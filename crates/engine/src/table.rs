//! The in-memory delta: rows appended since the last save, with a primary key map, bitmap indexes
//! and ordered indexes. Saving writes it as a segment (`format::write_segment`).

use crate::Error;
use crate::key::f64_key;
use crate::schema::{IndexKind, Kind, Schema};
use roaring::RoaringBitmap;
use std::collections::{BTreeMap, BTreeSet};

/// Column storage. Variable-length kinds keep `offsets` with `len + 1` entries starting at 0.
#[derive(Clone, Debug, PartialEq)]
pub enum ColumnData {
    U32(Vec<u32>),
    U32Multi { offsets: Vec<u32>, values: Vec<u32> },
    F64(Vec<f64>),
    Str { offsets: Vec<u32>, bytes: Vec<u8> },
}

impl ColumnData {
    pub fn empty(kind: Kind) -> ColumnData {
        match kind {
            Kind::U32 => ColumnData::U32(Vec::new()),
            Kind::U32Multi => ColumnData::U32Multi {
                offsets: vec![0],
                values: Vec::new(),
            },
            Kind::F64 => ColumnData::F64(Vec::new()),
            Kind::Str => ColumnData::Str {
                offsets: vec![0],
                bytes: Vec::new(),
            },
        }
    }

    pub fn kind(&self) -> Kind {
        match self {
            ColumnData::U32(_) => Kind::U32,
            ColumnData::U32Multi { .. } => Kind::U32Multi,
            ColumnData::F64(_) => Kind::F64,
            ColumnData::Str { .. } => Kind::Str,
        }
    }

