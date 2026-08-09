//! Fast, non-publishing GCP feedback for a fixed camera state.
//!
//! This is deliberately not bundle adjustment. Camera poses and intrinsics are
//! immutable inputs; only one observed point is triangulated. The result is
//! revision- and camera-state-bound and may be persisted as a derived cache,
//! but it never becomes an optimized alignment or product lineage source.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;
use crate::photolab_gcp::{
    GcpObservation, GcpObservationState, GcpPointId, ImageCoordinate, ProjectionUncertaintyEllipse,
};
use crate::photolab_gcp_optimization::{GcpCameraModel, GcpRobustLoss};
use crate::photolab_matching::ImageId;

const MIN_DEPTH: f64 = 1.0e-9;
const MATRIX_EPSILON: f64 = 1.0e-12;
const DEFAULT_SIGMA_PIXELS: f64 = 0.25;

/// Immutable input for one immediate fixed-camera estimate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpLocalEstimateRequest {
    pub collection_sha256: ObjectHash,
    pub point_id: GcpPointId,
    pub cameras: Vec<GcpCameraModel>,
    pub observations: Vec<GcpObservation>,
    #[serde(default = "default_sigma_pixels")]
    pub observation_sigma_pixels: f64,
    #[serde(default)]
    pub robust_loss: GcpRobustLoss,
}

const fn default_sigma_pixels() -> f64 {
    DEFAULT_SIGMA_PIXELS
}

/// Robust pixel residual evaluated without changing its camera.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpLocalResidual {
    pub image_id: ImageId,
    pub measured: ImageCoordinate,
    pub predicted: ImageCoordinate,
    pub delta_pixels: [f64; 2],
    pub norm_pixels: f64,
    pub robust_weight: f64,
}

/// Predicted image marker and propagated one-sigma point uncertainty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpLocalProjection {
    pub point_id: GcpPointId,
    pub image_id: ImageId,
    pub coordinate: ImageCoordinate,
    pub uncertainty: ProjectionUncertaintyEllipse,
}

/// Conditioning and residual summary shown without claiming global accuracy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpLocalEstimateDiagnostics {
    pub usable_observation_count: u32,
    pub effective_observation_count: u32,
    pub iteration_count: u16,
    pub normal_condition_number: f64,
    pub reprojection_rms_pixels: f64,
    pub reprojection_max_pixels: f64,
    pub ray_intersection_rms: f64,
}

/// Derived local feedback. `publishes_alignment` is always false by contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpLocalEstimate {
    pub schema_version: u32,
    pub collection_sha256: ObjectHash,
    pub camera_state_sha256: ObjectHash,
    pub point_id: GcpPointId,
    pub coordinate_camera_state: [f64; 3],
    /// Row-major symmetric covariance in the fixed camera state's coordinates.
    pub covariance_camera_state: [f64; 9],
    pub residuals: Vec<GcpLocalResidual>,
    pub projections: Vec<GcpLocalProjection>,
    pub diagnostics: GcpLocalEstimateDiagnostics,
    pub publishes_alignment: bool,
}

