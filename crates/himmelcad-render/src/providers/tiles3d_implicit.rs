//! 3D Tiles 1.1 implicit quadtree/octree hierarchy and subtree availability.

use std::collections::{BTreeMap, BTreeSet};

use glam::{DAffine3, DMat4, DVec3};
use serde::Deserialize;
use thiserror::Error;

use crate::{
    BoundingVolume, ContentKind, ContentReference, DatasetId, HierarchyPageReference,
    HierarchySource, RefinementMode, TileDescriptor, TileId, WorldTransform, WorldVec3,
};

use super::DecodedStructuralMetadata;

const SUBTREE_HEADER_BYTES: usize = 24;
const MAX_SUBTREE_NODES: u64 = 1_000_000;

/// Regular subdivision scheme declared by an implicit root tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImplicitSubdivisionScheme {
    /// Four children split along X and Y.
    Quadtree,
    /// Eight children split along X, Y and Z.
    Octree,
}

impl ImplicitSubdivisionScheme {
    fn dimensions(self) -> u32 {
        match self {
            Self::Quadtree => 2,
            Self::Octree => 3,
        }
    }

    fn branching(self) -> u64 {
        1_u64 << self.dimensions()
    }
}

/// Stable global coordinates of one implicit tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ImplicitTileCoordinates {
    /// Zero-based level relative to the implicit root.
    pub level: u32,
    /// X coordinate within the level.
    pub x: u64,
    /// Y coordinate within the level.
    pub y: u64,
    /// Z coordinate for octrees; zero for quadtrees.
    pub z: u64,
}

impl ImplicitTileCoordinates {
    fn root() -> Self {
        Self {
            level: 0,
            x: 0,
            y: 0,
            z: 0,
        }
    }

    fn parent(self) -> Option<Self> {
        (self.level > 0).then_some(Self {
            level: self.level.saturating_sub(1),
            x: self.x >> 1,
            y: self.y >> 1,
            z: self.z >> 1,
        })
    }
}

