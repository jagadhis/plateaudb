//! A database: saved segments read lazily from storage, plus the in-memory delta of rows written
//! since the last save. Queries run on each part and merge: counts add up, rows merge by
//! (order key, primary key), which is also the order inside each part, so ties break the same way
//! as within one table.
//!
//! Segments never change once written. `put` of an existing key and `delete` mark the old row in
//! its part's tombstones (a delete bitmap per segment, saved with the next save), and a replacing
//! `put` appends the new row to the delta. Compaction rewrites every live row into one segment.

use crate::Error;
use crate::cache;
use crate::dead::Tombstones;
use crate::format::{self, DATA_START, Layout, SLOT_SIZE, SectionRef, SegmentMeta, Slot};
use crate::key::{f64_key, key_f64};
use crate::merge::{self, KeysState, Merge, OrderedState, Src};
use crate::part::{Part, Val, write_row_json};
use crate::query::{self, Cond, Filter, Output, PartOutput, Query, QueryResult, RowId};
use crate::schema::{IndexKind, Kind, Schema};
use crate::segment::{Cache, Segment};
use crate::storage::Storage;
use crate::table::{Batch, Table};
use crate::write::{Space, Writer};
use std::rc::Rc;

/// Saving compacts instead when the database would hold more segments than this.
const COMPACT_SEGMENTS: usize = 8;

/// Saving compacts instead when more than this fraction of saved rows is deleted or replaced.
const COMPACT_DEAD_FRACTION: f64 = 0.25;

pub struct Db {
    storage: Rc<dyn Storage>,
    schema: Schema,
    segments: Vec<Segment>,
    delta: Table,
    /// Delta rows replaced or deleted before they were saved.
    delta_dead: Tombstones,
    /// Sequence number of the header slot that holds the current state; 0 before the first save.
    seq: u64,
    /// `[start, end)` of the committed manifest.
    manifest: Option<(u64, u64)>,
    stats: Rc<Cache>,
    layout: Layout,
    /// Whether commits keep the previous state's bytes in the file (`set_keep_previous`).
    keep_previous: bool,
    /// The extents the state before the last commit used, while `keep_previous` holds them.
    previous: Vec<(u64, u64)>,
    /// The owner's state, saved in the manifest with the rows (`set_meta`).
    meta: String,
    /// `meta` as the committed state holds it.
    committed_meta: String,
}

/// A tidy's moves: `(from, to, len)` file ranges, then per segment its new extents and delete
/// bitmap offset, and where the manifest goes.
struct TidyPlan {
    cut: u64,
    manifest_at: u64,
    moves: Vec<(u64, u64, u64)>,
    places: Vec<(Vec<(u64, u64)>, u64)>,
}

/// What lazy loading has read since open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Loaded {
    /// Bytes read from storage.
    pub bytes: u64,
    /// Sections and blocks loaded.
    pub sections: u64,
    /// Storage reads.
    pub reads: u64,
}

impl Db {
    /// Starts an empty database in `storage`, discarding what it held. Nothing is durable until
    /// `save`.
    pub fn create(storage: Rc<dyn Storage>, schema: Schema) -> Result<Db, Error> {
        Db::create_with_layout(storage, schema, Layout::default())
    }

    /// `create`, chunking the segments this handle saves by `layout`.
    pub fn create_with_layout(
        storage: Rc<dyn Storage>,
        schema: Schema,
        layout: Layout,
    ) -> Result<Db, Error> {
        layout.validate()?;
        storage.truncate(0)?;
        Ok(Db {
            delta: Table::new(schema.clone())?,
            delta_dead: Tombstones::default(),
            schema,
            storage,
            segments: Vec::new(),
            seq: 0,
            manifest: None,
            stats: Rc::default(),
            layout,
            keep_previous: false,
            previous: Vec::new(),
            meta: String::new(),
            committed_meta: String::new(),
        })
    }

    /// Opens the newest complete state in `storage`. Reads the two header slots and the manifest.
    pub fn open(storage: Rc<dyn Storage>) -> Result<Db, Error> {
        Db::open_at(storage, u64::MAX)
    }

    /// Opens the newest complete state whose sequence number is at most `max_seq`. An owner that
    /// commits several files together uses it to go back to the state it recorded for a file
    /// when a crash cut the group short; the file still holds that state in its other header
    /// slot, because a save reuses only space its own committed state no longer needs. The next
    /// save then overwrites the newer slot.
    pub fn open_at(storage: Rc<dyn Storage>, max_seq: u64) -> Result<Db, Error> {
        let size = storage.size()?;
        let mut head = vec![0u8; DATA_START.min(size) as usize];
        storage.read_at(0, &mut head)?;
        let mut slots: Vec<Slot> = head
            .chunks(SLOT_SIZE as usize)
            .filter_map(format::decode_slot)
            .collect();
        slots.retain(|s| s.seq <= max_seq);
        slots.sort_by_key(|s| std::cmp::Reverse(s.seq));
        for slot in slots {
            if slot.manifest_off < DATA_START
                || slot
                    .manifest_off
                    .checked_add(slot.manifest_len)
                    .is_none_or(|end| end > size)
            {
                continue;
            }
            let mut manifest = vec![0u8; slot.manifest_len as usize];
            storage.read_at(slot.manifest_off, &mut manifest)?;
            if format::checksum(&manifest) != slot.manifest_sum {
                continue;
            }
            let (schema, meta, metas) = format::decode_manifest(&manifest)?;
            let stats: Rc<Cache> = Rc::default();
            let segments = metas
                .into_iter()
                .map(|m| Segment::new(m, schema.clone(), storage.clone(), stats.clone()))
                .collect::<Result<_, _>>()?;
            return Ok(Db {
                delta: Table::new(schema.clone())?,
                delta_dead: Tombstones::default(),
                schema,
                storage,
                segments,
                seq: slot.seq,
                manifest: Some((slot.manifest_off, slot.manifest_off + slot.manifest_len)),
                stats,
                layout: Layout::default(),
                keep_previous: false,
                previous: Vec::new(),
                committed_meta: meta.clone(),
                meta,
            });
        }
        Err(Error::new("no complete database state in the file"))
    }

    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Sequence number of the committed state; 0 before the first save.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// The owner's state string, as last set (committed or not).
    pub fn meta(&self) -> &str {
        &self.meta
    }

