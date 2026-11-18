//! Query entry point: AND of filters (equality, IN, range), optional order and limit, or count.
//! `run` plans and runs a query on one part (the delta or a segment); `Db` merges the parts.
//!
//! Planning, in order:
//! 0. `orderBy` on an ordered field grouped by `g` with equality on `g` walks group `g`'s list
//!    (`group_walk`): it holds exactly the rows passing that filter, in order, so the walk reads
//!    only what it returns plus the rows it skips. Other filters are checked per row, by bitmap
//!    membership where they have a bitmap index.
//! 1. Every filter on a bitmap-indexed field (or the primary key) becomes a bitmap of row ids.
//!    The bitmaps are intersected smallest first; this is where multi-key queries win. Sizes come
//!    from the bitmap directory, so a bitmap that is not intersected is never loaded. A bitmap
//!    much larger than the candidate set is checked per candidate instead, by membership.
//! 2. A range on an ordered-indexed field is sized exactly by binary search. It is applied as a
//!    per-row check when the candidate set is smaller than the range, and materialized into a
//!    bitmap otherwise.
//! 3. `orderBy` + `limit` on an ordered-indexed field either walks the index from the end and
//!    keeps rows that are in the candidate set (expected cost `limit / selectivity`, flat in the
//!    table size) or sorts the candidates (cost `|candidates|`), whichever is estimated cheaper.

