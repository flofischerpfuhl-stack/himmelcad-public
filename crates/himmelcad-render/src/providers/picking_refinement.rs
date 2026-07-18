//! Exact provider-local refinement of shared GPU pick primitive identifiers.

use std::sync::Arc;
use thiserror::Error;

use himmelcad_core::entity_model::RasterCellDiagonal;

use super::{
    DecodedElevationRaster, DecodedGaussianSplats, DecodedPotreePoints, ElevationRasterInput,
    PotreeAttributeLayout, PotreeAttributeType, PotreeDecodeError, PotreePointLayout,
    RasterGridMapping, RasterSurfaceTopology,
};
use crate::{PickCandidate, PickRefinementRequest, SnapKind, WorldRay, WorldVec3};

/// Restores one exact Potree source point from its portable GPU primitive index.
pub fn potree_point_world_position(
    layout: &PotreePointLayout,
    bytes: &[u8],
    point_count: u64,
    point_index: u64,
) -> Result<Option<WorldVec3>, PotreeDecodeError> {
    if !layout.encoding.eq_ignore_ascii_case("DEFAULT")
        && !layout.encoding.eq_ignore_ascii_case("UNCOMPRESSED")
    {
        return Err(PotreeDecodeError::UnsupportedEncoding(
            layout.encoding.clone(),
        ));
    }
    let count = usize::try_from(point_count).map_err(|_| PotreeDecodeError::TooManyPoints)?;
    if count > u32::MAX as usize {
        return Err(PotreeDecodeError::TooManyPoints);
    }
    let expected_size = count
        .checked_mul(layout.stride)
        .ok_or(PotreeDecodeError::PayloadSize)?;
    if bytes.len() != expected_size {
        return Err(PotreeDecodeError::PayloadSize);
    }
    let Some(index) = usize::try_from(point_index)
        .ok()
        .filter(|index| *index < count)
    else {
        return Ok(None);
    };
    let position = position_attribute(layout)?;
    let record_start = index
        .checked_mul(layout.stride)
        .ok_or(PotreeDecodeError::PayloadSize)?;
    let record = &bytes[record_start..record_start + layout.stride];
    let coordinate_bytes = &record[position.byte_offset..position.byte_offset + 12];
    let mut coordinate = [0.0_f64; 3];
    for (axis, target) in coordinate.iter_mut().enumerate() {
        let start = axis * 4;
        let quantized = i32::from_le_bytes(
            coordinate_bytes[start..start + 4]
                .try_into()
                .expect("validated Potree coordinate size"),
        );
        *target = f64::from(quantized) * layout.scale[axis] + layout.offset[axis];
    }
    if coordinate.iter().any(|value| !value.is_finite()) {
        return Err(PotreeDecodeError::CoordinateRange);
    }
    Ok(Some(WorldVec3 {
        x: coordinate[0],
        y: coordinate[1],
        z: coordinate[2],
    }))
}

/// Replaces one Potree sprite hit with its exact source point and point index.
pub fn refine_potree_point_pick(
    request: PickRefinementRequest<'_>,
    layout: &PotreePointLayout,
    bytes: &[u8],
    point_count: u64,
) -> Result<Vec<PickCandidate>, PotreeDecodeError> {
    let Some(point_index) = request.coarse.address.primitive_id else {
        return Ok(Vec::new());
    };
    let Some(position) = potree_point_world_position(layout, bytes, point_count, point_index)?
    else {
        return Ok(Vec::new());
    };
    let mut candidates = Vec::with_capacity(1);
    push_projected_candidate(&mut candidates, request, position, SnapKind::Point);
    Ok(candidates)
}

/// Refines a Potree primitive from the already decoded worker artifact. This
/// is the resident path for BROTLI nodes whose source bytes are Morton/SoA
/// compressed rather than random-access point records.
pub fn refine_decoded_potree_point_pick(
    request: PickRefinementRequest<'_>,
    decoded: &DecodedPotreePoints,
) -> Vec<PickCandidate> {
    let Some(point_index) = request.coarse.address.primitive_id else {
        return Vec::new();
    };
    let Some(position) = usize::try_from(point_index)
        .ok()
        .and_then(|index| decoded.positions.get(index))
    else {
        return Vec::new();
    };
    let position = WorldVec3 {
        x: decoded.world_origin.x + f64::from(position[0]),
        y: decoded.world_origin.y + f64::from(position[1]),
        z: decoded.world_origin.z + f64::from(position[2]),
    };
    let mut candidates = Vec::with_capacity(1);
    push_projected_candidate(&mut candidates, request, position, SnapKind::Point);
    candidates
}

fn position_attribute(
    layout: &PotreePointLayout,
) -> Result<&PotreeAttributeLayout, PotreeDecodeError> {
    let position = layout
        .attributes
        .iter()
        .find(|attribute| {
            attribute.name.eq_ignore_ascii_case("position")
                || attribute.name.eq_ignore_ascii_case("POSITION_CARTESIAN")
        })
        .ok_or(PotreeDecodeError::PositionAttribute)?;
    if position.attribute_type != PotreeAttributeType::Int32
        || position.component_count != 3
        || position.byte_size != 12
        || position
            .byte_offset
            .checked_add(12)
            .is_none_or(|end| end > layout.stride)
    {
        return Err(PotreeDecodeError::PositionAttribute);
    }
    Ok(position)
}

/// Exact provider source addressed by one Gaussian GPU primitive identifier.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GaussianSplatPickSource {
    /// Zero-based PLY vertex and GPU primitive identifier.
    pub primitive_index: u32,
    /// Authoritative f64 PLY mean in project-world coordinates.
    pub world_position: WorldVec3,
    /// Decoded positive one-sigma local-axis radii used by the GPU.
    pub scale: [f32; 3],
    /// Decoded normalized XYZW local-to-world quaternion used by the GPU.
    pub rotation: [f32; 4],
    /// Decoded linear/source RGB and opacity bytes used by the GPU.
    pub color: [u8; 4],
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct GaussianSplatPickShape {
    scale: [f32; 3],
    rotation: [f32; 4],
    color: [u8; 4],
}

/// Invalid pairing of authoritative PLY positions and decoded GPU splats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum GaussianSplatPickError {
    /// Position and decoded-splat arrays differ or exceed portable addressing.
    #[error("Gaussian pick source dimensions do not match")]
    GeometryMismatch,
    /// Source positions or decoded shape values are non-finite or invalid.
    #[error("Gaussian pick source contains an invalid value")]
    InvalidValue,
}

/// O(1) resident Gaussian primitive refiner with authoritative f64 means.
#[derive(Debug, Clone)]
pub struct GaussianSplatPickRefiner {
    positions: Arc<[WorldVec3]>,
    shapes: Arc<[GaussianSplatPickShape]>,
}

