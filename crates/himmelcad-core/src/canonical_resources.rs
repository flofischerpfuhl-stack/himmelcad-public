//! Canonical immutable resources and non-geometric entity components.
//!
//! Geometry entities reference these objects by stable identity and content
//! hash. Resource payloads remain independent from renderer and provider
//! implementations.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_document::EntityVersionRef;
use crate::entity::EntityId;
use crate::entity_model::{BimClassification, GeometryObject, GeometryResource, Transform3d};
use crate::entity_validation::validate_geometry_object;
use crate::hash::ObjectHash;

const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_BLOCK_DEFINITIONS: usize = 100_000;
const MAX_BLOCK_MEMBERS: usize = 1_000_000;
const MAX_PATTERN_LINES: usize = 65_536;
const MAX_PATTERN_SEGMENTS: usize = 65_536;
const MAX_CLASSIFICATIONS: usize = 16_384;
const MAX_NETWORK_ITEMS: usize = 1_000_000;
const MAX_RESOURCE_REFERENCES: usize = 1_000_000;
const JAVASCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// Schema identifier for reusable block definitions.
pub const BLOCK_DEFINITION_SCHEMA_ID: &str = "hcad.resource.block-definition@2";
/// Schema identifier for physically based material resources.
pub const MATERIAL_RESOURCE_SCHEMA_ID: &str = "hcad.resource.material@1";
/// Schema identifier for ordered mesh material-table resources.
pub const MATERIAL_TABLE_RESOURCE_SCHEMA_ID: &str = "hcad.resource.material-table@1";
/// Schema identifier for texture resources.
pub const TEXTURE_RESOURCE_SCHEMA_ID: &str = "hcad.resource.texture@1";
/// Schema identifier for hatch-pattern resources.
pub const HATCH_PATTERN_RESOURCE_SCHEMA_ID: &str = "hcad.resource.hatch-pattern@1";
/// Schema identifier for line-type resources.
pub const LINE_TYPE_RESOURCE_SCHEMA_ID: &str = "hcad.resource.line-type@1";
/// Schema identifier for annotation-style resources.
pub const ANNOTATION_STYLE_RESOURCE_SCHEMA_ID: &str = "hcad.resource.annotation-style@1";
/// Schema identifier for canonical point-cloud display styles.
pub const POINT_CLOUD_DISPLAY_STYLE_SCHEMA_ID: &str = "hcad.resource.point-cloud-display@1";
/// Schema identifier for BIM classification components.
pub const BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID: &str = "hcad.component.bim-classification@1";
/// Schema identifier for utility-network topology components.
pub const NETWORK_TOPOLOGY_SCHEMA_ID: &str = "hcad.component.network-topology@1";

/// Canonical point-cloud color source below the view-level VD-D8 override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PointCloudColorMode {
    /// Source RGB when present, otherwise the renderer's neutral source fallback.
    Rgb,
    /// LAS/E57 intensity.
    Intensity,
    /// LAS-compatible classification code.
    Classification,
    /// Authoritative world elevation.
    Elevation,
}

/// One project-owned LAS/civil class display row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointCloudClassDisplay {
    /// LAS-compatible classification code.
    pub code: u8,
    /// Concise user-facing class name.
    pub name: String,
    /// Canonical P9 visibility state.
    pub visible: bool,
}

/// Immutable per-entity point-cloud display state referenced by `styleRef`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointCloudDisplayStyle {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Explicit per-entity size in physical screen pixels for Release 0.5.
    pub point_size_pixels: f32,
    /// Entity-level color source.
    pub color_mode: PointCloudColorMode,
    /// Stable, code-ordered class table and visibility state.
    pub classes: Vec<PointCloudClassDisplay>,
}

impl PointCloudDisplayStyle {
    /// Release-0.5 LAS/civil defaults. Unknown source codes remain visible.
    #[must_use]
    pub fn release_05_default() -> Self {
        Self {
            schema_id: POINT_CLOUD_DISPLAY_STYLE_SCHEMA_ID.to_owned(),
            point_size_pixels: 2.0,
            color_mode: PointCloudColorMode::Rgb,
            classes: [
                (0, "Created, never classified"),
                (1, "Unclassified"),
                (2, "Ground"),
                (3, "Low vegetation"),
                (4, "Medium vegetation"),
                (5, "High vegetation"),
                (6, "Building"),
                (7, "Low point"),
                (9, "Water"),
                (17, "Bridge deck"),
                (18, "High noise"),
            ]
            .into_iter()
            .map(|(code, name)| PointCloudClassDisplay {
                code,
                name: name.to_owned(),
                visible: true,
            })
            .collect(),
        }
    }

    /// Validates the closed Release-0.5 style contract.
    pub fn validate(&self) -> Result<(), CanonicalResourceValidationError> {
        if self.schema_id != POINT_CLOUD_DISPLAY_STYLE_SCHEMA_ID {
            return Err(CanonicalResourceValidationError::InvalidSchema);
        }
        if !self.point_size_pixels.is_finite() || !(1.0..=8.0).contains(&self.point_size_pixels) {
            return Err(CanonicalResourceValidationError::InvalidNumber);
        }
        if self.classes.len() > 256 {
            return Err(CanonicalResourceValidationError::CollectionLimit);
        }
        let mut codes = HashSet::new();
        for class in &self.classes {
            if class.name.trim().is_empty() || class.name.len() > MAX_IDENTIFIER_BYTES {
                return Err(CanonicalResourceValidationError::InvalidIdentifier);
            }
            if !codes.insert(class.code) {
                return Err(CanonicalResourceValidationError::DuplicateIdentifier);
            }
        }
        Ok(())
    }
}

/// Stable immutable resource identity used by resource-to-resource bindings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalResourceRef {
    /// Stable project-owned resource identity.
    pub resource_id: String,
    /// Exact versioned resource schema.
    pub schema_id: String,
    /// Exact immutable resource revision.
    pub content_hash: ObjectHash,
}

/// Explicit order used to compose an instance and one block member placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BlockPlacementComposition {
    /// Column-vector composition `instance * member * member-geometry`.
    InstanceThenMember,
}

/// Explicit style inheritance for one block level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BlockMemberStyle {
    /// Retain the style resolved from the referenced source or enclosing level.
    Inherit,
    /// Remove the inherited source style and use the neutral render style.
    Clear,
    /// The member uses one exact immutable style resource.
    Resource { style: CanonicalResourceRef },
}

/// Explicit attribute-table inheritance for one block level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BlockMemberAttributes {
    /// Retain the exact attribute table resolved from the referenced source.
    Inherit,
    /// Remove the inherited attribute table for this member expansion.
    Clear,
    /// Replace it with one exact content-addressed attribute table.
    Replace { attributes_ref: ObjectHash },
}

/// One stable member-specific override authored on a block instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockMemberOverride {
    /// Definition-owned member identity targeted by this override.
    pub member_id: String,
    /// Explicit style inheritance at this instance level.
    pub style: BlockMemberStyle,
    /// Explicit attribute inheritance at this instance level.
    pub attributes: BlockMemberAttributes,
}

/// Typed overrides carried directly by one canonical block-instance revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockInstanceOverrides {
    /// Style applied to every expanded member before member-specific overrides.
    pub style: BlockMemberStyle,
    /// Attributes applied to every expanded member before member-specific overrides.
    pub attributes: BlockMemberAttributes,
    /// Stable member-specific overrides; duplicate or unknown IDs are invalid.
    pub members: Vec<BlockMemberOverride>,
}

/// Authoritative source of one reusable block member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BlockMemberSource {
    /// Complete member geometry and explicit style state stored in the definition.
    Inline {
        /// Complete canonical member geometry.
        geometry: GeometryObject,
    },
    /// Exact immutable revision of an existing canonical entity.
    EntityReference { entity: EntityVersionRef },
}

/// One locally placed member of an immutable block definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockMember {
    /// Stable identity unique within the definition.
    pub member_id: String,
    /// Placement composed after the block-instance placement.
    pub placement: Transform3d,
    /// Definition-level style assignment or inheritance from the source entity.
    pub style: BlockMemberStyle,
    /// Definition-level attribute assignment or inheritance from the source entity.
    pub attributes: BlockMemberAttributes,
    /// Complete inline content or an exact entity revision.
    pub source: BlockMemberSource,
}

