//! A saved segment, read lazily. Opening keeps only the segment's few manifest fields; every
//! directory, column chunk, bitmap, pairs block and record block is read and checksummed the
//! first time a query touches it, then kept until the memory budget drops it (`cache`): leaf
//! pieces are registered as units with a last-use stamp, and `evict` or `reset` drop them, after
//! which the next touch reads and checks them again.

use crate::Error;
use crate::cache::{self, Slot, slots};
use crate::dead::Tombstones;
use crate::format::{
    ARRAY_WORDS, ArrayDesc, DIR_PER, FLAG_LEAN, FLAG_LOGICAL, FLAG_ROWS_IN_PK_ORDER, REF_WORDS,
    SectionRef, SegmentMeta, array_from_words, block_checksum, checksum, corrupt, field_words,
    in_record, read_dead, ref_from_words,
};
use crate::part::{Part, Val};
use crate::query::Test;
use crate::schema::{IndexKind, Kind, Schema};
use crate::storage::Storage;
use roaring::RoaringBitmap;
use std::borrow::Cow;
use std::cell::{Cell, OnceCell, RefCell};
use std::rc::Rc;

/// What lazy loading has read since open, across every segment of a database, and the clock
/// that stamps the pieces it touches.
#[derive(Debug, Default)]
pub(crate) struct Cache {
    /// Bytes read from storage.
    pub bytes: Cell<u64>,
    /// Sections and blocks loaded.
    pub sections: Cell<u64>,
    /// Storage reads; adjacent sections loaded together share one.
    pub reads: Cell<u64>,
    /// The database's operation count: a piece touched by a later operation was used more
    /// recently.
    pub now: Cell<u32>,
}

/// One blocked (key, row) array of a segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Arr {
    Pk,
    /// The global ordered index on a column.
    Ord(u32),
    /// Group `.1` (a position in the group list) of the ordered index on column `.0`.
    Grp(u32, u32),
}

/// A piece the budget can drop on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unit {
    /// Column, chunk.
    Chunk(u32, u32),
    /// Column, position in the bitmap directory.
    Bitmap(u32, u32),
    Fences(Arr),
    Block(Arr, u32),
    /// Column, block of its keys index.
    KeyBlock(u32, u32),
    /// A record directory block with the record blocks it lists.
    Records(u32),
}

/// Pieces whose gap is at most this many bytes are read in one storage call.
const COALESCE_GAP: u64 = 256;

/// Record blocks a segment loads one by one before it reads whole directory groups instead. A
/// segment that has gathered this many scattered rows is being read broadly; whole groups (128
/// rows at the default layout) then cost one read for rows a later call will want, as a column
/// chunk did. The first queries after open stay at one small block per row.
const EXTENT_AFTER: u64 = 4096;

/// Gap allowed inside one read once a segment reads whole groups: the group's blocks that are
/// already loaded are read again rather than splitting the read.
const EXTENT_GAP: u64 = 4096;

/// `n` offsets plus one, relative to the chunk, then the values (`u32_multi`) or bytes (`str`).
struct VarChunk {
    buf: Vec<u32>,
    n: usize,
}

impl VarChunk {
    #[inline]
    fn values(&self, r: usize) -> Option<&[u32]> {
        let base = self.n + 1;
        let (a, b) = (*self.buf.get(r)? as usize, *self.buf.get(r + 1)? as usize);
        self.buf.get(base + a..base + b)
    }
}

enum ColCells {
    U32(Box<[Slot<Box<[u32]>>]>),
    F64(Box<[Slot<Box<[f64]>>]>),
    Multi(Box<[Slot<VarChunk>]>),
    /// String columns are read only through records.
    Str,
}

struct Column {
    refs: Box<[SectionRef]>,
    cells: ColCells,
}

/// Per block of a pairs array: `n` keys, then `n` row ids packed two to a word.
type PairCells = Box<[Slot<Box<[u64]>>]>;

/// One blocked (key, row) array: its blocks and fences, loaded on first touch.
struct LazyPairs {
    desc: ArrayDesc,
    fences: Slot<Box<[u64]>>,
    blocks: OnceCell<PairCells>,
}

impl LazyPairs {
    fn new(desc: ArrayDesc) -> LazyPairs {
        LazyPairs {
            desc,
            fences: Slot::default(),
            blocks: OnceCell::new(),
        }
    }

    fn slot_mut(&mut self, u: Unit) -> Option<&mut Slot<Box<[u64]>>> {
        match u {
            Unit::Fences(_) => Some(&mut self.fences),
            Unit::Block(_, i) => self.blocks.get_mut()?.get_mut(i as usize),
            _ => None,
        }
    }

    fn slot(&self, u: Unit) -> Option<&Slot<Box<[u64]>>> {
        match u {
            Unit::Fences(_) => Some(&self.fences),
            Unit::Block(_, i) => self.blocks.get()?.get(i as usize),
            _ => None,
        }
    }
}

/// A loaded bitmap directory: its words, the number of values, and the bitmaps' cells.
type BitmapDir<'a> = (&'a [u64], usize, &'a [Slot<RoaringBitmap>]);

enum IndexState {
    Bitmap {
        /// `n`, then `n` (value | cardinality << 32), then `n` section refs, as read.
        dir: Box<[u64]>,
        n: usize,
        cells: Box<[Slot<RoaringBitmap>]>,
    },
    Ordered {
        global: LazyPairs,
        groups: Box<[(u32, LazyPairs)]>,
    },
    Keys(crate::keys::KeysDir),
}

/// One record directory block and the record blocks it lists.
struct RecGroup {
    start: u64,
    ends: Box<[u32]>,
    blocks: Box<[OnceCell<Box<[u32]>>]>,
}

impl RecGroup {
    fn base_size(&self) -> usize {
        std::mem::size_of::<RecGroup>() + size_of_val(&*self.ends) + size_of_val(&*self.blocks)
    }
}

/// Bytes a loaded piece holds, counted against the budget when it loads and released when it
/// drops; each must give the same answer at both times. They take the slot's own type, boxes
/// included, to serve as `fn(&T) -> usize`.
#[allow(clippy::borrowed_box)]
fn words_size<T>(v: &Box<[T]>) -> usize {
    size_of_val(&**v)
}

fn var_size(v: &VarChunk) -> usize {
    v.buf.len() * 4
}

fn bitmap_size(b: &RoaringBitmap) -> usize {
    b.serialized_size()
}

fn key_block_size(b: &crate::keys::KeyBlock) -> usize {
    b.heap_size()
}

#[allow(clippy::borrowed_box)]
fn group_size(g: &Box<RecGroup>) -> usize {
    g.base_size()
        + g.blocks
            .iter()
            .filter_map(OnceCell::get)
            .map(words_size)
            .sum::<usize>()
}

fn column_size(c: &Column) -> usize {
    size_of_val(&*c.refs)
        + match &c.cells {
            ColCells::U32(s) => size_of_val(&**s),
            ColCells::F64(s) => size_of_val(&**s),
            ColCells::Multi(s) => size_of_val(&**s),
            ColCells::Str => 0,
        }
}

fn index_size(i: &IndexState) -> usize {
    match i {
        IndexState::Bitmap { dir, cells, .. } => size_of_val(&**dir) + size_of_val(&**cells),
        IndexState::Ordered { groups, .. } => size_of_val(&**groups),
        IndexState::Keys(d) => d.heap_size(),
    }
}