/// Invalid implicit root, subtree container, availability or coordinate data.
#[derive(Debug, Error)]
pub enum ImplicitThreeDTilesError {
    /// Tileset or subtree JSON could not be parsed.
    #[error("invalid implicit 3D Tiles JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// A normative field or relationship is invalid.
    #[error("invalid implicit 3D Tiles field: {0}")]
    InvalidField(&'static str),
    /// A required external subtree buffer was not supplied by its resolved URI.
    #[error("missing implicit subtree buffer: {0}")]
    MissingExternalBuffer(String),
    /// The requested subtree root is not a known placeholder.
    #[error("unknown implicit subtree root: {0}")]
    UnknownSubtreeRoot(String),
}

#[derive(Debug, Deserialize)]
struct Tileset {
    asset: Asset,
    #[serde(default)]
    schema: Option<serde_json::Value>,
    #[serde(default, rename = "schemaUri")]
    schema_uri: Option<String>,
    root: JsonImplicitRoot,
}

#[derive(Debug, Deserialize)]
struct Asset {
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonImplicitRoot {
    bounding_volume: JsonBoundingVolume,
    geometric_error: f64,
    #[serde(default)]
    refine: Option<JsonRefine>,
    #[serde(default)]
    transform: Option<[f64; 16]>,
    #[serde(default)]
    content: Option<JsonContent>,
    #[serde(default)]
    contents: Vec<JsonContent>,
    implicit_tiling: JsonImplicitTiling,
    #[serde(default)]
    children: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonImplicitTiling {
    subdivision_scheme: JsonSubdivisionScheme,
    available_levels: u32,
    subtree_levels: u32,
    subtrees: JsonContent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum JsonSubdivisionScheme {
    Quadtree,
    Octree,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum JsonRefine {
    Add,
    Replace,
}

#[derive(Debug, Deserialize)]
struct JsonBoundingVolume {
    #[serde(default, rename = "box")]
    oriented_box: Option<[f64; 12]>,
    #[serde(default)]
    sphere: Option<[f64; 4]>,
    #[serde(default)]
    region: Option<[f64; 6]>,
}

#[derive(Debug, Deserialize)]
struct JsonContent {
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonSubtree {
    #[serde(default)]
    buffers: Vec<JsonBuffer>,
    #[serde(default)]
    buffer_views: Vec<JsonBufferView>,
    tile_availability: JsonAvailability,
    #[serde(default)]
    content_availability: Vec<JsonAvailability>,
    child_subtree_availability: JsonAvailability,
    #[serde(default)]
    property_tables: Vec<serde_json::Value>,
    #[serde(default)]
    tile_metadata: Option<usize>,
    #[serde(default)]
    content_metadata: Vec<usize>,
    #[serde(default)]
    subtree_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonBuffer {
    #[serde(default)]
    uri: Option<String>,
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonBufferView {
    buffer: usize,
    #[serde(default)]
    byte_offset: u64,
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonAvailability {
    #[serde(default)]
    constant: Option<u8>,
    #[serde(default)]
    bitstream: Option<usize>,
    #[serde(default)]
    available_count: Option<u64>,
}

#[derive(Debug, Clone)]
enum RootBounds {
    Box {
        center: WorldVec3,
        half_axes: [WorldVec3; 3],
    },
    Region([f64; 6]),
}

#[derive(Debug, Clone)]
struct ImplicitConfiguration {
    scheme: ImplicitSubdivisionScheme,
    available_levels: u32,
    subtree_levels: u32,
    subtree_template: String,
    content_templates: Vec<String>,
    root_bounds: RootBounds,
    transform: WorldTransform,
    root_error: f64,
    refinement: RefinementMode,
    base_uri: String,
    schema: Option<serde_json::Value>,
    schema_uri: Option<String>,
}

#[derive(Debug, Clone)]
enum Availability {
    Constant(bool),
    Bits(Vec<u8>),
}

impl Availability {
    fn get(&self, index: u64) -> bool {
        match self {
            Self::Constant(value) => *value,
            Self::Bits(bytes) => usize::try_from(index / 8)
                .ok()
                .and_then(|byte| bytes.get(byte))
                .is_some_and(|byte| byte & (1 << (index % 8)) != 0),
        }
    }

    fn available_rank(&self, index: u64) -> Option<u32> {
        if !self.get(index) {
            return None;
        }
        let rank = match self {
            Self::Constant(true) => index,
            Self::Constant(false) => return None,
            Self::Bits(bytes) => {
                let full_bytes = usize::try_from(index / 8).ok()?;
                let mut rank = bytes
                    .iter()
                    .take(full_bytes)
                    .map(|byte| u64::from(byte.count_ones()))
                    .sum::<u64>();
                let remaining = u32::try_from(index % 8).ok()?;
                if remaining > 0 {
                    let mask = (1_u16 << remaining) - 1;
                    rank += u64::from((u16::from(*bytes.get(full_bytes)?) & mask).count_ones());
                }
                rank
            }
        };
        u32::try_from(rank).ok()
    }
}

/// Lazily populated 3D Tiles 1.1 implicit hierarchy.
#[derive(Debug)]
pub struct ImplicitThreeDTilesHierarchySource {
    dataset_id: DatasetId,
    roots: Vec<TileId>,
    configuration: ImplicitConfiguration,
    tiles: BTreeMap<TileId, TileDescriptor>,
    coordinates: BTreeMap<TileId, ImplicitTileCoordinates>,
}

impl ImplicitThreeDTilesHierarchySource {
    /// Parses an implicit root and creates its first lazy subtree placeholder.
    pub fn from_json(
        dataset_id: DatasetId,
        tileset_uri: &str,
        json: &[u8],
    ) -> Result<Self, ImplicitThreeDTilesError> {
        let tileset: Tileset = serde_json::from_slice(json)?;
        if tileset.asset.version != "1.1" {
            return Err(ImplicitThreeDTilesError::InvalidField("asset.version"));
        }
        if tileset.schema.is_some() && tileset.schema_uri.is_some() {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "schema and schemaUri",
            ));
        }
        if tileset
            .schema
            .as_ref()
            .is_some_and(|schema| !schema.is_object())
        {
            return Err(ImplicitThreeDTilesError::InvalidField("schema"));
        }
        let root = tileset.root;
        if !root.children.is_empty() {
            return Err(ImplicitThreeDTilesError::InvalidField("root.children"));
        }
        if !root.geometric_error.is_finite() || root.geometric_error < 0.0 {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "root.geometricError",
            ));
        }
        let transform = parse_transform(root.transform)?;
        let scheme = match root.implicit_tiling.subdivision_scheme {
            JsonSubdivisionScheme::Quadtree => ImplicitSubdivisionScheme::Quadtree,
            JsonSubdivisionScheme::Octree => ImplicitSubdivisionScheme::Octree,
        };
        validate_levels(
            root.implicit_tiling.available_levels,
            root.implicit_tiling.subtree_levels,
            scheme,
        )?;
        if root.bounding_volume.sphere.is_some() {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "root.boundingVolume.sphere",
            ));
        }
        let root_bounds = parse_root_bounds(&root.bounding_volume, transform)?;
        let subtree_template = content_uri(root.implicit_tiling.subtrees)?;
        validate_template(&subtree_template, scheme)?;
        let mut json_contents = root.contents;
        if let Some(content) = root.content {
            json_contents.insert(0, content);
        }
        let content_templates = json_contents
            .into_iter()
            .map(content_uri)
            .collect::<Result<Vec<_>, _>>()?;
        for template in &content_templates {
            validate_template(template, scheme)?;
            if is_external_tileset(template) {
                return Err(ImplicitThreeDTilesError::InvalidField("content.uri"));
            }
        }
        let base_uri = base_uri(tileset_uri).to_owned();
        let refinement = match root.refine.unwrap_or(JsonRefine::Replace) {
            JsonRefine::Add => RefinementMode::Add,
            JsonRefine::Replace => RefinementMode::Replace,
        };
        let configuration = ImplicitConfiguration {
            scheme,
            available_levels: root.implicit_tiling.available_levels,
            subtree_levels: root.implicit_tiling.subtree_levels,
            subtree_template,
            content_templates,
            root_bounds,
            transform: WorldTransform(transform.to_cols_array()),
            root_error: root.geometric_error * maximum_scale(transform),
            refinement,
            base_uri,
            schema: tileset.schema,
            schema_uri: tileset.schema_uri,
        };
        let coordinates = ImplicitTileCoordinates::root();
        let id = tile_id(coordinates, scheme);
        let descriptor = placeholder_descriptor(&configuration, coordinates, None);
        Ok(Self {
            dataset_id,
            roots: vec![id.clone()],
            configuration,
            tiles: BTreeMap::from([(id.clone(), descriptor)]),
            coordinates: BTreeMap::from([(id, coordinates)]),
        })
    }

    /// Coordinates corresponding to a stable hierarchy tile ID.
    #[must_use]
    pub fn tile_coordinates(&self, id: &TileId) -> Option<ImplicitTileCoordinates> {
        self.coordinates.get(id).copied()
    }

    /// Applies a binary or JSON subtree plus externally fetched buffers by resolved URI.
    pub fn apply_subtree(
        &mut self,
        subtree_root: &TileId,
        subtree_uri: &str,
        bytes: &[u8],
        external_buffers: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), ImplicitThreeDTilesError> {
        let root_coordinates =
            self.coordinates.get(subtree_root).copied().ok_or_else(|| {
                ImplicitThreeDTilesError::UnknownSubtreeRoot(subtree_root.0.clone())
            })?;
        if root_coordinates.level % self.configuration.subtree_levels != 0 {
            return Err(ImplicitThreeDTilesError::InvalidField("subtree root level"));
        }
        let parsed = parse_subtree(subtree_uri, bytes, external_buffers)?;
        if parsed.content.len() != self.configuration.content_templates.len() {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "contentAvailability",
            ));
        }
        if parsed.metadata.as_ref().is_some_and(|metadata| {
            !metadata.content_tables.is_empty()
                && metadata.content_tables.len() != parsed.content.len()
        }) {
            return Err(ImplicitThreeDTilesError::InvalidField("contentMetadata"));
        }
        self.populate_subtree(root_coordinates, &parsed)
    }

    /// Applies a self-contained binary subtree with no external buffers.
    pub fn apply_binary_subtree(
        &mut self,
        subtree_root: &TileId,
        subtree_uri: &str,
        bytes: &[u8],
    ) -> Result<(), ImplicitThreeDTilesError> {
        self.apply_subtree(subtree_root, subtree_uri, bytes, &BTreeMap::new())
    }

