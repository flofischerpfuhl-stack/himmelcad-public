//! Offline PROJ process isolation, operation discovery and streamed coordinate transformation.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_crs::{
    CoordinateOperationKind, CrsDatabaseVersions, CrsDefinition, CrsWithEpoch,
    FrozenImportTransformation, FrozenOperationPipeline, GeographicArea, GridLicenseMetadata,
    OperationCandidate, OperationSelectionPolicy, RequiredGridAvailability,
    RequiredTransformationGrid, TransformationGridKind,
};
use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::process_group::{self, ProcessGroupDropGuard};

const DEFAULT_CAPTURE_LIMIT: usize = 32 * 1024 * 1024;
const MAX_CRS_ARGUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PIPELINE_BYTES: usize = 1024 * 1024;
const MAX_DATABASE_BYTES: u64 = 256 * 1024 * 1024;

/// Trusted local PROJ installation. Release packages point this at their bundled toolchain.
#[derive(Debug, Clone)]
pub struct ProjToolchainConfig {
    pub projinfo_path: PathBuf,
    pub cct_path: PathBuf,
    pub data_directory: PathBuf,
    pub database_path: PathBuf,
    pub allowed_grid_roots: Vec<PathBuf>,
    pub capture_limit_bytes: usize,
}

impl ProjToolchainConfig {
    /// Creates the explicit system-tool configuration used by development builds.
    #[must_use]
    pub fn system(
        projinfo_path: impl Into<PathBuf>,
        cct_path: impl Into<PathBuf>,
        data_directory: impl Into<PathBuf>,
    ) -> Self {
        let data_directory = data_directory.into();
        Self {
            projinfo_path: projinfo_path.into(),
            cct_path: cct_path.into(),
            database_path: data_directory.join("proj.db"),
            allowed_grid_roots: vec![data_directory.clone()],
            data_directory,
            capture_limit_bytes: DEFAULT_CAPTURE_LIMIT,
        }
    }
}

/// A known grid entry supplied by HimmelCAD's audited catalog or explicit user registration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridCatalogEntry {
    pub kind: TransformationGridKind,
    pub official_filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub official_sha256: Option<ObjectHash>,
    pub license: GridLicenseMetadata,
    pub coverage: GeographicArea,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

/// Inputs for deterministic, offline operation discovery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationQuery {
    pub source: CrsWithEpoch,
    pub target: CrsWithEpoch,
    pub area_of_interest: GeographicArea,
    #[serde(default)]
    pub selection_policy: OperationSelectionPolicy,
    #[serde(default)]
    pub grid_catalog: Vec<GridCatalogEntry>,
}

/// Immutable evidence identifying the exact local transformation engine and database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjAudit {
    pub versions: CrsDatabaseVersions,
    pub epsg_database_date: Option<String>,
    pub database_path: String,
    pub database_sha256: ObjectHash,
    pub projinfo_path: String,
    pub cct_path: String,
    pub network_enabled: bool,
}

/// Candidate response. The user must still choose and freeze one candidate explicitly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationDiscovery {
    pub candidates: Vec<OperationCandidate>,
    pub audit: ProjAudit,
    pub warnings: Vec<String>,
}

/// Byte-oriented result for a transformation streamed through a single `cct` process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformStreamSummary {
    pub input_bytes: u64,
    pub output_bytes: u64,
}

#[derive(Debug, Error)]
pub enum CrsRuntimeError {
    #[error("invalid PROJ toolchain path '{path}': {reason}")]
    InvalidToolchainPath { path: String, reason: String },
    #[error("invalid CRS operation request: {0}")]
    InvalidRequest(&'static str),
    #[error("PROJ process could not be started: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("PROJ process I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("PROJ process failed with status {status}: {stderr}")]
    ProcessFailed { status: String, stderr: String },
    #[error("PROJ output exceeded the configured {limit}-byte capture limit")]
    OutputLimit { limit: usize },
    #[error("PROJ operation output is malformed: {0}")]
    MalformedOutput(String),
    #[error("PROJ operation was cancelled")]
    Cancelled,
    #[error("grid '{filename}' is not registered in the audited grid catalog")]
    UnknownGrid { filename: String },
    #[error("grid path for '{filename}' is outside the configured grid roots")]
    GridOutsideAllowedRoots { filename: String },
    #[error("grid '{filename}' failed SHA-256 verification")]
    GridHashMismatch { filename: String },
    #[error("grid '{filename}' is incompatible with the selected operation: {reason}")]
    IncompatibleGrid { filename: String, reason: String },
    #[error("frozen PROJ database version does not match this runtime")]
    DatabaseVersionMismatch,
    #[error("selected operation is not present in a fresh offline PROJ discovery")]
    OperationNotDiscovered,
    #[error("PROJ background task failed: {0}")]
    BackgroundTask(String),
}

/// Canonicalized, network-disabled PROJ CLI runtime.
#[derive(Debug, Clone)]
pub struct ProjRuntime {
    config: CanonicalToolchain,
    audit_cache: std::sync::Arc<OnceCell<ProjAudit>>,
    grid_hash_cache: GridHashCache,
}

type GridHashCache =
    std::sync::Arc<std::sync::Mutex<HashMap<PathBuf, (u64, std::time::SystemTime, ObjectHash)>>>;

#[derive(Debug, Clone)]
struct CanonicalToolchain {
    projinfo_path: PathBuf,
    cct_path: PathBuf,
    data_directory: PathBuf,
    database_path: PathBuf,
    allowed_grid_roots: Vec<PathBuf>,
    capture_limit_bytes: usize,
}

impl ProjRuntime {
    /// Canonicalizes every executable and data root before it can reach a child process.
    pub fn open(config: ProjToolchainConfig) -> Result<Self, CrsRuntimeError> {
        let projinfo_path = canonical_file(&config.projinfo_path)?;
        let cct_path = canonical_file(&config.cct_path)?;
        let data_directory = canonical_directory(&config.data_directory)?;
        let database_path = canonical_file(&config.database_path)?;
        if !database_path.starts_with(&data_directory) {
            return Err(CrsRuntimeError::InvalidToolchainPath {
                path: database_path.display().to_string(),
                reason: "database must be inside the configured PROJ data directory".into(),
            });
        }
        let mut allowed_grid_roots = Vec::with_capacity(config.allowed_grid_roots.len() + 1);
        allowed_grid_roots.push(data_directory.clone());
        for root in config.allowed_grid_roots {
            let root = canonical_directory(&root)?;
            if !allowed_grid_roots.contains(&root) {
                allowed_grid_roots.push(root);
            }
        }
        Ok(Self {
            config: CanonicalToolchain {
                projinfo_path,
                cct_path,
                data_directory,
                database_path,
                allowed_grid_roots,
                capture_limit_bytes: config.capture_limit_bytes.max(1024),
            },
            audit_cache: std::sync::Arc::new(OnceCell::new()),
            grid_hash_cache: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        })
    }

