//! f64 world-camera and stable camera-relative GPU coordinate handling.

use std::error::Error;
use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

use crate::WorldVec3;

/// Projection used by one viewport camera.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CameraProjection {
    /// Perspective projection.
    Perspective {
        /// Vertical field of view in radians.
        vertical_fov_radians: f64,
        /// Viewport width divided by height.
        aspect: f64,
        /// Positive near distance in project units.
        near: f64,
        /// Positive far distance greater than `near`.
        far: f64,
    },
    /// Orthographic projection used for top-down and section views.
    Orthographic {
        /// Visible vertical span in project units.
        vertical_span: f64,
        /// Viewport width divided by height.
        aspect: f64,
        /// Signed near plane in camera space.
        near: f64,
        /// Far plane greater than `near`.
        far: f64,
    },
}

/// Authoritative f64 camera state shared by 3D and locked top-down modes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldCamera {
    /// Camera position in project-world coordinates.
    pub eye: WorldVec3,
    /// Orbit/focus target in project-world coordinates.
    pub target: WorldVec3,
    /// World-space camera up direction.
    pub up: WorldVec3,
    /// Active projection.
    pub projection: CameraProjection,
}

/// Invalid floating-origin configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FloatingOriginError {
    /// Grid size must be positive and finite.
    InvalidGridSize,
    /// Initial focus must contain only finite components.
    InvalidFocus,
}

impl Display for FloatingOriginError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidGridSize => {
                formatter.write_str("floating-origin grid must be finite and positive")
            }
            Self::InvalidFocus => formatter.write_str("floating-origin focus must be finite"),
        }
    }
}

impl Error for FloatingOriginError {}

/// One stable, grid-snapped world origin used for camera-relative rendering.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingOrigin {
    grid_size: f64,
    world: WorldVec3,
}

/// Origin movement that render proxies apply as a root-uniform update.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginShift {
    /// Previous f64 world origin.
    pub previous: WorldVec3,
    /// New f64 world origin.
    pub current: WorldVec3,
}

impl FloatingOrigin {
    /// Creates an origin snapped to `grid_size` around `focus`.
    pub fn new(grid_size: f64, focus: WorldVec3) -> Result<Self, FloatingOriginError> {
        if !grid_size.is_finite() || grid_size <= 0.0 {
            return Err(FloatingOriginError::InvalidGridSize);
        }
        if !finite(focus) {
            return Err(FloatingOriginError::InvalidFocus);
        }
        Ok(Self {
            grid_size,
            world: snap(focus, grid_size),
        })
    }

    /// Restores an already selected stable origin without re-snapping it.
    ///
    /// This is used across native/WASM host boundaries where the authoritative
    /// f64 origin was selected previously and must round-trip bit-for-bit.
    pub fn from_selected(grid_size: f64, world: WorldVec3) -> Result<Self, FloatingOriginError> {
        if !grid_size.is_finite() || grid_size <= 0.0 {
            return Err(FloatingOriginError::InvalidGridSize);
        }
        if !finite(world) {
            return Err(FloatingOriginError::InvalidFocus);
        }
        Ok(Self { grid_size, world })
    }

    /// Current stable f64 render origin.
    #[must_use]
    pub fn world(self) -> WorldVec3 {
        self.world
    }

    /// Grid spacing used to avoid changing origin on every camera movement.
    #[must_use]
    pub fn grid_size(self) -> f64 {
        self.grid_size
    }

    /// Moves to the snapped cell containing `focus` and reports an actual shift.
    pub fn update(&mut self, focus: WorldVec3) -> Result<Option<OriginShift>, FloatingOriginError> {
        if !finite(focus) {
            return Err(FloatingOriginError::InvalidFocus);
        }
        let next = snap(focus, self.grid_size);
        if next == self.world {
            return Ok(None);
        }
        let shift = OriginShift {
            previous: self.world,
            current: next,
        };
        self.world = next;
        Ok(Some(shift))
    }

