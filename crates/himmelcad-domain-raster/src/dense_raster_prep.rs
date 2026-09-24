//! Streaming conversion of the portable dense PLY into audited GDAL inputs.

use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use himmelcad_model::hash::ObjectHash;
use himmelcad_process::jobs::CancellationToken;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub use himmelcad_prepared::dense::{PreparedDenseVector, PreparedPotreeCloud};

use crate::raster_runtime::{RasterMemorySink, RasterPreparationStagePlan};
use himmelcad_process::process_group;
#[cfg(target_os = "linux")]
use himmelcad_process::worker::configure_systemd_user_bus_environment;
use himmelcad_process::worker::{worker_command, WorkerMemoryLimitMode, WorkerMemoryLimitPlan};
use himmelcad_spatial::ground_classification::{Point3, PointClass};

const POLL: Duration = Duration::from_millis(15);
/// X6 stream chunk: bounds cancellation latency while keeping class I/O allocations small.
const CLASSIFICATION_CHUNK_POINTS: usize = 8_192;
/// X6 diagnostic bound: 2 KiB preserves the actionable end of GDAL errors without
/// allowing verbose external tools to grow durable job records without limit.
const GDAL_OUTPUT_TAIL_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlyCoordinateKind {
    /// Legacy portable dense products wrote absolute CRS coords as float32.
    Float32,
    /// Current products keep world coordinates as float64 (required for projected CRS).
    Float64,
}

#[derive(Debug, Clone, Copy)]
pub struct PlyVertexLayout {
    pub stride: usize,
    pub x: usize,
    pub y: usize,
    pub z: usize,
    pub coordinate_kind: PlyCoordinateKind,
    pub red: Option<usize>,
    pub green: Option<usize>,
    pub blue: Option<usize>,
    pub confidence: Option<usize>,
    pub nx: Option<usize>,
    pub ny: Option<usize>,
    pub nz: Option<usize>,
}

#[derive(Debug, Error)]
pub enum DenseRasterPrepError {
    #[error("invalid portable dense PLY: {0}")]
    InvalidPly(String),
    #[error("dense raster preparation was cancelled")]
    Cancelled,
    #[error("GDAL preparation command `{command}` failed with exit code {code:?}")]
    GdalFailed {
        command: String,
        code: Option<i32>,
        stderr_tail: String,
    },
    #[error(
        "raster preparation stage `{stage}` exceeded its worker memory limit of {limit_bytes} bytes (sampled peak {peak_rss_bytes} bytes)"
    )]
    WorkerMemoryLimit {
        stage: String,
        limit_bytes: u64,
        peak_rss_bytes: u64,
    },
    #[error("failed to record raster preparation memory evidence: {0}")]
    MemoryRecord(String),
    #[error("classification has {actual} entries but the dense cloud has {expected} vertices")]
    ClassificationLength { expected: u64, actual: usize },
    #[error("dense cloud already has a different immutable ground classification")]
    ClassificationConflict,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Converts with bounded memory. The CSV is a temporary interchange consumed offline by ogr2ogr.
pub fn prepare_dense_vector(
    dense_ply: &Path,
    output_root: &Path,
    ogr2ogr: &Path,
    gdal_srs: &str,
    cancellation: &CancellationToken,
) -> Result<PreparedDenseVector, DenseRasterPrepError> {
    prepare_dense_vector_with_classification(
        dense_ply,
        output_root,
        ogr2ogr,
        gdal_srs,
        None,
        cancellation,
    )
}

/// Converts a portable dense cloud and carries an optional vertex-order LAS classification.
pub fn prepare_dense_vector_with_classification(
    dense_ply: &Path,
    output_root: &Path,
    ogr2ogr: &Path,
    gdal_srs: &str,
    classifications: Option<&[PointClass]>,
    cancellation: &CancellationToken,
) -> Result<PreparedDenseVector, DenseRasterPrepError> {
    prepare_dense_vector_with_classification_inner(
        dense_ply,
        output_root,
        ogr2ogr,
        gdal_srs,
        classifications,
        cancellation,
        None,
    )
}

/// Converts a dense cloud while enforcing and recording the admission-time ogr2ogr bound.
#[allow(clippy::too_many_arguments)]
pub fn prepare_dense_vector_with_classification_bounded(
    dense_ply: &Path,
    output_root: &Path,
    ogr2ogr: &Path,
    gdal_srs: &str,
    classifications: Option<&[PointClass]>,
    cancellation: &CancellationToken,
    memory_plan: RasterPreparationStagePlan,
    memory: &dyn RasterMemorySink,
) -> Result<PreparedDenseVector, DenseRasterPrepError> {
    prepare_dense_vector_with_classification_inner(
        dense_ply,
        output_root,
        ogr2ogr,
        gdal_srs,
        classifications,
        cancellation,
        Some(GdalCommandMemory {
            plan: memory_plan,
            sink: memory,
        }),
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_dense_vector_with_classification_inner(
    dense_ply: &Path,
    output_root: &Path,
    ogr2ogr: &Path,
    gdal_srs: &str,
    classifications: Option<&[PointClass]>,
    cancellation: &CancellationToken,
    memory: Option<GdalCommandMemory<'_>>,
) -> Result<PreparedDenseVector, DenseRasterPrepError> {
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root)?;
    let csv_path = output_root.join("dense.csv");
    let fgb_path = output_root.join("dense.fgb");
    let (point_count, minimum, maximum) =
        ply_to_csv(dense_ply, &csv_path, classifications, cancellation)?;
    run_command_with_memory(
        ogr2ogr,
        &[
            "-f",
            "FlatGeobuf",
            fgb_path.to_string_lossy().as_ref(),
            csv_path.to_string_lossy().as_ref(),
            "-oo",
            "X_POSSIBLE_NAMES=x",
            "-oo",
            "Y_POSSIBLE_NAMES=y",
            "-oo",
            "Z_POSSIBLE_NAMES=z",
            "-oo",
            "AUTODETECT_TYPE=YES",
            "-a_srs",
            gdal_srs,
            "-nln",
            "dense_points",
            "-overwrite",
        ],
        Some(output_root),
        cancellation,
        memory,
    )?;
    fs::remove_file(csv_path)?;
    Ok(PreparedDenseVector {
        flatgeobuf_path: fgb_path,
        layer: "dense_points".into(),
        point_count,
        minimum,
        maximum,
    })
}

/// Reads dense PLY coordinates in immutable vertex order for classification.
/// Writes a float32 copy of a dense PLY in a local frame (WP-A3).
///
/// COLMAP's meshers read and write float32 coordinates; in a projected CRS
/// (eastings around 4.4e6 m) float32 has ~0.25 m resolution, which collapses
/// neighbouring points and yields zero-area faces. The copy keeps colours and
/// normals when present and returns the origin (per-axis floor of the minimum)
/// that must be added back to every output vertex.
pub fn write_dense_local_frame_ply(
    dense_ply: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<[f64; 3], DenseRasterPrepError> {
    let (vertex_count, data_offset, layout, _, _) = inspect_ply(dense_ply, cancellation)?;
    let count = usize::try_from(vertex_count).map_err(|_| {
        DenseRasterPrepError::InvalidPly("vertex count does not fit address space".into())
    })?;
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, File::open(dense_ply)?);
    std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(data_offset))?;
    let mut record = vec![0_u8; layout.stride];
    let mut minimum = [f64::INFINITY; 3];
    for index in 0..count {
        if index % CLASSIFICATION_CHUNK_POINTS == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let [x, y, z] = read_coordinates(&record, layout)?;
        minimum = [minimum[0].min(x), minimum[1].min(y), minimum[2].min(z)];
    }
    if count == 0 || minimum.iter().any(|value| !value.is_finite()) {
        return Err(DenseRasterPrepError::InvalidPly(
            "dense cloud has no finite coordinates".into(),
        ));
    }
    let origin = [minimum[0].floor(), minimum[1].floor(), minimum[2].floor()];
    let has_color = layout.red.is_some() && layout.green.is_some() && layout.blue.is_some();
    let has_normals = layout.nx.is_some() && layout.ny.is_some() && layout.nz.is_some();
    let mut header = String::from("ply\nformat binary_little_endian 1.0\n");
    header.push_str(&format!(
        "comment himmelcad local frame origin {} {} {}\n",
        origin[0], origin[1], origin[2]
    ));
    header.push_str(&format!("element vertex {count}\n"));
    header.push_str("property float x\nproperty float y\nproperty float z\n");
    if has_color {
        header.push_str("property uchar red\nproperty uchar green\nproperty uchar blue\n");
    }
    if has_normals {
        header.push_str("property float nx\nproperty float ny\nproperty float nz\n");
    }
    header.push_str("end_header\n");
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, File::create(output)?);
    writer.write_all(header.as_bytes())?;
    std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(data_offset))?;
    for index in 0..count {
        if index % CLASSIFICATION_CHUNK_POINTS == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let [x, y, z] = read_coordinates(&record, layout)?;
        for value in [x - origin[0], y - origin[1], z - origin[2]] {
            writer.write_all(&(value as f32).to_le_bytes())?;
        }
        if has_color {
            for offset in [layout.red, layout.green, layout.blue] {
                writer.write_all(&[record[offset.unwrap_or(0)]])?;
            }
        }
        if has_normals {
            for offset in [layout.nx, layout.ny, layout.nz] {
                writer.write_all(&record[offset.unwrap_or(0)..offset.unwrap_or(0) + 4])?;
            }
        }
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(origin)
}

