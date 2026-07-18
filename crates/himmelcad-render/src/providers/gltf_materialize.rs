//! Deterministic conversion of resolved glTF assets into one self-contained GLB.

use base64::Engine as _;
use serde_json::{Map, Value};

use super::{
    gltf_meshopt::{document_binary_alignment, encode_glb, glb_chunks},
    GlbDecodeError, ResolvedAssetBundle, ResolvedAssetKind,
};

const MAX_MATERIALIZED_BYTES: usize = crate::decode_limits::MAX_DECODED_CONTENT_BYTES;

/// Resolves every buffer, image and metadata schema and returns a GLB whose
/// downstream decode path can no longer observe an external URI.
pub(super) fn materialize_resolved_gltf(
    document_uri: &str,
    bytes: &[u8],
    bundle: &ResolvedAssetBundle,
) -> Result<Vec<u8>, GlbDecodeError> {
    if bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES {
        return Err(invalid("glTF document exceeds the encoded leaf limit"));
    }
    if bytes.get(..4) == Some(b"glTF") && bytes.get(4..8) == Some(1_u32.to_le_bytes().as_slice()) {
        if bundle
            .entries()
            .iter()
            .any(|entry| entry.owner_uri == document_uri)
        {
            return Err(invalid("external resources in glTF 1.0 are not supported"));
        }
        return Ok(bytes.to_vec());
    }
    let (mut document, embedded_binary) = parse_document(bytes)?;
    let alignment = document_binary_alignment(&document).max(4);
    let buffers = document
        .get("buffers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut binary = Vec::new();
    let mut buffer_offsets = Vec::with_capacity(buffers.len());
    for (index, buffer) in buffers.iter().enumerate() {
        align(&mut binary, alignment)?;
        let offset = binary.len();
        let object = buffer
            .as_object()
            .ok_or_else(|| invalid("glTF buffer is not an object"))?;
        let declared_length = usize_field(object, "byteLength")?;
        let source = match object.get("uri") {
            Some(Value::String(uri)) if is_data_uri(uri) => decode_data_uri(uri)?.1,
            Some(Value::String(uri)) => {
                resolved_bytes(bundle, document_uri, uri, ResolvedAssetKind::Buffer)?.to_vec()
            }
            Some(_) => return Err(invalid("glTF buffer URI is not a string")),
            None if index == 0 => embedded_binary
                .ok_or(GlbDecodeError::MissingBinaryBlob)?
                .to_vec(),
            None => return Err(invalid("only the first GLB buffer may omit uri")),
        };
        if source.len() < declared_length {
            return Err(invalid("resolved buffer is shorter than byteLength"));
        }
        extend_bounded(&mut binary, &source[..declared_length])?;
        buffer_offsets.push(offset);
    }
    rewrite_buffer_views(&mut document, &buffer_offsets)?;
    materialize_images(document_uri, bundle, &mut document, &mut binary, alignment)?;
    materialize_schema(document_uri, bundle, &mut document)?;
    normalize_single_buffer(&mut document, binary.len())?;
    encode_glb(&document, &binary)
}

fn parse_document(bytes: &[u8]) -> Result<(Value, Option<&[u8]>), GlbDecodeError> {
    if bytes.get(..4) == Some(b"glTF") {
        if bytes.get(4..8) != Some(2_u32.to_le_bytes().as_slice()) {
            return Err(invalid("unsupported GLB version"));
        }
        let declared = read_u32(bytes, 8)? as usize;
        if declared != bytes.len() {
            return Err(invalid("GLB byteLength does not match its payload"));
        }
        let (json, binary) = glb_chunks(bytes)?;
        let document = serde_json::from_slice(json)
            .map_err(|error| invalid(format!("invalid GLB JSON: {error}")))?;
        Ok((document, binary))
    } else {
        let document = serde_json::from_slice(bytes)
            .map_err(|error| invalid(format!("invalid glTF JSON: {error}")))?;
        Ok((document, None))
    }
}

fn rewrite_buffer_views(
    document: &mut Value,
    buffer_offsets: &[usize],
) -> Result<(), GlbDecodeError> {
    let Some(views) = document.get_mut("bufferViews") else {
        return Ok(());
    };
    let views = views
        .as_array_mut()
        .ok_or_else(|| invalid("glTF bufferViews is not an array"))?;
    for view in views {
        let object = view
            .as_object_mut()
            .ok_or_else(|| invalid("glTF bufferView is not an object"))?;
        rewrite_buffer_range(object, buffer_offsets)?;
        if let Some(meshopt) = object
            .get_mut("extensions")
            .and_then(|extensions| extensions.get_mut("EXT_meshopt_compression"))
            .and_then(Value::as_object_mut)
        {
            rewrite_buffer_range(meshopt, buffer_offsets)?;
        }
    }
    Ok(())
}

fn rewrite_buffer_range(
    object: &mut Map<String, Value>,
    buffer_offsets: &[usize],
) -> Result<(), GlbDecodeError> {
    let buffer_index = object
        .get("buffer")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| invalid("buffer range has an invalid buffer index"))?;
    let base = *buffer_offsets
        .get(buffer_index)
        .ok_or_else(|| invalid("buffer range references a missing buffer"))?;
    let local = object
        .get("byteOffset")
        .map(value_usize)
        .transpose()?
        .unwrap_or(0);
    let offset = base
        .checked_add(local)
        .ok_or_else(|| invalid("materialized buffer offset overflows"))?;
    object.insert("buffer".to_owned(), Value::from(0));
    object.insert("byteOffset".to_owned(), Value::from(offset));
    Ok(())
}

