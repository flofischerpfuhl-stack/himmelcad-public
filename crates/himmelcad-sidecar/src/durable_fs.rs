//! Cross-platform durability helpers for files and their containing directories.

use std::path::Path;

use anyhow::{Context, Result};

#[cfg(unix)]
use std::fs::File;
#[cfg(windows)]
use std::fs::OpenOptions;

/// Flushes one file through a handle with the access required by the platform.
pub fn sync_file(path: &Path) -> Result<()> {
    #[cfg(windows)]
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("sync file {}", path.display()))?;
    #[cfg(unix)]
    let file = File::open(path).with_context(|| format!("sync file {}", path.display()))?;

    file.sync_all()
        .with_context(|| format!("sync file {}", path.display()))
}

/// Flushes directory metadata where the platform exposes a compatible handle.
pub fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let directory =
            File::open(path).with_context(|| format!("sync directory {}", path.display()))?;
        directory
            .sync_all()
            .with_context(|| format!("sync directory {}", path.display()))?;
    }
    #[cfg(windows)]
    {
        tracing::debug!(
            path = %path.display(),
            "skipping directory sync because Windows does not expose a File::open-compatible directory handle"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn test_directory(name: &str) -> std::path::PathBuf {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build/codex-scratch/win15")
            .join(format!(
                "{name}-{}-{}",
                std::process::id(),
                NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).expect("create durability test directory");
        path
    }

    #[test]
    fn sync_file_flushes_a_temporary_file() {
        let root = test_directory("file");
        let path = root.join("artifact.bin");
        fs::write(&path, b"durable artifact").expect("write artifact");

        sync_file(&path).expect("sync artifact");

        fs::remove_dir_all(root).expect("clean durability test directory");
    }

    #[test]
    #[cfg(unix)]
    fn sync_file_accepts_a_read_only_file_on_unix() {
        let root = test_directory("read-only-file");
        let path = root.join("manifest.json");
        fs::write(&path, b"{}\n").expect("write manifest");
        let mut permissions = fs::metadata(&path)
            .expect("manifest metadata")
            .permissions();
        permissions.set_mode(0o444);
        fs::set_permissions(&path, permissions).expect("make manifest read-only");

        sync_file(&path).expect("sync read-only manifest");

        fs::remove_dir_all(root).expect("clean durability test directory");
    }

    #[test]
    fn sync_dir_flushes_a_temporary_directory() {
        let root = test_directory("directory");

        sync_dir(&root).expect("sync directory");

        fs::remove_dir_all(root).expect("clean durability test directory");
    }
}