pub fn read_dense_points(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<Point3>, DenseRasterPrepError> {
    let (vertex_count, data_offset, layout, _, _) = inspect_ply(path, cancellation)?;
    let capacity = usize::try_from(vertex_count).map_err(|_| {
        DenseRasterPrepError::InvalidPly("vertex count does not fit address space".into())
    })?;
    let mut points = Vec::with_capacity(capacity);
    let mut reader = BufReader::new(File::open(path)?);
    use std::io::Seek;
    reader.seek(std::io::SeekFrom::Start(data_offset))?;
    let mut record = vec![0_u8; layout.stride];
    for index in 0..vertex_count {
        if index.is_multiple_of(CLASSIFICATION_CHUNK_POINTS as u64)
            && cancellation.is_cancel_requested()
        {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let [x, y, z] = read_coordinates(&record, layout)?;
        points.push(Point3 { x, y, z });
    }
    Ok(points)
}

/// Publishes the vertex-order class bytes and returns their content hash.
///
/// Two files are maintained next to the dense PLY: the immutable,
/// content-addressed `dense.classification.<hash16>.bin` (created once; an
/// existing file with the same name is verified byte-for-byte, never
/// overwritten) and `dense.classification.bin`, the *current* classification
/// that LAS/LAZ export consumes. Rebuilding a DTM with other SMRF parameters
/// therefore never fails: it adds another immutable artifact and atomically
/// repoints the current file. Which classification a DTM used is recorded by
/// its `ground_classification_sha256` on the raster artifact record (WP-A4).
pub fn persist_dense_classification(
    dense_ply: &Path,
    operation_id: &str,
    classifications: &[PointClass],
    cancellation: &CancellationToken,
) -> Result<ObjectHash, DenseRasterPrepError> {
    let mut hasher = Sha256::new();
    for chunk in classifications.chunks(CLASSIFICATION_CHUNK_POINTS) {
        if cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        let bytes = chunk.iter().copied().map(u8::from).collect::<Vec<_>>();
        hasher.update(bytes);
    }
    let hash = ObjectHash(format!("{:x}", hasher.finalize()));
    let parent = dense_ply.parent().ok_or_else(|| {
        DenseRasterPrepError::InvalidPly("dense PLY has no parent directory".into())
    })?;
    let immutable = parent.join(classification_artifact_name(&hash));
    let current = parent.join("dense.classification.bin");
    if immutable.exists() {
        verify_dense_classification(&immutable, classifications, cancellation)?;
    } else {
        let temporary = parent.join(format!(".dense.classification.bin.{operation_id}.partial"));
        if temporary.exists() {
            fs::remove_file(&temporary)?;
        }
        let result = (|| {
            let mut writer = BufWriter::with_capacity(1024 * 1024, File::create(&temporary)?);
            for chunk in classifications.chunks(CLASSIFICATION_CHUNK_POINTS) {
                if cancellation.is_cancel_requested() {
                    return Err(DenseRasterPrepError::Cancelled);
                }
                let bytes = chunk.iter().copied().map(u8::from).collect::<Vec<_>>();
                writer.write_all(&bytes)?;
            }
            writer.flush()?;
            writer.get_ref().sync_all()?;
            if cancellation.is_cancel_requested() {
                return Err(DenseRasterPrepError::Cancelled);
            }
            match fs::hard_link(&temporary, &immutable) {
                Ok(()) => fs::remove_file(&temporary)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    fs::remove_file(&temporary)?;
                    verify_dense_classification(&immutable, classifications, cancellation)?;
                }
                Err(error) => return Err(DenseRasterPrepError::Io(error)),
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
    }
    // Repoint the current classification atomically: a hard link to the
    // immutable bytes under a temporary name, then rename over the old current.
    let current_temporary = parent.join(format!(".dense.classification.current.{operation_id}"));
    let _ = fs::remove_file(&current_temporary);
    fs::hard_link(&immutable, &current_temporary)?;
    fs::rename(&current_temporary, &current)?;
    Ok(hash)
}

/// File name of the immutable, content-addressed classification artifact.
pub fn classification_artifact_name(hash: &ObjectHash) -> String {
    format!("dense.classification.{}.bin", &hash.0[..16])
}

fn verify_dense_classification(
    path: &Path,
    classifications: &[PointClass],
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    if path.metadata()?.len() != u64::try_from(classifications.len()).unwrap_or(u64::MAX) {
        return Err(DenseRasterPrepError::ClassificationConflict);
    }
    let mut reader = BufReader::new(File::open(path)?);
    let mut actual = vec![0_u8; CLASSIFICATION_CHUNK_POINTS];
    for chunk in classifications.chunks(CLASSIFICATION_CHUNK_POINTS) {
        if cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut actual[..chunk.len()])?;
        if actual[..chunk.len()]
            .iter()
            .copied()
            .ne(chunk.iter().copied().map(u8::from))
        {
            return Err(DenseRasterPrepError::ClassificationConflict);
        }
    }
    Ok(())
}

/// Converts the portable dense PLY to LAS 1.2 and then to the shared Potree 2.0 stream format.
pub fn prepare_dense_potree(
    dense_ply: &Path,
    output_root: &Path,
    converter: &Path,
    cancellation: &CancellationToken,
) -> Result<PreparedPotreeCloud, DenseRasterPrepError> {
    fs::create_dir_all(output_root)?;
    let las_path = output_root.join("dense.las");
    ply_to_las(dense_ply, &las_path, cancellation)?;
    let octree = output_root.join("octree");
    if octree.exists() {
        fs::remove_dir_all(&octree)?;
    }
    run_owned_command(
        converter,
        &[
            las_path.to_string_lossy().into_owned(),
            "-o".into(),
            octree.to_string_lossy().into_owned(),
            "--encoding".into(),
            "UNCOMPRESSED".into(),
            "-m".into(),
            "poisson".into(),
        ],
        cancellation,
    )?;
    fs::remove_file(las_path)?;
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(octree.join("metadata.json"))?)
            .map_err(|error| DenseRasterPrepError::InvalidPly(error.to_string()))?;
    let render_offset = json_xyz(&metadata, "offset")?;
    let bounding_box = metadata
        .get("boundingBox")
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("Potree bounds missing".into()))?;
    // Potree 2.0 metadata reports boundingBox in source/world coordinates.
    // `offset` is the render/decode origin and must not be added a second time.
    let bounds_min = json_xyz(bounding_box, "min")?;
    let bounds_max = json_xyz(bounding_box, "max")?;
    Ok(PreparedPotreeCloud {
        relative_metadata_path: PathBuf::from("potree/octree/metadata.json"),
        export_relative_path: None,
        point_count: metadata
            .get("points")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("Potree point count missing".into()))?,
        render_offset,
        bounds_min,
        bounds_max,
    })
}