    fn populate_subtree(
        &mut self,
        subtree_root: ImplicitTileCoordinates,
        availability: &ParsedAvailability,
    ) -> Result<(), ImplicitThreeDTilesError> {
        let scheme = self.configuration.scheme;
        let branching = scheme.branching();
        let levels = self.configuration.subtree_levels;
        let tile_bit_count = level_offset(branching, levels)?;
        availability.tile.validate(tile_bit_count)?;
        for content in &availability.content {
            content.validate(tile_bit_count)?;
        }
        let child_count = branching
            .checked_pow(levels)
            .ok_or(ImplicitThreeDTilesError::InvalidField("subtreeLevels"))?;
        availability.children.validate(child_count)?;

        let mut available = BTreeSet::new();
        let visible_levels = levels.min(
            self.configuration
                .available_levels
                .saturating_sub(subtree_root.level),
        );
        for local_level in 0..visible_levels {
            let count = branching
                .checked_pow(local_level)
                .ok_or(ImplicitThreeDTilesError::InvalidField("subtreeLevels"))?;
            let offset = level_offset(branching, local_level)?;
            for morton in 0..count {
                if availability.tile.get(offset + morton) {
                    available.insert(global_coordinates(
                        subtree_root,
                        decode_morton(morton, local_level, scheme),
                    )?);
                }
            }
        }
        if !available.contains(&subtree_root) {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "tileAvailability root",
            ));
        }
        let child_level = subtree_root.level.saturating_add(levels);
        let mut placeholders = BTreeSet::new();
        if child_level < self.configuration.available_levels {
            for morton in 0..child_count {
                if availability.children.get(morton) {
                    placeholders.insert(global_coordinates(
                        subtree_root,
                        decode_morton(morton, levels, scheme),
                    )?);
                }
            }
        }
        let all_coordinates = available
            .iter()
            .chain(&placeholders)
            .copied()
            .collect::<BTreeSet<_>>();
        let decoded_metadata =
            availability
                .metadata
                .as_ref()
                .map(|metadata| DecodedStructuralMetadata {
                    schema: self.configuration.schema.clone(),
                    schema_uri: self.configuration.schema_uri.clone(),
                    property_tables: metadata.property_tables.clone(),
                    property_textures: Vec::new(),
                    property_attributes: Vec::new(),
                    property_table_buffer_views: metadata.buffer_views.clone(),
                });
        for coordinates in &all_coordinates {
            let coordinates = *coordinates;
            let id = tile_id(coordinates, scheme);
            let parent = coordinates.parent().map(|parent| tile_id(parent, scheme));
            let descriptor = if placeholders.contains(&coordinates) {
                placeholder_descriptor(&self.configuration, coordinates, parent)
            } else {
                let local_level = coordinates.level - subtree_root.level;
                let morton = local_morton(coordinates, subtree_root, local_level, scheme)?;
                let index = level_offset(branching, local_level)? + morton;
                let provider_metadata = implicit_provider_metadata(
                    availability,
                    decoded_metadata.as_ref(),
                    index,
                    coordinates == subtree_root,
                )?;
                tile_descriptor(
                    &self.configuration,
                    coordinates,
                    parent,
                    &all_coordinates,
                    &availability.content,
                    index,
                    provider_metadata,
                )
            };
            self.coordinates.insert(id.clone(), coordinates);
            self.tiles.insert(id, descriptor);
        }
        Ok(())
    }
}

impl HierarchySource for ImplicitThreeDTilesHierarchySource {
    type Error = ImplicitThreeDTilesError;

    fn dataset_id(&self) -> &DatasetId {
        &self.dataset_id
    }

    fn roots(&self) -> &[TileId] {
        &self.roots
    }

    fn tile(&mut self, id: &TileId) -> Result<Option<TileDescriptor>, Self::Error> {
        Ok(self.tiles.get(id).cloned())
    }
}

struct ParsedAvailability {
    tile: Availability,
    content: Vec<Availability>,
    children: Availability,
    metadata: Option<ParsedSubtreeMetadata>,
}

struct ParsedSubtreeMetadata {
    property_tables: Vec<serde_json::Value>,
    buffer_views: BTreeMap<usize, Vec<u8>>,
    tile_table: Option<usize>,
    content_tables: Vec<usize>,
    subtree: Option<serde_json::Value>,
}

impl Availability {
    fn validate(&self, bit_count: u64) -> Result<(), ImplicitThreeDTilesError> {
        if let Self::Bits(bytes) = self {
            let required = usize::try_from(bit_count.div_ceil(8))
                .map_err(|_| ImplicitThreeDTilesError::InvalidField("availability bitstream"))?;
            if bytes.len() < required {
                return Err(ImplicitThreeDTilesError::InvalidField(
                    "availability bitstream",
                ));
            }
        }
        Ok(())
    }
}

fn parse_subtree(
    subtree_uri: &str,
    bytes: &[u8],
    external_buffers: &BTreeMap<String, Vec<u8>>,
) -> Result<ParsedAvailability, ImplicitThreeDTilesError> {
    let (json_bytes, internal) = if bytes.starts_with(b"subt") {
        parse_binary_subtree(bytes)?
    } else {
        (bytes, None)
    };
    let subtree: JsonSubtree = serde_json::from_slice(json_bytes)?;
    let buffers = resolve_buffers(&subtree.buffers, internal, subtree_uri, external_buffers)?;
    let resolve = |availability: &JsonAvailability| {
        resolve_availability(availability, &subtree.buffer_views, &buffers)
    };
    let tile = resolve(&subtree.tile_availability)?;
    let content = subtree
        .content_availability
        .iter()
        .map(resolve)
        .collect::<Result<Vec<_>, _>>()?;
    let children = resolve(&subtree.child_subtree_availability)?;
    let metadata = parse_subtree_metadata(&subtree, &buffers)?;
    Ok(ParsedAvailability {
        tile,
        content,
        children,
        metadata,
    })
}

fn parse_subtree_metadata(
    subtree: &JsonSubtree,
    buffers: &[&[u8]],
) -> Result<Option<ParsedSubtreeMetadata>, ImplicitThreeDTilesError> {
    if subtree.property_tables.is_empty()
        && subtree.tile_metadata.is_none()
        && subtree.content_metadata.is_empty()
        && subtree.subtree_metadata.is_none()
    {
        return Ok(None);
    }
    if subtree
        .tile_metadata
        .is_some_and(|index| index >= subtree.property_tables.len())
        || subtree
            .content_metadata
            .iter()
            .any(|index| *index >= subtree.property_tables.len())
    {
        return Err(ImplicitThreeDTilesError::InvalidField(
            "subtree metadata property table index",
        ));
    }
    let indices = property_table_buffer_view_indices(&subtree.property_tables)?;
    let mut buffer_views = BTreeMap::new();
    for index in indices {
        let view =
            subtree
                .buffer_views
                .get(index)
                .ok_or(ImplicitThreeDTilesError::InvalidField(
                    "property table bufferView",
                ))?;
        if view.byte_offset % 8 != 0 {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "property table bufferView.byteOffset",
            ));
        }
        let buffer = buffers
            .get(view.buffer)
            .ok_or(ImplicitThreeDTilesError::InvalidField(
                "property table bufferView.buffer",
            ))?;
        let start = usize::try_from(view.byte_offset).map_err(|_| {
            ImplicitThreeDTilesError::InvalidField("property table bufferView.byteOffset")
        })?;
        let end = view
            .byte_offset
            .checked_add(view.byte_length)
            .and_then(|end| usize::try_from(end).ok())
            .ok_or(ImplicitThreeDTilesError::InvalidField(
                "property table bufferView.byteLength",
            ))?;
        buffer_views.insert(
            index,
            buffer
                .get(start..end)
                .ok_or(ImplicitThreeDTilesError::InvalidField(
                    "property table bufferView.byteLength",
                ))?
                .to_vec(),
        );
    }
    Ok(Some(ParsedSubtreeMetadata {
        property_tables: subtree.property_tables.clone(),
        buffer_views,
        tile_table: subtree.tile_metadata,
        content_tables: subtree.content_metadata.clone(),
        subtree: subtree.subtree_metadata.clone(),
    }))
}

