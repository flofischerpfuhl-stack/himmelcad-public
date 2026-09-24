use super::*;

pub(super) async fn handle_himmelcap_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.himmelcap.inspect" => {
            rpc_blocking_with_params::<InspectHimmelcapParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    anyhow::ensure!(
                        !params.operation_id.trim().is_empty(),
                        "operationId must not be empty"
                    );
                    let source = PathBuf::from(params.path);
                    let staging = himmelcap_staging_path(&params.operation_id);
                    let cancellation = projects.begin_image_inspection(&params.operation_id)?;
                    let result = import_hcap_path_with_progress(
                        &source,
                        &staging,
                        || cancellation.is_cancel_requested(),
                        |fraction, message| {
                            emit_progress(params.progress_key.as_deref(), fraction, message)
                        },
                    );
                    projects.finish_image_inspection(&params.operation_id);
                    if result.is_err() && staging.exists() {
                        if let Err(error) = std::fs::remove_dir_all(&staging) {
                            tracing::warn!(
                                %error,
                                path = %staging.display(),
                                "failed to clean rejected HimmelCAD Cap staging directory"
                            );
                        }
                    }
                    result.map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "photolab.himmelcap.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_inspection(params)),
            )
            .await
        }
        "photolab.himmelcap.release" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    anyhow::ensure!(
                        !params.operation_id.trim().is_empty(),
                        "operationId must not be empty"
                    );
                    let staging = himmelcap_staging_path(&params.operation_id);
                    let released = if staging.exists() {
                        std::fs::remove_dir_all(&staging).with_context(|| {
                            format!(
                                "failed to release HimmelCAD Cap staging directory {}",
                                staging.display()
                            )
                        })?;
                        true
                    } else {
                        false
                    };
                    Ok(serde_json::json!({
                        "operationId": params.operation_id,
                        "released": released,
                    }))
                },
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.himmelcap.cancel",
    "photolab.himmelcap.inspect",
    "photolab.himmelcap.release",
];

pub(super) struct PhotolabHimmelcapModule {
    projects: Arc<ProjectRuntime>,
}

impl PhotolabHimmelcapModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>) -> Self {
        Self { projects }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabHimmelcapModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let projects = Arc::clone(&self.projects);
            registry.register(method, move |request, ()| {
                Box::pin(handle_himmelcap_rpc(request, Arc::clone(&projects)))
            })?;
        }
        Ok(())
    }
}