    /// Records executable version plus EPSG database version, date, path and content hash.
    pub async fn audit(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<ProjAudit, CrsRuntimeError> {
        self.audit_cache
            .get_or_try_init(|| async {
                let captured = self
                    .run_capture(
                        &self.config.cct_path,
                        [OsString::from("--version")],
                        cancellation,
                    )
                    .await?;
                let version_text = if captured.stdout.trim().is_empty() {
                    captured.stderr.trim()
                } else {
                    captured.stdout.trim()
                };
                let proj_version = parse_proj_version(version_text).ok_or_else(|| {
                    CrsRuntimeError::MalformedOutput("cct did not report a PROJ version".into())
                })?;
                let (metadata, database_sha256) =
                    database_evidence(self.config.database_path.clone(), cancellation.clone())
                        .await?;
                Ok(ProjAudit {
                    versions: CrsDatabaseVersions {
                        proj_version,
                        epsg_database_version: metadata.version,
                    },
                    epsg_database_date: metadata.date,
                    database_path: path_text(&self.config.database_path),
                    database_sha256,
                    projinfo_path: path_text(&self.config.projinfo_path),
                    cct_path: path_text(&self.config.cct_path),
                    network_enabled: false,
                })
            })
            .await
            .cloned()
    }

    /// Resolves one frozen CRS definition through the configured offline database as WKT2:2019.
    pub async fn canonical_wkt(
        &self,
        definition: &CrsDefinition,
        cancellation: &CancellationToken,
    ) -> Result<String, CrsRuntimeError> {
        let captured = self
            .run_capture(
                &self.config.projinfo_path,
                [
                    crs_argument(definition)?,
                    OsString::from("-o"),
                    OsString::from("WKT2:2019"),
                    OsString::from("--single-line"),
                ],
                cancellation,
            )
            .await?;
        let wkt = captured
            .stdout
            .lines()
            .map(str::trim)
            .find(|line| {
                line.starts_with("PROJCRS[")
                    || line.starts_with("GEOGCRS[")
                    || line.starts_with("COMPOUNDCRS[")
                    || line.starts_with("BOUNDCRS[")
                    || line.starts_with("VERTCRS[")
                    || line.starts_with("ENGCRS[")
            })
            .ok_or_else(|| {
                CrsRuntimeError::MalformedOutput(
                    "projinfo did not return a WKT2:2019 CRS definition".into(),
                )
            })?;
        Ok(wkt.to_owned())
    }

    /// Discovers every locally known candidate while retaining missing-grid candidates for UI.
    pub async fn discover_operations(
        &self,
        query: &OperationQuery,
        cancellation: &CancellationToken,
    ) -> Result<OperationDiscovery, CrsRuntimeError> {
        if !query.area_of_interest.is_valid() {
            return Err(CrsRuntimeError::InvalidRequest("areaOfInterest"));
        }
        let source = crs_argument(&query.source.crs)?;
        let target = crs_argument(&query.target.crs)?;
        let bbox = format!(
            "{},{},{},{}",
            query.area_of_interest.west_longitude,
            query.area_of_interest.south_latitude,
            query.area_of_interest.east_longitude,
            query.area_of_interest.north_latitude
        );
        let mut args = vec![
            OsString::from("-s"),
            source,
            OsString::from("-t"),
            target,
            OsString::from("--bbox"),
            OsString::from(bbox),
            OsString::from("--spatial-test"),
            OsString::from("contains"),
            OsString::from("--grid-check"),
            OsString::from("none"),
            OsString::from("-o"),
            OsString::from("PROJ,PROJJSON"),
            OsString::from("--single-line"),
        ];
        if let Some(epoch) = query.source.coordinate_epoch {
            if !epoch.decimal_year.is_finite() {
                return Err(CrsRuntimeError::InvalidRequest("sourceEpoch"));
            }
            args.push(OsString::from("--s_epoch"));
            args.push(OsString::from(epoch.decimal_year.to_string()));
        }
        if let Some(epoch) = query.target.coordinate_epoch {
            if !epoch.decimal_year.is_finite() {
                return Err(CrsRuntimeError::InvalidRequest("targetEpoch"));
            }
            args.push(OsString::from("--t_epoch"));
            args.push(OsString::from(epoch.decimal_year.to_string()));
        }
        if !query.selection_policy.allow_ballpark {
            args.push(OsString::from("--hide-ballpark"));
        }
        let captured = self
            .run_capture(&self.config.projinfo_path, args, cancellation)
            .await?;
        let (mut candidates, mut warnings) = self
            .parse_candidates(&captured.stdout, query, cancellation)
            .await?;
        if let Some(explicit) = self
            .explicit_vertical_grid_candidate(query, cancellation)
            .await?
        {
            for candidate in &mut candidates {
                candidate.best_available = false;
            }
            warnings.push(
                "The selected geoid is used in an explicit, hash-frozen projected-height pipeline. Published accuracy is not inferred from the filename."
                    .to_owned(),
            );
            candidates.insert(0, explicit);
        }
        if let Some(explicit) = self
            .explicit_dhdn_grid_candidate(query, cancellation)
            .await?
        {
            for candidate in &mut candidates {
                candidate.best_available = false;
            }
            warnings.push(
                "The selected local grids are used in an explicit, hash-frozen DHDN pipeline. Published accuracy is not inferred from the filename."
                    .to_owned(),
            );
            candidates.insert(0, explicit);
        }
        let audit = self.audit(cancellation).await?;
        Ok(OperationDiscovery {
            candidates,
            audit,
            warnings,
        })
    }

    /// Revalidates engine/database/grid evidence before executing a frozen pipeline.
    pub async fn validate_frozen(
        &self,
        frozen: &FrozenImportTransformation,
        cancellation: &CancellationToken,
    ) -> Result<ProjAudit, CrsRuntimeError> {
        validate_pipeline_tokens(&frozen.pipeline.proj_pipeline)?;
        let audit = self.audit(cancellation).await?;
        if audit.versions != frozen.database_versions {
            return Err(CrsRuntimeError::DatabaseVersionMismatch);
        }
        for grid in &frozen.pipeline.grids {
            let path = canonical_file(Path::new(&grid.local_path))?;
            if !self.is_allowed_grid(&path) {
                return Err(CrsRuntimeError::GridOutsideAllowedRoots {
                    filename: grid.official_filename.clone(),
                });
            }
        }
        let grid_catalog = frozen
            .pipeline
            .grids
            .iter()
            .map(|grid| GridCatalogEntry {
                kind: grid.kind,
                official_filename: grid.official_filename.clone(),
                official_sha256: grid.official_sha256.clone(),
                license: grid.license.clone(),
                coverage: frozen.area_of_interest,
                local_path: Some(grid.local_path.clone()),
            })
            .collect();
        let discovery = self
            .discover_operations(
                &OperationQuery {
                    source: frozen.original.horizontal.clone(),
                    target: frozen.target.horizontal.clone(),
                    area_of_interest: frozen.area_of_interest,
                    selection_policy: frozen.pipeline.selection_policy,
                    grid_catalog,
                },
                cancellation,
            )
            .await?;
        // Exact id/name/pipeline match, or a rediscovered non-ballpark candidate that
        // realizes the same pipeline after user-local grid rebinding (filename/path swap).
        // User grids change officialFilename and often the operation_id hash — that is
        // expected and must not block freeze for every custom NTv2/GTG/geoid file.
        let selected = discovery
            .candidates
            .iter()
            .any(|candidate| operation_matches_frozen_selection(candidate, &frozen.pipeline));
        if !selected {
            return Err(CrsRuntimeError::OperationNotDiscovered);
        }
        Ok(audit)
    }

    /// Streams normalized coordinate text through one `cct` child without temporary files.
    ///
    /// Input is expected to contain whitespace-separated `x y z t` rows. `cct` diagnostics are
    /// never mixed into the output stream.
    pub async fn transform_stream<R, W>(
        &self,
        frozen: &FrozenImportTransformation,
        mut input: R,
        mut output: W,
        cancellation: &CancellationToken,
    ) -> Result<TransformStreamSummary, CrsRuntimeError>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        self.validate_frozen(frozen, cancellation).await?;
        let pipeline_args = validate_pipeline_tokens(&frozen.pipeline.proj_pipeline)?;
        let mut args = vec![
            OsString::from("--columns"),
            OsString::from("1,2,3,4"),
            OsString::from("--decimals"),
            OsString::from("15"),
        ];
        args.extend(pipeline_args.into_iter().map(OsString::from));
        let mut command = self.command(&self.config.cct_path, args);
        command.env("PROJ_DATA", self.frozen_proj_search_path(frozen));
        let mut child = command.spawn().map_err(CrsRuntimeError::Spawn)?;
        let _group_guard = ProcessGroupDropGuard::new(child.id());
        let child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| CrsRuntimeError::MalformedOutput("cct stdin was not piped".into()))?;
        let mut child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| CrsRuntimeError::MalformedOutput("cct stdout was not piped".into()))?;
        let mut child_stderr = child
            .stderr
            .take()
            .ok_or_else(|| CrsRuntimeError::MalformedOutput("cct stderr was not piped".into()))?;
        let capture_limit = self.config.capture_limit_bytes;
        let transfer = async {
            let input_copy = async move {
                let mut child_stdin = child_stdin;
                let copied = tokio::io::copy(&mut input, &mut child_stdin).await?;
                child_stdin.shutdown().await?;
                drop(child_stdin);
                Ok::<u64, std::io::Error>(copied)
            };
            let output_copy = tokio::io::copy(&mut child_stdout, &mut output);
            let stderr_copy = capture_reader(&mut child_stderr, capture_limit);
            let (input_bytes, output_bytes, captured_stderr) =
                tokio::try_join!(input_copy, output_copy, stderr_copy)?;
            output.flush().await?;
            Ok::<_, std::io::Error>((input_bytes, output_bytes, captured_stderr))
        };
        tokio::pin!(transfer);
        tokio::select! {
            transferred = &mut transfer => {
                let (input_bytes, output_bytes, stderr) = transferred?;
                let status = child.wait().await?;
                if stderr.exceeded {
                    return Err(CrsRuntimeError::OutputLimit { limit: capture_limit });
                }
                if !status.success() {
                    return Err(process_failure(status.to_string(), &stderr.bytes));
                }
                Ok(TransformStreamSummary { input_bytes, output_bytes })
            }
            () = cancellation_requested(cancellation) => {
                if !process_group::kill_group(child.id()).unwrap_or(false) {
                    let _ = child.kill().await;
                }
                let _ = child.wait().await;
                Err(CrsRuntimeError::Cancelled)
            }
        }
    }

    async fn parse_candidates(
        &self,
        stdout: &str,
        query: &OperationQuery,
        cancellation: &CancellationToken,
    ) -> Result<(Vec<OperationCandidate>, Vec<String>), CrsRuntimeError> {
        let catalog: HashMap<&str, &GridCatalogEntry> = query
            .grid_catalog
            .iter()
            .map(|entry| (entry.official_filename.as_str(), entry))
            .collect();
        let blocks = stdout.split("Operation No. ").skip(1);
        let mut candidates = Vec::new();
        let mut warnings = Vec::new();
        for block in blocks {
            let pipeline = marker_value(block, "PROJ string:").ok_or_else(|| {
                CrsRuntimeError::MalformedOutput("candidate has no pipeline".into())
            })?;
            validate_pipeline_tokens(pipeline)?;
            let json_text = marker_value(block, "PROJJSON:").ok_or_else(|| {
                CrsRuntimeError::MalformedOutput("candidate has no PROJJSON".into())
            })?;
            let json: Value = serde_json::from_str(json_text)
                .map_err(|error| CrsRuntimeError::MalformedOutput(error.to_string()))?;
            let area_of_use = json_area(&json)?;
            let mut name = json
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| CrsRuntimeError::MalformedOutput("candidate has no name".into()))?
                .to_owned();
            let grid_names = pipeline_grid_names(pipeline);
            let mut required_grids = Vec::with_capacity(grid_names.len());
            let mut effective_pipeline = pipeline.to_owned();
            let mut local_overrides = Vec::new();
            for filename in grid_names {
                let entry = catalog.get(filename.as_str()).copied().or_else(|| {
                    let axis = pipeline_grid_axis(pipeline, &filename)?;
                    let mut matches = query.grid_catalog.iter().filter(|entry| {
                        entry.local_path.is_some()
                            && match axis {
                                PipelineGridAxis::Horizontal => matches!(
                                    entry.kind,
                                    TransformationGridKind::Ntv2 | TransformationGridKind::Gtg
                                ),
                                PipelineGridAxis::Vertical => {
                                    entry.kind == TransformationGridKind::Geoid
                                }
                            }
                    });
                    let first = matches.next()?;
                    matches.next().is_none().then_some(first)
                });
                let Some(entry) = entry else {
                    warnings.push(format!(
                        "Operation '{name}' requires the unregistered grid '{filename}'."
                    ));
                    continue;
                };
                let mut effective_entry = entry.clone();
                if let Some(local_path) = entry.local_path.as_ref() {
                    if let Some(local_filename) = Path::new(local_path)
                        .file_name()
                        .and_then(std::ffi::OsStr::to_str)
                    {
                        if local_filename != filename {
                            effective_pipeline = replace_pipeline_grid(
                                &effective_pipeline,
                                &filename,
                                local_filename,
                            );
                            effective_entry.official_filename = local_filename.to_owned();
                            local_overrides.push(format!("{filename} → {local_filename}"));
                        }
                    }
                }
                required_grids.push(self.catalog_grid(&effective_entry, cancellation).await?);
            }
            if required_grids.len() != pipeline_grid_names(pipeline).len() {
                continue;
            }
            let accuracy_m = json
                .get("accuracy")
                .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()));
            let ballpark = name.to_ascii_lowercase().contains("ballpark");
            let normalized_name = name.to_ascii_lowercase();
            let changes_reference_frame = query.source != query.target;
            let kind = if changes_reference_frame
                && (normalized_name.contains("gauss-kruger")
                    || normalized_name.contains("gauss-krüger"))
            {
                CoordinateOperationKind::GaussKruegerDatumTransformation
            } else {
                CoordinateOperationKind::General
            };
            if !local_overrides.is_empty() {
                warnings.push(format!(
                    "Explicit local grid override for '{name}': {}. The selected file is hash-verified and frozen with the project.",
                    local_overrides.join(", ")
                ));
                name = format!("{name} · local grid override");
            }
            let operation_id = format!(
                "proj:{}",
                ObjectHash::of_bytes(format!("{effective_pipeline}\n{json_text}").as_bytes())
                    .as_str()
            );
            candidates.push(OperationCandidate {
                operation_id,
                name,
                kind,
                proj_pipeline: effective_pipeline,
                area_of_use,
                expected_accuracy_mm: if local_overrides.is_empty() {
                    accuracy_m.map(|value| value * 1000.0)
                } else {
                    None
                },
                ballpark,
                best_available: candidates.is_empty(),
                required_grids,
            });
        }
        Ok((candidates, warnings))
    }

    async fn catalog_grid(
        &self,
        entry: &GridCatalogEntry,
        cancellation: &CancellationToken,
    ) -> Result<RequiredTransformationGrid, CrsRuntimeError> {
        let local_path = entry.local_path.as_ref().map(PathBuf::from).or_else(|| {
            self.config
                .allowed_grid_roots
                .iter()
                .map(|root| root.join(&entry.official_filename))
                .find(|path| path.is_file())
        });
        let availability = if let Some(local_path) = local_path {
            let path = canonical_file(&local_path)?;
            if !self.is_allowed_grid(&path) {
                return Err(CrsRuntimeError::GridOutsideAllowedRoots {
                    filename: entry.official_filename.clone(),
                });
            }
            let observed_sha256 = if let Some(expected) = &entry.official_sha256 {
                let observed = self.cached_grid_hash(&path, cancellation).await?;
                if &observed != expected {
                    return Err(CrsRuntimeError::GridHashMismatch {
                        filename: entry.official_filename.clone(),
                    });
                }
                Some(observed)
            } else {
                None
            };
            RequiredGridAvailability::PresentVerified {
                local_path: path_text(&path),
                observed_sha256,
            }
        } else {
            RequiredGridAvailability::Missing
        };
        Ok(RequiredTransformationGrid {
            kind: entry.kind,
            official_filename: entry.official_filename.clone(),
            official_sha256: entry.official_sha256.clone(),
            license: entry.license.clone(),
            coverage: entry.coverage,
            availability,
        })
    }

    async fn cached_grid_hash(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<ObjectHash, CrsRuntimeError> {
        let metadata = tokio::fs::metadata(path).await?;
        let modified = metadata.modified()?;
        if let Some((_, _, hash)) = self
            .grid_hash_cache
            .lock()
            .expect("grid hash cache mutex poisoned")
            .get(path)
            .filter(|(length, timestamp, _)| *length == metadata.len() && *timestamp == modified)
        {
            return Ok(hash.clone());
        }
        let hash = hash_file_async(path.to_path_buf(), cancellation.clone()).await?;
        self.grid_hash_cache
            .lock()
            .expect("grid hash cache mutex poisoned")
            .insert(path.to_path_buf(), (metadata.len(), modified, hash.clone()));
        Ok(hash)
    }

    async fn explicit_dhdn_grid_candidate(
        &self,
        query: &OperationQuery,
        cancellation: &CancellationToken,
    ) -> Result<Option<OperationCandidate>, CrsRuntimeError> {
        let Some(zone) = dhdn_gauss_krueger_zone(&query.target.crs) else {
            return Ok(None);
        };
        let source_is_3d = matches!(query.source.crs, CrsDefinition::Epsg(4979));
        let source_is_2d = matches!(query.source.crs, CrsDefinition::Epsg(4326));
        if !source_is_3d && !source_is_2d {
            return Ok(None);
        }

        let horizontal_entries = query
            .grid_catalog
            .iter()
            .filter(|entry| {
                matches!(
                    entry.kind,
                    TransformationGridKind::Ntv2 | TransformationGridKind::Gtg
                )
            })
            .collect::<Vec<_>>();
        if horizontal_entries.len() != 1 {
            return Ok(None);
        }
        let vertical_entries = query
            .grid_catalog
            .iter()
            .filter(|entry| entry.kind == TransformationGridKind::Geoid)
            .collect::<Vec<_>>();
        if vertical_entries.len() > 1
            || (source_is_3d && vertical_entries.len() != 1)
            || (source_is_2d && !vertical_entries.is_empty())
        {
            return Ok(None);
        }

        let mut entries = Vec::with_capacity(2);
        if let Some(vertical) = vertical_entries.first() {
            entries.push(*vertical);
        }
        entries.push(horizontal_entries[0]);
        if entries
            .iter()
            .any(|entry| !entry.coverage.contains(query.area_of_interest))
        {
            return Ok(None);
        }

        let mut effective_entries = Vec::with_capacity(entries.len());
        let mut required_grids = Vec::with_capacity(entries.len());
        for entry in entries {
            let mut effective = entry.clone();
            if let Some(local_path) = entry.local_path.as_ref() {
                let filename = Path::new(local_path)
                    .file_name()
                    .and_then(std::ffi::OsStr::to_str)
                    .ok_or(CrsRuntimeError::InvalidRequest("grid localPath"))?;
                validate_grid_filename(filename)?;
                effective.official_filename = filename.to_owned();
            } else {
                validate_grid_filename(&effective.official_filename)?;
            }
            required_grids.push(self.catalog_grid(&effective, cancellation).await?);
            effective_entries.push(effective);
        }
        self.validate_dhdn_horizontal_grid(
            required_grids
                .iter()
                .find(|grid| {
                    matches!(
                        grid.kind,
                        TransformationGridKind::Ntv2 | TransformationGridKind::Gtg
                    )
                })
                .expect("one horizontal grid was bound"),
        )
        .await?;

        let vertical_filename = effective_entries
            .iter()
            .find(|entry| entry.kind == TransformationGridKind::Geoid)
            .map(|entry| entry.official_filename.as_str());
        let horizontal_filename = effective_entries
            .iter()
            .find(|entry| {
                matches!(
                    entry.kind,
                    TransformationGridKind::Ntv2 | TransformationGridKind::Gtg
                )
            })
            .expect("one horizontal entry was validated")
            .official_filename
            .as_str();
        let longitude_origin = zone * 3;
        let false_easting = zone * 1_000_000 + 500_000;
        let mut pipeline = String::from(
            "+proj=pipeline +step +proj=axisswap +order=2,1 +step +proj=unitconvert +xy_in=deg +xy_out=rad",
        );
        if let Some(filename) = vertical_filename {
            pipeline.push_str(&format!(
                " +step +inv +proj=vgridshift +grids={filename} +multiplier=1"
            ));
        }
        pipeline.push_str(&format!(
            " +step +inv +proj=hgridshift +grids={horizontal_filename} +step +proj=tmerc +lat_0=0 +lon_0={longitude_origin} +k=1 +x_0={false_easting} +y_0=0 +ellps=bessel +step +proj=axisswap +order=2,1"
        ));
        validate_pipeline_tokens(&pipeline)?;
        self.validate_pipeline_roundtrip(
            &pipeline,
            &effective_entries,
            query.area_of_interest,
            cancellation,
        )
        .await?;

        let area_of_use = effective_entries
            .iter()
            .fold(query.area_of_interest, |area, entry| GeographicArea {
                west_longitude: area.west_longitude.max(entry.coverage.west_longitude),
                south_latitude: area.south_latitude.max(entry.coverage.south_latitude),
                east_longitude: area.east_longitude.min(entry.coverage.east_longitude),
                north_latitude: area.north_latitude.min(entry.coverage.north_latitude),
            });
        let operation_evidence = serde_json::json!({
            "schemaVersion": 1,
            "source": query.source,
            "target": query.target,
            "pipeline": pipeline,
            "grids": required_grids.iter().map(|grid| serde_json::json!({
                "kind": grid.kind,
                "sha256": grid.official_sha256,
            })).collect::<Vec<_>>(),
        });
        let operation_id = format!(
            "proj:{}",
            ObjectHash::of_bytes(
                &serde_json::to_vec(&operation_evidence)
                    .map_err(|error| { CrsRuntimeError::MalformedOutput(error.to_string()) })?
            )
            .as_str()
        );
        Ok(Some(OperationCandidate {
            operation_id,
            name: format!("Explicit local-grid WGS 84 to DHDN / Gauss-Krueger zone {zone}"),
            kind: CoordinateOperationKind::GaussKruegerDatumTransformation,
            proj_pipeline: pipeline,
            area_of_use,
            expected_accuracy_mm: None,
            ballpark: false,
            best_available: true,
            required_grids,
        }))
    }

    /// PROJ treats a projected 2D endpoint as permission to discard a compound
    /// vertical component. For a height-only GCP operation that would surface a
    /// misleading `+proj=noop`. Build the auditable projected → geographic →
    /// vgridshift → projected pipeline explicitly when exactly one endpoint is
    /// ellipsoidal and the other carries a registered vertical CRS.
    async fn explicit_vertical_grid_candidate(
        &self,
        query: &OperationQuery,
        cancellation: &CancellationToken,
    ) -> Result<Option<OperationCandidate>, CrsRuntimeError> {
        let Some(source_zone) = etrs89_utm_zone(&query.source.crs) else {
            return Ok(None);
        };
        let Some(target_zone) = etrs89_utm_zone(&query.target.crs) else {
            return Ok(None);
        };
        let source_vertical = compound_vertical_epsg(&query.source.crs);
        let target_vertical = compound_vertical_epsg(&query.target.crs);
        let (vertical_epsg, inverse_grid, direction_label) =
            match (source_vertical, target_vertical) {
                (Some(source), None) => (source, false, "to ellipsoidal height"),
                (None, Some(target)) => (target, true, "from ellipsoidal height"),
                _ => return Ok(None),
            };
        let mut vertical_entries = query
            .grid_catalog
            .iter()
            .filter(|entry| entry.kind == TransformationGridKind::Geoid);
        let Some(entry) = vertical_entries.next() else {
            return Ok(None);
        };
        if vertical_entries.next().is_some() {
            return Ok(None);
        }

        let mut effective_entry = entry.clone();
        if let Some(local_path) = entry.local_path.as_ref() {
            let filename = Path::new(local_path)
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .ok_or(CrsRuntimeError::InvalidRequest("grid localPath"))?;
            validate_grid_filename(filename)?;
            effective_entry.official_filename = filename.to_owned();
        } else {
            validate_grid_filename(&effective_entry.official_filename)?;
        }
        let required_grid = self.catalog_grid(&effective_entry, cancellation).await?;
        let grid_step = if inverse_grid {
            format!(
                "+step +inv +proj=vgridshift +grids={} +multiplier=1",
                effective_entry.official_filename
            )
        } else {
            format!(
                "+step +proj=vgridshift +grids={} +multiplier=1",
                effective_entry.official_filename
            )
        };
        let pipeline = format!(
            "+proj=pipeline +step +inv +proj=utm +zone={source_zone} +ellps=GRS80 {grid_step} +step +proj=utm +zone={target_zone} +ellps=GRS80"
        );
        validate_pipeline_tokens(&pipeline)?;
        if matches!(
            required_grid.availability,
            RequiredGridAvailability::PresentVerified { .. }
        ) && effective_entry.coverage.contains(query.area_of_interest)
        {
            let longitude = f64::from(source_zone) * 6.0 - 183.0;
            let latitude = (query.area_of_interest.south_latitude
                + query.area_of_interest.north_latitude)
                * 0.5;
            let probe_input = format!("{longitude:.12} {latitude:.12} 0 0\n");
            let geographic_to_source = format!(
                "+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=utm +zone={source_zone} +ellps=GRS80"
            );
            let projected = self
                .run_cct_probe(
                    &geographic_to_source,
                    &[],
                    false,
                    &probe_input,
                    cancellation,
                )
                .await?;
            let forward = self
                .run_cct_probe(
                    &pipeline,
                    std::slice::from_ref(&effective_entry),
                    false,
                    &projected,
                    cancellation,
                )
                .await?;
            let inverse = self
                .run_cct_probe(
                    &pipeline,
                    std::slice::from_ref(&effective_entry),
                    true,
                    &forward,
                    cancellation,
                )
                .await?;
            let projected_values = probe_values(&projected)?;
            let inverse_values = probe_values(&inverse)?;
            if inverse_values
                .iter()
                .take(3)
                .any(|value| !value.is_finite())
                || (projected_values[0] - inverse_values[0]).abs() > 1e-4
                || (projected_values[1] - inverse_values[1]).abs() > 1e-4
                || (projected_values[2] - inverse_values[2]).abs() > 1e-4
            {
                return Err(CrsRuntimeError::MalformedOutput(
                    "selected vertical-grid pipeline failed its forward/inverse area probe".into(),
                ));
            }
        }

        let operation_evidence = serde_json::json!({
            "schemaVersion": 1,
            "source": query.source,
            "target": query.target,
            "pipeline": pipeline,
            "verticalEpsg": vertical_epsg,
            "grid": {
                "filename": required_grid.official_filename,
                "sha256": required_grid.official_sha256,
            },
        });
        let operation_id = format!(
            "proj:{}",
            ObjectHash::of_bytes(
                &serde_json::to_vec(&operation_evidence)
                    .map_err(|error| CrsRuntimeError::MalformedOutput(error.to_string()))?
            )
            .as_str()
        );
        Ok(Some(OperationCandidate {
            operation_id,
            name: format!("EPSG:{vertical_epsg} {direction_label} · explicit geoid"),
            kind: CoordinateOperationKind::General,
            proj_pipeline: pipeline,
            area_of_use: effective_entry.coverage,
            expected_accuracy_mm: None,
            ballpark: false,
            best_available: true,
            required_grids: vec![required_grid],
        }))
    }

    async fn validate_dhdn_horizontal_grid(
        &self,
        grid: &RequiredTransformationGrid,
    ) -> Result<(), CrsRuntimeError> {
        const BETA2007_SHA256: &str =
            "46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2";
        let filename_lower = grid.official_filename.to_ascii_lowercase();
        // UI/GDAL sometimes mislabel classic NTv2 (.gsb) as GTG — treat by extension too.
        let looks_like_ntv2 = grid.kind == TransformationGridKind::Ntv2
            || filename_lower.ends_with(".gsb")
            || filename_lower.ends_with(".gsba");

        if grid.kind == TransformationGridKind::Gtg && !looks_like_ntv2 {
            if grid
                .official_sha256
                .as_ref()
                .is_some_and(|hash| hash.as_str() == BETA2007_SHA256)
            {
                return Ok(());
            }
            // Explicit user local GeoTIFF: allow when a concrete path is bound. Direction
            // safety is covered by the subsequent round-trip probe for this pipeline.
            let RequiredGridAvailability::PresentVerified { local_path, .. } = &grid.availability
            else {
                return Err(CrsRuntimeError::IncompatibleGrid {
                    filename: grid.official_filename.clone(),
                    reason: "an unaudited horizontal GeoTIFF cannot establish DHDN90 → ETRS89 direction; select the original NTv2 grid, bundled BETA2007, or a local grid file"
                        .into(),
                });
            };
            if local_path.trim().is_empty() {
                return Err(CrsRuntimeError::IncompatibleGrid {
                    filename: grid.official_filename.clone(),
                    reason: "horizontal GeoTIFF requires a local path for the DHDN pipeline".into(),
                });
            }
            return Ok(());
        }

        let RequiredGridAvailability::PresentVerified { local_path, .. } = &grid.availability
        else {
            return Ok(());
        };
        let mut file = tokio::fs::File::open(local_path).await?;
        let mut header = vec![0_u8; 512];
        let read = file.read(&mut header).await?;
        header.truncate(read);
        let compact = header
            .iter()
            .copied()
            .filter(u8::is_ascii_alphanumeric)
            .map(char::from)
            .collect::<String>()
            .to_ascii_uppercase();
        // Accept common DHDN ↔ ETRS NTv2 labels (order depends on whether the grid
        // is used forward or inverse in the pipeline).
        let has_dhdn = compact.contains("SYSTEMFDHDN")
            || compact.contains("SYSTEMTDHDN")
            || compact.contains("DHDN");
        let has_etrs = compact.contains("SYSTEMTETRS89")
            || compact.contains("SYSTEMFETRS89")
            || compact.contains("ETRS89")
            || compact.contains("ETRS");
        if has_dhdn && has_etrs {
            return Ok(());
        }
        // Regional survey grids often omit canonical SYSTEM_F/T tags. A file selected
        // explicitly by the user has no catalog-supplied official hash; accept that
        // local binding and let the subsequent PROJ round-trip validate its contents.
        // A hash-pinned catalog entry, however, claims a known grid identity. It must
        // not become a DHDN grid merely because its path happens to end in `.gsb`.
        if looks_like_ntv2 && grid.official_sha256.is_none() && !local_path.trim().is_empty() {
            return Ok(());
        }
        Err(CrsRuntimeError::IncompatibleGrid {
            filename: grid.official_filename.clone(),
            reason: "NTv2 header must declare DHDN and ETRS89 (or the grid must be an explicitly registered local .gsb / bundled BETA2007)".into(),
        })
    }

    async fn validate_pipeline_roundtrip(
        &self,
        pipeline: &str,
        grids: &[GridCatalogEntry],
        area: GeographicArea,
        cancellation: &CancellationToken,
    ) -> Result<(), CrsRuntimeError> {
        let latitude = (area.south_latitude + area.north_latitude) * 0.5;
        let longitude = (area.west_longitude + area.east_longitude) * 0.5;
        let input = format!("{latitude:.12} {longitude:.12} 0 0\n");
        let forward = self
            .run_cct_probe(pipeline, grids, false, &input, cancellation)
            .await?;
        let forward_values = probe_values(&forward)?;
        let inverse = self
            .run_cct_probe(pipeline, grids, true, &forward, cancellation)
            .await?;
        let inverse_values = probe_values(&inverse)?;
        if forward_values
            .iter()
            .take(3)
            .any(|value| !value.is_finite())
            || (inverse_values[0] - latitude).abs() > 1e-8
            || (inverse_values[1] - longitude).abs() > 1e-8
            || inverse_values[2].abs() > 1e-4
        {
            return Err(CrsRuntimeError::MalformedOutput(
                "selected grid pipeline failed its forward/inverse area probe".into(),
            ));
        }
        Ok(())
    }

    async fn run_cct_probe(
        &self,
        pipeline: &str,
        grids: &[GridCatalogEntry],
        inverse: bool,
        input: &str,
        cancellation: &CancellationToken,
    ) -> Result<String, CrsRuntimeError> {
        let mut args = Vec::new();
        if inverse {
            args.push(OsString::from("-I"));
        }
        args.extend([
            OsString::from("--columns"),
            OsString::from("1,2,3,4"),
            OsString::from("--decimals"),
            OsString::from("15"),
        ]);
        args.extend(
            validate_pipeline_tokens(pipeline)?
                .into_iter()
                .map(OsString::from),
        );
        let mut roots = Vec::new();
        for grid in grids {
            if let Some(parent) = grid
                .local_path
                .as_deref()
                .and_then(|path| Path::new(path).parent())
            {
                let parent = parent.to_path_buf();
                if !roots.contains(&parent) {
                    roots.push(parent);
                }
            }
        }
        for root in &self.config.allowed_grid_roots {
            if !roots.contains(root) {
                roots.push(root.clone());
            }
        }
        let search_path = std::env::join_paths(roots)
            .map_err(|_| CrsRuntimeError::InvalidRequest("grid search path"))?;
        let mut command = self.command(&self.config.cct_path, args);
        command.env("PROJ_DATA", search_path);
        let mut child = command.spawn().map_err(CrsRuntimeError::Spawn)?;
        let _group_guard = ProcessGroupDropGuard::new(child.id());
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| CrsRuntimeError::MalformedOutput("cct stdin was not piped".into()))?;
        stdin.write_all(input.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);
        tokio::select! {
            output = child.wait_with_output() => {
                let output = output?;
                if !output.status.success() {
                    return Err(process_failure(output.status.to_string(), &output.stderr));
                }
                if output.stdout.len() > 64 * 1024 {
                    return Err(CrsRuntimeError::OutputLimit { limit: 64 * 1024 });
                }
                String::from_utf8(output.stdout)
                    .map_err(|error| CrsRuntimeError::MalformedOutput(error.to_string()))
            }
            () = cancellation_requested(cancellation) => Err(CrsRuntimeError::Cancelled),
        }
    }

    fn is_allowed_grid(&self, path: &Path) -> bool {
        self.config
            .allowed_grid_roots
            .iter()
            .any(|root| path.starts_with(root))
    }

    async fn run_capture<I>(
        &self,
        executable: &Path,
        args: I,
        cancellation: &CancellationToken,
    ) -> Result<CapturedProcess, CrsRuntimeError>
    where
        I: IntoIterator<Item = OsString>,
    {
        if cancellation.is_cancel_requested() {
            return Err(CrsRuntimeError::Cancelled);
        }
        let mut child = self
            .command(executable, args)
            .spawn()
            .map_err(CrsRuntimeError::Spawn)?;
        let _group_guard = ProcessGroupDropGuard::new(child.id());
        drop(child.stdin.take());
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| CrsRuntimeError::MalformedOutput("child stdout was not piped".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| CrsRuntimeError::MalformedOutput("child stderr was not piped".into()))?;
        let limit = self.config.capture_limit_bytes;
        let capture = async {
            let (stdout, stderr) = tokio::try_join!(
                capture_reader(&mut stdout, limit),
                capture_reader(&mut stderr, limit)
            )?;
            Ok::<_, std::io::Error>((stdout, stderr))
        };
        tokio::pin!(capture);
        tokio::select! {
            captured = &mut capture => {
                let (stdout, stderr) = captured?;
                let status = child.wait().await?;
                if stdout.exceeded || stderr.exceeded {
                    return Err(CrsRuntimeError::OutputLimit { limit });
                }
                if !status.success() {
                    return Err(process_failure(status.to_string(), &stderr.bytes));
                }
                Ok(CapturedProcess {
                    stdout: String::from_utf8(stdout.bytes).map_err(|error| {
                        CrsRuntimeError::MalformedOutput(error.to_string())
                    })?,
                    stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
                })
            }
            () = cancellation_requested(cancellation) => {
                if !process_group::kill_group(child.id()).unwrap_or(false) {
                    let _ = child.kill().await;
                }
                let _ = child.wait().await;
                Err(CrsRuntimeError::Cancelled)
            }
        }
    }

    fn command<I>(&self, executable: &Path, args: I) -> Command
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut command = Command::new(executable);
        command
            .args(args)
            .env_remove("PROJ_NETWORK")
            .env_remove("PROJ_LIB")
            .env_remove("PROJ_DATA")
            .env_remove("PROJ_AUX_DB")
            .env_remove("PROJ_USER_WRITABLE_DIRECTORY")
            .env("PROJ_NETWORK", "OFF")
            .env("PROJ_DATA", self.proj_search_path())
            .env("PROJ_LIB", &self.config.data_directory)
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process_group::configure(command.as_std_mut());
        command
    }

    fn proj_search_path(&self) -> OsString {
        std::env::join_paths(&self.config.allowed_grid_roots)
            .unwrap_or_else(|_| self.config.data_directory.as_os_str().to_owned())
    }

    fn frozen_proj_search_path(&self, frozen: &FrozenImportTransformation) -> OsString {
        let mut roots = Vec::new();
        for grid in &frozen.pipeline.grids {
            if let Some(parent) = Path::new(&grid.local_path).parent() {
                let parent = parent.to_path_buf();
                if !roots.contains(&parent) {
                    roots.push(parent);
                }
            }
        }
        for root in &self.config.allowed_grid_roots {
            if !roots.contains(root) {
                roots.push(root.clone());
            }
        }
        std::env::join_paths(roots)
            .unwrap_or_else(|_| self.config.data_directory.as_os_str().to_owned())
    }
}

