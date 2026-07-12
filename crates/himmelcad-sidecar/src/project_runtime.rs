//! Desktop project storage with local working copies, atomic manifests, and journals.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use fs2::FileExt;
use himmelcad_core::entity::{EntityId, EntityKind, EntitySnapshot, VisibilityState};
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_core::photolab_products::ImageProductTag;
use himmelcad_core::photolab_project::{
    initial_photolab_manifest, JournalCommandState, OpenPhotolabProjectResult,
    PhotolabJournalEntry, PhotolabProjectManifest, ProjectSessionSummary,
    PHOTOLAB_PROJECT_FORMAT_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use himmelcad_sidecar::brush_runtime::{BrushOutputSummary, BrushRunOutcome};
use himmelcad_sidecar::colmap_runtime::{
    ColmapArtifactKind, ColmapArtifactSummary, ColmapRunOutcome, SelectedMapper,
};
use himmelcad_sidecar::dense_raster_prep::PreparedPotreeCloud;
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
    commit_images_transaction, read_project_camera_images, CameraImageMetadataRecord,
    CancelImageCommitParams, CancelImageCommitResult, CommitImagesParams, CommitImagesResult,
    ProjectCameraImageRecord,
};
use himmelcad_sidecar::mesh_tiler::PreparedMeshProduct;
use himmelcad_sidecar::mvs_runtime::{MvsCommandReport, MvsOutputIndex, MvsRunOutcome};
use himmelcad_sidecar::product_export::{ProductExportSource, ProductExportSourceKind};
use himmelcad_sidecar::project_archive::{
    pack_hcadx, unpack_hcadx, ArchiveProgress, PackArchiveOptions, UnpackArchiveLimits,
};
use himmelcad_sidecar::raster_runtime::RasterBuildSummary;
use himmelcad_sidecar::splat_tiler::PreparedSplatProduct;

static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(1);
const PROJECT_LEASE_SCHEMA_VERSION: u32 = 1;
const SOURCE_HASH_BUFFER_BYTES: usize = 1024 * 1024;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductLineage {
    pub source_alignment_entity_id: EntityId,
    pub processing_set_id: Option<EntityId>,
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
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
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
    pub source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
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
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_offset: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_count: Option<u64>,
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
}

/// Exactly one project is authoritative in a sidecar process.
#[derive(Debug, Default)]
pub struct ProjectRuntime {
    session: Mutex<Option<ProjectSession>>,
    active_archives: Mutex<HashMap<String, CancellationToken>>,
    active_image_commits: Mutex<HashMap<String, CancellationToken>>,
    active_gcp_operations: Mutex<HashMap<String, CancellationToken>>,
}

