/// Maps an `f64` to a `u64` whose unsigned order is the numeric order, so indexes compare
/// integers. `-0.0` and `0.0` map to the same key. Callers reject NaN before indexing.
pub fn f64_key(v: f64) -> u64 {
    let bits = if v == 0.0 { 0u64 } else { v.to_bits() };
    if bits >> 63 == 1 {
        !bits
    } else {
        bits | (1 << 63)
    }
}

/// The number `f64_key` maps to `k`.
pub fn key_f64(k: u64) -> f64 {
    f64::from_bits(if k >> 63 == 1 { k & !(1 << 63) } else { !k })
}

#[cfg(test)]
mod tests {
    use super::f64_key;

    #[test]
    fn preserves_numeric_order() {
        let values = [
            f64::NEG_INFINITY,
            -1e300,
            -2.5,
            -1.0,
            -f64::MIN_POSITIVE,
            0.0,
            f64::MIN_POSITIVE,
            1.0,
            1.5,
            1_700_000_000_000.0,
            1e300,
            f64::INFINITY,
        ];
        for pair in values.windows(2) {
            assert!(f64_key(pair[0]) < f64_key(pair[1]), "{pair:?}");
        }
        assert_eq!(f64_key(-0.0), f64_key(0.0));
        for v in values {
            assert_eq!(super::key_f64(f64_key(v)), v);
        }
    }
}
