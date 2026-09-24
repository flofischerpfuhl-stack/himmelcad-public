use super::*;

pub(super) async fn handle_crs_rpc(req: RpcRequest, crs: &CrsService) -> RpcResponse {
    match req.method.as_str() {
        "photolab.crs.discover" => {
            match serde_json::from_value::<DiscoverCrsOperationsParams>(req.params) {
                Ok(params) => rpc_result(req.id, crs.discover(params).await.map_err(Into::into)),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.crs.freeze" => {
            match serde_json::from_value::<FreezeCrsOperationParams>(req.params) {
                Ok(params) => rpc_result(req.id, crs.freeze(params).await.map_err(Into::into)),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.crs.cancel" => {
            match serde_json::from_value::<CancelCrsOperationParams>(req.params) {
                Ok(params) => rpc_result(req.id, Ok::<_, anyhow::Error>(crs.cancel(params).await)),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &[
    "photolab.crs.cancel",
    "photolab.crs.discover",
    "photolab.crs.freeze",
];

pub(super) struct PhotolabCrsModule {
    crs: Arc<CrsService>,
}

impl PhotolabCrsModule {
    pub(super) fn new(crs: Arc<CrsService>) -> Self {
        Self { crs }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabCrsModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let crs = Arc::clone(&self.crs);
            registry.register(method, move |request, ()| {
                let crs = Arc::clone(&crs);
                Box::pin(async move { handle_crs_rpc(request, &crs).await })
            })?;
        }
        Ok(())
    }
}
