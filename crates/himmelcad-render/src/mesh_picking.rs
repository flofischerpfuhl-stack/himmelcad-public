//! Owned exact triangle-mesh picking with compact primitive mapping and a bounded BVH.

use std::collections::BTreeSet;
use std::mem::size_of;
use std::sync::Arc;

use glam::{DMat4, DVec3};
use thiserror::Error;

use crate::{PickCandidate, PickRefinementRequest, SnapKind, WorldRay, WorldTransform, WorldVec3};

const LEAF_TRIANGLES: usize = 8;

/// One f64-authoritative mesh leaf before render-relative f32 packing.
#[derive(Debug, Clone, Copy)]
pub struct TriangleMeshPickSource<'a> {
    /// Source-local f64 positions.
    pub positions: &'a [WorldVec3],
    /// Source triangle-list indices.
    pub indices: &'a [u32],
    /// Source-local to leaf-frame transform.
    pub transform: WorldTransform,
    /// Exact project-world coordinate represented by the transformed leaf origin.
    pub leaf_origin: WorldVec3,
    /// First primitive identifier written into the GPU pick buffer for this leaf.
    pub gpu_primitive_base: u32,
    /// Stable source-triangle identifier corresponding to the first triangle.
    pub source_primitive_base: u64,
}

/// One placement of a shared triangle model in an instanced pick index.
#[derive(Debug, Clone, Copy)]
pub struct TriangleMeshPickInstance {
    /// Model-local to project-world transform.
    pub world_from_model: WorldTransform,
    /// First primitive identifier written by this instance into the GPU pick buffer.
    pub gpu_primitive_base: u32,
    /// First stable source-triangle identifier represented by this instance.
    pub source_primitive_base: u64,
}

/// Invalid exact mesh input or overlapping primitive ranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TriangleMeshPickBuildError {
    /// No source contained a triangle.
    #[error("triangle mesh pick source is empty")]
    Empty,
    /// Indices are not a triangle list or address a missing position.
    #[error("triangle mesh pick source has invalid indices")]
    InvalidIndices,
    /// Position, transform, leaf origin or transformed coordinate is non-finite.
    #[error("triangle mesh pick source contains an invalid coordinate")]
    InvalidCoordinate,
    /// GPU primitive ranges overlap or overflow portable u32 addressing.
    #[error("triangle mesh GPU primitive ranges overlap or overflow")]
    GpuPrimitiveRange,
    /// Stable source primitive ranges overlap or overflow u64 addressing.
    #[error("triangle mesh source primitive ranges overlap or overflow")]
    SourcePrimitiveRange,
    /// Combined position addressing exceeded portable u32 indices.
    #[error("triangle mesh pick position storage exceeds u32 addressing")]
    TooManyPositions,
}

/// Hard work and result bounds for one BVH query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TriangleMeshPickQueryLimits {
    /// Maximum accepted exact hits.
    pub maximum_hits: usize,
    /// Maximum leaf triangles tested exactly.
    pub maximum_tested_triangles: usize,
    /// Maximum BVH nodes visited.
    pub maximum_visited_nodes: usize,
}

impl Default for TriangleMeshPickQueryLimits {
    fn default() -> Self {
        Self {
            maximum_hits: 32,
            maximum_tested_triangles: 2_048,
            maximum_visited_nodes: 4_096,
        }
    }
}

impl TriangleMeshPickQueryLimits {
    fn bounded(self) -> Self {
        Self {
            maximum_hits: self.maximum_hits.clamp(1, 256),
            maximum_tested_triangles: self.maximum_tested_triangles.clamp(1, 65_536),
            maximum_visited_nodes: self.maximum_visited_nodes.clamp(1, 131_072),
        }
    }
}

/// Diagnostics proving that a query stayed inside its fixed work budget.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TriangleMeshPickQueryStats {
    /// BVH nodes whose bounds were examined.
    pub visited_nodes: usize,
    /// Source triangles tested with exact geometry.
    pub tested_triangles: usize,
    /// Query stopped because a work or result limit was reached.
    pub truncated: bool,
}

/// Exact face intersection produced by one bounded ray query.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleMeshRayHit {
    /// Stable source triangle identity.
    pub source_primitive_id: u64,
    /// Exact project-world intersection coordinate.
    pub world_position: WorldVec3,
    /// Non-negative distance along the normalized query ray.
    pub ray_distance: f64,
    /// Exact weights for the source triangle's three vertices.
    pub barycentric: [f64; 3],
}

/// Bounded exact ray-query result.
#[derive(Debug, Clone, PartialEq)]
pub struct TriangleMeshRayQuery {
    /// Front-to-back exact triangle intersections.
    pub hits: Vec<TriangleMeshRayHit>,
    /// Traversal work diagnostics.
    pub stats: TriangleMeshPickQueryStats,
}

/// Exact closest point on a triangle returned by a bounded radius query.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleMeshNearbyHit {
    /// Stable source triangle identity.
    pub source_primitive_id: u64,
    /// Exact closest project-world point.
    pub world_position: WorldVec3,
    /// Euclidean distance from the query coordinate.
    pub distance: f64,
    /// Exact weights for the source triangle's three vertices.
    pub barycentric: [f64; 3],
}

/// Bounded exact point-radius query result.
#[derive(Debug, Clone, PartialEq)]
pub struct TriangleMeshNearbyQuery {
    /// Nearest-first exact triangle results.
    pub hits: Vec<TriangleMeshNearbyHit>,
    /// Traversal work diagnostics.
    pub stats: TriangleMeshPickQueryStats,
}

#[derive(Debug, Clone, Copy)]
struct StoredTriangle {
    indices: [u32; 3],
    source_primitive_id: u64,
}

#[derive(Debug, Clone, Copy)]
struct PrimitiveRange {
    gpu_start: u32,
    source_start: u64,
    count: u32,
    triangle_start: usize,
}

#[derive(Debug, Clone, Copy)]
struct ExactAabb {
    minimum: DVec3,
    maximum: DVec3,
}

#[derive(Debug, Clone, Copy)]
enum BvhNodeKind {
    Leaf { start: usize, count: usize },
    Branch { left: usize, right: usize },
}

#[derive(Debug, Clone, Copy)]
struct BvhNode {
    bounds: ExactAabb,
    kind: BvhNodeKind,
}

