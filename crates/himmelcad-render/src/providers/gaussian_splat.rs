//! Bounded Brush/3DGS PLY decoding for the shared Gaussian provider.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::{WorldAabb, WorldVec3};

const HEADER_LIMIT: usize = 1024 * 1024;
const SH_C0: f64 = 0.282_094_791_773_878_14;
const INTERLEAVED_V1_STRIDE: usize = 44;

/// One decoded anisotropic Gaussian in tile-local coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DecodedGaussianSplat {
    /// Position relative to the decoded tile origin.
    pub position: [f32; 3],
    /// Positive one-sigma local-axis radii.
    pub scale: [f32; 3],
    /// Normalized XYZW local-to-world quaternion.
    pub rotation: [f32; 4],
    /// Linear/source RGB and opacity bytes.
    pub color: [u8; 4],
}

/// Decoded PLY tile with immutable source-space placement metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedGaussianSplats {
    /// f64 source-space center subtracted before f32 conversion.
    pub origin: WorldVec3,
    /// Exact source-space center bounds.
    pub bounds: WorldAabb,
    /// Decoded tile-local splats.
    pub splats: Vec<DecodedGaussianSplat>,
    /// Authoritative PLY positions before tile-local f32 conversion.
    ///
    /// Picking uses these values directly; reconstructing world coordinates as
    /// `origin + splat.position` would reintroduce the GPU's f32 precision loss.
    pub source_positions: Arc<[WorldVec3]>,
    /// Largest decoded one-sigma radius.
    pub maximum_scale: f32,
}

/// Invalid, unsupported or unsafe PLY splat input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GaussianSplatDecodeError {
    /// Header is missing, malformed or exceeds its bounded scan window.
    InvalidHeader,
    /// Only ASCII and binary little-endian scalar vertex PLY are accepted.
    UnsupportedLayout,
    /// Vertex count is zero or exceeds the caller's explicit safety bound.
    InvalidVertexCount,
    /// Position properties are absent.
    MissingPosition,
    /// Vertex rows end before the declared count.
    Truncated,
    /// A decoded value is non-finite or otherwise invalid.
    InvalidValue,
}

impl Display for GaussianSplatDecodeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidHeader => "Gaussian PLY header is invalid or too large",
            Self::UnsupportedLayout => "Gaussian PLY layout is unsupported",
            Self::InvalidVertexCount => "Gaussian PLY vertex count violates its decode bound",
            Self::MissingPosition => "Gaussian PLY is missing x, y or z",
            Self::Truncated => "Gaussian PLY vertex payload is truncated",
            Self::InvalidValue => "Gaussian PLY contains invalid splat values",
        })
    }
}

impl Error for GaussianSplatDecodeError {}

