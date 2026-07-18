//! Legacy 3D Tiles container and point-content decoding.

use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::{DMat4, DVec3};
use serde::{Deserialize, Serialize};

use super::legacy_batch_hierarchy::{
    decode_legacy_batch_table_hierarchy, DecodedLegacyBatchTableHierarchy,
    DecodedLegacyHierarchyRow,
};
use super::legacy_batch_table::{legacy_batch_table_row, validate_legacy_batch_table};
use super::legacy_tiles_layout::{
    embedded_glb, parse_i3dm_uri as parse_layout_i3dm_uri, trim_json_space_padding,
    validate_common_tile, validate_table_tile, LegacyLayoutError, LegacyTableSections,
};

use crate::{
    decode_glb, decode_glb_intrinsic, decode_gltf_intrinsic_with_resources,
    decode_gltf_with_resources, DecodedGlb, DecodedPotreePoints, GlbDecodeError,
    ResolvedAssetBundle, ResolvedAssetKind, WorldTransform, WorldVec3,
};

const FEATURE_HEADER_BYTES: usize = 28;
const INSTANCE_HEADER_BYTES: usize = 32;
const COMPOSITE_HEADER_BYTES: usize = 16;
const MAX_COMPOSITE_DEPTH: usize = 8;

/// Explicit interpretation of the primary streamed payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreeDTilesContentKind {
    /// Direct JSON glTF or GLB model.
    Gltf,
    /// Legacy b3dm/i3dm/pnts/cmpt container.
    ThreeDTilesContainer,
}

/// Fully decoded legacy 3D Tiles content ready for shared GPU resource builders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DecodedThreeDTilesContent {
    /// Direct GLB or a `b3dm` embedded GLB.
    Mesh(DecodedBatchedModel),
    /// Legacy `pnts` content.
    Points(DecodedPointTile),
    /// One shared model plus compact legacy `i3dm` instance transforms.
    InstancedMesh(DecodedInstancedModel),
    /// Ordered heterogeneous `cmpt` children, including nested composites.
    Composite(Vec<DecodedThreeDTilesContent>),
}

/// Retained, geometry-independent legacy feature metadata for exact queries.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedLegacyBatchTableCatalog {
    batch_length: u32,
    json: Option<serde_json::Value>,
    binary: Vec<u8>,
    hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

impl DecodedLegacyBatchTableCatalog {
    /// Number of feature IDs addressable by the batch table.
    #[must_use]
    pub const fn batch_length(&self) -> u32 {
        self.batch_length
    }

    /// Whether a direct or hierarchical batch-table document is retained.
    #[must_use]
    pub const fn has_batch_table(&self) -> bool {
        self.json.is_some()
    }

    /// Decodes direct properties for one exact legacy feature when present.
    pub fn direct_row(
        &self,
        feature_id: u32,
    ) -> Result<Option<serde_json::Value>, ThreeDTilesContentError> {
        if feature_id >= self.batch_length {
            return Err(ThreeDTilesContentError::InvalidJson(
                "batch-table feature ID is out of range".to_owned(),
            ));
        }
        self.json
            .as_ref()
            .map(|json| {
                legacy_batch_table_row(Some(json), &self.binary, self.batch_length, feature_id)
            })
            .transpose()
    }

    /// Resolves exact hierarchy provenance and inherited properties when present.
    pub fn hierarchy_row(
        &self,
        feature_id: u32,
    ) -> Result<Option<DecodedLegacyHierarchyRow>, ThreeDTilesContentError> {
        resolve_hierarchy(
            self.hierarchy.as_ref(),
            self.json.as_ref(),
            &self.binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Returns direct properties or their direct-over-inherited resolved view.
    pub fn resolved_row(
        &self,
        feature_id: u32,
    ) -> Result<Option<serde_json::Value>, ThreeDTilesContentError> {
        self.hierarchy_row(feature_id)?
            .map(|row| row.properties)
            .map_or_else(|| self.direct_row(feature_id), |row| Ok(Some(row)))
    }

    /// Retained heap bytes excluding the inline catalog and JSON allocator overhead.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        let json_bytes = self.json.as_ref().map_or(0, |json| {
            u64::try_from(json.to_string().len()).unwrap_or(u64::MAX)
        });
        json_bytes
            .saturating_add(u64::try_from(self.binary.capacity()).unwrap_or(u64::MAX))
            .saturating_add(
                self.hierarchy
                    .as_ref()
                    .map_or(0, DecodedLegacyBatchTableHierarchy::resident_bytes),
            )
    }
}

/// Decoded `b3dm` model and retained feature metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedBatchedModel {
    /// Transformed GLB geometry and textures.
    pub glb: DecodedGlb,
    /// Number of feature IDs declared by the feature table.
    pub batch_length: u32,
    /// Feature ID represented by this leaf when legacy instancing was expanded.
    pub feature_id: Option<u32>,
    /// Per-feature metadata JSON retained losslessly.
    pub batch_table_json: Option<serde_json::Value>,
    /// Raw binary body referenced by batch-table property descriptors.
    pub batch_table_binary: Vec<u8>,
    /// Prevalidated optional legacy class/parent topology.
    pub batch_table_hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

impl DecodedBatchedModel {
    /// Clones only validated legacy metadata, never mesh geometry.
    #[must_use]
    pub fn legacy_metadata_catalog(&self) -> DecodedLegacyBatchTableCatalog {
        legacy_metadata_catalog(
            self.batch_length,
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_table_hierarchy.as_ref(),
        )
    }

    /// Retained heap bytes for legacy metadata in this decoded tile.
    #[must_use]
    pub fn legacy_metadata_resident_bytes(&self) -> u64 {
        legacy_metadata_resident_bytes(
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_table_hierarchy.as_ref(),
        )
    }

