//! Product-neutral CRS declarations and operation-selection contracts.

use serde::{Deserialize, Serialize};

use crate::hash::ObjectHash;

/// Default equivalent of PROJ's `ALLOW_BALLPARK=NO` selection constraint.
pub const DEFAULT_ALLOW_BALLPARK: bool = false;
/// Default equivalent of PROJ's `ONLY_BEST=YES` selection constraint.
pub const DEFAULT_ONLY_BEST: bool = true;

/// Complete CRS representation accepted at the project boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum CrsDefinition {
    Epsg(u32),
    /// Canonical authority expression for compound CRS such as `EPSG:25832+7837`.
    Authority(String),
    Wkt2(String),
    ProjJson(String),
}

/// Decimal coordinate epoch for dynamic reference frames.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinateEpoch {
    pub decimal_year: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrsWithEpoch {
    pub crs: CrsDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate_epoch: Option<CoordinateEpoch>,
}

/// Height semantics are never inferred from a horizontal CRS or an EXIF field name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeightReference {
    Unknown,
    Ellipsoidal,
    Orthometric {
        #[serde(rename = "verticalCrs", alias = "vertical_crs")]
        vertical_crs: CrsDefinition,
    },
    NormalHeight {
        #[serde(rename = "verticalCrs", alias = "vertical_crs")]
        vertical_crs: CrsDefinition,
    },
    DeviceProfile {
        #[serde(rename = "profileId", alias = "profile_id")]
        profile_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HorizontalCrsSelection {
    pub source: CrsWithEpoch,
    pub target: CrsWithEpoch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerticalOperationMode {
    PreserveValues,
    Transform,
}

/// Explicit vertical decision. `Unknown` may be preserved, but absence is never implicit consent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerticalCrsSelection {
    pub source: HeightReference,
    pub target: HeightReference,
    pub mode: VerticalOperationMode,
}

/// Non-wrapping geographic bounds in decimal degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeographicArea {
    pub west_longitude: f64,
    pub south_latitude: f64,
    pub east_longitude: f64,
    pub north_latitude: f64,
}

impl GeographicArea {
    #[must_use]
    pub fn contains(self, other: Self) -> bool {
        self.is_valid()
            && other.is_valid()
            && self.west_longitude <= other.west_longitude
            && self.south_latitude <= other.south_latitude
            && self.east_longitude >= other.east_longitude
            && self.north_latitude >= other.north_latitude
    }

    #[must_use]
    pub fn is_valid(self) -> bool {
        [
            self.west_longitude,
            self.south_latitude,
            self.east_longitude,
            self.north_latitude,
        ]
        .into_iter()
        .all(f64::is_finite)
            && (-180.0..=180.0).contains(&self.west_longitude)
            && (-180.0..=180.0).contains(&self.east_longitude)
            && (-90.0..=90.0).contains(&self.south_latitude)
            && (-90.0..=90.0).contains(&self.north_latitude)
            && self.west_longitude <= self.east_longitude
            && self.south_latitude <= self.north_latitude
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransformationGridKind {
    Ntv2,
    Gtg,
    Geoid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLicenseMetadata {
    pub license_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spdx_expression: Option<String>,
    pub source: String,
    pub redistribution_allowed: bool,
}

/// Local state is evidence only; no network lookup or implicit grid installation is permitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RequiredGridAvailability {
    Missing,
    PresentVerified {
        /// Accept both camelCase (IPC) and snake_case for robustness.
        #[serde(rename = "localPath", alias = "local_path")]
        local_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "observedSha256", alias = "observed_sha256")]
        observed_sha256: Option<ObjectHash>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredTransformationGrid {
    pub kind: TransformationGridKind,
    pub official_filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub official_sha256: Option<ObjectHash>,
    pub license: GridLicenseMetadata,
    pub coverage: GeographicArea,
    pub availability: RequiredGridAvailability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoordinateOperationKind {
    General,
    GaussKruegerDatumTransformation,
}

/// Candidate returned by a future locally installed operation-selection engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCandidate {
    pub operation_id: String,
    pub name: String,
    pub kind: CoordinateOperationKind,
    pub proj_pipeline: String,
    pub area_of_use: GeographicArea,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_accuracy_mm: Option<f64>,
    pub ballpark: bool,
    pub best_available: bool,
    pub required_grids: Vec<RequiredTransformationGrid>,
}

/// Operation-selection controls persisted exactly as presented to PROJ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSelectionPolicy {
    pub allow_ballpark: bool,
    pub only_best: bool,
}

impl Default for OperationSelectionPolicy {
    fn default() -> Self {
        Self {
            allow_ballpark: DEFAULT_ALLOW_BALLPARK,
            only_best: DEFAULT_ONLY_BEST,
        }
    }
}

impl OperationSelectionPolicy {
    #[must_use]
    pub const fn proj_allow_ballpark(self) -> &'static str {
        if self.allow_ballpark {
            "YES"
        } else {
            "NO"
        }
    }

    #[must_use]
    pub const fn proj_only_best(self) -> &'static str {
        if self.only_best {
            "YES"
        } else {
            "NO"
        }
    }
}

/// Separate acknowledgement required in addition to changing the ballpark policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BallparkConfirmation {
    pub confirmed_by: String,
    pub reason: String,
}

/// Version snapshot required to reproduce operation selection later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrsDatabaseVersions {
    pub proj_version: String,
    pub epsg_database_version: String,
}
