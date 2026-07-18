//! Authored area boundary compilation and explicitly requested hole-aware fill.

use std::error::Error;
use std::fmt::{Display, Formatter};

use earcut::Earcut;
use glam::{DVec2, DVec3};
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    AreaGeometry, CurveGeometry, CurveLoop, CurveUse, HeightResolution, MissingHeightPolicy,
    Position, RasterCellDiagonal, Vector3,
};
use himmelcad_core::hash::ObjectHash;

use crate::{
    build_cad_curve_batch_with_width, tessellate_curve, CadCurveError, CurveSemanticSnap,
    CurveTessellationOptions, FloatingOrigin, GpuDrawBatch, GpuFrameError, GpuMeshVertexInput,
    RasterGridMapping, RasterSurfaceTopology, TessellatedCurve, TessellatedCurvePath,
    TessellatedCurveSegment, UnresolvedHeightDisplay, WorldVec3,
};

/// Immutable f64-authoritative support geometry returned by an area drape resolver.
#[derive(Debug, Clone, PartialEq)]
pub enum AreaDrapeSurface {
    /// Multiple resident support pieces in the same coordinate frame, such as
    /// the currently loaded tiles of one prepared elevation dataset.
    Composite {
        /// Independently valid support pieces.
        parts: Vec<AreaDrapeSurface>,
    },
    /// A 2.5D elevation TIN. Indices address `positions` in triangle triples.
    ElevationTin {
        /// Project-world vertices; these are never converted through f32 for draping.
        positions: Vec<WorldVec3>,
        /// Triangle indices.
        indices: Vec<u32>,
    },
    /// An elevation raster with explicit `NoData` and connectivity semantics.
    ElevationRaster {
        /// Number of row-major columns.
        width: u32,
        /// Number of row-major rows.
        height: u32,
        /// Exact elevations; `None` is `NoData`.
        elevations: Vec<Option<f64>>,
        /// Optional authoritative LSB0 mask with two triangle bits per cell.
        triangle_mask: Option<Vec<u8>>,
        /// Affine grid-to-project mapping.
        mapping: RasterGridMapping,
        /// Continuous or independent-pixel topology.
        topology: RasterSurfaceTopology,
    },
}

/// Owned surface snapshot satisfying one version-aware drape lookup.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAreaDrapeSurface {
    /// Immutable content version of `surface`.
    pub version: ObjectHash,
    /// Fully owned support data, safe to use after the resolver returns.
    pub surface: AreaDrapeSurface,
}

/// Immutable result of one named, versioned missing-height interpolation.
///
/// `area` must contain the same authored curve topology as the source area,
/// with associative uses materialized as inline curves. Only previously absent
/// Z values may differ. The render core validates this contract before using
/// the result for display or exact picking.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAreaInterpolation {
    /// Namespaced algorithm identifier copied from the authored request.
    pub algorithm_id: String,
    /// Exact implementation version copied from the authored request.
    pub algorithm_version: String,
    /// Content hash of the immutable algorithm parameters.
    pub parameters: ObjectHash,
    /// Fully owned resolved area snapshot with no further height resolver.
    pub area: AreaGeometry,
}

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
    /// The supporting elevation entity or requested immutable version was unavailable.
    MissingDrapeSurface(EntityId),
    /// The resolved support payload is malformed or not a usable elevation surface.
    InvalidDrapeSurface,
    /// The requested immutable named-interpolation result is unavailable.
    MissingInterpolation,
    /// A named interpolation changed source geometry or did not resolve every height.
    InvalidInterpolation,
    /// At least one unknown-height interval did not hit the declared support surface.
    DrapeMiss,
    /// A discontinuous support cannot produce the requested closed spatial fill.
    DiscontinuousDrape,
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
            Self::MissingDrapeSurface(id) => {
                write!(formatter, "area drape surface is unavailable: {}", id.0)
            }
            Self::InvalidDrapeSurface => formatter.write_str("area drape surface is invalid"),
            Self::MissingInterpolation => {
                formatter.write_str("area height interpolation result is unavailable")
            }
            Self::InvalidInterpolation => formatter.write_str(
                "area height interpolation changed source geometry or left heights unresolved",
            ),
            Self::DrapeMiss => formatter.write_str("area drape projection missed its support"),
            Self::DiscontinuousDrape => {
                formatter.write_str("discontinuous area drape cannot produce a closed spatial fill")
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
    tessellate_area_with_drape_surfaces(area, options, fill_mode, &mut resolve_curve, |_, _| None)
}

/// Tessellates an area using version-aware, fully owned elevation support snapshots.
///
/// The surface callback is invoked only for `DrapeMissing`. A returned snapshot is
/// accepted only when its version equals `expected_version`, when one was authored.
/// Known source Z values are authoritative and are never replaced by the support.
pub fn tessellate_area_with_drape_surfaces<F, S>(
    area: &AreaGeometry,
    options: CurveTessellationOptions,
    fill_mode: AreaFillMode,
    mut resolve_curve: F,
    mut resolve_surface: S,
) -> Result<TessellatedArea, CadAreaError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
    S: FnMut(&EntityId, Option<&ObjectHash>) -> Option<ResolvedAreaDrapeSurface>,
{
    tessellate_area_with_resolvers(
        area,
        options,
        fill_mode,
        &mut resolve_curve,
        &mut resolve_surface,
        |_, _, _| None,
    )
}

