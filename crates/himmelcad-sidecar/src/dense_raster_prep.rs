//! Streaming conversion of the portable dense PLY into audited GDAL inputs.

use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const RECORD_BYTES: usize = 19;
const POLL: Duration = Duration::from_millis(15);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDenseVector {
    pub flatgeobuf_path: PathBuf,
    pub layer: String,
    pub point_count: u64,
    pub minimum: [f64; 3],
    pub maximum: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPotreeCloud {
    pub relative_metadata_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_relative_path: Option<PathBuf>,
    pub point_count: u64,
    pub render_offset: [f64; 3],
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

#[derive(Debug, Error)]
pub enum DenseRasterPrepError {
    #[error("invalid portable dense PLY: {0}")]
    InvalidPly(String),
    #[error("dense raster preparation was cancelled")]
    Cancelled,
    #[error("GDAL preparation command failed with exit code {0:?}")]
    GdalFailed(Option<i32>),
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
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root)?;
    let csv_path = output_root.join("dense.csv");
    let fgb_path = output_root.join("dense.fgb");
    let (point_count, minimum, maximum) = ply_to_csv(dense_ply, &csv_path, cancellation)?;
    run_command(
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
            "-a_srs",
            gdal_srs,
            "-nln",
            "dense_points",
            "-overwrite",
        ],
        cancellation,
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
    let mut las = BufWriter::with_capacity(1024 * 1024, File::create(&las_path)?);
    write_las_header(
        &mut las,
        point_count,
        minimum,
        maximum,
        scale,
        "HimmelCAD sparse COLMAP to LAS",
    )?;
    let mut ply = BufWriter::with_capacity(1024 * 1024, File::create(&export_path)?);
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
fn quantize_las_coordinate(value: f64, minimum: f64, scale: f64) -> i32 {
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
struct ColmapSparsePoint {
    coordinate: [f64; 3],
    color: [u8; 3],
    reprojection_error: f64,
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

fn parse_colmap_sparse_point(
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

fn write_las_header(
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
        run_owned_command(gdal_grid, &arguments, cancellation)?;
        bands.push(output);
    }
    let vrt = output_root.join("orthophoto.vrt");
    let mut arguments = vec!["-separate".to_owned(), vrt.to_string_lossy().into_owned()];
    arguments.extend(bands.iter().map(|path| path.to_string_lossy().into_owned()));
    run_owned_command(gdalbuildvrt, &arguments, cancellation)?;
    Ok(vrt)
}

/// Reads the exact WKT emitted by GDAL for the prepared vector dataset.
pub fn inspect_vector_wkt(
    ogrinfo: &Path,
    vector: &PreparedDenseVector,
    cancellation: &CancellationToken,
) -> Result<String, DenseRasterPrepError> {
    let output_path = vector.flatgeobuf_path.with_extension("ogrinfo.json");
    let mut child = Command::new(ogrinfo)
        .args([
            "-json",
            "-so",
            vector.flatgeobuf_path.to_string_lossy().as_ref(),
            vector.layer.as_str(),
        ])
        .env_clear()
        .env("PROJ_NETWORK", "OFF")
        .stdin(Stdio::null())
        .stdout(File::create(&output_path)?)
        .stderr(Stdio::null())
        .spawn()?;
    loop {
        if cancellation.is_cancel_requested() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DenseRasterPrepError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(DenseRasterPrepError::GdalFailed(status.code()));
            }
            break;
        }
        thread::sleep(POLL);
    }
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
    let mut child = Command::new(gdalinfo)
        .args(["-json", raster.to_string_lossy().as_ref()])
        .env_clear()
        .env("PROJ_NETWORK", "OFF")
        .stdin(Stdio::null())
        .stdout(File::create(&output_path)?)
        .stderr(Stdio::null())
        .spawn()?;
    loop {
        if cancellation.is_cancel_requested() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DenseRasterPrepError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(DenseRasterPrepError::GdalFailed(status.code()));
            }
            break;
        }
        thread::sleep(POLL);
    }
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

fn ply_to_csv(
    path: &Path,
    csv_path: &Path,
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
    let header_text = String::from_utf8_lossy(&header);
    for required in [
        "format binary_little_endian 1.0",
        "property float x",
        "property float y",
        "property float z",
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
    writer.write_all(b"x,y,z,red,green,blue,confidence\n")?;
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    let mut record = [0_u8; RECORD_BYTES];
    for index in 0..vertex_count {
        if index % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let values = [
            f32::from_le_bytes(record[0..4].try_into().expect("fixed slice")) as f64,
            f32::from_le_bytes(record[4..8].try_into().expect("fixed slice")) as f64,
            f32::from_le_bytes(record[8..12].try_into().expect("fixed slice")) as f64,
        ];
        if values.iter().any(|value| !value.is_finite()) {
            return Err(DenseRasterPrepError::InvalidPly(
                "non-finite coordinate".into(),
            ));
        }
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(values[axis]);
            maximum[axis] = maximum[axis].max(values[axis]);
        }
        let confidence = f32::from_le_bytes(record[15..19].try_into().expect("fixed slice"));
        writeln!(
            writer,
            "{},{},{},{},{},{},{}",
            values[0], values[1], values[2], record[12], record[13], record[14], confidence
        )?;
    }
    writer.flush()?;
    Ok((vertex_count, minimum, maximum))
}

fn ply_to_las(
    path: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    let (vertex_count, data_offset, minimum, maximum) = inspect_ply(path, cancellation)?;
    if vertex_count > u64::from(u32::MAX) {
        return Err(DenseRasterPrepError::InvalidPly(
            "LAS 1.2 point limit exceeded".into(),
        ));
    }
    let scale =
        [0, 1, 2].map(|axis| ((maximum[axis] - minimum[axis]) / f64::from(i32::MAX)).max(0.001));
    let mut writer = BufWriter::with_capacity(1024 * 1024, File::create(output)?);
    let mut header = vec![0_u8; 227];
    header[0..4].copy_from_slice(b"LASF");
    header[24] = 1;
    header[25] = 2;
    copy_ascii(&mut header[26..58], "HimmelCAD PhotoLab");
    copy_ascii(&mut header[58..90], "HimmelCAD dense PLY to LAS");
    header[94..96].copy_from_slice(&227_u16.to_le_bytes());
    header[96..100].copy_from_slice(&227_u32.to_le_bytes());
    header[104] = 2;
    header[105..107].copy_from_slice(&26_u16.to_le_bytes());
    let count = u32::try_from(vertex_count).expect("bounded above");
    header[107..111].copy_from_slice(&count.to_le_bytes());
    header[111..115].copy_from_slice(&count.to_le_bytes());
    for axis in 0..3 {
        header[131 + axis * 8..139 + axis * 8].copy_from_slice(&scale[axis].to_le_bytes());
    }
    for axis in 0..3 {
        header[155 + axis * 8..163 + axis * 8].copy_from_slice(&minimum[axis].to_le_bytes());
    }
    for (offset, value) in [
        (179, maximum[0]),
        (187, minimum[0]),
        (195, maximum[1]),
        (203, minimum[1]),
        (211, maximum[2]),
        (219, minimum[2]),
    ] {
        header[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    writer.write_all(&header)?;
    let mut reader = BufReader::new(File::open(path)?);
    use std::io::Seek;
    reader.seek(std::io::SeekFrom::Start(data_offset))?;
    let mut record = [0_u8; RECORD_BYTES];
    for index in 0..vertex_count {
        if index % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        let coordinates = [
            f32::from_le_bytes(record[0..4].try_into().expect("fixed")) as f64,
            f32::from_le_bytes(record[4..8].try_into().expect("fixed")) as f64,
            f32::from_le_bytes(record[8..12].try_into().expect("fixed")) as f64,
        ];
        for axis in 0..3 {
            let quantized = ((coordinates[axis] - minimum[axis]) / scale[axis]).round() as i32;
            writer.write_all(&quantized.to_le_bytes())?;
        }
        let confidence =
            f32::from_le_bytes(record[15..19].try_into().expect("fixed")).clamp(0.0, 1.0);
        let intensity = (confidence * 65_535.0).round() as u16;
        writer.write_all(&intensity.to_le_bytes())?;
        writer.write_all(&[0b0000_1001, 1, 0, 0, 0, 0])?;
        for color in &record[12..15] {
            writer.write_all(&(u16::from(*color) * 257).to_le_bytes())?;
        }
    }
    writer.flush()?;
    Ok(())
}

fn inspect_ply(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(u64, u64, [f64; 3], [f64; 3]), DenseRasterPrepError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut offset = 0_u64;
    let mut vertex_count = None;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 || offset > 64 * 1024 {
            return Err(DenseRasterPrepError::InvalidPly(
                "unterminated header".into(),
            ));
        }
        offset += u64::try_from(read).expect("usize fits u64");
        if let Some(value) = line.strip_prefix("element vertex ") {
            vertex_count = value.trim().parse().ok();
        }
        if line.trim() == "end_header" {
            break;
        }
    }
    let vertex_count = vertex_count
        .ok_or_else(|| DenseRasterPrepError::InvalidPly("vertex count missing".into()))?;
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    let mut record = [0_u8; RECORD_BYTES];
    for index in 0..vertex_count {
        if index % 8_192 == 0 && cancellation.is_cancel_requested() {
            return Err(DenseRasterPrepError::Cancelled);
        }
        reader.read_exact(&mut record)?;
        for axis in 0..3 {
            let start = axis * 4;
            let value =
                f32::from_le_bytes(record[start..start + 4].try_into().expect("fixed")) as f64;
            if !value.is_finite() {
                return Err(DenseRasterPrepError::InvalidPly(
                    "non-finite coordinate".into(),
                ));
            }
            minimum[axis] = minimum[axis].min(value);
            maximum[axis] = maximum[axis].max(value);
        }
    }
    Ok((vertex_count, offset, minimum, maximum))
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

fn run_command(
    executable: &Path,
    arguments: &[&str],
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    let owned = arguments
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    run_owned_command(executable, &owned, cancellation)
}

fn run_owned_command(
    executable: &Path,
    arguments: &[String],
    cancellation: &CancellationToken,
) -> Result<(), DenseRasterPrepError> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env_clear()
        .env("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
        .env("PROJ_NETWORK", "OFF")
        .env("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", "");
    if let Some(parent) = executable.parent() {
        if parent.join("liblaszip.so").is_file() {
            command.env("LD_LIBRARY_PATH", parent);
        }
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    loop {
        if cancellation.is_cancel_requested() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DenseRasterPrepError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(DenseRasterPrepError::GdalFailed(status.code()))
            };
        }
        thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_colmap_sparse_points_without_losing_world_precision() {
        let point = parse_colmap_sparse_point(
            "42 500000.123456789 5400000.987654321 412.125 12 34 56 0.25 1 2",
        )
        .expect("valid record")
        .expect("point");
        assert!((point.coordinate[0] - 500_000.123_456_789).abs() < f64::EPSILON);
        assert!((point.coordinate[1] - 5_400_000.987_654_321).abs() < f64::EPSILON);
        assert_eq!(point.color, [12, 34, 56]);
        assert!((point.reprojection_error - 0.25).abs() < f64::EPSILON);
        assert!(parse_colmap_sparse_point("# comment").unwrap().is_none());
        assert!(parse_colmap_sparse_point("1 nan 2 3 4 5 6 0.1").is_err());
    }

    #[test]
    fn las_header_bounds_include_quantized_sparse_extrema() {
        let minimum = [
            600_717.888_652_278_2,
            5_279_110.353_927_144,
            737.980_228_639_967_7,
        ];
        let maximum = [
            600_773.938_272_826_6,
            5_279_166.403_547_692,
            794.029_849_188_347_3,
        ];
        let scale = [0.001; 3];
        let mut header = Vec::new();
        write_las_header(&mut header, 1, minimum, maximum, scale, "test").unwrap();
        for (axis, offset) in [179, 195, 211].into_iter().enumerate() {
            let header_max = f64::from_le_bytes(header[offset..offset + 8].try_into().unwrap());
            let stored_max = minimum[axis]
                + f64::from(quantize_las_coordinate(
                    maximum[axis],
                    minimum[axis],
                    scale[axis],
                )) * scale[axis];
            assert_eq!(header_max, stored_max);
            assert!(header_max >= stored_max);
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn sparse_preparation_builds_potree_and_portable_ply() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("hcad-sparse-prep-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let points = root.join("points3D.txt");
        fs::write(
            &points,
            "# points\n1 500000.125 5400000.25 100.5 255 0 0 0.2 1 0\n2 500001.5 5400002.75 102.0 0 255 32 0.4 2 0\n",
        )
        .unwrap();
        let converter = root.join("PotreeConverter");
        fs::write(
            &converter,
            r#"#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
mkdir -p "$out"
printf '%s' '{"points":2,"offset":[500000,5400000,100],"boundingBox":{"min":[500000.125,5400000.25,100.5],"max":[500001.5,5400002.75,102.0]}}' > "$out/metadata.json"
: > "$out/hierarchy.bin"
: > "$out/octree.bin"
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&converter).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&converter, permissions).unwrap();
        let output = root.join("prepared");
        let prepared =
            prepare_sparse_potree(&points, &output, &converter, &CancellationToken::new())
                .expect("prepare sparse point cloud");
        assert_eq!(prepared.point_count, 2);
        assert_eq!(
            prepared.relative_metadata_path,
            PathBuf::from("octree/metadata.json")
        );
        assert_eq!(
            prepared.export_relative_path,
            Some(PathBuf::from("export.ply"))
        );
        assert!(prepared
            .bounds_min
            .iter()
            .zip([500_000.125, 5_400_000.25, 100.5])
            .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON));
        let export = fs::read(output.join("export.ply")).expect("portable PLY");
        assert!(export
            .windows(b"element vertex 2".len())
            .any(|window| window == b"element vertex 2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_non_ply_header() {
        let root = std::env::temp_dir().join(format!("hcad-dense-prep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("bad.ply"), b"not ply\n").unwrap();
        assert!(matches!(
            ply_to_csv(
                &root.join("bad.ply"),
                &root.join("x.csv"),
                &CancellationToken::new()
            ),
            Err(DenseRasterPrepError::InvalidPly(_))
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn system_gdal_accepts_the_streamed_flatgeobuf() {
        if !Path::new("/usr/bin/ogr2ogr").is_file() || !Path::new("/usr/bin/ogrinfo").is_file() {
            return;
        }
        let root =
            std::env::temp_dir().join(format!("hcad-dense-prep-gdal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let ply = root.join("dense.ply");
        let mut file = File::create(&ply).unwrap();
        file.write_all(b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\nend_header\n").unwrap();
        for (x, y, z, color) in [
            (500_000_f32, 5_400_000_f32, 100_f32, [255, 0, 0]),
            (500_001_f32, 5_400_000_f32, 101_f32, [0, 255, 0]),
            (500_000_f32, 5_400_001_f32, 102_f32, [0, 0, 255]),
        ] {
            for value in [x, y, z] {
                file.write_all(&value.to_le_bytes()).unwrap();
            }
            file.write_all(&color).unwrap();
            file.write_all(&1_f32.to_le_bytes()).unwrap();
        }
        drop(file);
        let cancellation = CancellationToken::new();
        let vector = prepare_dense_vector(
            &ply,
            &root.join("vector"),
            Path::new("/usr/bin/ogr2ogr"),
            "EPSG:25832",
            &cancellation,
        )
        .unwrap();
        assert_eq!(vector.point_count, 3);
        let wkt =
            inspect_vector_wkt(Path::new("/usr/bin/ogrinfo"), &vector, &cancellation).unwrap();
        assert!(wkt.contains("ETRS89"));
        let converter = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../vendor/potreeconverter/linux-x64/PotreeConverter");
        if converter.is_file() {
            let potree =
                prepare_dense_potree(&ply, &root.join("potree"), &converter, &cancellation)
                    .unwrap();
            assert_eq!(potree.point_count, 3);
            assert!(root.join("potree/octree/metadata.json").is_file());
        }
        let _ = fs::remove_dir_all(root);
    }
}
