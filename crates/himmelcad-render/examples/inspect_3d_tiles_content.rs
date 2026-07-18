//! Validates and summarizes one GLB or legacy 3D Tiles content file.

use std::error::Error;

use himmelcad_render::{
    build_three_d_tiles_batches, decode_three_d_tiles_content_intrinsic,
    required_three_d_tiles_proxy_slots, DecodedThreeDTilesContent, GpuSharedRenderer, RenderStyle,
    WorldTransform,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("usage: inspect_3d_tiles_content <tile.glb|b3dm|pnts|cmpt>")?;
    let bytes = std::fs::read(&path)?;
    let decoded = decode_three_d_tiles_content_intrinsic(&bytes, WorldTransform::IDENTITY)?;
    let mut summary = Summary::default();
    summarize(&decoded, &mut summary);
    println!(
        "meshes={} primitives={} triangles={} images={} point_tiles={} points={} leaves={}",
        summary.meshes,
        summary.primitives,
        summary.triangles,
        summary.images,
        summary.point_tiles,
        summary.points,
        summary.leaves
    );
    if std::env::args().any(|argument| argument == "--gpu") {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("himmelcad-3d-tiles-fixture-device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..wgpu::DeviceDescriptor::default()
            })
            .await?;
        let renderer = GpuSharedRenderer::new(&device, &queue, wgpu::TextureFormat::Rgba8UnormSrgb);
        let slots = (1..=required_three_d_tiles_proxy_slots(&decoded))
            .map(u32::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let batches = build_three_d_tiles_batches(
            &device,
            &queue,
            &renderer,
            "fixture",
            &slots,
            &decoded,
            &RenderStyle::default(),
            0.0,
        )?;
        println!("gpu_batches={}", batches.len());
    }
    Ok(())
}

#[derive(Default)]
struct Summary {
    meshes: usize,
    primitives: usize,
    triangles: usize,
    images: usize,
    point_tiles: usize,
    points: usize,
    leaves: usize,
}

fn summarize(content: &DecodedThreeDTilesContent, summary: &mut Summary) {
    match content {
        DecodedThreeDTilesContent::Mesh(mesh) => {
            summary.meshes += 1;
            summary.leaves += 1;
            summary.primitives += mesh.glb.primitives.len();
            summary.images += mesh.glb.images.len();
            summary.triangles += mesh
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.indices.len() / 3)
                .sum::<usize>();
        }
        DecodedThreeDTilesContent::Points(points) => {
            summary.point_tiles += 1;
            summary.leaves += 1;
            summary.points += points.points.positions.len();
        }
        DecodedThreeDTilesContent::InstancedMesh(model) => {
            summary.meshes += 1;
            summary.leaves += himmelcad_render::instanced_model_chunks(model).len();
            summary.primitives += model.glb.primitives.len();
            summary.images += model.glb.images.len();
            summary.triangles += model
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.indices.len() / 3)
                .sum::<usize>()
                .saturating_mul(model.instances.len());
        }
        DecodedThreeDTilesContent::Composite(children) => {
            for child in children {
                summarize(child, summary);
            }
        }
    }
}
