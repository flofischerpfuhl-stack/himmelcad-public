//! Provider-neutral, disk-bounded preparation of large triangle meshes.
//!
//! Render LODs and authoritative section topology intentionally have different
//! payloads. Render nodes may contain bounded vertex-cluster proxies, while
//! every source triangle occurs exactly once in one f64 section partition.

use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
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
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::mesh_tiler::{
    PreparedMeshProduct, PreparedSectionTopologyBounds, PreparedSectionTopologyPart,
    PreparedSectionTopologyProduct,
};

/// One source triangle in project-world coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleRecord {
    pub positions: [[f64; 3]; 3],
    pub material_slot: Option<u32>,
    pub texture_coordinates: Option<[[f32; 2]; 3]>,
}

/// Fallible streaming adapter item accepted by the disk-backed preprocessor.
pub trait TriangleRecordInput {
    fn into_triangle_record(self) -> Result<TriangleRecord, PreparedTriangleMeshError>;
}

impl TriangleRecordInput for TriangleRecord {
    fn into_triangle_record(self) -> Result<TriangleRecord, PreparedTriangleMeshError> {
        Ok(self)
    }
}

impl TriangleRecordInput for Result<TriangleRecord, PreparedTriangleMeshError> {
    fn into_triangle_record(self) -> Result<TriangleRecord, PreparedTriangleMeshError> {
        self
    }
}

/// Permanent preprocessing budgets. They bound memory and individual GPU uploads,
/// not the total dataset size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedTriangleMeshOptions {
    pub max_triangles_per_partition: u32,
    pub internal_proxy_triangle_budget: u32,
    pub closed_manifold: bool,
}

impl Default for PreparedTriangleMeshOptions {
    fn default() -> Self {
        Self {
            max_triangles_per_partition: 131_072,
            internal_proxy_triangle_budget: 16_384,
            closed_manifold: false,
        }
    }
}

#[derive(Debug, Error)]
pub enum PreparedTriangleMeshError {
    #[error("invalid triangle mesh source: {0}")]
    InvalidSource(String),
    #[error("triangle mesh preparation was cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy)]
struct MeshBounds {
    minimum: [f64; 3],
    maximum: [f64; 3],
}

impl MeshBounds {
    fn empty() -> Self {
        Self {
            minimum: [f64::INFINITY; 3],
            maximum: [f64::NEG_INFINITY; 3],
        }
    }

    fn include_triangle(&mut self, triangle: &TriangleRecord) {
        for position in triangle.positions {
            self.include_point(position);
        }
    }

    fn include_point(&mut self, position: [f64; 3]) {
        for axis in 0..3 {
            self.minimum[axis] = self.minimum[axis].min(position[axis]);
            self.maximum[axis] = self.maximum[axis].max(position[axis]);
        }
    }

    fn is_valid(self) -> bool {
        (0..3).all(|axis| {
            self.minimum[axis].is_finite()
                && self.maximum[axis].is_finite()
                && self.minimum[axis] <= self.maximum[axis]
        })
    }

    fn center(self) -> [f64; 3] {
        std::array::from_fn(|axis| self.minimum[axis] * 0.5 + self.maximum[axis] * 0.5)
    }

    fn longest_axis(self) -> usize {
        let extent = std::array::from_fn::<_, 3, _>(|axis| self.maximum[axis] - self.minimum[axis]);
        if extent[1] > extent[0] && extent[1] >= extent[2] {
            1
        } else if extent[2] > extent[0] {
            2
        } else {
            0
        }
    }
}

struct PendingNode {
    id: String,
    parent: Option<String>,
    spool: PathBuf,
    triangle_count: u64,
    bounds: MeshBounds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct EdgeRecord {
    endpoints: [[u64; 3]; 2],
    forward: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyManifest<'a> {
    schema_version: u32,
    root_tile_id: &'static str,
    tiles: &'a [LegacyTile],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTile {
    id: String,
    parent: Option<String>,
    children: Vec<String>,
    bounds: LegacyBounds,
    origin: [f64; 3],
    geometric_error: f64,
    vertex_count: u32,
    index_count: u64,
    position_url: String,
    index_url: String,
    index_component_type: &'static str,
    bvh: LegacyBvh,
    #[serde(skip)]
    kernel_content: KernelContent,
    #[serde(skip)]
    immutable_assets: Vec<KernelAsset>,
}

#[derive(Serialize)]
struct LegacyBounds {
    min: LegacyPoint,
    max: LegacyPoint,
}

#[derive(Serialize)]
struct LegacyPoint {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Serialize)]
struct LegacyBvh {
    url: String,
    version: u32,
}

struct KernelContent {
    uri: String,
    object_hash: String,
    byte_length: u64,
}

struct KernelAsset {
    uri: String,
    object_hash: String,
    byte_length: u64,
}

struct RenderMaterialIndexRange {
    material_slot: u32,
    byte_offset: u64,
    index_count: u32,
}

#[derive(Clone)]
struct KernelHierarchyPageResource {
    uri: String,
    object_hash: String,
    byte_length: u64,
}

const KERNEL_INLINE_TILE_LIMIT: usize = 512;
const KERNEL_PAGE_DESCENDANT_LEVELS: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionTopologyIndex<'a> {
    schema_version: u32,
    closed_manifold: bool,
    material_keys: &'a BTreeMap<u32, String>,
    parts: &'a [PreparedSectionTopologyPart],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparationDescriptor<'a> {
    schema_version: u32,
    source_topology_hash: &'a ObjectHash,
    source_topology_byte_length: u64,
    source_topology_encoding: &'static str,
    source_triangle_count: u64,
    partitioner: PreparationAlgorithm<'a>,
    render_lod: PreparationAlgorithm<'a>,
    max_triangles_per_partition: u32,
    internal_proxy_triangle_budget: u32,
    authoritative_position_encoding: &'static str,
    authoritative_origin: [f64; 3],
    closed_manifold: bool,
    closed_manifold_validation: &'static str,
    render_hierarchy: &'a GeometryResource,
    section_topology: &'a GeometryResource,
    #[serde(skip_serializing_if = "Option::is_none")]
    texture: Option<&'a GeometryResource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparationAlgorithm<'a> {
    id: &'a str,
    version: u32,
}

/// Builds a spatial hierarchy without retaining the source mesh in memory.
///
/// The iterator is consumed once into a fixed-width temporary stream. Recursive
/// partitioning then uses sequential disk scans, so peak memory is bounded by
/// the configured per-node proxy rather than total triangle count.
pub fn build_prepared_triangle_mesh<I>(
    triangles: I,
    output_root: &Path,
    options: PreparedTriangleMeshOptions,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, PreparedTriangleMeshError>
where
    I: IntoIterator,
    I::Item: TriangleRecordInput,
{
    build_prepared_triangle_mesh_impl(triangles, output_root, None, options, cancellation)
}

/// Builds the same authoritative hierarchy while retaining per-face-corner UVs
/// and binding one immutable PNG atlas to every render tile.
pub fn build_prepared_textured_triangle_mesh<I>(
    triangles: I,
    texture: &Path,
    output_root: &Path,
    options: PreparedTriangleMeshOptions,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, PreparedTriangleMeshError>
where
    I: IntoIterator,
    I::Item: TriangleRecordInput,
{
    build_prepared_triangle_mesh_impl(triangles, output_root, Some(texture), options, cancellation)
}

fn build_prepared_triangle_mesh_impl<I>(
    triangles: I,
    output_root: &Path,
    texture: Option<&Path>,
    options: PreparedTriangleMeshOptions,
    cancellation: &CancellationToken,
) -> Result<PreparedMeshProduct, PreparedTriangleMeshError>
where
    I: IntoIterator,
    I::Item: TriangleRecordInput,
{
    validate_options(options)?;
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root.join("tiles"))?;
    let work_root = output_root.join(".partition-work");
    fs::create_dir_all(&work_root)?;
    let root_spool = work_root.join("r.triangles");
    let edge_spool = options
        .closed_manifold
        .then(|| work_root.join("manifold.edges"));
    let (triangle_count, bounds, material_slots, has_texture_coordinates) =
        spool_source(triangles, &root_spool, edge_spool.as_deref(), cancellation)?;
    if triangle_count == 0 || !bounds.is_valid() {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "mesh contains no finite non-degenerate triangle".into(),
        ));
    }
    let source_topology_resource = file_resource(&root_spool, "hcad.triangle-spool-f64le@2")?;
    if texture.is_some() != has_texture_coordinates {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "texture atlas and complete per-face texture coordinates must be supplied together"
                .into(),
        ));
    }
    let texture_resource = texture
        .map(|source| prepare_texture_atlas(source, output_root, cancellation))
        .transpose()?;
    if let Some(edge_spool) = edge_spool.as_deref() {
        validate_closed_manifold(edge_spool, &work_root, cancellation)?;
        fs::remove_file(edge_spool)?;
    }
    let material_keys = material_slots
        .iter()
        .copied()
        .map(|slot| (slot, format!("material:{slot}")))
        .collect::<BTreeMap<_, _>>();
    let has_materials = !material_keys.is_empty();

    let mut pending = VecDeque::from([PendingNode {
        id: "r".into(),
        parent: None,
        spool: root_spool,
        triangle_count,
        bounds,
    }]);
    let mut render_tiles = Vec::new();
    let mut topology_parts = Vec::new();
    while let Some(node) = pending.pop_front() {
        check_cancelled(cancellation)?;
        let leaf = node.triangle_count <= u64::from(options.max_triangles_per_partition);
        let budget = if leaf {
            u32::try_from(node.triangle_count).expect("partition budget keeps leaf count in u32")
        } else {
            options.internal_proxy_triangle_budget
        };
        let mut tile = write_render_tile(
            output_root,
            &node.id,
            node.parent.clone(),
            &node.spool,
            node.triangle_count,
            node.bounds,
            budget,
            leaf,
            texture_resource.as_ref(),
            cancellation,
        )?;
        if leaf {
            topology_parts.push(write_section_partition(
                output_root,
                &node.id,
                &node.spool,
                node.triangle_count,
                node.bounds,
                has_materials,
                cancellation,
            )?);
        } else {
            let left_id = format!("{}0", node.id);
            let right_id = format!("{}1", node.id);
            let left_path = work_root.join(format!("{left_id}.triangles"));
            let right_path = work_root.join(format!("{right_id}.triangles"));
            let (left_count, left_bounds, right_count, right_bounds) = split_spool(
                &node.spool,
                &left_path,
                &right_path,
                node.triangle_count,
                node.bounds,
                cancellation,
            )?;
            tile.children = vec![left_id.clone(), right_id.clone()];
            pending.push_back(PendingNode {
                id: left_id,
                parent: Some(node.id.clone()),
                spool: left_path,
                triangle_count: left_count,
                bounds: left_bounds,
            });
            pending.push_back(PendingNode {
                id: right_id,
                parent: Some(node.id.clone()),
                spool: right_path,
                triangle_count: right_count,
                bounds: right_bounds,
            });
        }
        fs::remove_file(&node.spool)?;
        render_tiles.push(tile);
    }
    topology_parts.sort_unstable_by(|left, right| left.part_id.cmp(&right.part_id));
    render_tiles.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    fs::remove_dir_all(&work_root)?;

    let section_relative = PathBuf::from("section-topology.json");
    let section_bytes = serde_json::to_vec(&SectionTopologyIndex {
        schema_version: 2,
        closed_manifold: options.closed_manifold,
        material_keys: &material_keys,
        parts: &topology_parts,
    })?;
    fs::write(output_root.join(&section_relative), &section_bytes)?;
    let legacy_relative = PathBuf::from("manifest.json");
    fs::write(
        output_root.join(&legacy_relative),
        serde_json::to_vec(&LegacyManifest {
            schema_version: 1,
            root_tile_id: "r",
            tiles: &render_tiles,
        })?,
    )?;
    let kernel_relative = PathBuf::from("kernel-manifest.json");
    let kernel_bytes = kernel_manifest(output_root, &render_tiles)?;
    fs::write(output_root.join(&kernel_relative), &kernel_bytes)?;
    let kernel_resource =
        geometry_resource_from_bytes(&kernel_bytes, "himmelcad-prepared-hierarchy@1");
    let section_resource =
        geometry_resource_from_bytes(&section_bytes, "hcad.section-topology-index@2");
    let preparation_relative = PathBuf::from("preparation.json");
    let preparation_bytes = serde_json::to_vec(&PreparationDescriptor {
        schema_version: 1,
        source_topology_hash: &source_topology_resource.object_hash,
        source_topology_byte_length: source_topology_resource
            .byte_length
            .expect("file resource has a byte length"),
        source_topology_encoding: "triangle-list-f64le-with-u32-material-slot-and-optional-f32-uv",
        source_triangle_count: triangle_count,
        partitioner: PreparationAlgorithm {
            id: "hcad.longest-axis-midpoint-partitioner",
            version: 1,
        },
        render_lod: PreparationAlgorithm {
            id: "hcad.streaming-vertex-cluster-proxy",
            version: 1,
        },
        max_triangles_per_partition: options.max_triangles_per_partition,
        internal_proxy_triangle_budget: options.internal_proxy_triangle_budget,
        authoritative_position_encoding: "float64-le-xyz",
        authoritative_origin: [0.0; 3],
        closed_manifold: options.closed_manifold,
        closed_manifold_validation: if options.closed_manifold {
            "external-edge-sort@1"
        } else {
            "not-requested"
        },
        render_hierarchy: &kernel_resource,
        section_topology: &section_resource,
        texture: texture_resource.as_ref(),
    })?;
    fs::write(output_root.join(&preparation_relative), &preparation_bytes)?;

    Ok(PreparedMeshProduct {
        manifest_relative_path: legacy_relative,
        preparation_descriptor_relative_path: Some(preparation_relative),
        preparation_descriptor_resource: Some(geometry_resource_from_bytes(
            &preparation_bytes,
            "hcad.prepared-triangle-mesh-recipe@1",
        )),
        kernel_manifest_relative_path: Some(kernel_relative),
        kernel_manifest_resource: Some(kernel_resource),
        section_topology: Some(PreparedSectionTopologyProduct {
            manifest_relative_path: section_relative,
            manifest_resource: section_resource,
            closed_manifold: options.closed_manifold,
            parts: topology_parts,
        }),
        tile_count: u32::try_from(render_tiles.len()).map_err(|_| {
            PreparedTriangleMeshError::InvalidSource("mesh hierarchy exceeds u32 tiles".into())
        })?,
        triangle_count,
    })
}