    /// Decodes the direct legacy properties for one exact batch feature.
    pub fn batch_table_row(
        &self,
        feature_id: u32,
    ) -> Result<serde_json::Value, ThreeDTilesContentError> {
        legacy_batch_table_row(
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Maps the stable source-triangle ID returned by exact mesh picking to
    /// the legacy batch feature selected at the hit barycentric coordinate.
    #[must_use]
    pub fn batch_feature_id_at_source_triangle(
        &self,
        source_primitive_id: u64,
        barycentric: [f64; 3],
    ) -> Option<u32> {
        let mut primitive_base = 0_u64;
        for primitive in &self.glb.primitives {
            let triangle_count = u64::try_from(primitive.indices.len() / 3).ok()?;
            let primitive_end = primitive_base.checked_add(triangle_count)?;
            if source_primitive_id < primitive_end {
                let triangle = usize::try_from(source_primitive_id - primitive_base).ok()?;
                return match primitive
                    .legacy_batch_ids
                    .as_ref()?
                    .feature_id_at_triangle(triangle, barycentric)?
                {
                    crate::DecodedTriangleFeatureId::Feature(feature_id) => Some(feature_id),
                    crate::DecodedTriangleFeatureId::Null
                    | crate::DecodedTriangleFeatureId::Ambiguous
                    | crate::DecodedTriangleFeatureId::Texture => None,
                };
            }
            primitive_base = primitive_end;
        }
        None
    }

    /// Resolves the optional hierarchy and inherited properties for one feature.
    pub fn batch_table_hierarchy_row(
        &self,
        feature_id: u32,
    ) -> Result<Option<DecodedLegacyHierarchyRow>, ThreeDTilesContentError> {
        resolve_hierarchy(
            self.batch_table_hierarchy.as_ref(),
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Returns direct properties, or the direct-over-inherited hierarchy view.
    pub fn resolved_batch_table_row(
        &self,
        feature_id: u32,
    ) -> Result<serde_json::Value, ThreeDTilesContentError> {
        self.batch_table_hierarchy_row(feature_id)?
            .map(|row| row.properties)
            .map_or_else(|| self.batch_table_row(feature_id), Ok)
    }
}

/// A shared decoded model and its f64 world-space instances.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedInstancedModel {
    /// Model-local, Z-up geometry decoded exactly once.
    pub glb: DecodedGlb,
    /// Stable source-ordered instance transforms and feature IDs.
    pub instances: Vec<DecodedMeshInstance>,
    /// Feature count declared by `INSTANCES_LENGTH`.
    pub batch_length: u32,
    /// Per-feature JSON metadata retained once for the whole tile.
    pub batch_table_json: Option<serde_json::Value>,
    /// Raw binary body referenced by batch-table property descriptors.
    pub batch_table_binary: Vec<u8>,
    /// Prevalidated optional legacy class/parent topology.
    pub batch_table_hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

impl DecodedInstancedModel {
    /// Clones only validated legacy metadata, never shared model geometry.
    #[must_use]
    pub fn legacy_metadata_catalog(&self) -> DecodedLegacyBatchTableCatalog {
        legacy_metadata_catalog(
            self.batch_length,
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_table_hierarchy.as_ref(),
        )
    }

    /// Retained heap bytes for legacy metadata in this decoded tile.
    #[must_use]
    pub fn legacy_metadata_resident_bytes(&self) -> u64 {
        legacy_metadata_resident_bytes(
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_table_hierarchy.as_ref(),
        )
    }

    /// Decodes the direct legacy properties addressed by an instance feature ID.
    pub fn batch_table_row(
        &self,
        feature_id: u32,
    ) -> Result<serde_json::Value, ThreeDTilesContentError> {
        legacy_batch_table_row(
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Resolves the optional hierarchy and inherited properties for one feature.
    pub fn batch_table_hierarchy_row(
        &self,
        feature_id: u32,
    ) -> Result<Option<DecodedLegacyHierarchyRow>, ThreeDTilesContentError> {
        resolve_hierarchy(
            self.batch_table_hierarchy.as_ref(),
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Returns direct properties, or the direct-over-inherited hierarchy view.
    pub fn resolved_batch_table_row(
        &self,
        feature_id: u32,
    ) -> Result<serde_json::Value, ThreeDTilesContentError> {
        self.batch_table_hierarchy_row(feature_id)?
            .map(|row| row.properties)
            .map_or_else(|| self.batch_table_row(feature_id), Ok)
    }
}

/// One source i3dm instance without duplicated model geometry.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DecodedMeshInstance {
    /// f64 transform from shared GLB-relative coordinates to project world.
    pub world_from_model: WorldTransform,
    /// Original instance index, stable across chunking and sorting.
    pub source_index: u32,
    /// Batch-table feature identity.
    pub feature_id: u32,
}

/// Decoded `pnts` geometry with optional feature identity and metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPointTile {
    /// Point positions and colors compatible with the shared point pipeline.
    pub points: DecodedPotreePoints,
    /// Per-point feature identity when `BATCH_ID` was declared.
    pub batch_ids: Option<Vec<u32>>,
    /// Number of addressable batch-table features.
    pub batch_length: u32,
    /// Per-feature or per-point metadata retained losslessly.
    pub batch_table_json: Option<serde_json::Value>,
    /// Raw binary body referenced by batch-table property descriptors.
    pub batch_table_binary: Vec<u8>,
    /// Prevalidated optional legacy class/parent topology.
    pub batch_table_hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

impl DecodedPointTile {
    /// Clones only validated legacy metadata, never point geometry.
    #[must_use]
    pub fn legacy_metadata_catalog(&self) -> DecodedLegacyBatchTableCatalog {
        legacy_metadata_catalog(
            self.batch_length,
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_table_hierarchy.as_ref(),
        )
    }

    /// Retained heap bytes for legacy metadata in this decoded tile.
    #[must_use]
    pub fn legacy_metadata_resident_bytes(&self) -> u64 {
        legacy_metadata_resident_bytes(
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_table_hierarchy.as_ref(),
        )
    }

    /// Decodes the direct legacy properties for one exact point feature ID.
    pub fn batch_table_row(
        &self,
        feature_id: u32,
    ) -> Result<serde_json::Value, ThreeDTilesContentError> {
        legacy_batch_table_row(
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Resolves the optional hierarchy and inherited properties for one feature.
    pub fn batch_table_hierarchy_row(
        &self,
        feature_id: u32,
    ) -> Result<Option<DecodedLegacyHierarchyRow>, ThreeDTilesContentError> {
        resolve_hierarchy(
            self.batch_table_hierarchy.as_ref(),
            self.batch_table_json.as_ref(),
            &self.batch_table_binary,
            self.batch_length,
            feature_id,
        )
    }

    /// Returns direct properties, or the direct-over-inherited hierarchy view.
    pub fn resolved_batch_table_row(
        &self,
        feature_id: u32,
    ) -> Result<serde_json::Value, ThreeDTilesContentError> {
        self.batch_table_hierarchy_row(feature_id)?
            .map(|row| row.properties)
            .map_or_else(|| self.batch_table_row(feature_id), Ok)
    }
}

fn resolve_hierarchy(
    hierarchy: Option<&DecodedLegacyBatchTableHierarchy>,
    batch_json: Option<&serde_json::Value>,
    batch_binary: &[u8],
    batch_length: u32,
    feature_id: u32,
) -> Result<Option<DecodedLegacyHierarchyRow>, ThreeDTilesContentError> {
    hierarchy
        .map(|hierarchy| {
            hierarchy.resolve_feature(
                batch_json.expect("decoded hierarchy retains JSON"),
                batch_binary,
                batch_length,
                feature_id,
            )
        })
        .transpose()
}

fn legacy_metadata_catalog(
    batch_length: u32,
    batch_table_json: Option<&serde_json::Value>,
    batch_table_binary: &[u8],
    batch_table_hierarchy: Option<&DecodedLegacyBatchTableHierarchy>,
) -> DecodedLegacyBatchTableCatalog {
    DecodedLegacyBatchTableCatalog {
        batch_length,
        json: batch_table_json.cloned(),
        binary: batch_table_binary.to_vec(),
        hierarchy: batch_table_hierarchy.cloned(),
    }
}

fn legacy_metadata_resident_bytes(
    batch_table_json: Option<&serde_json::Value>,
    batch_table_binary: &[u8],
    batch_table_hierarchy: Option<&DecodedLegacyBatchTableHierarchy>,
) -> u64 {
    let json_bytes = batch_table_json.map_or(0, |json| {
        u64::try_from(json.to_string().len()).unwrap_or(u64::MAX)
    });
    json_bytes
        .saturating_add(u64::try_from(batch_table_binary.len()).unwrap_or(u64::MAX))
        .saturating_add(
            batch_table_hierarchy.map_or(0, DecodedLegacyBatchTableHierarchy::resident_bytes),
        )
}

/// Invalid, unsupported or unsafe legacy tile content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreeDTilesContentError {
    /// Header, declared ranges or padding are structurally invalid.
    InvalidHeader(&'static str),
    /// Feature or batch table JSON is invalid.
    InvalidJson(String),
    /// Content magic is not implemented by this decoder.
    UnsupportedMagic([u8; 4]),
    /// Nested composites exceed the explicit parser bound.
    CompositeDepth,
    /// Point semantics or binary ranges are inconsistent.
    InvalidPointData(&'static str),
    /// Batched-model feature identity is inconsistent with its feature table.
    InvalidBatchData(&'static str),
    /// Instance semantics or binary ranges are inconsistent.
    InvalidInstanceData(&'static str),
    /// A transformed coordinate is non-finite or outside portable f32 range.
    CoordinateRange,
    /// Embedded glTF decoding failed.
    Gltf(GlbDecodeError),
}

impl Display for ThreeDTilesContentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHeader(message) => write!(formatter, "invalid 3D Tiles header: {message}"),
            Self::InvalidJson(message) => {
                write!(formatter, "invalid 3D Tiles table JSON: {message}")
            }
            Self::UnsupportedMagic(magic) => write!(
                formatter,
                "unsupported 3D Tiles content magic: {}",
                String::from_utf8_lossy(magic)
            ),
            Self::CompositeDepth => formatter.write_str("3D Tiles composite nesting is too deep"),
            Self::InvalidPointData(message) => {
                write!(formatter, "invalid pnts feature data: {message}")
            }
            Self::InvalidBatchData(message) => {
                write!(formatter, "invalid b3dm feature data: {message}")
            }
            Self::InvalidInstanceData(message) => {
                write!(formatter, "invalid i3dm feature data: {message}")
            }
            Self::CoordinateRange => {
                formatter.write_str("3D Tiles coordinate cannot be represented")
            }
            Self::Gltf(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for ThreeDTilesContentError {}

impl From<GlbDecodeError> for ThreeDTilesContentError {
    fn from(error: GlbDecodeError) -> Self {
        Self::Gltf(error)
    }
}

/// Detects and decodes GLB, `b3dm`, `pnts` or recursively nested `cmpt` bytes.
pub fn decode_three_d_tiles_content(
    bytes: &[u8],
    content_transform: WorldTransform,
    world_origin: WorldVec3,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    decode_content(
        bytes,
        content_transform,
        ContentOrigin::Explicit(world_origin),
        0,
        None,
    )
}

/// Decodes each leaf around its own deterministic f64 content anchor.
///
/// Composite children retain independent anchors, so distant leaves never
/// share a camera-selected origin or lose precision merely because they were
/// packaged in one `cmpt` payload.
pub fn decode_three_d_tiles_content_intrinsic(
    bytes: &[u8],
    content_transform: WorldTransform,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    decode_content(bytes, content_transform, ContentOrigin::Intrinsic, 0, None)
}

/// Decodes direct glTF or legacy 3D Tiles with a validated external asset set.
pub fn decode_three_d_tiles_content_with_resources(
    content_uri: &str,
    kind: ThreeDTilesContentKind,
    bytes: &[u8],
    resources: &ResolvedAssetBundle,
    content_transform: WorldTransform,
    world_origin: WorldVec3,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    decode_content_with_resources(
        content_uri,
        kind,
        bytes,
        resources,
        content_transform,
        ContentOrigin::Explicit(world_origin),
    )
}

/// Intrinsic-anchor variant of [`decode_three_d_tiles_content_with_resources`].
pub fn decode_three_d_tiles_content_intrinsic_with_resources(
    content_uri: &str,
    kind: ThreeDTilesContentKind,
    bytes: &[u8],
    resources: &ResolvedAssetBundle,
    content_transform: WorldTransform,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    decode_content_with_resources(
        content_uri,
        kind,
        bytes,
        resources,
        content_transform,
        ContentOrigin::Intrinsic,
    )
}

fn decode_content_with_resources(
    content_uri: &str,
    kind: ThreeDTilesContentKind,
    bytes: &[u8],
    resources: &ResolvedAssetBundle,
    content_transform: WorldTransform,
    origin: ContentOrigin,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    let context = ResourceContext {
        owner_uri: content_uri,
        bundle: resources,
    };
    if kind == ThreeDTilesContentKind::Gltf {
        return Ok(DecodedThreeDTilesContent::Mesh(DecodedBatchedModel {
            glb: decode_leaf_gltf(bytes, content_transform, origin, Some(context))?,
            batch_length: 0,
            feature_id: None,
            batch_table_json: None,
            batch_table_binary: Vec::new(),
            batch_table_hierarchy: None,
        }));
    }
    decode_content(bytes, content_transform, origin, 0, Some(context))
}

#[derive(Debug, Clone, Copy)]
enum ContentOrigin {
    Explicit(WorldVec3),
    Intrinsic,
}

#[derive(Debug, Clone, Copy)]
struct ResourceContext<'a> {
    owner_uri: &'a str,
    bundle: &'a ResolvedAssetBundle,
}

fn decode_content(
    bytes: &[u8],
    content_transform: WorldTransform,
    origin: ContentOrigin,
    depth: usize,
    resources: Option<ResourceContext<'_>>,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    if bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES {
        return Err(ThreeDTilesContentError::InvalidHeader(
            "content exceeds the encoded leaf limit",
        ));
    }
    let magic = bytes
        .get(..4)
        .and_then(|value| value.try_into().ok())
        .ok_or(ThreeDTilesContentError::InvalidHeader("missing magic"))?;
    match &magic {
        b"glTF" => Ok(DecodedThreeDTilesContent::Mesh(DecodedBatchedModel {
            glb: decode_leaf_gltf(bytes, content_transform, origin, resources)?,
            batch_length: 0,
            feature_id: None,
            batch_table_json: None,
            batch_table_binary: Vec::new(),
            batch_table_hierarchy: None,
        })),
        b"b3dm" => decode_b3dm(bytes, content_transform, origin, resources),
        b"i3dm" => decode_i3dm(bytes, content_transform, origin, resources),
        b"pnts" => decode_pnts(bytes, content_transform, origin),
        b"cmpt" => decode_cmpt(bytes, content_transform, origin, depth, resources),
        _ => Err(ThreeDTilesContentError::UnsupportedMagic(magic)),
    }
}

fn decode_leaf_gltf(
    bytes: &[u8],
    content_transform: WorldTransform,
    origin: ContentOrigin,
    resources: Option<ResourceContext<'_>>,
) -> Result<DecodedGlb, GlbDecodeError> {
    match (origin, resources) {
        (ContentOrigin::Explicit(world_origin), Some(resources)) => decode_gltf_with_resources(
            resources.owner_uri,
            bytes,
            resources.bundle,
            content_transform,
            world_origin,
        ),
        (ContentOrigin::Intrinsic, Some(resources)) => decode_gltf_intrinsic_with_resources(
            resources.owner_uri,
            bytes,
            resources.bundle,
            content_transform,
        ),
        (ContentOrigin::Explicit(world_origin), None) => {
            decode_glb(bytes, content_transform, world_origin)
        }
        (ContentOrigin::Intrinsic, None) => decode_glb_intrinsic(bytes, content_transform),
    }
}

fn decode_b3dm(
    bytes: &[u8],
    content_transform: WorldTransform,
    origin: ContentOrigin,
    resources: Option<ResourceContext<'_>>,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    let sections = feature_sections(bytes, *b"b3dm")?;
    let feature: B3dmFeatureTable = parse_json(sections.feature_json)?;
    let rtc = feature.rtc_center.unwrap_or([0.0; 3]);
    if rtc.iter().any(|value| !value.is_finite()) {
        return Err(ThreeDTilesContentError::CoordinateRange);
    }
    let transform = DMat4::from_cols_array(&content_transform.0)
        * DMat4::from_translation(DVec3::from_array(rtc));
    let glb = trim_glb_padding(sections.payload)?;
    let batch_table_json = parse_optional_json(sections.batch_json)?;
    validate_legacy_batch_table(
        batch_table_json.as_ref(),
        sections.batch_binary,
        feature.batch_length,
    )?;
    let batch_table_hierarchy = decode_legacy_batch_table_hierarchy(
        batch_table_json.as_ref(),
        sections.batch_binary,
        feature.batch_length,
    )?;
    let glb = decode_leaf_gltf(
        glb,
        WorldTransform(transform.to_cols_array()),
        origin,
        resources,
    )?;
    validate_b3dm_batch_ids(
        &glb,
        feature.batch_length,
        batch_table_json.is_some() || feature.batch_length > 0,
    )?;
    Ok(DecodedThreeDTilesContent::Mesh(DecodedBatchedModel {
        glb,
        batch_length: feature.batch_length,
        feature_id: None,
        batch_table_json,
        batch_table_binary: sections.batch_binary.to_vec(),
        batch_table_hierarchy,
    }))
}

fn validate_b3dm_batch_ids(
    glb: &DecodedGlb,
    batch_length: u32,
    required: bool,
) -> Result<(), ThreeDTilesContentError> {
    for primitive in &glb.primitives {
        let Some(ids) = &primitive.legacy_batch_ids else {
            if required {
                return Err(ThreeDTilesContentError::InvalidBatchData(
                    "_BATCHID is required for every primitive",
                ));
            }
            continue;
        };
        if ids
            .vertex_ids
            .iter()
            .any(|feature_id| *feature_id >= batch_length)
        {
            return Err(ThreeDTilesContentError::InvalidBatchData(
                "_BATCHID exceeds BATCH_LENGTH",
            ));
        }
    }
    Ok(())
}

fn decode_i3dm(
    bytes: &[u8],
    content_transform: WorldTransform,
    _origin: ContentOrigin,
    resources: Option<ResourceContext<'_>>,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    let sections = instance_sections(bytes)?;
    let feature: I3dmFeatureTable = parse_json(sections.feature_json)?;
    let instances_length = resolve_global_u32(&feature.instances_length, sections.feature_binary)?;
    let count = usize::try_from(instances_length)
        .map_err(|_| ThreeDTilesContentError::InvalidInstanceData("instance count is too large"))?;
    if count > crate::decode_limits::MAX_INSTANCE_COUNT {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "instance count exceeds the leaf budget",
        ));
    }
    let rtc_center = resolve_global_vec3(feature.rtc_center.as_ref(), sections.feature_binary)?;
    let quantized_volume_offset = resolve_global_vec3(
        feature.quantized_volume_offset.as_ref(),
        sections.feature_binary,
    )?;
    let quantized_volume_scale = resolve_global_vec3(
        feature.quantized_volume_scale.as_ref(),
        sections.feature_binary,
    )?;
    let (model_bytes, model_resources) = match read_u32(bytes, 28)? {
        1 => (trim_glb_padding(sections.payload)?, resources),
        0 => {
            let source_uri = parse_i3dm_uri(sections.payload)?;
            let resources = resources.ok_or(ThreeDTilesContentError::InvalidInstanceData(
                "external glTF URI requires provider resolution",
            ))?;
            let entry = resources
                .bundle
                .lookup(resources.owner_uri, source_uri)
                .ok_or_else(|| {
                    ThreeDTilesContentError::Gltf(GlbDecodeError::ExternalResource(
                        source_uri.to_owned(),
                    ))
                })?;
            if entry.kind != ResolvedAssetKind::GltfDocument {
                return Err(ThreeDTilesContentError::InvalidInstanceData(
                    "resolved i3dm model has the wrong asset kind",
                ));
            }
            let model = resources
                .bundle
                .bytes(entry)
                .map_err(|error| ThreeDTilesContentError::InvalidJson(error.to_string()))?;
            (
                model,
                Some(ResourceContext {
                    owner_uri: &entry.resolved_uri,
                    bundle: resources.bundle,
                }),
            )
        }
        _ => {
            return Err(ThreeDTilesContentError::InvalidInstanceData(
                "gltfFormat must be 0 or 1",
            ));
        }
    };
    validate_instance_feature_layout(&feature, quantized_volume_offset, quantized_volume_scale)?;
    let batch_table_json = parse_optional_json(sections.batch_json)?;
    validate_legacy_batch_table(
        batch_table_json.as_ref(),
        sections.batch_binary,
        instances_length,
    )?;
    let batch_table_hierarchy = decode_legacy_batch_table_hierarchy(
        batch_table_json.as_ref(),
        sections.batch_binary,
        instances_length,
    )?;
    let shared_glb = decode_leaf_gltf(
        model_bytes,
        WorldTransform::IDENTITY,
        ContentOrigin::Intrinsic,
        model_resources,
    )?;
    if instances_length == 0 {
        return Ok(DecodedThreeDTilesContent::InstancedMesh(
            DecodedInstancedModel {
                glb: shared_glb,
                instances: Vec::new(),
                batch_length: 0,
                batch_table_json,
                batch_table_binary: sections.batch_binary.to_vec(),
                batch_table_hierarchy,
            },
        ));
    }
    let positions = decode_instance_positions(
        &feature,
        sections.feature_binary,
        count,
        quantized_volume_offset,
        quantized_volume_scale,
    )?;
    let orientations =
        decode_instance_orientations(&feature, sections.feature_binary, &positions, rtc_center)?;
    let scales = decode_instance_scales(&feature, sections.feature_binary, count)?;
    let batch_ids = decode_batch_ids(
        feature.batch_id.as_ref(),
        sections.feature_binary,
        count,
        ThreeDTilesContentError::InvalidInstanceData,
    )?
    .unwrap_or_else(|| (0..instances_length).collect());
    if batch_ids
        .iter()
        .any(|feature_id| *feature_id >= instances_length)
    {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "BATCH_ID exceeds INSTANCES_LENGTH",
        ));
    }
    let rtc = DVec3::from_array(rtc_center.unwrap_or([0.0; 3]));
    if !rtc.is_finite() {
        return Err(ThreeDTilesContentError::CoordinateRange);
    }
    let tile_transform = DMat4::from_cols_array(&content_transform.0);
    let mut instances = Vec::with_capacity(count);
    for (source_index, (((position, orientation), scale), feature_id)) in positions
        .into_iter()
        .zip(orientations)
        .zip(scales)
        .zip(batch_ids)
        .enumerate()
    {
        let instance = DMat4::from_translation(rtc)
            * DMat4::from_translation(position)
            * orientation
            * DMat4::from_scale(scale)
            * DMat4::from_translation(DVec3::new(
                shared_glb.world_origin.x,
                shared_glb.world_origin.y,
                shared_glb.world_origin.z,
            ));
        let transform = tile_transform * instance;
        if !transform.is_finite() {
            return Err(ThreeDTilesContentError::InvalidInstanceData(
                "instance transform is non-finite",
            ));
        }
        instances.push(DecodedMeshInstance {
            world_from_model: WorldTransform(transform.to_cols_array()),
            source_index: u32::try_from(source_index).map_err(|_| {
                ThreeDTilesContentError::InvalidInstanceData("instance index exceeds u32")
            })?,
            feature_id,
        });
    }
    Ok(DecodedThreeDTilesContent::InstancedMesh(
        DecodedInstancedModel {
            glb: shared_glb,
            instances,
            batch_length: instances_length,
            batch_table_json,
            batch_table_binary: sections.batch_binary.to_vec(),
            batch_table_hierarchy,
        },
    ))
}

fn decode_pnts(
    bytes: &[u8],
    content_transform: WorldTransform,
    origin: ContentOrigin,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    let sections = feature_sections(bytes, *b"pnts")?;
    let feature: PntsFeatureTable = parse_json(sections.feature_json)?;
    if feature.points_length == 0 {
        return Err(ThreeDTilesContentError::InvalidPointData(
            "POINTS_LENGTH must be positive",
        ));
    }
    let count = usize::try_from(feature.points_length)
        .map_err(|_| ThreeDTilesContentError::InvalidPointData("point count is too large"))?;
    if count > crate::decode_limits::MAX_POINT_COUNT {
        return Err(ThreeDTilesContentError::InvalidPointData(
            "point count exceeds the leaf budget",
        ));
    }
    let mut world_positions = decode_positions(&feature, sections.feature_binary, count)?;
    let colors = decode_colors(&feature, sections.feature_binary, count)?;
    let batch_ids = decode_batch_ids(
        feature.batch_id.as_ref(),
        sections.feature_binary,
        count,
        ThreeDTilesContentError::InvalidPointData,
    )?;
    let batch_length = feature
        .batch_length
        .as_ref()
        .map(|length| resolve_global_u32(length, sections.feature_binary))
        .transpose()?;
    if feature.batch_id.is_some() && batch_length.is_none() {
        return Err(ThreeDTilesContentError::InvalidPointData(
            "BATCH_ID requires BATCH_LENGTH",
        ));
    }
    let batch_length = batch_length.unwrap_or(feature.points_length);
    if batch_ids
        .as_ref()
        .is_some_and(|ids| ids.iter().any(|feature_id| *feature_id >= batch_length))
    {
        return Err(ThreeDTilesContentError::InvalidPointData(
            "BATCH_ID exceeds BATCH_LENGTH",
        ));
    }
    let batch_table_json = parse_optional_json(sections.batch_json)?;
    validate_legacy_batch_table(
        batch_table_json.as_ref(),
        sections.batch_binary,
        batch_length,
    )?;
    let batch_table_hierarchy = decode_legacy_batch_table_hierarchy(
        batch_table_json.as_ref(),
        sections.batch_binary,
        batch_length,
    )?;
    let rtc = feature.rtc_center.unwrap_or([0.0; 3]);
    if rtc.iter().any(|value| !value.is_finite()) {
        return Err(ThreeDTilesContentError::CoordinateRange);
    }
    let transform = DMat4::from_cols_array(&content_transform.0);
    for position in &mut world_positions {
        let local = DVec3::from_array(*position) + DVec3::from_array(rtc);
        let world = transform * local.extend(1.0);
        if !world.is_finite() || world.w.abs() <= f64::EPSILON {
            return Err(ThreeDTilesContentError::CoordinateRange);
        }
        *position = (world.truncate() / world.w).to_array();
    }
    let world_origin = match origin {
        ContentOrigin::Explicit(world_origin) => world_origin,
        ContentOrigin::Intrinsic => point_cloud_anchor(&world_positions)?,
    };
    let origin = DVec3::new(world_origin.x, world_origin.y, world_origin.z);
    let positions = world_positions
        .into_iter()
        .map(|world| f32_position(DVec3::from_array(world) - origin))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DecodedThreeDTilesContent::Points(DecodedPointTile {
        points: DecodedPotreePoints {
            world_origin,
            positions,
            colors,
            civil_attributes: None,
        },
        batch_ids,
        batch_length,
        batch_table_json,
        batch_table_binary: sections.batch_binary.to_vec(),
        batch_table_hierarchy,
    }))
}

fn decode_cmpt(
    bytes: &[u8],
    content_transform: WorldTransform,
    origin: ContentOrigin,
    depth: usize,
    resources: Option<ResourceContext<'_>>,
) -> Result<DecodedThreeDTilesContent, ThreeDTilesContentError> {
    if depth >= MAX_COMPOSITE_DEPTH {
        return Err(ThreeDTilesContentError::CompositeDepth);
    }
    validate_common_header(bytes, *b"cmpt", COMPOSITE_HEADER_BYTES)?;
    let tile_count = usize::try_from(read_u32(bytes, 12)?)
        .map_err(|_| ThreeDTilesContentError::InvalidHeader("tile count is too large"))?;
    if tile_count > crate::decode_limits::MAX_COMPOSITE_CHILDREN {
        return Err(ThreeDTilesContentError::InvalidHeader(
            "composite child count exceeds the leaf budget",
        ));
    }
    let mut offset = COMPOSITE_HEADER_BYTES;
    let mut contents = Vec::with_capacity(tile_count);
    for _ in 0..tile_count {
        let length = usize::try_from(read_u32(bytes, offset + 8)?)
            .map_err(|_| ThreeDTilesContentError::InvalidHeader("inner tile is too large"))?;
        if length < 12 {
            return Err(ThreeDTilesContentError::InvalidHeader(
                "inner tile is shorter than its common header",
            ));
        }
        if !offset.is_multiple_of(8) || !length.is_multiple_of(8) {
            return Err(ThreeDTilesContentError::InvalidHeader(
                "composite child is not 8-byte aligned",
            ));
        }
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or(ThreeDTilesContentError::InvalidHeader(
                "inner tile exceeds composite",
            ))?;
        contents.push(decode_content(
            &bytes[offset..end],
            content_transform,
            origin,
            depth + 1,
            resources,
        )?);
        offset = end;
    }
    if offset != bytes.len() {
        return Err(ThreeDTilesContentError::InvalidHeader(
            "composite tile count does not consume byteLength",
        ));
    }
    Ok(DecodedThreeDTilesContent::Composite(contents))
}

fn point_cloud_anchor(points: &[[f64; 3]]) -> Result<WorldVec3, ThreeDTilesContentError> {
    let Some(first) = points.first().copied().map(DVec3::from_array) else {
        return Err(ThreeDTilesContentError::InvalidPointData(
            "point content is empty",
        ));
    };
    let (minimum, maximum) = points[1..]
        .iter()
        .copied()
        .map(DVec3::from_array)
        .fold((first, first), |(minimum, maximum), point| {
            (minimum.min(point), maximum.max(point))
        });
    let center = minimum + (maximum - minimum) * 0.5;
    if !center.is_finite() {
        return Err(ThreeDTilesContentError::CoordinateRange);
    }
    Ok(WorldVec3 {
        x: center.x,
        y: center.y,
        z: center.z,
    })
}

fn feature_sections(
    bytes: &[u8],
    expected_magic: [u8; 4],
) -> Result<LegacyTableSections<'_>, ThreeDTilesContentError> {
    table_sections(bytes, expected_magic, FEATURE_HEADER_BYTES)
}

fn instance_sections(bytes: &[u8]) -> Result<LegacyTableSections<'_>, ThreeDTilesContentError> {
    table_sections(bytes, *b"i3dm", INSTANCE_HEADER_BYTES)
}

fn table_sections(
    bytes: &[u8],
    expected_magic: [u8; 4],
    header_bytes: usize,
) -> Result<LegacyTableSections<'_>, ThreeDTilesContentError> {
    validate_table_tile(bytes, expected_magic, header_bytes).map_err(layout_error)
}

fn validate_common_header(
    bytes: &[u8],
    expected_magic: [u8; 4],
    minimum: usize,
) -> Result<(), ThreeDTilesContentError> {
    validate_common_tile(bytes, expected_magic, minimum).map_err(layout_error)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, ThreeDTilesContentError> {
    bytes
        .get(offset..offset.saturating_add(4))
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(ThreeDTilesContentError::InvalidHeader("truncated uint32"))
}

fn trim_glb_padding(bytes: &[u8]) -> Result<&[u8], ThreeDTilesContentError> {
    embedded_glb(bytes).map_err(layout_error)
}

fn parse_i3dm_uri(bytes: &[u8]) -> Result<&str, ThreeDTilesContentError> {
    parse_layout_i3dm_uri(bytes)
        .map_err(|LegacyLayoutError(message)| ThreeDTilesContentError::InvalidInstanceData(message))
}

fn parse_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, ThreeDTilesContentError> {
    serde_json::from_slice(trim_json_padding(bytes))
        .map_err(|error| ThreeDTilesContentError::InvalidJson(error.to_string()))
}

fn parse_optional_json(bytes: &[u8]) -> Result<Option<serde_json::Value>, ThreeDTilesContentError> {
    if trim_json_padding(bytes).is_empty() {
        Ok(None)
    } else {
        parse_json(bytes).map(Some)
    }
}

fn trim_json_padding(bytes: &[u8]) -> &[u8] {
    trim_json_space_padding(bytes)
}

fn layout_error(LegacyLayoutError(message): LegacyLayoutError) -> ThreeDTilesContentError {
    ThreeDTilesContentError::InvalidHeader(message)
}

#[derive(Deserialize)]
struct B3dmFeatureTable {
    #[serde(rename = "BATCH_LENGTH")]
    batch_length: u32,
    #[serde(rename = "RTC_CENTER")]
    rtc_center: Option<[f64; 3]>,
}

#[derive(Deserialize)]
struct I3dmFeatureTable {
    #[serde(rename = "INSTANCES_LENGTH")]
    instances_length: GlobalU32,
    #[serde(rename = "POSITION")]
    position: Option<BinaryReference>,
    #[serde(rename = "POSITION_QUANTIZED")]
    position_quantized: Option<BinaryReference>,
    #[serde(rename = "NORMAL_UP")]
    normal_up: Option<BinaryReference>,
    #[serde(rename = "NORMAL_RIGHT")]
    normal_right: Option<BinaryReference>,
    #[serde(rename = "NORMAL_UP_OCT32P")]
    normal_up_oct32p: Option<BinaryReference>,
    #[serde(rename = "NORMAL_RIGHT_OCT32P")]
    normal_right_oct32p: Option<BinaryReference>,
    #[serde(rename = "SCALE")]
    scale: Option<BinaryReference>,
    #[serde(rename = "SCALE_NON_UNIFORM")]
    scale_non_uniform: Option<BinaryReference>,
    #[serde(rename = "BATCH_ID")]
    batch_id: Option<BinaryReference>,
    #[serde(rename = "RTC_CENTER")]
    rtc_center: Option<GlobalVec3>,
    #[serde(rename = "QUANTIZED_VOLUME_OFFSET")]
    quantized_volume_offset: Option<GlobalVec3>,
    #[serde(rename = "QUANTIZED_VOLUME_SCALE")]
    quantized_volume_scale: Option<GlobalVec3>,
    #[serde(rename = "EAST_NORTH_UP", default)]
    east_north_up: bool,
}

#[derive(Deserialize)]
struct PntsFeatureTable {
    #[serde(rename = "POINTS_LENGTH")]
    points_length: u32,
    #[serde(rename = "POSITION")]
    position: Option<BinaryReference>,
    #[serde(rename = "POSITION_QUANTIZED")]
    position_quantized: Option<BinaryReference>,
    #[serde(rename = "QUANTIZED_VOLUME_OFFSET")]
    quantized_volume_offset: Option<[f64; 3]>,
    #[serde(rename = "QUANTIZED_VOLUME_SCALE")]
    quantized_volume_scale: Option<[f64; 3]>,
    #[serde(rename = "RTC_CENTER")]
    rtc_center: Option<[f64; 3]>,
    #[serde(rename = "RGBA")]
    rgba: Option<BinaryReference>,
    #[serde(rename = "RGB")]
    rgb: Option<BinaryReference>,
    #[serde(rename = "RGB565")]
    rgb565: Option<BinaryReference>,
    #[serde(rename = "CONSTANT_RGBA")]
    constant_rgba: Option<[u8; 4]>,
    #[serde(rename = "BATCH_ID")]
    batch_id: Option<BinaryReference>,
    #[serde(rename = "BATCH_LENGTH")]
    batch_length: Option<GlobalU32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryReference {
    byte_offset: usize,
    component_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum GlobalU32 {
    Inline(u32),
    Binary(BinaryReference),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum GlobalVec3 {
    Inline([f64; 3]),
    Binary(BinaryReference),
}

fn resolve_global_u32(value: &GlobalU32, binary: &[u8]) -> Result<u32, ThreeDTilesContentError> {
    match value {
        GlobalU32::Inline(value) => Ok(*value),
        GlobalU32::Binary(reference) => {
            validate_global_reference(reference, 4)?;
            let bytes = binary
                .get(reference.byte_offset..reference.byte_offset.saturating_add(4))
                .ok_or(ThreeDTilesContentError::InvalidInstanceData(
                    "binary global uint32 exceeds feature table",
                ))?;
            Ok(u32::from_le_bytes(
                bytes.try_into().expect("validated width"),
            ))
        }
    }
}

fn resolve_global_vec3(
    value: Option<&GlobalVec3>,
    binary: &[u8],
) -> Result<Option<[f64; 3]>, ThreeDTilesContentError> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        GlobalVec3::Inline(value) => Ok(Some(*value)),
        GlobalVec3::Binary(reference) => {
            validate_global_reference(reference, 4)?;
            let bytes = binary
                .get(reference.byte_offset..reference.byte_offset.saturating_add(12))
                .ok_or(ThreeDTilesContentError::InvalidInstanceData(
                    "binary global vec3 exceeds feature table",
                ))?;
            Ok(Some(std::array::from_fn(|axis| {
                let start = axis * 4;
                f64::from(f32::from_le_bytes(
                    bytes[start..start + 4].try_into().expect("validated width"),
                ))
            })))
        }
    }
}

fn validate_global_reference(
    reference: &BinaryReference,
    alignment: usize,
) -> Result<(), ThreeDTilesContentError> {
    if reference.component_type.is_some() {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "global semantic reference cannot override componentType",
        ));
    }
    if !reference.byte_offset.is_multiple_of(alignment) {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "global semantic byteOffset is misaligned",
        ));
    }
    Ok(())
}

fn validate_instance_feature_layout(
    feature: &I3dmFeatureTable,
    quantized_volume_offset: Option<[f64; 3]>,
    quantized_volume_scale: Option<[f64; 3]>,
) -> Result<(), ThreeDTilesContentError> {
    for (reference, alignment, semantic) in [
        (feature.position.as_ref(), 4, "POSITION"),
        (feature.position_quantized.as_ref(), 2, "POSITION_QUANTIZED"),
        (feature.normal_up.as_ref(), 4, "NORMAL_UP"),
        (feature.normal_right.as_ref(), 4, "NORMAL_RIGHT"),
        (feature.normal_up_oct32p.as_ref(), 2, "NORMAL_UP_OCT32P"),
        (
            feature.normal_right_oct32p.as_ref(),
            2,
            "NORMAL_RIGHT_OCT32P",
        ),
        (feature.scale.as_ref(), 4, "SCALE"),
        (feature.scale_non_uniform.as_ref(), 4, "SCALE_NON_UNIFORM"),
    ] {
        let Some(reference) = reference else {
            continue;
        };
        if reference.component_type.is_some() {
            return Err(ThreeDTilesContentError::InvalidInstanceData(
                "componentType is only valid for BATCH_ID",
            ));
        }
        if !reference.byte_offset.is_multiple_of(alignment) {
            return Err(ThreeDTilesContentError::InvalidInstanceData(
                match semantic {
                    "POSITION" => "POSITION byteOffset is not float-aligned",
                    "POSITION_QUANTIZED" => "POSITION_QUANTIZED byteOffset is not uint16-aligned",
                    "NORMAL_UP" | "NORMAL_RIGHT" => "float orientation byteOffset is not aligned",
                    "NORMAL_UP_OCT32P" | "NORMAL_RIGHT_OCT32P" => {
                        "oct orientation byteOffset is not uint16-aligned"
                    }
                    _ => "scale byteOffset is not float-aligned",
                },
            ));
        }
    }
    if feature.position_quantized.is_some()
        && (quantized_volume_offset.is_none() || quantized_volume_scale.is_none())
    {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "POSITION_QUANTIZED requires quantized volume offset and scale",
        ));
    }
    if feature.normal_up.is_some() != feature.normal_right.is_some() {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "NORMAL_RIGHT and NORMAL_UP must be paired",
        ));
    }
    if feature.normal_up_oct32p.is_some() != feature.normal_right_oct32p.is_some() {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "oct-encoded right and up normals must be paired",
        ));
    }
    if let Some(reference) = &feature.batch_id {
        let alignment = match reference.component_type.as_deref() {
            Some("UNSIGNED_BYTE") => 1,
            None | Some("UNSIGNED_SHORT") => 2,
            Some("UNSIGNED_INT") => 4,
            Some(_) => {
                return Err(ThreeDTilesContentError::InvalidInstanceData(
                    "unsupported BATCH_ID component type",
                ));
            }
        };
        if !reference.byte_offset.is_multiple_of(alignment) {
            return Err(ThreeDTilesContentError::InvalidInstanceData(
                "BATCH_ID byteOffset is not component-aligned",
            ));
        }
    }
    Ok(())
}

