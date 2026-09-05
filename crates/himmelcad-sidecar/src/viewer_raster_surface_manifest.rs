//! Bounded preparation of an orthomosaic colour pyramid over an independent DEM pyramid.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_render::{
    BoundingVolume, ContentKind, ContentReference, PreparedHierarchyManifest, RefinementMode,
    TileDescriptor, TileId, WorldAabb, WorldTransform, WorldVec3,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::raster_runtime::{
    OrthomosaicElevationSupport, RasterBounds, RasterBuildSummary, RasterByteOrder,
    RasterLevelSummary, RasterNoDataValue, RasterViewTileFormat,
};

const TILE_SIZE: u32 = 512;
const MAX_SUPPORT_CELLS: u32 = 512;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Invalid source pyramids, missing payloads or failed atomic publication.
#[derive(Debug, Error)]
pub enum PreparedRasterSurfaceHierarchyError {
    /// The two summaries cannot define one exact surface-drape hierarchy.
    #[error("invalid prepared raster surface input: {0}")]
    InvalidInput(String),
    /// Preparation was cooperatively cancelled before publication.
    #[error("prepared raster surface hierarchy was cancelled")]
    Cancelled,
    /// A required payload could not be read or published.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The deterministic manifest could not be serialized.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The shared render core rejected the hierarchy before publication.
    #[error(transparent)]
    Manifest(#[from] himmelcad_render::PreparedHierarchyError),
}

#[derive(Debug)]
struct PreparedSupportTile {
    bytes: Vec<u8>,
    minimum_height: Option<f64>,
    maximum_height: Option<f64>,
    width: u32,
    height: u32,
    mapping: SupportMapping,
}

#[derive(Debug, Clone, Copy)]
struct SupportMapping {
    origin: [f64; 2],
    column_step: [f64; 2],
    row_step: [f64; 2],
}

/// Samples bounded support grids and atomically publishes a schema-v2 viewer hierarchy.
///
/// Colour pages remain at their native pyramid resolution. Each output tile reads only the
/// handful of DEM pages intersecting its footprint and emits at most 513-by-513 support
/// vertices. Adjacent tiles evaluate the exact same world-coordinate boundary.
#[allow(clippy::too_many_lines)]
pub fn publish_prepared_raster_surface_hierarchy(
    product_root: &Path,
    color_summary: &RasterBuildSummary,
    support: &OrthomosaicElevationSupport,
    cancellation: &CancellationToken,
) -> Result<(), PreparedRasterSurfaceHierarchyError> {
    validate_inputs(color_summary, support)?;
    check_cancelled(cancellation)?;

    let dem_root = PathBuf::from(&support.dataset_root);
    let mut color_levels = sorted_levels(color_summary)?;
    let dem_levels = sorted_levels(&support.summary)?;
    let global_range = elevation_range(&support.summary)?;
    let known_levels = color_levels
        .iter()
        .map(|level| level.level)
        .collect::<BTreeSet<_>>();
    let coarsest = color_levels
        .last()
        .ok_or_else(|| invalid("colour pyramid is empty"))?;
    let roots = tile_ids(coarsest.level, coarsest.columns, coarsest.rows);
    let mut children = hierarchy_children(&color_levels);
    let mut tiles = Vec::new();

    color_levels.reverse();
    for color_level in color_levels {
        let dem_level = select_dem_level(color_level, &dem_levels)?;
        for row in 0..color_level.rows {
            for column in 0..color_level.columns {
                check_cancelled(cancellation)?;
                let bounds = exact_tile_bounds(color_level.bounds, color_level.gsd, column, row);
                let prepared = prepare_support_tile(
                    &dem_root,
                    &support.summary,
                    dem_level,
                    bounds,
                    cancellation,
                )?;
                let support_relative = PathBuf::from(format!(
                    "view/surface/L{:02}/{column}/{row}.f32",
                    color_level.level
                ));
                write_bytes_atomically(&product_root.join(&support_relative), &prepared.bytes)?;
                let (support_hash, support_length) =
                    hash_file(&product_root.join(&support_relative), cancellation)?;
                let color_relative = PathBuf::from(format!(
                    "view/rgba/L{:02}/{column}/{row}.png",
                    color_level.level
                ));
                let (color_hash, _) = hash_file(&product_root.join(&color_relative), cancellation)?;
                let minimum_height = prepared.minimum_height.unwrap_or(global_range[0]);
                let maximum_height = prepared.maximum_height.unwrap_or(global_range[1]);
                let id = tile_id(color_level.level, column, row);
                let parent = known_levels
                    .contains(&color_level.level.saturating_add(1))
                    .then(|| tile_id(color_level.level + 1, column / 2, row / 2));
                let primitive_count = u64::from(prepared.width - 1)
                    .saturating_mul(u64::from(prepared.height - 1))
                    .saturating_mul(2);
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
                                x: bounds.minimum_east,
                                y: bounds.minimum_north,
                                z: minimum_height,
                            },
                            max: WorldVec3 {
                                x: bounds.maximum_east,
                                y: bounds.maximum_north,
                                z: maximum_height,
                            },
                        },
                    },
                    content_transform: WorldTransform::IDENTITY,
                    geometric_error: dem_level.gsd.max(color_level.gsd),
                    refinement: RefinementMode::Replace,
                    contents: vec![ContentReference {
                        kind: ContentKind::Raster,
                        uri: format!("../view/rgba/L{:02}/{column}/{row}.png", color_level.level),
                        byte_offset: None,
                        byte_length: None,
                        primitive_count: Some(primitive_count),
                        content_hash: Some(color_hash),
                        decoder_parameters: Some(serde_json::json!({
                            "schemaVersion": 2,
                            "width": TILE_SIZE,
                            "height": TILE_SIZE,
                            "mapping": {
                                "origin": [
                                    bounds.minimum_east + color_level.gsd * 0.5,
                                    bounds.maximum_north - color_level.gsd * 0.5,
                                ],
                                "columnStep": [color_level.gsd, 0.0],
                                "rowStep": [0.0, -color_level.gsd],
                            },
                            "surface": {
                                "width": prepared.width,
                                "height": prepared.height,
                                "mapping": {
                                    "origin": prepared.mapping.origin,
                                    "columnStep": prepared.mapping.column_step,
                                    "rowStep": prepared.mapping.row_step,
                                },
                                "sourceSurface": support.source_surface,
                                "derivation": support.derivation,
                            },
                            "topology": {
                                "kind": "continuous",
                                "maximumHeightJump": null,
                                "diagonal": "topLeftToBottomRight",
                            },
                            "colorEncoding": "encodedImage",
                            "elevationEncoding": { "kind": "float32LittleEndian" },
                            "noData": { "kind": "nan" },
                            "elevationReference": {
                                "uri": format!(
                                    "../../../surface/L{:02}/{column}/{row}.f32",
                                    color_level.level
                                ),
                                "byteOffset": null,
                                "byteLength": support_length,
                                "contentHash": support_hash,
                            },
                            "validityReference": null,
                            "confidenceReference": null,
                            "triangleMaskReference": null,
                        })),
                    }],
                    child_page: None,
                    prepared_point_metadata: None,
                    provider_metadata: Some(serde_json::json!({
                        "schemaId": "hcad.provider.raster-surface-tile@1",
                        "level": color_level.level,
                        "column": column,
                        "row": row,
                        "colorGsd": color_level.gsd,
                        "supportSourceLevel": dem_level.level,
                        "supportSourceGsd": dem_level.gsd,
                    })),
                });
            }
        }
    }
    if !children.is_empty() {
        return Err(invalid("colour pyramid parent topology is incomplete"));
    }
    check_cancelled(cancellation)?;
    let bytes = PreparedHierarchyManifest {
        schema_version: 1,
        roots: roots.into_iter().map(TileId).collect(),
        tiles,
    }
    .to_validated_json()?;
    write_bytes_atomically(&product_root.join("viewer/manifest.json"), &bytes)?;
    Ok(())
}

