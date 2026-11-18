//! Differential test: random databases (saved segments, reopened from storage, plus an unsaved
//! delta) and random queries, checked against a brute-force evaluator.

use plateau_engine::{
    Batch, ColumnData, Cond, Db, Error, Filter, Layout, MemStorage, OrderBy, Output, Query, Schema,
    Storage, cached_bytes, set_memory_budget,
};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[derive(Clone, Debug)]
struct Issue {
    id: f64,
    team: u32,
    state: u32,
    assignee: u32,
    labels: Vec<u32>,
    priority: u32,
    created: f64,
    updated: f64,
    title: String,
}

const SCHEMA: &str = r#"{
  "primaryKey": "id",
  "columns": [
    {"name": "id", "kind": "f64"},
    {"name": "teamId", "kind": "u32", "index": "bitmap"},
    {"name": "stateId", "kind": "u32", "index": "bitmap"},
    {"name": "assigneeId", "kind": "u32", "index": "bitmap"},
    {"name": "labelIds", "kind": "u32_multi", "index": "bitmap"},
    {"name": "priority", "kind": "u32", "index": "bitmap"},
    {"name": "createdAt", "kind": "f64"},
    {"name": "updatedAt", "kind": "f64", "index": "ordered", "group": "teamId"},
    {"name": "title", "kind": "str"}
  ]
}"#;

fn issues(rng: &mut Rng, n: usize, first_id: usize) -> Vec<Issue> {
    (0..n)
        .map(|i| {
            let team = rng.below(5) as u32;
            let mut labels: Vec<u32> = (0..rng.below(4)).map(|_| rng.below(12) as u32).collect();
            labels.sort_unstable();
            labels.dedup();
            let created = 1_000.0 + rng.below(500) as f64;
            Issue {
                // Ids are not in insertion order, so row id order differs from key order.
                id: ((first_id + i) * 7919 % 1_000_003) as f64,
                team,
                state: team * 6 + rng.below(6) as u32,
                assignee: rng.below(20) as u32,
                labels,
                priority: rng.below(5) as u32,
                created,
                // Few distinct values, so ties exercise the primary key tiebreak.
                updated: created + rng.below(300) as f64,
                title: format!("Issue \"{}\" é", first_id + i),
            }
        })
        .collect()
}

fn batch(schema: &Schema, rows: &[Issue]) -> Batch {
    let mut b = Batch::new(schema, rows.len());
    let mut set = |name: &str, data| b.set(schema, name, data).unwrap();
    set("id", ColumnData::F64(rows.iter().map(|r| r.id).collect()));
    set(
        "teamId",
        ColumnData::U32(rows.iter().map(|r| r.team).collect()),
    );
    set(
        "stateId",
        ColumnData::U32(rows.iter().map(|r| r.state).collect()),
    );
    set(
        "assigneeId",
        ColumnData::U32(rows.iter().map(|r| r.assignee).collect()),
    );
    set(
        "priority",
        ColumnData::U32(rows.iter().map(|r| r.priority).collect()),
    );
    set(
        "createdAt",
        ColumnData::F64(rows.iter().map(|r| r.created).collect()),
    );
    set(
        "updatedAt",
        ColumnData::F64(rows.iter().map(|r| r.updated).collect()),
    );
    let mut offsets = vec![0u32];
    let mut values = Vec::new();
    for r in rows {
        values.extend_from_slice(&r.labels);
        offsets.push(values.len() as u32);
    }
    set("labelIds", ColumnData::U32Multi { offsets, values });
    let mut offsets = vec![0u32];
    let mut bytes = Vec::new();
    for r in rows {
        bytes.extend_from_slice(r.title.as_bytes());
        offsets.push(bytes.len() as u32);
    }
    set("title", ColumnData::Str { offsets, bytes });
    b
}

fn field(r: &Issue, name: &str) -> Vec<f64> {
    match name {
        "id" => vec![r.id],
        "teamId" => vec![r.team as f64],
        "stateId" => vec![r.state as f64],
        "assigneeId" => vec![r.assignee as f64],
        "labelIds" => r.labels.iter().map(|&v| v as f64).collect(),
        "priority" => vec![r.priority as f64],
        "createdAt" => vec![r.created],
        "updatedAt" => vec![r.updated],
        _ => unreachable!(),
    }
}

fn cond_ok(c: &Cond, v: f64) -> bool {
    match c {
        Cond::Eq { value } => v == *value,
        Cond::In { values } => values.contains(&v),
        Cond::Range { gt, gte, lt, lte } => {
            gt.is_none_or(|x| v > x)
                && gte.is_none_or(|x| v >= x)
                && lt.is_none_or(|x| v < x)
                && lte.is_none_or(|x| v <= x)
        }
    }
}

enum Expected {
    Count(u64),
    Keys(Vec<f64>),
}

fn brute(rows: &[Issue], q: &Query) -> Expected {
    let mut hits: Vec<&Issue> = rows
        .iter()
        .filter(|r| {
            q.filters
                .iter()
                .all(|f| field(r, &f.field).iter().any(|&v| cond_ok(&f.cond, v)))
        })
        .collect();
    if q.count {
        return Expected::Count(hits.len() as u64);
    }
    let (name, desc) = q
        .order_by
        .as_ref()
        .map_or(("id", false), |o| (o.field.as_str(), o.desc));
    hits.sort_by(|a, b| {
        let o = field(a, name)[0]
            .total_cmp(&field(b, name)[0])
            .then(a.id.total_cmp(&b.id));
        if desc { o.reverse() } else { o }
    });
    let limit = q.limit.map_or(usize::MAX, |l| l as usize);
    Expected::Keys(hits.iter().take(limit).map(|r| r.id).collect())
}

fn random_filter(rng: &mut Rng) -> Filter {
    let fields = [
        "teamId",
        "stateId",
        "assigneeId",
        "labelIds",
        "priority",
        "createdAt",
        "updatedAt",
        "id",
    ];
    let name = fields[rng.below(fields.len() as u64) as usize];
    let span = match name {
        "teamId" => 6,
        "stateId" => 32,
        "assigneeId" => 22,
        "labelIds" => 13,
        "priority" => 6,
        "createdAt" => 1600,
        "updatedAt" => 1900,
        _ => 1_000_003,
    };
    let val = |rng: &mut Rng| {
        let v = rng.below(span) as f64;
        if rng.below(10) == 0 { v + 0.5 } else { v }
    };
    let cond = match rng.below(3) {
        0 => Cond::Eq { value: val(rng) },
        1 => Cond::In {
            values: (0..1 + rng.below(4)).map(|_| val(rng)).collect(),
        },
        _ => {
            let a = val(rng);
            let b = a + rng.below(span / 2 + 1) as f64;
            let pick = rng.below(4);
            Cond::Range {
                gt: (pick == 0).then_some(a),
                gte: (pick != 0).then_some(a),
                lt: (pick == 1).then_some(b),
                lte: (pick >= 2).then_some(b),
            }
        }
    };
    Filter {
        field: name.into(),
        cond,
    }
}

fn random_query(rng: &mut Rng) -> Query {
    if rng.below(4) == 0 {
        return group_query(rng);
    }
    let filters = (0..rng.below(4)).map(|_| random_filter(rng)).collect();
    let order_fields = ["updatedAt", "createdAt", "priority", "id"];
    Query {
        filters,
        count: rng.below(4) == 0,
        order_by: (rng.below(3) != 0).then(|| OrderBy {
            field: order_fields[rng.below(order_fields.len() as u64) as usize].into(),
            desc: rng.below(2) == 0,
        }),
        limit: (rng.below(3) != 0).then(|| [1, 5, 50, 1000][rng.below(4) as usize]),
    }
}
/// The shape the grouped walk serves: equality on the group column, other filters, ordered by
/// the grouped column, with a limit.
fn group_query(rng: &mut Rng) -> Query {
    let mut filters = vec![Filter {
        field: "teamId".into(),
        cond: Cond::Eq {
            value: rng.below(6) as f64,
        },
    }];
    filters.extend((0..rng.below(3)).map(|_| random_filter(rng)));
    let at = rng.below(filters.len() as u64) as usize;
    filters.swap(0, at);
    Query {
        filters,
        count: false,
        order_by: Some(OrderBy {
            field: "updatedAt".into(),
            desc: rng.below(2) == 0,
        }),
        limit: Some([1, 5, 50, 1000][rng.below(4) as usize]),
    }
}

fn check(db: &mut Db, rows: &[Issue], q: &Query) {
    let got = db.query(q).unwrap();
    match (brute(rows, q), got.output) {
        (Expected::Count(e), Output::Count(g)) => assert_eq!(e, g, "{q:?} plan {}", got.plan),
        (Expected::Keys(e), Output::Rows(g)) => {
            assert_eq!(e, db.keys_of(&g).unwrap(), "{q:?} plan {}", got.plan)
        }
        _ => panic!("output kind differs for {q:?}"),
    }
}

fn new_db(schema: &Schema) -> (Rc<MemStorage>, Db) {
    new_db_with(schema, Layout::default())
}

