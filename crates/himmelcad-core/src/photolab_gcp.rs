//! Deterministic Ground Control Point contracts for Photolab.
//!
//! CSV decoding, camera projection and bundle adjustment run outside this
//! module. The authoritative core validates their inputs, freezes optimization
//! scopes and computes role-aware residual statistics.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{entity::EntityId, hash::ObjectHash, photolab_matching::ImageId};

const MINIMUM_USABLE_OBSERVATIONS: usize = 2;

/// Stable GCP identity within a project.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GcpPointId(pub String);

/// CSV column addressed by header or zero-based index.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum CsvColumnSelector {
    Header(String),
    Index(u16),
}

/// Decimal notation used by a GCP source file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvDecimalSeparator {
    Point,
    Comma,
}

/// Mapping contract consumed later by the IO CSV parser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCsvImportMapping {
    pub delimiter: char,
    pub decimal_separator: CsvDecimalSeparator,
    pub has_header: bool,
    pub name: CsvColumnSelector,
    pub east: CsvColumnSelector,
    pub north: CsvColumnSelector,
    pub height: CsvColumnSelector,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizontal_stddev: Option<CsvColumnSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_stddev: Option<CsvColumnSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north_stddev: Option<CsvColumnSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_stddev: Option<CsvColumnSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<CsvColumnSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<CsvColumnSelector>,
    pub default_role: GcpRole,
    pub default_uncertainty: GcpUncertainty,
}

impl GcpCsvImportMapping {
    /// Validates the mapping without opening or parsing a CSV file.
    pub fn validate(&self) -> Result<(), GcpError> {
        if self.delimiter == '\n' || self.delimiter == '\r' || self.delimiter == '\0' {
            return Err(GcpError::InvalidCsvMapping("invalid record delimiter"));
        }
        if self.decimal_separator == CsvDecimalSeparator::Comma && self.delimiter == ',' {
            return Err(GcpError::InvalidCsvMapping(
                "delimiter and decimal separator cannot both be comma",
            ));
        }
        if self.horizontal_stddev.is_some()
            && (self.east_stddev.is_some() || self.north_stddev.is_some())
        {
            return Err(GcpError::InvalidCsvMapping(
                "horizontal standard deviation cannot be combined with east or north standard deviation columns",
            ));
        }
        let required = [&self.name, &self.east, &self.north, &self.height];
        let mut selectors = BTreeSet::new();
        for selector in required
            .into_iter()
            .chain(self.horizontal_stddev.iter())
            .chain(self.east_stddev.iter())
            .chain(self.north_stddev.iter())
            .chain(self.height_stddev.iter())
            .chain(self.code.iter())
            .chain(self.role.iter())
        {
            validate_selector(selector)?;
            if !selectors.insert(selector) {
                return Err(GcpError::InvalidCsvMapping(
                    "one CSV column is mapped to multiple fields",
                ));
            }
        }
        self.default_uncertainty.validate()
    }
}

fn validate_selector(selector: &CsvColumnSelector) -> Result<(), GcpError> {
    if let CsvColumnSelector::Header(header) = selector {
        if header.trim().is_empty() {
            return Err(GcpError::InvalidCsvMapping("CSV header cannot be empty"));
        }
    }
    Ok(())
}

/// Role and coordinate mask of a project control point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpRole {
    ControlXyz,
    ControlXy,
    ControlZ,
    CheckpointXyz,
    CheckpointXy,
    CheckpointZ,
    Disabled,
}

impl GcpRole {
    /// Returns whether horizontal components participate mathematically.
    pub const fn uses_xy(self) -> bool {
        matches!(
            self,
            Self::ControlXyz | Self::ControlXy | Self::CheckpointXyz | Self::CheckpointXy
        )
    }

    /// Returns whether the height component participates mathematically.
    pub const fn uses_z(self) -> bool {
        matches!(
            self,
            Self::ControlXyz | Self::ControlZ | Self::CheckpointXyz | Self::CheckpointZ
        )
    }

    /// Returns whether the point constrains optimization.
    pub const fn is_control(self) -> bool {
        matches!(self, Self::ControlXyz | Self::ControlXy | Self::ControlZ)
    }

    /// Returns whether the point only evaluates the result.
    pub const fn is_checkpoint(self) -> bool {
        matches!(
            self,
            Self::CheckpointXyz | Self::CheckpointXy | Self::CheckpointZ
        )
    }

    /// Converts a control to the checkpoint with the same coordinate mask.
    pub const fn as_checkpoint(self) -> Option<Self> {
        match self {
            Self::ControlXyz => Some(Self::CheckpointXyz),
            Self::ControlXy => Some(Self::CheckpointXy),
            Self::ControlZ => Some(Self::CheckpointZ),
            _ => None,
        }
    }
}

/// Cartesian project coordinate; CRS and height datum remain project metadata.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCoordinate {
    pub east_meters: f64,
    pub north_meters: f64,
    pub height_meters: f64,
}

impl GcpCoordinate {
    fn validate(self) -> Result<(), GcpError> {
        validate_finite(self.east_meters, "east")?;
        validate_finite(self.north_meters, "north")?;
        validate_finite(self.height_meters, "height")
    }
}

/// Independent standard deviations for horizontal and height components.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpUncertainty {
    pub horizontal_stddev_meters: f64,
    /// Optional axis-specific override. Missing values use the common horizontal sigma.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_stddev_meters: Option<f64>,
    /// Optional axis-specific override. Missing values use the common horizontal sigma.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north_stddev_meters: Option<f64>,
    pub height_stddev_meters: f64,
}

impl GcpUncertainty {
    /// Rejects NaN, infinity and negative uncertainty.
    pub fn validate(self) -> Result<(), GcpError> {
        validate_non_negative_finite(self.horizontal_stddev_meters, "horizontal uncertainty")?;
        if let Some(value) = self.east_stddev_meters {
            validate_non_negative_finite(value, "east uncertainty")?;
        }
        if let Some(value) = self.north_stddev_meters {
            validate_non_negative_finite(value, "north uncertainty")?;
        }
        validate_non_negative_finite(self.height_stddev_meters, "height uncertainty")
    }

    #[must_use]
    pub fn east_stddev_meters(self) -> f64 {
        self.east_stddev_meters
            .unwrap_or(self.horizontal_stddev_meters)
    }

    #[must_use]
    pub fn north_stddev_meters(self) -> f64 {
        self.north_stddev_meters
            .unwrap_or(self.horizontal_stddev_meters)
    }
}

/// Authoritative GCP/checkpoint definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpPoint {
    pub id: GcpPointId,
    pub name: String,
    /// Immutable source code or description imported with the point.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    pub coordinate: GcpCoordinate,
    pub uncertainty: GcpUncertainty,
    pub role: GcpRole,
}

