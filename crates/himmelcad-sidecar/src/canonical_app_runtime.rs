//! Shared canonical application control-plane runtime.
//!
//! Desktop UIs and automation clients enter the same dispatcher. The runtime
//! owns the durable project store and never exposes an in-memory-only mutation
//! path.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::app_protocol::{
    read_journal_page, validate_request_envelope, AppDocumentSnapshot, AppJournalReadError,
    AppProtocolEnvelopeError, AppProtocolError, AppProtocolRequest, AppProtocolRequestEnvelope,
    AppProtocolResponse, AppProtocolResponseEnvelope, APP_PROTOCOL_SCHEMA_ID,
};
use himmelcad_core::canonical_document::{
    CanonicalCommandTransaction, CanonicalDocumentError, CanonicalEntityEdit,
    CanonicalEntityMutation, CanonicalJournalEntry, CanonicalJournalEntryKind, EntityVersionRef,
};
use himmelcad_core::canonical_resource_catalog::CanonicalPresentationResourceSet;
use himmelcad_core::canonical_resources::PointCloudDisplayStyle;
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, CurveGeometry, DepthSampling, DepthSemantics,
    ElevationSurfaceGeometry, EntityTypeId, GeometryObject, GeometryResource, OrthoGridMapping,
    Position, RasterConnectivity, RasterImageGeometry, RasterInterpolation, RasterMapping,
    Representation, RepresentationAuthority, RepresentationRole, StreamedGeometry,
    TriangleMeshStorage, Vector3,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::{
    CanonicalRepresentationAdmission, SectionIndexComponentType, SectionPositionComponentType,
    SectionTopologyPartitionManifest,
};
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::property_schema::{
    canonical_entity_property_schema, compile_multi_entity_property_edit, query_properties,
    PropertySchemaError,
};
use himmelcad_core::release_05_admissions::{
    validate_measurement, validate_point_acquisition, validate_snapshot_marker,
    validate_support_role, DerivedSourceV1, MeasurementAnchorV1, MeasurementV1,
    MeshSourceRoleKindV1, MeshSourceRoleV1, MeshSourceRolesV1, PointAcquisitionV1,
    SnapshotMarkerKindV1, SnapshotMarkerV1, SnapshotOriginV1, SnapshotRetentionV1,
    SupportRoleKindV1, SupportRoleV1, MEASUREMENT_SCHEMA_ID, MESH_SOURCE_ROLES_SCHEMA_ID,
    RELEASE_05_SCHEMA_VERSION, SNAPSHOT_MARKER_SCHEMA_ID, SUPPORT_ROLE_SCHEMA_ID,
};
use himmelcad_core::typed_artifact::{TypedArtifactDescriptor, TypedArtifactManifest};
use himmelcad_io::{
    CanonicalImportPackage, CanonicalJsonObject, CanonicalPreparedDataset, CanonicalStagedImport,
    PreparedDatasetArtifact, CANONICAL_IO_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::pointcloud_ground::{PreparedGroundDataset, PreparedGroundResult};
use crate::pointcloud_sampling::{
    PreparedHeightGrid, PreparedSampleResult, RasterAggregation, HEIGHT_GRID_FORMAT_ID,
    RASTERIZE_ALGORITHM_ID, SAMPLE_ALGORITHM_ID,
};
use crate::pointcloud_segment::{PreparedSegmentResult, SEGMENT_ALGORITHM_ID};

use crate::canonical_project_store::{
    CanonicalDurabilityStatus, CanonicalImportCommit, CanonicalImportInventory,
    CanonicalImportProgress, CanonicalImportSourceRoots, CanonicalProjectStore,
    CanonicalProjectStoreError, CanonicalStoredObject,
};
use crate::import_registration_runtime::{
    sample_potree_open_files, ImportRegistrationRuntimeError, PotreeOpenFiles,
    RegistrationSourceSamples,
};

/// Process-internal verified CAS source used by the bounded automation lease
/// runtime. Its path is never serialized.
#[derive(Debug)]
pub struct AutomationObjectSource {
    pub metadata: CanonicalStoredObject,
    pub source: File,
    pub source_entity: Option<himmelcad_core::canonical_document::EntityVersionRef>,
    pub typed_artifact: Option<TypedArtifactDescriptor>,
    pub representation_slot: Option<String>,
    pub geometry_ref: Option<ObjectHash>,
}

/// One process-local owner of the currently open canonical project.
#[derive(Default)]
pub struct CanonicalAppRuntime {
    store: Option<CanonicalProjectStore>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSnapshotSummary {
    pub entity_id: String,
    pub name: String,
    pub marker: SnapshotMarkerV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSnapshotRestoreCommit {
    pub snapshot: CanonicalSnapshotSummary,
    pub journal_entry: CanonicalJournalEntry,
}

const DEFAULT_SESSION_START_SNAPSHOT_RETENTION: usize = 5;
const SESSION_START_SNAPSHOT_RETENTION_ENV: &str = "HCAD_SESSION_START_SNAPSHOT_RETENTION";

const VIEW_BOOKMARK_SCHEMA_ID: &str = "hcad.view-bookmark@1";
const VIEWING_BOX_SCHEMA_ID: &str = "hcad.viewing-box@1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewBookmarkRecord {
    pub schema_id: String,
    pub schema_version: u32,
    pub state: serde_json::Value,
    pub restore_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewBookmarkSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub state: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewBookmarkCommit {
    pub bookmark: CanonicalViewBookmarkSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewingBoxSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub state: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewingBoxCommit {
    pub viewing_box: CanonicalViewingBoxSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewingBoxDelete {
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMeasurementSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub measurement: MeasurementV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMeasurementCommit {
    pub measurement: CanonicalMeasurementSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMeasurementDelete {
    pub journal_entry: CanonicalJournalEntry,
}

const DRAW_CURVE_COMPONENT_SCHEMA_ID: &str = "hcad.draw-curve@1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrawCurveRole {
    Plain,
    Breakline,
    Boundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DrawCurveTool {
    Line,
    Polyline,
    Boundary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawCurveInput {
    pub entity_id: String,
    pub expected_revision: Option<u64>,
    pub name: String,
    pub tool: DrawCurveTool,
    pub role: DrawCurveRole,
    pub closed: bool,
    pub vertices: Vec<Position>,
    pub acquisitions: Vec<PointAcquisitionV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrawCurveComponents {
    schema_id: String,
    schema_version: u32,
    tool: DrawCurveTool,
    role: DrawCurveRole,
    mesh_source_role: Option<String>,
    point_acquisitions: Vec<PointAcquisitionV1>,
    support_role: SupportRoleV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalDrawCurveSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub role: DrawCurveRole,
    pub closed: bool,
    pub vertices: Vec<Position>,
    pub acquisitions: Vec<PointAcquisitionV1>,
    pub admission: CanonicalRepresentationAdmission,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalDrawCurveCommit {
    pub curve: CanonicalDrawCurveSummary,
    pub journal_entry: CanonicalJournalEntry,
}

/// Versioned, path-free description of every live representation that can be
/// reconstructed from the canonical store after process restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalResidencyBootstrap {
    pub schema_version: u32,
    pub generation: u64,
    pub entries: Vec<CanonicalResidencyEntry>,
}

/// One exact live admission plus an optional prepared-dataset inventory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalResidencyEntry {
    pub provider_id: String,
    pub provider_version: String,
    pub admission: CanonicalRepresentationAdmission,
    pub dataset: Option<CanonicalPreparedDataset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point_cloud: Option<CanonicalPointCloudMetadata>,
}

/// Canonical point-cloud metadata needed by the tree, Properties and renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPointCloudMetadata {
    pub point_count: u64,
    pub source_crs: Option<String>,
    pub source_units: Option<String>,
    pub placement_offset: [f64; 3],
    pub display: PointCloudDisplayStyle,
}

/// Exact source capture prepared before a long-running ground job releases the project lock.
#[derive(Debug, Clone)]
pub struct CanonicalGroundSource {
    pub expected: EntityVersionRef,
    pub entity: CanonicalEntity,
    pub representation_slot: String,
    pub input_root: PathBuf,
    pub source_components: serde_json::Value,
    pub source_attributes: serde_json::Value,
    pub source_relations: serde_json::Value,
    pub source_style: Option<serde_json::Value>,
}

/// Truthful byte progress while a prepared point cloud is captured for
/// bounded sidecar work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSourceCaptureProgress {
    pub artifact: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CanonicalSourceCaptureArtifact {
    pub artifact: String,
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub object_hash: ObjectHash,
    pub byte_length: u64,
}

#[derive(Debug, Clone)]
pub struct CanonicalGroundSourceCapture {
    pub source: CanonicalGroundSource,
    pub artifacts: Vec<CanonicalSourceCaptureArtifact>,
    pub total_bytes: u64,
}

/// One atomic PC-D19 source-edit plus derived-cloud publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalGroundCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub source_entity_id: String,
    pub source_revision: u64,
    pub ground_entity_id: String,
    pub ground_revision: u64,
    pub source_dataset_id: String,
    pub ground_dataset_id: String,
}

/// One atomic PC-D1 edited-revision publication over one or more selected clouds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSegmentCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub revisions: Vec<CanonicalSegmentRevision>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSegmentRevision {
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
    pub retained_points: u64,
    pub removed_points: u64,
}

/// One immutable PC-D8 sampled-cloud publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSampleCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
}

/// One immutable PC-D17 grid publication for the later Mesh workflow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalRasterizeCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
    pub entity_type: String,
    pub mesh_source_role: Option<String>,
}

/// Failure of an explicit project lifecycle or staged import operation.
#[derive(Debug, Error)]
pub enum CanonicalAppRuntimeError {
    /// An operation requires an open canonical project.
    #[error("no canonical project is open")]
    ProjectNotOpen,
    /// Opening another project without first closing the current one is unsafe.
    #[error("a canonical project is already open")]
    ProjectAlreadyOpen,
    /// Durable canonical project storage rejected the operation.
    #[error(transparent)]
    Store(#[from] CanonicalProjectStoreError),
    #[error("canonical transaction references missing object {0:?}")]
    MissingObject(ObjectHash),
    /// Provider staging roots or the portable package are inconsistent.
    #[error("canonical staged import is invalid: {0}")]
    StagedImport(#[from] himmelcad_io::ProviderContractError),
    /// Persisted admissions or artifact inventories no longer agree with the
    /// live canonical document or immutable object store.
    #[error("canonical residency inventory is invalid: {0}")]
    InvalidResidency(String),
    /// A durable provider package cannot be reconstructed exactly for export.
    #[error("canonical import inventory cannot be reconstructed: {0}")]
    InvalidImportInventory(String),
    /// A live prepared point cloud could not provide bounded registration samples.
    #[error("canonical point-cloud registration samples are invalid: {0}")]
    RegistrationSamples(String),
    #[error("snapshot name is empty")]
    InvalidSnapshotName,
    #[error("snapshot marker is invalid")]
    InvalidSnapshotMarker,
    #[error("snapshot marker JSON is invalid: {0}")]
    SnapshotJson(#[from] serde_json::Error),
    #[error("snapshot marker {0} was not found")]
    SnapshotNotFound(String),
    #[error("snapshot generation {0} is not available in the journal")]
    SnapshotGenerationUnavailable(u64),
    #[error("snapshot restore cannot change the schema identity of entity {0}")]
    SnapshotSchemaConflict(String),
    #[error("there is no document change to {0}")]
    DocumentHistoryUnavailable(&'static str),
}

impl CanonicalAppRuntime {
    /// Opens or creates one durable canonical project and replays its journal.
    pub fn open(
        &mut self,
        project_root: impl AsRef<Path>,
    ) -> Result<AppDocumentSnapshot, CanonicalAppRuntimeError> {
        let project_root = project_root.as_ref();
        if let Some(store) = &self.store {
            if store.root() == project_root {
                return Ok(AppDocumentSnapshot::from_document(store.document()));
            }
            return Err(CanonicalAppRuntimeError::ProjectAlreadyOpen);
        }
        let mut store = CanonicalProjectStore::open(project_root)?;
        if store.document().generation() == 0
            && store.document().entities().next().is_none()
            && store.document().tombstones().next().is_none()
        {
            seed_project_root(&mut store, project_root)?;
        }
        ensure_default_layer(&mut store)?;
        let compacted =
            maintain_session_start_snapshots(&mut store, session_start_snapshot_retention())?;
        store.flush_group_commits()?;
        if compacted > 0 {
            eprintln!(
                "Compacted {compacted} session-start snapshots to {}",
                session_start_snapshot_retention()
            );
        }
        let snapshot = AppDocumentSnapshot::from_document(store.document());
        self.store = Some(store);
        Ok(snapshot)
    }

    /// Releases the exclusive canonical project lock.
    pub fn close(&mut self) -> bool {
        let Some(store) = self.store.as_mut() else {
            return false;
        };
        if store.flush_group_commits().is_err() {
            return false;
        }
        self.store.take().is_some()
    }

    pub fn durability_status(&self) -> Result<CanonicalDurabilityStatus, CanonicalAppRuntimeError> {
        Ok(self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?
            .durability_status())
    }

    /// Exact root owned by the currently locked Builder project.
    pub fn project_root(&self) -> Result<PathBuf, CanonicalAppRuntimeError> {
        Ok(self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?
            .root()
            .to_path_buf())
    }

    pub fn flush(&mut self) -> Result<CanonicalDurabilityStatus, CanonicalAppRuntimeError> {
        Ok(self.store_mut()?.flush_group_commits()?)
    }

    pub fn create_snapshot(
        &mut self,
        name: &str,
        origin: SnapshotOriginV1,
    ) -> Result<CanonicalSnapshotSummary, CanonicalAppRuntimeError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidSnapshotName);
        }
        Ok(create_snapshot_marker(
            self.store_mut()?,
            name,
            SnapshotMarkerKindV1::Manual,
            origin,
        )?)
    }

    pub fn list_snapshots(
        &self,
    ) -> Result<Vec<CanonicalSnapshotSummary>, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut result = Vec::new();
        for entity in store.document().entities() {
            if entity.type_id.0 != SNAPSHOT_MARKER_SCHEMA_ID {
                continue;
            }
            let marker: SnapshotMarkerV1 =
                serde_json::from_slice(&store.read_object(&entity.components_ref)?)?;
            validate_snapshot_marker(&marker)
                .map_err(|_| CanonicalAppRuntimeError::InvalidSnapshotMarker)?;
            result.push(CanonicalSnapshotSummary {
                entity_id: entity.id.0.clone(),
                name: entity.name.clone(),
                marker,
            });
        }
        result.sort_by(|left, right| {
            (left.marker.marked_generation, &left.entity_id)
                .cmp(&(right.marker.marked_generation, &right.entity_id))
        });
        Ok(result)
    }

    pub fn restore_snapshot(
        &mut self,
        entity_id: &str,
    ) -> Result<CanonicalSnapshotRestoreCommit, CanonicalAppRuntimeError> {
        let store = self.store_mut()?;
        let snapshot = snapshot_summaries(store)?
            .into_iter()
            .find(|candidate| candidate.entity_id == entity_id)
            .ok_or_else(|| CanonicalAppRuntimeError::SnapshotNotFound(entity_id.to_owned()))?;
        let marked_generation =
            usize::try_from(snapshot.marker.marked_generation).map_err(|_| {
                CanonicalAppRuntimeError::SnapshotGenerationUnavailable(
                    snapshot.marker.marked_generation,
                )
            })?;
        if marked_generation > store.document().journal().len() {
            return Err(CanonicalAppRuntimeError::SnapshotGenerationUnavailable(
                snapshot.marker.marked_generation,
            ));
        }
        let target = himmelcad_core::canonical_document::CanonicalDocument::from_journal(
            &store.document().journal()[..marked_generation],
        )
        .map_err(CanonicalProjectStoreError::Document)?;
        let mut mutations = restore_mutations(store.document(), &target)?;
        let safety_name = format!("Before restoring '{}'", snapshot.name);
        let (_, safety_entity) = build_snapshot_marker_entity(
            store,
            &safety_name,
            SnapshotMarkerKindV1::PreRestore,
            SnapshotOriginV1::System,
            Some(EntityId(snapshot.entity_id.clone())),
        )?;
        mutations.push(CanonicalEntityMutation::Create {
            entity: safety_entity,
        });
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id: format!(
                "snapshot.restore/{}/{}",
                snapshot.entity_id,
                store.document().generation()
            ),
            mutations,
        })?;
        Ok(CanonicalSnapshotRestoreCommit {
            snapshot,
            journal_entry,
        })
    }

    pub fn create_view_bookmark(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        state: serde_json::Value,
    ) -> Result<CanonicalViewBookmarkCommit, CanonicalAppRuntimeError> {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() || name.trim().is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "bookmark command, entity id and name are required".to_owned(),
            ));
        }
        validate_view_bookmark_state(&state)?;
        let record = CanonicalViewBookmarkRecord {
            schema_id: VIEW_BOOKMARK_SCHEMA_ID.to_owned(),
            schema_version: 1,
            state,
            restore_count: 0,
        };
        let components = bookmark_object(&record)?;
        let attributes = empty_json_object(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({}),
        )?;
        let relations = empty_json_object(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )?;
        let store = self.store_mut()?;
        store.put_json_object(&components)?;
        store.put_json_object(&attributes)?;
        store.put_json_object(&relations)?;
        let owner = store
            .document()
            .entities()
            .find(|entity| entity.owner.is_none() && entity.type_id.0 == built_in_type::GROUP)
            .map(|entity| entity.id.clone());
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(VIEW_BOOKMARK_SCHEMA_ID.to_owned()),
            name: name.trim().to_owned(),
            owner,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: components.object_hash,
            attributes_ref: attributes.object_hash,
            relations_ref: relations.object_hash,
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending view bookmark"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Create { entity }],
        })?;
        let bookmark = read_view_bookmark(
            store,
            journal_entry.effects[0].after.as_ref().ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(
                    "bookmark create produced no live entity".to_owned(),
                )
            })?,
        )?;
        Ok(CanonicalViewBookmarkCommit {
            bookmark,
            journal_entry,
        })
    }

    pub fn list_view_bookmarks(
        &self,
    ) -> Result<Vec<CanonicalViewBookmarkSummary>, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut result = store
            .document()
            .entities()
            .filter(|entity| entity.type_id.0 == VIEW_BOOKMARK_SCHEMA_ID)
            .map(|entity| read_view_bookmark(store, entity))
            .collect::<Result<Vec<_>, _>>()?;
        result.sort_by(|left, right| {
            (&left.name, &left.entity_id).cmp(&(&right.name, &right.entity_id))
        });
        Ok(result)
    }

    pub fn restore_view_bookmark(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewBookmarkCommit, CanonicalAppRuntimeError> {
        let store = self.store_mut()?;
        let entity = store
            .document()
            .entity(&EntityId(entity_id.clone()))
            .cloned()
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "bookmark {entity_id:?} no longer exists"
                ))
            })?;
        if entity.type_id.0 != VIEW_BOOKMARK_SCHEMA_ID || entity.revision != expected_revision {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "bookmark {entity_id:?} is stale or has the wrong type"
            )));
        }
        let mut record: CanonicalViewBookmarkRecord =
            serde_json::from_slice(&store.read_object(&entity.components_ref)?)?;
        record.restore_count = record.restore_count.saturating_add(1);
        let components = bookmark_object(&record)?;
        store.put_json_object(&components)?;
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Update {
                expected: EntityVersionRef {
                    id: entity.id,
                    revision: entity.revision,
                    version_hash: entity.version_hash,
                },
                edits: vec![CanonicalEntityEdit::SetComponentsRef {
                    components_ref: components.object_hash,
                }],
            }],
        })?;
        let bookmark = read_view_bookmark(
            store,
            journal_entry.effects[0].after.as_ref().ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(
                    "bookmark restore produced no live entity".to_owned(),
                )
            })?,
        )?;
        Ok(CanonicalViewBookmarkCommit {
            bookmark,
            journal_entry,
        })
    }

    pub fn put_viewing_box(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        expected_revision: Option<u64>,
        state: serde_json::Value,
    ) -> Result<CanonicalViewingBoxCommit, CanonicalAppRuntimeError> {
        if command_id.trim().is_empty()
            || entity_id.trim().is_empty()
            || name.trim().is_empty()
            || !state.is_object()
        {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "viewing-box command, id, name and object state are required".to_owned(),
            ));
        }
        let component_value = serde_json::json!({
            "schemaId": VIEWING_BOX_SCHEMA_ID,
            "schemaVersion": 1,
            "state": state,
        });
        let components = empty_json_object(
            "application/vnd.himmelcad.viewing-box+json",
            component_value,
        )?;
        let store = self.store_mut()?;
        store.put_json_object(&components)?;
        let existing = store
            .document()
            .entity(&EntityId(entity_id.clone()))
            .cloned();
        let mutation = if let Some(entity) = existing {
            if entity.type_id.0 != VIEWING_BOX_SCHEMA_ID
                || expected_revision != Some(entity.revision)
            {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "viewing box {entity_id:?} is stale or has the wrong type"
                )));
            }
            CanonicalEntityMutation::Update {
                expected: EntityVersionRef {
                    id: entity.id,
                    revision: entity.revision,
                    version_hash: entity.version_hash,
                },
                edits: vec![
                    CanonicalEntityEdit::SetName {
                        name: name.trim().to_owned(),
                    },
                    CanonicalEntityEdit::SetComponentsRef {
                        components_ref: components.object_hash,
                    },
                ],
            }
        } else {
            if expected_revision.is_some() {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "viewing box {entity_id:?} no longer exists"
                )));
            }
            let attributes = empty_json_object(
                "application/vnd.himmelcad.attributes+json",
                serde_json::json!({}),
            )?;
            let relations = empty_json_object(
                "application/vnd.himmelcad.relations+json",
                serde_json::json!([]),
            )?;
            store.put_json_object(&attributes)?;
            store.put_json_object(&relations)?;
            let owner = store
                .document()
                .entities()
                .find(|entity| entity.owner.is_none() && entity.type_id.0 == built_in_type::GROUP)
                .map(|entity| entity.id.clone());
            let mut entity = CanonicalEntity {
                id: EntityId(entity_id),
                revision: 0,
                type_id: EntityTypeId(VIEWING_BOX_SCHEMA_ID.to_owned()),
                name: name.trim().to_owned(),
                owner,
                layer_ids: Vec::new(),
                placement: None,
                representations: Vec::new(),
                components_ref: components.object_hash,
                attributes_ref: attributes.object_hash,
                relations_ref: relations.object_hash,
                style_ref: None,
                schema_version: 1,
                version_hash: ObjectHash::of_bytes(b"pending viewing box"),
            };
            entity.version_hash = canonical_entity_version_hash(&entity)
                .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
            CanonicalEntityMutation::Create { entity }
        };
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations: vec![mutation],
        })?;
        let viewing_box = read_viewing_box(
            store,
            journal_entry.effects[0].after.as_ref().ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(
                    "viewing-box commit produced no live entity".to_owned(),
                )
            })?,
        )?;
        Ok(CanonicalViewingBoxCommit {
            viewing_box,
            journal_entry,
        })
    }

    pub fn list_viewing_boxes(
        &self,
    ) -> Result<Vec<CanonicalViewingBoxSummary>, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        store
            .document()
            .entities()
            .filter(|entity| entity.type_id.0 == VIEWING_BOX_SCHEMA_ID)
            .map(|entity| read_viewing_box(store, entity))
            .collect()
    }

    pub fn delete_viewing_box(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewingBoxDelete, CanonicalAppRuntimeError> {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "viewing-box delete command and id are required".to_owned(),
            ));
        }
        let store = self.store_mut()?;
        let entity = store
            .document()
            .entity(&EntityId(entity_id.clone()))
            .cloned()
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "viewing box {entity_id:?} no longer exists"
                ))
            })?;
        if entity.type_id.0 != VIEWING_BOX_SCHEMA_ID || entity.revision != expected_revision {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "viewing box {entity_id:?} is stale or has the wrong type"
            )));
        }
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Delete {
                expected: EntityVersionRef {
                    id: entity.id,
                    revision: entity.revision,
                    version_hash: entity.version_hash,
                },
            }],
        })?;
        Ok(CanonicalViewingBoxDelete { journal_entry })
    }

    /// Creates one admitted Release 0.5 measurement in one journal transaction.
    /// Attached anchors are revalidated against the current canonical source
    /// revision immediately before the immutable geometry is stored.
    pub fn create_measurement(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        measurement: MeasurementV1,
    ) -> Result<CanonicalMeasurementCommit, CanonicalAppRuntimeError> {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() || name.trim().is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "measurement command, entity id and name are required".to_owned(),
            ));
        }
        validate_measurement(&measurement).map_err(|error| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "measurement payload is outside the admitted 0.5 profile: {error}"
            ))
        })?;

        let store = self.store_mut()?;
        if store
            .document()
            .entity(&EntityId(entity_id.clone()))
            .is_some()
            || store
                .document()
                .tombstone(&EntityId(entity_id.clone()))
                .is_some()
        {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "measurement {entity_id:?} already exists"
            )));
        }
        for anchor in &measurement.anchors {
            let MeasurementAnchorV1::Attached {
                entity_id,
                expected_revision,
                expected_version_hash,
                ..
            } = anchor
            else {
                continue;
            };
            let source = store.document().entity(entity_id).ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "attached measurement source {:?} no longer exists",
                    entity_id.0
                ))
            })?;
            if source.revision != *expected_revision
                || source.version_hash != *expected_version_hash
            {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "attached measurement source {:?} changed before commit",
                    entity_id.0
                )));
            }
        }

        let geometry = GeometryObject::Measurement {
            measurement: Box::new(measurement.clone()),
        };
        let geometry_ref = store.put_geometry_object(&geometry)?;
        let components = empty_json_object(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({ "schemaId": "hcad.components@1" }),
        )?;
        let attributes = empty_json_object(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({ "schemaId": "hcad.attributes@1" }),
        )?;
        let relations = empty_json_object(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
        )?;
        store.put_json_object(&components)?;
        store.put_json_object(&attributes)?;
        store.put_json_object(&relations)?;

        let owner = store
            .document()
            .entities()
            .find(|entity| entity.owner.is_none() && entity.type_id.0 == built_in_type::GROUP)
            .map(|entity| entity.id.clone());
        let mut mutations = Vec::with_capacity(1);
        match store.document().entity(&measurement.layer_id) {
            Some(layer) if layer.type_id.0 == built_in_type::LAYER => {}
            Some(_) => {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "measurement layer {:?} has the wrong type",
                    measurement.layer_id.0
                )));
            }
            None => {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "measurement layer {:?} no longer exists",
                    measurement.layer_id.0
                )));
            }
        }
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(MEASUREMENT_SCHEMA_ID.to_owned()),
            name: name.trim().to_owned(),
            owner,
            layer_ids: vec![measurement.layer_id.clone()],
            placement: None,
            representations: vec![Representation {
                role: RepresentationRole::Canonical,
                geometry_ref,
                authority: RepresentationAuthority::Authoritative,
                dependency_hash: None,
            }],
            components_ref: components.object_hash,
            attributes_ref: attributes.object_hash,
            relations_ref: relations.object_hash,
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending measurement"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        validate_resolved_representation(
            &entity,
            entity
                .representations
                .first()
                .expect("measurement representation"),
            &geometry,
        )
        .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        mutations.push(CanonicalEntityMutation::Create { entity });
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations,
        })?;
        let measurement = read_measurement(
            store,
            journal_entry
                .effects
                .last()
                .and_then(|effect| effect.after.as_ref())
                .ok_or_else(|| {
                    CanonicalAppRuntimeError::InvalidResidency(
                        "measurement create produced no live entity".to_owned(),
                    )
                })?,
        )?;
        Ok(CanonicalMeasurementCommit {
            measurement,
            journal_entry,
        })
    }

    pub fn list_measurements(
        &self,
    ) -> Result<Vec<CanonicalMeasurementSummary>, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut result = store
            .document()
            .entities()
            .filter(|entity| entity.type_id.0 == MEASUREMENT_SCHEMA_ID)
            .map(|entity| read_measurement(store, entity))
            .collect::<Result<Vec<_>, _>>()?;
        result.sort_by(|left, right| {
            (&left.name, &left.entity_id).cmp(&(&right.name, &right.entity_id))
        });
        Ok(result)
    }

    pub fn get_measurement(
        &self,
        entity_id: &str,
    ) -> Result<CanonicalMeasurementSummary, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let entity = store
            .document()
            .entity(&EntityId(entity_id.to_owned()))
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "measurement {entity_id:?} no longer exists"
                ))
            })?;
        read_measurement(store, entity)
    }

    pub fn delete_measurement(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalMeasurementDelete, CanonicalAppRuntimeError> {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "measurement delete command and entity id are required".to_owned(),
            ));
        }
        let store = self.store_mut()?;
        let entity = store
            .document()
            .entity(&EntityId(entity_id.clone()))
            .cloned()
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "measurement {entity_id:?} no longer exists"
                ))
            })?;
        if entity.type_id.0 != MEASUREMENT_SCHEMA_ID || entity.revision != expected_revision {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "measurement {entity_id:?} is stale or has the wrong type"
            )));
        }
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Delete {
                expected: EntityVersionRef::from_entity(&entity),
            }],
        })?;
        Ok(CanonicalMeasurementDelete { journal_entry })
    }

    /// Creates or extends one authored linework entity. Every accepted vertex
    /// is one forward journal transaction; immutable geometry and provenance
    /// are published before the document root becomes visible.
    pub fn put_draw_curve(
        &mut self,
        command_id: String,
        input: DrawCurveInput,
    ) -> Result<CanonicalDrawCurveCommit, CanonicalAppRuntimeError> {
        validate_draw_curve_input(&command_id, &input)?;
        let geometry = GeometryObject::Curve {
            curve: Box::new(if input.tool == DrawCurveTool::Line {
                CurveGeometry::LineSegment {
                    start: input.vertices[0],
                    end: input.vertices[1],
                }
            } else {
                CurveGeometry::Polyline {
                    positions: input.vertices.clone(),
                    closed: input.closed,
                }
            }),
        };
        let support_role = SupportRoleV1 {
            schema_id: SUPPORT_ROLE_SCHEMA_ID.to_owned(),
            schema_version: RELEASE_05_SCHEMA_VERSION,
            role_kind: SupportRoleKindV1::DefiningCurve,
            defines: Vec::new(),
            provenance: "draw.vertex".to_owned(),
        };
        validate_support_role(&support_role).map_err(|error| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "invalid draw support role: {error}"
            ))
        })?;
        let components_value = DrawCurveComponents {
            schema_id: DRAW_CURVE_COMPONENT_SCHEMA_ID.to_owned(),
            schema_version: 1,
            tool: input.tool,
            role: input.role,
            mesh_source_role: match input.role {
                DrawCurveRole::Plain => None,
                DrawCurveRole::Breakline => Some("breakline".to_owned()),
                DrawCurveRole::Boundary if input.closed => Some("outer_boundary".to_owned()),
                DrawCurveRole::Boundary => None,
            },
            point_acquisitions: input.acquisitions.clone(),
            support_role,
        };
        let components = empty_json_object(
            "application/vnd.himmelcad.components+json",
            serde_json::to_value(&components_value)
                .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?,
        )?;
        let attributes = empty_json_object(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({ "schemaId": "hcad.attributes@1" }),
        )?;
        let relations = empty_json_object(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
        )?;
        let store = self.store_mut()?;
        let geometry_ref = store.put_geometry_object(&geometry)?;
        store.put_json_object(&components)?;
        store.put_json_object(&attributes)?;
        store.put_json_object(&relations)?;
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref,
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let existing = store
            .document()
            .entity(&EntityId(input.entity_id.clone()))
            .cloned();
        let mut mutations = Vec::with_capacity(1);
        let mutation = match (existing, input.expected_revision) {
            (None, None) => {
                let owner = store
                    .document()
                    .entities()
                    .find(|entity| {
                        entity.owner.is_none() && entity.type_id.0 == built_in_type::GROUP
                    })
                    .map(|entity| entity.id.clone());
                let mut entity = CanonicalEntity {
                    id: EntityId(input.entity_id.clone()),
                    revision: 0,
                    type_id: EntityTypeId(built_in_type::CURVE.to_owned()),
                    name: input.name.trim().to_owned(),
                    owner,
                    layer_ids: vec![EntityId("default-layer".to_owned())],
                    placement: None,
                    representations: vec![selected.clone()],
                    components_ref: components.object_hash.clone(),
                    attributes_ref: attributes.object_hash.clone(),
                    relations_ref: relations.object_hash.clone(),
                    style_ref: None,
                    schema_version: 1,
                    version_hash: ObjectHash::of_bytes(b"pending draw curve"),
                };
                entity.version_hash = canonical_entity_version_hash(&entity).map_err(|error| {
                    CanonicalAppRuntimeError::InvalidResidency(error.to_string())
                })?;
                validate_resolved_representation(&entity, &selected, &geometry).map_err(
                    |error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()),
                )?;
                CanonicalEntityMutation::Create { entity }
            }
            (Some(entity), Some(expected_revision))
                if entity.type_id.0 == built_in_type::CURVE
                    && entity.revision == expected_revision =>
            {
                CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&entity),
                    edits: vec![
                        CanonicalEntityEdit::SetRepresentations {
                            representations: vec![selected],
                        },
                        CanonicalEntityEdit::SetComponentsRef {
                            components_ref: components.object_hash,
                        },
                    ],
                }
            }
            _ => {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "draw curve {:?} is stale, missing, or has the wrong type",
                    input.entity_id
                )))
            }
        };
        mutations.push(mutation);
        let journal_entry = store.queue_transaction(CanonicalCommandTransaction {
            command_id,
            mutations,
        })?;
        let entity = journal_entry
            .effects
            .iter()
            .find(|effect| effect.entity_id.0 == input.entity_id)
            .and_then(|effect| effect.after.as_ref())
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(
                    "draw curve mutation produced no live entity".to_owned(),
                )
            })?;
        let curve = read_draw_curve(store, entity)?;
        Ok(CanonicalDrawCurveCommit {
            curve,
            journal_entry,
        })
    }

    pub fn list_draw_curves(
        &self,
    ) -> Result<Vec<CanonicalDrawCurveSummary>, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut curves = store
            .document()
            .entities()
            .filter(|entity| entity.type_id.0 == built_in_type::CURVE)
            .filter_map(|entity| match read_draw_curve(store, entity) {
                Ok(curve) => Some(Ok(curve)),
                Err(CanonicalAppRuntimeError::InvalidResidency(message))
                    if message.contains("is not authored draw linework") =>
                {
                    None
                }
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        curves.sort_by(|left, right| {
            (&left.name, &left.entity_id).cmp(&(&right.name, &right.entity_id))
        });
        Ok(curves)
    }

    pub fn undo_draw_curve(
        &mut self,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        Ok(self
            .store_mut()?
            .commit_undo(command_id, &target_command_id)?)
    }

    pub fn redo_draw_curve(
        &mut self,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        Ok(self
            .store_mut()?
            .commit_redo(command_id, &target_command_id)?)
    }

    /// Undoes the newest active user-document command. Bookkeeping snapshot
    /// markers are deliberately outside the P8 document history surface.
    pub fn undo_document(
        &mut self,
        command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let target = latest_document_undo_target(store)
            .ok_or(CanonicalAppRuntimeError::DocumentHistoryUnavailable("undo"))?;
        Ok(self.store_mut()?.commit_undo(command_id, &target)?)
    }

    /// Redoes the newest still-undone user-document command. Because the
    /// target is reconstructed from the durable journal, this works after a
    /// close/reopen without renderer-owned history state.
    pub fn redo_document(
        &mut self,
        command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let target = latest_document_redo_target(store)
            .ok_or(CanonicalAppRuntimeError::DocumentHistoryUnavailable("redo"))?;
        Ok(self.store_mut()?.commit_redo(command_id, &target)?)
    }

    /// Returns whether a canonical project currently owns this runtime.
    #[must_use]
    pub const fn is_open(&self) -> bool {
        self.store.is_some()
    }

    /// Returns an immutable, stable-order automation snapshot without
    /// exposing the project store or host paths.
    pub fn automation_entities(
        &self,
    ) -> Result<(u64, Vec<CanonicalEntity>), CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        Ok((
            store.document().generation(),
            store.document().entities().cloned().collect(),
        ))
    }

    /// Fully validates one canonical transaction against the current
    /// generation and immutable object inventory without mutating state.
    pub fn automation_validate_transaction(
        &self,
        transaction: &CanonicalCommandTransaction,
    ) -> Result<(), String> {
        let store = self.store().map_err(|error| error.to_string())?;
        validate_transaction_object_refs(store, transaction).map_err(|error| error.to_string())?;
        store
            .document()
            .prepare_transaction(transaction.clone())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Resolves and verifies one immutable CAS source for a sidecar-owned
    /// bounded bulk lease. Only the automation runtime receives the path.
    pub fn automation_object_source(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<AutomationObjectSource, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let (metadata, source) = store.verified_object_source(object_hash)?;
        let direct_source_entity = store.document().entities().find_map(|entity| {
            let references_hash = entity.components_ref == *object_hash
                || entity.attributes_ref == *object_hash
                || entity.relations_ref == *object_hash
                || entity.style_ref.as_ref() == Some(object_hash)
                || entity
                    .representations
                    .iter()
                    .any(|representation| representation.geometry_ref == *object_hash);
            references_hash.then(|| himmelcad_core::canonical_document::EntityVersionRef {
                id: entity.id.clone(),
                revision: entity.revision,
                version_hash: entity.version_hash.clone(),
            })
        });
        let resolved = resolve_automation_artifact(store, object_hash)?;
        Ok(AutomationObjectSource {
            metadata,
            source,
            source_entity: resolved.source_entity.or(direct_source_entity),
            typed_artifact: resolved.typed_artifact,
            representation_slot: resolved.representation_slot,
            geometry_ref: resolved.geometry_ref,
        })
    }

    /// Reads one bounded committed-resource range for the trusted desktop
    /// protocol bridge. The response is path-free for the renderer.
    pub fn read_residency_resource_range(
        &self,
        object_hash: &ObjectHash,
        offset: u64,
        byte_length: u64,
    ) -> Result<(CanonicalStoredObject, Vec<u8>), CanonicalAppRuntimeError> {
        self.store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?
            .read_object_range(object_hash, offset, byte_length)
            .map_err(Into::into)
    }

    /// Publishes a validated provider result through the same journal-last store
    /// used by all other canonical mutations.
    pub fn publish_staged_import(
        &mut self,
        staged: &CanonicalStagedImport,
        command_id: &str,
    ) -> Result<CanonicalImportCommit, CanonicalAppRuntimeError> {
        staged.validate()?;
        if let Some(existing) = self.existing_product_import(staged)? {
            return Ok(existing);
        }
        let source_roots = CanonicalImportSourceRoots {
            datasets: staged.roots.dataset_roots.clone(),
            resource_sets: staged.roots.resource_set_roots.clone(),
        };
        self.store_mut()?
            .publish_import_package(&staged.package, &source_roots, command_id)
            .map_err(Into::into)
    }

    /// Publishes a staged import and reports the real durable-store byte progress.
    pub fn publish_staged_import_with_progress(
        &mut self,
        staged: &CanonicalStagedImport,
        command_id: &str,
        progress: &mut dyn FnMut(CanonicalImportProgress),
    ) -> Result<CanonicalImportCommit, CanonicalAppRuntimeError> {
        staged.validate()?;
        if let Some(existing) = self.existing_product_import(staged)? {
            return Ok(existing);
        }
        let source_roots = CanonicalImportSourceRoots {
            datasets: staged.roots.dataset_roots.clone(),
            resource_sets: staged.roots.resource_set_roots.clone(),
        };
        self.store_mut()?
            .publish_import_package_with_progress(
                &staged.package,
                &source_roots,
                command_id,
                progress,
            )
            .map_err(Into::into)
    }

    /// Publishes a staged import while observing cancellation until the store's
    /// durable ready-marker boundary. Publication after that marker is atomic.
    pub fn publish_staged_import_with_progress_and_cancel(
        &mut self,
        staged: &CanonicalStagedImport,
        command_id: &str,
        progress: &mut dyn FnMut(CanonicalImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalImportCommit, CanonicalAppRuntimeError> {
        staged.validate()?;
        if let Some(existing) = self.existing_product_import(staged)? {
            return Ok(existing);
        }
        let source_roots = CanonicalImportSourceRoots {
            datasets: staged.roots.dataset_roots.clone(),
            resource_sets: staged.roots.resource_set_roots.clone(),
        };
        self.store_mut()?
            .publish_import_package_with_progress_and_cancel(
                &staged.package,
                &source_roots,
                command_id,
                progress,
                is_cancelled,
            )
            .map_err(Into::into)
    }

    /// Identity-strict IF-D23 replay: the deterministic package destination id
    /// is checked again under the destination store lock and returns the
    /// original commit without adding an entity or journal transaction.
    fn existing_product_import(
        &self,
        staged: &CanonicalStagedImport,
    ) -> Result<Option<CanonicalImportCommit>, CanonicalAppRuntimeError> {
        if staged.package.provider_id != himmelcad_io::PRODUCT_IMPORT_PACKAGE_PROVIDER_ID {
            return Ok(None);
        }
        let Some(admission) = staged.package.admissions.first() else {
            return Ok(None);
        };
        let Some(store) = self.store.as_ref() else {
            return Ok(None);
        };
        if store.document().entity(&admission.entity.id).is_none() {
            return Ok(None);
        }
        let inventory = store
            .import_inventories()?
            .into_iter()
            .find(|inventory| {
                inventory.provider_id == himmelcad_io::PRODUCT_IMPORT_PACKAGE_PROVIDER_ID
                    && inventory
                        .admissions
                        .iter()
                        .any(|stored| stored.entity_id == admission.entity.id.0)
            })
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(
                    "a product destination exists without its immutable import inventory"
                        .to_owned(),
                )
            })?;
        let journal_entry = store
            .document()
            .journal()
            .iter()
            .find(|entry| entry.command_id == inventory.command_id)
            .cloned()
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(
                    "a product import inventory has no journal transaction".to_owned(),
                )
            })?;
        Ok(Some(CanonicalImportCommit {
            journal_entry,
            inventory,
        }))
    }

    /// Captures one live point cloud and materializes its three Potree files for bounded work.
    pub fn prepare_ground_source(
        &self,
        expected: EntityVersionRef,
        input_root: PathBuf,
    ) -> Result<CanonicalGroundSource, CanonicalAppRuntimeError> {
        self.prepare_ground_source_with_progress(expected, input_root, &mut |_| true)
    }

    /// Captures a prepared point-cloud source with truthful byte progress and
    /// cancellation checks during immutable-object verification.
    pub fn prepare_ground_source_with_progress(
        &self,
        expected: EntityVersionRef,
        input_root: PathBuf,
        progress: &mut dyn FnMut(CanonicalSourceCaptureProgress) -> bool,
    ) -> Result<CanonicalGroundSource, CanonicalAppRuntimeError> {
        let capture = self.plan_ground_source_capture(expected, input_root)?;
        let mut completed_bytes = 0_u64;
        for artifact in &capture.artifacts {
            let artifact_name = artifact.artifact.clone();
            crate::canonical_project_store::materialize_verified_path_with_progress(
                &artifact.source_path,
                &artifact.destination_path,
                &artifact.object_hash,
                Some(artifact.byte_length),
                &mut |bytes| {
                    completed_bytes = completed_bytes.saturating_add(bytes);
                    progress(CanonicalSourceCaptureProgress {
                        artifact: artifact_name.clone(),
                        completed_bytes,
                        total_bytes: capture.total_bytes.max(1),
                    })
                },
            )?;
        }
        Ok(capture.source)
    }

    /// Resolves one immutable capture under the project lock without doing
    /// the long file verification. The caller can then verify/materialize the
    /// returned paths while canonical range reads remain responsive.
    pub fn plan_ground_source_capture(
        &self,
        expected: EntityVersionRef,
        input_root: PathBuf,
    ) -> Result<CanonicalGroundSourceCapture, CanonicalAppRuntimeError> {
        let bootstrap = self.residency_bootstrap()?;
        let entry = bootstrap
            .entries
            .into_iter()
            .find(|entry| entry.admission.entity.id == expected.id)
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(
                    "selected point cloud has no live prepared dataset".to_owned(),
                )
            })?;
        if EntityVersionRef::from_entity(&entry.admission.entity) != expected {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "selected point-cloud revision changed before ground extraction".to_owned(),
            ));
        }
        let dataset = entry.dataset.ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(
                "selected point cloud is not a prepared dataset".to_owned(),
            )
        })?;
        if dataset.format_id != "potree@2" {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "ground extraction requires an uncompressed Potree 2 dataset".to_owned(),
            ));
        }
        std::fs::create_dir_all(&input_root).map_err(CanonicalProjectStoreError::from)?;
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let captured_artifacts = dataset
            .artifacts
            .iter()
            .filter_map(|artifact| {
                let name = artifact.relative_path.file_name()?.to_str()?;
                matches!(name, "metadata.json" | "hierarchy.bin" | "octree.bin")
                    .then_some((name.to_owned(), artifact))
            })
            .collect::<Vec<_>>();
        if captured_artifacts.len() != 3 {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "prepared point cloud is missing metadata.json, hierarchy.bin, or octree.bin"
                    .to_owned(),
            ));
        }
        let artifacts = captured_artifacts
            .into_iter()
            .map(|(name, artifact)| {
                let byte_length = artifact.resource.byte_length.map_or_else(
                    || store.object_byte_length(&artifact.resource.object_hash),
                    Ok,
                )?;
                Ok(CanonicalSourceCaptureArtifact {
                    source_path: store
                        .object_path_for_materialization(&artifact.resource.object_hash)?,
                    destination_path: input_root.join(&name),
                    object_hash: artifact.resource.object_hash.clone(),
                    byte_length,
                    artifact: name,
                })
            })
            .collect::<Result<Vec<_>, CanonicalProjectStoreError>>()?;
        let total_bytes = artifacts.iter().fold(0_u64, |total, artifact| {
            total.saturating_add(artifact.byte_length)
        });
        let entity = entry.admission.entity;
        Ok(CanonicalGroundSourceCapture {
            source: CanonicalGroundSource {
                expected,
                source_components: serde_json::from_slice(
                    &store.read_object(&entity.components_ref)?,
                )?,
                source_attributes: serde_json::from_slice(
                    &store.read_object(&entity.attributes_ref)?,
                )?,
                source_relations: serde_json::from_slice(
                    &store.read_object(&entity.relations_ref)?,
                )?,
                source_style: entity
                    .style_ref
                    .as_ref()
                    .map(|hash| store.read_object(hash))
                    .transpose()?
                    .map(|bytes| serde_json::from_slice(&bytes))
                    .transpose()?,
                entity,
                representation_slot: entry.admission.representation_slot,
                input_root,
            },
            artifacts,
            total_bytes,
        })
    }

    /// Publishes checked ground outputs and exact source class bytes as one undoable transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_ground_extraction(
        &mut self,
        source: CanonicalGroundSource,
        prepared: &PreparedGroundResult,
        command_id: String,
        ground_entity_id: String,
        output_name: String,
        parameters: serde_json::Value,
        scope: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(CanonicalImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalGroundCommit, CanonicalAppRuntimeError> {
        let recipe_parameters = serde_json::json!({
            "smrf": parameters.clone(),
            "scope": scope.clone(),
        });
        let source_dataset_id = ground_dataset_id("classified", &prepared.source);
        let ground_dataset_id = ground_dataset_id("ground", &prepared.extracted);
        let (source_dataset, source_geometry, source_representation) = ground_dataset_contract(
            &prepared.source,
            &source_dataset_id,
            &source.entity.id.0,
            &source.representation_slot,
        )?;
        let (ground_dataset, ground_geometry, ground_representation) = ground_dataset_contract(
            &prepared.extracted,
            &ground_dataset_id,
            &ground_entity_id,
            "source",
        )?;

        let source_components = merge_object(
            source.source_components,
            "hcad.prepared-dataset@1",
            serde_json::json!({ "formatId": "potree@2", "datasetId": source_dataset_id }),
        )?;
        let source_attributes = merge_object(
            source.source_attributes,
            "hcad.point-cloud-ground-classification@1",
            serde_json::json!({
                "algorithmId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
                "parameters": parameters.clone(),
                "scope": scope.clone(),
                "membershipSha256": prepared.summary.membership_sha256,
                "summary": prepared.summary,
            }),
        )?;
        let source_components_object = canonical_json(
            "application/vnd.himmelcad.components+json",
            source_components,
        )?;
        let source_attributes_object = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            source_attributes,
        )?;
        let source_relations_object = canonical_json(
            "application/vnd.himmelcad.relations+json",
            source.source_relations,
        )?;

        let ground_geometry_hash = ground_representation.geometry_ref.clone();
        let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "parameters": recipe_parameters,
        }))?);
        let recipe_id = format!(
            "ground-recipe-{}",
            &prepared.summary.membership_sha256.0[..24]
        );
        let recipe = serde_json::json!({
            "schemaId": "hcad.derived-recipe@1",
            "schemaVersion": 1,
            "recipeId": recipe_id,
            "recipeKind": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
            "generation": 1,
            "state": "linked-current",
            "outputGroupId": ground_entity_id,
            "outputs": [{
                "slotId": "ground",
                "role": "ground_cloud",
                "outputId": ground_entity_id,
                "typeId": built_in_type::POINT_CLOUD,
                "locator": "source",
                "currentRevision": 0,
                "currentContentHash": ground_geometry_hash,
                "status": "present"
            }],
            "sources": [{
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "contentHash": source.entity.version_hash,
                "placementRevision": source.entity.revision,
                "role": "outdoor_ground_source"
            }],
            "parameterTypeId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
            "parameters": recipe_parameters,
            "algorithmId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
            "algorithmVersion": "1",
            "dependencyRecipeIds": [],
            "staleCauses": [],
            "lastSuccess": {
                "generation": 1,
                "sourceFingerprint": source_fingerprint,
                "outputs": [{
                    "slotId": "ground",
                    "outputId": ground_entity_id,
                    "revision": 0,
                    "contentHash": ground_geometry_hash
                }],
                "completedAt": completed_at
            },
            "lastError": null,
            "detach": null
        });
        let mut mesh_source_roles = MeshSourceRolesV1 {
            schema_id: MESH_SOURCE_ROLES_SCHEMA_ID.to_owned(),
            schema_version: 1,
            resource_id: format!("mesh-source-{ground_entity_id}"),
            content_hash: ObjectHash::of_bytes(b""),
            roles: vec![MeshSourceRoleV1 {
                source: DerivedSourceV1 {
                    entity_id: EntityId(ground_entity_id.clone()),
                    revision: 0,
                    content_hash: ground_geometry_hash.clone(),
                    placement_revision: 0,
                    role: "ground_cloud".to_owned(),
                },
                placement: source
                    .entity
                    .placement
                    .unwrap_or(himmelcad_core::entity_model::Transform3d::IDENTITY),
                role: MeshSourceRoleKindV1::Points,
                sampling_tolerance: None,
                sampling_hash: None,
                boundary_hash: None,
                exclusion_hashes: Vec::new(),
            }],
        };
        mesh_source_roles.content_hash =
            ObjectHash::of_bytes(&serde_json::to_vec(&mesh_source_roles)?);
        let ground_components_object = canonical_json(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({
                "hcad.prepared-dataset@1": {
                    "formatId": "potree@2",
                    "datasetId": ground_dataset_id
                },
                "hcad.mesh-source-roles@1": mesh_source_roles
            }),
        )?;
        let ground_attributes_object = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.point-cloud-ground@1": {
                    "algorithmId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
                    "membershipSha256": prepared.summary.membership_sha256,
                    "summary": prepared.summary
                },
                "hcad.derived-recipe@1": recipe
            }),
        )?;
        let ground_relations_object = canonical_json(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([{
                "kind": "derivedFrom",
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "role": "outdoor_ground_source"
            }]),
        )?;
        let style_object = source
            .source_style
            .map(|value| {
                canonical_json("application/vnd.himmelcad.point-cloud-display+json", value)
            })
            .transpose()?;

        let mut source_after = source.entity.clone();
        source_after.revision = source_after.revision.saturating_add(1);
        source_after.representations = vec![source_representation.clone()];
        source_after.components_ref = source_components_object.object_hash.clone();
        source_after.attributes_ref = source_attributes_object.object_hash.clone();
        source_after.version_hash = canonical_entity_version_hash(&source_after)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        let mut ground_entity = CanonicalEntity {
            id: EntityId(ground_entity_id.clone()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: output_name,
            owner: source.entity.owner.clone(),
            layer_ids: source.entity.layer_ids.clone(),
            placement: source.entity.placement,
            representations: vec![ground_representation.clone()],
            components_ref: ground_components_object.object_hash.clone(),
            attributes_ref: ground_attributes_object.object_hash.clone(),
            relations_ref: ground_relations_object.object_hash.clone(),
            style_ref: style_object
                .as_ref()
                .map(|object| object.object_hash.clone()),
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized ground cloud"),
        };
        ground_entity.version_hash = canonical_entity_version_hash(&ground_entity)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;

        let mut objects = vec![
            source_components_object,
            source_attributes_object,
            source_relations_object,
            ground_components_object,
            ground_attributes_object,
            ground_relations_object,
        ];
        if let Some(style) = style_object {
            if !objects
                .iter()
                .any(|object| object.object_hash == style.object_hash)
            {
                objects.push(style);
            }
        }
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "hcad.pointcloud.ground-progressive@1".to_owned(),
            provider_version: "1".to_owned(),
            admissions: vec![
                CanonicalRepresentationAdmission {
                    entity: source_after.clone(),
                    selected: source_representation.clone(),
                    representation_slot: source.representation_slot,
                    expected_generation: None,
                    resolved_geometry: source_geometry,
                },
                CanonicalRepresentationAdmission {
                    entity: ground_entity.clone(),
                    selected: ground_representation,
                    representation_slot: "source".to_owned(),
                    expected_generation: None,
                    resolved_geometry: ground_geometry,
                },
            ],
            objects,
            datasets: vec![source_dataset, ground_dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let roots = CanonicalImportSourceRoots {
            datasets: [
                (source_dataset_id.clone(), prepared.source.root.clone()),
                (ground_dataset_id.clone(), prepared.extracted.root.clone()),
            ]
            .into_iter()
            .collect(),
            resource_sets: Default::default(),
        };
        let transaction = CanonicalCommandTransaction {
            command_id,
            mutations: vec![
                CanonicalEntityMutation::Update {
                    expected: source.expected,
                    edits: vec![
                        CanonicalEntityEdit::SetRepresentations {
                            representations: source_after.representations.clone(),
                        },
                        CanonicalEntityEdit::SetComponentsRef {
                            components_ref: source_after.components_ref.clone(),
                        },
                        CanonicalEntityEdit::SetAttributesRef {
                            attributes_ref: source_after.attributes_ref.clone(),
                        },
                    ],
                },
                CanonicalEntityMutation::Create {
                    entity: ground_entity.clone(),
                },
            ],
        };
        let commit = self
            .store_mut()?
            .publish_package_transaction_with_progress_and_cancel(
                &package,
                &roots,
                transaction,
                progress,
                is_cancelled,
            )?;
        Ok(CanonicalGroundCommit {
            journal_entry: commit.journal_entry,
            source_entity_id: source_after.id.0,
            source_revision: source_after.revision,
            ground_entity_id: ground_entity.id.0,
            ground_revision: ground_entity.revision,
            source_dataset_id,
            ground_dataset_id,
        })
    }

    /// Publishes every fully baked source revision in one journal transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_pointcloud_segmentation(
        &mut self,
        sources: Vec<(
            CanonicalGroundSource,
            PreparedSegmentResult,
            serde_json::Value,
        )>,
        command_id: String,
        volume: serde_json::Value,
        side: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(CanonicalImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalSegmentCommit, CanonicalAppRuntimeError> {
        if sources.is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "segmentation requires at least one source".to_owned(),
            ));
        }
        let mut admissions = Vec::with_capacity(sources.len());
        let mut datasets = Vec::with_capacity(sources.len());
        let mut objects = Vec::with_capacity(sources.len() * 3);
        let mut roots = BTreeMap::new();
        let mut mutations = Vec::with_capacity(sources.len());
        let mut revisions = Vec::with_capacity(sources.len());

        for (source, prepared, scope) in sources {
            let dataset_id = segment_dataset_id(&prepared.dataset);
            let (dataset, geometry, representation) = ground_dataset_contract(
                &prepared.dataset,
                &dataset_id,
                &source.entity.id.0,
                &source.representation_slot,
            )?;
            let next_revision = source.entity.revision.saturating_add(1);
            let geometry_hash = representation.geometry_ref.clone();
            let generation = source
                .source_attributes
                .get("hcad.point-cloud-edit-chain@1")
                .and_then(|value| value.get("edits"))
                .and_then(serde_json::Value::as_array)
                .map_or(1_u64, |edits| edits.len() as u64 + 1);
            let source_fingerprint =
                ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
                    "entityId": source.entity.id,
                    "revision": source.entity.revision,
                    "contentHash": source.entity.version_hash,
                    "volume": volume,
                    "side": side,
                    "scope": scope,
                }))?);
            let recipe_id = format!("segment-recipe-{}", &source_fingerprint.0[..24]);
            let recipe = serde_json::json!({
                "schemaId": "hcad.derived-recipe@1",
                "schemaVersion": 1,
                "recipeId": recipe_id,
                "recipeKind": SEGMENT_ALGORITHM_ID,
                "generation": generation,
                "state": "linked-current",
                "outputGroupId": source.entity.id,
                "outputs": [{
                    "slotId": source.representation_slot,
                    "role": "edited_cloud",
                    "outputId": source.entity.id,
                    "typeId": built_in_type::POINT_CLOUD,
                    "locator": source.representation_slot,
                    "currentRevision": next_revision,
                    "currentContentHash": geometry_hash,
                    "status": "present"
                }],
                "sources": [{
                    "entityId": source.entity.id,
                    "revision": source.entity.revision,
                    "contentHash": source.entity.version_hash,
                    "placementRevision": source.entity.revision,
                    "role": "source_revision"
                }],
                "parameterTypeId": SEGMENT_ALGORITHM_ID,
                "parameters": { "volume": volume, "side": side, "scope": scope },
                "algorithmId": SEGMENT_ALGORITHM_ID,
                "algorithmVersion": "1",
                "dependencyRecipeIds": [],
                "staleCauses": [],
                "lastSuccess": {
                    "generation": generation,
                    "sourceFingerprint": source_fingerprint,
                    "outputs": [{
                        "slotId": source.representation_slot,
                        "outputId": source.entity.id,
                        "revision": next_revision,
                        "contentHash": geometry_hash
                    }],
                    "completedAt": completed_at
                },
                "lastError": null,
                "detach": null
            });
            let mut edit_chain = source
                .source_attributes
                .get("hcad.point-cloud-edit-chain@1")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "schemaVersion": 1, "edits": [] }));
            let edits = edit_chain
                .get_mut("edits")
                .and_then(serde_json::Value::as_array_mut)
                .ok_or_else(|| {
                    CanonicalAppRuntimeError::InvalidResidency(
                        "point-cloud edit chain is malformed".to_owned(),
                    )
                })?;
            edits.push(recipe.clone());
            let components = merge_object(
                source.source_components,
                "hcad.prepared-dataset@1",
                serde_json::json!({ "formatId": "potree@2", "datasetId": dataset_id }),
            )?;
            let attributes = merge_object(
                merge_object(
                    source.source_attributes,
                    "hcad.point-cloud-edit-chain@1",
                    edit_chain,
                )?,
                "hcad.derived-recipe@1",
                recipe,
            )?;
            let components_object =
                canonical_json("application/vnd.himmelcad.components+json", components)?;
            let attributes_object =
                canonical_json("application/vnd.himmelcad.attributes+json", attributes)?;
            let relations_object = canonical_json(
                "application/vnd.himmelcad.relations+json",
                source.source_relations,
            )?;
            let mut entity_after = source.entity.clone();
            entity_after.revision = next_revision;
            entity_after.representations = vec![representation.clone()];
            entity_after.components_ref = components_object.object_hash.clone();
            entity_after.attributes_ref = attributes_object.object_hash.clone();
            entity_after.relations_ref = relations_object.object_hash.clone();
            entity_after.version_hash = canonical_entity_version_hash(&entity_after)
                .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;

            mutations.push(CanonicalEntityMutation::Update {
                expected: source.expected,
                edits: vec![
                    CanonicalEntityEdit::SetRepresentations {
                        representations: entity_after.representations.clone(),
                    },
                    CanonicalEntityEdit::SetComponentsRef {
                        components_ref: entity_after.components_ref.clone(),
                    },
                    CanonicalEntityEdit::SetAttributesRef {
                        attributes_ref: entity_after.attributes_ref.clone(),
                    },
                    CanonicalEntityEdit::SetRelationsRef {
                        relations_ref: entity_after.relations_ref.clone(),
                    },
                ],
            });
            roots.insert(dataset_id.clone(), prepared.dataset.root.clone());
            datasets.push(dataset);
            objects.extend([components_object, attributes_object, relations_object]);
            admissions.push(CanonicalRepresentationAdmission {
                entity: entity_after.clone(),
                selected: representation,
                representation_slot: source.representation_slot,
                expected_generation: None,
                resolved_geometry: geometry,
            });
            revisions.push(CanonicalSegmentRevision {
                entity_id: entity_after.id.0,
                revision: entity_after.revision,
                dataset_id,
                retained_points: prepared.summary.retained_points,
                removed_points: prepared.summary.removed_points,
            });
        }

        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: SEGMENT_ALGORITHM_ID.to_owned(),
            provider_version: "1".to_owned(),
            admissions,
            objects,
            datasets,
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let source_roots = CanonicalImportSourceRoots {
            datasets: roots,
            resource_sets: Default::default(),
        };
        let commit = self
            .store_mut()?
            .publish_package_transaction_with_progress_and_cancel(
                &package,
                &source_roots,
                CanonicalCommandTransaction {
                    command_id,
                    mutations,
                },
                progress,
                is_cancelled,
            )?;
        Ok(CanonicalSegmentCommit {
            journal_entry: commit.journal_entry,
            revisions,
        })
    }

    /// Publishes one PC-D8 sampled cloud without changing the captured source revision.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_sampled_cloud(
        &mut self,
        source: CanonicalGroundSource,
        prepared: &PreparedSampleResult,
        command_id: String,
        entity_id: String,
        output_name: String,
        parameters: serde_json::Value,
        scope: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(CanonicalImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalSampleCommit, CanonicalAppRuntimeError> {
        self.ensure_pointcloud_source_current(&source.expected)?;
        let dataset_id = derived_point_dataset_id("sample", SAMPLE_ALGORITHM_ID, &prepared.sampled);
        let (dataset, geometry, representation) =
            ground_dataset_contract(&prepared.sampled, &dataset_id, &entity_id, "source")?;
        let geometry_hash = representation.geometry_ref.clone();
        let recipe_parameters = serde_json::json!({
            "sampling": parameters,
            "scope": scope,
            "randomSeed": crate::pointcloud_sampling::RANDOM_SEED,
            "stableTieRule": prepared.summary.stable_tie_rule,
        });
        let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "parameters": recipe_parameters,
        }))?);
        let recipe_id = format!(
            "sample-recipe-{}",
            &prepared.summary.selection_sha256.as_str()[..24]
        );
        let recipe = derived_recipe_value(
            &recipe_id,
            SAMPLE_ALGORITHM_ID,
            &entity_id,
            "sampled",
            "sampled_cloud",
            built_in_type::POINT_CLOUD,
            &geometry_hash,
            &source,
            "point_cloud_source",
            recipe_parameters,
            source_fingerprint,
            completed_at,
        );
        let mut mesh_source_roles = mesh_source_roles(
            &entity_id,
            &geometry_hash,
            "sampled_cloud",
            source
                .entity
                .placement
                .unwrap_or(himmelcad_core::entity_model::Transform3d::IDENTITY),
            Some(prepared.summary.selection_sha256.clone()),
        )?;
        mesh_source_roles.content_hash =
            ObjectHash::of_bytes(&serde_json::to_vec(&mesh_source_roles)?);
        let components = canonical_json(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({
                "hcad.prepared-dataset@1": {
                    "formatId": "potree@2",
                    "datasetId": dataset_id,
                },
                "hcad.mesh-source-roles@1": mesh_source_roles,
            }),
        )?;
        let attributes = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.pointcloud.sample@1": {
                    "algorithmId": SAMPLE_ALGORITHM_ID,
                    "summary": prepared.summary,
                },
                "hcad.derived-recipe@1": recipe,
            }),
        )?;
        let relations = canonical_json(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([{
                "kind": "derivedFrom",
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "role": "point_cloud_source",
            }]),
        )?;
        let style = source
            .source_style
            .map(|value| {
                canonical_json("application/vnd.himmelcad.point-cloud-display+json", value)
            })
            .transpose()?;
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: output_name,
            owner: source.entity.owner.clone(),
            layer_ids: source.entity.layer_ids.clone(),
            placement: source.entity.placement,
            representations: vec![representation.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: style.as_ref().map(|value| value.object_hash.clone()),
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized sampled cloud"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        let mut objects = vec![components, attributes, relations];
        if let Some(style) = style {
            objects.push(style);
        }
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: SAMPLE_ALGORITHM_ID.to_owned(),
            provider_version: "1".to_owned(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity: entity.clone(),
                selected: representation,
                representation_slot: "source".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects,
            datasets: vec![dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let roots = CanonicalImportSourceRoots {
            datasets: [(dataset_id.clone(), prepared.sampled.root.clone())]
                .into_iter()
                .collect(),
            resource_sets: Default::default(),
        };
        let transaction = CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Create {
                entity: entity.clone(),
            }],
        };
        let commit = self
            .store_mut()?
            .publish_package_transaction_with_progress_and_cancel(
                &package,
                &roots,
                transaction,
                progress,
                is_cancelled,
            )?;
        Ok(CanonicalSampleCommit {
            journal_entry: commit.journal_entry,
            entity_id: entity.id.0,
            revision: entity.revision,
            dataset_id,
        })
    }

    /// Publishes one PC-D17 prepared grid. Count rasters remain RasterImage and are not Mesh height sources.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_height_grid(
        &mut self,
        source: CanonicalGroundSource,
        prepared: &PreparedHeightGrid,
        command_id: String,
        entity_id: String,
        output_name: String,
        parameters: serde_json::Value,
        scope: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(CanonicalImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalRasterizeCommit, CanonicalAppRuntimeError> {
        self.ensure_pointcloud_source_current(&source.expected)?;
        let resource = GeometryResource {
            object_hash: prepared.artifact.object_hash.clone(),
            media_type: prepared.artifact.media_type.clone(),
            byte_length: Some(prepared.artifact.byte_length),
        };
        let mapping = OrthoGridMapping {
            origin: Vector3 {
                x: prepared.summary.origin[0],
                y: prepared.summary.origin[1],
                z: 0.0,
            },
            column_step: Vector3 {
                x: prepared.summary.cell_size_m,
                y: 0.0,
                z: 0.0,
            },
            row_step: Vector3 {
                x: 0.0,
                y: prepared.summary.cell_size_m,
                z: 0.0,
            },
        };
        let (entity_type, geometry) = if prepared.summary.aggregation == RasterAggregation::Count {
            (
                built_in_type::RASTER_IMAGE,
                GeometryObject::RasterImage {
                    raster: Box::new(RasterImageGeometry {
                        pixels: resource.clone(),
                        width: prepared.summary.width,
                        height: prepared.summary.height,
                        mapping: RasterMapping::OrthoGrid(mapping),
                        depth: None,
                    }),
                },
            )
        } else {
            (
                built_in_type::ELEVATION_SURFACE,
                GeometryObject::ElevationSurface {
                    surface: Box::new(ElevationSurfaceGeometry::Grid {
                        raster: resource.clone(),
                        mapping,
                        sampling: DepthSampling {
                            semantics: DepthSemantics::ElevationZ,
                            interpolation: RasterInterpolation::Nearest,
                            connectivity: RasterConnectivity::PixelSteps,
                        },
                    }),
                },
            )
        };
        let representation = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry)
                .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?,
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let geometry_hash = representation.geometry_ref.clone();
        let dataset_id = format!(
            "height-grid-{}",
            &prepared.summary.cell_sha256.as_str()[..32]
        );
        let dataset = CanonicalPreparedDataset {
            dataset_id: dataset_id.clone(),
            format_id: HEIGHT_GRID_FORMAT_ID.to_owned(),
            entity_id: entity_id.clone(),
            representation_slot: "source".to_owned(),
            root_metadata: resource,
            artifacts: vec![PreparedDatasetArtifact {
                relative_path: PathBuf::from(&prepared.artifact.relative_path),
                resource: GeometryResource {
                    object_hash: prepared.artifact.object_hash.clone(),
                    media_type: prepared.artifact.media_type.clone(),
                    byte_length: Some(prepared.artifact.byte_length),
                },
            }],
        };
        let recipe_parameters = serde_json::json!({
            "rasterize": parameters,
            "scope": scope,
            "cellRecord": "valid:u8,value:f64le,count:u64le,variance:f64le",
        });
        let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "parameters": recipe_parameters,
        }))?);
        let recipe_id = format!(
            "height-grid-recipe-{}",
            &prepared.summary.cell_sha256.as_str()[..24]
        );
        let output_role = if prepared.summary.mesh_eligible {
            "grid_source"
        } else {
            "count_grid"
        };
        let recipe = derived_recipe_value(
            &recipe_id,
            RASTERIZE_ALGORITHM_ID,
            &entity_id,
            "grid",
            output_role,
            entity_type,
            &geometry_hash,
            &source,
            "point_cloud_source",
            recipe_parameters,
            source_fingerprint,
            completed_at,
        );
        let mesh_roles = if prepared.summary.mesh_eligible {
            let mut value = mesh_source_roles(
                &entity_id,
                &geometry_hash,
                "grid_source",
                himmelcad_core::entity_model::Transform3d::IDENTITY,
                Some(prepared.summary.cell_sha256.clone()),
            )?;
            value.content_hash = ObjectHash::of_bytes(&serde_json::to_vec(&value)?);
            Some(value)
        } else {
            None
        };
        let mut component_value = serde_json::json!({
            "hcad.prepared-dataset@1": {
                "formatId": HEIGHT_GRID_FORMAT_ID,
                "datasetId": dataset_id,
            }
        });
        if let Some(mesh_roles) = mesh_roles {
            component_value
                .as_object_mut()
                .expect("component object")
                .insert(
                    "hcad.mesh-source-roles@1".to_owned(),
                    serde_json::to_value(mesh_roles)?,
                );
        }
        let components =
            canonical_json("application/vnd.himmelcad.components+json", component_value)?;
        let attributes = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.pointcloud.height-grid@1": {
                    "algorithmId": RASTERIZE_ALGORITHM_ID,
                    "summary": prepared.summary,
                    "outputRole": output_role,
                },
                "hcad.derived-recipe@1": recipe,
            }),
        )?;
        let relations = canonical_json(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([{
                "kind": "derivedFrom",
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "role": "point_cloud_source",
            }]),
        )?;
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(entity_type.to_owned()),
            name: output_name,
            owner: source.entity.owner.clone(),
            layer_ids: source.entity.layer_ids.clone(),
            // Rasterization is in project XY/Z after applying the captured source placement.
            placement: None,
            representations: vec![representation.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized height grid"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: RASTERIZE_ALGORITHM_ID.to_owned(),
            provider_version: "1".to_owned(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity: entity.clone(),
                selected: representation,
                representation_slot: "source".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects: vec![components, attributes, relations],
            datasets: vec![dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let roots = CanonicalImportSourceRoots {
            datasets: [(dataset_id.clone(), prepared.root.clone())]
                .into_iter()
                .collect(),
            resource_sets: Default::default(),
        };
        let transaction = CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Create {
                entity: entity.clone(),
            }],
        };
        let commit = self
            .store_mut()?
            .publish_package_transaction_with_progress_and_cancel(
                &package,
                &roots,
                transaction,
                progress,
                is_cancelled,
            )?;
        Ok(CanonicalRasterizeCommit {
            journal_entry: commit.journal_entry,
            entity_id: entity.id.0,
            revision: entity.revision,
            dataset_id,
            entity_type: entity_type.to_owned(),
            mesh_source_role: prepared
                .summary
                .mesh_eligible
                .then(|| "grid_source".to_owned()),
        })
    }

    fn ensure_pointcloud_source_current(
        &self,
        expected: &EntityVersionRef,
    ) -> Result<(), CanonicalAppRuntimeError> {
        let current = self
            .residency_bootstrap()?
            .entries
            .into_iter()
            .find(|entry| entry.admission.entity.id == expected.id)
            .map(|entry| EntityVersionRef::from_entity(&entry.admission.entity));
        if current.as_ref() != Some(expected) {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "source point-cloud revision changed before derived publication".to_owned(),
            ));
        }
        Ok(())
    }

    /// Persists one canonical display resource and assigns it to exact live clouds.
    pub fn set_point_cloud_display(
        &mut self,
        command_id: String,
        entities: Vec<EntityVersionRef>,
        display: PointCloudDisplayStyle,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        display
            .validate()
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?;
        if entities.is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "point-cloud display edit requires at least one entity".to_owned(),
            ));
        }
        let value = serde_json::to_value(&display)?;
        let bytes = serde_json::to_vec(&value)?;
        let style_ref = ObjectHash::of_bytes(&bytes);
        let object = CanonicalJsonObject {
            object_hash: style_ref.clone(),
            media_type: "application/vnd.himmelcad.point-cloud-display+json".to_owned(),
            value,
        };
        let store = self.store_mut()?;
        for expected in &entities {
            let entity = store.document().entity(&expected.id).ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "point-cloud entity {:?} is no longer live",
                    expected.id.0
                ))
            })?;
            if entity.type_id.0 != built_in_type::POINT_CLOUD {
                return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                    "entity {:?} is not a point cloud",
                    expected.id.0
                )));
            }
        }
        store.put_json_object(&object)?;
        store
            .queue_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: entities
                    .into_iter()
                    .map(|expected| CanonicalEntityMutation::Update {
                        expected,
                        edits: vec![CanonicalEntityEdit::SetStyleRef {
                            style_ref: Some(style_ref.clone()),
                        }],
                    })
                    .collect(),
            })
            .map_err(Into::into)
    }

    /// Reconstructs exact admissions for live entities without exposing host
    /// paths. Deleted entities and superseded representation bindings are
    /// intentionally omitted.
    pub fn residency_bootstrap(
        &self,
    ) -> Result<CanonicalResidencyBootstrap, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut entries = Vec::new();
        let mut slots = std::collections::BTreeSet::new();
        for inventory in store.import_inventories()? {
            for stored in &inventory.admissions {
                let entity_id = EntityId(stored.entity_id.clone());
                let Some(entity) = store.document().entity(&entity_id) else {
                    continue;
                };
                if stored.geometry_ref != stored.selected.geometry_ref
                    || !entity
                        .representations
                        .iter()
                        .any(|representation| representation == &stored.selected)
                {
                    // The entity is live but this historical slot was replaced.
                    continue;
                }
                let slot = (stored.entity_id.clone(), stored.representation_slot.clone());
                if !slots.insert(slot.clone()) {
                    return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                        "duplicate live representation slot {slot:?}"
                    )));
                }
                let geometry_bytes = store.read_object(&stored.geometry_ref)?;
                let geometry: GeometryObject =
                    serde_json::from_slice(&geometry_bytes).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(error.to_string())
                    })?;
                validate_resolved_representation(entity, &stored.selected, &geometry).map_err(
                    |error| {
                        let observed = geometry_object_content_hash(&geometry)
                            .map(|hash| hash.0)
                            .unwrap_or_else(|hash_error| hash_error.to_string());
                        CanonicalAppRuntimeError::InvalidResidency(format!(
                            "entity {:?} slot {:?}: {error}; expected {}, observed {observed}",
                            stored.entity_id,
                            stored.representation_slot,
                            stored.selected.geometry_ref.0,
                        ))
                    },
                )?;
                let matching_datasets = inventory
                    .datasets
                    .iter()
                    .filter(|dataset| {
                        dataset.entity_id == stored.entity_id
                            && dataset.representation_slot == stored.representation_slot
                    })
                    .collect::<Vec<_>>();
                if matching_datasets.len() > 1 {
                    return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                        "multiple datasets bind representation slot {slot:?}"
                    )));
                }
                let dataset = matching_datasets.first().copied().cloned();
                if let Some(dataset) = &dataset {
                    validate_residency_dataset(store, dataset)?;
                }
                let point_cloud = point_cloud_metadata(store, entity, &geometry)?;
                entries.push(CanonicalResidencyEntry {
                    provider_id: inventory.provider_id.clone(),
                    provider_version: inventory.provider_version.clone(),
                    admission: CanonicalRepresentationAdmission {
                        entity: entity.clone(),
                        selected: stored.selected.clone(),
                        representation_slot: stored.representation_slot.clone(),
                        expected_generation: None,
                        resolved_geometry: geometry,
                    },
                    dataset,
                    point_cloud,
                });
            }
        }
        entries.sort_by(|left, right| {
            (
                &left.admission.entity.id.0,
                &left.admission.representation_slot,
            )
                .cmp(&(
                    &right.admission.entity.id.0,
                    &right.admission.representation_slot,
                ))
        });
        Ok(CanonicalResidencyBootstrap {
            schema_version: 1,
            generation: store.document().generation(),
            entries,
        })
    }

    /// Returns the immutable PhotoLab provenance component for exact live
    /// entities. Missing components are represented by omission, never by a
    /// reconstructed source-project value.
    pub fn photolab_product_provenance(
        &self,
        entity_ids: &[String],
    ) -> Result<Vec<serde_json::Value>, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut result = Vec::new();
        for entity_id in entity_ids {
            let Some(entity) = store.document().entity(&EntityId(entity_id.clone())) else {
                continue;
            };
            let components: serde_json::Value =
                serde_json::from_slice(&store.read_object(&entity.components_ref)?)?;
            if let Some(provenance) = components.get("hcad.photolab-product-provenance@1") {
                result.push(serde_json::json!({
                    "entityId": entity_id,
                    "componentSha256": entity.components_ref,
                    "provenance": provenance,
                }));
            }
        }
        Ok(result)
    }

    /// Returns a deterministic bounded sample of one live committed Potree point cloud.
    pub fn registration_point_cloud_samples(
        &self,
        dataset_id: &str,
        maximum_samples: usize,
    ) -> Result<RegistrationSourceSamples, CanonicalAppRuntimeError> {
        let bootstrap = self.residency_bootstrap()?;
        let entry = bootstrap
            .entries
            .into_iter()
            .find(|entry| {
                entry
                    .dataset
                    .as_ref()
                    .is_some_and(|dataset| dataset.dataset_id == dataset_id)
            })
            .ok_or_else(|| {
                CanonicalAppRuntimeError::RegistrationSamples(format!(
                    "unknown live dataset {dataset_id:?}"
                ))
            })?;
        let dataset = entry.dataset.ok_or_else(|| {
            CanonicalAppRuntimeError::RegistrationSamples("dataset is missing".to_owned())
        })?;
        if dataset.format_id != "potree@2"
            || !matches!(
                entry.admission.resolved_geometry,
                GeometryObject::PointCloud { .. }
            )
        {
            return Err(CanonicalAppRuntimeError::RegistrationSamples(
                "dataset is not a Potree point cloud".to_owned(),
            ));
        }
        let metadata_hash = dataset.root_metadata.object_hash.clone();
        let hierarchy_hash = dataset
            .artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("hierarchy.bin"))
            .map(|artifact| artifact.resource.object_hash.clone())
            .ok_or_else(|| {
                CanonicalAppRuntimeError::RegistrationSamples(
                    "Potree hierarchy artifact is missing".to_owned(),
                )
            })?;
        let octree_hash = dataset
            .artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("octree.bin"))
            .map(|artifact| artifact.resource.object_hash.clone())
            .ok_or_else(|| {
                CanonicalAppRuntimeError::RegistrationSamples(
                    "Potree octree artifact is missing".to_owned(),
                )
            })?;
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let (_, mut metadata_file) = store.verified_object_source(&metadata_hash)?;
        let (_, mut hierarchy_file) = store.verified_object_source(&hierarchy_hash)?;
        let (_, mut octree_file) = store.verified_object_source(&octree_hash)?;
        sample_potree_open_files(
            "project-point-cloud",
            dataset_id,
            [metadata_hash.0, hierarchy_hash.0, octree_hash.0],
            entry.admission.entity.placement,
            maximum_samples,
            PotreeOpenFiles {
                metadata: &mut metadata_file,
                hierarchy: &mut hierarchy_file,
                octree: &mut octree_file,
            },
        )
        .map_err(registration_sample_error)
    }

    /// Reconstructs the exact currently-live canonical package published by
    /// one import command. The provider/version and immutable presentation
    /// resources come from the durable inventory; entity envelopes and
    /// geometry are resolved from the authoritative document and object store.
    pub fn reconstruct_import_package(
        &self,
        command_id: &str,
    ) -> Result<CanonicalImportPackage, CanonicalAppRuntimeError> {
        let store = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
        let inventory = store
            .import_inventories()?
            .into_iter()
            .find(|inventory| inventory.command_id == command_id)
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "unknown import command {command_id:?}"
                ))
            })?;
        let mut admissions = Vec::with_capacity(inventory.admissions.len());
        let mut required_json = BTreeSet::new();
        for stored in &inventory.admissions {
            let entity = store
                .document()
                .entity(&EntityId(stored.entity_id.clone()))
                .ok_or_else(|| {
                    CanonicalAppRuntimeError::InvalidImportInventory(format!(
                        "entity {:?} is no longer live",
                        stored.entity_id
                    ))
                })?
                .clone();
            if !entity.representations.contains(&stored.selected)
                || stored.geometry_ref != stored.selected.geometry_ref
            {
                return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "entity {:?} no longer has representation slot {:?}",
                    stored.entity_id, stored.representation_slot
                )));
            }
            let resolved_geometry: GeometryObject = serde_json::from_slice(
                &store.read_object(&stored.geometry_ref)?,
            )
            .map_err(|error| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "geometry {:?} is invalid: {error}",
                    stored.geometry_ref
                ))
            })?;
            validate_resolved_representation(&entity, &stored.selected, &resolved_geometry)
                .map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(error.to_string())
                })?;
            required_json.extend([
                entity.components_ref.0.clone(),
                entity.attributes_ref.0.clone(),
                entity.relations_ref.0.clone(),
            ]);
            admissions.push(CanonicalRepresentationAdmission {
                entity,
                selected: stored.selected.clone(),
                representation_slot: stored.representation_slot.clone(),
                expected_generation: None,
                resolved_geometry,
            });
        }
        let metadata = inventory
            .objects
            .iter()
            .map(|object| (object.object_hash.0.clone(), object))
            .collect::<BTreeMap<_, _>>();
        let mut objects = Vec::with_capacity(required_json.len());
        for object_hash_text in required_json {
            let object_hash = ObjectHash(object_hash_text.clone());
            let stored = metadata.get(&object_hash_text).ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "required JSON object {object_hash:?} is absent"
                ))
            })?;
            let bytes = store.read_object(&object_hash)?;
            if stored.byte_length != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
                return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "required JSON object {object_hash:?} has the wrong length"
                )));
            }
            objects.push(CanonicalJsonObject {
                object_hash,
                media_type: stored.media_type.clone(),
                value: serde_json::from_slice(&bytes).map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(format!(
                        "required JSON object is invalid: {error}"
                    ))
                })?,
            });
        }
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: inventory.provider_id,
            provider_version: inventory.provider_version,
            admissions,
            objects,
            datasets: inventory.datasets,
            resource_sets: inventory.resource_sets,
            presentation_resources: inventory.presentation_resources,
        };
        package
            .validate()
            .map_err(|error| CanonicalAppRuntimeError::InvalidImportInventory(error.to_string()))?;
        Ok(package)
    }

    /// Captures exact live canonical entities into one provider-neutral export package.
    ///
    /// The UI supplies user-facing Selection/Visible/Project scope as entity IDs; import
    /// command identities remain an internal persistence seam. A resource-backed TIN is
    /// resolved from its authoritative section topology so the existing DXF/LandXML writers
    /// receive the same exact triangles as inline geometry.
    pub fn reconstruct_export_package(
        &self,
        entity_ids: &[String],
    ) -> Result<CanonicalImportPackage, CanonicalAppRuntimeError> {
        if entity_ids.is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidImportInventory(
                "export scope contains no canonical entities".to_owned(),
            ));
        }
        let requested = entity_ids.iter().cloned().collect::<BTreeSet<_>>();
        if requested.len() != entity_ids.len() {
            return Err(CanonicalAppRuntimeError::InvalidImportInventory(
                "export scope contains duplicate canonical entities".to_owned(),
            ));
        }
        let inventories = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?
            .import_inventories()?;
        let mut remaining = requested.clone();
        let mut contributors = Vec::new();
        for inventory in inventories.iter().rev() {
            if !inventory
                .admissions
                .iter()
                .any(|admission| remaining.contains(&admission.entity_id))
            {
                continue;
            }
            let Ok(package) = self.reconstruct_import_package(&inventory.command_id) else {
                continue;
            };
            let captured = package
                .admissions
                .iter()
                .filter(|admission| remaining.contains(&admission.entity.id.0))
                .map(|admission| admission.entity.id.0.clone())
                .collect::<BTreeSet<_>>();
            if captured.is_empty() {
                continue;
            }
            remaining.retain(|id| !captured.contains(id));
            contributors.push((package, captured));
            if remaining.is_empty() {
                break;
            }
        }
        if !remaining.is_empty() {
            let store = self
                .store()
                .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
            let mut admissions = Vec::new();
            let mut objects = Vec::new();
            let mut object_hashes = BTreeSet::new();
            let mut captured = BTreeSet::new();
            for entity_id in &remaining {
                let Some(entity) = store
                    .document()
                    .entity(&EntityId(entity_id.clone()))
                    .cloned()
                else {
                    continue;
                };
                let Some(selected) = entity
                    .representations
                    .iter()
                    .find(|representation| representation.role == RepresentationRole::Canonical)
                    .or_else(|| entity.representations.first())
                    .cloned()
                else {
                    continue;
                };
                let geometry: GeometryObject = serde_json::from_slice(
                    &store.read_object(&selected.geometry_ref)?,
                )
                .map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(format!(
                        "entity {entity_id:?} geometry is invalid: {error}"
                    ))
                })?;
                for object_hash in [
                    &entity.components_ref,
                    &entity.attributes_ref,
                    &entity.relations_ref,
                ] {
                    if !object_hashes.insert(object_hash.0.clone()) {
                        continue;
                    }
                    let bytes = store.read_object(object_hash)?;
                    let value = serde_json::from_slice(&bytes).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidImportInventory(format!(
                            "entity {entity_id:?} metadata is invalid: {error}"
                        ))
                    })?;
                    let (metadata, _) = store.verified_object_source(object_hash)?;
                    objects.push(CanonicalJsonObject {
                        object_hash: object_hash.clone(),
                        media_type: metadata.media_type,
                        value,
                    });
                }
                admissions.push(CanonicalRepresentationAdmission {
                    entity,
                    selected,
                    representation_slot: "source".to_owned(),
                    expected_generation: None,
                    resolved_geometry: geometry,
                });
                captured.insert(entity_id.clone());
            }
            if !captured.is_empty() {
                remaining.retain(|id| !captured.contains(id));
                contributors.push((
                    CanonicalImportPackage {
                        schema_version: CANONICAL_IO_SCHEMA_VERSION,
                        provider_id: "hcad.authored.scope@1".to_owned(),
                        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                        admissions,
                        objects,
                        datasets: Vec::new(),
                        resource_sets: Vec::new(),
                        presentation_resources: CanonicalPresentationResourceSet::default(),
                    },
                    captured,
                ));
            }
        }
        if !remaining.is_empty() {
            return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
                "export scope contains entities without a live canonical representation: {}",
                remaining.into_iter().collect::<Vec<_>>().join(", ")
            )));
        }
        if contributors.len() == 1 {
            let (mut package, captured) = contributors.pop().expect("one contributor");
            if captured.len() == package.admissions.len() {
                self.inline_resource_tins(&mut package)?;
                package.validate().map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(error.to_string())
                })?;
                return Ok(package);
            }
            contributors.push((package, captured));
        }

        let mut package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "hcad.export.scope@1".to_owned(),
            provider_version: env!("CARGO_PKG_VERSION").to_owned(),
            admissions: Vec::new(),
            objects: Vec::new(),
            datasets: Vec::new(),
            resource_sets: Vec::new(),
            presentation_resources: CanonicalPresentationResourceSet::default(),
        };
        let mut object_hashes = BTreeSet::new();
        let mut dataset_ids = BTreeSet::new();
        let mut resource_set_ids = BTreeSet::new();
        for (source, captured) in contributors {
            package.admissions.extend(
                source
                    .admissions
                    .into_iter()
                    .filter(|admission| captured.contains(&admission.entity.id.0)),
            );
            package.objects.extend(
                source
                    .objects
                    .into_iter()
                    .filter(|object| object_hashes.insert(object.object_hash.0.clone())),
            );
            package
                .datasets
                .extend(source.datasets.into_iter().filter(|dataset| {
                    captured.contains(&dataset.entity_id)
                        && dataset_ids.insert(dataset.dataset_id.clone())
                }));
            package.resource_sets.extend(
                source
                    .resource_sets
                    .into_iter()
                    .filter(|set| resource_set_ids.insert(set.resource_set_id.clone())),
            );
            merge_presentation_resources(
                &mut package.presentation_resources,
                source.presentation_resources,
            );
        }
        package
            .admissions
            .sort_by(|left, right| left.entity.id.0.cmp(&right.entity.id.0));
        self.inline_resource_tins(&mut package)?;
        package
            .validate()
            .map_err(|error| CanonicalAppRuntimeError::InvalidImportInventory(error.to_string()))?;
        Ok(package)
    }

    fn inline_resource_tins(
        &self,
        package: &mut CanonicalImportPackage,
    ) -> Result<(), CanonicalAppRuntimeError> {
        let store = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut converted_entities = BTreeSet::new();
        for admission in &mut package.admissions {
            let GeometryObject::ElevationSurface { surface } = &mut admission.resolved_geometry
            else {
                continue;
            };
            let ElevationSurfaceGeometry::Tin { mesh, .. } = surface.as_mut() else {
                continue;
            };
            let TriangleMeshStorage::Resource { resource } = &mesh.storage else {
                continue;
            };
            let dataset = package
                .datasets
                .iter()
                .find(|dataset| {
                    dataset.entity_id == admission.entity.id.0
                        && dataset.representation_slot == admission.representation_slot
                        && dataset.root_metadata == *resource
                })
                .ok_or_else(|| {
                    CanonicalAppRuntimeError::InvalidImportInventory(format!(
                        "surface {:?} has no authoritative export topology",
                        admission.entity.id.0
                    ))
                })?;
            let (positions, indices) = read_export_topology(store, dataset)?;
            mesh.storage = TriangleMeshStorage::Inline {
                positions,
                indices,
                normals: None,
                texture_coordinates: None,
            };
            mesh.triangle_material_slots = None;
            mesh.materials = None;
            let geometry_hash = geometry_object_content_hash(&admission.resolved_geometry)
                .map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(error.to_string())
                })?;
            admission.selected.geometry_ref = geometry_hash.clone();
            let representation = admission
                .entity
                .representations
                .iter_mut()
                .find(|representation| representation.role == admission.selected.role)
                .ok_or_else(|| {
                    CanonicalAppRuntimeError::InvalidImportInventory(
                        "selected export representation disappeared".to_owned(),
                    )
                })?;
            *representation = admission.selected.clone();
            admission.entity.version_hash = canonical_entity_version_hash(&admission.entity)
                .map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(error.to_string())
                })?;
            converted_entities.insert(admission.entity.id.0.clone());
        }
        package
            .datasets
            .retain(|dataset| !converted_entities.contains(&dataset.entity_id));
        Ok(())
    }

    /// Recreates provider-relative immutable artifact layouts below a
    /// sidecar-owned execution root for exact passthrough exporters.
    pub fn materialize_import_artifacts(
        &self,
        command_id: &str,
        prepared_root: &Path,
    ) -> Result<(), CanonicalAppRuntimeError> {
        let store = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
        let inventory = store
            .import_inventories()?
            .into_iter()
            .find(|inventory| inventory.command_id == command_id)
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "unknown import command {command_id:?}"
                ))
            })?;
        let mut destinations = BTreeMap::<PathBuf, ObjectHash>::new();
        for dataset in &inventory.datasets {
            for artifact in &dataset.artifacts {
                let destination = prepared_root
                    .join(&dataset.dataset_id)
                    .join(&artifact.relative_path);
                register_materialized_destination(
                    &mut destinations,
                    destination,
                    artifact.resource.object_hash.clone(),
                )?;
            }
        }
        for resource_set in &inventory.resource_sets {
            for artifact in &resource_set.resources {
                let destination = prepared_root.join(&artifact.relative_path);
                register_materialized_destination(
                    &mut destinations,
                    destination,
                    artifact.resource.object_hash.clone(),
                )?;
            }
        }
        for (destination, object_hash) in destinations {
            store.materialize_object(&object_hash, destination)?;
        }
        Ok(())
    }

    /// Materializes only immutable artifacts retained by the captured export package.
    pub fn materialize_export_artifacts(
        &self,
        package: &CanonicalImportPackage,
        prepared_root: &Path,
    ) -> Result<(), CanonicalAppRuntimeError> {
        let store = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut destinations = BTreeMap::<PathBuf, ObjectHash>::new();
        for dataset in &package.datasets {
            for artifact in &dataset.artifacts {
                register_materialized_destination(
                    &mut destinations,
                    prepared_root
                        .join(&dataset.dataset_id)
                        .join(&artifact.relative_path),
                    artifact.resource.object_hash.clone(),
                )?;
            }
        }
        for resource_set in &package.resource_sets {
            for artifact in &resource_set.resources {
                register_materialized_destination(
                    &mut destinations,
                    prepared_root.join(&artifact.relative_path),
                    artifact.resource.object_hash.clone(),
                )?;
            }
        }
        for (destination, object_hash) in destinations {
            store.materialize_object(&object_hash, destination)?;
        }
        Ok(())
    }

    /// Dispatches one versioned application request and always returns a
    /// correlated protocol response, including structured failures.
    #[must_use]
    pub fn dispatch(
        &mut self,
        envelope: AppProtocolRequestEnvelope,
    ) -> AppProtocolResponseEnvelope {
        let request_id = envelope.request_id.clone();
        let extensions = envelope.extensions.clone();
        let response = match validate_request_envelope(&envelope) {
            Ok(()) => self.dispatch_valid(envelope.request),
            Err(error) => AppProtocolResponse::Error(map_envelope_error(error)),
        };
        AppProtocolResponseEnvelope {
            schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
            request_id,
            response,
            extensions,
        }
    }

    fn dispatch_valid(&mut self, request: AppProtocolRequest) -> AppProtocolResponse {
        let result = match request {
            AppProtocolRequest::ReadPropertySchemas => {
                return AppProtocolResponse::PropertySchemas(vec![
                    canonical_entity_property_schema(),
                ]);
            }
            AppProtocolRequest::ReadDocumentSnapshot => self.store().map(|store| {
                AppProtocolResponse::DocumentSnapshot(AppDocumentSnapshot::from_document(
                    store.document(),
                ))
            }),
            AppProtocolRequest::ReadJournal(request) => self.store().and_then(|store| {
                read_journal_page(store.document(), request)
                    .map(AppProtocolResponse::JournalPage)
                    .map_err(CanonicalAppDispatchError::from)
            }),
            AppProtocolRequest::QueryProperties(request) => self.store().and_then(|store| {
                query_properties(store.document(), &request)
                    .map(AppProtocolResponse::PropertyQuery)
                    .map_err(CanonicalAppDispatchError::from)
            }),
            AppProtocolRequest::CompilePropertyEdit(request) => self.store().and_then(|store| {
                compile_multi_entity_property_edit(store.document(), &request)
                    .map(AppProtocolResponse::CompiledTransaction)
                    .map_err(CanonicalAppDispatchError::from)
            }),
            AppProtocolRequest::ExecuteCanonicalTransaction(transaction) => {
                self.dispatch_store_mut().and_then(|store| {
                    validate_transaction_object_refs(store, &transaction)?;
                    store
                        .queue_transaction(transaction)
                        .map(AppProtocolResponse::TransactionAccepted)
                        .map_err(CanonicalAppDispatchError::from)
                })
            }
        };
        result.unwrap_or_else(|error| AppProtocolResponse::Error(error.into_protocol_error()))
    }

    fn store(&self) -> Result<&CanonicalProjectStore, CanonicalAppDispatchError> {
        self.store
            .as_ref()
            .ok_or(CanonicalAppDispatchError::ProjectNotOpen)
    }

    fn store_mut(&mut self) -> Result<&mut CanonicalProjectStore, CanonicalAppRuntimeError> {
        self.store
            .as_mut()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)
    }

    fn dispatch_store_mut(
        &mut self,
    ) -> Result<&mut CanonicalProjectStore, CanonicalAppDispatchError> {
        self.store
            .as_mut()
            .ok_or(CanonicalAppDispatchError::ProjectNotOpen)
    }
}

