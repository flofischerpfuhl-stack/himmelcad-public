//! Release 0.5 data-model admissions from ADR 0031.
//!
//! These contracts are deliberately producer-narrow. Unknown future versions
//! are retained as opaque bytes for read-only forwarding, while writes fail
//! closed. Absence never causes synthesis.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::entity::EntityId;
use crate::entity_model::{Position, Transform3d, Vector3};
use crate::hash::ObjectHash;

pub const MEASUREMENT_SCHEMA_ID: &str = "hcad.measurement@1";
pub const SNAPSHOT_MARKER_SCHEMA_ID: &str = "hcad.snapshot-marker@1";
pub const DERIVED_RECIPE_SCHEMA_ID: &str = "hcad.derived-recipe@1";
pub const MESH_SOURCE_ROLES_SCHEMA_ID: &str = "hcad.mesh-source-roles@1";
pub const POINT_ACQUISITION_SCHEMA_ID: &str = "hcad.component.point-acquisition@1";
pub const SUPPORT_ROLE_SCHEMA_ID: &str = "hcad.component.support-role@1";
pub const CURVE_SUBENTITY_REF_SCHEMA_ID: &str = "hcad.curve-subentity-ref@1";
pub const LOCAL_HISTORY_SCHEMA_ID: &str = "hcad.local-history@1";
pub const VIEW_STATE_SCHEMA_ID: &str = "himmelcad.view-state";
pub const RELEASE_05_SCHEMA_VERSION: u32 = 1;