fn validate_options(options: PreparedTriangleMeshOptions) -> Result<(), PreparedTriangleMeshError> {
    if options.max_triangles_per_partition == 0
        || options.max_triangles_per_partition > u32::MAX / 3
        || options.internal_proxy_triangle_budget < 64
        || options.internal_proxy_triangle_budget > u32::MAX / 3
    {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "triangle partition budget must be positive and proxy budget must be at least 64; both must fit u32 vertex indices".into(),
        ));
    }
    Ok(())
}

fn prepare_texture_atlas(
    source: &Path,
    output_root: &Path,
    cancellation: &CancellationToken,
) -> Result<GeometryResource, PreparedTriangleMeshError> {
    let mut source_file = BufReader::with_capacity(1024 * 1024, fs::File::open(source)?);
    let mut header = [0_u8; 24];
    source_file.read_exact(&mut header)?;
    if header[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || &header[12..16] != b"IHDR"
        || u32::from_be_bytes(header[16..20].try_into().unwrap()) == 0
        || u32::from_be_bytes(header[20..24].try_into().unwrap()) == 0
    {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "texture atlas must be a non-empty PNG".into(),
        ));
    }
    source_file.seek(SeekFrom::Start(0))?;
    let destination = output_root.join("texture.png");
    let mut writer = BufWriter::with_capacity(1024 * 1024, fs::File::create(&destination)?);
    let mut digest = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check_cancelled(cancellation)?;
        let read = source_file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        byte_length = byte_length.checked_add(read as u64).ok_or_else(|| {
            PreparedTriangleMeshError::InvalidSource("texture size overflows".into())
        })?;
    }
    writer.flush()?;
    Ok(GeometryResource {
        object_hash: ObjectHash(hex::encode(digest.finalize())),
        media_type: "image/png".into(),
        byte_length: Some(byte_length),
    })
}

fn spool_source<I>(
    triangles: I,
    path: &Path,
    edge_path: Option<&Path>,
    cancellation: &CancellationToken,
) -> Result<(u64, MeshBounds, BTreeSet<u32>, bool), PreparedTriangleMeshError>
where
    I: IntoIterator,
    I::Item: TriangleRecordInput,
{
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, fs::File::create(path)?);
    let mut edge_writer = edge_path
        .map(|path| fs::File::create(path).map(BufWriter::new))
        .transpose()?;
    let mut count = 0_u64;
    let mut bounds = MeshBounds::empty();
    let mut material_slots = BTreeSet::new();
    let mut has_texture_coordinates = None;
    for triangle in triangles {
        let triangle = triangle.into_triangle_record()?;
        if count % 65_536 == 0 {
            check_cancelled(cancellation)?;
        }
        validate_triangle(&triangle)?;
        let textured = triangle.texture_coordinates.is_some();
        if has_texture_coordinates
            .replace(textured)
            .is_some_and(|value| value != textured)
        {
            return Err(PreparedTriangleMeshError::InvalidSource(
                "texture coordinates must be present on every triangle or none".into(),
            ));
        }
        write_triangle(&mut writer, &triangle)?;
        if let Some(writer) = edge_writer.as_mut() {
            for (start, end) in [(0, 1), (1, 2), (2, 0)] {
                write_edge(
                    writer,
                    EdgeRecord::new(triangle.positions[start], triangle.positions[end]),
                )?;
            }
        }
        bounds.include_triangle(&triangle);
        material_slots.insert(triangle.material_slot.unwrap_or(0));
        if material_slots.len() > 65_536 {
            return Err(PreparedTriangleMeshError::InvalidSource(
                "mesh exceeds the material-slot limit".into(),
            ));
        }
        count = count.checked_add(1).ok_or_else(|| {
            PreparedTriangleMeshError::InvalidSource("triangle count overflows u64".into())
        })?;
    }
    writer.flush()?;
    if let Some(writer) = edge_writer.as_mut() {
        writer.flush()?;
    }
    Ok((
        count,
        bounds,
        material_slots,
        has_texture_coordinates.unwrap_or(false),
    ))
}