fn validate_inputs(
    color: &RasterBuildSummary,
    support: &OrthomosaicElevationSupport,
) -> Result<(), PreparedRasterSurfaceHierarchyError> {
    if color.crs != support.summary.crs {
        return Err(invalid("colour and DEM CRS contracts differ"));
    }
    if !matches!(color.grid.no_data, RasterNoDataValue::AlphaMask) {
        return Err(invalid(
            "surface colour pyramid requires alpha-mask no-data",
        ));
    }
    if matches!(support.summary.grid.no_data, RasterNoDataValue::AlphaMask) {
        return Err(invalid("DEM support requires scalar no-data"));
    }
    if support.source_surface.id.0.trim().is_empty()
        || support.derivation.resource_id.trim().is_empty()
        || support.derivation.schema_id != "hcad.derivation.raster-surface-drape@1"
    {
        return Err(invalid("surface authority is incomplete"));
    }
    if !Path::new(&support.dataset_root).is_absolute() {
        return Err(invalid("DEM dataset root must be absolute"));
    }
    Ok(())
}

fn sorted_levels(
    summary: &RasterBuildSummary,
) -> Result<Vec<&RasterLevelSummary>, PreparedRasterSurfaceHierarchyError> {
    let mut levels = summary.levels.iter().collect::<Vec<_>>();
    levels.sort_by_key(|level| level.level);
    if levels.is_empty()
        || levels
            .windows(2)
            .any(|pair| pair[1].level != pair[0].level.saturating_add(1))
        || levels.iter().any(|level| {
            level.columns == 0 || level.rows == 0 || !level.gsd.is_finite() || level.gsd <= 0.0
        })
    {
        return Err(invalid("pyramid levels are empty, sparse or invalid"));
    }
    Ok(levels)
}

