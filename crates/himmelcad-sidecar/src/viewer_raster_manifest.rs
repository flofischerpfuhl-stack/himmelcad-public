//! Atomic bridge from the native elevation pyramid into the shared viewer hierarchy.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::entity_model::{GeometryResource, RasterCellDiagonal};
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_render::{
    BoundingVolume, ContentKind, ContentReference, PreparedHierarchyManifest, RefinementMode,
    TileDescriptor, TileId, WorldAabb, WorldTransform, WorldVec3,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::raster_runtime::{
    RasterBuildSummary, RasterByteOrder, RasterNoDataValue, RasterValidityResource,
    RasterViewTileFormat,
};

const TILE_SIZE: u32 = 512;
const HIERARCHY_MEDIA_TYPE: &str = "himmelcad-prepared-hierarchy@1";
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Explicit topology parameters that are not presentation metadata in a raster summary.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedElevationHierarchyOptions {
    /// Optional maximum source-height difference allowed inside one connected triangle.
    pub maximum_height_jump: Option<f64>,
    /// Stable cell diagonal shared by rendering and exact picking.
    pub diagonal: RasterCellDiagonal,
}

impl Default for PreparedElevationHierarchyOptions {
    fn default() -> Self {
        Self {
            maximum_height_jump: None,
            diagonal: RasterCellDiagonal::TopLeftToBottomRight,
        }
    }
}

/// Immutable hierarchy artifact published below the raster product root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedElevationHierarchyArtifact {
    /// Product-relative manifest path.
    pub relative_path: PathBuf,
    /// Exact bytes, media type and SHA-256 of the manifest.
    pub resource: GeometryResource,
    /// Base-grid validity resource referenced by the prepared Raster root.
    pub validity_resource: RasterValidityResource,
}

/// Invalid pyramid, missing/tampered tile or failed atomic publication.
#[derive(Debug, Error)]
pub enum PreparedElevationHierarchyError {
    /// The summary cannot define one exact prepared elevation hierarchy.
    #[error("invalid elevation hierarchy input: {0}")]
    InvalidInput(&'static str),
    /// Preparation was cooperatively cancelled before publication.
    #[error("elevation hierarchy preparation was cancelled")]
    Cancelled,
    /// A required product file could not be read or atomically published.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The deterministic manifest could not be serialized.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The shared render-core rejected the manifest before publication.
    #[error(transparent)]
    Manifest(#[from] himmelcad_render::PreparedHierarchyError),
}

#[derive(Debug)]
struct TileFiles {
    color_hash: String,
    elevation_length: u64,
    elevation_hash: String,
}

/// Hash-binds every 512x512 preview/depth tile and publishes one viewer hierarchy atomically.
///
/// The native pyramid remains the source artifact. This bridge never decodes a whole raster,
/// changes its grid, or copies tile payloads; it only publishes verified immutable references.
pub fn publish_prepared_elevation_hierarchy(
    product_root: &Path,
    summary: &RasterBuildSummary,
    options: PreparedElevationHierarchyOptions,
    cancellation: &CancellationToken,
) -> Result<PreparedElevationHierarchyArtifact, PreparedElevationHierarchyError> {
    validate_summary(summary, options)?;
    check_cancelled(cancellation)?;

    let validity_resource = publish_base_grid_validity(product_root, summary, cancellation)?;

    let mut levels = summary.levels.iter().collect::<Vec<_>>();
    levels.sort_by_key(|level| level.level);
    let known_levels = levels
        .iter()
        .map(|level| level.level)
        .collect::<BTreeSet<_>>();
    if levels
        .windows(2)
        .any(|pair| pair[1].level != pair[0].level.saturating_add(1))
    {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "pyramid levels must be contiguous",
        ));
    }

    let coarsest = levels
        .last()
        .ok_or(PreparedElevationHierarchyError::InvalidInput(
            "pyramid has no levels",
        ))?;
    let roots = tile_ids(coarsest.level, coarsest.columns, coarsest.rows);
    let mut children = BTreeMap::<String, Vec<String>>::new();
    for level in &levels {
        if !known_levels.contains(&level.level.saturating_add(1)) {
            continue;
        }
        for row in 0..level.rows {
            for column in 0..level.columns {
                children
                    .entry(tile_id(level.level + 1, column / 2, row / 2))
                    .or_default()
                    .push(tile_id(level.level, column, row));
            }
        }
    }
    for child_ids in children.values_mut() {
        child_ids.sort();
    }

