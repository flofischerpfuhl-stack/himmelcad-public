//! Reusable coordinate transformation contracts.
//!
//! This module describes *what* transform to apply and how to audit it. Execution lives in
//! `himmelcad-sidecar::transform_runtime` (PROJ, grid inspection, batch apply). Geometry
//! adapters (LAS, mesh, polyline, …) only extract/write `f64` points.
//!
//! Design priorities (in order):
//! 1. Accuracy and explicit auditability
//! 2. Format-agnostic grid/geoid binding (content inspection, not file names)
//! 3. Streaming-friendly batch application
//! 4. Integration surface small enough for PhotoLab import, Builder CRS tools, and jobs

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;
use crate::photolab_crs::{
    CrsDatabaseVersions, CrsDefinition, CrsWithEpoch, GeographicArea, HeightReference,
    OperationSelectionPolicy,
};

/// Contract schema version for persisted transform recipes.
pub const TRANSFORM_SPEC_SCHEMA_VERSION: u32 = 1;

/// A single world-space point. Always `f64` — absolute projected CRS values must not go through f32.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl WorldPoint {
    #[must_use]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[must_use]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    #[must_use]
    pub fn as_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }

    #[must_use]
    pub fn from_array(value: [f64; 3]) -> Self {
        Self {
            x: value[0],
            y: value[1],
            z: value[2],
        }
    }
}

/// Axis-aligned bounds in the coordinate system of the points being transformed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldBounds {
    pub min: WorldPoint,
    pub max: WorldPoint,
}

impl WorldBounds {
    #[must_use]
    pub fn is_valid(self) -> bool {
        self.min.is_finite()
            && self.max.is_finite()
            && self.min.x <= self.max.x
            && self.min.y <= self.max.y
            && self.min.z <= self.max.z
    }

    #[must_use]
    pub fn expand(self, margin: f64) -> Self {
        Self {
            min: WorldPoint::new(
                self.min.x - margin,
                self.min.y - margin,
                self.min.z - margin,
            ),
            max: WorldPoint::new(
                self.max.x + margin,
                self.max.y + margin,
                self.max.z + margin,
            ),
        }
    }
}

/// First wizard choice: how horizontal and vertical are composed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransformCompositionMode {
    /// Classical survey workflow: horizontal op then vertical op (or reverse if configured).
    SeparateHorizontalVertical,
    /// One 3D similarity / affine / freeform in XYZ.
    Joint3D,
    /// Ordered cascade of stages (e.g. PROJ datum → site cal → optional refinement).
    HybridCascade,
}

/// Order when using [`TransformCompositionMode::SeparateHorizontalVertical`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SeparateStageOrder {
    #[default]
    HorizontalThenVertical,
    VerticalThenHorizontal,
}

/// Behaviour when a point falls outside a grid/geoid coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OutOfBoundsPolicy {
    /// Fail the whole batch (default for survey deliverables).
    #[default]
    Error,
    /// Keep the input coordinate and mark the index in the residual report.
    FlagAndPreserve,
    /// Drop the point from the output stream (adapters must handle holes).
    Skip,
}

/// Content-detected shift / geoid / velocity grid formats we accept.
///
/// Detection is by **file content**, never by file name. File names may only produce warnings
/// when they disagree with an optional authority hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridFileFormat {
    /// NTv2 binary (`.gsb` / `.gsa` layout).
    Ntv2,
    /// NOAA/PROJ classic vertical GTX.
    Gtx,
    /// Geodetic TIFF grid (GTG) — horizontal, vertical, or compound.
    GeodeticTiff,
    /// PROJ ctable binary (legacy NADCON-style).
    Ctable,
    /// Trimble GGF vertical/geoid grid (proprietary layout; clean-room readable).
    Ggf,
    /// Unknown but present; PROJ may still open it via `+grids=`.
    Unrecognized,
}

impl GridFileFormat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ntv2 => "ntv2",
            Self::Gtx => "gtx",
            Self::GeodeticTiff => "geodeticTiff",
            Self::Ctable => "ctable",
            Self::Ggf => "ggf",
            Self::Unrecognized => "unrecognized",
        }
    }
}