fn select_dem_level<'a>(
    color: &RasterLevelSummary,
    levels: &'a [&RasterLevelSummary],
) -> Result<&'a RasterLevelSummary, PreparedRasterSurfaceHierarchyError> {
    let span = f64::from(TILE_SIZE) * color.gsd;
    levels
        .iter()
        .copied()
        .find(|level| span / level.gsd <= f64::from(MAX_SUPPORT_CELLS))
        .or_else(|| levels.last().copied())
        .ok_or_else(|| invalid("DEM pyramid is empty"))
}

fn prepare_support_tile(
    dem_root: &Path,
    summary: &RasterBuildSummary,
    level: &RasterLevelSummary,
    bounds: RasterBounds,
    cancellation: &CancellationToken,
) -> Result<PreparedSupportTile, PreparedRasterSurfaceHierarchyError> {
    let span_x = bounds.maximum_east - bounds.minimum_east;
    let span_y = bounds.maximum_north - bounds.minimum_north;
    let cells_x = support_cell_count(span_x, level.gsd);
    let cells_y = support_cell_count(span_y, level.gsd);
    let width = cells_x + 1;
    let height = cells_y + 1;
    let step_x = span_x / f64::from(cells_x);
    let step_y = span_y / f64::from(cells_y);
    let mapping = SupportMapping {
        origin: [bounds.minimum_east, bounds.maximum_north],
        column_step: [step_x, 0.0],
        row_step: [0.0, -step_y],
    };
    let mut sampler = DemSampler::new(dem_root, summary, level)?;
    let capacity = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|samples| samples.checked_mul(4))
        .ok_or_else(|| invalid("support tile allocation overflow"))?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    for row in 0..height {
        check_cancelled(cancellation)?;
        let y = if row == cells_y {
            bounds.minimum_north
        } else {
            bounds.maximum_north - f64::from(row) * step_y
        };
        for column in 0..width {
            let x = if column == cells_x {
                bounds.maximum_east
            } else {
                bounds.minimum_east + f64::from(column) * step_x
            };
            let value = sampler.sample(x, y)?;
            if value.is_finite() {
                minimum = minimum.min(f64::from(value));
                maximum = maximum.max(f64::from(value));
            }
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(PreparedSupportTile {
        bytes,
        minimum_height: minimum.is_finite().then_some(minimum),
        maximum_height: maximum.is_finite().then_some(maximum),
        width,
        height,
        mapping,
    })
}

fn support_cell_count(span: f64, source_gsd: f64) -> u32 {
    let ratio = (span / source_gsd).floor();
    if ratio < 1.0 {
        1
    } else {
        // INVARIANT: level selection bounds the finite positive ratio to 512.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let cells = ratio as u32;
        cells.min(MAX_SUPPORT_CELLS)
    }
}

struct DemSampler<'a> {
    root: &'a Path,
    summary: &'a RasterBuildSummary,
    level: &'a RasterLevelSummary,
    byte_order: RasterByteOrder,
    cache: BTreeMap<(u32, u32), Vec<f32>>,
}

