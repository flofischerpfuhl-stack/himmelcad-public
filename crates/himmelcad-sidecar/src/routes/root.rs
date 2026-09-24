use super::*;

pub(super) const SHARED_METHODS: &[&str] = &["ping"];
pub(super) const BUILDER_METHODS: &[&str] = &["import.ifc", "import.las", "import.las.cancel"];
pub(super) const PHOTOLAB_METHODS: &[&str] = &[
    "photolab.alignment.resolve",
    "photolab.alignmentMerge.preflight",
    "photolab.hardware.probe",
    "photolab.report.surveyData",
    "photolab.shutdown.drain",
];

#[derive(Clone)]
struct BuilderRootContext {
    las_imports: Arc<LasImportOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

#[derive(Clone)]
struct PhotolabRootContext {
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
}

enum RootContext {
    Shared,
    Builder(BuilderRootContext),
    Photolab(PhotolabRootContext),
}

pub(super) struct RootModule {
    context: RootContext,
    methods: &'static [&'static str],
}

impl RootModule {
    pub(super) fn shared() -> Self {
        Self {
            context: RootContext::Shared,
            methods: SHARED_METHODS,
        }
    }

    pub(super) fn builder(
        las_imports: Arc<LasImportOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self {
            context: RootContext::Builder(BuilderRootContext {
                las_imports,
                canonical_app,
            }),
            methods: BUILDER_METHODS,
        }
    }

    pub(super) fn photolab(projects: Arc<ProjectRuntime>, jobs: Arc<JobManager>) -> Self {
        Self {
            context: RootContext::Photolab(PhotolabRootContext { projects, jobs }),
            methods: PHOTOLAB_METHODS,
        }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for RootModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in self.methods {
            match &self.context {
                RootContext::Shared => registry.register(method, |request, ()| {
                    Box::pin(async move { handle_ping(request) })
                })?,
                RootContext::Builder(context) => {
                    let context = context.clone();
                    registry.register(method, move |request, ()| {
                        let context = context.clone();
                        Box::pin(handle_builder_root(request, context))
                    })?;
                }
                RootContext::Photolab(context) => {
                    let context = context.clone();
                    registry.register(method, move |request, ()| {
                        let context = context.clone();
                        Box::pin(handle_photolab_root(request, context))
                    })?;
                }
            }
        }
        Ok(())
    }
}

fn handle_ping(request: RpcRequest) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id: request.id,
        result: Some(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })),
        error: None,
    }
}

async fn handle_builder_root(request: RpcRequest, context: BuilderRootContext) -> RpcResponse {
    match request.method.as_str() {
        "import.las" => match serde_json::from_value::<ImportLasParams>(request.params.clone()) {
            Ok(params) => {
                match handle_import_las(params, context.las_imports, context.canonical_app).await {
                    Ok(value) => RpcResponse {
                        jsonrpc: "2.0",
                        id: request.id,
                        result: Some(value),
                        error: None,
                    },
                    Err(error) => {
                        rpc_err(request.id, -32000, &format!("import.las failed: {error}"))
                    }
                }
            }
            Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
        },
        "import.las.cancel" => {
            match serde_json::from_value::<CancelLasImportParams>(request.params.clone()) {
                Ok(params) => rpc_result(
                    request.id,
                    Ok::<_, anyhow::Error>(serde_json::json!({
                        "operationId": params.operation_id,
                        "cancellationRequested": context.las_imports.cancel(&params.operation_id),
                    })),
                ),
                Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "import.ifc" => match serde_json::from_value::<ImportIfcParams>(request.params.clone()) {
            Ok(params) => {
                let canonical_app = Arc::clone(&context.canonical_app);
                rpc_blocking(request.id, move || {
                    let (staged, command_id) = handle_import_ifc(params)?;
                    canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import(&staged, &command_id)?;
                    Ok(staged.package)
                })
                .await
            }
            Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
        },
        _ => unreachable!("builder root module registered an unrelated method"),
    }
}

async fn handle_photolab_root(request: RpcRequest, context: PhotolabRootContext) -> RpcResponse {
    match request.method.as_str() {
        "photolab.shutdown.drain" => {
            let (job_drain, side_drain) =
                drain_project_work(&context.jobs, &context.projects).await;
            if side_drain.completed() {
                rpc_result(request.id, Ok::<_, anyhow::Error>(job_drain))
            } else {
                rpc_err_with_data(
                    request.id,
                    -32030,
                    "PhotoLab side operations did not stop before the shutdown deadline",
                    serde_json::json!({ "timedOut": side_drain.timed_out }),
                )
            }
        }
        "photolab.alignmentMerge.preflight" => {
            rpc_blocking_with_params::<AlignmentMergePreflightParams, _, _>(
                request.id,
                request.params,
                move |params| context.projects.alignment_merge_preflight(params),
            )
            .await
        }
        "photolab.report.surveyData" => {
            rpc_blocking(request.id, move || {
                context.projects.processing_report_survey_data()
            })
            .await
        }
        "photolab.alignment.resolve" => {
            match serde_json::from_value::<ResolveAlignmentProfileRequest>(request.params.clone()) {
                Ok(params) => match resolve_alignment_profile(&params) {
                    Ok(config) => {
                        tracing::info!(
                            profile = ?config.profile,
                            config_hash = config.config_hash.as_str(),
                            image_count = config.image_count,
                            "photolab alignment profile resolved"
                        );
                        match serde_json::to_value(config) {
                            Ok(value) => RpcResponse {
                                jsonrpc: "2.0",
                                id: request.id,
                                result: Some(value),
                                error: None,
                            },
                            Err(error) => rpc_err(
                                request.id,
                                -32603,
                                &format!("failed to encode resolved alignment profile: {error}"),
                            ),
                        }
                    }
                    Err(error) => rpc_err(request.id, -32602, &error.to_string()),
                },
                Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.hardware.probe" => {
            rpc_blocking(request.id, || probe_hardware().map_err(anyhow::Error::from)).await
        }
        _ => unreachable!("PhotoLab root module registered an unrelated method"),
    }
}