/// Computes deterministic fixed-camera feedback after an observation edit.
pub fn estimate_gcp_locally(
    mut request: GcpLocalEstimateRequest,
) -> Result<GcpLocalEstimate, GcpLocalEstimateError> {
    validate_hash(&request.collection_sha256)?;
    if request.point_id.0.trim().is_empty()
        || !request.observation_sigma_pixels.is_finite()
        || request.observation_sigma_pixels <= 0.0
        || !valid_robust_loss(request.robust_loss)
    {
        return Err(GcpLocalEstimateError::InvalidRequest);
    }
    request.cameras.sort_by_key(|camera| camera.image_id);
    let camera_state_sha256 = camera_state_sha256(&request.cameras)?;
    let cameras = validate_cameras(&request.cameras)?;
    let observations = usable_observations(&request.point_id, &request.observations, &cameras)?;
    if observations.len() < 2 {
        return Err(GcpLocalEstimateError::TooFewObservations);
    }

    let (mut point, ray_intersection_rms) = ray_intersection(&observations)?;
    let mut iteration_count = 0_u16;
    for iteration in 0..12_u16 {
        let equations = point_normal_equations(
            point,
            &observations,
            request.observation_sigma_pixels,
            request.robust_loss,
        )?;
        let inverse =
            inverse_3(equations.normal).ok_or(GcpLocalEstimateError::DegenerateGeometry)?;
        let delta = mat3_vec(inverse, equations.gradient.map(|value| -value));
        if delta.iter().any(|value| !value.is_finite()) {
            return Err(GcpLocalEstimateError::DegenerateGeometry);
        }
        point = add3(point, delta);
        iteration_count = iteration + 1;
        if norm3(delta) <= 1.0e-10 * (1.0 + norm3(point)) {
            break;
        }
    }

    let equations = point_normal_equations(
        point,
        &observations,
        request.observation_sigma_pixels,
        request.robust_loss,
    )?;
    let inverse = inverse_3(equations.normal).ok_or(GcpLocalEstimateError::DegenerateGeometry)?;
    let degrees_of_freedom = (2 * equations.residuals.len()).saturating_sub(3).max(1);
    let residual_variance = (equations.weighted_squared_error
        / f64::from(u32::try_from(degrees_of_freedom).unwrap_or(u32::MAX)))
    .max(1.0);
    let covariance = scale_matrix(inverse, residual_variance);
    let condition = infinity_norm(equations.normal) * infinity_norm(inverse);
    if !condition.is_finite() || condition > 1.0e14 {
        return Err(GcpLocalEstimateError::IllConditioned { condition });
    }

    let residual_count = u32::try_from(equations.residuals.len()).unwrap_or(u32::MAX);
    let residual_sum = equations
        .residuals
        .iter()
        .map(|sample| sample.norm_pixels * sample.norm_pixels)
        .sum::<f64>();
    let residual_max = equations
        .residuals
        .iter()
        .map(|sample| sample.norm_pixels)
        .fold(0.0, f64::max);
    let effective_count = equations
        .residuals
        .iter()
        .filter(|sample| sample.robust_weight >= 0.25)
        .count();
    let projections = request
        .cameras
        .iter()
        .filter_map(|camera| local_projection(&request.point_id, camera, point, covariance).ok())
        .filter(|projection| {
            let camera = cameras[&projection.image_id];
            projection.coordinate.x_pixels >= 0.0
                && projection.coordinate.y_pixels >= 0.0
                && projection.coordinate.x_pixels < f64::from(camera.width_pixels)
                && projection.coordinate.y_pixels < f64::from(camera.height_pixels)
        })
        .collect::<Vec<_>>();

    Ok(GcpLocalEstimate {
        schema_version: 1,
        collection_sha256: request.collection_sha256,
        camera_state_sha256,
        point_id: request.point_id,
        coordinate_camera_state: point,
        covariance_camera_state: flatten_matrix(covariance),
        residuals: equations.residuals,
        projections,
        diagnostics: GcpLocalEstimateDiagnostics {
            usable_observation_count: residual_count,
            effective_observation_count: u32::try_from(effective_count).unwrap_or(u32::MAX),
            iteration_count,
            normal_condition_number: condition,
            reprojection_rms_pixels: (residual_sum / f64::from(residual_count)).sqrt(),
            reprojection_max_pixels: residual_max,
            ray_intersection_rms,
        },
        publishes_alignment: false,
    })
}

/// Hash binding an estimate to exact camera identities, poses and intrinsics.
pub fn camera_state_sha256(
    cameras: &[GcpCameraModel],
) -> Result<ObjectHash, GcpLocalEstimateError> {
    let mut ordered = cameras.to_vec();
    ordered.sort_by_key(|camera| camera.image_id);
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&ordered)?))
}

