//! Writing a segment from parts: the live rows of some segments and of the delta, merged in
//! primary key order. Nothing holds the whole result: the merge runs in steps, each reading a
//! bounded run of its sources and writing what it read, and keeps only small per-row state between
//! steps (the old-to-new row map). Between steps the owner may drop loaded sections to stay in the
//! memory budget; every source is reached again from its position, not from a borrow.
//!
//! The new segment's rows follow primary key order, so ordered index ties (ordered by primary key)
//! and keys index ties (ordered by row) both come out in new row order.

use crate::Error;
use crate::cache;
use crate::dead::Tombstones;
use crate::format::{
    ArrayDesc, DIR_PER, FLAG_LEAN, FLAG_LOGICAL, FLAG_ROWS_IN_PK_ORDER, Layout, SectionRef,
    SegmentMeta, dir_block_size, in_record, pair_block_size, put_array_words, put_ref_words,
    put_u32, put_u64,
};
use crate::part::{Part, Val};
use crate::query::Test;
use crate::schema::{IndexKind, Kind, Schema};
use crate::segment::Segment;
use crate::table::Table;
use crate::write::Writer;
use roaring::RoaringBitmap;

/// A row that is not in the new segment.
const GONE: u32 = u32::MAX;

/// Entries a cursor reads from its source at a time.
const CURSOR: usize = 512;

/// Rows or entries one step handles before handing back.
const STEP: usize = 16384;

/// Bytes a step of phase 2 may load from its sources before handing back, so the owner can shed:
/// a sixteenth of the budget, at least 1 MiB.
fn step_bytes() -> usize {
    (cache::memory_budget() / 16).max(1 << 20)
}

/// One part being merged, with its deleted rows.
pub(crate) enum Src<'a> {
    Seg(&'a Segment, &'a Tombstones),
    Delta(&'a Table, &'a Tombstones),
}

macro_rules! on {
    ($src:expr, $p:ident => $e:expr) => {
        match $src {
            Src::Seg($p, _) => $e,
            Src::Delta($p, _) => $e,
        }
    };
}

impl Src<'_> {
    fn dead(&self) -> &Tombstones {
        match self {
            Src::Seg(_, d) | Src::Delta(_, d) => d,
        }
    }

    pub fn len(&self) -> u32 {
        on!(self, p => p.len())
    }
}

/// Reads one source's primary key in order, live rows only.
#[derive(Default)]
struct PkCursor {
    lo: u64,
    buf: Vec<(u64, u32)>,
    at: usize,
    done: bool,
}

impl PkCursor {
    fn head(&mut self, src: &Src) -> Option<(u64, u32)> {
        while self.at == self.buf.len() {
            if self.done {
                return None;
            }
            self.buf.clear();
            self.at = 0;
            let (dead, mut n, mut last) = (src.dead(), 0, None);
            let buf = &mut self.buf;
            on!(src, p => p.pk_walk(self.lo, u64::MAX, false, |k, r| {
                n += 1;
                last = Some(k);
                if !dead.contains(r) {
                    buf.push((k, r));
                }
                n < CURSOR
            }));
            match last {
                Some(k) if n == CURSOR && k < u64::MAX => self.lo = k + 1,
                _ => self.done = true,
            }
        }
        Some(self.buf[self.at])
    }
}

/// The source and row of the next live row in primary key order across `cur`.
fn next_pk(cur: &mut [PkCursor], srcs: &[Src]) -> Option<(usize, u64, u32)> {
    let mut best: Option<(u64, usize, u32)> = None;
    for (i, c) in cur.iter_mut().enumerate() {
        if let Some((k, r)) = c.head(&srcs[i])
            && best.is_none_or(|b| k < b.0)
        {
            best = Some((k, i, r));
        }
    }
    let (k, i, r) = best?;
    cur[i].at += 1;
    Some((i, k, r))
}

/// Which pairs array of a source an ordered cursor walks.
#[derive(Clone, Copy)]
enum Walk {
    Global(usize),
    Group(usize, u32),
}

/// Reads one source's ordered index (or one group of it) by position, as (key, new row).
struct OrdCursor {
    pos: usize,
    end: usize,
    buf: Vec<(u64, u32)>,
    at: usize,
}

