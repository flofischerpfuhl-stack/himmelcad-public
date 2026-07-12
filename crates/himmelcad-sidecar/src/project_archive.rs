//! Streaming and defensive `.hcadx` project archives.

use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use himmelcad_core::{
    photolab_jobs::CancellationToken,
    photolab_project::{PhotolabProjectManifest, PHOTOLAB_PROJECT_FORMAT_VERSION},
};
use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, CompressionMethod, DateTime, ZipArchive, ZipWriter};

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Export choices that do not affect canonical project data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackArchiveOptions {
    #[serde(default)]
    pub include_rebuildable_index: bool,
}

/// Defensive limits applied before extraction starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpackArchiveLimits {
    pub max_entries: u64,
    pub max_declared_bytes: u64,
}

/// Operation currently represented by a progress update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchivePhase {
    Scanning,
    Packing,
    Validating,
    Extracting,
    Committing,
}

/// Exact archive progress. Byte counters describe uncompressed payload bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgress {
    pub phase: ArchivePhase,
    pub files_completed: u64,
    pub files_total: u64,
    pub bytes_completed: u64,
    pub bytes_total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_path: Option<String>,
}

/// Successful archive operation statistics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSummary {
    pub files: u64,
    pub bytes: u64,
    pub path: String,
}

#[derive(Debug)]
struct SourceEntry {
    source: PathBuf,
    relative: String,
    size: u64,
}

#[derive(Debug)]
struct ArchiveEntry {
    relative: String,
    size: u64,
    is_dir: bool,
}

/// Packs a project using a core cancellation token.
pub fn pack_hcadx<P>(
    project_root: &Path,
    destination: &Path,
    options: PackArchiveOptions,
    cancellation: &CancellationToken,
    progress: P,
) -> Result<ArchiveSummary, ProjectArchiveError>
where
    P: FnMut(ArchiveProgress),
{
    pack_hcadx_with_cancel(
        project_root,
        destination,
        options,
        || cancellation.is_cancel_requested(),
        progress,
    )
}

/// Packs with a callback checked during scanning and every `io::copy` read.
// INVARIANT: one scope owns the temporary archive guard through atomic publication.
#[allow(clippy::too_many_lines)]
pub fn pack_hcadx_with_cancel<C, P>(
    project_root: &Path,
    destination: &Path,
    options: PackArchiveOptions,
    mut is_cancelled: C,
    mut progress: P,
) -> Result<ArchiveSummary, ProjectArchiveError>
where
    C: FnMut() -> bool,
    P: FnMut(ArchiveProgress),
{
    check_cancelled(&mut is_cancelled)?;
    if !project_root.is_dir() {
        return Err(ProjectArchiveError::ProjectRootNotDirectory(
            project_root.to_path_buf(),
        ));
    }
    ensure_new_destination(destination)?;
    let mut entries = Vec::new();
    collect_sources(
        project_root,
        project_root,
        options,
        &mut entries,
        &mut is_cancelled,
    )?;
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    let total_bytes = entries.iter().try_fold(0_u64, |sum, entry| {
        sum.checked_add(entry.size)
            .ok_or(ProjectArchiveError::SizeOverflow)
    })?;
    let total_files =
        u64::try_from(entries.len()).map_err(|_| ProjectArchiveError::SizeOverflow)?;
    emit(
        &mut progress,
        ArchivePhase::Scanning,
        0,
        total_files,
        0,
        total_bytes,
        None,
    );

    let temporary = temporary_sibling(destination, "archive-tmp")?;
    let mut cleanup = CleanupPath::file(temporary.clone());
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| io_error("create temporary archive", &temporary, error))?;
    let writer = BufWriter::new(output);
    let mut archive = ZipWriter::new(writer);
    let file_options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true)
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644);
    let mut bytes_completed = 0_u64;
    let mut files_completed = 0_u64;
    for entry in &entries {
        check_cancelled(&mut is_cancelled)?;
        archive.start_file(&entry.relative, file_options)?;
        let input = File::open(&entry.source)
            .map_err(|error| io_error("open project file", &entry.source, error))?;
        let mut monitored = MonitoredReader::new(
            BufReader::new(input),
            &mut is_cancelled,
            &mut progress,
            ArchivePhase::Packing,
            files_completed,
            total_files,
            &mut bytes_completed,
            total_bytes,
            &entry.relative,
        );
        let copied = io::copy(&mut monitored, &mut archive);
        if monitored.cancelled {
            return Err(ProjectArchiveError::Cancelled);
        }
        let copied = copied.map_err(|error| io_error("copy project file", &entry.source, error))?;
        if copied != entry.size {
            return Err(ProjectArchiveError::SourceChanged {
                path: entry.source.clone(),
                expected: entry.size,
                copied,
            });
        }
        files_completed += 1;
        emit(
            &mut progress,
            ArchivePhase::Packing,
            files_completed,
            total_files,
            bytes_completed,
            total_bytes,
            Some(entry.relative.clone()),
        );
    }
    let mut output = archive
        .finish()?
        .into_inner()
        .map_err(|error| io_error("flush temporary archive", &temporary, error.into_error()))?;
    output
        .flush()
        .map_err(|error| io_error("flush temporary archive", &temporary, error))?;
    output
        .sync_all()
        .map_err(|error| io_error("sync temporary archive", &temporary, error))?;
    check_cancelled(&mut is_cancelled)?;
    emit(
        &mut progress,
        ArchivePhase::Committing,
        files_completed,
        total_files,
        bytes_completed,
        total_bytes,
        None,
    );
    fs::rename(&temporary, destination)
        .map_err(|error| io_error("atomically publish archive", destination, error))?;
    cleanup.disarm();
    sync_parent(destination)?;
    Ok(ArchiveSummary {
        files: total_files,
        bytes: total_bytes,
        path: path_string(destination)?,
    })
}

