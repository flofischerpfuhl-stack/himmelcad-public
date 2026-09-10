//! Atomic publication primitives with bounded Windows sharing-violation recovery.

use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

const REPLACE_FILE_OPERATION: &str = "replaceFileAtomically";
const PUBLISH_DIRECTORY_OPERATION: &str = "publishDirectory";
const WRITE_OBJECT_OPERATION: &str = "writeObjectIfAbsent";

// Windows indexers and real-time scanners can briefly retain a newly closed path. Twelve
// attempts with this bounded exponential schedule tolerate that transient interference while
// keeping the publication stall at or below six seconds.
const WINDOWS_RENAME_MAX_ATTEMPTS: usize = 12;
const WINDOWS_RENAME_INITIAL_BACKOFF: Duration = Duration::from_millis(50);
const WINDOWS_RENAME_MAX_BACKOFF: Duration = Duration::from_millis(750);

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Typed filesystem failure at an atomic publication boundary.
#[derive(Debug)]
pub struct PublishFsError {
    pub operation: &'static str,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub os_error: io::Error,
}

impl fmt::Display for PublishFsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} {}: {}",
            self.operation,
            self.destination.display(),
            self.os_error
        )
    }
}

impl Error for PublishFsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.os_error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectWriteOutcome {
    ExistingIdentical,
    Published,
}

/// Atomically replaces `destination` with a fully written temporary file.
pub fn replace_file_atomically(temporary: &Path, destination: &Path) -> Result<(), PublishFsError> {
    rename_with_platform_policy(REPLACE_FILE_OPERATION, temporary, destination)
}

/// Atomically publishes a closed scratch directory at its final destination.
pub fn publish_directory(scratch: &Path, destination: &Path) -> Result<(), PublishFsError> {
    rename_with_platform_policy(PUBLISH_DIRECTORY_OPERATION, scratch, destination)
}