fn dhdn_gauss_krueger_zone(target: &CrsDefinition) -> Option<i32> {
    let code = match target {
        CrsDefinition::Epsg(code) => *code,
        CrsDefinition::Authority(authority) => authority
            .strip_prefix("EPSG:")?
            .split('+')
            .next()?
            .parse()
            .ok()?,
        CrsDefinition::Wkt2(_) | CrsDefinition::ProjJson(_) => return None,
    };
    if (31_466..=31_469).contains(&code) {
        i32::try_from(code - 31_464).ok()
    } else {
        None
    }
}

fn etrs89_utm_zone(definition: &CrsDefinition) -> Option<u32> {
    let code = horizontal_epsg(definition)?;
    if (25_828..=25_838).contains(&code) {
        Some(code - 25_800)
    } else {
        None
    }
}

fn horizontal_epsg(definition: &CrsDefinition) -> Option<u32> {
    match definition {
        CrsDefinition::Epsg(code) => Some(*code),
        CrsDefinition::Authority(authority) => authority
            .strip_prefix("EPSG:")?
            .split('+')
            .next()?
            .parse()
            .ok(),
        CrsDefinition::Wkt2(_) | CrsDefinition::ProjJson(_) => None,
    }
}

fn compound_vertical_epsg(definition: &CrsDefinition) -> Option<u32> {
    let CrsDefinition::Authority(authority) = definition else {
        return None;
    };
    let mut parts = authority.strip_prefix("EPSG:")?.split('+');
    parts.next()?;
    let vertical = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some(vertical)
}

