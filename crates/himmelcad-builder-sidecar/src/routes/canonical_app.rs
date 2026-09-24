use super::*;
use crate::drafting_runtime::BuilderDraftingCommands;
use himmelcad_core::release_05_admissions::SnapshotOriginV1;
use himmelcad_model::canonical_resources::PointCloudDisplayStyle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetPointCloudDisplayParams {
    command_id: String,
    entities: Vec<EntityVersionRef>,
    display: PointCloudDisplayStyle,
}

pub(super) async fn handle_canonical_app_rpc(
    req: RpcRequest,
    runtime: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    let queue_flush = true;
    let runtime_owner = Arc::clone(&runtime);
    let mut runtime = runtime
        .lock()
        .expect("canonical app runtime mutex poisoned");
    let response = match req.method.as_str() {
        "product.import.provenance" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                entity_ids: Vec<String>,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) if (1..=200).contains(&params.entity_ids.len()) => rpc_result(
                    req.id,
                    runtime
                        .photolab_product_provenance(&params.entity_ids)
                        .map_err(anyhow::Error::from),
                ),
                Ok(_) => rpc_err(req.id, -32602, "entityIds must contain 1 through 200 ids"),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "project.flush" => {
            let result = runtime
                .flush()
                .and_then(|_| runtime.create_snapshot("Save", SnapshotOriginV1::Ui))
                .and_then(|_| runtime.flush())
                .map_err(anyhow::Error::from);
            rpc_result(req.id, result)
        }
        "project.undo" | "project.redo" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    if req.method == "project.undo" {
                        runtime.undo_document(params.command_id)
                    } else {
                        runtime.redo_document(params.command_id)
                    }
                    .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "snapshot.create" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                name: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .create_snapshot(&params.name, SnapshotOriginV1::Ui)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "snapshot.list" => rpc_result(
            req.id,
            runtime.list_snapshots().map_err(anyhow::Error::from),
        ),
        "snapshot.restore" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                entity_id: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .restore_snapshot(&params.entity_id)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "view.bookmark.create" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                entity_id: String,
                name: String,
                state: serde_json::Value,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .create_view_bookmark(
                            params.command_id,
                            params.entity_id,
                            params.name,
                            params.state,
                        )
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "view.bookmark.list" => rpc_result(
            req.id,
            runtime.list_view_bookmarks().map_err(anyhow::Error::from),
        ),
        "view.bookmark.restore" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                entity_id: String,
                expected_revision: u64,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .restore_view_bookmark(
                            params.command_id,
                            params.entity_id,
                            params.expected_revision,
                        )
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "canonical.viewing_box.put" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                entity_id: String,
                name: String,
                expected_revision: Option<u64>,
                state: serde_json::Value,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .put_viewing_box(
                            params.command_id,
                            params.entity_id,
                            params.name,
                            params.expected_revision,
                            params.state,
                        )
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "canonical.viewing_box.list" => rpc_result(
            req.id,
            runtime.list_viewing_boxes().map_err(anyhow::Error::from),
        ),
        "canonical.viewing_box.delete" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                entity_id: String,
                expected_revision: u64,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .delete_viewing_box(
                            params.command_id,
                            params.entity_id,
                            params.expected_revision,
                        )
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "measurement.create" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                entity_id: String,
                name: String,
                measurement: himmelcad_core::release_05_admissions::MeasurementV1,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .create_measurement(
                            params.command_id,
                            params.entity_id,
                            params.name,
                            params.measurement,
                        )
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "measurement.list" => rpc_result(
            req.id,
            runtime.list_measurements().map_err(anyhow::Error::from),
        ),
        "measurement.get" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                entity_id: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .get_measurement(&params.entity_id)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "measurement.remove" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                entity_id: String,
                expected_revision: u64,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .delete_measurement(
                            params.command_id,
                            params.entity_id,
                            params.expected_revision,
                        )
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "draw.curve.put" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                input: himmelcad_domain_drafting::DrawCurveInput,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .put_draw_curve(params.command_id, params.input)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "draw.curve.list" => rpc_result(
            req.id,
            runtime.list_draw_curves().map_err(anyhow::Error::from),
        ),
        "draw.curve.undo" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                target_command_id: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .undo_draw_curve(params.command_id, params.target_command_id)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "draw.curve.redo" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                command_id: String,
                target_command_id: String,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .redo_draw_curve(params.command_id, params.target_command_id)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "pointcloud.display.set" => {
            match serde_json::from_value::<SetPointCloudDisplayParams>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .set_point_cloud_display(params.command_id, params.entities, params.display)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        _ => rpc_err(req.id, -32601, "canonical application method not found"),
    };
    drop(runtime);
    if queue_flush {
        schedule_canonical_group_flush(runtime_owner);
    }
    response
}

fn schedule_canonical_group_flush(runtime: Arc<Mutex<CanonicalAppRuntime>>) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(
            std::env::var("HCAD_JOURNAL_FLUSH_INTERVAL_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(50),
        ))
        .await;
        let result = runtime
            .lock()
            .expect("canonical app runtime mutex poisoned")
            .flush();
        if let Err(error) = result {
            tracing::error!(%error, "Builder canonical journal group flush failed");
        }
    });
}

pub(super) const METHODS: &[&str] = &[
    "canonical.viewing_box.delete",
    "canonical.viewing_box.list",
    "canonical.viewing_box.put",
    "draw.curve.list",
    "draw.curve.put",
    "draw.curve.redo",
    "draw.curve.undo",
    "measurement.create",
    "measurement.get",
    "measurement.list",
    "measurement.remove",
    "pointcloud.display.set",
    "product.import.provenance",
    "project.flush",
    "project.redo",
    "project.undo",
    "snapshot.create",
    "snapshot.list",
    "snapshot.restore",
    "view.bookmark.create",
    "view.bookmark.list",
    "view.bookmark.restore",
];

#[cfg(test)]
fn routes_to_canonical_app(method: &str) -> bool {
    METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_history_methods_route_to_the_canonical_runtime() {
        assert!(routes_to_canonical_app("project.undo"));
        assert!(routes_to_canonical_app("project.redo"));
        assert!(routes_to_canonical_app("project.flush"));
        assert!(!routes_to_canonical_app("project.unknown"));
    }
}

#[derive(Clone)]
struct CanonicalAppContext {
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct CanonicalAppModule {
    context: CanonicalAppContext,
}

impl CanonicalAppModule {
    pub(super) fn new(canonical_app: Arc<Mutex<CanonicalAppRuntime>>) -> Self {
        Self {
            context: CanonicalAppContext { canonical_app },
        }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for CanonicalAppModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.context.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_canonical_app_rpc(request, context.canonical_app))
            })?;
        }
        Ok(())
    }
}