/// The stamp of a loaded slot; `None` when it is not loaded.
fn stamp<T>(s: &Slot<T>) -> Option<u32> {
    s.peek().map(|_| s.used())
}

pub(crate) struct Segment {
    pub(crate) meta: SegmentMeta,
    schema: Schema,
    pk_col: usize,
    storage: Rc<dyn Storage>,
    stats: Rc<Cache>,
    shift: u32,
    mask: u32,
    cols: Box<[OnceCell<Column>]>,
    indexes: Box<[OnceCell<IndexState>]>,
    pk: LazyPairs,
    records: OnceCell<Box<[Slot<Box<RecGroup>>]>>,
    /// Record blocks loaded so far.
    record_loads: Cell<u64>,
    /// Logical offset, file offset and length of each extent, for a segment whose offsets are
    /// logical (`FLAG_LOGICAL`); empty when they are file offsets.
    map: Box<[(u64, u64, u64)]>,
    /// Bytes counted against the budget for what this segment holds loaded.
    held: Cell<usize>,
    /// Pieces loaded that the budget can drop one by one, each with the clock when it loaded.
    units: RefCell<Vec<(Unit, u32)>>,
    failed: RefCell<Option<Error>>,
    /// Deleted and replaced rows: the saved delete bitmap, read on first touch, plus marks made
    /// since.
    dead: OnceCell<Tombstones>,
    /// Whether `dead` holds marks the file does not.
    pub(crate) dead_changed: bool,
}

/// `Segment::map` for `meta`.
fn map_of(meta: &SegmentMeta) -> Box<[(u64, u64, u64)]> {
    if meta.flags & FLAG_LOGICAL == 0 {
        return Box::default();
    }
    let mut at = crate::format::DATA_START;
    meta.extents
        .iter()
        .map(|&(a, b)| {
            let e = (at, a, b - a);
            at += b - a;
            e
        })
        .collect()
}

fn cells<T>(n: usize) -> Box<[OnceCell<T>]> {
    (0..n).map(|_| OnceCell::new()).collect()
}

/// Little-endian u32 words of `bytes`, whatever their alignment.
fn le_words(bytes: &[u8]) -> Vec<u32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|w| u32::from_le_bytes(*w))
        .collect()
}

fn verify_block(bytes: &[u8], off: u64) -> Result<(), Error> {
    let body = bytes
        .len()
        .checked_sub(8)
        .ok_or_else(|| corrupt("block is short"))?;
    let sum = u64::from_le_bytes(bytes[body..].try_into().unwrap());
    if block_checksum(&bytes[..body], off) != sum {
        return Err(Error::new(format!(
            "checksum mismatch in the block at offset {off}"
        )));
    }
    Ok(())
}

impl Segment {
    pub(crate) fn new(
        meta: SegmentMeta,
        schema: Schema,
        storage: Rc<dyn Storage>,
        stats: Rc<Cache>,
    ) -> Result<Segment, Error> {
        let pk_col = schema.validate()?;
        let n = schema.columns.len();
        if meta.column_dirs.len() != n || meta.index_dirs.len() != n {
            return Err(corrupt("segment directory"));
        }
        for (def, dir) in schema.columns.iter().zip(&meta.index_dirs) {
            if (def.index == IndexKind::None) != (dir.len == 0) {
                return Err(corrupt("index directory"));
            }
        }
        Ok(Segment {
            pk: LazyPairs::new(meta.pk),
            shift: meta.chunk_shift,
            mask: (1u32 << meta.chunk_shift) - 1,
            cols: cells(n),
            indexes: cells(n),
            records: OnceCell::new(),
            record_loads: Cell::new(0),
            held: Cell::new(0),
            units: RefCell::default(),
            map: map_of(&meta),
            meta,
            schema,
            pk_col,
            storage,
            stats,
            failed: RefCell::new(None),
            dead: OnceCell::new(),
            dead_changed: false,
        })
    }

    /// The segment's deleted rows, reading its delete bitmap on first touch.
    pub(crate) fn tombstones(&self) -> Result<&Tombstones, Error> {
        if let Some(t) = self.dead.get() {
            return Ok(t);
        }
        let rows = read_dead(&*self.storage, &self.meta)?;
        if self.meta.dead.len > 0 {
            self.count(self.meta.dead.len as usize, 1);
        }
        Ok(self.dead.get_or_init(|| Tombstones::new(rows)))
    }

    /// Marks `row` deleted.
    pub(crate) fn mark_dead(&mut self, row: u32) -> Result<(), Error> {
        self.tombstones()?;
        self.dead.get_mut().expect("loaded above").mark(row);
        self.dead_changed = true;
        Ok(())
    }

    /// Drops delete marks made since the last save: the saved bitmap is read again on next touch.
    pub(crate) fn forget_dead(&mut self) {
        self.dead = OnceCell::new();
        self.dead_changed = false;
    }

    /// Rows deleted or replaced, saved or not, without reading the delete bitmap.
    pub(crate) fn deleted(&self) -> u64 {
        self.dead
            .get()
            .map_or(self.meta.deleted as u64, |t| t.rows.len())
    }

    fn count(&self, bytes: usize, sections: usize) {
        self.stats.bytes.set(self.stats.bytes.get() + bytes as u64);
        self.stats
            .sections
            .set(self.stats.sections.get() + sections as u64);
        self.stats.reads.set(self.stats.reads.get() + 1);
    }

    /// Fills `buf` from the segment's offset `off`, through its extents when its offsets are
    /// logical.
    fn read_at(&self, off: u64, buf: &mut [u8]) -> Result<(), Error> {
        if self.map.is_empty() {
            return self.storage.read_at(off, buf);
        }
        let past = || Error::new("read past the end of the segment");
        let mut i = self
            .map
            .partition_point(|e| e.0 <= off)
            .checked_sub(1)
            .ok_or_else(past)?;
        let (mut at, mut done) = (off, 0);
        while done < buf.len() {
            let &(l, p, len) = self.map.get(i).ok_or_else(past)?;
            let inside = at - l;
            if inside >= len {
                return Err(past());
            }
            let n = ((len - inside) as usize).min(buf.len() - done);
            self.storage.read_at(p + inside, &mut buf[done..done + n])?;
            done += n;
            at += n as u64;
            i += 1;
        }
        Ok(())
    }

    /// Moves the segment's bytes to `extents` (the same bytes, in the same logical order).
    pub(crate) fn set_extents(&mut self, extents: Vec<(u64, u64)>) {
        self.meta.extents = extents;
        self.map = map_of(&self.meta);
    }