    pub fn len(&self) -> usize {
        match self {
            ColumnData::U32(v) => v.len(),
            ColumnData::F64(v) => v.len(),
            ColumnData::U32Multi { offsets, .. } | ColumnData::Str { offsets, .. } => {
                offsets.len() - 1
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline]
    pub fn u32_at(&self, row: u32) -> u32 {
        match self {
            ColumnData::U32(v) => v[row as usize],
            _ => unreachable!("u32_at on {:?}", self.kind()),
        }
    }

    #[inline]
    pub fn f64_at(&self, row: u32) -> f64 {
        match self {
            ColumnData::F64(v) => v[row as usize],
            _ => unreachable!("f64_at on {:?}", self.kind()),
        }
    }

    #[inline]
    pub fn multi_at(&self, row: u32) -> &[u32] {
        match self {
            ColumnData::U32Multi { offsets, values } => {
                let r = row as usize;
                &values[offsets[r] as usize..offsets[r + 1] as usize]
            }
            _ => unreachable!("multi_at on {:?}", self.kind()),
        }
    }

    #[inline]
    pub fn str_at(&self, row: u32) -> &str {
        match self {
            ColumnData::Str { offsets, bytes } => {
                let r = row as usize;
                let s = &bytes[offsets[r] as usize..offsets[r + 1] as usize];
                // Validated on the way in (Batch::set).
                std::str::from_utf8(s).expect("validated utf-8")
            }
            _ => unreachable!("str_at on {:?}", self.kind()),
        }
    }

    fn validate(&self, len: usize) -> Result<(), Error> {
        if self.len() != len {
            return Err(Error::new(format!(
                "column has {} rows, batch has {len}",
                self.len()
            )));
        }
        let check_offsets = |offsets: &[u32], total: usize| -> Result<(), Error> {
            if offsets.first() != Some(&0)
                || offsets.windows(2).any(|w| w[0] > w[1])
                || *offsets.last().unwrap() as usize != total
            {
                return Err(Error::new(
                    "offsets must start at 0, not decrease, and end at the data length",
                ));
            }
            Ok(())
        };
        match self {
            ColumnData::U32Multi { offsets, values } => check_offsets(offsets, values.len()),
            ColumnData::Str { offsets, bytes } => {
                check_offsets(offsets, bytes.len())?;
                let s = std::str::from_utf8(bytes).map_err(|e| Error::new(e.to_string()))?;
                if offsets.iter().any(|&o| !s.is_char_boundary(o as usize)) {
                    return Err(Error::new("string offset splits a character"));
                }
                Ok(())
            }
            ColumnData::F64(_) | ColumnData::U32(_) => Ok(()),
        }
    }

    fn append(&mut self, other: &ColumnData) {
        match (self, other) {
            (ColumnData::U32(a), ColumnData::U32(b)) => a.extend_from_slice(b),
            (ColumnData::F64(a), ColumnData::F64(b)) => a.extend_from_slice(b),
            (
                ColumnData::U32Multi { offsets, values },
                ColumnData::U32Multi {
                    offsets: bo,
                    values: bv,
                },
            ) => {
                let base = values.len() as u32;
                offsets.extend(bo[1..].iter().map(|o| o + base));
                values.extend_from_slice(bv);
            }
            (
                ColumnData::Str { offsets, bytes },
                ColumnData::Str {
                    offsets: bo,
                    bytes: bb,
                },
            ) => {
                let base = bytes.len() as u32;
                offsets.extend(bo[1..].iter().map(|o| o + base));
                bytes.extend_from_slice(bb);
            }
            _ => unreachable!("kinds checked by Batch::set"),
        }
    }
}

/// Rows to append, one `ColumnData` per schema column.
pub struct Batch {
    len: usize,
    columns: Vec<Option<ColumnData>>,
}

impl Batch {
    pub fn new(schema: &Schema, len: usize) -> Batch {
        Batch {
            len,
            columns: vec![None; schema.columns.len()],
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn set(&mut self, schema: &Schema, column: &str, data: ColumnData) -> Result<(), Error> {
        let c = schema
            .column(column)
            .ok_or_else(|| Error::new(format!("no column {column}")))?;
        if schema.columns[c].kind != data.kind() {
            return Err(Error::new(format!(
                "column {column} is {:?}, got {:?}",
                schema.columns[c].kind,
                data.kind()
            )));
        }
        data.validate(self.len)
            .map_err(|e| Error::new(format!("column {column}: {e}")))?;
        self.columns[c] = Some(data);
        Ok(())
    }

    /// The first schema column the batch does not set.
    pub(crate) fn missing<'a>(&self, schema: &'a Schema) -> Option<&'a str> {
        schema
            .columns
            .iter()
            .zip(&self.columns)
            .find(|(_, c)| c.is_none())
            .map(|(def, _)| def.name.as_str())
    }

    /// The batch's primary keys, if that column is set.
    pub(crate) fn keys(&self, pk_col: usize) -> Option<&[f64]> {
        match &self.columns[pk_col] {
            Some(ColumnData::F64(keys)) => Some(keys),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Index {
    None,
    Bitmap(BTreeMap<u32, RoaringBitmap>),
    /// `(f64_key(value), row)`, sorted by value then primary key. Rebuilt lazily after appends.
    Ordered {
        entries: Vec<(u64, u32)>,
        /// Per group value, the entries of that group in the same order. Empty without a group.
        groups: Groups,
        built_len: u32,
    },
    Keys(KeySet),
}

pub(crate) type Groups = BTreeMap<u32, Vec<(u64, u32)>>;

/// A keys index of the delta: (key, row), kept sorted as rows are appended.
pub(crate) type KeySet = BTreeSet<(Box<[u8]>, u32)>;

/// The keys a `keys`-indexed string holds: its space-separated pieces.
pub(crate) fn keys_of(s: &[u8]) -> impl Iterator<Item = &[u8]> {
    s.split(|&b| b == b' ').filter(|k| !k.is_empty())
}

#[derive(Clone, Debug)]
pub struct Table {
    pub(crate) schema: Schema,
    pub(crate) pk_col: usize,
    pub(crate) len: u32,
    pub(crate) columns: Vec<ColumnData>,
    pub(crate) pk: BTreeMap<u64, u32>,
    pub(crate) indexes: Vec<Index>,
}

impl Table {
    pub fn new(schema: Schema) -> Result<Table, Error> {
        let pk_col = schema.validate()?;
        let columns = schema
            .columns
            .iter()
            .map(|c| ColumnData::empty(c.kind))
            .collect();
        let indexes = schema
            .columns
            .iter()
            .map(|c| match c.index {
                IndexKind::None => Index::None,
                IndexKind::Bitmap => Index::Bitmap(BTreeMap::new()),
                IndexKind::Keys => Index::Keys(KeySet::new()),
                IndexKind::Ordered => Index::Ordered {
                    entries: Vec::new(),
                    groups: Groups::new(),
                    built_len: 0,
                },
            })
            .collect();
        Ok(Table {
            schema,
            pk_col,
            len: 0,
            columns,
            pk: BTreeMap::new(),
            indexes,
        })
    }

    /// Appends rows. Rejects the whole batch if a key is NaN, repeats, or already exists.
    pub fn append(&mut self, batch: Batch) -> Result<(), Error> {
        let Batch { len, columns } = batch;
        let mut cols = Vec::with_capacity(columns.len());
        for (def, c) in self.schema.columns.iter().zip(columns) {
            cols.push(
                c.ok_or_else(|| Error::new(format!("batch is missing column {}", def.name)))?,
            );
        }
        let ColumnData::F64(keys) = &cols[self.pk_col] else {
            unreachable!()
        };
        let mut sorted: Vec<u64> = Vec::with_capacity(len);
        for &k in keys {
            if k.is_nan() {
                return Err(Error::new("primary key is NaN"));
            }
            let key = f64_key(k);
            if self.pk.contains_key(&key) {
                return Err(Error::new(format!("primary key {k} already exists")));
            }
            sorted.push(key);
        }
        sorted.sort_unstable();
        if sorted.windows(2).any(|w| w[0] == w[1]) {
            return Err(Error::new("batch repeats a primary key"));
        }
        if self.len as usize + len > u32::MAX as usize {
            return Err(Error::new("table is full"));
        }

        let first = self.len;
        for (i, &k) in keys.iter().enumerate() {
            self.pk.insert(f64_key(k), first + i as u32);
        }
        for (c, data) in cols.iter().enumerate() {
            if let (Index::Keys(set), ColumnData::Str { offsets, bytes }) =
                (&mut self.indexes[c], data)
            {
                for i in 0..len {
                    let s = &bytes[offsets[i] as usize..offsets[i + 1] as usize];
                    for k in keys_of(s) {
                        set.insert((k.into(), first + i as u32));
                    }
                }
            }
            if let Index::Bitmap(map) = &mut self.indexes[c] {
                match data {
                    ColumnData::U32(values) => {
                        for (i, &v) in values.iter().enumerate() {
                            {
                                let bm = map.entry(v).or_default();
                                let r = first + i as u32;
                                if bm.try_push(r).is_err() {
                                    bm.insert(r);
                                }
                            }
                        }
                    }
                    ColumnData::U32Multi { offsets, values } => {
                        for i in 0..len {
                            let row = first + i as u32;
                            for &v in &values[offsets[i] as usize..offsets[i + 1] as usize] {
                                {
                                    let bm = map.entry(v).or_default();
                                    let r = row;
                                    if bm.try_push(r).is_err() {
                                        bm.insert(r);
                                    }
                                }
                            }
                        }
                    }
                    _ => unreachable!("bitmap index on {:?}", data.kind()),
                }
            }
            self.columns[c].append(data);
        }
        self.len += len as u32;
        Ok(())
    }

    /// Sorts every ordered index that is behind the table. Queries call this too.
    pub fn build_indexes(&mut self) {
        for c in 0..self.indexes.len() {
            let stale = matches!(&self.indexes[c], Index::Ordered { built_len, .. } if *built_len != self.len);
            if !stale {
                continue;
            }
            let ColumnData::F64(values) = &self.columns[c] else {
                unreachable!()
            };
            let mut entries: Vec<(u64, u32)> = values
                .iter()
                .enumerate()
                .map(|(row, &v)| (f64_key(v), row as u32))
                .collect();
            let pk = &self.columns[self.pk_col];
            entries.sort_unstable_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| f64_key(pk.f64_at(a.1)).cmp(&f64_key(pk.f64_at(b.1))))
            });
            let mut groups = Groups::new();
            if let Some(g) = &self.schema.columns[c].group {
                let gcol = &self.columns[self.schema.column(g).expect("validated")];
                for &(key, row) in &entries {
                    groups.entry(gcol.u32_at(row)).or_default().push((key, row));
                }
            }
            self.indexes[c] = Index::Ordered {
                entries,
                groups,
                built_len: self.len,
            };
        }
    }
}