const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MeasurementKindV1 {
    Point,
    Distance,
    HeightDifference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MeasurementMetricV1 {
    Horizontal,
    Spatial,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "binding",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "binding",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MeasurementAnchorV1 {
    Fixed {
        position: Position,
    },
    Attached {
        entity_id: EntityId,
        #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
        expected_revision: u64,
        expected_version_hash: ObjectHash,
        provider_id: String,
        representation_id: String,
        primitive_address: String,
        source_parameter: Option<f64>,
        exact_source_position: Position,
        offset: Vector3,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "state",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MeasurementVerificationV1 {
    Verified,
    Unresolved { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasurementResultCacheV1 {
    pub input_hash: ObjectHash,
    pub algorithm_id: String,
    pub algorithm_version: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasurementV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub measurement_kind: MeasurementKindV1,
    pub metric: Option<MeasurementMetricV1>,
    pub anchors: Vec<MeasurementAnchorV1>,
    pub layer_id: EntityId,
    pub visible: bool,
    pub creation_view_id: Option<String>,
    pub provenance: String,
    pub verification: MeasurementVerificationV1,
    pub result_cache: Option<MeasurementResultCacheV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SnapshotMarkerKindV1 {
    Manual,
    SessionStart,
    PreRestore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SnapshotOriginV1 {
    Ui,
    Sdk,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SnapshotRetentionV1 {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotMarkerV1 {
    pub schema_id: String,
    pub schema_version: u32,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub marked_generation: u64,
    pub marker_kind: SnapshotMarkerKindV1,
    pub created_at: String,
    pub origin: SnapshotOriginV1,
    pub restore_of: Option<EntityId>,
    pub retention: SnapshotRetentionV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum DerivedRecipeStateV1 {
    LinkedCurrent,
    LinkedStale,
    Regenerating,
    Detached,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedSourceV1 {
    pub entity_id: EntityId,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub revision: u64,
    pub content_hash: ObjectHash,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub placement_revision: u64,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedOutputV1 {
    pub slot_id: String,
    pub role: String,
    pub output_id: EntityId,
    pub type_id: String,
    pub locator: String,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub current_revision: u64,
    pub current_content_hash: Option<ObjectHash>,
    pub status: DerivedOutputStatusV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DerivedOutputStatusV1 {
    Present,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedSuccessOutputV1 {
    pub slot_id: String,
    pub output_id: EntityId,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub revision: u64,
    pub content_hash: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedLastSuccessV1 {
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub generation: u64,
    pub source_fingerprint: ObjectHash,
    pub outputs: Vec<DerivedSuccessOutputV1>,
    pub completed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedLastErrorV1 {
    pub code: String,
    pub phase: String,
    pub message_key: String,
    pub source_refs: Vec<EntityId>,
    pub error_list_ref: Option<ObjectHash>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum DerivedDetachCauseV1 {
    Manual,
    SourceMissing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedDetachV1 {
    pub cause: DerivedDetachCauseV1,
    pub source_refs: Vec<EntityId>,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub detached_at_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedRecipeV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub recipe_id: String,
    pub recipe_kind: String,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub generation: u64,
    pub state: DerivedRecipeStateV1,
    pub output_group_id: EntityId,
    pub outputs: Vec<DerivedOutputV1>,
    pub sources: Vec<DerivedSourceV1>,
    pub parameter_type_id: String,
    #[cfg_attr(feature = "ts-bindings", ts(type = "unknown"))]
    pub parameters: serde_json::Value,
    pub algorithm_id: String,
    pub algorithm_version: String,
    pub dependency_recipe_ids: Vec<String>,
    pub stale_causes: Vec<String>,
    pub last_success: DerivedLastSuccessV1,
    pub last_error: Option<DerivedLastErrorV1>,
    pub detach: Option<DerivedDetachV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum MeshSourceRoleKindV1 {
    Points,
    Breakline,
    FormLine,
    OuterBoundary,
    Hole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeshSourceRoleV1 {
    pub source: DerivedSourceV1,
    pub placement: Transform3d,
    pub role: MeshSourceRoleKindV1,
    pub sampling_tolerance: Option<f64>,
    pub sampling_hash: Option<ObjectHash>,
    pub boundary_hash: Option<ObjectHash>,
    pub exclusion_hashes: Vec<ObjectHash>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeshSourceRolesV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub resource_id: String,
    pub content_hash: ObjectHash,
    pub roles: Vec<MeshSourceRoleV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum PointAcquisitionKindV1 {
    Pick,
    Typed,
    ManualEstimate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AcquisitionTruthV1 {
    Exact,
    Typed,
    Estimated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointAcquisitionV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub acquisition: PointAcquisitionKindV1,
    pub final_coordinate: Position,
    pub input_mode: String,
    pub truth: AcquisitionTruthV1,
    pub source_entity_id: Option<EntityId>,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number | null"))]
    pub source_revision: Option<u64>,
    pub provider_id: Option<String>,
    pub primitive_address: Option<String>,
    pub constraint: Option<String>,
    pub estimate_confirmed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SupportRoleKindV1 {
    HelperPoint,
    DefiningPoint,
    DefiningCurve,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportDefinitionV1 {
    pub entity_id: EntityId,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub revision: u64,
    pub semantic_role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportRoleV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub role_kind: SupportRoleKindV1,
    pub defines: Vec<SupportDefinitionV1>,
    pub provenance: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurveSubentityRefV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub parent_id: EntityId,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub parent_revision: u64,
    pub topology_kind: String,
    pub stable_member_id: String,
    pub directed_parameter_interval: [f64; 2],
    pub loop_id: Option<String>,
    pub use_id: Option<String>,
    pub semantic_hash: ObjectHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LocalHistoryKindV1 {
    Selection,
    Display,
    Camera,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalHistoryEntryV1 {
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub sequence: u64,
    #[cfg_attr(feature = "ts-bindings", ts(type = "unknown"))]
    pub before: serde_json::Value,
    #[cfg_attr(feature = "ts-bindings", ts(type = "unknown"))]
    pub after: serde_json::Value,
    pub gesture_session: Option<String>,
    pub coalescing_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalHistoryV1 {
    pub schema_id: String,
    pub schema_version: u32,
    pub project_id: String,
    pub stream_kind: LocalHistoryKindV1,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub local_sequence: u64,
    pub cursor: u32,
    pub head: u32,
    pub entries: Vec<LocalHistoryEntryV1>,
    pub checksum: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewClipRefV2 {
    pub entity_id: EntityId,
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub expected_revision: u64,
    pub active: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ViewColorModeOverrideV2 {
    Follow,
    Mode {
        mode: String,
        #[cfg_attr(feature = "ts-bindings", ts(type = "unknown"))]
        params: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewPresentationV2 {
    pub background: String,
    pub render_style: String,
    pub show_grid: bool,
    pub show_axes: bool,
    pub show_selection_outline: bool,
    pub color_mode_override: ViewColorModeOverrideV2,
    pub point_size_multiplier: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewStateV2 {
    pub schema: String,
    pub version: u32,
    #[cfg_attr(feature = "ts-bindings", ts(type = "unknown"))]
    pub camera: serde_json::Value,
    pub navigation_mode: String,
    pub hidden_entity_ids: Vec<EntityId>,
    pub session_hidden_entity_ids: Vec<EntityId>,
    pub selected_entity_ids: Vec<EntityId>,
    pub clip_refs: Vec<ViewClipRefV2>,
    pub presentation: ViewPresentationV2,
}

/// Independent project-persisted records. Optional/empty fields are the lazy
/// migration baseline and serialize only after the corresponding state changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release05ProjectRecords {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub snapshots: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipes: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_source_roles: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_state: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub local_histories: BTreeMap<String, serde_json::Value>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompatibilityRead<T> {
    Supported {
        value: T,
        bytes: Vec<u8>,
    },
    UnsupportedReadOnly {
        schema_id: String,
        version: u64,
        bytes: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AdmissionError {
    #[error("admitted schema payload is malformed")]
    Malformed,
    #[error("schema identifier is unsupported")]
    UnsupportedSchema,
    #[error("schema version is unsupported for writable open")]
    UnsupportedVersion,
    #[error("admitted schema invariant is invalid")]
    Invalid,
    #[error("referenced entity revision is stale")]
    StaleReference,
    #[error("derived recipe dependency graph contains a cycle")]
    RecipeCycle,
    #[error("local history checksum or head is invalid")]
    CorruptLocalHistory,
}

pub(crate) fn validate_measurement_entity(value: &MeasurementV1) -> Result<(), AdmissionError> {
    if value.schema_id != MEASUREMENT_SCHEMA_ID
        || value.schema_version != 1
        || value.layer_id.0.trim().is_empty()
        || value.provenance.trim().is_empty()
    {
        return Err(AdmissionError::Invalid);
    }
    let required = match value.measurement_kind {
        MeasurementKindV1::Point => 1,
        MeasurementKindV1::Distance | MeasurementKindV1::HeightDifference => 2,
    };
    if value.anchors.len() != required {
        return Err(AdmissionError::Invalid);
    }
    match value.measurement_kind {
        MeasurementKindV1::Point if value.metric.is_some() => return Err(AdmissionError::Invalid),
        MeasurementKindV1::Distance if value.metric.is_none() => {
            return Err(AdmissionError::Invalid)
        }
        MeasurementKindV1::HeightDifference if value.metric.is_some() => {
            return Err(AdmissionError::Invalid)
        }
        _ => {}
    }
    let needs_z = value.measurement_kind == MeasurementKindV1::HeightDifference
        || value.metric == Some(MeasurementMetricV1::Spatial);
    for anchor in &value.anchors {
        let position = match anchor {
            MeasurementAnchorV1::Fixed { position } => position,
            MeasurementAnchorV1::Attached {
                entity_id,
                expected_revision,
                provider_id,
                representation_id,
                primitive_address,
                exact_source_position,
                source_parameter,
                offset,
                ..
            } => {
                if entity_id.0.trim().is_empty()
                    || *expected_revision > JS_SAFE_INTEGER
                    || provider_id.trim().is_empty()
                    || representation_id.trim().is_empty()
                    || primitive_address.trim().is_empty()
                    || source_parameter.is_some_and(|v| !v.is_finite())
                    || !finite_vec3(offset)
                {
                    return Err(AdmissionError::Invalid);
                }
                exact_source_position
            }
        };
        if !finite_position(position) || (needs_z && position.z.is_none()) {
            return Err(AdmissionError::Invalid);
        }
    }
    Ok(())
}

fn finite_position(value: &Position) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_none_or(f64::is_finite)
}

fn finite_vec3(value: &Vector3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}
