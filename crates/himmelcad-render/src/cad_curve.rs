//! Analytic authored-curve tessellation for shared color, clip and pick passes.

use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::{DVec2, DVec3, DVec4};
use himmelcad_core::entity_model::{CurveGeometry, PlaneDefinition, Position, Vector3};

use crate::gpu_frame::GpuLineInstance;
use crate::{FloatingOrigin, GpuDrawBatch, GpuFrameError, WorldVec3};
use crate::{PickCandidate, PickRefinementRequest, SnapKind};

/// Explicit display behavior for source positions whose Z is unknown.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UnresolvedHeightDisplay {
    /// Do not create spatial render geometry until a resolver is supplied.
    Reject,
    /// Place only unresolved render vertices on a view plane without changing source Z.
    ViewPlane {
        /// View-only elevation in project coordinates.
        elevation: f64,
    },
}

/// View-dependent tessellation limits; canonical analytic geometry remains unchanged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurveTessellationOptions {
    /// Maximum desired chord deviation in project units.
    pub chord_tolerance: f64,
    /// Hard segment ceiling across composite curves.
    pub maximum_segments: u32,
    /// Explicit handling of unknown source heights.
    pub unresolved_height: UnresolvedHeightDisplay,
}

/// One line segment carrying a stable analytic sub-primitive identifier.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TessellatedCurveSegment {
    /// Segment start in project-world coordinates.
    pub start: WorldVec3,
    /// Segment end in project-world coordinates.
    pub end: WorldVec3,
    /// Stable traversal-local primitive used by the shared pick pass.
    pub primitive_slot: u32,
}

/// Explicit ordered path topology over a contiguous segment range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TessellatedCurvePath {
    /// First segment in `TessellatedCurve::segments`.
    pub first_segment: u32,
    /// Number of ordered segments in this path.
    pub segment_count: u32,
    /// Whether the final segment joins back to the first segment.
    pub closed: bool,
}

/// One semantic snap derived from authored curve geometry, never from render tessellation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurveSemanticSnap {
    /// Exact authored/evaluated source position in project-world coordinates.
    pub position: WorldVec3,
    /// Semantic class exposed to the common Tab-cycle stack.
    pub snap_kind: SnapKind,
    /// Stable traversal-local identity disjoint from 32-bit GPU segment slots.
    pub semantic_slot: u32,
}

/// Render-only approximation of one analytic curve.
#[derive(Debug, Clone, PartialEq)]
pub struct TessellatedCurve {
    /// Independent line segments in analytic traversal order.
    pub segments: Vec<TessellatedCurveSegment>,
    /// Exact authored snaps kept independently from tessellation density.
    pub semantic_snaps: Vec<CurveSemanticSnap>,
    /// Explicit subpath topology used for continuous line types and analytic joins.
    pub paths: Vec<TessellatedCurvePath>,
}

/// Invalid authored curve or exhausted deterministic tessellation bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CadCurveError {
    /// A source coordinate or parameter is non-finite.
    NonFinite,
    /// A required source height is unknown and no display resolver was selected.
    UnresolvedHeight,
    /// Radius, knot vector, control set, tangent, plane or arc definition is invalid.
    InvalidGeometry,
    /// The requested tolerance cannot be met within the explicit segment ceiling.
    SegmentLimit,
    /// GPU batch validation failed.
    Gpu(GpuFrameError),
}

impl Display for CadCurveError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::NonFinite => "CAD curve contains a non-finite coordinate or parameter",
            Self::UnresolvedHeight => "CAD curve contains an unresolved source height",
            Self::InvalidGeometry => "CAD curve geometry is invalid or degenerate",
            Self::SegmentLimit => "CAD curve tessellation exceeded its segment ceiling",
            Self::Gpu(error) => return Display::fmt(error, formatter),
        })
    }
}

impl Error for CadCurveError {}

impl From<GpuFrameError> for CadCurveError {
    fn from(value: GpuFrameError) -> Self {
        Self::Gpu(value)
    }
}

/// Tessellates line, polyline, circle, arc, ellipse, clothoid, NURBS and composite curves.
pub fn tessellate_curve(
    curve: &CurveGeometry,
    options: CurveTessellationOptions,
) -> Result<TessellatedCurve, CadCurveError> {
    if !options.chord_tolerance.is_finite()
        || options.chord_tolerance <= 0.0
        || options.maximum_segments == 0
        || matches!(
            options.unresolved_height,
            UnresolvedHeightDisplay::ViewPlane { elevation } if !elevation.is_finite()
        )
    {
        return Err(CadCurveError::InvalidGeometry);
    }
    let mut builder = CurveBuilder {
        options,
        segments: Vec::new(),
        semantic_snaps: Vec::new(),
    };
    builder.curve(curve)?;
    if builder.segments.is_empty() {
        return Err(CadCurveError::InvalidGeometry);
    }
    let segment_count =
        u32::try_from(builder.segments.len()).map_err(|_| CadCurveError::SegmentLimit)?;
    Ok(TessellatedCurve {
        segments: builder.segments,
        semantic_snaps: builder.semantic_snaps,
        paths: vec![TessellatedCurvePath {
            first_segment: 0,
            segment_count,
            closed: authored_curve_closed(curve),
        }],
    })
}

fn authored_curve_closed(curve: &CurveGeometry) -> bool {
    match curve {
        CurveGeometry::Polyline { closed, .. } | CurveGeometry::Spline { closed, .. } => *closed,
        CurveGeometry::Circle { .. } | CurveGeometry::Ellipse { .. } => true,
        CurveGeometry::Composite { segments } if segments.len() == 1 => {
            authored_curve_closed(&segments[0])
        }
        CurveGeometry::LineSegment { .. }
        | CurveGeometry::CircularArc { .. }
        | CurveGeometry::EllipticArc { .. }
        | CurveGeometry::Clothoid { .. }
        | CurveGeometry::Composite { .. } => false,
    }
}