impl GaussianSplatPickRefiner {
    /// Builds an owned primitive index from one completed PLY decode.
    pub fn from_decoded(decoded: &DecodedGaussianSplats) -> Result<Self, GaussianSplatPickError> {
        if decoded.source_positions.len() != decoded.splats.len()
            || decoded.splats.len() > u32::MAX as usize
        {
            return Err(GaussianSplatPickError::GeometryMismatch);
        }
        let positions = Arc::clone(&decoded.source_positions);
        let shapes = decoded
            .splats
            .iter()
            .zip(positions.iter())
            .map(|(splat, position)| {
                let position = [position.x, position.y, position.z];
                let rotation_length_squared = splat
                    .rotation
                    .iter()
                    .map(|value| value * value)
                    .sum::<f32>();
                if position.iter().any(|value| !value.is_finite())
                    || splat
                        .scale
                        .iter()
                        .any(|value| !value.is_finite() || *value <= 0.0)
                    || splat.rotation.iter().any(|value| !value.is_finite())
                    || !rotation_length_squared.is_finite()
                    || rotation_length_squared <= f32::EPSILON
                {
                    return Err(GaussianSplatPickError::InvalidValue);
                }
                Ok(GaussianSplatPickShape {
                    scale: splat.scale,
                    rotation: splat.rotation,
                    color: splat.color,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            positions,
            shapes: shapes.into(),
        })
    }

    /// Complete retained provider index memory, excluding `Arc` headers.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        usize_to_u64(self.positions.len())
            .saturating_mul(u64::try_from(std::mem::size_of::<WorldVec3>()).unwrap_or(u64::MAX))
            .saturating_add(usize_to_u64(self.shapes.len()).saturating_mul(
                u64::try_from(std::mem::size_of::<GaussianSplatPickShape>()).unwrap_or(u64::MAX),
            ))
    }

    /// Resolves one GPU primitive to its exact PLY mean and decoded shape.
    #[must_use]
    pub fn source(&self, primitive_index: u64) -> Option<GaussianSplatPickSource> {
        let index = usize::try_from(primitive_index).ok()?;
        let shape = *self.shapes.get(index)?;
        Some(GaussianSplatPickSource {
            primitive_index: u32::try_from(index).ok()?,
            world_position: *self.positions.get(index)?,
            scale: shape.scale,
            rotation: shape.rotation,
            color: shape.color,
        })
    }

    /// Replaces one covered GPU sprite with its exact mean and visual coverage point.
    ///
    /// The coverage point lies on the same constant-center-depth plane as the
    /// GPU sprite. Its screen coordinate is the cursor while inside the 3-sigma
    /// projected ellipse, or a radial ellipse-boundary point within tolerance.
    #[must_use]
    pub fn refine(&self, request: PickRefinementRequest<'_>) -> Vec<PickCandidate> {
        let Some(primitive_index) = request.coarse.address.primitive_id else {
            return Vec::new();
        };
        let Some(source) = self.source(primitive_index) else {
            return Vec::new();
        };
        let mut candidates = Vec::with_capacity(2);
        if let Some(center) = projected_candidate(request, source.world_position, SnapKind::Point) {
            candidates.push(center);
        }
        if let Some(coverage) = gaussian_coverage_candidate(request, source) {
            candidates.push(coverage);
        }
        candidates
    }
}

fn gaussian_coverage_candidate(
    request: PickRefinementRequest<'_>,
    source: GaussianSplatPickSource,
) -> Option<PickCandidate> {
    if source.color[3] == 0 {
        return None;
    }
    let presented_center = request.present_source(source.world_position)?;
    let center = request
        .camera
        .project_world(presented_center, request.viewport)
        .ok()?;
    let rotation = glam::DQuat::from_xyzw(
        f64::from(source.rotation[0]),
        f64::from(source.rotation[1]),
        f64::from(source.rotation[2]),
        f64::from(source.rotation[3]),
    )
    .normalize();
    let axes = [
        rotation * glam::DVec3::new(f64::from(source.scale[0]), 0.0, 0.0),
        rotation * glam::DVec3::new(0.0, f64::from(source.scale[1]), 0.0),
        rotation * glam::DVec3::new(0.0, 0.0, f64::from(source.scale[2])),
    ];
    let projected_axes = axes.map(|axis| {
        let source_endpoint = WorldVec3 {
            x: source.world_position.x + axis.x,
            y: source.world_position.y + axis.y,
            z: source.world_position.z + axis.z,
        };
        let endpoint = request
            .present_source(source_endpoint)
            .and_then(|endpoint| {
                request
                    .camera
                    .project_world(endpoint, request.viewport)
                    .ok()
            });
        endpoint.map(|endpoint| {
            [
                endpoint.pixel[0] - center.pixel[0],
                endpoint.pixel[1] - center.pixel[1],
            ]
        })
    });
    let projected_axes = [projected_axes[0]?, projected_axes[1]?, projected_axes[2]?];
    let horizontal_variance = projected_axes
        .iter()
        .map(|axis| axis[0] * axis[0])
        .sum::<f64>()
        + 0.25;
    let cross_covariance = projected_axes
        .iter()
        .map(|axis| axis[0] * axis[1])
        .sum::<f64>();
    let vertical_variance = projected_axes
        .iter()
        .map(|axis| axis[1] * axis[1])
        .sum::<f64>()
        + 0.25;
    let trace = horizontal_variance + vertical_variance;
    let discriminant = ((horizontal_variance - vertical_variance).mul_add(
        horizontal_variance - vertical_variance,
        4.0 * cross_covariance * cross_covariance,
    ))
    .max(0.0)
    .sqrt();
    let eigenvalue_1 = (0.5 * (trace + discriminant)).max(0.25);
    let eigenvalue_2 = (0.5 * (trace - discriminant)).max(0.25);
    let eigenvector_1 = if cross_covariance.abs() > 1.0e-12 {
        glam::DVec2::new(eigenvalue_1 - vertical_variance, cross_covariance).normalize()
    } else if vertical_variance > horizontal_variance {
        glam::DVec2::Y
    } else {
        glam::DVec2::X
    };
    let eigenvector_2 = glam::DVec2::new(-eigenvector_1.y, eigenvector_1.x);
    let cursor_offset = glam::DVec2::new(
        request.cursor_pixel[0] - center.pixel[0],
        request.cursor_pixel[1] - center.pixel[1],
    );
    let normalized = glam::DVec2::new(
        cursor_offset.dot(eigenvector_1) / eigenvalue_1.sqrt(),
        cursor_offset.dot(eigenvector_2) / eigenvalue_2.sqrt(),
    );
    let sigma_radius = normalized.length();
    let coverage_pixel = if sigma_radius <= 3.0 {
        glam::DVec2::from_array(request.cursor_pixel)
    } else {
        let boundary = normalized / sigma_radius * 3.0;
        glam::DVec2::from_array(center.pixel)
            + eigenvector_1 * boundary.x * eigenvalue_1.sqrt()
            + eigenvector_2 * boundary.y * eigenvalue_2.sqrt()
    };
    let pixel_distance = coverage_pixel.distance(glam::DVec2::from_array(request.cursor_pixel));
    if !pixel_distance.is_finite() || pixel_distance > request.pixel_tolerance {
        return None;
    }
    let presented_world_position = request
        .camera
        .unproject_pixel(
            coverage_pixel.to_array(),
            center.reverse_z_depth,
            request.viewport,
        )
        .ok()?;
    let project_position = request
        .presentation_transform
        .source(presented_world_position);
    projected_candidate(
        request,
        request.source_from_project(project_position)?,
        SnapKind::Surface,
    )
}

/// Why one raster GPU triangle exists in the source elevation grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElevationRasterPickPrimitiveKind {
    /// Three connected elevation samples form an interpolated height-field triangle.
    ContinuousTriangle {
        /// Row-major source sample indices in rendered winding order.
        sample_indices: [u32; 3],
    },
    /// One half of a disconnected, constant-height pixel footprint.
    PixelSampleTriangle {
        /// Row-major source pixel/sample index.
        sample_index: u32,
        /// Triangle zero or one inside the four-corner footprint.
        triangle_in_sample: u8,
    },
}