/// Semantic role of a grid inside a pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridRole {
    HorizontalDatumShift,
    VerticalGeoidOrOffset,
    Velocity,
    Combined,
    Unknown,
}

/// Optional authority expectations. Mismatch → warning, not hard failure by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GridAuthorityHint {
    /// e.g. `"EPSG:15948"` or free text `"BETA2007"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_operation: Option<String>,
    /// e.g. source CRS authority the grid claims to leave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_source_crs: Option<String>,
    /// e.g. target CRS authority the grid claims to reach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_target_crs: Option<String>,
    /// Optional expected content hash when the operator pins a known good file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<ObjectHash>,
}

/// Path-based grid binding. The path is the identity; the file name is not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFileRef {
    pub path: String,
    pub role: GridRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_hint: Option<GridAuthorityHint>,
}

/// Result of inspecting a grid/geoid file on disk (populated by the runtime).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedGridFile {
    pub path: String,
    pub format: GridFileFormat,
    pub role_guess: GridRole,
    pub file_bytes: u64,
    pub sha256: ObjectHash,
    /// Geographic coverage when the format exposes it (degrees).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<GeographicArea>,
    /// e.g. NTv2 SYSTEM_F / SYSTEM_T, GTG GeoKeys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_type_label: Option<String>,
    /// Node / sample counts when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u64>,
    /// Soft mismatches (filename vs content, authority hints, low resolution, …).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// PROJ-backed CRS operation (horizontal, vertical, or compound).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjCoordinateOp {
    pub source: CrsWithEpoch,
    pub target: CrsWithEpoch,
    /// Explicit PROJ pipeline string when the operator (or discovery) pinned one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proj_pipeline: Option<String>,
    /// Grids the pipeline must load (absolute/project paths). Names are irrelevant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grids: Vec<GridFileRef>,
    #[serde(default)]
    pub selection_policy: OperationSelectionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_accuracy_mm: Option<f64>,
    #[serde(default)]
    pub ballpark: bool,
}

/// Constant height offset in metres (target = source + offset).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightOffsetOp {
    pub offset_meters: f64,
}

/// Inclined plane for height: `h' = h + a + b*E + c*N` (E/N in the working horizontal frame).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightPlaneOp {
    pub a_meters: f64,
    pub b: f64,
    pub c: f64,
}

/// 2D similarity (Helmert): translation, rotation (radians CCW), uniform scale.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Similarity2D {
    pub tx: f64,
    pub ty: f64,
    pub rotation_radians: f64,
    pub scale: f64,
}

/// 2D affine: `x' = a*x + b*y + tx`, `y' = c*x + d*y + ty`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Affine2D {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub tx: f64,
    pub ty: f64,
}

/// 3D similarity (7-parameter Helmert) in cartesian XYZ of the working frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Similarity3D {
    pub tx: f64,
    pub ty: f64,
    pub tz: f64,
    pub rx_radians: f64,
    pub ry_radians: f64,
    pub rz_radians: f64,
    pub scale: f64,
}

/// Control-point pair used to estimate empirical models.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPair {
    pub source: WorldPoint,
    pub target: WorldPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Empirical model kind requested when fitting control pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmpiricalModelKind {
    Translation2D,
    Rigid2D,
    Similarity2D,
    Affine2D,
    Translation3D,
    Rigid3D,
    Similarity3D,
}

/// Fitted or hand-entered empirical stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EmpiricalOp {
    Similarity2D {
        model: Similarity2D,
        /// Apply to XY only; Z unchanged unless `z_offset` set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        z_offset: Option<f64>,
    },
    Affine2D {
        model: Affine2D,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        z_offset: Option<f64>,
    },
    Similarity3D {
        model: Similarity3D,
    },
    Translation3D {
        tx: f64,
        ty: f64,
        tz: f64,
    },
}

