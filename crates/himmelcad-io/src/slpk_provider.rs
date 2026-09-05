//! Safe I3S Scene Layer Package import into the shared prepared hierarchy.
//!
//! This provider is an archive/parser/conversion boundary, not a renderer. It
//! accepts the I3S common mesh profiles, converts their bounded uncompressed
//! triangle resources to immutable GLB tiles and publishes the exact
//! `himmelcad-prepared-hierarchy@1` contract used by every other streamed mesh.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, EntityTypeId, GeometryObject, GeometryResource, Representation,
    RepresentationAuthority, RepresentationRole, TriangleMeshGeometry, TriangleMeshStorage,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use himmelcad_render::{
    BoundingVolume, ContentKind, ContentReference, PreparedHierarchyManifest, RefinementMode,
    TileDescriptor, TileId, WorldTransform, WorldVec3,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::read::ZipArchive;

use crate::canonical_provider::{
    CanonicalImportPackage, CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject,
    CanonicalPreparedDataset, FormatCapability, FormatProviderDescriptor, ImportProbe,
    ImportProbeRequest, PreparedDatasetArtifact, ProviderContractError, ProviderOperationContext,
    ProviderOptionContract, ProviderProgress, StagedArtifactRoots, CANONICAL_IO_SCHEMA_VERSION,
};

/// Stable provider identity.
pub const SLPK_PROVIDER_ID: &str = "hcad.io.slpk-i3s@1";
/// Exact prepared import surface. Source I3S version/profile remains provenance.
pub const SLPK_FORMAT_ID: &str = "slpk-i3s-common-mesh@1";
const PREPARED_FORMAT_ID: &str = "himmelcad-prepared-hierarchy@1";

const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 2_000_000;
const MAX_TOTAL_UNCOMPRESSED: u64 = 128 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GEOMETRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TEXTURE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TEXTURE_DIMENSION: u32 = 32_768;
const MAX_TEXTURE_PIXELS: u64 = 268_435_456;
const MAX_COMPRESSION_RATIO: u64 = 250;
const MAX_JSON_DEPTH: usize = 64;
const MAX_NODES: usize = 2_000_000;
const MAX_CHILDREN: usize = 4096;
const MAX_VERTICES_PER_TILE: u64 = 100_000_000;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Import-only SLPK provider. Export is intentionally absent: rebuilding an
/// interoperable I3S store requires a separate conformance/corpus gate.
pub struct SlpkCanonicalProvider {
    descriptor: FormatProviderDescriptor,
    prepared_root: PathBuf,
}

impl SlpkCanonicalProvider {
    #[must_use]
    pub fn new(prepared_root: PathBuf) -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: SLPK_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "I3S Scene Layer Package (SLPK)".to_owned(),
                format_ids: vec![SLPK_FORMAT_ID.to_owned()],
                extensions: vec!["slpk".to_owned()],
                media_types: vec!["application/vnd.esri.slpk".to_owned()],
                capabilities: vec![FormatCapability::Import],
                import_options: Some(ProviderOptionContract::object(
                    serde_json::json!({
                        "layerId": {"type": ["integer", "null"], "minimum": 0},
                    }),
                    serde_json::json!({"layerId": null}),
                )),
                export_options: None,
            },
            prepared_root,
        }
    }
}

impl Default for SlpkCanonicalProvider {
    fn default() -> Self {
        Self::new(std::env::temp_dir().join("himmelcad-slpk-provider"))
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct ImportOptions {
    layer_id: Option<u64>,
}

impl CanonicalImportProvider for SlpkCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let zip_magic = matches!(
            request.prefix.get(..4),
            Some(b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08")
        );
        let extension = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("slpk"));
        if zip_magic && (extension || request.media_type == Some("application/vnd.esri.slpk")) {
            Ok(Some(ImportProbe {
                format_id: SLPK_FORMAT_ID.to_owned(),
                confidence: if extension { 90 } else { 80 },
            }))
        } else {
            Ok(None)
        }
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != SLPK_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: ImportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        check_cancelled(context)?;
        let source_metadata = fs::metadata(request.source).map_err(provider_error)?;
        if !source_metadata.is_file()
            || source_metadata.len() < 22
            || source_metadata.len() > MAX_ARCHIVE_BYTES
        {
            return Err(provider_message(format!(
                "SLPK archive must be 22..={MAX_ARCHIVE_BYTES} bytes"
            )));
        }
        context.report_progress(ProviderProgress {
            phase: "scan".to_owned(),
            completed: 0,
            total: Some(source_metadata.len()),
            message: "SLPK central directory and source hash are validated".to_owned(),
        });
        let source_hash = hash_file(request.source, source_metadata.len(), context)?;
        let file = File::open(request.source).map_err(provider_error)?;
        let mut archive = ZipArchive::new(BufReader::new(file)).map_err(provider_error)?;
        let index = ArchiveIndex::scan(&mut archive)?;
        let layer_entry = index.select_layer(options.layer_id)?;
        let layer: LayerDocument = read_json(&mut archive, layer_entry, MAX_JSON_BYTES)?;
        layer.validate()?;
        let layer_base = if layer_entry
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.parse::<u64>().is_ok())
        {
            layer_entry.path.clone()
        } else {
            layer_entry
                .path
                .parent()
                .ok_or_else(|| provider_message("SLPK layer path has no parent"))?
                .to_path_buf()
        };
        let nodes = read_node_pages(&mut archive, &index, &layer_base, &layer, context)?;
        let dataset_id = format!("slpk-{source_hash}");
        let dataset_root = self.prepared_root.join("slpk").join(&source_hash);
        let tiles_root = dataset_root.join("tiles");
        fs::create_dir_all(&tiles_root).map_err(provider_error)?;
        let mut artifacts = Vec::new();
        let mut tiles = Vec::with_capacity(nodes.len());
        let mut converted = 0_u64;
        for node in &nodes {
            check_cancelled(context)?;
            let tile = convert_node(
                &mut archive,
                &index,
                &layer_base,
                &layer,
                node,
                &tiles_root,
                &mut artifacts,
            )?;
            if !tile.contents.is_empty() {
                converted += 1;
            }
            tiles.push(tile);
            context.report_progress(ProviderProgress {
                phase: "convert".to_owned(),
                completed: tiles.len() as u64,
                total: Some(nodes.len() as u64),
                message: "I3S mesh resources become common GLB tiles".to_owned(),
            });
        }
        check_cancelled(context)?;
        if converted == 0 {
            return Err(provider_message("SLPK contains no supported mesh geometry"));
        }
        let root_index = layer.node_pages.root_index.unwrap_or(0);
        if !nodes.iter().any(|node| node.index == root_index) {
            return Err(provider_message("SLPK root node is missing"));
        }
        let manifest = PreparedHierarchyManifest {
            schema_version: 1,
            roots: vec![TileId(root_index.to_string())],
            tiles,
        };
        let manifest_bytes = manifest.to_validated_json().map_err(provider_error)?;
        let manifest_artifact = write_artifact(
            &dataset_root,
            Path::new("manifest.json"),
            &manifest_bytes,
            PREPARED_FORMAT_ID,
        )?;
        artifacts.push(manifest_artifact.clone());
        artifacts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let provenance = SlpkProvenance {
            source_sha256: source_hash.clone(),
            source_byte_length: source_metadata.len(),
            layer_id: layer.id,
            layer_type: layer.layer_type.clone(),
            layer_revision: layer.version.clone(),
            i3s_version: layer.store.version.clone(),
            spatial_reference: layer.spatial_reference.clone(),
            archive_entries: index.entries.len(),
            archive_uncompressed_bytes: index.total_uncompressed,
            node_count: nodes.len(),
            converted_tile_count: converted,
            conversion:
                "I3S uncompressed triangle buffers -> GLB 2.0; shared PreparedHierarchyManifest"
                    .to_owned(),
        };
        let package = build_package(
            request.source,
            &dataset_id,
            &manifest_artifact.resource,
            artifacts,
            provenance,
        )?;
        package.validate()?;
        context.report_progress(ProviderProgress {
            phase: "admit".to_owned(),
            completed: 1,
            total: Some(1),
            message: "Prepared SLPK hierarchy passed canonical admission".to_owned(),
        });
        Ok(package)
    }

    fn staged_artifact_roots(
        &self,
        package: &CanonicalImportPackage,
    ) -> Result<StagedArtifactRoots, ProviderContractError> {
        Ok(StagedArtifactRoots {
            dataset_roots: package
                .datasets
                .iter()
                .map(|dataset| {
                    let hash = dataset
                        .dataset_id
                        .strip_prefix("slpk-")
                        .ok_or(ProviderContractError::InvalidArtifactRoots)?;
                    Ok((
                        dataset.dataset_id.clone(),
                        self.prepared_root.join("slpk").join(hash),
                    ))
                })
                .collect::<Result<_, ProviderContractError>>()?,
            resource_set_roots: Default::default(),
        })
    }
}

