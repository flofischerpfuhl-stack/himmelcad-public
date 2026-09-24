use super::*;

pub(super) async fn handle_image_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    crs: &CrsService,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.images.list" => rpc_blocking(req.id, move || projects.list_camera_images()).await,
        "photolab.images.quality.list" => {
            rpc_blocking(req.id, move || projects.list_image_quality_analyses()).await
        }
        "photolab.images.inspect" => {
            rpc_blocking_with_params::<InspectPhotolabImagesParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    if params.paths.is_empty() {
                        anyhow::bail!("at least one image or directory path is required");
                    }
                    let paths = params
                        .paths
                        .into_iter()
                        .map(PathBuf::from)
                        .collect::<Vec<_>>();
                    let operation_id = params.operation_id;
                    let cancellation = operation_id
                        .as_deref()
                        .map(|id| projects.begin_image_inspection(id))
                        .transpose()?;
                    let progress_key = params.progress_key;
                    let result = import_photo_files_with_progress(
                        &paths,
                        || {
                            cancellation
                                .as_ref()
                                .is_some_and(|token| token.is_cancel_requested())
                        },
                        |fraction, message| {
                            emit_progress(progress_key.as_deref(), fraction, message)
                        },
                    );
                    if let Some(operation_id) = operation_id.as_deref() {
                        projects.finish_image_inspection(operation_id);
                    }
                    result.context("image inspection cancelled")
                },
            )
            .await
        }
        "photolab.images.inspect.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_inspection(params)),
            )
            .await
        }
        "photolab.images.commit" => {
            let progress_key = req
                .params
                .get("progressKey")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            match serde_json::from_value::<CommitImagesParams>(req.params) {
                Ok(params) => match enrich_projected_references(params, crs).await {
                    Ok(params) => {
                        rpc_blocking(req.id, move || {
                            projects.commit_images_with_progress(params, |fraction, message| {
                                emit_progress(progress_key.as_deref(), fraction, message);
                            })
                        })
                        .await
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.images.commit.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_commit(params)),
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.images.commit",
    "photolab.images.commit.cancel",
    "photolab.images.inspect",
    "photolab.images.inspect.cancel",
    "photolab.images.list",
    "photolab.images.quality.list",
];

#[derive(Clone)]
struct PhotolabImagesContext {
    projects: Arc<ProjectRuntime>,
    crs: Arc<CrsService>,
}

pub(super) struct PhotolabImagesModule(PhotolabImagesContext);

impl PhotolabImagesModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>, crs: Arc<CrsService>) -> Self {
        Self(PhotolabImagesContext { projects, crs })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabImagesModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(
                    async move { handle_image_rpc(request, context.projects, &context.crs).await },
                )
            })?;
        }
        Ok(())
    }
}