    /// Reads and checks a section referenced with its checksum.
    fn read_section<T: bytemuck::Pod>(&self, r: &SectionRef) -> Result<Vec<T>, Error> {
        let size = std::mem::size_of::<T>();
        if !(r.len as usize).is_multiple_of(size) {
            return Err(corrupt("section length"));
        }
        let mut v = vec![T::zeroed(); r.len as usize / size];
        let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut v);
        self.read_at(r.off, bytes)?;
        if checksum(bytes) != r.sum {
            return Err(Error::new(format!(
                "checksum mismatch in the section at offset {}",
                r.off
            )));
        }
        self.count(r.len as usize, 1);
        Ok(v)
    }

    /// Reads a self-checked block of `len` bytes (checksum included) into words.
    fn read_block<T: bytemuck::Pod>(&self, off: u64, len: usize) -> Result<Vec<T>, Error> {
        let mut v = vec![T::zeroed(); len / std::mem::size_of::<T>()];
        let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut v);
        self.read_at(off, bytes)?;
        verify_block(bytes, off)?;
        self.count(len, 1);
        Ok(v)
    }

    /// Reads `(offset, len)` pieces, one storage call per run of pieces at most `COALESCE_GAP`
    /// apart, and hands each piece's bytes to `f` with its position in `pieces`.
    fn read_many(
        &self,
        pieces: &[(u64, usize)],
        f: impl FnMut(usize, &[u8], u64) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.read_runs(pieces, COALESCE_GAP, f)
    }

    /// `read_many` with pieces up to `gap` bytes apart sharing a read.
    fn read_runs(
        &self,
        pieces: &[(u64, usize)],
        gap: u64,
        mut f: impl FnMut(usize, &[u8], u64) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut order: Vec<usize> = (0..pieces.len()).collect();
        order.sort_unstable_by_key(|&i| pieces[i].0);
        let mut buf: Vec<u64> = Vec::new();
        let mut at = 0;
        while at < order.len() {
            let start = pieces[order[at]].0;
            let mut end = start + pieces[order[at]].1 as u64;
            let mut next = at + 1;
            while next < order.len() && pieces[order[next]].0 <= end + gap {
                end = end.max(pieces[order[next]].0 + pieces[order[next]].1 as u64);
                next += 1;
            }
            let len = (end - start) as usize;
            buf.clear();
            buf.resize(len.div_ceil(8), 0);
            let bytes = &mut bytemuck::cast_slice_mut::<u64, u8>(&mut buf)[..len];
            self.read_at(start, bytes)?;
            self.count(len, next - at);
            for &i in &order[at..next] {
                let (off, n) = pieces[i];
                let from = (off - start) as usize;
                f(i, &bytes[from..from + n], off)?;
            }
            at = next;
        }
        Ok(())
    }

    #[inline]
    fn now(&self) -> u32 {
        self.stats.now.get()
    }

    /// Counts `bytes` newly loaded against the budget, and registers `unit` if it is one.
    fn charge(&self, bytes: usize, unit: Option<Unit>) {
        self.held.set(self.held.get() + bytes);
        cache::charge(bytes);
        if let Some(u) = unit {
            self.units.borrow_mut().push((u, self.now()));
        }
    }

    /// The slot's value, loading it on first touch. `None` after a failed load, which is
    /// recorded.
    #[inline]
    fn get<'a, T>(
        &self,
        slot: &'a Slot<T>,
        unit: Unit,
        size: fn(&T) -> usize,
        load: impl FnOnce() -> Result<T, Error>,
    ) -> Option<&'a T> {
        match slot.get(self.now()) {
            Some(v) => Some(v),
            None => self.load(slot, unit, size, load),
        }
    }

    #[cold]
    #[inline(never)]
    fn load<'a, T>(
        &self,
        slot: &'a Slot<T>,
        unit: Unit,
        size: fn(&T) -> usize,
        load: impl FnOnce() -> Result<T, Error>,
    ) -> Option<&'a T> {
        match load() {
            Ok(v) => {
                self.charge(size(&v), Some(unit));
                slot.set(v);
                slot.peek()
            }
            Err(e) => {
                self.fail(e);
                None
            }
        }
    }

    /// A directory's value, loading it on first touch. Directories are counted but dropped only
    /// with the whole segment's cache (`reset`).
    #[inline]
    fn get_dir<'a, T>(
        &self,
        cell: &'a OnceCell<T>,
        size: fn(&T) -> usize,
        load: impl FnOnce() -> Result<T, Error>,
    ) -> Option<&'a T> {
        match cell.get() {
            Some(v) => Some(v),
            None => self.load_dir(cell, size, load),
        }
    }

    #[cold]
    #[inline(never)]
    fn load_dir<'a, T>(
        &self,
        cell: &'a OnceCell<T>,
        size: fn(&T) -> usize,
        load: impl FnOnce() -> Result<T, Error>,
    ) -> Option<&'a T> {
        match load() {
            Ok(v) => {
                self.charge(size(&v), None);
                let _ = cell.set(v);
                cell.get()
            }
            Err(e) => {
                self.fail(e);
                None
            }
        }
    }

    fn fail(&self, e: Error) {
        self.failed.borrow_mut().get_or_insert(e);
    }

    /// Whether the memory budget holds this segment's bytes twice over. Reading whole record
    /// groups pays only when what it reads stays loaded; under a budget smaller than that, a
    /// segment reads only the record blocks a call needs.
    fn fits_twice(&self) -> bool {
        let size: u64 = self.meta.extents.iter().map(|e| e.1 - e.0).sum();
        size.saturating_mul(2) <= cache::memory_budget() as u64
    }

    /// Bytes this segment holds loaded, as counted against the budget.
    pub(crate) fn held(&self) -> usize {
        self.held.get()
    }

    /// Per droppable piece loaded, in registration order: the stamp of its last use, and whether
    /// any operation after the one that loaded it used it again.
    pub(crate) fn unit_stamps(&self) -> Vec<(u32, bool)> {
        self.units
            .borrow()
            .iter()
            .map(|&(u, born)| {
                let used = self.unit_stamp(u).unwrap_or(0);
                (used, used != born)
            })
            .collect()
    }

    fn lazy(&self, a: Arr) -> Option<&LazyPairs> {
        match a {
            Arr::Pk => Some(&self.pk),
            Arr::Ord(c) => match self.indexes[c as usize].get()? {
                IndexState::Ordered { global, .. } => Some(global),
                _ => None,
            },
            Arr::Grp(c, g) => match self.indexes[c as usize].get()? {
                IndexState::Ordered { groups, .. } => groups.get(g as usize).map(|x| &x.1),
                _ => None,
            },
        }
    }

    fn lazy_mut(&mut self, a: Arr) -> Option<&mut LazyPairs> {
        match a {
            Arr::Pk => Some(&mut self.pk),
            Arr::Ord(c) => match self.indexes[c as usize].get_mut()? {
                IndexState::Ordered { global, .. } => Some(global),
                _ => None,
            },
            Arr::Grp(c, g) => match self.indexes[c as usize].get_mut()? {
                IndexState::Ordered { groups, .. } => groups.get_mut(g as usize).map(|x| &mut x.1),
                _ => None,
            },
        }
    }

    fn unit_stamp(&self, u: Unit) -> Option<u32> {
        match u {
            Unit::Chunk(c, i) => match &self.cols[c as usize].get()?.cells {
                ColCells::U32(s) => stamp(&s[i as usize]),
                ColCells::F64(s) => stamp(&s[i as usize]),
                ColCells::Multi(s) => stamp(&s[i as usize]),
                ColCells::Str => None,
            },
            Unit::Bitmap(c, i) => match self.indexes[c as usize].get()? {
                IndexState::Bitmap { cells, .. } => stamp(&cells[i as usize]),
                _ => None,
            },
            Unit::Fences(a) | Unit::Block(a, _) => stamp(self.lazy(a)?.slot(u)?),
            Unit::KeyBlock(c, i) => match self.indexes[c as usize].get()? {
                IndexState::Keys(d) => stamp(&d.cells[i as usize]),
                _ => None,
            },
            Unit::Records(g) => stamp(&self.records.get()?[g as usize]),
        }
    }

    /// Drops the pieces at these positions of `unit_stamps` (a record group with its record
    /// blocks); returns the bytes released.
    pub(crate) fn evict(&mut self, positions: &[usize]) -> usize {
        let mut units = std::mem::take(self.units.get_mut());
        let mut freed = 0;
        let mut gone = vec![false; units.len()];
        for &p in positions {
            if let Some(&(u, _)) = units.get(p)
                && !gone[p]
            {
                gone[p] = true;
                freed += self.drop_unit(u);
            }
        }
        let mut k = 0;
        units.retain(|_| {
            k += 1;
            !gone[k - 1]
        });
        *self.units.get_mut() = units;
        self.held.set(self.held.get() - freed);
        cache::release(freed);
        freed
    }

    /// Bytes the piece at position `p` of `unit_stamps` holds.
    pub(crate) fn unit_size(&self, p: usize) -> usize {
        let Some(&(u, _)) = self.units.borrow().get(p) else {
            return 0;
        };
        let i = |x: u32| x as usize;
        match u {
            Unit::Chunk(c, k) => match self.cols[i(c)].get().map(|c| &c.cells) {
                Some(ColCells::U32(s)) => s[i(k)].peek().map_or(0, words_size),
                Some(ColCells::F64(s)) => s[i(k)].peek().map_or(0, words_size),
                Some(ColCells::Multi(s)) => s[i(k)].peek().map_or(0, var_size),
                _ => 0,
            },
            Unit::Bitmap(c, k) => match self.indexes[i(c)].get() {
                Some(IndexState::Bitmap { cells, .. }) => cells[i(k)].peek().map_or(0, bitmap_size),
                _ => 0,
            },
            Unit::Fences(a) | Unit::Block(a, _) => self
                .lazy(a)
                .and_then(|lp| lp.slot(u))
                .and_then(Slot::peek)
                .map_or(0, words_size),
            Unit::KeyBlock(c, k) => match self.indexes[i(c)].get() {
                Some(IndexState::Keys(d)) => d.cells[i(k)].peek().map_or(0, key_block_size),
                _ => 0,
            },
            Unit::Records(g) => self
                .records
                .get()
                .and_then(|r| r[i(g)].peek())
                .map_or(0, group_size),
        }
    }

    fn drop_unit(&mut self, u: Unit) -> usize {
        let i = |x: u32| x as usize;
        match u {
            Unit::Chunk(c, k) => match self.cols[i(c)].get_mut().map(|c| &mut c.cells) {
                Some(ColCells::U32(s)) => s[i(k)].take().map_or(0, |v| words_size(&v)),
                Some(ColCells::F64(s)) => s[i(k)].take().map_or(0, |v| words_size(&v)),
                Some(ColCells::Multi(s)) => s[i(k)].take().map_or(0, |v| var_size(&v)),
                _ => 0,
            },
            Unit::Bitmap(c, k) => match self.indexes[i(c)].get_mut() {
                Some(IndexState::Bitmap { cells, .. }) => {
                    cells[i(k)].take().map_or(0, |b| bitmap_size(&b))
                }
                _ => 0,
            },
            Unit::Fences(a) | Unit::Block(a, _) => self
                .lazy_mut(a)
                .and_then(|lp| lp.slot_mut(u))
                .and_then(Slot::take)
                .map_or(0, |v| words_size(&v)),
            Unit::KeyBlock(c, k) => match self.indexes[i(c)].get_mut() {
                Some(IndexState::Keys(d)) => d.cells[i(k)].take().map_or(0, |b| key_block_size(&b)),
                _ => 0,
            },
            Unit::Records(g) => self
                .records
                .get_mut()
                .and_then(|r| r[i(g)].take())
                .map_or(0, |rg| group_size(&rg)),
        }
    }

    /// Drops everything loaded except the delete marks; returns the bytes released.
    pub(crate) fn reset(&mut self) -> usize {
        let n = self.schema.columns.len();
        self.cols = cells(n);
        self.indexes = cells(n);
        self.pk = LazyPairs::new(self.meta.pk);
        self.records = OnceCell::new();
        self.units.get_mut().clear();
        let freed = self.held.replace(0);
        cache::release(freed);
        freed
    }

    // Columns.

    fn column(&self, c: usize) -> Option<&Column> {
        self.get_dir(&self.cols[c], column_size, || {
            let words = self.read_section::<u64>(&self.meta.column_dirs[c])?;
            let chunks = self.meta.chunks();
            if words.len() != chunks * REF_WORDS {
                return Err(corrupt("column directory length"));
            }
            let refs = words
                .chunks(REF_WORDS)
                .map(ref_from_words)
                .collect::<Result<_, _>>()?;
            let cells = match self.schema.columns[c].kind {
                Kind::U32 => ColCells::U32(slots(chunks)),
                Kind::F64 => ColCells::F64(slots(chunks)),
                Kind::U32Multi => ColCells::Multi(slots(chunks)),
                Kind::Str => ColCells::Str,
            };
            Ok(Column { refs, cells })
        })
    }

    fn chunk_rows(&self, i: usize) -> usize {
        let per = 1usize << self.shift;
        (self.meta.rows as usize - i * per).min(per)
    }

    fn fixed<T: bytemuck::Pod>(&self, col: &Column, i: usize) -> Result<Box<[T]>, Error> {
        let v = self.read_section::<T>(&col.refs[i])?;
        if v.len() < self.chunk_rows(i) {
            return Err(corrupt("column chunk is short"));
        }
        Ok(v.into_boxed_slice())
    }

    fn var(&self, col: &Column, i: usize) -> Result<VarChunk, Error> {
        let buf = self.read_section::<u32>(&col.refs[i])?;
        let n = self.chunk_rows(i);
        let offsets = buf
            .get(..=n)
            .ok_or_else(|| corrupt("column chunk is short"))?;
        let total = offsets[n] as usize;
        if offsets[0] != 0 || offsets.windows(2).any(|w| w[0] > w[1]) || total > buf.len() - n - 1 {
            return Err(corrupt("column chunk offsets"));
        }
        Ok(VarChunk { buf, n })
    }

    // The per-row accessors keep only loaded, in-range reads on their fast path: a bounds check
    // that can panic there measured about twice the cost of a random row read. Everything else
    // (first touch, failed load, a row past the end) lands in these.

    #[cold]
    #[inline(never)]
    fn u32_cold(&self, c: usize, row: u32) -> u32 {
        let Some(col) = self.column(c) else { return 0 };
        let ColCells::U32(cells) = &col.cells else {
            unreachable!("u32_at on column {c}")
        };
        let i = (row >> self.shift) as usize;
        let unit = Unit::Chunk(c as u32, i as u32);
        self.get(&cells[i], unit, words_size, || self.fixed(col, i))
            .map_or(0, |v| v[(row & self.mask) as usize])
    }

    #[cold]
    #[inline(never)]
    fn f64_cold(&self, c: usize, row: u32) -> f64 {
        let Some(col) = self.column(c) else {
            return 0.0;
        };
        let ColCells::F64(cells) = &col.cells else {
            unreachable!("f64_at on column {c}")
        };
        let i = (row >> self.shift) as usize;
        let unit = Unit::Chunk(c as u32, i as u32);
        self.get(&cells[i], unit, words_size, || self.fixed(col, i))
            .map_or(0.0, |v| v[(row & self.mask) as usize])
    }

    #[cold]
    #[inline(never)]
    fn multi_cold(&self, c: usize, row: u32) -> &[u32] {
        let Some(col) = self.column(c) else {
            return &[];
        };
        let ColCells::Multi(cells) = &col.cells else {
            unreachable!("multi_at on column {c}")
        };
        let i = (row >> self.shift) as usize;
        let unit = Unit::Chunk(c as u32, i as u32);
        self.get(&cells[i], unit, var_size, || self.var(col, i))
            .map_or(&[], |ch| {
                ch.values((row & self.mask) as usize)
                    .expect("row is in the chunk")
            })
    }

    // Indexes.

    fn index(&self, c: usize) -> Option<&IndexState> {
        self.get_dir(&self.indexes[c], index_size, || {
            let dir = self.read_section::<u64>(&self.meta.index_dirs[c])?;
            match self.schema.columns[c].index {
                IndexKind::Bitmap => {
                    let n = *dir.first().ok_or_else(|| corrupt("bitmap directory"))? as usize;
                    if dir.len() != 1 + n * (1 + REF_WORDS) {
                        return Err(corrupt("bitmap directory length"));
                    }
                    let values = &dir[1..1 + n];
                    if values.windows(2).any(|w| w[0] as u32 >= w[1] as u32) {
                        return Err(corrupt("bitmap values out of order"));
                    }
                    for r in dir[1 + n..].chunks(REF_WORDS) {
                        ref_from_words(r)?;
                    }
                    Ok(IndexState::Bitmap {
                        dir: dir.into_boxed_slice(),
                        n,
                        cells: slots(n),
                    })
                }
                IndexKind::Ordered => {
                    let short = || corrupt("ordered directory length");
                    let global = array_from_words(dir.get(..ARRAY_WORDS).ok_or_else(short)?)?;
                    let groups = *dir.get(ARRAY_WORDS).ok_or_else(short)? as usize;
                    let rest = &dir[ARRAY_WORDS + 1..];
                    if global.len != self.meta.rows || rest.len() != groups * (1 + ARRAY_WORDS) {
                        return Err(short());
                    }
                    let mut gs: Vec<(u32, LazyPairs)> = Vec::with_capacity(groups);
                    for w in rest.chunks(1 + ARRAY_WORDS) {
                        let value = u32::try_from(w[0]).map_err(|_| corrupt("group value"))?;
                        if gs.last().is_some_and(|l| l.0 >= value) {
                            return Err(corrupt("group values out of order"));
                        }
                        gs.push((value, LazyPairs::new(array_from_words(&w[1..])?)));
                    }
                    Ok(IndexState::Ordered {
                        global: LazyPairs::new(global),
                        groups: gs.into_boxed_slice(),
                    })
                }
                IndexKind::Keys => Ok(IndexState::Keys(crate::keys::KeysDir::parse(&dir)?)),
                IndexKind::None => unreachable!("no directory without an index"),
            }
        })
    }

    fn keys_dir(&self, c: usize) -> Option<&crate::keys::KeysDir> {
        match self.index(c)? {
            IndexState::Keys(d) => Some(d),
            _ => unreachable!("column {c} has no keys index"),
        }
    }

    fn key_block<'a>(
        &'a self,
        c: usize,
        d: &'a crate::keys::KeysDir,
        b: usize,
    ) -> Option<&'a crate::keys::KeyBlock> {
        let unit = Unit::KeyBlock(c as u32, b as u32);
        self.get(&d.cells[b], unit, key_block_size, || {
            let (off, len) = d.block_span(b);
            let words = self.read_block::<u32>(off, len)?;
            if self.meta.flags & FLAG_LEAN != 0 {
                let body = &words[..words.len().saturating_sub(2)];
                return crate::keys::KeyBlock::parse(crate::keys::decode_lean_block(body)?);
            }
            crate::keys::KeyBlock::parse(words)
        })
    }

    /// Position of the first entry of the keys index on `c` whose key is >= `key`.
    fn keys_lower(&self, c: usize, d: &crate::keys::KeysDir, key: &[u8]) -> usize {
        if d.total() == 0 {
            return 0;
        }
        let b = d.block_for(key);
        self.key_block(c, d, b)
            .map_or(0, |blk| d.first(b) + blk.lower(key))
    }

    fn bitmap_dir(&self, c: usize) -> Option<BitmapDir<'_>> {
        match self.index(c)? {
            IndexState::Bitmap { dir, n, cells } => Some((dir, *n, cells)),
            _ => unreachable!("column {c} has no bitmap index"),
        }
    }

    fn ordered(&self, c: usize) -> Option<Pairs<'_>> {
        match self.index(c)? {
            IndexState::Ordered { global, .. } => Some(Pairs {
                seg: self,
                lp: global,
                arr: Arr::Ord(c as u32),
            }),
            _ => unreachable!("column {c} has no ordered index"),
        }
    }

    fn group(&self, c: usize, g: u32) -> Option<Pairs<'_>> {
        match self.index(c)? {
            IndexState::Ordered { groups, .. } => groups
                .binary_search_by_key(&g, |(v, _)| *v)
                .ok()
                .map(|i| Pairs {
                    seg: self,
                    lp: &groups[i].1,
                    arr: Arr::Grp(c as u32, i as u32),
                }),
            _ => unreachable!("column {c} has no ordered index"),
        }
    }

    fn pk_pairs(&self) -> Pairs<'_> {
        Pairs {
            seg: self,
            lp: &self.pk,
            arr: Arr::Pk,
        }
    }

    /// Positions in the bitmap directory of the values a test selects.
    fn bitmap_positions(dir: &[u64], n: usize, test: &Test) -> Vec<usize> {
        let values = &dir[1..1 + n];
        let value = |i: usize| values[i] as u32;
        let find = |v: u32| {
            let (mut lo, mut hi) = (0, n);
            while lo < hi {
                let mid = (lo + hi) / 2;
                if value(mid) < v {
                    lo = mid + 1
                } else {
                    hi = mid
                }
            }
            lo
        };
        match test {
            Test::U32Set(set) => set
                .iter()
                .filter_map(|&v| {
                    let i = find(v);
                    (i < n && value(i) == v).then_some(i)
                })
                .collect(),
            Test::U32Range(lo, hi) => {
                let start = find(*lo);
                let end = if *hi == u32::MAX { n } else { find(hi + 1) };
                (start..end.max(start)).collect()
            }
            _ => unreachable!("bitmap index on a u32 column"),
        }
    }

    /// Loads the bitmaps at `positions` that are not loaded yet, adjacent ones in one read.
    fn load_bitmaps(
        &self,
        c: usize,
        dir: &[u64],
        n: usize,
        cells: &[Slot<RoaringBitmap>],
        positions: &[usize],
    ) {
        let now = self.now();
        let todo: Vec<usize> = positions
            .iter()
            .copied()
            .filter(|&i| cells[i].get(now).is_none())
            .collect();
        if todo.is_empty() {
            return;
        }
        let sref =
            |i: usize| ref_from_words(&dir[1 + n + i * REF_WORDS..]).expect("checked at load");
        let pieces: Vec<(u64, usize)> = todo
            .iter()
            .map(|&i| {
                let r = sref(i);
                (r.off, r.len as usize)
            })
            .collect();
        let rows = self.meta.rows;
        let res = self.read_many(&pieces, |k, bytes, _| {
            let i = todo[k];
            if checksum(bytes) != sref(i).sum {
                return Err(Error::new(format!(
                    "checksum mismatch in the section at offset {}",
                    pieces[k].0
                )));
            }
            // The checksum covers the bytes, so the container checks are not repeated.
            let b = RoaringBitmap::deserialize_unchecked_from(bytes)
                .map_err(|e| corrupt(&e.to_string()))?;
            let card = dir[1 + i] >> 32;
            if b.len() != card || b.max().is_some_and(|m| m >= rows) {
                return Err(corrupt("bitmap does not match its directory"));
            }
            self.charge(bitmap_size(&b), Some(Unit::Bitmap(c as u32, i as u32)));
            cells[i].set(b);
            Ok(())
        });
        if let Err(e) = res {
            self.fail(e);
        }
    }

    // Records.

    fn record_groups(&self) -> &[Slot<Box<RecGroup>>] {
        if let Some(g) = self.records.get() {
            return g;
        }
        let table = slots(self.meta.dir_blocks());
        self.charge(size_of_val(&*table), None);
        self.records.get_or_init(|| table)
    }

    /// Loads record directory blocks `gs` that are not loaded, adjacent ones in one read.
    fn load_groups(&self, groups: &[Slot<Box<RecGroup>>], gs: &[usize]) -> Result<(), Error> {
        let now = self.now();
        let todo: Vec<usize> = gs
            .iter()
            .copied()
            .filter(|&g| groups[g].get(now).is_none())
            .collect();
        if todo.is_empty() {
            return Ok(());
        }
        let pieces: Vec<(u64, usize)> = todo
            .iter()
            .map(|&g| {
                let (off, len, _) = self.meta.dir_block(g);
                (off, len)
            })
            .collect();
        self.read_many(&pieces, |k, bytes, off| {
            verify_block(bytes, off)?;
            let g = todo[k];
            let (_, _, n) = self.meta.dir_block(g);
            let start = u64::from_le_bytes(bytes[..8].try_into().unwrap());
            let ends: Box<[u32]> = le_words(&bytes[8..8 + n * 4]).into_boxed_slice();
            if ends.first().is_none_or(|&e| e == 0)
                || ends.windows(2).any(|w| w[0] >= w[1])
                || start < crate::format::DATA_START
            {
                return Err(corrupt("record directory"));
            }
            let rg = Box::new(RecGroup {
                start,
                ends,
                blocks: cells(n),
            });
            self.charge(rg.base_size(), Some(Unit::Records(g as u32)));
            groups[g].set(rg);
            Ok(())
        })
    }

    /// Loads record blocks `(group, index)` that are not loaded, adjacent ones in one read. Their
    /// groups must be loaded.
    fn load_records(
        &self,
        groups: &[Slot<Box<RecGroup>>],
        items: &[(usize, usize)],
        gap: u64,
    ) -> Result<(), Error> {
        let todo: Vec<(usize, usize)> = items
            .iter()
            .copied()
            .filter(|&(g, k)| {
                groups[g]
                    .peek()
                    .is_some_and(|rg| rg.blocks[k].get().is_none())
            })
            .collect();
        if todo.is_empty() {
            return Ok(());
        }
        let pieces: Vec<(u64, usize)> = todo
            .iter()
            .map(|&(g, k)| {
                let rg = groups[g].peek().expect("filtered");
                let from = if k == 0 { 0 } else { rg.ends[k - 1] };
                (rg.start + from as u64, (rg.ends[k] - from) as usize)
            })
            .collect();
        let rshift = self.meta.record_shift;
        self.record_loads
            .set(self.record_loads.get() + todo.len() as u64);
        self.read_runs(&pieces, gap, |i, bytes, off| {
            if !bytes.len().is_multiple_of(8) {
                return Err(corrupt("record block length"));
            }
            verify_block(bytes, off)?;
            let (g, k) = todo[i];
            let first = (g * DIR_PER + k) << rshift;
            let n = (self.meta.rows as usize - first).min(1 << rshift);
            let words = le_words(&bytes[..bytes.len() - 8]);
            self.check_records(&words, n)?;
            let words = words.into_boxed_slice();
            self.charge(words_size(&words), None);
            let _ = groups[g].peek().expect("filtered").blocks[k].set(words);
            Ok(())
        })
    }

    /// Checks a record block's offsets and every field against the schema, so reading it later
    /// cannot go out of bounds or split a string.
    fn check_records(&self, words: &[u32], n: usize) -> Result<(), Error> {
        let bad = || corrupt("record block");
        let offsets = words.get(..=n).ok_or_else(bad)?;
        if offsets[0] as usize != n + 1 || offsets[n] as usize > words.len() {
            return Err(bad());
        }
        for i in 0..n {
            let (mut p, end) = (offsets[i] as usize, offsets[i + 1] as usize);
            for (c, def) in self.schema.columns.iter().enumerate() {
                if !in_record(&self.schema, self.meta.flags, c) {
                    continue;
                }
                let len = field_words(def.kind, words, p).ok_or_else(bad)?;
                let field = words.get(p..p + len).ok_or_else(bad)?;
                if def.kind == Kind::Str {
                    let bytes = bytemuck::cast_slice::<u32, u8>(&field[1..]);
                    let s = bytes.get(..field[0] as usize).ok_or_else(bad)?;
                    std::str::from_utf8(s).map_err(|_| corrupt("string is not UTF-8"))?;
                }
                p += len;
            }
            if p != end {
                return Err(bad());
            }
        }
        Ok(())
    }

    /// The record block holding `row` and the row's position in it, if loaded.
    #[inline]
    fn record_block(&self, row: u32) -> Option<(&[u32], usize)> {
        let j = (row >> self.meta.record_shift) as usize;
        let block = self
            .records
            .get()?
            .get(j / DIR_PER)?
            .get(self.now())?
            .blocks
            .get(j % DIR_PER)?
            .get()?;
        Some((block, (row & ((1 << self.meta.record_shift) - 1)) as usize))
    }

    /// Loads the record blocks of `rows`, two batched passes: directory blocks, then records.
    fn load_rows(&self, rows: &[u32]) {
        let groups = self.record_groups();
        let mut items: Vec<(usize, usize)> = rows
            .iter()
            .filter(|&&r| r < self.meta.rows && self.record_block(r).is_none())
            .map(|&r| {
                let j = (r >> self.meta.record_shift) as usize;
                (j / DIR_PER, j % DIR_PER)
            })
            .collect();
        if items.is_empty() {
            return;
        }
        items.sort_unstable();
        items.dedup();
        let mut gs: Vec<usize> = items.iter().map(|x| x.0).collect();
        gs.dedup();
        let broad = self.record_loads.get() >= EXTENT_AFTER && self.fits_twice();
        let res = self.load_groups(groups, &gs).and_then(|()| {
            if !broad {
                return self.load_records(groups, &items, COALESCE_GAP);
            }
            let whole: Vec<(usize, usize)> = gs
                .iter()
                .flat_map(|&g| {
                    (0..groups[g].peek().map_or(0, |rg| rg.blocks.len())).map(move |k| (g, k))
                })
                .collect();
            self.load_records(groups, &whole, EXTENT_GAP)
        });
        if let Err(e) = res {
            self.fail(e);
        }
    }
}