fn registration_sample_error(error: ImportRegistrationRuntimeError) -> CanonicalAppRuntimeError {
    CanonicalAppRuntimeError::RegistrationSamples(error.to_string())
}

fn canonical_json(
    media_type: &str,
    value: serde_json::Value,
) -> Result<CanonicalJsonObject, CanonicalAppRuntimeError> {
    CanonicalJsonObject::new(media_type, value)
        .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))
}

fn merge_object(
    mut value: serde_json::Value,
    key: &str,
    extension: serde_json::Value,
) -> Result<serde_json::Value, CanonicalAppRuntimeError> {
    value
        .as_object_mut()
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(
                "point-cloud canonical component is not an object".to_owned(),
            )
        })?
        .insert(key.to_owned(), extension);
    Ok(value)
}

fn ground_dataset_id(prefix: &str, dataset: &PreparedGroundDataset) -> String {
    let mut digest = sha2::Sha256::new();
    use sha2::Digest as _;
    digest.update(crate::pointcloud_ground::GROUND_ALGORITHM_ID.as_bytes());
    digest.update(prefix.as_bytes());
    digest.update(dataset.point_count.to_le_bytes());
    for artifact in &dataset.artifacts {
        digest.update(artifact.relative_path.as_bytes());
        digest.update(artifact.object_hash.as_str().as_bytes());
        digest.update(artifact.byte_length.to_le_bytes());
    }
    format!("ground-{prefix}-{}", hex::encode(digest.finalize()))
}

