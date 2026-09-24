use super::*;

#[derive(Default)]
struct LoggingProviderContext;

impl ProviderOperationContext for LoggingProviderContext {
    fn is_cancelled(&self) -> bool {
        false
    }

    fn report_progress(&mut self, progress: ProviderProgress) {
        tracing::info!(
            phase = progress.phase,
            completed = progress.completed,
            total = progress.total,
            message = progress.message,
            "canonical import progress"
        );
    }
}

pub(super) const METHODS: &[&str] = &["import.ifc", "import.las", "import.las.cancel"];
#[derive(Clone)]
struct BuilderRootContext {
    las_imports: Arc<LasImportOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct RootModule {
    context: BuilderRootContext,
}

impl RootModule {
    pub(super) fn new(
        las_imports: Arc<LasImportOperations>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self {
            context: BuilderRootContext {
                las_imports,
                canonical_app,
            },
        }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for RootModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.context.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_builder_root(request, context))
            })?;
        }
        Ok(())
    }
}

async fn handle_builder_root(request: RpcRequest, context: BuilderRootContext) -> RpcResponse {
    match request.method.as_str() {
        "import.las" => match serde_json::from_value::<ImportLasParams>(request.params.clone()) {
            Ok(params) => {
                match handle_import_las(params, context.las_imports, context.canonical_app).await {
                    Ok(value) => RpcResponse {
                        jsonrpc: "2.0",
                        id: request.id,
                        result: Some(value),
                        error: None,
                    },
                    Err(error) => {
                        rpc_err(request.id, -32000, &format!("import.las failed: {error}"))
                    }
                }
            }
            Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
        },
        "import.las.cancel" => {
            match serde_json::from_value::<CancelLasImportParams>(request.params.clone()) {
                Ok(params) => rpc_result(
                    request.id,
                    Ok::<_, anyhow::Error>(serde_json::json!({
                        "operationId": params.operation_id,
                        "cancellationRequested": context.las_imports.cancel(&params.operation_id),
                    })),
                ),
                Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "import.ifc" => match serde_json::from_value::<ImportIfcParams>(request.params.clone()) {
            Ok(params) => {
                let canonical_app = Arc::clone(&context.canonical_app);
                rpc_blocking(request.id, move || {
                    let (staged, command_id) = handle_import_ifc(params)?;
                    canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import(&staged, &command_id)?;
                    Ok(staged.package)
                })
                .await
            }
            Err(error) => rpc_err(request.id, -32602, &format!("invalid params: {error}")),
        },
        _ => unreachable!("builder root module registered an unrelated method"),
    }
}

fn handle_import_ifc(params: ImportIfcParams) -> anyhow::Result<(CanonicalStagedImport, String)> {
    let source = PathBuf::from(params.path);
    anyhow::ensure!(
        source.is_file(),
        "IFC source does not exist: {}",
        source.display()
    );
    anyhow::ensure!(
        !params.import_namespace.trim().is_empty(),
        "IFC import namespace is empty"
    );
    let mut prefix = vec![0_u8; 128 * 1024];
    let mut source_file = std::fs::File::open(&source)
        .with_context(|| format!("failed to read IFC source {}", source.display()))?;
    let prefix_length = source_file.read(&mut prefix)?;
    let prefix = String::from_utf8_lossy(&prefix[..prefix_length]).to_ascii_uppercase();
    let format_id = if prefix.contains("IFC4X3") {
        IFC4X3_FORMAT_ID
    } else if prefix.contains("IFC2X3") {
        IFC2X3_FORMAT_ID
    } else {
        IFC4_FORMAT_ID
    };
    let cache_dir = params.cache_dir.map_or_else(
        || {
            std::env::temp_dir()
                .join("himmelcad-cache")
                .join("canonical")
        },
        PathBuf::from,
    );
    std::fs::create_dir_all(&cache_dir)?;
    let mut hasher = Sha256::new();
    let mut hash_file = std::fs::File::open(&source)?;
    let mut hash_buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = hash_file.read(&mut hash_buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&hash_buffer[..count]);
    }
    let source_hash = hex::encode(hasher.finalize());
    let package_path = cache_dir
        .join("ifc-packages")
        .join(format!("{source_hash}.json"));
    let provider = IfcCanonicalProvider::new(cache_dir.clone());
    let command_id = format!("ifc-import-{source_hash}-{}", unix_timestamp_millis());
    if package_path.is_file() {
        let package = serde_json::from_slice::<himmelcad_io::CanonicalImportPackage>(
            &std::fs::read(&package_path)?,
        )?;
        let roots = provider.staged_artifact_roots(&package)?;
        return Ok((CanonicalStagedImport { package, roots }, command_id));
    }
    let options = serde_json::json!({
        "acceptedLossCodes": ["hcad.loss.ifc.unsupported-geometry@1"],
        "importNamespace": params.import_namespace,
    });
    let mut operation_context = LoggingProviderContext;
    let package = provider
        .import(
            CanonicalImportRequest {
                source: &source,
                format_id,
                options: &options,
            },
            &mut operation_context,
        )
        .map_err(anyhow::Error::from)?;
    if let Some(parent) = package_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = package_path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&package)?)?;
    std::fs::rename(temporary, package_path)?;
    let roots = provider.staged_artifact_roots(&package)?;
    Ok((CanonicalStagedImport { package, roots }, command_id))
}