#[derive(Debug, Clone)]
struct ArchiveEntry {
    index: usize,
    path: PathBuf,
    size: u64,
}

struct ArchiveIndex {
    entries: BTreeMap<String, ArchiveEntry>,
    total_uncompressed: u64,
}

impl ArchiveIndex {
    fn scan<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Self, ProviderContractError> {
        if archive.is_empty() || archive.len() > MAX_ENTRIES {
            return Err(provider_message(format!(
                "SLPK entry count must be 1..={MAX_ENTRIES}"
            )));
        }
        let mut entries = BTreeMap::new();
        let mut total_uncompressed = 0_u64;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(provider_error)?;
            if entry.encrypted() || entry.is_symlink() {
                return Err(provider_message(
                    "SLPK encrypted/symlink entries are unsupported",
                ));
            }
            let Some(path) = entry.enclosed_name() else {
                return Err(provider_message("SLPK contains an unsafe archive path"));
            };
            validate_relative_path(&path)?;
            if entry.is_dir() {
                continue;
            }
            if !entry.is_file() || entry.size() > MAX_ENTRY_BYTES {
                return Err(provider_message("SLPK entry type or size is unsupported"));
            }
            if !matches!(
                entry.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            ) {
                return Err(provider_message(
                    "SLPK entry compression must be ZIP STORE or DEFLATE",
                ));
            }
            if entry.compressed_size() == 0 && entry.size() != 0
                || entry.compressed_size() != 0
                    && entry.size() / entry.compressed_size().max(1) > MAX_COMPRESSION_RATIO
            {
                return Err(provider_message(
                    "SLPK compression ratio exceeds safety limit",
                ));
            }
            total_uncompressed = total_uncompressed
                .checked_add(entry.size())
                .ok_or_else(|| provider_message("SLPK aggregate size overflow"))?;
            if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
                return Err(provider_message(
                    "SLPK aggregate uncompressed size exceeds limit",
                ));
            }
            let key = path_key(&path)?;
            let metadata = ArchiveEntry {
                index,
                path,
                size: entry.size(),
            };
            if entries.insert(key, metadata).is_some() {
                return Err(provider_message("SLPK contains duplicate normalized paths"));
            }
        }
        Ok(Self {
            entries,
            total_uncompressed,
        })
    }

    fn select_layer(&self, selected: Option<u64>) -> Result<&ArchiveEntry, ProviderContractError> {
        let mut layers = self
            .entries
            .values()
            .filter(|entry| layer_id_from_path(&entry.path).is_some())
            .collect::<Vec<_>>();
        layers.sort_by(|left, right| left.path.cmp(&right.path));
        if let Some(id) = selected {
            layers.retain(|entry| layer_id_from_path(&entry.path) == Some(id));
        }
        match layers.as_slice() {
            [entry] => Ok(*entry),
            [] => Err(provider_message(
                "SLPK contains no selectable I3S layer document",
            )),
            _ => Err(provider_message(
                "SLPK contains multiple layers; choose import option layerId",
            )),
        }
    }

    fn get(&self, path: &Path) -> Option<&ArchiveEntry> {
        path_key(path).ok().and_then(|key| self.entries.get(&key))
    }
}

fn layer_id_from_path(path: &Path) -> Option<u64> {
    let parts = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    for index in 0..parts.len() {
        if parts[index].eq_ignore_ascii_case("layers") && index + 1 < parts.len() {
            let id = parts[index + 1].parse().ok()?;
            if index + 2 == parts.len()
                || index + 3 == parts.len()
                    && parts[index + 2].eq_ignore_ascii_case("3dscenelayer.json")
            {
                return Some(id);
            }
        }
    }
    None
}

fn validate_relative_path(path: &Path) -> Result<(), ProviderContractError> {
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || matches!(component, Component::Normal(value) if value.to_string_lossy().contains('\0'))
        })
    {
        return Err(provider_message("SLPK archive path is not a safe relative path"));
    }
    Ok(())
}

fn path_key(path: &Path) -> Result<String, ProviderContractError> {
    validate_relative_path(path)?;
    Ok(path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
        .to_ascii_lowercase())
}

fn read_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry: &ArchiveEntry,
    limit: u64,
) -> Result<Vec<u8>, ProviderContractError> {
    if entry.size > limit {
        return Err(provider_message("SLPK resource exceeds operation limit"));
    }
    let mut zip_file = archive.by_index(entry.index).map_err(provider_error)?;
    let mut bytes = Vec::with_capacity(usize::try_from(entry.size.min(limit)).unwrap_or(0));
    zip_file
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(provider_error)?;
    if bytes.len() as u64 > limit {
        return Err(provider_message(
            "SLPK resource expands beyond operation limit",
        ));
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoded = Vec::new();
        GzDecoder::new(bytes.as_slice())
            .take(limit + 1)
            .read_to_end(&mut decoded)
            .map_err(provider_error)?;
        if decoded.len() as u64 > limit {
            return Err(provider_message(
                "SLPK inner gzip expands beyond operation limit",
            ));
        }
        bytes = decoded;
    }
    Ok(bytes)
}

fn read_json<R: Read + Seek, T: for<'de> Deserialize<'de>>(
    archive: &mut ZipArchive<R>,
    entry: &ArchiveEntry,
    limit: u64,
) -> Result<T, ProviderContractError> {
    let bytes = read_entry(archive, entry, limit)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(provider_error)?;
    validate_json_depth(&value, 0)?;
    serde_json::from_value(value).map_err(provider_error)
}

