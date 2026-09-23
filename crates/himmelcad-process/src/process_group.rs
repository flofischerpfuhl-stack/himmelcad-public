//! Process-group containment for cancellable external workers.

use std::{
    collections::BTreeSet,
    io,
    ops::{Deref, DerefMut},
    process::{Child, Command},
    sync::{Mutex, OnceLock},
};

static ACTIVE_PROCESS_GROUPS: OnceLock<Mutex<BTreeSet<u32>>> = OnceLock::new();

fn active_process_groups() -> &'static Mutex<BTreeSet<u32>> {
    ACTIVE_PROCESS_GROUPS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn register(process_id: Option<u32>) {
    if let Some(process_id) = process_id {
        active_process_groups()
            .lock()
            .expect("external process group registry poisoned")
            .insert(process_id);
    }
}

fn unregister(process_id: Option<u32>) {
    if let Some(process_id) = process_id {
        active_process_groups()
            .lock()
            .expect("external process group registry poisoned")
            .remove(&process_id);
    }
}

/// Configures a worker command so descendants share a group distinct from the sidecar.
pub fn configure(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // WinBase.h CREATE_NEW_PROCESS_GROUP. This permits group-scoped console control
        // events, while direct termination remains the dependency-free fallback.
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
}

/// Spawns a contained standard-library child with a drop guard.
pub fn spawn(command: &mut Command) -> io::Result<ProcessGroupChild> {
    configure(command);
    command.spawn().map(ProcessGroupChild::new)
}

/// Best-effort group signal. `Ok(false)` means the platform fallback must kill the child.
pub fn kill_group(process_id: Option<u32>) -> io::Result<bool> {
    #[cfg(unix)]
    {
        let Some(process_id) = process_id else {
            return Ok(false);
        };
        // POSIX requires a negative pid to address a process group. No libc/nix crate is
        // a direct dependency, so use the platform utility rather than adding one.
        let status = Command::new("kill")
            .arg("-KILL")
            .arg("--")
            .arg(format!("-{process_id}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        Ok(status.success())
    }
    #[cfg(not(unix))]
    {
        let _ = process_id;
        Ok(false)
    }
}

/// Signals every external worker group still owned by this sidecar.
pub fn terminate_all_registered() {
    let process_ids = active_process_groups()
        .lock()
        .expect("external process group registry poisoned")
        .iter()
        .copied()
        .collect::<Vec<_>>();
    for process_id in process_ids {
        let _ = kill_group(Some(process_id));
    }
}

/// Owns a worker child and guarantees best-effort termination plus direct-child reaping.
#[derive(Debug)]
pub struct ProcessGroupChild {
    child: Child,
    peak_rss_bytes: u64,
}

impl ProcessGroupChild {
    fn new(child: Child) -> Self {
        register(Some(child.id()));
        Self {
            child,
            peak_rss_bytes: 0,
        }
    }

    /// Samples the contained group before querying child completion.
    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.sample_peak_rss();
        self.child.try_wait()
    }

    /// Highest sampled group RSS observed while supervising this child.
    #[must_use]
    pub const fn peak_rss_bytes(&self) -> u64 {
        self.peak_rss_bytes
    }

    /// Returns and resets the sampled peak at a caller-defined stage boundary.
    pub fn take_peak_rss_bytes(&mut self) -> u64 {
        self.sample_peak_rss();
        std::mem::take(&mut self.peak_rss_bytes)
    }

    fn sample_peak_rss(&mut self) {
        self.peak_rss_bytes = self
            .peak_rss_bytes
            .max(sample_process_group_rss(self.child.id()));
    }

    /// Kills the process group where supported, then reaps the direct child.
    pub fn terminate_and_wait(&mut self) -> io::Result<()> {
        if self.try_wait()?.is_some() {
            return Ok(());
        }
        if !kill_group(Some(self.child.id())).unwrap_or(false) {
            self.child.kill()?;
        }
        self.child.wait().map(|_| ())
    }
}

#[cfg(target_os = "linux")]
fn sample_process_group_rss(group_id: u32) -> u64 {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return 0;
    };
    let mut group_sum = 0_u64;
    let mut largest_child = 0_u64;
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(fields) = stat.rsplit_once(')').map(|(_, fields)| fields.trim()) else {
            continue;
        };
        let mut fields = fields.split_whitespace();
        let _state = fields.next();
        let parent_id = fields.next().and_then(|value| value.parse::<u32>().ok());
        let process_group = fields.next().and_then(|value| value.parse::<u32>().ok());
        if process_group != Some(group_id) {
            continue;
        }
        let rss = linux_process_rss_bytes(pid);
        group_sum = group_sum.saturating_add(rss);
        if parent_id == Some(group_id) {
            largest_child = largest_child.max(rss);
        }
    }
    // WP-A7 requires the complete process-group sum plus the largest direct child
    // so a launcher that briefly retains a copied activation buffer is not hidden.
    group_sum.saturating_add(largest_child)
}

