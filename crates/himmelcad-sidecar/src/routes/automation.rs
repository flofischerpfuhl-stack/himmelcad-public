use super::*;

pub(super) fn handle_automation_rpc(
    req: RpcRequest,
    automation: Arc<AutomationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    let id = req.id;
    let result = match req.method.as_str() {
        "automation.entities.page" => serde_json::from_value::<EntityPageRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                let app = canonical_app
                    .lock()
                    .map_err(|_| "internal: canonical application runtime poisoned".to_owned())?;
                automation
                    .entities_page(params, &*app)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.cas.describe" => serde_json::from_value::<CasDescribeRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                let app = canonical_app
                    .lock()
                    .map_err(|_| "internal: canonical application runtime poisoned".to_owned())?;
                automation
                    .describe_cas(params, &*app)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.commands.validate" => {
            serde_json::from_value::<CommandValidateRequest>(req.params)
                .map_err(|error| format!("invalidRequest: {error}"))
                .and_then(|params| {
                    let app = canonical_app.lock().map_err(|_| {
                        "internal: canonical application runtime poisoned".to_owned()
                    })?;
                    automation
                        .validate_command(params, &*app)
                        .map_err(|error| error.to_string())
                })
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        "automation.commands.status" => serde_json::from_value::<CommandStatusRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .command_status(&params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.commands.cancel" => serde_json::from_value::<CommandStatusRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .cancel_command(&params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.bulk.read" => serde_json::from_value::<BulkReadRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .bulk_read(params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.bulk.release" => serde_json::from_value::<BulkReleaseRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .bulk_release(params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        _ => Err("automation method not found".to_owned()),
    };
    match result {
        Ok(value) => RpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(value),
            error: None,
        },
        Err(message) => rpc_automation_err(id, &message),
    }
}

pub(super) const METHODS: &[&str] = &[
    "automation.bulk.read",
    "automation.bulk.release",
    "automation.cas.describe",
    "automation.commands.cancel",
    "automation.commands.status",
    "automation.commands.validate",
    "automation.entities.page",
];

#[derive(Clone)]
struct AutomationContext {
    automation: Arc<AutomationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
}

pub(super) struct AutomationModule(AutomationContext);

impl AutomationModule {
    pub(super) fn new(
        automation: Arc<AutomationRuntime>,
        canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
    ) -> Self {
        Self(AutomationContext {
            automation,
            canonical_app,
        })
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for AutomationModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let context = self.0.clone();
            registry.register(method, move |request, ()| {
                let context = context.clone();
                Box::pin(async move {
                    handle_automation_rpc(request, context.automation, context.canonical_app)
                })
            })?;
        }
        Ok(())
    }
}
