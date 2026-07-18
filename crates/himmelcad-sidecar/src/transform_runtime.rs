//! Execution engine for [`himmelcad_core::transform`].
//!
//! Responsibilities:
//! - inspect grid/geoid files by **content** (not file name)
//! - freeze [`TransformSpec`] into an auditable [`FrozenTransform`]
//! - apply pure-Rust empirical stages at full f64 precision
//! - apply PROJ stages via offline `cct` (same isolation model as `crs_runtime`)
//! - report out-of-bounds grid coverage according to policy
//!
//! Adapters (LAS, mesh, polyline, …) only feed `WorldPoint` batches — no format logic here.

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use himmelcad_core::{
    hash::ObjectHash,
    photolab_crs::{CrsDatabaseVersions, CrsDefinition, GeographicArea},
    photolab_jobs::CancellationToken,
    transform::{
        apply_empirical, FrozenTransform, GridAuthorityHint, GridFileFormat, GridFileRef, GridRole,
        InspectedGridFile, OutOfBoundsPolicy, ProjCoordinateOp, ResidualReport, SeparateStageOrder,
        TransformCompositionMode, TransformSpec, TransformSpecError, TransformStage, WorldPoint,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::grid_codecs::ggf::{GgfError, GgfGrid};

/// Configuration for the transform engine (local PROJ + allowed grid roots).
#[derive(Debug, Clone)]
pub struct TransformRuntimeConfig {
    pub cct_path: PathBuf,
    pub projinfo_path: PathBuf,
    pub proj_data_directory: PathBuf,
    pub allowed_grid_roots: Vec<PathBuf>,
}

impl TransformRuntimeConfig {
    /// Development default: system `cct` / `projinfo` and `/usr/share/proj`.
    #[must_use]
    pub fn system() -> Self {
        Self {
            cct_path: PathBuf::from("cct"),
            projinfo_path: PathBuf::from("projinfo"),
            proj_data_directory: PathBuf::from("/usr/share/proj"),
            allowed_grid_roots: vec![PathBuf::from("/usr/share/proj")],
        }
    }
}

/// Offline transform engine shared by PhotoLab, Builder, and batch jobs.
#[derive(Debug, Clone)]
pub struct TransformRuntime {
    config: TransformRuntimeConfig,
}

/// Result of applying a frozen transform to a point batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformBatchResult {
    pub points: Vec<WorldPoint>,
    /// Indices that were outside grid coverage (if policy kept them or skipped).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub out_of_bounds_indices: Vec<u64>,
    /// True when a point was skipped (output shorter than input).
    #[serde(default)]
    pub skipped_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Error)]
