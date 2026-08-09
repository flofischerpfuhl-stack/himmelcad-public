//! Provider-neutral capture, local-metric scale and video-selection contracts.

use serde::{Deserialize, Serialize};

use crate::hash::ObjectHash;
use crate::photolab_images::PhotoFormat;

/// Version of the deterministic video frame selection policy.
pub const VIDEO_FRAME_SELECTION_VERSION: &str = "hcad-video-frame-selection-v1";

/// Physical source represented by an immutable capture object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMedium {
    StillImage,
    Video,
    VideoFrame,
}

/// Device class inferred from metadata evidence, never from one vendor-only field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureDeviceClass {
    Smartphone,
    SystemCamera,
    Drone,
    ActionCamera,
    Scanner,
    Unknown,
}

/// Evidence used for the source classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureClassificationBasis {
    EmbeddedMetadata,
    ContainerMetadata,
    ExtensionFallback,
    DerivedArtifact,
}

/// Provider-neutral source identity retained beside vendor-specific metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSourceProfile {
    pub schema_version: u32,
    pub medium: CaptureMedium,
    pub device_class: CaptureDeviceClass,
    pub basis: CaptureClassificationBasis,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens_model: Option<String>,
}

impl Default for CaptureSourceProfile {
    fn default() -> Self {
        Self {
            schema_version: 1,
            medium: CaptureMedium::StillImage,
            device_class: CaptureDeviceClass::Unknown,
            basis: CaptureClassificationBasis::ExtensionFallback,
            make: None,
            model: None,
            lens_model: None,
        }
    }
}

/// Operation a decoder can perform without changing the immutable source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureDecodeOperation {
    Decode,
    TranscodeToTiff,
    TranscodeToPng,
}

/// How a format is made available on this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CaptureDecodeSupport {
    BuiltIn,
    SystemTool { tool: String, version: String },
    Unsupported { reason: String },
}

/// Explicit capability decision for one still-image source format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDecodeCapability {
    pub format: PhotoFormat,
    pub operation: CaptureDecodeOperation,
    pub support: CaptureDecodeSupport,
    /// Invariant: decoding/transcoding never replaces or re-hashes the source object.
    pub preserves_source_object: bool,
}

/// Executable discovered at runtime; it is not part of the packaged dependency closure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemToolCapability {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// One immutable host snapshot used throughout an import/prepare operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilityInventory {
    pub schema_version: u32,
    pub decoders: Vec<CaptureDecodeCapability>,
    pub ffprobe: SystemToolCapability,
    pub ffmpeg: SystemToolCapability,
}

impl CaptureCapabilityInventory {
    #[must_use]
    pub fn portable_defaults() -> Self {
        let formats = [
            PhotoFormat::Jpeg,
            PhotoFormat::Tiff,
            PhotoFormat::Dng,
            PhotoFormat::Png,
            PhotoFormat::Heic,
            PhotoFormat::Heif,
            PhotoFormat::Avif,
            PhotoFormat::CanonCr3,
            PhotoFormat::FujifilmRaf,
            PhotoFormat::PhaseOneIiq,
        ];
        Self {
            schema_version: 1,
            decoders: formats
                .into_iter()
                .map(|format| {
                    let support = if matches!(
                        format,
                        PhotoFormat::Jpeg | PhotoFormat::Tiff | PhotoFormat::Png
                    ) {
                        CaptureDecodeSupport::BuiltIn
                    } else {
                        CaptureDecodeSupport::Unsupported {
                            reason: "no compatible image decoder/transcoder was detected".into(),
                        }
                    };
                    CaptureDecodeCapability {
                        format,
                        operation: CaptureDecodeOperation::Decode,
                        support,
                        preserves_source_object: true,
                    }
                })
                .collect(),
            ffprobe: SystemToolCapability {
                available: false,
                executable: None,
                version: None,
            },
            ffmpeg: SystemToolCapability {
                available: false,
                executable: None,
                version: None,
            },
        }
    }

    #[must_use]
    pub fn decoder(&self, format: PhotoFormat) -> Option<&CaptureDecodeCapability> {
        self.decoders
            .iter()
            .find(|capability| capability.format == format)
    }
}

/// Immutable derived-artifact lineage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedCaptureArtifactProvenance {
    pub source_object_hash: ObjectHash,
    pub artifact_object_hash: ObjectHash,
    pub operation: String,
    pub algorithm_version: String,
    pub parameters_sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_timestamp_microseconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_frame_index: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_tool_version: Option<String>,
}

