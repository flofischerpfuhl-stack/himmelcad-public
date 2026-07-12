//! Builds streamed terrain-mesh tiles from a validated DEM pyramid.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use himmelcad_core::photolab_jobs::CancellationToken;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::raster_runtime::{RasterBuildSummary, RasterLevelSummary};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMeshProduct {
    pub manifest_relative_path: PathBuf,
    pub tile_count: u32,
    pub triangle_count: u64,
}

#[derive(Debug, Error)]
pub enum MeshTilerError {
    #[error("invalid DEM mesh source: {0}")]
    InvalidSource(String),
    #[error("mesh preparation was cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    root_tile_id: String,
    tiles: Vec<MeshTile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshTile {
    id: String,
    parent: Option<String>,
    children: Vec<String>,
    bounds: Bounds,
    origin: [f64; 3],
    geometric_error: f64,
    vertex_count: u32,
    index_count: u64,
    position_url: String,
    index_url: String,
    index_component_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    uv_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    texture_url: Option<String>,
    bvh: Bvh,
}

#[derive(Serialize)]
struct Bounds {
    min: Point,
    max: Point,
}
#[derive(Serialize)]
struct Point {
    x: f64,
    y: f64,
    z: f64,
}
#[derive(Serialize)]
struct Bvh {
    url: String,
    version: u32,
}

/// Creates one coarse root and level-zero leaves; every tile is independently streamable.
pub fn build_tiled_dem_mesh(
    dem_dataset_root: &Path,
    summary: &RasterBuildSummary,
    output_root: &Path,
    texture_dataset_root: Option<&Path>,
    texture_summary: Option<&RasterBuildSummary>,
    target_face_count: u64,
    interpolate_holes: bool,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, MeshTilerError> {
    if target_face_count < 2 {
        return Err(MeshTilerError::InvalidSource(
            "target face count must be at least two".into(),
        ));
    }
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root.join("tiles"))?;
    if texture_dataset_root.is_some() != texture_summary.is_some() {
        return Err(MeshTilerError::InvalidSource(
            "texture root and raster summary must be provided together".into(),
        ));
    }
    let finest = summary
        .levels
        .first()
        .ok_or_else(|| MeshTilerError::InvalidSource("DEM has no pyramid".into()))?;
    let coarsest = summary.levels.last().expect("non-empty");
    let mut tiles = Vec::new();
    let mut total_triangles = 0_u64;
    let rendered_tile_count = u64::from(finest.tile_count).saturating_add(1);
    let target_per_tile = target_face_count
        .checked_div(rendered_tile_count)
        .unwrap_or(2)
        .max(2);
    let sample_stride = mesh_sample_stride(target_per_tile);
    let root_id = "root".to_owned();
    let child_ids = if finest.tile_count > 1 {
        (0..finest.rows)
            .flat_map(|row| (0..finest.columns).map(move |column| format!("L0-{column}-{row}")))
            .collect()
    } else {
        Vec::new()
    };
    let root_source = raw_tile_path(dem_dataset_root, coarsest, 0, 0);
    let root_texture = if finest.tile_count == 1 {
        texture_dataset_root
            .zip(texture_summary)
            .map(|(texture_root, texture_summary)| {
                copy_texture(
                    texture_root,
                    texture_summary,
                    summary,
                    coarsest,
                    output_root,
                    0,
                    0,
                    cancellation,
                )
            })
            .transpose()?
    } else {
        None
    };
    let root = build_tile(
        &root_id,
        None,
        child_ids,
        &root_source,
        coarsest,
        0,
        0,
        output_root,
        root_texture,
        sample_stride,
        interpolate_holes,
        cancellation,
    )?;
    total_triangles += root.index_count / 3;
    tiles.push(root);
    if finest.tile_count > 1 {
        for row in 0..finest.rows {
            for column in 0..finest.columns {
                if cancellation.is_cancel_requested() {
                    return Err(MeshTilerError::Cancelled);
                }
                let id = format!("L0-{column}-{row}");
                let texture = texture_dataset_root
                    .zip(texture_summary)
                    .map(|(texture_root, texture_summary)| {
                        copy_texture(
                            texture_root,
                            texture_summary,
                            summary,
                            finest,
                            output_root,
                            column,
                            row,
                            cancellation,
                        )
                    })
                    .transpose()?;
                let tile = build_tile(
                    &id,
                    Some(root_id.clone()),
                    Vec::new(),
                    &raw_tile_path(dem_dataset_root, finest, column, row),
                    finest,
                    column,
                    row,
                    output_root,
                    texture,
                    sample_stride,
                    interpolate_holes,
                    cancellation,
                )?;
                total_triangles += tile.index_count / 3;
                tiles.push(tile);
            }
        }
    }
    let manifest = Manifest {
        schema_version: 1,
        root_tile_id: root_id,
        tiles,
    };
    fs::write(
        output_root.join("manifest.json"),
        serde_json::to_vec(&manifest)?,
    )?;
    Ok(PreparedMeshProduct {
        manifest_relative_path: PathBuf::from("manifest.json"),
        tile_count: u32::try_from(manifest.tiles.len()).unwrap_or(u32::MAX),
        triangle_count: total_triangles,
    })
}

fn copy_texture(
    texture_root: &Path,
    texture_summary: &RasterBuildSummary,
    dem_summary: &RasterBuildSummary,
    dem_level: &RasterLevelSummary,
    output_root: &Path,
    column: u32,
    row: u32,
    cancellation: &CancellationToken,
) -> Result<String, MeshTilerError> {
    if cancellation.is_cancel_requested() {
        return Err(MeshTilerError::Cancelled);
    }
    let relative = PathBuf::from("textures")
        .join(column.to_string())
        .join(format!("{row}.png"));
    let destination = output_root.join(&relative);
    fs::create_dir_all(destination.parent().expect("texture has parent"))?;
    if texture_summary.grid == dem_summary.grid && dem_level.level == 0 {
        let source = texture_root
            .join("view/rgba/L00")
            .join(column.to_string())
            .join(format!("{row}.png"));
        fs::copy(source, destination)?;
    } else {
        resample_texture(
            texture_root,
            texture_summary,
            dem_level,
            column,
            row,
            &destination,
            cancellation,
        )?;
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn resample_texture(
    texture_root: &Path,
    texture_summary: &RasterBuildSummary,
    destination_level: &RasterLevelSummary,
    destination_column: u32,
    destination_row: u32,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), MeshTilerError> {
    let source_level = texture_summary
        .levels
        .first()
        .ok_or_else(|| MeshTilerError::InvalidSource("orthomosaic has no level zero".into()))?;
    let span = destination_level.gsd * 512.0;
    let minimum_east = destination_level.bounds.minimum_east + f64::from(destination_column) * span;
    let maximum_north = destination_level.bounds.maximum_north - f64::from(destination_row) * span;
    let mut cache = HashMap::<(u32, u32), RgbaImage>::new();
    let mut output = RgbaImage::new(512, 512);
    for y in 0..512_u32 {
        if y % 16 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        let north = maximum_north - (f64::from(y) + 0.5) * destination_level.gsd;
        for x in 0..512_u32 {
            let east = minimum_east + (f64::from(x) + 0.5) * destination_level.gsd;
            let source_x = (east - source_level.bounds.minimum_east) / source_level.gsd - 0.5;
            let source_y = (source_level.bounds.maximum_north - north) / source_level.gsd - 0.5;
            let pixel =
                bilinear_texture_pixel(texture_root, source_level, source_x, source_y, &mut cache)?;
            output.put_pixel(x, y, image::Rgba(pixel));
        }
    }
    output.save(destination)?;
    Ok(())
}

fn bilinear_texture_pixel(
    texture_root: &Path,
    source_level: &RasterLevelSummary,
    x: f64,
    y: f64,
    cache: &mut HashMap<(u32, u32), RgbaImage>,
) -> Result<[u8; 4], MeshTilerError> {
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let fx = x - x.floor();
    let fy = y - y.floor();
    let samples = [
        (x0, y0, (1.0 - fx) * (1.0 - fy)),
        (x0 + 1, y0, fx * (1.0 - fy)),
        (x0, y0 + 1, (1.0 - fx) * fy),
        (x0 + 1, y0 + 1, fx * fy),
    ];
    let mut premultiplied = [0.0_f64; 3];
    let mut alpha = 0.0_f64;
    for (sample_x, sample_y, weight) in samples {
        let Some(pixel) = texture_pixel(texture_root, source_level, sample_x, sample_y, cache)?
        else {
            continue;
        };
        let sample_alpha = f64::from(pixel[3]) / 255.0;
        alpha += weight * sample_alpha;
        for channel in 0..3 {
            premultiplied[channel] += weight * sample_alpha * f64::from(pixel[channel]);
        }
    }
    if alpha <= f64::EPSILON {
        return Ok([0, 0, 0, 0]);
    }
    Ok([
        (premultiplied[0] / alpha).round().clamp(0.0, 255.0) as u8,
        (premultiplied[1] / alpha).round().clamp(0.0, 255.0) as u8,
        (premultiplied[2] / alpha).round().clamp(0.0, 255.0) as u8,
        (alpha * 255.0).round().clamp(0.0, 255.0) as u8,
    ])
}

fn texture_pixel(
    texture_root: &Path,
    source_level: &RasterLevelSummary,
    x: i64,
    y: i64,
    cache: &mut HashMap<(u32, u32), RgbaImage>,
) -> Result<Option<[u8; 4]>, MeshTilerError> {
    if x < 0 || y < 0 {
        return Ok(None);
    }
    let x = u64::try_from(x).expect("non-negative source x");
    let y = u64::try_from(y).expect("non-negative source y");
    let tile_x = u32::try_from(x / 512).unwrap_or(u32::MAX);
    let tile_y = u32::try_from(y / 512).unwrap_or(u32::MAX);
    if tile_x >= source_level.columns || tile_y >= source_level.rows {
        return Ok(None);
    }
    if !cache.contains_key(&(tile_x, tile_y)) {
        let source = texture_root
            .join("view/rgba/L00")
            .join(tile_x.to_string())
            .join(format!("{tile_y}.png"));
        cache.insert((tile_x, tile_y), image::open(source)?.to_rgba8());
    }
    let pixel = cache
        .get(&(tile_x, tile_y))
        .expect("texture was inserted")
        .get_pixel((x % 512) as u32, (y % 512) as u32)
        .0;
    Ok(Some(pixel))
}

fn build_tile(
    id: &str,
    parent: Option<String>,
    children: Vec<String>,
    source: &Path,
    level: &RasterLevelSummary,
    column: u32,
    row: u32,
    output_root: &Path,
    texture_url: Option<String>,
    sample_stride: usize,
    interpolate_holes: bool,
    cancellation: &CancellationToken,
) -> Result<MeshTile, MeshTilerError> {
    if cancellation.is_cancel_requested() {
        return Err(MeshTilerError::Cancelled);
    }
    let bytes = fs::read(source)?;
    let count = 512_usize * 512;
    if bytes.len() != count * 4 {
        return Err(MeshTilerError::InvalidSource(format!(
            "{} is not a 512x512 Float32 tile",
            source.display()
        )));
    }
    let mut heights = Vec::with_capacity(count);
    let mut min_z = f64::INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    for chunk in bytes.chunks_exact(4) {
        let value = f32::from_le_bytes(chunk.try_into().expect("fixed"));
        heights.push(value);
        if value.is_finite() && value > -1e30 {
            min_z = min_z.min(f64::from(value));
            max_z = max_z.max(f64::from(value));
        }
    }
    if !min_z.is_finite() {
        return Err(MeshTilerError::InvalidSource(
            "DEM tile contains no surface".into(),
        ));
    }
    let span = 512.0 * level.gsd;
    let min_e = level.bounds.minimum_east + f64::from(column) * span;
    let max_n = level.bounds.maximum_north - f64::from(row) * span;
    let origin = [
        min_e + span * 0.5,
        max_n - span * 0.5,
        (min_z + max_z) * 0.5,
    ];
    let coordinates = sample_coordinates(sample_stride);
    let grid_size = coordinates.len();
    let mut sampled = Vec::with_capacity(grid_size * grid_size);
    for y in &coordinates {
        for x in &coordinates {
            sampled.push(sample_height(&heights, *x, *y, interpolate_holes));
        }
    }
    let positions_path = output_root.join(format!("tiles/{id}.positions.f32"));
    let mut positions = fs::File::create(&positions_path)?;
    let uv_path = output_root.join(format!("tiles/{id}.uv.f32"));
    let mut uvs = fs::File::create(&uv_path)?;
    for (sample_y, y) in coordinates.iter().enumerate() {
        for (sample_x, x) in coordinates.iter().enumerate() {
            let z = sampled[sample_y * grid_size + sample_x];
            let world_x = min_e + (*x as f64 + 0.5) * level.gsd;
            let world_y = max_n - (*y as f64 + 0.5) * level.gsd;
            for value in [
                (world_x - origin[0]) as f32,
                (world_y - origin[1]) as f32,
                if z.is_finite() && z > -1e30 {
                    z - origin[2] as f32
                } else {
                    0.0
                },
            ] {
                positions.write_all(&value.to_le_bytes())?;
            }
            for value in [(*x as f32 + 0.5) / 512.0, 1.0 - (*y as f32 + 0.5) / 512.0] {
                uvs.write_all(&value.to_le_bytes())?;
            }
        }
    }
    let index_path = output_root.join(format!("tiles/{id}.indices.u32"));
    let mut indices = fs::File::create(&index_path)?;
    let mut index_count = 0_u64;
    for y in 0..grid_size.saturating_sub(1) {
        if y % 32 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        for x in 0..grid_size.saturating_sub(1) {
            let a = y * grid_size + x;
            let b = a + 1;
            let c = a + grid_size;
            let d = c + 1;
            if [a, b, c, d]
                .iter()
                .all(|offset| sampled[*offset].is_finite() && sampled[*offset] > -1e30)
            {
                for value in [a as u32, c as u32, b as u32, b as u32, c as u32, d as u32] {
                    indices.write_all(&value.to_le_bytes())?;
                    index_count += 1;
                }
            }
        }
    }
    if index_count == 0 {
        return Err(MeshTilerError::InvalidSource(
            "DEM tile has no valid triangles".into(),
        ));
    }
    let bvh_path = output_root.join(format!("tiles/{id}.bvh"));
    fs::write(&bvh_path, b"HCBVH001")?;
    Ok(MeshTile {
        id: id.into(),
        parent,
        children,
        bounds: Bounds {
            min: Point {
                x: min_e,
                y: max_n - span,
                z: min_z,
            },
            max: Point {
                x: min_e + span,
                y: max_n,
                z: max_z,
            },
        },
        origin,
        geometric_error: (level.gsd * sample_stride as f64 * 2.0).max(0.001),
        vertex_count: u32::try_from(sampled.len()).unwrap_or(u32::MAX),
        index_count,
        position_url: format!("tiles/{id}.positions.f32"),
        index_url: format!("tiles/{id}.indices.u32"),
        index_component_type: "uint32",
        uv_url: texture_url.as_ref().map(|_| format!("tiles/{id}.uv.f32")),
        texture_url,
        bvh: Bvh {
            url: format!("tiles/{id}.bvh"),
            version: 1,
        },
    })
}

fn mesh_sample_stride(target_faces_per_tile: u64) -> usize {
    let full_faces = 2_u64 * 511 * 511;
    if target_faces_per_tile >= full_faces {
        return 1;
    }
    let ratio = (full_faces as f64 / target_faces_per_tile as f64)
        .sqrt()
        .ceil();
    (ratio as usize).clamp(1, 511)
}

fn sample_coordinates(stride: usize) -> Vec<usize> {
    let stride = stride.clamp(1, 511);
    let mut values = (0..512).step_by(stride).collect::<Vec<_>>();
    if values.last().copied() != Some(511) {
        values.push(511);
    }
    values
}

fn sample_height(heights: &[f32], x: usize, y: usize, interpolate: bool) -> f32 {
    let value = heights[y * 512 + x];
    if value.is_finite() && value > -1e30 || !interpolate {
        return value;
    }
    for radius in 1..=8_usize {
        let min_x = x.saturating_sub(radius);
        let max_x = x.saturating_add(radius).min(511);
        let min_y = y.saturating_sub(radius);
        let max_y = y.saturating_add(radius).min(511);
        let mut sum = 0.0_f64;
        let mut count = 0_u32;
        for sample_y in min_y..=max_y {
            for sample_x in min_x..=max_x {
                if sample_x != min_x && sample_x != max_x && sample_y != min_y && sample_y != max_y
                {
                    continue;
                }
                let candidate = heights[sample_y * 512 + sample_x];
                if candidate.is_finite() && candidate > -1e30 {
                    sum += f64::from(candidate);
                    count += 1;
                }
            }
        }
        if count > 0 {
            return (sum / f64::from(count)) as f32;
        }
    }
    value
}

fn raw_tile_path(root: &Path, level: &RasterLevelSummary, column: u32, row: u32) -> PathBuf {
    root.join(format!(
        "view/height/L{:02}/{column}/{row}.f32",
        level.level
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raster_summary(columns: u32, rows: u32, gsd: f64) -> RasterBuildSummary {
        let bounds = crate::raster_runtime::RasterBounds {
            minimum_east: 0.0,
            minimum_north: 0.0,
            maximum_east: f64::from(columns) * 512.0 * gsd,
            maximum_north: f64::from(rows) * 512.0 * gsd,
        };
        RasterBuildSummary {
            output_directory: "x".into(),
            cog_path: "x".into(),
            pyramid_manifest_path: "x".into(),
            levels: vec![RasterLevelSummary {
                level: 0,
                columns,
                rows,
                tile_count: u64::from(columns) * u64::from(rows),
                bounds,
                gsd,
                relative_directory: "pyramid/L00".into(),
                metric_tile_url_template: String::new(),
                view_layers: vec![],
            }],
            crs: crate::raster_runtime::RasterCrs {
                horizontal: "x".into(),
                vertical: None,
                gdal_srs: "x".into(),
                canonical_wkt_sha256: himmelcad_core::hash::ObjectHash::of_bytes(b"x"),
            },
            grid: crate::raster_runtime::RasterGrid {
                bounds,
                width_pixels: columns * 512,
                height_pixels: rows * 512,
                gsd,
                no_data: crate::raster_runtime::RasterNoDataValue::Numeric(-1.0),
            },
            audit: crate::raster_runtime::GdalAudit {
                version: "x".into(),
                executable_sha256: Default::default(),
                raster_drivers: vec![],
                vector_drivers: vec![],
                network_enabled: false,
            },
        }
    }

    #[test]
    fn target_face_budget_increases_sampling_stride_deterministically() {
        assert_eq!(mesh_sample_stride(2 * 511 * 511), 1);
        assert!(mesh_sample_stride(10_000) > 1);
        assert_eq!(sample_coordinates(511), vec![0, 511]);
    }

    #[test]
    fn optional_hole_interpolation_uses_nearby_valid_surface_samples() {
        let mut heights = vec![f32::NAN; 512 * 512];
        heights[255 * 512 + 254] = 10.0;
        heights[255 * 512 + 256] = 14.0;
        assert!(sample_height(&heights, 255, 255, false).is_nan());
        assert_eq!(sample_height(&heights, 255, 255, true), 12.0);
    }

    #[test]
    fn rejects_truncated_dem_tile() {
        let root = std::env::temp_dir().join(format!("hcad-mesh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("view/height/L00/0")).unwrap();
        fs::write(root.join("view/height/L00/0/0.f32"), b"bad").unwrap();
        let summary = RasterBuildSummary {
            output_directory: root.to_string_lossy().into(),
            cog_path: "x".into(),
            pyramid_manifest_path: "x".into(),
            levels: vec![RasterLevelSummary {
                level: 0,
                columns: 1,
                rows: 1,
                tile_count: 1,
                bounds: crate::raster_runtime::RasterBounds {
                    minimum_east: 0.0,
                    minimum_north: 0.0,
                    maximum_east: 512.0,
                    maximum_north: 512.0,
                },
                gsd: 1.0,
                relative_directory: "pyramid/L00".into(),
                metric_tile_url_template: "".into(),
                view_layers: vec![],
            }],
            crs: crate::raster_runtime::RasterCrs {
                horizontal: "x".into(),
                vertical: None,
                gdal_srs: "x".into(),
                canonical_wkt_sha256: himmelcad_core::hash::ObjectHash::of_bytes(b"x"),
            },
            grid: crate::raster_runtime::RasterGrid {
                bounds: crate::raster_runtime::RasterBounds {
                    minimum_east: 0.0,
                    minimum_north: 0.0,
                    maximum_east: 512.0,
                    maximum_north: 512.0,
                },
                width_pixels: 512,
                height_pixels: 512,
                gsd: 1.0,
                no_data: crate::raster_runtime::RasterNoDataValue::Numeric(-1.0),
            },
            audit: crate::raster_runtime::GdalAudit {
                version: "x".into(),
                executable_sha256: Default::default(),
                raster_drivers: vec![],
                vector_drivers: vec![],
                network_enabled: false,
            },
        };
        assert!(build_tiled_dem_mesh(
            &root,
            &summary,
            &root.join("mesh"),
            None,
            None,
            100_000,
            false,
            &CancellationToken::new()
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copied_texture_uses_a_portable_relative_url() {
        let root = std::env::temp_dir().join(format!("hcad-mesh-texture-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let texture = root.join("ortho/view/rgba/L00/2");
        fs::create_dir_all(&texture).unwrap();
        fs::write(texture.join("3.png"), b"png").unwrap();
        let summary = raster_summary(3, 4, 1.0);
        let relative = copy_texture(
            &root.join("ortho"),
            &summary,
            &summary,
            &summary.levels[0],
            &root.join("mesh"),
            2,
            3,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(relative, "textures/2/3.png");
        assert_eq!(
            fs::read(root.join("mesh/textures/2/3.png")).unwrap(),
            b"png"
        );
        let _ = fs::remove_dir_all(root);
    }
}
