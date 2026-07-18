//! Potree 2.0 metadata and paged hierarchy provider.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::Cursor;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    BoundingVolume, ContentKind, ContentReference, DatasetId, HierarchyPageReference,
    HierarchySource, RefinementMode, TileDescriptor, TileId, WorldAabb, WorldTransform, WorldVec3,
};

const BYTES_PER_NODE: usize = 22;
const PROXY_NODE: u8 = 2;
const MAX_BROTLI_NODE_BYTES: usize = 64 * 1024 * 1024;

/// Potree metadata or hierarchy validation failure.
#[derive(Debug, Error)]
pub enum PotreeHierarchyError {
    /// Metadata JSON did not match the Potree 2.0 contract.
    #[error("invalid Potree metadata: {0}")]
    Metadata(#[from] serde_json::Error),
    /// Metadata contains invalid bounds or hierarchy values.
    #[error("invalid Potree metadata field: {0}")]
    InvalidMetadata(&'static str),
    /// Binary hierarchy page is truncated or structurally inconsistent.
    #[error("invalid Potree hierarchy page: {0}")]
    InvalidHierarchy(&'static str),
    /// Requested hierarchy page root is unknown.
    #[error("unknown Potree hierarchy page root: {0}")]
    UnknownPageRoot(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    version: String,
    hierarchy: MetadataHierarchy,
    spacing: f64,
    bounding_box: MetadataBounds,
    offset: [f64; 3],
    scale: [f64; 3],
    encoding: String,
    attributes: Vec<MetadataAttribute>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataHierarchy {
    first_chunk_size: u64,
}

#[derive(Debug, Deserialize)]
struct MetadataBounds {
    min: [f64; 3],
    max: [f64; 3],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataAttribute {
    name: String,
    size: usize,
    num_elements: usize,
    #[serde(rename = "type")]
    attribute_type: PotreeAttributeType,
}

/// Scalar storage type declared by Potree 2.0 metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PotreeAttributeType {
    /// IEEE-754 64-bit float.
    Double,
    /// IEEE-754 32-bit float.
    Float,
    /// Signed 8-bit integer.
    Int8,
    /// Unsigned 8-bit integer.
    Uint8,
    /// Signed 16-bit integer.
    Int16,
    /// Unsigned 16-bit integer.
    Uint16,
    /// Signed 32-bit integer.
    Int32,
    /// Unsigned 32-bit integer.
    Uint32,
    /// Signed 64-bit integer.
    Int64,
    /// Unsigned 64-bit integer.
    Uint64,
}

impl PotreeAttributeType {
    fn byte_size(self) -> usize {
        match self {
            Self::Int8 | Self::Uint8 => 1,
            Self::Int16 | Self::Uint16 => 2,
            Self::Float | Self::Int32 | Self::Uint32 => 4,
            Self::Double | Self::Int64 | Self::Uint64 => 8,
        }
    }
}

/// One interleaved point attribute in an `octree.bin` node payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PotreeAttributeLayout {
    /// Metadata attribute name.
    pub name: String,
    /// Scalar storage type.
    pub attribute_type: PotreeAttributeType,
    /// Scalar component count.
    pub component_count: usize,
    /// Byte offset within one interleaved point record.
    pub byte_offset: usize,
    /// Total bytes occupied by this attribute.
    pub byte_size: usize,
}

/// Validated point-record layout and coordinate quantization metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PotreePointLayout {
    /// Source coordinate scale per axis.
    pub scale: [f64; 3],
    /// Source coordinate offset per axis.
    pub offset: [f64; 3],
    /// Metadata encoding identifier.
    pub encoding: String,
    /// Interleaved attributes in source order.
    pub attributes: Vec<PotreeAttributeLayout>,
    /// Bytes per point record.
    pub stride: usize,
}

/// Camera-independent point payload decoded from one Potree node range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPotreePoints {
    /// Exact f64 tile origin used before conversion to local f32 positions.
    pub world_origin: WorldVec3,
    /// Positions relative to `world_origin`.
    pub positions: Vec<[f32; 3]>,
    /// Source colors normalized to 8-bit RGBA.
    pub colors: Vec<[u8; 4]>,
    /// Compact civil/LAS attributes aligned one-to-one with `positions`.
    ///
    /// `None` avoids carrying eight zero bytes per point for sources that do
    /// not declare any supported civil attribute.
    pub civil_attributes: Option<Vec<PackedCivilPointAttributes>>,
}

/// Exact non-geometric attributes read from one resident Potree source record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PotreePointMetadata {
    /// Source intensity, or `None` when the layout does not declare it.
    pub intensity: Option<u16>,
    /// Source classification, or `None` when absent.
    pub classification: Option<u8>,
    /// Source return number, or `None` when absent.
    pub return_number: Option<u8>,
    /// Source number of returns, or `None` when absent.
    pub number_of_returns: Option<u8>,
    /// Source point-source id, or `None` when absent.
    pub point_source_id: Option<u16>,
    /// Exact normalized source color, or `None` when absent.
    pub source_color: Option<[u8; 4]>,
}

/// Two-word GPU representation of the civil attributes used for point-cloud
/// styling. Exact picked values remain available from the source record.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[repr(C)]
pub struct PackedCivilPointAttributes {
    /// Intensity in bits 0..15, classification in 16..23 and return number in
    /// 24..31.
    pub civil_0: u32,
    /// Point-source id in bits 0..15, number of returns in 16..23 and presence
    /// flags in 24..31.
    pub civil_1: u32,
}

impl PackedCivilPointAttributes {
    /// Intensity was present in the source record.
    pub const HAS_INTENSITY: u8 = 1 << 0;
    /// Classification was present in the source record.
    pub const HAS_CLASSIFICATION: u8 = 1 << 1;
    /// Return number was present in the source record.
    pub const HAS_RETURN_NUMBER: u8 = 1 << 2;
    /// Point-source id was present in the source record.
    pub const HAS_POINT_SOURCE_ID: u8 = 1 << 3;
    /// Number of returns was present in the source record.
    pub const HAS_NUMBER_OF_RETURNS: u8 = 1 << 4;
    /// RGB(A) color was present in the source record.
    pub const HAS_SOURCE_COLOR: u8 = 1 << 5;

