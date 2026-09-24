use super::*;

pub(super) async fn handle_capture_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.capture.capabilities" => {
            rpc_blocking(req.id, move || {
                Ok::<_, anyhow::Error>(probe_capture_capabilities(
                    &CaptureToolConfig::from_environment(),
                ))
            })
            .await
        }
        "photolab.capture.scale.evaluate" => {
            rpc_blocking_with_params::<LocalScaleConstraint, _, _>(
                req.id,
                req.params,
                |constraint| Ok::<_, anyhow::Error>(evaluate_local_scale(&constraint)),
            )
            .await
        }
        "photolab.capture.video.prepare" => {
            let progress_key = req
                .params
                .get("progressKey")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            rpc_blocking_with_params::<PrepareVideoFramesRequest, _, _>(
                req.id,
                req.params,
                move |params| {
                    let operation_id = params.operation_id.clone();
                    let cancellation = projects.begin_image_inspection(&operation_id)?;
                    let capabilities =
                        probe_capture_capabilities(&CaptureToolConfig::from_environment());
                    let result = prepare_video_frames(
                        &params,
                        &capabilities,
                        || cancellation.is_cancel_requested(),
                        |fraction, message| {
                            emit_progress(progress_key.as_deref(), fraction, message);
                        },
                    );
                    projects.finish_image_inspection(&operation_id);
                    result.map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "photolab.capture.image.prepare" => {
            let progress_key = req
                .params
                .get("progressKey")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            rpc_blocking_with_params::<PrepareStillImageRequest, _, _>(
                req.id,
                req.params,
                move |params| {
                    let operation_id = params.operation_id.clone();
                    let cancellation = projects.begin_image_inspection(&operation_id)?;
                    let capabilities =
                        probe_capture_capabilities(&CaptureToolConfig::from_environment());
                    let result = prepare_still_image(
                        &params,
                        &capabilities,
                        || cancellation.is_cancel_requested(),
                        |fraction, message| {
                            emit_progress(progress_key.as_deref(), fraction, message);
                        },
                    );
                    projects.finish_image_inspection(&operation_id);
                    result.map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "photolab.capture.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_inspection(params)),
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.capture.cancel",
    "photolab.capture.capabilities",
    "photolab.capture.image.prepare",
    "photolab.capture.scale.evaluate",
    "photolab.capture.video.prepare",
];

pub(super) struct PhotolabCaptureModule {
    projects: Arc<ProjectRuntime>,
}

impl PhotolabCaptureModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>) -> Self {
        Self { projects }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabCaptureModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let projects = Arc::clone(&self.projects);
            registry.register(method, move |request, ()| {
                Box::pin(handle_capture_rpc(request, Arc::clone(&projects)))
            })?;
        }
        Ok(())
    }
}
