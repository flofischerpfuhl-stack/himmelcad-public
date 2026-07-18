//! `EXT_meshopt_compression` materialization for embedded GLB content.

use serde_json::{Map, Value};

use super::GlbDecodeError;

const GLB_MAGIC: &[u8; 4] = b"glTF";
const GLB_JSON_CHUNK: u32 = 0x4e4f_534a;
const GLB_BIN_CHUNK: u32 = 0x004e_4942;
const EXTENSION_NAME: &str = "EXT_meshopt_compression";
const MAX_MATERIALIZED_BYTES: usize = crate::decode_limits::MAX_DECODED_CONTENT_BYTES;

/// Returns a standards-equivalent uncompressed GLB when meshopt buffer views
/// are present, or `None` when the document does not use the extension.
pub(super) fn materialize_meshopt_glb(bytes: &[u8]) -> Result<Option<Vec<u8>>, GlbDecodeError> {
    if bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES {
        return Err(invalid("meshopt GLB exceeds the encoded leaf limit"));
    }
    if bytes.len() < 12 || bytes.get(..4) != Some(GLB_MAGIC) || read_u32(bytes, 4)? != 2 {
        return Ok(None);
    }
    let declared_length = usize::try_from(read_u32(bytes, 8)?).map_err(invalid_number)?;
    if declared_length != bytes.len() {
        return Err(invalid("GLB length does not match its header"));
    }
    let (json_bytes, binary) = glb_chunks(bytes)?;
    let mut document: Value = serde_json::from_slice(json_bytes)
        .map_err(|error| invalid(format!("invalid GLB JSON: {error}")))?;
    if !document_uses_meshopt(&document) {
        return Ok(None);
    }
    let materialized_alignment = document_binary_alignment(&document);
    let source_binary = binary.ok_or(GlbDecodeError::MissingBinaryBlob)?;
    let mut materialized = source_binary.to_vec();
    let views = document
        .get_mut("bufferViews")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("meshopt document has no bufferViews array"))?;
    let mut decoded_any = false;

    for view in views {
        let Some(view_object) = view.as_object_mut() else {
            return Err(invalid("bufferView is not an object"));
        };
        let Some(extension) = take_meshopt_extension(view_object)? else {
            continue;
        };
        decoded_any = true;
        let descriptor = MeshoptView::parse(&extension)?;
        let decoded_length = descriptor.decoded_length()?;
        if decoded_length > MAX_MATERIALIZED_BYTES
            || materialized
                .len()
                .checked_add(decoded_length)
                .is_none_or(|length| length > MAX_MATERIALIZED_BYTES)
        {
            return Err(invalid(
                "meshopt materialized data exceeds the decode budget",
            ));
        }
        if descriptor.buffer != 0 {
            return Err(GlbDecodeError::ExternalResource(format!(
                "meshopt buffer {}",
                descriptor.buffer
            )));
        }
        let source_end = descriptor
            .byte_offset
            .checked_add(descriptor.byte_length)
            .ok_or_else(|| invalid("meshopt source range overflows"))?;
        let compressed = source_binary
            .get(descriptor.byte_offset..source_end)
            .ok_or_else(|| invalid("meshopt source range exceeds the GLB binary chunk"))?;
        let decoded = descriptor.decode(compressed)?;
        while materialized.len() % materialized_alignment != 0 {
            materialized.push(0);
        }
        let output_offset = materialized.len();
        materialized.extend_from_slice(&decoded);
        view_object.insert("buffer".to_owned(), Value::from(0));
        view_object.insert("byteOffset".to_owned(), Value::from(output_offset));
        view_object.insert("byteLength".to_owned(), Value::from(decoded_length));
        if descriptor.mode == MeshoptMode::Attributes {
            view_object.insert("byteStride".to_owned(), Value::from(descriptor.byte_stride));
        } else {
            view_object.remove("byteStride");
        }
    }
    if !decoded_any {
        return Err(invalid(
            "EXT_meshopt_compression is declared but no compressed bufferView exists",
        ));
    }
    normalize_buffers(&mut document, materialized.len())?;
    remove_extension_declaration(&mut document);
    encode_glb(&document, &materialized).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeshoptMode {
    Attributes,
    Triangles,
    Indices,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeshoptFilter {
    None,
    Octahedral,
    Quaternion,
    Exponential,
}

#[derive(Debug, Clone, Copy)]
struct MeshoptView {
    buffer: usize,
    byte_offset: usize,
    byte_length: usize,
    byte_stride: usize,
    count: usize,
    mode: MeshoptMode,
    filter: MeshoptFilter,
}

impl MeshoptView {
    fn parse(value: &Value) -> Result<Self, GlbDecodeError> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid("meshopt extension is not an object"))?;
        let mode = match string_field(object, "mode")? {
            "ATTRIBUTES" => MeshoptMode::Attributes,
            "TRIANGLES" => MeshoptMode::Triangles,
            "INDICES" => MeshoptMode::Indices,
            other => return Err(invalid(format!("unsupported meshopt mode {other}"))),
        };
        let filter = match object
            .get("filter")
            .and_then(Value::as_str)
            .unwrap_or("NONE")
        {
            "NONE" => MeshoptFilter::None,
            "OCTAHEDRAL" => MeshoptFilter::Octahedral,
            "QUATERNION" => MeshoptFilter::Quaternion,
            "EXPONENTIAL" => MeshoptFilter::Exponential,
            other => return Err(invalid(format!("unsupported meshopt filter {other}"))),
        };
        let descriptor = Self {
            buffer: usize_field(object, "buffer")?,
            byte_offset: optional_usize_field(object, "byteOffset")?.unwrap_or(0),
            byte_length: usize_field(object, "byteLength")?,
            byte_stride: usize_field(object, "byteStride")?,
            count: usize_field(object, "count")?,
            mode,
            filter,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    fn validate(self) -> Result<(), GlbDecodeError> {
        match self.mode {
            MeshoptMode::Attributes
                if self.byte_stride == 0 || self.byte_stride > 256 || self.byte_stride % 4 != 0 =>
            {
                Err(invalid(
                    "meshopt attribute stride must be 4..=256 and divisible by 4",
                ))
            }
            MeshoptMode::Triangles if !matches!(self.byte_stride, 2 | 4) => {
                Err(invalid("meshopt triangle index stride must be 2 or 4"))
            }
            MeshoptMode::Triangles if self.count % 3 != 0 => {
                Err(invalid("meshopt triangle count must be divisible by 3"))
            }
            MeshoptMode::Indices if !matches!(self.byte_stride, 2 | 4) => {
                Err(invalid("meshopt index stride must be 2 or 4"))
            }
            _ => self.validate_filter(),
        }
    }

    fn validate_filter(self) -> Result<(), GlbDecodeError> {
        let valid = match self.filter {
            MeshoptFilter::None => true,
            MeshoptFilter::Octahedral => {
                self.mode == MeshoptMode::Attributes && matches!(self.byte_stride, 4 | 8)
            }
            MeshoptFilter::Quaternion => {
                self.mode == MeshoptMode::Attributes && self.byte_stride == 8
            }
            MeshoptFilter::Exponential => self.mode == MeshoptMode::Attributes,
        };
        if valid {
            Ok(())
        } else {
            Err(invalid(
                "meshopt filter is incompatible with mode or stride",
            ))
        }
    }

    fn decoded_length(self) -> Result<usize, GlbDecodeError> {
        self.count
            .checked_mul(self.byte_stride)
            .ok_or_else(|| invalid("meshopt decoded length overflows"))
    }

    fn decode(self, compressed: &[u8]) -> Result<Vec<u8>, GlbDecodeError> {
        match self.mode {
            MeshoptMode::Attributes => {
                let mut output = decode_attributes(self.count, self.byte_stride, compressed)?;
                apply_filter(&mut output, self.byte_stride, self.filter)?;
                Ok(output)
            }
            MeshoptMode::Triangles => {
                decode_indices(self.count, self.byte_stride, compressed, true)
            }
            MeshoptMode::Indices => decode_indices(self.count, self.byte_stride, compressed, false),
        }
    }
}

fn decode_attributes(
    count: usize,
    stride: usize,
    compressed: &[u8],
) -> Result<Vec<u8>, GlbDecodeError> {
    fn decode<const STRIDE: usize>(
        count: usize,
        compressed: &[u8],
    ) -> Result<Vec<u8>, GlbDecodeError> {
        let mut values = vec![[0_u8; STRIDE]; count];
        meshopt_rs::vertex::buffer::decode_vertex_buffer(&mut values, compressed)
            .map_err(|error| invalid(format!("meshopt attribute decode failed: {error:?}")))?;
        Ok(values.into_iter().flatten().collect())
    }

    macro_rules! strides {
        ($($stride:literal),+ $(,)?) => {
            match stride {
                $($stride => decode::<$stride>(count, compressed),)+
                _ => Err(invalid("unsupported meshopt attribute stride")),
            }
        };
    }
    strides!(
        4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92,
        96, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 148, 152, 156, 160, 164,
        168, 172, 176, 180, 184, 188, 192, 196, 200, 204, 208, 212, 216, 220, 224, 228, 232, 236,
        240, 244, 248, 252, 256
    )
}

fn apply_filter(
    output: &mut [u8],
    stride: usize,
    filter: MeshoptFilter,
) -> Result<(), GlbDecodeError> {
    match filter {
        MeshoptFilter::None => Ok(()),
        MeshoptFilter::Octahedral if stride == 4 => {
            let mut values: Vec<[u8; 4]> = output
                .chunks_exact(4)
                .map(|chunk| chunk.try_into().expect("exact chunks"))
                .collect();
            meshopt_rs::vertex::filter::decode_filter_oct_8(&mut values);
            for (target, value) in output.chunks_exact_mut(4).zip(values) {
                target.copy_from_slice(&value);
            }
            Ok(())
        }
        MeshoptFilter::Octahedral if stride == 8 => {
            apply_u16x4_filter(output, meshopt_rs::vertex::filter::decode_filter_oct_16)
        }
        MeshoptFilter::Quaternion => {
            apply_u16x4_filter(output, meshopt_rs::vertex::filter::decode_filter_quat)
        }
        MeshoptFilter::Exponential => {
            let mut values: Vec<u32> = output
                .chunks_exact(4)
                .map(|chunk| u32::from_le_bytes(chunk.try_into().expect("exact chunks")))
                .collect();
            meshopt_rs::vertex::filter::decode_filter_exp(&mut values);
            for (target, value) in output.chunks_exact_mut(4).zip(values) {
                target.copy_from_slice(&value.to_le_bytes());
            }
            Ok(())
        }
        MeshoptFilter::Octahedral => Err(invalid("invalid meshopt filter configuration")),
    }
}

fn apply_u16x4_filter(
    output: &mut [u8],
    filter: fn(&mut [[u16; 4]]),
) -> Result<(), GlbDecodeError> {
    if output.len() % 8 != 0 {
        return Err(invalid("meshopt 16-bit filter data is misaligned"));
    }
    let mut values: Vec<[u16; 4]> = output
        .chunks_exact(8)
        .map(|chunk| {
            std::array::from_fn(|index| {
                u16::from_le_bytes([chunk[index * 2], chunk[index * 2 + 1]])
            })
        })
        .collect();
    filter(&mut values);
    for (target, value) in output.chunks_exact_mut(8).zip(values) {
        for (word, bytes) in value.into_iter().zip(target.chunks_exact_mut(2)) {
            bytes.copy_from_slice(&word.to_le_bytes());
        }
    }
    Ok(())
}

fn decode_indices(
    count: usize,
    stride: usize,
    compressed: &[u8],
    triangles: bool,
) -> Result<Vec<u8>, GlbDecodeError> {
    let mut values = vec![0_u32; count];
    let result = if triangles {
        meshopt_rs::index::buffer::decode_index_buffer(&mut values, compressed)
    } else {
        meshopt_rs::index::sequence::decode_index_sequence(&mut values, compressed)
    };
    result.map_err(|error| invalid(format!("meshopt index decode failed: {error:?}")))?;
    let mut output = Vec::with_capacity(count * stride);
    for value in values {
        if stride == 2 {
            let value = u16::try_from(value)
                .map_err(|_| invalid("meshopt index exceeds its 16-bit bufferView stride"))?;
            output.extend_from_slice(&value.to_le_bytes());
        } else {
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(output)
}

fn take_meshopt_extension(view: &mut Map<String, Value>) -> Result<Option<Value>, GlbDecodeError> {
    let Some(extensions) = view.get_mut("extensions") else {
        return Ok(None);
    };
    let extensions = extensions
        .as_object_mut()
        .ok_or_else(|| invalid("bufferView extensions is not an object"))?;
    let extension = extensions.remove(EXTENSION_NAME);
    if extensions.is_empty() {
        view.remove("extensions");
    }
    Ok(extension)
}

fn normalize_buffers(document: &mut Value, binary_length: usize) -> Result<(), GlbDecodeError> {
    let referenced_external = document
        .get("bufferViews")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|view| view.get("buffer").and_then(Value::as_u64))
        .any(|buffer| buffer != 0);
    if referenced_external {
        return Err(GlbDecodeError::ExternalResource(
            "non-binary GLB bufferView".to_owned(),
        ));
    }
    let buffers = document
        .get_mut("buffers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("GLB buffers array is missing"))?;
    let first = buffers
        .first_mut()
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("GLB binary buffer is missing"))?;
    first.remove("uri");
    first.insert("byteLength".to_owned(), Value::from(binary_length));
    buffers.truncate(1);
    Ok(())
}

fn remove_extension_declaration(document: &mut Value) {
    for key in ["extensionsUsed", "extensionsRequired"] {
        let remove_key =
            if let Some(extensions) = document.get_mut(key).and_then(Value::as_array_mut) {
                extensions.retain(|extension| extension.as_str() != Some(EXTENSION_NAME));
                extensions.is_empty()
            } else {
                false
            };
        if remove_key {
            document
                .as_object_mut()
                .expect("glTF root object")
                .remove(key);
        }
    }
}

pub(super) fn encode_glb(document: &Value, binary: &[u8]) -> Result<Vec<u8>, GlbDecodeError> {
    let alignment = document_binary_alignment(document);
    let mut json = serde_json::to_vec(document)
        .map_err(|error| invalid(format!("cannot encode materialized GLB JSON: {error}")))?;
    while json.len() % alignment != 0 {
        json.push(b' ');
    }
    let mut padded_binary = binary.to_vec();
    while padded_binary.len() % alignment != 0 {
        padded_binary.push(0);
    }
    let total_length = 12_usize
        .checked_add(8 + json.len())
        .and_then(|length| length.checked_add(8 + padded_binary.len()))
        .ok_or_else(|| invalid("materialized GLB length overflows"))?;
    let total_length = u32::try_from(total_length)
        .map_err(|_| invalid("materialized GLB exceeds the GLB 32-bit length limit"))?;
    let json_length = u32::try_from(json.len()).map_err(invalid_number)?;
    let binary_length = u32::try_from(padded_binary.len()).map_err(invalid_number)?;
    let mut output = Vec::with_capacity(total_length as usize);
    output.extend_from_slice(GLB_MAGIC);
    output.extend_from_slice(&2_u32.to_le_bytes());
    output.extend_from_slice(&total_length.to_le_bytes());
    output.extend_from_slice(&json_length.to_le_bytes());
    output.extend_from_slice(&GLB_JSON_CHUNK.to_le_bytes());
    output.extend_from_slice(&json);
    output.extend_from_slice(&binary_length.to_le_bytes());
    output.extend_from_slice(&GLB_BIN_CHUNK.to_le_bytes());
    output.extend_from_slice(&padded_binary);
    Ok(output)
}

pub(super) fn document_binary_alignment(document: &Value) -> usize {
    let structural_metadata = document
        .get("extensions")
        .and_then(|extensions| extensions.get("EXT_structural_metadata"))
        .is_some()
        || document
            .get("extensionsUsed")
            .and_then(Value::as_array)
            .is_some_and(|extensions| {
                extensions
                    .iter()
                    .any(|extension| extension.as_str() == Some("EXT_structural_metadata"))
            });
    if structural_metadata {
        8
    } else {
        4
    }
}

pub(super) fn glb_chunks(bytes: &[u8]) -> Result<(&[u8], Option<&[u8]>), GlbDecodeError> {
    let mut offset = 12_usize;
    let mut json = None;
    let mut binary = None;
    while offset < bytes.len() {
        let header_end = offset
            .checked_add(8)
            .ok_or_else(|| invalid("GLB chunk header overflows"))?;
        if header_end > bytes.len() {
            return Err(invalid("truncated GLB chunk header"));
        }
        let length = usize::try_from(read_u32(bytes, offset)?).map_err(invalid_number)?;
        let kind = read_u32(bytes, offset + 4)?;
        let data_end = header_end
            .checked_add(length)
            .ok_or_else(|| invalid("GLB chunk range overflows"))?;
        let data = bytes
            .get(header_end..data_end)
            .ok_or_else(|| invalid("truncated GLB chunk"))?;
        match kind {
            GLB_JSON_CHUNK if json.is_none() => json = Some(data),
            GLB_BIN_CHUNK if binary.is_none() => binary = Some(data),
            _ => {}
        }
        offset = data_end;
    }
    let json = json.ok_or_else(|| invalid("GLB JSON chunk is missing"))?;
    Ok((json, binary))
}

fn document_uses_meshopt(document: &Value) -> bool {
    ["extensionsUsed", "extensionsRequired"]
        .into_iter()
        .any(|key| {
            document
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|extensions| {
                    extensions
                        .iter()
                        .any(|extension| extension.as_str() == Some(EXTENSION_NAME))
                })
        })
        || document
            .get("bufferViews")
            .and_then(Value::as_array)
            .is_some_and(|views| {
                views.iter().any(|view| {
                    view.get("extensions")
                        .and_then(|extensions| extensions.get(EXTENSION_NAME))
                        .is_some()
                })
            })
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, GlbDecodeError> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| invalid("truncated GLB integer"))?;
    Ok(u32::from_le_bytes(
        value.try_into().expect("four-byte slice"),
    ))
}