impl EdgeRecord {
    fn new(start: [f64; 3], end: [f64; 3]) -> Self {
        let start_key = point_key(start);
        let end_key = point_key(end);
        if point_before_or_equal(start, end) {
            Self {
                endpoints: [start_key, end_key],
                forward: true,
            }
        } else {
            Self {
                endpoints: [end_key, start_key],
                forward: false,
            }
        }
    }
}

fn point_before_or_equal(left: [f64; 3], right: [f64; 3]) -> bool {
    for axis in 0..3 {
        match left[axis].total_cmp(&right[axis]) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    true
}

fn point_key(point: [f64; 3]) -> [u64; 3] {
    point.map(|value| {
        if value == 0.0 {
            0.0_f64.to_bits()
        } else {
            value.to_bits()
        }
    })
}

fn write_edge(writer: &mut impl Write, edge: EdgeRecord) -> Result<(), std::io::Error> {
    for value in edge.endpoints.into_iter().flatten() {
        writer.write_all(&value.to_le_bytes())?;
    }
    writer.write_all(&[u8::from(edge.forward)])
}

fn read_edge(reader: &mut impl Read) -> Result<Option<EdgeRecord>, std::io::Error> {
    let mut first = [0_u8; 8];
    match reader.read_exact(&mut first) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut values = [0_u64; 6];
    values[0] = u64::from_le_bytes(first);
    for value in &mut values[1..] {
        let mut bytes = [0_u8; 8];
        reader.read_exact(&mut bytes)?;
        *value = u64::from_le_bytes(bytes);
    }
    let mut forward = [0_u8; 1];
    reader.read_exact(&mut forward)?;
    if forward[0] > 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid edge orientation",
        ));
    }
    Ok(Some(EdgeRecord {
        endpoints: [
            [values[0], values[1], values[2]],
            [values[3], values[4], values[5]],
        ],
        forward: forward[0] == 1,
    }))
}

fn validate_closed_manifold(
    edge_spool: &Path,
    work_root: &Path,
    cancellation: &CancellationToken,
) -> Result<(), PreparedTriangleMeshError> {
    const EDGES_PER_SORT_CHUNK: usize = 262_144;
    let sort_root = work_root.join("edge-sort");
    fs::create_dir_all(&sort_root)?;
    let mut source = BufReader::with_capacity(8 * 1024 * 1024, fs::File::open(edge_spool)?);
    let mut chunks = Vec::new();
    loop {
        check_cancelled(cancellation)?;
        let mut edges = Vec::with_capacity(EDGES_PER_SORT_CHUNK);
        while edges.len() < EDGES_PER_SORT_CHUNK {
            let Some(edge) = read_edge(&mut source)? else {
                break;
            };
            edges.push(edge);
        }
        if edges.is_empty() {
            break;
        }
        edges.sort_unstable();
        let path = sort_root.join(format!("{:08}.edges", chunks.len()));
        let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, fs::File::create(&path)?);
        for edge in edges {
            write_edge(&mut writer, edge)?;
        }
        writer.flush()?;
        chunks.push(path);
    }
    if chunks.is_empty() {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "closed mesh has no edges".into(),
        ));
    }
    let mut readers = chunks
        .iter()
        .map(|path| fs::File::open(path).map(BufReader::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = BinaryHeap::new();
    for (index, reader) in readers.iter_mut().enumerate() {
        if let Some(edge) = read_edge(reader)? {
            heap.push(Reverse((edge, index)));
        }
    }
    let mut current: Option<[[u64; 3]; 2]> = None;
    let mut occurrences = 0_u32;
    let mut forwards = 0_u32;
    let mut consumed = 0_u64;
    while let Some(Reverse((edge, source_index))) = heap.pop() {
        if consumed % 262_144 == 0 {
            check_cancelled(cancellation)?;
        }
        if current.is_some_and(|key| key != edge.endpoints) {
            validate_edge_group(occurrences, forwards)?;
            occurrences = 0;
            forwards = 0;
        }
        current = Some(edge.endpoints);
        occurrences += 1;
        forwards += u32::from(edge.forward);
        consumed += 1;
        if let Some(next) = read_edge(&mut readers[source_index])? {
            heap.push(Reverse((next, source_index)));
        }
    }
    validate_edge_group(occurrences, forwards)?;
    fs::remove_dir_all(sort_root)?;
    Ok(())
}

fn validate_edge_group(occurrences: u32, forwards: u32) -> Result<(), PreparedTriangleMeshError> {
    if occurrences != 2 || forwards != 1 {
        return Err(PreparedTriangleMeshError::InvalidSource(format!(
            "closed-manifold validation found an edge with {occurrences} occurrences and {forwards} forward orientations"
        )));
    }
    Ok(())
}

fn validate_triangle(triangle: &TriangleRecord) -> Result<(), PreparedTriangleMeshError> {
    if triangle
        .positions
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "triangle position is not finite".into(),
        ));
    }
    let [a, b, c] = triangle.positions;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    if cross.iter().all(|value| *value == 0.0) {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "degenerate triangle is not allowed in authoritative topology".into(),
        ));
    }
    if triangle
        .texture_coordinates
        .iter()
        .flatten()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "triangle texture coordinate is not finite".into(),
        ));
    }
    Ok(())
}

fn write_triangle(
    writer: &mut impl Write,
    triangle: &TriangleRecord,
) -> Result<(), std::io::Error> {
    for value in triangle.positions.into_iter().flatten() {
        writer.write_all(&value.to_le_bytes())?;
    }
    writer.write_all(&triangle.material_slot.unwrap_or(u32::MAX).to_le_bytes())?;
    writer.write_all(&u32::from(triangle.texture_coordinates.is_some()).to_le_bytes())?;
    if let Some(texture_coordinates) = triangle.texture_coordinates {
        for value in texture_coordinates.into_iter().flatten() {
            writer.write_all(&value.to_le_bytes())?;
        }
    }
    Ok(())
}

fn read_triangle(reader: &mut impl Read) -> Result<Option<TriangleRecord>, std::io::Error> {
    let mut first = [0_u8; 8];
    match reader.read_exact(&mut first) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut values = [0_f64; 9];
    values[0] = f64::from_le_bytes(first);
    for value in &mut values[1..] {
        let mut bytes = [0_u8; 8];
        reader.read_exact(&mut bytes)?;
        *value = f64::from_le_bytes(bytes);
    }
    let mut material = [0_u8; 4];
    reader.read_exact(&mut material)?;
    let material = u32::from_le_bytes(material);
    let mut texture_flag = [0_u8; 4];
    reader.read_exact(&mut texture_flag)?;
    let texture_flag = u32::from_le_bytes(texture_flag);
    if texture_flag > 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid triangle texture-coordinate flag",
        ));
    }
    let texture_coordinates = if texture_flag == 1 {
        let mut uv = [0_f32; 6];
        for value in &mut uv {
            let mut bytes = [0_u8; 4];
            reader.read_exact(&mut bytes)?;
            *value = f32::from_le_bytes(bytes);
        }
        Some([[uv[0], uv[1]], [uv[2], uv[3]], [uv[4], uv[5]]])
    } else {
        None
    };
    Ok(Some(TriangleRecord {
        positions: [
            [values[0], values[1], values[2]],
            [values[3], values[4], values[5]],
            [values[6], values[7], values[8]],
        ],
        material_slot: (material != u32::MAX).then_some(material),
        texture_coordinates,
    }))
}

fn split_spool(
    source: &Path,
    left: &Path,
    right: &Path,
    triangle_count: u64,
    bounds: MeshBounds,
    cancellation: &CancellationToken,
) -> Result<(u64, MeshBounds, u64, MeshBounds), PreparedTriangleMeshError> {
    let axis = bounds.longest_axis();
    let split = bounds.minimum[axis] * 0.5 + bounds.maximum[axis] * 0.5;
    let mut result = distribute_spool(source, left, right, cancellation, |triangle, _| {
        let centroid = triangle
            .positions
            .iter()
            .map(|point| point[axis])
            .sum::<f64>()
            / 3.0;
        centroid < split
    })?;
    if result.0 == 0 || result.2 == 0 {
        result = distribute_spool(source, left, right, cancellation, |_, index| {
            index < triangle_count / 2
        })?;
    }
    if result.0 == 0 || result.2 == 0 || result.0 + result.2 != triangle_count {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "triangle partition could not make bounded progress".into(),
        ));
    }
    Ok(result)
}

