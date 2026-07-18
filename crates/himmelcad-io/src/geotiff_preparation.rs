//! Bounded, atomic viewer preparation for canonical elevation `GeoTIFF` resources.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use geotiff_reader::GeoTiffFile;
use himmelcad_core::entity_model::{GeometryResource, OrthoGridMapping, RasterCellDiagonal};
use himmelcad_core::hash::ObjectHash;
use himmelcad_render::{
    BoundingVolume, ContentKind, ContentReference, PreparedHierarchyManifest, RefinementMode,
    TileDescriptor, TileId, WorldAabb, WorldTransform, WorldVec3,
};
use image::{GrayImage, ImageFormat};
use serde::Serialize;
use sha2::Digest;

use crate::canonical_provider::{
    PreparedDatasetArtifact, ProviderContractError, ProviderOperationContext, ProviderProgress,
};

const TILE_SIZE: usize = 512;
const TILE_SIZE_U32: u32 = 512;
pub(crate) const F64_TILE_BYTES: u64 = 512 * 512 * 8;
pub(crate) const HIERARCHY_MEDIA_TYPE: &str = "himmelcad-prepared-hierarchy@1";
pub(crate) const HEIGHT_MEDIA_TYPE: &str = "application/vnd.himmelcad.raster-f64le";
const PNG_MEDIA_TYPE: &str = "image/png";

#[derive(Debug)]
pub(crate) struct PreparedGeoTiffHierarchy {
    pub(crate) dataset_id: String,
    pub(crate) artifacts: Vec<PreparedDatasetArtifact>,
}

#[derive(Debug, Clone, Copy)]
struct Level {
    index: u16,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    scale: u64,
}

#[derive(Debug)]
struct TileEvidence {
    height: GeometryResource,
    color: GeometryResource,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparationIdentity<'a> {
    schema_version: u32,
    source_sha256: &'a ObjectHash,
    maximum_height_jump: Option<f64>,
    diagonal: RasterCellDiagonal,
    tile_size: u32,
    elevation_encoding: &'static str,
}