#[cfg(target_os = "linux")]
fn linux_process_rss_bytes(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        })
        .unwrap_or(0)
        .saturating_mul(1024)
}

#[cfg(not(target_os = "linux"))]
const fn sample_process_group_rss(_group_id: u32) -> u64 {
    0
}

impl Deref for ProcessGroupChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl DerefMut for ProcessGroupChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for ProcessGroupChild {
    fn drop(&mut self) {
        let process_id = Some(self.child.id());
        if self.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.terminate_and_wait();
        } else {
            // A worker that exited first may still have live descendants in its group.
            let _ = kill_group(process_id);
        }
        unregister(process_id);
    }
}

/// Drop hook for Tokio children; their own `kill_on_drop` setting reaps the direct child.
#[derive(Debug)]
pub struct ProcessGroupDropGuard {
    process_id: Option<u32>,
}

impl ProcessGroupDropGuard {
    #[must_use]
    pub fn new(process_id: Option<u32>) -> Self {
        register(process_id);
        Self { process_id }
    }
}

impl Drop for ProcessGroupDropGuard {
    fn drop(&mut self) {
        let _ = kill_group(self.process_id);
        unregister(self.process_id);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::{spawn, Command};

    #[cfg(unix)]
    #[test]
    fn killing_a_worker_group_also_kills_its_grandchild() {
        use std::{
            io::{BufRead, BufReader},
            process::Stdio,
            thread,
            time::{Duration, Instant},
        };

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 60 & echo $!; wait")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = spawn(&mut command).expect("spawn process-group fixture");
        let mut grandchild = String::new();
        BufReader::new(child.stdout.take().expect("fixture stdout"))
            .read_line(&mut grandchild)
            .expect("read grandchild pid");
        let grandchild = grandchild.trim().parse::<u32>().expect("grandchild pid");

        child
            .terminate_and_wait()
            .expect("terminate and reap worker group");

        let cutoff = Instant::now() + Duration::from_secs(3);
        loop {
            let alive = Command::new("kill")
                .arg("-0")
                .arg(grandchild.to_string())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !alive {
                break;
            }
            assert!(
                Instant::now() < cutoff,
                "grandchild {grandchild} survived group kill"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn samples_peak_rss_for_a_known_child_buffer() {
        use std::{process::Stdio, thread, time::Duration};

        const BUFFER_BYTES: u64 = 16 * 1024 * 1024;
        let mut command = Command::new("python3");
        command
            .args([
                "-c",
                "import time; value=bytearray(16*1024*1024); value[0]=1; time.sleep(0.4)",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = spawn(&mut command).expect("spawn allocation fixture");
        loop {
            if child.try_wait().expect("sample fixture").is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            child.peak_rss_bytes() >= BUFFER_BYTES,
            "sampled {} bytes for a {BUFFER_BYTES}-byte allocation",
            child.peak_rss_bytes()
        );
    }
}