#[derive(Debug)]
struct PointEquations {
    normal: [[f64; 3]; 3],
    gradient: [f64; 3],
    weighted_squared_error: f64,
    residuals: Vec<GcpLocalResidual>,
}

fn point_normal_equations(
    point: [f64; 3],
    observations: &[UsableObservation<'_>],
    sigma_pixels: f64,
    loss: GcpRobustLoss,
) -> Result<PointEquations, GcpLocalEstimateError> {
    let mut normal = [[0.0; 3]; 3];
    let mut gradient = [0.0; 3];
    let mut weighted_squared_error = 0.0;
    let mut residuals = Vec::with_capacity(observations.len());
    for observation in observations {
        let (predicted, jacobian) = project_with_jacobian(observation.camera, point)?;
        let delta = [
            predicted.x_pixels - observation.measured.x_pixels,
            predicted.y_pixels - observation.measured.y_pixels,
        ];
        let norm = delta[0].hypot(delta[1]);
        let weight = robust_weight(loss, norm / sigma_pixels);
        let normal_weight = weight / sigma_pixels.powi(2);
        for row in 0..3 {
            gradient[row] +=
                normal_weight * (jacobian[0][row] * delta[0] + jacobian[1][row] * delta[1]);
            for column in 0..3 {
                normal[row][column] += normal_weight
                    * (jacobian[0][row] * jacobian[0][column]
                        + jacobian[1][row] * jacobian[1][column]);
            }
        }
        weighted_squared_error += weight * (norm / sigma_pixels).powi(2);
        residuals.push(GcpLocalResidual {
            image_id: observation.camera.image_id,
            measured: observation.measured,
            predicted,
            delta_pixels: delta,
            norm_pixels: norm,
            robust_weight: weight,
        });
    }
    if residuals.len() < 2 {
        return Err(GcpLocalEstimateError::TooFewObservations);
    }
    Ok(PointEquations {
        normal,
        gradient,
        weighted_squared_error,
        residuals,
    })
}

#[derive(Clone, Copy)]
struct UsableObservation<'a> {
    camera: &'a GcpCameraModel,
    measured: ImageCoordinate,
    ray: [f64; 3],
}

fn usable_observations<'a>(
    point_id: &GcpPointId,
    observations: &[GcpObservation],
    cameras: &'a BTreeMap<ImageId, &'a GcpCameraModel>,
) -> Result<Vec<UsableObservation<'a>>, GcpLocalEstimateError> {
    let mut images = BTreeSet::new();
    let mut result = Vec::new();
    for observation in observations {
        if &observation.point_id != point_id {
            continue;
        }
        let measured = match observation.state {
            GcpObservationState::Manual { coordinate }
            | GcpObservationState::Automatic { coordinate, .. } => coordinate,
            GcpObservationState::Predicted { .. } | GcpObservationState::Blocked { .. } => {
                continue;
            }
        };
        if !images.insert(observation.image_id) {
            return Err(GcpLocalEstimateError::DuplicateObservation(
                observation.image_id,
            ));
        }
        let camera = cameras
            .get(&observation.image_id)
            .copied()
            .ok_or(GcpLocalEstimateError::MissingCamera(observation.image_id))?;
        result.push(UsableObservation {
            camera,
            measured,
            ray: camera_ray(camera, measured)?,
        });
    }
    result.sort_by_key(|observation| observation.camera.image_id);
    Ok(result)
}