/// Uploads tessellated authored lines into the common clip/depth/pick pipeline.
pub fn build_cad_curve_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    proxy_slot: u32,
    floating_origin: FloatingOrigin,
    linear_color: [f32; 4],
    curve: &TessellatedCurve,
) -> Result<GpuDrawBatch, CadCurveError> {
    build_cad_curve_batch_with_width(
        device,
        queue,
        label,
        proxy_slot,
        floating_origin,
        linear_color,
        2.0,
        curve,
    )
}

/// Uploads an authored curve with an explicit physical-pixel line width.
pub fn build_cad_curve_batch_with_width(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    proxy_slot: u32,
    floating_origin: FloatingOrigin,
    linear_color: [f32; 4],
    line_width: f32,
    curve: &TessellatedCurve,
) -> Result<GpuDrawBatch, CadCurveError> {
    if proxy_slot == 0 || linear_color.iter().any(|channel| !channel.is_finite()) {
        return Err(CadCurveError::InvalidGeometry);
    }
    if !line_width.is_finite() || line_width <= 0.0 || curve.paths.is_empty() {
        return Err(CadCurveError::InvalidGeometry);
    }
    let mut instances = vec![None; curve.segments.len()];
    for path in &curve.paths {
        let first =
            usize::try_from(path.first_segment).map_err(|_| CadCurveError::InvalidGeometry)?;
        let count =
            usize::try_from(path.segment_count).map_err(|_| CadCurveError::InvalidGeometry)?;
        let end = first
            .checked_add(count)
            .ok_or(CadCurveError::InvalidGeometry)?;
        let path_segments = curve
            .segments
            .get(first..end)
            .filter(|segments| !segments.is_empty())
            .ok_or(CadCurveError::InvalidGeometry)?;
        let mut path_distance = 0.0_f64;
        for (local_index, segment) in path_segments.iter().enumerate() {
            let global_index = first + local_index;
            if instances[global_index].is_some() {
                return Err(CadCurveError::InvalidGeometry);
            }
            let previous = if local_index > 0 {
                path_segments[local_index - 1].start
            } else if path.closed {
                path_segments.last().expect("non-empty path").start
            } else {
                segment.start
            };
            let next = if local_index + 1 < path_segments.len() {
                path_segments[local_index + 1].end
            } else if path.closed {
                path_segments.first().expect("non-empty path").end
            } else {
                segment.end
            };
            let segment_length = world_vector(segment.end).distance(world_vector(segment.start));
            if !segment_length.is_finite() || segment_length <= f64::EPSILON {
                return Err(CadCurveError::InvalidGeometry);
            }
            let path_chunk_f64 = (path_distance / 4096.0).floor();
            if path_chunk_f64 > f64::from(u32::MAX) {
                return Err(CadCurveError::InvalidGeometry);
            }
            let coarse_distance = path_chunk_f64 * 4096.0;
            #[allow(clippy::cast_possible_truncation)]
            let (path_chunk, distance_parts) = (
                path_chunk_f64 as u32,
                [
                    (path_distance - coarse_distance) as f32,
                    segment_length as f32,
                ],
            );
            if distance_parts.iter().any(|value| !value.is_finite()) {
                return Err(CadCurveError::InvalidGeometry);
            }
            instances[global_index] = Some(GpuLineInstance {
                start: floating_origin.world_to_render(segment.start),
                end: floating_origin.world_to_render(segment.end),
                color: linear_color,
                proxy_slot,
                primitive_slot: segment.primitive_slot,
                width: line_width,
                previous: floating_origin.world_to_render(previous),
                next: floating_origin.world_to_render(next),
                path_distance: distance_parts,
                path_chunk,
                topology_flags: u32::from(local_index > 0 || path.closed)
                    | (u32::from(local_index + 1 < path_segments.len() || path.closed) << 1),
            });
            path_distance += segment_length;
        }
    }
    let instances = instances
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(CadCurveError::InvalidGeometry)?;
    Ok(GpuDrawBatch::new_stroke_instances_with_queue(
        device, queue, label, &instances,
    )?)
}

/// Refines one tessellated CAD stroke hit to an edge approximation and exact semantic snaps.
///
/// This operates in f64 world coordinates. Analytic providers can use the same
/// refinement contract to replace the tessellation result for circles, splines
/// and clothoids without changing the shared pick pipeline.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn refine_tessellated_curve_pick(
    request: PickRefinementRequest<'_>,
    curve: &TessellatedCurve,
) -> Vec<PickCandidate> {
    let Some(primitive_slot) = request.coarse.address.primitive_id else {
        return Vec::new();
    };
    let Ok(primitive_slot) = u32::try_from(primitive_slot) else {
        return Vec::new();
    };
    let Some(segment) = curve
        .segments
        .iter()
        .find(|segment| segment.primitive_slot == primitive_slot)
    else {
        return Vec::new();
    };
    let start = world_vector(segment.start);
    let end = world_vector(segment.end);
    let Some(source_ray) = request.source_ray() else {
        return Vec::new();
    };
    let ray_origin = world_vector(source_ray.origin);
    let ray_direction = world_vector(source_ray.direction);
    let parameter = closest_segment_parameter(start, end, ray_origin, ray_direction);
    let nearest = start.lerp(end, parameter);
    let mut candidates = Vec::with_capacity(1 + curve.semantic_snaps.len());
    push_screen_snap(
        &mut candidates,
        request,
        vector_world(nearest),
        SnapKind::Edge,
        None,
    );
    for semantic in &curve.semantic_snaps {
        push_screen_snap(
            &mut candidates,
            request,
            semantic.position,
            semantic.snap_kind,
            Some(semantic.semantic_slot),
        );
    }
    candidates
}

