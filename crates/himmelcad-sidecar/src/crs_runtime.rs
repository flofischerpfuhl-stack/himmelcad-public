//! Offline PROJ process isolation, operation discovery and streamed coordinate transformation.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_crs::{
    CoordinateOperationKind, CrsDatabaseVersions, CrsDefinition, CrsWithEpoch,
    FrozenImportTransformation, GeographicArea, GridLicenseMetadata, OperationCandidate,
    OperationSelectionPolicy, RequiredGridAvailability, RequiredTransformationGrid,
    TransformationGridKind,
};
use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;

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
    pub official_sha256: ObjectHash,
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
}

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
        })
    }

    /// Records executable version plus EPSG database version, date, path and content hash.
    pub async fn audit(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<ProjAudit, CrsRuntimeError> {
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
            database_evidence(self.config.database_path.clone(), cancellation.clone()).await?;
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
        let (candidates, warnings) = self
            .parse_candidates(&captured.stdout, query, cancellation)
            .await?;
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
            if path.file_name() != Some(OsStr::new(&grid.official_filename))
                || !self.is_allowed_grid(&path)
            {
                return Err(CrsRuntimeError::GridOutsideAllowedRoots {
                    filename: grid.official_filename.clone(),
                });
            }
            if hash_file_async(path, cancellation.clone()).await? != grid.official_sha256 {
                return Err(CrsRuntimeError::GridHashMismatch {
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
        let selected = discovery.candidates.iter().any(|candidate| {
            candidate.operation_id == frozen.pipeline.operation_id
                && candidate.proj_pipeline == frozen.pipeline.proj_pipeline
                && candidate.name == frozen.pipeline.operation_name
        });
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
        let mut child = self
            .command(&self.config.cct_path, args)
            .spawn()
            .map_err(CrsRuntimeError::Spawn)?;
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
                let _ = child.kill().await;
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
            let name = json
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| CrsRuntimeError::MalformedOutput("candidate has no name".into()))?
                .to_owned();
            let grid_names = pipeline_grid_names(pipeline);
            let mut required_grids = Vec::with_capacity(grid_names.len());
            for filename in grid_names {
                let Some(entry) = catalog.get(filename.as_str()) else {
                    warnings.push(format!(
                        "Operation '{name}' requires the unregistered grid '{filename}'."
                    ));
                    continue;
                };
                required_grids.push(self.catalog_grid(entry, cancellation).await?);
            }
            if required_grids.len() != pipeline_grid_names(pipeline).len() {
                continue;
            }
            let accuracy_m = json
                .get("accuracy")
                .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()));
            let ballpark = name.to_ascii_lowercase().contains("ballpark");
            let kind = if name.to_ascii_lowercase().contains("gauss-kruger")
                || name.to_ascii_lowercase().contains("gauss-krüger")
            {
                CoordinateOperationKind::GaussKruegerDatumTransformation
            } else {
                CoordinateOperationKind::General
            };
            let operation_id = format!(
                "proj:{}",
                ObjectHash::of_bytes(format!("{pipeline}\n{json_text}").as_bytes()).as_str()
            );
            candidates.push(OperationCandidate {
                operation_id,
                name,
                kind,
                proj_pipeline: pipeline.to_owned(),
                area_of_use,
                expected_accuracy_mm: accuracy_m.map(|value| value * 1000.0),
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
            if path.file_name() != Some(OsStr::new(&entry.official_filename))
                || !self.is_allowed_grid(&path)
            {
                return Err(CrsRuntimeError::GridOutsideAllowedRoots {
                    filename: entry.official_filename.clone(),
                });
            }
            let observed_sha256 = hash_file_async(path.clone(), cancellation.clone()).await?;
            if observed_sha256 != entry.official_sha256 {
                return Err(CrsRuntimeError::GridHashMismatch {
                    filename: entry.official_filename.clone(),
                });
            }
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
                let _ = child.kill().await;
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
        command
    }

    fn proj_search_path(&self) -> OsString {
        std::env::join_paths(&self.config.allowed_grid_roots)
            .unwrap_or_else(|_| self.config.data_directory.as_os_str().to_owned())
    }
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
                    official_sha256: ObjectHash::of_bytes(b"audited-grid"),
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
                    official_sha256: ObjectHash::of_bytes(b"audited-grid"),
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
                    official_sha256: ObjectHash::of_bytes(b"outside-grid"),
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