fn decode_instance_positions(
    feature: &I3dmFeatureTable,
    binary: &[u8],
    count: usize,
    quantized_volume_offset: Option<[f64; 3]>,
    quantized_volume_scale: Option<[f64; 3]>,
) -> Result<Vec<DVec3>, ThreeDTilesContentError> {
    if let Some(reference) = &feature.position {
        return read_instance_components(binary, reference.byte_offset, count, 12, |bytes| {
            let position = DVec3::new(
                f64::from(f32::from_le_bytes(bytes[0..4].try_into().expect("width"))),
                f64::from(f32::from_le_bytes(bytes[4..8].try_into().expect("width"))),
                f64::from(f32::from_le_bytes(bytes[8..12].try_into().expect("width"))),
            );
            position
                .is_finite()
                .then_some(position)
                .ok_or(ThreeDTilesContentError::CoordinateRange)
        });
    }
    let Some(reference) = &feature.position_quantized else {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "POSITION or POSITION_QUANTIZED is required",
        ));
    };
    let offset = DVec3::from_array(quantized_volume_offset.ok_or(
        ThreeDTilesContentError::InvalidInstanceData(
            "quantized position requires QUANTIZED_VOLUME_OFFSET",
        ),
    )?);
    let scale = DVec3::from_array(quantized_volume_scale.ok_or(
        ThreeDTilesContentError::InvalidInstanceData(
            "quantized position requires QUANTIZED_VOLUME_SCALE",
        ),
    )?);
    if !offset.is_finite() || !scale.is_finite() {
        return Err(ThreeDTilesContentError::CoordinateRange);
    }
    read_instance_components(binary, reference.byte_offset, count, 6, |bytes| {
        let quantized = DVec3::new(
            f64::from(u16::from_le_bytes(bytes[0..2].try_into().expect("width"))),
            f64::from(u16::from_le_bytes(bytes[2..4].try_into().expect("width"))),
            f64::from(u16::from_le_bytes(bytes[4..6].try_into().expect("width"))),
        );
        Ok(offset + quantized * scale / 65_535.0)
    })
}

