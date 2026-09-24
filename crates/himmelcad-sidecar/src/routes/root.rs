use super::*;

pub(super) const METHODS: &[&str] = &["ping"];

pub(super) struct RootModule;

impl RpcModule<(), RpcRequest, RpcResponse> for RootModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        registry.register("ping", |request, ()| {
            Box::pin(async move {
                RpcResponse {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: Some(serde_json::json!({
                        "ok": true,
                        "version": env!("CARGO_PKG_VERSION"),
                    })),
                    error: None,
                }
            })
        })
    }
}
