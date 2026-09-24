//! Compatibility adapter from PhotoLab's similarity DTO to prepared splat production.

use std::path::Path;

use himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpSimilarityTransform;
use himmelcad_process::jobs::CancellationToken;

pub use himmelcad_prepared::splat_tiler::{PreparedSplatProduct, SplatTilerError};

pub fn tile_brush_ply(
    source: &Path,
    output_root: &Path,
    project_transform: Option<GcpSimilarityTransform>,
    cancellation: &CancellationToken,
) -> Result<PreparedSplatProduct, SplatTilerError> {
    himmelcad_prepared::splat_tiler::tile_brush_ply(
        source,
        output_root,
        project_transform.map(|transform| {
            himmelcad_prepared::splat_tiler::PreparedSimilarityTransform {
                scale: transform.scale,
                rotation: transform.rotation,
                translation_meters: transform.translation_meters,
            }
        }),
        cancellation,
    )
}