fn distribute_spool(
    source: &Path,
    left: &Path,
    right: &Path,
    cancellation: &CancellationToken,
    mut goes_left: impl FnMut(&TriangleRecord, u64) -> bool,
) -> Result<(u64, MeshBounds, u64, MeshBounds), PreparedTriangleMeshError> {
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, fs::File::open(source)?);
    let mut left_writer = BufWriter::with_capacity(4 * 1024 * 1024, fs::File::create(left)?);
    let mut right_writer = BufWriter::with_capacity(4 * 1024 * 1024, fs::File::create(right)?);
    let mut left_count = 0_u64;
    let mut right_count = 0_u64;
    let mut left_bounds = MeshBounds::empty();
    let mut right_bounds = MeshBounds::empty();
    let mut index = 0_u64;
    while let Some(triangle) = read_triangle(&mut reader)? {
        if index % 65_536 == 0 {
            check_cancelled(cancellation)?;
        }
        if goes_left(&triangle, index) {
            write_triangle(&mut left_writer, &triangle)?;
            left_bounds.include_triangle(&triangle);
            left_count += 1;
        } else {
            write_triangle(&mut right_writer, &triangle)?;
            right_bounds.include_triangle(&triangle);
            right_count += 1;
        }
        index += 1;
    }
    left_writer.flush()?;
    right_writer.flush()?;
    Ok((left_count, left_bounds, right_count, right_bounds))
}

#[allow(clippy::too_many_arguments)]
fn write_render_tile(
    output_root: &Path,
    id: &str,
    parent: Option<String>,
    spool: &Path,
    triangle_count: u64,
    bounds: MeshBounds,
    budget: u32,
    leaf: bool,
    texture: Option<&GeometryResource>,
    cancellation: &CancellationToken,
) -> Result<LegacyTile, PreparedTriangleMeshError> {
    let (render_triangles, geometric_error) = if leaf {
        (
            read_spool_triangles(spool, triangle_count, cancellation)?,
            0.0,
        )
    } else {
        clustered_proxy(spool, bounds, budget, cancellation)?
    };
    let origin = bounds.center();
    let position_url = format!("tiles/{id}.positions.f32");
    let index_url = format!("tiles/{id}.indices.u32");
    let texture_coordinate_url = texture.map(|_| format!("tiles/{id}.texcoords.f32"));
    let mut positions = BufWriter::new(fs::File::create(output_root.join(&position_url))?);
    let mut texture_coordinates = texture_coordinate_url
        .as_ref()
        .map(|url| fs::File::create(output_root.join(url)).map(BufWriter::new))
        .transpose()?;
    let mut indices_by_material = BTreeMap::<u32, Vec<u32>>::new();
    let mut written = 0_u32;
    let mut decoded_bounds = MeshBounds::empty();
    for triangle in render_triangles {
        if written % 65_536 == 0 {
            check_cancelled(cancellation)?;
        }
        for point in triangle.positions {
            let mut decoded = [0.0; 3];
            for axis in 0..3 {
                let local = (point[axis] - origin[axis]) as f32;
                positions.write_all(&local.to_le_bytes())?;
                decoded[axis] = origin[axis] + f64::from(local);
            }
            decoded_bounds.include_point(decoded);
        }
        if let Some(writer) = texture_coordinates.as_mut() {
            let coordinates = triangle.texture_coordinates.ok_or_else(|| {
                PreparedTriangleMeshError::InvalidSource(
                    "textured render proxy lost its texture coordinates".into(),
                )
            })?;
            for value in coordinates.into_iter().flatten() {
                writer.write_all(&value.to_le_bytes())?;
            }
        } else if triangle.texture_coordinates.is_some() {
            return Err(PreparedTriangleMeshError::InvalidSource(
                "untextured render tile contains texture coordinates".into(),
            ));
        }
        let base = written * 3;
        indices_by_material
            .entry(triangle.material_slot.unwrap_or(0))
            .or_default()
            .extend([base, base + 1, base + 2]);
        written += 1;
    }
    positions.flush()?;
    if let Some(writer) = texture_coordinates.as_mut() {
        writer.flush()?;
    }
    let mut indices = BufWriter::new(fs::File::create(output_root.join(&index_url))?);
    let mut material_ranges = Vec::with_capacity(indices_by_material.len());
    let mut index_byte_offset = 0_u64;
    for (material_slot, material_indices) in indices_by_material {
        let index_count = u32::try_from(material_indices.len()).map_err(|_| {
            PreparedTriangleMeshError::InvalidSource(
                "render material index range exceeds u32".into(),
            )
        })?;
        material_ranges.push(RenderMaterialIndexRange {
            material_slot,
            byte_offset: index_byte_offset,
            index_count,
        });
        for index in material_indices {
            indices.write_all(&index.to_le_bytes())?;
        }
        index_byte_offset += u64::from(index_count) * 4;
    }
    indices.flush()?;
    if written == 0 {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "render proxy contains no triangle".into(),
        ));
    }
    let bvh_url = format!("tiles/{id}.bvh");
    fs::write(output_root.join(&bvh_url), b"HCBVH001")?;
    let position_resource = file_resource(
        &output_root.join(&position_url),
        "hcad.positions-f32le-xyz@1",
    )?;
    let index_resource = file_resource(&output_root.join(&index_url), "hcad.indices-u32le@1")?;
    let texture_coordinate_resource = texture_coordinate_url
        .as_ref()
        .map(|url| file_resource(&output_root.join(url), "hcad.texcoords-f32le-uv@1"))
        .transpose()?;
    let (gltf_uri, gltf_resource) = write_gltf(
        output_root,
        id,
        written * 3,
        u64::from(written) * 3,
        decoded_bounds,
        origin,
        &position_url,
        &index_url,
        &material_ranges,
        texture_coordinate_url.as_deref(),
        texture,
    )?;
    let mut immutable_assets = vec![
        kernel_asset(file_name(&position_url)?, position_resource),
        kernel_asset(file_name(&index_url)?, index_resource),
    ];
    if let (Some(url), Some(resource)) = (
        texture_coordinate_url.as_deref(),
        texture_coordinate_resource,
    ) {
        immutable_assets.push(kernel_asset(file_name(url)?, resource));
    }
    if let Some(texture) = texture {
        immutable_assets.push(kernel_asset("../texture.png".into(), texture.clone()));
    }
    let mut hierarchy_bounds = decoded_bounds;
    hierarchy_bounds.include_point(bounds.minimum);
    hierarchy_bounds.include_point(bounds.maximum);
    Ok(LegacyTile {
        id: id.into(),
        parent,
        children: Vec::new(),
        bounds: legacy_bounds(hierarchy_bounds),
        origin,
        geometric_error,
        vertex_count: written * 3,
        index_count: u64::from(written) * 3,
        position_url: position_url.clone(),
        index_url: index_url.clone(),
        index_component_type: "uint32",
        bvh: LegacyBvh {
            url: bvh_url,
            version: 1,
        },
        kernel_content: KernelContent {
            uri: gltf_uri,
            object_hash: gltf_resource.object_hash.0,
            byte_length: gltf_resource.byte_length.expect("file resource has length"),
        },
        immutable_assets,
    })
}

fn read_spool_triangles(
    spool: &Path,
    triangle_count: u64,
    cancellation: &CancellationToken,
) -> Result<Vec<TriangleRecord>, PreparedTriangleMeshError> {
    let capacity = usize::try_from(triangle_count).map_err(|_| {
        PreparedTriangleMeshError::InvalidSource("partition exceeds address space".into())
    })?;
    let mut triangles = Vec::with_capacity(capacity);
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, fs::File::open(spool)?);
    while let Some(triangle) = read_triangle(&mut reader)? {
        if triangles.len() % 65_536 == 0 {
            check_cancelled(cancellation)?;
        }
        triangles.push(triangle);
    }
    if triangles.len() != capacity {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "triangle spool count changed during preparation".into(),
        ));
    }
    Ok(triangles)
}

