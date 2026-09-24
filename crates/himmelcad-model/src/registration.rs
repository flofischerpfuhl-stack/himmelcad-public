//! Neutral registration result and placement contracts.

use serde::{Deserialize, Serialize};

use crate::entity_model::Transform3d;
use crate::transform::{
    apply_similarity_3d, EmpiricalModelKind, ResidualReport, Similarity3D, WorldPoint,
};
use thiserror::Error;

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
    pub fn validate(self) -> Result<(), RegistrationError> {
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
    pub fn validate(self) -> Result<(), RegistrationError> {
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

pub fn validate_similarity(value: Similarity3D) -> Result<(), RegistrationError> {
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