    /// Converts a world coordinate to f32 only after the f64 origin subtraction.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn world_to_render(self, position: WorldVec3) -> [f32; 3] {
        // INVARIANT: conversion is intentional only after f64 origin removal;
        // the test below guards millimetre deltas at ECEF-scale coordinates.
        [
            (position.x - self.world.x) as f32,
            (position.y - self.world.y) as f32,
            (position.z - self.world.z) as f32,
        ]
    }

    /// Restores a project-world coordinate from a renderer-local value.
    #[must_use]
    pub fn render_to_world(self, position: [f32; 3]) -> WorldVec3 {
        WorldVec3 {
            x: self.world.x + f64::from(position[0]),
            y: self.world.y + f64::from(position[1]),
            z: self.world.z + f64::from(position[2]),
        }
    }
}

/// f64 tile anchor paired with tile-local f32 vertex data.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TilePlacement {
    /// Exact source/world anchor of the tile-local vertex buffer.
    pub world_origin: WorldVec3,
}

impl TilePlacement {
    /// Converts one tile-local vertex into renderer-relative coordinates.
    #[must_use]
    pub fn local_to_render(self, local: [f32; 3], origin: FloatingOrigin) -> [f32; 3] {
        let anchor = origin.world_to_render(self.world_origin);
        [
            anchor[0] + local[0],
            anchor[1] + local[1],
            anchor[2] + local[2],
        ]
    }
}

fn snap(value: WorldVec3, grid_size: f64) -> WorldVec3 {
    WorldVec3 {
        x: (value.x / grid_size).round() * grid_size,
        y: (value.y / grid_size).round() * grid_size,
        z: (value.z / grid_size).round() * grid_size,
    }
}

fn finite(value: WorldVec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

#[cfg(test)]
mod tests {
    use super::{CameraProjection, FloatingOrigin, TilePlacement};
    use crate::WorldVec3;

    #[test]
    fn camera_projection_json_uses_the_public_camel_case_contract() {
        let projection = CameraProjection::Perspective {
            vertical_fov_radians: 1.0,
            aspect: 1.5,
            near: 0.1,
            far: 1_000.0,
        };
        let json = serde_json::to_string(&projection).expect("camera projection serializes");

        assert!(json.contains("\"verticalFovRadians\""));
        assert!(!json.contains("vertical_fov_radians"));
        assert_eq!(
            serde_json::from_str::<CameraProjection>(&json).expect("camera projection restores"),
            projection
        );
    }

    #[test]
    fn ecef_scale_coordinates_keep_millimetre_delta_after_f64_subtraction() {
        let origin = FloatingOrigin::new(
            1_024.0,
            WorldVec3 {
                x: 6_378_137.0,
                y: 1_234_567.0,
                z: 700.0,
            },
        )
        .expect("valid origin");
        let base = origin.world();
        let relative = origin.world_to_render(WorldVec3 {
            x: base.x + 0.001,
            y: base.y - 0.002,
            z: base.z + 0.003,
        });

        assert!((relative[0] - 0.001).abs() < 1.0e-7);
        assert!((relative[1] + 0.002).abs() < 1.0e-7);
        assert!((relative[2] - 0.003).abs() < 1.0e-7);
    }

    #[test]
    fn origin_is_stable_inside_one_grid_cell() {
        let mut origin = FloatingOrigin::new(
            100.0,
            WorldVec3 {
                x: 1_010.0,
                y: 2_010.0,
                z: 10.0,
            },
        )
        .expect("valid origin");

        assert_eq!(
            origin
                .update(WorldVec3 {
                    x: 1_040.0,
                    y: 2_040.0,
                    z: 40.0,
                })
                .expect("valid focus"),
            None
        );
        assert!(origin
            .update(WorldVec3 {
                x: 1_060.0,
                y: 2_040.0,
                z: 40.0,
            })
            .expect("valid focus")
            .is_some());
    }

    #[test]
    fn tile_local_vertices_share_the_scene_origin_without_rewriting_source_data() {
        let origin = FloatingOrigin::new(
            1_000.0,
            WorldVec3 {
                x: 500_000.0,
                y: 5_400_000.0,
                z: 500.0,
            },
        )
        .expect("valid origin");
        let tile = TilePlacement {
            world_origin: WorldVec3 {
                x: origin.world().x + 100.0,
                y: origin.world().y - 50.0,
                z: origin.world().z + 10.0,
            },
        };

        let rendered = tile.local_to_render([0.25, 0.5, -1.0], origin);
        let expected = [100.25, -49.5, 9.0];
        for (actual, expected) in rendered.into_iter().zip(expected) {
            assert!((actual - expected).abs() < f32::EPSILON);
        }
    }
}
