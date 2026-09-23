//! Prepared dense point artifacts shared by raster and photogrammetry producers.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDenseVector {
    pub flatgeobuf_path: PathBuf,
    pub layer: String,
    pub point_count: u64,
    pub minimum: [f64; 3],
    pub maximum: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPotreeCloud {
    pub relative_metadata_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_relative_path: Option<PathBuf>,
    pub point_count: u64,
    pub render_offset: [f64; 3],
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}
