//! File format v6: two header slots, immutable segments, per-segment delete bitmaps, and a small
//! manifest. Little-endian.
//!
//! ```text
//! [0, 4096)      header slot 0
//! [4096, 8192)   header slot 1
//! [8192, ..)     segments, delete bitmaps and manifests, placed in space no committed state uses
//!
//! slot      "PLT6" | version u32 | seq u64 | manifest offset u64 | manifest len u64
//!           | manifest checksum u64 | slot checksum u64 (of the 40 bytes before it)
//! manifest  "PLM6" | schema_len u32 | schema JSON | segments u32 | segment*
//!           (the schema JSON may carry a `meta` string: the owner's own state, committed with
//!           the rows, such as a key generator)
//! segment   rows u32 | chunk_shift u32 | pair_block u32 | record_shift u32 | flags u32
//!           | extents u32 | (start u64 | end u64)* | deleted u32
//!           | delete bitmap section (zero if none) | pk array | record directory offset u64
//!           | per column: column directory section | index directory section (zero if none)
//! array     base u64 | len u32 | per u32 | fences section
//! section   offset u64 | len u32 | xxh3 checksum u64
//! ```
//!
//! The manifest holds no per-chunk entries, so opening reads and decodes a few hundred bytes per
//! segment. Everything else is reached through a directory loaded on first touch and used in
//! place:
//!
//! - column directory: one section ref (offset u64, len u64, checksum u64) per chunk of
//!   `2^chunk_shift` rows. Chunk contents, each padded to 8 bytes: `u32` and `f64` the values;
//!   `u32_multi` and `str` `rows + 1` u32 offsets relative to the chunk, then the u32 values or
//!   the UTF-8 bytes.
//! - bitmap directory: `n` u64 | `n` (value u32 | cardinality u32), ascending by value | `n`
//!   section refs. Each section is a serialized roaring bitmap of row ids.
//! - ordered directory: array | groups u64 | per group: value u64 | array, ascending by value.
//!   Groups exist only for an ordered column with a group column.
//!
//! An array (the primary key, an ordered index, one group of it) is a run of fixed-size blocks of
//! `per` entries from `base` on, so block `j` sits at `base + j * pair_block_size(per)`: `n` u64
//! keys, `n` u32 row ids, padding to 8, then an xxh3 checksum seeded with the block's file offset.
//! Its fences section holds the first key of every block. The primary key holds (key, row) sorted
//! by key; an ordered index (key, row) sorted by (key, primary key); a group the same restricted
//! to one group value.
//!
//! Records: rows stored whole, `2^record_shift` rows per record block, so gathering a result row
//! reads one small block instead of a chunk per column. A record block is u32 words: `n + 1` word
//! offsets of the rows from the block start, the rows, padding to 8 bytes, then an xxh3 checksum
//! seeded with the block's offset. A row is, per column: `u32` one word; `f64` two words (low
//! first); `u32_multi` a count then the values; `str` a byte length then the bytes, padded to a
//! word. Record blocks are found through the record directory: fixed-size blocks of `DIR_PER`
//! entries from the directory offset on, each the file offset of the group's first record block
//! u64, the end of each record block relative to it u32, padding, then a seeded checksum.
//!
//! A segment's bytes lie in its extents, apart from each other. Offsets inside a segment are
//! logical (flag `FLAG_LOGICAL`): its bytes are one run from `DATA_START` on, laid over its extents
//! in the order the manifest lists them, so a segment is written into the free space the
//! committed state leaves (gaps first, then the end of the file) and its extents can move later
//! without rewriting it. Segments of files written before the flag use file offsets. The free space is what
//! the committed extents (segments, delete bitmaps, the manifest) leave between the header and
//! the end of the file; it follows from them, so the manifest does not list it again. Its delete
//! bitmap, a serialized roaring bitmap of the row ids deleted or replaced since it was written, is
//! a separate section rewritten whole when it changes; `deleted` is its cardinality, so counting
//! rows reads nothing.
//!
//! Every byte a query reads is covered by a checksum: sections by the checksum in their reference,
//! blocks by their own. Saving writes the new segment, the changed delete bitmaps and the manifest
//! into space the committed state does not use (a gap left by an earlier state, or the end of the
//! file), flushes, then writes the slot that does not hold the newest state with the next sequence
//! number, and flushes. Space the committed state stops using is reused only after that slot is
//! written; then the file is cut after the last byte the new state uses. Opening takes the valid
//! slot with the highest sequence whose manifest checksum matches, so a save or compaction torn
//! anywhere before the last flush leaves the previous state.