/// Pixel coordinate in the orientation-normalized source image.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCoordinate {
    pub x_pixels: f64,
    pub y_pixels: f64,
}

impl ImageCoordinate {
    fn validate(self) -> Result<(), GcpError> {
        validate_finite(self.x_pixels, "image x")?;
        validate_finite(self.y_pixels, "image y")
    }
}

/// Manual confirmation, automatic proposal, or intentionally unusable marker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum GcpObservationState {
    Manual {
        coordinate: ImageCoordinate,
    },
    Automatic {
        coordinate: ImageCoordinate,
        confidence_per_mille: u16,
    },
    /// Projection-only proposal. It is shown in the image view but never constrains optimization.
    Predicted {
        coordinate: ImageCoordinate,
        confidence_per_mille: u16,
        source: String,
    },
    Blocked {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        predicted_coordinate: Option<ImageCoordinate>,
        reason: String,
    },
}

impl GcpObservationState {
    fn validate(&self) -> Result<(), GcpError> {
        match self {
            Self::Manual { coordinate } => coordinate.validate(),
            Self::Automatic {
                coordinate,
                confidence_per_mille,
            } => {
                coordinate.validate()?;
                if *confidence_per_mille > 1_000 {
                    return Err(GcpError::InvalidObservation(
                        "automatic confidence must be in 0..=1000",
                    ));
                }
                Ok(())
            }
            Self::Predicted {
                coordinate,
                confidence_per_mille,
                source,
            } => {
                coordinate.validate()?;
                if *confidence_per_mille > 1_000 {
                    return Err(GcpError::InvalidObservation(
                        "predicted confidence must be in 0..=1000",
                    ));
                }
                if source.trim().is_empty() {
                    return Err(GcpError::InvalidObservation(
                        "predicted observation needs a source",
                    ));
                }
                Ok(())
            }
            Self::Blocked {
                predicted_coordinate,
                reason,
            } => {
                if let Some(coordinate) = predicted_coordinate {
                    coordinate.validate()?;
                }
                if reason.trim().is_empty() {
                    return Err(GcpError::InvalidObservation(
                        "blocked observation needs a reason",
                    ));
                }
                Ok(())
            }
        }
    }

    const fn is_usable(&self) -> bool {
        matches!(self, Self::Manual { .. } | Self::Automatic { .. })
    }
}

/// Unique point/image observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpObservation {
    pub point_id: GcpPointId,
    pub image_id: ImageId,
    pub state: GcpObservationState,
}

/// Pixel-space uncertainty ellipse of an expected camera projection.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionUncertaintyEllipse {
    pub semi_major_pixels: f64,
    pub semi_minor_pixels: f64,
    pub angle_degrees: f64,
}

impl ProjectionUncertaintyEllipse {
    /// Validates finite, non-negative and ordered semi-axes.
    pub fn validate(self) -> Result<(), GcpError> {
        validate_non_negative_finite(self.semi_major_pixels, "ellipse semi-major")?;
        validate_non_negative_finite(self.semi_minor_pixels, "ellipse semi-minor")?;
        validate_finite(self.angle_degrees, "ellipse angle")?;
        if self.semi_minor_pixels > self.semi_major_pixels {
            return Err(GcpError::InvalidProjection(
                "ellipse semi-major axis must not be smaller than semi-minor axis",
            ));
        }
        Ok(())
    }
}

/// Expected point projection in one aligned camera.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCameraProjection {
    pub point_id: GcpPointId,
    pub image_id: ImageId,
    pub coordinate: ImageCoordinate,
    pub uncertainty: ProjectionUncertaintyEllipse,
}

/// Validates references, uniqueness, numeric values and minimum observations.
pub fn validate_gcp_dataset(
    points: &[GcpPoint],
    observations: &[GcpObservation],
    projections: &[GcpCameraProjection],
) -> Result<(), GcpError> {
    validate_gcp_points(points)?;
    let mut point_ids = BTreeSet::new();
    for point in points {
        point_ids.insert(point.id.clone());
    }

    let mut observation_keys = BTreeSet::new();
    let mut usable_counts = BTreeMap::<GcpPointId, usize>::new();
    for observation in observations {
        if !point_ids.contains(&observation.point_id) {
            return Err(GcpError::UnknownPoint(observation.point_id.clone()));
        }
        let key = (observation.point_id.clone(), observation.image_id);
        if !observation_keys.insert(key) {
            return Err(GcpError::DuplicateObservation {
                point_id: observation.point_id.clone(),
                image_id: observation.image_id,
            });
        }
        observation.state.validate()?;
        if observation.state.is_usable() {
            *usable_counts
                .entry(observation.point_id.clone())
                .or_default() += 1;
        }
    }
    for point in points {
        if point.role != GcpRole::Disabled
            && usable_counts.get(&point.id).copied().unwrap_or_default()
                < MINIMUM_USABLE_OBSERVATIONS
        {
            return Err(GcpError::TooFewObservations {
                point_id: point.id.clone(),
                minimum: MINIMUM_USABLE_OBSERVATIONS,
            });
        }
    }

    let mut projection_keys = BTreeSet::new();
    for projection in projections {
        if !point_ids.contains(&projection.point_id) {
            return Err(GcpError::UnknownPoint(projection.point_id.clone()));
        }
        let key = (projection.point_id.clone(), projection.image_id);
        if !projection_keys.insert(key) {
            return Err(GcpError::DuplicateProjection {
                point_id: projection.point_id.clone(),
                image_id: projection.image_id,
            });
        }
        projection.coordinate.validate()?;
        projection.uncertainty.validate()?;
    }
    Ok(())
}

/// Validates imported points before any image observations exist.
pub fn validate_gcp_points(points: &[GcpPoint]) -> Result<(), GcpError> {
    let mut point_ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for point in points {
        if point.id.0.trim().is_empty() || point.name.trim().is_empty() {
            return Err(GcpError::InvalidPoint("point id and name cannot be empty"));
        }
        if !point_ids.insert(point.id.clone()) {
            return Err(GcpError::DuplicatePoint(point.id.clone()));
        }
        if !names.insert(point.name.trim()) {
            return Err(GcpError::DuplicatePointName(point.name.clone()));
        }
        point.coordinate.validate()?;
        point.uncertainty.validate()?;
    }
    Ok(())
}

/// Validates one observation against the current point catalog without minimum-count checks.
pub fn validate_gcp_observation(
    points: &[GcpPoint],
    observation: &GcpObservation,
) -> Result<(), GcpError> {
    validate_gcp_points(points)?;
    if !points.iter().any(|point| point.id == observation.point_id) {
        return Err(GcpError::UnknownPoint(observation.point_id.clone()));
    }
    observation.state.validate()
}

