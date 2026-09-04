//! Bounded PLY adapter for the provider-neutral prepared triangle-mesh pipeline.

use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use himmelcad_core::photolab_jobs::CancellationToken;

use crate::{
    mesh_tiler::PreparedMeshProduct,
    prepared_triangle_mesh::{
        build_prepared_textured_triangle_mesh, build_prepared_triangle_mesh,
        PreparedTriangleMeshError, PreparedTriangleMeshOptions, TriangleRecord,
    },
};

const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const MAX_ELEMENTS: usize = 64;
const MAX_PROPERTIES_PER_ELEMENT: usize = 256;
const MAX_LIST_ITEMS: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlyFormat {
    Ascii,
    BinaryLittleEndian,
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

impl ScalarType {
    fn is_integer(self) -> bool {
        matches!(
            self,
            Self::I8 | Self::U8 | Self::I16 | Self::U16 | Self::I32 | Self::U32
        )
    }
}

#[derive(Debug)]
enum Property {
    Scalar {
        name: String,
        scalar: ScalarType,
    },
    List {
        name: String,
        count: ScalarType,
        item: ScalarType,
    },
}

#[derive(Debug)]
struct Element {
    name: String,
    count: u64,
    properties: Vec<Property>,
}

struct PlyTriangleStream {
    staging_root: PathBuf,
    vertices: File,
    faces: BufReader<File>,
    vertex_count: u64,
    remaining_faces: u64,
    textured: bool,
    vertex_blocks: VecDeque<(u64, Vec<[f64; 3]>)>,
}

struct StagingGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

impl Iterator for PlyTriangleStream {
    type Item = Result<TriangleRecord, PreparedTriangleMeshError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining_faces == 0 {
            return None;
        }
        self.remaining_faces -= 1;
        Some(self.read_triangle())
    }
}

impl PlyTriangleStream {
    fn read_triangle(&mut self) -> Result<TriangleRecord, PreparedTriangleMeshError> {
        let mut index_bytes = [0_u8; 24];
        self.faces.read_exact(&mut index_bytes)?;
        let indices: [u64; 3] = std::array::from_fn(|slot| {
            u64::from_le_bytes(index_bytes[slot * 8..slot * 8 + 8].try_into().unwrap())
        });
        let mut positions = [[0.0; 3]; 3];
        for (slot, index) in indices.into_iter().enumerate() {
            if index >= self.vertex_count {
                return Err(invalid(format!(
                    "face index {index} exceeds vertex count {}",
                    self.vertex_count
                )));
            }
            positions[slot] = self.vertex(index)?;
        }
        let texture_coordinates = if self.textured {
            let mut bytes = [0_u8; 24];
            self.faces.read_exact(&mut bytes)?;
            let values = std::array::from_fn::<_, 6, _>(|index| {
                f32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
            });
            Some([
                [values[0], values[1]],
                [values[2], values[3]],
                [values[4], values[5]],
            ])
        } else {
            None
        };
        Ok(TriangleRecord {
            positions,
            material_slot: None,
            texture_coordinates,
        })
    }

    fn vertex(&mut self, index: u64) -> Result<[f64; 3], PreparedTriangleMeshError> {
        const BLOCK_VERTICES: u64 = 4096;
        const MAX_BLOCKS: usize = 16;
        let block = index / BLOCK_VERTICES;
        if let Some(position) = self
            .vertex_blocks
            .iter()
            .position(|(candidate, _)| *candidate == block)
        {
            let entry = self
                .vertex_blocks
                .remove(position)
                .expect("known cache entry");
            let value = entry.1[usize::try_from(index % BLOCK_VERTICES).unwrap()];
            self.vertex_blocks.push_back(entry);
            return Ok(value);
        }
        let first = block * BLOCK_VERTICES;
        let count = (self.vertex_count - first).min(BLOCK_VERTICES);
        let byte_length = usize::try_from(count * 24)
            .map_err(|_| invalid("vertex cache block exceeds address space"))?;
        self.vertices.seek(SeekFrom::Start(
            first
                .checked_mul(24)
                .ok_or_else(|| invalid("vertex byte offset overflows"))?,
        ))?;
        let mut bytes = vec![0_u8; byte_length];
        self.vertices.read_exact(&mut bytes)?;
        let decoded = bytes
            .chunks_exact(24)
            .map(|vertex| {
                std::array::from_fn(|axis| {
                    f64::from_le_bytes(vertex[axis * 8..axis * 8 + 8].try_into().unwrap())
                })
            })
            .collect::<Vec<_>>();
        let value = decoded[usize::try_from(index - first).unwrap()];
        if self.vertex_blocks.len() == MAX_BLOCKS {
            self.vertex_blocks.pop_front();
        }
        self.vertex_blocks.push_back((block, decoded));
        Ok(value)
    }
}

