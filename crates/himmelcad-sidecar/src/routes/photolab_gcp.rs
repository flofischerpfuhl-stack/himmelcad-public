use super::*;

pub(super) async fn handle_gcp_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    crs: &CrsService,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.gcp.preview" => {
            rpc_blocking_with_params::<PreviewGcpCsvParams, _, _>(req.id, req.params, |params| {
                preview_gcp_csv_file(
                    Path::new(&params.path),
                    &params.mapping,
                    params.maximum_preview_rows.clamp(1, 1_000),
                )
                .map_err(anyhow::Error::from)
            })
            .await
        }
        "photolab.gcp.commit" => match serde_json::from_value::<CommitGcpCsvParams>(req.params) {
            Ok(params) => match transform_gcp_import(params, crs).await {
                Ok(params) => rpc_blocking(req.id, move || projects.commit_gcps(params)).await,
                Err(error) => rpc_err(req.id, -32000, &error.to_string()),
            },
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.gcp.list" => rpc_blocking(req.id, move || projects.list_gcps()).await,
        "photolab.gcp.observation.upsert" => {
            rpc_blocking_with_params::<UpsertGcpObservationParams, _, _>(
                req.id,
                req.params,
                move |params| projects.upsert_gcp_observation(params),
            )
            .await
        }
        "photolab.gcp.observation.edit" => {
            rpc_blocking_with_params::<EditGcpObservationParams, _, _>(
                req.id,
                req.params,
                move |params| projects.edit_gcp_observation(params),
            )
            .await
        }
        "photolab.gcp.observation.upsertAssisted" => {
            rpc_blocking_with_params::<UpsertAssistedGcpObservationParams, _, _>(
                req.id,
                req.params,
                move |params| upsert_assisted_gcp_observation(&projects, params),
            )
            .await
        }
        "photolab.gcp.localEstimate.compute" => {
            rpc_blocking_with_params::<ComputeGcpLocalEstimateParams, _, _>(
                req.id,
                req.params,
                move |params| projects.compute_gcp_local_estimate(params),
            )
            .await
        }
        "photolab.gcp.localEstimate.read" => {
            rpc_blocking_with_params::<ReadGcpLocalEstimateParams, _, _>(
                req.id,
                req.params,
                move |params| projects.read_gcp_local_estimate(params),
            )
            .await
        }
        "photolab.gcp.optimization.snapshot" => {
            rpc_blocking_with_params::<CreateGcpOptimizationSnapshotParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_gcp_optimization_snapshot(params),
            )
            .await
        }
        "photolab.gcp.optimization.latest" => {
            rpc_blocking_with_params::<AlignedGcpCamerasParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    latest_gcp_optimization_for_scope(
                        &projects,
                        params.processing_set_id.as_ref(),
                        params.source_alignment_entity_id.as_ref(),
                    )
                },
            )
            .await
        }
        "photolab.gcp.optimization.list" => {
            rpc_blocking(req.id, move || projects.list_gcp_optimizations()).await
        }
        "photolab.gcp.calibrationReport" => {
            rpc_blocking_with_params::<GcpCalibrationReportParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    projects.gcp_calibration_report(params.optimization_entity_id.as_ref())
                },
            )
            .await
        }
        "photolab.gcp.alignedCameras" => {
            rpc_blocking_with_params::<AlignedGcpCamerasParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    load_aligned_gcp_cameras(
                        &projects,
                        params.processing_set_id.as_ref(),
                        params.source_alignment_entity_id.as_ref(),
                    )
                },
            )
            .await
        }
        "photolab.gcp.cancel" => {
            match serde_json::from_value::<CancelGcpOperationParams>(req.params) {
                Ok(params) => {
                    let coordinate_operation_id = format!("{}.coordinates", params.operation_id);
                    let crs_cancelled = crs
                        .cancel(CancelCrsOperationParams {
                            operation_id: coordinate_operation_id,
                        })
                        .await;
                    let project_cancelled = projects.cancel_gcp_operation(params);
                    rpc_result(
                        req.id,
                        Ok::<_, anyhow::Error>(serde_json::json!({
                            "operationId": project_cancelled.operation_id,
                            "cancellationRequested": project_cancelled.cancellation_requested
                                || crs_cancelled.cancellation_requested,
                        })),
                    )
                }
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.gcp.alignedCameras",
    "photolab.gcp.calibrationReport",
    "photolab.gcp.cancel",
    "photolab.gcp.commit",
    "photolab.gcp.list",
    "photolab.gcp.localEstimate.compute",
    "photolab.gcp.localEstimate.read",
    "photolab.gcp.observation.edit",
    "photolab.gcp.observation.upsert",
    "photolab.gcp.observation.upsertAssisted",
    "photolab.gcp.optimization.latest",
    "photolab.gcp.optimization.list",
    "photolab.gcp.optimization.snapshot",
    "photolab.gcp.preview",
];

#[derive(Clone)]
struct PhotolabGcpContext {
    projects: Arc<ProjectRuntime>,
    crs: Arc<CrsService>,
}

pub(super) struct PhotolabGcpModule(PhotolabGcpContext);

impl PhotolabGcpModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>, crs: Arc<CrsService>) -> Self {
        Self(PhotolabGcpContext { projects, crs })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabGcpModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(
                    async move { handle_gcp_rpc(request, context.projects, &context.crs).await },
                )
            })?;
        }
        Ok(())
    }
}