fn validate_finite(value: f64, field: &'static str) -> Result<(), GcpError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(GcpError::NonFiniteValue(field))
    }
}

fn validate_non_negative_finite(value: f64, field: &'static str) -> Result<(), GcpError> {
    validate_finite(value, field)?;
    if value < 0.0 {
        Err(GcpError::NegativeUncertainty(field))
    } else {
        Ok(())
    }
}

/// GCP domain validation failure.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GcpError {
    #[error("invalid CSV mapping: {0}")]
    InvalidCsvMapping(&'static str),
    #[error("invalid GCP: {0}")]
    InvalidPoint(&'static str),
    #[error("invalid GCP observation: {0}")]
    InvalidObservation(&'static str),
    #[error("invalid camera projection: {0}")]
    InvalidProjection(&'static str),
    #[error("non-finite value in {0}")]
    NonFiniteValue(&'static str),
    #[error("negative uncertainty in {0}")]
    NegativeUncertainty(&'static str),
    #[error("duplicate GCP id: {0:?}")]
    DuplicatePoint(GcpPointId),
    #[error("duplicate GCP name: {0}")]
    DuplicatePointName(String),
    #[error("unknown GCP id: {0:?}")]
    UnknownPoint(GcpPointId),
    #[error("duplicate observation for {point_id:?} in {image_id:?}")]
    DuplicateObservation {
        point_id: GcpPointId,
        image_id: ImageId,
    },
    #[error("duplicate camera projection for {point_id:?} in {image_id:?}")]
    DuplicateProjection {
        point_id: GcpPointId,
        image_id: ImageId,
    },
    #[error("GCP {point_id:?} needs at least {minimum} usable observations")]
    TooFewObservations {
        point_id: GcpPointId,
        minimum: usize,
    },
    #[error("invalid checkpoint selection: {0}")]
    InvalidCheckpointSelection(&'static str),
    #[error("invalid optimization scope: {0}")]
    InvalidOptimizationScope(&'static str),
    #[error("residual input is invalid: {0}")]
    InvalidResidual(&'static str),
}

/// Per-image reprojection error contributing to a point residual.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReprojectionErrorSample {
    pub image_id: ImageId,
    pub error_pixels: f64,
}

/// Role-aware reference residual for one GCP or checkpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpResidual {
    pub point_id: GcpPointId,
    pub role: GcpRole,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_stddev_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north_stddev_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_stddev_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizontal_meters: Option<f64>,
    /// Only XYZ roles have a mathematically defined 3D residual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_3d_meters: Option<f64>,
    pub active_component_norm_meters: f64,
    pub reprojection_rms_pixels: f64,
    pub reprojection_max_pixels: f64,
}

/// Computes a residual and applies the point's role mask before any statistic.
pub fn compute_gcp_residual(
    point: &GcpPoint,
    estimated: GcpCoordinate,
    reprojection_samples: &[ReprojectionErrorSample],
) -> Result<GcpResidual, GcpError> {
    if point.role == GcpRole::Disabled {
        return Err(GcpError::InvalidResidual(
            "disabled points do not produce residuals",
        ));
    }
    point.coordinate.validate()?;
    estimated.validate()?;
    if reprojection_samples.is_empty() {
        return Err(GcpError::InvalidResidual(
            "at least one reprojection sample is required",
        ));
    }
    let mut images = BTreeSet::new();
    let mut reprojection_sum_squared = 0.0;
    let mut reprojection_max = 0.0_f64;
    for sample in reprojection_samples {
        validate_non_negative_finite(sample.error_pixels, "reprojection error")?;
        if !images.insert(sample.image_id) {
            return Err(GcpError::InvalidResidual(
                "reprojection images must be unique per point",
            ));
        }
        reprojection_sum_squared += sample.error_pixels * sample.error_pixels;
        reprojection_max = reprojection_max.max(sample.error_pixels);
    }

    let raw_east = estimated.east_meters - point.coordinate.east_meters;
    let raw_north = estimated.north_meters - point.coordinate.north_meters;
    let raw_height = estimated.height_meters - point.coordinate.height_meters;
    let east = point.role.uses_xy().then_some(raw_east);
    let north = point.role.uses_xy().then_some(raw_north);
    let height = point.role.uses_z().then_some(raw_height);
    let horizontal = point.role.uses_xy().then_some(raw_east.hypot(raw_north));
    let spatial_3d = (point.role.uses_xy() && point.role.uses_z())
        .then_some(raw_east.hypot(raw_north).hypot(raw_height));
    let active_component_norm = match (horizontal, height) {
        (Some(horizontal), Some(height)) => horizontal.hypot(height),
        (Some(horizontal), None) => horizontal,
        (None, Some(height)) => height.abs(),
        (None, None) => 0.0,
    };
    let sample_count = u32::try_from(reprojection_samples.len())
        .map_err(|_| GcpError::InvalidResidual("too many reprojection samples"))?;

    Ok(GcpResidual {
        point_id: point.id.clone(),
        role: point.role,
        code: point.code.clone(),
        east_stddev_meters: Some(point.uncertainty.east_stddev_meters()),
        north_stddev_meters: Some(point.uncertainty.north_stddev_meters()),
        height_stddev_meters: Some(point.uncertainty.height_stddev_meters),
        east_meters: east,
        north_meters: north,
        height_meters: height,
        horizontal_meters: horizontal,
        spatial_3d_meters: spatial_3d,
        active_component_norm_meters: active_component_norm,
        reprojection_rms_pixels: (reprojection_sum_squared / f64::from(sample_count)).sqrt(),
        reprojection_max_pixels: reprojection_max,
    })
}

/// RMS and maximum statistics for one role class.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualStatistics {
    pub point_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_rms_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north_rms_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizontal_rms_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_rms_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_3d_rms_meters: Option<f64>,
    pub active_component_rms_meters: f64,
    pub reprojection_rms_pixels: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_east_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_north_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_horizontal_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_spatial_3d_meters: Option<f64>,
    pub max_active_component_meters: f64,
    pub max_reprojection_pixels: f64,
}

/// Statistics shown for one immutable optimization snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCheckpointStatistics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<ResidualStatistics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<ResidualStatistics>,
}

/// Aggregates controls and checkpoints independently with role-aware divisors.
pub fn aggregate_residual_statistics(
    residuals: &[GcpResidual],
) -> Result<ControlCheckpointStatistics, GcpError> {
    let mut point_ids = BTreeSet::new();
    let mut controls = Vec::new();
    let mut checkpoints = Vec::new();
    for residual in residuals {
        validate_residual(residual)?;
        if !point_ids.insert(residual.point_id.clone()) {
            return Err(GcpError::InvalidResidual(
                "each point may have only one aggregate residual",
            ));
        }
        if residual.role.is_control() {
            controls.push(residual);
        } else if residual.role.is_checkpoint() {
            checkpoints.push(residual);
        } else {
            return Err(GcpError::InvalidResidual(
                "disabled point in residual collection",
            ));
        }
    }
    Ok(ControlCheckpointStatistics {
        control: summarize_residuals(&controls)?,
        checkpoint: summarize_residuals(&checkpoints)?,
    })
}

fn validate_residual(residual: &GcpResidual) -> Result<(), GcpError> {
    let options = [
        residual.east_meters,
        residual.north_meters,
        residual.height_meters,
        residual.horizontal_meters,
        residual.spatial_3d_meters,
    ];
    for value in options.into_iter().flatten() {
        validate_finite(value, "residual")?;
    }
    for value in [
        residual.east_stddev_meters,
        residual.north_stddev_meters,
        residual.height_stddev_meters,
    ]
    .into_iter()
    .flatten()
    {
        validate_non_negative_finite(value, "point uncertainty")?;
    }
    validate_non_negative_finite(residual.active_component_norm_meters, "active residual")?;
    validate_non_negative_finite(residual.reprojection_rms_pixels, "reprojection RMS")?;
    validate_non_negative_finite(residual.reprojection_max_pixels, "reprojection maximum")?;
    let xy_mask_correct = residual.east_meters.is_some() == residual.role.uses_xy()
        && residual.north_meters.is_some() == residual.role.uses_xy()
        && residual.horizontal_meters.is_some() == residual.role.uses_xy();
    let z_mask_correct = residual.height_meters.is_some() == residual.role.uses_z();
    let spatial_mask_correct =
        residual.spatial_3d_meters.is_some() == (residual.role.uses_xy() && residual.role.uses_z());
    if xy_mask_correct && z_mask_correct && spatial_mask_correct {
        Ok(())
    } else {
        Err(GcpError::InvalidResidual(
            "residual components do not match the role mask",
        ))
    }
}

fn summarize_residuals(residuals: &[&GcpResidual]) -> Result<Option<ResidualStatistics>, GcpError> {
    if residuals.is_empty() {
        return Ok(None);
    }
    let point_count = u32::try_from(residuals.len())
        .map_err(|_| GcpError::InvalidResidual("too many residuals"))?;
    Ok(Some(ResidualStatistics {
        point_count,
        east_rms_meters: optional_rms(residuals.iter().filter_map(|r| r.east_meters)),
        north_rms_meters: optional_rms(residuals.iter().filter_map(|r| r.north_meters)),
        horizontal_rms_meters: optional_rms(residuals.iter().filter_map(|r| r.horizontal_meters)),
        height_rms_meters: optional_rms(residuals.iter().filter_map(|r| r.height_meters)),
        spatial_3d_rms_meters: optional_rms(residuals.iter().filter_map(|r| r.spatial_3d_meters)),
        active_component_rms_meters: rms(residuals.iter().map(|r| r.active_component_norm_meters)),
        reprojection_rms_pixels: rms(residuals.iter().map(|r| r.reprojection_rms_pixels)),
        max_east_meters: optional_max(residuals.iter().filter_map(|r| r.east_meters.map(f64::abs))),
        max_north_meters: optional_max(
            residuals
                .iter()
                .filter_map(|r| r.north_meters.map(f64::abs)),
        ),
        max_horizontal_meters: optional_max(residuals.iter().filter_map(|r| r.horizontal_meters)),
        max_height_meters: optional_max(
            residuals
                .iter()
                .filter_map(|r| r.height_meters.map(f64::abs)),
        ),
        max_spatial_3d_meters: optional_max(residuals.iter().filter_map(|r| r.spatial_3d_meters)),
        max_active_component_meters: residuals
            .iter()
            .map(|r| r.active_component_norm_meters)
            .fold(0.0, f64::max),
        max_reprojection_pixels: residuals
            .iter()
            .map(|r| r.reprojection_max_pixels)
            .fold(0.0, f64::max),
    }))
}

fn rms(values: impl Iterator<Item = f64>) -> f64 {
    let (sum, count) = values.fold((0.0, 0_u32), |(sum, count), value| {
        (sum + value * value, count + 1)
    });
    (sum / f64::from(count)).sqrt()
}

fn optional_rms(values: impl Iterator<Item = f64>) -> Option<f64> {
    let values = values.collect::<Vec<_>>();
    (!values.is_empty()).then(|| rms(values.into_iter()))
}

fn optional_max(values: impl Iterator<Item = f64>) -> Option<f64> {
    values.reduce(f64::max)
}

/// Grid dimensions and target count for deterministic checkpoint selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSelectionPolicy {
    pub target_count: u32,
    pub east_strata: u16,
    pub north_strata: u16,
    pub height_strata: u16,
}

/// One role transition proposed by checkpoint selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointAssignment {
    pub point_id: GcpPointId,
    pub previous_role: GcpRole,
    pub checkpoint_role: GcpRole,
}

/// Reproducible, spatially stratified checkpoint proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSelection {
    pub assignments: Vec<CheckpointAssignment>,
    pub eligible_control_count: u32,
    pub occupied_strata: u32,
}

#[derive(Debug, Clone, Copy)]
struct CoordinateBounds {
    east_min: f64,
    east_span: f64,
    north_min: f64,
    north_span: f64,
    height_min: f64,
    height_span: f64,
}

impl CoordinateBounds {
    fn from_points(points: &[&GcpPoint]) -> Self {
        let first = points[0].coordinate;
        let (mut east_min, mut east_max) = (first.east_meters, first.east_meters);
        let (mut north_min, mut north_max) = (first.north_meters, first.north_meters);
        let (mut height_min, mut height_max) = (first.height_meters, first.height_meters);
        for point in &points[1..] {
            east_min = east_min.min(point.coordinate.east_meters);
            east_max = east_max.max(point.coordinate.east_meters);
            north_min = north_min.min(point.coordinate.north_meters);
            north_max = north_max.max(point.coordinate.north_meters);
            height_min = height_min.min(point.coordinate.height_meters);
            height_max = height_max.max(point.coordinate.height_meters);
        }
        Self {
            east_min,
            east_span: east_max - east_min,
            north_min,
            north_span: north_max - north_min,
            height_min,
            height_span: height_max - height_min,
        }
    }

    fn normalized(self, coordinate: GcpCoordinate) -> [f64; 3] {
        [
            normalize(coordinate.east_meters, self.east_min, self.east_span),
            normalize(coordinate.north_meters, self.north_min, self.north_span),
            normalize(coordinate.height_meters, self.height_min, self.height_span),
        ]
    }
}

fn normalize(value: f64, minimum: f64, span: f64) -> f64 {
    if span == 0.0 {
        0.5
    } else {
        (value - minimum) / span
    }
}

/// Selects checkpoints without randomness and preserves each XYZ/XY/Z mask.
pub fn select_spatial_checkpoints(
    points: &[GcpPoint],
    policy: CheckpointSelectionPolicy,
) -> Result<CheckpointSelection, GcpError> {
    if policy.target_count == 0 {
        return Ok(CheckpointSelection {
            assignments: Vec::new(),
            eligible_control_count: u32::try_from(
                points.iter().filter(|p| p.role.is_control()).count(),
            )
            .unwrap_or(u32::MAX),
            occupied_strata: 0,
        });
    }
    if policy.east_strata == 0 || policy.north_strata == 0 || policy.height_strata == 0 {
        return Err(GcpError::InvalidCheckpointSelection(
            "all stratum dimensions must be positive",
        ));
    }
    let mut eligible = points
        .iter()
        .filter(|point| point.role.is_control())
        .collect::<Vec<_>>();
    for point in &eligible {
        point.coordinate.validate()?;
    }
    eligible.sort_by(|left, right| left.id.cmp(&right.id));
    if eligible.is_empty() {
        return Err(GcpError::InvalidCheckpointSelection(
            "no active control points are eligible",
        ));
    }
    let bounds = CoordinateBounds::from_points(&eligible);
    let mut strata = BTreeMap::<[u16; 3], Vec<&GcpPoint>>::new();
    for point in &eligible {
        let normalized = bounds.normalized(point.coordinate);
        let key = [
            stratum_index(normalized[0], policy.east_strata),
            stratum_index(normalized[1], policy.north_strata),
            stratum_index(normalized[2], policy.height_strata),
        ];
        strata.entry(key).or_default().push(point);
    }
    sort_points_within_strata(&mut strata, bounds, policy);
    let occupied_strata = u32::try_from(strata.len()).unwrap_or(u32::MAX);
    let target = usize::try_from(policy.target_count)
        .unwrap_or(usize::MAX)
        .min(eligible.len());
    let selected = choose_stratified_points(&strata, bounds, target);
    let mut assignments = selected
        .into_iter()
        .map(|point| CheckpointAssignment {
            point_id: point.id.clone(),
            previous_role: point.role,
            checkpoint_role: point
                .role
                .as_checkpoint()
                .expect("eligible points are controls"),
        })
        .collect::<Vec<_>>();
    assignments.sort_by(|left, right| left.point_id.cmp(&right.point_id));
    Ok(CheckpointSelection {
        assignments,
        eligible_control_count: u32::try_from(eligible.len()).unwrap_or(u32::MAX),
        occupied_strata,
    })
}

fn stratum_index(normalized: f64, count: u16) -> u16 {
    let normalized = normalized.clamp(0.0, 1.0);
    for index in 0..count {
        let upper_bound = f64::from(index + 1) / f64::from(count);
        if normalized < upper_bound {
            return index;
        }
    }
    count - 1
}

fn sort_points_within_strata(
    strata: &mut BTreeMap<[u16; 3], Vec<&GcpPoint>>,
    bounds: CoordinateBounds,
    policy: CheckpointSelectionPolicy,
) {
    for (key, points) in strata {
        let center = [
            (f64::from(key[0]) + 0.5) / f64::from(policy.east_strata),
            (f64::from(key[1]) + 0.5) / f64::from(policy.north_strata),
            (f64::from(key[2]) + 0.5) / f64::from(policy.height_strata),
        ];
        points.sort_by(|left, right| {
            let left_distance = squared_distance(bounds.normalized(left.coordinate), center);
            let right_distance = squared_distance(bounds.normalized(right.coordinate), center);
            left_distance
                .total_cmp(&right_distance)
                .then_with(|| left.id.cmp(&right.id))
        });
    }
}

fn choose_stratified_points<'a>(
    strata: &BTreeMap<[u16; 3], Vec<&'a GcpPoint>>,
    bounds: CoordinateBounds,
    target: usize,
) -> Vec<&'a GcpPoint> {
    let representatives = strata
        .values()
        .filter_map(|points| points.first().copied())
        .collect::<Vec<_>>();
    let mut selected = if target < representatives.len() {
        farthest_point_sample(&representatives, bounds, target, &[])
    } else {
        representatives
    };
    if selected.len() < target {
        let selected_ids = selected
            .iter()
            .map(|point| &point.id)
            .collect::<BTreeSet<_>>();
        let remaining = strata
            .values()
            .flatten()
            .copied()
            .filter(|point| !selected_ids.contains(&point.id))
            .collect::<Vec<_>>();
        let fill_count = target - selected.len();
        let fill = farthest_point_sample(&remaining, bounds, fill_count, &selected);
        selected.extend(fill);
    }
    selected
}

