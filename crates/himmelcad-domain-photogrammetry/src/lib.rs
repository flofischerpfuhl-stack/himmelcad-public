//! PhotoLab photogrammetry contracts, project storage, and worker runtimes.

#![forbid(unsafe_code)]
#![recursion_limit = "256"]

pub mod splat_tiler {
    use himmelcad_prepared::splat_tiler::{PreparedSplatProduct, SplatTilerError};

    use std::path::Path;

    use crate::photolab_gcp_optimization::GcpSimilarityTransform;
    use himmelcad_process::jobs::CancellationToken;

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
}

#[cfg(test)]
pub(crate) static CANCELLATION_TIMING_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub mod alignment_merge_runtime;
pub mod brush_runtime;
pub mod camera_export;
pub mod capture_contract;
pub mod capture_runtime;
pub mod colmap_feature_db;
pub mod colmap_runtime;
pub mod contract;
pub mod dedode_colmap_bridge;
pub mod dedode_runtime;
pub mod gcp_import;
pub mod gcp_local_estimate_runtime;
pub mod gcp_optimization_runtime;
pub mod gcp_runtime;
pub mod hcap_import;
pub mod image_commit;
pub mod image_mask_runtime;
pub mod image_quality_runtime;
pub mod job_runtime;
pub mod job_supervisor;
pub mod mvs_runtime;
pub mod mvs_scene;
pub mod photolab;
pub mod photolab_batch;
pub mod photolab_capture;
pub mod photolab_gcp;
pub mod photolab_gcp_local_estimate;
pub mod photolab_gcp_optimization;
pub mod photolab_image_import;
pub mod photolab_images;
pub mod photolab_jobs;
pub mod photolab_masks;
pub mod photolab_matching;
pub mod photolab_models;
pub mod photolab_products;
pub mod photolab_project;
pub mod photolab_recipe;
pub mod product_export;
pub mod project_archive;
pub mod project_runtime;

pub use gcp_import::{
    import_gcp_csv_file, import_gcp_csv_file_with_cancel, preview_gcp_csv_file, GcpCsvImportResult,
    GcpCsvPreview, GcpCsvPreviewRow, GcpCsvRowError, GcpCsvUncertaintyOrigin,
};
pub use photolab_image_import::{
    discover_photo_files, import_photo_files, import_photo_files_with_capabilities_and_progress,
    import_photo_files_with_progress, PhotoDiscovery, PhotoImportCandidate,
};
