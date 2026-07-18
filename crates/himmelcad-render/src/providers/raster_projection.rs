//! Canonical raster pixel and depth projection into entity-local source space.

use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::{DMat4, DVec3};

use himmelcad_core::entity_model::{
    CameraModel, DepthSemantics, GeometryObject, RasterImageGeometry, RasterMapping, Transform3d,
    Vector3,
};
use himmelcad_core::entity_validation::validate_geometry_object;

use crate::WorldVec3;

/// A raster projection or depth semantic that cannot produce an authoritative
/// entity-local source coordinate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterProjectionError {
    /// The canonical raster contract itself is invalid.
    InvalidContract,
    /// Pixel-center coordinates are non-finite or outside the image footprint.
    PixelOutsideImage,
    /// This mapping requires a depth sample but none was supplied.
    DepthRequired,
    /// The depth sample is non-finite or lies behind its camera.
    InvalidDepth,
    /// Mapping and depth semantics do not define a unique source coordinate.
    UnsupportedDepthSemantics,
    /// A namespaced camera or distortion model has no registered evaluator.
    UnsupportedCameraModel,
    /// An elevation plane is parallel to the selected camera ray.
    ParallelElevationPlane,
}

impl Display for RasterProjectionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidContract => "canonical raster projection contract is invalid",
            Self::PixelOutsideImage => "pixel coordinate lies outside the raster footprint",
            Self::DepthRequired => "camera raster measurement requires a depth sample",
            Self::InvalidDepth => "raster depth is non-finite or behind the camera",
            Self::UnsupportedDepthSemantics => {
                "raster mapping and depth semantics do not define a source coordinate"
            }
            Self::UnsupportedCameraModel => {
                "camera or distortion model has no registered projection evaluator"
            }
            Self::ParallelElevationPlane => {
                "camera ray is parallel to the requested elevation plane"
            }
        })
    }
}

impl Error for RasterProjectionError {}

/// Projects one coordinate expressed in canonical pixel-center coordinates.
///
/// Integer `(0, 0)` is the center of the first pixel and the image footprint
/// spans `[-0.5, width - 0.5] x [-0.5, height - 0.5]`. The returned coordinate
/// is entity-local source geometry; entity placement and vertical
/// exaggeration are deliberately not applied here.
pub fn project_raster_sample(
    raster: &RasterImageGeometry,
    column: f64,
    row: f64,
    depth: Option<f64>,
) -> Result<WorldVec3, RasterProjectionError> {
    validate_geometry_object(&GeometryObject::RasterImage {
        raster: Box::new(raster.clone()),
    })
    .map_err(|_| RasterProjectionError::InvalidContract)?;
    validate_pixel(raster, column, row)?;

    match &raster.mapping {
        RasterMapping::OrthoGrid(mapping) => {
            let mut position = vector(mapping.origin)
                + vector(mapping.column_step) * column
                + vector(mapping.row_step) * row;
            if let Some(value) = depth {
                if raster
                    .depth
                    .as_ref()
                    .is_none_or(|field| field.sampling.semantics != DepthSemantics::ElevationZ)
                {
                    return Err(RasterProjectionError::UnsupportedDepthSemantics);
                }
                if !value.is_finite() {
                    return Err(RasterProjectionError::InvalidDepth);
                }
                position.z = value;
            }
            Ok(world(position))
        }
        RasterMapping::Planar { homography, frame } => {
            if depth.is_some() {
                return Err(RasterProjectionError::UnsupportedDepthSemantics);
            }
            let homogeneous = DVec3::new(
                homography[0] * column + homography[3] * row + homography[6],
                homography[1] * column + homography[4] * row + homography[7],
                homography[2] * column + homography[5] * row + homography[8],
            );
            if !homogeneous.is_finite() || homogeneous.z.abs() <= f64::EPSILON {
                return Err(RasterProjectionError::InvalidContract);
            }
            let u = homogeneous.x / homogeneous.z;
            let v = homogeneous.y / homogeneous.z;
            Ok(world(
                vector(frame.origin) + vector(frame.u_axis) * u + vector(frame.v_axis) * v,
            ))
        }
        RasterMapping::Camera { model, pose } => {
            let depth = depth.ok_or(RasterProjectionError::DepthRequired)?;
            if !depth.is_finite() {
                return Err(RasterProjectionError::InvalidDepth);
            }
            let pose = rigid_pose(*pose)?;
            let center = pose.transform_point3(DVec3::ZERO);
            let (camera_direction, entity_direction) =
                camera_ray(model, pose, column, row, raster.width, raster.height)?;
            let semantics = raster
                .depth
                .as_ref()
                .ok_or(RasterProjectionError::DepthRequired)?
                .sampling
                .semantics;
            let position = match semantics {
                DepthSemantics::RayDistance => {
                    if depth <= 0.0 {
                        return Err(RasterProjectionError::InvalidDepth);
                    }
                    center + entity_direction * depth
                }
                DepthSemantics::OpticalAxisDepth => {
                    if !matches!(model, CameraModel::Pinhole { .. }) {
                        return Err(RasterProjectionError::UnsupportedDepthSemantics);
                    }
                    if depth <= 0.0 {
                        return Err(RasterProjectionError::InvalidDepth);
                    }
                    pose.transform_point3(camera_direction * depth)
                }
                DepthSemantics::ElevationZ => {
                    if entity_direction.z.abs() <= 1.0e-12 {
                        return Err(RasterProjectionError::ParallelElevationPlane);
                    }
                    let distance = (depth - center.z) / entity_direction.z;
                    if !distance.is_finite() || distance <= 0.0 {
                        return Err(RasterProjectionError::InvalidDepth);
                    }
                    center + entity_direction * distance
                }
            };
            position
                .is_finite()
                .then(|| world(position))
                .ok_or(RasterProjectionError::InvalidDepth)
        }
    }
}

