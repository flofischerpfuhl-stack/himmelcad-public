//! Versioned contracts and bounded solvers for pre-commit import registration.
//!
//! Registration is deliberately separate from canonical I/O. Providers stage
//! source geometry; this module resolves an optional placement before a single
//! canonical commit. Persisted recipes never contain transient viewport picks.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::entity_model::Transform3d;
use crate::transform::{
    apply_similarity_3d, residual_report, ControlPair, EmpiricalModelKind, EmpiricalOp,
    ResidualReport, Similarity3D, WorldPoint,
};

/// Exact persisted registration-recipe revision.
pub const REGISTRATION_RECIPE_SCHEMA_VERSION: u32 = 1;
/// Maximum number of samples accepted by one interactive ICP preview.
pub const MAX_ICP_SAMPLES_PER_CLOUD: usize = 2_048;

/// Persistable method selection. Interactive observations are intentionally absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RegistrationMethod {
    /// Source coordinates are already correct or are transformed by a frozen CRS recipe.
    SourceCoordinates {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frozen_transform_sha256: Option<String>,
    },
    /// BIM/local model placement by source origin, target origin and project north.
    OriginAndProjectNorth {
        source_origin: WorldPoint,
        target_origin: WorldPoint,
        /// Clockwise bearing of model +Y from project +Y, in degrees.
        project_north_degrees: f64,
        #[serde(default = "unit_scale")]
        scale: f64,
    },
    /// User-authored coarse placement. The saved parameters are reusable.
    ManualPlacement { transform: Similarity3D },
    /// Requires fresh source/target picks for every run.
    PointPairs {
        model: EmpiricalModelKind,
        #[serde(default)]
        robust: RobustFitOptions,
        #[serde(default)]
        offer_icp_refinement: bool,
    },
    /// Requires fresh source/target samples and review for every run.
    Icp {
        mode: IcpMode,
        #[serde(default)]
        options: IcpOptions,
    },
}

fn unit_scale() -> f64 {
    1.0
}

/// Reusable recipe. `PointPairs` and `Icp` are method templates, not replayable picks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationRecipe {
    pub schema_version: u32,
    pub recipe_id: String,
    pub label: String,
    pub method: RegistrationMethod,
}

impl RegistrationRecipe {
    /// Whether a run must pause before commit for fresh viewport interaction.
    #[must_use]
    pub const fn requires_fresh_interaction(&self) -> bool {
        matches!(
            self.method,
            RegistrationMethod::PointPairs { .. } | RegistrationMethod::Icp { .. }
        )
    }

    /// Validates the persistable portion without accepting transient picks.
    pub fn validate(&self) -> Result<(), RegistrationError> {
        if self.schema_version != REGISTRATION_RECIPE_SCHEMA_VERSION {
            return Err(RegistrationError::UnsupportedSchema);
        }
        if self.recipe_id.trim().is_empty() || self.label.trim().is_empty() {
            return Err(RegistrationError::InvalidIdentity);
        }
        match &self.method {
            RegistrationMethod::SourceCoordinates {
                frozen_transform_sha256,
            } => {
                if frozen_transform_sha256
                    .as_ref()
                    .is_some_and(|hash| !is_sha256(hash))
                {
                    return Err(RegistrationError::InvalidTransformHash);
                }
            }
            RegistrationMethod::OriginAndProjectNorth {
                source_origin,
                target_origin,
                project_north_degrees,
                scale,
            } => {
                if !source_origin.is_finite()
                    || !target_origin.is_finite()
                    || !project_north_degrees.is_finite()
                    || !scale.is_finite()
                    || *scale <= 0.0
                {
                    return Err(RegistrationError::InvalidPlacement);
                }
            }
            RegistrationMethod::ManualPlacement { transform } => {
                validate_similarity(*transform)?;
            }
            RegistrationMethod::PointPairs { robust, .. } => robust.validate()?,
            RegistrationMethod::Icp { options, .. } => options.validate()?,
        }
        Ok(())
    }
}

/// One fresh, transient source/target observation from the dual viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationPointPair {
    pub pair_id: String,
    pub source: WorldPoint,
    pub target: WorldPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

/// Robust iteratively reweighted fit controls.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RobustFitOptions {
    pub maximum_iterations: u32,
    pub huber_delta_meters: f64,
    pub convergence_epsilon: f64,
}

impl Default for RobustFitOptions {
    fn default() -> Self {
        Self {
            maximum_iterations: 20,
            huber_delta_meters: 0.05,
            convergence_epsilon: 1e-10,
        }
    }
}