    /// Packs optional exact source values and their presence bits.
    #[must_use]
    pub fn new(
        intensity: Option<u16>,
        classification: Option<u8>,
        return_number: Option<u8>,
        point_source_id: Option<u16>,
        number_of_returns: Option<u8>,
        has_source_color: bool,
    ) -> Self {
        let mut flags = 0_u8;
        let intensity = intensity.map_or(0, |value| {
            flags |= Self::HAS_INTENSITY;
            value
        });
        let classification = classification.map_or(0, |value| {
            flags |= Self::HAS_CLASSIFICATION;
            value
        });
        let return_number = return_number.map_or(0, |value| {
            flags |= Self::HAS_RETURN_NUMBER;
            value
        });
        let point_source_id = point_source_id.map_or(0, |value| {
            flags |= Self::HAS_POINT_SOURCE_ID;
            value
        });
        let number_of_returns = number_of_returns.map_or(0, |value| {
            flags |= Self::HAS_NUMBER_OF_RETURNS;
            value
        });
        if has_source_color {
            flags |= Self::HAS_SOURCE_COLOR;
        }
        Self {
            civil_0: u32::from(intensity)
                | (u32::from(classification) << 16)
                | (u32::from(return_number) << 24),
            civil_1: u32::from(point_source_id)
                | (u32::from(number_of_returns) << 16)
                | (u32::from(flags) << 24),
        }
    }

    /// Returns the compact source-field presence mask.
    #[must_use]
    pub fn presence_flags(self) -> u8 {
        (self.civil_1 >> 24) as u8
    }

    /// Returns source intensity when declared.
    #[must_use]
    pub fn intensity(self) -> Option<u16> {
        self.has(Self::HAS_INTENSITY)
            .then_some((self.civil_0 & 0xffff) as u16)
    }

    /// Returns source classification when declared.
    #[must_use]
    pub fn classification(self) -> Option<u8> {
        self.has(Self::HAS_CLASSIFICATION)
            .then_some(((self.civil_0 >> 16) & 0xff) as u8)
    }

    /// Returns source return number when declared.
    #[must_use]
    pub fn return_number(self) -> Option<u8> {
        self.has(Self::HAS_RETURN_NUMBER)
            .then_some((self.civil_0 >> 24) as u8)
    }

    /// Returns source point-source id when declared.
    #[must_use]
    pub fn point_source_id(self) -> Option<u16> {
        self.has(Self::HAS_POINT_SOURCE_ID)
            .then_some((self.civil_1 & 0xffff) as u16)
    }

    /// Returns source number of returns when declared.
    #[must_use]
    pub fn number_of_returns(self) -> Option<u8> {
        self.has(Self::HAS_NUMBER_OF_RETURNS)
            .then_some(((self.civil_1 >> 16) & 0xff) as u8)
    }

    /// Reports whether a source color attribute was declared.
    #[must_use]
    pub fn has_source_color(self) -> bool {
        self.has(Self::HAS_SOURCE_COLOR)
    }

    fn has(self, flag: u8) -> bool {
        self.presence_flags() & flag != 0
    }
}

/// Potree node payload validation or decoding failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PotreeDecodeError {
    /// Encoding is not the standard interleaved Potree 2.0 layout.
    UnsupportedEncoding(String),
    /// Point count cannot be represented by the portable pick namespace.
    TooManyPoints,
    /// Payload byte length does not equal point count times source stride.
    PayloadSize,
    /// Required position attribute is absent or has a non-standard layout.
    PositionAttribute,
    /// Color attribute has an unsupported scalar layout.
    ColorAttribute,
    /// A supported civil attribute has an invalid scalar layout or value.
    CivilAttribute,
    /// Requested point index does not address the resident source payload.
    PointIndex,
    /// A decoded world or local coordinate is non-finite or exceeds f32.
    CoordinateRange,
    /// BROTLI payload is invalid or does not expand to the declared layout.
    BrotliPayload,
}

impl Display for PotreeDecodeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedEncoding(encoding) => {
                write!(formatter, "unsupported Potree point encoding: {encoding}")
            }
            Self::TooManyPoints => formatter.write_str("Potree node exceeds u32 point addressing"),
            Self::PayloadSize => {
                formatter.write_str("Potree node payload size does not match layout")
            }
            Self::PositionAttribute => formatter.write_str("invalid Potree position attribute"),
            Self::ColorAttribute => formatter.write_str("unsupported Potree color attribute"),
            Self::CivilAttribute => formatter.write_str("invalid Potree civil attribute"),
            Self::PointIndex => formatter.write_str("Potree point index is out of range"),
            Self::CoordinateRange => formatter.write_str("Potree coordinate cannot be represented"),
            Self::BrotliPayload => formatter.write_str("invalid Potree BROTLI node payload"),
        }
    }
}

impl Error for PotreeDecodeError {}

#[derive(Debug, Clone)]
struct PendingNode {
    id: TileId,
    bounds: WorldAabb,
    level: u32,
    was_proxy: bool,
}

/// Parsed Potree hierarchy whose binary payload remains range-addressed.
#[derive(Debug)]
pub struct PotreeHierarchySource {
    dataset_id: DatasetId,
    roots: Vec<TileId>,
    hierarchy_uri: String,
    octree_uri: String,
    spacing: f64,
    point_layout: PotreePointLayout,
    tiles: HashMap<TileId, Arc<TileDescriptor>>,
}

impl PotreeHierarchySource {
    /// Parses metadata and the first hierarchy chunk.
    pub fn from_bytes(
        dataset_id: DatasetId,
        metadata_uri: &str,
        metadata_json: &[u8],
        first_hierarchy_chunk: &[u8],
    ) -> Result<Self, PotreeHierarchyError> {
        let metadata: Metadata = serde_json::from_slice(metadata_json)?;
        if !metadata.version.starts_with('2') {
            return Err(PotreeHierarchyError::InvalidMetadata("version"));
        }
        if !metadata.spacing.is_finite() || metadata.spacing <= 0.0 {
            return Err(PotreeHierarchyError::InvalidMetadata("spacing"));
        }
        let point_layout = parse_point_layout(&metadata)?;
        if metadata.hierarchy.first_chunk_size
            != u64::try_from(first_hierarchy_chunk.len()).unwrap_or(u64::MAX)
        {
            return Err(PotreeHierarchyError::InvalidMetadata(
                "hierarchy.firstChunkSize",
            ));
        }
        let root_bounds = parse_bounds(&metadata.bounding_box)?;
        let base = base_uri(metadata_uri);
        let mut source = Self {
            dataset_id,
            roots: vec![TileId("r".to_owned())],
            hierarchy_uri: format!("{base}hierarchy.bin"),
            octree_uri: format!("{base}octree.bin"),
            spacing: metadata.spacing,
            point_layout,
            tiles: HashMap::new(),
        };
        source.parse_page(
            PendingNode {
                id: TileId("r".to_owned()),
                bounds: root_bounds,
                level: 0,
                was_proxy: true,
            },
            first_hierarchy_chunk,
        )?;
        Ok(source)
    }