/// Tessellates an area through associative-curve, drape-surface and immutable
/// named-interpolation resolvers.
///
/// Named results are accepted only when their algorithm identity and parameter
/// hash match the authored request, their curve topology is unchanged, every
/// previously known Z is byte-for-byte equal and every missing Z is finite.
pub fn tessellate_area_with_resolvers<F, S, I>(
    area: &AreaGeometry,
    options: CurveTessellationOptions,
    fill_mode: AreaFillMode,
    mut resolve_curve: F,
    mut resolve_surface: S,
    mut resolve_interpolation: I,
) -> Result<TessellatedArea, CadAreaError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
    S: FnMut(&EntityId, Option<&ObjectHash>) -> Option<ResolvedAreaDrapeSurface>,
    I: FnMut(&str, &str, &ObjectHash) -> Option<ResolvedAreaInterpolation>,
{
    if let Some(HeightResolution::InterpolateMissing {
        algorithm_id,
        algorithm_version,
        parameters,
    }) = area.height_resolution.as_ref()
    {
        let source = resolve_drape_loops(area, &mut resolve_curve)?;
        let resolved = resolve_interpolation(algorithm_id, algorithm_version, parameters)
            .filter(|resolved| {
                resolved.algorithm_id == *algorithm_id
                    && resolved.algorithm_version == *algorithm_version
                    && resolved.parameters == *parameters
            })
            .ok_or(CadAreaError::MissingInterpolation)?;
        let interpolated = validate_interpolation_snapshot(&source, &resolved.area)?;
        return tessellate_draped_area(
            &interpolated,
            options,
            fill_mode,
            &[],
            DVec3::Z,
            MissingHeightPolicy::RejectOperation,
        );
    }

    if let Some(HeightResolution::DrapeMissing {
        support_surface,
        expected_version,
        direction,
        miss_policy,
    }) = area.height_resolution.as_ref()
    {
        let resolved_loops = resolve_drape_loops(area, &mut resolve_curve)?;
        let needs_support = resolved_loops
            .iter()
            .flatten()
            .any(|curve_use| curve_has_missing_height(&curve_use.curve));
        let direction = model_vector(*direction)
            .try_normalize()
            .ok_or(CadAreaError::InvalidDrapeSurface)?;
        if !needs_support {
            return tessellate_draped_area(
                &resolved_loops,
                options,
                fill_mode,
                &[],
                direction,
                *miss_policy,
            );
        }
        let resolved = resolve_surface(support_surface, expected_version.as_ref())
            .filter(|surface| {
                expected_version
                    .as_ref()
                    .is_none_or(|version| *version == surface.version)
            })
            .ok_or_else(|| CadAreaError::MissingDrapeSurface(support_surface.clone()))?;
        let triangles = support_triangles(&resolved.surface)?;
        return tessellate_draped_area(
            &resolved_loops,
            options,
            fill_mode,
            &triangles,
            direction,
            *miss_policy,
        );
    }

    let mut boundary_segments = Vec::new();
    let mut boundary_snaps = Vec::new();
    let mut boundary_paths = Vec::with_capacity(1 + area.holes.len());
    let outer_start = boundary_segments.len();
    let outer = loop_points(
        &area.outer,
        area.height_resolution.as_ref(),
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
            area.height_resolution.as_ref(),
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

fn validate_interpolation_snapshot(
    source: &[Vec<ResolvedCurveUse>],
    resolved: &AreaGeometry,
) -> Result<Vec<Vec<ResolvedCurveUse>>, CadAreaError> {
    if resolved.height_resolution.is_some() {
        return Err(CadAreaError::InvalidInterpolation);
    }
    let resolved_loops = std::iter::once(&resolved.outer)
        .chain(&resolved.holes)
        .map(|curve_loop| {
            curve_loop
                .uses
                .iter()
                .map(|curve_use| match curve_use {
                    CurveUse::Inline { curve, reversed } => Ok(ResolvedCurveUse {
                        curve: curve.clone(),
                        reversed: *reversed,
                    }),
                    CurveUse::Associative { .. } => Err(CadAreaError::InvalidInterpolation),
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    if source.len() != resolved_loops.len() {
        return Err(CadAreaError::InvalidInterpolation);
    }
    for (source_loop, resolved_loop) in source.iter().zip(&resolved_loops) {
        if source_loop.len() != resolved_loop.len() {
            return Err(CadAreaError::InvalidInterpolation);
        }
        for (source_use, resolved_use) in source_loop.iter().zip(resolved_loop) {
            if source_use.reversed != resolved_use.reversed
                || !valid_interpolated_curve(&source_use.curve, &resolved_use.curve)
            {
                return Err(CadAreaError::InvalidInterpolation);
            }
        }
    }
    Ok(resolved_loops)
}

fn valid_interpolated_curve(source: &CurveGeometry, resolved: &CurveGeometry) -> bool {
    let mut source_shape = source.clone();
    let mut resolved_shape = resolved.clone();
    resolve_curve_positions(&mut source_shape, &|position| position.z = None);
    resolve_curve_positions(&mut resolved_shape, &|position| position.z = None);
    if source_shape != resolved_shape {
        return false;
    }
    let mut source_heights = Vec::new();
    let mut resolved_heights = Vec::new();
    collect_curve_heights(source, &mut source_heights);
    collect_curve_heights(resolved, &mut resolved_heights);
    source_heights.len() == resolved_heights.len()
        && source_heights
            .iter()
            .zip(resolved_heights)
            .all(|(source, resolved)| {
                resolved.is_some_and(f64::is_finite)
                    && source.is_none_or(|source| resolved == Some(source))
            })
}

fn collect_curve_heights(curve: &CurveGeometry, output: &mut Vec<Option<f64>>) {
    match curve {
        CurveGeometry::LineSegment { start, end } => output.extend([start.z, end.z]),
        CurveGeometry::Polyline { positions, .. } => {
            output.extend(positions.iter().map(|position| position.z));
        }
        CurveGeometry::CircularArc {
            start,
            point_on_arc,
            end,
        } => output.extend([start.z, point_on_arc.z, end.z]),
        CurveGeometry::Circle { center, .. }
        | CurveGeometry::Ellipse { center, .. }
        | CurveGeometry::EllipticArc { center, .. } => output.push(center.z),
        CurveGeometry::Clothoid { start, .. } => output.push(start.z),
        CurveGeometry::Spline { control_points, .. } => {
            output.extend(control_points.iter().map(|position| position.z));
        }
        CurveGeometry::Composite { segments } => {
            for segment in segments {
                collect_curve_heights(segment, output);
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct SupportTriangle([DVec3; 3]);

#[derive(Debug, Clone, Copy)]
struct DrapeSourceSegment {
    segment: TessellatedCurveSegment,
    start_known: bool,
    end_known: bool,
    requires_drape: bool,
}

#[derive(Debug, Clone)]
struct ResolvedCurveUse {
    curve: CurveGeometry,
    reversed: bool,
}

fn resolve_drape_loops<F>(
    area: &AreaGeometry,
    resolve_curve: &mut F,
) -> Result<Vec<Vec<ResolvedCurveUse>>, CadAreaError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
{
    std::iter::once(&area.outer)
        .chain(&area.holes)
        .map(|curve_loop| {
            if curve_loop.uses.is_empty() {
                return Err(CadAreaError::InvalidLoop);
            }
            curve_loop
                .uses
                .iter()
                .map(|curve_use| {
                    let (curve, reversed) = resolve_curve_use(curve_use, resolve_curve)?;
                    Ok(ResolvedCurveUse { curve, reversed })
                })
                .collect()
        })
        .collect()
}

fn tessellate_draped_area(
    loops: &[Vec<ResolvedCurveUse>],
    options: CurveTessellationOptions,
    fill_mode: AreaFillMode,
    triangles: &[SupportTriangle],
    direction: DVec3,
    miss_policy: MissingHeightPolicy,
) -> Result<TessellatedArea, CadAreaError> {
    let mut boundary = Vec::new();
    let mut semantic_snaps = Vec::new();
    let mut rings = Vec::with_capacity(loops.len());
    let mut paths = Vec::with_capacity(loops.len());
    let mut complete = true;
    for curve_loop in loops {
        let first_segment = boundary.len();
        let ring = drape_loop(
            curve_loop,
            options,
            triangles,
            direction,
            miss_policy,
            &mut boundary,
            &mut semantic_snaps,
        )?;
        complete &= ring.is_some();
        if let Some(ring) = ring {
            paths.push(curve_path(first_segment, boundary.len(), true)?);
            rings.push(ring);
        } else {
            for index in first_segment..boundary.len() {
                paths.push(curve_path(index, index + 1, false)?);
            }
        }
    }
    for (index, segment) in boundary.iter_mut().enumerate() {
        segment.primitive_slot = u32::try_from(index).map_err(|_| CadAreaError::InvalidLoop)?;
    }
    let fill = match (fill_mode, complete) {
        (AreaFillMode::BoundaryOnly, _) => None,
        (AreaFillMode::TriangulateResolved, true) => Some(triangulate(&rings)?),
        (AreaFillMode::TriangulateResolved, false)
            if miss_policy == MissingHeightPolicy::KeepUnresolved =>
        {
            None
        }
        (AreaFillMode::TriangulateResolved, false) => {
            return Err(CadAreaError::DiscontinuousDrape);
        }
    };
    Ok(TessellatedArea {
        boundary: TessellatedCurve {
            segments: boundary,
            semantic_snaps,
            paths,
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
fn drape_loop(
    curve_loop: &[ResolvedCurveUse],
    options: CurveTessellationOptions,
    triangles: &[SupportTriangle],
    direction: DVec3,
    miss_policy: MissingHeightPolicy,
    boundary: &mut Vec<TessellatedCurveSegment>,
    semantic_snaps: &mut Vec<CurveSemanticSnap>,
) -> Result<Option<Vec<WorldVec3>>, CadAreaError> {
    if curve_loop.is_empty() {
        return Err(CadAreaError::InvalidLoop);
    }
    let boundary_start = boundary.len();
    let mut source_end = None;
    let mut source_first = None;
    let mut missed = false;
    for curve_use in curve_loop {
        for mut semantic in
            drape_curve_semantic_snaps(&curve_use.curve, options, triangles, direction)?
        {
            if semantic_snaps.iter().any(|candidate| {
                candidate.snap_kind == semantic.snap_kind && candidate.position == semantic.position
            }) {
                continue;
            }
            semantic.semantic_slot =
                u32::try_from(semantic_snaps.len()).map_err(|_| CadAreaError::InvalidLoop)?;
            semantic_snaps.push(semantic);
        }
        let mut source = drape_source_curve(&curve_use.curve, options)?;
        if curve_use.reversed {
            source.reverse();
            for item in &mut source {
                std::mem::swap(&mut item.segment.start, &mut item.segment.end);
                std::mem::swap(&mut item.start_known, &mut item.end_known);
            }
        }
        for item in source {
            if let Some(previous) = source_end {
                if distance_xy(previous, item.segment.start) > options.chord_tolerance {
                    return Err(CadAreaError::InvalidLoop);
                }
            } else {
                source_first = Some(item.segment.start);
            }
            source_end = Some(item.segment.end);
            if item.requires_drape {
                let result = drape_segment(item, triangles, direction, options.chord_tolerance)?;
                missed |= result.missed;
                boundary.extend(result.segments);
            } else {
                boundary.push(item.segment);
            }
        }
    }
    let (Some(first), Some(last)) = (source_first, source_end) else {
        return Err(CadAreaError::InvalidLoop);
    };
    if distance_xy(first, last) > options.chord_tolerance {
        return Err(CadAreaError::InvalidLoop);
    }
    if missed && miss_policy == MissingHeightPolicy::RejectOperation {
        return Err(CadAreaError::DrapeMiss);
    }
    let produced = &boundary[boundary_start..];
    let ring = connected_ring(produced, options.chord_tolerance);
    Ok((!missed).then_some(ring).flatten())
}

fn drape_curve_semantic_snaps(
    curve: &CurveGeometry,
    options: CurveTessellationOptions,
    triangles: &[SupportTriangle],
    direction: DVec3,
) -> Result<Vec<CurveSemanticSnap>, CadAreaError> {
    let requires_drape = curve_has_missing_height(curve);
    let known = known_curve_positions(curve);
    let mut source = curve.clone();
    if requires_drape {
        resolve_curve_positions(&mut source, &|position| {
            if position.z.is_none() {
                position.z = Some(0.0);
            }
        });
    }
    let mut source_options = options;
    source_options.unresolved_height = UnresolvedHeightDisplay::Reject;
    let mut semantic_snaps = tessellate_curve(&source, source_options)?.semantic_snaps;
    semantic_snaps.retain_mut(|semantic| {
        let mut position = semantic.position;
        let known_height = restore_known_height(&mut position, &known);
        if requires_drape && !known_height {
            let origin = world_vector(position);
            let Some((triangle, _)) = nearest_ray_triangle(origin, direction, triangles) else {
                return false;
            };
            let Some(resolved) = triangle_plane_hit(origin, direction, triangle) else {
                return false;
            };
            position = vector_world(resolved);
        }
        semantic.position = position;
        true
    });
    Ok(semantic_snaps)
}

fn resolve_curve_use<F>(
    curve_use: &CurveUse,
    resolve_curve: &mut F,
) -> Result<(CurveGeometry, bool), CadAreaError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
{
    match curve_use {
        CurveUse::Inline { curve, reversed } => Ok((curve.clone(), *reversed)),
        CurveUse::Associative {
            entity_id,
            expected_version,
            reversed,
        } => Ok((
            resolve_curve(entity_id, expected_version.as_ref())
                .ok_or_else(|| CadAreaError::MissingAssociativeCurve(entity_id.clone()))?,
            *reversed,
        )),
    }
}

fn drape_source_curve(
    curve: &CurveGeometry,
    options: CurveTessellationOptions,
) -> Result<Vec<DrapeSourceSegment>, CadAreaError> {
    let requires_drape = curve_has_missing_height(curve);
    let known = known_curve_positions(curve);
    let mut source = curve.clone();
    if requires_drape {
        // This z=0 embedding is a resolver-domain construction, not ViewPlane display
        // semantics. Projection is performed in the quotient along `direction` below.
        resolve_curve_positions(&mut source, &|position| {
            if position.z.is_none() {
                position.z = Some(0.0);
            }
        });
    }
    let mut source_options = options;
    source_options.unresolved_height = UnresolvedHeightDisplay::Reject;
    let tessellated = tessellate_curve(&source, source_options)?;
    Ok(tessellated
        .segments
        .into_iter()
        .map(|mut segment| {
            let start_known = restore_known_height(&mut segment.start, &known);
            let end_known = restore_known_height(&mut segment.end, &known);
            DrapeSourceSegment {
                segment,
                start_known,
                end_known,
                requires_drape,
            }
        })
        .collect())
}

fn curve_has_missing_height(curve: &CurveGeometry) -> bool {
    let mut missing = false;
    visit_curve_positions(curve, &mut |position| missing |= position.z.is_none());
    missing
}

fn known_curve_positions(curve: &CurveGeometry) -> Vec<WorldVec3> {
    let mut known = Vec::new();
    visit_curve_positions(curve, &mut |position| {
        if let Some(z) = position.z {
            known.push(WorldVec3 {
                x: position.x,
                y: position.y,
                z,
            });
        }
    });
    known
}

fn restore_known_height(position: &mut WorldVec3, known: &[WorldVec3]) -> bool {
    let mut matches = known.iter().filter(|known| {
        known.x.to_bits() == position.x.to_bits() && known.y.to_bits() == position.y.to_bits()
    });
    let Some(first) = matches.next() else {
        return false;
    };
    if matches.any(|other| other.z.to_bits() != first.z.to_bits()) {
        return false;
    }
    position.z = first.z;
    true
}

#[derive(Debug)]
struct DrapedSegment {
    segments: Vec<TessellatedCurveSegment>,
    missed: bool,
}

fn drape_segment(
    source: DrapeSourceSegment,
    triangles: &[SupportTriangle],
    direction: DVec3,
    tolerance: f64,
) -> Result<DrapedSegment, CadAreaError> {
    let start = world_vector(source.segment.start);
    let end = world_vector(source.segment.end);
    let (axis_x, axis_y) = projection_basis(direction)?;
    let projected_start = project_quotient(start.with_z(0.0), axis_x, axis_y);
    let projected_end = project_quotient(end.with_z(0.0), axis_x, axis_y);
    let mut breaks = vec![0.0, 1.0];
    for triangle in triangles {
        let projected = triangle
            .0
            .map(|vertex| project_quotient(vertex, axis_x, axis_y));
        for edge in [[0, 1], [1, 2], [2, 0]] {
            if let Some(parameter) = segment_edge_parameter(
                projected_start,
                projected_end,
                projected[edge[0]],
                projected[edge[1]],
            ) {
                breaks.push(parameter);
            }
        }
    }
    breaks.sort_by(f64::total_cmp);
    breaks.dedup_by(|left, right| (*left - *right).abs() <= 1.0e-10);
    let mut segments = Vec::new();
    let mut missed = false;
    for interval in breaks.windows(2) {
        if interval[1] - interval[0] <= 1.0e-12 {
            continue;
        }
        let middle = (interval[0] + interval[1]) * 0.5;
        let source_middle = unresolved_source_point(start, end, middle);
        let Some((triangle, _)) = nearest_ray_triangle(source_middle, direction, triangles) else {
            missed = true;
            continue;
        };
        let mut resolved_start = triangle_plane_hit(
            unresolved_source_point(start, end, interval[0]),
            direction,
            triangle,
        )
        .ok_or(CadAreaError::InvalidDrapeSurface)?;
        let mut resolved_end = triangle_plane_hit(
            unresolved_source_point(start, end, interval[1]),
            direction,
            triangle,
        )
        .ok_or(CadAreaError::InvalidDrapeSurface)?;
        if interval[0] <= 1.0e-12 && source.start_known {
            resolved_start = start;
        }
        if interval[1] >= 1.0 - 1.0e-12 && source.end_known {
            resolved_end = end;
        }
        if resolved_start.distance(resolved_end) > tolerance * 1.0e-9 {
            segments.push(TessellatedCurveSegment {
                start: vector_world(resolved_start),
                end: vector_world(resolved_end),
                primitive_slot: source.segment.primitive_slot,
            });
        }
    }
    Ok(DrapedSegment { segments, missed })
}

fn unresolved_source_point(start: DVec3, end: DVec3, parameter: f64) -> DVec3 {
    let xy = start.truncate().lerp(end.truncate(), parameter);
    DVec3::new(xy.x, xy.y, 0.0)
}

fn projection_basis(direction: DVec3) -> Result<(DVec3, DVec3), CadAreaError> {
    let reference = if direction.z.abs() < 0.9 {
        DVec3::Z
    } else {
        DVec3::X
    };
    let axis_x = direction
        .cross(reference)
        .try_normalize()
        .ok_or(CadAreaError::InvalidDrapeSurface)?;
    let axis_y = direction.cross(axis_x);
    Ok((axis_x, axis_y))
}

fn project_quotient(point: DVec3, axis_x: DVec3, axis_y: DVec3) -> DVec2 {
    DVec2::new(point.dot(axis_x), point.dot(axis_y))
}

fn segment_edge_parameter(start: DVec2, end: DVec2, a: DVec2, b: DVec2) -> Option<f64> {
    let path = end - start;
    let edge = b - a;
    let denominator = cross_2d(path, edge);
    if denominator.abs() <= 1.0e-12 {
        return None;
    }
    let offset = a - start;
    let parameter = cross_2d(offset, edge) / denominator;
    let edge_parameter = cross_2d(offset, path) / denominator;
    ((-1.0e-10..=1.0 + 1.0e-10).contains(&parameter)
        && (-1.0e-10..=1.0 + 1.0e-10).contains(&edge_parameter))
    .then(|| parameter.clamp(0.0, 1.0))
}

fn cross_2d(left: DVec2, right: DVec2) -> f64 {
    left.x.mul_add(right.y, -left.y * right.x)
}

fn nearest_ray_triangle(
    origin: DVec3,
    direction: DVec3,
    triangles: &[SupportTriangle],
) -> Option<(&SupportTriangle, f64)> {
    triangles
        .iter()
        .filter_map(|triangle| {
            ray_triangle_parameter(origin, direction, triangle).map(|t| (triangle, t))
        })
        .min_by(|left, right| left.1.total_cmp(&right.1))
}

fn ray_triangle_parameter(
    origin: DVec3,
    direction: DVec3,
    triangle: &SupportTriangle,
) -> Option<f64> {
    let [first, second, third] = triangle.0;
    let first_edge = second - first;
    let second_edge = third - first;
    let direction_cross = direction.cross(second_edge);
    let determinant = first_edge.dot(direction_cross);
    if determinant.abs() <= 1.0e-12 {
        return None;
    }
    let inverse = determinant.recip();
    let offset = origin - first;
    let first_barycentric = offset.dot(direction_cross) * inverse;
    if !(-1.0e-10..=1.0 + 1.0e-10).contains(&first_barycentric) {
        return None;
    }
    let offset_cross = offset.cross(first_edge);
    let second_barycentric = direction.dot(offset_cross) * inverse;
    if second_barycentric < -1.0e-10 || first_barycentric + second_barycentric > 1.0 + 1.0e-10 {
        return None;
    }
    let ray_parameter = second_edge.dot(offset_cross) * inverse;
    (ray_parameter >= -1.0e-10 && ray_parameter.is_finite()).then_some(ray_parameter.max(0.0))
}

fn triangle_plane_hit(
    origin: DVec3,
    direction: DVec3,
    triangle: &SupportTriangle,
) -> Option<DVec3> {
    let [a, b, c] = triangle.0;
    let normal = (b - a).cross(c - a);
    let denominator = normal.dot(direction);
    if denominator.abs() <= 1.0e-12 {
        return None;
    }
    let t = normal.dot(a - origin) / denominator;
    (t >= -1.0e-9 && t.is_finite()).then(|| origin + direction * t.max(0.0))
}

fn connected_ring(segments: &[TessellatedCurveSegment], tolerance: f64) -> Option<Vec<WorldVec3>> {
    let first = segments.first()?.start;
    let mut points = vec![first];
    let mut previous = first;
    for segment in segments {
        if distance_3d(previous, segment.start) > tolerance {
            return None;
        }
        points.push(segment.end);
        previous = segment.end;
    }
    if distance_3d(previous, first) > tolerance {
        return None;
    }
    points.pop();
    (points.len() >= 3).then_some(points)
}

fn support_triangles(surface: &AreaDrapeSurface) -> Result<Vec<SupportTriangle>, CadAreaError> {
    match surface {
        AreaDrapeSurface::Composite { parts } => {
            if parts.is_empty() {
                return Err(CadAreaError::InvalidDrapeSurface);
            }
            let mut triangles = Vec::new();
            for part in parts {
                triangles.extend(support_triangles(part)?);
            }
            if triangles.is_empty() {
                return Err(CadAreaError::InvalidDrapeSurface);
            }
            Ok(triangles)
        }
        AreaDrapeSurface::ElevationTin { positions, indices } => {
            if indices.is_empty() || !indices.len().is_multiple_of(3) {
                return Err(CadAreaError::InvalidDrapeSurface);
            }
            let vertices = positions
                .iter()
                .copied()
                .map(world_vector)
                .collect::<Vec<_>>();
            indexed_support_triangles(&vertices, indices)
        }
        AreaDrapeSurface::ElevationRaster {
            width,
            height,
            elevations,
            triangle_mask,
            mapping,
            topology,
        } => raster_support_triangles(
            *width,
            *height,
            elevations,
            triangle_mask.as_deref(),
            *mapping,
            *topology,
        ),
    }
}

fn indexed_support_triangles(
    vertices: &[DVec3],
    indices: &[u32],
) -> Result<Vec<SupportTriangle>, CadAreaError> {
    if vertices.iter().any(|vertex| !vertex.is_finite()) {
        return Err(CadAreaError::InvalidDrapeSurface);
    }
    let mut triangles = Vec::with_capacity(indices.len() / 3);
    for indices in indices.chunks_exact(3) {
        let triangle = indices
            .iter()
            .map(|index| {
                usize::try_from(*index)
                    .ok()
                    .and_then(|index| vertices.get(index))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(CadAreaError::InvalidDrapeSurface)?;
        let triangle = SupportTriangle([*triangle[0], *triangle[1], *triangle[2]]);
        if (triangle.0[1] - triangle.0[0])
            .cross(triangle.0[2] - triangle.0[0])
            .length_squared()
            <= f64::EPSILON
        {
            return Err(CadAreaError::InvalidDrapeSurface);
        }
        triangles.push(triangle);
    }
    if triangles.is_empty() {
        return Err(CadAreaError::InvalidDrapeSurface);
    }
    Ok(triangles)
}

fn raster_support_triangles(
    width: u32,
    height: u32,
    elevations: &[Option<f64>],
    triangle_mask: Option<&[u8]>,
    mapping: RasterGridMapping,
    topology: RasterSurfaceTopology,
) -> Result<Vec<SupportTriangle>, CadAreaError> {
    let count = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(CadAreaError::InvalidDrapeSurface)?;
    let determinant = mapping.column_step[0].mul_add(
        mapping.row_step[1],
        -mapping.column_step[1] * mapping.row_step[0],
    );
    if width == 0
        || height == 0
        || elevations.len() != count
        || [
            mapping.origin[0],
            mapping.origin[1],
            mapping.column_step[0],
            mapping.column_step[1],
            mapping.row_step[0],
            mapping.row_step[1],
        ]
        .iter()
        .any(|value| !value.is_finite())
        || !determinant.is_finite()
        || determinant.abs() <= f64::EPSILON
        || elevations.iter().flatten().any(|value| !value.is_finite())
    {
        return Err(CadAreaError::InvalidDrapeSurface);
    }
    let triangle_bits = usize::try_from(width.saturating_sub(1))
        .ok()
        .and_then(|width| {
            usize::try_from(height.saturating_sub(1))
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|cells| cells.checked_mul(2))
        .ok_or(CadAreaError::InvalidDrapeSurface)?;
    if let Some(mask) = triangle_mask {
        let expected = triangle_bits
            .checked_add(7)
            .map(|bits| bits / 8)
            .ok_or(CadAreaError::InvalidDrapeSurface)?;
        let remainder = triangle_bits % 8;
        if mask.len() != expected
            || (remainder != 0 && mask.last().is_some_and(|byte| byte >> remainder != 0))
            || matches!(topology, RasterSurfaceTopology::PixelSteps)
        {
            return Err(CadAreaError::InvalidDrapeSurface);
        }
    }
    if let RasterSurfaceTopology::Continuous {
        maximum_height_jump: Some(jump),
        ..
    } = topology
    {
        if !jump.is_finite() || jump < 0.0 {
            return Err(CadAreaError::InvalidDrapeSurface);
        }
    }
    let mut triangles = Vec::new();
    match topology {
        RasterSurfaceTopology::Continuous {
            maximum_height_jump,
            diagonal,
        } => {
            for row in 0..height.saturating_sub(1) {
                for column in 0..width.saturating_sub(1) {
                    let cell_triangles = match diagonal {
                        RasterCellDiagonal::TopLeftToBottomRight => {
                            [[(0, 0), (1, 0), (1, 1)], [(0, 0), (1, 1), (0, 1)]]
                        }
                        RasterCellDiagonal::TopRightToBottomLeft => {
                            [[(0, 0), (1, 0), (0, 1)], [(1, 0), (1, 1), (0, 1)]]
                        }
                    };
                    let cell = usize::try_from(row)
                        .ok()
                        .and_then(|row| {
                            usize::try_from(width.saturating_sub(1))
                                .ok()
                                .and_then(|width| row.checked_mul(width))
                        })
                        .and_then(|base| {
                            usize::try_from(column)
                                .ok()
                                .and_then(|column| base.checked_add(column))
                        })
                        .ok_or(CadAreaError::InvalidDrapeSurface)?;
                    for (triangle_in_cell, cells) in cell_triangles.into_iter().enumerate() {
                        if triangle_mask.is_some_and(|mask| {
                            let bit = cell.saturating_mul(2).saturating_add(triangle_in_cell);
                            mask.get(bit / 8)
                                .is_none_or(|byte| byte & (1_u8 << (bit % 8)) == 0)
                        }) {
                            continue;
                        }
                        let samples = cells.map(|(dc, dr)| {
                            raster_sample(width, elevations, mapping, column + dc, row + dr)
                        });
                        let Some(samples) = samples.into_iter().collect::<Option<Vec<_>>>() else {
                            continue;
                        };
                        let minimum = samples
                            .iter()
                            .map(|sample| sample.z)
                            .fold(f64::INFINITY, f64::min);
                        let maximum = samples
                            .iter()
                            .map(|sample| sample.z)
                            .fold(f64::NEG_INFINITY, f64::max);
                        if maximum_height_jump.is_some_and(|jump| maximum - minimum > jump) {
                            continue;
                        }
                        triangles.push(SupportTriangle([samples[0], samples[1], samples[2]]));
                    }
                }
            }
        }
        RasterSurfaceTopology::PixelSteps => {
            for row in 0..height {
                for column in 0..width {
                    let index = raster_index(width, column, row)?;
                    let Some(z) = elevations[index] else { continue };
                    let corners =
                        [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)].map(|(dc, dr)| {
                            let xy =
                                raster_xy(mapping, f64::from(column) + dc, f64::from(row) + dr);
                            DVec3::new(xy.x, xy.y, z)
                        });
                    triangles.push(SupportTriangle([corners[0], corners[1], corners[2]]));
                    triangles.push(SupportTriangle([corners[0], corners[2], corners[3]]));
                }
            }
        }
    }
    if triangles.is_empty() {
        return Err(CadAreaError::InvalidDrapeSurface);
    }
    Ok(triangles)
}

fn raster_sample(
    width: u32,
    elevations: &[Option<f64>],
    mapping: RasterGridMapping,
    column: u32,
    row: u32,
) -> Option<DVec3> {
    let elevation = elevations[raster_index(width, column, row).ok()?]?;
    let xy = raster_xy(mapping, f64::from(column), f64::from(row));
    Some(DVec3::new(xy.x, xy.y, elevation))
}

fn raster_index(width: u32, column: u32, row: u32) -> Result<usize, CadAreaError> {
    usize::try_from(row)
        .ok()
        .and_then(|row| {
            usize::try_from(width)
                .ok()
                .and_then(|width| row.checked_mul(width))
        })
        .and_then(|base| {
            usize::try_from(column)
                .ok()
                .and_then(|column| base.checked_add(column))
        })
        .ok_or(CadAreaError::InvalidDrapeSurface)
}

fn raster_xy(mapping: RasterGridMapping, column: f64, row: f64) -> DVec2 {
    DVec2::new(
        mapping.origin[0] + mapping.column_step[0] * column + mapping.row_step[0] * row,
        mapping.origin[1] + mapping.column_step[1] * column + mapping.row_step[1] * row,
    )
}

fn visit_curve_positions(curve: &CurveGeometry, visit: &mut impl FnMut(Position)) {
    match curve {
        CurveGeometry::LineSegment { start, end } => {
            visit(*start);
            visit(*end);
        }
        CurveGeometry::Polyline { positions, .. } => positions.iter().copied().for_each(visit),
        CurveGeometry::CircularArc {
            start,
            point_on_arc,
            end,
        } => {
            visit(*start);
            visit(*point_on_arc);
            visit(*end);
        }
        CurveGeometry::Circle { center, .. }
        | CurveGeometry::Ellipse { center, .. }
        | CurveGeometry::EllipticArc { center, .. }
        | CurveGeometry::Clothoid { start: center, .. } => visit(*center),
        CurveGeometry::Spline { control_points, .. } => {
            control_points.iter().copied().for_each(visit);
        }
        CurveGeometry::Composite { segments } => {
            for segment in segments {
                visit_curve_positions(segment, visit);
            }
        }
    }
}

fn model_vector(value: Vector3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
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

fn distance_3d(left: WorldVec3, right: WorldVec3) -> f64 {
    world_vector(left).distance(world_vector(right))
}

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
    height_resolution: Option<&HeightResolution>,
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
        let curve = resolve_planar_heights(curve, height_resolution)?;
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

fn resolve_planar_heights(
    mut curve: CurveGeometry,
    resolution: Option<&HeightResolution>,
) -> Result<CurveGeometry, CadAreaError> {
    let Some(HeightResolution::Planar { plane }) = resolution else {
        return Ok(curve);
    };
    if !plane.normal.z.is_finite() || plane.normal.z.abs() <= f64::EPSILON {
        return Err(CadAreaError::InvalidLoop);
    }
    let resolve = |position: &mut Position| {
        if position.z.is_none() {
            position.z = Some(
                plane.origin.z
                    - (plane.normal.x * (position.x - plane.origin.x)
                        + plane.normal.y * (position.y - plane.origin.y))
                        / plane.normal.z,
            );
        }
    };
    resolve_curve_positions(&mut curve, &resolve);
    Ok(curve)
}

fn resolve_curve_positions(curve: &mut CurveGeometry, resolve: &impl Fn(&mut Position)) {
    match curve {
        CurveGeometry::LineSegment { start, end } => {
            resolve(start);
            resolve(end);
        }
        CurveGeometry::Polyline { positions, .. } => positions.iter_mut().for_each(resolve),
        CurveGeometry::CircularArc {
            start,
            point_on_arc,
            end,
        } => {
            resolve(start);
            resolve(point_on_arc);
            resolve(end);
        }
        CurveGeometry::Circle { center, .. }
        | CurveGeometry::Ellipse { center, .. }
        | CurveGeometry::EllipticArc { center, .. } => resolve(center),
        CurveGeometry::Clothoid { start, .. } => resolve(start),
        CurveGeometry::Spline { control_points, .. } => {
            control_points.iter_mut().for_each(resolve);
        }
        CurveGeometry::Composite { segments } => {
            for segment in segments {
                resolve_curve_positions(segment, resolve);
            }
        }
    }
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
    use super::{
        support_triangles, tessellate_area, tessellate_area_with_drape_surfaces,
        tessellate_area_with_resolvers, AreaDrapeSurface, AreaFillMode, CadAreaError,
        ResolvedAreaDrapeSurface, ResolvedAreaInterpolation,
    };
    use crate::{
        CurveTessellationOptions, RasterGridMapping, RasterSurfaceTopology,
        UnresolvedHeightDisplay, WorldVec3,
    };
    use glam::DVec3;
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        AreaGeometry, CurveGeometry, CurveLoop, CurveUse, HeightResolution, MissingHeightPolicy,
        PlaneDefinition, Position, RasterCellDiagonal, Vector3,
    };
    use himmelcad_core::hash::ObjectHash;

    fn ring(minimum: f64, maximum: f64, z: Option<f64>) -> CurveLoop {
        CurveLoop {
            uses: vec![CurveUse::Inline {
                curve: CurveGeometry::Polyline {
                    positions: vec![
                        Position {
                            x: minimum,
                            y: minimum,
                            z,
                        },
                        Position {
                            x: maximum,
                            y: minimum,
                            z,
                        },
                        Position {
                            x: maximum,
                            y: maximum,
                            z,
                        },
                        Position {
                            x: minimum,
                            y: maximum,
                            z,
                        },
                    ],
                    closed: true,
                },
                reversed: false,
            }],
        }
    }

    fn options(unresolved_height: UnresolvedHeightDisplay) -> CurveTessellationOptions {
        CurveTessellationOptions {
            chord_tolerance: 0.001,
            maximum_segments: 1_000,
            unresolved_height,
        }
    }

    fn drape_area(
        outer: CurveLoop,
        direction: Vector3,
        policy: MissingHeightPolicy,
    ) -> AreaGeometry {
        AreaGeometry {
            outer,
            holes: Vec::new(),
            height_resolution: Some(HeightResolution::DrapeMissing {
                support_surface: EntityId("support".to_owned()),
                expected_version: Some(ObjectHash::of_bytes(b"support-v1")),
                direction,
                miss_policy: policy,
            }),
        }
    }

    fn tin(positions: Vec<WorldVec3>, indices: Vec<u32>) -> ResolvedAreaDrapeSurface {
        ResolvedAreaDrapeSurface {
            version: ObjectHash::of_bytes(b"support-v1"),
            surface: AreaDrapeSurface::ElevationTin { positions, indices },
        }
    }

    fn interpolation_area(positions: Vec<Position>) -> AreaGeometry {
        AreaGeometry {
            outer: CurveLoop {
                uses: vec![CurveUse::Inline {
                    curve: CurveGeometry::Polyline {
                        positions,
                        closed: true,
                    },
                    reversed: false,
                }],
            },
            holes: Vec::new(),
            height_resolution: None,
        }
    }

    #[test]
    fn named_interpolation_fills_only_missing_heights_and_retains_topology() {
        let parameters = ObjectHash::of_bytes(b"natural-neighbour-parameters");
        let source = AreaGeometry {
            outer: interpolation_area(vec![
                Position {
                    x: 0.0,
                    y: 0.0,
                    z: Some(501.25),
                },
                Position {
                    x: 4.0,
                    y: 0.0,
                    z: None,
                },
                Position {
                    x: 4.0,
                    y: 3.0,
                    z: None,
                },
                Position {
                    x: 0.0,
                    y: 3.0,
                    z: Some(502.0),
                },
            ])
            .outer,
            holes: Vec::new(),
            height_resolution: Some(HeightResolution::InterpolateMissing {
                algorithm_id: "de.himmelcad.height/natural-neighbour".to_owned(),
                algorithm_version: "1.0.0".to_owned(),
                parameters: parameters.clone(),
            }),
        };
        let resolved_area = interpolation_area(vec![
            Position {
                x: 0.0,
                y: 0.0,
                z: Some(501.25),
            },
            Position {
                x: 4.0,
                y: 0.0,
                z: Some(501.5),
            },
            Position {
                x: 4.0,
                y: 3.0,
                z: Some(501.75),
            },
            Position {
                x: 0.0,
                y: 3.0,
                z: Some(502.0),
            },
        ]);
        let result = tessellate_area_with_resolvers(
            &source,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
            |_, _| None,
            |algorithm_id, algorithm_version, requested_parameters| {
                Some(ResolvedAreaInterpolation {
                    algorithm_id: algorithm_id.to_owned(),
                    algorithm_version: algorithm_version.to_owned(),
                    parameters: requested_parameters.clone(),
                    area: resolved_area.clone(),
                })
            },
        )
        .expect("immutable interpolation");
        let fill = result.fill.expect("resolved fill");
        assert!(fill.vertices.iter().any(|point| point.z == 501.25));
        assert!(fill.vertices.iter().any(|point| point.z == 501.5));
        assert!(fill.vertices.iter().any(|point| point.z == 501.75));
        assert!(fill.vertices.iter().any(|point| point.z == 502.0));
    }

    #[test]
    fn named_interpolation_rejects_changes_to_known_surveyed_height() {
        let parameters = ObjectHash::of_bytes(b"parameters");
        let source = AreaGeometry {
            outer: ring(0.0, 1.0, Some(90.0)),
            holes: Vec::new(),
            height_resolution: Some(HeightResolution::InterpolateMissing {
                algorithm_id: "de.himmelcad.height/test".to_owned(),
                algorithm_version: "1".to_owned(),
                parameters: parameters.clone(),
            }),
        };
        let error = tessellate_area_with_resolvers(
            &source,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
            |_, _| None,
            |algorithm_id, algorithm_version, requested_parameters| {
                Some(ResolvedAreaInterpolation {
                    algorithm_id: algorithm_id.to_owned(),
                    algorithm_version: algorithm_version.to_owned(),
                    parameters: requested_parameters.clone(),
                    area: AreaGeometry {
                        outer: ring(0.0, 1.0, Some(91.0)),
                        holes: Vec::new(),
                        height_resolution: None,
                    },
                })
            },
        )
        .expect_err("known survey Z must be immutable");
        assert_eq!(error, CadAreaError::InvalidInterpolation);
    }

    #[test]
    fn interior_ring_remains_a_hole_in_explicit_fill() {
        let area = AreaGeometry {
            outer: ring(0.0, 10.0, Some(5.0)),
            holes: vec![ring(4.0, 6.0, Some(5.0))],
            height_resolution: None,
        };
        let tessellated = tessellate_area(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
        )
        .expect("area with hole");

        let fill = tessellated.fill.expect("explicit fill");
        let area_sum = fill
            .indices
            .chunks_exact(3)
            .map(|triangle| {
                let a = fill.vertices[usize::try_from(triangle[0]).expect("index")];
                let b = fill.vertices[usize::try_from(triangle[1]).expect("index")];
                let c = fill.vertices[usize::try_from(triangle[2]).expect("index")];
                ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() * 0.5
            })
            .sum::<f64>();
        assert!((area_sum - 96.0).abs() < 1.0e-9);
    }

    #[test]
    fn mixed_xy_xyz_boundary_is_valid_without_implicit_fill() {
        let area = AreaGeometry {
            outer: CurveLoop {
                uses: vec![
                    CurveUse::Inline {
                        curve: CurveGeometry::Polyline {
                            positions: vec![
                                Position {
                                    x: 0.0,
                                    y: 0.0,
                                    z: Some(500.0),
                                },
                                Position {
                                    x: 10.0,
                                    y: 0.0,
                                    z: Some(501.0),
                                },
                                Position {
                                    x: 10.0,
                                    y: 10.0,
                                    z: Some(502.0),
                                },
                            ],
                            closed: false,
                        },
                        reversed: false,
                    },
                    CurveUse::Inline {
                        curve: CurveGeometry::Polyline {
                            positions: vec![
                                Position {
                                    x: 10.0,
                                    y: 10.0,
                                    z: None,
                                },
                                Position {
                                    x: 0.0,
                                    y: 10.0,
                                    z: None,
                                },
                                Position {
                                    x: 0.0,
                                    y: 0.0,
                                    z: None,
                                },
                            ],
                            closed: false,
                        },
                        reversed: false,
                    },
                ],
            },
            holes: Vec::new(),
            height_resolution: None,
        };
        let tessellated = tessellate_area(
            &area,
            options(UnresolvedHeightDisplay::ViewPlane { elevation: 123.0 }),
            AreaFillMode::BoundaryOnly,
            |_, _| None,
        )
        .expect("plan boundary");

        assert!(tessellated.fill.is_none());
        assert!(tessellated
            .boundary
            .segments
            .iter()
            .any(|segment| (segment.start.z - 500.0).abs() < f64::EPSILON));
        assert!(tessellated
            .boundary
            .segments
            .iter()
            .any(|segment| (segment.end.z - 123.0).abs() < f64::EPSILON));
    }

    #[test]
    fn explicit_tilted_plane_resolves_only_missing_area_heights_for_fill() {
        let area = AreaGeometry {
            outer: ring(0.0, 2.0, None),
            holes: Vec::new(),
            height_resolution: Some(HeightResolution::Planar {
                plane: PlaneDefinition {
                    origin: Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 10.0,
                    },
                    normal: Vector3 {
                        x: -1.0,
                        y: 0.0,
                        z: 1.0,
                    },
                },
            }),
        };
        let tessellated = tessellate_area(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
        )
        .expect("tilted planar fill");

        let fill = tessellated.fill.expect("fill");
        assert!(fill
            .vertices
            .iter()
            .all(|vertex| { (vertex.z - (10.0 + vertex.x)).abs() < f64::EPSILON }));
    }

    #[test]
    fn surveyed_xyz_road_edge_stays_authoritative_while_xy_parcel_edge_drapes_to_tin() {
        let area = drape_area(
            CurveLoop {
                uses: vec![
                    CurveUse::Inline {
                        curve: CurveGeometry::Polyline {
                            positions: vec![
                                Position {
                                    x: 0.0,
                                    y: 0.0,
                                    z: Some(100.0),
                                },
                                Position {
                                    x: 10.0,
                                    y: 0.0,
                                    z: Some(101.0),
                                },
                                Position {
                                    x: 10.0,
                                    y: 10.0,
                                    z: Some(102.0),
                                },
                            ],
                            closed: false,
                        },
                        reversed: false,
                    },
                    CurveUse::Inline {
                        curve: CurveGeometry::Polyline {
                            positions: vec![
                                Position {
                                    x: 10.0,
                                    y: 10.0,
                                    z: None,
                                },
                                Position {
                                    x: 0.0,
                                    y: 10.0,
                                    z: None,
                                },
                                Position {
                                    x: 0.0,
                                    y: 0.0,
                                    z: None,
                                },
                            ],
                            closed: false,
                        },
                        reversed: false,
                    },
                ],
            },
            Vector3 {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            MissingHeightPolicy::RejectOperation,
        );
        let support = tin(
            vec![
                WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 100.0,
                },
                WorldVec3 {
                    x: 10.0,
                    y: 0.0,
                    z: 101.0,
                },
                WorldVec3 {
                    x: 10.0,
                    y: 10.0,
                    z: 102.0,
                },
                WorldVec3 {
                    x: 0.0,
                    y: 10.0,
                    z: 101.0,
                },
            ],
            vec![0, 1, 2, 0, 2, 3],
        );
        let tessellated = tessellate_area_with_drape_surfaces(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
            |_, _| Some(support.clone()),
        )
        .expect("mixed surveyed and parcel boundary");

        assert!(tessellated.fill.is_some());
        assert!(tessellated.boundary.segments.iter().any(|segment| {
            segment.start
                == WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 100.0,
                }
                && segment.end
                    == WorldVec3 {
                        x: 10.0,
                        y: 0.0,
                        z: 101.0,
                    }
        }));
        assert!(tessellated.boundary.segments.iter().all(|segment| {
            for point in [segment.start, segment.end] {
                if point.x == 0.0 && point.y == 0.0 {
                    assert_eq!(point.z, 100.0);
                }
            }
            true
        }));
    }

    #[test]
    fn oblique_projection_uses_the_declared_three_dimensional_direction() {
        let area = drape_area(
            ring(0.0, 2.0, None),
            Vector3 {
                x: 1.0,
                y: 0.0,
                z: 1.0,
            },
            MissingHeightPolicy::RejectOperation,
        );
        let support = tin(
            vec![
                WorldVec3 {
                    x: 9.0,
                    y: -1.0,
                    z: 10.0,
                },
                WorldVec3 {
                    x: 13.0,
                    y: -1.0,
                    z: 10.0,
                },
                WorldVec3 {
                    x: 13.0,
                    y: 3.0,
                    z: 10.0,
                },
                WorldVec3 {
                    x: 9.0,
                    y: 3.0,
                    z: 10.0,
                },
            ],
            vec![0, 1, 2, 0, 2, 3],
        );
        let tessellated = tessellate_area_with_drape_surfaces(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
            |_, _| Some(support.clone()),
        )
        .expect("oblique drape");
        let fill = tessellated.fill.expect("resolved fill");
        assert!(fill.vertices.iter().all(|vertex| {
            (vertex.z - 10.0).abs() < 1.0e-10 && (10.0..=12.0).contains(&vertex.x)
        }));
    }

    #[test]
    fn draped_curve_is_split_at_tin_facet_edges_instead_of_interpolating_endpoints() {
        let area = drape_area(
            CurveLoop {
                uses: vec![CurveUse::Inline {
                    curve: CurveGeometry::Polyline {
                        positions: vec![
                            Position {
                                x: 1.0,
                                y: 1.0,
                                z: None,
                            },
                            Position {
                                x: 9.0,
                                y: 1.0,
                                z: None,
                            },
                            Position {
                                x: 9.0,
                                y: 3.0,
                                z: None,
                            },
                            Position {
                                x: 1.0,
                                y: 3.0,
                                z: None,
                            },
                        ],
                        closed: true,
                    },
                    reversed: false,
                }],
            },
            Vector3 {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            MissingHeightPolicy::RejectOperation,
        );
        let support = tin(
            vec![
                WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                WorldVec3 {
                    x: 5.0,
                    y: 0.0,
                    z: 0.0,
                },
                WorldVec3 {
                    x: 0.0,
                    y: 4.0,
                    z: 0.0,
                },
                WorldVec3 {
                    x: 5.0,
                    y: 4.0,
                    z: 0.0,
                },
                WorldVec3 {
                    x: 10.0,
                    y: 0.0,
                    z: 10.0,
                },
                WorldVec3 {
                    x: 10.0,
                    y: 4.0,
                    z: 10.0,
                },
            ],
            vec![0, 1, 3, 0, 3, 2, 1, 4, 5, 1, 5, 3],
        );
        let tessellated = tessellate_area_with_drape_surfaces(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::BoundaryOnly,
            |_, _| None,
            |_, _| Some(support.clone()),
        )
        .expect("facet-aware boundary");

        assert!(tessellated.boundary.segments.iter().any(|segment| {
            (segment.end.x - 5.0).abs() < 1.0e-10 && segment.end.z.abs() < 1.0e-10
        }));
        assert!(tessellated.boundary.segments.iter().any(|segment| {
            (segment.start.x - 5.0).abs() < 1.0e-10 && segment.end.z > segment.start.z
        }));
    }

    #[test]
    fn pixel_steps_and_nodata_never_create_cross_pixel_interpolation() {
        let area = drape_area(
            CurveLoop {
                uses: vec![CurveUse::Inline {
                    curve: CurveGeometry::Polyline {
                        positions: vec![
                            Position {
                                x: 0.25,
                                y: 0.25,
                                z: None,
                            },
                            Position {
                                x: 2.75,
                                y: 0.25,
                                z: None,
                            },
                            Position {
                                x: 2.75,
                                y: 0.75,
                                z: None,
                            },
                            Position {
                                x: 0.25,
                                y: 0.75,
                                z: None,
                            },
                        ],
                        closed: true,
                    },
                    reversed: false,
                }],
            },
            Vector3 {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            MissingHeightPolicy::KeepUnresolved,
        );
        let support = ResolvedAreaDrapeSurface {
            version: ObjectHash::of_bytes(b"support-v1"),
            surface: AreaDrapeSurface::ElevationRaster {
                width: 3,
                height: 1,
                elevations: vec![Some(1.0), Some(5.0), None],
                triangle_mask: None,
                mapping: RasterGridMapping {
                    origin: [0.0, 0.0],
                    column_step: [1.0, 0.0],
                    row_step: [0.0, 1.0],
                },
                topology: RasterSurfaceTopology::PixelSteps,
            },
        };
        let tessellated = tessellate_area_with_drape_surfaces(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::TriangulateResolved,
            |_, _| None,
            |_, _| Some(support.clone()),
        )
        .expect("partial pixel-step drape");

        assert!(tessellated.fill.is_none());
        assert!(!tessellated.boundary.segments.is_empty());
        assert!(tessellated.boundary.segments.iter().all(|segment| {
            (segment.start.z - segment.end.z).abs() < 1.0e-10
                && (segment.start.z == 1.0 || segment.start.z == 5.0)
        }));
        assert!(tessellated
            .boundary
            .segments
            .iter()
            .all(|segment| segment.end.x <= 2.0 + 1.0e-10));
    }

    #[test]
    fn raster_draping_never_reintroduces_a_masked_connectivity_triangle() {
        let surface = AreaDrapeSurface::ElevationRaster {
            width: 2,
            height: 2,
            elevations: vec![Some(1.0), Some(2.0), Some(3.0), Some(4.0)],
            triangle_mask: Some(vec![0b0000_0001]),
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

        let triangles = support_triangles(&surface).expect("masked support");
        assert_eq!(triangles.len(), 1);
        assert_eq!(triangles[0].0[0], DVec3::new(0.0, 0.0, 1.0));
        assert_eq!(triangles[0].0[2], DVec3::new(1.0, 1.0, 4.0));
    }

    #[test]
    fn expected_surface_version_is_enforced_by_the_render_core_contract() {
        let area = drape_area(
            ring(0.0, 1.0, None),
            Vector3 {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            MissingHeightPolicy::RejectOperation,
        );
        let wrong_version = ResolvedAreaDrapeSurface {
            version: ObjectHash::of_bytes(b"support-v2"),
            surface: AreaDrapeSurface::ElevationTin {
                positions: vec![
                    WorldVec3 {
                        x: -1.0,
                        y: -1.0,
                        z: 1.0,
                    },
                    WorldVec3 {
                        x: 2.0,
                        y: -1.0,
                        z: 1.0,
                    },
                    WorldVec3 {
                        x: 2.0,
                        y: 2.0,
                        z: 1.0,
                    },
                ],
                indices: vec![0, 1, 2],
            },
        };
        let error = tessellate_area_with_drape_surfaces(
            &area,
            options(UnresolvedHeightDisplay::Reject),
            AreaFillMode::BoundaryOnly,
            |_, _| None,
            |_, _| Some(wrong_version.clone()),
        )
        .expect_err("wrong immutable support version");
        assert_eq!(
            error,
            CadAreaError::MissingDrapeSurface(EntityId("support".to_owned()))
        );
    }
}