impl RobustFitOptions {
    fn validate(self) -> Result<(), RegistrationError> {
        if !(1..=100).contains(&self.maximum_iterations)
            || !self.huber_delta_meters.is_finite()
            || self.huber_delta_meters <= 0.0
            || !self.convergence_epsilon.is_finite()
            || self.convergence_epsilon <= 0.0
        {
            return Err(RegistrationError::InvalidFitOptions);
        }
        Ok(())
    }
}

/// Fine-registration objective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IcpMode {
    PointToPoint,
    PointToPlane,
}

/// Bounded deterministic ICP controls.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IcpOptions {
    pub maximum_iterations: u32,
    pub maximum_correspondence_distance: f64,
    pub convergence_translation_meters: f64,
    pub convergence_rotation_radians: f64,
    pub minimum_overlap_ratio: f64,
    pub huber_delta_meters: f64,
}

impl Default for IcpOptions {
    fn default() -> Self {
        Self {
            maximum_iterations: 30,
            maximum_correspondence_distance: 1.0,
            convergence_translation_meters: 0.0001,
            convergence_rotation_radians: 0.00001,
            minimum_overlap_ratio: 0.2,
            huber_delta_meters: 0.05,
        }
    }
}

impl IcpOptions {
    fn validate(self) -> Result<(), RegistrationError> {
        let finite_positive = [
            self.maximum_correspondence_distance,
            self.convergence_translation_meters,
            self.convergence_rotation_radians,
            self.huber_delta_meters,
        ]
        .into_iter()
        .all(|value| value.is_finite() && value > 0.0);
        if !(1..=100).contains(&self.maximum_iterations)
            || !finite_positive
            || !self.minimum_overlap_ratio.is_finite()
            || !(0.0..=1.0).contains(&self.minimum_overlap_ratio)
            || self.minimum_overlap_ratio == 0.0
        {
            return Err(RegistrationError::InvalidIcpOptions);
        }
        Ok(())
    }
}

/// One target sample. Normals are mandatory for point-to-plane ICP.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationTargetSample {
    pub position: WorldPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<WorldPoint>,
}

/// Preview diagnostics shown before the canonical import commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationPreview {
    pub transform: Similarity3D,
    pub residuals: ResidualReport,
    pub iterations: u32,
    pub matched_samples: u32,
    pub overlap_ratio: f64,
    pub converged: bool,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Observable pre-commit lifecycle. Only `ReadyToCommit` may publish staged I/O.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistrationPhase {
    Staged,
    AwaitingFreshInteraction,
    Previewing,
    ReadyToCommit,
    Committing,
    Completed,
    Cancelled,
    Failed,
}

/// Computes BIM/local placement from a coordinate origin and project-north bearing.
pub fn origin_and_project_north_transform(
    source_origin: WorldPoint,
    target_origin: WorldPoint,
    project_north_degrees: f64,
    scale: f64,
) -> Result<Similarity3D, RegistrationError> {
    if !source_origin.is_finite()
        || !target_origin.is_finite()
        || !project_north_degrees.is_finite()
        || !scale.is_finite()
        || scale <= 0.0
    {
        return Err(RegistrationError::InvalidPlacement);
    }
    // A clockwise bearing is a negative mathematical Z rotation.
    let rotation = -project_north_degrees.to_radians();
    let base = Similarity3D {
        tx: 0.0,
        ty: 0.0,
        tz: 0.0,
        rx_radians: 0.0,
        ry_radians: 0.0,
        rz_radians: rotation,
        scale,
    };
    let rotated_origin = apply_similarity_3d(base, source_origin);
    Ok(Similarity3D {
        tx: target_origin.x - rotated_origin.x,
        ty: target_origin.y - rotated_origin.y,
        tz: target_origin.z - rotated_origin.z,
        ..base
    })
}

/// Converts a registration similarity to the canonical column-major placement matrix.
#[must_use]
pub fn similarity_transform3d(value: Similarity3D) -> Transform3d {
    let (cx, sx) = (value.rx_radians.cos(), value.rx_radians.sin());
    let (cy, sy) = (value.ry_radians.cos(), value.ry_radians.sin());
    let (cz, sz) = (value.rz_radians.cos(), value.rz_radians.sin());
    let scale = value.scale;
    Transform3d([
        scale * cy * cz,
        scale * cy * sz,
        scale * -sy,
        0.0,
        scale * (sx * sy * cz - cx * sz),
        scale * (sx * sy * sz + cx * cz),
        scale * sx * cy,
        0.0,
        scale * (cx * sy * cz + sx * sz),
        scale * (cx * sy * sz - sx * cz),
        scale * cx * cy,
        0.0,
        value.tx,
        value.ty,
        value.tz,
        1.0,
    ])
}