    let [minimum_height, maximum_height] = elevation_range(summary)?;
    let no_data = no_data_json(summary.grid.no_data)?;
    let mut tiles = Vec::new();
    for level in levels.iter().rev() {
        let elevation_encoding = elevation_encoding(level)?;
        for row in 0..level.rows {
            for column in 0..level.columns {
                check_cancelled(cancellation)?;
                let id = tile_id(level.level, column, row);
                let files = hash_tile_files(product_root, level.level, column, row, cancellation)?;
                let tile_bounds = tile_bounds(level.bounds, level.gsd, column, row);
                let parent = known_levels
                    .contains(&level.level.saturating_add(1))
                    .then(|| tile_id(level.level + 1, column / 2, row / 2));
                let diagonal = match options.diagonal {
                    RasterCellDiagonal::TopLeftToBottomRight => "topLeftToBottomRight",
                    RasterCellDiagonal::TopRightToBottomLeft => "topRightToBottomLeft",
                };
                let color_uri = format!("../view/preview/L{:02}/{column}/{row}.png", level.level);
                let elevation_uri =
                    format!("../../../height/L{:02}/{column}/{row}.f32", level.level);
                tiles.push(TileDescriptor {
                    id: TileId(id.clone()),
                    parent: parent.map(TileId),
                    children: children
                        .remove(&id)
                        .unwrap_or_default()
                        .into_iter()
                        .map(TileId)
                        .collect(),
                    bounds: BoundingVolume::AxisAlignedBox {
                        bounds: WorldAabb {
                            min: WorldVec3 {
                                x: tile_bounds[0],
                                y: tile_bounds[1],
                                z: minimum_height,
                            },
                            max: WorldVec3 {
                                x: tile_bounds[2],
                                y: tile_bounds[3],
                                z: maximum_height,
                            },
                        },
                    },
                    content_transform: WorldTransform::IDENTITY,
                    geometric_error: level.gsd,
                    refinement: RefinementMode::Replace,
                    contents: vec![ContentReference {
                        kind: ContentKind::Raster,
                        uri: color_uri,
                        byte_offset: None,
                        byte_length: None,
                        primitive_count: Some(u64::from(TILE_SIZE) * u64::from(TILE_SIZE)),
                        content_hash: Some(files.color_hash),
                        decoder_parameters: Some(serde_json::json!({
                            "schemaVersion": 1,
                            "width": TILE_SIZE,
                            "height": TILE_SIZE,
                            "mapping": {
                                "origin": [
                                    tile_bounds[0] + level.gsd * 0.5,
                                    tile_bounds[3] - level.gsd * 0.5,
                                ],
                                "columnStep": [level.gsd, 0.0],
                                "rowStep": [0.0, -level.gsd],
                            },
                            "topology": {
                                "kind": "continuous",
                                "maximumHeightJump": options.maximum_height_jump,
                                "diagonal": diagonal,
                            },
                            "interpolation": "bilinear",
                            "colorEncoding": "encodedImage",
                            "elevationEncoding": elevation_encoding,
                            "noData": no_data,
                            "elevationReference": {
                                "uri": elevation_uri,
                                "byteOffset": null,
                                "byteLength": files.elevation_length,
                                "contentHash": files.elevation_hash,
                            },
                            "validityReference": {
                                "uri": "../../../../validity.bin",
                                "byteOffset": null,
                                "byteLength": validity_resource.byte_length,
                                "contentHash": validity_resource.sha256,
                            },
                            "confidenceReference": null,
                            "triangleMaskReference": null,
                        })),
                    }],
                    child_page: None,
                    prepared_point_metadata: None,
                    provider_metadata: Some(serde_json::json!({
                        "schemaId": "hcad.provider.raster-pyramid-tile@1",
                        "level": level.level,
                        "column": column,
                        "row": row,
                        "gsd": level.gsd,
                    })),
                });
            }
        }
    }
    if !children.is_empty() {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "pyramid parent topology is incomplete",
        ));
    }
    check_cancelled(cancellation)?;
    let bytes = PreparedHierarchyManifest {
        schema_version: 1,
        roots: roots.into_iter().map(TileId).collect(),
        tiles,
    }
    .to_validated_json()?;
    let relative_path = PathBuf::from("viewer/manifest.json");
    let destination = product_root.join(&relative_path);
    publish_bytes_atomically(&destination, &bytes)?;
    Ok(PreparedElevationHierarchyArtifact {
        relative_path,
        resource: GeometryResource {
            object_hash: ObjectHash::of_bytes(&bytes),
            media_type: HIERARCHY_MEDIA_TYPE.to_owned(),
            byte_length: u64::try_from(bytes.len()).ok(),
        },
        validity_resource,
    })
}