fn clustered_proxy(
    spool: &Path,
    bounds: MeshBounds,
    budget: u32,
    cancellation: &CancellationToken,
) -> Result<(Vec<TriangleRecord>, f64), PreparedTriangleMeshError> {
    let target_cells = u64::from(budget).saturating_mul(2).max(8);
    let mut resolution = (target_cells as f64).cbrt().ceil().clamp(2.0, 2048.0) as u64;
    loop {
        let mut representatives = HashMap::<u64, [f64; 3]>::new();
        let mut retained =
            BTreeMap::<[u64; 3], ([u64; 3], Option<u32>, Option<[[f32; 2]; 3]>)>::new();
        let mut collapsed = BTreeMap::<u64, TriangleRecord>::new();
        let mut reader = BufReader::with_capacity(8 * 1024 * 1024, fs::File::open(spool)?);
        let mut source_index = 0_u64;
        let mut exceeded_budget = false;
        while let Some(triangle) = read_triangle(&mut reader)? {
            if source_index % 65_536 == 0 {
                check_cancelled(cancellation)?;
            }
            let cells = triangle
                .positions
                .map(|point| proxy_cell(point, bounds, resolution));
            if cells[0] != cells[1] && cells[1] != cells[2] && cells[2] != cells[0] {
                for (cell, point) in cells.into_iter().zip(triangle.positions) {
                    representatives.entry(cell).or_insert(point);
                }
                let mut canonical = cells;
                canonical.sort_unstable();
                retained.entry(canonical).or_insert((
                    cells,
                    triangle.material_slot,
                    triangle.texture_coordinates,
                ));
            } else {
                let centroid = std::array::from_fn(|axis| {
                    (triangle.positions[0][axis]
                        + triangle.positions[1][axis]
                        + triangle.positions[2][axis])
                        / 3.0
                });
                collapsed
                    .entry(proxy_cell(centroid, bounds, resolution))
                    .or_insert(triangle);
            }
            source_index += 1;
            if retained.len() + collapsed.len() > budget as usize {
                exceeded_budget = true;
                break;
            }
        }
        if !exceeded_budget {
            let contains_collapsed_source = !collapsed.is_empty();
            let mut proxy = Vec::with_capacity(retained.len() + collapsed.len());
            proxy.extend(retained.into_values().map(
                |(cells, material_slot, texture_coordinates)| TriangleRecord {
                    positions: cells.map(|cell| representatives[&cell]),
                    material_slot,
                    texture_coordinates,
                },
            ));
            proxy.extend(collapsed.into_values());
            if proxy.is_empty() || source_index == 0 {
                return Err(PreparedTriangleMeshError::InvalidSource(
                    "render proxy contains no triangle".into(),
                ));
            }
            let geometric_error = if contains_collapsed_source {
                mesh_bounds_diagonal(bounds)
            } else {
                proxy_cell_diagonal(bounds, resolution)
            };
            return Ok((proxy, geometric_error));
        }
        if resolution == 2 {
            return Err(PreparedTriangleMeshError::InvalidSource(
                "64-triangle proxy invariant was exceeded at minimum clustering resolution".into(),
            ));
        }
        resolution = (resolution.saturating_mul(3) / 4).max(2);
    }
}

fn proxy_cell(point: [f64; 3], bounds: MeshBounds, resolution: u64) -> u64 {
    let coordinate = std::array::from_fn::<_, 3, _>(|axis| {
        let extent = bounds.maximum[axis] - bounds.minimum[axis];
        if extent <= f64::EPSILON {
            0
        } else {
            (((point[axis] - bounds.minimum[axis]) / extent) * resolution as f64)
                .floor()
                .clamp(0.0, (resolution - 1) as f64) as u64
        }
    });
    coordinate[0]
        + resolution.saturating_mul(coordinate[1] + resolution.saturating_mul(coordinate[2]))
}

fn proxy_cell_diagonal(bounds: MeshBounds, resolution: u64) -> f64 {
    (0..3)
        .map(|axis| (bounds.maximum[axis] - bounds.minimum[axis]) / resolution as f64)
        .map(|extent| extent * extent)
        .sum::<f64>()
        .sqrt()
}

fn mesh_bounds_diagonal(bounds: MeshBounds) -> f64 {
    proxy_cell_diagonal(bounds, 1)
}

fn write_section_partition(
    output_root: &Path,
    id: &str,
    spool: &Path,
    triangle_count: u64,
    bounds: MeshBounds,
    has_materials: bool,
    cancellation: &CancellationToken,
) -> Result<PreparedSectionTopologyPart, PreparedTriangleMeshError> {
    let vertex_count = triangle_count.checked_mul(3).ok_or_else(|| {
        PreparedTriangleMeshError::InvalidSource("section vertex count overflows".into())
    })?;
    let vertex_count_u32 = u32::try_from(vertex_count).map_err(|_| {
        PreparedTriangleMeshError::InvalidSource("section partition exceeds u32 vertices".into())
    })?;
    let position_url = format!("tiles/{id}.section.positions.f64");
    let index_url = format!("tiles/{id}.section.indices.u32");
    let material_slot_url = has_materials.then(|| format!("tiles/{id}.section.materials.u32"));
    let mut positions = BufWriter::new(fs::File::create(output_root.join(&position_url))?);
    let mut indices = BufWriter::new(fs::File::create(output_root.join(&index_url))?);
    let mut materials = material_slot_url
        .as_ref()
        .map(|url| fs::File::create(output_root.join(url)).map(BufWriter::new))
        .transpose()?;
    let mut reader = BufReader::new(fs::File::open(spool)?);
    let mut triangle_index = 0_u64;
    while let Some(triangle) = read_triangle(&mut reader)? {
        if triangle_index % 65_536 == 0 {
            check_cancelled(cancellation)?;
        }
        for point in triangle.positions {
            for value in point {
                positions.write_all(&value.to_le_bytes())?;
            }
        }
        let base = u32::try_from(triangle_index * 3).expect("partition vertex count validated");
        for index in [base, base + 1, base + 2] {
            indices.write_all(&index.to_le_bytes())?;
        }
        if let Some(writer) = materials.as_mut() {
            writer.write_all(&triangle.material_slot.unwrap_or(0).to_le_bytes())?;
        }
        triangle_index += 1;
    }
    positions.flush()?;
    indices.flush()?;
    if let Some(writer) = materials.as_mut() {
        writer.flush()?;
    }
    let material_resource = material_slot_url
        .as_ref()
        .map(|url| file_resource(&output_root.join(url), "hcad.material-slots-u32le@1"))
        .transpose()?;
    let manifest = SectionTopologyPartitionManifest {
        schema_version: SectionTopologyPartitionManifest::SCHEMA_VERSION,
        origin: [0.0; 3],
        positions: file_resource(
            &output_root.join(&position_url),
            "hcad.positions-f64le-xyz@1",
        )?,
        position_component_type: SectionPositionComponentType::Float64,
        vertex_count: vertex_count_u32,
        indices: file_resource(&output_root.join(&index_url), "hcad.indices-u32le@1")?,
        index_component_type: SectionIndexComponentType::Uint32,
        index_count: vertex_count,
        material_slots: material_resource,
    };
    let topology_hash = manifest.content_hash()?.0;
    let manifest_url = format!("tiles/{id}.section.json");
    fs::write(
        output_root.join(&manifest_url),
        serde_json::to_vec(&manifest)?,
    )?;
    Ok(PreparedSectionTopologyPart {
        part_id: id.into(),
        topology_hash,
        bounds: PreparedSectionTopologyBounds {
            minimum: bounds.minimum,
            maximum: bounds.maximum,
        },
        manifest_url,
        position_url,
        index_url,
        material_slot_url,
    })
}