fn validate_json_depth(
    value: &serde_json::Value,
    depth: usize,
) -> Result<(), ProviderContractError> {
    if depth > MAX_JSON_DEPTH {
        return Err(provider_message("SLPK JSON nesting exceeds safety limit"));
    }
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                validate_json_depth(value, depth + 1)?;
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                validate_json_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpatialReference {
    #[serde(default)]
    wkid: Option<u64>,
    #[serde(default)]
    latest_wkid: Option<u64>,
    #[serde(default)]
    vcs_wkid: Option<u64>,
    #[serde(default)]
    wkt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerDocument {
    id: u64,
    layer_type: String,
    version: String,
    #[serde(default)]
    spatial_reference: Option<SpatialReference>,
    store: StoreDefinition,
    node_pages: NodePagesDefinition,
    geometry_definitions: Vec<GeometryDefinition>,
    #[serde(default)]
    material_definitions: Vec<serde_json::Value>,
    #[serde(default)]
    texture_set_definitions: Vec<TextureSetDefinition>,
}

impl LayerDocument {
    fn validate(&self) -> Result<(), ProviderContractError> {
        if !matches!(self.layer_type.as_str(), "IntegratedMesh" | "3DObject") {
            return Err(provider_message(format!(
                "unsupported I3S profile {}; only IntegratedMesh and 3DObject are admitted",
                self.layer_type
            )));
        }
        let major_minor = self
            .store
            .version
            .split('.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".");
        if !matches!(major_minor.as_str(), "1.7" | "1.8" | "1.9" | "1.10") {
            return Err(provider_message(format!(
                "unsupported I3S version {}; common node-page mesh versions 1.7..1.10 are supported",
                self.store.version
            )));
        }
        if !self.store.profile.eq_ignore_ascii_case("meshpyramid") {
            return Err(provider_message(format!(
                "unsupported I3S store profile {}; only meshpyramid enters this provider",
                self.store.profile
            )));
        }
        let wkid = self
            .spatial_reference
            .as_ref()
            .and_then(|value| value.latest_wkid.or(value.wkid));
        if wkid == Some(4326) {
            return Err(provider_message(
                "I3S geographic WKID 4326 requires an explicit project CRS/ECEF transform; silent degree coordinates are refused",
            ));
        }
        let count = self.node_pages.nodes_per_page;
        if count == 0 || count >= 4096 || !count.is_power_of_two() {
            return Err(provider_message(
                "I3S nodesPerPage must be a power of two below 4096",
            ));
        }
        if self.node_pages.lod_selection_metric_type != "maxScreenThresholdSQ" {
            return Err(provider_message("unsupported I3S node-page LOD metric"));
        }
        if self.geometry_definitions.is_empty() {
            return Err(provider_message("I3S geometryDefinitions is empty"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct StoreDefinition {
    profile: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodePagesDefinition {
    nodes_per_page: u64,
    #[serde(default)]
    root_index: Option<u64>,
    lod_selection_metric_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeometryDefinition {
    #[serde(default)]
    topology: Option<String>,
    geometry_buffers: Vec<GeometryBufferDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeometryBufferDefinition {
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    position: Option<AttributeDefinition>,
    #[serde(default)]
    normal: Option<AttributeDefinition>,
    #[serde(default)]
    uv0: Option<AttributeDefinition>,
    #[serde(default)]
    color: Option<AttributeDefinition>,
    #[serde(default)]
    uv_region: Option<AttributeDefinition>,
    #[serde(default)]
    feature_id: Option<AttributeDefinition>,
    #[serde(default)]
    face_range: Option<AttributeDefinition>,
    #[serde(default)]
    compressed_attributes: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttributeDefinition {
    r#type: String,
    component: u64,
    #[serde(default)]
    binding: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureSetDefinition {
    formats: Vec<TextureFormat>,
    #[serde(default)]
    atlas: bool,
}

#[derive(Debug, Deserialize)]
struct TextureFormat {
    name: String,
    format: String,
}

#[derive(Debug, Deserialize)]
struct NodePage {
    nodes: Vec<I3sNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct I3sNode {
    index: u64,
    #[serde(default)]
    parent_index: Option<u64>,
    #[serde(default)]
    lod_threshold: Option<f64>,
    obb: I3sObb,
    #[serde(default)]
    children: Vec<u64>,
    #[serde(default)]
    mesh: Option<I3sMesh>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct I3sObb {
    center: [f64; 3],
    half_size: [f64; 3],
    quaternion: [f64; 4],
}

#[derive(Debug, Clone, Deserialize)]
struct I3sMesh {
    #[serde(default)]
    material: Option<I3sMaterialRef>,
    #[serde(default)]
    geometry: Option<I3sGeometryRef>,
}

#[derive(Debug, Clone, Deserialize)]
struct I3sMaterialRef {
    definition: usize,
    #[serde(default)]
    resource: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct I3sGeometryRef {
    definition: usize,
    resource: u64,
    vertex_count: u64,
    #[serde(default)]
    feature_count: u64,
}

fn read_node_pages<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    index: &ArchiveIndex,
    layer_base: &Path,
    layer: &LayerDocument,
    context: &dyn ProviderOperationContext,
) -> Result<Vec<I3sNode>, ProviderContractError> {
    let node_pages_prefix = path_key(&layer_base.join("nodepages"))?;
    let mut page_entries = index
        .entries
        .iter()
        .filter(|(key, _)| key.starts_with(&(node_pages_prefix.clone() + "/")))
        .filter_map(|(key, entry)| {
            let suffix = key.strip_prefix(&(node_pages_prefix.clone() + "/"))?;
            let page = suffix
                .strip_suffix(".json")
                .unwrap_or(suffix)
                .parse::<u64>()
                .ok()?;
            Some((page, entry))
        })
        .collect::<Vec<_>>();
    page_entries.sort_by_key(|(page, _)| *page);
    if page_entries.is_empty() {
        return Err(provider_message("SLPK contains no node pages"));
    }
    let mut nodes = BTreeMap::new();
    for (expected_page, entry) in page_entries {
        check_cancelled(context)?;
        let page: NodePage = read_json(archive, entry, MAX_JSON_BYTES)?;
        if page.nodes.len() as u64 > layer.node_pages.nodes_per_page {
            return Err(provider_message("I3S node page exceeds nodesPerPage"));
        }
        for node in page.nodes {
            if node.index / layer.node_pages.nodes_per_page != expected_page
                || node.children.len() > MAX_CHILDREN
                || nodes.insert(node.index, node).is_some()
                || nodes.len() > MAX_NODES
            {
                return Err(provider_message("I3S node page index/topology is invalid"));
            }
        }
    }
    let nodes = nodes.into_values().collect::<Vec<_>>();
    let known = nodes.iter().map(|node| node.index).collect::<BTreeSet<_>>();
    for node in &nodes {
        if node.children.iter().any(|child| !known.contains(child))
            || node
                .parent_index
                .is_some_and(|parent| !known.contains(&parent))
            || node.children.contains(&node.index)
        {
            return Err(provider_message(
                "I3S node topology references unknown/cyclic nodes",
            ));
        }
        for child in &node.children {
            let child_node = nodes
                .iter()
                .find(|candidate| candidate.index == *child)
                .ok_or_else(|| provider_message("I3S child is missing"))?;
            if child_node.parent_index != Some(node.index) {
                return Err(provider_message("I3S parent/child links disagree"));
            }
        }
    }
    Ok(nodes)
}

fn convert_node<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    index: &ArchiveIndex,
    layer_base: &Path,
    layer: &LayerDocument,
    node: &I3sNode,
    tiles_root: &Path,
    artifacts: &mut Vec<PreparedDatasetArtifact>,
) -> Result<TileDescriptor, ProviderContractError> {
    let (bounds, transform) = node_spatial_contract(&node.obb)?;
    let mut contents = Vec::new();
    if let Some(mesh) = &node.mesh {
        if let Some(geometry) = &mesh.geometry {
            if geometry.vertex_count == 0
                || geometry.vertex_count > MAX_VERTICES_PER_TILE
                || geometry.vertex_count % 3 != 0
                || geometry.feature_count > geometry.vertex_count / 3
                || geometry.feature_count > u64::from(u32::MAX)
            {
                return Err(provider_message(
                    "I3S tile vertexCount must be a bounded unindexed triangle list",
                ));
            }
            let definition = layer
                .geometry_definitions
                .get(geometry.definition)
                .ok_or_else(|| provider_message("I3S geometry definition is out of range"))?;
            if definition.topology.as_deref().unwrap_or("triangle") != "triangle" {
                return Err(provider_message("I3S non-triangle topology is unsupported"));
            }
            let buffer = definition
                .geometry_buffers
                .first()
                .ok_or_else(|| provider_message("I3S geometry definition has no buffer"))?;
            if buffer.compressed_attributes.is_some() || buffer.position.is_none() {
                return Err(provider_message(
                    "I3S first geometry buffer must be the required uncompressed position layout",
                ));
            }
            if buffer.uv_region.is_some() {
                return Err(provider_message(
                    "I3S uvRegion atlas remapping is not yet supported; import refuses incorrect texture coordinates",
                ));
            }
            let geometry_path = layer_base
                .join("nodes")
                .join(geometry.resource.to_string())
                .join("geometries")
                .join("0");
            let geometry_entry = find_resource(index, &geometry_path)?;
            let geometry_bytes = read_entry(archive, geometry_entry, MAX_GEOMETRY_BYTES)?;
            let texture = resolve_base_color_texture(
                archive,
                index,
                layer_base,
                layer,
                mesh.material.as_ref(),
            )?;
            let glb = convert_geometry_to_glb(
                &geometry_bytes,
                buffer,
                geometry.vertex_count,
                geometry.feature_count,
                texture.as_ref(),
                mesh.material
                    .as_ref()
                    .and_then(|reference| layer.material_definitions.get(reference.definition)),
            )?;
            let relative = PathBuf::from("tiles").join(format!("{}.glb", node.index));
            let artifact = write_artifact(
                tiles_root
                    .parent()
                    .ok_or_else(|| provider_message("SLPK tile root has no dataset parent"))?,
                &relative,
                &glb,
                "model/gltf-binary",
            )?;
            contents.push(ContentReference {
                kind: ContentKind::Gltf,
                uri: format!("tiles/{}.glb", node.index),
                byte_offset: None,
                byte_length: None,
                primitive_count: Some(geometry.vertex_count / 3),
                content_hash: Some(artifact.resource.object_hash.0.clone()),
                decoder_parameters: Some(serde_json::json!({
                    "schemaId": "hcad.decoder.slpk-i3s-glb@1",
                    "sourceNodeIndex": node.index,
                    "sourceGeometryResource": geometry.resource,
                    "sourceGeometryDefinition": geometry.definition,
                    "featureCount": geometry.feature_count,
                    "featurePicking": if geometry.feature_count > 0 { "EXT_mesh_features/_FEATURE_ID_0" } else { "none" },
                })),
            });
            artifacts.push(artifact);
        }
    }
    let geometric_error = node.obb.half_size.iter().copied().fold(0.0_f64, f64::max);
    Ok(TileDescriptor {
        id: TileId(node.index.to_string()),
        parent: node.parent_index.map(|value| TileId(value.to_string())),
        children: node
            .children
            .iter()
            .map(|value| TileId(value.to_string()))
            .collect(),
        bounds,
        content_transform: transform,
        geometric_error,
        refinement: RefinementMode::Replace,
        contents,
        child_page: None,
        prepared_point_metadata: None,
        provider_metadata: Some(serde_json::json!({
            "schemaId": "hcad.provider.slpk-i3s-node@1",
            "sourceNodeIndex": node.index,
            "sourceLodThreshold": node.lod_threshold,
        })),
    })
}

fn find_resource<'a>(
    index: &'a ArchiveIndex,
    path: &Path,
) -> Result<&'a ArchiveEntry, ProviderContractError> {
    for candidate in [
        path.to_path_buf(),
        path.with_extension("bin"),
        path.with_extension("json"),
    ] {
        if let Some(entry) = index.get(&candidate) {
            return Ok(entry);
        }
    }
    Err(provider_message(format!(
        "SLPK resource is missing: {}",
        path.display()
    )))
}

#[derive(Debug)]
struct TexturePayload {
    bytes: Vec<u8>,
    mime_type: &'static str,
}

fn resolve_base_color_texture<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    index: &ArchiveIndex,
    layer_base: &Path,
    layer: &LayerDocument,
    material_ref: Option<&I3sMaterialRef>,
) -> Result<Option<TexturePayload>, ProviderContractError> {
    let Some(material_ref) = material_ref else {
        return Ok(None);
    };
    let Some(material) = layer.material_definitions.get(material_ref.definition) else {
        return Err(provider_message("I3S material definition is out of range"));
    };
    let Some(texture_set_id) = material
        .pointer("/pbrMetallicRoughness/baseColorTexture/textureSetDefinitionId")
        .and_then(serde_json::Value::as_u64)
    else {
        return Ok(None);
    };
    let resource = material_ref
        .resource
        .ok_or_else(|| provider_message("I3S textured material has no resource id"))?;
    let texture_set = layer
        .texture_set_definitions
        .get(texture_set_id as usize)
        .ok_or_else(|| provider_message("I3S texture set definition is out of range"))?;
    if texture_set.atlas {
        return Err(provider_message(
            "I3S texture atlas requires uvRegion remapping and is refused until that mapping is supported",
        ));
    }
    let format = texture_set
        .formats
        .iter()
        .find(|format| matches!(format.format.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
        .ok_or_else(|| {
            provider_message(
                "I3S texture set has no safe common JPEG/PNG representation (DDS/KTX-only is unsupported)",
            )
        })?;
    let texture_path = layer_base
        .join("nodes")
        .join(resource.to_string())
        .join("textures")
        .join(&format.name);
    let entry = find_resource(index, &texture_path)?;
    let bytes = read_entry(archive, entry, MAX_TEXTURE_BYTES)?;
    let mime_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else {
        return Err(provider_message(
            "I3S JPEG/PNG texture declaration does not match payload magic",
        ));
    };
    let (width, height) = image::ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(provider_error)?
        .into_dimensions()
        .map_err(provider_error)?;
    if width == 0
        || height == 0
        || width > MAX_TEXTURE_DIMENSION
        || height > MAX_TEXTURE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_TEXTURE_PIXELS
    {
        return Err(provider_message(
            "I3S texture dimensions exceed safety limits",
        ));
    }
    Ok(Some(TexturePayload { bytes, mime_type }))
}

fn node_spatial_contract(
    obb: &I3sObb,
) -> Result<(BoundingVolume, WorldTransform), ProviderContractError> {
    if obb
        .center
        .iter()
        .chain(obb.half_size.iter())
        .chain(obb.quaternion.iter())
        .any(|value| !value.is_finite())
        || obb.half_size.iter().any(|value| *value <= 0.0)
    {
        return Err(provider_message("I3S OBB contains invalid values"));
    }
    let [x, y, z, w] = obb.quaternion;
    let norm = (x * x + y * y + z * z + w * w).sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON {
        return Err(provider_message("I3S OBB quaternion is invalid"));
    }
    let (x, y, z, w) = (x / norm, y / norm, z / norm, w / norm);
    let rotation = [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y + z * w),
            2.0 * (x * z - y * w),
        ],
        [
            2.0 * (x * y - z * w),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z + x * w),
        ],
        [
            2.0 * (x * z + y * w),
            2.0 * (y * z - x * w),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ];
    let half_axes = std::array::from_fn(|column| WorldVec3 {
        x: rotation[column][0] * obb.half_size[column],
        y: rotation[column][1] * obb.half_size[column],
        z: rotation[column][2] * obb.half_size[column],
    });
    let center = WorldVec3 {
        x: obb.center[0],
        y: obb.center[1],
        z: obb.center[2],
    };
    let transform = WorldTransform::from_translation(center)
        .ok_or_else(|| provider_message("I3S content transform is invalid"))?;
    Ok((BoundingVolume::OrientedBox { center, half_axes }, transform))
}

struct ParsedGeometry {
    positions: Vec<u8>,
    position_min: [f32; 3],
    position_max: [f32; 3],
    normals: Option<Vec<u8>>,
    tex_coords: Option<Vec<u8>>,
    colors: Option<Vec<u8>>,
    feature_indices: Option<Vec<u8>>,
    source_feature_ids: Vec<u64>,
}

fn convert_geometry_to_glb(
    source: &[u8],
    layout: &GeometryBufferDefinition,
    vertex_count: u64,
    feature_count: u64,
    texture: Option<&TexturePayload>,
    material: Option<&serde_json::Value>,
) -> Result<Vec<u8>, ProviderContractError> {
    let parsed = parse_uncompressed_geometry(source, layout, vertex_count, feature_count)?;
    build_glb(parsed, vertex_count, feature_count, texture, material)
}

fn parse_uncompressed_geometry(
    source: &[u8],
    layout: &GeometryBufferDefinition,
    vertex_count: u64,
    feature_count: u64,
) -> Result<ParsedGeometry, ProviderContractError> {
    let mut cursor = usize::try_from(layout.offset)
        .map_err(|_| provider_message("I3S geometry offset is too large"))?;
    let position = layout
        .position
        .as_ref()
        .ok_or_else(|| provider_message("I3S geometry has no position attribute"))?;
    require_attribute(position, "Float32", 3, None)?;
    let positions = take_attribute(source, &mut cursor, vertex_count, 12)?;
    let (position_min, position_max) = position_bounds(&positions)?;
    let normals = if let Some(normal) = &layout.normal {
        require_attribute(normal, "Float32", 3, None)?;
        Some(take_attribute(source, &mut cursor, vertex_count, 12)?)
    } else {
        None
    };
    let tex_coords = if let Some(uv) = &layout.uv0 {
        require_attribute(uv, "Float32", 2, None)?;
        Some(take_attribute(source, &mut cursor, vertex_count, 8)?)
    } else {
        None
    };
    let colors = if let Some(color) = &layout.color {
        require_attribute(color, "UInt8", 4, None)?;
        Some(take_attribute(source, &mut cursor, vertex_count, 4)?)
    } else {
        None
    };
    let mut source_feature_ids = Vec::new();
    let feature_indices = if feature_count == 0 {
        if layout.feature_id.is_some() || layout.face_range.is_some() {
            return Err(provider_message(
                "I3S geometry declares per-feature attributes with featureCount=0",
            ));
        }
        None
    } else {
        let feature_id = layout.feature_id.as_ref().ok_or_else(|| {
            provider_message("I3S feature geometry lacks required featureId attribute")
        })?;
        let face_range = layout.face_range.as_ref().ok_or_else(|| {
            provider_message("I3S feature geometry lacks required faceRange attribute")
        })?;
        require_attribute(feature_id, &feature_id.r#type, 1, Some("per-feature"))?;
        if !matches!(feature_id.r#type.as_str(), "UInt16" | "UInt32" | "UInt64") {
            return Err(provider_message(
                "I3S featureId integer type is unsupported",
            ));
        }
        require_attribute(face_range, "UInt32", 2, Some("per-feature"))?;
        let id_stride = match feature_id.r#type.as_str() {
            "UInt16" => 2,
            "UInt32" => 4,
            "UInt64" => 8,
            _ => unreachable!(),
        };
        let ids = take_attribute(source, &mut cursor, feature_count, id_stride)?;
        source_feature_ids = ids
            .chunks_exact(id_stride)
            .map(|bytes| match id_stride {
                2 => u64::from(u16::from_le_bytes([bytes[0], bytes[1]])),
                4 => u64::from(u32::from_le_bytes(bytes.try_into().expect("4-byte chunk"))),
                8 => u64::from_le_bytes(bytes.try_into().expect("8-byte chunk")),
                _ => unreachable!(),
            })
            .collect();
        let ranges = take_attribute(source, &mut cursor, feature_count, 8)?;
        let triangle_count = vertex_count / 3;
        let mut values = vec![0_u32; vertex_count as usize];
        let mut expected_first = 0_u64;
        for (feature_index, range) in ranges.chunks_exact(8).enumerate() {
            let first = u64::from(u32::from_le_bytes(range[..4].try_into().expect("range")));
            let last = u64::from(u32::from_le_bytes(range[4..].try_into().expect("range")));
            if first != expected_first || last < first || last >= triangle_count {
                return Err(provider_message(
                    "I3S feature face ranges are not a complete partition",
                ));
            }
            for vertex in first * 3..=(last * 3 + 2) {
                values[vertex as usize] = feature_index as u32;
            }
            expected_first = last + 1;
        }
        if expected_first != triangle_count {
            return Err(provider_message(
                "I3S feature face ranges do not cover every triangle",
            ));
        }
        Some(values.into_iter().flat_map(u32::to_le_bytes).collect())
    };
    if cursor > source.len() {
        return Err(provider_message("I3S geometry buffer is truncated"));
    }
    Ok(ParsedGeometry {
        positions,
        position_min,
        position_max,
        normals,
        tex_coords,
        colors,
        feature_indices,
        source_feature_ids,
    })
}

fn require_attribute(
    attribute: &AttributeDefinition,
    expected_type: &str,
    components: u64,
    binding: Option<&str>,
) -> Result<(), ProviderContractError> {
    if attribute.r#type != expected_type
        || attribute.component != components
        || binding.is_some_and(|expected| {
            attribute.binding.as_deref().unwrap_or("per-feature") != expected
        })
    {
        return Err(provider_message(
            "I3S geometry attribute layout is unsupported",
        ));
    }
    Ok(())
}

fn take_attribute(
    source: &[u8],
    cursor: &mut usize,
    count: u64,
    stride: usize,
) -> Result<Vec<u8>, ProviderContractError> {
    let length = usize::try_from(count)
        .ok()
        .and_then(|count| count.checked_mul(stride))
        .ok_or_else(|| provider_message("I3S geometry attribute size overflow"))?;
    let end = cursor
        .checked_add(length)
        .ok_or_else(|| provider_message("I3S geometry attribute offset overflow"))?;
    let value = source
        .get(*cursor..end)
        .ok_or_else(|| provider_message("I3S geometry buffer is truncated"))?
        .to_vec();
    *cursor = end;
    Ok(value)
}

fn position_bounds(bytes: &[u8]) -> Result<([f32; 3], [f32; 3]), ProviderContractError> {
    let mut minimum = [f32::INFINITY; 3];
    let mut maximum = [f32::NEG_INFINITY; 3];
    for vertex in bytes.chunks_exact(12) {
        for component in 0..3 {
            let offset = component * 4;
            let value = f32::from_le_bytes(
                vertex[offset..offset + 4]
                    .try_into()
                    .expect("four-byte position component"),
            );
            if !value.is_finite() {
                return Err(provider_message("I3S position contains a non-finite value"));
            }
            minimum[component] = minimum[component].min(value);
            maximum[component] = maximum[component].max(value);
        }
    }
    Ok((minimum, maximum))
}

fn build_glb(
    geometry: ParsedGeometry,
    vertex_count: u64,
    feature_count: u64,
    texture: Option<&TexturePayload>,
    material_source: Option<&serde_json::Value>,
) -> Result<Vec<u8>, ProviderContractError> {
    let mut binary = Vec::new();
    let mut views = Vec::new();
    let mut accessors = Vec::new();
    let position_view =
        append_buffer_view(&mut binary, &mut views, &geometry.positions, Some(34962));
    accessors.push(serde_json::json!({
        "bufferView": position_view,
        "componentType": 5126,
        "count": vertex_count,
        "type": "VEC3",
        "min": geometry.position_min,
        "max": geometry.position_max,
    }));
    let mut attributes = serde_json::Map::new();
    attributes.insert("POSITION".to_owned(), serde_json::json!(0));
    if let Some(normals) = &geometry.normals {
        let view = append_buffer_view(&mut binary, &mut views, normals, Some(34962));
        let accessor = accessors.len();
        accessors.push(serde_json::json!({
            "bufferView": view, "componentType": 5126, "count": vertex_count, "type": "VEC3"
        }));
        attributes.insert("NORMAL".to_owned(), serde_json::json!(accessor));
    }
    if let Some(uv) = &geometry.tex_coords {
        let view = append_buffer_view(&mut binary, &mut views, uv, Some(34962));
        let accessor = accessors.len();
        accessors.push(serde_json::json!({
            "bufferView": view, "componentType": 5126, "count": vertex_count, "type": "VEC2"
        }));
        attributes.insert("TEXCOORD_0".to_owned(), serde_json::json!(accessor));
    }
    if let Some(colors) = &geometry.colors {
        let view = append_buffer_view(&mut binary, &mut views, colors, Some(34962));
        let accessor = accessors.len();
        accessors.push(serde_json::json!({
            "bufferView": view, "componentType": 5121, "normalized": true,
            "count": vertex_count, "type": "VEC4"
        }));
        attributes.insert("COLOR_0".to_owned(), serde_json::json!(accessor));
    }
    let feature_extension = if let Some(features) = &geometry.feature_indices {
        let view = append_buffer_view(&mut binary, &mut views, features, Some(34962));
        let accessor = accessors.len();
        accessors.push(serde_json::json!({
            "bufferView": view, "componentType": 5125, "count": vertex_count, "type": "SCALAR"
        }));
        attributes.insert("_FEATURE_ID_0".to_owned(), serde_json::json!(accessor));
        Some(serde_json::json!({
            "EXT_mesh_features": {
                "featureIds": [{"featureCount": feature_count, "label": "i3sFeature", "attribute": 0}]
            }
        }))
    } else {
        None
    };
    let mut material = gltf_material(material_source);
    let mut images = Vec::new();
    let mut textures = Vec::new();
    if let Some(texture) = texture {
        if geometry.tex_coords.is_none() {
            return Err(provider_message(
                "I3S textured material has no uv0 geometry attribute",
            ));
        }
        let view = append_buffer_view(&mut binary, &mut views, &texture.bytes, None);
        images.push(serde_json::json!({"bufferView": view, "mimeType": texture.mime_type}));
        textures.push(serde_json::json!({"source": 0}));
        material
            .as_object_mut()
            .expect("material object")
            .entry("pbrMetallicRoughness")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .expect("PBR object")
            .insert(
                "baseColorTexture".to_owned(),
                serde_json::json!({"index": 0, "texCoord": 0}),
            );
    }
    let mut primitive = serde_json::json!({
        "attributes": attributes,
        "mode": 4,
        "material": 0,
        "extras": {
            "hcadI3sFeatureIds": geometry.source_feature_ids,
        }
    });
    if let Some(extension) = feature_extension {
        primitive
            .as_object_mut()
            .expect("primitive object")
            .insert("extensions".to_owned(), extension);
    }
    let mut document = serde_json::json!({
        "asset": {"version": "2.0", "generator": "HimmelCAD SLPK I3S canonical provider"},
        "buffers": [{"byteLength": binary.len()}],
        "bufferViews": views,
        "accessors": accessors,
        "materials": [material],
        "meshes": [{"primitives": [primitive]}],
        "nodes": [{"mesh": 0}],
        "scenes": [{"nodes": [0]}],
        "scene": 0,
    });
    if !images.is_empty() {
        let object = document.as_object_mut().expect("glTF document");
        object.insert("images".to_owned(), serde_json::Value::Array(images));
        object.insert("textures".to_owned(), serde_json::Value::Array(textures));
        object.insert(
            "samplers".to_owned(),
            serde_json::json!([{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]),
        );
        object
            .get_mut("textures")
            .and_then(serde_json::Value::as_array_mut)
            .expect("textures")
            .first_mut()
            .and_then(serde_json::Value::as_object_mut)
            .expect("texture")
            .insert("sampler".to_owned(), serde_json::json!(0));
    }
    if feature_count > 0 {
        document.as_object_mut().expect("glTF document").insert(
            "extensionsUsed".to_owned(),
            serde_json::json!(["EXT_mesh_features"]),
        );
    }
    encode_glb(&document, &binary)
}

fn append_buffer_view(
    binary: &mut Vec<u8>,
    views: &mut Vec<serde_json::Value>,
    bytes: &[u8],
    target: Option<u64>,
) -> usize {
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let offset = binary.len();
    binary.extend_from_slice(bytes);
    let mut view = serde_json::json!({
        "buffer": 0, "byteOffset": offset, "byteLength": bytes.len()
    });
    if let Some(target) = target {
        view.as_object_mut()
            .expect("buffer view")
            .insert("target".to_owned(), serde_json::json!(target));
    }
    let index = views.len();
    views.push(view);
    index
}

fn gltf_material(source: Option<&serde_json::Value>) -> serde_json::Value {
    let base_color = source
        .and_then(|value| value.pointer("/pbrMetallicRoughness/baseColorFactor"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!([1.0, 1.0, 1.0, 1.0]));
    let metallic = source
        .and_then(|value| value.pointer("/pbrMetallicRoughness/metallicFactor"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!(0.0));
    let roughness = source
        .and_then(|value| value.pointer("/pbrMetallicRoughness/roughnessFactor"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!(1.0));
    let alpha_mode = source
        .and_then(|value| value.get("alphaMode"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("opaque")
        .to_ascii_uppercase();
    serde_json::json!({
        "pbrMetallicRoughness": {
            "baseColorFactor": base_color,
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        },
        "alphaMode": alpha_mode,
        "alphaCutoff": source.and_then(|value| value.get("alphaCutoff")).and_then(serde_json::Value::as_f64).unwrap_or(0.25),
        "doubleSided": source.and_then(|value| value.get("doubleSided")).and_then(serde_json::Value::as_bool).unwrap_or(false),
    })
}

fn encode_glb(
    document: &serde_json::Value,
    binary: &[u8],
) -> Result<Vec<u8>, ProviderContractError> {
    let mut json = serde_json::to_vec(document).map_err(provider_error)?;
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let mut binary = binary.to_vec();
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let total = 12_usize
        .checked_add(8 + json.len())
        .and_then(|value| value.checked_add(8 + binary.len()))
        .ok_or_else(|| provider_message("GLB byte length overflow"))?;
    let total = u32::try_from(total).map_err(|_| provider_message("GLB exceeds 4 GiB"))?;
    let mut glb = Vec::with_capacity(total as usize);
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2_u32.to_le_bytes());
    glb.extend_from_slice(&total.to_le_bytes());
    glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
    glb.extend_from_slice(&0x4e4f534a_u32.to_le_bytes());
    glb.extend_from_slice(&json);
    glb.extend_from_slice(&(binary.len() as u32).to_le_bytes());
    glb.extend_from_slice(&0x004e4942_u32.to_le_bytes());
    glb.extend_from_slice(&binary);
    Ok(glb)
}

fn write_artifact(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    media_type: &str,
) -> Result<PreparedDatasetArtifact, ProviderContractError> {
    validate_relative_path(relative)?;
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(provider_error)?;
    }
    let expected = ObjectHash::of_bytes(bytes);
    let reusable = fs::read(&path)
        .ok()
        .is_some_and(|existing| ObjectHash::of_bytes(&existing) == expected);
    if !reusable {
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let mut file = File::create(&temporary).map_err(provider_error)?;
        file.write_all(bytes).map_err(provider_error)?;
        file.sync_all().map_err(provider_error)?;
        fs::rename(&temporary, &path).map_err(provider_error)?;
    }
    Ok(PreparedDatasetArtifact {
        relative_path: relative.to_path_buf(),
        resource: GeometryResource {
            object_hash: expected,
            media_type: media_type.to_owned(),
            byte_length: Some(bytes.len() as u64),
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlpkProvenance {
    source_sha256: String,
    source_byte_length: u64,
    layer_id: u64,
    layer_type: String,
    layer_revision: String,
    i3s_version: String,
    spatial_reference: Option<SpatialReference>,
    archive_entries: usize,
    archive_uncompressed_bytes: u64,
    node_count: usize,
    converted_tile_count: u64,
    conversion: String,
}

fn build_package(
    source_path: &Path,
    dataset_id: &str,
    manifest: &GeometryResource,
    artifacts: Vec<PreparedDatasetArtifact>,
    provenance: SlpkProvenance,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({
            "hcad.prepared-dataset@1": {"formatId": PREPARED_FORMAT_ID},
            "hcad.slpk-i3s@1": {"providerId": SLPK_PROVIDER_ID},
        }),
    )?;
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::to_value(provenance).map_err(provider_error)?,
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!([]),
    )?;
    let geometry = GeometryObject::Surface3d {
        mesh: Box::new(TriangleMeshGeometry {
            storage: TriangleMeshStorage::Resource {
                resource: manifest.clone(),
            },
            closed_manifold: false,
            triangle_material_slots: None,
            materials: None,
        }),
    };
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry).map_err(provider_error)?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let entity_id = format!("surface-{dataset_id}");
    let mut entity = CanonicalEntity {
        id: EntityId(entity_id.clone()),
        revision: 0,
        type_id: EntityTypeId(built_in_type::SURFACE_3D.to_owned()),
        name: source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("I3S Scene Layer")
            .to_owned(),
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref: components.object_hash.clone(),
        attributes_ref: attributes.object_hash.clone(),
        relations_ref: relations.object_hash.clone(),
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"uninitialized SLPK entity"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity).map_err(provider_error)?;
    validate_resolved_representation(&entity, &selected, &geometry).map_err(provider_error)?;
    Ok(CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: SLPK_PROVIDER_ID.to_owned(),
        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
        admissions: vec![CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot: "source".to_owned(),
            expected_generation: None,
            resolved_geometry: geometry,
        }],
        objects: vec![components, attributes, relations],
        datasets: vec![CanonicalPreparedDataset {
            dataset_id: dataset_id.to_owned(),
            format_id: PREPARED_FORMAT_ID.to_owned(),
            entity_id,
            representation_slot: "source".to_owned(),
            root_metadata: manifest.clone(),
            artifacts,
        }],
        resource_sets: Vec::new(),
        presentation_resources: Default::default(),
    })
}

fn hash_file(
    path: &Path,
    length: u64,
    context: &mut dyn ProviderOperationContext,
) -> Result<String, ProviderContractError> {
    let mut reader = BufReader::new(File::open(path).map_err(provider_error)?);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut digest = Sha256::new();
    let mut completed = 0_u64;
    loop {
        check_cancelled(context)?;
        let count = reader.read(&mut buffer).map_err(provider_error)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        completed += count as u64;
        context.report_progress(ProviderProgress {
            phase: "scan".to_owned(),
            completed,
            total: Some(length),
            message: "SLPK source hash is computed incrementally".to_owned(),
        });
    }
    if completed != length {
        return Err(provider_message("SLPK source changed while hashing"));
    }
    Ok(hex::encode(digest.finalize()))
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

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    use flate2::write::GzEncoder;
    use flate2::Compression;
    use himmelcad_render::{
        decode_glb_intrinsic, DatasetId, HierarchySource, PreparedHierarchySource,
    };
    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;
    use crate::viewer_contract_test_support::assert_provider_package_reaches_viewer;

    #[derive(Default)]
    struct TestContext {
        cancelled: bool,
        cancel_after_convert: Option<u64>,
        progress: Vec<ProviderProgress>,
    }

    impl ProviderOperationContext for TestContext {
        fn is_cancelled(&self) -> bool {
            self.cancelled
        }

        fn report_progress(&mut self, progress: ProviderProgress) {
            if progress.phase == "convert"
                && self
                    .cancel_after_convert
                    .is_some_and(|threshold| progress.completed >= threshold)
            {
                self.cancelled = true;
            }
            self.progress.push(progress);
        }
    }

    #[test]
    fn bounded_probe_requires_zip_and_slpk_identity() {
        let provider = SlpkCanonicalProvider::default();
        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("mesh.slpk"),
                prefix: b"PK\x03\x04rest",
                media_type: None,
            })
            .expect("probe")
            .is_some());
        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("mesh.zip"),
                prefix: b"PK\x03\x04rest",
                media_type: None,
            })
            .expect("probe")
            .is_none());
    }

    #[test]
    fn textured_feature_fixture_reaches_prepared_hierarchy_and_common_glb_decoder() {
        let root = temp_root("viewer");
        let source = root.join("textured.slpk");
        write_fixture(&source, false);
        let provider = SlpkCanonicalProvider::new(root.join("prepared"));
        let mut context = TestContext::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut context,
            )
            .expect("canonical SLPK import");
        assert_provider_package_reaches_viewer(&package);
        assert!(context
            .progress
            .iter()
            .any(|value| value.phase == "convert"));
        let roots = provider
            .staged_artifact_roots(&package)
            .expect("artifact roots");
        let dataset = &package.datasets[0];
        let dataset_root = &roots.dataset_roots[&dataset.dataset_id];
        let manifest_bytes = fs::read(dataset_root.join("manifest.json")).expect("manifest");
        let mut hierarchy = PreparedHierarchySource::from_json(
            DatasetId(dataset.dataset_id.clone()),
            "hcad://fixture/manifest.json",
            &manifest_bytes,
        )
        .expect("shared prepared hierarchy parser");
        let child = hierarchy
            .tile(&TileId("1".to_owned()))
            .expect("hierarchy lookup")
            .expect("child tile");
        assert_eq!(child.contents[0].kind, ContentKind::Gltf);
        let glb = fs::read(dataset_root.join("tiles/1.glb")).expect("prepared GLB");
        let decoded = decode_glb_intrinsic(&glb, child.content_transform)
            .expect("common GLB renderer decoder");
        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices.len(), 3);
        assert_eq!(decoded.primitives[0].features.len(), 1);
        assert_eq!(
            decoded.primitives[0].features[0].feature_id_at_triangle(0, [0.2, 0.3, 0.5]),
            Some(himmelcad_render::DecodedTriangleFeatureId::Feature(0))
        );
        assert_eq!(decoded.images.len(), 1);

        // A second run at the same content-addressed root reuses exact GLBs and
        // demonstrates restart/resume safety without mutable public state.
        let first_modified = fs::metadata(dataset_root.join("tiles/1.glb"))
            .expect("GLB metadata")
            .modified()
            .expect("modified");
        let mut second_context = TestContext::default();
        provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut second_context,
            )
            .expect("resumed canonical SLPK import");
        assert_eq!(
            fs::metadata(dataset_root.join("tiles/1.glb"))
                .expect("GLB metadata")
                .modified()
                .expect("modified"),
            first_modified
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn traversal_and_cancellation_fail_without_package() {
        let root = temp_root("unsafe");
        let source = root.join("unsafe.slpk");
        write_fixture(&source, true);
        let provider = SlpkCanonicalProvider::new(root.join("prepared"));
        let mut context = TestContext::default();
        assert!(provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut context,
            )
            .is_err());
        let safe = root.join("safe.slpk");
        write_fixture(&safe, false);
        let mut cancelled = TestContext {
            cancelled: true,
            cancel_after_convert: None,
            progress: Vec::new(),
        };
        assert!(matches!(
            provider.import(
                CanonicalImportRequest {
                    source: &safe,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut cancelled,
            ),
            Err(ProviderContractError::Cancelled)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn deflate_and_inner_gzip_resources_import_under_independent_limits() {
        let root = temp_root("compressed");
        let source = root.join("compressed.slpk");
        write_fixture_options(&source, false, CompressionMethod::Deflated, true, false);
        let provider = SlpkCanonicalProvider::new(root.join("prepared"));
        let mut context = TestContext::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut context,
            )
            .expect("DEFLATE/gzip SLPK import");
        package.validate().expect("canonical package");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn zip64_directory_and_entry_metadata_are_accepted_without_extraction() {
        let root = temp_root("zip64");
        let source = root.join("zip64.slpk");
        write_fixture_options(&source, false, CompressionMethod::Stored, false, true);
        let provider = SlpkCanonicalProvider::new(root.join("prepared"));
        let mut context = TestContext::default();
        provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut context,
            )
            .expect("Zip64 SLPK import");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn decompression_bomb_and_truncated_directory_are_rejected() {
        let root = temp_root("archive-limits");
        let bomb = root.join("bomb.slpk");
        {
            let file = File::create(&bomb).expect("bomb fixture");
            let mut zip = ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file("SceneServer/layers/0", options)
                .expect("bomb entry");
            zip.write_all(&vec![0_u8; 2 * 1024 * 1024])
                .expect("bomb bytes");
            zip.finish().expect("bomb finish");
        }
        let provider = SlpkCanonicalProvider::new(root.join("prepared"));
        let mut context = TestContext::default();
        assert!(provider
            .import(
                CanonicalImportRequest {
                    source: &bomb,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut context,
            )
            .is_err());

        let truncated = root.join("truncated.slpk");
        write_fixture(&truncated, false);
        let length = fs::metadata(&truncated).expect("fixture metadata").len();
        File::options()
            .write(true)
            .open(&truncated)
            .expect("fixture")
            .set_len(length - 10)
            .expect("truncate central directory");
        let mut context = TestContext::default();
        assert!(provider
            .import(
                CanonicalImportRequest {
                    source: &truncated,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut context,
            )
            .is_err());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cancelled_conversion_resumes_from_content_addressed_tiles() {
        let root = temp_root("resume");
        let source = root.join("resume.slpk");
        write_fixture(&source, false);
        let provider = SlpkCanonicalProvider::new(root.join("prepared"));
        let mut interrupted = TestContext {
            cancelled: false,
            cancel_after_convert: Some(2),
            progress: Vec::new(),
        };
        assert!(matches!(
            provider.import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut interrupted,
            ),
            Err(ProviderContractError::Cancelled)
        ));
        let hash = hex::encode(Sha256::digest(fs::read(&source).expect("fixture bytes")));
        let tile = root.join("prepared/slpk").join(hash).join("tiles/1.glb");
        let modified = fs::metadata(&tile)
            .expect("private completed tile")
            .modified()
            .expect("modified");
        let mut resumed = TestContext::default();
        provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: SLPK_FORMAT_ID,
                    options: &serde_json::json!({"layerId": null}),
                },
                &mut resumed,
            )
            .expect("resumed import");
        assert_eq!(
            fs::metadata(tile)
                .expect("resumed tile")
                .modified()
                .expect("modified"),
            modified
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn write_fixture(path: &Path, unsafe_entry: bool) {
        write_fixture_options(path, unsafe_entry, CompressionMethod::Stored, false, false);
    }

    fn write_fixture_options(
        path: &Path,
        unsafe_entry: bool,
        compression: CompressionMethod,
        inner_gzip: bool,
        force_zip64: bool,
    ) {
        let layer = serde_json::json!({
            "id": 0,
            "layerType": "IntegratedMesh",
            "version": "1.9",
            "spatialReference": {"wkid": 25832},
            "capabilities": ["View"],
            "store": {"profile": "meshpyramid", "version": "1.9"},
            "nodePages": {
                "nodesPerPage": 64,
                "rootIndex": 0,
                "lodSelectionMetricType": "maxScreenThresholdSQ"
            },
            "geometryDefinitions": [{
                "topology": "triangle",
                "geometryBuffers": [{
                    "position": {"type": "Float32", "component": 3},
                    "uv0": {"type": "Float32", "component": 2},
                    "featureId": {"type": "UInt64", "component": 1, "binding": "per-feature"},
                    "faceRange": {"type": "UInt32", "component": 2, "binding": "per-feature"}
                }]
            }],
            "materialDefinitions": [{
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "baseColorTexture": {"textureSetDefinitionId": 0}
                },
                "doubleSided": true
            }],
            "textureSetDefinitions": [{
                "formats": [{"name": "0", "format": "png"}],
                "atlas": false
            }]
        });
        let nodes = serde_json::json!({
            "nodes": [{
                "index": 0,
                "lodThreshold": 100.0,
                "obb": {"center": [500000.0, 5400000.0, 10.0], "halfSize": [10.0, 10.0, 10.0], "quaternion": [0.0, 0.0, 0.0, 1.0]},
                "children": [1]
            }, {
                "index": 1,
                "parentIndex": 0,
                "lodThreshold": 10.0,
                "obb": {"center": [500000.0, 5400000.0, 10.0], "halfSize": [1.0, 1.0, 1.0], "quaternion": [0.0, 0.0, 0.0, 1.0]},
                "mesh": {
                    "material": {"definition": 0, "resource": 7},
                    "geometry": {"definition": 0, "resource": 7, "vertexCount": 3, "featureCount": 1}
                }
            }]
        });
        let mut geometry = Vec::new();
        for value in [0.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0] {
            geometry.extend_from_slice(&value.to_le_bytes());
        }
        for value in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0] {
            geometry.extend_from_slice(&value.to_le_bytes());
        }
        geometry.extend_from_slice(&42_u64.to_le_bytes());
        geometry.extend_from_slice(&0_u32.to_le_bytes());
        geometry.extend_from_slice(&0_u32.to_le_bytes());
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(ImageBuffer::from_pixel(1, 1, Rgba([255, 0, 0, 255])))
            .write_to(&mut png, ImageFormat::Png)
            .expect("PNG fixture");
        let json_resource = |bytes: Vec<u8>| {
            if inner_gzip {
                let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(&bytes).expect("gzip JSON");
                encoder.finish().expect("gzip finish")
            } else {
                bytes
            }
        };
        let file = File::create(path).expect("SLPK fixture");
        let mut zip = ZipWriter::new(file);
        if force_zip64 {
            zip.set_raw_zip64_extensible_data_sector(Box::default());
        }
        let options = SimpleFileOptions::default()
            .compression_method(compression)
            .large_file(force_zip64);
        let mut entries = vec![
            (
                "SceneServer/layers/0",
                json_resource(serde_json::to_vec(&layer).expect("layer")),
            ),
            (
                "SceneServer/layers/0/nodepages/0",
                json_resource(serde_json::to_vec(&nodes).expect("nodes")),
            ),
            ("SceneServer/layers/0/nodes/7/geometries/0", geometry),
            ("SceneServer/layers/0/nodes/7/textures/0", png.into_inner()),
        ];
        if unsafe_entry {
            entries.push(("../escape", b"unsafe".to_vec()));
        }
        for (name, bytes) in entries {
            zip.start_file(name, options).expect("entry");
            zip.write_all(&bytes).expect("entry bytes");
        }
        zip.finish().expect("SLPK finish");
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "himmelcad-slpk-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temp root");
        root
    }
}