fn materialize_images(
    document_uri: &str,
    bundle: &ResolvedAssetBundle,
    document: &mut Value,
    binary: &mut Vec<u8>,
    alignment: usize,
) -> Result<(), GlbDecodeError> {
    let existing_view_count = document
        .get("bufferViews")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let Some(images) = document.get_mut("images") else {
        return Ok(());
    };
    let images = images
        .as_array_mut()
        .ok_or_else(|| invalid("glTF images is not an array"))?;
    let mut new_views = Vec::new();
    for image in images {
        let object = image
            .as_object_mut()
            .ok_or_else(|| invalid("glTF image is not an object"))?;
        let Some(uri) = object.get("uri").and_then(Value::as_str).map(str::to_owned) else {
            if object.contains_key("uri") {
                return Err(invalid("glTF image URI is not a string"));
            }
            continue;
        };
        let (data_mime, encoded) = if is_data_uri(&uri) {
            decode_data_uri(&uri)?
        } else {
            (
                None,
                resolved_bytes(bundle, document_uri, &uri, ResolvedAssetKind::Image)?.to_vec(),
            )
        };
        let sniffed = sniff_image_mime(&encoded)
            .ok_or_else(|| invalid("resolved image encoding is unsupported"))?;
        let declared = object
            .get("mimeType")
            .and_then(Value::as_str)
            .or(data_mime.as_deref());
        if declared.is_some_and(|mime| normalize_mime(mime) != sniffed) {
            return Err(invalid("resolved image MIME type does not match its bytes"));
        }
        align(binary, alignment)?;
        let byte_offset = binary.len();
        extend_bounded(binary, &encoded)?;
        let view_index = existing_view_count
            .checked_add(new_views.len())
            .ok_or_else(|| invalid("materialized image view index overflows"))?;
        new_views.push(serde_json::json!({
            "buffer": 0,
            "byteOffset": byte_offset,
            "byteLength": encoded.len(),
        }));
        object.remove("uri");
        object.insert("bufferView".to_owned(), Value::from(view_index));
        object.insert("mimeType".to_owned(), Value::String(sniffed.to_owned()));
    }
    if !new_views.is_empty() {
        let root = document
            .as_object_mut()
            .ok_or_else(|| invalid("glTF root is not an object"))?;
        let views = root
            .entry("bufferViews")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| invalid("glTF bufferViews is not an array"))?;
        views.extend(new_views);
    }
    Ok(())
}

fn materialize_schema(
    document_uri: &str,
    bundle: &ResolvedAssetBundle,
    document: &mut Value,
) -> Result<(), GlbDecodeError> {
    let Some(extension) = document
        .get_mut("extensions")
        .and_then(|extensions| extensions.get_mut("EXT_structural_metadata"))
        .and_then(Value::as_object_mut)
    else {
        return Ok(());
    };
    let Some(schema_uri) = extension
        .get("schemaUri")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(());
    };
    if extension.contains_key("schema") {
        return Err(invalid("structural metadata declares schema and schemaUri"));
    }
    let bytes = resolved_bytes(bundle, document_uri, &schema_uri, ResolvedAssetKind::Schema)?;
    let schema: Value = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("invalid external metadata schema: {error}")))?;
    if !schema.is_object() {
        return Err(invalid("external metadata schema is not an object"));
    }
    extension.remove("schemaUri");
    extension.insert("schema".to_owned(), schema);
    Ok(())
}

