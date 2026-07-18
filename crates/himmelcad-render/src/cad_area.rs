//! Authored area boundary compilation and explicitly requested hole-aware fill.

use std::error::Error;
use std::fmt::{Display, Formatter};

use earcut::Earcut;
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{AreaGeometry, CurveGeometry, CurveLoop, CurveUse};
use himmelcad_core::hash::ObjectHash;

use crate::{
    build_cad_curve_batch_with_width, tessellate_curve, CadCurveError, CurveSemanticSnap,
    CurveTessellationOptions, FloatingOrigin, GpuDrawBatch, GpuFrameError, GpuMeshVertexInput,
    TessellatedCurve, TessellatedCurvePath, TessellatedCurveSegment, WorldVec3,
};

/// Whether the caller explicitly requests a spatial fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AreaFillMode {
    /// Compile and pick boundary topology only.
    BoundaryOnly,
    /// Triangulate the positions produced by the explicit height-display policy.
    TriangulateResolved,
}

/// Hole-aware spatial fill compiled from resolved loop positions.
#[derive(Debug, Clone, PartialEq)]
pub struct TessellatedAreaFill {
    /// Flattened outer ring followed by interior rings.
    pub vertices: Vec<WorldVec3>,
    /// Triangle indices that never cover an interior ring.
    pub indices: Vec<u32>,
}

/// Boundary plus optional explicitly resolved fill.
#[derive(Debug, Clone, PartialEq)]
pub struct TessellatedArea {
    /// Every outer and inner boundary segment with stable pick IDs.
    pub boundary: TessellatedCurve,
    /// Absent unless `AreaFillMode::TriangulateResolved` was requested.
    pub fill: Option<TessellatedAreaFill>,
}

/// Resident area draw resources.
#[derive(Debug)]
pub struct GpuAreaBatches {
    /// Wide boundary batch.
    pub boundary: GpuDrawBatch,
    /// Optional fill batch.
    pub fill: Option<GpuDrawBatch>,
}

/// Invalid topology, unresolved association or GPU resource failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CadAreaError {
    /// Curve tessellation failed.
    Curve(CadCurveError),
    /// An associative boundary curve was unavailable at its requested version.
    MissingAssociativeCurve(EntityId),
    /// A loop is empty, open or has disconnected curve uses.
    InvalidLoop,
    /// Hole-aware triangulation produced no valid triangles.
    Triangulation,
    /// GPU batch validation failed.
    Gpu(GpuFrameError),
}

