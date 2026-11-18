//! The memory budget: a byte limit on the sections lazy segments keep loaded, per thread (the
//! browser runtime is one worker, so per runtime).
//!
//! Every loaded section, block and directory is counted when it loads. Leaf pieces (column
//! chunks, bitmaps, pairs blocks and fences, keys blocks, record groups) are registered with
//! their segment and carry a stamp of the last operation that touched them. When a database
//! operation starts or ends with the count past the budget, the database drops pieces down to
//! three quarters of the budget, and they load again, checksum checked, on their next touch. It
//! drops first the pieces no operation touched after the one that loaded them, least recently
//! used first, then the others the same way: a stream of one-off reads (scattered gets) does not
//! push out the index pieces queries keep using. Dropping takes `&mut` on the database, so nothing is dropped while a query
//! runs: every piece a query has touched stays loaded until it returns.

use std::cell::{Cell, OnceCell};

/// The default budget: 64 MiB. The browser bindings choose 24 MiB on small devices.
pub const DEFAULT_BUDGET: usize = 64 << 20;

thread_local! {
    static LIMIT: Cell<usize> = const { Cell::new(DEFAULT_BUDGET) };
    static USED: Cell<usize> = const { Cell::new(0) };
}

/// Sets the budget in bytes for every database on this thread; `usize::MAX` for no limit.
/// Databases shed down to it at their next operation.
pub fn set_memory_budget(bytes: usize) {
    LIMIT.with(|l| l.set(bytes));
}

/// The budget in bytes; `usize::MAX` when there is no limit.
pub fn memory_budget() -> usize {
    LIMIT.with(Cell::get)
}

/// Bytes the loaded sections of every open database on this thread hold.
pub fn cached_bytes() -> usize {
    USED.with(Cell::get)
}

pub(crate) fn charge(n: usize) {
    USED.with(|u| u.set(u.get() + n));
}

pub(crate) fn release(n: usize) {
    USED.with(|u| u.set(u.get().saturating_sub(n)));
}

pub(crate) fn over() -> bool {
    cached_bytes() > memory_budget()
}

/// What shedding aims for: three quarters of the budget, so a run of misses does not shed on
/// every operation.
pub(crate) fn low_water() -> usize {
    let b = memory_budget();
    b - b / 4
}

/// A piece loaded on first touch, with the stamp of the operation that last touched it.
pub(crate) struct Slot<T> {
    v: OnceCell<T>,
    used: Cell<u32>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Slot {
            v: OnceCell::new(),
            used: Cell::new(0),
        }
    }
}

impl<T> Slot<T> {
    /// The value if loaded, stamping the slot with `now` either way.
    #[inline]
    pub fn get(&self, now: u32) -> Option<&T> {
        self.used.set(now);
        self.v.get()
    }

    /// The value if loaded, without stamping.
    #[inline]
    pub fn peek(&self) -> Option<&T> {
        self.v.get()
    }

    pub fn set(&self, v: T) {
        let _ = self.v.set(v);
    }

    pub fn used(&self) -> u32 {
        self.used.get()
    }

    pub fn take(&mut self) -> Option<T> {
        self.v.take()
    }
}

pub(crate) fn slots<T>(n: usize) -> Box<[Slot<T>]> {
    (0..n).map(|_| Slot::default()).collect()
}