impl<'a> DemSampler<'a> {
    fn new(
        root: &'a Path,
        summary: &'a RasterBuildSummary,
        level: &'a RasterLevelSummary,
    ) -> Result<Self, PreparedRasterSurfaceHierarchyError> {
        let byte_order = level
            .view_layers
            .iter()
            .find_map(|layer| match (&*layer.name, &layer.format) {
                (
                    "height",
                    RasterViewTileFormat::Float32Raw {
                        byte_order,
                        width: 512,
                        height: 512,
                    },
                ) => Some(*byte_order),
                _ => None,
            })
            .ok_or_else(|| invalid("DEM level has no 512x512 Float32 height layer"))?;
        Ok(Self {
            root,
            summary,
            level,
            byte_order,
            cache: BTreeMap::new(),
        })
    }

    fn sample(&mut self, x: f64, y: f64) -> Result<f32, PreparedRasterSurfaceHierarchyError> {
        let bounds = self.level.bounds;
        let tolerance = self.level.gsd.max(1.0) * 1.0e-10;
        if x < bounds.minimum_east - tolerance
            || x > bounds.maximum_east + tolerance
            || y < bounds.minimum_north - tolerance
            || y > bounds.maximum_north + tolerance
        {
            return Ok(f32::NAN);
        }
        let sample_column_count = u64::from(self.level.columns) * u64::from(TILE_SIZE);
        let sample_row_count = u64::from(self.level.rows) * u64::from(TILE_SIZE);
        #[allow(clippy::cast_precision_loss)]
        let fractional_column = ((x - bounds.minimum_east) / self.level.gsd - 0.5)
            .clamp(0.0, (sample_column_count - 1) as f64);
        #[allow(clippy::cast_precision_loss)]
        let fractional_row = ((bounds.maximum_north - y) / self.level.gsd - 0.5)
            .clamp(0.0, (sample_row_count - 1) as f64);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let west_column = fractional_column.floor() as u64;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let north_row = fractional_row.floor() as u64;
        let east_column = (west_column + 1).min(sample_column_count - 1);
        let south_row = (north_row + 1).min(sample_row_count - 1);
        #[allow(clippy::cast_precision_loss)]
        let column_weight = fractional_column - west_column as f64;
        #[allow(clippy::cast_precision_loss)]
        let row_weight = fractional_row - north_row as f64;
        let contributors = [
            (
                west_column,
                north_row,
                (1.0 - column_weight) * (1.0 - row_weight),
            ),
            (east_column, north_row, column_weight * (1.0 - row_weight)),
            (west_column, south_row, (1.0 - column_weight) * row_weight),
            (east_column, south_row, column_weight * row_weight),
        ];
        let mut result = 0.0_f64;
        for (column, row, weight) in contributors {
            if weight == 0.0 {
                continue;
            }
            let value = self.value(column, row)?;
            if self.is_no_data(value) {
                return Ok(f32::NAN);
            }
            result += f64::from(value) * weight;
        }
        #[allow(clippy::cast_possible_truncation)]
        let result = result as f32;
        Ok(result)
    }

