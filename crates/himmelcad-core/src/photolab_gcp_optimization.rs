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

/// Calibrated pinhole camera in reconstruction coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCameraModel {
    pub image_id: ImageId,
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
    /// Refines camera rotations and centers while preserving a fixed gauge.
    pub refine_camera_extrinsics: bool,
}

impl Default for GcpSolverOptions {
    fn default() -> Self {
        Self {
            transform_mode: GcpTransformMode::Auto,
            robust_loss: GcpRobustLoss::default(),
            maximum_iterations: 50,
            convergence_tolerance: 1.0e-10,
            maximum_tie_points: 50_000,
            reprojection_sigma_pixels: 1.0,
            refine_camera_extrinsics: true,
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
}

#[derive(Debug, Clone)]
struct BundlePoint {
    track_id: Option<u64>,
    reconstruction: [f64; 3],
    world: [f64; 3],
    observations: Vec<BundleObservation>,
    survey: Option<GcpPoint>,
}

#[derive(Debug, Clone, Copy)]
struct BundleOutcome {
    iterations: u16,
    converged: bool,
    objective: f64,
    fixed_gauge_camera_count: u32,
}

#[derive(Debug, Clone, Copy)]
struct CameraReferencePrior {
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
/// The first camera pose and, when present, the second camera center form a
/// deterministic gauge. Survey priors are applied only to controls and honor
/// their independent XY/Z role masks. Intrinsics remain fixed because they are
/// not safely observable from the frozen GCP snapshot alone.
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
    let effective_mode = effective_mode(options.transform_mode, &controls)?;
    let active = active_parameters(effective_mode, &controls);
    let mut transform = initial_transform(&controls, effective_mode);
    let mut lambda = 1.0e-6;
    let mut current_objective = objective(&controls, transform, options.robust_loss);
    let mut converged = false;
    let mut iterations = 0_u16;
    for iteration in 0..options.maximum_iterations {
        check_progress(
            &mut progress,
            GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Optimize,
                completed_units: u32::from(iteration),
                total_units: u32::from(options.maximum_iterations).saturating_mul(2),
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
            converged = true;
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
        options.maximum_tie_points,
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
    );
    let bundle = run_bundle_adjustment(
        &mut optimized_cameras,
        &mut bundle_points,
        cameras,
        &snapshot.scope.camera_reference_image_ids,
        options,
        iterations,
        &mut progress,
    )?;
    current_objective = bundle.objective;
    iterations = iterations.saturating_add(bundle.iterations);
    converged |= bundle.converged;

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
    })
}

fn build_bundle_points(
    gcps: &[TriangulatedPoint],
    tie_points: &[GcpBundleTiePoint],
    cameras: &[OptimizedGcpCamera],
    transform: GcpSimilarityTransform,
    maximum_tie_points: u32,
) -> Result<Vec<BundlePoint>, GcpOptimizationError> {
    let camera_indices = cameras
        .iter()
        .enumerate()
        .map(|(index, camera)| (camera.image_id, index))
        .collect::<BTreeMap<_, _>>();
    let mut points = Vec::with_capacity(
        gcps.len().saturating_add(
            usize::try_from(maximum_tie_points)
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
    let limit = usize::try_from(maximum_tie_points).unwrap_or(usize::MAX);
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
            });
    }
}