/// Immutable reusable block definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockDefinition {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable definition identity used by block instances.
    pub definition_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Serialized placement-composition convention.
    pub placement_composition: BlockPlacementComposition,
    /// Ordered reusable members.
    pub members: Vec<BlockMember>,
}

/// Linear RGBA value. Components use the inclusive range zero through one.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinearRgba {
    /// Linear red component.
    pub red: f32,
    /// Linear green component.
    pub green: f32,
    /// Linear blue component.
    pub blue: f32,
    /// Opacity.
    pub alpha: f32,
}

/// Declared interpretation of decoded texture samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TextureColorSpace {
    /// Samples encode linear-light values.
    Linear,
    /// Samples encode sRGB color values.
    Srgb,
    /// Samples are non-color scalar or vector data.
    Data,
}

/// Texture-coordinate addressing mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TextureWrapMode {
    /// Clamp to the edge texel.
    ClampToEdge,
    /// Repeat periodically.
    Repeat,
    /// Repeat with alternating mirroring.
    MirroredRepeat,
}

/// Texture sampling filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TextureFilter {
    /// Nearest stored sample.
    Nearest,
    /// Linear interpolation in the selected mip level.
    Linear,
}

/// Immutable texture pixels and sampling defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureResource {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable texture identity.
    pub resource_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Immutable encoded pixels or prepared texture container.
    pub pixels: GeometryResource,
    /// Sample interpretation.
    pub color_space: TextureColorSpace,
    /// Horizontal addressing.
    pub wrap_u: TextureWrapMode,
    /// Vertical addressing.
    pub wrap_v: TextureWrapMode,
    /// Magnification filter.
    pub mag_filter: TextureFilter,
    /// Minification filter.
    pub min_filter: TextureFilter,
}

/// UV transform applied before texture sampling.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureTransform {
    /// UV translation.
    pub offset: [f32; 2],
    /// UV scale.
    pub scale: [f32; 2],
    /// Counter-clockwise rotation in radians.
    pub rotation: f32,
}

/// Semantic material channel fed by a texture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MaterialTextureSlot {
    /// Base color and optional opacity.
    BaseColor,
    /// Tangent-space normal.
    Normal,
    /// Metallic and roughness channels.
    MetallicRoughness,
    /// Emissive color.
    Emissive,
    /// Ambient-occlusion scalar.
    Occlusion,
}

/// Binding from one material channel to one immutable texture resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureResourceBinding {
    /// Material channel receiving the texture.
    pub slot: MaterialTextureSlot,
    /// Exact texture resource revision.
    pub texture: CanonicalResourceRef,
    /// Zero-based texture-coordinate set.
    pub texture_coordinate_set: u8,
    /// Optional UV transform.
    pub transform: Option<TextureTransform>,
}

/// Material alpha interpretation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MaterialAlphaMode {
    /// Fully opaque material.
    Opaque,
    /// Binary cutout using `alphaCutoff`.
    Mask,
    /// Fractional alpha blending.
    Blend,
}

/// Immutable physically based material resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialResource {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable material identity.
    pub resource_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Optional user-facing name.
    pub name: Option<String>,
    /// Linear base color and opacity.
    pub base_color: LinearRgba,
    /// Linear emissive RGB value.
    pub emissive: [f32; 3],
    /// Metallic factor in the inclusive range zero through one.
    pub metallic: f32,
    /// Roughness factor in the inclusive range zero through one.
    pub roughness: f32,
    /// Alpha interpretation.
    pub alpha_mode: MaterialAlphaMode,
    /// Required for masked materials and absent otherwise.
    pub alpha_cutoff: Option<f32>,
    /// Whether both triangle orientations are rendered.
    pub double_sided: bool,
    /// At most one texture binding for each material channel.
    pub texture_bindings: Vec<TextureResourceBinding>,
}

/// Immutable ordered mapping from mesh material slots to exact material
/// revisions.
///
/// Triangle meshes store only compact zero-based slot indices.  Keeping the
/// ordered table as a typed canonical resource makes every slot resolvable
/// without interpreting provider-specific JSON and lets older mesh revisions
/// retain their authored materials after a material is edited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialTableResource {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable material-table identity.
    pub resource_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Ordered, non-empty exact material revisions addressed by mesh slots.
    pub materials: Vec<CanonicalResourceRef>,
}

/// One repeated analytic hatch line family.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HatchPatternLine {
    /// Line angle in radians.
    pub angle: f64,
    /// Pattern-space point on the base line.
    pub origin: [f64; 2],
    /// Translation to the next parallel line.
    pub offset: [f64; 2],
    /// Signed dash sequence: positive draw, negative gap and zero dot.
    pub dash_pattern: Vec<f64>,
}

/// Hatch fill construction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HatchPatternKind {
    /// Continuous solid fill.
    Solid,
    /// Repeated analytic line families.
    Lines { lines: Vec<HatchPatternLine> },
}

/// Immutable hatch-pattern resource independent of area geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HatchPatternResource {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable hatch-pattern identity.
    pub resource_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Optional user-facing name.
    pub name: Option<String>,
    /// Pattern definition.
    pub pattern: HatchPatternKind,
}

/// One element of a repeating line-type pattern.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LineTypeElement {
    /// Visible segment with positive length.
    Dash { length: f64 },
    /// Invisible segment with positive length.
    Gap { length: f64 },
    /// Zero-length visible dot.
    Dot,
}

/// Continuous or explicitly repeating line construction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LineTypePattern {
    /// Unbroken continuous line.
    Continuous,
    /// Repeating finite dash/gap/dot sequence.
    Repeating { elements: Vec<LineTypeElement> },
}

/// Immutable continuous or repeating line-type resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineTypeResource {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable line-type identity.
    pub resource_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Optional user-facing name.
    pub name: Option<String>,
    /// Continuous or repeating construction.
    pub pattern: LineTypePattern,
}

/// Terminator used by dimensions and leaders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AnnotationTerminator {
    /// Filled arrow head.
    ClosedArrow,
    /// Open arrow head.
    OpenArrow,
    /// Architectural tick.
    Tick,
    /// Filled dot.
    Dot,
    /// No terminator.
    None,
}

/// Immutable shared text, label and dimension style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationStyleResource {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable annotation-style identity.
    pub resource_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Optional user-facing name.
    pub name: Option<String>,
    /// Immutable encoded font resource.
    pub font: GeometryResource,
    /// Default text height in project units.
    pub text_height: f64,
    /// Linear annotation color.
    pub color: LinearRgba,
    /// Optional exact line-type revision.
    pub line_type: Option<CanonicalResourceRef>,
    /// Dimension/leader terminator.
    pub terminator: AnnotationTerminator,
    /// Terminator size in project units.
    pub terminator_size: f64,
    /// Number of displayed decimal places.
    pub decimal_places: u8,
    /// Optional unit suffix.
    pub unit_suffix: Option<String>,
}

/// Immutable BIM classifications attached as one typed entity component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BimClassificationComponent {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Ordered unique classifications.
    pub classifications: Vec<BimClassification>,
}

/// One graph node backed by a canonical entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkNode {
    /// Stable identity unique within the topology.
    pub node_id: String,
    /// Canonical entity represented by the node.
    pub entity_id: EntityId,
}

/// One connectable port owned by a graph node and backed by an entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkPort {
    /// Stable identity unique within the topology.
    pub port_id: String,
    /// Owning node.
    pub node_id: String,
    /// Canonical entity represented by the port.
    pub entity_id: EntityId,
}

/// One utility connection between two ports and its canonical entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkEdge {
    /// Stable identity unique within the topology.
    pub edge_id: String,
    /// Canonical entity represented by the edge.
    pub entity_id: EntityId,
    /// First endpoint port.
    pub from_port_id: String,
    /// Second endpoint port.
    pub to_port_id: String,
    /// Whether traversal is restricted from `from` to `to`.
    pub directed: bool,
}

/// Cycle policy explicitly authored for one utility topology.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum NetworkCyclePolicy {
    /// Physical loops are valid.
    Allow,
    /// The undirected node projection must form a forest.
    AcyclicUndirectedProjection,
}