/// Publishes a content-addressed object, avoiding a replace when identical bytes already exist.
pub fn write_object_if_absent(
    path: &Path,
    bytes: &[u8],
) -> Result<ObjectWriteOutcome, PublishFsError> {
    let parent = path.parent().ok_or_else(|| {
        publish_error(
            WRITE_OBJECT_OPERATION,
            path,
            path,
            io::Error::new(io::ErrorKind::InvalidInput, "object path has no parent"),
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| publish_error(WRITE_OBJECT_OPERATION, path, path, error))?;

    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == bytes.len() as u64 => {
            if existing_file_matches(path, bytes)? {
                return Ok(ObjectWriteOutcome::ExistingIdentical);
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(publish_error(WRITE_OBJECT_OPERATION, path, path, error));
        }
    }

    let temporary = temporary_object_path(path);
    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(publish_error(
            WRITE_OBJECT_OPERATION,
            &temporary,
            path,
            error,
        ));
    }

    if let Err(error) = rename_with_platform_policy(WRITE_OBJECT_OPERATION, &temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(ObjectWriteOutcome::Published)
}

fn existing_file_matches(path: &Path, bytes: &[u8]) -> Result<bool, PublishFsError> {
    let mut file = File::open(path)
        .map_err(|error| publish_error(WRITE_OBJECT_OPERATION, path, path, error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| publish_error(WRITE_OBJECT_OPERATION, path, path, error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = digest.finalize();
    let expected = Sha256::digest(bytes);
    Ok(actual[..] == expected[..])
}

fn temporary_object_path(destination: &Path) -> PathBuf {
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("object");
    parent.join(format!(
        ".{name}.object-{}-{sequence}.tmp",
        std::process::id()
    ))
}

fn publish_error(
    operation: &'static str,
    source: &Path,
    destination: &Path,
    os_error: io::Error,
) -> PublishFsError {
    PublishFsError {
        operation,
        source: source.to_owned(),
        destination: destination.to_owned(),
        os_error,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenameRetryPolicy {
    Never,
    WindowsTransient,
}

#[cfg(windows)]
const PLATFORM_RENAME_RETRY_POLICY: RenameRetryPolicy = RenameRetryPolicy::WindowsTransient;

#[cfg(not(windows))]
const PLATFORM_RENAME_RETRY_POLICY: RenameRetryPolicy = RenameRetryPolicy::Never;

fn rename_with_platform_policy(
    operation: &'static str,
    source: &Path,
    destination: &Path,
) -> Result<(), PublishFsError> {
    rename_with_policy(
        operation,
        source,
        destination,
        PLATFORM_RENAME_RETRY_POLICY,
        || fs::rename(source, destination),
        std::thread::sleep,
    )
}

fn rename_with_policy<R, S>(
    operation: &'static str,
    source: &Path,
    destination: &Path,
    policy: RenameRetryPolicy,
    mut rename: R,
    mut sleep: S,
) -> Result<(), PublishFsError>
where
    R: FnMut() -> io::Result<()>,
    S: FnMut(Duration),
{
    let maximum_attempts = match policy {
        RenameRetryPolicy::Never => 1,
        RenameRetryPolicy::WindowsTransient => WINDOWS_RENAME_MAX_ATTEMPTS,
    };
    let mut backoff = WINDOWS_RENAME_INITIAL_BACKOFF;
    for attempt in 1..=maximum_attempts {
        match rename() {
            Ok(()) => return Ok(()),
            Err(error)
                if policy == RenameRetryPolicy::WindowsTransient
                    && windows_rename_error_is_transient(&error)
                    && attempt < maximum_attempts =>
            {
                sleep(backoff);
                backoff = backoff.saturating_mul(2).min(WINDOWS_RENAME_MAX_BACKOFF);
            }
            Err(error) => {
                return Err(publish_error(operation, source, destination, error));
            }
        }
    }
    unreachable!("the bounded rename loop always returns")
}

fn windows_rename_error_is_transient(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build/codex-scratch/win11")
            .join(format!("{name}-{}-{sequence}", std::process::id()))
    }

    #[test]
    fn windows_retry_path_accepts_access_denied_then_sharing_violation() {
        let mut attempts = 0;
        let mut delays = Vec::new();
        rename_with_policy(
            PUBLISH_DIRECTORY_OPERATION,
            Path::new("scratch"),
            Path::new("published"),
            RenameRetryPolicy::WindowsTransient,
            || {
                attempts += 1;
                match attempts {
                    1 => Err(io::Error::from_raw_os_error(5)),
                    2 => Err(io::Error::from_raw_os_error(32)),
                    _ => Ok(()),
                }
            },
            |delay| delays.push(delay),
        )
        .expect("transient Windows interference should be retried");
        assert_eq!(attempts, 3);
        assert_eq!(
            delays,
            [Duration::from_millis(50), Duration::from_millis(100)]
        );
    }

    #[test]
    fn windows_retry_path_fails_typed_after_the_budget() {
        let mut attempts = 0;
        let mut total_backoff = Duration::ZERO;
        let error = rename_with_policy(
            PUBLISH_DIRECTORY_OPERATION,
            Path::new("scratch"),
            Path::new("published"),
            RenameRetryPolicy::WindowsTransient,
            || {
                attempts += 1;
                Err(io::Error::from_raw_os_error(5))
            },
            |delay| total_backoff += delay,
        )
        .expect_err("retry budget must be bounded");
        assert_eq!(attempts, WINDOWS_RENAME_MAX_ATTEMPTS);
        assert_eq!(error.operation, PUBLISH_DIRECTORY_OPERATION);
        assert_eq!(error.source, Path::new("scratch"));
        assert_eq!(error.destination, Path::new("published"));
        assert_eq!(error.os_error.raw_os_error(), Some(5));
        assert_eq!(total_backoff, Duration::from_secs(6));
    }

    #[test]
    fn unix_retry_path_does_not_retry() {
        let mut attempts = 0;
        let error = rename_with_policy(
            REPLACE_FILE_OPERATION,
            Path::new("temporary"),
            Path::new("destination"),
            RenameRetryPolicy::Never,
            || {
                attempts += 1;
                Err(io::Error::from_raw_os_error(5))
            },
            |_| panic!("the Unix path must not back off"),
        )
        .expect_err("the first rename error must be returned");
        assert_eq!(attempts, 1);
        assert_eq!(error.os_error.raw_os_error(), Some(5));
    }

    #[test]
    fn object_write_skips_identical_and_replaces_differing_content() {
        let root = test_directory("objects");
        fs::create_dir_all(&root).expect("test root");
        let path = root.join("object");
        fs::write(&path, b"same").expect("existing object");

        assert_eq!(
            write_object_if_absent(&path, b"same").expect("identical object"),
            ObjectWriteOutcome::ExistingIdentical
        );
        assert_eq!(
            write_object_if_absent(&path, b"else").expect("replacement object"),
            ObjectWriteOutcome::Published
        );
        assert_eq!(fs::read(&path).expect("published object"), b"else");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn error_message_names_operation_and_destination() {
        let error = publish_error(
            PUBLISH_DIRECTORY_OPERATION,
            Path::new("scratch"),
            Path::new("project/datasets/final"),
            io::Error::from_raw_os_error(5),
        );
        let message = error.to_string();
        assert!(message.starts_with("publishDirectory project/datasets/final: "));
        assert!(message.contains("os error 5"));
    }
}