    fn value(&mut self, column: u64, row: u64) -> Result<f32, PreparedRasterSurfaceHierarchyError> {
        let tile_column = u32::try_from(column / u64::from(TILE_SIZE))
            .map_err(|_| invalid("DEM tile column overflow"))?;
        let tile_row = u32::try_from(row / u64::from(TILE_SIZE))
            .map_err(|_| invalid("DEM tile row overflow"))?;
        let local_column = usize::try_from(column % u64::from(TILE_SIZE))
            .map_err(|_| invalid("DEM local column overflow"))?;
        let local_row = usize::try_from(row % u64::from(TILE_SIZE))
            .map_err(|_| invalid("DEM local row overflow"))?;
        if !self.cache.contains_key(&(tile_column, tile_row)) {
            let path = self.root.join(format!(
                "view/height/L{:02}/{tile_column}/{tile_row}.f32",
                self.level.level
            ));
            let mut bytes = fs::read(path)?;
            let expected = usize::try_from(TILE_SIZE)
                .unwrap_or(512)
                .saturating_mul(usize::try_from(TILE_SIZE).unwrap_or(512))
                .saturating_mul(4);
            if bytes.len() != expected {
                return Err(invalid(
                    "DEM height tile byte length is not 512x512 Float32",
                ));
            }
            let values = bytes
                .chunks_exact_mut(4)
                .map(|chunk| {
                    let encoded = [chunk[0], chunk[1], chunk[2], chunk[3]];
                    match self.byte_order {
                        RasterByteOrder::LittleEndian => f32::from_le_bytes(encoded),
                        RasterByteOrder::BigEndian => f32::from_be_bytes(encoded),
                    }
                })
                .collect::<Vec<_>>();
            self.cache.insert((tile_column, tile_row), values);
        }
        let index = local_row
            .checked_mul(usize::try_from(TILE_SIZE).unwrap_or(512))
            .and_then(|offset| offset.checked_add(local_column))
            .ok_or_else(|| invalid("DEM sample index overflow"))?;
        self.cache
            .get(&(tile_column, tile_row))
            .and_then(|values| values.get(index))
            .copied()
            .ok_or_else(|| invalid("DEM sample index is outside its tile"))
    }

    fn is_no_data(&self, value: f32) -> bool {
        !value.is_finite()
            || match self.summary.grid.no_data {
                RasterNoDataValue::Numeric(no_data) => {
                    f64::from(value).to_bits() == no_data.to_bits()
                }
                RasterNoDataValue::Nan => value.is_nan(),
                RasterNoDataValue::AlphaMask => true,
            }
    }
}