use crate::Error;
use crate::schema::{Kind, Schema};
use crate::storage::Storage;

pub(crate) const SLOT_SIZE: u64 = 4096;
pub(crate) const DATA_START: u64 = 2 * SLOT_SIZE;
const SLOT_MAGIC: &[u8; 4] = b"PLT6";
const MANIFEST_MAGIC: &[u8; 4] = b"PLM6";
const VERSION: u32 = 6;

/// Version 5, still read: the same but for a segment's bytes, one `start u64 | end u64` extent.
/// A save to a v5 file writes v6 from then on.
const SLOT_MAGIC_V5: &[u8; 4] = b"PLT5";
const MANIFEST_MAGIC_V5: &[u8; 4] = b"PLM5";

/// Record blocks per record directory block.
pub(crate) const DIR_PER: usize = 32;

/// Segment flag: row ids follow primary key order, so primary key order needs no key reads.
pub(crate) const FLAG_ROWS_IN_PK_ORDER: u32 = 1;

/// Segment flag: each value is stored once. `str` columns have no column chunks (they are read
/// through records only), keys-indexed columns are left out of records (their values live in
/// their keys index, and rows are never returned with them), and keys blocks are prefix-coded
/// (`keys::encode_lean_block`).
pub(crate) const FLAG_LEAN: u32 = 4;

/// Segment flag: offsets inside the segment are logical, from `DATA_START` on through its extents
/// in the order listed (`write::Writer`). Without it (files before it existed) they are file
/// offsets and the extents ascend.
pub(crate) const FLAG_LOGICAL: u32 = 8;

/// Whether column `c` of a segment with `flags` is stored in its records.
pub(crate) fn in_record(schema: &Schema, flags: u32, c: usize) -> bool {
    flags & FLAG_LEAN == 0 || schema.columns[c].index != crate::schema::IndexKind::Keys
}

/// How new segments are laid out. Each segment records its own, so a reader follows the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    /// Rows per column chunk, as a power of two. Column chunks serve filters and sorts that read
    /// a column for many rows.
    pub chunk_shift: u32,
    /// Entries per primary key, ordered index or group block.
    pub pair_block: u32,
    /// Rows per record block, as a power of two. Gathering a result row reads one record block.
    pub record_shift: u32,
}

impl Default for Layout {
    fn default() -> Layout {
        Layout {
            chunk_shift: 10,
            pair_block: 256,
            record_shift: 2,
        }
    }
}

const CHUNK_SHIFTS: std::ops::RangeInclusive<u32> = 0..=24;
const RECORD_SHIFTS: std::ops::RangeInclusive<u32> = 0..=12;

impl Layout {
    pub fn validate(&self) -> Result<(), Error> {
        if !CHUNK_SHIFTS.contains(&self.chunk_shift)
            || !RECORD_SHIFTS.contains(&self.record_shift)
            || self.pair_block == 0
            || self.pair_block > 1 << 20
        {
            return Err(Error::new(format!("invalid layout {self:?}")));
        }
        Ok(())
    }
}

pub(crate) fn checksum(bytes: &[u8]) -> u64 {
    xxhash_rust::xxh3::xxh3_64(bytes)
}

/// Checksum of a self-describing block, seeded with its file offset so a block read from the
/// wrong place fails too.
pub(crate) fn block_checksum(bytes: &[u8], off: u64) -> u64 {
    xxhash_rust::xxh3::xxh3_64_with_seed(bytes, off)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SectionRef {
    pub off: u64,
    pub len: u32,
    pub sum: u64,
}

/// Size in bytes of a pairs block of `n` entries, checksum included.
pub(crate) fn pair_block_size(n: usize) -> usize {
    (n * 12).next_multiple_of(8) + 8
}

/// Size in bytes of a record directory block of `n` entries, checksum included.
pub(crate) fn dir_block_size(n: usize) -> usize {
    8 + (n * 4).next_multiple_of(8) + 8
}

/// One blocked (key, row) array on disk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ArrayDesc {
    pub base: u64,
    pub len: u32,
    pub per: u32,
    pub fences: SectionRef,
}

impl ArrayDesc {
    pub fn blocks(&self) -> usize {
        self.len.div_ceil(self.per.max(1)) as usize
    }

