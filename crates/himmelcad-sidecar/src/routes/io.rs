use super::*;
use himmelcad_io::ProviderContractError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageParams {
    #[serde(default)]
    cursor: Option<String>,
    limit: usize,
}

const IO_RPC_SCHEMA_VERSION: u32 = 1;
const IO_PROBE_PREFIX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoProbeParams {
    source_path: String,
    #[serde(default)]
    media_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoImportExecuteParams {
    operation_id: String,
    command_id: String,
    source_path: String,
    selection: ImportProviderSelection,
    options: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoExportRequestParams {
    command_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<IoExportScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entity_ids: Option<Vec<String>>,
    provider_id: String,
    provider_version: String,
    target_path: String,
    format_id: String,
    options: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum IoExportScope {
    Selection,
    Visible,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoExportPlanEnvelope {
    schema_version: u32,
    #[serde(flatten)]
    request: IoExportRequestParams,
    #[serde(default)]
    entity_versions: BTreeMap<String, String>,
    plan: CanonicalExportPlan,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoExportExecuteParams {
    operation_id: String,
    accepted_plan: IoExportPlanEnvelope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoOperationParams {
    operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoOperationStatus {
    schema_version: u32,
    operation_id: String,
    state: IoOperationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<ProviderProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum IoOperationState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

struct IoOperationRecord {
    cancellation: Arc<AtomicBool>,
    status: IoOperationStatus,
}

#[derive(Default)]
pub struct IoOperations {
    records: Mutex<BTreeMap<String, IoOperationRecord>>,
}

impl IoOperations {
    pub fn begin(self: &Arc<Self>, operation_id: String) -> anyhow::Result<IoProviderContext> {
        validate_io_identity(&operation_id, "operationId")?;
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut records = self.records.lock().expect("I/O operation mutex poisoned");
        if records.contains_key(&operation_id) {
            anyhow::bail!("I/O operation identity was already used: {operation_id}");
        }
        records.insert(
            operation_id.clone(),
            IoOperationRecord {
                cancellation: cancellation.clone(),
                status: IoOperationStatus {
                    schema_version: IO_RPC_SCHEMA_VERSION,
                    operation_id: operation_id.clone(),
                    state: IoOperationState::Running,
                    progress: None,
                    message: None,
                },
            },
        );
        Ok(IoProviderContext {
            operation_id,
            cancellation,
            operations: Arc::clone(self),
        })
    }

    fn status(&self, operation_id: &str) -> Option<IoOperationStatus> {
        self.records
            .lock()
            .expect("I/O operation mutex poisoned")
            .get(operation_id)
            .map(|record| record.status.clone())
    }

    pub fn cancel(&self, operation_id: &str) -> bool {
        let records = self.records.lock().expect("I/O operation mutex poisoned");
        let Some(record) = records.get(operation_id) else {
            return false;
        };
        if record.status.state != IoOperationState::Running {
            return false;
        }
        record.cancellation.store(true, Ordering::Release);
        true
    }

    fn progress(&self, operation_id: &str, progress: ProviderProgress) {
        if let Some(record) = self
            .records
            .lock()
            .expect("I/O operation mutex poisoned")
            .get_mut(operation_id)
        {
            record.status.progress = Some(progress);
        }
    }

    pub fn finish(&self, operation_id: &str, result: &anyhow::Result<serde_json::Value>) {
        if let Some(record) = self
            .records
            .lock()
            .expect("I/O operation mutex poisoned")
            .get_mut(operation_id)
        {
            let cancelled = record.cancellation.load(Ordering::Acquire);
            record.status.state = if result.is_ok() {
                IoOperationState::Completed
            } else if cancelled {
                IoOperationState::Cancelled
            } else {
                IoOperationState::Failed
            };
            record.status.message = result.as_ref().err().map(ToString::to_string);
        }
    }
}

pub struct IoProviderContext {
    operation_id: String,
    pub cancellation: Arc<AtomicBool>,
    operations: Arc<IoOperations>,
}

impl ProviderOperationContext for IoProviderContext {
    fn is_cancelled(&self) -> bool {
        self.cancellation.load(Ordering::Acquire)
    }

    fn report_progress(&mut self, progress: ProviderProgress) {
        self.operations.progress(&self.operation_id, progress);
    }
}

fn run_tracked_io<F>(
    operations: Arc<IoOperations>,
    operation_id: String,
    operation: F,
) -> anyhow::Result<serde_json::Value>
where
    F: FnOnce(&mut IoProviderContext) -> anyhow::Result<serde_json::Value>,
{
    let mut context = operations.begin(operation_id.clone())?;
    let result = operation(&mut context);
    operations.finish(&operation_id, &result);
    result
}

pub(crate) fn validate_io_identity(value: &str, field: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 160
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "{field} is not a bounded portable identity"
    );
    Ok(())
}

fn export_entity_versions(
    package: &himmelcad_io::CanonicalImportPackage,
) -> BTreeMap<String, String> {
    package
        .admissions
        .iter()
        .map(|admission| {
            (
                admission.entity.id.0.clone(),
                admission.entity.version_hash.0.clone(),
            )
        })
        .collect()
}

fn io_probe_registry_root() -> PathBuf {
    std::env::temp_dir().join("himmelcad-io-registry")
}

fn io_probe_prefix(source: &Path) -> anyhow::Result<Vec<u8>> {
    let probe_path = if source.is_dir() {
        source.join("ready.json")
    } else {
        source.to_path_buf()
    };
    anyhow::ensure!(probe_path.is_file(), "I/O probe source has no ready.json");
    let mut prefix = Vec::new();
    std::fs::File::open(probe_path)?
        .take(IO_PROBE_PREFIX_BYTES)
        .read_to_end(&mut prefix)?;
    Ok(prefix)
}

fn require_provider_version(
    registry: &himmelcad_io::FormatProviderRegistry,
    provider_id: &str,
    provider_version: &str,
) -> anyhow::Result<()> {
    let descriptor = registry
        .descriptors()
        .into_iter()
        .find(|descriptor| descriptor.provider_id == provider_id)
        .ok_or_else(|| anyhow::anyhow!("I/O provider is unavailable: {provider_id}"))?;
    anyhow::ensure!(
        descriptor.provider_version == provider_version,
        "I/O provider version changed: selected {provider_version}, available {}",
        descriptor.provider_version
    );
    Ok(())
}

struct IoScratch {
    root: PathBuf,
}

impl IoScratch {
    fn create(operation_id: &str) -> anyhow::Result<Self> {
        validate_io_identity(operation_id, "operationId")?;
        let digest = hex::encode(Sha256::digest(operation_id.as_bytes()));
        let parent = std::env::temp_dir().join("himmelcad-io-operations");
        std::fs::create_dir_all(&parent)?;
        let root = parent.join(format!("{}-{digest}", std::process::id()));
        std::fs::create_dir(&root).with_context(|| {
            format!(
                "I/O scratch root already exists or cannot be created: {}",
                root.display()
            )
        })?;
        Ok(Self { root })
    }
}

impl Drop for IoScratch {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            tracing::warn!(path = %self.root.display(), %error, "failed to remove I/O scratch root");
        }
    }
}

pub(crate) fn public_import_commit<T: Serialize>(commit: T) -> anyhow::Result<serde_json::Value> {
    let mut value = serde_json::to_value(commit)?;
    if let Some(references) = value
        .pointer_mut("/inventory/externalObjects")
        .and_then(serde_json::Value::as_array_mut)
    {
        for reference in references {
            if let Some(reference) = reference.as_object_mut() {
                reference.remove("sourcePath");
            }
        }
    }
    Ok(value)
}

pub(crate) fn product_rpc_err(id: serde_json::Value, error: &anyhow::Error) -> RpcResponse {
    if let Some(ProviderContractError::ProductImportRefused {
        reason_code,
        message,
    }) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ProviderContractError>())
    {
        return rpc_err_with_data(
            id,
            -32028,
            message,
            serde_json::json!({
                "code": reason_code,
                "reasonCode": reason_code,
                "message": message,
                "retryable": false,
            }),
        );
    }
    rpc_err(id, -32000, &error.to_string())
}

pub(super) fn handle_io_formats_page(req: RpcRequest) -> RpcResponse {
    let params = match serde_json::from_value::<PageParams>(req.params) {
        Ok(params) if (1..=1_000).contains(&params.limit) => params,
        Ok(_) => return rpc_err(req.id, -32602, "page limit must be from 1 through 1000"),
        Err(error) => return rpc_err(req.id, -32602, &format!("invalid params: {error}")),
    };
    let start = match params.cursor.as_deref() {
        None => 0,
        Some(cursor) => match cursor.parse::<usize>() {
            Ok(cursor) => cursor,
            Err(_) => return rpc_err(req.id, -32602, "page cursor is invalid"),
        },
    };
    let registry = match canonical_builtin_import_registry(
        std::env::temp_dir().join("himmelcad-provider-discovery"),
    ) {
        Ok(registry) => registry,
        Err(error) => return rpc_err(req.id, -32603, &error.to_string()),
    };
    let items = registry.descriptors();
    if start > items.len() {
        return rpc_err(
            req.id,
            -32602,
            "page cursor is beyond the provider catalogue",
        );
    }
    let end = start.saturating_add(params.limit).min(items.len());
    // Omit nextCursor when exhausted — JSON null breaks TS clients that only
    // treat `undefined` as end-of-page (`null.length` throws).
    let mut page = serde_json::json!({
        "items": &items[start..end],
    });
    if end < items.len() {
        page["nextCursor"] = serde_json::Value::String(end.to_string());
    }
    rpc_result(req.id, Ok::<_, anyhow::Error>(page))
}

pub(super) async fn handle_io_rpc(
    req: RpcRequest,
    operations: Arc<IoOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "io.formats.page" => handle_io_formats_page(req),
        "io.probe" => {
            rpc_blocking_with_params::<IoProbeParams, _, _>(req.id, req.params, |params| {
                let source = PathBuf::from(params.source_path);
                anyhow::ensure!(
                    source.is_file() || source.is_dir(),
                    "I/O probe source is not a file or package directory"
                );
                let prefix = io_probe_prefix(&source)?;
                let registry = canonical_builtin_import_registry(io_probe_registry_root())?;
                registry
                    .select_importer(ImportProbeRequest {
                        path: &source,
                        prefix: &prefix,
                        media_type: params.media_type.as_deref(),
                    })
                    .map_err(anyhow::Error::from)
            })
            .await
        }
        "io.import.execute" => {
            let params = match serde_json::from_value::<IoImportExecuteParams>(req.params) {
                Ok(params) => params,
                Err(error) => {
                    return rpc_err(req.id, -32602, &format!("invalid params: {error}"));
                }
            };
            let operation_id = params.operation_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_tracked_io(operations, operation_id, |context| {
                    validate_io_identity(&params.command_id, "commandId")?;
                    let source = PathBuf::from(&params.source_path);
                    anyhow::ensure!(
                        source.is_file() || source.is_dir(),
                        "I/O import source is not a file or package directory"
                    );
                    let scratch = IoScratch::create(&context.operation_id)?;
                    let registry = canonical_builtin_import_registry(scratch.root.clone())?;
                    let staged =
                        registry.import(&params.selection, &source, &params.options, context)?;
                    let commit = canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import(&staged, &params.command_id)?;
                    public_import_commit(commit)
                })
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            match result {
                Ok(value) => rpc_result(req.id, Ok::<_, anyhow::Error>(value)),
                Err(error) => product_rpc_err(req.id, &error),
            }
        }
        "io.export.plan" => {
            rpc_blocking_with_params::<IoExportRequestParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    validate_io_identity(&params.command_id, "commandId")?;
                    let package = {
                        let runtime = canonical_app
                            .lock()
                            .expect("canonical app runtime mutex poisoned");
                        match &params.entity_ids {
                            Some(entity_ids) => {
                                if params.scope.is_none() {
                                    anyhow::bail!("entityIds require a user-level export scope");
                                }
                                for entity_id in entity_ids {
                                    validate_io_identity(entity_id, "entityIds")?;
                                }
                                runtime.reconstruct_export_package(entity_ids)?
                            }
                            None => runtime.reconstruct_import_package(&params.command_id)?,
                        }
                    };
                    let registry = canonical_builtin_import_registry(io_probe_registry_root())?;
                    require_provider_version(
                        &registry,
                        &params.provider_id,
                        &params.provider_version,
                    )?;
                    let plan = registry.plan_export(
                        &params.provider_id,
                        CanonicalExportRequest {
                            target: Path::new(&params.target_path),
                            format_id: &params.format_id,
                            package: &package,
                            options: &params.options,
                        },
                    )?;
                    Ok(IoExportPlanEnvelope {
                        schema_version: IO_RPC_SCHEMA_VERSION,
                        request: params,
                        entity_versions: export_entity_versions(&package),
                        plan,
                    })
                },
            )
            .await
        }
        "io.export.execute" => {
            let params = match serde_json::from_value::<IoExportExecuteParams>(req.params) {
                Ok(params) => params,
                Err(error) => {
                    return rpc_err(req.id, -32602, &format!("invalid params: {error}"));
                }
            };
            if params.accepted_plan.schema_version != IO_RPC_SCHEMA_VERSION {
                return rpc_err(req.id, -32602, "unsupported I/O export-plan schema version");
            }
            let operation_id = params.operation_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_tracked_io(operations, operation_id, |context| {
                    let accepted = params.accepted_plan;
                    validate_io_identity(&accepted.request.command_id, "commandId")?;
                    let scratch = IoScratch::create(&context.operation_id)?;
                    let package = {
                        let runtime = canonical_app
                            .lock()
                            .expect("canonical app runtime mutex poisoned");
                        let package = match &accepted.request.entity_ids {
                            Some(entity_ids) => {
                                let package = runtime.reconstruct_export_package(entity_ids)?;
                                anyhow::ensure!(
                                    !accepted.entity_versions.is_empty()
                                        && export_entity_versions(&package)
                                            == accepted.entity_versions,
                                    "export scope changed after planning; create a new export plan"
                                );
                                runtime.materialize_export_artifacts(&package, &scratch.root)?;
                                package
                            }
                            None => {
                                let package = runtime
                                    .reconstruct_import_package(&accepted.request.command_id)?;
                                runtime.materialize_import_artifacts(
                                    &accepted.request.command_id,
                                    &scratch.root,
                                )?;
                                package
                            }
                        };
                        package
                    };
                    let registry = canonical_builtin_import_registry(scratch.root.clone())?;
                    require_provider_version(
                        &registry,
                        &accepted.request.provider_id,
                        &accepted.request.provider_version,
                    )?;
                    registry.execute_export(
                        &accepted.request.provider_id,
                        CanonicalExportRequest {
                            target: Path::new(&accepted.request.target_path),
                            format_id: &accepted.request.format_id,
                            package: &package,
                            options: &accepted.request.options,
                        },
                        &accepted.plan,
                        context,
                    )?;
                    Ok(serde_json::json!({
                        "schemaVersion": IO_RPC_SCHEMA_VERSION,
                        "operationId": context.operation_id,
                        "outputs": accepted.plan.outputs,
                    }))
                })
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(req.id, result)
        }
        "io.operation.status" => match serde_json::from_value::<IoOperationParams>(req.params) {
            Ok(params) => match operations.status(&params.operation_id) {
                Some(status) => rpc_result(req.id, Ok::<_, anyhow::Error>(status)),
                None => rpc_err(req.id, -32000, "I/O operation is unknown"),
            },
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "io.operation.cancel" => match serde_json::from_value::<IoOperationParams>(req.params) {
            Ok(params) => rpc_result(
                req.id,
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaVersion": IO_RPC_SCHEMA_VERSION,
                    "operationId": params.operation_id,
                    "cancellationRequested": operations.cancel(&params.operation_id),
                })),
            ),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        other => rpc_err(req.id, -32601, &format!("I/O method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "io.export.execute",
    "io.export.plan",
    "io.formats.page",
    "io.import.execute",
    "io.operation.cancel",
    "io.operation.status",
    "io.probe",
];

#[derive(Clone)]
struct IoContext {
    operations: Arc<IoOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct IoModule(IoContext);

impl IoModule {
    pub(super) fn new(
        operations: Arc<IoOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(IoContext {
            operations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for IoModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_io_rpc(
                    request,
                    context.operations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn rpc_request(method: &str, params: serde_json::Value) -> RpcRequest {
        RpcRequest {
            jsonrpc: "2.0".to_owned(),
            id: serde_json::json!(1),
            method: method.to_owned(),
            params,
        }
    }

    #[test]
    fn io_provider_discovery_is_stable_and_paginated() {
        let first = handle_io_formats_page(rpc_request(
            "io.formats.page",
            serde_json::json!({ "limit": 2 }),
        ));
        assert!(first.error.is_none());
        let result = first.result.expect("format result");
        assert_eq!(result["items"].as_array().map(Vec::len), Some(2));
        assert!(result["nextCursor"].is_string());
    }

    #[tokio::test]
    async fn io_probe_is_bounded_and_returns_a_version_frozen_selection() {
        let source = std::env::temp_dir().join(format!(
            "himmelcad-io-probe-{}-{}.dxf",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(&source, b"0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n")
            .expect("probe source");
        let response = handle_io_rpc(
            rpc_request(
                "io.probe",
                serde_json::json!({ "sourcePath": source, "mediaType": "image/vnd.dxf" }),
            ),
            Arc::new(IoOperations::default()),
            Arc::new(Mutex::new(CanonicalAppRuntime::default())),
        )
        .await;
        std::fs::remove_file(&source).expect("cleanup");
        assert!(response.error.is_none(), "{:?}", response.error);
        let selection = response.result.expect("probe selection");
        assert_eq!(selection["providerId"], "hcad.io.dxf-rs@1");
        assert_eq!(selection["formatId"], "dxf@r12-r2018-ascii");
        assert!(selection["providerVersion"].is_string());
    }

    #[test]
    fn generic_io_operation_cancel_is_visible_to_every_provider() {
        let operations = Arc::new(IoOperations::default());
        let context = operations
            .begin("generic-import-1".to_owned())
            .expect("begin operation");
        assert!(!context.is_cancelled());
        assert!(operations.cancel("generic-import-1"));
        assert!(context.is_cancelled());
        let result = Err(anyhow::anyhow!("cancelled"));
        operations.finish("generic-import-1", &result);
        assert_eq!(
            operations.status("generic-import-1").expect("status").state,
            IoOperationState::Cancelled
        );
        assert!(operations.begin("generic-import-1".to_owned()).is_err());
    }

    #[test]
    fn exporter_capabilities_and_version_drift_fail_closed() {
        let registry =
            canonical_builtin_import_registry(io_probe_registry_root()).expect("built-in registry");
        for provider_id in ["hcad.io.las-potree@1", "hcad.io.e57-potree@1"] {
            let descriptor = registry
                .descriptors()
                .into_iter()
                .find(|descriptor| descriptor.provider_id == provider_id)
                .expect("import descriptor");
            assert!(descriptor
                .capabilities
                .contains(&himmelcad_io::FormatCapability::Import));
            assert!(!descriptor
                .capabilities
                .contains(&himmelcad_io::FormatCapability::Export));
            assert!(registry.exporter(provider_id).is_err());
        }
        assert!(
            require_provider_version(&registry, "hcad.io.dxf-rs@1", "changed-version").is_err()
        );
    }
}
