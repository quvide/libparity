// JavaScript number semantics the engine relies on.

use std::hash::{BuildHasherDefault, Hasher};

/// `Number.prototype.toFixed(digits)` for |x| < 1e21: the exact binary value
/// rounded half up in magnitude ("pick the larger n").
pub fn to_fixed(x: f64, digits: u32) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    assert!(x.abs() < 1e21, "toFixed of {x} is out of range");
    let neg = x < 0.0;
    let bits = x.abs().to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if exp == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp - 1075) };
    let scale = 10u128.pow(digits);
    let num = m as u128 * scale;
    let n: u128 = if e >= 0 {
        num << e
    } else {
        let s = (-e) as u32;
        if s >= 127 {
            // num < 2^63 * 10^digits is below half of 2^s
            0
        } else {
            let q = num >> s;
            let r = num - (q << s);
            if r >= 1u128 << (s - 1) {
                q + 1
            } else {
                q
            }
        }
    };
    let int = n / scale;
    let fracpart = n % scale;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&int.to_string());
    if digits > 0 {
        out.push('.');
        out.push_str(&format!("{:0width$}", fracpart, width = digits as usize));
    }
    out
}

/// `Math.round`: half rounds toward +infinity.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `Math.max(a, b)`: NaN propagates, +0 beats -0.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a == 0.0 && a.is_sign_negative() {
            b
        } else {
            a
        }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN propagates, -0 beats +0.
pub fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a == 0.0 && a.is_sign_negative() {
            a
        } else {
            b
        }
    } else if a < b {
        a
    } else {
        b
    }
}

/// Truthiness of a number read from a sparse array (`undefined`, 0 and NaN are falsy).
pub fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

#[derive(Default, Clone, Copy)]
pub struct FxHasher {
    hash: u64,
}

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    fn write_u8(&mut self, i: u8) {
        self.write_u64(i as u64)
    }
    fn write_u32(&mut self, i: u32) {
        self.write_u64(i as u64)
    }
    fn write_u64(&mut self, i: u64) {
        self.hash = (self.hash.rotate_left(5) ^ i).wrapping_mul(SEED);
    }
    fn write_u128(&mut self, i: u128) {
        self.write_u64(i as u64);
        self.write_u64((i >> 64) as u64);
    }
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64)
    }
    fn finish(&self) -> u64 {
        self.hash
    }
}

pub type FxBuildHasher = BuildHasherDefault<FxHasher>;
pub type FxHashMap<K, V> = std::collections::HashMap<K, V, FxBuildHasher>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(to_fixed(1.0625, 3), "1.063");
        assert_eq!(to_fixed(1.0005, 3), "1.000"); // 1.0005 is below the tie in binary
        assert_eq!(to_fixed(0.0, 3), "0.000");
        assert_eq!(to_fixed(-0.0, 3), "0.000");
        assert_eq!(to_fixed(-0.0001, 3), "-0.000");
        assert_eq!(to_fixed(-1.0625, 3), "-1.063");
        assert_eq!(to_fixed(123.4567, 3), "123.457");
        assert_eq!(to_fixed(2.0 / 3.0, 3), "0.667");
        assert_eq!(to_fixed(1e-300, 3), "0.000");
        assert_eq!(to_fixed(4.0, 3), "4.000");
    }

    #[test]
    fn round_matches_js() {
        assert_eq!(math_round(-0.5), 0.0);
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
    }
}
