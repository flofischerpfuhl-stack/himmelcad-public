use super::*;

pub(super) async fn handle_registration_rpc(
    req: RpcRequest,
    registrations: Arc<ImportRegistrationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "registration.import.stage" => {
            rpc_blocking_product_with_params::<RegistrationStageParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    validate_io_identity(&params.session_id, "sessionId")?;
                    validate_io_identity(&params.command_id, "commandId")?;
                    let progress_key = params.session_id.clone();
                    emit_progress(Some(&progress_key), 0.0, "Reading header");
                    let source = PathBuf::from(&params.source_path);
                    anyhow::ensure!(
                        source.is_file() || source.is_dir(),
                        "registration source is not a file or package directory"
                    );
                    let cancellation = registrations.begin_preparation(&params.session_id)?;
                    let scratch_root = match create_registration_scratch(&params.session_id) {
                        Ok(root) => root,
                        Err(error) => {
                            registrations.finish_preparation(&params.session_id);
                            return Err(error);
                        }
                    };
                    let result = (|| {
                        let registry = canonical_builtin_import_registry(scratch_root.clone())?;
                        let mut context = RegistrationProviderContext::new(
                            progress_key.clone(),
                            cancellation.clone(),
                        );
                        let staged = registry.import(
                            &params.selection,
                            &source,
                            &params.options,
                            &mut context,
                        )?;
                        registrations
                            .begin_with_cancellation(
                                params.session_id,
                                params.command_id,
                                params.recipe,
                                staged,
                                scratch_root.clone(),
                                cancellation,
                            )
                            .map_err(anyhow::Error::from)
                    })();
                    if result.is_err() {
                        registrations.finish_preparation(&progress_key);
                        // This scratch tree is transient; preserving the original import error is more useful than a cleanup error.
                        let _ = std::fs::remove_dir_all(&scratch_root);
                    } else {
                        emit_progress(
                            Some(&progress_key),
                            0.70,
                            "Prepared import · ready for project commit",
                        );
                    }
                    result
                },
            )
            .await
        }
        "registration.session.state" => {
            rpc_blocking_with_params::<RegistrationSessionParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .state(&params.session_id)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.resources.describe" => {
            rpc_blocking_with_params::<RegistrationSessionParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .describe_resources(&params.session_id)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.resource.read" => {
            rpc_blocking_with_params::<RegistrationResourceReadParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .read_resource(
                            &params.session_id,
                            &params.capability,
                            &params.resource_id,
                            params.offset,
                            params.byte_length,
                        )
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.samples.source" => {
            rpc_blocking_with_params::<RegistrationSourceSamplesParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .source_samples(&params.session_id, params.maximum_samples)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.samples.projectPointCloud" => {
            rpc_blocking_with_params::<RegistrationProjectPointCloudSamplesParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    validate_io_identity(&params.dataset_id, "datasetId")?;
                    canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .registration_point_cloud_samples(
                            &params.dataset_id,
                            params.maximum_samples,
                        )
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.preview.pointPairs" => {
            rpc_blocking_with_params::<RegistrationPointPairsParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .preview_point_pairs(&params.session_id, &params.pairs)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.preview.icp" => {
            rpc_blocking_with_params::<RegistrationIcpParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .preview_icp(
                            &params.session_id,
                            &params.source,
                            &params.target,
                            params.initial,
                            params.mode,
                            params.options,
                            |completed, total, overlap| {
                                emit_progress(
                                    Some(&params.session_id),
                                    completed as f64 / f64::from(total.max(1)),
                                    &format!(
                                        "Registration ICP {completed}/{total} · {:.1}% overlap",
                                        overlap * 100.0
                                    ),
                                );
                            },
                        )
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.import.commit" => {
            rpc_blocking_with_params::<RegistrationSessionParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    let progress_key = params.session_id.clone();
                    emit_progress(Some(&progress_key), 0.70, "Registering dataset");
                    let (staged, command_id, _scratch_root, cancellation) =
                        registrations.take_ready(&params.session_id)?;
                    let mut last_phase = None;
                    let mut last_completed = 0_u64;
                    let result = canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import_with_progress_and_cancel(
                            &staged,
                            &command_id,
                            &mut |progress| {
                                let threshold =
                                    (progress.total_bytes / 1_000).max(16 * 1024 * 1024);
                                let phase_changed = last_phase != Some(progress.phase);
                                let finished = progress.completed_bytes >= progress.total_bytes;
                                if phase_changed
                                    || finished
                                    || progress.completed_bytes.saturating_sub(last_completed)
                                        >= threshold
                                {
                                    last_phase = Some(progress.phase);
                                    last_completed = progress.completed_bytes;
                                    emit_canonical_import_progress(&progress_key, progress);
                                }
                            },
                            &|| cancellation.is_cancel_requested(),
                        )
                        .map_err(anyhow::Error::from);
                    registrations.finish_commit(&params.session_id, result.is_ok());
                    if result.is_ok() {
                        emit_progress(Some(&progress_key), 0.99, "First frame");
                    }
                    result.and_then(public_import_commit)
                },
            )
            .await
        }
        "registration.session.cancel" => {
            match serde_json::from_value::<RegistrationSessionParams>(req.params) {
                Ok(params) => {
                    let outcome = registrations.cancel_with_outcome(&params.session_id);
                    rpc_result(
                        req.id,
                        Ok::<_, anyhow::Error>(serde_json::json!({
                            "schemaVersion": 1,
                            "sessionId": params.session_id,
                            "cancellationRequested": outcome.cancellation_requested,
                            "cancelledImmediately": outcome.cancelled_immediately,
                        })),
                    )
                }
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "registration.siteCalibration.inspect" => {
            rpc_blocking_with_params::<SiteCalibrationInspectParams, _, _>(
                req.id,
                req.params,
                |params| {
                    inspect_site_calibration(Path::new(&params.path)).map_err(anyhow::Error::from)
                },
            )
            .await
        }
        _ => rpc_err(req.id, -32601, "registration method not found"),
    }
}

pub(super) const METHODS: &[&str] = &[
    "registration.import.commit",
    "registration.import.stage",
    "registration.preview.icp",
    "registration.preview.pointPairs",
    "registration.resource.read",
    "registration.resources.describe",
    "registration.samples.projectPointCloud",
    "registration.samples.source",
    "registration.session.cancel",
    "registration.session.state",
    "registration.siteCalibration.inspect",
];

#[derive(Clone)]
struct RegistrationContext {
    registrations: Arc<ImportRegistrationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct RegistrationModule(RegistrationContext);

impl RegistrationModule {
    pub(super) fn new(
        registrations: Arc<ImportRegistrationRuntime>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(RegistrationContext {
            registrations,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for RegistrationModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_registration_rpc(
                    request,
                    context.registrations,
                    context.canonical_app,
                ))
            })?;
        }
        Ok(())
    }
}