impl Drop for PlyTriangleStream {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.staging_root);
    }
}

/// Reads COLMAP-compatible or general triangle PLY without retaining all
/// vertices/faces in memory, then runs the shared spatial mesh preprocessor.
pub fn build_prepared_triangle_mesh_from_ply(
    source: &Path,
    output_root: &Path,
    options: PreparedTriangleMeshOptions,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, PreparedTriangleMeshError> {
    let (stream, texture_file) = parse_ply_to_disk(source, cancellation)?;
    if stream.textured || texture_file.is_some() {
        return Err(invalid(
            "textured PLY must use the COLMAP textured-mesh adapter",
        ));
    }
    build_prepared_triangle_mesh(stream, output_root, options, cancellation)
}

/// Reads COLMAP's `mesh.ply` plus `texture.png` directory contract and feeds
/// Result of preparing a mesh that PhotoLab generated itself (WP-A3 stage 1).
#[derive(Debug)]
pub struct GeneratedMeshReport {
    pub prepared: PreparedMeshProduct,
    /// Zero-area faces removed before tiling. Poisson reconstruction emits
    /// them routinely; the shared producer rightly refuses them as
    /// authoritative topology, so a generated mesh is cleaned first.
    pub degenerate_faces_dropped: u64,
}

/// Prepares a PhotoLab-generated (untextured) PLY, dropping zero-area faces.
///
/// Only meshes this product computed itself go through this path; imported or
/// authoritative meshes keep the strict `build_prepared_triangle_mesh_from_ply`.
pub fn build_prepared_triangle_mesh_from_generated_ply(
    source: &Path,
    output_root: &Path,
    options: PreparedTriangleMeshOptions,
    origin: [f64; 3],
    cancellation: &CancellationToken,
) -> Result<GeneratedMeshReport, PreparedTriangleMeshError> {
    let (stream, texture_file) = parse_ply_to_disk(source, cancellation)?;
    if stream.textured || texture_file.is_some() {
        return Err(invalid("generated mesh PLY must not carry texture data"));
    }
    let dropped = std::cell::Cell::new(0_u64);
    // The mesher worked in a local frame (see dense_raster_prep::write_dense_local_frame_ply);
    // restore world coordinates in f64 before the producer sees the triangles.
    let filtered = stream
        .map(move |item| {
            item.map(|mut triangle| {
                for position in &mut triangle.positions {
                    position[0] += origin[0];
                    position[1] += origin[1];
                    position[2] += origin[2];
                }
                triangle
            })
        })
        .filter(|item| match item {
            Ok(triangle) if is_zero_area(triangle) => {
                dropped.set(dropped.get() + 1);
                false
            }
            _ => true,
        });
    let prepared = build_prepared_triangle_mesh(filtered, output_root, options, cancellation)?;
    Ok(GeneratedMeshReport {
        prepared,
        degenerate_faces_dropped: dropped.get(),
    })
}

/// Same criterion as the shared producer's rejection: an exactly zero cross
/// product (repeated vertices or collinear corners).
fn is_zero_area(triangle: &TriangleRecord) -> bool {
    let [a, b, c] = triangle.positions;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    cross.iter().all(|value| *value == 0.0)
}

/// its exact per-face-corner UVs into the shared prepared-mesh producer.
pub fn build_prepared_triangle_mesh_from_colmap_textured_directory(
    source_root: &Path,
    output_root: &Path,
    options: PreparedTriangleMeshOptions,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, PreparedTriangleMeshError> {
    let (stream, texture_file) = parse_ply_to_disk(&source_root.join("mesh.ply"), cancellation)?;
    if !stream.textured || texture_file.as_deref() != Some("texture.png") {
        return Err(invalid(
            "COLMAP textured mesh requires face texcoord lists and `comment TextureFile texture.png`",
        ));
    }
    let texture = source_root.join("texture.png");
    if !texture.is_file() {
        return Err(invalid("COLMAP textured mesh texture.png is missing"));
    }
    build_prepared_textured_triangle_mesh(stream, &texture, output_root, options, cancellation)
}

fn parse_ply_to_disk(
    source: &Path,
    cancellation: &CancellationToken,
) -> Result<(PlyTriangleStream, Option<String>), PreparedTriangleMeshError> {
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, File::open(source)?);
    let (format, elements, texture_file) = read_header(&mut reader)?;
    let vertex_element = elements
        .iter()
        .find(|element| element.name == "vertex")
        .ok_or_else(|| invalid("PLY has no vertex element"))?;
    validate_vertex_schema(vertex_element)?;
    let face_element = elements
        .iter()
        .find(|element| element.name == "face")
        .ok_or_else(|| invalid("PLY has no face element"))?;
    let textured = validate_face_schema(face_element)?;

    let staging_root = unique_staging_root(source)?;
    fs::create_dir_all(&staging_root)?;
    let mut staging_guard = StagingGuard {
        path: staging_root.clone(),
        armed: true,
    };
    let vertex_path = staging_root.join("vertices.f64");
    let face_path = staging_root.join("faces.u64");
    let mut vertices = BufWriter::with_capacity(8 * 1024 * 1024, File::create(&vertex_path)?);
    let mut faces = BufWriter::with_capacity(8 * 1024 * 1024, File::create(&face_path)?);
    let mut written_vertices = 0_u64;
    let mut written_faces = 0_u64;
    for element in &elements {
        for record_index in 0..element.count {
            if record_index % 65_536 == 0 && cancellation.is_cancel_requested() {
                return Err(PreparedTriangleMeshError::Cancelled);
            }
            let values = match format {
                PlyFormat::Ascii => read_ascii_record(&mut reader, element)?,
                PlyFormat::BinaryLittleEndian => read_binary_record(&mut reader, element)?,
            };
            if element.name == "vertex" {
                let point = vertex_point(element, &values)?;
                for value in point {
                    vertices.write_all(&value.to_le_bytes())?;
                }
                written_vertices += 1;
            } else if element.name == "face" {
                let indices = face_indices(element, &values)?;
                for index in indices {
                    faces.write_all(&index.to_le_bytes())?;
                }
                if textured {
                    for value in face_texture_coordinates(element, &values)? {
                        faces.write_all(&value.to_le_bytes())?;
                    }
                }
                written_faces += 1;
            }
        }
    }
    vertices.flush()?;
    faces.flush()?;
    reject_trailing_payload(&mut reader, format)?;
    if written_vertices != vertex_element.count || written_faces != face_element.count {
        return Err(invalid("PLY element payload count is inconsistent"));
    }
    staging_guard.armed = false;
    Ok((
        PlyTriangleStream {
            staging_root,
            vertices: File::open(vertex_path)?,
            faces: BufReader::with_capacity(8 * 1024 * 1024, File::open(face_path)?),
            vertex_count: written_vertices,
            remaining_faces: written_faces,
            textured,
            vertex_blocks: VecDeque::new(),
        },
        texture_file,
    ))
}

fn read_header(
    reader: &mut impl BufRead,
) -> Result<(PlyFormat, Vec<Element>, Option<String>), PreparedTriangleMeshError> {
    let mut total = 0_usize;
    let mut line = String::new();
    read_bounded_line(reader, &mut line, &mut total)?;
    if line.trim_end_matches(['\r', '\n']) != "ply" {
        return Err(invalid("missing PLY magic"));
    }
    let mut format = None;
    let mut texture_file = None;
    let mut elements: Vec<Element> = Vec::new();
    loop {
        line.clear();
        read_bounded_line(reader, &mut line, &mut total)?;
        let trimmed = line.trim();
        if trimmed == "end_header" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("comment TextureFile ") {
            set_once(&mut texture_file, value.to_owned(), "TextureFile comment")?;
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("comment ") || trimmed.starts_with("obj_info ")
        {
            continue;
        }
        let fields = trimmed.split_ascii_whitespace().collect::<Vec<_>>();
        match fields.as_slice() {
            ["format", "ascii", "1.0"] => set_once(&mut format, PlyFormat::Ascii, "format")?,
            ["format", "binary_little_endian", "1.0"] => {
                set_once(&mut format, PlyFormat::BinaryLittleEndian, "format")?
            }
            ["format", "binary_big_endian", "1.0"] => {
                return Err(invalid("binary big-endian PLY is unsupported"));
            }
            ["element", name, count] => {
                if elements.len() >= MAX_ELEMENTS {
                    return Err(invalid("PLY exceeds the element limit"));
                }
                elements.push(Element {
                    name: (*name).to_owned(),
                    count: parse_u64(count, "element count")?,
                    properties: Vec::new(),
                });
            }
            ["property", scalar, name] => {
                let element = elements
                    .last_mut()
                    .ok_or_else(|| invalid("property precedes element"))?;
                ensure_property_budget(element)?;
                element.properties.push(Property::Scalar {
                    name: (*name).to_owned(),
                    scalar: scalar_type(scalar)?,
                });
            }
            ["property", "list", count, item, name] => {
                let element = elements
                    .last_mut()
                    .ok_or_else(|| invalid("property precedes element"))?;
                ensure_property_budget(element)?;
                let count = scalar_type(count)?;
                if !count.is_integer() {
                    return Err(invalid("PLY list count type must be integer"));
                }
                element.properties.push(Property::List {
                    name: (*name).to_owned(),
                    count,
                    item: scalar_type(item)?,
                });
            }
            _ => return Err(invalid(format!("unsupported PLY header line: {trimmed}"))),
        }
    }
    let format = format.ok_or_else(|| invalid("PLY format is missing"))?;
    if elements.is_empty() {
        return Err(invalid("PLY has no elements"));
    }
    Ok((format, elements, texture_file))
}

fn read_bounded_line(
    reader: &mut impl BufRead,
    line: &mut String,
    total: &mut usize,
) -> Result<(), PreparedTriangleMeshError> {
    let read = reader.read_line(line)?;
    if read == 0 {
        return Err(invalid("unexpected EOF in PLY header"));
    }
    *total = total
        .checked_add(read)
        .ok_or_else(|| invalid("PLY header size overflows"))?;
    if read > MAX_LINE_BYTES || *total > MAX_HEADER_BYTES {
        return Err(invalid("PLY header exceeds bounded limits"));
    }
    Ok(())
}

fn ensure_property_budget(element: &Element) -> Result<(), PreparedTriangleMeshError> {
    if element.properties.len() >= MAX_PROPERTIES_PER_ELEMENT {
        Err(invalid("PLY element exceeds the property limit"))
    } else {
        Ok(())
    }
}

fn set_once<T>(
    slot: &mut Option<T>,
    value: T,
    label: &str,
) -> Result<(), PreparedTriangleMeshError> {
    if slot.replace(value).is_some() {
        Err(invalid(format!("duplicate PLY {label}")))
    } else {
        Ok(())
    }
}

fn scalar_type(value: &str) -> Result<ScalarType, PreparedTriangleMeshError> {
    match value {
        "char" | "int8" => Ok(ScalarType::I8),
        "uchar" | "uint8" => Ok(ScalarType::U8),
        "short" | "int16" => Ok(ScalarType::I16),
        "ushort" | "uint16" => Ok(ScalarType::U16),
        "int" | "int32" => Ok(ScalarType::I32),
        "uint" | "uint32" => Ok(ScalarType::U32),
        "float" | "float32" => Ok(ScalarType::F32),
        "double" | "float64" => Ok(ScalarType::F64),
        _ => Err(invalid(format!("unsupported PLY scalar type {value}"))),
    }
}

#[derive(Debug)]
enum PropertyValue {
    Scalar(f64),
    List(Vec<f64>),
}

fn read_ascii_record(
    reader: &mut impl BufRead,
    element: &Element,
) -> Result<Vec<PropertyValue>, PreparedTriangleMeshError> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(invalid("truncated ASCII PLY payload"));
    }
    if line.len() > MAX_LINE_BYTES * 16 {
        return Err(invalid("ASCII PLY record exceeds the line limit"));
    }
    let mut tokens = line.split_ascii_whitespace();
    let mut values = Vec::with_capacity(element.properties.len());
    for property in &element.properties {
        match property {
            Property::Scalar { .. } => {
                values.push(PropertyValue::Scalar(parse_f64(
                    tokens
                        .next()
                        .ok_or_else(|| invalid("truncated ASCII scalar"))?,
                    "ASCII scalar",
                )?));
            }
            Property::List { .. } => {
                let count = parse_u64(
                    tokens
                        .next()
                        .ok_or_else(|| invalid("truncated ASCII list count"))?,
                    "ASCII list count",
                )?;
                if count > MAX_LIST_ITEMS {
                    return Err(invalid("PLY list exceeds the item limit"));
                }
                let mut list = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
                for _ in 0..count {
                    list.push(parse_f64(
                        tokens
                            .next()
                            .ok_or_else(|| invalid("truncated ASCII list"))?,
                        "ASCII list item",
                    )?);
                }
                values.push(PropertyValue::List(list));
            }
        }
    }
    if tokens.next().is_some() {
        return Err(invalid("ASCII PLY record has excess values"));
    }
    Ok(values)
}

