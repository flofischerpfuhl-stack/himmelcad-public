//! Builds streamed terrain-mesh tiles from a validated DEM pyramid.

use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use himmelcad_core::{
    entity_model::GeometryResource,
    geometry_representation_registry::{
        SectionIndexComponentType, SectionPositionComponentType, SectionTopologyPartitionManifest,
    },
    hash::ObjectHash,
    photolab_jobs::CancellationToken,
};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::raster_runtime::{RasterBuildSummary, RasterLevelSummary};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMeshProduct {
    pub manifest_relative_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_descriptor_relative_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_descriptor_resource: Option<GeometryResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel_manifest_relative_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel_manifest_resource: Option<GeometryResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_topology: Option<PreparedSectionTopologyProduct>,
    pub tile_count: u32,
    pub triangle_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSectionTopologyProduct {
    pub manifest_relative_path: PathBuf,
    pub manifest_resource: GeometryResource,
    pub closed_manifold: bool,
    pub parts: Vec<PreparedSectionTopologyPart>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSectionTopologyPart {
    pub part_id: String,
    pub topology_hash: String,
    pub bounds: PreparedSectionTopologyBounds,
    pub manifest_url: String,
    pub position_url: String,
    pub index_url: String,
    pub material_slot_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSectionTopologyBounds {
    pub minimum: [f64; 3],
    pub maximum: [f64; 3],
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
    #[serde(skip)]
    kernel_content: KernelTileContent,
    #[serde(skip)]
    kernel_assets: Vec<KernelTileAsset>,
}

struct KernelTileContent {
    url: String,
    object_hash: String,
    byte_length: u64,
}

struct KernelTileAsset {
    uri: String,
    object_hash: String,
    byte_length: u64,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionTopologyIndex<'a> {
    schema_version: u32,
    closed_manifold: bool,
    parts: &'a [PreparedSectionTopologyPart],
}

/// Creates one coarse root and level-zero leaves; every tile is independently streamable.
#[allow(clippy::too_many_arguments)] // Public preparation boundary mirrors persisted mesh options.
pub fn build_tiled_dem_mesh(
    dem_dataset_root: &Path,
    summary: &RasterBuildSummary,
    output_root: &Path,
    texture_dataset_root: Option<&Path>,
    texture_summary: Option<&RasterBuildSummary>,
    target_face_count: u64,
    interpolate_holes: bool,
    texture_size: u32,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, MeshTilerError> {
    if target_face_count < 2 {
        return Err(MeshTilerError::InvalidSource(
            "target face count must be at least two".into(),
        ));
    }
    if !matches!(texture_size, 2048 | 4096 | 8192 | 16384) {
        return Err(MeshTilerError::InvalidSource(
            "texture detail budget must be 2048, 4096, 8192 or 16384".into(),
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
    let occupied_leaves = if finest.tile_count > 1 {
        let mut occupied = Vec::new();
        for row in 0..finest.rows {
            for column in 0..finest.columns {
                let path = raw_tile_path(dem_dataset_root, finest, column, row);
                if tile_contains_surface(&path, cancellation)? {
                    occupied.push((column, row));
                }
            }
        }
        if occupied.is_empty() {
            return Err(MeshTilerError::InvalidSource(
                "DEM pyramid contains no occupied surface tile".into(),
            ));
        }
        occupied
    } else {
        Vec::new()
    };
    let mut tiles = Vec::new();
    let mut total_triangles = 0_u64;
    let rendered_tile_count = u64::try_from(occupied_leaves.len())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let target_per_tile = target_face_count
        .checked_div(rendered_tile_count)
        .unwrap_or(2)
        .max(2);
    let sample_stride = mesh_sample_stride(target_per_tile);
    let texture_tile_size = texture_tile_size(texture_size, finest.columns, finest.rows);
    let root_id = "root".to_owned();
    let child_ids = if finest.tile_count > 1 {
        occupied_leaves
            .iter()
            .map(|(column, row)| format!("L0-{column}-{row}"))
            .collect()
    } else {
        Vec::new()
    };
    let root_source = raw_tile_path(dem_dataset_root, coarsest, 0, 0);
    let root_texture = texture_dataset_root
        .zip(texture_summary)
        .map(|(texture_root, texture_summary)| {
            copy_texture_to(
                texture_root,
                texture_summary,
                summary,
                coarsest,
                output_root,
                0,
                0,
                if finest.tile_count == 1 {
                    texture_tile_size
                } else {
                    512
                },
                PathBuf::from("textures/root.png"),
                cancellation,
            )
        })
        .transpose()?;
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
    let mut section_parts = if finest.tile_count == 1 {
        vec![build_section_topology_part(
            &root_id,
            dem_dataset_root,
            &root_source,
            coarsest,
            0,
            0,
            output_root,
            interpolate_holes,
            cancellation,
        )?]
    } else {
        Vec::with_capacity(occupied_leaves.len())
    };
    if finest.tile_count > 1 {
        for (column, row) in occupied_leaves {
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
                        texture_tile_size,
                        cancellation,
                    )
                })
                .transpose()?;
            let source = raw_tile_path(dem_dataset_root, finest, column, row);
            let tile = build_tile(
                &id,
                Some(root_id.clone()),
                Vec::new(),
                &source,
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
            section_parts.push(build_section_topology_part(
                &id,
                dem_dataset_root,
                &source,
                finest,
                column,
                row,
                output_root,
                interpolate_holes,
                cancellation,
            )?);
        }
    }
    section_parts.sort_unstable_by(|left, right| left.part_id.cmp(&right.part_id));
    let section_topology_relative_path = PathBuf::from("section-topology.json");
    let section_topology_bytes = serde_json::to_vec(&SectionTopologyIndex {
        schema_version: 2,
        closed_manifold: false,
        parts: &section_parts,
    })?;
    fs::write(
        output_root.join(&section_topology_relative_path),
        &section_topology_bytes,
    )?;
    let manifest = Manifest {
        schema_version: 1,
        root_tile_id: root_id,
        tiles,
    };
    fs::write(
        output_root.join("manifest.json"),
        serde_json::to_vec(&manifest)?,
    )?;
    let kernel_manifest_relative_path = PathBuf::from("kernel-manifest.json");
    let kernel_manifest_bytes = kernel_hierarchy_manifest(&manifest.tiles)?;
    fs::write(
        output_root.join(&kernel_manifest_relative_path),
        &kernel_manifest_bytes,
    )?;
    let kernel_manifest_resource = GeometryResource {
        object_hash: ObjectHash::of_bytes(&kernel_manifest_bytes),
        media_type: "himmelcad-prepared-hierarchy@1".to_owned(),
        byte_length: Some(u64::try_from(kernel_manifest_bytes.len()).unwrap_or(u64::MAX)),
    };
    let section_manifest_resource = GeometryResource {
        object_hash: ObjectHash::of_bytes(&section_topology_bytes),
        media_type: "hcad.section-topology-index@2".to_owned(),
        byte_length: Some(u64::try_from(section_topology_bytes.len()).unwrap_or(u64::MAX)),
    };
    let source_summary_bytes = serde_json::to_vec(summary)?;
    let texture_summary_hash = texture_summary
        .map(serde_json::to_vec)
        .transpose()?
        .map(|bytes| ObjectHash::of_bytes(&bytes));
    let preparation_descriptor_relative_path = PathBuf::from("preparation.json");
    let preparation_descriptor_bytes = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "sourceSummaryHash": ObjectHash::of_bytes(&source_summary_bytes),
        "textureSummaryHash": texture_summary_hash,
        "adapter": { "id": "hcad.dem-grid-triangle-mesh", "version": 1 },
        "partitioner": { "id": "hcad.dem-pyramid-leaves-with-east-south-halo", "version": 2 },
        "renderLod": { "id": "hcad.dem-grid-stride", "version": 1 },
        "targetFaceCount": target_face_count,
        "interpolateHoles": interpolate_holes,
        "textureSize": texture_size,
        "authoritativePositionEncoding": "float32-le-xyz-local",
        "closedManifold": false,
        "renderHierarchy": &kernel_manifest_resource,
        "sectionTopology": &section_manifest_resource,
    }))?;
    fs::write(
        output_root.join(&preparation_descriptor_relative_path),
        &preparation_descriptor_bytes,
    )?;
    Ok(PreparedMeshProduct {
        manifest_relative_path: PathBuf::from("manifest.json"),
        preparation_descriptor_relative_path: Some(preparation_descriptor_relative_path),
        preparation_descriptor_resource: Some(GeometryResource {
            object_hash: ObjectHash::of_bytes(&preparation_descriptor_bytes),
            media_type: "hcad.prepared-triangle-mesh-recipe@1".to_owned(),
            byte_length: Some(
                u64::try_from(preparation_descriptor_bytes.len()).unwrap_or(u64::MAX),
            ),
        }),
        kernel_manifest_relative_path: Some(kernel_manifest_relative_path),
        kernel_manifest_resource: Some(kernel_manifest_resource),
        section_topology: Some(PreparedSectionTopologyProduct {
            manifest_relative_path: section_topology_relative_path,
            manifest_resource: section_manifest_resource,
            closed_manifold: false,
            parts: section_parts,
        }),
        tile_count: u32::try_from(manifest.tiles.len()).unwrap_or(u32::MAX),
        triangle_count: total_triangles,
    })
}

fn tile_contains_surface(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<bool, MeshTilerError> {
    let bytes = fs::read(path)?;
    if bytes.len() != 512 * 512 * 4 {
        return Err(MeshTilerError::InvalidSource(format!(
            "{} is not a 512x512 Float32 tile",
            path.display()
        )));
    }
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        if index % 16_384 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        let value = f32::from_le_bytes(chunk.try_into().expect("fixed"));
        if value.is_finite() && value > -1e30 {
            return Ok(true);
        }
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)] // Texture tile coordinates and source metadata stay explicit.
fn copy_texture(
    texture_root: &Path,
    texture_summary: &RasterBuildSummary,
    dem_summary: &RasterBuildSummary,
    dem_level: &RasterLevelSummary,
    output_root: &Path,
    column: u32,
    row: u32,
    output_size: u32,
    cancellation: &CancellationToken,
) -> Result<String, MeshTilerError> {
    let relative = PathBuf::from("textures")
        .join(column.to_string())
        .join(format!("{row}.png"));
    copy_texture_to(
        texture_root,
        texture_summary,
        dem_summary,
        dem_level,
        output_root,
        column,
        row,
        output_size,
        relative,
        cancellation,
    )
}

#[allow(clippy::too_many_arguments)]
fn copy_texture_to(
    texture_root: &Path,
    texture_summary: &RasterBuildSummary,
    dem_summary: &RasterBuildSummary,
    dem_level: &RasterLevelSummary,
    output_root: &Path,
    column: u32,
    row: u32,
    output_size: u32,
    relative: PathBuf,
    cancellation: &CancellationToken,
) -> Result<String, MeshTilerError> {
    if cancellation.is_cancel_requested() {
        return Err(MeshTilerError::Cancelled);
    }
    let destination = output_root.join(&relative);
    fs::create_dir_all(destination.parent().expect("texture has parent"))?;
    if texture_summary.grid == dem_summary.grid && dem_level.level == 0 && output_size == 512 {
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
            output_size,
            &destination,
            cancellation,
        )?;
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

#[allow(clippy::too_many_arguments)] // Raster sampling coordinates form one hot-path boundary.
fn resample_texture(
    texture_root: &Path,
    texture_summary: &RasterBuildSummary,
    destination_level: &RasterLevelSummary,
    destination_column: u32,
    destination_row: u32,
    output_size: u32,
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
    let mut output = RgbaImage::new(output_size, output_size);
    let output_gsd = span / f64::from(output_size);
    for y in 0..output_size {
        if y % 16 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        let north = maximum_north - (f64::from(y) + 0.5) * output_gsd;
        for x in 0..output_size {
            let east = minimum_east + (f64::from(x) + 0.5) * output_gsd;
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
    if let std::collections::hash_map::Entry::Vacant(entry) = cache.entry((tile_x, tile_y)) {
        let source = texture_root
            .join("view/rgba/L00")
            .join(tile_x.to_string())
            .join(format!("{tile_y}.png"));
        entry.insert(image::open(source)?.to_rgba8());
    }
    let pixel = cache
        .get(&(tile_x, tile_y))
        .expect("texture was inserted")
        .get_pixel((x % 512) as u32, (y % 512) as u32)
        .0;
    Ok(Some(pixel))
}

#[allow(clippy::too_many_arguments)] // Tile topology, raster coordinates and output policy are inseparable here.
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
    positions.flush()?;
    uvs.flush()?;
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
    indices.flush()?;
    if index_count == 0 {
        return Err(MeshTilerError::InvalidSource(
            "DEM tile has no valid triangles".into(),
        ));
    }
    let bvh_path = output_root.join(format!("tiles/{id}.bvh"));
    fs::write(&bvh_path, b"HCBVH001")?;
    let position_url = format!("tiles/{id}.positions.f32");
    let index_url = format!("tiles/{id}.indices.u32");
    let position_resource = topology_resource(&positions_path, "hcad.positions-f32le-xyz@1")?;
    let index_resource = topology_resource(&index_path, "hcad.indices-u32le@1")?;
    let mut tile = MeshTile {
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
        position_url,
        index_url,
        index_component_type: "uint32",
        uv_url: texture_url.as_ref().map(|_| format!("tiles/{id}.uv.f32")),
        texture_url,
        bvh: Bvh {
            url: format!("tiles/{id}.bvh"),
            version: 1,
        },
        kernel_content: KernelTileContent {
            url: String::new(),
            object_hash: String::new(),
            byte_length: 0,
        },
        kernel_assets: Vec::new(),
    };
    tile.kernel_assets.push(kernel_asset(
        file_name_url(&tile.position_url)?.to_owned(),
        &position_resource,
    )?);
    if let Some(uv_url) = &tile.uv_url {
        let uv_resource = topology_resource(&output_root.join(uv_url), "hcad.uv-f32le-xy@1")?;
        tile.kernel_assets.push(kernel_asset(
            file_name_url(uv_url)?.to_owned(),
            &uv_resource,
        )?);
    }
    tile.kernel_assets.push(kernel_asset(
        file_name_url(&tile.index_url)?.to_owned(),
        &index_resource,
    )?);
    if let Some(texture_url) = &tile.texture_url {
        let texture_resource = topology_resource(&output_root.join(texture_url), "image/png")?;
        tile.kernel_assets.push(kernel_asset(
            format!("../{texture_url}"),
            &texture_resource,
        )?);
    }
    tile.kernel_content = write_kernel_gltf(output_root, &tile)?;
    Ok(tile)
}

#[allow(clippy::too_many_arguments)]
fn build_section_topology_part(
    id: &str,
    dem_dataset_root: &Path,
    source: &Path,
    level: &RasterLevelSummary,
    column: u32,
    row: u32,
    output_root: &Path,
    interpolate_holes: bool,
    cancellation: &CancellationToken,
) -> Result<PreparedSectionTopologyPart, MeshTilerError> {
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
    let mut source_heights = Vec::with_capacity(count);
    let mut min_z = f64::INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    for chunk in bytes.chunks_exact(4) {
        let value = f32::from_le_bytes(chunk.try_into().expect("fixed"));
        source_heights.push(value);
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
    let base_heights = resolve_topology_heights(&source_heights, interpolate_holes, cancellation)?;
    let east_heights = if column + 1 < level.columns {
        Some(load_topology_heights(
            &raw_tile_path(dem_dataset_root, level, column + 1, row),
            interpolate_holes,
            cancellation,
        )?)
    } else {
        None
    };
    let south_heights = if row + 1 < level.rows {
        Some(load_topology_heights(
            &raw_tile_path(dem_dataset_root, level, column, row + 1),
            interpolate_holes,
            cancellation,
        )?)
    } else {
        None
    };
    let south_east_heights = if column + 1 < level.columns && row + 1 < level.rows {
        Some(load_topology_heights(
            &raw_tile_path(dem_dataset_root, level, column + 1, row + 1),
            interpolate_holes,
            cancellation,
        )?)
    } else {
        None
    };
    let grid_width = 512 + usize::from(east_heights.is_some());
    let grid_height = 512 + usize::from(south_heights.is_some());
    let mut heights = Vec::with_capacity(grid_width * grid_height);
    for y in 0..grid_height {
        for x in 0..grid_width {
            heights.push(match (x == 512, y == 512) {
                (false, false) => base_heights[y * 512 + x],
                (true, false) => east_heights.as_ref().expect("east halo")[y * 512],
                (false, true) => south_heights.as_ref().expect("south halo")[x],
                (true, true) => south_east_heights.as_ref().expect("south-east halo")[0],
            });
        }
    }
    min_z = f64::INFINITY;
    max_z = f64::NEG_INFINITY;
    for height in heights
        .iter()
        .copied()
        .filter(|height| height.is_finite() && *height > -1e30)
    {
        min_z = min_z.min(f64::from(height));
        max_z = max_z.max(f64::from(height));
    }
    if !min_z.is_finite() || !max_z.is_finite() {
        return Err(MeshTilerError::InvalidSource(
            "DEM topology contains no finite surface samples".into(),
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
    let position_url = format!("tiles/{id}.section.positions.f32");
    let position_path = output_root.join(&position_url);
    let mut positions = fs::File::create(&position_path)?;
    let mut decoded_minimum = [f64::INFINITY; 3];
    let mut decoded_maximum = [f64::NEG_INFINITY; 3];
    for y in 0..grid_height {
        if y % 32 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        for x in 0..grid_width {
            let z = heights[y * grid_width + x];
            let world_x = min_e + (x as f64 + 0.5) * level.gsd;
            let world_y = max_n - (y as f64 + 0.5) * level.gsd;
            let local = [
                (world_x - origin[0]) as f32,
                (world_y - origin[1]) as f32,
                if z.is_finite() && z > -1e30 {
                    z - origin[2] as f32
                } else {
                    0.0
                },
            ];
            for axis in 0..3 {
                let decoded = origin[axis] + f64::from(local[axis]);
                decoded_minimum[axis] = decoded_minimum[axis].min(decoded);
                decoded_maximum[axis] = decoded_maximum[axis].max(decoded);
            }
            for value in local {
                positions.write_all(&value.to_le_bytes())?;
            }
        }
    }
    positions.flush()?;
    let index_url = format!("tiles/{id}.section.indices.u32");
    let index_path = output_root.join(&index_url);
    let mut indices = fs::File::create(&index_path)?;
    let mut index_count = 0_u64;
    for y in 0..grid_height.saturating_sub(1) {
        if y % 32 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        for x in 0..grid_width.saturating_sub(1) {
            let a = y * grid_width + x;
            let b = a + 1;
            let c = a + grid_width;
            let d = c + 1;
            if [a, b, c, d]
                .iter()
                .all(|offset| heights[*offset].is_finite() && heights[*offset] > -1e30)
            {
                for value in [a as u32, c as u32, b as u32, b as u32, c as u32, d as u32] {
                    indices.write_all(&value.to_le_bytes())?;
                    index_count += 1;
                }
            }
        }
    }
    indices.flush()?;
    if index_count == 0 {
        return Err(MeshTilerError::InvalidSource(
            "DEM tile has no valid authoritative triangles".into(),
        ));
    }
    let manifest = SectionTopologyPartitionManifest {
        schema_version: SectionTopologyPartitionManifest::SCHEMA_VERSION,
        origin,
        positions: topology_resource(&position_path, "hcad.positions-f32le-xyz@1")?,
        position_component_type: SectionPositionComponentType::Float32,
        vertex_count: u32::try_from(grid_width * grid_height)
            .expect("513x513 vertex count fits u32"),
        indices: topology_resource(&index_path, "hcad.indices-u32le@1")?,
        index_component_type: SectionIndexComponentType::Uint32,
        index_count,
        material_slots: None,
    };
    let topology_hash = manifest.content_hash()?.0;
    let manifest_url = format!("tiles/{id}.section.json");
    fs::write(
        output_root.join(&manifest_url),
        serde_json::to_vec(&manifest)?,
    )?;
    Ok(PreparedSectionTopologyPart {
        part_id: id.to_owned(),
        topology_hash,
        bounds: PreparedSectionTopologyBounds {
            minimum: decoded_minimum,
            maximum: decoded_maximum,
        },
        manifest_url,
        position_url,
        index_url,
        material_slot_url: None,
    })
}

fn load_topology_heights(
    path: &Path,
    interpolate_holes: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<f32>, MeshTilerError> {
    let bytes = fs::read(path)?;
    if bytes.len() != 512 * 512 * 4 {
        return Err(MeshTilerError::InvalidSource(format!(
            "{} is not a 512x512 Float32 tile",
            path.display()
        )));
    }
    let source = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("fixed")))
        .collect::<Vec<_>>();
    resolve_topology_heights(&source, interpolate_holes, cancellation)
}

fn resolve_topology_heights(
    source: &[f32],
    interpolate_holes: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<f32>, MeshTilerError> {
    let mut resolved = Vec::with_capacity(512 * 512);
    for y in 0..512 {
        if y % 32 == 0 && cancellation.is_cancel_requested() {
            return Err(MeshTilerError::Cancelled);
        }
        for x in 0..512 {
            resolved.push(sample_height(source, x, y, interpolate_holes));
        }
    }
    Ok(resolved)
}

fn kernel_asset(
    uri: String,
    resource: &GeometryResource,
) -> Result<KernelTileAsset, MeshTilerError> {
    Ok(KernelTileAsset {
        uri,
        object_hash: resource.object_hash.0.clone(),
        byte_length: resource.byte_length.ok_or_else(|| {
            MeshTilerError::InvalidSource("kernel asset is missing its byte length".into())
        })?,
    })
}

fn write_kernel_gltf(
    output_root: &Path,
    tile: &MeshTile,
) -> Result<KernelTileContent, MeshTilerError> {
    let position_bytes = tile
        .vertex_count
        .checked_mul(12)
        .ok_or_else(|| MeshTilerError::InvalidSource("position buffer size overflows".into()))?;
    let index_bytes = tile
        .index_count
        .checked_mul(4)
        .ok_or_else(|| MeshTilerError::InvalidSource("index buffer size overflows".into()))?;
    let mut buffers = vec![serde_json::json!({
        "uri": file_name_url(&tile.position_url)?,
        "byteLength": position_bytes,
    })];
    let mut buffer_views = vec![serde_json::json!({
        "buffer": 0,
        "byteOffset": 0,
        "byteLength": position_bytes,
        "target": 34962,
    })];
    let mut accessors = vec![serde_json::json!({
        "bufferView": 0,
        "byteOffset": 0,
        "componentType": 5126,
        "count": tile.vertex_count,
        "type": "VEC3",
        "min": [
            tile.bounds.min.x - tile.origin[0],
            tile.bounds.min.y - tile.origin[1],
            tile.bounds.min.z - tile.origin[2],
        ],
        "max": [
            tile.bounds.max.x - tile.origin[0],
            tile.bounds.max.y - tile.origin[1],
            tile.bounds.max.z - tile.origin[2],
        ],
    })];
    let mut attributes = serde_json::json!({ "POSITION": 0 });
    let mut next_buffer = 1_u32;
    if let Some(uv_url) = &tile.uv_url {
        let uv_bytes = tile
            .vertex_count
            .checked_mul(8)
            .ok_or_else(|| MeshTilerError::InvalidSource("UV buffer size overflows".into()))?;
        buffers.push(serde_json::json!({
            "uri": file_name_url(uv_url)?,
            "byteLength": uv_bytes,
        }));
        buffer_views.push(serde_json::json!({
            "buffer": next_buffer,
            "byteOffset": 0,
            "byteLength": uv_bytes,
            "target": 34962,
        }));
        accessors.push(serde_json::json!({
            "bufferView": next_buffer,
            "byteOffset": 0,
            "componentType": 5126,
            "count": tile.vertex_count,
            "type": "VEC2",
            "min": [0.0, 0.0],
            "max": [1.0, 1.0],
        }));
        attributes["TEXCOORD_0"] = serde_json::json!(next_buffer);
        next_buffer += 1;
    }
    let index_accessor = u32::try_from(accessors.len()).unwrap_or(u32::MAX);
    buffers.push(serde_json::json!({
        "uri": file_name_url(&tile.index_url)?,
        "byteLength": index_bytes,
    }));
    buffer_views.push(serde_json::json!({
        "buffer": next_buffer,
        "byteOffset": 0,
        "byteLength": index_bytes,
        "target": 34963,
    }));
    accessors.push(serde_json::json!({
        "bufferView": next_buffer,
        "byteOffset": 0,
        "componentType": 5125,
        "count": tile.index_count,
        "type": "SCALAR",
    }));
    let mut document = serde_json::json!({
        "asset": { "version": "2.0", "generator": "HimmelCAD DGM tiler" },
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0 }],
        "meshes": [{ "primitives": [{
            "attributes": attributes,
            "indices": index_accessor,
            "material": 0,
            "mode": 4,
        }] }],
        "buffers": buffers,
        "bufferViews": buffer_views,
        "accessors": accessors,
        "materials": [{
            "extensions": { "KHR_materials_unlit": {} },
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.65, 0.67, 0.68, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
            "doubleSided": true,
        }],
    });
    if let Some(texture_url) = &tile.texture_url {
        document["images"] = serde_json::json!([{ "uri": format!("../{texture_url}") }]);
        document["samplers"] = serde_json::json!([{
            "magFilter": 9729,
            "minFilter": 9729,
            "wrapS": 33071,
            "wrapT": 33071,
        }]);
        document["textures"] = serde_json::json!([{ "sampler": 0, "source": 0 }]);
        document["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] =
            serde_json::json!({ "index": 0, "texCoord": 0 });
        document["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] =
            serde_json::json!([1.0, 1.0, 1.0, 1.0]);
    }
    let bytes = serde_json::to_vec(&document)?;
    let url = format!("tiles/{}.gltf", tile.id);
    fs::write(output_root.join(&url), &bytes)?;
    Ok(KernelTileContent {
        url,
        object_hash: ObjectHash::of_bytes(&bytes).0,
        byte_length: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
    })
}

fn file_name_url(url: &str) -> Result<&str, MeshTilerError> {
    Path::new(url)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| MeshTilerError::InvalidSource("mesh resource URL is invalid".into()))
}

fn kernel_hierarchy_manifest(tiles: &[MeshTile]) -> Result<Vec<u8>, MeshTilerError> {
    let tiles = tiles
        .iter()
        .map(|tile| {
            let center = [
                (tile.bounds.min.x + tile.bounds.max.x) * 0.5,
                (tile.bounds.min.y + tile.bounds.max.y) * 0.5,
                (tile.bounds.min.z + tile.bounds.max.z) * 0.5,
            ];
            let dx = tile.bounds.max.x - center[0];
            let dy = tile.bounds.max.y - center[1];
            let dz = tile.bounds.max.z - center[2];
            serde_json::json!({
                "id": tile.id,
                "parent": tile.parent,
                "children": tile.children,
                "bounds": {
                    "kind": "sphere",
                    "center": { "x": center[0], "y": center[1], "z": center[2] },
                    "radius": dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt(),
                },
                "contentTransform": [
                    1.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                    tile.origin[0], tile.origin[1], tile.origin[2], 1.0,
                ],
                "geometricError": tile.geometric_error,
                "refinement": "replace",
                "contents": [{
                    "kind": "gltf",
                    "uri": tile.kernel_content.url,
                    "byteOffset": 0,
                    "byteLength": tile.kernel_content.byte_length,
                    "primitiveCount": tile.index_count / 3,
                    "contentHash": tile.kernel_content.object_hash,
                    "decoderParameters": {
                        "schemaVersion": 1,
                        "requireComplete": true,
                        "immutableAssets": tile.kernel_assets.iter().map(|asset| serde_json::json!({
                            "uri": asset.uri,
                            "contentHash": asset.object_hash,
                            "byteLength": asset.byte_length,
                        })).collect::<Vec<_>>(),
                    },
                }],
                "childPage": null,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "roots": ["root"],
        "tiles": tiles,
    }))
    .map_err(MeshTilerError::Json)
}

fn topology_resource(path: &Path, media_type: &str) -> Result<GeometryResource, MeshTilerError> {
    let byte_length = fs::metadata(path)?.len();
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 8 * 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(GeometryResource {
        object_hash: ObjectHash(hex::encode(digest.finalize())),
        media_type: media_type.to_owned(),
        byte_length: Some(byte_length),
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

fn texture_tile_size(texture_size: u32, columns: u32, rows: u32) -> u32 {
    texture_size
        .checked_div(columns.max(rows).max(1))
        .unwrap_or(1)
        .clamp(1, 512)
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
    fn legacy_prepared_mesh_record_remains_readable_without_kernel_artifacts() {
        let prepared: PreparedMeshProduct = serde_json::from_value(serde_json::json!({
            "manifestRelativePath": "manifest.json",
            "tileCount": 3,
            "triangleCount": 42,
        }))
        .expect("legacy mesh record");
        assert!(prepared.kernel_manifest_relative_path.is_none());
        assert!(prepared.kernel_manifest_resource.is_none());
        assert!(prepared.section_topology.is_none());
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
    fn empty_dem_tiles_are_distinguished_from_occupied_tiles() {
        let root = std::env::temp_dir().join(format!("hcad-mesh-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let empty = root.join("empty.f32");
        let occupied = root.join("occupied.f32");
        let mut values = vec![f32::MIN; 512 * 512];
        fs::write(
            &empty,
            values
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        values[1234] = 42.0;
        fs::write(
            &occupied,
            values
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let cancellation = CancellationToken::new();
        assert!(!tile_contains_surface(&empty, &cancellation).unwrap());
        assert!(tile_contains_surface(&occupied, &cancellation).unwrap());
        let _ = fs::remove_dir_all(root);
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
            8192,
            &CancellationToken::new()
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepared_dem_emits_content_addressed_open_section_topology() {
        use himmelcad_render::{
            decode_gltf_intrinsic_with_resources, inspect_gltf_dependencies, resolve_asset_uri,
            AssetBundleLimits, DatasetId, HierarchySource, PreparedHierarchySource,
            ResolvedAssetBundle, ResolvedAssetInput, TileId,
        };
        let root = std::env::temp_dir().join(format!("hcad-mesh-topology-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dem/view/height/L00/0")).unwrap();
        fs::create_dir_all(root.join("ortho/view/rgba/L00/0")).unwrap();
        RgbaImage::from_pixel(512, 512, image::Rgba([30, 90, 160, 255]))
            .save(root.join("ortho/view/rgba/L00/0/0.png"))
            .unwrap();
        let heights = (0..512 * 512)
            .flat_map(|index| ((index / 512) as f32 * 0.01).to_le_bytes())
            .collect::<Vec<_>>();
        fs::write(root.join("dem/view/height/L00/0/0.f32"), heights).unwrap();
        let summary = raster_summary(1, 1, 1.0);
        let prepared = build_tiled_dem_mesh(
            &root.join("dem"),
            &summary,
            &root.join("mesh"),
            Some(&root.join("ortho")),
            Some(&summary),
            2,
            false,
            2048,
            &CancellationToken::new(),
        )
        .expect("prepared DGM");

        let section_topology = prepared
            .section_topology
            .as_ref()
            .expect("section topology");
        assert!(!section_topology.closed_manifold);
        assert_eq!(section_topology.parts.len(), 1);
        let part = &section_topology.parts[0];
        assert_eq!(part.part_id, "root");
        let manifest_bytes = fs::read(root.join("mesh").join(&part.manifest_url)).unwrap();
        assert_eq!(ObjectHash::of_bytes(&manifest_bytes).0, part.topology_hash);
        let manifest: SectionTopologyPartitionManifest =
            serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest.content_hash().unwrap().0, part.topology_hash);
        let positions = fs::read(root.join("mesh").join(&part.position_url)).unwrap();
        let indices = fs::read(root.join("mesh").join(&part.index_url)).unwrap();
        assert_eq!(
            ObjectHash::of_bytes(&positions),
            manifest.positions.object_hash
        );
        assert_eq!(ObjectHash::of_bytes(&indices), manifest.indices.object_hash);
        assert_eq!(manifest.vertex_count, 512 * 512);
        assert_eq!(manifest.index_count, 6 * 511 * 511);
        for position in positions.chunks_exact(12) {
            for axis in 0..3 {
                let start = axis * 4;
                let local = f32::from_le_bytes(position[start..start + 4].try_into().unwrap());
                let decoded = manifest.origin[axis] + f64::from(local);
                assert!(decoded >= part.bounds.minimum[axis]);
                assert!(decoded <= part.bounds.maximum[axis]);
            }
        }
        assert!(root
            .join("mesh")
            .join(&section_topology.manifest_relative_path)
            .is_file());
        let kernel_manifest_relative_path = prepared
            .kernel_manifest_relative_path
            .as_ref()
            .expect("kernel manifest path");
        let kernel_manifest_bytes =
            fs::read(root.join("mesh").join(kernel_manifest_relative_path)).unwrap();
        assert_eq!(
            ObjectHash::of_bytes(&kernel_manifest_bytes),
            prepared
                .kernel_manifest_resource
                .as_ref()
                .expect("kernel manifest resource")
                .object_hash
        );
        let kernel_manifest: serde_json::Value =
            serde_json::from_slice(&kernel_manifest_bytes).unwrap();
        let kernel_tile = &kernel_manifest["tiles"][0];
        assert_eq!(kernel_tile["contents"][0]["kind"], "gltf");
        assert_eq!(kernel_tile["contents"][0]["primitiveCount"], 2);
        assert_eq!(kernel_tile["contentTransform"][12], manifest.origin[0]);
        assert_eq!(kernel_tile["contentTransform"][13], manifest.origin[1]);
        assert_eq!(kernel_tile["contentTransform"][14], manifest.origin[2]);
        let gltf_url = kernel_tile["contents"][0]["uri"].as_str().unwrap();
        let gltf_bytes = fs::read(root.join("mesh").join(gltf_url)).unwrap();
        assert_eq!(
            ObjectHash::of_bytes(&gltf_bytes).0,
            kernel_tile["contents"][0]["contentHash"]
        );
        let gltf: serde_json::Value = serde_json::from_slice(&gltf_bytes).unwrap();
        gltf::Gltf::from_slice(&gltf_bytes).expect("kernel glTF contract");
        assert_eq!(gltf["asset"]["version"], "2.0");
        assert_eq!(gltf["accessors"][0]["count"], 4);
        assert_eq!(gltf["accessors"][1]["count"], 4);
        assert_eq!(gltf["accessors"][2]["count"], 6);
        let immutable_assets = kernel_tile["contents"][0]["decoderParameters"]["immutableAssets"]
            .as_array()
            .expect("immutable glTF resources");
        assert_eq!(immutable_assets.len(), 4);
        let gltf_parent = Path::new(gltf_url).parent().unwrap();
        for asset in immutable_assets {
            let uri = asset["uri"].as_str().unwrap();
            let bytes = fs::read(root.join("mesh").join(gltf_parent).join(uri)).unwrap();
            assert_eq!(asset["byteLength"].as_u64(), Some(bytes.len() as u64));
            assert_eq!(asset["contentHash"], ObjectHash::of_bytes(&bytes).0);
        }

        let kernel_manifest_uri = "https://example.test/dgm/kernel-manifest.json";
        let mut hierarchy = PreparedHierarchySource::from_json(
            DatasetId("road-dgm".to_owned()),
            kernel_manifest_uri,
            &kernel_manifest_bytes,
        )
        .expect("kernel hierarchy contract");
        let root_tile = hierarchy
            .tile(&TileId("root".to_owned()))
            .expect("root lookup")
            .expect("root descriptor");
        let content = &root_tile.contents[0];
        let limits = AssetBundleLimits::default();
        let dependencies = inspect_gltf_dependencies(&content.uri, &gltf_bytes, limits)
            .expect("generated glTF dependencies");
        let mut declared_uris = immutable_assets
            .iter()
            .map(|asset| asset["uri"].as_str().unwrap())
            .collect::<Vec<_>>();
        declared_uris.sort_unstable();
        let mut dependency_uris = dependencies
            .dependencies()
            .iter()
            .map(|dependency| dependency.source_uri.as_str())
            .collect::<Vec<_>>();
        dependency_uris.sort_unstable();
        assert_eq!(declared_uris, dependency_uris);
        let owned_resources = dependencies
            .dependencies()
            .iter()
            .map(|dependency| {
                let resolved = resolve_asset_uri(
                    &dependency.owner_uri,
                    &dependency.source_uri,
                    limits.max_uri_bytes,
                )
                .expect("resolved generated dependency");
                let bytes = fs::read(root.join("mesh/tiles").join(&dependency.source_uri))
                    .expect("generated dependency bytes");
                (dependency.clone(), resolved, bytes)
            })
            .collect::<Vec<_>>();
        let inputs = owned_resources
            .iter()
            .map(|(dependency, resolved, bytes)| ResolvedAssetInput {
                owner_uri: &dependency.owner_uri,
                source_uri: &dependency.source_uri,
                resolved_uri: resolved,
                kind: dependency.kind,
                bytes,
            })
            .collect::<Vec<_>>();
        let bundle =
            ResolvedAssetBundle::build(&inputs, limits).expect("generated glTF resource bundle");
        let decoded = decode_gltf_intrinsic_with_resources(
            &content.uri,
            &gltf_bytes,
            &bundle,
            root_tile.content_transform,
        )
        .expect("kernel decoder accepts generated DGM tile");
        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices.len(), 6);
        assert_eq!(decoded.images.len(), 1);
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
            512,
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

    #[test]
    fn texture_budget_controls_per_tile_resolution() {
        assert_eq!(texture_tile_size(2048, 16, 8), 128);
        assert_eq!(texture_tile_size(8192, 16, 8), 512);
        assert_eq!(texture_tile_size(2048, 1, 1), 512);
        assert_eq!(texture_tile_size(2048, 512, 512), 4);
    }

    #[test]
    fn texture_budget_resamples_streaming_tiles() {
        let root =
            std::env::temp_dir().join(format!("hcad-mesh-texture-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let source = root.join("ortho/view/rgba/L00/0");
        fs::create_dir_all(&source).unwrap();
        RgbaImage::from_pixel(512, 512, image::Rgba([12, 34, 56, 255]))
            .save(source.join("0.png"))
            .unwrap();
        let summary = raster_summary(1, 1, 1.0);
        copy_texture(
            &root.join("ortho"),
            &summary,
            &summary,
            &summary.levels[0],
            &root.join("mesh"),
            0,
            0,
            128,
            &CancellationToken::new(),
        )
        .unwrap();
        let output = image::open(root.join("mesh/textures/0/0.png"))
            .unwrap()
            .to_rgba8();
        assert_eq!(output.dimensions(), (128, 128));
        assert_eq!(output.get_pixel(64, 64).0, [12, 34, 56, 255]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multi_tile_dgm_keeps_distinct_textured_root_and_leaf_lods() {
        let root = std::env::temp_dir().join(format!("hcad-mesh-root-lod-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for path in [
            "dem/view/height/L00/0",
            "dem/view/height/L00/1",
            "dem/view/height/L01/0",
            "ortho/view/rgba/L00/0",
            "ortho/view/rgba/L00/1",
        ] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        let height_bytes = vec![10.0_f32; 512 * 512]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        for path in [
            "dem/view/height/L00/0/0.f32",
            "dem/view/height/L00/1/0.f32",
            "dem/view/height/L01/0/0.f32",
        ] {
            fs::write(root.join(path), &height_bytes).unwrap();
        }
        RgbaImage::from_pixel(512, 512, image::Rgba([220, 20, 20, 255]))
            .save(root.join("ortho/view/rgba/L00/0/0.png"))
            .unwrap();
        RgbaImage::from_pixel(512, 512, image::Rgba([20, 40, 220, 255]))
            .save(root.join("ortho/view/rgba/L00/1/0.png"))
            .unwrap();
        let mut summary = raster_summary(2, 1, 1.0);
        summary.levels.push(RasterLevelSummary {
            level: 1,
            columns: 1,
            rows: 1,
            tile_count: 1,
            bounds: summary.grid.bounds,
            gsd: 2.0,
            relative_directory: "pyramid/L01".into(),
            metric_tile_url_template: String::new(),
            view_layers: vec![],
        });
        let prepared = build_tiled_dem_mesh(
            &root.join("dem"),
            &summary,
            &root.join("mesh"),
            Some(&root.join("ortho")),
            Some(&summary),
            6,
            false,
            2048,
            &CancellationToken::new(),
        )
        .expect("multi-tile textured DGM");
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("mesh").join(&prepared.manifest_relative_path)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["tiles"][0]["textureUrl"], "textures/root.png");
        assert_eq!(manifest["tiles"][1]["textureUrl"], "textures/0/0.png");
        assert_eq!(manifest["tiles"][2]["textureUrl"], "textures/1/0.png");
        let overview = image::open(root.join("mesh/textures/root.png"))
            .unwrap()
            .to_rgba8();
        assert_eq!(overview.get_pixel(64, 128).0, [220, 20, 20, 255]);
        assert_eq!(overview.get_pixel(448, 128).0, [20, 40, 220, 255]);
        assert_eq!(
            image::open(root.join("mesh/textures/0/0.png"))
                .unwrap()
                .to_rgba8()
                .get_pixel(256, 256)
                .0,
            [220, 20, 20, 255]
        );
        let topology = prepared.section_topology.as_ref().unwrap();
        assert_eq!(topology.parts.len(), 2);
        let left: SectionTopologyPartitionManifest = serde_json::from_slice(
            &fs::read(root.join("mesh").join(&topology.parts[0].manifest_url)).unwrap(),
        )
        .unwrap();
        let right: SectionTopologyPartitionManifest = serde_json::from_slice(
            &fs::read(root.join("mesh").join(&topology.parts[1].manifest_url)).unwrap(),
        )
        .unwrap();
        assert_eq!(left.vertex_count, 513 * 512);
        assert_eq!(left.index_count, 6 * 512 * 511);
        assert_eq!(right.vertex_count, 512 * 512);
        assert_eq!(right.index_count, 6 * 511 * 511);
        let trace_length = topology
            .parts
            .iter()
            .map(|part| {
                use himmelcad_render::{
                    section_open_mesh, SectionMeshInput, SectionPlane, WorldVec3,
                };
                let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(
                    &fs::read(root.join("mesh").join(&part.manifest_url)).unwrap(),
                )
                .unwrap();
                let positions = fs::read(root.join("mesh").join(&part.position_url))
                    .unwrap()
                    .chunks_exact(12)
                    .map(|xyz| WorldVec3 {
                        x: manifest.origin[0]
                            + f64::from(f32::from_le_bytes(xyz[0..4].try_into().unwrap())),
                        y: manifest.origin[1]
                            + f64::from(f32::from_le_bytes(xyz[4..8].try_into().unwrap())),
                        z: manifest.origin[2]
                            + f64::from(f32::from_le_bytes(xyz[8..12].try_into().unwrap())),
                    })
                    .collect::<Vec<_>>();
                let indices = fs::read(root.join("mesh").join(&part.index_url))
                    .unwrap()
                    .chunks_exact(4)
                    .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
                    .collect::<Vec<_>>();
                section_open_mesh(
                    SectionMeshInput {
                        positions: &positions,
                        indices: &indices,
                        material_slots: None,
                        closed_manifold: false,
                    },
                    SectionPlane {
                        origin: WorldVec3 {
                            x: 0.0,
                            y: 256.25,
                            z: 10.0,
                        },
                        normal: WorldVec3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    },
                    1.0e-8,
                )
                .unwrap()
                .segments
                .iter()
                .map(|segment| {
                    let dx = segment.end.x - segment.start.x;
                    let dy = segment.end.y - segment.start.y;
                    let dz = segment.end.z - segment.start.z;
                    dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt()
                })
                .sum::<f64>()
            })
            .sum::<f64>();
        assert!((trace_length - 1023.0).abs() < 1.0e-6);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "explicit checksum-pinned GeoBasis-DE/LGB real-data gate"]
    fn real_brandenburg_dgm_section_is_exact_across_the_source_tile_seam() {
        use himmelcad_render::{section_open_mesh, SectionMeshInput, SectionPlane, WorldVec3};

        let fixture_root = std::env::var_os("HCAD_REAL_DGM_FIXTURE_ROOT")
            .map(PathBuf::from)
            .expect("HCAD_REAL_DGM_FIXTURE_ROOT must point at extracted locked GeoTIFFs");
        let west = fs::read(fixture_root.join("dgm_33250-5888.window.f32"))
            .expect("read derived west DGM1 window");
        let east = fs::read(fixture_root.join("dgm_33251-5888.window.f32"))
            .expect("read derived east DGM1 window");
        assert_eq!(west.len(), 512 * 512 * 4);
        assert_eq!(east.len(), 512 * 512 * 4);

        let root = std::env::temp_dir().join(format!(
            "hcad-real-brandenburg-dgm-section-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let dem_root = root.join("dem");
        for column in 0..2 {
            fs::create_dir_all(dem_root.join(format!("view/height/L00/{column}"))).unwrap();
        }
        fs::write(dem_root.join("view/height/L00/0/0.f32"), west)
            .expect("stage west real DGM window");
        fs::write(dem_root.join("view/height/L00/1/0.f32"), east)
            .expect("stage east real DGM window");

        let mut summary = raster_summary(2, 1, 1.0);
        let bounds = crate::raster_runtime::RasterBounds {
            minimum_east: 250_488.0,
            minimum_north: 5_888_244.0,
            maximum_east: 251_512.0,
            maximum_north: 5_888_756.0,
        };
        summary.levels[0].bounds = bounds;
        summary.grid.bounds = bounds;
        summary.crs.horizontal = "EPSG:25833".to_owned();
        summary.crs.vertical = Some("EPSG:7837".to_owned());
        summary.crs.gdal_srs = "EPSG:25833+7837".to_owned();
        let prepared = build_tiled_dem_mesh(
            &dem_root,
            &summary,
            &root.join("mesh"),
            None,
            None,
            2,
            false,
            2048,
            &CancellationToken::new(),
        )
        .expect("prepare real two-tile DGM");
        let topology = prepared
            .section_topology
            .as_ref()
            .expect("section topology");
        assert_eq!(topology.parts.len(), 2);

        let mut segments = Vec::new();
        let mut exact_triangles = 0_u64;
        for part in &topology.parts {
            let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(
                &fs::read(root.join("mesh").join(&part.manifest_url)).unwrap(),
            )
            .unwrap();
            exact_triangles += manifest.index_count / 3;
            let positions = fs::read(root.join("mesh").join(&part.position_url))
                .unwrap()
                .chunks_exact(12)
                .map(|xyz| WorldVec3 {
                    x: manifest.origin[0]
                        + f64::from(f32::from_le_bytes(xyz[0..4].try_into().unwrap())),
                    y: manifest.origin[1]
                        + f64::from(f32::from_le_bytes(xyz[4..8].try_into().unwrap())),
                    z: manifest.origin[2]
                        + f64::from(f32::from_le_bytes(xyz[8..12].try_into().unwrap())),
                })
                .collect::<Vec<_>>();
            let indices = fs::read(root.join("mesh").join(&part.index_url))
                .unwrap()
                .chunks_exact(4)
                .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
                .collect::<Vec<_>>();
            segments.extend(
                section_open_mesh(
                    SectionMeshInput {
                        positions: &positions,
                        indices: &indices,
                        material_slots: None,
                        closed_manifold: false,
                    },
                    SectionPlane {
                        origin: WorldVec3 {
                            x: 251_000.0,
                            y: 5_888_488.0,
                            z: 0.0,
                        },
                        normal: WorldVec3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    },
                    1.0e-8,
                )
                .expect("exact real DGM partition section")
                .segments,
            );
        }
        assert_eq!(exact_triangles, 1_045_506);
        assert_eq!(segments.len(), 2_046);
        let mut intervals = segments
            .iter()
            .map(|segment| {
                (
                    segment.start.x.min(segment.end.x),
                    segment.start.x.max(segment.end.x),
                )
            })
            .collect::<Vec<_>>();
        intervals
            .sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.total_cmp(&right.1)));
        assert!((intervals[0].0 - 250_488.5).abs() < 1.0e-8);
        assert!((intervals.last().unwrap().1 - 251_511.5).abs() < 1.0e-8);
        for pair in intervals.windows(2) {
            assert!(
                (pair[1].0 - pair[0].1).abs() < 1.0e-8,
                "real DGM trace has a gap or positive overlap: {pair:?}"
            );
        }
        let seam_heights = segments
            .iter()
            .flat_map(|segment| [segment.start, segment.end])
            .filter(|point| (point.x - 251_000.5).abs() < 1.0e-8)
            .map(|point| point.z)
            .collect::<Vec<_>>();
        assert!(!seam_heights.is_empty());
        assert!(seam_heights
            .iter()
            .all(|height| (*height - 33.0).abs() < 1.0e-6));
        let projected_length = intervals
            .iter()
            .map(|(start, end)| end - start)
            .sum::<f64>();
        assert!((projected_length - 1_023.0).abs() < 1.0e-8);
        let _ = fs::remove_dir_all(root);
    }
}
