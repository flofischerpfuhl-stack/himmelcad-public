use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const MAIN_SOURCE: &str = include_str!("../src/main.rs");

fn quoted_strings(line: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('"') else { break };
        result.push(&rest[..end]);
        rest = &rest[end + 1..];
    }
    result
}

fn function_name(line: &str) -> Option<&str> {
    let line = line.trim_start();
    let tail = line
        .strip_prefix("async fn ")
        .or_else(|| line.strip_prefix("fn "))?;
    tail.split_once('(').map(|(name, _)| name.trim())
}

fn family_for(function: &str) -> Option<&'static str> {
    Some(match function {
        "handle" => "root",
        "handle_pointcloud_segment_rpc" => "pointcloud-segment",
        "handle_pointcloud_ground_rpc" => "pointcloud-ground",
        "handle_mesh_surface_rpc" => "mesh-surface",
        "handle_pointcloud_sampling_rpc" => "pointcloud-processing",
        "handle_builder_archive_rpc" => "builder-archive",
        "handle_himmelcap_rpc" => "photolab-himmelcap",
        "handle_capture_rpc" => "photolab-capture",
        "handle_canonical_app_rpc" => "canonical-app",
        "handle_automation_rpc" => "automation",
        "handle_registration_rpc" => "registration",
        "handle_io_rpc" => "io",
        "handle_product_rpc" => "photolab-products",
        "handle_image_rpc" => "photolab-images",
        "handle_gcp_rpc" => "photolab-gcp",
        "handle_crs_rpc" => "photolab-crs",
        "handle_project_rpc" => "photolab-project",
        "handle_job_rpc" => "photolab-jobs",
        _ => return None,
    })
}

fn looks_like_method(value: &str) -> bool {
    value == "ping"
        || (value.contains('.')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
}

fn brace_delta(line: &str) -> i32 {
    let mut delta = 0;
    let mut quoted = false;
    let mut escaped = false;
    for byte in line.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b'{' {
            delta += 1;
        } else if byte == b'}' {
            delta -= 1;
        }
    }
    delta
}

fn product_for(method: &str) -> &'static str {
    if method.starts_with("photolab.") {
        "photolab"
    } else if method.starts_with("builder.")
        || method.starts_with("pointcloud.")
        || method.starts_with("mesh.")
        || method.starts_with("measurement.")
        || method.starts_with("draw.")
        || method.starts_with("view.bookmark.")
        || method.starts_with("snapshot.")
        || method.starts_with("product.import.")
        || matches!(method, "import.las" | "import.las.cancel" | "import.ifc")
        || matches!(method, "project.flush" | "project.undo" | "project.redo")
        || method.starts_with("canonical.viewing_box.")
    {
        "builder"
    } else {
        "shared"
    }
}

fn assert_all_method_dispatchers_classified() {
    let mut current_function = "";
    for line in MAIN_SOURCE.lines() {
        if let Some(name) = function_name(line) {
            current_function = name;
        }
        if line.contains("match req.method.as_str() {") {
            assert!(
                family_for(current_function).is_some(),
                "method dispatcher {current_function} needs an inventory family"
            );
        }
    }
}

fn extracted_inventory() -> serde_json::Value {
    assert_all_method_dispatchers_classified();
    let mut current_function = "";
    let mut method_match_depth = 0;
    let mut arm_pattern = String::new();
    let mut routes = Vec::<(String, String)>::new();
    for line in MAIN_SOURCE.lines() {
        if let Some(name) = function_name(line) {
            current_function = name;
            method_match_depth = 0;
            arm_pattern.clear();
        }
        let Some(family) = family_for(current_function) else {
            continue;
        };
        let trimmed = line.trim_start();
        let is_direct_dispatch =
            current_function == "handle" && trimmed.starts_with("if req.method ==");
        let is_canonical_special = current_function == "handle_canonical_app_rpc"
            && trimmed.starts_with("if req.method == \"app.negotiate\"");
        if is_direct_dispatch || is_canonical_special {
            for method in quoted_strings(line)
                .into_iter()
                .filter(|method| looks_like_method(method))
            {
                routes.push((method.to_owned(), family.to_owned()));
            }
        }

        if method_match_depth == 0 {
            if trimmed.contains("match req.method.as_str() {") {
                method_match_depth = brace_delta(line);
            }
            continue;
        }

        if method_match_depth == 1 && (trimmed.starts_with('"') || !arm_pattern.is_empty()) {
            arm_pattern.push_str(trimmed);
            arm_pattern.push(' ');
            if arm_pattern.contains("=>") {
                let route_text = arm_pattern.split("=>").next().unwrap_or(&arm_pattern);
                for method in quoted_strings(route_text)
                    .into_iter()
                    .filter(|method| looks_like_method(method))
                {
                    routes.push((method.to_owned(), family.to_owned()));
                }
                arm_pattern.clear();
            }
        }
        method_match_depth += brace_delta(line);
    }
    routes.sort();
    routes.dedup_by(|left, right| left.0 == right.0);
    serde_json::Value::Array(
        routes
            .into_iter()
            .map(|(method, handler_family)| {
                let product = product_for(&method);
                serde_json::json!({
                    "method": method,
                    "handlerFamily": handler_family,
                    "product": product,
                })
            })
            .collect(),
    )
}