/// Exact f64 source triangle addressed by one raster GPU primitive identifier.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ElevationRasterPickPrimitive {
    /// Compact GPU triangle identifier.
    pub primitive_index: u32,
    /// Provider semantics retained across mesh construction.
    pub kind: ElevationRasterPickPrimitiveKind,
    /// Project-world triangle vertices in rendered winding order.
    pub vertices: [WorldVec3; 3],
}

/// Exact source sample coordinate independent from the generated triangle mesh.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ElevationRasterSample {
    /// Row-major source sample identifier.
    pub sample_index: u32,
    /// Zero-based source column.
    pub column: u32,
    /// Zero-based source row.
    pub row: u32,
    /// Project-world sample coordinate; pixel-step samples use their cell center.
    pub world_position: WorldVec3,
}

/// Invalid pairing of exact raster source bands and their decoded GPU mesh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ElevationRasterPickError {
    /// Dimensions, bands or decoded mesh metadata disagree.
    #[error("raster pick source dimensions or bands do not match")]
    BandSize,
    /// A source mapping or valid elevation is non-finite.
    #[error("raster pick source contains a non-finite coordinate")]
    NonFinite,
    /// Decoded triangle indices cannot be resolved to the declared source topology.
    #[error("raster pick triangles do not match source topology")]
    GeometryMismatch,
    /// Grid dimensions exceed portable row-major sample addressing.
    #[error("raster pick source exceeds portable sample addressing")]
    TooLarge,
}

/// O(1) raster primitive refiner built once when a decoded tile becomes resident.
#[derive(Debug, Clone)]
pub struct ElevationRasterPickRefiner {
    width: u32,
    height: u32,
    mapping: RasterGridMapping,
    topology: RasterSurfaceTopology,
    elevations: Arc<[f64]>,
    triangle_mask: Option<Arc<[u8]>>,
    continuous_triangles: Vec<u64>,
    pixel_step_samples: Vec<u32>,
}

impl ElevationRasterPickRefiner {
    /// Validates one exact source/decoded-mesh pair and prepares pixel-step lookup.
    pub fn new(
        input: ElevationRasterInput<'_>,
        raster: &DecodedElevationRaster,
    ) -> Result<Self, ElevationRasterPickError> {
        let count = sample_count(input.width, input.height)?;
        if input.elevations.len() != count
            || input.rgba8.len() != count.saturating_mul(4)
            || raster.width != input.width
            || raster.height != input.height
            || !source_elevations_match(&raster.source_elevations, input.elevations)
            || !raster.indices.len().is_multiple_of(3)
        {
            return Err(ElevationRasterPickError::BandSize);
        }
        validate_grid(input.mapping, input.elevations)?;
        Self::from_decoded(input.mapping, input.topology, input.triangle_mask, raster)
    }