/// One ordered stage in a cascade.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransformStage {
    /// Identity (explicit no-op).
    Identity,
    Proj(ProjCoordinateOp),
    HeightOffset(HeightOffsetOp),
    HeightPlane(HeightPlaneOp),
    Empirical(EmpiricalOp),
    /// Vertical CRS transform expressed as PROJ compound endpoints.
    VerticalProj {
        source: HeightReference,
        target: HeightReference,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proj_pipeline: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        grids: Vec<GridFileRef>,
    },
    /// Apply geoid undulation \(N\) from a vertical grid file (GGF, GTX, GTG, …).
    ///
    /// - `subtract_undulation = true`:  \(H = h - N\) (ellipsoid → gravity-related)
    /// - `subtract_undulation = false`: \(h = H + N\) (gravity-related → ellipsoid)
    ///
    /// Horizontal coordinates are interpreted as geographic degrees (lon=x, lat=y)
    /// unless `horizontal_is_projected` is set.
    GeoidUndulation {
        grid: GridFileRef,
        subtract_undulation: bool,
        /// When true, `x/y` are projected metres (E,N).
        #[serde(default)]
        horizontal_is_projected: bool,
        /// CRS of the XY coordinates when projected (e.g. `EPSG:25832`, `EPSG:31468`).
        /// Runtime inverts to WGS84 lon/lat for grid sampling, then keeps original E/N.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        geographic_crs: Option<CrsDefinition>,
    },
}

/// Full recipe. Apps persist this (or its frozen form) with products.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformSpec {
    pub schema_version: u32,
    pub composition: TransformCompositionMode,
    #[serde(default)]
    pub separate_order: SeparateStageOrder,
    /// Ordered stages for Joint3D / HybridCascade, or the horizontal stage list for Separate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<TransformStage>,
    /// Vertical stages when `composition == SeparateHorizontalVertical`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vertical_stages: Vec<TransformStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<WorldBounds>,
    #[serde(default)]
    pub out_of_bounds: OutOfBoundsPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area_of_interest: Option<GeographicArea>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Immutable audit record after validation + grid inspection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenTransform {
    pub schema_version: u32,
    pub spec: TransformSpec,
    pub inspected_grids: Vec<InspectedGridFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Expanded PROJ pipeline(s) actually used, when applicable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_proj_pipelines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_versions: Option<CrsDatabaseVersions>,
    pub spec_sha256: ObjectHash,
}

/// Residual for one control pair after fit or after apply-check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointResidual {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub source: WorldPoint,
    pub expected_target: WorldPoint,
    pub actual_target: WorldPoint,
    pub delta: WorldPoint,
    pub horizontal_meters: f64,
    pub vertical_meters: f64,
    pub spatial_meters: f64,
}

/// Fit / apply residual summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualReport {
    pub count: u64,
    pub rms_horizontal_meters: f64,
    pub rms_vertical_meters: f64,
    pub rms_spatial_meters: f64,
    pub max_spatial_meters: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<PointResidual>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub out_of_bounds_indices: Vec<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Contract-level errors (no I/O).
#[derive(Debug, Error, PartialEq)]
pub enum TransformSpecError {
    #[error("transform schema version must be non-zero")]
    InvalidSchemaVersion,
    #[error("transform has no stages")]
    EmptyStages,
    #[error("invalid CRS definition: {0}")]
    InvalidCrs(&'static str),
    #[error("invalid height offset: must be finite")]
    InvalidHeightOffset,
    #[error("invalid world bounds")]
    InvalidBounds,
    #[error("invalid geographic area of interest")]
    InvalidArea,
    #[error("similarity scale must be finite and positive")]
    InvalidScale,
    #[error("empirical model parameters must be finite")]
    InvalidEmpiricalParameters,
    #[error("control network is rank-deficient for model {0:?}: need at least {1} usable pairs")]
    InsufficientControl(EmpiricalModelKind, usize),
    #[error("control pair coordinates must be finite")]
    NonFiniteControl,
    #[error("PROJ pipeline string is empty")]
    EmptyProjPipeline,
    #[error("grid path must not be empty")]
    EmptyGridPath,
    #[error("serialization failed: {0}")]
    Serialization(String),
}

impl TransformSpec {
    /// Structural validation before the runtime touches disk or PROJ.
    pub fn validate(&self) -> Result<(), TransformSpecError> {
        if self.schema_version == 0 {
            return Err(TransformSpecError::InvalidSchemaVersion);
        }
        if self.stages.is_empty()
            && self.vertical_stages.is_empty()
            && !matches!(self.composition, TransformCompositionMode::HybridCascade)
        {
            // Allow empty only if identity is explicit.
            return Err(TransformSpecError::EmptyStages);
        }
        if let Some(bounds) = self.domain {
            if !bounds.is_valid() {
                return Err(TransformSpecError::InvalidBounds);
            }
        }
        if let Some(area) = self.area_of_interest {
            if !area.is_valid() {
                return Err(TransformSpecError::InvalidArea);
            }
        }
        for stage in self.stages.iter().chain(self.vertical_stages.iter()) {
            validate_stage(stage)?;
        }
        Ok(())
    }

