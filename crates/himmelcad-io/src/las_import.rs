//! LAS / LAZ importer (Phase 2, see ADR 0003).
//!
//! Strategy: shell out to vendored **`PotreeConverter`** to produce a
//! Potree 2.0 octree (`metadata.json` + `hierarchy.bin` + `octree.bin`)
//! inside the project cache directory. The renderer then streams the
//! octree via the vendored `@himmelcad/three-loader`; no raw point data
//! ever lives in our process memory and the runtime cost is independent
//! of total cloud size.
//!
//! Per `AGENTS.md` §1.6, `vendor/potreeconverter/<platform>/PotreeConverter`
//! is **part of HimmelCAD**: the binary is fetched on `pnpm install` (see
//! `scripts/fetch-vendor.mjs`, SHA-256-verified), the upstream license is
//! mirrored next to it, and we maintain a per-platform `VENDOR.md`.
//!
//! Each LAS file becomes one entity directory inside the cache:
//!
//! ```text
//! <cache_dir>/
//!   <entityId>/
//!     metadata.json
//!     hierarchy.bin
//!     octree.bin
//!     log.txt          (PotreeConverter diagnostic; ignored)
//! ```
//!
//! `<entityId>` is a short hash of (path, current nanoseconds) so repeated
//! imports of the same source produce isolated caches and don't trample
//! each other.

use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::ImportError;

/// `PotreeConverter` output encoding. We pin **DEFAULT** (uncompressed
/// `octree.bin`) because three-loader 1.0.x doesn't ship BROTLI support
/// yet — see ADR 0003. Switch to `"BROTLI"` once vendor patch lands.
const ENCODING: &str = "DEFAULT";

/// Sampling method. `"poisson"` produces well-distributed coarse-LOD
/// representations at every octree level; the alternative `"random"`
/// is faster but visually noisier.
const SAMPLING: &str = "poisson";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LasImportSummary {
    pub source_path: String,
    pub source_name: String,
    pub point_count_total: u64,
    /// Same as `point_count_total` now that `PotreeConverter` retains every
    /// input point (no decimation cap). Kept distinct for renderer-side
    /// "loaded / total" displays; will collapse to one field once the
    /// renderer logs are unified.
    pub point_count_loaded: u64,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    /// Coordinate offset `PotreeConverter` applied so the runtime can add
    /// it back when computing absolute world positions for snap or
    /// measurement output. Per-node positions in `octree.bin` are
    /// quantized via the per-axis `scale` (in metadata.json) relative
    /// to this offset.
    pub render_offset: [f64; 3],
    pub has_color: bool,
    pub has_intensity: bool,
    /// Absolute filesystem path to the entity's Potree directory inside
    /// the project cache (sidecar-side). The renderer never sees this
    /// path directly — only `entity_id`, which the Electron host maps to
    /// `hcad-cache://local/<entity_id>/...` URLs.
    pub potree_dir: String,
    /// Short hash, used both as the directory name in the cache and as
    /// the path component in `hcad-cache://local/<entity_id>/metadata.json`.
    pub entity_id: String,
}

#[derive(Debug, Clone)]
pub struct ConverterProgress {
    pub fraction: Option<f32>,
    pub message: String,
}

pub fn import_las_file(path: &Path, cache_dir: &Path) -> Result<LasImportSummary, ImportError> {
    import_las_file_with_progress(path, cache_dir, |_| {})
}

