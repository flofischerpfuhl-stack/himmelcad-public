//! HimmelCAD sidecar process entry.

#![forbid(unsafe_code)]
#![cfg_attr(test, recursion_limit = "256")]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use himmelcad_domain_photogrammetry::project_runtime;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

mod routes;

const PROGRESS_PREFIX: &str = "__HC_PROGRESS__";

pub(crate) fn emit_progress(progress_key: Option<&str>, fraction: f64, message: &str) {
    let Some(progress_key) = progress_key else {
        return;
    };
    let fraction = fraction.clamp(0.0, 1.0);
    let phase = progress_phase_signature(message);
    let started = PROGRESS_CLOCK.get_or_init(Instant::now);
    let mut coalescer = PROGRESS_COALESCER
        .get_or_init(|| Mutex::new(ProgressEventCoalescer::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !coalescer.should_emit_at(progress_key, &phase, fraction, started.elapsed()) {
        return;
    }
    let payload = serde_json::json!({
        "progressKey": progress_key,
        "fraction": fraction,
        "message": message,
    });
    eprintln!("{PROGRESS_PREFIX}{payload}");
}

const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_TRACKED_PROGRESS_JOBS: usize = 4_096;
static PROGRESS_CLOCK: OnceLock<Instant> = OnceLock::new();
static PROGRESS_COALESCER: OnceLock<Mutex<ProgressEventCoalescer>> = OnceLock::new();

#[derive(Default)]
pub(crate) struct ProgressEventCoalescer {
    jobs: BTreeMap<String, ProgressEmission>,
}

struct ProgressEmission {
    phase: String,
    fraction: f64,
    emitted_at: Duration,
}

impl ProgressEventCoalescer {
    pub(crate) fn should_emit_at(
        &mut self,
        progress_key: &str,
        phase: &str,
        fraction: f64,
        now: Duration,
    ) -> bool {
        let emit = self.jobs.get(progress_key).is_none_or(|previous| {
            previous.phase != phase
                || fraction < previous.fraction
                || (fraction >= 1.0 && previous.fraction < 1.0)
                || now.saturating_sub(previous.emitted_at) >= PROGRESS_EVENT_INTERVAL
        });
        if !emit {
            return false;
        }
        if self.jobs.len() >= MAX_TRACKED_PROGRESS_JOBS && !self.jobs.contains_key(progress_key) {
            if let Some(oldest) = self
                .jobs
                .iter()
                .min_by_key(|(_, emission)| emission.emitted_at)
                .map(|(key, _)| key.clone())
            {
                self.jobs.remove(&oldest);
            }
        }
        self.jobs.insert(
            progress_key.to_owned(),
            ProgressEmission {
                phase: phase.to_owned(),
                fraction,
                emitted_at: now,
            },
        );
        true
    }
}

fn progress_phase_signature(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.strip_prefix("Converting ").is_some() {
        return "Converting source".to_owned();
    }
    trimmed
        .split(['·', ':'])
        .next()
        .unwrap_or(trimmed)
        .split_whitespace()
        .take(2)
        .map(|word| {
            word.chars()
                .map(|character| {
                    if character.is_ascii_digit() {
                        '#'
                    } else {
                        character
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--list-routes"))
    {
        return routes::print_registered_routes();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,parse_gps=warn,nom_exif=warn")
            }),
        )
        .with_writer(std::io::stderr)
        .init();

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "himmelcad-sidecar starting"
    );
    if std::env::var("HIMMELCAD_PHOTOLAB_PROBE_WORKER_SCOPE").as_deref() == Ok("1") {
        let _ = himmelcad_process::worker::probe_worker_scope_for_diagnostics();
    }

    let mut stdin_lines = spawn_stdin_reader();
    let (services, command_registry) = build_command_registry(routes::ProductSelection::ALL)?;
    let projects = Arc::clone(&services.projects);
    let jobs = Arc::clone(&services.jobs);
    let canonical_app = Arc::clone(&services.canonical_app);
    let command_registry = Arc::new(command_registry);
    let (response_tx, mut response_rx) = mpsc::channel::<routes::RpcResponse>(256);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(response) = response_rx.recv().await {
            let json = serde_json::to_string(&response)?;
            stdout.write_all(json.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let line = tokio::select! {
            line = stdin_lines.recv() => match line {
                Some(line) => Some(line?),
                None => None,
            },
            () = &mut shutdown => {
                tracing::info!("sidecar shutdown signal received; draining active PhotoLab work");
                None
            }
        };
        let Some(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let command_registry = Arc::clone(&command_registry);
        let response_tx = response_tx.clone();
        let parsed = serde_json::from_str::<routes::RpcRequest>(&line);
        tokio::spawn(async move {
            let response = match parsed {
                Ok(request) => dispatch_request(&command_registry, request).await,
                Err(error) => routes::RpcResponse {
                    jsonrpc: "2.0",
                    id: serde_json::Value::Null,
                    result: None,
                    error: Some(routes::RpcError {
                        code: -32700,
                        message: format!("parse error: {error}"),
                        data: None,
                    }),
                },
            };
            if response_tx.send(response).await.is_err() {
                tracing::warn!("RPC response writer closed before request completed");
            }
        });
    }

    let (job_drain, side_drain) = routes::drain_project_work(&jobs, &projects).await;
    if !job_drain.completed() || !side_drain.completed() {
        tracing::error!(
            timed_out_jobs = ?job_drain.timed_out,
            timed_out_side_operations = ?side_drain.timed_out,
            "sidecar drain timed out; leaving the project manifest unclean and terminating worker groups"
        );
        himmelcad_sidecar::process_group::terminate_all_registered();
        std::process::exit(1);
    }
    drop(response_tx);
    writer.await??;

    if let Err(error) = projects.close_after_drain(&job_drain, &side_drain) {
        tracing::error!(%error, "failed to close project cleanly during sidecar shutdown");
    }
    canonical_app
        .lock()
        .expect("canonical app runtime mutex poisoned")
        .close();

    Ok(())
}

fn build_command_registry(
    selection: routes::ProductSelection,
) -> anyhow::Result<(routes::RouteServices, routes::SidecarCommandRegistry)> {
    let services = routes::RouteServices::new()?;
    let registry = routes::build_command_registry(selection, &services)?;
    Ok((services, registry))
}

async fn dispatch_request(
    registry: &routes::SidecarCommandRegistry,
    request: routes::RpcRequest,
) -> routes::RpcResponse {
    if request.jsonrpc != "2.0" {
        return routes::rpc_err(request.id, -32600, "invalid jsonrpc version");
    }
    let method = request.method.clone();
    match registry.dispatch(&method, request, ()) {
        Ok(response) => response.await,
        Err((request, ())) => routes::rpc_err(
            request.id,
            -32601,
            &format!("method not found: {}", request.method),
        ),
    }
}

fn spawn_stdin_reader() -> mpsc::Receiver<std::io::Result<String>> {
    let (sender, receiver) = mpsc::channel(256);
    std::thread::Builder::new()
        .name("sidecar-stdin".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            let reader = BufReader::new(stdin.lock());
            for line in reader.lines() {
                if sender.blocking_send(line).is_err() {
                    break;
                }
            }
        })
        .expect("spawn sidecar stdin reader");
    receiver
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut interrupt = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows::{ctrl_break, ctrl_c};

        let mut interrupt = ctrl_c().expect("install Ctrl+C handler");
        let mut ctrl_break = ctrl_break().expect("install Ctrl+Break handler");
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = ctrl_break.recv() => {}
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