fn read_binary_record(
    reader: &mut impl Read,
    element: &Element,
) -> Result<Vec<PropertyValue>, PreparedTriangleMeshError> {
    let mut values = Vec::with_capacity(element.properties.len());
    for property in &element.properties {
        match property {
            Property::Scalar { scalar, .. } => {
                values.push(PropertyValue::Scalar(read_binary_scalar(reader, *scalar)?));
            }
            Property::List { count, item, .. } => {
                let count =
                    scalar_to_u64(read_binary_scalar(reader, *count)?, "binary list count")?;
                if count > MAX_LIST_ITEMS {
                    return Err(invalid("PLY list exceeds the item limit"));
                }
                let mut list = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
                for _ in 0..count {
                    list.push(read_binary_scalar(reader, *item)?);
                }
                values.push(PropertyValue::List(list));
            }
        }
    }
    Ok(values)
}

fn read_binary_scalar(
    reader: &mut impl Read,
    scalar: ScalarType,
) -> Result<f64, PreparedTriangleMeshError> {
    macro_rules! read {
        ($type:ty) => {{
            let mut bytes = [0_u8; std::mem::size_of::<$type>()];
            reader.read_exact(&mut bytes)?;
            <$type>::from_le_bytes(bytes) as f64
        }};
    }
    Ok(match scalar {
        ScalarType::I8 => read!(i8),
        ScalarType::U8 => read!(u8),
        ScalarType::I16 => read!(i16),
        ScalarType::U16 => read!(u16),
        ScalarType::I32 => read!(i32),
        ScalarType::U32 => read!(u32),
        ScalarType::F32 => read!(f32),
        ScalarType::F64 => read!(f64),
    })
}

