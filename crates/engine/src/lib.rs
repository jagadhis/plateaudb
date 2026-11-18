//! plateau engine, M1f: a memory budget and file space reuse.
//!
//! A database is a file of immutable segments plus an in-memory delta of unsaved rows. Each
//! segment holds its columns in chunks, a primary key and ordered indexes as checksummed blocks of
//! (key, row) pairs, roaring bitmaps from value to row ids for low-cardinality fields, and every
//! row again as a record, so gathering a result row reads one small block. Opening reads two
//! header slots and a manifest of a few hundred bytes per segment; every directory, chunk, bitmap
//! and block is read and checksummed the first time a query touches it. Queries walk the group of
//! a grouped ordered index when they fix the group, otherwise combine bitmaps first and choose
//! between walking an ordered index and sorting the candidate set, so their cost follows the
//! result size rather than the table size.
//!
//! Saved segments never change: `put` of an existing key and `delete` mark the old row in a
//! per-segment delete bitmap that every plan subtracts, and `compact` rewrites the live rows as
//! one segment. Saves and compactions stream their rows a bounded run at a time (`merge`) into
//! the file's free space (`write`), and loaded sections stay within a memory budget (`cache`).

#[cfg(target_endian = "big")]
compile_error!("segments are read in place as little-endian arrays");

mod cache;
mod db;
mod dead;
mod error;
mod format;
mod json;
mod key;
mod keys;
mod merge;
mod part;
mod query;
mod schema;
mod segment;
mod storage;
mod table;
mod write;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use cache::{DEFAULT_BUDGET, cached_bytes, memory_budget, set_memory_budget};
pub use db::{Db, Loaded};
pub use error::Error;
pub use format::Layout;
pub use key::f64_key;
pub use query::{Cond, Filter, OrderBy, Output, Query, QueryResult, RowId};
pub use schema::{ColumnDef, IndexKind, Kind, Schema};
pub use storage::{MemStorage, Storage};
pub use table::{Batch, ColumnData};
