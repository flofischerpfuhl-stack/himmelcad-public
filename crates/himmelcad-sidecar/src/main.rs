//! Himmelcad sidecar: a long-running OS process that speaks JSON-RPC 2.0 over
//! stdio. Electron's main process spawns and supervises this binary.
//!
//! The sidecar holds the authoritative project state (entity store, command
//! journal, spatial indexes). The renderer mirrors snapshots and never mutates
//! state directly.

#![forbid(unsafe_code)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // params is part of the JSON-RPC contract; consumed once handlers exist.
struct RpcRequest {
    jsonrpc: String,
    id: serde_json::Value,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "himmelcad-sidecar starting"
    );

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(req) => handle(req).await,
            Err(err) => RpcResponse {
                jsonrpc: "2.0",
                id: serde_json::Value::Null,
                result: None,
                error: Some(RpcError {
                    code: -32700,
                    message: format!("parse error: {err}"),
                }),
            },
        };

        let json = serde_json::to_string(&response)?;
        stdout.write_all(json.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }

    Ok(())
}

// INVARIANT: kept async because real handlers (import, indexing, project IO)
// will be async; signature stability avoids touching the dispatch loop later.
#[allow(clippy::unused_async)]
async fn handle(req: RpcRequest) -> RpcResponse {
    if req.jsonrpc != "2.0" {
        return RpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: None,
            error: Some(RpcError {
                code: -32600,
                message: "invalid jsonrpc version".into(),
            }),
        };
    }

    match req.method.as_str() {
        "ping" => RpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })),
            error: None,
        },
        other => RpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: None,
            error: Some(RpcError {
                code: -32601,
                message: format!("method not found: {other}"),
            }),
        },
    }
}