fn validate_vertex_schema(element: &Element) -> Result<(), PreparedTriangleMeshError> {
    for axis in ["x", "y", "z"] {
        let count = element
            .properties
            .iter()
            .filter(|property| matches!(property, Property::Scalar { name, .. } if name == axis))
            .count();
        if count != 1 {
            return Err(invalid(format!(
                "vertex property {axis} must occur exactly once"
            )));
        }
    }
    Ok(())
}

fn validate_face_schema(element: &Element) -> Result<bool, PreparedTriangleMeshError> {
    let matches = element
        .properties
        .iter()
        .filter_map(|property| match property {
            Property::List { name, item, .. }
                if name == "vertex_indices" || name == "vertex_index" =>
            {
                Some(*item)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(invalid("face vertex-index list must occur exactly once"));
    } else if !matches[0].is_integer() {
        return Err(invalid("face vertex-index type must be integer"));
    }
    let texture_properties = element
        .properties
        .iter()
        .filter_map(|property| match property {
            Property::List { name, item, .. } if name == "texcoord" => Some(*item),
            _ => None,
        })
        .collect::<Vec<_>>();
    if texture_properties.len() > 1 {
        return Err(invalid("face texcoord list must not be duplicated"));
    }
    if texture_properties
        .first()
        .is_some_and(|item| !matches!(item, ScalarType::F32 | ScalarType::F64))
    {
        return Err(invalid("face texcoord items must be floating point"));
    }
    Ok(texture_properties.len() == 1)
}

fn vertex_point(
    element: &Element,
    values: &[PropertyValue],
) -> Result<[f64; 3], PreparedTriangleMeshError> {
    let mut result = [None; 3];
    for (property, value) in element.properties.iter().zip(values) {
        let Property::Scalar { name, .. } = property else {
            continue;
        };
        let Some(axis) = ["x", "y", "z"]
            .iter()
            .position(|candidate| *candidate == name)
        else {
            continue;
        };
        let PropertyValue::Scalar(value) = value else {
            unreachable!()
        };
        if !value.is_finite() {
            return Err(invalid("vertex coordinate is not finite"));
        }
        result[axis] = Some(*value);
    }
    Ok(result.map(|value| value.expect("validated coordinate property")))
}

fn face_indices(
    element: &Element,
    values: &[PropertyValue],
) -> Result<[u64; 3], PreparedTriangleMeshError> {
    for (property, value) in element.properties.iter().zip(values) {
        let Property::List { name, .. } = property else {
            continue;
        };
        if name != "vertex_indices" && name != "vertex_index" {
            continue;
        }
        let PropertyValue::List(values) = value else {
            unreachable!()
        };
        if values.len() != 3 {
            return Err(invalid("only triangular PLY faces are accepted"));
        }
        return values
            .iter()
            .map(|value| scalar_to_u64(*value, "face index"))
            .collect::<Result<Vec<_>, _>>()?
            .try_into()
            .map_err(|_| invalid("triangle index count is invalid"));
    }
    Err(invalid("face has no vertex-index list"))
}

fn face_texture_coordinates(
    element: &Element,
    values: &[PropertyValue],
) -> Result<[f32; 6], PreparedTriangleMeshError> {
    for (property, value) in element.properties.iter().zip(values) {
        let Property::List { name, .. } = property else {
            continue;
        };
        if name != "texcoord" {
            continue;
        }
        let PropertyValue::List(values) = value else {
            unreachable!()
        };
        if values.len() != 6
            || values.iter().any(|value| {
                !value.is_finite() || *value < f32::MIN as f64 || *value > f32::MAX as f64
            })
        {
            return Err(invalid(
                "face texcoord must contain exactly six finite float values",
            ));
        }
        return Ok(std::array::from_fn(|index| values[index] as f32));
    }
    Err(invalid("textured face has no texcoord list"))
}

fn reject_trailing_payload(
    reader: &mut impl Read,
    format: PlyFormat,
) -> Result<(), PreparedTriangleMeshError> {
    let mut trailing = Vec::new();
    reader.read_to_end(&mut trailing)?;
    let valid = match format {
        PlyFormat::Ascii => trailing.iter().all(u8::is_ascii_whitespace),
        PlyFormat::BinaryLittleEndian => trailing.is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid("PLY has trailing payload bytes"))
    }
}

fn parse_u64(value: &str, label: &str) -> Result<u64, PreparedTriangleMeshError> {
    value
        .parse()
        .map_err(|_| invalid(format!("invalid {label}")))
}

fn parse_f64(value: &str, label: &str) -> Result<f64, PreparedTriangleMeshError> {
    value
        .parse()
        .map_err(|_| invalid(format!("invalid {label}")))
}

fn scalar_to_u64(value: f64, label: &str) -> Result<u64, PreparedTriangleMeshError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u64::MAX as f64 {
        Err(invalid(format!("invalid {label}")))
    } else {
        Ok(value as u64)
    }
}

