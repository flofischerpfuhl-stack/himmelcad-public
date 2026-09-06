//! Product-neutral canonical JSON used by hash-bound wire contracts.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Canonical, plain-decimal wire spelling of one finite IEEE-754 binary64 value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Decimal64(String);

impl Decimal64 {
    /// Projects an authoritative binary64 value without changing its bits.
    pub fn from_f64(value: f64) -> Result<Self, CanonicalJsonError> {
        if !value.is_finite() {
            return Err(CanonicalJsonError::NonFiniteDecimal64);
        }
        if value == 0.0 {
            return Ok(Self("0".to_owned()));
        }
        Ok(Self(expand_decimal_exponent(&value.to_string())))
    }

    /// Parses and verifies the one canonical spelling for a binary64 value.
    pub fn parse(value: &str) -> Result<Self, CanonicalJsonError> {
        if !is_plain_normalized_decimal(value) {
            return Err(CanonicalJsonError::InvalidDecimal64(value.to_owned()));
        }
        let parsed = value
            .parse::<f64>()
            .map_err(|_| CanonicalJsonError::InvalidDecimal64(value.to_owned()))?;
        let canonical = Self::from_f64(parsed)?;
        if canonical.0 != value {
            return Err(CanonicalJsonError::InvalidDecimal64(value.to_owned()));
        }
        Ok(canonical)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the identical binary64 value represented by this checked spelling.
    pub fn to_f64(&self) -> f64 {
        self.0
            .parse()
            .expect("Decimal64 construction guarantees a finite binary64")
    }
}

impl Serialize for Decimal64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for Decimal64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// Canonical JSON serialization failures.
#[derive(Debug, Error)]
pub enum CanonicalJsonError {
    #[error("failed to convert the value to JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("canonical JSON does not allow floating-point values at {path}")]
    FloatingPoint { path: String },
    #[error("the omitted member requires a top-level JSON object")]
    TopLevelObjectRequired,
    #[error("Decimal64 requires a finite binary64 value")]
    NonFiniteDecimal64,
    #[error("invalid canonical Decimal64 spelling: {0}")]
    InvalidDecimal64(String),
}

fn expand_decimal_exponent(value: &str) -> String {
    let Some(exponent_index) = value.find(['e', 'E']) else {
        return value.to_owned();
    };
    let (mantissa, exponent) = value.split_at(exponent_index);
    let exponent = exponent[1..]
        .parse::<i32>()
        .expect("f64 Display always emits a valid decimal exponent");
    let negative = mantissa.starts_with('-');
    let unsigned = mantissa.strip_prefix('-').unwrap_or(mantissa);
    let decimal_index = unsigned.find('.').unwrap_or(unsigned.len());
    let digits = unsigned.replace('.', "");
    let shifted = i32::try_from(decimal_index).expect("binary64 decimal is bounded") + exponent;
    let mut output = String::new();
    if negative {
        output.push('-');
    }
    if shifted <= 0 {
        output.push_str("0.");
        output.extend(std::iter::repeat_n(
            '0',
            usize::try_from(-shifted).expect("binary64 decimal is bounded"),
        ));
        output.push_str(&digits);
    } else if usize::try_from(shifted).expect("binary64 decimal is bounded") >= digits.len() {
        output.push_str(&digits);
        output.extend(std::iter::repeat_n(
            '0',
            usize::try_from(shifted).expect("binary64 decimal is bounded") - digits.len(),
        ));
    } else {
        let shifted = usize::try_from(shifted).expect("binary64 decimal is bounded");
        output.push_str(&digits[..shifted]);
        output.push('.');
        output.push_str(&digits[shifted..]);
    }
    output
}

fn is_plain_normalized_decimal(value: &str) -> bool {
    if value.is_empty() || value == "-0" || value.starts_with('+') {
        return false;
    }
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    let mut parts = unsigned.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some()
        || integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || (integer.len() > 1 && integer.starts_with('0'))
    {
        return false;
    }
    fraction.is_none_or(|fraction| {
        !fraction.is_empty()
            && fraction.bytes().all(|byte| byte.is_ascii_digit())
            && !fraction.ends_with('0')
    })
}

/// Serializes as UTF-8 JSON with byte-sorted object keys, stable arrays and no whitespace.
pub fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, CanonicalJsonError> {
    let value = serde_json::to_value(value)?;
    let mut output = Vec::new();
    write_value(&value, &mut output, "$".to_owned())?;
    Ok(output)
}

/// Hashes a canonical top-level object after omitting exactly one member.
pub fn sha256_omitting_member<T: Serialize>(
    value: &T,
    member: &str,
) -> Result<String, CanonicalJsonError> {
    let mut value = serde_json::to_value(value)?;
    let object = value
        .as_object_mut()
        .ok_or(CanonicalJsonError::TopLevelObjectRequired)?;
    object.remove(member);
    let mut bytes = Vec::new();
    write_value(&value, &mut bytes, "$".to_owned())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn write_value(
    value: &Value,
    output: &mut Vec<u8>,
    path: String,
) -> Result<(), CanonicalJsonError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => {
            if value.is_f64() {
                return Err(CanonicalJsonError::FloatingPoint { path });
            }
            output.extend_from_slice(value.to_string().as_bytes());
        }
        Value::String(value) => serde_json::to_writer(&mut *output, value)?,
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_value(value, output, format!("{path}[{index}]"))?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key)?;
                output.push(b':');
                write_value(&values[key], output, format!("{path}.{key}"))?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::{sha256_omitting_member, to_vec, CanonicalJsonError, Decimal64};