fn validate_pixel(
    raster: &RasterImageGeometry,
    column: f64,
    row: f64,
) -> Result<(), RasterProjectionError> {
    let maximum_column = f64::from(raster.width) - 0.5;
    let maximum_row = f64::from(raster.height) - 0.5;
    if !column.is_finite()
        || !row.is_finite()
        || column < -0.5
        || row < -0.5
        || column > maximum_column
        || row > maximum_row
    {
        Err(RasterProjectionError::PixelOutsideImage)
    } else {
        Ok(())
    }
}

fn rigid_pose(pose: Transform3d) -> Result<DMat4, RasterProjectionError> {
    let pose = DMat4::from_cols_array(&pose.0);
    if !pose.is_finite() || pose.determinant().abs() <= f64::EPSILON {
        Err(RasterProjectionError::InvalidContract)
    } else {
        Ok(pose)
    }
}

fn camera_ray(
    model: &CameraModel,
    pose: DMat4,
    column: f64,
    row: f64,
    width: u32,
    height: u32,
) -> Result<(DVec3, DVec3), RasterProjectionError> {
    let camera_direction = match model {
        CameraModel::Pinhole {
            focal_x,
            focal_y,
            center_x,
            center_y,
            distortion_model,
            ..
        } => {
            if distortion_model.is_some() {
                return Err(RasterProjectionError::UnsupportedCameraModel);
            }
            DVec3::new(
                (column - center_x) / focal_x,
                (row - center_y) / focal_y,
                1.0,
            )
        }
        CameraModel::Equirectangular => {
            let longitude = ((column + 0.5) / f64::from(width) - 0.5) * std::f64::consts::TAU;
            let latitude = ((row + 0.5) / f64::from(height) - 0.5) * std::f64::consts::PI;
            let planar = latitude.cos();
            DVec3::new(
                planar * longitude.sin(),
                latitude.sin(),
                planar * longitude.cos(),
            )
        }
        CameraModel::Extension { .. } => return Err(RasterProjectionError::UnsupportedCameraModel),
    };
    if !camera_direction.is_finite() || camera_direction.length_squared() <= f64::EPSILON {
        return Err(RasterProjectionError::InvalidContract);
    }
    let entity_direction = pose.transform_vector3(camera_direction).normalize_or_zero();
    if !entity_direction.is_finite() || entity_direction.length_squared() <= f64::EPSILON {
        return Err(RasterProjectionError::InvalidContract);
    }
    Ok((camera_direction, entity_direction))
}