fn validate_cameras(
    cameras: &[GcpCameraModel],
) -> Result<BTreeMap<ImageId, &GcpCameraModel>, GcpLocalEstimateError> {
    let mut result = BTreeMap::new();
    for camera in cameras {
        if camera.width_pixels == 0
            || camera.height_pixels == 0
            || !camera.focal_x_pixels.is_finite()
            || !camera.focal_y_pixels.is_finite()
            || camera.focal_x_pixels <= 0.0
            || camera.focal_y_pixels <= 0.0
            || camera
                .camera_to_reconstruction_rotation
                .iter()
                .chain(camera.center_reconstruction.iter())
                .chain(camera.radial_distortion.iter())
                .chain(camera.tangential_distortion.iter())
                .chain([camera.principal_x_pixels, camera.principal_y_pixels].iter())
                .any(|value| !value.is_finite())
            || !is_rotation(camera.camera_to_reconstruction_rotation)
        {
            return Err(GcpLocalEstimateError::InvalidCamera(camera.image_id));
        }
        if result.insert(camera.image_id, camera).is_some() {
            return Err(GcpLocalEstimateError::DuplicateCamera(camera.image_id));
        }
    }
    Ok(result)
}

fn is_rotation(rotation: [f64; 9]) -> bool {
    let columns = [
        [rotation[0], rotation[3], rotation[6]],
        [rotation[1], rotation[4], rotation[7]],
        [rotation[2], rotation[5], rotation[8]],
    ];
    let orthonormal = (0..3).all(|row| {
        (0..3).all(|column| {
            let expected = if row == column { 1.0 } else { 0.0 };
            (dot3(columns[row], columns[column]) - expected).abs() <= 1.0e-6
        })
    });
    let determinant = rotation[0] * (rotation[4] * rotation[8] - rotation[5] * rotation[7])
        - rotation[1] * (rotation[3] * rotation[8] - rotation[5] * rotation[6])
        + rotation[2] * (rotation[3] * rotation[7] - rotation[4] * rotation[6]);
    orthonormal && (determinant - 1.0).abs() <= 1.0e-6
}