fn property_table_buffer_view_indices(
    property_tables: &[serde_json::Value],
) -> Result<BTreeSet<usize>, ImplicitThreeDTilesError> {
    let mut indices = BTreeSet::new();
    for table in property_tables {
        let properties = table
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .ok_or(ImplicitThreeDTilesError::InvalidField(
                "property table properties",
            ))?;
        for property in properties.values() {
            let property = property
                .as_object()
                .ok_or(ImplicitThreeDTilesError::InvalidField(
                    "property table property",
                ))?;
            for key in ["values", "arrayOffsets", "stringOffsets"] {
                if let Some(index) = property.get(key) {
                    indices.insert(
                        index
                            .as_u64()
                            .and_then(|index| usize::try_from(index).ok())
                            .ok_or(ImplicitThreeDTilesError::InvalidField(
                                "property table bufferView index",
                            ))?,
                    );
                }
            }
        }
    }
    Ok(indices)
}

fn parse_binary_subtree(bytes: &[u8]) -> Result<(&[u8], Option<&[u8]>), ImplicitThreeDTilesError> {
    if bytes.len() < SUBTREE_HEADER_BYTES || &bytes[0..4] != b"subt" {
        return Err(ImplicitThreeDTilesError::InvalidField("subtree header"));
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().expect("header range"));
    if version != 1 {
        return Err(ImplicitThreeDTilesError::InvalidField("subtree version"));
    }
    let json_length = u64::from_le_bytes(bytes[8..16].try_into().expect("header range"));
    let binary_length = u64::from_le_bytes(bytes[16..24].try_into().expect("header range"));
    if json_length % 8 != 0 || binary_length % 8 != 0 {
        return Err(ImplicitThreeDTilesError::InvalidField("subtree alignment"));
    }
    let json_end = u64::try_from(SUBTREE_HEADER_BYTES)
        .expect("header fits")
        .checked_add(json_length)
        .ok_or(ImplicitThreeDTilesError::InvalidField("subtree length"))?;
    let binary_end = json_end
        .checked_add(binary_length)
        .ok_or(ImplicitThreeDTilesError::InvalidField("subtree length"))?;
    if binary_end != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
        return Err(ImplicitThreeDTilesError::InvalidField("subtree length"));
    }
    let json_end = usize::try_from(json_end)
        .map_err(|_| ImplicitThreeDTilesError::InvalidField("subtree length"))?;
    let binary_end = usize::try_from(binary_end)
        .map_err(|_| ImplicitThreeDTilesError::InvalidField("subtree length"))?;
    Ok((
        &bytes[SUBTREE_HEADER_BYTES..json_end],
        (binary_length > 0).then_some(&bytes[json_end..binary_end]),
    ))
}

fn resolve_buffers<'a>(
    descriptions: &[JsonBuffer],
    internal: Option<&'a [u8]>,
    subtree_uri: &str,
    external: &'a BTreeMap<String, Vec<u8>>,
) -> Result<Vec<&'a [u8]>, ImplicitThreeDTilesError> {
    descriptions
        .iter()
        .enumerate()
        .map(|(index, buffer)| {
            let bytes = if let Some(uri) = &buffer.uri {
                let resolved = resolve_uri(base_uri(subtree_uri), uri);
                external
                    .get(&resolved)
                    .or_else(|| external.get(uri))
                    .map(Vec::as_slice)
                    .ok_or(ImplicitThreeDTilesError::MissingExternalBuffer(resolved))?
            } else if index == 0 {
                internal.ok_or(ImplicitThreeDTilesError::InvalidField(
                    "internal subtree buffer",
                ))?
            } else {
                return Err(ImplicitThreeDTilesError::InvalidField("buffer.uri"));
            };
            if u64::try_from(bytes.len()).unwrap_or(u64::MAX) < buffer.byte_length {
                return Err(ImplicitThreeDTilesError::InvalidField("buffer.byteLength"));
            }
            Ok(bytes)
        })
        .collect()
}

fn resolve_availability(
    availability: &JsonAvailability,
    views: &[JsonBufferView],
    buffers: &[&[u8]],
) -> Result<Availability, ImplicitThreeDTilesError> {
    match (availability.constant, availability.bitstream) {
        (Some(constant @ 0..=1), None) => Ok(Availability::Constant(constant == 1)),
        (None, Some(view_index)) => {
            let view = views
                .get(view_index)
                .ok_or(ImplicitThreeDTilesError::InvalidField(
                    "availability.bitstream",
                ))?;
            if view.byte_offset % 8 != 0 {
                return Err(ImplicitThreeDTilesError::InvalidField(
                    "bufferView.byteOffset",
                ));
            }
            let buffer = buffers
                .get(view.buffer)
                .ok_or(ImplicitThreeDTilesError::InvalidField("bufferView.buffer"))?;
            let start = usize::try_from(view.byte_offset)
                .map_err(|_| ImplicitThreeDTilesError::InvalidField("bufferView.byteOffset"))?;
            let end = view
                .byte_offset
                .checked_add(view.byte_length)
                .and_then(|end| usize::try_from(end).ok())
                .ok_or(ImplicitThreeDTilesError::InvalidField(
                    "bufferView.byteLength",
                ))?;
            let bits = buffer
                .get(start..end)
                .ok_or(ImplicitThreeDTilesError::InvalidField(
                    "bufferView.byteLength",
                ))?
                .to_vec();
            if let Some(expected) = availability.available_count {
                let actual: u64 = bits.iter().map(|byte| u64::from(byte.count_ones())).sum();
                if actual != expected {
                    return Err(ImplicitThreeDTilesError::InvalidField(
                        "availability.availableCount",
                    ));
                }
            }
            Ok(Availability::Bits(bits))
        }
        _ => Err(ImplicitThreeDTilesError::InvalidField("availability")),
    }
}