#[allow(clippy::too_many_arguments)]
fn write_gltf(
    output_root: &Path,
    id: &str,
    vertex_count: u32,
    index_count: u64,
    bounds: MeshBounds,
    origin: [f64; 3],
    position_url: &str,
    index_url: &str,
    material_ranges: &[RenderMaterialIndexRange],
    texture_coordinate_url: Option<&str>,
    texture: Option<&GeometryResource>,
) -> Result<(String, GeometryResource), PreparedTriangleMeshError> {
    let position_bytes = u64::from(vertex_count) * 12;
    let index_bytes = index_count * 4;
    let textured = texture_coordinate_url.is_some();
    if textured != texture.is_some() {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "glTF texture and texture coordinates must be supplied together".into(),
        ));
    }
    let index_accessor_base = if textured { 2 } else { 1 };
    let primitives = material_ranges
        .iter()
        .enumerate()
        .map(|(material_index, _)| {
            let attributes = if textured {
                serde_json::json!({ "POSITION": 0, "TEXCOORD_0": 1 })
            } else {
                serde_json::json!({ "POSITION": 0 })
            };
            serde_json::json!({
                "attributes": attributes,
                "indices": material_index + index_accessor_base,
                "material": material_index,
                "mode": 4
            })
        })
        .collect::<Vec<_>>();
    let mut accessors = vec![serde_json::json!({
        "bufferView": 0, "byteOffset": 0, "componentType": 5126,
        "count": vertex_count, "type": "VEC3",
        "min": [
            bounds.minimum[0] - origin[0],
            bounds.minimum[1] - origin[1],
            bounds.minimum[2] - origin[2]
        ],
        "max": [
            bounds.maximum[0] - origin[0],
            bounds.maximum[1] - origin[1],
            bounds.maximum[2] - origin[2]
        ]
    })];
    if let Some(url) = texture_coordinate_url {
        accessors.push(serde_json::json!({
            "bufferView": 2,
            "byteOffset": 0,
            "componentType": 5126,
            "count": vertex_count,
            "type": "VEC2"
        }));
        debug_assert!(!url.is_empty());
    }
    accessors.extend(material_ranges.iter().map(|range| {
        serde_json::json!({
            "bufferView": 1,
            "byteOffset": range.byte_offset,
            "componentType": 5125,
            "count": range.index_count,
            "type": "SCALAR"
        })
    }));
    let materials = material_ranges
        .iter()
        .map(|range| {
            let pbr = if textured {
                serde_json::json!({
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "baseColorTexture": { "index": 0, "texCoord": 0 },
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0
                })
            } else {
                serde_json::json!({
                    "baseColorFactor": [0.65, 0.67, 0.68, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0
                })
            };
            serde_json::json!({
                "name": format!("material:{}", range.material_slot),
                "extensions": { "KHR_materials_unlit": {} },
                "extras": { "hcadMaterialSlot": range.material_slot },
                "pbrMetallicRoughness": pbr,
                "doubleSided": true
            })
        })
        .collect::<Vec<_>>();
    let mut buffers = vec![
        serde_json::json!({ "uri": file_name(position_url)?, "byteLength": position_bytes }),
        serde_json::json!({ "uri": file_name(index_url)?, "byteLength": index_bytes }),
    ];
    let mut buffer_views = vec![
        serde_json::json!({ "buffer": 0, "byteOffset": 0, "byteLength": position_bytes, "target": 34962 }),
        serde_json::json!({ "buffer": 1, "byteOffset": 0, "byteLength": index_bytes, "target": 34963 }),
    ];
    if let Some(url) = texture_coordinate_url {
        let texture_coordinate_bytes = u64::from(vertex_count) * 8;
        buffers.push(serde_json::json!({
            "uri": file_name(url)?,
            "byteLength": texture_coordinate_bytes
        }));
        buffer_views.push(serde_json::json!({
            "buffer": 2,
            "byteOffset": 0,
            "byteLength": texture_coordinate_bytes,
            "target": 34962
        }));
    }
    let mut document = serde_json::json!({
        "asset": { "version": "2.0", "generator": "HimmelCAD prepared triangle mesh" },
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{
            "mesh": 0,
            "matrix": [
                1.0, 0.0, 0.0, 0.0,
                0.0, 0.0, -1.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 0.0, 1.0
            ]
        }],
        "meshes": [{ "primitives": primitives }],
        "buffers": buffers,
        "bufferViews": buffer_views,
        "accessors": accessors,
        "materials": materials
    });
    if let Some(texture) = texture {
        let object = document
            .as_object_mut()
            .expect("glTF document is an object");
        object.insert(
            "images".into(),
            serde_json::json!([{
                "uri": "../texture.png",
                "mimeType": texture.media_type,
                "extras": { "contentHash": texture.object_hash }
            }]),
        );
        object.insert(
            "samplers".into(),
            serde_json::json!([{ "magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497 }]),
        );
        object.insert(
            "textures".into(),
            serde_json::json!([{ "sampler": 0, "source": 0 }]),
        );
    }
    let bytes = serde_json::to_vec(&document)?;
    let uri = format!("tiles/{id}.gltf");
    fs::write(output_root.join(&uri), &bytes)?;
    Ok((uri, geometry_resource_from_bytes(&bytes, "model/gltf+json")))
}

fn kernel_manifest(
    output_root: &Path,
    tiles: &[LegacyTile],
) -> Result<Vec<u8>, PreparedTriangleMeshError> {
    let by_id = tiles
        .iter()
        .map(|tile| (tile.id.as_str(), tile))
        .collect::<BTreeMap<_, _>>();
    let root = by_id.get("r").copied().ok_or_else(|| {
        PreparedTriangleMeshError::InvalidSource("render hierarchy is missing root tile".into())
    })?;
    let descriptors = if tiles.len() <= KERNEL_INLINE_TILE_LIMIT {
        tiles
            .iter()
            .map(|tile| kernel_tile_descriptor(tile, None))
            .collect()
    } else {
        let mut page_resources = BTreeMap::new();
        let root_page =
            write_kernel_hierarchy_page(output_root, root, &by_id, &mut page_resources)?;
        vec![kernel_tile_descriptor(root, Some(&root_page))]
    };
    Ok(serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "roots": ["r"],
        "tiles": descriptors
    }))?)
}

fn write_kernel_hierarchy_page(
    output_root: &Path,
    owner: &LegacyTile,
    tiles: &BTreeMap<&str, &LegacyTile>,
    page_resources: &mut BTreeMap<String, KernelHierarchyPageResource>,
) -> Result<KernelHierarchyPageResource, PreparedTriangleMeshError> {
    if let Some(resource) = page_resources.get(&owner.id) {
        return Ok(resource.clone());
    }
    if owner.children.is_empty() {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "leaf tile cannot own a hierarchy page".into(),
        ));
    }
    let mut pending = owner
        .children
        .iter()
        .cloned()
        .map(|id| (id, 1_usize))
        .collect::<VecDeque<_>>();
    let mut page_tile_ids = Vec::new();
    let mut boundary_owners = Vec::new();
    while let Some((id, depth)) = pending.pop_front() {
        let tile = tiles.get(id.as_str()).copied().ok_or_else(|| {
            PreparedTriangleMeshError::InvalidSource(format!(
                "render hierarchy references missing tile {id}"
            ))
        })?;
        page_tile_ids.push(id);
        if depth == KERNEL_PAGE_DESCENDANT_LEVELS {
            if !tile.children.is_empty() {
                boundary_owners.push(tile.id.clone());
            }
        } else {
            pending.extend(
                tile.children
                    .iter()
                    .cloned()
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    if page_tile_ids.len() > (1 << (KERNEL_PAGE_DESCENDANT_LEVELS + 1)) - 2 {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "hierarchy page exceeds its binary descendant bound".into(),
        ));
    }
    for boundary_owner in boundary_owners {
        let tile = tiles
            .get(boundary_owner.as_str())
            .copied()
            .expect("boundary owner was collected from hierarchy");
        write_kernel_hierarchy_page(output_root, tile, tiles, page_resources)?;
    }
    let descriptors = page_tile_ids
        .iter()
        .map(|id| {
            let tile = tiles
                .get(id.as_str())
                .copied()
                .expect("page tile was collected from hierarchy");
            kernel_tile_descriptor(tile, page_resources.get(&tile.id))
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "owner": owner.id,
        "roots": owner.children,
        "tiles": descriptors
    }))?;
    let uri = format!("hierarchy-{}.json", owner.id);
    fs::write(output_root.join(&uri), &bytes)?;
    let resource = geometry_resource_from_bytes(&bytes, "himmelcad-prepared-hierarchy-page@1");
    let page = KernelHierarchyPageResource {
        uri,
        object_hash: resource.object_hash.0,
        byte_length: resource
            .byte_length
            .expect("in-memory hierarchy page has a byte length"),
    };
    page_resources.insert(owner.id.clone(), page.clone());
    Ok(page)
}

fn kernel_tile_descriptor(
    tile: &LegacyTile,
    child_page: Option<&KernelHierarchyPageResource>,
) -> serde_json::Value {
    let center = tile.origin;
    let dx = (tile.bounds.max.x - center[0])
        .abs()
        .max((tile.bounds.min.x - center[0]).abs());
    let dy = (tile.bounds.max.y - center[1])
        .abs()
        .max((tile.bounds.min.y - center[1]).abs());
    let dz = (tile.bounds.max.z - center[2])
        .abs()
        .max((tile.bounds.min.z - center[2]).abs());
    let child_page = child_page.map(|page| {
        serde_json::json!({
            "uri": page.uri,
            "byteOffset": 0,
            "byteLength": page.byte_length,
            "contentHash": page.object_hash,
            "decoderParameters": { "schemaVersion": 1 }
        })
    });
    serde_json::json!({
        "id": tile.id,
        "parent": tile.parent,
        "children": tile.children,
        "bounds": {
            "kind": "sphere",
            "center": { "x": center[0], "y": center[1], "z": center[2] },
            "radius": dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt()
        },
        "contentTransform": [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            center[0], center[1], center[2], 1.0
        ],
        "geometricError": tile.geometric_error,
        "refinement": "replace",
        "contents": [{
            "kind": "gltf",
            "uri": tile.kernel_content.uri,
            "byteOffset": 0,
            "byteLength": tile.kernel_content.byte_length,
            "primitiveCount": tile.index_count / 3,
            "contentHash": tile.kernel_content.object_hash,
            "decoderParameters": {
                "schemaVersion": 1,
                "requireComplete": true,
                "immutableAssets": tile.immutable_assets.iter().map(|asset| serde_json::json!({
                    "uri": asset.uri,
                    "contentHash": asset.object_hash,
                    "byteLength": asset.byte_length
                })).collect::<Vec<_>>()
            }
        }],
        "childPage": child_page
    })
}