fn run_bundle_adjustment<F>(
    cameras: &mut [OptimizedGcpCamera],
    points: &mut [BundlePoint],
    source_cameras: &[GcpCameraModel],
    selected_camera_ids: &[ImageId],
    options: GcpSolverOptions,
    iteration_offset: u16,
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
    let mut current_objective = bundle_objective(cameras, points, &camera_priors, options);
    let refinable = vec![true; cameras.len()];
    let gauge = refinable
        .iter()
        .enumerate()
        .filter_map(|(index, active)| active.then_some(index))
        .take(2)
        .collect::<Vec<_>>();
    let mut converged = false;
    let mut iterations = 0_u16;
    for iteration in 0..options.maximum_iterations {
        check_progress(
            progress,
            GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Optimize,
                completed_units: u32::from(iteration_offset.saturating_add(iteration)),
                total_units: u32::from(options.maximum_iterations).saturating_mul(2),
                iteration: Some(iteration_offset.saturating_add(iteration)),
                objective: Some(current_objective),
            },
        )?;
        let mut largest_step = 0.0_f64;
        for point_index in 0..points.len() {
            if point_index % 256 == 0 {
                check_progress(
                    progress,
                    GcpOptimizationProgress {
                        phase: GcpOptimizationPhase::Optimize,
                        completed_units: u32::from(iteration_offset.saturating_add(iteration)),
                        total_units: u32::from(options.maximum_iterations).saturating_mul(2),
                        iteration: Some(iteration_offset.saturating_add(iteration)),
                        objective: Some(current_objective),
                    },
                )?;
            }
            largest_step =
                largest_step.max(refine_bundle_point(point_index, cameras, points, options));
        }
        if options.refine_camera_extrinsics {
            let observations = camera_observation_index(cameras.len(), points);
            for camera_index in 0..cameras.len() {
                if !refinable[camera_index] || gauge.first() == Some(&camera_index) {
                    continue;
                }
                if camera_index % 32 == 0 {
                    check_progress(
                        progress,
                        GcpOptimizationProgress {
                            phase: GcpOptimizationPhase::Optimize,
                            completed_units: u32::from(iteration_offset.saturating_add(iteration)),
                            total_units: u32::from(options.maximum_iterations).saturating_mul(2),
                            iteration: Some(iteration_offset.saturating_add(iteration)),
                            objective: Some(current_objective),
                        },
                    )?;
                }
                largest_step = largest_step.max(refine_bundle_camera(
                    camera_index,
                    &observations[camera_index],
                    cameras,
                    points,
                    camera_priors[camera_index],
                    options,
                    gauge.get(1) == Some(&camera_index),
                ));
            }
        }
        let objective = bundle_objective(cameras, points, &camera_priors, options);
        iterations = iteration + 1;
        let objective_change = (current_objective - objective).abs();
        current_objective = objective;
        if largest_step <= options.convergence_tolerance.sqrt()
            && objective_change <= options.convergence_tolerance * (1.0 + objective.abs())
        {
            converged = true;
            break;
        }
    }
    Ok(BundleOutcome {
        iterations,
        converged,
        objective: current_objective,
        fixed_gauge_camera_count: u32::try_from(gauge.len()).unwrap_or(2),
    })
}

fn camera_observation_index(
    camera_count: usize,
    points: &[BundlePoint],
) -> Vec<Vec<(usize, ImageCoordinate)>> {
    let mut result = vec![Vec::new(); camera_count];
    for (point_index, point) in points.iter().enumerate() {
        for observation in &point.observations {
            result[observation.camera_index].push((point_index, observation.measured));
        }
    }
    result
}

fn refine_bundle_point(
    point_index: usize,
    cameras: &[OptimizedGcpCamera],
    points: &mut [BundlePoint],
    options: GcpSolverOptions,
) -> f64 {
    let point = &points[point_index];
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
        let normalized = residual[0].hypot(residual[1]) / options.reprojection_sigma_pixels;
        let weight = robust_weight(options.robust_loss, normalized)
            / options.reprojection_sigma_pixels.powi(2);
        let jacobian = numeric_point_jacobian(camera, point.world, projected);
        accumulate_2d_normal(&mut normal, &mut gradient, jacobian, residual, weight);
    }
    if let Some(survey) = &point.survey {
        accumulate_survey_prior(
            &mut normal,
            &mut gradient,
            point.world,
            survey,
            options.robust_loss,
        );
    }
    damp_diagonal(&mut normal, 1.0e-5);
    let Some(delta) = solve_linear(normal, gradient.map(|value| -value)) else {
        return 0.0;
    };
    let old_cost = point_objective(cameras, point, options);
    let candidate = add3(point.world, delta);
    let mut candidate_point = point.clone();
    candidate_point.world = candidate;
    if point_objective(cameras, &candidate_point, options) <= old_cost {
        points[point_index].world = candidate;
        norm3(delta)
    } else {
        0.0
    }
}

