//! Keys indexes: (key bytes, row) pairs sorted by bytewise key order, for range walks in either
//! direction. A segment stores one as fixed-count blocks plus a directory read on first touch.
//!
//! ```text
//! directory (u64 words)  blocks | entries | per block: offset, length, first entry
//!                        | fence offsets (blocks + 1) | fence bytes, padded
//! block (u32 words)      n | n rows | n + 1 key offsets | key bytes, padded | seeded checksum
//!                        (a lean segment's blocks are prefix-coded on disk, `encode_lean_block`,
//!                        and expanded to this layout when loaded)
//! ```
//!
//! A fence is the shortest prefix of a block's first key that is greater than the previous
//! block's last key, so a search lands on one block from the directory alone.

use crate::Error;
use crate::cache::{Slot, slots};
use crate::format::corrupt;

/// Entries per block.
pub(crate) const KEYS_PER: usize = 256;

/// The shortest prefix of `first` greater than `prev`.
pub(crate) fn separator<'a>(prev: &[u8], first: &'a [u8]) -> &'a [u8] {
    let common = prev.iter().zip(first).take_while(|(a, b)| a == b).count();
    &first[..(common + 1).min(first.len())]
}

/// Encodes one block's words prefix-coded (without the checksum): `n` | `n` rows | `n` suffix
/// end offsets | `n` shared prefix lengths, one byte each, padded to a word | suffix bytes. Entry
/// `i`'s key is the first `shared[i]` bytes of entry `i - 1`'s key, then its suffix.
pub(crate) fn encode_lean_block(out: &mut Vec<u8>, entries: &[(&[u8], u32)]) {
    let put = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_le_bytes());
    put(out, entries.len() as u32);
    entries.iter().for_each(|e| put(out, e.1));
    let shared: Vec<u8> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let prev: &[u8] = if i == 0 { &[] } else { entries[i - 1].0 };
            prev.iter()
                .zip(e.0)
                .take_while(|(a, b)| a == b)
                .count()
                .min(255) as u8
        })
        .collect();
    let mut end = 0u32;
    for (e, &s) in entries.iter().zip(&shared) {
        end += (e.0.len() - s as usize) as u32;
        put(out, end);
    }
    out.extend_from_slice(&shared);
    out.resize(out.len().next_multiple_of(4), 0);
    for (e, &s) in entries.iter().zip(&shared) {
        out.extend_from_slice(&e.0[s as usize..]);
    }
}

/// Expands a prefix-coded block (`encode_lean_block`, checksum stripped) to the plain layout.
pub(crate) fn decode_lean_block(words: &[u32]) -> Result<Vec<u32>, Error> {
    let bad = || corrupt("keys block");
    let n = *words.first().ok_or_else(bad)? as usize;
    let rows = words.get(1..1 + n).ok_or_else(bad)?;
    let ends = words.get(1 + n..1 + 2 * n).ok_or_else(bad)?;
    let bytes = bytemuck::cast_slice::<u32, u8>(words.get(1 + 2 * n..).ok_or_else(bad)?);
    let shared = bytes.get(..n).ok_or_else(bad)?;
    let suffixes = &bytes[n.next_multiple_of(4)..];
    let mut keys: Vec<u8> = Vec::new();
    let mut offs: Vec<u32> = Vec::with_capacity(n + 1);
    offs.push(0);
    let (mut start, mut prev) = (0usize, 0usize..0usize);
    for i in 0..n {
        let end = ends[i] as usize;
        let s = shared[i] as usize;
        if end < start || end > suffixes.len() || s > prev.len() {
            return Err(bad());
        }
        let from = keys.len();
        keys.extend_from_within(prev.start..prev.start + s);
        keys.extend_from_slice(&suffixes[start..end]);
        prev = from..keys.len();
        offs.push(keys.len() as u32);
        start = end;
    }
    let mut out: Vec<u32> = Vec::with_capacity(2 + 2 * n + keys.len() / 4 + 1);
    out.push(n as u32);
    out.extend_from_slice(rows);
    out.extend_from_slice(&offs);
    keys.resize(keys.len().next_multiple_of(4), 0);
    out.extend(
        keys.as_chunks::<4>()
            .0
            .iter()
            .map(|w| u32::from_le_bytes(*w)),
    );
    // The plain layout ends in a checksum word pair that `parse` does not read; keep its shape.
    out.extend([0, 0]);
    Ok(out)
}

/// A loaded block.
pub(crate) struct KeyBlock {
    words: Box<[u32]>,
    n: usize,
}