#[derive(Debug)]
struct CapturedProcess {
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct CapturedBytes {
    bytes: Vec<u8>,
    exceeded: bool,
}

#[derive(Debug)]
struct DatabaseMetadata {
    version: String,
    date: Option<String>,
}

async fn capture_reader<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<CapturedBytes, std::io::Error> {
    let mut captured = Vec::with_capacity(limit.min(64 * 1024));
    let mut exceeded = false;
    let mut buffer = vec![0_u8; 16 * 1024].into_boxed_slice();
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let retained = read.min(remaining);
        captured.extend_from_slice(&buffer[..retained]);
        exceeded |= retained < read;
    }
    Ok(CapturedBytes {
        bytes: captured,
        exceeded,
    })
}

async fn cancellation_requested(token: &CancellationToken) {
    while !token.is_cancel_requested() {
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}

fn canonical_file(path: &Path) -> Result<PathBuf, CrsRuntimeError> {
    canonical_path(path, false)
}

fn canonical_directory(path: &Path) -> Result<PathBuf, CrsRuntimeError> {
    canonical_path(path, true)
}

fn canonical_path(path: &Path, directory: bool) -> Result<PathBuf, CrsRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| CrsRuntimeError::InvalidToolchainPath {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
    let metadata = canonical
        .metadata()
        .map_err(|error| CrsRuntimeError::InvalidToolchainPath {
            path: canonical.display().to_string(),
            reason: error.to_string(),
        })?;
    if metadata.is_dir() != directory || (!directory && !metadata.is_file()) {
        return Err(CrsRuntimeError::InvalidToolchainPath {
            path: canonical.display().to_string(),
            reason: if directory {
                "not a directory".into()
            } else {
                "not a regular file".into()
            },
        });
    }
    Ok(canonical)
}

fn crs_argument(crs: &CrsDefinition) -> Result<OsString, CrsRuntimeError> {
    let argument = match crs {
        CrsDefinition::Epsg(code) if *code > 0 => format!("EPSG:{code}"),
        CrsDefinition::Authority(value)
            if !value.is_empty()
                && value.len() <= 256
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'+' | b'_' | b'-')
                }) =>
        {
            value.clone()
        }
        CrsDefinition::Wkt2(value) if !value.trim().is_empty() => value.clone(),
        CrsDefinition::ProjJson(value)
            if !value.trim().is_empty() && serde_json::from_str::<Value>(value).is_ok() =>
        {
            value.clone()
        }
        _ => return Err(CrsRuntimeError::InvalidRequest("crs")),
    };
    if argument.len() > MAX_CRS_ARGUMENT_BYTES || argument.contains('\0') {
        return Err(CrsRuntimeError::InvalidRequest("crs"));
    }
    Ok(OsString::from(argument))
}