fn segment_dataset_id(dataset: &PreparedGroundDataset) -> String {
    let mut digest = sha2::Sha256::new();
    use sha2::Digest as _;
    digest.update(SEGMENT_ALGORITHM_ID.as_bytes());
    digest.update(dataset.point_count.to_le_bytes());
    for artifact in &dataset.artifacts {
        digest.update(artifact.relative_path.as_bytes());
        digest.update(artifact.object_hash.as_str().as_bytes());
        digest.update(artifact.byte_length.to_le_bytes());
    }
    format!("segment-{}", hex::encode(digest.finalize()))
}

fn derived_point_dataset_id(
    prefix: &str,
    algorithm_id: &str,
    dataset: &PreparedGroundDataset,
) -> String {
    let mut digest = sha2::Sha256::new();
    use sha2::Digest as _;
    digest.update(algorithm_id.as_bytes());
    digest.update(prefix.as_bytes());
    digest.update(dataset.point_count.to_le_bytes());
    for artifact in &dataset.artifacts {
        digest.update(artifact.relative_path.as_bytes());
        digest.update(artifact.object_hash.as_str().as_bytes());
        digest.update(artifact.byte_length.to_le_bytes());
    }
    format!("{prefix}-{}", hex::encode(digest.finalize()))
}

#[allow(clippy::too_many_arguments)]
fn derived_recipe_value(
    recipe_id: &str,
    algorithm_id: &str,
    output_group_id: &str,
    slot_id: &str,
    output_role: &str,
    output_type: &str,
    output_hash: &ObjectHash,
    source: &CanonicalGroundSource,
    source_role: &str,
    parameters: serde_json::Value,
    source_fingerprint: ObjectHash,
    completed_at: String,
) -> serde_json::Value {
    serde_json::json!({
        "schemaId": "hcad.derived-recipe@1",
        "schemaVersion": 1,
        "recipeId": recipe_id,
        "recipeKind": algorithm_id,
        "generation": 1,
        "state": "linked-current",
        "outputGroupId": output_group_id,
        "outputs": [{
            "slotId": slot_id,
            "role": output_role,
            "outputId": output_group_id,
            "typeId": output_type,
            "locator": "source",
            "currentRevision": 0,
            "currentContentHash": output_hash,
            "status": "present",
        }],
        "sources": [{
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "placementRevision": source.entity.revision,
            "role": source_role,
        }],
        "parameterTypeId": algorithm_id,
        "parameters": parameters,
        "algorithmId": algorithm_id,
        "algorithmVersion": "1",
        "dependencyRecipeIds": [],
        "staleCauses": [],
        "lastSuccess": {
            "generation": 1,
            "sourceFingerprint": source_fingerprint,
            "outputs": [{
                "slotId": slot_id,
                "outputId": output_group_id,
                "revision": 0,
                "contentHash": output_hash,
            }],
            "completedAt": completed_at,
        },
        "lastError": null,
        "detach": null,
    })
}