    /// Freezes the recipe with inspected grids and optional PROJ version metadata.
    pub fn freeze(
        &self,
        inspected_grids: Vec<InspectedGridFile>,
        resolved_proj_pipelines: Vec<String>,
        warnings: Vec<String>,
        database_versions: Option<CrsDatabaseVersions>,
    ) -> Result<FrozenTransform, TransformSpecError> {
        self.validate()?;
        let encoded = serde_json::to_vec(self)
            .map_err(|error| TransformSpecError::Serialization(error.to_string()))?;
        Ok(FrozenTransform {
            schema_version: self.schema_version,
            spec: self.clone(),
            inspected_grids,
            warnings,
            resolved_proj_pipelines,
            database_versions,
            spec_sha256: ObjectHash::of_bytes(&encoded),
        })
    }
}

fn validate_stage(stage: &TransformStage) -> Result<(), TransformSpecError> {
    match stage {
        TransformStage::Identity => Ok(()),
        TransformStage::Proj(op) => validate_proj_op(op),
        TransformStage::HeightOffset(op) => {
            if op.offset_meters.is_finite() {
                Ok(())
            } else {
                Err(TransformSpecError::InvalidHeightOffset)
            }
        }
        TransformStage::HeightPlane(op) => {
            if op.a_meters.is_finite() && op.b.is_finite() && op.c.is_finite() {
                Ok(())
            } else {
                Err(TransformSpecError::InvalidEmpiricalParameters)
            }
        }
        TransformStage::Empirical(op) => validate_empirical(op),
        TransformStage::VerticalProj {
            source: _,
            target: _,
            proj_pipeline,
            grids,
        } => {
            if let Some(pipeline) = proj_pipeline {
                if pipeline.trim().is_empty() {
                    return Err(TransformSpecError::EmptyProjPipeline);
                }
            }
            for grid in grids {
                if grid.path.trim().is_empty() {
                    return Err(TransformSpecError::EmptyGridPath);
                }
            }
            Ok(())
        }
        TransformStage::GeoidUndulation {
            grid,
            horizontal_is_projected,
            geographic_crs,
            ..
        } => {
            if grid.path.trim().is_empty() {
                return Err(TransformSpecError::EmptyGridPath);
            }
            if *horizontal_is_projected {
                match geographic_crs {
                    Some(crs) => validate_crs_def(crs, "projected source crs for geoid")?,
                    None => {
                        return Err(TransformSpecError::InvalidCrs(
                            "geoid undulation on projected XY requires projected CRS in geographicCrs field",
                        ));
                    }
                }
            }
            Ok(())
        }
    }
}

fn validate_proj_op(op: &ProjCoordinateOp) -> Result<(), TransformSpecError> {
    validate_crs_def(&op.source.crs, "proj source")?;
    validate_crs_def(&op.target.crs, "proj target")?;
    if let Some(pipeline) = &op.proj_pipeline {
        if pipeline.trim().is_empty() {
            return Err(TransformSpecError::EmptyProjPipeline);
        }
    }
    for grid in &op.grids {
        if grid.path.trim().is_empty() {
            return Err(TransformSpecError::EmptyGridPath);
        }
    }
    if op
        .expected_accuracy_mm
        .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err(TransformSpecError::InvalidEmpiricalParameters);
    }
    Ok(())
}

fn validate_crs_def(crs: &CrsDefinition, field: &'static str) -> Result<(), TransformSpecError> {
    let valid = match crs {
        CrsDefinition::Epsg(code) => *code > 0,
        CrsDefinition::Authority(value) => !value.trim().is_empty(),
        CrsDefinition::Wkt2(value) | CrsDefinition::ProjJson(value) => !value.trim().is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(TransformSpecError::InvalidCrs(field))
    }
}

