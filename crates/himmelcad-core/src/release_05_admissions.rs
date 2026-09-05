//! Release 0.5 data-model admissions from ADR 0031.
//!
//! These contracts are deliberately producer-narrow. Unknown future versions
//! are retained as opaque bytes for read-only forwarding, while writes fail
//! closed. Absence never causes synthesis.

use std::collections::{BTreeMap, BTreeSet};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
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

pub fn read_additive<T: DeserializeOwned>(
    bytes: &[u8],
    expected_schema: &str,
    writable: bool,
) -> Result<CompatibilityRead<T>, AdmissionError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| AdmissionError::Malformed)?;
    let schema_id = value
        .get("schemaId")
        .or_else(|| value.get("schema"))
        .and_then(serde_json::Value::as_str)
        .ok_or(AdmissionError::Malformed)?;
    let version = value
        .get("schemaVersion")
        .or_else(|| value.get("version"))
        .and_then(serde_json::Value::as_u64)
        .ok_or(AdmissionError::Malformed)?;
    if schema_id != expected_schema {
        return Err(AdmissionError::UnsupportedSchema);
    }
    if version != 1 && !(expected_schema == VIEW_STATE_SCHEMA_ID && version == 2) {
        if writable {
            return Err(AdmissionError::UnsupportedVersion);
        }
        return Ok(CompatibilityRead::UnsupportedReadOnly {
            schema_id: schema_id.to_owned(),
            version,
            bytes: bytes.to_vec(),
        });
    }
    serde_json::from_value(value)
        .map(|value| CompatibilityRead::Supported {
            value,
            bytes: bytes.to_vec(),
        })
        .map_err(|_| AdmissionError::Malformed)
}

