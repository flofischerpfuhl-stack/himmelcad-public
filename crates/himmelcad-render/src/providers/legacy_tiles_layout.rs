//! Structural validation shared by legacy 3D Tiles inspection and decoding.

const COMMON_HEADER_BYTES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LegacyLayoutError(pub(super) &'static str);

#[derive(Debug, Clone, Copy)]
pub(super) struct LegacyTableSections<'a> {
    pub(super) feature_json: &'a [u8],
    pub(super) feature_binary: &'a [u8],
    pub(super) batch_json: &'a [u8],
    pub(super) batch_binary: &'a [u8],
    pub(super) payload: &'a [u8],
}

pub(super) fn validate_common_tile(
    bytes: &[u8],
    expected_magic: [u8; 4],
    minimum: usize,
) -> Result<(), LegacyLayoutError> {
    if bytes.len() < minimum || bytes.get(..4) != Some(expected_magic.as_slice()) {
        return Err(LegacyLayoutError("magic or minimum byte length"));
    }
    if read_u32(bytes, 4)? != 1 {
        return Err(LegacyLayoutError("unsupported legacy tile version"));
    }
    let declared = usize::try_from(read_u32(bytes, 8)?)
        .map_err(|_| LegacyLayoutError("declared byteLength is too large"))?;
    if declared != bytes.len() {
        return Err(LegacyLayoutError(
            "declared byteLength does not match payload",
        ));
    }
    if !bytes.len().is_multiple_of(8) {
        return Err(LegacyLayoutError(
            "legacy tile byteLength is not 8-byte aligned",
        ));
    }
    Ok(())
}

pub(super) fn validate_table_tile(
    bytes: &[u8],
    expected_magic: [u8; 4],
    header_bytes: usize,
) -> Result<LegacyTableSections<'_>, LegacyLayoutError> {
    validate_common_tile(bytes, expected_magic, header_bytes)?;
    let lengths = [
        read_u32(bytes, 12)?,
        read_u32(bytes, 16)?,
        read_u32(bytes, 20)?,
        read_u32(bytes, 24)?,
    ];
    let mut offsets = [header_bytes; 5];
    for (index, length) in lengths.into_iter().enumerate() {
        offsets[index + 1] = offsets[index]
            .checked_add(
                usize::try_from(length)
                    .map_err(|_| LegacyLayoutError("table section is too large"))?,
            )
            .filter(|offset| *offset <= bytes.len())
            .ok_or(LegacyLayoutError("table section exceeds byteLength"))?;
        if !offsets[index + 1].is_multiple_of(8) {
            return Err(LegacyLayoutError(
                "feature or batch table boundary is not 8-byte aligned",
            ));
        }
    }
    if lengths[2] == 0 && lengths[3] != 0 {
        return Err(LegacyLayoutError(
            "batch table binary exists without batch table JSON",
        ));
    }
    Ok(LegacyTableSections {
        feature_json: &bytes[offsets[0]..offsets[1]],
        feature_binary: &bytes[offsets[1]..offsets[2]],
        batch_json: &bytes[offsets[2]..offsets[3]],
        batch_binary: &bytes[offsets[3]..offsets[4]],
        payload: &bytes[offsets[4]..],
    })
}

pub(super) fn embedded_glb(payload: &[u8]) -> Result<&[u8], LegacyLayoutError> {
    if payload.len() < COMMON_HEADER_BYTES || payload.get(..4) != Some(b"glTF") {
        return Err(LegacyLayoutError("tile has no embedded GLB payload"));
    }
    let version = read_u32(payload, 4)?;
    let minimum = match version {
        1 => 20,
        2 => COMMON_HEADER_BYTES,
        _ => return Err(LegacyLayoutError("unsupported embedded GLB version")),
    };
    let declared = usize::try_from(read_u32(payload, 8)?)
        .map_err(|_| LegacyLayoutError("embedded GLB byteLength is too large"))?;
    if declared < minimum || !declared.is_multiple_of(4) {
        return Err(LegacyLayoutError(
            "embedded GLB byteLength or alignment is invalid",
        ));
    }
    let glb = payload
        .get(..declared)
        .ok_or(LegacyLayoutError("embedded GLB is truncated"))?;
    if payload[declared..]
        .iter()
        .any(|byte| !matches!(byte, 0 | b' '))
    {
        return Err(LegacyLayoutError("invalid embedded GLB padding"));
    }
    Ok(glb)
}

pub(super) fn parse_i3dm_uri(payload: &[u8]) -> Result<&str, LegacyLayoutError> {
    if payload.is_empty() {
        return Err(LegacyLayoutError("empty i3dm glTF URI"));
    }
    if payload.contains(&0) {
        return Err(LegacyLayoutError("NUL-padded i3dm glTF URI"));
    }
    let end = payload
        .iter()
        .rposition(|byte| *byte != b' ')
        .map_or(0, |index| index + 1);
    let uri = &payload[..end];
    if uri.is_empty()
        || uri
            .iter()
            .any(|byte| byte.is_ascii_control() || *byte == b' ')
    {
        return Err(LegacyLayoutError(
            "i3dm glTF URI contains non-padding whitespace",
        ));
    }
    std::str::from_utf8(uri).map_err(|_| LegacyLayoutError("non-UTF-8 i3dm glTF URI"))
}

pub(super) fn trim_json_space_padding(bytes: &[u8]) -> &[u8] {
    let end = bytes
        .iter()
        .rposition(|byte| *byte != b' ')
        .map_or(0, |index| index + 1);
    &bytes[..end]
}

pub(super) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, LegacyLayoutError> {
    bytes
        .get(offset..offset.saturating_add(4))
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(LegacyLayoutError("truncated uint32"))
}
