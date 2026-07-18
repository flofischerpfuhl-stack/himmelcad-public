use std::{env, fs, path::PathBuf};

use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_sidecar::prepared_triangle_mesh::{
    build_prepared_textured_triangle_mesh, PreparedTriangleMeshOptions, TriangleRecord,
};
use image::{ImageFormat, Rgba, RgbaImage};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: prepared_textured_mesh_fixture <output-directory>")?;
    let source_root = output.with_extension("source");
    fs::create_dir_all(&source_root)?;
    let texture = source_root.join("texture.png");
    let mut image = RgbaImage::new(8, 8);
    for (x, _, pixel) in image.enumerate_pixels_mut() {
        *pixel = if x < 4 {
            Rgba([255, 210, 40, 255])
        } else {
            Rgba([40, 110, 255, 255])
        };
    }
    image.save_with_format(&texture, ImageFormat::Png)?;

    const CENTER: [f64; 3] = [6_378_085.125, 5_400_038.25, 520.75];
    let triangles = [
        TriangleRecord {
            positions: [
                [CENTER[0] - 2.0, CENTER[1] - 2.0, CENTER[2]],
                [CENTER[0] + 2.0, CENTER[1] - 2.0, CENTER[2]],
                [CENTER[0] + 2.0, CENTER[1] + 2.0, CENTER[2]],
            ],
            material_slot: Some(3),
            texture_coordinates: Some([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]),
        },
        TriangleRecord {
            positions: [
                [CENTER[0] - 2.0, CENTER[1] - 2.0, CENTER[2]],
                [CENTER[0] + 2.0, CENTER[1] + 2.0, CENTER[2]],
                [CENTER[0] - 2.0, CENTER[1] + 2.0, CENTER[2]],
            ],
            material_slot: Some(7),
            texture_coordinates: Some([[0.0, 0.0], [1.0, 1.0], [0.0, 1.0]]),
        },
    ];
    let product = build_prepared_textured_triangle_mesh(
        triangles,
        &texture,
        &output,
        PreparedTriangleMeshOptions {
            max_triangles_per_partition: 64,
            internal_proxy_triangle_budget: 64,
            closed_manifold: false,
        },
        &CancellationToken::new(),
    )?;
    fs::remove_dir_all(source_root)?;
    println!("{}", serde_json::to_string(&product)?);
    Ok(())
}
