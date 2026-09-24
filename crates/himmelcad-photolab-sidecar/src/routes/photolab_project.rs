use super::*;

pub(super) async fn handle_project_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    jobs: &JobManager,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.project.create" => {
            let (job_drain, side_drain) = drain_project_work(jobs, &projects).await;
            if !job_drain.completed() || !side_drain.completed() {
                return drain_timeout_response(req.id, &job_drain, &side_drain);
            }
            let operation_projects = Arc::clone(&projects);
            let response = rpc_blocking_with_params::<CreateProjectParams, _, _>(
                req.id,
                req.params,
                move |params| operation_projects.create(params),
            )
            .await;
            jobs.resume_admission();
            projects.resume_side_operation_admission();
            response
        }
        "photolab.project.open" => {
            let (job_drain, side_drain) = drain_project_work(jobs, &projects).await;
            if !job_drain.completed() || !side_drain.completed() {
                return drain_timeout_response(req.id, &job_drain, &side_drain);
            }
            let operation_projects = Arc::clone(&projects);
            let response = rpc_blocking_with_params::<OpenProjectParams, _, _>(
                req.id,
                req.params,
                move |params| operation_projects.open(&params),
            )
            .await;
            jobs.resume_admission();
            projects.resume_side_operation_admission();
            response
        }
        "photolab.project.snapshot" => rpc_blocking(req.id, move || projects.snapshot()).await,
        "photolab.project.diagnostics" => {
            rpc_blocking(req.id, move || projects.diagnostics()).await
        }
        "photolab.project.journal.start" => {
            rpc_blocking_with_params::<AppendJournalParams, _, _>(
                req.id,
                req.params,
                move |params| projects.append_journal(params),
            )
            .await
        }
        "photolab.project.journal.finish" => {
            rpc_blocking_with_params::<FinishJournalParams, _, _>(
                req.id,
                req.params,
                move |params| projects.finish_journal(params),
            )
            .await
        }
        "photolab.project.entity.rename" => {
            rpc_blocking_with_params::<RenameEntityParams, _, _>(
                req.id,
                req.params,
                move |params| projects.rename_entity(params),
            )
            .await
        }
        "photolab.project.entity.visibility" => {
            rpc_blocking_with_params::<SetEntityVisibilityParams, _, _>(
                req.id,
                req.params,
                move |params| projects.set_entity_visibility(params),
            )
            .await
        }
        "photolab.project.entity.move" => {
            rpc_blocking_with_params::<MoveEntityParams, _, _>(req.id, req.params, move |params| {
                projects.move_entity(params)
            })
            .await
        }
        "photolab.project.images.remove" => {
            rpc_blocking_with_params::<RemoveCameraImagesParams, _, _>(
                req.id,
                req.params,
                move |params| projects.remove_camera_images(params),
            )
            .await
        }
        "photolab.project.imageMask.list" => {
            rpc_blocking(req.id, move || projects.list_image_masks()).await
        }
        "photolab.project.imageMask.edit" => {
            rpc_blocking_with_params::<EditImageMaskParams, _, _>(
                req.id,
                req.params,
                move |params| projects.edit_image_mask(params),
            )
            .await
        }
        "photolab.project.imageMask.cancel" => {
            rpc_blocking_with_params::<CancelImageMaskParams, _, _>(
                req.id,
                req.params,
                move |params| Ok::<_, anyhow::Error>(projects.cancel_image_mask(params)),
            )
            .await
        }
        "photolab.project.processingSet.list" => {
            rpc_blocking(req.id, move || projects.list_processing_sets()).await
        }
        "photolab.project.processingSet.create" => {
            rpc_blocking_with_params::<CreateProcessingSetParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_processing_set(params),
            )
            .await
        }
        "photolab.project.captureGroup.list" => {
            rpc_blocking(req.id, move || projects.list_capture_groups()).await
        }
        "photolab.project.calibrationGroup.list" => {
            rpc_blocking(req.id, move || projects.list_calibration_groups()).await
        }
        "photolab.project.calibrationGroup.updateIntrinsics" => {
            rpc_blocking_with_params::<UpdateCalibrationGroupIntrinsicsParams, _, _>(
                req.id,
                req.params,
                move |params| projects.update_calibration_group_intrinsics(params),
            )
            .await
        }
        "photolab.project.calibrationGroup.setInitialCalibration" => {
            rpc_blocking_with_params::<UpdateCalibrationGroupInitialCalibrationParams, _, _>(
                req.id,
                req.params,
                move |params| projects.update_calibration_group_initial_calibration(params),
            )
            .await
        }
        "photolab.project.captureGroup.create" => {
            rpc_blocking_with_params::<CreateCaptureGroupParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_capture_group(params),
            )
            .await
        }
        "photolab.project.captureGroup.confirm" => {
            rpc_blocking_with_params::<ConfirmCaptureGroupParams, _, _>(
                req.id,
                req.params,
                move |params| projects.confirm_capture_group(params),
            )
            .await
        }
        "photolab.project.captureGroup.duplicateAsDraft" => {
            rpc_blocking_with_params::<DuplicateCaptureGroupDraftParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_capture_group_draft_from(params),
            )
            .await
        }
        "photolab.project.captureGroup.mergeProposals" => {
            rpc_blocking_with_params::<MergeCaptureGroupProposalsParams, _, _>(
                req.id,
                req.params,
                move |params| projects.merge_capture_group_proposals(params),
            )
            .await
        }
        "photolab.project.alignmentMerge.list" => {
            rpc_blocking(req.id, move || projects.list_alignment_merges()).await
        }
        "photolab.project.alignmentMerge.candidates" => {
            rpc_blocking(req.id, move || projects.list_alignment_merge_candidates()).await
        }
        "photolab.project.alignmentMerge.create" => {
            rpc_blocking_with_params::<CreateAlignmentMergeParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_alignment_merge(params),
            )
            .await
        }
        "photolab.project.autosave" => rpc_blocking(req.id, move || projects.autosave()).await,
        "photolab.project.save" => {
            let params = if req.params.is_null() {
                serde_json::json!({})
            } else {
                req.params
            };
            rpc_blocking_with_params::<SavePhotolabProjectParams, _, _>(
                req.id,
                params,
                move |params| {
                    projects.save_with_archive_operation(
                        params.archive_operation_id.as_deref(),
                        params.progress_key.as_deref(),
                    )
                },
            )
            .await
        }
        "photolab.project.saveAs" => {
            rpc_blocking_with_params::<SaveProjectAsParams, _, _>(
                req.id,
                req.params,
                move |params| projects.save_as(&params),
            )
            .await
        }
        "photolab.project.archive.cancel" => {
            rpc_blocking_with_params::<CancelArchiveParams, _, _>(
                req.id,
                req.params,
                move |params| projects.cancel_archive(params),
            )
            .await
        }
        "photolab.project.images.commit" => {
            rpc_blocking_with_params::<CommitImagesParams, _, _>(
                req.id,
                req.params,
                move |params| projects.commit_images(params),
            )
            .await
        }
        "photolab.project.images.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok::<_, anyhow::Error>(projects.cancel_image_commit(params)),
            )
            .await
        }
        "photolab.project.close" => {
            let (job_drain, side_drain) = drain_project_work(jobs, &projects).await;
            if !job_drain.completed() || !side_drain.completed() {
                return drain_timeout_response(req.id, &job_drain, &side_drain);
            }
            let operation_projects = Arc::clone(&projects);
            let response = rpc_blocking(req.id, move || {
                operation_projects.close_after_drain(&job_drain, &side_drain)
            })
            .await;
            jobs.resume_admission();
            projects.resume_side_operation_admission();
            response
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.project.alignmentMerge.candidates",
    "photolab.project.alignmentMerge.create",
    "photolab.project.alignmentMerge.list",
    "photolab.project.archive.cancel",
    "photolab.project.autosave",
    "photolab.project.calibrationGroup.list",
    "photolab.project.calibrationGroup.setInitialCalibration",
    "photolab.project.calibrationGroup.updateIntrinsics",
    "photolab.project.captureGroup.confirm",
    "photolab.project.captureGroup.create",
    "photolab.project.captureGroup.duplicateAsDraft",
    "photolab.project.captureGroup.list",
    "photolab.project.captureGroup.mergeProposals",
    "photolab.project.close",
    "photolab.project.create",
    "photolab.project.diagnostics",
    "photolab.project.entity.move",
    "photolab.project.entity.rename",
    "photolab.project.entity.visibility",
    "photolab.project.imageMask.cancel",
    "photolab.project.imageMask.edit",
    "photolab.project.imageMask.list",
    "photolab.project.images.cancel",
    "photolab.project.images.commit",
    "photolab.project.images.remove",
    "photolab.project.journal.finish",
    "photolab.project.journal.start",
    "photolab.project.open",
    "photolab.project.processingSet.create",
    "photolab.project.processingSet.list",
    "photolab.project.save",
    "photolab.project.saveAs",
    "photolab.project.snapshot",
];

#[derive(Clone)]
struct PhotolabProjectContext {
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
}

pub(super) struct PhotolabProjectModule(PhotolabProjectContext);

impl PhotolabProjectModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>, jobs: Arc<JobManager>) -> Self {
        Self(PhotolabProjectContext { projects, jobs })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabProjectModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(async move {
                    handle_project_rpc(request, context.projects, &context.jobs).await
                })
            })?;
        }
        Ok(())
    }
}