fn golden_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn golden_inventory() -> serde_json::Value {
    let path = golden_root().join("route-inventory.json");
    serde_json::from_slice(&fs::read(&path).expect("read route inventory golden"))
        .expect("parse route inventory golden")
}

#[test]
fn dispatched_route_inventory_matches_golden() {
    assert_eq!(
        extracted_inventory(),
        golden_inventory(),
        "sidecar routes changed; inspect the dispatch and deliberately update the golden"
    );
}

#[test]
fn registered_route_inventory_matches_golden() {
    let output = Command::new(env!("CARGO_BIN_EXE_himmelcad-sidecar"))
        .arg("--list-routes")
        .output()
        .expect("ask the sidecar registry for its route inventory");
    assert!(
        output.status.success(),
        "route inventory command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse registered route inventory");
    assert_eq!(
        actual,
        golden_inventory(),
        "registered routes changed; inspect registration and deliberately update the golden"
    );
}

fn corpus_scratch_root() -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .expect("resolve repository root")
        .join(".build/split-s2")
}

fn corpus_sidecar_binary() -> PathBuf {
    std::env::var_os("HIMMELCAD_SIDECAR_FIXTURE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_himmelcad-sidecar")))
}

fn replace_literal(bytes: Vec<u8>, from: &str, to: &str) -> Vec<u8> {
    String::from_utf8(bytes)
        .expect("sidecar response is UTF-8 JSON")
        .replace(from, to)
        .into_bytes()
}

fn normalize_session_id(bytes: Vec<u8>) -> Vec<u8> {
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).expect("parse negotiation response");
    let session_id = value
        .pointer("/result/sessionId")
        .and_then(serde_json::Value::as_str)
        .expect("negotiation response session id");
    replace_literal(bytes, session_id, "<session-id>")
}

fn normalize_lifecycle(bytes: Vec<u8>, project_root: &Path) -> Vec<u8> {
    let first_line_end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("lifecycle create response newline");
    let create: serde_json::Value =
        serde_json::from_slice(&bytes[..first_line_end]).expect("parse lifecycle create response");
    let project_id = create
        .pointer("/result/manifest/projectId")
        .and_then(serde_json::Value::as_str)
        .expect("lifecycle project id")
        .to_owned();
    let session_id = create
        .pointer("/result/session/sessionId")
        .and_then(serde_json::Value::as_str)
        .expect("lifecycle session id")
        .to_owned();
    let created_unix_ms = create
        .pointer("/result/manifest/createdUnixMs")
        .and_then(serde_json::Value::as_u64)
        .expect("lifecycle creation timestamp");
    let modified_unix_ms = create
        .pointer("/result/manifest/modifiedUnixMs")
        .and_then(serde_json::Value::as_u64)
        .expect("lifecycle modification timestamp");
    let entities = create
        .pointer("/result/manifest/entities")
        .and_then(serde_json::Value::as_object)
        .expect("lifecycle entities");
    let mut version_hashes = Vec::new();
    for (entity_id, entity) in entities {
        let suffix = entity_id
            .strip_prefix(&format!("{project_id}:"))
            .expect("initial entity belongs to lifecycle project");
        let version_hash = entity
            .get("versionHash")
            .and_then(serde_json::Value::as_str)
            .expect("initial entity version hash");
        version_hashes.push((version_hash.to_owned(), format!("<version-hash-{suffix}>")));
    }

    // This fixture normalizes only values generated by project creation:
    // its scratch path, project/session ids, two timestamps, and the five
    // initial entity hashes derived from those values. All other bytes remain
    // in the digest comparison below.
    let mut normalized = replace_literal(
        bytes,
        project_root.to_str().expect("UTF-8 lifecycle project path"),
        "<project-root>",
    );
    normalized = replace_literal(normalized, &session_id, "<session-id>");
    for (version_hash, replacement) in version_hashes {
        normalized = replace_literal(normalized, &version_hash, &replacement);
    }
    normalized = replace_literal(
        normalized,
        &format!("\"createdUnixMs\":{created_unix_ms}"),
        "\"createdUnixMs\":0",
    );
    normalized = replace_literal(
        normalized,
        &format!("\"modifiedUnixMs\":{modified_unix_ms}"),
        "\"modifiedUnixMs\":0",
    );
    normalized = replace_literal(normalized, &project_id, "<project-id>");
    format!("sha256:{}\n", hex::encode(Sha256::digest(normalized))).into_bytes()
}

