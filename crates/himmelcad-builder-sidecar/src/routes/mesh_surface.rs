use super::*;
use crate::mesh_surface_runtime::SurfaceRuntimeAdapter;

pub(super) async fn handle_mesh_surface_rpc(
    req: RpcRequest,
    operations: Arc<GroundOperations>,
    runtime: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "mesh.surface.cancel" | "mesh.edit.cancel" => {
            match serde_json::from_value::<CancelGroundOperationParams>(req.params) {
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
        "mesh.surface.draft.create" => {
            let id = req.id;
            let params = match serde_json::from_value::<SurfaceDraftCreateParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                create_surface_draft(
                    &adapter,
                    params.request,
                    &active.cancellation,
                    |fraction, phase| {
                        emit_progress(Some(&params.progress_key), fraction * 0.98, phase)
                    },
                )
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        "mesh.surface.check" => {
            let id = req.id;
            rpc_blocking_with_params::<SurfaceDraftParams, _, _>(id, req.params, move |params| {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                check_persisted_surface(&adapter, &params.draft_id)
            })
            .await
        }
        "mesh.surface.draft.apply_fix" => {
            let id = req.id;
            rpc_blocking_with_params::<SurfaceFixParams, _, _>(id, req.params, move |params| {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                fix_persisted_surface(
                    &adapter,
                    &params.draft_id,
                    &SurfaceFixRequest {
                        error_id: params.error_id,
                        fix: params.fix,
                        authority_source_id: params.authority_source_id,
                    },
                )
            })
            .await
        }
        "mesh.surface.create" => {
            let id = req.id;
            let params = match serde_json::from_value::<SurfacePublishParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let mut adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                publish_persisted_surface(
                    &mut adapter,
                    &params.draft_id,
                    params.output_entity_id,
                    params.command_id,
                    current_rfc3339(),
                    &active.cancellation,
                    |fraction, phase| emit_progress(Some(&params.progress_key), fraction, phase),
                )
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        "mesh.edit.region.select" => {
            let id = req.id;
            rpc_blocking_with_params::<SurfaceEditRegionParams, _, _>(
                id,
                req.params,
                move |params| {
                    let mut runtime = runtime
                        .lock()
                        .expect("canonical app runtime mutex poisoned");
                    let adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                    select_surface_edit_region(&adapter, params.request)
                },
            )
            .await
        }
        "mesh.edit.smooth.preview" => {
            let id = req.id;
            let params = match serde_json::from_value::<SurfaceSmoothPreviewParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                preview_surface_smoothing(
                    &adapter,
                    &params.edit_id,
                    &params.parameters,
                    &active.cancellation,
                    |fraction, phase| emit_progress(Some(&params.progress_key), fraction, phase),
                )
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        "mesh.edit.downsample.preview" => {
            let id = req.id;
            let params = match serde_json::from_value::<SurfaceDownsamplePreviewParams>(req.params)
            {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                preview_surface_downsample(
                    &adapter,
                    &params.edit_id,
                    &params.parameters,
                    &active.cancellation,
                    |fraction, phase| emit_progress(Some(&params.progress_key), fraction, phase),
                )
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        "mesh.edit.smooth" | "mesh.edit.downsample" => {
            let id = req.id;
            let params = match serde_json::from_value::<SurfaceEditBakeRequest>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned");
                let mut adapter = SurfaceRuntimeAdapter::new(&mut runtime);
                bake_surface_edit(
                    &mut adapter,
                    &params,
                    &current_rfc3339(),
                    &active.cancellation,
                    |fraction, phase| emit_progress(Some(&params.progress_key), fraction, phase),
                )
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "mesh.edit.cancel",
    "mesh.edit.downsample",
    "mesh.edit.downsample.preview",
    "mesh.edit.region.select",
    "mesh.edit.smooth",
    "mesh.edit.smooth.preview",
    "mesh.surface.cancel",
    "mesh.surface.check",
    "mesh.surface.create",
    "mesh.surface.draft.apply_fix",
    "mesh.surface.draft.create",
];

#[derive(Clone)]
struct MeshSurfaceContext {
    operations: Arc<GroundOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct MeshSurfaceModule(MeshSurfaceContext);

impl MeshSurfaceModule {
    pub(super) fn new(
        operations: Arc<GroundOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(MeshSurfaceContext {
            operations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for MeshSurfaceModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_mesh_surface_rpc(
                    request,
                    context.operations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}