fn farthest_point_sample<'a>(
    candidates: &[&'a GcpPoint],
    bounds: CoordinateBounds,
    target: usize,
    seeds: &[&GcpPoint],
) -> Vec<&'a GcpPoint> {
    let mut remaining = candidates.to_vec();
    let mut context = seeds.to_vec();
    let mut selected = Vec::new();
    while selected.len() < target && !remaining.is_empty() {
        let best_index = remaining
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                let left_score = coverage_score(left, &context, bounds);
                let right_score = coverage_score(right, &context, bounds);
                left_score
                    .total_cmp(&right_score)
                    .then_with(|| right.id.cmp(&left.id))
            })
            .map(|(index, _)| index)
            .unwrap_or_default();
        let point = remaining.remove(best_index);
        context.push(point);
        selected.push(point);
    }
    selected
}

fn coverage_score(point: &GcpPoint, selected: &[&GcpPoint], bounds: CoordinateBounds) -> f64 {
    let coordinate = bounds.normalized(point.coordinate);
    if selected.is_empty() {
        squared_distance(coordinate, [0.5, 0.5, 0.5])
    } else {
        selected
            .iter()
            .map(|selected| squared_distance(coordinate, bounds.normalized(selected.coordinate)))
            .fold(f64::INFINITY, f64::min)
    }
}

