//! Deleted and replaced rows of one part. A saved segment's rows never change, so `put` of an
//! existing key and `delete` mark the old row here; queries leave marked rows out.

use crate::key::f64_key;
use crate::part::Part;
use crate::query::Test;
use roaring::RoaringBitmap;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

/// Per (ordered column, group value): sorted index keys of the deleted rows in that group.
type GroupKeys = BTreeMap<(usize, u32), Rc<[u64]>>;

#[derive(Debug, Default)]
pub(crate) struct Tombstones {
    pub rows: RoaringBitmap,
    /// The same rows as a flat bitset, for the per-row test walks and gets make: one load and a
    /// shift instead of a roaring lookup. Covers rows up to the highest deleted one.
    bits: Vec<u64>,
    /// Per (ordered column, group value): the sorted index keys of deleted rows in that group, so
    /// a grouped count subtracts them with two binary searches. Built on first use.
    groups: RefCell<GroupKeys>,
}

impl Tombstones {
    pub fn new(rows: RoaringBitmap) -> Tombstones {
        let mut t = Tombstones {
            rows: RoaringBitmap::new(),
            bits: Vec::new(),
            groups: RefCell::default(),
        };
        for row in &rows {
            t.set_bit(row);
        }
        t.rows = rows;
        t
    }

    fn set_bit(&mut self, row: u32) {
        let w = (row >> 6) as usize;
        if self.bits.len() <= w {
            self.bits.resize(w + 1, 0);
        }
        self.bits[w] |= 1 << (row & 63);
    }

    #[inline]
    pub fn contains(&self, row: u32) -> bool {
        self.bits
            .get((row >> 6) as usize)
            .is_some_and(|w| w >> (row & 63) & 1 == 1)
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn mark(&mut self, row: u32) {
        self.rows.insert(row);
        self.set_bit(row);
        self.groups.get_mut().clear();
    }

    /// Deleted rows of group `g` (on bitmap column `gc`) whose key on ordered column `c` lies in
    /// `lo..=hi`.
    pub fn group_count<P: Part>(
        &self,
        p: &P,
        c: usize,
        gc: usize,
        g: u32,
        lo: u64,
        hi: u64,
    ) -> u64 {
        let keys = self.group_keys(p, c, gc, g);
        let start = keys.partition_point(|&k| k < lo);
        let end = keys.partition_point(|&k| k <= hi);
        end.saturating_sub(start) as u64
    }

    fn group_keys<P: Part>(&self, p: &P, c: usize, gc: usize, g: u32) -> Rc<[u64]> {
        if let Some(keys) = self.groups.borrow().get(&(c, g)) {
            return keys.clone();
        }
        let in_group = p.bitmap(gc, &Test::U32Set(vec![g]));
        let mut keys: Vec<u64> = (&self.rows & in_group.as_ref())
            .iter()
            .map(|r| f64_key(p.f64_at(c, r)))
            .collect();
        keys.sort_unstable();
        let keys: Rc<[u64]> = keys.into();
        self.groups.borrow_mut().insert((c, g), keys.clone());
        keys
    }
}
