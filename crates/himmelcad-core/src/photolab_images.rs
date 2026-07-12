//! Serializable, CRS-agnostic contracts for Photolab image discovery and metadata import.

use serde::{Deserialize, Serialize};

use crate::hash::ObjectHash;

/// Photo containers accepted by the Photolab discovery stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhotoFormat {
    Jpeg,
    Tiff,
    Dng,
    Png,
    Heic,
    Heif,
    Avif,
    CanonCr3,
    FujifilmRaf,
    PhaseOneIiq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDimensions {
    pub width_pixels: u32,
    pub height_pixels: u32,
}

/// EXIF orientation values from CIPA DC-008.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExifOrientation {
    Normal,
    MirrorHorizontal,
    Rotate180,
    MirrorVertical,
    MirrorHorizontalRotate270Clockwise,
    Rotate90Clockwise,
    MirrorHorizontalRotate90Clockwise,
    Rotate270Clockwise,
}

impl ExifOrientation {
    #[must_use]
    pub const fn from_exif_value(value: u16) -> Option<Self> {
        match value {
            1 => Some(Self::Normal),
            2 => Some(Self::MirrorHorizontal),
            3 => Some(Self::Rotate180),
            4 => Some(Self::MirrorVertical),
            5 => Some(Self::MirrorHorizontalRotate270Clockwise),
            6 => Some(Self::Rotate90Clockwise),
            7 => Some(Self::MirrorHorizontalRotate90Clockwise),
            8 => Some(Self::Rotate270Clockwise),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTimeReference {
    EmbeddedUtcOffset,
    UnknownLocalTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTime {
    /// RFC 3339 for aware values, `YYYY-MM-DD HH:MM:SS` for naive EXIF values.
    pub value: String,
    pub reference: CaptureTimeReference,
}

/// Semantic height reference is deliberately unresolved during image import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeightSemanticReference {
    Unknown,
}

/// Height retained exactly as metadata, without implicit geoid or ellipsoid assignment.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHeight {
    pub meters: f64,
    pub semantic_reference: HeightSemanticReference,
}

impl ImportedHeight {
    #[must_use]
    pub const fn unknown_reference(meters: f64) -> Self {
        Self {
            meters,
            semantic_reference: HeightSemanticReference::Unknown,
        }
    }
}

/// WGS84 angular coordinates reported by EXIF. Height semantics stay unresolved.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifGpsPosition {
    pub latitude_degrees: f64,
    pub longitude_degrees: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude: Option<ImportedHeight>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifPhotoMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal_length_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<ImageDimensions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<ExifOrientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<CaptureTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps: Option<ExifGpsPosition>,
}

/// Optional yaw, pitch and roll values in degrees. Missing axes remain missing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DjiAttitudeDegrees {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yaw: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roll: Option<f64>,
}

impl DjiAttitudeDegrees {
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.yaw.is_none() && self.pitch.is_none() && self.roll.is_none()
    }
}

/// DJI XMP values preserved without treating their altitude names as a geodetic datum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DjiXmpMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latitude_degrees: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitude_degrees: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ground_altitude: Option<ImportedHeight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_altitude: Option<ImportedHeight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_altitude: Option<ImportedHeight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flight_attitude: Option<DjiAttitudeDegrees>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gimbal_attitude: Option<DjiAttitudeDegrees>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtk: Option<DjiRtkMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrated_focal_length_pixels: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrated_optical_center_x_pixels: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrated_optical_center_y_pixels: Option<f64>,
}

/// Raw DJI RTK quality metadata. Standard deviations are stored in meters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DjiRtkMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standard_deviation_longitude_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standard_deviation_latitude_meters: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standard_deviation_height_meters: Option<f64>,
}

