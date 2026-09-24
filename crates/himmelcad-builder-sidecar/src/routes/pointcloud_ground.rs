use super::*;

pub(super) async fn handle_pointcloud_ground_rpc(
    req: RpcRequest,
    operations: Arc<GroundOperations>,
    runtime: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "pointcloud.ground.cancel" => {
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
        "pointcloud.ground.preview" => {
            let id = req.id;
            let params = match serde_json::from_value::<GroundPreviewParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                anyhow::ensure!(
                    params.algorithm_id == GROUND_ALGORITHM_ID,
                    "unsupported ground algorithm: {}",
                    params.algorithm_id
                );
                anyhow::ensure!(
                    (1..=50_000).contains(&params.sample_limit),
                    "sampleLimit must be between 1 and 50000"
                );
                let scratch = GroundScratch::new(&params.operation_id)?;
                emit_progress(
                    Some(&params.progress_key),
                    0.01,
                    "Capturing ground preview source",
                );
                let source = capture_pointcloud_source(
                    &runtime,
                    params.source,
                    scratch.root.join("source"),
                    &active.cancellation,
                    &params.progress_key,
                    0.01,
                    0.19,
                )?;
                let scope = ground_scope(&source, params.scope);
                let request = GroundPrepareRequest {
                    metadata_path: source.input_root.join("metadata.json"),
                    hierarchy_path: source.input_root.join("hierarchy.bin"),
                    octree_path: source.input_root.join("octree.bin"),
                    output_root: scratch.root.join("unused"),
                    output_name: "Ground preview".to_owned(),
                    params: params.parameters.into(),
                    scope,
                };
                let mut ground_progress = GroundProgressThrottle::default();
                let preview = preview_ground(
                    &request,
                    params.sample_limit,
                    &active.cancellation,
                    |progress| ground_progress.emit(&params.progress_key, progress, 0.20, 0.78),
                )?;
                emit_progress(Some(&params.progress_key), 1.0, "Ground preview ready");
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaId": "hcad.pointcloud.ground-preview-result@1",
                    "algorithmId": GROUND_ALGORITHM_ID,
                    "source": source.expected,
                    "preview": preview,
                }))
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        "pointcloud.ground.extract" => {
            let id = req.id;
            let params = match serde_json::from_value::<GroundExtractionParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                anyhow::ensure!(
                    params.algorithm_id == GROUND_ALGORITHM_ID,
                    "unsupported ground algorithm: {}",
                    params.algorithm_id
                );
                anyhow::ensure!(!params.output_name.trim().is_empty(), "outputName is empty");
                let scratch = GroundScratch::new(&params.operation_id)?;
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
                let scope = ground_scope(&source, params.scope);
                let scope_value = serde_json::to_value(&scope)?;
                let parameters_value = serde_json::to_value(params.parameters)?;
                let request = GroundPrepareRequest {
                    metadata_path: source.input_root.join("metadata.json"),
                    hierarchy_path: source.input_root.join("hierarchy.bin"),
                    octree_path: source.input_root.join("octree.bin"),
                    output_root: scratch.root.join("prepared"),
                    output_name: params.output_name.clone(),
                    params: params.parameters.into(),
                    scope,
                };
                let mut ground_progress = GroundProgressThrottle::default();
                let prepared: PreparedGroundResult =
                    prepare_ground_datasets(&request, &active.cancellation, |progress| {
                        ground_progress.emit(&params.progress_key, progress, 0.10, 0.78)
                    })?;
                active.cancellation.check()?;
                emit_progress(
                    Some(&params.progress_key),
                    0.90,
                    "Publishing ground datasets",
                );
                let mut publication_phase = None;
                let mut publication_local = -1.0_f64;
                let commit = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned")
                    .publish_ground_extraction(
                        source,
                        &prepared,
                        params.command_id,
                        params.ground_entity_id,
                        params.output_name,
                        parameters_value,
                        scope_value,
                        current_rfc3339(),
                        &mut |publication| {
                            let local = if publication.total_bytes == 0 {
                                0.0
                            } else {
                                publication.completed_bytes as f64 / publication.total_bytes as f64
                            };
                            let phase_changed = publication_phase != Some(publication.phase);
                            if !phase_changed && local - publication_local < 0.01 {
                                return;
                            }
                            publication_phase = Some(publication.phase);
                            publication_local = local;
                            let (start, span, message) = match publication.phase {
                                CanonicalImportProgressPhase::Staging => {
                                    (0.90, 0.07, "Storing prepared ground datasets")
                                }
                                CanonicalImportProgressPhase::Publishing => {
                                    (0.97, 0.03, "Committing ground extraction")
                                }
                            };
                            emit_progress(
                                Some(&params.progress_key),
                                start + span * local.clamp(0.0, 1.0),
                                message,
                            );
                        },
                        &|| active.cancellation.is_cancel_requested(),
                    )?;
                emit_progress(Some(&params.progress_key), 1.0, "Ground cloud ready");
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaId": "hcad.pointcloud.ground-result@1",
                    "algorithmId": GROUND_ALGORITHM_ID,
                    "summary": prepared.summary,
                    "source": {
                        "entityId": commit.source_entity_id,
                        "revision": commit.source_revision,
                        "datasetId": commit.source_dataset_id,
                        "classification": 2
                    },
                    "groundCloud": {
                        "entityId": commit.ground_entity_id,
                        "revision": commit.ground_revision,
                        "datasetId": commit.ground_dataset_id,
                        "entityType": "PointCloud",
                        "isDgm": false,
                        "meshSourceRole": "ground_cloud"
                    },
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

pub(super) const METHODS: &[&str] = &[
    "pointcloud.ground.cancel",
    "pointcloud.ground.extract",
    "pointcloud.ground.preview",
];

#[derive(Clone)]
struct PointcloudGroundContext {
    operations: Arc<GroundOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct PointcloudGroundModule(PointcloudGroundContext);

impl PointcloudGroundModule {
    pub(super) fn new(
        operations: Arc<GroundOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(PointcloudGroundContext {
            operations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PointcloudGroundModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_pointcloud_ground_rpc(
                    request,
                    context.operations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}