fn new_db_with(schema: &Schema, layout: Layout) -> (Rc<MemStorage>, Db) {
    let storage = Rc::new(MemStorage::new());
    let db = Db::create_with_layout(storage.clone(), schema.clone(), layout).unwrap();
    (storage, db)
}

fn reopen(storage: &Rc<MemStorage>) -> Db {
    Db::open(storage.clone()).unwrap()
}

/// A database with `rows` saved as one segment, reopened so every read goes through storage.
fn saved(schema: &Schema, rows: &[Issue]) -> (Rc<MemStorage>, Db) {
    let (storage, mut db) = new_db(schema);
    db.append(batch(schema, rows)).unwrap();
    db.save().unwrap();
    let db = reopen(&storage);
    (storage, db)
}

/// Gives rows ids that follow insertion order, so each segment's row ids follow its keys.
fn in_insertion_order(rows: &mut [Issue], first_id: usize) {
    for (i, r) in rows.iter_mut().enumerate() {
        r.id = (first_id + i) as f64;
    }
}

#[test]
fn random_queries_match_brute_force() {
    for seed in 0..6u64 {
        random_case(seed, false);
    }
}

#[test]
fn random_queries_match_brute_force_with_keys_in_row_order() {
    for seed in 10..14u64 {
        random_case(seed, true);
    }
}

fn random_case(seed: u64, ordered_ids: bool) {
    let schema = Schema::from_json(SCHEMA).unwrap();
    {
        let mut rng = Rng(seed);
        // Tiny chunks put chunk and fence boundaries inside every range and walk.
        let layout = if seed.is_multiple_of(2) {
            Layout::default()
        } else {
            Layout {
                chunk_shift: rng.below(5) as u32,
                pair_block: 1 + rng.below(12) as u32,
                record_shift: rng.below(4) as u32,
            }
        };
        let (storage, mut db) = new_db_with(&schema, layout);
        let mut rows = Vec::new();
        let mut saved_rows = 0;
        // Saved segments of several sizes (some span many column and index chunks), queried with
        // and without an unsaved delta on top, before and after reopening.
        for part in 0..4 {
            let size = [0, 1, 700, 6000, 13000][rng.below(5) as usize];
            let mut new = issues(&mut rng, size, rows.len() + part * 20_000);
            if ordered_ids {
                in_insertion_order(&mut new, rows.len() + part * 20_000);
            }
            db.append(batch(&schema, &new)).unwrap();
            rows.extend(new);
            if part < 3 || rng.below(2) == 0 {
                db.save().unwrap();
                saved_rows = rows.len();
            }
            for _ in 0..60 {
                check(&mut db, &rows, &random_query(&mut rng));
            }
        }
        let mut db = reopen(&storage);
        rows.truncate(saved_rows);
        assert_eq!(db.len(), rows.len() as u64);
        for _ in 0..60 {
            check(&mut db, &rows, &random_query(&mut rng));
        }
        let mut more = issues(&mut rng, 1500, 90_000);
        if ordered_ids {
            in_insertion_order(&mut more, 90_000);
        }
        db.append(batch(&schema, &more)).unwrap();
        rows.extend(more);
        for _ in 0..100 {
            check(&mut db, &rows, &random_query(&mut rng));
        }
        let keys: Vec<f64> = (0..40)
            .map(|_| {
                if rng.below(5) == 0 {
                    -1.0
                } else {
                    rows[rng.below(rows.len() as u64) as usize].id
                }
            })
            .collect();
        let got: serde_json::Value =
            serde_json::from_str(&db.get_many_json(&keys).unwrap()).unwrap();
        for (k, v) in keys.iter().zip(got.as_array().unwrap()) {
            match rows.iter().find(|r| r.id == *k) {
                Some(r) => {
                    assert_eq!(v["id"].as_f64(), Some(r.id));
                    assert_eq!(v["title"].as_str(), Some(r.title.as_str()));
                    assert_eq!(v["labelIds"].as_array().unwrap().len(), r.labels.len());
                }
                None => assert!(v.is_null()),
            }
        }
    }
}

fn q1(team: f64, states: [f64; 2], limit: u32) -> Query {
    Query {
        filters: vec![
            Filter {
                field: "teamId".into(),
                cond: Cond::Eq { value: team },
            },
            Filter {
                field: "stateId".into(),
                cond: Cond::In {
                    values: states.to_vec(),
                },
            },
        ],
        order_by: Some(OrderBy {
            field: "updatedAt".into(),
            desc: true,
        }),
        limit: Some(limit),
        count: false,
    }
}

#[test]
fn planner_walks_the_ordered_index_for_unselective_filters_and_sorts_selective_ones() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(42);
    let rows = issues(&mut rng, 20_000, 0);
    let (_, mut db) = saved(&schema, &rows);

    // 20k rows, ~7% selective: walking finds 10 rows in ~150 steps, sorting visits ~1400.
    let broad = q1(1.0, [6.0, 7.0], 10);
    let r = db.query(&broad).unwrap();
    assert!(r.plan.contains("walk:updatedAt:desc"), "{}", r.plan);
    check(&mut db, &rows, &broad);
    // Only what the walk touched is read: the bitmaps, one ordered chunk, and the rows' chunks.
    assert!(db.loaded().bytes < 400_000, "{:?}", db.loaded());

    let mut narrow = q1(1.0, [6.0, 7.0], 10);
    narrow.filters.push(Filter {
        field: "assigneeId".into(),
        cond: Cond::Eq { value: 3.0 },
    });
    let r = db.query(&narrow).unwrap();
    assert!(r.plan.contains("sort:updatedAt"), "{}", r.plan);
    check(&mut db, &rows, &narrow);
}

#[test]
fn a_count_by_group_and_range_uses_the_grouped_index_and_matches_brute_force() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(99);
    let rows = issues(&mut rng, 12_000, 0);
    let (_, mut segment) = saved(&schema, &rows);
    let (_, mut delta) = new_db(&schema);
    delta.append(batch(&schema, &rows)).unwrap();
    for db in [&mut segment, &mut delta] {
        for (teams, range) in [
            (
                vec![1.0],
                Cond::Range {
                    gt: Some(1200.0),
                    gte: None,
                    lt: None,
                    lte: None,
                },
            ),
            (
                vec![0.0, 3.0, 9.0],
                Cond::Range {
                    gt: None,
                    gte: Some(1100.0),
                    lt: Some(1300.0),
                    lte: None,
                },
            ),
            (
                vec![2.0],
                Cond::Range {
                    gt: Some(5.0),
                    gte: None,
                    lt: Some(5.0),
                    lte: None,
                },
            ),
            (
                vec![99.0],
                Cond::Range {
                    gt: None,
                    gte: None,
                    lt: None,
                    lte: None,
                },
            ),
        ] {
            let q = Query {
                filters: vec![
                    Filter {
                        field: "updatedAt".into(),
                        cond: range.clone(),
                    },
                    Filter {
                        field: "teamId".into(),
                        cond: Cond::In { values: teams },
                    },
                ],
                order_by: None,
                limit: None,
                count: true,
            };
            let r = db.query(&q).unwrap();
            assert_eq!(r.plan, "grouped-count");
            check(db, &rows, &q);
        }
    }
}

/// Two saves: `first` alone, then `first` + `second`. Returns the storage and both row sets.
fn two_states(schema: &Schema) -> (Rc<MemStorage>, Vec<Issue>, Vec<Issue>) {
    let mut rng = Rng(5);
    let first = issues(&mut rng, 3000, 0);
    let second = issues(&mut rng, 2000, 3000);
    let (storage, mut db) = new_db(schema);
    db.append(batch(schema, &first)).unwrap();
    db.save().unwrap();
    db.append(batch(schema, &second)).unwrap();
    db.save().unwrap();
    let both = first.iter().chain(&second).cloned().collect();
    (storage, first, both)
}

fn assert_holds(storage: Rc<MemStorage>, rows: &[Issue]) {
    let mut db = Db::open(storage).unwrap();
    assert_eq!(db.len(), rows.len() as u64);
    let mut rng = Rng(77);
    for _ in 0..50 {
        check(&mut db, rows, &random_query(&mut rng));
    }
}

#[test]
fn a_torn_save_opens_the_previous_state() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let (storage, first, both) = two_states(&schema);
    assert_holds(storage.clone(), &both);
    let bytes = storage.to_bytes();

    // The second save went to slot 0 (sequence 2). A torn header write fails its checksum.
    let mut torn_slot = bytes.clone();
    torn_slot[20] ^= 0xff;
    assert_holds(Rc::new(MemStorage::from_bytes(torn_slot)), &first);

    // The newest manifest is the last thing before the header write; if it did not reach the
    // disk intact, its checksum fails.
    let mut torn_manifest = bytes.clone();
    *torn_manifest.last_mut().unwrap() ^= 0xff;
    assert_holds(Rc::new(MemStorage::from_bytes(torn_manifest)), &first);

    // Saving after opening the previous state replaces the torn one.
    let storage = Rc::new(MemStorage::from_bytes({
        let mut b = bytes.clone();
        b[20] ^= 0xff;
        b
    }));
    let mut db = Db::open(storage.clone()).unwrap();
    let extra = issues(&mut Rng(6), 10, 9000);
    db.append(batch(&schema, &extra)).unwrap();
    db.save().unwrap();
    assert_holds(
        storage,
        &first.iter().chain(&extra).cloned().collect::<Vec<_>>(),
    );

    assert!(Db::open(Rc::new(MemStorage::from_bytes(vec![0; 9000]))).is_err());
    assert!(Db::open(Rc::new(MemStorage::new())).is_err());
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