fn squared_distance(first: [f64; 3], second: [f64; 3]) -> f64 {
    (first[0] - second[0]).powi(2) + (first[1] - second[1]).powi(2) + (first[2] - second[2]).powi(2)
}

/// Frozen user selection that gives residual panels an unambiguous scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationScope {
    pub label: String,
    pub point_ids: Vec<GcpPointId>,
    /// Image reference priors included in optimization; image observations are
    /// always selected through their points.
    pub camera_reference_image_ids: Vec<ImageId>,
}

/// Whether a frozen point constrains or only evaluates optimization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OptimizationPointParticipation {
    Control,
    Checkpoint,
}

/// Point frozen into an optimization snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationPointSnapshot {
    pub point: GcpPoint,
    pub participation: OptimizationPointParticipation,
}

/// Immutable optimization/evaluation input used to label subsequent errors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationSnapshot {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    pub scope: GcpOptimizationScope,
    pub points: Vec<OptimizationPointSnapshot>,
    pub observations: Vec<GcpObservation>,
}

/// Immutable label for every residual table and export derived from one optimization input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpResidualReportScope {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_entity_id: Option<EntityId>,
    pub label: String,
    pub collection_sha256: ObjectHash,
    pub optimization_snapshot_sha256: ObjectHash,
    pub control_point_ids: Vec<GcpPointId>,
    pub checkpoint_point_ids: Vec<GcpPointId>,
    pub camera_reference_image_ids: Vec<ImageId>,
}

