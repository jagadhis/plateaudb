//! Peak heap through a bulk load saved in batches, updates and compaction, under a memory budget
//! and without one. A counting allocator measures it; this file holds one test so nothing else
//! allocates meanwhile.

use plateau_engine::{Batch, ColumnData, Db, Error, Schema, Storage, set_memory_budget};
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;

static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = NOW.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        NOW.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, p: *mut u8, layout: Layout, new: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, layout, new) };
        if !q.is_null() {
            if new >= layout.size() {
                let now =
                    NOW.fetch_add(new - layout.size(), Ordering::Relaxed) + new - layout.size();
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                NOW.fetch_sub(layout.size() - new, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// Runs `f` and returns how far the heap rose above where it started.
fn peak_of(f: impl FnOnce()) -> usize {
    let base = NOW.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    f();
    PEAK.load(Ordering::Relaxed) - base
}

/// A file on disk, so the database's bytes are not on the heap being measured.
struct Disk(File);

impl Storage for Disk {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<(), Error> {
        self.0
            .read_exact_at(buf, offset)
            .map_err(|e| Error::new(e.to_string()))
    }
    fn write_at(&self, offset: u64, buf: &[u8]) -> Result<(), Error> {
        self.0
            .write_all_at(buf, offset)
            .map_err(|e| Error::new(e.to_string()))
    }
    fn size(&self) -> Result<u64, Error> {
        Ok(self
            .0
            .metadata()
            .map_err(|e| Error::new(e.to_string()))?
            .len())
    }
    fn truncate(&self, size: u64) -> Result<(), Error> {
        self.0.set_len(size).map_err(|e| Error::new(e.to_string()))
    }
    fn flush(&self) -> Result<(), Error> {
        Ok(())
    }
}

const SCHEMA: &str = r#"{
  "primaryKey": "id",
  "columns": [
    {"name": "id", "kind": "f64"},
    {"name": "teamId", "kind": "u32", "index": "bitmap"},
    {"name": "stateId", "kind": "u32", "index": "bitmap"},
    {"name": "labelIds", "kind": "u32_multi", "index": "bitmap"},
    {"name": "updatedAt", "kind": "f64", "index": "ordered", "group": "teamId"},
    {"name": "title", "kind": "str"}
  ]
}"#;

/// Rows `from..from + n` (ids may repeat earlier ones when `edit`).
fn rows(schema: &Schema, ids: &[f64], seed: u64) -> Batch {
    let mut x = seed | 1;
    let mut next = move |m: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % m
    };
    let n = ids.len();
    let mut b = Batch::new(schema, n);
    let mut col = |name: &str, d: ColumnData| b.set(schema, name, d).unwrap();
    col("id", ColumnData::F64(ids.to_vec()));
    col(
        "teamId",
        ColumnData::U32((0..n).map(|_| next(40) as u32).collect()),
    );
    col(
        "stateId",
        ColumnData::U32((0..n).map(|_| next(300) as u32).collect()),
    );
    let (mut offsets, mut values) = (vec![0u32], Vec::new());
    for _ in 0..n {
        for _ in 0..next(3) {
            values.push(next(200) as u32);
        }
        offsets.push(values.len() as u32);
    }
    col("labelIds", ColumnData::U32Multi { offsets, values });
    col(
        "updatedAt",
        ColumnData::F64((0..n).map(|_| next(1 << 40) as f64).collect()),
    );
    let (mut offsets, mut bytes) = (vec![0u32], Vec::new());
    for id in ids {
        bytes.extend_from_slice(format!("issue {id} about {}", next(1 << 30)).as_bytes());
        offsets.push(bytes.len() as u32);
    }

    col("title", ColumnData::Str { offsets, bytes });
    b
}

const ROWS: usize = 200_000;
const BATCH: usize = 20_000;

/// Peaks of load (saves of `BATCH` rows, then a compaction), updates (1% replaced, 1% deleted,
/// saved) and compaction, and the file's size after each.
fn phases(budget: usize) -> [(usize, u64); 3] {
    set_memory_budget(budget);
    let schema = Schema::from_json(SCHEMA).unwrap();
    let path =
        std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("memory-{budget}.db"));
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    let storage = Rc::new(Disk(file));
    let mut db = Db::create(storage.clone(), schema.clone()).unwrap();
    let load = peak_of(|| {
        for start in (0..ROWS).step_by(BATCH) {
            let ids: Vec<f64> = (start..start + BATCH).map(|i| i as f64).collect();
            db.append(rows(&schema, &ids, start as u64)).unwrap();
            db.save().unwrap();
        }
        db.compact().unwrap();
    });
    let after_load = storage.size().unwrap();
    assert!(
        after_load <= db.used_bytes() + db.used_bytes() / 10 + (16 << 10),
        "after_load: file {after_load}, used {}",
        db.used_bytes()
    );
    let updates = peak_of(|| {
        let edit: Vec<f64> = (0..ROWS).step_by(100).map(|i| i as f64).collect();
        let gone: Vec<f64> = (50..ROWS).step_by(100).map(|i| i as f64).collect();
        db.put(rows(&schema, &edit, 7)).unwrap();
        db.delete(&gone).unwrap();
        db.save().unwrap();
    });
    let after_updates = storage.size().unwrap();
    assert!(
        after_updates <= db.used_bytes() + db.used_bytes() / 10 + (16 << 10),
        "after_updates: file {after_updates}, used {}",
        db.used_bytes()
    );
    let compaction = peak_of(|| db.compact().unwrap());
    let after_compaction = storage.size().unwrap();
    assert!(
        after_compaction <= db.used_bytes() + db.used_bytes() / 10 + (16 << 10),
        "after_compaction: file {after_compaction}, used {}",
        db.used_bytes()
    );
    assert_eq!(db.len(), (ROWS - ROWS / 100) as u64);
    [
        (load, after_load),
        (updates, after_updates),
        (compaction, after_compaction),
    ]
}

#[test]
fn peak_heap_follows_the_budget_not_the_table_through_load_updates_and_compaction() {
    let mb = |b: usize| b as f64 / (1 << 20) as f64;
    let unbounded = phases(usize::MAX);
    let budget = 2 << 20;
    let bounded = phases(budget);
    for (name, (u, b)) in ["load", "updates", "compaction"]
        .iter()
        .zip(unbounded.iter().zip(&bounded))
    {
        println!(
            "{name}: peak heap {:.1} MiB unbounded, {:.1} MiB with a 2 MiB budget; file {:.1} / {:.1} MiB",
            mb(u.0),
            mb(b.0),
            mb(u.1 as usize),
            mb(b.1 as usize)
        );
    }
    let file = bounded[2].1 as usize;
    // Unbounded, compaction holds what it read; under the budget the peak is the budget plus a
    // working set that does not grow with the file: the row map (4 bytes per row), one bitmap's
    // rows, the write buffer and the step's reads.
    assert!(unbounded[2].0 > file / 2, "{}", unbounded[2].0);
    for (load_or_update, _) in &bounded[..2] {
        // The memory test's own input batches (`BATCH` rows) are part of these peaks.
        assert!(*load_or_update < budget + (12 << 20), "{}", load_or_update);
    }
    assert!(
        bounded[2].0 < budget + 12 * ROWS + (2 << 20),
        "{}",
        bounded[2].0
    );
    // The compaction went into the space the load's last compaction freed, and the file was cut.
    assert!(bounded[2].1 < bounded[1].1, "{:?}", bounded);
}