fn implicit_provider_metadata(
    availability: &ParsedAvailability,
    decoded: Option<&DecodedStructuralMetadata>,
    availability_index: u64,
    is_subtree_root: bool,
) -> Result<Option<serde_json::Value>, ImplicitThreeDTilesError> {
    let Some(metadata) = &availability.metadata else {
        return Ok(None);
    };
    let decoded = decoded.ok_or(ImplicitThreeDTilesError::InvalidField(
        "decoded subtree metadata",
    ))?;
    let tile = metadata
        .tile_table
        .map(|table| {
            let row = availability.tile.available_rank(availability_index).ok_or(
                ImplicitThreeDTilesError::InvalidField("tile metadata availability rank"),
            )?;
            implicit_property_table_row(decoded, table, row)
        })
        .transpose()?;
    let contents = metadata
        .content_tables
        .iter()
        .enumerate()
        .map(|(content_index, table)| {
            let Some(row) = availability
                .content
                .get(content_index)
                .and_then(|content| content.available_rank(availability_index))
            else {
                return Ok(serde_json::Value::Null);
            };
            let mut value = implicit_property_table_row(decoded, *table, row)?;
            value["contentIndex"] = serde_json::Value::from(content_index);
            Ok(value)
        })
        .collect::<Result<Vec<_>, ImplicitThreeDTilesError>>()?;
    Ok(Some(serde_json::json!({
        "implicitMetadata": {
            "schemaUri": decoded.schema_uri,
            "tile": tile,
            "contents": contents,
            "subtree": is_subtree_root.then(|| metadata.subtree.clone()).flatten(),
        }
    })))
}

fn implicit_property_table_row(
    metadata: &DecodedStructuralMetadata,
    table: usize,
    row: u32,
) -> Result<serde_json::Value, ImplicitThreeDTilesError> {
    let definition = metadata.property_tables.get(table).cloned().ok_or(
        ImplicitThreeDTilesError::InvalidField("subtree property table index"),
    )?;
    let properties = metadata
        .schema
        .as_ref()
        .map(|_| metadata.property_table_row(table, row))
        .transpose()
        .map_err(|_| ImplicitThreeDTilesError::InvalidField("subtree property table row"))?;
    Ok(serde_json::json!({
        "propertyTable": table,
        "row": row,
        "definition": definition,
        "properties": properties,
    }))
}

fn tile_descriptor(
    configuration: &ImplicitConfiguration,
    coordinates: ImplicitTileCoordinates,
    parent: Option<TileId>,
    available: &BTreeSet<ImplicitTileCoordinates>,
    content_availability: &[Availability],
    availability_index: u64,
    provider_metadata: Option<serde_json::Value>,
) -> TileDescriptor {
    let children = implicit_children(coordinates, configuration.scheme)
        .into_iter()
        .filter(|child| available.contains(child))
        .map(|child| tile_id(child, configuration.scheme))
        .collect();
    let contents = configuration
        .content_templates
        .iter()
        .zip(content_availability)
        .filter(|(_, availability)| availability.get(availability_index))
        .map(|(template, _)| {
            let uri = resolve_uri(
                &configuration.base_uri,
                &substitute_template(template, coordinates, configuration.scheme),
            );
            ContentReference {
                kind: content_kind(&uri),
                uri,
                byte_offset: None,
                byte_length: None,
                primitive_count: None,
                content_hash: None,
                decoder_parameters: None,
            }
        })
        .collect();
    TileDescriptor {
        id: tile_id(coordinates, configuration.scheme),
        parent,
        children,
        bounds: tile_bounds(configuration, coordinates),
        content_transform: configuration.transform,
        geometric_error: configuration.root_error
            / 2_f64.powi(i32::try_from(coordinates.level).expect("level is at most 52")),
        refinement: configuration.refinement,
        contents,
        child_page: None,
        prepared_point_metadata: None,
        provider_metadata,
    }
}

fn placeholder_descriptor(
    configuration: &ImplicitConfiguration,
    coordinates: ImplicitTileCoordinates,
    parent: Option<TileId>,
) -> TileDescriptor {
    TileDescriptor {
        id: tile_id(coordinates, configuration.scheme),
        parent,
        children: Vec::new(),
        bounds: tile_bounds(configuration, coordinates),
        content_transform: configuration.transform,
        geometric_error: configuration.root_error
            / 2_f64.powi(i32::try_from(coordinates.level).expect("level is at most 52")),
        refinement: configuration.refinement,
        contents: Vec::new(),
        child_page: Some(HierarchyPageReference {
            uri: resolve_uri(
                &configuration.base_uri,
                &substitute_template(
                    &configuration.subtree_template,
                    coordinates,
                    configuration.scheme,
                ),
            ),
            byte_offset: None,
            byte_length: None,
            content_hash: None,
            decoder_parameters: None,
        }),
        prepared_point_metadata: None,
        provider_metadata: None,
    }
}

fn tile_bounds(
    configuration: &ImplicitConfiguration,
    coordinates: ImplicitTileCoordinates,
) -> BoundingVolume {
    let divisions = 2_f64.powi(i32::try_from(coordinates.level).expect("level is at most 52"));
    match &configuration.root_bounds {
        RootBounds::Box { center, half_axes } => {
            let split_z = configuration.scheme == ImplicitSubdivisionScheme::Octree;
            let fractions = [
                (coordinate_f64(coordinates.x) + 0.5) / divisions * 2.0 - 1.0,
                (coordinate_f64(coordinates.y) + 0.5) / divisions * 2.0 - 1.0,
                if split_z {
                    (coordinate_f64(coordinates.z) + 0.5) / divisions * 2.0 - 1.0
                } else {
                    0.0
                },
            ];
            let center = add_world(
                *center,
                add_world(
                    scale_world(half_axes[0], fractions[0]),
                    add_world(
                        scale_world(half_axes[1], fractions[1]),
                        scale_world(half_axes[2], fractions[2]),
                    ),
                ),
            );
            BoundingVolume::OrientedBox {
                center,
                half_axes: [
                    scale_world(half_axes[0], 1.0 / divisions),
                    scale_world(half_axes[1], 1.0 / divisions),
                    scale_world(half_axes[2], if split_z { 1.0 / divisions } else { 1.0 }),
                ],
            }
        }
        RootBounds::Region(root) => {
            let interpolate = |minimum: f64, maximum: f64, coordinate: u64| {
                let size = (maximum - minimum) / divisions;
                (
                    minimum + size * coordinate_f64(coordinate),
                    minimum + size * coordinate_f64(coordinate + 1),
                )
            };
            let (west, east) = interpolate(root[0], root[2], coordinates.x);
            let (south, north) = interpolate(root[1], root[3], coordinates.y);
            let (minimum_height, maximum_height) =
                if configuration.scheme == ImplicitSubdivisionScheme::Octree {
                    interpolate(root[4], root[5], coordinates.z)
                } else {
                    (root[4], root[5])
                };
            BoundingVolume::GeodeticRegion {
                west,
                south,
                east,
                north,
                minimum_height,
                maximum_height,
            }
        }
    }
}

