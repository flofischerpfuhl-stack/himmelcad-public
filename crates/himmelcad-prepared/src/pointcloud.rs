//! Neutral point-cloud scope contracts shared by preparation domains.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use himmelcad_model::hash::ObjectHash;

pub const HEIGHT_GRID_FORMAT_ID: &str = "hcad.pointcloud.height-grid@1";
pub const HEIGHT_GRID_MEDIA_TYPE: &str = HEIGHT_GRID_FORMAT_ID;
pub const HEIGHT_GRID_MAGIC: &[u8; 8] = b"HCGRID01";
pub const HEIGHT_GRID_HEADER_BYTES: usize = 42;
pub const HEIGHT_GRID_RECORD_BYTES: usize = 25;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundViewingBox {
    pub center: [f64; 3],
    pub half_extents: [f64; 3],
    /// Unit quaternion in x/y/z/w order.
    pub rotation: [f64; 4],
    pub keep_inside: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundScope {
    /// Exact canonical source placement, column-major.
    pub placement: [f64; 16],
    pub viewing_box: Option<GroundViewingBox>,
    pub visible_classes: BTreeSet<u8>,
}

impl Default for GroundScope {
    fn default() -> Self {
        Self {
            placement: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            viewing_box: None,
            visible_classes: (0_u8..=u8::MAX).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedGroundArtifact {
    pub relative_path: String,
    pub object_hash: ObjectHash,
    pub byte_length: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedGroundDataset {
    pub root: PathBuf,
    pub point_count: u64,
    pub artifacts: Vec<PreparedGroundArtifact>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SamplingMethod {
    Distance,
    Grid,
    Random,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RasterAggregation {
    Mean,
    Min,
    Max,
    Count,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EmptyCellPolicy {
    NoData,
    Fill { value: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleSummary {
    pub source_points: u64,
    pub scoped_points: u64,
    pub sampled_points: u64,
    pub method: SamplingMethod,
    pub spacing_m: Option<f64>,
    pub percentage: Option<f64>,
    pub stable_tie_rule: String,
    pub selection_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSampleResult {
    pub sampled: PreparedGroundDataset,
    pub summary: SampleSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RasterSummary {
    pub source_points: u64,
    pub scoped_points: u64,
    pub width: u32,
    pub height: u32,
    pub cell_size_m: f64,
    pub origin: [f64; 2],
    pub aggregation: RasterAggregation,
    pub empty_cell_policy: EmptyCellPolicy,
    pub empty_cells: u64,
    pub empty_ratio: f64,
    pub cell_sha256: ObjectHash,
    pub mesh_eligible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedHeightGrid {
    pub root: PathBuf,
    pub artifact: PreparedGroundArtifact,
    pub viewer_manifest: PreparedGroundArtifact,
    pub viewer_artifacts: Vec<PreparedGroundArtifact>,
    pub summary: RasterSummary,
}