fn hierarchy_children(levels: &[&RasterLevelSummary]) -> BTreeMap<String, Vec<String>> {
    let known = levels
        .iter()
        .map(|level| level.level)
        .collect::<BTreeSet<_>>();
    let mut children = BTreeMap::<String, Vec<String>>::new();
    for level in levels {
        if !known.contains(&level.level.saturating_add(1)) {
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
    for values in children.values_mut() {
        values.sort();
    }
    children
}

fn elevation_range(
    summary: &RasterBuildSummary,
) -> Result<[f64; 2], PreparedRasterSurfaceHierarchyError> {
    for level in &summary.levels {
        for layer in &level.view_layers {
            if let RasterViewTileFormat::GrayscalePng {
                minimum_elevation,
                maximum_elevation,
            } = layer.format
            {
                if minimum_elevation.is_finite()
                    && maximum_elevation.is_finite()
                    && minimum_elevation < maximum_elevation
                {
                    return Ok([minimum_elevation, maximum_elevation]);
                }
            }
        }
    }
    Err(invalid("DEM preview range is missing or invalid"))
}

fn exact_tile_bounds(bounds: RasterBounds, gsd: f64, column: u32, row: u32) -> RasterBounds {
    let span = f64::from(TILE_SIZE) * gsd;
    RasterBounds {
        minimum_east: bounds.minimum_east + f64::from(column) * span,
        minimum_north: bounds.maximum_north - f64::from(row + 1) * span,
        maximum_east: bounds.minimum_east + f64::from(column + 1) * span,
        maximum_north: bounds.maximum_north - f64::from(row) * span,
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

fn hash_file(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(String, u64), PreparedRasterSurfaceHierarchyError> {
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
        length = length
            .checked_add(read as u64)
            .ok_or_else(|| invalid("payload byte length overflow"))?;
    }
    if length == 0 {
        return Err(invalid("prepared payload is empty"));
    }
    Ok((hex::encode(hasher.finalize()), length))
}

fn write_bytes_atomically(
    destination: &Path,
    bytes: &[u8],
) -> Result<(), PreparedRasterSurfaceHierarchyError> {
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("prepared output has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(".viewer-raster-surface-{nonce}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut writer = BufWriter::new(options.open(&temporary)?);
    writer.write_all(bytes)?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    drop(writer);
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(&temporary, destination)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn check_cancelled(
    cancellation: &CancellationToken,
) -> Result<(), PreparedRasterSurfaceHierarchyError> {
    if cancellation.is_cancel_requested() {
        Err(PreparedRasterSurfaceHierarchyError::Cancelled)
    } else {
        Ok(())
    }
}

fn invalid(message: &str) -> PreparedRasterSurfaceHierarchyError {
    PreparedRasterSurfaceHierarchyError::InvalidInput(message.to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use himmelcad_core::canonical_document::EntityVersionRef;
    use himmelcad_core::canonical_resources::CanonicalResourceRef;
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::hash::ObjectHash;
    use himmelcad_core::photolab_jobs::CancellationToken;
    use himmelcad_render::{DatasetId, HierarchySource, PreparedHierarchySource, TileId};

    use super::publish_prepared_raster_surface_hierarchy;
    use crate::raster_runtime::{
        GdalAudit, OrthomosaicElevationSupport, RasterBounds, RasterBuildSummary, RasterByteOrder,
        RasterCrs, RasterGrid, RasterLevelSummary, RasterNoDataValue, RasterViewLayer,
        RasterViewTileFormat,
    };

    fn fixture_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hcad-raster-surface-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("fixture root");
        root
    }

    fn crs() -> RasterCrs {
        RasterCrs {
            horizontal: "EPSG:25832".into(),
            vertical: Some("DHHN2016".into()),
            gdal_srs: "EPSG:25832".into(),
            canonical_wkt_sha256: ObjectHash::of_bytes(b"fixture wkt"),
        }
    }

    fn audit() -> GdalAudit {
        GdalAudit {
            version: "fixture".into(),
            executable_sha256: Default::default(),
            raster_drivers: Vec::new(),
            vector_drivers: Vec::new(),
            network_enabled: false,
        }
    }

    fn dem_summary(root: &std::path::Path) -> RasterBuildSummary {
        let bounds = RasterBounds {
            minimum_east: 0.0,
            minimum_north: 0.0,
            maximum_east: 51.2,
            maximum_north: 51.2,
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
                gsd: 0.1,
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
                            minimum_elevation: 400.0,
                            maximum_elevation: 800.0,
                        },
                        url_template: "view/preview/L00/{x}/{y}.png".into(),
                    },
                ],
            }],
            crs: crs(),
            grid: RasterGrid {
                bounds,
                width_pixels: 512,
                height_pixels: 512,
                gsd: 0.1,
                no_data: RasterNoDataValue::Numeric(-9999.0),
            },
            audit: audit(),
        }
    }

    fn color_summary(root: &std::path::Path) -> RasterBuildSummary {
        let bounds = RasterBounds {
            minimum_east: 0.0,
            minimum_north: 40.96,
            maximum_east: 20.48,
            maximum_north: 51.2,
        };
        RasterBuildSummary {
            output_directory: root.to_string_lossy().into_owned(),
            cog_path: "product.cog.tif".into(),
            pyramid_manifest_path: "pyramid/manifest.json".into(),
            levels: vec![RasterLevelSummary {
                level: 0,
                columns: 2,
                rows: 1,
                tile_count: 2,
                bounds,
                gsd: 0.02,
                relative_directory: "pyramid/L00".into(),
                metric_tile_url_template: "pyramid/L00/{x}/{y}.tif".into(),
                view_layers: vec![RasterViewLayer {
                    name: "rgba".into(),
                    format: RasterViewTileFormat::RgbaPng,
                    url_template: "view/rgba/L00/{x}/{y}.png".into(),
                }],
            }],
            crs: crs(),
            grid: RasterGrid {
                bounds,
                width_pixels: 1024,
                height_pixels: 512,
                gsd: 0.02,
                no_data: RasterNoDataValue::AlphaMask,
            },
            audit: audit(),
        }
    }

    fn support(root: &std::path::Path) -> OrthomosaicElevationSupport {
        OrthomosaicElevationSupport {
            dataset_root: root.to_string_lossy().into_owned(),
            summary: dem_summary(root),
            source_surface: EntityVersionRef {
                id: EntityId("project:raster:dem-1".into()),
                revision: 1,
                version_hash: ObjectHash::of_bytes(b"dem record"),
            },
            derivation: CanonicalResourceRef {
                resource_id: "project:raster-surface-drape:ortho-1".into(),
                schema_id: "hcad.derivation.raster-surface-drape@1".into(),
                content_hash: ObjectHash::of_bytes(b"drape recipe"),
            },
        }
    }

    fn write_fixture_payloads(color_root: &std::path::Path, dem_root: &std::path::Path) {
        fs::create_dir_all(color_root.join("view/rgba/L00/0")).expect("left colour dir");
        fs::create_dir_all(color_root.join("view/rgba/L00/1")).expect("right colour dir");
        let image = image::RgbaImage::from_pixel(512, 512, image::Rgba([12, 70, 130, 255]));
        image
            .save(color_root.join("view/rgba/L00/0/0.png"))
            .expect("left colour");
        image
            .save(color_root.join("view/rgba/L00/1/0.png"))
            .expect("right colour");
        fs::create_dir_all(dem_root.join("view/height/L00/0")).expect("DEM dir");
        let mut bytes = Vec::with_capacity(512 * 512 * 4);
        for row in 0..512_u32 {
            for column in 0..512_u32 {
                let value = 450.0_f32 + row as f32 * 0.25 + column as f32 * 0.125;
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        fs::write(dem_root.join("view/height/L00/0/0.f32"), bytes).expect("DEM payload");
    }

    #[test]
    fn preserves_fine_colour_and_repeats_shared_support_edge_byte_exactly() {
        let color_root = fixture_root("colour");
        let dem_root = fixture_root("dem");
        write_fixture_payloads(&color_root, &dem_root);
        publish_prepared_raster_surface_hierarchy(
            &color_root,
            &color_summary(&color_root),
            &support(&dem_root),
            &CancellationToken::new(),
        )
        .expect("surface hierarchy");

        let manifest = fs::read(color_root.join("viewer/manifest.json")).expect("manifest");
        let mut source = PreparedHierarchySource::from_json(
            DatasetId("ortho-dem-fixture".into()),
            "file:///fixture/viewer/manifest.json",
            &manifest,
        )
        .expect("render hierarchy");
        let left = source
            .tile(&TileId("L00/0/0".into()))
            .expect("left query")
            .expect("left tile");
        let parameters = left.contents[0]
            .decoder_parameters
            .as_ref()
            .expect("decoder parameters");
        assert_eq!(parameters["schemaVersion"], 2);
        assert_eq!(parameters["width"], 512);
        assert_eq!(parameters["surface"]["width"], 103);
        assert_eq!(parameters["surface"]["height"], 103);
        assert_eq!(parameters["surface"]["sourceSurface"]["revision"], 1);

        let left = fs::read(color_root.join("view/surface/L00/0/0.f32")).expect("left support");
        let right = fs::read(color_root.join("view/surface/L00/1/0.f32")).expect("right support");
        let width = 103_usize;
        for row in 0..103_usize {
            let left_start = (row * width + width - 1) * 4;
            let right_start = row * width * 4;
            assert_eq!(
                &left[left_start..left_start + 4],
                &right[right_start..right_start + 4]
            );
        }

        fs::remove_dir_all(color_root).expect("remove colour fixture");
        fs::remove_dir_all(dem_root).expect("remove DEM fixture");
    }

    #[test]
    fn cancellation_prevents_manifest_publication() {
        let color_root = fixture_root("cancel-colour");
        let dem_root = fixture_root("cancel-dem");
        write_fixture_payloads(&color_root, &dem_root);
        let cancellation = CancellationToken::new();
        assert!(cancellation.request_cancel());
        assert!(publish_prepared_raster_surface_hierarchy(
            &color_root,
            &color_summary(&color_root),
            &support(&dem_root),
            &cancellation,
        )
        .is_err());
        assert!(!color_root.join("viewer/manifest.json").exists());
        fs::remove_dir_all(color_root).expect("remove colour fixture");
        fs::remove_dir_all(dem_root).expect("remove DEM fixture");
    }
}
