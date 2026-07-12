//! Point-cloud octree.
//!
//! Built once from a contiguous `[f32; 3]` position array. Stores nodes plus a
//! permutation of point indices so each leaf's points are contiguous in the
//! permutation. Positions themselves are NOT duplicated by the octree — query
//! methods take the original positions slice and read it indirectly through
//! `point_indices`.
//!
//! Build cost: O(n log n). Build memory: O(n) extra (one u32 per point) plus a
//! small temporary scratch buffer. Designed so that one octree corresponds to
//! one tile; a billion-point dataset is many octrees, never one.
//!
//! Query budget: k-NN at k=32 with ~1M points walks O(log n) nodes plus a few
//! leaves; typical sub-millisecond on a laptop. Ray-nearest is similar.

use std::collections::BinaryHeap;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::aabb::{octant_index, Aabb};

/// Hard ceiling for in-memory build. Tile splitting beyond this is the
/// importer's responsibility.
pub const MAX_POINTS_PER_OCTREE: usize = 64_000_000;

/// Maximum points stored in a single leaf. Smaller = more nodes but tighter
/// pruning; larger = fewer nodes but more linear scan per leaf.
pub const DEFAULT_LEAF_CAPACITY: u32 = 1024;

/// Maximum subdivision depth. 20 is plenty: a 10 km extent at depth 20 has
/// leaf cubes ~10 mm wide, far below cursor pixel resolution.
pub const MAX_DEPTH: u8 = 20;

const NO_CHILD: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OctreeNode {
    pub bounds: Aabb,
    pub children: [u32; 8],
    /// Range of `point_indices` covered by this node (inclusive start,
    /// exclusive end). For internal nodes this is the union of children.
    pub point_start: u32,
    pub point_count: u32,
    pub depth: u8,
}

