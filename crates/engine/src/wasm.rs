//! Browser bindings. The worker owns one `Db` over an OPFS `FileSystemSyncAccessHandle`; every
//! call is synchronous.
//!
//! Storage is a JS object the worker supplies with `read(ptr, len, at)`, `write(ptr, len, at)`,
//! `size()`, `truncate(size)` and `flush()`. `ptr` and `len` name a buffer in this module's memory:
//! the worker wraps them in a `Uint8Array` over `memory.buffer` for the call, so file bytes go
//! straight into Rust buffers. It must build the view per call, because a `memory.grow` detaches
//! the previous buffer.

use crate::Error;
use crate::schema::Schema;
use crate::storage::Storage;
use crate::table::{Batch, ColumnData};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    pub type JsStorage;

    #[wasm_bindgen(method, catch)]
    fn read(this: &JsStorage, ptr: u32, len: u32, at: f64) -> Result<f64, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn write(this: &JsStorage, ptr: u32, len: u32, at: f64) -> Result<f64, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn size(this: &JsStorage) -> Result<f64, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn truncate(this: &JsStorage, size: f64) -> Result<(), JsValue>;
    #[wasm_bindgen(method, catch)]
    fn flush(this: &JsStorage) -> Result<(), JsValue>;
}

fn js_err(e: JsValue) -> Error {
    Error::new(format!(
        "storage: {}",
        e.as_string().unwrap_or_else(|| format!("{e:?}"))
    ))
}

impl Storage for JsStorage {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<(), Error> {
        let mut done = 0usize;
        while done < buf.len() {
            let rest = &mut buf[done..];
            let n = self
                .read(
                    rest.as_mut_ptr() as u32,
                    rest.len() as u32,
                    (offset + done as u64) as f64,
                )
                .map_err(js_err)? as usize;
            if n == 0 {
                return Err(Error::new("read past the end of the file"));
            }
            done += n;
        }
        Ok(())
    }

    fn write_at(&self, offset: u64, buf: &[u8]) -> Result<(), Error> {
        let mut done = 0usize;
        while done < buf.len() {
            let rest = &buf[done..];
            let n = self
                .write(
                    rest.as_ptr() as u32,
                    rest.len() as u32,
                    (offset + done as u64) as f64,
                )
                .map_err(js_err)? as usize;
            if n == 0 {
                return Err(Error::new("storage wrote nothing"));
            }
            done += n;
        }
        Ok(())
    }

    fn size(&self) -> Result<u64, Error> {
        Ok(JsStorage::size(self).map_err(js_err)? as u64)
    }

    fn truncate(&self, size: u64) -> Result<(), Error> {
        JsStorage::truncate(self, size as f64).map_err(js_err)
    }

    fn flush(&self) -> Result<(), Error> {
        JsStorage::flush(self).map_err(js_err)
    }
}

/// Sets the memory budget for every database in this runtime, in bytes: loaded sections past it
/// are dropped, least recently used first, and read again when touched. `Infinity`, `NaN` or a
/// value of 0 or less means no limit.
#[wasm_bindgen(js_name = setMemoryBudget)]
pub fn set_memory_budget(bytes: f64) {
    let b = if bytes.is_finite() && bytes > 0.0 {
        bytes as usize
    } else {
        usize::MAX
    };
    crate::set_memory_budget(b);
}

/// The memory budget in bytes; `Infinity` when there is none.
#[wasm_bindgen(js_name = memoryBudget)]
pub fn memory_budget() -> f64 {
    match crate::memory_budget() {
        usize::MAX => f64::INFINITY,
        b => b as f64,
    }
}

/// Bytes every open database's loaded sections hold, as counted against the budget.
#[wasm_bindgen(js_name = cachedBytes)]
pub fn cached_bytes() -> f64 {
    crate::cached_bytes() as f64
}

#[wasm_bindgen]
pub struct Db {
    db: crate::Db,
    batch: Option<Batch>,
}

#[wasm_bindgen]
impl Db {
    /// Starts an empty database in `storage` from a schema JSON
    /// (`{"primaryKey":"id","columns":[{"name":"id","kind":"f64"}, ...]}`).
    pub fn create(storage: JsStorage, schema_json: &str) -> Result<Db, JsError> {
        let schema = Schema::from_json(schema_json)?;
        Ok(Db {
            db: crate::Db::create(Rc::new(storage), schema)?,
            batch: None,
        })
    }