fn publish_base_grid_validity(
    product_root: &Path,
    summary: &RasterBuildSummary,
    cancellation: &CancellationToken,
) -> Result<RasterValidityResource, PreparedElevationHierarchyError> {
    let base = summary.levels.iter().find(|level| level.level == 0).ok_or(
        PreparedElevationHierarchyError::InvalidInput("base pyramid level is missing"),
    )?;
    let expected_columns = summary.grid.width_pixels.div_ceil(TILE_SIZE);
    let expected_rows = summary.grid.height_pixels.div_ceil(TILE_SIZE);
    if base.columns != expected_columns || base.rows != expected_rows {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "base pyramid tiles do not cover the exact grid",
        ));
    }
    let byte_order = match base
        .view_layers
        .iter()
        .find(|layer| layer.name == "height")
        .map(|layer| &layer.format)
    {
        Some(RasterViewTileFormat::Float32Raw {
            byte_order,
            width: 512,
            height: 512,
        }) => *byte_order,
        _ => {
            return Err(PreparedElevationHierarchyError::InvalidInput(
                "base height layer must be a 512x512 Float32 tile",
            ));
        }
    };
    let cell_count = u64::from(summary.grid.width_pixels)
        .checked_mul(u64::from(summary.grid.height_pixels))
        .ok_or(PreparedElevationHierarchyError::InvalidInput(
            "validity cell count overflow",
        ))?;
    let byte_length = cell_count.div_ceil(8);
    let relative_path = PathBuf::from("view/validity.bin");
    let destination = product_root.join(&relative_path);
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("validity resource has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(
        ".validity-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| -> Result<(String, u64), PreparedElevationHierarchyError> {
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&staging)?;
        output.set_len(byte_length)?;
        let mut sample_bytes = [0_u8; 4];
        for tile_row in 0..base.rows {
            for tile_column in 0..base.columns {
                check_cancelled(cancellation)?;
                let tile_path =
                    product_root.join(format!("view/height/L00/{tile_column}/{tile_row}.f32"));
                let mut tile = BufReader::with_capacity(COPY_BUFFER_BYTES, File::open(tile_path)?);
                let tile_x = tile_column * TILE_SIZE;
                let tile_y = tile_row * TILE_SIZE;
                let valid_width = TILE_SIZE.min(summary.grid.width_pixels - tile_x);
                let valid_height = TILE_SIZE.min(summary.grid.height_pixels - tile_y);
                for local_y in 0..TILE_SIZE {
                    check_cancelled(cancellation)?;
                    if local_y >= valid_height {
                        break;
                    }
                    let global_y = tile_y + local_y;
                    let start_bit = u64::from(global_y)
                        .checked_mul(u64::from(summary.grid.width_pixels))
                        .and_then(|value| value.checked_add(u64::from(tile_x)))
                        .ok_or(PreparedElevationHierarchyError::InvalidInput(
                            "validity bit offset overflow",
                        ))?;
                    let leading_bits = usize::try_from(start_bit % 8).map_err(|_| {
                        PreparedElevationHierarchyError::InvalidInput(
                            "validity bit offset exceeds usize",
                        )
                    })?;
                    let segment_length = (leading_bits
                        + usize::try_from(valid_width).map_err(|_| {
                            PreparedElevationHierarchyError::InvalidInput(
                                "validity row width exceeds usize",
                            )
                        })?)
                    .div_ceil(8);
                    let byte_offset = start_bit / 8;
                    let mut segment = vec![0_u8; segment_length];
                    output.seek(SeekFrom::Start(byte_offset))?;
                    output.read_exact(&mut segment)?;
                    for local_x in 0..TILE_SIZE {
                        tile.read_exact(&mut sample_bytes)?;
                        if local_x >= valid_width {
                            continue;
                        }
                        let value = match byte_order {
                            RasterByteOrder::LittleEndian => f32::from_le_bytes(sample_bytes),
                            RasterByteOrder::BigEndian => f32::from_be_bytes(sample_bytes),
                        };
                        let valid = value.is_finite()
                            && match summary.grid.no_data {
                                // Numeric sentinels such as -9999.0 compare exactly after the
                                // source value is represented in the tile's Float32 encoding.
                                RasterNoDataValue::Numeric(no_data) => {
                                    value.to_bits() != (no_data as f32).to_bits()
                                }
                                RasterNoDataValue::Nan => true,
                                RasterNoDataValue::AlphaMask => false,
                            };
                        if valid {
                            let bit = leading_bits
                                + usize::try_from(local_x).map_err(|_| {
                                    PreparedElevationHierarchyError::InvalidInput(
                                        "validity column exceeds usize",
                                    )
                                })?;
                            segment[bit / 8] |= 1 << (bit % 8);
                        }
                    }
                    output.seek(SeekFrom::Start(byte_offset))?;
                    output.write_all(&segment)?;
                }
            }
        }
        output.flush()?;
        output.sync_all()?;
        drop(output);
        hash_file(&staging, cancellation)
    })();
    let (sha256, actual_length) = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
    };
    if actual_length != byte_length {
        let _ = fs::remove_file(&staging);
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "validity byte length does not match the grid",
        ));
    }
    if destination.exists() {
        let existing = match hash_file(&destination, cancellation) {
            Ok(existing) => existing,
            Err(error) => {
                let _ = fs::remove_file(&staging);
                return Err(error);
            }
        };
        let _ = fs::remove_file(&staging);
        if existing != (sha256.clone(), byte_length) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "validity resource already exists with different bytes",
            )
            .into());
        }
    } else if let Err(error) = fs::rename(&staging, &destination) {
        let _ = fs::remove_file(&staging);
        return Err(error.into());
    }
    Ok(RasterValidityResource {
        path: normalized_relative_path(&relative_path)?,
        sha256: ObjectHash(sha256),
        byte_length,
    })
}

