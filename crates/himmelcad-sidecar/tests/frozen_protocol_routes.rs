use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

fn golden_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn golden_inventory() -> serde_json::Value {
    let path = golden_root().join("route-inventory.json");
    serde_json::from_slice(&fs::read(&path).expect("read route inventory golden"))
        .expect("parse route inventory golden")
}

fn product_inventory(product: &str) -> serde_json::Value {
    serde_json::Value::Array(
        golden_inventory()
            .as_array()
            .expect("route inventory array")
            .iter()
            .filter(|route| route["product"] == "shared" || route["product"] == product)
            .cloned()
            .collect(),
    )
}

fn product_binary(name: &str) -> PathBuf {
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    std::env::current_exe()
        .expect("resolve test executable")
        .parent()
        .and_then(Path::parent)
        .expect("resolve Cargo target profile directory")
        .join(executable)
}

fn registered_inventory(binary: &Path) -> serde_json::Value {
    let output = Command::new(binary)
        .arg("--list-routes")
        .output()
        .unwrap_or_else(|error| {
            panic!("ask {} for its route inventory: {error}", binary.display())
        });
    assert!(
        output.status.success(),
        "route inventory command failed for {}: {}",
        binary.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("parse registered route inventory")
}

#[test]
fn registered_route_inventory_matches_golden() {
    assert_eq!(
        registered_inventory(&product_binary("himmelcad-builder-sidecar")),
        product_inventory("builder"),
        "Builder routes changed; inspect registration and deliberately update the golden"
    );
    assert_eq!(
        registered_inventory(&product_binary("himmelcad-photolab-sidecar")),
        product_inventory("photolab"),
        "PhotoLab routes changed; inspect registration and deliberately update the golden"
    );
}

#[test]
fn registered_route_products_match_golden() {
    let products = |inventory: &serde_json::Value| {
        inventory
            .as_array()
            .expect("route inventory array")
            .iter()
            .map(|route| {
                (
                    route["method"].as_str().expect("route method").to_owned(),
                    route["product"].as_str().expect("route product").to_owned(),
                )
            })
            .collect::<Vec<_>>()
    };
    for (binary, product) in [
        ("himmelcad-builder-sidecar", "builder"),
        ("himmelcad-photolab-sidecar", "photolab"),
    ] {
        assert_eq!(
            products(&registered_inventory(&product_binary(binary))),
            products(&product_inventory(product)),
        );
    }
}

fn corpus_scratch_root() -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .expect("resolve repository root")
        .join(".build/split-s2")
}

fn corpus_sidecar_binary(request: &[u8]) -> PathBuf {
    if let Some(binary) = std::env::var_os("HIMMELCAD_SIDECAR_FIXTURE_BIN") {
        return PathBuf::from(binary);
    }
    let inventory = golden_inventory();
    let products = request
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_slice::<serde_json::Value>(line).expect("parse fixture request")
        })
        .map(|request| {
            let method = request["method"].as_str().expect("fixture request method");
            inventory
                .as_array()
                .expect("route inventory array")
                .iter()
                .find(|route| route["method"] == method)
                .map_or("shared", |route| {
                    route["product"].as_str().expect("route product")
                })
                .to_owned()
        })
        .filter(|product| product != "shared")
        .collect::<std::collections::BTreeSet<_>>();
    assert!(products.len() <= 1, "fixture mixes product-only route sets");
    if products.contains("photolab") {
        product_binary("himmelcad-photolab-sidecar")
    } else {
        product_binary("himmelcad-builder-sidecar")
    }
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

        let mut child = Command::new(corpus_sidecar_binary(&request))
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
