//! Cross-domain worker launch commands and operating-system memory limits.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

// RLIMIT_AS measures virtual address space while the calibrated models predict RSS. The
// fallback doubles the resident limit to cover thread arenas and mapped weights.
pub const WORKER_RLIMIT_AS_MULTIPLIER: u64 = 2;
const SYSTEMD_SCOPE_PROBE_DIAGNOSTIC_MAX_CHARS: usize = 512;
#[cfg(target_os = "linux")]
const PRLIMIT_PATH: &str = "/usr/bin/prlimit";

#[cfg(target_os = "linux")]
static SYSTEMD_USER_SCOPE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Operating-system mechanism used to enforce one worker's memory limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerMemoryLimitMode {
    /// A transient systemd user scope with a cgroup resident-memory limit.
    CgroupScope,
    /// A child-only address-space rlimit applied by `prlimit`.
    RlimitAs,
}

impl WorkerMemoryLimitMode {
    /// Stable diagnostic spelling recorded with memory evidence.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CgroupScope => "cgroupScope",
            Self::RlimitAs => "rlimitAs",
        }
    }
}

/// Frozen launch mechanism and exact enforced byte limit for one worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerMemoryLimitPlan {
    /// Operating-system enforcement mechanism.
    pub mode: WorkerMemoryLimitMode,
    /// Exact byte limit passed to the launcher.
    pub enforced_limit_bytes: u64,
}

/// Builds a worker command with the strongest available child-only memory limit.
#[must_use]
pub fn worker_command(
    executable: &Path,
    memory_limit_bytes: Option<u64>,
) -> (Command, Option<WorkerMemoryLimitPlan>) {
    #[cfg(target_os = "linux")]
    if let Some(memory_limit_bytes) = memory_limit_bytes
        .filter(|_| std::env::var("HIMMELCAD_PHOTOLAB_WORKER_RLIMIT_DISABLE").as_deref() != Ok("1"))
    {
        // Operational/test override for hosts where probing a systemd user manager is forbidden;
        // the hard address-space fallback remains active instead of disabling the worker bound.
        let force_rlimit =
            std::env::var("HIMMELCAD_PHOTOLAB_WORKER_FORCE_RLIMIT_AS").as_deref() == Ok("1");
        if !force_rlimit {
            if let Some(systemd_run) = systemd_user_scope() {
                let plan = WorkerMemoryLimitPlan {
                    mode: WorkerMemoryLimitMode::CgroupScope,
                    enforced_limit_bytes: memory_limit_bytes,
                };
                return (
                    worker_command_for_plan(systemd_run, executable, plan),
                    Some(plan),
                );
            }
        }
        let plan = WorkerMemoryLimitPlan {
            mode: WorkerMemoryLimitMode::RlimitAs,
            enforced_limit_bytes: memory_limit_bytes.saturating_mul(WORKER_RLIMIT_AS_MULTIPLIER),
        };
        return (
            worker_command_for_plan(Path::new(PRLIMIT_PATH), executable, plan),
            Some(plan),
        );
    }
    let _ = memory_limit_bytes;
    (Command::new(executable), None)
}

/// Builds the exact command for an already selected worker memory-limit plan.
#[cfg(target_os = "linux")]
#[must_use]
pub fn worker_command_for_plan(
    launcher: &Path,
    executable: &Path,
    plan: WorkerMemoryLimitPlan,
) -> Command {
    match plan.mode {
        WorkerMemoryLimitMode::CgroupScope => {
            let mut command = Command::new(launcher);
            command
                .arg("--user")
                .arg("--scope")
                .arg("--quiet")
                .arg("-p")
                .arg(format!("MemoryMax={}", plan.enforced_limit_bytes))
                .arg("-p")
                .arg("MemorySwapMax=0")
                .arg("--collect")
                .arg("--")
                // A scope can enforce cgroup properties, but it cannot apply execution-context
                // properties such as LimitCORE. Apply the child-only rlimit immediately before
                // exec while the resulting process remains inside the transient scope.
                .arg(PRLIMIT_PATH)
                .arg("--core=0")
                .arg("--")
                .arg(executable);
            command
        }
        WorkerMemoryLimitMode::RlimitAs => {
            // This crate forbids unsafe code, while std's pre-exec hook is unsafe. `prlimit`
            // applies the child-only fallback immediately before `exec`; descendants inherit it.
            let mut command = Command::new(launcher);
            command
                .arg(format!("--as={}", plan.enforced_limit_bytes))
                .arg("--")
                .arg(executable);
            command
        }
    }
}