#[test]
fn a_corrupt_record_block_is_an_error_when_touched_and_stays_one() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(8);
    let rows = issues(&mut rng, 3000, 0);
    let (storage, _) = saved(&schema, &rows);
    // A string is stored once, in the row's record block.
    let mut bytes = storage.to_bytes();
    let title = rows[0].title.as_bytes();
    let in_record = find(&bytes, title, 8192).unwrap();
    bytes[in_record + 2] ^= 0xff;
    let mut db = Db::open(Rc::new(MemStorage::from_bytes(bytes))).unwrap();
    for _ in 0..2 {
        let err = db
            .get_many_json(&[rows[0].id])
            .expect_err("record block is corrupt");
        assert!(err.to_string().contains("checksum"), "{err}");
    }
    // Rows in other record blocks still read, and queries that gather no row still run.
    let last = rows.last().unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&db.get_many_json(&[last.id]).unwrap()).unwrap();
    assert_eq!(v[0]["id"].as_f64(), Some(last.id));
    assert_eq!(v[0]["title"].as_str(), Some(last.title.as_str()));
    let mut q = q1(rows[0].team as f64, [0.0, 1.0], 10);
    q.count = true;
    check(&mut db, &rows, &q);
}

/// Flips one byte at a time across the whole file. Every open, query and get either errors or
/// returns exactly the right answer: no corrupt byte is ever served as data.
#[test]
fn a_flipped_byte_anywhere_is_an_error_or_harmless() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(21);
    let rows = issues(&mut rng, 1500, 0);
    let (storage, mut db) = new_db_with(
        &schema,
        Layout {
            chunk_shift: 7,
            pair_block: 64,
            record_shift: 2,
        },
    );
    db.append(batch(&schema, &rows)).unwrap();
    db.save().unwrap();
    let clean = storage.to_bytes();
    let mut queries: Vec<Query> = (0..12).map(|_| random_query(&mut rng)).collect();
    queries.push(q1(2.0, [12.0, 14.0], 20));
    let keys: Vec<f64> = rows.iter().step_by(97).map(|r| r.id).collect();
    let mut errors = 0;
    let step = clean.len() / 1500;
    for at in (8192..clean.len()).step_by(step) {
        let mut bytes = clean.clone();
        bytes[at] ^= 0x5a;
        let Ok(mut db) = Db::open(Rc::new(MemStorage::from_bytes(bytes))) else {
            errors += 1;
            continue;
        };
        for q in &queries {
            match db.query(q) {
                Err(_) => errors += 1,
                Ok(got) => match (brute(&rows, q), got.output) {
                    (Expected::Count(e), Output::Count(g)) => assert_eq!(e, g, "byte {at} {q:?}"),
                    (Expected::Keys(e), Output::Rows(g)) => match db.keys_of(&g) {
                        Ok(k) => assert_eq!(e, k, "byte {at} {q:?} plan {}", got.plan),
                        Err(_) => errors += 1,
                    },
                    _ => panic!("output kind differs"),
                },
            }
        }
        match db.get_many_json(&keys) {
            Err(_) => errors += 1,
            Ok(json) => {
                let got: serde_json::Value = serde_json::from_str(&json).unwrap();
                for (k, v) in keys.iter().zip(got.as_array().unwrap()) {
                    let r = rows.iter().find(|r| r.id == *k).unwrap();
                    assert_eq!(v["id"].as_f64(), Some(r.id), "byte {at}");
                    assert_eq!(v["title"].as_str(), Some(r.title.as_str()), "byte {at}");
                    assert_eq!(v["updatedAt"].as_f64(), Some(r.updated), "byte {at}");
                    assert_eq!(v["labelIds"].as_array().unwrap().len(), r.labels.len());
                }
            }
        }
    }
    assert!(errors > 100, "corruption was detected {errors} times");
}

/// A save torn while its segment or manifest was being written, before the header slot: the
/// file holds the old slots and part of the new data. It opens the previous state.
#[test]
fn a_save_torn_inside_the_segment_opens_the_previous_state() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(31);
    let first = issues(&mut rng, 2000, 0);
    let second = issues(&mut rng, 1000, 2000);
    let (storage, mut db) = new_db(&schema);
    db.append(batch(&schema, &first)).unwrap();
    db.save().unwrap();
    let before = storage.to_bytes();
    db.append(batch(&schema, &second)).unwrap();
    db.save().unwrap();
    let after = storage.to_bytes();
    let step = (after.len() - before.len()) / 7;
    for cut in (before.len()..after.len()).step_by(step) {
        let mut torn = before[..8192].to_vec();
        torn.extend_from_slice(&after[8192..cut]);
        assert_holds(Rc::new(MemStorage::from_bytes(torn)), &first);
    }
}

/// Gathering many scattered rows makes a segment read whole record groups; every row still reads
/// back exactly, before and after the switch.
#[test]
fn broad_gathers_read_whole_groups_and_return_the_same_rows() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(41);
    let rows = issues(&mut rng, 30_000, 0);
    let (_, db) = saved(&schema, &rows);
    let mut order: Vec<usize> = (0..rows.len()).collect();
    for i in (1..order.len()).rev() {
        order.swap(i, rng.below(i as u64 + 1) as usize);
    }
    let mut reads_per_row = Vec::new();
    for batch in order.chunks(1000) {
        let before = db.loaded();
        let keys: Vec<f64> = batch.iter().map(|&i| rows[i].id).collect();
        let got: serde_json::Value =
            serde_json::from_str(&db.get_many_json(&keys).unwrap()).unwrap();
        for (&i, v) in batch.iter().zip(got.as_array().unwrap()) {
            let r = &rows[i];
            assert_eq!(v["id"].as_f64(), Some(r.id));
            assert_eq!(v["teamId"].as_u64(), Some(r.team as u64));
            assert_eq!(v["updatedAt"].as_f64(), Some(r.updated));
            assert_eq!(v["title"].as_str(), Some(r.title.as_str()));
            let labels: Vec<u64> = v["labelIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_u64().unwrap())
                .collect();
            assert_eq!(
                labels,
                r.labels.iter().map(|&l| l as u64).collect::<Vec<_>>()
            );
        }
        reads_per_row.push((db.loaded().reads - before.reads) as f64 / batch.len() as f64);
    }
    // Early batches read about one record block per row; later ones find most rows loaded.
    assert!(reads_per_row[0] > 0.5, "{reads_per_row:?}");
    assert!(*reads_per_row.last().unwrap() < 0.2, "{reads_per_row:?}");
}

#[test]
fn append_rejects_duplicate_and_nan_keys_without_changing_the_database() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(3);
    let rows = issues(&mut rng, 10, 0);
    let (_, mut db) = saved(&schema, &rows);
    let more = issues(&mut rng, 5, 100);
    db.append(batch(&schema, &more)).unwrap();

    // Already in the segment, already in the delta, repeated in the batch, NaN.
    assert!(db.append(batch(&schema, &rows[3..4])).is_err());
    assert!(db.append(batch(&schema, &more[..1])).is_err());
    let mut dup = issues(&mut rng, 2, 500);
    dup[1].id = dup[0].id;
    assert!(db.append(batch(&schema, &dup)).is_err());
    let mut nan = issues(&mut rng, 1, 900);
    nan[0].id = f64::NAN;
    assert!(db.append(batch(&schema, &nan)).is_err());
    assert_eq!(db.len(), 15);

    let mut b = Batch::new(&schema, 1);
    assert!(
        b.set(&schema, "teamId", ColumnData::U32(vec![1, 2]))
            .is_err()
    );
    assert!(
        b.set(&schema, "teamId", ColumnData::F64(vec![1.0]))
            .is_err()
    );
    assert!(
        b.set(
            &schema,
            "title",
            ColumnData::Str {
                offsets: vec![0, 1],
                bytes: vec![0xff]
            }
        )
        .is_err()
    );
    assert!(db.append(b).is_err());
}