fn decode_instance_orientations(
    feature: &I3dmFeatureTable,
    binary: &[u8],
    positions: &[DVec3],
    rtc_center: Option<[f64; 3]>,
) -> Result<Vec<DMat4>, ThreeDTilesContentError> {
    let count = positions.len();
    let high_precision = match (&feature.normal_right, &feature.normal_up) {
        (Some(right), Some(up)) => Some((
            decode_f32_directions(binary, right.byte_offset, count)?,
            decode_f32_directions(binary, up.byte_offset, count)?,
        )),
        (None, None) => None,
        _ => {
            return Err(ThreeDTilesContentError::InvalidInstanceData(
                "NORMAL_RIGHT and NORMAL_UP must be paired",
            ));
        }
    };
    let oct_encoded = if high_precision.is_none() {
        match (&feature.normal_right_oct32p, &feature.normal_up_oct32p) {
            (Some(right), Some(up)) => Some((
                decode_oct_directions(binary, right.byte_offset, count)?,
                decode_oct_directions(binary, up.byte_offset, count)?,
            )),
            (None, None) => None,
            _ => {
                return Err(ThreeDTilesContentError::InvalidInstanceData(
                    "oct-encoded right and up normals must be paired",
                ));
            }
        }
    } else {
        None
    };
    let rtc = DVec3::from_array(rtc_center.unwrap_or([0.0; 3]));
    (0..count)
        .map(|index| {
            let (right, up) = if let Some((right, up)) = &high_precision {
                (right[index], up[index])
            } else if let Some((right, up)) = &oct_encoded {
                (right[index], up[index])
            } else if feature.east_north_up {
                east_north_up(positions[index] + rtc)?
            } else {
                return Ok(DMat4::IDENTITY);
            };
            if right.dot(up).abs() > 1.0e-4 {
                return Err(ThreeDTilesContentError::InvalidInstanceData(
                    "instance right and up directions are not orthogonal",
                ));
            }
            let forward = right.cross(up).normalize_or_zero();
            if forward == DVec3::ZERO {
                return Err(ThreeDTilesContentError::InvalidInstanceData(
                    "instance orientation is degenerate",
                ));
            }
            Ok(DMat4::from_cols(
                right.extend(0.0),
                up.extend(0.0),
                forward.extend(0.0),
                glam::DVec4::W,
            ))
        })
        .collect()
}

