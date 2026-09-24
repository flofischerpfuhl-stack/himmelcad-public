use super::*;
use crate::canonical_project_store::{CanonicalImportProgress, CanonicalImportProgressPhase};
use io::{product_rpc_err, public_import_commit, validate_io_identity};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationStageParams {
    session_id: String,
    command_id: String,
    source_path: String,
    selection: ImportProviderSelection,
    options: serde_json::Value,
    recipe: RegistrationRecipe,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationSessionParams {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationResourceReadParams {
    session_id: String,
    capability: String,
    resource_id: String,
    offset: u64,
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationSourceSamplesParams {
    session_id: String,
    maximum_samples: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationProjectPointCloudSamplesParams {
    dataset_id: String,
    maximum_samples: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SiteCalibrationInspectParams {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationPointPairsParams {
    session_id: String,
    pairs: Vec<RegistrationPointPair>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationIcpParams {
    session_id: String,
    source: Vec<WorldPoint>,
    target: Vec<RegistrationTargetSample>,
    initial: Similarity3D,
    mode: IcpMode,
    options: IcpOptions,
}

struct RegistrationProviderContext {
    progress_key: String,
    last_fraction: f64,
    cancellation: CancellationToken,
}

impl RegistrationProviderContext {
    fn new(progress_key: String, cancellation: CancellationToken) -> Self {
        Self {
            progress_key,
            last_fraction: 0.0,
            cancellation,
        }
    }
}

impl ProviderOperationContext for RegistrationProviderContext {
    fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancel_requested()
    }

    #[allow(clippy::cast_precision_loss)]
    fn report_progress(&mut self, progress: ProviderProgress) {
        let local_fraction = progress
            .total
            .filter(|total| *total > 0)
            .map_or(self.last_fraction, |total| {
                progress.completed as f64 / total as f64
            })
            .clamp(0.0, 1.0);
        self.last_fraction = self.last_fraction.max(local_fraction);
        emit_progress(
            Some(&self.progress_key),
            0.02 + self.last_fraction * 0.68,
            &format!("Preparing hierarchy · {}", progress.message),
        );
        tracing::info!(
            phase = %progress.phase,
            completed = progress.completed,
            total = ?progress.total,
            message = %progress.message,
            "canonical import progress"
        );
    }
}

fn create_registration_scratch(session_id: &str) -> anyhow::Result<PathBuf> {
    validate_io_identity(session_id, "sessionId")?;
    let digest = hex::encode(Sha256::digest(session_id.as_bytes()));
    let parent = std::env::temp_dir().join("himmelcad-registration-sessions");
    std::fs::create_dir_all(&parent)?;
    let root = parent.join(format!("{}-{digest}", std::process::id()));
    std::fs::create_dir(&root).with_context(|| {
        format!(
            "registration scratch already exists or cannot be created: {}",
            root.display()
        )
    })?;
    Ok(root)
}

async fn rpc_blocking_product_with_params<P, T, F>(
    id: serde_json::Value,
    params: serde_json::Value,
    operation: F,
) -> RpcResponse
where
    P: serde::de::DeserializeOwned + Send + 'static,
    T: Serialize + Send + 'static,
    F: FnOnce(P) -> anyhow::Result<T> + Send + 'static,
{
    match serde_json::from_value::<P>(params) {
        Ok(params) => {
            let result = tokio::task::spawn_blocking(move || operation(params))
                .await
                .map_err(anyhow::Error::from)
                .and_then(std::convert::identity);
            match result {
                Ok(value) => rpc_result(id, Ok(value)),
                Err(error) => product_rpc_err(id, &error),
            }
        }
        Err(error) => rpc_err(id, -32602, &format!("invalid params: {error}")),
    }
}

#[allow(clippy::cast_precision_loss)]
fn emit_canonical_import_progress(progress_key: &str, progress: CanonicalImportProgress) {
    let local_fraction = if progress.total_bytes == 0 {
        1.0
    } else {
        progress.completed_bytes as f64 / progress.total_bytes as f64
    }
    .clamp(0.0, 1.0);
    let (overall_fraction, phase) = match progress.phase {
        CanonicalImportProgressPhase::Staging => {
            (0.70 + local_fraction * 0.24, "Registering dataset")
        }
        CanonicalImportProgressPhase::Publishing => {
            (0.94 + local_fraction * 0.05, "Registering journal head")
        }
    };
    let completed_gib = progress.completed_bytes as f64 / 1_073_741_824.0;
    let total_gib = progress.total_bytes as f64 / 1_073_741_824.0;
    emit_progress(
        Some(progress_key),
        overall_fraction,
        &format!("{phase} · {completed_gib:.2}/{total_gib:.2} GiB"),
    );
}

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