/// Reads one row's fields from its record block, which `check_records` validated. A column the
/// records leave out (`in_record`) reads as an empty string.
fn record_vals<'a>(
    schema: &Schema,
    flags: u32,
    block: &'a [u32],
    i: usize,
    out: &mut Vec<Val<'a>>,
) {
    let mut p = block[i] as usize;
    for (c, def) in schema.columns.iter().enumerate() {
        if !in_record(schema, flags, c) {
            out.push(Val::Str(""));
            continue;
        }
        match def.kind {
            Kind::U32 => {
                out.push(Val::U32(block[p]));
                p += 1;
            }
            Kind::F64 => {
                let bits = block[p] as u64 | (block[p + 1] as u64) << 32;
                out.push(Val::F64(f64::from_bits(bits)));
                p += 2;
            }
            Kind::U32Multi => {
                let n = block[p] as usize;
                out.push(Val::Multi(&block[p + 1..p + 1 + n]));
                p += 1 + n;
            }
            Kind::Str => {
                let n = block[p] as usize;
                let words = n.div_ceil(4);
                let bytes = &bytemuck::cast_slice::<u32, u8>(&block[p + 1..p + 1 + words])[..n];
                out.push(Val::Str(std::str::from_utf8(bytes).unwrap_or_default()));
                p += 1 + words;
            }
        }
    }
}

