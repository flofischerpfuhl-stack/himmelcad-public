//! Raster geometry and immutable prepared-pyramid summary contracts.

use std::collections::BTreeMap;

use himmelcad_model::canonical_resources::CanonicalResourceRef;
use himmelcad_model::document_model::EntityVersionRef;
use himmelcad_model::hash::ObjectHash;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterCrs {
    pub horizontal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical: Option<String>,
    pub gdal_srs: String,
    pub canonical_wkt_sha256: ObjectHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterBounds {
    pub minimum_east: f64,
    pub minimum_north: f64,
    pub maximum_east: f64,
    pub maximum_north: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterGrid {
    pub bounds: RasterBounds,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub gsd: f64,
    pub no_data: RasterNoDataValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum RasterNoDataValue {
    Numeric(f64),
    Nan,
    AlphaMask,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrthophotoSource {
    pub source_id: String,
    pub warp_vrt_path: String,
    pub bounds: RasterBounds,
    pub crs: RasterCrs,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrthomosaicElevationSupport {
    pub dataset_root: String,
    pub summary: RasterBuildSummary,
    pub source_surface: EntityVersionRef,
    pub derivation: CanonicalResourceRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterLevelSummary {
    pub level: u16,
    pub columns: u32,
    pub rows: u32,
    pub tile_count: u64,
    pub bounds: RasterBounds,
    pub gsd: f64,
    pub relative_directory: String,
    pub metric_tile_url_template: String,
    pub view_layers: Vec<RasterViewLayer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterViewLayer {
    pub name: String,
    pub format: RasterViewTileFormat,
    pub url_template: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum RasterViewTileFormat {
    RgbaPng,
    GrayscalePng {
        #[serde(alias = "minimum_elevation")]
        minimum_elevation: f64,
        #[serde(alias = "maximum_elevation")]
        maximum_elevation: f64,
    },
    Float32Raw {
        #[serde(alias = "byte_order")]
        byte_order: RasterByteOrder,
        width: u16,
        height: u16,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterByteOrder {
    LittleEndian,
    BigEndian,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GdalAudit {
    pub version: String,
    pub executable_sha256: BTreeMap<String, ObjectHash>,
    pub raster_drivers: Vec<String>,
    pub vector_drivers: Vec<String>,
    pub network_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterBuildSummary {
    pub output_directory: String,
    pub cog_path: String,
    pub pyramid_manifest_path: String,
    pub levels: Vec<RasterLevelSummary>,
    pub crs: RasterCrs,
    pub grid: RasterGrid,
    pub audit: GdalAudit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterValidityResource {
    /// Path relative to the raster dataset root.
    pub path: String,
    pub sha256: ObjectHash,
    pub byte_length: u64,
}