fn decode_f32_directions(
    binary: &[u8],
    offset: usize,
    count: usize,
) -> Result<Vec<DVec3>, ThreeDTilesContentError> {
    read_instance_components(binary, offset, count, 12, |bytes| {
        let direction = DVec3::new(
            f64::from(f32::from_le_bytes(bytes[0..4].try_into().expect("width"))),
            f64::from(f32::from_le_bytes(bytes[4..8].try_into().expect("width"))),
            f64::from(f32::from_le_bytes(bytes[8..12].try_into().expect("width"))),
        );
        let length = direction.length();
        if !length.is_finite() || length <= f64::EPSILON {
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "instance direction is invalid",
            ))
        } else {
            Ok(direction / length)
        }
    })
}

fn decode_oct_directions(
    binary: &[u8],
    offset: usize,
    count: usize,
) -> Result<Vec<DVec3>, ThreeDTilesContentError> {
    read_instance_components(binary, offset, count, 4, |bytes| {
        let x = f64::from(u16::from_le_bytes(bytes[0..2].try_into().expect("width"))) / 65_535.0
            * 2.0
            - 1.0;
        let y = f64::from(u16::from_le_bytes(bytes[2..4].try_into().expect("width"))) / 65_535.0
            * 2.0
            - 1.0;
        let mut value = DVec3::new(x, y, 1.0 - x.abs() - y.abs());
        if value.z < 0.0 {
            let old_x = value.x;
            value.x = (1.0 - value.y.abs()).copysign(old_x);
            value.y = (1.0 - old_x.abs()).copysign(value.y);
        }
        Ok(value.normalize())
    })
}

fn east_north_up(position: DVec3) -> Result<(DVec3, DVec3), ThreeDTilesContentError> {
    const WGS84_A: f64 = 6_378_137.0;
    const WGS84_B: f64 = 6_356_752.314_245_179;
    let geodetic = DVec3::new(
        position.x / (WGS84_A * WGS84_A),
        position.y / (WGS84_A * WGS84_A),
        position.z / (WGS84_B * WGS84_B),
    );
    let up = geodetic.normalize_or_zero();
    if up == DVec3::ZERO {
        return Err(ThreeDTilesContentError::InvalidInstanceData(
            "east-north-up position is invalid",
        ));
    }
    let east = if up.x.abs() < 1.0e-12 && up.y.abs() < 1.0e-12 {
        DVec3::Y
    } else {
        DVec3::Z.cross(up).normalize()
    };
    let north = up.cross(east).normalize();
    Ok((east, north))
}

fn decode_instance_scales(
    feature: &I3dmFeatureTable,
    binary: &[u8],
    count: usize,
) -> Result<Vec<DVec3>, ThreeDTilesContentError> {
    let uniform = if let Some(reference) = &feature.scale {
        read_instance_components(binary, reference.byte_offset, count, 4, |bytes| {
            Ok(f64::from(f32::from_le_bytes(
                bytes.try_into().expect("width"),
            )))
        })?
    } else {
        vec![1.0; count]
    };
    let non_uniform = if let Some(reference) = &feature.scale_non_uniform {
        read_instance_components(binary, reference.byte_offset, count, 12, |bytes| {
            Ok(DVec3::new(
                f64::from(f32::from_le_bytes(bytes[0..4].try_into().expect("width"))),
                f64::from(f32::from_le_bytes(bytes[4..8].try_into().expect("width"))),
                f64::from(f32::from_le_bytes(bytes[8..12].try_into().expect("width"))),
            ))
        })?
    } else {
        vec![DVec3::ONE; count]
    };
    uniform
        .into_iter()
        .zip(non_uniform)
        .map(|(uniform, axes)| {
            let scale = axes * uniform;
            if !scale.is_finite() {
                Err(ThreeDTilesContentError::InvalidInstanceData(
                    "instance scale must be finite",
                ))
            } else {
                Ok(scale)
            }
        })
        .collect()
}

fn decode_positions(
    feature: &PntsFeatureTable,
    binary: &[u8],
    count: usize,
) -> Result<Vec<[f64; 3]>, ThreeDTilesContentError> {
    if let Some(reference) = &feature.position {
        return read_components(binary, reference.byte_offset, count, 12, |bytes| {
            Ok([
                f64::from(f32::from_le_bytes(bytes[0..4].try_into().expect("slice"))),
                f64::from(f32::from_le_bytes(bytes[4..8].try_into().expect("slice"))),
                f64::from(f32::from_le_bytes(bytes[8..12].try_into().expect("slice"))),
            ])
        });
    }
    let Some(reference) = &feature.position_quantized else {
        return Err(ThreeDTilesContentError::InvalidPointData(
            "POSITION or POSITION_QUANTIZED is required",
        ));
    };
    let offset =
        feature
            .quantized_volume_offset
            .ok_or(ThreeDTilesContentError::InvalidPointData(
                "quantized position has no offset",
            ))?;
    let scale = feature
        .quantized_volume_scale
        .ok_or(ThreeDTilesContentError::InvalidPointData(
            "quantized position has no scale",
        ))?;
    if offset.iter().chain(&scale).any(|value| !value.is_finite()) {
        return Err(ThreeDTilesContentError::CoordinateRange);
    }
    read_components(binary, reference.byte_offset, count, 6, |bytes| {
        Ok(std::array::from_fn(|axis| {
            let start = axis * 2;
            let quantized = u16::from_le_bytes(bytes[start..start + 2].try_into().expect("slice"));
            f64::from(quantized).mul_add(scale[axis] / 65_535.0, offset[axis])
        }))
    })
}

fn decode_colors(
    feature: &PntsFeatureTable,
    binary: &[u8],
    count: usize,
) -> Result<Vec<[u8; 4]>, ThreeDTilesContentError> {
    if let Some(reference) = &feature.rgba {
        return read_components(binary, reference.byte_offset, count, 4, |bytes| {
            Ok(bytes.try_into().expect("four-byte chunk"))
        });
    }
    if let Some(reference) = &feature.rgb {
        return read_components(binary, reference.byte_offset, count, 3, |bytes| {
            Ok([bytes[0], bytes[1], bytes[2], 255])
        });
    }
    if let Some(reference) = &feature.rgb565 {
        return read_components(binary, reference.byte_offset, count, 2, |bytes| {
            let packed = u16::from_le_bytes(bytes.try_into().expect("two-byte chunk"));
            Ok([
                expand_bits(u8::try_from(packed >> 11).expect("five bits"), 5),
                expand_bits(u8::try_from((packed >> 5) & 0x3f).expect("six bits"), 6),
                expand_bits(u8::try_from(packed & 0x1f).expect("five bits"), 5),
                255,
            ])
        });
    }
    Ok(vec![feature.constant_rgba.unwrap_or([255; 4]); count])
}

fn decode_batch_ids(
    reference: Option<&BinaryReference>,
    binary: &[u8],
    count: usize,
    invalid: fn(&'static str) -> ThreeDTilesContentError,
) -> Result<Option<Vec<u32>>, ThreeDTilesContentError> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    let (stride, decoder): (usize, fn(&[u8]) -> u32) = match reference.component_type.as_deref() {
        Some("UNSIGNED_BYTE") => (1, |bytes| u32::from(bytes[0])),
        None | Some("UNSIGNED_SHORT") => (2, |bytes| {
            u32::from(u16::from_le_bytes(
                bytes.try_into().expect("two-byte chunk"),
            ))
        }),
        Some("UNSIGNED_INT") => (4, |bytes| {
            u32::from_le_bytes(bytes.try_into().expect("four-byte chunk"))
        }),
        Some(_) => {
            return Err(invalid("unsupported BATCH_ID component type"));
        }
    };
    read_typed_components(
        binary,
        reference.byte_offset,
        count,
        stride,
        invalid,
        |bytes| Ok(decoder(bytes)),
    )
    .map(Some)
}

fn read_components<T>(
    binary: &[u8],
    offset: usize,
    count: usize,
    stride: usize,
    mut decode: impl FnMut(&[u8]) -> Result<T, ThreeDTilesContentError>,
) -> Result<Vec<T>, ThreeDTilesContentError> {
    read_typed_components(
        binary,
        offset,
        count,
        stride,
        ThreeDTilesContentError::InvalidPointData,
        &mut decode,
    )
}

fn read_instance_components<T>(
    binary: &[u8],
    offset: usize,
    count: usize,
    stride: usize,
    mut decode: impl FnMut(&[u8]) -> Result<T, ThreeDTilesContentError>,
) -> Result<Vec<T>, ThreeDTilesContentError> {
    read_typed_components(
        binary,
        offset,
        count,
        stride,
        ThreeDTilesContentError::InvalidInstanceData,
        &mut decode,
    )
}