/// A noisy position is evidence for adjustment, never an authoritative coordinate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePositionPrior {
    pub latitude_degrees: f64,
    pub longitude_degrees: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_meters: Option<f64>,
    /// East/North/Up covariance in square metres, row-major.
    pub covariance_enu_m2: [f64; 9],
    pub source: CapturePositionPriorSource,
    pub role: CapturePositionRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapturePositionPriorSource {
    ExifGps,
    VendorRtk,
    VideoContainer,
    /// HimmelCAD Cap `.hcap` session package priors.
    HimmelCap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapturePositionRole {
    PriorOnly,
}

impl CapturePositionPrior {
    /// Creates a conservative diagonal prior while retaining explicit uncertainty.
    #[must_use]
    pub fn diagonal(
        latitude_degrees: f64,
        longitude_degrees: f64,
        height_meters: Option<f64>,
        horizontal_sigma_meters: f64,
        vertical_sigma_meters: f64,
        source: CapturePositionPriorSource,
    ) -> Option<Self> {
        if !latitude_degrees.is_finite()
            || !longitude_degrees.is_finite()
            || !(-90.0..=90.0).contains(&latitude_degrees)
            || !(-180.0..=180.0).contains(&longitude_degrees)
            || height_meters.is_some_and(|value| !value.is_finite())
            || !horizontal_sigma_meters.is_finite()
            || horizontal_sigma_meters <= 0.0
            || !vertical_sigma_meters.is_finite()
            || vertical_sigma_meters <= 0.0
        {
            return None;
        }
        let horizontal_variance = horizontal_sigma_meters * horizontal_sigma_meters;
        let vertical_variance = vertical_sigma_meters * vertical_sigma_meters;
        Some(Self {
            latitude_degrees,
            longitude_degrees,
            height_meters,
            covariance_enu_m2: [
                horizontal_variance,
                0.0,
                0.0,
                0.0,
                horizontal_variance,
                0.0,
                0.0,
                0.0,
                vertical_variance,
            ],
            source,
            role: CapturePositionRole::PriorOnly,
        })
    }
}

/// Local projects are metric without claiming a CRS, origin, north or gravity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PhotolabSpatialReference {
    LocalMetric {
        unit: MetricLengthUnit,
        axes: LocalMetricAxes,
    },
    CrsBacked,
}

