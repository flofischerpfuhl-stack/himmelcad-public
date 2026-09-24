use super::*;

pub(super) async fn handle_builder_archive_rpc(
    req: RpcRequest,
    operations: Arc<IoOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "builder.project.archive.pack" => {
            let params = match serde_json::from_value::<BuilderArchivePackParams>(req.params) {
                Ok(params) => params,
                Err(error) => {
                    return rpc_err(req.id, -32602, &format!("invalid params: {error}"));
                }
            };
            let operation_id = params.operation_id.clone();
            let operation_id_for_finish = operation_id.clone();
            let finish_operations = Arc::clone(&operations);
            let result = rpc_blocking(req.id, move || {
                let context = operations.begin(operation_id.clone())?;
                let result = (|| -> anyhow::Result<serde_json::Value> {
                    let mut runtime = canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned");
                    runtime.flush()?;
                    let opened_root = runtime.project_root()?;
                    anyhow::ensure!(
                        opened_root == params.project_root,
                        "archive source is not the open Builder project"
                    );
                    let summary = pack_hcadx_replace_with_cancel(
                        &opened_root,
                        &params.destination,
                        PackArchiveOptions {
                            include_rebuildable_index: false,
                        },
                        || context.cancellation.load(Ordering::Acquire),
                        |progress| emit_builder_archive_progress(&params.progress_key, &progress),
                    )?;
                    Ok(serde_json::to_value(summary)?)
                })();
                finish_operations.finish(&operation_id_for_finish, &result);
                result
            })
            .await;
            result
        }
        "builder.project.archive.unpack" => {
            let params = match serde_json::from_value::<BuilderArchiveUnpackParams>(req.params) {
                Ok(params) => params,
                Err(error) => {
                    return rpc_err(req.id, -32602, &format!("invalid params: {error}"));
                }
            };
            let operation_id = params.operation_id.clone();
            let operation_id_for_finish = operation_id.clone();
            let finish_operations = Arc::clone(&operations);
            rpc_blocking(req.id, move || {
                let context = operations.begin(operation_id.clone())?;
                let result = (|| -> anyhow::Result<serde_json::Value> {
                    let summary = unpack_hcadx_with_cancel(
                        &params.source,
                        &params.destination,
                        UnpackArchiveLimits {
                            max_entries: 1_000_000,
                            max_declared_bytes: 2_u64 * 1024 * 1024 * 1024 * 1024,
                        },
                        || context.cancellation.load(Ordering::Acquire),
                        |progress| emit_builder_archive_progress(&params.progress_key, &progress),
                    )?;
                    Ok(serde_json::to_value(summary)?)
                })();
                finish_operations.finish(&operation_id_for_finish, &result);
                result
            })
            .await
        }
        "builder.project.archive.cancel" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                operation_id: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    Ok::<_, anyhow::Error>(serde_json::json!({
                        "operationId": params.operation_id,
                        "cancellationRequested": operations.cancel(&params.operation_id),
                    })),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

#[allow(clippy::cast_precision_loss)]

pub(super) const METHODS: &[&str] = &[
    "builder.project.archive.cancel",
    "builder.project.archive.pack",
    "builder.project.archive.unpack",
];

#[derive(Clone)]
struct BuilderArchiveContext {
    operations: Arc<IoOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct BuilderArchiveModule(BuilderArchiveContext);

impl BuilderArchiveModule {
    pub(super) fn new(
        operations: Arc<IoOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(BuilderArchiveContext {
            operations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for BuilderArchiveModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_builder_archive_rpc(
                    request,
                    context.operations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}