/// Streams a COLMAP text model into a portable PLY and the shared Potree hierarchy.
pub fn prepare_sparse_potree(
    points3d_text: &Path,
    output_root: &Path,
    converter: &Path,
    cancellation: &CancellationToken,
) -> Result<PreparedPotreeCloud, DenseRasterPrepError> {
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root)?;
    let (point_count, minimum, maximum) = inspect_colmap_sparse(points3d_text, cancellation)?;
    if point_count == 0 {
        return Err(DenseRasterPrepError::InvalidPly(
            "COLMAP sparse model contains no points".into(),
        ));
    }
    if point_count > u64::from(u32::MAX) {
        return Err(DenseRasterPrepError::InvalidPly(
            "LAS 1.2 point limit exceeded".into(),
        ));
    }
    let scale =
        [0, 1, 2].map(|axis| ((maximum[axis] - minimum[axis]) / f64::from(i32::MAX)).max(0.001));
    let las_path = output_root.join("sparse.las");
    let export_path = output_root.join("export.ply");
    write_sparse_intermediates(
        points3d_text,
        &las_path,
        &export_path,
        point_count,
        minimum,
        maximum,
        scale,
        cancellation,
    )?;
    let octree = output_root.join("octree");
    run_owned_command(
        converter,
        &[
            las_path.to_string_lossy().into_owned(),
            "-o".into(),
            octree.to_string_lossy().into_owned(),
            "--encoding".into(),
            "UNCOMPRESSED".into(),
            "-m".into(),
            "poisson".into(),
        ],
        cancellation,
    )?;
    fs::remove_file(las_path)?;
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(octree.join("metadata.json"))?)
            .map_err(|error| DenseRasterPrepError::InvalidPly(error.to_string()))?;
    let render_offset = json_xyz(&metadata, "offset")?;
    let bounding_box = metadata
        .get("boundingBox")
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("Potree bounds missing".into()))?;
    // Potree 2.0 stores world-space bounds alongside its render offset.
    let bounds_min = json_xyz(bounding_box, "min")?;
    let bounds_max = json_xyz(bounding_box, "max")?;
    Ok(PreparedPotreeCloud {
        relative_metadata_path: PathBuf::from("octree/metadata.json"),
        export_relative_path: Some(PathBuf::from("export.ply")),
        point_count: metadata
            .get("points")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("Potree point count missing".into()))?,
        render_offset,
        bounds_min,
        bounds_max,
    })
}

#[allow(clippy::too_many_arguments)]
fn write_sparse_intermediates(
    points3d_text: &Path,
    las_path: &Path,
    export_path: &Path,
    point_count: u64,
    minimum: [f64; 3],
    maximum: [f64; 3],
    scale: [f64; 3],
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    let mut las = BufWriter::with_capacity(1024 * 1024, File::create(las_path)?);
    write_las_header(
        &mut las,
        point_count,
        minimum,
        maximum,
        scale,
        "HimmelCAD sparse COLMAP to LAS",
    )?;
    let mut ply = BufWriter::with_capacity(1024 * 1024, File::create(export_path)?);
    write!(
        ply,
        "ply\nformat binary_little_endian 1.0\nelement vertex {point_count}\n\
property double x\nproperty double y\nproperty double z\n\
property uchar red\nproperty uchar green\nproperty uchar blue\n\
property float reprojection_error\nend_header\n"
    )?;
    let reader = BufReader::new(File::open(points3d_text)?);
    let mut written = 0_u64;
    for line in reader.lines() {
        if written % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        let line = line?;
        let Some(point) = parse_colmap_sparse_point(&line)? else {
            continue;
        };
        for axis in 0..3 {
            let quantized =
                quantize_las_coordinate(point.coordinate[axis], minimum[axis], scale[axis]);
            las.write_all(&quantized.to_le_bytes())?;
            ply.write_all(&point.coordinate[axis].to_le_bytes())?;
        }
        las.write_all(&reprojection_intensity(point.reprojection_error).to_le_bytes())?;
        las.write_all(&[0b0000_1001, 1, 0, 0, 0, 0])?;
        for color in point.color {
            las.write_all(&(u16::from(color) * 257).to_le_bytes())?;
        }
        ply.write_all(&point.color)?;
        ply.write_all(&reprojection_error_f32(point.reprojection_error).to_le_bytes())?;
        written += 1;
    }
    if written != point_count {
        return Err(DenseRasterPrepError::InvalidPly(
            "COLMAP sparse point count changed while preparing output".into(),
        ));
    }
    las.flush()?;
    ply.flush()?;
    las.get_ref().sync_all()?;
    ply.get_ref().sync_all()?;
    Ok(())
}

