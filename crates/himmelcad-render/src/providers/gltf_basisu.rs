//! glTF KTX2 texture-source normalization.

use serde_json::Value;

use super::GlbDecodeError;

const EXTENSION_NAME: &str = "KHR_texture_basisu";

pub(super) fn materialize_basisu_sources(bytes: &[u8]) -> Result<Option<Vec<u8>>, GlbDecodeError> {
    let (json, binary) = super::gltf_meshopt::glb_chunks(bytes)?;
    let mut document: Value = serde_json::from_slice(json)
        .map_err(|error| invalid(format!("invalid GLB JSON: {error}")))?;
    let Some(textures) = document.get_mut("textures").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let mut changed = false;
    for texture in textures {
        let Some(texture) = texture.as_object_mut() else {
            return Err(invalid("glTF texture is not an object"));
        };
        let (source, extensions_empty) = {
            let Some(extensions) = texture.get_mut("extensions") else {
                continue;
            };
            let extensions = extensions
                .as_object_mut()
                .ok_or_else(|| invalid("texture extensions is not an object"))?;
            let Some(extension) = extensions.remove(EXTENSION_NAME) else {
                continue;
            };
            let source = extension
                .get("source")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid("KHR_texture_basisu source is missing or invalid"))?;
            (source, extensions.is_empty())
        };
        texture.insert("source".to_owned(), Value::from(source));
        if extensions_empty {
            texture.remove("extensions");
        }
        changed = true;
    }
    if !changed {
        return Ok(None);
    }
    for key in ["extensionsUsed", "extensionsRequired"] {
        let remove = if let Some(extensions) = document.get_mut(key).and_then(Value::as_array_mut) {
            extensions.retain(|extension| extension.as_str() != Some(EXTENSION_NAME));
            extensions.is_empty()
        } else {
            false
        };
        if remove {
            document
                .as_object_mut()
                .expect("glTF root object")
                .remove(key);
        }
    }
    let binary = binary.ok_or(GlbDecodeError::MissingBinaryBlob)?;
    super::gltf_meshopt::encode_glb(&document, binary).map(Some)
}

fn invalid(message: impl Into<String>) -> GlbDecodeError {
    GlbDecodeError::InvalidDocument(message.into())
}