/// Unpacks an archive using a core cancellation token.
pub fn unpack_hcadx<P>(
    archive_path: &Path,
    destination: &Path,
    limits: UnpackArchiveLimits,
    cancellation: &CancellationToken,
    progress: P,
) -> Result<ArchiveSummary, ProjectArchiveError>
where
    P: FnMut(ArchiveProgress),
{
    unpack_hcadx_with_cancel(
        archive_path,
        destination,
        limits,
        || cancellation.is_cancel_requested(),
        progress,
    )
}

/// Validates completely before extracting into a staging directory.
// INVARIANT: one scope owns validated metadata and the staging guard until publication.
#[allow(clippy::too_many_lines)]
pub fn unpack_hcadx_with_cancel<C, P>(
    archive_path: &Path,
    destination: &Path,
    limits: UnpackArchiveLimits,
    mut is_cancelled: C,
    mut progress: P,
) -> Result<ArchiveSummary, ProjectArchiveError>
where
    C: FnMut() -> bool,
    P: FnMut(ArchiveProgress),
{
    check_cancelled(&mut is_cancelled)?;
    ensure_new_destination(destination)?;
    if limits.max_entries == 0 || limits.max_declared_bytes == 0 {
        return Err(ProjectArchiveError::InvalidLimits);
    }
    let input =
        File::open(archive_path).map_err(|error| io_error("open archive", archive_path, error))?;
    let mut archive = ZipArchive::new(BufReader::new(input))?;
    let entry_count =
        u64::try_from(archive.len()).map_err(|_| ProjectArchiveError::SizeOverflow)?;
    if entry_count > limits.max_entries {
        return Err(ProjectArchiveError::EntryLimitExceeded {
            declared: entry_count,
            limit: limits.max_entries,
        });
    }
    let mut entries = Vec::with_capacity(archive.len());
    let mut names = BTreeSet::new();
    let mut total_bytes = 0_u64;
    let mut has_manifest = false;
    for index in 0..archive.len() {
        check_cancelled(&mut is_cancelled)?;
        let file = archive.by_index(index)?;
        let relative = validate_entry_path(&file)?;
        if !names.insert(relative.clone()) {
            return Err(ProjectArchiveError::DuplicateEntry(relative));
        }
        if file.is_symlink() || is_special_file(file.unix_mode()) {
            return Err(ProjectArchiveError::UnsupportedEntryType(relative));
        }
        let is_dir = file.is_dir();
        let size = if is_dir { 0 } else { file.size() };
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or(ProjectArchiveError::SizeOverflow)?;
        if total_bytes > limits.max_declared_bytes {
            return Err(ProjectArchiveError::DeclaredSizeLimitExceeded {
                declared: total_bytes,
                limit: limits.max_declared_bytes,
            });
        }
        has_manifest |= relative == "manifest.json" && !is_dir;
        entries.push(ArchiveEntry {
            relative,
            size,
            is_dir,
        });
    }
    if !has_manifest {
        return Err(ProjectArchiveError::ManifestMissing);
    }
    let declared_files = entries.iter().filter(|entry| !entry.is_dir).count();
    let declared_files =
        u64::try_from(declared_files).map_err(|_| ProjectArchiveError::SizeOverflow)?;
    emit(
        &mut progress,
        ArchivePhase::Validating,
        declared_files,
        declared_files,
        total_bytes,
        total_bytes,
        None,
    );

    let staging = temporary_sibling(destination, "extract-staging")?;
    fs::create_dir(&staging)
        .map_err(|error| io_error("create extraction staging directory", &staging, error))?;
    let mut cleanup = CleanupPath::directory(staging.clone());
    let file_total = entries.iter().filter(|entry| !entry.is_dir).count();
    let file_total = u64::try_from(file_total).map_err(|_| ProjectArchiveError::SizeOverflow)?;
    let mut bytes_completed = 0_u64;
    let mut files_completed = 0_u64;
    for (index, metadata) in entries.iter().enumerate() {
        check_cancelled(&mut is_cancelled)?;
        let output_path = staging.join(&metadata.relative);
        if metadata.is_dir {
            fs::create_dir_all(&output_path)
                .map_err(|error| io_error("create archive directory", &output_path, error))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| io_error("create archive parent", parent, error))?;
        }
        let mut input = archive.by_index(index)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|error| io_error("create extracted file", &output_path, error))?;
        let mut monitored = MonitoredReader::new(
            &mut input,
            &mut is_cancelled,
            &mut progress,
            ArchivePhase::Extracting,
            files_completed,
            file_total,
            &mut bytes_completed,
            total_bytes,
            &metadata.relative,
        );
        let copied = io::copy(&mut monitored, &mut output);
        if monitored.cancelled {
            return Err(ProjectArchiveError::Cancelled);
        }
        let copied =
            copied.map_err(|error| io_error("extract archive file", &output_path, error))?;
        if copied != metadata.size {
            return Err(ProjectArchiveError::EntrySizeMismatch {
                path: metadata.relative.clone(),
                declared: metadata.size,
                copied,
            });
        }
        output
            .sync_all()
            .map_err(|error| io_error("sync extracted file", &output_path, error))?;
        files_completed += 1;
    }
    validate_manifest(&staging)?;
    check_cancelled(&mut is_cancelled)?;
    emit(
        &mut progress,
        ArchivePhase::Committing,
        files_completed,
        file_total,
        bytes_completed,
        total_bytes,
        None,
    );
    fs::rename(&staging, destination)
        .map_err(|error| io_error("atomically publish extracted project", destination, error))?;
    cleanup.disarm();
    sync_parent(destination)?;
    Ok(ArchiveSummary {
        files: file_total,
        bytes: total_bytes,
        path: path_string(destination)?,
    })
}

