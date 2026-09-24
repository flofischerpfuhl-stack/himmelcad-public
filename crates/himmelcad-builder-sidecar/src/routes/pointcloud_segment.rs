use super::*;

pub(super) async fn handle_pointcloud_segment_rpc(
    req: RpcRequest,
    operations: Arc<GroundOperations>,
    runtime: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "pointcloud.segment.cancel" => {
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
        "pointcloud.segment.keep_inside" | "pointcloud.segment.remove_inside" => {
            let id = req.id;
            let params = match serde_json::from_value::<SegmentParams>(req.params) {
                Ok(params) => params,
                Err(error) => return rpc_err(id, -32602, &format!("invalid params: {error}")),
            };
            let expected_side = if req.method.ends_with("keep_inside") {
                SegmentSide::KeepInside
            } else {
                SegmentSide::RemoveInside
            };
            if params.side != expected_side {
                return rpc_err(id, -32602, "method and segmentation side disagree");
            }
            let active = match operations.begin(params.operation_id.clone()) {
                Ok(active) => active,
                Err(error) => return rpc_err(id, -32602, &error.to_string()),
            };
            let result = tokio::task::spawn_blocking(move || {
                anyhow::ensure!(
                    params.algorithm_id == SEGMENT_ALGORITHM_ID,
                    "unsupported segmentation algorithm: {}",
                    params.algorithm_id
                );
                anyhow::ensure!(
                    !params.sources.is_empty() && params.sources.len() <= 64,
                    "segmentation requires 1..64 point-cloud sources"
                );
                let scratch = GroundScratch::new(&params.operation_id)?;
                let total_sources = params.sources.len();
                let mut prepared_sources = Vec::with_capacity(total_sources);
                for (index, source_params) in params.sources.into_iter().enumerate() {
                    active.cancellation.check()?;
                    emit_progress(
                        Some(&params.progress_key),
                        0.01 + index as f64 / total_sources as f64 * 0.86,
                        "Capturing visible point-cloud state",
                    );
                    let source = capture_pointcloud_source(
                        &runtime,
                        source_params.source,
                        scratch.root.join(format!("source-{index}")),
                        &active.cancellation,
                        &params.progress_key,
                        0.01 + index as f64 / total_sources as f64 * 0.86,
                        0.01 / total_sources as f64,
                    )?;
                    let scope = ground_scope(&source, source_params.scope);
                    let scope_value = serde_json::to_value(&scope)?;
                    let mut last_progress_bucket = None;
                    let prepared: PreparedSegmentResult = prepare_segment_dataset(
                        &SegmentPrepareRequest {
                            metadata_path: source.input_root.join("metadata.json"),
                            hierarchy_path: source.input_root.join("hierarchy.bin"),
                            octree_path: source.input_root.join("octree.bin"),
                            output_root: scratch.root.join(format!("prepared-{index}")),
                            output_name: format!("{} — edited", source.entity.name),
                            volume: params.volume.clone(),
                            side: params.side,
                            scope: scope.clone(),
                        },
                        &active.cancellation,
                        |progress| {
                            let bucket = segment_progress_bucket(progress);
                            if last_progress_bucket != Some(bucket)
                                || progress.completed >= progress.total
                            {
                                last_progress_bucket = Some(bucket);
                                emit_segment_progress(
                                    &params.progress_key,
                                    progress,
                                    index,
                                    total_sources,
                                );
                            }
                        },
                    )?;
                    prepared_sources.push((source, prepared, scope_value));
                }
                active.cancellation.check()?;
                emit_progress(
                    Some(&params.progress_key),
                    0.90,
                    "Publishing edited point-cloud revisions",
                );
                let commit = runtime
                    .lock()
                    .expect("canonical app runtime mutex poisoned")
                    .publish_pointcloud_segmentation(
                        prepared_sources,
                        params.command_id,
                        serde_json::to_value(&params.volume)?,
                        serde_json::to_value(params.side)?,
                        current_rfc3339(),
                        &mut |publication| {
                            let local = if publication.total_bytes == 0 {
                                0.0
                            } else {
                                publication.completed_bytes as f64 / publication.total_bytes as f64
                            };
                            emit_progress(
                                Some(&params.progress_key),
                                0.90 + local.clamp(0.0, 1.0) * 0.10,
                                match publication.phase {
                                    CanonicalImportProgressPhase::Staging => {
                                        "Storing reduced point-cloud datasets"
                                    }
                                    CanonicalImportProgressPhase::Publishing => {
                                        "Committing segmentation"
                                    }
                                },
                            );
                        },
                        &|| active.cancellation.is_cancel_requested(),
                    )?;
                emit_progress(Some(&params.progress_key), 1.0, "Segmentation ready");
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaId": "hcad.pointcloud.segment-result@1",
                    "algorithmId": SEGMENT_ALGORITHM_ID,
                    "side": params.side,
                    "volume": params.volume,
                    "revisions": commit.revisions,
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
    "pointcloud.segment.cancel",
    "pointcloud.segment.keep_inside",
    "pointcloud.segment.remove_inside",
];

#[derive(Clone)]
struct PointcloudSegmentContext {
    operations: Arc<GroundOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct PointcloudSegmentModule(PointcloudSegmentContext);

impl PointcloudSegmentModule {
    pub(super) fn new(
        operations: Arc<GroundOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(PointcloudSegmentContext {
            operations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PointcloudSegmentModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_pointcloud_segment_rpc(
                    request,
                    context.operations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}