fn validate_levels(
    available: u32,
    subtree: u32,
    scheme: ImplicitSubdivisionScheme,
) -> Result<(), ImplicitThreeDTilesError> {
    if available == 0 || available > 53 || subtree == 0 {
        return Err(ImplicitThreeDTilesError::InvalidField(
            "implicitTiling levels",
        ));
    }
    let branching = scheme.branching();
    let nodes = level_offset(branching, subtree)?;
    if nodes > MAX_SUBTREE_NODES {
        return Err(ImplicitThreeDTilesError::InvalidField("subtreeLevels"));
    }
    Ok(())
}

fn level_offset(branching: u64, level: u32) -> Result<u64, ImplicitThreeDTilesError> {
    if level == 0 {
        return Ok(0);
    }
    branching
        .checked_pow(level)
        .and_then(|power| power.checked_sub(1))
        .and_then(|numerator| numerator.checked_div(branching - 1))
        .ok_or(ImplicitThreeDTilesError::InvalidField("subtreeLevels"))
}

fn decode_morton(
    morton: u64,
    level: u32,
    scheme: ImplicitSubdivisionScheme,
) -> ImplicitTileCoordinates {
    let dimensions = scheme.dimensions();
    let mut coordinates = [0_u64; 3];
    for bit in 0..level {
        for dimension in 0..dimensions {
            let source = bit * dimensions + dimension;
            coordinates[usize::try_from(dimension).expect("dimension")] |=
                ((morton >> source) & 1) << bit;
        }
    }
    ImplicitTileCoordinates {
        level,
        x: coordinates[0],
        y: coordinates[1],
        z: coordinates[2],
    }
}

fn encode_morton(coordinates: [u64; 3], level: u32, dimensions: u32) -> u64 {
    let mut morton = 0_u64;
    for bit in 0..level {
        for dimension in 0..dimensions {
            morton |= ((coordinates[usize::try_from(dimension).expect("dimension")] >> bit) & 1)
                << (bit * dimensions + dimension);
        }
    }
    morton
}

fn global_coordinates(
    root: ImplicitTileCoordinates,
    local: ImplicitTileCoordinates,
) -> Result<ImplicitTileCoordinates, ImplicitThreeDTilesError> {
    let shift = local.level;
    Ok(ImplicitTileCoordinates {
        level: root.level.saturating_add(local.level),
        x: root
            .x
            .checked_shl(shift)
            .and_then(|value| value.checked_add(local.x))
            .ok_or(ImplicitThreeDTilesError::InvalidField("tile coordinates"))?,
        y: root
            .y
            .checked_shl(shift)
            .and_then(|value| value.checked_add(local.y))
            .ok_or(ImplicitThreeDTilesError::InvalidField("tile coordinates"))?,
        z: root
            .z
            .checked_shl(shift)
            .and_then(|value| value.checked_add(local.z))
            .ok_or(ImplicitThreeDTilesError::InvalidField("tile coordinates"))?,
    })
}

fn local_morton(
    coordinates: ImplicitTileCoordinates,
    root: ImplicitTileCoordinates,
    local_level: u32,
    scheme: ImplicitSubdivisionScheme,
) -> Result<u64, ImplicitThreeDTilesError> {
    let coordinates = [
        coordinates.x.checked_sub(root.x << local_level),
        coordinates.y.checked_sub(root.y << local_level),
        coordinates.z.checked_sub(root.z << local_level),
    ];
    let [Some(x), Some(y), Some(z)] = coordinates else {
        return Err(ImplicitThreeDTilesError::InvalidField("tile coordinates"));
    };
    Ok(encode_morton([x, y, z], local_level, scheme.dimensions()))
}

fn implicit_children(
    parent: ImplicitTileCoordinates,
    scheme: ImplicitSubdivisionScheme,
) -> Vec<ImplicitTileCoordinates> {
    let z_count = if scheme == ImplicitSubdivisionScheme::Octree {
        2
    } else {
        1
    };
    (0_u64..z_count)
        .flat_map(|z| {
            (0_u64..2).flat_map(move |y| {
                (0_u64..2).map(move |x| ImplicitTileCoordinates {
                    level: parent.level.saturating_add(1),
                    x: parent.x * 2 + x,
                    y: parent.y * 2 + y,
                    z: parent.z * 2 + z,
                })
            })
        })
        .collect()
}

fn tile_id(coordinates: ImplicitTileCoordinates, scheme: ImplicitSubdivisionScheme) -> TileId {
    match scheme {
        ImplicitSubdivisionScheme::Quadtree => TileId(format!(
            "i/{}/{}/{}",
            coordinates.level, coordinates.x, coordinates.y
        )),
        ImplicitSubdivisionScheme::Octree => TileId(format!(
            "i/{}/{}/{}/{}",
            coordinates.level, coordinates.x, coordinates.y, coordinates.z
        )),
    }
}

fn substitute_template(
    template: &str,
    coordinates: ImplicitTileCoordinates,
    scheme: ImplicitSubdivisionScheme,
) -> String {
    let mut result = template
        .replace("{level}", &coordinates.level.to_string())
        .replace("{x}", &coordinates.x.to_string())
        .replace("{y}", &coordinates.y.to_string());
    if scheme == ImplicitSubdivisionScheme::Octree {
        result = result.replace("{z}", &coordinates.z.to_string());
    }
    result
}

fn validate_template(
    template: &str,
    scheme: ImplicitSubdivisionScheme,
) -> Result<(), ImplicitThreeDTilesError> {
    if !template.contains("{level}")
        || !template.contains("{x}")
        || !template.contains("{y}")
        || (scheme == ImplicitSubdivisionScheme::Octree && !template.contains("{z}"))
    {
        return Err(ImplicitThreeDTilesError::InvalidField("template URI"));
    }
    Ok(())
}