fn validate_empirical(op: &EmpiricalOp) -> Result<(), TransformSpecError> {
    let finite = match op {
        EmpiricalOp::Similarity2D { model, z_offset } => {
            model.tx.is_finite()
                && model.ty.is_finite()
                && model.rotation_radians.is_finite()
                && model.scale.is_finite()
                && model.scale > 0.0
                && z_offset.is_none_or(f64::is_finite)
        }
        EmpiricalOp::Affine2D { model, z_offset } => {
            [model.a, model.b, model.c, model.d, model.tx, model.ty]
                .into_iter()
                .all(f64::is_finite)
                && z_offset.is_none_or(f64::is_finite)
        }
        EmpiricalOp::Similarity3D { model } => {
            [
                model.tx,
                model.ty,
                model.tz,
                model.rx_radians,
                model.ry_radians,
                model.rz_radians,
                model.scale,
            ]
            .into_iter()
            .all(f64::is_finite)
                && model.scale > 0.0
        }
        EmpiricalOp::Translation3D { tx, ty, tz } => {
            tx.is_finite() && ty.is_finite() && tz.is_finite()
        }
    };
    if !finite {
        let bad_scale = match op {
            EmpiricalOp::Similarity2D {
                model: Similarity2D { scale, .. },
                ..
            }
            | EmpiricalOp::Similarity3D {
                model: Similarity3D { scale, .. },
            } => !scale.is_finite() || *scale <= 0.0,
            _ => false,
        };
        if bad_scale {
            return Err(TransformSpecError::InvalidScale);
        }
        return Err(TransformSpecError::InvalidEmpiricalParameters);
    }
    Ok(())
}

/// Minimum independent control pairs for each empirical model.
#[must_use]
pub const fn minimum_control_pairs(kind: EmpiricalModelKind) -> usize {
    match kind {
        EmpiricalModelKind::Translation2D | EmpiricalModelKind::Translation3D => 1,
        EmpiricalModelKind::Rigid2D | EmpiricalModelKind::Similarity2D => 2,
        EmpiricalModelKind::Affine2D => 3,
        EmpiricalModelKind::Rigid3D | EmpiricalModelKind::Similarity3D => 3,
    }
}

/// Apply a 2D similarity to XY (Z optional offset).
#[must_use]
pub fn apply_similarity_2d(model: Similarity2D, point: WorldPoint, z_offset: f64) -> WorldPoint {
    let cos = model.rotation_radians.cos();
    let sin = model.rotation_radians.sin();
    let x = model.scale * (cos * point.x - sin * point.y) + model.tx;
    let y = model.scale * (sin * point.x + cos * point.y) + model.ty;
    WorldPoint::new(x, y, point.z + z_offset)
}

/// Apply a 2D affine to XY.
#[must_use]
pub fn apply_affine_2d(model: Affine2D, point: WorldPoint, z_offset: f64) -> WorldPoint {
    WorldPoint::new(
        model.a * point.x + model.b * point.y + model.tx,
        model.c * point.x + model.d * point.y + model.ty,
        point.z + z_offset,
    )
}

/// Apply a small-angle 3D similarity (standard surveying linearisation).
#[must_use]
pub fn apply_similarity_3d(model: Similarity3D, point: WorldPoint) -> WorldPoint {
    let (rx, ry, rz) = (model.rx_radians, model.ry_radians, model.rz_radians);
    let s = model.scale;
    // R ≈ [[1,-rz,ry],[rz,1,-rx],[-ry,rx,1]] for small angles; full Rodrigues for generality.
    let (cx, sx) = (rx.cos(), rx.sin());
    let (cy, sy) = (ry.cos(), ry.sin());
    let (cz, sz) = (rz.cos(), rz.sin());
    // ZYX intrinsic rotations
    let r00 = cy * cz;
    let r01 = sx * sy * cz - cx * sz;
    let r02 = cx * sy * cz + sx * sz;
    let r10 = cy * sz;
    let r11 = sx * sy * sz + cx * cz;
    let r12 = cx * sy * sz - sx * cz;
    let r20 = -sy;
    let r21 = sx * cy;
    let r22 = cx * cy;
    WorldPoint::new(
        s * (r00 * point.x + r01 * point.y + r02 * point.z) + model.tx,
        s * (r10 * point.x + r11 * point.y + r12 * point.z) + model.ty,
        s * (r20 * point.x + r21 * point.y + r22 * point.z) + model.tz,
    )
}

