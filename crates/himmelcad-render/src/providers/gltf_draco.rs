//! `KHR_draco_mesh_compression` materialization for embedded GLB content.

use serde_json::Value;

use super::GlbDecodeError;

const EXTENSION_NAME: &str = "KHR_draco_mesh_compression";
const MAX_MATERIALIZED_BYTES: usize = crate::decode_limits::MAX_DECODED_CONTENT_BYTES;

/// Returns a standards-equivalent uncompressed GLB when Draco primitives are
/// present, or `None` when the document does not use the extension.
pub(super) fn materialize_draco_glb(bytes: &[u8]) -> Result<Option<Vec<u8>>, GlbDecodeError> {
    if bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES {
        return Err(invalid("Draco GLB exceeds the encoded leaf limit"));
    }
    let (json, _) = super::gltf_meshopt::glb_chunks(bytes)?;
    let declaration: Value = serde_json::from_slice(json)
        .map_err(|error| invalid(format!("invalid GLB JSON: {error}")))?;
    if !document_uses_draco(&declaration) {
        return Ok(None);
    }
    preflight_accessors(&declaration)?;

    let mut imported = draco_gltf::import_slice(bytes, None)
        .map_err(|error| invalid(format!("Draco glTF import failed: {error}")))?;
    imported
        .decompress_in_place()
        .map_err(|error| invalid(format!("Draco materialization failed: {error}")))?;
    let mut document = serde_json::to_value(imported.document.into_json())
        .map_err(|error| invalid(format!("Draco glTF JSON conversion failed: {error}")))?;
    let binary = merge_embedded_buffers(&mut document, &imported.buffers)?;
    remove_empty_extension_declarations(&mut document);
    super::gltf_meshopt::encode_glb(&document, &binary).map(Some)
}

fn preflight_accessors(document: &Value) -> Result<(), GlbDecodeError> {
    let accessors = document
        .get("accessors")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Draco document has no accessors array"))?;
    let mut decoded_bytes = 0_usize;
    for accessor in accessors {
        let count = accessor
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
            .ok_or_else(|| invalid("Draco accessor count is invalid"))?;
        let component_bytes = match accessor.get("componentType").and_then(Value::as_u64) {
            Some(5120 | 5121) => 1,
            Some(5122 | 5123) => 2,
            Some(5125 | 5126) => 4,
            _ => return Err(invalid("Draco accessor component type is invalid")),
        };
        let components = match accessor.get("type").and_then(Value::as_str) {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4" | "MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => return Err(invalid("Draco accessor type is invalid")),
        };
        decoded_bytes = count
            .checked_mul(component_bytes)
            .and_then(|bytes| bytes.checked_mul(components))
            .and_then(|bytes| decoded_bytes.checked_add(bytes))
            .ok_or_else(|| invalid("Draco decoded accessor bytes overflow"))?;
        if count > crate::decode_limits::MAX_GLTF_INDICES
            || decoded_bytes > crate::decode_limits::MAX_DECODED_CONTENT_BYTES
        {
            return Err(invalid("Draco decoded accessors exceed the leaf budget"));
        }
    }
    Ok(())
}

fn merge_embedded_buffers(
    document: &mut Value,
    buffers: &[Vec<u8>],
) -> Result<Vec<u8>, GlbDecodeError> {
    if buffers.is_empty() {
        return Err(GlbDecodeError::MissingBinaryBlob);
    }
    let mut binary = Vec::new();
    let mut base_offsets = Vec::with_capacity(buffers.len());
    let alignment = super::gltf_meshopt::document_binary_alignment(document);
    for buffer in buffers {
        while binary.len() % alignment != 0 {
            binary.push(0);
        }
        base_offsets.push(binary.len());
        let new_length = binary
            .len()
            .checked_add(buffer.len())
            .ok_or_else(|| invalid("Draco materialized buffer length overflows"))?;
        if new_length > MAX_MATERIALIZED_BYTES {
            return Err(invalid("Draco materialized data exceeds the decode budget"));
        }
        binary.extend_from_slice(buffer);
    }

    let views = document
        .get_mut("bufferViews")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("Draco document has no bufferViews array"))?;
    for view in views {
        let object = view
            .as_object_mut()
            .ok_or_else(|| invalid("bufferView is not an object"))?;
        let buffer_index = object
            .get("buffer")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .ok_or_else(|| invalid("bufferView buffer index is invalid"))?;
        let source = buffers
            .get(buffer_index)
            .ok_or_else(|| invalid("bufferView buffer index is out of range"))?;
        let offset = object
            .get("byteOffset")
            .and_then(Value::as_u64)
            .map_or(Ok(0), |offset| {
                usize::try_from(offset)
                    .map_err(|error| invalid(format!("bufferView offset is invalid: {error}")))
            })?;
        let length = object
            .get("byteLength")
            .and_then(Value::as_u64)
            .and_then(|length| usize::try_from(length).ok())
            .ok_or_else(|| invalid("bufferView byteLength is invalid"))?;
        if offset
            .checked_add(length)
            .is_none_or(|end| end > source.len())
        {
            return Err(invalid("bufferView range exceeds its materialized buffer"));
        }
        let merged_offset = base_offsets[buffer_index]
            .checked_add(offset)
            .ok_or_else(|| invalid("merged bufferView offset overflows"))?;
        object.insert("buffer".to_owned(), Value::from(0));
        if merged_offset == 0 {
            object.remove("byteOffset");
        } else {
            object.insert("byteOffset".to_owned(), Value::from(merged_offset));
        }
    }

    let root = document
        .as_object_mut()
        .ok_or_else(|| invalid("glTF root is not an object"))?;
    root.insert(
        "buffers".to_owned(),
        Value::Array(vec![serde_json::json!({ "byteLength": binary.len() })]),
    );
    Ok(binary)
}

fn document_uses_draco(document: &Value) -> bool {
    document
        .get("meshes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|mesh| mesh.get("primitives").and_then(Value::as_array))
        .flatten()
        .any(|primitive| {
            primitive
                .get("extensions")
                .and_then(|extensions| extensions.get(EXTENSION_NAME))
                .is_some()
        })
}

fn remove_empty_extension_declarations(document: &mut Value) {
    for key in ["extensionsUsed", "extensionsRequired"] {
        let remove = document
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        if remove {
            document
                .as_object_mut()
                .expect("glTF root object")
                .remove(key);
        }
    }
}

fn invalid(message: impl Into<String>) -> GlbDecodeError {
    GlbDecodeError::InvalidDocument(message.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::preflight_accessors;

    #[test]
    fn rejects_declared_draco_output_bomb_before_native_decompression() {
        let document = json!({
            "accessors": [{
                "componentType": 5126,
                "count": 100_000_000,
                "type": "VEC3"
            }]
        });
        let error = preflight_accessors(&document).expect_err("oversized accessor");
        assert!(error.to_string().contains("leaf budget"));
    }
}