fn mesh_source_roles(
    entity_id: &str,
    content_hash: &ObjectHash,
    source_role: &str,
    placement: himmelcad_core::entity_model::Transform3d,
    sampling_hash: Option<ObjectHash>,
) -> Result<MeshSourceRolesV1, CanonicalAppRuntimeError> {
    Ok(MeshSourceRolesV1 {
        schema_id: MESH_SOURCE_ROLES_SCHEMA_ID.to_owned(),
        schema_version: 1,
        resource_id: format!("mesh-source-{entity_id}"),
        content_hash: ObjectHash::of_bytes(b""),
        roles: vec![MeshSourceRoleV1 {
            source: DerivedSourceV1 {
                entity_id: EntityId(entity_id.to_owned()),
                revision: 0,
                content_hash: content_hash.clone(),
                placement_revision: 0,
                role: source_role.to_owned(),
            },
            placement,
            // MT-D26's admitted enum has exactly five roles. A grid carries its exact
            // source role above and enters the draft through the Points evaluator.
            role: MeshSourceRoleKindV1::Points,
            sampling_tolerance: None,
            sampling_hash,
            boundary_hash: None,
            exclusion_hashes: Vec::new(),
        }],
    })
}

fn ground_dataset_contract(
    prepared: &PreparedGroundDataset,
    dataset_id: &str,
    entity_id: &str,
    representation_slot: &str,
) -> Result<(CanonicalPreparedDataset, GeometryObject, Representation), CanonicalAppRuntimeError> {
    let artifacts = prepared
        .artifacts
        .iter()
        .map(|artifact| PreparedDatasetArtifact {
            relative_path: PathBuf::from(&artifact.relative_path),
            resource: GeometryResource {
                object_hash: artifact.object_hash.clone(),
                media_type: artifact.media_type.clone(),
                byte_length: Some(artifact.byte_length),
            },
        })
        .collect::<Vec<_>>();
    let root_metadata = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == Path::new("metadata.json"))
        .map(|artifact| artifact.resource.clone())
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(
                "prepared ground dataset has no metadata".to_owned(),
            )
        })?;
    let dataset = CanonicalPreparedDataset {
        dataset_id: dataset_id.to_owned(),
        format_id: "potree@2".to_owned(),
        entity_id: entity_id.to_owned(),
        representation_slot: representation_slot.to_owned(),
        root_metadata: root_metadata.clone(),
        artifacts,
    };
    let geometry = GeometryObject::PointCloud {
        dataset: StreamedGeometry {
            format_id: "potree@2".to_owned(),
            metadata: root_metadata,
            element_count: Some(prepared.point_count),
        },
    };
    let representation = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry)
            .map_err(|error| CanonicalAppRuntimeError::InvalidResidency(error.to_string()))?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    Ok((dataset, geometry, representation))
}

