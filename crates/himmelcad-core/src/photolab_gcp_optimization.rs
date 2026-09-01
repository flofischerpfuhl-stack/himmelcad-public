//! Camera projection, GCP triangulation and robust georeferencing optimization.
//!
//! The solver deliberately has no native dependency. It initializes the project
//! frame with a robust similarity and then performs a bounded, robust sparse
//! bundle adjustment. Checkpoints participate in image reprojection but their
//! surveyed coordinates always remain evaluation-only.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::photolab_gcp::{
    aggregate_residual_statistics, compute_gcp_residual, ControlCheckpointStatistics,
    GcpCameraProjection, GcpCoordinate, GcpObservation, GcpObservationState,
    GcpOptimizationSnapshot, GcpPoint, GcpPointId, GcpResidual, ImageCoordinate,
    OptimizationPointParticipation, ProjectionUncertaintyEllipse, ReprojectionErrorSample,
};
use crate::photolab_matching::ImageId;

const MIN_DEPTH: f64 = 1.0e-9;
const MIN_SIGMA_METERS: f64 = 1.0e-6;
const MATRIX_EPSILON: f64 = 1.0e-12;
// Invalid candidates must never beat a valid reprojection merely because the
// projector cannot produce a sample for them.
const INVALID_PROJECTION_COST: f64 = 1.0e12;

/// Calibrated pinhole camera in reconstruction coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCameraModel {
    pub image_id: ImageId,
    /// Immutable calibration-group identity. Grouping is never inferred from
    /// numerically equal lens parameters: callers freeze this identity as part
    /// of the optimization input.
    pub calibration_group_id: String,
    /// Interior-orientation policy frozen for this camera's calibration group.
    #[serde(default)]
    pub intrinsics_policy: GcpIntrinsicsPolicy,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub focal_x_pixels: f64,
    pub focal_y_pixels: f64,
    pub principal_x_pixels: f64,
    pub principal_y_pixels: f64,
    #[serde(default)]
    pub radial_distortion: [f64; 3],
    #[serde(default)]
    pub tangential_distortion: [f64; 2],
    /// Row-major camera-to-reconstruction rotation.
    pub camera_to_reconstruction_rotation: [f64; 9],
    pub center_reconstruction: [f64; 3],
    /// Optional surveyed camera center in the established project frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_center_world_meters: Option<[f64; 3]>,
    /// One-sigma reference uncertainty for east, north, and height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_stddev_meters: Option<[f64; 3]>,
}

/// The ordinary Brown/Metashape-compatible parameters supported by the
/// automatic optimizer. Advanced affinity/skew and `k4` are deliberately not
/// representable here, so they can never be enabled accidentally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpIntrinsicParameter {
    F,
    Cx,
    Cy,
    K1,
    K2,
    K3,
    P1,
    P2,
}

/// Serializable selection of the eight supported parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GcpIntrinsicParameterMask {
    pub f: bool,
    pub cx: bool,
    pub cy: bool,
    pub k1: bool,
    pub k2: bool,
    pub k3: bool,
    pub p1: bool,
    pub p2: bool,
}

impl Default for GcpIntrinsicParameterMask {
    fn default() -> Self {
        Self::all()
    }
}

impl GcpIntrinsicParameterMask {
    pub const fn none() -> Self {
        Self {
            f: false,
            cx: false,
            cy: false,
            k1: false,
            k2: false,
            k3: false,
            p1: false,
            p2: false,
        }
    }

    pub const fn all() -> Self {
        Self {
            f: true,
            cx: true,
            cy: true,
            k1: true,
            k2: true,
            k3: true,
            p1: true,
            p2: true,
        }
    }

    const fn auto_base() -> Self {
        Self {
            f: true,
            cx: false,
            cy: false,
            k1: true,
            k2: false,
            k3: false,
            p1: false,
            p2: false,
        }
    }

    fn enabled(self, index: usize) -> bool {
        [
            self.f, self.cx, self.cy, self.k1, self.k2, self.k3, self.p1, self.p2,
        ][index]
    }

    pub fn parameters(self) -> Vec<GcpIntrinsicParameter> {
        const PARAMETERS: [GcpIntrinsicParameter; 8] = [
            GcpIntrinsicParameter::F,
            GcpIntrinsicParameter::Cx,
            GcpIntrinsicParameter::Cy,
            GcpIntrinsicParameter::K1,
            GcpIntrinsicParameter::K2,
            GcpIntrinsicParameter::K3,
            GcpIntrinsicParameter::P1,
            GcpIntrinsicParameter::P2,
        ];
        PARAMETERS
            .into_iter()
            .enumerate()
            .filter_map(|(index, parameter)| self.enabled(index).then_some(parameter))
            .collect()
    }
}

/// One-sigma priors in the solver's native parameterization (`f` is log-scale).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpIntrinsicPriorStddev {
    pub focal_log_scale: f64,
    pub principal_x_pixels: f64,
    pub principal_y_pixels: f64,
    pub k1: f64,
    pub k2: f64,
    pub k3: f64,
    pub p1: f64,
    pub p2: f64,
}

impl Default for GcpIntrinsicPriorStddev {
    fn default() -> Self {
        Self {
            focal_log_scale: 0.25,
            principal_x_pixels: 200.0,
            principal_y_pixels: 200.0,
            k1: 0.25,
            k2: 0.25,
            k3: 0.25,
            p1: 0.1,
            p2: 0.1,
        }
    }
}

impl GcpIntrinsicPriorStddev {
    fn values(self) -> [f64; 8] {
        [
            self.focal_log_scale,
            self.principal_x_pixels,
            self.principal_y_pixels,
            self.k1,
            self.k2,
            self.k3,
            self.p1,
            self.p2,
        ]
    }

    fn is_valid(self) -> bool {
        self.values()
            .into_iter()
            .all(|value| value.is_finite() && value > 0.0)
    }
}

/// Per-calibration-group interior-orientation behavior.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GcpIntrinsicsPolicy {
    Auto,
    Fixed,
    Prior {
        parameters: GcpIntrinsicParameterMask,
        stddev: GcpIntrinsicPriorStddev,
    },
    Custom {
        parameters: GcpIntrinsicParameterMask,
    },
}

impl Default for GcpIntrinsicsPolicy {
    fn default() -> Self {
        Self::Auto
    }
}

impl GcpCameraModel {
    fn validate(&self) -> Result<(), GcpOptimizationError> {
        if self.width_pixels == 0 || self.height_pixels == 0 {
            return Err(GcpOptimizationError::InvalidCamera(
                self.image_id,
                "image dimensions must be positive",
            ));
        }
        if !self.focal_x_pixels.is_finite()
            || !self.focal_y_pixels.is_finite()
            || self.focal_x_pixels <= 0.0
            || self.focal_y_pixels <= 0.0
        {
            return Err(GcpOptimizationError::InvalidCamera(
                self.image_id,
                "focal lengths must be positive and finite",
            ));
        }
        if self
            .camera_to_reconstruction_rotation
            .iter()
            .chain(self.center_reconstruction.iter())
            .chain(self.radial_distortion.iter())
            .chain(self.tangential_distortion.iter())
            .chain([self.principal_x_pixels, self.principal_y_pixels].iter())
            .any(|value| !value.is_finite())
        {
            return Err(GcpOptimizationError::InvalidCamera(
                self.image_id,
                "camera contains a non-finite value",
            ));
        }
        match (
            self.reference_center_world_meters,
            self.reference_stddev_meters,
        ) {
            (None, None) => {}
            (Some(center), Some(stddev))
                if center.iter().all(|value| value.is_finite())
                    && stddev.iter().all(|value| value.is_finite() && *value > 0.0) => {}
            _ => {
                return Err(GcpOptimizationError::InvalidCamera(
                    self.image_id,
                    "camera reference center and positive uncertainty must be provided together",
                ));
            }
        }
        if !is_rotation(self.camera_to_reconstruction_rotation) {
            return Err(GcpOptimizationError::InvalidCamera(
                self.image_id,
                "camera rotation must be orthonormal and right-handed",
            ));
        }
        Ok(())
    }
}

/// Camera after mapping the reconstruction into the project reference frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizedGcpCamera {
    pub image_id: ImageId,
    pub calibration_group_id: String,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub focal_x_pixels: f64,
    pub focal_y_pixels: f64,
    pub principal_x_pixels: f64,
    pub principal_y_pixels: f64,
    pub radial_distortion: [f64; 3],
    pub tangential_distortion: [f64; 2],
    /// Row-major camera-to-world rotation.
    pub camera_to_world_rotation: [f64; 9],
    pub center_world_meters: [f64; 3],
}

/// Marker color/state used consistently by image and 3D views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpMarkerVisualState {
    /// Unconfirmed projection proposal.
    PredictedBlue,
    /// Explicit user measurement.
    ManualGreen,
    /// Tie-point/keypoint assisted observation.
    AutomaticOrange,
    /// Intentionally unusable observation.
    BlockedMuted,
}

/// Returns the canonical visual state for an observation.
pub const fn observation_visual_state(state: &GcpObservationState) -> GcpMarkerVisualState {
    match state {
        GcpObservationState::Predicted { .. } => GcpMarkerVisualState::PredictedBlue,
        GcpObservationState::Manual { .. } => GcpMarkerVisualState::ManualGreen,
        GcpObservationState::Automatic { .. } => GcpMarkerVisualState::AutomaticOrange,
        GcpObservationState::Blocked { .. } => GcpMarkerVisualState::BlockedMuted,
    }
}

/// Pixel observation of one geometrically verified feature track.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpTiePointMeasurement {
    pub image_id: ImageId,
    pub coordinate: ImageCoordinate,
}

/// Minimal neutral tie-point track needed for assisted GCP marking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpTiePointTrack {
    pub track_id: u64,
    pub confidence_per_mille: u16,
    pub measurements: Vec<GcpTiePointMeasurement>,
}

/// One triangulated sparse-reconstruction point supplied to bundle adjustment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpBundleTiePoint {
    pub track_id: u64,
    pub reconstruction_coordinate: [f64; 3],
    pub measurements: Vec<GcpTiePointMeasurement>,
}

/// Automatic orange observations inferred from a manually confirmed keypoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpTiePointPropagation {
    pub track_id: u64,
    pub seed_distance_pixels: f64,
    pub observations: Vec<GcpObservation>,
}

/// Snaps a manual marker to the nearest verified feature track and propagates it.
/// Existing manual observations always win and are never overwritten.
pub fn propagate_gcp_through_tie_points(
    manual: &GcpObservation,
    tracks: &[GcpTiePointTrack],
    existing: &[GcpObservation],
    maximum_seed_distance_pixels: f64,
) -> Result<Option<GcpTiePointPropagation>, GcpOptimizationError> {
    let GcpObservationState::Manual {
        coordinate: manual_coordinate,
    } = manual.state
    else {
        return Err(GcpOptimizationError::TiePointSeedMustBeManual);
    };
    if !maximum_seed_distance_pixels.is_finite() || maximum_seed_distance_pixels <= 0.0 {
        return Err(GcpOptimizationError::InvalidTiePointThreshold);
    }
    let mut best: Option<(&GcpTiePointTrack, f64)> = None;
    for track in tracks {
        validate_tie_point_track(track)?;
        let Some(seed) = track
            .measurements
            .iter()
            .find(|measurement| measurement.image_id == manual.image_id)
        else {
            continue;
        };
        let distance = (seed.coordinate.x_pixels - manual_coordinate.x_pixels)
            .hypot(seed.coordinate.y_pixels - manual_coordinate.y_pixels);
        if distance <= maximum_seed_distance_pixels
            && best.is_none_or(|(candidate, candidate_distance)| {
                match distance.total_cmp(&candidate_distance) {
                    std::cmp::Ordering::Less => true,
                    std::cmp::Ordering::Equal => track.track_id < candidate.track_id,
                    std::cmp::Ordering::Greater => false,
                }
            })
        {
            best = Some((track, distance));
        }
    }
    let Some((track, distance)) = best else {
        return Ok(None);
    };
    let manually_measured_images = existing
        .iter()
        .filter(|observation| {
            observation.point_id == manual.point_id
                && matches!(observation.state, GcpObservationState::Manual { .. })
        })
        .map(|observation| observation.image_id)
        .collect::<BTreeSet<_>>();
    let distance_confidence =
        per_mille_from_unit_fraction(1.0 - distance / maximum_seed_distance_pixels);
    let confidence = track.confidence_per_mille.min(distance_confidence);
    let mut observations = track
        .measurements
        .iter()
        .filter(|measurement| {
            measurement.image_id != manual.image_id
                && !manually_measured_images.contains(&measurement.image_id)
        })
        .map(|measurement| GcpObservation {
            point_id: manual.point_id.clone(),
            image_id: measurement.image_id,
            state: GcpObservationState::Automatic {
                coordinate: measurement.coordinate,
                confidence_per_mille: confidence,
            },
        })
        .collect::<Vec<_>>();
    observations.sort_by_key(|observation| observation.image_id);
    Ok(Some(GcpTiePointPropagation {
        track_id: track.track_id,
        seed_distance_pixels: distance,
        observations,
    }))
}

fn per_mille_from_unit_fraction(value: f64) -> u16 {
    let scaled = value.clamp(0.0, 1.0) * 1_000.0;
    (0..=1_000_u16)
        .rev()
        .find(|candidate| f64::from(*candidate) <= scaled + 0.5)
        .unwrap_or_default()
}

fn validate_tie_point_track(track: &GcpTiePointTrack) -> Result<(), GcpOptimizationError> {
    if track.confidence_per_mille > 1_000 || track.measurements.len() < 2 {
        return Err(GcpOptimizationError::InvalidTiePointTrack(track.track_id));
    }
    let mut images = BTreeSet::new();
    for measurement in &track.measurements {
        if !measurement.coordinate.x_pixels.is_finite()
            || !measurement.coordinate.y_pixels.is_finite()
            || !images.insert(measurement.image_id)
        {
            return Err(GcpOptimizationError::InvalidTiePointTrack(track.track_id));
        }
    }
    Ok(())
}

/// Robust loss applied to normalized survey residuals.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GcpRobustLoss {
    Huber { threshold_sigma: f64 },
    Cauchy { scale_sigma: f64 },
}

impl Default for GcpRobustLoss {
    fn default() -> Self {
        Self::Huber {
            threshold_sigma: 2.5,
        }
    }
}

/// Degrees of freedom used by georeferencing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpTransformMode {
    /// Full similarity when at least three spatial controls support it; otherwise
    /// only observable translation components are adjusted.
    Auto,
    TranslationOnly,
    Similarity7,
}

/// Solver limits. Every iteration is an explicit cancellation checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct GcpSolverOptions {
    pub transform_mode: GcpTransformMode,
    pub robust_loss: GcpRobustLoss,
    pub maximum_iterations: u16,
    pub convergence_tolerance: f64,
    /// Maximum sparse tie points admitted to the in-memory adjustment.
    pub maximum_tie_points: u32,
    /// A-priori standard deviation of a measured image coordinate.
    pub reprojection_sigma_pixels: f64,
    /// A-priori standard deviation of an explicitly measured GCP marker.
    pub gcp_reprojection_sigma_pixels: f64,
    /// Refines camera rotations and centers while preserving a fixed gauge.
    pub refine_camera_extrinsics: bool,
    /// Refines one shared interior orientation per input calibration group.
    pub refine_shared_intrinsics: bool,
}

impl Default for GcpSolverOptions {
    fn default() -> Self {
        Self {
            transform_mode: GcpTransformMode::Auto,
            robust_loss: GcpRobustLoss::default(),
            maximum_iterations: 200,
            convergence_tolerance: 1.0e-8,
            maximum_tie_points: 50_000,
            reprojection_sigma_pixels: 1.0,
            gcp_reprojection_sigma_pixels: 0.25,
            refine_camera_extrinsics: true,
            refine_shared_intrinsics: true,
        }
    }
}

/// Similarity mapping reconstruction coordinates to project-world meters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpSimilarityTransform {
    pub scale: f64,
    pub rotation: [f64; 9],
    pub translation_meters: [f64; 3],
}

impl GcpSimilarityTransform {
    /// Identity transform.
    pub const fn identity() -> Self {
        Self {
            scale: 1.0,
            rotation: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            translation_meters: [0.0; 3],
        }
    }

    /// Applies the similarity to one reconstruction point.
    pub fn apply(self, point: [f64; 3]) -> [f64; 3] {
        add3(
            scale3(mat3_vec(self.rotation, point), self.scale),
            self.translation_meters,
        )
    }
}

/// One triangulated GCP and its optimized survey residual.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizedGcpPoint {
    pub point_id: GcpPointId,
    pub reconstruction_coordinate: [f64; 3],
    pub optimized_coordinate: GcpCoordinate,
    pub ray_intersection_rms_meters: f64,
    pub observation_count: u32,
}

/// Refined sparse tie point retained in the published alignment artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizedGcpTiePoint {
    pub track_id: u64,
    pub reconstruction_coordinate: [f64; 3],
    pub optimized_world_coordinate: [f64; 3],
    pub observation_count: u32,
}

/// Stage reported to UI and durable sidecar checkpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpOptimizationPhase {
    Validate,
    Triangulate,
    Optimize,
    Residuals,
    Projections,
    Complete,
}

/// Fine-grained progress emitted from CPU loops.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationProgress {
    pub phase: GcpOptimizationPhase,
    pub completed_units: u32,
    pub total_units: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<f64>,
}

/// Callback decision checked during all potentially long loops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcpSolveControl {
    Continue,
    Cancel,
}

