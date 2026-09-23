//! Renderer-neutral prepared multi-view scene manifest contracts.

use std::path::PathBuf;

use himmelcad_model::hash::ObjectHash;
use serde::{Deserialize, Serialize};

/// Intrinsics for an already-undistorted perspective image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsPinholeCamera {
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
    /// Row-major 3x4 world-to-camera transform.
    pub world_to_camera: [f64; 12],
}

/// One source image and its view graph neighborhood.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsSceneImage {
    pub image_id: String,
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_relative_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_sha256: Option<ObjectHash>,
    pub width: u32,
    pub height: u32,
    pub camera: MvsPinholeCamera,
    pub minimum_depth: f64,
    pub maximum_depth: f64,
    pub neighbor_image_ids: Vec<String>,
}

/// Neutral scene format produced from any successful SfM backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsSceneManifest {
    pub schema_version: u32,
    pub coordinate_frame_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
    pub images: Vec<MvsSceneImage>,
}
