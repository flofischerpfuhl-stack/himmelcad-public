use super::io::handle_io_formats_page;
use super::*;

pub(super) fn handle_app_negotiation(req: RpcRequest) -> RpcResponse {
    let params = match serde_json::from_value::<AppNegotiationParams>(req.params) {
        Ok(params) => params,
        Err(error) => return rpc_err(req.id, -32602, &format!("invalid params: {error}")),
    };
    const CAPABILITIES: &[&str] = &[
        "document.read",
        "document.write",
        "journal.read",
        "io.formats.read",
        "io.probe",
        "io.import.execute",
        "io.export",
        "io.operation",
        "registration.import",
        "residency.read",
        "automation.entities.page",
        "automation.cas.describe",
        "automation.commands.validate",
        "automation.commands.status",
        "automation.commands.cancel",
        "automation.bulk.read",
        "automation.bulk.release",
    ];
    let invalid = params.client_name.trim().is_empty()
        || params.supported_versions.is_empty()
        || params.supported_versions.contains(&0)
        || params
            .required_capabilities
            .iter()
            .chain(params.optional_capabilities.iter())
            .any(|capability| capability.trim().is_empty());
    let required_unique = params
        .required_capabilities
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        == params.required_capabilities.len();
    let optional_unique = params
        .optional_capabilities
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        == params.optional_capabilities.len();
    if invalid || !required_unique || !optional_unique {
        return rpc_err(req.id, -32602, "negotiation request is invalid");
    }
    let missing = params
        .required_capabilities
        .iter()
        .filter(|required| !CAPABILITIES.contains(&required.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !params.supported_versions.contains(&1) || !missing.is_empty() {
        return rpc_err(
            req.id,
            -32602,
            &format!(
                "the sidecar cannot satisfy the required app protocol; missing capabilities: {}",
                missing.join(", ")
            ),
        );
    }
    rpc_result(
        req.id,
        Ok::<_, anyhow::Error>(serde_json::json!({
            "selectedVersion": 1,
            "serverName": "himmelcad-sidecar",
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "sessionId": format!("sidecar-{}", std::process::id()),
            "capabilities": CAPABILITIES,
        })),
    )
}

pub(super) async fn handle_canonical_app_rpc(
    req: RpcRequest,
    runtime: Arc<Mutex<CanonicalAppRuntime>>,
    automation: Arc<AutomationRuntime>,
) -> RpcResponse {
    let queue_flush = req.method == "snapshot.create"
        || req.method == "snapshot.restore"
        || req.method == "project.undo"
        || req.method == "project.redo"
        || req.method == "pointcloud.display.set"
        || req.method == "view.bookmark.create"
        || req.method == "view.bookmark.restore"
        || req.method == "canonical.viewing_box.put"
        || req.method == "canonical.viewing_box.delete"
        || req.method == "measurement.create"
        || req.method == "measurement.remove"
        || req.method == "draw.curve.put"
        || req.method == "draw.curve.undo"
        || req.method == "draw.curve.redo"
        || (req.method == "app.protocol"
            && serde_json::from_value::<AppProtocolRequestEnvelope>(req.params.clone()).is_ok_and(
                |envelope| {
                    matches!(
                        envelope.request,
                        AppProtocolRequest::ExecuteCanonicalTransaction(_)
                    )
                },
            ));
    if req.method == "app.negotiate" {
        return handle_app_negotiation(req);
    }
    if req.method == "io.formats.page" {
        return handle_io_formats_page(req);
    }
    let runtime_owner = Arc::clone(&runtime);
    let mut runtime = runtime
        .lock()
        .expect("canonical app runtime mutex poisoned");
    let response = match req.method.as_str() {
        "canonical.project.open" => {
            match serde_json::from_value::<OpenCanonicalProjectParams>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .open(params.project_root)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "canonical.project.close" => {
            let closed = runtime.close();
            automation.revoke_all();
            rpc_result(
                req.id,
                Ok::<_, anyhow::Error>(serde_json::json!({ "closed": closed })),
            )
        }
        "canonical.project.durability" => rpc_result(
            req.id,
            runtime.durability_status().map_err(anyhow::Error::from),
        ),
        "canonical.residency.resource.read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                object_hash: ObjectHash,
                offset: u64,
                byte_length: u64,
            }
            match serde_json::from_value::<Params>(req.params) {
                Ok(params) => {
                    let result = runtime
                        .read_residency_resource_range(
                            &params.object_hash,
                            params.offset,
                            params.byte_length,
                        )
                        .map(|(metadata, bytes)| {
                            serde_json::json!({
                                "schemaVersion": 1,
                                "objectHash": metadata.object_hash,
                                "mediaType": metadata.media_type,
                                "offset": params.offset,
                                "byteLength": params.byte_length,
                                "totalByteLength": metadata.byte_length,
                                "bytesBase64": encode_rpc_base64(&bytes),
                            })
                        })
                        .map_err(anyhow::Error::from);
                    rpc_result(req.id, result)
                }
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
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
                input: himmelcad_sidecar::canonical_app_runtime::DrawCurveInput,
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
        "canonical.residency.bootstrap" => rpc_result(
            req.id,
            runtime.residency_bootstrap().map_err(anyhow::Error::from),
        ),
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
        "app.protocol" => match serde_json::from_value::<AppProtocolRequestEnvelope>(req.params) {
            Ok(envelope) => {
                if let AppProtocolRequest::ExecuteCanonicalTransaction(transaction) =
                    &envelope.request
                {
                    if let Some(extension) =
                        envelope.extensions.get("hcad.automation.confirmation@1")
                    {
                        let grant = extension
                            .as_object()
                            .filter(|object| object.len() == 1)
                            .and_then(|object| object.get("grant"))
                            .and_then(serde_json::Value::as_str);
                        let generation = runtime
                            .automation_entities()
                            .map(|(generation, _)| generation);
                        let authorization = match (grant, generation) {
                            (Some(grant), Ok(generation)) => automation
                                .authorize_confirmation_grant(transaction, grant, generation)
                                .map_err(|error| error.to_string()),
                            (None, _) => {
                                Err("confirmationRequired: approval extension is malformed"
                                    .to_owned())
                            }
                            (_, Err(error)) => Err(error.to_string()),
                        };
                        if let Err(message) = authorization {
                            let response = AppProtocolResponseEnvelope {
                                schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
                                request_id: envelope.request_id,
                                response: AppProtocolResponse::Error(AppProtocolError {
                                    code: "confirmationRequired".to_owned(),
                                    message,
                                    details: BTreeMap::new(),
                                }),
                                extensions: envelope.extensions,
                            };
                            return rpc_result(
                                req.id,
                                serde_json::to_value(response).map_err(anyhow::Error::from),
                            );
                        }
                    }
                }
                let response = rpc_result(
                    req.id,
                    serde_json::to_value(runtime.dispatch(envelope)).map_err(anyhow::Error::from),
                );
                response
            }
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        _ => rpc_err(req.id, -32601, "canonical application method not found"),
    };
    drop(runtime);
    if queue_flush {
        schedule_canonical_group_flush(runtime_owner);
    }
    response
}

pub(super) const SHARED_METHODS: &[&str] = &[
    "app.negotiate",
    "app.protocol",
    "canonical.project.close",
    "canonical.project.durability",
    "canonical.project.open",
    "canonical.residency.bootstrap",
    "canonical.residency.resource.read",
];

pub(super) const BUILDER_METHODS: &[&str] = &[
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

#[derive(Clone)]
struct CanonicalAppContext {
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    automation: Arc<AutomationRuntime>,
}

pub(super) struct CanonicalAppModule {
    context: CanonicalAppContext,
    methods: &'static [&'static str],
}

impl CanonicalAppModule {
    pub(super) fn shared(
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
        automation: Arc<AutomationRuntime>,
    ) -> Self {
        Self::new(canonical_app, automation, SHARED_METHODS)
    }

    pub(super) fn builder(
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
        automation: Arc<AutomationRuntime>,
    ) -> Self {
        Self::new(canonical_app, automation, BUILDER_METHODS)
    }

    fn new(
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
        automation: Arc<AutomationRuntime>,
        methods: &'static [&'static str],
    ) -> Self {
        Self {
            context: CanonicalAppContext {
                canonical_app,
                automation,
            },
            methods,
        }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for CanonicalAppModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in self.methods {
            let context = self.context.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(handle_canonical_app_rpc(
                    request,
                    context.canonical_app,
                    context.automation,
                ))
            })?;
        }
        Ok(())
    }
}