fn collect_sources<C>(
    root: &Path,
    directory: &Path,
    options: PackArchiveOptions,
    output: &mut Vec<SourceEntry>,
    is_cancelled: &mut C,
) -> Result<(), ProjectArchiveError>
where
    C: FnMut() -> bool,
{
    let mut children = fs::read_dir(directory)
        .map_err(|error| io_error("read project directory", directory, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error("read project directory entry", directory, error))?;
    children.sort_by_key(std::fs::DirEntry::file_name);
    for child in children {
        check_cancelled(is_cancelled)?;
        let path = child.path();
        let relative_path = path
            .strip_prefix(root)
            .map_err(|_| ProjectArchiveError::InvalidSourcePath(path.clone()))?;
        if is_excluded(relative_path, options) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| io_error("inspect project entry", &path, error))?;
        if metadata.file_type().is_symlink() {
            return Err(ProjectArchiveError::UnsupportedSourceType(path));
        }
        if metadata.is_dir() {
            collect_sources(root, &path, options, output, is_cancelled)?;
        } else if metadata.is_file() {
            let relative = relative_utf8(relative_path)?;
            output.push(SourceEntry {
                source: path,
                relative,
                size: metadata.len(),
            });
        } else {
            return Err(ProjectArchiveError::UnsupportedSourceType(path));
        }
    }
    Ok(())
}