fn normalized_relative_path(path: &Path) -> Result<String, PreparedElevationHierarchyError> {
    path.to_str().map(|value| value.replace('\\', "/")).ok_or(
        PreparedElevationHierarchyError::InvalidInput("validity path is not valid UTF-8"),
    )
}

fn validate_summary(
    summary: &RasterBuildSummary,
    options: PreparedElevationHierarchyOptions,
) -> Result<(), PreparedElevationHierarchyError> {
    no_data_json(summary.grid.no_data)?;
    if matches!(
        summary.grid.no_data,
        RasterNoDataValue::Numeric(value) if !(value as f32).is_finite()
    ) {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "numeric NoData is not representable as finite Float32",
        ));
    }
    if summary.levels.is_empty()
        || summary.grid.width_pixels == 0
        || summary.grid.height_pixels == 0
        || !summary.grid.gsd.is_finite()
        || summary.grid.gsd <= 0.0
        || options
            .maximum_height_jump
            .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "grid or topology is invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    for level in &summary.levels {
        if !ids.insert(level.level)
            || level.columns == 0
            || level.rows == 0
            || level.tile_count != u64::from(level.columns) * u64::from(level.rows)
            || !level.gsd.is_finite()
            || level.gsd <= 0.0
        {
            return Err(PreparedElevationHierarchyError::InvalidInput(
                "pyramid level is invalid",
            ));
        }
        elevation_encoding(level)?;
    }
    Ok(())
}

fn elevation_range(
    summary: &RasterBuildSummary,
) -> Result<[f64; 2], PreparedElevationHierarchyError> {
    let range = summary.levels.iter().find_map(|level| {
        level
            .view_layers
            .iter()
            .find_map(|layer| match layer.format {
                RasterViewTileFormat::GrayscalePng {
                    minimum_elevation,
                    maximum_elevation,
                } => Some([minimum_elevation, maximum_elevation]),
                _ => None,
            })
    });
    match range {
        Some([minimum, maximum])
            if minimum.is_finite() && maximum.is_finite() && minimum < maximum =>
        {
            Ok([minimum, maximum])
        }
        _ => Err(PreparedElevationHierarchyError::InvalidInput(
            "elevation view range is missing or invalid",
        )),
    }
}

