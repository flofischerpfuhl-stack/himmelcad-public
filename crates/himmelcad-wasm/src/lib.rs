//! WASM facade for Weltview.
//!
//! Mirrors the sidecar JSON-RPC surface, but transported over `postMessage`
//! between the UI thread and a Web Worker hosting this module. The same Rust
//! core powers both targets.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn ping() -> String {
    serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }).to_string()
}