    /// File offset, byte length and entry count of block `j`.
    pub fn block(&self, j: usize) -> (u64, usize, usize) {
        let per = self.per as usize;
        let n = (self.len as usize - j * per).min(per);
        let off = self.base + (j * pair_block_size(per)) as u64;
        (off, pair_block_size(n), n)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SegmentMeta {
    pub rows: u32,
    pub chunk_shift: u32,
    pub pair_block: u32,
    pub record_shift: u32,
    pub flags: u32,
    /// The segment's bytes: `[start, end)` extents, ascending and apart. Its delete bitmap lives
    /// apart.
    pub extents: Vec<(u64, u64)>,
    /// Rows deleted or replaced: the delete bitmap's cardinality.
    pub deleted: u32,
    /// Serialized roaring bitmap of deleted row ids; zero when none are.
    pub dead: SectionRef,
    pub pk: ArrayDesc,
    pub record_dir: u64,
    pub column_dirs: Vec<SectionRef>,
    pub index_dirs: Vec<SectionRef>,
}

impl SegmentMeta {
    pub fn chunks(&self) -> usize {
        self.rows.div_ceil(1 << self.chunk_shift) as usize
    }

    pub fn record_blocks(&self) -> usize {
        self.rows.div_ceil(1 << self.record_shift) as usize
    }

    pub fn dir_blocks(&self) -> usize {
        self.record_blocks().div_ceil(DIR_PER)
    }

    /// File offset, byte length and entry count of record directory block `g`.
    pub fn dir_block(&self, g: usize) -> (u64, usize, usize) {
        let n = (self.record_blocks() - g * DIR_PER).min(DIR_PER);
        let off = self.record_dir + (g * dir_block_size(DIR_PER)) as u64;
        (off, dir_block_size(n), n)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    pub seq: u64,
    pub manifest_off: u64,
    pub manifest_len: u64,
    pub manifest_sum: u64,
}

pub(crate) fn encode_slot(slot: &Slot) -> Vec<u8> {
    let mut out = Vec::with_capacity(SLOT_SIZE as usize);
    out.extend_from_slice(SLOT_MAGIC);
    put_u32(&mut out, VERSION);
    put_u64(&mut out, slot.seq);
    put_u64(&mut out, slot.manifest_off);
    put_u64(&mut out, slot.manifest_len);
    put_u64(&mut out, slot.manifest_sum);
    let sum = checksum(&out);
    put_u64(&mut out, sum);
    out.resize(SLOT_SIZE as usize, 0);
    out
}

/// `None` for a slot that was never written or was torn.
pub(crate) fn decode_slot(bytes: &[u8]) -> Option<Slot> {
    let mut r = Reader::new(bytes);
    let magic = r.take(4).ok()?;
    let version = r.u32().ok()?;
    if !(magic == SLOT_MAGIC && version == VERSION || magic == SLOT_MAGIC_V5 && version == 5) {
        return None;
    }
    let slot = Slot {
        seq: r.u64().ok()?,
        manifest_off: r.u64().ok()?,
        manifest_len: r.u64().ok()?,
        manifest_sum: r.u64().ok()?,
    };
    let body = r.pos;
    (r.u64().ok()? == checksum(&bytes[..body])).then_some(slot)
}

pub(crate) fn encode_manifest(schema: &Schema, meta: &str, segments: &[&SegmentMeta]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(MANIFEST_MAGIC);
    let json = if meta.is_empty() {
        serde_json::to_vec(schema).expect("schema serializes")
    } else {
        let mut v = serde_json::to_value(schema).expect("schema serializes");
        v["meta"] = serde_json::Value::String(meta.to_string());
        serde_json::to_vec(&v).expect("schema serializes")
    };
    put_u32(&mut out, json.len() as u32);
    out.extend_from_slice(&json);
    put_u32(&mut out, segments.len() as u32);
    for s in segments {
        put_u32(&mut out, s.rows);
        put_u32(&mut out, s.chunk_shift);
        put_u32(&mut out, s.pair_block);
        put_u32(&mut out, s.record_shift);
        put_u32(&mut out, s.flags);
        put_u32(&mut out, s.extents.len() as u32);
        for &(a, b) in &s.extents {
            put_u64(&mut out, a);
            put_u64(&mut out, b);
        }
        put_u32(&mut out, s.deleted);
        put_ref(&mut out, &s.dead);
        put_array(&mut out, &s.pk);
        put_u64(&mut out, s.record_dir);
        for (col, index) in s.column_dirs.iter().zip(&s.index_dirs) {
            put_ref(&mut out, col);
            put_ref(&mut out, index);
        }
    }
    out
}

/// A decoded manifest: the schema, the owner's meta string and the segments.
pub(crate) type Manifest = (Schema, String, Vec<SegmentMeta>);

pub(crate) fn decode_manifest(bytes: &[u8]) -> Result<Manifest, Error> {
    let mut r = Reader::new(bytes);
    let v5 = match r.take(4)? {
        m if m == MANIFEST_MAGIC => false,
        m if m == MANIFEST_MAGIC_V5 => true,
        _ => return Err(corrupt("manifest magic")),
    };
    let schema_len = r.u32()? as usize;
    let json = r.take(schema_len)?;
    // Most manifests carry no meta: parse those straight into the schema, as before meta existed.
    let (schema, meta): (Schema, String) = if json.windows(6).any(|w| w == b"\"meta\"") {
        let mut v: serde_json::Value = serde_json::from_slice(json)?;
        let meta = match v.get_mut("meta").map(serde_json::Value::take) {
            Some(serde_json::Value::String(m)) => m,
            Some(_) => return Err(corrupt("manifest meta")),
            None => String::new(),
        };
        if let Some(o) = v.as_object_mut() {
            o.remove("meta");
        }
        (serde_json::from_value(v)?, meta)
    } else {
        (serde_json::from_slice(json)?, String::new())
    };
    schema.validate()?;
    let n = r.u32()?;
    let mut segments = Vec::new();
    for _ in 0..n {
        let rows = r.u32()?;
        let chunk_shift = r.u32()?;
        let pair_block = r.u32()?;
        let record_shift = r.u32()?;
        let flags = r.u32()?;
        let count = if v5 { 1 } else { r.u32()? as usize };
        let mut extents = Vec::with_capacity(count.min(1 << 16));
        for _ in 0..count {
            extents.push((r.u64()?, r.u64()?));
        }
        // Apart and past the header slots; ascending too unless listed in logical order.
        let mut sorted = extents.clone();
        if flags & FLAG_LOGICAL != 0 {
            sorted.sort_unstable();
        }
        let mut prev = DATA_START;
        for &(a, b) in &sorted {
            if a < prev || b < a {
                return Err(corrupt("segment extents"));
            }
            prev = b;
        }
        let deleted = r.u32()?;
        let dead = r.section()?;
        if deleted > rows || (deleted == 0) != (dead.len == 0) {
            return Err(corrupt("segment delete bitmap"));
        }
        let layout = Layout {
            chunk_shift,
            pair_block,
            record_shift,
        };
        if layout.validate().is_err() {
            return Err(corrupt("layout"));
        }
        let pk = r.array()?;
        if pk.len != rows || pk.per != pair_block {
            return Err(corrupt("primary key length"));
        }
        let record_dir = r.u64()?;
        let mut column_dirs = Vec::with_capacity(schema.columns.len());
        let mut index_dirs = Vec::with_capacity(schema.columns.len());
        for _ in &schema.columns {
            column_dirs.push(r.section()?);
            index_dirs.push(r.section()?);
        }
        segments.push(SegmentMeta {
            rows,
            chunk_shift,
            pair_block,
            record_shift,
            flags,
            extents,
            deleted,
            dead,
            pk,
            record_dir,
            column_dirs,
            index_dirs,
        });
    }
    if r.pos != bytes.len() {
        return Err(corrupt("manifest has trailing bytes"));
    }
    Ok((schema, meta, segments))
}

pub(crate) fn corrupt(what: &str) -> Error {
    Error::new(format!("file is corrupt: {what}"))
}

pub(crate) fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_ref(out: &mut Vec<u8>, r: &SectionRef) {
    put_u64(out, r.off);
    put_u32(out, r.len);
    put_u64(out, r.sum);
}

/// Words a section ref takes inside a directory: offset, length, checksum.
pub(crate) const REF_WORDS: usize = 3;

pub(crate) fn put_ref_words(out: &mut Vec<u8>, r: &SectionRef) {
    put_u64(out, r.off);
    put_u64(out, r.len as u64);
    put_u64(out, r.sum);
}

pub(crate) fn ref_from_words(w: &[u64]) -> Result<SectionRef, Error> {
    let len = u32::try_from(w[1]).map_err(|_| corrupt("section length"))?;
    Ok(SectionRef {
        off: w[0],
        len,
        sum: w[2],
    })
}

fn put_array(out: &mut Vec<u8>, a: &ArrayDesc) {
    put_u64(out, a.base);
    put_u32(out, a.len);
    put_u32(out, a.per);
    put_ref(out, &a.fences);
}

/// Words an array takes inside a directory: base, `len | per << 32`, then the fences ref.
pub(crate) const ARRAY_WORDS: usize = 2 + REF_WORDS;

pub(crate) fn put_array_words(out: &mut Vec<u8>, a: &ArrayDesc) {
    put_u64(out, a.base);
    put_u64(out, a.len as u64 | (a.per as u64) << 32);
    put_ref_words(out, &a.fences);
}

pub(crate) fn array_from_words(w: &[u64]) -> Result<ArrayDesc, Error> {
    let a = ArrayDesc {
        base: w[0],
        len: w[1] as u32,
        per: (w[1] >> 32) as u32,
        fences: ref_from_words(&w[2..2 + REF_WORDS])?,
    };
    check_array(&a)?;
    Ok(a)
}

fn check_array(a: &ArrayDesc) -> Result<(), Error> {
    if a.per == 0 || a.fences.len as usize != (a.blocks() * 8).next_multiple_of(8) {
        return Err(corrupt("array directory"));
    }
    Ok(())
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len());
        let end = end.ok_or_else(|| corrupt("manifest is truncated"))?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn section(&mut self) -> Result<SectionRef, Error> {
        Ok(SectionRef {
            off: self.u64()?,
            len: self.u32()?,
            sum: self.u64()?,
        })
    }

    fn array(&mut self) -> Result<ArrayDesc, Error> {
        let a = ArrayDesc {
            base: self.u64()?,
            len: self.u32()?,
            per: self.u32()?,
            fences: self.section()?,
        };
        check_array(&a)?;
        Ok(a)
    }
}

/// Words a record field takes, read from its first word; `None` if that word is missing.
#[inline]
pub(crate) fn field_words(kind: Kind, words: &[u32], at: usize) -> Option<usize> {
    match kind {
        Kind::U32 => Some(1),
        Kind::F64 => Some(2),
        Kind::U32Multi => Some(1 + *words.get(at)? as usize),
        Kind::Str => Some(1 + (*words.get(at)? as usize).div_ceil(4)),
    }
}

/// A delete bitmap as section bytes: the serialized roaring bitmap, padded to 8.
pub(crate) fn encode_dead(dead: &roaring::RoaringBitmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(dead.serialized_size() + 8);
    dead.serialize_into(&mut out)
        .expect("writing to a Vec does not fail");
    out.resize(out.len().next_multiple_of(8), 0);
    out
}

/// Reads and checks a segment's delete bitmap.
pub(crate) fn read_dead(
    storage: &dyn Storage,
    meta: &SegmentMeta,
) -> Result<roaring::RoaringBitmap, Error> {
    if meta.dead.len == 0 {
        return Ok(roaring::RoaringBitmap::new());
    }
    let mut bytes = vec![0u8; meta.dead.len as usize];
    storage.read_at(meta.dead.off, &mut bytes)?;
    if checksum(&bytes) != meta.dead.sum {
        return Err(Error::new(format!(
            "checksum mismatch in the delete bitmap at offset {}",
            meta.dead.off
        )));
    }
    // The checksum above covers the bytes, as for index bitmaps.
    let dead = roaring::RoaringBitmap::deserialize_unchecked_from(&bytes[..])
        .map_err(|_| corrupt("delete bitmap"))?;
    if dead.len() != meta.deleted as u64 || dead.max().is_some_and(|m| m >= meta.rows) {
        return Err(corrupt("delete bitmap"));
    }
    Ok(dead)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Batch, ColumnData, Db, MemStorage};
    use std::rc::Rc;

    /// The v5 manifest of `segments`: as v6 but for one `start | end` extent per segment.
    fn encode_manifest_v5(schema: &Schema, segments: &[SegmentMeta]) -> Vec<u8> {
        let v6 = encode_manifest(schema, "", &segments.iter().collect::<Vec<_>>());
        let mut out = MANIFEST_MAGIC_V5.to_vec();
        let mut r = Reader::new(&v6);
        r.take(4).unwrap();
        let schema_len = r.u32().unwrap() as usize;
        put_u32(&mut out, schema_len as u32);
        out.extend_from_slice(r.take(schema_len).unwrap());
        let n = r.u32().unwrap();
        put_u32(&mut out, n);
        for s in segments {
            for _ in 0..5 {
                put_u32(&mut out, r.u32().unwrap());
            }
            let count = r.u32().unwrap() as usize;
            assert_eq!(count, 1, "a v5 segment has one extent");
            let (a, b) = (r.u64().unwrap(), r.u64().unwrap());
            assert_eq!(s.extents, vec![(a, b)]);
            put_u64(&mut out, a);
            put_u64(&mut out, b);
            // deleted, delete bitmap section, pk array, record directory, per column two sections.
            let rest = 4 + 20 + 36 + 8 + schema.columns.len() * 40;
            out.extend_from_slice(r.take(rest).unwrap());
        }
        assert_eq!(r.pos, v6.len());
        out
    }

    #[test]
    fn a_version_5_file_opens_answers_and_takes_a_version_6_save() {
        let schema = Schema::from_json(
            r#"{"primaryKey":"id","columns":[{"name":"id","kind":"f64"},
                {"name":"team","kind":"u32","index":"bitmap"},{"name":"t","kind":"str"}]}"#,
        )
        .unwrap();
        let batch = |ids: std::ops::Range<u32>| {
            let n = ids.len();
            let mut b = Batch::new(&schema, n);
            b.set(
                &schema,
                "id",
                ColumnData::F64(ids.clone().map(f64::from).collect()),
            )
            .unwrap();
            b.set(
                &schema,
                "team",
                ColumnData::U32(ids.clone().map(|i| i % 3).collect()),
            )
            .unwrap();
            let mut offsets = vec![0u32];
            let mut bytes = Vec::new();
            for i in ids {
                bytes.extend_from_slice(format!("row {i}").as_bytes());
                offsets.push(bytes.len() as u32);
            }
            b.set(&schema, "t", ColumnData::Str { offsets, bytes })
                .unwrap();
            b
        };
        let storage = Rc::new(MemStorage::new());
        let mut db = Db::create(storage.clone(), schema.clone()).unwrap();
        db.append(batch(0..500)).unwrap();
        db.save().unwrap();
        // Rewrite the committed state as v5: its manifest in place, then its slot.
        let mut bytes = storage.to_bytes();
        let slot = decode_slot(&bytes[SLOT_SIZE as usize..2 * SLOT_SIZE as usize]).unwrap();
        let at = slot.manifest_off as usize;
        let (_, _, metas) = decode_manifest(&bytes[at..at + slot.manifest_len as usize]).unwrap();
        let v5 = encode_manifest_v5(&schema, &metas);
        bytes[at..at + v5.len()].copy_from_slice(&v5);
        let mut s = SLOT_MAGIC_V5.to_vec();
        put_u32(&mut s, 5);
        put_u64(&mut s, slot.seq);
        put_u64(&mut s, slot.manifest_off);
        put_u64(&mut s, v5.len() as u64);
        put_u64(&mut s, checksum(&v5));
        let sum = checksum(&s);
        put_u64(&mut s, sum);
        bytes[SLOT_SIZE as usize..SLOT_SIZE as usize + s.len()].copy_from_slice(&s);
        assert_eq!(&bytes[SLOT_SIZE as usize..SLOT_SIZE as usize + 4], b"PLT5");

        let storage = Rc::new(MemStorage::from_bytes(bytes));
        let mut db = Db::open(storage.clone()).unwrap();
        assert_eq!(db.len(), 500);
        let q = r#"{"where":[{"field":"team","op":"eq","value":1}],"count":true}"#;
        assert!(db.query_json(q).unwrap().contains("\"count\":167"));
        assert!(db.get_many_json(&[42.0]).unwrap().contains("row 42"));
        db.put(batch(400..600)).unwrap();
        db.save().unwrap();
        let mut db = Db::open(storage).unwrap();
        assert_eq!(db.len(), 600);
        assert!(
            db.get_many_json(&[42.0, 599.0])
                .unwrap()
                .contains("row 599")
        );
        db.compact().unwrap();
        assert_eq!(db.len(), 600);
    }
}