fn elevation_encoding(
    level: &crate::raster_runtime::RasterLevelSummary,
) -> Result<serde_json::Value, PreparedElevationHierarchyError> {
    let format = level
        .view_layers
        .iter()
        .find(|layer| layer.name == "height")
        .map(|layer| &layer.format)
        .ok_or(PreparedElevationHierarchyError::InvalidInput(
            "height layer is missing",
        ))?;
    match format {
        RasterViewTileFormat::Float32Raw {
            byte_order: RasterByteOrder::LittleEndian,
            width: 512,
            height: 512,
        } => Ok(serde_json::json!({ "kind": "float32LittleEndian" })),
        RasterViewTileFormat::Float32Raw {
            byte_order: RasterByteOrder::BigEndian,
            width: 512,
            height: 512,
        } => Ok(serde_json::json!({ "kind": "float32BigEndian" })),
        _ => Err(PreparedElevationHierarchyError::InvalidInput(
            "height layer must be a 512x512 Float32 tile",
        )),
    }
}

fn no_data_json(
    value: RasterNoDataValue,
) -> Result<serde_json::Value, PreparedElevationHierarchyError> {
    match value {
        RasterNoDataValue::Numeric(value) if value.is_finite() => {
            Ok(serde_json::json!({ "kind": "numeric", "value": value }))
        }
        RasterNoDataValue::Nan => Ok(serde_json::json!({ "kind": "nan" })),
        RasterNoDataValue::Numeric(_) | RasterNoDataValue::AlphaMask => {
            Err(PreparedElevationHierarchyError::InvalidInput(
                "elevation NoData requires a finite numeric sentinel or NaN",
            ))
        }
    }
}

fn hash_tile_files(
    root: &Path,
    level: u16,
    column: u32,
    row: u32,
    cancellation: &CancellationToken,
) -> Result<TileFiles, PreparedElevationHierarchyError> {
    let color = root.join(format!("view/preview/L{level:02}/{column}/{row}.png"));
    let elevation = root.join(format!("view/height/L{level:02}/{column}/{row}.f32"));
    let (color_hash, _) = hash_file(&color, cancellation)?;
    let (elevation_hash, elevation_length) = hash_file(&elevation, cancellation)?;
    let expected = u64::from(TILE_SIZE) * u64::from(TILE_SIZE) * 4;
    if elevation_length != expected {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "height tile byte length is not 512x512 Float32",
        ));
    }
    Ok(TileFiles {
        color_hash,
        elevation_length,
        elevation_hash,
    })
}