fn normalize_single_buffer(document: &mut Value, length: usize) -> Result<(), GlbDecodeError> {
    let root = document
        .as_object_mut()
        .ok_or_else(|| invalid("glTF root is not an object"))?;
    if length == 0 && !root.contains_key("buffers") {
        return Ok(());
    }
    root.insert(
        "buffers".to_owned(),
        Value::Array(vec![serde_json::json!({ "byteLength": length })]),
    );
    Ok(())
}

fn resolved_bytes<'a>(
    bundle: &'a ResolvedAssetBundle,
    owner_uri: &str,
    source_uri: &str,
    expected_kind: ResolvedAssetKind,
) -> Result<&'a [u8], GlbDecodeError> {
    let entry = bundle
        .lookup(owner_uri, source_uri)
        .ok_or_else(|| GlbDecodeError::ExternalResource(format!("{owner_uri} -> {source_uri}")))?;
    if entry.kind != expected_kind {
        return Err(invalid("resolved asset has the wrong semantic kind"));
    }
    bundle
        .bytes(entry)
        .map_err(|error| invalid(error.to_string()))
}

fn decode_data_uri(uri: &str) -> Result<(Option<String>, Vec<u8>), GlbDecodeError> {
    let payload = uri
        .get(5..)
        .ok_or_else(|| invalid("data URI is truncated"))?;
    let (metadata, encoded) = payload
        .split_once(',')
        .ok_or_else(|| invalid("data URI has no comma"))?;
    let mut parts = metadata.split(';');
    let mime = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(normalize_mime)
        .map(str::to_owned);
    let parameters = parts.collect::<Vec<_>>();
    let base64 = parameters
        .last()
        .is_some_and(|value| value.eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| invalid(format!("invalid base64 data URI: {error}")))?
    } else {
        percent_decode(encoded)?
    };
    if bytes.len() > MAX_MATERIALIZED_BYTES {
        return Err(invalid(
            "decoded data URI exceeds the materialization limit",
        ));
    }
    Ok((mime, bytes))
}

fn percent_decode(value: &str) -> Result<Vec<u8>, GlbDecodeError> {
    let source = value.as_bytes();
    let mut output = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            let high = source
                .get(index + 1)
                .and_then(|byte| hex(*byte))
                .ok_or_else(|| invalid("invalid percent escape in data URI"))?;
            let low = source
                .get(index + 2)
                .and_then(|byte| hex(*byte))
                .ok_or_else(|| invalid("invalid percent escape in data URI"))?;
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(source[index]);
            index += 1;
        }
    }
    Ok(output)
}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\xabKTX 20\xbb\r\n\x1a\n") {
        Some("image/ktx2")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

fn normalize_mime(value: &str) -> &str {
    value.split(';').next().unwrap_or(value).trim()
}