/// Composes column-major affine placements as `outer * inner`.
#[must_use]
pub fn compose_placement(outer: Transform3d, inner: Transform3d) -> Transform3d {
    let mut result = [0.0_f64; 16];
    for column in 0..4 {
        for row in 0..4 {
            result[column * 4 + row] = (0..4)
                .map(|index| outer.0[index * 4 + row] * inner.0[column * 4 + index])
                .sum();
        }
    }
    Transform3d(result)
}

/// Fits a robust 3D rigid/similarity transform from fresh point pairs.
pub fn fit_point_pairs_3d(
    pairs: &[RegistrationPointPair],
    allow_scale: bool,
    options: RobustFitOptions,
) -> Result<RegistrationPreview, RegistrationError> {
    options.validate()?;
    let matched_samples =
        u32::try_from(pairs.len()).map_err(|_| RegistrationError::TooManyPointPairs)?;
    if pairs.len() < 3 {
        return Err(RegistrationError::InsufficientPointPairs);
    }
    if pairs.iter().any(|pair| {
        pair.pair_id.trim().is_empty()
            || !pair.source.is_finite()
            || !pair.target.is_finite()
            || pair
                .weight
                .is_some_and(|weight| !weight.is_finite() || weight <= 0.0)
    }) {
        return Err(RegistrationError::InvalidPointPair);
    }
    let mut weights = pairs
        .iter()
        .map(|pair| pair.weight.unwrap_or(1.0))
        .collect::<Vec<_>>();
    let mut transform = identity_similarity();
    let mut iterations = 0;
    let mut converged = false;
    for iteration in 0..options.maximum_iterations {
        iterations = iteration + 1;
        let next = fit_horn(
            &pairs.iter().map(|pair| pair.source).collect::<Vec<_>>(),
            &pairs.iter().map(|pair| pair.target).collect::<Vec<_>>(),
            &weights,
            allow_scale,
        )?;
        let delta = transform_delta(transform, next);
        transform = next;
        for (index, pair) in pairs.iter().enumerate() {
            let mapped = apply_similarity_3d(transform, pair.source);
            let residual = distance(mapped, pair.target);
            let robust = huber_weight(residual, options.huber_delta_meters);
            weights[index] = pair.weight.unwrap_or(1.0) * robust;
        }
        if delta < options.convergence_epsilon {
            converged = true;
            break;
        }
    }
    let controls = pairs
        .iter()
        .map(|pair| ControlPair {
            source: pair.source,
            target: pair.target,
            weight: pair.weight,
            id: Some(pair.pair_id.clone()),
        })
        .collect::<Vec<_>>();
    let residuals = residual_report(&controls, |point| apply_similarity_3d(transform, point));
    Ok(RegistrationPreview {
        transform,
        residuals,
        iterations,
        matched_samples,
        overlap_ratio: 1.0,
        converged,
        accepted: converged,
        warnings: (!converged)
            .then(|| "robust point-pair fit reached its iteration limit".to_owned())
            .into_iter()
            .collect(),
    })
}

/// Fits a robust 3D translation from one or more fresh point pairs.
pub fn fit_translation_point_pairs_3d(
    pairs: &[RegistrationPointPair],
    options: RobustFitOptions,
) -> Result<RegistrationPreview, RegistrationError> {
    options.validate()?;
    let matched_samples =
        u32::try_from(pairs.len()).map_err(|_| RegistrationError::TooManyPointPairs)?;
    if pairs.is_empty() {
        return Err(RegistrationError::InsufficientPointPairs);
    }
    if pairs.iter().any(|pair| {
        pair.pair_id.trim().is_empty()
            || !pair.source.is_finite()
            || !pair.target.is_finite()
            || pair
                .weight
                .is_some_and(|weight| !weight.is_finite() || weight <= 0.0)
    }) {
        return Err(RegistrationError::InvalidPointPair);
    }
    let mut weights = pairs
        .iter()
        .map(|pair| pair.weight.unwrap_or(1.0))
        .collect::<Vec<_>>();
    let mut transform = identity_similarity();
    let mut iterations = 0;
    let mut converged = false;
    for iteration in 0..options.maximum_iterations {
        iterations = iteration + 1;
        let weight_sum = weights.iter().sum::<f64>();
        if !weight_sum.is_finite() || weight_sum <= 0.0 {
            return Err(RegistrationError::InvalidPointPair);
        }
        let next = Similarity3D {
            tx: pairs
                .iter()
                .zip(&weights)
                .map(|(pair, weight)| weight * (pair.target.x - pair.source.x))
                .sum::<f64>()
                / weight_sum,
            ty: pairs
                .iter()
                .zip(&weights)
                .map(|(pair, weight)| weight * (pair.target.y - pair.source.y))
                .sum::<f64>()
                / weight_sum,
            tz: pairs
                .iter()
                .zip(&weights)
                .map(|(pair, weight)| weight * (pair.target.z - pair.source.z))
                .sum::<f64>()
                / weight_sum,
            ..identity_similarity()
        };
        let delta = transform_delta(transform, next);
        transform = next;
        for (index, pair) in pairs.iter().enumerate() {
            let residual = distance(apply_similarity_3d(transform, pair.source), pair.target);
            weights[index] =
                pair.weight.unwrap_or(1.0) * huber_weight(residual, options.huber_delta_meters);
        }
        if delta < options.convergence_epsilon {
            converged = true;
            break;
        }
    }
    let controls = pairs
        .iter()
        .map(|pair| ControlPair {
            source: pair.source,
            target: pair.target,
            weight: pair.weight,
            id: Some(pair.pair_id.clone()),
        })
        .collect::<Vec<_>>();
    let residuals = residual_report(&controls, |point| apply_similarity_3d(transform, point));
    Ok(RegistrationPreview {
        transform,
        residuals,
        iterations,
        matched_samples,
        overlap_ratio: 1.0,
        converged,
        accepted: converged,
        warnings: (!converged)
            .then(|| "robust point-pair translation reached its iteration limit".to_owned())
            .into_iter()
            .collect(),
    })
}