impl OctreeNode {
    pub fn is_leaf(&self) -> bool {
        for c in self.children {
            if c != NO_CHILD {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointOctree {
    /// World offset that was subtracted from the source `f64` coordinates
    /// before they became the local `f32` positions this octree indexes.
    /// Add it back to convert local positions to world coordinates.
    pub render_offset: [f64; 3],
    pub bounds_local: Aabb,
    pub nodes: Vec<OctreeNode>,
    /// Permutation of `[0, point_count)`; each leaf's points are contiguous.
    /// To read leaf points: for `i in 0..node.point_count` look up
    /// `point_indices[node.point_start + i]`, then `positions[3*idx..]`.
    pub point_indices: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
pub struct KnnHit {
    /// Index into the original positions array (`positions[3*index..]`).
    pub point_index: u32,
    pub distance_sq: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct RayHit {
    pub point_index: u32,
    /// Distance from the ray (perpendicular), squared.
    pub ray_distance_sq: f32,
    /// Distance along the ray from origin.
    pub t: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct BuildOptions {
    pub leaf_capacity: u32,
    pub max_depth: u8,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            leaf_capacity: DEFAULT_LEAF_CAPACITY,
            max_depth: MAX_DEPTH,
        }
    }
}

impl PointOctree {
    /// Build the octree over `positions`. `positions.len()` must be `3 * n`.
    /// Does not modify `positions`. Returns the index permutation in
    /// `point_indices`.
    ///
    /// Panics if `n > MAX_POINTS_PER_OCTREE`. Callers exceeding that must
    /// split into tiles upstream.
    pub fn build(positions: &[f32], render_offset: [f64; 3], opts: BuildOptions) -> Self {
        assert!(
            positions.len() % 3 == 0,
            "positions length must be a multiple of 3"
        );
        let n = positions.len() / 3;
        assert!(
            n <= MAX_POINTS_PER_OCTREE,
            "octree input larger than MAX_POINTS_PER_OCTREE; tile upstream"
        );

        let bounds_local = Aabb::from_points_f32(positions).bounding_cube();
        let point_count = u32::try_from(n).expect("point limit guarantees a u32 point count");
        let mut indices: Vec<u32> = (0..point_count).collect();
        let mut nodes: Vec<OctreeNode> = Vec::new();

        if n > 0 {
            build_recurse(
                positions,
                &mut indices,
                &mut nodes,
                0,
                point_count,
                bounds_local,
                0,
                opts,
            );
        } else {
            nodes.push(OctreeNode {
                bounds: bounds_local,
                children: [NO_CHILD; 8],
                point_start: 0,
                point_count: 0,
                depth: 0,
            });
        }

        Self {
            render_offset,
            bounds_local,
            nodes,
            point_indices: indices,
        }
    }

    pub fn point_count(&self) -> u32 {
        u32::try_from(self.point_indices.len()).expect("octree point count exceeds u32")
    }

    pub fn node_count(&self) -> u32 {
        u32::try_from(self.nodes.len()).expect("octree node count exceeds u32")
    }

    /// k-nearest neighbours of `query` in local space. Results sorted by
    /// distance ascending. Returns at most `k` hits.
    pub fn k_nearest(&self, positions: &[f32], query: Vec3, k: usize) -> Vec<KnnHit> {
        if k == 0 || self.nodes.is_empty() {
            return Vec::new();
        }
        let mut heap: BinaryHeap<HeapHit> = BinaryHeap::with_capacity(k);
        knn_recurse(self, positions, 0, query, k, &mut heap);
        let mut out: Vec<KnnHit> = heap
            .into_iter()
            .map(|h| KnnHit {
                point_index: h.point_index,
                distance_sq: h.distance_sq,
            })
            .collect();
        out.sort_by(|a, b| {
            a.distance_sq
                .partial_cmp(&b.distance_sq)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    /// Closest point whose perpendicular distance to the ray is below
    /// `max_perp_dist`, in local units. Returns the closest by perpendicular
    /// distance (not by `t`), preferring near-camera hits when ties.
    pub fn nearest_to_ray(
        &self,
        positions: &[f32],
        origin: Vec3,
        dir: Vec3,
        max_perp_dist: f32,
    ) -> Option<RayHit> {
        if self.nodes.is_empty() {
            return None;
        }
        let dir_n = dir.normalize_or_zero();
        if dir_n == Vec3::ZERO {
            return None;
        }
        // Inverse direction with safe handling of zero components.
        let dir_inv = Vec3::new(
            if dir_n.x.abs() > f32::EPSILON {
                1.0 / dir_n.x
            } else {
                f32::INFINITY
            },
            if dir_n.y.abs() > f32::EPSILON {
                1.0 / dir_n.y
            } else {
                f32::INFINITY
            },
            if dir_n.z.abs() > f32::EPSILON {
                1.0 / dir_n.z
            } else {
                f32::INFINITY
            },
        );
        let mut best: Option<RayHit> = None;
        ray_recurse(
            self,
            positions,
            0,
            origin,
            dir_n,
            dir_inv,
            max_perp_dist,
            &mut best,
        );
        best
    }

    /// Convenience: project a local position to world coordinates.
    pub fn local_to_world(&self, p: Vec3) -> [f64; 3] {
        [
            f64::from(p.x) + self.render_offset[0],
            f64::from(p.y) + self.render_offset[1],
            f64::from(p.z) + self.render_offset[2],
        ]
    }
}

/// Heap entry sorted so the LARGEST distance pops first (max-heap), enabling
/// efficient bounded-k nearest-neighbour insertion.
#[derive(Debug, Clone, Copy)]
struct HeapHit {
    point_index: u32,
    distance_sq: f32,
}

impl PartialEq for HeapHit {
    fn eq(&self, other: &Self) -> bool {
        self.distance_sq == other.distance_sq
    }
}

impl Eq for HeapHit {}

impl PartialOrd for HeapHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.distance_sq
            .partial_cmp(&other.distance_sq)
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

fn knn_recurse(
    tree: &PointOctree,
    positions: &[f32],
    node_idx: u32,
    query: Vec3,
    k: usize,
    heap: &mut BinaryHeap<HeapHit>,
) {
    let node = &tree.nodes[node_idx as usize];

    if heap.len() == k {
        let worst = heap.peek().map_or(f32::INFINITY, |h| h.distance_sq);
        if node.bounds.distance_sq_to_point(query) > worst {
            return;
        }
    }

    if node.is_leaf() {
        let start = node.point_start as usize;
        let end = start + node.point_count as usize;
        for slot in start..end {
            let point_index = tree.point_indices[slot];
            let pi = point_index as usize;
            let base = pi * 3;
            let p = Vec3::new(positions[base], positions[base + 1], positions[base + 2]);
            let d2 = (p - query).length_squared();
            if heap.len() < k {
                heap.push(HeapHit {
                    point_index,
                    distance_sq: d2,
                });
            } else if let Some(top) = heap.peek() {
                if d2 < top.distance_sq {
                    heap.pop();
                    heap.push(HeapHit {
                        point_index,
                        distance_sq: d2,
                    });
                }
            }
        }
        return;
    }

    // Sort children by distance to query for best pruning.
    let mut order: [(usize, f32); 8] = [(0, f32::INFINITY); 8];
    for (slot, child_idx) in node.children.iter().enumerate() {
        order[slot] = if *child_idx == NO_CHILD {
            (slot, f32::INFINITY)
        } else {
            let cn = &tree.nodes[*child_idx as usize];
            (slot, cn.bounds.distance_sq_to_point(query))
        };
    }
    order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    for (slot, _) in order {
        let child_idx = node.children[slot];
        if child_idx == NO_CHILD {
            continue;
        }
        knn_recurse(tree, positions, child_idx, query, k, heap);
    }
}

#[allow(clippy::too_many_arguments)]
fn ray_recurse(
    tree: &PointOctree,
    positions: &[f32],
    node_idx: u32,
    origin: Vec3,
    dir: Vec3,
    dir_inv: Vec3,
    max_perp_dist: f32,
    best: &mut Option<RayHit>,
) {
    let node = &tree.nodes[node_idx as usize];

    // Prune: bbox expanded by max_perp_dist must intersect the ray.
    let expanded = Aabb {
        min: [
            node.bounds.min[0] - f64::from(max_perp_dist),
            node.bounds.min[1] - f64::from(max_perp_dist),
            node.bounds.min[2] - f64::from(max_perp_dist),
        ],
        max: [
            node.bounds.max[0] + f64::from(max_perp_dist),
            node.bounds.max[1] + f64::from(max_perp_dist),
            node.bounds.max[2] + f64::from(max_perp_dist),
        ],
    };
    if expanded.ray_intersect(origin, dir_inv).is_none() {
        return;
    }

    if node.is_leaf() {
        let start = node.point_start as usize;
        let end = start + node.point_count as usize;
        let max_perp_sq = max_perp_dist * max_perp_dist;
        let best_sq = best.map_or(max_perp_sq, |b| b.ray_distance_sq.min(max_perp_sq));
        for slot in start..end {
            let point_index = tree.point_indices[slot];
            let pi = point_index as usize;
            let base = pi * 3;
            let p = Vec3::new(positions[base], positions[base + 1], positions[base + 2]);
            let to_p = p - origin;
            let t = to_p.dot(dir);
            if t < 0.0 {
                continue;
            }
            let perp_sq = to_p.length_squared() - t * t;
            if perp_sq < best_sq && perp_sq <= max_perp_sq {
                *best = Some(RayHit {
                    point_index,
                    ray_distance_sq: perp_sq,
                    t,
                });
            }
        }
        return;
    }

    for child_idx in node.children {
        if child_idx == NO_CHILD {
            continue;
        }
        ray_recurse(
            tree,
            positions,
            child_idx,
            origin,
            dir,
            dir_inv,
            max_perp_dist,
            best,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn build_recurse(
    positions: &[f32],
    indices: &mut [u32],
    nodes: &mut Vec<OctreeNode>,
    range_start: u32,
    range_count: u32,
    bounds: Aabb,
    depth: u8,
    opts: BuildOptions,
) -> u32 {
    let node_idx = u32::try_from(nodes.len()).expect("octree node count exceeds u32");
    nodes.push(OctreeNode {
        bounds,
        children: [NO_CHILD; 8],
        point_start: range_start,
        point_count: range_count,
        depth,
    });

    if range_count <= opts.leaf_capacity || depth >= opts.max_depth {
        return node_idx;
    }

    let center = bounds.center();
    let lo = range_start as usize;
    let hi = (range_start + range_count) as usize;

    // Partition indices in `[lo..hi)` into 8 contiguous octant groups.
    // Two-pass counting sort keeps it cache-friendly and stable.
    let mut counts = [0u32; 8];
    for &pi in &indices[lo..hi] {
        let base = pi as usize * 3;
        let p = [positions[base], positions[base + 1], positions[base + 2]];
        counts[octant_index(p, center)] += 1;
    }

    let mut starts = [0u32; 8];
    let mut acc = range_start;
    for (start, count) in starts.iter_mut().zip(counts.iter()) {
        *start = acc;
        acc += *count;
    }

    // Scratch reorder.
    let mut scratch: Vec<u32> = vec![0; range_count as usize];
    let mut cursors = starts;
    for &pi in &indices[lo..hi] {
        let base = pi as usize * 3;
        let p = [positions[base], positions[base + 1], positions[base + 2]];
        let o = octant_index(p, center);
        let dst = (cursors[o] - range_start) as usize;
        cursors[o] += 1;
        scratch[dst] = pi;
    }
    indices[lo..hi].copy_from_slice(&scratch);

    for octant in 0..8usize {
        let count = counts[octant];
        if count == 0 {
            continue;
        }
        let child_bounds = bounds.child_cube(octant);
        let child_idx = build_recurse(
            positions,
            indices,
            nodes,
            starts[octant],
            count,
            child_bounds,
            depth + 1,
            opts,
        );
        nodes[node_idx as usize].children[octant] = child_idx;
    }

    node_idx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_grid(n: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(n * n * n * 3);
        for x in 0..n {
            for y in 0..n {
                for z in 0..n {
                    v.push(x as f32);
                    v.push(y as f32);
                    v.push(z as f32);
                }
            }
        }
        v
    }

    #[test]
    fn knn_returns_self() {
        let pts = make_grid(8);
        let oct = PointOctree::build(&pts, [0.0, 0.0, 0.0], BuildOptions::default());
        let hits = oct.k_nearest(&pts, Vec3::new(3.0, 3.0, 3.0), 1);
        assert_eq!(hits.len(), 1);
        let hit = hits[0];
        let base = hit.point_index as usize * 3;
        assert!((pts[base] - 3.0).abs() < 1e-3);
        assert!((pts[base + 1] - 3.0).abs() < 1e-3);
        assert!((pts[base + 2] - 3.0).abs() < 1e-3);
    }

    #[test]
    fn knn_returns_k() {
        let pts = make_grid(8);
        let oct = PointOctree::build(&pts, [0.0, 0.0, 0.0], BuildOptions::default());
        let hits = oct.k_nearest(&pts, Vec3::new(3.5, 3.5, 3.5), 16);
        assert_eq!(hits.len(), 16);
        // First eight hits should be the corners of the cube around (3.5,3.5,3.5).
        for hit in &hits[..8] {
            assert!(hit.distance_sq <= 0.76); // sqrt(0.75) ~ 0.866
        }
    }

    #[test]
    fn ray_finds_closest_point_on_axis() {
        let pts = make_grid(8);
        let oct = PointOctree::build(&pts, [0.0, 0.0, 0.0], BuildOptions::default());
        let hit = oct
            .nearest_to_ray(
                &pts,
                Vec3::new(-1.0, 4.0, 4.0),
                Vec3::new(1.0, 0.0, 0.0),
                0.1,
            )
            .expect("ray should hit grid");
        let base = hit.point_index as usize * 3;
        assert_eq!((pts[base + 1] as i32, pts[base + 2] as i32), (4, 4));
    }

    #[test]
    fn empty_input() {
        let pts: Vec<f32> = Vec::new();
        let oct = PointOctree::build(&pts, [0.0, 0.0, 0.0], BuildOptions::default());
        assert!(oct.k_nearest(&pts, Vec3::ZERO, 4).is_empty());
        assert!(oct.nearest_to_ray(&pts, Vec3::ZERO, Vec3::X, 1.0).is_none());
    }
}