impl ProjectRuntime {
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
        let (operation_id, cancellation) =
            match self.begin_archive_operation(params.archive_operation_id.as_deref()) {
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
        self.finish_archive_operation(&operation_id);
        if result.is_err() {
            release_lock(&lock_file, &lock_path, &session_id)?;
        }
        result
    }

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
            write_lease_record(&lock_file, &lease)?;
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
        let images =
            unique_entity_of_kind(&session.manifest, EntityKind::ImageCollection, "images")?;
        let now = unix_ms()?;
        let entity_id = EntityId(format!(
            "{}:processing-set:{}",
            session.manifest.project_id,
            unique_id("scope", now)
        ));
        let membership_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&camera_ids)?);
        let record = ProcessingSetRecord {
            schema_version: 1,
            entity_id: entity_id.clone(),
            name: name.to_owned(),
            camera_entity_ids: camera_ids,
            membership_sha256,
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
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut entities = session
            .manifest
            .entities
            .values()
            .filter(|entity| {
                entity.kind == EntityKind::AlignmentRun && entity.id.0.contains(":alignment-gcp:")
            })
            .collect::<Vec<_>>();
        entities.sort_by(|left, right| right.id.0.cmp(&left.id.0));
        for entity in entities {
            let path = project_object_path(&session.working_path, &entity.version_hash);
            let bytes = fs::read(path)?;
            anyhow::ensure!(
                ObjectHash::of_bytes(&bytes) == entity.version_hash,
                "GCP optimization record hash mismatch"
            );
            if let Ok(record) = serde_json::from_slice(&bytes) {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    pub fn latest_gcp_optimization_for_lineage(
        &self,
        lineage: &ProductLineage,
    ) -> Result<Option<GcpOptimizationPublicationRecord>> {
        let guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_ref().context("no project is open")?;
        let mut entities = session
            .manifest
            .entities
            .values()
            .filter(|entity| {
                entity.kind == EntityKind::AlignmentRun && entity.id.0.contains(":alignment-gcp:")
            })
            .collect::<Vec<_>>();
        entities.sort_by(|left, right| right.id.0.cmp(&left.id.0));
        for entity in entities {
            let path = project_object_path(&session.working_path, &entity.version_hash);
            let bytes = fs::read(path)?;
            anyhow::ensure!(
                ObjectHash::of_bytes(&bytes) == entity.version_hash,
                "GCP optimization record hash mismatch"
            );
            let Ok(record) = serde_json::from_slice::<GcpOptimizationPublicationRecord>(&bytes)
            else {
                continue;
            };
            if record_matches_lineage(
                record.source_alignment_entity_id.as_ref(),
                record.processing_set_id.as_ref(),
                lineage,
            ) {
                return Ok(Some(record));
            }
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
            if !record_matches_lineage(
                record.source_alignment_entity_id.as_ref(),
                record.processing_set_id.as_ref(),
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
            if !record_matches_lineage(
                record.source_alignment_entity_id.as_ref(),
                record.processing_set_id.as_ref(),
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
                let record: MeshArtifactRecord = serde_json::from_slice(&bytes)?;
                let relative = dataset_protocol_relative(&record.dataset_relative_path)?
                    .join(&record.prepared.manifest_relative_path);
                records.push(ProjectProductDatasetRecord {
                    entity_id: entity.id.clone(),
                    kind: "mesh".into(),
                    relative_path: path_string(&relative),
                    format: "tiledMesh".into(),
                    visible: entity.visibility.visible,
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
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
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
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
                        bounds_min: record.potree.as_ref().map(|potree| potree.bounds_min),
                        bounds_max: record.potree.as_ref().map(|potree| potree.bounds_max),
                        render_offset: record.potree.as_ref().map(|potree| potree.render_offset),
                        point_count: record.potree.as_ref().map(|potree| potree.point_count),
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
                        bounds_min: Some(potree.bounds_min),
                        bounds_max: Some(potree.bounds_max),
                        render_offset: Some(potree.render_offset),
                        point_count: Some(potree.point_count),
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
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
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
                    bounds_min: None,
                    bounds_max: None,
                    render_offset: None,
                    point_count: None,
                });
            }
        }
        records.sort_by(|left, right| left.entity_id.0.cmp(&right.entity_id.0));
        Ok(records)
    }

    pub fn product_export_source(&self, entity_id: &EntityId) -> Result<ProductExportSource> {
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
                        ProductExportSourceKind::File,
                        format!("{stem}.ply"),
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
                        ProductExportSourceKind::File,
                        format!("{stem}.ply"),
                    )
                }
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
                let record: MeshArtifactRecord = serde_json::from_slice(&bytes)?;
                (
                    session.working_path.join(record.dataset_relative_path),
                    ProductExportSourceKind::Directory,
                    format!("{stem}-mesh"),
                )
            }
            _ => anyhow::bail!("entity is not an exportable PhotoLab product"),
        };
        let path = path.canonicalize()?;
        anyhow::ensure!(
            path.starts_with(&dataset_root),
            "product export source escaped the project datasets root"
        );
        Ok(ProductExportSource {
            source_path: path,
            kind,
            suggested_name,
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

    pub fn publish_colmap_outcome(&self, outcome: ColmapRunOutcome) -> Result<PublishColmapResult> {
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
            |index: usize| EntityId(format!("{}:compute:{}:{index}", project_id, job_id));
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
                schema_version: 1,
                job_id: outcome.summary.job_id.clone(),
                dataset_relative_path: dataset_relative_path.clone(),
                artifact: artifact.clone(),
                camera_entity_ids: camera_scope.clone(),
                publication_sequence: session.manifest.command_sequence.saturating_add(1),
                selected_mapper: outcome.summary.selected_mapper,
                tool_manifest_sha256: outcome.summary.tool_manifest_sha256.clone(),
                parent_alignment_entity_id: (artifact.kind == ColmapArtifactKind::SparsePointCloud)
                    .then_some(alignment_entity_id.clone()),
                potree: (artifact.kind == ColmapArtifactKind::SparsePointCloud)
                    .then(|| outcome.sparse_potree.clone())
                    .flatten(),
            };
            let bytes = serde_json::to_vec(&record)?;
            let version_hash = put_project_object(&session.working_path, &bytes)?;
            let entity_id = entity_id_for(index);
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
            }),
            affected_entities,
            before_refs: Vec::new(),
            after_refs,
            message: Some("COLMAP artifacts validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
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
            schema_version: 2,
            job_id: outcome.summary.job_id.clone(),
            dataset_relative_path: dataset_relative_path.clone(),
            summary_sha256: outcome.summary_sha256.clone(),
            summary: outcome.summary.clone(),
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
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
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("Brush output validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
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
        lineage: &ProductLineage,
    ) -> Result<PublishColmapResult> {
        validate_compute_job_id(&outcome.output.job_id)?;
        let mut guard = self.session.lock().expect("project session mutex poisoned");
        let session = guard.as_mut().context("no project is open")?;
        ensure_writable(session)?;
        let camera_scope = validate_camera_scope(&session.manifest, camera_entity_ids)?;
        validate_product_lineage(session, lineage, Some(&camera_scope))?;
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
            schema_version: 2,
            job_id: outcome.output.job_id.clone(),
            dataset_relative_path: dataset_relative_path.clone(),
            output_index_sha256: outcome.output_index_sha256,
            output: outcome.output.clone(),
            command: outcome.command,
            camera_entity_ids: camera_scope,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
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
            }),
            affected_entities,
            before_refs: Vec::new(),
            after_refs,
            message: Some("Portable MVS output validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
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
            schema_version: 2,
            operation_id: outcome.operation_id.clone(),
            input_sha256: outcome.input_sha256,
            artifact_sha256: outcome.artifact_sha256,
            snapshot_sha256: outcome.artifact.snapshot_sha256.clone(),
            artifact: outcome.artifact,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
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
            schema_version: 2,
            job_id: job_id.to_owned(),
            kind,
            dataset_relative_path: dataset_relative_path.clone(),
            summary,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
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
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("GDAL raster validated and atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
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
        fs::rename(staging_path, &destination)?;
        let record = MeshArtifactRecord {
            schema_version: 2,
            job_id: job_id.into(),
            dataset_relative_path: relative,
            textured,
            prepared,
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
        };
        let version_hash =
            put_project_object(&session.working_path, &serde_json::to_vec(&record)?)?;
        let mut candidate = session.manifest.clone();
        let entity_id = EntityId(format!("{}:mesh:{job_id}", candidate.project_id));
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
                    if textured {
                        "Texturiertes Mesh"
                    } else {
                        "Mesh"
                    }
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
            }),
            affected_entities: vec![entity_id.clone()],
            before_refs: Vec::new(),
            after_refs: vec![version_hash, group_hash],
            message: Some("Tiled mesh atomically published".into()),
        };
        write_journal_entry(&session.working_path, &journal)?;
        atomic_write_json(&session.working_path.join("manifest.json"), &candidate)?;
        session.manifest = candidate;
        Ok(PublishColmapResult {
            job_id: job_id.into(),
            entity_ids: vec![entity_id],
            autosave_generation: session.manifest.autosave_generation,
        })
    }

    pub fn commit_images(&self, params: CommitImagesParams) -> Result<CommitImagesResult> {
        let operation_id = params.operation_id.clone();
        let cancellation = CancellationToken::new();
        {
            let mut active = self
                .active_image_commits
                .lock()
                .expect("image commit mutex poisoned");
            if active.contains_key(&operation_id) {
                anyhow::bail!("image commit operation id is already active: {operation_id}");
            }
            active.insert(operation_id.clone(), cancellation.clone());
        }
        let result = (|| {
            let mut guard = self.session.lock().expect("project session mutex poisoned");
            let session = guard.as_mut().context("no project is open")?;
            ensure_writable(session)?;
            commit_images_transaction(
                &session.working_path,
                &mut session.manifest,
                params,
                &cancellation,
            )
            .map_err(anyhow::Error::from)
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
        write_lease_record(&new_lock_file, &new_lease)?;
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

    pub fn close(&self) -> Result<()> {
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
    write_lease_record(&session.lock_file, &session.lease)
}

fn ensure_source_unchanged(session: &ProjectSession) -> Result<()> {
    let observed = source_fingerprint(&session.source_path)?;
    if observed == session.lease.source_fingerprint {
        return Ok(());
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
        ColmapArtifactKind::TexturedMesh => Some((EntityKind::TexturedMesh, "Texturiertes Mesh")),
        ColmapArtifactKind::AlikedVerifiedDatabase
        | ColmapArtifactKind::SiftVerifiedDatabase
        | ColmapArtifactKind::DedodeVerifiedDatabase => None,
    }
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
        candidates.push((
            record.publication_sequence,
            entity.id.0.clone(),
            dataset,
            camera_entity_ids,
            entity.id.clone(),
        ));
    }
    let (_, _, root, camera_entity_ids, source_alignment_entity_id) = candidates
        .into_iter()
        .max_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)))
        .context("no completed sparse alignment is available for the requested camera scope")?;
    Ok(PublishedAlignmentDataset {
        root,
        camera_entity_ids,
        source_alignment_entity_id,
        processing_set_id,
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
        entity.kind == EntityKind::AlignmentRun,
        "source alignment lineage references a non-alignment entity"
    );
    let bytes = fs::read(project_object_path(
        &session.working_path,
        &entity.version_hash,
    ))?;
    anyhow::ensure!(
        ObjectHash::of_bytes(&bytes) == entity.version_hash,
        "source alignment record hash mismatch"
    );
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
    let alignment_scope = alignment_camera_scope(&record, &dataset, &session.manifest)?;
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
    serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid project manifest {}", manifest_path.display()))
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
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .with_context(|| format!("project lock cannot be opened: {}", path.display()))?;
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
    write_lease_record(&lock, &lease)?;
    Ok((Arc::new(lock), lease))
}