#[test]
fn schema_rejects_invalid_indexes() {
    assert!(
        Schema::from_json(r#"{"primaryKey":"id","columns":[{"name":"id","kind":"u32"}]}"#).is_err()
    );
    assert!(Schema::from_json(
        r#"{"primaryKey":"id","columns":[{"name":"id","kind":"f64"},{"name":"t","kind":"str","index":"bitmap"}]}"#
    )
    .is_err());
    assert!(Schema::from_json(
        r#"{"primaryKey":"id","columns":[{"name":"id","kind":"f64"},{"name":"id","kind":"f64"}]}"#
    )
    .is_err());
}

#[test]
fn query_json_parses_the_wire_format() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(9);
    let rows = issues(&mut rng, 500, 0);
    let (_, mut db) = saved(&schema, &rows);
    let json = db
        .query_json(
            r#"{"where":[{"field":"teamId","op":"eq","value":2},{"field":"updatedAt","op":"range","gt":1200}],"count":true}"#,
        )
        .unwrap();
    let expected = rows
        .iter()
        .filter(|r| r.team == 2 && r.updated > 1200.0)
        .count() as u64;
    assert!(json.contains(&format!("\"count\":{expected}")), "{json}");
    assert!(
        db.query_json(r#"{"where":[{"field":"nope","op":"eq","value":1}]}"#)
            .is_err()
    );
    assert!(
        db.query_json(r#"{"where":[{"field":"title","op":"eq","value":1}]}"#)
            .is_err()
    );
}

// Updates and deletes.

/// The rows a database should hold, by key: what `put`, `delete`, `save` and reopen do to it.
#[derive(Clone, Default)]
struct Model {
    rows: Vec<Issue>,
}

impl Model {
    fn index(&self, id: f64) -> Option<usize> {
        self.rows.iter().position(|r| r.id == id)
    }

    fn put(&mut self, new: &[Issue]) {
        for r in new {
            match self.index(r.id) {
                Some(i) => self.rows[i] = r.clone(),
                None => self.rows.push(r.clone()),
            }
        }
    }

    fn delete(&mut self, keys: &[f64]) -> u64 {
        let before = self.rows.len();
        self.rows.retain(|r| !keys.contains(&r.id));
        (before - self.rows.len()) as u64
    }
}

/// Checks every field of the rows `get_many_json` returns for `keys`.
fn check_gets(db: &Db, model: &Model, keys: &[f64]) {
    let got: serde_json::Value = serde_json::from_str(&db.get_many_json(keys).unwrap()).unwrap();
    for (k, v) in keys.iter().zip(got.as_array().unwrap()) {
        match model.index(*k).map(|i| &model.rows[i]) {
            Some(r) => {
                assert_eq!(v["id"].as_f64(), Some(r.id));
                assert_eq!(v["teamId"].as_u64(), Some(r.team as u64), "key {k}");
                assert_eq!(v["updatedAt"].as_f64(), Some(r.updated), "key {k}");
                assert_eq!(v["title"].as_str(), Some(r.title.as_str()), "key {k}");
                let labels: Vec<u32> = v["labelIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_u64().unwrap() as u32)
                    .collect();
                assert_eq!(labels, r.labels, "key {k}");
            }
            None => assert!(v.is_null(), "key {k} was deleted: {v}"),
        }
    }
}

/// Some live keys, some deleted or never present.
fn some_keys(rng: &mut Rng, model: &Model, n: usize) -> Vec<f64> {
    (0..n)
        .map(|_| {
            if model.rows.is_empty() || rng.below(4) == 0 {
                (rng.below(1_000_003) as f64) + 0.25
            } else {
                model.rows[rng.below(model.rows.len() as u64) as usize].id
            }
        })
        .collect()
}

/// New rows for `n` keys drawn from the live rows (replacements) and from fresh ids.
fn replacements(rng: &mut Rng, model: &Model, n: usize, fresh_from: usize) -> Vec<Issue> {
    let mut new = issues(rng, n, fresh_from);
    let mut used = Vec::new();
    for r in &mut new {
        if !model.rows.is_empty() && rng.below(3) != 0 {
            let id = model.rows[rng.below(model.rows.len() as u64) as usize].id;
            if !used.contains(&id) {
                r.id = id;
            }
        }
        used.push(r.id);
    }
    new.sort_by(|a, b| a.id.total_cmp(&b.id));
    new.dedup_by(|a, b| a.id == b.id);
    new
}

fn check_all(db: &mut Db, model: &Model, rng: &mut Rng, queries: usize) {
    assert_eq!(db.len(), model.rows.len() as u64);
    for _ in 0..queries {
        check(db, &model.rows, &random_query(rng));
    }
    let keys = some_keys(rng, model, 30);
    check_gets(db, model, &keys);
}

#[test]
fn random_puts_deletes_saves_compactions_and_reopens_match_brute_force() {
    for seed in 100..106u64 {
        updates_case(seed);
    }
}

fn updates_case(seed: u64) {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(seed);
    let layout = if seed.is_multiple_of(2) {
        Layout::default()
    } else {
        Layout {
            chunk_shift: rng.below(5) as u32,
            pair_block: 1 + rng.below(12) as u32,
            record_shift: rng.below(4) as u32,
        }
    };
    let (storage, mut db) = new_db_with(&schema, layout);
    let mut model = Model::default();
    let mut saved = Model::default();
    let mut fresh = 0usize;
    let mut ever_saved = false;
    for step in 0..40 {
        match rng.below(10) {
            0..=3 => {
                let n = [1, 20, 300, 2500][rng.below(4) as usize];
                let new = replacements(&mut rng, &model, n, 200_000 + fresh);
                fresh += n;
                db.put(batch(&schema, &new)).unwrap();
                model.put(&new);
            }
            4..=5 => {
                let n = [1, 10, 200, 1500][rng.below(4) as usize];
                let mut keys = some_keys(&mut rng, &model, n);
                keys.sort_by(f64::total_cmp);
                keys.dedup();
                assert_eq!(
                    db.delete(&keys).unwrap(),
                    model.delete(&keys),
                    "step {step}"
                );
            }
            6..=7 => {
                db.save().unwrap();
                assert_tight(&storage, &db);
                saved = model.clone();
                ever_saved = true;
            }
            8 => {
                db.compact().unwrap();
                assert_tight(&storage, &db);
                saved = model.clone();
                ever_saved = true;
                assert!(db.segments() <= 1);
                assert_eq!(db.deleted(), 0);
            }
            _ if ever_saved => {
                db = reopen(&storage);
                model = saved.clone();
            }
            _ => {}
        }
        check_all(&mut db, &model, &mut rng, 25);
        // Appending a live key is rejected and changes nothing.
        if let Some(r) = model.rows.first() {
            assert!(db.append(batch(&schema, std::slice::from_ref(r))).is_err());
            assert_eq!(db.len(), model.rows.len() as u64);
        }
    }
    db.save().unwrap();
    let mut db = reopen(&storage);
    check_all(&mut db, &model, &mut rng, 60);
}

#[test]
fn put_rejects_nan_and_repeated_keys_without_changing_the_database() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(4);
    let rows = issues(&mut rng, 50, 0);
    let (_, mut db) = saved(&schema, &rows);
    let mut model = Model { rows: rows.clone() };
    let mut dup = issues(&mut rng, 2, 500);
    dup[0].id = rows[0].id;
    dup[1].id = rows[0].id;
    assert!(db.put(batch(&schema, &dup)).is_err());
    let mut nan = issues(&mut rng, 2, 900);
    nan[0].id = rows[1].id;
    nan[1].id = f64::NAN;
    assert!(db.put(batch(&schema, &nan)).is_err());
    let mut partial = Batch::new(&schema, 1);
    partial
        .set(&schema, "id", ColumnData::F64(vec![rows[2].id]))
        .unwrap();
    assert!(db.put(partial).is_err());
    check_all(&mut db, &model, &mut rng, 30);

    // A key replaced twice before a save keeps only the last row.
    let mut a = issues(&mut rng, 1, 1000);
    a[0].id = rows[3].id;
    let mut b = issues(&mut rng, 1, 1001);
    b[0].id = rows[3].id;
    db.put(batch(&schema, &a)).unwrap();
    db.put(batch(&schema, &b)).unwrap();
    model.put(&a);
    model.put(&b);
    assert_eq!(db.delete(&[rows[4].id, rows[4].id, -7.0]).unwrap(), 1);
    model.delete(&[rows[4].id]);
    check_all(&mut db, &model, &mut rng, 30);
}

/// Queries every plan shape once the segment has deleted rows: the grouped walk, the global walk,
/// bitmap intersections, the grouped count, plain counts, primary key scans and gets.
#[test]
fn every_plan_leaves_out_deleted_and_replaced_rows() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(12);
    let rows = issues(&mut rng, 20_000, 0);
    let (storage, mut db) = saved(&schema, &rows);
    let mut model = Model { rows: rows.clone() };
    let keys: Vec<f64> = rows.iter().step_by(50).map(|r| r.id).collect();
    db.delete(&keys).unwrap();
    model.delete(&keys);
    let new = replacements(&mut rng, &model, 400, 50_000);
    db.put(batch(&schema, &new)).unwrap();
    model.put(&new);
    let mut plans = Vec::new();
    let mut run = |db: &mut Db, q: Query| {
        plans.push(db.query(&q).unwrap().plan);
        check(db, &model.rows, &q);
    };
    for round in 0..2 {
        for team in 0..5 {
            run(
                &mut db,
                q1(
                    team as f64,
                    [team as f64 * 6.0, team as f64 * 6.0 + 1.0],
                    50,
                ),
            );
            let mut count = q1(team as f64, [0.0, 1.0], 0);
            count.filters = vec![
                Filter {
                    field: "teamId".into(),
                    cond: Cond::Eq { value: team as f64 },
                },
                Filter {
                    field: "updatedAt".into(),
                    cond: Cond::Range {
                        gt: Some(1200.0),
                        gte: None,
                        lt: None,
                        lte: None,
                    },
                },
            ];
            count.count = true;
            count.limit = None;
            run(&mut db, count);
        }
        run(
            &mut db,
            Query {
                count: true,
                ..Query::default()
            },
        );
        run(
            &mut db,
            Query {
                limit: Some(100),
                ..Query::default()
            },
        );
        run(
            &mut db,
            Query {
                order_by: Some(OrderBy {
                    field: "updatedAt".into(),
                    desc: true,
                }),
                limit: Some(100),
                ..Query::default()
            },
        );
        for _ in 0..150 {
            run(&mut db, random_query(&mut rng));
        }
        check_gets(&db, &model, &keys);
        check_gets(&db, &model, &new.iter().map(|r| r.id).collect::<Vec<_>>());
        if round == 0 {
            db.save().unwrap();
            db = reopen(&storage);
        }
    }
    let joined = plans.join("\n");
    for shape in [
        "grouped-count",
        "group:",
        "and[",
        "walk:",
        "scan:pk",
        "deleted:",
    ] {
        assert!(joined.contains(shape), "no {shape} plan in\n{joined}");
    }
}

#[test]
fn compaction_drops_dead_rows_and_later_saves_reuse_the_old_space() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(14);
    let rows = issues(&mut rng, 6000, 0);
    let (storage, mut db) = saved(&schema, &rows);
    let mut model = Model { rows };
    for round in 0..3 {
        let new = replacements(&mut rng, &model, 300, 10_000 * (round + 1));
        db.put(batch(&schema, &new)).unwrap();
        model.put(&new);
        let keys = some_keys(&mut rng, &model, 200);
        db.delete(&keys).unwrap();
        model.delete(&keys);
        db.save().unwrap();
    }
    assert!(db.segments() > 1 && db.deleted() > 0);
    let before = storage.size().unwrap();
    db.compact().unwrap();
    assert_eq!((db.segments(), db.deleted()), (1, 0));
    let compacted = storage.size().unwrap();
    assert!(compacted < before, "{before} {compacted}");
    assert_tight(&storage, &db);
    check_all(&mut db, &model, &mut rng, 40);
    let new = replacements(&mut rng, &model, 300, 90_000);
    db.put(batch(&schema, &new)).unwrap();
    model.put(&new);
    db.save().unwrap();
    assert_tight(&storage, &db);
    let mut db = reopen(&storage);
    check_all(&mut db, &model, &mut rng, 40);

    // Many deleted rows make a save compact.
    let keys: Vec<f64> = model.rows.iter().step_by(2).map(|r| r.id).collect();
    db.delete(&keys).unwrap();
    model.delete(&keys);
    db.save().unwrap();
    assert_eq!((db.segments(), db.deleted()), (1, 0));
    let mut db = reopen(&storage);
    check_all(&mut db, &model, &mut rng, 40);

    // Deleting everything leaves an empty database that saves and reopens.
    let all: Vec<f64> = model.rows.iter().map(|r| r.id).collect();
    db.delete(&all).unwrap();
    model.delete(&all);
    db.compact().unwrap();
    let mut db = reopen(&storage);
    assert_eq!(db.segments(), 0);
    check_all(&mut db, &model, &mut rng, 10);
}