#[allow(clippy::too_many_lines)]
pub(crate) fn prepare_elevation_geotiff(
    source: &GeoTiffFile,
    resource_root: &Path,
    source_resource: &GeometryResource,
    mapping: OrthoGridMapping,
    maximum_height_jump: Option<f64>,
    context: &mut dyn ProviderOperationContext,
) -> Result<PreparedGeoTiffHierarchy, ProviderContractError> {
    check_cancelled(context)?;
    let identity = PreparationIdentity {
        schema_version: 1,
        source_sha256: &source_resource.object_hash,
        maximum_height_jump,
        diagonal: RasterCellDiagonal::TopLeftToBottomRight,
        tile_size: TILE_SIZE_U32,
        elevation_encoding: "float64LittleEndian",
    };
    let identity_bytes = serde_json::to_vec(&identity).map_err(provider_error)?;
    let preparation_hash = ObjectHash::of_bytes(&identity_bytes);
    let dataset_id = format!("geotiff-elevation-{}", &preparation_hash.as_str()[..32]);
    let relative_root = PathBuf::from("geotiff")
        .join("prepared")
        .join(preparation_hash.as_str());
    let final_root = resource_root.join(&relative_root);
    let staging_parent = resource_root.join("geotiff").join(".prepared-staging");
    fs::create_dir_all(&staging_parent).map_err(provider_error)?;
    let staging_root = staging_parent.join(format!(
        "{}-{}-{}",
        std::process::id(),
        preparation_hash.as_str(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(provider_error)?
            .as_nanos()
    ));
    fs::create_dir(&staging_root).map_err(provider_error)?;
    let mut cleanup = StagingDirectory::new(staging_root.clone());

    let levels = levels(source.width(), source.height())?;
    let total_tiles = levels
        .iter()
        .map(|level| u64::from(level.columns) * u64::from(level.rows))
        .sum::<u64>();
    context.report_progress(ProviderProgress {
        phase: "prepareViewer".to_owned(),
        completed: 0,
        total: Some(total_tiles.saturating_mul(2)),
        message: "GeoTIFF-Höhenpyramide wird kachelweise vorbereitet".to_owned(),
    });

    let no_data = parse_no_data(source.nodata())?;
    let mut evidence = BTreeMap::new();
    let mut completed = 0_u64;
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    write_base_level(
        source,
        &staging_root,
        levels[0],
        no_data,
        context,
        &mut evidence,
        &mut minimum,
        &mut maximum,
        &mut completed,
        total_tiles,
    )?;
    if !minimum.is_finite() || !maximum.is_finite() {
        return Err(provider_message(
            "elevation GeoTIFF contains no finite height samples",
        ));
    }
    for pair in levels.windows(2) {
        write_parent_level(
            &staging_root,
            pair[0],
            pair[1],
            context,
            &mut evidence,
            &mut completed,
            total_tiles,
        )?;
    }
    write_previews(
        &staging_root,
        &levels,
        minimum,
        maximum,
        context,
        &mut evidence,
        &mut completed,
        total_tiles,
    )?;

    let manifest = hierarchy_manifest(
        &levels,
        &evidence,
        mapping,
        minimum,
        maximum,
        maximum_height_jump,
    )?;
    let manifest_bytes = manifest.to_validated_json().map_err(provider_error)?;
    let manifest_relative = PathBuf::from("viewer/manifest.json");
    write_bytes(&staging_root.join(&manifest_relative), &manifest_bytes)?;

    let mut artifacts = evidence
        .into_iter()
        .flat_map(|((level, column, row), tile)| {
            [
                (
                    PathBuf::from(format!("height/L{level:02}/{column}/{row}.f64")),
                    tile.height,
                ),
                (
                    PathBuf::from(format!("color/L{level:02}/{column}/{row}.png")),
                    tile.color,
                ),
            ]
        })
        .collect::<Vec<_>>();
    artifacts.push((
        manifest_relative,
        GeometryResource {
            object_hash: ObjectHash::of_bytes(&manifest_bytes),
            media_type: HIERARCHY_MEDIA_TYPE.to_owned(),
            byte_length: u64::try_from(manifest_bytes.len()).ok(),
        },
    ));
    artifacts.sort_by(|left, right| left.0.cmp(&right.0));
    check_cancelled(context)?;
    publish_or_verify(&staging_root, &final_root, &artifacts, context)?;
    cleanup.disarm();

    Ok(PreparedGeoTiffHierarchy {
        dataset_id,
        artifacts: artifacts
            .into_iter()
            .map(|(path, resource)| PreparedDatasetArtifact {
                relative_path: relative_root.join(path),
                resource,
            })
            .collect(),
    })
}

#[allow(clippy::too_many_arguments)]
fn write_base_level(
    source: &GeoTiffFile,
    root: &Path,
    level: Level,
    no_data: Option<f64>,
    context: &mut dyn ProviderOperationContext,
    evidence: &mut BTreeMap<(u16, u32, u32), TileEvidence>,
    minimum: &mut f64,
    maximum: &mut f64,
    completed: &mut u64,
    total_tiles: u64,
) -> Result<(), ProviderContractError> {
    let ifd = source
        .tiff()
        .ifd(source.base_ifd_index())
        .map_err(provider_error)?;
    let bits = *ifd
        .bits_per_sample()
        .first()
        .ok_or_else(|| provider_message("GeoTIFF sample bit depth is missing"))?;
    let format = *ifd
        .sample_format()
        .first()
        .ok_or_else(|| provider_message("GeoTIFF sample format is missing"))?;
    for row in 0..level.rows {
        for column in 0..level.columns {
            check_cancelled(context)?;
            let col_off = usize::try_from(column)
                .ok()
                .and_then(|value| value.checked_mul(TILE_SIZE))
                .ok_or_else(|| provider_message("GeoTIFF tile column overflow"))?;
            let row_off = usize::try_from(row)
                .ok()
                .and_then(|value| value.checked_mul(TILE_SIZE))
                .ok_or_else(|| provider_message("GeoTIFF tile row overflow"))?;
            let cols = TILE_SIZE.min(usize::try_from(level.width).unwrap_or(usize::MAX) - col_off);
            let rows = TILE_SIZE.min(usize::try_from(level.height).unwrap_or(usize::MAX) - row_off);
            let samples =
                read_elevation_window(source, format, bits, row_off, col_off, rows, cols)?;
            let mut tile = vec![f64::NAN; TILE_SIZE * TILE_SIZE];
            for source_row in 0..rows {
                for source_column in 0..cols {
                    let value = samples[source_row * cols + source_column];
                    let valid = value.is_finite()
                        && no_data.is_none_or(|sentinel| !is_no_data(value, sentinel));
                    if valid {
                        tile[source_row * TILE_SIZE + source_column] = value;
                        *minimum = minimum.min(value);
                        *maximum = maximum.max(value);
                    }
                }
            }
            let resource = write_height_tile(root, level.index, column, row, &tile)?;
            evidence.insert(
                (level.index, column, row),
                TileEvidence {
                    height: resource,
                    color: empty_resource(),
                },
            );
            *completed = completed.saturating_add(1);
            report_tile_progress(context, *completed, total_tiles.saturating_mul(2));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_parent_level(
    root: &Path,
    child: Level,
    parent: Level,
    context: &mut dyn ProviderOperationContext,
    evidence: &mut BTreeMap<(u16, u32, u32), TileEvidence>,
    completed: &mut u64,
    total_tiles: u64,
) -> Result<(), ProviderContractError> {
    for row in 0..parent.rows {
        for column in 0..parent.columns {
            check_cancelled(context)?;
            let mut children = BTreeMap::new();
            for child_row in row * 2..(row * 2 + 2).min(child.rows) {
                for child_column in column * 2..(column * 2 + 2).min(child.columns) {
                    children.insert(
                        (child_column, child_row),
                        read_height_tile(root, child.index, child_column, child_row)?,
                    );
                }
            }
            let mut output = vec![f64::NAN; TILE_SIZE * TILE_SIZE];
            let parent_col_start = u64::from(column) * TILE_SIZE as u64;
            let parent_row_start = u64::from(row) * TILE_SIZE as u64;
            for local_row in 0..TILE_SIZE {
                let parent_row = parent_row_start + local_row as u64;
                if parent_row >= u64::from(parent.height) {
                    break;
                }
                for local_column in 0..TILE_SIZE {
                    let parent_column = parent_col_start + local_column as u64;
                    if parent_column >= u64::from(parent.width) {
                        break;
                    }
                    let mut sum = 0.0;
                    let mut count = 0_u8;
                    for dy in 0..2_u64 {
                        for dx in 0..2_u64 {
                            let source_column = parent_column * 2 + dx;
                            let source_row = parent_row * 2 + dy;
                            if source_column >= u64::from(child.width)
                                || source_row >= u64::from(child.height)
                            {
                                continue;
                            }
                            let tile_column = u32::try_from(source_column / TILE_SIZE as u64)
                                .map_err(provider_error)?;
                            let tile_row = u32::try_from(source_row / TILE_SIZE as u64)
                                .map_err(provider_error)?;
                            let sample_column = usize::try_from(source_column % TILE_SIZE as u64)
                                .map_err(provider_error)?;
                            let sample_row = usize::try_from(source_row % TILE_SIZE as u64)
                                .map_err(provider_error)?;
                            let value = children[&(tile_column, tile_row)]
                                [sample_row * TILE_SIZE + sample_column];
                            if value.is_finite() {
                                sum += value;
                                count += 1;
                            }
                        }
                    }
                    if count != 0 {
                        output[local_row * TILE_SIZE + local_column] = sum / f64::from(count);
                    }
                }
            }
            let resource = write_height_tile(root, parent.index, column, row, &output)?;
            evidence.insert(
                (parent.index, column, row),
                TileEvidence {
                    height: resource,
                    color: empty_resource(),
                },
            );
            *completed = completed.saturating_add(1);
            report_tile_progress(context, *completed, total_tiles.saturating_mul(2));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_previews(
    root: &Path,
    levels: &[Level],
    minimum: f64,
    maximum: f64,
    context: &mut dyn ProviderOperationContext,
    evidence: &mut BTreeMap<(u16, u32, u32), TileEvidence>,
    completed: &mut u64,
    total_tiles: u64,
) -> Result<(), ProviderContractError> {
    for level in levels {
        for row in 0..level.rows {
            for column in 0..level.columns {
                check_cancelled(context)?;
                let heights = read_height_tile(root, level.index, column, row)?;
                let mut pixels = vec![0_u8; TILE_SIZE * TILE_SIZE];
                for (pixel, height) in pixels.iter_mut().zip(heights) {
                    if !height.is_finite() {
                        continue;
                    }
                    *pixel = if maximum > minimum {
                        let normalized = ((height - minimum) / (maximum - minimum)).clamp(0.0, 1.0);
                        grayscale_byte(normalized)
                    } else {
                        128
                    };
                }
                let path = root.join(format!("color/L{:02}/{column}/{row}.png", level.index));
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(provider_error)?;
                }
                let image = GrayImage::from_raw(TILE_SIZE_U32, TILE_SIZE_U32, pixels)
                    .ok_or_else(|| provider_message("invalid GeoTIFF preview buffer"))?;
                image
                    .save_with_format(&path, ImageFormat::Png)
                    .map_err(provider_error)?;
                let resource = hash_resource(&path, PNG_MEDIA_TYPE, context)?;
                evidence
                    .get_mut(&(level.index, column, row))
                    .ok_or_else(|| provider_message("prepared height tile evidence is missing"))?
                    .color = resource;
                *completed = completed.saturating_add(1);
                report_tile_progress(context, *completed, total_tiles.saturating_mul(2));
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn hierarchy_manifest(
    levels: &[Level],
    evidence: &BTreeMap<(u16, u32, u32), TileEvidence>,
    mapping: OrthoGridMapping,
    minimum: f64,
    maximum: f64,
    maximum_height_jump: Option<f64>,
) -> Result<PreparedHierarchyManifest, ProviderContractError> {
    let coarsest = levels
        .last()
        .ok_or_else(|| provider_message("prepared GeoTIFF has no levels"))?;
    let roots = tile_ids(*coarsest);
    let mut tiles = Vec::with_capacity(evidence.len());
    for level in levels.iter().rev() {
        for row in 0..level.rows {
            for column in 0..level.columns {
                let tile = evidence
                    .get(&(level.index, column, row))
                    .ok_or_else(|| provider_message("prepared GeoTIFF tile evidence is missing"))?;
                let id = tile_id(level.index, column, row);
                let parent = levels
                    .get(usize::from(level.index) + 1)
                    .map(|parent| tile_id(parent.index, column / 2, row / 2));
                let children = if level.index == 0 {
                    Vec::new()
                } else {
                    let child = levels[usize::from(level.index - 1)];
                    (row * 2..(row * 2 + 2).min(child.rows))
                        .flat_map(|child_row| {
                            (column * 2..(column * 2 + 2).min(child.columns)).map(
                                move |child_column| tile_id(child.index, child_column, child_row),
                            )
                        })
                        .collect()
                };
                let scale = exact_u64_f64(level.scale)?;
                let center_bias = exact_u64_f64(level.scale.saturating_sub(1))? * 0.5;
                let global_column = u64::from(column) * TILE_SIZE as u64 * level.scale;
                let global_row = u64::from(row) * TILE_SIZE as u64 * level.scale;
                let origin = add_mapping(
                    mapping,
                    exact_u64_f64(global_column)? + center_bias,
                    exact_u64_f64(global_row)? + center_bias,
                );
                let column_step = [mapping.column_step.x * scale, mapping.column_step.y * scale];
                let row_step = [mapping.row_step.x * scale, mapping.row_step.y * scale];
                let bounds = tile_world_bounds(*level, column, row, mapping, minimum, maximum)?;
                let color_uri = format!("../color/L{:02}/{column}/{row}.png", level.index);
                let elevation_uri =
                    format!("../../../height/L{:02}/{column}/{row}.f64", level.index);
                tiles.push(TileDescriptor {
                    id: TileId(id),
                    parent: parent.map(TileId),
                    children: children.into_iter().map(TileId).collect(),
                    bounds: BoundingVolume::AxisAlignedBox { bounds },
                    content_transform: WorldTransform::IDENTITY,
                    geometric_error: column_step
                        .into_iter()
                        .chain(row_step)
                        .map(f64::abs)
                        .fold(0.0, f64::max),
                    refinement: RefinementMode::Replace,
                    contents: vec![ContentReference {
                        kind: ContentKind::Raster,
                        uri: color_uri,
                        byte_offset: None,
                        byte_length: None,
                        primitive_count: Some((TILE_SIZE * TILE_SIZE) as u64),
                        content_hash: Some(tile.color.object_hash.0.clone()),
                        decoder_parameters: Some(serde_json::json!({
                            "schemaVersion": 1,
                            "width": TILE_SIZE_U32,
                            "height": TILE_SIZE_U32,
                            "mapping": {
                                "origin": origin,
                                "columnStep": column_step,
                                "rowStep": row_step,
                            },
                            "topology": {
                                "kind": "continuous",
                                "maximumHeightJump": maximum_height_jump,
                                "diagonal": "topLeftToBottomRight",
                            },
                            "colorEncoding": "encodedImage",
                            "elevationEncoding": { "kind": "float64LittleEndian" },
                            "noData": { "kind": "nan" },
                            "elevationReference": {
                                "uri": elevation_uri,
                                "byteOffset": null,
                                "byteLength": tile.height.byte_length,
                                "contentHash": tile.height.object_hash,
                            },
                            "validityReference": null,
                            "confidenceReference": null,
                            "triangleMaskReference": null,
                        })),
                    }],
                    child_page: None,
                    provider_metadata: Some(serde_json::json!({
                        "schemaId": "hcad.provider.geotiff-elevation-tile@1",
                        "level": level.index,
                        "column": column,
                        "row": row,
                        "sourceScale": level.scale,
                    })),
                });
            }
        }
    }
    Ok(PreparedHierarchyManifest {
        schema_version: 1,
        roots: roots.into_iter().map(TileId).collect(),
        tiles,
    })
}

fn tile_world_bounds(
    level: Level,
    column: u32,
    row: u32,
    mapping: OrthoGridMapping,
    minimum: f64,
    maximum: f64,
) -> Result<WorldAabb, ProviderContractError> {
    let start_column = u64::from(column) * TILE_SIZE as u64;
    let start_row = u64::from(row) * TILE_SIZE as u64;
    let width = u64::from(level.width)
        .saturating_sub(start_column)
        .min(TILE_SIZE as u64);
    let height = u64::from(level.height)
        .saturating_sub(start_row)
        .min(TILE_SIZE as u64);
    if width == 0 || height == 0 {
        return Err(provider_message(
            "prepared GeoTIFF tile is outside its level",
        ));
    }
    let scale = exact_u64_f64(level.scale)?;
    let left = exact_u64_f64(start_column)? * scale - 0.5;
    let top = exact_u64_f64(start_row)? * scale - 0.5;
    let right = exact_u64_f64(start_column + width)? * scale - 0.5;
    let bottom = exact_u64_f64(start_row + height)? * scale - 0.5;
    let corners = [
        add_mapping(mapping, left, top),
        add_mapping(mapping, right, top),
        add_mapping(mapping, left, bottom),
        add_mapping(mapping, right, bottom),
    ];
    Ok(WorldAabb {
        min: WorldVec3 {
            x: corners
                .iter()
                .map(|point| point[0])
                .fold(f64::INFINITY, f64::min),
            y: corners
                .iter()
                .map(|point| point[1])
                .fold(f64::INFINITY, f64::min),
            z: minimum,
        },
        max: WorldVec3 {
            x: corners
                .iter()
                .map(|point| point[0])
                .fold(f64::NEG_INFINITY, f64::max),
            y: corners
                .iter()
                .map(|point| point[1])
                .fold(f64::NEG_INFINITY, f64::max),
            z: maximum,
        },
    })
}

fn add_mapping(mapping: OrthoGridMapping, column: f64, row: f64) -> [f64; 2] {
    [
        mapping.origin.x + mapping.column_step.x * column + mapping.row_step.x * row,
        mapping.origin.y + mapping.column_step.y * column + mapping.row_step.y * row,
    ]
}

fn levels(width: u32, height: u32) -> Result<Vec<Level>, ProviderContractError> {
    if width == 0 || height == 0 {
        return Err(provider_message("GeoTIFF dimensions must be positive"));
    }
    let mut levels = Vec::new();
    let (mut width, mut height, mut scale) = (width, height, 1_u64);
    loop {
        let index = u16::try_from(levels.len())
            .map_err(|_| provider_message("GeoTIFF pyramid has too many levels"))?;
        let columns = width.div_ceil(TILE_SIZE_U32);
        let rows = height.div_ceil(TILE_SIZE_U32);
        levels.push(Level {
            index,
            width,
            height,
            columns,
            rows,
            scale,
        });
        if columns == 1 && rows == 1 {
            break;
        }
        width = width.div_ceil(2);
        height = height.div_ceil(2);
        scale = scale
            .checked_mul(2)
            .ok_or_else(|| provider_message("GeoTIFF pyramid scale overflow"))?;
    }
    Ok(levels)
}

fn read_elevation_window(
    source: &GeoTiffFile,
    format: u16,
    bits: u16,
    row: usize,
    column: usize,
    rows: usize,
    columns: usize,
) -> Result<Vec<f64>, ProviderContractError> {
    macro_rules! read {
        ($kind:ty, $convert:expr) => {{
            source
                .read_band_window::<$kind>(0, row, column, rows, columns)
                .map_err(provider_error)?
                .iter()
                .copied()
                .map($convert)
                .collect()
        }};
    }
    match (format, bits) {
        (1, 1..=8) => read!(u8, |value| Ok(f64::from(value))),
        (1, 16) => read!(u16, |value| Ok(f64::from(value))),
        (1, 32) => read!(u32, |value| Ok(f64::from(value))),
        (1, 64) => read!(u64, exact_u64_f64),
        (2, 8) => read!(i8, |value| Ok(f64::from(value))),
        (2, 16) => read!(i16, |value| Ok(f64::from(value))),
        (2, 32) => read!(i32, |value| Ok(f64::from(value))),
        (2, 64) => read!(i64, exact_i64_f64),
        (3, 32) => read!(f32, |value| Ok(f64::from(value))),
        (3, 64) => read!(f64, Ok),
        _ => Err(provider_message(
            "GeoTIFF elevation sample type is unsupported",
        )),
    }
}

fn write_height_tile(
    root: &Path,
    level: u16,
    column: u32,
    row: u32,
    values: &[f64],
) -> Result<GeometryResource, ProviderContractError> {
    if values.len() != TILE_SIZE * TILE_SIZE {
        return Err(provider_message("prepared height tile length is invalid"));
    }
    let path = root.join(format!("height/L{level:02}/{column}/{row}.f64"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(provider_error)?;
    }
    let file = File::create(&path).map_err(provider_error)?;
    let mut writer = BufWriter::new(file);
    let mut hasher = sha2::Sha256::new();
    for value in values {
        let bytes = value.to_le_bytes();
        writer.write_all(&bytes).map_err(provider_error)?;
        hasher.update(bytes);
    }
    writer.flush().map_err(provider_error)?;
    writer.get_ref().sync_all().map_err(provider_error)?;
    Ok(GeometryResource {
        object_hash: ObjectHash(hex::encode(hasher.finalize())),
        media_type: HEIGHT_MEDIA_TYPE.to_owned(),
        byte_length: Some(F64_TILE_BYTES),
    })
}

fn read_height_tile(
    root: &Path,
    level: u16,
    column: u32,
    row: u32,
) -> Result<Vec<f64>, ProviderContractError> {
    let path = root.join(format!("height/L{level:02}/{column}/{row}.f64"));
    let bytes = fs::read(path).map_err(provider_error)?;
    if bytes.len() != usize::try_from(F64_TILE_BYTES).unwrap_or(usize::MAX) {
        return Err(provider_message("prepared height tile was truncated"));
    }
    Ok(bytes
        .chunks_exact(8)
        .map(|sample| f64::from_le_bytes(sample.try_into().expect("eight-byte sample")))
        .collect())
}

fn hash_resource(
    path: &Path,
    media_type: &str,
    context: &dyn ProviderOperationContext,
) -> Result<GeometryResource, ProviderContractError> {
    let mut reader = BufReader::new(File::open(path).map_err(provider_error)?);
    let mut hasher = sha2::Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check_cancelled(context)?;
        let read = reader.read(&mut buffer).map_err(provider_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| provider_message("prepared artifact length overflow"))?;
    }
    Ok(GeometryResource {
        object_hash: ObjectHash(hex::encode(hasher.finalize())),
        media_type: media_type.to_owned(),
        byte_length: Some(bytes),
    })
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), ProviderContractError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(provider_error)?;
    }
    let file = File::create(path).map_err(provider_error)?;
    let mut writer = BufWriter::new(file);
    writer.write_all(bytes).map_err(provider_error)?;
    writer.flush().map_err(provider_error)?;
    writer.get_ref().sync_all().map_err(provider_error)
}

fn publish_or_verify(
    staging: &Path,
    destination: &Path,
    artifacts: &[(PathBuf, GeometryResource)],
    context: &dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    if destination.exists() {
        for (relative, expected) in artifacts {
            let observed =
                hash_resource(&destination.join(relative), &expected.media_type, context)?;
            if &observed != expected {
                return Err(provider_message(
                    "existing prepared GeoTIFF hierarchy is not immutable",
                ));
            }
        }
        fs::remove_dir_all(staging).map_err(provider_error)?;
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| provider_message("prepared GeoTIFF destination has no parent"))?;
    fs::create_dir_all(parent).map_err(provider_error)?;
    fs::rename(staging, destination).map_err(provider_error)
}

fn parse_no_data(value: Option<&str>) -> Result<Option<f64>, ProviderContractError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().trim_end_matches('\0');
    if value.eq_ignore_ascii_case("nan") {
        return Ok(Some(f64::NAN));
    }
    value
        .parse::<f64>()
        .map(Some)
        .map_err(|_| provider_message("GeoTIFF NoData is invalid"))
}

#[allow(clippy::float_cmp)]
fn is_no_data(value: f64, sentinel: f64) -> bool {
    sentinel.is_nan() && value.is_nan() || !sentinel.is_nan() && value == sentinel
}

fn exact_u64_f64(value: u64) -> Result<f64, ProviderContractError> {
    const MAX_EXACT_INTEGER: u64 = 1_u64 << f64::MANTISSA_DIGITS;
    if value > MAX_EXACT_INTEGER {
        return Err(provider_message(
            "GeoTIFF integer coordinate or height exceeds exact f64 range",
        ));
    }
    #[allow(clippy::cast_precision_loss)]
    Ok(value as f64)
}

fn exact_i64_f64(value: i64) -> Result<f64, ProviderContractError> {
    const MAX_EXACT_INTEGER: i64 = 1_i64 << f64::MANTISSA_DIGITS;
    if !(-MAX_EXACT_INTEGER..=MAX_EXACT_INTEGER).contains(&value) {
        return Err(provider_message(
            "GeoTIFF integer height exceeds exact f64 range",
        ));
    }
    #[allow(clippy::cast_precision_loss)]
    Ok(value as f64)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn grayscale_byte(normalized: f64) -> u8 {
    debug_assert!((0.0..=1.0).contains(&normalized));
    (1.0 + normalized * 254.0).round() as u8
}

fn tile_ids(level: Level) -> Vec<String> {
    (0..level.rows)
        .flat_map(|row| (0..level.columns).map(move |column| tile_id(level.index, column, row)))
        .collect()
}

fn tile_id(level: u16, column: u32, row: u32) -> String {
    format!("L{level:02}/{column}/{row}")
}

fn empty_resource() -> GeometryResource {
    GeometryResource {
        object_hash: ObjectHash::of_bytes(b"pending preview"),
        media_type: PNG_MEDIA_TYPE.to_owned(),
        byte_length: Some(1),
    }
}

fn report_tile_progress(context: &mut dyn ProviderOperationContext, completed: u64, total: u64) {
    context.report_progress(ProviderProgress {
        phase: "prepareViewer".to_owned(),
        completed,
        total: Some(total),
        message: "GeoTIFF-Höhenpyramide wird kachelweise vorbereitet".to_owned(),
    });
}

fn check_cancelled(context: &dyn ProviderOperationContext) -> Result<(), ProviderContractError> {
    if context.is_cancelled() {
        Err(ProviderContractError::Cancelled)
    } else {
        Ok(())
    }
}

fn provider_error(error: impl std::fmt::Display) -> ProviderContractError {
    ProviderContractError::Provider(error.to_string())
}

fn provider_message(message: impl Into<String>) -> ProviderContractError {
    ProviderContractError::Provider(message.into())
}

struct StagingDirectory {
    path: PathBuf,
    armed: bool,
}

impl StagingDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::entity_model::Vector3;
    use himmelcad_render::{DatasetId, HierarchySource, PreparedHierarchySource};

    #[test]
    fn coarser_levels_keep_average_sample_centres_and_exact_children() {
        let levels = levels(513, 1).expect("levels");
        assert_eq!(levels.len(), 2);
        let mut evidence = BTreeMap::new();
        for level in &levels {
            for row in 0..level.rows {
                for column in 0..level.columns {
                    evidence.insert(
                        (level.index, column, row),
                        TileEvidence {
                            height: GeometryResource {
                                object_hash: ObjectHash::of_bytes(
                                    format!("height-{}-{column}-{row}", level.index).as_bytes(),
                                ),
                                media_type: HEIGHT_MEDIA_TYPE.to_owned(),
                                byte_length: Some(F64_TILE_BYTES),
                            },
                            color: GeometryResource {
                                object_hash: ObjectHash::of_bytes(
                                    format!("color-{}-{column}-{row}", level.index).as_bytes(),
                                ),
                                media_type: PNG_MEDIA_TYPE.to_owned(),
                                byte_length: Some(64),
                            },
                        },
                    );
                }
            }
        }
        let manifest = hierarchy_manifest(
            &levels,
            &evidence,
            OrthoGridMapping {
                origin: Vector3 {
                    x: 100.0,
                    y: 200.0,
                    z: 0.0,
                },
                column_step: Vector3 {
                    x: 2.0,
                    y: 0.0,
                    z: 0.0,
                },
                row_step: Vector3 {
                    x: 0.0,
                    y: -4.0,
                    z: 0.0,
                },
            },
            10.0,
            20.0,
            None,
        )
        .expect("manifest");
        let bytes = manifest.to_validated_json().expect("validated JSON");
        let mut source = PreparedHierarchySource::from_json(
            DatasetId("multilevel-geotiff".to_owned()),
            "hcad://fixture/viewer/manifest.json",
            &bytes,
        )
        .expect("render source");
        let root = source
            .tile(&TileId("L01/0/0".to_owned()))
            .expect("query")
            .expect("root");
        assert_eq!(
            root.children,
            vec![TileId("L00/0/0".to_owned()), TileId("L00/1/0".to_owned())]
        );
        let decoder = root.contents[0]
            .decoder_parameters
            .as_ref()
            .expect("decoder parameters");
        assert_eq!(
            decoder["mapping"]["origin"],
            serde_json::json!([101.0, 198.0])
        );
        assert_eq!(
            decoder["mapping"]["columnStep"],
            serde_json::json!([4.0, 0.0])
        );
        assert_eq!(
            decoder["mapping"]["rowStep"],
            serde_json::json!([0.0, -8.0])
        );
    }
}
