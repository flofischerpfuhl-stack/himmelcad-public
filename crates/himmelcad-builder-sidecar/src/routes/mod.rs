//! Builder-only route composition for the shared sidecar host.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::mesh_surface_runtime::{
    bake_surface_edit, check_persisted_surface, create_surface_draft, fix_persisted_surface,
    preview_surface_downsample, preview_surface_smoothing, publish_persisted_surface,
    select_surface_edit_region, CreateSurfaceDraftRequest, SurfaceEditBakeRequest,
    SurfaceEditRegionRequest,
};
use anyhow::{Context, Result};
use himmelcad_command::RpcModule;
use himmelcad_document::canonical_document::EntityVersionRef;
use himmelcad_document::project_archive::{
    pack_hcadx_replace_with_cancel, unpack_hcadx_with_cancel, ArchivePhase, ArchiveProgress,
    PackArchiveOptions, UnpackArchiveLimits,
};
use himmelcad_domain_surface::mesh_surface::{
    SurfaceDownsampleParameters, SurfaceFixKind, SurfaceFixRequest, SurfaceSmoothParameters,
};
use himmelcad_io::{
    import_las_file_with_progress_and_cancel, CanonicalImportProvider, CanonicalImportRequest,
    CanonicalStagedImport, ConverterProgress, IfcCanonicalProvider, ProviderOperationContext,
    ProviderProgress, StagedArtifactRoots, IFC2X3_FORMAT_ID, IFC4X3_FORMAT_ID, IFC4_FORMAT_ID,
};
use himmelcad_process::jobs::CancellationToken;
use himmelcad_sidecar::canonical_app_runtime::{CanonicalAppRuntime, CanonicalGroundSource};
use himmelcad_sidecar::canonical_project_store::{
    CanonicalImportProgress, CanonicalImportProgressPhase,
};
use himmelcad_sidecar::ground_classification::SmrfParams;
use himmelcad_sidecar::host::{emit_progress, HostComposition, ProductLifecycle};
use himmelcad_sidecar::pointcloud_ground::{
    prepare_ground_datasets, preview_ground, GroundPhase, GroundPrepareRequest, GroundProgress,
    GroundScope, GroundViewingBox, PreparedGroundResult, GROUND_ALGORITHM_ID,
};
use himmelcad_sidecar::pointcloud_sampling::{
    prepare_height_grid, prepare_sampled_cloud, PreparedHeightGrid, PreparedSampleResult,
    RasterAggregation, RasterizeParameters, RasterizePhase, RasterizePrepareRequest,
    RasterizeProgress, SamplePrepareRequest, SamplingParameters, SamplingPhase, SamplingProgress,
    RASTERIZE_ALGORITHM_ID, SAMPLE_ALGORITHM_ID,
};
use himmelcad_sidecar::pointcloud_segment::{
    prepare_segment_dataset, FenceVolume, PreparedSegmentResult, SegmentPhase,
    SegmentPrepareRequest, SegmentProgress, SegmentSide, SEGMENT_ALGORITHM_ID,
};
use himmelcad_sidecar::routes::{
    definitions, register_shared_routes, rpc_blocking, rpc_blocking_with_params, rpc_err,
    rpc_result, shared_route_definitions, IoOperations, RpcRequest, RpcResponse,
    SharedRouteServices, SidecarCommandRegistry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod builder_archive;
mod canonical_app;
mod mesh_surface;
mod pointcloud_ground;
mod pointcloud_processing;
mod pointcloud_segment;
mod root;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderArchivePackParams {
    project_root: PathBuf,
    destination: PathBuf,
    operation_id: String,
    progress_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderArchiveUnpackParams {
    source: PathBuf,
    destination: PathBuf,
    operation_id: String,
    progress_key: String,
}

#[derive(Debug, Deserialize)]
struct ImportLasParams {
    paths: Vec<String>,
    #[serde(default)]
    cache_dir: Option<String>,
    #[serde(default)]
    progress_key: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CancelLasImportParams {
    operation_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundParameters {
    cell_size_m: f64,
    slope: f64,
    max_window_m: f64,
    initial_distance_m: f64,
}

impl From<GroundParameters> for SmrfParams {
    fn from(value: GroundParameters) -> Self {
        Self {
            cell_size_m: value.cell_size_m,
            slope: value.slope,
            max_window_m: value.max_window_m,
            initial_distance_m: value.initial_distance_m,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundScopeParams {
    #[serde(default)]
    viewing_box: Option<GroundViewingBox>,
    visible_classes: BTreeSet<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundExtractionParams {
    operation_id: String,
    progress_key: String,
    command_id: String,
    algorithm_id: String,
    source: EntityVersionRef,
    ground_entity_id: String,
    output_name: String,
    parameters: GroundParameters,
    scope: GroundScopeParams,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundPreviewParams {
    operation_id: String,
    progress_key: String,
    algorithm_id: String,
    source: EntityVersionRef,
    parameters: GroundParameters,
    scope: GroundScopeParams,
    #[serde(default = "default_ground_preview_limit")]
    sample_limit: usize,
}

fn default_ground_preview_limit() -> usize {
    20_000
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelGroundOperationParams {
    operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceDraftCreateParams {
    operation_id: String,
    progress_key: String,
    #[serde(flatten)]
    request: CreateSurfaceDraftRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceDraftParams {
    draft_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceFixParams {
    draft_id: String,
    error_id: String,
    fix: SurfaceFixKind,
    #[serde(default)]
    authority_source_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfacePublishParams {
    operation_id: String,
    progress_key: String,
    draft_id: String,
    output_entity_id: String,
    command_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceEditRegionParams {
    #[serde(flatten)]
    request: SurfaceEditRegionRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceSmoothPreviewParams {
    operation_id: String,
    progress_key: String,
    edit_id: String,
    parameters: SurfaceSmoothParameters,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceDownsamplePreviewParams {
    operation_id: String,
    progress_key: String,
    edit_id: String,
    parameters: SurfaceDownsampleParameters,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SegmentSourceParams {
    source: EntityVersionRef,
    scope: GroundScopeParams,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SegmentParams {
    operation_id: String,
    progress_key: String,
    command_id: String,
    algorithm_id: String,
    sources: Vec<SegmentSourceParams>,
    volume: FenceVolume,
    side: SegmentSide,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PointcloudSampleParams {
    operation_id: String,
    progress_key: String,
    command_id: String,
    algorithm_id: String,
    source: EntityVersionRef,
    output_entity_id: String,
    output_name: String,
    parameters: SamplingParameters,
    scope: GroundScopeParams,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PointcloudRasterizeParams {
    operation_id: String,
    progress_key: String,
    command_id: String,
    algorithm_id: String,
    source: EntityVersionRef,
    output_entity_id: String,
    output_name: String,
    parameters: RasterizeParameters,
    scope: GroundScopeParams,
}

#[derive(Debug, Deserialize)]
struct ImportIfcParams {
    path: String,
    #[serde(default)]
    cache_dir: Option<String>,
    #[serde(default = "default_ifc_namespace")]
    import_namespace: String,
}

fn default_ifc_namespace() -> String {
    "builder".to_owned()
}

#[derive(Default)]
struct LasImportOperations {
    active: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
}

impl LasImportOperations {
    fn begin(self: &Arc<Self>, operation_id: String) -> anyhow::Result<ActiveLasImport> {
        anyhow::ensure!(!operation_id.trim().is_empty(), "operation_id is empty");
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut active = self.active.lock().expect("LAS import mutex poisoned");
        match active.entry(operation_id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(cancellation.clone());
            }
            std::collections::btree_map::Entry::Occupied(_) => {
                anyhow::bail!("LAS import operation is already active: {operation_id}");
            }
        }
        Ok(ActiveLasImport {
            operation_id,
            cancellation,
            operations: Arc::clone(self),
        })
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let active = self.active.lock().expect("LAS import mutex poisoned");
        let Some(cancellation) = active.get(operation_id) else {
            return false;
        };
        cancellation.store(true, Ordering::Release);
        true
    }
}

struct ActiveLasImport {
    operation_id: String,
    cancellation: Arc<AtomicBool>,
    operations: Arc<LasImportOperations>,
}

impl Drop for ActiveLasImport {
    fn drop(&mut self) {
        self.operations
            .active
            .lock()
            .expect("LAS import mutex poisoned")
            .remove(&self.operation_id);
    }
}

#[derive(Default)]
struct GroundOperations {
    active: Mutex<BTreeMap<String, CancellationToken>>,
}

impl GroundOperations {
    fn begin(self: &Arc<Self>, operation_id: String) -> anyhow::Result<ActiveGroundOperation> {
        validate_operation_id(&operation_id)?;
        let cancellation = CancellationToken::new();
        let mut active = self.active.lock().expect("ground operation mutex poisoned");
        anyhow::ensure!(
            !active.contains_key(&operation_id),
            "ground operation is already active: {operation_id}"
        );
        active.insert(operation_id.clone(), cancellation.clone());
        Ok(ActiveGroundOperation {
            operation_id,
            cancellation,
            operations: Arc::clone(self),
        })
    }

    fn cancel(&self, operation_id: &str) -> bool {
        self.active
            .lock()
            .expect("ground operation mutex poisoned")
            .get(operation_id)
            .is_some_and(CancellationToken::request_cancel)
    }
}

struct ActiveGroundOperation {
    operation_id: String,
    cancellation: CancellationToken,
    operations: Arc<GroundOperations>,
}

impl Drop for ActiveGroundOperation {
    fn drop(&mut self) {
        self.operations
            .active
            .lock()
            .expect("ground operation mutex poisoned")
            .remove(&self.operation_id);
    }
}

fn validate_operation_id(value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "operation_id must use 1–128 ASCII letters, digits, '-' or '_'"
    );
    Ok(())
}

fn segment_progress_bucket(progress: SegmentProgress) -> (SegmentPhase, u64) {
    let bucket = if progress.total == 0 {
        100
    } else {
        progress.completed.saturating_mul(100) / progress.total
    };
    (progress.phase, bucket.min(100))
}

#[allow(clippy::cast_precision_loss)]
fn emit_segment_progress(
    progress_key: &str,
    progress: SegmentProgress,
    source_index: usize,
    source_count: usize,
) {
    let local = if progress.total == 0 {
        0.0
    } else {
        progress.completed as f64 / progress.total as f64
    };
    let phase = match progress.phase {
        SegmentPhase::Scan => local * 0.35,
        SegmentPhase::Bake => 0.35 + local * 0.65,
    };
    let fraction = (source_index as f64 + phase) / source_count as f64;
    emit_progress(
        Some(progress_key),
        0.02 + fraction.clamp(0.0, 1.0) * 0.86,
        progress.phase.label(),
    );
}

fn emit_sampling_progress(
    throttle: &mut IncrementalProgressThrottle,
    progress_key: &str,
    progress: SamplingProgress,
    start: f64,
    span: f64,
) {
    let local = progress.completed as f64 / progress.total.max(1) as f64;
    if !throttle.should_emit(progress.phase.label(), local) {
        return;
    }
    let phase_start = match progress.phase {
        SamplingPhase::Scan => 0.0,
        SamplingPhase::Select => 1.0 / 3.0,
        SamplingPhase::Bake => 2.0 / 3.0,
    };
    emit_progress(
        Some(progress_key),
        start + span * (phase_start + local.clamp(0.0, 1.0) / 3.0),
        progress.phase.label(),
    );
}

#[allow(clippy::cast_precision_loss)]
fn emit_rasterize_progress(
    throttle: &mut IncrementalProgressThrottle,
    progress_key: &str,
    progress: RasterizeProgress,
    start: f64,
    span: f64,
) {
    let local = progress.completed as f64 / progress.total.max(1) as f64;
    if !throttle.should_emit(progress.phase.label(), local) {
        return;
    }
    let phase_start = match progress.phase {
        RasterizePhase::Scan => 0.0,
        RasterizePhase::Aggregate => 1.0 / 3.0,
        RasterizePhase::Bake => 2.0 / 3.0,
    };
    emit_progress(
        Some(progress_key),
        start + span * (phase_start + local.clamp(0.0, 1.0) / 3.0),
        progress.phase.label(),
    );
}

#[allow(clippy::cast_precision_loss)]
fn emit_derived_publication_progress(
    throttle: &mut IncrementalProgressThrottle,
    progress_key: &str,
    publication: CanonicalImportProgress,
    noun: &str,
) {
    let local = if publication.total_bytes == 0 {
        0.0
    } else {
        publication.completed_bytes as f64 / publication.total_bytes as f64
    };
    let (start, span, verb) = match publication.phase {
        CanonicalImportProgressPhase::Staging => (0.88, 0.09, "Storing"),
        CanonicalImportProgressPhase::Publishing => (0.97, 0.03, "Committing"),
    };
    if !throttle.should_emit(verb, local) {
        return;
    }
    emit_progress(
        Some(progress_key),
        start + span * local.clamp(0.0, 1.0),
        &format!("{verb} prepared {noun}"),
    );
}

#[derive(Default)]
struct IncrementalProgressThrottle {
    phase: Option<&'static str>,
    local: f64,
}

impl IncrementalProgressThrottle {
    fn should_emit(&mut self, phase: &'static str, local: f64) -> bool {
        let local = local.clamp(0.0, 1.0);
        if self.phase == Some(phase) && local - self.local < 0.01 {
            return false;
        }
        self.phase = Some(phase);
        self.local = local;
        true
    }
}

fn ground_scope(source: &CanonicalGroundSource, scope: GroundScopeParams) -> GroundScope {
    GroundScope {
        placement: source.entity.placement.map_or(
            himmelcad_model::entity_model::Transform3d::IDENTITY.0,
            |value| value.0,
        ),
        viewing_box: scope.viewing_box,
        visible_classes: scope.visible_classes,
    }
}

fn capture_pointcloud_source(
    runtime: &Arc<Mutex<CanonicalAppRuntime>>,
    expected: EntityVersionRef,
    input_root: PathBuf,
    cancellation: &CancellationToken,
    progress_key: &str,
    start: f64,
    span: f64,
) -> Result<CanonicalGroundSource> {
    let capture = runtime
        .lock()
        .expect("canonical app runtime mutex poisoned")
        .plan_ground_source_capture(expected, input_root)?;
    let mut last_fraction = -1.0_f64;
    let mut last_artifact = String::new();
    let mut completed_bytes = 0_u64;
    for artifact in &capture.artifacts {
        let artifact_name = artifact.artifact.clone();
        himmelcad_sidecar::canonical_project_store::pin_canonical_object_with_progress(
            &artifact.source_path,
            &artifact.destination_path,
            &artifact.object_hash,
            artifact.byte_length,
            &mut |bytes| {
                completed_bytes = completed_bytes.saturating_add(bytes);
                let local = completed_bytes as f64 / capture.total_bytes.max(1) as f64;
                if artifact_name != last_artifact || local >= 1.0 || local - last_fraction >= 0.01 {
                    emit_progress(
                        Some(progress_key),
                        start + span * local.clamp(0.0, 1.0),
                        &format!("Capturing resident {artifact_name}"),
                    );
                    last_fraction = local;
                    last_artifact.clone_from(&artifact_name);
                }
                !cancellation.is_cancel_requested()
            },
        )?;
    }
    Ok(capture.source)
}

#[derive(Default)]
struct GroundProgressThrottle {
    phase: Option<GroundPhase>,
    local: f64,
}

impl GroundProgressThrottle {
    #[allow(clippy::cast_precision_loss)]
    fn emit(&mut self, progress_key: &str, progress: GroundProgress, start: f64, span: f64) {
        let local = if progress.total == 0 {
            0.0
        } else {
            progress.completed as f64 / progress.total as f64
        }
        .clamp(0.0, 1.0);
        if self.phase == Some(progress.phase) && local - self.local < 0.01 {
            return;
        }
        self.phase = Some(progress.phase);
        self.local = local;
        let phase_start = match progress.phase {
            GroundPhase::Grid => 0.0,
            GroundPhase::Filter => 0.25,
            GroundPhase::Classify => 0.50,
            GroundPhase::Bake => 0.75,
        };
        emit_progress(
            Some(progress_key),
            start + span * (phase_start + local * 0.25),
            progress.phase.label(),
        );
    }
}

struct GroundScratch {
    root: PathBuf,
}

impl GroundScratch {
    fn new(operation_id: &str) -> anyhow::Result<Self> {
        Self::new_with_prefix("ground", operation_id)
    }

    fn new_with_prefix(prefix: &str, operation_id: &str) -> anyhow::Result<Self> {
        validate_operation_id(operation_id)?;
        let root = std::env::temp_dir().join(format!(
            "hcad-{prefix}-{}-{operation_id}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root)?;
        }
        std::fs::create_dir(&root)?;
        Ok(Self { root })
    }
}

impl Drop for GroundScratch {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            tracing::warn!(path = %self.root.display(), %error, "failed to remove ground scratch directory");
        }
    }
}

fn current_rfc3339() -> String {
    let seconds = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0_i64, |value| {
            i64::try_from(value.as_secs()).unwrap_or(i64::MAX)
        });
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn emit_builder_archive_progress(progress_key: &str, progress: &ArchiveProgress) {
    let fraction = if progress.bytes_total > 0 {
        progress.bytes_completed as f64 / progress.bytes_total as f64
    } else if progress.files_total > 0 {
        progress.files_completed as f64 / progress.files_total as f64
    } else {
        0.0
    };
    let phase = match progress.phase {
        ArchivePhase::Scanning => "Scanning project",
        ArchivePhase::Packing => "Saving archive",
        ArchivePhase::Validating => "Validating archive",
        ArchivePhase::Extracting => "Opening archive",
        ArchivePhase::Committing => "Publishing archive",
    };
    emit_progress(Some(progress_key), fraction.clamp(0.0, 1.0), phase);
}

struct BuilderLifecycle;

impl ProductLifecycle for BuilderLifecycle {}

pub async fn run() -> anyhow::Result<()> {
    let shared = SharedRouteServices::new()?;
    let mut registry = SidecarCommandRegistry::default();
    register_shared_routes(&mut registry, &shared)?;
    let ground_operations = Arc::new(GroundOperations::default());
    let las_imports = Arc::new(LasImportOperations::default());

    canonical_app::CanonicalAppModule::new(Arc::clone(&shared.canonical_app))
        .register(&mut registry)?;
    builder_archive::BuilderArchiveModule::new(
        Arc::clone(&shared.io_operations),
        Arc::clone(&shared.canonical_app),
    )
    .register(&mut registry)?;
    mesh_surface::MeshSurfaceModule::new(
        Arc::clone(&ground_operations),
        Arc::clone(&shared.canonical_app),
    )
    .register(&mut registry)?;
    pointcloud_ground::PointcloudGroundModule::new(
        Arc::clone(&ground_operations),
        Arc::clone(&shared.canonical_app),
    )
    .register(&mut registry)?;
    pointcloud_processing::PointcloudProcessingModule::new(
        Arc::clone(&ground_operations),
        Arc::clone(&shared.canonical_app),
    )
    .register(&mut registry)?;
    pointcloud_segment::PointcloudSegmentModule::new(
        Arc::clone(&ground_operations),
        Arc::clone(&shared.canonical_app),
    )
    .register(&mut registry)?;
    root::RootModule::new(las_imports, Arc::clone(&shared.canonical_app))
        .register(&mut registry)?;

    let mut routes = shared_route_definitions();
    routes.extend(definitions(
        canonical_app::METHODS,
        "canonical-app",
        "builder",
    ));
    routes.extend(definitions(
        builder_archive::METHODS,
        "builder-archive",
        "builder",
    ));
    routes.extend(definitions(
        mesh_surface::METHODS,
        "mesh-surface",
        "builder",
    ));
    routes.extend(definitions(
        pointcloud_ground::METHODS,
        "pointcloud-ground",
        "builder",
    ));
    routes.extend(definitions(
        pointcloud_processing::METHODS,
        "pointcloud-processing",
        "builder",
    ));
    routes.extend(definitions(
        pointcloud_segment::METHODS,
        "pointcloud-segment",
        "builder",
    ));
    routes.extend(definitions(root::METHODS, "root", "builder"));

    himmelcad_sidecar::host::run(HostComposition {
        registry,
        routes,
        canonical_app: shared.canonical_app,
        lifecycle: Arc::new(BuilderLifecycle),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_progress_is_bucketed_by_phase_and_percent() {
        assert_eq!(
            segment_progress_bucket(SegmentProgress {
                phase: SegmentPhase::Scan,
                completed: 49,
                total: 10_000,
            }),
            (SegmentPhase::Scan, 0),
        );
        assert_eq!(
            segment_progress_bucket(SegmentProgress {
                phase: SegmentPhase::Scan,
                completed: 100,
                total: 10_000,
            }),
            (SegmentPhase::Scan, 1),
        );
        assert_eq!(
            segment_progress_bucket(SegmentProgress {
                phase: SegmentPhase::Bake,
                completed: u64::MAX,
                total: 1,
            }),
            (SegmentPhase::Bake, 100),
        );
    }

    #[test]
    fn las_import_cancellation_is_generation_scoped_and_removed_on_finish() {
        let operations = Arc::new(LasImportOperations::default());
        let active = operations
            .begin("import-1".to_string())
            .expect("begin import");
        assert!(!active.cancellation.load(Ordering::Acquire));
        assert!(operations.cancel("import-1"));
        assert!(active.cancellation.load(Ordering::Acquire));
        assert!(operations.begin("import-1".to_string()).is_err());
        assert!(operations.cancel("import-1"));
        drop(active);
        assert!(!operations.cancel("import-1"));
        assert!(operations.begin("import-1".to_string()).is_ok());
    }
}
