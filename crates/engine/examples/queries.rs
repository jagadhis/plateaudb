//! Native engine-only timings for the M0 query shapes, without a browser or a thread hop.
//! The browser benchmark in `packages/bench` is the measurement of record; this is for
//! looking inside the engine. `cargo run --release --example queries -- 1000000`

use plateau_engine::{Batch, ColumnData, Db, MemStorage, Schema};
use std::rc::Rc;
use std::time::Instant;

const SCHEMA: &str = r#"{"primaryKey":"id","columns":[
  {"name":"id","kind":"f64"},
  {"name":"teamId","kind":"u32","index":"bitmap"},
  {"name":"stateId","kind":"u32","index":"bitmap"},
  {"name":"assigneeId","kind":"u32","index":"bitmap"},
  {"name":"labelIds","kind":"u32_multi","index":"bitmap"},
  {"name":"priority","kind":"u32","index":"bitmap"},
  {"name":"createdAt","kind":"f64"},
  {"name":"updatedAt","kind":"f64","index":"ordered","group":"teamId"},
  {"name":"title","kind":"str"}]}"#;

/// Rows with these ids and random fields.
fn rows(schema: &Schema, ids: &[f64], recent: bool, rnd: &mut impl FnMut(u64) -> u64) -> Batch {
    let n = ids.len();
    let day = 86_400_000.0;
    let t0 = 1_767_225_600_000.0;
    let (mut team, mut state, mut assignee, mut prio, mut created, mut updated) =
        (vec![], vec![], vec![], vec![], vec![], vec![]);
    let (mut lo, mut lv, mut to, mut tb) = (vec![0u32], vec![], vec![0u32], vec![]);
    for (i, &id) in ids.iter().enumerate() {
        let t = rnd(20) as u32;
        team.push(t);
        state.push(t * 6 + rnd(6) as u32);
        assignee.push(rnd(200) as u32);
        for _ in 0..rnd(4) {
            lv.push(rnd(50) as u32);
        }
        let row = &mut lv[lo[i] as usize..];
        row.sort_unstable();
        let mut k = 0;
        for j in 0..row.len() {
            if j == 0 || row[j] != row[k - 1] {
                row[k] = row[j];
                k += 1;
            }
        }
        lv.truncate(lo[i] as usize + k);
        lo.push(lv.len() as u32);
        prio.push(rnd(5) as u32);
        let c = t0 - rnd(730) as f64 * day - rnd(86_400_000) as f64;
        created.push(c);
        updated.push(if recent {
            (t0 - rnd(30 * 86_400_000) as f64).max(c)
        } else {
            c + rnd((t0 - c) as u64 + 1) as f64
        });
        tb.extend_from_slice(format!("Issue {id}: sync crash login").as_bytes());
        to.push(tb.len() as u32);
    }
    let mut b = Batch::new(schema, n);
    let mut set = |name: &str, d| b.set(schema, name, d).unwrap();
    set("id", ColumnData::F64(ids.to_vec()));
    set("teamId", ColumnData::U32(team));
    set("stateId", ColumnData::U32(state));
    set("assigneeId", ColumnData::U32(assignee));
    set(
        "labelIds",
        ColumnData::U32Multi {
            offsets: lo,
            values: lv,
        },
    );
    set("priority", ColumnData::U32(prio));
    set("createdAt", ColumnData::F64(created));
    set("updatedAt", ColumnData::F64(updated));
    set(
        "title",
        ColumnData::Str {
            offsets: to,
            bytes: tb,
        },
    );
    b
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .map_or(1_000_000, |s| s.parse().unwrap());
    let schema = Schema::from_json(SCHEMA).unwrap();
    let mut s = 0x2545_F491_4F6C_DD1Du64;
    let mut rnd = |m: u64| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s % m
    };
    let day = 86_400_000.0;
    let t0 = 1_767_225_600_000.0;
    let ids: Vec<f64> = (1..=n).map(|i| i as f64).collect();
    let b = rows(&schema, &ids, false, &mut rnd);
    let storage = Rc::new(MemStorage::new());
    let mut db = Db::create(storage.clone(), schema.clone()).unwrap();
    let t = Instant::now();
    db.append(b).unwrap();
    println!("append {n}: {:?}", t.elapsed());

    let queries = [
        ("q1", r#"{"where":[{"field":"teamId","op":"eq","value":3},{"field":"stateId","op":"in","values":[19,22]}],"orderBy":{"field":"updatedAt","desc":true},"limit":50}"#.to_string()),
        ("q2", r#"{"where":[{"field":"assigneeId","op":"eq","value":17},{"field":"labelIds","op":"eq","value":7},{"field":"priority","op":"range","lte":2}]}"#.to_string()),
        ("q3", format!(r#"{{"where":[{{"field":"teamId","op":"eq","value":5}},{{"field":"updatedAt","op":"range","gt":{}}}],"count":true}}"#, t0 - 30.0 * day)),
        ("q4", r#"{"where":[{"field":"teamId","op":"eq","value":3},{"field":"stateId","op":"in","values":[19,22]},{"field":"priority","op":"range","lte":2}],"orderBy":{"field":"updatedAt","desc":true},"limit":50}"#.to_string()),
    ];
    let keys: Vec<f64> = (0..1000).map(|_| (1 + rnd(n as u64)) as f64).collect();
    let warm = |db: &mut Db, part: &str| {
        for (name, q) in &queries {
            let reps = 200;
            let mut json = db.query_json(q).unwrap();
            let t = Instant::now();
            for _ in 0..reps {
                json = db.query_json(q).unwrap();
            }
            let plan = &json[..json.find(",\"").unwrap_or(json.len())];
            println!(
                "{name} warm {part}: {:?}/query incl. JSON ({} bytes)  {plan}",
                t.elapsed() / reps,
                json.len()
            );
        }
        db.get_many_json(&keys).unwrap();
        let reps = 50;
        let t = Instant::now();
        for _ in 0..reps {
            db.get_many_json(&keys).unwrap();
        }
        println!("1000 gets warm {part}: {:?}", t.elapsed() / reps);
    };
    warm(&mut db, "delta");

    let t = Instant::now();
    db.save().unwrap();
    println!("save {n}: {:?}", t.elapsed());
    for (name, q) in &queries {
        let t = Instant::now();
        let mut cold = Db::open(storage.clone()).unwrap();
        let opened = t.elapsed();
        cold.query_json(q).unwrap();
        println!(
            "{name} cold: open {opened:?}, open + query {:?}, read {:?}",
            t.elapsed(),
            cold.loaded()
        );
    }
    warm(&mut db, "segment");

    // Replace 1% of the rows (an edit: updatedAt in the last 30 days) and delete another 1%, then
    // save; then compact.
    let replaced: Vec<f64> = (1..=n).step_by(100).map(|i| i as f64).collect();
    let deleted: Vec<f64> = (51..=n).step_by(100).map(|i| i as f64).collect();
    // Two commits, as the browser bench makes them: 1,000 of each, then the rest.
    let t = Instant::now();
    for (from, to) in [
        (0, 1000.min(replaced.len())),
        (1000.min(replaced.len()), replaced.len()),
    ] {
        let b = rows(&schema, &replaced[from..to], true, &mut rnd);
        let t = Instant::now();
        db.put(b).unwrap();
        let put = t.elapsed();
        db.delete(&deleted[from..to]).unwrap();
        let del = t.elapsed() - put;
        db.save().unwrap();
        println!(
            "put {} + delete {} + save: {:?} (put {put:?}, delete {del:?})",
            to - from,
            to - from,
            t.elapsed()
        );
    }
    println!("updates: {:?}", t.elapsed());
    warm(&mut db, "after updates");
    let t = Instant::now();
    let mut reopened = Db::open(storage.clone()).unwrap();
    reopened.query_json(&queries[0].1).unwrap();
    println!("q1 cold after updates: open + query {:?}", t.elapsed());
    let t = Instant::now();
    db.compact().unwrap();
    println!("compact: {:?}", t.elapsed());
    warm(&mut db, "after compaction");
}