    /// Sets the owner's state string; the next save or compaction commits it with the rows.
    pub fn set_meta(&mut self, meta: String) {
        self.meta = meta;
    }

    /// Drops every change since the last save or compaction (unsaved rows, delete marks, meta), so
    /// the database is the committed state again.
    pub fn rollback(&mut self) {
        self.delta = Table::new(self.schema.clone()).expect("schema validated at open");
        self.delta_dead = Tombstones::default();
        for s in &mut self.segments {
            if s.dead_changed {
                s.forget_dead();
            }
        }
        self.meta = self.committed_meta.clone();
    }

    /// Live rows: saved and unsaved, less those deleted or replaced.
    pub fn len(&self) -> u64 {
        self.segments
            .iter()
            .map(|s| s.len() as u64 - s.deleted())
            .sum::<u64>()
            + self.unsaved() as u64
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn segments(&self) -> usize {
        self.segments.len()
    }

    /// Live rows written since the last save.
    pub fn unsaved(&self) -> usize {
        (self.delta.len as u64 - self.delta_dead.rows.len()) as usize
    }

    /// Saved rows deleted or replaced: what compaction would drop.
    pub fn deleted(&self) -> u64 {
        self.segments.iter().map(Segment::deleted).sum()
    }

    /// Bytes of the file the committed state uses (its segments, delete bitmaps and manifest, and
    /// the two header slots): the file's size once nothing else is in it.
    pub fn used_bytes(&self) -> u64 {
        DATA_START + self.committed().iter().map(|e| e.1 - e.0).sum::<u64>()
    }

    /// Bytes this database's loaded sections hold, as counted against the memory budget.
    pub fn cached(&self) -> usize {
        self.segments.iter().map(Segment::held).sum()
    }

    /// Starts an operation: advances the clock that stamps what it touches, and drops loaded
    /// sections while the thread's loaded bytes exceed the memory budget, down to three quarters
    /// of it (`cache`): first those no later operation used, then the rest, least recently used
    /// first. Sections of other databases on the thread are
    /// dropped when those run. Callers of the `&self` reads (`get_many_json`, `key_scan`, ...)
    /// call this between them; every `&mut` operation does on its own.
    pub fn enforce_budget(&mut self) {
        self.stats.now.set(self.stats.now.get().wrapping_add(1));
        if cache::over() {
            self.shed_to(cache::low_water());
        }
    }

    /// Drops loaded sections, one-off pieces first, until the thread's loaded bytes are at most
    /// `target` or this database holds none.
    fn shed_to(&mut self, target: usize) {
        if cache::cached_bytes() <= target {
            return;
        }
        // Pieces no operation used after the one that loaded them go first (a run of one-off
        // reads, such as scattered gets, does not push out what queries keep using), then the
        // rest; each least recently used first.
        let mut all: Vec<(bool, u32, u32, u32)> = Vec::new();
        for (si, s) in self.segments.iter().enumerate() {
            for (p, (st, reused)) in s.unit_stamps().into_iter().enumerate() {
                all.push((reused, st, si as u32, p as u32));
            }
        }
        all.sort_unstable();
        let mut need = cache::cached_bytes().saturating_sub(target);
        let mut pick: Vec<Vec<usize>> = vec![Vec::new(); self.segments.len()];
        for (_, _, si, p) in all {
            if need == 0 {
                break;
            }
            need = need.saturating_sub(self.segments[si as usize].unit_size(p as usize));
            pick[si as usize].push(p as usize);
        }
        for (s, ps) in self.segments.iter_mut().zip(pick) {
            if !ps.is_empty() {
                s.evict(&ps);
            }
        }
        // Directories are dropped only with their whole segment: largest first, while still over.
        let mut order: Vec<usize> = (0..self.segments.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(self.segments[i].held()));
        for i in order {
            if cache::cached_bytes() <= target {
                break;
            }
            self.segments[i].reset();
        }
    }

    pub fn loaded(&self) -> Loaded {
        Loaded {
            bytes: self.stats.bytes.get(),
            sections: self.stats.sections.get(),
            reads: self.stats.reads.get(),
        }
    }

    fn check_segments(&self) -> Result<(), Error> {
        match self.segments.iter().find_map(Part::failure) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// The live row holding `key`, if any. A key has at most one live row: replaced rows are
    /// marked dead before their replacement is added.
    fn find(&self, key: f64) -> Result<Option<RowId>, Error> {
        if key.is_nan() {
            return Ok(None);
        }
        let k = f64_key(key);
        if let Some(row) = self.delta.pk_get(k) {
            return Ok(Some(RowId {
                part: self.segments.len() as u32,
                row,
            }));
        }
        for (i, s) in self.segments.iter().enumerate() {
            if let Some(row) = s.pk_get(k) {
                if s.meta.deleted == 0 && !s.dead_changed {
                    return Ok(Some(RowId {
                        part: i as u32,
                        row,
                    }));
                }
                if !s.tombstones()?.contains(row) {
                    return Ok(Some(RowId {
                        part: i as u32,
                        row,
                    }));
                }
            }
        }
        self.check_segments()?;
        Ok(None)
    }

    /// Checks a batch's keys: present, not NaN, not repeated. Returns them.
    fn batch_keys<'b>(&self, batch: &'b Batch) -> Result<&'b [f64], Error> {
        if let Some(name) = batch.missing(&self.schema) {
            return Err(Error::new(format!("batch is missing column {name}")));
        }
        let keys = batch.keys(self.delta.pk_col).expect("every column is set");
        let mut sorted: Vec<u64> = Vec::with_capacity(keys.len());
        for &k in keys {
            if k.is_nan() {
                return Err(Error::new("primary key is NaN"));
            }
            sorted.push(f64_key(k));
        }
        sorted.sort_unstable();
        if sorted.windows(2).any(|w| w[0] == w[1]) {
            return Err(Error::new("batch repeats a primary key"));
        }
        if self.delta.len as usize + keys.len() > u32::MAX as usize {
            return Err(Error::new("table is full"));
        }
        Ok(keys)
    }

