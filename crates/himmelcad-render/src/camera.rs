//! f64 camera matrices, projection morphing and cursor unprojection.

use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::{DMat4, DVec3, DVec4};
use serde::{Deserialize, Serialize};

use crate::{CameraProjection, WorldCamera, WorldVec3};

/// Invalid camera basis, projection, viewport or non-invertible transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraFrameError {
    /// Eye, target and up do not form a finite camera basis.
    InvalidBasis,
    /// Projection parameters are invalid.
    InvalidProjection,
    /// Viewport dimensions are zero.
    InvalidViewport,
    /// A blended view-projection matrix cannot be inverted.
    NonInvertible,
}

impl Display for CameraFrameError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBasis => "invalid world-camera basis",
            Self::InvalidProjection => "invalid camera projection",
            Self::InvalidViewport => "invalid camera viewport",
            Self::NonInvertible => "camera view-projection matrix is non-invertible",
        })
    }
}

impl Error for CameraFrameError {}

/// One renderable f64 camera frame and its exact inverse.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraFrame {
    /// Camera state sampled for this frame.
    pub camera: WorldCamera,
    /// Stable render origin used by the matrix.
    pub floating_origin: WorldVec3,
    /// Reverse-Z world-relative view-projection matrix.
    pub view_projection: DMat4,
    /// Inverse used for cursor rays and depth reconstruction.
    pub inverse_view_projection: DMat4,
}

impl CameraFrame {
    /// Creates a non-morphed frame from one authoritative camera.
    pub fn new(camera: WorldCamera, floating_origin: WorldVec3) -> Result<Self, CameraFrameError> {
        camera_frame(camera, camera.projection, floating_origin)
    }

    /// Converts the f64 camera-relative matrix only at the GPU boundary.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn gpu_view_projection(self) -> [[f32; 4]; 4] {
        self.view_projection
            .to_cols_array_2d()
            .map(|column| column.map(|value| value as f32))
    }

    /// Reconstructs the world coordinate beneath one physical viewport pixel.
    pub fn unproject_pixel(
        self,
        pixel: [f64; 2],
        reverse_z_depth: f64,
        viewport: [u32; 2],
    ) -> Result<WorldVec3, CameraFrameError> {
        if viewport[0] == 0 || viewport[1] == 0 {
            return Err(CameraFrameError::InvalidViewport);
        }
        if pixel.iter().any(|value| !value.is_finite())
            || !reverse_z_depth.is_finite()
            || !(0.0..=1.0).contains(&reverse_z_depth)
        {
            return Err(CameraFrameError::InvalidProjection);
        }
        let ndc = DVec4::new(
            pixel[0] / f64::from(viewport[0]) * 2.0 - 1.0,
            1.0 - pixel[1] / f64::from(viewport[1]) * 2.0,
            reverse_z_depth,
            1.0,
        );
        let homogeneous = self.inverse_view_projection * ndc;
        if homogeneous.w.abs() <= f64::EPSILON || !homogeneous.is_finite() {
            return Err(CameraFrameError::NonInvertible);
        }
        let relative = homogeneous.truncate() / homogeneous.w;
        Ok(WorldVec3 {
            x: relative.x + self.floating_origin.x,
            y: relative.y + self.floating_origin.y,
            z: relative.z + self.floating_origin.z,
        })
    }

    /// Projects one project-world coordinate into physical viewport pixels.
    pub fn project_world(
        self,
        position: WorldVec3,
        viewport: [u32; 2],
    ) -> Result<ProjectedWorldPoint, CameraFrameError> {
        if viewport[0] == 0 || viewport[1] == 0 {
            return Err(CameraFrameError::InvalidViewport);
        }
        let relative = DVec3::new(
            position.x - self.floating_origin.x,
            position.y - self.floating_origin.y,
            position.z - self.floating_origin.z,
        );
        if !relative.is_finite() {
            return Err(CameraFrameError::InvalidProjection);
        }
        let clip = self.view_projection * relative.extend(1.0);
        if !clip.is_finite() || clip.w <= f64::EPSILON {
            return Err(CameraFrameError::InvalidProjection);
        }
        let ndc = clip.truncate() / clip.w;
        Ok(ProjectedWorldPoint {
            pixel: [
                (ndc.x + 1.0) * 0.5 * f64::from(viewport[0]),
                (1.0 - ndc.y) * 0.5 * f64::from(viewport[1]),
            ],
            reverse_z_depth: ndc.z,
        })
    }

    /// Returns a f64 cursor ray through one physical viewport pixel.
    pub fn cursor_ray(
        self,
        pixel: [f64; 2],
        viewport: [u32; 2],
    ) -> Result<WorldRay, CameraFrameError> {
        let near = self.unproject_pixel(pixel, 1.0, viewport)?;
        let far = self.unproject_pixel(pixel, 0.0, viewport)?;
        let direction = (vector(far) - vector(near))
            .try_normalize()
            .ok_or(CameraFrameError::InvalidBasis)?;
        Ok(WorldRay {
            origin: near,
            direction: world(direction),
        })
    }
}