    #[test]
    fn sorts_object_keys_by_utf8_bytes() {
        let bytes = to_vec(&json!({"z": 1, "aa": 2, "a": 3, "é": 4})).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"a":3,"aa":2,"z":1,"é":4}"#
        );
    }

    #[test]
    fn retains_declared_nested_array_order() {
        let bytes = to_vec(&json!({"outer": [{"b": 2, "a": 1}, [3, 1, 2]]})).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"outer":[{"a":1,"b":2},[3,1,2]]}"#
        );
    }

    #[test]
    fn rejects_floating_point_values() {
        assert!(matches!(
            to_vec(&json!({"nested": [1, 2.5]})),
            Err(CanonicalJsonError::FloatingPoint { path }) if path == "$.nested[1]"
        ));
    }

    #[test]
    fn hash_is_stable_across_field_insertion_order() {
        let mut left = Map::new();
        left.insert("package_sha256".into(), Value::String("old".into()));
        left.insert("b".into(), json!({"y": 2, "x": 1}));
        left.insert("a".into(), json!(3));
        let mut right = Map::new();
        right.insert("a".into(), json!(3));
        right.insert("b".into(), json!({"x": 1, "y": 2}));
        right.insert("package_sha256".into(), Value::String("different".into()));
        assert_eq!(
            sha256_omitting_member(&Value::Object(left), "package_sha256").unwrap(),
            sha256_omitting_member(&Value::Object(right), "package_sha256").unwrap()
        );
    }

    #[test]
    fn decimal64_uses_shortest_plain_round_trip_spelling() {
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (1.0e-7, "0.0000001"),
            (1.0e21, "1000000000000000000000"),
        ] {
            let decimal = Decimal64::from_f64(value).unwrap();
            assert_eq!(decimal.as_str(), expected);
            let expected_bits = if value == 0.0 {
                0.0_f64.to_bits()
            } else {
                value.to_bits()
            };
            assert_eq!(decimal.to_f64().to_bits(), expected_bits);
        }

        let smallest_normal = Decimal64::from_f64(f64::MIN_POSITIVE).unwrap();
        assert!(!smallest_normal.as_str().contains(['e', 'E']));
        assert_eq!(
            smallest_normal.to_f64().to_bits(),
            f64::MIN_POSITIVE.to_bits()
        );
    }

    #[test]
    fn decimal64_rejects_equivalent_noncanonical_spellings() {
        for value in ["-0", "+1", "01", "1.0", "1e3", "0.10", "NaN", "inf"] {
            assert!(Decimal64::parse(value).is_err(), "{value}");
        }
        assert_eq!(Decimal64::parse("0.0000001").unwrap().to_f64(), 1.0e-7);
    }
}