fn parse_transform(values: Option<[f64; 16]>) -> Result<DMat4, ImplicitThreeDTilesError> {
    let values = values.unwrap_or(DMat4::IDENTITY.to_cols_array());
    if values.iter().any(|value| !value.is_finite()) {
        return Err(ImplicitThreeDTilesError::InvalidField("root.transform"));
    }
    Ok(DMat4::from_cols_array(&values))
}

fn parse_root_bounds(
    bounds: &JsonBoundingVolume,
    transform: DMat4,
) -> Result<RootBounds, ImplicitThreeDTilesError> {
    let count = usize::from(bounds.oriented_box.is_some()) + usize::from(bounds.region.is_some());
    if count != 1 {
        return Err(ImplicitThreeDTilesError::InvalidField(
            "root.boundingVolume",
        ));
    }
    if let Some(values) = bounds.oriented_box {
        if values.iter().any(|value| !value.is_finite()) {
            return Err(ImplicitThreeDTilesError::InvalidField(
                "root.boundingVolume.box",
            ));
        }
        let center = transform.transform_point3(DVec3::new(values[0], values[1], values[2]));
        let axes = [
            transform.transform_vector3(DVec3::new(values[3], values[4], values[5])),
            transform.transform_vector3(DVec3::new(values[6], values[7], values[8])),
            transform.transform_vector3(DVec3::new(values[9], values[10], values[11])),
        ];
        return Ok(RootBounds::Box {
            center: world_vec(center),
            half_axes: axes.map(world_vec),
        });
    }
    let region = bounds.region.expect("one root bound");
    if region.iter().any(|value| !value.is_finite()) {
        return Err(ImplicitThreeDTilesError::InvalidField(
            "root.boundingVolume.region",
        ));
    }
    Ok(RootBounds::Region(region))
}

fn maximum_scale(transform: DMat4) -> f64 {
    let axes = DAffine3::from_mat4(transform).matrix3;
    axes.x_axis
        .length()
        .max(axes.y_axis.length())
        .max(axes.z_axis.length())
}