#[test]
fn a_corrupt_delete_bitmap_is_an_error_when_touched() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(15);
    let rows = issues(&mut rng, 3000, 0);
    let (storage, mut db) = saved(&schema, &rows);
    let before = storage.size().unwrap();
    let keys: Vec<f64> = rows.iter().step_by(7).map(|r| r.id).collect();
    db.delete(&keys).unwrap();
    db.save().unwrap();
    // The delete bitmap is written first, at the end of the file, then the new manifest.
    let mut bytes = storage.to_bytes();
    bytes[before as usize + 12] ^= 0xff;
    let mut db = Db::open(Rc::new(MemStorage::from_bytes(bytes))).unwrap();
    assert_eq!(db.len(), (rows.len() - keys.len()) as u64);
    for _ in 0..2 {
        let err = db
            .query(&Query::default())
            .expect_err("delete bitmap is corrupt");
        assert!(err.to_string().contains("delete bitmap"), "{err}");
        let err = db.get_many_json(&[rows[1].id]).expect_err("corrupt");
        assert!(err.to_string().contains("delete bitmap"), "{err}");
        assert!(db.delete(&[rows[1].id]).is_err());
    }
}

/// A storage that loses power at one write call: that write reaches the file only up to `cut`
/// bytes, and with `shrink` the file's length also falls back to where that cut ends, though
/// never below its length at the last flush (a flush makes the length durable). Every later call
/// fails.
struct Crashy {
    mem: MemStorage,
    crash_at: usize,
    cut: usize,
    shrink: bool,
    floor: Cell<u64>,
    calls: Cell<usize>,
    down: Cell<bool>,
    lens: RefCell<Vec<usize>>,
}

impl Crashy {
    fn new(bytes: Vec<u8>, crash_at: usize, cut: usize, shrink: bool) -> Crashy {
        Crashy {
            floor: Cell::new(bytes.len() as u64),
            mem: MemStorage::from_bytes(bytes),
            crash_at,
            cut,
            shrink,
            calls: Cell::new(0),
            down: Cell::new(false),
            lens: RefCell::default(),
        }
    }

    fn power(&self) -> Result<(), Error> {
        if self.down.get() {
            Err(Error::new("power is off"))
        } else {
            Ok(())
        }
    }
}

impl Storage for Crashy {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<(), Error> {
        self.power()?;
        self.mem.read_at(offset, buf)
    }

    fn write_at(&self, offset: u64, buf: &[u8]) -> Result<(), Error> {
        self.power()?;
        let i = self.calls.get();
        self.calls.set(i + 1);
        self.lens.borrow_mut().push(buf.len());
        if i != self.crash_at {
            return self.mem.write_at(offset, buf);
        }
        let cut = self.cut.min(buf.len());
        self.mem.write_at(offset, &buf[..cut])?;
        if self.shrink {
            let keep = self.floor.get().max(offset + cut as u64);
            if self.mem.size()? > keep {
                self.mem.truncate(keep)?;
            }
        }
        self.down.set(true);
        Err(Error::new("power cut"))
    }

    fn size(&self) -> Result<u64, Error> {
        self.power()?;
        self.mem.size()
    }

    fn truncate(&self, size: u64) -> Result<(), Error> {
        self.power()?;
        let i = self.calls.get();
        self.calls.set(i + 1);
        self.lens.borrow_mut().push(0);
        if i == self.crash_at {
            self.down.set(true);
            return Err(Error::new("power cut"));
        }
        self.mem.truncate(size)
    }

    fn flush(&self) -> Result<(), Error> {
        self.power()?;
        self.floor.set(self.mem.size()?);
        Ok(())
    }
}

/// Live rows, segments and deleted rows, then every row in key order, whole: two databases with
/// equal dumps hold the same state, down to whether it was compacted.
fn dump(db: &mut Db) -> String {
    try_dump(db).unwrap()
}

fn try_dump(db: &mut Db) -> Result<String, Error> {
    let r = db.query(&Query::default())?;
    let Output::Rows(ids) = r.output else {
        unreachable!()
    };
    let keys = db.keys_of(&ids)?;
    let mut out = format!(
        "{} {} {} {}",
        db.len(),
        db.segments(),
        db.deleted(),
        db.get_many_json(&keys)?
    );
    let names: Vec<String> = db
        .schema()
        .columns
        .iter()
        .filter(|c| c.index == plateau_engine::IndexKind::Keys)
        .map(|c| c.name.clone())
        .collect();
    for name in names {
        out.push_str(&format!(
            " {name}:{:?}",
            db.key_scan(&name, b"", None, false, usize::MAX)?
        ));
    }
    Ok(out)
}

/// Byte positions to cut a write of `len` bytes at: both ends, the slot's fields, and a stride
/// through the rest.
fn cuts(len: usize) -> Vec<usize> {
    let mut v = vec![0, 1, 4, 8, 16, 40, 47, 48];
    v.extend((0..len).step_by((len / 48).max(1)));
    v.extend([len / 2, len.saturating_sub(1)]);
    v.retain(|&c| c < len.max(1));
    v.sort_unstable();
    v.dedup();
    v
}