fn is_excluded(relative: &Path, options: PackArchiveOptions) -> bool {
    let first = relative.components().next();
    matches!(first, Some(Component::Normal(name)) if name == "tmp")
        || matches!(first, Some(Component::Normal(name)) if name == "project.lock")
        || (!options.include_rebuildable_index
            && matches!(first, Some(Component::Normal(name)) if name == "index"))
}

fn relative_utf8(path: &Path) -> Result<String, ProjectArchiveError> {
    let mut components = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(ProjectArchiveError::InvalidSourcePath(path.to_path_buf()));
        };
        components.push(
            component
                .to_str()
                .ok_or_else(|| ProjectArchiveError::NonUtf8Path(path.to_path_buf()))?,
        );
    }
    if components.is_empty() {
        return Err(ProjectArchiveError::InvalidSourcePath(path.to_path_buf()));
    }
    if components
        .iter()
        .any(|component| component.contains(['\\', ':']))
    {
        return Err(ProjectArchiveError::InvalidSourcePath(path.to_path_buf()));
    }
    Ok(components.join("/"))
}

fn validate_entry_path<R: Read>(
    file: &zip::read::ZipFile<'_, R>,
) -> Result<String, ProjectArchiveError> {
    let raw =
        std::str::from_utf8(file.name_raw()).map_err(|_| ProjectArchiveError::NonUtf8Entry)?;
    if raw.is_empty()
        || raw.starts_with('/')
        || raw.starts_with('\\')
        || raw.contains('\\')
        || raw.contains(':')
    {
        return Err(ProjectArchiveError::UnsafeEntryPath(raw.into()));
    }
    let trimmed = raw.strip_suffix('/').unwrap_or(raw);
    if trimmed.is_empty()
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || file.enclosed_name().is_none()
    {
        return Err(ProjectArchiveError::UnsafeEntryPath(raw.into()));
    }
    Ok(trimmed.into())
}

fn is_special_file(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| {
        let kind = mode & 0o170_000;
        kind != 0 && kind != 0o040_000 && kind != 0o100_000
    })
}

fn validate_manifest(staging: &Path) -> Result<(), ProjectArchiveError> {
    let path = staging.join("manifest.json");
    let file = File::open(&path).map_err(|error| io_error("open manifest", &path, error))?;
    let manifest: PhotolabProjectManifest = serde_json::from_reader(BufReader::new(file))
        .map_err(ProjectArchiveError::InvalidManifest)?;
    if manifest.format_version != PHOTOLAB_PROJECT_FORMAT_VERSION {
        return Err(ProjectArchiveError::UnsupportedFormatVersion {
            found: manifest.format_version,
            supported: PHOTOLAB_PROJECT_FORMAT_VERSION,
        });
    }
    Ok(())
}

struct MonitoredReader<'a, R, C, P> {
    inner: R,
    is_cancelled: &'a mut C,
    progress: &'a mut P,
    phase: ArchivePhase,
    files_completed: u64,
    files_total: u64,
    bytes_completed: &'a mut u64,
    bytes_total: u64,
    path: &'a str,
    cancelled: bool,
}

impl<'a, R, C, P> MonitoredReader<'a, R, C, P> {
    #[allow(clippy::too_many_arguments)]
    fn new(
        inner: R,
        is_cancelled: &'a mut C,
        progress: &'a mut P,
        phase: ArchivePhase,
        files_completed: u64,
        files_total: u64,
        bytes_completed: &'a mut u64,
        bytes_total: u64,
        path: &'a str,
    ) -> Self {
        Self {
            inner,
            is_cancelled,
            progress,
            phase,
            files_completed,
            files_total,
            bytes_completed,
            bytes_total,
            path,
            cancelled: false,
        }
    }
}