/// Apply an empirical op without I/O.
#[must_use]
pub fn apply_empirical(op: &EmpiricalOp, point: WorldPoint) -> WorldPoint {
    match op {
        EmpiricalOp::Similarity2D { model, z_offset } => {
            apply_similarity_2d(*model, point, z_offset.unwrap_or(0.0))
        }
        EmpiricalOp::Affine2D { model, z_offset } => {
            apply_affine_2d(*model, point, z_offset.unwrap_or(0.0))
        }
        EmpiricalOp::Similarity3D { model } => apply_similarity_3d(*model, point),
        EmpiricalOp::Translation3D { tx, ty, tz } => {
            WorldPoint::new(point.x + tx, point.y + ty, point.z + tz)
        }
    }
}

/// Build a residual report from control pairs after applying `map`.
pub fn residual_report<F>(pairs: &[ControlPair], mut map: F) -> ResidualReport
where
    F: FnMut(WorldPoint) -> WorldPoint,
{
    let mut points = Vec::with_capacity(pairs.len());
    let mut sum_h2 = 0.0_f64;
    let mut sum_v2 = 0.0_f64;
    let mut sum_s2 = 0.0_f64;
    let mut max_s = 0.0_f64;
    for pair in pairs {
        let actual = map(pair.source);
        let dx = actual.x - pair.target.x;
        let dy = actual.y - pair.target.y;
        let dz = actual.z - pair.target.z;
        let horizontal = (dx * dx + dy * dy).sqrt();
        let vertical = dz.abs();
        let spatial = (dx * dx + dy * dy + dz * dz).sqrt();
        sum_h2 += horizontal * horizontal;
        sum_v2 += vertical * vertical;
        sum_s2 += spatial * spatial;
        max_s = max_s.max(spatial);
        points.push(PointResidual {
            id: pair.id.clone(),
            source: pair.source,
            expected_target: pair.target,
            actual_target: actual,
            delta: WorldPoint::new(dx, dy, dz),
            horizontal_meters: horizontal,
            vertical_meters: vertical,
            spatial_meters: spatial,
        });
    }
    let n = pairs.len().max(1) as f64;
    ResidualReport {
        count: pairs.len() as u64,
        rms_horizontal_meters: (sum_h2 / n).sqrt(),
        rms_vertical_meters: (sum_v2 / n).sqrt(),
        rms_spatial_meters: (sum_s2 / n).sqrt(),
        max_spatial_meters: max_s,
        points,
        out_of_bounds_indices: Vec::new(),
        warnings: Vec::new(),
    }
}

/// Fit a 2D similarity from ≥2 pairs (least squares, equal weights unless provided).
pub fn fit_similarity_2d(pairs: &[ControlPair]) -> Result<Similarity2D, TransformSpecError> {
    if pairs.len() < minimum_control_pairs(EmpiricalModelKind::Similarity2D) {
        return Err(TransformSpecError::InsufficientControl(
            EmpiricalModelKind::Similarity2D,
            minimum_control_pairs(EmpiricalModelKind::Similarity2D),
        ));
    }
    for pair in pairs {
        if !pair.source.is_finite() || !pair.target.is_finite() {
            return Err(TransformSpecError::NonFiniteControl);
        }
    }
    // Weighted centroid
    let mut w_sum = 0.0;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut tx = 0.0;
    let mut ty = 0.0;
    for pair in pairs {
        let w = pair.weight.unwrap_or(1.0).max(0.0);
        w_sum += w;
        sx += w * pair.source.x;
        sy += w * pair.source.y;
        tx += w * pair.target.x;
        ty += w * pair.target.y;
    }
    if w_sum <= 0.0 || !w_sum.is_finite() {
        return Err(TransformSpecError::InvalidEmpiricalParameters);
    }
    let csx = sx / w_sum;
    let csy = sy / w_sum;
    let ctx = tx / w_sum;
    let cty = ty / w_sum;

    let mut sxx = 0.0;
    let mut sxt = 0.0;
    let mut syt = 0.0;
    for pair in pairs {
        let w = pair.weight.unwrap_or(1.0).max(0.0);
        let dx = pair.source.x - csx;
        let dy = pair.source.y - csy;
        let dtx = pair.target.x - ctx;
        let dty = pair.target.y - cty;
        sxx += w * (dx * dx + dy * dy);
        sxt += w * (dx * dtx + dy * dty);
        syt += w * (dx * dty - dy * dtx);
    }
    if sxx <= 0.0 {
        return Err(TransformSpecError::InsufficientControl(
            EmpiricalModelKind::Similarity2D,
            minimum_control_pairs(EmpiricalModelKind::Similarity2D),
        ));
    }
    let scale = (sxt * sxt + syt * syt).sqrt() / sxx;
    let rotation = syt.atan2(sxt);
    let cos = rotation.cos();
    let sin = rotation.sin();
    // translation so that centroid maps correctly
    let mapped_cx = scale * (cos * csx - sin * csy);
    let mapped_cy = scale * (sin * csx + cos * csy);
    Ok(Similarity2D {
        tx: ctx - mapped_cx,
        ty: cty - mapped_cy,
        rotation_radians: rotation,
        scale,
    })
}

