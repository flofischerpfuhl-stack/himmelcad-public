//! CRS declarations, boundary transform contracts, and pure geometry helpers.

#![forbid(unsafe_code)]

pub mod crs;
pub mod grid_codecs;
pub mod site_calibration_reader;
pub mod transform;
pub mod transform_geometry;

pub use himmelcad_model::hash;
