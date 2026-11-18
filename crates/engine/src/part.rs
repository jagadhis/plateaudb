//! What the planner needs from a piece of the database: the in-memory delta (`Table`) or a lazy
//! segment. Row ids are local to the part.
//!
//! Lazy parts load sections on first touch. The per-row accessors cannot return a `Result`
//! without slowing the hot loops, so a failed load records its error in the part (`failure`),
//! returns an empty value, and the caller checks `failure` before using the answer.

use crate::Error;
use crate::json;
use crate::key::f64_key;
use crate::query::Test;
use crate::schema::{Kind, Schema};
use crate::table::{Index, Table};
use roaring::RoaringBitmap;
use std::borrow::Cow;

pub(crate) trait Part {
    fn schema(&self) -> &Schema;
    fn pk_col(&self) -> usize;
    fn len(&self) -> u32;

    fn u32_at(&self, c: usize, row: u32) -> u32;
    fn f64_at(&self, c: usize, row: u32) -> f64;
    fn multi_at(&self, c: usize, row: u32) -> &[u32];
    fn str_at(&self, c: usize, row: u32) -> &str;

    /// Exact number of row ids a bitmap-index filter yields, without building the union.
    fn bitmap_estimate(&self, c: usize, test: &Test) -> u64;
    /// Number of bitmaps (index values) a bitmap-index filter selects.
    fn bitmap_count(&self, c: usize, test: &Test) -> usize;
    /// The bitmaps a bitmap-index filter selects, for membership tests.
    fn bitmaps(&self, c: usize, test: &Test) -> Vec<&RoaringBitmap>;
    fn bitmap(&self, c: usize, test: &Test) -> Cow<'_, RoaringBitmap>;

    /// `[start, end)` of the ordered index entries whose key lies in `lo..=hi`.
    fn ordered_bounds(&self, c: usize, lo: u64, hi: u64) -> (usize, usize);
    fn ordered_len(&self, c: usize) -> usize;
    /// Visits (row id, key) of entries `start..end`, from the end when `desc`, until `visit`
    /// returns false.
    fn ordered_walk(
        &self,
        c: usize,
        start: usize,
        end: usize,
        desc: bool,
        visit: impl FnMut(u32, u64) -> bool,
    );
    fn ordered_rows(&self, c: usize, start: usize, end: usize, out: &mut Vec<u32>);
    /// Whether the ordered index on `c` keeps per-group lists that are current.
    fn has_groups(&self, c: usize) -> bool;
    /// Entries in group `g` of the ordered index on `c`.
    fn group_len(&self, c: usize, g: u32) -> usize;
    /// `[start, end)` of group `g`'s entries whose key lies in `lo..=hi`.
    fn group_bounds(&self, c: usize, g: u32, lo: u64, hi: u64) -> (usize, usize);
    /// `ordered_walk` inside group `g`.
    fn group_walk(
        &self,
        c: usize,
        g: u32,
        start: usize,
        end: usize,
        desc: bool,
        visit: impl FnMut(u32, u64) -> bool,
    );
    /// Entries of group `g` whose key lies in `lo..=hi`.
    fn group_count(&self, c: usize, g: u32, lo: u64, hi: u64) -> u64 {
        let (start, end) = self.group_bounds(c, g, lo, hi);
        (end - start) as u64
    }
    /// Whether row ids follow primary key order.
    fn rows_in_pk_order(&self) -> bool {
        false
    }

    fn pk_get(&self, key: u64) -> Option<u32>;
    /// Visits (key, row) of the primary key in `lo..=hi`, from the end when `desc`, until `visit`
    /// returns false.
    fn pk_walk(&self, lo: u64, hi: u64, desc: bool, visit: impl FnMut(u64, u32) -> bool);
    /// Visits (key, row) of the keys index on `c` with `lo <= key < hi` (no upper bound when
    /// `hi` is `None`), from the end when `desc`, until `visit` returns false. Deleted rows
    /// included.
    fn keys_walk(
        &self,
        c: usize,
        lo: &[u8],
        hi: Option<&[u8]>,
        desc: bool,
        visit: impl FnMut(&[u8], u32) -> bool,
    );
    /// Entries `keys_walk` would visit.
    fn keys_count(&self, c: usize, lo: &[u8], hi: Option<&[u8]>) -> u64;
    fn pk_range(&self, lo: u64, hi: u64, out: &mut Vec<u32>);
    /// Visits row ids in primary key order until `visit` returns false.
    fn pk_scan(&self, visit: impl FnMut(u32) -> bool);

    /// The first load error since the last call, if any.
    fn failure(&self) -> Option<Error>;

    /// The values the bitmap index on `c` holds, ascending.
    fn bitmap_values(&self, c: usize) -> Vec<u32>;

    /// Loads what gathering `rows` needs, batching reads. A hint: `gather` loads on its own.
    fn prefetch(&self, _rows: &[u32]) {}