#[allow(clippy::cast_possible_truncation)]
pub fn quantize_las_coordinate(value: f64, minimum: f64, scale: f64) -> i32 {
    // INVARIANT: The scale maps the complete axis extent into LAS's signed 32-bit range.
    ((value - minimum) / scale)
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn reprojection_intensity(error: f64) -> u16 {
    // INVARIANT: Clamping makes the rounded value representable by u16.
    ((1.0 / (1.0 + error)).clamp(0.0, 1.0) * 65_535.0).round() as u16
}

#[allow(clippy::cast_possible_truncation)]
fn reprojection_error_f32(error: f64) -> f32 {
    // The portable PLY schema intentionally stores this display attribute as float32.
    error as f32
}

#[derive(Debug, Clone, Copy)]
pub struct ColmapSparsePoint {
    pub coordinate: [f64; 3],
    pub color: [u8; 3],
    pub reprojection_error: f64,
}

fn inspect_colmap_sparse(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(u64, [f64; 3], [f64; 3]), DenseRasterPrepError> {
    let reader = BufReader::new(File::open(path)?);
    let mut count = 0_u64;
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    for line in reader.lines() {
        if count % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        let line = line?;
        let Some(point) = parse_colmap_sparse_point(&line)? else {
            continue;
        };
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(point.coordinate[axis]);
            maximum[axis] = maximum[axis].max(point.coordinate[axis]);
        }
        count = count.saturating_add(1);
    }
    Ok((count, minimum, maximum))
}

pub fn parse_colmap_sparse_point(
    line: &str,
) -> Result<Option<ColmapSparsePoint>, DenseRasterPrepError> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() < 8 {
        return Err(DenseRasterPrepError::InvalidPly(
            "invalid COLMAP points3D.txt record".into(),
        ));
    }
    fields[0]
        .parse::<u64>()
        .map_err(|_| DenseRasterPrepError::InvalidPly("invalid COLMAP point id".into()))?;
    let parse_coordinate = |index: usize| {
        fields[index]
            .parse::<f64>()
            .map_err(|_| DenseRasterPrepError::InvalidPly("invalid COLMAP coordinate".into()))
    };
    let coordinate = [
        parse_coordinate(1)?,
        parse_coordinate(2)?,
        parse_coordinate(3)?,
    ];
    if coordinate.iter().any(|value| !value.is_finite()) {
        return Err(DenseRasterPrepError::InvalidPly(
            "non-finite COLMAP coordinate".into(),
        ));
    }
    let parse_color = |index: usize| {
        fields[index]
            .parse::<u8>()
            .map_err(|_| DenseRasterPrepError::InvalidPly("invalid COLMAP point color".into()))
    };
    let color = [parse_color(4)?, parse_color(5)?, parse_color(6)?];
    let reprojection_error = fields[7].parse::<f64>().map_err(|_| {
        DenseRasterPrepError::InvalidPly("invalid COLMAP reprojection error".into())
    })?;
    if !reprojection_error.is_finite() || reprojection_error < 0.0 {
        return Err(DenseRasterPrepError::InvalidPly(
            "invalid COLMAP reprojection error".into(),
        ));
    }
    Ok(Some(ColmapSparsePoint {
        coordinate,
        color,
        reprojection_error,
    }))
}

