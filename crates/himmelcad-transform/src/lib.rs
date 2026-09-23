//! CRS declarations, boundary transform contracts, and pure geometry helpers.

#![forbid(unsafe_code)]

pub mod crs;
pub mod crs_runtime;
pub mod crs_service;
pub mod grid_codecs;
pub mod photolab_crs;
pub mod site_calibration_reader;
pub mod transform;
pub mod transform_geometry;
pub mod transform_geometry_runtime;
pub mod transform_runtime;

pub use himmelcad_model::hash;
