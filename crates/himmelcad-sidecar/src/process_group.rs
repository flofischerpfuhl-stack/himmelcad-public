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
}

impl ProcessGroupChild {
    fn new(child: Child) -> Self {
        register(Some(child.id()));
        Self { child }
    }

    /// Kills the process group where supported, then reaps the direct child.
    pub fn terminate_and_wait(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_some() {
            return Ok(());
        }
        if !kill_group(Some(self.child.id())).unwrap_or(false) {
            self.child.kill()?;
        }
        self.child.wait().map(|_| ())
    }
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
        if self.child.try_wait().is_ok_and(|status| status.is_none()) {
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
}