/// Bounded, deterministic ICP over prepared point/surface samples.
///
/// `progress` is called after every iteration and returning `false` cancels.
pub fn run_icp<F>(
    source: &[WorldPoint],
    target: &[RegistrationTargetSample],
    initial: Similarity3D,
    mode: IcpMode,
    options: IcpOptions,
    mut progress: F,
) -> Result<RegistrationPreview, RegistrationError>
where
    F: FnMut(u32, u32, f64) -> bool,
{
    options.validate()?;
    validate_similarity(initial)?;
    if source.len() < 3 || target.len() < 3 {
        return Err(RegistrationError::InsufficientIcpSamples);
    }
    if source.len() > MAX_ICP_SAMPLES_PER_CLOUD || target.len() > MAX_ICP_SAMPLES_PER_CLOUD {
        return Err(RegistrationError::TooManyIcpSamples);
    }
    if source.iter().any(|point| !point.is_finite())
        || target.iter().any(|sample| {
            !sample.position.is_finite()
                || sample.normal.is_some_and(|normal| {
                    !normal.is_finite() || squared_norm(normal) <= f64::EPSILON
                })
        })
    {
        return Err(RegistrationError::InvalidIcpSample);
    }
    if mode == IcpMode::PointToPlane && target.iter().any(|sample| sample.normal.is_none()) {
        return Err(RegistrationError::MissingTargetNormals);
    }

    let maximum_distance_squared = options.maximum_correspondence_distance.powi(2);
    let mut transform = initial;
    let mut iterations = 0;
    let mut matched = 0_usize;
    let mut overlap = 0.0;
    let mut converged = false;
    let mut last_pairs = Vec::new();
    for iteration in 0..options.maximum_iterations {
        let correspondences =
            nearest_correspondences(source, target, transform, maximum_distance_squared);
        matched = correspondences.len();
        overlap = matched as f64 / source.len() as f64;
        if matched < 3 || overlap < options.minimum_overlap_ratio {
            return Err(RegistrationError::InsufficientIcpOverlap {
                overlap,
                required: options.minimum_overlap_ratio,
            });
        }
        let before = transform;
        transform = match mode {
            IcpMode::PointToPoint => {
                let sources = correspondences
                    .iter()
                    .map(|item| source[item.source_index])
                    .collect::<Vec<_>>();
                let targets = correspondences
                    .iter()
                    .map(|item| target[item.target_index].position)
                    .collect::<Vec<_>>();
                let weights = correspondences
                    .iter()
                    .map(|item| {
                        huber_weight(item.distance_squared.sqrt(), options.huber_delta_meters)
                    })
                    .collect::<Vec<_>>();
                fit_horn(&sources, &targets, &weights, false)?
            }
            IcpMode::PointToPlane => point_to_plane_step(
                source,
                target,
                &correspondences,
                transform,
                options.huber_delta_meters,
            )?,
        };
        iterations = iteration + 1;
        last_pairs = correspondences;
        let translation_delta = ((transform.tx - before.tx).powi(2)
            + (transform.ty - before.ty).powi(2)
            + (transform.tz - before.tz).powi(2))
        .sqrt();
        let rotation_delta = ((transform.rx_radians - before.rx_radians).powi(2)
            + (transform.ry_radians - before.ry_radians).powi(2)
            + (transform.rz_radians - before.rz_radians).powi(2))
        .sqrt();
        if !progress(iterations, options.maximum_iterations, overlap) {
            return Err(RegistrationError::Cancelled);
        }
        if translation_delta <= options.convergence_translation_meters
            && rotation_delta <= options.convergence_rotation_radians
        {
            converged = true;
            break;
        }
    }
    let controls = last_pairs
        .iter()
        .enumerate()
        .map(|(index, item)| ControlPair {
            source: source[item.source_index],
            target: target[item.target_index].position,
            weight: None,
            id: Some(format!("icp-{index}")),
        })
        .collect::<Vec<_>>();
    let residuals = residual_report(&controls, |point| apply_similarity_3d(transform, point));
    let accepted = converged && overlap >= options.minimum_overlap_ratio;
    Ok(RegistrationPreview {
        transform,
        residuals,
        iterations,
        matched_samples: matched as u32,
        overlap_ratio: overlap,
        converged,
        accepted,
        warnings: (!converged)
            .then(|| "ICP reached its iteration limit; review before commit".to_owned())
            .into_iter()
            .collect(),
    })
}