fn ray_intersection(
    observations: &[UsableObservation<'_>],
) -> Result<([f64; 3], f64), GcpLocalEstimateError> {
    let count = u32::try_from(observations.len()).unwrap_or(u32::MAX);
    let origin = scale3(
        observations.iter().fold([0.0; 3], |sum, observation| {
            add3(sum, observation.camera.center_reconstruction)
        }),
        1.0 / f64::from(count),
    );
    let mut normal = [[0.0; 3]; 3];
    let mut rhs = [0.0; 3];
    for observation in observations {
        let direction = observation.ray;
        let center = sub3(observation.camera.center_reconstruction, origin);
        for row in 0..3 {
            for column in 0..3 {
                let identity = if row == column { 1.0 } else { 0.0 };
                let value = identity - direction[row] * direction[column];
                normal[row][column] += value;
                rhs[row] += value * center[column];
            }
        }
    }
    let inverse = inverse_3(normal).ok_or(GcpLocalEstimateError::DegenerateGeometry)?;
    let point = add3(mat3_vec(inverse, rhs), origin);
    let sum = observations
        .iter()
        .map(|observation| {
            let offset = sub3(point, observation.camera.center_reconstruction);
            let perpendicular = sub3(
                offset,
                scale3(observation.ray, dot3(offset, observation.ray)),
            );
            dot3(perpendicular, perpendicular)
        })
        .sum::<f64>();
    Ok((point, (sum / f64::from(count)).sqrt()))
}

fn local_projection(
    point_id: &GcpPointId,
    camera: &GcpCameraModel,
    point: [f64; 3],
    covariance: [[f64; 3]; 3],
) -> Result<GcpLocalProjection, GcpLocalEstimateError> {
    let (coordinate, jacobian) = project_with_jacobian(camera, point)?;
    let projected_covariance = covariance_2d(jacobian, covariance);
    Ok(GcpLocalProjection {
        point_id: point_id.clone(),
        image_id: camera.image_id,
        coordinate,
        uncertainty: ellipse(projected_covariance)?,
    })
}

fn project_with_jacobian(
    camera: &GcpCameraModel,
    point: [f64; 3],
) -> Result<(ImageCoordinate, [[f64; 3]; 2]), GcpLocalEstimateError> {
    let rotation_t = [
        [
            camera.camera_to_reconstruction_rotation[0],
            camera.camera_to_reconstruction_rotation[3],
            camera.camera_to_reconstruction_rotation[6],
        ],
        [
            camera.camera_to_reconstruction_rotation[1],
            camera.camera_to_reconstruction_rotation[4],
            camera.camera_to_reconstruction_rotation[7],
        ],
        [
            camera.camera_to_reconstruction_rotation[2],
            camera.camera_to_reconstruction_rotation[5],
            camera.camera_to_reconstruction_rotation[8],
        ],
    ];
    let camera_point = mat3_vec(rotation_t, sub3(point, camera.center_reconstruction));
    if camera_point[2] <= MIN_DEPTH {
        return Err(GcpLocalEstimateError::PointBehindCamera(camera.image_id));
    }
    let x = camera_point[0] / camera_point[2];
    let y = camera_point[1] / camera_point[2];
    let distortion = distortion_jacobian(
        [x, y],
        camera.radial_distortion,
        camera.tangential_distortion,
    )?;
    let distorted = distort(
        [x, y],
        camera.radial_distortion,
        camera.tangential_distortion,
    );
    let coordinate = ImageCoordinate {
        x_pixels: camera.focal_x_pixels * distorted[0] + camera.principal_x_pixels,
        y_pixels: camera.focal_y_pixels * distorted[1] + camera.principal_y_pixels,
    };
    let inverse_z = 1.0 / camera_point[2];
    let normalized_jacobian = [
        [
            (rotation_t[0][0] - x * rotation_t[2][0]) * inverse_z,
            (rotation_t[0][1] - x * rotation_t[2][1]) * inverse_z,
            (rotation_t[0][2] - x * rotation_t[2][2]) * inverse_z,
        ],
        [
            (rotation_t[1][0] - y * rotation_t[2][0]) * inverse_z,
            (rotation_t[1][1] - y * rotation_t[2][1]) * inverse_z,
            (rotation_t[1][2] - y * rotation_t[2][2]) * inverse_z,
        ],
    ];
    let mut jacobian = [[0.0; 3]; 2];
    for column in 0..3 {
        jacobian[0][column] = camera.focal_x_pixels
            * (distortion[0][0] * normalized_jacobian[0][column]
                + distortion[0][1] * normalized_jacobian[1][column]);
        jacobian[1][column] = camera.focal_y_pixels
            * (distortion[1][0] * normalized_jacobian[0][column]
                + distortion[1][1] * normalized_jacobian[1][column]);
    }
    Ok((coordinate, jacobian))
}

fn camera_ray(
    camera: &GcpCameraModel,
    coordinate: ImageCoordinate,
) -> Result<[f64; 3], GcpLocalEstimateError> {
    if !coordinate.x_pixels.is_finite() || !coordinate.y_pixels.is_finite() {
        return Err(GcpLocalEstimateError::InvalidObservation);
    }
    let distorted = [
        (coordinate.x_pixels - camera.principal_x_pixels) / camera.focal_x_pixels,
        (coordinate.y_pixels - camera.principal_y_pixels) / camera.focal_y_pixels,
    ];
    let mut undistorted = distorted;
    for _ in 0..16 {
        let projected = distort(
            undistorted,
            camera.radial_distortion,
            camera.tangential_distortion,
        );
        let correction = [distorted[0] - projected[0], distorted[1] - projected[1]];
        undistorted = add2(undistorted, correction);
        if correction[0].hypot(correction[1]) < 1.0e-13 {
            break;
        }
    }
    let camera_direction = normalize3([undistorted[0], undistorted[1], 1.0])
        .ok_or(GcpLocalEstimateError::InvalidObservation)?;
    normalize3(mat3_vec(
        matrix_from_flat(camera.camera_to_reconstruction_rotation),
        camera_direction,
    ))
    .ok_or(GcpLocalEstimateError::InvalidObservation)
}

fn distortion_jacobian(
    point: [f64; 2],
    radial: [f64; 3],
    tangential: [f64; 2],
) -> Result<[[f64; 2]; 2], GcpLocalEstimateError> {
    let [x, y] = point;
    let r2 = x * x + y * y;
    let r4 = r2 * r2;
    let r6 = r4 * r2;
    let scale = 1.0 + radial[0] * r2 + radial[1] * r4 + radial[2] * r6;
    let derivative_scale = 2.0 * (radial[0] + 2.0 * radial[1] * r2 + 3.0 * radial[2] * r4);
    let ds_dx = x * derivative_scale;
    let ds_dy = y * derivative_scale;
    let [p1, p2] = tangential;
    let jacobian = [
        [
            scale + x * ds_dx + 2.0 * p1 * y + 6.0 * p2 * x,
            x * ds_dy + 2.0 * p1 * x + 2.0 * p2 * y,
        ],
        [
            y * ds_dx + 2.0 * p1 * x + 2.0 * p2 * y,
            scale + y * ds_dy + 6.0 * p1 * y + 2.0 * p2 * x,
        ],
    ];
    let determinant = jacobian[0][0] * jacobian[1][1] - jacobian[0][1] * jacobian[1][0];
    if jacobian.iter().flatten().all(|value| value.is_finite()) && determinant > 1.0e-10 {
        Ok(jacobian)
    } else {
        Err(GcpLocalEstimateError::InvalidDistortion)
    }
}

fn distort(point: [f64; 2], radial: [f64; 3], tangential: [f64; 2]) -> [f64; 2] {
    let r2 = point[0] * point[0] + point[1] * point[1];
    let scale = 1.0 + radial[0] * r2 + radial[1] * r2.powi(2) + radial[2] * r2.powi(3);
    [
        point[0] * scale
            + 2.0 * tangential[0] * point[0] * point[1]
            + tangential[1] * (r2 + 2.0 * point[0] * point[0]),
        point[1] * scale
            + tangential[0] * (r2 + 2.0 * point[1] * point[1])
            + 2.0 * tangential[1] * point[0] * point[1],
    ]
}

fn covariance_2d(jacobian: [[f64; 3]; 2], covariance: [[f64; 3]; 3]) -> [[f64; 2]; 2] {
    let mut result = [[0.0; 2]; 2];
    for row in 0..2 {
        for column in 0..2 {
            for (inner_row, covariance_row) in covariance.iter().enumerate() {
                for (inner_column, covariance_value) in covariance_row.iter().enumerate() {
                    result[row][column] += jacobian[row][inner_row]
                        * covariance_value
                        * jacobian[column][inner_column];
                }
            }
        }
    }
    result
}

fn ellipse(
    covariance: [[f64; 2]; 2],
) -> Result<ProjectionUncertaintyEllipse, GcpLocalEstimateError> {
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
        Err(GcpLocalEstimateError::DegenerateGeometry)
    }
}