/// Owned f64 triangle geometry, primitive mapping and bounded spatial index.
#[derive(Debug, Clone)]
pub struct TriangleMeshPickRefiner {
    positions: Vec<WorldVec3>,
    triangles: Vec<StoredTriangle>,
    primitive_ranges: Vec<PrimitiveRange>,
    source_primitive_ranges: Vec<PrimitiveRange>,
    bvh_nodes: Vec<BvhNode>,
    bvh_triangle_order: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
struct StoredInstance {
    world_from_model: DMat4,
    model_from_world: DMat4,
    bounds: ExactAabb,
    gpu_primitive_base: u32,
    source_primitive_base: u64,
}

/// One model BVH shared by compact placements plus a top-level instance-AABB BVH.
///
/// Model positions and triangles are retained exactly once regardless of the
/// instance count. Exact tests transform only candidate rays/points selected by
/// the top-level BVH into model space.
#[derive(Debug, Clone)]
pub struct InstancedTriangleMeshPickRefiner {
    model: Arc<TriangleMeshPickRefiner>,
    instances: Vec<StoredInstance>,
    gpu_instance_order: Vec<u32>,
    source_instance_order: Vec<u32>,
    bvh_nodes: Vec<BvhNode>,
    bvh_instance_order: Vec<u32>,
}

/// Uniform exact mesh-picking surface used by ordinary and instanced proxies.
#[derive(Debug, Clone)]
pub enum MeshPickRefiner {
    /// Fully evaluated non-instanced triangle geometry.
    Mesh(TriangleMeshPickRefiner),
    /// Shared model geometry with a top-level instance index.
    Instanced(InstancedTriangleMeshPickRefiner),
}

impl TriangleMeshPickRefiner {
    /// Builds one immutable index from inline, evaluated or streamed mesh leaves.
    pub fn build(
        sources: &[TriangleMeshPickSource<'_>],
    ) -> Result<Self, TriangleMeshPickBuildError> {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        let mut primitive_ranges = Vec::new();
        for source in sources {
            append_source(
                *source,
                &mut positions,
                &mut triangles,
                &mut primitive_ranges,
            )?;
        }
        if triangles.is_empty() {
            return Err(TriangleMeshPickBuildError::Empty);
        }
        primitive_ranges.sort_by_key(|range| range.gpu_start);
        for pair in primitive_ranges.windows(2) {
            let end = u64::from(pair[0].gpu_start) + u64::from(pair[0].count);
            if end > u64::from(pair[1].gpu_start) {
                return Err(TriangleMeshPickBuildError::GpuPrimitiveRange);
            }
        }
        let mut source_primitive_ranges = primitive_ranges.clone();
        source_primitive_ranges.sort_by_key(|range| range.source_start);
        for pair in source_primitive_ranges.windows(2) {
            let end = pair[0]
                .source_start
                .checked_add(u64::from(pair[0].count))
                .ok_or(TriangleMeshPickBuildError::SourcePrimitiveRange)?;
            if end > pair[1].source_start {
                return Err(TriangleMeshPickBuildError::SourcePrimitiveRange);
            }
        }
        let mut bvh_triangle_order = (0..triangles.len())
            .map(|index| {
                u32::try_from(index).map_err(|_| TriangleMeshPickBuildError::GpuPrimitiveRange)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut bvh_nodes = Vec::with_capacity(triangles.len().saturating_mul(2));
        build_bvh_node(
            &positions,
            &triangles,
            &mut bvh_triangle_order,
            0,
            &mut bvh_nodes,
        );
        Ok(Self {
            positions,
            triangles,
            primitive_ranges,
            source_primitive_ranges,
            bvh_nodes,
            bvh_triangle_order,
        })
    }

    /// Exact source triangle addressed by one GPU primitive identifier.
    #[must_use]
    pub fn source_primitive_id(&self, gpu_primitive_id: u64) -> Option<u64> {
        let triangle = self.triangle_for_gpu_primitive(gpu_primitive_id)?;
        Some(self.triangles[triangle].source_primitive_id)
    }

    /// Returns exact vertex weights for one stable source triangle at a known
    /// project-world coordinate. This is used to resolve per-vertex metadata
    /// after ordinary geometry picking without duplicating the BVH topology.
    #[must_use]
    pub fn source_triangle_barycentric(
        &self,
        source_primitive_id: u64,
        world_position: WorldVec3,
    ) -> Option<[f64; 3]> {
        let range = self.source_primitive_ranges.iter().find(|range| {
            source_primitive_id >= range.source_start
                && source_primitive_id - range.source_start < u64::from(range.count)
        })?;
        let local = usize::try_from(source_primitive_id - range.source_start).ok()?;
        let triangle_index = range.triangle_start.checked_add(local)?;
        let point = vector(world_position);
        point
            .is_finite()
            .then(|| barycentric_coordinates(point, self.triangle_vertices(triangle_index)))
    }

    /// Complete retained CPU allocation owned by this refiner.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        allocation_bytes::<WorldVec3>(self.positions.capacity())
            .saturating_add(allocation_bytes::<StoredTriangle>(
                self.triangles.capacity(),
            ))
            .saturating_add(allocation_bytes::<PrimitiveRange>(
                self.primitive_ranges.capacity(),
            ))
            .saturating_add(allocation_bytes::<PrimitiveRange>(
                self.source_primitive_ranges.capacity(),
            ))
            .saturating_add(allocation_bytes::<BvhNode>(self.bvh_nodes.capacity()))
            .saturating_add(allocation_bytes::<u32>(self.bvh_triangle_order.capacity()))
    }

    fn triangle_count(&self) -> u32 {
        u32::try_from(self.triangles.len()).expect("triangle storage is limited to u32")
    }

    fn bounds(&self) -> ExactAabb {
        self.bvh_nodes[0].bounds
    }

    fn source_triangle_vertices(&self, source_primitive_id: u64) -> Option<[DVec3; 3]> {
        self.triangle_for_source_primitive(source_primitive_id)
            .map(|index| self.triangle_vertices(index))
    }

    /// Intersects a ray against the BVH within caller-supplied hard work limits.
    #[must_use]
    pub fn ray_query(
        &self,
        ray: WorldRay,
        maximum_distance: f64,
        limits: TriangleMeshPickQueryLimits,
    ) -> TriangleMeshRayQuery {
        let limits = limits.bounded();
        let mut stats = TriangleMeshPickQueryStats::default();
        let mut hits = Vec::new();
        let origin = vector(ray.origin);
        let direction = vector(ray.direction);
        if !origin.is_finite()
            || !direction.is_finite()
            || direction.length_squared() <= f64::EPSILON
            || !maximum_distance.is_finite()
            || maximum_distance < 0.0
        {
            return TriangleMeshRayQuery { hits, stats };
        }
        let direction = direction.normalize();
        let mut stack = Vec::with_capacity(64);
        if let Some(distance) = ray_aabb(origin, direction, self.bvh_nodes[0].bounds) {
            if distance <= maximum_distance {
                stack.push((0_usize, distance));
            }
        }
        while let Some((node_index, _)) = stack.pop() {
            if stats.visited_nodes >= limits.maximum_visited_nodes
                || stats.tested_triangles >= limits.maximum_tested_triangles
                || hits.len() >= limits.maximum_hits
            {
                stats.truncated = true;
                break;
            }
            stats.visited_nodes += 1;
            match self.bvh_nodes[node_index].kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ordered in &self.bvh_triangle_order[start..start + count] {
                        if stats.tested_triangles >= limits.maximum_tested_triangles
                            || hits.len() >= limits.maximum_hits
                        {
                            stats.truncated = true;
                            break;
                        }
                        stats.tested_triangles += 1;
                        let triangle_index = usize::try_from(*ordered).expect("stored u32 index");
                        let vertices = self.triangle_vertices(triangle_index);
                        if let Some((distance, barycentric)) =
                            ray_triangle(origin, direction, vertices)
                        {
                            if distance <= maximum_distance {
                                hits.push(TriangleMeshRayHit {
                                    source_primitive_id: self.triangles[triangle_index]
                                        .source_primitive_id,
                                    world_position: world(origin + direction * distance),
                                    ray_distance: distance,
                                    barycentric,
                                });
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    push_ray_children(
                        &mut stack,
                        origin,
                        direction,
                        maximum_distance,
                        left,
                        right,
                        &self.bvh_nodes,
                    );
                }
            }
        }
        hits.sort_by(|left, right| left.ray_distance.total_cmp(&right.ray_distance));
        TriangleMeshRayQuery { hits, stats }
    }

    /// Finds exact triangle points inside a world-space radius with bounded work.
    #[must_use]
    pub fn nearby_query(
        &self,
        position: WorldVec3,
        radius: f64,
        limits: TriangleMeshPickQueryLimits,
    ) -> TriangleMeshNearbyQuery {
        let limits = limits.bounded();
        let mut stats = TriangleMeshPickQueryStats::default();
        let mut hits = Vec::new();
        let point = vector(position);
        if !point.is_finite() || !radius.is_finite() || radius < 0.0 {
            return TriangleMeshNearbyQuery { hits, stats };
        }
        let radius_squared = radius * radius;
        let mut stack = Vec::with_capacity(64);
        if aabb_distance_squared(point, self.bvh_nodes[0].bounds) <= radius_squared {
            stack.push(0_usize);
        }
        while let Some(node_index) = stack.pop() {
            if stats.visited_nodes >= limits.maximum_visited_nodes
                || stats.tested_triangles >= limits.maximum_tested_triangles
            {
                stats.truncated = true;
                break;
            }
            stats.visited_nodes += 1;
            match self.bvh_nodes[node_index].kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ordered in &self.bvh_triangle_order[start..start + count] {
                        if stats.tested_triangles >= limits.maximum_tested_triangles {
                            stats.truncated = true;
                            break;
                        }
                        stats.tested_triangles += 1;
                        let triangle_index = usize::try_from(*ordered).expect("stored u32 index");
                        let vertices = self.triangle_vertices(triangle_index);
                        let closest = closest_point_on_triangle(point, vertices);
                        let distance_squared = point.distance_squared(closest);
                        if distance_squared <= radius_squared {
                            hits.push(TriangleMeshNearbyHit {
                                source_primitive_id: self.triangles[triangle_index]
                                    .source_primitive_id,
                                world_position: world(closest),
                                distance: distance_squared.sqrt(),
                                barycentric: barycentric_coordinates(closest, vertices),
                            });
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    for child in [right, left] {
                        if aabb_distance_squared(point, self.bvh_nodes[child].bounds)
                            <= radius_squared
                        {
                            stack.push(child);
                        }
                    }
                }
            }
        }
        hits.sort_by(|left, right| left.distance.total_cmp(&right.distance));
        if hits.len() > limits.maximum_hits {
            hits.truncate(limits.maximum_hits);
            stats.truncated = true;
        }
        TriangleMeshNearbyQuery { hits, stats }
    }

    /// Produces exact face, edge and vertex snaps with stable source addresses.
    #[must_use]
    pub fn refine(&self, request: PickRefinementRequest<'_>) -> Vec<PickCandidate> {
        let mut candidates = Vec::new();
        let mut refined_triangles = BTreeSet::new();
        let Some(source_ray) = request.source_ray() else {
            return Vec::new();
        };
        if let Some(gpu_primitive) = request.coarse.address.primitive_id {
            if let Some(index) = self.triangle_for_gpu_primitive(gpu_primitive) {
                refined_triangles.insert(index);
            }
        }
        let ray_hits = self.ray_query(
            source_ray,
            f64::MAX,
            TriangleMeshPickQueryLimits {
                maximum_hits: 16,
                ..TriangleMeshPickQueryLimits::default()
            },
        );
        for hit in ray_hits.hits {
            push_candidate(
                &mut candidates,
                request,
                hit.source_primitive_id,
                hit.world_position,
                SnapKind::Surface,
            );
            if let Some(index) = self.triangle_for_source_primitive(hit.source_primitive_id) {
                refined_triangles.insert(index);
            }
        }
        if let Some(radius) = screen_radius(request) {
            let Some(source_position) = request.source_from_project(
                request
                    .presentation_transform
                    .source(request.coarse.world_position),
            ) else {
                return candidates;
            };
            let nearby = self.nearby_query(
                source_position,
                radius,
                TriangleMeshPickQueryLimits {
                    maximum_hits: 32,
                    maximum_tested_triangles: 1_024,
                    maximum_visited_nodes: 2_048,
                },
            );
            for hit in nearby.hits {
                push_candidate(
                    &mut candidates,
                    request,
                    hit.source_primitive_id,
                    hit.world_position,
                    SnapKind::Surface,
                );
                if let Some(index) = self.triangle_for_source_primitive(hit.source_primitive_id) {
                    refined_triangles.insert(index);
                }
            }
        }
        for triangle in refined_triangles {
            self.push_triangle_feature_snaps(&mut candidates, request, triangle);
        }
        candidates
    }

    fn triangle_for_gpu_primitive(&self, gpu_primitive_id: u64) -> Option<usize> {
        let gpu = u32::try_from(gpu_primitive_id).ok()?;
        let next = self
            .primitive_ranges
            .partition_point(|range| range.gpu_start <= gpu);
        let range = self.primitive_ranges.get(next.checked_sub(1)?)?;
        let offset = gpu.checked_sub(range.gpu_start)?;
        (offset < range.count).then(|| {
            range.triangle_start + usize::try_from(offset).expect("u32 fits portable usize")
        })
    }

    fn triangle_for_source_primitive(&self, source: u64) -> Option<usize> {
        let next = self
            .source_primitive_ranges
            .partition_point(|range| range.source_start <= source);
        let range = self.source_primitive_ranges.get(next.checked_sub(1)?)?;
        let offset = source.checked_sub(range.source_start)?;
        (offset < u64::from(range.count))
            .then(|| range.triangle_start + usize::try_from(offset).expect("range count is u32"))
    }

    fn triangle_vertices(&self, index: usize) -> [DVec3; 3] {
        self.triangles[index].indices.map(|vertex| {
            vector(self.positions[usize::try_from(vertex).expect("stored u32 index")])
        })
    }

    fn push_triangle_feature_snaps(
        &self,
        candidates: &mut Vec<PickCandidate>,
        request: PickRefinementRequest<'_>,
        triangle_index: usize,
    ) {
        let triangle = self.triangles[triangle_index];
        let vertices = self.triangle_vertices(triangle_index);
        for vertex in vertices {
            push_candidate(
                candidates,
                request,
                triangle.source_primitive_id,
                world(vertex),
                SnapKind::Vertex,
            );
        }
        let Some(source_ray) = request.source_ray() else {
            return;
        };
        let ray_origin = vector(source_ray.origin);
        let ray_direction = vector(source_ray.direction);
        for edge in [[0, 1], [1, 2], [2, 0]] {
            let parameter = closest_segment_parameter(
                vertices[edge[0]],
                vertices[edge[1]],
                ray_origin,
                ray_direction,
            );
            push_candidate(
                candidates,
                request,
                triangle.source_primitive_id,
                world(vertices[edge[0]].lerp(vertices[edge[1]], parameter)),
                SnapKind::Edge,
            );
        }
    }
}

impl InstancedTriangleMeshPickRefiner {
    /// Builds compact instance records over one already-built shared model BVH.
    pub fn build(
        model: Arc<TriangleMeshPickRefiner>,
        sources: &[TriangleMeshPickInstance],
    ) -> Result<Self, TriangleMeshPickBuildError> {
        if sources.is_empty() {
            return Err(TriangleMeshPickBuildError::Empty);
        }
        let triangle_count = model.triangle_count();
        if triangle_count == 0
            || (0..triangle_count).any(|primitive| {
                model.source_primitive_id(u64::from(primitive)) != Some(u64::from(primitive))
            })
        {
            return Err(TriangleMeshPickBuildError::InvalidIndices);
        }
        let model_bounds = model.bounds();
        let mut instances = Vec::with_capacity(sources.len());
        for source in sources {
            let world_from_model = DMat4::from_cols_array(&source.world_from_model.0);
            let determinant = world_from_model.determinant();
            if !world_from_model.is_finite()
                || source.world_from_model.0[3] != 0.0
                || source.world_from_model.0[7] != 0.0
                || source.world_from_model.0[11] != 0.0
                || source.world_from_model.0[15] != 1.0
                || !determinant.is_finite()
                || determinant.abs() <= f64::MIN_POSITIVE
            {
                return Err(TriangleMeshPickBuildError::InvalidCoordinate);
            }
            let model_from_world = world_from_model.inverse();
            if !model_from_world.is_finite() {
                return Err(TriangleMeshPickBuildError::InvalidCoordinate);
            }
            let bounds = transform_aabb(model_bounds, world_from_model)
                .ok_or(TriangleMeshPickBuildError::InvalidCoordinate)?;
            source
                .gpu_primitive_base
                .checked_add(triangle_count - 1)
                .ok_or(TriangleMeshPickBuildError::GpuPrimitiveRange)?;
            source
                .source_primitive_base
                .checked_add(u64::from(triangle_count - 1))
                .ok_or(TriangleMeshPickBuildError::SourcePrimitiveRange)?;
            instances.push(StoredInstance {
                world_from_model,
                model_from_world,
                bounds,
                gpu_primitive_base: source.gpu_primitive_base,
                source_primitive_base: source.source_primitive_base,
            });
        }
        let mut gpu_instance_order = ordered_instance_indices(instances.len())?;
        gpu_instance_order.sort_unstable_by_key(|index| {
            instances[usize::try_from(*index).expect("stored u32 index")].gpu_primitive_base
        });
        validate_instance_ranges(&instances, &gpu_instance_order, triangle_count, true)?;
        let mut source_instance_order = ordered_instance_indices(instances.len())?;
        source_instance_order.sort_unstable_by_key(|index| {
            instances[usize::try_from(*index).expect("stored u32 index")].source_primitive_base
        });
        validate_instance_ranges(&instances, &source_instance_order, triangle_count, false)?;
        let mut bvh_instance_order = ordered_instance_indices(instances.len())?;
        let mut bvh_nodes = Vec::with_capacity(instances.len().saturating_mul(2));
        build_instance_bvh_node(&instances, &mut bvh_instance_order, 0, &mut bvh_nodes);
        Ok(Self {
            model,
            instances,
            gpu_instance_order,
            source_instance_order,
            bvh_nodes,
            bvh_instance_order,
        })
    }

    /// Maps a chunk-local GPU primitive to its stable source instance/triangle address.
    #[must_use]
    pub fn source_primitive_id(&self, gpu_primitive_id: u64) -> Option<u64> {
        let gpu = u32::try_from(gpu_primitive_id).ok()?;
        let instance_index = self.instance_for_gpu_primitive(gpu)?;
        let instance = self.instances[instance_index];
        let local = gpu.checked_sub(instance.gpu_primitive_base)?;
        let model_source = self.model.source_primitive_id(u64::from(local))?;
        instance.source_primitive_base.checked_add(model_source)
    }

    /// Exact barycentric weights for an instanced source triangle.
    #[must_use]
    pub fn source_triangle_barycentric(
        &self,
        source_primitive_id: u64,
        world_position: WorldVec3,
    ) -> Option<[f64; 3]> {
        let instance_index = self.instance_for_source_primitive(source_primitive_id)?;
        let instance = self.instances[instance_index];
        let local_source = source_primitive_id.checked_sub(instance.source_primitive_base)?;
        let local = instance
            .model_from_world
            .transform_point3(vector(world_position));
        local.is_finite().then_some(())?;
        self.model
            .source_triangle_barycentric(local_source, world(local))
    }

    /// Actual retained allocation for this chunk, including the shared model once.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        self.model
            .resident_bytes()
            .saturating_add(allocation_bytes::<StoredInstance>(
                self.instances.capacity(),
            ))
            .saturating_add(allocation_bytes::<u32>(self.gpu_instance_order.capacity()))
            .saturating_add(allocation_bytes::<u32>(
                self.source_instance_order.capacity(),
            ))
            .saturating_add(allocation_bytes::<BvhNode>(self.bvh_nodes.capacity()))
            .saturating_add(allocation_bytes::<u32>(self.bvh_instance_order.capacity()))
    }

    /// Shared model allocation. Callers aggregating sibling chunks can count it once.
    #[must_use]
    pub fn shared_model_resident_bytes(&self) -> u64 {
        self.model.resident_bytes()
    }

    /// Stable process-local identity for deduplicating shared-model accounting.
    #[must_use]
    pub fn shared_model_key(&self) -> usize {
        Arc::as_ptr(&self.model) as usize
    }

    /// Intersects top-level instance bounds before entering the shared model BVH.
    #[must_use]
    pub fn ray_query(
        &self,
        ray: WorldRay,
        maximum_distance: f64,
        limits: TriangleMeshPickQueryLimits,
    ) -> TriangleMeshRayQuery {
        let limits = limits.bounded();
        let mut stats = TriangleMeshPickQueryStats::default();
        let mut hits = Vec::new();
        let origin = vector(ray.origin);
        let direction = vector(ray.direction);
        if !origin.is_finite()
            || !direction.is_finite()
            || direction.length_squared() <= f64::EPSILON
            || !maximum_distance.is_finite()
            || maximum_distance < 0.0
        {
            return TriangleMeshRayQuery { hits, stats };
        }
        let direction = direction.normalize();
        let mut stack = Vec::with_capacity(64);
        if let Some(distance) = ray_aabb(origin, direction, self.bvh_nodes[0].bounds) {
            if distance <= maximum_distance {
                stack.push((0_usize, distance));
            }
        }
        while let Some((node_index, _)) = stack.pop() {
            if stats.visited_nodes >= limits.maximum_visited_nodes
                || stats.tested_triangles >= limits.maximum_tested_triangles
                || hits.len() >= limits.maximum_hits
            {
                stats.truncated = true;
                break;
            }
            stats.visited_nodes += 1;
            match self.bvh_nodes[node_index].kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ordered in &self.bvh_instance_order[start..start + count] {
                        if stats.visited_nodes >= limits.maximum_visited_nodes
                            || stats.tested_triangles >= limits.maximum_tested_triangles
                            || hits.len() >= limits.maximum_hits
                        {
                            stats.truncated = true;
                            break;
                        }
                        let instance =
                            self.instances[usize::try_from(*ordered).expect("stored u32 index")];
                        let local_origin = instance.model_from_world.transform_point3(origin);
                        let local_direction =
                            instance.model_from_world.transform_vector3(direction);
                        let direction_scale = local_direction.length();
                        if !local_origin.is_finite()
                            || !local_direction.is_finite()
                            || direction_scale <= f64::EPSILON
                        {
                            continue;
                        }
                        let nested = self.model.ray_query(
                            WorldRay {
                                origin: world(local_origin),
                                direction: world(local_direction / direction_scale),
                            },
                            if maximum_distance > f64::MAX / direction_scale {
                                f64::MAX
                            } else {
                                maximum_distance * direction_scale
                            },
                            TriangleMeshPickQueryLimits {
                                maximum_hits: limits.maximum_hits - hits.len(),
                                maximum_tested_triangles: limits.maximum_tested_triangles
                                    - stats.tested_triangles,
                                maximum_visited_nodes: limits.maximum_visited_nodes
                                    - stats.visited_nodes,
                            },
                        );
                        stats.visited_nodes += nested.stats.visited_nodes;
                        stats.tested_triangles += nested.stats.tested_triangles;
                        stats.truncated |= nested.stats.truncated;
                        for hit in nested.hits {
                            let world_position = instance
                                .world_from_model
                                .transform_point3(vector(hit.world_position));
                            let ray_distance = (world_position - origin).dot(direction);
                            if ray_distance >= 0.0 && ray_distance <= maximum_distance {
                                hits.push(TriangleMeshRayHit {
                                    source_primitive_id: instance.source_primitive_base
                                        + hit.source_primitive_id,
                                    world_position: world(world_position),
                                    ray_distance,
                                    barycentric: hit.barycentric,
                                });
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => push_ray_children(
                    &mut stack,
                    origin,
                    direction,
                    maximum_distance,
                    left,
                    right,
                    &self.bvh_nodes,
                ),
            }
        }
        hits.sort_by(|left, right| left.ray_distance.total_cmp(&right.ray_distance));
        if hits.len() > limits.maximum_hits {
            hits.truncate(limits.maximum_hits);
            stats.truncated = true;
        }
        TriangleMeshRayQuery { hits, stats }
    }

    /// Finds exact nearest points after pruning instances by their world AABBs.
    #[must_use]
    pub fn nearby_query(
        &self,
        position: WorldVec3,
        radius: f64,
        limits: TriangleMeshPickQueryLimits,
    ) -> TriangleMeshNearbyQuery {
        let limits = limits.bounded();
        let mut stats = TriangleMeshPickQueryStats::default();
        let mut hits = Vec::new();
        let point = vector(position);
        if !point.is_finite() || !radius.is_finite() || radius < 0.0 {
            return TriangleMeshNearbyQuery { hits, stats };
        }
        let radius_squared = radius * radius;
        let mut stack = vec![0_usize];
        while let Some(node_index) = stack.pop() {
            if stats.visited_nodes >= limits.maximum_visited_nodes
                || stats.tested_triangles >= limits.maximum_tested_triangles
            {
                stats.truncated = true;
                break;
            }
            if aabb_distance_squared(point, self.bvh_nodes[node_index].bounds) > radius_squared {
                continue;
            }
            stats.visited_nodes += 1;
            match self.bvh_nodes[node_index].kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ordered in &self.bvh_instance_order[start..start + count] {
                        if stats.visited_nodes >= limits.maximum_visited_nodes
                            || stats.tested_triangles >= limits.maximum_tested_triangles
                        {
                            stats.truncated = true;
                            break;
                        }
                        let instance =
                            self.instances[usize::try_from(*ordered).expect("stored u32 index")];
                        let local_point = instance.model_from_world.transform_point3(point);
                        let inverse_linear = glam::DMat3::from_mat4(instance.model_from_world);
                        let inverse_scale = inverse_linear
                            .to_cols_array()
                            .iter()
                            .fold(0.0_f64, |length, value| length.hypot(*value));
                        let local_radius = if radius > f64::MAX / inverse_scale {
                            f64::MAX
                        } else {
                            radius * inverse_scale
                        };
                        let nested = self.model.nearby_query(
                            world(local_point),
                            local_radius,
                            TriangleMeshPickQueryLimits {
                                maximum_hits: limits.maximum_hits,
                                maximum_tested_triangles: limits.maximum_tested_triangles
                                    - stats.tested_triangles,
                                maximum_visited_nodes: limits.maximum_visited_nodes
                                    - stats.visited_nodes,
                            },
                        );
                        stats.visited_nodes += nested.stats.visited_nodes;
                        stats.tested_triangles += nested.stats.tested_triangles;
                        stats.truncated |= nested.stats.truncated;
                        for hit in nested.hits {
                            let world_position = instance
                                .world_from_model
                                .transform_point3(vector(hit.world_position));
                            let distance = point.distance(world_position);
                            if distance <= radius {
                                hits.push(TriangleMeshNearbyHit {
                                    source_primitive_id: instance.source_primitive_base
                                        + hit.source_primitive_id,
                                    world_position: world(world_position),
                                    distance,
                                    barycentric: hit.barycentric,
                                });
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    stack.extend([right, left]);
                }
            }
        }
        hits.sort_by(|left, right| left.distance.total_cmp(&right.distance));
        if hits.len() > limits.maximum_hits {
            hits.truncate(limits.maximum_hits);
            stats.truncated = true;
        }
        TriangleMeshNearbyQuery { hits, stats }
    }

    /// Produces stable surface, edge and vertex candidates for instanced geometry.
    #[must_use]
    pub fn refine(&self, request: PickRefinementRequest<'_>) -> Vec<PickCandidate> {
        let mut candidates = Vec::new();
        let mut refined = BTreeSet::new();
        let Some(source_ray) = request.source_ray() else {
            return Vec::new();
        };
        if let Some(gpu) = request.coarse.address.primitive_id {
            if let Some(source) = self.source_primitive_id(gpu) {
                refined.insert(source);
            }
        }
        for hit in self
            .ray_query(source_ray, f64::MAX, TriangleMeshPickQueryLimits::default())
            .hits
        {
            push_candidate(
                &mut candidates,
                request,
                hit.source_primitive_id,
                hit.world_position,
                SnapKind::Surface,
            );
            refined.insert(hit.source_primitive_id);
        }
        if let Some(radius) = screen_radius(request) {
            let Some(source_position) = request.source_from_project(
                request
                    .presentation_transform
                    .source(request.coarse.world_position),
            ) else {
                return candidates;
            };
            for hit in self
                .nearby_query(
                    source_position,
                    radius,
                    TriangleMeshPickQueryLimits::default(),
                )
                .hits
            {
                push_candidate(
                    &mut candidates,
                    request,
                    hit.source_primitive_id,
                    hit.world_position,
                    SnapKind::Surface,
                );
                refined.insert(hit.source_primitive_id);
            }
        }
        for source in refined {
            let Some(instance_index) = self.instance_for_source_primitive(source) else {
                continue;
            };
            let instance = self.instances[instance_index];
            let Some(vertices) = self
                .model
                .source_triangle_vertices(source - instance.source_primitive_base)
            else {
                continue;
            };
            let vertices =
                vertices.map(|vertex| instance.world_from_model.transform_point3(vertex));
            for vertex in vertices {
                push_candidate(
                    &mut candidates,
                    request,
                    source,
                    world(vertex),
                    SnapKind::Vertex,
                );
            }
            let ray_origin = vector(source_ray.origin);
            let ray_direction = vector(source_ray.direction);
            for edge in [[0, 1], [1, 2], [2, 0]] {
                let parameter = closest_segment_parameter(
                    vertices[edge[0]],
                    vertices[edge[1]],
                    ray_origin,
                    ray_direction,
                );
                push_candidate(
                    &mut candidates,
                    request,
                    source,
                    world(vertices[edge[0]].lerp(vertices[edge[1]], parameter)),
                    SnapKind::Edge,
                );
            }
        }
        candidates
    }

    fn instance_for_gpu_primitive(&self, gpu: u32) -> Option<usize> {
        let next = self.gpu_instance_order.partition_point(|index| {
            self.instances[usize::try_from(*index).expect("stored u32 index")].gpu_primitive_base
                <= gpu
        });
        let index = usize::try_from(*self.gpu_instance_order.get(next.checked_sub(1)?)?).ok()?;
        let instance = self.instances[index];
        (gpu - instance.gpu_primitive_base < self.model.triangle_count()).then_some(index)
    }

    fn instance_for_source_primitive(&self, source: u64) -> Option<usize> {
        let next = self.source_instance_order.partition_point(|index| {
            self.instances[usize::try_from(*index).expect("stored u32 index")].source_primitive_base
                <= source
        });
        let index = usize::try_from(*self.source_instance_order.get(next.checked_sub(1)?)?).ok()?;
        let instance = self.instances[index];
        (source - instance.source_primitive_base < u64::from(self.model.triangle_count()))
            .then_some(index)
    }
}

impl MeshPickRefiner {
    /// Exact source primitive represented by one GPU primitive address.
    #[must_use]
    pub fn source_primitive_id(&self, gpu_primitive_id: u64) -> Option<u64> {
        match self {
            Self::Mesh(index) => index.source_primitive_id(gpu_primitive_id),
            Self::Instanced(index) => index.source_primitive_id(gpu_primitive_id),
        }
    }

    /// Exact vertex weights at a known project-world coordinate.
    #[must_use]
    pub fn source_triangle_barycentric(
        &self,
        source_primitive_id: u64,
        world_position: WorldVec3,
    ) -> Option<[f64; 3]> {
        match self {
            Self::Mesh(index) => {
                index.source_triangle_barycentric(source_primitive_id, world_position)
            }
            Self::Instanced(index) => {
                index.source_triangle_barycentric(source_primitive_id, world_position)
            }
        }
    }

    /// CPU allocation charged conservatively to this proxy.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        match self {
            Self::Mesh(index) => index.resident_bytes(),
            Self::Instanced(index) => index.resident_bytes(),
        }
    }

    /// Allocation unique to this proxy, excluding an Arc-shared instance model.
    #[must_use]
    pub fn exclusive_resident_bytes(&self) -> u64 {
        match self {
            Self::Mesh(index) => index.resident_bytes(),
            Self::Instanced(index) => index
                .resident_bytes()
                .saturating_sub(index.shared_model_resident_bytes()),
        }
    }

    /// Process-local shared allocation identity and bytes for exact accounting.
    #[must_use]
    pub fn shared_resident_allocation(&self) -> Option<(usize, u64)> {
        match self {
            Self::Mesh(_) => None,
            Self::Instanced(index) => Some((
                index.shared_model_key(),
                index.shared_model_resident_bytes(),
            )),
        }
    }

    /// Exact refinement shared by ordinary and instanced mesh proxies.
    #[must_use]
    pub fn refine(&self, request: PickRefinementRequest<'_>) -> Vec<PickCandidate> {
        match self {
            Self::Mesh(index) => index.refine(request),
            Self::Instanced(index) => index.refine(request),
        }
    }
}

impl From<TriangleMeshPickRefiner> for MeshPickRefiner {
    fn from(value: TriangleMeshPickRefiner) -> Self {
        Self::Mesh(value)
    }
}

impl From<InstancedTriangleMeshPickRefiner> for MeshPickRefiner {
    fn from(value: InstancedTriangleMeshPickRefiner) -> Self {
        Self::Instanced(value)
    }
}

fn ordered_instance_indices(count: usize) -> Result<Vec<u32>, TriangleMeshPickBuildError> {
    (0..count)
        .map(|index| {
            u32::try_from(index).map_err(|_| TriangleMeshPickBuildError::GpuPrimitiveRange)
        })
        .collect()
}

fn validate_instance_ranges(
    instances: &[StoredInstance],
    order: &[u32],
    triangle_count: u32,
    gpu: bool,
) -> Result<(), TriangleMeshPickBuildError> {
    for pair in order.windows(2) {
        let left = instances[usize::try_from(pair[0]).expect("stored u32 index")];
        let right = instances[usize::try_from(pair[1]).expect("stored u32 index")];
        if gpu {
            if u64::from(left.gpu_primitive_base) + u64::from(triangle_count)
                > u64::from(right.gpu_primitive_base)
            {
                return Err(TriangleMeshPickBuildError::GpuPrimitiveRange);
            }
        } else if left
            .source_primitive_base
            .checked_add(u64::from(triangle_count))
            .ok_or(TriangleMeshPickBuildError::SourcePrimitiveRange)?
            > right.source_primitive_base
        {
            return Err(TriangleMeshPickBuildError::SourcePrimitiveRange);
        }
    }
    Ok(())
}

fn transform_aabb(bounds: ExactAabb, transform: DMat4) -> Option<ExactAabb> {
    let mut transformed = ExactAabb::empty();
    for x in [bounds.minimum.x, bounds.maximum.x] {
        for y in [bounds.minimum.y, bounds.maximum.y] {
            for z in [bounds.minimum.z, bounds.maximum.z] {
                let point = transform.transform_point3(DVec3::new(x, y, z));
                if !point.is_finite() {
                    return None;
                }
                transformed = transformed.include(point);
            }
        }
    }
    Some(transformed)
}

fn build_instance_bvh_node(
    instances: &[StoredInstance],
    order: &mut [u32],
    order_start: usize,
    nodes: &mut Vec<BvhNode>,
) -> usize {
    let bounds = order.iter().fold(ExactAabb::empty(), |bounds, instance| {
        bounds.union(instances[usize::try_from(*instance).expect("stored u32 index")].bounds)
    });
    let node_index = nodes.len();
    nodes.push(BvhNode {
        bounds,
        kind: BvhNodeKind::Leaf {
            start: order_start,
            count: order.len(),
        },
    });
    if order.len() <= LEAF_TRIANGLES {
        return node_index;
    }
    let extent = bounds.maximum - bounds.minimum;
    let axis = if extent.x >= extent.y && extent.x >= extent.z {
        0
    } else if extent.y >= extent.z {
        1
    } else {
        2
    };
    order.sort_unstable_by(|left, right| {
        let left = instances[usize::try_from(*left).expect("stored u32 index")].bounds;
        let right = instances[usize::try_from(*right).expect("stored u32 index")].bounds;
        ((left.minimum[axis] + left.maximum[axis]) * 0.5)
            .total_cmp(&((right.minimum[axis] + right.maximum[axis]) * 0.5))
    });
    let middle = order.len() / 2;
    let (left_order, right_order) = order.split_at_mut(middle);
    let left = build_instance_bvh_node(instances, left_order, order_start, nodes);
    let right = build_instance_bvh_node(instances, right_order, order_start + middle, nodes);
    nodes[node_index].kind = BvhNodeKind::Branch { left, right };
    node_index
}

fn append_source(
    source: TriangleMeshPickSource<'_>,
    positions: &mut Vec<WorldVec3>,
    triangles: &mut Vec<StoredTriangle>,
    ranges: &mut Vec<PrimitiveRange>,
) -> Result<(), TriangleMeshPickBuildError> {
    if source.indices.is_empty() {
        return Ok(());
    }
    if !source.indices.len().is_multiple_of(3)
        || source.indices.iter().any(|index| {
            usize::try_from(*index)
                .ok()
                .is_none_or(|index| index >= source.positions.len())
        })
    {
        return Err(TriangleMeshPickBuildError::InvalidIndices);
    }
    let triangle_count = u32::try_from(source.indices.len() / 3)
        .map_err(|_| TriangleMeshPickBuildError::GpuPrimitiveRange)?;
    let last_triangle = triangle_count
        .checked_sub(1)
        .expect("non-empty triangle source");
    source
        .gpu_primitive_base
        .checked_add(last_triangle)
        .ok_or(TriangleMeshPickBuildError::GpuPrimitiveRange)?;
    source
        .source_primitive_base
        .checked_add(u64::from(last_triangle))
        .ok_or(TriangleMeshPickBuildError::SourcePrimitiveRange)?;
    let combined_position_count = positions
        .len()
        .checked_add(source.positions.len())
        .ok_or(TriangleMeshPickBuildError::TooManyPositions)?;
    if u64::try_from(combined_position_count).unwrap_or(u64::MAX) > u64::from(u32::MAX) + 1 {
        return Err(TriangleMeshPickBuildError::TooManyPositions);
    }
    let position_base =
        u32::try_from(positions.len()).map_err(|_| TriangleMeshPickBuildError::TooManyPositions)?;
    let transform = DMat4::from_cols_array(&source.transform.0);
    let leaf_origin = vector(source.leaf_origin);
    if !transform.is_finite() || !leaf_origin.is_finite() {
        return Err(TriangleMeshPickBuildError::InvalidCoordinate);
    }
    for position in source.positions {
        let homogeneous = transform * vector(*position).extend(1.0);
        if !homogeneous.is_finite() || homogeneous.w.abs() <= f64::EPSILON {
            return Err(TriangleMeshPickBuildError::InvalidCoordinate);
        }
        let position = homogeneous.truncate() / homogeneous.w + leaf_origin;
        if !position.is_finite() {
            return Err(TriangleMeshPickBuildError::InvalidCoordinate);
        }
        positions.push(world(position));
    }
    let triangle_start = triangles.len();
    for (local, indices) in source.indices.chunks_exact(3).enumerate() {
        let local = u64::try_from(local).expect("triangle count validated as u32");
        triangles.push(StoredTriangle {
            indices: [
                position_base
                    .checked_add(indices[0])
                    .ok_or(TriangleMeshPickBuildError::TooManyPositions)?,
                position_base
                    .checked_add(indices[1])
                    .ok_or(TriangleMeshPickBuildError::TooManyPositions)?,
                position_base
                    .checked_add(indices[2])
                    .ok_or(TriangleMeshPickBuildError::TooManyPositions)?,
            ],
            source_primitive_id: source
                .source_primitive_base
                .checked_add(local)
                .ok_or(TriangleMeshPickBuildError::SourcePrimitiveRange)?,
        });
    }
    ranges.push(PrimitiveRange {
        gpu_start: source.gpu_primitive_base,
        source_start: source.source_primitive_base,
        count: triangle_count,
        triangle_start,
    });
    Ok(())
}

fn build_bvh_node(
    positions: &[WorldVec3],
    triangles: &[StoredTriangle],
    order: &mut [u32],
    order_start: usize,
    nodes: &mut Vec<BvhNode>,
) -> usize {
    let bounds = order.iter().fold(ExactAabb::empty(), |bounds, triangle| {
        bounds.union(triangle_bounds(
            positions,
            triangles[usize::try_from(*triangle).expect("stored u32 index")],
        ))
    });
    let node_index = nodes.len();
    nodes.push(BvhNode {
        bounds,
        kind: BvhNodeKind::Leaf {
            start: order_start,
            count: order.len(),
        },
    });
    if order.len() <= LEAF_TRIANGLES {
        return node_index;
    }
    let extent = bounds.maximum - bounds.minimum;
    let axis = if extent.x >= extent.y && extent.x >= extent.z {
        0
    } else if extent.y >= extent.z {
        1
    } else {
        2
    };
    order.sort_unstable_by(|left, right| {
        triangle_centroid(
            positions,
            triangles[usize::try_from(*left).expect("stored u32 index")],
        )[axis]
            .total_cmp(
                &triangle_centroid(
                    positions,
                    triangles[usize::try_from(*right).expect("stored u32 index")],
                )[axis],
            )
    });
    let middle = order.len() / 2;
    let (left_order, right_order) = order.split_at_mut(middle);
    let left = build_bvh_node(positions, triangles, left_order, order_start, nodes);
    let right = build_bvh_node(
        positions,
        triangles,
        right_order,
        order_start + middle,
        nodes,
    );
    nodes[node_index].kind = BvhNodeKind::Branch { left, right };
    node_index
}

impl ExactAabb {
    fn empty() -> Self {
        Self {
            minimum: DVec3::splat(f64::INFINITY),
            maximum: DVec3::splat(f64::NEG_INFINITY),
        }
    }

    fn include(mut self, point: DVec3) -> Self {
        self.minimum = self.minimum.min(point);
        self.maximum = self.maximum.max(point);
        self
    }

    fn union(self, other: Self) -> Self {
        Self {
            minimum: self.minimum.min(other.minimum),
            maximum: self.maximum.max(other.maximum),
        }
    }
}

fn triangle_bounds(positions: &[WorldVec3], triangle: StoredTriangle) -> ExactAabb {
    triangle
        .indices
        .iter()
        .fold(ExactAabb::empty(), |bounds, index| {
            bounds.include(vector(
                positions[usize::try_from(*index).expect("stored u32 index")],
            ))
        })
}

fn triangle_centroid(positions: &[WorldVec3], triangle: StoredTriangle) -> DVec3 {
    triangle.indices.iter().fold(DVec3::ZERO, |sum, index| {
        sum + vector(positions[usize::try_from(*index).expect("stored u32 index")])
    }) / 3.0
}

fn push_ray_children(
    stack: &mut Vec<(usize, f64)>,
    origin: DVec3,
    direction: DVec3,
    maximum_distance: f64,
    left: usize,
    right: usize,
    nodes: &[BvhNode],
) {
    let left_distance = ray_aabb(origin, direction, nodes[left].bounds)
        .filter(|distance| *distance <= maximum_distance);
    let right_distance = ray_aabb(origin, direction, nodes[right].bounds)
        .filter(|distance| *distance <= maximum_distance);
    match (left_distance, right_distance) {
        (Some(left_distance), Some(right_distance)) if left_distance <= right_distance => {
            stack.push((right, right_distance));
            stack.push((left, left_distance));
        }
        (Some(left_distance), Some(right_distance)) => {
            stack.push((left, left_distance));
            stack.push((right, right_distance));
        }
        (Some(distance), None) => stack.push((left, distance)),
        (None, Some(distance)) => stack.push((right, distance)),
        (None, None) => {}
    }
}

fn ray_aabb(origin: DVec3, direction: DVec3, bounds: ExactAabb) -> Option<f64> {
    let mut minimum = 0.0_f64;
    let mut maximum = f64::INFINITY;
    for axis in 0..3 {
        if direction[axis].abs() <= f64::EPSILON {
            if origin[axis] < bounds.minimum[axis] || origin[axis] > bounds.maximum[axis] {
                return None;
            }
            continue;
        }
        let inverse = direction[axis].recip();
        let mut near = (bounds.minimum[axis] - origin[axis]) * inverse;
        let mut far = (bounds.maximum[axis] - origin[axis]) * inverse;
        if near > far {
            std::mem::swap(&mut near, &mut far);
        }
        minimum = minimum.max(near);
        maximum = maximum.min(far);
        if maximum < minimum {
            return None;
        }
    }
    Some(minimum)
}

fn ray_triangle(origin: DVec3, direction: DVec3, vertices: [DVec3; 3]) -> Option<(f64, [f64; 3])> {
    let edge_a = vertices[1] - vertices[0];
    let edge_b = vertices[2] - vertices[0];
    let cross = direction.cross(edge_b);
    let determinant = edge_a.dot(cross);
    let scale = edge_a.length().max(edge_b.length()).max(1.0);
    if determinant.abs() <= f64::EPSILON * scale * scale {
        return None;
    }
    let inverse = determinant.recip();
    let offset = origin - vertices[0];
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
    (distance.is_finite() && distance >= 0.0).then_some((distance, [1.0 - u - v, u, v]))
}

fn barycentric_coordinates(point: DVec3, vertices: [DVec3; 3]) -> [f64; 3] {
    let edge_a = vertices[1] - vertices[0];
    let edge_b = vertices[2] - vertices[0];
    let offset = point - vertices[0];
    let aa = edge_a.dot(edge_a);
    let ab = edge_a.dot(edge_b);
    let bb = edge_b.dot(edge_b);
    let pa = offset.dot(edge_a);
    let pb = offset.dot(edge_b);
    let denominator = aa * bb - ab * ab;
    if denominator.abs() <= f64::EPSILON * aa.max(bb).max(1.0).powi(2) {
        let nearest = vertices
            .iter()
            .enumerate()
            .min_by(|(_, left), (_, right)| {
                point
                    .distance_squared(**left)
                    .total_cmp(&point.distance_squared(**right))
            })
            .map_or(0, |(index, _)| index);
        return std::array::from_fn(|index| f64::from(index == nearest));
    }
    let second = (bb * pa - ab * pb) / denominator;
    let third = (aa * pb - ab * pa) / denominator;
    [1.0 - second - third, second, third]
}

fn aabb_distance_squared(point: DVec3, bounds: ExactAabb) -> f64 {
    let closest = point.clamp(bounds.minimum, bounds.maximum);
    point.distance_squared(closest)
}

fn closest_point_on_triangle(point: DVec3, triangle: [DVec3; 3]) -> DVec3 {
    let a = triangle[0];
    let b = triangle[1];
    let c = triangle[2];
    let ab = b - a;
    let ac = c - a;
    let scale_squared = ab.length_squared().max(ac.length_squared()).max(1.0);
    if ab.cross(ac).length_squared() <= f64::EPSILON * scale_squared * scale_squared {
        return [[a, b], [b, c], [c, a]]
            .into_iter()
            .map(|segment| closest_point_on_segment(point, segment[0], segment[1]))
            .min_by(|left, right| {
                point
                    .distance_squared(*left)
                    .total_cmp(&point.distance_squared(*right))
            })
            .unwrap_or(a);
    }
    let ap = point - a;
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = point - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return a + ab * (d1 / (d1 - d3));
    }
    let cp = point - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return a + ac * (d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    let denominator = (va + vb + vc).recip();
    a + ab * (vb * denominator) + ac * (vc * denominator)
}

fn closest_point_on_segment(point: DVec3, start: DVec3, end: DVec3) -> DVec3 {
    let edge = end - start;
    let length_squared = edge.length_squared();
    if length_squared <= f64::EPSILON {
        return start;
    }
    start + edge * ((point - start).dot(edge) / length_squared).clamp(0.0, 1.0)
}

fn closest_segment_parameter(start: DVec3, end: DVec3, origin: DVec3, direction: DVec3) -> f64 {
    let edge = end - start;
    let offset = origin - start;
    let edge_length_squared = edge.length_squared();
    if edge_length_squared <= f64::EPSILON {
        return 0.0;
    }
    let direction_length_squared = direction.length_squared();
    let coupling = direction.dot(edge);
    let denominator = direction_length_squared * edge_length_squared - coupling * coupling;
    if denominator.abs() <= f64::EPSILON {
        return (offset.dot(edge) / edge_length_squared).clamp(0.0, 1.0);
    }
    ((direction_length_squared * offset.dot(edge) - coupling * direction.dot(offset)) / denominator)
        .clamp(0.0, 1.0)
}

fn screen_radius(request: PickRefinementRequest<'_>) -> Option<f64> {
    let projected = request
        .camera
        .project_world(request.coarse.world_position, request.viewport)
        .ok()?;
    let center = request
        .camera
        .unproject_pixel(
            request.cursor_pixel,
            projected.reverse_z_depth,
            request.viewport,
        )
        .ok()?;
    let side = request
        .camera
        .unproject_pixel(
            [
                request.cursor_pixel[0] + request.pixel_tolerance.max(1.0),
                request.cursor_pixel[1],
            ],
            projected.reverse_z_depth,
            request.viewport,
        )
        .ok()?;
    let source_center =
        request.source_from_project(request.presentation_transform.source(center))?;
    let source_side = request.source_from_project(request.presentation_transform.source(side))?;
    let radius = vector(source_center).distance(vector(source_side));
    (radius.is_finite() && radius > 0.0).then_some(radius)
}

#[allow(clippy::cast_possible_truncation)]
fn push_candidate(
    candidates: &mut Vec<PickCandidate>,
    request: PickRefinementRequest<'_>,
    source_primitive_id: u64,
    position: WorldVec3,
    snap_kind: SnapKind,
) {
    let Some(project_position) = request.project_source(position) else {
        return;
    };
    let presented = request.presentation_transform.present(project_position);
    let Ok(projected) = request.camera.project_world(presented, request.viewport) else {
        return;
    };
    let pixel_distance = (projected.pixel[0] - request.cursor_pixel[0])
        .hypot(projected.pixel[1] - request.cursor_pixel[1]);
    if !pixel_distance.is_finite() || pixel_distance > request.pixel_tolerance {
        return;
    }
    let mut address = request.coarse.address.clone();
    address.primitive_id = Some(source_primitive_id);
    candidates.push(PickCandidate {
        address,
        world_position: project_position,
        snap_kind,
        pixel_distance: pixel_distance as f32,
        depth: (1.0 - projected.reverse_z_depth) as f32,
    });
}

fn allocation_bytes<T>(capacity: usize) -> u64 {
    u64::try_from(capacity)
        .unwrap_or(u64::MAX)
        .saturating_mul(u64::try_from(size_of::<T>()).unwrap_or(u64::MAX))
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
    use std::sync::Arc;

    use glam::{DMat4, DVec3};

    use super::{
        InstancedTriangleMeshPickRefiner, TriangleMeshPickBuildError, TriangleMeshPickInstance,
        TriangleMeshPickQueryLimits, TriangleMeshPickRefiner, TriangleMeshPickSource,
    };
    use crate::picking::PresentationTransform;
    use crate::{
        CameraFrame, CameraProjection, PickAddress, PickCandidate, PickRefinementRequest, SnapKind,
        WorldCamera, WorldRay, WorldTransform, WorldVec3,
    };

    #[test]
    fn primitive_ranges_map_gpu_ids_to_stable_source_triangles() {
        let first_positions = triangle_at(0.0);
        let second_positions = triangle_at(10.0);
        let indices = [0, 1, 2];
        let refiner = TriangleMeshPickRefiner::build(&[
            TriangleMeshPickSource {
                positions: &first_positions,
                indices: &indices,
                transform: WorldTransform::IDENTITY,
                leaf_origin: zero(),
                gpu_primitive_base: 4,
                source_primitive_base: 100,
            },
            TriangleMeshPickSource {
                positions: &second_positions,
                indices: &indices,
                transform: WorldTransform::IDENTITY,
                leaf_origin: zero(),
                gpu_primitive_base: 20,
                source_primitive_base: 900,
            },
        ])
        .expect("refiner");

        assert_eq!(refiner.source_primitive_id(4), Some(100));
        assert_eq!(refiner.source_primitive_id(20), Some(900));
        assert_eq!(refiner.source_primitive_id(5), None);
        assert!(refiner.resident_bytes() > 0);
    }

    #[test]
    fn primitive_range_boundaries_remain_portable_and_source_addresses_are_unique() {
        let positions = triangle_at(0.0);
        let indices = [0, 1, 2];
        let maximum = TriangleMeshPickRefiner::build(&[TriangleMeshPickSource {
            positions: &positions,
            indices: &indices,
            transform: WorldTransform::IDENTITY,
            leaf_origin: zero(),
            gpu_primitive_base: u32::MAX,
            source_primitive_base: u64::MAX,
        }])
        .expect("maximum primitive address");
        assert_eq!(
            maximum.source_primitive_id(u64::from(u32::MAX)),
            Some(u64::MAX)
        );

        let overlap = TriangleMeshPickRefiner::build(&[
            TriangleMeshPickSource {
                positions: &positions,
                indices: &indices,
                transform: WorldTransform::IDENTITY,
                leaf_origin: zero(),
                gpu_primitive_base: 0,
                source_primitive_base: 5,
            },
            TriangleMeshPickSource {
                positions: &positions,
                indices: &indices,
                transform: WorldTransform::IDENTITY,
                leaf_origin: zero(),
                gpu_primitive_base: 1,
                source_primitive_base: 5,
            },
        ]);
        assert!(matches!(
            overlap,
            Err(TriangleMeshPickBuildError::SourcePrimitiveRange)
        ));
    }

    #[test]
    fn transform_and_leaf_origin_preserve_ecef_millimetres_and_exact_snaps() {
        let positions = [
            point(0.001, 0.002, 0.0),
            point(0.004, 0.002, 0.0),
            point(0.001, 0.006, 0.0),
        ];
        let indices = [0, 1, 2];
        let transform = WorldTransform([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.125, -0.25, 0.5, 1.0,
        ]);
        let origin = point(6_378_137.0, 5_400_000.0, 712.0);
        let refiner = TriangleMeshPickRefiner::build(&[TriangleMeshPickSource {
            positions: &positions,
            indices: &indices,
            transform,
            leaf_origin: origin,
            gpu_primitive_base: 7,
            source_primitive_base: 42,
        }])
        .expect("refiner");
        let expected = point(origin.x + 0.126, origin.y - 0.248, origin.z + 0.5);
        let ray = WorldRay {
            origin: point(expected.x, expected.y, expected.z + 10.0),
            direction: point(0.0, 0.0, -1.0),
        };
        let query = refiner.ray_query(ray, 20.0, TriangleMeshPickQueryLimits::default());
        assert_eq!(query.hits.len(), 1);
        assert_eq!(query.hits[0].source_primitive_id, 42);
        assert!((query.hits[0].world_position.x - expected.x).abs() < 1.0e-9);
        assert!((query.hits[0].world_position.y - expected.y).abs() < 1.0e-9);

        let target = point(expected.x + 0.001, expected.y + 0.001, expected.z);
        let camera = camera(target);
        let pixel = camera
            .project_world(target, [1_000, 800])
            .expect("project")
            .pixel;
        let coarse = candidate(7, target);
        let candidates = refiner.refine(request(&coarse, &camera, pixel, 256.0));
        assert!(candidates.iter().any(|candidate| {
            candidate.address.primitive_id == Some(42) && candidate.snap_kind == SnapKind::Surface
        }));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.snap_kind == SnapKind::Edge));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.snap_kind == SnapKind::Vertex));
    }