pub fn import_las_file_with_progress<F>(
    path: &Path,
    cache_dir: &Path,
    progress: F,
) -> Result<LasImportSummary, ImportError>
where
    F: Fn(ConverterProgress) + Send + Sync + 'static,
{
    let converter = locate_potreeconverter()?;
    let entity_id = short_hash(path);
    let entity_dir = cache_dir.join(&entity_id);
    if entity_dir.exists() {
        std::fs::remove_dir_all(&entity_dir)?;
    }
    std::fs::create_dir_all(&entity_dir)?;

    let source_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("import.las")
        .to_string();

    tracing::info!(
        converter = ?converter,
        target = ?entity_dir,
        source = %path.display(),
        "PotreeConverter spawning"
    );

    let converter_output = run_converter_streaming(&converter, path, &entity_dir, &progress)?;

    if !converter_output.status.success() {
        return Err(ImportError::Converter(format!(
            "exit {} — stderr: {} | stdout: {}",
            converter_output.status.code().unwrap_or(-1),
            tail(&converter_output.stderr_tail, 800),
            tail(&converter_output.stdout_tail, 400),
        )));
    }

    let metadata_path = entity_dir.join("metadata.json");
    let metadata_str = std::fs::read_to_string(&metadata_path)
        .map_err(|e| ImportError::Metadata(format!("read {}: {e}", metadata_path.display())))?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata_str)
        .map_err(|e| ImportError::Metadata(format!("parse {}: {e}", metadata_path.display())))?;

    let point_count = metadata
        .get("points")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let render_offset = parse_xyz(&metadata, "offset")?;
    let bb = metadata
        .get("boundingBox")
        .ok_or_else(|| ImportError::Metadata("missing boundingBox".to_string()))?;
    let bb_min = parse_xyz(bb, "min")?;
    let bb_max = parse_xyz(bb, "max")?;

    let attributes = metadata
        .get("attributes")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_color = attributes.iter().any(|a| {
        a.get("name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|n| matches!(n, "rgb" | "rgba" | "color"))
    });
    let has_intensity = attributes.iter().any(|a| {
        a.get("name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|n| n == "intensity")
    });

    tracing::info!(
        entity = %entity_id,
        points = point_count,
        bounds_min = ?bb_min,
        bounds_max = ?bb_max,
        "PotreeConverter completed"
    );

    Ok(LasImportSummary {
        source_path: path.to_string_lossy().into_owned(),
        source_name,
        point_count_total: point_count,
        point_count_loaded: point_count,
        bounds_min: bb_min,
        bounds_max: bb_max,
        render_offset,
        has_color,
        has_intensity,
        potree_dir: entity_dir.to_string_lossy().into_owned(),
        entity_id,
    })
}

struct ConverterOutput {
    status: ExitStatus,
    stdout_tail: String,
    stderr_tail: String,
}

struct StreamLine {
    stream: &'static str,
    line: String,
}

fn run_converter_streaming(
    converter: &Path,
    source: &Path,
    entity_dir: &Path,
    progress: &(dyn Fn(ConverterProgress) + Send + Sync),
) -> Result<ConverterOutput, ImportError> {
    progress(ConverterProgress {
        fraction: Some(0.01),
        message: "starting PotreeConverter".to_string(),
    });

    let mut child = Command::new(converter)
        .arg(source)
        .arg("-o")
        .arg(entity_dir)
        .arg("--encoding")
        .arg(ENCODING)
        .arg("-m")
        .arg(SAMPLING)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ImportError::Converter(format!("spawn failed: {e}")))?;

    let (tx, rx) = mpsc::channel::<StreamLine>();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ImportError::Converter("failed to capture converter stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ImportError::Converter("failed to capture converter stderr".to_string()))?;
    let stdout_thread = spawn_stream_reader(stdout, "stdout", tx.clone());
    let stderr_thread = spawn_stream_reader(stderr, "stderr", tx);

    let mut stdout_tail = String::new();
    let mut stderr_tail = String::new();
    let mut progress_state = ConverterProgressState::default();
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(line) => handle_converter_line(
                &line,
                &mut stdout_tail,
                &mut stderr_tail,
                &mut progress_state,
                progress,
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(done) = child
                    .try_wait()
                    .map_err(|e| ImportError::Converter(format!("wait failed: {e}")))?
                {
                    break done;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break child
                    .wait()
                    .map_err(|e| ImportError::Converter(format!("wait failed: {e}")))?;
            }
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    while let Ok(line) = rx.try_recv() {
        handle_converter_line(
            &line,
            &mut stdout_tail,
            &mut stderr_tail,
            &mut progress_state,
            progress,
        );
    }

    progress(ConverterProgress {
        fraction: Some(1.0),
        message: "PotreeConverter finished".to_string(),
    });

    Ok(ConverterOutput {
        status,
        stdout_tail,
        stderr_tail,
    })
}

fn spawn_stream_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    tx: mpsc::Sender<StreamLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0_u8; 4096];
        let mut line = String::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = String::from_utf8_lossy(&buf[..n]);
            for ch in chunk.chars() {
                if ch == '\n' || ch == '\r' {
                    emit_stream_line(stream, &mut line, &tx);
                } else {
                    line.push(ch);
                }
            }
        }
        emit_stream_line(stream, &mut line, &tx);
    })
}

fn emit_stream_line(stream: &'static str, line: &mut String, tx: &mpsc::Sender<StreamLine>) {
    let cleaned = strip_ansi(line).trim().to_string();
    line.clear();
    if cleaned.is_empty() {
        return;
    }
    let _ = tx.send(StreamLine {
        stream,
        line: cleaned,
    });
}

fn handle_converter_line(
    line: &StreamLine,
    stdout_tail: &mut String,
    stderr_tail: &mut String,
    progress_state: &mut ConverterProgressState,
    progress: &(dyn Fn(ConverterProgress) + Send + Sync),
) {
    if line.stream == "stderr" {
        push_tail(stderr_tail, &line.line, 4_000);
    } else {
        push_tail(stdout_tail, &line.line, 2_000);
    }
    if let Some(update) = progress_state.observe(&line.line) {
        progress(update);
    }
}

#[derive(Default)]
struct ConverterProgressState {
    last_fraction: f32,
    last_phase: &'static str,
}

