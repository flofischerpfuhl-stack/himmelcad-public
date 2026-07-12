//! Explicit Photolab CRS-transformation decisions and frozen audit contracts.
//!
//! This module describes and validates a pipeline selected by a future PROJ-backed service; it
//! never performs coordinate transformation itself. The local reference folder
//! `/home/oem/Dokumente/002_Geschäftlich/01_Geiger/03_Projekte/NT2V` was inspected only to
//! inventory these future regression fixtures: `NTV2_Transformation.csv`,
//! `Testpunkte_Echtumstellung.csv`, `testpunkte.csv`, and `testpunktetrafo.csv`. No source code or
//! transformation implementation was copied or ported from that directory.

use serde::{Deserialize, Serialize};
use thiserror::Error;

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
    Orthometric { vertical_crs: CrsDefinition },
    NormalHeight { vertical_crs: CrsDefinition },
    DeviceProfile { profile_id: String },
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
        local_path: String,
        observed_sha256: ObjectHash,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredTransformationGrid {
    pub kind: TransformationGridKind,
    pub official_filename: String,
    pub official_sha256: ObjectHash,
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

/// User decision before validation. Vertical absence is representable so it can be rejected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTransformationDecision {
    pub schema_version: u32,
    pub contains_gps_data: bool,
    pub horizontal: HorizontalCrsSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical: Option<VerticalCrsSelection>,
    pub area_of_interest: GeographicArea,
    pub operation: OperationCandidate,
    #[serde(default)]
    pub selection_policy: OperationSelectionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ballpark_confirmation: Option<BallparkConfirmation>,
    pub database_versions: CrsDatabaseVersions,
}