    /// Appends the values of `row`, one per column, to `out`.
    ///
    /// Rows are gathered for a whole result before any is formatted. Rows of a result are
    /// scattered over memory, and a loop that only loads keeps many of those cache misses in
    /// flight, while interleaving them with JSON formatting waits for each in turn.
    #[inline]
    fn gather<'a>(&'a self, row: u32, out: &mut Vec<Val<'a>>) {
        for (c, def) in self.schema().columns.iter().enumerate() {
            out.push(match def.kind {
                Kind::U32 => Val::U32(self.u32_at(c, row)),
                Kind::F64 => Val::F64(self.f64_at(c, row)),
                Kind::Str => Val::Str(self.str_at(c, row)),
                Kind::U32Multi => Val::Multi(self.multi_at(c, row)),
            });
        }
    }

    #[inline]
    fn pk_key(&self, row: u32) -> u64 {
        f64_key(self.f64_at(self.pk_col(), row))
    }
}

/// One column value of a row, read out ahead of formatting.
pub(crate) enum Val<'a> {
    U32(u32),
    F64(f64),
    Str(&'a str),
    Multi(&'a [u32]),
}

/// Appends one gathered row as a JSON object with the schema's column names.
pub(crate) fn write_row_json(schema: &Schema, vals: &[Val<'_>], out: &mut String) {
    out.push('{');
    let mut first = true;
    for (def, v) in schema.columns.iter().zip(vals) {
        if def.index == crate::schema::IndexKind::Keys
            || (def.omit_empty && matches!(v, Val::Str("")))
        {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        json::write_str(out, &def.name);
        out.push(':');
        match *v {
            Val::U32(x) => json::write_u32(out, x),
            Val::F64(x) => json::write_f64(out, x),
            Val::Str(s) => json::write_str(out, s),
            Val::Multi(values) => {
                out.push('[');
                for (j, &x) in values.iter().enumerate() {
                    if j > 0 {
                        out.push(',');
                    }
                    json::write_u32(out, x);
                }
                out.push(']');
            }
        }
    }
    out.push('}');
}

fn union<'a>(bitmaps: impl Iterator<Item = &'a RoaringBitmap>) -> RoaringBitmap {
    let mut acc = RoaringBitmap::new();
    for b in bitmaps {
        acc |= b;
    }
    acc
}

/// `[start, end)` of the entries whose key lies in `lo..=hi`.
pub(crate) fn slice_bounds(entries: &[(u64, u32)], lo: u64, hi: u64) -> (usize, usize) {
    let start = entries.partition_point(|e| e.0 < lo);
    let end = entries.partition_point(|e| e.0 <= hi);
    (start, end.max(start))
}

fn walk_slice(slice: &[(u64, u32)], desc: bool, mut visit: impl FnMut(u32, u64) -> bool) {
    if desc {
        for &(key, row) in slice.iter().rev() {
            if !visit(row, key) {
                break;
            }
        }
    } else {
        for &(key, row) in slice {
            if !visit(row, key) {
                break;
            }
        }
    }
}

impl Table {
    fn ordered_entries(&self, c: usize) -> &[(u64, u32)] {
        match &self.indexes[c] {
            Index::Ordered { entries, .. } => entries,
            _ => unreachable!("column {c} has no ordered index"),
        }
    }

    fn group_entries(&self, c: usize, g: u32) -> &[(u64, u32)] {
        match &self.indexes[c] {
            Index::Ordered { groups, .. } => groups.get(&g).map_or(&[], Vec::as_slice),
            _ => unreachable!("column {c} has no ordered index"),
        }
    }
}

impl Part for Table {
    fn schema(&self) -> &Schema {
        &self.schema
    }

    fn pk_col(&self) -> usize {
        self.pk_col
    }

    fn len(&self) -> u32 {
        self.len
    }

    #[inline]
    fn u32_at(&self, c: usize, row: u32) -> u32 {
        self.columns[c].u32_at(row)
    }

    #[inline]
    fn f64_at(&self, c: usize, row: u32) -> f64 {
        self.columns[c].f64_at(row)
    }

    #[inline]
    fn multi_at(&self, c: usize, row: u32) -> &[u32] {
        self.columns[c].multi_at(row)
    }

    #[inline]
    fn str_at(&self, c: usize, row: u32) -> &str {
        self.columns[c].str_at(row)
    }

    fn bitmap_estimate(&self, c: usize, test: &Test) -> u64 {
        let Index::Bitmap(map) = &self.indexes[c] else {
            unreachable!("column {c} has no bitmap index")
        };
        match test {
            Test::U32Set(values) => values
                .iter()
                .filter_map(|v| map.get(v))
                .map(RoaringBitmap::len)
                .sum(),
            Test::U32Range(lo, hi) => map.range(*lo..=*hi).map(|(_, b)| b.len()).sum(),
            _ => unreachable!("bitmap index on a u32 column"),
        }
    }

    fn bitmap_count(&self, c: usize, test: &Test) -> usize {
        self.bitmaps(c, test).len()
    }

    fn bitmaps(&self, c: usize, test: &Test) -> Vec<&RoaringBitmap> {
        let Index::Bitmap(map) = &self.indexes[c] else {
            unreachable!("column {c} has no bitmap index")
        };
        match test {
            Test::U32Set(values) => values.iter().filter_map(|v| map.get(v)).collect(),
            Test::U32Range(lo, hi) => map.range(*lo..=*hi).map(|(_, b)| b).collect(),
            _ => unreachable!("bitmap index on a u32 column"),
        }
    }

    fn bitmap(&self, c: usize, test: &Test) -> Cow<'_, RoaringBitmap> {
        let Index::Bitmap(map) = &self.indexes[c] else {
            unreachable!("column {c} has no bitmap index")
        };
        match test {
            Test::U32Set(values) if values.len() == 1 => map
                .get(&values[0])
                .map_or_else(|| Cow::Owned(RoaringBitmap::new()), Cow::Borrowed),
            Test::U32Set(values) => Cow::Owned(union(values.iter().filter_map(|v| map.get(v)))),
            Test::U32Range(lo, hi) => Cow::Owned(union(map.range(*lo..=*hi).map(|(_, b)| b))),
            _ => unreachable!("bitmap index on a u32 column"),
        }
    }

    fn ordered_bounds(&self, c: usize, lo: u64, hi: u64) -> (usize, usize) {
        slice_bounds(self.ordered_entries(c), lo, hi)
    }

    fn ordered_len(&self, c: usize) -> usize {
        self.ordered_entries(c).len()
    }

    fn ordered_walk(
        &self,
        c: usize,
        start: usize,
        end: usize,
        desc: bool,
        visit: impl FnMut(u32, u64) -> bool,
    ) {
        walk_slice(&self.ordered_entries(c)[start..end], desc, visit);
    }

    fn ordered_rows(&self, c: usize, start: usize, end: usize, out: &mut Vec<u32>) {
        out.extend(self.ordered_entries(c)[start..end].iter().map(|e| e.1));
    }

    fn has_groups(&self, c: usize) -> bool {
        matches!(&self.indexes[c], Index::Ordered { built_len, .. } if *built_len == self.len)
            && self.schema.columns[c].group.is_some()
    }

    fn group_len(&self, c: usize, g: u32) -> usize {
        self.group_entries(c, g).len()
    }

    fn group_bounds(&self, c: usize, g: u32, lo: u64, hi: u64) -> (usize, usize) {
        slice_bounds(self.group_entries(c, g), lo, hi)
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
        walk_slice(&self.group_entries(c, g)[start..end], desc, visit);
    }

    fn pk_walk(&self, lo: u64, hi: u64, desc: bool, mut visit: impl FnMut(u64, u32) -> bool) {
        if lo > hi {
            return;
        }
        let range = self.pk.range(lo..=hi);
        if desc {
            for (&k, &r) in range.rev() {
                if !visit(k, r) {
                    return;
                }
            }
        } else {
            for (&k, &r) in range {
                if !visit(k, r) {
                    return;
                }
            }
        }
    }

    fn keys_walk(
        &self,
        c: usize,
        lo: &[u8],
        hi: Option<&[u8]>,
        desc: bool,
        mut visit: impl FnMut(&[u8], u32) -> bool,
    ) {
        let Index::Keys(set) = &self.indexes[c] else {
            unreachable!("column {c} has no keys index")
        };
        if hi.is_some_and(|h| h <= lo) {
            return;
        }
        use std::ops::Bound;
        let low = Bound::Included((Box::<[u8]>::from(lo), 0u32));
        let high = hi.map_or(Bound::Unbounded, |h| {
            Bound::Excluded((Box::<[u8]>::from(h), 0u32))
        });
        let range = set.range((low, high));
        if desc {
            for (k, r) in range.rev() {
                if !visit(k, *r) {
                    return;
                }
            }
        } else {
            for (k, r) in range {
                if !visit(k, *r) {
                    return;
                }
            }
        }
    }

    fn keys_count(&self, c: usize, lo: &[u8], hi: Option<&[u8]>) -> u64 {
        let mut n = 0;
        self.keys_walk(c, lo, hi, false, |_, _| {
            n += 1;
            true
        });
        n
    }

    fn pk_get(&self, key: u64) -> Option<u32> {
        self.pk.get(&key).copied()
    }

    fn pk_range(&self, lo: u64, hi: u64, out: &mut Vec<u32>) {
        out.extend(self.pk.range(lo..=hi).map(|(_, &r)| r));
    }

    fn pk_scan(&self, mut visit: impl FnMut(u32) -> bool) {
        for &row in self.pk.values() {
            if !visit(row) {
                break;
            }
        }
    }

    fn failure(&self) -> Option<Error> {
        None
    }

    fn bitmap_values(&self, c: usize) -> Vec<u32> {
        match &self.indexes[c] {
            Index::Bitmap(map) => map.keys().copied().collect(),
            _ => unreachable!("column {c} has no bitmap index"),
        }
    }
}