pub fn write_las_header(
    writer: &mut impl Write,
    point_count: u64,
    minimum: [f64; 3],
    maximum: [f64; 3],
    scale: [f64; 3],
    software: &str,
) -> Result<(), DenseRasterPrepError> {
    let count = u32::try_from(point_count)
        .map_err(|_| DenseRasterPrepError::InvalidPly("LAS 1.2 point limit exceeded".into()))?;
    let mut header = vec![0_u8; 227];
    header[0..4].copy_from_slice(b"LASF");
    header[24] = 1;
    header[25] = 2;
    copy_ascii(&mut header[26..58], "HimmelCAD PhotoLab");
    copy_ascii(&mut header[58..90], software);
    header[94..96].copy_from_slice(&227_u16.to_le_bytes());
    header[96..100].copy_from_slice(&227_u32.to_le_bytes());
    header[104] = 2;
    header[105..107].copy_from_slice(&26_u16.to_le_bytes());
    header[107..111].copy_from_slice(&count.to_le_bytes());
    header[111..115].copy_from_slice(&count.to_le_bytes());
    for axis in 0..3 {
        header[131 + axis * 8..139 + axis * 8].copy_from_slice(&scale[axis].to_le_bytes());
        header[155 + axis * 8..163 + axis * 8].copy_from_slice(&minimum[axis].to_le_bytes());
    }
    // Header bounds must describe the quantized coordinates stored below,
    // not the pre-quantization floating-point extrema. With the deliberately
    // portable millimetre minimum scale, rounding can otherwise put a point
    // by less than half a millimetre outside the advertised LAS bounds and
    // PotreeConverter correctly rejects the file.
    let encoded_maximum = [0, 1, 2].map(|axis| {
        minimum[axis]
            + f64::from(quantize_las_coordinate(
                maximum[axis],
                minimum[axis],
                scale[axis],
            )) * scale[axis]
    });
    for (offset, value) in [
        (179, encoded_maximum[0]),
        (187, minimum[0]),
        (195, encoded_maximum[1]),
        (203, minimum[1]),
        (211, encoded_maximum[2]),
        (219, minimum[2]),
    ] {
        header[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    writer.write_all(&header)?;
    Ok(())
}

/// Creates a georeferenced three-band VRT by nearest-neighbor gridding of dense RGB samples.
#[allow(clippy::too_many_arguments)] // GDAL grid parameters form one stable command boundary.
pub fn prepare_color_vrt(
    vector: &PreparedDenseVector,
    output_root: &Path,
    gdal_grid: &Path,
    gdalbuildvrt: &Path,
    gdal_srs: &str,
    bounds: [f64; 4],
    width: u32,
    height: u32,
    radius: f64,
    cancellation: &CancellationToken,
) -> Result<PathBuf, DenseRasterPrepError> {
    prepare_color_vrt_inner(
        vector,
        output_root,
        gdal_grid,
        gdalbuildvrt,
        gdal_srs,
        bounds,
        width,
        height,
        radius,
        cancellation,
        None,
    )
}

/// Builds the color VRT while enforcing and recording the gdal_grid unit bound.
#[allow(clippy::too_many_arguments)]
pub fn prepare_color_vrt_bounded(
    vector: &PreparedDenseVector,
    output_root: &Path,
    gdal_grid: &Path,
    gdalbuildvrt: &Path,
    gdal_srs: &str,
    bounds: [f64; 4],
    width: u32,
    height: u32,
    radius: f64,
    cancellation: &CancellationToken,
    memory_plan: RasterPreparationStagePlan,
    memory: &dyn RasterMemorySink,
) -> Result<PathBuf, DenseRasterPrepError> {
    prepare_color_vrt_inner(
        vector,
        output_root,
        gdal_grid,
        gdalbuildvrt,
        gdal_srs,
        bounds,
        width,
        height,
        radius,
        cancellation,
        Some(GdalCommandMemory {
            plan: memory_plan,
            sink: memory,
        }),
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_color_vrt_inner(
    vector: &PreparedDenseVector,
    output_root: &Path,
    gdal_grid: &Path,
    gdalbuildvrt: &Path,
    gdal_srs: &str,
    bounds: [f64; 4],
    width: u32,
    height: u32,
    radius: f64,
    cancellation: &CancellationToken,
    memory: Option<GdalCommandMemory<'_>>,
) -> Result<PathBuf, DenseRasterPrepError> {
    fs::create_dir_all(output_root)?;
    let mut bands = Vec::new();
    for field in ["red", "green", "blue"] {
        let output = output_root.join(format!("{field}.tif"));
        let arguments = vec![
            "-of".to_owned(),
            "GTiff".to_owned(),
            "-ot".to_owned(),
            "Byte".to_owned(),
            "-txe".to_owned(),
            bounds[0].to_string(),
            bounds[2].to_string(),
            "-tye".to_owned(),
            bounds[1].to_string(),
            bounds[3].to_string(),
            "-outsize".to_owned(),
            width.to_string(),
            height.to_string(),
            "-a_srs".to_owned(),
            gdal_srs.to_owned(),
            "-a".to_owned(),
            format!("nearest:radius1={radius}:radius2={radius}:nodata=0"),
            "-l".to_owned(),
            vector.layer.clone(),
            "-zfield".to_owned(),
            field.to_owned(),
            vector.flatgeobuf_path.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
        ];
        run_owned_command_with_memory(gdal_grid, &arguments, cancellation, memory)?;
        bands.push(output);
    }
    let vrt = output_root.join("orthophoto.vrt");
    let mut arguments = vec!["-separate".to_owned(), vrt.to_string_lossy().into_owned()];
    arguments.extend(bands.iter().map(|path| path.to_string_lossy().into_owned()));
    run_owned_command_with_memory(gdalbuildvrt, &arguments, cancellation, memory)?;
    Ok(vrt)
}

/// Reads the exact WKT emitted by GDAL for the prepared vector dataset.
pub fn inspect_vector_wkt(
    ogrinfo: &Path,
    vector: &PreparedDenseVector,
    cancellation: &CancellationToken,
) -> Result<String, DenseRasterPrepError> {
    inspect_vector_wkt_inner(ogrinfo, vector, cancellation, None)
}

/// Reads vector WKT under the same bound as the preceding OGR conversion unit.
pub fn inspect_vector_wkt_bounded(
    ogrinfo: &Path,
    vector: &PreparedDenseVector,
    cancellation: &CancellationToken,
    memory_plan: RasterPreparationStagePlan,
    memory: &dyn RasterMemorySink,
) -> Result<String, DenseRasterPrepError> {
    inspect_vector_wkt_inner(
        ogrinfo,
        vector,
        cancellation,
        Some(GdalCommandMemory {
            plan: memory_plan,
            sink: memory,
        }),
    )
}

fn inspect_vector_wkt_inner(
    ogrinfo: &Path,
    vector: &PreparedDenseVector,
    cancellation: &CancellationToken,
    memory: Option<GdalCommandMemory<'_>>,
) -> Result<String, DenseRasterPrepError> {
    let output_path = vector.flatgeobuf_path.with_extension("ogrinfo.json");
    let arguments = vec![
        "-json".to_owned(),
        "-so".to_owned(),
        vector.flatgeobuf_path.to_string_lossy().into_owned(),
        vector.layer.clone(),
    ];
    run_gdal_command_inner(
        ogrinfo,
        &arguments,
        Some(File::create(&output_path)?),
        None,
        cancellation,
        memory,
        None,
    )?;
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&output_path)?)
        .map_err(|error| DenseRasterPrepError::InvalidPly(error.to_string()))?;
    fs::remove_file(output_path)?;
    value
        .pointer("/layers/0/geometryFields/0/coordinateSystem/wkt")
        .or_else(|| value.pointer("/layers/0/geometryFields/0/coordinateSystem/wkt2"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("OGR WKT is missing".into()))
}

/// Reads the exact WKT emitted by GDAL for an existing raster. Passing this
/// text back to GDAL prevents an authority-code re-expansion from changing the
/// frozen datum/ensemble representation between dependent products.
pub fn inspect_raster_wkt(
    gdalinfo: &Path,
    raster: &Path,
    cancellation: &CancellationToken,
) -> Result<String, DenseRasterPrepError> {
    let output_path = raster.with_extension("gdalinfo.json");
    let arguments = vec!["-json".to_owned(), raster.to_string_lossy().into_owned()];
    run_gdal_command(
        gdalinfo,
        &arguments,
        Some(File::create(&output_path)?),
        None,
        cancellation,
    )?;
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&output_path)?)
        .map_err(|error| DenseRasterPrepError::InvalidPly(error.to_string()))?;
    fs::remove_file(output_path)?;
    value
        .pointer("/coordinateSystem/wkt")
        .or_else(|| value.pointer("/coordinateSystem/wkt2"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("GDAL raster WKT is missing".into()))
}

pub fn ply_to_csv(
    path: &Path,
    csv_path: &Path,
    classifications: Option<&[PointClass]>,
    cancellation: &CancellationToken,
) -> Result<(u64, [f64; 3], [f64; 3]), DenseRasterPrepError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut header = Vec::new();
    let mut vertex_count = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || header.len() > 64 * 1024 {
            return Err(DenseRasterPrepError::InvalidPly(
                "unterminated header".into(),
            ));
        }
        if let Some(value) = line.strip_prefix("element vertex ") {
            vertex_count = value.trim().parse::<u64>().ok();
        }
        header.extend_from_slice(line.as_bytes());
        if line.trim() == "end_header" {
            break;
        }
    }
    let vertex_count = vertex_count
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("vertex count missing".into()))?;
    if let Some(classifications) = classifications {
        if u64::try_from(classifications.len()).unwrap_or(u64::MAX) != vertex_count {
            return Err(DenseRasterPrepError::ClassificationLength {
                expected: vertex_count,
                actual: classifications.len(),
            });
        }
    }
    let header_text = String::from_utf8_lossy(&header);
    for required in [
        "format binary_little_endian 1.0",
        "property uchar red",
        "property uchar green",
        "property uchar blue",
        "property float confidence",
    ] {
        if !header_text.contains(required) {
            return Err(DenseRasterPrepError::InvalidPly(format!(
                "missing {required}"
            )));
        }
    }
    let mut writer = BufWriter::with_capacity(1024 * 1024, File::create(csv_path)?);
    if classifications.is_some() {
        writer.write_all(b"x,y,z,red,green,blue,confidence,classification\n")?;
    } else {
        writer.write_all(b"x,y,z,red,green,blue,confidence\n")?;
    }
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    let layout = ply_vertex_layout(&header_text)?;
    let (red, green, blue, confidence_offset) = required_dense_attributes(layout)?;
    let mut record = vec![0_u8; layout.stride];
    for index in 0..vertex_count {
        if index % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let values = read_coordinates(&record, layout)?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(values[axis]);
            maximum[axis] = maximum[axis].max(values[axis]);
        }
        let confidence = read_f32(&record, confidence_offset);
        if let Some(classifications) = classifications {
            writeln!(
                writer,
                "{},{},{},{},{},{},{},{}",
                values[0],
                values[1],
                values[2],
                record[red],
                record[green],
                record[blue],
                confidence,
                u8::from(classifications[usize::try_from(index).expect("vertex index fits usize")])
            )?;
        } else {
            writeln!(
                writer,
                "{},{},{},{},{},{},{}",
                values[0],
                values[1],
                values[2],
                record[red],
                record[green],
                record[blue],
                confidence
            )?;
        }
    }
    writer.flush()?;
    Ok((vertex_count, minimum, maximum))
}