/// Project-world cursor ray used by analytic CAD and provider refinements.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorldRay {
    /// Near-plane world point.
    pub origin: WorldVec3,
    /// Unit world direction.
    pub direction: WorldVec3,
}

/// Physical-pixel projection and reverse-Z depth of one world coordinate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProjectedWorldPoint {
    /// Top-left-origin physical viewport coordinate.
    pub pixel: [f64; 2],
    /// Reverse-Z normalized device depth.
    pub reverse_z_depth: f64,
}

/// Immutable source and destination of a seamless camera transition.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraTransition {
    /// Starting camera.
    pub from: WorldCamera,
    /// Destination camera.
    pub to: WorldCamera,
}

impl CameraTransition {
    /// Samples a view and projection morph. `progress` is clamped to zero through one.
    pub fn sample(
        self,
        progress: f64,
        floating_origin: WorldVec3,
    ) -> Result<CameraFrame, CameraFrameError> {
        if !progress.is_finite() {
            return Err(CameraFrameError::InvalidProjection);
        }
        let progress = smoothstep(progress.clamp(0.0, 1.0));
        let camera = WorldCamera {
            eye: lerp_world(self.from.eye, self.to.eye, progress),
            target: lerp_world(self.from.target, self.to.target, progress),
            up: world(
                vector(self.from.up)
                    .lerp(vector(self.to.up), progress)
                    .try_normalize()
                    .ok_or(CameraFrameError::InvalidBasis)?,
            ),
            projection: if progress < 0.5 {
                self.from.projection
            } else {
                self.to.projection
            },
        };
        validate_basis(camera)?;
        let view = view_matrix(camera, floating_origin)?;
        let from_projection = projection_matrix(self.from.projection)?;
        let to_projection = projection_matrix(self.to.projection)?;
        let projection = matrix_lerp(from_projection, to_projection, progress);
        finish_frame(camera, floating_origin, projection * view)
    }
}

/// Creates a top-down orthographic camera whose initial scale matches a perspective target plane.
pub fn matched_top_down(camera: WorldCamera) -> Result<WorldCamera, CameraFrameError> {
    let CameraProjection::Perspective {
        vertical_fov_radians,
        aspect,
        near,
        far,
    } = camera.projection
    else {
        return Err(CameraFrameError::InvalidProjection);
    };
    validate_basis(camera)?;
    let distance = vector(camera.eye).distance(vector(camera.target));
    let vertical_span = 2.0 * distance * (vertical_fov_radians * 0.5).tan();
    let height = distance.max(near);
    Ok(WorldCamera {
        eye: WorldVec3 {
            x: camera.target.x,
            y: camera.target.y,
            z: camera.target.z + height,
        },
        target: camera.target,
        up: WorldVec3 {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        },
        projection: CameraProjection::Orthographic {
            vertical_span,
            aspect,
            near,
            far,
        },
    })
}

fn camera_frame(
    camera: WorldCamera,
    projection: CameraProjection,
    floating_origin: WorldVec3,
) -> Result<CameraFrame, CameraFrameError> {
    validate_basis(camera)?;
    let matrix = projection_matrix(projection)? * view_matrix(camera, floating_origin)?;
    finish_frame(camera, floating_origin, matrix)
}

fn finish_frame(
    camera: WorldCamera,
    floating_origin: WorldVec3,
    view_projection: DMat4,
) -> Result<CameraFrame, CameraFrameError> {
    let determinant = view_projection.determinant();
    if !determinant.is_finite() || determinant.abs() <= f64::EPSILON {
        return Err(CameraFrameError::NonInvertible);
    }
    Ok(CameraFrame {
        camera,
        floating_origin,
        view_projection,
        inverse_view_projection: view_projection.inverse(),
    })
}

fn view_matrix(camera: WorldCamera, origin: WorldVec3) -> Result<DMat4, CameraFrameError> {
    let eye = vector(camera.eye) - vector(origin);
    let target = vector(camera.target) - vector(origin);
    let up = vector(camera.up);
    if !eye.is_finite() || !target.is_finite() || !up.is_finite() {
        return Err(CameraFrameError::InvalidBasis);
    }
    Ok(DMat4::look_at_rh(eye, target, up))
}

fn projection_matrix(projection: CameraProjection) -> Result<DMat4, CameraFrameError> {
    match projection {
        CameraProjection::Perspective {
            vertical_fov_radians,
            aspect,
            near,
            far,
        } if vertical_fov_radians.is_finite()
            && vertical_fov_radians > 0.0
            && vertical_fov_radians < std::f64::consts::PI
            && aspect.is_finite()
            && aspect > 0.0
            && near.is_finite()
            && near > 0.0
            && far.is_finite()
            && far > near =>
        {
            let focal = 1.0 / (vertical_fov_radians * 0.5).tan();
            let depth = near / (far - near);
            let translation = near * far / (far - near);
            Ok(DMat4::from_cols(
                DVec4::new(focal / aspect, 0.0, 0.0, 0.0),
                DVec4::new(0.0, focal, 0.0, 0.0),
                DVec4::new(0.0, 0.0, depth, -1.0),
                DVec4::new(0.0, 0.0, translation, 0.0),
            ))
        }
        CameraProjection::Orthographic {
            vertical_span,
            aspect,
            near,
            far,
        } if vertical_span.is_finite()
            && vertical_span > 0.0
            && aspect.is_finite()
            && aspect > 0.0
            && near.is_finite()
            && far.is_finite()
            && far > near =>
        {
            let depth_range = far - near;
            Ok(DMat4::from_cols(
                DVec4::new(2.0 / (vertical_span * aspect), 0.0, 0.0, 0.0),
                DVec4::new(0.0, 2.0 / vertical_span, 0.0, 0.0),
                DVec4::new(0.0, 0.0, 1.0 / depth_range, 0.0),
                DVec4::new(0.0, 0.0, far / depth_range, 1.0),
            ))
        }
        _ => Err(CameraFrameError::InvalidProjection),
    }
}