fn is_data_uri(uri: &str) -> bool {
    uri.get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

fn align(output: &mut Vec<u8>, alignment: usize) -> Result<(), GlbDecodeError> {
    while !output.len().is_multiple_of(alignment) {
        extend_bounded(output, &[0])?;
    }
    Ok(())
}

fn extend_bounded(output: &mut Vec<u8>, bytes: &[u8]) -> Result<(), GlbDecodeError> {
    if output
        .len()
        .checked_add(bytes.len())
        .is_none_or(|length| length > MAX_MATERIALIZED_BYTES)
    {
        return Err(invalid("materialized glTF exceeds the decode budget"));
    }
    output.extend_from_slice(bytes);
    Ok(())
}

fn usize_field(object: &Map<String, Value>, name: &str) -> Result<usize, GlbDecodeError> {
    object
        .get(name)
        .ok_or_else(|| invalid(format!("missing {name}")))
        .and_then(value_usize)
}

fn value_usize(value: &Value) -> Result<usize, GlbDecodeError> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| invalid("integer field exceeds the platform range"))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, GlbDecodeError> {
    bytes
        .get(offset..offset + 4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| invalid("truncated GLB integer"))
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn invalid(message: impl Into<String>) -> GlbDecodeError {
    GlbDecodeError::InvalidDocument(message.into())
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;

    use crate::{
        decode_gltf_intrinsic_with_resources, AssetBundleLimits, ResolvedAssetBundle,
        ResolvedAssetInput, ResolvedAssetKind, WorldTransform,
    };

    #[test]
    fn external_buffer_image_and_schema_decode_through_the_common_glb_path() {
        let mut mesh = Vec::new();
        for position in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for component in position {
                mesh.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2] {
            mesh.extend(index.to_le_bytes());
        }
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+N8N1AAAAAElFTkSuQmCC")
            .expect("fixture png");
        let schema = br#"{"id":"fixture","classes":{}}"#;
        let document = serde_json::to_vec(&serde_json::json!({
            "asset": { "version": "2.0" },
            "extensionsUsed": ["EXT_structural_metadata"],
            "extensions": {
                "EXT_structural_metadata": { "schemaUri": "metadata.schema.json" }
            },
            "buffers": [{ "uri": "geometry/mesh.bin", "byteLength": mesh.len() }],
            "bufferViews": [
                { "buffer": 0, "byteOffset": 0, "byteLength": 36, "target": 34962 },
                { "buffer": 0, "byteOffset": 36, "byteLength": 6, "target": 34963 }
            ],
            "accessors": [
                {
                    "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
                    "min": [0, 0, 0], "max": [1, 1, 0]
                },
                { "bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR" }
            ],
            "images": [{ "uri": "textures/albedo.png" }],
            "textures": [{ "source": 0 }],
            "materials": [{
                "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 } }
            }],
            "meshes": [{
                "primitives": [{
                    "attributes": { "POSITION": 0 }, "indices": 1, "material": 0
                }]
            }],
            "nodes": [{ "mesh": 0 }],
            "scenes": [{ "nodes": [0] }],
            "scene": 0
        }))
        .expect("document");
        let bundle = ResolvedAssetBundle::build(
            &[
                ResolvedAssetInput {
                    owner_uri: "https://example.test/models/tree.gltf",
                    source_uri: "geometry/mesh.bin",
                    resolved_uri: "https://example.test/models/geometry/mesh.bin",
                    kind: ResolvedAssetKind::Buffer,
                    bytes: &mesh,
                },
                ResolvedAssetInput {
                    owner_uri: "https://example.test/models/tree.gltf",
                    source_uri: "textures/albedo.png",
                    resolved_uri: "https://example.test/models/textures/albedo.png",
                    kind: ResolvedAssetKind::Image,
                    bytes: &png,
                },
                ResolvedAssetInput {
                    owner_uri: "https://example.test/models/tree.gltf",
                    source_uri: "metadata.schema.json",
                    resolved_uri: "https://example.test/models/metadata.schema.json",
                    kind: ResolvedAssetKind::Schema,
                    bytes: schema,
                },
            ],
            AssetBundleLimits::default(),
        )
        .expect("bundle");

        let decoded = decode_gltf_intrinsic_with_resources(
            "https://example.test/models/tree.gltf",
            &document,
            &bundle,
            WorldTransform::IDENTITY,
        )
        .expect("resolved glTF");
        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices, [0, 1, 2]);
        assert_eq!(decoded.images.len(), 1);
        assert_eq!(decoded.images[0].mime_type, "image/png");
        assert_eq!(
            decoded
                .structural_metadata
                .expect("metadata")
                .schema
                .expect("schema")["id"],
            "fixture"
        );
    }

    #[test]
    fn percent_encoded_data_buffer_never_requires_a_bundle_entry() {
        let document = br#"{
          "asset":{"version":"2.0"},
          "buffers":[{"uri":"data:application/octet-stream,%00%00%00%00","byteLength":4}],
          "bufferViews":[]
        }"#;
        let bundle =
            ResolvedAssetBundle::build(&[], AssetBundleLimits::default()).expect("empty bundle");
        let materialized =
            super::materialize_resolved_gltf("https://example.test/empty.gltf", document, &bundle)
                .expect("data URI");
        assert_eq!(&materialized[..4], b"glTF");
    }
}