    #[test]
    fn exaggerated_triangle_refines_in_source_space_and_ranks_in_presentation_space() {
        let positions = [
            point(-1.0, 0.0, 501.0),
            point(1.0, 0.0, 502.0),
            point(0.0, 2.0, 503.0),
        ];
        let indices = [0, 1, 2];
        let refiner = TriangleMeshPickRefiner::build(&[TriangleMeshPickSource {
            positions: &positions,
            indices: &indices,
            transform: WorldTransform::IDENTITY,
            leaf_origin: zero(),
            gpu_primitive_base: 7,
            source_primitive_base: 42,
        }])
        .expect("refiner");
        let presentation = PresentationTransform::new(2.0, 500.0).expect("invertible");
        let source_center = point(0.0, 2.0 / 3.0, 502.0);
        let presented_center = presentation.present(source_center);
        let camera = camera(presented_center);
        let cursor = camera
            .project_world(presented_center, [1_000, 800])
            .expect("presented center")
            .pixel;
        let coarse = candidate(7, presented_center);
        let candidates = refiner.refine(request_with_presentation(
            &coarse,
            &camera,
            cursor,
            2_000.0,
            presentation,
        ));

        let surface = candidates
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Surface)
            .expect("exact source face");
        assert_eq!(surface.address.primitive_id, Some(42));
        assert!((surface.world_position.x - source_center.x).abs() < 1.0e-10);
        assert!((surface.world_position.y - source_center.y).abs() < 1.0e-10);
        assert!((surface.world_position.z - source_center.z).abs() < 1.0e-10);
        assert_ne!(surface.world_position.z, presented_center.z);

