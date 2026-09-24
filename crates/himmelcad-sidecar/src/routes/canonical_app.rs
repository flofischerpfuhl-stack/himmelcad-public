use super::io::handle_io_formats_page;
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenCanonicalProjectParams {
    project_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppNegotiationParams {
    client_name: String,
    supported_versions: Vec<u32>,
    required_capabilities: Vec<String>,
    optional_capabilities: Vec<String>,
}

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
    let queue_flush = req.method == "app.protocol"
        && serde_json::from_value::<AppProtocolRequestEnvelope>(req.params.clone()).is_ok_and(
            |envelope| {
                matches!(
                    envelope.request,
                    AppProtocolRequest::ExecuteCanonicalTransaction(_)
                )
            },
        );
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
        "canonical.residency.bootstrap" => rpc_result(
            req.id,
            runtime.residency_bootstrap().map_err(anyhow::Error::from),
        ),
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

fn encode_rpc_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(TABLE[usize::from(a >> 2)]));
        output.push(char::from(TABLE[usize::from(((a & 0x03) << 4) | (b >> 4))]));
        output.push(if chunk.len() > 1 {
            char::from(TABLE[usize::from(((b & 0x0f) << 2) | (c >> 6))])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(TABLE[usize::from(c & 0x3f)])
        } else {
            '='
        });
    }
    output
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc_request(method: &str, params: serde_json::Value) -> RpcRequest {
        RpcRequest {
            jsonrpc: "2.0".to_owned(),
            id: serde_json::json!(1),
            method: method.to_owned(),
            params,
        }
    }

    #[test]
    fn app_negotiation_advertises_only_implemented_capabilities() {
        let response = handle_app_negotiation(rpc_request(
            "app.negotiate",
            serde_json::json!({
                "clientName": "builder-test",
                "supportedVersions": [1],
                "requiredCapabilities": ["document.read", "document.write"],
                "optionalCapabilities": ["view.read"]
            }),
        ));
        assert!(response.error.is_none());
        let result = response.result.expect("negotiation result");
        assert_eq!(result["selectedVersion"], 1);
        assert_eq!(
            result["capabilities"],
            serde_json::json!([
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
                "automation.bulk.release"
            ])
        );
    }
}

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