impl KeyBlock {
    pub(crate) fn parse(words: Vec<u32>) -> Result<KeyBlock, Error> {
        let n = *words.first().ok_or_else(|| corrupt("keys block"))? as usize;
        let body = words.len().saturating_sub(2) * 4;
        if 2 + 2 * n > words.len() {
            return Err(corrupt("keys block"));
        }
        let b = KeyBlock {
            words: words.into_boxed_slice(),
            n,
        };
        let offs = &b.words[1 + n..2 + 2 * n];
        let room = body.saturating_sub((2 + 2 * n) * 4);
        if offs[0] != 0 || offs.windows(2).any(|w| w[0] > w[1]) || offs[n] as usize > room {
            return Err(corrupt("keys block offsets"));
        }
        Ok(b)
    }

    pub(crate) fn len(&self) -> usize {
        self.n
    }

    pub(crate) fn heap_size(&self) -> usize {
        size_of_val(&*self.words)
    }

    fn bytes(&self) -> &[u8] {
        &bytemuck::cast_slice::<u32, u8>(&self.words)[(2 + 2 * self.n) * 4..]
    }

    #[inline]
    pub(crate) fn entry(&self, i: usize) -> (&[u8], u32) {
        let n = self.n;
        let a = self.words[1 + n + i] as usize;
        let b = self.words[2 + n + i] as usize;
        (&self.bytes()[a..b], self.words[1 + i])
    }

    /// First entry whose key is >= `key`.
    pub(crate) fn lower(&self, key: &[u8]) -> usize {
        let (mut lo, mut hi) = (0, self.n);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.entry(mid).0 < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }
}

/// A loaded directory.
pub(crate) struct KeysDir {
    /// Per block: offset, length, first entry.
    blocks: Box<[(u64, usize, usize)]>,
    total: usize,
    fence_offs: Box<[u64]>,
    fences: Box<[u8]>,
    pub(crate) cells: Box<[Slot<KeyBlock>]>,
}

impl KeysDir {
    pub(crate) fn parse(words: &[u64]) -> Result<KeysDir, Error> {
        let bad = || corrupt("keys directory");
        let n = *words.first().ok_or_else(bad)? as usize;
        let total = *words.get(1).ok_or_else(bad)? as usize;
        let head = 2 + 3 * n;
        let fo = words.get(head..head + n + 1).ok_or_else(bad)?;
        let fbytes = bytemuck::cast_slice::<u64, u8>(&words[head + n + 1..]);
        if fo.first() != Some(&0)
            || fo.windows(2).any(|w| w[0] > w[1])
            || fo[n] as usize > fbytes.len()
        {
            return Err(bad());
        }
        let blocks: Box<[(u64, usize, usize)]> = words[2..head]
            .chunks(3)
            .map(|w| (w[0], w[1] as usize, w[2] as usize))
            .collect();
        if blocks.windows(2).any(|w| w[0].2 > w[1].2) || blocks.last().is_some_and(|b| b.2 > total)
        {
            return Err(bad());
        }
        Ok(KeysDir {
            cells: slots(n),
            fences: fbytes[..fo[n] as usize].into(),
            fence_offs: fo.into(),
            blocks,
            total,
        })
    }

    pub(crate) fn total(&self) -> usize {
        self.total
    }

    /// Bytes the directory holds, its blocks' cells included.
    pub(crate) fn heap_size(&self) -> usize {
        size_of_val(&*self.blocks)
            + size_of_val(&*self.fence_offs)
            + size_of_val(&*self.fences)
            + size_of_val(&*self.cells)
    }

    pub(crate) fn block_span(&self, b: usize) -> (u64, usize) {
        (self.blocks[b].0, self.blocks[b].1)
    }

    pub(crate) fn first(&self, b: usize) -> usize {
        self.blocks[b].2
    }

    fn fence(&self, b: usize) -> &[u8] {
        &self.fences[self.fence_offs[b] as usize..self.fence_offs[b + 1] as usize]
    }

    /// The block a search for `key` starts in.
    pub(crate) fn block_for(&self, key: &[u8]) -> usize {
        let (mut lo, mut hi) = (0, self.blocks.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.fence(mid) <= key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo.saturating_sub(1)
    }

    /// The block holding entry `i`.
    pub(crate) fn block_of(&self, i: usize) -> usize {
        self.blocks.partition_point(|b| b.2 <= i).saturating_sub(1)
    }
}
