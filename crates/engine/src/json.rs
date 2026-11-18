use std::fmt::Write;

pub fn write_u32(out: &mut String, v: u32) {
    out.push_str(itoa::Buffer::new().format(v));
}

/// Integral values below 2^53 print without a fraction; non-finite values print as `null`,
/// as `JSON.stringify` does.
pub fn write_f64(out: &mut String, v: f64) {
    if !v.is_finite() {
        out.push_str("null");
    } else if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        out.push_str(itoa::Buffer::new().format(v as i64));
    } else {
        let _ = write!(out, "{v:e}");
    }
}

pub fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_round_trip_through_a_json_parser() {
        let s = "quote \" back \\ nl \n tab \t bell \u{7} é 🦀";
        let mut out = String::new();
        write_str(&mut out, s);
        let back: String = serde_json::from_str(&out).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn numbers_round_trip_through_a_json_parser() {
        for v in [
            0.0,
            -3.0,
            1_767_225_600_000.0,
            0.1,
            -2.5e-7,
            1e300,
            9_007_199_254_740_993.0,
        ] {
            let mut out = String::new();
            write_f64(&mut out, v);
            let back: f64 = serde_json::from_str(&out).unwrap();
            assert_eq!(back, v, "{out}");
        }
        let mut out = String::new();
        write_f64(&mut out, f64::NAN);
        assert_eq!(out, "null");
    }
}