fn write_lease_record(lock: &File, lease: &ProjectLeaseRecord) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(lease)?;
    bytes.push(b'\n');
    lock.set_len(0)?;
    let mut writer = lock;
    writer.seek(SeekFrom::Start(0))?;
    writer.write_all(&bytes)?;
    lock.sync_data()?;
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
    File::open(parent)?.sync_all()?;
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
            Ok(()) => Err(error).with_context(|| {
                format!("failed to replace archive {}", destination.display())
            }),
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
    let fraction = if progress.bytes_total == 0 {
        if progress.files_total == 0 {
            1.0
        } else {
            progress.files_completed as f64 / progress.files_total as f64
        }
    } else {
        progress.bytes_completed as f64 / progress.bytes_total as f64
    };
    let payload = serde_json::json!({
        "progressKey": progress_key,
        "operationId": operation_id,
        "fraction": fraction.clamp(0.0, 1.0),
        "message": format!("Projektarchiv: {:?}", progress.phase),
        "archive": progress,
    });
    eprintln!("__HC_PROGRESS__{payload}");
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

const fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::photolab_images::{DiscoveredPhoto, PhotoFormat, PhotoMetadata};
    use himmelcad_sidecar::colmap_runtime::{ColmapOutputSummary, SelectedFeatureStore};
    use himmelcad_sidecar::mvs_runtime::{MvsCommandReport, MvsComputeDevice, MvsDenseCloudRecord};

    fn temp_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(unique_id(name, unix_ms().expect("clock must work")))
    }

    fn insert_test_camera(
        session: &mut ProjectSession,
        images: &EntityId,
        suffix: &str,
        status_tags: impl IntoIterator<Item = ImageProductTag>,
    ) -> EntityId {
        let entity_id = EntityId(format!("{}:camera:{suffix}", session.manifest.project_id));
        let source_object_hash = ObjectHash::of_bytes(format!("source-{suffix}").as_bytes());
        let metadata = CameraImageMetadataRecord {
            schema_version: 1,
            source_object_hash,
            transformation_object_hash: ObjectHash::of_bytes(b"test-transform"),
            inspected_photo: DiscoveredPhoto {
                source_path: format!("/{suffix}.jpg"),
                format: PhotoFormat::Jpeg,
                byte_size: 1,
                sha256: ObjectHash::of_bytes(format!("source-{suffix}").as_bytes()),
                metadata: PhotoMetadata::default(),
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
                }),
            },
            command: MvsCommandReport {
                argv: Vec::new(),
                exit_code: Some(0),
                duration_ms: 1,
                log_tail: Vec::new(),
            },
            camera_entity_ids: Vec::new(),
            source_alignment_entity_id: Some(lineage.source_alignment_entity_id.clone()),
            processing_set_id: lineage.processing_set_id.clone(),
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
        };
        let incompatible = ProductLineage {
            source_alignment_entity_id: EntityId("alignment-b".into()),
            processing_set_id: Some(EntityId("set-b".into())),
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
            scratch.join("sparse-view-source/points3D.txt"),
            b"1 1000 2000 3000 10 20 30 0.25\n",
        )
        .expect("points3D");
        fs::create_dir_all(scratch.join("sparse-potree/octree")).expect("Potree output");
        fs::write(scratch.join("sparse-potree/octree/metadata.json"), b"{}").expect("metadata");
        fs::write(scratch.join("sparse-potree/export.ply"), b"ply\n").expect("portable PLY");
        let summary = ColmapOutputSummary {
            schema_version: 1,
            job_id: "alignment-sparse-test".into(),
            tool_manifest_sha256: ObjectHash::of_bytes(b"tools"),
            executable_sha256: ObjectHash::of_bytes(b"colmap"),
            colmap_version: "test".into(),
            camera_entity_ids: vec![camera_id.0],
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
            .publish_colmap_outcome(ColmapRunOutcome {
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
            })
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

        let datasets = runtime.list_product_datasets().expect("product datasets");
        let sparse = datasets
            .iter()
            .find(|dataset| dataset.entity_id == *sparse_id)
            .expect("sparse product dataset");
        assert_eq!(sparse.kind, "sparse");
        assert_eq!(sparse.format, "potreeV2");
        assert_eq!(sparse.point_count, Some(1));
        assert!(sparse
            .relative_path
            .ends_with("sparse-potree/octree/metadata.json"));

        let export = runtime
            .product_export_source(sparse_id)
            .expect("sparse product export");
        assert_eq!(export.kind, ProductExportSourceKind::File);
        assert!(export.source_path.ends_with("sparse-potree/export.ply"));
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
            .find(|entity| entity.name == "Referenz & GCPs")
            .expect("reference group")
            .id
            .clone();
        let products = opened
            .manifest
            .entities
            .values()
            .find(|entity| entity.name == "Produkte")
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
}