/// Runs `op` on a database opened from `before` (after `prepare`, which makes unsaved changes),
/// once without a crash to learn its writes, then once per (write call, cut, shrink) with the
/// power cut there. After each cut the file must open to exactly the state before `op` or after
/// it, and take a further save. Returns the number of crash points tried.
fn crash_loop(
    schema: &Schema,
    before: &[u8],
    prepare: &dyn Fn(&mut Db),
    op: &dyn Fn(&mut Db) -> Result<(), Error>,
) -> (usize, usize) {
    let old_dump = dump(&mut Db::open(Rc::new(MemStorage::from_bytes(before.to_vec()))).unwrap());
    let clean = Rc::new(Crashy::new(before.to_vec(), usize::MAX, 0, false));
    let mut db = Db::open(clean.clone()).unwrap();
    // Opening and `prepare` write nothing, so every write counted is the operation's.
    prepare(&mut db);
    op(&mut db).unwrap();
    let lens = clean.lens.borrow().clone();
    let new_dump =
        dump(&mut Db::open(Rc::new(MemStorage::from_bytes(clean.mem.to_bytes()))).unwrap());
    assert_ne!(old_dump, new_dump, "the operation changes the state");
    let mut points = 0;
    let mut saw_new = 0;
    for (i, &len) in lens.iter().enumerate() {
        for cut in cuts(len) {
            for shrink in [false, true] {
                let crashy = Rc::new(Crashy::new(before.to_vec(), i, cut, shrink));
                let mut db = Db::open(crashy.clone()).unwrap();
                prepare(&mut db);
                assert!(
                    op(&mut db).is_err(),
                    "write {i} of {} cut at {cut}",
                    lens.len()
                );
                points += 1;
                let after = Rc::new(MemStorage::from_bytes(crashy.mem.to_bytes()));
                let mut db = Db::open(after.clone())
                    .unwrap_or_else(|e| panic!("write {i} cut {cut} shrink {shrink}: {e}"));
                let got = try_dump(&mut db).unwrap_or_else(|e| {
                    panic!("write {i} of {lens:?} cut {cut} shrink {shrink}: {e}")
                });
                if got == new_dump {
                    saw_new += 1;
                } else {
                    assert_eq!(got, old_dump, "write {i} cut {cut} shrink {shrink}");
                }
                // The survivor takes another save over whatever the cut left behind.
                let mut rng = Rng(points as u64);
                let extra = if schema.column("teamId").is_some() {
                    batch(schema, &issues(&mut rng, 3, 700_000))
                } else {
                    key_batch(schema, &key_rows(&mut rng, &[7e5, 7e5 + 1.0, 7e5 + 2.0]))
                };
                db.put(extra).unwrap();
                db.save().unwrap();
                let survivors: u64 = got.split(' ').next().unwrap().parse().unwrap();
                assert_eq!(Db::open(after).unwrap().len(), survivors + 3);
            }
        }
    }
    println!("writes {lens:?}");
    (points, saw_new)
}

#[test]
fn a_save_or_compaction_cut_at_any_write_opens_the_old_or_the_new_state() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(16);
    let layout = Layout {
        chunk_shift: 6,
        pair_block: 32,
        record_shift: 2,
    };
    // Two segments, then a save of deletes only, so the file has a free gap where the first
    // manifest was.
    let (storage, mut db) = new_db_with(&schema, layout);
    let first = issues(&mut rng, 1500, 0);
    let second = issues(&mut rng, 800, 1500);
    db.append(batch(&schema, &first)).unwrap();
    db.save().unwrap();
    db.append(batch(&schema, &second)).unwrap();
    db.save().unwrap();
    db.delete(&[first[0].id, second[0].id]).unwrap();
    db.save().unwrap();
    let start = storage.to_bytes();

    let mut model = Model {
        rows: first.iter().chain(&second).cloned().collect(),
    };
    model.delete(&[first[0].id, second[0].id]);
    let put_rows = replacements(&mut Rng(17), &model, 120, 300_000);
    let del_keys: Vec<f64> = model
        .rows
        .iter()
        .skip(5)
        .step_by(37)
        .map(|r| r.id)
        .collect();
    let prepare = |db: &mut Db| {
        db.put(batch(&schema, &put_rows)).unwrap();
        db.delete(&del_keys).unwrap();
    };
    let save = |db: &mut Db| db.save();
    let (save_points, save_new) = crash_loop(&schema, &start, &prepare, &save);

    // The saved state of that save, then a compaction of it.
    let saved_storage = Rc::new(MemStorage::from_bytes(start.clone()));
    let mut db2 = Db::open(saved_storage.clone()).unwrap();
    prepare(&mut db2);
    db2.save().unwrap();
    let after_save = saved_storage.to_bytes();
    let nothing = |_: &mut Db| {};
    let compact = |db: &mut Db| db.compact();
    let (compact_points, compact_new) = crash_loop(&schema, &after_save, &nothing, &compact);

    // A save after compaction writes into the space the old segments left.
    let compacted_storage = Rc::new(MemStorage::from_bytes(after_save.clone()));
    let mut db3 = Db::open(compacted_storage.clone()).unwrap();
    db3.compact().unwrap();
    let compacted = compacted_storage.to_bytes();
    let more = replacements(&mut Rng(18), &model, 200, 400_000);
    let prepare_more = |db: &mut Db| {
        db.put(batch(&schema, &more)).unwrap();
        db.delete(&del_keys[..10]).unwrap();
    };
    let (reuse_points, reuse_new) = crash_loop(&schema, &compacted, &prepare_more, &save);
    println!(
        "crash points: save {save_points} ({save_new} new), compaction {compact_points} \
         ({compact_new} new), save into freed space {reuse_points} ({reuse_new} new)"
    );
    assert!(save_new > 0 && compact_new > 0 && reuse_new > 0);
}

#[test]
fn rollback_returns_to_the_committed_rows_deletes_and_meta() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(41);
    let first = issues(&mut rng, 2000, 0);
    let (storage, mut db) = new_db(&schema);
    db.append(batch(&schema, &first)).unwrap();
    db.set_meta("gen=1".into());
    db.save().unwrap();
    // Changes on top of a saved segment and of unsaved rows, then dropped.
    let more = issues(&mut rng, 300, 2000);
    let edits = replacements(
        &mut rng,
        &Model {
            rows: first.clone(),
        },
        200,
        5000,
    );
    db.put(batch(&schema, &edits)).unwrap();
    db.append(batch(&schema, &more)).unwrap();
    db.delete(&[1.0, 2.0, 2001.0, 2002.0]).unwrap();
    db.set_meta("gen=99".into());
    db.rollback();
    assert_eq!(db.meta(), "gen=1");
    assert_eq!(db.len(), first.len() as u64);
    let mut q = Rng(3);
    for _ in 0..40 {
        check(&mut db, &first, &random_query(&mut q));
    }
    check_gets(
        &db,
        &Model {
            rows: first.clone(),
        },
        &[1.0, 2.0, 3.0, 2001.0],
    );
    // What follows the rollback commits normally; the dropped changes never reach the file.
    db.delete(&[5.0]).unwrap();
    db.save().unwrap();
    let kept: Vec<Issue> = first.iter().filter(|r| r.id != 5.0).cloned().collect();
    let reopened = reopen(&storage);
    assert_eq!(reopened.meta(), "gen=1");
    assert_holds(storage, &kept);
}

#[test]
fn meta_is_committed_with_saves_and_compactions() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(42);
    let rows = issues(&mut rng, 500, 0);
    let (storage, mut db) = new_db(&schema);
    db.append(batch(&schema, &rows)).unwrap();
    db.set_meta("{\"gen\":7,\"quote\":\"\\\"\"}".into());
    db.save().unwrap();
    assert_eq!(reopen(&storage).meta(), "{\"gen\":7,\"quote\":\"\\\"\"}");
    db.set_meta("after compaction".into());
    db.compact().unwrap();
    let again = reopen(&storage);
    assert_eq!(again.meta(), "after compaction");
    assert_eq!(again.len(), rows.len() as u64);
}

#[test]
fn open_at_an_older_sequence_returns_the_previous_state_and_the_next_save_replaces_the_newer() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let (storage, first, both) = two_states(&schema);
    let newest = reopen(&storage).seq();
    // The group commit that wrote the newest state did not finish: go back one state.
    let mut db = Db::open_at(storage.clone(), newest - 1).unwrap();
    assert_eq!(db.seq(), newest - 1);
    assert_eq!(db.len(), first.len() as u64);
    db.save().unwrap();
    assert_eq!(db.seq(), newest);
    assert_holds(storage.clone(), &first);
    assert!(Db::open_at(storage.clone(), 0).is_err());
    let _ = both;
}