fn robust_weight(loss: GcpRobustLoss, normalized: f64) -> f64 {
    match loss {
        GcpRobustLoss::Huber { threshold_sigma } => {
            if normalized <= threshold_sigma {
                1.0
            } else {
                threshold_sigma / normalized.max(MATRIX_EPSILON)
            }
        }
        GcpRobustLoss::Cauchy { scale_sigma } => 1.0 / (1.0 + (normalized / scale_sigma).powi(2)),
    }
}

fn valid_robust_loss(loss: GcpRobustLoss) -> bool {
    match loss {
        GcpRobustLoss::Huber { threshold_sigma } => {
            threshold_sigma.is_finite() && threshold_sigma > 0.0
        }
        GcpRobustLoss::Cauchy { scale_sigma } => scale_sigma.is_finite() && scale_sigma > 0.0,
    }
}

fn inverse_3(matrix: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let determinant = matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
    let scale = infinity_norm(matrix).powi(3).max(1.0);
    if !determinant.is_finite() || determinant.abs() <= MATRIX_EPSILON * scale {
        return None;
    }
    let inverse_determinant = 1.0 / determinant;
    Some([
        [
            (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) * inverse_determinant,
            (matrix[0][2] * matrix[2][1] - matrix[0][1] * matrix[2][2]) * inverse_determinant,
            (matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1]) * inverse_determinant,
        ],
        [
            (matrix[1][2] * matrix[2][0] - matrix[1][0] * matrix[2][2]) * inverse_determinant,
            (matrix[0][0] * matrix[2][2] - matrix[0][2] * matrix[2][0]) * inverse_determinant,
            (matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2]) * inverse_determinant,
        ],
        [
            (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]) * inverse_determinant,
            (matrix[0][1] * matrix[2][0] - matrix[0][0] * matrix[2][1]) * inverse_determinant,
            (matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]) * inverse_determinant,
        ],
    ])
}