fn world_vec(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

fn add_world(left: WorldVec3, right: WorldVec3) -> WorldVec3 {
    WorldVec3 {
        x: left.x + right.x,
        y: left.y + right.y,
        z: left.z + right.z,
    }
}

fn scale_world(value: WorldVec3, scale: f64) -> WorldVec3 {
    WorldVec3 {
        x: value.x * scale,
        y: value.y * scale,
        z: value.z * scale,
    }
}

fn coordinate_f64(value: u64) -> f64 {
    // `availableLevels <= 53` keeps every coordinate at or below 2^52, which
    // f64 represents exactly before root-bound interpolation.
    #[allow(clippy::cast_precision_loss)]
    let converted = value as f64;
    converted
}

fn content_uri(content: JsonContent) -> Result<String, ImplicitThreeDTilesError> {
    content
        .uri
        .or(content.url)
        .ok_or(ImplicitThreeDTilesError::InvalidField("content.uri"))
}

fn content_kind(uri: &str) -> ContentKind {
    if matches!(file_extension(uri), Some(extension) if extension.eq_ignore_ascii_case("glb") || extension.eq_ignore_ascii_case("gltf"))
    {
        ContentKind::Gltf
    } else {
        ContentKind::ThreeDTilesContainer
    }
}

fn is_external_tileset(uri: &str) -> bool {
    matches!(file_extension(uri), Some(extension) if extension.eq_ignore_ascii_case("json"))
}

fn file_extension(uri: &str) -> Option<&str> {
    uri.split(['?', '#'])
        .next()
        .and_then(|path| path.rsplit_once('.'))
        .map(|(_, extension)| extension)
}

fn base_uri(uri: &str) -> &str {
    uri.rsplit_once('/')
        .map_or("", |(base, _)| &uri[..=base.len()])
}

fn resolve_uri(base: &str, uri: &str) -> String {
    if uri.contains("://") || uri.starts_with('/') {
        uri.to_owned()
    } else {
        format!("{base}{uri}")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::ImplicitThreeDTilesHierarchySource;
    use crate::{BoundingVolume, DatasetId, HierarchySource, TileId};

    #[test]
    fn binary_quadtree_subtree_resolves_morton_content_and_child_page() {
        let tileset = br#"{
          "asset":{"version":"1.1"},
          "root":{
            "boundingVolume":{"box":[0,0,0, 8,0,0, 0,8,0, 0,0,2]},
            "geometricError":16,
            "refine":"REPLACE",
            "content":{"uri":"content/{level}/{x}/{y}.glb"},
            "implicitTiling":{
              "subdivisionScheme":"QUADTREE",
              "availableLevels":5,
              "subtreeLevels":2,
              "subtrees":{"uri":"subtrees/{level}/{x}/{y}.subtree"}
            }
          }
        }"#;
        let mut source = ImplicitThreeDTilesHierarchySource::from_json(
            DatasetId("implicit".to_owned()),
            "https://example.test/tiles/tileset.json",
            tileset,
        )
        .expect("implicit root");
        let root_id = TileId("i/0/0/0".to_owned());
        let before = source.tile(&root_id).expect("lookup").expect("placeholder");
        assert_eq!(
            before.child_page.expect("subtree page").uri,
            "https://example.test/tiles/subtrees/0/0/0.subtree"
        );

        // Tile bits: root and four level-1 tiles are available. Content exists
        // at root and Morton child 2. Child-subtree bit 3 creates level-2 (1,1).
        let subtree = binary_subtree(
            r#"{"buffers":[{"byteLength":16}],"bufferViews":[
              {"buffer":0,"byteOffset":0,"byteLength":1},
              {"buffer":0,"byteOffset":8,"byteLength":2}],
              "tileAvailability":{"constant":1},
              "contentAvailability":[{"bitstream":0,"availableCount":2}],
              "childSubtreeAvailability":{"bitstream":1,"availableCount":1}}"#,
            &[
                0b0000_1001,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0b0000_1000,
                0,
                0,
                0,
                0,
                0,
                0,
            ],
        );
        source
            .apply_binary_subtree(
                &root_id,
                "https://example.test/tiles/subtrees/0/0/0.subtree",
                &subtree,
            )
            .expect("apply subtree");

        let root = source.tile(&root_id).expect("lookup").expect("root");
        assert_eq!(root.children.len(), 4);
        assert_eq!(
            root.contents[0].uri,
            "https://example.test/tiles/content/0/0/0.glb"
        );
        let morton_two = source
            .tile(&TileId("i/1/0/1".to_owned()))
            .expect("lookup")
            .expect("Morton child two");
        assert_eq!(morton_two.contents.len(), 1);
        let child_subtree = source
            .tile(&TileId("i/2/1/1".to_owned()))
            .expect("lookup")
            .expect("child subtree placeholder");
        assert!(child_subtree.contents.is_empty());
        assert_eq!(
            child_subtree.child_page.expect("child subtree").uri,
            "https://example.test/tiles/subtrees/2/1/1.subtree"
        );
        let BoundingVolume::OrientedBox {
            center, half_axes, ..
        } = child_subtree.bounds
        else {
            panic!("implicit box")
        };
        assert!((center.x + 2.0).abs() < f64::EPSILON);
        assert!((center.y + 2.0).abs() < f64::EPSILON);
        assert!((half_axes[0].x - 2.0).abs() < f64::EPSILON);
        assert!((half_axes[2].z - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn octree_region_subdivides_height_and_requires_z_template() {
        let tileset = br#"{
          "asset":{"version":"1.1"},
          "root":{
            "boundingVolume":{"region":[0,0,8,8,0,80]},
            "geometricError":8,
            "contents":[],
            "implicitTiling":{
              "subdivisionScheme":"OCTREE","availableLevels":2,"subtreeLevels":1,
              "subtrees":{"uri":"s/{level}/{x}/{y}/{z}.json"}
            }
          }
        }"#;
        let mut source = ImplicitThreeDTilesHierarchySource::from_json(
            DatasetId("octree".to_owned()),
            "tileset.json",
            tileset,
        )
        .expect("octree root");
        source
            .apply_subtree(
                &TileId("i/0/0/0/0".to_owned()),
                "s/0/0/0/0.json",
                br#"{"tileAvailability":{"constant":1},"childSubtreeAvailability":{"constant":1}}"#,
                &BTreeMap::default(),
            )
            .expect("constant subtree");
        let high = source
            .tile(&TileId("i/1/1/1/1".to_owned()))
            .expect("lookup")
            .expect("octree child");
        let BoundingVolume::GeodeticRegion {
            minimum_height,
            maximum_height,
            ..
        } = high.bounds
        else {
            panic!("region")
        };
        assert!((minimum_height - 40.0).abs() < f64::EPSILON);
        assert!((maximum_height - 80.0).abs() < f64::EPSILON);
    }

    #[test]
    fn sparse_implicit_tile_metadata_uses_available_rank_not_morton_index() {
        let tileset = br#"{
          "asset":{"version":"1.1"},
          "schema":{"classes":{"tileClass":{"properties":{
            "height":{"type":"SCALAR","componentType":"FLOAT32"},
            "quality":{"type":"SCALAR","componentType":"FLOAT32"}
          }}}},
          "root":{
            "boundingVolume":{"box":[0,0,0, 8,0,0, 0,8,0, 0,0,2]},
            "geometricError":16,
            "content":{"uri":"content/{level}/{x}/{y}.glb"},
            "implicitTiling":{
              "subdivisionScheme":"QUADTREE","availableLevels":2,"subtreeLevels":2,
              "subtrees":{"uri":"subtrees/{level}/{x}/{y}.subtree"}
            }
          }
        }"#;
        let mut source = ImplicitThreeDTilesHierarchySource::from_json(
            DatasetId("metadata".to_owned()),
            "tileset.json",
            tileset,
        )
        .expect("metadata root");
        let mut binary = vec![0b0000_1001];
        binary.resize(8, 0);
        binary.extend(10.0_f32.to_le_bytes());
        binary.extend(20.0_f32.to_le_bytes());
        binary.extend(100.0_f32.to_le_bytes());
        binary.extend(200.0_f32.to_le_bytes());
        let subtree = binary_subtree(
            r#"{"buffers":[{"byteLength":24}],"bufferViews":[
              {"buffer":0,"byteOffset":0,"byteLength":1},
              {"buffer":0,"byteOffset":8,"byteLength":8},
              {"buffer":0,"byteOffset":16,"byteLength":8}],
              "tileAvailability":{"bitstream":0,"availableCount":2},
              "contentAvailability":[{"bitstream":0,"availableCount":2}],
              "childSubtreeAvailability":{"constant":0},
              "propertyTables":[{"class":"tileClass","count":2,"properties":{
                "height":{"values":1}
              }},{"class":"tileClass","count":2,"properties":{
                "quality":{"values":2}
              }}],
              "tileMetadata":0,
              "contentMetadata":[1],
              "subtreeMetadata":{"class":"subtree","properties":{"name":"root page"}}}"#,
            &binary,
        );
        let root_id = TileId("i/0/0/0".to_owned());
        source
            .apply_binary_subtree(&root_id, "subtrees/0/0/0.subtree", &subtree)
            .expect("metadata subtree");

        let root = source.tile(&root_id).expect("root lookup").expect("root");
        let root_metadata = root.provider_metadata.expect("root metadata");
        assert_eq!(
            root_metadata["implicitMetadata"]["tile"]["properties"]["height"],
            10.0
        );
        assert_eq!(
            root_metadata["implicitMetadata"]["subtree"]["properties"]["name"],
            "root page"
        );

        let sparse_child = source
            .tile(&TileId("i/1/0/1".to_owned()))
            .expect("child lookup")
            .expect("sparse child");
        let child_metadata = sparse_child.provider_metadata.expect("child metadata");
        assert_eq!(child_metadata["implicitMetadata"]["tile"]["row"], 1);
        assert_eq!(
            child_metadata["implicitMetadata"]["tile"]["properties"]["height"],
            20.0
        );
        assert_eq!(
            child_metadata["implicitMetadata"]["contents"][0]["properties"]["quality"],
            200.0
        );
        assert!(child_metadata["implicitMetadata"]["subtree"].is_null());
    }

    fn binary_subtree(json: &str, binary: &[u8]) -> Vec<u8> {
        let mut padded_json = json.as_bytes().to_vec();
        while !padded_json.len().is_multiple_of(8) {
            padded_json.push(b' ');
        }
        let mut padded_binary = binary.to_vec();
        while !padded_binary.len().is_multiple_of(8) {
            padded_binary.push(0);
        }
        let mut result = b"subt".to_vec();
        result.extend_from_slice(&1_u32.to_le_bytes());
        result.extend_from_slice(
            &u64::try_from(padded_json.len())
                .expect("JSON length")
                .to_le_bytes(),
        );
        result.extend_from_slice(
            &u64::try_from(padded_binary.len())
                .expect("binary length")
                .to_le_bytes(),
        );
        result.extend_from_slice(&padded_json);
        result.extend_from_slice(&padded_binary);
        result
    }
}
