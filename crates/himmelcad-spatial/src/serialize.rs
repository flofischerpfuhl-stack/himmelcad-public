//! Binary persistence for `PointOctree`.
//!
//! Format is intentionally simple, fixed-stride, little-endian, so the WASM
//! runtime can parse it with a single allocation. Versioned via a u32 in the
//! header.
//!
//! Layout:
//!
//! ```text
//! Header (64 bytes):
//!   magic u32        = 0x484D4F54  ("HMOT" in LE)
//!   version u32      = 1
//!   flags u32        = 0
//!   point_count u32
//!   node_count u32
//!   leaf_capacity u32
//!   max_depth u32
//!   _reserved u32
//!   render_offset f64[3]   (24 B)
//! Bounds (48 bytes):
//!   bounds_min f64[3]      (24 B)
//!   bounds_max f64[3]      (24 B)
//! Nodes (node_count * 88 bytes each):
//!   bounds_min f64[3]      (24 B)
//!   bounds_max f64[3]      (24 B)
//!   children   u32[8]      (32 B)
//!   point_start u32        ( 4 B)
//!   point_count u32        ( 4 B)
//! Indices (point_count * 4 bytes): u32 array
//! ```

use std::io::{Read, Write};

use crate::aabb::Aabb;
use crate::octree_points::{OctreeNode, PointOctree};

pub const MAGIC: u32 = 0x484D_4F54; // "HMOT"
pub const VERSION: u32 = 1;
// 8 u32s (32 B) + render_offset f64[3] (24 B) = 56 B
const HEADER_SIZE: usize = 56;
const BOUNDS_SIZE: usize = 48;
const NODE_SIZE: usize = 88;

#[derive(Debug, thiserror::Error)]
pub enum OctreeIoError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("bad magic")]
    BadMagic,
    #[error("unsupported version: {0}")]
    UnsupportedVersion(u32),
    #[error("truncated input")]
    Truncated,
    #[error("octree exceeds the u32 persistence format")]
    CapacityExceeded,
}

pub fn write<W: Write>(octree: &PointOctree, mut w: W) -> Result<(), OctreeIoError> {
    let n_nodes = u32::try_from(octree.nodes.len()).map_err(|_| OctreeIoError::CapacityExceeded)?;
    let n_points =
        u32::try_from(octree.point_indices.len()).map_err(|_| OctreeIoError::CapacityExceeded)?;

    let mut header = [0u8; HEADER_SIZE];
    let mut cur = 0;
    write_u32(&mut header, &mut cur, MAGIC);
    write_u32(&mut header, &mut cur, VERSION);
    write_u32(&mut header, &mut cur, 0);
    write_u32(&mut header, &mut cur, n_points);
    write_u32(&mut header, &mut cur, n_nodes);
    write_u32(
        &mut header,
        &mut cur,
        super::octree_points::DEFAULT_LEAF_CAPACITY,
    );
    write_u32(
        &mut header,
        &mut cur,
        u32::from(super::octree_points::MAX_DEPTH),
    );
    write_u32(&mut header, &mut cur, 0); // reserved
    write_f64x3(&mut header, &mut cur, octree.render_offset);
    debug_assert_eq!(cur, HEADER_SIZE);
    w.write_all(&header)?;

    let mut bounds = [0u8; BOUNDS_SIZE];
    let mut cur = 0;
    write_f64x3(&mut bounds, &mut cur, octree.bounds_local.min);
    write_f64x3(&mut bounds, &mut cur, octree.bounds_local.max);
    debug_assert_eq!(cur, BOUNDS_SIZE);
    w.write_all(&bounds)?;

    let mut node_buf = [0u8; NODE_SIZE];
    for node in &octree.nodes {
        let mut cur = 0;
        write_f64x3(&mut node_buf, &mut cur, node.bounds.min);
        write_f64x3(&mut node_buf, &mut cur, node.bounds.max);
        for child in node.children {
            write_u32(&mut node_buf, &mut cur, child);
        }
        write_u32(&mut node_buf, &mut cur, node.point_start);
        write_u32(&mut node_buf, &mut cur, node.point_count);
        debug_assert_eq!(cur, NODE_SIZE);
        w.write_all(&node_buf)?;
    }

    // Indices: write as raw little-endian u32 buffer.
    let mut idx_bytes: Vec<u8> = Vec::with_capacity(octree.point_indices.len() * 4);
    for i in &octree.point_indices {
        idx_bytes.extend_from_slice(&i.to_le_bytes());
    }
    w.write_all(&idx_bytes)?;

    Ok(())
}

