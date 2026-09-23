//! Reusable sidecar runtime components.

#![forbid(unsafe_code)]

#[cfg(test)]
pub(crate) static CANCELLATION_TIMING_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub mod alignment_merge_runtime;
pub mod automation_runtime;
pub mod brush_runtime;
pub mod camera_export;
pub mod canonical_app_runtime;
pub mod canonical_project_store;
pub mod capture_runtime;
pub mod colmap_feature_db;
pub mod colmap_runtime;
pub use himmelcad_transform::crs_runtime;
pub use himmelcad_transform::crs_service;
pub mod dedode_colmap_bridge;
pub mod dedode_runtime;
pub mod dense_raster_prep;
pub use himmelcad_document::durable_fs;
pub mod gcp_local_estimate_runtime;
pub mod gcp_optimization_runtime;
pub mod gcp_runtime;
pub use himmelcad_transform::grid_codecs;
pub mod ground_classification;
pub mod hardware_runtime;
pub mod image_commit;
pub mod image_mask_runtime;
pub mod image_quality_runtime;
pub mod import_registration_runtime;
pub mod job_runtime;
pub mod mesh_surface_runtime;
pub mod mesh_tiler;
pub mod mvs_runtime;
pub mod mvs_scene;
pub use himmelcad_domain_raster::orthophoto_prep;
pub mod pointcloud_export;
pub mod pointcloud_ground;
pub mod pointcloud_sampling;
pub mod pointcloud_segment;
pub mod prepared_triangle_mesh;
pub use himmelcad_command::process_group;
pub use himmelcad_prepared::prepared_triangle_mesh_ply;
pub mod product_export;
pub mod project_archive;
pub use himmelcad_document::publish_fs;
pub mod raster_runtime;
pub use himmelcad_transform::site_calibration_reader;
pub mod splat_tiler;
pub use himmelcad_command::worker_toolchain;
pub use himmelcad_prepared::viewer_raster_manifest;
pub use himmelcad_prepared::viewer_raster_surface_manifest;
pub use himmelcad_transform::transform_geometry_runtime;
pub use himmelcad_transform::transform_runtime;