/// One blocked (key, row) array of a segment.
struct Pairs<'a> {
    seg: &'a Segment,
    lp: &'a LazyPairs,
    arr: Arr,
}

impl<'a> Pairs<'a> {
    fn len(&self) -> usize {
        self.lp.desc.len as usize
    }

    fn per(&self) -> usize {
        self.lp.desc.per as usize
    }

    /// Keys and row ids of block `i`.
    #[inline]
    fn chunk(&self, i: usize) -> Option<(&'a [u64], &'a [u32])> {
        let tab = match self.lp.blocks.get() {
            Some(t) => t,
            None => self.table(),
        };
        let n = (self.len() - i * self.per()).min(self.per());
        let words: &[u64] = match tab.get(i)?.get(self.seg.now()) {
            Some(w) => w,
            None => self.load(&tab[i], i)?,
        };
        Some((
            &words[..n],
            &bytemuck::cast_slice::<u64, u32>(&words[n..])[..n],
        ))
    }

    #[cold]
    #[inline(never)]
    fn table(&self) -> &'a PairCells {
        let table = slots(self.lp.desc.blocks());
        self.seg.charge(size_of_val(&*table), None);
        self.lp.blocks.get_or_init(|| table)
    }

    #[cold]
    #[inline(never)]
    fn load(&self, cell: &'a Slot<Box<[u64]>>, i: usize) -> Option<&'a [u64]> {
        self.seg
            .get(cell, Unit::Block(self.arr, i as u32), words_size, || {
                let (off, len, n) = self.lp.desc.block(i);
                let mut words = self.seg.read_block::<u64>(off, len)?;
                words.truncate(n + n.div_ceil(2));
                Ok(words.into_boxed_slice())
            })
            .map(|w| &w[..])
    }

    fn fences(&self) -> Option<&'a [u64]> {
        self.seg
            .get(&self.lp.fences, Unit::Fences(self.arr), words_size, || {
                let mut f = self.seg.read_section::<u64>(&self.lp.desc.fences)?;
                f.truncate(self.lp.desc.blocks());
                if f.len() != self.lp.desc.blocks() || f.windows(2).any(|w| w[0] > w[1]) {
                    return Err(corrupt("fences"));
                }
                Ok(f.into_boxed_slice())
            })
            .map(|f| &f[..])
    }

    /// The number of leading entries whose key satisfies `pred`, which must hold for a prefix of
    /// the keys. Reads the fences and one block.
    fn partition_point(&self, pred: impl Fn(u64) -> bool) -> usize {
        let Some(fences) = self.fences() else {
            return 0;
        };
        let j = fences.partition_point(|&f| pred(f));
        if j == 0 {
            return 0;
        }
        match self.chunk(j - 1) {
            Some((keys, _)) => (j - 1) * self.per() + keys.partition_point(|&k| pred(k)),
            None => 0,
        }
    }

    fn bounds(&self, lo: u64, hi: u64) -> (usize, usize) {
        if lo == 0 && hi == u64::MAX {
            return (0, self.len());
        }
        let start = self.partition_point(|k| k < lo);
        let end = self.partition_point(|k| k <= hi);
        (start, end.max(start))
    }

    /// Visits (row, key) of entries `start..end`, from the end when `desc`, until `visit`
    /// returns false.
    fn walk(&self, start: usize, end: usize, desc: bool, mut visit: impl FnMut(u32, u64) -> bool) {
        let end = end.min(self.len());
        if start >= end {
            return;
        }
        let per = self.per();
        let (first, last) = (start / per, (end - 1) / per);
        let mut step = |i: usize| -> bool {
            let Some((keys, rows)) = self.chunk(i) else {
                return false;
            };
            let base = i * per;
            let range = start.max(base) - base..end.min(base + rows.len()) - base;
            let (rows, keys) = (&rows[range.clone()], &keys[range]);
            if desc {
                rows.iter().zip(keys).rev().all(|(&r, &k)| visit(r, k))
            } else {
                rows.iter().zip(keys).all(|(&r, &k)| visit(r, k))
            }
        };
        if desc {
            for i in (first..=last).rev() {
                if !step(i) {
                    return;
                }
            }
        } else {
            for i in first..=last {
                if !step(i) {
                    return;
                }
            }
        }
    }

    fn get(&self, key: u64) -> Option<u32> {
        let j = self.fences()?.partition_point(|&f| f <= key);
        if j == 0 {
            return None;
        }
        let (keys, rows) = self.chunk(j - 1)?;
        let at = keys.binary_search(&key).ok()?;
        rows.get(at).copied()
    }
}