/// Original and target CRS snapshots tied to the exact frozen pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenCrsEndpoint {
    pub horizontal: CrsWithEpoch,
    pub vertical: HeightReference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenGridBinding {
    pub kind: TransformationGridKind,
    pub official_filename: String,
    pub official_sha256: ObjectHash,
    pub local_path: String,
    pub license: GridLicenseMetadata,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenOperationPipeline {
    pub operation_id: String,
    pub operation_name: String,
    pub proj_pipeline: String,
    pub expected_accuracy_mm: Option<f64>,
    pub ballpark: bool,
    pub selection_policy: OperationSelectionPolicy,
    pub grids: Vec<FrozenGridBinding>,
}

/// Validated, immutable audit record persisted with imported coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenImportTransformation {
    pub schema_version: u32,
    pub original: FrozenCrsEndpoint,
    pub target: FrozenCrsEndpoint,
    pub vertical_mode: VerticalOperationMode,
    pub area_of_interest: GeographicArea,
    pub pipeline: FrozenOperationPipeline,
    pub database_versions: CrsDatabaseVersions,
    pub decision_sha256: ObjectHash,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ImportTransformationError {
    #[error("transformation decision schema version must be non-zero")]
    InvalidSchemaVersion,
    #[error("source or target CRS definition is invalid: {0}")]
    InvalidCrs(&'static str),
    #[error("coordinate epoch must be finite")]
    InvalidCoordinateEpoch,
    #[error("GPS image data requires an explicit height decision")]
    MissingHeightDecision,
    #[error("height device profile id must not be empty")]
    InvalidDeviceProfile,
    #[error("area of interest or operation coverage is invalid")]
    InvalidArea,
    #[error("area of interest is outside operation area of use")]
    AreaOutsideOperationCoverage,
    #[error("operation candidate metadata is invalid: {0}")]
    InvalidOperation(&'static str),
    #[error("ONLY_BEST=YES rejects an operation not marked as best available")]
    OperationIsNotBest,
    #[error("ballpark operation is disabled by ALLOW_BALLPARK=NO")]
    BallparkDisallowed,
    #[error("ballpark operation requires a separate, non-empty confirmation")]
    BallparkConfirmationRequired,
    #[error("required transformation grid '{filename}' is missing")]
    RequiredGridMissing { filename: String },
    #[error("required transformation grid '{filename}' failed SHA-256 verification")]
    RequiredGridHashMismatch { filename: String },
    #[error("area of interest is outside grid '{filename}' coverage")]
    AreaOutsideGridCoverage { filename: String },
    #[error("required transformation grid metadata is invalid: {0}")]
    InvalidGrid(&'static str),
    #[error("Gauß-Krüger datum transformation requires an explicit NTv2/GTG grid")]
    GaussKruegerGridRequired,
    #[error("Gauß-Krüger required grid '{filename}' is missing")]
    GaussKruegerRequiredGridMissing { filename: String },
    #[error("PROJ and EPSG database versions must be recorded")]
    MissingDatabaseVersion,
    #[error("failed to serialize validated transformation decision: {0}")]
    Serialization(String),
}

impl ImportTransformationDecision {
    /// Validates all offline prerequisites and freezes the exact selected operation.
    pub fn validate_and_freeze(
        &self,
    ) -> Result<FrozenImportTransformation, ImportTransformationError> {
        validate_decision(self)?;
        let no_height_values = VerticalCrsSelection {
            source: HeightReference::Unknown,
            target: HeightReference::Unknown,
            mode: VerticalOperationMode::PreserveValues,
        };
        let vertical = self.vertical.as_ref().unwrap_or(&no_height_values);
        let grids = self
            .operation
            .required_grids
            .iter()
            .map(|grid| {
                let RequiredGridAvailability::PresentVerified {
                    local_path,
                    observed_sha256: _,
                } = &grid.availability
                else {
                    unreachable!("validation rejects missing grid bindings")
                };
                FrozenGridBinding {
                    kind: grid.kind,
                    official_filename: grid.official_filename.clone(),
                    official_sha256: grid.official_sha256.clone(),
                    local_path: local_path.clone(),
                    license: grid.license.clone(),
                }
            })
            .collect();
        let encoded = serde_json::to_vec(self)
            .map_err(|error| ImportTransformationError::Serialization(error.to_string()))?;

        Ok(FrozenImportTransformation {
            schema_version: self.schema_version,
            original: FrozenCrsEndpoint {
                horizontal: self.horizontal.source.clone(),
                vertical: vertical.source.clone(),
            },
            target: FrozenCrsEndpoint {
                horizontal: self.horizontal.target.clone(),
                vertical: vertical.target.clone(),
            },
            vertical_mode: vertical.mode,
            area_of_interest: self.area_of_interest,
            pipeline: FrozenOperationPipeline {
                operation_id: self.operation.operation_id.clone(),
                operation_name: self.operation.name.clone(),
                proj_pipeline: self.operation.proj_pipeline.clone(),
                expected_accuracy_mm: self.operation.expected_accuracy_mm,
                ballpark: self.operation.ballpark,
                selection_policy: self.selection_policy,
                grids,
            },
            database_versions: self.database_versions.clone(),
            decision_sha256: ObjectHash::of_bytes(&encoded),
        })
    }
}

fn validate_decision(
    decision: &ImportTransformationDecision,
) -> Result<(), ImportTransformationError> {
    if decision.schema_version == 0 {
        return Err(ImportTransformationError::InvalidSchemaVersion);
    }
    validate_crs_with_epoch(&decision.horizontal.source, "horizontal source")?;
    validate_crs_with_epoch(&decision.horizontal.target, "horizontal target")?;
    if decision.contains_gps_data && decision.vertical.is_none() {
        return Err(ImportTransformationError::MissingHeightDecision);
    }
    if let Some(vertical) = decision.vertical.as_ref() {
        validate_height_reference(&vertical.source)?;
        validate_height_reference(&vertical.target)?;
    }
    if !decision.area_of_interest.is_valid() || !decision.operation.area_of_use.is_valid() {
        return Err(ImportTransformationError::InvalidArea);
    }
    if !decision
        .operation
        .area_of_use
        .contains(decision.area_of_interest)
    {
        return Err(ImportTransformationError::AreaOutsideOperationCoverage);
    }
    validate_operation(decision)?;
    if decision.database_versions.proj_version.trim().is_empty()
        || decision
            .database_versions
            .epsg_database_version
            .trim()
            .is_empty()
    {
        return Err(ImportTransformationError::MissingDatabaseVersion);
    }
    Ok(())
}

fn validate_crs_with_epoch(
    crs: &CrsWithEpoch,
    field: &'static str,
) -> Result<(), ImportTransformationError> {
    validate_crs(&crs.crs, field)?;
    if crs
        .coordinate_epoch
        .is_some_and(|epoch| !epoch.decimal_year.is_finite())
    {
        return Err(ImportTransformationError::InvalidCoordinateEpoch);
    }
    Ok(())
}

fn validate_crs(crs: &CrsDefinition, field: &'static str) -> Result<(), ImportTransformationError> {
    let valid = match crs {
        CrsDefinition::Epsg(code) => *code > 0,
        CrsDefinition::Authority(value) => {
            !value.is_empty()
                && value.len() <= 256
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'+' | b'_' | b'-')
                })
        }
        CrsDefinition::Wkt2(value) => !value.trim().is_empty(),
        CrsDefinition::ProjJson(value) => {
            !value.trim().is_empty() && serde_json::from_str::<serde_json::Value>(value).is_ok()
        }
    };
    if valid {
        Ok(())
    } else {
        Err(ImportTransformationError::InvalidCrs(field))
    }
}

fn validate_height_reference(reference: &HeightReference) -> Result<(), ImportTransformationError> {
    match reference {
        HeightReference::Unknown | HeightReference::Ellipsoidal => Ok(()),
        HeightReference::Orthometric { vertical_crs }
        | HeightReference::NormalHeight { vertical_crs } => validate_crs(vertical_crs, "vertical"),
        HeightReference::DeviceProfile { profile_id } => {
            if profile_id.trim().is_empty() {
                Err(ImportTransformationError::InvalidDeviceProfile)
            } else {
                Ok(())
            }
        }
    }
}

fn validate_operation(
    decision: &ImportTransformationDecision,
) -> Result<(), ImportTransformationError> {
    let operation = &decision.operation;
    if operation.operation_id.trim().is_empty() {
        return Err(ImportTransformationError::InvalidOperation("operationId"));
    }
    if operation.name.trim().is_empty() {
        return Err(ImportTransformationError::InvalidOperation("name"));
    }
    if operation.proj_pipeline.trim().is_empty() {
        return Err(ImportTransformationError::InvalidOperation("projPipeline"));
    }
    if operation
        .expected_accuracy_mm
        .is_some_and(|accuracy| !accuracy.is_finite() || accuracy < 0.0)
    {
        return Err(ImportTransformationError::InvalidOperation(
            "expectedAccuracyMm",
        ));
    }
    if decision.selection_policy.only_best && !operation.best_available {
        return Err(ImportTransformationError::OperationIsNotBest);
    }
    if operation.ballpark {
        if !decision.selection_policy.allow_ballpark {
            return Err(ImportTransformationError::BallparkDisallowed);
        }
        let confirmed = decision
            .ballpark_confirmation
            .as_ref()
            .is_some_and(|confirmation| {
                !confirmation.confirmed_by.trim().is_empty()
                    && !confirmation.reason.trim().is_empty()
            });
        if !confirmed {
            return Err(ImportTransformationError::BallparkConfirmationRequired);
        }
    }

    if operation.kind == CoordinateOperationKind::GaussKruegerDatumTransformation
        && !operation.required_grids.iter().any(|grid| {
            matches!(
                grid.kind,
                TransformationGridKind::Ntv2 | TransformationGridKind::Gtg
            )
        })
    {
        return Err(ImportTransformationError::GaussKruegerGridRequired);
    }
    for grid in &operation.required_grids {
        validate_grid(grid, decision.area_of_interest, operation.kind)?;
    }
    Ok(())
}

fn validate_grid(
    grid: &RequiredTransformationGrid,
    area_of_interest: GeographicArea,
    operation_kind: CoordinateOperationKind,
) -> Result<(), ImportTransformationError> {
    if grid.official_filename.trim().is_empty() {
        return Err(ImportTransformationError::InvalidGrid("officialFilename"));
    }
    if !is_sha256(&grid.official_sha256) {
        return Err(ImportTransformationError::InvalidGrid("officialSha256"));
    }
    if grid.license.license_name.trim().is_empty() || grid.license.source.trim().is_empty() {
        return Err(ImportTransformationError::InvalidGrid("license"));
    }
    if !grid.coverage.is_valid() {
        return Err(ImportTransformationError::InvalidArea);
    }
    let RequiredGridAvailability::PresentVerified {
        local_path,
        observed_sha256,
    } = &grid.availability
    else {
        if operation_kind == CoordinateOperationKind::GaussKruegerDatumTransformation {
            return Err(ImportTransformationError::GaussKruegerRequiredGridMissing {
                filename: grid.official_filename.clone(),
            });
        }
        return Err(ImportTransformationError::RequiredGridMissing {
            filename: grid.official_filename.clone(),
        });
    };
    if local_path.trim().is_empty() {
        return Err(ImportTransformationError::RequiredGridMissing {
            filename: grid.official_filename.clone(),
        });
    }
    if observed_sha256 != &grid.official_sha256 {
        return Err(ImportTransformationError::RequiredGridHashMismatch {
            filename: grid.official_filename.clone(),
        });
    }
    if !grid.coverage.contains(area_of_interest) {
        return Err(ImportTransformationError::AreaOutsideGridCoverage {
            filename: grid.official_filename.clone(),
        });
    }
    Ok(())
}

fn is_sha256(hash: &ObjectHash) -> bool {
    hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(value: &[u8]) -> ObjectHash {
        ObjectHash::of_bytes(value)
    }

    fn germany_area() -> GeographicArea {
        GeographicArea {
            west_longitude: 5.0,
            south_latitude: 47.0,
            east_longitude: 16.0,
            north_latitude: 56.0,
        }
    }

    fn project_area() -> GeographicArea {
        GeographicArea {
            west_longitude: 9.0,
            south_latitude: 48.0,
            east_longitude: 10.0,
            north_latitude: 49.0,
        }
    }

    fn verified_grid(kind: TransformationGridKind) -> RequiredTransformationGrid {
        let official_sha256 = hash(b"official-grid-fixture");
        RequiredTransformationGrid {
            kind,
            official_filename: "official-grid.gsb".to_owned(),
            official_sha256: official_sha256.clone(),
            license: GridLicenseMetadata {
                license_name: "Fixture license".to_owned(),
                spdx_expression: Some("CC-BY-4.0".to_owned()),
                source: "https://example.invalid/official-grid".to_owned(),
                redistribution_allowed: true,
            },
            coverage: germany_area(),
            availability: RequiredGridAvailability::PresentVerified {
                local_path: "grids/official-grid.gsb".to_owned(),
                observed_sha256: official_sha256,
            },
        }
    }

    fn decision() -> ImportTransformationDecision {
        ImportTransformationDecision {
            schema_version: 1,
            contains_gps_data: true,
            horizontal: HorizontalCrsSelection {
                source: CrsWithEpoch {
                    crs: CrsDefinition::Epsg(4_326),
                    coordinate_epoch: Some(CoordinateEpoch {
                        decimal_year: 2025.5,
                    }),
                },
                target: CrsWithEpoch {
                    crs: CrsDefinition::Epsg(25_832),
                    coordinate_epoch: None,
                },
            },
            vertical: Some(VerticalCrsSelection {
                source: HeightReference::Ellipsoidal,
                target: HeightReference::Orthometric {
                    vertical_crs: CrsDefinition::Epsg(7_837),
                },
                mode: VerticalOperationMode::Transform,
            }),
            area_of_interest: project_area(),
            operation: OperationCandidate {
                operation_id: "fixture-operation".to_owned(),
                name: "WGS 84 to ETRS89 / UTM32 plus height".to_owned(),
                kind: CoordinateOperationKind::General,
                proj_pipeline: "+proj=pipeline +step +proj=unitconvert".to_owned(),
                area_of_use: germany_area(),
                expected_accuracy_mm: Some(10.0),
                ballpark: false,
                best_available: true,
                required_grids: vec![verified_grid(TransformationGridKind::Geoid)],
            },
            selection_policy: OperationSelectionPolicy::default(),
            ballpark_confirmation: None,
            database_versions: CrsDatabaseVersions {
                proj_version: "9.6.2".to_owned(),
                epsg_database_version: "12.013".to_owned(),
            },
        }
    }

    #[test]
    fn defaults_are_allow_ballpark_no_and_only_best_yes() {
        let policy = OperationSelectionPolicy::default();

        assert!(!policy.allow_ballpark);
        assert!(policy.only_best);
        assert_eq!(policy.proj_allow_ballpark(), "NO");
        assert_eq!(policy.proj_only_best(), "YES");
    }

    #[test]
    fn gps_data_requires_an_explicit_height_decision() {
        let mut decision = decision();
        decision.vertical = None;

        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::MissingHeightDecision)
        );
    }

    #[test]
    fn nt2v_transformation_and_testpunkte_echtumstellung_require_verified_gk_grid() {
        let mut decision = decision();
        decision.operation.kind = CoordinateOperationKind::GaussKruegerDatumTransformation;
        decision.operation.required_grids.clear();

        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::GaussKruegerGridRequired)
        );

        let mut grid = verified_grid(TransformationGridKind::Ntv2);
        grid.official_filename = "BWTA2017.gsb".to_owned();
        grid.availability = RequiredGridAvailability::Missing;
        decision.operation.required_grids.push(grid);
        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::GaussKruegerRequiredGridMissing {
                filename: "BWTA2017.gsb".to_owned(),
            })
        );
    }

    #[test]
    fn ballpark_requires_policy_override_and_separate_confirmation() {
        let mut decision = decision();
        decision.operation.ballpark = true;

        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::BallparkDisallowed)
        );

        decision.selection_policy.allow_ballpark = true;
        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::BallparkConfirmationRequired)
        );

        decision.ballpark_confirmation = Some(BallparkConfirmation {
            confirmed_by: "test-user".to_owned(),
            reason: "No authoritative operation covers this isolated fixture".to_owned(),
        });
        assert!(decision.validate_and_freeze().is_ok());
    }

    #[test]
    fn rejects_operation_and_grid_coverage_gaps() {
        let mut outside_operation = decision();
        outside_operation.area_of_interest.east_longitude = 17.0;
        assert_eq!(
            outside_operation.validate_and_freeze(),
            Err(ImportTransformationError::AreaOutsideOperationCoverage)
        );

        let mut outside_grid = decision();
        outside_grid.operation.required_grids[0].coverage = GeographicArea {
            west_longitude: 9.2,
            south_latitude: 48.2,
            east_longitude: 9.8,
            north_latitude: 48.8,
        };
        assert_eq!(
            outside_grid.validate_and_freeze(),
            Err(ImportTransformationError::AreaOutsideGridCoverage {
                filename: "official-grid.gsb".to_owned(),
            })
        );
    }

    #[test]
    fn rejects_hash_mismatched_required_grid() {
        let mut decision = decision();
        decision.operation.required_grids[0].availability =
            RequiredGridAvailability::PresentVerified {
                local_path: "grids/official-grid.gsb".to_owned(),
                observed_sha256: hash(b"tampered-grid"),
            };

        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::RequiredGridHashMismatch {
                filename: "official-grid.gsb".to_owned(),
            })
        );
    }

    #[test]
    fn frozen_record_preserves_original_target_pipeline_versions_and_grid_evidence() {
        let decision = decision();
        let frozen = decision
            .validate_and_freeze()
            .expect("complete decision must freeze");

        assert_eq!(frozen.original.horizontal, decision.horizontal.source);
        assert_eq!(frozen.target.horizontal, decision.horizontal.target);
        assert_eq!(
            frozen.target.vertical,
            decision.vertical.as_ref().expect("fixture vertical").target
        );
        assert_eq!(
            frozen.pipeline.proj_pipeline,
            decision.operation.proj_pipeline
        );
        assert_eq!(frozen.pipeline.grids.len(), 1);
        assert_eq!(frozen.database_versions, decision.database_versions);
        assert_eq!(
            frozen.decision_sha256,
            decision
                .validate_and_freeze()
                .expect("same decision must freeze repeatedly")
                .decision_sha256
        );
    }

    #[test]
    fn wkt2_projjson_and_coordinate_epoch_are_explicitly_validated() {
        let mut decision = decision();
        decision.horizontal.source.crs = CrsDefinition::Wkt2("GEOGCRS[\"WGS 84\"]".to_owned());
        decision.horizontal.target.crs =
            CrsDefinition::ProjJson("{\"type\":\"ProjectedCRS\"}".to_owned());
        assert!(decision.validate_and_freeze().is_ok());

        decision.horizontal.source.coordinate_epoch = Some(CoordinateEpoch {
            decimal_year: f64::NAN,
        });
        assert_eq!(
            decision.validate_and_freeze(),
            Err(ImportTransformationError::InvalidCoordinateEpoch)
        );
    }
}
