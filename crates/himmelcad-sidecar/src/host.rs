//! HimmelCAD sidecar process entry.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::future::Future;
use std::io::{BufRead, BufReader};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::canonical_app_runtime::CanonicalAppRuntime;
use crate::routes::{
    rpc_err, RouteDefinition, RpcError, RpcRequest, RpcResponse, SidecarCommandRegistry,
};

const PROGRESS_PREFIX: &str = "__HC_PROGRESS__";

pub fn emit_progress(progress_key: Option<&str>, fraction: f64, message: &str) {
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
pub struct ProgressEventCoalescer {
    jobs: BTreeMap<String, ProgressEmission>,
}

struct ProgressEmission {
    phase: String,
    fraction: f64,
    emitted_at: Duration,
}

impl ProgressEventCoalescer {
    pub fn should_emit_at(
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

pub type DrainFuture<'a> = Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

pub trait ProductLifecycle: Send + Sync {
    fn startup(&self) {}

    fn drain(&self) -> DrainFuture<'_> {
        Box::pin(async { true })
    }

    fn close(&self) {}
}

pub struct HostComposition {
    pub registry: SidecarCommandRegistry,
    pub routes: Vec<RouteDefinition>,
    pub canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    pub lifecycle: Arc<dyn ProductLifecycle>,
}

pub async fn run(mut composition: HostComposition) -> anyhow::Result<()> {
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--list-routes"))
    {
        composition.routes.sort_by_key(|route| route.method);
        anyhow::ensure!(
            composition
                .registry
                .methods()
                .eq(composition.routes.iter().map(|route| route.method)),
            "registered route metadata differs from the exact command registry"
        );
        let inventory = composition
            .routes
            .into_iter()
            .map(|route| {
                serde_json::json!({
                    "method": route.method,
                    "handlerFamily": route.family,
                    "product": route.product,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_writer(std::io::stdout().lock(), &inventory)?;
        println!();
        return Ok(());
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
    composition.lifecycle.startup();

    let mut stdin_lines = spawn_stdin_reader();
    let canonical_app = Arc::clone(&composition.canonical_app);
    let command_registry = Arc::new(composition.registry);
    let lifecycle = Arc::clone(&composition.lifecycle);
    let (response_tx, mut response_rx) = mpsc::channel::<RpcResponse>(256);
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
        let parsed = serde_json::from_str::<RpcRequest>(&line);
        tokio::spawn(async move {
            let response = match parsed {
                Ok(request) => dispatch_request(&command_registry, request).await,
                Err(error) => RpcResponse {
                    jsonrpc: "2.0",
                    id: serde_json::Value::Null,
                    result: None,
                    error: Some(RpcError {
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

    if !lifecycle.drain().await {
        tracing::error!("sidecar drain timed out; terminating worker groups");
        crate::process_group::terminate_all_registered();
        std::process::exit(1);
    }
    drop(response_tx);
    writer.await??;

    lifecycle.close();
    canonical_app
        .lock()
        .expect("canonical app runtime mutex poisoned")
        .close();

    Ok(())
}

async fn dispatch_request(registry: &SidecarCommandRegistry, request: RpcRequest) -> RpcResponse {
    if request.jsonrpc != "2.0" {
        return rpc_err(request.id, -32600, "invalid jsonrpc version");
    }
    let method = request.method.clone();
    match registry.dispatch(&method, request, ()) {
        Ok(response) => response.await,
        Err((request, ())) => rpc_err(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_progress_is_coalesced_to_ten_hz_and_phase_changes_are_immediate() {
        let mut coalescer = ProgressEventCoalescer::default();
        let emitted = (0_u64..200)
            .filter(|index| {
                coalescer.should_emit_at(
                    "segment-road",
                    "Scanning points",
                    *index as f64 / 1_000.0,
                    Duration::from_millis(index * 5),
                )
            })
            .count();
        assert_eq!(
            emitted, 10,
            "steady per-batch updates must publish at most 10 Hz"
        );
        assert!(coalescer.should_emit_at(
            "segment-road",
            "Baking hierarchy",
            0.2,
            Duration::from_millis(997),
        ));
        assert!(!coalescer.should_emit_at(
            "segment-road",
            "Baking hierarchy",
            0.21,
            Duration::from_millis(999),
        ));
    }
}