impl<R: Read, C: FnMut() -> bool, P: FnMut(ArchiveProgress)> Read for MonitoredReader<'_, R, C, P> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if (self.is_cancelled)() {
            self.cancelled = true;
            // `io::copy` retries `Interrupted`; a private flag preserves the typed cause.
            return Err(io::Error::other("archive cancelled"));
        }
        let read = self.inner.read(buffer)?;
        *self.bytes_completed = self
            .bytes_completed
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or_else(|| io::Error::other("archive byte counter overflow"))?;
        emit(
            self.progress,
            self.phase,
            self.files_completed,
            self.files_total,
            *self.bytes_completed,
            self.bytes_total,
            Some(self.path.into()),
        );
        Ok(read)
    }
}

fn emit<P: FnMut(ArchiveProgress)>(
    progress: &mut P,
    phase: ArchivePhase,
    files_completed: u64,
    files_total: u64,
    bytes_completed: u64,
    bytes_total: u64,
    current_path: Option<String>,
) {
    progress(ArchiveProgress {
        phase,
        files_completed,
        files_total,
        bytes_completed,
        bytes_total,
        current_path,
    });
}

fn check_cancelled<C: FnMut() -> bool>(is_cancelled: &mut C) -> Result<(), ProjectArchiveError> {
    if is_cancelled() {
        Err(ProjectArchiveError::Cancelled)
    } else {
        Ok(())
    }
}

fn ensure_new_destination(path: &Path) -> Result<(), ProjectArchiveError> {
    if path.exists() {
        return Err(ProjectArchiveError::DestinationExists(path.to_path_buf()));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| ProjectArchiveError::MissingParent(path.to_path_buf()))?;
    if !parent.is_dir() {
        return Err(ProjectArchiveError::MissingParent(parent.to_path_buf()));
    }
    Ok(())
}

fn temporary_sibling(destination: &Path, marker: &str) -> Result<PathBuf, ProjectArchiveError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ProjectArchiveError::MissingParent(destination.to_path_buf()))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ProjectArchiveError::NonUtf8Path(destination.to_path_buf()))?;
    let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{name}.{marker}-{}-{sequence}",
        std::process::id()
    )))
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), ProjectArchiveError> {
    let parent = path
        .parent()
        .ok_or_else(|| ProjectArchiveError::MissingParent(path.to_path_buf()))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("sync destination directory", parent, error))
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<(), ProjectArchiveError> {
    Ok(())
}