pub fn ply_to_las(
    path: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    let (vertex_count, data_offset, layout, minimum, maximum) = inspect_ply(path, cancellation)?;
    let (red, green, blue, confidence_offset) = required_dense_attributes(layout)?;
    if vertex_count > u64::from(u32::MAX) {
        return Err(DenseRasterPrepError::InvalidPly(
            "LAS 1.2 point limit exceeded".into(),
        ));
    }
    // Millimetre floor matches sparse prep and keeps LAS quantization well below
    // the f32 absolute-CRS grid (~0.5 m) that previously corrupted dense products.
    let scale =
        [0, 1, 2].map(|axis| ((maximum[axis] - minimum[axis]) / f64::from(i32::MAX)).max(0.001));
    let mut writer = BufWriter::with_capacity(1024 * 1024, File::create(output)?);
    write_las_header(
        &mut writer,
        vertex_count,
        minimum,
        maximum,
        scale,
        "HimmelCAD dense PLY to LAS",
    )?;
    let mut reader = BufReader::new(File::open(path)?);
    use std::io::Seek;
    reader.seek(std::io::SeekFrom::Start(data_offset))?;
    let mut record = vec![0_u8; layout.stride];
    for index in 0..vertex_count {
        if index % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let coordinates = read_coordinates(&record, layout)?;
        for axis in 0..3 {
            let quantized = quantize_las_coordinate(coordinates[axis], minimum[axis], scale[axis]);
            writer.write_all(&quantized.to_le_bytes())?;
        }
        let confidence = read_f32(&record, confidence_offset).clamp(0.0, 1.0);
        let intensity = (confidence * 65_535.0).round() as u16;
        writer.write_all(&intensity.to_le_bytes())?;
        writer.write_all(&[0b0000_1001, 1, 0, 0, 0, 0])?;
        for color in [record[red], record[green], record[blue]] {
            writer.write_all(&(u16::from(color) * 257).to_le_bytes())?;
        }
    }
    writer.flush()?;
    Ok(())
}

type PlyInspection = (u64, u64, PlyVertexLayout, [f64; 3], [f64; 3]);

fn inspect_ply(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<PlyInspection, DenseRasterPrepError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut offset = 0_u64;
    let mut vertex_count = None;
    let mut header = String::new();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 || offset > 64 * 1024 {
            return Err(DenseRasterPrepError::InvalidPly(
                "unterminated header".into(),
            ));
        }
        offset += u64::try_from(read).expect("usize fits u64");
        header.push_str(&line);
        if let Some(value) = line.strip_prefix("element vertex ") {
            vertex_count = value.trim().parse().ok();
        }
        if line.trim() == "end_header" {
            break;
        }
    }
    let vertex_count = vertex_count
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("vertex count missing".into()))?;
    let layout = ply_vertex_layout(&header)?;
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    let mut record = vec![0_u8; layout.stride];
    for index in 0..vertex_count {
        if index % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let values = read_coordinates(&record, layout)?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(values[axis]);
            maximum[axis] = maximum[axis].max(values[axis]);
        }
    }
    Ok((vertex_count, offset, layout, minimum, maximum))
}

fn ply_coordinate_kind(scalar: &str) -> Option<PlyCoordinateKind> {
    match scalar {
        "float" | "float32" => Some(PlyCoordinateKind::Float32),
        "double" | "float64" => Some(PlyCoordinateKind::Float64),
        _ => None,
    }
}

pub fn ply_vertex_layout(header: &str) -> Result<PlyVertexLayout, DenseRasterPrepError> {
    let mut in_vertex = false;
    let mut stride = 0_usize;
    let mut x = None;
    let mut y = None;
    let mut z = None;
    let mut coordinate_kind = None;
    let mut red = None;
    let mut green = None;
    let mut blue = None;
    let mut confidence = None;
    let mut nx = None;
    let mut ny = None;
    let mut nz = None;
    for line in header.lines().map(str::trim) {
        if line.starts_with("element vertex ") {
            in_vertex = true;
            continue;
        }
        if line.starts_with("element ") || line == "end_header" {
            in_vertex = false;
        }
        if !in_vertex || !line.starts_with("property ") {
            continue;
        }
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        let ["property", scalar, name] = fields.as_slice() else {
            return Err(DenseRasterPrepError::InvalidPly(
                "PLY vertex list properties are unsupported".into(),
            ));
        };
        let width = match *scalar {
            "float" | "float32" | "int" | "uint" => 4,
            "double" | "float64" | "int64" | "uint64" => 8,
            "uchar" | "uint8" | "char" | "int8" => 1,
            "short" | "ushort" | "int16" | "uint16" => 2,
            _ => {
                return Err(DenseRasterPrepError::InvalidPly(format!(
                    "unsupported PLY scalar type {scalar}"
                )))
            }
        };
        match *name {
            "x" | "y" | "z" => {
                let kind = ply_coordinate_kind(scalar).ok_or_else(|| {
                    DenseRasterPrepError::InvalidPly(format!(
                        "coordinate property {name} must be float or double"
                    ))
                })?;
                match coordinate_kind {
                    Some(existing) if existing != kind => {
                        return Err(DenseRasterPrepError::InvalidPly(
                            "coordinate properties must share one scalar type".into(),
                        ));
                    }
                    None => coordinate_kind = Some(kind),
                    _ => {}
                }
                match *name {
                    "x" => x = Some(stride),
                    "y" => y = Some(stride),
                    "z" => z = Some(stride),
                    _ => {}
                }
            }
            "red" if matches!(*scalar, "uchar" | "uint8") => red = Some(stride),
            "green" if matches!(*scalar, "uchar" | "uint8") => green = Some(stride),
            "blue" if matches!(*scalar, "uchar" | "uint8") => blue = Some(stride),
            "confidence" if matches!(*scalar, "float" | "float32") => confidence = Some(stride),
            "nx" if matches!(*scalar, "float" | "float32") => nx = Some(stride),
            "ny" if matches!(*scalar, "float" | "float32") => ny = Some(stride),
            "nz" if matches!(*scalar, "float" | "float32") => nz = Some(stride),
            _ => {}
        }
        stride = stride
            .checked_add(width)
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("PLY vertex stride overflow".into()))?;
    }
    Ok(PlyVertexLayout {
        stride,
        x: x.ok_or_else(|| DenseRasterPrepError::InvalidPly("missing coordinate x".into()))?,
        y: y.ok_or_else(|| DenseRasterPrepError::InvalidPly("missing coordinate y".into()))?,
        z: z.ok_or_else(|| DenseRasterPrepError::InvalidPly("missing coordinate z".into()))?,
        coordinate_kind: coordinate_kind.ok_or_else(|| {
            DenseRasterPrepError::InvalidPly("missing coordinate scalar type".into())
        })?,
        red,
        green,
        blue,
        confidence,
        nx,
        ny,
        nz,
    })
}