fn unique_staging_root(source: &Path) -> Result<PathBuf, PreparedTriangleMeshError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("system clock precedes Unix epoch"))?
        .as_nanos();
    Ok(source
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".hcad-ply-stage-{}-{nonce}", std::process::id())))
}

fn invalid(message: impl Into<String>) -> PreparedTriangleMeshError {
    PreparedTriangleMeshError::InvalidSource(message.into())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Write,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use himmelcad_core::photolab_jobs::CancellationToken;

    use super::{
        build_prepared_triangle_mesh_from_colmap_textured_directory,
        build_prepared_triangle_mesh_from_generated_ply, build_prepared_triangle_mesh_from_ply,
    };
    use crate::prepared_triangle_mesh::PreparedTriangleMeshOptions;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("hcad-ply-adapter-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_reordered_coordinates_and_skips_unknown_properties() {
        let root = TestDirectory::new();
        let source = root.0.join("mesh.ply");
        fs::write(&source, b"ply\nformat ascii 1.0\nelement vertex 4\nproperty uchar red\nproperty float z\nproperty float x\nproperty float y\nelement face 2\nproperty uchar quality\nproperty list uchar int vertex_indices\nend_header\n255 0 0 0\n255 0 1 0\n255 0 1 1\n255 0 0 1\n7 3 0 1 2\n8 3 0 2 3\n").unwrap();
        let product = build_prepared_triangle_mesh_from_ply(
            &source,
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("valid reordered PLY");
        assert_eq!(product.triangle_count, 2);
        assert!(product.preparation_descriptor_resource.is_some());
    }

    #[test]
    fn generated_ply_drops_zero_area_faces_and_reports_them() {
        let root = TestDirectory::new();
        let source = root.0.join("poisson.ply");
        fs::write(
            &source,
            b"ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n3 0 1 2\n3 1 3 2\n3 0 0 1\n3 0 1 1\n",
        )
        .unwrap();
        let report = build_prepared_triangle_mesh_from_generated_ply(
            &source,
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions::default(),
            [4_375_000.0, 5_281_000.0, 700.0],
            &CancellationToken::new(),
        )
        .expect("generated mesh with degenerate faces");
        assert_eq!(report.degenerate_faces_dropped, 2);
        assert_eq!(report.prepared.triangle_count, 2);
        // The strict adapter keeps refusing the same file.
        assert!(build_prepared_triangle_mesh_from_ply(
            &source,
            &root.0.join("prepared-strict"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .is_err());
    }

    #[test]
    fn rejects_out_of_range_face_indices() {
        let root = TestDirectory::new();
        let source = root.0.join("bad.ply");
        fs::write(&source, b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 9\n").unwrap();
        let error = build_prepared_triangle_mesh_from_ply(
            &source,
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect_err("invalid index");
        assert!(error.to_string().contains("exceeds vertex count"));
    }

    #[test]
    fn accepts_colmap_style_binary_little_endian_triangles() {
        let root = TestDirectory::new();
        let source = root.0.join("binary.ply");
        let mut file = fs::File::create(&source).unwrap();
        file.write_all(b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n").unwrap();
        for point in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for value in point {
                file.write_all(&value.to_le_bytes()).unwrap();
            }
        }
        file.write_all(&[3]).unwrap();
        for index in [0_i32, 1, 2] {
            file.write_all(&index.to_le_bytes()).unwrap();
        }
        file.flush().unwrap();
        let product = build_prepared_triangle_mesh_from_ply(
            &source,
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("binary COLMAP-style PLY");
        assert_eq!(product.triangle_count, 1);
    }

    #[test]
    fn colmap_textured_directory_preserves_face_corner_uvs_and_atlas_identity() {
        let root = TestDirectory::new();
        let source = root.0.join("textured");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("mesh.ply"),
            b"ply\nformat ascii 1.0\ncomment TextureFile texture.png\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 2\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2 6 0 0 1 0 1 1\n3 0 2 3 6 0 0 1 1 0 1\n",
        )
        .unwrap();
        image::RgbaImage::from_pixel(2, 2, image::Rgba([12, 34, 56, 255]))
            .save(source.join("texture.png"))
            .unwrap();
        let output = root.0.join("prepared");
        let product = build_prepared_triangle_mesh_from_colmap_textured_directory(
            &source,
            &output,
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("COLMAP textured mesh");
        assert_eq!(product.triangle_count, 2);
        assert_eq!(
            fs::read(output.join("texture.png")).unwrap(),
            fs::read(source.join("texture.png")).unwrap()
        );
        let gltf_bytes = fs::read(output.join("tiles/r.gltf")).unwrap();
        gltf::Gltf::from_slice(&gltf_bytes).expect("valid textured glTF");
        let gltf: serde_json::Value = serde_json::from_slice(&gltf_bytes).unwrap();
        assert_eq!(
            gltf["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"],
            1
        );
        assert_eq!(gltf["images"][0]["uri"], "../texture.png");
        assert_eq!(
            gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"],
            0
        );
        let uv = fs::read(output.join("tiles/r.texcoords.f32"))
            .unwrap()
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(
            uv,
            [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0]
        );
        let kernel: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("kernel-manifest.json")).unwrap())
                .unwrap();
        let assets = kernel["tiles"][0]["contents"][0]["decoderParameters"]["immutableAssets"]
            .as_array()
            .unwrap();
        assert!(assets.iter().any(|asset| asset["uri"] == "r.texcoords.f32"));
        assert!(assets.iter().any(|asset| asset["uri"] == "../texture.png"));
        let preparation: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("preparation.json")).unwrap()).unwrap();
        assert_eq!(preparation["texture"]["mediaType"], "image/png");
    }

    #[test]
    fn accepts_colmap_default_binary_textured_mesh_contract() {
        let root = TestDirectory::new();
        let source = root.0.join("textured-binary");
        fs::create_dir_all(&source).unwrap();
        let mut file = fs::File::create(source.join("mesh.ply")).unwrap();
        file.write_all(b"ply\nformat binary_little_endian 1.0\ncomment TextureFile texture.png\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n").unwrap();
        for point in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for value in point {
                file.write_all(&value.to_le_bytes()).unwrap();
            }
        }
        file.write_all(&[3]).unwrap();
        for index in [0_i32, 1, 2] {
            file.write_all(&index.to_le_bytes()).unwrap();
        }
        file.write_all(&[6]).unwrap();
        for value in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0] {
            file.write_all(&value.to_le_bytes()).unwrap();
        }
        file.flush().unwrap();
        image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 255, 255, 255]))
            .save(source.join("texture.png"))
            .unwrap();
        let output = root.0.join("prepared-binary");
        let product = build_prepared_triangle_mesh_from_colmap_textured_directory(
            &source,
            &output,
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("default binary COLMAP textured mesh");
        assert_eq!(product.triangle_count, 1);
        assert_eq!(
            fs::metadata(output.join("tiles/r.texcoords.f32"))
                .unwrap()
                .len(),
            24
        );
    }
}