    /// Validated layout needed to decode range-loaded `octree.bin` records.
    #[must_use]
    pub fn point_layout(&self) -> &PotreePointLayout {
        &self.point_layout
    }

    /// Adds a range-loaded hierarchy page for a previously discovered proxy.
    pub fn apply_hierarchy_page(
        &mut self,
        page_root: &TileId,
        bytes: &[u8],
    ) -> Result<(), PotreeHierarchyError> {
        let tile = self
            .tiles
            .get(page_root)
            .ok_or_else(|| PotreeHierarchyError::UnknownPageRoot(page_root.0.clone()))?;
        let BoundingVolume::AxisAlignedBox { bounds } = tile.bounds else {
            return Err(PotreeHierarchyError::InvalidHierarchy(
                "Potree tile did not have AABB bounds",
            ));
        };
        let level = page_root.0.len().saturating_sub(1);
        self.parse_page(
            PendingNode {
                id: page_root.clone(),
                bounds,
                level: u32::try_from(level).unwrap_or(u32::MAX),
                was_proxy: true,
            },
            bytes,
        )
    }

    fn parse_page(&mut self, root: PendingNode, bytes: &[u8]) -> Result<(), PotreeHierarchyError> {
        if bytes.is_empty() || bytes.len() % BYTES_PER_NODE != 0 {
            return Err(PotreeHierarchyError::InvalidHierarchy(
                "page length is not a positive multiple of 22",
            ));
        }
        let mut pending = VecDeque::from([root]);
        for record in bytes.chunks_exact(BYTES_PER_NODE) {
            let current = pending
                .pop_front()
                .ok_or(PotreeHierarchyError::InvalidHierarchy(
                    "page contains unreachable records",
                ))?;
            let node_type = record[0];
            let child_mask = record[1];
            let point_count = u64::from(u32::from_le_bytes(record[2..6].try_into().expect("size")));
            let byte_offset = nonnegative_i64(&record[6..14])?;
            let byte_length = nonnegative_i64(&record[14..22])?;
            let is_proxy = node_type == PROXY_NODE && !current.was_proxy;
            let mut children = Vec::new();
            if !is_proxy {
                for child_index in 0_u8..8 {
                    if child_mask & (1 << child_index) == 0 {
                        continue;
                    }
                    let id = TileId(format!("{}{child_index}", current.id.0));
                    let bounds = child_bounds(current.bounds, child_index);
                    children.push(id.clone());
                    pending.push_back(PendingNode {
                        id,
                        bounds,
                        level: current.level.saturating_add(1),
                        was_proxy: false,
                    });
                }
            }
            let contents = if is_proxy {
                Vec::new()
            } else {
                vec![ContentReference {
                    kind: ContentKind::PotreePoints,
                    uri: self.octree_uri.clone(),
                    byte_offset: Some(byte_offset),
                    byte_length: Some(byte_length),
                    primitive_count: Some(point_count),
                    content_hash: None,
                    decoder_parameters: None,
                }]
            };
            let child_page = is_proxy.then(|| HierarchyPageReference {
                uri: self.hierarchy_uri.clone(),
                byte_offset: Some(byte_offset),
                byte_length: Some(byte_length),
                content_hash: None,
                decoder_parameters: None,
            });
            let parent = parent_id(&current.id);
            let level_exponent = i32::try_from(current.level).unwrap_or(i32::MAX);
            self.tiles.insert(
                current.id.clone(),
                Arc::new(TileDescriptor {
                    id: current.id,
                    parent,
                    children,
                    bounds: BoundingVolume::AxisAlignedBox {
                        bounds: current.bounds,
                    },
                    content_transform: WorldTransform::IDENTITY,
                    geometric_error: self.spacing / 2_f64.powi(level_exponent),
                    refinement: RefinementMode::Add,
                    contents,
                    child_page,
                    provider_metadata: None,
                }),
            );
        }
        if !pending.is_empty() {
            return Err(PotreeHierarchyError::InvalidHierarchy(
                "page ended before declared child records",
            ));
        }
        Ok(())
    }
}

impl PotreePointLayout {
    /// Decodes one standard interleaved Potree node without changing world coordinates.
    pub fn decode_node(
        &self,
        bytes: &[u8],
        point_count: u64,
        world_origin: WorldVec3,
    ) -> Result<DecodedPotreePoints, PotreeDecodeError> {
        let point_count =
            usize::try_from(point_count).map_err(|_| PotreeDecodeError::TooManyPoints)?;
        if point_count > crate::decode_limits::MAX_POINT_COUNT {
            return Err(PotreeDecodeError::TooManyPoints);
        }
        if self.encoding.eq_ignore_ascii_case("BROTLI") {
            let interleaved = self.decode_brotli_interleaved(bytes, point_count)?;
            return self.decode_interleaved(&interleaved, point_count, world_origin);
        }
        if !self.encoding.eq_ignore_ascii_case("DEFAULT")
            && !self.encoding.eq_ignore_ascii_case("UNCOMPRESSED")
        {
            return Err(PotreeDecodeError::UnsupportedEncoding(
                self.encoding.clone(),
            ));
        }
        self.decode_interleaved(bytes, point_count, world_origin)
    }