fn register_materialized_destination(
    destinations: &mut BTreeMap<PathBuf, ObjectHash>,
    destination: PathBuf,
    object_hash: ObjectHash,
) -> Result<(), CanonicalAppRuntimeError> {
    if destinations
        .insert(destination, object_hash.clone())
        .is_some_and(|existing| existing != object_hash)
    {
        return Err(CanonicalAppRuntimeError::InvalidImportInventory(
            "two immutable artifacts require the same provider-relative path".to_owned(),
        ));
    }
    Ok(())
}

fn point_cloud_metadata(
    store: &CanonicalProjectStore,
    entity: &CanonicalEntity,
    geometry: &GeometryObject,
) -> Result<Option<CanonicalPointCloudMetadata>, CanonicalAppRuntimeError> {
    let GeometryObject::PointCloud { dataset } = geometry else {
        return Ok(None);
    };
    let attributes: serde_json::Value =
        serde_json::from_slice(&store.read_object(&entity.attributes_ref)?)?;
    let imported = attributes
        .get("hcad.point-cloud-import@1")
        .and_then(serde_json::Value::as_object);
    let source = imported
        .and_then(|value| value.get("source"))
        .and_then(serde_json::Value::as_object);
    let point_count = dataset.element_count.or_else(|| {
        imported
            .and_then(|value| value.get("pointCount"))
            .and_then(serde_json::Value::as_u64)
    });
    let Some(point_count) = point_count else {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "point-cloud entity {:?} has no exact point count",
            entity.id.0
        )));
    };
    let display = match &entity.style_ref {
        Some(style_ref) => {
            let value: PointCloudDisplayStyle =
                serde_json::from_slice(&store.read_object(style_ref)?)?;
            value.validate().map_err(|error| {
                CanonicalAppRuntimeError::InvalidResidency(format!(
                    "point-cloud display for {:?}: {error}",
                    entity.id.0
                ))
            })?;
            value
        }
        None => PointCloudDisplayStyle::release_05_default(),
    };
    let placement = entity
        .placement
        .unwrap_or(himmelcad_core::entity_model::Transform3d::IDENTITY);
    Ok(Some(CanonicalPointCloudMetadata {
        point_count,
        source_crs: source
            .and_then(|value| value.get("declaredCrs"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        source_units: source
            .and_then(|value| value.get("declaredUnits"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        placement_offset: [placement.0[12], placement.0[13], placement.0[14]],
        display,
    }))
}

fn validate_residency_dataset(
    store: &CanonicalProjectStore,
    dataset: &CanonicalPreparedDataset,
) -> Result<(), CanonicalAppRuntimeError> {
    let root_artifact = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.resource.object_hash == dataset.root_metadata.object_hash)
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "dataset {:?} has no root-metadata artifact",
                dataset.dataset_id
            ))
        })?;
    if root_artifact.resource != dataset.root_metadata {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "dataset {:?} root metadata differs from its artifact inventory",
            dataset.dataset_id
        )));
    }
    for artifact in &dataset.artifacts {
        let observed = store.object_byte_length(&artifact.resource.object_hash)?;
        if artifact
            .resource
            .byte_length
            .is_some_and(|expected| expected != observed)
        {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "dataset {:?} artifact {:?} has the wrong byte length",
                dataset.dataset_id, artifact.relative_path
            )));
        }
    }
    // Root metadata is small and controls all subsequent streaming. Re-read it
    // through the hash-verifying object API before issuing any residency URL.
    let root_bytes = store.read_object(&dataset.root_metadata.object_hash)?;
    if dataset
        .root_metadata
        .byte_length
        .is_some_and(|expected| expected != u64::try_from(root_bytes.len()).unwrap_or(u64::MAX))
    {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "dataset {:?} root metadata has the wrong byte length",
            dataset.dataset_id
        )));
    }
    Ok(())
}

#[derive(Default)]
struct ResolvedAutomationArtifact {
    source_entity: Option<himmelcad_core::canonical_document::EntityVersionRef>,
    typed_artifact: Option<TypedArtifactDescriptor>,
    representation_slot: Option<String>,
    geometry_ref: Option<ObjectHash>,
}

fn resolve_automation_artifact(
    store: &CanonicalProjectStore,
    object_hash: &ObjectHash,
) -> Result<ResolvedAutomationArtifact, CanonicalAppRuntimeError> {
    let mut bindings = Vec::new();
    let mut descriptors = Vec::new();
    for inventory in store.import_inventories()? {
        for dataset in &inventory.datasets {
            if !dataset
                .artifacts
                .iter()
                .any(|artifact| artifact.resource.object_hash == *object_hash)
            {
                continue;
            }
            if let Some(binding) = live_inventory_binding(
                store,
                &inventory,
                &dataset.entity_id,
                &dataset.representation_slot,
            ) {
                bindings.push(binding);
            }
            if let Some(manifest_artifact) = dataset.typed_artifact_manifest() {
                let bytes = store.read_object(&manifest_artifact.resource.object_hash)?;
                let manifest: TypedArtifactManifest =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(format!(
                            "typed artifact manifest for dataset {:?} is invalid: {error}",
                            dataset.dataset_id
                        ))
                    })?;
                dataset
                    .validate_typed_artifact_layouts(&manifest)
                    .map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(error.to_string())
                    })?;
                descriptors.extend(
                    manifest
                        .artifacts
                        .into_iter()
                        .filter(|descriptor| descriptor.resource.object_hash == *object_hash),
                );
            }
        }
        if inventory.resource_sets.iter().any(|resource_set| {
            resource_set
                .resources
                .iter()
                .any(|artifact| artifact.resource.object_hash == *object_hash)
        }) {
            for admission in &inventory.admissions {
                let Some(binding) = live_inventory_binding(
                    store,
                    &inventory,
                    &admission.entity_id,
                    &admission.representation_slot,
                ) else {
                    continue;
                };
                let geometry = store.read_object(&admission.geometry_ref)?;
                let value: serde_json::Value =
                    serde_json::from_slice(&geometry).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(format!(
                            "resolved geometry {:?} is invalid: {error}",
                            admission.geometry_ref
                        ))
                    })?;
                if value_references_object_hash(&value, object_hash.as_str()) {
                    bindings.push(binding);
                }
            }
        }
    }
    bindings.sort_by(|left, right| {
        (&left.0.id.0, &left.1, &left.2 .0).cmp(&(&right.0.id.0, &right.1, &right.2 .0))
    });
    bindings.dedup();
    let typed_artifact = descriptors
        .first()
        .filter(|first| descriptors.iter().all(|descriptor| descriptor == *first))
        .cloned();
    let (source_entity, representation_slot, geometry_ref) = if bindings.len() == 1 {
        let (entity, slot, geometry_ref) = bindings.remove(0);
        (Some(entity), Some(slot), Some(geometry_ref))
    } else {
        (None, None, None)
    };
    Ok(ResolvedAutomationArtifact {
        source_entity,
        typed_artifact,
        representation_slot,
        geometry_ref,
    })
}

fn live_inventory_binding(
    store: &CanonicalProjectStore,
    inventory: &CanonicalImportInventory,
    entity_id: &str,
    representation_slot: &str,
) -> Option<(
    himmelcad_core::canonical_document::EntityVersionRef,
    String,
    ObjectHash,
)> {
    let admission = inventory.admissions.iter().find(|admission| {
        admission.entity_id == entity_id && admission.representation_slot == representation_slot
    })?;
    let entity = store.document().entity(&EntityId(entity_id.to_owned()))?;
    if admission.geometry_ref != admission.selected.geometry_ref
        || !entity.representations.contains(&admission.selected)
    {
        return None;
    }
    Some((
        himmelcad_core::canonical_document::EntityVersionRef {
            id: entity.id.clone(),
            revision: entity.revision,
            version_hash: entity.version_hash.clone(),
        },
        representation_slot.to_owned(),
        admission.geometry_ref.clone(),
    ))
}

fn value_references_object_hash(value: &serde_json::Value, object_hash: &str) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            object.get("objectHash").and_then(serde_json::Value::as_str) == Some(object_hash)
                || object
                    .values()
                    .any(|child| value_references_object_hash(child, object_hash))
        }
        serde_json::Value::Array(values) => values
            .iter()
            .any(|child| value_references_object_hash(child, object_hash)),
        _ => false,
    }
}

fn seed_project_root(
    store: &mut CanonicalProjectStore,
    project_root: &Path,
) -> Result<(), CanonicalProjectStoreError> {
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({ "schemaId": "hcad.components@1" }),
    )?;
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({ "schemaId": "hcad.attributes@1" }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
    )?;
    store.put_json_object(&components)?;
    store.put_json_object(&attributes)?;
    store.put_json_object(&relations)?;
    let name = project_root
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("Untitled")
        .to_owned();
    let mut root = CanonicalEntity {
        id: EntityId("project-root".to_owned()),
        revision: 0,
        type_id: EntityTypeId(built_in_type::GROUP.to_owned()),
        name,
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: Vec::new(),
        components_ref: components.object_hash.clone(),
        attributes_ref: attributes.object_hash.clone(),
        relations_ref: relations.object_hash.clone(),
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending"),
    };
    root.version_hash = canonical_entity_version_hash(&root)
        .map_err(|_| CanonicalProjectStoreError::CommitInvariant)?;
    let layer = default_layer_entity(
        Some(root.id.clone()),
        components.object_hash,
        attributes.object_hash,
        relations.object_hash,
    )?;
    store.commit_transaction(CanonicalCommandTransaction {
        command_id: "system.create-project-root@1".to_owned(),
        mutations: vec![
            CanonicalEntityMutation::Create { entity: root },
            CanonicalEntityMutation::Create { entity: layer },
        ],
    })?;
    Ok(())
}

fn ensure_default_layer(store: &mut CanonicalProjectStore) -> Result<(), CanonicalAppRuntimeError> {
    let layer_id = EntityId("default-layer".to_owned());
    if let Some(layer) = store.document().entity(&layer_id) {
        if layer.type_id.0 != built_in_type::LAYER {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "system default-layer exists with a non-layer type".to_owned(),
            ));
        }
        return Ok(());
    }
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({ "schemaId": "hcad.components@1" }),
    )?;
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({ "schemaId": "hcad.attributes@1" }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
    )?;
    store.put_json_object(&components)?;
    store.put_json_object(&attributes)?;
    store.put_json_object(&relations)?;
    let owner = store
        .document()
        .entities()
        .find(|entity| entity.owner.is_none() && entity.type_id.0 == built_in_type::GROUP)
        .map(|entity| entity.id.clone());
    let layer = default_layer_entity(
        owner,
        components.object_hash,
        attributes.object_hash,
        relations.object_hash,
    )?;
    let mutation = match store.document().tombstone(&layer_id).cloned() {
        Some(tombstone) => CanonicalEntityMutation::Restore {
            expected: EntityVersionRef::from_tombstone(&tombstone),
            snapshot: layer,
        },
        None => CanonicalEntityMutation::Create { entity: layer },
    };
    store.commit_transaction(CanonicalCommandTransaction {
        command_id: "system.ensure-default-layer@1".to_owned(),
        mutations: vec![mutation],
    })?;
    Ok(())
}

fn default_layer_entity(
    owner: Option<EntityId>,
    components_ref: ObjectHash,
    attributes_ref: ObjectHash,
    relations_ref: ObjectHash,
) -> Result<CanonicalEntity, CanonicalProjectStoreError> {
    let mut layer = CanonicalEntity {
        id: EntityId("default-layer".to_owned()),
        revision: 0,
        type_id: EntityTypeId(built_in_type::LAYER.to_owned()),
        name: "Default".to_owned(),
        owner,
        layer_ids: Vec::new(),
        placement: None,
        representations: Vec::new(),
        components_ref,
        attributes_ref,
        relations_ref,
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending default layer"),
    };
    layer.version_hash = canonical_entity_version_hash(&layer)
        .map_err(|_| CanonicalProjectStoreError::CommitInvariant)?;
    Ok(layer)
}

fn create_snapshot_marker(
    store: &mut CanonicalProjectStore,
    name: &str,
    marker_kind: SnapshotMarkerKindV1,
    origin: SnapshotOriginV1,
) -> Result<CanonicalSnapshotSummary, CanonicalAppRuntimeError> {
    let (summary, entity) = build_snapshot_marker_entity(store, name, marker_kind, origin, None)?;
    store.queue_transaction(CanonicalCommandTransaction {
        command_id: format!("snapshot.create/{}", summary.entity_id),
        mutations: vec![CanonicalEntityMutation::Create { entity }],
    })?;
    Ok(summary)
}

fn latest_document_undo_target(store: &CanonicalProjectStore) -> Option<String> {
    let mut active = BTreeMap::<&str, bool>::new();
    for entry in store.document().journal() {
        match entry.kind {
            CanonicalJournalEntryKind::Command => {
                active.insert(entry.command_id.as_str(), true);
            }
            CanonicalJournalEntryKind::Undo | CanonicalJournalEntryKind::Redo => {
                if let Some(target) = entry.related_command_id.as_deref() {
                    active.insert(target, entry.kind == CanonicalJournalEntryKind::Redo);
                }
            }
        }
    }
    store
        .document()
        .journal()
        .iter()
        .rev()
        .find(|entry| {
            entry.kind == CanonicalJournalEntryKind::Command
                && active
                    .get(entry.command_id.as_str())
                    .copied()
                    .unwrap_or(false)
                && journal_entry_changes_document(entry)
        })
        .map(|entry| entry.command_id.clone())
}

fn latest_document_redo_target(store: &CanonicalProjectStore) -> Option<String> {
    let mut active = BTreeMap::<&str, bool>::new();
    for entry in store.document().journal() {
        match entry.kind {
            CanonicalJournalEntryKind::Command => {
                active.insert(entry.command_id.as_str(), true);
            }
            CanonicalJournalEntryKind::Undo | CanonicalJournalEntryKind::Redo => {
                if let Some(target) = entry.related_command_id.as_deref() {
                    active.insert(target, entry.kind == CanonicalJournalEntryKind::Redo);
                }
            }
        }
    }
    for entry in store.document().journal().iter().rev() {
        if !journal_entry_changes_document(entry) {
            continue;
        }
        match entry.kind {
            CanonicalJournalEntryKind::Command => return None,
            CanonicalJournalEntryKind::Undo => {
                let target = entry.related_command_id.as_deref()?;
                if !active.get(target).copied().unwrap_or(true) {
                    return Some(target.to_owned());
                }
            }
            CanonicalJournalEntryKind::Redo => {}
        }
    }
    None
}

fn journal_entry_changes_document(entry: &CanonicalJournalEntry) -> bool {
    entry.effects.iter().any(|effect| {
        effect
            .after
            .as_ref()
            .or(effect.before.as_ref())
            .is_some_and(|entity| entity.type_id.0 != SNAPSHOT_MARKER_SCHEMA_ID)
    })
}

fn build_snapshot_marker_entity(
    store: &CanonicalProjectStore,
    name: &str,
    marker_kind: SnapshotMarkerKindV1,
    origin: SnapshotOriginV1,
    restore_of: Option<EntityId>,
) -> Result<(CanonicalSnapshotSummary, CanonicalEntity), CanonicalAppRuntimeError> {
    let marked_generation = store.document().generation();
    let now_ms = unix_timestamp_millis();
    let marker = SnapshotMarkerV1 {
        schema_id: SNAPSHOT_MARKER_SCHEMA_ID.to_owned(),
        schema_version: RELEASE_05_SCHEMA_VERSION,
        marked_generation,
        marker_kind,
        created_at: format!("unix-ms:{now_ms}"),
        origin,
        restore_of,
        retention: if marker_kind == SnapshotMarkerKindV1::Manual {
            SnapshotRetentionV1::Manual
        } else {
            SnapshotRetentionV1::Automatic
        },
    };
    validate_snapshot_marker(&marker)
        .map_err(|_| CanonicalAppRuntimeError::InvalidSnapshotMarker)?;
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.snapshot-marker+json",
        serde_json::to_value(&marker)?,
    )?;
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({ "schemaId": "hcad.attributes@1" }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
    )?;
    store.put_json_object(&components)?;
    store.put_json_object(&attributes)?;
    store.put_json_object(&relations)?;
    let entity_id = format!("snapshot-{marked_generation}-{now_ms}");
    let mut entity = CanonicalEntity {
        id: EntityId(entity_id.clone()),
        revision: 0,
        type_id: EntityTypeId(SNAPSHOT_MARKER_SCHEMA_ID.to_owned()),
        name: name.to_owned(),
        owner: Some(EntityId("project-root".to_owned())),
        layer_ids: Vec::new(),
        placement: None,
        representations: Vec::new(),
        components_ref: components.object_hash,
        attributes_ref: attributes.object_hash,
        relations_ref: relations.object_hash,
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)
        .map_err(|_| CanonicalProjectStoreError::CommitInvariant)?;
    Ok((
        CanonicalSnapshotSummary {
            entity_id,
            name: name.to_owned(),
            marker,
        },
        entity,
    ))
}

fn snapshot_summaries(
    store: &CanonicalProjectStore,
) -> Result<Vec<CanonicalSnapshotSummary>, CanonicalAppRuntimeError> {
    let mut result = Vec::new();
    for entity in store.document().entities() {
        if entity.type_id.0 != SNAPSHOT_MARKER_SCHEMA_ID {
            continue;
        }
        let marker: SnapshotMarkerV1 =
            serde_json::from_slice(&store.read_object(&entity.components_ref)?)?;
        validate_snapshot_marker(&marker)
            .map_err(|_| CanonicalAppRuntimeError::InvalidSnapshotMarker)?;
        result.push(CanonicalSnapshotSummary {
            entity_id: entity.id.0.clone(),
            name: entity.name.clone(),
            marker,
        });
    }
    result.sort_by(|left, right| {
        (left.marker.marked_generation, &left.entity_id)
            .cmp(&(right.marker.marked_generation, &right.entity_id))
    });
    Ok(result)
}

fn session_start_snapshot_retention() -> usize {
    std::env::var(SESSION_START_SNAPSHOT_RETENTION_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SESSION_START_SNAPSHOT_RETENTION)
}

fn maintain_session_start_snapshots(
    store: &mut CanonicalProjectStore,
    retention: usize,
) -> Result<usize, CanonicalAppRuntimeError> {
    let snapshots = snapshot_summaries(store)?;
    let session_starts: Vec<_> = snapshots
        .iter()
        .filter(|snapshot| snapshot.marker.marker_kind == SnapshotMarkerKindV1::SessionStart)
        .collect();
    let create_new = session_starts.last().is_none_or(|latest| {
        let marker_entry = latest.marker.marked_generation.saturating_add(1);
        store.document().journal().iter().any(|entry| {
            entry.sequence > marker_entry
                && !entry
                    .command_id
                    .starts_with("snapshot.session-start-maintenance/")
        })
    });
    let target_existing = retention.saturating_sub(usize::from(create_new));
    let compacted = session_starts.len().saturating_sub(target_existing);
    if compacted == 0 && !create_new {
        return Ok(0);
    }

    let mut mutations = Vec::with_capacity(compacted + usize::from(create_new));
    for snapshot in session_starts.iter().take(compacted) {
        let entity = store
            .document()
            .entity(&EntityId(snapshot.entity_id.clone()))
            .ok_or_else(|| {
                CanonicalAppRuntimeError::SnapshotNotFound(snapshot.entity_id.clone())
            })?;
        mutations.push(CanonicalEntityMutation::Delete {
            expected: EntityVersionRef::from_entity(entity),
        });
    }
    if create_new {
        let (_, entity) = build_snapshot_marker_entity(
            store,
            "Session start",
            SnapshotMarkerKindV1::SessionStart,
            SnapshotOriginV1::System,
            None,
        )?;
        mutations.push(CanonicalEntityMutation::Create { entity });
    }
    store.queue_transaction(CanonicalCommandTransaction {
        command_id: format!(
            "snapshot.session-start-maintenance/{}",
            store.document().generation()
        ),
        mutations,
    })?;
    Ok(compacted)
}

fn restore_mutations(
    current: &himmelcad_core::canonical_document::CanonicalDocument,
    target: &himmelcad_core::canonical_document::CanonicalDocument,
) -> Result<Vec<CanonicalEntityMutation>, CanonicalAppRuntimeError> {
    let current_entities: BTreeMap<_, _> = current
        .entities()
        .filter(|entity| entity.type_id.0 != SNAPSHOT_MARKER_SCHEMA_ID)
        .map(|entity| (entity.id.0.clone(), entity))
        .collect();
    let target_entities: BTreeMap<_, _> = target
        .entities()
        .filter(|entity| entity.type_id.0 != SNAPSHOT_MARKER_SCHEMA_ID)
        .map(|entity| (entity.id.0.clone(), entity))
        .collect();
    let mut mutations = Vec::new();

    for (id, entity) in &current_entities {
        if !target_entities.contains_key(id) {
            mutations.push(CanonicalEntityMutation::Delete {
                expected: EntityVersionRef::from_entity(entity),
            });
        }
    }
    for (id, target_entity) in target_entities {
        if let Some(current_entity) = current_entities.get(&id) {
            if current_entity.type_id != target_entity.type_id
                || current_entity.schema_version != target_entity.schema_version
            {
                return Err(CanonicalAppRuntimeError::SnapshotSchemaConflict(id));
            }
            let edits = entity_restore_edits(current_entity, target_entity);
            if !edits.is_empty() {
                mutations.push(CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(current_entity),
                    edits,
                });
            }
        } else if let Some(tombstone) = current.tombstone(&target_entity.id) {
            mutations.push(CanonicalEntityMutation::Restore {
                expected: EntityVersionRef::from_tombstone(tombstone),
                snapshot: target_entity.clone(),
            });
        } else {
            return Err(CanonicalAppRuntimeError::SnapshotSchemaConflict(id));
        }
    }
    Ok(mutations)
}

