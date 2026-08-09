//! Streaming Brush/3DGS PLY conversion into the shared tiled splat contract.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use himmelcad_core::{
    photolab_gcp_optimization::GcpSimilarityTransform, photolab_jobs::CancellationToken,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const OUTPUT_STRIDE: usize = 44;
const TARGET_LEAF_SPLATS: u64 = 200_000;
const ROOT_SAMPLE_SPLATS: u64 = 50_000;
const MAX_GRID_AXIS: u32 = 4;
const SH_C0: f64 = 0.282_094_791_773_878_14;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSplatProduct {
    pub manifest_relative_path: PathBuf,
    #[serde(default)]
    pub export_relative_path: PathBuf,
    pub splat_count: u64,
    pub tile_count: u32,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

#[derive(Debug, Error)]
pub enum SplatTilerError {
    #[error("invalid Brush PLY: {0}")]
    InvalidPly(String),
    #[error("splat tiling was cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy)]
enum ScalarType {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

#[derive(Debug, Clone)]
struct Header {
    ascii: bool,
    count: u64,
    properties: Vec<(String, ScalarType)>,
    body_offset: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    format: &'static str,
    root_tile_id: &'static str,
    tiles: Vec<TileManifest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TileManifest {
    id: String,
    parent: Option<String>,
    children: Vec<String>,
    bounds: Bounds,
    origin: [f64; 3],
    geometric_error: f64,
    splat_count: u64,
    data_url: String,
}

#[derive(Debug, Clone, Serialize)]
struct Bounds {
    min: Point,
    max: Point,
}

#[derive(Debug, Clone, Serialize)]
struct Point {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Clone)]
struct TileStats {
    count: u64,
    min: [f64; 3],
    max: [f64; 3],
    maximum_scale: f64,
}

impl TileStats {
    fn new() -> Self {
        Self {
            count: 0,
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
            maximum_scale: 0.0,
        }
    }
    fn observe(&mut self, position: [f64; 3], maximum_scale: f64) {
        self.count += 1;
        self.maximum_scale = self.maximum_scale.max(maximum_scale);
        for (axis, coordinate) in position.into_iter().enumerate() {
            self.min[axis] = self.min[axis].min(coordinate);
            self.max[axis] = self.max[axis].max(coordinate);
        }
    }
}

struct Splat {
    position: [f64; 3],
    scale: [f32; 3],
    rotation: [f32; 4],
    color: [u8; 4],
}

/// Produces a coarse root sample plus spatial leaves. At most 64 leaf files are open.
pub fn tile_brush_ply(
    source: &Path,
    output_root: &Path,
    project_transform: Option<GcpSimilarityTransform>,
    cancellation: &CancellationToken,
) -> Result<PreparedSplatProduct, SplatTilerError> {
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root.join("tiles"))?;
    let header = parse_header(source)?;
    if header.count == 0 {
        return Err(SplatTilerError::InvalidPly("no splats".into()));
    }
    let property_map = header
        .properties
        .iter()
        .enumerate()
        .map(|(index, (name, _))| (name.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    for required in ["x", "y", "z"] {
        if !property_map.contains_key(required) {
            return Err(SplatTilerError::InvalidPly(format!("missing {required}")));
        }
    }
    let mut global = TileStats::new();
    visit_splats(source, &header, cancellation, |values| {
        let mut splat = decode_splat(values, &property_map)?;
        if let Some(transform) = project_transform {
            transform_splat(&mut splat, transform);
        }
        global.observe(
            splat.position,
            splat
                .scale
                .iter()
                .copied()
                .map(f64::from)
                .fold(0.0, f64::max),
        );
        Ok(())
    })?;
    let desired_leaves = header.count.div_ceil(TARGET_LEAF_SPLATS).max(1);
    let axis = (1..=MAX_GRID_AXIS)
        .find(|value| u64::from(*value).pow(3) >= desired_leaves)
        .unwrap_or(MAX_GRID_AXIS);
    let global_origin = midpoint(global.min, global.max);
    let root_path = output_root.join("tiles/root.bin");
    let mut root = BufWriter::new(File::create(&root_path)?);
    let export_path = output_root.join("export.ply");
    let mut export = BufWriter::with_capacity(1024 * 1024, File::create(&export_path)?);
    write_export_header(&mut export, header.count)?;
    let root_stride = header.count.div_ceil(ROOT_SAMPLE_SPLATS).max(1);
    let mut writers = BTreeMap::<u32, BufWriter<File>>::new();
    let mut stats = BTreeMap::<u32, TileStats>::new();
    let mut index = 0_u64;
    visit_splats(source, &header, cancellation, |values| {
        let mut splat = decode_splat(values, &property_map)?;
        if let Some(transform) = project_transform {
            transform_splat(&mut splat, transform);
        }
        let cell = cell_id(splat.position, global.min, global.max, axis);
        let cell_origin = cell_origin(cell, global.min, global.max, axis);
        if let std::collections::btree_map::Entry::Vacant(entry) = writers.entry(cell) {
            let path = output_root.join(format!("tiles/cell-{cell}.bin"));
            entry.insert(BufWriter::with_capacity(
                1024 * 1024,
                OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .open(path)?,
            ));
        }
        write_splat(
            writers.get_mut(&cell).expect("inserted"),
            &splat,
            cell_origin,
        )?;
        write_export_splat(&mut export, &splat)?;
        stats.entry(cell).or_insert_with(TileStats::new).observe(
            splat.position,
            splat
                .scale
                .iter()
                .copied()
                .map(f64::from)
                .fold(0.0, f64::max),
        );
        if index % root_stride == 0 {
            write_splat(&mut root, &splat, global_origin)?;
        }
        index += 1;
        Ok(())
    })?;
    root.flush()?;
    export.flush()?;
    export.get_ref().sync_all()?;
    for writer in writers.values_mut() {
        writer.flush()?;
    }
    let root_count = header.count.div_ceil(root_stride);
    let child_ids = stats
        .keys()
        .map(|cell| format!("cell-{cell}"))
        .collect::<Vec<_>>();
    let mut tiles = vec![TileManifest {
        id: "root".into(),
        parent: None,
        children: child_ids.clone(),
        bounds: bounds(global.min, global.max),
        origin: global_origin,
        geometric_error: diagonal(global.min, global.max)
            .max(global.maximum_scale * 2.0)
            .max(0.001),
        splat_count: root_count,
        data_url: "tiles/root.bin".into(),
    }];
    for (cell, item) in stats {
        tiles.push(TileManifest {
            id: format!("cell-{cell}"),
            parent: Some("root".into()),
            children: Vec::new(),
            bounds: bounds(item.min, item.max),
            origin: cell_origin(cell, global.min, global.max, axis),
            geometric_error: (item.maximum_scale * 2.0).max(0.001),
            splat_count: item.count,
            data_url: format!("tiles/cell-{cell}.bin"),
        });
    }
    let manifest = Manifest {
        schema_version: 1,
        format: "hcsplatInterleavedV1",
        root_tile_id: "root",
        tiles,
    };
    let manifest_path = output_root.join("manifest.json");
    let temporary = output_root.join("manifest.json.pending");
    fs::write(&temporary, serde_json::to_vec(&manifest)?)?;
    fs::rename(temporary, &manifest_path)?;
    Ok(PreparedSplatProduct {
        manifest_relative_path: PathBuf::from("prepared-splats/manifest.json"),
        export_relative_path: PathBuf::from("prepared-splats/export.ply"),
        splat_count: header.count,
        tile_count: u32::try_from(manifest.tiles.len()).unwrap_or(u32::MAX),
        bounds_min: global.min,
        bounds_max: global.max,
    })
}

fn write_export_header(writer: &mut impl Write, count: u64) -> Result<(), SplatTilerError> {
    write!(
        writer,
        "ply\nformat binary_little_endian 1.0\nelement vertex {count}\n\
property double x\nproperty double y\nproperty double z\n\
property float scale_x\nproperty float scale_y\nproperty float scale_z\n\
property float qx\nproperty float qy\nproperty float qz\nproperty float qw\n\
property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n"
    )?;
    Ok(())
}

fn write_export_splat(writer: &mut impl Write, splat: &Splat) -> Result<(), SplatTilerError> {
    for value in splat.position {
        writer.write_all(&value.to_le_bytes())?;
    }
    for value in splat.scale {
        writer.write_all(&value.to_le_bytes())?;
    }
    for value in splat.rotation {
        writer.write_all(&value.to_le_bytes())?;
    }
    writer.write_all(&splat.color)?;
    Ok(())
}

fn visit_splats(
    source: &Path,
    header: &Header,
    cancellation: &CancellationToken,
    mut visitor: impl FnMut(&[f64]) -> Result<(), SplatTilerError>,
) -> Result<(), SplatTilerError> {
    let mut file = BufReader::new(File::open(source)?);
    file.seek(SeekFrom::Start(header.body_offset))?;
    if header.ascii {
        let mut line = String::new();
        for index in 0..header.count {
            if index % 4_096 == 0 && cancellation.is_cancel_requested() {
                return Err(SplatTilerError::Cancelled);
            }
            line.clear();
            if file.read_line(&mut line)? == 0 {
                return Err(SplatTilerError::InvalidPly("truncated ASCII body".into()));
            }
            let values = line
                .split_whitespace()
                .map(|value| {
                    value
                        .parse::<f64>()
                        .map_err(|_| SplatTilerError::InvalidPly("invalid ASCII scalar".into()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            if values.len() < header.properties.len() {
                return Err(SplatTilerError::InvalidPly("short ASCII row".into()));
            }
            visitor(&values)?;
        }
    } else {
        let record_bytes = header
            .properties
            .iter()
            .map(|(_, kind)| scalar_bytes(*kind))
            .sum::<usize>();
        let mut record = vec![0_u8; record_bytes];
        let mut values = vec![0_f64; header.properties.len()];
        for index in 0..header.count {
            if index % 4_096 == 0 && cancellation.is_cancel_requested() {
                return Err(SplatTilerError::Cancelled);
            }
            file.read_exact(&mut record)?;
            let mut cursor = 0;
            for (property, (_, kind)) in header.properties.iter().enumerate() {
                values[property] = read_scalar(&record, cursor, *kind);
                cursor += scalar_bytes(*kind);
            }
            visitor(&values)?;
        }
    }
    Ok(())
}

fn parse_header(source: &Path) -> Result<Header, SplatTilerError> {
    let mut reader = BufReader::new(File::open(source)?);
    let mut body_offset = 0_u64;
    let mut ascii = None;
    let mut count = None;
    let mut in_vertices = false;
    let mut properties = Vec::new();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 || body_offset > 1024 * 1024 {
            return Err(SplatTilerError::InvalidPly("unterminated header".into()));
        }
        body_offset += u64::try_from(read).expect("usize fits");
        let fields = line.split_whitespace().collect::<Vec<_>>();
        match fields.as_slice() {
            ["ply"] => {}
            ["format", "ascii", "1.0"] => ascii = Some(true),
            ["format", "binary_little_endian", "1.0"] => ascii = Some(false),
            ["element", "vertex", value] => {
                count = value.parse().ok();
                in_vertices = true;
            }
            ["element", ..] => in_vertices = false,
            ["property", kind, name] if in_vertices => {
                properties.push(((*name).into(), scalar_type(kind)?))
            }
            ["property", "list", ..] if in_vertices => {
                return Err(SplatTilerError::InvalidPly("vertex list property".into()))
            }
            ["end_header"] => break,
            _ => {}
        }
    }
    Ok(Header {
        ascii: ascii.ok_or_else(|| SplatTilerError::InvalidPly("format missing".into()))?,
        count: count.ok_or_else(|| SplatTilerError::InvalidPly("vertex count missing".into()))?,
        properties,
        body_offset,
    })
}

fn decode_splat(
    values: &[f64],
    properties: &BTreeMap<&str, usize>,
) -> Result<Splat, SplatTilerError> {
    let value = |name: &str, fallback: f64| {
        properties
            .get(name)
            .and_then(|index| values.get(*index))
            .copied()
            .unwrap_or(fallback)
    };
    let position = [
        value("x", f64::NAN),
        value("y", f64::NAN),
        value("z", f64::NAN),
    ];
    if position.iter().any(|item| !item.is_finite()) {
        return Err(SplatTilerError::InvalidPly("non-finite position".into()));
    }
    let scale = [
        scale_value(value("scale_0", f64::NAN), value("scale_x", 0.01)),
        scale_value(value("scale_1", f64::NAN), value("scale_y", 0.01)),
        scale_value(value("scale_2", f64::NAN), value("scale_z", 0.01)),
    ];
    let mut rotation = if properties.contains_key("rot_0") {
        [
            value("rot_1", 0.0),
            value("rot_2", 0.0),
            value("rot_3", 0.0),
            value("rot_0", 1.0),
        ]
    } else {
        [
            value("qx", 0.0),
            value("qy", 0.0),
            value("qz", 0.0),
            value("qw", 1.0),
        ]
    };
    let length = rotation.iter().map(|item| item * item).sum::<f64>().sqrt();
    if length <= 1e-8 {
        rotation = [0.0, 0.0, 0.0, 1.0];
    } else {
        for item in &mut rotation {
            *item /= length;
        }
    }
    let color = if properties.contains_key("f_dc_0") {
        [0, 1, 2].map(|axis| byte((0.5 + SH_C0 * value(&format!("f_dc_{axis}"), 0.0)) * 255.0))
    } else {
        [
            byte(value("red", 255.0)),
            byte(value("green", 255.0)),
            byte(value("blue", 255.0)),
        ]
    };
    let alpha = if properties.contains_key("opacity") {
        byte(255.0 / (1.0 + (-value("opacity", 20.0).clamp(-20.0, 20.0)).exp()))
    } else {
        byte(value("alpha", 255.0))
    };
    Ok(Splat {
        position,
        scale,
        rotation: rotation.map(|item| item as f32),
        color: [color[0], color[1], color[2], alpha],
    })
}

fn write_splat(
    writer: &mut impl Write,
    splat: &Splat,
    origin: [f64; 3],
) -> Result<(), SplatTilerError> {
    let mut record = [0_u8; OUTPUT_STRIDE];
    for axis in 0..3 {
        record[axis * 4..axis * 4 + 4]
            .copy_from_slice(&((splat.position[axis] - origin[axis]) as f32).to_le_bytes());
        record[12 + axis * 4..16 + axis * 4].copy_from_slice(&splat.scale[axis].to_le_bytes());
    }
    for component in 0..4 {
        record[24 + component * 4..28 + component * 4]
            .copy_from_slice(&splat.rotation[component].to_le_bytes());
    }
    record[40..44].copy_from_slice(&splat.color);
    writer.write_all(&record)?;
    Ok(())
}

fn transform_splat(splat: &mut Splat, transform: GcpSimilarityTransform) {
    let source = splat.position;
    splat.position = [
        transform.scale
            * (transform.rotation[0] * source[0]
                + transform.rotation[1] * source[1]
                + transform.rotation[2] * source[2])
            + transform.translation_meters[0],
        transform.scale
            * (transform.rotation[3] * source[0]
                + transform.rotation[4] * source[1]
                + transform.rotation[5] * source[2])
            + transform.translation_meters[1],
        transform.scale
            * (transform.rotation[6] * source[0]
                + transform.rotation[7] * source[1]
                + transform.rotation[8] * source[2])
            + transform.translation_meters[2],
    ];
    for scale in &mut splat.scale {
        *scale *= transform.scale as f32;
    }
    splat.rotation = quaternion_multiply(matrix_quaternion(transform.rotation), splat.rotation);
}

fn matrix_quaternion(matrix: [f64; 9]) -> [f32; 4] {
    let trace = matrix[0] + matrix[4] + matrix[8];
    let (x, y, z, w) = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        (
            (matrix[7] - matrix[5]) / s,
            (matrix[2] - matrix[6]) / s,
            (matrix[3] - matrix[1]) / s,
            0.25 * s,
        )
    } else if matrix[0] > matrix[4] && matrix[0] > matrix[8] {
        let s = (1.0 + matrix[0] - matrix[4] - matrix[8]).sqrt() * 2.0;
        (
            0.25 * s,
            (matrix[1] + matrix[3]) / s,
            (matrix[2] + matrix[6]) / s,
            (matrix[7] - matrix[5]) / s,
        )
    } else if matrix[4] > matrix[8] {
        let s = (1.0 + matrix[4] - matrix[0] - matrix[8]).sqrt() * 2.0;
        (
            (matrix[1] + matrix[3]) / s,
            0.25 * s,
            (matrix[5] + matrix[7]) / s,
            (matrix[2] - matrix[6]) / s,
        )
    } else {
        let s = (1.0 + matrix[8] - matrix[0] - matrix[4]).sqrt() * 2.0;
        (
            (matrix[2] + matrix[6]) / s,
            (matrix[5] + matrix[7]) / s,
            0.25 * s,
            (matrix[3] - matrix[1]) / s,
        )
    };
    [x as f32, y as f32, z as f32, w as f32]
}

fn quaternion_multiply(left: [f32; 4], right: [f32; 4]) -> [f32; 4] {
    let [lx, ly, lz, lw] = left;
    let [rx, ry, rz, rw] = right;
    let result = [
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    ];
    let length = result.iter().map(|value| value * value).sum::<f32>().sqrt();
    if length > 1e-8 {
        result.map(|value| value / length)
    } else {
        [0.0, 0.0, 0.0, 1.0]
    }
}

fn cell_id(position: [f64; 3], min: [f64; 3], max: [f64; 3], axis: u32) -> u32 {
    let index = |dimension: usize| {
        let span = max[dimension] - min[dimension];
        if span <= 0.0 {
            0
        } else {
            (((position[dimension] - min[dimension]) / span * f64::from(axis)).floor() as u32)
                .min(axis - 1)
        }
    };
    index(0) + axis * (index(1) + axis * index(2))
}
fn cell_origin(id: u32, min: [f64; 3], max: [f64; 3], axis: u32) -> [f64; 3] {
    let x = id % axis;
    let y = (id / axis) % axis;
    let z = id / (axis * axis);
    [0, 1, 2].map(|dimension| {
        let cell = [x, y, z][dimension];
        min[dimension]
            + (f64::from(cell) + 0.5) * (max[dimension] - min[dimension]) / f64::from(axis)
    })
}
fn midpoint(min: [f64; 3], max: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|axis| (min[axis] + max[axis]) * 0.5)
}
fn diagonal(min: [f64; 3], max: [f64; 3]) -> f64 {
    ((max[0] - min[0]).powi(2) + (max[1] - min[1]).powi(2) + (max[2] - min[2]).powi(2)).sqrt()
}
fn bounds(min: [f64; 3], max: [f64; 3]) -> Bounds {
    Bounds {
        min: Point {
            x: min[0],
            y: min[1],
            z: min[2],
        },
        max: Point {
            x: max[0],
            y: max[1],
            z: max[2],
        },
    }
}
fn scale_value(logarithmic: f64, linear: f64) -> f32 {
    if logarithmic.is_finite() {
        logarithmic.exp().clamp(1e-6, 1e6) as f32
    } else {
        linear.clamp(1e-6, 1e6) as f32
    }
}
fn byte(value: f64) -> u8 {
    value.clamp(0.0, 255.0).round() as u8
}
fn scalar_type(value: &str) -> Result<ScalarType, SplatTilerError> {
    match value {
        "char" | "int8" => Ok(ScalarType::I8),
        "uchar" | "uint8" => Ok(ScalarType::U8),
        "short" | "int16" => Ok(ScalarType::I16),
        "ushort" | "uint16" => Ok(ScalarType::U16),
        "int" | "int32" => Ok(ScalarType::I32),
        "uint" | "uint32" => Ok(ScalarType::U32),
        "float" | "float32" => Ok(ScalarType::F32),
        "double" | "float64" => Ok(ScalarType::F64),
        _ => Err(SplatTilerError::InvalidPly(format!(
            "unsupported scalar {value}"
        ))),
    }
}
fn scalar_bytes(kind: ScalarType) -> usize {
    match kind {
        ScalarType::I8 | ScalarType::U8 => 1,
        ScalarType::I16 | ScalarType::U16 => 2,
        ScalarType::F64 => 8,
        _ => 4,
    }
}
fn read_scalar(bytes: &[u8], offset: usize, kind: ScalarType) -> f64 {
    match kind {
        ScalarType::I8 => f64::from(bytes[offset] as i8),
        ScalarType::U8 => f64::from(bytes[offset]),
        ScalarType::I16 => f64::from(i16::from_le_bytes(
            bytes[offset..offset + 2].try_into().unwrap(),
        )),
        ScalarType::U16 => f64::from(u16::from_le_bytes(
            bytes[offset..offset + 2].try_into().unwrap(),
        )),
        ScalarType::I32 => f64::from(i32::from_le_bytes(
            bytes[offset..offset + 4].try_into().unwrap(),
        )),
        ScalarType::U32 => f64::from(u32::from_le_bytes(
            bytes[offset..offset + 4].try_into().unwrap(),
        )),
        ScalarType::F32 => f64::from(f32::from_le_bytes(
            bytes[offset..offset + 4].try_into().unwrap(),
        )),
        ScalarType::F64 => f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiles_ascii_brush_output() {
        let root = std::env::temp_dir().join(format!("hcad-splat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("s.ply");
        fs::write(&source,b"ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float opacity\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n0 0 0 -2 -2 -2 2 1 0 0 0 0 0 0\n1 1 1 -2 -2 -2 2 1 0 0 0 0 0 0\n").unwrap();
        let result = tile_brush_ply(
            &source,
            &root.join("prepared-splats"),
            None,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.splat_count, 2);
        assert!(root.join("prepared-splats/manifest.json").is_file());
        assert!(root.join("prepared-splats/export.ply").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