impl Part for Segment {
    fn schema(&self) -> &Schema {
        &self.schema
    }

    fn pk_col(&self) -> usize {
        self.pk_col
    }

    fn len(&self) -> u32 {
        self.meta.rows
    }

    #[inline]
    fn u32_at(&self, c: usize, row: u32) -> u32 {
        if let Some(col) = self.cols[c].get()
            && let ColCells::U32(cells) = &col.cells
            && let Some(v) = cells
                .get((row >> self.shift) as usize)
                .and_then(|s| s.get(self.now()))
            && let Some(&x) = v.get((row & self.mask) as usize)
        {
            return x;
        }
        self.u32_cold(c, row)
    }

    #[inline]
    fn f64_at(&self, c: usize, row: u32) -> f64 {
        if let Some(col) = self.cols[c].get()
            && let ColCells::F64(cells) = &col.cells
            && let Some(v) = cells
                .get((row >> self.shift) as usize)
                .and_then(|s| s.get(self.now()))
            && let Some(&x) = v.get((row & self.mask) as usize)
        {
            return x;
        }
        self.f64_cold(c, row)
    }

    #[inline]
    fn multi_at(&self, c: usize, row: u32) -> &[u32] {
        if let Some(col) = self.cols[c].get()
            && let ColCells::Multi(cells) = &col.cells
            && let Some(ch) = cells
                .get((row >> self.shift) as usize)
                .and_then(|s| s.get(self.now()))
            && let Some(v) = ch.values((row & self.mask) as usize)
        {
            return v;
        }
        self.multi_cold(c, row)
    }