#[derive(Debug, Clone, Copy)]
struct Correspondence {
    source_index: usize,
    target_index: usize,
    distance_squared: f64,
}

fn nearest_correspondences(
    source: &[WorldPoint],
    target: &[RegistrationTargetSample],
    transform: Similarity3D,
    maximum_distance_squared: f64,
) -> Vec<Correspondence> {
    let mut result = Vec::with_capacity(source.len());
    for (source_index, source_point) in source.iter().enumerate() {
        let mapped = apply_similarity_3d(transform, *source_point);
        let mut best_index = 0_usize;
        let mut best_distance = maximum_distance_squared;
        for (target_index, sample) in target.iter().enumerate() {
            let candidate = squared_distance(mapped, sample.position);
            if candidate < best_distance {
                best_distance = candidate;
                best_index = target_index;
            }
        }
        if best_distance < maximum_distance_squared {
            result.push(Correspondence {
                source_index,
                target_index: best_index,
                distance_squared: best_distance,
            });
        }
    }
    result
}

fn point_to_plane_step(
    source: &[WorldPoint],
    target: &[RegistrationTargetSample],
    correspondences: &[Correspondence],
    current: Similarity3D,
    huber_delta: f64,
) -> Result<Similarity3D, RegistrationError> {
    let mut normal = [[0.0_f64; 6]; 6];
    let mut rhs = [0.0_f64; 6];
    for item in correspondences {
        let point = apply_similarity_3d(current, source[item.source_index]);
        let sample = target[item.target_index];
        let n = normalize(
            sample
                .normal
                .ok_or(RegistrationError::MissingTargetNormals)?,
        );
        let residual = dot(n, subtract(point, sample.position));
        let cross = cross_product(point, n);
        let jacobian = [cross.x, cross.y, cross.z, n.x, n.y, n.z];
        let weight = huber_weight(residual.abs(), huber_delta);
        for row in 0..6 {
            rhs[row] -= weight * jacobian[row] * residual;
            for column in 0..6 {
                normal[row][column] += weight * jacobian[row] * jacobian[column];
            }
        }
    }
    let delta = solve_linear_6(normal, rhs).ok_or(RegistrationError::DegenerateGeometry)?;
    // Small increments are composed in the global working frame. Fine ICP intentionally keeps scale.
    Ok(Similarity3D {
        tx: current.tx + delta[3],
        ty: current.ty + delta[4],
        tz: current.tz + delta[5],
        rx_radians: current.rx_radians + delta[0],
        ry_radians: current.ry_radians + delta[1],
        rz_radians: current.rz_radians + delta[2],
        scale: current.scale,
    })
}

