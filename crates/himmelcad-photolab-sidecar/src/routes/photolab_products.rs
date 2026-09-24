use super::*;

pub(super) async fn handle_product_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.products.list" => {
            rpc_blocking(req.id, move || projects.list_product_datasets()).await
        }
        "photolab.products.resolveInputs" => {
            rpc_blocking_product_with_params::<ResolveProductInputsParams, _, _>(
                req.id,
                req.params,
                move |params| resolve_product_inputs_response(&projects, params),
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

pub(super) const METHODS: &[&str] = &["photolab.products.list", "photolab.products.resolveInputs"];

pub(super) struct PhotolabProductsModule {
    projects: Arc<ProjectRuntime>,
}

impl PhotolabProductsModule {
    pub(super) fn new(projects: Arc<ProjectRuntime>) -> Self {
        Self { projects }
    }
}

impl RpcModule<(), RpcRequest, RpcResponse> for PhotolabProductsModule {
    fn register(
        &self,
        registry: &mut SidecarCommandRegistry,
    ) -> Result<(), himmelcad_command::DuplicateMethod> {
        for &method in METHODS {
            let projects = Arc::clone(&self.projects);
            registry.register(method, move |request, ()| {
                Box::pin(handle_product_rpc(request, Arc::clone(&projects)))
            })?;
        }
        Ok(())
    }
}