use crate::Error;
use crate::dead::Tombstones;
use crate::key::f64_key;
use crate::part::Part;
use crate::schema::{IndexKind, Kind};
use roaring::RoaringBitmap;
use serde::Deserialize;
use std::borrow::Cow;
use std::cmp::Ordering;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    #[serde(default, rename = "where")]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub order_by: Option<OrderBy>,
    #[serde(default)]
    pub limit: Option<u32>,
    /// Return only the number of matching rows; `orderBy` and `limit` are ignored.
    #[serde(default)]
    pub count: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Filter {
    pub field: String,
    #[serde(flatten)]
    pub cond: Cond,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Cond {
    Eq {
        value: f64,
    },
    In {
        values: Vec<f64>,
    },
    Range {
        #[serde(default)]
        gt: Option<f64>,
        #[serde(default)]
        gte: Option<f64>,
        #[serde(default)]
        lt: Option<f64>,
        #[serde(default)]
        lte: Option<f64>,
    },
}

#[derive(Clone, Debug, Deserialize)]
pub struct OrderBy {
    pub field: String,
    #[serde(default)]
    pub desc: bool,
}

/// A row of the database: which part (segment, or the delta after the last segment) and the row
/// id inside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowId {
    pub(crate) part: u32,
    pub(crate) row: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Output {
    Count(u64),
    /// Rows in result order.
    Rows(Vec<RowId>),
}

#[derive(Clone, Debug)]
pub struct QueryResult {
    pub output: Output,
    /// Which access paths the planner chose, for benchmark records and debugging.
    pub plan: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PartOutput {
    Count(u64),
    /// Row ids local to the part, in result order.
    Rows(Vec<u32>),
}

pub(crate) struct PartResult {
    pub output: PartOutput,
    pub plan: String,
    /// With `orderBy`: the order key of each returned row (`f64_key` of a number, a `u32` as
    /// is), so merging parts reads no column.
    pub keys: Vec<u64>,
}

/// A filter normalized against its column's kind.
#[derive(Clone, Debug)]
pub(crate) enum Test {
    /// Sorted, deduplicated. Empty matches nothing.
    U32Set(Vec<u32>),
    /// Inclusive.
    U32Range(u32, u32),
    /// Sorted `f64_key`s.
    F64Set(Vec<u64>),
    /// Inclusive `f64_key` bounds.
    F64Range(u64, u64),
}

impl Test {
    fn none() -> Test {
        Test::U32Set(Vec::new())
    }

    fn for_u32(cond: &Cond) -> Test {
        fn exact(v: f64) -> Option<u32> {
            (v.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&v)).then_some(v as u32)
        }
        match cond {
            Cond::Eq { value } => Test::U32Set(exact(*value).into_iter().collect()),
            Cond::In { values } => {
                let mut v: Vec<u32> = values.iter().filter_map(|&x| exact(x)).collect();
                v.sort_unstable();
                v.dedup();
                Test::U32Set(v)
            }
            Cond::Range { gt, gte, lt, lte } => {
                let bounds = [gt, gte, lt, lte];
                if bounds.iter().any(|b| b.is_some_and(f64::is_nan)) {
                    return Test::none();
                }
                let mut lo = 0.0f64;
                let mut hi = u32::MAX as f64;
                if let Some(x) = gte {
                    lo = lo.max(x.ceil());
                }
                if let Some(x) = gt {
                    lo = lo.max(x.floor() + 1.0);
                }
                if let Some(x) = lte {
                    hi = hi.min(x.floor());
                }
                if let Some(x) = lt {
                    hi = hi.min(x.ceil() - 1.0);
                }
                if lo > hi {
                    Test::none()
                } else {
                    Test::U32Range(lo as u32, hi as u32)
                }
            }
        }
    }

    fn for_f64(cond: &Cond) -> Test {
        match cond {
            Cond::Eq { value } if value.is_nan() => Test::none(),
            Cond::Eq { value } => Test::F64Set(vec![f64_key(*value)]),
            Cond::In { values } => {
                let mut v: Vec<u64> = values
                    .iter()
                    .filter(|x| !x.is_nan())
                    .map(|&x| f64_key(x))
                    .collect();
                v.sort_unstable();
                v.dedup();
                Test::F64Set(v)
            }
            Cond::Range { gt, gte, lt, lte } => {
                let bounds = [gt, gte, lt, lte];
                if bounds.iter().any(|b| b.is_some_and(f64::is_nan)) {
                    return Test::none();
                }
                let mut lo = 0u64;
                let mut hi = u64::MAX;
                if let Some(x) = gte {
                    lo = lo.max(f64_key(*x));
                }
                if let Some(x) = gt {
                    match f64_key(*x).checked_add(1) {
                        Some(k) => lo = lo.max(k),
                        None => return Test::none(),
                    }
                }
                if let Some(x) = lte {
                    hi = hi.min(f64_key(*x));
                }
                if let Some(x) = lt {
                    match f64_key(*x).checked_sub(1) {
                        Some(k) => hi = hi.min(k),
                        None => return Test::none(),
                    }
                }
                if lo > hi {
                    Test::none()
                } else {
                    Test::F64Range(lo, hi)
                }
            }
        }
    }

    fn is_none(&self) -> bool {
        matches!(self, Test::U32Set(v) if v.is_empty())
            || matches!(self, Test::F64Set(v) if v.is_empty())
    }

    #[inline]
    fn u32_ok(&self, v: u32) -> bool {
        match self {
            Test::U32Set(set) => set.binary_search(&v).is_ok(),
            Test::U32Range(lo, hi) => (*lo..=*hi).contains(&v),
            _ => false,
        }
    }

    #[inline]
    fn key_ok(&self, k: u64) -> bool {
        match self {
            Test::F64Set(set) => set.binary_search(&k).is_ok(),
            Test::F64Range(lo, hi) => (*lo..=*hi).contains(&k),
            _ => false,
        }
    }
}

fn bitmap_from_unsorted(mut rows: Vec<u32>) -> RoaringBitmap {
    rows.sort_unstable();
    rows.dedup();
    RoaringBitmap::from_sorted_iter(rows).expect("sorted and deduplicated")
}

/// An ordered-index range kept for after the bitmaps are intersected.
struct OrderedRange {
    col: usize,
    test: Test,
    start: usize,
    end: usize,
}

/// Cost of one ordered-index walk step (bitmap probe) relative to one candidate visited when sorting.
const WALK_STEP_COST: f64 = 2.0;

/// Candidate rows sampled to measure how many pass the per-row checks.
const SAMPLE: u64 = 64;

/// A bitmap filter larger than this many times the candidate set is checked per row instead.
/// Roaring intersects two bitmaps in about the time a membership lookup per candidate takes, so
/// only a much larger filter is cheaper to check per row (Q2 at 1M rows: 34 us intersecting the
/// label bitmap against 80 us looking each of 5,033 candidates up in it).
const LATE_FACTOR: u64 = 8;

/// A filter that yields a bitmap: built now (`ready`) or on demand from a bitmap index.
struct Source {
    col: usize,
    est: u64,
    test: Test,
    ready: Option<RoaringBitmap>,
}

/// Most bitmaps a filter may select and still be checked by bitmap membership; past this, a
/// column read per row is cheaper than a lookup per bitmap.
const MAX_MEMBER: usize = 4;

/// How a residual filter is checked per row.
enum How {
    /// Read the row's column value.
    Column,
    /// Look the row up in the filter's bitmaps; nothing is read per row.
    Member,
    /// Look the row up in a bitmap built while planning.
    Ready(RoaringBitmap),
}

/// A filter checked per candidate row, with the fraction of rows it is expected to keep.
struct Residual {
    col: usize,
    test: Test,
    selectivity: f64,
    how: How,
}

impl Residual {
    fn column(col: usize, test: Test, selectivity: f64) -> Residual {
        Residual {
            col,
            test,
            selectivity,
            how: How::Column,
        }
    }

    /// A residual on a bitmap-indexed column: membership when it selects few bitmaps.
    fn bitmap<P: Part>(p: &P, col: usize, test: Test, selectivity: f64) -> Residual {
        let how = if p.bitmap_count(col, &test) <= MAX_MEMBER {
            How::Member
        } else {
            How::Column
        };
        Residual {
            col,
            test,
            selectivity,
            how,
        }
    }

    fn label(&self, schema: &crate::schema::Schema, est: impl std::fmt::Display) -> String {
        let name = &schema.columns[self.col].name;
        match self.how {
            How::Column => format!("check:{name}:{est}"),
            How::Member | How::Ready(_) => format!("member:{name}:{est}"),
        }
    }
}

/// A residual filter bound to its column's kind or its bitmaps, so the per-row check is one
/// column load and a compare, or a bitmap lookup.
enum Check<'a> {
    Column {
        col: usize,
        kind: Kind,
        test: &'a Test,
    },
    Member(Vec<&'a RoaringBitmap>),
}

impl<'a> Check<'a> {
    fn new<P: Part>(p: &'a P, r: &'a Residual) -> Check<'a> {
        match &r.how {
            How::Column => Check::Column {
                col: r.col,
                kind: p.schema().columns[r.col].kind,
                test: &r.test,
            },
            How::Member => Check::Member(p.bitmaps(r.col, &r.test)),
            How::Ready(b) => Check::Member(vec![b]),
        }
    }

    #[inline]
    fn ok<P: Part>(&self, p: &P, row: u32) -> bool {
        match self {
            Check::Member(bitmaps) => bitmaps.iter().any(|b| b.contains(row)),
            Check::Column { col, kind, test } => match kind {
                Kind::U32 => test.u32_ok(p.u32_at(*col, row)),
                Kind::F64 => test.key_ok(f64_key(p.f64_at(*col, row))),
                Kind::U32Multi => p.multi_at(*col, row).iter().any(|&v| test.u32_ok(v)),
                Kind::Str => false,
            },
        }
    }
}