fn read_coordinates(
    record: &[u8],
    layout: PlyVertexLayout,
) -> Result<[f64; 3], DenseRasterPrepError> {
    let values = [
        read_coordinate(record, layout.x, layout.coordinate_kind),
        read_coordinate(record, layout.y, layout.coordinate_kind),
        read_coordinate(record, layout.z, layout.coordinate_kind),
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return Err(DenseRasterPrepError::InvalidPly(
            "non-finite coordinate".into(),
        ));
    }
    Ok(values)
}

fn read_coordinate(record: &[u8], offset: usize, kind: PlyCoordinateKind) -> f64 {
    match kind {
        PlyCoordinateKind::Float32 => f64::from(read_f32(record, offset)),
        PlyCoordinateKind::Float64 => read_f64(record, offset),
    }
}

pub fn required_dense_attributes(
    layout: PlyVertexLayout,
) -> Result<(usize, usize, usize, usize), DenseRasterPrepError> {
    Ok((
        layout
            .red
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("missing uchar red".into()))?,
        layout
            .green
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("missing uchar green".into()))?,
        layout
            .blue
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("missing uchar blue".into()))?,
        layout
            .confidence
            .ok_or_else(|| DenseRasterPrepError::InvalidPly("missing float confidence".into()))?,
    ))
}

fn read_f32(record: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(
        record[offset..offset + 4]
            .try_into()
            .expect("validated PLY layout"),
    )
}

fn read_f64(record: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(
        record[offset..offset + 8]
            .try_into()
            .expect("validated PLY layout"),
    )
}

fn copy_ascii(target: &mut [u8], value: &str) {
    let bytes = value.as_bytes();
    let count = target.len().min(bytes.len());
    target[..count].copy_from_slice(&bytes[..count]);
}

fn json_xyz(value: &serde_json::Value, key: &str) -> Result<[f64; 3], DenseRasterPrepError> {
    let values = value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DenseRasterPrepError::InvalidPly(format!("Potree {key} missing")))?;
    if values.len() != 3 {
        return Err(DenseRasterPrepError::InvalidPly(format!(
            "Potree {key} invalid"
        )));
    }
    Ok([
        values[0]
            .as_f64()
            .ok_or_else(|| DenseRasterPrepError::InvalidPly(format!("Potree {key} invalid")))?,
        values[1]
            .as_f64()
            .ok_or_else(|| DenseRasterPrepError::InvalidPly(format!("Potree {key} invalid")))?,
        values[2]
            .as_f64()
            .ok_or_else(|| DenseRasterPrepError::InvalidPly(format!("Potree {key} invalid")))?,
    ])
}

fn run_command_with_memory(
    executable: &Path,
    arguments: &[&str],
    gdal_temp_directory: Option<&Path>,
    cancellation: &CancellationToken,
    memory: Option<GdalCommandMemory<'_>>,
) -> Result<(), DenseRasterPrepError> {
    let owned = arguments
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    run_gdal_command_inner(
        executable,
        &owned,
        None,
        gdal_temp_directory,
        cancellation,
        memory,
        None,
    )
}

pub fn run_owned_command(
    executable: &Path,
    arguments: &[String],
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    run_gdal_command(executable, arguments, None, None, cancellation)
}

fn run_owned_command_with_memory(
    executable: &Path,
    arguments: &[String],
    cancellation: &CancellationToken,
    memory: Option<GdalCommandMemory<'_>>,
) -> Result<(), DenseRasterPrepError> {
    run_gdal_command_inner(
        executable,
        arguments,
        None,
        None,
        cancellation,
        memory,
        None,
    )
}

fn run_gdal_command(
    executable: &Path,
    arguments: &[String],
    stdout_destination: Option<File>,
    gdal_temp_directory: Option<&Path>,
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    run_gdal_command_inner(
        executable,
        arguments,
        stdout_destination,
        gdal_temp_directory,
        cancellation,
        None,
        None,
    )
}

#[derive(Clone, Copy)]
pub struct GdalCommandMemory<'a> {
    pub plan: RasterPreparationStagePlan,
    pub sink: &'a dyn RasterMemorySink,
}

pub fn run_fake_gdal_stage_with_memory(
    executable: &Path,
    arguments: &[String],
    cancellation: &CancellationToken,
    memory_plan: RasterPreparationStagePlan,
    memory: &dyn RasterMemorySink,
    worker_plan: WorkerMemoryLimitPlan,
) -> Result<(), DenseRasterPrepError> {
    run_gdal_command_inner(
        executable,
        arguments,
        None,
        None,
        cancellation,
        Some(GdalCommandMemory {
            plan: memory_plan,
            sink: memory,
        }),
        Some(worker_plan),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_gdal_command_inner(
    executable: &Path,
    arguments: &[String],
    stdout_destination: Option<File>,
    gdal_temp_directory: Option<&Path>,
    cancellation: &CancellationToken,
    memory: Option<GdalCommandMemory<'_>>,
    explicit_worker_plan: Option<WorkerMemoryLimitPlan>,
) -> Result<(), DenseRasterPrepError> {
    let normalized_arguments = arguments
        .iter()
        .map(|argument| external_tool_argument(argument))
        .collect::<Vec<_>>();
    let command_description = diagnostic_command(executable, &normalized_arguments);
    let (mut command, worker_limit_plan) = if let Some(plan) = explicit_worker_plan {
        #[cfg(target_os = "linux")]
        {
            let launcher = match plan.mode {
                WorkerMemoryLimitMode::CgroupScope => Path::new("/usr/bin/systemd-run"),
                WorkerMemoryLimitMode::RlimitAs => Path::new("/usr/bin/prlimit"),
            };
            (
                himmelcad_process::worker::worker_command_for_plan(launcher, executable, plan),
                Some(plan),
            )
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = plan;
            (Command::new(executable), None)
        }
    } else {
        worker_command(
            executable,
            memory.map(|memory| memory.plan.resident_limit_bytes),
        )
    };
    configure_offline_gdal_command(&mut command, executable);
    command.args(&normalized_arguments);
    if let Some(directory) = gdal_temp_directory {
        command
            .env("CPL_TMPDIR", directory)
            .env("GDAL_TMPDIR", directory);
    }
    if let Some(parent) = executable.parent() {
        if parent.join("liblaszip.so").is_file() {
            command.env("LD_LIBRARY_PATH", parent);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "linux")]
    if matches!(
        worker_limit_plan,
        Some(WorkerMemoryLimitPlan {
            mode: WorkerMemoryLimitMode::CgroupScope,
            ..
        })
    ) {
        configure_systemd_user_bus_environment(&mut command);
    }
    let mut child = process_group::spawn(&mut command)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.terminate_and_wait();
        return Err(DenseRasterPrepError::Io(std::io::Error::other(
            "GDAL child did not expose its captured stdout",
        )));
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.terminate_and_wait();
        return Err(DenseRasterPrepError::Io(std::io::Error::other(
            "GDAL child did not expose its captured stderr",
        )));
    };
    let stdout_reader = spawn_output_reader(stdout, stdout_destination);
    let stderr_reader = spawn_output_reader(stderr, None);
    loop {
        if cancellation.is_cancel_requested() {
            let _ = child.terminate_and_wait();
            let _ = join_output_reader(stdout_reader);
            let _ = join_output_reader(stderr_reader);
            record_command_memory(memory, worker_limit_plan, child.peak_rss_bytes())?;
            return Err(DenseRasterPrepError::Cancelled);
        }
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                let _ = child.terminate_and_wait();
                let _ = join_output_reader(stdout_reader);
                let _ = join_output_reader(stderr_reader);
                record_command_memory(memory, worker_limit_plan, child.peak_rss_bytes())?;
                return Err(DenseRasterPrepError::Io(error));
            }
        };
        if let Some(status) = status {
            let stdout_result = join_output_reader(stdout_reader);
            let stderr_result = join_output_reader(stderr_reader);
            let _stdout_tail = stdout_result?;
            let stderr_tail = stderr_result?;
            let peak_rss_bytes = child.peak_rss_bytes();
            record_command_memory(memory, worker_limit_plan, peak_rss_bytes)?;
            if status.success() {
                return Ok(());
            }
            if status_indicates_memory_limit(&status, &stderr_tail) {
                if let (Some(memory), Some(limit)) = (memory, worker_limit_plan) {
                    memory
                        .sink
                        .record_worker_memory_limit_hit(
                            memory.plan.stage,
                            limit.enforced_limit_bytes,
                        )
                        .map_err(|error| DenseRasterPrepError::MemoryRecord(error.to_string()))?;
                    return Err(DenseRasterPrepError::WorkerMemoryLimit {
                        stage: memory.plan.stage.into(),
                        limit_bytes: limit.enforced_limit_bytes,
                        peak_rss_bytes,
                    });
                }
            }
            return Err(DenseRasterPrepError::GdalFailed {
                command: command_description,
                code: status.code(),
                stderr_tail: String::from_utf8_lossy(&stderr_tail).into_owned(),
            });
        }
        thread::sleep(POLL);
    }
}