    fn decode_interleaved(
        &self,
        bytes: &[u8],
        point_count: usize,
        world_origin: WorldVec3,
    ) -> Result<DecodedPotreePoints, PotreeDecodeError> {
        let expected_size = point_count
            .checked_mul(self.stride)
            .ok_or(PotreeDecodeError::PayloadSize)?;
        if bytes.len() != expected_size {
            return Err(PotreeDecodeError::PayloadSize);
        }
        let position = self
            .attributes
            .iter()
            .find(|attribute| {
                attribute.name.eq_ignore_ascii_case("position")
                    || attribute.name.eq_ignore_ascii_case("POSITION_CARTESIAN")
            })
            .ok_or(PotreeDecodeError::PositionAttribute)?;
        if position.attribute_type != PotreeAttributeType::Int32
            || position.component_count != 3
            || position.byte_size != 12
        {
            return Err(PotreeDecodeError::PositionAttribute);
        }
        let color = validated_color_attribute(&self.attributes)?;
        let civil_layout = CivilAttributeLayout::from_attributes(&self.attributes)?;
        let has_civil_attributes = civil_layout.has_any();
        let mut positions = Vec::with_capacity(point_count);
        let mut colors = Vec::with_capacity(point_count);
        let mut civil_attributes = has_civil_attributes.then(|| Vec::with_capacity(point_count));
        for record in bytes.chunks_exact(self.stride) {
            let coordinate_bytes = &record[position.byte_offset..position.byte_offset + 12];
            let mut local = [0_f32; 3];
            for (axis, target) in local.iter_mut().enumerate() {
                let start = axis * 4;
                let quantized = i32::from_le_bytes(
                    coordinate_bytes[start..start + 4]
                        .try_into()
                        .expect("coordinate slice size"),
                );
                let world = f64::from(quantized) * self.scale[axis] + self.offset[axis];
                let origin = [world_origin.x, world_origin.y, world_origin.z][axis];
                let relative = world - origin;
                #[allow(clippy::cast_possible_truncation)]
                let render = relative as f32;
                if !world.is_finite() || !render.is_finite() {
                    return Err(PotreeDecodeError::CoordinateRange);
                }
                *target = render;
            }
            positions.push(local);
            colors.push(color.map_or([255; 4], |attribute| decode_color(record, attribute)));
            if let Some(attributes) = &mut civil_attributes {
                attributes.push(civil_layout.decode(record, color.is_some())?);
            }
        }
        Ok(DecodedPotreePoints {
            world_origin,
            positions,
            colors,
            civil_attributes,
        })
    }

    fn decode_brotli_interleaved(
        &self,
        bytes: &[u8],
        point_count: usize,
    ) -> Result<Vec<u8>, PotreeDecodeError> {
        let expanded_stride = self
            .attributes
            .iter()
            .try_fold(0_usize, |total, attribute| {
                total.checked_add(brotli_attribute_stride(attribute))
            })
            .ok_or(PotreeDecodeError::BrotliPayload)?;
        let expanded_size = point_count
            .checked_mul(expanded_stride)
            .filter(|size| *size <= MAX_BROTLI_NODE_BYTES)
            .ok_or(PotreeDecodeError::BrotliPayload)?;
        let interleaved_size = point_count
            .checked_mul(self.stride)
            .filter(|size| *size <= MAX_BROTLI_NODE_BYTES)
            .ok_or(PotreeDecodeError::BrotliPayload)?;
        let mut expanded = vec![0_u8; expanded_size];
        let mut input = Cursor::new(bytes);
        let mut output = Cursor::new(expanded.as_mut_slice());
        brotli_decompressor::BrotliDecompress(&mut input, &mut output)
            .map_err(|_| PotreeDecodeError::BrotliPayload)?;
        if usize::try_from(input.position()).ok() != Some(bytes.len())
            || usize::try_from(output.position()).ok() != Some(expanded_size)
        {
            return Err(PotreeDecodeError::BrotliPayload);
        }

        let mut interleaved = vec![0_u8; interleaved_size];
        let mut attribute_start = 0_usize;
        for attribute in &self.attributes {
            let encoded_stride = brotli_attribute_stride(attribute);
            for point_index in 0..point_count {
                let source_start = attribute_start + point_index * encoded_stride;
                let source = &expanded[source_start..source_start + encoded_stride];
                let target_start = point_index * self.stride + attribute.byte_offset;
                let target = &mut interleaved[target_start..target_start + attribute.byte_size];
                if is_position_attribute(attribute) {
                    decode_brotli_position(source, target)?;
                } else if is_color_attribute(attribute) {
                    decode_brotli_color(source, target, attribute)?;
                } else {
                    target.copy_from_slice(source);
                }
            }
            attribute_start += point_count * encoded_stride;
        }
        Ok(interleaved)
    }

    /// Reads exact civil and color metadata for one source-record index without
    /// decoding or allocating the complete node.
    pub fn point_metadata(
        &self,
        bytes: &[u8],
        point_count: u64,
        point_index: u64,
    ) -> Result<PotreePointMetadata, PotreeDecodeError> {
        if !self.encoding.eq_ignore_ascii_case("DEFAULT")
            && !self.encoding.eq_ignore_ascii_case("UNCOMPRESSED")
        {
            return Err(PotreeDecodeError::UnsupportedEncoding(
                self.encoding.clone(),
            ));
        }
        let point_count =
            usize::try_from(point_count).map_err(|_| PotreeDecodeError::TooManyPoints)?;
        let point_index =
            usize::try_from(point_index).map_err(|_| PotreeDecodeError::PointIndex)?;
        if point_count > crate::decode_limits::MAX_POINT_COUNT || point_index >= point_count {
            return Err(PotreeDecodeError::PointIndex);
        }
        let expected_size = point_count
            .checked_mul(self.stride)
            .ok_or(PotreeDecodeError::PayloadSize)?;
        if bytes.len() != expected_size {
            return Err(PotreeDecodeError::PayloadSize);
        }
        let record_start = point_index
            .checked_mul(self.stride)
            .ok_or(PotreeDecodeError::PointIndex)?;
        let record = &bytes[record_start..record_start + self.stride];
        let color = validated_color_attribute(&self.attributes)?;
        let civil = CivilAttributeLayout::from_attributes(&self.attributes)?;
        Ok(PotreePointMetadata {
            intensity: decode_optional_integer(record, civil.intensity)?,
            classification: decode_optional_integer(record, civil.classification)?,
            return_number: decode_optional_integer(record, civil.return_number)?,
            number_of_returns: decode_optional_integer(record, civil.number_of_returns)?,
            point_source_id: decode_optional_integer(record, civil.point_source_id)?,
            source_color: color.map(|attribute| decode_color(record, attribute)),
        })
    }
}