fn entity_restore_edits(
    current: &CanonicalEntity,
    target: &CanonicalEntity,
) -> Vec<CanonicalEntityEdit> {
    let mut edits = Vec::new();
    if current.name != target.name {
        edits.push(CanonicalEntityEdit::SetName {
            name: target.name.clone(),
        });
    }
    if current.owner != target.owner {
        edits.push(CanonicalEntityEdit::SetOwner {
            owner: target.owner.clone(),
        });
    }
    if current.layer_ids != target.layer_ids {
        edits.push(CanonicalEntityEdit::SetLayerIds {
            layer_ids: target.layer_ids.clone(),
        });
    }
    if current.placement != target.placement {
        edits.push(CanonicalEntityEdit::SetPlacement {
            placement: target.placement,
        });
    }
    if current.representations != target.representations {
        edits.push(CanonicalEntityEdit::SetRepresentations {
            representations: target.representations.clone(),
        });
    }
    if current.components_ref != target.components_ref {
        edits.push(CanonicalEntityEdit::SetComponentsRef {
            components_ref: target.components_ref.clone(),
        });
    }
    if current.attributes_ref != target.attributes_ref {
        edits.push(CanonicalEntityEdit::SetAttributesRef {
            attributes_ref: target.attributes_ref.clone(),
        });
    }
    if current.relations_ref != target.relations_ref {
        edits.push(CanonicalEntityEdit::SetRelationsRef {
            relations_ref: target.relations_ref.clone(),
        });
    }
    if current.style_ref != target.style_ref {
        edits.push(CanonicalEntityEdit::SetStyleRef {
            style_ref: target.style_ref.clone(),
        });
    }
    edits
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

#[derive(Debug, Error)]
enum CanonicalAppDispatchError {
    #[error("no canonical project is open")]
    ProjectNotOpen,
    #[error(transparent)]
    Journal(#[from] AppJournalReadError),
    #[error(transparent)]
    Property(#[from] PropertySchemaError),
    #[error(transparent)]
    Store(#[from] CanonicalProjectStoreError),
    #[error("canonical transaction references missing object {0:?}")]
    MissingObject(ObjectHash),
}

impl CanonicalAppDispatchError {
    fn into_protocol_error(self) -> AppProtocolError {
        let code = match &self {
            Self::ProjectNotOpen => "hcad.app.project-not-open",
            Self::Journal(AppJournalReadError::InvalidLimit) => "hcad.app.journal.invalid-limit",
            Self::Journal(AppJournalReadError::SequenceAheadOfJournal) => {
                "hcad.app.journal.cursor-ahead"
            }
            Self::Property(PropertySchemaError::Canonical(error)) => document_error_code(error),
            Self::Property(_) => "hcad.app.property.invalid-request",
            Self::Store(CanonicalProjectStoreError::Document(error)) => document_error_code(error),
            Self::Store(_) => "hcad.app.store.failure",
            Self::MissingObject(_) => "hcad.app.object.not-found",
        };
        AppProtocolError {
            code: code.to_owned(),
            message: self.to_string(),
            details: BTreeMap::new(),
        }
    }
}

fn validate_transaction_object_refs(
    store: &CanonicalProjectStore,
    transaction: &CanonicalCommandTransaction,
) -> Result<(), CanonicalAppDispatchError> {
    let mut references = Vec::new();
    for mutation in &transaction.mutations {
        match mutation {
            CanonicalEntityMutation::Create { entity }
            | CanonicalEntityMutation::Restore {
                snapshot: entity, ..
            } => collect_entity_object_refs(entity, &mut references),
            CanonicalEntityMutation::Update { edits, .. } => {
                for edit in edits {
                    match edit {
                        CanonicalEntityEdit::SetRepresentations { representations } => references
                            .extend(
                                representations
                                    .iter()
                                    .map(|representation| &representation.geometry_ref),
                            ),
                        CanonicalEntityEdit::SetComponentsRef { components_ref } => {
                            references.push(components_ref);
                        }
                        CanonicalEntityEdit::SetAttributesRef { attributes_ref } => {
                            references.push(attributes_ref);
                        }
                        CanonicalEntityEdit::SetRelationsRef { relations_ref } => {
                            references.push(relations_ref);
                        }
                        CanonicalEntityEdit::SetStyleRef {
                            style_ref: Some(style_ref),
                        } => references.push(style_ref),
                        CanonicalEntityEdit::SetName { .. }
                        | CanonicalEntityEdit::SetOwner { .. }
                        | CanonicalEntityEdit::SetLayerIds { .. }
                        | CanonicalEntityEdit::SetPlacement { .. }
                        | CanonicalEntityEdit::SetStyleRef { style_ref: None } => {}
                    }
                }
            }
            CanonicalEntityMutation::Delete { .. } => {}
        }
    }
    references.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
    references.dedup();
    for object_hash in references {
        if !store.contains_object(object_hash)? {
            return Err(CanonicalAppDispatchError::MissingObject(
                object_hash.clone(),
            ));
        }
    }
    Ok(())
}

fn validate_view_bookmark_state(state: &serde_json::Value) -> Result<(), CanonicalAppRuntimeError> {
    let object = state.as_object().ok_or_else(|| {
        CanonicalAppRuntimeError::InvalidResidency("bookmark state must be an object".to_owned())
    })?;
    if object.get("schemaId").and_then(serde_json::Value::as_str)
        != Some("hcad.bookmark-view-state@1")
        || !object
            .get("camera")
            .is_some_and(serde_json::Value::is_object)
        || !object
            .get("presentation")
            .is_some_and(serde_json::Value::is_object)
        || !object
            .get("clipRefs")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(CanonicalAppRuntimeError::InvalidResidency(
            "bookmark state does not match hcad.bookmark-view-state@1".to_owned(),
        ));
    }
    Ok(())
}

fn bookmark_object(
    record: &CanonicalViewBookmarkRecord,
) -> Result<CanonicalJsonObject, CanonicalAppRuntimeError> {
    empty_json_object(
        "application/vnd.himmelcad.view-bookmark+json",
        serde_json::to_value(record)?,
    )
}

fn empty_json_object(
    media_type: &str,
    value: serde_json::Value,
) -> Result<CanonicalJsonObject, CanonicalAppRuntimeError> {
    let bytes = serde_json::to_vec(&value)?;
    Ok(CanonicalJsonObject {
        object_hash: ObjectHash::of_bytes(&bytes),
        media_type: media_type.to_owned(),
        value,
    })
}

fn read_view_bookmark(
    store: &CanonicalProjectStore,
    entity: &CanonicalEntity,
) -> Result<CanonicalViewBookmarkSummary, CanonicalAppRuntimeError> {
    let record: CanonicalViewBookmarkRecord =
        serde_json::from_slice(&store.read_object(&entity.components_ref)?)?;
    if record.schema_id != VIEW_BOOKMARK_SCHEMA_ID || record.schema_version != 1 {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "bookmark {:?} has an unsupported component",
            entity.id.0
        )));
    }
    validate_view_bookmark_state(&record.state)?;
    Ok(CanonicalViewBookmarkSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        state: record.state,
    })
}

fn read_viewing_box(
    store: &CanonicalProjectStore,
    entity: &CanonicalEntity,
) -> Result<CanonicalViewingBoxSummary, CanonicalAppRuntimeError> {
    let value: serde_json::Value =
        serde_json::from_slice(&store.read_object(&entity.components_ref)?)?;
    let state = value.get("state").cloned().ok_or_else(|| {
        CanonicalAppRuntimeError::InvalidResidency(format!(
            "viewing box {:?} has no state component",
            entity.id.0
        ))
    })?;
    if value.get("schemaId").and_then(serde_json::Value::as_str) != Some(VIEWING_BOX_SCHEMA_ID)
        || value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
        || !state.is_object()
    {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "viewing box {:?} has an unsupported component",
            entity.id.0
        )));
    }
    Ok(CanonicalViewingBoxSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        state,
    })
}

fn read_measurement(
    store: &CanonicalProjectStore,
    entity: &CanonicalEntity,
) -> Result<CanonicalMeasurementSummary, CanonicalAppRuntimeError> {
    if entity.type_id.0 != MEASUREMENT_SCHEMA_ID
        || entity.placement.is_some()
        || entity.layer_ids.len() != 1
    {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "measurement {:?} has an incompatible entity envelope",
            entity.id.0
        )));
    }
    let representation = entity
        .representations
        .iter()
        .find(|representation| {
            representation.role == RepresentationRole::Canonical
                && representation.authority == RepresentationAuthority::Authoritative
        })
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "measurement {:?} has no authoritative geometry",
                entity.id.0
            ))
        })?;
    let geometry: GeometryObject =
        serde_json::from_slice(&store.read_object(&representation.geometry_ref)?)?;
    let GeometryObject::Measurement { measurement } = geometry else {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "measurement {:?} has the wrong geometry kind",
            entity.id.0
        )));
    };
    validate_measurement(&measurement).map_err(|error| {
        CanonicalAppRuntimeError::InvalidResidency(format!(
            "measurement {:?} failed admission: {error}",
            entity.id.0
        ))
    })?;
    if measurement.layer_id != entity.layer_ids[0] {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "measurement {:?} layer payload differs from its entity envelope",
            entity.id.0
        )));
    }
    Ok(CanonicalMeasurementSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        measurement: *measurement,
    })
}

fn validate_draw_curve_input(
    command_id: &str,
    input: &DrawCurveInput,
) -> Result<(), CanonicalAppRuntimeError> {
    if command_id.trim().is_empty()
        || input.entity_id.trim().is_empty()
        || input.name.trim().is_empty()
        || input.vertices.len() < 2
        || input.vertices.len() != input.acquisitions.len()
        || (input.tool == DrawCurveTool::Line && (input.vertices.len() != 2 || input.closed))
        || (input.closed && (input.tool == DrawCurveTool::Line || input.vertices.len() < 3))
        || (input.role == DrawCurveRole::Boundary && input.tool != DrawCurveTool::Boundary)
        || (input.tool == DrawCurveTool::Boundary && input.role != DrawCurveRole::Boundary)
    {
        return Err(CanonicalAppRuntimeError::InvalidResidency(
            "draw curve input has invalid identity, topology, role, or vertex counts".to_owned(),
        ));
    }
    for (position, acquisition) in input.vertices.iter().zip(&input.acquisitions) {
        validate_point_acquisition(acquisition).map_err(|error| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "draw vertex acquisition is invalid: {error}"
            ))
        })?;
        if acquisition.final_coordinate != *position {
            return Err(CanonicalAppRuntimeError::InvalidResidency(
                "draw vertex differs from its acquisition coordinate".to_owned(),
            ));
        }
    }
    Ok(())
}

fn read_draw_curve(
    store: &CanonicalProjectStore,
    entity: &CanonicalEntity,
) -> Result<CanonicalDrawCurveSummary, CanonicalAppRuntimeError> {
    let components: DrawCurveComponents =
        serde_json::from_slice(&store.read_object(&entity.components_ref)?).map_err(|_| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "curve {:?} is not authored draw linework",
                entity.id.0
            ))
        })?;
    if components.schema_id != DRAW_CURVE_COMPONENT_SCHEMA_ID || components.schema_version != 1 {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "curve {:?} is not authored draw linework",
            entity.id.0
        )));
    }
    validate_support_role(&components.support_role).map_err(|error| {
        CanonicalAppRuntimeError::InvalidResidency(format!(
            "draw curve {:?} support role is invalid: {error}",
            entity.id.0
        ))
    })?;
    let selected = entity
        .representations
        .iter()
        .find(|representation| {
            representation.role == RepresentationRole::Canonical
                && representation.authority == RepresentationAuthority::Authoritative
        })
        .cloned()
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "draw curve {:?} has no authoritative geometry",
                entity.id.0
            ))
        })?;
    let resolved_geometry: GeometryObject =
        serde_json::from_slice(&store.read_object(&selected.geometry_ref)?)?;
    validate_resolved_representation(entity, &selected, &resolved_geometry).map_err(|error| {
        CanonicalAppRuntimeError::InvalidResidency(format!(
            "draw curve {:?} failed representation validation: {error}",
            entity.id.0
        ))
    })?;
    let GeometryObject::Curve { curve } = &resolved_geometry else {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "draw curve {:?} has the wrong geometry kind",
            entity.id.0
        )));
    };
    let (vertices, closed) = match curve.as_ref() {
        CurveGeometry::LineSegment { start, end } => (vec![*start, *end], false),
        CurveGeometry::Polyline { positions, closed } => (positions.clone(), *closed),
        _ => {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "draw curve {:?} has an unsupported curve kind",
                entity.id.0
            )))
        }
    };
    let input = DrawCurveInput {
        entity_id: entity.id.0.clone(),
        expected_revision: Some(entity.revision),
        name: entity.name.clone(),
        tool: components.tool,
        role: components.role,
        closed,
        vertices: vertices.clone(),
        acquisitions: components.point_acquisitions.clone(),
    };
    validate_draw_curve_input("read", &input)?;
    Ok(CanonicalDrawCurveSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        role: components.role,
        closed,
        vertices,
        acquisitions: components.point_acquisitions,
        admission: CanonicalRepresentationAdmission {
            entity: entity.clone(),
            selected,
            representation_slot: "primary".to_owned(),
            expected_generation: None,
            resolved_geometry,
        },
    })
}

fn collect_entity_object_refs<'a>(
    entity: &'a CanonicalEntity,
    references: &mut Vec<&'a ObjectHash>,
) {
    references.push(&entity.components_ref);
    references.push(&entity.attributes_ref);
    references.push(&entity.relations_ref);
    if let Some(style_ref) = &entity.style_ref {
        references.push(style_ref);
    }
    references.extend(
        entity
            .representations
            .iter()
            .map(|representation| &representation.geometry_ref),
    );
}

fn document_error_code(error: &CanonicalDocumentError) -> &'static str {
    match error {
        CanonicalDocumentError::VersionConflict { .. }
        | CanonicalDocumentError::PreparedTransactionStale
        | CanonicalDocumentError::DuplicateCommandId => "hcad.app.document.conflict",
        CanonicalDocumentError::EntityNotFound { .. }
        | CanonicalDocumentError::TombstoneNotFound { .. }
        | CanonicalDocumentError::CommandUnavailable { .. } => "hcad.app.document.not-found",
        _ => "hcad.app.document.invalid-transaction",
    }
}

fn map_envelope_error(error: AppProtocolEnvelopeError) -> AppProtocolError {
    AppProtocolError {
        code: match error {
            AppProtocolEnvelopeError::UnsupportedSchema => "hcad.app.protocol.unsupported-schema",
            AppProtocolEnvelopeError::InvalidRequestId => "hcad.app.protocol.invalid-request-id",
        }
        .to_owned(),
        message: error.to_string(),
        details: BTreeMap::new(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportSectionTopologyIndex {
    schema_version: u32,
    closed_manifold: bool,
    #[serde(default)]
    material_keys: BTreeMap<u32, String>,
    parts: Vec<ExportSectionTopologyPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportSectionTopologyPart {
    part_id: String,
    topology_hash: String,
    manifest_url: String,
}

fn read_export_topology(
    store: &CanonicalProjectStore,
    dataset: &CanonicalPreparedDataset,
) -> Result<(Vec<Vector3>, Vec<u32>), CanonicalAppRuntimeError> {
    let index_artifact = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.resource.media_type == "hcad.section-topology-index@2")
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidImportInventory(format!(
                "dataset {:?} has no section-topology index",
                dataset.dataset_id
            ))
        })?;
    let index_bytes = store.read_object(&index_artifact.resource.object_hash)?;
    let index: ExportSectionTopologyIndex = serde_json::from_slice(&index_bytes)?;
    if index.schema_version != 2 || index.parts.is_empty() {
        return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
            "dataset {:?} has an invalid section-topology index",
            dataset.dataset_id
        )));
    }
    let _ = (index.closed_manifold, &index.material_keys);
    let artifacts = dataset
        .artifacts
        .iter()
        .map(|artifact| {
            (
                artifact.relative_path.to_string_lossy().replace('\\', "/"),
                artifact,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for part in index.parts {
        let artifact = artifacts.get(&part.manifest_url).ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidImportInventory(format!(
                "section part {:?} is absent from dataset {:?}",
                part.part_id, dataset.dataset_id
            ))
        })?;
        let bytes = store.read_object(&artifact.resource.object_hash)?;
        let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(&bytes)?;
        if manifest.schema_version != SectionTopologyPartitionManifest::SCHEMA_VERSION
            || manifest.content_hash()?.as_str() != part.topology_hash
        {
            return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
                "section part {:?} changed before export",
                part.part_id
            )));
        }
        let position_bytes = store.read_object(&manifest.positions.object_hash)?;
        let part_positions = decode_export_positions(&manifest, &position_bytes)?;
        let index_bytes = store.read_object(&manifest.indices.object_hash)?;
        let part_indices = decode_export_indices(&manifest, &index_bytes)?;
        let offset = u32::try_from(positions.len()).map_err(|_| {
            CanonicalAppRuntimeError::InvalidImportInventory(
                "export topology exceeds the canonical inline address space".to_owned(),
            )
        })?;
        positions.extend(part_positions);
        for index in part_indices {
            indices.push(index.checked_add(offset).ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(
                    "export topology index overflow".to_owned(),
                )
            })?);
        }
    }
    Ok((positions, indices))
}

fn decode_export_positions(
    manifest: &SectionTopologyPartitionManifest,
    bytes: &[u8],
) -> Result<Vec<Vector3>, CanonicalAppRuntimeError> {
    let component_bytes = match manifest.position_component_type {
        SectionPositionComponentType::Float32 => 4,
        SectionPositionComponentType::Float64 => 8,
    };
    let expected = usize::try_from(manifest.vertex_count)
        .ok()
        .and_then(|count| count.checked_mul(3))
        .and_then(|count| count.checked_mul(component_bytes))
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidImportInventory(
                "section position byte length overflow".to_owned(),
            )
        })?;
    if bytes.len() != expected {
        return Err(CanonicalAppRuntimeError::InvalidImportInventory(
            "section position buffer length changed before export".to_owned(),
        ));
    }
    let mut values = Vec::with_capacity(manifest.vertex_count as usize);
    for vertex in 0..manifest.vertex_count as usize {
        let coordinate = |axis: usize| -> f64 {
            let start = (vertex * 3 + axis) * component_bytes;
            match manifest.position_component_type {
                SectionPositionComponentType::Float32 => {
                    f32::from_le_bytes(bytes[start..start + 4].try_into().expect("fixed slice"))
                        as f64
                }
                SectionPositionComponentType::Float64 => {
                    f64::from_le_bytes(bytes[start..start + 8].try_into().expect("fixed slice"))
                }
            }
        };
        values.push(Vector3 {
            x: manifest.origin[0] + coordinate(0),
            y: manifest.origin[1] + coordinate(1),
            z: manifest.origin[2] + coordinate(2),
        });
    }
    Ok(values)
}

fn decode_export_indices(
    manifest: &SectionTopologyPartitionManifest,
    bytes: &[u8],
) -> Result<Vec<u32>, CanonicalAppRuntimeError> {
    let component_bytes = match manifest.index_component_type {
        SectionIndexComponentType::Uint16 => 2,
        SectionIndexComponentType::Uint32 => 4,
    };
    let count = usize::try_from(manifest.index_count).map_err(|_| {
        CanonicalAppRuntimeError::InvalidImportInventory(
            "section index count exceeds the platform address space".to_owned(),
        )
    })?;
    if count % 3 != 0 || bytes.len() != count.saturating_mul(component_bytes) {
        return Err(CanonicalAppRuntimeError::InvalidImportInventory(
            "section index buffer length changed before export".to_owned(),
        ));
    }
    let mut values = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * component_bytes;
        let value = match manifest.index_component_type {
            SectionIndexComponentType::Uint16 => {
                u16::from_le_bytes(bytes[start..start + 2].try_into().expect("fixed slice")) as u32
            }
            SectionIndexComponentType::Uint32 => {
                u32::from_le_bytes(bytes[start..start + 4].try_into().expect("fixed slice"))
            }
        };
        if value >= manifest.vertex_count {
            return Err(CanonicalAppRuntimeError::InvalidImportInventory(
                "section topology contains an out-of-range index".to_owned(),
            ));
        }
        values.push(value);
    }
    Ok(values)
}

fn merge_presentation_resources(
    target: &mut CanonicalPresentationResourceSet,
    source: CanonicalPresentationResourceSet,
) {
    extend_unique(&mut target.textures, source.textures);
    extend_unique(&mut target.materials, source.materials);
    extend_unique(&mut target.material_tables, source.material_tables);
    extend_unique(&mut target.hatch_patterns, source.hatch_patterns);
    extend_unique(&mut target.line_types, source.line_types);
    extend_unique(&mut target.annotation_styles, source.annotation_styles);
}