fn fit_horn(
    source: &[WorldPoint],
    target: &[WorldPoint],
    weights: &[f64],
    allow_scale: bool,
) -> Result<Similarity3D, RegistrationError> {
    if source.len() != target.len() || source.len() != weights.len() || source.len() < 3 {
        return Err(RegistrationError::InsufficientPointPairs);
    }
    let weight_sum: f64 = weights.iter().sum();
    if !weight_sum.is_finite() || weight_sum <= 0.0 {
        return Err(RegistrationError::DegenerateGeometry);
    }
    let source_center = weighted_center(source, weights, weight_sum);
    let target_center = weighted_center(target, weights, weight_sum);
    let mut covariance = [[0.0_f64; 3]; 3];
    let mut source_variance = 0.0;
    for index in 0..source.len() {
        let a = subtract(source[index], source_center);
        let b = subtract(target[index], target_center);
        let weight = weights[index];
        let av = [a.x, a.y, a.z];
        let bv = [b.x, b.y, b.z];
        source_variance += weight * squared_norm(a);
        for (covariance_row, av_component) in covariance.iter_mut().zip(av) {
            for (covariance_value, bv_component) in covariance_row.iter_mut().zip(bv) {
                *covariance_value += weight * av_component * bv_component;
            }
        }
    }
    if source_variance <= f64::EPSILON {
        return Err(RegistrationError::DegenerateGeometry);
    }
    let s = covariance;
    let trace = s[0][0] + s[1][1] + s[2][2];
    let horn = [
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
    let quaternion = dominant_eigenvector(horn);
    let rotation = quaternion_matrix(quaternion);
    let mut numerator = 0.0;
    if allow_scale {
        for index in 0..source.len() {
            let a = subtract(source[index], source_center);
            let b = subtract(target[index], target_center);
            numerator += weights[index] * dot(rotate(rotation, a), b);
        }
    }
    let scale = if allow_scale {
        numerator / source_variance
    } else {
        1.0
    };
    if !scale.is_finite() || scale <= 0.0 {
        return Err(RegistrationError::DegenerateGeometry);
    }
    let angles = matrix_to_euler_zyx(rotation);
    let rotated_center = scale_point(rotate(rotation, source_center), scale);
    let translation = subtract(target_center, rotated_center);
    Ok(Similarity3D {
        tx: translation.x,
        ty: translation.y,
        tz: translation.z,
        rx_radians: angles.x,
        ry_radians: angles.y,
        rz_radians: angles.z,
        scale,
    })
}

fn dominant_eigenvector(matrix: [[f64; 4]; 4]) -> [f64; 4] {
    let mut vector = [1.0_f64, 0.0, 0.0, 0.0];
    for _ in 0..80 {
        let mut next = [0.0; 4];
        for (next_value, matrix_row) in next.iter_mut().zip(matrix) {
            for (matrix_value, vector_value) in matrix_row.iter().zip(vector) {
                *next_value += matrix_value * vector_value;
            }
        }
        let norm = next.iter().map(|value| value * value).sum::<f64>().sqrt();
        if norm <= f64::EPSILON {
            break;
        }
        for value in &mut next {
            *value /= norm;
        }
        vector = next;
    }
    vector
}

fn quaternion_matrix(q: [f64; 4]) -> [[f64; 3]; 3] {
    let [w, x, y, z] = q;
    [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - z * w),
            2.0 * (x * z + y * w),
        ],
        [
            2.0 * (x * y + z * w),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - x * w),
        ],
        [
            2.0 * (x * z - y * w),
            2.0 * (y * z + x * w),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ]
}

fn matrix_to_euler_zyx(matrix: [[f64; 3]; 3]) -> WorldPoint {
    let ry = (-matrix[2][0]).asin();
    let cy = ry.cos();
    if cy.abs() > 1e-12 {
        WorldPoint::new(
            matrix[2][1].atan2(matrix[2][2]),
            ry,
            matrix[1][0].atan2(matrix[0][0]),
        )
    } else {
        WorldPoint::new(0.0, ry, (-matrix[0][1]).atan2(matrix[1][1]))
    }
}

