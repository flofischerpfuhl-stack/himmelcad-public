#![forbid(unsafe_code)]

mod drafting_runtime;
mod mesh_surface_runtime;
mod routes;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    routes::run().await
}