impl ConverterProgressState {
    fn observe(&mut self, line: &str) -> Option<ConverterProgress> {
        let lower = line.to_ascii_lowercase();
        let (phase, start, end) = if lower.contains("counting") {
            ("counting points", 0.03_f32, 0.22_f32)
        } else if lower.contains("creating chunks")
            || lower.contains("chunking")
            || lower.contains("distribute")
        {
            ("creating chunks", 0.22_f32, 0.55_f32)
        } else if lower.contains("indexing") || lower.contains("sampling") {
            ("indexing octree", 0.55_f32, 0.96_f32)
        } else if lower.contains("writing") || lower.contains("metadata") {
            ("writing metadata", 0.96_f32, 0.99_f32)
        } else {
            ("converting", self.last_fraction, 0.99_f32)
        };

        let local = percent_from_line(line).or_else(|| ratio_from_line(line));
        let mut next = local.map_or(start, |f| start + (end - start) * f);
        next = next.clamp(0.0, 0.99_f32);
        if next < self.last_fraction {
            next = self.last_fraction;
        }

        let phase_changed = phase != self.last_phase;
        if !phase_changed && next - self.last_fraction < 0.005 {
            return None;
        }

        self.last_phase = phase;
        self.last_fraction = next;
        Some(ConverterProgress {
            fraction: Some(next),
            message: format!("{phase}: {}", compact_line(line, 96)),
        })
    }
}

fn parse_xyz(parent: &serde_json::Value, key: &str) -> Result<[f64; 3], ImportError> {
    let arr = parent
        .get(key)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ImportError::Metadata(format!("missing or non-array {key}")))?;
    if arr.len() != 3 {
        return Err(ImportError::Metadata(format!(
            "expected 3 elements in {key}, got {}",
            arr.len()
        )));
    }
    let coord = |i: usize| -> Result<f64, ImportError> {
        arr[i]
            .as_f64()
            .ok_or_else(|| ImportError::Metadata(format!("{key}[{i}] not a number")))
    };
    Ok([coord(0)?, coord(1)?, coord(2)?])
}

/// Resolve the platform-specific `PotreeConverter` binary.
///
/// Resolution order:
/// 1. `HIMMELCAD_VENDOR_DIR` env override (used by CI and the packaged build).
/// 2. `<workspace_root>/vendor/potreeconverter/<platform>/PotreeConverter` —
///    the dev layout populated by `scripts/fetch-vendor.mjs`.
fn locate_potreeconverter() -> Result<PathBuf, ImportError> {
    let platform_dir = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else {
        return Err(ImportError::Converter(
            "unsupported platform for PotreeConverter".to_string(),
        ));
    };
    let exe_name = if cfg!(target_os = "windows") {
        "PotreeConverter.exe"
    } else {
        "PotreeConverter"
    };

    if let Ok(env_dir) = env::var("HIMMELCAD_VENDOR_DIR") {
        let candidate = PathBuf::from(env_dir)
            .join("potreeconverter")
            .join(platform_dir)
            .join(exe_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest
        .join("../..")
        .join("vendor")
        .join("potreeconverter")
        .join(platform_dir)
        .join(exe_name);
    if dev_path.exists() {
        return Ok(dev_path.canonicalize().unwrap_or(dev_path));
    }

    Err(ImportError::Converter(format!(
        "PotreeConverter not found at {} — run `pnpm install` (the postinstall hook \
         fetches it) or `node scripts/fetch-vendor.mjs` manually",
        dev_path.display()
    )))
}

fn short_hash(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    format!("{:016x}", h.finish())
}

fn tail(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.trim().to_string();
    }
    let skip = s.chars().count() - max_chars;
    let trimmed: String = s.chars().skip(skip).collect();
    format!("…{}", trimmed.trim())
}

fn push_tail(buf: &mut String, line: &str, max_chars: usize) {
    buf.push_str(line);
    buf.push('\n');
    let count = buf.chars().count();
    if count > max_chars {
        let skip = count - max_chars;
        *buf = buf.chars().skip(skip).collect();
    }
}

fn compact_line(line: &str, max_chars: usize) -> String {
    let one_line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max_chars {
        return one_line;
    }
    let mut out = one_line
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        if chars.peek() == Some(&'[') {
            let _ = chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

fn percent_from_line(line: &str) -> Option<f32> {
    for (idx, ch) in line.char_indices() {
        if ch != '%' {
            continue;
        }
        let prefix = &line[..idx];
        let start = prefix
            .rfind(|c: char| !(c.is_ascii_digit() || c == '.' || c.is_ascii_whitespace()))
            .map_or(0, |i| i + 1);
        let raw = prefix[start..].trim();
        if raw.is_empty() {
            continue;
        }
        if let Ok(value) = raw.parse::<f32>() {
            if (0.0..=100.0).contains(&value) {
                return Some(value / 100.0);
            }
        }
    }
    None
}

fn ratio_from_line(line: &str) -> Option<f32> {
    for (idx, ch) in line.char_indices() {
        if ch != '/' {
            continue;
        }
        let before = &line[..idx];
        let after = &line[idx + 1..];
        let left_start = before
            .rfind(|c: char| !c.is_ascii_digit())
            .map_or(0, |i| i + 1);
        let right_end = after
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after.len());
        let left = before[left_start..].trim();
        let right = after[..right_end].trim();
        if left.is_empty() || right.is_empty() {
            continue;
        }
        let current = left.parse::<f32>().ok()?;
        let total = right.parse::<f32>().ok()?;
        if total > 0.0 && current >= 0.0 && current <= total {
            return Some((current / total).clamp(0.0, 1.0));
        }
    }
    None
}