fn brotli_attribute_stride(attribute: &PotreeAttributeLayout) -> usize {
    if is_position_attribute(attribute) {
        16
    } else if is_color_attribute(attribute) {
        8
    } else {
        attribute.byte_size
    }
}

fn is_position_attribute(attribute: &PotreeAttributeLayout) -> bool {
    attribute.name.eq_ignore_ascii_case("position")
        || attribute.name.eq_ignore_ascii_case("POSITION_CARTESIAN")
}

fn is_color_attribute(attribute: &PotreeAttributeLayout) -> bool {
    attribute.name.eq_ignore_ascii_case("rgba") || attribute.name.eq_ignore_ascii_case("rgb")
}

fn decode_brotli_position(source: &[u8], target: &mut [u8]) -> Result<(), PotreeDecodeError> {
    if source.len() != 16 || target.len() != 12 {
        return Err(PotreeDecodeError::PositionAttribute);
    }
    let upper = u64::from_le_bytes(source[..8].try_into().expect("upper Morton word"));
    let lower = u64::from_le_bytes(source[8..].try_into().expect("lower Morton word"));
    for axis in 0_u32..3 {
        let value = compact_morton_axis(lower, axis) | (compact_morton_axis(upper, axis) << 16);
        let value = i32::try_from(value).map_err(|_| PotreeDecodeError::CoordinateRange)?;
        let start = axis as usize * 4;
        target[start..start + 4].copy_from_slice(&value.to_le_bytes());
    }
    Ok(())
}

fn compact_morton_axis(code: u64, axis: u32) -> u32 {
    let mut value = 0_u32;
    for bit in 0_u32..16 {
        value |= (((code >> (3 * bit + axis)) & 1) as u32) << bit;
    }
    value
}

fn decode_brotli_color(
    source: &[u8],
    target: &mut [u8],
    attribute: &PotreeAttributeLayout,
) -> Result<(), PotreeDecodeError> {
    if source.len() != 8 {
        return Err(PotreeDecodeError::ColorAttribute);
    }
    let morton = u64::from_le_bytes(source.try_into().expect("color Morton word"));
    for component in 0..attribute.component_count.min(3) {
        let value = compact_morton_axis(morton, component as u32) as u16;
        match attribute.attribute_type {
            PotreeAttributeType::Uint16 => {
                let start = component * 2;
                target[start..start + 2].copy_from_slice(&value.to_le_bytes());
            }
            PotreeAttributeType::Uint8 => {
                target[component] = u8::try_from(value).unwrap_or((value >> 8) as u8);
            }
            _ => return Err(PotreeDecodeError::ColorAttribute),
        }
    }
    if attribute.component_count == 4 {
        match attribute.attribute_type {
            PotreeAttributeType::Uint16 => target[6..8].copy_from_slice(&u16::MAX.to_le_bytes()),
            PotreeAttributeType::Uint8 => target[3] = u8::MAX,
            _ => return Err(PotreeDecodeError::ColorAttribute),
        }
    }
    Ok(())
}

fn validated_color_attribute(
    attributes: &[PotreeAttributeLayout],
) -> Result<Option<&PotreeAttributeLayout>, PotreeDecodeError> {
    let color = attributes.iter().find(|attribute| {
        attribute.name.eq_ignore_ascii_case("rgba") || attribute.name.eq_ignore_ascii_case("rgb")
    });
    if color.is_some_and(|attribute| {
        !matches!(
            (attribute.attribute_type, attribute.component_count),
            (
                PotreeAttributeType::Uint8 | PotreeAttributeType::Uint16,
                3 | 4
            )
        )
    }) {
        return Err(PotreeDecodeError::ColorAttribute);
    }
    Ok(color)
}

#[derive(Debug, Clone, Copy, Default)]
struct CivilAttributeLayout<'a> {
    intensity: Option<&'a PotreeAttributeLayout>,
    classification: Option<&'a PotreeAttributeLayout>,
    return_number: Option<&'a PotreeAttributeLayout>,
    point_source_id: Option<&'a PotreeAttributeLayout>,
    number_of_returns: Option<&'a PotreeAttributeLayout>,
}

impl<'a> CivilAttributeLayout<'a> {
    fn from_attributes(attributes: &'a [PotreeAttributeLayout]) -> Result<Self, PotreeDecodeError> {
        let mut result = Self::default();
        for attribute in attributes {
            let target = match normalize_attribute_name(&attribute.name).as_str() {
                "intensity" => &mut result.intensity,
                "classification" => &mut result.classification,
                "returnnumber" => &mut result.return_number,
                "pointsourceid" | "sourceid" => &mut result.point_source_id,
                "numberofreturns" => &mut result.number_of_returns,
                _ => continue,
            };
            if target.is_some()
                || attribute.component_count != 1
                || !matches!(
                    attribute.attribute_type,
                    PotreeAttributeType::Int8
                        | PotreeAttributeType::Uint8
                        | PotreeAttributeType::Int16
                        | PotreeAttributeType::Uint16
                        | PotreeAttributeType::Int32
                        | PotreeAttributeType::Uint32
                        | PotreeAttributeType::Int64
                        | PotreeAttributeType::Uint64
                )
            {
                return Err(PotreeDecodeError::CivilAttribute);
            }
            *target = Some(attribute);
        }
        Ok(result)
    }

    fn has_any(self) -> bool {
        self.intensity.is_some()
            || self.classification.is_some()
            || self.return_number.is_some()
            || self.point_source_id.is_some()
            || self.number_of_returns.is_some()
    }

    fn decode(
        self,
        record: &[u8],
        has_source_color: bool,
    ) -> Result<PackedCivilPointAttributes, PotreeDecodeError> {
        Ok(PackedCivilPointAttributes::new(
            decode_optional_integer::<u16>(record, self.intensity)?,
            decode_optional_integer::<u8>(record, self.classification)?,
            decode_optional_integer::<u8>(record, self.return_number)?,
            decode_optional_integer::<u16>(record, self.point_source_id)?,
            decode_optional_integer::<u8>(record, self.number_of_returns)?,
            has_source_color,
        ))
    }
}

