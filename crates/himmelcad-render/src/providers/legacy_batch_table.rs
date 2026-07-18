//! Exact, bounded access to legacy 3D Tiles batch-table properties.

use serde_json::Value;

use super::tiles3d_content::ThreeDTilesContentError;

const ROOT_PROPERTIES: [&str; 2] = ["extensions", "extras"];

pub(super) fn validate_legacy_batch_table(
    json: Option<&Value>,
    binary: &[u8],
    feature_count: u32,
) -> Result<(), ThreeDTilesContentError> {
    let Some(json) = json else {
        return binary
            .is_empty()
            .then_some(())
            .ok_or_else(|| invalid("binary body exists without a batch-table JSON header"));
    };
    let properties = json
        .as_object()
        .ok_or_else(|| invalid("batch-table JSON root is not an object"))?;
    validate_legacy_property_set(properties, binary, feature_count, true)
}

pub(super) fn validate_legacy_property_set(
    properties: &serde_json::Map<String, Value>,
    binary: &[u8],
    feature_count: u32,
    skip_root_properties: bool,
) -> Result<(), ThreeDTilesContentError> {
    let feature_count = usize::try_from(feature_count)
        .map_err(|_| invalid("batch-table feature count exceeds the address space"))?;
    for (name, property) in properties {
        if skip_root_properties && ROOT_PROPERTIES.contains(&name.as_str()) {
            continue;
        }
        match property {
            Value::Array(values) if values.len() == feature_count => {}
            Value::Array(_) => {
                return Err(invalid(
                    "batch-table JSON property length does not match the feature count",
                ));
            }
            Value::Object(descriptor) => {
                let layout = BinaryPropertyLayout::parse(descriptor)?;
                layout.validate_range(binary, feature_count)?;
            }
            _ => {
                return Err(invalid(
                    "batch-table property is neither an array nor a binary descriptor",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn legacy_batch_table_row(
    json: Option<&Value>,
    binary: &[u8],
    feature_count: u32,
    feature_id: u32,
) -> Result<Value, ThreeDTilesContentError> {
    validate_legacy_batch_table(json, binary, feature_count)?;
    if feature_id >= feature_count {
        return Err(invalid("batch-table feature ID is out of range"));
    }
    let properties = json
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("batch-table JSON header is missing"))?;
    legacy_property_set_row(properties, binary, feature_count, feature_id, true)
}

pub(super) fn legacy_property_set_row(
    properties: &serde_json::Map<String, Value>,
    binary: &[u8],
    feature_count: u32,
    feature_id: u32,
    skip_root_properties: bool,
) -> Result<Value, ThreeDTilesContentError> {
    validate_legacy_property_set(properties, binary, feature_count, skip_root_properties)?;
    if feature_id >= feature_count {
        return Err(invalid("batch-table feature ID is out of range"));
    }
    let row = usize::try_from(feature_id).expect("u32 fits usize");
    let mut decoded = serde_json::Map::new();
    for (name, property) in properties {
        if skip_root_properties && ROOT_PROPERTIES.contains(&name.as_str()) {
            continue;
        }
        let value = match property {
            Value::Array(values) => values
                .get(row)
                .cloned()
                .ok_or_else(|| invalid("batch-table JSON property row is missing"))?,
            Value::Object(descriptor) => {
                BinaryPropertyLayout::parse(descriptor)?.decode(binary, row)?
            }
            _ => unreachable!("validated batch-table property"),
        };
        decoded.insert(name.clone(), value);
    }
    Ok(Value::Object(decoded))
}

#[derive(Debug, Clone, Copy)]
struct BinaryPropertyLayout {
    byte_offset: usize,
    component: LegacyComponent,
    component_count: usize,
}

impl BinaryPropertyLayout {
    fn parse(descriptor: &serde_json::Map<String, Value>) -> Result<Self, ThreeDTilesContentError> {
        let byte_offset = descriptor
            .get("byteOffset")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| invalid("batch-table binary byteOffset is invalid"))?;
        let component = descriptor
            .get("componentType")
            .and_then(Value::as_str)
            .and_then(LegacyComponent::parse)
            .ok_or_else(|| invalid("batch-table binary componentType is unsupported"))?;
        let component_count = match descriptor.get("type").and_then(Value::as_str) {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4") => 4,
            _ => return Err(invalid("batch-table binary type is unsupported")),
        };
        if !byte_offset.is_multiple_of(component.size()) {
            return Err(invalid(
                "batch-table binary byteOffset is not component-aligned",
            ));
        }
        Ok(Self {
            byte_offset,
            component,
            component_count,
        })
    }

    fn validate_range(
        self,
        binary: &[u8],
        feature_count: usize,
    ) -> Result<(), ThreeDTilesContentError> {
        let byte_length = feature_count
            .checked_mul(self.component_count)
            .and_then(|count| count.checked_mul(self.component.size()))
            .ok_or_else(|| invalid("batch-table binary property range overflows"))?;
        let end = self
            .byte_offset
            .checked_add(byte_length)
            .ok_or_else(|| invalid("batch-table binary property range overflows"))?;
        if end > binary.len() {
            return Err(invalid("batch-table binary property exceeds its body"));
        }
        Ok(())
    }

    fn decode(self, binary: &[u8], row: usize) -> Result<Value, ThreeDTilesContentError> {
        let stride = self
            .component_count
            .checked_mul(self.component.size())
            .ok_or_else(|| invalid("batch-table binary row stride overflows"))?;
        let start = row
            .checked_mul(stride)
            .and_then(|offset| self.byte_offset.checked_add(offset))
            .ok_or_else(|| invalid("batch-table binary row offset overflows"))?;
        if self.component_count == 1 {
            return self.component.decode(binary, start);
        }
        (0..self.component_count)
            .map(|component| {
                let offset = component
                    .checked_mul(self.component.size())
                    .and_then(|offset| start.checked_add(offset))
                    .ok_or_else(|| invalid("batch-table binary component offset overflows"))?;
                self.component.decode(binary, offset)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array)
    }
}

#[derive(Debug, Clone, Copy)]
enum LegacyComponent {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl LegacyComponent {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "BYTE" => Some(Self::I8),
            "UNSIGNED_BYTE" => Some(Self::U8),
            "SHORT" => Some(Self::I16),
            "UNSIGNED_SHORT" => Some(Self::U16),
            "INT" => Some(Self::I32),
            "UNSIGNED_INT" => Some(Self::U32),
            "FLOAT" => Some(Self::F32),
            "DOUBLE" => Some(Self::F64),
            _ => None,
        }
    }

    const fn size(self) -> usize {
        match self {
            Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::F64 => 8,
        }
    }

    fn decode(self, bytes: &[u8], offset: usize) -> Result<Value, ThreeDTilesContentError> {
        match self {
            Self::I8 => Ok(Value::from(i64::from(i8::from_le_bytes(read(
                bytes, offset,
            )?)))),
            Self::U8 => Ok(Value::from(u64::from(read::<1>(bytes, offset)?[0]))),
            Self::I16 => Ok(Value::from(i64::from(i16::from_le_bytes(read(
                bytes, offset,
            )?)))),
            Self::U16 => Ok(Value::from(u64::from(u16::from_le_bytes(read(
                bytes, offset,
            )?)))),
            Self::I32 => Ok(Value::from(i64::from(i32::from_le_bytes(read(
                bytes, offset,
            )?)))),
            Self::U32 => Ok(Value::from(u64::from(u32::from_le_bytes(read(
                bytes, offset,
            )?)))),
            Self::F32 => finite_float(f64::from(f32::from_le_bytes(read(bytes, offset)?))),
            Self::F64 => finite_float(f64::from_le_bytes(read(bytes, offset)?)),
        }
    }
}

fn read<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], ThreeDTilesContentError> {
    bytes
        .get(offset..offset.saturating_add(N))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| invalid("batch-table binary component is out of range"))
}

fn finite_float(value: f64) -> Result<Value, ThreeDTilesContentError> {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| invalid("batch-table binary float is not finite"))
}

fn invalid(message: &str) -> ThreeDTilesContentError {
    ThreeDTilesContentError::InvalidJson(message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{legacy_batch_table_row, validate_legacy_batch_table};
    use serde_json::json;

    #[test]
    fn decodes_json_and_every_legacy_binary_component_shape() {
        let mut binary = Vec::new();
        binary.extend((-7_i8).to_le_bytes());
        binary.push(9);
        binary.extend([250_u8, 251]);
        binary.extend((-300_i16).to_le_bytes());
        binary.extend(700_i16.to_le_bytes());
        binary.extend(60_000_u16.to_le_bytes());
        binary.extend(60_001_u16.to_le_bytes());
        binary.extend((-2_000_000_i32).to_le_bytes());
        binary.extend(3_000_000_i32.to_le_bytes());
        binary.extend(4_000_000_000_u32.to_le_bytes());
        binary.extend(4_000_000_001_u32.to_le_bytes());
        binary.extend(1.5_f32.to_le_bytes());
        binary.extend(2.5_f32.to_le_bytes());
        while !binary.len().is_multiple_of(8) {
            binary.push(0);
        }
        let double_offset = binary.len();
        for value in [10.25_f64, 11.25, 12.25, 20.25, 21.25, 22.25] {
            binary.extend(value.to_le_bytes());
        }
        let json = json!({
            "name": ["first", "second"],
            "i8": {"byteOffset": 0, "componentType": "BYTE", "type": "SCALAR"},
            "u8": {"byteOffset": 2, "componentType": "UNSIGNED_BYTE", "type": "SCALAR"},
            "i16": {"byteOffset": 4, "componentType": "SHORT", "type": "SCALAR"},
            "u16": {"byteOffset": 8, "componentType": "UNSIGNED_SHORT", "type": "SCALAR"},
            "i32": {"byteOffset": 12, "componentType": "INT", "type": "SCALAR"},
            "u32": {"byteOffset": 20, "componentType": "UNSIGNED_INT", "type": "SCALAR"},
            "f32": {"byteOffset": 28, "componentType": "FLOAT", "type": "SCALAR"},
            "position": {"byteOffset": double_offset, "componentType": "DOUBLE", "type": "VEC3"},
            "extensions": {"3DTILES_batch_table_hierarchy": {"classes": []}}
        });

        let second = legacy_batch_table_row(Some(&json), &binary, 2, 1).expect("second row");
        assert_eq!(second["name"], "second");
        assert_eq!(second["i8"], 9);
        assert_eq!(second["u8"], 251);
        assert_eq!(second["i16"], 700);
        assert_eq!(second["u16"], 60_001);
        assert_eq!(second["i32"], 3_000_000);
        assert_eq!(second["u32"], 4_000_000_001_u64);
        assert_eq!(second["f32"], 2.5);
        assert_eq!(second["position"], json!([20.25, 21.25, 22.25]));
        assert!(second.get("extensions").is_none());
    }

    #[test]
    fn rejects_ranges_alignment_lengths_types_ids_and_non_finite_values() {
        let invalid_cases = [
            (json!({"x": [1]}), vec![], 2),
            (
                json!({"x": {"byteOffset": 1, "componentType": "FLOAT", "type": "SCALAR"}}),
                vec![0; 8],
                1,
            ),
            (
                json!({"x": {"byteOffset": 0, "componentType": "HALF_FLOAT", "type": "SCALAR"}}),
                vec![0; 8],
                1,
            ),
            (
                json!({"x": {"byteOffset": 0, "componentType": "DOUBLE", "type": "MAT2"}}),
                vec![0; 8],
                1,
            ),
            (
                json!({"x": {"byteOffset": 8, "componentType": "DOUBLE", "type": "SCALAR"}}),
                vec![0; 8],
                1,
            ),
        ];
        for (json, binary, count) in invalid_cases {
            assert!(validate_legacy_batch_table(Some(&json), &binary, count).is_err());
        }

        let json = json!({"x": {"byteOffset": 0, "componentType": "DOUBLE", "type": "SCALAR"}});
        assert!(legacy_batch_table_row(Some(&json), &f64::NAN.to_le_bytes(), 1, 0).is_err());
        assert!(legacy_batch_table_row(Some(&json), &0.0_f64.to_le_bytes(), 1, 1).is_err());
    }
}
