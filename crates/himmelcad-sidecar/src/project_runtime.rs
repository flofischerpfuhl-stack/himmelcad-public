//! Desktop project storage with local working copies, atomic manifests, and journals.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

use anyhow::{Context, Result};
use fs2::FileExt;
use himmelcad_core::entity::{EntityId, EntityKind, EntitySnapshot, VisibilityState};
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, EntityTypeId, GeometryObject, GeometryResource, Representation,
    RepresentationAuthority, RepresentationRole, SolidGeometry, TriangleMeshGeometry,
    TriangleMeshStorage,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::geometry_representation_registry::SectionTopologyPartitionManifest;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_crs::{CrsDefinition, FrozenImportTransformation};
use himmelcad_core::photolab_gcp_optimization::GcpIntrinsicsPolicy;
use himmelcad_core::photolab_images::DjiBrownConradyCalibration;
use himmelcad_core::photolab_jobs::{
    CancellationToken, PhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
};
use himmelcad_core::photolab_masks::{
    ComputeImageMask, ImageMaskCatalog, ImageMaskCatalogEntry, ImageMaskComputeScope,
    ImageMaskEdit, ImageMaskRaster, ImageMaskRevisionRecord,
};
use himmelcad_core::photolab_products::ImageProductTag;
use himmelcad_core::photolab_project::{
    initial_photolab_manifest, JournalCommandState, OpenPhotolabProjectResult,
    PhotolabJournalEntry, PhotolabProjectManifest, ProjectSessionSummary,
    PHOTOLAB_PROJECT_FORMAT_VERSION,
};
use himmelcad_core::typed_artifact::{TypedArtifactManifest, TYPED_ARTIFACT_MANIFEST_NAME};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use himmelcad_io::{CanonicalImportJsonObject, CanonicalPreparedDataset, PreparedDatasetArtifact};
use himmelcad_sidecar::alignment_merge_runtime::{
    inspect_solved_merge, AlignmentMergeEvidenceReport, MergeInputScope, SharedControlMergeOutcome,
};
use himmelcad_sidecar::brush_runtime::{BrushOutputSummary, BrushRunOutcome};
use himmelcad_sidecar::camera_export::CameraCalibrationExportGroup;
use himmelcad_sidecar::colmap_runtime::{
    ColmapArtifactKind, ColmapArtifactSummary, ColmapCalibrationGroup, ColmapCalibrationSeed,
    ColmapIntrinsicsRefinement, ColmapRunOutcome, SelectedMapper,
};
use himmelcad_sidecar::dense_raster_prep::PreparedPotreeCloud;
use himmelcad_sidecar::gcp_local_estimate_runtime::{
    compute_gcp_local_estimate, read_gcp_local_estimate, ComputeGcpLocalEstimateParams,
    GcpLocalEstimateArtifact, ReadGcpLocalEstimateParams,
};
use himmelcad_sidecar::gcp_optimization_runtime::RunGcpOptimizationResult;
use himmelcad_sidecar::gcp_runtime::{
    commit_gcps_transaction, create_gcp_optimization_snapshot_transaction,
    edit_gcp_observation_transaction, read_gcp_collection, upsert_gcp_observation_transaction,
    upsert_gcp_observations_transaction, CancelGcpOperationParams, CancelGcpOperationResult,
    CommitGcpsParams, CommitGcpsResult, CreateGcpOptimizationSnapshotParams,
    CreateGcpOptimizationSnapshotResult, EditGcpObservationParams, EditGcpObservationResult,
    GcpCollectionRecord, UpsertGcpObservationParams, UpsertGcpObservationResult,
    UpsertGcpObservationsParams, UpsertGcpObservationsResult,
};
use himmelcad_sidecar::image_commit::{
    commit_images_transaction_with_progress, read_project_camera_images, CameraImageMetadataRecord,
    CancelImageCommitParams, CancelImageCommitResult, CommitImagesParams, CommitImagesResult,
    ProjectCameraImageRecord,
};
use himmelcad_sidecar::image_mask_runtime::{apply_brush_stroke, ImageMaskRuntimeError};
use himmelcad_sidecar::image_quality_runtime::{
    ImageQualityAnalysisRecord, ImageQualityCatalog, ImageQualityOutcome,
};
#[cfg(test)]
use himmelcad_sidecar::image_quality_runtime::{
    ImageQualityMetrics, ImageQualityScope, ImageQualityWarning,
};
use himmelcad_sidecar::job_runtime::{
    DrainReport, FrozenJobRequest, JobHistoryPersistence, JobHistoryScope,
};
use himmelcad_sidecar::mesh_tiler::PreparedMeshProduct;
use himmelcad_sidecar::mvs_runtime::{
    MvsCommandReport, MvsOutputIndex, MvsRunOutcome, MvsSceneManifest,
};
use himmelcad_sidecar::pointcloud_export::PointCloudExportFormat;
use himmelcad_sidecar::product_export::{
    ProductExportConversion, ProductExportSource, ProductExportSourceKind,
};
use himmelcad_sidecar::project_archive::{
    pack_hcadx, unpack_hcadx, ArchivePhase, ArchiveProgress, PackArchiveOptions,
    UnpackArchiveLimits,
};
use himmelcad_sidecar::raster_runtime::{raster_checkpoint_content_key, RasterBuildSummary};
use himmelcad_sidecar::splat_tiler::PreparedSplatProduct;

static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(1);
const PROJECT_LEASE_SCHEMA_VERSION: u32 = 1;
const SOURCE_HASH_BUFFER_BYTES: usize = 1024 * 1024;
const JOB_HISTORY_SCHEMA_VERSION: u32 = 1;
const MAX_DURABLE_JOB_RECORDS: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectJobHistoryFile {
    schema_version: u32,
    project_id: String,
    #[serde(default)]
    jobs: Vec<PhotolabJob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectJobHistoryRecord {
    schema_version: u32,
    project_id: String,
    job: PhotolabJob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frozen_request: Option<FrozenJobRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSourceFingerprint {
    pub kind: ProjectSourceFingerprintKind,
    pub sha256: ObjectHash,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectSourceFingerprintKind {
    Manifest,
    Archive,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLeaseRecord {
    pub schema_version: u32,
    pub session_id: String,
    pub host_name: String,
    pub user_name: String,
    pub process_id: u32,
    pub process_name: String,
    pub source_fingerprint: ProjectSourceFingerprint,
    pub opened_unix_ms: u64,
    pub heartbeat_unix_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectParams {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectParams {
    pub path: String,
    pub working_root: String,
    #[serde(default = "default_true")]
    pub use_local_working_copy: bool,
    #[serde(default)]
    pub recover_existing_working_copy: bool,
    #[serde(default)]
    pub archive_operation_id: Option<String>,
    #[serde(default)]
    pub progress_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectAsParams {
    pub path: String,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub include_rebuildable_index: bool,
    #[serde(default)]
    pub archive_operation_id: Option<String>,
    #[serde(default)]
    pub progress_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProcessingSetParams {
    pub name: String,
    pub camera_entity_ids: Vec<EntityId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingSetRecord {
    pub schema_version: u32,
    pub entity_id: EntityId,
    pub name: String,
    pub camera_entity_ids: Vec<EntityId>,
    pub membership_sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capture_group_ids: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calibration_group_ids: Vec<EntityId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraCalibrationGroupingBasis {
    MissionAutofocus,
    EmbeddedCalibration,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CaptureGroupReviewStatus {
    NeedsReview,
    #[default]
    Confirmed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraCalibrationSeed {
    pub width_pixels: u32,
    pub height_pixels: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal_pixels: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_x_pixels: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_y_pixels: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_brown_calibration: Option<DjiBrownConradyCalibration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraCalibrationGroupRecord {
    pub schema_version: u32,
    pub entity_id: EntityId,
    pub capture_group_id: EntityId,
    pub name: String,
    pub camera_entity_ids: Vec<EntityId>,
    pub membership_sha256: ObjectHash,
    pub grouping_basis: CameraCalibrationGroupingBasis,
    #[serde(default)]
    pub review_status: CaptureGroupReviewStatus,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_calibration: Option<CameraCalibrationSeed>,
    #[serde(default)]
    pub intrinsics_policy: GcpIntrinsicsPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureGroupRecord {
    pub schema_version: u32,
    pub entity_id: EntityId,
    pub name: String,
    pub camera_entity_ids: Vec<EntityId>,
    pub membership_sha256: ObjectHash,
    pub calibration_group_ids: Vec<EntityId>,
    #[serde(default)]
    pub review_status: CaptureGroupReviewStatus,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCalibrationGroupInput {
    pub name: String,
    pub camera_entity_ids: Vec<EntityId>,
    pub grouping_basis: CameraCalibrationGroupingBasis,
    #[serde(default)]
    pub initial_calibration: Option<CameraCalibrationSeed>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCaptureGroupParams {
    pub name: String,
    pub camera_entity_ids: Vec<EntityId>,
    pub calibration_groups: Vec<CreateCalibrationGroupInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmCaptureGroupParams {
    pub capture_group_id: EntityId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCalibrationGroupIntrinsicsParams {
    pub calibration_group_id: EntityId,
    pub intrinsics_policy: GcpIntrinsicsPolicy,
}

#[derive(Debug, Clone)]
struct AutomaticCalibrationGroup {
    name: String,
    camera_entity_ids: Vec<EntityId>,
    grouping_basis: CameraCalibrationGroupingBasis,
    initial_calibration: Option<CameraCalibrationSeed>,
    evidence: Vec<String>,
}

#[derive(Debug, Clone)]
struct AutomaticCaptureGroup {
    name: String,
    camera_entity_ids: Vec<EntityId>,
    calibration_groups: Vec<AutomaticCalibrationGroup>,
    evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AlignmentMergeConnection {
    Overlap {
        alignment_a: EntityId,
        alignment_b: EntityId,
        verified_cross_run_track_count: u64,
    },
    SharedControls {
        alignment_a: EntityId,
        alignment_b: EntityId,
        control_point_ids: Vec<String>,
    },
}

impl AlignmentMergeConnection {
    fn endpoints(&self) -> (&EntityId, &EntityId) {
        match self {
            Self::Overlap {
                alignment_a,
                alignment_b,
                ..
            }
            | Self::SharedControls {
                alignment_a,
                alignment_b,
                ..
            } => (alignment_a, alignment_b),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergedAlignmentState {
    Planned,
    Published,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedAlignmentRunRecord {
    pub schema_version: u32,
    pub entity_id: EntityId,
    pub name: String,
    pub state: MergedAlignmentState,
    pub input_alignment_entity_ids: Vec<EntityId>,
    pub input_gcp_optimization_entity_ids: Vec<EntityId>,
    pub connections: Vec<AlignmentMergeConnection>,
    pub camera_entity_ids: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
    pub lineage_sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_relative_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlignmentMergeParams {
    pub name: String,
    pub input_alignment_entity_ids: Vec<EntityId>,
    #[serde(default)]
    pub input_gcp_optimization_entity_ids: Vec<EntityId>,
    pub connections: Vec<AlignmentMergeConnection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentMergeCandidateRecord {
    pub entity_id: EntityId,
    pub name: String,
    pub job_id: String,
    pub publication_sequence: u64,
    pub camera_entity_ids: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calibration_group_ids: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calibration_groups: Vec<ColmapCalibrationGroup>,
}

#[derive(Debug, Clone)]
pub struct AlignmentMergeComputeContext {
    pub record: MergedAlignmentRunRecord,
    pub project: ProjectComputeContext,
    pub input_camera_scopes: HashMap<String, Vec<String>>,
    pub input_dataset_roots: HashMap<String, PathBuf>,
    pub optimization_records: HashMap<String, GcpOptimizationPublicationRecord>,
    pub calibration_groups: Vec<ColmapCalibrationGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelArchiveParams {
    pub archive_operation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelArchiveResult {
    pub archive_operation_id: String,
    pub cancellation_requested: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendJournalParams {
    pub command_kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub affected_entities: Vec<himmelcad_core::entity::EntityId>,
    #[serde(default)]
    pub before_refs: Vec<ObjectHash>,
    #[serde(default)]
    pub after_refs: Vec<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishJournalParams {
    pub command_id: String,
    pub state: JournalCommandState,
    #[serde(default)]
    pub affected_entities: Vec<himmelcad_core::entity::EntityId>,
    #[serde(default)]
    pub after_refs: Vec<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntityParams {
    pub entity_id: EntityId,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEntityVisibilityParams {
    pub entity_id: EntityId,
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveEntityParams {
    pub entity_id: EntityId,
    pub new_parent_id: EntityId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCameraImagesParams {
    pub entity_ids: Vec<EntityId>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditImageMaskParams {
    pub operation_id: String,
    pub image_entity_id: EntityId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision_sha256: Option<ObjectHash>,
    pub edit: ImageMaskEdit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditImageMaskResult {
    pub operation_id: String,
    pub revision_sha256: ObjectHash,
    pub raster_object_hash: Option<ObjectHash>,
    pub masked_pixel_count: u64,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
}

/// The current immutable mask revision together with its content-store identity.
/// The hash cannot be embedded in `ImageMaskRevisionRecord` itself because it is
/// the hash of that canonical record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedImageMaskRevision {
    pub revision_sha256: ObjectHash,
    #[serde(flatten)]
    pub revision: ImageMaskRevisionRecord,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelImageMaskParams {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelImageMaskResult {
    pub operation_id: String,
    pub cancellation_requested: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveResult {
    pub autosave_generation: u64,
    pub last_saved_generation: u64,
    pub dirty: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved_generation: u64,
    pub source_path: String,
}

#[derive(Debug, Clone)]
pub struct ProjectComputeContext {
    pub working_path: PathBuf,
    pub manifest: PhotolabProjectManifest,
    pub camera_images: Vec<ProjectCameraImageRecord>,
}

#[derive(Debug, Clone)]
pub struct PublishedAlignmentDataset {
    pub root: PathBuf,
    pub camera_entity_ids: Vec<String>,
    pub source_alignment_entity_id: EntityId,
    pub processing_set_id: Option<EntityId>,
    pub image_mask_scope_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductLineage {
    pub source_alignment_entity_id: EntityId,
    pub processing_set_id: Option<EntityId>,
    pub gcp_optimization_entity_id: Option<EntityId>,
    pub gcp_optimization_snapshot_sha256: Option<ObjectHash>,
    pub image_mask_scope_sha256: ObjectHash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeArtifactRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub dataset_relative_path: String,
    pub artifact: ColmapArtifactSummary,
    #[serde(default)]
    pub camera_entity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
    /// Frozen intrinsics partition copied from the worker request that produced this alignment.
    #[serde(default)]
    pub calibration_groups: Vec<ColmapCalibrationGroup>,
    #[serde(default)]
    pub intrinsics_refinement: ColmapIntrinsicsRefinement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default)]
    pub publication_sequence: u64,
    pub selected_mapper: SelectedMapper,
    pub tool_manifest_sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub potree: Option<PreparedPotreeCloud>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishColmapResult {
    pub job_id: String,
    pub entity_ids: Vec<EntityId>,
    pub autosave_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushArtifactRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub dataset_relative_path: String,
    pub summary_sha256: ObjectHash,
    pub summary: BrushOutputSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_snapshot_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_splats: Option<PreparedSplatProduct>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PublishedRasterKind {
    Dem,
    Orthomosaic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterArtifactRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub kind: PublishedRasterKind,
    pub dataset_relative_path: String,
    pub summary: RasterBuildSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_snapshot_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvsArtifactRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub dataset_relative_path: String,
    pub output_index_sha256: ObjectHash,
    pub output: MvsOutputIndex,
    pub command: MvsCommandReport,
    #[serde(default)]
    pub camera_entity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_snapshot_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub potree: Option<PreparedPotreeCloud>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationPublicationRecord {
    pub schema_version: u32,
    pub operation_id: String,
    pub input_sha256: ObjectHash,
    pub artifact_sha256: ObjectHash,
    pub snapshot_sha256: ObjectHash,
    pub artifact: himmelcad_sidecar::gcp_optimization_runtime::GcpOptimizationArtifact,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default)]
    pub publication_sequence: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedGcpOptimizationEntry {
    pub entity_id: EntityId,
    pub optimization: GcpOptimizationPublicationRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshArtifactRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub dataset_relative_path: String,
    pub textured: bool,
    pub prepared: PreparedMeshProduct,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_dataset: Option<CanonicalPreparedDataset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_artifact: Option<ColmapArtifactSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_snapshot_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
}

#[derive(Debug)]
enum PublishedMeshRecord {
    Prepared(Box<MeshArtifactRecord>),
    Colmap(Box<ComputeArtifactRecord>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProductDatasetRecord {
    pub entity_id: EntityId,
    pub kind: String,
    pub relative_path: String,
    pub format: String,
    pub visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_mesh: Option<ProjectPreparedMeshDatasetRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_offset: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_entity_id: Option<EntityId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gcp_optimization_snapshot_sha256: Option<ObjectHash>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreparedMeshDatasetRecord {
    pub dataset_id: String,
    pub provider_id: String,
    pub provider_version: String,
    pub render_manifest_relative_path: String,
    pub render_manifest_resource: GeometryResource,
    pub preparation_descriptor_relative_path: String,
    pub preparation_descriptor_resource: GeometryResource,
    pub section_topology_relative_path: String,
    pub section_topology_resource: GeometryResource,
    pub canonical_admission: CanonicalRepresentationAdmission,
    pub canonical_objects: Vec<CanonicalImportJsonObject>,
    pub canonical_dataset: CanonicalPreparedDataset,
}

fn package_prepared_mesh_dataset(
    dataset_root: &Path,
    prepared: &PreparedMeshProduct,
    entity_id: &EntityId,
) -> Result<CanonicalPreparedDataset> {
    let render_path = prepared
        .kernel_manifest_relative_path
        .as_ref()
        .context("prepared mesh has no kernel manifest path")?;
    let render_resource = prepared
        .kernel_manifest_resource
        .as_ref()
        .context("prepared mesh has no kernel manifest resource")?;
    let preparation_path = prepared
        .preparation_descriptor_relative_path
        .as_ref()
        .context("prepared mesh has no preparation descriptor path")?;
    let preparation_resource = prepared
        .preparation_descriptor_resource
        .as_ref()
        .context("prepared mesh has no preparation descriptor resource")?;
    let topology = prepared
        .section_topology
        .as_ref()
        .context("prepared mesh has no section topology")?;
    anyhow::ensure!(
        !topology.parts.is_empty(),
        "prepared mesh section topology is empty"
    );
    let topology_parent = topology
        .manifest_relative_path
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut artifacts = vec![
        verified_dataset_artifact(dataset_root, render_path, render_resource)?,
        verified_dataset_artifact(dataset_root, preparation_path, preparation_resource)?,
        verified_dataset_artifact(
            dataset_root,
            &topology.manifest_relative_path,
            &topology.manifest_resource,
        )?,
    ];
    let mut descriptors = Vec::new();
    for part in &topology.parts {
        let manifest_relative = topology_parent.join(safe_mesh_artifact_url(&part.manifest_url)?);
        let manifest_path = dataset_root.join(&manifest_relative);
        let manifest_bytes = fs::read(&manifest_path)?;
        let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(&manifest_bytes)?;
        anyhow::ensure!(
            manifest.content_hash()?.as_str() == part.topology_hash,
            "section topology partition hash mismatch for {}",
            part.part_id
        );
        let manifest_resource = GeometryResource {
            object_hash: ObjectHash::of_bytes(&manifest_bytes),
            media_type: "hcad.section-topology-partition@1".to_owned(),
            byte_length: Some(u64::try_from(manifest_bytes.len()).unwrap_or(u64::MAX)),
        };
        artifacts.push(verified_dataset_artifact(
            dataset_root,
            &manifest_relative,
            &manifest_resource,
        )?);
        let position_relative = topology_parent.join(safe_mesh_artifact_url(&part.position_url)?);
        artifacts.push(verified_dataset_artifact(
            dataset_root,
            &position_relative,
            &manifest.positions,
        )?);
        let index_relative = topology_parent.join(safe_mesh_artifact_url(&part.index_url)?);
        artifacts.push(verified_dataset_artifact(
            dataset_root,
            &index_relative,
            &manifest.indices,
        )?);
        match (&part.material_slot_url, &manifest.material_slots) {
            (Some(url), Some(resource)) => {
                let relative = topology_parent.join(safe_mesh_artifact_url(url)?);
                artifacts.push(verified_dataset_artifact(
                    dataset_root,
                    &relative,
                    resource,
                )?);
            }
            (None, None) => {}
            _ => anyhow::bail!(
                "section topology material-slot inventory mismatch for {}",
                part.part_id
            ),
        }
        descriptors.extend(
            manifest
                .typed_artifact_descriptors()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        );
    }
    let typed_manifest = TypedArtifactManifest {
        schema_version: TypedArtifactManifest::SCHEMA_VERSION,
        artifacts: descriptors,
    };
    typed_manifest
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let typed_relative = topology_parent.join(TYPED_ARTIFACT_MANIFEST_NAME);
    let (typed_artifact, typed_bytes) =
        PreparedDatasetArtifact::typed_artifact_manifest(typed_relative.clone(), &typed_manifest)?;
    let typed_path = dataset_root.join(&typed_relative);
    anyhow::ensure!(
        !typed_path.exists(),
        "typed artifact manifest already exists"
    );
    fs::write(&typed_path, typed_bytes)?;
    artifacts.push(typed_artifact);
    artifacts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    for pair in artifacts.windows(2) {
        anyhow::ensure!(
            pair[0].relative_path != pair[1].relative_path,
            "prepared mesh artifact path is duplicated: {}",
            pair[0].relative_path.display()
        );
    }
    let dataset = CanonicalPreparedDataset {
        dataset_id: format!("prepared-mesh-{}", render_resource.object_hash.as_str()),
        format_id: render_resource.media_type.clone(),
        entity_id: entity_id.0.clone(),
        representation_slot: "primary".to_owned(),
        root_metadata: render_resource.clone(),
        artifacts,
    };
    dataset.validate_typed_artifact_layouts(&typed_manifest)?;
    Ok(dataset)
}

fn safe_mesh_artifact_url(url: &str) -> Result<PathBuf> {
    anyhow::ensure!(
        !url.trim().is_empty() && !url.contains('\\'),
        "invalid prepared mesh artifact URL"
    );
    let path = PathBuf::from(url);
    safe_mesh_relative_path(&path)?;
    Ok(path)
}

fn safe_mesh_relative_path(path: &Path) -> Result<()> {
    anyhow::ensure!(
        !path.is_absolute()
            && path
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))),
        "prepared mesh artifact URL escaped its dataset"
    );
    Ok(())
}

fn verified_dataset_artifact(
    dataset_root: &Path,
    relative_path: &Path,
    expected: &GeometryResource,
) -> Result<PreparedDatasetArtifact> {
    safe_mesh_relative_path(relative_path)?;
    let relative_path = relative_path.to_owned();
    let root = dataset_root.canonicalize()?;
    let path = dataset_root.join(&relative_path).canonicalize()?;
    anyhow::ensure!(
        path.starts_with(&root),
        "prepared mesh artifact escaped its dataset"
    );
    let bytes = fs::read(path)?;
    anyhow::ensure!(
        ObjectHash::of_bytes(&bytes) == expected.object_hash
            && expected.byte_length == Some(u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
        "prepared mesh artifact does not match its immutable descriptor: {}",
        relative_path.display()
    );
    Ok(PreparedDatasetArtifact {
        relative_path,
        resource: expected.clone(),
    })
}

fn canonical_prepared_mesh_contract(
    snapshot: &EntitySnapshot,
    record: &MeshArtifactRecord,
    render_manifest: &GeometryResource,
    preparation: &GeometryResource,
    section_topology: &GeometryResource,
) -> Result<(
    CanonicalRepresentationAdmission,
    Vec<CanonicalImportJsonObject>,
)> {
    let closed_manifold = record
        .prepared
        .section_topology
        .as_ref()
        .is_some_and(|topology| topology.closed_manifold);
    let mesh = TriangleMeshGeometry {
        storage: TriangleMeshStorage::Resource {
            resource: render_manifest.clone(),
        },
        closed_manifold,
        triangle_material_slots: None,
        materials: None,
    };
    let (type_id, geometry) = if closed_manifold {
        (
            built_in_type::OBJECT_3D,
            GeometryObject::Solid {
                solid: Box::new(SolidGeometry::ClosedMesh { mesh }),
            },
        )
    } else {
        (
            built_in_type::SURFACE_3D,
            GeometryObject::Surface3d {
                mesh: Box::new(mesh),
            },
        )
    };
    let components = serde_json::json!({
        "hcad.prepared-dataset@1": {
            "formatId": render_manifest.media_type,
            "manifestRef": render_manifest.object_hash,
            "preparationRef": preparation.object_hash,
            "sectionTopologyRef": section_topology.object_hash,
        }
    });
    let attributes = serde_json::json!({
        "hcad.mesh-product@1": {
            "jobId": record.job_id,
            "triangleCount": record.prepared.triangle_count,
            "closedManifold": closed_manifold,
            "textured": record.textured,
            "sourceArtifact": record.source_artifact,
            "processingSetId": record.processing_set_id,
            "gcpOptimizationEntityId": record.gcp_optimization_entity_id,
            "gcpOptimizationSnapshotSha256": record.gcp_optimization_snapshot_sha256,
            "imageMaskScopeSha256": record.image_mask_scope_sha256,
        }
    });
    let relations = record
        .source_alignment_entity_id
        .iter()
        .map(|target| {
            serde_json::json!({
                "relationType": "hcad.derived-from@1",
                "target": target,
                "expectedVersion": null,
                "parameters": preparation.object_hash,
            })
        })
        .collect::<Vec<_>>();
    let canonical_objects = [
        ("application/vnd.himmelcad.components+json", components),
        ("application/vnd.himmelcad.attributes+json", attributes),
        (
            "application/vnd.himmelcad.relations+json",
            serde_json::Value::Array(relations),
        ),
    ]
    .into_iter()
    .map(|(media_type, value)| {
        let bytes = serde_json::to_vec(&value)?;
        Ok(CanonicalImportJsonObject {
            object_hash: ObjectHash::of_bytes(&bytes),
            media_type: media_type.to_owned(),
            value,
        })
    })
    .collect::<Result<Vec<_>>>()?;
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry)?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let mut entity = CanonicalEntity {
        id: snapshot.id.clone(),
        revision: 0,
        type_id: EntityTypeId(type_id.to_owned()),
        name: snapshot.name.clone(),
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref: canonical_objects[0].object_hash.clone(),
        attributes_ref: canonical_objects[1].object_hash.clone(),
        relations_ref: canonical_objects[2].object_hash.clone(),
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"uninitialized canonical prepared mesh"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)?;
    validate_resolved_representation(&entity, &selected, &geometry)?;
    Ok((
        CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot: "source".to_owned(),
            expected_generation: None,
            resolved_geometry: geometry,
        },
        canonical_objects,
    ))
}

#[derive(Debug)]
struct ProjectSession {
    id: String,
    source_path: PathBuf,
    working_path: PathBuf,
    lock_path: PathBuf,
    lock_file: Arc<File>,
    lease: ProjectLeaseRecord,
    uses_local_working_copy: bool,
    recovery_available: bool,
    read_only: bool,
    last_saved_generation: u64,
    manifest: PhotolabProjectManifest,
    job_history: BTreeMap<String, PhotolabJob>,
}

/// Exactly one project is authoritative in a sidecar process.
#[derive(Debug, Default)]
pub struct ProjectRuntime {
    session: Mutex<Option<ProjectSession>>,
    job_history_io: Mutex<()>,
    active_archives: Mutex<HashMap<String, CancellationToken>>,
    active_image_commits: Mutex<HashMap<String, CancellationToken>>,
    active_image_inspections: Mutex<HashMap<String, CancellationToken>>,
    active_image_masks: Mutex<HashMap<String, CancellationToken>>,
    active_gcp_operations: Mutex<HashMap<String, CancellationToken>>,
    draining_side_operations: AtomicBool,
}

/// Bounded drain result for project operations that have not yet moved into JobManager.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SideOperationDrainReport {
    pub timed_out: Vec<String>,
}

impl SideOperationDrainReport {
    #[must_use]
    pub fn completed(&self) -> bool {
        self.timed_out.is_empty()
    }
}

impl ProjectRuntime {
    /// Cancels archive and image-commit side operations, then waits for their owners to finish.
    pub async fn drain_side_operations(&self, deadline: Duration) -> SideOperationDrainReport {
        self.draining_side_operations.store(true, Ordering::Release);
        for cancellation in self
            .active_archives
            .lock()
            .expect("archive operation mutex poisoned")
            .values()
        {
            cancellation.request_cancel();
        }
        for cancellation in self
            .active_image_commits
            .lock()
            .expect("image commit mutex poisoned")
            .values()
        {
            cancellation.request_cancel();
        }

        let cutoff = tokio::time::Instant::now() + deadline;
        loop {
            let active = self.active_drain_operation_ids();
            if active.is_empty() {
                return SideOperationDrainReport::default();
            }
            if tokio::time::Instant::now() >= cutoff {
                return SideOperationDrainReport { timed_out: active };
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn active_drain_operation_ids(&self) -> Vec<String> {
        let mut active = self
            .active_archives
            .lock()
            .expect("archive operation mutex poisoned")
            .keys()
            .map(|id| format!("archive:{id}"))
            .collect::<Vec<_>>();
        active.extend(
            self.active_image_commits
                .lock()
                .expect("image commit mutex poisoned")
                .keys()
                .map(|id| format!("imageCommit:{id}")),
        );
        active.sort();
        active
    }

    /// Reopens side-operation admission after a completed project transition.
    pub fn resume_side_operation_admission(&self) {
        self.draining_side_operations
            .store(false, Ordering::Release);
    }

    pub fn begin_image_inspection(&self, operation_id: &str) -> Result<CancellationToken> {
        let cancellation = CancellationToken::new();
        let mut active = self
            .active_image_inspections
            .lock()
            .expect("image inspection mutex poisoned");
        if active.contains_key(operation_id) {
            anyhow::bail!("image inspection operation id is already active: {operation_id}");
        }
        active.insert(operation_id.to_owned(), cancellation.clone());
        Ok(cancellation)
    }

    pub fn finish_image_inspection(&self, operation_id: &str) {
        self.active_image_inspections
            .lock()
            .expect("image inspection mutex poisoned")
            .remove(operation_id);
    }

    pub fn cancel_image_inspection(
        &self,
        params: CancelImageCommitParams,
    ) -> CancelImageCommitResult {
        let active = self
            .active_image_inspections
            .lock()
            .expect("image inspection mutex poisoned");
        let cancellation_requested = active
            .get(&params.operation_id)
            .is_some_and(CancellationToken::request_cancel);
        CancelImageCommitResult {
            operation_id: params.operation_id,
            cancellation_requested,
        }
    }

    pub fn create(&self, params: CreateProjectParams) -> Result<OpenPhotolabProjectResult> {
        let path = normalize_hcad_path(Path::new(&params.path));
        if path.exists() && path.read_dir()?.next().is_some() {
            anyhow::bail!("project directory is not empty: {}", path.display());
        }
        ensure_project_directories(&path)?;
        let path = fs::canonicalize(&path)
            .with_context(|| format!("failed to resolve project directory {}", path.display()))?;
        let now = unix_ms()?;
        let project_id = unique_id("project", now);
        let manifest = initial_photolab_manifest(project_id, params.name, now);
        atomic_write_json(&path.join("manifest.json"), &manifest)?;
        let result = self.install_session(path.clone(), path, manifest, false, false)?;
        let manifest_object = serde_json::to_vec(&result.manifest)?;
        self.put_object(&manifest_object)?;
        Ok(result)
    }

    pub fn open(&self, params: &OpenProjectParams) -> Result<OpenPhotolabProjectResult> {
        if is_hcadx_path(Path::new(&params.path)) {
            return self.open_archive(params);
        }
        let source_path = fs::canonicalize(normalize_hcad_path(Path::new(&params.path)))
            .with_context(|| format!("failed to resolve project directory {}", params.path))?;
        let source_manifest = read_manifest(&source_path)?;
        validate_manifest(&source_manifest)?;
        let source_saved_generation = source_manifest.autosave_generation;
        let session_id = unique_id("session", unix_ms()?);
        let lock_path = project_lock_path(&source_path);
        let (lock_file, lease) = acquire_lock(&lock_path, &session_id, &source_path)?;
        let result = (|| -> Result<OpenPhotolabProjectResult> {
            let working_path = if params.use_local_working_copy {
                Path::new(&params.working_root)
                    .join("photolab")
                    .join("workspaces")
                    .join(format!("{}.hcad", source_manifest.project_id))
            } else {
                source_path.clone()
            };
            let recovery_available = params.use_local_working_copy
                && working_path.join("manifest.json").is_file()
                && read_manifest(&working_path).is_ok_and(|manifest| {
                    !manifest.clean_shutdown
                        || manifest.autosave_generation > source_manifest.autosave_generation
                        || job_history_differs(&working_path, &source_path)
                });

            if params.use_local_working_copy
                && (!recovery_available || !params.recover_existing_working_copy)
            {
                if working_path.exists() {
                    fs::remove_dir_all(&working_path).with_context(|| {
                        format!("failed to refresh working copy {}", working_path.display())
                    })?;
                }
                copy_project_incremental(&source_path, &working_path)?;
            }

            let manifest = if recovery_available && params.recover_existing_working_copy {
                read_manifest(&working_path)?
            } else {
                source_manifest
            };
            self.install_session_locked(
                source_path,
                working_path,
                manifest,
                params.use_local_working_copy,
                recovery_available,
                session_id.clone(),
                lock_path.clone(),
                Arc::clone(&lock_file),
                lease.clone(),
                source_saved_generation,
            )
        })();
        let result = result.map(|opened| self.ensure_automatic_capture_groups().unwrap_or_else(|error| {
            tracing::warn!(%error, "project opened without persisting automatic calibration groups");
            opened
        }));
        if result.is_err() {
            release_lock(&lock_file, &lock_path, &session_id)?;
        }
        result
    }

    fn open_archive(&self, params: &OpenProjectParams) -> Result<OpenPhotolabProjectResult> {
        let source_path = fs::canonicalize(normalize_hcadx_path(Path::new(&params.path)))
            .with_context(|| format!("failed to resolve project archive {}", params.path))?;
        if !source_path.is_file() {
            anyhow::bail!("project archive does not exist: {}", source_path.display());
        }
        if self
            .session
            .lock()
            .expect("project session mutex poisoned")
            .is_some()
        {
            anyhow::bail!("a project is already open; close it before opening another one");
        }
        let session_id = unique_id("session", unix_ms()?);
        let lock_path = project_lock_path(&source_path);
        let (lock_file, lease) = acquire_lock(&lock_path, &session_id, &source_path)?;
        let (operation_id, cancellation) = match self
            .begin_project_open_archive_operation(params.archive_operation_id.as_deref())
        {
            Ok(operation) => operation,
            Err(error) => {
                release_lock(&lock_file, &lock_path, &session_id)?;
                return Err(error);
            }
        };
        let result = self.open_archive_inner(
            params,
            source_path,
            &operation_id,
            &cancellation,
            session_id.clone(),
            lock_path.clone(),
            Arc::clone(&lock_file),
            lease,
        );
        let result = result.map(|opened| self.ensure_automatic_capture_groups().unwrap_or_else(|error| {
            tracing::warn!(%error, "project archive opened without persisting automatic calibration groups");
            opened
        }));
        self.finish_archive_operation(&operation_id);
        if result.is_err() {
            release_lock(&lock_file, &lock_path, &session_id)?;
        }
        result
    }

    #[allow(clippy::too_many_arguments)] // Archive lock ownership stays explicit until session installation.
    fn open_archive_inner(
        &self,
        params: &OpenProjectParams,
        source_path: PathBuf,
        operation_id: &str,
        cancellation: &CancellationToken,
        session_id: String,
        lock_path: PathBuf,
        lock_file: Arc<File>,
        lease: ProjectLeaseRecord,
    ) -> Result<OpenPhotolabProjectResult> {
        let workspace_root = Path::new(&params.working_root)
            .join("photolab")
            .join("workspaces");
        fs::create_dir_all(&workspace_root)?;
        let source_key = ObjectHash::of_bytes(path_string(&source_path).as_bytes());
        let working_path = workspace_root.join(format!("archive-{}.hcad", source_key.as_str()));
        let incoming_path = workspace_root.join(format!(
            ".archive-{}.incoming-{}",
            source_key.as_str(),
            unique_id("extract", unix_ms()?)
        ));
        let progress_key = params.progress_key.clone();
        let unpack_result = unpack_hcadx(
            &source_path,
            &incoming_path,
            default_archive_limits(),
            cancellation,
            |progress| emit_archive_progress(progress_key.as_deref(), operation_id, &progress),
        );
        if let Err(error) = unpack_result {
            remove_path_if_exists(&incoming_path)?;
            return Err(error.into());
        }

        let source_manifest = read_manifest(&incoming_path)?;
        validate_manifest(&source_manifest)?;
        let source_saved_generation = source_manifest.autosave_generation;
        let recovery_available = working_path.join("manifest.json").is_file()
            && read_manifest(&working_path).is_ok_and(|manifest| {
                !manifest.clean_shutdown
                    || manifest.autosave_generation > source_manifest.autosave_generation
                    || job_history_differs(&working_path, &incoming_path)
            });
        let recover = recovery_available && params.recover_existing_working_copy;
        if recover {
            remove_path_if_exists(&incoming_path)?;
        } else {
            remove_path_if_exists(&working_path)?;
            fs::rename(&incoming_path, &working_path).with_context(|| {
                format!(
                    "failed to publish extracted workspace {}",
                    working_path.display()
                )
            })?;
        }
        let manifest = if recover {
            read_manifest(&working_path)?
        } else {
            source_manifest
        };
        self.install_session_locked(
            source_path,
            working_path,
            manifest,
            true,
            recovery_available,
            session_id,
            lock_path,
            lock_file,
            lease,
            source_saved_generation,
        )
    }

    fn install_session(
        &self,
        source_path: PathBuf,
        working_path: PathBuf,
        manifest: PhotolabProjectManifest,
        uses_local_working_copy: bool,
        recovery_available: bool,
    ) -> Result<OpenPhotolabProjectResult> {
        let session_id = unique_id("session", unix_ms()?);
        let lock_path = project_lock_path(&source_path);
        let last_saved_generation = manifest.autosave_generation;
        let (lock_file, lease) = acquire_lock(&lock_path, &session_id, &source_path)?;
        let result = self.install_session_locked(
            source_path,
            working_path,
            manifest,
            uses_local_working_copy,
            recovery_available,
            session_id.clone(),
            lock_path.clone(),
            Arc::clone(&lock_file),
            lease,
            last_saved_generation,
        );
        if result.is_err() {
            release_lock(&lock_file, &lock_path, &session_id)?;
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn install_session_locked(
        &self,
        source_path: PathBuf,
        working_path: PathBuf,
        mut manifest: PhotolabProjectManifest,
        uses_local_working_copy: bool,
        recovery_available: bool,
        session_id: String,
        lock_path: PathBuf,
        lock_file: Arc<File>,
        mut lease: ProjectLeaseRecord,
        last_saved_generation: u64,
    ) -> Result<OpenPhotolabProjectResult> {
        let job_history = {
            let _history_guard = self
                .job_history_io
                .lock()
                .expect("job history mutex poisoned");
            let mut history = read_project_job_history(&working_path, &manifest.project_id)?;
            for job in mark_interrupted_jobs(&mut history)? {
                write_project_job_history_record(&working_path, &manifest.project_id, &job, None)?;
            }
            for job in history
                .values()
                .filter(|job| job_state_is_terminal(&job.state))
            {
                if let Err(error) = cleanup_terminal_job_scratch(&working_path, job) {
                    tracing::warn!(
                        job_id = %job.id.0,
                        %error,
                        "terminal PhotoLab scratch cleanup will be retried on the next project open"
                    );
                }
            }
            history
        };
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        if guard.is_some() {
            anyhow::bail!("a project is already open; close it before opening another one");
        }
        ensure_project_directories(&working_path)?;
        manifest.clean_shutdown = false;
        manifest.modified_unix_ms = unix_ms()?;
        atomic_write_json(&working_path.join("manifest.json"), &manifest)?;
        if working_path == source_path {
            lease.source_fingerprint = source_fingerprint(&source_path)?;
            lease.heartbeat_unix_ms = unix_ms()?;
            write_lease_record(&lock_path, &lease)?;
        }

        let summary = ProjectSessionSummary {
            session_id: session_id.clone(),
            source_path: path_string(&source_path),
            working_path: path_string(&working_path),
            uses_local_working_copy,
            recovery_available,
            read_only: false,
            autosave_generation: manifest.autosave_generation,
            last_saved_generation,
        };
        *guard = Some(ProjectSession {
            id: session_id,
            source_path,
            working_path,
            lock_path,
            lock_file,
            lease,
            uses_local_working_copy,
            recovery_available,
            read_only: false,
            last_saved_generation,
            manifest: manifest.clone(),
            job_history,
        });
        Ok(OpenPhotolabProjectResult {
            session: summary,
            manifest,
        })
    }

    pub fn snapshot(&self) -> Result<OpenPhotolabProjectResult> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        Ok(session.result())
    }

    pub fn list_camera_images(&self) -> Result<Vec<ProjectCameraImageRecord>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        read_project_camera_images(&session.working_path, &session.manifest)
            .map_err(anyhow::Error::from)
    }

    pub fn list_image_masks(&self) -> Result<Vec<ListedImageMaskRevision>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let catalog = read_image_mask_catalog(session)?;
        catalog
            .revisions
            .iter()
            .map(|entry| {
                let revision = read_image_mask_revision(session, &entry.revision_sha256)?;
                anyhow::ensure!(
                    revision.image_entity_id == entry.image_entity_id,
                    "image-mask catalog entry selects a revision for another image"
                );
                Ok(ListedImageMaskRevision {
                    revision_sha256: entry.revision_sha256.clone(),
                    revision,
                })
            })
            .collect()
    }

    pub fn edit_image_mask(&self, params: EditImageMaskParams) -> Result<EditImageMaskResult> {
        validate_compute_job_id(&params.operation_id)?;
        let operation_id = params.operation_id.clone();
        let cancellation = CancellationToken::new();
        {
            let mut active = self
                .active_image_masks
                .lock()
                .expect("image mask operation mutex poisoned");
            anyhow::ensure!(
                !active.contains_key(&operation_id),
                "image-mask operation id is already active: {operation_id}"
            );
            active.insert(operation_id.clone(), cancellation.clone());
        }
        let result = (|| {
            let mut guard = self.session.lock().expect("project session mutex poisoned");
            let session = guard.as_mut().context("no project is open")?;
            ensure_writable(session)?;
            edit_image_mask_transaction(session, params, &cancellation)
        })();
        self.active_image_masks
            .lock()
            .expect("image mask operation mutex poisoned")
            .remove(&operation_id);
        result
    }

    pub fn cancel_image_mask(&self, params: CancelImageMaskParams) -> CancelImageMaskResult {
        let active = self
            .active_image_masks
            .lock()
            .expect("image mask operation mutex poisoned");
        let cancellation_requested = active
            .get(&params.operation_id)
            .is_some_and(CancellationToken::request_cancel);
        CancelImageMaskResult {
            operation_id: params.operation_id,
            cancellation_requested,
        }
    }

    pub fn image_mask_compute_scope(
        &self,
        camera_entity_ids: &[String],
        processing_set_id: Option<&EntityId>,
    ) -> Result<ImageMaskComputeScope> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        build_image_mask_compute_scope(session, camera_entity_ids, processing_set_id)
    }

    pub fn list_image_quality_analyses(&self) -> Result<Vec<ImageQualityAnalysisRecord>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut catalog = read_image_quality_catalog(session)?;
        catalog.analyses.retain(|analysis| {
            session
                .manifest
                .entities
                .get(&analysis.image_entity_id.0)
                .is_some_and(|entity| entity.kind == EntityKind::CameraImage)
        });
        catalog.analyses.sort_by(|left, right| {
            left.image_name
                .cmp(&right.image_name)
                .then_with(|| left.image_entity_id.0.cmp(&right.image_entity_id.0))
                .then_with(|| {
                    left.scope
                        .processing_set_id
                        .as_ref()
                        .map(|id| id.0.as_str())
                        .cmp(
                            &right
                                .scope
                                .processing_set_id
                                .as_ref()
                                .map(|id| id.0.as_str()),
                        )
                })
        });
        Ok(catalog.analyses)
    }

    pub fn publish_image_quality_analyses(
        &self,
        job_id: &str,
        analyses: Vec<ImageQualityAnalysisRecord>,
    ) -> Result<OpenPhotolabProjectResult> {
        validate_compute_job_id(job_id)?;
        anyhow::ensure!(!analyses.is_empty(), "image-quality result is empty");
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let mut catalog = read_image_quality_catalog(session)?;
        let scope = analyses[0].scope.clone();
        let configuration_sha256 = analyses[0].configuration_sha256.clone();
        let measured_count = analyses
            .iter()
            .filter(|analysis| matches!(analysis.outcome, ImageQualityOutcome::Measured { .. }))
            .count();
        let mut affected_entities = Vec::with_capacity(analyses.len());
        for analysis in &analyses {
            anyhow::ensure!(analysis.job_id == job_id, "image-quality job id changed");
            anyhow::ensure!(
                analysis.scope == scope,
                "image-quality result contains mixed processing scopes"
            );
            anyhow::ensure!(
                analysis.configuration_sha256 == configuration_sha256,
                "image-quality result contains mixed configurations"
            );
            let entity = session
                .manifest
                .entities
                .get(&analysis.image_entity_id.0)
                .with_context(|| {
                    format!(
                        "image-quality result references removed image {}",
                        analysis.image_entity_id.0
                    )
                })?;
            anyhow::ensure!(
                entity.kind == EntityKind::CameraImage,
                "image-quality result references a non-camera entity"
            );
            let metadata: CameraImageMetadataRecord = serde_json::from_slice(
                &read_verified_object(&session.working_path, &entity.version_hash)?,
            )?;
            anyhow::ensure!(
                metadata.source_object_hash == analysis.source_object_hash,
                "image pixels changed while quality analysis was running"
            );
            affected_entities.push(analysis.image_entity_id.clone());
        }
        if let Some(processing_set_id) = scope.processing_set_id.as_ref() {
            let record = read_processing_set(session, processing_set_id)?;
            anyhow::ensure!(
                Some(&record.membership_sha256) == scope.processing_set_membership_sha256.as_ref(),
                "processing-set membership changed while quality analysis was running"
            );
            let expected = record
                .camera_entity_ids
                .iter()
                .map(|id| id.0.as_str())
                .collect::<BTreeSet<_>>();
            let observed = analyses
                .iter()
                .map(|analysis| analysis.image_entity_id.0.as_str())
                .collect::<BTreeSet<_>>();
            anyhow::ensure!(
                observed == expected,
                "image-quality result does not cover the complete processing set"
            );
        }
        let replacement_keys = analyses
            .iter()
            .map(|analysis| {
                (
                    analysis.image_entity_id.0.clone(),
                    analysis
                        .scope
                        .processing_set_id
                        .as_ref()
                        .map(|id| id.0.clone()),
                )
            })
            .collect::<BTreeSet<_>>();
        catalog.analyses.retain(|existing| {
            session
                .manifest
                .entities
                .get(&existing.image_entity_id.0)
                .is_some_and(|entity| entity.kind == EntityKind::CameraImage)
                && !replacement_keys.contains(&(
                    existing.image_entity_id.0.clone(),
                    existing
                        .scope
                        .processing_set_id
                        .as_ref()
                        .map(|id| id.0.clone()),
                ))
        });
        catalog.analyses.extend(analyses);
        catalog.analyses.sort_by(|left, right| {
            left.image_entity_id
                .0
                .cmp(&right.image_entity_id.0)
                .then_with(|| {
                    left.scope
                        .processing_set_id
                        .as_ref()
                        .map(|id| id.0.as_str())
                        .cmp(
                            &right
                                .scope
                                .processing_set_id
                                .as_ref()
                                .map(|id| id.0.as_str()),
                        )
                })
        });
        let catalog_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&catalog)?)?;
        let previous_catalog_hash = session.manifest.image_quality_catalog_hash.clone();
        let now = unix_ms()?;
        let mut candidate = session.manifest.clone();
        candidate.image_quality_catalog_hash = Some(catalog_hash.clone());
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = now;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: job_id.to_owned(),
            command_kind: "PhotolabAnalyzeImageQuality".into(),
            timestamp_unix_ms: now,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "configurationSha256": configuration_sha256,
                "processingSetId": scope.processing_set_id,
                "processingSetMembershipSha256": scope.processing_set_membership_sha256,
                "imageCount": affected_entities.len(),
                "measuredCount": measured_count,
                "catalogSha256": catalog_hash,
            }),
            affected_entities,
            before_refs: previous_catalog_hash.into_iter().collect(),
            after_refs: vec![catalog_hash],
            message: Some("Measured image-quality analysis published atomically".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        Ok(session.result())
    }

    pub fn list_processing_sets(&self) -> Result<Vec<ProcessingSetRecord>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut records = Vec::new();
        for entity in session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::ProcessingSet)
        {
            let bytes = fs::read(project_object_path(
                &session.working_path,
                &entity.version_hash,
            ))?;
            anyhow::ensure!(
                ObjectHash::of_bytes(&bytes) == entity.version_hash,
                "processing-set record hash mismatch"
            );
            let record: ProcessingSetRecord = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                record.entity_id == entity.id,
                "processing-set entity id mismatch"
            );
            validate_processing_set_record(&session.manifest, &record)?;
            records.push(record);
        }
        records.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then(left.entity_id.0.cmp(&right.entity_id.0))
        });
        Ok(records)
    }

    pub fn create_processing_set(
        &self,
        params: CreateProcessingSetParams,
    ) -> Result<OpenPhotolabProjectResult> {
        let name = params.name.trim();
        anyhow::ensure!(
            !name.is_empty() && name.chars().count() <= 128,
            "invalid processing-set name"
        );
        let mut camera_ids = params.camera_entity_ids;
        camera_ids.sort_by(|left, right| left.0.cmp(&right.0));
        camera_ids.dedup();
        anyhow::ensure!(
            camera_ids.len() >= 2,
            "a processing set needs at least two cameras"
        );
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        for id in &camera_ids {
            let entity = session
                .manifest
                .entities
                .get(&id.0)
                .context("processing-set camera does not exist")?;
            anyhow::ensure!(
                entity.kind == EntityKind::CameraImage,
                "processing set contains a non-camera entity"
            );
        }
        for entity in session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::ProcessingSet)
        {
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let existing: ProcessingSetRecord = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                existing.camera_entity_ids != camera_ids,
                "processing set '{}' already freezes this exact camera membership",
                existing.name
            );
        }
        let images =
            unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")?;
        let now = unix_ms()?;
        let entity_id = EntityId(format!(
            "{}:processing-set:{}",
            session.manifest.project_id,
            unique_id("scope", now)
        ));
        let membership_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&camera_ids)?);
        let camera_set = camera_ids
            .iter()
            .map(|id| id.0.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let mut capture_group_ids = Vec::new();
        let mut calibration_group_ids = Vec::new();
        for entity in session.manifest.entities.values() {
            if entity.kind == EntityKind::CaptureGroup {
                let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
                let capture: CaptureGroupRecord = serde_json::from_slice(&bytes)?;
                if capture
                    .camera_entity_ids
                    .iter()
                    .all(|id| camera_set.contains(id.0.as_str()))
                {
                    capture_group_ids.push(capture.entity_id);
                }
            } else if entity.kind == EntityKind::CameraCalibrationGroup {
                let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
                let calibration: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
                if calibration
                    .camera_entity_ids
                    .iter()
                    .all(|id| camera_set.contains(id.0.as_str()))
                {
                    calibration_group_ids.push(calibration.entity_id);
                }
            }
        }
        capture_group_ids.sort_by(|left, right| left.0.cmp(&right.0));
        calibration_group_ids.sort_by(|left, right| left.0.cmp(&right.0));
        let record = ProcessingSetRecord {
            schema_version: 2,
            entity_id: entity_id.clone(),
            name: name.to_owned(),
            camera_entity_ids: camera_ids,
            membership_sha256,
            capture_group_ids,
            calibration_group_ids,
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        candidate.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::ProcessingSet,
                name: record.name.clone(),
                parent: Some(images.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        let parent = candidate
            .entities
            .get_mut(&images.0)
            .context("image collection disappeared")?;
        parent.children.push(entity_id.clone());
        parent.children.sort_by(|left, right| left.0.cmp(&right.0));
        parent.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&parent.children)?);
        let parent_hash = parent.version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = now;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: unique_id("processing-set-create", now),
            command_kind: "PhotolabCreateProcessingSet".into(),
            timestamp_unix_ms: now,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "entityId": entity_id,
                "name": record.name,
                "cameraEntityIds": record.camera_entity_ids,
                "membershipSha256": record.membership_sha256,
                "captureGroupIds": record.capture_group_ids,
                "calibrationGroupIds": record.calibration_group_ids,
            }),
            affected_entities: vec![entity_id],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, parent_hash],
            message: Some("Immutable camera processing set created".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        Ok(session.result())
    }

    pub fn list_capture_groups(&self) -> Result<Vec<CaptureGroupRecord>> {
        self.list_records_of_kind(EntityKind::CaptureGroup)
    }

    pub fn list_calibration_groups(&self) -> Result<Vec<CameraCalibrationGroupRecord>> {
        self.list_records_of_kind(EntityKind::CameraCalibrationGroup)
    }

    fn ensure_automatic_capture_groups(&self) -> Result<OpenPhotolabProjectResult> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let camera_ids = session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::CameraImage)
            .map(|entity| entity.id.clone())
            .collect::<Vec<_>>();
        let groups = automatic_capture_groups_for_import(session, &camera_ids)?;
        Self::persist_automatic_capture_groups(session, groups)?;
        Ok(session.result())
    }

    pub fn confirm_capture_group(
        &self,
        params: ConfirmCaptureGroupParams,
    ) -> Result<OpenPhotolabProjectResult> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let snapshot = session
            .manifest
            .entities
            .get(&params.capture_group_id.0)
            .context("unknown capture group")?;
        anyhow::ensure!(
            snapshot.kind == EntityKind::CaptureGroup,
            "entity is not a capture group"
        );
        let bytes = read_verified_object(&session.working_path, &snapshot.version_hash)?;
        let mut capture: CaptureGroupRecord = serde_json::from_slice(&bytes)?;
        if capture.review_status == CaptureGroupReviewStatus::Confirmed {
            return Ok(session.result());
        }
        capture.review_status = CaptureGroupReviewStatus::Confirmed;
        let mut candidate = session.manifest.clone();
        let mut affected = vec![capture.entity_id.clone()];
        let mut after_refs = Vec::new();
        let capture_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&capture)?)?;
        candidate
            .entities
            .get_mut(&capture.entity_id.0)
            .context("capture group disappeared")?
            .version_hash = capture_hash.clone();
        after_refs.push(capture_hash);
        for calibration_id in &capture.calibration_group_ids {
            let entity = candidate
                .entities
                .get(calibration_id.0.as_str())
                .context("capture group calibration disappeared")?;
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let mut calibration: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
            calibration.review_status = CaptureGroupReviewStatus::Confirmed;
            let hash =
                put_project_object(&session.working_path, &serde_json::to_vec(&calibration)?)?;
            candidate
                .entities
                .get_mut(&calibration_id.0)
                .context("capture group calibration disappeared")?
                .version_hash = hash.clone();
            affected.push(calibration_id.clone());
            after_refs.push(hash);
        }
        commit_domain_entity_change(
            session,
            candidate,
            unix_ms()?,
            "PhotolabConfirmAutomaticCaptureGroup",
            serde_json::json!({"captureGroupId": capture.entity_id}),
            affected,
            after_refs,
            "Automatic capture and calibration grouping confirmed",
        )
    }

    pub fn update_calibration_group_intrinsics(
        &self,
        params: UpdateCalibrationGroupIntrinsicsParams,
    ) -> Result<OpenPhotolabProjectResult> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let snapshot = session
            .manifest
            .entities
            .get(&params.calibration_group_id.0)
            .context("unknown calibration group")?;
        anyhow::ensure!(
            snapshot.kind == EntityKind::CameraCalibrationGroup,
            "entity is not a camera calibration group"
        );
        let bytes = read_verified_object(&session.working_path, &snapshot.version_hash)?;
        let mut calibration: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
        calibration.schema_version = 2;
        calibration.intrinsics_policy = params.intrinsics_policy;
        let hash = put_project_object(&session.working_path, &serde_json::to_vec(&calibration)?)?;
        let mut candidate = session.manifest.clone();
        candidate
            .entities
            .get_mut(&calibration.entity_id.0)
            .context("calibration group disappeared")?
            .version_hash = hash.clone();
        commit_domain_entity_change(
            session,
            candidate,
            unix_ms()?,
            "PhotolabUpdateCalibrationGroupIntrinsics",
            serde_json::json!({
                "calibrationGroupId": calibration.entity_id,
                "intrinsicsPolicy": calibration.intrinsics_policy,
            }),
            vec![calibration.entity_id],
            vec![hash],
            "Calibration-group intrinsics policy updated",
        )
    }

    pub fn calibration_groups_for_camera_scope(
        &self,
        camera_entity_ids: &[String],
    ) -> Result<Vec<ColmapCalibrationGroup>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let scope = validate_camera_scope(&session.manifest, camera_entity_ids)?
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        let mut assigned = std::collections::BTreeSet::new();
        let mut result = Vec::new();
        for entity in session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::CameraCalibrationGroup)
        {
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let group: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
            let members = group
                .camera_entity_ids
                .iter()
                .filter(|id| scope.contains(&id.0))
                .map(|id| id.0.clone())
                .collect::<Vec<_>>();
            if members.is_empty() {
                continue;
            }
            for id in &members {
                anyhow::ensure!(
                    assigned.insert(id.clone()),
                    "camera {id} belongs to multiple calibration groups"
                );
            }
            result.push(ColmapCalibrationGroup {
                group_id: group.entity_id.0,
                camera_entity_ids: members,
                seed: group.initial_calibration.and_then(|seed| {
                    Some(ColmapCalibrationSeed {
                        width_pixels: seed.width_pixels,
                        height_pixels: seed.height_pixels,
                        focal_pixels: seed.focal_pixels?,
                        principal_x_pixels: seed.principal_x_pixels?,
                        principal_y_pixels: seed.principal_y_pixels?,
                        full_brown_calibration: seed.full_brown_calibration,
                    })
                }),
            });
        }
        let unassigned = scope
            .difference(&assigned)
            .cloned()
            .map(EntityId)
            .collect::<Vec<_>>();
        for capture in automatic_capture_groups_for_import(session, &unassigned)? {
            for calibration in capture.calibration_groups {
                let members = calibration
                    .camera_entity_ids
                    .into_iter()
                    .map(|id| id.0)
                    .collect::<Vec<_>>();
                let membership =
                    membership_hash(&members.iter().cloned().map(EntityId).collect::<Vec<_>>())?;
                let group_id = format!("implicit-metadata:{}", membership.as_str());
                assigned.extend(members.iter().cloned());
                result.push(ColmapCalibrationGroup {
                    group_id,
                    camera_entity_ids: members,
                    seed: calibration.initial_calibration.and_then(|seed| {
                        Some(ColmapCalibrationSeed {
                            width_pixels: seed.width_pixels,
                            height_pixels: seed.height_pixels,
                            focal_pixels: seed.focal_pixels?,
                            principal_x_pixels: seed.principal_x_pixels?,
                            principal_y_pixels: seed.principal_y_pixels?,
                            full_brown_calibration: seed.full_brown_calibration,
                        })
                    }),
                });
            }
        }
        // Metadata-poor isolated images remain independently solvable rather than being silently
        // tied to unrelated cameras.
        for camera_id in scope.difference(&assigned) {
            result.push(ColmapCalibrationGroup {
                group_id: format!("implicit-independent:{camera_id}"),
                camera_entity_ids: vec![camera_id.clone()],
                seed: None,
            });
        }
        result.sort_by(|left, right| left.group_id.cmp(&right.group_id));
        Ok(result)
    }

    fn persist_automatic_capture_groups(
        session: &mut ProjectSession,
        groups: Vec<AutomaticCaptureGroup>,
    ) -> Result<()> {
        if groups.is_empty() {
            return Ok(());
        }
        let images =
            unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")?;
        let now = unix_ms()?;
        let mut candidate = session.manifest.clone();
        let mut affected = Vec::new();
        let mut after_refs = Vec::new();
        let mut capture_ids = Vec::new();
        for (capture_index, group) in groups.into_iter().enumerate() {
            let capture_id = EntityId(format!(
                "{}:capture-group:{}:{}",
                session.manifest.project_id,
                unique_id("automatic-capture", now),
                capture_index
            ));
            let mut calibration_records = Vec::with_capacity(group.calibration_groups.len());
            for (calibration_index, calibration) in group.calibration_groups.into_iter().enumerate()
            {
                let entity_id = EntityId(format!(
                    "{}:calibration-group:{}:{}:{}",
                    session.manifest.project_id,
                    unique_id("automatic-calibration", now),
                    capture_index,
                    calibration_index
                ));
                calibration_records.push(CameraCalibrationGroupRecord {
                    schema_version: 2,
                    entity_id,
                    capture_group_id: capture_id.clone(),
                    name: calibration.name,
                    membership_sha256: membership_hash(&calibration.camera_entity_ids)?,
                    camera_entity_ids: calibration.camera_entity_ids,
                    grouping_basis: calibration.grouping_basis,
                    review_status: CaptureGroupReviewStatus::NeedsReview,
                    automatic: true,
                    evidence: calibration.evidence,
                    initial_calibration: calibration.initial_calibration,
                    intrinsics_policy: GcpIntrinsicsPolicy::Auto,
                });
            }
            let capture_record = CaptureGroupRecord {
                schema_version: 1,
                entity_id: capture_id.clone(),
                name: group.name,
                membership_sha256: membership_hash(&group.camera_entity_ids)?,
                camera_entity_ids: group.camera_entity_ids,
                calibration_group_ids: calibration_records
                    .iter()
                    .map(|record| record.entity_id.clone())
                    .collect(),
                review_status: CaptureGroupReviewStatus::NeedsReview,
                automatic: true,
                evidence: group.evidence,
            };
            let capture_hash =
                put_project_object(&session.working_path, &serde_json::to_vec(&capture_record)?)?;
            after_refs.push(capture_hash.clone());
            candidate.entities.insert(
                capture_id.0.clone(),
                EntitySnapshot {
                    id: capture_id.clone(),
                    kind: EntityKind::CaptureGroup,
                    name: capture_record.name.clone(),
                    parent: Some(images.clone()),
                    children: capture_record.calibration_group_ids.clone(),
                    visibility: VisibilityState::default(),
                    version_hash: capture_hash,
                    bounds: None,
                },
            );
            affected.push(capture_id.clone());
            for record in calibration_records {
                let hash =
                    put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
                after_refs.push(hash.clone());
                candidate.entities.insert(
                    record.entity_id.0.clone(),
                    EntitySnapshot {
                        id: record.entity_id.clone(),
                        kind: EntityKind::CameraCalibrationGroup,
                        name: record.name.clone(),
                        parent: Some(capture_id.clone()),
                        children: Vec::new(),
                        visibility: VisibilityState::default(),
                        version_hash: hash,
                        bounds: None,
                    },
                );
                affected.push(record.entity_id);
            }
            capture_ids.push(capture_id);
        }
        let parent = candidate
            .entities
            .get_mut(&images.0)
            .context("image collection disappeared")?;
        parent.children.extend(capture_ids.iter().cloned());
        parent.children.sort_by(|left, right| left.0.cmp(&right.0));
        parent.children.dedup();
        parent.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&parent.children)?);
        after_refs.push(parent.version_hash.clone());
        commit_domain_entity_change(
            session,
            candidate,
            now,
            "PhotolabCreateAutomaticCaptureGroups",
            serde_json::json!({
                "captureGroupIds": capture_ids,
                "reviewStatus": "needsReview",
            }),
            affected,
            after_refs,
            "Metadata-derived capture and calibration groups created for review",
        )?;
        Ok(())
    }

    pub fn create_capture_group(
        &self,
        params: CreateCaptureGroupParams,
    ) -> Result<OpenPhotolabProjectResult> {
        let name = validated_record_name(&params.name, "capture-group")?;
        let mut camera_ids = params.camera_entity_ids;
        sort_unique_entity_ids(&mut camera_ids, "capture group")?;
        anyhow::ensure!(
            camera_ids.len() >= 2,
            "a capture group needs at least two cameras"
        );
        anyhow::ensure!(
            !params.calibration_groups.is_empty(),
            "a capture group needs at least one calibration group"
        );

        let mut assigned = Vec::new();
        let mut definitions = Vec::with_capacity(params.calibration_groups.len());
        for input in params.calibration_groups {
            let group_name = validated_record_name(&input.name, "calibration-group")?;
            let mut ids = input.camera_entity_ids;
            sort_unique_entity_ids(&mut ids, "calibration group")?;
            anyhow::ensure!(!ids.is_empty(), "a calibration group cannot be empty");
            if let Some(seed) = input.initial_calibration.as_ref() {
                validate_calibration_seed(seed)?;
            }
            assigned.extend(ids.iter().cloned());
            definitions.push((
                group_name,
                ids,
                input.grouping_basis,
                input.initial_calibration,
            ));
        }
        assigned.sort_by(|left, right| left.0.cmp(&right.0));
        anyhow::ensure!(
            assigned == camera_ids,
            "calibration groups must partition the capture group exactly"
        );

        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        validate_camera_entities(&session.manifest, &camera_ids)?;
        let requested = camera_ids
            .iter()
            .map(|id| id.0.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let mut replace_automatic_capture_ids = BTreeSet::new();
        for entity in session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::CameraCalibrationGroup)
        {
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let existing: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
            let overlaps = existing
                .camera_entity_ids
                .iter()
                .any(|id| requested.contains(id.0.as_str()));
            if !overlaps {
                continue;
            }
            anyhow::ensure!(
                existing.automatic
                    && existing.review_status == CaptureGroupReviewStatus::NeedsReview,
                "a camera already belongs to a confirmed calibration group"
            );
            replace_automatic_capture_ids.insert(existing.capture_group_id.0);
        }
        for capture_id in &replace_automatic_capture_ids {
            let entity = session
                .manifest
                .entities
                .get(capture_id)
                .context("automatic capture group disappeared")?;
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let existing: CaptureGroupRecord = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                existing
                    .camera_entity_ids
                    .iter()
                    .map(|id| id.0.as_str())
                    .collect::<BTreeSet<_>>()
                    == requested,
                "select the complete automatic capture group before replacing its intrinsics partition"
            );
        }
        let images =
            unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")?;
        let now = unix_ms()?;
        let capture_id = EntityId(format!(
            "{}:capture-group:{}",
            session.manifest.project_id,
            unique_id("capture", now)
        ));
        let mut calibration_records = Vec::with_capacity(definitions.len());
        for (index, (group_name, ids, basis, seed)) in definitions.into_iter().enumerate() {
            let entity_id = EntityId(format!(
                "{}:calibration-group:{}:{}",
                session.manifest.project_id,
                unique_id("calibration", now),
                index
            ));
            calibration_records.push(CameraCalibrationGroupRecord {
                schema_version: 2,
                entity_id,
                capture_group_id: capture_id.clone(),
                name: group_name,
                membership_sha256: membership_hash(&ids)?,
                camera_entity_ids: ids,
                grouping_basis: basis,
                review_status: CaptureGroupReviewStatus::Confirmed,
                automatic: false,
                evidence: Vec::new(),
                initial_calibration: seed,
                intrinsics_policy: GcpIntrinsicsPolicy::Auto,
            });
        }
        let capture_record = CaptureGroupRecord {
            schema_version: 1,
            entity_id: capture_id.clone(),
            name,
            membership_sha256: membership_hash(&camera_ids)?,
            camera_entity_ids: camera_ids,
            calibration_group_ids: calibration_records
                .iter()
                .map(|record| record.entity_id.clone())
                .collect(),
            review_status: CaptureGroupReviewStatus::Confirmed,
            automatic: false,
            evidence: Vec::new(),
        };

        let mut candidate = session.manifest.clone();
        for existing_capture_id in &replace_automatic_capture_ids {
            if let Some(existing_capture) = candidate.entities.remove(existing_capture_id) {
                for calibration_id in existing_capture.children {
                    candidate.entities.remove(&calibration_id.0);
                }
            }
        }
        let capture_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&capture_record)?)?;
        candidate.entities.insert(
            capture_id.0.clone(),
            EntitySnapshot {
                id: capture_id.clone(),
                kind: EntityKind::CaptureGroup,
                name: capture_record.name.clone(),
                parent: Some(images.clone()),
                children: capture_record.calibration_group_ids.clone(),
                visibility: VisibilityState::default(),
                version_hash: capture_hash.clone(),
                bounds: None,
            },
        );
        let mut hashes = vec![capture_hash];
        for record in &calibration_records {
            let hash = put_project_object(&session.working_path, &serde_json::to_vec(record)?)?;
            hashes.push(hash.clone());
            candidate.entities.insert(
                record.entity_id.0.clone(),
                EntitySnapshot {
                    id: record.entity_id.clone(),
                    kind: EntityKind::CameraCalibrationGroup,
                    name: record.name.clone(),
                    parent: Some(capture_id.clone()),
                    children: Vec::new(),
                    visibility: VisibilityState::default(),
                    version_hash: hash,
                    bounds: None,
                },
            );
        }
        let parent = candidate
            .entities
            .get_mut(&images.0)
            .context("image collection disappeared")?;
        parent
            .children
            .retain(|id| !replace_automatic_capture_ids.contains(&id.0));
        parent.children.push(capture_id.clone());
        parent.children.sort_by(|left, right| left.0.cmp(&right.0));
        parent.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&parent.children)?);
        hashes.push(parent.version_hash.clone());
        commit_domain_entity_change(
            session,
            candidate,
            now,
            "PhotolabCreateCaptureGroup",
            serde_json::to_value(&capture_record)?,
            std::iter::once(capture_id)
                .chain(capture_record.calibration_group_ids.iter().cloned())
                .collect(),
            hashes,
            "Capture and calibration groups created",
        )
    }

    pub fn list_alignment_merge_candidates(&self) -> Result<Vec<AlignmentMergeCandidateRecord>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let processing_sets = session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::ProcessingSet)
            .filter_map(|entity| {
                read_verified_object(&session.working_path, &entity.version_hash)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<ProcessingSetRecord>(&bytes).ok())
            })
            .collect::<Vec<_>>();
        let calibration_groups = session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::CameraCalibrationGroup)
            .filter_map(|entity| {
                read_verified_object(&session.working_path, &entity.version_hash)
                    .ok()
                    .and_then(|bytes| {
                        serde_json::from_slice::<CameraCalibrationGroupRecord>(&bytes).ok()
                    })
            })
            .collect::<Vec<_>>();
        let mut candidates = Vec::new();
        for entity in session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::AlignmentRun)
        {
            let Ok(bytes) = read_verified_object(&session.working_path, &entity.version_hash)
            else {
                continue;
            };
            let Ok(record) = serde_json::from_slice::<ComputeArtifactRecord>(&bytes) else {
                continue;
            };
            if record.artifact.kind != ColmapArtifactKind::SparseModel {
                continue;
            }
            let dataset = session.working_path.join(&record.dataset_relative_path);
            let Ok(scope) = alignment_camera_scope(&record, &dataset, &session.manifest) else {
                continue;
            };
            let scope_set = scope
                .iter()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>();
            let matching_sets = processing_sets
                .iter()
                .filter(|set| {
                    set.camera_entity_ids
                        .iter()
                        .map(|id| id.0.as_str())
                        .collect::<std::collections::BTreeSet<_>>()
                        == scope_set
                })
                .collect::<Vec<_>>();
            let frozen_calibration_groups = if record.calibration_groups.is_empty() {
                calibration_groups
                    .iter()
                    .filter(|group| {
                        group
                            .camera_entity_ids
                            .iter()
                            .all(|id| scope_set.contains(id.0.as_str()))
                    })
                    .map(|group| ColmapCalibrationGroup {
                        group_id: group.entity_id.0.clone(),
                        camera_entity_ids: group
                            .camera_entity_ids
                            .iter()
                            .map(|id| id.0.clone())
                            .collect(),
                        seed: group.initial_calibration.as_ref().and_then(|seed| {
                            Some(ColmapCalibrationSeed {
                                width_pixels: seed.width_pixels,
                                height_pixels: seed.height_pixels,
                                focal_pixels: seed.focal_pixels?,
                                principal_x_pixels: seed.principal_x_pixels?,
                                principal_y_pixels: seed.principal_y_pixels?,
                                full_brown_calibration: seed.full_brown_calibration.clone(),
                            })
                        }),
                    })
                    .collect::<Vec<_>>()
            } else {
                record.calibration_groups.clone()
            };
            let mut calibration_group_ids = frozen_calibration_groups
                .iter()
                .map(|group| EntityId(group.group_id.clone()))
                .collect::<Vec<_>>();
            calibration_group_ids.sort_by(|left, right| left.0.cmp(&right.0));
            candidates.push(AlignmentMergeCandidateRecord {
                entity_id: entity.id.clone(),
                name: entity.name.clone(),
                job_id: record.job_id,
                publication_sequence: record.publication_sequence,
                camera_entity_ids: scope.into_iter().map(EntityId).collect(),
                processing_set_id: record.processing_set_id.or_else(|| {
                    (matching_sets.len() == 1).then(|| matching_sets[0].entity_id.clone())
                }),
                calibration_group_ids,
                calibration_groups: frozen_calibration_groups,
            });
        }
        candidates.sort_by(|left, right| left.entity_id.0.cmp(&right.entity_id.0));
        Ok(candidates)
    }

    pub fn list_alignment_merges(&self) -> Result<Vec<MergedAlignmentRunRecord>> {
        self.list_records_of_kind(EntityKind::MergedAlignmentRun)
    }

    pub fn alignment_merge_compute_context(
        &self,
        merge_entity_id: &EntityId,
    ) -> Result<AlignmentMergeComputeContext> {
        let project = self.compute_context()?;
        let entity = project
            .manifest
            .entities
            .get(&merge_entity_id.0)
            .with_context(|| format!("unknown alignment merge {}", merge_entity_id.0))?;
        anyhow::ensure!(
            entity.kind == EntityKind::MergedAlignmentRun,
            "merge job references a non-merge entity"
        );
        let bytes = read_verified_object(&project.working_path, &entity.version_hash)?;
        let record: MergedAlignmentRunRecord = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            record.entity_id == *merge_entity_id && record.state == MergedAlignmentState::Planned,
            "alignment merge is not an unpublished plan"
        );

        let mut input_camera_scopes = HashMap::new();
        let mut input_dataset_roots = HashMap::new();
        for alignment_id in &record.input_alignment_entity_ids {
            let input = project
                .manifest
                .entities
                .get(&alignment_id.0)
                .with_context(|| format!("missing input alignment {}", alignment_id.0))?;
            let input_bytes = read_verified_object(&project.working_path, &input.version_hash)?;
            let artifact: ComputeArtifactRecord = serde_json::from_slice(&input_bytes)?;
            let dataset = project.working_path.join(&artifact.dataset_relative_path);
            input_dataset_roots.insert(alignment_id.0.clone(), dataset.clone());
            input_camera_scopes.insert(
                alignment_id.0.clone(),
                alignment_camera_scope(&artifact, &dataset, &project.manifest)?,
            );
        }
        let mut optimization_records = HashMap::new();
        for optimization_id in &record.input_gcp_optimization_entity_ids {
            let entity = project
                .manifest
                .entities
                .get(&optimization_id.0)
                .with_context(|| format!("missing GCP optimization {}", optimization_id.0))?;
            let bytes = read_verified_object(&project.working_path, &entity.version_hash)?;
            let optimization: GcpOptimizationPublicationRecord = serde_json::from_slice(&bytes)?;
            let source = optimization
                .source_alignment_entity_id
                .as_ref()
                .context("merge GCP optimization has no source alignment")?;
            optimization_records.insert(source.0.clone(), optimization);
        }
        let union = record
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let mut calibration_groups = self
            .list_calibration_groups()?
            .into_iter()
            .filter_map(|group| {
                let camera_entity_ids = group
                    .camera_entity_ids
                    .iter()
                    .filter(|id| union.contains(&id.0))
                    .map(|id| id.0.clone())
                    .collect::<Vec<_>>();
                (!camera_entity_ids.is_empty()).then(|| ColmapCalibrationGroup {
                    group_id: group.entity_id.0,
                    camera_entity_ids,
                    seed: group.initial_calibration.and_then(|seed| {
                        Some(ColmapCalibrationSeed {
                            width_pixels: seed.width_pixels,
                            height_pixels: seed.height_pixels,
                            focal_pixels: seed.focal_pixels?,
                            principal_x_pixels: seed.principal_x_pixels?,
                            principal_y_pixels: seed.principal_y_pixels?,
                            full_brown_calibration: seed.full_brown_calibration,
                        })
                    }),
                })
            })
            .collect::<Vec<_>>();
        let covered = calibration_groups
            .iter()
            .flat_map(|group| group.camera_entity_ids.iter().cloned())
            .collect::<std::collections::BTreeSet<_>>();
        if covered != union {
            // Legacy projects did not persist calibration groups. Keeping each independently
            // solved alignment separate is the conservative, autofocus-safe migration.
            calibration_groups = union
                .iter()
                .map(|camera_id| ColmapCalibrationGroup {
                    group_id: format!("legacy:{camera_id}"),
                    camera_entity_ids: vec![camera_id.clone()],
                    seed: None,
                })
                .collect();
        }
        Ok(AlignmentMergeComputeContext {
            record,
            project,
            input_camera_scopes,
            input_dataset_roots,
            optimization_records,
            calibration_groups,
        })
    }

    pub fn create_alignment_merge(
        &self,
        params: CreateAlignmentMergeParams,
    ) -> Result<OpenPhotolabProjectResult> {
        let name = validated_record_name(&params.name, "alignment merge")?;
        let mut input_ids = params.input_alignment_entity_ids;
        sort_unique_entity_ids(&mut input_ids, "alignment merge")?;
        anyhow::ensure!(
            input_ids.len() >= 2,
            "an alignment merge needs at least two input alignments"
        );
        let mut optimization_ids = params.input_gcp_optimization_entity_ids;
        sort_unique_entity_ids(&mut optimization_ids, "GCP optimization lineage")?;

        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let mut camera_ids = Vec::new();
        for input_id in &input_ids {
            let entity = session
                .manifest
                .entities
                .get(&input_id.0)
                .with_context(|| format!("unknown input alignment {}", input_id.0))?;
            anyhow::ensure!(
                entity.kind == EntityKind::AlignmentRun,
                "merge input is not a published alignment run"
            );
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)
                .context("merge input is not a sparse alignment artifact")?;
            anyhow::ensure!(
                record.artifact.kind == ColmapArtifactKind::SparseModel,
                "merge input is not a sparse alignment artifact"
            );
            let dataset = session.working_path.join(&record.dataset_relative_path);
            let input_camera_ids = alignment_camera_scope(&record, &dataset, &session.manifest)?;
            let current_mask_scope =
                build_image_mask_compute_scope(session, &input_camera_ids, None)?;
            match record.image_mask_scope_sha256.as_ref() {
                Some(frozen) => anyhow::ensure!(
                    frozen == &current_mask_scope.scope_sha256,
                    "an input alignment's image masks changed; realign that block before merging"
                ),
                None => anyhow::ensure!(
                    current_mask_scope.masks.is_empty(),
                    "a legacy input alignment predates its current image masks; realign that block before merging"
                ),
            }
            camera_ids.extend(input_camera_ids.into_iter().map(EntityId));
        }
        camera_ids.sort_by(|left, right| left.0.cmp(&right.0));
        camera_ids.dedup();
        let image_mask_scope_sha256 = build_image_mask_compute_scope(
            session,
            &camera_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
            None,
        )?
        .scope_sha256;

        let optimization_records = optimization_ids
            .iter()
            .map(|id| {
                let entity = session
                    .manifest
                    .entities
                    .get(&id.0)
                    .with_context(|| format!("unknown GCP optimization {}", id.0))?;
                anyhow::ensure!(
                    entity.kind == EntityKind::AlignmentRun,
                    "GCP optimization lineage references a non-alignment entity"
                );
                let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
                let record: GcpOptimizationPublicationRecord = serde_json::from_slice(&bytes)
                    .context("GCP optimization lineage references a non-optimization record")?;
                Ok((id.clone(), record))
            })
            .collect::<Result<Vec<_>>>()?;
        validate_merge_connections(&input_ids, &params.connections, &optimization_records)?;

        let now = unix_ms()?;
        let entity_id = EntityId(format!(
            "{}:alignment-merge:{}",
            session.manifest.project_id,
            unique_id("merge", now)
        ));
        let lineage_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&(
            &input_ids,
            &optimization_ids,
            &params.connections,
            &camera_ids,
            &image_mask_scope_sha256,
        ))?);
        let record = MergedAlignmentRunRecord {
            schema_version: 1,
            entity_id: entity_id.clone(),
            name,
            state: MergedAlignmentState::Planned,
            input_alignment_entity_ids: input_ids,
            input_gcp_optimization_entity_ids: optimization_ids,
            connections: params.connections,
            camera_entity_ids: camera_ids,
            image_mask_scope_sha256: Some(image_mask_scope_sha256),
            lineage_sha256,
            dataset_relative_path: None,
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let survey = unique_entity_of_kind(&session.manifest, EntityKind::Survey, "survey")?;
        let mut candidate = session.manifest.clone();
        candidate.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::MergedAlignmentRun,
                name: record.name.clone(),
                parent: Some(survey.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        let parent = candidate
            .entities
            .get_mut(&survey.0)
            .context("survey disappeared")?;
        parent.children.push(entity_id.clone());
        parent.children.sort_by(|left, right| left.0.cmp(&right.0));
        parent.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&parent.children)?);
        let parent_hash = parent.version_hash.clone();
        commit_domain_entity_change(
            session,
            candidate,
            now,
            "PhotolabCreateAlignmentMerge",
            serde_json::to_value(&record)?,
            vec![entity_id],
            vec![version_hash, parent_hash],
            "Validated alignment merge plan created; no products are published before the joint solve",
        )
    }

    pub fn publish_alignment_merge_outcome(
        &self,
        merge_entity_id: &EntityId,
        outcome: ColmapRunOutcome,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(&outcome.summary.job_id)?;
        let context = self.alignment_merge_compute_context(merge_entity_id)?;
        let expected = context
            .record
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<std::collections::BTreeSet<_>>();
        anyhow::ensure!(
            outcome
                .summary
                .camera_entity_ids
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
                == expected,
            "joint alignment output camera scope differs from the immutable merge plan"
        );
        let inputs = context
            .record
            .input_alignment_entity_ids
            .iter()
            .map(|id| MergeInputScope {
                alignment_id: id.clone(),
                camera_entity_ids: context
                    .input_camera_scopes
                    .get(&id.0)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            })
            .collect::<Vec<_>>();
        let evidence = inspect_solved_merge(&outcome.scratch_path, &inputs, &expected)?;
        let mut published_connections = context.record.connections.clone();
        for connection in &mut published_connections {
            if let AlignmentMergeConnection::Overlap {
                alignment_a,
                alignment_b,
                verified_cross_run_track_count,
            } = connection
            {
                let actual = solved_overlap_count(&evidence, alignment_a, alignment_b);
                anyhow::ensure!(
                    actual >= 3,
                    "joint solve found only {actual} verified tracks between {} and {}; at least 3 are required",
                    alignment_a.0,
                    alignment_b.0
                );
                *verified_cross_run_track_count = actual;
            }
        }
        let evidence_path = outcome.scratch_path.join("alignment-merge-evidence.json");
        atomic_write_json(&evidence_path, &evidence)?;

        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let before_version_hash = session
            .manifest
            .entities
            .get(&merge_entity_id.0)
            .context("alignment merge disappeared before publication")?
            .version_hash
            .clone();
        anyhow::ensure!(
            before_version_hash
                == context
                    .project
                    .manifest
                    .entities
                    .get(&merge_entity_id.0)
                    .context("merge context lost entity")?
                    .version_hash,
            "alignment merge plan changed while the solve was running"
        );
        let dataset_relative_path = format!("datasets/alignment-merges/{}", outcome.summary.job_id);
        let dataset_path = session.working_path.join(&dataset_relative_path);
        anyhow::ensure!(!dataset_path.exists(), "merge dataset already exists");
        fs::create_dir_all(
            dataset_path
                .parent()
                .context("merge dataset has no parent")?,
        )?;
        for transient in ["tmp", "home", "cache"] {
            let path = outcome.scratch_path.join(transient);
            if path.exists() {
                fs::remove_dir_all(path)?;
            }
        }
        fs::rename(&outcome.scratch_path, &dataset_path)
            .context("failed to atomically publish solved alignment merge dataset")?;

        let mut published = context.record;
        published.state = MergedAlignmentState::Published;
        published.connections = published_connections;
        published.dataset_relative_path = Some(dataset_relative_path.clone());
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&published)?)?;
        let mut candidate = session.manifest.clone();
        let entity = candidate
            .entities
            .get_mut(&merge_entity_id.0)
            .context("alignment merge disappeared during publication")?;
        entity.version_hash = version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("alignment-merge-publish-{}", outcome.summary.job_id),
            command_kind: "PhotolabPublishAlignmentMerge".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "mergeEntityId": merge_entity_id,
                "jobId": outcome.summary.job_id,
                "datasetRelativePath": dataset_relative_path,
                "summarySha256": outcome.summary_sha256,
                "evidence": evidence,
            }),
            affected_entities: vec![merge_entity_id.clone()],
            before_refs: vec![before_version_hash],
            after_refs: vec![version_hash],
            message: Some("Joint alignment merge validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(
            &session.working_path,
            &outcome.summary.job_id,
            PhotolabJobKind::MergeAlignments,
        );
        Ok(PublishColmapResult {
            job_id: outcome.summary.job_id,
            entity_ids: vec![merge_entity_id.clone()],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn publish_shared_control_merge_outcome(
        &self,
        merge_entity_id: &EntityId,
        outcome: SharedControlMergeOutcome,
        operation_id: &str,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(operation_id)?;
        let context = self.alignment_merge_compute_context(merge_entity_id)?;
        anyhow::ensure!(
            context.record.connections.iter().all(|connection| matches!(
                connection,
                AlignmentMergeConnection::SharedControls { .. }
            )),
            "shared-control block assembly cannot satisfy a planned overlap edge"
        );
        let expected = context
            .record
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<std::collections::BTreeSet<_>>();
        anyhow::ensure!(
            outcome
                .camera_entity_ids
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
                == expected,
            "shared-control dataset camera scope differs from the immutable merge plan"
        );
        let evidence = serde_json::json!({
            "schemaVersion": 1,
            "method": "sharedControlsCommonSurveyFrame",
            "connections": context.record.connections,
            "datasetSha256": outcome.dataset_sha256,
            "note": "Blocks retain independent observations and intrinsics; shared controls establish the common survey frame without claiming cross-block bundle observations."
        });
        atomic_write_json(
            &outcome.scratch_path.join("alignment-merge-evidence.json"),
            &evidence,
        )?;

        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let before_version_hash = session
            .manifest
            .entities
            .get(&merge_entity_id.0)
            .context("alignment merge disappeared before publication")?
            .version_hash
            .clone();
        anyhow::ensure!(
            before_version_hash
                == context
                    .project
                    .manifest
                    .entities
                    .get(&merge_entity_id.0)
                    .context("merge context lost entity")?
                    .version_hash,
            "alignment merge plan changed while the solve was running"
        );
        let dataset_relative_path = format!("datasets/alignment-merges/{operation_id}");
        let dataset_path = session.working_path.join(&dataset_relative_path);
        anyhow::ensure!(!dataset_path.exists(), "merge dataset already exists");
        fs::create_dir_all(
            dataset_path
                .parent()
                .context("merge dataset has no parent")?,
        )?;
        fs::rename(&outcome.scratch_path, &dataset_path)
            .context("failed to atomically publish shared-control alignment dataset")?;
        let mut published = context.record;
        published.state = MergedAlignmentState::Published;
        published.dataset_relative_path = Some(dataset_relative_path.clone());
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&published)?)?;
        let mut candidate = session.manifest.clone();
        candidate
            .entities
            .get_mut(&merge_entity_id.0)
            .context("alignment merge disappeared during publication")?
            .version_hash = version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("alignment-merge-publish-{operation_id}"),
            command_kind: "PhotolabPublishSharedControlAlignmentMerge".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({ "mergeEntityId": merge_entity_id, "jobId": operation_id, "datasetRelativePath": dataset_relative_path, "datasetSha256": outcome.dataset_sha256, "evidence": evidence }),
            affected_entities: vec![merge_entity_id.clone()],
            before_refs: vec![before_version_hash],
            after_refs: vec![version_hash],
            message: Some(
                "Shared-control sparse blocks atomically published in their common survey frame"
                    .into(),
            ),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(
            &session.working_path,
            operation_id,
            PhotolabJobKind::MergeAlignments,
        );
        Ok(PublishColmapResult {
            job_id: operation_id.into(),
            entity_ids: vec![merge_entity_id.clone()],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    fn list_records_of_kind<T: serde::de::DeserializeOwned>(
        &self,
        kind: EntityKind,
    ) -> Result<Vec<T>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == kind)
            .map(|entity| {
                read_verified_object(&session.working_path, &entity.version_hash)
                    .and_then(|bytes| serde_json::from_slice(&bytes).map_err(anyhow::Error::from))
            })
            .collect()
    }

    pub fn compute_context(&self) -> Result<ProjectComputeContext> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        Ok(ProjectComputeContext {
            working_path: session.working_path.clone(),
            manifest: session.manifest.clone(),
            camera_images: read_project_camera_images(&session.working_path, &session.manifest)
                .map_err(anyhow::Error::from)?,
        })
    }

    pub fn latest_alignment_dataset(&self) -> Result<PublishedAlignmentDataset> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        select_alignment_dataset(session, None, None)
    }

    pub fn latest_alignment_dataset_for_processing_set(
        &self,
        processing_set_id: Option<&EntityId>,
    ) -> Result<PublishedAlignmentDataset> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let Some(processing_set_id) = processing_set_id else {
            return select_alignment_dataset(session, None, None);
        };
        let record = read_processing_set(session, processing_set_id)?;
        let required_scope = record
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<Vec<_>>();
        select_alignment_dataset(
            session,
            Some(&required_scope),
            Some(processing_set_id.clone()),
        )
        .with_context(|| {
            format!(
                "no completed sparse alignment exactly matches processing set {}",
                processing_set_id.0
            )
        })
    }

    pub fn alignment_dataset_by_entity_id(
        &self,
        alignment_entity_id: &EntityId,
        processing_set_id: Option<&EntityId>,
    ) -> Result<PublishedAlignmentDataset> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let entity = session
            .manifest
            .entities
            .get(&alignment_entity_id.0)
            .with_context(|| format!("unknown source alignment {}", alignment_entity_id.0))?;
        let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
        let (root, camera_entity_ids, image_mask_scope_sha256) = match entity.kind {
            EntityKind::MergedAlignmentRun => {
                let record: MergedAlignmentRunRecord = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    record.state == MergedAlignmentState::Published,
                    "selected alignment merge has not published a joint solve"
                );
                let relative = record
                    .dataset_relative_path
                    .context("published alignment merge has no dataset")?;
                (
                    session.working_path.join(relative),
                    validate_camera_scope(
                        &session.manifest,
                        &record
                            .camera_entity_ids
                            .iter()
                            .map(|id| id.0.clone())
                            .collect::<Vec<_>>(),
                    )?,
                    record.image_mask_scope_sha256,
                )
            }
            EntityKind::AlignmentRun => {
                let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    record.artifact.kind == ColmapArtifactKind::SparseModel,
                    "selected alignment entity is not a sparse model"
                );
                let root = session.working_path.join(&record.dataset_relative_path);
                let scope = alignment_camera_scope(&record, &root, &session.manifest)?;
                (root, scope, record.image_mask_scope_sha256)
            }
            _ => anyhow::bail!("selected product source is not an alignment"),
        };
        let root = root.canonicalize()?;
        anyhow::ensure!(
            root.starts_with(session.working_path.canonicalize()?) && root.is_dir(),
            "selected alignment dataset escaped the project"
        );
        if let Some(processing_set_id) = processing_set_id {
            let set = read_processing_set(session, processing_set_id)?;
            anyhow::ensure!(
                validate_processing_set_record(&session.manifest, &set)? == camera_entity_ids,
                "processing set membership differs from the selected alignment"
            );
        }
        let current_mask_scope =
            build_image_mask_compute_scope(session, &camera_entity_ids, processing_set_id)?;
        match image_mask_scope_sha256.as_ref() {
            Some(frozen) => anyhow::ensure!(
                frozen == &current_mask_scope.scope_sha256,
                "image masks changed after the selected alignment; rerun alignment"
            ),
            None => anyhow::ensure!(
                current_mask_scope.masks.is_empty(),
                "the selected legacy alignment predates its current image masks; rerun alignment"
            ),
        }
        Ok(PublishedAlignmentDataset {
            root,
            camera_entity_ids,
            source_alignment_entity_id: alignment_entity_id.clone(),
            processing_set_id: processing_set_id.cloned(),
            image_mask_scope_sha256: current_mask_scope.scope_sha256,
        })
    }

    pub fn latest_alignment_dataset_for_camera_scope(
        &self,
        camera_entity_ids: &[String],
    ) -> Result<PublishedAlignmentDataset> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let scope = validate_camera_scope(&session.manifest, camera_entity_ids)?;
        select_alignment_dataset(session, Some(&scope), None).with_context(|| {
            "no completed sparse alignment exactly matches the requested batch camera scope"
        })
    }

    pub fn latest_alignment_dataset_root(&self) -> Result<PathBuf> {
        Ok(self.latest_alignment_dataset()?.root)
    }

    pub fn latest_gcp_optimization(&self) -> Result<Option<GcpOptimizationPublicationRecord>> {
        Ok(self
            .list_gcp_optimizations()?
            .into_iter()
            .max_by(gcp_publication_order)
            .map(|entry| entry.optimization))
    }

    pub fn list_gcp_optimizations(&self) -> Result<Vec<PublishedGcpOptimizationEntry>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut records = Vec::new();
        for entity in session.manifest.entities.values().filter(|entity| {
            entity.kind == EntityKind::AlignmentRun && entity.id.0.contains(":alignment-gcp:")
        }) {
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let Ok(optimization) =
                serde_json::from_slice::<GcpOptimizationPublicationRecord>(&bytes)
            else {
                continue;
            };
            records.push(PublishedGcpOptimizationEntry {
                entity_id: entity.id.clone(),
                optimization,
            });
        }
        records.sort_by(gcp_publication_order);
        Ok(records)
    }

    pub fn latest_gcp_optimization_entry_for_lineage(
        &self,
        lineage: &ProductLineage,
    ) -> Result<Option<PublishedGcpOptimizationEntry>> {
        Ok(self
            .list_gcp_optimizations()?
            .into_iter()
            .filter(|entry| {
                record_matches_lineage(
                    entry.optimization.source_alignment_entity_id.as_ref(),
                    entry.optimization.processing_set_id.as_ref(),
                    lineage,
                )
            })
            .max_by(gcp_publication_order))
    }

    pub fn latest_gcp_optimization_for_lineage(
        &self,
        lineage: &ProductLineage,
    ) -> Result<Option<GcpOptimizationPublicationRecord>> {
        Ok(self
            .latest_gcp_optimization_entry_for_lineage(lineage)?
            .map(|entry| entry.optimization))
    }

    /// Selects a published, settings-identical depth product for immutable reuse.
    pub fn latest_compatible_depth_mvs_dataset_for_lineage(
        &self,
        lineage: &ProductLineage,
        settings_sha256: &ObjectHash,
        image_mask_scope_sha256: &ObjectHash,
    ) -> Result<Option<(PathBuf, MvsArtifactRecord)>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut entities = session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::DepthMap)
            .collect::<Vec<_>>();
        entities.sort_by(|left, right| right.id.0.cmp(&left.id.0));
        for entity in entities {
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let Ok(record) = serde_json::from_slice::<MvsArtifactRecord>(&bytes) else {
                continue;
            };
            if record.output.settings_sha256 != *settings_sha256
                || record.image_mask_scope_sha256.as_ref() != Some(image_mask_scope_sha256)
                || !product_record_matches_lineage(
                    record.source_alignment_entity_id.as_ref(),
                    record.processing_set_id.as_ref(),
                    record.gcp_optimization_entity_id.as_ref(),
                    record.gcp_optimization_snapshot_sha256.as_ref(),
                    record.image_mask_scope_sha256.as_ref(),
                    lineage,
                )
                || record.output.depth_images.is_empty()
            {
                continue;
            }
            let scene_manifest = session
                .working_path
                .join(".photolab/mvs-scenes")
                .join(&record.job_id)
                .join("scene.json");
            let Ok(scene_bytes) = fs::read(&scene_manifest) else {
                continue;
            };
            if ObjectHash::of_bytes(&scene_bytes) != record.output.scene_manifest_sha256 {
                continue;
            }
            let Ok(scene) = serde_json::from_slice::<MvsSceneManifest>(&scene_bytes) else {
                continue;
            };
            if scene.image_mask_scope_sha256.as_ref() != Some(image_mask_scope_sha256) {
                continue;
            }
            let dataset = session
                .working_path
                .join(&record.dataset_relative_path)
                .canonicalize()?;
            let root = session.working_path.canonicalize()?;
            anyhow::ensure!(
                dataset.starts_with(&root)
                    && dataset.is_dir()
                    && dataset.join("output/index.json").is_file()
                    && dataset.join("checkpoints").is_dir(),
                "depth MVS dataset is incomplete or escaped the project root"
            );
            return Ok(Some((dataset, record)));
        }
        Ok(None)
    }

    pub fn latest_dense_mvs_dataset_for_lineage(
        &self,
        lineage: &ProductLineage,
    ) -> Result<(PathBuf, MvsArtifactRecord)> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut entities = session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::PointCloud)
            .collect::<Vec<_>>();
        entities.sort_by(|left, right| right.id.0.cmp(&left.id.0));
        for entity in entities {
            let path = project_object_path(&session.working_path, &entity.version_hash);
            let bytes = fs::read(path)?;
            anyhow::ensure!(
                ObjectHash::of_bytes(&bytes) == entity.version_hash,
                "dense MVS record hash mismatch"
            );
            let Ok(record) = serde_json::from_slice::<MvsArtifactRecord>(&bytes) else {
                continue;
            };
            if !product_record_matches_lineage(
                record.source_alignment_entity_id.as_ref(),
                record.processing_set_id.as_ref(),
                record.gcp_optimization_entity_id.as_ref(),
                record.gcp_optimization_snapshot_sha256.as_ref(),
                record.image_mask_scope_sha256.as_ref(),
                lineage,
            ) {
                continue;
            }
            let Some(dense) = record.output.dense_point_cloud.as_ref() else {
                continue;
            };
            let dataset = session
                .working_path
                .join(&record.dataset_relative_path)
                .join("output")
                .join(&dense.relative_path)
                .canonicalize()?;
            let root = session.working_path.canonicalize()?;
            anyhow::ensure!(
                dataset.starts_with(&root) && dataset.is_file(),
                "dense dataset escaped project root"
            );
            return Ok((dataset, record));
        }
        anyhow::bail!(
            "no completed portable dense point cloud is available for this alignment lineage"
        )
    }

    pub fn latest_raster_dataset_for_lineage(
        &self,
        kind: PublishedRasterKind,
        lineage: &ProductLineage,
    ) -> Result<(PathBuf, RasterArtifactRecord)> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let entity_kind = match kind {
            PublishedRasterKind::Dem => EntityKind::DigitalElevationModel,
            PublishedRasterKind::Orthomosaic => EntityKind::Orthomosaic,
        };
        let mut entities = session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == entity_kind)
            .collect::<Vec<_>>();
        entities.sort_by(|left, right| right.id.0.cmp(&left.id.0));
        for entity in entities {
            let bytes = fs::read(project_object_path(
                &session.working_path,
                &entity.version_hash,
            ))?;
            anyhow::ensure!(
                ObjectHash::of_bytes(&bytes) == entity.version_hash,
                "raster record hash mismatch"
            );
            let record: RasterArtifactRecord = serde_json::from_slice(&bytes)?;
            if !product_record_matches_lineage(
                record.source_alignment_entity_id.as_ref(),
                record.processing_set_id.as_ref(),
                record.gcp_optimization_entity_id.as_ref(),
                record.gcp_optimization_snapshot_sha256.as_ref(),
                record.image_mask_scope_sha256.as_ref(),
                lineage,
            ) {
                continue;
            }
            let dataset = session
                .working_path
                .join(&record.dataset_relative_path)
                .canonicalize()?;
            anyhow::ensure!(
                dataset.starts_with(session.working_path.canonicalize()?) && dataset.is_dir(),
                "raster dataset escaped project root"
            );
            return Ok((dataset, record));
        }
        anyhow::bail!("no completed raster product is available for this alignment lineage")
    }

    /// Resolves one exact raster entity revision; batch planning must never use "latest".
    pub fn raster_dataset_by_entity_id(
        &self,
        entity_id: &EntityId,
        expected_kind: PublishedRasterKind,
        required_lineage: Option<&ProductLineage>,
    ) -> Result<(PathBuf, RasterArtifactRecord)> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let entity = session
            .manifest
            .entities
            .get(&entity_id.0)
            .context("selected raster entity does not exist")?;
        let expected_entity_kind = match expected_kind {
            PublishedRasterKind::Dem => EntityKind::DigitalElevationModel,
            PublishedRasterKind::Orthomosaic => EntityKind::Orthomosaic,
        };
        anyhow::ensure!(
            entity.kind == expected_entity_kind,
            "selected raster has the wrong kind"
        );
        let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
        let record: RasterArtifactRecord = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            record.kind == expected_kind,
            "selected raster record has the wrong kind"
        );
        if let Some(lineage) = required_lineage {
            anyhow::ensure!(
                product_record_matches_lineage(
                    record.source_alignment_entity_id.as_ref(),
                    record.processing_set_id.as_ref(),
                    record.gcp_optimization_entity_id.as_ref(),
                    record.gcp_optimization_snapshot_sha256.as_ref(),
                    record.image_mask_scope_sha256.as_ref(),
                    lineage,
                ),
                "selected raster does not belong to the frozen processing lineage"
            );
        }
        let dataset = session
            .working_path
            .join(&record.dataset_relative_path)
            .canonicalize()?;
        let root = session.working_path.canonicalize()?;
        anyhow::ensure!(
            dataset.starts_with(&root) && dataset.is_dir(),
            "raster dataset escaped project root"
        );
        Ok((dataset, record))
    }

    pub fn list_product_datasets(&self) -> Result<Vec<ProjectProductDatasetRecord>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut records = Vec::new();
        for entity in session.manifest.entities.values() {
            let object_path = project_object_path(&session.working_path, &entity.version_hash);
            if !matches!(
                entity.kind,
                EntityKind::GaussianSplatCloud
                    | EntityKind::DigitalElevationModel
                    | EntityKind::Orthomosaic
                    | EntityKind::DepthMap
                    | EntityKind::PointCloud
                    | EntityKind::Mesh
                    | EntityKind::TexturedMesh
            ) {
                continue;
            }
            let bytes = fs::read(&object_path)?;
            anyhow::ensure!(
                ObjectHash::of_bytes(&bytes) == entity.version_hash,
                "product record hash mismatch for {}",
                entity.id.0
            );
            if matches!(entity.kind, EntityKind::Mesh | EntityKind::TexturedMesh) {
                let PublishedMeshRecord::Prepared(record) =
                    decode_published_mesh_record(&bytes, entity.kind)?
                else {
                    // Raw COLMAP outputs are immutable export products, but they are not a
                    // renderer-ready tiled dataset. The mesh preprocessor publishes those via
                    // `MeshArtifactRecord` once a shared hierarchy exists.
                    continue;
                };
                let relative = dataset_protocol_relative(&record.dataset_relative_path)?
                    .join(&record.prepared.manifest_relative_path);
                let prepared_root = dataset_protocol_relative(&record.dataset_relative_path)?;
                let prepared_mesh = record
                    .prepared
                    .kernel_manifest_relative_path
                    .as_ref()
                    .zip(record.prepared.kernel_manifest_resource.as_ref())
                    .zip(
                        record
                            .prepared
                            .preparation_descriptor_relative_path
                            .as_ref()
                            .zip(record.prepared.preparation_descriptor_resource.as_ref()),
                    )
                    .zip(record.prepared.section_topology.as_ref())
                    .zip(record.canonical_dataset.as_ref())
                    .map(
                        |(
                            (
                                ((render_path, render_resource), (recipe_path, recipe_resource)),
                                topology,
                            ),
                            canonical_dataset,
                        )|
                         -> Result<ProjectPreparedMeshDatasetRecord> {
                            let (canonical_admission, canonical_objects) =
                                canonical_prepared_mesh_contract(
                                    entity,
                                    &record,
                                    render_resource,
                                    recipe_resource,
                                    &topology.manifest_resource,
                                )?;
                            Ok(ProjectPreparedMeshDatasetRecord {
                                dataset_id: format!(
                                    "prepared-mesh-{}",
                                    render_resource.object_hash.as_str()
                                ),
                                provider_id: "hcad.prepared-triangle-mesh".to_owned(),
                                provider_version: "1.0.0".to_owned(),
                                render_manifest_relative_path: path_string(
                                    &prepared_root.join(render_path),
                                ),
                                render_manifest_resource: render_resource.clone(),
                                preparation_descriptor_relative_path: path_string(
                                    &prepared_root.join(recipe_path),
                                ),
                                preparation_descriptor_resource: recipe_resource.clone(),
                                section_topology_relative_path: path_string(
                                    &prepared_root.join(&topology.manifest_relative_path),
                                ),
                                section_topology_resource: topology.manifest_resource.clone(),
                                canonical_admission,
                                canonical_objects,
                                canonical_dataset: canonical_dataset.clone(),
                            })
                        },
                    )
                    .transpose()?;
                records.push(ProjectProductDatasetRecord {
                    entity_id: entity.id.clone(),
                    kind: "mesh".into(),
                    relative_path: path_string(&relative),
                    format: "tiledMesh".into(),
                    visible: entity.visibility.visible,
                    prepared_mesh,
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
                    source_alignment_entity_id: record.source_alignment_entity_id,
                    processing_set_id: record.processing_set_id,
                    gcp_optimization_entity_id: record.gcp_optimization_entity_id,
                    gcp_optimization_snapshot_sha256: record.gcp_optimization_snapshot_sha256,
                });
            } else if entity.kind == EntityKind::DepthMap {
                let record: MvsArtifactRecord = serde_json::from_slice(&bytes)?;
                let dataset = dataset_protocol_relative(&record.dataset_relative_path)?;
                records.push(ProjectProductDatasetRecord {
                    entity_id: entity.id.clone(),
                    kind: "depth".into(),
                    relative_path: path_string(&dataset.join("output/index.json")),
                    format: "mvsDepth".into(),
                    visible: entity.visibility.visible,
                    prepared_mesh: None,
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
                    source_alignment_entity_id: record.source_alignment_entity_id,
                    processing_set_id: record.processing_set_id,
                    gcp_optimization_entity_id: record.gcp_optimization_entity_id,
                    gcp_optimization_snapshot_sha256: record.gcp_optimization_snapshot_sha256,
                });
            } else if entity.kind == EntityKind::PointCloud {
                if let Ok(record) = serde_json::from_slice::<MvsArtifactRecord>(&bytes) {
                    let dataset = dataset_protocol_relative(&record.dataset_relative_path)?;
                    let dense = record.output.dense_point_cloud.as_ref().context(
                        "dense point-cloud entity references an MVS record without dense output",
                    )?;
                    let (relative_path, format) = if let Some(potree) = &record.potree {
                        (dataset.join(&potree.relative_metadata_path), "potreeV2")
                    } else {
                        (
                            dataset.join("output").join(&dense.relative_path),
                            "binaryPly",
                        )
                    };
                    records.push(ProjectProductDatasetRecord {
                        entity_id: entity.id.clone(),
                        kind: "dense".into(),
                        relative_path: path_string(&relative_path),
                        format: format.into(),
                        visible: entity.visibility.visible,
                        prepared_mesh: None,
                        bounds_min: record.potree.as_ref().map(|potree| potree.bounds_min),
                        bounds_max: record.potree.as_ref().map(|potree| potree.bounds_max),
                        render_offset: record.potree.as_ref().map(|potree| potree.render_offset),
                        point_count: record.potree.as_ref().map(|potree| potree.point_count),
                        source_alignment_entity_id: record.source_alignment_entity_id,
                        processing_set_id: record.processing_set_id,
                        gcp_optimization_entity_id: record.gcp_optimization_entity_id,
                        gcp_optimization_snapshot_sha256: record.gcp_optimization_snapshot_sha256,
                    });
                } else {
                    let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        record.artifact.kind == ColmapArtifactKind::SparsePointCloud,
                        "point-cloud compute record is not a sparse point cloud"
                    );
                    let potree = record
                        .potree
                        .as_ref()
                        .context("sparse point cloud has no Potree hierarchy")?;
                    let dataset = dataset_protocol_relative(&record.dataset_relative_path)?;
                    records.push(ProjectProductDatasetRecord {
                        entity_id: entity.id.clone(),
                        kind: "sparse".into(),
                        relative_path: path_string(&dataset.join(&potree.relative_metadata_path)),
                        format: "potreeV2".into(),
                        visible: entity.visibility.visible,
                        prepared_mesh: None,
                        bounds_min: Some(potree.bounds_min),
                        bounds_max: Some(potree.bounds_max),
                        render_offset: Some(potree.render_offset),
                        point_count: Some(potree.point_count),
                        source_alignment_entity_id: record.parent_alignment_entity_id,
                        processing_set_id: None,
                        gcp_optimization_entity_id: None,
                        gcp_optimization_snapshot_sha256: None,
                    });
                }
            } else if entity.kind == EntityKind::GaussianSplatCloud {
                let record: BrushArtifactRecord = serde_json::from_slice(&bytes)?;
                let relative = dataset_protocol_relative(&record.dataset_relative_path)?.join(
                    record.prepared_splats.as_ref().map_or(
                        record.summary.final_output.relative_path.as_path(),
                        |prepared| prepared.manifest_relative_path.as_path(),
                    ),
                );
                records.push(ProjectProductDatasetRecord {
                    entity_id: entity.id.clone(),
                    kind: "gaussianSplat".into(),
                    relative_path: path_string(&relative),
                    format: if record.prepared_splats.is_some() {
                        "prepared"
                    } else {
                        "brushPly"
                    }
                    .into(),
                    visible: entity.visibility.visible,
                    prepared_mesh: None,
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
                    source_alignment_entity_id: record.source_alignment_entity_id,
                    processing_set_id: record.processing_set_id,
                    gcp_optimization_entity_id: record.gcp_optimization_entity_id,
                    gcp_optimization_snapshot_sha256: record.gcp_optimization_snapshot_sha256,
                });
            } else {
                let record: RasterArtifactRecord = serde_json::from_slice(&bytes)?;
                let relative = dataset_protocol_relative(&record.dataset_relative_path)?
                    .join(&record.summary.pyramid_manifest_path);
                records.push(ProjectProductDatasetRecord {
                    entity_id: entity.id.clone(),
                    kind: match record.kind {
                        PublishedRasterKind::Dem => "dem".into(),
                        PublishedRasterKind::Orthomosaic => "orthomosaic".into(),
                    },
                    relative_path: path_string(&relative),
                    format: "rasterPyramid".into(),
                    visible: entity.visibility.visible,
                    prepared_mesh: None,
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
                    source_alignment_entity_id: record.source_alignment_entity_id,
                    processing_set_id: record.processing_set_id,
                    gcp_optimization_entity_id: record.gcp_optimization_entity_id,
                    gcp_optimization_snapshot_sha256: record.gcp_optimization_snapshot_sha256,
                });
            }
        }
        records.sort_by(|left, right| left.entity_id.0.cmp(&right.entity_id.0));
        Ok(records)
    }

    pub fn frozen_horizontal_crs(&self) -> Result<Option<CrsDefinition>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        Ok(session
            .manifest
            .reference_frame
            .as_ref()
            .map(|frame| frame.target.horizontal.crs.clone()))
    }

    pub fn product_export_source(&self, entity_id: &EntityId) -> Result<ProductExportSource> {
        self.product_export_source_with_format(entity_id, None, None)
    }

    pub fn pointcloud_export_format(
        &self,
        entity_id: &EntityId,
        requested: Option<PointCloudExportFormat>,
    ) -> Result<Option<PointCloudExportFormat>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let entity = session
            .manifest
            .entities
            .get(&entity_id.0)
            .context("product entity does not exist")?;
        if entity.kind != EntityKind::PointCloud {
            anyhow::ensure!(
                requested.is_none(),
                "an explicit point-cloud format is only valid for point-cloud products"
            );
            return Ok(None);
        }
        let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
        let dense = serde_json::from_slice::<MvsArtifactRecord>(&bytes).is_ok();
        Ok(Some(requested.unwrap_or(if dense {
            PointCloudExportFormat::Laz
        } else {
            PointCloudExportFormat::Ply
        })))
    }

    pub fn product_export_source_with_format(
        &self,
        entity_id: &EntityId,
        requested_format: Option<PointCloudExportFormat>,
        crs_wkt: Option<String>,
    ) -> Result<ProductExportSource> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let entity = session
            .manifest
            .entities
            .get(&entity_id.0)
            .context("product entity does not exist")?;
        let bytes = fs::read(project_object_path(
            &session.working_path,
            &entity.version_hash,
        ))?;
        anyhow::ensure!(
            ObjectHash::of_bytes(&bytes) == entity.version_hash,
            "product record hash mismatch"
        );
        let dataset_root = session.working_path.canonicalize()?.join("datasets");
        let stem = safe_export_stem(&entity.name);
        let mut conversion = ProductExportConversion::Copy;
        let (path, kind, suggested_name) = match entity.kind {
            EntityKind::DigitalElevationModel | EntityKind::Orthomosaic => {
                let record: RasterArtifactRecord = serde_json::from_slice(&bytes)?;
                let suffix = if record.kind == PublishedRasterKind::Dem {
                    "dem"
                } else {
                    "orthomosaik"
                };
                (
                    PathBuf::from(record.summary.cog_path),
                    ProductExportSourceKind::File,
                    format!("{stem}-{suffix}.tif"),
                )
            }
            EntityKind::PointCloud => {
                let (path, dense) =
                    if let Ok(record) = serde_json::from_slice::<MvsArtifactRecord>(&bytes) {
                        let dense = record
                            .output
                            .dense_point_cloud
                            .context("point-cloud record has no dense output")?;
                        (
                            session
                                .working_path
                                .join(record.dataset_relative_path)
                                .join("output")
                                .join(dense.relative_path),
                            true,
                        )
                    } else {
                        let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)?;
                        anyhow::ensure!(
                            record.artifact.kind == ColmapArtifactKind::SparsePointCloud,
                            "point-cloud compute record is not a sparse point cloud"
                        );
                        let relative = record
                            .potree
                            .as_ref()
                            .and_then(|potree| potree.export_relative_path.as_ref())
                            .context("sparse point cloud has no portable export")?;
                        (
                            session
                                .working_path
                                .join(record.dataset_relative_path)
                                .join(relative),
                            false,
                        )
                    };
                let format = requested_format.unwrap_or(if dense {
                    PointCloudExportFormat::Laz
                } else {
                    PointCloudExportFormat::Ply
                });
                if format != PointCloudExportFormat::Ply {
                    anyhow::ensure!(
                        session.manifest.reference_frame.is_none() || crs_wkt.is_some(),
                        "the frozen project CRS could not be resolved to WKT"
                    );
                    conversion = ProductExportConversion::PointCloud { format, crs_wkt };
                }
                (
                    path,
                    ProductExportSourceKind::File,
                    format!("{stem}.{}", format.extension()),
                )
            }
            EntityKind::DepthMap => {
                let record: MvsArtifactRecord = serde_json::from_slice(&bytes)?;
                (
                    session
                        .working_path
                        .join(record.dataset_relative_path)
                        .join("output"),
                    ProductExportSourceKind::Directory,
                    format!("{stem}-tiefenbilder"),
                )
            }
            EntityKind::GaussianSplatCloud => {
                let record: BrushArtifactRecord = serde_json::from_slice(&bytes)?;
                let relative_path = record.prepared_splats.as_ref().and_then(|prepared| {
                    (!prepared.export_relative_path.as_os_str().is_empty())
                        .then_some(prepared.export_relative_path.as_path())
                });
                (
                    session
                        .working_path
                        .join(record.dataset_relative_path)
                        .join(relative_path.unwrap_or(&record.summary.final_output.relative_path)),
                    ProductExportSourceKind::File,
                    format!("{stem}.ply"),
                )
            }
            EntityKind::Mesh | EntityKind::TexturedMesh => {
                match decode_published_mesh_record(&bytes, entity.kind)? {
                    PublishedMeshRecord::Prepared(record) => {
                        if let Some(source_artifact) = record.source_artifact {
                            let source = session
                                .working_path
                                .join(record.dataset_relative_path)
                                .join(source_artifact.relative_path);
                            match source_artifact.kind {
                                ColmapArtifactKind::Mesh => {
                                    (source, ProductExportSourceKind::File, format!("{stem}.ply"))
                                }
                                ColmapArtifactKind::TexturedMesh => (
                                    source,
                                    ProductExportSourceKind::Directory,
                                    format!("{stem}-mesh"),
                                ),
                                _ => unreachable!(
                                    "prepared mesh source kind is validated by the decoder"
                                ),
                            }
                        } else {
                            (
                                session.working_path.join(record.dataset_relative_path),
                                ProductExportSourceKind::Directory,
                                format!("{stem}-mesh"),
                            )
                        }
                    }
                    PublishedMeshRecord::Colmap(record) => {
                        let source = session
                            .working_path
                            .join(record.dataset_relative_path)
                            .join(record.artifact.relative_path);
                        match record.artifact.kind {
                            ColmapArtifactKind::Mesh => {
                                (source, ProductExportSourceKind::File, format!("{stem}.ply"))
                            }
                            ColmapArtifactKind::TexturedMesh => (
                                source,
                                ProductExportSourceKind::Directory,
                                format!("{stem}-mesh"),
                            ),
                            _ => unreachable!("mesh record decoder validates the artifact kind"),
                        }
                    }
                }
            }
            EntityKind::AlignmentRun => {
                let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    record.artifact.kind == ColmapArtifactKind::SparseModel,
                    "alignment export source is not a sparse model"
                );
                let dataset = session.working_path.join(&record.dataset_relative_path);
                let refinement = recorded_intrinsics_refinement(&record)?;
                conversion = ProductExportConversion::Cameras {
                    calibration_groups: camera_export_groups(
                        &record.calibration_groups,
                        refinement,
                    ),
                };
                (
                    dataset.join("sparse-view-source"),
                    ProductExportSourceKind::Directory,
                    format!("{stem}-cameras"),
                )
            }
            EntityKind::MergedAlignmentRun => {
                let record: MergedAlignmentRunRecord = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    record.state == MergedAlignmentState::Published,
                    "alignment merge has not published a camera model"
                );
                let relative = record
                    .dataset_relative_path
                    .clone()
                    .context("published alignment merge has no dataset")?;
                conversion = ProductExportConversion::Cameras {
                    calibration_groups: merged_camera_export_groups(session, &record)?,
                };
                (
                    session
                        .working_path
                        .join(relative)
                        .join("sparse-view-source"),
                    ProductExportSourceKind::Directory,
                    format!("{stem}-cameras"),
                )
            }
            _ => anyhow::bail!("entity is not an exportable PhotoLab product"),
        };
        anyhow::ensure!(
            requested_format.is_none() || entity.kind == EntityKind::PointCloud,
            "an explicit point-cloud format is only valid for point-cloud products"
        );
        let path = path.canonicalize()?;
        anyhow::ensure!(
            path.starts_with(&dataset_root),
            "product export source escaped the project datasets root"
        );
        Ok(ProductExportSource {
            source_path: path,
            kind,
            suggested_name,
            conversion,
        })
    }

    pub fn rename_entity(&self, params: RenameEntityParams) -> Result<OpenPhotolabProjectResult> {
        let name = params.name.trim();
        anyhow::ensure!(!name.is_empty() && name.len() <= 512, "invalid entity name");
        self.mutate_manifest_entity(
            "PhotolabRenameEntity",
            serde_json::json!({ "entityId": params.entity_id, "name": name }),
            &[params.entity_id.clone()],
            |manifest| {
                let entity = manifest
                    .entities
                    .get_mut(&params.entity_id.0)
                    .context("entity does not exist")?;
                entity.name = name.to_owned();
                Ok(())
            },
        )
    }

    pub fn set_entity_visibility(
        &self,
        params: SetEntityVisibilityParams,
    ) -> Result<OpenPhotolabProjectResult> {
        self.mutate_manifest_entity(
            "PhotolabSetEntityVisibility",
            serde_json::json!({ "entityId": params.entity_id, "visible": params.visible }),
            &[params.entity_id.clone()],
            |manifest| {
                let entity = manifest
                    .entities
                    .get_mut(&params.entity_id.0)
                    .context("entity does not exist")?;
                entity.visibility.visible = params.visible;
                Ok(())
            },
        )
    }

    pub fn move_entity(&self, params: MoveEntityParams) -> Result<OpenPhotolabProjectResult> {
        anyhow::ensure!(
            params.entity_id != params.new_parent_id,
            "entity cannot be its own parent"
        );
        self.mutate_manifest_entity(
            "PhotolabMoveEntity",
            serde_json::json!({
                "entityId": params.entity_id,
                "newParentId": params.new_parent_id,
            }),
            &[params.entity_id.clone(), params.new_parent_id.clone()],
            |manifest| {
                anyhow::ensure!(
                    params.entity_id != manifest.root_entity,
                    "project root cannot be moved"
                );
                let new_parent = manifest
                    .entities
                    .get(&params.new_parent_id.0)
                    .context("target parent does not exist")?;
                anyhow::ensure!(
                    matches!(
                        new_parent.kind,
                        EntityKind::ProjectRoot
                            | EntityKind::Group
                            | EntityKind::Survey
                            | EntityKind::ImageCollection
                            | EntityKind::ProcessingSet
                    ),
                    "target entity cannot contain children"
                );
                let mut ancestor = Some(params.new_parent_id.clone());
                while let Some(id) = ancestor {
                    anyhow::ensure!(id != params.entity_id, "entity move would create a cycle");
                    ancestor = manifest
                        .entities
                        .get(&id.0)
                        .and_then(|entity| entity.parent.clone());
                }
                let old_parent = manifest
                    .entities
                    .get(&params.entity_id.0)
                    .context("entity does not exist")?
                    .parent
                    .clone();
                if old_parent.as_ref() == Some(&params.new_parent_id) {
                    return Ok(());
                }
                if let Some(old_parent) = old_parent {
                    let parent = manifest
                        .entities
                        .get_mut(&old_parent.0)
                        .context("old parent does not exist")?;
                    parent.children.retain(|id| id != &params.entity_id);
                }
                manifest
                    .entities
                    .get_mut(&params.entity_id.0)
                    .context("entity disappeared")?
                    .parent = Some(params.new_parent_id.clone());
                let parent = manifest
                    .entities
                    .get_mut(&params.new_parent_id.0)
                    .context("target parent disappeared")?;
                parent.children.push(params.entity_id.clone());
                parent.children.sort_by(|left, right| left.0.cmp(&right.0));
                parent.children.dedup();
                Ok(())
            },
        )
    }

    pub fn remove_camera_images(
        &self,
        params: RemoveCameraImagesParams,
    ) -> Result<OpenPhotolabProjectResult> {
        anyhow::ensure!(
            !params.entity_ids.is_empty(),
            "no camera images were selected"
        );
        let mut ids = params.entity_ids;
        ids.sort_by(|left, right| left.0.cmp(&right.0));
        ids.dedup();

        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let selected = ids
            .iter()
            .map(|id| id.0.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        for id in &ids {
            let entity = session
                .manifest
                .entities
                .get(&id.0)
                .with_context(|| format!("camera image {} does not exist", id.0))?;
            anyhow::ensure!(
                entity.kind == EntityKind::CameraImage,
                "entity is not a camera image"
            );
        }
        let mut discarded_automatic_capture_ids = BTreeSet::new();
        for entity in session
            .manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::CameraCalibrationGroup)
        {
            let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
            let group: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
            if group.automatic
                && group.review_status == CaptureGroupReviewStatus::NeedsReview
                && group
                    .camera_entity_ids
                    .iter()
                    .any(|id| selected.contains(id.0.as_str()))
            {
                discarded_automatic_capture_ids.insert(group.capture_group_id.0);
            }
        }
        let discarded_automatic_entity_ids = discarded_automatic_capture_ids
            .iter()
            .flat_map(|capture_id| {
                session
                    .manifest
                    .entities
                    .get(capture_id)
                    .into_iter()
                    .flat_map(|capture| {
                        std::iter::once(capture.id.0.clone())
                            .chain(capture.children.iter().map(|child| child.0.clone()))
                    })
            })
            .collect::<BTreeSet<_>>();
        for entity in session.manifest.entities.values() {
            if selected.contains(entity.id.0.as_str())
                || entity.kind == EntityKind::ImageCollection
                || discarded_automatic_entity_ids.contains(&entity.id.0)
            {
                continue;
            }
            let path = project_object_path(&session.working_path, &entity.version_hash);
            let Ok(bytes) = fs::read(path) else { continue };
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                continue;
            };
            if ids.iter().any(|id| json_contains_string(&value, &id.0)) {
                anyhow::bail!(
                    "cannot remove selected images because they are referenced by {:?} “{}”; remove the dependent alignment, processing set, group, GCP observation, or product first",
                    entity.kind,
                    entity.name
                );
            }
        }

        let previous_mask_catalog_hash = session.manifest.image_mask_catalog_hash.clone();
        let mut mask_catalog = read_image_mask_catalog(session)?;
        let removed_mask_revisions = mask_catalog
            .revisions
            .iter()
            .filter(|entry| selected.contains(entry.image_entity_id.0.as_str()))
            .map(|entry| entry.revision_sha256.clone())
            .collect::<Vec<_>>();
        mask_catalog
            .revisions
            .retain(|entry| !selected.contains(entry.image_entity_id.0.as_str()));
        let next_mask_catalog_hash = if removed_mask_revisions.is_empty() {
            previous_mask_catalog_hash.clone()
        } else if mask_catalog.revisions.is_empty() {
            None
        } else {
            Some(put_project_object(
                &session.working_path,
                &serde_json::to_vec(&mask_catalog)?,
            )?)
        };

        let now = unix_ms()?;
        let mut candidate = session.manifest.clone();
        candidate.image_mask_catalog_hash = next_mask_catalog_hash.clone();
        let mut before_refs = Vec::with_capacity(ids.len());
        let mut affected_entities = ids.clone();
        for entity_id in &discarded_automatic_entity_ids {
            if let Some(removed) = candidate.entities.remove(entity_id) {
                before_refs.push(removed.version_hash);
                affected_entities.push(removed.id);
            }
        }
        for capture_id in &discarded_automatic_capture_ids {
            if let Some(parent_id) = session
                .manifest
                .entities
                .get(capture_id)
                .and_then(|capture| capture.parent.as_ref())
            {
                if let Some(parent) = candidate.entities.get_mut(&parent_id.0) {
                    parent.children.retain(|child| child.0 != *capture_id);
                }
            }
        }
        for id in &ids {
            let removed = candidate
                .entities
                .remove(&id.0)
                .context("camera image disappeared during removal")?;
            before_refs.push(removed.version_hash);
            if let Some(parent_id) = removed.parent {
                if !affected_entities.contains(&parent_id) {
                    affected_entities.push(parent_id.clone());
                }
                let parent = candidate
                    .entities
                    .get_mut(&parent_id.0)
                    .context("camera image parent does not exist")?;
                parent.children.retain(|child| child != id);
                if parent.kind == EntityKind::ImageCollection {
                    parent.name = format!("Images · {}", parent.children.len());
                }
            }
        }
        before_refs.extend(previous_mask_catalog_hash);
        before_refs.extend(removed_mask_revisions);
        if !candidate
            .entities
            .values()
            .any(|entity| entity.kind == EntityKind::CameraImage)
            && !candidate.entities.values().any(|entity| {
                matches!(
                    entity.kind,
                    EntityKind::GroundControlPoint
                        | EntityKind::AlignmentRun
                        | EntityKind::MergedAlignmentRun
                        | EntityKind::DepthMap
                        | EntityKind::Orthomosaic
                        | EntityKind::DigitalElevationModel
                        | EntityKind::PointCloud
                        | EntityKind::Mesh
                        | EntityKind::TexturedMesh
                        | EntityKind::GaussianSplatCloud
                )
            })
        {
            candidate.reference_frame = None;
            candidate.spatial_reference =
                himmelcad_core::photolab_capture::PhotolabSpatialReference::default();
            candidate.render_offset = Default::default();
        }
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = now;
        candidate.clean_shutdown = false;
        let after_refs = next_mask_catalog_hash.into_iter().collect();
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: unique_id("remove-camera-images", now),
            command_kind: "PhotolabRemoveCameraImages".to_owned(),
            timestamp_unix_ms: now,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({ "entityIds": ids }),
            affected_entities,
            before_refs,
            after_refs,
            message: Some("Camera images removed from project".to_owned()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        Ok(session.result())
    }

    fn mutate_manifest_entity(
        &self,
        command_kind: &str,
        payload: serde_json::Value,
        affected_entities: &[EntityId],
        mutation: impl FnOnce(&mut PhotolabProjectManifest) -> Result<()>,
    ) -> Result<OpenPhotolabProjectResult> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let mut candidate = session.manifest.clone();
        mutation(&mut candidate)?;
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: unique_id("entity-command", candidate.modified_unix_ms),
            command_kind: command_kind.to_owned(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload,
            affected_entities: affected_entities.to_vec(),
            before_refs: Vec::new(),
            after_refs: Vec::new(),
            message: None,
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        Ok(session.result())
    }

    pub fn publish_colmap_outcome_for_processing_set(
        &self,
        outcome: ColmapRunOutcome,
        processing_set_id: Option<EntityId>,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(&outcome.summary.job_id)?;
        anyhow::ensure!(
            !outcome
                .summary
                .artifacts
                .iter()
                .any(|artifact| artifact.kind == ColmapArtifactKind::SparsePointCloud)
                || outcome.sparse_potree.is_some(),
            "sparse point-cloud artifact has no prepared Potree hierarchy"
        );
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let camera_scope =
            validate_camera_scope(&session.manifest, &outcome.summary.camera_entity_ids)?;
        if let Some(entity_id) = processing_set_id.as_ref() {
            let processing_set = read_processing_set(session, entity_id)?;
            anyhow::ensure!(
                validate_processing_set_record(&session.manifest, &processing_set)? == camera_scope,
                "alignment camera scope differs from its immutable processing set"
            );
        }
        let products_group =
            unique_entity_of_kind(&session.manifest, EntityKind::Group, "products")?;
        let dataset_relative_path = format!("datasets/colmap/{}", outcome.summary.job_id);
        let dataset_path = session.working_path.join(&dataset_relative_path);
        if dataset_path.exists() {
            anyhow::bail!("compute dataset already exists: {}", outcome.summary.job_id);
        }
        fs::create_dir_all(
            dataset_path
                .parent()
                .context("compute dataset path has no parent")?,
        )?;
        // COLMAP/glog may leave host-named log symlinks in its isolated tmp
        // directory. They are transient diagnostics, not product data, and
        // must never enter an immutable alignment dataset consumed by later
        // security-audited runtimes.
        for transient in ["tmp", "home", "cache"] {
            let path = outcome.scratch_path.join(transient);
            if path.exists() {
                fs::remove_dir_all(path)?;
            }
        }
        fs::rename(&outcome.scratch_path, &dataset_path).with_context(|| {
            format!(
                "failed to atomically publish compute dataset {}",
                dataset_path.display()
            )
        })?;

        let mut candidate = session.manifest.clone();
        let mut entity_ids = Vec::new();
        let project_id = candidate.project_id.clone();
        let job_id = outcome.summary.job_id.clone();
        let entity_id_for =
            |index: usize| EntityId(format!("{project_id}:compute:{job_id}:{index}"));
        let alignment_entity_id = outcome
            .summary
            .artifacts
            .iter()
            .position(|artifact| artifact.kind == ColmapArtifactKind::SparseModel)
            .map(entity_id_for)
            .context("COLMAP outcome has no sparse alignment artifact")?;
        let sparse_cloud_entity_id = outcome
            .summary
            .artifacts
            .iter()
            .position(|artifact| artifact.kind == ColmapArtifactKind::SparsePointCloud)
            .map(entity_id_for);
        let mut top_level_entity_ids = Vec::new();
        let mut after_refs = Vec::new();
        for (index, artifact) in outcome.summary.artifacts.iter().enumerate() {
            let Some((kind, label)) = artifact_entity(artifact.kind) else {
                continue;
            };
            let record = ComputeArtifactRecord {
                schema_version: 3,
                job_id: outcome.summary.job_id.clone(),
                dataset_relative_path: dataset_relative_path.clone(),
                artifact: artifact.clone(),
                camera_entity_ids: camera_scope.clone(),
                image_mask_scope_sha256: outcome.summary.image_mask_scope_sha256.clone(),
                calibration_groups: outcome.summary.calibration_groups.clone(),
                intrinsics_refinement: outcome.summary.intrinsics_refinement,
                processing_set_id: processing_set_id.clone(),
                publication_sequence: session.manifest.command_sequence.saturating_add(1),
                selected_mapper: outcome.summary.selected_mapper,
                tool_manifest_sha256: outcome.summary.tool_manifest_sha256.clone(),
                parent_alignment_entity_id: (artifact.kind == ColmapArtifactKind::SparsePointCloud)
                    .then_some(alignment_entity_id.clone()),
                potree: (artifact.kind == ColmapArtifactKind::SparsePointCloud)
                    .then(|| outcome.sparse_potree.clone())
                    .flatten(),
            };
            let prepared = match artifact.kind {
                ColmapArtifactKind::Mesh => {
                    outcome.prepared_mesh.as_ref().map(|value| (value, false))
                }
                ColmapArtifactKind::TexturedMesh => outcome
                    .prepared_textured_mesh
                    .as_ref()
                    .map(|value| (value, true)),
                _ => None,
            };
            let entity_id = entity_id_for(index);
            let bytes = if matches!(
                artifact.kind,
                ColmapArtifactKind::Mesh | ColmapArtifactKind::TexturedMesh
            ) {
                if let Some((prepared, textured)) = prepared {
                    serde_json::to_vec(&MeshArtifactRecord {
                        schema_version: 4,
                        job_id: outcome.summary.job_id.clone(),
                        dataset_relative_path: dataset_relative_path.clone(),
                        textured,
                        prepared: prepared.clone(),
                        canonical_dataset: Some(package_prepared_mesh_dataset(
                            &dataset_path,
                            prepared,
                            &entity_id,
                        )?),
                        source_artifact: Some(artifact.clone()),
                        source_alignment_entity_id: Some(alignment_entity_id.clone()),
                        processing_set_id: processing_set_id.clone(),
                        gcp_optimization_entity_id: None,
                        gcp_optimization_snapshot_sha256: None,
                        image_mask_scope_sha256: outcome.summary.image_mask_scope_sha256.clone(),
                    })?
                } else {
                    serde_json::to_vec(&record)?
                }
            } else {
                serde_json::to_vec(&record)?
            };
            let version_hash = put_project_object(&session.working_path, &bytes)?;
            let parent = if artifact.kind == ColmapArtifactKind::SparsePointCloud {
                alignment_entity_id.clone()
            } else {
                top_level_entity_ids.push(entity_id.clone());
                products_group.clone()
            };
            let children = if artifact.kind == ColmapArtifactKind::SparseModel {
                sparse_cloud_entity_id.iter().cloned().collect()
            } else {
                Vec::new()
            };
            candidate.entities.insert(
                entity_id.0.clone(),
                EntitySnapshot {
                    id: entity_id.clone(),
                    kind,
                    name: format!("{label} · {}", outcome.summary.job_id),
                    parent: Some(parent),
                    children,
                    visibility: VisibilityState::default(),
                    version_hash: version_hash.clone(),
                    bounds: None,
                },
            );
            after_refs.push(version_hash);
            entity_ids.push(entity_id);
        }
        if entity_ids.is_empty() {
            anyhow::bail!("COLMAP outcome contains no publishable artifact");
        }
        let has_alignment = outcome
            .summary
            .artifacts
            .iter()
            .any(|artifact| artifact.kind == ColmapArtifactKind::SparseModel);
        let has_depth = outcome
            .summary
            .artifacts
            .iter()
            .any(|artifact| artifact.kind == ColmapArtifactKind::DepthMaps);
        update_camera_product_tags(
            &session.working_path,
            &mut candidate,
            &camera_scope,
            has_alignment,
            has_depth,
            &mut after_refs,
        )?;
        let group = candidate
            .entities
            .get_mut(&products_group.0)
            .context("products group disappeared during compute publication")?;
        group.children.extend(top_level_entity_ids);
        group.children.sort_by(|left, right| left.0.cmp(&right.0));
        group.children.dedup();
        group.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&group.children)?);
        after_refs.push(group.version_hash.clone());

        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let mut affected_entities = entity_ids.clone();
        if has_alignment || has_depth {
            affected_entities.extend(camera_scope.iter().cloned().map(EntityId));
        }
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("compute-publish-{}", outcome.summary.job_id),
            command_kind: "PhotolabPublishColmapOutcome".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "jobId": outcome.summary.job_id,
                "datasetRelativePath": dataset_relative_path,
                "summarySha256": outcome.summary_sha256,
                "processingSetId": processing_set_id,
                "calibrationGroups": outcome.summary.calibration_groups,
            }),
            affected_entities,
            before_refs: Vec::new(),
            after_refs,
            message: Some("COLMAP artifacts validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(
            &session.working_path,
            &outcome.summary.job_id,
            PhotolabJobKind::AlignPhotos,
        );
        Ok(PublishColmapResult {
            job_id: outcome.summary.job_id,
            entity_ids,
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn publish_brush_outcome(
        &self,
        outcome: BrushRunOutcome,
        lineage: &ProductLineage,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(&outcome.summary.job_id)?;
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        validate_product_lineage(session, lineage, None)?;
        let products_group =
            unique_entity_of_kind(&session.manifest, EntityKind::Group, "products")?;
        let dataset_relative_path = format!("datasets/splats/{}", outcome.summary.job_id);
        let dataset_path = session.working_path.join(&dataset_relative_path);
        if dataset_path.exists() {
            anyhow::bail!("splat dataset already exists: {}", outcome.summary.job_id);
        }
        fs::create_dir_all(
            dataset_path
                .parent()
                .context("splat dataset path has no parent")?,
        )?;
        fs::rename(&outcome.scratch_path, &dataset_path).with_context(|| {
            format!(
                "failed to atomically publish Brush dataset {}",
                dataset_path.display()
            )
        })?;

        let record = BrushArtifactRecord {
            schema_version: 3,
            job_id: outcome.summary.job_id.clone(),
            dataset_relative_path: dataset_relative_path.clone(),
            summary_sha256: outcome.summary_sha256.clone(),
            summary: outcome.summary.clone(),
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            gcp_optimization_entity_id: lineage.gcp_optimization_entity_id.clone(),
            gcp_optimization_snapshot_sha256: lineage.gcp_optimization_snapshot_sha256.clone(),
            image_mask_scope_sha256: Some(lineage.image_mask_scope_sha256.clone()),
            prepared_splats: outcome.prepared_splats,
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        let entity_id = EntityId(format!(
            "{}:splat:{}",
            candidate.project_id, outcome.summary.job_id
        ));
        candidate.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::GaussianSplatCloud,
                name: format!("Gaussian Splat · {}", outcome.summary.job_id),
                parent: Some(products_group.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        let group = candidate
            .entities
            .get_mut(&products_group.0)
            .context("products group disappeared during splat publication")?;
        group.children.push(entity_id.clone());
        group.children.sort_by(|left, right| left.0.cmp(&right.0));
        group.children.dedup();
        group.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&group.children)?);
        let group_hash = group.version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("splat-publish-{}", outcome.summary.job_id),
            command_kind: "PhotolabPublishBrushOutcome".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "jobId": outcome.summary.job_id,
                "datasetRelativePath": dataset_relative_path,
                "summarySha256": outcome.summary_sha256,
                "sourceAlignmentEntityId": record.source_alignment_entity_id,
                "processingSetId": record.processing_set_id,
                "gcpOptimizationEntityId": record.gcp_optimization_entity_id,
                "gcpOptimizationSnapshotSha256": record.gcp_optimization_snapshot_sha256,
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("Brush output validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(
            &session.working_path,
            &outcome.summary.job_id,
            PhotolabJobKind::BuildGaussianSplat,
        );
        Ok(PublishColmapResult {
            job_id: outcome.summary.job_id,
            entity_ids: vec![entity_id],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn publish_mvs_outcome(
        &self,
        outcome: MvsRunOutcome,
        camera_entity_ids: &[String],
        image_mask_scope_sha256: &ObjectHash,
        lineage: &ProductLineage,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(&outcome.output.job_id)?;
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let camera_scope = validate_camera_scope(&session.manifest, camera_entity_ids)?;
        validate_product_lineage(session, lineage, Some(&camera_scope))?;
        anyhow::ensure!(
            image_mask_scope_sha256 == &lineage.image_mask_scope_sha256,
            "MVS publication mask scope differs from product lineage"
        );
        let products_group =
            unique_entity_of_kind(&session.manifest, EntityKind::Group, "products")?;
        let dataset_relative_path = format!("datasets/mvs/{}", outcome.output.job_id);
        let dataset_path = session.working_path.join(&dataset_relative_path);
        anyhow::ensure!(!dataset_path.exists(), "MVS dataset already exists");
        fs::create_dir_all(
            dataset_path
                .parent()
                .context("MVS dataset path has no parent")?,
        )?;
        fs::rename(&outcome.scratch_path, &dataset_path).with_context(|| {
            format!(
                "failed to atomically publish MVS dataset {}",
                dataset_path.display()
            )
        })?;
        let record = MvsArtifactRecord {
            schema_version: 3,
            job_id: outcome.output.job_id.clone(),
            dataset_relative_path: dataset_relative_path.clone(),
            output_index_sha256: outcome.output_index_sha256,
            output: outcome.output.clone(),
            command: outcome.command,
            camera_entity_ids: camera_scope,
            image_mask_scope_sha256: Some(image_mask_scope_sha256.clone()),
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            gcp_optimization_entity_id: lineage.gcp_optimization_entity_id.clone(),
            gcp_optimization_snapshot_sha256: lineage.gcp_optimization_snapshot_sha256.clone(),
            potree: outcome.potree,
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        let mut entity_ids = Vec::new();
        let depth_id = EntityId(format!("{}:depth:{}", candidate.project_id, record.job_id));
        candidate.entities.insert(
            depth_id.0.clone(),
            EntitySnapshot {
                id: depth_id.clone(),
                kind: EntityKind::DepthMap,
                name: format!("Depth Maps · {}", record.job_id),
                parent: Some(products_group.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        entity_ids.push(depth_id);
        if record.output.dense_point_cloud.is_some() {
            let dense_id = EntityId(format!("{}:dense:{}", candidate.project_id, record.job_id));
            candidate.entities.insert(
                dense_id.0.clone(),
                EntitySnapshot {
                    id: dense_id.clone(),
                    kind: EntityKind::PointCloud,
                    name: format!("Dense Point Cloud · {}", record.job_id),
                    parent: Some(products_group.clone()),
                    children: Vec::new(),
                    visibility: VisibilityState::default(),
                    version_hash: version_hash.clone(),
                    bounds: None,
                },
            );
            entity_ids.push(dense_id);
        }
        let mut after_refs = vec![version_hash.clone()];
        update_camera_product_tags(
            &session.working_path,
            &mut candidate,
            &record.camera_entity_ids,
            false,
            true,
            &mut after_refs,
        )?;
        let group = candidate
            .entities
            .get_mut(&products_group.0)
            .context("products group disappeared during MVS publication")?;
        group.children.extend(entity_ids.iter().cloned());
        group.children.sort_by(|left, right| left.0.cmp(&right.0));
        group.children.dedup();
        group.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&group.children)?);
        let group_hash = group.version_hash.clone();
        after_refs.push(group_hash);
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let mut affected_entities = entity_ids.clone();
        affected_entities.extend(record.camera_entity_ids.iter().cloned().map(EntityId));
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("mvs-publish-{}", record.job_id),
            command_kind: "PhotolabPublishMvsOutcome".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "jobId": record.job_id,
                "datasetRelativePath": dataset_relative_path,
                "outputIndexSha256": record.output_index_sha256,
                "sourceAlignmentEntityId": record.source_alignment_entity_id,
                "processingSetId": record.processing_set_id,
                "gcpOptimizationEntityId": record.gcp_optimization_entity_id,
                "gcpOptimizationSnapshotSha256": record.gcp_optimization_snapshot_sha256,
            }),
            affected_entities,
            before_refs: Vec::new(),
            after_refs,
            message: Some("Portable MVS output validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(
            &session.working_path,
            &record.job_id,
            if record.output.dense_point_cloud.is_some() {
                PhotolabJobKind::BuildDensePointCloud
            } else {
                PhotolabJobKind::BuildDepthMaps
            },
        );
        Ok(PublishColmapResult {
            job_id: record.job_id,
            entity_ids,
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn publish_gcp_optimization(
        &self,
        outcome: RunGcpOptimizationResult,
        lineage: &ProductLineage,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(&outcome.operation_id)?;
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        validate_product_lineage(session, lineage, None)?;
        let products_group =
            unique_entity_of_kind(&session.manifest, EntityKind::Group, "products")?;
        let record = GcpOptimizationPublicationRecord {
            schema_version: 3,
            operation_id: outcome.operation_id.clone(),
            input_sha256: outcome.input_sha256,
            artifact_sha256: outcome.artifact_sha256,
            snapshot_sha256: outcome.artifact.snapshot_sha256.clone(),
            artifact: outcome.artifact,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            publication_sequence: session.manifest.command_sequence.saturating_add(1),
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        let entity_id = EntityId(format!(
            "{}:alignment-gcp:{}",
            candidate.project_id, record.operation_id
        ));
        candidate.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::AlignmentRun,
                name: format!("GCP-optimized Alignment · {}", record.operation_id),
                parent: Some(products_group.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        let group = candidate
            .entities
            .get_mut(&products_group.0)
            .context("products group disappeared during GCP publication")?;
        group.children.push(entity_id.clone());
        group.children.sort_by(|left, right| left.0.cmp(&right.0));
        group.children.dedup();
        group.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&group.children)?);
        let group_hash = group.version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("gcp-optimize-{}", record.operation_id),
            command_kind: "PhotolabPublishGcpOptimization".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "operationId": record.operation_id,
                "snapshotSha256": record.snapshot_sha256,
                "artifactSha256": record.artifact_sha256,
                "publicationSequence": record.publication_sequence,
                "sourceAlignmentEntityId": record.source_alignment_entity_id,
                "processingSetId": record.processing_set_id,
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("GCP optimization validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        Ok(PublishColmapResult {
            job_id: record.operation_id,
            entity_ids: vec![entity_id],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn publish_raster_summary(
        &self,
        job_id: &str,
        kind: PublishedRasterKind,
        summary: RasterBuildSummary,
        lineage: &ProductLineage,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(job_id)?;
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        validate_product_lineage(session, lineage, None)?;
        let project_root = session.working_path.canonicalize()?;
        let output = PathBuf::from(&summary.output_directory).canonicalize()?;
        anyhow::ensure!(
            output.starts_with(project_root.join("datasets")),
            "raster output is outside the project datasets root"
        );
        let dataset_relative_path = path_string(output.strip_prefix(&project_root)?);
        let products_group =
            unique_entity_of_kind(&session.manifest, EntityKind::Group, "products")?;
        let record = RasterArtifactRecord {
            schema_version: 3,
            job_id: job_id.to_owned(),
            kind,
            dataset_relative_path: dataset_relative_path.clone(),
            summary,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            gcp_optimization_entity_id: lineage.gcp_optimization_entity_id.clone(),
            gcp_optimization_snapshot_sha256: lineage.gcp_optimization_snapshot_sha256.clone(),
            image_mask_scope_sha256: Some(lineage.image_mask_scope_sha256.clone()),
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        let (entity_kind, label) = match kind {
            PublishedRasterKind::Dem => (EntityKind::DigitalElevationModel, "DEM"),
            PublishedRasterKind::Orthomosaic => (EntityKind::Orthomosaic, "Orthomosaic"),
        };
        let entity_id = EntityId(format!("{}:raster:{job_id}", candidate.project_id));
        candidate.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: entity_kind,
                name: format!("{label} · {job_id}"),
                parent: Some(products_group.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        let group = candidate
            .entities
            .get_mut(&products_group.0)
            .context("products group disappeared during raster publication")?;
        group.children.push(entity_id.clone());
        group.children.sort_by(|left, right| left.0.cmp(&right.0));
        group.children.dedup();
        group.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&group.children)?);
        let group_hash = group.version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("raster-publish-{job_id}"),
            command_kind: "PhotolabPublishRasterOutcome".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "jobId": job_id,
                "kind": kind,
                "datasetRelativePath": dataset_relative_path,
                "sourceAlignmentEntityId": record.source_alignment_entity_id,
                "processingSetId": record.processing_set_id,
                "gcpOptimizationEntityId": record.gcp_optimization_entity_id,
                "gcpOptimizationSnapshotSha256": record.gcp_optimization_snapshot_sha256,
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("GDAL raster validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(
            &session.working_path,
            job_id,
            match kind {
                PublishedRasterKind::Dem => PhotolabJobKind::BuildDem,
                PublishedRasterKind::Orthomosaic => PhotolabJobKind::BuildOrthomosaic,
            },
        );
        Ok(PublishColmapResult {
            job_id: job_id.to_owned(),
            entity_ids: vec![entity_id],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn publish_mesh_product(
        &self,
        job_id: &str,
        staging_path: &Path,
        prepared: PreparedMeshProduct,
        textured: bool,
        lineage: &ProductLineage,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(job_id)?;
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        validate_product_lineage(session, lineage, None)?;
        let products_group =
            unique_entity_of_kind(&session.manifest, EntityKind::Group, "products")?;
        let relative = format!("datasets/mesh/{job_id}");
        let destination = session.working_path.join(&relative);
        anyhow::ensure!(!destination.exists(), "mesh dataset already exists");
        fs::create_dir_all(
            destination
                .parent()
                .context("mesh destination has no parent")?,
        )?;
        let entity_id = EntityId(format!("{}:mesh:{job_id}", session.manifest.project_id));
        let canonical_dataset = package_prepared_mesh_dataset(staging_path, &prepared, &entity_id)?;
        fs::rename(staging_path, &destination)?;
        let record = MeshArtifactRecord {
            schema_version: 3,
            job_id: job_id.into(),
            dataset_relative_path: relative,
            textured,
            prepared,
            canonical_dataset: Some(canonical_dataset),
            source_artifact: None,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            gcp_optimization_entity_id: lineage.gcp_optimization_entity_id.clone(),
            gcp_optimization_snapshot_sha256: lineage.gcp_optimization_snapshot_sha256.clone(),
            image_mask_scope_sha256: Some(lineage.image_mask_scope_sha256.clone()),
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        candidate.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: if textured {
                    EntityKind::TexturedMesh
                } else {
                    EntityKind::Mesh
                },
                name: format!(
                    "{} · {job_id}",
                    if textured { "Textured Mesh" } else { "Mesh" }
                ),
                parent: Some(products_group.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: version_hash.clone(),
                bounds: None,
            },
        );
        let group = candidate
            .entities
            .get_mut(&products_group.0)
            .context("products group disappeared")?;
        group.children.push(entity_id.clone());
        group.children.sort_by(|a, b| a.0.cmp(&b.0));
        group.children.dedup();
        group.version_hash = ObjectHash::of_bytes(&serde_json::to_vec(&group.children)?);
        let group_hash = group.version_hash.clone();
        candidate.command_sequence = candidate.command_sequence.saturating_add(1);
        candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
        candidate.modified_unix_ms = unix_ms()?;
        candidate.clean_shutdown = false;
        let journal = PhotolabJournalEntry {
            sequence: candidate.command_sequence,
            command_id: format!("mesh-publish-{job_id}"),
            command_kind: "PhotolabPublishTiledMesh".into(),
            timestamp_unix_ms: candidate.modified_unix_ms,
            state: JournalCommandState::Committed,
            payload: serde_json::json!({
                "jobId": job_id,
                "datasetRelativePath": record.dataset_relative_path,
                "triangleCount": record.prepared.triangle_count,
                "sourceAlignmentEntityId": record.source_alignment_entity_id,
                "processingSetId": record.processing_set_id,
                "gcpOptimizationEntityId": record.gcp_optimization_entity_id,
                "gcpOptimizationSnapshotSha256": record.gcp_optimization_snapshot_sha256,
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("Tiled mesh atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        cleanup_published_job_scratch(&session.working_path, job_id, PhotolabJobKind::BuildMesh);
        Ok(PublishColmapResult {
            job_id: job_id.into(),
            entity_ids: vec![entity_id],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn commit_images(&self, params: CommitImagesParams) -> Result<CommitImagesResult> {
        self.commit_images_with_progress(params, |_, _| {})
    }

    pub fn commit_images_with_progress<P>(
        &self,
        params: CommitImagesParams,
        progress: P,
    ) -> Result<CommitImagesResult>
    where
        P: FnMut(f64, &str),
    {
        anyhow::ensure!(
            !self.draining_side_operations.load(Ordering::Acquire),
            "image commits are unavailable while the project is draining"
        );
        let operation_id = params.operation_id.clone();
        let cancellation = CancellationToken::new();
        {
            let mut active = self
                .active_image_commits
                .lock()
                .expect("image commit mutex poisoned");
            anyhow::ensure!(
                !self.draining_side_operations.load(Ordering::Acquire),
                "image commits are unavailable while the project is draining"
            );
            if active.contains_key(&operation_id) {
                anyhow::bail!("image commit operation id is already active: {operation_id}");
            }
            active.insert(operation_id.clone(), cancellation.clone());
        }
        let result = (|| {
            let mut guard = self.session.lock().expect("project session mutex poisoned");
            let session = guard.as_mut().context("no project is open")?;
            ensure_writable(session)?;
            let mut result = commit_images_transaction_with_progress(
                &session.working_path,
                &mut session.manifest,
                params,
                &cancellation,
                progress,
            )
            .map_err(anyhow::Error::from)?;
            let imported_camera_ids = result
                .images
                .iter()
                .filter(|image| !image.duplicate)
                .map(|image| image.entity_id.clone())
                .collect::<Vec<_>>();
            match automatic_capture_groups_for_import(session, &imported_camera_ids)
                .and_then(|groups| Self::persist_automatic_capture_groups(session, groups))
            {
                Ok(()) => {}
                Err(error) => tracing::warn!(
                    %error,
                    "images were imported, but automatic calibration grouping could not be persisted"
                ),
            }
            result.autosave_generation = session.manifest.autosave_generation;
            result.journal_sequence = session.manifest.command_sequence;
            Ok(result)
        })();
        self.active_image_commits
            .lock()
            .expect("image commit mutex poisoned")
            .remove(&operation_id);
        result
    }

    pub fn cancel_image_commit(&self, params: CancelImageCommitParams) -> CancelImageCommitResult {
        let active = self
            .active_image_commits
            .lock()
            .expect("image commit mutex poisoned");
        let cancellation_requested = active
            .get(&params.operation_id)
            .is_some_and(CancellationToken::request_cancel);
        CancelImageCommitResult {
            operation_id: params.operation_id,
            cancellation_requested,
        }
    }

    pub fn list_gcps(&self) -> Result<Option<(ObjectHash, GcpCollectionRecord)>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        read_gcp_collection(&session.working_path, &session.manifest).map_err(anyhow::Error::from)
    }

    /// Computes derived point feedback without journalling or publishing an alignment.
    pub fn compute_gcp_local_estimate(
        &self,
        params: ComputeGcpLocalEstimateParams,
    ) -> Result<GcpLocalEstimateArtifact> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let (collection_sha256, collection) =
            read_gcp_collection(&session.working_path, &session.manifest)?
                .context("project has no GCP collection")?;
        compute_gcp_local_estimate(
            &session.working_path,
            &collection_sha256,
            &collection,
            params,
        )
        .map_err(anyhow::Error::from)
    }

    /// Reads only an estimate valid for the current collection and supplied cameras.
    pub fn read_gcp_local_estimate(
        &self,
        params: ReadGcpLocalEstimateParams,
    ) -> Result<Option<GcpLocalEstimateArtifact>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let Some((collection_sha256, _)) =
            read_gcp_collection(&session.working_path, &session.manifest)?
        else {
            return Ok(None);
        };
        read_gcp_local_estimate(
            &session.working_path,
            &collection_sha256,
            &params.point_id,
            &params.cameras,
        )
        .map_err(anyhow::Error::from)
    }

    pub fn commit_gcps(&self, params: CommitGcpsParams) -> Result<CommitGcpsResult> {
        let operation_id = params.operation_id.clone();
        self.run_gcp_operation(&operation_id, |session, cancellation| {
            commit_gcps_transaction(
                &session.working_path,
                &mut session.manifest,
                params,
                cancellation,
            )
            .map_err(anyhow::Error::from)
        })
    }

    pub fn upsert_gcp_observation(
        &self,
        params: UpsertGcpObservationParams,
    ) -> Result<UpsertGcpObservationResult> {
        let operation_id = params.operation_id.clone();
        self.run_gcp_operation(&operation_id, |session, cancellation| {
            upsert_gcp_observation_transaction(
                &session.working_path,
                &mut session.manifest,
                params,
                cancellation,
            )
            .map_err(anyhow::Error::from)
        })
    }

    pub fn edit_gcp_observation(
        &self,
        params: EditGcpObservationParams,
    ) -> Result<EditGcpObservationResult> {
        let operation_id = params.operation_id.clone();
        self.run_gcp_operation(&operation_id, |session, cancellation| {
            edit_gcp_observation_transaction(
                &session.working_path,
                &mut session.manifest,
                params,
                cancellation,
            )
            .map_err(anyhow::Error::from)
        })
    }

    pub fn upsert_gcp_observations(
        &self,
        params: UpsertGcpObservationsParams,
    ) -> Result<UpsertGcpObservationsResult> {
        let operation_id = params.operation_id.clone();
        self.run_gcp_operation(&operation_id, |session, cancellation| {
            upsert_gcp_observations_transaction(
                &session.working_path,
                &mut session.manifest,
                params,
                cancellation,
            )
            .map_err(anyhow::Error::from)
        })
    }

    pub fn create_gcp_optimization_snapshot(
        &self,
        params: CreateGcpOptimizationSnapshotParams,
    ) -> Result<CreateGcpOptimizationSnapshotResult> {
        let operation_id = params.operation_id.clone();
        self.run_gcp_operation(&operation_id, |session, cancellation| {
            create_gcp_optimization_snapshot_transaction(
                &session.working_path,
                &mut session.manifest,
                params,
                cancellation,
            )
            .map_err(anyhow::Error::from)
        })
    }

    pub fn cancel_gcp_operation(
        &self,
        params: CancelGcpOperationParams,
    ) -> CancelGcpOperationResult {
        let active = self
            .active_gcp_operations
            .lock()
            .expect("GCP operation mutex poisoned");
        let cancellation_requested = active
            .get(&params.operation_id)
            .is_some_and(CancellationToken::request_cancel);
        CancelGcpOperationResult {
            operation_id: params.operation_id,
            cancellation_requested,
        }
    }

    fn run_gcp_operation<T>(
        &self,
        operation_id: &str,
        operation: impl FnOnce(&mut ProjectSession, &CancellationToken) -> Result<T>,
    ) -> Result<T> {
        let cancellation = CancellationToken::new();
        {
            let mut active = self
                .active_gcp_operations
                .lock()
                .expect("GCP operation mutex poisoned");
            if active.contains_key(operation_id) {
                anyhow::bail!("GCP operation id is already active: {operation_id}");
            }
            active.insert(operation_id.to_owned(), cancellation.clone());
        }
        let result = (|| {
            let mut guard = self.session.lock().expect("project session mutex poisoned");
            let session = guard.as_mut().context("no project is open")?;
            ensure_writable(session)?;
            operation(session, &cancellation)
        })();
        self.active_gcp_operations
            .lock()
            .expect("GCP operation mutex poisoned")
            .remove(operation_id);
        result
    }

    pub fn append_journal(&self, params: AppendJournalParams) -> Result<PhotolabJournalEntry> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let sequence = session.manifest.command_sequence.saturating_add(1);
        let entry = PhotolabJournalEntry {
            sequence,
            command_id: unique_id("command", unix_ms()?),
            command_kind: params.command_kind,
            timestamp_unix_ms: unix_ms()?,
            state: JournalCommandState::Started,
            payload: params.payload,
            affected_entities: params.affected_entities,
            before_refs: params.before_refs,
            after_refs: params.after_refs,
            message: params.message,
        };
        write_journal_entry(&session.working_path, &entry)?;
        session.manifest.command_sequence = sequence;
        touch_and_autosave(session)?;
        Ok(entry)
    }

    pub fn finish_journal(&self, params: FinishJournalParams) -> Result<PhotolabJournalEntry> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let sequence = session.manifest.command_sequence.saturating_add(1);
        let entry = PhotolabJournalEntry {
            sequence,
            command_id: params.command_id,
            command_kind: "CommandResult".to_owned(),
            timestamp_unix_ms: unix_ms()?,
            state: params.state,
            payload: serde_json::Value::Null,
            affected_entities: params.affected_entities,
            before_refs: Vec::new(),
            after_refs: params.after_refs,
            message: params.message,
        };
        write_journal_entry(&session.working_path, &entry)?;
        session.manifest.command_sequence = sequence;
        touch_and_autosave(session)?;
        Ok(entry)
    }

    pub fn autosave(&self) -> Result<AutosaveResult> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        session.manifest.modified_unix_ms = unix_ms()?;
        atomic_write_json(
            &session.working_path.join("manifest.json"),
            &session.manifest,
        )?;
        heartbeat_session_lease(session, session.working_path == session.source_path)?;
        Ok(AutosaveResult {
            autosave_generation: session.manifest.autosave_generation,
            last_saved_generation: session.last_saved_generation,
            dirty: session.manifest.autosave_generation != session.last_saved_generation,
        })
    }

    pub fn save(&self) -> Result<SaveResult> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        ensure_source_unchanged(session)?;
        atomic_write_json(
            &session.working_path.join("manifest.json"),
            &session.manifest,
        )?;
        if is_hcadx_path(&session.source_path) {
            let destination = session.source_path.clone();
            save_archive_session(session, &destination, true, false, None, None)?;
        } else if session.uses_local_working_copy {
            copy_project_incremental(&session.working_path, &session.source_path)?;
            let mut saved_manifest = session.manifest.clone();
            saved_manifest.clean_shutdown = true;
            atomic_write_json(&session.source_path.join("manifest.json"), &saved_manifest)?;
        }
        session.last_saved_generation = session.manifest.autosave_generation;
        heartbeat_session_lease(session, true)?;
        Ok(SaveResult {
            saved_generation: session.last_saved_generation,
            source_path: path_string(&session.source_path),
        })
    }

    pub fn save_as(&self, params: &SaveProjectAsParams) -> Result<SaveResult> {
        let destination = canonicalize_archive_destination(Path::new(&params.path))?;
        let same_source = {
            let guard = self.session.lock().expect("project session mutex poisoned");
            let session = guard.as_ref().context("no project is open")?;
            session.source_path == destination
        };
        if same_source {
            let (operation_id, cancellation) =
                self.begin_archive_operation(params.archive_operation_id.as_deref())?;
            let result = (|| -> Result<SaveResult> {
                let mut guard = self.session.lock().expect("project session mutex poisoned");
                let session = guard.as_mut().context("no project is open")?;
                ensure_writable(session)?;
                ensure_source_unchanged(session)?;
                save_archive_session(
                    session,
                    &destination,
                    true,
                    params.include_rebuildable_index,
                    Some((&operation_id, &cancellation)),
                    params.progress_key.as_deref(),
                )?;
                session.last_saved_generation = session.manifest.autosave_generation;
                heartbeat_session_lease(session, true)?;
                Ok(SaveResult {
                    saved_generation: session.last_saved_generation,
                    source_path: path_string(&session.source_path),
                })
            })();
            self.finish_archive_operation(&operation_id);
            return result;
        }

        let (operation_id, cancellation) =
            self.begin_archive_operation(params.archive_operation_id.as_deref())?;
        let result = self.save_as_inner(destination, params, &operation_id, &cancellation);
        self.finish_archive_operation(&operation_id);
        result
    }

    fn save_as_inner(
        &self,
        destination: PathBuf,
        params: &SaveProjectAsParams,
        operation_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<SaveResult> {
        if destination.exists() && !params.overwrite {
            anyhow::bail!(
                "archive destination already exists: {}",
                destination.display()
            );
        }
        let parent = destination
            .parent()
            .context("archive destination has no parent")?;
        fs::create_dir_all(parent)?;
        let new_lock_path = project_lock_path(&destination);
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let (new_lock_file, mut new_lease) =
            acquire_lock(&new_lock_path, &session.id, &destination)?;
        let save_result = save_archive_session(
            session,
            &destination,
            params.overwrite,
            params.include_rebuildable_index,
            Some((operation_id, cancellation)),
            params.progress_key.as_deref(),
        );
        if let Err(error) = save_result {
            release_lock(&new_lock_file, &new_lock_path, &session.id)?;
            return Err(error);
        }
        new_lease.source_fingerprint = source_fingerprint(&destination)?;
        new_lease.heartbeat_unix_ms = unix_ms()?;
        write_lease_record(&new_lock_path, &new_lease)?;
        if let Err(error) = release_lock(&session.lock_file, &session.lock_path, &session.id) {
            release_lock(&new_lock_file, &new_lock_path, &session.id)?;
            return Err(error).context("failed to release previous project lock after Save As");
        }
        session.source_path = destination;
        session.lock_path = new_lock_path;
        session.lock_file = new_lock_file;
        session.lease = new_lease;
        session.uses_local_working_copy = true;
        session.last_saved_generation = session.manifest.autosave_generation;
        // Display name follows the archive file stem (Save As → project title).
        let source_for_name = session.source_path.clone();
        apply_project_display_name_from_path(session, &source_for_name)?;
        Ok(SaveResult {
            saved_generation: session.last_saved_generation,
            source_path: path_string(&session.source_path),
        })
    }

    pub fn cancel_archive(&self, params: CancelArchiveParams) -> Result<CancelArchiveResult> {
        validate_archive_operation_id(&params.archive_operation_id)?;
        let guard = self
            .active_archives
            .lock()
            .expect("archive operation mutex poisoned");
        let cancellation_requested = guard
            .get(&params.archive_operation_id)
            .is_some_and(CancellationToken::request_cancel);
        Ok(CancelArchiveResult {
            archive_operation_id: params.archive_operation_id,
            cancellation_requested,
        })
    }

    fn begin_archive_operation(
        &self,
        requested_id: Option<&str>,
    ) -> Result<(String, CancellationToken)> {
        self.begin_archive_operation_inner(requested_id, false)
    }

    fn begin_project_open_archive_operation(
        &self,
        requested_id: Option<&str>,
    ) -> Result<(String, CancellationToken)> {
        self.begin_archive_operation_inner(requested_id, true)
    }

    fn begin_archive_operation_inner(
        &self,
        requested_id: Option<&str>,
        permit_project_open: bool,
    ) -> Result<(String, CancellationToken)> {
        anyhow::ensure!(
            permit_project_open || !self.draining_side_operations.load(Ordering::Acquire),
            "archive operations are unavailable while the project is draining"
        );
        let operation_id = requested_id.map_or_else(
            || unique_id("archive", unix_ms().unwrap_or_default()),
            str::to_owned,
        );
        validate_archive_operation_id(&operation_id)?;
        let cancellation = CancellationToken::new();
        let mut guard = self
            .active_archives
            .lock()
            .expect("archive operation mutex poisoned");
        anyhow::ensure!(
            permit_project_open || !self.draining_side_operations.load(Ordering::Acquire),
            "archive operations are unavailable while the project is draining"
        );
        if guard.contains_key(&operation_id) {
            anyhow::bail!("archive operation id is already active: {operation_id}");
        }
        guard.insert(operation_id.clone(), cancellation.clone());
        Ok((operation_id, cancellation))
    }

    fn finish_archive_operation(&self, operation_id: &str) {
        self.active_archives
            .lock()
            .expect("archive operation mutex poisoned")
            .remove(operation_id);
    }

    /// Closes only after both authoritative job owners prove their drains completed.
    pub fn close_after_drain(
        &self,
        jobs: &DrainReport,
        side_operations: &SideOperationDrainReport,
    ) -> Result<()> {
        anyhow::ensure!(
            jobs.completed() && side_operations.completed(),
            "project cannot be marked as cleanly closed after a timed-out drain"
        );
        self.close()
    }

    fn close(&self) -> Result<()> {
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let Some(mut session) = guard.take() else {
            return Ok(());
        };
        session.manifest.clean_shutdown = true;
        session.manifest.modified_unix_ms = unix_ms()?;
        atomic_write_json(
            &session.working_path.join("manifest.json"),
            &session.manifest,
        )?;
        if !session.uses_local_working_copy {
            atomic_write_json(
                &session.source_path.join("manifest.json"),
                &session.manifest,
            )?;
        }
        release_lock(&session.lock_file, &session.lock_path, &session.id)?;
        Ok(())
    }

    pub fn put_object(&self, bytes: &[u8]) -> Result<ObjectHash> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        ensure_writable(session)?;
        let hash = ObjectHash::of_bytes(bytes);
        let (prefix, remainder) = hash.as_str().split_at(2);
        let directory = session.working_path.join("objects").join(prefix);
        fs::create_dir_all(&directory)?;
        let path = directory.join(remainder);
        if !path.exists() {
            atomic_write_bytes(&path, bytes)?;
        }
        Ok(hash)
    }

    /// Loads the sidecar-owned request bound to one durable job history row.
    pub fn frozen_job_request(
        &self,
        history_job_id: &PhotolabJobId,
    ) -> Result<Option<FrozenJobRequest>> {
        let (project_id, project_root) = {
            let guard = self.session.lock().expect("project session mutex poisoned");
            let session = guard.as_ref().context("no project is open")?;
            (
                session.manifest.project_id.clone(),
                session.working_path.clone(),
            )
        };
        let _history_guard = self
            .job_history_io
            .lock()
            .map_err(|_| anyhow::anyhow!("job history mutex poisoned"))?;
        let path = job_history_record_path(&project_root, &history_job_id.0);
        if !path.is_file() {
            return Ok(None);
        }
        let record: ProjectJobHistoryRecord = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("invalid job history record {}", path.display()))?;
        anyhow::ensure!(
            record.schema_version == JOB_HISTORY_SCHEMA_VERSION
                && record.project_id == project_id
                && record.job.id == *history_job_id,
            "frozen request belongs to a different job history record"
        );
        if let Some(frozen_request) = &record.frozen_request {
            frozen_request.validate().map_err(anyhow::Error::msg)?;
            anyhow::ensure!(
                frozen_request.job_kind == record.job.kind
                    && frozen_request.config_hash == record.job.config_hash
                    && frozen_request.input_hash == record.job.input_hash,
                "frozen job request identity does not match its history record"
            );
        }
        Ok(record.frozen_request)
    }
}

impl JobHistoryPersistence for ProjectRuntime {
    fn current_scope(&self) -> std::result::Result<Option<JobHistoryScope>, String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "project session mutex poisoned".to_owned())?;
        Ok(guard.as_ref().map(|session| JobHistoryScope {
            project_id: session.manifest.project_id.clone(),
            project_root: session.working_path.clone(),
        }))
    }

    fn load_current(&self) -> std::result::Result<Vec<PhotolabJob>, String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "project session mutex poisoned".to_owned())?;
        Ok(guard.as_ref().map_or_else(Vec::new, |session| {
            session.job_history.values().cloned().collect()
        }))
    }

    fn persist(
        &self,
        scope: &JobHistoryScope,
        job: &PhotolabJob,
        frozen_request: Option<&FrozenJobRequest>,
    ) -> std::result::Result<(), String> {
        {
            let _history_guard = self
                .job_history_io
                .lock()
                .map_err(|_| "job history mutex poisoned".to_owned())?;
            write_project_job_history_record(
                &scope.project_root,
                &scope.project_id,
                job,
                frozen_request,
            )
            .map_err(|error| error.to_string())?;
        }

        {
            let mut guard = self
                .session
                .lock()
                .map_err(|_| "project session mutex poisoned".to_owned())?;
            if let Some(session) = guard.as_mut().filter(|session| {
                session.manifest.project_id == scope.project_id
                    && session.working_path == scope.project_root
            }) {
                session.job_history.insert(job.id.0.clone(), job.clone());
            }
        }
        if job_state_is_terminal(&job.state) {
            if let Err(error) = cleanup_terminal_job_scratch(&scope.project_root, job) {
                tracing::warn!(
                    job_id = %job.id.0,
                    %error,
                    "terminal PhotoLab scratch cleanup will be retried on the next project open"
                );
            }
        }
        Ok(())
    }
}

fn job_state_is_terminal(state: &PhotolabJobState) -> bool {
    matches!(
        state,
        PhotolabJobState::Cancelled | PhotolabJobState::Completed | PhotolabJobState::Failed { .. }
    )
}

fn cleanup_published_job_scratch(project_root: &Path, job_id: &str, kind: PhotolabJobKind) {
    let job = PhotolabJob {
        schema_version: 1,
        id: himmelcad_core::photolab_jobs::PhotolabJobId(job_id.to_owned()),
        kind,
        config_hash: ObjectHash::of_bytes(b"published-scratch-cleanup"),
        input_hash: ObjectHash::of_bytes(b"published-scratch-cleanup"),
        state: PhotolabJobState::Completed,
        progress: himmelcad_core::photolab_jobs::JobProgress {
            stage: himmelcad_core::photolab_jobs::PhotolabStage {
                kind: himmelcad_core::photolab_jobs::PhotolabStageKind::Finalizing,
                index: 0,
                stage_count: 1,
                label: "Published".into(),
            },
            metrics: himmelcad_core::photolab_jobs::ProgressMetrics::empty(),
        },
        created_at_unix_ms: 0,
        started_at_unix_ms: None,
        finished_at_unix_ms: Some(0),
        last_checkpoint_sequence: None,
        terminal_diagnostic: None,
    };
    if let Err(error) = cleanup_terminal_job_scratch(project_root, &job) {
        tracing::warn!(
            job_id,
            %error,
            "published PhotoLab scratch cleanup will be retried from durable job history"
        );
    }
}

/// Removes only rebuildable, job-owned scratch after the worker has reached a durable terminal
/// state. Published datasets and the files required by a committed resume checkpoint are outside
/// this deletion set (or explicitly retained below).
fn cleanup_terminal_job_scratch(project_root: &Path, job: &PhotolabJob) -> Result<()> {
    if !job_state_is_terminal(&job.state) {
        return Ok(());
    }
    validate_compute_job_id(&job.id.0)?;
    let job_id = &job.id.0;
    let completed = job.state == PhotolabJobState::Completed;

    match job.kind {
        PhotolabJobKind::AlignPhotos => {
            remove_prefixed_job_directories(
                &project_root.join("tmp/colmap"),
                &format!("colmap-{job_id}-"),
                |_| Ok(false),
            )?;
            remove_prefixed_job_directories(
                &project_root.join(".photolab/scratch/dedode"),
                &format!("dedode-{job_id}-"),
                |_| Ok(false),
            )?;
        }
        PhotolabJobKind::MergeAlignments => {
            let scratch = project_root
                .join(".photolab/scratch/alignment-merge")
                .join(job_id);
            let checkpoint = project_root
                .join(".photolab/jobs/alignment-merge")
                .join(job_id)
                .join("checkpoint.json");
            if completed || !checkpoint.is_file() {
                remove_path_if_exists(&scratch)?;
            }
        }
        PhotolabJobKind::BuildDepthMaps | PhotolabJobKind::BuildDensePointCloud => {
            cleanup_mvs_job(project_root, job_id, completed)?;
        }
        PhotolabJobKind::BuildDem | PhotolabJobKind::BuildOrthomosaic => {
            cleanup_raster_job(project_root, job_id, completed, Some(job))?;
        }
        PhotolabJobKind::BuildMesh => {
            remove_path_if_exists(&project_root.join(".photolab/mesh-staging").join(job_id))?;
        }
        PhotolabJobKind::BuildGaussianSplat => {
            cleanup_brush_job(project_root, job_id, completed)?;
        }
        PhotolabJobKind::AnalyzeImageQuality
        | PhotolabJobKind::OptimizeAlignment
        | PhotolabJobKind::ExportProduct => {}
        PhotolabJobKind::Batch => cleanup_batch_job(project_root, job_id)?,
    }
    Ok(())
}

fn cleanup_batch_job(project_root: &Path, batch_id: &str) -> Result<()> {
    let operation_prefix = format!("{batch_id}-");
    for index in 0..32 {
        let alignment_id = format!("{batch_id}-{index:02}-alignment");
        remove_prefixed_job_directories(
            &project_root.join("tmp/colmap"),
            &format!("colmap-{alignment_id}-"),
            |_| Ok(false),
        )?;
        remove_prefixed_job_directories(
            &project_root.join(".photolab/scratch/dedode"),
            &format!("dedode-{alignment_id}-"),
            |_| Ok(false),
        )?;
    }

    let mut raster_jobs = direct_child_names_with_prefix(
        &project_root.join(".photolab/raster-inputs"),
        &operation_prefix,
    )?;
    raster_jobs.extend(direct_child_names_with_prefix(
        &project_root.join(".photolab/raster-staging/raster-jobs"),
        &operation_prefix,
    )?);
    raster_jobs.extend(file_stems_with_prefix(
        &project_root.join(".photolab/raster-staging/raster-checkpoints"),
        &operation_prefix,
        "json",
    )?);
    raster_jobs.retain(|job_id| is_batch_child_operation(batch_id, job_id));
    for job_id in raster_jobs {
        cleanup_raster_job(
            project_root,
            &job_id,
            project_root.join("datasets/raster").join(&job_id).is_dir(),
            None,
        )?;
    }

    for job_id in direct_child_names_with_prefix(
        &project_root.join(".photolab/mesh-staging"),
        &operation_prefix,
    )?
    .into_iter()
    .filter(|job_id| is_batch_child_operation(batch_id, job_id))
    {
        remove_path_if_exists(&project_root.join(".photolab/mesh-staging").join(job_id))?;
    }

    let mut brush_jobs = direct_child_names_with_prefix(
        &project_root.join(".photolab/brush-scenes"),
        &operation_prefix,
    )?;
    brush_jobs.extend(runtime_job_ids_with_prefix(
        &project_root.join("tmp/brush"),
        "brush-",
        &operation_prefix,
    )?);
    brush_jobs.retain(|job_id| is_batch_child_operation(batch_id, job_id));
    for job_id in brush_jobs {
        cleanup_brush_job(
            project_root,
            &job_id,
            project_root.join("datasets/splats").join(&job_id).is_dir(),
        )?;
    }

    let mut mvs_jobs = direct_child_names_with_prefix(
        &project_root.join(".photolab/mvs-scenes"),
        &operation_prefix,
    )?;
    mvs_jobs.extend(runtime_job_ids_with_prefix(
        &project_root.join(".photolab/scratch/mvs"),
        "mvs-",
        &operation_prefix,
    )?);
    mvs_jobs.retain(|job_id| is_batch_child_operation(batch_id, job_id));
    for job_id in mvs_jobs {
        cleanup_mvs_job(
            project_root,
            &job_id,
            project_root.join("datasets/mvs").join(&job_id).is_dir(),
        )?;
    }
    Ok(())
}

fn is_batch_child_operation(batch_id: &str, operation_id: &str) -> bool {
    let Some(suffix) = operation_id.strip_prefix(&format!("{batch_id}-")) else {
        return false;
    };
    let bytes = suffix.as_bytes();
    bytes.len() >= 4 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[2] == b'-'
}

fn cleanup_raster_job(
    project_root: &Path,
    job_id: &str,
    completed: bool,
    identity: Option<&PhotolabJob>,
) -> Result<()> {
    remove_path_if_exists(&project_root.join(".photolab/raster-inputs").join(job_id))?;
    let staging = project_root.join(".photolab/raster-staging");
    let checkpoint = staging
        .join("raster-checkpoints")
        .join(format!("{job_id}.json"));
    let job_directory = staging.join("raster-jobs").join(job_id);
    if completed {
        remove_path_if_exists(&checkpoint)?;
        remove_path_if_exists(&checkpoint.with_extension("steps"))?;
        remove_path_if_exists(&job_directory)?;
    } else if !checkpoint.is_file() {
        remove_path_if_exists(&job_directory)?;
    }
    remove_path_if_exists(&staging.join("raster-locks").join(format!("{job_id}.lock")))?;
    if let Some(identity) = identity {
        let kind = match identity.kind {
            PhotolabJobKind::BuildDem => "buildDem",
            PhotolabJobKind::BuildOrthomosaic => "buildOrthomosaic",
            _ => return Ok(()),
        };
        let key = raster_checkpoint_content_key(kind, &identity.config_hash, &identity.input_hash)?;
        let checkpoint = staging
            .join("raster-checkpoints")
            .join(format!("{key}.json"));
        let content_job_directory = staging.join("raster-jobs").join(&key);
        if completed {
            remove_path_if_exists(&checkpoint)?;
            remove_path_if_exists(&checkpoint.with_extension("steps"))?;
            remove_path_if_exists(&content_job_directory)?;
        } else if !checkpoint.is_file() {
            remove_path_if_exists(&content_job_directory)?;
        }
        remove_path_if_exists(&staging.join("raster-locks").join(format!("{key}.lock")))?;
    }
    Ok(())
}

fn cleanup_brush_job(project_root: &Path, job_id: &str, completed: bool) -> Result<()> {
    remove_path_if_exists(&project_root.join(".photolab/brush-scenes").join(job_id))?;
    remove_prefixed_job_directories(
        &project_root.join("tmp/brush"),
        &format!("brush-{job_id}-"),
        |scratch| {
            if completed || !directory_has_regular_files(&scratch.join("checkpoints"))? {
                return Ok(false);
            }
            retain_named_children(scratch, &["checkpoints"])?;
            Ok(true)
        },
    )
}

fn cleanup_mvs_job(project_root: &Path, job_id: &str, completed: bool) -> Result<()> {
    let mut retained_checkpoint = false;
    remove_prefixed_job_directories(
        &project_root.join(".photolab/scratch/mvs"),
        &format!("mvs-{job_id}-"),
        |scratch| {
            if completed || !directory_has_regular_files(&scratch.join("checkpoints"))? {
                return Ok(false);
            }
            retained_checkpoint = true;
            retain_named_children(scratch, &["checkpoints", "output"])?;
            Ok(true)
        },
    )?;

    let scene = project_root.join(".photolab/mvs-scenes").join(job_id);
    let published_dataset = project_root.join("datasets/mvs").join(job_id).is_dir();
    if !(published_dataset || retained_checkpoint) {
        remove_path_if_exists(&scene)?;
    }
    Ok(())
}

/// Applies a policy to matching directories. `true` retains explicitly pruned recovery material;
/// `false` removes the whole rebuildable run.
fn remove_prefixed_job_directories<F>(root: &Path, prefix: &str, mut retain: F) -> Result<()>
where
    F: FnMut(&Path) -> Result<bool>,
{
    if !root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || !entry.file_name().to_string_lossy().starts_with(prefix) {
            continue;
        }
        let path = entry.path();
        if !retain(&path)? {
            remove_path_if_exists(&path)?;
        }
    }
    Ok(())
}

fn retain_named_children(root: &Path, retained_names: &[&str]) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if retained_names
            .iter()
            .any(|name| entry.file_name() == std::ffi::OsStr::new(name))
        {
            continue;
        }
        remove_path_if_exists(&entry.path())?;
    }
    Ok(())
}

fn directory_has_regular_files(path: &Path) -> Result<bool> {
    if !path.is_dir() {
        return Ok(false);
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if fs::symlink_metadata(entry.path())?.is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn direct_child_names_with_prefix(root: &Path, prefix: &str) -> Result<BTreeSet<String>> {
    let mut values = BTreeSet::new();
    if !root.is_dir() {
        return Ok(values);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if fs::symlink_metadata(entry.path())?.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(prefix) && validate_compute_job_id(&name).is_ok() {
                values.insert(name);
            }
        }
    }
    Ok(values)
}

fn file_stems_with_prefix(root: &Path, prefix: &str, extension: &str) -> Result<BTreeSet<String>> {
    let mut values = BTreeSet::new();
    if !root.is_dir() {
        return Ok(values);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if !fs::symlink_metadata(&path)?.is_file()
            || path.extension() != Some(std::ffi::OsStr::new(extension))
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if stem.starts_with(prefix) && validate_compute_job_id(stem).is_ok() {
            values.insert(stem.to_owned());
        }
    }
    Ok(values)
}

fn runtime_job_ids_with_prefix(
    root: &Path,
    runtime_prefix: &str,
    operation_prefix: &str,
) -> Result<BTreeSet<String>> {
    let mut values = BTreeSet::new();
    if !root.is_dir() {
        return Ok(values);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !fs::symlink_metadata(entry.path())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(value) = name.strip_prefix(runtime_prefix) else {
            continue;
        };
        let Some((job_id, _sequence)) = value.rsplit_once('-') else {
            continue;
        };
        if job_id.starts_with(operation_prefix) && validate_compute_job_id(job_id).is_ok() {
            values.insert(job_id.to_owned());
        }
    }
    Ok(values)
}

fn job_history_path(project_root: &Path) -> PathBuf {
    project_root.join(".photolab/jobs/history.json")
}

fn job_history_records_path(project_root: &Path) -> PathBuf {
    project_root.join(".photolab/jobs/records")
}

fn job_history_record_path(project_root: &Path, job_id: &str) -> PathBuf {
    let file_name = format!("{}.json", ObjectHash::of_bytes(job_id.as_bytes()).as_str());
    job_history_records_path(project_root).join(file_name)
}

fn job_history_differs(working_root: &Path, source_root: &Path) -> bool {
    job_history_snapshot(working_root)
        .is_some_and(|working| Some(working) != job_history_snapshot(source_root))
}

fn job_history_snapshot(project_root: &Path) -> Option<Vec<(String, Vec<u8>)>> {
    let mut snapshot = Vec::new();
    if let Ok(bytes) = fs::read(job_history_path(project_root)) {
        snapshot.push(("history.json".into(), bytes));
    }
    let records_root = job_history_records_path(project_root);
    if !records_root.is_dir() {
        return (!snapshot.is_empty()).then_some(snapshot);
    }
    let mut entries = fs::read_dir(records_root)
        .ok()?
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if entry.file_type().ok()?.is_file()
            && is_job_history_record_filename(&entry.file_name().to_string_lossy())
        {
            snapshot.push((
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).ok()?,
            ));
        }
    }
    (!snapshot.is_empty()).then_some(snapshot)
}

fn read_project_job_history(
    project_root: &Path,
    project_id: &str,
) -> Result<BTreeMap<String, PhotolabJob>> {
    let manifest = read_manifest(project_root)?;
    anyhow::ensure!(
        manifest.project_id == project_id,
        "job history scope does not match the project manifest"
    );
    let mut jobs = BTreeMap::new();
    let legacy_path = job_history_path(project_root);
    if legacy_path.is_file() {
        let history: ProjectJobHistoryFile = serde_json::from_slice(&fs::read(&legacy_path)?)
            .with_context(|| format!("invalid job history {}", legacy_path.display()))?;
        anyhow::ensure!(
            history.schema_version == JOB_HISTORY_SCHEMA_VERSION
                && history.project_id == project_id,
            "legacy job history belongs to a different schema or project"
        );
        for job in history.jobs {
            validate_project_job(&job)?;
            anyhow::ensure!(
                jobs.insert(job.id.0.clone(), job).is_none(),
                "legacy project job history contains duplicate job ids"
            );
        }
    }
    let records_root = job_history_records_path(project_root);
    if records_root.is_dir() {
        for entry in fs::read_dir(&records_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file()
                || !is_job_history_record_filename(&entry.file_name().to_string_lossy())
            {
                continue;
            }
            let path = entry.path();
            let record: ProjectJobHistoryRecord = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("invalid job history record {}", path.display()))?;
            anyhow::ensure!(
                record.schema_version == JOB_HISTORY_SCHEMA_VERSION
                    && record.project_id == project_id,
                "job history record belongs to a different schema or project"
            );
            validate_project_job(&record.job)?;
            if let Some(frozen_request) = &record.frozen_request {
                frozen_request.validate().map_err(anyhow::Error::msg)?;
                anyhow::ensure!(
                    frozen_request.job_kind == record.job.kind
                        && frozen_request.config_hash == record.job.config_hash
                        && frozen_request.input_hash == record.job.input_hash,
                    "frozen job request identity does not match its history record"
                );
            }
            anyhow::ensure!(
                path == job_history_record_path(project_root, &record.job.id.0),
                "job history record file name does not match its job id"
            );
            jobs.insert(record.job.id.0.clone(), record.job);
            anyhow::ensure!(
                jobs.len() <= MAX_DURABLE_JOB_RECORDS,
                "project job history exceeds the supported record limit"
            );
        }
    }
    Ok(jobs)
}

fn is_job_history_record_filename(name: &str) -> bool {
    name.len() == 69
        && name.ends_with(".json")
        && name[..64]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_project_job(job: &PhotolabJob) -> Result<()> {
    anyhow::ensure!(job.schema_version == 1, "unsupported job record schema");
    anyhow::ensure!(!job.id.0.trim().is_empty(), "job id must not be empty");
    Ok(())
}

fn write_project_job_history_record(
    project_root: &Path,
    project_id: &str,
    job: &PhotolabJob,
    frozen_request: Option<&FrozenJobRequest>,
) -> Result<()> {
    validate_project_job(job)?;
    let existing_frozen_request = if frozen_request.is_none() {
        let path = job_history_record_path(project_root, &job.id.0);
        path.is_file()
            .then(|| fs::read(&path))
            .transpose()?
            .map(|bytes| serde_json::from_slice::<ProjectJobHistoryRecord>(&bytes))
            .transpose()?
            .and_then(|record| record.frozen_request)
    } else {
        None
    };
    let frozen_request = frozen_request.cloned().or(existing_frozen_request);
    if let Some(frozen_request) = &frozen_request {
        frozen_request.validate().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            frozen_request.job_kind == job.kind
                && frozen_request.config_hash == job.config_hash
                && frozen_request.input_hash == job.input_hash,
            "frozen job request identity does not match its history record"
        );
    }
    let record = ProjectJobHistoryRecord {
        schema_version: JOB_HISTORY_SCHEMA_VERSION,
        project_id: project_id.to_owned(),
        job: job.clone(),
        frozen_request,
    };
    atomic_write_json(&job_history_record_path(project_root, &job.id.0), &record)
}

fn mark_interrupted_jobs(history: &mut BTreeMap<String, PhotolabJob>) -> Result<Vec<PhotolabJob>> {
    let mut changed = Vec::new();
    for job in history.values_mut() {
        if matches!(
            job.state,
            PhotolabJobState::Cancelled
                | PhotolabJobState::Completed
                | PhotolabJobState::Failed { .. }
        ) {
            continue;
        }
        let (code, message) = match (
            job.last_checkpoint_sequence,
            job_kind_supports_cross_restart_resume(job.kind),
        ) {
            (Some(sequence), true) => (
                "interruptedRecoverable".to_owned(),
                format!(
                    "The previous PhotoLab session ended before this job completed. Resume is available from committed checkpoint {sequence}."
                ),
            ),
            (_, false) => (
                "interrupted".to_owned(),
                "The previous PhotoLab session ended before this job completed. Restart required; this operation has no cross-restart resume path."
                    .to_owned(),
            ),
            (None, true) => (
                "interrupted".to_owned(),
                "The previous PhotoLab session ended before this job completed. Restart the operation; no committed checkpoint was recorded."
                    .to_owned(),
            ),
        };
        job.transition_to(PhotolabJobState::Failed { code, message })?;
        changed.push(job.clone());
    }
    Ok(changed)
}

const fn job_kind_supports_cross_restart_resume(kind: PhotolabJobKind) -> bool {
    match kind {
        PhotolabJobKind::BuildDepthMaps
        | PhotolabJobKind::BuildDensePointCloud
        | PhotolabJobKind::BuildDem
        | PhotolabJobKind::BuildOrthomosaic
        | PhotolabJobKind::BuildGaussianSplat
        | PhotolabJobKind::Batch => true,
        PhotolabJobKind::AnalyzeImageQuality
        | PhotolabJobKind::AlignPhotos
        | PhotolabJobKind::OptimizeAlignment
        | PhotolabJobKind::MergeAlignments
        | PhotolabJobKind::BuildMesh
        | PhotolabJobKind::ExportProduct => false,
    }
}

fn json_contains_string(value: &serde_json::Value, needle: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value == needle,
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_contains_string(value, needle)),
        serde_json::Value::Object(values) => values
            .values()
            .any(|value| json_contains_string(value, needle)),
        _ => false,
    }
}

impl ProjectSession {
    fn result(&self) -> OpenPhotolabProjectResult {
        OpenPhotolabProjectResult {
            session: ProjectSessionSummary {
                session_id: self.id.clone(),
                source_path: path_string(&self.source_path),
                working_path: path_string(&self.working_path),
                uses_local_working_copy: self.uses_local_working_copy,
                recovery_available: self.recovery_available,
                read_only: self.read_only,
                autosave_generation: self.manifest.autosave_generation,
                last_saved_generation: self.last_saved_generation,
            },
            manifest: self.manifest.clone(),
        }
    }
}

fn touch_and_autosave(session: &mut ProjectSession) -> Result<()> {
    session.manifest.autosave_generation = session.manifest.autosave_generation.saturating_add(1);
    session.manifest.modified_unix_ms = unix_ms()?;
    session.manifest.clean_shutdown = false;
    atomic_write_json(
        &session.working_path.join("manifest.json"),
        &session.manifest,
    )?;
    heartbeat_session_lease(session, session.working_path == session.source_path)
}

fn heartbeat_session_lease(session: &mut ProjectSession, refresh_source: bool) -> Result<()> {
    if refresh_source {
        session.lease.source_fingerprint = source_fingerprint(&session.source_path)?;
    }
    session.lease.heartbeat_unix_ms = unix_ms()?;
    write_lease_record(&session.lock_path, &session.lease)
}

fn ensure_source_unchanged(session: &ProjectSession) -> Result<()> {
    let observed = source_fingerprint(&session.source_path)?;
    if observed == session.lease.source_fingerprint {
        return Ok(());
    }
    if session.working_path == session.source_path
        && observed.kind == ProjectSourceFingerprintKind::Manifest
    {
        let expected_bytes = serde_json::to_vec_pretty(&session.manifest)?;
        let expected = ProjectSourceFingerprint {
            kind: ProjectSourceFingerprintKind::Manifest,
            sha256: ObjectHash::of_bytes(&expected_bytes),
            byte_size: u64::try_from(expected_bytes.len())?,
        };
        if observed == expected {
            return Ok(());
        }
    }
    anyhow::bail!(
        "project source changed externally while this session was open; refusing to overwrite {} (opened fingerprint {}, current fingerprint {}). Save to a different file or reopen the project.",
        session.source_path.display(),
        session.lease.source_fingerprint.sha256.as_str(),
        observed.sha256.as_str()
    )
}

fn validate_compute_job_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        anyhow::bail!("compute job id contains unsupported characters");
    }
    Ok(())
}

fn unique_entity_of_kind(
    manifest: &PhotolabProjectManifest,
    kind: EntityKind,
    id_suffix: &str,
) -> Result<EntityId> {
    let mut matches = manifest
        .entities
        .values()
        .filter(|entity| entity.kind == kind && entity.id.0.ends_with(&format!(":{id_suffix}")));
    let entity = matches
        .next()
        .with_context(|| format!("project has no {id_suffix} group"))?;
    if matches.next().is_some() {
        anyhow::bail!("project has multiple {id_suffix} groups");
    }
    Ok(entity.id.clone())
}

fn artifact_entity(kind: ColmapArtifactKind) -> Option<(EntityKind, &'static str)> {
    match kind {
        ColmapArtifactKind::SparseModel => Some((EntityKind::AlignmentRun, "Alignment")),
        ColmapArtifactKind::SparsePointCloud => {
            Some((EntityKind::PointCloud, "Sparse Point Cloud"))
        }
        ColmapArtifactKind::DepthMaps => Some((EntityKind::DepthMap, "Depth Maps")),
        ColmapArtifactKind::DensePointCloud => Some((EntityKind::PointCloud, "Dense Point Cloud")),
        ColmapArtifactKind::Mesh => Some((EntityKind::Mesh, "Mesh")),
        ColmapArtifactKind::TexturedMesh => Some((EntityKind::TexturedMesh, "Textured Mesh")),
        ColmapArtifactKind::AlikedVerifiedDatabase
        | ColmapArtifactKind::SiftVerifiedDatabase
        | ColmapArtifactKind::DedodeVerifiedDatabase => None,
    }
}

fn decode_published_mesh_record(
    bytes: &[u8],
    entity_kind: EntityKind,
) -> Result<PublishedMeshRecord> {
    anyhow::ensure!(
        matches!(entity_kind, EntityKind::Mesh | EntityKind::TexturedMesh),
        "entity is not a mesh product"
    );
    let expected_textured = entity_kind == EntityKind::TexturedMesh;
    if let Ok(record) = serde_json::from_slice::<MeshArtifactRecord>(bytes) {
        anyhow::ensure!(
            record.textured == expected_textured,
            "prepared mesh record kind does not match its entity"
        );
        if let Some(source) = record.source_artifact.as_ref() {
            let expected_source = if expected_textured {
                ColmapArtifactKind::TexturedMesh
            } else {
                ColmapArtifactKind::Mesh
            };
            anyhow::ensure!(
                source.kind == expected_source,
                "prepared mesh source artifact kind does not match its entity"
            );
        }
        return Ok(PublishedMeshRecord::Prepared(Box::new(record)));
    }
    let record: ComputeArtifactRecord =
        serde_json::from_slice(bytes).context("mesh entity has an unsupported product record")?;
    let expected_artifact_kind = if expected_textured {
        ColmapArtifactKind::TexturedMesh
    } else {
        ColmapArtifactKind::Mesh
    };
    anyhow::ensure!(
        record.artifact.kind == expected_artifact_kind,
        "COLMAP mesh record kind does not match its entity"
    );
    Ok(PublishedMeshRecord::Colmap(Box::new(record)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedCameraMapEntry {
    entity_id: String,
}

fn alignment_camera_scope(
    record: &ComputeArtifactRecord,
    dataset_root: &Path,
    manifest: &PhotolabProjectManifest,
) -> Result<Vec<String>> {
    let camera_entity_ids = if record.camera_entity_ids.is_empty() {
        // Records written before camera membership was embedded remain usable because every
        // COLMAP publication contains the exact immutable materialization map for that run.
        let bytes = fs::read(dataset_root.join("camera-map.json"))
            .context("legacy alignment has no recoverable camera scope")?;
        serde_json::from_slice::<Vec<PublishedCameraMapEntry>>(&bytes)
            .context("legacy alignment camera map is invalid")?
            .into_iter()
            .map(|entry| entry.entity_id)
            .collect()
    } else {
        record.camera_entity_ids.clone()
    };
    validate_camera_scope(manifest, &camera_entity_ids)
}

fn read_processing_set(
    session: &ProjectSession,
    processing_set_id: &EntityId,
) -> Result<ProcessingSetRecord> {
    let entity = session
        .manifest
        .entities
        .get(&processing_set_id.0)
        .with_context(|| format!("unknown processing set {}", processing_set_id.0))?;
    anyhow::ensure!(
        entity.kind == EntityKind::ProcessingSet,
        "entity {} is not a processing set",
        processing_set_id.0
    );
    let bytes = fs::read(project_object_path(
        &session.working_path,
        &entity.version_hash,
    ))?;
    anyhow::ensure!(
        ObjectHash::of_bytes(&bytes) == entity.version_hash,
        "processing-set record hash mismatch"
    );
    let record: ProcessingSetRecord = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        record.entity_id == *processing_set_id,
        "processing-set entity id mismatch"
    );
    validate_processing_set_record(&session.manifest, &record)?;
    Ok(record)
}

fn validate_processing_set_record(
    manifest: &PhotolabProjectManifest,
    record: &ProcessingSetRecord,
) -> Result<Vec<String>> {
    let ids = record
        .camera_entity_ids
        .iter()
        .map(|id| id.0.clone())
        .collect::<Vec<_>>();
    let scope = validate_camera_scope(manifest, &ids)?;
    let frozen_ids = scope.iter().cloned().map(EntityId).collect::<Vec<_>>();
    anyhow::ensure!(
        ObjectHash::of_bytes(&serde_json::to_vec(&frozen_ids)?) == record.membership_sha256,
        "processing-set membership hash mismatch"
    );
    if record.schema_version >= 2 {
        for (ids, kind, label) in [
            (
                &record.capture_group_ids,
                EntityKind::CaptureGroup,
                "capture group",
            ),
            (
                &record.calibration_group_ids,
                EntityKind::CameraCalibrationGroup,
                "calibration group",
            ),
        ] {
            for id in ids {
                let entity = manifest
                    .entities
                    .get(&id.0)
                    .with_context(|| format!("processing-set {label} is missing"))?;
                anyhow::ensure!(
                    entity.kind == kind,
                    "processing-set {label} has the wrong kind"
                );
            }
        }
    }
    Ok(scope)
}

fn select_alignment_dataset(
    session: &ProjectSession,
    required_scope: Option<&[String]>,
    processing_set_id: Option<EntityId>,
) -> Result<PublishedAlignmentDataset> {
    let required_scope = required_scope
        .map(|scope| validate_camera_scope(&session.manifest, scope))
        .transpose()?;
    let mut candidates = Vec::new();
    for entity in session
        .manifest
        .entities
        .values()
        .filter(|entity| entity.kind == EntityKind::AlignmentRun)
    {
        let record_path = project_object_path(&session.working_path, &entity.version_hash);
        let Ok(bytes) = fs::read(record_path) else {
            continue;
        };
        if ObjectHash::of_bytes(&bytes) != entity.version_hash {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<ComputeArtifactRecord>(&bytes) else {
            continue;
        };
        if record.artifact.kind != ColmapArtifactKind::SparseModel {
            continue;
        }
        let Ok(dataset) = session
            .working_path
            .join(&record.dataset_relative_path)
            .canonicalize()
        else {
            continue;
        };
        let root = session.working_path.canonicalize()?;
        anyhow::ensure!(
            dataset.starts_with(&root) && dataset.is_dir(),
            "alignment dataset escaped the project root"
        );
        let camera_entity_ids = alignment_camera_scope(&record, &dataset, &session.manifest)?;
        if required_scope
            .as_ref()
            .is_some_and(|required| camera_entity_ids != *required)
        {
            continue;
        }
        let Ok(current_mask_scope) =
            build_image_mask_compute_scope(session, &camera_entity_ids, processing_set_id.as_ref())
        else {
            continue;
        };
        if record
            .image_mask_scope_sha256
            .as_ref()
            .is_some_and(|frozen| frozen != &current_mask_scope.scope_sha256)
            || (record.image_mask_scope_sha256.is_none() && !current_mask_scope.masks.is_empty())
        {
            continue;
        }
        candidates.push((
            record.publication_sequence,
            entity.id.0.clone(),
            dataset,
            camera_entity_ids,
            entity.id.clone(),
            current_mask_scope.scope_sha256,
        ));
    }
    let (_, _, root, camera_entity_ids, source_alignment_entity_id, image_mask_scope_sha256) =
        candidates
            .into_iter()
            .max_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)))
            .context("no completed sparse alignment is available for the requested camera scope")?;
    Ok(PublishedAlignmentDataset {
        root,
        camera_entity_ids,
        source_alignment_entity_id,
        processing_set_id,
        image_mask_scope_sha256,
    })
}

fn record_matches_lineage(
    source_alignment_entity_id: Option<&EntityId>,
    processing_set_id: Option<&EntityId>,
    required: &ProductLineage,
) -> bool {
    source_alignment_entity_id == Some(&required.source_alignment_entity_id)
        && processing_set_id == required.processing_set_id.as_ref()
}

fn product_record_matches_lineage(
    source_alignment_entity_id: Option<&EntityId>,
    processing_set_id: Option<&EntityId>,
    gcp_optimization_entity_id: Option<&EntityId>,
    gcp_optimization_snapshot_sha256: Option<&ObjectHash>,
    image_mask_scope_sha256: Option<&ObjectHash>,
    required: &ProductLineage,
) -> bool {
    record_matches_lineage(source_alignment_entity_id, processing_set_id, required)
        && gcp_optimization_entity_id == required.gcp_optimization_entity_id.as_ref()
        && gcp_optimization_snapshot_sha256 == required.gcp_optimization_snapshot_sha256.as_ref()
        && image_mask_scope_sha256 == Some(&required.image_mask_scope_sha256)
}

fn gcp_publication_order(
    left: &PublishedGcpOptimizationEntry,
    right: &PublishedGcpOptimizationEntry,
) -> std::cmp::Ordering {
    (left.optimization.publication_sequence, &left.entity_id.0)
        .cmp(&(right.optimization.publication_sequence, &right.entity_id.0))
}

fn validate_product_lineage(
    session: &ProjectSession,
    lineage: &ProductLineage,
    expected_camera_scope: Option<&[String]>,
) -> Result<()> {
    let entity = session
        .manifest
        .entities
        .get(&lineage.source_alignment_entity_id.0)
        .context("source alignment entity does not exist")?;
    anyhow::ensure!(
        matches!(
            entity.kind,
            EntityKind::AlignmentRun | EntityKind::MergedAlignmentRun
        ),
        "source alignment lineage references a non-alignment entity"
    );
    let bytes = read_verified_object(&session.working_path, &entity.version_hash)
        .context("source alignment record hash mismatch")?;
    let (alignment_scope, frozen_mask_scope_sha256) = if entity.kind
        == EntityKind::MergedAlignmentRun
    {
        let merged: MergedAlignmentRunRecord = serde_json::from_slice(&bytes)
            .context("source alignment is not a merged alignment record")?;
        anyhow::ensure!(
            merged.state == MergedAlignmentState::Published,
            "merged alignment is only planned; run and publish the joint solve before building products"
        );
        let relative_path = merged
            .dataset_relative_path
            .as_ref()
            .context("published merged alignment has no dataset")?;
        let dataset = session.working_path.join(relative_path).canonicalize()?;
        anyhow::ensure!(
            dataset.starts_with(session.working_path.canonicalize()?) && dataset.is_dir(),
            "merged alignment dataset escaped the project root"
        );
        (
            validate_camera_scope(
                &session.manifest,
                &merged
                    .camera_entity_ids
                    .iter()
                    .map(|id| id.0.clone())
                    .collect::<Vec<_>>(),
            )?,
            merged.image_mask_scope_sha256,
        )
    } else {
        let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)
            .context("source alignment is not a published sparse alignment")?;
        anyhow::ensure!(
            record.artifact.kind == ColmapArtifactKind::SparseModel,
            "source alignment record is not a sparse model"
        );
        let dataset = session
            .working_path
            .join(&record.dataset_relative_path)
            .canonicalize()?;
        anyhow::ensure!(
            dataset.starts_with(session.working_path.canonicalize()?) && dataset.is_dir(),
            "source alignment dataset escaped the project root"
        );
        (
            alignment_camera_scope(&record, &dataset, &session.manifest)?,
            record.image_mask_scope_sha256,
        )
    };
    if let Some(expected) = expected_camera_scope {
        anyhow::ensure!(
            alignment_scope == validate_camera_scope(&session.manifest, expected)?,
            "product camera scope differs from its source alignment"
        );
    }
    if let Some(processing_set_id) = lineage.processing_set_id.as_ref() {
        let processing_set = read_processing_set(session, processing_set_id)?;
        let processing_scope = validate_processing_set_record(&session.manifest, &processing_set)?;
        anyhow::ensure!(
            processing_scope == alignment_scope,
            "processing set membership differs from the source alignment"
        );
    }
    let current_mask_scope = build_image_mask_compute_scope(
        session,
        &alignment_scope,
        lineage.processing_set_id.as_ref(),
    )?;
    anyhow::ensure!(
        current_mask_scope.scope_sha256 == lineage.image_mask_scope_sha256,
        "product mask lineage differs from the current alignment scope"
    );
    match frozen_mask_scope_sha256.as_ref() {
        Some(frozen) => anyhow::ensure!(
            frozen == &lineage.image_mask_scope_sha256,
            "product mask lineage differs from its source alignment"
        ),
        None => anyhow::ensure!(
            current_mask_scope.masks.is_empty(),
            "legacy source alignment predates the current image masks"
        ),
    }
    match (
        lineage.gcp_optimization_entity_id.as_ref(),
        lineage.gcp_optimization_snapshot_sha256.as_ref(),
    ) {
        (None, None) => {}
        (Some(gcp_entity_id), Some(snapshot_sha256)) => {
            let gcp_entity = session
                .manifest
                .entities
                .get(&gcp_entity_id.0)
                .context("GCP optimization lineage entity does not exist")?;
            anyhow::ensure!(
                gcp_entity.kind == EntityKind::AlignmentRun
                    && gcp_entity.id.0.contains(":alignment-gcp:"),
                "GCP optimization lineage references a non-GCP entity"
            );
            let record: GcpOptimizationPublicationRecord = serde_json::from_slice(
                &read_verified_object(&session.working_path, &gcp_entity.version_hash)?,
            )?;
            anyhow::ensure!(
                &record.snapshot_sha256 == snapshot_sha256,
                "GCP optimization snapshot differs from the pinned product lineage"
            );
            anyhow::ensure!(
                record_matches_lineage(
                    record.source_alignment_entity_id.as_ref(),
                    record.processing_set_id.as_ref(),
                    lineage,
                ),
                "GCP optimization belongs to another alignment or processing set"
            );
        }
        _ => anyhow::bail!(
            "GCP optimization entity and snapshot must either both be pinned or both be absent"
        ),
    }
    Ok(())
}

fn validate_camera_scope(
    manifest: &PhotolabProjectManifest,
    camera_entity_ids: &[String],
) -> Result<Vec<String>> {
    anyhow::ensure!(!camera_entity_ids.is_empty(), "camera scope is empty");
    let mut validated = camera_entity_ids.to_vec();
    validated.sort();
    let original_len = validated.len();
    validated.dedup();
    anyhow::ensure!(
        validated.len() == original_len,
        "camera scope contains duplicate entity ids"
    );
    for camera_id in &validated {
        let entity = manifest
            .entities
            .get(camera_id)
            .with_context(|| format!("camera scope references unknown entity {camera_id}"))?;
        anyhow::ensure!(
            entity.kind == EntityKind::CameraImage,
            "camera scope references non-camera entity {camera_id}"
        );
    }
    Ok(validated)
}

fn validated_record_name(value: &str, kind: &str) -> Result<String> {
    let value = value.trim();
    anyhow::ensure!(
        !value.is_empty() && value.chars().count() <= 128,
        "invalid {kind} name"
    );
    Ok(value.to_owned())
}

fn sort_unique_entity_ids(ids: &mut Vec<EntityId>, kind: &str) -> Result<()> {
    ids.sort_by(|left, right| left.0.cmp(&right.0));
    let original_len = ids.len();
    ids.dedup();
    anyhow::ensure!(
        ids.len() == original_len,
        "{kind} contains duplicate entity ids"
    );
    Ok(())
}

fn validate_camera_entities(manifest: &PhotolabProjectManifest, ids: &[EntityId]) -> Result<()> {
    let strings = ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>();
    validate_camera_scope(manifest, &strings).map(|_| ())
}

fn membership_hash(ids: &[EntityId]) -> Result<ObjectHash> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(ids)?))
}

fn validate_calibration_seed(seed: &CameraCalibrationSeed) -> Result<()> {
    anyhow::ensure!(
        seed.width_pixels > 0 && seed.height_pixels > 0,
        "calibration image dimensions must be positive"
    );
    for (label, value) in [
        ("focal length", seed.focal_pixels),
        ("principal X", seed.principal_x_pixels),
        ("principal Y", seed.principal_y_pixels),
    ] {
        if let Some(value) = value {
            anyhow::ensure!(
                value.is_finite() && value >= 0.0,
                "calibration {label} must be finite and non-negative"
            );
        }
    }
    anyhow::ensure!(
        seed.focal_pixels.is_none_or(|value| value > 0.0),
        "calibration focal length must be positive"
    );
    Ok(())
}

fn read_image_quality_catalog(session: &ProjectSession) -> Result<ImageQualityCatalog> {
    let Some(hash) = session.manifest.image_quality_catalog_hash.as_ref() else {
        return Ok(ImageQualityCatalog {
            schema_version: 1,
            project_id: session.manifest.project_id.clone(),
            analyses: Vec::new(),
        });
    };
    let catalog: ImageQualityCatalog =
        serde_json::from_slice(&read_verified_object(&session.working_path, hash)?)?;
    anyhow::ensure!(
        catalog.schema_version == 1,
        "unsupported image-quality catalog schema"
    );
    anyhow::ensure!(
        catalog.project_id == session.manifest.project_id,
        "image-quality catalog belongs to another project"
    );
    Ok(catalog)
}

fn read_image_mask_catalog(session: &ProjectSession) -> Result<ImageMaskCatalog> {
    let Some(hash) = session.manifest.image_mask_catalog_hash.as_ref() else {
        return Ok(ImageMaskCatalog {
            schema_version: 1,
            project_id: session.manifest.project_id.clone(),
            revisions: Vec::new(),
        });
    };
    let mut catalog: ImageMaskCatalog =
        serde_json::from_slice(&read_verified_object(&session.working_path, hash)?)?;
    anyhow::ensure!(
        catalog.schema_version == 1,
        "unsupported image-mask catalog schema"
    );
    anyhow::ensure!(
        catalog.project_id == session.manifest.project_id,
        "image-mask catalog belongs to another project"
    );
    catalog
        .revisions
        .sort_by(|left, right| left.image_entity_id.0.cmp(&right.image_entity_id.0));
    anyhow::ensure!(
        catalog
            .revisions
            .windows(2)
            .all(|pair| pair[0].image_entity_id != pair[1].image_entity_id),
        "image-mask catalog contains duplicate image entries"
    );
    for entry in &catalog.revisions {
        anyhow::ensure!(
            session
                .manifest
                .entities
                .get(&entry.image_entity_id.0)
                .is_some_and(|entity| entity.kind == EntityKind::CameraImage),
            "image-mask catalog references a missing camera image"
        );
    }
    Ok(catalog)
}

fn read_image_mask_revision(
    session: &ProjectSession,
    hash: &ObjectHash,
) -> Result<ImageMaskRevisionRecord> {
    let record: ImageMaskRevisionRecord =
        serde_json::from_slice(&read_verified_object(&session.working_path, hash)?)?;
    anyhow::ensure!(
        record.schema_version == 1,
        "unsupported image-mask revision schema"
    );
    anyhow::ensure!(
        record.width_pixels > 0 && record.height_pixels > 0,
        "invalid image-mask dimensions"
    );
    anyhow::ensure!(
        (record.masked_pixel_count == 0) == record.raster_object_hash.is_none(),
        "empty image masks must not reference raster objects"
    );
    if let Some(raster_hash) = record.raster_object_hash.as_ref() {
        let raster =
            ImageMaskRaster::decode(&read_verified_object(&session.working_path, raster_hash)?)
                .map_err(|error| anyhow::anyhow!("invalid image-mask raster: {error:?}"))?;
        anyhow::ensure!(
            raster.width() == record.width_pixels
                && raster.height() == record.height_pixels
                && raster.masked_pixel_count() == record.masked_pixel_count,
            "image-mask raster differs from its revision"
        );
    }
    Ok(record)
}

fn edit_image_mask_transaction(
    session: &mut ProjectSession,
    params: EditImageMaskParams,
    cancellation: &CancellationToken,
) -> Result<EditImageMaskResult> {
    cancellation
        .check()
        .map_err(|_| anyhow::anyhow!(ImageMaskRuntimeError::Cancelled))?;
    let entity = session
        .manifest
        .entities
        .get(&params.image_entity_id.0)
        .context("image-mask edit references an unknown image")?;
    anyhow::ensure!(
        entity.kind == EntityKind::CameraImage,
        "image-mask target is not a camera image"
    );
    let previous_metadata_hash = entity.version_hash.clone();
    let mut metadata: CameraImageMetadataRecord = serde_json::from_slice(&read_verified_object(
        &session.working_path,
        &previous_metadata_hash,
    )?)?;
    let dimensions = metadata
        .inspected_photo
        .metadata
        .exif
        .dimensions
        .context("image-mask editing requires known source pixel dimensions")?;
    let mut catalog = read_image_mask_catalog(session)?;
    let current_index = catalog
        .revisions
        .iter()
        .position(|entry| entry.image_entity_id == params.image_entity_id);
    let current_hash = current_index.map(|index| catalog.revisions[index].revision_sha256.clone());
    if let Some(expected) = params.expected_revision_sha256.as_ref() {
        anyhow::ensure!(
            current_hash.as_ref() == Some(expected),
            "image mask changed after the editor snapshot; reload before applying this stroke"
        );
    }
    let current = current_hash
        .as_ref()
        .map(|hash| read_image_mask_revision(session, hash))
        .transpose()?;
    if let Some(current) = current.as_ref() {
        anyhow::ensure!(
            current.image_entity_id == params.image_entity_id
                && current.source_object_hash == metadata.source_object_hash,
            "current image-mask revision belongs to different pixels"
        );
    }
    let mut raster = if let Some(hash) = current
        .as_ref()
        .and_then(|revision| revision.raster_object_hash.as_ref())
    {
        ImageMaskRaster::decode(&read_verified_object(&session.working_path, hash)?)
            .map_err(|error| anyhow::anyhow!("invalid current image-mask raster: {error:?}"))?
    } else {
        ImageMaskRaster::empty(dimensions.width_pixels, dimensions.height_pixels)
            .map_err(|error| anyhow::anyhow!("invalid image-mask dimensions: {error:?}"))?
    };
    anyhow::ensure!(
        raster.width() == dimensions.width_pixels && raster.height() == dimensions.height_pixels,
        "image-mask dimensions differ from current source pixels"
    );
    match &params.edit {
        ImageMaskEdit::Brush { stroke } => {
            apply_brush_stroke(&mut raster, stroke, cancellation).map_err(anyhow::Error::from)?;
        }
        ImageMaskEdit::Clear => raster.clear(),
        ImageMaskEdit::Restore { revision_sha256 } => {
            let restored = read_image_mask_revision(session, revision_sha256)?;
            anyhow::ensure!(
                restored.image_entity_id == params.image_entity_id
                    && restored.source_object_hash == metadata.source_object_hash
                    && restored.width_pixels == dimensions.width_pixels
                    && restored.height_pixels == dimensions.height_pixels,
                "restored image-mask revision belongs to different source pixels"
            );
            raster = if let Some(hash) = restored.raster_object_hash.as_ref() {
                ImageMaskRaster::decode(&read_verified_object(&session.working_path, hash)?)
                    .map_err(|error| {
                        anyhow::anyhow!("invalid restored image-mask raster: {error:?}")
                    })?
            } else {
                ImageMaskRaster::empty(dimensions.width_pixels, dimensions.height_pixels)
                    .map_err(|error| anyhow::anyhow!("invalid image-mask dimensions: {error:?}"))?
            };
        }
    }
    cancellation
        .check()
        .map_err(|_| anyhow::anyhow!(ImageMaskRuntimeError::Cancelled))?;
    let masked_pixel_count = raster.masked_pixel_count();
    let raster_object_hash = if masked_pixel_count == 0 {
        None
    } else {
        Some(put_project_object(&session.working_path, &raster.encode())?)
    };
    let revision = ImageMaskRevisionRecord {
        schema_version: 1,
        image_entity_id: params.image_entity_id.clone(),
        source_object_hash: metadata.source_object_hash.clone(),
        source_metadata_object_hash: previous_metadata_hash.clone(),
        width_pixels: dimensions.width_pixels,
        height_pixels: dimensions.height_pixels,
        revision: current
            .as_ref()
            .map_or(1, |value| value.revision.saturating_add(1)),
        parent_revision_sha256: current_hash.clone(),
        edit: params.edit.clone(),
        raster_object_hash: raster_object_hash.clone(),
        masked_pixel_count,
    };
    let revision_sha256 =
        put_project_object(&session.working_path, &serde_json::to_vec(&revision)?)?;
    let entry = ImageMaskCatalogEntry {
        image_entity_id: params.image_entity_id.clone(),
        revision_sha256: revision_sha256.clone(),
    };
    if let Some(index) = current_index {
        catalog.revisions[index] = entry;
    } else {
        catalog.revisions.push(entry);
    }
    catalog
        .revisions
        .sort_by(|left, right| left.image_entity_id.0.cmp(&right.image_entity_id.0));
    let catalog_sha256 = put_project_object(&session.working_path, &serde_json::to_vec(&catalog)?)?;
    if masked_pixel_count > 0 {
        metadata.status_tags.insert(ImageProductTag::Masked);
    } else {
        metadata.status_tags.remove(&ImageProductTag::Masked);
    }
    let metadata_sha256 =
        put_project_object(&session.working_path, &serde_json::to_vec(&metadata)?)?;
    cancellation
        .check()
        .map_err(|_| anyhow::anyhow!(ImageMaskRuntimeError::Cancelled))?;
    let now = unix_ms()?;
    let previous_catalog_hash = session.manifest.image_mask_catalog_hash.clone();
    let mut candidate = session.manifest.clone();
    candidate.image_mask_catalog_hash = Some(catalog_sha256.clone());
    candidate
        .entities
        .get_mut(&params.image_entity_id.0)
        .context("image disappeared before mask publication")?
        .version_hash = metadata_sha256.clone();
    candidate.command_sequence = candidate.command_sequence.saturating_add(1);
    candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
    candidate.modified_unix_ms = now;
    candidate.clean_shutdown = false;
    let mut before_refs = previous_catalog_hash.into_iter().collect::<Vec<_>>();
    before_refs.push(previous_metadata_hash);
    before_refs.extend(current_hash);
    let mut after_refs = vec![catalog_sha256, revision_sha256.clone(), metadata_sha256];
    after_refs.extend(raster_object_hash.clone());
    let journal = PhotolabJournalEntry {
        sequence: candidate.command_sequence,
        command_id: params.operation_id.clone(),
        command_kind: match &params.edit {
            ImageMaskEdit::Brush { .. } => "PhotolabBrushImageMask",
            ImageMaskEdit::Clear => "PhotolabClearImageMask",
            ImageMaskEdit::Restore { .. } => "PhotolabRestoreImageMaskRevision",
        }
        .into(),
        timestamp_unix_ms: now,
        state: JournalCommandState::Committed,
        payload: serde_json::json!({
            "imageEntityId": params.image_entity_id,
            "edit": params.edit,
            "previousRevisionSha256": revision.parent_revision_sha256,
            "revisionSha256": revision_sha256,
            "rasterObjectHash": raster_object_hash,
            "maskedPixelCount": masked_pixel_count,
        }),
        affected_entities: vec![revision.image_entity_id],
        before_refs,
        after_refs,
        message: Some("Immutable image-mask revision published atomically".into()),
    };
    write_journal_entry(&session.working_path, &journal)?;
    atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
    session.manifest = candidate;
    Ok(EditImageMaskResult {
        operation_id: params.operation_id,
        revision_sha256,
        raster_object_hash,
        masked_pixel_count,
        autosave_generation: session.manifest.autosave_generation,
        journal_sequence: session.manifest.command_sequence,
    })
}

fn build_image_mask_compute_scope(
    session: &ProjectSession,
    camera_entity_ids: &[String],
    processing_set_id: Option<&EntityId>,
) -> Result<ImageMaskComputeScope> {
    let mut ids = camera_entity_ids.to_vec();
    ids.sort();
    ids.dedup();
    anyhow::ensure!(
        ids.len() == camera_entity_ids.len(),
        "mask compute scope contains duplicate cameras"
    );
    for id in &ids {
        anyhow::ensure!(
            session
                .manifest
                .entities
                .get(id)
                .is_some_and(|entity| entity.kind == EntityKind::CameraImage),
            "mask compute scope references an unknown camera: {id}"
        );
    }
    let processing_set_membership_sha256 = if let Some(processing_set_id) = processing_set_id {
        let set = read_processing_set(session, processing_set_id)?;
        let mut expected = set
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<Vec<_>>();
        expected.sort();
        anyhow::ensure!(
            ids == expected,
            "mask camera scope differs from its immutable processing set"
        );
        Some(set.membership_sha256)
    } else {
        None
    };
    let selected = ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let catalog = read_image_mask_catalog(session)?;
    let mut masks = Vec::new();
    for entry in catalog
        .revisions
        .iter()
        .filter(|entry| selected.contains(entry.image_entity_id.0.as_str()))
    {
        let revision = read_image_mask_revision(session, &entry.revision_sha256)?;
        anyhow::ensure!(
            revision.image_entity_id == entry.image_entity_id,
            "image-mask catalog entry selects a revision for another image"
        );
        if revision.masked_pixel_count == 0 {
            continue;
        }
        let raster_object_hash = revision
            .raster_object_hash
            .context("non-empty image-mask revision has no raster")?;
        masks.push(ComputeImageMask {
            image_entity_id: entry.image_entity_id.clone(),
            revision_sha256: entry.revision_sha256.clone(),
            raster_object_hash,
            width_pixels: revision.width_pixels,
            height_pixels: revision.height_pixels,
            masked_pixel_count: revision.masked_pixel_count,
        });
    }
    masks.sort_by(|left, right| left.image_entity_id.0.cmp(&right.image_entity_id.0));
    let camera_entity_ids = ids.into_iter().map(EntityId).collect::<Vec<_>>();
    let scope_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&(
        1_u32,
        processing_set_id,
        &processing_set_membership_sha256,
        &camera_entity_ids,
        &masks,
    ))?);
    Ok(ImageMaskComputeScope {
        schema_version: 1,
        processing_set_id: processing_set_id.cloned(),
        processing_set_membership_sha256,
        camera_entity_ids,
        masks,
        scope_sha256,
    })
}

fn read_verified_object(project_root: &Path, hash: &ObjectHash) -> Result<Vec<u8>> {
    let bytes = fs::read(project_object_path(project_root, hash))?;
    anyhow::ensure!(
        ObjectHash::of_bytes(&bytes) == *hash,
        "project object hash mismatch"
    );
    Ok(bytes)
}

fn validate_merge_connections(
    input_ids: &[EntityId],
    connections: &[AlignmentMergeConnection],
    optimization_records: &[(EntityId, GcpOptimizationPublicationRecord)],
) -> Result<()> {
    anyhow::ensure!(
        !connections.is_empty(),
        "alignment merge has no validated connection evidence"
    );
    let input = input_ids
        .iter()
        .map(|id| id.0.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut adjacency = HashMap::<String, Vec<String>>::new();
    let mut seen_edges = std::collections::BTreeSet::new();
    for connection in connections {
        let (left, right) = connection.endpoints();
        anyhow::ensure!(
            left != right,
            "alignment merge connection cannot be a self-edge"
        );
        anyhow::ensure!(
            input.contains(left.0.as_str()) && input.contains(right.0.as_str()),
            "alignment merge connection references an alignment outside the merge"
        );
        let edge = if left.0 < right.0 {
            (left.0.as_str(), right.0.as_str())
        } else {
            (right.0.as_str(), left.0.as_str())
        };
        anyhow::ensure!(
            seen_edges.insert(edge),
            "alignment merge contains duplicate connection evidence for the same input pair"
        );
        match connection {
            AlignmentMergeConnection::Overlap {
                verified_cross_run_track_count,
                ..
            } => {
                anyhow::ensure!(
                    *verified_cross_run_track_count == 0,
                    "planned overlap connections must not claim track evidence before the authoritative joint solve"
                );
            }
            AlignmentMergeConnection::SharedControls {
                control_point_ids, ..
            } => {
                let unique = control_point_ids
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>();
                anyhow::ensure!(
                    unique.len() == control_point_ids.len() && unique.len() >= 3,
                    "shared-control connection needs at least three unique controls"
                );
                for alignment in [left, right] {
                    let record = optimization_records
                        .iter()
                        .find_map(|(_, record)| {
                            (record.source_alignment_entity_id.as_ref() == Some(alignment))
                                .then_some(record)
                        })
                        .with_context(|| {
                            format!(
                                "shared-control connection has no GCP optimization for {}",
                                alignment.0
                            )
                        })?;
                    let controls = record
                        .artifact
                        .result
                        .residuals
                        .iter()
                        .filter(|residual| {
                            matches!(
                                residual.role,
                                himmelcad_core::photolab_gcp::GcpRole::ControlXyz
                                    | himmelcad_core::photolab_gcp::GcpRole::ControlXy
                                    | himmelcad_core::photolab_gcp::GcpRole::ControlZ
                            )
                        })
                        .map(|residual| residual.point_id.0.as_str())
                        .collect::<std::collections::BTreeSet<_>>();
                    anyhow::ensure!(
                        control_point_ids
                            .iter()
                            .all(|id| controls.contains(id.as_str())),
                        "shared-control evidence contains a point that was not a control in both optimizations"
                    );
                }
            }
        }
        adjacency
            .entry(left.0.clone())
            .or_default()
            .push(right.0.clone());
        adjacency
            .entry(right.0.clone())
            .or_default()
            .push(left.0.clone());
    }
    let mut visited = std::collections::BTreeSet::new();
    let mut stack = vec![input_ids[0].0.clone()];
    while let Some(current) = stack.pop() {
        if visited.insert(current.clone()) {
            stack.extend(adjacency.get(&current).into_iter().flatten().cloned());
        }
    }
    anyhow::ensure!(
        visited.len() == input_ids.len(),
        "alignment merge connection graph is disconnected"
    );
    Ok(())
}

fn solved_overlap_count(
    evidence: &AlignmentMergeEvidenceReport,
    left: &EntityId,
    right: &EntityId,
) -> u64 {
    evidence
        .overlap
        .iter()
        .find(|item| {
            (&item.alignment_a == left && &item.alignment_b == right)
                || (&item.alignment_a == right && &item.alignment_b == left)
        })
        .map_or(0, |item| item.verified_cross_run_track_count)
}

#[allow(clippy::too_many_arguments)]
fn commit_domain_entity_change(
    session: &mut ProjectSession,
    mut candidate: PhotolabProjectManifest,
    now: u64,
    command_kind: &str,
    payload: serde_json::Value,
    affected_entities: Vec<EntityId>,
    after_refs: Vec<ObjectHash>,
    message: &str,
) -> Result<OpenPhotolabProjectResult> {
    candidate.command_sequence = candidate.command_sequence.saturating_add(1);
    candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
    candidate.modified_unix_ms = now;
    candidate.clean_shutdown = false;
    let journal = PhotolabJournalEntry {
        sequence: candidate.command_sequence,
        command_id: unique_id("domain-create", now),
        command_kind: command_kind.into(),
        timestamp_unix_ms: now,
        state: JournalCommandState::Committed,
        payload,
        affected_entities,
        before_refs: Vec::new(),
        after_refs,
        message: Some(message.into()),
    };
    write_journal_entry(&session.working_path, &journal)?;
    atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
    session.manifest = candidate;
    Ok(session.result())
}

fn update_camera_product_tags(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    camera_entity_ids: &[String],
    alignment_completed: bool,
    depth_completed: bool,
    after_refs: &mut Vec<ObjectHash>,
) -> Result<()> {
    if !alignment_completed && !depth_completed {
        return Ok(());
    }
    let camera_ids = validate_camera_scope(manifest, camera_entity_ids)?;
    for camera_id in camera_ids {
        let entity = manifest
            .entities
            .get(&camera_id)
            .context("camera disappeared during tag update")?;
        let metadata_path = project_object_path(project_root, &entity.version_hash);
        let bytes = fs::read(&metadata_path)?;
        if ObjectHash::of_bytes(&bytes) != entity.version_hash {
            anyhow::bail!("camera metadata object hash mismatch");
        }
        let mut metadata: CameraImageMetadataRecord = serde_json::from_slice(&bytes)?;
        if alignment_completed {
            metadata.status_tags.insert(ImageProductTag::Aligned);
            if metadata.status_tags.remove(&ImageProductTag::DepthReady) {
                metadata.status_tags.insert(ImageProductTag::DepthStale);
            }
        }
        if depth_completed {
            metadata.status_tags.insert(ImageProductTag::Aligned);
            metadata.status_tags.remove(&ImageProductTag::DepthStale);
            metadata.status_tags.insert(ImageProductTag::DepthReady);
        }
        let metadata_bytes = serde_json::to_vec(&metadata)?;
        let version_hash = put_project_object(project_root, &metadata_bytes)?;
        manifest
            .entities
            .get_mut(&camera_id)
            .context("camera disappeared before tag publication")?
            .version_hash = version_hash.clone();
        after_refs.push(version_hash);
    }
    Ok(())
}

fn put_project_object(project_root: &Path, bytes: &[u8]) -> Result<ObjectHash> {
    let hash = ObjectHash::of_bytes(bytes);
    let path = project_object_path(project_root, &hash);
    if !path.is_file() {
        atomic_write_bytes(&path, bytes)?;
    }
    Ok(hash)
}

fn project_object_path(project_root: &Path, hash: &ObjectHash) -> PathBuf {
    let (prefix, remainder) = hash.as_str().split_at(2);
    project_root.join("objects").join(prefix).join(remainder)
}

fn dataset_protocol_relative(relative_path: &str) -> Result<PathBuf> {
    let path = Path::new(relative_path);
    anyhow::ensure!(
        !path.is_absolute()
            && !path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir)),
        "product dataset path is unsafe"
    );
    path.strip_prefix("datasets")
        .map(Path::to_path_buf)
        .context("product dataset path is outside datasets")
}

fn ensure_writable(session: &ProjectSession) -> Result<()> {
    if session.read_only {
        anyhow::bail!("project is open read-only");
    }
    Ok(())
}

fn validate_manifest(manifest: &PhotolabProjectManifest) -> Result<()> {
    if manifest.format_version != PHOTOLAB_PROJECT_FORMAT_VERSION {
        anyhow::bail!(
            "unsupported project format version {}; expected {}",
            manifest.format_version,
            PHOTOLAB_PROJECT_FORMAT_VERSION
        );
    }
    if !manifest.entities.contains_key(&manifest.root_entity.0) {
        anyhow::bail!("manifest root entity is missing");
    }
    Ok(())
}

fn read_manifest(path: &Path) -> Result<PhotolabProjectManifest> {
    let manifest_path = path.join("manifest.json");
    let bytes = fs::read(&manifest_path)
        .with_context(|| format!("failed to read {}", manifest_path.display()))?;
    let mut manifest: PhotolabProjectManifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid project manifest {}", manifest_path.display()))?;
    // `spatialReference` was introduced after `referenceFrame`. Preserve the
    // meaning of existing georeferenced projects instead of accepting the
    // serde default (`localMetric`) alongside an established CRS frame.
    if manifest.reference_frame.is_some() {
        manifest.spatial_reference =
            himmelcad_core::photolab_capture::PhotolabSpatialReference::CrsBacked;
    }
    if manifest.coordinate_axis_contract_version < 2 {
        normalize_legacy_coordinate_axes(path, &mut manifest)?;
        manifest.coordinate_axis_contract_version = 2;
    }
    for entity in manifest.entities.values_mut() {
        if entity.name == "Produkte" {
            entity.name = "Products".to_owned();
        } else if let Some(suffix) = entity.name.strip_prefix("Referenz & GCPs") {
            entity.name = format!("Reference & GCPs{suffix}");
        } else if let Some(suffix) = entity.name.strip_prefix("Texturiertes Mesh") {
            entity.name = format!("Textured Mesh{suffix}");
        }
    }
    Ok(manifest)
}

fn normalize_legacy_coordinate_axes(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
) -> Result<()> {
    let Some(reference_frame) = manifest.reference_frame.as_ref() else {
        return Ok(());
    };
    let legacy_camera = manifest
        .entities
        .values()
        .find(|entity| entity.kind == EntityKind::CameraImage)
        .and_then(|entity| fs::read(project_object_path(project_root, &entity.version_hash)).ok())
        .and_then(|bytes| serde_json::from_slice::<CameraImageMetadataRecord>(&bytes).ok())
        .is_some_and(|metadata| metadata.schema_version == 1);
    if !legacy_camera {
        return Ok(());
    }
    let transformation_path = project_object_path(
        project_root,
        &reference_frame.established_by_transformation_sha256,
    );
    let transformation_bytes = fs::read(&transformation_path).with_context(|| {
        format!(
            "failed to read legacy coordinate transformation {}",
            transformation_path.display()
        )
    })?;
    let transformation: FrozenImportTransformation = serde_json::from_slice(&transformation_bytes)
        .with_context(|| format!("invalid transformation {}", transformation_path.display()))?;
    if pipeline_ends_with_axis_swap(&transformation.pipeline.proj_pipeline) {
        std::mem::swap(&mut manifest.render_offset.x, &mut manifest.render_offset.y);
    }
    Ok(())
}

fn pipeline_ends_with_axis_swap(pipeline: &str) -> bool {
    pipeline.rsplit("+step").next().is_some_and(|last| {
        last.split_ascii_whitespace()
            .any(|token| token == "+proj=axisswap")
            && last
                .split_ascii_whitespace()
                .any(|token| token == "+order=2,1")
    })
}

fn ensure_project_directories(root: &Path) -> Result<()> {
    fs::create_dir_all(root)?;
    for child in ["objects", "journal", "index", "previews", "tmp", "sources"] {
        fs::create_dir_all(root.join(child))?;
    }
    Ok(())
}

fn acquire_lock(
    path: &Path,
    session_id: &str,
    source_path: &Path,
) -> Result<(Arc<File>, ProjectLeaseRecord)> {
    let guard_path = project_lock_guard_path(path);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    options.share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004);
    let lock = options
        .open(&guard_path)
        .with_context(|| format!("project lock cannot be opened: {}", guard_path.display()))?;
    if let Err(error) = lock.try_lock_exclusive() {
        anyhow::bail!(
            "project is already locked/open: {} ({error}). {}",
            path.display(),
            active_lease_description(path)
        );
    }
    let opened_unix_ms = unix_ms()?;
    let lease = ProjectLeaseRecord {
        schema_version: PROJECT_LEASE_SCHEMA_VERSION,
        session_id: session_id.to_owned(),
        host_name: current_host_name(),
        user_name: current_user_name(),
        process_id: std::process::id(),
        process_name: current_process_name(),
        source_fingerprint: source_fingerprint(source_path)?,
        opened_unix_ms,
        heartbeat_unix_ms: opened_unix_ms,
    };
    write_lease_record(path, &lease)?;
    Ok((Arc::new(lock), lease))
}

fn write_lease_record(path: &Path, lease: &ProjectLeaseRecord) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(lease)?;
    bytes.push(b'\n');
    let mut writer = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    writer.write_all(&bytes)?;
    writer.sync_data()?;
    Ok(())
}

fn active_lease_description(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return "The active lease owner could not be read; wait for the other session to close or open a separate copy.".to_owned();
    };
    if let Ok(lease) = serde_json::from_slice::<ProjectLeaseRecord>(&bytes) {
        return format!(
            "Active lease belongs to user '{}' on host '{}' (process {} '{}', session '{}', heartbeat {}). Wait for that session to close or open a separate copy.",
            lease.user_name,
            lease.host_name,
            lease.process_id,
            lease.process_name,
            lease.session_id,
            lease.heartbeat_unix_ms
        );
    }
    "An active legacy lease exists; wait for the other session to close or open a separate copy."
        .to_owned()
}

fn source_fingerprint(source_path: &Path) -> Result<ProjectSourceFingerprint> {
    if !source_path.exists() {
        return Ok(ProjectSourceFingerprint {
            kind: ProjectSourceFingerprintKind::Missing,
            sha256: ObjectHash::of_bytes(path_string(source_path).as_bytes()),
            byte_size: 0,
        });
    }
    let (kind, path) = if is_hcadx_path(source_path) {
        (
            ProjectSourceFingerprintKind::Archive,
            source_path.to_path_buf(),
        )
    } else {
        (
            ProjectSourceFingerprintKind::Manifest,
            source_path.join("manifest.json"),
        )
    };
    let file = File::open(&path)
        .with_context(|| format!("failed to fingerprint project source {}", path.display()))?;
    let mut reader = BufReader::with_capacity(SOURCE_HASH_BUFFER_BYTES, file);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; SOURCE_HASH_BUFFER_BYTES].into_boxed_slice();
    let mut byte_size = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        byte_size = byte_size.saturating_add(u64::try_from(read)?);
    }
    Ok(ProjectSourceFingerprint {
        kind,
        sha256: ObjectHash(hex::encode(digest.finalize())),
        byte_size,
    })
}

fn current_host_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "unknown-host".to_owned())
}

fn current_user_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown-user".to_owned())
}

fn current_process_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "himmelcad-sidecar".to_owned())
}

fn release_lock(lock: &File, path: &Path, session_id: &str) -> Result<()> {
    if !path.exists() {
        FileExt::unlock(lock)?;
        return Ok(());
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    if value["sessionId"] != session_id {
        anyhow::bail!("refusing to remove a project lock owned by another session");
    }
    FileExt::unlock(lock)?;
    fs::remove_file(path)?;
    Ok(())
}

fn project_lock_guard_path(lease_path: &Path) -> PathBuf {
    let parent = lease_path.parent().unwrap_or_else(|| Path::new("."));
    let lease_name = lease_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project.lock");
    parent.join(format!("{lease_name}.guard"))
}

fn write_journal_entry(root: &Path, entry: &PhotolabJournalEntry) -> Result<()> {
    let path = root
        .join("journal")
        .join(format!("{:016}.json", entry.sequence));
    atomic_write_json(&path, entry)
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write_bytes(path, &bytes)
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("target path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("write"),
        unique_id("atomic", unix_ms()?)
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path).with_context(|| {
        format!(
            "failed to atomically commit {} to {}",
            temporary.display(),
            path.display()
        )
    })?;
    sync_parent_directory(path)?;
    Ok(())
}

fn copy_project_incremental(source: &Path, destination: &Path) -> Result<()> {
    ensure_project_directories(destination)?;
    copy_directory_contents(source, destination, false)?;
    let source_manifest = source.join("manifest.json");
    if source_manifest.is_file() {
        let bytes = fs::read(source_manifest)?;
        atomic_write_bytes(&destination.join("manifest.json"), &bytes)?;
    }
    Ok(())
}

fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    include_manifest: bool,
) -> Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name == "project.lock"
            || name == ".project.lock"
            || name == "tmp"
            || (!include_manifest && name == "manifest.json")
        {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(&file_name);
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&destination_path)?;
            copy_directory_contents(&source_path, &destination_path, true)?;
        } else if should_copy(&source_path, &destination_path)? {
            fs::copy(&source_path, &destination_path).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn should_copy(source: &Path, destination: &Path) -> Result<bool> {
    if !destination.exists() {
        return Ok(true);
    }
    let source_metadata = fs::metadata(source)?;
    let destination_metadata = fs::metadata(destination)?;
    Ok(source_metadata.len() != destination_metadata.len()
        || source_metadata.modified()? > destination_metadata.modified()?)
}

fn save_archive_session(
    session: &mut ProjectSession,
    destination: &Path,
    overwrite: bool,
    include_rebuildable_index: bool,
    active_operation: Option<(&str, &CancellationToken)>,
    progress_key: Option<&str>,
) -> Result<()> {
    let owned_cancellation = CancellationToken::new();
    let (operation_id, cancellation) =
        active_operation.unwrap_or(("archive-save", &owned_cancellation));
    let candidate = archive_candidate_path(destination)?;
    remove_path_if_exists(&candidate)?;

    let mut archived_manifest = session.manifest.clone();
    archived_manifest.clean_shutdown = true;
    archived_manifest.modified_unix_ms = unix_ms()?;
    atomic_write_json(
        &session.working_path.join("manifest.json"),
        &archived_manifest,
    )?;
    let pack_result = pack_hcadx(
        &session.working_path,
        &candidate,
        PackArchiveOptions {
            include_rebuildable_index,
        },
        cancellation,
        |progress| emit_archive_progress(progress_key, operation_id, &progress),
    );
    let restore_result = atomic_write_json(
        &session.working_path.join("manifest.json"),
        &session.manifest,
    );
    if let Err(error) = pack_result {
        remove_path_if_exists(&candidate)?;
        restore_result.context("failed to restore live manifest after archive failure")?;
        return Err(error.into());
    }
    if let Err(error) = restore_result {
        remove_path_if_exists(&candidate)?;
        return Err(error).context("failed to restore live manifest after archive creation");
    }
    if destination == session.source_path {
        if let Err(error) = ensure_source_unchanged(session) {
            remove_path_if_exists(&candidate)?;
            return Err(error).context(
                "project source changed while the replacement archive was being prepared",
            );
        }
    }
    publish_archive_candidate(&candidate, destination, overwrite)?;
    Ok(())
}

fn publish_archive_candidate(candidate: &Path, destination: &Path, overwrite: bool) -> Result<()> {
    if !destination.exists() {
        fs::rename(candidate, destination).with_context(|| {
            format!(
                "failed to publish archive {} to {}",
                candidate.display(),
                destination.display()
            )
        })?;
        sync_parent_directory(destination)?;
        return Ok(());
    }
    if !overwrite {
        remove_path_if_exists(candidate)?;
        anyhow::bail!(
            "archive destination already exists: {}",
            destination.display()
        );
    }

    replace_existing_archive(candidate, destination)
}

#[cfg(unix)]
fn replace_existing_archive(candidate: &Path, destination: &Path) -> Result<()> {
    fs::rename(candidate, destination).with_context(|| {
        format!(
            "failed to atomically replace archive {}",
            destination.display()
        )
    })?;
    sync_parent_directory(destination)
}

#[cfg(not(unix))]
fn replace_existing_archive(candidate: &Path, destination: &Path) -> Result<()> {
    let backup = archive_backup_path(destination)?;
    remove_path_if_exists(&backup)?;
    fs::rename(destination, &backup).with_context(|| {
        format!(
            "failed to preserve existing archive {}",
            destination.display()
        )
    })?;
    if let Err(error) = fs::rename(candidate, destination) {
        let restore = fs::rename(&backup, destination);
        return match restore {
            Ok(()) => Err(error)
                .with_context(|| format!("failed to replace archive {}", destination.display())),
            Err(restore_error) => anyhow::bail!(
                "failed to replace archive {} ({error}); previous archive remains at {} and could not be restored ({restore_error})",
                destination.display(),
                backup.display()
            ),
        };
    }
    if let Err(error) = fs::remove_file(&backup) {
        tracing::warn!(
            path = %backup.display(),
            %error,
            "new archive is valid but replaced archive backup could not be removed"
        );
    }
    sync_parent_directory(destination)?;
    Ok(())
}

fn archive_candidate_path(destination: &Path) -> Result<PathBuf> {
    sibling_operation_path(destination, "candidate")
}

#[cfg(not(unix))]
fn archive_backup_path(destination: &Path) -> Result<PathBuf> {
    sibling_operation_path(destination, "backup")
}

fn sibling_operation_path(destination: &Path, marker: &str) -> Result<PathBuf> {
    let parent = destination.parent().context("archive path has no parent")?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .context("archive path is not valid UTF-8")?;
    Ok(parent.join(format!(
        ".{name}.{marker}-{}",
        unique_id("archive-file", unix_ms()?)
    )))
}

fn remove_path_if_exists(path: &Path) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn project_lock_path(source_path: &Path) -> PathBuf {
    if is_hcadx_path(source_path) {
        let parent = source_path.parent().unwrap_or_else(|| Path::new("."));
        let name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("photolab.hcadx");
        parent.join(format!(".{name}.lock"))
    } else {
        source_path.join(".project.lock")
    }
}

fn default_archive_limits() -> UnpackArchiveLimits {
    UnpackArchiveLimits {
        max_entries: 1_000_000,
        max_declared_bytes: 4 * 1024 * 1024 * 1024 * 1024,
    }
}

#[allow(clippy::cast_precision_loss)]
fn emit_archive_progress(
    progress_key: Option<&str>,
    operation_id: &str,
    progress: &ArchiveProgress,
) {
    let Some(progress_key) = progress_key else {
        return;
    };
    let phase_fraction = if progress.bytes_total == 0 {
        if progress.files_total == 0 {
            1.0
        } else {
            progress.files_completed as f64 / progress.files_total as f64
        }
    } else {
        progress.bytes_completed as f64 / progress.bytes_total as f64
    };
    let fraction = archive_overall_fraction(progress.phase, phase_fraction);
    let phase_label = match progress.phase {
        ArchivePhase::Scanning => "Scanning project",
        ArchivePhase::Packing => "Writing project archive",
        ArchivePhase::Validating => "Validating project archive",
        ArchivePhase::Extracting => "Extracting project archive",
        ArchivePhase::Committing => "Publishing project atomically",
    };
    let payload = serde_json::json!({
        "progressKey": progress_key,
        "operationId": operation_id,
        "fraction": fraction,
        "message": phase_label,
        "archive": progress,
    });
    eprintln!("__HC_PROGRESS__{payload}");
}

/// Maps the two archive phase sequences onto one monotonic user-facing scale.
/// Packing runs `scanning -> packing -> committing`; opening runs
/// `validating -> extracting -> committing`. Raw byte fractions restart at a
/// phase boundary and therefore must never be exposed as overall progress.
fn archive_overall_fraction(phase: ArchivePhase, phase_fraction: f64) -> f64 {
    let phase_fraction = phase_fraction.clamp(0.0, 1.0);
    match phase {
        ArchivePhase::Scanning => 0.02,
        ArchivePhase::Packing => 0.05 + phase_fraction * 0.9,
        ArchivePhase::Validating => 0.12,
        ArchivePhase::Extracting => 0.12 + phase_fraction * 0.83,
        ArchivePhase::Committing => 1.0,
    }
}

fn validate_archive_operation_id(operation_id: &str) -> Result<()> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'))
    {
        anyhow::bail!("invalid archive operation id");
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<()> {
    File::open(path.parent().context("archive path has no parent")?)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn is_hcadx_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("hcadx"))
}

fn normalize_hcadx_path(path: &Path) -> PathBuf {
    if is_hcadx_path(path) {
        path.to_path_buf()
    } else {
        PathBuf::from(format!("{}.hcadx", path.display()))
    }
}

fn canonicalize_archive_destination(path: &Path) -> Result<PathBuf> {
    let normalized = normalize_hcadx_path(path);
    let parent = normalized
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let canonical_parent = fs::canonicalize(parent).with_context(|| {
        format!(
            "failed to resolve archive destination directory {}",
            parent.display()
        )
    })?;
    Ok(canonical_parent.join(
        normalized
            .file_name()
            .context("archive destination has no file name")?,
    ))
}

fn normalize_hcad_path(path: &Path) -> PathBuf {
    if path
        .extension()
        .is_some_and(|extension| extension == "hcad")
    {
        path.to_path_buf()
    } else {
        PathBuf::from(format!("{}.hcad", path.display()))
    }
}

fn unique_id(prefix: &str, timestamp: u64) -> String {
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{prefix}:{timestamp}:{}:{counter}", std::process::id());
    format!(
        "{prefix}-{}",
        ObjectHash::of_bytes(seed.as_bytes()).as_str()
    )
}

fn unix_ms() -> Result<u64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?;
    u64::try_from(duration.as_millis()).context("timestamp does not fit into u64")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Set project + root-group display name from an archive path stem (`MySurvey.hcadx` → `MySurvey`).
fn apply_project_display_name_from_path(session: &mut ProjectSession, path: &Path) -> Result<()> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("PhotoLab Project");
    let name = stem.to_owned();
    if session.manifest.name == name {
        return Ok(());
    }
    session.manifest.name = name.clone();
    session.manifest.modified_unix_ms = unix_ms()?;
    session.manifest.autosave_generation = session.manifest.autosave_generation.saturating_add(1);
    if let Some(root) = session
        .manifest
        .entities
        .get_mut(&session.manifest.root_entity.0)
    {
        root.name = name;
    }
    atomic_write_json(
        &session.working_path.join("manifest.json"),
        &session.manifest,
    )?;
    Ok(())
}

fn safe_export_stem(name: &str) -> String {
    let mut output = String::with_capacity(name.len().min(80));
    for character in name.chars().take(80) {
        if character.is_alphanumeric() || matches!(character, ' ' | '-' | '_') {
            output.push(character);
        } else {
            output.push('_');
        }
    }
    let trimmed = output.trim_matches([' ', '.', '_']);
    if trimmed.is_empty() {
        "PhotoLab product".into()
    } else {
        trimmed.into()
    }
}

fn camera_export_groups(
    groups: &[ColmapCalibrationGroup],
    refinement: ColmapIntrinsicsRefinement,
) -> Vec<CameraCalibrationExportGroup> {
    groups
        .iter()
        .map(|group| CameraCalibrationExportGroup {
            group_id: group.group_id.clone(),
            camera_entity_ids: group.camera_entity_ids.clone(),
            intrinsics_refinement: refinement,
        })
        .collect()
}

fn merged_camera_export_groups(
    session: &ProjectSession,
    merge: &MergedAlignmentRunRecord,
) -> Result<Vec<CameraCalibrationExportGroup>> {
    let mut inputs = Vec::new();
    for entity_id in &merge.input_alignment_entity_ids {
        let entity = session
            .manifest
            .entities
            .get(&entity_id.0)
            .with_context(|| format!("missing input alignment {}", entity_id.0))?;
        anyhow::ensure!(
            entity.kind == EntityKind::AlignmentRun,
            "merged camera export input is not an alignment"
        );
        let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
        let record: ComputeArtifactRecord = serde_json::from_slice(&bytes)?;
        inputs.extend(camera_export_groups(
            &record.calibration_groups,
            recorded_intrinsics_refinement(&record)?,
        ));
    }
    if merge
        .connections
        .iter()
        .all(|connection| matches!(connection, AlignmentMergeConnection::SharedControls { .. }))
    {
        return Ok(inputs);
    }
    // Joint overlap solves use one run-wide policy and receive their calibration groups in
    // deterministic project-id order.
    inputs.sort_by(|left, right| left.group_id.cmp(&right.group_id));
    let refinement = if inputs.iter().any(|group| {
        group.intrinsics_refinement == ColmapIntrinsicsRefinement::FreezeReliableEmbedded
    }) {
        ColmapIntrinsicsRefinement::FreezeReliableEmbedded
    } else {
        ColmapIntrinsicsRefinement::Refine
    };
    for group in &mut inputs {
        group.intrinsics_refinement = refinement;
    }
    Ok(inputs)
}

fn recorded_intrinsics_refinement(
    record: &ComputeArtifactRecord,
) -> Result<ColmapIntrinsicsRefinement> {
    anyhow::ensure!(
        record.schema_version >= 3,
        "legacy alignment does not record which calibration parameters were refined; rerun alignment before camera export"
    );
    Ok(record.intrinsics_refinement)
}

const fn default_true() -> bool {
    true
}

const AUTOMATIC_CAPTURE_GAP_SECONDS: i64 = 120;

#[derive(Debug, Clone)]
struct AutomaticCameraCandidate {
    entity_id: EntityId,
    name: String,
    source_directory: String,
    hardware_label: String,
    capture_time_label: Option<String>,
    capture_time_seconds: Option<i64>,
    calibration_seed: Option<CameraCalibrationSeed>,
}

fn automatic_capture_groups_for_import(
    session: &ProjectSession,
    imported_camera_ids: &[EntityId],
) -> Result<Vec<AutomaticCaptureGroup>> {
    let mut assigned = BTreeSet::new();
    for entity in session
        .manifest
        .entities
        .values()
        .filter(|entity| entity.kind == EntityKind::CameraCalibrationGroup)
    {
        let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
        let group: CameraCalibrationGroupRecord = serde_json::from_slice(&bytes)?;
        assigned.extend(group.camera_entity_ids.into_iter().map(|id| id.0));
    }
    let mut buckets = BTreeMap::<String, Vec<AutomaticCameraCandidate>>::new();
    for entity_id in imported_camera_ids {
        if assigned.contains(&entity_id.0) {
            continue;
        }
        let Some(entity) = session.manifest.entities.get(&entity_id.0) else {
            continue;
        };
        if entity.kind != EntityKind::CameraImage {
            continue;
        }
        let bytes = read_verified_object(&session.working_path, &entity.version_hash)?;
        let metadata: CameraImageMetadataRecord = serde_json::from_slice(&bytes)?;
        let photo = &metadata.inspected_photo;
        let exif = &photo.metadata.exif;
        let source_directory = Path::new(&photo.source_path)
            .parent()
            .map_or_else(String::new, |path| path.to_string_lossy().into_owned());
        let make = normalized_metadata_component(exif.make.as_deref(), "unknown make");
        let model = normalized_metadata_component(exif.model.as_deref(), "unknown model");
        let lens = normalized_metadata_component(exif.lens_model.as_deref(), "fixed lens");
        let dimensions = exif.dimensions.map_or_else(
            || "unknown-size".into(),
            |value| format!("{}x{}", value.width_pixels, value.height_pixels),
        );
        let focal = exif
            .focal_length_mm
            .filter(|value| value.is_finite() && *value > 0.0)
            .map_or_else(|| "unknown-focal".into(), |value| format!("{value:.2}"));
        let hardware_key = format!("{source_directory}|{make}|{model}|{lens}|{dimensions}|{focal}");
        let hardware_label = format!("{make} {model} · {lens} · {focal} mm");
        let capture_time_label = exif.captured_at.as_ref().map(|value| value.value.clone());
        let capture_time_seconds = capture_time_label
            .as_deref()
            .and_then(parse_capture_time_seconds);
        let calibration_seed = embedded_calibration_seed(&metadata);
        buckets
            .entry(hardware_key)
            .or_default()
            .push(AutomaticCameraCandidate {
                entity_id: entity_id.clone(),
                name: entity.name.clone(),
                source_directory,
                hardware_label,
                capture_time_label,
                capture_time_seconds,
                calibration_seed,
            });
    }

    let mut sessions = Vec::new();
    for mut cameras in buckets.into_values() {
        cameras.sort_by(|left, right| {
            left.capture_time_seconds
                .cmp(&right.capture_time_seconds)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.entity_id.0.cmp(&right.entity_id.0))
        });
        let mut current = Vec::new();
        let mut previous_time = None;
        for camera in cameras {
            let begins_new_session = match (previous_time, camera.capture_time_seconds) {
                (Some(previous), Some(current)) => {
                    current.saturating_sub(previous) > AUTOMATIC_CAPTURE_GAP_SECONDS
                }
                _ => false,
            };
            if begins_new_session && !current.is_empty() {
                sessions.push(std::mem::take(&mut current));
            }
            previous_time = camera.capture_time_seconds;
            current.push(camera);
        }
        if !current.is_empty() {
            sessions.push(current);
        }
    }

    let mut proposals = Vec::new();
    for (session_index, cameras) in sessions.into_iter().enumerate() {
        if cameras.len() < 2 {
            continue;
        }
        let first = &cameras[0];
        let last = &cameras[cameras.len() - 1];
        let mut evidence = vec![format!("Camera/lens: {}", first.hardware_label)];
        if !first.source_directory.is_empty() {
            evidence.push(format!("Source folder: {}", first.source_directory));
        }
        if let (Some(start), Some(end)) = (
            first.capture_time_label.as_deref(),
            last.capture_time_label.as_deref(),
        ) {
            evidence.push(format!("Continuous capture: {start} – {end}"));
        } else {
            evidence.push("Capture timestamps unavailable; folder and camera metadata only".into());
        }
        let name = first
            .capture_time_label
            .as_deref()
            .and_then(|value| value.get(..16))
            .map_or_else(
                || format!("Detected capture {}", session_index + 1),
                |value| format!("Capture {value}"),
            );
        proposals.push(AutomaticCaptureGroup {
            name,
            camera_entity_ids: cameras
                .iter()
                .map(|camera| camera.entity_id.clone())
                .collect(),
            calibration_groups: automatic_calibration_groups(&cameras),
            evidence,
        });
    }
    Ok(proposals)
}

fn automatic_calibration_groups(
    cameras: &[AutomaticCameraCandidate],
) -> Vec<AutomaticCalibrationGroup> {
    let mut groups = Vec::<Vec<&AutomaticCameraCandidate>>::new();
    for camera in cameras {
        let matching = groups.iter().position(|group| {
            calibration_seeds_compatible(
                group[0].calibration_seed.as_ref(),
                camera.calibration_seed.as_ref(),
            )
        });
        if let Some(index) = matching {
            groups[index].push(camera);
        } else {
            groups.push(vec![camera]);
        }
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(index, members)| {
            let seeds = members
                .iter()
                .filter_map(|camera| camera.calibration_seed.as_ref())
                .collect::<Vec<_>>();
            let initial_calibration = averaged_calibration_seed(&seeds);
            let embedded = initial_calibration.is_some() && seeds.len() == members.len();
            let evidence = if let Some(seed) = initial_calibration.as_ref() {
                let mut evidence = vec![format!(
                    "Embedded calibration: {:.2} px focal, {:.2}/{:.2} px principal point",
                    seed.focal_pixels.unwrap_or_default(),
                    seed.principal_x_pixels.unwrap_or_default(),
                    seed.principal_y_pixels.unwrap_or_default()
                )];
                if let Some(full) = &seed.full_brown_calibration {
                    evidence.push(format!(
                        "DJI DewarpData {}: full Brown-Conrady calibration",
                        full.calibration_date
                    ));
                }
                evidence
            } else {
                vec![
                    "No embedded calibration; shared camera/lens and continuous capture only"
                        .into(),
                ]
            };
            AutomaticCalibrationGroup {
                name: format!("Intrinsics {}", index + 1),
                camera_entity_ids: members
                    .into_iter()
                    .map(|camera| camera.entity_id.clone())
                    .collect(),
                grouping_basis: if embedded {
                    CameraCalibrationGroupingBasis::EmbeddedCalibration
                } else {
                    CameraCalibrationGroupingBasis::MissionAutofocus
                },
                initial_calibration,
                evidence,
            }
        })
        .collect()
}

fn embedded_calibration_seed(
    metadata: &CameraImageMetadataRecord,
) -> Option<CameraCalibrationSeed> {
    let dimensions = metadata.inspected_photo.metadata.exif.dimensions?;
    let dji = &metadata.inspected_photo.metadata.dji_xmp;
    if let Some(calibration) = dji
        .dewarp_calibration
        .as_ref()
        .filter(|calibration| calibration.is_valid_for_dimensions(dimensions))
    {
        return Some(CameraCalibrationSeed {
            width_pixels: dimensions.width_pixels,
            height_pixels: dimensions.height_pixels,
            focal_pixels: Some(calibration.focal_x_pixels),
            principal_x_pixels: Some(calibration.principal_x_pixels),
            principal_y_pixels: Some(calibration.principal_y_pixels),
            full_brown_calibration: Some(calibration.clone()),
        });
    }
    let focal = dji.calibrated_focal_length_pixels?;
    let principal_x = dji.calibrated_optical_center_x_pixels?;
    let principal_y = dji.calibrated_optical_center_y_pixels?;
    (focal.is_finite() && principal_x.is_finite() && principal_y.is_finite() && focal > 0.0)
        .then_some(CameraCalibrationSeed {
            width_pixels: dimensions.width_pixels,
            height_pixels: dimensions.height_pixels,
            focal_pixels: Some(focal),
            principal_x_pixels: Some(principal_x),
            principal_y_pixels: Some(principal_y),
            full_brown_calibration: None,
        })
}

fn calibration_seeds_compatible(
    left: Option<&CameraCalibrationSeed>,
    right: Option<&CameraCalibrationSeed>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            if left.width_pixels != right.width_pixels || left.height_pixels != right.height_pixels
            {
                return false;
            }
            match (
                left.full_brown_calibration.as_ref(),
                right.full_brown_calibration.as_ref(),
            ) {
                (Some(left), Some(right)) if left != right => return false,
                (Some(_), None) | (None, Some(_)) => return false,
                _ => {}
            }
            let (Some(left_focal), Some(right_focal)) = (left.focal_pixels, right.focal_pixels)
            else {
                return false;
            };
            let focal_tolerance = (left_focal.abs() * 0.001).max(2.0);
            (left_focal - right_focal).abs() <= focal_tolerance
                && option_difference_within(left.principal_x_pixels, right.principal_x_pixels, 2.0)
                && option_difference_within(left.principal_y_pixels, right.principal_y_pixels, 2.0)
        }
        _ => false,
    }
}

fn option_difference_within(left: Option<f64>, right: Option<f64>, tolerance: f64) -> bool {
    matches!((left, right), (Some(left), Some(right)) if (left - right).abs() <= tolerance)
}

fn averaged_calibration_seed(seeds: &[&CameraCalibrationSeed]) -> Option<CameraCalibrationSeed> {
    let first = *seeds.first()?;
    let count = seeds.len() as f64;
    Some(CameraCalibrationSeed {
        width_pixels: first.width_pixels,
        height_pixels: first.height_pixels,
        focal_pixels: Some(
            seeds
                .iter()
                .filter_map(|seed| seed.focal_pixels)
                .sum::<f64>()
                / count,
        ),
        principal_x_pixels: Some(
            seeds
                .iter()
                .filter_map(|seed| seed.principal_x_pixels)
                .sum::<f64>()
                / count,
        ),
        principal_y_pixels: Some(
            seeds
                .iter()
                .filter_map(|seed| seed.principal_y_pixels)
                .sum::<f64>()
                / count,
        ),
        full_brown_calibration: first.full_brown_calibration.clone(),
    })
}

fn normalized_metadata_component(value: Option<&str>, fallback: &str) -> String {
    let value = value.unwrap_or(fallback).trim().to_ascii_lowercase();
    if value.is_empty() {
        fallback.into()
    } else {
        value
    }
}

fn parse_capture_time_seconds(value: &str) -> Option<i64> {
    let digits = value
        .chars()
        .filter(|value| value.is_ascii_digit())
        .take(14)
        .collect::<String>();
    if digits.len() != 14 {
        return None;
    }
    let parse = |range: std::ops::Range<usize>| digits.get(range)?.parse::<i64>().ok();
    let year = parse(0..4)?;
    let month = parse(4..6)?;
    let day = parse(6..8)?;
    let hour = parse(8..10)?;
    let minute = parse(10..12)?;
    let second = parse(12..14)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::photolab_images::{
        CaptureTime, CaptureTimeReference, DiscoveredPhoto, ImageDimensions, PhotoFormat,
        PhotoMetadata,
    };
    use himmelcad_core::photolab_jobs::{
        CheckpointDescriptor, CheckpointId, JobProgress, NewPendingCheckpoint, NewPhotolabJob,
        PhotolabJobId, PhotolabJobKind, PhotolabStage, PhotolabStageKind, ProgressMetrics,
    };
    use himmelcad_sidecar::colmap_runtime::{ColmapOutputSummary, SelectedFeatureStore};
    use himmelcad_sidecar::job_runtime::{JobManager, JobManagerConfig, JobWorkerError};
    use himmelcad_sidecar::mvs_runtime::{MvsCommandReport, MvsComputeDevice, MvsDenseCloudRecord};
    use himmelcad_sidecar::prepared_triangle_mesh::{
        build_prepared_textured_triangle_mesh, build_prepared_triangle_mesh,
        PreparedTriangleMeshOptions, TriangleRecord,
    };

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clean_shutdown_waits_for_the_running_job_drain() {
        let root = temp_test_dir("clean-shutdown-drain");
        let project = root.join("drain.hcad");
        let runtime = Arc::new(ProjectRuntime::default());
        runtime
            .create(CreateProjectParams {
                path: path_string(&project),
                name: "Drain lifecycle".into(),
            })
            .expect("project");
        let manager = Arc::new(
            JobManager::new_with_history(
                JobManagerConfig {
                    max_concurrency: 1,
                    max_queued: 0,
                },
                runtime.clone(),
            )
            .expect("job manager"),
        );
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (cancelled_tx, cancelled_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let job_id = PhotolabJobId("close-running-job".into());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::AlignPhotos,
                    config_hash: ObjectHash::of_bytes(b"close-config"),
                    input_hash: ObjectHash::of_bytes(b"close-input"),
                    progress: JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::FeatureExtraction,
                            index: 0,
                            stage_count: 1,
                            label: "Slow close fixture".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    },
                },
                move |context| {
                    started_tx.send(()).expect("worker start signal");
                    while !context.cancellation.is_cancel_requested() {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    cancelled_tx.send(()).expect("cancel observed signal");
                    release_rx.recv().expect("release worker");
                    Err(JobWorkerError::Cancelled)
                },
            )
            .await
            .expect("start slow job");
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker started");

        let draining_manager = manager.clone();
        let drain_task =
            tokio::spawn(async move { draining_manager.drain(Duration::from_secs(2)).await });
        cancelled_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker observed cancellation");
        assert!(
            !read_manifest(&project)
                .expect("active manifest")
                .clean_shutdown
        );
        assert!(runtime
            .close_after_drain(
                &DrainReport {
                    terminal: 0,
                    timed_out: vec![job_id],
                },
                &SideOperationDrainReport::default(),
            )
            .is_err());
        assert!(
            !read_manifest(&project)
                .expect("refused close manifest")
                .clean_shutdown
        );

        release_tx.send(()).expect("release worker");
        let report = drain_task.await.expect("drain task");
        assert_eq!(report.terminal, 1);
        assert!(report.timed_out.is_empty());
        runtime
            .close_after_drain(&report, &SideOperationDrainReport::default())
            .expect("close after drain");
        assert!(
            read_manifest(&project)
                .expect("closed manifest")
                .clean_shutdown
        );
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[tokio::test]
    async fn side_operation_drain_cancels_and_waits_for_archive_and_image_commit_owners() {
        let runtime = Arc::new(ProjectRuntime::default());
        let archive = CancellationToken::new();
        let image_commit = CancellationToken::new();
        runtime
            .active_archives
            .lock()
            .expect("archives")
            .insert("archive-test".into(), archive.clone());
        runtime
            .active_image_commits
            .lock()
            .expect("image commits")
            .insert("images-test".into(), image_commit.clone());

        let draining_runtime = runtime.clone();
        let drain = tokio::spawn(async move {
            draining_runtime
                .drain_side_operations(Duration::from_secs(1))
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !archive.is_cancel_requested() || !image_commit.is_cancel_requested() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("side-operation cancellation");
        assert!(runtime
            .begin_archive_operation(Some("rejected-during-drain"))
            .is_err());

        runtime.active_archives.lock().expect("archives").clear();
        runtime
            .active_image_commits
            .lock()
            .expect("image commits")
            .clear();
        let report = drain.await.expect("side-operation drain task");
        assert!(report.completed());
        runtime.resume_side_operation_admission();
        let (operation_id, _) = runtime
            .begin_archive_operation(Some("accepted-after-drain"))
            .expect("archive admission reopened");
        runtime.finish_archive_operation(&operation_id);
    }

    #[test]
    fn image_quality_catalog_is_atomic_journalled_and_survives_reopen() {
        let root = temp_test_dir("image-quality-catalog");
        let project = root.join("quality.hcad");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&project),
                name: "Quality".into(),
            })
            .expect("project");
        let camera = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            insert_test_camera(session, &images, "quality", [])
        };
        let camera_record = runtime
            .list_camera_images()
            .expect("camera catalog")
            .into_iter()
            .find(|record| record.entity_id == camera)
            .expect("camera record");
        let analysis = ImageQualityAnalysisRecord {
            schema_version: 1,
            job_id: "image-quality-test".into(),
            image_entity_id: camera.clone(),
            image_name: camera_record.name,
            source_object_hash: camera_record.metadata.source_object_hash,
            source_metadata_object_hash: camera_record.metadata_object_hash,
            algorithm_version: "test-v1".into(),
            configuration_sha256: ObjectHash::of_bytes(b"quality-config"),
            analyzed_at_unix_ms: 42,
            original_width_pixels: 100,
            original_height_pixels: 80,
            sample_width_pixels: 100,
            sample_height_pixels: 80,
            sampled_pixel_count: 8_000,
            scope: ImageQualityScope {
                processing_set_id: None,
                processing_set_membership_sha256: None,
            },
            outcome: ImageQualityOutcome::Measured {
                metrics: ImageQualityMetrics {
                    laplacian_variance: 0.01,
                    tenengrad: 0.02,
                    directional_gradient_coherence: 0.3,
                    dominant_gradient_angle_degrees: 12.0,
                    mean_luminance: 0.5,
                    shadow_clipped_fraction: 0.01,
                    highlight_clipped_fraction: 0.02,
                    texture_entropy_bits: 6.5,
                    textured_pixel_fraction: 0.4,
                },
                warnings: vec![ImageQualityWarning::HighlightClipping],
            },
        };
        let published = runtime
            .publish_image_quality_analyses("image-quality-test", vec![analysis.clone()])
            .expect("publish quality catalog");
        let catalog_hash = published
            .manifest
            .image_quality_catalog_hash
            .expect("catalog hash");
        assert!(project_object_path(&project, &catalog_hash).is_file());
        assert_eq!(
            runtime.list_image_quality_analyses().unwrap(),
            vec![analysis.clone()]
        );
        let journal: PhotolabJournalEntry = serde_json::from_slice(
            &fs::read(project.join("journal/0000000000000001.json")).expect("journal"),
        )
        .expect("journal JSON");
        assert_eq!(journal.command_kind, "PhotolabAnalyzeImageQuality");
        assert_eq!(journal.affected_entities, vec![camera]);
        runtime.close().expect("close");

        let reopened = ProjectRuntime::default();
        reopened
            .open(&OpenProjectParams {
                path: path_string(&project),
                working_root: path_string(&root.join("working")),
                use_local_working_copy: false,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("reopen");
        assert_eq!(
            reopened.list_image_quality_analyses().unwrap(),
            vec![analysis]
        );
        reopened.close().expect("close reopened");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn job_history_marks_only_checkpointed_resume_capable_kinds_recoverable() {
        let root = temp_test_dir("durable-job-history");
        let project = root.join("project.hcad");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&project),
                name: "Durable jobs".into(),
            })
            .expect("project");
        let scope = runtime
            .current_scope()
            .expect("scope")
            .expect("open project scope");

        let mut completed = test_job("completed-job");
        completed
            .transition_to(PhotolabJobState::Running)
            .expect("running");
        completed
            .transition_to(PhotolabJobState::Completed)
            .expect("completed");
        let mut interrupted =
            test_job_with_kind("interrupted-job", PhotolabJobKind::BuildDepthMaps);
        interrupted
            .transition_to(PhotolabJobState::Running)
            .expect("running");
        interrupted
            .record_checkpoint(&test_checkpoint(&interrupted))
            .expect("checkpoint");
        let frozen_interrupted = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": interrupted.id.0.clone() }),
            &NewPhotolabJob {
                id: interrupted.id.clone(),
                kind: interrupted.kind,
                config_hash: interrupted.config_hash.clone(),
                input_hash: interrupted.input_hash.clone(),
                progress: interrupted.progress.clone(),
            },
        )
        .expect("frozen interrupted request");
        let mut alignment = test_job_with_kind("alignment-job", PhotolabJobKind::AlignPhotos);
        alignment
            .transition_to(PhotolabJobState::Running)
            .expect("alignment running");
        alignment
            .record_checkpoint(&test_checkpoint(&alignment))
            .expect("synthetic alignment checkpoint");

        let manifest_before = fs::read(project.join("manifest.json")).expect("manifest before");
        runtime
            .persist(&scope, &completed, None)
            .expect("persist completed");
        let completed_record_before =
            fs::read(job_history_record_path(&project, "completed-job")).expect("completed record");
        runtime
            .persist(&scope, &interrupted, Some(&frozen_interrupted))
            .expect("persist interrupted");
        runtime
            .persist(&scope, &alignment, None)
            .expect("persist alignment");
        let interrupted_scratch =
            project.join(format!("tmp/colmap/colmap-{}-123-1", alignment.id.0));
        fs::create_dir_all(interrupted_scratch.join("features"))
            .expect("interrupted alignment scratch");
        fs::write(interrupted_scratch.join("features/partial.db"), b"partial")
            .expect("partial alignment output");
        assert_eq!(
            fs::read(job_history_record_path(&project, "completed-job"))
                .expect("completed record after unrelated update"),
            completed_record_before,
            "persisting one job must not rewrite historical job records"
        );
        assert_eq!(
            fs::read(project.join("manifest.json")).expect("manifest after"),
            manifest_before,
            "job persistence must never restore or rewrite the project manifest"
        );
        assert!(job_history_record_path(&project, "completed-job").is_file());
        assert!(job_history_record_path(&project, "interrupted-job").is_file());
        fs::write(
            job_history_records_path(&project).join(".stale-atomic-write.tmp"),
            b"incomplete",
        )
        .expect("stale temporary record");
        runtime.close().expect("close");

        let reopened = ProjectRuntime::default();
        reopened
            .open(&OpenProjectParams {
                path: path_string(&project),
                working_root: path_string(&root.join("working")),
                use_local_working_copy: false,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("reopen");
        let jobs = reopened.load_current().expect("load durable jobs");
        assert_eq!(jobs.len(), 3);
        assert!(jobs.iter().any(|job| {
            job.id.0 == "completed-job" && job.state == PhotolabJobState::Completed
        }));
        let recovered = jobs
            .iter()
            .find(|job| job.id.0 == "interrupted-job")
            .expect("interrupted record");
        assert_eq!(recovered.last_checkpoint_sequence, Some(1));
        assert!(matches!(
            &recovered.state,
            PhotolabJobState::Failed { code, message }
                if code == "interruptedRecoverable"
                    && message.contains("committed checkpoint 1")
        ));
        assert!(recovered.finished_at_unix_ms.is_some());
        assert_eq!(
            reopened
                .frozen_job_request(&recovered.id)
                .expect("frozen request after interruption"),
            Some(frozen_interrupted),
            "interruption classification must preserve the sidecar-owned request"
        );
        let restarted = jobs
            .iter()
            .find(|job| job.id.0 == "alignment-job")
            .expect("alignment record");
        assert_eq!(restarted.last_checkpoint_sequence, Some(1));
        assert!(matches!(
            &restarted.state,
            PhotolabJobState::Failed { code, message }
                if code == "interrupted"
                    && message.contains("Restart required")
                    && !message.contains("Resume is available")
        ));
        assert!(
            !interrupted_scratch.exists(),
            "a crashed alignment has no resumable runtime checkpoint, so its scratch is rebuildable"
        );
        reopened.close().expect("close reopened");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn alignment_and_mesh_capability_table_never_claims_cross_restart_resume() {
        assert!(!job_kind_supports_cross_restart_resume(
            PhotolabJobKind::AlignPhotos
        ));
        assert!(!job_kind_supports_cross_restart_resume(
            PhotolabJobKind::OptimizeAlignment
        ));
        assert!(!job_kind_supports_cross_restart_resume(
            PhotolabJobKind::MergeAlignments
        ));
        assert!(!job_kind_supports_cross_restart_resume(
            PhotolabJobKind::BuildMesh
        ));
    }

    fn test_job(id: &str) -> PhotolabJob {
        test_job_with_kind(id, PhotolabJobKind::AlignPhotos)
    }

    fn test_job_with_kind(id: &str, kind: PhotolabJobKind) -> PhotolabJob {
        PhotolabJob::new(NewPhotolabJob {
            id: PhotolabJobId(id.into()),
            kind,
            config_hash: ObjectHash::of_bytes(b"config"),
            input_hash: ObjectHash::of_bytes(b"input"),
            progress: JobProgress {
                stage: PhotolabStage {
                    kind: PhotolabStageKind::FeatureExtraction,
                    index: 0,
                    stage_count: 2,
                    label: "Extract features".into(),
                },
                metrics: ProgressMetrics::empty(),
            },
        })
        .expect("valid job")
    }

    fn terminal_test_job(id: &str, kind: PhotolabJobKind, state: PhotolabJobState) -> PhotolabJob {
        let mut job = test_job_with_kind(id, kind);
        job.transition_to(PhotolabJobState::Running)
            .expect("job running");
        if state == PhotolabJobState::Cancelled {
            job.request_cancel(&CancellationToken::new())
                .expect("cancel requested");
        }
        job.transition_to(state).expect("terminal job");
        job
    }

    #[test]
    fn terminal_scratch_cleanup_preserves_products_and_resume_material() {
        let root = temp_test_dir("terminal-scratch-cleanup");
        fs::create_dir_all(&root).expect("root");
        fs::create_dir_all(root.join("datasets/raster/raster-done")).expect("published raster");
        fs::write(
            root.join("datasets/raster/raster-done/product.cog.tif"),
            b"published",
        )
        .expect("published COG");
        fs::create_dir_all(root.join(".photolab/checkpoints")).expect("durable checkpoint root");
        fs::write(
            root.join(".photolab/checkpoints/unrelated.json"),
            b"durable",
        )
        .expect("durable checkpoint");

        fs::create_dir_all(root.join(".photolab/raster-inputs/raster-done")).expect("raster input");
        fs::write(
            root.join(".photolab/raster-inputs/raster-done/large.gpkg"),
            b"rebuildable",
        )
        .expect("raster input payload");
        fs::create_dir_all(root.join(".photolab/raster-staging/raster-jobs/raster-done"))
            .expect("stale completed raster staging");
        fs::write(
            root.join(".photolab/raster-staging/raster-jobs/raster-done/base.tif"),
            b"stale",
        )
        .expect("stale raster stage");
        let completed_raster = terminal_test_job(
            "raster-done",
            PhotolabJobKind::BuildDem,
            PhotolabJobState::Completed,
        );
        cleanup_terminal_job_scratch(&root, &completed_raster).expect("raster cleanup");
        assert!(!root.join(".photolab/raster-inputs/raster-done").exists());
        assert!(!root
            .join(".photolab/raster-staging/raster-jobs/raster-done")
            .exists());
        assert_eq!(
            fs::read(root.join("datasets/raster/raster-done/product.cog.tif"))
                .expect("published product retained"),
            b"published"
        );
        assert_eq!(
            fs::read(root.join(".photolab/checkpoints/unrelated.json"))
                .expect("durable checkpoint retained"),
            b"durable"
        );

        fs::create_dir_all(root.join(".photolab/raster-inputs/raster-failed"))
            .expect("failed raster input");
        fs::create_dir_all(root.join(".photolab/raster-staging/raster-jobs/raster-failed"))
            .expect("failed raster output");
        fs::create_dir_all(root.join(".photolab/raster-staging/raster-checkpoints"))
            .expect("raster checkpoint root");
        fs::write(
            root.join(".photolab/raster-staging/raster-jobs/raster-failed/tile.tif"),
            b"checkpoint-output",
        )
        .expect("checkpoint output");
        fs::write(
            root.join(".photolab/raster-staging/raster-checkpoints/raster-failed.json"),
            b"checkpoint",
        )
        .expect("raster checkpoint");
        let failed_raster = terminal_test_job(
            "raster-failed",
            PhotolabJobKind::BuildOrthomosaic,
            PhotolabJobState::Failed {
                code: "test".into(),
                message: "test".into(),
            },
        );
        cleanup_terminal_job_scratch(&root, &failed_raster).expect("failed raster cleanup");
        assert!(!root.join(".photolab/raster-inputs/raster-failed").exists());
        assert!(root
            .join(".photolab/raster-staging/raster-jobs/raster-failed/tile.tif")
            .is_file());
        assert!(root
            .join(".photolab/raster-staging/raster-checkpoints/raster-failed.json")
            .is_file());

        fs::create_dir_all(root.join(".photolab/mvs-scenes/mvs-failed/images")).expect("MVS scene");
        let mvs_scratch = root.join(".photolab/scratch/mvs/mvs-mvs-failed-0001");
        fs::create_dir_all(mvs_scratch.join("checkpoints")).expect("MVS checkpoints");
        fs::create_dir_all(mvs_scratch.join("output/raw")).expect("MVS resumable output");
        fs::create_dir_all(mvs_scratch.join("home/cache")).expect("MVS transient cache");
        fs::write(
            mvs_scratch.join("checkpoints/checkpoint-1.json"),
            b"checkpoint",
        )
        .expect("MVS checkpoint");
        fs::write(mvs_scratch.join("output/raw/tile.bin"), b"tile").expect("MVS tile");
        fs::write(mvs_scratch.join("request.json"), b"request").expect("MVS request");
        let failed_mvs = terminal_test_job(
            "mvs-failed",
            PhotolabJobKind::BuildDensePointCloud,
            PhotolabJobState::Cancelled,
        );
        cleanup_terminal_job_scratch(&root, &failed_mvs).expect("MVS cleanup");
        assert!(root.join(".photolab/mvs-scenes/mvs-failed").is_dir());
        assert!(mvs_scratch.join("checkpoints/checkpoint-1.json").is_file());
        assert!(mvs_scratch.join("output/raw/tile.bin").is_file());
        assert!(!mvs_scratch.join("request.json").exists());
        assert!(!mvs_scratch.join("home").exists());

        fs::create_dir_all(root.join("datasets/mvs/mvs-done/output"))
            .expect("published MVS dataset");
        fs::write(
            root.join("datasets/mvs/mvs-done/output/index.json"),
            b"published MVS",
        )
        .expect("published MVS index");
        fs::create_dir_all(root.join(".photolab/mvs-scenes/mvs-done/images"))
            .expect("published reusable MVS scene");
        let completed_mvs_scratch = root.join(".photolab/scratch/mvs/mvs-mvs-done-0001");
        fs::create_dir_all(completed_mvs_scratch.join("checkpoints"))
            .expect("stale completed checkpoint");
        fs::write(
            completed_mvs_scratch.join("checkpoints/checkpoint-1.json"),
            b"stale",
        )
        .expect("stale completed checkpoint file");
        let completed_mvs = terminal_test_job(
            "mvs-done",
            PhotolabJobKind::BuildDepthMaps,
            PhotolabJobState::Completed,
        );
        cleanup_terminal_job_scratch(&root, &completed_mvs).expect("completed MVS cleanup");
        assert!(root
            .join("datasets/mvs/mvs-done/output/index.json")
            .is_file());
        assert!(root.join(".photolab/mvs-scenes/mvs-done/images").is_dir());
        assert!(!completed_mvs_scratch.exists());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn terminal_cleanup_prunes_splat_inputs_but_active_jobs_are_untouched() {
        let root = temp_test_dir("active-scratch-cleanup");
        let active_input = root.join(".photolab/raster-inputs/active-raster");
        fs::create_dir_all(&active_input).expect("active raster input");
        fs::write(active_input.join("source.bin"), b"active").expect("active input");
        let mut active = test_job_with_kind("active-raster", PhotolabJobKind::BuildDem);
        active
            .transition_to(PhotolabJobState::Running)
            .expect("active job");
        cleanup_terminal_job_scratch(&root, &active).expect("active cleanup is a no-op");
        assert!(active_input.join("source.bin").is_file());

        let brush_scene = root.join(".photolab/brush-scenes/splat-failed/images");
        let brush_scratch = root.join("tmp/brush/brush-splat-failed-0000000000000001");
        fs::create_dir_all(&brush_scene).expect("brush scene");
        fs::create_dir_all(brush_scratch.join("checkpoints")).expect("brush checkpoints");
        fs::create_dir_all(brush_scratch.join("cache")).expect("brush cache");
        fs::write(
            brush_scratch.join("checkpoints/checkpoint_5000.ply"),
            b"ply checkpoint",
        )
        .expect("brush checkpoint");
        fs::write(brush_scratch.join("cache/rebuildable.bin"), b"cache").expect("brush cache file");
        let failed_splat = terminal_test_job(
            "splat-failed",
            PhotolabJobKind::BuildGaussianSplat,
            PhotolabJobState::Cancelled,
        );
        cleanup_terminal_job_scratch(&root, &failed_splat).expect("splat cleanup");
        assert!(!root.join(".photolab/brush-scenes/splat-failed").exists());
        assert!(brush_scratch
            .join("checkpoints/checkpoint_5000.ply")
            .is_file());
        assert!(!brush_scratch.join("cache").exists());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn terminal_batch_cleanup_covers_child_operation_ids_without_touching_other_jobs() {
        let root = temp_test_dir("batch-scratch-cleanup");
        let batch_input = root.join(".photolab/raster-inputs/batch-01-dem");
        let foreign_input = root.join(".photolab/raster-inputs/batch-other-01-dem");
        fs::create_dir_all(&batch_input).expect("batch input");
        fs::create_dir_all(&foreign_input).expect("foreign input");
        fs::write(batch_input.join("large.gpkg"), b"batch").expect("batch data");
        fs::write(foreign_input.join("large.gpkg"), b"foreign").expect("foreign data");
        fs::create_dir_all(root.join("datasets/raster/batch-01-dem"))
            .expect("published batch raster");

        let child_mvs = "batch-02-dense";
        fs::create_dir_all(root.join(format!(".photolab/mvs-scenes/{child_mvs}/images")))
            .expect("batch MVS scene");
        fs::create_dir_all(root.join(format!("datasets/mvs/{child_mvs}")))
            .expect("published batch MVS");
        let stale_mvs = root.join(format!(".photolab/scratch/mvs/mvs-{child_mvs}-0001"));
        fs::create_dir_all(stale_mvs.join("checkpoints")).expect("stale MVS scratch");
        fs::write(stale_mvs.join("checkpoints/checkpoint.json"), b"stale")
            .expect("stale MVS checkpoint");

        let batch = terminal_test_job("batch", PhotolabJobKind::Batch, PhotolabJobState::Completed);
        cleanup_terminal_job_scratch(&root, &batch).expect("batch cleanup");
        assert!(!batch_input.exists());
        assert!(foreign_input.join("large.gpkg").is_file());
        assert!(!stale_mvs.exists());
        assert!(root
            .join(format!(".photolab/mvs-scenes/{child_mvs}/images"))
            .is_dir());
        assert!(root.join(format!("datasets/mvs/{child_mvs}")).is_dir());

        fs::remove_dir_all(root).expect("cleanup");
    }

    fn test_checkpoint(job: &PhotolabJob) -> CheckpointDescriptor {
        let payload_hash = ObjectHash::of_bytes(b"payload");
        let mut checkpoint = CheckpointDescriptor::pending(NewPendingCheckpoint {
            checkpoint_id: CheckpointId("checkpoint-1".into()),
            job_id: job.id.clone(),
            job_kind: job.kind,
            sequence: 1,
            progress: job.progress.clone(),
            config_hash: job.config_hash.clone(),
            input_hash: job.input_hash.clone(),
            temporary_object_key: "tmp/checkpoint-1".into(),
            expected_payload_hash: payload_hash.clone(),
        })
        .expect("pending checkpoint");
        checkpoint.commit(payload_hash).expect("commit checkpoint");
        checkpoint
    }

    #[test]
    fn merge_plans_require_a_connected_graph_without_claiming_overlap_evidence() {
        let inputs = vec![
            EntityId("alignment-a".into()),
            EntityId("alignment-b".into()),
            EntityId("alignment-c".into()),
        ];
        let weak = vec![AlignmentMergeConnection::Overlap {
            alignment_a: inputs[0].clone(),
            alignment_b: inputs[1].clone(),
            verified_cross_run_track_count: 2,
        }];
        assert!(validate_merge_connections(&inputs, &weak, &[]).is_err());

        let disconnected = vec![AlignmentMergeConnection::Overlap {
            alignment_a: inputs[0].clone(),
            alignment_b: inputs[1].clone(),
            verified_cross_run_track_count: 0,
        }];
        assert!(validate_merge_connections(&inputs, &disconnected, &[]).is_err());

        let connected = vec![
            AlignmentMergeConnection::Overlap {
                alignment_a: inputs[0].clone(),
                alignment_b: inputs[1].clone(),
                verified_cross_run_track_count: 0,
            },
            AlignmentMergeConnection::Overlap {
                alignment_a: inputs[1].clone(),
                alignment_b: inputs[2].clone(),
                verified_cross_run_track_count: 0,
            },
        ];
        validate_merge_connections(&inputs, &connected, &[]).expect("connected merge evidence");

        let duplicate = vec![
            connected[0].clone(),
            connected[0].clone(),
            connected[1].clone(),
        ];
        assert!(validate_merge_connections(&inputs, &duplicate, &[])
            .expect_err("duplicate edge")
            .to_string()
            .contains("duplicate connection"));
    }

    #[test]
    fn calibration_groups_must_form_an_exact_partition() {
        let mut capture = vec![EntityId("camera-a".into()), EntityId("camera-b".into())];
        sort_unique_entity_ids(&mut capture, "capture").expect("valid capture");
        let mut assigned = vec![capture[0].clone(), capture[0].clone()];
        assigned.sort_by(|left, right| left.0.cmp(&right.0));
        assert_ne!(assigned, capture);
        assert!(sort_unique_entity_ids(&mut assigned, "calibration").is_err());
    }

    #[test]
    fn automatic_metadata_grouping_shares_intrinsics_for_one_continuous_flight() {
        let root = temp_test_dir("automatic-capture-group");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Automatic grouping".into(),
            })
            .expect("project");
        let camera_ids = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            let mut camera_ids = Vec::new();
            for index in 0..135 {
                let mut metadata = PhotoMetadata::default();
                metadata.exif.make = Some("DJI".into());
                metadata.exif.model = Some("M4E".into());
                metadata.exif.focal_length_mm = Some(12.29);
                metadata.exif.dimensions = Some(ImageDimensions {
                    width_pixels: 5280,
                    height_pixels: 3956,
                });
                metadata.exif.captured_at = Some(CaptureTime {
                    value: format!("2026-07-06 15:{:02}:{:02}", index / 60, index % 60),
                    reference: CaptureTimeReference::UnknownLocalTime,
                });
                metadata.dji_xmp.calibrated_focal_length_pixels = Some(3_725.151_611);
                metadata.dji_xmp.calibrated_optical_center_x_pixels = Some(2640.0);
                metadata.dji_xmp.calibrated_optical_center_y_pixels = Some(1978.0);
                camera_ids.push(insert_test_camera_with_metadata(
                    session,
                    &images,
                    &format!("camera-{index:03}"),
                    [],
                    metadata,
                ));
            }
            let proposals = automatic_capture_groups_for_import(session, &camera_ids)
                .expect("automatic proposals");
            assert_eq!(proposals.len(), 1);
            assert_eq!(proposals[0].camera_entity_ids.len(), 135);
            assert_eq!(proposals[0].calibration_groups.len(), 1);
            assert_eq!(
                proposals[0].calibration_groups[0].camera_entity_ids.len(),
                135
            );
            ProjectRuntime::persist_automatic_capture_groups(session, proposals)
                .expect("persist automatic groups");
            camera_ids
        };
        let groups = runtime
            .calibration_groups_for_camera_scope(
                &camera_ids
                    .iter()
                    .map(|camera| camera.0.clone())
                    .collect::<Vec<_>>(),
            )
            .expect("compute groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].camera_entity_ids.len(), 135);
        let captures = runtime.list_capture_groups().expect("capture groups");
        assert_eq!(
            captures[0].review_status,
            CaptureGroupReviewStatus::NeedsReview
        );
        assert!(captures[0].automatic);
        runtime
            .confirm_capture_group(ConfirmCaptureGroupParams {
                capture_group_id: captures[0].entity_id.clone(),
            })
            .expect("confirm automatic grouping");
        assert_eq!(
            runtime.list_capture_groups().expect("confirmed groups")[0].review_status,
            CaptureGroupReviewStatus::Confirmed
        );
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn embedded_calibration_jump_splits_autofocus_intrinsics() {
        let candidate = |suffix: &str, focal_pixels: f64| AutomaticCameraCandidate {
            entity_id: EntityId(format!("camera-{suffix}")),
            name: format!("{suffix}.jpg"),
            source_directory: "/survey".into(),
            hardware_label: "dji m4e · fixed lens · 12.29 mm".into(),
            capture_time_label: None,
            capture_time_seconds: None,
            calibration_seed: Some(CameraCalibrationSeed {
                width_pixels: 5280,
                height_pixels: 3956,
                focal_pixels: Some(focal_pixels),
                principal_x_pixels: Some(2640.0),
                principal_y_pixels: Some(1978.0),
                full_brown_calibration: None,
            }),
        };
        let cameras = vec![
            candidate("before-a", 3725.0),
            candidate("before-b", 3725.5),
            candidate("after-a", 3742.0),
            candidate("after-b", 3742.4),
        ];
        let groups = automatic_calibration_groups(&cameras);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].camera_entity_ids.len(), 2);
        assert_eq!(groups[1].camera_entity_ids.len(), 2);
    }

    #[test]
    fn full_dewarp_calibration_is_part_of_automatic_group_identity() {
        let calibration = |date: &str, k3: f64| DjiBrownConradyCalibration {
            focal_x_pixels: 3713.771893164336,
            focal_y_pixels: 3713.771893164336,
            principal_x_pixels: 2660.720882112011,
            principal_y_pixels: 1961.266654297148,
            radial_distortion: [-0.107756512758, -0.000878853880, k3],
            tangential_distortion: [0.000130474491, -0.000011293710],
            calibration_date: date.into(),
            provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        let candidate = |suffix: &str, full: DjiBrownConradyCalibration| AutomaticCameraCandidate {
            entity_id: EntityId(format!("camera-{suffix}")),
            name: format!("{suffix}.jpg"),
            source_directory: "/survey".into(),
            hardware_label: "dji m4e · fixed lens · 12.29 mm".into(),
            capture_time_label: None,
            capture_time_seconds: None,
            calibration_seed: Some(CameraCalibrationSeed {
                width_pixels: 5280,
                height_pixels: 3956,
                focal_pixels: Some(full.focal_x_pixels),
                principal_x_pixels: Some(full.principal_x_pixels),
                principal_y_pixels: Some(full.principal_y_pixels),
                full_brown_calibration: Some(full),
            }),
        };
        let cameras = vec![
            candidate("a", calibration("2025-02-26", -0.015723478938)),
            candidate("b", calibration("2025-02-27", -0.015723478938)),
            candidate("c", calibration("2025-02-26", -0.016)),
        ];

        let groups = automatic_calibration_groups(&cameras);
        assert_eq!(
            groups.len(),
            3,
            "date and every Brown coefficient are identity"
        );
    }

    #[test]
    fn image_masks_are_versioned_scoped_reopenable_and_removed_with_their_camera() {
        let root = temp_test_dir("image-mask-lifecycle");
        let source = root.join("masks.hcad");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&source),
                name: "Mask lifecycle".into(),
            })
            .expect("project");
        let (camera_a, camera_b) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            let mut metadata = PhotoMetadata::default();
            metadata.exif.dimensions = Some(ImageDimensions {
                width_pixels: 64,
                height_pixels: 48,
            });
            (
                insert_test_camera_with_metadata(session, &images, "mask-a", [], metadata.clone()),
                insert_test_camera_with_metadata(session, &images, "mask-b", [], metadata),
            )
        };

        let initial_a = runtime
            .image_mask_compute_scope(std::slice::from_ref(&camera_a.0), None)
            .expect("initial scope");
        let cancelled_manifest = runtime.snapshot().expect("snapshot").manifest;
        {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let cancellation = CancellationToken::new();
            cancellation.request_cancel();
            assert!(edit_image_mask_transaction(
                session,
                EditImageMaskParams {
                    operation_id: "mask-cancelled".into(),
                    image_entity_id: camera_a.clone(),
                    expected_revision_sha256: None,
                    edit: ImageMaskEdit::Clear,
                },
                &cancellation,
            )
            .is_err());
        }
        assert_eq!(
            runtime.snapshot().expect("snapshot").manifest,
            cancelled_manifest
        );

        let add = runtime
            .edit_image_mask(EditImageMaskParams {
                operation_id: "mask-add-a".into(),
                image_entity_id: camera_a.clone(),
                expected_revision_sha256: None,
                edit: ImageMaskEdit::Brush {
                    stroke: himmelcad_core::photolab_masks::ImageMaskBrushStroke {
                        mode: himmelcad_core::photolab_masks::ImageMaskBrushMode::Add,
                        radius_pixels: 5.0,
                        points: vec![himmelcad_core::photolab_masks::ImageMaskBrushPoint {
                            x_pixels: 20.0,
                            y_pixels: 18.0,
                        }],
                    },
                },
            })
            .expect("add mask");
        assert!(add.masked_pixel_count > 0);
        let masked_a = runtime
            .image_mask_compute_scope(std::slice::from_ref(&camera_a.0), None)
            .expect("masked scope");
        assert_ne!(masked_a.scope_sha256, initial_a.scope_sha256);
        assert_eq!(masked_a.masks.len(), 1);
        assert_eq!(masked_a.masks[0].revision_sha256, add.revision_sha256);
        let tags = runtime
            .list_camera_images()
            .expect("camera records")
            .into_iter()
            .find(|camera| camera.entity_id == camera_a)
            .expect("camera a")
            .metadata
            .status_tags;
        assert!(tags.contains(&ImageProductTag::Masked));

        runtime
            .edit_image_mask(EditImageMaskParams {
                operation_id: "mask-add-b".into(),
                image_entity_id: camera_b.clone(),
                expected_revision_sha256: None,
                edit: ImageMaskEdit::Brush {
                    stroke: himmelcad_core::photolab_masks::ImageMaskBrushStroke {
                        mode: himmelcad_core::photolab_masks::ImageMaskBrushMode::Add,
                        radius_pixels: 3.0,
                        points: vec![himmelcad_core::photolab_masks::ImageMaskBrushPoint {
                            x_pixels: 8.0,
                            y_pixels: 8.0,
                        }],
                    },
                },
            })
            .expect("mask outside scope");
        assert_eq!(
            runtime
                .image_mask_compute_scope(std::slice::from_ref(&camera_a.0), None)
                .expect("same scope")
                .scope_sha256,
            masked_a.scope_sha256,
            "a mask outside a frozen camera scope must not invalidate it"
        );

        let cleared = runtime
            .edit_image_mask(EditImageMaskParams {
                operation_id: "mask-clear-a".into(),
                image_entity_id: camera_a.clone(),
                expected_revision_sha256: Some(add.revision_sha256.clone()),
                edit: ImageMaskEdit::Clear,
            })
            .expect("clear mask");
        assert_eq!(cleared.masked_pixel_count, 0);
        assert!(cleared.raster_object_hash.is_none());
        let restored = runtime
            .edit_image_mask(EditImageMaskParams {
                operation_id: "mask-restore-a".into(),
                image_entity_id: camera_a.clone(),
                expected_revision_sha256: Some(cleared.revision_sha256),
                edit: ImageMaskEdit::Restore {
                    revision_sha256: add.revision_sha256.clone(),
                },
            })
            .expect("restore mask");
        assert_eq!(restored.masked_pixel_count, add.masked_pixel_count);

        runtime.close().expect("close");
        let reopened = ProjectRuntime::default();
        reopened
            .open(&OpenProjectParams {
                path: path_string(&source),
                working_root: path_string(&root.join("cache")),
                use_local_working_copy: false,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("reopen");
        let revisions = reopened.list_image_masks().expect("reopened masks");
        assert_eq!(revisions.len(), 2);
        assert_eq!(
            revisions
                .iter()
                .find(|revision| revision.revision.image_entity_id == camera_a)
                .expect("camera a revision")
                .revision
                .masked_pixel_count,
            add.masked_pixel_count
        );
        reopened
            .remove_camera_images(RemoveCameraImagesParams {
                entity_ids: vec![camera_a.clone()],
            })
            .expect("remove camera and mask catalog entry");
        assert!(reopened
            .list_image_masks()
            .expect("remaining masks")
            .iter()
            .all(|revision| revision.revision.image_entity_id != camera_a));
        reopened.close().expect("close reopened");
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(unique_id(name, unix_ms().expect("clock must work")))
    }

    fn insert_test_camera(
        session: &mut ProjectSession,
        images: &EntityId,
        suffix: &str,
        status_tags: impl IntoIterator<Item = ImageProductTag>,
    ) -> EntityId {
        insert_test_camera_with_metadata(
            session,
            images,
            suffix,
            status_tags,
            PhotoMetadata::default(),
        )
    }

    fn insert_test_camera_with_metadata(
        session: &mut ProjectSession,
        images: &EntityId,
        suffix: &str,
        status_tags: impl IntoIterator<Item = ImageProductTag>,
        photo_metadata: PhotoMetadata,
    ) -> EntityId {
        let entity_id = EntityId(format!("{}:camera:{suffix}", session.manifest.project_id));
        let source_object_hash = ObjectHash::of_bytes(format!("source-{suffix}").as_bytes());
        let metadata = CameraImageMetadataRecord {
            schema_version: 2,
            source_object_hash,
            transformation_object_hash: ObjectHash::of_bytes(b"test-transform"),
            inspected_photo: DiscoveredPhoto {
                source_path: format!("/survey/{suffix}.jpg"),
                format: PhotoFormat::Jpeg,
                byte_size: 1,
                sha256: ObjectHash::of_bytes(format!("source-{suffix}").as_bytes()),
                metadata: photo_metadata,
                capture_source: Default::default(),
                decoder_capability: None,
                position_prior: None,
                derived_provenance: None,
                duplicate_of: None,
            },
            projected_reference: None,
            status_tags: status_tags.into_iter().collect(),
        };
        let version_hash = put_project_object(
            &session.working_path,
            &serde_json::to_vec(&metadata).expect("metadata JSON"),
        )
        .expect("metadata object");
        session.manifest.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::CameraImage,
                name: format!("{suffix}.jpg"),
                parent: Some(images.clone()),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash,
                bounds: None,
            },
        );
        session
            .manifest
            .entities
            .get_mut(&images.0)
            .expect("images collection")
            .children
            .push(entity_id.clone());
        entity_id
    }

    fn insert_test_alignment(
        session: &mut ProjectSession,
        suffix: &str,
        publication_sequence: u64,
        camera_entity_ids: &[EntityId],
    ) -> EntityId {
        let relative = format!("datasets/colmap/{suffix}");
        fs::create_dir_all(session.working_path.join(&relative)).expect("alignment dataset");
        let record = ComputeArtifactRecord {
            schema_version: 1,
            job_id: suffix.into(),
            dataset_relative_path: relative,
            artifact: ColmapArtifactSummary {
                kind: ColmapArtifactKind::SparseModel,
                relative_path: "sparse/0".into(),
                sha256: ObjectHash::of_bytes(suffix.as_bytes()),
                bytes: 1,
            },
            camera_entity_ids: camera_entity_ids.iter().map(|id| id.0.clone()).collect(),
            image_mask_scope_sha256: None,
            calibration_groups: Vec::new(),
            intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
            processing_set_id: None,
            publication_sequence,
            selected_mapper: SelectedMapper::Global,
            tool_manifest_sha256: ObjectHash::of_bytes(b"test-tools"),
            parent_alignment_entity_id: None,
            potree: None,
        };
        let version_hash = put_project_object(
            &session.working_path,
            &serde_json::to_vec(&record).expect("alignment JSON"),
        )
        .expect("alignment object");
        let entity_id = EntityId(format!(
            "{}:alignment:{suffix}",
            session.manifest.project_id
        ));
        session.manifest.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::AlignmentRun,
                name: suffix.into(),
                parent: None,
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash,
                bounds: None,
            },
        );
        entity_id
    }

    #[test]
    fn camera_images_can_be_removed_until_a_scope_references_them() {
        let root = temp_test_dir("remove-camera-images");
        let source = root.join("remove.hcad");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&source),
                name: "Remove images".to_owned(),
            })
            .expect("project");
        let (camera_a, camera_b) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("image collection");
            (
                insert_test_camera(session, &images, "a", []),
                insert_test_camera(session, &images, "b", []),
            )
        };

        let opened = runtime
            .remove_camera_images(RemoveCameraImagesParams {
                entity_ids: vec![camera_a.clone()],
            })
            .expect("unreferenced image removal");
        assert!(!opened.manifest.entities.contains_key(&camera_a.0));
        assert_eq!(
            opened
                .manifest
                .entities
                .values()
                .filter(|entity| entity.kind == EntityKind::CameraImage)
                .count(),
            1
        );

        let camera_c = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("image collection");
            insert_test_camera(session, &images, "c", [])
        };
        runtime
            .create_processing_set(CreateProcessingSetParams {
                name: "Remaining cameras".to_owned(),
                camera_entity_ids: vec![camera_b.clone(), camera_c],
            })
            .expect("processing set");
        let error = runtime
            .remove_camera_images(RemoveCameraImagesParams {
                entity_ids: vec![camera_b.clone()],
            })
            .expect_err("referenced image must not be removed");
        assert!(error.to_string().contains("referenced by ProcessingSet"));
        assert!(runtime
            .snapshot()
            .expect("snapshot")
            .manifest
            .entities
            .contains_key(&camera_b.0));
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn insert_test_dense_record(
        session: &mut ProjectSession,
        suffix: &str,
        lineage: &ProductLineage,
    ) -> EntityId {
        let relative = format!("datasets/mvs/{suffix}");
        let output = session.working_path.join(&relative).join("output");
        fs::create_dir_all(&output).expect("dense output");
        fs::write(output.join("dense.ply"), b"ply\n").expect("dense PLY");
        let record = MvsArtifactRecord {
            schema_version: 2,
            job_id: suffix.into(),
            dataset_relative_path: relative,
            output_index_sha256: ObjectHash::of_bytes(suffix.as_bytes()),
            output: MvsOutputIndex {
                schema_version: 1,
                job_id: suffix.into(),
                scene_manifest_sha256: ObjectHash::of_bytes(b"scene"),
                settings_sha256: ObjectHash::of_bytes(b"settings"),
                device: MvsComputeDevice::Cpu { threads: 1 },
                depth_images: Vec::new(),
                dense_point_cloud: Some(MvsDenseCloudRecord {
                    relative_path: "dense.ply".into(),
                    sha256: ObjectHash::of_bytes(b"ply\n"),
                    vertex_count: 0,
                    bytes: 4,
                    fusion: Some(himmelcad_sidecar::mvs_runtime::MvsDenseFusionEvidence {
                        algorithm: himmelcad_sidecar::mvs_runtime::MVS_DENSE_FUSION_ALGORITHM
                            .into(),
                        raw_sample_count: 0,
                        fused_sample_count: 0,
                        voxel_size_meters: 0.01,
                        minimum_representative_pixel_footprint_meters: 0.01,
                        median_representative_pixel_footprint_meters: 0.01,
                        maximum_representative_pixel_footprint_meters: 0.01,
                        external_sort_runs: 1,
                        maximum_buffered_samples: 1,
                    }),
                }),
            },
            command: MvsCommandReport {
                argv: Vec::new(),
                exit_code: Some(0),
                duration_ms: 1,
                log_tail: Vec::new(),
            },
            camera_entity_ids: Vec::new(),
            image_mask_scope_sha256: Some(ObjectHash::of_bytes(b"scope")),
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            gcp_optimization_entity_id: lineage.gcp_optimization_entity_id.clone(),
            gcp_optimization_snapshot_sha256: lineage.gcp_optimization_snapshot_sha256.clone(),
            potree: None,
        };
        let version_hash = put_project_object(
            &session.working_path,
            &serde_json::to_vec(&record).expect("MVS record JSON"),
        )
        .expect("MVS record object");
        let entity_id = EntityId(format!("{}:dense:{suffix}", session.manifest.project_id));
        session.manifest.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::PointCloud,
                name: suffix.into(),
                parent: None,
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash,
                bounds: None,
            },
        );
        entity_id
    }

    fn insert_test_depth_record(
        session: &mut ProjectSession,
        suffix: &str,
        lineage: &ProductLineage,
        settings_sha256: ObjectHash,
    ) -> EntityId {
        let relative = format!("datasets/mvs/{suffix}");
        let dataset = session.working_path.join(&relative);
        fs::create_dir_all(dataset.join("output")).expect("depth output");
        fs::create_dir_all(dataset.join("checkpoints")).expect("depth checkpoints");
        fs::write(dataset.join("output/index.json"), b"{}").expect("depth index");
        let scene = MvsSceneManifest {
            schema_version: 1,
            coordinate_frame_id: "frame".into(),
            image_mask_scope_sha256: Some(ObjectHash::of_bytes(b"scope")),
            images: Vec::new(),
        };
        let scene = serde_json::to_vec(&scene).expect("scene JSON");
        let scene_sha256 = ObjectHash::of_bytes(&scene);
        let scene_root = session
            .working_path
            .join(".photolab/mvs-scenes")
            .join(suffix);
        fs::create_dir_all(&scene_root).expect("scene cache");
        fs::write(scene_root.join("scene.json"), &scene).expect("scene manifest");
        let record = MvsArtifactRecord {
            schema_version: 2,
            job_id: suffix.into(),
            dataset_relative_path: relative,
            output_index_sha256: ObjectHash::of_bytes(b"{}"),
            output: MvsOutputIndex {
                schema_version: 1,
                job_id: suffix.into(),
                scene_manifest_sha256: scene_sha256,
                settings_sha256,
                device: MvsComputeDevice::Cpu { threads: 1 },
                depth_images: vec![himmelcad_sidecar::mvs_runtime::MvsDepthImageRecord {
                    image_id: "1".into(),
                    width: 1,
                    height: 1,
                    camera: himmelcad_sidecar::mvs_runtime::MvsPinholeCamera {
                        fx: 1.0,
                        fy: 1.0,
                        cx: 0.0,
                        cy: 0.0,
                        world_to_camera: [
                            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                        ],
                    },
                    tiles: Vec::new(),
                }],
                dense_point_cloud: None,
            },
            command: MvsCommandReport {
                argv: Vec::new(),
                exit_code: Some(0),
                duration_ms: 1,
                log_tail: Vec::new(),
            },
            camera_entity_ids: Vec::new(),
            image_mask_scope_sha256: Some(ObjectHash::of_bytes(b"scope")),
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
            gcp_optimization_entity_id: lineage.gcp_optimization_entity_id.clone(),
            gcp_optimization_snapshot_sha256: lineage.gcp_optimization_snapshot_sha256.clone(),
            potree: None,
        };
        let version_hash = put_project_object(
            &session.working_path,
            &serde_json::to_vec(&record).expect("depth record JSON"),
        )
        .expect("depth record object");
        let entity_id = EntityId(format!("{}:depth:{suffix}", session.manifest.project_id));
        session.manifest.entities.insert(
            entity_id.0.clone(),
            EntitySnapshot {
                id: entity_id.clone(),
                kind: EntityKind::DepthMap,
                name: suffix.into(),
                parent: None,
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash,
                bounds: None,
            },
        );
        entity_id
    }

    #[test]
    fn stale_lock_file_is_reclaimed_after_process_lock_was_released() {
        let root = temp_test_dir("stale-project-lock");
        fs::create_dir_all(&root).expect("test root");
        fs::write(root.join("manifest.json"), b"stale-test-manifest").expect("manifest");
        let path = root.join(".survey.hcadx.lock");
        fs::write(&path, br#"{"sessionId":"crashed","pid":999999}"#).expect("stale lock");

        let (lock, lease) =
            acquire_lock(&path, "new-session", &root).expect("stale OS lock must be reclaimable");
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("current lock bytes"))
                .expect("current lock JSON");
        assert_eq!(value["sessionId"], "new-session");
        assert_eq!(lease.schema_version, PROJECT_LEASE_SCHEMA_VERSION);
        release_lock(&lock, &path, "new-session").expect("release current lock");
        assert!(!path.exists());
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn project_lease_is_versioned_and_heartbeat_is_persisted() {
        let root = temp_test_dir("project-lease-heartbeat");
        let source = root.join("lease.hcad");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&source),
                name: "Lease".to_owned(),
            })
            .expect("project must be created");

        let lock_path = project_lock_path(&source);
        let opened: ProjectLeaseRecord =
            serde_json::from_slice(&fs::read(&lock_path).expect("lease bytes"))
                .expect("versioned lease JSON");
        assert_eq!(opened.schema_version, PROJECT_LEASE_SCHEMA_VERSION);
        assert!(!opened.host_name.is_empty());
        assert!(!opened.user_name.is_empty());
        assert_eq!(opened.process_id, std::process::id());
        assert_eq!(
            opened.source_fingerprint.kind,
            ProjectSourceFingerprintKind::Manifest
        );

        {
            let mut guard = runtime.session.lock().expect("session");
            guard
                .as_mut()
                .expect("open session")
                .lease
                .heartbeat_unix_ms = 0;
        }
        runtime.autosave().expect("autosave must persist heartbeat");
        let persisted: ProjectLeaseRecord =
            serde_json::from_slice(&fs::read(&lock_path).expect("updated lease bytes"))
                .expect("updated lease JSON");
        assert!(persisted.heartbeat_unix_ms >= opened.heartbeat_unix_ms);
        assert_eq!(persisted.opened_unix_ms, opened.opened_unix_ms);

        runtime.close().expect("project must close");
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn legacy_manifest_render_offset_is_normalized_to_easting_northing_once() {
        let root = temp_test_dir("legacy-axis-manifest");
        let project_path = root.join("legacy-axis.hcad");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&project_path),
                name: "Legacy axis".to_owned(),
            })
            .expect("project");

        {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open session");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            let legacy_camera = insert_test_camera(session, &images, "legacy", []);
            let current_hash = session
                .manifest
                .entities
                .get(&legacy_camera.0)
                .expect("legacy camera")
                .version_hash
                .clone();
            let mut legacy_metadata: CameraImageMetadataRecord = serde_json::from_slice(
                &fs::read(project_object_path(&session.working_path, &current_hash))
                    .expect("camera metadata"),
            )
            .expect("camera metadata JSON");
            legacy_metadata.schema_version = 1;
            let legacy_hash = put_project_object(
                &session.working_path,
                &serde_json::to_vec(&legacy_metadata).expect("legacy metadata JSON"),
            )
            .expect("legacy camera object");
            session
                .manifest
                .entities
                .get_mut(&legacy_camera.0)
                .expect("legacy camera")
                .version_hash = legacy_hash;
            let transformation: FrozenImportTransformation = serde_json::from_value(
                serde_json::json!({
                    "schemaVersion": 1,
                    "original": {
                        "horizontal": { "crs": { "kind": "epsg", "value": 4979 } },
                        "vertical": { "kind": "ellipsoidal" }
                    },
                    "target": {
                        "horizontal": { "crs": { "kind": "authority", "value": "EPSG:31468+7837" } },
                        "vertical": {
                            "kind": "normalHeight",
                            "verticalCrs": { "kind": "epsg", "value": 7837 }
                        }
                    },
                    "verticalMode": "transform",
                    "areaOfInterest": {
                        "westLongitude": 10.3,
                        "southLatitude": 47.6,
                        "eastLongitude": 10.4,
                        "northLatitude": 47.7
                    },
                    "pipeline": {
                        "operationId": "legacy-gk",
                        "operationName": "Legacy axis test",
                        "projPipeline": "+proj=pipeline +step +proj=tmerc +step +proj=axisswap +order=2,1",
                        "expectedAccuracyMm": 10.0,
                        "ballpark": false,
                        "selectionPolicy": { "allowBallpark": false, "onlyBest": true },
                        "grids": []
                    },
                    "databaseVersions": {
                        "projVersion": "test-proj",
                        "epsgDatabaseVersion": "test-epsg"
                    },
                    "decisionSha256": ObjectHash::of_bytes(b"legacy-decision")
                }),
            )
            .expect("transformation");
            let transformation_hash = put_project_object(
                &session.working_path,
                &serde_json::to_vec(&transformation).expect("transformation JSON"),
            )
            .expect("transformation object");
            session.manifest.coordinate_axis_contract_version = 1;
            session.manifest.render_offset.x = 5_281_200.5;
            session.manifest.render_offset.y = 4_375_550.25;
            session.manifest.render_offset.z = 735.8;
            session.manifest.reference_frame =
                Some(himmelcad_core::photolab_project::ProjectReferenceFrame {
                    target: transformation.target.clone(),
                    established_by_transformation_sha256: transformation_hash,
                });
            atomic_write_json(
                &session.working_path.join("manifest.json"),
                &session.manifest,
            )
            .expect("legacy manifest");
        }

        let migrated = read_manifest(&project_path).expect("migrated manifest");
        assert_eq!(migrated.coordinate_axis_contract_version, 2);
        assert_eq!(migrated.render_offset.x, 4_375_550.25);
        assert_eq!(migrated.render_offset.y, 5_281_200.5);
        assert_eq!(migrated.render_offset.z, 735.8);
        assert!(matches!(
            migrated.spatial_reference,
            himmelcad_core::photolab_capture::PhotolabSpatialReference::CrsBacked
        ));

        runtime.close().expect("close project");
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn create_journal_autosave_save_and_close_is_recoverable() {
        let root = temp_test_dir("project-runtime");
        let project_path = root.join("survey.hcad");
        let runtime = ProjectRuntime::default();
        let opened = runtime
            .create(CreateProjectParams {
                path: path_string(&project_path),
                name: "Survey".to_owned(),
            })
            .expect("project must be created");
        assert!(project_path.join(".project.lock").is_file());
        assert!(!opened.manifest.clean_shutdown);

        let started = runtime
            .append_journal(AppendJournalParams {
                command_kind: "ImportImages".to_owned(),
                payload: serde_json::json!({"count": 2}),
                affected_entities: Vec::new(),
                before_refs: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("journal start must be written");
        runtime
            .finish_journal(FinishJournalParams {
                command_id: started.command_id,
                state: JournalCommandState::Committed,
                affected_entities: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("journal finish must be written");
        let save = runtime.save().expect("save must succeed");
        assert_eq!(save.saved_generation, 2);
        runtime.close().expect("close must release lock");

        assert!(!project_path.join(".project.lock").exists());
        assert!(project_path.join("journal/0000000000000001.json").is_file());
        let manifest = read_manifest(&project_path).expect("manifest must remain valid");
        assert!(manifest.clean_shutdown);
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn processing_set_persists_immutable_sorted_camera_membership() {
        let root = temp_test_dir("processing-set");
        let runtime = ProjectRuntime::default();
        let opened = runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Processing set".into(),
            })
            .expect("project");
        let camera_a = EntityId(format!("{}:camera:b", opened.manifest.project_id));
        let camera_b = EntityId(format!("{}:camera:a", opened.manifest.project_id));
        {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            for id in [&camera_a, &camera_b] {
                session.manifest.entities.insert(
                    id.0.clone(),
                    EntitySnapshot {
                        id: id.clone(),
                        kind: EntityKind::CameraImage,
                        name: id.0.clone(),
                        parent: Some(images.clone()),
                        children: Vec::new(),
                        visibility: VisibilityState::default(),
                        version_hash: ObjectHash::of_bytes(id.0.as_bytes()),
                        bounds: None,
                    },
                );
                session
                    .manifest
                    .entities
                    .get_mut(&images.0)
                    .expect("images")
                    .children
                    .push(id.clone());
            }
        }
        runtime
            .create_processing_set(CreateProcessingSetParams {
                name: "Flug Nord".into(),
                camera_entity_ids: vec![camera_a.clone(), camera_b.clone(), camera_a.clone()],
            })
            .expect("create processing set");
        let duplicate = runtime
            .create_processing_set(CreateProcessingSetParams {
                name: "Same cameras, different label".into(),
                camera_entity_ids: vec![camera_a.clone(), camera_b.clone()],
            })
            .expect_err("identical immutable membership must not create ambiguous lineage");
        assert!(duplicate
            .to_string()
            .contains("already freezes this exact camera membership"));
        let records = runtime.list_processing_sets().expect("list");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "Flug Nord");
        assert_eq!(records[0].camera_entity_ids, vec![camera_b, camera_a]);
        assert_eq!(
            records[0].membership_sha256,
            ObjectHash::of_bytes(&serde_json::to_vec(&records[0].camera_entity_ids).unwrap())
        );
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn capture_group_persists_distinct_autofocus_calibration_groups() {
        let root = temp_test_dir("capture-group");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Two autofocus sessions".into(),
            })
            .expect("project");
        let (camera_a, camera_b, camera_c) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            let ids = ["camera-a", "camera-b", "camera-c"].map(|suffix| {
                let id = EntityId(format!("{}:{suffix}", session.manifest.project_id));
                session.manifest.entities.insert(
                    id.0.clone(),
                    EntitySnapshot {
                        id: id.clone(),
                        kind: EntityKind::CameraImage,
                        name: suffix.into(),
                        parent: Some(images.clone()),
                        children: Vec::new(),
                        visibility: VisibilityState::default(),
                        version_hash: ObjectHash::of_bytes(suffix.as_bytes()),
                        bounds: None,
                    },
                );
                id
            });
            (ids[0].clone(), ids[1].clone(), ids[2].clone())
        };
        runtime
            .create_capture_group(CreateCaptureGroupParams {
                name: "Mission 2".into(),
                camera_entity_ids: vec![camera_a.clone(), camera_b.clone(), camera_c.clone()],
                calibration_groups: vec![
                    CreateCalibrationGroupInput {
                        name: "Before landing".into(),
                        camera_entity_ids: vec![camera_a.clone(), camera_b.clone()],
                        grouping_basis: CameraCalibrationGroupingBasis::MissionAutofocus,
                        initial_calibration: None,
                    },
                    CreateCalibrationGroupInput {
                        name: "After landing".into(),
                        camera_entity_ids: vec![camera_c.clone()],
                        grouping_basis: CameraCalibrationGroupingBasis::MissionAutofocus,
                        initial_calibration: None,
                    },
                ],
            })
            .expect("capture group");
        let captures = runtime.list_capture_groups().expect("captures");
        let calibrations = runtime.list_calibration_groups().expect("calibrations");
        assert_eq!(captures.len(), 1);
        assert_eq!(calibrations.len(), 2);
        assert_eq!(captures[0].calibration_group_ids.len(), 2);
        assert!(calibrations
            .iter()
            .all(|group| group.capture_group_id == captures[0].entity_id));
        runtime
            .create_processing_set(CreateProcessingSetParams {
                name: "Mission 2 processing".into(),
                camera_entity_ids: vec![camera_a, camera_b, camera_c],
            })
            .expect("processing set");
        let sets = runtime.list_processing_sets().expect("processing sets");
        assert_eq!(sets[0].schema_version, 2);
        assert_eq!(
            sets[0].capture_group_ids,
            vec![captures[0].entity_id.clone()]
        );
        assert_eq!(sets[0].calibration_group_ids.len(), 2);
        let compute_groups = runtime
            .calibration_groups_for_camera_scope(
                &sets[0]
                    .camera_entity_ids
                    .iter()
                    .map(|id| id.0.clone())
                    .collect::<Vec<_>>(),
            )
            .expect("compute calibration partition");
        assert_eq!(compute_groups.len(), 2);
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cameras_outside_capture_groups_keep_independent_intrinsics() {
        let root = temp_test_dir("partial-capture-group");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Partial capture metadata".into(),
            })
            .expect("project");
        let (camera_a, camera_b, ungrouped) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            (
                insert_test_camera(session, &images, "grouped-a", []),
                insert_test_camera(session, &images, "grouped-b", []),
                insert_test_camera(session, &images, "ungrouped", []),
            )
        };
        runtime
            .create_capture_group(CreateCaptureGroupParams {
                name: "Known mission".into(),
                camera_entity_ids: vec![camera_a.clone(), camera_b.clone()],
                calibration_groups: vec![CreateCalibrationGroupInput {
                    name: "Known autofocus".into(),
                    camera_entity_ids: vec![camera_a.clone(), camera_b.clone()],
                    grouping_basis: CameraCalibrationGroupingBasis::MissionAutofocus,
                    initial_calibration: None,
                }],
            })
            .expect("capture group");
        let groups = runtime
            .calibration_groups_for_camera_scope(&[camera_a.0, camera_b.0, ungrouped.0.clone()])
            .expect("complete runtime calibration partition");
        assert_eq!(groups.len(), 2);
        let fallback = groups
            .iter()
            .find(|group| group.group_id.starts_with("implicit-independent:"))
            .expect("ungrouped singleton");
        assert_eq!(fallback.camera_entity_ids, vec![ungrouped.0]);
        assert!(fallback.seed.is_none());
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn processing_set_selects_newest_exact_alignment_membership() {
        let root = temp_test_dir("processing-set-alignment-lineage");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Lineage".into(),
            })
            .expect("project");
        let (camera_a, camera_b, camera_c) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            (
                insert_test_camera(session, &images, "a", []),
                insert_test_camera(session, &images, "b", []),
                insert_test_camera(session, &images, "c", []),
            )
        };
        runtime
            .create_processing_set(CreateProcessingSetParams {
                name: "A+B".into(),
                camera_entity_ids: vec![camera_a.clone(), camera_b.clone()],
            })
            .expect("processing set");
        runtime
            .create_processing_set(CreateProcessingSetParams {
                name: "B+C".into(),
                camera_entity_ids: vec![camera_b.clone(), camera_c.clone()],
            })
            .expect("unmatched processing set");
        let processing_sets = runtime.list_processing_sets().expect("processing sets");
        let processing_set = processing_sets
            .iter()
            .find(|record| record.name == "A+B")
            .expect("matching processing set")
            .clone();
        let unmatched = processing_sets
            .iter()
            .find(|record| record.name == "B+C")
            .expect("unmatched processing set");
        let expected_alignment = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            insert_test_alignment(session, "ab-old", 1, &[camera_a.clone(), camera_b.clone()]);
            let expected =
                insert_test_alignment(session, "ab-new", 2, &[camera_b.clone(), camera_a.clone()]);
            insert_test_alignment(session, "ac-global-newest", 99, &[camera_a, camera_c]);
            expected
        };

        let selected = runtime
            .latest_alignment_dataset_for_processing_set(Some(&processing_set.entity_id))
            .expect("exact alignment");
        assert_eq!(selected.source_alignment_entity_id, expected_alignment);
        assert_eq!(selected.processing_set_id, Some(processing_set.entity_id));
        assert_eq!(
            selected.camera_entity_ids,
            processing_set
                .camera_entity_ids
                .into_iter()
                .map(|id| id.0)
                .collect::<Vec<_>>()
        );
        assert!(runtime
            .latest_alignment_dataset_for_processing_set(Some(&EntityId("missing".into())))
            .expect_err("unknown processing set must fail")
            .to_string()
            .contains("unknown processing set"));
        assert!(runtime
            .latest_alignment_dataset_for_processing_set(Some(&unmatched.entity_id))
            .expect_err("mismatched camera membership must fail")
            .to_string()
            .contains("exactly matches processing set"));
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn product_record_lineage_requires_both_alignment_and_processing_set() {
        let alignment = EntityId("alignment-a".into());
        let processing_set = EntityId("processing-a".into());
        let required = ProductLineage {
            source_alignment_entity_id: alignment.clone(),
            processing_set_id: Some(processing_set.clone()),
            gcp_optimization_entity_id: Some(EntityId("gcp-revision-a".into())),
            gcp_optimization_snapshot_sha256: Some(ObjectHash::of_bytes(b"gcp-snapshot-a")),
            image_mask_scope_sha256: ObjectHash::of_bytes(b"scope"),
        };
        assert!(record_matches_lineage(
            Some(&alignment),
            Some(&processing_set),
            &required
        ));
        assert!(!record_matches_lineage(Some(&alignment), None, &required));
        assert!(!record_matches_lineage(
            Some(&EntityId("alignment-b".into())),
            Some(&processing_set),
            &required
        ));
        assert!(product_record_matches_lineage(
            Some(&alignment),
            Some(&processing_set),
            required.gcp_optimization_entity_id.as_ref(),
            required.gcp_optimization_snapshot_sha256.as_ref(),
            Some(&required.image_mask_scope_sha256),
            &required,
        ));
        assert!(!product_record_matches_lineage(
            Some(&alignment),
            Some(&processing_set),
            Some(&EntityId("gcp-revision-b".into())),
            required.gcp_optimization_snapshot_sha256.as_ref(),
            Some(&required.image_mask_scope_sha256),
            &required,
        ));
    }

    #[test]
    fn dense_dependency_selection_ignores_newer_incompatible_lineage() {
        let root = temp_test_dir("dense-lineage-selection");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Dense lineage".into(),
            })
            .expect("project");
        let expected = ProductLineage {
            source_alignment_entity_id: EntityId("alignment-a".into()),
            processing_set_id: Some(EntityId("set-a".into())),
            gcp_optimization_entity_id: Some(EntityId("gcp-a".into())),
            gcp_optimization_snapshot_sha256: Some(ObjectHash::of_bytes(b"gcp-a")),
            image_mask_scope_sha256: ObjectHash::of_bytes(b"scope"),
        };
        let incompatible = ProductLineage {
            source_alignment_entity_id: EntityId("alignment-b".into()),
            processing_set_id: Some(EntityId("set-b".into())),
            gcp_optimization_entity_id: Some(EntityId("gcp-b".into())),
            gcp_optimization_snapshot_sha256: Some(ObjectHash::of_bytes(b"gcp-b")),
            image_mask_scope_sha256: ObjectHash::of_bytes(b"other-scope"),
        };
        {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            insert_test_dense_record(session, "a-compatible", &expected);
            insert_test_dense_record(session, "z-incompatible-newer", &incompatible);
        }
        let (path, record) = runtime
            .latest_dense_mvs_dataset_for_lineage(&expected)
            .expect("compatible dense dependency");
        assert!(path.ends_with("datasets/mvs/a-compatible/output/dense.ply"));
        assert_eq!(
            record.source_alignment_entity_id.as_ref(),
            Some(&expected.source_alignment_entity_id)
        );
        assert_eq!(
            record.processing_set_id.as_ref(),
            expected.processing_set_id.as_ref()
        );
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn depth_reuse_requires_lineage_settings_and_a_pinned_scene_cache() {
        let root = temp_test_dir("depth-reuse-selection");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Depth reuse".into(),
            })
            .expect("project");
        let expected = ProductLineage {
            source_alignment_entity_id: EntityId("alignment-a".into()),
            processing_set_id: Some(EntityId("set-a".into())),
            gcp_optimization_entity_id: Some(EntityId("gcp-a".into())),
            gcp_optimization_snapshot_sha256: Some(ObjectHash::of_bytes(b"gcp-a")),
            image_mask_scope_sha256: ObjectHash::of_bytes(b"scope"),
        };
        let incompatible = ProductLineage {
            source_alignment_entity_id: EntityId("alignment-b".into()),
            processing_set_id: Some(EntityId("set-b".into())),
            gcp_optimization_entity_id: Some(EntityId("gcp-b".into())),
            gcp_optimization_snapshot_sha256: Some(ObjectHash::of_bytes(b"gcp-b")),
            image_mask_scope_sha256: ObjectHash::of_bytes(b"other-scope"),
        };
        let settings = ObjectHash::of_bytes(b"settings-a");
        {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open");
            insert_test_depth_record(session, "a-compatible", &expected, settings.clone());
            insert_test_depth_record(session, "x-wrong-lineage", &incompatible, settings.clone());
            insert_test_depth_record(
                session,
                "y-wrong-settings",
                &expected,
                ObjectHash::of_bytes(b"settings-b"),
            );
            insert_test_depth_record(session, "z-missing-scene", &expected, settings.clone());
            fs::remove_file(
                session
                    .working_path
                    .join(".photolab/mvs-scenes/z-missing-scene/scene.json"),
            )
            .expect("remove newest scene cache");
        }
        let (path, record) = runtime
            .latest_compatible_depth_mvs_dataset_for_lineage(
                &expected,
                &settings,
                &ObjectHash::of_bytes(b"scope"),
            )
            .expect("depth lookup")
            .expect("compatible depth product");
        assert!(path.ends_with("datasets/mvs/a-compatible"));
        assert_eq!(record.job_id, "a-compatible");
        assert_eq!(record.output.settings_sha256, settings);
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn camera_product_tags_only_change_inside_the_frozen_run_scope() {
        let root = temp_test_dir("scoped-camera-product-tags");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Scoped camera tags".into(),
            })
            .expect("project");
        let (camera_a, camera_b, camera_c) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open project");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            let ready = [ImageProductTag::Aligned, ImageProductTag::DepthReady];
            let camera_a = insert_test_camera(session, &images, "a", ready);
            let camera_b = insert_test_camera(session, &images, "b", []);
            let camera_c = insert_test_camera(session, &images, "c", ready);
            let mut after_refs = Vec::new();
            update_camera_product_tags(
                &session.working_path,
                &mut session.manifest,
                std::slice::from_ref(&camera_a.0),
                true,
                false,
                &mut after_refs,
            )
            .expect("publish partial alignment tags");
            update_camera_product_tags(
                &session.working_path,
                &mut session.manifest,
                std::slice::from_ref(&camera_b.0),
                false,
                true,
                &mut after_refs,
            )
            .expect("publish partial depth tags");
            (camera_a, camera_b, camera_c)
        };

        let cameras = runtime
            .list_camera_images()
            .expect("read updated camera records")
            .into_iter()
            .map(|camera| (camera.entity_id, camera.metadata.status_tags))
            .collect::<HashMap<_, _>>();
        assert_eq!(
            cameras[&camera_a],
            [ImageProductTag::Aligned, ImageProductTag::DepthStale]
                .into_iter()
                .collect()
        );
        assert_eq!(
            cameras[&camera_b],
            [ImageProductTag::Aligned, ImageProductTag::DepthReady]
                .into_iter()
                .collect()
        );
        assert_eq!(
            cameras[&camera_c],
            [ImageProductTag::Aligned, ImageProductTag::DepthReady]
                .into_iter()
                .collect()
        );
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn prepared_colmap_meshes_list_canonical_contracts_and_export_originals() {
        let root = temp_test_dir("raw-colmap-mesh-product");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Raw COLMAP mesh product".into(),
            })
            .expect("project");
        let camera_id = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open project");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            insert_test_camera(session, &images, "mesh-source", [])
        };
        let scratch = root.join("colmap-mesh-scratch");
        fs::create_dir_all(scratch.join("sparse/0")).expect("sparse model directory");
        fs::create_dir_all(scratch.join("dense/textured")).expect("textured mesh directory");
        fs::write(scratch.join("dense/meshed-poisson.ply"), b"ply\n").expect("raw mesh artifact");
        fs::write(scratch.join("dense/textured/mesh.ply"), b"ply\n")
            .expect("textured mesh source artifact");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([10, 20, 30, 255]))
            .save(scratch.join("dense/textured/texture.png"))
            .expect("textured mesh atlas");
        let mut prepared_mesh = build_prepared_triangle_mesh(
            [TriangleRecord {
                positions: [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                material_slot: None,
                texture_coordinates: None,
            }],
            &scratch.join("prepared-mesh"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("prepare COLMAP mesh fixture");
        prepared_mesh.manifest_relative_path =
            PathBuf::from("prepared-mesh").join(prepared_mesh.manifest_relative_path);
        prepared_mesh.preparation_descriptor_relative_path = prepared_mesh
            .preparation_descriptor_relative_path
            .map(|path| PathBuf::from("prepared-mesh").join(path));
        prepared_mesh.kernel_manifest_relative_path = prepared_mesh
            .kernel_manifest_relative_path
            .map(|path| PathBuf::from("prepared-mesh").join(path));
        if let Some(topology) = prepared_mesh.section_topology.as_mut() {
            topology.manifest_relative_path =
                PathBuf::from("prepared-mesh").join(&topology.manifest_relative_path);
        }
        let mut prepared_textured_mesh = build_prepared_textured_triangle_mesh(
            [TriangleRecord {
                positions: [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                material_slot: None,
                texture_coordinates: Some([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]),
            }],
            &scratch.join("dense/textured/texture.png"),
            &scratch.join("prepared-textured-mesh"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("prepare textured COLMAP mesh fixture");
        prepared_textured_mesh.manifest_relative_path = PathBuf::from("prepared-textured-mesh")
            .join(prepared_textured_mesh.manifest_relative_path);
        prepared_textured_mesh.preparation_descriptor_relative_path = prepared_textured_mesh
            .preparation_descriptor_relative_path
            .map(|path| PathBuf::from("prepared-textured-mesh").join(path));
        prepared_textured_mesh.kernel_manifest_relative_path = prepared_textured_mesh
            .kernel_manifest_relative_path
            .map(|path| PathBuf::from("prepared-textured-mesh").join(path));
        if let Some(topology) = prepared_textured_mesh.section_topology.as_mut() {
            topology.manifest_relative_path =
                PathBuf::from("prepared-textured-mesh").join(&topology.manifest_relative_path);
        }
        let summary = ColmapOutputSummary {
            schema_version: 2,
            job_id: "raw-colmap-mesh-test".into(),
            tool_manifest_sha256: ObjectHash::of_bytes(b"tools"),
            executable_sha256: ObjectHash::of_bytes(b"colmap"),
            colmap_version: "test".into(),
            camera_entity_ids: vec![camera_id.0],
            image_mask_scope_sha256: None,
            calibration_groups: Vec::new(),
            intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
            selected_mapper: SelectedMapper::Global,
            selected_feature_store: SelectedFeatureStore::Aliked,
            mapping_candidates: Vec::new(),
            commands: Vec::new(),
            artifacts: vec![
                ColmapArtifactSummary {
                    kind: ColmapArtifactKind::SparseModel,
                    relative_path: "sparse/0".into(),
                    sha256: ObjectHash::of_bytes(b"model"),
                    bytes: 0,
                },
                ColmapArtifactSummary {
                    kind: ColmapArtifactKind::Mesh,
                    relative_path: "dense/meshed-poisson.ply".into(),
                    sha256: ObjectHash::of_bytes(b"mesh"),
                    bytes: 4,
                },
                ColmapArtifactSummary {
                    kind: ColmapArtifactKind::TexturedMesh,
                    relative_path: "dense/textured".into(),
                    sha256: ObjectHash::of_bytes(b"textured"),
                    bytes: 7,
                },
            ],
        };
        let published = runtime
            .publish_colmap_outcome_for_processing_set(
                ColmapRunOutcome {
                    scratch_path: scratch.clone(),
                    summary_path: scratch.join("summary.json"),
                    summary_sha256: ObjectHash::of_bytes(b"summary"),
                    summary,
                    sparse_potree: None,
                    prepared_mesh: Some(prepared_mesh),
                    prepared_textured_mesh: Some(prepared_textured_mesh),
                },
                None,
            )
            .expect("publish COLMAP mesh products");
        assert_eq!(published.entity_ids.len(), 3);
        let datasets = runtime
            .list_product_datasets()
            .expect("prepared mesh and textured mesh listing");
        assert_eq!(datasets.len(), 2);
        assert_eq!(datasets[0].entity_id, published.entity_ids[1]);
        assert!(datasets[0]
            .relative_path
            .ends_with("prepared-mesh/manifest.json"));
        let kernel = datasets[0]
            .prepared_mesh
            .as_ref()
            .expect("kernel prepared mesh contract");
        assert!(kernel
            .render_manifest_relative_path
            .ends_with("prepared-mesh/kernel-manifest.json"));
        assert_eq!(
            kernel.preparation_descriptor_resource.media_type,
            "hcad.prepared-triangle-mesh-recipe@1"
        );
        assert_eq!(kernel.provider_id, "hcad.prepared-triangle-mesh");
        assert_eq!(kernel.provider_version, "1.0.0");
        assert_eq!(
            kernel.canonical_dataset.entity_id,
            published.entity_ids[1].0
        );
        assert!(kernel.canonical_dataset.typed_artifact_manifest().is_some());
        assert!(kernel
            .canonical_dataset
            .artifacts
            .iter()
            .any(|artifact| artifact.resource.media_type.starts_with("hcad.positions-f")));
        assert!(kernel
            .canonical_dataset
            .artifacts
            .iter()
            .any(|artifact| artifact.resource.media_type == "hcad.indices-u32le@1"));
        assert_eq!(
            kernel.dataset_id,
            format!(
                "prepared-mesh-{}",
                kernel.render_manifest_resource.object_hash.as_str()
            )
        );
        assert_eq!(
            kernel.canonical_admission.entity.id,
            published.entity_ids[1]
        );
        assert_eq!(
            kernel.canonical_admission.entity.type_id.0,
            built_in_type::SURFACE_3D
        );
        validate_resolved_representation(
            &kernel.canonical_admission.entity,
            &kernel.canonical_admission.selected,
            &kernel.canonical_admission.resolved_geometry,
        )
        .expect("valid canonical prepared mesh admission");
        let GeometryObject::Surface3d { mesh } = &kernel.canonical_admission.resolved_geometry
        else {
            panic!("open COLMAP mesh must be a canonical spatial surface");
        };
        let TriangleMeshStorage::Resource { resource } = &mesh.storage else {
            panic!("prepared mesh must remain resource-backed");
        };
        assert_eq!(resource, &kernel.render_manifest_resource);
        assert_eq!(kernel.canonical_objects.len(), 3);
        for object in &kernel.canonical_objects {
            assert_eq!(
                object.object_hash,
                ObjectHash::of_bytes(&serde_json::to_vec(&object.value).unwrap())
            );
        }
        let textured = datasets
            .iter()
            .find(|dataset| dataset.entity_id == published.entity_ids[2])
            .expect("prepared textured mesh listing");
        assert!(textured
            .relative_path
            .ends_with("prepared-textured-mesh/manifest.json"));
        let textured_kernel = textured
            .prepared_mesh
            .as_ref()
            .expect("canonical textured mesh contract");
        let GeometryObject::Surface3d { mesh } =
            &textured_kernel.canonical_admission.resolved_geometry
        else {
            panic!("open textured COLMAP mesh must be a spatial surface");
        };
        let TriangleMeshStorage::Resource { resource } = &mesh.storage else {
            panic!("textured mesh must remain resource-backed");
        };
        assert_eq!(resource, &textured_kernel.render_manifest_resource);

        let mesh_export = runtime
            .product_export_source(&published.entity_ids[1])
            .expect("raw mesh export");
        assert_eq!(mesh_export.kind, ProductExportSourceKind::File);
        assert!(mesh_export
            .source_path
            .ends_with("dense/meshed-poisson.ply"));
        assert!(mesh_export.suggested_name.ends_with(".ply"));

        let textured_export = runtime
            .product_export_source(&published.entity_ids[2])
            .expect("textured mesh export");
        assert_eq!(textured_export.kind, ProductExportSourceKind::Directory);
        assert!(textured_export.source_path.ends_with("dense/textured"));
        assert!(textured_export.suggested_name.ends_with("-mesh"));
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn sparse_alignment_cloud_is_published_as_a_tiled_child_and_exportable_product() {
        let root = temp_test_dir("sparse-alignment-product");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Sparse alignment product".into(),
            })
            .expect("project");
        let camera_id = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open project");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            insert_test_camera(session, &images, "aligned", [])
        };
        let scratch = root.join("alignment-scratch");
        fs::create_dir_all(scratch.join("sparse/0")).expect("sparse model");
        fs::write(scratch.join("sparse/0/cameras.bin"), b"model").expect("model file");
        fs::create_dir_all(scratch.join("sparse-view-source")).expect("sparse source");
        fs::write(
            scratch.join("sparse-view-source/cameras.txt"),
            b"1 PINHOLE 100 80 90 91 50 40\n",
        )
        .expect("cameras");
        fs::write(
            scratch.join("sparse-view-source/images.txt"),
            b"1 1 0 0 0 0 0 0 1 image.jpg\n\n",
        )
        .expect("images");
        fs::write(
            scratch.join("sparse-view-source/points3D.txt"),
            b"1 1000 2000 3000 10 20 30 0.25\n",
        )
        .expect("points3D");
        fs::create_dir_all(scratch.join("sparse-potree/octree")).expect("Potree output");
        fs::write(scratch.join("sparse-potree/octree/metadata.json"), b"{}").expect("metadata");
        fs::write(scratch.join("sparse-potree/export.ply"), b"ply\n").expect("portable PLY");
        let frozen_camera_id = camera_id.0.clone();
        let summary = ColmapOutputSummary {
            schema_version: 2,
            job_id: "alignment-sparse-test".into(),
            tool_manifest_sha256: ObjectHash::of_bytes(b"tools"),
            executable_sha256: ObjectHash::of_bytes(b"colmap"),
            colmap_version: "test".into(),
            camera_entity_ids: vec![frozen_camera_id.clone()],
            image_mask_scope_sha256: None,
            calibration_groups: vec![ColmapCalibrationGroup {
                group_id: "mission-a-autofocus-1".into(),
                camera_entity_ids: vec![frozen_camera_id.clone()],
                seed: None,
            }],
            intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
            selected_mapper: SelectedMapper::Global,
            selected_feature_store: SelectedFeatureStore::Aliked,
            mapping_candidates: Vec::new(),
            commands: Vec::new(),
            artifacts: vec![
                ColmapArtifactSummary {
                    kind: ColmapArtifactKind::SparseModel,
                    relative_path: "sparse/0".into(),
                    sha256: ObjectHash::of_bytes(b"model"),
                    bytes: 5,
                },
                ColmapArtifactSummary {
                    kind: ColmapArtifactKind::SparsePointCloud,
                    relative_path: "sparse-view-source/points3D.txt".into(),
                    sha256: ObjectHash::of_bytes(b"points"),
                    bytes: 34,
                },
            ],
        };
        let published = runtime
            .publish_colmap_outcome_for_processing_set(
                ColmapRunOutcome {
                    scratch_path: scratch.clone(),
                    summary_path: scratch.join("summary.json"),
                    summary_sha256: ObjectHash::of_bytes(b"summary"),
                    summary,
                    sparse_potree: Some(PreparedPotreeCloud {
                        relative_metadata_path: "sparse-potree/octree/metadata.json".into(),
                        export_relative_path: Some("sparse-potree/export.ply".into()),
                        point_count: 1,
                        render_offset: [1000.0, 2000.0, 3000.0],
                        bounds_min: [1000.0, 2000.0, 3000.0],
                        bounds_max: [1000.0, 2000.0, 3000.0],
                    }),
                    prepared_mesh: None,
                    prepared_textured_mesh: None,
                },
                None,
            )
            .expect("publish sparse alignment");
        assert!(
            !scratch.exists(),
            "publication must move the scratch dataset"
        );
        assert_eq!(published.entity_ids.len(), 2);
        let alignment_id = &published.entity_ids[0];
        let sparse_id = &published.entity_ids[1];
        let manifest = runtime.snapshot().expect("project snapshot").manifest;
        assert_eq!(
            manifest.entities[&sparse_id.0].parent.as_ref(),
            Some(alignment_id)
        );
        assert_eq!(
            manifest.entities[&alignment_id.0].children,
            vec![sparse_id.clone()]
        );
        let merge_candidates = runtime
            .list_alignment_merge_candidates()
            .expect("alignment merge candidates");
        let candidate = merge_candidates
            .iter()
            .find(|candidate| candidate.entity_id == *alignment_id)
            .expect("published alignment candidate");
        assert_eq!(candidate.job_id, "alignment-sparse-test");
        assert_eq!(candidate.calibration_groups.len(), 1);
        assert_eq!(
            candidate.calibration_groups[0].camera_entity_ids,
            vec![frozen_camera_id]
        );

        let datasets = runtime.list_product_datasets().expect("product datasets");
        let sparse = datasets
            .iter()
            .find(|dataset| dataset.entity_id == *sparse_id)
            .expect("sparse product dataset");
        assert_eq!(sparse.kind, "sparse");
        assert_eq!(sparse.format, "potreeV2");
        assert_eq!(sparse.point_count, Some(1));
        assert_eq!(
            sparse.source_alignment_entity_id.as_ref(),
            Some(alignment_id)
        );
        assert!(sparse.processing_set_id.is_none());
        assert!(sparse
            .relative_path
            .ends_with("sparse-potree/octree/metadata.json"));

        let export = runtime
            .product_export_source(sparse_id)
            .expect("sparse product export");
        assert_eq!(export.kind, ProductExportSourceKind::File);
        assert!(export.source_path.ends_with("sparse-potree/export.ply"));
        let camera_export = runtime
            .product_export_source(alignment_id)
            .expect("alignment camera export");
        assert_eq!(camera_export.kind, ProductExportSourceKind::Directory);
        assert!(camera_export.source_path.ends_with("sparse-view-source"));
        assert!(camera_export.suggested_name.ends_with("-cameras"));
        let ProductExportConversion::Cameras { calibration_groups } = camera_export.conversion
        else {
            panic!("alignment export must carry calibration metadata");
        };
        assert_eq!(calibration_groups.len(), 1);
        assert_eq!(
            calibration_groups[0].intrinsics_refinement,
            ColmapIntrinsicsRefinement::Refine
        );
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn legacy_alignment_scope_is_recovered_from_its_camera_map_only() {
        let root = temp_test_dir("legacy-alignment-scope");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("project.hcad")),
                name: "Legacy alignment scope".into(),
            })
            .expect("project");
        let (record, manifest, dataset, expected) = {
            let mut guard = runtime.session.lock().expect("session");
            let session = guard.as_mut().expect("open project");
            let images =
                unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")
                    .expect("images");
            let camera_a = insert_test_camera(session, &images, "a", []);
            let camera_b = insert_test_camera(session, &images, "b", []);
            let _camera_outside_scope = insert_test_camera(session, &images, "outside", []);
            let dataset = session.working_path.join("legacy-alignment");
            fs::create_dir_all(&dataset).expect("dataset");
            fs::write(
                dataset.join("camera-map.json"),
                serde_json::to_vec(&serde_json::json!([
                    {"entityId": camera_b.0.clone()},
                    {"entityId": camera_a.0.clone()},
                ]))
                .expect("camera map JSON"),
            )
            .expect("camera map");
            (
                ComputeArtifactRecord {
                    schema_version: 1,
                    job_id: "legacy".into(),
                    dataset_relative_path: "legacy-alignment".into(),
                    artifact: ColmapArtifactSummary {
                        kind: ColmapArtifactKind::SparseModel,
                        relative_path: "sparse/0".into(),
                        sha256: ObjectHash::of_bytes(b"sparse"),
                        bytes: 1,
                    },
                    camera_entity_ids: Vec::new(),
                    image_mask_scope_sha256: None,
                    calibration_groups: Vec::new(),
                    intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
                    processing_set_id: None,
                    publication_sequence: 1,
                    selected_mapper: SelectedMapper::Global,
                    tool_manifest_sha256: ObjectHash::of_bytes(b"tools"),
                    parent_alignment_entity_id: None,
                    potree: None,
                },
                session.manifest.clone(),
                dataset,
                vec![camera_a.0, camera_b.0],
            )
        };
        assert_eq!(
            alignment_camera_scope(&record, &dataset, &manifest).expect("legacy camera scope"),
            expected
        );
        fs::remove_file(dataset.join("camera-map.json")).expect("remove map");
        assert!(alignment_camera_scope(&record, &dataset, &manifest).is_err());
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn entity_tree_commands_are_atomic_journalled_and_cycle_safe() {
        let root = temp_test_dir("entity-tree-commands");
        let project_path = root.join("survey.hcad");
        let runtime = ProjectRuntime::default();
        let opened = runtime
            .create(CreateProjectParams {
                path: path_string(&project_path),
                name: "Survey".to_owned(),
            })
            .expect("project");
        let reference = opened
            .manifest
            .entities
            .values()
            .find(|entity| entity.name == "Reference & GCPs")
            .expect("reference group")
            .id
            .clone();
        let products = opened
            .manifest
            .entities
            .values()
            .find(|entity| entity.name == "Products")
            .expect("products group")
            .id
            .clone();
        runtime
            .rename_entity(RenameEntityParams {
                entity_id: reference.clone(),
                name: "Passpunkte".into(),
            })
            .expect("rename");
        runtime
            .set_entity_visibility(SetEntityVisibilityParams {
                entity_id: products.clone(),
                visible: false,
            })
            .expect("visibility");
        let moved = runtime
            .move_entity(MoveEntityParams {
                entity_id: products.clone(),
                new_parent_id: opened.manifest.root_entity.clone(),
            })
            .expect("move");
        assert_eq!(moved.manifest.entities[&reference.0].name, "Passpunkte");
        assert!(!moved.manifest.entities[&products.0].visibility.visible);
        assert_eq!(
            moved.manifest.entities[&products.0].parent.as_ref(),
            Some(&opened.manifest.root_entity)
        );
        assert!(runtime
            .move_entity(MoveEntityParams {
                entity_id: opened.manifest.root_entity.clone(),
                new_parent_id: products,
            })
            .is_err());
        assert_eq!(moved.manifest.autosave_generation, 3);
        assert!(project_path.join("journal/0000000000000003.json").is_file());
        runtime.close().expect("close");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn opening_into_local_copy_keeps_source_and_working_paths_explicit() {
        let root = temp_test_dir("project-working-copy");
        let source = root.join("source.hcad");
        let first = ProjectRuntime::default();
        first
            .create(CreateProjectParams {
                path: path_string(&source),
                name: "Network survey".to_owned(),
            })
            .expect("source project must be created");
        first.close().expect("source project must close");

        let second = ProjectRuntime::default();
        let opened = second
            .open(&OpenProjectParams {
                path: path_string(&source),
                working_root: path_string(&root.join("cache")),
                use_local_working_copy: true,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("project must open in local copy");
        assert!(opened.session.uses_local_working_copy);
        assert_ne!(opened.session.source_path, opened.session.working_path);
        assert!(Path::new(&opened.session.working_path)
            .join("manifest.json")
            .is_file());
        second.close().expect("working session must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn object_store_is_content_addressed_and_deduplicated() {
        let root = temp_test_dir("project-objects");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("objects.hcad")),
                name: "Objects".to_owned(),
            })
            .expect("project must be created");
        let first = runtime.put_object(b"same object").expect("object write");
        let second = runtime.put_object(b"same object").expect("object dedupe");
        assert_eq!(first, second);
        runtime.close().expect("project must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn second_runtime_cannot_open_locked_project() {
        let root = temp_test_dir("project-lock");
        let source = root.join("locked.hcad");
        let owner = ProjectRuntime::default();
        owner
            .create(CreateProjectParams {
                path: path_string(&source),
                name: "Locked".to_owned(),
            })
            .expect("project must be created");
        let contender = ProjectRuntime::default();
        let error = contender
            .open(&OpenProjectParams {
                path: path_string(&source),
                working_root: path_string(&root.join("cache")),
                use_local_working_copy: true,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect_err("locked project must not open twice");
        assert!(error.to_string().contains("locked"));
        assert!(error.to_string().contains("Active lease belongs to user"));
        assert!(error.to_string().contains("session"));
        owner.close().expect("owner must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn save_refuses_to_overwrite_an_externally_changed_source_manifest() {
        let root = temp_test_dir("project-external-source-change");
        let source = root.join("source.hcad");
        let creator = ProjectRuntime::default();
        creator
            .create(CreateProjectParams {
                path: path_string(&source),
                name: "Source".to_owned(),
            })
            .expect("source project must be created");
        creator.close().expect("creator must close");

        let runtime = ProjectRuntime::default();
        runtime
            .open(&OpenProjectParams {
                path: path_string(&source),
                working_root: path_string(&root.join("cache")),
                use_local_working_copy: true,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("project must open in a local working copy");
        runtime
            .append_journal(AppendJournalParams {
                command_kind: "ExternalChangeGuard".to_owned(),
                payload: serde_json::Value::Null,
                affected_entities: Vec::new(),
                before_refs: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("working copy must become dirty");

        let manifest_path = source.join("manifest.json");
        let mut external_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("source manifest"))
                .expect("manifest JSON");
        external_manifest["name"] = serde_json::Value::String("Externally edited".to_owned());
        let external_bytes = serde_json::to_vec_pretty(&external_manifest).expect("external JSON");
        fs::write(&manifest_path, &external_bytes).expect("external edit");

        let error = runtime
            .save()
            .expect_err("changed source must never be overwritten");
        assert!(error.to_string().contains("changed externally"));
        assert_eq!(
            fs::read(&manifest_path).expect("preserved source"),
            external_bytes
        );
        runtime
            .close()
            .expect("runtime must close without publishing");
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn atomic_manifest_write_never_leaves_temporary_file() {
        let root = temp_test_dir("project-atomic");
        fs::create_dir_all(&root).expect("root must exist");
        let path = root.join("manifest.json");
        atomic_write_json(&path, &serde_json::json!({"value": 1})).expect("first write must work");
        atomic_write_json(&path, &serde_json::json!({"value": 2})).expect("replacement must work");
        let mut text = String::new();
        File::open(&path)
            .expect("manifest must exist")
            .read_to_string(&mut text)
            .expect("manifest must be readable");
        assert!(text.contains('2'));
        assert_eq!(fs::read_dir(&root).expect("root readable").count(), 1);
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn hcadx_save_as_and_open_round_trip_uses_a_local_workspace() {
        let root = temp_test_dir("project-archive-roundtrip");
        fs::create_dir_all(&root).expect("test root must exist");
        let local = root.join("local.hcad");
        let archive = root.join("survey.hcadx");
        let creator = ProjectRuntime::default();
        let created = creator
            .create(CreateProjectParams {
                path: path_string(&local),
                name: "Archive survey".to_owned(),
            })
            .expect("local workspace must be created");
        creator
            .append_journal(AppendJournalParams {
                command_kind: "ImportImages".to_owned(),
                payload: serde_json::json!({"count": 3}),
                affected_entities: Vec::new(),
                before_refs: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("journal entry must be written");
        let saved = creator
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: false,
                include_rebuildable_index: false,
                archive_operation_id: Some("roundtrip-save".to_owned()),
                progress_key: None,
            })
            .expect("archive must be written");
        assert_eq!(saved.source_path, path_string(&archive));
        assert!(archive.is_file());
        assert!(project_lock_path(&archive).is_file());
        assert!(!local.join(".project.lock").exists());
        creator.close().expect("archive session must close");
        assert!(!project_lock_path(&archive).exists());

        let reopened_runtime = ProjectRuntime::default();
        let opened = reopened_runtime
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&root.join("cache")),
                use_local_working_copy: true,
                recover_existing_working_copy: true,
                archive_operation_id: Some("roundtrip-open".to_owned()),
                progress_key: None,
            })
            .expect("archive must open");
        assert_eq!(opened.manifest.project_id, created.manifest.project_id);
        assert!(opened.session.uses_local_working_copy);
        assert_ne!(opened.session.source_path, opened.session.working_path);
        assert!(Path::new(&opened.session.working_path)
            .join("journal/0000000000000001.json")
            .is_file());
        reopened_runtime.close().expect("opened archive must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn hcadx_overwrite_keeps_one_valid_archive() {
        let root = temp_test_dir("project-archive-overwrite");
        fs::create_dir_all(&root).expect("test root must exist");
        let archive = root.join("survey.hcadx");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("workspace.hcad")),
                name: "Overwrite survey".to_owned(),
            })
            .expect("workspace must be created");
        runtime
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: false,
                include_rebuildable_index: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("first archive must be written");
        runtime
            .append_journal(AppendJournalParams {
                command_kind: "OptimizeAlignment".to_owned(),
                payload: serde_json::Value::Null,
                affected_entities: Vec::new(),
                before_refs: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("project must become dirty");
        runtime
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: true,
                include_rebuildable_index: false,
                archive_operation_id: Some("overwrite-save".to_owned()),
                progress_key: None,
            })
            .expect("existing archive must be safely replaced");
        runtime.close().expect("runtime must close");

        let reopened = ProjectRuntime::default();
        let result = reopened
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&root.join("reopen-cache")),
                use_local_working_copy: true,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("replacement archive must remain valid");
        assert_eq!(result.manifest.command_sequence, 1);
        reopened.close().expect("reopened project must close");
        let archive_artifacts = fs::read_dir(&root)
            .expect("test root readable")
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".backup-"))
            .count();
        assert_eq!(archive_artifacts, 0);
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn cancelled_archive_save_preserves_existing_destination_and_live_manifest() {
        let root = temp_test_dir("project-archive-cancel-preserve");
        fs::create_dir_all(&root).expect("test root must exist");
        let archive = root.join("survey.hcadx");
        let runtime = ProjectRuntime::default();
        runtime
            .create(CreateProjectParams {
                path: path_string(&root.join("workspace.hcad")),
                name: "Cancellation survey".to_owned(),
            })
            .expect("workspace must be created");
        runtime
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: false,
                include_rebuildable_index: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("initial archive must be written");
        runtime
            .append_journal(AppendJournalParams {
                command_kind: "EditAfterSave".to_owned(),
                payload: serde_json::Value::Null,
                affected_entities: Vec::new(),
                before_refs: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("project must become dirty");
        let archive_before = fs::read(&archive).expect("existing archive must be readable");
        let manifest_before = runtime
            .snapshot()
            .expect("snapshot before cancellation")
            .manifest;
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let error = {
            let mut guard = runtime.session.lock().expect("session mutex");
            let session = guard.as_mut().expect("open session");
            save_archive_session(
                session,
                &archive,
                true,
                false,
                Some(("cancel-preserve", &cancellation)),
                None,
            )
            .expect_err("pre-cancelled archive must not publish")
        };
        assert!(error.to_string().to_lowercase().contains("cancel"));
        assert_eq!(
            fs::read(&archive).expect("archive after cancellation"),
            archive_before
        );
        assert_eq!(
            runtime
                .snapshot()
                .expect("snapshot after cancellation")
                .manifest,
            manifest_before
        );
        runtime.close().expect("runtime must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn archive_save_refuses_to_replace_an_externally_changed_archive() {
        let root = temp_test_dir("project-external-archive-change");
        fs::create_dir_all(&root).expect("test root");
        let archive = root.join("source.hcadx");
        let creator = ProjectRuntime::default();
        creator
            .create(CreateProjectParams {
                path: path_string(&root.join("creator.hcad")),
                name: "Archive source".to_owned(),
            })
            .expect("creator project");
        creator
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: false,
                include_rebuildable_index: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("initial archive");
        creator.close().expect("creator close");

        let runtime = ProjectRuntime::default();
        runtime
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&root.join("cache")),
                use_local_working_copy: true,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("archive open");
        let mut external_bytes = fs::read(&archive).expect("archive bytes");
        external_bytes.extend_from_slice(b"external-revision");
        fs::write(&archive, &external_bytes).expect("external archive edit");

        let error = runtime
            .save()
            .expect_err("changed archive must never be replaced");
        assert!(error.to_string().contains("changed externally"));
        assert_eq!(
            fs::read(&archive).expect("preserved archive"),
            external_bytes
        );
        runtime.close().expect("runtime close");
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn archive_cancellation_token_is_addressable_while_operation_is_active() {
        let runtime = ProjectRuntime::default();
        let (operation_id, token) = runtime
            .begin_archive_operation(Some("cancel-test"))
            .expect("operation must start");
        let result = runtime
            .cancel_archive(CancelArchiveParams {
                archive_operation_id: operation_id.clone(),
            })
            .expect("cancel request must be accepted");
        assert!(result.cancellation_requested);
        assert!(token.is_cancel_requested());
        runtime.finish_archive_operation(&operation_id);
    }

    #[test]
    fn locked_archive_is_rejected_before_shared_workspace_is_touched() {
        let root = temp_test_dir("project-archive-lock");
        fs::create_dir_all(&root).expect("test root must exist");
        let archive = root.join("locked.hcadx");
        let creator = ProjectRuntime::default();
        creator
            .create(CreateProjectParams {
                path: path_string(&root.join("source.hcad")),
                name: "Locked archive".to_owned(),
            })
            .expect("source must be created");
        creator
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: false,
                include_rebuildable_index: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("archive must be created");
        creator.close().expect("creator must close");

        let cache = root.join("shared-cache");
        let owner = ProjectRuntime::default();
        let opened = owner
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&cache),
                use_local_working_copy: true,
                recover_existing_working_copy: true,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("owner must open archive");
        let marker = Path::new(&opened.session.working_path).join("tmp/owner-marker");
        fs::write(&marker, b"owned workspace").expect("owner marker must be written");

        let contender = ProjectRuntime::default();
        let error = contender
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&cache),
                use_local_working_copy: true,
                recover_existing_working_copy: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect_err("second process must fail on the archive lock");
        assert!(error.to_string().contains("locked"));
        assert_eq!(
            fs::read(&marker).expect("owner workspace must stay untouched"),
            b"owned workspace"
        );
        owner.close().expect("owner must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn recovered_archive_workspace_stays_dirty_against_archived_generation() {
        let root = temp_test_dir("project-archive-recovery");
        fs::create_dir_all(&root).expect("test root must exist");
        let archive = root.join("recover.hcadx");
        let creator = ProjectRuntime::default();
        creator
            .create(CreateProjectParams {
                path: path_string(&root.join("source.hcad")),
                name: "Recovery archive".to_owned(),
            })
            .expect("source must be created");
        creator
            .save_as(&SaveProjectAsParams {
                path: path_string(&archive),
                overwrite: false,
                include_rebuildable_index: false,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("archive must be created");
        creator.close().expect("creator must close");

        let cache = root.join("cache");
        let editing = ProjectRuntime::default();
        editing
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&cache),
                use_local_working_copy: true,
                recover_existing_working_copy: true,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("archive must open for editing");
        editing
            .append_journal(AppendJournalParams {
                command_kind: "EditGcp".to_owned(),
                payload: serde_json::Value::Null,
                affected_entities: Vec::new(),
                before_refs: Vec::new(),
                after_refs: Vec::new(),
                message: None,
            })
            .expect("edit must autosave");
        editing.close().expect("edited workspace must close");

        let recovery = ProjectRuntime::default();
        let recovered = recovery
            .open(&OpenProjectParams {
                path: path_string(&archive),
                working_root: path_string(&cache),
                use_local_working_copy: true,
                recover_existing_working_copy: true,
                archive_operation_id: None,
                progress_key: None,
            })
            .expect("newer workspace must recover");
        assert!(recovered.session.recovery_available);
        assert_eq!(recovered.session.autosave_generation, 1);
        assert_eq!(recovered.session.last_saved_generation, 0);
        recovery.close().expect("recovered project must close");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn archive_progress_is_monotonic_across_phase_boundaries() {
        let packing = [
            archive_overall_fraction(ArchivePhase::Scanning, 1.0),
            archive_overall_fraction(ArchivePhase::Packing, 0.0),
            archive_overall_fraction(ArchivePhase::Packing, 0.4),
            archive_overall_fraction(ArchivePhase::Packing, 1.0),
            archive_overall_fraction(ArchivePhase::Committing, 1.0),
        ];
        let opening = [
            archive_overall_fraction(ArchivePhase::Validating, 1.0),
            archive_overall_fraction(ArchivePhase::Extracting, 0.0),
            archive_overall_fraction(ArchivePhase::Extracting, 0.4),
            archive_overall_fraction(ArchivePhase::Extracting, 1.0),
            archive_overall_fraction(ArchivePhase::Committing, 1.0),
        ];
        for values in [packing, opening] {
            assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
            assert_eq!(values.last().copied(), Some(1.0));
        }
    }
}