#[test]
fn omit_empty_leaves_empty_strings_out_of_json_rows() {
    let schema = Schema::from_json(
        r#"{"primaryKey":"id","columns":[{"name":"id","kind":"f64"},{"name":"_v","kind":"str","omit_empty":true},{"name":"t","kind":"str"}]}"#,
    )
    .unwrap();
    let (storage, mut db) = new_db(&schema);
    let mut b = Batch::new(&schema, 2);
    b.set(&schema, "id", ColumnData::F64(vec![1.0, 2.0]))
        .unwrap();
    let strs = |a: &str, b: &str| ColumnData::Str {
        offsets: vec![0, a.len() as u32, (a.len() + b.len()) as u32],
        bytes: [a, b].concat().into_bytes(),
    };
    b.set(&schema, "_v", strs("", "rest")).unwrap();
    b.set(&schema, "t", strs("", "x")).unwrap();
    db.append(b).unwrap();
    let want = r#"[{"id":1,"t":""},{"id":2,"_v":"rest","t":"x"}]"#;
    assert_eq!(db.get_many_json(&[1.0, 2.0]).unwrap(), want);
    db.save().unwrap();
    assert_eq!(reopen(&storage).get_many_json(&[1.0, 2.0]).unwrap(), want);
    assert!(
        Schema::from_json(
            r#"{"primaryKey":"id","columns":[{"name":"id","kind":"f64","omit_empty":true}]}"#
        )
        .is_err()
    );
}

const KEYS_SCHEMA: &str = r#"{
  "primaryKey": "id",
  "columns": [
    {"name": "id", "kind": "f64"},
    {"name": "k", "kind": "str", "index": "keys"},
    {"name": "m", "kind": "str", "index": "keys"},
    {"name": "v", "kind": "str"}
  ]
}"#;

#[derive(Clone, Debug)]
struct KeyRow {
    id: f64,
    k: String,
    m: Vec<String>,
}

/// A key unique to its row: a random prefix from a small alphabet, then the row id.
fn key_token(rng: &mut Rng, id: f64) -> String {
    let len = rng.below(4) as usize;
    let p: String = (0..len)
        .map(|_| (b'0' + rng.below(4) as u8) as char)
        .collect();
    format!("{p}_{:06}", id as u64)
}

fn key_rows(rng: &mut Rng, ids: &[f64]) -> Vec<KeyRow> {
    ids.iter()
        .map(|&id| KeyRow {
            id,
            k: key_token(rng, id),
            m: (0..rng.below(4))
                .map(|j| format!("{}{j}", key_token(rng, id)))
                .collect(),
        })
        .collect()
}

fn key_batch(schema: &Schema, rows: &[KeyRow]) -> Batch {
    let strs = |vals: Vec<String>| {
        let mut offsets = vec![0u32];
        let mut bytes = Vec::new();
        for v in vals {
            bytes.extend_from_slice(v.as_bytes());
            offsets.push(bytes.len() as u32);
        }
        ColumnData::Str { offsets, bytes }
    };
    let mut b = Batch::new(schema, rows.len());
    b.set(
        schema,
        "id",
        ColumnData::F64(rows.iter().map(|r| r.id).collect()),
    )
    .unwrap();
    b.set(
        schema,
        "k",
        strs(rows.iter().map(|r| r.k.clone()).collect()),
    )
    .unwrap();
    b.set(
        schema,
        "m",
        strs(rows.iter().map(|r| r.m.join(" ")).collect()),
    )
    .unwrap();
    b.set(
        schema,
        "v",
        strs(rows.iter().map(|r| format!("v{}", r.id)).collect()),
    )
    .unwrap();
    b
}

fn check_keys(db: &Db, model: &[KeyRow], rng: &mut Rng) {
    for col in ["k", "m"] {
        let mut want: Vec<(Vec<u8>, f64)> = model
            .iter()
            .flat_map(|r| {
                let ks: Vec<String> = if col == "k" {
                    vec![r.k.clone()]
                } else {
                    r.m.clone()
                };
                ks.into_iter().map(move |k| (k.into_bytes(), r.id))
            })
            .collect();
        want.sort_by(|a, b| a.0.cmp(&b.0));
        let all = db.key_scan(col, b"", None, false, usize::MAX).unwrap();
        assert_eq!(all, want, "full scan of {col}");
        assert_eq!(db.key_count(col, b"", None).unwrap(), want.len() as u64);
        for _ in 0..20 {
            let bound = |rng: &mut Rng| -> Vec<u8> {
                let len = rng.below(3) as usize;
                (0..len).map(|_| b'0' + rng.below(5) as u8).collect()
            };
            let lo = bound(rng);
            let hi = if rng.below(4) == 0 {
                None
            } else {
                Some(bound(rng))
            };
            let desc = rng.below(2) == 0;
            let limit = [1, 3, 50, usize::MAX][rng.below(4) as usize];
            let mut sel: Vec<(Vec<u8>, f64)> = want
                .iter()
                .filter(|e| e.0.as_slice() >= lo.as_slice() && hi.as_ref().is_none_or(|h| e.0 < *h))
                .cloned()
                .collect();
            let count = sel.len() as u64;
            if desc {
                sel.reverse();
            }
            sel.truncate(limit);
            let got = db.key_scan(col, &lo, hi.as_deref(), desc, limit).unwrap();
            assert_eq!(got, sel, "{col} [{lo:?}, {hi:?}) desc {desc} limit {limit}");
            assert_eq!(db.key_count(col, &lo, hi.as_deref()).unwrap(), count);
        }
    }
    let mut ids: Vec<f64> = model.iter().map(|r| r.id).collect();
    ids.sort_by(f64::total_cmp);
    for _ in 0..10 {
        let lo = rng.below(400) as f64;
        let hi = lo + rng.below(200) as f64;
        let (lo_open, hi_open, desc) = (rng.below(2) == 0, rng.below(2) == 0, rng.below(2) == 0);
        let mut sel: Vec<f64> = ids
            .iter()
            .copied()
            .filter(|&x| {
                (if lo_open { x > lo } else { x >= lo }) && (if hi_open { x < hi } else { x <= hi })
            })
            .collect();
        if desc {
            sel.reverse();
        }
        sel.truncate(7);
        assert_eq!(db.pk_scan(lo, lo_open, hi, hi_open, desc, 7).unwrap(), sel);
    }
}

#[test]
fn keys_indexes_and_pk_scans_match_brute_force_through_puts_deletes_saves_and_reopens() {
    keys_case();
}

fn keys_case() {
    let schema = Schema::from_json(KEYS_SCHEMA).unwrap();
    let mut rng = Rng(77);
    let layout = Layout {
        chunk_shift: 6,
        pair_block: 32,
        record_shift: 2,
    };
    let (storage, mut db) = new_db_with(&schema, layout);
    let mut model: Vec<KeyRow> = Vec::new();
    for round in 0..14 {
        let ids: Vec<f64> = (0..60)
            .map(|_| rng.below(500))
            .collect::<std::collections::BTreeSet<u64>>()
            .into_iter()
            .map(|x| x as f64)
            .collect();
        let rows = key_rows(&mut rng, &ids);
        db.put(key_batch(&schema, &rows)).unwrap();
        model.retain(|r| !ids.contains(&r.id));
        model.extend(rows);
        let gone: Vec<f64> = (0..15).map(|_| rng.below(500) as f64).collect();
        db.delete(&gone).unwrap();
        model.retain(|r| !gone.contains(&r.id));
        check_keys(&db, &model, &mut rng);
        db.enforce_budget();
        match round % 4 {
            0 => db.save().unwrap(),
            1 => {
                db.save().unwrap();
                db = reopen(&storage);
            }
            2 => db.compact().unwrap(),
            _ => {}
        }
        check_keys(&db, &model, &mut rng);
    }
    db.save().unwrap();
    // Thousands of entries: several blocks per segment.
    let ids: Vec<f64> = (1000..4000).map(|x| x as f64).collect();
    let rows = key_rows(&mut rng, &ids);
    db.put(key_batch(&schema, &rows)).unwrap();
    model.extend(rows);
    db.save().unwrap();
    let mut db = reopen(&storage);
    check_keys(&db, &model, &mut rng);
    db.enforce_budget();
    check_keys(&db, &model, &mut rng);
}

#[test]
fn a_save_with_keys_indexes_cut_at_any_write_opens_the_old_or_the_new_state() {
    let schema = Schema::from_json(KEYS_SCHEMA).unwrap();
    let mut rng = Rng(5);
    let layout = Layout {
        chunk_shift: 6,
        pair_block: 32,
        record_shift: 2,
    };
    let (storage, mut db) = new_db_with(&schema, layout);
    let ids: Vec<f64> = (0..700).map(|x| x as f64).collect();
    db.put(key_batch(&schema, &key_rows(&mut rng, &ids)))
        .unwrap();
    db.save().unwrap();
    let start = storage.to_bytes();
    let more = key_rows(&mut rng, &(600..900).map(|x| x as f64).collect::<Vec<_>>());
    let (points, saw_new) = crash_loop(&schema, &start, &|_| {}, &|db| {
        db.put(key_batch(&schema, &more))?;
        db.delete(&[1.0, 2.0, 3.0])?;
        db.save()
    });
    assert!(points > 50 && saw_new > 0, "{points} {saw_new}");
}

/// A memory budget so small that nearly every operation drops loaded sections and the next one
/// reads them again from storage.
const TINY: usize = 48 << 10;

#[test]
fn queries_updates_and_keys_under_a_tiny_memory_budget_match_brute_force() {
    set_memory_budget(TINY);
    for seed in 0..4u64 {
        random_case(seed, seed % 2 == 1);
    }
    for seed in 100..104u64 {
        updates_case(seed);
    }
    keys_case();
    assert_eq!(cached_bytes(), 0, "every database is gone");
}