pub(crate) fn col<P: Part>(p: &P, name: &str) -> Result<usize, Error> {
    p.schema()
        .column(name)
        .ok_or_else(|| Error::new(format!("no column {name}")))
}

/// A row's key in the `orderBy` column `order` (column and kind), as plans report it: `f64_key`
/// of a number, a `u32` as is; 0 without an order.
#[inline]
pub(crate) fn order_key<P: Part>(p: &P, order: Option<(usize, Kind)>, row: u32) -> u64 {
    match order {
        Some((c, Kind::U32)) => p.u32_at(c, row) as u64,
        Some((c, _)) => f64_key(p.f64_at(c, row)),
        None => 0,
    }
}

/// Plans and runs a query on one part, leaving out the rows in `dead`. A delta's ordered indexes
/// must be built.
pub(crate) fn run<P: Part>(
    p: &P,
    q: &Query,
    dead: Option<&Tombstones>,
) -> Result<PartResult, Error> {
    let dead = dead.filter(|d| !d.is_empty());
    let mut r = run_live(p, q, dead)?;
    if let Some(d) = dead {
        r.plan = format!("deleted:{} {}", d.rows.len(), r.plan);
    }
    Ok(r)
}

fn run_live<P: Part>(p: &P, q: &Query, dead: Option<&Tombstones>) -> Result<PartResult, Error> {
    let dead_rows = dead.map(|d| &d.rows);
    let alive = |row: u32| dead.is_none_or(|d| !d.contains(row));
    if let Some(count) = grouped_count(p, q, dead)? {
        return Ok(PartResult {
            output: PartOutput::Count(count),
            plan: "grouped-count".into(),
            keys: Vec::new(),
        });
    }
    if let Some(r) = group_walk(p, q, alive)? {
        return Ok(r);
    }
    let schema = p.schema();
    let n = p.len();
    let mut plan: Vec<String> = Vec::new();
    let mut sources: Vec<Source> = Vec::new();
    let mut ranges: Vec<OrderedRange> = Vec::new();
    let mut residual: Vec<Residual> = Vec::new();

    let order = if q.count { None } else { q.order_by.as_ref() };
    let order_col = match order {
        Some(o) => Some(col(p, &o.field)?),
        None => None,
    };

    for f in &q.filters {
        let c = col(p, &f.field)?;
        let def = &schema.columns[c];
        let test = match def.kind {
            Kind::U32 | Kind::U32Multi => Test::for_u32(&f.cond),
            Kind::F64 => Test::for_f64(&f.cond),
            Kind::Str => {
                return Err(Error::new(format!(
                    "cannot filter on string column {}",
                    def.name
                )));
            }
        };
        if test.is_none() {
            plan.push(format!("empty:{}", def.name));
            let output = if q.count {
                PartOutput::Count(0)
            } else {
                PartOutput::Rows(Vec::new())
            };
            return Ok(PartResult {
                output,
                plan: plan.join(" "),
                keys: Vec::new(),
            });
        }
        if c == p.pk_col() {
            let mut rows = Vec::new();
            match &test {
                Test::F64Set(keys) => rows.extend(keys.iter().filter_map(|&k| p.pk_get(k))),
                Test::F64Range(lo, hi) => p.pk_range(*lo, *hi, &mut rows),
                _ => unreachable!("primary key is f64"),
            }
            let b = bitmap_from_unsorted(rows);
            sources.push(Source {
                col: c,
                est: b.len(),
                test,
                ready: Some(b),
            });
            continue;
        }
        match def.index {
            IndexKind::Bitmap => {
                let est = p.bitmap_estimate(c, &test);
                sources.push(Source {
                    col: c,
                    est,
                    test,
                    ready: None,
                });
            }
            IndexKind::Ordered => match test {
                Test::F64Range(lo, hi) => {
                    let (start, end) = p.ordered_bounds(c, lo, hi);
                    ranges.push(OrderedRange {
                        col: c,
                        test,
                        start,
                        end,
                    });
                }
                Test::F64Set(ref keys) => {
                    let mut rows = Vec::new();
                    for &k in keys {
                        let (s, e) = p.ordered_bounds(c, k, k);
                        p.ordered_rows(c, s, e, &mut rows);
                    }
                    let b = bitmap_from_unsorted(rows);
                    sources.push(Source {
                        col: c,
                        est: b.len(),
                        test,
                        ready: Some(b),
                    });
                }
                _ => unreachable!("ordered index on an f64 column"),
            },
            IndexKind::None => residual.push(Residual::column(c, test, 0.5)),
            IndexKind::Keys => unreachable!("keys indexes are on str columns, which never filter"),
        }
    }

    // 1. Intersect bitmaps, smallest first. A filter much larger than the running candidate
    //    set is cheaper to check per candidate than to build and intersect.
    sources.sort_by_key(|s| s.est);
    let mut cand: Option<Cow<'_, RoaringBitmap>> = None;
    let mut and: Vec<String> = Vec::new();
    for s in sources {
        let name = &schema.columns[s.col].name;
        if let Some(c) = &cand {
            if c.is_empty() {
                break;
            }
            if s.est > LATE_FACTOR * c.len() {
                let selectivity = s.est as f64 / n.max(1) as f64;
                let r = match s.ready {
                    Some(b) => Residual {
                        col: s.col,
                        test: s.test,
                        selectivity,
                        how: How::Ready(b),
                    },
                    None => Residual::bitmap(p, s.col, s.test, selectivity),
                };
                plan.push(r.label(schema, s.est));
                residual.push(r);
                continue;
            }
        }
        and.push(format!("{name}:{}", s.est));
        let b: Cow<'_, RoaringBitmap> = match s.ready {
            Some(b) => Cow::Owned(b),
            None => p.bitmap(s.col, &s.test),
        };
        cand = Some(match cand {
            None => b,
            Some(acc) => {
                let mut acc = acc.into_owned();
                acc &= b.as_ref();
                Cow::Owned(acc)
            }
        });
    }
    if !and.is_empty() {
        plan.insert(0, format!("and[{}]", and.join(",")));
    }

    // 2. Ordered ranges: check per row, or materialize, or keep as the walk's bounds.
    ranges.sort_by_key(|r| r.end - r.start);
    let mut walk_bounds: Option<(usize, usize)> = None;
    for r in ranges {
        let size = (r.end - r.start) as u64;
        let name = &schema.columns[r.col].name;
        let selectivity = size as f64 / n.max(1) as f64;
        if Some(r.col) == order_col && walk_bounds.is_none() {
            walk_bounds = Some((r.start, r.end));
            // Also checked per row: a later range may still make the sort path win. The walk's
            // bounds already apply it, so it does not lower the walk's estimated selectivity.
            residual.push(Residual::column(r.col, r.test, 1.0));
            plan.push(format!("bound:{name}:{size}"));
            continue;
        }
        match &cand {
            Some(c) if c.len() <= size => {
                plan.push(format!("check:{name}:{size}"));
                residual.push(Residual::column(r.col, r.test, selectivity));
            }
            _ => {
                plan.push(format!("range:{name}:{size}"));
                let mut rows = Vec::with_capacity(size as usize);
                p.ordered_rows(r.col, r.start, r.end, &mut rows);
                let b = bitmap_from_unsorted(rows);
                cand = Some(Cow::Owned(match cand {
                    None => b,
                    Some(acc) => {
                        let mut acc = acc.into_owned();
                        acc &= b;
                        acc
                    }
                }));
            }
        }
    }

    // Most selective checks first, each bound to its column.
    residual.sort_by(|a, b| a.selectivity.total_cmp(&b.selectivity));
    let residual_selectivity: f64 = residual.iter().map(|r| r.selectivity).product();
    let checks: Vec<Check<'_>> = residual.iter().map(|r| Check::new(p, r)).collect();
    let check = |row: u32| alive(row) && checks.iter().all(|c| c.ok(p, row));
    let cand: Option<&RoaringBitmap> = cand.as_deref();
    // Filters are often correlated (a state belongs to one team), so the product of
    // per-filter selectivities can be far off. Measure the checks on a stride sample instead.
    let residual_selectivity = match cand {
        Some(c) if !checks.is_empty() && !c.is_empty() => {
            let m = c.len().min(SAMPLE);
            let pass = (0..m)
                .filter_map(|i| c.select((i * c.len() / m) as u32))
                .filter(|&r| check(r))
                .count();
            (pass as f64).max(0.5) / m as f64
        }
        _ => residual_selectivity,
    };

    if q.count {
        let count = match (cand, checks.is_empty()) {
            (Some(c), true) => c.len() - dead_rows.map_or(0, |d| c.intersection_len(d)),
            (None, true) => n as u64 - dead_rows.map_or(0, RoaringBitmap::len),
            (Some(c), false) => c.iter().filter(|&r| check(r)).count() as u64,
            (None, false) => (0..n).filter(|&r| check(r)).count() as u64,
        };
        plan.push("count".into());
        return Ok(PartResult {
            output: PartOutput::Count(count),
            plan: plan.join(" "),
            keys: Vec::new(),
        });
    }

    let limit = q.limit.map_or(usize::MAX, |l| l as usize);
    if limit == 0 {
        return Ok(PartResult {
            output: PartOutput::Rows(Vec::new()),
            plan: plan.join(" "),
            keys: Vec::new(),
        });
    }

    let mut keys = Vec::new();
    let rows = match (order, order_col) {
        (Some(o), Some(c)) if schema.columns[c].index == IndexKind::Ordered => {
            let (start, end) = walk_bounds.unwrap_or((0, p.ordered_len(c)));
            let span = end - start;
            let cand_len = cand.map_or(span as u64, RoaringBitmap::len) as f64;
            let selectivity = (cand_len / n.max(1) as f64) * residual_selectivity;
            let walk_est = if selectivity > 0.0 {
                (limit as f64 / selectivity).min(span as f64)
            } else {
                span as f64
            };
            if cand.is_none() || walk_est * WALK_STEP_COST < cand_len {
                let mut steps = 0usize;
                let mut out = Vec::with_capacity(limit.min(1024));
                p.ordered_walk(c, start, end, o.desc, |row: u32, key: u64| {
                    steps += 1;
                    if cand.is_none_or(|c| c.contains(row)) && check(row) {
                        out.push(row);
                        keys.push(key);
                    }
                    out.len() < limit
                });
                plan.push(format!(
                    "walk:{}:{}:steps={steps}",
                    o.field,
                    if o.desc { "desc" } else { "asc" }
                ));
                out
            } else {
                plan.push(format!("sort:{}:{}", o.field, cand_len as u64));
                sorted(p, cand, &check, limit, o.desc, &mut keys, |r| {
                    f64_key(p.f64_at(c, r))
                })
            }
        }
        (Some(o), Some(c)) => {
            plan.push(format!("sort:{}", o.field));
            match schema.columns[c].kind {
                Kind::U32 => sorted(p, cand, &check, limit, o.desc, &mut keys, |r| {
                    p.u32_at(c, r) as u64
                }),
                Kind::F64 => sorted(p, cand, &check, limit, o.desc, &mut keys, |r| {
                    f64_key(p.f64_at(c, r))
                }),
                _ => return Err(Error::new(format!("cannot order by {}", o.field))),
            }
        }
        _ => {
            // No order: primary key order, as IndexedDB returns.
            match cand {
                None => {
                    plan.push("scan:pk".into());
                    let mut out = Vec::new();
                    p.pk_scan(|r| {
                        if check(r) {
                            out.push(r);
                        }
                        out.len() < limit
                    });
                    out
                }
                Some(c) if p.rows_in_pk_order() => {
                    plan.push("rows:pk".into());
                    c.iter().filter(|&r| check(r)).take(limit).collect()
                }
                Some(_) => {
                    plan.push("sort:pk".into());
                    sorted(p, cand, &check, limit, false, &mut keys, |r| p.pk_key(r))
                }
            }
        }
    };
    if order.is_none() {
        keys.clear();
    }
    Ok(PartResult {
        output: PartOutput::Rows(rows),
        plan: plan.join(" "),
        keys,
    })
}