fn validate_pipeline_tokens(pipeline: &str) -> Result<Vec<&str>, CrsRuntimeError> {
    if pipeline.is_empty()
        || pipeline.len() > MAX_PIPELINE_BYTES
        || pipeline.contains(['\0', '\n', '\r'])
    {
        return Err(CrsRuntimeError::InvalidRequest("projPipeline"));
    }
    let tokens: Vec<_> = pipeline.split_ascii_whitespace().collect();
    if tokens.is_empty()
        || tokens
            .iter()
            .any(|token| !token.starts_with('+') || token.len() < 2)
    {
        return Err(CrsRuntimeError::InvalidRequest("projPipeline"));
    }
    Ok(tokens)
}

fn validate_grid_filename(filename: &str) -> Result<(), CrsRuntimeError> {
    if filename.is_empty()
        || filename.len() > 255
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(CrsRuntimeError::InvalidRequest("grid filename"));
    }
    Ok(())
}

fn probe_values(output: &str) -> Result<[f64; 4], CrsRuntimeError> {
    let line = output
        .lines()
        .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .ok_or_else(|| {
            CrsRuntimeError::MalformedOutput("cct probe returned no coordinate".into())
        })?;
    let values = line
        .split_ascii_whitespace()
        .take(4)
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CrsRuntimeError::MalformedOutput(error.to_string()))?;
    values.try_into().map_err(|_| {
        CrsRuntimeError::MalformedOutput("cct probe returned fewer than four ordinates".into())
    })
}

fn marker_value<'a>(block: &'a str, marker: &str) -> Option<&'a str> {
    let remainder = block.split_once(marker)?.1;
    remainder
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
}

fn json_area(json: &Value) -> Result<GeographicArea, CrsRuntimeError> {
    let bbox = json
        .get("bbox")
        .ok_or_else(|| CrsRuntimeError::MalformedOutput("candidate has no bbox".into()))?;
    let number = |key| {
        bbox.get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| CrsRuntimeError::MalformedOutput(format!("bbox has no {key}")))
    };
    let area = GeographicArea {
        west_longitude: number("west_longitude")?,
        south_latitude: number("south_latitude")?,
        east_longitude: number("east_longitude")?,
        north_latitude: number("north_latitude")?,
    };
    if !area.is_valid() {
        return Err(CrsRuntimeError::MalformedOutput(
            "invalid candidate bbox".into(),
        ));
    }
    Ok(area)
}

