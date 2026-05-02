//! Spatial indexing primitives.
//!
//! Skeleton crate. Octree (Potree-2.0-compatible) and kd-tree implementations
//! land in MVP Workstreams 5 and 8.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}