impl Default for PhotolabSpatialReference {
    fn default() -> Self {
        Self::LocalMetric {
            unit: MetricLengthUnit::Meter,
            axes: LocalMetricAxes::RightHandedZUp,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalMetricAxes {
    RightHandedZUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricLengthUnit {
    Millimeter,
    Centimeter,
    Meter,
    Inch,
    Foot,
}

impl MetricLengthUnit {
    #[must_use]
    pub const fn meters_per_unit(self) -> f64 {
        match self {
            Self::Millimeter => 0.001,
            Self::Centimeter => 0.01,
            Self::Meter => 1.0,
            Self::Inch => 0.0254,
            Self::Foot => 0.3048,
        }
    }
}

/// One endpoint already triangulated from independent image observations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriangulatedScaleEndpoint {
    pub endpoint_id: String,
    pub position_project_units: [f64; 3],
    /// Project-coordinate covariance, row-major.
    pub covariance_project_units2: [f64; 9],
    pub observation_count: u32,
    pub maximum_intersection_angle_degrees: f64,
}

/// User-supplied metric distance between two triangulated endpoints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScaleConstraint {
    pub constraint_id: String,
    pub first: TriangulatedScaleEndpoint,
    pub second: TriangulatedScaleEndpoint,
    pub target_length: f64,
    pub target_unit: MetricLengthUnit,
    pub target_standard_deviation: f64,
    pub lineage_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScaleEvaluation {
    pub observable: bool,
    pub reasons: Vec<ScaleObservabilityFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconstructed_distance_project_units: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_distance_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_meters_per_project_unit: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_standard_deviation: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScaleObservabilityFailure {
    NonFiniteInput,
    EndpointNotTriangulated,
    WeakRayIntersection,
    CoincidentEndpoints,
    InvalidTargetLength,
    InvalidCovariance,
}

/// Evaluates scale and first-order uncertainty without changing reconstruction coordinates.
#[must_use]
pub fn evaluate_local_scale(constraint: &LocalScaleConstraint) -> LocalScaleEvaluation {
    let mut reasons = Vec::new();
    let endpoint_values = constraint
        .first
        .position_project_units
        .iter()
        .chain(constraint.second.position_project_units.iter())
        .copied();
    if endpoint_values.clone().any(|value| !value.is_finite()) {
        reasons.push(ScaleObservabilityFailure::NonFiniteInput);
    }
    if constraint.first.observation_count < 2 || constraint.second.observation_count < 2 {
        reasons.push(ScaleObservabilityFailure::EndpointNotTriangulated);
    }
    if !constraint
        .first
        .maximum_intersection_angle_degrees
        .is_finite()
        || !constraint
            .second
            .maximum_intersection_angle_degrees
            .is_finite()
        || constraint.first.maximum_intersection_angle_degrees < 1.0
        || constraint.second.maximum_intersection_angle_degrees < 1.0
    {
        reasons.push(ScaleObservabilityFailure::WeakRayIntersection);
    }
    let target_meters = constraint.target_length * constraint.target_unit.meters_per_unit();
    let target_sigma_meters =
        constraint.target_standard_deviation * constraint.target_unit.meters_per_unit();
    if !target_meters.is_finite()
        || target_meters <= 0.0
        || !target_sigma_meters.is_finite()
        || target_sigma_meters < 0.0
    {
        reasons.push(ScaleObservabilityFailure::InvalidTargetLength);
    }
    let covariance_valid = constraint
        .first
        .covariance_project_units2
        .iter()
        .chain(constraint.second.covariance_project_units2.iter())
        .all(|value| value.is_finite())
        && [0_usize, 4, 8].into_iter().all(|index| {
            constraint.first.covariance_project_units2[index] >= 0.0
                && constraint.second.covariance_project_units2[index] >= 0.0
        });
    if !covariance_valid {
        reasons.push(ScaleObservabilityFailure::InvalidCovariance);
    }
    let delta = [
        constraint.second.position_project_units[0] - constraint.first.position_project_units[0],
        constraint.second.position_project_units[1] - constraint.first.position_project_units[1],
        constraint.second.position_project_units[2] - constraint.first.position_project_units[2],
    ];
    let distance = delta.iter().map(|value| value * value).sum::<f64>().sqrt();
    if !distance.is_finite() || distance <= 1.0e-9 {
        reasons.push(ScaleObservabilityFailure::CoincidentEndpoints);
    }
    if !reasons.is_empty() {
        return LocalScaleEvaluation {
            observable: false,
            reasons,
            reconstructed_distance_project_units: distance.is_finite().then_some(distance),
            target_distance_meters: target_meters.is_finite().then_some(target_meters),
            scale_meters_per_project_unit: None,
            scale_standard_deviation: None,
        };
    }

    let direction = [
        delta[0] / distance,
        delta[1] / distance,
        delta[2] / distance,
    ];
    let mut distance_variance = 0.0;
    for row in 0..3 {
        for column in 0..3 {
            let covariance = constraint.first.covariance_project_units2[row * 3 + column]
                + constraint.second.covariance_project_units2[row * 3 + column];
            distance_variance += direction[row] * covariance * direction[column];
        }
    }
    let distance_variance = distance_variance.max(0.0);
    let scale = target_meters / distance;
    let scale_variance = target_sigma_meters.powi(2) / distance.powi(2)
        + target_meters.powi(2) * distance_variance / distance.powi(4);
    LocalScaleEvaluation {
        observable: true,
        reasons,
        reconstructed_distance_project_units: Some(distance),
        target_distance_meters: Some(target_meters),
        scale_meters_per_project_unit: Some(scale),
        scale_standard_deviation: Some(scale_variance.sqrt()),
    }
}

/// Measured candidate emitted by a bounded video thumbnail pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameCandidate {
    pub frame_index: u64,
    pub timestamp_microseconds: u64,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub sharpness: f64,
    pub motion: f64,
    pub overlap: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameSelectionPolicy {
    pub maximum_frames: usize,
    pub minimum_interval_microseconds: u64,
    pub minimum_width_pixels: u32,
    pub minimum_height_pixels: u32,
    pub minimum_sharpness: f64,
    pub maximum_motion: f64,
    pub minimum_overlap: f64,
    pub maximum_overlap: f64,
}

impl Default for VideoFrameSelectionPolicy {
    fn default() -> Self {
        Self {
            maximum_frames: 1_000,
            minimum_interval_microseconds: 250_000,
            minimum_width_pixels: 640,
            minimum_height_pixels: 480,
            minimum_sharpness: 0.02,
            maximum_motion: 0.8,
            minimum_overlap: 0.2,
            maximum_overlap: 0.98,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameSelection {
    pub algorithm_version: String,
    pub selected: Vec<VideoFrameCandidate>,
    pub rejected_count: usize,
}

/// Deterministic best-first selection with a temporal separation constraint.
#[must_use]
pub fn select_video_frames(
    candidates: &[VideoFrameCandidate],
    policy: &VideoFrameSelectionPolicy,
) -> VideoFrameSelection {
    let mut eligible = candidates
        .iter()
        .filter(|candidate| {
            candidate.width_pixels >= policy.minimum_width_pixels
                && candidate.height_pixels >= policy.minimum_height_pixels
                && candidate.sharpness.is_finite()
                && candidate.motion.is_finite()
                && candidate.overlap.is_finite()
                && candidate.sharpness >= policy.minimum_sharpness
                && candidate.motion <= policy.maximum_motion
                && candidate.overlap >= policy.minimum_overlap
                && candidate.overlap <= policy.maximum_overlap
        })
        .cloned()
        .collect::<Vec<_>>();
    eligible.sort_by(|left, right| {
        frame_score(right)
            .total_cmp(&frame_score(left))
            .then_with(|| {
                left.timestamp_microseconds
                    .cmp(&right.timestamp_microseconds)
            })
            .then_with(|| left.frame_index.cmp(&right.frame_index))
    });
    let mut selected = Vec::<VideoFrameCandidate>::new();
    for candidate in eligible {
        if selected.len() >= policy.maximum_frames {
            break;
        }
        if selected.iter().all(|existing| {
            existing
                .timestamp_microseconds
                .abs_diff(candidate.timestamp_microseconds)
                >= policy.minimum_interval_microseconds
        }) {
            selected.push(candidate);
        }
    }
    selected.sort_by_key(|candidate| (candidate.timestamp_microseconds, candidate.frame_index));
    VideoFrameSelection {
        algorithm_version: VIDEO_FRAME_SELECTION_VERSION.to_owned(),
        rejected_count: candidates.len().saturating_sub(selected.len()),
        selected,
    }
}

fn frame_score(candidate: &VideoFrameCandidate) -> f64 {
    candidate.sharpness * 0.6
        + (1.0 - candidate.motion.clamp(0.0, 1.0)) * 0.25
        + (1.0 - (candidate.overlap - 0.75).abs()).clamp(0.0, 1.0) * 0.15
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(id: &str, x: f64) -> TriangulatedScaleEndpoint {
        TriangulatedScaleEndpoint {
            endpoint_id: id.to_owned(),
            position_project_units: [x, 0.0, 0.0],
            covariance_project_units2: [0.0001, 0.0, 0.0, 0.0, 0.0001, 0.0, 0.0, 0.0, 0.0001],
            observation_count: 3,
            maximum_intersection_angle_degrees: 15.0,
        }
    }

    #[test]
    fn two_triangulated_endpoints_establish_scale_and_uncertainty() {
        let result = evaluate_local_scale(&LocalScaleConstraint {
            constraint_id: "scale-1".into(),
            first: endpoint("a", 0.0),
            second: endpoint("b", 2.0),
            target_length: 5.0,
            target_unit: MetricLengthUnit::Meter,
            target_standard_deviation: 0.01,
            lineage_sha256: ObjectHash::of_bytes(b"lineage"),
        });
        assert!(result.observable);
        assert_eq!(result.scale_meters_per_project_unit, Some(2.5));
        assert!(result
            .scale_standard_deviation
            .is_some_and(|sigma| sigma > 0.0));
    }

    #[test]
    fn a_single_image_endpoint_is_not_observable() {
        let mut second = endpoint("b", 2.0);
        second.observation_count = 1;
        let result = evaluate_local_scale(&LocalScaleConstraint {
            constraint_id: "scale-2".into(),
            first: endpoint("a", 0.0),
            second,
            target_length: 2.0,
            target_unit: MetricLengthUnit::Meter,
            target_standard_deviation: 0.01,
            lineage_sha256: ObjectHash::of_bytes(b"lineage"),
        });
        assert!(!result.observable);
        assert!(result
            .reasons
            .contains(&ScaleObservabilityFailure::EndpointNotTriangulated));
    }

    #[test]
    fn frame_selection_is_stable_and_enforces_temporal_separation() {
        let candidates = (0..6)
            .map(|index| VideoFrameCandidate {
                frame_index: index,
                timestamp_microseconds: index * 100_000,
                width_pixels: 1920,
                height_pixels: 1080,
                sharpness: 0.5 + index as f64 * 0.01,
                motion: 0.1,
                overlap: 0.8,
            })
            .collect::<Vec<_>>();
        let policy = VideoFrameSelectionPolicy {
            maximum_frames: 2,
            minimum_interval_microseconds: 250_000,
            ..VideoFrameSelectionPolicy::default()
        };
        let first = select_video_frames(&candidates, &policy);
        let second = select_video_frames(&candidates, &policy);
        assert_eq!(first, second);
        assert_eq!(first.selected.len(), 2);
        assert!(
            first.selected[0]
                .timestamp_microseconds
                .abs_diff(first.selected[1].timestamp_microseconds)
                >= 250_000
        );
    }
}