    /// Builds an owned index from source elevations retained by the completed decoder.
    pub fn from_decoded(
        mapping: RasterGridMapping,
        topology: RasterSurfaceTopology,
        triangle_mask: Option<&[u8]>,
        raster: &DecodedElevationRaster,
    ) -> Result<Self, ElevationRasterPickError> {
        let count = sample_count(raster.width, raster.height)?;
        if raster.rgba8.len() != count.saturating_mul(4)
            || raster.source_elevations.len() != count
            || !raster.indices.len().is_multiple_of(3)
        {
            return Err(ElevationRasterPickError::BandSize);
        }
        validate_compact_grid(mapping, &raster.source_elevations)?;
        if raster.indices.iter().any(|index| {
            usize::try_from(*index)
                .ok()
                .is_none_or(|index| index >= raster.vertices.len())
        }) {
            return Err(ElevationRasterPickError::GeometryMismatch);
        }
        let triangle_mask =
            validate_triangle_mask(raster.width, raster.height, topology, triangle_mask)?;
        let (continuous_triangles, pixel_step_samples) = match topology {
            RasterSurfaceTopology::Continuous { diagonal, .. } => (
                continuous_triangle_sources(
                    raster.width,
                    raster.height,
                    diagonal,
                    &raster.indices,
                )?,
                Vec::new(),
            ),
            RasterSurfaceTopology::PixelSteps => (
                Vec::new(),
                raster
                    .source_elevations
                    .iter()
                    .enumerate()
                    .filter(|(_, elevation)| elevation.is_finite())
                    .map(|(index, _)| {
                        u32::try_from(index).map_err(|_| ElevationRasterPickError::TooLarge)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        };
        if continuous_triangles.iter().any(|source| {
            triangle_mask
                .as_deref()
                .is_some_and(|mask| !lsb0_mask_bit(mask, *source))
        }) {
            return Err(ElevationRasterPickError::GeometryMismatch);
        }
        if matches!(topology, RasterSurfaceTopology::PixelSteps)
            && raster.indices.len() / 6 != pixel_step_samples.len()
        {
            return Err(ElevationRasterPickError::GeometryMismatch);
        }
        Ok(Self {
            width: raster.width,
            height: raster.height,
            mapping,
            topology,
            elevations: Arc::clone(&raster.source_elevations),
            triangle_mask,
            continuous_triangles,
            pixel_step_samples,
        })
    }

    /// Complete retained CPU bytes used by the exact resident pick index.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        usize_to_u64(self.elevations.len())
            .saturating_mul(8)
            .saturating_add(
                self.triangle_mask
                    .as_ref()
                    .map_or(0, |mask| usize_to_u64(mask.len())),
            )
            .saturating_add(usize_to_u64(self.continuous_triangles.len()).saturating_mul(8))
            .saturating_add(usize_to_u64(self.pixel_step_samples.len()).saturating_mul(4))
    }

    /// Exact immutable grid retained for measurement and associative draping.
    /// Invalid/NoData samples are represented by `NaN` and must never be
    /// interpolated across by callers.
    #[must_use]
    pub fn source_grid(
        &self,
    ) -> (
        u32,
        u32,
        RasterGridMapping,
        RasterSurfaceTopology,
        &[f64],
        Option<&[u8]>,
    ) {
        (
            self.width,
            self.height,
            self.mapping,
            self.topology,
            &self.elevations,
            self.triangle_mask.as_deref(),
        )
    }

    /// Resolves one row-major source sample, preserving topology-specific placement.
    #[must_use]
    pub fn sample(&self, sample_index: u32) -> Option<ElevationRasterSample> {
        let index = usize::try_from(sample_index).ok()?;
        let elevation = *self.elevations.get(index)?;
        if !elevation.is_finite() {
            return None;
        }
        let width = usize::try_from(self.width).ok()?;
        let column = u32::try_from(index % width).ok()?;
        let row = u32::try_from(index / width).ok()?;
        let xy = world_xy(self.mapping, f64::from(column), f64::from(row));
        Some(ElevationRasterSample {
            sample_index,
            column,
            row,
            world_position: WorldVec3 {
                x: xy[0],
                y: xy[1],
                z: elevation,
            },
        })
    }

    /// Resolves a compact GPU primitive into its exact source triangle in O(1).
    #[must_use]
    pub fn primitive(&self, primitive_index: u64) -> Option<ElevationRasterPickPrimitive> {
        let primitive = usize::try_from(primitive_index).ok()?;
        let primitive_index = u32::try_from(primitive).ok()?;
        match self.topology {
            RasterSurfaceTopology::Continuous { diagonal, .. } => {
                let source_triangle = *self.continuous_triangles.get(primitive)?;
                let cell = source_triangle / 2;
                let triangle_in_cell = source_triangle % 2;
                let cells_per_row = u64::from(self.width.checked_sub(1)?);
                let row = cell / cells_per_row;
                let column = cell % cells_per_row;
                if row >= u64::from(self.height.checked_sub(1)?) {
                    return None;
                }
                let a = row
                    .checked_mul(u64::from(self.width))?
                    .checked_add(column)?;
                let b = a.checked_add(1)?;
                let c = a.checked_add(u64::from(self.width))?;
                let d = c.checked_add(1)?;
                let values = match (diagonal, triangle_in_cell) {
                    (RasterCellDiagonal::TopLeftToBottomRight, 0) => [a, b, d],
                    (RasterCellDiagonal::TopLeftToBottomRight, _) => [a, d, c],
                    (RasterCellDiagonal::TopRightToBottomLeft, 0) => [a, b, c],
                    (RasterCellDiagonal::TopRightToBottomLeft, _) => [b, d, c],
                };
                let sample_indices = [
                    u32::try_from(values[0]).ok()?,
                    u32::try_from(values[1]).ok()?,
                    u32::try_from(values[2]).ok()?,
                ];
                let vertices = sample_indices
                    .map(|index| self.sample(index).map(|sample| sample.world_position));
                Some(ElevationRasterPickPrimitive {
                    primitive_index,
                    kind: ElevationRasterPickPrimitiveKind::ContinuousTriangle { sample_indices },
                    vertices: [vertices[0]?, vertices[1]?, vertices[2]?],
                })
            }
            RasterSurfaceTopology::PixelSteps => {
                let sample_index = *self.pixel_step_samples.get(primitive / 2)?;
                let triangle_in_sample = u8::try_from(primitive % 2).ok()?;
                let sample = self.sample(sample_index)?;
                let corners = pixel_corners(
                    self.mapping,
                    sample.column,
                    sample.row,
                    sample.world_position.z,
                );
                let vertices = if triangle_in_sample == 0 {
                    [corners[0], corners[1], corners[2]]
                } else {
                    [corners[0], corners[2], corners[3]]
                };
                Some(ElevationRasterPickPrimitive {
                    primitive_index,
                    kind: ElevationRasterPickPrimitiveKind::PixelSampleTriangle {
                        sample_index,
                        triangle_in_sample,
                    },
                    vertices,
                })
            }
        }
    }

    /// Refines a raster triangle hit while preserving continuous vs. pixel-step semantics.
    #[must_use]
    pub fn refine(&self, request: PickRefinementRequest<'_>) -> Vec<PickCandidate> {
        let Some(primitive_index) = request.coarse.address.primitive_id else {
            return Vec::new();
        };
        let Some(primitive) = self.primitive(primitive_index) else {
            return Vec::new();
        };
        let mut candidates = Vec::with_capacity(4);
        let Some(source_ray) = request.source_ray() else {
            return Vec::new();
        };
        if let Some(position) = ray_triangle(source_ray, primitive.vertices) {
            let kind = match primitive.kind {
                ElevationRasterPickPrimitiveKind::ContinuousTriangle { .. } => SnapKind::Surface,
                ElevationRasterPickPrimitiveKind::PixelSampleTriangle { .. } => {
                    SnapKind::RasterSample
                }
            };
            push_projected_candidate(&mut candidates, request, position, kind);
        }
        match primitive.kind {
            ElevationRasterPickPrimitiveKind::ContinuousTriangle { sample_indices } => {
                for sample_index in sample_indices {
                    if let Some(sample) = self.sample(sample_index) {
                        push_projected_candidate(
                            &mut candidates,
                            request,
                            sample.world_position,
                            SnapKind::RasterSample,
                        );
                    }
                }
            }
            ElevationRasterPickPrimitiveKind::PixelSampleTriangle { sample_index, .. } => {
                if let Some(sample) = self.sample(sample_index) {
                    push_projected_candidate(
                        &mut candidates,
                        request,
                        sample.world_position,
                        SnapKind::RasterSample,
                    );
                }
            }
        }
        candidates
    }
}

fn validate_triangle_mask(
    width: u32,
    height: u32,
    topology: RasterSurfaceTopology,
    mask: Option<&[u8]>,
) -> Result<Option<Arc<[u8]>>, ElevationRasterPickError> {
    let Some(mask) = mask else { return Ok(None) };
    if matches!(topology, RasterSurfaceTopology::PixelSteps) {
        return Err(ElevationRasterPickError::GeometryMismatch);
    }
    let bits = usize::try_from(width.saturating_sub(1))
        .ok()
        .and_then(|width| {
            usize::try_from(height.saturating_sub(1))
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|cells| cells.checked_mul(2))
        .ok_or(ElevationRasterPickError::TooLarge)?;
    let bytes = bits
        .checked_add(7)
        .map(|bits| bits / 8)
        .ok_or(ElevationRasterPickError::TooLarge)?;
    let remainder = bits % 8;
    if mask.len() != bytes
        || (remainder != 0 && mask.last().is_some_and(|byte| byte >> remainder != 0))
    {
        return Err(ElevationRasterPickError::GeometryMismatch);
    }
    Ok(Some(Arc::from(mask)))
}

fn lsb0_mask_bit(mask: &[u8], bit: u64) -> bool {
    usize::try_from(bit).ok().is_some_and(|bit| {
        mask.get(bit / 8)
            .is_some_and(|byte| byte & (1_u8 << (bit % 8)) != 0)
    })
}

fn continuous_triangle_sources(
    width: u32,
    height: u32,
    diagonal: RasterCellDiagonal,
    indices: &[u32],
) -> Result<Vec<u64>, ElevationRasterPickError> {
    let cells_per_row = width
        .checked_sub(1)
        .ok_or(ElevationRasterPickError::GeometryMismatch)?;
    let cell_rows = height
        .checked_sub(1)
        .ok_or(ElevationRasterPickError::GeometryMismatch)?;
    let mut sources = Vec::with_capacity(indices.len() / 3);
    for triangle in indices.chunks_exact(3) {
        let (a, triangle_in_cell) = match diagonal {
            RasterCellDiagonal::TopLeftToBottomRight => {
                let a = triangle[0];
                let b = a.checked_add(1).ok_or(ElevationRasterPickError::TooLarge)?;
                let c = a
                    .checked_add(width)
                    .ok_or(ElevationRasterPickError::TooLarge)?;
                let d = c.checked_add(1).ok_or(ElevationRasterPickError::TooLarge)?;
                if triangle == [a, b, d] {
                    (a, 0_u64)
                } else if triangle == [a, d, c] {
                    (a, 1)
                } else {
                    return Err(ElevationRasterPickError::GeometryMismatch);
                }
            }
            RasterCellDiagonal::TopRightToBottomLeft => {
                let first = triangle[0];
                let direct_b = first
                    .checked_add(1)
                    .ok_or(ElevationRasterPickError::TooLarge)?;
                let direct_c = first
                    .checked_add(width)
                    .ok_or(ElevationRasterPickError::TooLarge)?;
                if triangle == [first, direct_b, direct_c] {
                    (first, 0_u64)
                } else {
                    let a = first
                        .checked_sub(1)
                        .ok_or(ElevationRasterPickError::GeometryMismatch)?;
                    let c = a
                        .checked_add(width)
                        .ok_or(ElevationRasterPickError::TooLarge)?;
                    let d = first
                        .checked_add(width)
                        .ok_or(ElevationRasterPickError::TooLarge)?;
                    if triangle != [first, d, c] {
                        return Err(ElevationRasterPickError::GeometryMismatch);
                    }
                    (a, 1)
                }
            }
        };
        let row = a / width;
        let column = a % width;
        if row >= cell_rows || column >= cells_per_row {
            return Err(ElevationRasterPickError::GeometryMismatch);
        }
        let cell = u64::from(row)
            .checked_mul(u64::from(cells_per_row))
            .and_then(|value| value.checked_add(u64::from(column)))
            .ok_or(ElevationRasterPickError::TooLarge)?;
        sources.push(
            cell.checked_mul(2)
                .and_then(|value| value.checked_add(triangle_in_cell))
                .ok_or(ElevationRasterPickError::TooLarge)?,
        );
    }
    Ok(sources)
}

fn validate_grid(
    mapping: RasterGridMapping,
    elevations: &[Option<f64>],
) -> Result<(), ElevationRasterPickError> {
    let values = [
        mapping.origin[0],
        mapping.origin[1],
        mapping.column_step[0],
        mapping.column_step[1],
        mapping.row_step[0],
        mapping.row_step[1],
    ];
    if values.iter().any(|value| !value.is_finite())
        || elevations.iter().flatten().any(|value| !value.is_finite())
    {
        return Err(ElevationRasterPickError::NonFinite);
    }
    let determinant =
        mapping.column_step[0] * mapping.row_step[1] - mapping.column_step[1] * mapping.row_step[0];
    if !determinant.is_finite() || determinant.abs() <= f64::EPSILON {
        return Err(ElevationRasterPickError::GeometryMismatch);
    }
    Ok(())
}

fn validate_compact_grid(
    mapping: RasterGridMapping,
    elevations: &[f64],
) -> Result<(), ElevationRasterPickError> {
    let values = [
        mapping.origin[0],
        mapping.origin[1],
        mapping.column_step[0],
        mapping.column_step[1],
        mapping.row_step[0],
        mapping.row_step[1],
    ];
    if values.iter().any(|value| !value.is_finite())
        || elevations.iter().any(|value| value.is_infinite())
    {
        return Err(ElevationRasterPickError::NonFinite);
    }
    let determinant =
        mapping.column_step[0] * mapping.row_step[1] - mapping.column_step[1] * mapping.row_step[0];
    if !determinant.is_finite() || determinant.abs() <= f64::EPSILON {
        return Err(ElevationRasterPickError::GeometryMismatch);
    }
    Ok(())
}

#[allow(clippy::float_cmp)]
fn source_elevations_match(compact: &[f64], elevations: &[Option<f64>]) -> bool {
    compact.len() == elevations.len()
        && compact.iter().zip(elevations).all(|(compact, elevation)| {
            elevation.map_or_else(|| compact.is_nan(), |elevation| *compact == elevation)
        })
}

fn sample_count(width: u32, height: u32) -> Result<usize, ElevationRasterPickError> {
    if width == 0 || height == 0 {
        return Err(ElevationRasterPickError::BandSize);
    }
    usize::try_from(u64::from(width) * u64::from(height))
        .map_err(|_| ElevationRasterPickError::TooLarge)
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn pixel_corners(
    mapping: RasterGridMapping,
    column: u32,
    row: u32,
    elevation: f64,
) -> [WorldVec3; 4] {
    [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)].map(|(column_offset, row_offset)| {
        let xy = world_xy(
            mapping,
            f64::from(column) + column_offset,
            f64::from(row) + row_offset,
        );
        WorldVec3 {
            x: xy[0],
            y: xy[1],
            z: elevation,
        }
    })
}

fn world_xy(mapping: RasterGridMapping, column: f64, row: f64) -> [f64; 2] {
    [
        mapping.origin[0] + mapping.column_step[0] * column + mapping.row_step[0] * row,
        mapping.origin[1] + mapping.column_step[1] * column + mapping.row_step[1] * row,
    ]
}

fn ray_triangle(ray: WorldRay, vertices: [WorldVec3; 3]) -> Option<WorldVec3> {
    let origin = vector(ray.origin);
    let direction = vector(ray.direction);
    let first = vector(vertices[0]);
    let edge_a = vector(vertices[1]) - first;
    let edge_b = vector(vertices[2]) - first;
    let cross = direction.cross(edge_b);
    let determinant = edge_a.dot(cross);
    let scale = edge_a.length().max(edge_b.length()).max(1.0);
    if determinant.abs() <= f64::EPSILON * scale * scale {
        return None;
    }
    let inverse = determinant.recip();
    let offset = origin - first;
    let u = offset.dot(cross) * inverse;
    if !(-f64::EPSILON..=1.0 + f64::EPSILON).contains(&u) {
        return None;
    }
    let q = offset.cross(edge_a);
    let v = direction.dot(q) * inverse;
    if v < -f64::EPSILON || u + v > 1.0 + f64::EPSILON {
        return None;
    }
    let distance = edge_b.dot(q) * inverse;
    if !distance.is_finite() || distance < 0.0 {
        return None;
    }
    let position = origin + direction * distance;
    Some(WorldVec3 {
        x: position.x,
        y: position.y,
        z: position.z,
    })
}

#[allow(clippy::cast_possible_truncation)]
fn projected_candidate(
    request: PickRefinementRequest<'_>,
    position: WorldVec3,
    snap_kind: SnapKind,
) -> Option<PickCandidate> {
    let project_position = request.project_source(position)?;
    let presented = request.presentation_transform.present(project_position);
    let projected = request
        .camera
        .project_world(presented, request.viewport)
        .ok()?;
    let pixel_distance = (projected.pixel[0] - request.cursor_pixel[0])
        .hypot(projected.pixel[1] - request.cursor_pixel[1]);
    if !pixel_distance.is_finite() {
        return None;
    }
    Some(PickCandidate {
        address: request.coarse.address.clone(),
        world_position: project_position,
        snap_kind,
        pixel_distance: pixel_distance as f32,
        depth: (1.0 - projected.reverse_z_depth) as f32,
    })
}

fn push_projected_candidate(
    candidates: &mut Vec<PickCandidate>,
    request: PickRefinementRequest<'_>,
    position: WorldVec3,
    snap_kind: SnapKind,
) {
    let Some(candidate) = projected_candidate(request, position, snap_kind) else {
        return;
    };
    if f64::from(candidate.pixel_distance) <= request.pixel_tolerance {
        candidates.push(candidate);
    }
}

fn vector(value: WorldVec3) -> glam::DVec3 {
    glam::DVec3::new(value.x, value.y, value.z)
}

#[cfg(test)]
mod tests {
    use himmelcad_core::entity_model::RasterCellDiagonal;

    use super::{
        potree_point_world_position, refine_potree_point_pick, ElevationRasterPickPrimitiveKind,
        ElevationRasterPickRefiner, GaussianSplatPickRefiner,
    };
    use crate::{
        decode_elevation_raster, decode_gaussian_splat_ply, CameraFrame, CameraProjection,
        ElevationRasterInput, PickAddress, PickCandidate, PickRefinementRequest,
        PotreeAttributeLayout, PotreeAttributeType, PotreePointLayout, PresentationTransform,
        RasterGridMapping, RasterSurfaceTopology, SnapKind, WorldCamera, WorldVec3,
    };

    #[test]
    fn potree_primitive_index_restores_exact_quantized_f64_world_point() {
        let layout = point_layout();
        let bytes = point_payload();
        let point = potree_point_world_position(&layout, &bytes, 2, 1)
            .expect("valid payload")
            .expect("point index");
        assert_eq!(point.x, 500_000.123_456);
        assert_eq!(point.y, 5_400_000.654_321);
        assert_eq!(point.z, 101.234_567);

        let camera = camera(point);
        let projected = camera.project_world(point, [1_000, 800]).expect("project");
        let coarse = candidate(1, point);
        let refined = refine_potree_point_pick(
            refinement_request(&coarse, &camera, projected.pixel, 8.0),
            &layout,
            &bytes,
            2,
        )
        .expect("refine");
        assert_eq!(refined.len(), 1);
        assert_eq!(refined[0].address.primitive_id, Some(1));
        assert_eq!(refined[0].world_position, point);
        assert_eq!(refined[0].snap_kind, SnapKind::Point);
    }

    #[test]
    fn exaggerated_potree_pick_returns_authoritative_source_height() {
        let layout = point_layout();
        let bytes = point_payload();
        let source = potree_point_world_position(&layout, &bytes, 2, 1)
            .expect("valid payload")
            .expect("point index");
        let presentation = PresentationTransform::new(3.0, 100.0).expect("presentation");
        let presented = presentation.present(source);
        let camera = camera(presented);
        let cursor = camera
            .project_world(presented, [1_000, 800])
            .expect("presented point")
            .pixel;
        let coarse = candidate(1, presented);

        let refined = refine_potree_point_pick(
            refinement_request_with_presentation(&coarse, &camera, cursor, 8.0, presentation),
            &layout,
            &bytes,
            2,
        )
        .expect("refine");
        assert_eq!(refined.len(), 1);
        assert_eq!(refined[0].world_position, source);
        assert_ne!(refined[0].world_position.z, presented.z);
        assert!(refined[0].pixel_distance < f32::EPSILON);
    }

    #[test]
    fn continuous_raster_pick_retains_triangle_and_sample_semantics() {
        let elevations = [Some(10.0), Some(20.0), Some(30.0), Some(40.0)];
        let mapping = RasterGridMapping {
            origin: [500_000.0, 5_400_000.0],
            column_step: [2.0, 1.0],
            row_step: [-1.0, 2.0],
        };
        let input = raster_input(
            2,
            2,
            &elevations,
            mapping,
            RasterSurfaceTopology::Continuous {
                maximum_height_jump: None,
                diagonal: RasterCellDiagonal::TopLeftToBottomRight,
            },
        );
        let decoded = decode_elevation_raster(
            input,
            WorldVec3 {
                x: 500_000.0,
                y: 5_400_000.0,
                z: 0.0,
            },
        )
        .expect("decode");
        let refiner = ElevationRasterPickRefiner::new(input, &decoded).expect("refiner");
        assert_eq!(refiner.resident_bytes(), 48);
        let primitive = refiner.primitive(0).expect("triangle");
        assert_eq!(
            primitive.kind,
            ElevationRasterPickPrimitiveKind::ContinuousTriangle {
                sample_indices: [0, 1, 3],
            }
        );
        assert_eq!(
            primitive.vertices[0],
            WorldVec3 {
                x: 500_000.0,
                y: 5_400_000.0,
                z: 10.0
            }
        );
        assert_eq!(
            primitive.vertices[2],
            WorldVec3 {
                x: 500_001.0,
                y: 5_400_003.0,
                z: 40.0
            }
        );

        let center = average(primitive.vertices);
        let camera = camera(center);
        let projected = camera.project_world(center, [1_000, 800]).expect("project");
        let coarse = candidate(0, center);
        let refined = refiner.refine(refinement_request(
            &coarse,
            &camera,
            projected.pixel,
            1_000.0,
        ));
        assert!(refined
            .iter()
            .any(|candidate| candidate.snap_kind == SnapKind::Surface));
        assert!(refined
            .iter()
            .any(|candidate| candidate.snap_kind == SnapKind::RasterSample));
    }

    #[test]
    fn alternate_raster_diagonal_is_identical_in_geometry_and_exact_pick() {
        let elevations = [Some(10.0), Some(20.0), Some(30.0), Some(40.0)];
        let mapping = RasterGridMapping {
            origin: [0.0, 0.0],
            column_step: [1.0, 0.0],
            row_step: [0.0, 1.0],
        };
        let input = raster_input(
            2,
            2,
            &elevations,
            mapping,
            RasterSurfaceTopology::Continuous {
                maximum_height_jump: None,
                diagonal: RasterCellDiagonal::TopRightToBottomLeft,
            },
        );
        let decoded = decode_elevation_raster(
            input,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("decode");
        assert_eq!(decoded.indices, [0, 1, 2, 1, 3, 2]);

        let refiner = ElevationRasterPickRefiner::new(input, &decoded).expect("refiner");
        assert_eq!(
            refiner.primitive(0).expect("first triangle").kind,
            ElevationRasterPickPrimitiveKind::ContinuousTriangle {
                sample_indices: [0, 1, 2],
            }
        );
        assert_eq!(
            refiner.primitive(1).expect("second triangle").kind,
            ElevationRasterPickPrimitiveKind::ContinuousTriangle {
                sample_indices: [1, 3, 2],
            }
        );
    }

    #[test]
    fn masked_raster_primitive_ids_resolve_only_admitted_source_triangles() {
        let elevations = [Some(10.0), Some(20.0), Some(30.0), Some(40.0)];
        let input = ElevationRasterInput {
            width: 2,
            height: 2,
            rgba8: &[255; 16],
            elevations: &elevations,
            triangle_mask: Some(&[0b0000_0010]),
            mapping: RasterGridMapping {
                origin: [0.0, 0.0],
                column_step: [1.0, 0.0],
                row_step: [0.0, 1.0],
            },
            topology: RasterSurfaceTopology::Continuous {
                maximum_height_jump: None,
                diagonal: RasterCellDiagonal::TopLeftToBottomRight,
            },
        };
        let decoded = decode_elevation_raster(
            input,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("masked decode");
        assert_eq!(decoded.indices, [0, 3, 2]);

        let refiner = ElevationRasterPickRefiner::new(input, &decoded).expect("exact refiner");
        assert_eq!(
            refiner.primitive(0).expect("admitted triangle").kind,
            ElevationRasterPickPrimitiveKind::ContinuousTriangle {
                sample_indices: [0, 3, 2],
            }
        );
        assert!(refiner.primitive(1).is_none());
    }

    #[test]
    fn exaggerated_raster_intersects_in_source_space_and_returns_source_height() {
        let elevations = [Some(10.0), Some(12.0), Some(14.0), Some(16.0)];
        let mapping = RasterGridMapping {
            origin: [500_000.0, 5_400_000.0],
            column_step: [2.0, 0.0],
            row_step: [0.0, 2.0],
        };
        let input = raster_input(
            2,
            2,
            &elevations,
            mapping,
            RasterSurfaceTopology::Continuous {
                maximum_height_jump: None,
                diagonal: RasterCellDiagonal::TopLeftToBottomRight,
            },
        );
        let decoded = decode_elevation_raster(
            input,
            WorldVec3 {
                x: 500_000.0,
                y: 5_400_000.0,
                z: 0.0,
            },
        )
        .expect("decode");
        let refiner = ElevationRasterPickRefiner::new(input, &decoded).expect("refiner");
        let source_center = average(refiner.primitive(0).expect("triangle").vertices);
        let presentation = PresentationTransform::new(4.0, 10.0).expect("presentation");
        let presented_center = presentation.present(source_center);
        let camera = camera(presented_center);
        let cursor = camera
            .project_world(presented_center, [1_000, 800])
            .expect("presented center")
            .pixel;
        let coarse = candidate(0, presented_center);

        let refined = refiner.refine(refinement_request_with_presentation(
            &coarse,
            &camera,
            cursor,
            8.0,
            presentation,
        ));
        let surface = refined
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Surface)
            .expect("source surface");
        assert!((surface.world_position.x - source_center.x).abs() < 1.0e-9);
        assert!((surface.world_position.y - source_center.y).abs() < 1.0e-9);
        assert!((surface.world_position.z - source_center.z).abs() < 1.0e-9);
        assert_ne!(surface.world_position.z, presented_center.z);
        assert!(surface.pixel_distance < f32::EPSILON);
    }

    #[test]
    fn pixel_step_primitive_resolves_original_sample_after_nodata_gap() {
        let elevations = [None, Some(100.0)];
        let mapping = RasterGridMapping {
            origin: [100.0, 200.0],
            column_step: [2.0, 0.0],
            row_step: [0.0, -3.0],
        };
        let input = raster_input(
            2,
            1,
            &elevations,
            mapping,
            RasterSurfaceTopology::PixelSteps,
        );
        let decoded = decode_elevation_raster(
            input,
            WorldVec3 {
                x: 100.0,
                y: 200.0,
                z: 0.0,
            },
        )
        .expect("decode");
        let refiner = ElevationRasterPickRefiner::new(input, &decoded).expect("refiner");
        assert_eq!(refiner.resident_bytes(), 20);
        let primitive = refiner.primitive(1).expect("second triangle");
        assert_eq!(
            primitive.kind,
            ElevationRasterPickPrimitiveKind::PixelSampleTriangle {
                sample_index: 1,
                triangle_in_sample: 1,
            }
        );
        assert!(primitive.vertices.iter().all(|vertex| vertex.z == 100.0));
        assert_eq!(
            refiner.sample(1).expect("sample").world_position,
            WorldVec3 {
                x: 102.0,
                y: 200.0,
                z: 100.0,
            }
        );
        assert_eq!(primitive.vertices[0].x, 101.0);
        assert_eq!(primitive.vertices[0].y, 201.5);
        assert_eq!(primitive.vertices[2].x, 101.0);
        assert_eq!(primitive.vertices[2].y, 198.5);
    }

    #[test]
    fn gaussian_primitive_restores_ecef_mean_and_projected_coverage_without_scan() {
        let ply = b"ply\nformat ascii 1.0\nelement vertex 1\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n6378137.123456789 5400000.234567891 512.345678901 2 1 0.5 0 0 0 1 20 180 240 255\n";
        let decoded = decode_gaussian_splat_ply(ply, 1).expect("decode");
        let refiner = GaussianSplatPickRefiner::from_decoded(&decoded).expect("refiner");
        assert_eq!(refiner.resident_bytes(), 56);
        let source = refiner.source(0).expect("primitive");
        assert_eq!(source.primitive_index, 0);
        assert_eq!(source.world_position.x, 6_378_137.123_456_789);
        assert_eq!(source.world_position.y, 5_400_000.234_567_891);
        assert_eq!(source.world_position.z, 512.345_678_901);
        assert_eq!(source.scale, [2.0, 1.0, 0.5]);
        assert_eq!(source.color, [20, 180, 240, 255]);
        assert!(refiner.source(1).is_none());

        let camera = top_down_camera(source.world_position);
        let coarse = candidate(0, source.world_position);
        let refined = refiner.refine(refinement_request(&coarse, &camera, [508.0, 400.0], 2.0));
        let center = refined
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Point)
            .expect("exact center");
        assert_eq!(center.address.primitive_id, Some(0));
        assert_eq!(center.world_position, source.world_position);
        let coverage = refined
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Surface)
            .expect("ellipse coverage");
        assert!((coverage.world_position.x - (source.world_position.x + 1.0)).abs() < 1.0e-8);
        assert!((coverage.world_position.y - source.world_position.y).abs() < 1.0e-8);
        assert!((coverage.world_position.z - source.world_position.z).abs() < 1.0e-8);
        assert!(coverage.pixel_distance < 1.0e-6);

        let unknown = candidate(7, source.world_position);
        assert!(refiner
            .refine(refinement_request(&unknown, &camera, [500.0, 400.0], 2.0,))
            .is_empty());
    }

    #[test]
    fn exaggerated_gaussian_mean_and_coverage_return_source_coordinates() {
        let ply = b"ply\nformat ascii 1.0\nelement vertex 1\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n6378137.125 5400000.25 503 2 1 0.5 0 0 0 1 20 180 240 255\n";
        let decoded = decode_gaussian_splat_ply(ply, 1).expect("decode");
        let refiner = GaussianSplatPickRefiner::from_decoded(&decoded).expect("refiner");
        let source = refiner.source(0).expect("source").world_position;
        let presentation = PresentationTransform::new(4.0, 500.0).expect("presentation");
        let presented = presentation.present(source);
        let camera = camera(presented);
        let cursor = camera
            .project_world(presented, [1_000, 800])
            .expect("presented mean")
            .pixel;
        let coarse = candidate(0, presented);

        let refined = refiner.refine(refinement_request_with_presentation(
            &coarse,
            &camera,
            cursor,
            8.0,
            presentation,
        ));
        let mean = refined
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Point)
            .expect("source mean");
        let coverage = refined
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Surface)
            .expect("source coverage");
        assert_eq!(mean.world_position, source);
        assert_ne!(mean.world_position.z, presented.z);
        assert!((coverage.world_position.z - source.z).abs() < 1.0e-9);
        assert!(mean.pixel_distance < f32::EPSILON);
        assert!(coverage.pixel_distance < f32::EPSILON);
    }