/// Immutable typed utility-network topology component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkTopology {
    /// Exact versioned schema identifier.
    pub schema_id: String,
    /// Stable topology identity.
    pub topology_id: String,
    /// Hash of every serialized field except `contentHash`.
    pub content_hash: ObjectHash,
    /// Explicit cycle semantics.
    pub cycle_policy: NetworkCyclePolicy,
    /// Graph nodes.
    pub nodes: Vec<NetworkNode>,
    /// Connectable ports.
    pub ports: Vec<NetworkPort>,
    /// Connections.
    pub edges: Vec<NetworkEdge>,
}

/// Reason an immutable resource or component cannot enter canonical storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CanonicalResourceValidationError {
    /// A schema, resource, member or topology identifier is invalid.
    #[error("canonical resource identifier is invalid")]
    InvalidIdentifier,
    /// A required schema identifier does not match the supported version.
    #[error("canonical resource schema is unsupported")]
    InvalidSchema,
    /// A content hash is malformed or does not match the serialized object.
    #[error("canonical resource content hash is invalid")]
    InvalidContentHash,
    /// A numeric value is non-finite or outside its contract range.
    #[error("canonical resource numeric value is invalid")]
    InvalidNumber,
    /// A collection exceeds its schema limit.
    #[error("canonical resource collection exceeds its bounded limit")]
    CollectionLimit,
    /// A supposedly unique local identity occurs more than once.
    #[error("canonical resource contains a duplicate identity")]
    DuplicateIdentifier,
    /// A referenced entity, port, node, definition or resource does not exist.
    #[error("canonical resource reference cannot be resolved")]
    MissingReference,
    /// A reference resolves to a different immutable revision.
    #[error("canonical resource reference revision does not match")]
    ReferenceVersionMismatch,
    /// Block definitions recursively contain themselves.
    #[error("canonical block-definition graph is recursive")]
    RecursiveBlockDefinition,
    /// Topology violates its explicit cycle policy.
    #[error("canonical network topology violates its cycle policy")]
    CyclicTopology,
    /// Inline geometry failed canonical geometry validation.
    #[error("canonical block member geometry is invalid")]
    InvalidGeometry,
    /// Canonical JSON encoding failed.
    #[error("canonical resource serialization failed")]
    Serialization,
}

macro_rules! impl_content_addressed {
    ($type:ty, $schema:expr, $id:ident) => {
        impl $type {
            /// Exact schema supported by this contract revision.
            pub const SCHEMA_ID: &'static str = $schema;

            /// Computes the canonical hash excluding the `contentHash` field.
            pub fn computed_content_hash(
                &self,
            ) -> Result<ObjectHash, CanonicalResourceValidationError> {
                content_hash_without_embedded_hash(self)
            }

            /// Computes and embeds the immutable content hash before publication.
            pub fn seal(mut self) -> Result<Self, CanonicalResourceValidationError> {
                self.content_hash = self.computed_content_hash()?;
                Ok(self)
            }

            /// Returns this resource's exact stable identity and revision.
            #[must_use]
            pub fn resource_ref(&self) -> CanonicalResourceRef {
                CanonicalResourceRef {
                    resource_id: self.$id.clone(),
                    schema_id: self.schema_id.clone(),
                    content_hash: self.content_hash.clone(),
                }
            }
        }
    };
}

impl_content_addressed!(BlockDefinition, BLOCK_DEFINITION_SCHEMA_ID, definition_id);
impl_content_addressed!(MaterialResource, MATERIAL_RESOURCE_SCHEMA_ID, resource_id);
impl_content_addressed!(
    MaterialTableResource,
    MATERIAL_TABLE_RESOURCE_SCHEMA_ID,
    resource_id
);
impl_content_addressed!(TextureResource, TEXTURE_RESOURCE_SCHEMA_ID, resource_id);
impl_content_addressed!(
    HatchPatternResource,
    HATCH_PATTERN_RESOURCE_SCHEMA_ID,
    resource_id
);
impl_content_addressed!(LineTypeResource, LINE_TYPE_RESOURCE_SCHEMA_ID, resource_id);
impl_content_addressed!(
    AnnotationStyleResource,
    ANNOTATION_STYLE_RESOURCE_SCHEMA_ID,
    resource_id
);
impl_content_addressed!(NetworkTopology, NETWORK_TOPOLOGY_SCHEMA_ID, topology_id);

impl BimClassificationComponent {
    /// Exact schema supported by this contract revision.
    pub const SCHEMA_ID: &'static str = BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID;

    /// Computes the canonical hash excluding the `contentHash` field.
    pub fn computed_content_hash(&self) -> Result<ObjectHash, CanonicalResourceValidationError> {
        content_hash_without_embedded_hash(self)
    }

    /// Computes and embeds the immutable content hash before publication.
    pub fn seal(mut self) -> Result<Self, CanonicalResourceValidationError> {
        self.content_hash = self.computed_content_hash()?;
        Ok(self)
    }
}

/// Composes a block-instance placement with a member-local placement.
///
/// Both matrices are column-major and operate on column vectors. The result is
/// `instance * member`, so member-local coordinates are transformed first.
#[must_use]
pub fn compose_block_member_placement(instance: Transform3d, member: Transform3d) -> Transform3d {
    let mut result = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            result[column * 4 + row] = (0..4)
                .map(|inner| instance.0[inner * 4 + row] * member.0[column * 4 + inner])
                .sum();
        }
    }
    Transform3d(result)
}

/// Validates a texture resource independently of storage publication.
pub fn validate_texture_resource(
    texture: &TextureResource,
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &texture.schema_id,
        TEXTURE_RESOURCE_SCHEMA_ID,
        &texture.resource_id,
        &texture.content_hash,
        texture,
    )?;
    validate_geometry_resource(&texture.pixels)
}

/// Validates a material and every texture binding against a resource index.
pub fn validate_material_resource(
    material: &MaterialResource,
    resources: &[CanonicalResourceRef],
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &material.schema_id,
        MATERIAL_RESOURCE_SCHEMA_ID,
        &material.resource_id,
        &material.content_hash,
        material,
    )?;
    validate_optional_text(material.name.as_deref())?;
    validate_color(material.base_color)?;
    if !material
        .emissive
        .iter()
        .all(|value| finite_non_negative(*value))
        || !unit_interval(material.metallic)
        || !unit_interval(material.roughness)
    {
        return Err(CanonicalResourceValidationError::InvalidNumber);
    }
    match (material.alpha_mode, material.alpha_cutoff) {
        (MaterialAlphaMode::Mask, Some(cutoff)) if unit_interval(cutoff) => {}
        (MaterialAlphaMode::Mask, _) => {
            return Err(CanonicalResourceValidationError::InvalidNumber);
        }
        (_, None) => {}
        (_, Some(_)) => return Err(CanonicalResourceValidationError::InvalidNumber),
    }
    if material.texture_bindings.len() > MaterialTextureSlot::COUNT {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let resource_index = build_resource_index(resources)?;
    let mut slots = HashSet::with_capacity(material.texture_bindings.len());
    for binding in &material.texture_bindings {
        if !slots.insert(binding.slot) {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
        validate_canonical_resource_ref(&binding.texture)?;
        validate_resolved_resource_ref(
            &binding.texture,
            TEXTURE_RESOURCE_SCHEMA_ID,
            &resource_index,
        )?;
        if binding.texture_coordinate_set > 7 {
            return Err(CanonicalResourceValidationError::InvalidNumber);
        }
        if let Some(transform) = binding.transform {
            if !transform
                .offset
                .iter()
                .chain(transform.scale.iter())
                .all(|value| value.is_finite())
                || !transform.rotation.is_finite()
                || transform.scale.contains(&0.0)
            {
                return Err(CanonicalResourceValidationError::InvalidNumber);
            }
        }
    }
    Ok(())
}

/// Validates an ordered material table against exact immutable material
/// revisions. Repeating one material in multiple slots is intentional and
/// therefore valid.
pub fn validate_material_table_resource(
    table: &MaterialTableResource,
    resources: &[CanonicalResourceRef],
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &table.schema_id,
        MATERIAL_TABLE_RESOURCE_SCHEMA_ID,
        &table.resource_id,
        &table.content_hash,
        table,
    )?;
    if table.materials.is_empty() || table.materials.len() > MAX_RESOURCE_REFERENCES {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let resource_index = build_resource_index(resources)?;
    for material in &table.materials {
        validate_resolved_resource_ref(material, MATERIAL_RESOURCE_SCHEMA_ID, &resource_index)?;
    }
    Ok(())
}

impl MaterialTextureSlot {
    const COUNT: usize = 5;
}

/// Validates an immutable hatch-pattern resource.
pub fn validate_hatch_pattern_resource(
    hatch: &HatchPatternResource,
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &hatch.schema_id,
        HATCH_PATTERN_RESOURCE_SCHEMA_ID,
        &hatch.resource_id,
        &hatch.content_hash,
        hatch,
    )?;
    validate_optional_text(hatch.name.as_deref())?;
    if let HatchPatternKind::Lines { lines } = &hatch.pattern {
        if lines.is_empty() || lines.len() > MAX_PATTERN_LINES {
            return Err(CanonicalResourceValidationError::CollectionLimit);
        }
        for line in lines {
            let direction = [line.angle.cos(), line.angle.sin()];
            let normal_step = -direction[1] * line.offset[0] + direction[0] * line.offset[1];
            if !line.angle.is_finite()
                || !line
                    .origin
                    .iter()
                    .chain(line.offset.iter())
                    .all(|v| v.is_finite())
                || line.offset == [0.0, 0.0]
                || !normal_step.is_finite()
                || normal_step.abs() <= f64::EPSILON
                || line.dash_pattern.len() > MAX_PATTERN_SEGMENTS
                || line.dash_pattern.iter().any(|value| !value.is_finite())
                || (!line.dash_pattern.is_empty()
                    && !line
                        .dash_pattern
                        .iter()
                        .any(|value| value.abs() > f64::EPSILON))
            {
                return Err(CanonicalResourceValidationError::InvalidNumber);
            }
        }
    }
    Ok(())
}