    /// Opens the database in `storage`: reads the header slots and the manifest, nothing else.
    pub fn open(storage: JsStorage) -> Result<Db, JsError> {
        Ok(Db {
            db: crate::Db::open(Rc::new(storage))?,
            batch: None,
        })
    }

    /// Opens the newest complete state whose sequence number is at most `max_seq`.
    #[wasm_bindgen(js_name = openAt)]
    pub fn open_at(storage: JsStorage, max_seq: f64) -> Result<Db, JsError> {
        Ok(Db {
            db: crate::Db::open_at(Rc::new(storage), max_seq as u64)?,
            batch: None,
        })
    }

    /// Sequence number of the committed state; 0 before the first save.
    pub fn seq(&self) -> f64 {
        self.db.seq() as f64
    }

    /// The owner's state string, committed with the rows by the next save.
    pub fn meta(&self) -> String {
        self.db.meta().to_string()
    }

    #[wasm_bindgen(js_name = setMeta)]
    pub fn set_meta(&mut self, meta: String) {
        self.db.set_meta(meta);
    }

    /// Drops every change since the last save or compaction.
    pub fn rollback(&mut self) {
        self.batch = None;
        self.db.rollback();
    }

    #[wasm_bindgen(js_name = beginBatch)]
    pub fn begin_batch(&mut self, rows: usize) {
        self.batch = Some(Batch::new(self.db.schema(), rows));
    }

    fn set(&mut self, column: &str, data: ColumnData) -> Result<(), JsError> {
        let batch = self
            .batch
            .as_mut()
            .ok_or_else(|| JsError::new("no batch: call beginBatch"))?;
        batch.set(self.db.schema(), column, data)?;
        Ok(())
    }

    #[wasm_bindgen(js_name = setU32)]
    pub fn set_u32(&mut self, column: &str, values: Vec<u32>) -> Result<(), JsError> {
        self.set(column, ColumnData::U32(values))
    }

    #[wasm_bindgen(js_name = setF64)]
    pub fn set_f64(&mut self, column: &str, values: Vec<f64>) -> Result<(), JsError> {
        self.set(column, ColumnData::F64(values))
    }

    #[wasm_bindgen(js_name = setMulti)]
    pub fn set_multi(
        &mut self,
        column: &str,
        offsets: Vec<u32>,
        values: Vec<u32>,
    ) -> Result<(), JsError> {
        self.set(column, ColumnData::U32Multi { offsets, values })
    }

    #[wasm_bindgen(js_name = setStr)]
    pub fn set_str(
        &mut self,
        column: &str,
        offsets: Vec<u32>,
        bytes: Vec<u8>,
    ) -> Result<(), JsError> {
        self.set(column, ColumnData::Str { offsets, bytes })
    }

    #[wasm_bindgen(js_name = commitBatch)]
    pub fn commit_batch(&mut self) -> Result<(), JsError> {
        let batch = self
            .batch
            .take()
            .ok_or_else(|| JsError::new("no batch: call beginBatch"))?;
        self.db.append(batch)?;
        Ok(())
    }

    /// Puts the batch: inserts its rows, replacing live rows with the same keys.
    #[wasm_bindgen(js_name = putBatch)]
    pub fn put_batch(&mut self) -> Result<(), JsError> {
        let batch = self
            .batch
            .take()
            .ok_or_else(|| JsError::new("no batch: call beginBatch"))?;
        self.db.put(batch)?;
        Ok(())
    }

    /// Deletes the live rows with these keys; returns how many there were.
    pub fn delete(&mut self, keys: &[f64]) -> Result<f64, JsError> {
        Ok(self.db.delete(keys)? as f64)
    }

    /// Writes the unsaved rows as a segment and the changed delete bitmaps, and commits them.
    pub fn save(&mut self) -> Result<(), JsError> {
        Ok(self.db.save()?)
    }

    /// Rewrites every live row as one segment and commits it.
    pub fn compact(&mut self) -> Result<(), JsError> {
        Ok(self.db.compact()?)
    }

    pub fn len(&self) -> f64 {
        self.db.len() as f64
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.db.is_empty()
    }