    fn point_layout() -> PotreePointLayout {
        PotreePointLayout {
            scale: [0.000_001; 3],
            offset: [500_000.0, 5_400_000.0, 100.0],
            encoding: "DEFAULT".to_owned(),
            attributes: vec![PotreeAttributeLayout {
                name: "position".to_owned(),
                attribute_type: PotreeAttributeType::Int32,
                component_count: 3,
                byte_offset: 0,
                byte_size: 12,
            }],
            stride: 12,
        }
    }

    fn point_payload() -> Vec<u8> {
        [[0_i32, 0, 0], [123_456, 654_321, 1_234_567]]
            .into_iter()
            .flatten()
            .flat_map(i32::to_le_bytes)
            .collect()
    }

    fn raster_input<'a>(
        width: u32,
        height: u32,
        elevations: &'a [Option<f64>],
        mapping: RasterGridMapping,
        topology: RasterSurfaceTopology,
    ) -> ElevationRasterInput<'a> {
        ElevationRasterInput {
            width,
            height,
            rgba8: if elevations.len() == 4 {
                &[255; 16]
            } else {
                &[255; 8]
            },
            elevations,
            triangle_mask: None,
            mapping,
            topology,
        }
    }

    fn candidate(primitive_id: u64, world_position: WorldVec3) -> PickCandidate {
        PickCandidate {
            address: PickAddress {
                entity_id: "entity".to_owned(),
                render_proxy_id: "proxy".to_owned(),
                dataset_id: None,
                tile_id: None,
                primitive_id: Some(primitive_id),
            },
            world_position,
            snap_kind: SnapKind::Surface,
            pixel_distance: 0.0,
            depth: 0.5,
        }
    }

    fn camera(target: WorldVec3) -> CameraFrame {
        CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    x: target.x,
                    y: target.y - 20.0,
                    z: target.z + 20.0,
                },
                target,
                up: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
                projection: CameraProjection::Perspective {
                    vertical_fov_radians: 1.0,
                    aspect: 1.25,
                    near: 0.1,
                    far: 1_000.0,
                },
            },
            target,
        )
        .expect("camera")
    }

    fn top_down_camera(target: WorldVec3) -> CameraFrame {
        CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    x: target.x,
                    y: target.y,
                    z: target.z + 100.0,
                },
                target,
                up: WorldVec3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                },
                projection: CameraProjection::Orthographic {
                    vertical_span: 100.0,
                    aspect: 1.25,
                    near: 0.1,
                    far: 1_000.0,
                },
            },
            target,
        )
        .expect("camera")
    }

    fn refinement_request<'a>(
        coarse: &'a PickCandidate,
        camera: &'a CameraFrame,
        cursor_pixel: [f64; 2],
        pixel_tolerance: f64,
    ) -> PickRefinementRequest<'a> {
        refinement_request_with_presentation(
            coarse,
            camera,
            cursor_pixel,
            pixel_tolerance,
            PresentationTransform::IDENTITY,
        )
    }

    fn refinement_request_with_presentation<'a>(
        coarse: &'a PickCandidate,
        camera: &'a CameraFrame,
        cursor_pixel: [f64; 2],
        pixel_tolerance: f64,
        presentation_transform: PresentationTransform,
    ) -> PickRefinementRequest<'a> {
        PickRefinementRequest {
            coarse,
            camera,
            cursor_ray: camera.cursor_ray(cursor_pixel, [1_000, 800]).expect("ray"),
            source_to_project: crate::WorldTransform::IDENTITY,
            presentation_transform,
            cursor_pixel,
            viewport: [1_000, 800],
            pixel_tolerance,
        }
    }

    fn average(vertices: [WorldVec3; 3]) -> WorldVec3 {
        WorldVec3 {
            x: (vertices[0].x + vertices[1].x + vertices[2].x) / 3.0,
            y: (vertices[0].y + vertices[1].y + vertices[2].y) / 3.0,
            z: (vertices[0].z + vertices[1].z + vertices[2].z) / 3.0,
        }
    }
}