    /// Appends rows to the delta. Rejects the whole batch if a key is NaN, repeats, or is live in
    /// any segment or the delta.
    pub fn append(&mut self, batch: Batch) -> Result<(), Error> {
        self.enforce_budget();
        let keys = self.batch_keys(&batch)?;
        for &k in keys {
            if self.find(k)?.is_some() {
                return Err(Error::new(format!("primary key {k} already exists")));
            }
        }
        self.delta.append(batch)
    }

    /// Inserts rows, replacing any live row with the same key: the old row is marked deleted and
    /// the new one appended to the delta. Rejects the whole batch, changing nothing, if a key is
    /// NaN or repeats.
    pub fn put(&mut self, batch: Batch) -> Result<(), Error> {
        self.enforce_budget();
        let keys = self.batch_keys(&batch)?;
        let mut old = Vec::new();
        for &k in keys {
            if let Some(id) = self.find(k)? {
                old.push((k, id));
            }
        }
        for (k, id) in old {
            self.mark(k, id)?;
        }
        self.delta.append(batch)?;
        self.enforce_budget();
        Ok(())
    }

    /// Deletes the live rows with these keys. Returns how many there were.
    pub fn delete(&mut self, keys: &[f64]) -> Result<u64, Error> {
        self.enforce_budget();
        let mut n = 0;
        for &k in keys {
            if let Some(id) = self.find(k)? {
                self.mark(k, id)?;
                n += 1;
            }
        }
        self.enforce_budget();
        Ok(n)
    }

    fn mark(&mut self, key: f64, id: RowId) -> Result<(), Error> {
        match self.segments.get_mut(id.part as usize) {
            Some(s) => s.mark_dead(id.row)?,
            None => {
                self.delta.pk.remove(&f64_key(key));
                self.delta_dead.mark(id.row);
            }
        }
        Ok(())
    }

    /// Whether saving now should compact instead.
    fn wants_compaction(&self) -> bool {
        let saved: u64 = self.segments.iter().map(|s| s.len() as u64).sum();
        let new = usize::from(self.unsaved() > 0);
        self.segments.len() + new > COMPACT_SEGMENTS
            || (saved > 0 && self.deleted() as f64 > COMPACT_DEAD_FRACTION * saved as f64)
    }

    /// The extents the committed state uses.
    fn committed(&self) -> Vec<(u64, u64)> {
        let mut taken: Vec<(u64, u64)> = self.manifest.into_iter().collect();
        for s in &self.segments {
            taken.extend(s.meta.extents.iter().copied());
            if s.meta.dead.len > 0 {
                taken.push((s.meta.dead.off, s.meta.dead.off + s.meta.dead.len as u64));
            }
        }
        taken
    }