/// Complete immutable optimization output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationResult {
    pub transform: GcpSimilarityTransform,
    pub effective_mode: GcpTransformMode,
    pub cameras: Vec<OptimizedGcpCamera>,
    pub points: Vec<OptimizedGcpPoint>,
    #[serde(default)]
    pub tie_points: Vec<OptimizedGcpTiePoint>,
    pub residuals: Vec<GcpResidual>,
    pub statistics: ControlCheckpointStatistics,
    pub projections: Vec<GcpCameraProjection>,
    pub iterations: u16,
    pub converged: bool,
    pub final_objective: f64,
    /// Number of cameras held fixed to remove similarity gauge freedom.
    pub fixed_gauge_camera_count: u32,
    /// Reproducible model-selection and observability report per explicit
    /// calibration group.
    #[serde(default)]
    pub intrinsics_diagnostics: Vec<GcpIntrinsicsGroupDiagnostics>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpIntrinsicsStageRejection {
    PolicyFixed,
    MasterRefinementDisabled,
    TooFewCameras,
    TooFewObservations,
    InsufficientQuadrantCoverage,
    InsufficientRadialCoverage,
    InsufficientBaselineDiversity,
    InsufficientDepthDiversity,
    IllConditioned,
    Singular,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpIntrinsicsStageDiagnostic {
    pub parameters: GcpIntrinsicParameterMask,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejection: Option<GcpIntrinsicsStageRejection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition_number: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpIntrinsicsGroupDiagnostics {
    pub calibration_group_id: String,
    pub policy: GcpIntrinsicsPolicy,
    pub camera_count: u32,
    pub observation_count: u32,
    pub occupied_quadrants: u8,
    /// Maximum observed radius divided by the half image diagonal.
    pub radial_coverage: f64,
    /// Camera-centre baseline divided by median observed depth.
    pub baseline_depth_ratio: f64,
    /// Robust depth range divided by median observed depth.
    pub relative_depth_range: f64,
    pub effective_parameters: GcpIntrinsicParameterMask,
    pub stages: Vec<GcpIntrinsicsStageDiagnostic>,
}

#[derive(Debug, Clone)]
struct TriangulatedPoint {
    definition: GcpPoint,
    participation: OptimizationPointParticipation,
    reconstruction: [f64; 3],
    ray_rms: f64,
}

#[derive(Debug, Clone, Copy)]
struct BundleObservation {
    camera_index: usize,
    measured: ImageCoordinate,
    sigma_pixels: f64,
    is_gcp_marker: bool,
}

#[derive(Debug, Clone)]
struct BundlePoint {
    track_id: Option<u64>,
    reconstruction: [f64; 3],
    world: [f64; 3],
    observations: Vec<BundleObservation>,
    survey: Option<GcpPoint>,
}

#[derive(Debug, Clone)]
struct BundleOutcome {
    iterations: u16,
    converged: bool,
    objective: f64,
    fixed_gauge_camera_count: u32,
    intrinsics_diagnostics: Vec<GcpIntrinsicsGroupDiagnostics>,
}

#[derive(Debug, Clone, Copy)]
struct BundleProgressRange {
    iteration_offset: u16,
    total_units: u32,
}

#[derive(Debug, Clone)]
struct IntrinsicGroupPlan {
    indices: Vec<usize>,
    diagnostics: GcpIntrinsicsGroupDiagnostics,
}

#[derive(Debug, Clone, Copy)]
struct CameraReferencePrior {
    center_world_meters: [f64; 3],
    stddev_meters: [f64; 3],
}

#[derive(Debug, Clone, Copy)]
struct CameraReferencePair {
    center_reconstruction: [f64; 3],
    center_world_meters: [f64; 3],
    stddev_meters: [f64; 3],
}

/// Runs triangulation, robust control-only fitting and checkpoint-only evaluation.
#[allow(clippy::too_many_lines)]
pub fn optimize_gcp_alignment<F>(
    snapshot: &GcpOptimizationSnapshot,
    cameras: &[GcpCameraModel],
    options: GcpSolverOptions,
    progress: F,
) -> Result<GcpOptimizationResult, GcpOptimizationError>
where
    F: FnMut(GcpOptimizationProgress) -> GcpSolveControl,
{
    optimize_gcp_bundle_alignment(snapshot, cameras, &[], options, progress)
}

/// Runs similarity initialization followed by weighted robust bundle adjustment.
///
/// Three spatial survey controls remove the similarity gauge. Without that
/// support, the first camera pose and (when present) second camera center form a
/// deterministic gauge. Survey priors are applied only to controls and honor
/// their independent XY/Z role masks. Interior orientation is refined once per
/// input calibration group against the sparse tie-point graph and GCP markers.
#[allow(clippy::too_many_lines)]
pub fn optimize_gcp_bundle_alignment<F>(
    snapshot: &GcpOptimizationSnapshot,
    cameras: &[GcpCameraModel],
    tie_points: &[GcpBundleTiePoint],
    options: GcpSolverOptions,
    mut progress: F,
) -> Result<GcpOptimizationResult, GcpOptimizationError>
where
    F: FnMut(GcpOptimizationProgress) -> GcpSolveControl,
{
    validate_options(options)?;
    check_progress(
        &mut progress,
        GcpOptimizationProgress {
            phase: GcpOptimizationPhase::Validate,
            completed_units: 0,
            total_units: 1,
            iteration: None,
            objective: None,
        },
    )?;
    validate_snapshot(snapshot)?;
    let camera_map = validate_cameras(cameras)?;
    let mut triangulated = Vec::with_capacity(snapshot.points.len());
    for (index, point) in snapshot.points.iter().enumerate() {
        let observations = snapshot
            .observations
            .iter()
            .filter(|observation| observation.point_id == point.point.id)
            .collect::<Vec<_>>();
        let (coordinate, ray_rms) = triangulate_observations(&observations, &camera_map)?;
        triangulated.push(TriangulatedPoint {
            definition: point.point.clone(),
            participation: point.participation,
            reconstruction: coordinate,
            ray_rms,
        });
        check_progress(
            &mut progress,
            GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Triangulate,
                completed_units: saturating_u32(index + 1),
                total_units: saturating_u32(snapshot.points.len()),
                iteration: None,
                objective: None,
            },
        )?;
    }

    let controls = triangulated
        .iter()
        .filter(|point| point.participation == OptimizationPointParticipation::Control)
        .collect::<Vec<_>>();
    let camera_only = controls.is_empty();
    let effective_mode = if camera_only {
        GcpTransformMode::Similarity7
    } else {
        effective_mode(options.transform_mode, &controls)?
    };
    let active = active_parameters(effective_mode, &controls);
    let mut transform = if camera_only {
        initial_camera_reference_transform(
            cameras,
            &snapshot.scope.camera_reference_image_ids,
            options.robust_loss,
        )?
    } else {
        initial_transform(&controls, effective_mode, options.robust_loss)
    };
    let mut lambda = 1.0e-6;
    let mut current_objective = objective(&controls, transform, options.robust_loss);
    let mut iterations = 0_u16;
    let similarity_iteration_limit = if camera_only {
        0
    } else {
        options.maximum_iterations.min(50)
    };
    // The seven-parameter initializer is tiny and should settle quickly; keep
    // the larger iteration budget for the coupled camera/point adjustment.
    for iteration in 0..similarity_iteration_limit {
        check_progress(
            &mut progress,
            GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Optimize,
                completed_units: u32::from(iteration),
                total_units: u32::from(similarity_iteration_limit)
                    .saturating_add(u32::from(options.maximum_iterations)),
                iteration: Some(iteration),
                objective: Some(current_objective),
            },
        )?;
        let (normal, gradient) =
            normal_equations(&controls, transform, options.robust_loss, active);
        let mut accepted = None;
        for _ in 0..10 {
            let mut damped = normal;
            for index in 0..7 {
                damped[index][index] += if active[index] {
                    lambda * normal[index][index].abs().max(1.0)
                } else {
                    1.0
                };
            }
            let delta = solve_7(damped, gradient.map(|value| -value))?;
            let candidate = update_transform(transform, delta);
            let candidate_objective = objective(&controls, candidate, options.robust_loss);
            if candidate_objective <= current_objective {
                accepted = Some((candidate, candidate_objective, delta));
                lambda = (lambda / 3.0).max(1.0e-12);
                break;
            }
            lambda = (lambda * 10.0).min(1.0e12);
        }
        let Some((candidate, candidate_objective, delta)) = accepted else {
            break;
        };
        transform = candidate;
        current_objective = candidate_objective;
        iterations = iteration + 1;
        if vector_norm_7(delta) <= options.convergence_tolerance {
            break;
        }
    }

    let mut optimized_cameras = cameras
        .iter()
        .map(|camera| transform_camera(camera, transform))
        .collect::<Vec<_>>();
    let mut bundle_points = build_bundle_points(
        &triangulated,
        tie_points,
        &optimized_cameras,
        transform,
        options,
    )?;
    let bundle_camera_indices = optimized_cameras
        .iter()
        .enumerate()
        .map(|(index, camera)| (camera.image_id, index))
        .collect::<BTreeMap<_, _>>();
    attach_gcp_bundle_observations(
        &mut bundle_points,
        &triangulated,
        snapshot,
        &bundle_camera_indices,
        options.gcp_reprojection_sigma_pixels,
    );
    let bundle = run_bundle_adjustment(
        &mut optimized_cameras,
        &mut bundle_points,
        cameras,
        &snapshot.scope.camera_reference_image_ids,
        options,
        BundleProgressRange {
            iteration_offset: iterations,
            total_units: u32::from(similarity_iteration_limit)
                .saturating_add(u32::from(options.maximum_iterations)),
        },
        &mut progress,
    )?;
    current_objective = bundle.objective;
    iterations = iterations.saturating_add(bundle.iterations);
    // Once bundle adjustment runs, its terminal state is authoritative. A
    // settled seven-parameter initializer must never mask a stalled camera /
    // point adjustment.
    let converged = bundle.converged;

    let mut points = Vec::with_capacity(triangulated.len());
    let mut residuals = Vec::with_capacity(triangulated.len());
    for (index, point) in triangulated.iter().enumerate() {
        let optimized = bundle_points[index].world;
        let optimized_coordinate = GcpCoordinate {
            east_meters: optimized[0],
            north_meters: optimized[1],
            height_meters: optimized[2],
        };
        let final_reprojection = bundle_points[index]
            .observations
            .iter()
            .filter_map(|observation| {
                let camera = optimized_cameras.get(observation.camera_index)?;
                let projected = project_world(camera, optimized).ok()?;
                Some(ReprojectionErrorSample {
                    image_id: camera.image_id,
                    error_pixels: (projected.x_pixels - observation.measured.x_pixels)
                        .hypot(projected.y_pixels - observation.measured.y_pixels),
                })
            })
            .collect::<Vec<_>>();
        residuals.push(compute_gcp_residual(
            &point.definition,
            optimized_coordinate,
            &final_reprojection,
        )?);
        points.push(OptimizedGcpPoint {
            point_id: point.definition.id.clone(),
            reconstruction_coordinate: point.reconstruction,
            optimized_coordinate,
            ray_intersection_rms_meters: point.ray_rms * transform.scale,
            observation_count: saturating_u32(final_reprojection.len()),
        });
        check_progress(
            &mut progress,
            GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Residuals,
                completed_units: saturating_u32(index + 1),
                total_units: saturating_u32(triangulated.len()),
                iteration: None,
                objective: Some(current_objective),
            },
        )?;
    }
    let statistics = aggregate_residual_statistics(&residuals)?;
    let optimized_tie_points = bundle_points
        .iter()
        .skip(triangulated.len())
        .filter_map(|point| {
            point.track_id.map(|track_id| OptimizedGcpTiePoint {
                track_id,
                reconstruction_coordinate: point.reconstruction,
                optimized_world_coordinate: point.world,
                observation_count: saturating_u32(point.observations.len()),
            })
        })
        .collect();
    let projections = predicted_projections(
        snapshot
            .points
            .iter()
            .map(|point| &point.point)
            .collect::<Vec<_>>()
            .as_slice(),
        &optimized_cameras,
        &mut progress,
    )?;
    check_progress(
        &mut progress,
        GcpOptimizationProgress {
            phase: GcpOptimizationPhase::Complete,
            completed_units: 1,
            total_units: 1,
            iteration: Some(iterations),
            objective: Some(current_objective),
        },
    )?;
    Ok(GcpOptimizationResult {
        transform,
        effective_mode,
        cameras: optimized_cameras,
        points,
        tie_points: optimized_tie_points,
        residuals,
        statistics,
        projections,
        iterations,
        converged,
        final_objective: current_objective,
        fixed_gauge_camera_count: bundle.fixed_gauge_camera_count,
        intrinsics_diagnostics: bundle.intrinsics_diagnostics,
    })
}

fn build_bundle_points(
    gcps: &[TriangulatedPoint],
    tie_points: &[GcpBundleTiePoint],
    cameras: &[OptimizedGcpCamera],
    transform: GcpSimilarityTransform,
    options: GcpSolverOptions,
) -> Result<Vec<BundlePoint>, GcpOptimizationError> {
    let camera_indices = cameras
        .iter()
        .enumerate()
        .map(|(index, camera)| (camera.image_id, index))
        .collect::<BTreeMap<_, _>>();
    let mut points = Vec::with_capacity(
        gcps.len().saturating_add(
            usize::try_from(options.maximum_tie_points)
                .unwrap_or(usize::MAX)
                .min(tie_points.len()),
        ),
    );
    for gcp in gcps {
        points.push(BundlePoint {
            track_id: None,
            reconstruction: gcp.reconstruction,
            world: transform.apply(gcp.reconstruction),
            observations: Vec::new(),
            survey: (gcp.participation == OptimizationPointParticipation::Control)
                .then(|| gcp.definition.clone()),
        });
    }
    // GCP image observations are attached by the caller after triangulation.
    let limit = usize::try_from(options.maximum_tie_points).unwrap_or(usize::MAX);
    let mut seen_tracks = BTreeSet::new();
    for tie_point in tie_points.iter().take(limit) {
        if !seen_tracks.insert(tie_point.track_id)
            || tie_point
                .reconstruction_coordinate
                .iter()
                .any(|value| !value.is_finite())
        {
            return Err(GcpOptimizationError::InvalidBundleTiePoint(
                tie_point.track_id,
            ));
        }
        let mut seen_images = BTreeSet::new();
        let mut observations = Vec::with_capacity(tie_point.measurements.len());
        for measurement in &tie_point.measurements {
            if !measurement.coordinate.x_pixels.is_finite()
                || !measurement.coordinate.y_pixels.is_finite()
                || !seen_images.insert(measurement.image_id)
            {
                return Err(GcpOptimizationError::InvalidBundleTiePoint(
                    tie_point.track_id,
                ));
            }
            if let Some(camera_index) = camera_indices.get(&measurement.image_id) {
                observations.push(BundleObservation {
                    camera_index: *camera_index,
                    measured: measurement.coordinate,
                    sigma_pixels: options.reprojection_sigma_pixels,
                    is_gcp_marker: false,
                });
            }
        }
        if observations.len() >= 2 {
            points.push(BundlePoint {
                track_id: Some(tie_point.track_id),
                reconstruction: tie_point.reconstruction_coordinate,
                world: transform.apply(tie_point.reconstruction_coordinate),
                observations,
                survey: None,
            });
        }
    }
    Ok(points)
}

fn attach_gcp_bundle_observations(
    bundle_points: &mut [BundlePoint],
    triangulated: &[TriangulatedPoint],
    snapshot: &GcpOptimizationSnapshot,
    camera_indices: &BTreeMap<ImageId, usize>,
    sigma_pixels: f64,
) {
    let point_indices = triangulated
        .iter()
        .enumerate()
        .map(|(index, point)| (point.definition.id.clone(), index))
        .collect::<BTreeMap<_, _>>();
    for observation in &snapshot.observations {
        let Some(measured) = usable_coordinate(&observation.state) else {
            continue;
        };
        let (Some(point_index), Some(camera_index)) = (
            point_indices.get(&observation.point_id),
            camera_indices.get(&observation.image_id),
        ) else {
            continue;
        };
        bundle_points[*point_index]
            .observations
            .push(BundleObservation {
                camera_index: *camera_index,
                measured,
                sigma_pixels,
                is_gcp_marker: true,
            });
    }
}

fn run_bundle_adjustment<F>(
    cameras: &mut [OptimizedGcpCamera],
    points: &mut [BundlePoint],
    source_cameras: &[GcpCameraModel],
    selected_camera_ids: &[ImageId],
    options: GcpSolverOptions,
    progress_range: BundleProgressRange,
    progress: &mut F,
) -> Result<BundleOutcome, GcpOptimizationError>
where
    F: FnMut(GcpOptimizationProgress) -> GcpSolveControl,
{
    if cameras.is_empty() || points.is_empty() {
        return Err(GcpOptimizationError::EmptyBundleAdjustment);
    }
    let selected = selected_camera_ids.iter().copied().collect::<BTreeSet<_>>();
    let camera_priors = source_cameras
        .iter()
        .map(|camera| {
            if !selected.contains(&camera.image_id) {
                return None;
            }
            Some(CameraReferencePrior {
                center_world_meters: camera.reference_center_world_meters?,
                stddev_meters: camera.reference_stddev_meters?,
            })
        })
        .collect::<Vec<_>>();
    let observations = camera_observation_index(cameras.len(), points);
    let intrinsic_groups =
        build_intrinsic_groups(source_cameras, cameras, &observations, points, options);
    // Start the nonlinear solve on the declared control datum. This is a
    // graduated initialization only: after the short anchoring stage the
    // controls are released again and their declared survey uncertainties are
    // honored by the final weighted adjustment.
    initialize_control_targets(points);
    let mut current_objective = bundle_objective(cameras, points, &camera_priors, options);
    let refinable = vec![true; cameras.len()];
    let gauge = if controls_anchor_bundle(points) {
        Vec::new()
    } else {
        refinable
            .iter()
            .enumerate()
            .filter_map(|(index, active)| active.then_some(index))
            .take(2)
            .collect::<Vec<_>>()
    };
    let mut converged = false;
    let mut iterations = 0_u16;
    let anchored_iterations = options.maximum_iterations.min(10);
    let mut stable_sweeps = 0_u8;
    for iteration in 0..options.maximum_iterations {
        let controls_anchored = iteration < anchored_iterations;
        check_progress(
            progress,
            GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Optimize,
                completed_units: u32::from(
                    progress_range.iteration_offset.saturating_add(iteration),
                ),
                total_units: progress_range.total_units,
                iteration: Some(progress_range.iteration_offset.saturating_add(iteration)),
                objective: Some(current_objective),
            },
        )?;
        let mut accepted_updates = 0_u32;
        for point_index in 0..points.len() {
            if point_index % 256 == 0 {
                check_progress(
                    progress,
                    GcpOptimizationProgress {
                        phase: GcpOptimizationPhase::Optimize,
                        completed_units: u32::from(
                            progress_range.iteration_offset.saturating_add(iteration),
                        ),
                        total_units: progress_range.total_units,
                        iteration: Some(progress_range.iteration_offset.saturating_add(iteration)),
                        objective: Some(current_objective),
                    },
                )?;
            }
            let step =
                refine_bundle_point(point_index, cameras, points, options, controls_anchored);
            accepted_updates += u32::from(step > 0.0);
        }
        if options.refine_camera_extrinsics {
            for camera_index in 0..cameras.len() {
                if !refinable[camera_index] || gauge.first() == Some(&camera_index) {
                    continue;
                }
                if camera_index % 32 == 0 {
                    check_progress(
                        progress,
                        GcpOptimizationProgress {
                            phase: GcpOptimizationPhase::Optimize,
                            completed_units: u32::from(
                                progress_range.iteration_offset.saturating_add(iteration),
                            ),
                            total_units: progress_range.total_units,
                            iteration: Some(
                                progress_range.iteration_offset.saturating_add(iteration),
                            ),
                            objective: Some(current_objective),
                        },
                    )?;
                }
                let step = refine_bundle_camera(
                    camera_index,
                    &observations[camera_index],
                    cameras,
                    points,
                    camera_priors[camera_index],
                    options,
                    gauge.get(1) == Some(&camera_index),
                );
                accepted_updates += u32::from(step > 0.0);
            }
        }
        if options.refine_shared_intrinsics {
            for group in &intrinsic_groups {
                let step = refine_intrinsic_group(
                    &group.indices,
                    group.diagnostics.effective_parameters,
                    cameras,
                    &observations,
                    points,
                    source_cameras,
                    options,
                );
                accepted_updates += u32::from(step > 0.0);
            }
        }
        let objective = bundle_objective(cameras, points, &camera_priors, options);
        iterations = iteration + 1;
        let objective_change = (current_objective - objective).abs();
        let relative_objective_change = objective_change / (1.0 + current_objective.abs());
        current_objective = objective;
        // A complete block-coordinate sweep mixes metres, radians and normalized
        // interior-orientation increments, so a single maximum-step threshold is
        // not dimensionally meaningful. Convergence is instead a sustained
        // relative objective plateau (or several sweeps with no accepted block
        // update). Requiring four complete sweeps avoids one-off line-search
        // stalls while reporting an honest numerical terminal state.
        // The option is also the parameter-step tolerance of the compact
        // seven-parameter initializer. Its square root is the dimensionless
        // relative-cost tolerance for this much larger sparse bundle.
        if controls_anchored {
            // The initial control lock deliberately creates a flat objective:
            // it must never be mistaken for convergence before the controls
            // have participated as weighted bundle unknowns at least once.
            stable_sweeps = 0;
        } else if relative_objective_change <= 3.0 * options.convergence_tolerance.sqrt()
            || accepted_updates == 0
        {
            stable_sweeps = stable_sweeps.saturating_add(1);
        } else {
            stable_sweeps = 0;
        }
        if !controls_anchored && stable_sweeps >= 4 {
            converged = true;
            break;
        }
    }
    Ok(BundleOutcome {
        iterations,
        converged,
        objective: current_objective,
        fixed_gauge_camera_count: u32::try_from(gauge.len()).unwrap_or(2),
        intrinsics_diagnostics: intrinsic_groups
            .into_iter()
            .map(|group| group.diagnostics)
            .collect(),
    })
}

fn initialize_control_targets(points: &mut [BundlePoint]) {
    for point in points {
        let Some(survey) = &point.survey else {
            continue;
        };
        if survey.role.uses_xy() {
            point.world[0] = survey.coordinate.east_meters;
            point.world[1] = survey.coordinate.north_meters;
        }
        if survey.role.uses_z() {
            point.world[2] = survey.coordinate.height_meters;
        }
    }
}

fn camera_observation_index(
    camera_count: usize,
    points: &[BundlePoint],
) -> Vec<Vec<(usize, ImageCoordinate, f64, bool)>> {
    let mut result = vec![Vec::new(); camera_count];
    for (point_index, point) in points.iter().enumerate() {
        for observation in &point.observations {
            result[observation.camera_index].push((
                point_index,
                observation.measured,
                observation.sigma_pixels,
                observation.is_gcp_marker,
            ));
        }
    }
    result
}

fn controls_anchor_bundle(points: &[BundlePoint]) -> bool {
    let controls = points
        .iter()
        .filter_map(|point| point.survey.as_ref())
        .filter(|point| point.role.uses_xy() && point.role.uses_z())
        .map(|point| {
            [
                point.coordinate.east_meters,
                point.coordinate.north_meters,
                point.coordinate.height_meters,
            ]
        })
        .collect::<Vec<_>>();
    if controls.len() < 3 {
        return false;
    }
    let baseline = sub3(controls[1], controls[0]);
    controls.iter().skip(2).any(|point| {
        let offset = sub3(*point, controls[0]);
        norm3(cross3(baseline, offset)) > 1.0e-6
    })
}