/// Binds residuals to exact collection and optimization content hashes.
pub fn build_gcp_residual_report_scope(
    snapshot: &GcpOptimizationSnapshot,
    collection_sha256: ObjectHash,
    optimization_snapshot_sha256: ObjectHash,
) -> Result<GcpResidualReportScope, GcpError> {
    validate_sha256(&collection_sha256)?;
    validate_sha256(&optimization_snapshot_sha256)?;
    if snapshot.schema_version == 0 || snapshot.scope.label.trim().is_empty() {
        return Err(GcpError::InvalidResidual(
            "optimization snapshot metadata is invalid",
        ));
    }
    let mut control_point_ids = Vec::new();
    let mut checkpoint_point_ids = Vec::new();
    for point in &snapshot.points {
        match point.participation {
            OptimizationPointParticipation::Control => {
                control_point_ids.push(point.point.id.clone());
            }
            OptimizationPointParticipation::Checkpoint => {
                checkpoint_point_ids.push(point.point.id.clone());
            }
        }
    }
    control_point_ids.sort();
    checkpoint_point_ids.sort();
    Ok(GcpResidualReportScope {
        schema_version: 1,
        source_alignment_entity_id: snapshot.source_alignment_entity_id.clone(),
        label: snapshot.scope.label.clone(),
        collection_sha256,
        optimization_snapshot_sha256,
        control_point_ids,
        checkpoint_point_ids,
        camera_reference_image_ids: snapshot.scope.camera_reference_image_ids.clone(),
    })
}

fn validate_sha256(hash: &ObjectHash) -> Result<(), GcpError> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(GcpError::InvalidResidual("invalid content hash"))
    }
}

/// Validates and freezes point roles, camera-reference scope and observations.
pub fn build_optimization_snapshot(
    source_alignment_entity_id: Option<EntityId>,
    mut scope: GcpOptimizationScope,
    points: &[GcpPoint],
    observations: &[GcpObservation],
) -> Result<GcpOptimizationSnapshot, GcpError> {
    if scope.label.trim().is_empty() {
        return Err(GcpError::InvalidOptimizationScope(
            "scope label cannot be empty",
        ));
    }
    sort_unique(&mut scope.point_ids)?;
    sort_unique(&mut scope.camera_reference_image_ids)?;
    if scope.point_ids.is_empty() && scope.camera_reference_image_ids.len() < 3 {
        return Err(GcpError::InvalidOptimizationScope(
            "scope needs at least one GCP or three camera references",
        ));
    }
    let mut points_by_id = BTreeMap::new();
    for point in points {
        if points_by_id.insert(point.id.clone(), point).is_some() {
            return Err(GcpError::DuplicatePoint(point.id.clone()));
        }
    }
    let mut snapshots = Vec::new();
    for point_id in &scope.point_ids {
        let point = points_by_id
            .get(point_id)
            .ok_or_else(|| GcpError::UnknownPoint(point_id.clone()))?;
        let participation = if point.role.is_control() {
            OptimizationPointParticipation::Control
        } else if point.role.is_checkpoint() {
            OptimizationPointParticipation::Checkpoint
        } else {
            return Err(GcpError::InvalidOptimizationScope(
                "disabled points cannot enter optimization scope",
            ));
        };
        snapshots.push(OptimizationPointSnapshot {
            point: (*point).clone(),
            participation,
        });
    }
    if !snapshots.is_empty()
        && !snapshots
            .iter()
            .any(|point| point.participation == OptimizationPointParticipation::Control)
    {
        return Err(GcpError::InvalidOptimizationScope(
            "scope needs at least one control point",
        ));
    }
    let selected = scope.point_ids.iter().collect::<BTreeSet<_>>();
    let mut frozen_observations = observations
        .iter()
        .filter(|observation| selected.contains(&observation.point_id))
        .cloned()
        .collect::<Vec<_>>();
    frozen_observations.sort_by(|left, right| {
        left.point_id
            .cmp(&right.point_id)
            .then_with(|| left.image_id.cmp(&right.image_id))
    });
    validate_gcp_dataset(
        &snapshots
            .iter()
            .map(|snapshot| snapshot.point.clone())
            .collect::<Vec<_>>(),
        &frozen_observations,
        &[],
    )?;

    Ok(GcpOptimizationSnapshot {
        schema_version: 1,
        source_alignment_entity_id,
        scope,
        points: snapshots,
        observations: frozen_observations,
    })
}

