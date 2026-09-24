//! Neutral coordinate value contracts shared by transformation and registration domains.

use serde::{Deserialize, Serialize};

/// A single world-space point. Always `f64` — absolute projected CRS values must not go through f32.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl WorldPoint {
    #[must_use]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[must_use]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    #[must_use]
    pub fn as_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }

    #[must_use]
    pub fn from_array(value: [f64; 3]) -> Self {
        Self {
            x: value[0],
            y: value[1],
            z: value[2],
        }
    }
}

/// 3D similarity (7-parameter Helmert) in cartesian XYZ of the working frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Similarity3D {
    pub tx: f64,
    pub ty: f64,
    pub tz: f64,
    pub rx_radians: f64,
    pub ry_radians: f64,
    pub rz_radians: f64,
    pub scale: f64,
}

/// Apply a small-angle 3D similarity (standard surveying linearisation).
#[must_use]
pub fn apply_similarity_3d(model: Similarity3D, point: WorldPoint) -> WorldPoint {
    let (rx, ry, rz) = (model.rx_radians, model.ry_radians, model.rz_radians);
    let s = model.scale;
    // R ≈ [[1,-rz,ry],[rz,1,-rx],[-ry,rx,1]] for small angles; full Rodrigues for generality.
    let (cx, sx) = (rx.cos(), rx.sin());
    let (cy, sy) = (ry.cos(), ry.sin());
    let (cz, sz) = (rz.cos(), rz.sin());
    // ZYX intrinsic rotations
    let r00 = cy * cz;
    let r01 = sx * sy * cz - cx * sz;
    let r02 = cx * sy * cz + sx * sz;
    let r10 = cy * sz;
    let r11 = sx * sy * sz + cx * cz;
    let r12 = cx * sy * sz - sx * cz;
    let r20 = -sy;
    let r21 = sx * cy;
    let r22 = cx * cy;
    WorldPoint::new(
        s * (r00 * point.x + r01 * point.y + r02 * point.z) + model.tx,
        s * (r10 * point.x + r11 * point.y + r12 * point.z) + model.ty,
        s * (r20 * point.x + r21 * point.y + r22 * point.z) + model.tz,
    )
}

/// Empirical model kind requested when fitting control pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmpiricalModelKind {
    Translation2D,
    Rigid2D,
    Similarity2D,
    Affine2D,
    Translation3D,
    Rigid3D,
    Similarity3D,
}

/// Residual for one control pair after fit or after apply-check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointResidual {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub source: WorldPoint,
    pub expected_target: WorldPoint,
    pub actual_target: WorldPoint,
    pub delta: WorldPoint,
    pub horizontal_meters: f64,
    pub vertical_meters: f64,
    pub spatial_meters: f64,
}

/// Fit / apply residual summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualReport {
    pub count: u64,
    pub rms_horizontal_meters: f64,
    pub rms_vertical_meters: f64,
    pub rms_spatial_meters: f64,
    pub max_spatial_meters: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<PointResidual>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub out_of_bounds_indices: Vec<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}
