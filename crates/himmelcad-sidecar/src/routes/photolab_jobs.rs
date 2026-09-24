use super::*;

pub(super) async fn handle_job_rpc(
    req: RpcRequest,
    jobs: &JobManager,
    projects: Arc<ProjectRuntime>,
    crs: &CrsService,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.jobs.startProductExport" => {
            match serde_json::from_value::<StartProductExportJobParams>(req.params) {
                Ok(params) => match prepare_product_export_job(params, &projects, crs).await {
                    Ok((job, request)) => {
                        let result = jobs
                            .start(job, move |context| {
                                let mut progress_error = None;
                                export_product(
                                    &request,
                                    &context.cancellation,
                                    |completed, total| {
                                        if progress_error.is_none() {
                                            progress_error = context
                                                .progress
                                                .report_blocking(JobProgress {
                                                    stage: PhotolabStage {
                                                        kind: PhotolabStageKind::Finalizing,
                                                        index: 0,
                                                        stage_count: 1,
                                                        label: "Export product atomically".into(),
                                                    },
                                                    metrics: ProgressMetrics {
                                                        completed_units: completed,
                                                        total_units: Some(total.max(1)),
                                                        completed_bytes: completed,
                                                        total_bytes: Some(total.max(1)),
                                                    },
                                                })
                                                .err()
                                                .map(|error| error.to_string());
                                        }
                                    },
                                )
                                .map_err(map_product_export_error)?;
                                if let Some(message) = progress_error {
                                    return Err(worker_error("progressSink", &message));
                                }
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startBatch" => {
            match serde_json::from_value::<StartBatchJobParams>(req.params) {
                Ok(params) => match prepare_batch_job(&params, &projects) {
                    Ok((job, frozen_plan)) => {
                        let frozen_request =
                            match freeze_job_request("photolab.jobs.startBatch", &params, &job) {
                                Ok(request) => request,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                        let admission_context = match projects.compute_context() {
                            Ok(context) => context,
                            Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                        };
                        let batch_image_count = if params.camera_entity_ids.is_empty() {
                            admission_context.camera_images.len()
                        } else {
                            params.camera_entity_ids.len()
                        };
                        let batch_target = EntityId(frozen_plan.project_id.clone());
                        let lineage_target = params.processing_set_id.clone();
                        let mut publication_targets = vec![
                            himmelcad_sidecar::job_runtime::PublicationTarget::alignment(
                                batch_target.clone(),
                                lineage_target.clone(),
                            ),
                        ];
                        let mut required_bytes = himmelcad_sidecar::job_runtime::estimate_job_bytes(
                            PhotolabJobKind::AlignPhotos,
                            himmelcad_sidecar::job_runtime::DiskEstimateScale::Images(
                                u64::try_from(batch_image_count).unwrap_or(u64::MAX),
                            ),
                        );
                        for step in &params.steps {
                            let BatchPipelineStep::Product {
                                configuration,
                                gcp_optimization_entity_id,
                            } = step
                            else {
                                continue;
                            };
                            let (product_kind, job_kind, scale) = match configuration {
                                ProductRunConfiguration::Depth { .. } => (himmelcad_domain_photogrammetry::photolab_products::ProductKind::DepthMaps, PhotolabJobKind::BuildDepthMaps, himmelcad_sidecar::job_runtime::DiskEstimateScale::Images(u64::try_from(batch_image_count).unwrap_or(u64::MAX))),
                                ProductRunConfiguration::Dense { .. } => (himmelcad_domain_photogrammetry::photolab_products::ProductKind::DensePointCloud, PhotolabJobKind::BuildDensePointCloud, himmelcad_sidecar::job_runtime::DiskEstimateScale::Images(u64::try_from(batch_image_count).unwrap_or(u64::MAX))),
                                ProductRunConfiguration::Dem { .. } => (himmelcad_domain_photogrammetry::photolab_products::ProductKind::Dem, PhotolabJobKind::BuildDem, himmelcad_sidecar::job_runtime::DiskEstimateScale::RasterPixels(0)),
                                ProductRunConfiguration::Ortho { .. } => (himmelcad_domain_photogrammetry::photolab_products::ProductKind::Orthomosaic, PhotolabJobKind::BuildOrthomosaic, himmelcad_sidecar::job_runtime::DiskEstimateScale::RasterPixels(0)),
                                ProductRunConfiguration::Mesh { .. } => (himmelcad_domain_photogrammetry::photolab_products::ProductKind::TexturedMesh, PhotolabJobKind::BuildMesh, himmelcad_sidecar::job_runtime::DiskEstimateScale::Fixed),
                                ProductRunConfiguration::Splat { .. } => (himmelcad_domain_photogrammetry::photolab_products::ProductKind::GaussianSplat, PhotolabJobKind::BuildGaussianSplat, himmelcad_sidecar::job_runtime::DiskEstimateScale::Fixed),
                            };
                            let product_lineage_target = match gcp_optimization_entity_id {
                                ProductGcpSelection::Explicit(entity_id) => Some(entity_id.clone()),
                                ProductGcpSelection::Latest | ProductGcpSelection::None => None,
                            };
                            publication_targets.push(
                                himmelcad_sidecar::job_runtime::PublicationTarget::product(
                                    product_kind,
                                    batch_target.clone(),
                                    product_lineage_target,
                                ),
                            );
                            required_bytes = required_bytes.saturating_add(
                                himmelcad_sidecar::job_runtime::estimate_job_bytes(job_kind, scale),
                            );
                        }
                        let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                            publication_targets,
                            disk_preflight: Some(himmelcad_sidecar::job_runtime::DiskPreflight {
                                required_bytes,
                                path: admission_context.working_path,
                            }),
                            memory_preflight: None,
                            toolchain_preflight: Some(
                                worker_toolchain_preflight(
                                    PhotolabJobKind::Batch,
                                    &batch_worker_requirements(&params.steps),
                                )
                                .into_admission(),
                            ),
                        };
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start_with_frozen_request_and_admission(
                                job,
                                frozen_request,
                                admission,
                                move |context| {
                                    run_batch_pipeline(params, frozen_plan, &context, &publisher)
                                },
                            )
                            .await;
                        job_start_response(req.id, result)
                    }
                    Err(error) => alignment_admission_rpc_err(req.id, &error),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startGcpOptimization" => {
            match serde_json::from_value::<StartGcpOptimizationJobParams>(req.params) {
                Ok(params) => match prepare_gcp_optimization_job(params, &projects) {
                    Ok((
                        job,
                        project_root,
                        alignment_dataset,
                        camera_root,
                        colmap,
                        run_params,
                        camera_images,
                        calibration_groups,
                        frozen_calibration_partition,
                        lineage,
                    )) => {
                        let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                            publication_targets: vec![
                                himmelcad_sidecar::job_runtime::PublicationTarget::optimization(
                                    lineage.source_alignment_entity_id.clone(),
                                    lineage.processing_set_id.clone(),
                                ),
                            ],
                            disk_preflight: None,
                            memory_preflight: None,
                            toolchain_preflight: Some(
                                worker_toolchain_preflight(
                                    PhotolabJobKind::OptimizeAlignment,
                                    &[WorkerProduct::Colmap],
                                )
                                .into_admission(),
                            ),
                        };
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start_with_admission(job, admission, move |context| {
                                let mut prepared_cameras = prepare_gcp_cameras(
                                    &colmap,
                                    &alignment_dataset,
                                    &camera_root,
                                    &context.cancellation,
                                )
                                .map_err(|error| {
                                    if matches!(
                                        error,
                                        himmelcad_sidecar::mvs_scene::MvsSceneError::Cancelled
                                    ) {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Cancelled
                                    } else {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "gcpCameraPreparation".into(),
                                            message: error.to_string(),
                                        }
                                    }
                                })?;
                                attach_camera_reference_priors(
                                    &mut prepared_cameras,
                                    &camera_images,
                                    &alignment_dataset,
                                    &calibration_groups,
                                    &frozen_calibration_partition,
                                )
                                .map_err(|error| {
                                    himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                        code: "gcpCameraPreparation".into(),
                                        message: error.to_string(),
                                    }
                                })?;
                                let tie_points = load_gcp_bundle_tie_points(
                                    &camera_root,
                                    run_params.options.maximum_tie_points,
                                    &context.cancellation,
                                )
                                .map_err(|error| {
                                    if matches!(
                                        error,
                                        himmelcad_sidecar::mvs_scene::MvsSceneError::Cancelled
                                    ) {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Cancelled
                                    } else {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "gcpTiePointPreparation".into(),
                                            message: error.to_string(),
                                        }
                                    }
                                })?;
                                let mut progress_error = None;
                                let outcome = run_gcp_optimization(
                                    &project_root,
                                    RunGcpOptimizationParams {
                                        cameras: prepared_cameras
                                            .into_iter()
                                            .map(|entry| entry.camera)
                                            .collect(),
                                        tie_points,
                                        ..run_params
                                    },
                                    &context.cancellation,
                                    |progress| {
                                        if progress_error.is_none() {
                                            progress_error = context
                                                .progress
                                                .report_blocking(gcp_job_progress(*progress))
                                                .err()
                                                .map(|error| error.to_string());
                                        }
                                    },
                                )
                                .map_err(map_gcp_optimization_error)?;
                                if let Some(message) = progress_error {
                                    return Err(
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "progressSink".into(),
                                            message,
                                        },
                                    );
                                }
                                context.check_cancelled()?;
                                publisher
                                    .publish_gcp_optimization(outcome, &lineage)
                                    .map_err(|error| {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "projectPublish".into(),
                                            message: error.to_string(),
                                        }
                                    })?;
                                Ok(())
                            })
                            .await;
                        job_start_response(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startImageQuality" => {
            match serde_json::from_value::<StartImageQualityJobParams>(req.params) {
                Ok(params) => match prepare_image_quality_job(params, &projects) {
                    Ok((job, project_root, cameras, scope, configuration)) => {
                        let publisher = Arc::clone(&projects);
                        let job_id = job.id.0.clone();
                        let result = jobs
                            .start(job, move |context| {
                                let analyses = analyze_project_images(
                                    &project_root,
                                    &job_id,
                                    &cameras,
                                    &scope,
                                    &configuration,
                                    &context,
                                )
                                .map_err(image_quality_worker_error)?;
                                context.check_cancelled()?;
                                publisher
                                    .publish_image_quality_analyses(&job_id, analyses)
                                    .map_err(|error| JobWorkerError::Failed {
                                        code: "projectPublish".into(),
                                        message: error.to_string(),
                                    })?;
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startAlignment" => {
            match serde_json::from_value::<StartAlignmentJobParams>(req.params) {
                Ok(params) => {
                    const GIB: u64 = 1024 * 1024 * 1024;
                    let physical_memory_bytes =
                        probe_hardware().map_or(8 * GIB, |hardware| hardware.ram_bytes);
                    let machine_usable_bytes = physical_memory_bytes
                        .saturating_sub(memory_os_ui_reserve_bytes(physical_memory_bytes));
                    let usable_memory_bytes = jobs.usable_memory_bytes(physical_memory_bytes).await;
                    let measured_extraction_bytes_per_pixel =
                        jobs.measured_extraction_bytes_per_pixel().await;
                    match prepare_alignment_job(
                        params,
                        &projects,
                        usable_memory_bytes,
                        measured_extraction_bytes_per_pixel,
                    ) {
                        Ok((
                            job,
                            request,
                            runtime,
                            dedode,
                            processing_set_id,
                            memory_plan,
                            refusal,
                        )) => {
                            let combined_stage_count = job.progress.stage.stage_count;
                            let colmap_stage_base = if dedode.is_some() { 3 } else { 0 };
                            let admission_context = match projects.compute_context() {
                                Ok(context) => context,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                            let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                                publication_targets: vec![
                                    himmelcad_sidecar::job_runtime::PublicationTarget::alignment(
                                        EntityId(admission_context.manifest.project_id),
                                        processing_set_id.clone(),
                                    ),
                                ],
                                disk_preflight: Some(
                                    himmelcad_sidecar::job_runtime::DiskPreflight::for_job(
                                        PhotolabJobKind::AlignPhotos,
                                        himmelcad_sidecar::job_runtime::DiskEstimateScale::Images(
                                            u64::try_from(request.camera_images.len())
                                                .unwrap_or(u64::MAX),
                                        ),
                                        request.project_root.clone(),
                                    ),
                                ),
                                memory_preflight: Some(MemoryPreflight {
                                    predicted_bytes: memory_plan.predicted_peak_bytes,
                                    available_bytes: usable_memory_bytes,
                                    machine_usable_bytes,
                                    memory: memory_plan.memory,
                                    refusal,
                                }),
                                toolchain_preflight: Some(
                                    worker_toolchain_preflight(
                                        PhotolabJobKind::AlignPhotos,
                                        &[WorkerProduct::Alignment {
                                            dedode: dedode.is_some(),
                                        }],
                                    )
                                    .into_admission(),
                                ),
                            };
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                            .start_with_admission(job, admission, move |context| {
                                let mut outcome = match dedode {
                                    Some((dedode_runtime, dedode_request)) => {
                                        let dedode_context =
                                            context.with_progress_window(0, combined_stage_count);
                                        let dedode_outcome = dedode_runtime
                                            .run(&dedode_request, &dedode_context)
                                            .map_err(himmelcad_sidecar::job_runtime::JobWorkerError::from)?;
                                        context.check_cancelled()?;
                                        let colmap_context = context.with_progress_window(
                                            colmap_stage_base,
                                            combined_stage_count,
                                        );
                                        runtime.run_with_dedode(
                                            &request,
                                            &dedode_outcome,
                                            &colmap_context,
                                        )
                                    }
                                    None => {
                                        let colmap_context = context.with_progress_window(
                                            colmap_stage_base,
                                            combined_stage_count,
                                        );
                                        runtime.run(&request, &colmap_context)
                                    }
                                }
                                .map_err(himmelcad_sidecar::job_runtime::JobWorkerError::from)?;
                                prepare_alignment_sparse_potree(&mut outcome, &context)?;
                                prepare_alignment_mesh(&mut outcome, &context)?;
                                context.check_cancelled()?;
                                publisher
                                    .publish_colmap_outcome_for_processing_set(
                                        outcome,
                                        processing_set_id,
                                        &context.cancellation,
                                    )
                                    .map_err(|error| {
                                        map_project_publish_error(error, &context.cancellation)
                                    })?;
                                Ok(())
                            })
                            .await;
                            job_start_response(req.id, result)
                        }
                        Err(error) => alignment_admission_rpc_err(req.id, &error),
                    }
                }
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startAlignmentMerge" => {
            match serde_json::from_value::<StartAlignmentMergeJobParams>(req.params) {
                Ok(params) => {
                    const GIB: u64 = 1024 * 1024 * 1024;
                    let physical_memory_bytes =
                        probe_hardware().map_or(8 * GIB, |hardware| hardware.ram_bytes);
                    let machine_usable_bytes = physical_memory_bytes
                        .saturating_sub(memory_os_ui_reserve_bytes(physical_memory_bytes));
                    let usable_memory_bytes = jobs.usable_memory_bytes(physical_memory_bytes).await;
                    let measured_extraction_bytes_per_pixel =
                        jobs.measured_extraction_bytes_per_pixel().await;
                    match prepare_alignment_merge_job(
                        params,
                        &projects,
                        usable_memory_bytes,
                        measured_extraction_bytes_per_pixel,
                    ) {
                        Ok((
                            job,
                            request,
                            runtime,
                            dedode,
                            merge_entity_id,
                            resumed,
                            resumed_shared,
                            shared_control_only,
                            memory_plan,
                            refusal,
                        )) => {
                            let combined_stage_count = job.progress.stage.stage_count;
                            let colmap_stage_base = if dedode.is_some() { 3 } else { 0 };
                            let worker_products = if shared_control_only {
                                Vec::new()
                            } else {
                                vec![WorkerProduct::Alignment {
                                    dedode: dedode.is_some(),
                                }]
                            };
                            let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                                publication_targets: vec![
                                    himmelcad_sidecar::job_runtime::PublicationTarget::alignment(
                                        merge_entity_id.clone(),
                                        None,
                                    ),
                                ],
                                disk_preflight: Some(
                                    himmelcad_sidecar::job_runtime::DiskPreflight::for_job(
                                        PhotolabJobKind::MergeAlignments,
                                        himmelcad_sidecar::job_runtime::DiskEstimateScale::Images(
                                            u64::try_from(request.camera_images.len())
                                                .unwrap_or(u64::MAX),
                                        ),
                                        request.project_root.clone(),
                                    ),
                                ),
                                memory_preflight: Some(MemoryPreflight {
                                    predicted_bytes: memory_plan.predicted_peak_bytes,
                                    available_bytes: memory_plan.memory.envelope_bytes,
                                    machine_usable_bytes,
                                    memory: memory_plan.memory,
                                    refusal,
                                }),
                                toolchain_preflight: Some(
                                    worker_toolchain_preflight(
                                        PhotolabJobKind::MergeAlignments,
                                        &worker_products,
                                    )
                                    .into_admission(),
                                ),
                            };
                            let checkpoint_project_root = request.project_root.clone();
                            let checkpoint_operation_id = request.job_id.clone();
                            let checkpoint_input_hash = job.input_hash.clone();
                            let checkpoint_config_hash = job.config_hash.clone();
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                            .start_with_admission(job, admission, move |context| {
                                if shared_control_only {
                                    context.progress.report_blocking(JobProgress {
                                        stage: PhotolabStage { kind: PhotolabStageKind::Preparing, index: 0, stage_count: 3, label: "Validate shared controls".into() },
                                        metrics: ProgressMetrics { completed_units: 1, total_units: Some(1), completed_bytes: 0, total_bytes: None },
                                    }).map_err(JobWorkerError::from)?;
                                    let merge = publisher.alignment_merge_compute_context(&merge_entity_id).map_err(|error| worker_error("alignmentMergeInput", &error.to_string()))?;
                                    let scopes = merge.record.input_alignment_entity_ids.iter().map(|alignment_id| {
                                        let cameras = merge.input_camera_scopes.get(&alignment_id.0).cloned().unwrap_or_default().into_iter().collect::<BTreeSet<_>>();
                                        (alignment_id.clone(), cameras)
                                    }).collect::<Vec<_>>();
                                    let shared_inputs = scopes.iter().map(|(alignment_id, cameras)| {
                                        let optimization = merge.optimization_records.get(&alignment_id.0).with_context(|| format!("shared-control merge has no published GCP optimization for {}", alignment_id.0))?;
                                        anyhow::ensure!(optimization.artifact.result.converged, "GCP optimization for {} did not converge", alignment_id.0);
                                        let dataset = merge.input_dataset_roots.get(&alignment_id.0).context("shared-control merge lost an input dataset")?;
                                        Ok(SharedControlInput { alignment_id, dataset_root: dataset, camera_entity_ids: cameras, transform: optimization.artifact.result.transform, optimized_cameras: &optimization.artifact.result.cameras })
                                    }).collect::<anyhow::Result<Vec<_>>>().map_err(|error| worker_error("alignmentMergeInput", &error.to_string()))?;
                                    context.progress.report_blocking(JobProgress {
                                        stage: PhotolabStage { kind: PhotolabStageKind::SparseReconstruction, index: 1, stage_count: 3, label: "Assemble optimized survey blocks".into() },
                                        metrics: ProgressMetrics::empty(),
                                    }).map_err(JobWorkerError::from)?;
                                    let outcome = if let Some(outcome) = resumed_shared {
                                        outcome
                                    } else {
                                        build_shared_control_merge(&checkpoint_project_root, &checkpoint_operation_id, &shared_inputs, &context.cancellation).map_err(|error| {
                                            if matches!(error, himmelcad_sidecar::alignment_merge_runtime::AlignmentMergeRuntimeError::Cancelled) { JobWorkerError::Cancelled } else { worker_error("sharedControlMerge", &error.to_string()) }
                                        })?
                                    };
                                    let scratch_relative_path = outcome.scratch_path.strip_prefix(&checkpoint_project_root).map_err(|_| worker_error("alignmentMergeCheckpoint", "shared-control merge scratch escaped the project"))?.to_path_buf();
                                    write_merge_checkpoint(&checkpoint_project_root, &AlignmentMergeCheckpoint { schema_version: 1, operation_id: checkpoint_operation_id.clone(), merge_entity_id: merge_entity_id.clone(), input_hash: checkpoint_input_hash.clone(), config_hash: checkpoint_config_hash.clone(), state: AlignmentMergeCheckpointState::Solved, scratch_relative_path: Some(scratch_relative_path), summary_sha256: Some(outcome.dataset_sha256.clone()) }).map_err(|error| worker_error("alignmentMergeCheckpoint", &error.to_string()))?;
                                    context.check_cancelled()?;
                                    context.progress.report_blocking(JobProgress {
                                        stage: PhotolabStage { kind: PhotolabStageKind::Finalizing, index: 2, stage_count: 3, label: "Publish common survey frame".into() },
                                        metrics: ProgressMetrics::empty(),
                                    }).map_err(JobWorkerError::from)?;
                                    publisher.publish_shared_control_merge_outcome(&merge_entity_id, outcome, &checkpoint_operation_id).map_err(|error| worker_error("alignmentMergePublish", &error.to_string()))?;
                                    write_merge_checkpoint(&checkpoint_project_root, &AlignmentMergeCheckpoint { schema_version: 1, operation_id: checkpoint_operation_id, merge_entity_id, input_hash: checkpoint_input_hash, config_hash: checkpoint_config_hash, state: AlignmentMergeCheckpointState::Published, scratch_relative_path: None, summary_sha256: None })
                                        .map_err(|error| worker_error("alignmentMergeCheckpoint", &error.to_string()))?;
                                    return Ok(());
                                }
                                let solve = resumed.map_or_else(
                                    || match dedode {
                                        Some((dedode_runtime, dedode_request)) => {
                                            let dedode_context = context
                                                .with_progress_window(0, combined_stage_count);
                                            let dedode_outcome = dedode_runtime
                                                .run(&dedode_request, &dedode_context)
                                                .map_err(JobWorkerError::from);
                                            dedode_outcome.and_then(|dedode_outcome| {
                                                context.check_cancelled()?;
                                                runtime
                                                    .run_with_dedode(
                                                        &request,
                                                        &dedode_outcome,
                                                        &context.with_progress_window(
                                                            colmap_stage_base,
                                                            combined_stage_count,
                                                        ),
                                                    )
                                                    .map_err(JobWorkerError::from)
                                            })
                                        }
                                        None => runtime
                                            .run(
                                                &request,
                                                &context.with_progress_window(
                                                    colmap_stage_base,
                                                    combined_stage_count,
                                                ),
                                            )
                                            .map_err(JobWorkerError::from),
                                    },
                                    Ok,
                                );
                                let outcome = match solve {
                                    Ok(outcome) => outcome,
                                    Err(error) => {
                                        if matches!(error, JobWorkerError::Cancelled) {
                                            let cancelled_checkpoint = AlignmentMergeCheckpoint {
                                                schema_version: 1,
                                                operation_id: checkpoint_operation_id.clone(),
                                                merge_entity_id: merge_entity_id.clone(),
                                                input_hash: checkpoint_input_hash.clone(),
                                                config_hash: checkpoint_config_hash.clone(),
                                                state: AlignmentMergeCheckpointState::Cancelled,
                                                scratch_relative_path: None,
                                                summary_sha256: None,
                                            };
                                            if let Err(first_error) = write_merge_checkpoint(
                                                &checkpoint_project_root,
                                                &cancelled_checkpoint,
                                            ) {
                                                tracing::error!(
                                                    job_id = %checkpoint_operation_id,
                                                    error = %first_error,
                                                    "failed to write cancelled alignment-merge checkpoint; retrying once"
                                                );
                                                if let Err(retry_error) = write_merge_checkpoint(
                                                    &checkpoint_project_root,
                                                    &cancelled_checkpoint,
                                                ) {
                                                    let diagnostic = format!(
                                                        "Cancelled alignment-merge checkpoint could not be written after one retry: {retry_error} (first attempt: {first_error})"
                                                    );
                                                    tracing::error!(
                                                        job_id = %checkpoint_operation_id,
                                                        error = %retry_error,
                                                        first_error = %first_error,
                                                        "cancelled alignment-merge checkpoint retry failed"
                                                    );
                                                    if let Err(diagnostic_error) = context
                                                        .diagnostics
                                                        .record_blocking(diagnostic)
                                                    {
                                                        tracing::error!(
                                                            job_id = %checkpoint_operation_id,
                                                            error = %diagnostic_error,
                                                            "failed to persist alignment-merge cancellation diagnostic"
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        return Err(error);
                                    }
                                };
                                let scratch_relative_path = outcome
                                    .scratch_path
                                    .strip_prefix(&checkpoint_project_root)
                                    .map_err(|_| {
                                        worker_error(
                                            "alignmentMergeCheckpoint",
                                            "merge scratch path escaped the project",
                                        )
                                    })?
                                    .to_path_buf();
                                write_merge_checkpoint(
                                    &checkpoint_project_root,
                                    &AlignmentMergeCheckpoint {
                                        schema_version: 1,
                                        operation_id: checkpoint_operation_id.clone(),
                                        merge_entity_id: merge_entity_id.clone(),
                                        input_hash: checkpoint_input_hash.clone(),
                                        config_hash: checkpoint_config_hash.clone(),
                                        state: AlignmentMergeCheckpointState::Solved,
                                        scratch_relative_path: Some(scratch_relative_path),
                                        summary_sha256: Some(outcome.summary_sha256.clone()),
                                    },
                                )
                                .map_err(|error| {
                                    worker_error("alignmentMergeCheckpoint", &error.to_string())
                                })?;
                                context.check_cancelled()?;
                                publisher
                                    .publish_alignment_merge_outcome(&merge_entity_id, outcome)
                                    .map_err(|error| {
                                        worker_error("alignmentMergePublish", &error.to_string())
                                    })?;
                                write_merge_checkpoint(
                                    &checkpoint_project_root,
                                    &AlignmentMergeCheckpoint {
                                        schema_version: 1,
                                        operation_id: checkpoint_operation_id,
                                        merge_entity_id,
                                        input_hash: checkpoint_input_hash,
                                        config_hash: checkpoint_config_hash,
                                        state: AlignmentMergeCheckpointState::Published,
                                        scratch_relative_path: None,
                                        summary_sha256: None,
                                    },
                                )
                                .map_err(|error| {
                                    worker_error("alignmentMergeCheckpoint", &error.to_string())
                                })?;
                                Ok(())
                            })
                            .await;
                            job_start_response(req.id, result)
                        }
                        Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                    }
                }
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startProduct" => {
            match serde_json::from_value::<StartProductJobParams>(req.params) {
                Ok(params)
                    if matches!(params.configuration, ProductRunConfiguration::Splat { .. }) =>
                {
                    let frozen_params = params.clone();
                    match prepare_brush_product_job(params, &projects, None, false) {
                        Ok((job, request, runtime, lineage)) => {
                            let frozen_request = match freeze_job_request(
                                "photolab.jobs.startProduct",
                                &frozen_params,
                                &job,
                            ) {
                                Ok(request) => request,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                            let project_root = match projects.compute_context() {
                                Ok(context) => context.working_path,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                            let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                                publication_targets: vec![
                                    himmelcad_sidecar::job_runtime::PublicationTarget::product(
                                        himmelcad_domain_photogrammetry::photolab_products::ProductKind::GaussianSplat,
                                        lineage.source_alignment_entity_id.clone(),
                                        lineage.gcp_optimization_entity_id.clone(),
                                    ),
                                ],
                                disk_preflight: Some(
                                    himmelcad_sidecar::job_runtime::DiskPreflight::for_job(
                                        PhotolabJobKind::BuildGaussianSplat,
                                        himmelcad_sidecar::job_runtime::DiskEstimateScale::Fixed,
                                        project_root,
                                    ),
                                ),
                                memory_preflight: Some(MemoryPreflight::unbounded(
                                    fallback_alignment_usable_memory_bytes(),
                                    "Splat optimization",
                                )),
                                toolchain_preflight: Some(
                                    worker_toolchain_preflight(
                                        PhotolabJobKind::BuildGaussianSplat,
                                        &[WorkerProduct::GaussianSplat],
                                    )
                                    .into_admission(),
                                ),
                            };
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start_with_frozen_request_and_admission(
                                    job,
                                    frozen_request,
                                    admission,
                                    move |context| {
                                        let mut outcome = runtime.run(&request, &context).map_err(
                                            himmelcad_sidecar::job_runtime::JobWorkerError::from,
                                        )?;
                                        let project_transform =
                                            pinned_product_gcp_optimization(&publisher, &lineage)
                                                .map_err(|error| {
                                                    worker_error("projectRead", &error.to_string())
                                                })?
                                                .map(|record| record.artifact.result.transform);
                                        let prepared = tile_brush_ply(
                                            &outcome.output_path,
                                            &outcome.scratch_path.join("prepared-splats"),
                                            project_transform,
                                            &context.cancellation,
                                        )
                                        .map_err(map_splat_tiler_error)?;
                                        outcome.prepared_splats = Some(prepared);
                                        context.check_cancelled()?;
                                        publisher.publish_brush_outcome(outcome, &lineage).map_err(
                                        |error| {
                                            himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                                code: "projectPublish".into(),
                                                message: error.to_string(),
                                            }
                                        },
                                    )?;
                                        Ok(())
                                    },
                                )
                                .await;
                            job_start_response(req.id, result)
                        }
                        Err(error) => product_rpc_err(req.id, &error),
                    }
                }
                Ok(params)
                    if matches!(
                        params.configuration,
                        ProductRunConfiguration::Depth { .. }
                            | ProductRunConfiguration::Dense { .. }
                    ) =>
                {
                    let frozen_params = params.clone();
                    match prepare_mvs_product_job(params, &projects, None) {
                        Ok(prepared) => {
                            let frozen_request = match freeze_job_request(
                                "photolab.jobs.startProduct",
                                &frozen_params,
                                &prepared.job,
                            ) {
                                Ok(request) => request,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                            let (product_kind, job_kind) = match prepared.job.kind {
                                PhotolabJobKind::BuildDepthMaps => (
                                    himmelcad_domain_photogrammetry::photolab_products::ProductKind::DepthMaps,
                                    PhotolabJobKind::BuildDepthMaps,
                                ),
                                PhotolabJobKind::BuildDensePointCloud => (
                                    himmelcad_domain_photogrammetry::photolab_products::ProductKind::DensePointCloud,
                                    PhotolabJobKind::BuildDensePointCloud,
                                ),
                                _ => unreachable!("MVS product preparation returned another kind"),
                            };
                            let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                                publication_targets: vec![
                                    himmelcad_sidecar::job_runtime::PublicationTarget::product(
                                        product_kind,
                                        prepared.lineage.source_alignment_entity_id.clone(),
                                        prepared.lineage.gcp_optimization_entity_id.clone(),
                                    ),
                                ],
                                disk_preflight: Some(
                                    himmelcad_sidecar::job_runtime::DiskPreflight::for_job(
                                        job_kind,
                                        himmelcad_sidecar::job_runtime::DiskEstimateScale::Images(
                                            u64::try_from(prepared.camera_entity_ids.len())
                                                .unwrap_or(u64::MAX),
                                        ),
                                        prepared.project_root.clone(),
                                    ),
                                ),
                                memory_preflight: Some(MemoryPreflight::unbounded(
                                    fallback_alignment_usable_memory_bytes(),
                                    if job_kind == PhotolabJobKind::BuildDepthMaps {
                                        "Depth estimation"
                                    } else {
                                        "Dense fusion"
                                    },
                                )),
                                toolchain_preflight: Some(
                                    worker_toolchain_preflight(
                                        job_kind,
                                        &[if job_kind == PhotolabJobKind::BuildDepthMaps {
                                            WorkerProduct::DepthMaps
                                        } else {
                                            WorkerProduct::DensePointCloud
                                        }],
                                    )
                                    .into_admission(),
                                ),
                            };
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start_with_frozen_request_and_admission(
                                    prepared.job.clone(),
                                    frozen_request,
                                    admission,
                                    move |context| {
                                        let scene =
                                            prepare_or_reuse_mvs_scene(&prepared, &context)?;
                                        let resume = if prepared.reuse_compatible_maps {
                                            prepared.runtime.compatible_resume_checkpoint(
                                                &scene.manifest_sha256,
                                                &prepared.settings,
                                            )?
                                        } else {
                                            None
                                        };
                                        let request = MvsRunRequest {
                                            job_id: prepared.operation_id,
                                            scene_manifest_path: scene.manifest_path,
                                            scene_manifest_sha256: scene.manifest_sha256,
                                            device: MvsComputeDevice::Cpu {
                                                threads: portable_mvs_threads(),
                                            },
                                            settings: prepared.settings,
                                            fuse_dense_point_cloud: prepared.fuse_dense_point_cloud,
                                            resume,
                                        };
                                        let mut outcome =
                                        prepared.runtime.run(&request, &context).map_err(
                                            himmelcad_sidecar::job_runtime::JobWorkerError::from,
                                        )?;
                                        if let Some(dense) =
                                            outcome.output.dense_point_cloud.as_ref()
                                        {
                                            let dense_path =
                                                outcome.output_path.join(&dense.relative_path);
                                            let potree = prepare_dense_potree(
                                                &dense_path,
                                                &outcome.scratch_path.join("potree"),
                                                &potree_converter_executable()?,
                                                &context.cancellation,
                                            )
                                            .map_err(map_dense_prep_error)?;
                                            outcome.potree = Some(potree);
                                        }
                                        context.check_cancelled()?;
                                        publisher
                                            .publish_mvs_outcome(
                                                outcome,
                                                &prepared.camera_entity_ids,
                                                &prepared.image_mask_scope.scope_sha256,
                                                &prepared.lineage,
                                                &context.cancellation,
                                            )
                                            .map_err(|error| {
                                                map_project_publish_error(
                                                    error,
                                                    &context.cancellation,
                                                )
                                            })?;
                                        Ok(())
                                    },
                                )
                                .await;
                            job_start_response(req.id, result)
                        }
                        Err(error) => product_rpc_err(req.id, &error),
                    }
                }
                Ok(params)
                    if matches!(
                        params.configuration,
                        ProductRunConfiguration::Dem { .. } | ProductRunConfiguration::Ortho { .. }
                    ) =>
                {
                    let frozen_params = params.clone();
                    match prepare_raster_product_job(params, &projects, None) {
                        Ok(prepared) => {
                            let frozen_request = match freeze_job_request(
                                "photolab.jobs.startProduct",
                                &frozen_params,
                                &prepared.job,
                            ) {
                                Ok(request) => request,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                            let (product_kind, gsd) = match &prepared.configuration {
                                ProductRunConfiguration::Dem {
                                    resolution_meters_per_pixel,
                                    ..
                                } => (
                                    himmelcad_domain_photogrammetry::photolab_products::ProductKind::Dem,
                                    *resolution_meters_per_pixel,
                                ),
                                ProductRunConfiguration::Ortho {
                                    resolution_meters_per_pixel,
                                    ..
                                } => (
                                    himmelcad_domain_photogrammetry::photolab_products::ProductKind::Orthomosaic,
                                    *resolution_meters_per_pixel,
                                ),
                                _ => {
                                    unreachable!("raster product preparation returned another kind")
                                }
                            };
                            let (bounds, dense_point_count) = if prepared.job.kind
                                == PhotolabJobKind::BuildDem
                            {
                                match projects.latest_dense_mvs_dataset_for_lineage(&prepared.lineage) {
                                    Ok((_, record)) => match record.potree {
                                        Some(potree) => ((potree.bounds_min, potree.bounds_max), potree.point_count),
                                        None => return rpc_err(req.id, -32000, "dense point cloud has no frozen bounds for disk preflight"),
                                    },
                                    Err(error) => return product_rpc_err(req.id, &error),
                                }
                            } else {
                                let summary = &prepared
                                    .dem_dataset
                                    .as_ref()
                                    .expect("orthomosaic preparation pins a DEM")
                                    .1
                                    .summary;
                                (
                                    (
                                        [
                                            summary.grid.bounds.minimum_east,
                                            summary.grid.bounds.minimum_north,
                                            0.0,
                                        ],
                                        [
                                            summary.grid.bounds.maximum_east,
                                            summary.grid.bounds.maximum_north,
                                            0.0,
                                        ],
                                    ),
                                    0,
                                )
                            };
                            let Some(raster_pixels) =
                                himmelcad_sidecar::job_runtime::raster_pixel_count(
                                    bounds.0, bounds.1, gsd,
                                )
                            else {
                                return rpc_err(
                                    req.id,
                                    -32000,
                                    "raster extent or GSD is invalid for disk preflight",
                                );
                            };
                            let disk_scale =
                                himmelcad_sidecar::job_runtime::DiskEstimateScale::DenseRaster {
                                    point_count: dense_point_count,
                                    raster_pixels,
                                };
                            let disk_estimate =
                                himmelcad_sidecar::job_runtime::disk_estimate_components(
                                    prepared.job.kind,
                                    disk_scale,
                                );
                            let raster_memory_plan = if prepared.job.kind
                                == PhotolabJobKind::BuildDem
                            {
                                const GIB: u64 = 1024 * 1024 * 1024;
                                let physical_memory_bytes =
                                    probe_hardware().map_or(8 * GIB, |hardware| hardware.ram_bytes);
                                let machine_usable_bytes = physical_memory_bytes.saturating_sub(
                                    memory_os_ui_reserve_bytes(physical_memory_bytes),
                                );
                                let usable_memory_bytes =
                                    jobs.usable_memory_bytes(physical_memory_bytes).await;
                                Some((
                                    plan_raster_preparation_memory(
                                        dense_point_count,
                                        disk_estimate.output_bytes,
                                        usable_memory_bytes,
                                    ),
                                    machine_usable_bytes,
                                ))
                            } else {
                                None
                            };
                            let disk_path = prepared
                                .project_root
                                .join(".photolab/raster-inputs")
                                .join(&prepared.operation_id);
                            let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                                publication_targets: vec![
                                    himmelcad_sidecar::job_runtime::PublicationTarget::product(
                                        product_kind,
                                        prepared.lineage.source_alignment_entity_id.clone(),
                                        prepared.lineage.gcp_optimization_entity_id.clone(),
                                    ),
                                ],
                                disk_preflight: Some(
                                    himmelcad_sidecar::job_runtime::DiskPreflight::for_job(
                                        prepared.job.kind,
                                        disk_scale,
                                        disk_path,
                                    ),
                                ),
                                memory_preflight: raster_memory_plan.as_ref().map(
                                    |(plan, machine_usable_bytes)| MemoryPreflight {
                                        predicted_bytes: plan.predicted_peak_bytes,
                                        available_bytes: plan.memory.envelope_bytes,
                                        machine_usable_bytes: *machine_usable_bytes,
                                        memory: plan.memory.clone(),
                                        refusal: plan.refusal.clone(),
                                    },
                                ),
                                toolchain_preflight: Some(
                                    worker_toolchain_preflight(
                                        prepared.job.kind,
                                        &[product_worker_requirement(&prepared.configuration)],
                                    )
                                    .into_admission(),
                                ),
                            };
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start_with_frozen_request_and_disk_admission(
                                    prepared.job.clone(),
                                    frozen_request,
                                    admission,
                                    disk_estimate,
                                    move |context| {
                                        run_raster_product(
                                            prepared,
                                            raster_memory_plan.map(|(plan, _)| plan),
                                            &context,
                                            &publisher,
                                        )
                                    },
                                )
                                .await;
                            job_start_response(req.id, result)
                        }
                        Err(error) => product_rpc_err(req.id, &error),
                    }
                }
                Ok(params)
                    if matches!(params.configuration, ProductRunConfiguration::Mesh { .. }) =>
                {
                    let frozen_params = params.clone();
                    match prepare_mesh_job(params, &projects, None) {
                        Ok(prepared) => {
                            let frozen_request = match freeze_job_request(
                                "photolab.jobs.startProduct",
                                &frozen_params,
                                &prepared.job,
                            ) {
                                Ok(request) => request,
                                Err(error) => return rpc_err(req.id, -32000, &error.to_string()),
                            };
                            let admission = himmelcad_sidecar::job_runtime::JobAdmission {
                                publication_targets: vec![
                                    himmelcad_sidecar::job_runtime::PublicationTarget::product(
                                        himmelcad_domain_photogrammetry::photolab_products::ProductKind::TexturedMesh,
                                        prepared.lineage.source_alignment_entity_id.clone(),
                                        prepared.lineage.gcp_optimization_entity_id.clone(),
                                    ),
                                ],
                                disk_preflight: Some(
                                    himmelcad_sidecar::job_runtime::DiskPreflight::for_job(
                                        PhotolabJobKind::BuildMesh,
                                        himmelcad_sidecar::job_runtime::DiskEstimateScale::Fixed,
                                        prepared.project_root.clone(),
                                    ),
                                ),
                                memory_preflight: Some(MemoryPreflight::unbounded(
                                    fallback_alignment_usable_memory_bytes(),
                                    "Meshing",
                                )),
                                toolchain_preflight: Some(
                                    worker_toolchain_preflight(
                                        PhotolabJobKind::BuildMesh,
                                        &[WorkerProduct::Mesh {
                                            requires_colmap: prepared.mesh_source
                                                == himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense,
                                        }],
                                    )
                                    .into_admission(),
                                ),
                            };
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start_with_frozen_request_and_admission(
                                    prepared.job.clone(),
                                    frozen_request,
                                    admission,
                                    move |context| run_mesh_job(prepared, &context, &publisher),
                                )
                                .await;
                            job_start_response(req.id, result)
                        }
                        Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                    }
                }
                Ok(_) => rpc_err(
                    req.id,
                    -32603,
                    "product configuration did not match a registered runtime",
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.resume" => match serde_json::from_value::<ResumeJobParams>(req.params) {
            Ok(params) => match resume_history_job(params, jobs, &projects).await {
                Ok(result) => rpc_result(req.id, Ok::<_, anyhow::Error>(result)),
                Err(error) => rpc_resume_err(req.id, &error),
            },
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.jobs.list" => match serde_json::from_value::<ListJobsParams>(req.params) {
            Ok(params) => rpc_result(req.id, jobs.list(params).await.map_err(anyhow::Error::from)),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.jobs.status" => match serde_json::from_value::<JobIdParams>(req.params) {
            Ok(params) => rpc_result(
                req.id,
                jobs.status(&params.job_id)
                    .await
                    .map_err(anyhow::Error::from),
            ),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.jobs.cancel" => match serde_json::from_value::<JobIdParams>(req.params) {
            Ok(params) => rpc_result(
                req.id,
                jobs.cancel(&params.job_id)
                    .await
                    .map_err(anyhow::Error::from),
            ),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.jobs.cancel",
    "photolab.jobs.list",
    "photolab.jobs.resume",
    "photolab.jobs.startAlignment",
    "photolab.jobs.startAlignmentMerge",
    "photolab.jobs.startBatch",
    "photolab.jobs.startGcpOptimization",
    "photolab.jobs.startImageQuality",
    "photolab.jobs.startProduct",
    "photolab.jobs.startProductExport",
    "photolab.jobs.status",
];

#[derive(Clone)]
struct PhotolabJobsContext {
    jobs: Arc<JobManager>,
    projects: Arc<ProjectRuntime>,
    crs: Arc<CrsService>,
}

pub(super) struct PhotolabJobsModule(PhotolabJobsContext);

impl PhotolabJobsModule {
    pub(super) fn new(
        jobs: Arc<JobManager>,
        projects: Arc<ProjectRuntime>,
        crs: Arc<CrsService>,
    ) -> Self {
        Self(PhotolabJobsContext {
            jobs,
            projects,
            crs,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabJobsModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(async move {
                    handle_job_rpc(request, &context.jobs, context.projects, &context.crs).await
                })
            })?;
        }
        Ok(())
    }
}