fn sort_unique<T: Ord>(values: &mut Vec<T>) -> Result<(), GcpError> {
    values.sort();
    let previous_len = values.len();
    values.dedup();
    if values.len() == previous_len {
        Ok(())
    } else {
        Err(GcpError::InvalidOptimizationScope(
            "scope identifiers must be unique",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(id: &str, east: f64, north: f64, height: f64, role: GcpRole) -> GcpPoint {
        GcpPoint {
            id: GcpPointId(id.to_owned()),
            name: id.to_owned(),
            code: String::new(),
            coordinate: GcpCoordinate {
                east_meters: east,
                north_meters: north,
                height_meters: height,
            },
            uncertainty: GcpUncertainty {
                horizontal_stddev_meters: 0.01,
                east_stddev_meters: None,
                north_stddev_meters: None,
                height_stddev_meters: 0.02,
            },
            role,
        }
    }

    fn observations(point_id: &str) -> Vec<GcpObservation> {
        [1, 2]
            .into_iter()
            .map(|image| GcpObservation {
                point_id: GcpPointId(point_id.to_owned()),
                image_id: ImageId(image),
                state: GcpObservationState::Manual {
                    coordinate: ImageCoordinate {
                        x_pixels: 100.0 + f64::from(image),
                        y_pixels: 200.0,
                    },
                },
            })
            .collect()
    }

    #[test]
    fn csv_mapping_rejects_ambiguous_columns() {
        let mapping = GcpCsvImportMapping {
            delimiter: ';',
            decimal_separator: CsvDecimalSeparator::Comma,
            has_header: true,
            name: CsvColumnSelector::Header("name".to_owned()),
            east: CsvColumnSelector::Header("east".to_owned()),
            north: CsvColumnSelector::Header("north".to_owned()),
            height: CsvColumnSelector::Header("east".to_owned()),
            horizontal_stddev: None,
            east_stddev: None,
            north_stddev: None,
            height_stddev: None,
            code: None,
            role: None,
            default_role: GcpRole::ControlXyz,
            default_uncertainty: GcpUncertainty {
                horizontal_stddev_meters: 0.01,
                east_stddev_meters: None,
                north_stddev_meters: None,
                height_stddev_meters: 0.02,
            },
        };
        assert_eq!(
            mapping.validate(),
            Err(GcpError::InvalidCsvMapping(
                "one CSV column is mapped to multiple fields"
            ))
        );
    }

    #[test]
    fn dataset_requires_unique_point_image_observations_and_two_usable_images() {
        let gcp = point("G1", 1.0, 2.0, 3.0, GcpRole::ControlXyz);
        let one_observation = vec![observations("G1")[0].clone()];
        assert!(matches!(
            validate_gcp_dataset(&[gcp.clone()], &one_observation, &[]),
            Err(GcpError::TooFewObservations { .. })
        ));

        let duplicated = vec![observations("G1")[0].clone(); 2];
        assert!(matches!(
            validate_gcp_dataset(&[gcp.clone()], &duplicated, &[]),
            Err(GcpError::DuplicateObservation { .. })
        ));

        let manual_and_blocked = vec![
            observations("G1")[0].clone(),
            GcpObservation {
                point_id: GcpPointId("G1".to_owned()),
                image_id: ImageId(2),
                state: GcpObservationState::Blocked {
                    predicted_coordinate: Some(ImageCoordinate {
                        x_pixels: 120.0,
                        y_pixels: 220.0,
                    }),
                    reason: "outside image".to_owned(),
                },
            },
        ];
        assert!(matches!(
            validate_gcp_dataset(&[gcp], &manual_and_blocked, &[]),
            Err(GcpError::TooFewObservations { .. })
        ));
    }

    #[test]
    fn projection_ellipse_and_point_image_uniqueness_are_validated() {
        let point = point("G1", 1.0, 2.0, 3.0, GcpRole::ControlXyz);
        let projection = GcpCameraProjection {
            point_id: point.id.clone(),
            image_id: ImageId(1),
            coordinate: ImageCoordinate {
                x_pixels: 400.0,
                y_pixels: 300.0,
            },
            uncertainty: ProjectionUncertaintyEllipse {
                semi_major_pixels: 5.0,
                semi_minor_pixels: 2.0,
                angle_degrees: 35.0,
            },
        };
        assert!(
            validate_gcp_dataset(&[point.clone()], &observations("G1"), &[projection.clone()])
                .is_ok()
        );
        assert!(matches!(
            validate_gcp_dataset(
                &[point],
                &observations("G1"),
                &[projection.clone(), projection]
            ),
            Err(GcpError::DuplicateProjection { .. })
        ));
    }

    #[test]
    fn numeric_validation_rejects_nan_and_negative_uncertainty() {
        let mut invalid = point("G1", f64::NAN, 2.0, 3.0, GcpRole::ControlXyz);
        assert_eq!(
            validate_gcp_dataset(&[invalid.clone()], &observations("G1"), &[]),
            Err(GcpError::NonFiniteValue("east"))
        );
        invalid.coordinate.east_meters = 1.0;
        invalid.uncertainty.height_stddev_meters = -0.1;
        assert_eq!(
            validate_gcp_dataset(&[invalid], &observations("G1"), &[]),
            Err(GcpError::NegativeUncertainty("height uncertainty"))
        );
    }

    #[test]
    fn role_masking_excludes_unused_coordinates_mathematically() {
        let samples = [
            ReprojectionErrorSample {
                image_id: ImageId(1),
                error_pixels: 1.0,
            },
            ReprojectionErrorSample {
                image_id: ImageId(2),
                error_pixels: 3.0,
            },
        ];
        let xy = compute_gcp_residual(
            &point("XY", 10.0, 20.0, 30.0, GcpRole::ControlXy),
            GcpCoordinate {
                east_meters: 13.0,
                north_meters: 24.0,
                height_meters: 130.0,
            },
            &samples,
        )
        .expect("XY residual should compute");
        assert_eq!(xy.horizontal_meters, Some(5.0));
        assert_eq!(xy.height_meters, None);
        assert_eq!(xy.spatial_3d_meters, None);
        assert!((xy.active_component_norm_meters - 5.0).abs() < f64::EPSILON);

        let z = compute_gcp_residual(
            &point("Z", 10.0, 20.0, 30.0, GcpRole::CheckpointZ),
            GcpCoordinate {
                east_meters: 999.0,
                north_meters: 999.0,
                height_meters: 34.0,
            },
            &samples,
        )
        .expect("Z residual should compute");
        assert_eq!(z.east_meters, None);
        assert_eq!(z.height_meters, Some(4.0));
        assert!((z.active_component_norm_meters - 4.0).abs() < f64::EPSILON);
    }

    #[test]
    fn statistics_keep_controls_and_checkpoints_separate() {
        let samples = [ReprojectionErrorSample {
            image_id: ImageId(1),
            error_pixels: 2.0,
        }];
        let control = compute_gcp_residual(
            &point("C", 0.0, 0.0, 0.0, GcpRole::ControlXyz),
            GcpCoordinate {
                east_meters: 3.0,
                north_meters: 4.0,
                height_meters: 12.0,
            },
            &samples,
        )
        .expect("control residual should compute");
        let checkpoint = compute_gcp_residual(
            &point("K", 0.0, 0.0, 0.0, GcpRole::CheckpointZ),
            GcpCoordinate {
                east_meters: 100.0,
                north_meters: 100.0,
                height_meters: 2.0,
            },
            &samples,
        )
        .expect("checkpoint residual should compute");
        let statistics = aggregate_residual_statistics(&[control, checkpoint])
            .expect("statistics should aggregate");

        let control = statistics.control.expect("control summary");
        assert_eq!(control.east_rms_meters, Some(3.0));
        assert_eq!(control.north_rms_meters, Some(4.0));
        assert_eq!(control.horizontal_rms_meters, Some(5.0));
        assert_eq!(control.height_rms_meters, Some(12.0));
        assert_eq!(control.spatial_3d_rms_meters, Some(13.0));
        assert_eq!(control.reprojection_rms_pixels, 2.0);
        let checkpoint = statistics.checkpoint.expect("checkpoint summary");
        assert_eq!(checkpoint.east_rms_meters, None);
        assert_eq!(checkpoint.north_rms_meters, None);
        assert_eq!(checkpoint.height_rms_meters, Some(2.0));
        assert_eq!(checkpoint.horizontal_rms_meters, None);
        assert_eq!(checkpoint.spatial_3d_rms_meters, None);
        assert_eq!(checkpoint.reprojection_rms_pixels, 2.0);
    }

    #[test]
    fn checkpoint_selection_is_deterministic_spatial_and_preserves_mask() {
        let points = vec![
            point("A", 0.0, 0.0, 0.0, GcpRole::ControlXyz),
            point("B", 100.0, 0.0, 0.0, GcpRole::ControlXy),
            point("C", 0.0, 100.0, 20.0, GcpRole::ControlZ),
            point("D", 100.0, 100.0, 20.0, GcpRole::ControlXyz),
            point("E", 50.0, 50.0, 10.0, GcpRole::Disabled),
        ];
        let policy = CheckpointSelectionPolicy {
            target_count: 3,
            east_strata: 2,
            north_strata: 2,
            height_strata: 2,
        };
        let first = select_spatial_checkpoints(&points, policy).expect("selection should work");
        let repeated =
            select_spatial_checkpoints(&points, policy).expect("selection should repeat");
        assert_eq!(first, repeated);
        assert_eq!(first.assignments.len(), 3);
        assert!(first.assignments.iter().all(|assignment| matches!(
            (assignment.previous_role, assignment.checkpoint_role),
            (GcpRole::ControlXyz, GcpRole::CheckpointXyz)
                | (GcpRole::ControlXy, GcpRole::CheckpointXy)
                | (GcpRole::ControlZ, GcpRole::CheckpointZ)
        )));
    }

    #[test]
    fn optimization_snapshot_sorts_scope_and_freezes_participation() {
        let controls = vec![
            point("A", 0.0, 0.0, 0.0, GcpRole::ControlXyz),
            point("B", 1.0, 1.0, 1.0, GcpRole::CheckpointXy),
        ];
        let mut all_observations = observations("A");
        all_observations.extend(observations("B"));
        let snapshot = build_optimization_snapshot(
            None,
            GcpOptimizationScope {
                label: "Block Nord · Run 4".to_owned(),
                point_ids: vec![GcpPointId("B".to_owned()), GcpPointId("A".to_owned())],
                camera_reference_image_ids: vec![ImageId(8), ImageId(2)],
            },
            &controls,
            &all_observations,
        )
        .expect("snapshot should build");

        assert_eq!(snapshot.scope.point_ids[0].0, "A");
        assert_eq!(
            snapshot.scope.camera_reference_image_ids,
            vec![ImageId(2), ImageId(8)]
        );
        assert_eq!(
            snapshot.points[1].participation,
            OptimizationPointParticipation::Checkpoint
        );
        let encoded = serde_json::to_string(&snapshot).expect("serialize snapshot");
        let decoded: GcpOptimizationSnapshot =
            serde_json::from_str(&encoded).expect("deserialize snapshot");
        assert_eq!(decoded, snapshot);
    }

    #[test]
    fn optimization_snapshot_accepts_camera_references_without_gcps() {
        let snapshot = build_optimization_snapshot(
            None,
            GcpOptimizationScope {
                label: "Camera references".to_owned(),
                point_ids: Vec::new(),
                camera_reference_image_ids: vec![ImageId(9), ImageId(3), ImageId(6)],
            },
            &[],
            &[],
        )
        .expect("three camera references should define a camera-only scope");

        assert!(snapshot.points.is_empty());
        assert!(snapshot.observations.is_empty());
        assert_eq!(
            snapshot.scope.camera_reference_image_ids,
            vec![ImageId(3), ImageId(6), ImageId(9)]
        );

        let insufficient = build_optimization_snapshot(
            None,
            GcpOptimizationScope {
                label: "Too few camera references".to_owned(),
                point_ids: Vec::new(),
                camera_reference_image_ids: vec![ImageId(3), ImageId(6)],
            },
            &[],
            &[],
        );
        assert!(matches!(
            insufficient,
            Err(GcpError::InvalidOptimizationScope(_))
        ));
    }

    #[test]
    fn predicted_observation_is_valid_but_not_an_optimization_constraint() {
        let gcp = point("A", 0.0, 0.0, 0.0, GcpRole::ControlXyz);
        let predicted = GcpObservation {
            point_id: gcp.id.clone(),
            image_id: ImageId(1),
            state: GcpObservationState::Predicted {
                coordinate: ImageCoordinate {
                    x_pixels: 100.0,
                    y_pixels: 200.0,
                },
                confidence_per_mille: 900,
                source: "tie-point projection".into(),
            },
        };
        assert!(validate_gcp_observation(std::slice::from_ref(&gcp), &predicted).is_ok());
        assert!(matches!(
            validate_gcp_dataset(&[gcp], &[predicted], &[]),
            Err(GcpError::TooFewObservations { .. })
        ));
    }

    #[test]
    fn residual_report_scope_partitions_controls_and_checkpoints() {
        let points = vec![
            point("A", 0.0, 0.0, 0.0, GcpRole::ControlXyz),
            point("B", 1.0, 1.0, 1.0, GcpRole::CheckpointZ),
        ];
        let mut all_observations = observations("A");
        all_observations.extend(observations("B"));
        let snapshot = build_optimization_snapshot(
            None,
            GcpOptimizationScope {
                label: "Run 7".into(),
                point_ids: vec![GcpPointId("A".into()), GcpPointId("B".into())],
                camera_reference_image_ids: vec![ImageId(1)],
            },
            &points,
            &all_observations,
        )
        .expect("snapshot");
        let scope = build_gcp_residual_report_scope(
            &snapshot,
            ObjectHash::of_bytes(b"collection"),
            ObjectHash::of_bytes(b"snapshot"),
        )
        .expect("residual scope");
        assert_eq!(scope.control_point_ids, vec![GcpPointId("A".into())]);
        assert_eq!(scope.checkpoint_point_ids, vec![GcpPointId("B".into())]);
        assert_eq!(scope.camera_reference_image_ids, vec![ImageId(1)]);
    }
}