fn read_typed_components<T>(
    binary: &[u8],
    offset: usize,
    count: usize,
    stride: usize,
    invalid: fn(&'static str) -> ThreeDTilesContentError,
    mut decode: impl FnMut(&[u8]) -> Result<T, ThreeDTilesContentError>,
) -> Result<Vec<T>, ThreeDTilesContentError> {
    let byte_length = count
        .checked_mul(stride)
        .ok_or_else(|| invalid("binary range overflow"))?;
    let bytes = binary
        .get(offset..offset.saturating_add(byte_length))
        .ok_or_else(|| invalid("binary semantic exceeds feature table"))?;
    bytes.chunks_exact(stride).map(&mut decode).collect()
}

fn expand_bits(value: u8, bits: u32) -> u8 {
    let maximum = (1_u16 << bits) - 1;
    u8::try_from((u16::from(value) * 255 + maximum / 2) / maximum).expect("normalized color")
}

fn f32_position(value: DVec3) -> Result<[f32; 3], ThreeDTilesContentError> {
    #[allow(clippy::cast_possible_truncation)]
    let position = [value.x as f32, value.y as f32, value.z as f32];
    position
        .iter()
        .all(|component| component.is_finite())
        .then_some(position)
        .ok_or(ThreeDTilesContentError::CoordinateRange)
}

#[cfg(test)]
mod tests {
    use super::{
        decode_three_d_tiles_content, decode_three_d_tiles_content_intrinsic,
        decode_three_d_tiles_content_intrinsic_with_resources, DecodedInstancedModel,
        DecodedThreeDTilesContent, ThreeDTilesContentError, ThreeDTilesContentKind,
    };
    use crate::{
        AssetBundleLimits, ResolvedAssetBundle, ResolvedAssetInput, ResolvedAssetKind,
        WorldTransform, WorldVec3,
    };
    use glam::{DMat4, DVec3};

    #[test]
    fn pnts_decodes_quantized_position_color_and_batch_identity() {
        let feature_json = br#"{"POINTS_LENGTH":2,"POSITION_QUANTIZED":{"byteOffset":0},"QUANTIZED_VOLUME_OFFSET":[10,20,30],"QUANTIZED_VOLUME_SCALE":[2,4,6],"RGB":{"byteOffset":12},"BATCH_ID":{"byteOffset":18,"componentType":"UNSIGNED_BYTE"},"BATCH_LENGTH":10}"#;
        let mut binary = Vec::new();
        for value in [0_u16, 0, 0, 65_535, 65_535, 65_535] {
            binary.extend(value.to_le_bytes());
        }
        binary.extend([255, 0, 0, 0, 255, 0, 4, 9]);
        let pnts = feature_tile(*b"pnts", feature_json, &binary, &[], &[]);
        let decoded = decode_three_d_tiles_content(
            &pnts,
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 10.0,
                y: 20.0,
                z: 30.0,
            },
        )
        .expect("pnts");
        let DecodedThreeDTilesContent::Points(points) = decoded else {
            panic!("expected points");
        };
        assert_eq!(points.points.positions, [[0.0, 0.0, 0.0], [2.0, 4.0, 6.0]]);
        assert_eq!(points.points.colors, [[255, 0, 0, 255], [0, 255, 0, 255]]);
        assert_eq!(points.batch_ids, Some(vec![4, 9]));
        assert_eq!(points.batch_length, 10);
    }

    #[test]
    fn pnts_maps_repeated_batch_ids_to_exact_json_and_binary_feature_rows() {
        let feature_json = br#"{"POINTS_LENGTH":3,"POSITION":{"byteOffset":0},"BATCH_ID":{"byteOffset":36,"componentType":"UNSIGNED_BYTE"},"BATCH_LENGTH":2}"#;
        let mut feature_binary = vec![0; 36];
        feature_binary.extend([0, 0, 1]);
        let batch_json = br#"{"name":["wall","door"],"height":{"byteOffset":0,"componentType":"FLOAT","type":"SCALAR"}}"#;
        let mut batch_binary = Vec::new();
        batch_binary.extend(2.5_f32.to_le_bytes());
        batch_binary.extend(3.75_f32.to_le_bytes());
        let tile = feature_tile(
            *b"pnts",
            feature_json,
            &feature_binary,
            batch_json,
            &batch_binary,
        );

        let decoded = decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY)
            .expect("batched point metadata");
        let DecodedThreeDTilesContent::Points(points) = decoded else {
            panic!("expected points");
        };
        assert_eq!(points.batch_ids.as_deref(), Some(&[0, 0, 1][..]));
        assert_eq!(points.batch_length, 2);
        assert_eq!(
            points.batch_table_row(0).expect("wall metadata"),
            serde_json::json!({"height": 2.5, "name": "wall"})
        );
        assert_eq!(
            points.batch_table_row(1).expect("door metadata"),
            serde_json::json!({"height": 3.75, "name": "door"})
        );
    }

    #[test]
    fn pnts_resolves_binary_global_batch_length_before_validating_metadata() {
        let feature_json = br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0},"BATCH_ID":{"byteOffset":12,"componentType":"UNSIGNED_BYTE"},"BATCH_LENGTH":{"byteOffset":16}}"#;
        let mut feature_binary = vec![0; 16];
        feature_binary.extend(1_u32.to_le_bytes());
        let tile = feature_tile(
            *b"pnts",
            feature_json,
            &feature_binary,
            br#"{"name":["survey point"]}"#,
            &[],
        );

        let decoded = decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY)
            .expect("binary BATCH_LENGTH");
        let DecodedThreeDTilesContent::Points(points) = decoded else {
            panic!("expected points");
        };
        assert_eq!(points.batch_length, 1);
        assert_eq!(
            points.batch_table_row(0).expect("point metadata"),
            serde_json::json!({"name": "survey point"})
        );
    }

    #[test]
    fn pnts_rejects_missing_and_out_of_range_batch_feature_contracts() {
        let mut feature_binary = vec![0; 12];
        feature_binary.push(0);
        let missing_length = feature_tile(
            *b"pnts",
            br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0},"BATCH_ID":{"byteOffset":12,"componentType":"UNSIGNED_BYTE"}}"#,
            &feature_binary,
            &[],
            &[],
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&missing_length, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidPointData(
                "BATCH_ID requires BATCH_LENGTH"
            ))
        );

        *feature_binary.last_mut().expect("batch ID") = 2;
        let out_of_range = feature_tile(
            *b"pnts",
            br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0},"BATCH_ID":{"byteOffset":12,"componentType":"UNSIGNED_BYTE"},"BATCH_LENGTH":2}"#,
            &feature_binary,
            &[],
            &[],
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&out_of_range, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidPointData(
                "BATCH_ID exceeds BATCH_LENGTH"
            ))
        );

        let wrong_rows = feature_tile(
            *b"pnts",
            br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0}}"#,
            &[0; 12],
            br#"{"name":[]}"#,
            &[],
        );
        assert!(matches!(
            decode_three_d_tiles_content_intrinsic(&wrong_rows, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidJson(_))
        ));
    }

    #[test]
    fn b3dm_applies_rtc_after_gltf_y_up_to_tiles_z_up_conversion() {
        let glb = batched_triangles_glb(
            &[0.0_f32; 6]
                .into_iter()
                .flat_map(f32::to_le_bytes)
                .collect::<Vec<_>>(),
            5126,
            6,
            "SCALAR",
            false,
        );
        let b3dm = b3dm_tile(
            br#"{"BATCH_LENGTH":1,"RTC_CENTER":[10,20,30]}"#,
            br#"{"name":["triangle"]}"#,
            &glb,
        );
        let decoded = decode_three_d_tiles_content(
            &b3dm,
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 10.0,
                y: 20.0,
                z: 30.0,
            },
        )
        .expect("b3dm");
        let DecodedThreeDTilesContent::Mesh(mesh) = decoded else {
            panic!("expected mesh");
        };
        assert_eq!(mesh.batch_length, 1);
        assert_eq!(mesh.glb.primitives[0].vertices[2].position, [0.0, 0.0, 1.0]);
        assert_eq!(
            mesh.batch_table_json.expect("metadata")["name"][0],
            "triangle"
        );
    }

    #[test]
    fn b3dm_binds_source_triangles_to_exact_batch_features_and_rows() {
        let batch_bytes = [0.0_f32, 1.0, 1.0, 1.0, 1.0, 1.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let tile = b3dm_tile(
            br#"{"BATCH_LENGTH":2}"#,
            br#"{"name":["wall","door"]}"#,
            &batched_triangles_glb(&batch_bytes, 5126, 6, "SCALAR", false),
        );
        let decoded = decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY)
            .expect("batched triangle features");
        let DecodedThreeDTilesContent::Mesh(mesh) = decoded else {
            panic!("expected mesh");
        };
        let ids = mesh.glb.primitives[0]
            .legacy_batch_ids
            .as_ref()
            .expect("legacy feature IDs");
        assert_eq!(ids.vertex_ids, [0, 1, 1, 1, 1, 1]);
        assert_eq!(ids.triangle_vertex_ids, [[0, 1, 1], [1, 1, 1]]);
        assert_eq!(
            ids.triangle_ids,
            [
                crate::DecodedTriangleFeatureId::Ambiguous,
                crate::DecodedTriangleFeatureId::Feature(1)
            ]
        );
        assert_eq!(
            ids.feature_id_at_triangle(0, [0.8, 0.1, 0.1]),
            Some(crate::DecodedTriangleFeatureId::Feature(0))
        );
        assert_eq!(
            ids.feature_id_at_triangle(0, [0.1, 0.8, 0.1]),
            Some(crate::DecodedTriangleFeatureId::Feature(1))
        );
        assert_eq!(
            mesh.batch_table_row(1).expect("feature row"),
            serde_json::json!({"name": "door"})
        );
        assert_eq!(
            mesh.batch_feature_id_at_source_triangle(0, [0.8, 0.1, 0.1]),
            Some(0)
        );
        assert_eq!(
            mesh.batch_feature_id_at_source_triangle(1, [0.2, 0.3, 0.5]),
            Some(1)
        );
        let catalog = mesh.legacy_metadata_catalog();
        assert_eq!(catalog.batch_length(), 2);
        assert!(catalog.has_batch_table());
        assert_eq!(
            catalog.direct_row(1).expect("catalog row"),
            Some(serde_json::json!({"name": "door"}))
        );
        assert_eq!(
            catalog.resolved_row(1).expect("catalog resolved row"),
            Some(serde_json::json!({"name": "door"}))
        );
        assert!(catalog.resident_bytes() > 0);
    }

    #[test]
    fn b3dm_rejects_missing_out_of_range_and_invalid_batch_id_accessors() {
        let missing = b3dm_tile(br#"{"BATCH_LENGTH":1}"#, &[], &triangle_glb());
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&missing, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidBatchData(
                "_BATCHID is required for every primitive"
            ))
        );

        let out_of_range = b3dm_tile(
            br#"{"BATCH_LENGTH":2}"#,
            &[],
            &batched_triangles_glb(&[2; 6], 5121, 6, "SCALAR", false),
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&out_of_range, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidBatchData(
                "_BATCHID exceeds BATCH_LENGTH"
            ))
        );

        let invalid_accessors = [
            batched_triangles_glb(&[0; 6], 5121, 6, "SCALAR", true),
            batched_triangles_glb(&[0; 12], 5121, 6, "VEC2", false),
            batched_triangles_glb(&[0; 5], 5121, 5, "SCALAR", false),
            batched_triangles_glb(
                &[0.5_f32; 6]
                    .into_iter()
                    .flat_map(f32::to_le_bytes)
                    .collect::<Vec<_>>(),
                5126,
                6,
                "SCALAR",
                false,
            ),
            batched_triangles_glb(
                &[f32::NAN; 6]
                    .into_iter()
                    .flat_map(f32::to_le_bytes)
                    .collect::<Vec<_>>(),
                5126,
                6,
                "SCALAR",
                false,
            ),
            batched_triangles_glb(&[u8::MAX; 6], 5120, 6, "SCALAR", false),
        ];
        for glb in invalid_accessors {
            let tile = b3dm_tile(br#"{"BATCH_LENGTH":2}"#, &[], &glb);
            assert!(matches!(
                decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY),
                Err(ThreeDTilesContentError::Gltf(_))
            ));
        }

        let no_features = b3dm_tile(br#"{"BATCH_LENGTH":0}"#, &[], &triangle_glb());
        assert!(
            decode_three_d_tiles_content_intrinsic(&no_features, WorldTransform::IDENTITY).is_ok()
        );

        let empty_batch_table = b3dm_tile(br#"{"BATCH_LENGTH":0}"#, b"{}", &triangle_glb());
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&empty_batch_table, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidBatchData(
                "_BATCHID is required for every primitive"
            ))
        );
    }

    #[test]
    fn b3dm_public_query_composes_direct_and_hierarchical_metadata() {
        let batch_bytes = [0.0_f32; 6]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let batch_json = br#"{
            "surveyId":[42],
            "extensions":{"3DTILES_batch_table_hierarchy":{
                "classes":[
                    {"name":"Wall","length":1,"instances":{"color":["lime"]}},
                    {"name":"Building","length":1,"instances":{"name":["station"]}}
                ],
                "instancesLength":2,
                "classIds":[0,1],
                "parentIds":[1,1]
            }}
        }"#;
        let tile = b3dm_tile(
            br#"{"BATCH_LENGTH":1}"#,
            batch_json,
            &batched_triangles_glb(&batch_bytes, 5126, 6, "SCALAR", false),
        );
        let decoded = decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY)
            .expect("hierarchical b3dm");
        let DecodedThreeDTilesContent::Mesh(mesh) = decoded else {
            panic!("expected mesh");
        };
        let hierarchy = mesh
            .batch_table_hierarchy_row(0)
            .expect("hierarchy query")
            .expect("hierarchy");
        assert_eq!(hierarchy.exact_instance.class_name, "Wall");
        assert_eq!(hierarchy.ancestors[0].class_name, "Building");
        assert_eq!(
            mesh.resolved_batch_table_row(0).expect("resolved row"),
            serde_json::json!({"color":"lime","name":"station","surveyId":42})
        );
    }

    #[test]
    fn i3dm_expands_rtc_positions_scales_and_feature_ids_in_transform_order() {
        let feature_json = br#"{"INSTANCES_LENGTH":2,"POSITION":{"byteOffset":0},"SCALE":{"byteOffset":24},"SCALE_NON_UNIFORM":{"byteOffset":32},"BATCH_ID":{"byteOffset":56,"componentType":"UNSIGNED_BYTE"},"RTC_CENTER":[10,20,30]}"#;
        let mut binary = Vec::new();
        for position in [[1.0_f32, 2.0, 3.0], [4.0, 5.0, 6.0]] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for scale in [2.0_f32, 0.5] {
            binary.extend(scale.to_le_bytes());
        }
        for scale in [[3.0_f32, 4.0, 5.0], [2.0, 4.0, 6.0]] {
            for component in scale {
                binary.extend(component.to_le_bytes());
            }
        }
        binary.extend([0, 1]);
        let i3dm = i3dm_tile(
            feature_json,
            &binary,
            br#"{"name":["first","second"]}"#,
            &triangle_glb(),
            1,
        );
        let mut tile_transform = WorldTransform::IDENTITY;
        tile_transform.0[12] = 100.0;
        tile_transform.0[13] = 200.0;
        tile_transform.0[14] = 300.0;
        let decoded = decode_three_d_tiles_content(
            &i3dm,
            tile_transform,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("i3dm");
        let DecodedThreeDTilesContent::InstancedMesh(model) = decoded else {
            panic!("expected shared instanced model");
        };
        assert_eq!(model.instances.len(), 2);
        assert_eq!(model.batch_length, 2);
        assert_eq!(model.instances[0].feature_id, 0);
        assert_eq!(model.instances[1].feature_id, 1);
        assert_eq!(instance_vertex_world(&model, 0, 0), [111.0, 222.0, 333.0]);
        assert_eq!(instance_vertex_world(&model, 0, 1), [117.0, 222.0, 333.0]);
        assert_eq!(instance_vertex_world(&model, 1, 0), [114.0, 225.0, 336.0]);
        assert_eq!(instance_vertex_world(&model, 1, 1), [115.0, 225.0, 336.0]);
        assert_eq!(
            model.batch_table_json.as_ref().expect("metadata")["name"][0],
            "first"
        );
    }

    #[test]
    fn i3dm_dequantizes_positions_and_assigns_sequential_feature_ids() {
        let feature_json = br#"{"INSTANCES_LENGTH":2,"POSITION_QUANTIZED":{"byteOffset":0},"QUANTIZED_VOLUME_OFFSET":[-1,-2,-3],"QUANTIZED_VOLUME_SCALE":[2,4,6]}"#;
        let mut binary = Vec::new();
        for value in [0_u16, 0, 0, 65_535, 65_535, 65_535] {
            binary.extend(value.to_le_bytes());
        }
        let i3dm = i3dm_tile(feature_json, &binary, &[], &triangle_glb(), 1);
        let decoded = decode_three_d_tiles_content(
            &i3dm,
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("quantized i3dm");
        let DecodedThreeDTilesContent::InstancedMesh(model) = decoded else {
            panic!("expected shared instanced model");
        };
        assert_eq!(model.instances[0].feature_id, 0);
        assert_eq!(model.instances[1].feature_id, 1);
        assert_eq!(instance_vertex_world(&model, 0, 0), [-1.0, -2.0, -3.0]);
        assert_eq!(instance_vertex_world(&model, 1, 0), [1.0, 2.0, 3.0]);
    }

    #[test]
    fn i3dm_external_glb_uses_exact_owner_source_bundle_lookup() {
        let feature_json = br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0}}"#;
        let mut feature_binary = Vec::new();
        for component in [10.0_f32, 20.0, 30.0] {
            feature_binary.extend(component.to_le_bytes());
        }
        let tile = i3dm_uri_tile(feature_json, &feature_binary, b"../models/triangle.glb");
        let glb = triangle_glb();
        let bundle = ResolvedAssetBundle::build(
            &[ResolvedAssetInput {
                owner_uri: "https://example.test/tiles/tree.i3dm",
                source_uri: "../models/triangle.glb",
                resolved_uri: "https://example.test/models/triangle.glb",
                kind: ResolvedAssetKind::GltfDocument,
                bytes: &glb,
            }],
            AssetBundleLimits::default(),
        )
        .expect("bundle");
        let decoded = decode_three_d_tiles_content_intrinsic_with_resources(
            "https://example.test/tiles/tree.i3dm",
            ThreeDTilesContentKind::ThreeDTilesContainer,
            &tile,
            &bundle,
            WorldTransform::IDENTITY,
        )
        .expect("external i3dm");
        let DecodedThreeDTilesContent::InstancedMesh(model) = decoded else {
            panic!("expected shared instanced model");
        };
        assert_eq!(model.instances.len(), 1);
        assert_eq!(instance_vertex_world(&model, 0, 0), [10.0, 20.0, 30.0]);
        assert_eq!(instance_vertex_world(&model, 0, 1), [11.0, 20.0, 30.0]);
    }

    #[test]
    fn i3dm_accepts_empty_reflected_and_invisible_instances() {
        let empty = i3dm_tile(br#"{"INSTANCES_LENGTH":0}"#, &[], &[], &triangle_glb(), 1);
        let decoded = decode_three_d_tiles_content_intrinsic(&empty, WorldTransform::IDENTITY)
            .expect("empty i3dm");
        let DecodedThreeDTilesContent::InstancedMesh(empty_model) = decoded else {
            panic!("expected empty instanced model");
        };
        assert!(empty_model.instances.is_empty());

        let feature_json =
            br#"{"INSTANCES_LENGTH":2,"POSITION":{"byteOffset":0},"SCALE":{"byteOffset":24}}"#;
        let mut binary = Vec::new();
        for position in [[10.0_f32, 20.0, 30.0], [40.0, 50.0, 60.0]] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for scale in [-2.0_f32, 0.0] {
            binary.extend(scale.to_le_bytes());
        }
        let tile = i3dm_tile(feature_json, &binary, &[], &triangle_glb(), 1);
        let decoded = decode_three_d_tiles_content(
            &tile,
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("reflected and invisible i3dm");
        let DecodedThreeDTilesContent::InstancedMesh(model) = decoded else {
            panic!("expected shared instanced model");
        };
        assert_eq!(
            model.instances.len(),
            2,
            "zero-scale identity stays addressable"
        );
        assert_eq!(model.instances[0].feature_id, 0);
        assert_eq!(instance_vertex_world(&model, 0, 0), [10.0, 20.0, 30.0]);
        assert_eq!(instance_vertex_world(&model, 0, 1), [8.0, 20.0, 30.0]);
        assert_eq!(instance_vertex_world(&model, 1, 0), [40.0, 50.0, 60.0]);
        assert_eq!(instance_vertex_world(&model, 1, 1), [40.0, 50.0, 60.0]);
    }

    #[test]
    fn i3dm_rejects_unpaired_orientation_and_invalid_gltf_format() {
        let feature_json =
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0},"NORMAL_UP":{"byteOffset":12}}"#;
        let mut binary = Vec::new();
        for component in [0.0_f32, 0.0, 0.0, 0.0, 1.0, 0.0] {
            binary.extend(component.to_le_bytes());
        }
        let unpaired = i3dm_tile(feature_json, &binary, &[], &triangle_glb(), 1);
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&unpaired, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "NORMAL_RIGHT and NORMAL_UP must be paired"
            ))
        );

        let invalid_format = i3dm_tile(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0}}"#,
            &[0; 12],
            &[],
            &triangle_glb(),
            2,
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&invalid_format, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "gltfFormat must be 0 or 1"
            ))
        );

        let truncated_batch_id = i3dm_tile(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0},"BATCH_ID":{"byteOffset":1024}}"#,
            &[0; 12],
            &[],
            &triangle_glb(),
            1,
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&truncated_batch_id, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "binary semantic exceeds feature table"
            ))
        );
    }

    #[test]
    fn legacy_tiles_reject_misaligned_tables_dirty_glb_padding_and_nul_uris() {
        let mut misaligned = b3dm_tile(br#"{"BATCH_LENGTH":0}"#, &[], &triangle_glb());
        let feature_length = u32::from_le_bytes(misaligned[12..16].try_into().expect("field"));
        misaligned[12..16].copy_from_slice(&(feature_length - 1).to_le_bytes());
        misaligned[16..20].copy_from_slice(&1_u32.to_le_bytes());
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&misaligned, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidHeader(
                "feature or batch table boundary is not 8-byte aligned"
            ))
        );

        let mut dirty_padding = b3dm_tile(br#"{"BATCH_LENGTH":0}"#, &[], &triangle_glb());
        dirty_padding.extend([0_u8; 8]);
        let dirty_length = u32::try_from(dirty_padding.len()).expect("tile length");
        dirty_padding[8..12].copy_from_slice(&dirty_length.to_le_bytes());
        let payload_offset = 28
            + [12_usize, 16, 20, 24]
                .into_iter()
                .map(|offset| {
                    usize::try_from(u32::from_le_bytes(
                        dirty_padding[offset..offset + 4].try_into().expect("field"),
                    ))
                    .expect("length")
                })
                .sum::<usize>();
        let glb_length = usize::try_from(u32::from_le_bytes(
            dirty_padding[payload_offset + 8..payload_offset + 12]
                .try_into()
                .expect("GLB length"),
        ))
        .expect("length");
        assert!(payload_offset + glb_length < dirty_padding.len());
        dirty_padding[payload_offset + glb_length] = b'x';
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&dirty_padding, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidHeader(
                "invalid embedded GLB padding"
            ))
        );

        let mut nul_uri = i3dm_uri_tile(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0}}"#,
            &[0; 12],
            b"model.glb",
        );
        *nul_uri.last_mut().expect("URI padding") = 0;
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&nul_uri, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "NUL-padded i3dm glTF URI"
            ))
        );
    }

    #[test]
    fn i3dm_validates_binary_layout_dependencies_and_metadata_lengths() {
        let glb = triangle_glb();
        let invalid_component = i3dm_tile(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0,"componentType":"DOUBLE"}}"#,
            &[0; 12],
            &[],
            &glb,
            1,
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&invalid_component, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "componentType is only valid for BATCH_ID"
            ))
        );

        let unaligned = i3dm_tile(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":2}}"#,
            &[0; 16],
            &[],
            &glb,
            1,
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(&unaligned, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "POSITION byteOffset is not float-aligned"
            ))
        );

        let invalid_lower_priority = i3dm_tile(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0},"POSITION_QUANTIZED":{"byteOffset":12}}"#,
            &[0; 24],
            &[],
            &glb,
            1,
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(
                &invalid_lower_priority,
                WorldTransform::IDENTITY
            ),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "POSITION_QUANTIZED requires quantized volume offset and scale"
            ))
        );

        let wrong_metadata_length = i3dm_tile(
            br#"{"INSTANCES_LENGTH":2,"POSITION":{"byteOffset":0}}"#,
            &[0; 24],
            br#"{"name":["only-one"]}"#,
            &glb,
            1,
        );
        assert_eq!(
            decode_three_d_tiles_content_intrinsic(
                &wrong_metadata_length,
                WorldTransform::IDENTITY
            ),
            Err(ThreeDTilesContentError::InvalidJson(
                "batch-table JSON property length does not match the feature count".to_owned()
            ))
        );
    }

    #[test]
    fn i3dm_retains_binary_batch_table_once_for_shared_instances() {
        let tile = i3dm_tile_with_batch_binary(
            br#"{"INSTANCES_LENGTH":1,"POSITION":{"byteOffset":0}}"#,
            &[0; 12],
            br#"{"height":{"byteOffset":0,"componentType":"FLOAT","type":"SCALAR"}}"#,
            &27.5_f32.to_le_bytes(),
            &triangle_glb(),
            1,
        );
        let decoded = decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY)
            .expect("binary batch table");
        let DecodedThreeDTilesContent::InstancedMesh(model) = decoded else {
            panic!("expected instanced model");
        };
        assert_eq!(
            &model.batch_table_binary[..4],
            27.5_f32.to_le_bytes().as_slice()
        );
        assert_eq!(
            model.batch_table_binary.len(),
            8,
            "alignment padding is retained"
        );
        assert_eq!(
            model.batch_table_row(0).expect("instance metadata"),
            serde_json::json!({"height": 27.5})
        );
    }

    #[test]
    fn i3dm_resolves_binary_global_feature_semantics() {
        let feature_json = br#"{"INSTANCES_LENGTH":{"byteOffset":0},"RTC_CENTER":{"byteOffset":4},"QUANTIZED_VOLUME_OFFSET":{"byteOffset":16},"QUANTIZED_VOLUME_SCALE":{"byteOffset":28},"POSITION_QUANTIZED":{"byteOffset":40}}"#;
        let mut binary = Vec::new();
        binary.extend(1_u32.to_le_bytes());
        for value in [10.0_f32, 20.0, 30.0, 1.0, 2.0, 3.0, 2.0, 4.0, 6.0] {
            binary.extend(value.to_le_bytes());
        }
        for value in [0_u16, 0, 0] {
            binary.extend(value.to_le_bytes());
        }
        let tile = i3dm_tile(feature_json, &binary, &[], &triangle_glb(), 1);
        let decoded = decode_three_d_tiles_content_intrinsic(&tile, WorldTransform::IDENTITY)
            .expect("binary global semantics");
        let DecodedThreeDTilesContent::InstancedMesh(model) = decoded else {
            panic!("expected instanced model");
        };
        assert_eq!(model.batch_length, 1);
        assert_eq!(instance_vertex_world(&model, 0, 0), [11.0, 22.0, 33.0]);
    }

    #[test]
    fn rejects_point_and_instance_bomb_counts_before_payload_allocation() {
        let points = feature_tile(*b"pnts", br#"{"POINTS_LENGTH":16000001}"#, &[], &[], &[]);
        assert!(matches!(
            decode_three_d_tiles_content_intrinsic(&points, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidPointData(
                "point count exceeds the leaf budget"
            ))
        ));

        let instances = i3dm_tile(
            br#"{"INSTANCES_LENGTH":1000001}"#,
            &[],
            &[],
            &triangle_glb(),
            1,
        );
        assert!(matches!(
            decode_three_d_tiles_content_intrinsic(&instances, WorldTransform::IDENTITY),
            Err(ThreeDTilesContentError::InvalidInstanceData(
                "instance count exceeds the leaf budget"
            ))
        ));
    }

    #[test]
    fn composite_preserves_heterogeneous_child_order() {
        let first = feature_tile(
            *b"pnts",
            br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0}}"#,
            &[0; 12],
            &[],
            &[],
        );
        let second = first.clone();
        let total = 16 + first.len() + second.len();
        let mut composite = Vec::with_capacity(total);
        composite.extend(*b"cmpt");
        composite.extend(1_u32.to_le_bytes());
        composite.extend(u32::try_from(total).expect("length").to_le_bytes());
        composite.extend(2_u32.to_le_bytes());
        composite.extend(first);
        composite.extend(second);
        let decoded = decode_three_d_tiles_content(
            &composite,
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("composite");
        let DecodedThreeDTilesContent::Composite(children) = decoded else {
            panic!("expected composite");
        };
        assert_eq!(children.len(), 2);
        assert!(children
            .iter()
            .all(|child| matches!(child, DecodedThreeDTilesContent::Points(_))));
    }

    #[test]
    fn intrinsic_pnts_anchor_preserves_millimetres_at_ecef_scale() {
        let feature_json = br#"{"POINTS_LENGTH":2,"POSITION":{"byteOffset":0},"RTC_CENTER":[6378137.25,4812345.5,512.125]}"#;
        let mut binary = Vec::new();
        for position in [[0.0_f32, 0.0, 0.0], [0.001, 0.0, 0.0]] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        let pnts = feature_tile(*b"pnts", feature_json, &binary, &[], &[]);
        let decoded = decode_three_d_tiles_content_intrinsic(&pnts, WorldTransform::IDENTITY)
            .expect("intrinsic pnts");
        let DecodedThreeDTilesContent::Points(points) = decoded else {
            panic!("expected points");
        };

        assert!(points.points.world_origin.x > 6_000_000.0);
        let first = points.points.world_origin.x + f64::from(points.points.positions[0][0]);
        let second = points.points.world_origin.x + f64::from(points.points.positions[1][0]);
        assert!((first - 6_378_137.25).abs() < 1.0e-9);
        assert!((second - 6_378_137.251).abs() < 1.0e-9);
        assert!((second - first - 0.001).abs() < 1.0e-9);
    }

    #[test]
    fn intrinsic_composite_owns_one_anchor_per_distant_leaf() {
        let first = feature_tile(
            *b"pnts",
            br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0},"RTC_CENTER":[6378137,0,0]}"#,
            &[0; 12],
            &[],
            &[],
        );
        let second = feature_tile(
            *b"pnts",
            br#"{"POINTS_LENGTH":1,"POSITION":{"byteOffset":0},"RTC_CENTER":[0,6378137,0]}"#,
            &[0; 12],
            &[],
            &[],
        );
        let composite = composite(&[first, second]);
        let decoded = decode_three_d_tiles_content_intrinsic(&composite, WorldTransform::IDENTITY)
            .expect("intrinsic composite");
        let DecodedThreeDTilesContent::Composite(children) = decoded else {
            panic!("expected composite");
        };
        let origins = children
            .iter()
            .map(|child| match child {
                DecodedThreeDTilesContent::Points(points) => points.points.world_origin,
                _ => panic!("expected point leaf"),
            })
            .collect::<Vec<_>>();

        assert_eq!(origins[0].x, 6_378_137.0);
        assert_eq!(origins[0].y, 0.0);
        assert_eq!(origins[1].x, 0.0);
        assert_eq!(origins[1].y, 6_378_137.0);
    }

    fn instance_vertex_world(
        model: &DecodedInstancedModel,
        instance_index: usize,
        vertex_index: usize,
    ) -> [f64; 3] {
        let position = model.glb.primitives[0].exact_positions[vertex_index];
        let position = DVec3::new(position.x, position.y, position.z);
        (DMat4::from_cols_array(&model.instances[instance_index].world_from_model.0)
            * position.extend(1.0))
        .truncate()
        .to_array()
    }

    fn feature_tile(
        magic: [u8; 4],
        feature_json: &[u8],
        feature_binary: &[u8],
        batch_json: &[u8],
        batch_binary: &[u8],
    ) -> Vec<u8> {
        let mut feature_json = feature_json.to_vec();
        while !(28 + feature_json.len()).is_multiple_of(8) {
            feature_json.push(b' ');
        }
        let mut feature_binary = feature_binary.to_vec();
        while !(28 + feature_json.len() + feature_binary.len()).is_multiple_of(8) {
            feature_binary.push(0);
        }
        let mut batch_json = batch_json.to_vec();
        while !batch_json.is_empty()
            && !(28 + feature_json.len() + feature_binary.len() + batch_json.len())
                .is_multiple_of(8)
        {
            batch_json.push(b' ');
        }
        let mut batch_binary = batch_binary.to_vec();
        while !batch_binary.is_empty()
            && !(28
                + feature_json.len()
                + feature_binary.len()
                + batch_json.len()
                + batch_binary.len())
            .is_multiple_of(8)
        {
            batch_binary.push(0);
        }
        let total =
            28 + feature_json.len() + feature_binary.len() + batch_json.len() + batch_binary.len();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(magic);
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("length").to_le_bytes());
        for length in [
            feature_json.len(),
            feature_binary.len(),
            batch_json.len(),
            batch_binary.len(),
        ] {
            bytes.extend(u32::try_from(length).expect("length").to_le_bytes());
        }
        bytes.extend(feature_json);
        bytes.extend(feature_binary);
        bytes.extend(batch_json);
        bytes.extend(batch_binary);
        bytes
    }

    fn b3dm_tile(feature_json: &[u8], batch_json: &[u8], glb: &[u8]) -> Vec<u8> {
        let mut feature_json = feature_json.to_vec();
        while !(28 + feature_json.len()).is_multiple_of(8) {
            feature_json.push(b' ');
        }
        let mut batch_json = batch_json.to_vec();
        while !batch_json.is_empty()
            && !(28 + feature_json.len() + batch_json.len()).is_multiple_of(8)
        {
            batch_json.push(b' ');
        }
        let unpadded_total = 28 + feature_json.len() + batch_json.len() + glb.len();
        let total = unpadded_total.next_multiple_of(8);
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"b3dm");
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("length").to_le_bytes());
        bytes.extend(
            u32::try_from(feature_json.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(
            u32::try_from(batch_json.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(feature_json);
        bytes.extend(batch_json);
        bytes.extend(glb);
        bytes.resize(total, 0);
        bytes
    }

    fn i3dm_tile(
        feature_json: &[u8],
        feature_binary: &[u8],
        batch_json: &[u8],
        glb: &[u8],
        gltf_format: u32,
    ) -> Vec<u8> {
        i3dm_tile_with_batch_binary(
            feature_json,
            feature_binary,
            batch_json,
            &[],
            glb,
            gltf_format,
        )
    }

    fn i3dm_uri_tile(feature_json: &[u8], feature_binary: &[u8], uri: &[u8]) -> Vec<u8> {
        let mut feature_json = feature_json.to_vec();
        while !feature_json.len().is_multiple_of(8) {
            feature_json.push(b' ');
        }
        let mut feature_binary = feature_binary.to_vec();
        while !feature_binary.len().is_multiple_of(8) {
            feature_binary.push(0);
        }
        let unpadded_total = 32 + feature_json.len() + feature_binary.len() + uri.len();
        let total = unpadded_total.next_multiple_of(8);
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"i3dm");
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("length").to_le_bytes());
        bytes.extend(
            u32::try_from(feature_json.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(
            u32::try_from(feature_binary.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(feature_json);
        bytes.extend(feature_binary);
        bytes.extend(uri);
        bytes.resize(total, b' ');
        bytes
    }

    fn i3dm_tile_with_batch_binary(
        feature_json: &[u8],
        feature_binary: &[u8],
        batch_json: &[u8],
        batch_binary: &[u8],
        glb: &[u8],
        gltf_format: u32,
    ) -> Vec<u8> {
        let mut feature_json = feature_json.to_vec();
        while !feature_json.len().is_multiple_of(8) {
            feature_json.push(b' ');
        }
        let mut feature_binary = feature_binary.to_vec();
        while !feature_binary.len().is_multiple_of(8) {
            feature_binary.push(0);
        }
        let mut batch_json = batch_json.to_vec();
        while !batch_json.len().is_multiple_of(8) {
            batch_json.push(b' ');
        }
        let mut batch_binary = batch_binary.to_vec();
        while !batch_binary.len().is_multiple_of(8) {
            batch_binary.push(0);
        }
        let unpadded_total = 32
            + feature_json.len()
            + feature_binary.len()
            + batch_json.len()
            + batch_binary.len()
            + glb.len();
        let total = unpadded_total.next_multiple_of(8);
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"i3dm");
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("length").to_le_bytes());
        bytes.extend(
            u32::try_from(feature_json.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(
            u32::try_from(feature_binary.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(
            u32::try_from(batch_json.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(
            u32::try_from(batch_binary.len())
                .expect("length")
                .to_le_bytes(),
        );
        bytes.extend(gltf_format.to_le_bytes());
        bytes.extend(feature_json);
        bytes.extend(feature_binary);
        bytes.extend(batch_json);
        bytes.extend(batch_binary);
        bytes.extend(glb);
        bytes.resize(total, 0);
        bytes
    }

    fn composite(children: &[Vec<u8>]) -> Vec<u8> {
        let total = 16 + children.iter().map(Vec::len).sum::<usize>();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"cmpt");
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("length").to_le_bytes());
        bytes.extend(
            u32::try_from(children.len())
                .expect("child count")
                .to_le_bytes(),
        );
        for child in children {
            bytes.extend(child);
        }
        bytes
    }

    fn triangle_glb() -> Vec<u8> {
        let mut binary = Vec::new();
        for position in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2] {
            binary.extend(index.to_le_bytes());
        }
        let binary_length = binary.len();
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{binary_length}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},{{"buffer":0,"byteOffset":36,"byteLength":6}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1}}]}}],"nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
        );
        let mut json = json.into_bytes();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let total = 12 + 8 + json.len() + 8 + binary.len();
        let mut glb = Vec::with_capacity(total);
        glb.extend(*b"glTF");
        glb.extend(2_u32.to_le_bytes());
        glb.extend(u32::try_from(total).expect("length").to_le_bytes());
        glb.extend(u32::try_from(json.len()).expect("length").to_le_bytes());
        glb.extend(0x4e4f_534a_u32.to_le_bytes());
        glb.extend(json);
        glb.extend(u32::try_from(binary.len()).expect("length").to_le_bytes());
        glb.extend(0x004e_4942_u32.to_le_bytes());
        glb.extend(binary);
        glb
    }

    fn batched_triangles_glb(
        batch_bytes: &[u8],
        component_type: u32,
        count: usize,
        accessor_type: &str,
        normalized: bool,
    ) -> Vec<u8> {
        let mut binary = Vec::new();
        for position in [
            [0.0_f32, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
        ] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2, 3, 4, 5] {
            binary.extend(index.to_le_bytes());
        }
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let batch_offset = binary.len();
        binary.extend(batch_bytes);
        let binary_length = binary.len();
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let normalized = if normalized {
            r#","normalized":true"#
        } else {
            ""
        };
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{binary_length}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":72}},{{"buffer":0,"byteOffset":72,"byteLength":12}},{{"buffer":0,"byteOffset":{batch_offset},"byteLength":{batch_length}}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":6,"type":"VEC3","min":[0,0,0],"max":[3,1,0]}},{{"bufferView":1,"componentType":5123,"count":6,"type":"SCALAR"}},{{"bufferView":2,"componentType":{component_type},"count":{count},"type":"{accessor_type}"{normalized}}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"_BATCHID":2}},"indices":1}}]}}],"nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#,
            batch_length = batch_bytes.len(),
        );
        let mut json = json.into_bytes();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let total = 12 + 8 + json.len() + 8 + binary.len();
        let mut glb = Vec::with_capacity(total);
        glb.extend(*b"glTF");
        glb.extend(2_u32.to_le_bytes());
        glb.extend(u32::try_from(total).expect("length").to_le_bytes());
        glb.extend(u32::try_from(json.len()).expect("length").to_le_bytes());
        glb.extend(0x4e4f_534a_u32.to_le_bytes());
        glb.extend(json);
        glb.extend(u32::try_from(binary.len()).expect("length").to_le_bytes());
        glb.extend(0x004e_4942_u32.to_le_bytes());
        glb.extend(binary);
        glb
    }
}