fn extend_unique<T: PartialEq>(target: &mut Vec<T>, source: Vec<T>) {
    for item in source {
        if !target.contains(&item) {
            target.push(item);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use himmelcad_core::app_protocol::{
        AppJournalReadRequest, AppProtocolExtensions, AppProtocolRequest,
        AppProtocolRequestEnvelope, AppProtocolResponse, APP_PROTOCOL_SCHEMA_ID,
    };
    use himmelcad_core::canonical_document::{
        CanonicalCommandTransaction, CanonicalEntityMutation, CanonicalJournalEntryKind,
        EntityVersionRef,
    };
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        built_in_type, CanonicalEntity, EntityTypeId, GeometryResource, Representation,
        RepresentationAuthority, RepresentationRole, StreamedGeometry,
    };
    use himmelcad_core::entity_validation::{
        canonical_entity_version_hash, geometry_object_content_hash,
    };
    use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
    use himmelcad_core::hash::ObjectHash;
    use himmelcad_core::release_05_admissions::{
        AcquisitionTruthV1, PointAcquisitionKindV1, POINT_ACQUISITION_SCHEMA_ID,
    };
    use himmelcad_core::typed_artifact::{
        ArtifactElementType, ArtifactEndianness, TypedArtifactDescriptor, TypedArtifactLayout,
        TypedArtifactManifest, TYPED_ARTIFACT_MANIFEST_NAME,
    };
    use himmelcad_io::{
        CanonicalImportPackage, CanonicalImportProvider, CanonicalImportRequest,
        PhotoLabProductPackageProvider, PreparedDatasetArtifact, ProviderOperationContext,
        ProviderProgress, StagedArtifactRoots, CANONICAL_IO_SCHEMA_VERSION,
        PRODUCT_IMPORT_PACKAGE_FORMAT_ID,
    };
    use serde_json::json;

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn temp_project(label: &str) -> std::path::PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "himmelcad-app-runtime-{label}-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn snapshot_markers_round_trip_with_session_and_manual_origins() {
        let root = temp_project("snapshot-round-trip");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open with session marker");
        let session = runtime.list_snapshots().expect("session snapshot");
        assert_eq!(session.len(), 1);
        assert_eq!(session[0].name, "Session start");
        assert_eq!(
            session[0].marker.marker_kind,
            SnapshotMarkerKindV1::SessionStart
        );
        let manual = runtime
            .create_snapshot("Before grading", SnapshotOriginV1::Ui)
            .expect("manual marker");
        assert_eq!(manual.marker.schema_id, SNAPSHOT_MARKER_SCHEMA_ID);
        runtime.flush().expect("snapshot durability");
        assert!(runtime.close());

        runtime.open(&root).expect("reopen");
        let snapshots = runtime.list_snapshots().expect("round-trip snapshots");
        assert!(snapshots.iter().any(|snapshot| {
            snapshot.name == "Before grading"
                && snapshot.marker.marker_kind == SnapshotMarkerKindV1::Manual
                && snapshot.marker.origin == SnapshotOriginV1::Ui
        }));
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn unchanged_session_does_not_create_another_session_start_snapshot_marker() {
        let root = temp_project("snapshot-unchanged-session");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("first open");
        assert!(runtime.close());
        runtime.open(&root).expect("unchanged reopen");
        assert_eq!(
            runtime
                .list_snapshots()
                .expect("snapshots")
                .iter()
                .filter(|item| item.marker.marker_kind == SnapshotMarkerKindV1::SessionStart)
                .count(),
            1
        );
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn sixth_session_start_snapshot_evicts_the_oldest_but_keeps_named_snapshots() {
        let root = temp_project("snapshot-retention");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let oldest = runtime.list_snapshots().expect("initial marker")[0]
            .entity_id
            .clone();
        for _ in 0..4 {
            create_snapshot_marker(
                runtime.store_mut().expect("store"),
                "Session start",
                SnapshotMarkerKindV1::SessionStart,
                SnapshotOriginV1::System,
            )
            .expect("automatic snapshot");
        }
        runtime
            .create_snapshot("Named checkpoint", SnapshotOriginV1::Ui)
            .expect("session journal change");

        let generation_before = runtime.store().expect("store").document().generation();
        let compacted = maintain_session_start_snapshots(
            runtime.store_mut().expect("store"),
            DEFAULT_SESSION_START_SNAPSHOT_RETENTION,
        )
        .expect("retention command");
        assert_eq!(compacted, 1);
        let store = runtime.store().expect("store");
        assert_eq!(store.document().generation(), generation_before + 1);
        assert_eq!(
            store
                .document()
                .journal()
                .last()
                .expect("command")
                .effects
                .len(),
            2
        );
        let snapshots = runtime.list_snapshots().expect("retained snapshots");
        assert_eq!(
            snapshots
                .iter()
                .filter(|item| item.marker.marker_kind == SnapshotMarkerKindV1::SessionStart)
                .count(),
            5
        );
        assert!(!snapshots.iter().any(|item| item.entity_id == oldest));
        assert!(snapshots.iter().any(|item| item.name == "Named checkpoint"));
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn forty_legacy_session_snapshot_markers_compact_in_one_journaled_command() {
        let root = temp_project("snapshot-compaction");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        for _ in 1..40 {
            create_snapshot_marker(
                runtime.store_mut().expect("store"),
                "Session start",
                SnapshotMarkerKindV1::SessionStart,
                SnapshotOriginV1::System,
            )
            .expect("legacy marker");
        }
        let generation_before = runtime.store().expect("store").document().generation();
        runtime.flush().expect("durable fixture");
        assert!(runtime.close());

        runtime.open(&root).expect("open compacts fixture");
        let store = runtime.store().expect("store");
        assert_eq!(store.document().generation(), generation_before + 1);
        assert_eq!(
            store
                .document()
                .journal()
                .last()
                .expect("command")
                .effects
                .len(),
            35
        );
        assert_eq!(
            snapshot_summaries(store)
                .expect("snapshots")
                .iter()
                .filter(|item| item.marker.marker_kind == SnapshotMarkerKindV1::SessionStart)
                .count(),
            5
        );
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn snapshot_restore_round_trips_as_one_forward_command() {
        let root = temp_project("snapshot-restore");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let original_name = runtime
            .store()
            .expect("store")
            .document()
            .entity(&EntityId("project-root".to_owned()))
            .expect("root")
            .name
            .clone();
        let marker = runtime
            .create_snapshot("Before grading", SnapshotOriginV1::Ui)
            .expect("snapshot");
        let root_entity = runtime
            .store()
            .expect("store")
            .document()
            .entity(&EntityId("project-root".to_owned()))
            .expect("root")
            .clone();
        runtime
            .store_mut()
            .expect("store")
            .queue_transaction(CanonicalCommandTransaction {
                command_id: "test.rename-after-snapshot".to_owned(),
                mutations: vec![CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&root_entity),
                    edits: vec![CanonicalEntityEdit::SetName {
                        name: "Changed later".to_owned(),
                    }],
                }],
            })
            .expect("rename");

        let restored = runtime
            .restore_snapshot(&marker.entity_id)
            .expect("restore snapshot");
        assert_eq!(restored.snapshot.entity_id, marker.entity_id);
        assert_eq!(restored.journal_entry.effects.len(), 2);
        assert_eq!(
            runtime
                .store()
                .expect("store")
                .document()
                .entity(&EntityId("project-root".to_owned()))
                .expect("root")
                .name,
            original_name
        );
        assert_eq!(runtime.list_snapshots().expect("snapshots").len(), 3);
        runtime.flush().expect("durable restore");
        assert!(runtime.close());
        runtime.open(&root).expect("reopen");
        assert_eq!(
            runtime
                .store()
                .expect("store")
                .document()
                .entity(&EntityId("project-root".to_owned()))
                .expect("root")
                .name,
            original_name
        );
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn view_bookmarks_round_trip_through_the_journal_and_reopen() {
        let root = temp_project("view-bookmark-round-trip");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let state = json!({
            "schemaId": "hcad.bookmark-view-state@1",
            "camera": { "target": [0, 0, 0] },
            "presentation": { "background": "theme" },
            "clipRefs": [],
        });

        let created = runtime
            .create_view_bookmark(
                "bookmark-create".to_owned(),
                "bookmark-a".to_owned(),
                "Overview".to_owned(),
                state.clone(),
            )
            .expect("create bookmark");
        assert_eq!(created.bookmark.revision, 0);
        assert_eq!(created.bookmark.state, state);
        let restored = runtime
            .restore_view_bookmark(
                "bookmark-restore".to_owned(),
                created.bookmark.entity_id.clone(),
                created.bookmark.revision,
            )
            .expect("restore bookmark");
        assert_eq!(restored.bookmark.revision, 1);
        assert!(restored.journal_entry.sequence > created.journal_entry.sequence);
        runtime.flush().expect("bookmark durability");
        assert!(runtime.close());

        runtime.open(&root).expect("reopen project");
        let bookmarks = runtime.list_view_bookmarks().expect("list bookmarks");
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0], restored.bookmark);
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn viewing_box_restores_exactly_through_the_journal_and_reopen() {
        let root = temp_project("viewing-box-round-trip");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let state = json!({
            "id": "viewing-box-a",
            "center": { "x": 12.5, "y": -4.25, "z": 103.75 },
            "halfExtents": { "x": 7.5, "y": 8.25, "z": 9.5 },
            "rotation": [0.0, 0.0, 0.3826834323650898, 0.9238795325112867],
            "mode": "resize",
            "enabled": true,
            "operation": "removeInside",
            "lockMode": "unlocked",
            "bakeKey": null
        });
        let created = runtime
            .put_viewing_box(
                "viewing-box-create".to_owned(),
                "viewing-box-a".to_owned(),
                "Excavation exclusion".to_owned(),
                None,
                state.clone(),
            )
            .expect("create viewing box");
        assert_eq!(created.viewing_box.state, state);
        assert_eq!(
            created.journal_entry.kind,
            CanonicalJournalEntryKind::Command
        );
        assert_eq!(created.journal_entry.effects.len(), 1);
        runtime.flush().expect("viewing-box durability");
        assert!(runtime.close());

        runtime.open(&root).expect("reopen project");
        let boxes = runtime.list_viewing_boxes().expect("list viewing boxes");
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0], created.viewing_box);
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn legacy_persisted_project_tombstoned_default_layer_is_repaired_once_on_open() {
        let root = temp_project("legacy-default-layer-repair");
        let default_layer_id = EntityId("default-layer".to_owned());
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("create legacy fixture");
        let layer = runtime
            .store()
            .expect("store")
            .document()
            .entity(&default_layer_id)
            .expect("default layer")
            .clone();
        runtime
            .store_mut()
            .expect("store")
            .commit_transaction(CanonicalCommandTransaction {
                command_id: "legacy.delete-default-layer".to_owned(),
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef::from_entity(&layer),
                }],
            })
            .expect("persist legacy tombstone");
        runtime.flush().expect("durable legacy fixture");
        assert!(runtime.close());

        runtime.open(&root).expect("repair legacy fixture");
        let store = runtime.store().expect("repaired store");
        assert!(store.document().entity(&default_layer_id).is_some());
        assert!(store.document().tombstone(&default_layer_id).is_none());
        assert_eq!(
            store
                .document()
                .journal()
                .iter()
                .filter(|entry| entry.command_id == "system.ensure-default-layer@1")
                .count(),
            1
        );
        assert!(runtime.close());

        runtime.open(&root).expect("idempotent reopen");
        let store = runtime.store().expect("reopened store");
        assert_eq!(
            store
                .document()
                .entities()
                .filter(|entity| entity.id == default_layer_id)
                .count(),
            1
        );
        assert_eq!(
            store
                .document()
                .journal()
                .iter()
                .filter(|entry| entry.command_id == "system.ensure-default-layer@1")
                .count(),
            1
        );
        use himmelcad_core::release_05_admissions::{
            MeasurementAnchorV1, MeasurementKindV1, MeasurementVerificationV1,
        };
        let measured = runtime
            .create_measurement(
                "measurement-after-repair".to_owned(),
                "measurement-after-repair".to_owned(),
                "Point 1".to_owned(),
                MeasurementV1 {
                    schema_id: MEASUREMENT_SCHEMA_ID.to_owned(),
                    schema_version: 1,
                    measurement_kind: MeasurementKindV1::Point,
                    metric: None,
                    anchors: vec![MeasurementAnchorV1::Fixed {
                        position: Position {
                            x: 1.0,
                            y: 2.0,
                            z: Some(3.0),
                        },
                    }],
                    layer_id: default_layer_id.clone(),
                    visible: true,
                    creation_view_id: None,
                    provenance: "ui".to_owned(),
                    verification: MeasurementVerificationV1::Verified,
                    result_cache: None,
                },
            )
            .expect("measurement after legacy repair");
        assert_eq!(measured.journal_entry.effects.len(), 1);
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn project_draw_boundary_cancel_reopen_and_second_drawing_keep_default_layer() {
        fn position(x: f64, y: f64, z: f64) -> Position {
            Position { x, y, z: Some(z) }
        }
        fn typed(point: Position) -> PointAcquisitionV1 {
            PointAcquisitionV1 {
                schema_id: POINT_ACQUISITION_SCHEMA_ID.to_owned(),
                schema_version: RELEASE_05_SCHEMA_VERSION,
                acquisition: PointAcquisitionKindV1::Typed,
                final_coordinate: point,
                input_mode: "typed".to_owned(),
                truth: AcquisitionTruthV1::Typed,
                source_entity_id: None,
                source_revision: None,
                provider_id: None,
                primitive_address: None,
                constraint: None,
                estimate_confirmed: false,
            }
        }
        fn input(
            entity_id: &str,
            expected_revision: Option<u64>,
            tool: DrawCurveTool,
            role: DrawCurveRole,
            closed: bool,
            vertices: Vec<Position>,
        ) -> DrawCurveInput {
            let acquisitions = vertices.iter().cloned().map(typed).collect();
            DrawCurveInput {
                entity_id: entity_id.to_owned(),
                expected_revision,
                name: entity_id.to_owned(),
                tool,
                role,
                closed,
                vertices,
                acquisitions,
            }
        }

        let root = temp_project("draw-round-trip");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        assert!(runtime
            .store
            .as_ref()
            .unwrap()
            .document()
            .entity(&EntityId("default-layer".to_owned()))
            .is_some());
        runtime
            .put_draw_curve(
                "draw-cancelled-create".to_owned(),
                input(
                    "cancelled-boundary",
                    None,
                    DrawCurveTool::Boundary,
                    DrawCurveRole::Boundary,
                    false,
                    vec![position(0.0, 0.0, 0.0), position(1.0, 0.0, 0.0)],
                ),
            )
            .expect("create then cancel boundary");
        runtime
            .undo_draw_curve(
                "draw-cancelled-undo".to_owned(),
                "draw-cancelled-create".to_owned(),
            )
            .expect("cancel boundary transaction");
        let store = runtime.store.as_ref().unwrap();
        assert!(store
            .document()
            .entity(&EntityId("default-layer".to_owned()))
            .is_some());
        assert!(store
            .document()
            .tombstone(&EntityId("default-layer".to_owned()))
            .is_none());
        let curb = vec![
            position(397_842.125, 5_486_213.75, 312.48),
            position(397_846.125, 5_486_213.75, 312.56),
        ];
        let created = runtime
            .put_draw_curve(
                "draw-curb-create".to_owned(),
                input(
                    "curb-breakline",
                    None,
                    DrawCurveTool::Polyline,
                    DrawCurveRole::Breakline,
                    false,
                    curb.clone(),
                ),
            )
            .expect("create curb breakline");
        assert_eq!(created.curve.vertices, curb);
        let mut extended_curb = created.curve.vertices.clone();
        extended_curb.push(position(397_850.125, 5_486_213.75, 312.64));
        let extended = runtime
            .put_draw_curve(
                "draw-curb-vertex-3".to_owned(),
                input(
                    "curb-breakline",
                    Some(created.curve.revision),
                    DrawCurveTool::Polyline,
                    DrawCurveRole::Breakline,
                    false,
                    extended_curb.clone(),
                ),
            )
            .expect("extend curb breakline");
        assert_eq!(extended.curve.vertices, extended_curb);
        runtime
            .undo_draw_curve(
                "undo-curb-vertex-3".to_owned(),
                "draw-curb-vertex-3".to_owned(),
            )
            .expect("undo last curb vertex");
        assert_eq!(
            runtime.list_draw_curves().expect("curves")[0].vertices,
            curb
        );
        runtime
            .redo_draw_curve(
                "redo-curb-vertex-3".to_owned(),
                "draw-curb-vertex-3".to_owned(),
            )
            .expect("redo last curb vertex");

        let boundary = vec![
            position(397_840.0, 5_486_210.0, 312.4),
            position(397_855.0, 5_486_210.0, 312.5),
            position(397_855.0, 5_486_220.0, 312.7),
            position(397_840.0, 5_486_220.0, 312.6),
        ];
        runtime
            .put_draw_curve(
                "draw-boundary-create".to_owned(),
                input(
                    "fixture-boundary",
                    None,
                    DrawCurveTool::Boundary,
                    DrawCurveRole::Boundary,
                    true,
                    boundary.clone(),
                ),
            )
            .expect("create closed boundary");
        runtime.flush().expect("draw durability");
        assert!(runtime.close());

        runtime.open(&root).expect("reopen project");
        let curves = runtime.list_draw_curves().expect("reopen draw curves");
        assert_eq!(curves.len(), 2);
        let reopened_curb = curves
            .iter()
            .find(|curve| curve.entity_id == "curb-breakline")
            .expect("reopened curb");
        assert_eq!(reopened_curb.vertices, extended_curb);
        assert_eq!(reopened_curb.role, DrawCurveRole::Breakline);
        let reopened_boundary = curves
            .iter()
            .find(|curve| curve.entity_id == "fixture-boundary")
            .expect("reopened boundary");
        assert!(reopened_boundary.closed);
        assert_eq!(reopened_boundary.vertices, boundary);
        runtime
            .put_draw_curve(
                "draw-after-reopen".to_owned(),
                input(
                    "second-boundary",
                    None,
                    DrawCurveTool::Boundary,
                    DrawCurveRole::Boundary,
                    true,
                    vec![
                        position(0.0, 0.0, 1.0),
                        position(2.0, 0.0, 1.0),
                        position(2.0, 2.0, 1.0),
                    ],
                ),
            )
            .expect("draw a second boundary after reopen");
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn g_mi_command_measurements_round_trip_and_delete_atomically() {
        use himmelcad_core::entity_model::Position;
        use himmelcad_core::release_05_admissions::{
            MeasurementKindV1, MeasurementMetricV1, MeasurementVerificationV1,
        };

        let root = temp_project("measurement-round-trip");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let payload = MeasurementV1 {
            schema_id: MEASUREMENT_SCHEMA_ID.to_owned(),
            schema_version: 1,
            measurement_kind: MeasurementKindV1::Distance,
            metric: Some(MeasurementMetricV1::Spatial),
            anchors: vec![
                MeasurementAnchorV1::Fixed {
                    position: Position {
                        x: 1.0,
                        y: 2.0,
                        z: Some(3.0),
                    },
                },
                MeasurementAnchorV1::Fixed {
                    position: Position {
                        x: 4.0,
                        y: 6.0,
                        z: Some(15.0),
                    },
                },
            ],
            layer_id: EntityId("default-layer".to_owned()),
            visible: true,
            creation_view_id: Some("view-1".to_owned()),
            provenance: "ui".to_owned(),
            verification: MeasurementVerificationV1::Verified,
            result_cache: None,
        };
        let created = runtime
            .create_measurement(
                "measurement-create-1".to_owned(),
                "measurement-1".to_owned(),
                "Distance 1".to_owned(),
                payload.clone(),
            )
            .expect("create measurement");
        assert_eq!(created.measurement.measurement, payload);
        assert_eq!(
            created.journal_entry.kind,
            CanonicalJournalEntryKind::Command
        );
        assert_eq!(
            created.journal_entry.effects.len(),
            1,
            "measurement references the already-live default layer instead of creating it"
        );
        runtime.flush().expect("measurement durability");
        runtime.close();

        runtime.open(&root).expect("reopen project");
        let listed = runtime.list_measurements().expect("list measurements");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].measurement, payload);
        let deleted = runtime
            .delete_measurement(
                "measurement-delete-1".to_owned(),
                listed[0].entity_id.clone(),
                listed[0].revision,
            )
            .expect("delete measurement");
        assert_eq!(deleted.journal_entry.effects.len(), 1);
        assert!(runtime
            .list_measurements()
            .expect("list after delete")
            .is_empty());
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn entity(id: &str, name: &str) -> CanonicalEntity {
        let mut entity = CanonicalEntity {
            id: EntityId(id.to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::GROUP.to_owned()),
            name: name.to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: ObjectHash::of_bytes(b"components"),
            attributes_ref: ObjectHash::of_bytes(b"attributes"),
            relations_ref: ObjectHash::of_bytes(b"relations"),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        entity
    }

    fn staged_point_cloud(root: &Path) -> CanonicalStagedImport {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            json!({"schemaId": "hcad.components@1"}),
        )
        .expect("components");
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            json!({"pointCount": 1}),
        )
        .expect("attributes");
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            json!({"relations": []}),
        )
        .expect("relations");
        let metadata_bytes = br#"{"points":1,"boundingBox":{"min":[0,0,0],"max":[1,1,1]}}"#;
        let metadata = GeometryResource {
            object_hash: ObjectHash::of_bytes(metadata_bytes),
            media_type: "application/json".to_owned(),
            byte_length: Some(u64::try_from(metadata_bytes.len()).expect("length")),
        };
        let point_bytes = [0_f32, 0.5, 1.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let points = GeometryResource {
            object_hash: ObjectHash::of_bytes(&point_bytes),
            media_type: "hcad.positions-f32le-xyz@1".to_owned(),
            byte_length: Some(u64::try_from(point_bytes.len()).expect("point length")),
        };
        let typed_manifest = TypedArtifactManifest {
            schema_version: TypedArtifactManifest::SCHEMA_VERSION,
            artifacts: vec![TypedArtifactDescriptor {
                resource: points.clone(),
                semantic: "hcad.point-cloud.positions".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: points.byte_length.expect("point length"),
                    element_type: ArtifactElementType::Float32,
                    shape: vec![1, 3],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: None,
                },
            }],
        };
        let (typed_artifact, typed_bytes) = PreparedDatasetArtifact::typed_artifact_manifest(
            PathBuf::from(TYPED_ARTIFACT_MANIFEST_NAME),
            &typed_manifest,
        )
        .expect("typed manifest");
        let geometry = GeometryObject::PointCloud {
            dataset: StreamedGeometry {
                format_id: "potree@2".to_owned(),
                metadata: metadata.clone(),
                element_count: Some(1),
            },
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut cloud = CanonicalEntity {
            id: EntityId("cloud-a".to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: "Cloud".to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![selected.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending"),
        };
        cloud.version_hash = canonical_entity_version_hash(&cloud).expect("entity hash");
        let dataset_root = root.join("prepared-point-cloud");
        fs::create_dir_all(&dataset_root).expect("dataset root");
        fs::write(dataset_root.join("metadata.json"), metadata_bytes).expect("metadata");
        fs::write(dataset_root.join("points.bin"), point_bytes).expect("points");
        fs::write(dataset_root.join(TYPED_ARTIFACT_MANIFEST_NAME), typed_bytes)
            .expect("typed manifest");
        CanonicalStagedImport {
            package: CanonicalImportPackage {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: "test.potree@1".to_owned(),
                provider_version: "1".to_owned(),
                admissions: vec![CanonicalRepresentationAdmission {
                    entity: cloud,
                    selected,
                    representation_slot: "source".to_owned(),
                    expected_generation: None,
                    resolved_geometry: geometry,
                }],
                objects: vec![components, attributes, relations],
                datasets: vec![CanonicalPreparedDataset {
                    dataset_id: "dataset-a".to_owned(),
                    format_id: "potree@2".to_owned(),
                    entity_id: "cloud-a".to_owned(),
                    representation_slot: "source".to_owned(),
                    root_metadata: metadata.clone(),
                    artifacts: vec![
                        PreparedDatasetArtifact {
                            relative_path: PathBuf::from("metadata.json"),
                            resource: metadata,
                        },
                        PreparedDatasetArtifact {
                            relative_path: PathBuf::from("points.bin"),
                            resource: points,
                        },
                        typed_artifact,
                    ],
                }],
                resource_sets: Vec::new(),
                presentation_resources: Default::default(),
            },
            roots: StagedArtifactRoots {
                dataset_roots: BTreeMap::from([("dataset-a".to_owned(), dataset_root)]),
                resource_set_roots: BTreeMap::new(),
            },
        }
    }

    fn staged_ground_point_cloud(root: &Path) -> CanonicalStagedImport {
        let mut staged = staged_point_cloud(root);
        let metadata_bytes = serde_json::to_vec(&json!({
            "version": "2.0",
            "name": "small-las-fixture",
            "points": 20,
            "hierarchy": { "firstChunkSize": 22, "stepSize": 4, "depth": 0 },
            "offset": [0.0, 0.0, 0.0],
            "scale": [0.01, 0.01, 0.01],
            "spacing": 1.0,
            "boundingBox": { "min": [0.0, 0.0, 0.0], "max": [10.0, 4.0, 5.0] },
            "encoding": "UNCOMPRESSED",
            "attributes": [
                { "name": "position", "size": 12, "type": "int32" },
                { "name": "classification", "size": 1, "type": "uint8", "histogram": [0, 20] }
            ]
        }))
        .expect("metadata");
        let mut octree_bytes = Vec::new();
        for index in 0_i32..20 {
            let x = if index < 15 { index % 5 } else { 10 };
            let y = index / 5;
            let z = if index == 4 { 300 } else { x * 5 };
            octree_bytes.extend_from_slice(&(x * 100).to_le_bytes());
            octree_bytes.extend_from_slice(&(y * 100).to_le_bytes());
            octree_bytes.extend_from_slice(&z.to_le_bytes());
            octree_bytes.push(1);
        }
        let mut hierarchy_bytes = vec![0, 0];
        hierarchy_bytes.extend_from_slice(&20_u32.to_le_bytes());
        hierarchy_bytes.extend_from_slice(&0_u64.to_le_bytes());
        hierarchy_bytes.extend_from_slice(&(octree_bytes.len() as u64).to_le_bytes());

        let dataset_root = staged.roots.dataset_roots["dataset-a"].clone();
        fs::write(dataset_root.join("metadata.json"), &metadata_bytes).expect("metadata");
        fs::write(dataset_root.join("hierarchy.bin"), &hierarchy_bytes).expect("hierarchy");
        fs::write(dataset_root.join("octree.bin"), &octree_bytes).expect("octree");
        let resource = |bytes: &[u8], media_type: &str| GeometryResource {
            object_hash: ObjectHash::of_bytes(bytes),
            media_type: media_type.to_owned(),
            byte_length: Some(u64::try_from(bytes.len()).expect("artifact length")),
        };
        let metadata = resource(&metadata_bytes, "application/json");
        let hierarchy = resource(&hierarchy_bytes, "application/vnd.potree.hierarchy");
        let octree = resource(&octree_bytes, "application/vnd.potree.points");
        let geometry = GeometryObject::PointCloud {
            dataset: StreamedGeometry {
                format_id: "potree@2".to_owned(),
                metadata: metadata.clone(),
                element_count: Some(20),
            },
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let admission = &mut staged.package.admissions[0];
        admission.selected = selected.clone();
        admission.resolved_geometry = geometry;
        admission.entity.representations = vec![selected];
        admission.entity.version_hash =
            canonical_entity_version_hash(&admission.entity).expect("entity hash");
        staged.package.datasets[0] = CanonicalPreparedDataset {
            dataset_id: "dataset-a".to_owned(),
            format_id: "potree@2".to_owned(),
            entity_id: "cloud-a".to_owned(),
            representation_slot: "source".to_owned(),
            root_metadata: metadata.clone(),
            artifacts: vec![
                PreparedDatasetArtifact {
                    relative_path: PathBuf::from("metadata.json"),
                    resource: metadata,
                },
                PreparedDatasetArtifact {
                    relative_path: PathBuf::from("hierarchy.bin"),
                    resource: hierarchy,
                },
                PreparedDatasetArtifact {
                    relative_path: PathBuf::from("octree.bin"),
                    resource: octree,
                },
            ],
        };
        staged
    }

    fn request(method: AppProtocolRequest) -> AppProtocolRequestEnvelope {
        AppProtocolRequestEnvelope {
            schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
            request_id: "request-1".to_owned(),
            request: method,
            extensions: AppProtocolExtensions::from([(
                "test.extension@1".to_owned(),
                json!({"opaque": [1, 2, 3]}),
            )]),
        }
    }

    #[test]
    fn protocol_commits_reopens_and_pages_the_durable_journal() {
        let root = temp_project("roundtrip");
        let mut runtime = CanonicalAppRuntime::default();
        let opened = runtime.open(&root).expect("open project");
        assert_eq!(
            runtime.open(&root).expect("idempotent reopen"),
            opened,
            "renderer reload must not replace or reject the same project"
        );
        let project_root = opened.entities[0].clone();

        let accepted = runtime.dispatch(request(AppProtocolRequest::ExecuteCanonicalTransaction(
            CanonicalCommandTransaction {
                command_id: "rename-project".to_owned(),
                mutations: vec![CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&project_root),
                    edits: vec![CanonicalEntityEdit::SetName {
                        name: "Renamed".to_owned(),
                    }],
                }],
            },
        )));
        assert_eq!(
            accepted.extensions["test.extension@1"],
            json!({"opaque": [1, 2, 3]})
        );
        let AppProtocolResponse::TransactionAccepted(entry) = accepted.response else {
            panic!("accepted transaction expected");
        };
        let renamed = entry.effects[0].after.clone().expect("renamed entity");
        assert!(runtime.close());

        let snapshot = runtime.open(&root).expect("reopen project");
        assert!(snapshot.entities.contains(&renamed));
        assert_eq!(
            snapshot
                .entities
                .iter()
                .filter(|entity| entity.type_id.0 == SNAPSHOT_MARKER_SCHEMA_ID)
                .count(),
            2
        );
        let page = runtime.dispatch(request(AppProtocolRequest::ReadJournal(
            AppJournalReadRequest {
                after_sequence: 0,
                limit: 10,
            },
        )));
        let AppProtocolResponse::JournalPage(page) = page.response else {
            panic!("journal response expected");
        };
        assert_eq!(page.entries.len(), 4);
        assert_eq!(page.journal_head_sequence, 4);
        assert!(!page.has_more);

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn stale_property_selection_fails_closed_with_conflict_code() {
        let root = temp_project("conflict");
        let mut runtime = CanonicalAppRuntime::default();
        let snapshot = runtime.open(&root).expect("open project");
        let project_root = snapshot.entities[0].clone();

        let mut stale_hash = project_root.version_hash.clone();
        let replacement = if stale_hash.as_str().starts_with('0') {
            "1"
        } else {
            "0"
        };
        stale_hash.0.replace_range(0..1, replacement);
        let response = runtime.dispatch(request(AppProtocolRequest::QueryProperties(
            himmelcad_core::property_schema::PropertyQueryRequest {
                schema_id: himmelcad_core::property_schema::PROPERTY_QUERY_REQUEST_SCHEMA_ID
                    .to_owned(),
                entities: vec![EntityVersionRef {
                    id: project_root.id,
                    revision: 0,
                    version_hash: stale_hash,
                }],
                properties: Vec::new(),
            },
        )));
        let AppProtocolResponse::Error(error) = response.response else {
            panic!("structured conflict expected");
        };
        assert_eq!(error.code, "hcad.app.document.conflict");

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn canonical_create_rejects_unpublished_object_references() {
        let root = temp_project("missing-object");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let response = runtime.dispatch(request(AppProtocolRequest::ExecuteCanonicalTransaction(
            CanonicalCommandTransaction {
                command_id: "unsafe-create".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create {
                    entity: entity("unsafe", "Unsafe"),
                }],
            },
        )));
        let AppProtocolResponse::Error(error) = response.response else {
            panic!("missing object error expected");
        };
        assert_eq!(error.code, "hcad.app.object.not-found");

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn schemas_are_discoverable_without_an_open_project() {
        let mut runtime = CanonicalAppRuntime::default();
        let response = runtime.dispatch(request(AppProtocolRequest::ReadPropertySchemas));
        let AppProtocolResponse::PropertySchemas(schemas) = response.response else {
            panic!("property schemas expected");
        };
        assert_eq!(schemas.len(), 1);
    }

    #[test]
    fn residency_bootstrap_is_path_free_and_generation_bound() {
        let root = temp_project("residency-empty");
        let mut runtime = CanonicalAppRuntime::default();
        let snapshot = runtime.open(&root).expect("open project");
        let bootstrap = runtime.residency_bootstrap().expect("bootstrap");
        assert_eq!(bootstrap.schema_version, 1);
        assert_eq!(bootstrap.generation, snapshot.generation);
        assert!(bootstrap.entries.is_empty());
        let encoded = serde_json::to_string(&bootstrap).expect("encode bootstrap");
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn import_residency_reopens_exact_point_cloud_display_and_filters_deleted_entity() {
        let root = temp_project("residency-point-cloud");
        let staged = staged_point_cloud(&root);
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        runtime
            .publish_staged_import(&staged, "import-cloud")
            .expect("publish cloud");
        runtime.close();
        runtime.open(&root).expect("reopen project");

        let bootstrap = runtime.residency_bootstrap().expect("bootstrap");
        assert_eq!(bootstrap.entries.len(), 1);
        assert_eq!(bootstrap.entries[0].admission.entity.id.0, "cloud-a");
        let metadata = bootstrap.entries[0]
            .point_cloud
            .as_ref()
            .expect("point-cloud metadata");
        assert_eq!(metadata.point_count, 1);
        assert_eq!(metadata.display.point_size_pixels, 2.0);
        assert_eq!(
            bootstrap.entries[0]
                .dataset
                .as_ref()
                .expect("dataset")
                .dataset_id,
            "dataset-a"
        );
        let encoded = serde_json::to_string(&bootstrap).expect("encode bootstrap");
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));

        let mut display = metadata.display.clone();
        display.point_size_pixels = 4.5;
        display.color_mode = himmelcad_core::canonical_resources::PointCloudColorMode::Elevation;
        runtime
            .set_point_cloud_display(
                "point-cloud-display".to_owned(),
                vec![EntityVersionRef::from_entity(
                    &bootstrap.entries[0].admission.entity,
                )],
                display,
            )
            .expect("set display");
        runtime.flush().expect("flush display");
        runtime.close();
        runtime.open(&root).expect("reopen display edit");
        let updated = runtime.residency_bootstrap().expect("updated bootstrap");
        let updated_display = &updated.entries[0]
            .point_cloud
            .as_ref()
            .expect("updated metadata")
            .display;
        assert_eq!(updated_display.point_size_pixels, 4.5);
        assert_eq!(
            updated_display.color_mode,
            himmelcad_core::canonical_resources::PointCloudColorMode::Elevation
        );

        let points = staged.package.datasets[0]
            .artifacts
            .iter()
            .find(|artifact| artifact.resource.media_type == "hcad.positions-f32le-xyz@1")
            .expect("typed point artifact");
        let source = runtime
            .automation_object_source(&points.resource.object_hash)
            .expect("resolve typed artifact");
        assert_eq!(
            source
                .source_entity
                .as_ref()
                .map(|entity| entity.id.0.as_str()),
            Some("cloud-a")
        );
        assert_eq!(source.representation_slot.as_deref(), Some("source"));
        assert_eq!(
            source.geometry_ref.as_ref(),
            Some(&bootstrap.entries[0].admission.selected.geometry_ref)
        );
        assert!(matches!(
            source.typed_artifact.as_ref().map(|artifact| &artifact.layout),
            Some(TypedArtifactLayout::DenseArray {
                element_type: ArtifactElementType::Float32,
                shape,
                byte_strides: None,
                ..
            }) if shape == &[1, 3]
        ));

        let reconstructed = runtime
            .reconstruct_import_package("import-cloud")
            .expect("reconstruct package after restart");
        assert_eq!(reconstructed.provider_id, staged.package.provider_id);
        assert_eq!(
            reconstructed.provider_version,
            staged.package.provider_version
        );
        assert_eq!(
            reconstructed.admissions,
            vec![updated.entries[0].admission.clone()]
        );
        assert_eq!(reconstructed.datasets, staged.package.datasets);
        assert_eq!(
            reconstructed.presentation_resources,
            staged.package.presentation_resources
        );
        let export_package = runtime
            .reconstruct_export_package(&["cloud-a".to_owned()])
            .expect("capture user-level export scope");
        assert_eq!(export_package.admissions, reconstructed.admissions);
        assert_eq!(export_package.datasets, reconstructed.datasets);
        let materialized = root.join("export-materialized");
        runtime
            .materialize_export_artifacts(&export_package, &materialized)
            .expect("materialize exact artifact layout");
        assert_eq!(
            fs::read(materialized.join("dataset-a/metadata.json")).expect("metadata bytes"),
            fs::read(staged.roots.dataset_roots["dataset-a"].join("metadata.json"))
                .expect("source metadata")
        );

        let cloud = updated.entries[0].admission.entity.clone();
        let deleted = runtime.dispatch(request(AppProtocolRequest::ExecuteCanonicalTransaction(
            CanonicalCommandTransaction {
                command_id: "delete-cloud".to_owned(),
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef::from_entity(&cloud),
                }],
            },
        )));
        assert!(matches!(
            deleted.response,
            AppProtocolResponse::TransactionAccepted(_)
        ));
        assert!(runtime
            .residency_bootstrap()
            .expect("bootstrap after delete")
            .entries
            .is_empty());

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn ground_extraction_publishes_one_undoable_source_and_derived_cloud_transaction() {
        use crate::ground_classification::SmrfParams;
        use crate::pointcloud_ground::{
            prepare_ground_datasets, GroundPrepareRequest, GroundScope,
        };
        use himmelcad_core::photolab_jobs::CancellationToken;
        use himmelcad_core::release_05_admissions::{
            validate_mesh_source_roles, validate_recipe, DerivedRecipeV1, MeshSourceRolesV1,
        };

        let root = temp_project("ground-atomic-publication");
        let staged = staged_ground_point_cloud(&root);
        let scratch = root.join("ground-scratch");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        runtime
            .publish_staged_import(&staged, "import-ground-source")
            .expect("publish source");
        let source_before = runtime
            .residency_bootstrap()
            .expect("source residency")
            .entries[0]
            .admission
            .entity
            .clone();
        let source = runtime
            .prepare_ground_source(
                EntityVersionRef::from_entity(&source_before),
                scratch.join("input"),
            )
            .expect("capture exact source");
        let prepared = prepare_ground_datasets(
            &GroundPrepareRequest {
                metadata_path: source.input_root.join("metadata.json"),
                hierarchy_path: source.input_root.join("hierarchy.bin"),
                octree_path: source.input_root.join("octree.bin"),
                output_root: scratch.join("output"),
                output_name: "Ground".to_owned(),
                params: SmrfParams {
                    max_window_m: 3.0,
                    ..SmrfParams::default()
                },
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("prepare ground datasets");
        let commit = runtime
            .publish_ground_extraction(
                source,
                &prepared,
                "ground-extract-test".to_owned(),
                "ground-cloud-a".to_owned(),
                "Cloud — Ground".to_owned(),
                json!({
                    "cellSizeM": 1.0,
                    "slope": 0.15,
                    "maxWindowM": 3.0,
                    "initialDistanceM": 0.5
                }),
                serde_json::to_value(GroundScope::default()).expect("scope"),
                "2026-09-08T00:00:00Z".to_owned(),
                &mut |_| {},
                &|| false,
            )
            .expect("publish atomic ground result");
        assert_eq!(commit.journal_entry.effects.len(), 2);
        let store = runtime.store().expect("store");
        let source_after = store
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("edited source");
        assert_eq!(source_after.revision, source_before.revision + 1);
        let ground = store
            .document()
            .entity(&EntityId("ground-cloud-a".to_owned()))
            .expect("derived cloud");
        assert_eq!(ground.type_id.0, built_in_type::POINT_CLOUD);
        let components: serde_json::Value = serde_json::from_slice(
            &store
                .read_object(&ground.components_ref)
                .expect("components"),
        )
        .expect("components JSON");
        let roles: MeshSourceRolesV1 =
            serde_json::from_value(components["hcad.mesh-source-roles@1"].clone())
                .expect("mesh source roles");
        validate_mesh_source_roles(&roles).expect("DGM point-source admission");
        let attributes: serde_json::Value = serde_json::from_slice(
            &store
                .read_object(&ground.attributes_ref)
                .expect("attributes"),
        )
        .expect("attributes JSON");
        let recipe: DerivedRecipeV1 =
            serde_json::from_value(attributes["hcad.derived-recipe@1"].clone())
                .expect("derived recipe");
        validate_recipe(&recipe, &std::collections::BTreeMap::new()).expect("ground recipe");
        let native = runtime.residency_bootstrap().expect("native residency");
        assert_eq!(native.entries.len(), 2);
        assert!(native.entries.iter().all(|entry| {
            entry.dataset.as_ref().is_some_and(|dataset| {
                dataset.format_id == "potree@2" && dataset.artifacts.len() == 3
            })
        }));

        runtime
            .store_mut()
            .expect("store")
            .commit_undo("undo-ground-extract-test".to_owned(), "ground-extract-test")
            .expect("undo ground extraction");
        let store = runtime.store().expect("store after undo");
        let restored = store
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("restored source");
        assert_eq!(restored.revision, source_before.revision + 2);
        assert_eq!(restored.representations, source_before.representations);
        assert_eq!(restored.components_ref, source_before.components_ref);
        assert_eq!(restored.attributes_ref, source_before.attributes_ref);
        assert_eq!(restored.relations_ref, source_before.relations_ref);
        assert!(store
            .document()
            .entity(&EntityId("ground-cloud-a".to_owned()))
            .is_none());
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn segmentation_revisions_compose_and_each_undo_restores_its_source() {
        use crate::pointcloud_ground::GroundScope;
        use crate::pointcloud_segment::{
            prepare_segment_dataset, FenceVolume, SegmentPrepareRequest, SegmentSide,
        };
        use himmelcad_core::photolab_jobs::CancellationToken;

        let root = temp_project("segment-revision-chain");
        let staged = staged_ground_point_cloud(&root);
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        runtime
            .publish_staged_import(&staged, "import-segment-source")
            .expect("publish source");
        let source_before = runtime
            .residency_bootstrap()
            .expect("source residency")
            .entries[0]
            .admission
            .entity
            .clone();
        let fence = FenceVolume::Prism {
            polygon: vec![
                [-1.0, -1.0, 0.0],
                [6.0, -1.0, 0.0],
                [6.0, 6.0, 0.0],
                [-1.0, 6.0, 0.0],
            ],
            direction: [0.0, 0.0, 1.0],
        };
        let scope = GroundScope::default();
        let captured = runtime
            .prepare_ground_source(
                EntityVersionRef::from_entity(&source_before),
                root.join("segment-input-1"),
            )
            .expect("capture first source");
        let prepared = prepare_segment_dataset(
            &SegmentPrepareRequest {
                metadata_path: captured.input_root.join("metadata.json"),
                hierarchy_path: captured.input_root.join("hierarchy.bin"),
                octree_path: captured.input_root.join("octree.bin"),
                output_root: root.join("segment-output-1"),
                output_name: "Segmented".to_owned(),
                volume: fence.clone(),
                side: SegmentSide::KeepInside,
                scope: scope.clone(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("prepare first segment");
        assert_eq!(prepared.summary.retained_points, 15);
        let cancelled = runtime.publish_pointcloud_segmentation(
            vec![(
                captured.clone(),
                prepared.clone(),
                serde_json::to_value(&scope).expect("scope"),
            )],
            "segment-cancelled-publication".to_owned(),
            serde_json::to_value(&fence).expect("fence"),
            serde_json::to_value(SegmentSide::KeepInside).expect("side"),
            "2026-09-08T00:00:00Z".to_owned(),
            &mut |_| {},
            &|| true,
        );
        assert!(cancelled.is_err());
        let unchanged = runtime
            .store()
            .expect("store after cancelled publication")
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("unchanged source");
        assert_eq!(unchanged, &source_before);
        let first = runtime
            .publish_pointcloud_segmentation(
                vec![(
                    captured,
                    prepared,
                    serde_json::to_value(&scope).expect("scope"),
                )],
                "segment-first".to_owned(),
                serde_json::to_value(&fence).expect("fence"),
                serde_json::to_value(SegmentSide::KeepInside).expect("side"),
                "2026-09-08T00:00:00Z".to_owned(),
                &mut |_| {},
                &|| false,
            )
            .expect("publish first segment");
        assert_eq!(first.journal_entry.effects.len(), 1);

        let first_entity = runtime
            .store()
            .expect("store")
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("first revision")
            .clone();
        let captured_again = runtime
            .prepare_ground_source(
                EntityVersionRef::from_entity(&first_entity),
                root.join("segment-input-2"),
            )
            .expect("capture edited source");
        let second_fence = FenceVolume::Prism {
            polygon: vec![
                [-1.0, -1.0, 0.0],
                [2.5, -1.0, 0.0],
                [2.5, 6.0, 0.0],
                [-1.0, 6.0, 0.0],
            ],
            direction: [0.0, 0.0, 1.0],
        };
        let prepared_again = prepare_segment_dataset(
            &SegmentPrepareRequest {
                metadata_path: captured_again.input_root.join("metadata.json"),
                hierarchy_path: captured_again.input_root.join("hierarchy.bin"),
                octree_path: captured_again.input_root.join("octree.bin"),
                output_root: root.join("segment-output-2"),
                output_name: "Segmented again".to_owned(),
                volume: second_fence.clone(),
                side: SegmentSide::RemoveInside,
                scope: scope.clone(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("prepare repeated segment");
        runtime
            .publish_pointcloud_segmentation(
                vec![(
                    captured_again,
                    prepared_again,
                    serde_json::to_value(&scope).expect("scope"),
                )],
                "segment-second".to_owned(),
                serde_json::to_value(&second_fence).expect("fence"),
                serde_json::to_value(SegmentSide::RemoveInside).expect("side"),
                "2026-09-08T00:01:00Z".to_owned(),
                &mut |_| {},
                &|| false,
            )
            .expect("publish repeated segment");
        let second_entity = runtime
            .store()
            .expect("store")
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("second revision")
            .clone();
        assert_eq!(second_entity.revision, first_entity.revision + 1);
        let attributes: serde_json::Value = serde_json::from_slice(
            &runtime
                .store()
                .expect("store")
                .read_object(&second_entity.attributes_ref)
                .expect("attributes"),
        )
        .expect("attributes json");
        assert_eq!(
            attributes["hcad.point-cloud-edit-chain@1"]["edits"]
                .as_array()
                .expect("edit chain")
                .len(),
            2
        );

        runtime
            .store_mut()
            .expect("store")
            .commit_undo("undo-segment-second".to_owned(), "segment-second")
            .expect("undo second segment");
        let restored_first = runtime
            .store()
            .expect("store")
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("restored first");
        assert_eq!(restored_first.representations, first_entity.representations);
        assert_eq!(restored_first.components_ref, first_entity.components_ref);
        assert_eq!(restored_first.attributes_ref, first_entity.attributes_ref);
        runtime
            .store_mut()
            .expect("store")
            .commit_undo("undo-segment-first".to_owned(), "segment-first")
            .expect("undo first segment");
        let restored_source = runtime
            .store()
            .expect("store")
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("restored source");
        assert_eq!(
            restored_source.representations,
            source_before.representations
        );
        assert_eq!(restored_source.components_ref, source_before.components_ref);
        assert_eq!(restored_source.attributes_ref, source_before.attributes_ref);
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn sampling_and_height_grid_publish_immutable_undoable_prepared_entities() {
        use crate::pointcloud_ground::GroundScope;
        use crate::pointcloud_sampling::{
            prepare_height_grid, prepare_sampled_cloud, EmptyCellPolicy, RasterAggregation,
            RasterizeParameters, RasterizePrepareRequest, SamplePrepareRequest, SamplingMethod,
            SamplingParameters,
        };
        use himmelcad_core::photolab_jobs::CancellationToken;
        use himmelcad_core::release_05_admissions::{
            validate_mesh_source_roles, validate_recipe, DerivedRecipeV1, MeshSourceRolesV1,
        };

        let root = temp_project("sampling-raster-publication");
        let staged = staged_ground_point_cloud(&root);
        let scratch = root.join("sampling-scratch");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        runtime
            .publish_staged_import(&staged, "import-sampling-source")
            .expect("publish source");
        let source_before = runtime
            .residency_bootstrap()
            .expect("source residency")
            .entries[0]
            .admission
            .entity
            .clone();

        let source = runtime
            .prepare_ground_source(
                EntityVersionRef::from_entity(&source_before),
                scratch.join("sample-input"),
            )
            .expect("capture sample source");
        let prepared_sample = prepare_sampled_cloud(
            &SamplePrepareRequest {
                metadata_path: source.input_root.join("metadata.json"),
                hierarchy_path: source.input_root.join("hierarchy.bin"),
                octree_path: source.input_root.join("octree.bin"),
                output_root: scratch.join("sample-output"),
                output_name: "Sampled".to_owned(),
                parameters: SamplingParameters {
                    method: SamplingMethod::Grid,
                    spacing_m: 2.0,
                    percentage: 50.0,
                    origin_x: Some(0.0),
                    origin_y: Some(0.0),
                },
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("prepare sample");
        let sample_commit = runtime
            .publish_sampled_cloud(
                source,
                &prepared_sample,
                "sample-test".to_owned(),
                "sampled-cloud-a".to_owned(),
                "Cloud — Sampled".to_owned(),
                json!({ "method": "grid", "spacingM": 2.0 }),
                serde_json::to_value(GroundScope::default()).expect("scope"),
                "2026-09-08T00:00:00Z".to_owned(),
                &mut |_| {},
                &|| false,
            )
            .expect("publish sampled cloud");
        assert_eq!(sample_commit.journal_entry.effects.len(), 1);
        let store = runtime.store().expect("store after sample");
        let source_after_sample = store
            .document()
            .entity(&EntityId("cloud-a".to_owned()))
            .expect("immutable source");
        assert_eq!(source_after_sample, &source_before);
        let sampled = store
            .document()
            .entity(&EntityId("sampled-cloud-a".to_owned()))
            .expect("sampled cloud");
        let sampled_attributes: serde_json::Value = serde_json::from_slice(
            &store
                .read_object(&sampled.attributes_ref)
                .expect("sample attributes"),
        )
        .expect("sample attributes JSON");
        let sample_recipe: DerivedRecipeV1 =
            serde_json::from_value(sampled_attributes["hcad.derived-recipe@1"].clone())
                .expect("sample recipe");
        assert_eq!(sample_recipe.recipe_kind, SAMPLE_ALGORITHM_ID);
        validate_recipe(&sample_recipe, &std::collections::BTreeMap::new())
            .expect("admitted sample recipe");
        runtime
            .store_mut()
            .expect("store")
            .commit_undo("undo-sample-test".to_owned(), "sample-test")
            .expect("undo sample");
        assert!(runtime
            .store()
            .expect("store after sample undo")
            .document()
            .entity(&EntityId("sampled-cloud-a".to_owned()))
            .is_none());

        let source = runtime
            .prepare_ground_source(
                EntityVersionRef::from_entity(&source_before),
                scratch.join("raster-input"),
            )
            .expect("capture raster source");
        let prepared_grid = prepare_height_grid(
            &RasterizePrepareRequest {
                metadata_path: source.input_root.join("metadata.json"),
                hierarchy_path: source.input_root.join("hierarchy.bin"),
                octree_path: source.input_root.join("octree.bin"),
                output_root: scratch.join("raster-output"),
                parameters: RasterizeParameters {
                    cell_size_m: 2.0,
                    origin_x: Some(0.0),
                    origin_y: Some(0.0),
                    aggregation: RasterAggregation::Mean,
                    empty_cell_policy: EmptyCellPolicy::NoData,
                },
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("prepare mean grid");
        let grid_commit = runtime
            .publish_height_grid(
                source,
                &prepared_grid,
                "rasterize-test".to_owned(),
                "height-grid-a".to_owned(),
                "Cloud — Mean height".to_owned(),
                json!({ "aggregation": "mean", "cellSizeM": 2.0 }),
                serde_json::to_value(GroundScope::default()).expect("scope"),
                "2026-09-08T00:00:01Z".to_owned(),
                &mut |_| {},
                &|| false,
            )
            .expect("publish height grid");
        assert_eq!(grid_commit.journal_entry.effects.len(), 1);
        assert_eq!(grid_commit.mesh_source_role.as_deref(), Some("grid_source"));
        let store = runtime.store().expect("store after rasterize");
        assert_eq!(
            store
                .document()
                .entity(&EntityId("cloud-a".to_owned()))
                .expect("immutable source after rasterize"),
            &source_before
        );
        let grid = store
            .document()
            .entity(&EntityId("height-grid-a".to_owned()))
            .expect("height grid");
        assert_eq!(grid.type_id.0, built_in_type::ELEVATION_SURFACE);
        let grid_components: serde_json::Value = serde_json::from_slice(
            &store
                .read_object(&grid.components_ref)
                .expect("grid components"),
        )
        .expect("grid components JSON");
        let roles: MeshSourceRolesV1 =
            serde_json::from_value(grid_components["hcad.mesh-source-roles@1"].clone())
                .expect("grid source roles");
        validate_mesh_source_roles(&roles).expect("sealed grid source roles");
        assert_eq!(roles.roles[0].source.role, "grid_source");
        let grid_attributes: serde_json::Value = serde_json::from_slice(
            &store
                .read_object(&grid.attributes_ref)
                .expect("grid attributes"),
        )
        .expect("grid attributes JSON");
        let grid_recipe: DerivedRecipeV1 =
            serde_json::from_value(grid_attributes["hcad.derived-recipe@1"].clone())
                .expect("grid recipe");
        validate_recipe(&grid_recipe, &std::collections::BTreeMap::new())
            .expect("admitted height-grid recipe");
        runtime
            .store_mut()
            .expect("store")
            .commit_undo("undo-rasterize-test".to_owned(), "rasterize-test")
            .expect("undo rasterize");
        let store = runtime.store().expect("store after rasterize undo");
        assert!(store
            .document()
            .entity(&EntityId("height-grid-a".to_owned()))
            .is_none());
        assert_eq!(
            store
                .document()
                .entity(&EntityId("cloud-a".to_owned()))
                .expect("source remains after undo")
                .representations,
            source_before.representations
        );
        runtime.close();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn photolab_product_import_is_idempotent_and_copies_package_payload_to_cas() {
        #[derive(Default)]
        struct Context;

        impl ProviderOperationContext for Context {
            fn is_cancelled(&self) -> bool {
                false
            }

            fn report_progress(&mut self, _progress: ProviderProgress) {}
        }

        let package_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad/.photolab/\
             product-import-packages/product-9ad8b3224d97b1430358a6d3962cd7c0d55cb1f2c85cb89536b53f81a87c5be9",
        );
        if !package_root.join("ready.json").is_file() {
            return;
        }
        let provider = PhotoLabProductPackageProvider::new();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &package_root,
                    format_id: PRODUCT_IMPORT_PACKAGE_FORMAT_ID,
                    options: &json!({}),
                },
                &mut Context,
            )
            .expect("validated PhotoLab package");
        let roots = provider
            .staged_artifact_roots(&package)
            .expect("package authority roots");
        let staged = CanonicalStagedImport { package, roots };
        let project_root = temp_project("photolab-product-import");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&project_root).expect("open project");

        let first = runtime
            .publish_staged_import(&staged, "photolab-import-first")
            .expect("register product");
        let generation_after_first = runtime.store().expect("store").document().generation();
        let repeated = runtime
            .publish_staged_import(&staged, "photolab-import-repeat")
            .expect("idempotent registration");
        assert_eq!(repeated, first);
        assert_eq!(
            runtime.store().expect("store").document().generation(),
            generation_after_first
        );
        assert!(first.inventory.external_objects.is_empty());
        let stored = first
            .inventory
            .datasets
            .iter()
            .flat_map(|dataset| &dataset.artifacts)
            .map(|artifact| &artifact.resource)
            .find(|resource| resource.media_type == "application/octet-stream")
            .expect("copied package payload");
        let (prefix, remainder) = stored.object_hash.as_str().split_at(2);
        let cas_path = project_root.join("objects").join(prefix).join(remainder);
        assert!(cas_path.exists());
        assert_eq!(
            runtime
                .store()
                .expect("store")
                .object_byte_length(&stored.object_hash)
                .expect("copied package object"),
            stored.byte_length.expect("stored byte length")
        );
        let expected_prefix = fs::read(&cas_path).expect("package object");
        let range_length = u64::try_from(expected_prefix.len().min(32)).expect("range length");
        let (metadata, prefix) = runtime
            .read_residency_resource_range(&stored.object_hash, 0, range_length)
            .expect("bounded CAS range");
        assert_eq!(metadata.object_hash, stored.object_hash);
        assert_eq!(prefix, expected_prefix[..prefix.len()]);
        assert_eq!(
            runtime
                .photolab_product_provenance(&[first.inventory.admissions[0].entity_id.clone()])
                .expect("provenance")
                .len(),
            1
        );

        let imported_entity_id = EntityId(first.inventory.admissions[0].entity_id.clone());
        let undo = runtime
            .undo_document("photolab-import-undo".to_owned())
            .expect("undo imported product");
        assert_eq!(undo.kind, CanonicalJournalEntryKind::Undo);
        assert_eq!(
            undo.related_command_id.as_deref(),
            Some("photolab-import-first")
        );
        assert!(runtime
            .store()
            .expect("store after import undo")
            .document()
            .entity(&imported_entity_id)
            .is_none());
        assert!(runtime
            .residency_bootstrap()
            .expect("residency after import undo")
            .entries
            .is_empty());
        assert!(
            cas_path.exists(),
            "undo must retain the immutable CAS object"
        );

        runtime.close();
        runtime
            .open(&project_root)
            .expect("reopen project after undo");
        assert!(runtime
            .store()
            .expect("reopened store")
            .document()
            .entity(&imported_entity_id)
            .is_none());
        let redo = runtime
            .redo_document("photolab-import-redo".to_owned())
            .expect("redo imported product after reopen");
        assert_eq!(redo.kind, CanonicalJournalEntryKind::Redo);
        assert_eq!(
            redo.related_command_id.as_deref(),
            Some("photolab-import-first")
        );
        assert!(runtime
            .store()
            .expect("store after import redo")
            .document()
            .entity(&imported_entity_id)
            .is_some());
        assert_eq!(
            runtime
                .residency_bootstrap()
                .expect("residency after import redo")
                .entries
                .len(),
            1
        );
        assert!(cas_path.exists(), "redo must reuse the retained CAS object");
        runtime.close();
        fs::remove_dir_all(project_root).expect("cleanup");
    }
}