fn pipeline_grid_names(pipeline: &str) -> Vec<String> {
    let mut names = Vec::new();
    for token in pipeline.split_ascii_whitespace() {
        let Some(value) = token.strip_prefix("+grids=") else {
            continue;
        };
        for filename in value.split(',') {
            let filename = filename.trim_start_matches('@');
            if !filename.is_empty()
                && filename != "null"
                && !names.iter().any(|item| item == filename)
            {
                names.push(filename.to_owned());
            }
        }
    }
    names
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PipelineGridAxis {
    Horizontal,
    Vertical,
}

fn pipeline_grid_axis(pipeline: &str, grid_name: &str) -> Option<PipelineGridAxis> {
    let mut axis = None;
    for token in pipeline.split_ascii_whitespace() {
        if token == "+step" {
            axis = None;
        } else if token == "+proj=hgridshift" {
            axis = Some(PipelineGridAxis::Horizontal);
        } else if token == "+proj=vgridshift" {
            axis = Some(PipelineGridAxis::Vertical);
        } else if let Some(grids) = token.strip_prefix("+grids=") {
            if grids
                .split(',')
                .map(|value| value.trim_start_matches('@'))
                .any(|value| value == grid_name)
            {
                return axis;
            }
        }
    }
    None
}

fn replace_pipeline_grid(pipeline: &str, expected: &str, replacement: &str) -> String {
    pipeline
        .split_ascii_whitespace()
        .map(|token| {
            let Some(grids) = token.strip_prefix("+grids=") else {
                return token.to_owned();
            };
            let replaced = grids
                .split(',')
                .map(|value| {
                    let optional = value.starts_with('@');
                    let name = value.trim_start_matches('@');
                    if name == expected {
                        format!("{}{}", if optional { "@" } else { "" }, replacement)
                    } else {
                        value.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("+grids={replaced}")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_proj_version(text: &str) -> Option<String> {
    let marker = "Rel. ";
    let value = text.split_once(marker)?.1;
    let version = value.split([',', ' ']).find(|part| !part.is_empty())?;
    Some(version.to_owned())
}

async fn database_evidence(
    path: PathBuf,
    cancellation: CancellationToken,
) -> Result<(DatabaseMetadata, ObjectHash), CrsRuntimeError> {
    tokio::task::spawn_blocking(move || database_evidence_blocking(&path, &cancellation))
        .await
        .map_err(|error| CrsRuntimeError::BackgroundTask(error.to_string()))?
}

fn database_evidence_blocking(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(DatabaseMetadata, ObjectHash), CrsRuntimeError> {
    use std::io::Read;

    let metadata = path.metadata()?;
    if metadata.len() > MAX_DATABASE_BYTES {
        return Err(CrsRuntimeError::InvalidToolchainPath {
            path: path_text(path),
            reason: "PROJ database exceeds safety limit".into(),
        });
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    let mut scan_tail = Vec::with_capacity(512);
    let mut version = None;
    let mut date = None;
    loop {
        if cancellation.is_cancel_requested() {
            return Err(CrsRuntimeError::Cancelled);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        if version.is_none() || date.is_none() {
            scan_tail.extend_from_slice(&buffer[..read]);
            version = version.or_else(|| binary_metadata_value(&scan_tail, b"EPSG.VERSION"));
            date = date.or_else(|| binary_metadata_value(&scan_tail, b"EPSG.DATE"));
            if scan_tail.len() > 512 {
                scan_tail.drain(..scan_tail.len() - 512);
            }
        }
    }
    let version = version
        .ok_or_else(|| CrsRuntimeError::MalformedOutput("proj.db has no EPSG.VERSION".into()))?;
    Ok((
        DatabaseMetadata { version, date },
        ObjectHash(hex::encode(hasher.finalize())),
    ))
}

fn binary_metadata_value(bytes: &[u8], marker: &[u8]) -> Option<String> {
    let offset = bytes
        .windows(marker.len())
        .position(|window| window == marker)?
        + marker.len();
    let value: Vec<u8> = bytes[offset..]
        .iter()
        .copied()
        .take_while(u8::is_ascii_graphic)
        .take(128)
        .collect();
    (!value.is_empty()).then(|| String::from_utf8_lossy(&value).into_owned())
}

async fn hash_file_async(
    path: PathBuf,
    cancellation: CancellationToken,
) -> Result<ObjectHash, CrsRuntimeError> {
    tokio::task::spawn_blocking(move || hash_file(&path, &cancellation))
        .await
        .map_err(|error| CrsRuntimeError::BackgroundTask(error.to_string()))?
}

fn hash_file(path: &Path, cancellation: &CancellationToken) -> Result<ObjectHash, CrsRuntimeError> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    loop {
        if cancellation.is_cancel_requested() {
            return Err(CrsRuntimeError::Cancelled);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn process_failure(status: String, stderr: &[u8]) -> CrsRuntimeError {
    CrsRuntimeError::ProcessFailed {
        status,
        stderr: String::from_utf8_lossy(stderr).trim().to_owned(),
    }
}

/// Whether a rediscovered candidate is an acceptable realization of the frozen selection.
///
/// Exact triple match is preferred. After a user rebinds local NTv2/GTG/geoid files, PROJ may
/// re-hash `operation_id` or rewrite the display name (`· local grid override`) while the
/// executable pipeline (same steps, possibly only `+grids=` basenames changed) stays valid.
fn operation_matches_frozen_selection(
    candidate: &OperationCandidate,
    frozen: &FrozenOperationPipeline,
) -> bool {
    if candidate.operation_id == frozen.operation_id
        && candidate.proj_pipeline == frozen.proj_pipeline
        && candidate.name == frozen.operation_name
    {
        return true;
    }
    if candidate.ballpark {
        return false;
    }
    if candidate.proj_pipeline == frozen.proj_pipeline {
        return true;
    }
    pipelines_equivalent_for_user_grids(&candidate.proj_pipeline, &frozen.proj_pipeline)
}

/// Compare pipelines ignoring which concrete grid file fills each `+grids=` slot.
fn pipelines_equivalent_for_user_grids(left: &str, right: &str) -> bool {
    normalize_pipeline_grid_slots(left) == normalize_pipeline_grid_slots(right)
}

fn normalize_pipeline_grid_slots(pipeline: &str) -> String {
    let mut out = String::with_capacity(pipeline.len());
    for token in pipeline.split_whitespace() {
        if let Some(rest) = token.strip_prefix("+grids=") {
            // Collapse multi-grid comma lists to a stable slot count marker.
            let slots = rest.split(',').filter(|s| !s.is_empty()).count().max(1);
            out.push_str(&format!("+grids=<{slots}>"));
        } else {
            out.push_str(token);
        }
        out.push(' ');
    }
    out
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    use himmelcad_core::photolab_crs::{
        CrsWithEpoch, FrozenCrsEndpoint, FrozenOperationPipeline, HeightReference,
        HorizontalCrsSelection, ImportTransformationDecision, VerticalCrsSelection,
        VerticalOperationMode,
    };

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        runtime: ProjRuntime,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "himmelcad-crs-runtime-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).expect("fixture directory");
            fs::write(
                root.join("proj.db"),
                b"fixture\0EPSG.VERSIONv11.004\0EPSG.DATE2024-02-24\0",
            )
            .expect("database fixture");
            write_executable(
                &root.join("cct"),
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'cct: Rel. 9.4.0, March 1st, 2024'; else /bin/cat; fi\n",
            );
            write_executable(
                &root.join("projinfo"),
                "#!/bin/sh\nprintf '%s\\n' 'Candidate operations found: 1' 'Operation No. 1:' '' 'unknown id' '' 'PROJ string:' '+proj=pipeline +step +proj=utm +zone=32 +ellps=GRS80' '' 'PROJJSON:' '{\"type\":\"ConcatenatedOperation\",\"name\":\"Fixture operation\",\"accuracy\":\"0.01\",\"bbox\":{\"south_latitude\":47.0,\"west_longitude\":5.0,\"north_latitude\":56.0,\"east_longitude\":16.0}}'\n",
            );
            let runtime = ProjRuntime::open(ProjToolchainConfig::system(
                root.join("projinfo"),
                root.join("cct"),
                &root,
            ))
            .expect("runtime");
            Self { root, runtime }
        }

        fn frozen() -> FrozenImportTransformation {
            let pipeline = "+proj=pipeline +step +proj=utm +zone=32 +ellps=GRS80";
            let json = "{\"type\":\"ConcatenatedOperation\",\"name\":\"Fixture operation\",\"accuracy\":\"0.01\",\"bbox\":{\"south_latitude\":47.0,\"west_longitude\":5.0,\"north_latitude\":56.0,\"east_longitude\":16.0}}";
            FrozenImportTransformation {
                schema_version: 1,
                original: FrozenCrsEndpoint {
                    horizontal: CrsWithEpoch {
                        crs: CrsDefinition::Epsg(4326),
                        coordinate_epoch: None,
                    },
                    vertical: HeightReference::Ellipsoidal,
                },
                target: FrozenCrsEndpoint {
                    horizontal: CrsWithEpoch {
                        crs: CrsDefinition::Epsg(25832),
                        coordinate_epoch: None,
                    },
                    vertical: HeightReference::Ellipsoidal,
                },
                vertical_mode: VerticalOperationMode::PreserveValues,
                area_of_interest: project_area(),
                pipeline: FrozenOperationPipeline {
                    operation_id: format!(
                        "proj:{}",
                        ObjectHash::of_bytes(format!("{pipeline}\n{json}").as_bytes()).as_str()
                    ),
                    operation_name: "Fixture operation".into(),
                    proj_pipeline: pipeline.into(),
                    expected_accuracy_mm: Some(10.0),
                    ballpark: false,
                    selection_policy: OperationSelectionPolicy::default(),
                    grids: vec![],
                },
                database_versions: CrsDatabaseVersions {
                    proj_version: "9.4.0".into(),
                    epsg_database_version: "v11.004".into(),
                },
                decision_sha256: ObjectHash::of_bytes(b"decision"),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_executable(path: &Path, body: &str) {
        fs::write(path, body).expect("script");
        let mut permissions = fs::metadata(path).expect("metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).expect("permissions");
    }

    fn project_area() -> GeographicArea {
        GeographicArea {
            west_longitude: 9.0,
            south_latitude: 48.0,
            east_longitude: 10.0,
            north_latitude: 49.0,
        }
    }

    fn crs(code: u32) -> CrsWithEpoch {
        CrsWithEpoch {
            crs: CrsDefinition::Epsg(code),
            coordinate_epoch: None,
        }
    }

    #[tokio::test]
    async fn audit_records_versions_hash_and_offline_state() {
        let fixture = Fixture::new();
        let audit = fixture
            .runtime
            .audit(&CancellationToken::new())
            .await
            .expect("audit");
        assert_eq!(audit.versions.proj_version, "9.4.0");
        assert_eq!(audit.versions.epsg_database_version, "v11.004");
        assert_eq!(audit.epsg_database_date.as_deref(), Some("2024-02-24"));
        assert!(!audit.network_enabled);
        assert_eq!(audit.database_sha256.as_str().len(), 64);
    }

    #[tokio::test]
    async fn discovery_builds_domain_candidate_with_millimetre_accuracy() {
        let fixture = Fixture::new();
        let result = fixture
            .runtime
            .discover_operations(
                &OperationQuery {
                    source: crs(4326),
                    target: crs(25832),
                    area_of_interest: project_area(),
                    selection_policy: OperationSelectionPolicy::default(),
                    grid_catalog: vec![],
                },
                &CancellationToken::new(),
            )
            .await
            .expect("discovery");
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].expected_accuracy_mm, Some(10.0));
        assert!(result.candidates[0].best_available);
        assert!(result.candidates[0].operation_id.starts_with("proj:"));
    }

    #[tokio::test]
    async fn transformation_is_streamed_without_shell_or_temp_file() {
        let fixture = Fixture::new();
        let input = b"1 2 3 4\n5 6 7 8\n".as_slice();
        let mut output = Vec::new();
        let summary = fixture
            .runtime
            .transform_stream(
                &Fixture::frozen(),
                input,
                &mut output,
                &CancellationToken::new(),
            )
            .await
            .expect("transform");
        assert_eq!(output, input);
        assert_eq!(summary.input_bytes, input.len() as u64);
        assert_eq!(summary.output_bytes, input.len() as u64);
    }

    #[tokio::test]
    async fn registered_grid_is_canonicalized_and_hash_verified() {
        let fixture = Fixture::new();
        let grid_path = fixture.root.join("fixture.gsb");
        fs::write(&grid_path, b"audited-grid").expect("grid");
        let grid = fixture
            .runtime
            .catalog_grid(
                &GridCatalogEntry {
                    kind: TransformationGridKind::Ntv2,
                    official_filename: "fixture.gsb".into(),
                    official_sha256: Some(ObjectHash::of_bytes(b"audited-grid")),
                    license: GridLicenseMetadata {
                        license_name: "Fixture".into(),
                        spdx_expression: None,
                        source: "fixture".into(),
                        redistribution_allowed: false,
                    },
                    coverage: project_area(),
                    local_path: Some(path_text(&grid_path)),
                },
                &CancellationToken::new(),
            )
            .await
            .expect("verified grid");
        assert!(matches!(
            grid.availability,
            RequiredGridAvailability::PresentVerified { .. }
        ));
        let bundled = fixture
            .runtime
            .catalog_grid(
                &GridCatalogEntry {
                    kind: TransformationGridKind::Ntv2,
                    official_filename: "fixture.gsb".into(),
                    official_sha256: Some(ObjectHash::of_bytes(b"audited-grid")),
                    license: GridLicenseMetadata {
                        license_name: "Fixture".into(),
                        spdx_expression: None,
                        source: "fixture".into(),
                        redistribution_allowed: false,
                    },
                    coverage: project_area(),
                    local_path: None,
                },
                &CancellationToken::new(),
            )
            .await
            .expect("bundled grid");
        assert!(matches!(
            bundled.availability,
            RequiredGridAvailability::PresentVerified { .. }
        ));
    }

    #[tokio::test]
    async fn explicit_local_grid_can_override_a_different_proj_database_filename() {
        let fixture = Fixture::new();
        let grid_path = fixture.root.join("survey-grid.gsb");
        fs::write(&grid_path, b"survey-grid").expect("grid");
        let stdout = r#"Operation No. 1:
PROJ string:
+proj=pipeline +step +proj=hgridshift +grids=database-name.gsb
PROJJSON:
{"type":"Transformation","name":"Grid fixture","accuracy":"0.01","bbox":{"south_latitude":47.0,"west_longitude":5.0,"north_latitude":56.0,"east_longitude":16.0}}
"#;
        let query = OperationQuery {
            source: crs(4326),
            target: crs(25832),
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![GridCatalogEntry {
                kind: TransformationGridKind::Ntv2,
                official_filename: "original-user-name.gsb".into(),
                official_sha256: Some(ObjectHash::of_bytes(b"survey-grid")),
                license: GridLicenseMetadata {
                    license_name: "User supplied".into(),
                    spdx_expression: None,
                    source: "local selection".into(),
                    redistribution_allowed: false,
                },
                coverage: project_area(),
                local_path: Some(path_text(&grid_path)),
            }],
        };

        let (candidates, warnings) = fixture
            .runtime
            .parse_candidates(stdout, &query, &CancellationToken::new())
            .await
            .expect("candidate");

        assert_eq!(candidates.len(), 1);
        assert!(candidates[0]
            .proj_pipeline
            .contains("+grids=survey-grid.gsb"));
        assert_eq!(
            candidates[0].required_grids[0].official_filename,
            "survey-grid.gsb"
        );
        assert_eq!(candidates[0].expected_accuracy_mm, None);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("Explicit local grid override")));
    }

    #[tokio::test]
    async fn explicit_survey_grids_build_a_non_ballpark_dhdn_compound_pipeline() {
        let fixture = Fixture::new();
        let horizontal_path = fixture.root.join("schwaben.gsb");
        let vertical_path = fixture.root.join("gcg2016-su.tif");
        let horizontal_bytes = b"SYSTEM_FDHDN90  SYSTEM_TETRS89  horizontal-grid";
        fs::write(&horizontal_path, horizontal_bytes).expect("horizontal grid");
        fs::write(&vertical_path, b"vertical-grid").expect("vertical grid");
        let license = GridLicenseMetadata {
            license_name: "User supplied".into(),
            spdx_expression: None,
            source: "local selection".into(),
            redistribution_allowed: false,
        };
        let query = OperationQuery {
            source: crs(4979),
            target: CrsWithEpoch {
                crs: CrsDefinition::Authority("EPSG:31468+7837".into()),
                coordinate_epoch: None,
            },
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![
                GridCatalogEntry {
                    kind: TransformationGridKind::Ntv2,
                    official_filename: "kanu_ntv2_schwaben.gsb".into(),
                    official_sha256: Some(ObjectHash::of_bytes(horizontal_bytes)),
                    license: license.clone(),
                    coverage: project_area(),
                    local_path: Some(path_text(&horizontal_path)),
                },
                GridCatalogEntry {
                    kind: TransformationGridKind::Geoid,
                    official_filename: "GCG2016_SU.tif".into(),
                    official_sha256: Some(ObjectHash::of_bytes(b"vertical-grid")),
                    license,
                    coverage: project_area(),
                    local_path: Some(path_text(&vertical_path)),
                },
            ],
        };

        let discovery = fixture
            .runtime
            .discover_operations(&query, &CancellationToken::new())
            .await
            .expect("explicit compound discovery");
        let candidate = &discovery.candidates[0];
        assert!(candidate.best_available);
        assert!(!candidate.ballpark);
        assert_eq!(candidate.expected_accuracy_mm, None);
        assert_eq!(candidate.required_grids.len(), 2);
        assert!(candidate
            .proj_pipeline
            .contains("+inv +proj=vgridshift +grids=gcg2016-su.tif +multiplier=1"));
        assert!(candidate
            .proj_pipeline
            .contains("+inv +proj=hgridshift +grids=schwaben.gsb"));
        assert!(candidate
            .proj_pipeline
            .contains("+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000"));
    }

    #[tokio::test]
    async fn dhhn2016_to_ellipsoidal_height_uses_frozen_golden_geoid() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let grid = workspace.join("photolab/01_Transformation/Geoide/DHHN 2016/GCG2016_SU.tif");
        if !grid.is_file()
            || !Path::new("/usr/bin/projinfo").is_file()
            || !Path::new("/usr/bin/cct").is_file()
            || !Path::new("/usr/share/proj/proj.db").is_file()
        {
            return;
        }
        let grid_root = grid.parent().expect("geoid parent").to_path_buf();
        let mut config =
            ProjToolchainConfig::system("/usr/bin/projinfo", "/usr/bin/cct", "/usr/share/proj");
        config.allowed_grid_roots.push(grid_root);
        let runtime = ProjRuntime::open(config).expect("system PROJ runtime");
        let area = GeographicArea {
            west_longitude: 11.49,
            south_latitude: 47.99,
            east_longitude: 11.51,
            north_latitude: 48.01,
        };
        let query = OperationQuery {
            source: CrsWithEpoch {
                crs: CrsDefinition::Authority("EPSG:25832+7837".into()),
                coordinate_epoch: None,
            },
            target: crs(25832),
            area_of_interest: area,
            selection_policy: OperationSelectionPolicy {
                allow_ballpark: false,
                only_best: false,
            },
            grid_catalog: vec![GridCatalogEntry {
                kind: TransformationGridKind::Geoid,
                official_filename: "GCG2016_SU.tif".into(),
                official_sha256: Some(ObjectHash(
                    "3898a1d1ef673012dffd3ed2d311707403ceab236b372f86d3ab7515caa2af9d".into(),
                )),
                license: GridLicenseMetadata {
                    license_name: "Golden survey fixture".into(),
                    spdx_expression: None,
                    source: "photolab/01_Transformation/Geoide".into(),
                    redistribution_allowed: false,
                },
                coverage: GeographicArea {
                    west_longitude: 7.45,
                    south_latitude: 47.216_666_6,
                    east_longitude: 13.925,
                    north_latitude: 50.616_666_7,
                },
                local_path: Some(path_text(&grid)),
            }],
        };
        let discovery = runtime
            .discover_operations(&query, &CancellationToken::new())
            .await
            .expect("height operation discovery");
        let operation = discovery
            .candidates
            .iter()
            .find(|candidate| candidate.proj_pipeline.contains("+proj=vgridshift"))
            .expect("explicit vertical operation")
            .clone();
        let frozen = ImportTransformationDecision {
            schema_version: 1,
            contains_gps_data: false,
            horizontal: HorizontalCrsSelection {
                source: query.source.clone(),
                target: query.target.clone(),
            },
            vertical: Some(VerticalCrsSelection {
                source: HeightReference::NormalHeight {
                    vertical_crs: CrsDefinition::Epsg(7837),
                },
                target: HeightReference::Ellipsoidal,
                mode: VerticalOperationMode::Transform,
            }),
            area_of_interest: area,
            operation,
            selection_policy: query.selection_policy,
            ballpark_confirmation: None,
            database_versions: discovery.audit.versions,
        }
        .validate_and_freeze()
        .expect("freeze height decision");
        let mut input = "686482.635 5319324.564 454.053825 0\n".as_bytes();
        let mut output = Vec::new();
        runtime
            .transform_stream(&frozen, &mut input, &mut output, &CancellationToken::new())
            .await
            .expect("frozen height transform");
        let values = probe_values(std::str::from_utf8(&output).expect("UTF-8 output"))
            .expect("transformed coordinate");
        assert!((values[0] - 686_482.635).abs() < 1e-6);
        assert!((values[1] - 5_319_324.564).abs() < 1e-6);
        assert!(
            (values[2] - 500.698_500_255).abs() < 1e-6,
            "expected ellipsoidal height 500.698500255, got {}",
            values[2]
        );
    }

    /// Regression: UI/GDAL often labels classic .gsb as GTG; freeze used to reject
    /// `kanu_ntv2_schwaben.gsb` as "unaudited horizontal GeoTIFF".
    #[tokio::test]
    async fn gsb_mislabeled_as_gtg_is_accepted_for_explicit_dhdn() {
        let fixture = Fixture::new();
        let horizontal_path = fixture.root.join("kanu_ntv2_schwaben.gsb");
        // Minimal body without SYSTEM tags — local .gsb path must still be accepted.
        let horizontal_bytes = b"NTv2 regional schwaben grid without tags";
        fs::write(&horizontal_path, horizontal_bytes).expect("horizontal grid");
        let license = GridLicenseMetadata {
            license_name: "User supplied".into(),
            spdx_expression: None,
            source: "local selection".into(),
            redistribution_allowed: false,
        };
        let query = OperationQuery {
            source: crs(4326),
            target: crs(31468),
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![GridCatalogEntry {
                kind: TransformationGridKind::Gtg, // mislabeled
                official_filename: "kanu_ntv2_schwaben.gsb".into(),
                // No official hash pin (user file).
                official_sha256: None,
                license,
                coverage: project_area(),
                local_path: Some(path_text(&horizontal_path)),
            }],
        };

        let discovery = fixture
            .runtime
            .discover_operations(&query, &CancellationToken::new())
            .await
            .expect("mislabeled gsb discovery");
        assert!(
            !discovery.candidates.is_empty(),
            "expected explicit DHDN candidate for user .gsb"
        );
        let horizontal = discovery.candidates[0]
            .required_grids
            .iter()
            .find(|g| {
                matches!(
                    g.kind,
                    TransformationGridKind::Ntv2 | TransformationGridKind::Gtg
                )
            })
            .expect("horizontal grid");
        assert!(matches!(
            horizontal.availability,
            RequiredGridAvailability::PresentVerified { .. }
        ));
    }

    #[tokio::test]
    async fn user_local_gtg_with_path_is_accepted_for_explicit_dhdn() {
        let fixture = Fixture::new();
        let horizontal_path = fixture.root.join("regional.tif");
        fs::write(&horizontal_path, b"user-geo-tiff").expect("grid");
        let license = GridLicenseMetadata {
            license_name: "User supplied".into(),
            spdx_expression: None,
            source: "local selection".into(),
            redistribution_allowed: false,
        };
        let query = OperationQuery {
            source: crs(4326),
            target: crs(31468),
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![GridCatalogEntry {
                kind: TransformationGridKind::Gtg,
                official_filename: "regional.tif".into(),
                official_sha256: None,
                license,
                coverage: project_area(),
                local_path: Some(path_text(&horizontal_path)),
            }],
        };
        let discovery = fixture
            .runtime
            .discover_operations(&query, &CancellationToken::new())
            .await
            .expect("user gtg discovery");
        assert!(!discovery.candidates.is_empty());
    }

    #[tokio::test]
    async fn preserved_2d_height_never_adds_a_selected_vertical_grid() {
        let fixture = Fixture::new();
        let horizontal_path = fixture.root.join("schwaben.gsb");
        let vertical_path = fixture.root.join("geoid.tif");
        let horizontal_bytes = b"SYSTEM_FDHDN90  SYSTEM_TETRS89  horizontal-grid";
        fs::write(&horizontal_path, horizontal_bytes).expect("horizontal grid");
        fs::write(&vertical_path, b"vertical-grid").expect("vertical grid");
        let license = GridLicenseMetadata {
            license_name: "User supplied".into(),
            spdx_expression: None,
            source: "local selection".into(),
            redistribution_allowed: false,
        };
        let query = OperationQuery {
            source: crs(4326),
            target: crs(31468),
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![
                GridCatalogEntry {
                    kind: TransformationGridKind::Ntv2,
                    official_filename: "schwaben.gsb".into(),
                    official_sha256: Some(ObjectHash::of_bytes(horizontal_bytes)),
                    license: license.clone(),
                    coverage: project_area(),
                    local_path: Some(path_text(&horizontal_path)),
                },
                GridCatalogEntry {
                    kind: TransformationGridKind::Geoid,
                    official_filename: "geoid.tif".into(),
                    official_sha256: Some(ObjectHash::of_bytes(b"vertical-grid")),
                    license,
                    coverage: project_area(),
                    local_path: Some(path_text(&vertical_path)),
                },
            ],
        };

        let discovery = fixture
            .runtime
            .discover_operations(&query, &CancellationToken::new())
            .await
            .expect("discovery");
        assert!(discovery
            .candidates
            .iter()
            .all(|candidate| !candidate.proj_pipeline.contains("vgridshift")));
    }

    #[tokio::test]
    async fn unrelated_ntv2_header_is_rejected_for_dhdn_inverse_pipeline() {
        let fixture = Fixture::new();
        let horizontal_path = fixture.root.join("unrelated.gsb");
        fs::write(&horizontal_path, b"SYSTEM_FOTHER   SYSTEM_TUNRELATED").expect("grid");
        let query = OperationQuery {
            source: crs(4326),
            target: crs(31468),
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![GridCatalogEntry {
                kind: TransformationGridKind::Ntv2,
                official_filename: "unrelated.gsb".into(),
                official_sha256: Some(ObjectHash::of_bytes(b"SYSTEM_FOTHER   SYSTEM_TUNRELATED")),
                license: GridLicenseMetadata {
                    license_name: "User supplied".into(),
                    spdx_expression: None,
                    source: "local selection".into(),
                    redistribution_allowed: false,
                },
                coverage: project_area(),
                local_path: Some(path_text(&horizontal_path)),
            }],
        };

        let error = fixture
            .runtime
            .discover_operations(&query, &CancellationToken::new())
            .await
            .expect_err("unrelated grid must fail");
        assert!(matches!(error, CrsRuntimeError::IncompatibleGrid { .. }));
    }

    #[tokio::test]
    async fn identical_gauss_krueger_crs_does_not_require_a_datum_grid() {
        let fixture = Fixture::new();
        let stdout = r#"Operation No. 1:
PROJ string:
+proj=noop
PROJJSON:
{"type":"Conversion","name":"DHDN / Gauss-Kruger zone 4 identity","accuracy":"0","bbox":{"south_latitude":47.0,"west_longitude":5.0,"north_latitude":56.0,"east_longitude":16.0}}
"#;
        let query = OperationQuery {
            source: crs(31468),
            target: crs(31468),
            area_of_interest: project_area(),
            selection_policy: OperationSelectionPolicy::default(),
            grid_catalog: vec![],
        };

        let (candidates, _) = fixture
            .runtime
            .parse_candidates(stdout, &query, &CancellationToken::new())
            .await
            .expect("identity candidate");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].kind, CoordinateOperationKind::General);
        assert!(candidates[0].required_grids.is_empty());
    }

    #[tokio::test]
    async fn grid_outside_explicit_roots_is_rejected() {
        let fixture = Fixture::new();
        let outside = fixture.root.with_extension("outside.gsb");
        fs::write(&outside, b"outside-grid").expect("outside grid");
        let error = fixture
            .runtime
            .catalog_grid(
                &GridCatalogEntry {
                    kind: TransformationGridKind::Ntv2,
                    official_filename: outside
                        .file_name()
                        .expect("filename")
                        .to_string_lossy()
                        .into_owned(),
                    official_sha256: Some(ObjectHash::of_bytes(b"outside-grid")),
                    license: GridLicenseMetadata {
                        license_name: "Fixture".into(),
                        spdx_expression: None,
                        source: "fixture".into(),
                        redistribution_allowed: false,
                    },
                    coverage: project_area(),
                    local_path: Some(path_text(&outside)),
                },
                &CancellationToken::new(),
            )
            .await
            .expect_err("outside root");
        let _ = fs::remove_file(outside);
        assert!(matches!(
            error,
            CrsRuntimeError::GridOutsideAllowedRoots { .. }
        ));
    }

    #[tokio::test]
    async fn hostile_pipeline_cannot_become_a_cct_file_argument() {
        let fixture = Fixture::new();
        let mut frozen = Fixture::frozen();
        frozen.pipeline.proj_pipeline = "+proj=pipeline /tmp/input".into();
        let error = fixture
            .runtime
            .transform_stream(
                &frozen,
                b"1 2 3 4\n".as_slice(),
                Vec::new(),
                &CancellationToken::new(),
            )
            .await
            .expect_err("pipeline must be rejected");
        assert!(matches!(
            error,
            CrsRuntimeError::InvalidRequest("projPipeline")
        ));
    }

    #[tokio::test]
    async fn pre_requested_cancellation_prevents_discovery() {
        let fixture = Fixture::new();
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let error = fixture
            .runtime
            .discover_operations(
                &OperationQuery {
                    source: crs(4326),
                    target: crs(25832),
                    area_of_interest: project_area(),
                    selection_policy: OperationSelectionPolicy::default(),
                    grid_catalog: vec![],
                },
                &cancellation,
            )
            .await
            .expect_err("cancelled");
        assert!(matches!(error, CrsRuntimeError::Cancelled));
    }
}