pub fn read<R: Read>(mut r: R) -> Result<PointOctree, OctreeIoError> {
    let mut buf = Vec::new();
    r.read_to_end(&mut buf)?;
    read_bytes(&buf)
}

pub fn read_bytes(buf: &[u8]) -> Result<PointOctree, OctreeIoError> {
    if buf.len() < HEADER_SIZE + BOUNDS_SIZE {
        return Err(OctreeIoError::Truncated);
    }
    let mut cur = 0;
    let magic = read_u32(buf, &mut cur);
    if magic != MAGIC {
        return Err(OctreeIoError::BadMagic);
    }
    let version = read_u32(buf, &mut cur);
    if version != VERSION {
        return Err(OctreeIoError::UnsupportedVersion(version));
    }
    let _flags = read_u32(buf, &mut cur);
    let n_points = read_u32(buf, &mut cur);
    let n_nodes = read_u32(buf, &mut cur);
    let _leaf_capacity = read_u32(buf, &mut cur);
    let _max_depth = read_u32(buf, &mut cur);
    let _reserved = read_u32(buf, &mut cur);
    let render_offset = read_f64x3(buf, &mut cur);
    debug_assert_eq!(cur, HEADER_SIZE);

    let bounds_min = read_f64x3(buf, &mut cur);
    let bounds_max = read_f64x3(buf, &mut cur);
    debug_assert_eq!(cur, HEADER_SIZE + BOUNDS_SIZE);
    let bounds_local = Aabb {
        min: bounds_min,
        max: bounds_max,
    };

    let nodes_end = HEADER_SIZE + BOUNDS_SIZE + n_nodes as usize * NODE_SIZE;
    if buf.len() < nodes_end + n_points as usize * 4 {
        return Err(OctreeIoError::Truncated);
    }

    let mut nodes = Vec::with_capacity(n_nodes as usize);
    for _ in 0..n_nodes {
        let bounds_min = read_f64x3(buf, &mut cur);
        let bounds_max = read_f64x3(buf, &mut cur);
        let mut children = [0u32; 8];
        for child in &mut children {
            *child = read_u32(buf, &mut cur);
        }
        let point_start = read_u32(buf, &mut cur);
        let point_count = read_u32(buf, &mut cur);
        nodes.push(OctreeNode {
            bounds: Aabb {
                min: bounds_min,
                max: bounds_max,
            },
            children,
            point_start,
            point_count,
            depth: 0,
        });
    }

    let mut point_indices = Vec::with_capacity(n_points as usize);
    for _ in 0..n_points {
        point_indices.push(read_u32(buf, &mut cur));
    }

    Ok(PointOctree {
        render_offset,
        bounds_local,
        nodes,
        point_indices,
    })
}

fn write_u32(buf: &mut [u8], cur: &mut usize, v: u32) {
    buf[*cur..*cur + 4].copy_from_slice(&v.to_le_bytes());
    *cur += 4;
}

fn write_f64x3(buf: &mut [u8], cur: &mut usize, v: [f64; 3]) {
    for component in v {
        buf[*cur..*cur + 8].copy_from_slice(&component.to_le_bytes());
        *cur += 8;
    }
}

fn read_u32(buf: &[u8], cur: &mut usize) -> u32 {
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&buf[*cur..*cur + 4]);
    *cur += 4;
    u32::from_le_bytes(bytes)
}

fn read_f64x3(buf: &[u8], cur: &mut usize) -> [f64; 3] {
    let mut out = [0.0_f64; 3];
    for value in &mut out {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&buf[*cur..*cur + 8]);
        *cur += 8;
        *value = f64::from_le_bytes(bytes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::octree_points::BuildOptions;
    use glam::Vec3;

    #[test]
    fn roundtrip_octree() {
        let mut pts = Vec::new();
        for x in 0..4 {
            for y in 0..4 {
                for z in 0..4 {
                    pts.push(x as f32);
                    pts.push(y as f32);
                    pts.push(z as f32);
                }
            }
        }
        let oct = PointOctree::build(&pts, [10.0, 20.0, 30.0], BuildOptions::default());
        let mut buf = Vec::new();
        write(&oct, &mut buf).expect("write");
        let restored = read_bytes(&buf).expect("read");
        assert_eq!(restored.point_indices.len(), oct.point_indices.len());
        assert_eq!(restored.nodes.len(), oct.nodes.len());
        assert_eq!(restored.render_offset, [10.0, 20.0, 30.0]);
        let h1 = oct.k_nearest(&pts, Vec3::new(2.0, 2.0, 2.0), 4);
        let h2 = restored.k_nearest(&pts, Vec3::new(2.0, 2.0, 2.0), 4);
        assert_eq!(h1.len(), h2.len());
    }
}