    /// Runs a query JSON; returns `{"plan":..,"rows":[..]}` or `{"plan":..,"count":n}`.
    pub fn query(&mut self, query_json: &str) -> Result<String, JsError> {
        Ok(self.db.query_json(query_json)?)
    }

    /// Live entries of the keys index on `column` in `[lo, hi)` (no upper bound when `hi` is
    /// undefined), ascending or descending, at most `limit`: one line per entry, the key, a tab,
    /// then the row's primary key.
    #[wasm_bindgen(js_name = keyScan)]
    pub fn key_scan(
        &mut self,
        column: &str,
        lo: &str,
        hi: Option<String>,
        desc: bool,
        limit: u32,
    ) -> Result<String, JsError> {
        let found = self.db.key_scan(
            column,
            lo.as_bytes(),
            hi.as_deref().map(str::as_bytes),
            desc,
            limit as usize,
        );
        self.db.enforce_budget();
        let found = found?;
        let mut out = String::new();
        for (i, (k, pk)) in found.iter().enumerate() {
            if i > 0 {
                out.push('\n');
            }
            out.push_str(std::str::from_utf8(k).map_err(|e| JsError::new(&e.to_string()))?);
            out.push('\t');
            crate::json::write_f64(&mut out, *pk);
        }
        Ok(out)
    }

    /// Live entries of the keys index on `column` in `[lo, hi)`.
    #[wasm_bindgen(js_name = keyCount)]
    pub fn key_count(
        &mut self,
        column: &str,
        lo: &str,
        hi: Option<String>,
    ) -> Result<f64, JsError> {
        let n = self
            .db
            .key_count(column, lo.as_bytes(), hi.as_deref().map(str::as_bytes));
        self.db.enforce_budget();
        Ok(n? as f64)
    }

    /// Live primary keys between `lo` and `hi`, ascending or descending, at most `limit`.
    #[wasm_bindgen(js_name = pkScan)]
    pub fn pk_scan(
        &mut self,
        lo: f64,
        lo_open: bool,
        hi: f64,
        hi_open: bool,
        desc: bool,
        limit: u32,
    ) -> Result<Vec<f64>, JsError> {
        let keys = self
            .db
            .pk_scan(lo, lo_open, hi, hi_open, desc, limit as usize);
        self.db.enforce_budget();
        Ok(keys?)
    }

    /// JSON array of row objects for the keys, `null` for absent keys.
    #[wasm_bindgen(js_name = getMany)]
    pub fn get_many(&mut self, keys: &[f64]) -> Result<String, JsError> {
        let out = self.db.get_many_json(keys);
        self.db.enforce_budget();
        Ok(out?)
    }

    /// Bytes of the file the committed state uses.
    #[wasm_bindgen(js_name = usedBytes)]
    pub fn used_bytes(&self) -> f64 {
        self.db.used_bytes() as f64
    }

    /// While set, commits leave the previous state's bytes in the file, so `openAt` can return
    /// to it (a group commit across files).
    #[wasm_bindgen(js_name = setKeepPrevious)]
    pub fn set_keep_previous(&mut self, keep: bool) {
        self.db.set_keep_previous(keep);
    }

    /// Lets go of the previous state: cuts the file after the committed state's last byte.
    #[wasm_bindgen(js_name = releasePrevious)]
    pub fn release_previous(&mut self) -> Result<(), JsError> {
        Ok(self.db.release_previous()?)
    }

    /// `{"segments":n,"unsavedRows":n,"deletedRows":n,"bytesLoaded":n,"sectionsLoaded":n,
    /// "engineReads":n,"cachedBytes":n,"usedBytes":n}`; `cachedBytes` is this database's loaded
    /// sections, `usedBytes` the bytes of the file its committed state uses.
    pub fn details(&self) -> String {
        let l = self.db.loaded();
        format!(
            "{{\"segments\":{},\"unsavedRows\":{},\"deletedRows\":{},\"bytesLoaded\":{},\"sectionsLoaded\":{},\"engineReads\":{},\"cachedBytes\":{},\"usedBytes\":{}}}",
            self.db.segments(),
            self.db.unsaved(),
            self.db.deleted(),
            l.bytes,
            l.sections,
            l.reads,
            self.db.cached(),
            self.db.used_bytes()
        )
    }
}