fn validate_basis(camera: WorldCamera) -> Result<(), CameraFrameError> {
    let forward = vector(camera.target) - vector(camera.eye);
    let up = vector(camera.up);
    if !forward.is_finite()
        || !up.is_finite()
        || forward.length_squared() <= f64::EPSILON
        || up.length_squared() <= f64::EPSILON
        || forward.cross(up).length_squared() <= f64::EPSILON
    {
        return Err(CameraFrameError::InvalidBasis);
    }
    Ok(())
}

fn matrix_lerp(from: DMat4, to: DMat4, progress: f64) -> DMat4 {
    DMat4::from_cols_array(&std::array::from_fn(|index| {
        from.to_cols_array()[index].mul_add(1.0 - progress, to.to_cols_array()[index] * progress)
    }))
}

fn lerp_world(from: WorldVec3, to: WorldVec3, progress: f64) -> WorldVec3 {
    WorldVec3 {
        x: from.x.mul_add(1.0 - progress, to.x * progress),
        y: from.y.mul_add(1.0 - progress, to.y * progress),
        z: from.z.mul_add(1.0 - progress, to.z * progress),
    }
}

fn smoothstep(value: f64) -> f64 {
    value * value * (3.0 - 2.0 * value)
}

fn vector(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn world(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

#[cfg(test)]
mod tests {
    use super::{matched_top_down, CameraFrame, CameraTransition};
    use crate::{CameraProjection, WorldCamera, WorldVec3};

    fn perspective() -> WorldCamera {
        WorldCamera {
            eye: WorldVec3 {
                x: 10.0,
                y: -10.0,
                z: 10.0,
            },
            target: WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            up: WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            projection: CameraProjection::Perspective {
                vertical_fov_radians: std::f64::consts::FRAC_PI_3,
                aspect: 16.0 / 9.0,
                near: 0.1,
                far: 10_000.0,
            },
        }
    }

    #[test]
    fn center_cursor_ray_points_at_orbit_target() {
        let camera = perspective();
        let frame = CameraFrame::new(
            camera,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("camera frame");
        let ray = frame
            .cursor_ray([960.0, 540.0], [1_920, 1_080])
            .expect("ray");
        let expected = (glam::DVec3::ZERO - glam::DVec3::new(10.0, -10.0, 10.0)).normalize();
        let actual = glam::DVec3::new(ray.direction.x, ray.direction.y, ray.direction.z);

        assert!(actual.distance(expected) < 1.0e-10);
    }

    #[test]
    fn project_and_unproject_round_trip_world_coordinate() {
        let frame = CameraFrame::new(
            perspective(),
            WorldVec3 {
                x: 1_000_000.0,
                y: 2_000_000.0,
                z: 500.0,
            },
        )
        .expect("camera frame");
        let source = WorldVec3 {
            x: 1.25,
            y: -0.75,
            z: 0.5,
        };
        let projected = frame
            .project_world(source, [1_920, 1_080])
            .expect("project");
        let reconstructed = frame
            .unproject_pixel(projected.pixel, projected.reverse_z_depth, [1_920, 1_080])
            .expect("unproject");

        assert!((reconstructed.x - source.x).abs() < 1.0e-8);
        assert!((reconstructed.y - source.y).abs() < 1.0e-8);
        assert!((reconstructed.z - source.z).abs() < 1.0e-8);
    }

    #[test]
    fn top_down_span_matches_perspective_target_plane() {
        let source = perspective();
        let top = matched_top_down(source).expect("top down");
        let CameraProjection::Orthographic { vertical_span, .. } = top.projection else {
            panic!("orthographic");
        };
        let distance = (3.0_f64 * 100.0).sqrt();
        let expected = 2.0 * distance * (std::f64::consts::FRAC_PI_6).tan();
        assert!((vertical_span - expected).abs() < 1.0e-10);
    }

    #[test]
    fn projection_transition_keeps_every_intermediate_matrix_invertible() {
        let from = perspective();
        let to = matched_top_down(from).expect("top down");
        let transition = CameraTransition { from, to };
        for step in 0_u8..=20 {
            transition
                .sample(
                    f64::from(step) / 20.0,
                    WorldVec3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                )
                .expect("invertible transition frame");
        }
    }
}