impl OrdCursor {
    fn new(src: &Src, walk: Walk) -> OrdCursor {
        let end = match walk {
            Walk::Global(c) => on!(src, p => p.ordered_len(c)),
            Walk::Group(c, g) => on!(src, p => p.group_len(c, g)),
        };
        OrdCursor {
            pos: 0,
            end,
            buf: Vec::new(),
            at: 0,
        }
    }

    fn head(&mut self, src: &Src, walk: Walk, map: &[u32]) -> Option<(u64, u32)> {
        while self.at == self.buf.len() {
            if self.pos >= self.end {
                return None;
            }
            self.buf.clear();
            self.at = 0;
            let to = (self.pos + CURSOR).min(self.end);
            let buf = &mut self.buf;
            let mut visit = |r: u32, k: u64| {
                let nr = map[r as usize];
                if nr != GONE {
                    buf.push((k, nr));
                }
                true
            };
            match walk {
                Walk::Global(c) => {
                    on!(src, p => p.ordered_walk(c, self.pos, to, false, &mut visit))
                }
                Walk::Group(c, g) => {
                    on!(src, p => p.group_walk(c, g, self.pos, to, false, &mut visit))
                }
            }
            self.pos = to;
        }
        Some(self.buf[self.at])
    }
}

/// Reads one source's keys index in order as (key, new row), never splitting a run of equal keys
/// between reads.
#[derive(Default)]
struct KeyCursor {
    lo: Vec<u8>,
    done: bool,
    buf: Vec<(Box<[u8]>, u32)>,
    at: usize,
}

impl KeyCursor {
    fn head(&mut self, src: &Src, c: usize, map: &[u32]) -> Option<&[u8]> {
        while self.at == self.buf.len() {
            if self.done {
                return None;
            }
            self.buf.clear();
            self.at = 0;
            let (mut n, mut last, mut next): (usize, Vec<u8>, Option<Vec<u8>>) = (0, vec![], None);
            let buf = &mut self.buf;
            on!(src, p => p.keys_walk(c, &self.lo, None, false, |k, r| {
                if n >= CURSOR && k != last.as_slice() {
                    next = Some(k.to_vec());
                    return false;
                }
                n += 1;
                last.clear();
                last.extend_from_slice(k);
                let nr = map[r as usize];
                if nr != GONE {
                    buf.push((k.into(), nr));
                }
                true
            }));
            match next {
                Some(k) => self.lo = k,
                None => self.done = true,
            }
        }
        Some(&self.buf[self.at].0)
    }
}

/// A pairs array being written block by block into space claimed for all of it.
struct PairsOut {
    base: u64,
    per: usize,
    len: usize,
    written: usize,
    block: Vec<(u64, u32)>,
    fences: Vec<u64>,
    body: Vec<u8>,
}

impl PairsOut {
    fn begin(w: &mut Writer, len: usize, per: u32) -> Result<PairsOut, Error> {
        let per = per as usize;
        let full = len / per;
        let rest = len % per;
        let size = full * pair_block_size(per) + if rest > 0 { pair_block_size(rest) } else { 0 };
        let base = w.reserve(size as u64)?;
        Ok(PairsOut {
            base,
            per,
            len,
            written: 0,
            block: Vec::with_capacity(per),
            fences: Vec::with_capacity(len.div_ceil(per)),
            body: Vec::new(),
        })
    }

    fn push(&mut self, w: &mut Writer, key: u64, row: u32) -> Result<(), Error> {
        self.block.push((key, row));
        if self.block.len() == self.per {
            self.flush(w)?;
        }
        Ok(())
    }

    fn flush(&mut self, w: &mut Writer) -> Result<(), Error> {
        if self.block.is_empty() {
            return Ok(());
        }
        let j = self.written / self.per;
        if self.written + self.block.len() > self.len {
            return Err(Error::new("merge: an index has more entries than rows"));
        }
        self.fences.push(self.block[0].0);
        self.block.iter().for_each(|e| put_u64(&mut self.body, e.0));
        self.block.iter().for_each(|e| put_u32(&mut self.body, e.1));
        self.body.resize(self.body.len().next_multiple_of(8), 0);
        let off = self.base + (j * pair_block_size(self.per)) as u64;
        w.put_block(&mut self.body, off)?;
        self.written += self.block.len();
        self.block.clear();
        Ok(())
    }