fn build_intrinsic_groups(
    source_cameras: &[GcpCameraModel],
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    options: GcpSolverOptions,
) -> Vec<IntrinsicGroupPlan> {
    let mut groups = BTreeMap::<String, Vec<usize>>::new();
    for (index, camera) in source_cameras.iter().enumerate() {
        groups
            .entry(camera.calibration_group_id.clone())
            .or_default()
            .push(index);
    }
    groups
        .into_iter()
        .map(|(calibration_group_id, indices)| {
            let diagnostics = intrinsic_group_diagnostics(
                calibration_group_id,
                &indices,
                source_cameras,
                cameras,
                observations,
                points,
                options,
            );
            IntrinsicGroupPlan {
                indices,
                diagnostics,
            }
        })
        .collect()
}

fn refine_intrinsic_group(
    group: &[usize],
    active: GcpIntrinsicParameterMask,
    cameras: &mut [OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    source_cameras: &[GcpCameraModel],
    options: GcpSolverOptions,
) -> f64 {
    let Some(&first_index) = group.first() else {
        return 0.0;
    };
    if active == GcpIntrinsicParameterMask::none() {
        return 0.0;
    }
    let mut normal = [[0.0; 8]; 8];
    let mut gradient = [0.0; 8];
    let mut usable = 0_usize;
    for &camera_index in group {
        let camera = &cameras[camera_index];
        for (point_index, measured, sigma_pixels, is_gcp_marker) in &observations[camera_index] {
            let point = points[*point_index].world;
            let Ok((projected, jacobian)) = intrinsic_projection_jacobian(camera, point) else {
                continue;
            };
            let residual = [
                projected.x_pixels - measured.x_pixels,
                projected.y_pixels - measured.y_pixels,
            ];
            let normalized = residual[0].hypot(residual[1]) / sigma_pixels;
            let weight = robust_weight(
                observation_loss(options.robust_loss, *is_gcp_marker),
                normalized,
            ) / sigma_pixels.powi(2);
            accumulate_2d_normal(&mut normal, &mut gradient, jacobian, residual, weight);
            usable += 1;
        }
    }
    if usable < active.parameters().len().saturating_mul(2).max(8) {
        return 0.0;
    }
    let policy = source_cameras[first_index].intrinsics_policy;
    if let GcpIntrinsicsPolicy::Prior { stddev, .. } = policy {
        accumulate_intrinsic_prior(
            &mut normal,
            &mut gradient,
            &cameras[first_index],
            &source_cameras[first_index],
            active,
            stddev,
        );
    } else if matches!(policy, GcpIntrinsicsPolicy::Auto) {
        accumulate_intrinsic_prior(
            &mut normal,
            &mut gradient,
            &cameras[first_index],
            &source_cameras[first_index],
            active,
            default_intrinsic_prior(&source_cameras[first_index]),
        );
    }
    constrain_inactive_intrinsics(&mut normal, &mut gradient, active);
    damp_diagonal(&mut normal, 1.0e-4);
    let Some(delta) = solve_linear(normal, gradient.map(|value| -value)) else {
        return 0.0;
    };
    let old_cost = intrinsic_group_objective(
        group,
        cameras,
        observations,
        points,
        &source_cameras[first_index],
        options,
    );
    for divisor in [1.0, 2.0, 4.0, 8.0, 16.0] {
        let step = delta.map(|value| value / divisor);
        let shared = perturb_intrinsics(&cameras[first_index], step);
        let mut candidates = group
            .iter()
            .map(|index| copy_intrinsics(&cameras[*index], &shared))
            .collect::<Vec<_>>();
        if !valid_intrinsic_candidate(&candidates[0], &source_cameras[first_index]) {
            continue;
        }
        let candidate_cost = intrinsic_group_candidate_objective(
            group,
            &candidates,
            observations,
            points,
            &source_cameras[first_index],
            options,
        );
        if candidate_cost <= old_cost {
            for (&camera_index, candidate) in group.iter().zip(candidates.drain(..)) {
                cameras[camera_index] = candidate;
            }
            return normalized_intrinsic_step(step, &cameras[first_index]);
        }
    }
    0.0
}

fn intrinsic_group_diagnostics(
    calibration_group_id: String,
    group: &[usize],
    source_cameras: &[GcpCameraModel],
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    options: GcpSolverOptions,
) -> GcpIntrinsicsGroupDiagnostics {
    let first_index = group[0];
    let policy = source_cameras[first_index].intrinsics_policy;
    let geometry = intrinsic_group_geometry(group, cameras, observations, points);
    let mut stages = Vec::new();
    let effective_parameters = if !options.refine_shared_intrinsics {
        stages.push(rejected_intrinsic_stage(
            policy_parameters(policy),
            GcpIntrinsicsStageRejection::MasterRefinementDisabled,
            None,
        ));
        GcpIntrinsicParameterMask::none()
    } else {
        match policy {
            GcpIntrinsicsPolicy::Fixed => {
                stages.push(rejected_intrinsic_stage(
                    GcpIntrinsicParameterMask::none(),
                    GcpIntrinsicsStageRejection::PolicyFixed,
                    None,
                ));
                GcpIntrinsicParameterMask::none()
            }
            GcpIntrinsicsPolicy::Auto => {
                auto_intrinsic_mask(group, cameras, observations, points, geometry, &mut stages)
            }
            GcpIntrinsicsPolicy::Prior { parameters, .. } => select_explicit_intrinsic_mask(
                parameters,
                group,
                cameras,
                observations,
                points,
                ExplicitIntrinsicSelection {
                    geometry,
                    maximum_condition: 1.0e12,
                },
                &mut stages,
            ),
            GcpIntrinsicsPolicy::Custom { parameters } => select_explicit_intrinsic_mask(
                parameters,
                group,
                cameras,
                observations,
                points,
                ExplicitIntrinsicSelection {
                    geometry,
                    maximum_condition: 1.0e10,
                },
                &mut stages,
            ),
        }
    };
    GcpIntrinsicsGroupDiagnostics {
        calibration_group_id,
        policy,
        camera_count: saturating_u32(group.len()),
        observation_count: saturating_u32(geometry.observation_count),
        occupied_quadrants: geometry.occupied_quadrants,
        radial_coverage: geometry.radial_coverage,
        baseline_depth_ratio: geometry.baseline_depth_ratio,
        relative_depth_range: geometry.relative_depth_range,
        effective_parameters,
        stages,
    }
}

#[derive(Debug, Clone, Copy)]
struct IntrinsicGroupGeometry {
    observation_count: usize,
    occupied_quadrants: u8,
    radial_coverage: f64,
    baseline_depth_ratio: f64,
    relative_depth_range: f64,
}

#[derive(Debug, Clone, Copy)]
struct ExplicitIntrinsicSelection {
    geometry: IntrinsicGroupGeometry,
    maximum_condition: f64,
}

fn intrinsic_group_geometry(
    group: &[usize],
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
) -> IntrinsicGroupGeometry {
    let mut quadrants = [false; 4];
    let mut maximum_radius = 0.0_f64;
    let mut depths = Vec::new();
    let mut observation_count = 0_usize;
    for &camera_index in group {
        let camera = &cameras[camera_index];
        let half_diagonal =
            (f64::from(camera.width_pixels).hypot(f64::from(camera.height_pixels)) / 2.0).max(1.0);
        for (point_index, measured, _, _) in &observations[camera_index] {
            let offset = [
                measured.x_pixels - camera.principal_x_pixels,
                measured.y_pixels - camera.principal_y_pixels,
            ];
            maximum_radius = maximum_radius.max(offset[0].hypot(offset[1]) / half_diagonal);
            let quadrant = usize::from(offset[0] >= 0.0) + 2 * usize::from(offset[1] >= 0.0);
            quadrants[quadrant] = true;
            let camera_point = mat3_transpose_vec(
                camera.camera_to_world_rotation,
                sub3(points[*point_index].world, camera.center_world_meters),
            );
            if camera_point[2].is_finite() && camera_point[2] > MIN_DEPTH {
                depths.push(camera_point[2]);
            }
            observation_count += 1;
        }
    }
    depths.sort_by(f64::total_cmp);
    let median_depth = depths
        .get(depths.len() / 2)
        .copied()
        .unwrap_or(1.0)
        .max(MIN_DEPTH);
    let relative_depth_range = match (depths.first(), depths.last()) {
        (Some(minimum), Some(maximum)) => (maximum - minimum) / median_depth,
        _ => 0.0,
    };
    let mut maximum_baseline = 0.0_f64;
    for (position, &left) in group.iter().enumerate() {
        for &right in &group[position + 1..] {
            maximum_baseline = maximum_baseline.max(norm3(sub3(
                cameras[left].center_world_meters,
                cameras[right].center_world_meters,
            )));
        }
    }
    IntrinsicGroupGeometry {
        observation_count,
        occupied_quadrants: u8::try_from(
            quadrants.into_iter().filter(|occupied| *occupied).count(),
        )
        .unwrap_or(4),
        radial_coverage: maximum_radius,
        baseline_depth_ratio: maximum_baseline / median_depth,
        relative_depth_range,
    }
}

fn auto_intrinsic_mask(
    group: &[usize],
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    geometry: IntrinsicGroupGeometry,
    stages: &mut Vec<GcpIntrinsicsStageDiagnostic>,
) -> GcpIntrinsicParameterMask {
    let candidates = [
        (
            GcpIntrinsicParameterMask::auto_base(),
            32,
            3,
            0.25,
            0.02,
            0.02,
            1.0e8,
        ),
        (
            GcpIntrinsicParameterMask {
                k2: true,
                ..GcpIntrinsicParameterMask::auto_base()
            },
            64,
            4,
            0.45,
            0.03,
            0.04,
            5.0e7,
        ),
        (
            GcpIntrinsicParameterMask {
                cx: true,
                cy: true,
                k2: true,
                ..GcpIntrinsicParameterMask::auto_base()
            },
            80,
            4,
            0.50,
            0.04,
            0.05,
            2.0e7,
        ),
        (
            GcpIntrinsicParameterMask {
                cx: true,
                cy: true,
                k2: true,
                p1: true,
                p2: true,
                ..GcpIntrinsicParameterMask::auto_base()
            },
            96,
            4,
            0.60,
            0.05,
            0.08,
            1.0e7,
        ),
        (
            GcpIntrinsicParameterMask::all(),
            128,
            4,
            0.75,
            0.08,
            0.12,
            5.0e6,
        ),
    ];
    let mut effective = GcpIntrinsicParameterMask::none();
    for (
        parameters,
        minimum_observations,
        minimum_quadrants,
        radial,
        baseline,
        depth,
        maximum_condition,
    ) in candidates
    {
        let rejection = intrinsic_stage_geometry_rejection(
            group.len(),
            geometry,
            minimum_observations,
            minimum_quadrants,
            radial,
            baseline,
            depth,
        );
        let condition =
            intrinsic_condition_number(group, parameters, cameras, observations, points);
        let rejection = rejection.or(match condition {
            None => Some(GcpIntrinsicsStageRejection::Singular),
            Some(value) if value > maximum_condition => {
                Some(GcpIntrinsicsStageRejection::IllConditioned)
            }
            Some(_) => None,
        });
        let accepted = rejection.is_none();
        stages.push(GcpIntrinsicsStageDiagnostic {
            parameters,
            accepted,
            rejection,
            condition_number: condition,
        });
        if !accepted {
            break;
        }
        effective = parameters;
    }
    effective
}

fn select_explicit_intrinsic_mask(
    parameters: GcpIntrinsicParameterMask,
    group: &[usize],
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    selection: ExplicitIntrinsicSelection,
    stages: &mut Vec<GcpIntrinsicsStageDiagnostic>,
) -> GcpIntrinsicParameterMask {
    if parameters == GcpIntrinsicParameterMask::none() {
        stages.push(GcpIntrinsicsStageDiagnostic {
            parameters,
            accepted: true,
            rejection: None,
            condition_number: Some(1.0),
        });
        return parameters;
    }
    let minimum = parameters.parameters().len().saturating_mul(2).max(8);
    let mut rejection = intrinsic_stage_geometry_rejection(
        group.len(),
        selection.geometry,
        minimum,
        2,
        0.1,
        0.005,
        0.005,
    );
    let condition = intrinsic_condition_number(group, parameters, cameras, observations, points);
    rejection = rejection.or(match condition {
        None => Some(GcpIntrinsicsStageRejection::Singular),
        Some(value) if value > selection.maximum_condition => {
            Some(GcpIntrinsicsStageRejection::IllConditioned)
        }
        Some(_) => None,
    });
    stages.push(GcpIntrinsicsStageDiagnostic {
        parameters,
        accepted: rejection.is_none(),
        rejection,
        condition_number: condition,
    });
    if rejection.is_none() {
        parameters
    } else {
        GcpIntrinsicParameterMask::none()
    }
}

fn intrinsic_stage_geometry_rejection(
    camera_count: usize,
    geometry: IntrinsicGroupGeometry,
    minimum_observations: usize,
    minimum_quadrants: u8,
    radial_coverage: f64,
    baseline_depth_ratio: f64,
    relative_depth_range: f64,
) -> Option<GcpIntrinsicsStageRejection> {
    if camera_count < 2 {
        Some(GcpIntrinsicsStageRejection::TooFewCameras)
    } else if geometry.observation_count < minimum_observations {
        Some(GcpIntrinsicsStageRejection::TooFewObservations)
    } else if geometry.occupied_quadrants < minimum_quadrants {
        Some(GcpIntrinsicsStageRejection::InsufficientQuadrantCoverage)
    } else if geometry.radial_coverage < radial_coverage {
        Some(GcpIntrinsicsStageRejection::InsufficientRadialCoverage)
    } else if geometry.baseline_depth_ratio < baseline_depth_ratio {
        Some(GcpIntrinsicsStageRejection::InsufficientBaselineDiversity)
    } else if geometry.relative_depth_range < relative_depth_range {
        Some(GcpIntrinsicsStageRejection::InsufficientDepthDiversity)
    } else {
        None
    }
}

fn rejected_intrinsic_stage(
    parameters: GcpIntrinsicParameterMask,
    rejection: GcpIntrinsicsStageRejection,
    condition_number: Option<f64>,
) -> GcpIntrinsicsStageDiagnostic {
    GcpIntrinsicsStageDiagnostic {
        parameters,
        accepted: false,
        rejection: Some(rejection),
        condition_number,
    }
}

fn policy_parameters(policy: GcpIntrinsicsPolicy) -> GcpIntrinsicParameterMask {
    match policy {
        GcpIntrinsicsPolicy::Auto => GcpIntrinsicParameterMask::all(),
        GcpIntrinsicsPolicy::Fixed => GcpIntrinsicParameterMask::none(),
        GcpIntrinsicsPolicy::Prior { parameters, .. }
        | GcpIntrinsicsPolicy::Custom { parameters } => parameters,
    }
}

fn intrinsic_projection_jacobian(
    camera: &OptimizedGcpCamera,
    point: [f64; 3],
) -> Result<(ImageCoordinate, [[f64; 8]; 2]), GcpOptimizationError> {
    let camera_point = mat3_transpose_vec(
        camera.camera_to_world_rotation,
        sub3(point, camera.center_world_meters),
    );
    if camera_point[2] <= MIN_DEPTH {
        return Err(GcpOptimizationError::PointBehindCamera);
    }
    let normalized = [
        camera_point[0] / camera_point[2],
        camera_point[1] / camera_point[2],
    ];
    let radius2 = normalized[0].powi(2) + normalized[1].powi(2);
    let radius4 = radius2.powi(2);
    let radius6 = radius2.powi(3);
    let distorted = distort(
        normalized,
        camera.radial_distortion,
        camera.tangential_distortion,
    );
    let projected = ImageCoordinate {
        x_pixels: camera.focal_x_pixels * distorted[0] + camera.principal_x_pixels,
        y_pixels: camera.focal_y_pixels * distorted[1] + camera.principal_y_pixels,
    };
    let x = normalized[0];
    let y = normalized[1];
    Ok((
        projected,
        [
            [
                camera.focal_x_pixels * distorted[0],
                1.0,
                0.0,
                camera.focal_x_pixels * x * radius2,
                camera.focal_x_pixels * x * radius4,
                camera.focal_x_pixels * x * radius6,
                camera.focal_x_pixels * 2.0 * x * y,
                camera.focal_x_pixels * (radius2 + 2.0 * x * x),
            ],
            [
                camera.focal_y_pixels * distorted[1],
                0.0,
                1.0,
                camera.focal_y_pixels * y * radius2,
                camera.focal_y_pixels * y * radius4,
                camera.focal_y_pixels * y * radius6,
                camera.focal_y_pixels * (radius2 + 2.0 * y * y),
                camera.focal_y_pixels * 2.0 * x * y,
            ],
        ],
    ))
}

fn intrinsic_condition_number(
    group: &[usize],
    active: GcpIntrinsicParameterMask,
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
) -> Option<f64> {
    let indices = (0..8)
        .filter(|index| active.enabled(*index))
        .collect::<Vec<_>>();
    if indices.is_empty() {
        return Some(1.0);
    }
    let mut normal = [[0.0; 8]; 8];
    for &camera_index in group {
        let camera = &cameras[camera_index];
        for (point_index, _, sigma_pixels, _) in &observations[camera_index] {
            let Ok((_, jacobian)) =
                intrinsic_projection_jacobian(camera, points[*point_index].world)
            else {
                continue;
            };
            let mut unused_gradient = [0.0; 8];
            accumulate_2d_normal(
                &mut normal,
                &mut unused_gradient,
                jacobian,
                [0.0; 2],
                1.0 / sigma_pixels.powi(2),
            );
        }
    }
    let dimension = indices.len();
    let mut correlation = vec![vec![0.0; dimension]; dimension];
    for (row, &source_row) in indices.iter().enumerate() {
        let row_scale = normal[source_row][source_row].sqrt();
        if !row_scale.is_finite() || row_scale <= MATRIX_EPSILON {
            return None;
        }
        for (column, &source_column) in indices.iter().enumerate() {
            let column_scale = normal[source_column][source_column].sqrt();
            correlation[row][column] =
                normal[source_row][source_column] / (row_scale * column_scale);
        }
    }
    symmetric_condition_number(correlation)
}

fn symmetric_condition_number(mut matrix: Vec<Vec<f64>>) -> Option<f64> {
    let dimension = matrix.len();
    for _ in 0..dimension.saturating_mul(dimension).saturating_mul(32) {
        let mut pivot = None;
        let mut maximum = 0.0_f64;
        for (row, values) in matrix.iter().enumerate() {
            for (column, value) in values.iter().enumerate().skip(row + 1) {
                if value.abs() > maximum {
                    maximum = value.abs();
                    pivot = Some((row, column));
                }
            }
        }
        if maximum <= 1.0e-12 {
            break;
        }
        let (row, column) = pivot?;
        let angle =
            0.5 * (2.0 * matrix[row][column]).atan2(matrix[column][column] - matrix[row][row]);
        let (sine, cosine) = angle.sin_cos();
        let old_row = matrix[row][row];
        let old_column = matrix[column][column];
        let cross = matrix[row][column];
        matrix[row][row] =
            cosine * cosine * old_row - 2.0 * sine * cosine * cross + sine * sine * old_column;
        matrix[column][column] =
            sine * sine * old_row + 2.0 * sine * cosine * cross + cosine * cosine * old_column;
        matrix[row][column] = 0.0;
        matrix[column][row] = 0.0;
        for index in 0..dimension {
            if index == row || index == column {
                continue;
            }
            let left = matrix[index][row];
            let right = matrix[index][column];
            matrix[index][row] = cosine * left - sine * right;
            matrix[row][index] = matrix[index][row];
            matrix[index][column] = sine * left + cosine * right;
            matrix[column][index] = matrix[index][column];
        }
    }
    let mut minimum = f64::INFINITY;
    let mut maximum = 0.0_f64;
    for (index, row) in matrix.iter().enumerate() {
        let eigenvalue = row[index];
        if !eigenvalue.is_finite() || eigenvalue <= 1.0e-10 {
            return None;
        }
        minimum = minimum.min(eigenvalue);
        maximum = maximum.max(eigenvalue);
    }
    Some(maximum / minimum)
}

fn accumulate_intrinsic_prior(
    normal: &mut [[f64; 8]; 8],
    gradient: &mut [f64; 8],
    camera: &OptimizedGcpCamera,
    source: &GcpCameraModel,
    active: GcpIntrinsicParameterMask,
    stddev: GcpIntrinsicPriorStddev,
) {
    let residuals = [
        (camera.focal_x_pixels / source.focal_x_pixels).ln(),
        camera.principal_x_pixels - source.principal_x_pixels,
        camera.principal_y_pixels - source.principal_y_pixels,
        camera.radial_distortion[0] - source.radial_distortion[0],
        camera.radial_distortion[1] - source.radial_distortion[1],
        camera.radial_distortion[2] - source.radial_distortion[2],
        camera.tangential_distortion[0] - source.tangential_distortion[0],
        camera.tangential_distortion[1] - source.tangential_distortion[1],
    ];
    let sigmas = stddev.values();
    for index in 0..8 {
        if !active.enabled(index) {
            continue;
        }
        let weight = 1.0 / sigmas[index].powi(2);
        normal[index][index] += weight;
        gradient[index] += weight * residuals[index];
    }
}

fn default_intrinsic_prior(source: &GcpCameraModel) -> GcpIntrinsicPriorStddev {
    GcpIntrinsicPriorStddev {
        principal_x_pixels: f64::from(source.width_pixels) * 0.1,
        principal_y_pixels: f64::from(source.height_pixels) * 0.1,
        ..GcpIntrinsicPriorStddev::default()
    }
}

fn constrain_inactive_intrinsics(
    normal: &mut [[f64; 8]; 8],
    gradient: &mut [f64; 8],
    active: GcpIntrinsicParameterMask,
) {
    for index in 0..8 {
        if active.enabled(index) {
            continue;
        }
        for other in 0..8 {
            normal[index][other] = 0.0;
            normal[other][index] = 0.0;
        }
        normal[index][index] = 1.0;
        gradient[index] = 0.0;
    }
}

fn perturb_intrinsics(camera: &OptimizedGcpCamera, delta: [f64; 8]) -> OptimizedGcpCamera {
    let mut candidate = camera.clone();
    let focal_scale = delta[0].exp();
    candidate.focal_x_pixels *= focal_scale;
    candidate.focal_y_pixels *= focal_scale;
    candidate.principal_x_pixels += delta[1];
    candidate.principal_y_pixels += delta[2];
    candidate.radial_distortion[0] += delta[3];
    candidate.radial_distortion[1] += delta[4];
    candidate.radial_distortion[2] += delta[5];
    candidate.tangential_distortion[0] += delta[6];
    candidate.tangential_distortion[1] += delta[7];
    candidate
}

fn copy_intrinsics(camera: &OptimizedGcpCamera, source: &OptimizedGcpCamera) -> OptimizedGcpCamera {
    let mut candidate = camera.clone();
    candidate.focal_x_pixels = source.focal_x_pixels;
    candidate.focal_y_pixels = source.focal_y_pixels;
    candidate.principal_x_pixels = source.principal_x_pixels;
    candidate.principal_y_pixels = source.principal_y_pixels;
    candidate.radial_distortion = source.radial_distortion;
    candidate.tangential_distortion = source.tangential_distortion;
    candidate
}

fn valid_intrinsic_candidate(camera: &OptimizedGcpCamera, source: &GcpCameraModel) -> bool {
    let focal_ratio = camera.focal_x_pixels / source.focal_x_pixels;
    (0.5..=2.0).contains(&focal_ratio)
        && camera.principal_x_pixels.abs() <= f64::from(camera.width_pixels) * 1.5
        && camera.principal_y_pixels.abs() <= f64::from(camera.height_pixels) * 1.5
        && camera
            .radial_distortion
            .iter()
            .chain(camera.tangential_distortion.iter())
            .all(|value| value.is_finite() && value.abs() <= 2.0)
}

fn normalized_intrinsic_step(delta: [f64; 8], camera: &OptimizedGcpCamera) -> f64 {
    let scaled = [
        delta[0],
        delta[1] / f64::from(camera.width_pixels),
        delta[2] / f64::from(camera.height_pixels),
        delta[3],
        delta[4],
        delta[5],
        delta[6],
        delta[7],
    ];
    scaled.iter().map(|value| value * value).sum::<f64>().sqrt()
}

fn intrinsic_group_objective(
    group: &[usize],
    cameras: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    source: &GcpCameraModel,
    options: GcpSolverOptions,
) -> f64 {
    let candidate_cameras = group
        .iter()
        .map(|index| cameras[*index].clone())
        .collect::<Vec<_>>();
    intrinsic_group_candidate_objective(
        group,
        &candidate_cameras,
        observations,
        points,
        source,
        options,
    )
}

fn intrinsic_group_candidate_objective(
    group: &[usize],
    candidates: &[OptimizedGcpCamera],
    observations: &[Vec<(usize, ImageCoordinate, f64, bool)>],
    points: &[BundlePoint],
    source: &GcpCameraModel,
    options: GcpSolverOptions,
) -> f64 {
    let reprojection = group
        .iter()
        .zip(candidates)
        .map(|(camera_index, camera)| {
            camera_objective(camera, &observations[*camera_index], points, None, options)
        })
        .sum::<f64>();
    let (parameters, stddev) = match source.intrinsics_policy {
        GcpIntrinsicsPolicy::Auto => (
            GcpIntrinsicParameterMask::all(),
            Some(default_intrinsic_prior(source)),
        ),
        GcpIntrinsicsPolicy::Prior { parameters, stddev } => (parameters, Some(stddev)),
        GcpIntrinsicsPolicy::Fixed | GcpIntrinsicsPolicy::Custom { .. } => {
            (GcpIntrinsicParameterMask::none(), None)
        }
    };
    let Some(stddev) = stddev else {
        return reprojection;
    };
    let camera = &candidates[0];
    let residuals = [
        (camera.focal_x_pixels / source.focal_x_pixels).ln(),
        camera.principal_x_pixels - source.principal_x_pixels,
        camera.principal_y_pixels - source.principal_y_pixels,
        camera.radial_distortion[0] - source.radial_distortion[0],
        camera.radial_distortion[1] - source.radial_distortion[1],
        camera.radial_distortion[2] - source.radial_distortion[2],
        camera.tangential_distortion[0] - source.tangential_distortion[0],
        camera.tangential_distortion[1] - source.tangential_distortion[1],
    ];
    let sigmas = stddev.values();
    reprojection
        + residuals
            .iter()
            .enumerate()
            .filter(|(index, _)| parameters.enabled(*index))
            .map(|(index, value)| 0.5 * (value / sigmas[index]).powi(2))
            .sum::<f64>()
}

fn refine_bundle_point(
    point_index: usize,
    cameras: &[OptimizedGcpCamera],
    points: &mut [BundlePoint],
    options: GcpSolverOptions,
    hold_controls: bool,
) -> f64 {
    let point = &points[point_index];
    if hold_controls && point.survey.is_some() {
        return 0.0;
    }
    if point.observations.len() < 2 && point.survey.is_none() {
        return 0.0;
    }
    let mut normal = [[0.0; 3]; 3];
    let mut gradient = [0.0; 3];
    for observation in &point.observations {
        let camera = &cameras[observation.camera_index];
        let Ok(projected) = project_world(camera, point.world) else {
            continue;
        };
        let residual = [
            projected.x_pixels - observation.measured.x_pixels,
            projected.y_pixels - observation.measured.y_pixels,
        ];
        let sigma = observation.sigma_pixels;
        let normalized = residual[0].hypot(residual[1]) / sigma;
        let weight = robust_weight(
            observation_loss(options.robust_loss, observation.is_gcp_marker),
            normalized,
        ) / sigma.powi(2);
        let jacobian = numeric_point_jacobian(camera, point.world, projected);
        accumulate_2d_normal(&mut normal, &mut gradient, jacobian, residual, weight);
    }
    if let Some(survey) = &point.survey {
        accumulate_survey_prior(
            &mut normal,
            &mut gradient,
            point.world,
            survey,
            bundle_survey_loss(options.robust_loss),
        );
    }
    damp_diagonal(&mut normal, 1.0e-5);
    let Some(delta) = solve_linear(normal, gradient.map(|value| -value)) else {
        return 0.0;
    };
    let old_cost = point_objective(cameras, point, options);
    for divisor in [1.0, 2.0, 4.0, 8.0, 16.0, 32.0] {
        let step = scale3(delta, 1.0 / divisor);
        let candidate = add3(point.world, step);
        let mut candidate_point = point.clone();
        candidate_point.world = candidate;
        if point_objective(cameras, &candidate_point, options) <= old_cost {
            points[point_index].world = candidate;
            return norm3(step);
        }
    }
    0.0
}

fn refine_bundle_camera(
    camera_index: usize,
    observations: &[(usize, ImageCoordinate, f64, bool)],
    cameras: &mut [OptimizedGcpCamera],
    points: &[BundlePoint],
    reference_prior: Option<CameraReferencePrior>,
    options: GcpSolverOptions,
    fix_center: bool,
) -> f64 {
    if observations.len() < 3 {
        return 0.0;
    }
    let camera = &cameras[camera_index];
    let mut normal = [[0.0; 6]; 6];
    let mut gradient = [0.0; 6];
    for (point_index, measured, sigma_pixels, is_gcp_marker) in observations {
        let point = points[*point_index].world;
        let Ok(projected) = project_world(camera, point) else {
            continue;
        };
        let residual = [
            projected.x_pixels - measured.x_pixels,
            projected.y_pixels - measured.y_pixels,
        ];
        let normalized = residual[0].hypot(residual[1]) / sigma_pixels;
        let weight = robust_weight(
            observation_loss(options.robust_loss, *is_gcp_marker),
            normalized,
        ) / sigma_pixels.powi(2);
        let mut jacobian = numeric_camera_jacobian(camera, point, projected);
        // The second camera center fixes the reconstruction baseline and scale.
        if fix_center {
            for row in &mut jacobian {
                row[..3].fill(0.0);
            }
        }
        accumulate_2d_normal(&mut normal, &mut gradient, jacobian, residual, weight);
    }
    if let Some(prior) = reference_prior {
        for axis in 0..3 {
            let sigma = prior.stddev_meters[axis].max(MIN_SIGMA_METERS);
            let residual = camera.center_world_meters[axis] - prior.center_world_meters[axis];
            let weight = robust_weight(options.robust_loss, residual.abs() / sigma) / sigma.powi(2);
            normal[axis][axis] += weight;
            gradient[axis] += weight * residual;
        }
    }
    damp_diagonal(&mut normal, 1.0e-5);
    if fix_center {
        for (axis, row) in normal.iter_mut().enumerate().take(3) {
            row[axis] += 1.0;
        }
    }
    let Some(delta) = solve_linear(normal, gradient.map(|value| -value)) else {
        return 0.0;
    };
    let old_cost = camera_objective(camera, observations, points, reference_prior, options);
    for divisor in [1.0, 2.0, 4.0, 8.0, 16.0, 32.0] {
        let step = delta.map(|value| value / divisor);
        let candidate = perturb_camera(camera, step);
        if camera_objective(&candidate, observations, points, reference_prior, options) <= old_cost
        {
            cameras[camera_index] = candidate;
            return step.iter().map(|value| value * value).sum::<f64>().sqrt();
        }
    }
    0.0
}

fn numeric_point_jacobian(
    camera: &OptimizedGcpCamera,
    point: [f64; 3],
    baseline: ImageCoordinate,
) -> [[f64; 3]; 2] {
    let epsilon = 1.0e-5;
    let mut result = [[0.0; 3]; 2];
    for axis in 0..3 {
        let mut candidate = point;
        candidate[axis] += epsilon;
        if let Ok(projected) = project_world(camera, candidate) {
            result[0][axis] = (projected.x_pixels - baseline.x_pixels) / epsilon;
            result[1][axis] = (projected.y_pixels - baseline.y_pixels) / epsilon;
        }
    }
    result
}

fn numeric_camera_jacobian(
    camera: &OptimizedGcpCamera,
    point: [f64; 3],
    baseline: ImageCoordinate,
) -> [[f64; 6]; 2] {
    let mut result = [[0.0; 6]; 2];
    for parameter in 0..6 {
        let epsilon = if parameter < 3 { 1.0e-5 } else { 1.0e-7 };
        let mut delta = [0.0; 6];
        delta[parameter] = epsilon;
        if let Ok(projected) = project_world(&perturb_camera(camera, delta), point) {
            result[0][parameter] = (projected.x_pixels - baseline.x_pixels) / epsilon;
            result[1][parameter] = (projected.y_pixels - baseline.y_pixels) / epsilon;
        }
    }
    result
}

fn perturb_camera(camera: &OptimizedGcpCamera, delta: [f64; 6]) -> OptimizedGcpCamera {
    let mut result = camera.clone();
    result.center_world_meters = add3(result.center_world_meters, [delta[0], delta[1], delta[2]]);
    result.camera_to_world_rotation = mat3_mul(
        rotation_exp([delta[3], delta[4], delta[5]]),
        result.camera_to_world_rotation,
    );
    result
}

fn accumulate_2d_normal<const N: usize>(
    normal: &mut [[f64; N]; N],
    gradient: &mut [f64; N],
    jacobian: [[f64; N]; 2],
    residual: [f64; 2],
    weight: f64,
) {
    for sample in 0..2 {
        for row in 0..N {
            gradient[row] += weight * jacobian[sample][row] * residual[sample];
            for column in 0..N {
                normal[row][column] += weight * jacobian[sample][row] * jacobian[sample][column];
            }
        }
    }
}

fn accumulate_survey_prior(
    normal: &mut [[f64; 3]; 3],
    gradient: &mut [f64; 3],
    world: [f64; 3],
    survey: &GcpPoint,
    loss: GcpRobustLoss,
) {
    let target = [
        survey.coordinate.east_meters,
        survey.coordinate.north_meters,
        survey.coordinate.height_meters,
    ];
    let sigma_xy = survey
        .uncertainty
        .horizontal_stddev_meters
        .max(MIN_SIGMA_METERS);
    let sigma_z = survey
        .uncertainty
        .height_stddev_meters
        .max(MIN_SIGMA_METERS);
    let residual = sub3(world, target);
    let normalized = {
        let mut sum = 0.0;
        if survey.role.uses_xy() {
            sum += (residual[0] / sigma_xy).powi(2) + (residual[1] / sigma_xy).powi(2);
        }
        if survey.role.uses_z() {
            sum += (residual[2] / sigma_z).powi(2);
        }
        sum.sqrt()
    };
    let robust = robust_weight(bundle_survey_loss(loss), normalized);
    for axis in 0..3 {
        if (axis < 2 && !survey.role.uses_xy()) || (axis == 2 && !survey.role.uses_z()) {
            continue;
        }
        let sigma = if axis < 2 { sigma_xy } else { sigma_z };
        let weight = robust / sigma.powi(2);
        normal[axis][axis] += weight;
        gradient[axis] += weight * residual[axis];
    }
}

fn point_objective(
    cameras: &[OptimizedGcpCamera],
    point: &BundlePoint,
    options: GcpSolverOptions,
) -> f64 {
    let reprojection = point
        .observations
        .iter()
        .map(|observation| {
            let Ok(projected) = project_world(&cameras[observation.camera_index], point.world)
            else {
                return INVALID_PROJECTION_COST;
            };
            let norm = (projected.x_pixels - observation.measured.x_pixels)
                .hypot(projected.y_pixels - observation.measured.y_pixels)
                / observation.sigma_pixels;
            robust_cost(
                observation_loss(options.robust_loss, observation.is_gcp_marker),
                norm,
            )
        })
        .sum::<f64>();
    reprojection
        + point.survey.as_ref().map_or(0.0, |survey| {
            let pseudo = TriangulatedPoint {
                definition: survey.clone(),
                participation: OptimizationPointParticipation::Control,
                reconstruction: point.reconstruction,
                ray_rms: 0.0,
            };
            robust_cost(
                bundle_survey_loss(options.robust_loss),
                masked_normalized_norm(
                    &pseudo,
                    sub3(
                        point.world,
                        [
                            survey.coordinate.east_meters,
                            survey.coordinate.north_meters,
                            survey.coordinate.height_meters,
                        ],
                    ),
                    survey
                        .uncertainty
                        .horizontal_stddev_meters
                        .max(MIN_SIGMA_METERS),
                    survey
                        .uncertainty
                        .height_stddev_meters
                        .max(MIN_SIGMA_METERS),
                ),
            )
        })
}

fn camera_objective(
    camera: &OptimizedGcpCamera,
    observations: &[(usize, ImageCoordinate, f64, bool)],
    points: &[BundlePoint],
    reference_prior: Option<CameraReferencePrior>,
    options: GcpSolverOptions,
) -> f64 {
    let reprojection = observations
        .iter()
        .map(|(point_index, measured, sigma_pixels, is_gcp_marker)| {
            let Ok(projected) = project_world(camera, points[*point_index].world) else {
                return INVALID_PROJECTION_COST;
            };
            robust_cost(
                observation_loss(options.robust_loss, *is_gcp_marker),
                (projected.x_pixels - measured.x_pixels)
                    .hypot(projected.y_pixels - measured.y_pixels)
                    / sigma_pixels,
            )
        })
        .sum::<f64>();
    reprojection
        + reference_prior.map_or(0.0, |prior| {
            (0..3)
                .map(|axis| {
                    robust_cost(
                        options.robust_loss,
                        (camera.center_world_meters[axis] - prior.center_world_meters[axis])
                            / prior.stddev_meters[axis].max(MIN_SIGMA_METERS),
                    )
                })
                .sum::<f64>()
        })
}

fn bundle_objective(
    cameras: &[OptimizedGcpCamera],
    points: &[BundlePoint],
    camera_priors: &[Option<CameraReferencePrior>],
    options: GcpSolverOptions,
) -> f64 {
    let point_cost = points
        .iter()
        .map(|point| point_objective(cameras, point, options))
        .sum::<f64>();
    point_cost
        + cameras
            .iter()
            .zip(camera_priors)
            .map(|(camera, prior)| camera_objective(camera, &[], points, *prior, options))
            .sum::<f64>()
}

fn damp_diagonal<const N: usize>(normal: &mut [[f64; N]; N], lambda: f64) {
    for (index, row) in normal.iter_mut().enumerate() {
        row[index] += lambda * row[index].abs().max(1.0);
    }
}

fn solve_linear<const N: usize>(mut matrix: [[f64; N]; N], mut rhs: [f64; N]) -> Option<[f64; N]> {
    for pivot in 0..N {
        let best = (pivot..N).max_by(|left, right| {
            matrix[*left][pivot]
                .abs()
                .total_cmp(&matrix[*right][pivot].abs())
        })?;
        if matrix[best][pivot].abs() <= MATRIX_EPSILON {
            return None;
        }
        matrix.swap(pivot, best);
        rhs.swap(pivot, best);
        for row in (pivot + 1)..N {
            let factor = matrix[row][pivot] / matrix[pivot][pivot];
            for column in pivot..N {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    let mut result = [0.0; N];
    for row in (0..N).rev() {
        let tail = ((row + 1)..N)
            .map(|column| matrix[row][column] * result[column])
            .sum::<f64>();
        result[row] = (rhs[row] - tail) / matrix[row][row];
    }
    result
        .iter()
        .all(|value| value.is_finite())
        .then_some(result)
}

fn validate_options(options: GcpSolverOptions) -> Result<(), GcpOptimizationError> {
    if options.maximum_iterations == 0
        || !options.convergence_tolerance.is_finite()
        || options.convergence_tolerance <= 0.0
        || options.maximum_tie_points > 1_000_000
        || !options.reprojection_sigma_pixels.is_finite()
        || options.reprojection_sigma_pixels <= 0.0
        || !options.gcp_reprojection_sigma_pixels.is_finite()
        || options.gcp_reprojection_sigma_pixels <= 0.0
    {
        return Err(GcpOptimizationError::InvalidOptions);
    }
    let scale = match options.robust_loss {
        GcpRobustLoss::Huber { threshold_sigma } => threshold_sigma,
        GcpRobustLoss::Cauchy { scale_sigma } => scale_sigma,
    };
    if !scale.is_finite() || scale <= 0.0 {
        return Err(GcpOptimizationError::InvalidOptions);
    }
    Ok(())
}

fn validate_snapshot(snapshot: &GcpOptimizationSnapshot) -> Result<(), GcpOptimizationError> {
    if snapshot.schema_version != 1
        || (snapshot.points.is_empty() && snapshot.scope.camera_reference_image_ids.len() < 3)
    {
        return Err(GcpOptimizationError::InvalidSnapshot);
    }
    if !snapshot.points.is_empty()
        && !snapshot
            .points
            .iter()
            .any(|point| point.participation == OptimizationPointParticipation::Control)
    {
        return Err(GcpOptimizationError::NoControls);
    }
    Ok(())
}

fn validate_cameras(
    cameras: &[GcpCameraModel],
) -> Result<BTreeMap<ImageId, &GcpCameraModel>, GcpOptimizationError> {
    let mut map = BTreeMap::new();
    let mut groups = BTreeMap::<&str, (u32, u32, GcpIntrinsicsPolicy)>::new();
    for camera in cameras {
        camera.validate()?;
        if camera.calibration_group_id.trim().is_empty() {
            return Err(GcpOptimizationError::InvalidCamera(
                camera.image_id,
                "calibration group id must be explicit and non-empty",
            ));
        }
        if let GcpIntrinsicsPolicy::Prior { stddev, .. } = camera.intrinsics_policy {
            if !stddev.is_valid() {
                return Err(GcpOptimizationError::InvalidCamera(
                    camera.image_id,
                    "intrinsic prior standard deviations must be positive and finite",
                ));
            }
        }
        let signature = (
            camera.width_pixels,
            camera.height_pixels,
            camera.intrinsics_policy,
        );
        if groups
            .insert(&camera.calibration_group_id, signature)
            .is_some_and(|existing| existing != signature)
        {
            return Err(GcpOptimizationError::InvalidCamera(
                camera.image_id,
                "calibration group members must share dimensions and policy",
            ));
        }
        if map.insert(camera.image_id, camera).is_some() {
            return Err(GcpOptimizationError::DuplicateCamera(camera.image_id));
        }
    }
    Ok(map)
}

fn triangulate_observations(
    observations: &[&GcpObservation],
    cameras: &BTreeMap<ImageId, &GcpCameraModel>,
) -> Result<([f64; 3], f64), GcpOptimizationError> {
    let mut rays = Vec::new();
    for observation in observations {
        let Some(coordinate) = usable_coordinate(&observation.state) else {
            continue;
        };
        let camera = cameras
            .get(&observation.image_id)
            .ok_or(GcpOptimizationError::MissingCamera(observation.image_id))?;
        rays.push((
            camera.center_reconstruction,
            camera_ray(camera, coordinate)?,
        ));
    }
    if rays.len() < 2 {
        return Err(GcpOptimizationError::TooFewUsableRays(
            observations
                .first()
                .map_or_else(|| GcpPointId(String::new()), |value| value.point_id.clone()),
        ));
    }
    // Solving the ray normal equations directly in a projected CRS (E/N in
    // the millions of metres) loses the small baseline/depth terms to
    // cancellation. Rebase the centres near the cameras, solve there, then
    // restore the frozen world frame. The projection matrix is translation
    // invariant, so this changes only numerical conditioning.
    let ray_count = u32::try_from(rays.len()).unwrap_or(u32::MAX);
    let local_origin = scale3(
        rays.iter()
            .fold([0.0; 3], |sum, (center, _)| add3(sum, *center)),
        1.0 / f64::from(ray_count),
    );
    let mut matrix = [[0.0; 3]; 3];
    let mut rhs = [0.0; 3];
    for (center, direction) in &rays {
        let local_center = sub3(*center, local_origin);
        let projection = [
            [
                1.0 - direction[0] * direction[0],
                -direction[0] * direction[1],
                -direction[0] * direction[2],
            ],
            [
                -direction[1] * direction[0],
                1.0 - direction[1] * direction[1],
                -direction[1] * direction[2],
            ],
            [
                -direction[2] * direction[0],
                -direction[2] * direction[1],
                1.0 - direction[2] * direction[2],
            ],
        ];
        for row in 0..3 {
            rhs[row] += dot3(projection[row], local_center);
            for column in 0..3 {
                matrix[row][column] += projection[row][column];
            }
        }
    }
    let local_point = solve_3(matrix, rhs).ok_or(GcpOptimizationError::DegenerateRays)?;
    let point = add3(local_point, local_origin);
    let ray_sum = rays
        .iter()
        .map(|(center, direction)| {
            let offset = sub3(point, *center);
            let perpendicular = sub3(offset, scale3(*direction, dot3(offset, *direction)));
            dot3(perpendicular, perpendicular)
        })
        .sum::<f64>();
    Ok((point, (ray_sum / f64::from(ray_count)).sqrt()))
}

fn usable_coordinate(state: &GcpObservationState) -> Option<ImageCoordinate> {
    match state {
        GcpObservationState::Manual { coordinate }
        | GcpObservationState::Automatic { coordinate, .. } => Some(*coordinate),
        GcpObservationState::Predicted { .. } | GcpObservationState::Blocked { .. } => None,
    }
}

fn camera_ray(
    camera: &GcpCameraModel,
    coordinate: ImageCoordinate,
) -> Result<[f64; 3], GcpOptimizationError> {
    if !coordinate.x_pixels.is_finite() || !coordinate.y_pixels.is_finite() {
        return Err(GcpOptimizationError::InvalidObservationCoordinate);
    }
    let distorted = [
        (coordinate.x_pixels - camera.principal_x_pixels) / camera.focal_x_pixels,
        (coordinate.y_pixels - camera.principal_y_pixels) / camera.focal_y_pixels,
    ];
    let undistorted = undistort(
        distorted,
        camera.radial_distortion,
        camera.tangential_distortion,
    )?;
    let camera_direction = normalize3([undistorted[0], undistorted[1], 1.0])
        .ok_or(GcpOptimizationError::InvalidObservationCoordinate)?;
    Ok(normalize3(mat3_vec(
        camera.camera_to_reconstruction_rotation,
        camera_direction,
    ))
    .expect("rotation preserves non-zero vectors"))
}

fn undistort(
    distorted: [f64; 2],
    radial: [f64; 3],
    tangential: [f64; 2],
) -> Result<[f64; 2], GcpOptimizationError> {
    let mut point = distorted;
    for _ in 0..12 {
        let projected = distort(point, radial, tangential);
        let correction = [distorted[0] - projected[0], distorted[1] - projected[1]];
        point[0] += correction[0];
        point[1] += correction[1];
        if correction[0].hypot(correction[1]) < 1.0e-13 {
            break;
        }
    }
    if point.iter().all(|value| value.is_finite()) {
        Ok(point)
    } else {
        Err(GcpOptimizationError::DistortionDiverged)
    }
}

fn distort(point: [f64; 2], radial: [f64; 3], tangential: [f64; 2]) -> [f64; 2] {
    let radius2 = point[0] * point[0] + point[1] * point[1];
    let radial_scale =
        1.0 + radial[0] * radius2 + radial[1] * radius2.powi(2) + radial[2] * radius2.powi(3);
    [
        point[0] * radial_scale
            + 2.0 * tangential[0] * point[0] * point[1]
            + tangential[1] * (radius2 + 2.0 * point[0] * point[0]),
        point[1] * radial_scale
            + tangential[0] * (radius2 + 2.0 * point[1] * point[1])
            + 2.0 * tangential[1] * point[0] * point[1],
    ]
}

#[cfg(test)]
fn project_reconstruction(
    camera: &GcpCameraModel,
    point: [f64; 3],
) -> Result<ImageCoordinate, GcpOptimizationError> {
    let camera_point = mat3_transpose_vec(
        camera.camera_to_reconstruction_rotation,
        sub3(point, camera.center_reconstruction),
    );
    project_camera_coordinate(
        camera_point,
        camera.focal_x_pixels,
        camera.focal_y_pixels,
        camera.principal_x_pixels,
        camera.principal_y_pixels,
        camera.radial_distortion,
        camera.tangential_distortion,
    )
}

fn project_world(
    camera: &OptimizedGcpCamera,
    point: [f64; 3],
) -> Result<ImageCoordinate, GcpOptimizationError> {
    let camera_point = mat3_transpose_vec(
        camera.camera_to_world_rotation,
        sub3(point, camera.center_world_meters),
    );
    project_camera_coordinate(
        camera_point,
        camera.focal_x_pixels,
        camera.focal_y_pixels,
        camera.principal_x_pixels,
        camera.principal_y_pixels,
        camera.radial_distortion,
        camera.tangential_distortion,
    )
}

#[allow(clippy::too_many_arguments)]
fn project_camera_coordinate(
    point: [f64; 3],
    focal_x: f64,
    focal_y: f64,
    principal_x: f64,
    principal_y: f64,
    radial: [f64; 3],
    tangential: [f64; 2],
) -> Result<ImageCoordinate, GcpOptimizationError> {
    if point[2] <= MIN_DEPTH {
        return Err(GcpOptimizationError::PointBehindCamera);
    }
    let undistorted = [point[0] / point[2], point[1] / point[2]];
    if !distortion_is_invertible_at(undistorted, radial, tangential) {
        return Err(GcpOptimizationError::InvalidObservationCoordinate);
    }
    let normalized = distort(undistorted, radial, tangential);
    Ok(ImageCoordinate {
        x_pixels: focal_x * normalized[0] + principal_x,
        y_pixels: focal_y * normalized[1] + principal_y,
    })
}

fn distortion_is_invertible_at(point: [f64; 2], radial: [f64; 3], tangential: [f64; 2]) -> bool {
    let [x, y] = point;
    let radius2 = x * x + y * y;
    let radius4 = radius2 * radius2;
    let radius6 = radius4 * radius2;
    let radial_scale = 1.0 + radial[0] * radius2 + radial[1] * radius4 + radial[2] * radius6;
    let radial_derivative =
        1.0 + 3.0 * radial[0] * radius2 + 5.0 * radial[1] * radius4 + 7.0 * radial[2] * radius6;
    if !radial_scale.is_finite() || radial_scale <= 0.0 || radial_derivative <= 0.0 {
        return false;
    }

    let radial_gradient_scale =
        2.0 * (radial[0] + 2.0 * radial[1] * radius2 + 3.0 * radial[2] * radius4);
    let radial_x = x * radial_gradient_scale;
    let radial_y = y * radial_gradient_scale;
    let [p1, p2] = tangential;
    let dx_dx = radial_scale + x * radial_x + 2.0 * p1 * y + 6.0 * p2 * x;
    let dx_dy = x * radial_y + 2.0 * p1 * x + 2.0 * p2 * y;
    let dy_dx = y * radial_x + 2.0 * p1 * x + 2.0 * p2 * y;
    let dy_dy = radial_scale + y * radial_y + 6.0 * p1 * y + 2.0 * p2 * x;
    let determinant = dx_dx * dy_dy - dx_dy * dy_dx;
    determinant.is_finite() && determinant > 1.0e-8
}

fn effective_mode(
    requested: GcpTransformMode,
    controls: &[&TriangulatedPoint],
) -> Result<GcpTransformMode, GcpOptimizationError> {
    let spatial = controls
        .iter()
        .filter(|point| point.definition.role.uses_xy() && point.definition.role.uses_z())
        .count();
    match requested {
        GcpTransformMode::Similarity7 if spatial < 3 => {
            Err(GcpOptimizationError::SimilarityNeedsThreeSpatialControls)
        }
        GcpTransformMode::Auto if spatial < 3 => Ok(GcpTransformMode::TranslationOnly),
        GcpTransformMode::Auto => Ok(GcpTransformMode::Similarity7),
        value => Ok(value),
    }
}

fn active_parameters(mode: GcpTransformMode, controls: &[&TriangulatedPoint]) -> [bool; 7] {
    if mode == GcpTransformMode::Similarity7 {
        return [true; 7];
    }
    let xy = controls.iter().any(|point| point.definition.role.uses_xy());
    let z = controls.iter().any(|point| point.definition.role.uses_z());
    [xy, xy, z, false, false, false, false]
}

fn initial_camera_reference_transform(
    cameras: &[GcpCameraModel],
    selected_camera_ids: &[ImageId],
    loss: GcpRobustLoss,
) -> Result<GcpSimilarityTransform, GcpOptimizationError> {
    let selected = selected_camera_ids.iter().copied().collect::<BTreeSet<_>>();
    let pairs = cameras
        .iter()
        .filter(|camera| selected.contains(&camera.image_id))
        .filter_map(|camera| {
            Some(CameraReferencePair {
                center_reconstruction: camera.center_reconstruction,
                center_world_meters: camera.reference_center_world_meters?,
                stddev_meters: camera.reference_stddev_meters?,
            })
        })
        .collect::<Vec<_>>();
    if pairs.len() < 3 {
        return Err(GcpOptimizationError::TooFewCameraReferencePriors);
    }
    if !camera_reference_geometry_is_stable(&pairs) {
        return Err(GcpOptimizationError::DegenerateCameraReferences);
    }

    let mut candidates = Vec::new();
    if let Some(transform) = weighted_camera_similarity(&pairs) {
        candidates.push(transform);
    }
    candidates.push(camera_median_translation(&pairs));

    const MAX_TRIPLE_HYPOTHESES: usize = 256;
    let mut hypotheses = 0_usize;
    'outer: for first in 0..pairs.len() {
        for second in (first + 1)..pairs.len() {
            for third in (second + 1)..pairs.len() {
                if let Some(transform) =
                    weighted_camera_similarity(&[pairs[first], pairs[second], pairs[third]])
                {
                    candidates.push(transform);
                }
                hypotheses += 1;
                if hypotheses >= MAX_TRIPLE_HYPOTHESES {
                    break 'outer;
                }
            }
        }
    }

    candidates
        .into_iter()
        .min_by(|left, right| {
            camera_reference_initializer_objective(&pairs, *left, loss).total_cmp(
                &camera_reference_initializer_objective(&pairs, *right, loss),
            )
        })
        .ok_or(GcpOptimizationError::DegenerateCameraReferences)
}

fn camera_reference_geometry_is_stable(pairs: &[CameraReferencePair]) -> bool {
    for first in 0..pairs.len() {
        for second in (first + 1)..pairs.len() {
            for third in (second + 1)..pairs.len() {
                let source_first = sub3(
                    pairs[second].center_reconstruction,
                    pairs[first].center_reconstruction,
                );
                let source_second = sub3(
                    pairs[third].center_reconstruction,
                    pairs[first].center_reconstruction,
                );
                let target_first = sub3(
                    pairs[second].center_world_meters,
                    pairs[first].center_world_meters,
                );
                let target_second = sub3(
                    pairs[third].center_world_meters,
                    pairs[first].center_world_meters,
                );
                let source_scale = norm3(source_first).max(norm3(source_second)).powi(2);
                let target_scale = norm3(target_first).max(norm3(target_second)).powi(2);
                if source_scale > MATRIX_EPSILON
                    && target_scale > MATRIX_EPSILON
                    && norm3(cross3(source_first, source_second)) > source_scale * 1.0e-6
                    && norm3(cross3(target_first, target_second)) > target_scale * 1.0e-6
                {
                    return true;
                }
            }
        }
    }
    false
}

fn camera_reference_initializer_objective(
    pairs: &[CameraReferencePair],
    transform: GcpSimilarityTransform,
    loss: GcpRobustLoss,
) -> f64 {
    let mut costs = pairs
        .iter()
        .map(|pair| {
            let residual = sub3(
                transform.apply(pair.center_reconstruction),
                pair.center_world_meters,
            );
            let normalized = ((residual[0] / pair.stddev_meters[0]).powi(2)
                + (residual[1] / pair.stddev_meters[1]).powi(2)
                + (residual[2] / pair.stddev_meters[2]).powi(2))
            .sqrt();
            robust_cost(loss, normalized)
        })
        .collect::<Vec<_>>();
    costs.sort_by(f64::total_cmp);
    let retained = if costs.len() < 4 {
        costs.len()
    } else {
        costs.len() - (costs.len() / 5).max(1)
    };
    costs.into_iter().take(retained).sum()
}

fn camera_median_translation(pairs: &[CameraReferencePair]) -> GcpSimilarityTransform {
    let mut deltas = [Vec::new(), Vec::new(), Vec::new()];
    for pair in pairs {
        for (axis, axis_deltas) in deltas.iter_mut().enumerate() {
            axis_deltas.push(pair.center_world_meters[axis] - pair.center_reconstruction[axis]);
        }
    }
    let mut translation = [0.0; 3];
    for (axis, values) in deltas.iter_mut().enumerate() {
        values.sort_by(f64::total_cmp);
        translation[axis] = match values.len() {
            0 => 0.0,
            length if length % 2 == 1 => values[length / 2],
            length => (values[length / 2 - 1] + values[length / 2]) * 0.5,
        };
    }
    GcpSimilarityTransform {
        translation_meters: translation,
        ..GcpSimilarityTransform::identity()
    }
}

fn weighted_camera_similarity(pairs: &[CameraReferencePair]) -> Option<GcpSimilarityTransform> {
    if pairs.len() < 3 {
        return None;
    }
    let weights = pairs
        .iter()
        .map(|pair| {
            let variance = pair
                .stddev_meters
                .iter()
                .map(|sigma| sigma * sigma)
                .sum::<f64>()
                / 3.0;
            1.0 / variance.max(MIN_SIGMA_METERS.powi(2))
        })
        .collect::<Vec<_>>();
    let weight_sum = weights.iter().sum::<f64>();
    if !weight_sum.is_finite() || weight_sum <= MATRIX_EPSILON {
        return None;
    }
    let source_center = scale3(
        pairs
            .iter()
            .zip(&weights)
            .fold([0.0; 3], |sum, (pair, weight)| {
                add3(sum, scale3(pair.center_reconstruction, *weight))
            }),
        1.0 / weight_sum,
    );
    let target_center = scale3(
        pairs
            .iter()
            .zip(&weights)
            .fold([0.0; 3], |sum, (pair, weight)| {
                add3(sum, scale3(pair.center_world_meters, *weight))
            }),
        1.0 / weight_sum,
    );
    let mut covariance = [[0.0; 3]; 3];
    let mut source_energy = 0.0;
    for (pair, weight) in pairs.iter().zip(&weights) {
        let source = sub3(pair.center_reconstruction, source_center);
        let target = sub3(pair.center_world_meters, target_center);
        source_energy += weight * dot3(source, source);
        for (row, source_component) in source.iter().enumerate() {
            for (column, target_component) in target.iter().enumerate() {
                covariance[row][column] += weight * source_component * target_component;
            }
        }
    }
    if source_energy <= MATRIX_EPSILON {
        return None;
    }
    let rotation = horn_rotation(covariance)?;
    let numerator = pairs
        .iter()
        .zip(&weights)
        .map(|(pair, weight)| {
            let source = sub3(pair.center_reconstruction, source_center);
            let target = sub3(pair.center_world_meters, target_center);
            weight * dot3(target, mat3_vec(rotation, source))
        })
        .sum::<f64>();
    let scale = numerator / source_energy;
    if !scale.is_finite() || scale <= MATRIX_EPSILON {
        return None;
    }
    Some(GcpSimilarityTransform {
        scale,
        rotation,
        translation_meters: sub3(
            target_center,
            scale3(mat3_vec(rotation, source_center), scale),
        ),
    })
}

fn initial_transform(
    controls: &[&TriangulatedPoint],
    mode: GcpTransformMode,
    loss: GcpRobustLoss,
) -> GcpSimilarityTransform {
    let spatial = controls
        .iter()
        .filter(|point| point.definition.role.uses_xy() && point.definition.role.uses_z())
        .copied()
        .collect::<Vec<_>>();

    // A sparse reconstruction may already be expressed in project-world
    // coordinates. In that case one inaccurate marker must not rotate and
    // shrink the entire camera rig before the robust optimizer even starts.
    // The component-wise median is a cheap, deterministic translation-only
    // hypothesis and remains valid for mixed XY/Z control roles.
    let translation = median_translation(controls);
    let mut candidates = vec![GcpSimilarityTransform {
        translation_meters: translation,
        ..GcpSimilarityTransform::identity()
    }];

    if mode == GcpTransformMode::Similarity7 {
        if let Some(transform) = horn_similarity(&spatial) {
            candidates.push(transform);
        }

        // Deterministic RANSAC-style seeds make the seven-parameter start
        // robust without adding work to the frame loop or the iterative
        // solver. GCP sets are normally small; the cap bounds pathological
        // imports while still covering many independent triples.
        const MAX_TRIPLE_HYPOTHESES: usize = 256;
        let mut hypotheses = 0_usize;
        'outer: for first in 0..spatial.len() {
            for second in (first + 1)..spatial.len() {
                for third in (second + 1)..spatial.len() {
                    if let Some(transform) =
                        horn_similarity(&[spatial[first], spatial[second], spatial[third]])
                    {
                        candidates.push(transform);
                    }
                    hypotheses += 1;
                    if hypotheses >= MAX_TRIPLE_HYPOTHESES {
                        break 'outer;
                    }
                }
            }
        }
    }

    candidates
        .into_iter()
        .min_by(|left, right| {
            let left_trimmed = initializer_objective(controls, *left, loss);
            let right_trimmed = initializer_objective(controls, *right, loss);
            left_trimmed.total_cmp(&right_trimmed).then_with(|| {
                objective(controls, *left, loss).total_cmp(&objective(controls, *right, loss))
            })
        })
        .unwrap_or_else(GcpSimilarityTransform::identity)
}

fn initializer_objective(
    controls: &[&TriangulatedPoint],
    transform: GcpSimilarityTransform,
    loss: GcpRobustLoss,
) -> f64 {
    let mut costs = controls
        .iter()
        .map(|point| {
            let mapped = transform.apply(point.reconstruction);
            let target = [
                point.definition.coordinate.east_meters,
                point.definition.coordinate.north_meters,
                point.definition.coordinate.height_meters,
            ];
            let normalized = masked_normalized_norm(
                point,
                sub3(mapped, target),
                point
                    .definition
                    .uncertainty
                    .horizontal_stddev_meters
                    .max(MIN_SIGMA_METERS),
                point
                    .definition
                    .uncertainty
                    .height_stddev_meters
                    .max(MIN_SIGMA_METERS),
            );
            robust_cost(survey_loss(loss), normalized)
        })
        .collect::<Vec<_>>();
    costs.sort_by(f64::total_cmp);

    // Trim at most the worst fifth, but always retain every point when only
    // the minimum three spatial controls are available.
    let retained = if costs.len() < 4 {
        costs.len()
    } else {
        costs.len() - (costs.len() / 5).max(1)
    };
    costs.into_iter().take(retained).sum()
}

fn median_translation(controls: &[&TriangulatedPoint]) -> [f64; 3] {
    let mut deltas = [Vec::new(), Vec::new(), Vec::new()];
    for control in controls {
        if control.definition.role.uses_xy() {
            deltas[0].push(control.definition.coordinate.east_meters - control.reconstruction[0]);
            deltas[1].push(control.definition.coordinate.north_meters - control.reconstruction[1]);
        }
        if control.definition.role.uses_z() {
            deltas[2].push(control.definition.coordinate.height_meters - control.reconstruction[2]);
        }
    }

    let mut translation = [0.0; 3];
    for (axis, values) in deltas.iter_mut().enumerate() {
        values.sort_by(f64::total_cmp);
        translation[axis] = match values.len() {
            0 => 0.0,
            length if length % 2 == 1 => values[length / 2],
            length => (values[length / 2 - 1] + values[length / 2]) * 0.5,
        };
    }
    translation
}

fn horn_similarity(points: &[&TriangulatedPoint]) -> Option<GcpSimilarityTransform> {
    if points.len() < 3 {
        return None;
    }
    let count = f64::from(u32::try_from(points.len()).unwrap_or(u32::MAX));
    let source_center = scale3(
        points
            .iter()
            .fold([0.0; 3], |sum, point| add3(sum, point.reconstruction)),
        1.0 / count,
    );
    let target_center = scale3(
        points.iter().fold([0.0; 3], |sum, point| {
            add3(
                sum,
                [
                    point.definition.coordinate.east_meters,
                    point.definition.coordinate.north_meters,
                    point.definition.coordinate.height_meters,
                ],
            )
        }),
        1.0 / count,
    );
    let mut covariance = [[0.0; 3]; 3];
    let mut source_energy = 0.0;
    for point in points {
        let source = sub3(point.reconstruction, source_center);
        let target = sub3(
            [
                point.definition.coordinate.east_meters,
                point.definition.coordinate.north_meters,
                point.definition.coordinate.height_meters,
            ],
            target_center,
        );
        source_energy += dot3(source, source);
        for (row, source_component) in source.iter().enumerate() {
            for (column, target_component) in target.iter().enumerate() {
                covariance[row][column] += source_component * target_component;
            }
        }
    }
    if source_energy <= MATRIX_EPSILON {
        return None;
    }
    let rotation = horn_rotation(covariance)?;
    let numerator = points
        .iter()
        .map(|point| {
            let source = sub3(point.reconstruction, source_center);
            let target = sub3(
                [
                    point.definition.coordinate.east_meters,
                    point.definition.coordinate.north_meters,
                    point.definition.coordinate.height_meters,
                ],
                target_center,
            );
            dot3(target, mat3_vec(rotation, source))
        })
        .sum::<f64>();
    let scale = numerator / source_energy;
    if !scale.is_finite() || scale <= MATRIX_EPSILON {
        return None;
    }
    Some(GcpSimilarityTransform {
        scale,
        rotation,
        translation_meters: sub3(
            target_center,
            scale3(mat3_vec(rotation, source_center), scale),
        ),
    })
}

fn horn_rotation(s: [[f64; 3]; 3]) -> Option<[f64; 9]> {
    let trace = s[0][0] + s[1][1] + s[2][2];
    let n = [
        [
            trace,
            s[1][2] - s[2][1],
            s[2][0] - s[0][2],
            s[0][1] - s[1][0],
        ],
        [
            s[1][2] - s[2][1],
            s[0][0] - s[1][1] - s[2][2],
            s[0][1] + s[1][0],
            s[0][2] + s[2][0],
        ],
        [
            s[2][0] - s[0][2],
            s[0][1] + s[1][0],
            -s[0][0] + s[1][1] - s[2][2],
            s[1][2] + s[2][1],
        ],
        [
            s[0][1] - s[1][0],
            s[0][2] + s[2][0],
            s[1][2] + s[2][1],
            -s[0][0] - s[1][1] + s[2][2],
        ],
    ];
    let shift = n.iter().flatten().map(|value| value.abs()).sum::<f64>() + 1.0;
    let mut quaternion = [1.0, 0.0, 0.0, 0.0];
    for _ in 0..80 {
        let mut next = [0.0; 4];
        for row in 0..4 {
            next[row] = shift * quaternion[row]
                + (0..4)
                    .map(|column| n[row][column] * quaternion[column])
                    .sum::<f64>();
        }
        let norm = next.iter().map(|value| value * value).sum::<f64>().sqrt();
        if norm <= MATRIX_EPSILON {
            return None;
        }
        for value in &mut next {
            *value /= norm;
        }
        quaternion = next;
    }
    Some(quaternion_rotation(quaternion))
}

fn quaternion_rotation(quaternion: [f64; 4]) -> [f64; 9] {
    let scalar = quaternion[0];
    let axis_x = quaternion[1];
    let axis_y = quaternion[2];
    let axis_z = quaternion[3];
    [
        1.0 - 2.0 * (axis_y * axis_y + axis_z * axis_z),
        2.0 * (axis_x * axis_y - axis_z * scalar),
        2.0 * (axis_x * axis_z + axis_y * scalar),
        2.0 * (axis_x * axis_y + axis_z * scalar),
        1.0 - 2.0 * (axis_x * axis_x + axis_z * axis_z),
        2.0 * (axis_y * axis_z - axis_x * scalar),
        2.0 * (axis_x * axis_z - axis_y * scalar),
        2.0 * (axis_y * axis_z + axis_x * scalar),
        1.0 - 2.0 * (axis_x * axis_x + axis_y * axis_y),
    ]
}

fn normal_equations(
    controls: &[&TriangulatedPoint],
    transform: GcpSimilarityTransform,
    loss: GcpRobustLoss,
    active: [bool; 7],
) -> ([[f64; 7]; 7], [f64; 7]) {
    let mut normal = [[0.0; 7]; 7];
    let mut gradient = [0.0; 7];
    for point in controls {
        let rotated_scaled = scale3(
            mat3_vec(transform.rotation, point.reconstruction),
            transform.scale,
        );
        let mapped = add3(rotated_scaled, transform.translation_meters);
        let target = [
            point.definition.coordinate.east_meters,
            point.definition.coordinate.north_meters,
            point.definition.coordinate.height_meters,
        ];
        let residual = sub3(mapped, target);
        let sigma_xy = point
            .definition
            .uncertainty
            .horizontal_stddev_meters
            .max(MIN_SIGMA_METERS);
        let sigma_z = point
            .definition
            .uncertainty
            .height_stddev_meters
            .max(MIN_SIGMA_METERS);
        let normalized_norm = masked_normalized_norm(point, residual, sigma_xy, sigma_z);
        let robust = robust_weight(survey_loss(loss), normalized_norm);
        for axis in 0..3 {
            if (axis < 2 && !point.definition.role.uses_xy())
                || (axis == 2 && !point.definition.role.uses_z())
            {
                continue;
            }
            let sigma = if axis < 2 { sigma_xy } else { sigma_z };
            let weight = robust / (sigma * sigma);
            let mut jacobian = [0.0; 7];
            jacobian[axis] = 1.0;
            let rotation_jacobian = [
                [0.0, rotated_scaled[2], -rotated_scaled[1]],
                [-rotated_scaled[2], 0.0, rotated_scaled[0]],
                [rotated_scaled[1], -rotated_scaled[0], 0.0],
            ];
            jacobian[3] = rotation_jacobian[axis][0];
            jacobian[4] = rotation_jacobian[axis][1];
            jacobian[5] = rotation_jacobian[axis][2];
            jacobian[6] = rotated_scaled[axis];
            for row in 0..7 {
                if !active[row] {
                    continue;
                }
                gradient[row] += weight * jacobian[row] * residual[axis];
                for column in 0..7 {
                    if active[column] {
                        normal[row][column] += weight * jacobian[row] * jacobian[column];
                    }
                }
            }
        }
    }
    (normal, gradient)
}

fn objective(
    controls: &[&TriangulatedPoint],
    transform: GcpSimilarityTransform,
    loss: GcpRobustLoss,
) -> f64 {
    controls
        .iter()
        .map(|point| {
            let mapped = transform.apply(point.reconstruction);
            let target = [
                point.definition.coordinate.east_meters,
                point.definition.coordinate.north_meters,
                point.definition.coordinate.height_meters,
            ];
            let normalized = masked_normalized_norm(
                point,
                sub3(mapped, target),
                point
                    .definition
                    .uncertainty
                    .horizontal_stddev_meters
                    .max(MIN_SIGMA_METERS),
                point
                    .definition
                    .uncertainty
                    .height_stddev_meters
                    .max(MIN_SIGMA_METERS),
            );
            robust_cost(survey_loss(loss), normalized)
        })
        .sum()
}

fn masked_normalized_norm(
    point: &TriangulatedPoint,
    residual: [f64; 3],
    sigma_xy: f64,
    sigma_z: f64,
) -> f64 {
    let mut sum = 0.0;
    if point.definition.role.uses_xy() {
        sum += (residual[0] / sigma_xy).powi(2) + (residual[1] / sigma_xy).powi(2);
    }
    if point.definition.role.uses_z() {
        sum += (residual[2] / sigma_z).powi(2);
    }
    sum.sqrt()
}

fn robust_weight(loss: GcpRobustLoss, norm: f64) -> f64 {
    match loss {
        GcpRobustLoss::Huber { threshold_sigma } => {
            if norm <= threshold_sigma || norm <= MATRIX_EPSILON {
                1.0
            } else {
                threshold_sigma / norm
            }
        }
        GcpRobustLoss::Cauchy { scale_sigma } => 1.0 / (1.0 + (norm / scale_sigma).powi(2)),
    }
}

fn survey_loss(loss: GcpRobustLoss) -> GcpRobustLoss {
    match loss {
        GcpRobustLoss::Huber { threshold_sigma } => GcpRobustLoss::Huber {
            threshold_sigma: threshold_sigma * 10.0,
        },
        GcpRobustLoss::Cauchy { scale_sigma } => GcpRobustLoss::Cauchy {
            scale_sigma: scale_sigma * 10.0,
        },
    }
}

/// Survey coordinates and manually placed image markers are explicit user
/// measurements, not automatically generated feature matches. Keep them
/// influential while the initially unreferenced reconstruction is still far
/// from the survey frame; the enlarged robust transition still limits truly
/// gross input mistakes instead of silently discarding the measurements that
/// are supposed to anchor the bundle.
fn bundle_survey_loss(loss: GcpRobustLoss) -> GcpRobustLoss {
    scale_robust_loss(loss, 200.0)
}

fn observation_loss(loss: GcpRobustLoss, is_gcp_marker: bool) -> GcpRobustLoss {
    if is_gcp_marker {
        scale_robust_loss(loss, 32.0)
    } else {
        loss
    }
}

fn scale_robust_loss(loss: GcpRobustLoss, factor: f64) -> GcpRobustLoss {
    match loss {
        GcpRobustLoss::Huber { threshold_sigma } => GcpRobustLoss::Huber {
            threshold_sigma: threshold_sigma * factor,
        },
        GcpRobustLoss::Cauchy { scale_sigma } => GcpRobustLoss::Cauchy {
            scale_sigma: scale_sigma * factor,
        },
    }
}

fn robust_cost(loss: GcpRobustLoss, norm: f64) -> f64 {
    match loss {
        GcpRobustLoss::Huber { threshold_sigma } if norm > threshold_sigma => {
            threshold_sigma * (norm - 0.5 * threshold_sigma)
        }
        GcpRobustLoss::Huber { .. } => 0.5 * norm * norm,
        GcpRobustLoss::Cauchy { scale_sigma } => {
            0.5 * scale_sigma * scale_sigma * (1.0 + (norm / scale_sigma).powi(2)).ln()
        }
    }
}

fn update_transform(transform: GcpSimilarityTransform, delta: [f64; 7]) -> GcpSimilarityTransform {
    let rotation_update = rotation_exp([delta[3], delta[4], delta[5]]);
    GcpSimilarityTransform {
        scale: transform.scale * delta[6].exp(),
        rotation: mat3_mul(rotation_update, transform.rotation),
        translation_meters: add3(transform.translation_meters, [delta[0], delta[1], delta[2]]),
    }
}

fn rotation_exp(vector: [f64; 3]) -> [f64; 9] {
    let angle = dot3(vector, vector).sqrt();
    if angle < 1.0e-14 {
        return [
            1.0, -vector[2], vector[1], vector[2], 1.0, -vector[0], -vector[1], vector[0], 1.0,
        ];
    }
    let axis = scale3(vector, 1.0 / angle);
    let (sine, cosine) = angle.sin_cos();
    let one_minus_cosine = 1.0 - cosine;
    [
        cosine + axis[0] * axis[0] * one_minus_cosine,
        axis[0] * axis[1] * one_minus_cosine - axis[2] * sine,
        axis[0] * axis[2] * one_minus_cosine + axis[1] * sine,
        axis[1] * axis[0] * one_minus_cosine + axis[2] * sine,
        cosine + axis[1] * axis[1] * one_minus_cosine,
        axis[1] * axis[2] * one_minus_cosine - axis[0] * sine,
        axis[2] * axis[0] * one_minus_cosine - axis[1] * sine,
        axis[2] * axis[1] * one_minus_cosine + axis[0] * sine,
        cosine + axis[2] * axis[2] * one_minus_cosine,
    ]
}

fn transform_camera(
    camera: &GcpCameraModel,
    transform: GcpSimilarityTransform,
) -> OptimizedGcpCamera {
    OptimizedGcpCamera {
        image_id: camera.image_id,
        calibration_group_id: camera.calibration_group_id.clone(),
        width_pixels: camera.width_pixels,
        height_pixels: camera.height_pixels,
        focal_x_pixels: camera.focal_x_pixels,
        focal_y_pixels: camera.focal_y_pixels,
        principal_x_pixels: camera.principal_x_pixels,
        principal_y_pixels: camera.principal_y_pixels,
        radial_distortion: camera.radial_distortion,
        tangential_distortion: camera.tangential_distortion,
        camera_to_world_rotation: mat3_mul(
            transform.rotation,
            camera.camera_to_reconstruction_rotation,
        ),
        center_world_meters: transform.apply(camera.center_reconstruction),
    }
}

fn predicted_projections<F>(
    points: &[&GcpPoint],
    cameras: &[OptimizedGcpCamera],
    progress: &mut F,
) -> Result<Vec<GcpCameraProjection>, GcpOptimizationError>
where
    F: FnMut(GcpOptimizationProgress) -> GcpSolveControl,
{
    let total = points.len().saturating_mul(cameras.len());
    let mut completed = 0_usize;
    let mut result = Vec::new();
    for point in points {
        let world = [
            point.coordinate.east_meters,
            point.coordinate.north_meters,
            point.coordinate.height_meters,
        ];
        for camera in cameras {
            completed += 1;
            if let Ok(coordinate) = project_world(camera, world) {
                if coordinate.x_pixels >= 0.0
                    && coordinate.y_pixels >= 0.0
                    && coordinate.x_pixels < f64::from(camera.width_pixels)
                    && coordinate.y_pixels < f64::from(camera.height_pixels)
                {
                    let jacobian = numeric_point_jacobian(camera, world, coordinate);
                    let horizontal_variance = point.uncertainty.horizontal_stddev_meters.powi(2);
                    let vertical_variance = point.uncertainty.height_stddev_meters.powi(2);
                    let covariance_world = [
                        [horizontal_variance, 0.0, 0.0],
                        [0.0, horizontal_variance, 0.0],
                        [0.0, 0.0, vertical_variance],
                    ];
                    let covariance_pixels = propagate_point_covariance(jacobian, covariance_world);
                    result.push(GcpCameraProjection {
                        point_id: point.id.clone(),
                        image_id: camera.image_id,
                        coordinate,
                        uncertainty: covariance_ellipse(covariance_pixels)?,
                    });
                }
            }
            check_progress(
                progress,
                GcpOptimizationProgress {
                    phase: GcpOptimizationPhase::Projections,
                    completed_units: saturating_u32(completed),
                    total_units: saturating_u32(total),
                    iteration: None,
                    objective: None,
                },
            )?;
        }
    }
    result.sort_by(|left, right| {
        left.point_id
            .cmp(&right.point_id)
            .then_with(|| left.image_id.cmp(&right.image_id))
    });
    Ok(result)
}

fn propagate_point_covariance(
    jacobian: [[f64; 3]; 2],
    covariance_world: [[f64; 3]; 3],
) -> [[f64; 2]; 2] {
    let mut result = [[0.0; 2]; 2];
    for row in 0..2 {
        for column in 0..2 {
            for (left, covariance_row) in covariance_world.iter().enumerate() {
                for (right, covariance_value) in covariance_row.iter().enumerate() {
                    result[row][column] +=
                        jacobian[row][left] * covariance_value * jacobian[column][right];
                }
            }
        }
    }
    result
}

fn covariance_ellipse(
    covariance: [[f64; 2]; 2],
) -> Result<ProjectionUncertaintyEllipse, GcpOptimizationError> {
    let xx = covariance[0][0].max(0.0);
    let yy = covariance[1][1].max(0.0);
    let xy = 0.5 * (covariance[0][1] + covariance[1][0]);
    let half_trace = 0.5 * (xx + yy);
    let radius = (0.25 * (xx - yy).powi(2) + xy * xy).max(0.0).sqrt();
    let major = (half_trace + radius).max(0.0).sqrt();
    let minor = (half_trace - radius).max(0.0).sqrt();
    let angle = 0.5 * (2.0 * xy).atan2(xx - yy).to_degrees();
    if [major, minor, angle].iter().all(|value| value.is_finite()) {
        Ok(ProjectionUncertaintyEllipse {
            semi_major_pixels: major,
            semi_minor_pixels: minor,
            angle_degrees: angle,
        })
    } else {
        Err(GcpOptimizationError::InvalidProjectionUncertainty)
    }
}

fn check_progress<F>(
    progress: &mut F,
    value: GcpOptimizationProgress,
) -> Result<(), GcpOptimizationError>
where
    F: FnMut(GcpOptimizationProgress) -> GcpSolveControl,
{
    if progress(value) == GcpSolveControl::Cancel {
        Err(GcpOptimizationError::Cancelled)
    } else {
        Ok(())
    }
}

fn solve_3(mut matrix: [[f64; 3]; 3], mut rhs: [f64; 3]) -> Option<[f64; 3]> {
    for pivot in 0..3 {
        let best = (pivot..3).max_by(|left, right| {
            matrix[*left][pivot]
                .abs()
                .total_cmp(&matrix[*right][pivot].abs())
        })?;
        if matrix[best][pivot].abs() <= MATRIX_EPSILON {
            return None;
        }
        matrix.swap(pivot, best);
        rhs.swap(pivot, best);
        for row in (pivot + 1)..3 {
            let factor = matrix[row][pivot] / matrix[pivot][pivot];
            for column in pivot..3 {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    let mut result = [0.0; 3];
    for row in (0..3).rev() {
        let tail = ((row + 1)..3)
            .map(|column| matrix[row][column] * result[column])
            .sum::<f64>();
        result[row] = (rhs[row] - tail) / matrix[row][row];
    }
    Some(result)
}

fn solve_7(mut matrix: [[f64; 7]; 7], mut rhs: [f64; 7]) -> Result<[f64; 7], GcpOptimizationError> {
    for pivot in 0..7 {
        let best = (pivot..7)
            .max_by(|left, right| {
                matrix[*left][pivot]
                    .abs()
                    .total_cmp(&matrix[*right][pivot].abs())
            })
            .expect("non-empty pivot range");
        if matrix[best][pivot].abs() <= MATRIX_EPSILON {
            return Err(GcpOptimizationError::SingularAdjustment);
        }
        matrix.swap(pivot, best);
        rhs.swap(pivot, best);
        for row in (pivot + 1)..7 {
            let factor = matrix[row][pivot] / matrix[pivot][pivot];
            for column in pivot..7 {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    let mut result = [0.0; 7];
    for row in (0..7).rev() {
        let tail = ((row + 1)..7)
            .map(|column| matrix[row][column] * result[column])
            .sum::<f64>();
        result[row] = (rhs[row] - tail) / matrix[row][row];
    }
    Ok(result)
}

fn is_rotation(rotation: [f64; 9]) -> bool {
    let rows = [
        [rotation[0], rotation[1], rotation[2]],
        [rotation[3], rotation[4], rotation[5]],
        [rotation[6], rotation[7], rotation[8]],
    ];
    let orthonormal = rows
        .iter()
        .all(|row| (dot3(*row, *row) - 1.0).abs() <= 1.0e-6)
        && dot3(rows[0], rows[1]).abs() <= 1.0e-6
        && dot3(rows[0], rows[2]).abs() <= 1.0e-6
        && dot3(rows[1], rows[2]).abs() <= 1.0e-6;
    orthonormal && determinant(rotation) > 0.0
}

fn determinant(m: [f64; 9]) -> f64 {
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6])
}

fn mat3_vec(m: [f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

fn mat3_transpose_vec(m: [f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
        m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
        m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
    ]
}

fn mat3_mul(left: [f64; 9], right: [f64; 9]) -> [f64; 9] {
    let mut result = [0.0; 9];
    for row in 0..3 {
        for column in 0..3 {
            result[row * 3 + column] = (0..3)
                .map(|inner| left[row * 3 + inner] * right[inner * 3 + column])
                .sum();
        }
    }
    result
}

fn dot3(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross3(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

fn norm3(value: [f64; 3]) -> f64 {
    dot3(value, value).sqrt()
}

fn normalize3(value: [f64; 3]) -> Option<[f64; 3]> {
    let norm = norm3(value);
    (norm > MATRIX_EPSILON).then(|| scale3(value, 1.0 / norm))
}

fn add3(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

fn sub3(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

fn scale3(value: [f64; 3], scale: f64) -> [f64; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn vector_norm_7(value: [f64; 7]) -> f64 {
    value
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Projection or robust-adjustment failure.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum GcpOptimizationError {
    #[error("GCP optimization was cancelled")]
    Cancelled,
    #[error("invalid GCP optimization options")]
    InvalidOptions,
    #[error("invalid or unsupported GCP optimization snapshot")]
    InvalidSnapshot,
    #[error("optimization scope contains no control points")]
    NoControls,
    #[error("invalid camera {0:?}: {1}")]
    InvalidCamera(ImageId, &'static str),
    #[error("duplicate camera {0:?}")]
    DuplicateCamera(ImageId),
    #[error("observation references missing camera {0:?}")]
    MissingCamera(ImageId),
    #[error("GCP {0:?} has fewer than two usable camera rays")]
    TooFewUsableRays(GcpPointId),
    #[error("camera rays do not define a stable 3D intersection")]
    DegenerateRays,
    #[error("invalid image observation coordinate")]
    InvalidObservationCoordinate,
    #[error("inverse lens distortion did not converge")]
    DistortionDiverged,
    #[error("point lies behind a camera")]
    PointBehindCamera,
    #[error("projected point covariance is invalid")]
    InvalidProjectionUncertainty,
    #[error("full similarity adjustment needs at least three XYZ controls")]
    SimilarityNeedsThreeSpatialControls,
    #[error("camera-reference-only adjustment needs at least three usable camera priors")]
    TooFewCameraReferencePriors,
    #[error("camera reference positions do not define a stable similarity")]
    DegenerateCameraReferences,
    #[error("GCP normal equations are singular")]
    SingularAdjustment,
    #[error("sparse tie point {0} is invalid")]
    InvalidBundleTiePoint(u64),
    #[error("bundle adjustment has no cameras or points")]
    EmptyBundleAdjustment,
    #[error("tie-point propagation requires a manual seed observation")]
    TiePointSeedMustBeManual,
    #[error("tie-point snap threshold must be positive and finite")]
    InvalidTiePointThreshold,
    #[error("tie-point track {0} is invalid")]
    InvalidTiePointTrack(u64),
    #[error("GCP domain calculation failed: {0}")]
    Domain(#[from] crate::photolab_gcp::GcpError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photolab_gcp::{
        GcpOptimizationScope, GcpRole, GcpUncertainty, OptimizationPointSnapshot,
    };

    fn camera(id: u32, center: [f64; 3], rotation: [f64; 9]) -> GcpCameraModel {
        GcpCameraModel {
            image_id: ImageId(id),
            calibration_group_id: "test-camera".into(),
            intrinsics_policy: GcpIntrinsicsPolicy::Auto,
            width_pixels: 2000,
            height_pixels: 1500,
            focal_x_pixels: 1000.0,
            focal_y_pixels: 1000.0,
            principal_x_pixels: 1000.0,
            principal_y_pixels: 750.0,
            radial_distortion: [0.0; 3],
            tangential_distortion: [0.0; 2],
            camera_to_reconstruction_rotation: rotation,
            center_reconstruction: center,
            reference_center_world_meters: None,
            reference_stddev_meters: None,
        }
    }

    fn look_down_camera(id: u32, x: f64, y: f64) -> GcpCameraModel {
        // Camera +Z looks towards reconstruction -Z while keeping an orthonormal frame.
        camera(
            id,
            [x, y, 10.0],
            [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0],
        )
    }

    #[test]
    fn objective_penalizes_points_that_move_behind_the_camera() {
        let camera = transform_camera(
            &look_down_camera(1, 0.0, 0.0),
            GcpSimilarityTransform::identity(),
        );
        let measured = project_world(&camera, [0.0, 0.0, 0.0]).expect("visible point");
        let mut point = BundlePoint {
            track_id: None,
            reconstruction: [0.0, 0.0, 0.0],
            world: [0.0, 0.0, 0.0],
            observations: vec![BundleObservation {
                camera_index: 0,
                measured,
                sigma_pixels: 1.0,
                is_gcp_marker: true,
            }],
            survey: None,
        };
        let options = GcpSolverOptions::default();
        let visible_cost = point_objective(std::slice::from_ref(&camera), &point, options);
        point.world = [0.0, 0.0, 20.0];
        let invalid_cost = point_objective(std::slice::from_ref(&camera), &point, options);
        assert_eq!(visible_cost, 0.0);
        assert_eq!(invalid_cost, INVALID_PROJECTION_COST);
    }

    #[test]
    fn similarity_initializer_ignores_one_gross_triangulation_outlier() {
        let coordinates = [
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.2],
            [0.0, 10.0, -0.1],
            [10.0, 10.0, 0.3],
            [5.0, 4.0, -0.2],
            [8.0, 3.0, 0.4],
        ];
        let mut points = coordinates
            .iter()
            .enumerate()
            .map(|(index, coordinate)| TriangulatedPoint {
                definition: identity_frame_point(
                    &format!("R{index}"),
                    *coordinate,
                    GcpRole::ControlXyz,
                ),
                participation: OptimizationPointParticipation::Control,
                reconstruction: *coordinate,
                ray_rms: 0.0,
            })
            .collect::<Vec<_>>();
        points[5].reconstruction = [100.0, -200.0, 50.0];
        let controls = points.iter().collect::<Vec<_>>();

        let transform = initial_transform(
            &controls,
            GcpTransformMode::Similarity7,
            GcpRobustLoss::default(),
        );

        assert!((transform.scale - 1.0).abs() < 1.0e-8);
        for (point, expected) in points.iter().take(5).zip(coordinates) {
            assert!(norm3(sub3(transform.apply(point.reconstruction), expected)) < 1.0e-7);
        }
    }

    fn point(id: &str, reconstruction: [f64; 3], role: GcpRole) -> (GcpPoint, [f64; 3]) {
        let world = [
            2.0 * reconstruction[0] + 500.0,
            2.0 * reconstruction[1] + 600.0,
            2.0 * reconstruction[2] + 50.0,
        ];
        (
            GcpPoint {
                id: GcpPointId(id.into()),
                name: id.into(),
                coordinate: GcpCoordinate {
                    east_meters: world[0],
                    north_meters: world[1],
                    height_meters: world[2],
                },
                uncertainty: GcpUncertainty {
                    horizontal_stddev_meters: 0.01,
                    height_stddev_meters: 0.02,
                },
                role,
            },
            reconstruction,
        )
    }

    fn snapshot(
        points: &[(GcpPoint, [f64; 3])],
        cameras: &[GcpCameraModel],
    ) -> GcpOptimizationSnapshot {
        let mut observations = Vec::new();
        for (definition, coordinate) in points {
            for camera in cameras {
                let image = project_reconstruction(camera, *coordinate).expect("visible");
                observations.push(GcpObservation {
                    point_id: definition.id.clone(),
                    image_id: camera.image_id,
                    state: GcpObservationState::Manual { coordinate: image },
                });
            }
        }
        GcpOptimizationSnapshot {
            schema_version: 1,
            scope: GcpOptimizationScope {
                label: "Test scope".into(),
                point_ids: points.iter().map(|value| value.0.id.clone()).collect(),
                camera_reference_image_ids: Vec::new(),
            },
            points: points
                .iter()
                .map(|value| OptimizationPointSnapshot {
                    point: value.0.clone(),
                    participation: if value.0.role.is_control() {
                        OptimizationPointParticipation::Control
                    } else {
                        OptimizationPointParticipation::Checkpoint
                    },
                })
                .collect(),
            observations,
        }
    }

    fn identity_frame_point(id: &str, coordinate: [f64; 3], role: GcpRole) -> GcpPoint {
        GcpPoint {
            id: GcpPointId(id.into()),
            name: id.into(),
            coordinate: GcpCoordinate {
                east_meters: coordinate[0],
                north_meters: coordinate[1],
                height_meters: coordinate[2],
            },
            uncertainty: GcpUncertainty {
                horizontal_stddev_meters: 0.01,
                height_stddev_meters: 0.02,
            },
            role,
        }
    }

    fn identity_snapshot(
        coordinates: &[[f64; 3]],
        cameras: &[GcpCameraModel],
        checkpoint_offset: Option<[f64; 3]>,
    ) -> GcpOptimizationSnapshot {
        let mut points = coordinates
            .iter()
            .enumerate()
            .map(|(index, coordinate)| {
                identity_frame_point(&format!("P{index}"), *coordinate, GcpRole::ControlXyz)
            })
            .collect::<Vec<_>>();
        if let Some(offset) = checkpoint_offset {
            let coordinate = add3(coordinates[0], offset);
            points.push(identity_frame_point(
                "CHECK",
                coordinate,
                GcpRole::CheckpointXyz,
            ));
        }
        let mut observations = Vec::new();
        for (index, point) in points.iter().enumerate() {
            let reconstruction = if index < coordinates.len() {
                coordinates[index]
            } else {
                coordinates[0]
            };
            for camera in cameras {
                observations.push(GcpObservation {
                    point_id: point.id.clone(),
                    image_id: camera.image_id,
                    state: GcpObservationState::Manual {
                        coordinate: project_reconstruction(camera, reconstruction)
                            .expect("visible"),
                    },
                });
            }
        }
        GcpOptimizationSnapshot {
            schema_version: 1,
            scope: GcpOptimizationScope {
                label: "BA synthetic".into(),
                point_ids: points.iter().map(|point| point.id.clone()).collect(),
                camera_reference_image_ids: Vec::new(),
            },
            points: points
                .into_iter()
                .map(|point| OptimizationPointSnapshot {
                    participation: if point.role.is_control() {
                        OptimizationPointParticipation::Control
                    } else {
                        OptimizationPointParticipation::Checkpoint
                    },
                    point,
                })
                .collect(),
            observations,
        }
    }

    fn synthetic_tie_points(
        cameras: &[GcpCameraModel],
        with_outlier: bool,
    ) -> Vec<GcpBundleTiePoint> {
        let coordinates = [
            [-2.0, -2.0, 0.2],
            [2.0, -2.0, -0.1],
            [-2.0, 2.0, 0.1],
            [2.0, 2.0, 0.3],
            [0.0, 0.0, -0.2],
            [1.0, -1.0, 0.4],
        ];
        coordinates
            .into_iter()
            .enumerate()
            .map(|(index, coordinate)| {
                let mut measurements = cameras
                    .iter()
                    .map(|camera| GcpTiePointMeasurement {
                        image_id: camera.image_id,
                        coordinate: project_reconstruction(camera, coordinate).expect("visible"),
                    })
                    .collect::<Vec<_>>();
                if with_outlier && index == 0 {
                    measurements[2].coordinate.x_pixels += 500.0;
                    measurements[2].coordinate.y_pixels -= 300.0;
                }
                GcpBundleTiePoint {
                    track_id: u64::try_from(index + 1).expect("small id"),
                    reconstruction_coordinate: coordinate,
                    measurements,
                }
            })
            .collect()
    }

    #[test]
    fn visual_states_are_unambiguous() {
        let coordinate = ImageCoordinate {
            x_pixels: 1.0,
            y_pixels: 2.0,
        };
        assert_eq!(
            observation_visual_state(&GcpObservationState::Manual { coordinate }),
            GcpMarkerVisualState::ManualGreen
        );
        assert_eq!(
            observation_visual_state(&GcpObservationState::Automatic {
                coordinate,
                confidence_per_mille: 900,
            }),
            GcpMarkerVisualState::AutomaticOrange
        );
        assert_eq!(
            observation_visual_state(&GcpObservationState::Predicted {
                coordinate,
                confidence_per_mille: 500,
                source: "projection".into(),
            }),
            GcpMarkerVisualState::PredictedBlue
        );
    }

    #[test]
    fn triangulation_and_similarity_recover_known_frame() {
        let cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let points = [
            point("A", [-1.0, -1.0, 0.0], GcpRole::ControlXyz),
            point("B", [1.0, -1.0, 0.2], GcpRole::ControlXyz),
            point("C", [0.0, 1.0, -0.1], GcpRole::ControlXyz),
            point("D", [0.2, 0.1, 0.4], GcpRole::CheckpointXyz),
        ];
        let result = optimize_gcp_alignment(
            &snapshot(&points, &cameras),
            &cameras,
            GcpSolverOptions::default(),
            |_| GcpSolveControl::Continue,
        )
        .expect("optimization");
        assert!((result.transform.scale - 2.0).abs() < 1.0e-7);
        assert!((result.transform.translation_meters[0] - 500.0).abs() < 1.0e-6);
        assert!((result.transform.translation_meters[1] - 600.0).abs() < 1.0e-6);
        assert!((result.transform.translation_meters[2] - 50.0).abs() < 1.0e-6);
        assert!(result
            .residuals
            .iter()
            .all(|residual| residual.active_component_norm_meters < 1.0e-6));
        assert_eq!(
            result
                .statistics
                .control
                .as_ref()
                .map(|value| value.point_count),
            Some(3)
        );
        assert_eq!(
            result
                .statistics
                .checkpoint
                .as_ref()
                .map(|value| value.point_count),
            Some(1)
        );
    }

    #[test]
    fn checkpoint_outlier_does_not_change_fit() {
        let cameras = [
            look_down_camera(1, -4.0, 0.0),
            look_down_camera(2, 4.0, 0.0),
        ];
        let mut points = vec![
            point("A", [-1.0, -1.0, 0.0], GcpRole::ControlXyz),
            point("B", [1.0, -1.0, 0.2], GcpRole::ControlXyz),
            point("C", [0.0, 1.0, -0.1], GcpRole::ControlXyz),
            point("D", [0.2, 0.1, 0.4], GcpRole::CheckpointXyz),
        ];
        points[3].0.coordinate.east_meters += 1_000.0;
        let result = optimize_gcp_alignment(
            &snapshot(&points, &cameras),
            &cameras,
            GcpSolverOptions::default(),
            |_| GcpSolveControl::Continue,
        )
        .expect("optimization");
        assert!((result.transform.scale - 2.0).abs() < 1.0e-6);
        assert!(result.residuals[3].active_component_norm_meters > 900.0);
    }

    #[test]
    fn robust_bundle_adjustment_recovers_perturbed_camera_with_tie_points() {
        let true_cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [
            [-1.5, -1.0, 0.0],
            [1.5, -1.0, 0.2],
            [-1.0, 1.5, -0.1],
            [1.0, 1.5, 0.3],
        ];
        let data = identity_snapshot(&controls, &true_cameras, None);
        let mut initial = true_cameras.clone();
        initial[2].center_reconstruction[0] += 0.35;
        initial[2].center_reconstruction[1] -= 0.2;
        let before = norm3(sub3(
            initial[2].center_reconstruction,
            true_cameras[2].center_reconstruction,
        ));
        let result = optimize_gcp_bundle_alignment(
            &data,
            &initial,
            &synthetic_tie_points(&true_cameras, false),
            GcpSolverOptions {
                transform_mode: GcpTransformMode::TranslationOnly,
                maximum_iterations: 30,
                ..GcpSolverOptions::default()
            },
            |_| GcpSolveControl::Continue,
        )
        .expect("bundle adjustment");
        let after = norm3(sub3(
            result.cameras[2].center_world_meters,
            true_cameras[2].center_reconstruction,
        ));
        assert!(after < before * 0.5, "before={before}, after={after}");
        assert!(result.converged);
        assert_eq!(result.tie_points.len(), 6);
        assert_eq!(result.fixed_gauge_camera_count, 0);
    }

    #[test]
    fn settled_initializer_does_not_mask_an_unfinished_bundle() {
        let cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [
            [-1.5, -1.0, 0.0],
            [1.5, -1.0, 0.2],
            [-1.0, 1.5, -0.1],
            [1.0, 1.5, 0.3],
        ];
        let result = optimize_gcp_bundle_alignment(
            &identity_snapshot(&controls, &cameras, None),
            &cameras,
            &synthetic_tie_points(&cameras, false),
            GcpSolverOptions {
                transform_mode: GcpTransformMode::TranslationOnly,
                maximum_iterations: 1,
                ..GcpSolverOptions::default()
            },
            |_| GcpSolveControl::Continue,
        )
        .expect("single-sweep bundle adjustment");
        assert!(!result.converged);
        assert_eq!(result.iterations, 2);
    }

    #[test]
    fn only_explicitly_selected_camera_reference_priors_constrain_bundle_adjustment() {
        let true_cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [
            [-1.5, -1.0, 0.0],
            [1.5, -1.0, 0.2],
            [-1.0, 1.5, -0.1],
            [1.0, 1.5, 0.3],
        ];
        let unselected_snapshot = identity_snapshot(&controls, &true_cameras, None);
        let mut selected_snapshot = unselected_snapshot.clone();
        selected_snapshot.scope.camera_reference_image_ids = vec![ImageId(3)];
        let mut inputs = true_cameras.clone();
        inputs[2].reference_center_world_meters = Some([0.5, 4.0, 10.0]);
        inputs[2].reference_stddev_meters = Some([0.02, 0.02, 0.04]);
        let options = GcpSolverOptions {
            transform_mode: GcpTransformMode::TranslationOnly,
            maximum_iterations: 30,
            ..GcpSolverOptions::default()
        };
        let unselected =
            optimize_gcp_bundle_alignment(&unselected_snapshot, &inputs, &[], options, |_| {
                GcpSolveControl::Continue
            })
            .expect("unselected camera prior");
        let selected =
            optimize_gcp_bundle_alignment(&selected_snapshot, &inputs, &[], options, |_| {
                GcpSolveControl::Continue
            })
            .expect("selected camera prior");
        assert!(
            selected.cameras[2].center_world_meters[0]
                > unselected.cameras[2].center_world_meters[0] + 0.01
        );
    }

    #[test]
    fn camera_references_alone_initialize_and_constrain_similarity() {
        let mut cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
            look_down_camera(4, 5.0, 5.0),
        ];
        let target = |center: [f64; 3]| {
            [
                center[0] * 2.0 + 500.0,
                center[1] * 2.0 + 600.0,
                center[2] * 2.0 + 50.0,
            ]
        };
        for camera in &mut cameras {
            camera.reference_center_world_meters = Some(target(camera.center_reconstruction));
            camera.reference_stddev_meters = Some([0.03, 0.03, 0.06]);
        }
        let snapshot = GcpOptimizationSnapshot {
            schema_version: 1,
            scope: GcpOptimizationScope {
                label: "Camera references only".into(),
                point_ids: Vec::new(),
                camera_reference_image_ids: cameras.iter().map(|camera| camera.image_id).collect(),
            },
            points: Vec::new(),
            observations: Vec::new(),
        };
        let result = optimize_gcp_bundle_alignment(
            &snapshot,
            &cameras,
            &synthetic_tie_points(&cameras, false),
            GcpSolverOptions::default(),
            |_| GcpSolveControl::Continue,
        )
        .expect("camera-reference-only adjustment");

        assert_eq!(result.effective_mode, GcpTransformMode::Similarity7);
        for (optimized, source) in result.cameras.iter().zip(&cameras) {
            let expected = target(source.center_reconstruction);
            assert!(norm3(sub3(optimized.center_world_meters, expected)) < 0.05);
        }
    }

    #[test]
    fn camera_reference_only_alignment_rejects_collinear_camera_centers() {
        let mut cameras = [
            look_down_camera(1, 0.0, 0.0),
            look_down_camera(2, 2.0, 0.0),
            look_down_camera(3, 4.0, 0.0),
        ];
        for camera in &mut cameras {
            camera.reference_center_world_meters = Some([
                camera.center_reconstruction[0] + 100.0,
                200.0,
                camera.center_reconstruction[2] + 10.0,
            ]);
            camera.reference_stddev_meters = Some([0.03, 0.03, 0.06]);
        }
        let snapshot = GcpOptimizationSnapshot {
            schema_version: 1,
            scope: GcpOptimizationScope {
                label: "Degenerate camera references".into(),
                point_ids: Vec::new(),
                camera_reference_image_ids: cameras.iter().map(|camera| camera.image_id).collect(),
            },
            points: Vec::new(),
            observations: Vec::new(),
        };
        let error = optimize_gcp_bundle_alignment(
            &snapshot,
            &cameras,
            &[],
            GcpSolverOptions::default(),
            |_| GcpSolveControl::Continue,
        )
        .expect_err("collinear camera references must be rejected");
        assert_eq!(error, GcpOptimizationError::DegenerateCameraReferences);
    }

    #[test]
    fn robust_bundle_adjustment_limits_a_gross_image_outlier() {
        let true_cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [
            [-1.5, -1.0, 0.0],
            [1.5, -1.0, 0.2],
            [-1.0, 1.5, -0.1],
            [1.0, 1.5, 0.3],
        ];
        let data = identity_snapshot(&controls, &true_cameras, None);
        let mut initial = true_cameras.clone();
        initial[2].center_reconstruction[0] += 0.25;
        let result = optimize_gcp_bundle_alignment(
            &data,
            &initial,
            &synthetic_tie_points(&true_cameras, true),
            GcpSolverOptions {
                transform_mode: GcpTransformMode::TranslationOnly,
                robust_loss: GcpRobustLoss::Cauchy { scale_sigma: 2.5 },
                maximum_iterations: 30,
                ..GcpSolverOptions::default()
            },
            |_| GcpSolveControl::Continue,
        )
        .expect("robust bundle adjustment");
        let camera_error = norm3(sub3(
            result.cameras[2].center_world_meters,
            true_cameras[2].center_reconstruction,
        ));
        assert!(camera_error < 0.12, "camera error={camera_error}");
    }

    #[test]
    fn checkpoint_survey_coordinate_remains_evaluation_only_in_bundle() {
        let cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [[-1.5, -1.0, 0.0], [1.5, -1.0, 0.2], [-1.0, 1.5, -0.1]];
        let result = optimize_gcp_bundle_alignment(
            &identity_snapshot(&controls, &cameras, Some([500.0, -300.0, 100.0])),
            &cameras,
            &synthetic_tie_points(&cameras, false),
            GcpSolverOptions {
                transform_mode: GcpTransformMode::TranslationOnly,
                ..GcpSolverOptions::default()
            },
            |_| GcpSolveControl::Continue,
        )
        .expect("bundle adjustment");
        assert!(
            result
                .residuals
                .last()
                .expect("checkpoint")
                .active_component_norm_meters
                > 500.0
        );
        assert!(
            result
                .statistics
                .control
                .as_ref()
                .expect("controls")
                .active_component_rms_meters
                < 1.0e-6
        );
    }

    #[test]
    fn checkpoint_coordinates_do_not_change_the_survey_estimate() {
        let cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [[-1.5, -1.0, 0.0], [1.5, -1.0, 0.2], [-1.0, 1.5, -0.1]];
        let options = GcpSolverOptions {
            transform_mode: GcpTransformMode::TranslationOnly,
            maximum_iterations: 30,
            ..GcpSolverOptions::default()
        };
        let baseline = optimize_gcp_bundle_alignment(
            &identity_snapshot(&controls, &cameras, Some([0.0, 0.0, 0.0])),
            &cameras,
            &synthetic_tie_points(&cameras, false),
            options,
            |_| GcpSolveControl::Continue,
        )
        .expect("baseline checkpoint bundle");
        let displaced = optimize_gcp_bundle_alignment(
            &identity_snapshot(&controls, &cameras, Some([500.0, -300.0, 100.0])),
            &cameras,
            &synthetic_tie_points(&cameras, false),
            options,
            |_| GcpSolveControl::Continue,
        )
        .expect("displaced checkpoint bundle");

        assert_eq!(baseline.transform, displaced.transform);
        assert_eq!(baseline.cameras, displaced.cameras);
        assert_eq!(baseline.points, displaced.points);
        assert_eq!(
            baseline.statistics.control, displaced.statistics.control,
            "checkpoint coordinates entered the control estimate"
        );
        assert_ne!(
            baseline.statistics.checkpoint, displaced.statistics.checkpoint,
            "checkpoint coordinates must still affect evaluation"
        );
    }

    #[test]
    fn controls_are_released_before_bundle_convergence_is_reported() {
        let cameras = [
            look_down_camera(1, -4.0, -3.0),
            look_down_camera(2, 4.0, -3.0),
            look_down_camera(3, 0.0, 4.0),
        ];
        let controls = [
            [-1.5, -1.0, 0.0],
            [1.5, -1.0, 0.2],
            [-1.0, 1.5, -0.1],
            [1.0, 1.5, 0.3],
        ];
        let mut data = identity_snapshot(&controls, &cameras, None);
        for point in &mut data.points {
            point.point.uncertainty.horizontal_stddev_meters = 0.5;
            point.point.uncertainty.height_stddev_meters = 0.5;
        }
        for observation in &mut data.observations {
            if observation.image_id != ImageId(3) {
                continue;
            }
            if let GcpObservationState::Manual { coordinate } = &mut observation.state {
                coordinate.x_pixels += 24.0;
                coordinate.y_pixels -= 12.0;
            }
        }

        let result = optimize_gcp_bundle_alignment(
            &data,
            &cameras,
            &[],
            GcpSolverOptions {
                transform_mode: GcpTransformMode::TranslationOnly,
                maximum_iterations: 30,
                refine_camera_extrinsics: false,
                refine_shared_intrinsics: false,
                ..GcpSolverOptions::default()
            },
            |_| GcpSolveControl::Continue,
        )
        .expect("released-control bundle adjustment");

        assert!(result.converged);
        assert!(
            result
                .statistics
                .control
                .as_ref()
                .expect("control statistics")
                .active_component_rms_meters
                > 1.0e-4,
            "controls stayed artificially fixed at their survey priors"
        );
    }

    #[test]
    fn xy_and_z_masks_are_preserved_in_statistics() {
        let cameras = [
            look_down_camera(1, -4.0, 0.0),
            look_down_camera(2, 4.0, 0.0),
        ];
        let points = [
            point("XY", [-1.0, 0.0, 0.0], GcpRole::ControlXy),
            point("Z", [1.0, 0.0, 0.0], GcpRole::ControlZ),
        ];
        let result = optimize_gcp_alignment(
            &snapshot(&points, &cameras),
            &cameras,
            GcpSolverOptions {
                transform_mode: GcpTransformMode::TranslationOnly,
                ..GcpSolverOptions::default()
            },
            |_| GcpSolveControl::Continue,
        )
        .expect("optimization");
        assert!(result.residuals[0].east_meters.is_some());
        assert!(result.residuals[0].height_meters.is_none());
        assert!(result.residuals[1].east_meters.is_none());
        assert!(result.residuals[1].height_meters.is_some());
    }

    #[test]
    fn cancellation_is_checked_during_triangulation() {
        let cameras = [
            look_down_camera(1, -4.0, 0.0),
            look_down_camera(2, 4.0, 0.0),
        ];
        let points = [point("A", [0.0, 0.0, 0.0], GcpRole::ControlXyz)];
        let error = optimize_gcp_alignment(
            &snapshot(&points, &cameras),
            &cameras,
            GcpSolverOptions::default(),
            |progress| {
                if progress.phase == GcpOptimizationPhase::Triangulate {
                    GcpSolveControl::Cancel
                } else {
                    GcpSolveControl::Continue
                }
            },
        )
        .expect_err("cancelled");
        assert_eq!(error, GcpOptimizationError::Cancelled);
    }

    #[test]
    fn radial_distortion_round_trips_for_triangulation() {
        let mut cameras = [
            look_down_camera(1, -4.0, 0.0),
            look_down_camera(2, 4.0, 0.0),
        ];
        cameras[0].radial_distortion = [0.05, -0.01, 0.001];
        cameras[1].radial_distortion = [0.05, -0.01, 0.001];
        let points = [point("A", [0.3, 0.2, 0.0], GcpRole::ControlXyz)];
        let data = snapshot(&points, &cameras);
        let map = validate_cameras(&cameras).expect("cameras");
        let observations = data.observations.iter().collect::<Vec<_>>();
        let (triangulated, _) = triangulate_observations(&observations, &map).expect("triangulate");
        assert!(norm3(sub3(triangulated, points[0].1)) < 1.0e-8);
    }

    #[test]
    fn projected_crs_triangulation_is_numerically_stable() {
        let target = [4_375_526.105, 5_281_233.931, 706.982];
        let rotation = [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0];
        let cameras = [
            camera(1, [target[0] - 18.0, target[1] - 4.0, 736.0], rotation),
            camera(2, [target[0] + 17.0, target[1] - 3.0, 735.5], rotation),
            camera(3, [target[0] + 2.0, target[1] + 16.0, 736.5], rotation),
        ];
        let observations = cameras
            .iter()
            .map(|camera| GcpObservation {
                point_id: GcpPointId("WORLD".into()),
                image_id: camera.image_id,
                state: GcpObservationState::Manual {
                    coordinate: project_reconstruction(camera, target).expect("visible"),
                },
            })
            .collect::<Vec<_>>();
        let camera_map = validate_cameras(&cameras).expect("camera map");
        let references = observations.iter().collect::<Vec<_>>();

        let (triangulated, ray_rms) =
            triangulate_observations(&references, &camera_map).expect("stable triangulation");

        assert!(norm3(sub3(triangulated, target)) < 1.0e-7);
        assert!(ray_rms < 1.0e-7);
    }

    #[test]
    fn projection_rejects_the_folded_part_of_a_radial_model() {
        let radial = [-0.107_756_512_758, -0.000_878_853_88, -0.015_723_478_938];
        let tangential = [0.000_130_474_491, -0.000_011_293_71];

        assert!(project_camera_coordinate(
            [0.2, -0.3, 1.0],
            3_713.0,
            3_713.0,
            2_640.0,
            1_978.0,
            radial,
            tangential,
        )
        .is_ok());
        assert_eq!(
            project_camera_coordinate(
                [0.82, -1.64, 1.0],
                3_713.0,
                3_713.0,
                2_640.0,
                1_978.0,
                radial,
                tangential,
            ),
            Err(GcpOptimizationError::InvalidObservationCoordinate)
        );
    }

    #[test]
    fn manual_keypoint_propagates_orange_observations_without_overwriting_manual() {
        let seed = GcpObservation {
            point_id: GcpPointId("A".into()),
            image_id: ImageId(1),
            state: GcpObservationState::Manual {
                coordinate: ImageCoordinate {
                    x_pixels: 101.0,
                    y_pixels: 202.0,
                },
            },
        };
        let existing_manual = GcpObservation {
            point_id: seed.point_id.clone(),
            image_id: ImageId(3),
            state: GcpObservationState::Manual {
                coordinate: ImageCoordinate {
                    x_pixels: 4.0,
                    y_pixels: 5.0,
                },
            },
        };
        let propagation = propagate_gcp_through_tie_points(
            &seed,
            &[GcpTiePointTrack {
                track_id: 7,
                confidence_per_mille: 920,
                measurements: vec![
                    GcpTiePointMeasurement {
                        image_id: ImageId(1),
                        coordinate: ImageCoordinate {
                            x_pixels: 100.0,
                            y_pixels: 200.0,
                        },
                    },
                    GcpTiePointMeasurement {
                        image_id: ImageId(2),
                        coordinate: ImageCoordinate {
                            x_pixels: 300.0,
                            y_pixels: 400.0,
                        },
                    },
                    GcpTiePointMeasurement {
                        image_id: ImageId(3),
                        coordinate: ImageCoordinate {
                            x_pixels: 500.0,
                            y_pixels: 600.0,
                        },
                    },
                ],
            }],
            &[seed.clone(), existing_manual],
            5.0,
        )
        .expect("propagate")
        .expect("track");
        assert_eq!(propagation.track_id, 7);
        assert_eq!(propagation.observations.len(), 1);
        assert_eq!(propagation.observations[0].image_id, ImageId(2));
        assert!(matches!(
            propagation.observations[0].state,
            GcpObservationState::Automatic { .. }
        ));
    }

    #[test]
    fn explicit_calibration_ids_are_the_only_grouping_authority() {
        let mut cameras = vec![
            look_down_camera(1, -4.0, 0.0),
            look_down_camera(2, 0.0, 0.0),
            look_down_camera(3, 4.0, 0.0),
        ];
        cameras[0].calibration_group_id = "physical-lens-a".into();
        cameras[1].calibration_group_id = "physical-lens-b".into();
        cameras[2].calibration_group_id = "physical-lens-a".into();
        // Deliberately different floating-point seeds must not split an
        // explicitly reviewed group, while equal seeds in B must not merge it.
        cameras[2].focal_x_pixels = 999.999_999;
        cameras[2].focal_y_pixels = 999.999_999;
        validate_cameras(&cameras).expect("explicit groups are valid");
        let optimized = cameras
            .iter()
            .map(|camera| transform_camera(camera, GcpSimilarityTransform::identity()))
            .collect::<Vec<_>>();
        let groups = build_intrinsic_groups(
            &cameras,
            &optimized,
            &vec![Vec::new(); cameras.len()],
            &[],
            GcpSolverOptions::default(),
        );
        assert_eq!(groups.len(), 2);
        assert_eq!(
            groups
                .iter()
                .find(|group| group.diagnostics.calibration_group_id == "physical-lens-a")
                .map(|group| group.indices.as_slice()),
            Some([0, 2].as_slice())
        );
    }

    #[test]
    fn auto_returns_a_named_safe_fallback_for_a_weak_group() {
        let cameras = vec![look_down_camera(1, 0.0, 0.0)];
        let optimized = cameras
            .iter()
            .map(|camera| transform_camera(camera, GcpSimilarityTransform::identity()))
            .collect::<Vec<_>>();
        let groups = build_intrinsic_groups(
            &cameras,
            &optimized,
            &[Vec::new()],
            &[],
            GcpSolverOptions::default(),
        );
        let diagnostics = &groups[0].diagnostics;
        assert_eq!(
            diagnostics.effective_parameters,
            GcpIntrinsicParameterMask::none()
        );
        assert_eq!(diagnostics.stages.len(), 1);
        assert_eq!(
            diagnostics.stages[0].rejection,
            Some(GcpIntrinsicsStageRejection::TooFewCameras)
        );
    }

    #[test]
    fn custom_mask_refines_only_the_selected_parameter_family() {
        let mut truth = vec![
            look_down_camera(1, -4.0, 0.0),
            look_down_camera(2, 4.0, 0.0),
        ];
        for camera in &mut truth {
            camera.calibration_group_id = "golden-lens".into();
            camera.intrinsics_policy = GcpIntrinsicsPolicy::Custom {
                parameters: GcpIntrinsicParameterMask {
                    f: true,
                    ..GcpIntrinsicParameterMask::none()
                },
            };
        }
        let mut source = truth.clone();
        for camera in &mut source {
            camera.focal_x_pixels = 900.0;
            camera.focal_y_pixels = 900.0;
        }
        let truth_optimized = truth
            .iter()
            .map(|camera| transform_camera(camera, GcpSimilarityTransform::identity()))
            .collect::<Vec<_>>();
        let mut optimized = source
            .iter()
            .map(|camera| transform_camera(camera, GcpSimilarityTransform::identity()))
            .collect::<Vec<_>>();
        let mut points = Vec::new();
        let mut observations = vec![Vec::new(), Vec::new()];
        for row in 0..7 {
            for column in 0..7 {
                let world = [
                    -3.0 + f64::from(column),
                    -3.0 + f64::from(row),
                    f64::from((row + column) % 4) * 0.35,
                ];
                let point_index = points.len();
                points.push(BundlePoint {
                    track_id: Some(u64::try_from(point_index).expect("small fixture")),
                    reconstruction: world,
                    world,
                    observations: Vec::new(),
                    survey: None,
                });
                for camera_index in 0..2 {
                    observations[camera_index].push((
                        point_index,
                        project_world(&truth_optimized[camera_index], world).expect("visible"),
                        1.0,
                        false,
                    ));
                }
            }
        }
        let mut auto_source = source.clone();
        for camera in &mut auto_source {
            camera.intrinsics_policy = GcpIntrinsicsPolicy::Auto;
        }
        let auto = build_intrinsic_groups(
            &auto_source,
            &optimized,
            &observations,
            &points,
            GcpSolverOptions::default(),
        );
        assert!(auto[0].diagnostics.stages[0].accepted);
        assert!(auto[0].diagnostics.effective_parameters.f);
        assert!(auto[0].diagnostics.effective_parameters.k1);
        let principal_before = optimized[0].principal_x_pixels;
        let radial_before = optimized[0].radial_distortion;
        let mask = GcpIntrinsicParameterMask {
            f: true,
            ..GcpIntrinsicParameterMask::none()
        };
        for _ in 0..12 {
            refine_intrinsic_group(
                &[0, 1],
                mask,
                &mut optimized,
                &observations,
                &points,
                &source,
                GcpSolverOptions::default(),
            );
        }
        assert!((optimized[0].focal_x_pixels - 1_000.0).abs() < 1.0e-4);
        assert_eq!(optimized[0].principal_x_pixels, principal_before);
        assert_eq!(optimized[0].radial_distortion, radial_before);
        assert_eq!(optimized[0].focal_x_pixels, optimized[1].focal_x_pixels);
    }

    #[test]
    fn intrinsics_policy_json_is_a_pinned_eight_parameter_contract() {
        let policy = GcpIntrinsicsPolicy::Prior {
            parameters: GcpIntrinsicParameterMask::all(),
            stddev: GcpIntrinsicPriorStddev::default(),
        };
        let value = serde_json::to_value(policy).expect("serialize policy");
        assert_eq!(value["kind"], "prior");
        assert_eq!(
            value["parameters"].as_object().map(|value| value.len()),
            Some(8)
        );
        let encoded = value.to_string();
        assert!(!encoded.contains("b1"));
        assert!(!encoded.contains("b2"));
        assert!(!encoded.contains("k4"));
    }

    #[test]
    fn projection_ellipse_uses_full_jacobian_covariance() {
        let jacobian = [[2.0, 1.0, 0.5], [-0.5, 3.0, 1.0]];
        let world = [[4.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 9.0]];
        let pixels = propagate_point_covariance(jacobian, world);
        assert!(pixels[0][1].abs() > 1.0e-6);
        let ellipse = covariance_ellipse(pixels).expect("valid propagated ellipse");
        assert!(ellipse.semi_major_pixels > ellipse.semi_minor_pixels);
        assert!(ellipse.angle_degrees.abs() > 1.0e-3);
    }
}