fn path_string(path: &Path) -> Result<String, ProjectArchiveError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| ProjectArchiveError::NonUtf8Path(path.to_path_buf()))
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> ProjectArchiveError {
    ProjectArchiveError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

enum CleanupKind {
    File,
    Directory,
}

struct CleanupPath {
    path: PathBuf,
    kind: CleanupKind,
    armed: bool,
}

impl CleanupPath {
    fn file(path: PathBuf) -> Self {
        Self {
            path,
            kind: CleanupKind::File,
            armed: true,
        }
    }

    fn directory(path: PathBuf) -> Self {
        Self {
            path,
            kind: CleanupKind::Directory,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupPath {
    fn drop(&mut self) {
        if self.armed {
            let _ = match self.kind {
                CleanupKind::File => fs::remove_file(&self.path),
                CleanupKind::Directory => fs::remove_dir_all(&self.path),
            };
        }
    }
}

/// Archive validation, I/O and safety failures.
#[derive(Debug)]
pub enum ProjectArchiveError {
    Cancelled,
    ProjectRootNotDirectory(PathBuf),
    DestinationExists(PathBuf),
    MissingParent(PathBuf),
    NonUtf8Path(PathBuf),
    InvalidSourcePath(PathBuf),
    UnsupportedSourceType(PathBuf),
    NonUtf8Entry,
    UnsafeEntryPath(String),
    DuplicateEntry(String),
    UnsupportedEntryType(String),
    InvalidLimits,
    EntryLimitExceeded {
        declared: u64,
        limit: u64,
    },
    DeclaredSizeLimitExceeded {
        declared: u64,
        limit: u64,
    },
    ManifestMissing,
    InvalidManifest(serde_json::Error),
    UnsupportedFormatVersion {
        found: u32,
        supported: u32,
    },
    SourceChanged {
        path: PathBuf,
        expected: u64,
        copied: u64,
    },
    EntrySizeMismatch {
        path: String,
        declared: u64,
        copied: u64,
    },
    SizeOverflow,
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Zip(zip::result::ZipError),
}

impl From<zip::result::ZipError> for ProjectArchiveError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Zip(error)
    }
}

impl std::fmt::Display for ProjectArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("archive operation cancelled"),
            Self::ProjectRootNotDirectory(p) => {
                write!(f, "project root is not a directory: {}", p.display())
            }
            Self::DestinationExists(p) => write!(f, "destination already exists: {}", p.display()),
            Self::MissingParent(p) => write!(f, "destination parent is missing: {}", p.display()),
            Self::NonUtf8Path(p) => write!(f, "path is not valid UTF-8: {}", p.display()),
            Self::InvalidSourcePath(p) => {
                write!(f, "invalid relative source path: {}", p.display())
            }
            Self::UnsupportedSourceType(p) => {
                write!(f, "unsupported source entry type: {}", p.display())
            }
            Self::NonUtf8Entry => f.write_str("archive entry path is not valid UTF-8"),
            Self::UnsafeEntryPath(p) => write!(f, "unsafe archive entry path: {p}"),
            Self::DuplicateEntry(p) => write!(f, "duplicate archive entry: {p}"),
            Self::UnsupportedEntryType(p) => {
                write!(f, "archive entry is a symlink or special file: {p}")
            }
            Self::InvalidLimits => f.write_str("archive limits must be greater than zero"),
            Self::EntryLimitExceeded { declared, limit } => {
                write!(f, "archive declares {declared} entries, limit is {limit}")
            }
            Self::DeclaredSizeLimitExceeded { declared, limit } => {
                write!(f, "archive declares {declared} bytes, limit is {limit}")
            }
            Self::ManifestMissing => f.write_str("archive does not contain manifest.json"),
            Self::InvalidManifest(e) => write!(f, "invalid manifest.json: {e}"),
            Self::UnsupportedFormatVersion { found, supported } => write!(
                f,
                "unsupported formatVersion {found}; supported is {supported}"
            ),
            Self::SourceChanged {
                path,
                expected,
                copied,
            } => write!(
                f,
                "source changed while packing {}: expected {expected}, copied {copied}",
                path.display()
            ),
            Self::EntrySizeMismatch {
                path,
                declared,
                copied,
            } => write!(
                f,
                "entry {path} declared {declared} bytes but produced {copied}"
            ),
            Self::SizeOverflow => f.write_str("archive size counter overflow"),
            Self::Io {
                operation,
                path,
                source,
            } => write!(f, "{operation} {}: {source}", path.display()),
            Self::Zip(e) => write!(f, "invalid ZIP archive: {e}"),
        }
    }
}