impl Display for CadAreaError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Curve(error) => Display::fmt(error, formatter),
            Self::MissingAssociativeCurve(id) => {
                write!(formatter, "associative area curve is unavailable: {}", id.0)
            }
            Self::InvalidLoop => formatter.write_str("area boundary loop is open or disconnected"),
            Self::Triangulation => formatter.write_str("area fill triangulation failed"),
            Self::Gpu(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for CadAreaError {}

impl From<CadCurveError> for CadAreaError {
    fn from(value: CadCurveError) -> Self {
        Self::Curve(value)
    }
}

impl From<GpuFrameError> for CadAreaError {
    fn from(value: GpuFrameError) -> Self {
        Self::Gpu(value)
    }
}

/// Compiles inline and associative curve loops without changing source geometry.
pub fn tessellate_area<F>(
    area: &AreaGeometry,
    options: CurveTessellationOptions,
    fill_mode: AreaFillMode,
    mut resolve_curve: F,
) -> Result<TessellatedArea, CadAreaError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
{
    let mut boundary_segments = Vec::new();
    let mut boundary_snaps = Vec::new();
    let mut boundary_paths = Vec::with_capacity(1 + area.holes.len());
    let outer_start = boundary_segments.len();
    let outer = loop_points(
        &area.outer,
        options,
        &mut resolve_curve,
        &mut boundary_segments,
        &mut boundary_snaps,
    )?;
    boundary_paths.push(curve_path(outer_start, boundary_segments.len(), true)?);
    let mut rings = vec![outer];
    for hole in &area.holes {
        let hole_start = boundary_segments.len();
        rings.push(loop_points(
            hole,
            options,
            &mut resolve_curve,
            &mut boundary_segments,
            &mut boundary_snaps,
        )?);
        boundary_paths.push(curve_path(hole_start, boundary_segments.len(), true)?);
    }
    for (index, segment) in boundary_segments.iter_mut().enumerate() {
        segment.primitive_slot = u32::try_from(index).map_err(|_| CadAreaError::InvalidLoop)?;
    }
    let fill = match fill_mode {
        AreaFillMode::BoundaryOnly => None,
        AreaFillMode::TriangulateResolved => Some(triangulate(&rings)?),
    };
    Ok(TessellatedArea {
        boundary: TessellatedCurve {
            segments: boundary_segments,
            semantic_snaps: boundary_snaps,
            paths: boundary_paths,
        },
        fill,
    })
}
fn curve_path(
    first_segment: usize,
    end_segment: usize,
    closed: bool,
) -> Result<TessellatedCurvePath, CadAreaError> {
    let segment_count = end_segment.saturating_sub(first_segment);
    if segment_count == 0 {
        return Err(CadAreaError::InvalidLoop);
    }
    Ok(TessellatedCurvePath {
        first_segment: u32::try_from(first_segment).map_err(|_| CadAreaError::InvalidLoop)?,
        segment_count: u32::try_from(segment_count).map_err(|_| CadAreaError::InvalidLoop)?,
        closed,
    })
}

#[allow(clippy::too_many_arguments)]
/// Uploads boundary and fill into the shared depth, clip and ID pipelines.
#[allow(clippy::too_many_arguments)]
pub fn build_cad_area_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    boundary_proxy_slot: u32,
    fill_proxy_slot: u32,
    floating_origin: FloatingOrigin,
    boundary_color: [f32; 4],
    fill_color: [f32; 4],
    line_width: f32,
    area: &TessellatedArea,
) -> Result<GpuAreaBatches, CadAreaError> {
    let boundary = build_cad_curve_batch_with_width(
        device,
        queue,
        &format!("{label}-boundary"),
        boundary_proxy_slot,
        floating_origin,
        boundary_color,
        line_width,
        &area.boundary,
    )?;
    let fill = area
        .fill
        .as_ref()
        .map(|fill| {
            let vertices = fill
                .vertices
                .iter()
                .map(|position| GpuMeshVertexInput {
                    position: floating_origin.world_to_render(*position),
                    normal: [0.0, 0.0, 1.0],
                    tex_coord: [0.0; 2],
                    additional_tex_coords: [[0.0; 2]; 7],
                    color: fill_color,
                })
                .collect::<Vec<_>>();
            GpuDrawBatch::new_indexed_mesh_with_queue(
                device,
                queue,
                &format!("{label}-fill"),
                fill_proxy_slot,
                0,
                &vertices,
                &fill.indices,
                fill_color[3] < 1.0,
            )
        })
        .transpose()?;
    Ok(GpuAreaBatches { boundary, fill })
}

fn loop_points<F>(
    curve_loop: &CurveLoop,
    options: CurveTessellationOptions,
    resolve_curve: &mut F,
    boundary: &mut Vec<TessellatedCurveSegment>,
    semantic_snaps: &mut Vec<CurveSemanticSnap>,
) -> Result<Vec<WorldVec3>, CadAreaError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
{
    if curve_loop.uses.is_empty() {
        return Err(CadAreaError::InvalidLoop);
    }
    let mut points = Vec::new();
    for curve_use in &curve_loop.uses {
        let (curve, reversed) = match curve_use {
            CurveUse::Inline { curve, reversed } => (curve.clone(), *reversed),
            CurveUse::Associative {
                entity_id,
                expected_version,
                reversed,
            } => (
                resolve_curve(entity_id, expected_version.as_ref())
                    .ok_or_else(|| CadAreaError::MissingAssociativeCurve(entity_id.clone()))?,
                *reversed,
            ),
        };
        let tessellated = tessellate_curve(&curve, options)?;
        for mut semantic in tessellated.semantic_snaps {
            if semantic_snaps.iter().any(|candidate| {
                candidate.snap_kind == semantic.snap_kind && candidate.position == semantic.position
            }) {
                continue;
            }
            semantic.semantic_slot =
                u32::try_from(semantic_snaps.len()).map_err(|_| CadAreaError::InvalidLoop)?;
            semantic_snaps.push(semantic);
        }
        let oriented = if reversed {
            tessellated
                .segments
                .into_iter()
                .rev()
                .map(|segment| TessellatedCurveSegment {
                    start: segment.end,
                    end: segment.start,
                    primitive_slot: segment.primitive_slot,
                })
                .collect::<Vec<_>>()
        } else {
            tessellated.segments
        };
        for segment in oriented {
            if let Some(previous) = points.last().copied() {
                if distance_xy(previous, segment.start) > options.chord_tolerance {
                    return Err(CadAreaError::InvalidLoop);
                }
            } else {
                points.push(segment.start);
            }
            points.push(segment.end);
            boundary.push(segment);
        }
    }
    if points.len() < 4
        || distance_xy(points[0], *points.last().expect("non-empty loop")) > options.chord_tolerance
    {
        return Err(CadAreaError::InvalidLoop);
    }
    points.pop();
    if points.len() < 3 {
        return Err(CadAreaError::InvalidLoop);
    }
    Ok(points)
}

