use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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

#[test]
fn dispatched_route_inventory_matches_golden() {
    let path = golden_root().join("route-inventory.json");
    let expected: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("read route inventory golden"))
            .expect("parse route inventory golden");
    assert_eq!(
        extracted_inventory(),
        expected,
        "sidecar routes changed; inspect the dispatch and deliberately update the golden"
    );
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

    for request_path in requests {
        let stem = request_path
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("fixture request name");
        let expected_path = responses.join(format!("{stem}.response"));
        let request = fs::read(&request_path).expect("read request fixture");
        let expected = fs::read(&expected_path).expect("read response fixture");
        assert!(
            request.ends_with(b"\n"),
            "request fixture must end in a newline"
        );
        assert!(
            expected.ends_with(b"\n"),
            "response fixture must end in a newline"
        );

        let mut child = Command::new(env!("CARGO_BIN_EXE_himmelcad-sidecar"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sidecar fixture process");
        child
            .stdin
            .take()
            .expect("sidecar stdin")
            .write_all(&request)
            .expect("write fixture request");
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
        let mut stdout = Vec::new();
        child
            .stdout
            .take()
            .expect("sidecar stdout")
            .read_to_end(&mut stdout)
            .expect("read sidecar stdout");
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
        assert_eq!(
            stdout, expected,
            "{stem}: dispatcher response bytes changed"
        );
    }
}