fn normalize_response(stem: &str, bytes: Vec<u8>, project_root: &Path) -> Vec<u8> {
    match stem {
        "canonical-app-negotiate-success" => normalize_session_id(bytes),
        "photolab-project-lifecycle-success" => normalize_lifecycle(bytes, project_root),
        _ => bytes,
    }
}

#[test]
fn response_corpus_matches_exact_sidecar_bytes() {
    let responses = golden_root().join("responses");
    let mut requests = fs::read_dir(&responses)
        .expect("read response corpus")
        .map(|entry| entry.expect("read response corpus entry").path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("request"))
        .collect::<Vec<_>>();
    requests.sort();
    assert!(!requests.is_empty(), "response corpus is empty");

    let scratch_root = corpus_scratch_root();
    fs::create_dir_all(&scratch_root).expect("create split-s2 corpus scratch root");

    for request_path in requests {
        let stem = request_path
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("fixture request name");
        let expected_path = responses.join(format!("{stem}.response"));
        let mut request = fs::read(&request_path).expect("read request fixture");
        let expected = fs::read(&expected_path).expect("read response fixture");
        assert!(
            request.ends_with(b"\n"),
            "request fixture must end in a newline"
        );
        assert!(
            expected.ends_with(b"\n"),
            "response fixture must end in a newline"
        );

        let project_root =
            scratch_root.join(format!("protocol-lifecycle-{}.hcad", std::process::id()));
        if project_root.exists() {
            fs::remove_dir_all(&project_root).expect("remove stale lifecycle fixture project");
        }
        request = replace_literal(
            request,
            "{{PROJECT_ROOT}}",
            project_root.to_str().expect("UTF-8 lifecycle project path"),
        );

        let mut child = Command::new(corpus_sidecar_binary())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sidecar fixture process");
        let mut stdin = child.stdin.take().expect("sidecar stdin");
        let child_stdout = child.stdout.take().expect("sidecar stdout");
        let (stdout_tx, stdout_rx) = std::sync::mpsc::channel::<std::io::Result<Vec<u8>>>();
        let stdout_reader = std::thread::spawn(move || {
            let mut stdout = std::io::BufReader::new(child_stdout);
            loop {
                let mut line = Vec::new();
                match stdout.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if stdout_tx.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = stdout_tx.send(Err(error));
                        break;
                    }
                }
            }
        });
        let mut actual = Vec::new();
        for request_line in request.split_inclusive(|byte| *byte == b'\n') {
            if request_line.is_empty() {
                continue;
            }
            stdin
                .write_all(request_line)
                .expect("write fixture request line");
            stdin.flush().expect("flush fixture request line");
            match stdout_rx.recv_timeout(Duration::from_secs(20)) {
                Ok(Ok(line)) => actual.extend_from_slice(&line),
                Ok(Err(error)) => panic!("{stem}: failed to read fixture response: {error}"),
                Err(error) => {
                    child
                        .kill()
                        .expect("kill timed-out sidecar fixture process");
                    child
                        .wait()
                        .expect("reap timed-out sidecar fixture process");
                    panic!("{stem}: no sidecar response within 20 seconds: {error}");
                }
            }
        }
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().expect("poll sidecar fixture process") {
                break status;
            }
            if Instant::now() >= deadline {
                child
                    .kill()
                    .expect("kill timed-out sidecar fixture process");
                child
                    .wait()
                    .expect("reap timed-out sidecar fixture process");
                panic!("{stem}: sidecar fixture process exceeded 20 seconds");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        stdout_reader.join().expect("join sidecar stdout reader");
        for remaining in stdout_rx.try_iter() {
            actual.extend_from_slice(&remaining.expect("read remaining sidecar stdout"));
        }
        let mut stderr = Vec::new();
        child
            .stderr
            .take()
            .expect("sidecar stderr")
            .read_to_end(&mut stderr)
            .expect("read sidecar stderr");
        assert!(
            status.success(),
            "{stem}: sidecar failed: {}",
            String::from_utf8_lossy(&stderr)
        );
        let actual = normalize_response(stem, actual, &project_root);
        assert_eq!(
            actual, expected,
            "{stem}: dispatcher response bytes changed"
        );
        if project_root.exists() {
            fs::remove_dir_all(&project_root).expect("remove lifecycle fixture project");
        }
    }
}