fn hash_file(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(String, u64), PreparedElevationHierarchyError> {
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut length = 0_u64;
    loop {
        check_cancelled(cancellation)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        length = length.checked_add(read as u64).ok_or(
            PreparedElevationHierarchyError::InvalidInput("tile byte length overflow"),
        )?;
    }
    if length == 0 {
        return Err(PreparedElevationHierarchyError::InvalidInput(
            "prepared tile is empty",
        ));
    }
    Ok((hex::encode(hasher.finalize()), length))
}

fn publish_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("manifest has no parent directory"))?;
    fs::create_dir_all(parent)?;
    if path.exists() {
        let existing = fs::read(path)?;
        if existing == bytes {
            return Ok(());
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "prepared hierarchy already exists with different bytes",
        ));
    }
    let staging = parent.join(format!(
        ".manifest-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)?;
    let mut writer = BufWriter::new(output);
    if let Err(error) = (|| {
        writer.write_all(bytes)?;
        writer.flush()?;
        writer.get_ref().sync_all()
    })() {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, path) {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }
    Ok(())
}

fn check_cancelled(
    cancellation: &CancellationToken,
) -> Result<(), PreparedElevationHierarchyError> {
    if cancellation.is_cancel_requested() {
        Err(PreparedElevationHierarchyError::Cancelled)
    } else {
        Ok(())
    }
}

fn tile_ids(level: u16, columns: u32, rows: u32) -> Vec<String> {
    (0..rows)
        .flat_map(|row| (0..columns).map(move |column| tile_id(level, column, row)))
        .collect()
}

fn tile_id(level: u16, column: u32, row: u32) -> String {
    format!("L{level:02}/{column}/{row}")
}

#[allow(clippy::cast_precision_loss)]
fn tile_bounds(
    bounds: crate::raster_runtime::RasterBounds,
    resolution: f64,
    column: u32,
    row: u32,
) -> [f64; 4] {
    let span = f64::from(TILE_SIZE) * resolution;
    let minimum_east = bounds.minimum_east + f64::from(column) * span;
    let maximum_north = bounds.maximum_north - f64::from(row) * span;
    [
        minimum_east,
        maximum_north - span,
        minimum_east + span,
        maximum_north,
    ]
}

#[cfg(test)]
mod tests {
    use std::fs;

    use himmelcad_render::{DatasetId, HierarchySource, PreparedHierarchySource, TileId};

    use super::{publish_prepared_elevation_hierarchy, PreparedElevationHierarchyOptions};
    use crate::raster_runtime::{
        GdalAudit, RasterBounds, RasterBuildSummary, RasterByteOrder, RasterCrs, RasterGrid,
        RasterLevelSummary, RasterNoDataValue, RasterViewLayer, RasterViewTileFormat,
    };
    use himmelcad_core::hash::ObjectHash;
    use himmelcad_core::photolab_jobs::CancellationToken;

    fn fixture_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hcad-prepared-raster-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("view/preview/L00/0")).expect("preview root");
        fs::create_dir_all(root.join("view/height/L00/0")).expect("height root");
        let image = image::RgbaImage::from_pixel(512, 512, image::Rgba([30, 90, 170, 255]));
        image
            .save(root.join("view/preview/L00/0/0.png"))
            .expect("preview");
        fs::write(
            root.join("view/height/L00/0/0.f32"),
            vec![0_u8; 512 * 512 * 4],
        )
        .expect("height");
        root
    }

    fn summary(root: &std::path::Path) -> RasterBuildSummary {
        let bounds = RasterBounds {
            minimum_east: 1_000.0,
            minimum_north: 2_000.0,
            maximum_east: 1_512.0,
            maximum_north: 2_512.0,
        };
        RasterBuildSummary {
            output_directory: root.to_string_lossy().into_owned(),
            cog_path: "product.cog.tif".into(),
            pyramid_manifest_path: "pyramid/manifest.json".into(),
            levels: vec![RasterLevelSummary {
                level: 0,
                columns: 1,
                rows: 1,
                tile_count: 1,
                bounds,
                gsd: 1.0,
                relative_directory: "pyramid/L00".into(),
                metric_tile_url_template: "pyramid/L00/{x}/{y}.tif".into(),
                view_layers: vec![
                    RasterViewLayer {
                        name: "height".into(),
                        format: RasterViewTileFormat::Float32Raw {
                            byte_order: RasterByteOrder::LittleEndian,
                            width: 512,
                            height: 512,
                        },
                        url_template: "view/height/L00/{x}/{y}.f32".into(),
                    },
                    RasterViewLayer {
                        name: "preview".into(),
                        format: RasterViewTileFormat::GrayscalePng {
                            minimum_elevation: 450.0,
                            maximum_elevation: 510.0,
                        },
                        url_template: "view/preview/L00/{x}/{y}.png".into(),
                    },
                ],
            }],
            crs: RasterCrs {
                horizontal: "EPSG:25832".into(),
                vertical: None,
                gdal_srs: "EPSG:25832".into(),
                canonical_wkt_sha256: ObjectHash::of_bytes(b"wkt"),
            },
            grid: RasterGrid {
                bounds,
                width_pixels: 512,
                height_pixels: 512,
                gsd: 1.0,
                no_data: RasterNoDataValue::Numeric(-9999.0),
            },
            audit: GdalAudit {
                version: "fixture".into(),
                executable_sha256: Default::default(),
                raster_drivers: vec![],
                vector_drivers: vec![],
                network_enabled: false,
            },
        }
    }

    fn write_small_height_tile(root: &std::path::Path, byte_order: RasterByteOrder) {
        let mut values = vec![0.0_f32; 512 * 512];
        values[0] = 1.0;
        values[1] = f32::NAN;
        values[2] = -9999.0;
        values[512] = 2.0;
        values[513] = 3.0;
        values[514] = 4.0;
        let bytes = values
            .into_iter()
            .flat_map(|value| match byte_order {
                RasterByteOrder::LittleEndian => value.to_le_bytes(),
                RasterByteOrder::BigEndian => value.to_be_bytes(),
            })
            .collect::<Vec<_>>();
        fs::write(root.join("view/height/L00/0/0.f32"), bytes).expect("height");
    }

    #[test]
    fn publishes_hash_bound_viewer_hierarchy_accepted_by_render_core() {
        let root = fixture_root();
        let artifact = publish_prepared_elevation_hierarchy(
            &root,
            &summary(&root),
            PreparedElevationHierarchyOptions::default(),
            &CancellationToken::new(),
        )
        .expect("prepared hierarchy");
        let bytes = fs::read(root.join(&artifact.relative_path)).expect("manifest");
        assert_eq!(artifact.resource.object_hash, ObjectHash::of_bytes(&bytes));
        let mut source = PreparedHierarchySource::from_json(
            DatasetId("geotiff-fixture".into()),
            "file:///fixture/viewer/manifest.json",
            &bytes,
        )
        .expect("render hierarchy");
        let tile = source
            .tile(&TileId("L00/0/0".into()))
            .expect("tile query")
            .expect("root tile");
        assert_eq!(tile.contents.len(), 1);
        assert_eq!(tile.contents[0].kind, himmelcad_render::ContentKind::Raster);
        assert_eq!(tile.contents[0].primitive_count, Some(512 * 512));
        let parameters = tile.contents[0]
            .decoder_parameters
            .as_ref()
            .expect("decoder parameters");
        assert_eq!(
            parameters["mapping"]["origin"],
            serde_json::json!([1000.5, 2511.5])
        );
        assert_eq!(
            parameters["elevationReference"]["byteLength"],
            512 * 512 * 4
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn base_grid_validity_is_lsb_first_and_byte_order_independent() {
        for byte_order in [RasterByteOrder::LittleEndian, RasterByteOrder::BigEndian] {
            let root = fixture_root();
            write_small_height_tile(&root, byte_order);
            let mut summary = summary(&root);
            summary.grid.width_pixels = 3;
            summary.grid.height_pixels = 2;
            summary.grid.bounds.maximum_east = summary.grid.bounds.minimum_east + 3.0;
            summary.grid.bounds.maximum_north = summary.grid.bounds.minimum_north + 2.0;
            summary.levels[0].bounds = summary.grid.bounds;
            let RasterViewTileFormat::Float32Raw {
                byte_order: format_byte_order,
                ..
            } = &mut summary.levels[0].view_layers[0].format
            else {
                panic!("height fixture must be Float32");
            };
            *format_byte_order = byte_order;

            let artifact = publish_prepared_elevation_hierarchy(
                &root,
                &summary,
                PreparedElevationHierarchyOptions::default(),
                &CancellationToken::new(),
            )
            .expect("prepared hierarchy");
            let validity = fs::read(root.join("view/validity.bin")).expect("validity bitset");
            assert_eq!(validity, [0b0011_1001]);
            assert_eq!(artifact.validity_resource.path, "view/validity.bin");
            assert_eq!(artifact.validity_resource.byte_length, 1);
            assert_eq!(
                artifact.validity_resource.sha256,
                ObjectHash::of_bytes(&validity)
            );

            let manifest: serde_json::Value = serde_json::from_slice(
                &fs::read(root.join(&artifact.relative_path)).expect("viewer manifest"),
            )
            .expect("viewer manifest JSON");
            let reference =
                &manifest["tiles"][0]["contents"][0]["decoderParameters"]["validityReference"];
            assert_eq!(reference["uri"], "../../../../validity.bin");
            assert!(reference["byteOffset"].is_null());
            assert_eq!(reference["byteLength"], 1);
            assert_eq!(
                reference["contentHash"],
                artifact.validity_resource.sha256.as_str()
            );
            assert_eq!(
                manifest["tiles"][0]["contents"][0]["decoderParameters"]["interpolation"],
                "bilinear"
            );
            fs::remove_dir_all(root).expect("cleanup");
        }
    }

    #[test]
    fn cancellation_and_tampered_height_length_never_publish() {
        let root = fixture_root();
        fs::write(root.join("view/height/L00/0/0.f32"), [0_u8; 4]).expect("tamper");
        assert!(publish_prepared_elevation_hierarchy(
            &root,
            &summary(&root),
            PreparedElevationHierarchyOptions::default(),
            &CancellationToken::new(),
        )
        .is_err());
        assert!(!root.join("viewer/manifest.json").exists());

        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        assert!(publish_prepared_elevation_hierarchy(
            &root,
            &summary(&root),
            PreparedElevationHierarchyOptions::default(),
            &cancellation,
        )
        .is_err());
        assert!(!root.join("viewer/manifest.json").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }
}