/// Validates an immutable line-type resource.
pub fn validate_line_type_resource(
    line_type: &LineTypeResource,
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &line_type.schema_id,
        LINE_TYPE_RESOURCE_SCHEMA_ID,
        &line_type.resource_id,
        &line_type.content_hash,
        line_type,
    )?;
    validate_optional_text(line_type.name.as_deref())?;
    if let LineTypePattern::Repeating { elements } = &line_type.pattern {
        if elements.is_empty() || elements.len() > MAX_PATTERN_SEGMENTS {
            return Err(CanonicalResourceValidationError::CollectionLimit);
        }
        let mut advances = false;
        for element in elements {
            match element {
                LineTypeElement::Dash { length } | LineTypeElement::Gap { length }
                    if length.is_finite() && *length > 0.0 =>
                {
                    advances = true;
                }
                LineTypeElement::Dot => {}
                _ => return Err(CanonicalResourceValidationError::InvalidNumber),
            }
        }
        if !advances {
            return Err(CanonicalResourceValidationError::InvalidNumber);
        }
    }
    Ok(())
}

/// Validates an immutable annotation style and its line-type reference.
pub fn validate_annotation_style_resource(
    style: &AnnotationStyleResource,
    resources: &[CanonicalResourceRef],
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &style.schema_id,
        ANNOTATION_STYLE_RESOURCE_SCHEMA_ID,
        &style.resource_id,
        &style.content_hash,
        style,
    )?;
    validate_optional_text(style.name.as_deref())?;
    validate_optional_text(style.unit_suffix.as_deref())?;
    validate_geometry_resource(&style.font)?;
    validate_color(style.color)?;
    let terminator_size_valid = match style.terminator {
        AnnotationTerminator::None => style.terminator_size.abs() <= f64::EPSILON,
        _ => finite_positive(style.terminator_size),
    };
    if !finite_positive(style.text_height) || !terminator_size_valid || style.decimal_places > 15 {
        return Err(CanonicalResourceValidationError::InvalidNumber);
    }
    if let Some(line_type) = &style.line_type {
        let resource_index = build_resource_index(resources)?;
        validate_resolved_resource_ref(line_type, LINE_TYPE_RESOURCE_SCHEMA_ID, &resource_index)?;
    }
    Ok(())
}