/// `orderBy` on an ordered column grouped by `g`, with equality on `g` and a limit: walks group
/// `g`'s list, which holds exactly the rows passing that filter in the index order, and checks
/// the other filters per row, by bitmap membership where they have a bitmap index. It never takes
/// more steps than the walk of the whole index would, so the only alternative is sorting the
/// candidates: the walk runs when its estimate is cheaper, and gives up for the general planner
/// once it has cost as much as that sort. `None` when the query does not fit or the walk gave up.
fn group_walk<P: Part>(
    p: &P,
    q: &Query,
    alive: impl Fn(u32) -> bool,
) -> Result<Option<PartResult>, Error> {
    let (Some(o), Some(limit)) = (&q.order_by, q.limit) else {
        return Ok(None);
    };
    if q.count || limit == 0 {
        return Ok(None);
    }
    let schema = p.schema();
    let Some(c) = schema.column(&o.field) else {
        return Ok(None);
    };
    let def = &schema.columns[c];
    let (Some(gname), IndexKind::Ordered) = (&def.group, def.index) else {
        return Ok(None);
    };
    if !p.has_groups(c) {
        return Ok(None);
    }
    let Some((gi, g)) = q
        .filters
        .iter()
        .enumerate()
        .find_map(|(i, f)| match &f.field == gname {
            true => match Test::for_u32(&f.cond) {
                Test::U32Set(v) if v.len() == 1 => Some((i, v[0])),
                _ => None,
            },
            false => None,
        })
    else {
        return Ok(None);
    };

    let n = p.len().max(1) as f64;
    let group_len = p.group_len(c, g);
    let mut bounds: Option<(u64, u64)> = None;
    let mut residual: Vec<Residual> = Vec::new();
    let mut ests: Vec<u64> = vec![group_len as u64];
    let mut labels: Vec<String> = Vec::new();
    for (i, f) in q.filters.iter().enumerate() {
        if i == gi {
            continue;
        }
        let Some(fc) = schema.column(&f.field) else {
            return Ok(None);
        };
        let fdef = &schema.columns[fc];
        let test = match fdef.kind {
            Kind::U32 | Kind::U32Multi => Test::for_u32(&f.cond),
            Kind::F64 => Test::for_f64(&f.cond),
            Kind::Str => return Ok(None),
        };
        if test.is_none() {
            return Ok(None);
        }
        // Selectivity inside the group, assuming the filter is as correlated with the group as it
        // can be; the step budget below bounds the cost when it is not.
        let in_group = |est: u64| (est as f64 / group_len.max(1) as f64).min(1.0);
        let r = if fc == p.pk_col() {
            match &test {
                Test::F64Set(keys) => {
                    let b =
                        bitmap_from_unsorted(keys.iter().filter_map(|&k| p.pk_get(k)).collect());
                    ests.push(b.len());
                    let selectivity = in_group(b.len());
                    Residual {
                        col: fc,
                        test,
                        selectivity,
                        how: How::Ready(b),
                    }
                }
                _ => Residual::column(fc, test, 0.5),
            }
        } else {
            match (fdef.index, &test) {
                (IndexKind::Bitmap, _) => {
                    let est = p.bitmap_estimate(fc, &test);
                    ests.push(est);
                    Residual::bitmap(p, fc, test, in_group(est))
                }
                (IndexKind::Ordered, Test::F64Range(lo, hi)) if fc == c && bounds.is_none() => {
                    bounds = Some((*lo, *hi));
                    continue;
                }
                (IndexKind::Ordered, Test::F64Range(lo, hi)) => {
                    let (s, e) = p.ordered_bounds(fc, *lo, *hi);
                    ests.push((e - s) as u64);
                    Residual::column(fc, test, (e - s) as f64 / n)
                }
                _ => Residual::column(fc, test, 0.5),
            }
        };
        residual.push(r);
    }
    let (start, end) = match bounds {
        Some((lo, hi)) => p.group_bounds(c, g, lo, hi),
        None => (0, group_len),
    };
    let span = end - start;
    let selectivity: f64 = residual.iter().map(|r| r.selectivity).product();
    let walk_est = if selectivity > 0.0 {
        (limit as f64 / selectivity).min(span as f64)
    } else {
        span as f64
    };
    let sort_est = *ests.iter().min().expect("holds the group") as f64;
    if walk_est * WALK_STEP_COST >= sort_est && span > limit as usize {
        return Ok(None);
    }
    let budget = ((sort_est / WALK_STEP_COST) as usize).max(limit as usize);

    residual.sort_by(|a, b| a.selectivity.total_cmp(&b.selectivity));
    for r in &residual {
        let est = (r.selectivity * group_len as f64).round() as u64;
        labels.push(r.label(schema, est));
    }
    let checks: Vec<Check<'_>> = residual.iter().map(|r| Check::new(p, r)).collect();
    let limit = limit as usize;
    let mut steps = 0usize;
    let mut out = Vec::with_capacity(limit.min(1024));
    let mut keys = Vec::with_capacity(limit.min(1024));
    p.group_walk(c, g, start, end, o.desc, |row, key| {
        steps += 1;
        if alive(row) && checks.iter().all(|ch| ch.ok(p, row)) {
            out.push(row);
            keys.push(key);
        }
        out.len() < limit && steps < budget
    });
    if out.len() < limit && steps >= budget && steps < span {
        return Ok(None);
    }
    let mut plan = format!("group:{gname}={g}:{group_len}");
    for l in labels {
        plan.push(' ');
        plan.push_str(&l);
    }
    plan.push_str(&format!(
        " walk:{}:{}:steps={steps}",
        o.field,
        if o.desc { "desc" } else { "asc" }
    ));
    Ok(Some(PartResult {
        output: PartOutput::Rows(out),
        plan,
        keys,
    }))
}

