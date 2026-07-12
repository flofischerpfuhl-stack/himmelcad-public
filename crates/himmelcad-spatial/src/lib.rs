//! Spatial indexing primitives for HimmelCAD.
//!
//! Cursor coordinates, picking, segmentation, and (later) tile streaming all
//! depend on these. The crate is plain Rust with `glam`, no platform deps,
//! so it compiles equally for native sidecar and `wasm32-unknown-unknown`.
//!
//! Today: point-cloud octree with k-NN, ray-nearest, and a PCA local-plane
//! estimator for surface interpolation. Coming: triangle BVH (mesh snap),
//! grid index for DGM, splat tree.

#![forbid(unsafe_code)]

pub mod aabb;
pub mod octree_points;
pub mod query;
pub mod serialize;

pub use aabb::Aabb;
pub use octree_points::{
    BuildOptions, KnnHit, OctreeNode, PointOctree, RayHit, DEFAULT_LEAF_CAPACITY, MAX_DEPTH,
    MAX_POINTS_PER_OCTREE,
};
pub use query::{fit_plane, ray_plane_intersect, LocalPlane};
pub use serialize::{
    read as read_octree, read_bytes as read_octree_bytes, write as write_octree, OctreeIoError,
};