#[test]
fn a_tiny_budget_drops_and_reloads_sections_and_holds_loaded_bytes_down() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(51);
    let rows = issues(&mut rng, 20_000, 0);
    let (storage, mut db) = saved(&schema, &rows);
    let size = storage.size().unwrap();
    let model = Model { rows };
    set_memory_budget(TINY);
    let mut peak = 0;
    for _ in 0..40 {
        check_all(&mut db, &model, &mut rng, 10);
        peak = peak.max(cached_bytes());
        db.enforce_budget();
        assert!(cached_bytes() <= TINY - TINY / 4, "{}", cached_bytes());
    }
    // The queries touched far more than the budget holds, and read it again after drops.
    assert!(db.loaded().bytes > 2 * size, "{:?} of {size}", db.loaded());
    assert!(peak > TINY, "{peak}");
    // Without a limit the same database keeps what it reads.
    set_memory_budget(usize::MAX);
    check_all(&mut db, &model, &mut rng, 10);
    let read = db.loaded().bytes;
    check_all(&mut db, &model, &mut rng, 10);
    assert!(db.loaded().bytes - read < size / 4);
    assert_eq!(db.cached(), cached_bytes());
}

#[test]
fn a_corrupt_section_dropped_by_the_budget_is_an_error_when_read_again() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(52);
    let rows = issues(&mut rng, 3000, 0);
    let (storage, _) = saved(&schema, &rows);
    let mut db = reopen(&storage);
    let first: serde_json::Value =
        serde_json::from_str(&db.get_many_json(&[rows[0].id]).unwrap()).unwrap();
    // Corrupt the row's record block in the file while it is loaded.
    let bytes = storage.to_bytes();
    let title = rows[0].title.as_bytes();
    let in_record = find(&bytes, title, 8192).unwrap();
    storage
        .write_at(in_record as u64 + 2, &[bytes[in_record + 2] ^ 0xff])
        .unwrap();
    // Loaded, it answers from memory.
    let again: serde_json::Value =
        serde_json::from_str(&db.get_many_json(&[rows[0].id]).unwrap()).unwrap();
    assert_eq!(first, again);
    // Dropped, it is read again, and its checksum fails, every time.
    set_memory_budget(1);
    db.enforce_budget();
    assert_eq!(db.cached(), 0);
    for _ in 0..2 {
        let err = db.get_many_json(&[rows[0].id]).expect_err("corrupt");
        assert!(err.to_string().contains("checksum"), "{err}");
        db.enforce_budget();
    }
}

/// Every byte position (sampled) flipped after a database loaded what its queries need: once
/// the budget drops the loaded sections, each query and get errors or answers exactly right.
#[test]
fn a_byte_flipped_under_loaded_sections_is_caught_when_they_are_read_again() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut rng = Rng(53);
    let rows = issues(&mut rng, 1500, 0);
    let (storage, mut db) = new_db_with(
        &schema,
        Layout {
            chunk_shift: 7,
            pair_block: 64,
            record_shift: 2,
        },
    );
    db.append(batch(&schema, &rows)).unwrap();
    db.save().unwrap();
    let clean = storage.to_bytes();
    let queries: Vec<Query> = (0..12).map(|_| random_query(&mut rng)).collect();
    let keys: Vec<f64> = rows.iter().step_by(97).map(|r| r.id).collect();
    let mut errors = 0;
    for at in (8192..clean.len()).step_by(clean.len() / 400) {
        set_memory_budget(usize::MAX);
        let storage = Rc::new(MemStorage::from_bytes(clean.clone()));
        let mut db = Db::open(storage.clone()).unwrap();
        for q in &queries {
            db.query(q).unwrap();
        }
        db.get_many_json(&keys).unwrap();
        storage.write_at(at as u64, &[clean[at] ^ 0x5a]).unwrap();
        set_memory_budget(1);
        for q in &queries {
            match db.query(q) {
                Err(_) => errors += 1,
                Ok(got) => match (brute(&rows, q), got.output) {
                    (Expected::Count(e), Output::Count(g)) => assert_eq!(e, g, "byte {at} {q:?}"),
                    (Expected::Keys(e), Output::Rows(g)) => match db.keys_of(&g) {
                        Ok(k) => assert_eq!(e, k, "byte {at} {q:?} plan {}", got.plan),
                        Err(_) => errors += 1,
                    },
                    _ => panic!("output kind differs"),
                },
            }
        }
        db.enforce_budget();
        match db.get_many_json(&keys) {
            Err(_) => errors += 1,
            Ok(json) => {
                let got: serde_json::Value = serde_json::from_str(&json).unwrap();
                for (k, v) in keys.iter().zip(got.as_array().unwrap()) {
                    let r = rows.iter().find(|r| r.id == *k).unwrap();
                    assert_eq!(v["id"].as_f64(), Some(r.id), "byte {at}");
                    assert_eq!(v["title"].as_str(), Some(r.title.as_str()), "byte {at}");
                }
            }
        }
    }
    assert!(errors > 50, "corruption was detected {errors} times");
}

/// After every commit a file holds little beyond what its committed state uses.
fn assert_tight(storage: &MemStorage, db: &Db) {
    let (size, used) = (storage.size().unwrap(), db.used_bytes());
    assert!(
        size <= used + used / 10 + (16 << 10),
        "file {size}, used {used}"
    );
}

/// A compacted file, then a fifth of its rows deleted and saved: it has no free space a
/// compaction fits in, so a compaction goes after it and then moves back (`Db::tidy`).
fn compactable_into_free_space(schema: &Schema) -> (Vec<u8>, Model) {
    let mut rng = Rng(61);
    let layout = Layout {
        chunk_shift: 6,
        pair_block: 32,
        record_shift: 2,
    };
    let (storage, mut db) = new_db_with(schema, layout);
    let first = issues(&mut rng, 1200, 0);
    let second = issues(&mut rng, 600, 1200);
    db.append(batch(schema, &first)).unwrap();
    db.save().unwrap();
    db.append(batch(schema, &second)).unwrap();
    db.save().unwrap();
    db.compact().unwrap();
    let mut model = Model {
        rows: first.iter().chain(&second).cloned().collect(),
    };
    let gone: Vec<f64> = model.rows.iter().step_by(5).map(|r| r.id).collect();
    db.delete(&gone).unwrap();
    model.delete(&gone);
    db.save().unwrap();
    (storage.to_bytes(), model)
}

#[test]
fn a_compaction_past_the_end_moves_back_and_the_file_is_cut() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let (start, model) = compactable_into_free_space(&schema);
    let storage = Rc::new(MemStorage::from_bytes(start.clone()));
    let mut db = Db::open(storage.clone()).unwrap();
    assert_tight(&storage, &db);
    db.compact().unwrap();
    let after = storage.size().unwrap();
    assert!(
        after * 10 < start.len() as u64 * 9,
        "{after} of {}",
        start.len()
    );
    assert_tight(&storage, &db);
    let mut rng = Rng(62);
    check_all(&mut db, &model, &mut rng, 30);
    let mut db = Db::open(storage).unwrap();
    check_all(&mut db, &model, &mut rng, 30);
}

#[test]
fn a_compaction_past_the_end_and_its_move_back_cut_at_any_write_open_the_old_or_the_new_state() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let (start, _) = compactable_into_free_space(&schema);
    let compact = |db: &mut Db| db.compact();
    let (points, saw_new) = crash_loop(&schema, &start, &|_| {}, &compact);
    println!("crash points: compaction past the end, move back and cut {points} ({saw_new} new)");
    assert!(points > 100 && saw_new > 0, "{points} {saw_new}");
}

#[test]
fn keeping_the_previous_state_lets_open_at_return_to_it_after_a_compaction_cut_the_file() {
    let schema = Schema::from_json(SCHEMA).unwrap();
    let (start, model) = compactable_into_free_space(&schema);
    let before = Db::open(Rc::new(MemStorage::from_bytes(start.clone())))
        .unwrap()
        .seq();
    for keep in [false, true] {
        let storage = Rc::new(MemStorage::from_bytes(start.clone()));
        let mut db = Db::open(storage.clone()).unwrap();
        db.set_keep_previous(keep);
        db.compact().unwrap();
        let old = Db::open_at(storage.clone(), before);
        if keep {
            let mut old = old.unwrap();
            assert!(old.deleted() > 0, "the state before compaction");
            check_all(&mut old, &model, &mut Rng(63), 10);
            db.set_keep_previous(false);
            db.release_previous().unwrap();
            assert_tight(&storage, &db);
            assert!((storage.size().unwrap() as usize) < start.len());
        } else {
            // The previous state's bytes were cut with the free tail.
            assert!(
                old.is_err_and(|e| !e.0.is_empty()) || {
                    let mut old = Db::open_at(storage.clone(), before).unwrap();
                    try_dump(&mut old).is_err()
                }
            );
        }
    }
}