/// A count with exactly two filters, equality or IN on a column `g` and a range on an ordered
/// column grouped by `g`, is a pair of binary searches per group value, so it follows the number
/// of group values and not the number of rows. Any other query returns `None`.
fn grouped_count<P: Part>(
    p: &P,
    q: &Query,
    dead: Option<&Tombstones>,
) -> Result<Option<u64>, Error> {
    if !q.count || q.filters.len() != 2 {
        return Ok(None);
    }
    let schema = p.schema();
    for (range_at, group_at) in [(1, 0), (0, 1)] {
        let (rf, gf) = (&q.filters[range_at], &q.filters[group_at]);
        let (Some(rc), Some(gc)) = (schema.column(&rf.field), schema.column(&gf.field)) else {
            continue;
        };
        let def = &schema.columns[rc];
        if def.kind != Kind::F64
            || def.index != IndexKind::Ordered
            || !matches!(rf.cond, Cond::Range { .. })
            || def.group.as_deref() != Some(&gf.field)
            || !matches!(gf.cond, Cond::Eq { .. } | Cond::In { .. })
            || !p.has_groups(rc)
            || schema.columns[gc].kind != Kind::U32
        {
            continue;
        }
        let (Test::U32Set(values), Test::F64Range(lo, hi)) =
            (Test::for_u32(&gf.cond), Test::for_f64(&rf.cond))
        else {
            return Ok(Some(0));
        };
        let count = values
            .into_iter()
            .map(|v| {
                p.group_count(rc, v, lo, hi)
                    - dead.map_or(0, |d| d.group_count(p, rc, gc, v, lo, hi))
            })
            .sum();
        return Ok(Some(count));
    }
    Ok(None)
}