/// Convenience: identity transform stage list for “no transform” UI option.
#[must_use]
pub fn identity_spec() -> TransformSpec {
    TransformSpec {
        schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
        composition: TransformCompositionMode::HybridCascade,
        separate_order: SeparateStageOrder::default(),
        stages: vec![TransformStage::Identity],
        vertical_stages: Vec::new(),
        domain: None,
        out_of_bounds: OutOfBoundsPolicy::Error,
        area_of_interest: None,
        label: Some("identity".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_2d_roundtrip_on_synthetic_pairs() {
        let model = Similarity2D {
            tx: 100.0,
            ty: -50.0,
            rotation_radians: 0.1,
            scale: 1.002,
        };
        let sources = [
            WorldPoint::new(0.0, 0.0, 0.0),
            WorldPoint::new(1000.0, 0.0, 0.0),
            WorldPoint::new(0.0, 1000.0, 0.0),
            WorldPoint::new(400.0, 700.0, 10.0),
        ];
        let pairs: Vec<_> = sources
            .iter()
            .map(|source| ControlPair {
                source: *source,
                target: apply_similarity_2d(model, *source, 0.0),
                weight: None,
                id: None,
            })
            .collect();
        let fitted = fit_similarity_2d(&pairs).expect("fit");
        assert!((fitted.scale - model.scale).abs() < 1e-9);
        assert!((fitted.rotation_radians - model.rotation_radians).abs() < 1e-9);
        assert!((fitted.tx - model.tx).abs() < 1e-6);
        assert!((fitted.ty - model.ty).abs() < 1e-6);
        let report = residual_report(&pairs, |p| apply_similarity_2d(fitted, p, 0.0));
        assert!(report.max_spatial_meters < 1e-6);
    }

    #[test]
    fn empty_stages_rejected() {
        let spec = TransformSpec {
            schema_version: 1,
            composition: TransformCompositionMode::SeparateHorizontalVertical,
            separate_order: SeparateStageOrder::default(),
            stages: vec![],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: OutOfBoundsPolicy::Error,
            area_of_interest: None,
            label: None,
        };
        assert!(matches!(
            spec.validate(),
            Err(TransformSpecError::EmptyStages)
        ));
    }

    #[test]
    fn identity_spec_validates_and_freezes() {
        let spec = identity_spec();
        let frozen = spec
            .freeze(vec![], vec![], vec![], None)
            .expect("freeze identity");
        assert_eq!(frozen.schema_version, TRANSFORM_SPEC_SCHEMA_VERSION);
        assert_eq!(frozen.spec.stages.len(), 1);
    }

    #[test]
    fn insufficient_control_is_rejected() {
        let pairs = [ControlPair {
            source: WorldPoint::new(0.0, 0.0, 0.0),
            target: WorldPoint::new(1.0, 1.0, 0.0),
            weight: None,
            id: None,
        }];
        assert!(matches!(
            fit_similarity_2d(&pairs),
            Err(TransformSpecError::InsufficientControl(_, 2))
        ));
    }
}