    fn str_at(&self, c: usize, row: u32) -> &str {
        let mut vals = Vec::with_capacity(self.schema.columns.len());
        self.gather(row, &mut vals);
        match vals.get(c) {
            Some(Val::Str(s)) => s,
            _ => "",
        }
    }

    fn bitmap_estimate(&self, c: usize, test: &Test) -> u64 {
        let Some((dir, n, _)) = self.bitmap_dir(c) else {
            return 0;
        };
        Self::bitmap_positions(dir, n, test)
            .into_iter()
            .map(|i| dir[1 + i] >> 32)
            .sum()
    }

    fn bitmap_count(&self, c: usize, test: &Test) -> usize {
        self.bitmap_dir(c)
            .map_or(0, |(dir, n, _)| Self::bitmap_positions(dir, n, test).len())
    }

    fn bitmaps(&self, c: usize, test: &Test) -> Vec<&RoaringBitmap> {
        let Some((dir, n, cells)) = self.bitmap_dir(c) else {
            return Vec::new();
        };
        let positions = Self::bitmap_positions(dir, n, test);
        self.load_bitmaps(c, dir, n, cells, &positions);
        positions.iter().filter_map(|&i| cells[i].peek()).collect()
    }

    fn bitmap(&self, c: usize, test: &Test) -> Cow<'_, RoaringBitmap> {
        let bitmaps = self.bitmaps(c, test);
        if let [b] = bitmaps[..] {
            return Cow::Borrowed(b);
        }
        let mut acc = RoaringBitmap::new();
        for b in bitmaps {
            acc |= b;
        }
        Cow::Owned(acc)
    }

    fn ordered_bounds(&self, c: usize, lo: u64, hi: u64) -> (usize, usize) {
        self.ordered(c).map_or((0, 0), |p| p.bounds(lo, hi))
    }

    fn ordered_len(&self, c: usize) -> usize {
        self.ordered(c).map_or(0, |p| p.len())
    }

    fn ordered_walk(
        &self,
        c: usize,
        start: usize,
        end: usize,
        desc: bool,
        visit: impl FnMut(u32, u64) -> bool,
    ) {
        if let Some(p) = self.ordered(c) {
            p.walk(start, end, desc, visit);
        }
    }

    fn ordered_rows(&self, c: usize, start: usize, end: usize, out: &mut Vec<u32>) {
        self.ordered_walk(c, start, end, false, |r, _| {
            out.push(r);
            true
        });
    }

    fn has_groups(&self, c: usize) -> bool {
        self.schema.columns[c].group.is_some()
    }

    fn group_len(&self, c: usize, g: u32) -> usize {
        self.group(c, g).map_or(0, |p| p.len())
    }

    fn group_bounds(&self, c: usize, g: u32, lo: u64, hi: u64) -> (usize, usize) {
        self.group(c, g).map_or((0, 0), |p| p.bounds(lo, hi))
    }

    fn group_walk(
        &self,
        c: usize,
        g: u32,
        start: usize,
        end: usize,
        desc: bool,
        visit: impl FnMut(u32, u64) -> bool,
    ) {
        if let Some(p) = self.group(c, g) {
            p.walk(start, end, desc, visit);
        }
    }

    fn rows_in_pk_order(&self) -> bool {
        self.meta.flags & FLAG_ROWS_IN_PK_ORDER != 0
    }

    fn pk_get(&self, key: u64) -> Option<u32> {
        self.pk_pairs().get(key)
    }

    fn pk_walk(&self, lo: u64, hi: u64, desc: bool, mut visit: impl FnMut(u64, u32) -> bool) {
        let pk = self.pk_pairs();
        let (start, end) = pk.bounds(lo, hi);
        pk.walk(start, end, desc, |r, k| visit(k, r));
    }

    fn keys_walk(
        &self,
        c: usize,
        lo: &[u8],
        hi: Option<&[u8]>,
        desc: bool,
        mut visit: impl FnMut(&[u8], u32) -> bool,
    ) {
        let Some(d) = self.keys_dir(c) else { return };
        let start = self.keys_lower(c, d, lo);
        let end = hi
            .map_or(d.total(), |h| self.keys_lower(c, d, h))
            .max(start);
        let mut i = if desc { end } else { start };
        loop {
            if desc {
                if i == start {
                    return;
                }
                i -= 1;
            } else if i == end {
                return;
            }
            let b = d.block_of(i);
            let Some(blk) = self.key_block(c, d, b) else {
                return;
            };
            let local = i - d.first(b);
            if local >= blk.len() {
                return;
            }
            let (k, r) = blk.entry(local);
            if !visit(k, r) {
                return;
            }
            if !desc {
                i += 1;
            }
        }
    }

    fn keys_count(&self, c: usize, lo: &[u8], hi: Option<&[u8]>) -> u64 {
        let Some(d) = self.keys_dir(c) else { return 0 };
        let start = self.keys_lower(c, d, lo);
        let end = hi.map_or(d.total(), |h| self.keys_lower(c, d, h));
        end.saturating_sub(start) as u64
    }

    fn pk_range(&self, lo: u64, hi: u64, out: &mut Vec<u32>) {
        let pk = self.pk_pairs();
        let (start, end) = pk.bounds(lo, hi);
        pk.walk(start, end, false, |r, _| {
            out.push(r);
            true
        });
    }

    fn pk_scan(&self, mut visit: impl FnMut(u32) -> bool) {
        if self.rows_in_pk_order() {
            for r in 0..self.meta.rows {
                if !visit(r) {
                    return;
                }
            }
            return;
        }
        self.pk_pairs()
            .walk(0, self.meta.rows as usize, false, |r, _| visit(r));
    }

    fn prefetch(&self, rows: &[u32]) {
        self.load_rows(rows);
    }

    fn gather<'a>(&'a self, row: u32, out: &mut Vec<Val<'a>>) {
        if self.record_block(row).is_none() {
            self.load_rows(&[row]);
        }
        match self.record_block(row) {
            Some((block, i)) => record_vals(&self.schema, self.meta.flags, block, i, out),
            None => {
                // A failed load, recorded in `failed`: fill the row so the caller's shape holds.
                for def in &self.schema.columns {
                    out.push(match def.kind {
                        Kind::U32 => Val::U32(0),
                        Kind::F64 => Val::F64(0.0),
                        Kind::Str => Val::Str(""),
                        Kind::U32Multi => Val::Multi(&[]),
                    });
                }
            }
        }
    }

    fn failure(&self) -> Option<Error> {
        self.failed.borrow_mut().take()
    }

    fn bitmap_values(&self, c: usize) -> Vec<u32> {
        self.bitmap_dir(c).map_or_else(Vec::new, |(dir, n, _)| {
            dir[1..1 + n].iter().map(|&w| w as u32).collect()
        })
    }
}

impl Drop for Segment {
    fn drop(&mut self) {
        cache::release(self.held.get());
    }
}
