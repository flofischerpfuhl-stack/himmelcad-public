//! Product-neutral canonical JSON used by hash-bound wire contracts.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Canonical JSON serialization failures.
#[derive(Debug, Error)]
pub enum CanonicalJsonError {
    #[error("failed to convert the value to JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("canonical JSON does not allow floating-point values at {path}")]
    FloatingPoint { path: String },
    #[error("the omitted member requires a top-level JSON object")]
    TopLevelObjectRequired,
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

    use super::{sha256_omitting_member, to_vec, CanonicalJsonError};

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
}