    fn finish(mut self, w: &mut Writer, scratch: &mut Vec<u8>) -> Result<ArrayDesc, Error> {
        self.flush(w)?;
        if self.written != self.len {
            return Err(Error::new("merge: an index has fewer entries than rows"));
        }
        self.fences.iter().for_each(|&f| put_u64(scratch, f));
        let fences = w.section(scratch)?;
        Ok(ArrayDesc {
            base: self.base,
            len: self.len as u32,
            per: self.per as u32,
            fences,
        })
    }
}

/// A keys index being written block by block.
struct KeysOut {
    entries: Vec<(Box<[u8]>, u32)>,
    blocks: Vec<(u64, u64, usize)>,
    fences: Vec<u8>,
    fence_offs: Vec<u64>,
    prev_last: Vec<u8>,
    total: usize,
    body: Vec<u8>,
}

impl KeysOut {
    fn new() -> KeysOut {
        KeysOut {
            entries: Vec::with_capacity(crate::keys::KEYS_PER),
            blocks: Vec::new(),
            fences: Vec::new(),
            fence_offs: vec![0],
            prev_last: Vec::new(),
            total: 0,
            body: Vec::new(),
        }
    }

    fn push(&mut self, w: &mut Writer, key: Box<[u8]>, row: u32) -> Result<(), Error> {
        self.entries.push((key, row));
        if self.entries.len() == crate::keys::KEYS_PER {
            self.flush(w)?;
        }
        Ok(())
    }

    fn flush(&mut self, w: &mut Writer) -> Result<(), Error> {
        if self.entries.is_empty() {
            return Ok(());
        }
        let refs: Vec<(&[u8], u32)> = self.entries.iter().map(|(k, r)| (&k[..], *r)).collect();
        crate::keys::encode_lean_block(&mut self.body, &refs);
        let (off, len) = w.block(&mut self.body)?;
        self.blocks.push((off, len, self.total));
        self.fences
            .extend_from_slice(crate::keys::separator(&self.prev_last, &self.entries[0].0));
        self.fence_offs.push(self.fences.len() as u64);
        self.prev_last.clear();
        self.prev_last
            .extend_from_slice(&self.entries.last().expect("not empty").0);
        self.total += self.entries.len();
        self.entries.clear();
        Ok(())
    }

    fn finish(mut self, w: &mut Writer, scratch: &mut Vec<u8>) -> Result<SectionRef, Error> {
        self.flush(w)?;
        put_u64(scratch, self.blocks.len() as u64);
        put_u64(scratch, self.total as u64);
        for &(off, len, first) in &self.blocks {
            put_u64(scratch, off);
            put_u64(scratch, len);
            put_u64(scratch, first as u64);
        }
        self.fence_offs.iter().for_each(|&o| put_u64(scratch, o));
        scratch.extend_from_slice(&self.fences);
        w.section(scratch)
    }
}