fn solve_linear_6(mut matrix: [[f64; 6]; 6], mut rhs: [f64; 6]) -> Option<[f64; 6]> {
    for pivot in 0..6 {
        let mut best = pivot;
        for row in (pivot + 1)..6 {
            if matrix[row][pivot].abs() > matrix[best][pivot].abs() {
                best = row;
            }
        }
        if matrix[best][pivot].abs() < 1e-14 {
            return None;
        }
        matrix.swap(pivot, best);
        rhs.swap(pivot, best);
        let diagonal = matrix[pivot][pivot];
        for column in pivot..6 {
            matrix[pivot][column] /= diagonal;
        }
        rhs[pivot] /= diagonal;
        for row in 0..6 {
            if row == pivot {
                continue;
            }
            let factor = matrix[row][pivot];
            for column in pivot..6 {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    Some(rhs)
}

fn weighted_center(points: &[WorldPoint], weights: &[f64], weight_sum: f64) -> WorldPoint {
    let mut center = WorldPoint::new(0.0, 0.0, 0.0);
    for (point, weight) in points.iter().zip(weights) {
        center.x += point.x * weight;
        center.y += point.y * weight;
        center.z += point.z * weight;
    }
    scale_point(center, 1.0 / weight_sum)
}

fn validate_similarity(value: Similarity3D) -> Result<(), RegistrationError> {
    if [
        value.tx,
        value.ty,
        value.tz,
        value.rx_radians,
        value.ry_radians,
        value.rz_radians,
        value.scale,
    ]
    .into_iter()
    .all(f64::is_finite)
        && value.scale > 0.0
    {
        Ok(())
    } else {
        Err(RegistrationError::InvalidPlacement)
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn identity_similarity() -> Similarity3D {
    Similarity3D {
        tx: 0.0,
        ty: 0.0,
        tz: 0.0,
        rx_radians: 0.0,
        ry_radians: 0.0,
        rz_radians: 0.0,
        scale: 1.0,
    }
}

fn huber_weight(residual: f64, delta: f64) -> f64 {
    if residual <= delta {
        1.0
    } else {
        delta / residual.max(f64::EPSILON)
    }
}

fn transform_delta(a: Similarity3D, b: Similarity3D) -> f64 {
    [
        a.tx - b.tx,
        a.ty - b.ty,
        a.tz - b.tz,
        a.rx_radians - b.rx_radians,
        a.ry_radians - b.ry_radians,
        a.rz_radians - b.rz_radians,
        a.scale - b.scale,
    ]
    .into_iter()
    .map(|value| value * value)
    .sum::<f64>()
    .sqrt()
}

fn subtract(a: WorldPoint, b: WorldPoint) -> WorldPoint {
    WorldPoint::new(a.x - b.x, a.y - b.y, a.z - b.z)
}

fn scale_point(value: WorldPoint, scale: f64) -> WorldPoint {
    WorldPoint::new(value.x * scale, value.y * scale, value.z * scale)
}

fn dot(a: WorldPoint, b: WorldPoint) -> f64 {
    a.x * b.x + a.y * b.y + a.z * b.z
}

fn squared_norm(value: WorldPoint) -> f64 {
    dot(value, value)
}

fn squared_distance(a: WorldPoint, b: WorldPoint) -> f64 {
    squared_norm(subtract(a, b))
}

fn distance(a: WorldPoint, b: WorldPoint) -> f64 {
    squared_distance(a, b).sqrt()
}

fn cross_product(a: WorldPoint, b: WorldPoint) -> WorldPoint {
    WorldPoint::new(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    )
}

fn normalize(value: WorldPoint) -> WorldPoint {
    scale_point(value, 1.0 / squared_norm(value).sqrt())
}

fn rotate(matrix: [[f64; 3]; 3], value: WorldPoint) -> WorldPoint {
    WorldPoint::new(
        matrix[0][0] * value.x + matrix[0][1] * value.y + matrix[0][2] * value.z,
        matrix[1][0] * value.x + matrix[1][1] * value.y + matrix[1][2] * value.z,
        matrix[2][0] * value.x + matrix[2][1] * value.y + matrix[2][2] * value.z,
    )
}

/// Contract/solver failure with stable semantics for the sidecar RPC boundary.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum RegistrationError {
    #[error("unsupported registration recipe schema")]
    UnsupportedSchema,
    #[error("registration recipe identity is empty")]
    InvalidIdentity,
    #[error("frozen transform hash is invalid")]
    InvalidTransformHash,
    #[error("registration placement is invalid")]
    InvalidPlacement,
    #[error("robust fit options are invalid")]
    InvalidFitOptions,
    #[error("ICP options are invalid")]
    InvalidIcpOptions,
    #[error("at least three non-collinear point pairs are required")]
    InsufficientPointPairs,
    #[error("point-pair limit exceeded; pre-filter observations first")]
    TooManyPointPairs,
    #[error("a point-pair observation is invalid")]
    InvalidPointPair,
    #[error("at least three source and target ICP samples are required")]
    InsufficientIcpSamples,
    #[error("ICP sample limit exceeded; pre-sample prepared geometry first")]
    TooManyIcpSamples,
    #[error("an ICP sample is invalid")]
    InvalidIcpSample,
    #[error("point-to-plane ICP requires a valid target normal for every sample")]
    MissingTargetNormals,
    #[error("ICP overlap {overlap:.3} is below required {required:.3}")]
    InsufficientIcpOverlap { overlap: f64, required: f64 },
    #[error("registration geometry is degenerate")]
    DegenerateGeometry,
    #[error("registration was cancelled")]
    Cancelled,
}

/// Converts an accepted preview to the common transform-stage representation.
pub fn preview_empirical_op(
    preview: &RegistrationPreview,
) -> Result<EmpiricalOp, RegistrationError> {
    if !preview.accepted {
        return Err(RegistrationError::DegenerateGeometry);
    }
    Ok(EmpiricalOp::Similarity3D {
        model: preview.transform,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_never_serializes_transient_picks_and_requires_fresh_interaction() {
        let recipe = RegistrationRecipe {
            schema_version: 1,
            recipe_id: "site-pairs".into(),
            label: "Site point pairs".into(),
            method: RegistrationMethod::PointPairs {
                model: EmpiricalModelKind::Similarity3D,
                robust: RobustFitOptions::default(),
                offer_icp_refinement: true,
            },
        };
        recipe.validate().expect("recipe");
        assert!(recipe.requires_fresh_interaction());
        let json = serde_json::to_string(&recipe).expect("serialize");
        assert!(!json.contains("source\""));
        assert!(!json.contains("target\""));
    }

    #[test]
    fn origin_and_north_maps_exact_origin() {
        let source = WorldPoint::new(10.0, 20.0, 5.0);
        let target = WorldPoint::new(500.0, 900.0, 12.0);
        let transform =
            origin_and_project_north_transform(source, target, 30.0, 1.0).expect("placement");
        let mapped = apply_similarity_3d(transform, source);
        assert!(distance(mapped, target) < 1e-9);
    }

    #[test]
    fn robust_pair_fit_recovers_similarity_with_one_outlier() {
        let expected = Similarity3D {
            tx: 12.0,
            ty: -4.0,
            tz: 2.0,
            rx_radians: 0.01,
            ry_radians: -0.02,
            rz_radians: 0.08,
            scale: 1.002,
        };
        let source = [
            WorldPoint::new(0.0, 0.0, 0.0),
            WorldPoint::new(10.0, 0.0, 0.0),
            WorldPoint::new(0.0, 10.0, 0.0),
            WorldPoint::new(0.0, 0.0, 10.0),
            WorldPoint::new(5.0, 4.0, 3.0),
        ];
        let pairs = source
            .iter()
            .enumerate()
            .map(|(index, point)| RegistrationPointPair {
                pair_id: format!("p{index}"),
                source: *point,
                target: if index == 4 {
                    WorldPoint::new(100.0, 100.0, 100.0)
                } else {
                    apply_similarity_3d(expected, *point)
                },
                weight: (index == 4).then_some(0.01),
            })
            .collect::<Vec<_>>();
        let result = fit_point_pairs_3d(&pairs, true, RobustFitOptions::default()).expect("fit");
        assert!(
            distance(
                apply_similarity_3d(result.transform, source[1]),
                apply_similarity_3d(expected, source[1])
            ) < 0.1
        );
    }

    #[test]
    fn one_point_pair_fits_translation_without_rotation_or_scale() {
        let pair = RegistrationPointPair {
            pair_id: "p1".to_owned(),
            source: WorldPoint::new(4.0, -2.0, 8.0),
            target: WorldPoint::new(104.0, 18.0, 5.0),
            weight: None,
        };
        let result = fit_translation_point_pairs_3d(&[pair], RobustFitOptions::default())
            .expect("translation fit");
        assert!(result.accepted);
        assert!((result.transform.tx - 100.0).abs() < f64::EPSILON);
        assert!((result.transform.ty - 20.0).abs() < f64::EPSILON);
        assert!((result.transform.tz + 3.0).abs() < f64::EPSILON);
        assert!((result.transform.scale - 1.0).abs() < f64::EPSILON);
        assert!(result.transform.rx_radians.abs() < f64::EPSILON);
    }

    #[test]
    fn point_to_point_icp_reports_overlap_and_converges() {
        let source = vec![
            WorldPoint::new(0.0, 0.0, 0.0),
            WorldPoint::new(1.0, 0.0, 0.0),
            WorldPoint::new(0.0, 1.0, 0.0),
            WorldPoint::new(0.0, 0.0, 1.0),
        ];
        let target = source
            .iter()
            .map(|point| RegistrationTargetSample {
                position: WorldPoint::new(point.x + 0.1, point.y - 0.05, point.z + 0.02),
                normal: None,
            })
            .collect::<Vec<_>>();
        let result = run_icp(
            &source,
            &target,
            identity_similarity(),
            IcpMode::PointToPoint,
            IcpOptions::default(),
            |_, _, _| true,
        )
        .expect("ICP");
        assert!(result.accepted);
        assert_eq!(result.matched_samples, 4);
        assert!(result.residuals.rms_spatial_meters < 1e-9);
    }

    #[test]
    fn point_to_plane_requires_normals() {
        let points = vec![WorldPoint::new(0.0, 0.0, 0.0); 3];
        let target = points
            .iter()
            .map(|position| RegistrationTargetSample {
                position: *position,
                normal: None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            run_icp(
                &points,
                &target,
                identity_similarity(),
                IcpMode::PointToPlane,
                IcpOptions::default(),
                |_, _, _| true,
            ),
            Err(RegistrationError::MissingTargetNormals)
        );
    }
}