fn validate_hash(hash: &ObjectHash) -> Result<(), GcpLocalEstimateError> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(GcpLocalEstimateError::InvalidRequest)
    }
}

fn infinity_norm(matrix: [[f64; 3]; 3]) -> f64 {
    matrix
        .iter()
        .map(|row| row.iter().map(|value| value.abs()).sum::<f64>())
        .fold(0.0, f64::max)
}

fn matrix_from_flat(value: [f64; 9]) -> [[f64; 3]; 3] {
    [
        [value[0], value[1], value[2]],
        [value[3], value[4], value[5]],
        [value[6], value[7], value[8]],
    ]
}

fn flatten_matrix(value: [[f64; 3]; 3]) -> [f64; 9] {
    [
        value[0][0],
        value[0][1],
        value[0][2],
        value[1][0],
        value[1][1],
        value[1][2],
        value[2][0],
        value[2][1],
        value[2][2],
    ]
}

fn scale_matrix(mut value: [[f64; 3]; 3], scale: f64) -> [[f64; 3]; 3] {
    for row in &mut value {
        for entry in row {
            *entry *= scale;
        }
    }
    value
}

fn mat3_vec(matrix: [[f64; 3]; 3], vector: [f64; 3]) -> [f64; 3] {
    [
        dot3(matrix[0], vector),
        dot3(matrix[1], vector),
        dot3(matrix[2], vector),
    ]
}

