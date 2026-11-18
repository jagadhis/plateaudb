//! The file the database lives in. Every method takes `&self` because lazy segments read through
//! a shared handle while a query holds them; implementations use interior mutability.

use crate::Error;
use std::cell::RefCell;

pub trait Storage {
    /// Fills `buf` from `offset`. Reading past the end is an error.
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<(), Error>;
    fn write_at(&self, offset: u64, buf: &[u8]) -> Result<(), Error>;
    fn size(&self) -> Result<u64, Error>;
    fn truncate(&self, size: u64) -> Result<(), Error>;
    fn flush(&self) -> Result<(), Error>;
}

/// A file held in a `Vec`, for tests and native tools.
#[derive(Debug, Default)]
pub struct MemStorage {
    data: RefCell<Vec<u8>>,
}

impl MemStorage {
    pub fn new() -> MemStorage {
        MemStorage::default()
    }

    pub fn from_bytes(bytes: Vec<u8>) -> MemStorage {
        MemStorage {
            data: RefCell::new(bytes),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.data.borrow().clone()
    }
}

impl Storage for MemStorage {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<(), Error> {
        let data = self.data.borrow();
        let start = usize::try_from(offset).map_err(|_| Error::new("read past the end"))?;
        let src = start
            .checked_add(buf.len())
            .and_then(|end| data.get(start..end))
            .ok_or_else(|| Error::new("read past the end of the file"))?;
        buf.copy_from_slice(src);
        Ok(())
    }

    fn write_at(&self, offset: u64, buf: &[u8]) -> Result<(), Error> {
        let mut data = self.data.borrow_mut();
        let start = offset as usize;
        let end = start + buf.len();
        if data.len() < end {
            data.resize(end, 0);
        }
        data[start..end].copy_from_slice(buf);
        Ok(())
    }

    fn size(&self) -> Result<u64, Error> {
        Ok(self.data.borrow().len() as u64)
    }

    fn truncate(&self, size: u64) -> Result<(), Error> {
        self.data.borrow_mut().resize(size as usize, 0);
        Ok(())
    }

    fn flush(&self) -> Result<(), Error> {
        Ok(())
    }
}