/// Appends one row's fields (those `keep` marks) to a record block as u32 words.
fn put_record(out: &mut Vec<u8>, vals: &[Val<'_>], keep: &[bool]) {
    for (v, _) in vals.iter().zip(keep).filter(|x| *x.1) {
        match v {
            Val::U32(x) => put_u32(out, *x),
            Val::F64(x) => put_u64(out, x.to_bits()),
            Val::Multi(xs) => {
                put_u32(out, xs.len() as u32);
                xs.iter().for_each(|&x| put_u32(out, x));
            }
            Val::Str(s) => {
                put_u32(out, s.len() as u32);
                out.extend_from_slice(s.as_bytes());
                out.resize(out.len().next_multiple_of(4), 0);
            }
        }
    }
}

/// Appends column `c` of `rows` (each `width` values) as a column chunk.
fn put_chunk(out: &mut Vec<u8>, vals: &[Val<'_>], width: usize, c: usize, kind: Kind) {
    let col = vals.iter().skip(c).step_by(width);
    match kind {
        Kind::U32 => col.for_each(|v| put_u32(out, if let Val::U32(x) = v { *x } else { 0 })),
        Kind::F64 => col.for_each(|v| {
            out.extend_from_slice(&if let Val::F64(x) = v { *x } else { 0.0 }.to_le_bytes())
        }),
        Kind::U32Multi => {
            let mut at = 0u32;
            put_u32(out, 0);
            for v in col.clone() {
                at += if let Val::Multi(xs) = v {
                    xs.len() as u32
                } else {
                    0
                };
                put_u32(out, at);
            }
            for v in col {
                if let Val::Multi(xs) = v {
                    xs.iter().for_each(|&x| put_u32(out, x));
                }
            }
        }
        Kind::Str => {
            let mut at = 0u32;
            put_u32(out, 0);
            for v in col.clone() {
                at += if let Val::Str(s) = v {
                    s.len() as u32
                } else {
                    0
                };
                put_u32(out, at);
            }
            for v in col {
                if let Val::Str(s) = v {
                    out.extend_from_slice(s.as_bytes());
                }
            }
        }
    }
}

/// The state of a merge across its steps.
pub(crate) struct Merge {
    schema: Schema,
    layout: Layout,
    /// Live rows: the new segment's rows.
    n: usize,
    /// Per source: old row to new row, `GONE` for rows left out.
    maps: Vec<Vec<u32>>,
    pk_cur: Vec<PkCursor>,
    next: usize,
    rows_started: bool,
    pairs: Option<PairsOut>,
    pk: Option<ArrayDesc>,
    col_refs: Vec<Vec<SectionRef>>,
    column_dirs: Vec<SectionRef>,
    index_dirs: Vec<SectionRef>,
    /// Record directory block bodies, padded, and the entries in each.
    dir_bodies: Vec<u8>,
    dir_ns: Vec<usize>,
    /// Per column that groups an ordered index: (value, rows) of the new segment.
    cards: Vec<Vec<(u32, u32)>>,
    scratch: Vec<u8>,
}

impl Merge {
    /// A merge of sources with these row counts into a segment of `n` live rows.
    pub fn new(schema: Schema, layout: Layout, lens: &[u32], n: usize) -> Merge {
        let width = schema.columns.len();
        Merge {
            layout,
            n,
            maps: lens.iter().map(|&l| vec![GONE; l as usize]).collect(),
            pk_cur: Vec::new(),
            next: 0,
            rows_started: true,
            pairs: None,
            pk: None,
            col_refs: vec![Vec::new(); width],
            column_dirs: Vec::new(),
            index_dirs: vec![SectionRef::default(); width],
            dir_bodies: Vec::new(),
            dir_ns: Vec::new(),
            cards: vec![Vec::new(); width],
            scratch: Vec::new(),
            schema,
        }
    }

    fn reset_pk(&mut self, srcs: usize) {
        self.pk_cur = (0..srcs).map(|_| PkCursor::default()).collect();
        self.next = 0;
    }

    /// Phase 1: the primary key array, numbering rows. Returns true when done.
    pub fn pk_step(&mut self, srcs: &[Src], w: &mut Writer) -> Result<bool, Error> {
        if self.pairs.is_none() && self.pk.is_none() {
            debug_assert_eq!(srcs.len(), self.maps.len());
            self.reset_pk(srcs.len());
            self.pairs = Some(PairsOut::begin(w, self.n, self.layout.pair_block)?);
        }
        for _ in 0..STEP {
            let Some((i, k, r)) = next_pk(&mut self.pk_cur, srcs) else {
                let out = self.pairs.take().expect("begun");
                self.pk = Some(out.finish(w, &mut self.scratch)?);
                self.rows_started = false;
                return Ok(true);
            };
            if self.next >= self.n {
                return Err(Error::new("merge: more live rows than counted"));
            }
            self.maps[i][r as usize] = self.next as u32;
            let row = self.next as u32;
            self.pairs.as_mut().expect("begun").push(w, k, row)?;
            self.next += 1;
        }
        Ok(false)
    }

    /// Rows per batch of phase 2: whole column chunks and whole record directory groups.
    fn batch_rows(&self) -> usize {
        (1usize << self.layout.chunk_shift).max(DIR_PER << self.layout.record_shift)
    }

    /// Phase 2: column chunks and records, in new row order. Returns true when done.
    pub fn rows_step(&mut self, srcs: &[Src], w: &mut Writer) -> Result<bool, Error> {
        if !self.rows_started {
            // Phase 1 left its cursors at the end; walk the primary key again.
            self.reset_pk(srcs.len());
            self.rows_started = true;
        }
        let width = self.schema.columns.len();
        let batch = self.batch_rows();
        let loaded_at_start = cache::cached_bytes();
        let mut done = 0;
        let mut rows: Vec<(usize, u32)> = Vec::with_capacity(batch);
        let mut per_src: Vec<Vec<u32>> = vec![Vec::new(); srcs.len()];
        let mut vals: Vec<Val<'_>> = Vec::with_capacity(batch * width);
        while done < STEP {
            rows.clear();
            while rows.len() < batch {
                match next_pk(&mut self.pk_cur, srcs) {
                    Some((i, _, r)) => rows.push((i, r)),
                    None => break,
                }
            }
            if rows.is_empty() {
                return self.finish_rows(w).map(|()| true);
            }
            per_src.iter_mut().for_each(Vec::clear);
            for &(i, r) in &rows {
                per_src[i].push(r);
            }
            for (src, rs) in srcs.iter().zip(&per_src) {
                if !rs.is_empty() {
                    on!(src, p => p.prefetch(rs));
                }
            }
            vals.clear();
            for &(i, r) in &rows {
                on!(&srcs[i], p => p.gather(r, &mut vals));
            }
            let chunk = 1usize << self.layout.chunk_shift;
            for (c, def) in self.schema.columns.iter().enumerate() {
                if def.kind == Kind::Str {
                    continue;
                }
                for part in vals.chunks(chunk * width) {
                    put_chunk(&mut self.scratch, part, width, c, def.kind);
                    self.col_refs[c].push(w.section(&mut self.scratch)?);
                }
            }
            let block = 1usize << self.layout.record_shift;
            for group in vals.chunks(DIR_PER * block * width) {
                self.put_group(w, group, width, block)?;
            }
            self.next += rows.len();
            done += rows.len();
            if rows.len() < batch {
                return self.finish_rows(w).map(|()| true);
            }
            if cache::cached_bytes().saturating_sub(loaded_at_start) > step_bytes() {
                break;
            }
        }
        Ok(false)
    }

    /// One record directory group: its record blocks, adjacent, and its directory body.
    fn put_group(
        &mut self,
        w: &mut Writer,
        vals: &[Val<'_>],
        width: usize,
        block: usize,
    ) -> Result<(), Error> {
        let keep: Vec<bool> = (0..width)
            .map(|c| in_record(&self.schema, FLAG_LEAN, c))
            .collect();
        let mut bodies: Vec<u8> = Vec::new();
        let mut lens: Vec<usize> = Vec::with_capacity(DIR_PER);
        let mut body: Vec<u8> = Vec::new();
        for rows in vals.chunks(block * width) {
            let n = rows.len() / width;
            body.clear();
            let start = bodies.len();
            let mut offsets: Vec<u32> = Vec::with_capacity(n + 1);
            for row in rows.chunks(width) {
                offsets.push((n + 1 + body.len() / 4) as u32);
                put_record(&mut body, row, &keep);
            }
            offsets.push((n + 1 + body.len() / 4) as u32);
            offsets.iter().for_each(|&o| put_u32(&mut bodies, o));
            bodies.extend_from_slice(&body);
            bodies.resize(bodies.len().next_multiple_of(8), 0);
            lens.push(bodies.len() - start);
        }
        let total: usize = lens.iter().map(|l| l + 8).sum();
        let base = w.reserve(total as u64)?;
        let (mut at, mut from) = (0usize, 0usize);
        let mut ends: Vec<u32> = Vec::with_capacity(lens.len());
        for &len in &lens {
            let mut b = bodies[from..from + len].to_vec();
            w.put_block(&mut b, base + at as u64)?;
            at += len + 8;
            from += len;
            ends.push(u32::try_from(at).map_err(|_| Error::new("record group over 4 GiB"))?);
        }
        let start = self.dir_bodies.len();
        put_u64(&mut self.dir_bodies, base);
        ends.iter().for_each(|&e| put_u32(&mut self.dir_bodies, e));
        self.dir_bodies
            .resize(start + dir_block_size(ends.len()) - 8, 0);
        self.dir_ns.push(ends.len());
        Ok(())
    }

    fn finish_rows(&mut self, w: &mut Writer) -> Result<(), Error> {
        if self.next != self.n {
            return Err(Error::new("merge: fewer live rows than counted"));
        }
        for (c, refs) in std::mem::take(&mut self.col_refs).into_iter().enumerate() {
            if self.schema.columns[c].kind == Kind::Str {
                self.column_dirs.push(SectionRef::default());
                continue;
            }
            refs.iter()
                .for_each(|r| put_ref_words(&mut self.scratch, r));
            self.column_dirs.push(w.section(&mut self.scratch)?);
        }
        self.pk_cur.clear();
        Ok(())
    }

    /// Phase 3, a bitmap index: one bitmap per value, `from` the value at that position of the
    /// sorted union of the sources' values. Returns the next position, or `None` when done.
    pub fn bitmap_step(
        &mut self,
        srcs: &[Src],
        w: &mut Writer,
        c: usize,
        values: &[u32],
        entries: &mut Vec<(u32, u32, SectionRef)>,
        from: usize,
    ) -> Result<Option<usize>, Error> {
        let mut rows: Vec<u32> = Vec::new();
        let mut done = 0;
        let mut at = from;
        while at < values.len() && done < STEP {
            let v = values[at];
            rows.clear();
            for (src, map) in srcs.iter().zip(&self.maps) {
                let b = on!(src, p => p.bitmap(c, &Test::U32Set(vec![v])));
                rows.extend(b.iter().map(|r| map[r as usize]).filter(|&r| r != GONE));
            }
            rows.sort_unstable();
            done += rows.len().max(1);
            at += 1;
            if rows.is_empty() {
                continue;
            }
            let b = RoaringBitmap::from_sorted_iter(rows.iter().copied())
                .map_err(|_| Error::new("merge: bitmap rows out of order"))?;
            b.serialize_into(&mut self.scratch)
                .expect("writing to a Vec does not fail");
            entries.push((v, rows.len() as u32, w.section(&mut self.scratch)?));
        }
        if at < values.len() {
            return Ok(Some(at));
        }
        let is_group = self
            .schema
            .columns
            .iter()
            .any(|d| d.group.as_deref() == Some(self.schema.columns[c].name.as_str()));
        if is_group {
            self.cards[c] = entries.iter().map(|e| (e.0, e.1)).collect();
        }
        put_u64(&mut self.scratch, entries.len() as u64);
        for (value, card, _) in entries.iter() {
            put_u32(&mut self.scratch, *value);
            put_u32(&mut self.scratch, *card);
        }
        entries
            .iter()
            .for_each(|e| put_ref_words(&mut self.scratch, &e.2));
        self.index_dirs[c] = w.section(&mut self.scratch)?;
        Ok(None)
    }

    /// The sorted union of the sources' bitmap values on `c`.
    pub fn bitmap_values(srcs: &[Src], c: usize) -> Vec<u32> {
        let mut v: Vec<u32> = srcs
            .iter()
            .flat_map(|s| on!(s, p => p.bitmap_values(c)))
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// Phase 3, an ordered index: the global array, then one array per group. `state` carries
    /// the arrays done and the walk in progress between steps. Returns true when done.
    pub fn ordered_step(
        &mut self,
        srcs: &[Src],
        w: &mut Writer,
        c: usize,
        state: &mut OrderedState,
    ) -> Result<bool, Error> {
        let groups: Vec<(u32, u32)> = match &self.schema.columns[c].group {
            Some(g) => self.cards[self.schema.column(g).expect("validated")].clone(),
            None => Vec::new(),
        };
        let mut done = 0;
        while done < STEP {
            // Which array: 0 is the global one, then the groups.
            let (walk, len) = match state.array {
                0 => (Walk::Global(c), self.n),
                k if k <= groups.len() => {
                    (Walk::Group(c, groups[k - 1].0), groups[k - 1].1 as usize)
                }
                _ => break,
            };
            if state.out.is_none() {
                state.cur = srcs.iter().map(|s| OrdCursor::new(s, walk)).collect();
                state.out = Some(PairsOut::begin(w, len, self.layout.pair_block)?);
            }
            loop {
                let mut best: Option<((u64, u32), usize)> = None;
                for (i, cur) in state.cur.iter_mut().enumerate() {
                    if let Some(e) = cur.head(&srcs[i], walk, &self.maps[i])
                        && best.is_none_or(|b| e < b.0)
                    {
                        best = Some((e, i));
                    }
                }
                let Some(((k, r), i)) = best else {
                    let a = state
                        .out
                        .take()
                        .expect("begun")
                        .finish(w, &mut self.scratch)?;
                    state.arrays.push(a);
                    state.array += 1;
                    break;
                };
                state.cur[i].at += 1;
                state.out.as_mut().expect("begun").push(w, k, r)?;
                done += 1;
                if done >= STEP {
                    return Ok(false);
                }
            }
        }
        if state.array <= groups.len() {
            return Ok(false);
        }
        put_array_words(&mut self.scratch, &state.arrays[0]);
        put_u64(&mut self.scratch, groups.len() as u64);
        for ((value, _), a) in groups.iter().zip(&state.arrays[1..]) {
            put_u64(&mut self.scratch, *value as u64);
            put_array_words(&mut self.scratch, a);
        }
        self.index_dirs[c] = w.section(&mut self.scratch)?;
        Ok(true)
    }

    /// Phase 3, a keys index. Returns true when done.
    pub fn keys_step(
        &mut self,
        srcs: &[Src],
        w: &mut Writer,
        c: usize,
        state: &mut KeysState,
    ) -> Result<bool, Error> {
        if state.out.is_none() {
            state.cur = srcs.iter().map(|_| KeyCursor::default()).collect();
            state.out = Some(KeysOut::new());
        }
        let mut run: Vec<u32> = Vec::new();
        let mut done = 0;
        while done < STEP {
            let mut least: Option<Box<[u8]>> = None;
            for (i, cur) in state.cur.iter_mut().enumerate() {
                if let Some(k) = cur.head(&srcs[i], c, &self.maps[i])
                    && least.as_deref().is_none_or(|l| k < l)
                {
                    least = Some(k.into());
                }
            }
            let Some(key) = least else {
                let out = state.out.take().expect("begun");
                self.index_dirs[c] = out.finish(w, &mut self.scratch)?;
                return Ok(true);
            };
            run.clear();
            for (i, cur) in state.cur.iter_mut().enumerate() {
                while let Some(k) = cur.head(&srcs[i], c, &self.maps[i]) {
                    if *k != *key {
                        break;
                    }
                    run.push(cur.buf[cur.at].1);
                    cur.at += 1;
                }
            }
            run.sort_unstable();
            let out = state.out.as_mut().expect("begun");
            for &r in &run {
                out.push(w, key.clone(), r)?;
            }
            done += run.len();
        }
        Ok(false)
    }

    /// Phase 4: the record directory; returns the new segment's directory.
    pub fn finish(mut self, w: &mut Writer) -> Result<SegmentMeta, Error> {
        let total: usize = self.dir_ns.iter().map(|&n| dir_block_size(n)).sum();
        let base = w.reserve(total as u64)?;
        let (mut at, mut from) = (0usize, 0usize);
        for &n in &self.dir_ns {
            let len = dir_block_size(n) - 8;
            let mut b = self.dir_bodies[from..from + len].to_vec();
            w.put_block(&mut b, base + at as u64)?;
            at += len + 8;
            from += len;
        }
        for (c, def) in self.schema.columns.iter().enumerate() {
            if (def.index == IndexKind::None) != (self.index_dirs[c].len == 0) {
                return Err(Error::new(format!(
                    "merge: index of {} not written",
                    def.name
                )));
            }
        }
        Ok(SegmentMeta {
            rows: self.n as u32,
            chunk_shift: self.layout.chunk_shift,
            pair_block: self.layout.pair_block,
            record_shift: self.layout.record_shift,
            flags: FLAG_ROWS_IN_PK_ORDER | FLAG_LEAN | FLAG_LOGICAL,
            extents: Vec::new(),
            deleted: 0,
            dead: SectionRef::default(),
            pk: self
                .pk
                .take()
                .ok_or_else(|| Error::new("merge: no primary key"))?,
            record_dir: base,
            column_dirs: std::mem::take(&mut self.column_dirs),
            index_dirs: std::mem::take(&mut self.index_dirs),
        })
    }
}

/// An ordered index merge in progress.
#[derive(Default)]
pub(crate) struct OrderedState {
    array: usize,
    arrays: Vec<ArrayDesc>,
    cur: Vec<OrdCursor>,
    out: Option<PairsOut>,
}

/// A keys index merge in progress.
#[derive(Default)]
pub(crate) struct KeysState {
    cur: Vec<KeyCursor>,
    out: Option<KeysOut>,
}

/// The rows of `src` a merge keeps, for `Merge::new`.
pub(crate) fn live(src: &Src) -> usize {
    src.len() as usize - src.dead().rows.len() as usize
}