fn dot3(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn add2(left: [f64; 2], right: [f64; 2]) -> [f64; 2] {
    [left[0] + right[0], left[1] + right[1]]
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

fn norm3(value: [f64; 3]) -> f64 {
    dot3(value, value).sqrt()
}

fn normalize3(value: [f64; 3]) -> Option<[f64; 3]> {
    let norm = norm3(value);
    (norm.is_finite() && norm > MATRIX_EPSILON).then(|| scale3(value, 1.0 / norm))
}

#[derive(Debug, Error)]
pub enum GcpLocalEstimateError {
    #[error("invalid local GCP estimate request")]
    InvalidRequest,
    #[error("invalid fixed camera {0:?}")]
    InvalidCamera(ImageId),
    #[error("duplicate fixed camera {0:?}")]
    DuplicateCamera(ImageId),
    #[error("observation references missing camera {0:?}")]
    MissingCamera(ImageId),
    #[error("duplicate observation in camera {0:?}")]
    DuplicateObservation(ImageId),
    #[error("at least two usable observations are required")]
    TooFewObservations,
    #[error("invalid image observation")]
    InvalidObservation,
    #[error("point lies behind fixed camera {0:?}")]
    PointBehindCamera(ImageId),
    #[error("camera distortion is locally non-invertible")]
    InvalidDistortion,
    #[error("fixed-camera rays do not define a stable point")]
    DegenerateGeometry,
    #[error("fixed-camera point normal matrix is ill-conditioned ({condition:e})")]
    IllConditioned { condition: f64 },
    #[error("local estimate serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera(id: u32, x: f64) -> GcpCameraModel {
        GcpCameraModel {
            image_id: ImageId(id),
            calibration_group_id: "local-test-camera".into(),
            intrinsics_policy: crate::photolab_gcp_optimization::GcpIntrinsicsPolicy::Auto,
            width_pixels: 2_000,
            height_pixels: 1_500,
            focal_x_pixels: 1_000.0,
            focal_y_pixels: 1_000.0,
            principal_x_pixels: 1_000.0,
            principal_y_pixels: 750.0,
            radial_distortion: [0.01, -0.001, 0.0001],
            tangential_distortion: [0.0002, -0.0001],
            camera_to_reconstruction_rotation: [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0],
            center_reconstruction: [x, 0.0, 10.0],
            reference_center_world_meters: None,
            reference_stddev_meters: None,
        }
    }

    fn observation(camera: &GcpCameraModel, point: [f64; 3]) -> GcpObservation {
        let coordinate = project_with_jacobian(camera, point).expect("projection").0;
        GcpObservation {
            point_id: GcpPointId("P1".into()),
            image_id: camera.image_id,
            state: GcpObservationState::Manual { coordinate },
        }
    }

    #[test]
    fn fixed_camera_estimate_recovers_point_and_propagates_anisotropic_covariance() {
        let cameras = vec![camera(1, -4.0), camera(2, 4.0), camera(3, 0.0)];
        let point = [0.3, -0.2, 0.5];
        let observations = cameras
            .iter()
            .map(|camera| observation(camera, point))
            .collect();
        let estimate = estimate_gcp_locally(GcpLocalEstimateRequest {
            collection_sha256: ObjectHash::of_bytes(b"collection-v1"),
            point_id: GcpPointId("P1".into()),
            cameras,
            observations,
            observation_sigma_pixels: 0.25,
            robust_loss: GcpRobustLoss::default(),
        })
        .expect("local estimate");

        assert!(norm3(sub3(estimate.coordinate_camera_state, point)) < 1.0e-8);
        assert_eq!(estimate.projections.len(), 3);
        assert!(estimate
            .projections
            .iter()
            .all(|projection| projection.uncertainty.semi_major_pixels
                >= projection.uncertainty.semi_minor_pixels));
        assert!(estimate.diagnostics.normal_condition_number.is_finite());
        assert!(!estimate.publishes_alignment);
    }

    #[test]
    fn robust_estimate_limits_one_large_pixel_outlier() {
        let cameras = vec![
            camera(1, -5.0),
            camera(2, 5.0),
            camera(3, -1.0),
            camera(4, 1.0),
        ];
        let point = [0.4, 0.1, 0.2];
        let mut observations = cameras
            .iter()
            .map(|camera| observation(camera, point))
            .collect::<Vec<_>>();
        if let GcpObservationState::Manual { coordinate } = &mut observations[3].state {
            coordinate.x_pixels += 80.0;
            coordinate.y_pixels -= 60.0;
        }
        let estimate = estimate_gcp_locally(GcpLocalEstimateRequest {
            collection_sha256: ObjectHash::of_bytes(b"collection-v2"),
            point_id: GcpPointId("P1".into()),
            cameras,
            observations,
            observation_sigma_pixels: 0.5,
            robust_loss: GcpRobustLoss::Cauchy { scale_sigma: 2.5 },
        })
        .expect("robust estimate");

        assert!(norm3(sub3(estimate.coordinate_camera_state, point)) < 0.15);
        assert!(estimate
            .residuals
            .iter()
            .any(|residual| residual.robust_weight < 0.01));
    }

    #[test]
    fn camera_state_hash_is_order_independent_but_pose_bound() {
        let first = camera(1, -4.0);
        let mut second = camera(2, 4.0);
        let baseline = camera_state_sha256(&[first.clone(), second.clone()]).expect("hash");
        assert_eq!(
            baseline,
            camera_state_sha256(&[second.clone(), first]).expect("reordered hash")
        );
        second.center_reconstruction[0] += 0.01;
        assert_ne!(
            baseline,
            camera_state_sha256(&[camera(1, -4.0), second]).expect("changed hash")
        );
    }
}