fn record_command_memory(
    memory: Option<GdalCommandMemory<'_>>,
    worker_limit_plan: Option<WorkerMemoryLimitPlan>,
    peak_rss_bytes: u64,
) -> Result<(), DenseRasterPrepError> {
    let Some(memory) = memory else {
        return Ok(());
    };
    let mut parameters = serde_json::json!({
        "modelBytes": memory.plan.model_bytes,
        "workerMemoryLimitBytes": memory.plan.resident_limit_bytes,
    });
    if let (Some(parameters), Some(limit)) = (parameters.as_object_mut(), worker_limit_plan) {
        parameters.insert(
            "workerMemoryLimitBytes".into(),
            limit.enforced_limit_bytes.into(),
        );
        parameters.insert("workerMemoryLimitMode".into(), limit.mode.as_str().into());
    }
    memory
        .sink
        .record_stage_peak(memory.plan.stage, peak_rss_bytes, 1, parameters)
        .map_err(|error| DenseRasterPrepError::MemoryRecord(error.to_string()))
}

fn status_indicates_memory_limit(status: &std::process::ExitStatus, stderr: &[u8]) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if matches!(status.signal(), Some(6 | 9 | 11)) {
            return true;
        }
    }
    let lower = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    [
        "cannot allocate memory",
        "failed to map segment",
        "memory allocation",
        "std::bad_alloc",
        "out of memory",
        "oom-kill",
        "killed",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn spawn_output_reader<R>(
    mut reader: R,
    mut destination: Option<File>,
) -> thread::JoinHandle<std::io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut tail = Vec::with_capacity(GDAL_OUTPUT_TAIL_BYTES);
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if let Some(writer) = destination.as_mut() {
                writer.write_all(&buffer[..count])?;
            }
            extend_bounded_tail(&mut tail, &buffer[..count]);
        }
        if let Some(writer) = destination.as_mut() {
            writer.flush()?;
        }
        Ok(tail)
    })
}

fn join_output_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> std::io::Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| std::io::Error::other("GDAL output reader panicked"))?
}

fn extend_bounded_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= GDAL_OUTPUT_TAIL_BYTES {
        tail.clear();
        tail.extend_from_slice(&bytes[bytes.len() - GDAL_OUTPUT_TAIL_BYTES..]);
        return;
    }
    let overflow = tail
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(GDAL_OUTPUT_TAIL_BYTES);
    if overflow > 0 {
        tail.drain(..overflow);
    }
    tail.extend_from_slice(bytes);
}

fn diagnostic_command(executable: &Path, arguments: &[String]) -> String {
    std::iter::once(diagnostic_path(executable))
        .chain(arguments.iter().map(|argument| {
            let path = Path::new(argument);
            if path.is_absolute() {
                diagnostic_path(path)
            } else {
                argument.clone()
            }
        }))
        .map(|argument| format!("{argument:?}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn diagnostic_path(path: &Path) -> String {
    if let Some(project_root) = path.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension == "hcad")
    }) {
        let relative = path.strip_prefix(project_root).unwrap_or(path);
        return if relative.as_os_str().is_empty() {
            "<project>".into()
        } else {
            format!("<project>/{}", relative.to_string_lossy())
        };
    }
    if let Ok(current) = std::env::current_dir() {
        if let Ok(relative) = path.strip_prefix(current) {
            return relative.to_string_lossy().into_owned();
        }
    }
    path.to_string_lossy().into_owned()
}

fn configure_offline_gdal_command(command: &mut Command, executable: &Path) {
    command
        .env_clear()
        .env("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
        .env("PROJ_NETWORK", "OFF")
        .env("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", "");
    if let Some(prefix) = executable.parent().and_then(Path::parent) {
        let gdal_data = prefix.join("share/gdal");
        if gdal_data.is_dir() {
            command.env("GDAL_DATA", gdal_data);
        }
        let proj_data = prefix.join("share/proj");
        if proj_data.is_dir() {
            command.env("PROJ_DATA", proj_data);
        }
    }
}

#[cfg(windows)]
fn external_tool_argument(value: &str) -> String {
    if let Some(suffix) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{suffix}")
    } else if let Some(suffix) = value.strip_prefix(r"\\?\") {
        suffix.to_owned()
    } else {
        value.to_owned()
    }
}

#[cfg(not(windows))]
fn external_tool_argument(value: &str) -> String {
    value.to_owned()
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::*;

    #[cfg(windows)]
    #[test]
    fn gdal_arguments_strip_windows_verbatim_prefixes() {
        assert_eq!(
            external_tool_argument(r"\\?\C:\project\dense.csv"),
            r"C:\project\dense.csv"
        );
        assert_eq!(
            external_tool_argument(r"\\?\UNC\server\share\dense.csv"),
            r"\\server\share\dense.csv"
        );
        assert_eq!(external_tool_argument("EPSG:31468"), "EPSG:31468");
    }
}
