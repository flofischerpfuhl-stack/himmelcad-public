use super::*;

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