fn usize_field(object: &Map<String, Value>, key: &str) -> Result<usize, GlbDecodeError> {
    optional_usize_field(object, key)?.ok_or_else(|| invalid(format!("meshopt {key} is missing")))
}

fn optional_usize_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<usize>, GlbDecodeError> {
    object
        .get(key)
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| invalid(format!("meshopt {key} is not an unsigned integer")))
                .and_then(|value| usize::try_from(value).map_err(invalid_number))
        })
        .transpose()
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, GlbDecodeError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("meshopt {key} is missing or not a string")))
}

fn invalid(message: impl Into<String>) -> GlbDecodeError {
    GlbDecodeError::InvalidDocument(message.into())
}

fn invalid_number(error: impl std::fmt::Display) -> GlbDecodeError {
    invalid(format!("numeric conversion failed: {error}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{encode_glb, glb_chunks, materialize_meshopt_glb};

    #[test]
    fn structural_metadata_reencoding_preserves_eight_byte_chunk_alignment() {
        let document = json!({
            "asset": { "version": "2.0" },
            "extensionsUsed": ["EXT_structural_metadata"],
            "extensions": { "EXT_structural_metadata": { "schema": { "classes": {} } } },
            "buffers": [{ "byteLength": 5 }]
        });
        let encoded = encode_glb(&document, &[1, 2, 3, 4, 5]).expect("encoded GLB");
        let (json, binary) = glb_chunks(&encoded).expect("GLB chunks");
        assert!(json.len().is_multiple_of(8));
        assert!(binary.expect("BIN").len().is_multiple_of(8));
    }

    #[test]
    fn rejects_meshopt_output_bomb_before_decoder_allocation() {
        let document = json!({
            "asset": { "version": "2.0" },
            "extensionsUsed": ["EXT_meshopt_compression"],
            "buffers": [{ "byteLength": 1 }],
            "bufferViews": [{
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": 1,
                "extensions": {
                    "EXT_meshopt_compression": {
                        "buffer": 0,
                        "byteOffset": 0,
                        "byteLength": 1,
                        "byteStride": 256,
                        "count": 3_000_000,
                        "mode": "ATTRIBUTES"
                    }
                }
            }]
        });
        let glb = encode_glb(&document, &[0]).expect("test GLB");
        let error = materialize_meshopt_glb(&glb).expect_err("oversized meshopt output");
        assert!(error.to_string().contains("decode budget"));
    }
}