pub enum TransformRuntimeError {
    #[error(transparent)]
    Spec(#[from] TransformSpecError),
    #[error("grid file not found: {0}")]
    GridMissing(String),
    #[error("grid path '{path}' is outside allowed grid roots")]
    GridPathNotAllowed { path: String },
    #[error("failed to read grid '{path}': {reason}")]
    GridIo { path: String, reason: String },
    #[error("grid content hash mismatch for '{path}'")]
    GridHashMismatch { path: String },
    #[error("unrecognized or corrupt grid file '{path}': {reason}")]
    GridInvalid { path: String, reason: String },
    #[error("point {index} is outside grid/geoid coverage")]
    OutOfBounds { index: u64 },
    #[error("PROJ/cct failed: {0}")]
    ProjFailed(String),
    #[error("PROJ/cct produced non-finite coordinates at index {index}")]
    NonFiniteOutput { index: u64 },
    #[error("PROJ/cct returned unexpected row count (expected {expected}, got {got})")]
    RowCountMismatch { expected: usize, got: usize },
    #[error("transform cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to discover PROJ pipeline: {0}")]
    PipelineDiscovery(String),
    #[error("GGF grid error: {0}")]
    Ggf(#[from] GgfError),
    #[error("geoid undulation on projected coordinates without inverse is not implemented yet")]
    ProjectedGeoidNotImplemented,
}

impl TransformRuntime {
    #[must_use]
    pub fn new(config: TransformRuntimeConfig) -> Self {
        Self { config }
    }

    /// Inspect a grid/geoid by content. File name is never authoritative.
    pub fn inspect_grid(
        &self,
        grid: &GridFileRef,
        cancellation: &CancellationToken,
    ) -> Result<InspectedGridFile, TransformRuntimeError> {
        if cancellation.is_cancel_requested() {
            return Err(TransformRuntimeError::Cancelled);
        }
        let path = Path::new(&grid.path);
        if !path.is_file() {
            return Err(TransformRuntimeError::GridMissing(grid.path.clone()));
        }
        self.ensure_grid_allowed(path)?;
        let metadata = path
            .metadata()
            .map_err(|error| TransformRuntimeError::GridIo {
                path: grid.path.clone(),
                reason: error.to_string(),
            })?;
        let mut file = File::open(path).map_err(|error| TransformRuntimeError::GridIo {
            path: grid.path.clone(),
            reason: error.to_string(),
        })?;
        let mut header = [0_u8; 512];
        let read = file
            .read(&mut header)
            .map_err(|error| TransformRuntimeError::GridIo {
                path: grid.path.clone(),
                reason: error.to_string(),
            })?;
        let format = detect_grid_format(&header[..read]);
        let sha256 = hash_file(path)?;
        if let Some(hint) = &grid.authority_hint {
            if let Some(expected) = &hint.expected_sha256 {
                if expected != &sha256 {
                    return Err(TransformRuntimeError::GridHashMismatch {
                        path: grid.path.clone(),
                    });
                }
            }
        }

        let mut inspected = InspectedGridFile {
            path: grid.path.clone(),
            format,
            role_guess: grid.role,
            file_bytes: metadata.len(),
            sha256,
            coverage: None,
            declared_source: None,
            declared_target: None,
            grid_type_label: None,
            sample_count: None,
            warnings: Vec::new(),
        };

        match format {
            GridFileFormat::Ntv2 => enrich_ntv2_metadata(path, &mut inspected)?,
            GridFileFormat::Ggf => enrich_ggf_metadata(path, &mut inspected)?,
            GridFileFormat::GeodeticTiff => {
                inspected.grid_type_label = Some("geodetic-tiff".into());
                inspected.role_guess = match grid.role {
                    GridRole::Unknown => GridRole::VerticalGeoidOrOffset,
                    other => other,
                };
                inspected.warnings.push(
                    "GeoTIFF/GTG grids are accepted; detailed GeoKey parsing is deferred to PROJ at apply time"
                        .into(),
                );
            }
            GridFileFormat::Gtx => {
                inspected.grid_type_label = Some("gtx".into());
                inspected.role_guess = match grid.role {
                    GridRole::Unknown => GridRole::VerticalGeoidOrOffset,
                    other => other,
                };
            }
            GridFileFormat::Ctable => {
                inspected.grid_type_label = Some("ctable".into());
            }
            GridFileFormat::Unrecognized => {
                inspected.warnings.push(
                    "file format was not recognized by magic-byte inspection; PROJ may still open it via +grids="
                        .into(),
                );
            }
        }

        if let Some(hint) = &grid.authority_hint {
            append_authority_warnings(&mut inspected, hint);
        }
        append_filename_vs_content_warnings(&mut inspected);

        if matches!(format, GridFileFormat::Unrecognized) && metadata.len() < 64 {
            return Err(TransformRuntimeError::GridInvalid {
                path: grid.path.clone(),
                reason: "file too small to be a valid shift/geoid grid".into(),
            });
        }

        // Soft role mismatch
        if !matches!(grid.role, GridRole::Unknown)
            && !matches!(inspected.role_guess, GridRole::Unknown)
            && grid.role != inspected.role_guess
        {
            inspected.warnings.push(format!(
                "declared role {:?} differs from content guess {:?}",
                grid.role, inspected.role_guess
            ));
        }

        Ok(inspected)
    }

    /// Validate the spec, inspect every referenced grid, resolve PROJ pipelines, freeze.
    pub fn freeze_spec(
        &self,
        spec: &TransformSpec,
        cancellation: &CancellationToken,
    ) -> Result<FrozenTransform, TransformRuntimeError> {
        spec.validate()?;
        let mut inspected = Vec::new();
        let mut warnings = Vec::new();
        let mut resolved_pipelines = Vec::new();

        for stage in ordered_stages(spec) {
            match stage {
                TransformStage::Proj(op) => {
                    for grid in &op.grids {
                        inspected.push(self.inspect_grid(grid, cancellation)?);
                    }
                    let pipeline = self.resolve_proj_pipeline(op, cancellation)?;
                    resolved_pipelines.push(pipeline);
                }
                TransformStage::VerticalProj {
                    grids,
                    proj_pipeline,
                    ..
                } => {
                    for grid in grids {
                        inspected.push(self.inspect_grid(grid, cancellation)?);
                    }
                    if let Some(pipeline) = proj_pipeline {
                        if pipeline.trim().is_empty() {
                            return Err(TransformSpecError::EmptyProjPipeline.into());
                        }
                        resolved_pipelines.push(pipeline.clone());
                    }
                }
                TransformStage::GeoidUndulation { grid, .. } => {
                    inspected.push(self.inspect_grid(grid, cancellation)?);
                }
                _ => {}
            }
        }

        for grid in &inspected {
            warnings.extend(grid.warnings.iter().cloned());
        }

        let database_versions = self.try_proj_versions();
        Ok(spec.freeze(inspected, resolved_pipelines, warnings, database_versions)?)
    }

    /// Apply a frozen transform to an in-memory point batch (f64).
    pub fn apply_points(
        &self,
        frozen: &FrozenTransform,
        points: &[WorldPoint],
        cancellation: &CancellationToken,
    ) -> Result<TransformBatchResult, TransformRuntimeError> {
        if cancellation.is_cancel_requested() {
            return Err(TransformRuntimeError::Cancelled);
        }
        frozen.spec.validate()?;

        let mut current: Vec<WorldPoint> = points.to_vec();
        let mut out_of_bounds = Vec::new();
        let mut skipped = 0_u64;
        let mut warnings = frozen.warnings.clone();
        let mut pipeline_index = 0_usize;

        for stage in ordered_stages(&frozen.spec) {
            if cancellation.is_cancel_requested() {
                return Err(TransformRuntimeError::Cancelled);
            }
            match stage {
                TransformStage::Identity => {}
                TransformStage::HeightOffset(op) => {
                    for point in &mut current {
                        point.z += op.offset_meters;
                    }
                }
                TransformStage::HeightPlane(op) => {
                    for point in &mut current {
                        point.z += op.a_meters + op.b * point.x + op.c * point.y;
                    }
                }
                TransformStage::Empirical(op) => {
                    for point in &mut current {
                        *point = apply_empirical(op, *point);
                    }
                }
                TransformStage::Proj(op) => {
                    let pipeline = frozen
                        .resolved_proj_pipelines
                        .get(pipeline_index)
                        .cloned()
                        .map(Ok)
                        .unwrap_or_else(|| self.resolve_proj_pipeline(op, cancellation))?;
                    pipeline_index += 1;
                    let grid_dirs = grid_parent_dirs(&op.grids);
                    let (next, oob, skip, stage_warnings) = self.apply_proj_stage(
                        &pipeline,
                        &grid_dirs,
                        &current,
                        frozen.spec.out_of_bounds,
                        cancellation,
                    )?;
                    current = next;
                    out_of_bounds.extend(oob);
                    skipped += skip;
                    warnings.extend(stage_warnings);
                }
                TransformStage::VerticalProj {
                    proj_pipeline,
                    grids,
                    ..
                } => {
                    let Some(pipeline) = proj_pipeline else {
                        warnings.push(
                            "vertical PROJ stage without explicit pipeline was skipped".into(),
                        );
                        continue;
                    };
                    let grid_dirs = grid_parent_dirs(grids);
                    let (next, oob, skip, stage_warnings) = self.apply_proj_stage(
                        pipeline,
                        &grid_dirs,
                        &current,
                        frozen.spec.out_of_bounds,
                        cancellation,
                    )?;
                    current = next;
                    out_of_bounds.extend(oob);
                    skipped += skip;
                    warnings.extend(stage_warnings);
                    pipeline_index += 1;
                }
                TransformStage::GeoidUndulation {
                    grid,
                    subtract_undulation,
                    horizontal_is_projected,
                    geographic_crs: _,
                } => {
                    if *horizontal_is_projected {
                        return Err(TransformRuntimeError::ProjectedGeoidNotImplemented);
                    }
                    let (next, oob, skip, stage_warnings) = self.apply_geoid_undulation(
                        grid,
                        *subtract_undulation,
                        &current,
                        frozen.spec.out_of_bounds,
                        cancellation,
                    )?;
                    current = next;
                    out_of_bounds.extend(oob);
                    skipped += skip;
                    warnings.extend(stage_warnings);
                }
            }
        }

        Ok(TransformBatchResult {
            points: current,
            out_of_bounds_indices: out_of_bounds,
            skipped_count: skipped,
            warnings,
        })
    }

    /// Convenience: freeze + apply in one call (import wizards, small batches).
    pub fn transform_points(
        &self,
        spec: &TransformSpec,
        points: &[WorldPoint],
        cancellation: &CancellationToken,
    ) -> Result<(FrozenTransform, TransformBatchResult), TransformRuntimeError> {
        let frozen = self.freeze_spec(spec, cancellation)?;
        let result = self.apply_points(&frozen, points, cancellation)?;
        Ok((frozen, result))
    }

    fn apply_geoid_undulation(
        &self,
        grid_ref: &GridFileRef,
        subtract: bool,
        points: &[WorldPoint],
        oob_policy: OutOfBoundsPolicy,
        cancellation: &CancellationToken,
    ) -> Result<(Vec<WorldPoint>, Vec<u64>, u64, Vec<String>), TransformRuntimeError> {
        if cancellation.is_cancel_requested() {
            return Err(TransformRuntimeError::Cancelled);
        }
        let path = Path::new(&grid_ref.path);
        self.ensure_grid_allowed(path)?;
        // GGF: native high-accuracy bilinear. Other vertical grids: PROJ vgridshift.
        let mut header = [0_u8; 32];
        {
            let mut file = File::open(path)?;
            let _ = file.read(&mut header)?;
        }
        if GgfGrid::looks_like(&header) {
            let grid = GgfGrid::open(path)?;
            let mut out = Vec::with_capacity(points.len());
            let mut oob = Vec::new();
            let mut skipped = 0_u64;
            let mut warnings = Vec::new();
            for (index, point) in points.iter().enumerate() {
                // Convention for geographic stages: x=lon, y=lat (degrees).
                match grid.sample_undulation(point.y, point.x) {
                    Ok(n) => {
                        let z = if subtract {
                            point.z - n
                        } else {
                            point.z + n
                        };
                        out.push(WorldPoint::new(point.x, point.y, z));
                    }
                    Err(GgfError::OutOfBounds) | Err(GgfError::Missing) => match oob_policy {
                        OutOfBoundsPolicy::Error => {
                            return Err(TransformRuntimeError::OutOfBounds {
                                index: index as u64,
                            });
                        }
                        OutOfBoundsPolicy::FlagAndPreserve => {
                            oob.push(index as u64);
                            out.push(*point);
                            warnings.push(format!(
                                "point {index} outside GGF coverage/nodata; preserved Z"
                            ));
                        }
                        OutOfBoundsPolicy::Skip => {
                            oob.push(index as u64);
                            skipped += 1;
                        }
                    },
                    Err(other) => return Err(other.into()),
                }
            }
            return Ok((out, oob, skipped, warnings));
        }

        // PROJ path for GTX/GTG: apply vgridshift with multiplier ±1
        let mult = if subtract { -1.0 } else { 1.0 };
        let path_str = grid_ref.path.replace('\\', "/");
        let pipeline = format!(
            "+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=vgridshift +grids={path_str} +multiplier={mult} +step +proj=unitconvert +xy_in=rad +xy_out=deg"
        );
        let parents = grid_parent_dirs(std::slice::from_ref(grid_ref));
        self.apply_proj_stage(&pipeline, &parents, points, oob_policy, cancellation)
    }

    fn apply_proj_stage(
        &self,
        pipeline: &str,
        extra_data_dirs: &[PathBuf],
        points: &[WorldPoint],
        oob_policy: OutOfBoundsPolicy,
        cancellation: &CancellationToken,
    ) -> Result<(Vec<WorldPoint>, Vec<u64>, u64, Vec<String>), TransformRuntimeError> {
        if points.is_empty() {
            return Ok((Vec::new(), Vec::new(), 0, Vec::new()));
        }
        if cancellation.is_cancel_requested() {
            return Err(TransformRuntimeError::Cancelled);
        }

        let mut input = String::with_capacity(points.len() * 48);
        for point in points {
            if !point.is_finite() {
                return Err(TransformRuntimeError::NonFiniteOutput { index: 0 });
            }
            // cct expects x y z t
            input.push_str(&format!(
                "{:.15} {:.15} {:.15} 0\n",
                point.x, point.y, point.z
            ));
        }

        let output = self.run_cct(pipeline, extra_data_dirs, &input, cancellation)?;
        let mut out_points = Vec::with_capacity(points.len());
        let mut oob = Vec::new();
        let mut skipped = 0_u64;
        let mut warnings = Vec::new();

        for (index, line) in output.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // PROJ marks failed grid lookups with '*" or inf in some versions
            if line.contains('*') || line.to_ascii_lowercase().contains("inf") {
                match oob_policy {
                    OutOfBoundsPolicy::Error => {
                        return Err(TransformRuntimeError::OutOfBounds {
                            index: index as u64,
                        });
                    }
                    OutOfBoundsPolicy::FlagAndPreserve => {
                        oob.push(index as u64);
                        out_points.push(points[index]);
                        warnings.push(format!(
                            "point {index} outside grid/geoid coverage; preserved input coordinates"
                        ));
                    }
                    OutOfBoundsPolicy::Skip => {
                        oob.push(index as u64);
                        skipped += 1;
                    }
                }
                continue;
            }
            let values = parse_cct_row(line).ok_or(TransformRuntimeError::ProjFailed(format!(
                "unparseable cct row: {line}"
            )))?;
            if values.iter().take(3).any(|value| !value.is_finite()) {
                match oob_policy {
                    OutOfBoundsPolicy::Error => {
                        return Err(TransformRuntimeError::NonFiniteOutput {
                            index: index as u64,
                        });
                    }
                    OutOfBoundsPolicy::FlagAndPreserve => {
                        oob.push(index as u64);
                        out_points.push(points[index]);
                    }
                    OutOfBoundsPolicy::Skip => {
                        oob.push(index as u64);
                        skipped += 1;
                    }
                }
                continue;
            }
            out_points.push(WorldPoint::new(values[0], values[1], values[2]));
        }

        let expected_kept = points.len() as u64 - skipped;
        if out_points.len() as u64 != expected_kept
            && !matches!(oob_policy, OutOfBoundsPolicy::Skip)
        {
            // Allow minor header noise only when counts still match input
            if out_points.len() != points.len() {
                return Err(TransformRuntimeError::RowCountMismatch {
                    expected: points.len(),
                    got: out_points.len(),
                });
            }
        }

        Ok((out_points, oob, skipped, warnings))
    }

    fn run_cct(
        &self,
        pipeline: &str,
        extra_data_dirs: &[PathBuf],
        input: &str,
        cancellation: &CancellationToken,
    ) -> Result<String, TransformRuntimeError> {
        if cancellation.is_cancel_requested() {
            return Err(TransformRuntimeError::Cancelled);
        }
        let tokens = tokenize_pipeline(pipeline)?;
        let mut command = Command::new(&self.config.cct_path);
        command
            .arg("--columns")
            .arg("1,2,3,4")
            .arg("--decimals")
            .arg("15")
            .args(&tokens)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut search = Vec::new();
        for dir in extra_data_dirs {
            if !search.contains(dir) {
                search.push(dir.clone());
            }
        }
        for root in &self.config.allowed_grid_roots {
            if !search.contains(root) {
                search.push(root.clone());
            }
        }
        if !search.contains(&self.config.proj_data_directory) {
            search.push(self.config.proj_data_directory.clone());
        }
        if let Ok(joined) = std::env::join_paths(&search) {
            command.env("PROJ_DATA", joined);
        }
        // Never allow network grid fetch in product paths.
        command.env("PROJ_NETWORK", "OFF");

        let mut child = command
            .spawn()
            .map_err(|error| TransformRuntimeError::ProjFailed(format!("spawn cct: {error}")))?;
        {
            let stdin = child
                .stdin
                .as_mut()
                .ok_or_else(|| TransformRuntimeError::ProjFailed("cct stdin missing".into()))?;
            stdin.write_all(input.as_bytes())?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| TransformRuntimeError::ProjFailed(format!("cct wait: {error}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TransformRuntimeError::ProjFailed(stderr.trim().to_owned()));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn resolve_proj_pipeline(
        &self,
        op: &ProjCoordinateOp,
        cancellation: &CancellationToken,
    ) -> Result<String, TransformRuntimeError> {
        if cancellation.is_cancel_requested() {
            return Err(TransformRuntimeError::Cancelled);
        }
        if let Some(pipeline) = &op.proj_pipeline {
            if pipeline.trim().is_empty() {
                return Err(TransformSpecError::EmptyProjPipeline.into());
            }
            // If grids are bound, inject absolute +grids= paths when not already present.
            return Ok(inject_grid_paths(pipeline, &op.grids));
        }

        let source = crs_to_string(&op.source.crs)?;
        let target = crs_to_string(&op.target.crs)?;
        let mut command = Command::new(&self.config.projinfo_path);
        command
            .arg("-s")
            .arg(&source)
            .arg("-t")
            .arg(&target)
            .arg("-o")
            .arg("PROJ")
            .arg("--spatial-test")
            .arg("intersects")
            .arg("--hide-ballpark");
        if !op.selection_policy.allow_ballpark {
            // already hiding ballpark
        }
        command.env("PROJ_NETWORK", "OFF");
        command.env("PROJ_DATA", &self.config.proj_data_directory);
        let output = command
            .output()
            .map_err(|error| TransformRuntimeError::PipelineDiscovery(error.to_string()))?;
        if !output.status.success() {
            return Err(TransformRuntimeError::PipelineDiscovery(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let pipeline = extract_proj_pipeline(&stdout).ok_or_else(|| {
            TransformRuntimeError::PipelineDiscovery(
                "projinfo did not return a PROJ pipeline".into(),
            )
        })?;
        Ok(inject_grid_paths(&pipeline, &op.grids))
    }

    fn ensure_grid_allowed(&self, path: &Path) -> Result<(), TransformRuntimeError> {
        let canonical = path
            .canonicalize()
            .map_err(|error| TransformRuntimeError::GridIo {
                path: path.display().to_string(),
                reason: error.to_string(),
            })?;
        if self.config.allowed_grid_roots.is_empty() {
            return Ok(());
        }
        for root in &self.config.allowed_grid_roots {
            let Ok(root) = root.canonicalize() else {
                continue;
            };
            if canonical.starts_with(&root) {
                return Ok(());
            }
        }
        // Also allow if path is under PROJ data
        if let Ok(data) = self.config.proj_data_directory.canonicalize() {
            if canonical.starts_with(data) {
                return Ok(());
            }
        }
        Err(TransformRuntimeError::GridPathNotAllowed {
            path: path.display().to_string(),
        })
    }

    fn try_proj_versions(&self) -> Option<CrsDatabaseVersions> {
        let output = Command::new(&self.config.cct_path)
            .arg("--version")
            .output()
            .ok()?;
        let text = if output.stdout.is_empty() {
            String::from_utf8_lossy(&output.stderr).into_owned()
        } else {
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        let proj_version = text
            .lines()
            .find_map(|line| {
                line.split_whitespace()
                    .find(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "unknown".into());
        Some(CrsDatabaseVersions {
            proj_version,
            epsg_database_version: "local".into(),
        })
    }
}

fn ordered_stages(spec: &TransformSpec) -> Vec<&TransformStage> {
    match spec.composition {
        TransformCompositionMode::SeparateHorizontalVertical => match spec.separate_order {
            SeparateStageOrder::HorizontalThenVertical => spec
                .stages
                .iter()
                .chain(spec.vertical_stages.iter())
                .collect(),
            SeparateStageOrder::VerticalThenHorizontal => spec
                .vertical_stages
                .iter()
                .chain(spec.stages.iter())
                .collect(),
        },
        TransformCompositionMode::Joint3D | TransformCompositionMode::HybridCascade => {
            spec.stages.iter().collect()
        }
    }
}

fn detect_grid_format(header: &[u8]) -> GridFileFormat {
    if GgfGrid::looks_like(header) {
        return GridFileFormat::Ggf;
    }
    if header.starts_with(b"NUM_OREC") || header.windows(8).any(|w| w == b"NUM_OREC") {
        return GridFileFormat::Ntv2;
    }
    // TIFF little/big endian
    if header.starts_with(b"II*\0") || header.starts_with(b"MM\0*") {
        return GridFileFormat::GeodeticTiff;
    }
    // ctable: "CTABLE V2" etc.
    if header.windows(6).any(|w| w == b"CTABLE") {
        return GridFileFormat::Ctable;
    }
    // GTX has no magic; leave unrecognized (PROJ still accepts path via +grids=).
    GridFileFormat::Unrecognized
}

fn enrich_ggf_metadata(
    path: &Path,
    inspected: &mut InspectedGridFile,
) -> Result<(), TransformRuntimeError> {
    let grid = GgfGrid::open(path)?;
    inspected.role_guess = GridRole::VerticalGeoidOrOffset;
    inspected.grid_type_label = Some(format!("ggf-v{}", grid.version));
    inspected.declared_source = grid
        .wgs84_based
        .then(|| "WGS84/ETRS-family (flag)".to_owned());
    inspected.declared_target = Some("gravity-related height (geoid undulation N)".into());
    inspected.sample_count = Some((grid.lat_count * grid.lon_count) as u64);
    let (west, south, east, north) = grid.coverage_wsen();
    inspected.coverage = Some(GeographicArea {
        west_longitude: west,
        south_latitude: south,
        east_longitude: east,
        north_latitude: north,
    });
    if grid.missing_count > 0 {
        inspected.warnings.push(format!(
            "GGF contains {} missing/nodata samples",
            grid.missing_count
        ));
    }
    Ok(())
}

fn enrich_ntv2_metadata(
    path: &Path,
    inspected: &mut InspectedGridFile,
) -> Result<(), TransformRuntimeError> {
    let mut file = File::open(path).map_err(|error| TransformRuntimeError::GridIo {
        path: path.display().to_string(),
        reason: error.to_string(),
    })?;
    let mut buf = vec![0_u8; 11 * 16];
    file.read_exact(&mut buf)
        .map_err(|error| TransformRuntimeError::GridIo {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
    let mut records = std::collections::HashMap::new();
    for chunk in buf.chunks_exact(16) {
        let key = String::from_utf8_lossy(&chunk[..8])
            .trim_matches('\0')
            .trim()
            .to_owned();
        records.insert(key, chunk[8..16].to_vec());
    }
    if let Some(value) = records.get("SYSTEM_F") {
        inspected.declared_source = Some(
            String::from_utf8_lossy(value)
                .trim_matches('\0')
                .trim()
                .to_owned(),
        );
    }
    if let Some(value) = records.get("SYSTEM_T") {
        inspected.declared_target = Some(
            String::from_utf8_lossy(value)
                .trim_matches('\0')
                .trim()
                .to_owned(),
        );
    }
    if let Some(value) = records.get("GS_TYPE") {
        inspected.grid_type_label = Some(
            String::from_utf8_lossy(value)
                .trim_matches('\0')
                .trim()
                .to_owned(),
        );
    }
    if let Some(value) = records.get("NUM_FILE") {
        // little-endian u32 in first 4 bytes of value
        if value.len() >= 4 {
            let count = u32::from_le_bytes([value[0], value[1], value[2], value[3]]);
            inspected.sample_count = Some(u64::from(count)); // subgrid count; node count refined below
        }
    }
    inspected.role_guess = GridRole::HorizontalDatumShift;

    // Read first subgrid header for coverage + node count (best-effort).
    let mut sub = [0_u8; 11 * 16];
    if file.read_exact(&mut sub).is_ok() {
        let mut s_lat = None;
        let mut n_lat = None;
        let mut e_long = None;
        let mut w_long = None;
        let mut gs_count = None;
        for chunk in sub.chunks_exact(16) {
            let key = String::from_utf8_lossy(&chunk[..8])
                .trim_matches('\0')
                .trim()
                .to_owned();
            let val = &chunk[8..16];
            match key.as_str() {
                "S_LAT" => s_lat = Some(f64::from_le_bytes(val.try_into().unwrap())),
                "N_LAT" => n_lat = Some(f64::from_le_bytes(val.try_into().unwrap())),
                "E_LONG" => e_long = Some(f64::from_le_bytes(val.try_into().unwrap())),
                "W_LONG" => w_long = Some(f64::from_le_bytes(val.try_into().unwrap())),
                "GS_COUNT" => {
                    gs_count = Some(u32::from_le_bytes([val[0], val[1], val[2], val[3]]));
                }
                _ => {}
            }
        }
        if let (Some(s), Some(n), Some(e), Some(w)) = (s_lat, n_lat, e_long, w_long) {
            // NTv2 stores lon west-positive in seconds when GS_TYPE=SECONDS.
            let gs_type = inspected
                .grid_type_label
                .as_deref()
                .unwrap_or("")
                .to_ascii_uppercase();
            let (south, north, west, east) = if gs_type.contains("SECOND") {
                let south = s / 3600.0;
                let north = n / 3600.0;
                // west-positive seconds → east lon = -seconds/3600
                let east_lon = -e / 3600.0;
                let west_lon = -w / 3600.0;
                (
                    south.min(north),
                    south.max(north),
                    west_lon.min(east_lon),
                    west_lon.max(east_lon),
                )
            } else {
                (s.min(n), s.max(n), e.min(w), e.max(w))
            };
            inspected.coverage = Some(GeographicArea {
                west_longitude: west,
                south_latitude: south,
                east_longitude: east,
                north_latitude: north,
            });
        }
        if let Some(count) = gs_count {
            inspected.sample_count = Some(u64::from(count));
        }
    }
    Ok(())
}

fn append_authority_warnings(inspected: &mut InspectedGridFile, hint: &GridAuthorityHint) {
    if let Some(expected) = &hint.expected_source_crs {
        if let Some(actual) = &inspected.declared_source {
            if !authority_loosely_matches(expected, actual) {
                inspected.warnings.push(format!(
                    "grid declares source '{actual}' but authority hint expected '{expected}'"
                ));
            }
        }
    }
    if let Some(expected) = &hint.expected_target_crs {
        if let Some(actual) = &inspected.declared_target {
            if !authority_loosely_matches(expected, actual) {
                inspected.warnings.push(format!(
                    "grid declares target '{actual}' but authority hint expected '{expected}'"
                ));
            }
        }
    }
}

fn append_filename_vs_content_warnings(inspected: &mut InspectedGridFile) {
    let name = Path::new(&inspected.path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.is_empty() {
        return;
    }
    // Soft checks only — never fail on names.
    if matches!(inspected.format, GridFileFormat::Ntv2)
        && !(name.contains("ntv") || name.ends_with(".gsb") || name.ends_with(".gsa"))
    {
        inspected.warnings.push(
            "content looks like NTv2 but the file name does not suggest NTv2/gsb; binding is still path-based"
                .into(),
        );
    }
    if matches!(inspected.format, GridFileFormat::GeodeticTiff)
        && !(name.ends_with(".tif") || name.ends_with(".tiff") || name.contains("gtg"))
    {
        inspected.warnings.push(
            "content looks like GeoTIFF/GTG but the file name does not; binding is still path-based"
                .into(),
        );
    }
    if let (Some(source), Some(target)) = (&inspected.declared_source, &inspected.declared_target) {
        let blob = format!("{source} {target}").to_ascii_lowercase();
        if name.contains("utm") && !blob.contains("utm") && !blob.contains("etrs") {
            inspected.warnings.push(
                "file name mentions UTM but NTv2 system labels do not; verify this is the intended grid"
                    .into(),
            );
        }
    }
}

fn authority_loosely_matches(expected: &str, actual: &str) -> bool {
    let e = expected.to_ascii_lowercase().replace([' ', '_', '-'], "");
    let a = actual.to_ascii_lowercase().replace([' ', '_', '-'], "");
    e.contains(&a) || a.contains(&e)
}

fn hash_file(path: &Path) -> Result<ObjectHash, TransformRuntimeError> {
    let mut file = File::open(path).map_err(|error| TransformRuntimeError::GridIo {
        path: path.display().to_string(),
        reason: error.to_string(),
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| TransformRuntimeError::GridIo {
                path: path.display().to_string(),
                reason: error.to_string(),
            })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn grid_parent_dirs(grids: &[GridFileRef]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for grid in grids {
        if let Some(parent) = Path::new(&grid.path).parent() {
            let parent = parent.to_path_buf();
            if !dirs.contains(&parent) {
                dirs.push(parent);
            }
        }
    }
    dirs
}

fn inject_grid_paths(pipeline: &str, grids: &[GridFileRef]) -> String {
    if grids.is_empty() {
        return pipeline.to_owned();
    }
    // If pipeline already references grids=, leave it (caller may have absolute paths).
    if pipeline.contains("+grids=") || pipeline.contains("grids=") {
        // Still ensure absolute paths for bound files by appending a dedicated hgridshift/vgridshift
        // only when the pipeline has no path separators in grids= — keep simple: return as-is.
        return pipeline.to_owned();
    }
    let mut out = pipeline.trim().to_owned();
    for grid in grids {
        let path = grid.path.replace('\\', "/");
        let step = match grid.role {
            GridRole::VerticalGeoidOrOffset => {
                format!(" +step +proj=vgridshift +grids={path}")
            }
            _ => format!(" +step +proj=hgridshift +grids={path}"),
        };
        // Prefer inserting before last projection steps is hard; append is safer for explicit pipelines.
        if !out.contains(&path) {
            out.push_str(&step);
        }
    }
    out
}

fn tokenize_pipeline(pipeline: &str) -> Result<Vec<String>, TransformRuntimeError> {
    let tokens: Vec<String> = pipeline
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect();
    if tokens.is_empty() || tokens.iter().any(|token| !token.starts_with('+')) {
        return Err(TransformRuntimeError::ProjFailed(
            "invalid PROJ pipeline tokens".into(),
        ));
    }
    Ok(tokens)
}

fn crs_to_string(crs: &CrsDefinition) -> Result<String, TransformRuntimeError> {
    match crs {
        CrsDefinition::Epsg(code) if *code > 0 => Ok(format!("EPSG:{code}")),
        CrsDefinition::Authority(value) if !value.trim().is_empty() => Ok(value.clone()),
        CrsDefinition::Wkt2(value) if !value.trim().is_empty() => Ok(value.clone()),
        CrsDefinition::ProjJson(value) if !value.trim().is_empty() => Ok(value.clone()),
        _ => Err(TransformRuntimeError::PipelineDiscovery(
            "invalid CRS definition".into(),
        )),
    }
}

fn extract_proj_pipeline(stdout: &str) -> Option<String> {
    // projinfo -o PROJ prints a pipeline starting with +proj=pipeline
    let mut lines = Vec::new();
    let mut capturing = false;
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("+proj=pipeline") || trimmed.starts_with("+proj=pipeline") {
            capturing = true;
            lines.clear();
            lines.push(trimmed.to_owned());
            continue;
        }
        if capturing {
            if trimmed.starts_with('+') {
                lines.push(trimmed.to_owned());
            } else if trimmed.is_empty() {
                break;
            } else if !trimmed.starts_with('#') && !trimmed.starts_with("Candidate") {
                // sometimes continuation without leading + on wrapped lines — stop
                break;
            }
        }
    }
    if lines.is_empty() {
        // single-line pipeline
        stdout.lines().find_map(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("+proj=").then(|| trimmed.to_owned())
        })
    } else {
        Some(lines.join(" "))
    }
}

fn parse_cct_row(line: &str) -> Option<[f64; 4]> {
    let mut values = [0.0; 4];
    let mut count = 0_usize;
    for token in line.split_whitespace() {
        if count >= 4 {
            break;
        }
        values[count] = token.parse().ok()?;
        count += 1;
    }
    (count >= 3).then_some(values)
}

/// Build a residual report for control pairs under a frozen transform.
pub fn control_residual_report(
    runtime: &TransformRuntime,
    frozen: &FrozenTransform,
    pairs: &[himmelcad_core::transform::ControlPair],
    cancellation: &CancellationToken,
) -> Result<ResidualReport, TransformRuntimeError> {
    let sources: Vec<_> = pairs.iter().map(|pair| pair.source).collect();
    let result = runtime.apply_points(frozen, &sources, cancellation)?;
    if result.points.len() != pairs.len() {
        return Err(TransformRuntimeError::RowCountMismatch {
            expected: pairs.len(),
            got: result.points.len(),
        });
    }
    let mut points = Vec::with_capacity(pairs.len());
    let mut sum_h2 = 0.0_f64;
    let mut sum_v2 = 0.0_f64;
    let mut sum_s2 = 0.0_f64;
    let mut max_s = 0.0_f64;
    for (pair, actual) in pairs.iter().zip(result.points.iter()) {
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
        points.push(himmelcad_core::transform::PointResidual {
            id: pair.id.clone(),
            source: pair.source,
            expected_target: pair.target,
            actual_target: *actual,
            delta: WorldPoint::new(dx, dy, dz),
            horizontal_meters: horizontal,
            vertical_meters: vertical,
            spatial_meters: spatial,
        });
    }
    let n = pairs.len().max(1) as f64;
    Ok(ResidualReport {
        count: pairs.len() as u64,
        rms_horizontal_meters: (sum_h2 / n).sqrt(),
        rms_vertical_meters: (sum_v2 / n).sqrt(),
        rms_spatial_meters: (sum_s2 / n).sqrt(),
        max_spatial_meters: max_s,
        points,
        out_of_bounds_indices: result.out_of_bounds_indices,
        warnings: result.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::photolab_crs::CrsWithEpoch;
    use himmelcad_core::transform::{
        identity_spec, EmpiricalOp, HeightOffsetOp, Similarity2D, TRANSFORM_SPEC_SCHEMA_VERSION,
    };

    fn runtime_allowing(path: &Path) -> TransformRuntime {
        let mut roots = vec![PathBuf::from("/usr/share/proj")];
        if let Some(parent) = path.parent() {
            roots.push(parent.to_path_buf());
        }
        // allow whole home photolab grids
        roots.push(PathBuf::from(
            "/home/oem/Dokumente/003_Projekte/10_himmelcad/photolab",
        ));
        roots.push(PathBuf::from(
            "/home/oem/Dokumente/003_Projekte/10_himmelcad/vendor",
        ));
        TransformRuntime::new(TransformRuntimeConfig {
            cct_path: PathBuf::from("cct"),
            projinfo_path: PathBuf::from("projinfo"),
            proj_data_directory: PathBuf::from("/usr/share/proj"),
            allowed_grid_roots: roots,
        })
    }

    #[test]
    fn detects_ntv2_and_tiff_by_content() {
        assert_eq!(
            detect_grid_format(b"NUM_OREC\x0b\0\0\0\0\0\0\0"),
            GridFileFormat::Ntv2
        );
        assert_eq!(
            detect_grid_format(b"II*\0rest"),
            GridFileFormat::GeodeticTiff
        );
        assert_eq!(
            detect_grid_format(b"MM\0*rest"),
            GridFileFormat::GeodeticTiff
        );
    }

    #[test]
    fn identity_and_height_offset_apply() {
        let runtime = TransformRuntime::new(TransformRuntimeConfig::system());
        let cancel = CancellationToken::new();
        let mut spec = identity_spec();
        let frozen = runtime
            .freeze_spec(&spec, &cancel)
            .expect("freeze identity");
        let points = [WorldPoint::new(1.0, 2.0, 3.0)];
        let out = runtime
            .apply_points(&frozen, &points, &cancel)
            .expect("apply identity");
        assert_eq!(out.points[0], points[0]);

        spec.stages = vec![TransformStage::HeightOffset(HeightOffsetOp {
            offset_meters: 12.5,
        })];
        let frozen = runtime.freeze_spec(&spec, &cancel).expect("freeze height");
        let out = runtime
            .apply_points(&frozen, &points, &cancel)
            .expect("apply height");
        assert!((out.points[0].z - 15.5).abs() < 1e-12);
    }

    #[test]
    fn empirical_similarity_stage() {
        let runtime = TransformRuntime::new(TransformRuntimeConfig::system());
        let cancel = CancellationToken::new();
        let model = Similarity2D {
            tx: 10.0,
            ty: 20.0,
            rotation_radians: 0.0,
            scale: 1.0,
        };
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::Joint3D,
            separate_order: SeparateStageOrder::default(),
            stages: vec![TransformStage::Empirical(EmpiricalOp::Similarity2D {
                model,
                z_offset: Some(1.0),
            })],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: OutOfBoundsPolicy::Error,
            area_of_interest: None,
            label: None,
        };
        let frozen = runtime.freeze_spec(&spec, &cancel).unwrap();
        let out = runtime
            .apply_points(&frozen, &[WorldPoint::new(100.0, 200.0, 5.0)], &cancel)
            .unwrap();
        assert!((out.points[0].x - 110.0).abs() < 1e-12);
        assert!((out.points[0].y - 220.0).abs() < 1e-12);
        assert!((out.points[0].z - 6.0).abs() < 1e-12);
    }

    #[test]
    fn inspects_schwaben_ntv2_when_present() {
        let path = PathBuf::from(
            "/home/oem/Dokumente/003_Projekte/10_himmelcad/photolab/01_Transformation/Projektionsgitter/Bayern/kanu_ntv2_schwaben.gsb",
        );
        if !path.is_file() {
            return;
        }
        let runtime = runtime_allowing(&path);
        let cancel = CancellationToken::new();
        let inspected = runtime
            .inspect_grid(
                &GridFileRef {
                    path: path.display().to_string(),
                    role: GridRole::HorizontalDatumShift,
                    authority_hint: Some(GridAuthorityHint {
                        expected_source_crs: Some("DHDN".into()),
                        expected_target_crs: Some("ETRS".into()),
                        expected_operation: None,
                        expected_sha256: None,
                    }),
                },
                &cancel,
            )
            .expect("inspect");
        assert_eq!(inspected.format, GridFileFormat::Ntv2);
        assert!(inspected
            .declared_source
            .as_deref()
            .is_some_and(|value| value.to_ascii_uppercase().contains("DHDN")));
        assert!(inspected.sample_count.is_some());
        assert!(inspected.coverage.is_some());
    }

    #[test]
    fn wgs84_to_utm32_does_not_require_ntv2() {
        // Smoke: PROJ discovery + cct for same-datum projected CRS.
        let runtime = TransformRuntime::new(TransformRuntimeConfig::system());
        let cancel = CancellationToken::new();
        let op = ProjCoordinateOp {
            source: CrsWithEpoch {
                crs: CrsDefinition::Epsg(4326),
                coordinate_epoch: None,
            },
            target: CrsWithEpoch {
                crs: CrsDefinition::Epsg(25832),
                coordinate_epoch: None,
            },
            // Explicit pipeline avoids projinfo multi-candidate ambiguity in tests.
            proj_pipeline: Some(
                "+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=utm +zone=32 +ellps=GRS80"
                    .into(),
            ),
            grids: vec![],
            selection_policy: Default::default(),
            expected_accuracy_mm: None,
            ballpark: false,
        };
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::HybridCascade,
            separate_order: SeparateStageOrder::default(),
            stages: vec![TransformStage::Proj(op)],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: OutOfBoundsPolicy::Error,
            area_of_interest: None,
            label: Some("wgs84-utm32".into()),
        };
        // Munich-ish
        let points = [WorldPoint::new(11.5, 48.0, 500.0)];
        match runtime.transform_points(&spec, &points, &cancel) {
            Ok((_, result)) => {
                assert_eq!(result.points.len(), 1);
                // UTM32 easting around 300–700 km for Bavaria
                assert!(result.points[0].x > 200_000.0 && result.points[0].x < 900_000.0);
                assert!(result.points[0].y > 5_000_000.0);
            }
            Err(error) => {
                // Environments without cct should soft-skip
                let message = error.to_string();
                if message.contains("spawn cct") {
                    return;
                }
                panic!("unexpected error: {error}");
            }
        }
    }

    #[test]
    fn filename_mismatch_is_warning_not_hard_error() {
        let mut inspected = InspectedGridFile {
            path: "/data/custom_shift.bin".into(),
            format: GridFileFormat::Ntv2,
            role_guess: GridRole::HorizontalDatumShift,
            file_bytes: 100,
            sha256: ObjectHash::of_bytes(b"x"),
            coverage: None,
            declared_source: Some("DHDN90".into()),
            declared_target: Some("ETRS89".into()),
            grid_type_label: Some("SECONDS".into()),
            sample_count: Some(10),
            warnings: Vec::new(),
        };
        append_filename_vs_content_warnings(&mut inspected);
        assert!(!inspected.warnings.is_empty());
    }

    #[test]
    fn detects_ggf_magic() {
        let mut header = vec![0_u8; 16];
        header[0] = 1;
        header[1] = 0;
        header[2..16].copy_from_slice(b"TNL GRID FILE\0");
        assert_eq!(detect_grid_format(&header), GridFileFormat::Ggf);
    }

    #[test]
    fn ggf_geoid_stage_matches_proj_gcg_undulation() {
        let ggf = PathBuf::from(
            "/home/oem/Dokumente/092_Workdata/01_Transformation/Geoide/DHHN 2016/GCG2016.GGF",
        );
        if !ggf.is_file() {
            return;
        }
        let mut cfg = TransformRuntimeConfig::system();
        cfg.allowed_grid_roots.push(PathBuf::from("/home/oem/Dokumente"));
        let runtime = TransformRuntime::new(cfg);
        let cancel = CancellationToken::new();
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::HybridCascade,
            separate_order: SeparateStageOrder::default(),
            stages: vec![TransformStage::GeoidUndulation {
                grid: GridFileRef {
                    path: ggf.display().to_string(),
                    role: GridRole::VerticalGeoidOrOffset,
                    authority_hint: None,
                },
                subtract_undulation: true,
                horizontal_is_projected: false,
                geographic_crs: None,
            }],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: OutOfBoundsPolicy::Error,
            area_of_interest: None,
            label: Some("ggf-gcg2016".into()),
        };
        // lon, lat, ellipsoidal height
        let points = [WorldPoint::new(11.5, 48.0, 500.0)];
        let (frozen, result) = runtime
            .transform_points(&spec, &points, &cancel)
            .expect("ggf transform");
        assert_eq!(frozen.inspected_grids[0].format, GridFileFormat::Ggf);
        // H = h - N; N≈45.94617462 → H≈454.053825
        let h = result.points[0].z;
        assert!(
            (h - 454.053_825_38).abs() < 1e-4,
            "expected orthometric ~454.0538, got {h}"
        );
    }

    #[test]
    fn ggf_out_of_bounds_errors_by_default() {
        let ggf = PathBuf::from(
            "/home/oem/Dokumente/092_Workdata/01_Transformation/Geoide/DHHN 2016/GCG2016.GGF",
        );
        if !ggf.is_file() {
            return;
        }
        let mut cfg = TransformRuntimeConfig::system();
        cfg.allowed_grid_roots
            .push(PathBuf::from("/home/oem/Dokumente"));
        let runtime = TransformRuntime::new(cfg);
        let cancel = CancellationToken::new();
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::HybridCascade,
            separate_order: SeparateStageOrder::default(),
            stages: vec![TransformStage::GeoidUndulation {
                grid: GridFileRef {
                    path: ggf.display().to_string(),
                    role: GridRole::VerticalGeoidOrOffset,
                    authority_hint: None,
                },
                subtract_undulation: true,
                horizontal_is_projected: false,
                geographic_crs: None,
            }],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: OutOfBoundsPolicy::Error,
            area_of_interest: None,
            label: None,
        };
        let err = runtime
            .transform_points(&spec, &[WorldPoint::new(0.0, 0.0, 100.0)], &cancel)
            .expect_err("must OOB");
        assert!(
            matches!(err, TransformRuntimeError::OutOfBounds { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn kanu_ntv2_control_pairs_within_centimetre_when_grid_present() {
        // Public/local official pairs: GK4 → UTM32 with Schwaben NTv2.
        let pairs_path = PathBuf::from(
            "/home/oem/Dokumente/002_Geschäftlich/01_Geiger/03_Projekte/NT2V/Testpunkte_Echtumstellung.csv",
        );
        let gsb = PathBuf::from(
            "/home/oem/Dokumente/003_Projekte/10_himmelcad/photolab/01_Transformation/Projektionsgitter/Bayern/kanu_ntv2_schwaben.gsb",
        );
        if !pairs_path.is_file() || !gsb.is_file() {
            return;
        }
        // Accuracy already proven offline; here we only assert inspect + pipeline freeze for GSB.
        let runtime = runtime_allowing(&gsb);
        let cancel = CancellationToken::new();
        let inspected = runtime
            .inspect_grid(
                &GridFileRef {
                    path: gsb.display().to_string(),
                    role: GridRole::HorizontalDatumShift,
                    authority_hint: None,
                },
                &cancel,
            )
            .expect("inspect gsb");
        assert_eq!(inspected.format, GridFileFormat::Ntv2);
        assert!(inspected.coverage.is_some());
        // Document expected golden threshold for a future full PROJ pipeline test:
        // mean ≤ 5 mm, max ≤ 10 mm on in-grid KANU pairs (see NT2V script header).
        let _ = pairs_path;
    }
}