fn triangulate(rings: &[Vec<WorldVec3>]) -> Result<TessellatedAreaFill, CadAreaError> {
    let mut vertices = Vec::new();
    let mut hole_indices = Vec::new();
    for (ring_index, ring) in rings.iter().enumerate() {
        if ring_index > 0 {
            hole_indices
                .push(u32::try_from(vertices.len()).map_err(|_| CadAreaError::InvalidLoop)?);
        }
        vertices.extend_from_slice(ring);
    }
    let coordinates = vertices.iter().map(|position| [position.x, position.y]);
    let mut indices = Vec::new();
    Earcut::<f64>::new().earcut(coordinates, &hole_indices, &mut indices);
    if indices.is_empty() || !indices.len().is_multiple_of(3) {
        return Err(CadAreaError::Triangulation);
    }
    Ok(TessellatedAreaFill { vertices, indices })
}

fn distance_xy(left: WorldVec3, right: WorldVec3) -> f64 {
    (left.x - right.x).hypot(left.y - right.y)
}

#[cfg(test)]
mod tests {
    use himmelcad_core::entity_model::{
        AreaGeometry, CurveGeometry, CurveLoop, CurveUse, Position,
    };

    use super::{tessellate_area, AreaFillMode};
    use crate::{CurveTessellationOptions, UnresolvedHeightDisplay};

    fn area_with_heights(heights: [Option<f64>; 4]) -> AreaGeometry {
        AreaGeometry {
            outer: CurveLoop {
                uses: vec![CurveUse::Inline {
                    curve: CurveGeometry::Polyline {
                        positions: vec![
                            Position {
                                x: 0.0,
                                y: 0.0,
                                z: heights[0],
                            },
                            Position {
                                x: 4.0,
                                y: 0.0,
                                z: heights[1],
                            },
                            Position {
                                x: 4.0,
                                y: 3.0,
                                z: heights[2],
                            },
                            Position {
                                x: 0.0,
                                y: 0.0,
                                z: heights[3],
                            },
                        ],
                        closed: false,
                    },
                    reversed: false,
                }],
            },
            holes: Vec::new(),
        }
    }

    fn options(unresolved_height: UnresolvedHeightDisplay) -> CurveTessellationOptions {
        CurveTessellationOptions {
            chord_tolerance: 0.001,
            maximum_segments: 128,
            unresolved_height,
        }
    }

    #[test]
    fn mixed_xy_xyz_area_is_plan_only_and_never_partially_compiled_for_3d() {
        let area = area_with_heights([Some(10.0), None, Some(12.0), Some(10.0)]);

        assert!(tessellate_area(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
        )
        .is_err());

        let plan = tessellate_area(
            &area,
            options(UnresolvedHeightDisplay::ViewPlane { elevation: 25.0 }),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
        )
        .expect("locked plan view may rasterize unknown heights on its presentation plane");
        let fill = plan.fill.expect("complete plan topology");
        assert_eq!(fill.vertices.len(), 3);
        assert_eq!(fill.indices.len(), 3);
        assert!(fill.vertices.iter().any(|position| position.z == 25.0));
        assert!(fill.vertices.iter().any(|position| position.z == 10.0));
    }

    #[test]
    fn materialized_xyz_revision_is_independently_3d_compilable() {
        let original = area_with_heights([Some(10.0), None, Some(12.0), Some(10.0)]);
        let materialized = area_with_heights([Some(10.0), Some(11.0), Some(12.0), Some(10.0)]);

        let compiled = tessellate_area(
            &materialized,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
        )
        .expect("materialized XYZ revision");
        assert_eq!(compiled.fill.expect("3d fill").vertices[1].z, 11.0);
        assert_eq!(original.outer.uses.len(), 1);
        let CurveUse::Inline { curve, .. } = &original.outer.uses[0] else {
            panic!("inline fixture");
        };
        let CurveGeometry::Polyline { positions, .. } = curve else {
            panic!("polyline fixture");
        };
        assert_eq!(positions[1].z, None, "source revision remains unchanged");
    }
}