fn refine_bundle_camera(
    camera_index: usize,
    observations: &[(usize, ImageCoordinate)],
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
    for (point_index, measured) in observations {
        let point = points[*point_index].world;
        let Ok(projected) = project_world(camera, point) else {
            continue;
        };
        let residual = [
            projected.x_pixels - measured.x_pixels,
            projected.y_pixels - measured.y_pixels,
        ];
        let normalized = residual[0].hypot(residual[1]) / options.reprojection_sigma_pixels;
        let weight = robust_weight(options.robust_loss, normalized)
            / options.reprojection_sigma_pixels.powi(2);
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
    let candidate = perturb_camera(camera, delta);
    if camera_objective(&candidate, observations, points, reference_prior, options) <= old_cost {
        cameras[camera_index] = candidate;
        delta.iter().map(|value| value * value).sum::<f64>().sqrt()
    } else {
        0.0
    }
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
    let robust = robust_weight(loss, normalized);
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
        .filter_map(|observation| {
            let projected = project_world(&cameras[observation.camera_index], point.world).ok()?;
            let norm = (projected.x_pixels - observation.measured.x_pixels)
                .hypot(projected.y_pixels - observation.measured.y_pixels)
                / options.reprojection_sigma_pixels;
            Some(robust_cost(options.robust_loss, norm))
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
                options.robust_loss,
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
    observations: &[(usize, ImageCoordinate)],
    points: &[BundlePoint],
    reference_prior: Option<CameraReferencePrior>,
    options: GcpSolverOptions,
) -> f64 {
    let reprojection = observations
        .iter()
        .filter_map(|(point_index, measured)| {
            let projected = project_world(camera, points[*point_index].world).ok()?;
            Some(robust_cost(
                options.robust_loss,
                (projected.x_pixels - measured.x_pixels)
                    .hypot(projected.y_pixels - measured.y_pixels)
                    / options.reprojection_sigma_pixels,
            ))
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
    if snapshot.schema_version != 1 || snapshot.points.is_empty() {
        return Err(GcpOptimizationError::InvalidSnapshot);
    }
    if !snapshot
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
    for camera in cameras {
        camera.validate()?;
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
    let mut matrix = [[0.0; 3]; 3];
    let mut rhs = [0.0; 3];
    for (center, direction) in &rays {
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
            rhs[row] += dot3(projection[row], *center);
            for column in 0..3 {
                matrix[row][column] += projection[row][column];
            }
        }
    }
    let point = solve_3(matrix, rhs).ok_or(GcpOptimizationError::DegenerateRays)?;
    let ray_sum = rays
        .iter()
        .map(|(center, direction)| {
            let offset = sub3(point, *center);
            let perpendicular = sub3(offset, scale3(*direction, dot3(offset, *direction)));
            dot3(perpendicular, perpendicular)
        })
        .sum::<f64>();
    let ray_count = u32::try_from(rays.len()).unwrap_or(u32::MAX);
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
    let normalized = distort(
        [point[0] / point[2], point[1] / point[2]],
        radial,
        tangential,
    );
    Ok(ImageCoordinate {
        x_pixels: focal_x * normalized[0] + principal_x,
        y_pixels: focal_y * normalized[1] + principal_y,
    })
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

fn initial_transform(
    controls: &[&TriangulatedPoint],
    mode: GcpTransformMode,
) -> GcpSimilarityTransform {
    let spatial = controls
        .iter()
        .filter(|point| point.definition.role.uses_xy() && point.definition.role.uses_z())
        .copied()
        .collect::<Vec<_>>();
    let mut transform = if mode == GcpTransformMode::Similarity7 {
        horn_similarity(&spatial).unwrap_or_else(GcpSimilarityTransform::identity)
    } else {
        GcpSimilarityTransform::identity()
    };
    let mut sums = [0.0; 3];
    let mut counts = [0_u32; 3];
    for control in controls {
        let mapped = transform.apply(control.reconstruction);
        if control.definition.role.uses_xy() {
            sums[0] += control.definition.coordinate.east_meters - mapped[0];
            sums[1] += control.definition.coordinate.north_meters - mapped[1];
            counts[0] += 1;
            counts[1] += 1;
        }
        if control.definition.role.uses_z() {
            sums[2] += control.definition.coordinate.height_meters - mapped[2];
            counts[2] += 1;
        }
    }
    for axis in 0..3 {
        if counts[axis] > 0 {
            transform.translation_meters[axis] += sums[axis] / f64::from(counts[axis]);
        }
    }
    transform
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
        let robust = robust_weight(loss, normalized_norm);
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
            robust_cost(loss, normalized)
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
                    let distance = norm3(sub3(world, camera.center_world_meters)).max(MIN_DEPTH);
                    let horizontal_pixels = point.uncertainty.horizontal_stddev_meters
                        * camera.focal_x_pixels.max(camera.focal_y_pixels)
                        / distance;
                    let vertical_pixels = point.uncertainty.height_stddev_meters
                        * camera.focal_x_pixels.max(camera.focal_y_pixels)
                        / distance;
                    result.push(GcpCameraProjection {
                        point_id: point.id.clone(),
                        image_id: camera.image_id,
                        coordinate,
                        uncertainty: ProjectionUncertaintyEllipse {
                            semi_major_pixels: horizontal_pixels.max(vertical_pixels),
                            semi_minor_pixels: horizontal_pixels.min(vertical_pixels),
                            angle_degrees: 0.0,
                        },
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
    #[error("full similarity adjustment needs at least three XYZ controls")]
    SimilarityNeedsThreeSpatialControls,
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
        assert_eq!(result.tie_points.len(), 6);
        assert_eq!(result.fixed_gauge_camera_count, 2);
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
}