    /// The parts a merge reads: segment `i` for each `i` in `parts`, the delta for
    /// `segments.len()`.
    fn sources(&self, parts: &[usize]) -> Result<Vec<Src<'_>>, Error> {
        parts
            .iter()
            .map(|&i| match self.segments.get(i) {
                Some(s) => Ok(Src::Seg(s, s.tombstones()?)),
                None => Ok(Src::Delta(&self.delta, &self.delta_dead)),
            })
            .collect()
    }

    /// Runs `step` on the sources until it reports done. Between steps the loaded sections are
    /// held to half the budget: a merge reads each piece once, so what it loads is not worth the
    /// room its row maps and buffers need.
    fn steps(
        &mut self,
        parts: &[usize],
        mut step: impl FnMut(&[Src<'_>]) -> Result<bool, Error>,
    ) -> Result<(), Error> {
        loop {
            let r = step(&self.sources(parts)?);
            self.check_segments()?;
            if r? {
                return Ok(());
            }
            self.stats.now.set(self.stats.now.get().wrapping_add(1));
            let half = cache::memory_budget() / 2;
            if cache::cached_bytes() > half {
                self.shed_to(half - half / 4);
            }
        }
    }

    /// Writes the live rows of `parts` (see `sources`) as one segment in primary key order, into
    /// the free space of `space`, a bounded run at a time.
    fn write_merged(&mut self, parts: &[usize], space: &mut Space) -> Result<SegmentMeta, Error> {
        let storage = self.storage.clone();
        let mut w = Writer::new(&*storage, space);
        let (lens, n): (Vec<u32>, usize) = {
            let srcs = self.sources(parts)?;
            (
                srcs.iter().map(|s| s.len()).collect(),
                srcs.iter().map(merge::live).sum(),
            )
        };
        // Room under the budget for the merge's row maps and reads, whatever queries left loaded.
        self.shed_to(cache::memory_budget() / 2);
        let mut m = Merge::new(self.schema.clone(), self.layout, &lens, n);
        self.steps(parts, |srcs| m.pk_step(srcs, &mut w))?;
        self.steps(parts, |srcs| m.rows_step(srcs, &mut w))?;
        // Bitmaps first: an ordered index's groups take their sizes from its group column's.
        let kinds: Vec<IndexKind> = self.schema.columns.iter().map(|c| c.index).collect();
        for (c, _) in kinds
            .iter()
            .enumerate()
            .filter(|k| *k.1 == IndexKind::Bitmap)
        {
            let (mut values, mut entries, mut from) = (None, Vec::new(), 0);
            self.steps(parts, |srcs| {
                let v = values.get_or_insert_with(|| Merge::bitmap_values(srcs, c));
                Ok(
                    match m.bitmap_step(srcs, &mut w, c, v, &mut entries, from)? {
                        Some(next) => {
                            from = next;
                            false
                        }
                        None => true,
                    },
                )
            })?;
        }
        for (c, kind) in kinds.iter().enumerate() {
            match kind {
                IndexKind::Ordered => {
                    let mut state = OrderedState::default();
                    self.steps(parts, |srcs| m.ordered_step(srcs, &mut w, c, &mut state))?;
                }
                IndexKind::Keys => {
                    let mut state = KeysState::default();
                    self.steps(parts, |srcs| m.keys_step(srcs, &mut w, c, &mut state))?;
                }
                IndexKind::Bitmap | IndexKind::None => {}
            }
        }
        let mut meta = m.finish(&mut w)?;
        meta.extents = w.finish()?;
        Ok(meta)
    }

    /// Writes the manifest listing `metas`, flushes, writes the next header slot and flushes.
    /// Returns the new slot's sequence number and the manifest's extent.
    fn commit(&self, metas: &[&SegmentMeta], space: &mut Space) -> Result<(u64, u64, u64), Error> {
        let manifest = format::encode_manifest(&self.schema, &self.meta, metas);
        let at = space.place(manifest.len() as u64);
        self.commit_at(&manifest, at)
    }

    /// `commit` with the manifest already encoded and placed at `at`.
    fn commit_at(&self, manifest: &[u8], at: u64) -> Result<(u64, u64, u64), Error> {
        self.storage.write_at(at, manifest)?;
        self.storage.flush()?;
        let slot = Slot {
            seq: self.seq + 1,
            manifest_off: at,
            manifest_len: manifest.len() as u64,
            manifest_sum: format::checksum(manifest),
        };
        self.storage
            .write_at((slot.seq % 2) * SLOT_SIZE, &format::encode_slot(&slot))?;
        self.storage.flush()?;
        Ok((slot.seq, at, at + slot.manifest_len))
    }

    /// After a commit: cuts the file after the last byte the new state uses (and the previous
    /// state, while `keep_previous` holds it).
    fn trim(&self) -> Result<(), Error> {
        let mut end = Space::new(self.committed()).end();
        if self.keep_previous {
            end = end.max(Space::new(self.previous.clone()).end());
        }
        if self.storage.size()? > end {
            self.storage.truncate(end)?;
        }
        Ok(())
    }

    /// While set, a commit leaves the previous state's bytes in the file even where the file
    /// could be cut shorter, so `open_at` can still return to it: an owner committing several
    /// files together sets it until its group commit is recorded. A save never writes over the
    /// previous state's bytes either way.
    pub fn set_keep_previous(&mut self, keep: bool) {
        self.keep_previous = keep;
    }

    /// Lets go of the previous state: cuts the file after the last byte the committed state
    /// uses, and (once `keep_previous` is cleared) tidies it.
    pub fn release_previous(&mut self) -> Result<(), Error> {
        self.previous.clear();
        self.trim()?;
        self.tidy()
    }

    /// After a commit, when the file is over a tenth larger than what the committed state uses
    /// (a compaction had to go after the state it replaced, or saves left gaps): finds the lowest
    /// cut such that the free space before it holds everything past it, copies those bytes there
    /// (a segment's extents move as they are, since its offsets are logical), commits a manifest
    /// listing the new places, and cuts the file there. Nothing is written over bytes the
    /// committed state uses, so a tidy torn anywhere leaves the state before it, which holds the
    /// same rows. Segments of files from before logical offsets do not move.
    fn tidy(&mut self) -> Result<(), Error> {
        if self.keep_previous || self.unsaved() > 0 || self.segments.iter().any(|s| s.dead_changed)
        {
            return Ok(());
        }
        let size = self.storage.size()?;
        let used = self.used_bytes();
        if size <= used + used / 10 + (16 << 10) {
            return Ok(());
        }
        let before = self.committed();
        let gaps: Vec<(u64, u64)> = Space::new(before.clone())
            .gaps()
            .map(|(a, b)| (a.next_multiple_of(8), b))
            .filter(|&(a, b)| a < b)
            .collect();
        let extents: usize = self.segments.iter().map(|s| s.meta.extents.len()).sum();
        let metas: Vec<&SegmentMeta> = self.segments.iter().map(|s| &s.meta).collect();
        let bound = (format::encode_manifest(&self.schema, &self.meta, &metas).len()
            + 16 * (gaps.len() + extents + 4))
            .next_multiple_of(8) as u64;
        let (mut lo, mut hi) = (DATA_START, size.next_multiple_of(8));
        if self.tidy_plan(hi, &gaps, bound).is_none() {
            return Ok(());
        }
        // The plan fits at `hi`; the lowest cut that fits, by bisection over 8-byte steps.
        while lo < hi {
            let mid = (lo + (hi - lo) / 2) & !7;
            if self.tidy_plan(mid, &gaps, bound).is_some() {
                hi = mid;
            } else {
                lo = mid + 8;
            }
        }
        let Some(plan) = self.tidy_plan(hi, &gaps, bound) else {
            return Ok(());
        };
        if plan.cut >= size {
            return Ok(());
        }
        let mut buf = vec![0u8; 1 << 20];
        for &(src, dst, len) in &plan.moves {
            let mut done = 0;
            while done < len {
                let n = (len - done).min(buf.len() as u64) as usize;
                self.storage.read_at(src + done, &mut buf[..n])?;
                self.storage.write_at(dst + done, &buf[..n])?;
                done += n as u64;
            }
        }
        let metas: Vec<SegmentMeta> = self
            .segments
            .iter()
            .zip(&plan.places)
            .map(|(s, (extents, dead))| {
                let mut m = s.meta.clone();
                m.extents = extents.clone();
                m.dead.off = *dead;
                m
            })
            .collect();
        let manifest =
            format::encode_manifest(&self.schema, &self.meta, &metas.iter().collect::<Vec<_>>());
        if manifest.len() as u64 > bound {
            return Err(Error::new("tidy: the manifest outgrew its place"));
        }
        let (seq, start, end) = self.commit_at(&manifest, plan.manifest_at)?;
        for (s, m) in self.segments.iter_mut().zip(metas) {
            s.meta.dead = m.dead;
            s.set_extents(m.extents);
        }
        self.seq = seq;
        self.manifest = Some((start, end));
        self.previous = before;
        self.trim()
    }

    /// Where everything past `cut` goes in the gaps before it, the manifest first (`bound`
    /// bytes, whole), then delete bitmaps (whole), then segment bytes in order (split as the gaps
    /// fall); `None` if it does not fit or a segment that cannot move lies past the cut.
    fn tidy_plan(&self, cut: u64, gaps: &[(u64, u64)], bound: u64) -> Option<TidyPlan> {
        let mut free: Vec<(u64, u64)> = gaps
            .iter()
            .filter(|g| g.0 < cut)
            .map(|&(a, b)| (a, b.min(cut)))
            .filter(|g| g.1 - g.0 >= 8)
            .collect();
        let mut whole = |len: u64| -> Option<u64> {
            let g = free.iter_mut().find(|g| g.1 - g.0 >= len)?;
            let at = g.0;
            g.0 = (g.0 + len).next_multiple_of(8).min(g.1);
            Some(at)
        };
        let manifest_at = whole(bound)?;
        let mut moves = Vec::new();
        let mut deads = Vec::with_capacity(self.segments.len());
        for s in &self.segments {
            let d = s.meta.dead;
            if d.len > 0 && d.off + d.len as u64 > cut {
                let at = whole((d.len as u64).next_multiple_of(8))?;
                moves.push((d.off, at, d.len as u64));
                deads.push(at);
            } else {
                deads.push(d.off);
            }
        }
        let mut places = Vec::with_capacity(self.segments.len());
        let mut g = 0;
        for (s, dead) in self.segments.iter().zip(deads) {
            let logical = s.meta.flags & format::FLAG_LOGICAL != 0;
            let mut extents: Vec<(u64, u64)> = Vec::with_capacity(s.meta.extents.len());
            let mut push = |e: (u64, u64)| match extents.last_mut() {
                Some(last) if last.1 == e.0 => last.1 = e.1,
                _ => extents.push(e),
            };
            for &(a, b) in &s.meta.extents {
                if b <= cut {
                    push((a, b));
                    continue;
                }
                if !logical {
                    return None;
                }
                if a < cut {
                    push((a, cut));
                }
                let mut from = a.max(cut);
                while from < b {
                    let gap = free.get_mut(g)?;
                    if gap.1 - gap.0 < 8 {
                        g += 1;
                        continue;
                    }
                    let n = (gap.1 - gap.0).min(b - from);
                    moves.push((from, gap.0, n));
                    push((gap.0, gap.0 + n));
                    gap.0 += n;
                    from += n;
                }
            }
            places.push((extents, dead));
        }
        Some(TidyPlan {
            cut,
            manifest_at,
            moves,
            places,
        })
    }

    /// After a commit of `metas` (one per kept segment, then the new one if any).
    fn committed_state(
        &mut self,
        seq: u64,
        manifest: (u64, u64),
        before: Vec<(u64, u64)>,
    ) -> Result<(), Error> {
        self.seq = seq;
        self.committed_meta = self.meta.clone();
        self.manifest = Some(manifest);
        self.previous = before;
        self.delta = Table::new(self.schema.clone())?;
        self.delta_dead = Tombstones::default();
        Ok(())
    }

    fn new_segment(&self, meta: SegmentMeta) -> Result<Segment, Error> {
        Segment::new(
            meta,
            self.schema.clone(),
            self.storage.clone(),
            self.stats.clone(),
        )
    }

    /// Saves: writes the live delta rows as a new segment and each changed delete bitmap as a
    /// section, then a manifest listing every segment, flushes, then writes the header slot not
    /// holding the current state and flushes. Nothing is written over bytes the current state
    /// uses, so a save torn anywhere leaves it. Compacts instead when the database has many
    /// segments or many deleted rows.
    pub fn save(&mut self) -> Result<(), Error> {
        if self.wants_compaction() {
            return self.compact();
        }
        self.enforce_budget();
        self.delta.build_indexes();
        let before = self.committed();
        let mut space = Space::new(before.clone());
        let mut metas: Vec<SegmentMeta> = Vec::with_capacity(self.segments.len() + 1);
        for s in &self.segments {
            let mut meta = s.meta.clone();
            if s.dead_changed {
                let dead = &s.tombstones()?.rows;
                meta.deleted = dead.len() as u32;
                meta.dead = SectionRef::default();
                if !dead.is_empty() {
                    let bytes = format::encode_dead(dead);
                    let at = space.place(bytes.len() as u64);
                    self.storage.write_at(at, &bytes)?;
                    meta.dead = SectionRef {
                        off: at,
                        len: bytes.len() as u32,
                        sum: format::checksum(&bytes),
                    };
                }
            }
            metas.push(meta);
        }
        let mut new = None;
        if self.unsaved() > 0 {
            new = Some(self.write_merged(&[self.segments.len()], &mut space)?);
        }
        let all: Vec<&SegmentMeta> = metas.iter().chain(new.as_ref()).collect();
        let (seq, start, end) = self.commit(&all, &mut space)?;

        for (s, meta) in self.segments.iter_mut().zip(metas) {
            s.meta = meta;
            s.dead_changed = false;
        }
        if let Some(meta) = new {
            let seg = self.new_segment(meta)?;
            self.segments.push(seg);
        }
        self.committed_state(seq, (start, end), before)?;
        self.trim()?;
        self.tidy()?;
        self.enforce_budget();
        Ok(())
    }

    /// Rewrites every live row, saved or not, in primary key order as one segment, and commits a
    /// manifest listing only it. The new segment goes into the free space the committed state
    /// leaves where it fits, else after it; once the new header slot is written, the file is cut
    /// after the new state's last byte, and the old segments' space is free for later saves.
    pub fn compact(&mut self) -> Result<(), Error> {
        self.enforce_budget();
        self.delta.build_indexes();
        let before = self.committed();
        let mut space = Space::new(before.clone());
        let new = if !self.is_empty() {
            let parts: Vec<usize> = (0..=self.segments.len()).collect();
            Some(self.write_merged(&parts, &mut space)?)
        } else {
            None
        };
        let all: Vec<&SegmentMeta> = new.iter().collect();
        let (seq, start, end) = self.commit(&all, &mut space)?;

        self.segments.clear();
        if let Some(meta) = new {
            let seg = self.new_segment(meta)?;
            self.segments.push(seg);
        }
        self.committed_state(seq, (start, end), before)?;
        self.trim()?;
        self.tidy()?;
        self.enforce_budget();
        Ok(())
    }

    /// Runs `q` on part `i` (a segment, or the delta at `segments.len()`), leaving out its
    /// deleted rows.
    fn run_part(&self, i: u32, q: &Query) -> Result<query::PartResult, Error> {
        match self.segments.get(i as usize) {
            Some(s) => {
                let r = query::run(s, q, Some(s.tombstones()?));
                self.check_segments()?;
                r
            }
            None => query::run(&self.delta, q, Some(&self.delta_dead)),
        }
    }

    /// Runs a query on every part with live rows and merges the answers.
    ///
    /// Parts run largest first. With several parts and `orderBy` on a number column plus a
    /// limit, once `limit` rows are in hand the later parts get the worst order key among them as
    /// a range bound, which an ordered index walk applies by binary search: no row past it can
    /// make the result. The largest part's walk stops at `limit` rows whatever it is given, so it
    /// runs unbounded and hands the small parts a tight bound.
    pub fn query(&mut self, q: &Query) -> Result<QueryResult, Error> {
        self.enforce_budget();
        self.delta.build_indexes();
        let delta_at = self.segments.len() as u32;
        let mut order: Vec<(u64, u32)> = Vec::with_capacity(self.segments.len() + 1);
        for (i, s) in self.segments.iter().enumerate() {
            let live = s.len() as u64 - s.deleted();
            if live > 0 {
                order.push((live, i as u32));
            }
        }
        if self.unsaved() > 0 || order.is_empty() {
            order.push((self.unsaved() as u64, delta_at));
        }
        order.sort_by_key(|&(live, i)| (std::cmp::Reverse(live), i));
        let order: Vec<u32> = order.into_iter().map(|(_, i)| i).collect();

        if order.len() == 1 {
            let r = self.run_part(order[0], q)?;
            let output = match r.output {
                PartOutput::Count(n) => Output::Count(n),
                PartOutput::Rows(rows) => Output::Rows(
                    rows.into_iter()
                        .map(|row| RowId {
                            part: order[0],
                            row,
                        })
                        .collect(),
                ),
            };
            return Ok(QueryResult {
                output,
                plan: r.plan,
            });
        }

        let limit = q.limit.map_or(usize::MAX, |l| l as usize);
        let desc = q.order_by.as_ref().is_some_and(|o| o.desc);
        // Order keys only; the primary key breaks ties, read only for rows that tie.
        let better = |a: u64, b: u64| if desc { b.cmp(&a) } else { a.cmp(&b) };
        let order_col = match &q.order_by {
            Some(o) if !q.count => {
                let c = self
                    .schema
                    .column(&o.field)
                    .ok_or_else(|| Error::new(format!("no column {}", o.field)))?;
                Some((c, self.schema.columns[c].kind))
            }
            _ => None,
        };
        let bounded_field = match (&q.order_by, q.limit, q.count) {
            (Some(o), Some(_), false) => self
                .schema
                .column(&o.field)
                .filter(|&c| self.schema.columns[c].kind == Kind::F64)
                .map(|_| o.field.clone()),
            _ => None,
        };
        let mut bounded: Option<Query> = None;
        let mut total = 0u64;
        let mut counted = false;
        let mut keyed: Vec<(u64, RowId)> = Vec::new();
        let mut scratch: Vec<u64> = Vec::new();
        let mut plans: Vec<String> = Vec::with_capacity(order.len());
        for &i in &order {
            let r = self.run_part(i, bounded.as_ref().unwrap_or(q))?;
            let name = if i == delta_at {
                "delta".to_string()
            } else {
                format!("s{i}")
            };
            plans.push(format!("{name}: {}", r.plan));
            match r.output {
                PartOutput::Count(n) => {
                    total += n;
                    counted = true;
                }
                PartOutput::Rows(rows) => {
                    let id = |row| RowId { part: i, row };
                    if order_col.is_none() {
                        keyed.extend(rows.into_iter().map(|row| (0, id(row))));
                    } else if r.keys.len() == rows.len() {
                        keyed.extend(r.keys.into_iter().zip(rows).map(|(k, row)| (k, id(row))));
                    } else {
                        let key = |row| match self.segments.get(i as usize) {
                            Some(s) => query::order_key(s, order_col, row),
                            None => query::order_key(&self.delta, order_col, row),
                        };
                        keyed.extend(rows.into_iter().map(|row| (key(row), id(row))));
                        self.check_segments()?;
                    }
                }
            }
            if order_col.is_some() && limit > 0 && keyed.len() >= limit {
                // The limit-th best key: a row worse than it cannot make the result.
                scratch.clear();
                scratch.extend(keyed.iter().map(|e| e.0));
                let (_, &mut kth, _) =
                    scratch.select_nth_unstable_by(limit - 1, |a, b| better(*a, *b));
                keyed.retain(|e| better(e.0, kth).is_le());
                if let Some(field) = &bounded_field {
                    let v = key_f64(kth);
                    let cond = if desc {
                        Cond::Range {
                            gt: None,
                            gte: Some(v),
                            lt: None,
                            lte: None,
                        }
                    } else {
                        Cond::Range {
                            gt: None,
                            gte: None,
                            lt: None,
                            lte: Some(v),
                        }
                    };
                    let mut b = q.clone();
                    b.filters.push(Filter {
                        field: field.clone(),
                        cond,
                    });
                    bounded = Some(b);
                }
            }
        }
        let plan = plans.join("; ");
        if counted {
            return Ok(QueryResult {
                output: Output::Count(total),
                plan,
            });
        }
        keyed.sort_unstable_by(|a, b| better(a.0, b.0));
        // Runs of equal order keys (every row, without `orderBy`) go by primary key, ascending
        // with the order, as inside one part.
        let pk_key = |id: RowId| match self.segments.get(id.part as usize) {
            Some(s) => s.pk_key(id.row),
            None => self.delta.pk_key(id.row),
        };
        let mut start = 0;
        while start < keyed.len().min(limit) {
            let mut end = start + 1;
            while end < keyed.len() && keyed[end].0 == keyed[start].0 {
                end += 1;
            }
            if end - start > 1 {
                let mut run: Vec<(u64, RowId)> = keyed[start..end]
                    .iter()
                    .map(|e| (pk_key(e.1), e.1))
                    .collect();
                run.sort_unstable_by(|a, b| better(a.0, b.0));
                for (slot, e) in keyed[start..end].iter_mut().zip(run) {
                    slot.1 = e.1;
                }
            }
            start = end;
        }
        self.check_segments()?;
        keyed.truncate(limit);
        Ok(QueryResult {
            output: Output::Rows(keyed.into_iter().map(|(_, id)| id).collect()),
            plan,
        })
    }

    /// Runs a query JSON; returns `{"plan":..,"rows":[..]}` or `{"plan":..,"count":n}`.
    pub fn query_json(&mut self, json: &str) -> Result<String, Error> {
        let q: Query = serde_json::from_str(json)?;
        let result = self.query(&q)?;
        let out = self.result_json(&result);
        self.enforce_budget();
        out
    }

    pub fn result_json(&self, result: &QueryResult) -> Result<String, Error> {
        let mut out = String::from("{\"plan\":");
        crate::json::write_str(&mut out, &result.plan);
        match &result.output {
            Output::Count(n) => {
                out.push_str(",\"count\":");
                out.push_str(&n.to_string());
            }
            Output::Rows(rows) => {
                out.push_str(",\"rows\":");
                self.write_rows(rows.iter().map(|&id| Some(id)), &mut out);
            }
        }
        out.push('}');
        self.check_segments()?;
        Ok(out)
    }

    /// Writes a JSON array with one object per row, `null` for `None`.
    fn write_rows(&self, ids: impl Iterator<Item = Option<RowId>> + Clone, out: &mut String) {
        let mut per_segment: Vec<Vec<u32>> = vec![Vec::new(); self.segments.len()];
        for id in ids.clone().flatten() {
            if let Some(rows) = per_segment.get_mut(id.part as usize) {
                rows.push(id.row);
            }
        }
        for (s, rows) in self.segments.iter().zip(&per_segment) {
            if !rows.is_empty() {
                s.prefetch(rows);
            }
        }
        let mut vals: Vec<Val<'_>> = Vec::new();
        for id in ids.clone().flatten() {
            match self.segments.get(id.part as usize) {
                Some(s) => s.gather(id.row, &mut vals),
                None => self.delta.gather(id.row, &mut vals),
            }
        }
        let width = self.schema.columns.len();
        let mut rows = vals.chunks(width);
        out.push('[');
        for (i, id) in ids.enumerate() {
            if i > 0 {
                out.push(',');
            }
            match id.and_then(|_| rows.next()) {
                Some(row) => write_row_json(&self.schema, row, out),
                None => out.push_str("null"),
            }
        }
        out.push(']');
    }

    fn keys_column(&self, column: &str) -> Result<usize, Error> {
        let c = self
            .schema
            .column(column)
            .ok_or_else(|| Error::new(format!("no column {column}")))?;
        if self.schema.columns[c].index != crate::schema::IndexKind::Keys {
            return Err(Error::new(format!("column {column} has no keys index")));
        }
        Ok(c)
    }

    /// The live entries of the keys index on `column` with `lo <= key < hi` (no upper bound when
    /// `hi` is `None`), ascending, or descending when `desc`, at most `limit`, each with its row's
    /// primary key. Each part walks only as far as `limit` live entries.
    pub fn key_scan(
        &self,
        column: &str,
        lo: &[u8],
        hi: Option<&[u8]>,
        desc: bool,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, f64)>, Error> {
        let c = self.keys_column(column)?;
        let mut found: Vec<(Vec<u8>, RowId)> = Vec::new();
        for i in 0..=self.segments.len() {
            let mut n = 0;
            let mut visit = |k: &[u8], row: u32, dead: &Tombstones| {
                if !dead.contains(row) {
                    found.push((
                        k.to_vec(),
                        RowId {
                            part: i as u32,
                            row,
                        },
                    ));
                    n += 1;
                }
                n < limit
            };
            match self.segments.get(i) {
                Some(s) => {
                    let dead = s.tombstones()?;
                    s.keys_walk(c, lo, hi, desc, |k, r| visit(k, r, dead));
                }
                None => self
                    .delta
                    .keys_walk(c, lo, hi, desc, |k, r| visit(k, r, &self.delta_dead)),
            }
        }
        self.check_segments()?;
        found.sort_unstable_by(|a, b| if desc { b.0.cmp(&a.0) } else { a.0.cmp(&b.0) });
        found.truncate(limit);
        let pk = self.delta.pk_col;
        let out = found
            .into_iter()
            .map(|(k, id)| {
                let key = match self.segments.get(id.part as usize) {
                    Some(s) => s.f64_at(pk, id.row),
                    None => self.delta.f64_at(pk, id.row),
                };
                (k, key)
            })
            .collect();
        self.check_segments()?;
        Ok(out)
    }

    /// Live entries of the keys index on `column` with `lo <= key < hi`.
    pub fn key_count(&self, column: &str, lo: &[u8], hi: Option<&[u8]>) -> Result<u64, Error> {
        let c = self.keys_column(column)?;
        let mut n = 0;
        for s in &self.segments {
            if s.deleted() == 0 {
                n += s.keys_count(c, lo, hi);
            } else {
                let dead = s.tombstones()?;
                s.keys_walk(c, lo, hi, false, |_, r| {
                    n += u64::from(!dead.contains(r));
                    true
                });
            }
        }
        self.delta.keys_walk(c, lo, hi, false, |_, r| {
            n += u64::from(!self.delta_dead.contains(r));
            true
        });
        self.check_segments()?;
        Ok(n)
    }

    /// Live primary keys in `lo..hi` (each end open or closed), ascending or descending, at most
    /// `limit`.
    pub fn pk_scan(
        &self,
        lo: f64,
        lo_open: bool,
        hi: f64,
        hi_open: bool,
        desc: bool,
        limit: usize,
    ) -> Result<Vec<f64>, Error> {
        if lo.is_nan() || hi.is_nan() {
            return Ok(Vec::new());
        }
        let mut l = f64_key(lo);
        let mut h = f64_key(hi);
        if lo_open {
            let Some(x) = l.checked_add(1) else {
                return Ok(Vec::new());
            };
            l = x;
        }
        if hi_open {
            let Some(x) = h.checked_sub(1) else {
                return Ok(Vec::new());
            };
            h = x;
        }
        let mut found: Vec<u64> = Vec::new();
        for i in 0..=self.segments.len() {
            let mut n = 0;
            let mut visit = |k: u64, row: u32, dead: &Tombstones| {
                if !dead.contains(row) {
                    found.push(k);
                    n += 1;
                }
                n < limit
            };
            match self.segments.get(i) {
                Some(s) => {
                    let dead = s.tombstones()?;
                    s.pk_walk(l, h, desc, |k, r| visit(k, r, dead));
                }
                None => self
                    .delta
                    .pk_walk(l, h, desc, |k, r| visit(k, r, &self.delta_dead)),
            }
        }
        self.check_segments()?;
        found.sort_unstable();
        if desc {
            found.reverse();
        }
        found.truncate(limit);
        Ok(found.into_iter().map(key_f64).collect())
    }

    /// Primary key values of `rows`, for comparing results across engines.
    pub fn keys_of(&self, rows: &[RowId]) -> Result<Vec<f64>, Error> {
        let pk = self.delta.pk_col;
        let keys = rows
            .iter()
            .map(|id| match self.segments.get(id.part as usize) {
                Some(s) => s.f64_at(pk, id.row),
                None => self.delta.f64_at(pk, id.row),
            })
            .collect();
        self.check_segments()?;
        Ok(keys)
    }

    /// JSON array with one row object per key, `null` where the key is absent.
    pub fn get_many_json(&self, keys: &[f64]) -> Result<String, Error> {
        let ids: Vec<Option<RowId>> = keys
            .iter()
            .map(|&k| self.find(k))
            .collect::<Result<_, _>>()?;
        let mut out = String::with_capacity(keys.len() * 128 + 2);
        self.write_rows(ids.iter().copied(), &mut out);
        self.check_segments()?;
        Ok(out)
    }
}