pub fn validate_measurement(value: &MeasurementV1) -> Result<(), AdmissionError> {
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

pub fn validate_snapshot_marker(value: &SnapshotMarkerV1) -> Result<(), AdmissionError> {
    if value.schema_id != SNAPSHOT_MARKER_SCHEMA_ID
        || value.schema_version != 1
        || value.marked_generation > JS_SAFE_INTEGER
        || value.created_at.trim().is_empty()
        || (value.marker_kind == SnapshotMarkerKindV1::PreRestore && value.restore_of.is_none())
        || (value.marker_kind != SnapshotMarkerKindV1::PreRestore && value.restore_of.is_some())
    {
        return Err(AdmissionError::Invalid);
    }
    Ok(())
}

pub fn validate_support_role(value: &SupportRoleV1) -> Result<(), AdmissionError> {
    if value.schema_id != SUPPORT_ROLE_SCHEMA_ID
        || value.schema_version != 1
        || value.provenance.trim().is_empty()
        || value.defines.iter().any(|definition| {
            definition.entity_id.0.trim().is_empty()
                || definition.revision > JS_SAFE_INTEGER
                || definition.semantic_role.trim().is_empty()
        })
    {
        return Err(AdmissionError::Invalid);
    }
    Ok(())
}

pub fn validate_point_acquisition(value: &PointAcquisitionV1) -> Result<(), AdmissionError> {
    if value.schema_id != POINT_ACQUISITION_SCHEMA_ID
        || value.schema_version != 1
        || !finite_position(&value.final_coordinate)
    {
        return Err(AdmissionError::Invalid);
    }
    let valid = match value.acquisition {
        PointAcquisitionKindV1::Pick => {
            value.truth == AcquisitionTruthV1::Exact
                && value.source_entity_id.is_some()
                && value.source_revision.is_some()
                && value
                    .provider_id
                    .as_ref()
                    .is_some_and(|v| !v.trim().is_empty())
                && !value.estimate_confirmed
        }
        PointAcquisitionKindV1::Typed => {
            value.truth == AcquisitionTruthV1::Typed
                && value.source_entity_id.is_none()
                && value.source_revision.is_none()
                && !value.estimate_confirmed
        }
        PointAcquisitionKindV1::ManualEstimate => {
            value.truth == AcquisitionTruthV1::Estimated
                && value.source_entity_id.is_none()
                && value.source_revision.is_none()
                && value.estimate_confirmed
        }
    };
    valid.then_some(()).ok_or(AdmissionError::Invalid)
}

pub fn validate_recipe(
    recipe: &DerivedRecipeV1,
    dependencies: &BTreeMap<String, Vec<String>>,
) -> Result<(), AdmissionError> {
    if recipe.schema_id != DERIVED_RECIPE_SCHEMA_ID
        || recipe.schema_version != 1
        || recipe.generation == 0
        || recipe.generation > JS_SAFE_INTEGER
        || recipe.recipe_id.trim().is_empty()
        || recipe.outputs.is_empty()
        || recipe.sources.is_empty()
    {
        return Err(AdmissionError::Invalid);
    }
    const ADMITTED_KINDS: [&str; 3] = [
        "hcad.mesh.surface@1",
        "hcad.mesh.region-repair@1",
        "hcad.mesh.simplify-terrain@1",
    ];
    if !ADMITTED_KINDS.contains(&recipe.recipe_kind.as_str()) {
        return Err(AdmissionError::UnsupportedSchema);
    }
    let mut slots = BTreeSet::new();
    let mut outputs = BTreeSet::new();
    for output in &recipe.outputs {
        if !slots.insert(&output.slot_id)
            || !outputs.insert(&output.output_id.0)
            || (output.status == DerivedOutputStatusV1::Present)
                != output.current_content_hash.is_some()
        {
            return Err(AdmissionError::Invalid);
        }
    }
    if has_recipe_cycle(&recipe.recipe_id, dependencies) {
        return Err(AdmissionError::RecipeCycle);
    }
    Ok(())
}

pub fn validate_mesh_source_roles(value: &MeshSourceRolesV1) -> Result<(), AdmissionError> {
    if value.schema_id != MESH_SOURCE_ROLES_SCHEMA_ID
        || value.schema_version != 1
        || value.resource_id.trim().is_empty()
    {
        return Err(AdmissionError::Invalid);
    }
    let mut unsealed = value.clone();
    unsealed.content_hash = ObjectHash::of_bytes(b"");
    let bytes = serde_json::to_vec(&unsealed).map_err(|_| AdmissionError::Invalid)?;
    (ObjectHash::of_bytes(&bytes) == value.content_hash)
        .then_some(())
        .ok_or(AdmissionError::Invalid)
}

pub fn seal_mesh_source_roles(
    mut value: MeshSourceRolesV1,
) -> Result<MeshSourceRolesV1, AdmissionError> {
    value.content_hash = ObjectHash::of_bytes(b"");
    value.content_hash =
        ObjectHash::of_bytes(&serde_json::to_vec(&value).map_err(|_| AdmissionError::Invalid)?);
    validate_mesh_source_roles(&value)?;
    Ok(value)
}

pub fn validate_curve_ref(value: &CurveSubentityRefV1) -> Result<(), AdmissionError> {
    if value.schema_id != CURVE_SUBENTITY_REF_SCHEMA_ID
        || value.schema_version != 1
        || value.parent_id.0.trim().is_empty()
        || value.stable_member_id.trim().is_empty()
        || value.parent_revision > JS_SAFE_INTEGER
        || value
            .directed_parameter_interval
            .iter()
            .any(|v| !v.is_finite())
        || value.directed_parameter_interval[0] == value.directed_parameter_interval[1]
    {
        return Err(AdmissionError::Invalid);
    }
    Ok(())
}

pub fn resolve_curve_ref(
    token: &CurveSubentityRefV1,
    parent_revision: u64,
    indexed_members: &BTreeMap<String, (ObjectHash, [f64; 2])>,
) -> Result<(), AdmissionError> {
    validate_curve_ref(token)?;
    let Some((semantic_hash, interval)) = indexed_members.get(&token.stable_member_id) else {
        return Err(AdmissionError::StaleReference);
    };
    if semantic_hash != &token.semantic_hash
        || !same_interval(*interval, token.directed_parameter_interval)
        || parent_revision < token.parent_revision
    {
        return Err(AdmissionError::StaleReference);
    }
    Ok(())
}

pub fn local_history_checksum(history: &LocalHistoryV1) -> Result<ObjectHash, AdmissionError> {
    let mut value = history.clone();
    value.checksum = ObjectHash::of_bytes(b"");
    Ok(ObjectHash::of_bytes(
        &serde_json::to_vec(&value).map_err(|_| AdmissionError::Invalid)?,
    ))
}

pub fn validate_local_history(history: &LocalHistoryV1) -> Result<(), AdmissionError> {
    if history.schema_id != LOCAL_HISTORY_SCHEMA_ID
        || history.schema_version != 1
        || history.local_sequence > JS_SAFE_INTEGER
        || history.cursor > history.head
        || usize::try_from(history.head)
            .ok()
            .is_none_or(|head| head > history.entries.len())
        || local_history_checksum(history)? != history.checksum
    {
        return Err(AdmissionError::CorruptLocalHistory);
    }
    Ok(())
}

pub fn seal_local_history(mut history: LocalHistoryV1) -> Result<LocalHistoryV1, AdmissionError> {
    history.checksum = local_history_checksum(&history)?;
    validate_local_history(&history)?;
    Ok(history)
}

pub fn validate_view_state_v2(
    state: &ViewStateV2,
    revisions: &BTreeMap<String, u64>,
) -> Result<(), AdmissionError> {
    if state.schema != VIEW_STATE_SCHEMA_ID
        || state.version != 2
        || !matches!(state.navigation_mode.as_str(), "3d" | "2d" | "2.5d")
        || !state.presentation.point_size_multiplier.is_finite()
        || state.presentation.point_size_multiplier <= 0.0
        || state.presentation.background == "transparent"
    {
        return Err(AdmissionError::Invalid);
    }
    let mut refs = BTreeSet::new();
    for clip in &state.clip_refs {
        if !refs.insert(&clip.entity_id.0)
            || revisions.get(&clip.entity_id.0) != Some(&clip.expected_revision)
        {
            return Err(AdmissionError::StaleReference);
        }
    }
    Ok(())
}

fn has_recipe_cycle(root: &str, graph: &BTreeMap<String, Vec<String>>) -> bool {
    fn visit<'a>(
        node: &'a str,
        graph: &'a BTreeMap<String, Vec<String>>,
        active: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> bool {
        if active.contains(node) {
            return true;
        }
        if done.contains(node) {
            return false;
        }
        active.insert(node);
        if graph
            .get(node)
            .into_iter()
            .flatten()
            .any(|next| visit(next, graph, active, done))
        {
            return true;
        }
        active.remove(node);
        done.insert(node);
        false
    }
    visit(root, graph, &mut BTreeSet::new(), &mut BTreeSet::new())
}

fn finite_position(value: &Position) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_none_or(f64::is_finite)
}
fn finite_vec3(value: &Vector3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}
fn same_interval(a: [f64; 2], b: [f64; 2]) -> bool {
    a == b || (a[0] == b[1] && a[1] == b[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixed(x: f64, y: f64, z: Option<f64>) -> MeasurementAnchorV1 {
        MeasurementAnchorV1::Fixed {
            position: Position { x, y, z },
        }
    }
    fn measurement(
        kind: MeasurementKindV1,
        metric: Option<MeasurementMetricV1>,
        anchors: Vec<MeasurementAnchorV1>,
    ) -> MeasurementV1 {
        MeasurementV1 {
            schema_id: MEASUREMENT_SCHEMA_ID.into(),
            schema_version: 1,
            measurement_kind: kind,
            metric,
            anchors,
            layer_id: EntityId("layer".into()),
            visible: true,
            creation_view_id: Some("view".into()),
            provenance: "ui".into(),
            verification: MeasurementVerificationV1::Verified,
            result_cache: None,
        }
    }

    #[test]
    fn g_s01_1() {
        assert!(validate_measurement(&measurement(
            MeasurementKindV1::Point,
            None,
            vec![fixed(1.0, 2.0, None)]
        ))
        .is_ok());
        assert!(validate_measurement(&measurement(
            MeasurementKindV1::Distance,
            Some(MeasurementMetricV1::Horizontal),
            vec![fixed(0.0, 0.0, None), fixed(3.0, 4.0, None)]
        ))
        .is_ok());
        assert!(validate_measurement(&measurement(
            MeasurementKindV1::Distance,
            Some(MeasurementMetricV1::Spatial),
            vec![fixed(0.0, 0.0, None), fixed(3.0, 4.0, Some(1.0))]
        ))
        .is_err());
        assert!(validate_measurement(&measurement(
            MeasurementKindV1::HeightDifference,
            None,
            vec![fixed(0.0, 0.0, Some(1.0)), fixed(0.0, 0.0, Some(2.0))]
        ))
        .is_ok());
        let deferred =
            br#"{"schemaId":"hcad.measurement@1","schemaVersion":2,"measurementKind":"angle"}"#;
        assert!(matches!(
            read_additive::<MeasurementV1>(deferred, MEASUREMENT_SCHEMA_ID, true),
            Err(AdmissionError::UnsupportedVersion)
        ));
    }

    #[test]
    fn g_s01_3() {
        let old = br#"{"schema":"himmelcad.view-state","version":1,"scopedClips":[]}"#.to_vec();
        let before = ObjectHash::of_bytes(&old);
        let result = read_additive::<serde_json::Value>(&old, VIEW_STATE_SCHEMA_ID, false).unwrap();
        assert!(matches!(result, CompatibilityRead::Supported { bytes, .. } if bytes == old));
        assert_eq!(before, ObjectHash::of_bytes(&old));
        let state = ViewStateV2 {
            schema: VIEW_STATE_SCHEMA_ID.into(),
            version: 2,
            camera: json!({}),
            navigation_mode: "3d".into(),
            hidden_entity_ids: vec![],
            session_hidden_entity_ids: vec![],
            selected_entity_ids: vec![],
            clip_refs: vec![ViewClipRefV2 {
                entity_id: EntityId("box".into()),
                expected_revision: 4,
                active: true,
                locked: true,
            }],
            presentation: ViewPresentationV2 {
                background: "theme".into(),
                render_style: "source".into(),
                show_grid: true,
                show_axes: true,
                show_selection_outline: true,
                color_mode_override: ViewColorModeOverrideV2::Follow,
                point_size_multiplier: 1.0,
            },
        };
        assert!(validate_view_state_v2(&state, &BTreeMap::from([("box".into(), 4)])).is_ok());
        assert_eq!(
            validate_view_state_v2(&state, &BTreeMap::new()),
            Err(AdmissionError::StaleReference)
        );
    }

    #[test]
    fn g_s01_5() {
        let marker = SnapshotMarkerV1 {
            schema_id: SNAPSHOT_MARKER_SCHEMA_ID.into(),
            schema_version: 1,
            marked_generation: 8,
            marker_kind: SnapshotMarkerKindV1::PreRestore,
            created_at: "2026-09-02T00:00:00Z".into(),
            origin: SnapshotOriginV1::System,
            restore_of: Some(EntityId("manual".into())),
            retention: SnapshotRetentionV1::Automatic,
        };
        let bytes = serde_json::to_vec(&marker).unwrap();
        let decoded: SnapshotMarkerV1 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(marker, decoded);
        assert!(validate_snapshot_marker(&marker).is_ok());
    }

    fn recipe() -> DerivedRecipeV1 {
        let hash = ObjectHash::of_bytes(b"x");
        DerivedRecipeV1 {
            schema_id: DERIVED_RECIPE_SCHEMA_ID.into(),
            schema_version: 1,
            recipe_id: "r1".into(),
            recipe_kind: "hcad.mesh.surface@1".into(),
            generation: 1,
            state: DerivedRecipeStateV1::LinkedCurrent,
            output_group_id: EntityId("g".into()),
            outputs: vec![DerivedOutputV1 {
                slot_id: "surface".into(),
                role: "surface".into(),
                output_id: EntityId("out".into()),
                type_id: "hcad.elevation-surface@1".into(),
                locator: "canonical".into(),
                current_revision: 0,
                current_content_hash: Some(hash.clone()),
                status: DerivedOutputStatusV1::Present,
            }],
            sources: vec![DerivedSourceV1 {
                entity_id: EntityId("source".into()),
                revision: 2,
                content_hash: hash.clone(),
                placement_revision: 1,
                role: "points".into(),
            }],
            parameter_type_id: "hcad.mesh.surface-parameters@1".into(),
            parameters: json!({}),
            algorithm_id: "tin".into(),
            algorithm_version: "1".into(),
            dependency_recipe_ids: vec![],
            stale_causes: vec![],
            last_success: DerivedLastSuccessV1 {
                generation: 1,
                source_fingerprint: hash.clone(),
                outputs: vec![DerivedSuccessOutputV1 {
                    slot_id: "surface".into(),
                    output_id: EntityId("out".into()),
                    revision: 0,
                    content_hash: hash,
                }],
                completed_at: "2026-09-02T00:00:00Z".into(),
            },
            last_error: None,
            detach: None,
        }
    }

    #[test]
    fn g_s01_6() {
        assert!(validate_recipe(&recipe(), &BTreeMap::new()).is_ok());
        let graph = BTreeMap::from([
            ("r1".into(), vec!["r2".into()]),
            ("r2".into(), vec!["r1".into()]),
        ]);
        assert_eq!(
            validate_recipe(&recipe(), &graph),
            Err(AdmissionError::RecipeCycle)
        );
        let mut deferred = recipe();
        deferred.recipe_kind = "hcad.draw.offset@1".into();
        assert_eq!(
            validate_recipe(&deferred, &BTreeMap::new()),
            Err(AdmissionError::UnsupportedSchema)
        );
    }

    #[test]
    fn g_s01_7() {
        let typed = PointAcquisitionV1 {
            schema_id: POINT_ACQUISITION_SCHEMA_ID.into(),
            schema_version: 1,
            acquisition: PointAcquisitionKindV1::Typed,
            final_coordinate: Position {
                x: 1.0,
                y: 2.0,
                z: None,
            },
            input_mode: "cartesian".into(),
            truth: AcquisitionTruthV1::Typed,
            source_entity_id: None,
            source_revision: None,
            provider_id: None,
            primitive_address: None,
            constraint: None,
            estimate_confirmed: false,
        };
        assert!(validate_point_acquisition(&typed).is_ok());
        let mut estimate = typed.clone();
        estimate.acquisition = PointAcquisitionKindV1::ManualEstimate;
        estimate.truth = AcquisitionTruthV1::Estimated;
        estimate.estimate_confirmed = true;
        assert!(validate_point_acquisition(&estimate).is_ok());
        let mut invalid = estimate;
        invalid.estimate_confirmed = false;
        assert!(validate_point_acquisition(&invalid).is_err());
        let support = SupportRoleV1 {
            schema_id: SUPPORT_ROLE_SCHEMA_ID.into(),
            schema_version: 1,
            role_kind: SupportRoleKindV1::DefiningCurve,
            defines: vec![SupportDefinitionV1 {
                entity_id: EntityId("surface".into()),
                revision: 1,
                semantic_role: "breakline".into(),
            }],
            provenance: "ui".into(),
        };
        assert!(validate_support_role(&support).is_ok());
    }

    #[test]
    fn g_s01_11() {
        let token = CurveSubentityRefV1 {
            schema_id: CURVE_SUBENTITY_REF_SCHEMA_ID.into(),
            schema_version: 1,
            parent_id: EntityId("curve".into()),
            parent_revision: 2,
            topology_kind: "composite".into(),
            stable_member_id: "m9999".into(),
            directed_parameter_interval: [0.0, 1.0],
            loop_id: None,
            use_id: None,
            semantic_hash: ObjectHash::of_bytes(b"member"),
        };
        let index: BTreeMap<_, _> = (0..10_000)
            .map(|i| {
                (
                    format!("m{i}"),
                    (
                        if i == 9999 {
                            token.semantic_hash.clone()
                        } else {
                            ObjectHash::of_bytes(i.to_string().as_bytes())
                        },
                        [0.0, 1.0],
                    ),
                )
            })
            .collect();
        assert_eq!(resolve_curve_ref(&token, 3, &index), Ok(()));
        assert_eq!(
            resolve_curve_ref(&token, 3, &BTreeMap::new()),
            Err(AdmissionError::StaleReference)
        );
    }

    #[test]
    fn g_s01_12() {
        let baseline = LocalHistoryV1 {
            schema_id: LOCAL_HISTORY_SCHEMA_ID.into(),
            schema_version: 1,
            project_id: "p".into(),
            stream_kind: LocalHistoryKindV1::Selection,
            local_sequence: 1,
            cursor: 1,
            head: 1,
            entries: vec![LocalHistoryEntryV1 {
                sequence: 1,
                before: json!([]),
                after: json!(["e"]),
                gesture_session: Some("g".into()),
                coalescing_key: None,
            }],
            checksum: ObjectHash::of_bytes(b""),
        };
        let valid = seal_local_history(baseline).unwrap();
        assert!(validate_local_history(&valid).is_ok());
        let mut corrupt = valid;
        corrupt.cursor = 2;
        assert_eq!(
            validate_local_history(&corrupt),
            Err(AdmissionError::CorruptLocalHistory)
        );
        let absent = Release05ProjectRecords::default();
        assert_eq!(serde_json::to_string(&absent).unwrap(), "{}");
    }

    #[test]
    fn g_s01_compatibility_round_trip_and_fail_closed() {
        let fixture = br#"{"legacy":true}"#.to_vec();
        let before = ObjectHash::of_bytes(&fixture);
        let records: Release05ProjectRecords = serde_json::from_slice(&fixture).unwrap();
        assert_eq!(
            before,
            ObjectHash::of_bytes(&fixture),
            "passive open must not rewrite fixture bytes"
        );
        assert_eq!(records.extensions.get("legacy"), Some(&json!(true)));
        let unknown = br#"{"schemaId":"hcad.local-history@1","schemaVersion":99,"future":true}"#;
        assert!(
            matches!(read_additive::<LocalHistoryV1>(unknown, LOCAL_HISTORY_SCHEMA_ID, false), Ok(CompatibilityRead::UnsupportedReadOnly { bytes, .. }) if bytes == unknown)
        );
        assert_eq!(
            read_additive::<LocalHistoryV1>(unknown, LOCAL_HISTORY_SCHEMA_ID, true),
            Err(AdmissionError::UnsupportedVersion)
        );
    }
}