#[cfg(target_os = "linux")]
pub fn systemd_user_scope() -> Option<&'static Path> {
    if std::env::var("HIMMELCAD_PHOTOLAB_WORKER_FORCE_RLIMIT_AS").as_deref() == Ok("1") {
        return None;
    }
    SYSTEMD_USER_SCOPE
        .get_or_init(|| {
            let Some(executable) = find_in_path("systemd-run") else {
                tracing::info!(
                    available = false,
                    reason = "systemd-run was not found in PATH or the standard system paths",
                    "PhotoLab systemd user-scope probe completed"
                );
                return None;
            };
            let outcome = run_systemd_user_scope_probe(&executable);
            let available = outcome.as_ref().is_ok_and(|output| output.status.success());
            match outcome {
                Ok(output) => tracing::info!(
                    available,
                    status = %output.status,
                    stdout = %systemd_probe_excerpt(&output.stdout),
                    stderr = %systemd_probe_excerpt(&output.stderr),
                    "PhotoLab systemd user-scope probe completed"
                ),
                Err(ref error) => tracing::info!(
                    available,
                    reason = %error,
                    "PhotoLab systemd user-scope probe completed"
                ),
            }
            available.then_some(executable)
        })
        .as_deref()
}

/// Builds the fixed systemd user-scope availability probe command.
#[cfg(target_os = "linux")]
#[must_use]
pub fn systemd_user_scope_probe_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("--user")
        .arg("--scope")
        .arg("--quiet")
        .arg("-p")
        .arg("MemoryMax=64M")
        .arg("-p")
        .arg("MemorySwapMax=0")
        .arg("--collect")
        .arg("--")
        .arg(PRLIMIT_PATH)
        .arg("--core=0")
        .arg("--")
        .arg("/bin/true");
    configure_systemd_user_bus_environment(&mut command);
    command
}

#[cfg(target_os = "linux")]
pub fn run_systemd_user_scope_probe(executable: &Path) -> io::Result<std::process::Output> {
    systemd_user_scope_probe_command(executable)
        .stdin(Stdio::null())
        .output()
}

#[cfg(target_os = "linux")]
fn systemd_probe_excerpt(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(SYSTEMD_SCOPE_PROBE_DIAGNOSTIC_MAX_CHARS)
        .collect()
}

/// Restores the user-bus environment after a worker command used `env_clear`.
#[cfg(target_os = "linux")]
pub fn configure_systemd_user_bus_environment(command: &mut Command) {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(systemd_user_runtime_dir);
    // The worker command starts from `env_clear()`, so the bus variables must be set
    // explicitly even when the sidecar itself inherited them.
    if let Some(runtime_dir) = runtime_dir.as_ref() {
        command.env("XDG_RUNTIME_DIR", runtime_dir);
    }
    if let Some(bus) = std::env::var_os("DBUS_SESSION_BUS_ADDRESS") {
        command.env("DBUS_SESSION_BUS_ADDRESS", bus);
    } else if let Some(bus) = runtime_dir
        .as_ref()
        .map(|runtime_dir| runtime_dir.join("bus"))
        .filter(|bus| bus.exists())
    {
        command.env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", bus.display()),
        );
    }
}

#[cfg(target_os = "linux")]
fn systemd_user_runtime_dir() -> Option<PathBuf> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let uid = effective_uid_from_proc_status(&status)?;
    let runtime_dir = Path::new("/run/user").join(uid.to_string());
    runtime_dir.is_dir().then_some(runtime_dir)
}

/// Parses the effective uid column from Linux `/proc/self/status` text.
#[cfg(target_os = "linux")]
#[must_use]
pub fn effective_uid_from_proc_status(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// Runs the process-cached worker-scope probe for integration diagnostics.
#[cfg(target_os = "linux")]
#[must_use]
pub fn probe_worker_scope_for_diagnostics() -> bool {
    systemd_user_scope().is_some()
}

/// Reports that worker scopes are unavailable on non-Linux targets.
#[cfg(not(target_os = "linux"))]
#[must_use]
pub const fn probe_worker_scope_for_diagnostics() -> bool {
    false
}

#[cfg(target_os = "linux")]
pub fn find_in_path(executable: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
        .or_else(|| {
            ["/usr/bin", "/bin"]
                .into_iter()
                .map(|directory| Path::new(directory).join(executable))
                .find(|candidate| candidate.is_file())
        })
}