impl DjiXmpMetadata {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ground_altitude.is_none()
            && self.absolute_altitude.is_none()
            && self.relative_altitude.is_none()
            && self.flight_attitude.is_none()
            && self.gimbal_attitude.is_none()
            && self.latitude_degrees.is_none()
            && self.longitude_degrees.is_none()
            && self.rtk.is_none()
            && self.calibrated_focal_length_pixels.is_none()
            && self.calibrated_optical_center_x_pixels.is_none()
            && self.calibrated_optical_center_y_pixels.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoMetadata {
    pub exif: ExifPhotoMetadata,
    pub dji_xmp: DjiXmpMetadata,
}

impl PhotoMetadata {
    /// Returns the highest precision inspected position without changing height semantics.
    #[must_use]
    pub fn preferred_gps_position(&self) -> Option<ExifGpsPosition> {
        match (
            self.dji_xmp.latitude_degrees,
            self.dji_xmp.longitude_degrees,
        ) {
            (Some(latitude_degrees), Some(longitude_degrees))
                if latitude_degrees.is_finite()
                    && longitude_degrees.is_finite()
                    && (-90.0..=90.0).contains(&latitude_degrees)
                    && (-180.0..=180.0).contains(&longitude_degrees) =>
            {
                Some(ExifGpsPosition {
                    latitude_degrees,
                    longitude_degrees,
                    altitude: self
                        .dji_xmp
                        .absolute_altitude
                        .or_else(|| self.exif.gps.and_then(|gps| gps.altitude)),
                })
            }
            _ => self.exif.gps,
        }
    }

    /// Conservative fixed-RTK classification based on DJI flag and reported precision.
    #[must_use]
    pub fn has_fixed_rtk_position(&self) -> bool {
        let Some(rtk) = self.dji_xmp.rtk.as_ref() else {
            return false;
        };
        let flag = rtk.flag.as_deref().unwrap_or_default().trim();
        let flag_fixed = flag.eq_ignore_ascii_case("fixed") || flag == "50";
        let precision_fixed = rtk
            .standard_deviation_longitude_meters
            .zip(rtk.standard_deviation_latitude_meters)
            .is_some_and(|(longitude, latitude)| longitude <= 0.1 && latitude <= 0.1)
            && rtk
                .standard_deviation_height_meters
                .is_none_or(|height| height <= 0.2);
        flag_fixed && precision_fixed
    }
}

/// Non-fatal import diagnostics attached to their source path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageImportWarningCode {
    PathUnavailable,
    DirectoryReadFailed,
    SymlinkSkipped,
    UnsupportedFormat,
    FileReadFailed,
    ExifParseFailed,
    ExifEntryInvalid,
    MetadataValueInvalid,
    XmpScanLimitReached,
    XmpMalformed,
    XmpUnsafeXmlIgnored,
    DuplicateContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageImportWarning {
    pub source_path: String,
    pub code: ImageImportWarningCode,
    pub message: String,
}

/// One discovered and hashed source image. No copy or CRS operation has occurred yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPhoto {
    pub source_path: String,
    pub format: PhotoFormat,
    pub byte_size: u64,
    pub sha256: ObjectHash,
    pub metadata: PhotoMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
}

/// Import-time projected reference derived from the immutable WGS84 metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedPhotoReference {
    pub source_latitude_degrees: f64,
    pub source_longitude_degrees: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_height_meters: Option<f64>,
    pub easting: f64,
    pub northing: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transformed_height_meters: Option<f64>,
    pub transformation_decision_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoImportBatch {
    pub photos: Vec<DiscoveredPhoto>,
    pub warnings: Vec<ImageImportWarning>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_is_explicitly_semantically_unknown_on_the_wire() {
        let height = ImportedHeight::unknown_reference(123.45);
        let encoded = serde_json::to_value(height).expect("height must serialize");

        assert_eq!(encoded["meters"], 123.45);
        assert_eq!(encoded["semanticReference"], "unknown");
    }

    #[test]
    fn orientation_rejects_values_outside_the_exif_contract() {
        assert_eq!(
            ExifOrientation::from_exif_value(6),
            Some(ExifOrientation::Rotate90Clockwise)
        );
        assert_eq!(ExifOrientation::from_exif_value(0), None);
        assert_eq!(ExifOrientation::from_exif_value(9), None);
    }
}