fn normalize_attribute_name(name: &str) -> String {
    name.chars()
        .filter(|character| !matches!(character, ' ' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn decode_optional_integer<T>(
    record: &[u8],
    attribute: Option<&PotreeAttributeLayout>,
) -> Result<Option<T>, PotreeDecodeError>
where
    T: TryFrom<u64>,
{
    attribute
        .map(|attribute| {
            let start = attribute.byte_offset;
            let bytes = &record[start..start + attribute.byte_size];
            let value = match attribute.attribute_type {
                PotreeAttributeType::Uint8 => u64::from(bytes[0]),
                PotreeAttributeType::Uint16 => {
                    u64::from(u16::from_le_bytes(bytes.try_into().expect("uint16 size")))
                }
                PotreeAttributeType::Uint32 => {
                    u64::from(u32::from_le_bytes(bytes.try_into().expect("uint32 size")))
                }
                PotreeAttributeType::Uint64 => {
                    u64::from_le_bytes(bytes.try_into().expect("uint64 size"))
                }
                PotreeAttributeType::Int8 => u64::try_from(i8::from_le_bytes([bytes[0]]))
                    .map_err(|_| PotreeDecodeError::CivilAttribute)?,
                PotreeAttributeType::Int16 => {
                    u64::try_from(i16::from_le_bytes(bytes.try_into().expect("int16 size")))
                        .map_err(|_| PotreeDecodeError::CivilAttribute)?
                }
                PotreeAttributeType::Int32 => {
                    u64::try_from(i32::from_le_bytes(bytes.try_into().expect("int32 size")))
                        .map_err(|_| PotreeDecodeError::CivilAttribute)?
                }
                PotreeAttributeType::Int64 => {
                    u64::try_from(i64::from_le_bytes(bytes.try_into().expect("int64 size")))
                        .map_err(|_| PotreeDecodeError::CivilAttribute)?
                }
                PotreeAttributeType::Float | PotreeAttributeType::Double => {
                    return Err(PotreeDecodeError::CivilAttribute);
                }
            };
            T::try_from(value).map_err(|_| PotreeDecodeError::CivilAttribute)
        })
        .transpose()
}

fn parse_point_layout(metadata: &Metadata) -> Result<PotreePointLayout, PotreeHierarchyError> {
    if metadata
        .scale
        .iter()
        .chain(metadata.offset.iter())
        .any(|value| !value.is_finite())
        || metadata.scale.contains(&0.0)
    {
        return Err(PotreeHierarchyError::InvalidMetadata("scale/offset"));
    }
    let mut byte_offset = 0_usize;
    let mut attributes = Vec::with_capacity(metadata.attributes.len());
    for attribute in &metadata.attributes {
        let expected_size = attribute
            .attribute_type
            .byte_size()
            .checked_mul(attribute.num_elements)
            .ok_or(PotreeHierarchyError::InvalidMetadata("attributes.size"))?;
        if attribute.name.is_empty()
            || attribute.num_elements == 0
            || attribute.size != expected_size
        {
            return Err(PotreeHierarchyError::InvalidMetadata("attributes"));
        }
        attributes.push(PotreeAttributeLayout {
            name: attribute.name.clone(),
            attribute_type: attribute.attribute_type,
            component_count: attribute.num_elements,
            byte_offset,
            byte_size: attribute.size,
        });
        byte_offset = byte_offset
            .checked_add(attribute.size)
            .ok_or(PotreeHierarchyError::InvalidMetadata("attributes.size"))?;
    }
    if byte_offset == 0 {
        return Err(PotreeHierarchyError::InvalidMetadata("attributes"));
    }
    Ok(PotreePointLayout {
        scale: metadata.scale,
        offset: metadata.offset,
        encoding: metadata.encoding.clone(),
        attributes,
        stride: byte_offset,
    })
}

fn decode_color(record: &[u8], attribute: &PotreeAttributeLayout) -> [u8; 4] {
    let mut result = [255_u8; 4];
    for (component, target) in result
        .iter_mut()
        .enumerate()
        .take(attribute.component_count)
    {
        *target = match attribute.attribute_type {
            PotreeAttributeType::Uint8 => record[attribute.byte_offset + component],
            PotreeAttributeType::Uint16 => {
                let start = attribute.byte_offset + component * 2;
                let value = u16::from_le_bytes(
                    record[start..start + 2]
                        .try_into()
                        .expect("color slice size"),
                );
                u8::try_from(value).unwrap_or((value >> 8) as u8)
            }
            _ => unreachable!("color layout validated before decoding"),
        };
    }
    result
}

impl HierarchySource for PotreeHierarchySource {
    type Error = PotreeHierarchyError;

    fn dataset_id(&self) -> &DatasetId {
        &self.dataset_id
    }

    fn roots(&self) -> &[TileId] {
        &self.roots
    }

    fn tile(&mut self, id: &TileId) -> Result<Option<TileDescriptor>, Self::Error> {
        Ok(self.tiles.get(id).map(|tile| tile.as_ref().clone()))
    }

    fn shared_tile(&mut self, id: &TileId) -> Result<Option<Arc<TileDescriptor>>, Self::Error> {
        Ok(self.tiles.get(id).cloned())
    }
}

fn parse_bounds(bounds: &MetadataBounds) -> Result<WorldAabb, PotreeHierarchyError> {
    if bounds
        .min
        .iter()
        .chain(bounds.max.iter())
        .any(|value| !value.is_finite())
        || (0..3).any(|axis| bounds.min[axis] > bounds.max[axis])
    {
        return Err(PotreeHierarchyError::InvalidMetadata("boundingBox"));
    }
    Ok(WorldAabb {
        min: WorldVec3 {
            x: bounds.min[0],
            y: bounds.min[1],
            z: bounds.min[2],
        },
        max: WorldVec3 {
            x: bounds.max[0],
            y: bounds.max[1],
            z: bounds.max[2],
        },
    })
}

fn nonnegative_i64(bytes: &[u8]) -> Result<u64, PotreeHierarchyError> {
    let value = i64::from_le_bytes(bytes.try_into().expect("Potree record field size"));
    u64::try_from(value).map_err(|_| PotreeHierarchyError::InvalidHierarchy("negative byte range"))
}

fn child_bounds(parent: WorldAabb, index: u8) -> WorldAabb {
    let middle = WorldVec3 {
        x: (parent.min.x + parent.max.x) * 0.5,
        y: (parent.min.y + parent.max.y) * 0.5,
        z: (parent.min.z + parent.max.z) * 0.5,
    };
    WorldAabb {
        min: WorldVec3 {
            x: if index & 0b100 != 0 {
                middle.x
            } else {
                parent.min.x
            },
            y: if index & 0b010 != 0 {
                middle.y
            } else {
                parent.min.y
            },
            z: if index & 0b001 != 0 {
                middle.z
            } else {
                parent.min.z
            },
        },
        max: WorldVec3 {
            x: if index & 0b100 != 0 {
                parent.max.x
            } else {
                middle.x
            },
            y: if index & 0b010 != 0 {
                parent.max.y
            } else {
                middle.y
            },
            z: if index & 0b001 != 0 {
                parent.max.z
            } else {
                middle.z
            },
        },
    }
}

fn parent_id(id: &TileId) -> Option<TileId> {
    (id.0.len() > 1).then(|| TileId(id.0[..id.0.len() - 1].to_owned()))
}

fn base_uri(uri: &str) -> &str {
    uri.rsplit_once('/')
        .map_or("", |(base, _)| &uri[..=base.len()])
}

#[cfg(test)]
mod tests {
    use super::{
        PotreeAttributeLayout, PotreeAttributeType, PotreeDecodeError, PotreeHierarchySource,
        PotreePointLayout,
    };
    use crate::{BoundingVolume, DatasetId, HierarchySource, TileId, WorldVec3};

    #[test]
    fn parses_first_chunk_into_range_addressed_additive_tiles() {
        let metadata = br#"{
          "version":"2.0",
          "hierarchy":{"firstChunkSize":44,"stepSize":5,"depth":2},
          "spacing":4.0,
          "boundingBox":{"min":[100.0,200.0,300.0],"max":[108.0,208.0,308.0]},
          "offset":[100.0,200.0,300.0],
          "scale":[0.001,0.001,0.001],
          "encoding":"DEFAULT",
          "attributes":[
            {"name":"position","size":12,"numElements":3,"type":"int32"},
            {"name":"rgba","size":6,"numElements":3,"type":"uint16"}
          ]
        }"#;
        let mut hierarchy = Vec::new();
        hierarchy.extend(record(0, 1, 100, 0, 1_200));
        hierarchy.extend(record(1, 0, 50, 1_200, 600));
        let mut source = PotreeHierarchySource::from_bytes(
            DatasetId("cloud".to_owned()),
            "hcad://cloud/metadata.json",
            metadata,
            &hierarchy,
        )
        .expect("valid Potree hierarchy");

        let root = source
            .tile(&TileId("r".to_owned()))
            .expect("lookup")
            .expect("root");
        assert_eq!(root.children, vec![TileId("r0".to_owned())]);
        assert_eq!(root.contents[0].byte_offset, Some(0));
        assert_eq!(root.contents[0].primitive_count, Some(100));
        let child = source
            .tile(&TileId("r0".to_owned()))
            .expect("lookup")
            .expect("child");
        assert_close(child.geometric_error, 2.0);
        let BoundingVolume::AxisAlignedBox { bounds } = child.bounds else {
            panic!("expected AABB");
        };
        assert_close(bounds.max.x, 104.0);
        assert_close(bounds.max.y, 204.0);
        assert_close(bounds.max.z, 304.0);
    }

    #[test]
    fn decodes_quantized_positions_after_f64_tile_origin_subtraction() {
        let metadata = br#"{
          "version":"2.0",
          "hierarchy":{"firstChunkSize":22,"stepSize":5,"depth":0},
          "spacing":1.0,
          "boundingBox":{"min":[500000.0,5400000.0,100.0],"max":[500001.0,5400001.0,101.0]},
          "offset":[500000.0,5400000.0,100.0],
          "scale":[0.001,0.001,0.001],
          "encoding":"DEFAULT",
          "attributes":[
            {"name":"position","size":12,"numElements":3,"type":"int32"},
            {"name":"rgba","size":6,"numElements":3,"type":"uint16"}
          ]
        }"#;
        let hierarchy = record(0, 0, 2, 0, 36);
        let source = PotreeHierarchySource::from_bytes(
            DatasetId("cloud".to_owned()),
            "hcad://cloud/metadata.json",
            metadata,
            &hierarchy,
        )
        .expect("metadata");
        assert_eq!(
            source.point_layout().decode_node(
                &[],
                16_000_001,
                WorldVec3 {
                    x: 500_000.0,
                    y: 5_400_000.0,
                    z: 100.0,
                },
            ),
            Err(PotreeDecodeError::TooManyPoints)
        );
        let mut payload = Vec::new();
        payload.extend(point_record([125, -250, 500], [65_535, 32_768, 256]));
        payload.extend(point_record([1, 2, 3], [10, 20, 30]));
        let decoded = source
            .point_layout()
            .decode_node(
                &payload,
                2,
                WorldVec3 {
                    x: 500_000.0,
                    y: 5_400_000.0,
                    z: 100.0,
                },
            )
            .expect("points");

        assert_close(f64::from(decoded.positions[0][0]), 0.125);
        assert_close(f64::from(decoded.positions[0][1]), -0.25);
        assert_close(f64::from(decoded.positions[0][2]), 0.5);
        assert_eq!(decoded.colors[0], [255, 128, 1, 255]);
        assert_eq!(decoded.colors[1], [10, 20, 30, 255]);
        assert!(decoded.civil_attributes.is_none());
    }

    #[test]
    fn decodes_normalized_civil_attributes_with_explicit_presence() {
        let layout = PotreePointLayout {
            scale: [0.001; 3],
            offset: [0.0; 3],
            encoding: "DEFAULT".to_owned(),
            attributes: vec![
                attribute("position", PotreeAttributeType::Int32, 3, 0),
                attribute("Intensity", PotreeAttributeType::Uint16, 1, 12),
                attribute("classification", PotreeAttributeType::Uint8, 1, 14),
                attribute("return_number", PotreeAttributeType::Uint8, 1, 15),
                attribute("Number Of Returns", PotreeAttributeType::Uint8, 1, 16),
                attribute("source-id", PotreeAttributeType::Uint16, 1, 17),
                attribute("rgb", PotreeAttributeType::Uint8, 3, 19),
            ],
            stride: 22,
        };
        let mut record = vec![0_u8; layout.stride];
        record[12..14].copy_from_slice(&32_768_u16.to_le_bytes());
        record[14] = 6;
        record[15] = 2;
        record[16] = 4;
        record[17..19].copy_from_slice(&513_u16.to_le_bytes());
        record[19..22].copy_from_slice(&[10, 20, 30]);

        let decoded = layout
            .decode_node(&record, 1, world_zero())
            .expect("civil point");
        let civil = decoded.civil_attributes.expect("civil attributes")[0];
        assert_eq!(civil.intensity(), Some(32_768));
        assert_eq!(civil.classification(), Some(6));
        assert_eq!(civil.return_number(), Some(2));
        assert_eq!(civil.number_of_returns(), Some(4));
        assert_eq!(civil.point_source_id(), Some(513));
        assert!(civil.has_source_color());
        let metadata = layout
            .point_metadata(&record, 1, 0)
            .expect("point metadata");
        assert_eq!(metadata.intensity, Some(32_768));
        assert_eq!(metadata.classification, Some(6));
        assert_eq!(metadata.return_number, Some(2));
        assert_eq!(metadata.number_of_returns, Some(4));
        assert_eq!(metadata.point_source_id, Some(513));
        assert_eq!(metadata.source_color, Some([10, 20, 30, 255]));
        assert_eq!(
            layout.point_metadata(&record, 1, 1),
            Err(PotreeDecodeError::PointIndex)
        );
    }

    #[test]
    fn rejects_out_of_range_and_non_scalar_civil_attributes() {
        let mut layout = PotreePointLayout {
            scale: [1.0; 3],
            offset: [0.0; 3],
            encoding: "DEFAULT".to_owned(),
            attributes: vec![
                attribute("position", PotreeAttributeType::Int32, 3, 0),
                attribute("classification", PotreeAttributeType::Uint16, 1, 12),
            ],
            stride: 14,
        };
        let mut record = vec![0_u8; layout.stride];
        record[12..14].copy_from_slice(&256_u16.to_le_bytes());
        assert_eq!(
            layout.decode_node(&record, 1, world_zero()),
            Err(PotreeDecodeError::CivilAttribute)
        );

        layout.attributes[1].component_count = 2;
        assert_eq!(
            layout.decode_node(&record, 1, world_zero()),
            Err(PotreeDecodeError::CivilAttribute)
        );
    }

    #[test]
    fn decodes_converter_brotli_morton_soa_into_the_common_point_contract() {
        let layout = PotreePointLayout {
            scale: [0.001; 3],
            offset: [500_000.0, 5_400_000.0, 100.0],
            encoding: "BROTLI".to_owned(),
            attributes: vec![
                attribute("position", PotreeAttributeType::Int32, 3, 0),
                attribute("intensity", PotreeAttributeType::Uint16, 1, 12),
                attribute("classification", PotreeAttributeType::Uint8, 1, 14),
                attribute("return number", PotreeAttributeType::Uint8, 1, 15),
                attribute("number of returns", PotreeAttributeType::Uint8, 1, 16),
                attribute("point source id", PotreeAttributeType::Uint16, 1, 17),
                attribute("rgb", PotreeAttributeType::Uint8, 3, 19),
            ],
            stride: 22,
        };
        // Brotli-compressed PotreeConverter attribute-major payload. Position
        // and RGB use its Morton representation; all civil values are exact.
        let encoded = [
            11, 15, 128, 0, 0, 0, 0, 0, 0, 0, 0, 81, 247, 223, 4, 0, 0, 0, 0, 0, 128, 6, 2, 4, 1,
            2, 73, 146, 36, 77, 146, 100, 0, 0, 3,
        ];
        let origin = WorldVec3 {
            x: 500_000.0,
            y: 5_400_000.0,
            z: 100.0,
        };
        let decoded = layout
            .decode_node(&encoded, 1, origin)
            .expect("PotreeConverter BROTLI node");
        assert_close(f64::from(decoded.positions[0][0]), 0.125);
        assert_close(f64::from(decoded.positions[0][1]), 0.25);
        assert_close(f64::from(decoded.positions[0][2]), 0.5);
        assert_eq!(decoded.colors[0], [255, 128, 1, 255]);
        let civil = decoded.civil_attributes.expect("civil attributes")[0];
        assert_eq!(civil.intensity(), Some(32_768));
        assert_eq!(civil.classification(), Some(6));
        assert_eq!(civil.return_number(), Some(2));
        assert_eq!(civil.number_of_returns(), Some(4));
        assert_eq!(civil.point_source_id(), Some(513));
        assert!(civil.has_source_color());

        let mut truncated = encoded.to_vec();
        truncated.pop();
        assert_eq!(
            layout.decode_node(&truncated, 1, origin),
            Err(PotreeDecodeError::BrotliPayload)
        );
    }

    fn attribute(
        name: &str,
        attribute_type: PotreeAttributeType,
        component_count: usize,
        byte_offset: usize,
    ) -> PotreeAttributeLayout {
        let byte_size = attribute_type.byte_size() * component_count;
        PotreeAttributeLayout {
            name: name.to_owned(),
            attribute_type,
            component_count,
            byte_offset,
            byte_size,
        }
    }

    fn world_zero() -> WorldVec3 {
        WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }

    fn record(node_type: u8, child_mask: u8, points: u32, offset: i64, size: i64) -> [u8; 22] {
        let mut bytes = [0_u8; 22];
        bytes[0] = node_type;
        bytes[1] = child_mask;
        bytes[2..6].copy_from_slice(&points.to_le_bytes());
        bytes[6..14].copy_from_slice(&offset.to_le_bytes());
        bytes[14..22].copy_from_slice(&size.to_le_bytes());
        bytes
    }

    fn point_record(position: [i32; 3], color: [u16; 3]) -> [u8; 18] {
        let mut bytes = [0_u8; 18];
        for (index, value) in position.into_iter().enumerate() {
            let start = index * 4;
            bytes[start..start + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in color.into_iter().enumerate() {
            let start = 12 + index * 2;
            bytes[start..start + 2].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1.0e-12);
    }
}
