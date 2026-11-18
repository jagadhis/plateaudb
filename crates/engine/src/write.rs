//! Where new bytes go: the free space the committed state leaves in the file, and a buffered
//! writer that fills it one piece at a time.

use crate::Error;
use crate::format::{DATA_START, SectionRef, block_checksum, checksum};
use crate::storage::Storage;

/// Bytes buffered before a write goes to storage. Small, so a save or compaction holds little
/// beyond the piece it encodes.
const WRITE_BUFFER: usize = 256 << 10;

/// The extents in use (by the committed state and by what was placed since), and so the gaps
/// between them.
pub(crate) struct Space {
    taken: Vec<(u64, u64)>,
}

impl Space {
    pub fn new(taken: Vec<(u64, u64)>) -> Space {
        let mut s = Space { taken };
        s.taken.sort_unstable();
        s
    }

    pub fn gaps(&self) -> impl Iterator<Item = (u64, u64)> + '_ {
        let mut prev = DATA_START;
        self.taken.iter().filter_map(move |&(start, end)| {
            let gap = (start > prev).then_some((prev, start));
            prev = prev.max(end);
            gap
        })
    }

    /// The offset after the last byte in use.
    pub fn end(&self) -> u64 {
        self.taken
            .iter()
            .map(|e| e.1)
            .max()
            .unwrap_or(DATA_START)
            .max(DATA_START)
    }

    pub fn take(&mut self, start: u64, end: u64) {
        let at = self.taken.partition_point(|e| *e < (start, end));
        self.taken.insert(at, (start, end));
    }

    /// The first free run with room for `len` bytes: `(start, limit)`, 8-aligned, in the lowest
    /// gap that holds it, else at the end of the file (`limit` then unbounded).
    pub fn fit(&self, len: u64) -> (u64, u64) {
        self.gaps()
            .map(|(a, b)| (a.next_multiple_of(8), b))
            .find(|&(a, b)| a <= b && b - a >= len)
            .unwrap_or_else(|| self.at_end())
    }

    /// The free run at the end of the file.
    fn at_end(&self) -> (u64, u64) {
        (self.end().next_multiple_of(8), u64::MAX)
    }

    /// Where `len` bytes go; marks them taken.
    pub fn place(&mut self, len: u64) -> u64 {
        let len = len.next_multiple_of(8);
        let (at, _) = self.fit(len);
        self.take(at, at + len);
        at
    }
}

/// Gaps smaller than this are left alone: each run a segment is written in costs a manifest entry.
const MIN_GAP: u64 = 4 << 10;

/// Writes a segment's pieces (sections, blocks, arrays) into the free space of a `Space`.
///
/// A segment has its own logical address space from `DATA_START` on: `reserve` hands out logical
/// offsets one piece after another, and every offset inside the segment (directories, array
/// bases, block checksum seeds) is logical. The bytes go into physical runs: the lowest gaps first,
/// filled in order, then the end of the file. The runs, in logical order, are the segment's
/// extents; a reader maps logical offsets through them, so a piece may straddle two runs, and the
/// runs can later move (`Db::tidy`) without rewriting a byte of the segment.
pub(crate) struct Writer<'a> {
    storage: &'a dyn Storage,
    space: &'a mut Space,
    buf: Vec<u8>,
    /// Next logical offset to hand out.
    logical: u64,
    /// The run being filled: `[start, at)` is written, there is room up to `limit`.
    run: Option<(u64, u64, u64)>,
    extents: Vec<(u64, u64)>,
}

impl<'a> Writer<'a> {
    pub fn new(storage: &'a dyn Storage, space: &'a mut Space) -> Writer<'a> {
        Writer {
            storage,
            space,
            buf: Vec::new(),
            logical: DATA_START,
            run: None,
            extents: Vec::new(),
        }
    }

    /// Claims `len` bytes (a multiple of 8) for one piece and returns their logical offset. The
    /// caller then `put`s exactly that many bytes before claiming again.
    pub fn reserve(&mut self, len: u64) -> Result<u64, Error> {
        debug_assert!(len.is_multiple_of(8));
        let at = self.logical;
        self.logical += len;
        Ok(at)
    }

    pub fn put(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() >= WRITE_BUFFER {
            self.drain()?;
        }
        Ok(())
    }

    /// Writes the buffer into the current run, then into the next ones.
    fn drain(&mut self) -> Result<(), Error> {
        let mut from = 0;
        while from < self.buf.len() {
            let (start, at, limit) = match self.run {
                Some(r) if r.1 < r.2 => r,
                _ => {
                    self.close();
                    let (a, limit) = self.space.fit(MIN_GAP);
                    (a, a, limit)
                }
            };
            let n = ((limit - at) as usize).min(self.buf.len() - from);
            self.storage.write_at(at, &self.buf[from..from + n])?;
            self.run = Some((start, at + n as u64, limit));
            from += n;
        }
        self.buf.clear();
        Ok(())
    }

    fn close(&mut self) {
        if let Some((start, at, _)) = self.run.take()
            && at > start
        {
            self.space.take(start, at);
            match self.extents.last_mut() {
                Some(last) if last.1 == start => last.1 = at,
                _ => self.extents.push((start, at)),
            }
        }
    }

    /// A section: `bytes` padded to 8, referenced with its checksum. Clears `bytes`.
    pub fn section(&mut self, bytes: &mut Vec<u8>) -> Result<SectionRef, Error> {
        bytes.resize(bytes.len().next_multiple_of(8), 0);
        let len = u32::try_from(bytes.len()).map_err(|_| Error::new("section is over 4 GiB"))?;
        let off = self.reserve(len as u64)?;
        let sum = checksum(bytes);
        self.put(bytes)?;
        bytes.clear();
        Ok(SectionRef { off, len, sum })
    }

    /// A block: `body` padded to 8, then its checksum seeded with its offset. Clears `body` and
    /// returns the block's offset and length.
    pub fn block(&mut self, body: &mut Vec<u8>) -> Result<(u64, u64), Error> {
        body.resize(body.len().next_multiple_of(8), 0);
        let len = body.len() as u64 + 8;
        let off = self.reserve(len)?;
        self.put_block(body, off)?;
        Ok((off, len))
    }

    /// Writes a padded block body claimed at `off`, then its seeded checksum. Clears `body`.
    pub fn put_block(&mut self, body: &mut Vec<u8>, off: u64) -> Result<(), Error> {
        debug_assert!(body.len().is_multiple_of(8));
        let sum = block_checksum(body, off);
        self.put(body)?;
        self.put(&sum.to_le_bytes())?;
        body.clear();
        Ok(())
    }

    /// Writes what is buffered and returns the extents written, in logical order.
    pub fn finish(mut self) -> Result<Vec<(u64, u64)>, Error> {
        self.drain()?;
        self.close();
        let written: u64 = self.extents.iter().map(|e| e.1 - e.0).sum();
        debug_assert_eq!(
            DATA_START + written,
            self.logical,
            "a claimed piece was not written"
        );
        Ok(std::mem::take(&mut self.extents))
    }
}