fn closest_segment_parameter(start: DVec3, end: DVec3, origin: DVec3, direction: DVec3) -> f64 {
    let edge = end - start;
    let offset = origin - start;
    let edge_length_squared = edge.length_squared();
    let direction_length_squared = direction.length_squared();
    let coupling = direction.dot(edge);
    let denominator = direction_length_squared * edge_length_squared - coupling * coupling;
    if denominator.abs() <= f64::EPSILON {
        return (offset.dot(edge) / edge_length_squared).clamp(0.0, 1.0);
    }
    let parameter = (direction_length_squared * offset.dot(edge)
        - coupling * direction.dot(offset))
        / denominator;
    parameter.clamp(0.0, 1.0)
}

#[allow(clippy::cast_possible_truncation)]
fn push_screen_snap(
    candidates: &mut Vec<PickCandidate>,
    request: PickRefinementRequest<'_>,
    position: WorldVec3,
    snap_kind: SnapKind,
    semantic_slot: Option<u32>,
) {
    let Some(project_position) = request.project_source(position) else {
        return;
    };
    let presented = request.presentation_transform.present(project_position);
    let Ok(projected) = request.camera.project_world(presented, request.viewport) else {
        return;
    };
    let dx = projected.pixel[0] - request.cursor_pixel[0];
    let dy = projected.pixel[1] - request.cursor_pixel[1];
    let pixel_distance = dx.hypot(dy);
    if pixel_distance > request.pixel_tolerance {
        return;
    }
    let mut address = request.coarse.address.clone();
    if let Some(semantic_slot) = semantic_slot {
        address.primitive_id = Some(u64::from(u32::MAX) + 1 + u64::from(semantic_slot));
    }
    candidates.push(PickCandidate {
        address,
        world_position: project_position,
        snap_kind,
        pixel_distance: pixel_distance as f32,
        depth: (1.0 - projected.reverse_z_depth) as f32,
    });
}

