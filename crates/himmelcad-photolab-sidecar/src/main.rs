#![forbid(unsafe_code)]

mod dense_raster_prep;
mod mesh_tiler;
pub use himmelcad_photolab_sidecar::prepared_triangle_mesh;
mod product_export;
mod raster_runtime;
mod routes;
mod splat_tiler;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    routes::run().await
}