fn vector(value: Vector3) -> DVec3 {
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
    use himmelcad_core::entity_model::{
        CameraModel, DepthField, DepthSampling, DepthSemantics, GeometryResource, OrthoGridMapping,
        PlaneFrame, RasterCellDiagonal, RasterConnectivity, RasterImageGeometry,
        RasterInterpolation, RasterMapping, Transform3d, Vector3,
    };
    use himmelcad_core::hash::ObjectHash;

    use super::{project_raster_sample, RasterProjectionError};
    use crate::WorldVec3;

    fn resource(bytes: usize) -> GeometryResource {
        GeometryResource {
            object_hash: ObjectHash::of_bytes(&vec![0; bytes]),
            media_type: "application/octet-stream".to_owned(),
            byte_length: Some(bytes as u64),
        }
    }

    fn depth(semantics: DepthSemantics) -> Option<DepthField> {
        Some(DepthField {
            values: resource(16),
            validity: None,
            confidence: None,
            sampling: DepthSampling {
                semantics,
                interpolation: RasterInterpolation::DiscontinuityAware,
                connectivity: RasterConnectivity::Continuous {
                    maximum_height_jump: None,
                    diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                },
            },
        })
    }

    fn raster(mapping: RasterMapping, semantics: Option<DepthSemantics>) -> RasterImageGeometry {
        RasterImageGeometry {
            pixels: resource(64),
            width: 4,
            height: 4,
            mapping,
            depth: semantics.and_then(depth),
        }
    }

    fn translation(x: f64, y: f64, z: f64) -> Transform3d {
        Transform3d([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0,
        ])
    }

    fn assert_close(actual: WorldVec3, expected: WorldVec3) {
        assert!((actual.x - expected.x).abs() < 1.0e-12);
        assert!((actual.y - expected.y).abs() < 1.0e-12);
        assert!((actual.z - expected.z).abs() < 1.0e-12);
    }

    #[test]
    fn orthographic_elevation_replaces_only_entity_local_z() {
        let raster = raster(
            RasterMapping::OrthoGrid(OrthoGridMapping {
                origin: Vector3 {
                    x: 10.0,
                    y: 20.0,
                    z: 30.0,
                },
                column_step: Vector3 {
                    x: 2.0,
                    y: 0.0,
                    z: 0.0,
                },
                row_step: Vector3 {
                    x: 0.0,
                    y: -3.0,
                    z: 0.0,
                },
            }),
            Some(DepthSemantics::ElevationZ),
        );
        assert_close(
            project_raster_sample(&raster, 1.0, 1.0, Some(100.0)).unwrap(),
            WorldVec3 {
                x: 12.0,
                y: 17.0,
                z: 100.0,
            },
        );
    }

    #[test]
    fn planar_homography_maps_pixel_centers_into_its_oriented_frame() {
        let raster = raster(
            RasterMapping::Planar {
                homography: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                frame: PlaneFrame {
                    origin: Vector3 {
                        x: 10.0,
                        y: 20.0,
                        z: 30.0,
                    },
                    u_axis: Vector3 {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    v_axis: Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 1.0,
                    },
                },
            },
            None,
        );
        assert_close(
            project_raster_sample(&raster, 2.0, 3.0, None).unwrap(),
            WorldVec3 {
                x: 12.0,
                y: 20.0,
                z: 33.0,
            },
        );
        assert_eq!(
            project_raster_sample(&raster, 2.0, 3.0, Some(1.0)),
            Err(RasterProjectionError::UnsupportedDepthSemantics)
        );
    }

    #[test]
    fn pinhole_optical_axis_ray_distance_and_elevation_are_distinct() {
        let mapping = RasterMapping::Camera {
            model: CameraModel::Pinhole {
                focal_x: 2.0,
                focal_y: 4.0,
                center_x: 1.0,
                center_y: 1.0,
                distortion_model: None,
                distortion_parameters: Vec::new(),
            },
            pose: translation(100.0, 200.0, 300.0),
        };
        let optical = raster(mapping.clone(), Some(DepthSemantics::OpticalAxisDepth));
        assert_close(
            project_raster_sample(&optical, 3.0, 3.0, Some(2.0)).unwrap(),
            WorldVec3 {
                x: 102.0,
                y: 201.0,
                z: 302.0,
            },
        );
        let ray = raster(mapping.clone(), Some(DepthSemantics::RayDistance));
        let ray_point = project_raster_sample(&ray, 3.0, 3.0, Some(3.0)).unwrap();
        let inverse_length = 1.0 / 2.25_f64.sqrt();
        assert_close(
            ray_point,
            WorldVec3 {
                x: 100.0 + 3.0 * inverse_length,
                y: 200.0 + 1.5 * inverse_length,
                z: 300.0 + 3.0 * inverse_length,
            },
        );
        let elevation = raster(mapping, Some(DepthSemantics::ElevationZ));
        assert_close(
            project_raster_sample(&elevation, 3.0, 3.0, Some(305.0)).unwrap(),
            WorldVec3 {
                x: 105.0,
                y: 202.5,
                z: 305.0,
            },
        );
    }

    #[test]
    fn equirectangular_center_uses_camera_forward_and_rejects_optical_depth() {
        let mapping = RasterMapping::Camera {
            model: CameraModel::Equirectangular,
            pose: translation(10.0, 20.0, 30.0),
        };
        let ray = raster(mapping.clone(), Some(DepthSemantics::RayDistance));
        assert_close(
            project_raster_sample(&ray, 1.5, 1.5, Some(10.0)).unwrap(),
            WorldVec3 {
                x: 10.0,
                y: 20.0,
                z: 40.0,
            },
        );
        let optical = raster(mapping, Some(DepthSemantics::OpticalAxisDepth));
        assert_eq!(
            project_raster_sample(&optical, 1.5, 1.5, Some(10.0)),
            Err(RasterProjectionError::InvalidContract)
        );
    }

    #[test]
    fn unknown_camera_evaluators_and_outside_pixels_fail_explicitly() {
        let distorted = raster(
            RasterMapping::Camera {
                model: CameraModel::Pinhole {
                    focal_x: 2.0,
                    focal_y: 2.0,
                    center_x: 1.0,
                    center_y: 1.0,
                    distortion_model: Some("vendor.radial@1".to_owned()),
                    distortion_parameters: vec![0.1],
                },
                pose: Transform3d::IDENTITY,
            },
            Some(DepthSemantics::RayDistance),
        );
        assert_eq!(
            project_raster_sample(&distorted, 1.0, 1.0, Some(1.0)),
            Err(RasterProjectionError::UnsupportedCameraModel)
        );
        assert_eq!(
            project_raster_sample(&distorted, -0.6, 1.0, Some(1.0)),
            Err(RasterProjectionError::PixelOutsideImage)
        );
    }
}
