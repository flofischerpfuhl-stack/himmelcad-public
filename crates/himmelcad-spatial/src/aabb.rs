//! Axis-aligned bounding box utilities.
//!
//! All bounds are stored as `[f64; 3]` for storage (so very-large-extent point
//! clouds remain precise), but ray/distance queries use `glam::Vec3` (`f32`)
//! after applying the per-tile render offset upstream.

use glam::Vec3;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            min: [f64::MAX, f64::MAX, f64::MAX],
            max: [f64::MIN, f64::MIN, f64::MIN],
        }
    }

    pub fn from_points_f32(positions: &[f32]) -> Self {
        debug_assert!(positions.len() % 3 == 0);
        if positions.is_empty() {
            return Self::default();
        }
        let mut bb = Self::empty();
        for chunk in positions.chunks_exact(3) {
            let px = f64::from(chunk[0]);
            let py = f64::from(chunk[1]);
            let pz = f64::from(chunk[2]);
            if px < bb.min[0] {
                bb.min[0] = px;
            }
            if py < bb.min[1] {
                bb.min[1] = py;
            }
            if pz < bb.min[2] {
                bb.min[2] = pz;
            }
            if px > bb.max[0] {
                bb.max[0] = px;
            }
            if py > bb.max[1] {
                bb.max[1] = py;
            }
            if pz > bb.max[2] {
                bb.max[2] = pz;
            }
        }
        bb
    }

    pub fn center(self) -> [f64; 3] {
        [
            (self.min[0] + self.max[0]) * 0.5,
            (self.min[1] + self.max[1]) * 0.5,
            (self.min[2] + self.max[2]) * 0.5,
        ]
    }

    pub fn extent(self) -> [f64; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }

    /// Smallest cube that fully contains `self`. Centered on `self.center()`.
    /// Used so octree subdivision keeps children equally sized at every level.
    #[must_use]
    pub fn bounding_cube(self) -> Self {
        let c = self.center();
        let e = self.extent();
        let half = (e[0].max(e[1]).max(e[2]) * 0.5).max(f64::EPSILON);
        Self {
            min: [c[0] - half, c[1] - half, c[2] - half],
            max: [c[0] + half, c[1] + half, c[2] + half],
        }
    }

    /// Sub-cube of the parent for a given octant index in [0, 8).
    /// Bit layout: bit 0 = +X, bit 1 = +Y, bit 2 = +Z.
    #[must_use]
    pub fn child_cube(self, octant: usize) -> Self {
        debug_assert!(octant < 8);
        let c = self.center();
        let mut min = self.min;
        let mut max = c;
        if octant & 1 != 0 {
            min[0] = c[0];
            max[0] = self.max[0];
        }
        if octant & 2 != 0 {
            min[1] = c[1];
            max[1] = self.max[1];
        }
        if octant & 4 != 0 {
            min[2] = c[2];
            max[2] = self.max[2];
        }
        Self { min, max }
    }

    /// `t_near, t_far` along the ray, or `None` if no hit.
    /// `dir_inv = 1/dir` — caller precomputes once.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "bounds are already tile-local before this f32 renderer query"
    )]
    pub fn ray_intersect(self, origin: Vec3, dir_inv: Vec3) -> Option<(f32, f32)> {
        let lo_x = (self.min[0] as f32 - origin.x) * dir_inv.x;
        let hi_x = (self.max[0] as f32 - origin.x) * dir_inv.x;
        let lo_y = (self.min[1] as f32 - origin.y) * dir_inv.y;
        let hi_y = (self.max[1] as f32 - origin.y) * dir_inv.y;
        let lo_z = (self.min[2] as f32 - origin.z) * dir_inv.z;
        let hi_z = (self.max[2] as f32 - origin.z) * dir_inv.z;

        let (ax, bx) = if lo_x <= hi_x {
            (lo_x, hi_x)
        } else {
            (hi_x, lo_x)
        };
        let (ay, by) = if lo_y <= hi_y {
            (lo_y, hi_y)
        } else {
            (hi_y, lo_y)
        };
        let (az, bz) = if lo_z <= hi_z {
            (lo_z, hi_z)
        } else {
            (hi_z, lo_z)
        };

        let t_min = ax.max(ay).max(az);
        let t_max = bx.min(by).min(bz);
        if t_max < t_min || t_max < 0.0 {
            None
        } else {
            Some((t_min.max(0.0), t_max))
        }
    }

    /// Squared distance from a point to the box (0 if inside).
    #[allow(
        clippy::cast_possible_truncation,
        reason = "bounds are already tile-local before this f32 renderer query"
    )]
    pub fn distance_sq_to_point(self, p: Vec3) -> f32 {
        let mut d2 = 0.0_f32;
        let lo_x = self.min[0] as f32;
        let hi_x = self.max[0] as f32;
        let lo_y = self.min[1] as f32;
        let hi_y = self.max[1] as f32;
        let lo_z = self.min[2] as f32;
        let hi_z = self.max[2] as f32;
        if p.x < lo_x {
            let d = lo_x - p.x;
            d2 += d * d;
        } else if p.x > hi_x {
            let d = p.x - hi_x;
            d2 += d * d;
        }
        if p.y < lo_y {
            let d = lo_y - p.y;
            d2 += d * d;
        } else if p.y > hi_y {
            let d = p.y - hi_y;
            d2 += d * d;
        }
        if p.z < lo_z {
            let d = lo_z - p.z;
            d2 += d * d;
        } else if p.z > hi_z {
            let d = p.z - hi_z;
            d2 += d * d;
        }
        d2
    }
}

/// Octant index for a point relative to a cube center.
/// Bit layout: bit 0 = +X, bit 1 = +Y, bit 2 = +Z.
pub fn octant_index(point: [f32; 3], center: [f64; 3]) -> usize {
    let mut idx = 0;
    if f64::from(point[0]) >= center[0] {
        idx |= 1;
    }
    if f64::from(point[1]) >= center[1] {
        idx |= 2;
    }
    if f64::from(point[2]) >= center[2] {
        idx |= 4;
    }
    idx
}