/// Validates one immutable BIM-classification component.
pub fn validate_bim_classification_component(
    component: &BimClassificationComponent,
) -> Result<(), CanonicalResourceValidationError> {
    validate_schema_and_hash(
        &component.schema_id,
        BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID,
        &component.content_hash,
        component,
    )?;
    if component.classifications.is_empty() || component.classifications.len() > MAX_CLASSIFICATIONS
    {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let mut identities = HashSet::with_capacity(component.classifications.len());
    for classification in &component.classifications {
        if !valid_text(&classification.system, MAX_TEXT_BYTES)
            || !valid_text(&classification.code, MAX_TEXT_BYTES)
            || classification
                .predefined_type
                .as_deref()
                .is_some_and(|value| !valid_text(value, MAX_TEXT_BYTES))
        {
            return Err(CanonicalResourceValidationError::InvalidIdentifier);
        }
        if !identities.insert((
            classification.system.as_str(),
            classification.code.as_str(),
            classification.predefined_type.as_deref(),
        )) {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
    }
    Ok(())
}

/// Validates a complete block-definition graph and all external references.
pub fn validate_block_definition_set(
    definitions: &[BlockDefinition],
    entities: &[EntityVersionRef],
    resources: &[CanonicalResourceRef],
    attribute_tables: &[ObjectHash],
) -> Result<(), CanonicalResourceValidationError> {
    if definitions.len() > MAX_BLOCK_DEFINITIONS {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let resource_index = build_resource_index(resources)?;
    let entity_index = build_entity_index(entities)?;
    let attribute_index = build_block_attribute_index(attribute_tables)?;
    let mut definition_index = HashMap::with_capacity(definitions.len());
    for definition in definitions {
        validate_resource_envelope(
            &definition.schema_id,
            BLOCK_DEFINITION_SCHEMA_ID,
            &definition.definition_id,
            &definition.content_hash,
            definition,
        )?;
        if definition_index
            .insert(
                (
                    definition.definition_id.as_str(),
                    definition.content_hash.as_str(),
                ),
                definition,
            )
            .is_some()
        {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
        if definition.members.len() > MAX_BLOCK_MEMBERS {
            return Err(CanonicalResourceValidationError::CollectionLimit);
        }
        let mut member_ids = HashSet::with_capacity(definition.members.len());
        for member in &definition.members {
            if !valid_identifier(&member.member_id) || !member_ids.insert(&member.member_id) {
                return Err(CanonicalResourceValidationError::DuplicateIdentifier);
            }
            validate_transform(member.placement)?;
            validate_block_member_style_resources(&member.style, &resource_index)?;
            validate_block_member_attributes(&member.attributes, &attribute_index)?;
            match &member.source {
                BlockMemberSource::Inline { geometry } => {
                    validate_geometry_object(geometry)
                        .map_err(|_| CanonicalResourceValidationError::InvalidGeometry)?;
                    if let GeometryObject::Block { instance } = geometry {
                        validate_block_instance_override_resources(
                            instance,
                            &resource_index,
                            &attribute_index,
                        )?;
                    }
                }
                BlockMemberSource::EntityReference { entity } => {
                    let Some(versions) = entity_index.get(&entity.id) else {
                        return Err(CanonicalResourceValidationError::MissingReference);
                    };
                    if !versions.contains(&entity) {
                        return Err(CanonicalResourceValidationError::ReferenceVersionMismatch);
                    }
                }
            }
        }
    }

    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for definition in definitions {
        validate_block_cycles(definition, &definition_index, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn validate_block_member_style_resources(
    style: &BlockMemberStyle,
    resources: &HashMap<&str, Vec<&CanonicalResourceRef>>,
) -> Result<(), CanonicalResourceValidationError> {
    let BlockMemberStyle::Resource { style } = style else {
        return Ok(());
    };
    validate_canonical_resource_ref(style)?;
    let Some(versions) = resources.get(style.resource_id.as_str()) else {
        return Err(CanonicalResourceValidationError::MissingReference);
    };
    if !versions.contains(&style) {
        return Err(CanonicalResourceValidationError::ReferenceVersionMismatch);
    }
    Ok(())
}

fn validate_block_member_attributes(
    attributes: &BlockMemberAttributes,
    attribute_tables: &HashSet<&str>,
) -> Result<(), CanonicalResourceValidationError> {
    if let BlockMemberAttributes::Replace { attributes_ref } = attributes {
        if !valid_hash(attributes_ref.as_str()) {
            return Err(CanonicalResourceValidationError::InvalidContentHash);
        }
        if !attribute_tables.contains(attributes_ref.as_str()) {
            return Err(CanonicalResourceValidationError::MissingReference);
        }
    }
    Ok(())
}

fn validate_block_instance_override_resources(
    instance: &crate::entity_model::BlockInstanceGeometry,
    resources: &HashMap<&str, Vec<&CanonicalResourceRef>>,
    attribute_tables: &HashSet<&str>,
) -> Result<(), CanonicalResourceValidationError> {
    let Some(overrides) = &instance.overrides else {
        return Ok(());
    };
    validate_block_member_style_resources(&overrides.style, resources)?;
    validate_block_member_attributes(&overrides.attributes, attribute_tables)?;
    for member in &overrides.members {
        validate_block_member_style_resources(&member.style, resources)?;
        validate_block_member_attributes(&member.attributes, attribute_tables)?;
    }
    Ok(())
}

fn build_block_attribute_index(
    attributes: &[ObjectHash],
) -> Result<HashSet<&str>, CanonicalResourceValidationError> {
    if attributes.len() > MAX_RESOURCE_REFERENCES {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let mut index = HashSet::with_capacity(attributes.len());
    for attributes_ref in attributes {
        if !valid_hash(attributes_ref.as_str()) {
            return Err(CanonicalResourceValidationError::InvalidContentHash);
        }
        if !index.insert(attributes_ref.as_str()) {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
    }
    Ok(index)
}

/// Validates utility topology references, uniqueness and explicit cycle policy.
pub fn validate_network_topology(
    topology: &NetworkTopology,
    entities: &[EntityId],
) -> Result<(), CanonicalResourceValidationError> {
    validate_resource_envelope(
        &topology.schema_id,
        NETWORK_TOPOLOGY_SCHEMA_ID,
        &topology.topology_id,
        &topology.content_hash,
        topology,
    )?;
    if entities.len() > MAX_NETWORK_ITEMS
        || topology.nodes.len() > MAX_NETWORK_ITEMS
        || topology.ports.len() > MAX_NETWORK_ITEMS
        || topology.edges.len() > MAX_NETWORK_ITEMS
    {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let known_entities: HashSet<_> = entities.iter().collect();
    if known_entities.len() != entities.len() {
        return Err(CanonicalResourceValidationError::DuplicateIdentifier);
    }

    let mut node_index = HashMap::with_capacity(topology.nodes.len());
    for (index, node) in topology.nodes.iter().enumerate() {
        if !valid_identifier(&node.node_id) || !valid_entity_id(&node.entity_id) {
            return Err(CanonicalResourceValidationError::InvalidIdentifier);
        }
        if !known_entities.contains(&node.entity_id) {
            return Err(CanonicalResourceValidationError::MissingReference);
        }
        if node_index.insert(node.node_id.as_str(), index).is_some() {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
    }

    let mut port_index = HashMap::with_capacity(topology.ports.len());
    for port in &topology.ports {
        if !valid_identifier(&port.port_id) || !valid_entity_id(&port.entity_id) {
            return Err(CanonicalResourceValidationError::InvalidIdentifier);
        }
        if !known_entities.contains(&port.entity_id)
            || !node_index.contains_key(port.node_id.as_str())
        {
            return Err(CanonicalResourceValidationError::MissingReference);
        }
        if port_index.insert(port.port_id.as_str(), port).is_some() {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
    }

    let mut edge_ids = HashSet::with_capacity(topology.edges.len());
    let mut adjacency = vec![Vec::new(); topology.nodes.len()];
    for edge in &topology.edges {
        let Some(from_port) = port_index.get(edge.from_port_id.as_str()) else {
            return Err(CanonicalResourceValidationError::MissingReference);
        };
        let Some(to_port) = port_index.get(edge.to_port_id.as_str()) else {
            return Err(CanonicalResourceValidationError::MissingReference);
        };
        if !valid_identifier(&edge.edge_id)
            || !valid_entity_id(&edge.entity_id)
            || edge.from_port_id == edge.to_port_id
        {
            return Err(CanonicalResourceValidationError::InvalidIdentifier);
        }
        if !edge_ids.insert(&edge.edge_id) {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
        if !known_entities.contains(&edge.entity_id) {
            return Err(CanonicalResourceValidationError::MissingReference);
        }
        let from = node_index[from_port.node_id.as_str()];
        let to = node_index[to_port.node_id.as_str()];
        if from == to && topology.cycle_policy == NetworkCyclePolicy::AcyclicUndirectedProjection {
            return Err(CanonicalResourceValidationError::CyclicTopology);
        }
        adjacency[from].push(to);
        adjacency[to].push(from);
    }

    if topology.cycle_policy == NetworkCyclePolicy::AcyclicUndirectedProjection
        && undirected_cycle_exists(&adjacency)
    {
        return Err(CanonicalResourceValidationError::CyclicTopology);
    }
    Ok(())
}

fn validate_block_cycles<'a>(
    definition: &'a BlockDefinition,
    definitions: &HashMap<(&'a str, &'a str), &'a BlockDefinition>,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
) -> Result<(), CanonicalResourceValidationError> {
    let key = format!(
        "{}:{}:{}",
        definition.definition_id.len(),
        definition.definition_id,
        definition.content_hash.as_str()
    );
    if visited.contains(&key) {
        return Ok(());
    }
    if !visiting.insert(key.clone()) {
        return Err(CanonicalResourceValidationError::RecursiveBlockDefinition);
    }
    for member in &definition.members {
        let BlockMemberSource::Inline { geometry, .. } = &member.source else {
            continue;
        };
        let GeometryObject::Block { instance } = geometry else {
            continue;
        };
        let lookup = (
            instance.definition_id.as_str(),
            instance.definition_hash.as_str(),
        );
        let Some(nested) = definitions.get(&lookup) else {
            return Err(
                if definitions
                    .keys()
                    .any(|(definition_id, _)| *definition_id == instance.definition_id.as_str())
                {
                    CanonicalResourceValidationError::ReferenceVersionMismatch
                } else {
                    CanonicalResourceValidationError::MissingReference
                },
            );
        };
        if let Some(overrides) = &instance.overrides {
            let nested_members = nested
                .members
                .iter()
                .map(|member| member.member_id.as_str())
                .collect::<HashSet<_>>();
            if overrides
                .members
                .iter()
                .any(|member| !nested_members.contains(member.member_id.as_str()))
            {
                return Err(CanonicalResourceValidationError::MissingReference);
            }
        }
        validate_block_cycles(nested, definitions, visiting, visited)?;
    }
    visiting.remove(&key);
    visited.insert(key);
    Ok(())
}

fn undirected_cycle_exists(adjacency: &[Vec<usize>]) -> bool {
    let mut visited = vec![false; adjacency.len()];
    for start in 0..adjacency.len() {
        if visited[start] {
            continue;
        }
        let mut stack = vec![(start, usize::MAX)];
        while let Some((node, parent)) = stack.pop() {
            if visited[node] {
                return true;
            }
            visited[node] = true;
            for &neighbor in &adjacency[node] {
                if neighbor != parent {
                    stack.push((neighbor, node));
                }
            }
        }
    }
    false
}

fn build_resource_index(
    resources: &[CanonicalResourceRef],
) -> Result<HashMap<&str, Vec<&CanonicalResourceRef>>, CanonicalResourceValidationError> {
    if resources.len() > MAX_RESOURCE_REFERENCES {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let mut index = HashMap::<&str, Vec<&CanonicalResourceRef>>::new();
    for resource in resources {
        validate_canonical_resource_ref(resource)?;
        let versions = index.entry(resource.resource_id.as_str()).or_default();
        if versions.contains(&resource) {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
        versions.push(resource);
    }
    Ok(index)
}

fn build_entity_index(
    entities: &[EntityVersionRef],
) -> Result<HashMap<EntityId, Vec<&EntityVersionRef>>, CanonicalResourceValidationError> {
    if entities.len() > MAX_NETWORK_ITEMS {
        return Err(CanonicalResourceValidationError::CollectionLimit);
    }
    let mut index = HashMap::<EntityId, Vec<&EntityVersionRef>>::new();
    for entity in entities {
        if !valid_entity_id(&entity.id)
            || entity.revision > JAVASCRIPT_SAFE_INTEGER_MAX
            || !valid_hash(entity.version_hash.as_str())
        {
            return Err(CanonicalResourceValidationError::InvalidIdentifier);
        }
        let versions = index.entry(entity.id.clone()).or_default();
        if versions.contains(&entity) {
            return Err(CanonicalResourceValidationError::DuplicateIdentifier);
        }
        versions.push(entity);
    }
    Ok(index)
}

fn validate_resolved_resource_ref(
    resource: &CanonicalResourceRef,
    expected_schema: &str,
    index: &HashMap<&str, Vec<&CanonicalResourceRef>>,
) -> Result<(), CanonicalResourceValidationError> {
    validate_canonical_resource_ref(resource)?;
    if resource.schema_id != expected_schema {
        return Err(CanonicalResourceValidationError::InvalidSchema);
    }
    let Some(versions) = index.get(resource.resource_id.as_str()) else {
        return Err(CanonicalResourceValidationError::MissingReference);
    };
    if !versions.contains(&resource) {
        return Err(CanonicalResourceValidationError::ReferenceVersionMismatch);
    }
    Ok(())
}

/// Validates the envelope of one exact immutable canonical resource reference.
pub fn validate_canonical_resource_ref(
    resource: &CanonicalResourceRef,
) -> Result<(), CanonicalResourceValidationError> {
    if valid_identifier(&resource.resource_id)
        && valid_schema_id(&resource.schema_id)
        && valid_hash(resource.content_hash.as_str())
    {
        Ok(())
    } else {
        Err(CanonicalResourceValidationError::InvalidIdentifier)
    }
}

fn validate_resource_envelope<T: Serialize>(
    schema_id: &str,
    expected_schema: &str,
    resource_id: &str,
    content_hash: &ObjectHash,
    resource: &T,
) -> Result<(), CanonicalResourceValidationError> {
    if !valid_identifier(resource_id) {
        return Err(CanonicalResourceValidationError::InvalidIdentifier);
    }
    validate_schema_and_hash(schema_id, expected_schema, content_hash, resource)
}

fn validate_schema_and_hash<T: Serialize>(
    schema_id: &str,
    expected_schema: &str,
    content_hash: &ObjectHash,
    resource: &T,
) -> Result<(), CanonicalResourceValidationError> {
    if schema_id != expected_schema {
        return Err(CanonicalResourceValidationError::InvalidSchema);
    }
    if !valid_hash(content_hash.as_str())
        || content_hash_without_embedded_hash(resource)? != *content_hash
    {
        return Err(CanonicalResourceValidationError::InvalidContentHash);
    }
    Ok(())
}

fn content_hash_without_embedded_hash<T: Serialize>(
    resource: &T,
) -> Result<ObjectHash, CanonicalResourceValidationError> {
    let mut value = serde_json::to_value(resource)
        .map_err(|_| CanonicalResourceValidationError::Serialization)?;
    let object = value
        .as_object_mut()
        .ok_or(CanonicalResourceValidationError::Serialization)?;
    if object.remove("contentHash").is_none() {
        return Err(CanonicalResourceValidationError::Serialization);
    }
    let bytes =
        serde_json::to_vec(&value).map_err(|_| CanonicalResourceValidationError::Serialization)?;
    Ok(ObjectHash::of_bytes(&bytes))
}

fn validate_geometry_resource(
    resource: &GeometryResource,
) -> Result<(), CanonicalResourceValidationError> {
    if !valid_hash(resource.object_hash.as_str())
        || !valid_text(&resource.media_type, MAX_IDENTIFIER_BYTES)
        || resource
            .byte_length
            .is_some_and(|length| length == 0 || length > JAVASCRIPT_SAFE_INTEGER_MAX)
    {
        Err(CanonicalResourceValidationError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

fn validate_transform(transform: Transform3d) -> Result<(), CanonicalResourceValidationError> {
    let determinant = transform.0[0]
        * (transform.0[5] * transform.0[10] - transform.0[9] * transform.0[6])
        - transform.0[4] * (transform.0[1] * transform.0[10] - transform.0[9] * transform.0[2])
        + transform.0[8] * (transform.0[1] * transform.0[6] - transform.0[5] * transform.0[2]);
    if transform.0.iter().all(|value| value.is_finite())
        && transform.0[3].abs() <= f64::EPSILON
        && transform.0[7].abs() <= f64::EPSILON
        && transform.0[11].abs() <= f64::EPSILON
        && (transform.0[15] - 1.0).abs() <= f64::EPSILON
        && determinant.is_finite()
        && determinant.abs() > f64::EPSILON
    {
        Ok(())
    } else {
        Err(CanonicalResourceValidationError::InvalidNumber)
    }
}

fn validate_color(color: LinearRgba) -> Result<(), CanonicalResourceValidationError> {
    if [color.red, color.green, color.blue, color.alpha]
        .into_iter()
        .all(unit_interval)
    {
        Ok(())
    } else {
        Err(CanonicalResourceValidationError::InvalidNumber)
    }
}

fn validate_optional_text(value: Option<&str>) -> Result<(), CanonicalResourceValidationError> {
    if value.is_some_and(|value| !valid_text(value, MAX_TEXT_BYTES)) {
        Err(CanonicalResourceValidationError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    valid_text(value, MAX_IDENTIFIER_BYTES) && !value.chars().any(char::is_whitespace)
}

fn valid_entity_id(value: &EntityId) -> bool {
    valid_identifier(&value.0)
}

fn valid_schema_id(value: &str) -> bool {
    let Some((name, version)) = value.rsplit_once('@') else {
        return false;
    };
    name.contains('.')
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
        && !version.is_empty()
        && version.chars().all(|character| character.is_ascii_digit())
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unit_interval(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn finite_non_negative(value: f32) -> bool {
    value.is_finite() && value >= 0.0
}

fn finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity_model::{BlockInstanceGeometry, Position};

    fn hash(seed: &str) -> ObjectHash {
        ObjectHash::of_bytes(seed.as_bytes())
    }

    fn entity_ref(id: &str) -> EntityVersionRef {
        EntityVersionRef {
            id: EntityId(id.to_owned()),
            revision: 3,
            version_hash: hash(id),
        }
    }

    fn geometry_resource(media_type: &str) -> GeometryResource {
        GeometryResource {
            object_hash: hash(media_type),
            media_type: media_type.to_owned(),
            byte_length: Some(128),
        }
    }

    fn point_member(id: &str) -> BlockMember {
        BlockMember {
            member_id: id.to_owned(),
            placement: Transform3d::IDENTITY,
            style: BlockMemberStyle::Inherit,
            attributes: BlockMemberAttributes::Inherit,
            source: BlockMemberSource::Inline {
                geometry: GeometryObject::Point {
                    position: Position {
                        x: 1.0,
                        y: 2.0,
                        z: None,
                    },
                },
            },
        }
    }

    fn block_definition(id: &str, members: Vec<BlockMember>) -> BlockDefinition {
        BlockDefinition {
            schema_id: BLOCK_DEFINITION_SCHEMA_ID.to_owned(),
            definition_id: id.to_owned(),
            content_hash: hash("unsealed"),
            placement_composition: BlockPlacementComposition::InstanceThenMember,
            members,
        }
        .seal()
        .unwrap()
    }

    #[test]
    fn block_placement_composes_instance_before_member() {
        let mut instance = Transform3d::IDENTITY;
        instance.0[12] = 10.0;
        let mut member = Transform3d::IDENTITY;
        member.0[0] = 2.0;
        member.0[13] = 5.0;

        let composed = compose_block_member_placement(instance, member);

        assert!((composed.0[0] - 2.0).abs() <= f64::EPSILON);
        assert!((composed.0[12] - 10.0).abs() <= f64::EPSILON);
        assert!((composed.0[13] - 5.0).abs() <= f64::EPSILON);
    }

    #[test]
    fn block_definition_validates_inline_and_entity_members() {
        let entity = entity_ref("entity-1");
        let mut definition = block_definition(
            "definition-1",
            vec![
                point_member("inline"),
                BlockMember {
                    member_id: "linked".to_owned(),
                    placement: Transform3d::IDENTITY,
                    style: BlockMemberStyle::Inherit,
                    attributes: BlockMemberAttributes::Inherit,
                    source: BlockMemberSource::EntityReference {
                        entity: entity.clone(),
                    },
                },
            ],
        );
        definition.content_hash = definition.computed_content_hash().unwrap();

        assert_eq!(
            validate_block_definition_set(&[definition], &[entity], &[], &[]),
            Ok(())
        );
    }

    #[test]
    fn block_definition_validates_exact_typed_style_and_attribute_inheritance() {
        let style = CanonicalResourceRef {
            resource_id: "marker-style".to_owned(),
            schema_id: "hcad.resource.render-style@1".to_owned(),
            content_hash: hash("marker-style"),
        };
        let mut member = point_member("marker");
        member.style = BlockMemberStyle::Resource {
            style: style.clone(),
        };
        member.attributes = BlockMemberAttributes::Replace {
            attributes_ref: hash("marker-attributes"),
        };
        let definition = block_definition("typed-marker", vec![member]);

        assert_eq!(
            validate_block_definition_set(
                &[definition.clone()],
                &[],
                &[style.clone()],
                &[hash("marker-attributes")],
            ),
            Ok(())
        );
        assert_eq!(
            validate_block_definition_set(&[definition.clone()], &[], &[style.clone()], &[]),
            Err(CanonicalResourceValidationError::MissingReference)
        );
        let stale_style = CanonicalResourceRef {
            content_hash: hash("stale-marker-style"),
            ..style
        };
        assert_eq!(
            validate_block_definition_set(
                &[definition],
                &[],
                &[stale_style],
                &[hash("marker-attributes")],
            ),
            Err(CanonicalResourceValidationError::ReferenceVersionMismatch)
        );
    }

    #[test]
    fn nested_block_rejects_an_unknown_stable_member_override() {
        let child = block_definition("child", vec![point_member("known-member")]);
        let parent = block_definition(
            "parent",
            vec![BlockMember {
                member_id: "child-instance".to_owned(),
                placement: Transform3d::IDENTITY,
                style: BlockMemberStyle::Inherit,
                attributes: BlockMemberAttributes::Inherit,
                source: BlockMemberSource::Inline {
                    geometry: GeometryObject::Block {
                        instance: Box::new(BlockInstanceGeometry {
                            definition_id: child.definition_id.clone(),
                            definition_hash: child.content_hash.clone(),
                            placement: Transform3d::IDENTITY,
                            overrides: Some(BlockInstanceOverrides {
                                style: BlockMemberStyle::Inherit,
                                attributes: BlockMemberAttributes::Inherit,
                                members: vec![BlockMemberOverride {
                                    member_id: "missing-member".to_owned(),
                                    style: BlockMemberStyle::Inherit,
                                    attributes: BlockMemberAttributes::Inherit,
                                }],
                            }),
                        }),
                    },
                },
            }],
        );

        assert_eq!(
            validate_block_definition_set(&[child, parent], &[], &[], &[]),
            Err(CanonicalResourceValidationError::MissingReference)
        );
    }

    #[test]
    fn block_definitions_can_capture_multiple_immutable_revisions_of_one_entity() {
        let old = entity_ref("survey-point");
        let mut current = old.clone();
        current.revision += 1;
        current.version_hash = hash("survey-point-current");
        let referencing = |definition_id: &str, member_id: &str, entity: EntityVersionRef| {
            block_definition(
                definition_id,
                vec![BlockMember {
                    member_id: member_id.to_owned(),
                    placement: Transform3d::IDENTITY,
                    style: BlockMemberStyle::Inherit,
                    attributes: BlockMemberAttributes::Inherit,
                    source: BlockMemberSource::EntityReference { entity },
                }],
            )
        };

        assert_eq!(
            validate_block_definition_set(
                &[
                    referencing("old-marker", "old", old.clone()),
                    referencing("current-marker", "current", current.clone()),
                ],
                &[old, current],
                &[],
                &[],
            ),
            Ok(())
        );
    }

    #[test]
    fn block_definition_set_retains_multiple_revisions_of_one_stable_definition_id() {
        let old = block_definition("marker", vec![point_member("old-point")]);
        let current = block_definition("marker", vec![point_member("current-point")]);

        assert_ne!(old.content_hash, current.content_hash);
        assert_eq!(
            validate_block_definition_set(&[old, current], &[], &[], &[]),
            Ok(())
        );
    }

    #[test]
    fn block_definition_rejects_stale_revision_before_recursive_expansion() {
        let mut left = block_definition("left", vec![]);
        let mut right = block_definition("right", vec![]);
        left.members.push(BlockMember {
            member_id: "right-instance".to_owned(),
            placement: Transform3d::IDENTITY,
            style: BlockMemberStyle::Inherit,
            attributes: BlockMemberAttributes::Inherit,
            source: BlockMemberSource::Inline {
                geometry: GeometryObject::Block {
                    instance: Box::new(BlockInstanceGeometry {
                        definition_id: "right".to_owned(),
                        definition_hash: right.content_hash.clone(),
                        placement: Transform3d::IDENTITY,
                        overrides: None,
                    }),
                },
            },
        });
        left = left.seal().unwrap();
        right.members.push(BlockMember {
            member_id: "left-instance".to_owned(),
            placement: Transform3d::IDENTITY,
            style: BlockMemberStyle::Inherit,
            attributes: BlockMemberAttributes::Inherit,
            source: BlockMemberSource::Inline {
                geometry: GeometryObject::Block {
                    instance: Box::new(BlockInstanceGeometry {
                        definition_id: "left".to_owned(),
                        definition_hash: left.content_hash.clone(),
                        placement: Transform3d::IDENTITY,
                        overrides: None,
                    }),
                },
            },
        });
        right = right.seal().unwrap();
        left.members[0] = BlockMember {
            member_id: "right-instance".to_owned(),
            placement: Transform3d::IDENTITY,
            style: BlockMemberStyle::Inherit,
            attributes: BlockMemberAttributes::Inherit,
            source: BlockMemberSource::Inline {
                geometry: GeometryObject::Block {
                    instance: Box::new(BlockInstanceGeometry {
                        definition_id: "right".to_owned(),
                        definition_hash: right.content_hash.clone(),
                        placement: Transform3d::IDENTITY,
                        overrides: None,
                    }),
                },
            },
        };
        left = left.seal().unwrap();
        assert_eq!(
            validate_block_definition_set(&[left, right], &[], &[], &[]),
            Err(CanonicalResourceValidationError::ReferenceVersionMismatch)
        );
    }

    #[test]
    fn material_requires_exact_texture_revision() {
        let texture = TextureResource {
            schema_id: TEXTURE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "texture-1".to_owned(),
            content_hash: hash("unsealed"),
            pixels: geometry_resource("image/png"),
            color_space: TextureColorSpace::Srgb,
            wrap_u: TextureWrapMode::Repeat,
            wrap_v: TextureWrapMode::Repeat,
            mag_filter: TextureFilter::Linear,
            min_filter: TextureFilter::Linear,
        }
        .seal()
        .unwrap();
        let material = MaterialResource {
            schema_id: MATERIAL_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "material-1".to_owned(),
            content_hash: hash("unsealed"),
            name: None,
            base_color: LinearRgba {
                red: 1.0,
                green: 1.0,
                blue: 1.0,
                alpha: 1.0,
            },
            emissive: [0.0; 3],
            metallic: 0.0,
            roughness: 0.5,
            alpha_mode: MaterialAlphaMode::Opaque,
            alpha_cutoff: None,
            double_sided: false,
            texture_bindings: vec![TextureResourceBinding {
                slot: MaterialTextureSlot::BaseColor,
                texture: texture.resource_ref(),
                texture_coordinate_set: 0,
                transform: None,
            }],
        }
        .seal()
        .unwrap();

        assert_eq!(validate_texture_resource(&texture), Ok(()));
        assert_eq!(
            validate_material_resource(&material, &[texture.resource_ref()]),
            Ok(())
        );
        assert_eq!(
            validate_material_resource(&material, &[]),
            Err(CanonicalResourceValidationError::MissingReference)
        );
    }

    #[test]
    fn presentation_resources_validate_as_independent_content_addresses() {
        let line_type = LineTypeResource {
            schema_id: LINE_TYPE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "line-type-1".to_owned(),
            content_hash: hash("unsealed"),
            name: Some("Dash dot".to_owned()),
            pattern: LineTypePattern::Repeating {
                elements: vec![
                    LineTypeElement::Dash { length: 2.0 },
                    LineTypeElement::Gap { length: 1.0 },
                    LineTypeElement::Dot,
                    LineTypeElement::Gap { length: 1.0 },
                ],
            },
        }
        .seal()
        .unwrap();
        let hatch = HatchPatternResource {
            schema_id: HATCH_PATTERN_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "hatch-1".to_owned(),
            content_hash: hash("unsealed"),
            name: Some("Diagonal".to_owned()),
            pattern: HatchPatternKind::Lines {
                lines: vec![HatchPatternLine {
                    angle: std::f64::consts::FRAC_PI_4,
                    origin: [0.0, 0.0],
                    offset: [0.0, 1.0],
                    dash_pattern: vec![],
                }],
            },
        }
        .seal()
        .unwrap();
        let style = AnnotationStyleResource {
            schema_id: ANNOTATION_STYLE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "annotation-1".to_owned(),
            content_hash: hash("unsealed"),
            name: Some("Survey".to_owned()),
            font: geometry_resource("font/woff2"),
            text_height: 0.25,
            color: LinearRgba {
                red: 0.2,
                green: 0.4,
                blue: 0.8,
                alpha: 1.0,
            },
            line_type: Some(line_type.resource_ref()),
            terminator: AnnotationTerminator::ClosedArrow,
            terminator_size: 0.1,
            decimal_places: 3,
            unit_suffix: Some(" m".to_owned()),
        }
        .seal()
        .unwrap();

        assert_eq!(validate_line_type_resource(&line_type), Ok(()));
        assert_eq!(
            serde_json::to_value(&line_type.pattern).unwrap(),
            serde_json::json!({
                "kind": "repeating",
                "elements": [
                    { "kind": "dash", "length": 2.0 },
                    { "kind": "gap", "length": 1.0 },
                    { "kind": "dot" },
                    { "kind": "gap", "length": 1.0 }
                ]
            })
        );
        assert_eq!(validate_hatch_pattern_resource(&hatch), Ok(()));
        assert_eq!(
            validate_annotation_style_resource(&style, &[line_type.resource_ref()]),
            Ok(())
        );
        assert_eq!(
            validate_annotation_style_resource(&style, &[]),
            Err(CanonicalResourceValidationError::MissingReference)
        );
    }

    #[test]
    fn hatch_rejects_offsets_parallel_to_the_repeated_line() {
        let hatch = HatchPatternResource {
            schema_id: HATCH_PATTERN_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "parallel-offset".to_owned(),
            content_hash: hash("unsealed"),
            name: None,
            pattern: HatchPatternKind::Lines {
                lines: vec![HatchPatternLine {
                    angle: 0.0,
                    origin: [0.0, 0.0],
                    offset: [1.0, 0.0],
                    dash_pattern: Vec::new(),
                }],
            },
        };
        let hatch = hatch.seal().expect("content address");
        assert_eq!(
            validate_hatch_pattern_resource(&hatch),
            Err(CanonicalResourceValidationError::InvalidNumber)
        );
    }

    #[test]
    fn network_validates_references_and_cycle_policy() {
        let entities = ["n1", "n2", "n3", "p1", "p2", "p3", "e1", "e2", "e3"]
            .map(|id| EntityId(id.to_owned()));
        let mut topology = NetworkTopology {
            schema_id: NETWORK_TOPOLOGY_SCHEMA_ID.to_owned(),
            topology_id: "network-1".to_owned(),
            content_hash: hash("unsealed"),
            cycle_policy: NetworkCyclePolicy::AcyclicUndirectedProjection,
            nodes: vec![
                NetworkNode {
                    node_id: "node-1".to_owned(),
                    entity_id: entities[0].clone(),
                },
                NetworkNode {
                    node_id: "node-2".to_owned(),
                    entity_id: entities[1].clone(),
                },
                NetworkNode {
                    node_id: "node-3".to_owned(),
                    entity_id: entities[2].clone(),
                },
            ],
            ports: vec![
                NetworkPort {
                    port_id: "port-1".to_owned(),
                    node_id: "node-1".to_owned(),
                    entity_id: entities[3].clone(),
                },
                NetworkPort {
                    port_id: "port-2".to_owned(),
                    node_id: "node-2".to_owned(),
                    entity_id: entities[4].clone(),
                },
                NetworkPort {
                    port_id: "port-3".to_owned(),
                    node_id: "node-3".to_owned(),
                    entity_id: entities[5].clone(),
                },
            ],
            edges: vec![
                NetworkEdge {
                    edge_id: "edge-1".to_owned(),
                    entity_id: entities[6].clone(),
                    from_port_id: "port-1".to_owned(),
                    to_port_id: "port-2".to_owned(),
                    directed: false,
                },
                NetworkEdge {
                    edge_id: "edge-2".to_owned(),
                    entity_id: entities[7].clone(),
                    from_port_id: "port-2".to_owned(),
                    to_port_id: "port-3".to_owned(),
                    directed: false,
                },
            ],
        }
        .seal()
        .unwrap();
        assert_eq!(validate_network_topology(&topology, &entities), Ok(()));

        topology.edges.push(NetworkEdge {
            edge_id: "edge-3".to_owned(),
            entity_id: entities[8].clone(),
            from_port_id: "port-3".to_owned(),
            to_port_id: "port-1".to_owned(),
            directed: false,
        });
        topology = topology.seal().unwrap();
        assert_eq!(
            validate_network_topology(&topology, &entities),
            Err(CanonicalResourceValidationError::CyclicTopology)
        );
    }

    #[test]
    fn component_hash_and_unknown_field_are_strict() {
        let component = BimClassificationComponent {
            schema_id: BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID.to_owned(),
            content_hash: hash("unsealed"),
            classifications: vec![BimClassification {
                system: "IFC 4.3".to_owned(),
                code: "IfcPipeSegment".to_owned(),
                predefined_type: Some("RIGIDSEGMENT".to_owned()),
            }],
        }
        .seal()
        .unwrap();
        assert_eq!(validate_bim_classification_component(&component), Ok(()));

        let mut tampered = component.clone();
        tampered.classifications[0].code = "IfcWall".to_owned();
        assert_eq!(
            validate_bim_classification_component(&tampered),
            Err(CanonicalResourceValidationError::InvalidContentHash)
        );

        let mut value = serde_json::to_value(component).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unknown".to_owned(), serde_json::json!(true));
        assert!(serde_json::from_value::<BimClassificationComponent>(value).is_err());

        let mut nested = serde_json::json!({
            "schemaId": BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID,
            "contentHash": hash("nested"),
            "classifications": [{
                "system": "IFC 4.3",
                "code": "IfcPipeSegment",
                "predefinedType": null,
                "unknown": true
            }]
        });
        assert!(serde_json::from_value::<BimClassificationComponent>(nested.take()).is_err());
    }

    #[test]
    fn point_cloud_display_is_bounded_and_strict() {
        let display = PointCloudDisplayStyle::release_05_default();
        assert_eq!(display.validate(), Ok(()));
        assert_eq!(display.point_size_pixels, 2.0);
        assert!(display
            .classes
            .iter()
            .any(|item| item.code == 2 && item.name == "Ground"));

        let mut invalid = display.clone();
        invalid.point_size_pixels = 8.5;
        assert_eq!(
            invalid.validate(),
            Err(CanonicalResourceValidationError::InvalidNumber)
        );
        let mut duplicate = display;
        duplicate.classes.push(duplicate.classes[0].clone());
        assert_eq!(
            duplicate.validate(),
            Err(CanonicalResourceValidationError::DuplicateIdentifier)
        );
    }
}