impl std::error::Error for ProjectArchiveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidManifest(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            Self::Zip(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::photolab_project::initial_photolab_manifest;
    fn temp(name: &str) -> PathBuf {
        let n = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("hcadx-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).expect("temp directory");
        path
    }

    fn project(root: &Path) {
        let project = root.join("sample.hcad");
        fs::create_dir_all(project.join("objects")).expect("objects");
        fs::create_dir_all(project.join("tmp")).expect("tmp");
        fs::create_dir_all(project.join("index")).expect("index");
        let manifest = initial_photolab_manifest("id".into(), "Sample".into(), 1);
        fs::write(
            project.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(project.join("objects/b.bin"), b"bbb").unwrap();
        fs::write(project.join("objects/a.bin"), b"a").unwrap();
        fs::write(project.join("tmp/partial"), b"no").unwrap();
        fs::write(project.join("index/cache"), b"no").unwrap();
        fs::write(project.join("project.lock"), b"no").unwrap();
    }

    fn limits() -> UnpackArchiveLimits {
        UnpackArchiveLimits {
            max_entries: 100,
            max_declared_bytes: 1_000_000,
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn round_trip_streams_project_and_excludes_transient_data() {
        let root = temp("roundtrip");
        project(&root);
        let archive = root.join("sample.hcadx");
        let token = CancellationToken::new();
        let summary = pack_hcadx(
            &root.join("sample.hcad"),
            &archive,
            PackArchiveOptions {
                include_rebuildable_index: false,
            },
            &token,
            |_| {},
        )
        .unwrap();
        assert_eq!(summary.files, 3);
        let output = root.join("restored.hcad");
        unpack_hcadx(&archive, &output, limits(), &token, |_| {}).unwrap();
        assert_eq!(fs::read(output.join("objects/b.bin")).unwrap(), b"bbb");
        assert!(!output.join("tmp").exists());
        assert!(!output.join("index").exists());
        assert!(!output.join("project.lock").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deterministic_entry_order_is_lexicographic() {
        let root = temp("order");
        project(&root);
        let archive_path = root.join("sample.hcadx");
        pack_hcadx(
            &root.join("sample.hcad"),
            &archive_path,
            PackArchiveOptions {
                include_rebuildable_index: false,
            },
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let mut archive = ZipArchive::new(File::open(archive_path).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_owned())
            .collect();
        assert_eq!(
            names,
            vec!["manifest.json", "objects/a.bin", "objects/b.bin"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let root = temp("traversal");
        let manifest =
            serde_json::to_vec(&initial_photolab_manifest("id".into(), "x".into(), 1)).unwrap();
        for (case, name) in [
            ("parent", "../evil"),
            ("absolute", "/evil"),
            ("drive", "C:/evil"),
        ] {
            let archive = root.join(format!("{case}.hcadx"));
            write_zip(&archive, &[("manifest.json", &manifest), (name, b"evil")]);
            let result = unpack_hcadx(
                &archive,
                &root.join(format!("out-{case}")),
                limits(),
                &CancellationToken::new(),
                |_| {},
            );
            assert!(matches!(
                result,
                Err(ProjectArchiveError::UnsafeEntryPath(_))
            ));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_entry_and_declared_size_limits() {
        let root = temp("limits");
        let manifest =
            serde_json::to_vec(&initial_photolab_manifest("id".into(), "x".into(), 1)).unwrap();
        let archive = root.join("many.hcadx");
        write_zip(&archive, &[("manifest.json", &manifest), ("a", b"1234")]);
        let entries = unpack_hcadx(
            &archive,
            &root.join("entries"),
            UnpackArchiveLimits {
                max_entries: 1,
                max_declared_bytes: 1_000_000,
            },
            &CancellationToken::new(),
            |_| {},
        );
        assert!(matches!(
            entries,
            Err(ProjectArchiveError::EntryLimitExceeded { .. })
        ));
        let bytes = unpack_hcadx(
            &archive,
            &root.join("bytes"),
            UnpackArchiveLimits {
                max_entries: 10,
                max_declared_bytes: 1,
            },
            &CancellationToken::new(),
            |_| {},
        );
        assert!(matches!(
            bytes,
            Err(ProjectArchiveError::DeclaredSizeLimitExceeded { .. })
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_removes_partial_staging_output() {
        let root = temp("cancel");
        project(&root);
        let archive = root.join("sample.hcadx");
        pack_hcadx(
            &root.join("sample.hcad"),
            &archive,
            PackArchiveOptions {
                include_rebuildable_index: false,
            },
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let output = root.join("cancelled.hcad");
        let mut checks = 0;
        let result = unpack_hcadx_with_cancel(
            &archive,
            &output,
            limits(),
            || {
                checks += 1;
                checks > 5
            },
            |_| {},
        );
        assert!(matches!(result, Err(ProjectArchiveError::Cancelled)));
        assert!(!output.exists());
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("extract-staging")));
        fs::remove_dir_all(root).unwrap();
    }
}
