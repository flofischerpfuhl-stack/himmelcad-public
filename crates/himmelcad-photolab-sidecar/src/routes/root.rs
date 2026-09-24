use super::*;

pub(super) const METHODS: &[&str] = &[
    "photolab.alignment.resolve",
    "photolab.alignmentMerge.preflight",
    "photolab.hardware.probe",
    "photolab.report.surveyData",
    "photolab.shutdown.drain",
];

#[derive(Clone)]
struct PhotolabRootContext {
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
}

pub(super) struct RootModule {
    context: PhotolabRootContext,
}

impl RootModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>, jobs: Arc<JobManager>) -> Self {
        Self {
            context: PhotolabRootContext { projects, jobs },
        }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for RootModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.context.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_photolab_root(request, context))
            })?;
        }
        Ok(())
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