async fn handle_import_las(
    params: ImportLasParams,
    operations: Arc<LasImportOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> anyhow::Result<serde_json::Value> {
    if params.paths.is_empty() {
        anyhow::bail!("paths is empty");
    }
    let cache_dir = params.cache_dir.map_or_else(
        || std::env::temp_dir().join("himmelcad-cache"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&cache_dir)?;

    let mut summaries = Vec::with_capacity(params.paths.len());
    let mut combined_package: Option<himmelcad_io::CanonicalImportPackage> = None;
    let mut staged_roots = StagedArtifactRoots::default();
    let progress_key = params.progress_key.clone();
    let operation_id = params
        .operation_id
        .clone()
        .or_else(|| progress_key.clone())
        .unwrap_or_else(|| format!("las-import-{}", unix_timestamp_millis()));
    let active_operation = operations.begin(operation_id.clone())?;
    emit_progress(
        progress_key.as_deref(),
        0.01,
        &format!("Preparing {} LAS/LAZ file(s)", params.paths.len()),
    );

    let total = params.paths.len();
    for (index, raw) in params.paths.into_iter().enumerate() {
        let path = PathBuf::from(&raw);
        if !Path::new(&path).exists() {
            anyhow::bail!("file not found: {raw}");
        }
        let cache_dir_clone = cache_dir.clone();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&raw)
            .to_owned();
        let progress_key_for_file = progress_key.clone();
        let cancellation = Arc::clone(&active_operation.cancellation);
        let summary = tokio::task::spawn_blocking(move || {
            let progress_key_for_callback = progress_key_for_file.clone();
            let file_name_for_callback = file_name.clone();
            import_las_file_with_progress_and_cancel(
                &path,
                &cache_dir_clone,
                move |progress| {
                    emit_import_progress(
                        progress_key_for_callback.as_deref(),
                        index,
                        total,
                        &file_name_for_callback,
                        &progress,
                    );
                },
                move || cancellation.load(Ordering::Acquire),
            )
        })
        .await??;
        tracing::info!(
            path = %summary.source_path,
            loaded = summary.point_count_loaded,
            total = summary.point_count_total,
            "import.las completed"
        );
        let package = summary.canonical_import_package()?;
        staged_roots.dataset_roots.insert(
            summary.dataset_id.clone(),
            PathBuf::from(&summary.potree_dir),
        );
        if let Some(combined) = combined_package.as_mut() {
            combined.admissions.extend(package.admissions);
            for object in package.objects {
                if !combined
                    .objects
                    .iter()
                    .any(|existing| existing.object_hash == object.object_hash)
                {
                    combined.objects.push(object);
                }
            }
            combined.datasets.extend(package.datasets);
            combined.resource_sets.extend(package.resource_sets);
        } else {
            combined_package = Some(package);
        }
        summaries.push(summary);
    }
    let staged = CanonicalStagedImport {
        package: combined_package.context("LAS import produced no canonical package")?,
        roots: staged_roots,
    };
    if active_operation.cancellation.load(Ordering::Acquire) {
        anyhow::bail!("LAS import was cancelled before canonical publication");
    }
    let commit = canonical_app
        .lock()
        .expect("canonical app runtime mutex poisoned")
        .publish_staged_import(&staged, &operation_id)?;
    emit_progress(
        progress_key.as_deref(),
        0.85,
        &format!("Conversion finished for {total} LAS/LAZ file(s)"),
    );
    Ok(serde_json::json!({
        "operationId": operation_id,
        "imports": summaries,
        "journalEntry": commit.journal_entry,
    }))
}

fn unix_timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

fn emit_import_progress(
    progress_key: Option<&str>,
    file_index: usize,
    file_total: usize,
    file_name: &str,
    progress: &ConverterProgress,
) {
    let local = f64::from(progress.fraction.unwrap_or(0.0).clamp(0.0, 1.0));
    let total = u32::try_from(file_total.max(1)).unwrap_or(u32::MAX);
    let index = u32::try_from(file_index).unwrap_or(u32::MAX);
    let conversion_fraction = (f64::from(index) + local) / f64::from(total);
    let overall = 0.02 + 0.83 * conversion_fraction;
    let message = format!(
        "Converting {} ({}/{}): {}",
        file_name,
        file_index + 1,
        file_total,
        progress.message
    );
    emit_progress(progress_key, overall, &message);
}
