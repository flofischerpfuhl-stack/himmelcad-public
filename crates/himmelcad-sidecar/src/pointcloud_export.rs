//! Streaming, cancellable PLY to LAS/LAZ product export.

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use himmelcad_core::photolab_jobs::CancellationToken;
use las::{point::Classification, Builder, Color, Point, Transform, Vector, Writer};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const SCALE_METERS: f64 = 0.001;
const POINT_CHUNK: u64 = 8_192;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_POINTS: u64 = 4_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PointCloudExportFormat {
    Ply,
    Las,
    Laz,
}

impl PointCloudExportFormat {
    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Ply => "ply",
            Self::Las => "las",
            Self::Laz => "laz",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointCloudExportSummary {
    pub point_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Error)]
pub enum PointCloudExportError {
    #[error("point-cloud export was cancelled")]
    Cancelled,
    #[error("invalid binary PLY: {0}")]
    InvalidPly(String),
    #[error("LAS/LAZ encoding failed: {0}")]
    Las(#[from] las::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy)]
enum ScalarType {
    F32,
    F64,
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
}

impl ScalarType {
    const fn width(self) -> usize {
        match self {
            Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            Self::F32 | Self::U32 | Self::I32 => 4,
            Self::F64 | Self::U64 | Self::I64 => 8,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Property {
    scalar: ScalarType,
    offset: usize,
}

#[derive(Debug)]
struct PlyLayout {
    header_bytes: u64,
    point_count: u64,
    stride: usize,
    xyz: [Property; 3],
    rgb: [Property; 3],
}

/// Converts one validated binary little-endian point cloud and publishes it atomically.
///
/// The source is scanned twice: once for finite bounds and once for encoding. Memory use is
/// bounded by one vertex record plus the LAS/LAZ writer's compression buffers.
pub fn transcode_ply_atomic(
    source: &Path,
    destination: &Path,
    operation_id: &str,
    format: PointCloudExportFormat,
    crs_wkt: Option<&str>,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<PointCloudExportSummary, PointCloudExportError> {
    if format == PointCloudExportFormat::Ply {
        return Err(PointCloudExportError::InvalidPly(
            "PLY passthrough does not require transcoding".into(),
        ));
    }
    validate_operation_id(operation_id)?;
    check_cancelled(cancellation)?;
    let source = source.canonicalize()?;
    if !source.is_file() {
        return Err(PointCloudExportError::InvalidPly(
            "source is not a regular file".into(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| PointCloudExportError::InvalidPly("destination has no parent".into()))?
        .canonicalize()?;
    let name = destination
        .file_name()
        .ok_or_else(|| PointCloudExportError::InvalidPly("destination has no filename".into()))?;
    let destination = parent.join(name);
    if destination == source {
        return invalid("source and destination overlap");
    }
    let temporary = parent.join(format!(
        ".{}.{}.partial.{}",
        name.to_string_lossy(),
        operation_id,
        format.extension()
    ));
    remove_file_if_present(&temporary)?;
    let result = (|| {
        let layout = read_layout(&source)?;
        let classification_path = source.with_file_name("dense.classification.bin");
        let classification_path = if classification_path.exists() {
            let length = classification_path.metadata()?.len();
            if length != layout.point_count {
                return invalid("classification sidecar length differs from the PLY vertex count");
            }
            Some(classification_path)
        } else {
            None
        };
        let total_work = layout.point_count.saturating_mul(2);
        let bounds = scan_bounds(&source, &layout, cancellation, total_work, &mut progress)?;
        check_quantization_range(bounds)?;
        write_las(
            &source,
            &temporary,
            &layout,
            classification_path.as_deref(),
            bounds,
            crs_wkt,
            cancellation,
            total_work,
            &mut progress,
        )?;
        check_cancelled(cancellation)?;
        crate::product_export::publish_replace(&temporary, &destination, operation_id).map_err(
            |error| match error {
                crate::product_export::ProductExportError::Io(error) => {
                    PointCloudExportError::Io(error)
                }
                other => PointCloudExportError::InvalidPly(other.to_string()),
            },
        )?;
        Ok(PointCloudExportSummary {
            point_count: layout.point_count,
            bytes: destination.metadata()?.len(),
        })
    })();
    if result.is_err() {
        let _ = remove_file_if_present(&temporary);
    }
    result
}

fn read_layout(path: &Path) -> Result<PlyLayout, PointCloudExportError> {
    let file = File::open(path)?;
    let file_bytes = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut header_bytes = 0_usize;
    let mut binary_little_endian = false;
    let mut point_count = None;
    let mut in_vertices = false;
    let mut stride = 0_usize;
    let mut xyz = [None; 3];
    let mut rgb = [None; 3];
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 || header_bytes.saturating_add(read) > MAX_HEADER_BYTES {
            return invalid("header is missing or too large");
        }
        header_bytes += read;
        let value = line.trim();
        if header_bytes == read && value != "ply" {
            return invalid("missing PLY signature");
        }
        if value == "format binary_little_endian 1.0" {
            binary_little_endian = true;
        } else if let Some(count) = value.strip_prefix("element vertex ") {
            point_count = count.parse::<u64>().ok();
            in_vertices = true;
            continue;
        } else if value.starts_with("element ") {
            in_vertices = false;
        } else if in_vertices && value.starts_with("property ") {
            let fields = value.split_whitespace().collect::<Vec<_>>();
            if fields.len() != 3 {
                return invalid("vertex list properties are not supported");
            }
            let scalar = scalar_type(fields[1])?;
            let property = Property {
                scalar,
                offset: stride,
            };
            match fields[2] {
                "x" => xyz[0] = Some(property),
                "y" => xyz[1] = Some(property),
                "z" => xyz[2] = Some(property),
                "red" | "r" => rgb[0] = Some(property),
                "green" | "g" => rgb[1] = Some(property),
                "blue" | "b" => rgb[2] = Some(property),
                _ => {}
            }
            stride = stride.checked_add(scalar.width()).ok_or_else(|| {
                PointCloudExportError::InvalidPly("vertex stride overflow".into())
            })?;
        }
        if value == "end_header" {
            break;
        }
    }
    let point_count = point_count
        .filter(|count| *count > 0 && *count <= MAX_POINTS)
        .ok_or_else(|| PointCloudExportError::InvalidPly("invalid vertex count".into()))?;
    if !binary_little_endian || stride == 0 {
        return invalid("expected binary_little_endian 1.0 vertices");
    }
    let xyz = required_properties(xyz, "x/y/z")?;
    if xyz
        .iter()
        .any(|property| !matches!(property.scalar, ScalarType::F32 | ScalarType::F64))
    {
        return invalid("x/y/z properties must be float or double");
    }
    let rgb = required_properties(rgb, "red/green/blue")?;
    if rgb
        .iter()
        .any(|property| !matches!(property.scalar, ScalarType::U8))
    {
        return invalid("RGB properties must be unsigned bytes");
    }
    let payload = point_count
        .checked_mul(u64::try_from(stride).unwrap_or(u64::MAX))
        .and_then(|bytes| bytes.checked_add(u64::try_from(header_bytes).unwrap_or(u64::MAX)))
        .ok_or_else(|| PointCloudExportError::InvalidPly("payload size overflow".into()))?;
    if file_bytes < payload {
        return invalid("vertex payload is truncated");
    }
    Ok(PlyLayout {
        header_bytes: u64::try_from(header_bytes).unwrap_or(u64::MAX),
        point_count,
        stride,
        xyz,
        rgb,
    })
}

fn required_properties(
    values: [Option<Property>; 3],
    label: &str,
) -> Result<[Property; 3], PointCloudExportError> {
    match values {
        [Some(a), Some(b), Some(c)] => Ok([a, b, c]),
        _ => invalid(&format!("missing {label} properties")),
    }
}

fn scalar_type(value: &str) -> Result<ScalarType, PointCloudExportError> {
    match value {
        "float" | "float32" => Ok(ScalarType::F32),
        "double" | "float64" => Ok(ScalarType::F64),
        "uchar" | "uint8" => Ok(ScalarType::U8),
        "char" | "int8" => Ok(ScalarType::I8),
        "ushort" | "uint16" => Ok(ScalarType::U16),
        "short" | "int16" => Ok(ScalarType::I16),
        "uint" | "uint32" => Ok(ScalarType::U32),
        "int" | "int32" => Ok(ScalarType::I32),
        "uint64" => Ok(ScalarType::U64),
        "int64" => Ok(ScalarType::I64),
        other => invalid(&format!("unsupported property type {other}")),
    }
}

fn scan_bounds(
    path: &Path,
    layout: &PlyLayout,
    cancellation: &CancellationToken,
    total_work: u64,
    progress: &mut impl FnMut(u64, u64),
) -> Result<([f64; 3], [f64; 3]), PointCloudExportError> {
    let mut reader = point_reader(path, layout)?;
    let mut record = vec![0_u8; layout.stride];
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    progress(0, total_work);
    for index in 0..layout.point_count {
        if index.is_multiple_of(POINT_CHUNK) {
            check_cancelled(cancellation)?;
            progress(index, total_work);
        }
        reader.read_exact(&mut record)?;
        let coordinate = coordinates(&record, layout)?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(coordinate[axis]);
            maximum[axis] = maximum[axis].max(coordinate[axis]);
        }
    }
    progress(layout.point_count, total_work);
    Ok((minimum, maximum))
}

fn write_las(
    source: &Path,
    destination: &Path,
    layout: &PlyLayout,
    classification_path: Option<&Path>,
    bounds: ([f64; 3], [f64; 3]),
    crs_wkt: Option<&str>,
    cancellation: &CancellationToken,
    total_work: u64,
    progress: &mut impl FnMut(u64, u64),
) -> Result<(), PointCloudExportError> {
    let mut builder = Builder::from((1, 4));
    builder.generating_software = "HimmelCAD PhotoLab".into();
    builder.system_identifier = "PhotoLab point-cloud export".into();
    builder.point_format = las::point::Format::new(2)?;
    builder.transforms = Vector {
        x: Transform {
            scale: SCALE_METERS,
            offset: bounds.0[0],
        },
        y: Transform {
            scale: SCALE_METERS,
            offset: bounds.0[1],
        },
        z: Transform {
            scale: SCALE_METERS,
            offset: bounds.0[2],
        },
    };
    let mut header = builder.into_header()?;
    if let Some(wkt) = crs_wkt.map(str::trim).filter(|wkt| !wkt.is_empty()) {
        let mut bytes = wkt.as_bytes().to_vec();
        if !bytes.ends_with(&[0]) {
            bytes.push(0);
        }
        header.set_wkt_crs(bytes)?;
    }
    let mut writer = Writer::from_path(destination, header)?;
    let mut reader = point_reader(source, layout)?;
    let mut classifications = classification_path
        .map(File::open)
        .transpose()?
        .map(BufReader::new);
    let mut record = vec![0_u8; layout.stride];
    let mut classification = [0_u8; 1];
    for index in 0..layout.point_count {
        if index.is_multiple_of(POINT_CHUNK) {
            check_cancelled(cancellation)?;
            progress(layout.point_count.saturating_add(index), total_work);
        }
        reader.read_exact(&mut record)?;
        let coordinate = coordinates(&record, layout)?;
        let classification = if let Some(reader) = classifications.as_mut() {
            reader.read_exact(&mut classification)?;
            match classification[0] {
                1 => Classification::Unclassified,
                2 => Classification::Ground,
                _ => return invalid("classification sidecar contains a value other than 1 or 2"),
            }
        } else {
            Classification::CreatedNeverClassified
        };
        writer.write_point(Point {
            x: coordinate[0],
            y: coordinate[1],
            z: coordinate[2],
            color: Some(Color::new(
                u16::from(read_u8(&record, layout.rgb[0])?) * 257,
                u16::from(read_u8(&record, layout.rgb[1])?) * 257,
                u16::from(read_u8(&record, layout.rgb[2])?) * 257,
            )),
            classification,
            ..Point::default()
        })?;
    }
    check_cancelled(cancellation)?;
    writer.close()?;
    OpenOptions::new()
        .write(true)
        .open(destination)?
        .sync_all()?;
    progress(total_work, total_work);
    Ok(())
}

fn point_reader(path: &Path, layout: &PlyLayout) -> Result<BufReader<File>, std::io::Error> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(layout.header_bytes))?;
    Ok(BufReader::with_capacity(1024 * 1024, file))
}

fn coordinates(record: &[u8], layout: &PlyLayout) -> Result<[f64; 3], PointCloudExportError> {
    let values = [
        read_float(record, layout.xyz[0])?,
        read_float(record, layout.xyz[1])?,
        read_float(record, layout.xyz[2])?,
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return invalid("coordinate is not finite");
    }
    Ok(values)
}

fn read_float(record: &[u8], property: Property) -> Result<f64, PointCloudExportError> {
    let bytes = field(record, property)?;
    match property.scalar {
        ScalarType::F32 => Ok(f64::from(f32::from_le_bytes(
            bytes.try_into().expect("four-byte property"),
        ))),
        ScalarType::F64 => Ok(f64::from_le_bytes(
            bytes.try_into().expect("eight-byte property"),
        )),
        _ => invalid("coordinate property is not floating point"),
    }
}

fn read_u8(record: &[u8], property: Property) -> Result<u8, PointCloudExportError> {
    if !matches!(property.scalar, ScalarType::U8) {
        return invalid("color property is not an unsigned byte");
    }
    Ok(field(record, property)?[0])
}

fn field(record: &[u8], property: Property) -> Result<&[u8], PointCloudExportError> {
    record
        .get(property.offset..property.offset.saturating_add(property.scalar.width()))
        .ok_or_else(|| PointCloudExportError::InvalidPly("property exceeds vertex stride".into()))
}

fn check_quantization_range(
    (minimum, maximum): ([f64; 3], [f64; 3]),
) -> Result<(), PointCloudExportError> {
    let maximum_span = f64::from(i32::MAX) * SCALE_METERS;
    if (0..3).any(|axis| maximum[axis] - minimum[axis] > maximum_span) {
        return invalid("one axis exceeds the LAS 1 mm quantization range");
    }
    Ok(())
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), PointCloudExportError> {
    if cancellation.is_cancel_requested() {
        Err(PointCloudExportError::Cancelled)
    } else {
        Ok(())
    }
}

fn validate_operation_id(value: &str) -> Result<(), PointCloudExportError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return invalid("operation id is not a safe path component");
    }
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), std::io::Error> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn invalid<T>(message: &str) -> Result<T, PointCloudExportError> {
    Err(PointCloudExportError::InvalidPly(message.into()))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use las::Reader;

    use super::*;

    fn root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "himmelcad-pointcloud-export-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("root");
        path
    }

    fn write_ply(path: &Path, count: usize) -> Vec<([f64; 3], [u8; 3])> {
        use std::io::Write as _;
        let expected = (0..count)
            .map(|index| {
                let coordinate = [
                    654_321.123_4 + index as f64 * 0.000_7,
                    5_432_100.987_6 + index as f64 * 0.001_1,
                    412.345_6 - index as f64 * 0.000_3,
                ];
                let color = [
                    u8::try_from(index % 251).unwrap(),
                    u8::try_from((index + 17) % 251).unwrap(),
                    u8::try_from((index + 37) % 251).unwrap(),
                ];
                (coordinate, color)
            })
            .collect::<Vec<_>>();
        let mut file = File::create(path).expect("PLY");
        write!(
            file,
            "ply\nformat binary_little_endian 1.0\nelement vertex {count}\n\
             property double x\nproperty double y\nproperty double z\n\
             property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
        )
        .expect("header");
        for (coordinate, color) in &expected {
            for value in coordinate {
                file.write_all(&value.to_le_bytes()).expect("coordinate");
            }
            file.write_all(color).expect("color");
        }
        expected
    }

    #[test]
    fn las_14_format_2_preserves_count_color_classification_scale_offset_and_wkt() {
        let root = root("header");
        let source = root.join("source.ply");
        let destination = root.join("output.las");
        let expected = write_ply(&source, 3);
        fs::write(root.join("dense.classification.bin"), [2_u8, 1, 2])
            .expect("classification sidecar");
        let wkt = "PROJCRS[\"ETRS89 / UTM zone 32N\"]";
        let summary = transcode_ply_atomic(
            &source,
            &destination,
            "header-test",
            PointCloudExportFormat::Las,
            Some(wkt),
            &CancellationToken::new(),
            |_, _| {},
        )
        .expect("transcode");
        assert_eq!(summary.point_count, 3);
        let mut reader = Reader::from_path(&destination).expect("LAS reader");
        let header = reader.header();
        assert_eq!((header.version().major, header.version().minor), (1, 4));
        assert_eq!(header.point_format().to_u8().expect("format"), 2);
        assert_eq!(header.number_of_points(), 3);
        assert_eq!(header.transforms().x.scale, SCALE_METERS);
        assert_eq!(header.transforms().x.offset, expected[0].0[0]);
        assert_eq!(header.transforms().y.offset, expected[0].0[1]);
        assert_eq!(header.transforms().z.offset, expected[2].0[2]);
        assert_eq!(
            header.get_wkt_crs_bytes().expect("WKT"),
            format!("{wkt}\0").as_bytes()
        );
        let points = reader
            .points()
            .collect::<Result<Vec<_>, _>>()
            .expect("points");
        for (index, (actual, (coordinate, color))) in points.iter().zip(expected).enumerate() {
            assert!((actual.x - coordinate[0]).abs() <= 0.000_5);
            assert!((actual.y - coordinate[1]).abs() <= 0.000_5);
            assert!((actual.z - coordinate[2]).abs() <= 0.000_5);
            assert_eq!(
                actual.color,
                Some(Color::new(
                    u16::from(color[0]) * 257,
                    u16::from(color[1]) * 257,
                    u16::from(color[2]) * 257,
                ))
            );
            assert_eq!(
                actual.classification,
                if index == 1 {
                    Classification::Unclassified
                } else {
                    Classification::Ground
                }
            );
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn local_metric_export_omits_crs_vlr_and_laz_is_compressed() {
        let root = root("local-laz");
        let source = root.join("source.ply");
        let destination = root.join("output.laz");
        write_ply(&source, 2);
        transcode_ply_atomic(
            &source,
            &destination,
            "local-test",
            PointCloudExportFormat::Laz,
            None,
            &CancellationToken::new(),
            |_, _| {},
        )
        .expect("transcode");
        let mut reader = Reader::from_path(destination).expect("LAZ reader");
        assert!(reader.header().point_format().is_compressed);
        assert!(reader.header().get_wkt_crs_bytes().is_none());
        assert!(reader.points().all(|point| {
            point.expect("LAZ point").classification == Classification::CreatedNeverClassified
        }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cancellation_removes_partial_output_and_preserves_existing_destination() {
        let root = root("cancel");
        let source = root.join("source.ply");
        let destination = root.join("output.las");
        write_ply(&source, usize::try_from(POINT_CHUNK * 2).unwrap());
        fs::write(&destination, b"existing").expect("destination");
        let cancellation = CancellationToken::new();
        let signal = cancellation.clone();
        let error = transcode_ply_atomic(
            &source,
            &destination,
            "cancel-test",
            PointCloudExportFormat::Las,
            None,
            &cancellation,
            move |completed, _| {
                if completed >= POINT_CHUNK * 3 {
                    signal.request_cancel();
                }
            },
        )
        .expect_err("cancelled");
        assert!(matches!(error, PointCloudExportError::Cancelled));
        assert_eq!(fs::read(&destination).expect("destination"), b"existing");
        assert!(!root.join(".output.las.cancel-test.partial.las").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn invalid_source_never_replaces_destination() {
        let root = root("atomic");
        let source = root.join("source.ply");
        let destination = root.join("output.las");
        fs::write(&source, b"not a PLY").expect("source");
        fs::write(&destination, b"existing").expect("destination");
        assert!(transcode_ply_atomic(
            &source,
            &destination,
            "atomic-test",
            PointCloudExportFormat::Las,
            None,
            &CancellationToken::new(),
            |_, _| {},
        )
        .is_err());
        assert_eq!(fs::read(destination).expect("destination"), b"existing");
        fs::remove_dir_all(root).expect("cleanup");
    }
}