/// Decodes a bounded monolithic Brush/3DGS PLY tile.
pub fn decode_gaussian_splat_ply(
    bytes: &[u8],
    maximum_splats: usize,
) -> Result<DecodedGaussianSplats, GaussianSplatDecodeError> {
    if bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES {
        return Err(GaussianSplatDecodeError::InvalidVertexCount);
    }
    let header = parse_header(bytes)?;
    if header.vertex_count == 0
        || header.vertex_count > maximum_splats
        || header.vertex_count > u32::MAX as usize
    {
        return Err(GaussianSplatDecodeError::InvalidVertexCount);
    }
    let row_bytes = header
        .properties
        .len()
        .checked_mul(std::mem::size_of::<f64>())
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<Vec<f64>>()))
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<WorldVec3>()))
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<DecodedGaussianSplat>()))
        .ok_or(GaussianSplatDecodeError::InvalidVertexCount)?;
    if header.properties.len() > crate::decode_limits::MAX_GAUSSIAN_PROPERTIES
        || header
            .vertex_count
            .checked_mul(row_bytes)
            .is_none_or(|bytes| bytes > crate::decode_limits::MAX_DECODED_CONTENT_BYTES)
    {
        return Err(GaussianSplatDecodeError::InvalidVertexCount);
    }
    let property_index = |name: &str| {
        header
            .properties
            .iter()
            .position(|property| property.name == name)
    };
    for required in ["x", "y", "z"] {
        if property_index(required).is_none() {
            return Err(GaussianSplatDecodeError::MissingPosition);
        }
    }
    let rows = decode_rows(bytes, &header)?;
    let source_positions = rows
        .iter()
        .map(|row| {
            let coordinate =
                ["x", "y", "z"].map(|name| value(row, &header.properties, name, f64::NAN));
            if coordinate.iter().any(|value| !value.is_finite()) {
                return Err(GaussianSplatDecodeError::InvalidValue);
            }
            Ok(WorldVec3 {
                x: coordinate[0],
                y: coordinate[1],
                z: coordinate[2],
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    for position in &source_positions {
        for (axis, coordinate) in [position.x, position.y, position.z].into_iter().enumerate() {
            minimum[axis] = minimum[axis].min(coordinate);
            maximum[axis] = maximum[axis].max(coordinate);
        }
    }
    let center: [f64; 3] = std::array::from_fn(|axis| (minimum[axis] + maximum[axis]) * 0.5);
    let origin = WorldVec3 {
        x: center[0],
        y: center[1],
        z: center[2],
    };
    let mut maximum_scale = 0.0_f32;
    let splats = rows
        .iter()
        .zip(&source_positions)
        .map(|(row, source_position)| {
            let source = [source_position.x, source_position.y, source_position.z];
            let position = std::array::from_fn(|axis| {
                #[allow(clippy::cast_possible_truncation)]
                let relative = (source[axis] - center[axis]) as f32;
                relative
            });
            let scale = [
                scale_value(row, &header.properties, "scale_0", "scale_x"),
                scale_value(row, &header.properties, "scale_1", "scale_y"),
                scale_value(row, &header.properties, "scale_2", "scale_z"),
            ];
            let rotation = quaternion(row, &header.properties);
            if position.iter().any(|value| !value.is_finite())
                || scale
                    .iter()
                    .any(|value| !value.is_finite() || *value <= 0.0)
                || rotation.iter().any(|value| !value.is_finite())
            {
                return Err(GaussianSplatDecodeError::InvalidValue);
            }
            maximum_scale = maximum_scale.max(scale.into_iter().fold(0.0, f32::max));
            Ok(DecodedGaussianSplat {
                position,
                scale,
                rotation,
                color: color(row, &header.properties),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DecodedGaussianSplats {
        origin,
        bounds: WorldAabb {
            min: WorldVec3 {
                x: minimum[0],
                y: minimum[1],
                z: minimum[2],
            },
            max: WorldVec3 {
                x: maximum[0],
                y: maximum[1],
                z: maximum[2],
            },
        },
        splats,
        source_positions: source_positions.into(),
        maximum_scale,
    })
}

/// Decodes the compact tiled HCSP v1 payload produced by PhotoLab.
///
/// Layout per splat is local XYZ f32, linear scale XYZ f32, normalized XYZW
/// f32 and RGBA8. The manifest-authored f64 origin restores authoritative
/// source positions without expanding the on-disk tile to PLY.
pub fn decode_gaussian_splat_interleaved_v1(
    bytes: &[u8],
    maximum_splats: usize,
    origin: WorldVec3,
) -> Result<DecodedGaussianSplats, GaussianSplatDecodeError> {
    if bytes.is_empty()
        || bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES
        || bytes.len() % INTERLEAVED_V1_STRIDE != 0
    {
        return Err(GaussianSplatDecodeError::InvalidVertexCount);
    }
    let count = bytes.len() / INTERLEAVED_V1_STRIDE;
    if count == 0 || count > maximum_splats || count > u32::MAX as usize {
        return Err(GaussianSplatDecodeError::InvalidVertexCount);
    }
    let mut splats = Vec::with_capacity(count);
    let mut source_positions = Vec::with_capacity(count);
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    let mut maximum_scale = 0.0_f32;
    for record in bytes.chunks_exact(INTERLEAVED_V1_STRIDE) {
        let position = [
            read_f32(record, 0),
            read_f32(record, 4),
            read_f32(record, 8),
        ];
        let scale = [
            read_f32(record, 12),
            read_f32(record, 16),
            read_f32(record, 20),
        ];
        let mut rotation = [
            read_f32(record, 24),
            read_f32(record, 28),
            read_f32(record, 32),
            read_f32(record, 36),
        ];
        if position.iter().any(|value| !value.is_finite())
            || scale
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            || rotation.iter().any(|value| !value.is_finite())
        {
            return Err(GaussianSplatDecodeError::InvalidValue);
        }
        let rotation_length = rotation
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        if !rotation_length.is_finite() || rotation_length <= 1.0e-8 {
            return Err(GaussianSplatDecodeError::InvalidValue);
        }
        for value in &mut rotation {
            *value /= rotation_length;
        }
        let source = WorldVec3 {
            x: origin.x + f64::from(position[0]),
            y: origin.y + f64::from(position[1]),
            z: origin.z + f64::from(position[2]),
        };
        for (axis, coordinate) in [source.x, source.y, source.z].into_iter().enumerate() {
            minimum[axis] = minimum[axis].min(coordinate);
            maximum[axis] = maximum[axis].max(coordinate);
        }
        maximum_scale = maximum_scale.max(scale.into_iter().fold(0.0, f32::max));
        source_positions.push(source);
        splats.push(DecodedGaussianSplat {
            position,
            scale,
            rotation,
            color: [record[40], record[41], record[42], record[43]],
        });
    }
    Ok(DecodedGaussianSplats {
        origin,
        bounds: WorldAabb {
            min: WorldVec3 {
                x: minimum[0],
                y: minimum[1],
                z: minimum[2],
            },
            max: WorldVec3 {
                x: maximum[0],
                y: maximum[1],
                z: maximum[2],
            },
        },
        splats,
        source_positions: source_positions.into(),
        maximum_scale,
    })
}

fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("HCSP record contains each requested f32"),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlyFormat {
    Ascii,
    BinaryLittleEndian,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScalarType {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl ScalarType {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "char" | "int8" => Self::I8,
            "uchar" | "uint8" => Self::U8,
            "short" | "int16" => Self::I16,
            "ushort" | "uint16" => Self::U16,
            "int" | "int32" => Self::I32,
            "uint" | "uint32" => Self::U32,
            "float" | "float32" => Self::F32,
            "double" | "float64" => Self::F64,
            _ => return None,
        })
    }

    const fn byte_width(self) -> usize {
        match self {
            Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::F64 => 8,
        }
    }
}

#[derive(Debug)]
struct Property {
    scalar_type: ScalarType,
    name: String,
}

#[derive(Debug)]
struct Header {
    format: PlyFormat,
    vertex_count: usize,
    properties: Vec<Property>,
    body_offset: usize,
}

fn parse_header(bytes: &[u8]) -> Result<Header, GaussianSplatDecodeError> {
    let scan = &bytes[..bytes.len().min(HEADER_LIMIT)];
    let marker = b"end_header";
    let marker_start = scan
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or(GaussianSplatDecodeError::InvalidHeader)?;
    let line_end = scan[marker_start + marker.len()..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| marker_start + marker.len() + offset + 1)
        .ok_or(GaussianSplatDecodeError::InvalidHeader)?;
    let text = std::str::from_utf8(&scan[..marker_start])
        .map_err(|_| GaussianSplatDecodeError::InvalidHeader)?;
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("ply") {
        return Err(GaussianSplatDecodeError::InvalidHeader);
    }
    let mut format = None;
    let mut vertex_count = None;
    let mut properties = Vec::new();
    let mut in_vertices = false;
    let mut saw_prior_nonempty_element = false;
    for line in lines {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        match fields.as_slice() {
            ["format", "ascii", _] => format = Some(PlyFormat::Ascii),
            ["format", "binary_little_endian", _] => {
                format = Some(PlyFormat::BinaryLittleEndian);
            }
            ["format", ..] => return Err(GaussianSplatDecodeError::UnsupportedLayout),
            ["element", "vertex", count] => {
                if saw_prior_nonempty_element {
                    return Err(GaussianSplatDecodeError::UnsupportedLayout);
                }
                vertex_count = count.parse().ok();
                in_vertices = true;
            }
            ["element", _, count] => {
                if vertex_count.is_none() && count.parse::<usize>().unwrap_or(1) != 0 {
                    saw_prior_nonempty_element = true;
                }
                in_vertices = false;
            }
            ["property", "list", ..] if in_vertices => {
                return Err(GaussianSplatDecodeError::UnsupportedLayout);
            }
            ["property", scalar, name] if in_vertices => {
                properties.push(Property {
                    scalar_type: ScalarType::parse(scalar)
                        .ok_or(GaussianSplatDecodeError::UnsupportedLayout)?,
                    name: (*name).to_owned(),
                });
            }
            _ => {}
        }
    }
    Ok(Header {
        format: format.ok_or(GaussianSplatDecodeError::InvalidHeader)?,
        vertex_count: vertex_count.ok_or(GaussianSplatDecodeError::InvalidHeader)?,
        properties,
        body_offset: line_end,
    })
}

fn decode_rows(bytes: &[u8], header: &Header) -> Result<Vec<Vec<f64>>, GaussianSplatDecodeError> {
    match header.format {
        PlyFormat::Ascii => {
            let text = std::str::from_utf8(
                bytes
                    .get(header.body_offset..)
                    .ok_or(GaussianSplatDecodeError::Truncated)?,
            )
            .map_err(|_| GaussianSplatDecodeError::InvalidValue)?;
            text.lines()
                .take(header.vertex_count)
                .map(|line| {
                    let mut fields = line.split_whitespace();
                    let values = fields
                        .by_ref()
                        .take(header.properties.len() + 1)
                        .map(|field| {
                            field
                                .parse::<f64>()
                                .map_err(|_| GaussianSplatDecodeError::InvalidValue)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if values.len() != header.properties.len() || fields.next().is_some() {
                        return Err(GaussianSplatDecodeError::Truncated);
                    }
                    Ok(values)
                })
                .collect::<Result<Vec<_>, _>>()
                .and_then(|rows| {
                    (rows.len() == header.vertex_count)
                        .then_some(rows)
                        .ok_or(GaussianSplatDecodeError::Truncated)
                })
        }
        PlyFormat::BinaryLittleEndian => {
            let mut cursor = header.body_offset;
            let mut rows = Vec::with_capacity(header.vertex_count);
            for _ in 0..header.vertex_count {
                let mut row = Vec::with_capacity(header.properties.len());
                for property in &header.properties {
                    row.push(read_scalar(bytes, &mut cursor, property.scalar_type)?);
                }
                rows.push(row);
            }
            Ok(rows)
        }
    }
}

fn read_scalar(
    bytes: &[u8],
    cursor: &mut usize,
    scalar_type: ScalarType,
) -> Result<f64, GaussianSplatDecodeError> {
    let end = cursor
        .checked_add(scalar_type.byte_width())
        .ok_or(GaussianSplatDecodeError::Truncated)?;
    let source = bytes
        .get(*cursor..end)
        .ok_or(GaussianSplatDecodeError::Truncated)?;
    *cursor = end;
    Ok(match scalar_type {
        ScalarType::I8 => f64::from(i8::from_le_bytes([source[0]])),
        ScalarType::U8 => f64::from(source[0]),
        ScalarType::I16 => f64::from(i16::from_le_bytes(source.try_into().expect("width"))),
        ScalarType::U16 => f64::from(u16::from_le_bytes(source.try_into().expect("width"))),
        ScalarType::I32 => f64::from(i32::from_le_bytes(source.try_into().expect("width"))),
        ScalarType::U32 => f64::from(u32::from_le_bytes(source.try_into().expect("width"))),
        ScalarType::F32 => f64::from(f32::from_le_bytes(source.try_into().expect("width"))),
        ScalarType::F64 => f64::from_le_bytes(source.try_into().expect("width")),
    })
}

fn value(row: &[f64], properties: &[Property], name: &str, fallback: f64) -> f64 {
    properties
        .iter()
        .position(|property| property.name == name)
        .and_then(|index| row.get(index).copied())
        .unwrap_or(fallback)
}

fn scale_value(row: &[f64], properties: &[Property], logarithmic: &str, linear: &str) -> f32 {
    let result = if properties
        .iter()
        .any(|property| property.name == logarithmic)
    {
        value(row, properties, logarithmic, f64::NAN)
            .exp()
            .clamp(1.0e-6, 1.0e6)
    } else {
        value(row, properties, linear, 0.01).max(1.0e-6)
    };
    #[allow(clippy::cast_possible_truncation)]
    let converted = result as f32;
    converted
}

fn quaternion(row: &[f64], properties: &[Property]) -> [f32; 4] {
    let source = if properties.iter().any(|property| property.name == "rot_0") {
        [
            value(row, properties, "rot_1", 0.0),
            value(row, properties, "rot_2", 0.0),
            value(row, properties, "rot_3", 0.0),
            value(row, properties, "rot_0", 1.0),
        ]
    } else {
        [
            value(row, properties, "qx", 0.0),
            value(row, properties, "qy", 0.0),
            value(row, properties, "qz", 0.0),
            value(row, properties, "qw", 1.0),
        ]
    };
    let length = source.iter().map(|value| value * value).sum::<f64>().sqrt();
    if !length.is_finite() || length <= 1.0e-8 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    source.map(|value| {
        #[allow(clippy::cast_possible_truncation)]
        let converted = (value / length) as f32;
        converted
    })
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn color(row: &[f64], properties: &[Property]) -> [u8; 4] {
    let has = |name: &str| properties.iter().any(|property| property.name == name);
    let rgb = if has("f_dc_0") {
        ["f_dc_0", "f_dc_1", "f_dc_2"].map(|name| {
            ((0.5 + SH_C0 * value(row, properties, name, 0.0)).clamp(0.0, 1.0) * 255.0).round()
                as u8
        })
    } else {
        ["red", "green", "blue"].map(|name| {
            value(row, properties, name, 255.0)
                .clamp(0.0, 255.0)
                .round() as u8
        })
    };
    let alpha = if has("opacity") {
        let opacity = value(row, properties, "opacity", 20.0).clamp(-20.0, 20.0);
        (255.0 / (1.0 + (-opacity).exp())).round() as u8
    } else {
        value(row, properties, "alpha", 255.0)
            .clamp(0.0, 255.0)
            .round() as u8
    };
    [rgb[0], rgb[1], rgb[2], alpha]
}

#[cfg(test)]
mod tests {
    use super::{
        decode_gaussian_splat_interleaved_v1, decode_gaussian_splat_ply, GaussianSplatDecodeError,
    };
    use crate::WorldVec3;

    #[test]
    fn decodes_compact_photolab_tile_without_expanding_to_ply() {
        let mut bytes = [0_u8; 44];
        for (offset, value) in [
            (0, 1.25_f32),
            (4, -2.5),
            (8, 3.75),
            (12, 0.1),
            (16, 0.2),
            (20, 0.3),
            (24, 0.0),
            (28, 0.0),
            (32, 0.0),
            (36, 2.0),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes[40..44].copy_from_slice(&[10, 20, 30, 200]);
        let decoded = decode_gaussian_splat_interleaved_v1(
            &bytes,
            1,
            WorldVec3 {
                x: 4_000_000.0,
                y: 5_000_000.0,
                z: 600.0,
            },
        )
        .expect("decode compact tile");

        assert_eq!(decoded.splats[0].position, [1.25, -2.5, 3.75]);
        assert_eq!(decoded.splats[0].rotation, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(decoded.splats[0].color, [10, 20, 30, 200]);
        assert_eq!(decoded.source_positions[0].x, 4_000_001.25);
        assert_eq!(decoded.source_positions[0].y, 4_999_997.5);
        assert_eq!(decoded.source_positions[0].z, 603.75);
    }

    #[test]
    fn decodes_ascii_3dgs_and_preserves_f64_origin() {
        let ply = b"ply\nformat ascii 1.0\nelement vertex 2\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nend_header\n1000000.001 2000000 500 0 0 0 1 0 0 0 0 0 0 0\n1000000.003 2000000 500 0 0 0 1 0 0 0 0 0 0 0\n";
        let decoded = decode_gaussian_splat_ply(ply, 2).expect("decode");

        assert_eq!(decoded.splats.len(), 2);
        assert!((decoded.origin.x - 1_000_000.002).abs() < 1.0e-9);
        assert_eq!(decoded.source_positions[0].x, 1_000_000.001);
        assert_eq!(decoded.source_positions[1].x, 1_000_000.003);
        assert!((decoded.splats[0].position[0] + 0.001).abs() < 1.0e-7);
        assert!(decoded.splats[0]
            .rotation
            .iter()
            .zip([0.0, 0.0, 0.0, 1.0])
            .all(|(actual, expected)| (*actual - expected).abs() < f32::EPSILON));
        assert_eq!(decoded.splats[0].color, [128, 128, 128, 128]);
    }

    #[test]
    fn retains_ecef_source_position_before_local_f32_rounding() {
        let ply = b"ply\nformat ascii 1.0\nelement vertex 2\nproperty double x\nproperty double y\nproperty double z\nend_header\n6378137.123456789 5400000.234567891 512.345678901\n6378137.370370367 5400000.481481469 512.592592479\n";
        let decoded = decode_gaussian_splat_ply(ply, 2).expect("decode");

        assert_eq!(decoded.source_positions[0].x, 6_378_137.123_456_789);
        assert_eq!(decoded.source_positions[0].y, 5_400_000.234_567_891);
        assert_eq!(decoded.source_positions[0].z, 512.345_678_901);
        let reconstructed = decoded.origin.x + f64::from(decoded.splats[0].position[0]);
        assert_ne!(
            reconstructed, decoded.source_positions[0].x,
            "the fixture must exercise the precision that the authoritative source array preserves",
        );
    }

    #[test]
    fn rejects_monolithic_payload_above_explicit_bound() {
        let ply = b"ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n";

        assert!(decode_gaussian_splat_ply(ply, 1).is_err());
    }

    #[test]
    fn rejects_excessive_property_width_before_allocating_vertex_rows() {
        let mut ply = String::from("ply\nformat ascii 1.0\nelement vertex 1\n");
        for index in 0..129 {
            ply.push_str(&format!("property float p{index}\n"));
        }
        ply.push_str("end_header\n");
        assert_eq!(
            decode_gaussian_splat_ply(ply.as_bytes(), 1),
            Err(GaussianSplatDecodeError::InvalidVertexCount)
        );
    }
}