fn world_vector(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn vector_world(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

struct CurveBuilder {
    options: CurveTessellationOptions,
    segments: Vec<TessellatedCurveSegment>,
    semantic_snaps: Vec<CurveSemanticSnap>,
}

impl CurveBuilder {
    fn curve(&mut self, curve: &CurveGeometry) -> Result<(), CadCurveError> {
        match curve {
            CurveGeometry::LineSegment { start, end } => {
                let start = self.position(*start)?;
                let end = self.position(*end)?;
                self.push(start, end)?;
                self.push_semantic_snap(start, SnapKind::Vertex)?;
                self.push_semantic_snap(end, SnapKind::Vertex)?;
                self.push_semantic_snap(start.lerp(end, 0.5), SnapKind::Midpoint)
            }
            CurveGeometry::Polyline { positions, closed } => {
                if positions.len() < 2 {
                    return Err(CadCurveError::InvalidGeometry);
                }
                let resolved = positions
                    .iter()
                    .map(|position| self.position(*position))
                    .collect::<Result<Vec<_>, _>>()?;
                for position in &resolved {
                    self.push_semantic_snap(*position, SnapKind::Vertex)?;
                }
                for pair in resolved.windows(2) {
                    self.push(pair[0], pair[1])?;
                    self.push_semantic_snap(pair[0].lerp(pair[1], 0.5), SnapKind::Midpoint)?;
                }
                if *closed {
                    let last = *resolved.last().expect("non-empty polyline");
                    self.push(last, resolved[0])?;
                    self.push_semantic_snap(last.lerp(resolved[0], 0.5), SnapKind::Midpoint)?;
                }
                Ok(())
            }
            CurveGeometry::CircularArc {
                start,
                point_on_arc,
                end,
            } => self.circular_arc(
                self.position(*start)?,
                self.position(*point_on_arc)?,
                self.position(*end)?,
            ),
            CurveGeometry::Circle {
                center,
                radius,
                plane,
            } => {
                if !radius.is_finite() || *radius <= 0.0 {
                    return Err(CadCurveError::InvalidGeometry);
                }
                let center = self.position(*center)?;
                let (axis_x, axis_y) = plane_basis(*plane, None)?;
                self.parametric_closed(|parameter| {
                    center + *radius * (axis_x * parameter.cos() + axis_y * parameter.sin())
                })?;
                self.push_semantic_snap(center, SnapKind::Point)
            }
            CurveGeometry::Ellipse {
                center,
                major_axis,
                minor_radius,
                plane,
            } => self.ellipse(*center, *major_axis, *minor_radius, *plane, None),
            CurveGeometry::EllipticArc {
                center,
                major_axis,
                minor_radius,
                start_parameter,
                sweep_parameter,
                plane,
            } => self.ellipse(
                *center,
                *major_axis,
                *minor_radius,
                *plane,
                Some((*start_parameter, *sweep_parameter)),
            ),
            CurveGeometry::Clothoid {
                start,
                start_tangent,
                start_curvature,
                end_curvature,
                length,
                plane,
            } => self.clothoid(
                self.position(*start)?,
                vector(*start_tangent)?,
                *start_curvature,
                *end_curvature,
                *length,
                *plane,
            ),
            CurveGeometry::Spline {
                degree,
                control_points,
                knots,
                weights,
                closed,
            } => self.spline(*degree, control_points, knots, weights.as_deref(), *closed),
            CurveGeometry::Composite { segments } => {
                if segments.is_empty() {
                    return Err(CadCurveError::InvalidGeometry);
                }
                for segment in segments {
                    self.curve(segment)?;
                }
                Ok(())
            }
        }
    }

    fn circular_arc(
        &mut self,
        start: DVec3,
        middle: DVec3,
        end: DVec3,
    ) -> Result<(), CadCurveError> {
        let a = middle - start;
        let b = end - start;
        let normal = a.cross(b);
        let normal_squared = normal.length_squared();
        if normal_squared <= f64::EPSILON {
            return Err(CadCurveError::InvalidGeometry);
        }
        let center = start
            + (b.length_squared() * a.cross(normal) + a.length_squared() * normal.cross(b))
                / (2.0 * normal_squared);
        let axis_x = (start - center)
            .try_normalize()
            .ok_or(CadCurveError::InvalidGeometry)?;
        let axis_y = normal
            .try_normalize()
            .ok_or(CadCurveError::InvalidGeometry)?
            .cross(axis_x);
        let middle_angle = angle(middle - center, axis_x, axis_y);
        let end_angle = angle(end - center, axis_x, axis_y);
        let positive_end = positive_angle(end_angle);
        let positive_middle = positive_angle(middle_angle);
        let sweep = if positive_middle <= positive_end {
            positive_end
        } else {
            positive_end - std::f64::consts::TAU
        };
        let radius = (start - center).length();
        let evaluate = |parameter: f64| {
            center + radius * (axis_x * parameter.cos() + axis_y * parameter.sin())
        };
        self.adaptive_parametric(0.0, sweep, &evaluate)?;
        self.push_semantic_snap(start, SnapKind::Vertex)?;
        self.push_semantic_snap(middle, SnapKind::Vertex)?;
        self.push_semantic_snap(end, SnapKind::Vertex)?;
        self.push_semantic_snap(evaluate(sweep * 0.5), SnapKind::Midpoint)
    }

    fn ellipse(
        &mut self,
        center: Position,
        major_axis: Vector3,
        minor_radius: f64,
        plane: Option<PlaneDefinition>,
        span: Option<(f64, f64)>,
    ) -> Result<(), CadCurveError> {
        if !minor_radius.is_finite() || minor_radius <= 0.0 {
            return Err(CadCurveError::InvalidGeometry);
        }
        let center = self.position(center)?;
        let major = vector(major_axis)?;
        let major_radius = major.length();
        if major_radius <= f64::EPSILON {
            return Err(CadCurveError::InvalidGeometry);
        }
        let (axis_x, axis_y) = plane_basis(plane, Some(major))?;
        let evaluate = |parameter: f64| {
            center
                + major_radius * axis_x * parameter.cos()
                + minor_radius * axis_y * parameter.sin()
        };
        if let Some((start, sweep)) = span {
            if !start.is_finite() || !sweep.is_finite() || sweep.abs() <= f64::EPSILON {
                return Err(CadCurveError::InvalidGeometry);
            }
            self.parametric_span(start, sweep, evaluate)?;
            self.push_semantic_snap(center, SnapKind::Point)?;
            self.push_semantic_snap(evaluate(start), SnapKind::Vertex)?;
            self.push_semantic_snap(evaluate(start + sweep), SnapKind::Vertex)?;
            self.push_semantic_snap(evaluate(start + sweep * 0.5), SnapKind::Midpoint)
        } else {
            self.parametric_closed(evaluate)?;
            self.push_semantic_snap(center, SnapKind::Point)
        }
    }

    fn parametric_closed(&mut self, evaluate: impl Fn(f64) -> DVec3) -> Result<(), CadCurveError> {
        let quarter = std::f64::consts::FRAC_PI_2;
        for index in 0_u8..4 {
            let start = f64::from(index) * quarter;
            self.adaptive_parametric(start, start + quarter, &evaluate)?;
        }
        Ok(())
    }

    fn parametric_span(
        &mut self,
        start: f64,
        sweep: f64,
        evaluate: impl Fn(f64) -> DVec3,
    ) -> Result<(), CadCurveError> {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let pieces = (sweep.abs() / std::f64::consts::FRAC_PI_2).ceil() as u32;
        if pieces == 0 || pieces > self.options.maximum_segments {
            return Err(CadCurveError::SegmentLimit);
        }
        for index in 0..pieces {
            let first = start + sweep * f64::from(index) / f64::from(pieces);
            let last = start + sweep * f64::from(index + 1) / f64::from(pieces);
            self.adaptive_parametric(first, last, &evaluate)?;
        }
        Ok(())
    }

    fn adaptive_parametric(
        &mut self,
        start_parameter: f64,
        end_parameter: f64,
        evaluate: &impl Fn(f64) -> DVec3,
    ) -> Result<(), CadCurveError> {
        let start = evaluate(start_parameter);
        let end = evaluate(end_parameter);
        self.subdivide(start_parameter, start, end_parameter, end, evaluate, 0)
    }

    fn subdivide(
        &mut self,
        start_parameter: f64,
        start: DVec3,
        end_parameter: f64,
        end: DVec3,
        evaluate: &impl Fn(f64) -> DVec3,
        depth: u8,
    ) -> Result<(), CadCurveError> {
        let middle_parameter = (start_parameter + end_parameter) * 0.5;
        let middle = evaluate(middle_parameter);
        if !finite_vec(middle) {
            return Err(CadCurveError::NonFinite);
        }
        let deviation = distance_to_segment(middle, start, end);
        if deviation <= self.options.chord_tolerance {
            return self.push(start, end);
        }
        if depth >= 32 || self.remaining_segments() < 2 {
            return Err(CadCurveError::SegmentLimit);
        }
        self.subdivide(
            start_parameter,
            start,
            middle_parameter,
            middle,
            evaluate,
            depth + 1,
        )?;
        self.subdivide(
            middle_parameter,
            middle,
            end_parameter,
            end,
            evaluate,
            depth + 1,
        )
    }

    fn clothoid(
        &mut self,
        start: DVec3,
        tangent: DVec3,
        start_curvature: f64,
        end_curvature: f64,
        length: f64,
        plane: Option<PlaneDefinition>,
    ) -> Result<(), CadCurveError> {
        if !start_curvature.is_finite()
            || !end_curvature.is_finite()
            || !length.is_finite()
            || length <= 0.0
        {
            return Err(CadCurveError::InvalidGeometry);
        }
        let tangent = tangent
            .try_normalize()
            .ok_or(CadCurveError::InvalidGeometry)?;
        let normal = plane_normal(plane)?;
        if tangent.dot(normal).abs() > 1.0e-8 {
            return Err(CadCurveError::InvalidGeometry);
        }
        let lateral = normal.cross(tangent);
        let curvature_delta = end_curvature - start_curvature;
        let evaluate = |chainage: f64| {
            // Deterministic composite Simpson integration of the exact heading law.
            let subdivisions = 32_u32;
            let step = chainage / f64::from(subdivisions);
            let mut integral = DVec2::ZERO;
            for index in 0..=subdivisions {
                let station = f64::from(index) * step;
                let heading = start_curvature
                    .mul_add(station, 0.5 * curvature_delta * station * station / length);
                let weight = if index == 0 || index == subdivisions {
                    1.0
                } else if index % 2 == 0 {
                    2.0
                } else {
                    4.0
                };
                integral += weight * DVec2::new(heading.cos(), heading.sin());
            }
            integral *= step / 3.0;
            start + tangent * integral.x + lateral * integral.y
        };
        self.adaptive_parametric(0.0, length, &evaluate)?;
        self.push_semantic_snap(start, SnapKind::Vertex)?;
        self.push_semantic_snap(evaluate(length), SnapKind::Vertex)?;
        self.push_semantic_snap(evaluate(length * 0.5), SnapKind::Midpoint)
    }

    fn spline(
        &mut self,
        degree: u16,
        control_points: &[Position],
        knots: &[f64],
        weights: Option<&[f64]>,
        closed: bool,
    ) -> Result<(), CadCurveError> {
        let degree = usize::from(degree);
        if degree == 0
            || control_points.len() <= degree
            || knots.len()
                != control_points
                    .len()
                    .saturating_add(degree)
                    .saturating_add(1)
            || knots.windows(2).any(|pair| pair[0] > pair[1])
            || knots.iter().any(|value| !value.is_finite())
            || weights.is_some_and(|values| {
                values.len() != control_points.len()
                    || values
                        .iter()
                        .any(|weight| !weight.is_finite() || *weight <= 0.0)
            })
        {
            return Err(CadCurveError::InvalidGeometry);
        }
        let controls = control_points
            .iter()
            .map(|position| self.position(*position))
            .collect::<Result<Vec<_>, _>>()?;
        let start_parameter = knots[degree];
        let end_parameter = knots[control_points.len()];
        if start_parameter >= end_parameter {
            return Err(CadCurveError::InvalidGeometry);
        }
        let evaluate = |parameter| nurbs_point(parameter, degree, &controls, knots, weights);
        let mut breaks = vec![start_parameter];
        breaks.extend(
            knots[degree + 1..=control_points.len()]
                .iter()
                .copied()
                .filter(|value| *value > start_parameter && *value < end_parameter),
        );
        breaks.push(end_parameter);
        breaks.dedup_by(|left, right| (*left - *right).abs() <= f64::EPSILON);
        for parameters in breaks.windows(2) {
            self.adaptive_parametric(parameters[0], parameters[1], &|parameter| {
                evaluate(parameter).unwrap_or(DVec3::splat(f64::NAN))
            })?;
        }
        if closed {
            let first = evaluate(start_parameter).ok_or(CadCurveError::InvalidGeometry)?;
            let last = evaluate(end_parameter).ok_or(CadCurveError::InvalidGeometry)?;
            if first.distance(last) > self.options.chord_tolerance {
                self.push(last, first)?;
            }
        } else {
            self.push_semantic_snap(
                evaluate(start_parameter).ok_or(CadCurveError::InvalidGeometry)?,
                SnapKind::Vertex,
            )?;
            self.push_semantic_snap(
                evaluate(end_parameter).ok_or(CadCurveError::InvalidGeometry)?,
                SnapKind::Vertex,
            )?;
        }
        Ok(())
    }

    fn position(&self, position: Position) -> Result<DVec3, CadCurveError> {
        if !position.x.is_finite() || !position.y.is_finite() {
            return Err(CadCurveError::NonFinite);
        }
        let z = match (position.z, self.options.unresolved_height) {
            (Some(z), _) if z.is_finite() => z,
            (Some(_), _) => return Err(CadCurveError::NonFinite),
            (None, UnresolvedHeightDisplay::Reject) => {
                return Err(CadCurveError::UnresolvedHeight);
            }
            (None, UnresolvedHeightDisplay::ViewPlane { elevation }) => elevation,
        };
        Ok(DVec3::new(position.x, position.y, z))
    }

    fn push(&mut self, start: DVec3, end: DVec3) -> Result<(), CadCurveError> {
        if !finite_vec(start) || !finite_vec(end) || start == end {
            return Err(CadCurveError::InvalidGeometry);
        }
        let primitive_slot =
            u32::try_from(self.segments.len()).map_err(|_| CadCurveError::SegmentLimit)?;
        if primitive_slot >= self.options.maximum_segments {
            return Err(CadCurveError::SegmentLimit);
        }
        self.segments.push(TessellatedCurveSegment {
            start: world(start),
            end: world(end),
            primitive_slot,
        });
        Ok(())
    }

    fn push_semantic_snap(
        &mut self,
        position: DVec3,
        snap_kind: SnapKind,
    ) -> Result<(), CadCurveError> {
        if !finite_vec(position) {
            return Err(CadCurveError::NonFinite);
        }
        if self.semantic_snaps.iter().any(|candidate| {
            candidate.snap_kind == snap_kind && world_vector(candidate.position) == position
        }) {
            return Ok(());
        }
        let semantic_slot =
            u32::try_from(self.semantic_snaps.len()).map_err(|_| CadCurveError::SegmentLimit)?;
        self.semantic_snaps.push(CurveSemanticSnap {
            position: vector_world(position),
            snap_kind,
            semantic_slot,
        });
        Ok(())
    }

    fn remaining_segments(&self) -> usize {
        usize::try_from(self.options.maximum_segments)
            .unwrap_or(usize::MAX)
            .saturating_sub(self.segments.len())
    }
}

fn nurbs_point(
    parameter: f64,
    degree: usize,
    controls: &[DVec3],
    knots: &[f64],
    weights: Option<&[f64]>,
) -> Option<DVec3> {
    let last_parameter = knots[controls.len()];
    let span = if (parameter - last_parameter).abs() <= f64::EPSILON {
        controls.len().checked_sub(1)?
    } else {
        (degree..controls.len())
            .find(|index| parameter >= knots[*index] && parameter < knots[*index + 1])?
    };
    let mut points = (0..=degree)
        .map(|index| {
            let control_index = span - degree + index;
            let weight = weights.map_or(1.0, |values| values[control_index]);
            let control = controls[control_index];
            DVec4::new(
                control.x * weight,
                control.y * weight,
                control.z * weight,
                weight,
            )
        })
        .collect::<Vec<_>>();
    for level in 1..=degree {
        for index in (level..=degree).rev() {
            let knot_index = span - degree + index;
            let denominator = knots[knot_index + degree + 1 - level] - knots[knot_index];
            let alpha = if denominator.abs() <= f64::EPSILON {
                0.0
            } else {
                (parameter - knots[knot_index]) / denominator
            };
            points[index] = points[index - 1].lerp(points[index], alpha);
        }
    }
    let point = points[degree];
    (point.w.abs() > f64::EPSILON).then(|| point.truncate() / point.w)
}

fn plane_basis(
    plane: Option<PlaneDefinition>,
    preferred_axis: Option<DVec3>,
) -> Result<(DVec3, DVec3), CadCurveError> {
    let normal = plane_normal(plane)?;
    let axis_x = if let Some(axis) = preferred_axis {
        let projected = axis - normal * axis.dot(normal);
        projected
            .try_normalize()
            .ok_or(CadCurveError::InvalidGeometry)?
    } else {
        let reference = if normal.z.abs() < 0.9 {
            DVec3::Z
        } else {
            DVec3::X
        };
        reference
            .cross(normal)
            .try_normalize()
            .ok_or(CadCurveError::InvalidGeometry)?
    };
    let axis_y = normal
        .cross(axis_x)
        .try_normalize()
        .ok_or(CadCurveError::InvalidGeometry)?;
    Ok((axis_x, axis_y))
}

fn plane_normal(plane: Option<PlaneDefinition>) -> Result<DVec3, CadCurveError> {
    let normal = plane.map_or(DVec3::Z, |plane| {
        DVec3::new(plane.normal.x, plane.normal.y, plane.normal.z)
    });
    normal
        .try_normalize()
        .filter(|normal| finite_vec(*normal))
        .ok_or(CadCurveError::InvalidGeometry)
}

fn vector(value: Vector3) -> Result<DVec3, CadCurveError> {
    let vector = DVec3::new(value.x, value.y, value.z);
    finite_vec(vector)
        .then_some(vector)
        .ok_or(CadCurveError::NonFinite)
}

fn angle(vector: DVec3, axis_x: DVec3, axis_y: DVec3) -> f64 {
    vector.dot(axis_y).atan2(vector.dot(axis_x))
}

fn positive_angle(angle: f64) -> f64 {
    angle.rem_euclid(std::f64::consts::TAU)
}

fn distance_to_segment(point: DVec3, start: DVec3, end: DVec3) -> f64 {
    let direction = end - start;
    let length_squared = direction.length_squared();
    if length_squared <= f64::EPSILON {
        return point.distance(start);
    }
    let parameter = ((point - start).dot(direction) / length_squared).clamp(0.0, 1.0);
    point.distance(start + parameter * direction)
}

fn finite_vec(vector: DVec3) -> bool {
    vector.x.is_finite() && vector.y.is_finite() && vector.z.is_finite()
}

fn world(vector: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: vector.x,
        y: vector.y,
        z: vector.z,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        refine_tessellated_curve_pick, tessellate_curve, vector_world, world_vector, CadCurveError,
        CurveSemanticSnap, CurveTessellationOptions, TessellatedCurve, TessellatedCurveSegment,
        UnresolvedHeightDisplay,
    };
    use crate::{
        CameraFrame, CameraProjection, PickAddress, PickCandidate, PickRefinementRequest,
        PresentationTransform, SnapKind, WorldCamera, WorldTransform, WorldVec3,
    };
    use himmelcad_core::entity_model::{CurveGeometry, Position, Vector3};

    fn options() -> CurveTessellationOptions {
        CurveTessellationOptions {
            chord_tolerance: 0.01,
            maximum_segments: 10_000,
            unresolved_height: UnresolvedHeightDisplay::Reject,
        }
    }

    fn position(x: f64, y: f64) -> Position {
        Position {
            x,
            y,
            z: Some(500.0),
        }
    }

    #[test]
    fn visual_line_hit_refines_to_exact_midpoint_and_edge() {
        let camera = CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 10.0,
                },
                target: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                up: WorldVec3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                },
                projection: CameraProjection::Orthographic {
                    vertical_span: 20.0,
                    aspect: 1.0,
                    near: 0.1,
                    far: 100.0,
                },
            },
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("camera");
        let coarse = PickCandidate {
            address: PickAddress {
                entity_id: "line".to_owned(),
                render_proxy_id: "line-proxy".to_owned(),
                dataset_id: None,
                tile_id: None,
                primitive_id: Some(0),
            },
            world_position: WorldVec3 {
                x: 0.2,
                y: 0.1,
                z: 0.0,
            },
            snap_kind: SnapKind::Edge,
            pixel_distance: 1.0,
            depth: 0.5,
        };
        let cursor_pixel = [50.0, 50.0];
        let curve = TessellatedCurve {
            segments: vec![TessellatedCurveSegment {
                start: WorldVec3 {
                    x: -5.0,
                    y: 0.0,
                    z: 0.0,
                },
                end: WorldVec3 {
                    x: 5.0,
                    y: 0.0,
                    z: 0.0,
                },
                primitive_slot: 0,
            }],
            semantic_snaps: vec![CurveSemanticSnap {
                position: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                snap_kind: SnapKind::Midpoint,
                semantic_slot: 0,
            }],
            paths: vec![super::TessellatedCurvePath {
                first_segment: 0,
                segment_count: 1,
                closed: false,
            }],
        };
        let refined = refine_tessellated_curve_pick(
            PickRefinementRequest {
                coarse: &coarse,
                camera: &camera,
                cursor_ray: camera
                    .cursor_ray(cursor_pixel, [100, 100])
                    .expect("cursor ray"),
                source_to_project: WorldTransform::IDENTITY,
                presentation_transform: PresentationTransform::IDENTITY,
                cursor_pixel,
                viewport: [100, 100],
                pixel_tolerance: 8.0,
            },
            &curve,
        );

        assert!(refined.iter().any(|candidate| {
            candidate.snap_kind == SnapKind::Midpoint
                && candidate.world_position.x.abs() < f64::EPSILON
                && candidate.world_position.y.abs() < f64::EPSILON
        }));
        assert!(refined
            .iter()
            .any(|candidate| candidate.snap_kind == SnapKind::Edge));
    }

    #[test]
    fn exaggerated_line_ranks_in_presentation_space_but_returns_source_height() {
        let presentation = PresentationTransform::new(2.0, 500.0).expect("presentation");
        let source_midpoint = WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 502.0,
        };
        let presented_midpoint = presentation.present(source_midpoint);
        let camera = CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    x: 0.0,
                    y: -20.0,
                    z: presented_midpoint.z + 20.0,
                },
                target: presented_midpoint,
                up: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
                projection: CameraProjection::Perspective {
                    vertical_fov_radians: 1.0,
                    aspect: 1.0,
                    near: 0.1,
                    far: 1_000.0,
                },
            },
            presented_midpoint,
        )
        .expect("camera");
        let cursor_pixel = camera
            .project_world(presented_midpoint, [100, 100])
            .expect("projected midpoint")
            .pixel;
        let coarse = PickCandidate {
            address: PickAddress {
                entity_id: "line".to_owned(),
                render_proxy_id: "line-proxy".to_owned(),
                dataset_id: None,
                tile_id: None,
                primitive_id: Some(0),
            },
            world_position: presented_midpoint,
            snap_kind: SnapKind::Edge,
            pixel_distance: 0.0,
            depth: 0.5,
        };
        let curve = TessellatedCurve {
            segments: vec![TessellatedCurveSegment {
                start: WorldVec3 {
                    x: -5.0,
                    ..source_midpoint
                },
                end: WorldVec3 {
                    x: 5.0,
                    ..source_midpoint
                },
                primitive_slot: 0,
            }],
            semantic_snaps: vec![CurveSemanticSnap {
                position: source_midpoint,
                snap_kind: SnapKind::Midpoint,
                semantic_slot: 0,
            }],
            paths: vec![super::TessellatedCurvePath {
                first_segment: 0,
                segment_count: 1,
                closed: false,
            }],
        };

        let refined = refine_tessellated_curve_pick(
            PickRefinementRequest {
                coarse: &coarse,
                camera: &camera,
                cursor_ray: camera
                    .cursor_ray(cursor_pixel, [100, 100])
                    .expect("cursor ray"),
                source_to_project: WorldTransform::IDENTITY,
                presentation_transform: presentation,
                cursor_pixel,
                viewport: [100, 100],
                pixel_tolerance: 8.0,
            },
            &curve,
        );
        let midpoint = refined
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Midpoint)
            .expect("source midpoint");
        assert_eq!(midpoint.world_position, source_midpoint);
        assert_ne!(midpoint.world_position.z, presented_midpoint.z);
        assert!(midpoint.pixel_distance < f32::EPSILON);
    }

    #[test]
    fn circle_and_clothoid_receive_stable_unique_segment_ids() {
        let curve = CurveGeometry::Composite {
            segments: vec![
                CurveGeometry::Circle {
                    center: position(0.0, 0.0),
                    radius: 10.0,
                    plane: None,
                },
                CurveGeometry::Clothoid {
                    start: position(20.0, 0.0),
                    start_tangent: Vector3 {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    start_curvature: 0.0,
                    end_curvature: 0.1,
                    length: 20.0,
                    plane: None,
                },
            ],
        };
        let tessellated = tessellate_curve(&curve, options()).expect("valid curve");

        assert!(tessellated.segments.len() > 8);
        assert!(tessellated
            .segments
            .iter()
            .enumerate()
            .all(|(index, segment)| usize::try_from(segment.primitive_slot) == Ok(index)));
    }

    #[test]
    fn circle_render_vertices_never_leak_as_authored_vertex_or_midpoint_snaps() {
        let curve = tessellate_curve(
            &CurveGeometry::Circle {
                center: position(0.0, 0.0),
                radius: 10.0,
                plane: None,
            },
            options(),
        )
        .expect("circle");
        let segment = curve.segments[0];
        let target = vector_world(world_vector(segment.start).lerp(world_vector(segment.end), 0.5));
        let camera = CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    z: target.z + 20.0,
                    ..target
                },
                target,
                up: WorldVec3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                },
                projection: CameraProjection::Orthographic {
                    vertical_span: 20.0,
                    aspect: 1.0,
                    near: 0.1,
                    far: 100.0,
                },
            },
            target,
        )
        .expect("camera");
        let cursor = [50.0, 50.0];
        let coarse = PickCandidate {
            address: PickAddress {
                entity_id: "circle".to_owned(),
                render_proxy_id: "circle-proxy".to_owned(),
                dataset_id: None,
                tile_id: None,
                primitive_id: Some(u64::from(segment.primitive_slot)),
            },
            world_position: target,
            snap_kind: SnapKind::Edge,
            pixel_distance: 0.0,
            depth: 0.5,
        };
        let refined = refine_tessellated_curve_pick(
            PickRefinementRequest {
                coarse: &coarse,
                camera: &camera,
                cursor_ray: camera.cursor_ray(cursor, [100, 100]).expect("ray"),
                source_to_project: WorldTransform::IDENTITY,
                presentation_transform: PresentationTransform::IDENTITY,
                cursor_pixel: cursor,
                viewport: [100, 100],
                pixel_tolerance: 4.0,
            },
            &curve,
        );

        assert!(refined
            .iter()
            .any(|candidate| candidate.snap_kind == SnapKind::Edge));
        assert!(!refined
            .iter()
            .any(|candidate| matches!(candidate.snap_kind, SnapKind::Vertex | SnapKind::Midpoint)));
    }

    #[test]
    fn clothoid_semantic_snaps_are_independent_of_render_tessellation_density() {
        let authored = CurveGeometry::Clothoid {
            start: position(0.0, 0.0),
            start_tangent: Vector3 {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            start_curvature: 0.0,
            end_curvature: 0.1,
            length: 20.0,
            plane: None,
        };
        let fine = tessellate_curve(&authored, options()).expect("fine");
        let coarse = tessellate_curve(
            &authored,
            CurveTessellationOptions {
                chord_tolerance: 0.5,
                ..options()
            },
        )
        .expect("coarse");

        assert_ne!(fine.segments.len(), coarse.segments.len());
        assert_eq!(fine.semantic_snaps, coarse.semantic_snaps);
        assert_eq!(fine.semantic_snaps.len(), 3);
    }

    #[test]
    fn elliptic_arc_honors_signed_parameter_span() {
        let curve = CurveGeometry::EllipticArc {
            center: position(0.0, 0.0),
            major_axis: Vector3 {
                x: 10.0,
                y: 0.0,
                z: 0.0,
            },
            minor_radius: 5.0,
            start_parameter: 0.0,
            sweep_parameter: -std::f64::consts::FRAC_PI_2,
            plane: None,
        };
        let tessellated = tessellate_curve(&curve, options()).expect("elliptic arc");
        let first = tessellated.segments.first().expect("first").start;
        let last = tessellated.segments.last().expect("last").end;

        assert!((first.x - 10.0).abs() < 1.0e-9);
        assert!((first.y - 0.0).abs() < 1.0e-9);
        assert!((last.x - 0.0).abs() < 1.0e-9);
        assert!((last.y + 5.0).abs() < 1.0e-9);
    }

    #[test]
    fn mixed_xy_xyz_never_silently_turns_unknown_height_into_zero() {
        let curve = CurveGeometry::LineSegment {
            start: position(0.0, 0.0),
            end: Position {
                x: 1.0,
                y: 2.0,
                z: None,
            },
        };
        assert_eq!(
            tessellate_curve(&curve, options()),
            Err(CadCurveError::UnresolvedHeight)
        );
        let displayed = tessellate_curve(
            &curve,
            CurveTessellationOptions {
                unresolved_height: UnresolvedHeightDisplay::ViewPlane { elevation: 123.0 },
                ..options()
            },
        )
        .expect("explicit view-plane display");
        assert!((displayed.segments[0].end.z - 123.0).abs() < f64::EPSILON);
        assert!((displayed.segments[0].start.z - 500.0).abs() < f64::EPSILON);
    }

    #[test]
    fn rational_quadratic_spline_is_tessellated() {
        let curve = CurveGeometry::Spline {
            degree: 2,
            control_points: vec![position(0.0, 0.0), position(1.0, 1.0), position(2.0, 0.0)],
            knots: vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0],
            weights: Some(vec![1.0, std::f64::consts::FRAC_1_SQRT_2, 1.0]),
            closed: false,
        };
        let tessellated = tessellate_curve(&curve, options()).expect("valid NURBS");

        assert!(tessellated.segments.len() > 2);
        assert!(tessellated.segments[0].start.x.abs() < f64::EPSILON);
        assert!((tessellated.segments.last().expect("last").end.x - 2.0).abs() < f64::EPSILON);
    }
}
