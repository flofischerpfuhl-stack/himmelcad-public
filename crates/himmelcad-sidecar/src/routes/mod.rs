//! Shared wire routes and exact-method registration for every product host.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use himmelcad_command::{CommandRegistry, RpcModule};
use himmelcad_core::app_protocol::{
    AppProtocolError, AppProtocolRequest, AppProtocolRequestEnvelope, AppProtocolResponse,
    AppProtocolResponseEnvelope, APP_PROTOCOL_SCHEMA_ID,
};
use himmelcad_domain_registration::registration::{
    IcpMode, IcpOptions, RegistrationPointPair, RegistrationRecipe, RegistrationTargetSample,
};
use himmelcad_io::{
    canonical_builtin_import_registry, CanonicalExportPlan, CanonicalExportRequest,
    ImportProbeRequest, ImportProviderSelection, ProviderOperationContext, ProviderProgress,
};
use himmelcad_model::hash::ObjectHash;
use himmelcad_process::jobs::CancellationToken;
use himmelcad_transform::transform::{Similarity3D, WorldPoint};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::automation_runtime::{
    AutomationRuntime, BulkReadRequest, BulkReleaseRequest, CasDescribeRequest,
    CommandStatusRequest, CommandValidateRequest, EntityPageRequest,
};
use crate::canonical_app_runtime::CanonicalAppRuntime;
use crate::import_registration_runtime::ImportRegistrationRuntime;
use crate::site_calibration_reader::inspect_site_calibration;

mod automation;
mod canonical_app;
mod io;
mod registration;
mod root;

use crate::host::emit_progress;
pub use io::IoOperations;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

pub type SidecarCommandRegistry = CommandRegistry<(), RpcRequest, RpcResponse>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteDefinition {
    pub method: &'static str,
    pub family: &'static str,
    pub product: &'static str,
}

pub fn definitions(
    methods: &'static [&'static str],
    family: &'static str,
    product: &'static str,
) -> impl Iterator<Item = RouteDefinition> {
    methods.iter().copied().map(move |method| RouteDefinition {
        method,
        family,
        product,
    })
}

#[derive(Clone)]
pub struct SharedRouteServices {
    pub automation: Arc<AutomationRuntime>,
    pub canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    pub io_operations: Arc<IoOperations>,
    pub registrations: Arc<ImportRegistrationRuntime>,
}

impl SharedRouteServices {
    pub fn new() -> Result<Self> {
        Ok(Self {
            automation: Arc::new(AutomationRuntime::new()?),
            canonical_app: Arc::new(Mutex::new(CanonicalAppRuntime::default())),
            io_operations: Arc::new(IoOperations::default()),
            registrations: Arc::new(ImportRegistrationRuntime::default()),
        })
    }
}

pub fn register_shared_routes(
    registry: &mut SidecarCommandRegistry,
    services: &SharedRouteServices,
) -> Result<()> {
    canonical_app::CanonicalAppModule::shared(
        Arc::clone(&services.canonical_app),
        Arc::clone(&services.automation),
    )
    .register(registry)?;
    automation::AutomationModule::new(
        Arc::clone(&services.automation),
        Arc::clone(&services.canonical_app),
    )
    .register(registry)?;
    io::IoModule::new(
        Arc::clone(&services.io_operations),
        Arc::clone(&services.canonical_app),
    )
    .register(registry)?;
    registration::RegistrationModule::new(
        Arc::clone(&services.registrations),
        Arc::clone(&services.canonical_app),
    )
    .register(registry)?;
    root::RootModule.register(registry)?;
    Ok(())
}

pub fn shared_route_definitions() -> Vec<RouteDefinition> {
    let mut routes = Vec::new();
    routes.extend(definitions(
        canonical_app::SHARED_METHODS,
        "canonical-app",
        "shared",
    ));
    routes.extend(definitions(automation::METHODS, "automation", "shared"));
    routes.extend(definitions(io::METHODS, "io", "shared"));
    routes.extend(definitions(registration::METHODS, "registration", "shared"));
    routes.extend(definitions(root::METHODS, "root", "shared"));
    routes
}

pub fn rpc_err(id: serde_json::Value, code: i32, message: &str) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_owned(),
            data: None,
        }),
    }
}

pub fn rpc_err_with_data(
    id: serde_json::Value,
    code: i32,
    message: &str,
    data: serde_json::Value,
) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_owned(),
            data: Some(data),
        }),
    }
}

pub fn rpc_result<T: Serialize>(id: serde_json::Value, result: anyhow::Result<T>) -> RpcResponse {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => RpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(value),
                error: None,
            },
            Err(error) => rpc_err(id, -32603, &format!("failed to encode result: {error}")),
        },
        Err(error) => rpc_err(id, -32000, &error.to_string()),
    }
}

pub async fn rpc_blocking<T, F>(id: serde_json::Value, operation: F) -> RpcResponse
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(operation)
        .await
        .map_err(anyhow::Error::from)
        .and_then(std::convert::identity);
    rpc_result(id, result)
}

pub async fn rpc_blocking_with_params<P, T, F>(
    id: serde_json::Value,
    params: serde_json::Value,
    operation: F,
) -> RpcResponse
where
    P: for<'de> Deserialize<'de> + Send + 'static,
    T: Serialize + Send + 'static,
    F: FnOnce(P) -> anyhow::Result<T> + Send + 'static,
{
    match serde_json::from_value::<P>(params) {
        Ok(params) => rpc_blocking(id, move || operation(params)).await,
        Err(error) => rpc_err(id, -32602, &format!("invalid params: {error}")),
    }
}