fn legacy_bounds(bounds: MeshBounds) -> LegacyBounds {
    LegacyBounds {
        min: LegacyPoint {
            x: bounds.minimum[0],
            y: bounds.minimum[1],
            z: bounds.minimum[2],
        },
        max: LegacyPoint {
            x: bounds.maximum[0],
            y: bounds.maximum[1],
            z: bounds.maximum[2],
        },
    }
}

fn kernel_asset(uri: String, resource: GeometryResource) -> KernelAsset {
    KernelAsset {
        uri,
        object_hash: resource.object_hash.0,
        byte_length: resource.byte_length.expect("file resource has length"),
    }
}

fn file_name(url: &str) -> Result<String, PreparedTriangleMeshError> {
    Path::new(url)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| PreparedTriangleMeshError::InvalidSource("invalid mesh asset URL".into()))
}

fn geometry_resource_from_bytes(bytes: &[u8], media_type: &str) -> GeometryResource {
    GeometryResource {
        object_hash: ObjectHash::of_bytes(bytes),
        media_type: media_type.into(),
        byte_length: Some(u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
    }
}

fn file_resource(
    path: &Path,
    media_type: &str,
) -> Result<GeometryResource, PreparedTriangleMeshError> {
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
        media_type: media_type.into(),
        byte_length: Some(fs::metadata(path)?.len()),
    })
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), PreparedTriangleMeshError> {
    if cancellation.is_cancel_requested() {
        Err(PreparedTriangleMeshError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use himmelcad_core::{
        geometry_representation_registry::{
            SectionPositionComponentType, SectionTopologyPartitionManifest,
        },
        photolab_jobs::CancellationToken,
    };
    use himmelcad_render::{
        section_open_mesh, DatasetId, PreparedHierarchySource, SectionMeshInput, SectionPlane,
        TileId, WorldVec3,
    };

    use super::{
        build_prepared_triangle_mesh, geometry_resource_from_bytes, PreparedTriangleMeshOptions,
        TriangleRecord, KERNEL_INLINE_TILE_LIMIT,
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "himmelcad-prepared-triangle-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn triangle(x: f64) -> TriangleRecord {
        TriangleRecord {
            positions: [[x, -1.0, 0.0], [x + 1.0, 1.0, 0.0], [x + 2.0, -1.0, 0.0]],
            material_slot: None,
            texture_coordinates: None,
        }
    }

    fn closed_cube() -> Vec<TriangleRecord> {
        let vertices = [
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
            [-1.0, 1.0, 1.0],
        ];
        [
            [0, 3, 2],
            [0, 2, 1],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ]
        .into_iter()
        .map(|face| TriangleRecord {
            positions: face.map(|index| vertices[index]),
            material_slot: None,
            texture_coordinates: None,
        })
        .collect()
    }

    #[test]
    fn builds_bounded_render_hierarchy_and_complete_f64_topology() {
        let root = TestDirectory::new("hierarchy");
        let output = root.0.join("prepared");
        let product = build_prepared_triangle_mesh(
            (0..9).map(|index| triangle(f64::from(index) * 10.0)),
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 2,
                internal_proxy_triangle_budget: 64,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .expect("prepared mesh");
        assert_eq!(product.triangle_count, 9);
        assert!(product.tile_count > product.section_topology.as_ref().unwrap().parts.len() as u32);
        let kernel = fs::read(output.join("kernel-manifest.json")).unwrap();
        PreparedHierarchySource::from_json(
            DatasetId("mesh".into()),
            "https://example.test/kernel-manifest.json",
            &kernel,
        )
        .expect("valid prepared hierarchy");
        let topology = product.section_topology.unwrap();
        let exact_triangles = topology
            .parts
            .iter()
            .map(|part| {
                let manifest: SectionTopologyPartitionManifest =
                    serde_json::from_slice(&fs::read(output.join(&part.manifest_url)).unwrap())
                        .unwrap();
                assert_eq!(
                    manifest.position_component_type,
                    SectionPositionComponentType::Float64
                );
                manifest.index_count / 3
            })
            .sum::<u64>();
        assert_eq!(exact_triangles, 9);
    }

    #[test]
    fn exact_section_crosses_spatial_partition_without_a_trace_gap() {
        let root = TestDirectory::new("section");
        let output = root.0.join("prepared");
        let product = build_prepared_triangle_mesh(
            [
                TriangleRecord {
                    positions: [[-1.0, -1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
                TriangleRecord {
                    positions: [[-1.0, -1.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
                TriangleRecord {
                    positions: [[0.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
                TriangleRecord {
                    positions: [[0.0, -1.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
            ],
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 2,
                internal_proxy_triangle_budget: 64,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let topology = product.section_topology.unwrap();
        assert_eq!(topology.parts.len(), 2);
        let mut segments = Vec::new();
        for part in topology.parts {
            let manifest: SectionTopologyPartitionManifest =
                serde_json::from_slice(&fs::read(output.join(&part.manifest_url)).unwrap())
                    .unwrap();
            let position_bytes = fs::read(output.join(&part.position_url)).unwrap();
            let positions = position_bytes
                .chunks_exact(24)
                .map(|xyz| WorldVec3 {
                    x: f64::from_le_bytes(xyz[0..8].try_into().unwrap()),
                    y: f64::from_le_bytes(xyz[8..16].try_into().unwrap()),
                    z: f64::from_le_bytes(xyz[16..24].try_into().unwrap()),
                })
                .collect::<Vec<_>>();
            let index_bytes = fs::read(output.join(&part.index_url)).unwrap();
            let indices = index_bytes
                .chunks_exact(4)
                .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            assert_eq!(manifest.origin, [0.0; 3]);
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
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        normal: WorldVec3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    },
                    1e-12,
                )
                .unwrap()
                .segments,
            );
        }
        let mut minimum = f64::INFINITY;
        let mut maximum = f64::NEG_INFINITY;
        for segment in &segments {
            minimum = minimum.min(segment.start.x).min(segment.end.x);
            maximum = maximum.max(segment.start.x).max(segment.end.x);
        }
        assert_eq!((minimum, maximum), (-1.0, 1.0));
    }

    #[test]
    fn rejects_non_finite_source_before_publication() {
        let root = TestDirectory::new("invalid");
        let error = build_prepared_triangle_mesh(
            [TriangleRecord {
                positions: [[0.0, 0.0, 0.0], [1.0, f64::NAN, 0.0], [0.0, 1.0, 0.0]],
                material_slot: None,
                texture_coordinates: None,
            }],
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect_err("invalid mesh");
        assert!(error.to_string().contains("not finite"));
    }

    #[test]
    fn globally_validates_a_closed_cube_split_across_partitions() {
        let root = TestDirectory::new("closed-cube");
        let output = root.0.join("prepared");
        let product = build_prepared_triangle_mesh(
            closed_cube(),
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 2,
                internal_proxy_triangle_budget: 64,
                closed_manifold: true,
            },
            &CancellationToken::new(),
        )
        .expect("globally closed cube");
        let topology = product.section_topology.unwrap();
        assert!(topology.closed_manifold);
        assert!(topology.parts.len() > 1);
        let index: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("section-topology.json")).unwrap())
                .unwrap();
        assert_eq!(index["materialKeys"]["0"], "material:0");
    }

    #[test]
    fn render_bounds_cover_f32_vertices_at_large_world_coordinates() {
        let root = TestDirectory::new("large-coordinate-bounds");
        let output = root.0.join("prepared");
        build_prepared_triangle_mesh(
            [TriangleRecord {
                positions: [
                    [6_378_257.123_456, 5_400_020.234_567, 542.345_678],
                    [6_378_257.124_456, 5_400_020.234_567, 542.345_678],
                    [6_378_257.123_456, 5_400_020.235_567, 542.346_678],
                ],
                material_slot: None,
                texture_coordinates: None,
            }],
            &output,
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        let tile = &manifest["tiles"][0];
        let origin = [
            tile["origin"][0].as_f64().unwrap(),
            tile["origin"][1].as_f64().unwrap(),
            tile["origin"][2].as_f64().unwrap(),
        ];
        let minimum = [
            tile["bounds"]["min"]["x"].as_f64().unwrap(),
            tile["bounds"]["min"]["y"].as_f64().unwrap(),
            tile["bounds"]["min"]["z"].as_f64().unwrap(),
        ];
        let maximum = [
            tile["bounds"]["max"]["x"].as_f64().unwrap(),
            tile["bounds"]["max"]["y"].as_f64().unwrap(),
            tile["bounds"]["max"]["z"].as_f64().unwrap(),
        ];
        for xyz in fs::read(output.join("tiles/r.positions.f32"))
            .unwrap()
            .chunks_exact(12)
        {
            for axis in 0..3 {
                let local = f32::from_le_bytes(xyz[axis * 4..axis * 4 + 4].try_into().unwrap());
                let decoded = origin[axis] + f64::from(local);
                assert!(decoded >= minimum[axis] && decoded <= maximum[axis]);
            }
        }
    }

    #[test]
    fn render_gltf_preserves_deterministic_material_slot_primitives() {
        let root = TestDirectory::new("render-material-slots");
        let output = root.0.join("prepared");
        build_prepared_triangle_mesh(
            [
                TriangleRecord {
                    material_slot: Some(7),
                    ..triangle(0.0)
                },
                TriangleRecord {
                    material_slot: Some(3),
                    ..triangle(10.0)
                },
            ],
            &output,
            PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        let gltf_bytes = fs::read(output.join("tiles/r.gltf")).unwrap();
        gltf::Gltf::from_slice(&gltf_bytes).expect("valid multi-material glTF");
        let gltf: serde_json::Value = serde_json::from_slice(&gltf_bytes).unwrap();
        let primitives = gltf["meshes"][0]["primitives"].as_array().unwrap();
        assert_eq!(primitives.len(), 2);
        assert_eq!(
            gltf["nodes"][0]["matrix"],
            serde_json::json!([
                1.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0
            ])
        );
        assert_eq!(primitives[0]["indices"], 1);
        assert_eq!(primitives[1]["indices"], 2);
        assert_eq!(gltf["materials"][0]["extras"]["hcadMaterialSlot"], 3);
        assert_eq!(gltf["materials"][1]["extras"]["hcadMaterialSlot"], 7);
        assert_eq!(gltf["accessors"][1]["count"], 3);
        assert_eq!(gltf["accessors"][2]["count"], 3);
        let indices = fs::read(output.join("tiles/r.indices.u32"))
            .unwrap()
            .chunks_exact(4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(indices, [3, 4, 5, 0, 1, 2]);
        let topology: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("section-topology.json")).unwrap())
                .unwrap();
        assert_eq!(topology["materialKeys"]["3"], "material:3");
        assert_eq!(topology["materialKeys"]["7"], "material:7");
    }

    #[test]
    fn clustered_parent_proxy_represents_distant_source_regions() {
        let root = TestDirectory::new("clustered-parent");
        let output = root.0.join("prepared");
        build_prepared_triangle_mesh(
            [triangle(0.0), triangle(10_000.0)],
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 1,
                internal_proxy_triangle_budget: 64,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        let root_tile = manifest["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tile| tile["id"] == "r")
            .unwrap();
        assert_eq!(root_tile["indexCount"], 6);
        assert!(root_tile["bounds"]["min"]["x"].as_f64().unwrap() <= 0.0);
        assert!(root_tile["bounds"]["max"]["x"].as_f64().unwrap() >= 10_002.0);
    }

    #[test]
    fn clustered_parent_adapts_without_dropping_occupied_regions() {
        let root = TestDirectory::new("adaptive-clustered-parent");
        let output = root.0.join("prepared");
        let triangles = (0..6).flat_map(|x| {
            (0..6).flat_map(move |y| {
                (0..6).map(move |z| {
                    let base = [
                        f64::from(x) * 10.0,
                        f64::from(y) * 10.0,
                        f64::from(z) * 10.0,
                    ];
                    TriangleRecord {
                        positions: [
                            base,
                            [base[0] + 0.1, base[1], base[2]],
                            [base[0], base[1] + 0.1, base[2] + 0.1],
                        ],
                        material_slot: None,
                        texture_coordinates: None,
                    }
                })
            })
        });
        build_prepared_triangle_mesh(
            triangles,
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 200,
                internal_proxy_triangle_budget: 64,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        let root_tile = manifest["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tile| tile["id"] == "r")
            .unwrap();
        assert_eq!(root_tile["indexCount"], 64 * 3);
        assert!(root_tile["bounds"]["min"]["x"].as_f64().unwrap() <= 0.0);
        assert!(root_tile["bounds"]["max"]["x"].as_f64().unwrap() >= 50.1);
        assert!(root_tile["geometricError"].as_f64().unwrap() > 86.0);
    }

    #[test]
    fn large_kernel_hierarchy_is_hash_bound_and_lazily_pageable() {
        let root = TestDirectory::new("paged-kernel-hierarchy");
        let output = root.0.join("prepared");
        let product = build_prepared_triangle_mesh(
            (0..300).map(|index| triangle(f64::from(index) * 10.0)),
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 1,
                internal_proxy_triangle_budget: 64,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(product.tile_count as usize > KERNEL_INLINE_TILE_LIMIT);
        let root_bytes = fs::read(output.join("kernel-manifest.json")).unwrap();
        let root_json: serde_json::Value = serde_json::from_slice(&root_bytes).unwrap();
        assert_eq!(root_json["tiles"].as_array().unwrap().len(), 1);
        let mut source = PreparedHierarchySource::from_json(
            DatasetId("paged-mesh".into()),
            "https://example.test/prepared/kernel-manifest.json",
            &root_bytes,
        )
        .unwrap();
        let mut pending = vec![("r".to_owned(), root_json["tiles"][0]["childPage"].clone())];
        let mut seen_owners = BTreeSet::new();
        let mut descriptor_count = 1_usize;
        while let Some((owner, reference)) = pending.pop() {
            assert!(seen_owners.insert(owner.clone()));
            assert_eq!(reference["byteOffset"], 0);
            let uri = reference["uri"].as_str().unwrap();
            let bytes = fs::read(output.join(uri)).unwrap();
            let resource =
                geometry_resource_from_bytes(&bytes, "himmelcad-prepared-hierarchy-page@1");
            assert_eq!(reference["contentHash"], resource.object_hash.0);
            assert_eq!(reference["byteLength"].as_u64(), resource.byte_length);
            let page: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(page["owner"], owner);
            let page_tiles = page["tiles"].as_array().unwrap();
            assert!(page_tiles.len() <= 510);
            descriptor_count += page_tiles.len();
            let resolved_uri = format!("https://example.test/prepared/{uri}");
            source
                .apply_hierarchy_page(&TileId(owner), &resolved_uri, &bytes)
                .unwrap();
            for tile in page_tiles {
                if !tile["childPage"].is_null() {
                    pending.push((
                        tile["id"].as_str().unwrap().to_owned(),
                        tile["childPage"].clone(),
                    ));
                }
            }
        }
        assert!(seen_owners.len() > 1);
        assert_eq!(source.generation() as usize, seen_owners.len());
        assert_eq!(descriptor_count, product.tile_count as usize);
    }

    #[test]
    fn rejects_a_proxy_budget_too_small_for_spatial_coverage() {
        let root = TestDirectory::new("invalid-proxy-budget");
        let error = build_prepared_triangle_mesh(
            [triangle(0.0)],
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions {
                internal_proxy_triangle_budget: 63,
                ..PreparedTriangleMeshOptions::default()
            },
            &CancellationToken::new(),
        )
        .expect_err("proxy budget below the coverage invariant must fail");
        assert!(error.to_string().contains("at least 64"));
    }

    #[test]
    fn refuses_to_publish_an_open_mesh_as_closed() {
        let root = TestDirectory::new("false-closed");
        let error = build_prepared_triangle_mesh(
            [triangle(0.0)],
            &root.0.join("prepared"),
            PreparedTriangleMeshOptions {
                closed_manifold: true,
                ..PreparedTriangleMeshOptions::default()
            },
            &CancellationToken::new(),
        )
        .expect_err("boundary edges must fail closed-manifold validation");
        assert!(error.to_string().contains("closed-manifold validation"));
    }

    #[test]
    #[ignore = "explicit multi-million-triangle disk-bounded preparation gate"]
    fn large_synthetic_mesh_is_partitioned_without_materializing_the_source() {
        let root = TestDirectory::new("large-stream");
        let output = root.0.join("prepared");
        let triangle_count = std::env::var("HCAD_LARGE_MESH_TRIANGLES")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(2_000_000);
        let product = build_prepared_triangle_mesh(
            (0..triangle_count).map(|index| {
                let column = (index % 100_000) as f64;
                let row = (index / 100_000) as f64;
                TriangleRecord {
                    positions: [
                        [column, row, 0.0],
                        [column + 0.8, row, 0.1],
                        [column, row + 0.8, 0.2],
                    ],
                    material_slot: None,
                    texture_coordinates: None,
                }
            }),
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 100_000,
                internal_proxy_triangle_budget: 8_192,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .expect("large streamed mesh");
        assert_eq!(product.triangle_count, triangle_count);
        assert!(!output.join(".partition-work").exists());
        let topology = product.section_topology.expect("section topology");
        let exact_triangles = topology
            .parts
            .iter()
            .map(|part| {
                let manifest: SectionTopologyPartitionManifest =
                    serde_json::from_slice(&fs::read(output.join(&part.manifest_url)).unwrap())
                        .unwrap();
                assert!(manifest.index_count / 3 <= 100_000);
                manifest.index_count / 3
            })
            .sum::<u64>();
        assert_eq!(exact_triangles, triangle_count);
    }
}