        for source_vertex in positions {
            assert!(candidates.iter().any(|candidate| {
                candidate.snap_kind == SnapKind::Vertex
                    && super::vector(candidate.world_position)
                        .distance(super::vector(source_vertex))
                        < 1.0e-10
            }));
        }
        let edge = candidates
            .iter()
            .find(|candidate| candidate.snap_kind == SnapKind::Edge)
            .expect("source edge");
        assert!([
            [positions[0], positions[1]],
            [positions[1], positions[2]],
            [positions[2], positions[0]],
        ]
        .iter()
        .any(|vertices| {
            let point = super::vector(edge.world_position);
            point.distance(super::closest_point_on_segment(
                point,
                super::vector(vertices[0]),
                super::vector(vertices[1]),
            )) < 1.0e-10
        }));
        let projected_edge = camera
            .project_world(presentation.present(edge.world_position), [1_000, 800])
            .expect("presented edge");
        let expected_pixel_distance =
            (projected_edge.pixel[0] - cursor[0]).hypot(projected_edge.pixel[1] - cursor[1]);
        assert!((f64::from(edge.pixel_distance) - expected_pixel_distance).abs() < 1.0e-4);
    }

    #[test]
    fn bvh_queries_are_hard_bounded_independently_from_triangle_count() {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for row in 0..100_u32 {
            for column in 0..100_u32 {
                let base = u32::try_from(positions.len()).expect("test vertices");
                let x = f64::from(column) * 2.0;
                let y = f64::from(row) * 2.0;
                positions.extend([
                    point(x, y, 0.0),
                    point(x + 1.0, y, 0.0),
                    point(x, y + 1.0, 0.0),
                ]);
                indices.extend([base, base + 1, base + 2]);
            }
        }
        let refiner = TriangleMeshPickRefiner::build(&[TriangleMeshPickSource {
            positions: &positions,
            indices: &indices,
            transform: WorldTransform::IDENTITY,
            leaf_origin: zero(),
            gpu_primitive_base: 0,
            source_primitive_base: 0,
        }])
        .expect("refiner");
        let limits = TriangleMeshPickQueryLimits {
            maximum_hits: 4,
            maximum_tested_triangles: 32,
            maximum_visited_nodes: 64,
        };
        let query = refiner.ray_query(
            WorldRay {
                origin: point(0.25, 0.25, 10.0),
                direction: point(0.0, 0.0, -1.0),
            },
            20.0,
            limits,
        );
        assert_eq!(query.hits.len(), 1);
        assert!(query.stats.tested_triangles <= 32);
        assert!(query.stats.visited_nodes <= 64);
        assert!(query.stats.tested_triangles < indices.len() / 3);

        let nearby = refiner.nearby_query(point(0.25, 0.25, 0.1), 0.2, limits);
        assert_eq!(nearby.hits.len(), 1);
        assert!(nearby.stats.tested_triangles <= 32);
        assert!(nearby.stats.visited_nodes <= 64);
    }

    #[test]
    fn shared_model_and_instance_bvh_preserve_exact_source_addresses() {
        let positions = triangle_at(0.0);
        let indices = [0, 1, 2];
        let model = Arc::new(
            TriangleMeshPickRefiner::build(&[TriangleMeshPickSource {
                positions: &positions,
                indices: &indices,
                transform: WorldTransform::IDENTITY,
                leaf_origin: zero(),
                gpu_primitive_base: 0,
                source_primitive_base: 0,
            }])
            .expect("shared model"),
        );
        let second_transform = DMat4::from_scale_rotation_translation(
            DVec3::new(2.0, 3.0, 1.0),
            glam::DQuat::IDENTITY,
            DVec3::new(100.0, 20.0, 7.0),
        );
        let refiner = InstancedTriangleMeshPickRefiner::build(
            model,
            &[
                TriangleMeshPickInstance {
                    world_from_model: WorldTransform::IDENTITY,
                    gpu_primitive_base: 0,
                    source_primitive_base: 100,
                },
                TriangleMeshPickInstance {
                    world_from_model: WorldTransform(second_transform.to_cols_array()),
                    gpu_primitive_base: 1,
                    source_primitive_base: 900,
                },
            ],
        )
        .expect("instance BVH");

        assert_eq!(refiner.source_primitive_id(0), Some(100));
        assert_eq!(refiner.source_primitive_id(1), Some(900));
        let query = refiner.ray_query(
            WorldRay {
                origin: point(100.5, 20.75, 17.0),
                direction: point(0.0, 0.0, -1.0),
            },
            20.0,
            TriangleMeshPickQueryLimits::default(),
        );
        assert_eq!(query.hits.len(), 1);
        assert_eq!(query.hits[0].source_primitive_id, 900);
        assert!((query.hits[0].world_position.z - 7.0).abs() < 1.0e-12);
        assert_eq!(
            refiner
                .ray_query(
                    WorldRay {
                        origin: point(100.5, 20.75, 17.0),
                        direction: point(0.0, 0.0, -1.0),
                    },
                    f64::MAX,
                    TriangleMeshPickQueryLimits::default(),
                )
                .hits
                .len(),
            1
        );
        let barycentric = refiner
            .source_triangle_barycentric(900, query.hits[0].world_position)
            .expect("barycentric");
        assert!((barycentric.iter().sum::<f64>() - 1.0).abs() < 1.0e-12);
    }

    #[test]
    fn shared_model_storage_does_not_scale_with_instances_times_triangles() {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for triangle in 0..64_u32 {
            let base = u32::try_from(positions.len()).expect("test positions");
            positions.extend(triangle_at(f64::from(triangle) * 2.0));
            indices.extend([base, base + 1, base + 2]);
        }
        let model = Arc::new(
            TriangleMeshPickRefiner::build(&[TriangleMeshPickSource {
                positions: &positions,
                indices: &indices,
                transform: WorldTransform::IDENTITY,
                leaf_origin: zero(),
                gpu_primitive_base: 0,
                source_primitive_base: 0,
            }])
            .expect("shared model"),
        );
        let instances = (0..128_u32)
            .map(|instance| TriangleMeshPickInstance {
                world_from_model: WorldTransform(
                    DMat4::from_translation(DVec3::new(0.0, f64::from(instance) * 3.0, 0.0))
                        .to_cols_array(),
                ),
                gpu_primitive_base: instance * 64,
                source_primitive_base: u64::from(instance) * 64,
            })
            .collect::<Vec<_>>();
        let compact = InstancedTriangleMeshPickRefiner::build(Arc::clone(&model), &instances)
            .expect("compact index");

        let expanded_sources = instances
            .iter()
            .map(|instance| TriangleMeshPickSource {
                positions: positions.as_slice(),
                indices: indices.as_slice(),
                transform: instance.world_from_model,
                leaf_origin: zero(),
                gpu_primitive_base: instance.gpu_primitive_base,
                source_primitive_base: instance.source_primitive_base,
            })
            .collect::<Vec<_>>();
        let expanded = TriangleMeshPickRefiner::build(&expanded_sources).expect("expanded index");
        assert!(compact.resident_bytes() * 4 < expanded.resident_bytes());

        let query = compact.ray_query(
            WorldRay {
                origin: point(0.25, 381.25, 10.0),
                direction: point(0.0, 0.0, -1.0),
            },
            20.0,
            TriangleMeshPickQueryLimits {
                maximum_hits: 4,
                maximum_tested_triangles: 32,
                maximum_visited_nodes: 128,
            },
        );
        assert_eq!(query.hits.len(), 1);
        assert_eq!(query.hits[0].source_primitive_id, 127 * 64);
        assert!(query.stats.tested_triangles <= 32);
        assert!(query.stats.visited_nodes <= 128);
    }

    fn triangle_at(x: f64) -> [WorldVec3; 3] {
        [
            point(x, 0.0, 0.0),
            point(x + 1.0, 0.0, 0.0),
            point(x, 1.0, 0.0),
        ]
    }

    fn zero() -> WorldVec3 {
        point(0.0, 0.0, 0.0)
    }

    fn point(x: f64, y: f64, z: f64) -> WorldVec3 {
        WorldVec3 { x, y, z }
    }

    fn camera(target: WorldVec3) -> CameraFrame {
        CameraFrame::new(
            WorldCamera {
                eye: point(target.x, target.y - 5.0, target.z + 5.0),
                target,
                up: point(0.0, 0.0, 1.0),
                projection: CameraProjection::Perspective {
                    vertical_fov_radians: 1.0,
                    aspect: 1.25,
                    near: 0.01,
                    far: 1_000.0,
                },
            },
            target,
        )
        .expect("camera")
    }

    fn candidate(primitive_id: u64, world_position: WorldVec3) -> PickCandidate {
        PickCandidate {
            address: PickAddress {
                entity_id: "mesh".to_owned(),
                render_proxy_id: "mesh@1".to_owned(),
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

    fn request<'a>(
        coarse: &'a PickCandidate,
        camera: &'a CameraFrame,
        cursor_pixel: [f64; 2],
        pixel_tolerance: f64,
    ) -> PickRefinementRequest<'a> {
        request_with_presentation(
            coarse,
            camera,
            cursor_pixel,
            pixel_tolerance,
            PresentationTransform::IDENTITY,
        )
    }

    fn request_with_presentation<'a>(
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
            source_to_project: WorldTransform::IDENTITY,
            presentation_transform,
            cursor_pixel,
            viewport: [1_000, 800],
            pixel_tolerance,
        }
    }
}
