use super::*;

pub(super) async fn handle_pointcloud_sampling_rpc(
    req: RpcRequest,
    operations: Arc<GroundOperations>,
    runtime: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "pointcloud.processing.cancel" => {
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
        "pointcloud.sample" => {
            let id = req.id;
            let params = match serde_json::from_value::<PointcloudSampleParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                anyhow::ensure!(
                    params.algorithm_id == SAMPLE_ALGORITHM_ID,
                    "unsupported sampling algorithm: {}",
                    params.algorithm_id
                );
                anyhow::ensure!(!params.output_name.trim().is_empty(), "outputName is empty");
                let scratch = GroundScratch::new_with_prefix("sample", &params.operation_id)?;
                emit_progress(
                    Some(&params.progress_key),
                    0.01,
                    "Capturing visible point-cloud state",
                );
                let source = capture_pointcloud_source(
                    &runtime,
                    params.source,
                    scratch.root.join("source"),
                    &active.cancellation,
                    &params.progress_key,
                    0.01,
                    0.09,
                )?;
                let source_result = serde_json::to_value(&source.expected)?;
                let scope = ground_scope(&source, params.scope);
                let scope_value = serde_json::to_value(&scope)?;
                let parameters_value = serde_json::to_value(params.parameters)?;
                let mut sampling_progress = IncrementalProgressThrottle::default();
                let prepared: PreparedSampleResult = prepare_sampled_cloud(
                    &SamplePrepareRequest {
                        metadata_path: source.input_root.join("metadata.json"),
                        hierarchy_path: source.input_root.join("hierarchy.bin"),
                        octree_path: source.input_root.join("octree.bin"),
                        output_root: scratch.root.join("prepared"),
                        output_name: params.output_name.clone(),
                        parameters: params.parameters,
                        scope,
                    },
                    &active.cancellation,
                    |progress| {
                        emit_sampling_progress(
                            &mut sampling_progress,
                            &params.progress_key,
                            progress,
                            0.10,
                            0.78,
                        )
                    },
                )?;
                active.cancellation.check()?;
                emit_progress(Some(&params.progress_key), 0.88, "Publishing sampled cloud");
                let mut publication_progress = IncrementalProgressThrottle::default();
                let commit = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned")
                    .publish_sampled_cloud(
                        source,
                        &prepared,
                        params.command_id,
                        params.output_entity_id,
                        params.output_name,
                        parameters_value,
                        scope_value,
                        current_rfc3339(),
                        &mut |publication| {
                            emit_derived_publication_progress(
                                &mut publication_progress,
                                &params.progress_key,
                                publication,
                                "sampled cloud",
                            )
                        },
                        &|| active.cancellation.is_cancel_requested(),
                    )?;
                emit_progress(Some(&params.progress_key), 1.0, "Sampled cloud ready");
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaId": "hcad.pointcloud.sample-result@1",
                    "algorithmId": SAMPLE_ALGORITHM_ID,
                    "source": source_result,
                    "sampledCloud": {
                        "entityId": commit.entity_id,
                        "revision": commit.revision,
                        "datasetId": commit.dataset_id,
                        "entityType": "PointCloud",
                    },
                    "summary": prepared.summary,
                    "journalEntry": commit.journal_entry,
                }))
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        "pointcloud.rasterize" => {
            let id = req.id;
            let params = match serde_json::from_value::<PointcloudRasterizeParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                anyhow::ensure!(
                    params.algorithm_id == RASTERIZE_ALGORITHM_ID,
                    "unsupported rasterize algorithm: {}",
                    params.algorithm_id
                );
                anyhow::ensure!(!params.output_name.trim().is_empty(), "outputName is empty");
                let output_noun = if params.parameters.aggregation == RasterAggregation::Count {
                    "count grid"
                } else {
                    "height grid"
                };
                let output_ready = if params.parameters.aggregation == RasterAggregation::Count {
                    "Count grid ready"
                } else {
                    "Height grid ready"
                };
                let scratch = GroundScratch::new_with_prefix("rasterize", &params.operation_id)?;
                emit_progress(
                    Some(&params.progress_key),
                    0.01,
                    "Capturing visible point-cloud state",
                );
                let source = capture_pointcloud_source(
                    &runtime,
                    params.source,
                    scratch.root.join("source"),
                    &active.cancellation,
                    &params.progress_key,
                    0.01,
                    0.09,
                )?;
                let source_result = serde_json::json!({
                    "entityId": source.expected.id,
                    "revision": source.expected.revision,
                    "versionHash": source.expected.version_hash,
                });
                let scope = ground_scope(&source, params.scope);
                let scope_value = serde_json::to_value(&scope)?;
                let parameters_value = serde_json::to_value(params.parameters)?;
                let mut rasterize_progress = IncrementalProgressThrottle::default();
                let prepared: PreparedHeightGrid = prepare_height_grid(
                    &RasterizePrepareRequest {
                        metadata_path: source.input_root.join("metadata.json"),
                        hierarchy_path: source.input_root.join("hierarchy.bin"),
                        octree_path: source.input_root.join("octree.bin"),
                        output_root: scratch.root.join("prepared"),
                        parameters: params.parameters,
                        scope,
                    },
                    &active.cancellation,
                    |progress| {
                        emit_rasterize_progress(
                            &mut rasterize_progress,
                            &params.progress_key,
                            progress,
                            0.10,
                            0.78,
                        )
                    },
                )?;
                active.cancellation.check()?;
                emit_progress(
                    Some(&params.progress_key),
                    0.88,
                    &format!("Publishing {output_noun}"),
                );
                let mut publication_progress = IncrementalProgressThrottle::default();
                let commit = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned")
                    .publish_height_grid(
                        source,
                        &prepared,
                        params.command_id,
                        params.output_entity_id,
                        params.output_name,
                        parameters_value,
                        scope_value,
                        current_rfc3339(),
                        &mut |publication| {
                            emit_derived_publication_progress(
                                &mut publication_progress,
                                &params.progress_key,
                                publication,
                                output_noun,
                            )
                        },
                        &|| active.cancellation.is_cancel_requested(),
                    )?;
                emit_progress(Some(&params.progress_key), 1.0, output_ready);
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaId": "hcad.pointcloud.rasterize-result@1",
                    "algorithmId": RASTERIZE_ALGORITHM_ID,
                    "source": source_result,
                    "grid": {
                        "entityId": commit.entity_id,
                        "revision": commit.revision,
                        "datasetId": commit.dataset_id,
                        "entityType": commit.entity_type,
                        "meshSourceRole": commit.mesh_source_role,
                    },
                    "summary": prepared.summary,
                    "journalEntry": commit.journal_entry,
                }))
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

#[allow(clippy::cast_precision_loss)]

pub(super) const METHODS: &[&str] = &[
    "pointcloud.processing.cancel",
    "pointcloud.rasterize",
    "pointcloud.sample",
];

#[derive(Clone)]
struct PointcloudProcessingContext {
    operations: Arc<GroundOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct PointcloudProcessingModule(PointcloudProcessingContext);

impl PointcloudProcessingModule {
    pub(super) fn new(
        operations: Arc<GroundOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(PointcloudProcessingContext {
            operations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PointcloudProcessingModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_pointcloud_sampling_rpc(
                    request,
                    context.operations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}