/// Candidates (or all rows) that pass `check`, ordered by `(key, primary key)`, first `limit`.
/// Their keys go to `keys`.
fn sorted<P: Part>(
    p: &P,
    cand: Option<&RoaringBitmap>,
    check: &dyn Fn(u32) -> bool,
    limit: usize,
    desc: bool,
    keys: &mut Vec<u64>,
    key: impl Fn(u32) -> u64,
) -> Vec<u32> {
    // Ties break by primary key; when row ids follow it, by row id, which reads nothing.
    let in_order = p.rows_in_pk_order();
    let tie = |r: u32| if in_order { r as u64 } else { p.pk_key(r) };
    let mut v: Vec<(u64, u64, u32)> = match cand {
        Some(c) => c
            .iter()
            .filter(|&r| check(r))
            .map(|r| (key(r), tie(r), r))
            .collect(),
        None => (0..p.len())
            .filter(|&r| check(r))
            .map(|r| (key(r), tie(r), r))
            .collect(),
    };
    let cmp = |a: &(u64, u64, u32), b: &(u64, u64, u32)| -> Ordering {
        let o = (a.0, a.1).cmp(&(b.0, b.1));
        if desc { o.reverse() } else { o }
    };
    if limit < v.len() {
        v.select_nth_unstable_by(limit, cmp);
        v.truncate(limit);
    }
    v.sort_unstable_by(cmp);
    keys.extend(v.iter().map(|x| x.0));
    v.into_iter().map(|x| x.2).collect()
}
