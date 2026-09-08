//! Checked 2.5D surface creation shared by Builder UI, sidecar and automation.
//!
//! The draft is intentionally independent from canonical source entities. It
//! contains an immutable, already P4-scoped source snapshot. Fixes therefore
//! never mutate survey sources and publishing can remain one journal command.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use spade::{ConstrainedDelaunayTriangulation, HasPosition, Point2, Triangulation};
use thiserror::Error;

use crate::hash::ObjectHash;

/// Stable evaluator identity recorded in every DGM recipe.
pub const SURFACE_ALGORITHM_ID: &str = "hcad.mesh.surface-cdt@1";
/// Stable regional cut/refill evaluator identity.
pub const SURFACE_SMOOTH_ALGORITHM_ID: &str = "hcad.mesh.smooth-region@1";
/// Stable certified terrain-decimation evaluator identity.
pub const SURFACE_DOWNSAMPLE_ALGORITHM_ID: &str = "hcad.mesh.simplify-terrain@1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceSourceRole {
    Points,
    Breakline,
    FormLine,
    OuterBoundary,
    Hole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfacePoint {
    pub point_id: String,
    pub source_id: String,
    pub position: [f64; 2],
    pub z: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceLine {
    pub source_id: String,
    pub role: SurfaceSourceRole,
    pub vertices: Vec<SurfacePoint>,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceRules {
    pub maximum_edge_length: f64,
    pub thin_cloud_spacing: f64,
    pub xy_tolerance: f64,
    pub z_tolerance: f64,
    pub exclude_outside_boundary: bool,
    pub breakline_exclusion_distance: Option<f64>,
    pub auto_boundary: bool,
    #[serde(default)]
    pub crop_polyline: Vec<[f64; 2]>,
}

impl Default for SurfaceRules {
    fn default() -> Self {
        Self {
            maximum_edge_length: 25.0,
            thin_cloud_spacing: 0.25,
            xy_tolerance: 0.001,
            z_tolerance: 0.001,
            exclude_outside_boundary: true,
            breakline_exclusion_distance: None,
            auto_boundary: true,
            crop_polyline: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceDraft {
    pub draft_id: String,
    pub name: String,
    pub points: Vec<SurfacePoint>,
    pub lines: Vec<SurfaceLine>,
    pub rules: SurfaceRules,
    #[serde(default)]
    pub excluded_source_ids: BTreeSet<String>,
    #[serde(default)]
    pub excluded_point_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceErrorCode {
    TooFewPoints,
    DuplicatePoints,
    ZeroLengthEdge,
    CrossingBreaklines,
    BreaklineVertexOffPointSet,
    VertexOutsideBoundary,
    BoundaryDefect,
    InventedZ,
    VerticalOrOverhanging,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceErrorSeverity {
    Error,
    Warning,
    Notice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceFixKind {
    Drop,
    Snap,
    Split,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceCheckError {
    pub error_id: String,
    pub code: SurfaceErrorCode,
    pub severity: SurfaceErrorSeverity,
    pub message: String,
    pub source_ids: Vec<String>,
    pub location: Option<[f64; 3]>,
    pub fixes: Vec<SurfaceFixKind>,
    pub blocks_publish: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceCheckResult {
    pub errors: Vec<SurfaceCheckError>,
    pub fixable: usize,
    pub blocking: usize,
    pub source_points: usize,
    pub admitted_points: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceFixRequest {
    pub error_id: String,
    pub fix: SurfaceFixKind,
    /// Required authority source for conflicting-Z crossing splits.
    pub authority_source_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceFixResult {
    pub draft: SurfaceDraft,
    pub resolved_error_ids: Vec<String>,
    pub introduced_error_ids: Vec<String>,
    pub check: SurfaceCheckResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceMesh {
    pub positions: Vec<[f64; 3]>,
    pub indices: Vec<u32>,
    pub constrained_edges: Vec<[u32; 2]>,
    pub projected_area: f64,
    pub z_range: [f64; 2],
    pub source_residual: SurfaceResidual,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceResidual {
    pub count: usize,
    pub mean_absolute: f64,
    pub maximum_absolute: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceRegionSource {
    Fence,
    BoundaryPolyline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditRegion {
    pub source: SurfaceRegionSource,
    /// Project-XY polygon. The closing vertex is implicit.
    pub polygon: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceSmoothFilter {
    Gaussian,
    Median,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceSmoothParameters {
    pub filter: SurfaceSmoothFilter,
    pub radius: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceDownsampleParameters {
    pub maximum_vertical_error: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceErrorCertificate {
    pub metric: String,
    pub sample_count: usize,
    pub maximum_vertical_error: f64,
    pub rms_vertical_error: f64,
    pub target_vertical_error: Option<f64>,
    pub certified: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditMetrics {
    pub vertices_before: usize,
    pub vertices_after: usize,
    pub triangles_before: usize,
    pub triangles_after: usize,
    pub affected_triangles: usize,
    pub region_area: f64,
    pub error: SurfaceErrorCertificate,
    pub outside_identity_hash: ObjectHash,
    pub result_hash: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditResult {
    pub mesh: SurfaceMesh,
    pub metrics: SurfaceEditMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceRegionSummary {
    pub vertices: usize,
    pub triangles: usize,
    pub protected_segments: usize,
    pub area: f64,
}

#[derive(Debug, Error, PartialEq)]
pub enum SurfaceEditError {
    #[error("surface edit region is invalid: {0}")]
    InvalidRegion(&'static str),
    #[error("surface edit parameters are invalid: {0}")]
    InvalidParameters(&'static str),
    #[error("surface edit source mesh is invalid: {0}")]
    InvalidMesh(&'static str),
    #[error("surface edit region contains no triangle")]
    EmptyRegion,
    #[error("surface edit triangulation failed: {0}")]
    Triangulation(String),
    #[error("surface edit was cancelled")]
    Cancelled,
}

#[derive(Debug, Error, PartialEq)]
pub enum SurfaceBuildError {
    #[error("surface rules are invalid: {0}")]
    InvalidRules(&'static str),
    #[error("surface check has {0} blocking error(s)")]
    CheckFailed(usize),
    #[error("surface triangulation failed: {0}")]
    Triangulation(String),
    #[error("surface creation was cancelled")]
    Cancelled,
    #[error("the requested draft fix is not applicable")]
    FixNotApplicable,
}

#[derive(Debug, Clone)]
struct Vertex {
    xy: Point2<f64>,
}

impl HasPosition for Vertex {
    type Scalar = f64;

    fn position(&self) -> Point2<Self::Scalar> {
        self.xy
    }
}

pub fn check_surface_draft(draft: &SurfaceDraft) -> Result<SurfaceCheckResult, SurfaceBuildError> {
    validate_rules(&draft.rules)?;
    let mut errors = Vec::new();
    let points = admitted_points(draft);
    let key = |point: &SurfacePoint| quantized_key(point.position, draft.rules.xy_tolerance);
    let mut by_xy = BTreeMap::<(i64, i64), Vec<&SurfacePoint>>::new();
    for point in &points {
        if point.z.is_none_or(|z| !z.is_finite())
            || !point.position[0].is_finite()
            || !point.position[1].is_finite()
        {
            errors.push(error(
                SurfaceErrorCode::InventedZ,
                format!("{} has no authoritative finite height", point.point_id),
                vec![point.source_id.clone()],
                point.z.map(|z| [point.position[0], point.position[1], z]),
                vec![SurfaceFixKind::Snap, SurfaceFixKind::Exclude],
            ));
            continue;
        }
        if draft
            .points
            .iter()
            .any(|candidate| std::ptr::eq(candidate, *point))
        {
            by_xy.entry(key(point)).or_default().push(point);
        }
    }
    for duplicates in by_xy.values().filter(|items| items.len() > 1) {
        let z0 = duplicates[0].z.unwrap_or_default();
        let conflicting = duplicates
            .iter()
            .skip(1)
            .any(|point| (point.z.unwrap_or_default() - z0).abs() > draft.rules.z_tolerance);
        errors.push(error(
            if conflicting {
                SurfaceErrorCode::VerticalOrOverhanging
            } else {
                SurfaceErrorCode::DuplicatePoints
            },
            if conflicting {
                "Duplicate XY coordinates carry conflicting heights".to_owned()
            } else {
                "Duplicate input points share the same XY coordinate".to_owned()
            },
            duplicates
                .iter()
                .map(|point| point.source_id.clone())
                .collect(),
            Some([duplicates[0].position[0], duplicates[0].position[1], z0]),
            vec![SurfaceFixKind::Drop, SurfaceFixKind::Exclude],
        ));
    }

    let boundaries = active_lines(draft, SurfaceSourceRole::OuterBoundary);
    let holes = active_lines(draft, SurfaceSourceRole::Hole);
    for line in draft
        .lines
        .iter()
        .filter(|line| !draft.excluded_source_ids.contains(&line.source_id))
    {
        for pair in line.vertices.windows(2) {
            if distance_xy(pair[0].position, pair[1].position) <= draft.rules.xy_tolerance {
                errors.push(error(
                    SurfaceErrorCode::ZeroLengthEdge,
                    format!("{} contains a zero-length edge", line.source_id),
                    vec![line.source_id.clone()],
                    point_location(&pair[0]),
                    vec![SurfaceFixKind::Drop, SurfaceFixKind::Exclude],
                ));
            }
        }
        if line.closed
            && line.vertices.len() > 1
            && distance_xy(
                line.vertices
                    .last()
                    .expect("closed line is non-empty")
                    .position,
                line.vertices[0].position,
            ) <= draft.rules.xy_tolerance
        {
            errors.push(error(
                SurfaceErrorCode::ZeroLengthEdge,
                format!("{} contains a zero-length closing edge", line.source_id),
                vec![line.source_id.clone()],
                point_location(&line.vertices[0]),
                vec![SurfaceFixKind::Drop, SurfaceFixKind::Exclude],
            ));
        }
        if matches!(
            line.role,
            SurfaceSourceRole::OuterBoundary | SurfaceSourceRole::Hole
        ) && (!line.closed || distinct_xy(&line.vertices, draft.rules.xy_tolerance) < 3)
        {
            errors.push(error(
                SurfaceErrorCode::BoundaryDefect,
                format!("{} is not a valid closed boundary", line.source_id),
                vec![line.source_id.clone()],
                line.vertices
                    .first()
                    .and_then(|point| point_location(point)),
                vec![SurfaceFixKind::Exclude],
            ));
        }
    }

    let breaklines = active_lines(draft, SurfaceSourceRole::Breakline);
    for line in &breaklines {
        for vertex in &line.vertices {
            if !draft.points.iter().any(|point| {
                !draft.excluded_source_ids.contains(&point.source_id)
                    && !draft.excluded_point_ids.contains(&point.point_id)
                    && distance_xy(point.position, vertex.position) <= draft.rules.xy_tolerance
                    && point.z.zip(vertex.z).is_some_and(|(left, right)| {
                        (left - right).abs() <= draft.rules.z_tolerance
                    })
            }) {
                errors.push(error(
                    SurfaceErrorCode::BreaklineVertexOffPointSet,
                    format!("{} has a vertex off the admitted point set", line.source_id),
                    vec![line.source_id.clone()],
                    point_location(vertex),
                    vec![SurfaceFixKind::Snap, SurfaceFixKind::Exclude],
                ));
            }
        }
    }
    let segments = breakline_segments(&breaklines);
    for (index, left) in segments.iter().enumerate() {
        for right in segments.iter().skip(index + 1) {
            if left.source_id == right.source_id
                && shares_endpoint(left, right, draft.rules.xy_tolerance)
            {
                continue;
            }
            if let Some((xy, left_z, right_z)) =
                segment_crossing(left, right, draft.rules.xy_tolerance)
            {
                let agreed = (left_z - right_z).abs() <= draft.rules.z_tolerance;
                errors.push(error(
                    SurfaceErrorCode::CrossingBreaklines,
                    if agreed {
                        "Breaklines cross away from a shared vertex; the evaluated heights agree"
                            .to_owned()
                    } else {
                        format!(
                            "Breaklines cross with conflicting heights ({left_z:.3} / {right_z:.3})"
                        )
                    },
                    vec![left.source_id.to_owned(), right.source_id.to_owned()],
                    Some([xy[0], xy[1], if agreed { left_z } else { f64::NAN }]),
                    vec![SurfaceFixKind::Split, SurfaceFixKind::Exclude],
                ));
            }
        }
    }

    if let Some(boundary) = boundaries.first() {
        for point in &points {
            if point.z.is_some()
                && !point_in_ring(point.position, &boundary.vertices, draft.rules.xy_tolerance)
            {
                errors.push(error(
                    SurfaceErrorCode::VertexOutsideBoundary,
                    format!("{} lies outside the outer boundary", point.point_id),
                    vec![point.source_id.clone(), boundary.source_id.clone()],
                    point_location(point),
                    vec![SurfaceFixKind::Exclude],
                ));
            }
        }
        for hole in holes {
            if hole.vertices.iter().any(|point| {
                !point_in_ring(point.position, &boundary.vertices, draft.rules.xy_tolerance)
            }) {
                errors.push(error(
                    SurfaceErrorCode::BoundaryDefect,
                    format!("Hole {} lies outside the outer boundary", hole.source_id),
                    vec![hole.source_id.clone(), boundary.source_id.clone()],
                    hole.vertices.first().and_then(point_location),
                    vec![SurfaceFixKind::Exclude],
                ));
            }
        }
    }

    let finite_unique = points
        .iter()
        .filter(|point| point.z.is_some_and(f64::is_finite))
        .map(|point| key(point))
        .collect::<BTreeSet<_>>()
        .len();
    if finite_unique < 3 {
        errors.push(error(
            SurfaceErrorCode::TooFewPoints,
            "At least three unique authoritative XYZ points are required".to_owned(),
            Vec::new(),
            None,
            Vec::new(),
        ));
    }
    errors.sort_by(|left, right| left.error_id.cmp(&right.error_id));
    let fixable = errors.iter().filter(|item| !item.fixes.is_empty()).count();
    let blocking = errors.iter().filter(|item| item.blocks_publish).count();
    Ok(SurfaceCheckResult {
        errors,
        fixable,
        blocking,
        source_points: draft.points.len()
            + draft
                .lines
                .iter()
                .map(|line| line.vertices.len())
                .sum::<usize>(),
        admitted_points: points.len(),
    })
}

pub fn apply_surface_fix(
    draft: &SurfaceDraft,
    request: &SurfaceFixRequest,
) -> Result<SurfaceFixResult, SurfaceBuildError> {
    let before = check_surface_draft(draft)?;
    let target = before
        .errors
        .iter()
        .find(|item| item.error_id == request.error_id && item.fixes.contains(&request.fix))
        .ok_or(SurfaceBuildError::FixNotApplicable)?;
    let mut next = draft.clone();
    match request.fix {
        SurfaceFixKind::Exclude => {
            let source = target
                .source_ids
                .first()
                .ok_or(SurfaceBuildError::FixNotApplicable)?;
            next.excluded_source_ids.insert(source.clone());
        }
        SurfaceFixKind::Drop => apply_drop(&mut next, target)?,
        SurfaceFixKind::Snap => apply_snap(&mut next, target)?,
        SurfaceFixKind::Split => {
            apply_split(&mut next, target, request.authority_source_id.as_deref())?
        }
    }
    let check = check_surface_draft(&next)?;
    let before_ids = before
        .errors
        .iter()
        .map(|item| item.error_id.clone())
        .collect::<BTreeSet<_>>();
    let after_ids = check
        .errors
        .iter()
        .map(|item| item.error_id.clone())
        .collect::<BTreeSet<_>>();
    Ok(SurfaceFixResult {
        draft: next,
        resolved_error_ids: before_ids.difference(&after_ids).cloned().collect(),
        introduced_error_ids: after_ids.difference(&before_ids).cloned().collect(),
        check,
    })
}

pub fn triangulate_surface(draft: &SurfaceDraft) -> Result<SurfaceMesh, SurfaceBuildError> {
    triangulate_surface_with_cancel(draft, || false)
}

pub fn triangulate_surface_with_cancel(
    draft: &SurfaceDraft,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<SurfaceMesh, SurfaceBuildError> {
    let check = check_surface_draft(draft)?;
    if check.blocking > 0 {
        return Err(SurfaceBuildError::CheckFailed(check.blocking));
    }
    if is_cancelled() {
        return Err(SurfaceBuildError::Cancelled);
    }
    let mut positions = Vec::<[f64; 3]>::new();
    let mut index_by_xy = BTreeMap::<(u64, u64), usize>::new();
    let mut add = |point: &SurfacePoint| -> Result<usize, SurfaceBuildError> {
        let z = point.z.ok_or_else(|| SurfaceBuildError::CheckFailed(1))?;
        let key = (point.position[0].to_bits(), point.position[1].to_bits());
        if let Some(index) = index_by_xy.get(&key) {
            return Ok(*index);
        }
        let index = positions.len();
        positions.push([point.position[0], point.position[1], z]);
        index_by_xy.insert(key, index);
        Ok(index)
    };
    for point in &draft.points {
        if !draft.excluded_source_ids.contains(&point.source_id)
            && !draft.excluded_point_ids.contains(&point.point_id)
        {
            add(point)?;
        }
    }
    let mut constraints = Vec::<[usize; 2]>::new();
    for line in draft
        .lines
        .iter()
        .filter(|line| !draft.excluded_source_ids.contains(&line.source_id))
    {
        let line_indices = line
            .vertices
            .iter()
            .map(&mut add)
            .collect::<Result<Vec<_>, _>>()?;
        if matches!(
            line.role,
            SurfaceSourceRole::Breakline
                | SurfaceSourceRole::OuterBoundary
                | SurfaceSourceRole::Hole
        ) {
            constraints.extend(line_indices.windows(2).map(|pair| [pair[0], pair[1]]));
            if line.closed && line_indices.len() > 2 {
                constraints.push([*line_indices.last().unwrap_or(&0), line_indices[0]]);
            }
        }
    }
    drop(add);
    let vertices = positions
        .iter()
        .map(|point| Vertex {
            xy: Point2::new(point[0], point[1]),
        })
        .collect::<Vec<_>>();
    let triangulation =
        ConstrainedDelaunayTriangulation::<Vertex>::bulk_load_cdt(vertices, constraints.clone())
            .map_err(|error| SurfaceBuildError::Triangulation(error.to_string()))?;
    if triangulation.num_vertices() != positions.len() {
        return Err(SurfaceBuildError::Triangulation(
            "duplicate vertices reached the triangulator".to_owned(),
        ));
    }
    let outer = active_lines(draft, SurfaceSourceRole::OuterBoundary)
        .first()
        .map(|line| line.vertices.as_slice());
    let holes = active_lines(draft, SurfaceSourceRole::Hole);
    let crop =
        (!draft.rules.crop_polyline.is_empty()).then_some(draft.rules.crop_polyline.as_slice());
    let mut indices = Vec::with_capacity(triangulation.num_inner_faces() * 3);
    let mut projected_area = 0.0;
    for (face_index, face) in triangulation.inner_faces().enumerate() {
        if face_index % 4_096 == 0 && is_cancelled() {
            return Err(SurfaceBuildError::Cancelled);
        }
        let vertices = face.vertices();
        let face_indices = vertices.map(|vertex| vertex.fix().index());
        let p = face_indices.map(|index| positions[index]);
        let centroid = [
            (p[0][0] + p[1][0] + p[2][0]) / 3.0,
            (p[0][1] + p[1][1] + p[2][1]) / 3.0,
        ];
        if outer.is_some_and(|ring| !point_in_ring(centroid, ring, draft.rules.xy_tolerance))
            || holes
                .iter()
                .any(|hole| point_in_ring(centroid, &hole.vertices, draft.rules.xy_tolerance))
            || crop.is_some_and(|ring| !point_in_xy_ring(centroid, ring))
        {
            continue;
        }
        if draft.rules.auto_boundary
            && draft.rules.maximum_edge_length.is_finite()
            && triangle_max_edge(p) > draft.rules.maximum_edge_length
        {
            continue;
        }
        let area = signed_twice_area(p[0], p[1], p[2]).abs() * 0.5;
        if area <= draft.rules.xy_tolerance * draft.rules.xy_tolerance {
            continue;
        }
        projected_area += area;
        indices.extend(face_indices.map(|value| u32::try_from(value).unwrap_or(u32::MAX)));
    }
    if indices.is_empty() {
        return Err(SurfaceBuildError::Triangulation(
            "rules excluded every valid triangle".to_owned(),
        ));
    }
    let z_min = positions
        .iter()
        .map(|point| point[2])
        .fold(f64::INFINITY, f64::min);
    let z_max = positions
        .iter()
        .map(|point| point[2])
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(SurfaceMesh {
        positions,
        indices,
        constrained_edges: constraints
            .into_iter()
            .map(|edge| {
                [
                    u32::try_from(edge[0]).unwrap_or(u32::MAX),
                    u32::try_from(edge[1]).unwrap_or(u32::MAX),
                ]
            })
            .collect(),
        projected_area,
        z_range: [z_min, z_max],
        source_residual: SurfaceResidual {
            count: check.admitted_points,
            mean_absolute: 0.0,
            maximum_absolute: 0.0,
        },
    })
}

/// Excises the triangle patch selected by the project-XY region and refills it
/// from filtered interior heights. Original positions are never overwritten:
/// protected and outside triangles keep their exact original vertex bytes.
pub fn smooth_surface_region(
    source: &SurfaceMesh,
    region: &SurfaceEditRegion,
    parameters: &SurfaceSmoothParameters,
) -> Result<SurfaceEditResult, SurfaceEditError> {
    smooth_surface_region_with_cancel(source, region, parameters, || false)
}

pub fn inspect_surface_region(
    source: &SurfaceMesh,
    region: &SurfaceEditRegion,
) -> Result<SurfaceRegionSummary, SurfaceEditError> {
    validate_edit_input(source, region)?;
    let patch = EditPatch::capture(source, region)?;
    Ok(SurfaceRegionSummary {
        vertices: patch.affected_vertices.len(),
        triangles: patch.affected_faces.len(),
        protected_segments: patch.local_constraints.len(),
        area: patch.region_area,
    })
}

pub fn smooth_surface_region_with_cancel(
    source: &SurfaceMesh,
    region: &SurfaceEditRegion,
    parameters: &SurfaceSmoothParameters,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<SurfaceEditResult, SurfaceEditError> {
    validate_edit_input(source, region)?;
    if !parameters.radius.is_finite() || parameters.radius <= 0.0 {
        return Err(SurfaceEditError::InvalidParameters(
            "filter radius must be finite and positive",
        ));
    }
    let patch = EditPatch::capture(source, region)?;
    let affected_vertices = patch.affected_vertices.iter().copied().collect::<Vec<_>>();
    let mut filtered = BTreeMap::<u32, f64>::new();
    for (ordinal, vertex) in affected_vertices.iter().copied().enumerate() {
        if ordinal % 4_096 == 0 && is_cancelled() {
            return Err(SurfaceEditError::Cancelled);
        }
        if patch.protected_vertices.contains(&vertex) {
            continue;
        }
        let point = source.positions[vertex as usize];
        let mut neighbours = affected_vertices
            .iter()
            .copied()
            .filter_map(|candidate| {
                let other = source.positions[candidate as usize];
                let distance = distance_xy([point[0], point[1]], [other[0], other[1]]);
                (distance <= parameters.radius).then_some((candidate, distance, other[2]))
            })
            .collect::<Vec<_>>();
        neighbours.sort_by(|left, right| left.0.cmp(&right.0));
        if neighbours.is_empty() {
            continue;
        }
        let z = match parameters.filter {
            SurfaceSmoothFilter::Gaussian => {
                let sigma = parameters.radius / 3.0;
                let (weighted, weights) =
                    neighbours
                        .iter()
                        .fold((0.0, 0.0), |(weighted, weights), (_, distance, z)| {
                            let weight = (-0.5 * (distance / sigma).powi(2)).exp();
                            (weighted + weight * z, weights + weight)
                        });
                weighted / weights
            }
            SurfaceSmoothFilter::Median => {
                let mut heights = neighbours.iter().map(|(_, _, z)| *z).collect::<Vec<_>>();
                heights.sort_by(f64::total_cmp);
                let middle = heights.len() / 2;
                if heights.len() % 2 == 0 {
                    (heights[middle - 1] + heights[middle]) * 0.5
                } else {
                    heights[middle]
                }
            }
        };
        if !z.is_finite() {
            return Err(SurfaceEditError::InvalidMesh(
                "height filter produced a non-finite value",
            ));
        }
        filtered.insert(vertex, z);
    }
    let candidate = refill_patch(
        source,
        &patch,
        |vertex| {
            filtered
                .get(&vertex)
                .copied()
                .unwrap_or(source.positions[vertex as usize][2])
        },
        |_| true,
    )?;
    finish_edit(source, region, &patch, candidate, None, &mut is_cancelled)
}

/// Deterministically proposes a reduced constrained patch, then certifies the
/// exact maximum of the two piecewise-linear height fields over their overlay.
/// If the proposal cannot meet the requested bound it returns the unchanged
/// source mesh, never a relaxed or sampled-only result.
pub fn downsample_surface_region(
    source: &SurfaceMesh,
    region: &SurfaceEditRegion,
    parameters: &SurfaceDownsampleParameters,
) -> Result<SurfaceEditResult, SurfaceEditError> {
    downsample_surface_region_with_cancel(source, region, parameters, || false)
}

pub fn downsample_surface_region_with_cancel(
    source: &SurfaceMesh,
    region: &SurfaceEditRegion,
    parameters: &SurfaceDownsampleParameters,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<SurfaceEditResult, SurfaceEditError> {
    validate_edit_input(source, region)?;
    if !parameters.maximum_vertical_error.is_finite() || parameters.maximum_vertical_error < 0.0 {
        return Err(SurfaceEditError::InvalidParameters(
            "maximum vertical error must be finite and non-negative",
        ));
    }
    let patch = EditPatch::capture(source, region)?;
    let mut z_extrema = None::<(u32, u32)>;
    for vertex in patch.affected_vertices.iter().copied() {
        z_extrema = Some(match z_extrema {
            None => (vertex, vertex),
            Some((minimum, maximum)) => {
                let z = source.positions[vertex as usize][2];
                let min = if z < source.positions[minimum as usize][2] {
                    vertex
                } else {
                    minimum
                };
                let max = if z > source.positions[maximum as usize][2] {
                    vertex
                } else {
                    maximum
                };
                (min, max)
            }
        });
    }
    let mut ordinal = 0_usize;
    let candidate = refill_patch(
        source,
        &patch,
        |vertex| source.positions[vertex as usize][2],
        |vertex| {
            let retain = patch.protected_vertices.contains(&vertex)
                || z_extrema
                    .is_some_and(|(minimum, maximum)| vertex == minimum || vertex == maximum)
                || {
                    let keep = ordinal % 4 == 3;
                    ordinal += 1;
                    keep
                };
            retain
        },
    )?;
    let result = finish_edit(
        source,
        region,
        &patch,
        candidate,
        Some(parameters.maximum_vertical_error),
        &mut is_cancelled,
    )?;
    if result.metrics.error.maximum_vertical_error
        <= parameters.maximum_vertical_error + f64::EPSILON * 32.0
    {
        return Ok(result);
    }
    // A verified no-op is preferable to silently exceeding domain truth. This
    // also makes zero-tolerance and adversarial ridges deterministic.
    finish_edit(
        source,
        region,
        &patch,
        source.clone(),
        Some(parameters.maximum_vertical_error),
        &mut is_cancelled,
    )
}

/// Hashes only original positions used by outside triangles and the exact
/// outside triangle index triples. It is the executable outside-identity gate.
pub fn surface_outside_region_identity_hash(
    mesh: &SurfaceMesh,
    region: &SurfaceEditRegion,
) -> Result<ObjectHash, SurfaceEditError> {
    validate_edit_input(mesh, region)?;
    let mut triangles = Vec::<[u32; 3]>::new();
    let mut vertices = BTreeSet::<u32>::new();
    for triangle in mesh.indices.chunks_exact(3) {
        let triple = [triangle[0], triangle[1], triangle[2]];
        let points = triple.map(|index| mesh.positions[index as usize]);
        if !point_in_xy_ring(triangle_centroid(points), &region.polygon) {
            triangles.push(triple);
            vertices.extend(triple);
        }
    }
    let positions = vertices
        .into_iter()
        .map(|index| (index, mesh.positions[index as usize].map(f64::to_bits)))
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&(positions, triangles))
        .map_err(|_| SurfaceEditError::InvalidMesh("outside identity is not serializable"))?;
    Ok(ObjectHash::of_bytes(&bytes))
}

#[derive(Debug)]
struct EditPatch {
    affected_faces: BTreeSet<usize>,
    affected_vertices: BTreeSet<u32>,
    protected_vertices: BTreeSet<u32>,
    local_constraints: BTreeSet<[u32; 2]>,
    region_area: f64,
    polygon: Vec<[f64; 2]>,
}

impl EditPatch {
    fn capture(source: &SurfaceMesh, region: &SurfaceEditRegion) -> Result<Self, SurfaceEditError> {
        let mut affected_faces = BTreeSet::new();
        let mut affected_vertices = BTreeSet::new();
        let mut region_area = 0.0;
        let mut edge_faces = BTreeMap::<[u32; 2], Vec<usize>>::new();
        for (face, triangle) in source.indices.chunks_exact(3).enumerate() {
            let triple = [triangle[0], triangle[1], triangle[2]];
            let points = triple.map(|index| source.positions[index as usize]);
            for edge in triangle_edges(triple) {
                edge_faces.entry(sorted_edge(edge)).or_default().push(face);
            }
            if points
                .iter()
                .all(|point| point_in_xy_ring([point[0], point[1]], &region.polygon))
            {
                affected_faces.insert(face);
                affected_vertices.extend(triple);
                region_area += signed_twice_area(points[0], points[1], points[2]).abs() * 0.5;
            }
        }
        if affected_faces.is_empty() {
            return Err(SurfaceEditError::EmptyRegion);
        }
        let mut local_constraints = source
            .constrained_edges
            .iter()
            .copied()
            .map(sorted_edge)
            .collect::<BTreeSet<_>>();
        for (edge, faces) in &edge_faces {
            let affected = faces
                .iter()
                .filter(|face| affected_faces.contains(face))
                .count();
            if faces.len() == 1 || (affected > 0 && affected < faces.len()) {
                local_constraints.insert(*edge);
            }
        }
        let protected_vertices = local_constraints.iter().flatten().copied().collect();
        Ok(Self {
            affected_faces,
            affected_vertices,
            protected_vertices,
            local_constraints,
            region_area,
            polygon: region.polygon.clone(),
        })
    }
}

fn refill_patch(
    source: &SurfaceMesh,
    patch: &EditPatch,
    mut height: impl FnMut(u32) -> f64,
    mut retain: impl FnMut(u32) -> bool,
) -> Result<SurfaceMesh, SurfaceEditError> {
    let mut local_source = patch
        .affected_vertices
        .iter()
        .copied()
        .filter(|vertex| patch.protected_vertices.contains(vertex) || retain(*vertex))
        .collect::<Vec<_>>();
    local_source.sort_by(|left, right| {
        let a = source.positions[*left as usize];
        let b = source.positions[*right as usize];
        (a[0].total_cmp(&b[0]))
            .then(a[1].total_cmp(&b[1]))
            .then(a[2].total_cmp(&b[2]))
            .then(left.cmp(right))
    });
    local_source.dedup();
    if local_source.len() < 3 {
        return Err(SurfaceEditError::Triangulation(
            "region has fewer than three retained vertices".to_owned(),
        ));
    }
    let local_index = local_source
        .iter()
        .enumerate()
        .map(|(index, vertex)| (*vertex, index))
        .collect::<BTreeMap<_, _>>();
    let constraints = patch
        .local_constraints
        .iter()
        .filter_map(|edge| Some([*local_index.get(&edge[0])?, *local_index.get(&edge[1])?]))
        .collect::<Vec<_>>();
    let vertices = local_source
        .iter()
        .map(|vertex| {
            let point = source.positions[*vertex as usize];
            Vertex {
                xy: Point2::new(point[0], point[1]),
            }
        })
        .collect::<Vec<_>>();
    let triangulation =
        ConstrainedDelaunayTriangulation::<Vertex>::bulk_load_cdt(vertices, constraints)
            .map_err(|error| SurfaceEditError::Triangulation(error.to_string()))?;
    let mut positions = source.positions.clone();
    let mut output_index = Vec::with_capacity(local_source.len());
    for source_index in &local_source {
        if patch.protected_vertices.contains(source_index) {
            output_index.push(*source_index);
        } else {
            let mut point = source.positions[*source_index as usize];
            point[2] = height(*source_index);
            if !point[2].is_finite() {
                return Err(SurfaceEditError::InvalidMesh(
                    "replacement contains a non-finite height",
                ));
            }
            let index = u32::try_from(positions.len())
                .map_err(|_| SurfaceEditError::InvalidMesh("mesh exceeds u32 vertex indices"))?;
            positions.push(point);
            output_index.push(index);
        }
    }
    let source_patch_triangles = patch
        .affected_faces
        .iter()
        .map(|face| {
            let offset = face * 3;
            [
                source.positions[source.indices[offset] as usize],
                source.positions[source.indices[offset + 1] as usize],
                source.positions[source.indices[offset + 2] as usize],
            ]
        })
        .collect::<Vec<_>>();
    let mut replacement = Vec::<[u32; 3]>::new();
    for face in triangulation.inner_faces() {
        let local = face.vertices().map(|vertex| vertex.fix().index());
        let output = local.map(|index| output_index[index]);
        let points = output.map(|index| positions[index as usize]);
        let centroid = triangle_centroid(points);
        if source_patch_triangles
            .iter()
            .any(|triangle| point_in_triangle(centroid, *triangle))
            && point_in_xy_ring(centroid, &patch.polygon)
            && signed_twice_area(points[0], points[1], points[2]).abs() > f64::EPSILON
        {
            replacement.push(output);
        }
    }
    replacement.sort_by_key(|triangle| {
        let mut normalized = *triangle;
        normalized.sort_unstable();
        normalized
    });
    if replacement.is_empty() {
        return Err(SurfaceEditError::Triangulation(
            "replacement triangulation is empty".to_owned(),
        ));
    }
    let mut indices = Vec::with_capacity(source.indices.len());
    for (face, triangle) in source.indices.chunks_exact(3).enumerate() {
        if !patch.affected_faces.contains(&face) {
            indices.extend_from_slice(triangle);
        }
    }
    indices.extend(replacement.into_iter().flatten());
    let active = indices.iter().copied().collect::<BTreeSet<_>>();
    let z_min = active
        .iter()
        .map(|index| positions[*index as usize][2])
        .fold(f64::INFINITY, f64::min);
    let z_max = active
        .iter()
        .map(|index| positions[*index as usize][2])
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(SurfaceMesh {
        positions,
        indices,
        constrained_edges: source.constrained_edges.clone(),
        projected_area: source.projected_area,
        z_range: [z_min, z_max],
        source_residual: source.source_residual,
    })
}

fn finish_edit(
    source: &SurfaceMesh,
    region: &SurfaceEditRegion,
    patch: &EditPatch,
    candidate: SurfaceMesh,
    target: Option<f64>,
    is_cancelled: &mut impl FnMut() -> bool,
) -> Result<SurfaceEditResult, SurfaceEditError> {
    let error = certify_vertical_error(source, &candidate, patch, target, is_cancelled)?;
    let outside_identity_hash = surface_outside_region_identity_hash(&candidate, region)?;
    let source_outside = surface_outside_region_identity_hash(source, region)?;
    if outside_identity_hash != source_outside {
        return Err(SurfaceEditError::InvalidMesh(
            "outside-region identity changed",
        ));
    }
    let vertices_before = active_vertex_count(&source.indices);
    let vertices_after = active_vertex_count(&candidate.indices);
    let result_hash = ObjectHash::of_bytes(
        &serde_json::to_vec(&candidate)
            .map_err(|_| SurfaceEditError::InvalidMesh("result is not serializable"))?,
    );
    Ok(SurfaceEditResult {
        metrics: SurfaceEditMetrics {
            vertices_before,
            vertices_after,
            triangles_before: source.indices.len() / 3,
            triangles_after: candidate.indices.len() / 3,
            affected_triangles: patch.affected_faces.len(),
            region_area: patch.region_area,
            error,
            outside_identity_hash,
            result_hash,
        },
        mesh: candidate,
    })
}

fn certify_vertical_error(
    source: &SurfaceMesh,
    candidate: &SurfaceMesh,
    patch: &EditPatch,
    target: Option<f64>,
    is_cancelled: &mut impl FnMut() -> bool,
) -> Result<SurfaceErrorCertificate, SurfaceEditError> {
    let mut locations = patch
        .affected_vertices
        .iter()
        .map(|index| {
            let point = source.positions[*index as usize];
            [point[0], point[1]]
        })
        .collect::<Vec<_>>();
    let source_edges = patch_edges(source, &patch.affected_faces);
    let candidate_faces = candidate
        .indices
        .chunks_exact(3)
        .enumerate()
        .filter_map(|(face, triangle)| {
            let points = [triangle[0], triangle[1], triangle[2]]
                .map(|index| candidate.positions[index as usize]);
            point_in_xy_ring(triangle_centroid(points), &patch.polygon).then_some(face)
        })
        .collect::<BTreeSet<_>>();
    let candidate_edges = patch_edges(candidate, &candidate_faces);
    locations.extend(candidate_edges.iter().flat_map(|edge| {
        edge.iter().map(|index| {
            let point = candidate.positions[*index as usize];
            [point[0], point[1]]
        })
    }));
    for (left_index, left) in source_edges.iter().enumerate() {
        if left_index % 512 == 0 && is_cancelled() {
            return Err(SurfaceEditError::Cancelled);
        }
        let a = source.positions[left[0] as usize];
        let b = source.positions[left[1] as usize];
        for right in &candidate_edges {
            let c = candidate.positions[right[0] as usize];
            let d = candidate.positions[right[1] as usize];
            if let Some(point) = segment_intersection_xy(a, b, c, d) {
                locations.push(point);
            }
        }
    }
    locations.sort_by(|left, right| {
        left[0]
            .total_cmp(&right[0])
            .then(left[1].total_cmp(&right[1]))
    });
    locations.dedup_by(|left, right| {
        left[0].to_bits() == right[0].to_bits() && left[1].to_bits() == right[1].to_bits()
    });
    let mut maximum = 0.0_f64;
    let mut squares = 0.0_f64;
    let mut count = 0_usize;
    for (index, location) in locations.into_iter().enumerate() {
        if index % 4_096 == 0 && is_cancelled() {
            return Err(SurfaceEditError::Cancelled);
        }
        let Some(left) = evaluate_mesh_z(source, location) else {
            continue;
        };
        let Some(right) = evaluate_mesh_z(candidate, location) else {
            continue;
        };
        let error = (left - right).abs();
        maximum = maximum.max(error);
        squares += error * error;
        count += 1;
    }
    if count == 0 {
        return Err(SurfaceEditError::InvalidMesh(
            "vertical error domain is empty",
        ));
    }
    let rms = (squares / count as f64).sqrt();
    Ok(SurfaceErrorCertificate {
        metric: "continuous_piecewise_linear_vertical_overlay".to_owned(),
        sample_count: count,
        maximum_vertical_error: maximum,
        rms_vertical_error: rms,
        target_vertical_error: target,
        certified: target.is_none_or(|bound| maximum <= bound + f64::EPSILON * 32.0),
    })
}

fn patch_edges(mesh: &SurfaceMesh, faces: &BTreeSet<usize>) -> BTreeSet<[u32; 2]> {
    faces
        .iter()
        .flat_map(|face| {
            let offset = face * 3;
            triangle_edges([
                mesh.indices[offset],
                mesh.indices[offset + 1],
                mesh.indices[offset + 2],
            ])
        })
        .map(sorted_edge)
        .collect()
}

fn validate_edit_input(
    mesh: &SurfaceMesh,
    region: &SurfaceEditRegion,
) -> Result<(), SurfaceEditError> {
    if mesh.indices.is_empty() || mesh.indices.len() % 3 != 0 {
        return Err(SurfaceEditError::InvalidMesh(
            "indices must contain complete triangles",
        ));
    }
    if mesh
        .positions
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(SurfaceEditError::InvalidMesh("positions must be finite"));
    }
    if mesh
        .indices
        .iter()
        .any(|index| *index as usize >= mesh.positions.len())
        || mesh
            .constrained_edges
            .iter()
            .flatten()
            .any(|index| *index as usize >= mesh.positions.len())
    {
        return Err(SurfaceEditError::InvalidMesh("an index is out of range"));
    }
    if region.polygon.len() < 3
        || region
            .polygon
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(SurfaceEditError::InvalidRegion(
            "polygon needs three finite vertices",
        ));
    }
    let area = region
        .polygon
        .iter()
        .zip(region.polygon.iter().cycle().skip(1))
        .map(|(left, right)| left[0] * right[1] - right[0] * left[1])
        .sum::<f64>()
        .abs()
        * 0.5;
    if area <= f64::EPSILON {
        return Err(SurfaceEditError::InvalidRegion(
            "polygon area must be positive",
        ));
    }
    Ok(())
}

fn evaluate_mesh_z(mesh: &SurfaceMesh, point: [f64; 2]) -> Option<f64> {
    for triangle in mesh.indices.chunks_exact(3) {
        let p = [triangle[0], triangle[1], triangle[2]].map(|index| mesh.positions[index as usize]);
        let denominator = signed_twice_area(p[0], p[1], p[2]);
        if denominator.abs() <= f64::EPSILON {
            continue;
        }
        let w0 = ((p[1][0] - point[0]) * (p[2][1] - point[1])
            - (p[2][0] - point[0]) * (p[1][1] - point[1]))
            / denominator;
        let w1 = ((p[2][0] - point[0]) * (p[0][1] - point[1])
            - (p[0][0] - point[0]) * (p[2][1] - point[1]))
            / denominator;
        let w2 = 1.0 - w0 - w1;
        if w0 >= -1.0e-10 && w1 >= -1.0e-10 && w2 >= -1.0e-10 {
            return Some(w0 * p[0][2] + w1 * p[1][2] + w2 * p[2][2]);
        }
    }
    None
}

fn point_in_triangle(point: [f64; 2], triangle: [[f64; 3]; 3]) -> bool {
    let area = signed_twice_area(triangle[0], triangle[1], triangle[2]);
    if area.abs() <= f64::EPSILON {
        return false;
    }
    let side = |a: [f64; 3], b: [f64; 3]| {
        ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) / area
    };
    side(triangle[0], triangle[1]) >= -1.0e-10
        && side(triangle[1], triangle[2]) >= -1.0e-10
        && side(triangle[2], triangle[0]) >= -1.0e-10
}

fn segment_intersection_xy(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> Option<[f64; 2]> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let denominator = r[0] * s[1] - r[1] * s[0];
    if denominator.abs() <= 1.0e-14 {
        return None;
    }
    let q = [c[0] - a[0], c[1] - a[1]];
    let t = (q[0] * s[1] - q[1] * s[0]) / denominator;
    let u = (q[0] * r[1] - q[1] * r[0]) / denominator;
    if (-1.0e-12..=1.0 + 1.0e-12).contains(&t) && (-1.0e-12..=1.0 + 1.0e-12).contains(&u) {
        Some([a[0] + t * r[0], a[1] + t * r[1]])
    } else {
        None
    }
}

fn triangle_edges(triangle: [u32; 3]) -> [[u32; 2]; 3] {
    [
        [triangle[0], triangle[1]],
        [triangle[1], triangle[2]],
        [triangle[2], triangle[0]],
    ]
}

fn sorted_edge(mut edge: [u32; 2]) -> [u32; 2] {
    edge.sort_unstable();
    edge
}

fn triangle_centroid(points: [[f64; 3]; 3]) -> [f64; 2] {
    [
        (points[0][0] + points[1][0] + points[2][0]) / 3.0,
        (points[0][1] + points[1][1] + points[2][1]) / 3.0,
    ]
}

fn active_vertex_count(indices: &[u32]) -> usize {
    indices.iter().copied().collect::<BTreeSet<_>>().len()
}

fn validate_rules(rules: &SurfaceRules) -> Result<(), SurfaceBuildError> {
    if !rules.maximum_edge_length.is_finite() || rules.maximum_edge_length <= 0.0 {
        return Err(SurfaceBuildError::InvalidRules(
            "maximum edge length must be finite and positive",
        ));
    }
    if !rules.thin_cloud_spacing.is_finite() || rules.thin_cloud_spacing <= 0.0 {
        return Err(SurfaceBuildError::InvalidRules(
            "thin-cloud spacing must be finite and positive",
        ));
    }
    if !rules.xy_tolerance.is_finite()
        || rules.xy_tolerance <= 0.0
        || !rules.z_tolerance.is_finite()
        || rules.z_tolerance < 0.0
    {
        return Err(SurfaceBuildError::InvalidRules("tolerances are invalid"));
    }
    Ok(())
}

fn admitted_points(draft: &SurfaceDraft) -> Vec<&SurfacePoint> {
    let exclusion_distance = draft.rules.breakline_exclusion_distance;
    let breaklines = draft
        .lines
        .iter()
        .filter(|line| {
            line.role == SurfaceSourceRole::Breakline
                && !draft.excluded_source_ids.contains(&line.source_id)
        })
        .collect::<Vec<_>>();
    draft
        .points
        .iter()
        .chain(draft.lines.iter().flat_map(|line| line.vertices.iter()))
        .filter(|point| {
            !draft.excluded_source_ids.contains(&point.source_id)
                && !draft.excluded_point_ids.contains(&point.point_id)
                && !exclusion_distance.is_some_and(|distance| {
                    draft
                        .points
                        .iter()
                        .any(|source_point| std::ptr::eq(source_point, *point))
                        && breaklines.iter().any(|line| {
                            line.vertices.windows(2).any(|pair| {
                                point_segment_distance(
                                    point.position,
                                    pair[0].position,
                                    pair[1].position,
                                ) <= distance
                            })
                        })
                })
        })
        .collect()
}

fn active_lines(draft: &SurfaceDraft, role: SurfaceSourceRole) -> Vec<&SurfaceLine> {
    draft
        .lines
        .iter()
        .filter(|line| line.role == role && !draft.excluded_source_ids.contains(&line.source_id))
        .collect()
}

#[derive(Clone, Copy)]
struct Segment<'a> {
    source_id: &'a str,
    a: &'a SurfacePoint,
    b: &'a SurfacePoint,
}

fn breakline_segments<'a>(lines: &[&'a SurfaceLine]) -> Vec<Segment<'a>> {
    let mut result = Vec::new();
    for line in lines {
        result.extend(line.vertices.windows(2).map(|pair| Segment {
            source_id: &line.source_id,
            a: &pair[0],
            b: &pair[1],
        }));
        if line.closed && line.vertices.len() > 2 {
            result.push(Segment {
                source_id: &line.source_id,
                a: line.vertices.last().expect("non-empty closed line"),
                b: &line.vertices[0],
            });
        }
    }
    result
}

fn segment_crossing(
    left: &Segment<'_>,
    right: &Segment<'_>,
    tolerance: f64,
) -> Option<([f64; 2], f64, f64)> {
    let p = left.a.position;
    let q = right.a.position;
    let r = [left.b.position[0] - p[0], left.b.position[1] - p[1]];
    let s = [right.b.position[0] - q[0], right.b.position[1] - q[1]];
    let cross = r[0] * s[1] - r[1] * s[0];
    if cross.abs() <= tolerance {
        return None;
    }
    let qp = [q[0] - p[0], q[1] - p[1]];
    let t = (qp[0] * s[1] - qp[1] * s[0]) / cross;
    let u = (qp[0] * r[1] - qp[1] * r[0]) / cross;
    if !(t > tolerance && t < 1.0 - tolerance && u > tolerance && u < 1.0 - tolerance) {
        return None;
    }
    let left_z = left.a.z? + t * (left.b.z? - left.a.z?);
    let right_z = right.a.z? + u * (right.b.z? - right.a.z?);
    Some(([p[0] + t * r[0], p[1] + t * r[1]], left_z, right_z))
}

fn shares_endpoint(left: &Segment<'_>, right: &Segment<'_>, tolerance: f64) -> bool {
    [left.a, left.b].iter().any(|a| {
        [right.a, right.b]
            .iter()
            .any(|b| distance_xy(a.position, b.position) <= tolerance)
    })
}

fn apply_drop(
    draft: &mut SurfaceDraft,
    target: &SurfaceCheckError,
) -> Result<(), SurfaceBuildError> {
    let source = target
        .source_ids
        .first()
        .ok_or(SurfaceBuildError::FixNotApplicable)?;
    if target.code == SurfaceErrorCode::ZeroLengthEdge {
        let line = draft
            .lines
            .iter_mut()
            .find(|line| &line.source_id == source)
            .ok_or(SurfaceBuildError::FixNotApplicable)?;
        line.vertices.dedup_by(|right, left| {
            distance_xy(left.position, right.position) <= draft.rules.xy_tolerance
        });
        return Ok(());
    }
    let location = target.location.ok_or(SurfaceBuildError::FixNotApplicable)?;
    let candidate = draft
        .points
        .iter()
        .filter(|point| {
            distance_xy(point.position, [location[0], location[1]]) <= draft.rules.xy_tolerance
        })
        .max_by(|left, right| left.point_id.cmp(&right.point_id))
        .ok_or(SurfaceBuildError::FixNotApplicable)?;
    draft.excluded_point_ids.insert(candidate.point_id.clone());
    Ok(())
}

fn apply_snap(
    draft: &mut SurfaceDraft,
    target: &SurfaceCheckError,
) -> Result<(), SurfaceBuildError> {
    let source = target
        .source_ids
        .first()
        .ok_or(SurfaceBuildError::FixNotApplicable)?;
    let candidates = draft
        .points
        .iter()
        .filter_map(|point| point.z.map(|z| (point.position, z)))
        .collect::<Vec<_>>();
    let location = target.location.map(|value| [value[0], value[1]]);
    let point = draft
        .points
        .iter_mut()
        .chain(
            draft
                .lines
                .iter_mut()
                .flat_map(|line| line.vertices.iter_mut()),
        )
        .find(|point| {
            &point.source_id == source
                && ((target.code == SurfaceErrorCode::InventedZ && point.z.is_none())
                    || (target.code == SurfaceErrorCode::BreaklineVertexOffPointSet
                        && location.is_some_and(|location| {
                            distance_xy(point.position, location) <= draft.rules.xy_tolerance
                        })))
        })
        .ok_or(SurfaceBuildError::FixNotApplicable)?;
    let nearest = candidates
        .into_iter()
        .min_by(|left, right| {
            distance_xy(point.position, left.0).total_cmp(&distance_xy(point.position, right.0))
        })
        .ok_or(SurfaceBuildError::FixNotApplicable)?;
    point.position = nearest.0;
    point.z = Some(nearest.1);
    // Snapping a heightless point-source vertex onto an authoritative point
    // coalesces the invalid draft vertex. Keeping both would turn one repaired
    // diagnostic into a new duplicate-point diagnostic.
    if target.code == SurfaceErrorCode::InventedZ {
        let snapped_point_id = point.point_id.clone();
        draft.excluded_point_ids.insert(snapped_point_id);
    }
    Ok(())
}

fn apply_split(
    draft: &mut SurfaceDraft,
    target: &SurfaceCheckError,
    authority: Option<&str>,
) -> Result<(), SurfaceBuildError> {
    let [left_id, right_id] = target.source_ids.as_slice() else {
        return Err(SurfaceBuildError::FixNotApplicable);
    };
    let location = target.location.ok_or(SurfaceBuildError::FixNotApplicable)?;
    let agreed = location[2].is_finite();
    let authority = if agreed {
        left_id.as_str()
    } else {
        authority.ok_or(SurfaceBuildError::FixNotApplicable)?
    };
    if authority != left_id && authority != right_id {
        return Err(SurfaceBuildError::FixNotApplicable);
    }
    let z = if agreed {
        location[2]
    } else {
        let line = draft
            .lines
            .iter()
            .find(|line| line.source_id == authority)
            .ok_or(SurfaceBuildError::FixNotApplicable)?;
        interpolate_line_z(line, [location[0], location[1]], draft.rules.xy_tolerance)
            .ok_or(SurfaceBuildError::FixNotApplicable)?
    };
    for source in [left_id, right_id] {
        let line = draft
            .lines
            .iter_mut()
            .find(|line| line.source_id == *source)
            .ok_or(SurfaceBuildError::FixNotApplicable)?;
        insert_line_vertex(
            line,
            [location[0], location[1]],
            z,
            draft.rules.xy_tolerance,
        )?;
    }
    Ok(())
}

fn insert_line_vertex(
    line: &mut SurfaceLine,
    xy: [f64; 2],
    z: f64,
    tolerance: f64,
) -> Result<(), SurfaceBuildError> {
    let mut insert_at = None;
    for (index, pair) in line.vertices.windows(2).enumerate() {
        if point_on_segment(xy, pair[0].position, pair[1].position, tolerance) {
            insert_at = Some(index + 1);
            break;
        }
    }
    let index = insert_at.ok_or(SurfaceBuildError::FixNotApplicable)?;
    line.vertices.insert(
        index,
        SurfacePoint {
            point_id: format!("{}:split:{:.12}:{:.12}", line.source_id, xy[0], xy[1]),
            source_id: line.source_id.clone(),
            position: xy,
            z: Some(z),
        },
    );
    Ok(())
}

fn interpolate_line_z(line: &SurfaceLine, xy: [f64; 2], tolerance: f64) -> Option<f64> {
    for pair in line.vertices.windows(2) {
        if !point_on_segment(xy, pair[0].position, pair[1].position, tolerance) {
            continue;
        }
        let length = distance_xy(pair[0].position, pair[1].position);
        let t = if length <= tolerance {
            0.0
        } else {
            distance_xy(pair[0].position, xy) / length
        };
        return Some(pair[0].z? + t * (pair[1].z? - pair[0].z?));
    }
    None
}

fn point_on_segment(point: [f64; 2], a: [f64; 2], b: [f64; 2], tolerance: f64) -> bool {
    let length = distance_xy(a, b);
    (distance_xy(a, point) + distance_xy(point, b) - length).abs() <= tolerance
}

fn point_segment_distance(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let delta = [b[0] - a[0], b[1] - a[1]];
    let length_squared = delta[0] * delta[0] + delta[1] * delta[1];
    if length_squared == 0.0 {
        return distance_xy(point, a);
    }
    let projection = (((point[0] - a[0]) * delta[0] + (point[1] - a[1]) * delta[1])
        / length_squared)
        .clamp(0.0, 1.0);
    distance_xy(
        point,
        [a[0] + projection * delta[0], a[1] + projection * delta[1]],
    )
}

fn error(
    code: SurfaceErrorCode,
    message: String,
    mut source_ids: Vec<String>,
    location: Option<[f64; 3]>,
    fixes: Vec<SurfaceFixKind>,
) -> SurfaceCheckError {
    source_ids.sort();
    source_ids.dedup();
    let location_key = location
        .map(|value| format!("{:.9}:{:.9}", value[0], value[1]))
        .unwrap_or_default();
    SurfaceCheckError {
        error_id: format!("{:?}:{}:{location_key}", code, source_ids.join("+")),
        code,
        severity: SurfaceErrorSeverity::Error,
        message,
        source_ids,
        location,
        fixes,
        blocks_publish: true,
    }
}

fn quantized_key(position: [f64; 2], tolerance: f64) -> (i64, i64) {
    (
        (position[0] / tolerance).round() as i64,
        (position[1] / tolerance).round() as i64,
    )
}

fn distance_xy(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn distinct_xy(points: &[SurfacePoint], tolerance: f64) -> usize {
    points
        .iter()
        .map(|point| quantized_key(point.position, tolerance))
        .collect::<BTreeSet<_>>()
        .len()
}

fn point_location(point: &SurfacePoint) -> Option<[f64; 3]> {
    point.z.map(|z| [point.position[0], point.position[1], z])
}

fn point_in_ring(point: [f64; 2], ring: &[SurfacePoint], tolerance: f64) -> bool {
    if ring
        .windows(2)
        .any(|pair| point_on_segment(point, pair[0].position, pair[1].position, tolerance))
    {
        return true;
    }
    point_in_xy_ring(
        point,
        &ring.iter().map(|value| value.position).collect::<Vec<_>>(),
    )
}

fn point_in_xy_ring(point: [f64; 2], ring: &[[f64; 2]]) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut previous = *ring.last().expect("ring has at least three points");
    for current in ring {
        let crosses = (current[1] > point[1]) != (previous[1] > point[1])
            && point[0]
                < (previous[0] - current[0]) * (point[1] - current[1]) / (previous[1] - current[1])
                    + current[0];
        inside ^= crosses;
        previous = *current;
    }
    inside
}

fn triangle_max_edge(points: [[f64; 3]; 3]) -> f64 {
    distance_xy([points[0][0], points[0][1]], [points[1][0], points[1][1]])
        .max(distance_xy(
            [points[1][0], points[1][1]],
            [points[2][0], points[2][1]],
        ))
        .max(distance_xy(
            [points[2][0], points[2][1]],
            [points[0][0], points[0][1]],
        ))
}

fn signed_twice_area(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(id: &str, x: f64, y: f64, z: Option<f64>) -> SurfacePoint {
        SurfacePoint {
            point_id: id.to_owned(),
            source_id: id.to_owned(),
            position: [x, y],
            z,
        }
    }

    fn fixture() -> SurfaceDraft {
        SurfaceDraft {
            draft_id: "mesh-draft-1".to_owned(),
            name: "Road DGM".to_owned(),
            points: vec![
                point("p0", 0.0, 0.0, Some(100.0)),
                point("p1", 10.0, 0.0, Some(101.0)),
                point("p2", 10.0, 10.0, Some(102.0)),
                point("p3", 0.0, 10.0, Some(101.0)),
                point("p4", 5.0, 5.0, Some(101.5)),
            ],
            lines: Vec::new(),
            rules: SurfaceRules {
                maximum_edge_length: 20.0,
                ..SurfaceRules::default()
            },
            excluded_source_ids: BTreeSet::new(),
            excluded_point_ids: BTreeSet::new(),
        }
    }

    fn edit_fixture(curved: bool) -> SurfaceMesh {
        let mut positions = Vec::new();
        for y in 0..=4 {
            for x in 0..=4 {
                let z = if curved && x == 2 && y == 2 { 1.0 } else { 0.0 };
                positions.push([x as f64, y as f64, z]);
            }
        }
        let mut indices = Vec::new();
        for y in 0..4_u32 {
            for x in 0..4_u32 {
                let a = y * 5 + x;
                let b = a + 1;
                let d = (y + 1) * 5 + x;
                let c = d + 1;
                indices.extend_from_slice(&[a, b, c, a, c, d]);
            }
        }
        SurfaceMesh {
            positions,
            indices,
            constrained_edges: vec![[10, 11], [11, 12], [12, 13], [13, 14]],
            projected_area: 16.0,
            z_range: [0.0, if curved { 1.0 } else { 0.0 }],
            source_residual: SurfaceResidual {
                count: 25,
                mean_absolute: 0.0,
                maximum_absolute: 0.0,
            },
        }
    }

    fn edit_region() -> SurfaceEditRegion {
        SurfaceEditRegion {
            source: SurfaceRegionSource::Fence,
            polygon: vec![[0.9, 0.9], [3.1, 0.9], [3.1, 3.1], [0.9, 3.1]],
        }
    }

    #[test]
    fn mesh_surface_fixture_produces_typed_summary() {
        let mesh = triangulate_surface(&fixture()).expect("mesh");
        assert_eq!(mesh.indices.len() % 3, 0);
        assert!(mesh.indices.len() >= 12);
        assert!((mesh.projected_area - 100.0).abs() < 1.0e-9);
        assert_eq!(mesh.z_range, [100.0, 102.0]);
        assert_eq!(mesh.source_residual.maximum_absolute, 0.0);
    }

    #[test]
    fn mesh_surface_check_reports_no_invented_z_and_fix_is_local() {
        let mut draft = fixture();
        draft.points[4].z = None;
        let before = check_surface_draft(&draft).expect("check");
        let target = before
            .errors
            .iter()
            .find(|item| item.code == SurfaceErrorCode::InventedZ)
            .expect("invented z");
        let fixed = apply_surface_fix(
            &draft,
            &SurfaceFixRequest {
                error_id: target.error_id.clone(),
                fix: SurfaceFixKind::Snap,
                authority_source_id: None,
            },
        )
        .expect("fix");
        assert_eq!(draft.points[4].z, None, "source snapshot is immutable");
        assert!(fixed
            .check
            .errors
            .iter()
            .all(|item| item.code != SurfaceErrorCode::InventedZ));
        assert_eq!(fixed.introduced_error_ids, Vec::<String>::new());
    }

    #[test]
    fn mesh_surface_crossing_requires_explicit_z_authority() {
        let mut draft = fixture();
        draft.lines = vec![
            SurfaceLine {
                source_id: "break-a".to_owned(),
                role: SurfaceSourceRole::Breakline,
                vertices: vec![
                    point("p0", 0.0, 0.0, Some(100.0)),
                    point("p2", 10.0, 10.0, Some(102.0)),
                ],
                closed: false,
            },
            SurfaceLine {
                source_id: "break-b".to_owned(),
                role: SurfaceSourceRole::Breakline,
                vertices: vec![
                    point("p3", 0.0, 10.0, Some(103.0)),
                    point("p1", 10.0, 0.0, Some(103.0)),
                ],
                closed: false,
            },
        ];
        let check = check_surface_draft(&draft).expect("check");
        let crossing = check
            .errors
            .iter()
            .find(|item| item.code == SurfaceErrorCode::CrossingBreaklines)
            .expect("crossing");
        assert!(apply_surface_fix(
            &draft,
            &SurfaceFixRequest {
                error_id: crossing.error_id.clone(),
                fix: SurfaceFixKind::Split,
                authority_source_id: None,
            }
        )
        .is_err());
        let fixed = apply_surface_fix(
            &draft,
            &SurfaceFixRequest {
                error_id: crossing.error_id.clone(),
                fix: SurfaceFixKind::Split,
                authority_source_id: Some("break-a".to_owned()),
            },
        )
        .expect("explicit authority");
        assert!(fixed
            .check
            .errors
            .iter()
            .all(|item| item.code != SurfaceErrorCode::CrossingBreaklines));
    }

    #[test]
    fn mesh_surface_constraints_and_boundary_are_retained() {
        let mut draft = fixture();
        draft.lines.push(SurfaceLine {
            source_id: "boundary".to_owned(),
            role: SurfaceSourceRole::OuterBoundary,
            vertices: vec![
                point("p0", 0.0, 0.0, Some(100.0)),
                point("p1", 10.0, 0.0, Some(101.0)),
                point("p2", 10.0, 10.0, Some(102.0)),
                point("p3", 0.0, 10.0, Some(101.0)),
            ],
            closed: true,
        });
        let mesh = triangulate_surface(&draft).expect("mesh");
        assert_eq!(mesh.constrained_edges.len(), 4);
        let output_edges = mesh
            .indices
            .chunks_exact(3)
            .flat_map(|triangle| {
                [
                    [triangle[0], triangle[1]],
                    [triangle[1], triangle[2]],
                    [triangle[2], triangle[0]],
                ]
            })
            .map(|mut edge| {
                edge.sort_unstable();
                edge
            })
            .collect::<BTreeSet<_>>();
        for mut edge in mesh.constrained_edges.clone() {
            edge.sort_unstable();
            assert!(output_edges.contains(&edge));
        }
    }

    #[test]
    fn mesh_surface_cancel_never_returns_partial_topology() {
        let result = triangulate_surface_with_cancel(&fixture(), || true);
        assert_eq!(result, Err(SurfaceBuildError::Cancelled));
    }

    #[test]
    fn mesh_surface_drop_and_exclude_report_exact_error_delta() {
        let mut duplicate = fixture();
        duplicate.points.push(point("p5", 5.0, 5.0, Some(101.5)));
        let check = check_surface_draft(&duplicate).expect("duplicate check");
        let error = check
            .errors
            .iter()
            .find(|item| item.code == SurfaceErrorCode::DuplicatePoints)
            .expect("duplicate");
        let fixed = apply_surface_fix(
            &duplicate,
            &SurfaceFixRequest {
                error_id: error.error_id.clone(),
                fix: SurfaceFixKind::Drop,
                authority_source_id: None,
            },
        )
        .expect("drop");
        assert!(fixed.resolved_error_ids.contains(&error.error_id));
        assert!(fixed.introduced_error_ids.is_empty());

        let mut invalid = fixture();
        invalid.points[4].z = None;
        let check = check_surface_draft(&invalid).expect("height check");
        let error = check
            .errors
            .iter()
            .find(|item| item.code == SurfaceErrorCode::InventedZ)
            .expect("heightless");
        let fixed = apply_surface_fix(
            &invalid,
            &SurfaceFixRequest {
                error_id: error.error_id.clone(),
                fix: SurfaceFixKind::Exclude,
                authority_source_id: None,
            },
        )
        .expect("exclude");
        assert!(fixed.resolved_error_ids.contains(&error.error_id));
        assert!(fixed.introduced_error_ids.is_empty());
    }

    #[test]
    fn mesh_surface_auto_boundary_and_2d_crop_remove_long_or_outside_faces() {
        let mut draft = fixture();
        draft.rules.maximum_edge_length = 11.0;
        draft.rules.crop_polyline = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [0.0, 6.0]];
        let mesh = triangulate_surface(&draft).expect("cropped mesh");
        assert!(mesh.projected_area > 0.0);
        assert!(mesh.projected_area < 100.0);
        for triangle in mesh.indices.chunks_exact(3) {
            let centroid_y = triangle
                .iter()
                .map(|index| mesh.positions[*index as usize][1])
                .sum::<f64>()
                / 3.0;
            assert!(centroid_y <= 6.0);
        }
    }

    #[test]
    fn mesh_surface_smooth_preserves_outside_and_protected_constraints() {
        let source = edit_fixture(true);
        let outside = surface_outside_region_identity_hash(&source, &edit_region()).unwrap();
        let result = smooth_surface_region(
            &source,
            &edit_region(),
            &SurfaceSmoothParameters {
                filter: SurfaceSmoothFilter::Gaussian,
                radius: 2.0,
            },
        )
        .expect("smooth");
        assert_eq!(
            surface_outside_region_identity_hash(&result.mesh, &edit_region()).unwrap(),
            outside
        );
        assert_eq!(result.mesh.constrained_edges, source.constrained_edges);
        for edge in &source.constrained_edges {
            for vertex in edge {
                assert_eq!(
                    result.mesh.positions[*vertex as usize].map(f64::to_bits),
                    source.positions[*vertex as usize].map(f64::to_bits)
                );
            }
        }
        assert!(result.metrics.error.maximum_vertical_error > 0.0);
    }

    #[test]
    fn mesh_surface_smooth_and_downsample_are_deterministic() {
        let source = edit_fixture(true);
        let smooth = || {
            smooth_surface_region(
                &source,
                &edit_region(),
                &SurfaceSmoothParameters {
                    filter: SurfaceSmoothFilter::Median,
                    radius: 2.0,
                },
            )
            .unwrap()
        };
        assert_eq!(smooth().metrics.result_hash, smooth().metrics.result_hash);

        let mut plane = edit_fixture(false);
        plane.constrained_edges.clear();
        let simplify = || {
            downsample_surface_region(
                &plane,
                &edit_region(),
                &SurfaceDownsampleParameters {
                    maximum_vertical_error: 0.02,
                },
            )
            .unwrap()
        };
        let first = simplify();
        let second = simplify();
        assert_eq!(first.metrics.result_hash, second.metrics.result_hash);
        assert!(first.metrics.vertices_after < first.metrics.vertices_before);
        assert!(first.metrics.error.certified);
        assert!(first.metrics.error.maximum_vertical_error <= 0.02);
    }

    #[test]
    fn mesh_surface_downsample_never_relaxes_error_and_cancel_publishes_nothing() {
        let source = edit_fixture(true);
        let result = downsample_surface_region(
            &source,
            &edit_region(),
            &SurfaceDownsampleParameters {
                maximum_vertical_error: 0.0,
            },
        )
        .expect("verified fallback");
        assert!(result.metrics.error.certified);
        assert_eq!(result.metrics.error.maximum_vertical_error, 0.0);
        assert_eq!(result.mesh, source);

        assert_eq!(
            smooth_surface_region_with_cancel(
                &source,
                &edit_region(),
                &SurfaceSmoothParameters {
                    filter: SurfaceSmoothFilter::Gaussian,
                    radius: 1.0,
                },
                || true,
            ),
            Err(SurfaceEditError::Cancelled)
        );
    }
}
