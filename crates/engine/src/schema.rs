use crate::Error;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// One unsigned 32-bit value per row (ids of teams, states, users; small enums).
    U32,
    /// Zero or more unsigned 32-bit values per row (IndexedDB `multiEntry`).
    U32Multi,
    /// One number per row (keys, timestamps).
    F64,
    /// One UTF-8 string per row. Stored, returned, never filtered in M0.
    Str,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexKind {
    #[default]
    None,
    /// Value to roaring bitmap of row ids. For `u32` and `u32_multi` columns.
    Bitmap,
    /// Row ids sorted by (value, primary key). For `f64` columns.
    Ordered,
    /// For `str` columns: every space-separated piece of a row's string is a key; the index holds
    /// (key bytes, row) sorted by bytewise key order, in blocks with fences, for range walks in
    /// either direction. The IndexedDB layer stores order-preserving key encodings here.
    Keys,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnDef {
    pub name: String,
    pub kind: Kind,
    #[serde(default)]
    pub index: IndexKind,
    /// For an ordered index: a `u32` bitmap-indexed column. The index also keeps one sorted list
    /// per value of that column, so a count or a walk inside one group follows the range or the
    /// page, not the group's size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// For a `str` column: leave the field out of JSON rows when the string is empty, so a row's
    /// JSON holds only what its owner stored (the IndexedDB layer keeps the rest of a value here).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub omit_empty: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    /// Name of an `f64` column holding a unique key per row.
    pub primary_key: String,
    pub columns: Vec<ColumnDef>,
}

impl Schema {
    pub fn from_json(json: &str) -> Result<Schema, Error> {
        let schema: Schema = serde_json::from_str(json)?;
        schema.validate()?;
        Ok(schema)
    }

    pub fn column(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c.name == name)
    }

    /// Index of the primary key column.
    pub fn validate(&self) -> Result<usize, Error> {
        for (i, c) in self.columns.iter().enumerate() {
            if self.columns[..i].iter().any(|o| o.name == c.name) {
                return Err(Error::new(format!("duplicate column {}", c.name)));
            }
            let ok = matches!(
                (c.kind, c.index),
                (_, IndexKind::None)
                    | (Kind::U32 | Kind::U32Multi, IndexKind::Bitmap)
                    | (Kind::F64, IndexKind::Ordered)
                    | (Kind::Str, IndexKind::Keys)
            );
            if c.omit_empty && c.kind != Kind::Str {
                return Err(Error::new(format!(
                    "column {}: omit_empty applies to str columns",
                    c.name
                )));
            }
            if !ok {
                return Err(Error::new(format!(
                    "column {}: index {:?} does not apply to kind {:?}",
                    c.name, c.index, c.kind
                )));
            }
        }
        for c in &self.columns {
            let Some(g) = &c.group else { continue };
            let target = self.column(g).map(|i| &self.columns[i]);
            let ok = c.index == IndexKind::Ordered
                && target.is_some_and(|t| t.kind == Kind::U32 && t.index == IndexKind::Bitmap);
            if !ok {
                return Err(Error::new(format!(
                    "column {}: group {g} needs an ordered index and a u32 bitmap column",
                    c.name
                )));
            }
        }
        let pk = self.column(&self.primary_key).ok_or_else(|| {
            Error::new(format!("primary key {} is not a column", self.primary_key))
        })?;
        if self.columns[pk].kind != Kind::F64 {
            return Err(Error::new("primary key must be an f64 column"));
        }
        Ok(pk)
    }
}
