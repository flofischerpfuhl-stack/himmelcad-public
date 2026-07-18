//! Bounded dependency inspection and immutable byte bundles for external glTF assets.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::legacy_tiles_layout::{
    embedded_glb, parse_i3dm_uri, trim_json_space_padding as trim_layout_json_padding,
    validate_common_tile, validate_table_tile, LegacyLayoutError,
};

const GLB_HEADER_BYTES: usize = 12;
const GLB_CHUNK_HEADER_BYTES: usize = 8;
const B3DM_HEADER_BYTES: usize = 28;
const I3DM_HEADER_BYTES: usize = 32;
const CMPT_HEADER_BYTES: usize = 16;
const GLB_JSON_CHUNK: u32 = 0x4e4f_534a;

/// Hard bounds shared by dependency inspection and immutable bundle assembly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetBundleLimits {
    /// Maximum number of owner/source entries in one bundle.
    pub max_entries: usize,
    /// Maximum number of distinct resolved resources in one bundle.
    pub max_unique_assets: usize,
    /// Maximum encoded byte length of one resolved resource.
    pub max_asset_bytes: usize,
    /// Maximum encoded byte length of the complete deduplicated blob.
    pub max_blob_bytes: usize,
    /// Maximum UTF-8 byte length of each owner, source or resolved URI.
    pub max_uri_bytes: usize,
    /// Maximum direct document or tile-content byte length accepted for inspection.
    pub max_document_bytes: usize,
    /// Maximum number of external fetch dependencies emitted by one inspection.
    pub max_dependencies: usize,
    /// Maximum nested `cmpt` depth accepted during inspection.
    pub max_composite_depth: usize,
}

impl Default for AssetBundleLimits {
    fn default() -> Self {
        Self {
            max_entries: 16_384,
            max_unique_assets: 8_192,
            max_asset_bytes: 512 * 1024 * 1024,
            max_blob_bytes: 2 * 1024 * 1024 * 1024,
            max_uri_bytes: 16 * 1024,
            max_document_bytes: 1024 * 1024 * 1024,
            max_dependencies: 16_384,
            max_composite_depth: 8,
        }
    }
}

/// Semantic role of one externally resolved glTF asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolvedAssetKind {
    /// A glTF JSON or GLB model document.
    GltfDocument,
    /// Binary buffer data referenced by a glTF document.
    Buffer,
    /// Encoded image data referenced by a glTF document.
    Image,
    /// External schema referenced by `EXT_structural_metadata.schemaUri`.
    Schema,
}

/// Borrowed input used to construct an immutable [`ResolvedAssetBundle`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedAssetInput<'a> {
    /// URI of the document containing the reference.
    pub owner_uri: &'a str,
    /// Exact URI string stored in the owning document.
    pub source_uri: &'a str,
    /// Canonical URI used by the fetch/cache layer.
    pub resolved_uri: &'a str,
    /// Semantic role of the referenced bytes.
    pub kind: ResolvedAssetKind,
    /// Complete encoded resource bytes.
    pub bytes: &'a [u8],
}

/// One owner/source alias into a bundle's contiguous byte blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAssetEntry {
    /// URI of the document containing the reference.
    pub owner_uri: String,
    /// Exact URI string stored in the owning document.
    pub source_uri: String,
    /// Canonical URI used by the fetch/cache layer.
    pub resolved_uri: String,
    /// Semantic role of the referenced bytes.
    pub kind: ResolvedAssetKind,
    /// Start of this resource in the host-packed bundle payload.
    pub byte_offset: usize,
    /// Encoded byte length of this resource.
    pub byte_length: usize,
}

/// Immutable, range-checked external asset set with one contiguous byte allocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAssetBundle {
    entries: Vec<ResolvedAssetEntry>,
    resources: BTreeMap<String, Arc<[u8]>>,
    lookup: BTreeMap<(String, String), usize>,
    unique_compressed_bytes: usize,
}

impl ResolvedAssetBundle {
    /// Validates aliases and compacts unique resolved resources into one byte blob.
    pub fn build(
        inputs: &[ResolvedAssetInput<'_>],
        limits: AssetBundleLimits,
    ) -> Result<Self, AssetResolverError> {
        validate_limits(limits)?;
        if inputs.len() > limits.max_entries {
            return Err(AssetResolverError::LimitExceeded("bundle entry count"));
        }

        let mut entries = Vec::with_capacity(inputs.len());
        let mut blob = Vec::new();
        let mut lookup = BTreeMap::new();
        let mut resolved_ranges: BTreeMap<&str, (usize, usize, &[u8])> = BTreeMap::new();

        for input in inputs {
            validate_uri("owner URI", input.owner_uri, limits.max_uri_bytes)?;
            validate_uri("source URI", input.source_uri, limits.max_uri_bytes)?;
            validate_uri("resolved URI", input.resolved_uri, limits.max_uri_bytes)?;
            if input.bytes.len() > limits.max_asset_bytes {
                return Err(AssetResolverError::LimitExceeded(
                    "single asset byte length",
                ));
            }

            let key = (input.owner_uri.to_owned(), input.source_uri.to_owned());
            if lookup.contains_key(&key) {
                return Err(AssetResolverError::DuplicateLookup {
                    owner_uri: key.0,
                    source_uri: key.1,
                });
            }

            let (byte_offset, byte_length) = if let Some(&(offset, length, existing)) =
                resolved_ranges.get(input.resolved_uri)
            {
                if existing != input.bytes {
                    return Err(AssetResolverError::ConflictingResolvedAsset(
                        input.resolved_uri.to_owned(),
                    ));
                }
                (offset, length)
            } else {
                if resolved_ranges.len() >= limits.max_unique_assets {
                    return Err(AssetResolverError::LimitExceeded("unique asset count"));
                }
                let offset = blob.len();
                let end = offset
                    .checked_add(input.bytes.len())
                    .filter(|end| *end <= limits.max_blob_bytes)
                    .ok_or(AssetResolverError::LimitExceeded("bundle blob byte length"))?;
                blob.extend_from_slice(input.bytes);
                debug_assert_eq!(blob.len(), end);
                resolved_ranges
                    .insert(input.resolved_uri, (offset, input.bytes.len(), input.bytes));
                (offset, input.bytes.len())
            };

            let entry_index = entries.len();
            entries.push(ResolvedAssetEntry {
                owner_uri: input.owner_uri.to_owned(),
                source_uri: input.source_uri.to_owned(),
                resolved_uri: input.resolved_uri.to_owned(),
                kind: input.kind,
                byte_offset,
                byte_length,
            });
            lookup.insert(key, entry_index);
        }

        let unique_compressed_bytes = blob.len();
        let resources = resolved_ranges
            .into_iter()
            .map(|(uri, (_, _, bytes))| (uri.to_owned(), Arc::from(bytes)))
            .collect();
        Ok(Self {
            entries,
            resources,
            lookup,
            unique_compressed_bytes,
        })
    }

    /// Validates a host-packed manifest and adopts its blob without copying bytes.
    ///
    /// Every distinct resolved URI must own one non-overlapping range, aliases of
    /// that URI must repeat the exact range, and the ranges must cover the blob.
    pub fn from_packed(
        entries: Vec<ResolvedAssetEntry>,
        blob: Vec<u8>,
        limits: AssetBundleLimits,
    ) -> Result<Self, AssetResolverError> {
        let blob: Arc<[u8]> = Arc::from(blob);
        validate_limits(limits)?;
        if entries.len() > limits.max_entries {
            return Err(AssetResolverError::LimitExceeded("bundle entry count"));
        }
        if blob.len() > limits.max_blob_bytes {
            return Err(AssetResolverError::LimitExceeded("bundle blob byte length"));
        }

        let mut lookup = BTreeMap::new();
        let mut resolved_ranges: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        for (entry_index, entry) in entries.iter().enumerate() {
            validate_uri("owner URI", &entry.owner_uri, limits.max_uri_bytes)?;
            validate_uri("source URI", &entry.source_uri, limits.max_uri_bytes)?;
            validate_uri("resolved URI", &entry.resolved_uri, limits.max_uri_bytes)?;
            if entry.byte_length > limits.max_asset_bytes {
                return Err(AssetResolverError::LimitExceeded(
                    "single asset byte length",
                ));
            }
            checked_slice(&blob, entry.byte_offset, entry.byte_length)
                .ok_or(AssetResolverError::InvalidRange("packed bundle entry"))?;

            let key = (entry.owner_uri.clone(), entry.source_uri.clone());
            if lookup.insert(key.clone(), entry_index).is_some() {
                return Err(AssetResolverError::DuplicateLookup {
                    owner_uri: key.0,
                    source_uri: key.1,
                });
            }
            match resolved_ranges.get(entry.resolved_uri.as_str()) {
                Some(range) if *range != (entry.byte_offset, entry.byte_length) => {
                    return Err(AssetResolverError::ConflictingResolvedRange(
                        entry.resolved_uri.clone(),
                    ));
                }
                Some(_) => {}
                None => {
                    if resolved_ranges.len() >= limits.max_unique_assets {
                        return Err(AssetResolverError::LimitExceeded("unique asset count"));
                    }
                    resolved_ranges.insert(
                        entry.resolved_uri.as_str(),
                        (entry.byte_offset, entry.byte_length),
                    );
                }
            }
        }

        let mut ordered_ranges = resolved_ranges
            .values()
            .copied()
            .collect::<Vec<(usize, usize)>>();
        ordered_ranges.sort_unstable();
        let mut covered_end = 0_usize;
        let mut unique_compressed_bytes = 0_usize;
        for (offset, length) in ordered_ranges {
            if offset > covered_end {
                return Err(AssetResolverError::UnreferencedBlobBytes);
            }
            if offset < covered_end && length != 0 {
                return Err(AssetResolverError::OverlappingResolvedRanges);
            }
            let end = offset
                .checked_add(length)
                .ok_or(AssetResolverError::InvalidRange("packed resolved range"))?;
            covered_end = covered_end.max(end);
            unique_compressed_bytes = unique_compressed_bytes.checked_add(length).ok_or(
                AssetResolverError::LimitExceeded("unique compressed byte accounting"),
            )?;
        }
        if covered_end != blob.len() {
            return Err(AssetResolverError::UnreferencedBlobBytes);
        }

        let resources = resolved_ranges
            .iter()
            .map(|(uri, (offset, length))| {
                let bytes = checked_slice(&blob, *offset, *length)
                    .expect("validated packed range remains addressable");
                ((*uri).to_owned(), Arc::from(bytes))
            })
            .collect();
        Ok(Self {
            entries,
            resources,
            lookup,
            unique_compressed_bytes,
        })
    }

    /// Owner/source aliases in deterministic input order.
    pub fn entries(&self) -> &[ResolvedAssetEntry] {
        &self.entries
    }

    /// Number of encoded bytes charged once per distinct resolved URI.
    pub fn unique_compressed_bytes(&self) -> usize {
        self.unique_compressed_bytes
    }

    /// Finds an alias by the exact owning URI and exact source URI pair.
    pub fn lookup(&self, owner_uri: &str, source_uri: &str) -> Option<&ResolvedAssetEntry> {
        let index = self
            .lookup
            .get(&(owner_uri.to_owned(), source_uri.to_owned()))?;
        self.entries.get(*index)
    }

    /// Returns the checked encoded byte range represented by an entry.
    pub fn bytes(&self, entry: &ResolvedAssetEntry) -> Result<&[u8], AssetResolverError> {
        self.resources
            .get(&entry.resolved_uri)
            .map(AsRef::as_ref)
            .ok_or(AssetResolverError::InvalidRange("bundle entry"))
    }

    pub(crate) fn shared_resources(&self) -> impl Iterator<Item = (&str, Arc<[u8]>)> + '_ {
        self.resources
            .iter()
            .map(|(uri, bytes)| (uri.as_str(), Arc::clone(bytes)))
    }

    pub(crate) fn replace_shared_resource(&mut self, resolved_uri: &str, bytes: Arc<[u8]>) {
        let previous = self.resources.insert(resolved_uri.to_owned(), bytes);
        debug_assert!(previous.is_some());
    }
}

/// One external fetch discovered in a glTF or legacy 3D Tiles payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GltfDependency {
    /// URI of the document or tile content containing the reference.
    pub owner_uri: String,
    /// Exact non-data URI stored in that document.
    pub source_uri: String,
    /// Semantic role of the fetched resource.
    pub kind: ResolvedAssetKind,
}

/// Deterministically ordered set of external glTF fetches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GltfDependencyInspection {
    dependencies: Vec<GltfDependency>,
}

impl GltfDependencyInspection {
    /// External dependencies in source traversal order, with exact duplicates removed.
    pub fn dependencies(&self) -> &[GltfDependency] {
        &self.dependencies
    }

    /// Finds a discovered dependency by exact owner/source URI.
    pub fn lookup(&self, owner_uri: &str, source_uri: &str) -> Option<&GltfDependency> {
        self.dependencies.iter().find(|dependency| {
            dependency.owner_uri == owner_uri && dependency.source_uri == source_uri
        })
    }
}

/// Invalid content, conflicting aliases or an explicitly exceeded resource bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetResolverError {
    /// A configured hard bound is zero or internally inconsistent.
    InvalidLimits(&'static str),
    /// A document, dependency list or byte allocation exceeded a hard bound.
    LimitExceeded(&'static str),
    /// A URI is empty, too long, invalid UTF-8 or contains forbidden control bytes.
    InvalidUri(&'static str),
    /// One owner/source lookup key was supplied more than once.
    DuplicateLookup {
        /// URI of the owning document.
        owner_uri: String,
        /// Exact source reference duplicated in that document.
        source_uri: String,
    },
    /// One resolved URI was associated with different encoded bytes.
    ConflictingResolvedAsset(String),
    /// Aliases of one resolved URI declared different packed byte ranges.
    ConflictingResolvedRange(String),
    /// The packed blob contains bytes not owned by any distinct resolved URI.
    UnreferencedBlobBytes,
    /// Distinct resolved URIs own overlapping non-empty packed byte ranges.
    OverlappingResolvedRanges,
    /// Checked offset and length arithmetic did not fit within its container.
    InvalidRange(&'static str),
    /// JSON glTF or a JSON-bearing container section could not be parsed.
    InvalidJson(String),
    /// Content magic, version, chunk layout or declared byte length is invalid.
    InvalidContainer(&'static str),
    /// A content type is validly framed but outside this dependency inspector's scope.
    UnsupportedContent([u8; 4]),
    /// The same owner/source dependency was declared with incompatible semantic kinds.
    ConflictingDependencyKind {
        /// URI of the owning document.
        owner_uri: String,
        /// Exact conflicting source reference.
        source_uri: String,
    },
}

impl Display for AssetResolverError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidLimits(message) => write!(formatter, "invalid asset limits: {message}"),
            Self::LimitExceeded(message) => write!(formatter, "asset limit exceeded: {message}"),
            Self::InvalidUri(message) => write!(formatter, "invalid asset URI: {message}"),
            Self::DuplicateLookup {
                owner_uri,
                source_uri,
            } => write!(
                formatter,
                "duplicate asset lookup: {owner_uri} -> {source_uri}"
            ),
            Self::ConflictingResolvedAsset(uri) => {
                write!(formatter, "conflicting bytes for resolved asset: {uri}")
            }
            Self::ConflictingResolvedRange(uri) => {
                write!(
                    formatter,
                    "conflicting packed ranges for resolved asset: {uri}"
                )
            }
            Self::UnreferencedBlobBytes => {
                formatter.write_str("packed asset blob contains unreferenced bytes")
            }
            Self::OverlappingResolvedRanges => {
                formatter.write_str("packed resolved asset ranges overlap")
            }
            Self::InvalidRange(message) => write!(formatter, "invalid asset range: {message}"),
            Self::InvalidJson(message) => write!(formatter, "invalid glTF JSON: {message}"),
            Self::InvalidContainer(message) => {
                write!(formatter, "invalid glTF or 3D Tiles container: {message}")
            }
            Self::UnsupportedContent(magic) => write!(
                formatter,
                "unsupported dependency content: {}",
                String::from_utf8_lossy(magic)
            ),
            Self::ConflictingDependencyKind {
                owner_uri,
                source_uri,
            } => write!(
                formatter,
                "conflicting dependency kind: {owner_uri} -> {source_uri}"
            ),
        }
    }
}

impl Error for AssetResolverError {}

/// Inspects direct glTF JSON, GLB, `b3dm`, `i3dm` and recursively nested `cmpt` bytes.
///
/// Returned dependencies require a fetch. Embedded `data:` URIs are deliberately
/// omitted because their bytes belong to the owning glTF document.
pub fn inspect_gltf_dependencies(
    owner_uri: &str,
    bytes: &[u8],
    limits: AssetBundleLimits,
) -> Result<GltfDependencyInspection, AssetResolverError> {
    validate_limits(limits)?;
    validate_uri("owner URI", owner_uri, limits.max_uri_bytes)?;
    if bytes.len() > limits.max_document_bytes {
        return Err(AssetResolverError::LimitExceeded(
            "inspected document byte length",
        ));
    }
    let mut inspector = DependencyInspector {
        owner_uri,
        limits,
        dependencies: Vec::new(),
        lookup: BTreeMap::new(),
    };
    inspector.inspect_content(bytes, 0)?;
    Ok(GltfDependencyInspection {
        dependencies: inspector.dependencies,
    })
}

struct DependencyInspector<'a> {
    owner_uri: &'a str,
    limits: AssetBundleLimits,
    dependencies: Vec<GltfDependency>,
    lookup: BTreeMap<(String, String), ResolvedAssetKind>,
}

impl DependencyInspector<'_> {
    fn inspect_content(&mut self, bytes: &[u8], depth: usize) -> Result<(), AssetResolverError> {
        let json_candidate = bytes.trim_ascii_start();
        if json_candidate
            .first()
            .is_some_and(|byte| matches!(byte, b'{' | b'['))
        {
            return self.inspect_json(json_candidate);
        }
        let magic: [u8; 4] = bytes
            .get(..4)
            .and_then(|value| value.try_into().ok())
            .ok_or(AssetResolverError::InvalidContainer(
                "missing content magic",
            ))?;
        match &magic {
            b"glTF" => self.inspect_glb(bytes),
            b"b3dm" => self.inspect_b3dm(bytes),
            b"i3dm" => self.inspect_i3dm(bytes),
            b"cmpt" => self.inspect_cmpt(bytes, depth),
            _ => Err(AssetResolverError::UnsupportedContent(magic)),
        }
    }

    fn inspect_json(&mut self, bytes: &[u8]) -> Result<(), AssetResolverError> {
        let document: Value = serde_json::from_slice(bytes)
            .map_err(|error| AssetResolverError::InvalidJson(error.to_string()))?;
        let object = document.as_object().ok_or(AssetResolverError::InvalidJson(
            "root must be an object".to_owned(),
        ))?;
        self.inspect_uri_array(object.get("buffers"), ResolvedAssetKind::Buffer)?;
        self.inspect_uri_array(object.get("images"), ResolvedAssetKind::Image)?;
        self.inspect_schema_uri(object.get("extensions"))
    }

    fn inspect_schema_uri(&mut self, extensions: Option<&Value>) -> Result<(), AssetResolverError> {
        let Some(extensions) = extensions else {
            return Ok(());
        };
        let extensions = extensions.as_object().ok_or_else(|| {
            AssetResolverError::InvalidJson("extensions must be an object".to_owned())
        })?;
        let Some(extension) = extensions.get("EXT_structural_metadata") else {
            return Ok(());
        };
        let extension = extension.as_object().ok_or_else(|| {
            AssetResolverError::InvalidJson("EXT_structural_metadata must be an object".to_owned())
        })?;
        let Some(schema_uri) = extension.get("schemaUri") else {
            return Ok(());
        };
        let schema_uri = schema_uri.as_str().ok_or_else(|| {
            AssetResolverError::InvalidJson(
                "EXT_structural_metadata.schemaUri must be a string".to_owned(),
            )
        })?;
        if is_data_uri(schema_uri) {
            return Ok(());
        }
        self.push_dependency(schema_uri, ResolvedAssetKind::Schema)
    }

    fn inspect_uri_array(
        &mut self,
        value: Option<&Value>,
        kind: ResolvedAssetKind,
    ) -> Result<(), AssetResolverError> {
        let Some(array) = value else {
            return Ok(());
        };
        let array = array.as_array().ok_or_else(|| {
            AssetResolverError::InvalidJson("buffers/images must be arrays".to_owned())
        })?;
        for item in array {
            let Some(uri) = item.get("uri") else {
                continue;
            };
            let uri = uri.as_str().ok_or_else(|| {
                AssetResolverError::InvalidJson("resource uri must be a string".to_owned())
            })?;
            if is_data_uri(uri) {
                continue;
            }
            self.push_dependency(uri, kind)?;
        }
        Ok(())
    }

    fn inspect_glb(&mut self, bytes: &[u8]) -> Result<(), AssetResolverError> {
        validate_declared_length(bytes, *b"glTF", GLB_HEADER_BYTES)?;
        match read_u32(bytes, 4)? {
            1 => return Self::inspect_glb_v1(bytes),
            2 => {}
            _ => {
                return Err(AssetResolverError::InvalidContainer(
                    "unsupported GLB version",
                ));
            }
        }
        let mut offset = GLB_HEADER_BYTES;
        let mut json = None;
        let mut chunk_index = 0_usize;
        while offset < bytes.len() {
            let length = usize::try_from(read_u32(bytes, offset)?)
                .map_err(|_| AssetResolverError::InvalidRange("GLB chunk length"))?;
            if !length.is_multiple_of(4) || !offset.is_multiple_of(4) {
                return Err(AssetResolverError::InvalidContainer(
                    "GLB chunk is not 4-byte aligned",
                ));
            }
            let chunk_type = read_u32(bytes, offset + 4)?;
            let start = offset
                .checked_add(GLB_CHUNK_HEADER_BYTES)
                .ok_or(AssetResolverError::InvalidRange("GLB chunk header"))?;
            let chunk = checked_slice(bytes, start, length)
                .ok_or(AssetResolverError::InvalidRange("GLB chunk"))?;
            if chunk_index == 0 && chunk_type != GLB_JSON_CHUNK {
                return Err(AssetResolverError::InvalidContainer(
                    "first GLB chunk is not JSON",
                ));
            }
            if chunk_type == GLB_JSON_CHUNK && json.replace(chunk).is_some() {
                return Err(AssetResolverError::InvalidContainer(
                    "multiple GLB JSON chunks",
                ));
            }
            offset = start
                .checked_add(length)
                .ok_or(AssetResolverError::InvalidRange("GLB chunk end"))?;
            chunk_index += 1;
        }
        if offset != bytes.len() {
            return Err(AssetResolverError::InvalidContainer(
                "GLB chunks do not consume byteLength",
            ));
        }
        let json = json.ok_or(AssetResolverError::InvalidContainer(
            "missing GLB JSON chunk",
        ))?;
        self.inspect_json(trim_layout_json_padding(json))
    }

    fn inspect_glb_v1(bytes: &[u8]) -> Result<(), AssetResolverError> {
        const GLB_V1_HEADER_BYTES: usize = 20;
        if bytes.len() < GLB_V1_HEADER_BYTES {
            return Err(AssetResolverError::InvalidContainer(
                "truncated GLB 1 header",
            ));
        }
        let json_length = usize::try_from(read_u32(bytes, 12)?)
            .map_err(|_| AssetResolverError::InvalidRange("GLB 1 JSON length"))?;
        let body_offset = GLB_V1_HEADER_BYTES
            .checked_add(json_length)
            .filter(|offset| *offset <= bytes.len())
            .ok_or(AssetResolverError::InvalidRange("GLB 1 JSON content"))?;
        if json_length == 0 || !body_offset.is_multiple_of(4) {
            return Err(AssetResolverError::InvalidContainer(
                "GLB 1 JSON body offset is not 4-byte aligned",
            ));
        }
        if read_u32(bytes, 16)? != 0 {
            return Err(AssetResolverError::InvalidContainer(
                "unsupported GLB 1 content format",
            ));
        }
        let json = &bytes[GLB_V1_HEADER_BYTES..body_offset];
        let document: Value = serde_json::from_slice(trim_layout_json_padding(json))
            .map_err(|error| AssetResolverError::InvalidJson(error.to_string()))?;
        if !document.is_object() {
            return Err(AssetResolverError::InvalidJson(
                "GLB 1 root must be an object".to_owned(),
            ));
        }
        Ok(())
    }

    fn inspect_b3dm(&mut self, bytes: &[u8]) -> Result<(), AssetResolverError> {
        let sections = validate_table_tile(bytes, *b"b3dm", B3DM_HEADER_BYTES)
            .map_err(layout_container_error)?;
        validate_table_json(sections.feature_json, false)?;
        validate_table_json(sections.batch_json, true)?;
        self.inspect_embedded_glb(sections.payload)
    }

    fn inspect_i3dm(&mut self, bytes: &[u8]) -> Result<(), AssetResolverError> {
        let sections = validate_table_tile(bytes, *b"i3dm", I3DM_HEADER_BYTES)
            .map_err(layout_container_error)?;
        validate_table_json(sections.feature_json, false)?;
        validate_table_json(sections.batch_json, true)?;
        let format = read_u32(bytes, 28)?;
        match format {
            0 => {
                let uri = parse_i3dm_uri(sections.payload).map_err(|error| match error.0 {
                    "NUL-padded i3dm glTF URI" => {
                        AssetResolverError::InvalidUri("NUL-padded i3dm glTF URI")
                    }
                    message => AssetResolverError::InvalidUri(message),
                })?;
                self.push_dependency(uri, ResolvedAssetKind::GltfDocument)
            }
            1 => self.inspect_embedded_glb(sections.payload),
            _ => Err(AssetResolverError::InvalidContainer(
                "i3dm gltfFormat must be 0 or 1",
            )),
        }
    }

    fn inspect_cmpt(&mut self, bytes: &[u8], depth: usize) -> Result<(), AssetResolverError> {
        if depth >= self.limits.max_composite_depth {
            return Err(AssetResolverError::LimitExceeded("composite nesting depth"));
        }
        validate_common_tile(bytes, *b"cmpt", CMPT_HEADER_BYTES).map_err(layout_container_error)?;
        let count = usize::try_from(read_u32(bytes, 12)?)
            .map_err(|_| AssetResolverError::InvalidRange("composite tile count"))?;
        if count > self.limits.max_dependencies {
            return Err(AssetResolverError::LimitExceeded("composite tile count"));
        }
        let mut offset = CMPT_HEADER_BYTES;
        for _ in 0..count {
            let length = usize::try_from(read_u32(bytes, offset + 8)?)
                .map_err(|_| AssetResolverError::InvalidRange("inner tile length"))?;
            if length < GLB_HEADER_BYTES {
                return Err(AssetResolverError::InvalidContainer(
                    "inner tile is too short",
                ));
            }
            if !offset.is_multiple_of(8) || !length.is_multiple_of(8) {
                return Err(AssetResolverError::InvalidContainer(
                    "composite child is not 8-byte aligned",
                ));
            }
            let child = checked_slice(bytes, offset, length)
                .ok_or(AssetResolverError::InvalidRange("inner tile"))?;
            self.inspect_content(child, depth + 1)?;
            offset = offset
                .checked_add(length)
                .ok_or(AssetResolverError::InvalidRange("composite child end"))?;
        }
        if offset != bytes.len() {
            return Err(AssetResolverError::InvalidContainer(
                "composite tile count does not consume byteLength",
            ));
        }
        Ok(())
    }

    fn inspect_embedded_glb(&mut self, payload: &[u8]) -> Result<(), AssetResolverError> {
        let glb = embedded_glb(payload).map_err(layout_container_error)?;
        self.inspect_glb(glb)
    }

    fn push_dependency(
        &mut self,
        source_uri: &str,
        kind: ResolvedAssetKind,
    ) -> Result<(), AssetResolverError> {
        validate_uri("source URI", source_uri, self.limits.max_uri_bytes)?;
        let key = (self.owner_uri.to_owned(), source_uri.to_owned());
        if let Some(existing_kind) = self.lookup.get(&key) {
            if *existing_kind != kind {
                return Err(AssetResolverError::ConflictingDependencyKind {
                    owner_uri: key.0,
                    source_uri: key.1,
                });
            }
            return Ok(());
        }
        if self.dependencies.len() >= self.limits.max_dependencies {
            return Err(AssetResolverError::LimitExceeded("dependency count"));
        }
        self.lookup.insert(key, kind);
        self.dependencies.push(GltfDependency {
            owner_uri: self.owner_uri.to_owned(),
            source_uri: source_uri.to_owned(),
            kind,
        });
        Ok(())
    }
}

/// Resolves an external glTF reference relative to its owner without filesystem access.
pub fn resolve_asset_uri(
    owner_uri: &str,
    source_uri: &str,
    max_uri_bytes: usize,
) -> Result<String, AssetResolverError> {
    validate_uri("owner URI", owner_uri, max_uri_bytes)?;
    validate_uri("source URI", source_uri, max_uri_bytes)?;
    if has_uri_scheme(source_uri) {
        return Ok(source_uri.to_owned());
    }

    let owner_without_fragment = owner_uri
        .split_once('#')
        .map_or(owner_uri, |(head, _)| head);
    let owner_without_suffix = owner_without_fragment
        .split_once('?')
        .map_or(owner_without_fragment, |(head, _)| head);
    let resolved = if source_uri.starts_with("//") {
        owner_without_suffix.find(':').map_or_else(
            || source_uri.to_owned(),
            |colon| format!("{}:{source_uri}", &owner_without_suffix[..colon]),
        )
    } else if source_uri.starts_with('/') {
        if let Some(authority_end) = authority_end(owner_without_suffix) {
            format!("{}{source_uri}", &owner_without_suffix[..authority_end])
        } else {
            source_uri.to_owned()
        }
    } else {
        let base_end = owner_without_suffix.rfind('/').map_or(0, |slash| slash + 1);
        format!("{}{source_uri}", &owner_without_suffix[..base_end])
    };
    let normalized = normalize_uri_path(&resolved);
    if normalized.len() > max_uri_bytes {
        return Err(AssetResolverError::LimitExceeded(
            "resolved URI byte length",
        ));
    }
    Ok(normalized)
}

fn normalize_uri_path(uri: &str) -> String {
    let suffix_start = uri.find(['?', '#']).unwrap_or(uri.len());
    let (without_suffix, suffix) = uri.split_at(suffix_start);
    let path_start = authority_end(without_suffix).unwrap_or(0);
    let (prefix, path) = without_suffix.split_at(path_start);
    let absolute = path.starts_with('/');
    let trailing_slash = path.ends_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|part| *part != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let mut normalized = String::with_capacity(uri.len());
    normalized.push_str(prefix);
    if absolute {
        normalized.push('/');
    }
    normalized.push_str(&parts.join("/"));
    if trailing_slash && !normalized.ends_with('/') {
        normalized.push('/');
    }
    normalized.push_str(suffix);
    normalized
}

fn authority_end(uri: &str) -> Option<usize> {
    let scheme = uri.find("://")?;
    let authority_start = scheme + 3;
    Some(
        uri[authority_start..]
            .find('/')
            .map_or(uri.len(), |slash| authority_start + slash),
    )
}

fn has_uri_scheme(uri: &str) -> bool {
    let Some(colon) = uri.find(':') else {
        return false;
    };
    let scheme = &uri[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn is_data_uri(uri: &str) -> bool {
    uri.get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

fn validate_limits(limits: AssetBundleLimits) -> Result<(), AssetResolverError> {
    if limits.max_entries == 0
        || limits.max_unique_assets == 0
        || limits.max_asset_bytes == 0
        || limits.max_blob_bytes == 0
        || limits.max_uri_bytes == 0
        || limits.max_document_bytes == 0
        || limits.max_dependencies == 0
        || limits.max_composite_depth == 0
    {
        return Err(AssetResolverError::InvalidLimits(
            "all limits must be positive",
        ));
    }
    if limits.max_asset_bytes > limits.max_blob_bytes {
        return Err(AssetResolverError::InvalidLimits(
            "single asset limit exceeds blob limit",
        ));
    }
    Ok(())
}

fn validate_uri(
    label: &'static str,
    uri: &str,
    max_uri_bytes: usize,
) -> Result<(), AssetResolverError> {
    if uri.is_empty() {
        return Err(AssetResolverError::InvalidUri(label));
    }
    if uri.len() > max_uri_bytes {
        return Err(AssetResolverError::LimitExceeded(label));
    }
    if uri.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(AssetResolverError::InvalidUri(label));
    }
    Ok(())
}

fn validate_declared_length(
    bytes: &[u8],
    magic: [u8; 4],
    minimum: usize,
) -> Result<(), AssetResolverError> {
    if bytes.len() < minimum || bytes.get(..4) != Some(magic.as_slice()) {
        return Err(AssetResolverError::InvalidContainer(
            "magic or minimum length",
        ));
    }
    let declared = usize::try_from(read_u32(bytes, 8)?)
        .map_err(|_| AssetResolverError::InvalidRange("declared byteLength"))?;
    if declared != bytes.len() {
        return Err(AssetResolverError::InvalidContainer(
            "declared byteLength does not match payload",
        ));
    }
    Ok(())
}

fn validate_table_json(bytes: &[u8], optional: bool) -> Result<(), AssetResolverError> {
    let bytes = trim_layout_json_padding(bytes);
    if optional && bytes.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| AssetResolverError::InvalidJson(error.to_string()))?;
    if !value.is_object() {
        return Err(AssetResolverError::InvalidJson(
            "legacy table JSON must be an object".to_owned(),
        ));
    }
    Ok(())
}

fn layout_container_error(LegacyLayoutError(message): LegacyLayoutError) -> AssetResolverError {
    AssetResolverError::InvalidContainer(message)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, AssetResolverError> {
    bytes
        .get(offset..offset.saturating_add(4))
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(AssetResolverError::InvalidRange("truncated uint32"))
}

fn checked_slice(bytes: &[u8], offset: usize, length: usize) -> Option<&[u8]> {
    let end = offset.checked_add(length)?;
    bytes.get(offset..end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_deduplicates_resolved_bytes_and_preserves_alias_lookup() {
        let shared = [1, 2, 3, 4];
        let unique = [7, 8];
        let bundle = ResolvedAssetBundle::build(
            &[
                ResolvedAssetInput {
                    owner_uri: "https://example.test/a/model.gltf",
                    source_uri: "../shared.bin",
                    resolved_uri: "https://example.test/shared.bin",
                    kind: ResolvedAssetKind::Buffer,
                    bytes: &shared,
                },
                ResolvedAssetInput {
                    owner_uri: "https://example.test/b/model.gltf",
                    source_uri: "../shared.bin",
                    resolved_uri: "https://example.test/shared.bin",
                    kind: ResolvedAssetKind::Buffer,
                    bytes: &shared,
                },
                ResolvedAssetInput {
                    owner_uri: "https://example.test/a/model.gltf",
                    source_uri: "albedo.png",
                    resolved_uri: "https://example.test/a/albedo.png",
                    kind: ResolvedAssetKind::Image,
                    bytes: &unique,
                },
            ],
            AssetBundleLimits::default(),
        )
        .expect("bundle");

        assert_eq!(bundle.entries().len(), 3);
        assert_eq!(bundle.unique_compressed_bytes(), 6);
        let first = bundle
            .lookup("https://example.test/a/model.gltf", "../shared.bin")
            .expect("first alias");
        let second = bundle
            .lookup("https://example.test/b/model.gltf", "../shared.bin")
            .expect("second alias");
        assert_eq!(first.byte_offset, second.byte_offset);
        assert_eq!(bundle.bytes(first).expect("range"), shared);
    }

    #[test]
    fn bundle_rejects_duplicate_keys_conflicting_bytes_and_limits() {
        let duplicate = [
            ResolvedAssetInput {
                owner_uri: "model.gltf",
                source_uri: "mesh.bin",
                resolved_uri: "mesh.bin",
                kind: ResolvedAssetKind::Buffer,
                bytes: &[1],
            },
            ResolvedAssetInput {
                owner_uri: "model.gltf",
                source_uri: "mesh.bin",
                resolved_uri: "mesh.bin",
                kind: ResolvedAssetKind::Buffer,
                bytes: &[1],
            },
        ];
        assert!(matches!(
            ResolvedAssetBundle::build(&duplicate, AssetBundleLimits::default()),
            Err(AssetResolverError::DuplicateLookup { .. })
        ));

        let conflict = [
            ResolvedAssetInput {
                owner_uri: "a.gltf",
                source_uri: "mesh.bin",
                resolved_uri: "mesh.bin",
                kind: ResolvedAssetKind::Buffer,
                bytes: &[1],
            },
            ResolvedAssetInput {
                owner_uri: "b.gltf",
                source_uri: "mesh.bin",
                resolved_uri: "mesh.bin",
                kind: ResolvedAssetKind::Buffer,
                bytes: &[2],
            },
        ];
        assert!(matches!(
            ResolvedAssetBundle::build(&conflict, AssetBundleLimits::default()),
            Err(AssetResolverError::ConflictingResolvedAsset(_))
        ));

        let limits = AssetBundleLimits {
            max_asset_bytes: 1,
            max_blob_bytes: 1,
            ..AssetBundleLimits::default()
        };
        assert!(matches!(
            ResolvedAssetBundle::build(&conflict[..1], limits),
            Ok(_)
        ));
        assert!(matches!(
            ResolvedAssetBundle::build(
                &[ResolvedAssetInput {
                    bytes: &[1, 2],
                    ..conflict[0]
                }],
                limits
            ),
            Err(AssetResolverError::LimitExceeded(_))
        ));
    }

    #[test]
    fn packed_bundle_is_zero_copy_and_rejects_range_conflicts_or_unowned_bytes() {
        let entries = vec![
            ResolvedAssetEntry {
                owner_uri: "a.gltf".to_owned(),
                source_uri: "shared.bin".to_owned(),
                resolved_uri: "cache://shared".to_owned(),
                kind: ResolvedAssetKind::Buffer,
                byte_offset: 0,
                byte_length: 3,
            },
            ResolvedAssetEntry {
                owner_uri: "b.gltf".to_owned(),
                source_uri: "../shared.bin".to_owned(),
                resolved_uri: "cache://shared".to_owned(),
                kind: ResolvedAssetKind::Buffer,
                byte_offset: 0,
                byte_length: 3,
            },
            ResolvedAssetEntry {
                owner_uri: "a.gltf".to_owned(),
                source_uri: "schema.json".to_owned(),
                resolved_uri: "cache://schema".to_owned(),
                kind: ResolvedAssetKind::Schema,
                byte_offset: 3,
                byte_length: 2,
            },
        ];
        let manifest_json = serde_json::to_value(&entries[2]).expect("serialize entry");
        assert_eq!(manifest_json["kind"], "schema");
        assert_eq!(manifest_json["byteOffset"], 3);
        assert_eq!(manifest_json["byteLength"], 2);
        assert_eq!(
            serde_json::from_value::<ResolvedAssetEntry>(manifest_json).expect("deserialize entry"),
            entries[2]
        );
        let bundle = ResolvedAssetBundle::from_packed(
            entries.clone(),
            vec![1, 2, 3, 4, 5],
            AssetBundleLimits::default(),
        )
        .expect("packed bundle");
        assert_eq!(bundle.unique_compressed_bytes(), 5);

        let mut conflict = entries.clone();
        conflict[1].byte_offset = 1;
        assert!(matches!(
            ResolvedAssetBundle::from_packed(
                conflict,
                vec![1, 2, 3, 4, 5],
                AssetBundleLimits::default()
            ),
            Err(AssetResolverError::ConflictingResolvedRange(_))
        ));

        let mut gap = entries;
        gap[2].byte_offset = 4;
        gap[2].byte_length = 1;
        assert!(matches!(
            ResolvedAssetBundle::from_packed(
                gap,
                vec![1, 2, 3, 4, 5],
                AssetBundleLimits::default()
            ),
            Err(AssetResolverError::UnreferencedBlobBytes)
        ));
    }

    #[test]
    fn direct_json_and_glb_find_buffers_images_and_schema_but_not_data_uris() {
        let json = br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"../mesh.bin"},{"uri":"data:application/octet-stream;base64,AA=="}],"images":[{"uri":"textures/a.png"}],"extensions":{"EXT_structural_metadata":{"schemaUri":"metadata/schema.json"}}}"#;
        let direct = inspect_gltf_dependencies(
            "https://example.test/models/site/model.glb",
            json,
            AssetBundleLimits::default(),
        )
        .expect("JSON inspection");
        assert_eq!(direct.dependencies().len(), 3);
        assert_eq!(direct.dependencies()[0].source_uri, "../mesh.bin");
        assert_eq!(direct.dependencies()[0].kind, ResolvedAssetKind::Buffer);
        assert_eq!(direct.dependencies()[1].source_uri, "textures/a.png");
        assert_eq!(direct.dependencies()[1].kind, ResolvedAssetKind::Image);
        assert_eq!(
            direct.dependencies()[2],
            GltfDependency {
                owner_uri: "https://example.test/models/site/model.glb".to_owned(),
                source_uri: "metadata/schema.json".to_owned(),
                kind: ResolvedAssetKind::Schema,
            }
        );

        let glb = test_glb(json);
        let embedded = inspect_gltf_dependencies(
            "https://example.test/models/site/model.glb",
            &glb,
            AssetBundleLimits::default(),
        )
        .expect("GLB inspection");
        assert_eq!(embedded.dependencies(), direct.dependencies());

        let embedded_schema = br#"{"extensions":{"EXT_structural_metadata":{"schemaUri":"data:application/json,%7B%7D"}}}"#;
        let data =
            inspect_gltf_dependencies("model.gltf", embedded_schema, AssetBundleLimits::default())
                .expect("data schema");
        assert!(data.dependencies().is_empty());
    }

    #[test]
    fn glb_v1_is_accepted_directly_and_when_embedded_in_i3dm() {
        let glb = test_glb_v1(br#"{"buffers":{"binary_glTF":{"type":"arraybuffer"}}}"#);
        assert!(
            inspect_gltf_dependencies("model.glb", &glb, AssetBundleLimits::default())
                .expect("direct GLB 1")
                .dependencies()
                .is_empty()
        );
        let i3dm = legacy_tile(*b"i3dm", 32, 1, &glb);
        assert!(
            inspect_gltf_dependencies("tile.i3dm", &i3dm, AssetBundleLimits::default())
                .expect("embedded GLB 1")
                .dependencies()
                .is_empty()
        );
    }

    #[test]
    fn embedded_b3dm_and_nested_cmpt_inspect_glb_dependencies() {
        let glb = test_glb(
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin"}],"images":[{"uri":"image.webp"}]}"#,
        );
        let b3dm = legacy_tile(*b"b3dm", 28, 1, &glb);
        let cmpt = composite(&[b3dm.clone(), composite(&[b3dm])]);
        let result = inspect_gltf_dependencies(
            "https://example.test/tiles/0/0.b3dm",
            &cmpt,
            AssetBundleLimits::default(),
        )
        .expect("nested composite");
        assert_eq!(result.dependencies().len(), 2);
        assert_eq!(result.dependencies()[0].source_uri, "mesh.bin");
        assert_eq!(result.dependencies()[1].source_uri, "image.webp");
    }

    #[test]
    fn i3dm_external_uri_accepts_only_space_padding_and_rejects_nul() {
        let padded = legacy_tile(*b"i3dm", 32, 0, b"models/tree.gltf   ");
        let result = inspect_gltf_dependencies(
            "https://example.test/tiles/tile.i3dm",
            &padded,
            AssetBundleLimits::default(),
        )
        .expect("external model");
        assert_eq!(result.dependencies().len(), 1);
        assert_eq!(
            result.dependencies()[0],
            GltfDependency {
                owner_uri: "https://example.test/tiles/tile.i3dm".to_owned(),
                source_uri: "models/tree.gltf".to_owned(),
                kind: ResolvedAssetKind::GltfDocument,
            }
        );

        let nul = legacy_tile(*b"i3dm", 32, 0, b"models/tree.gltf\0\0");
        assert!(matches!(
            inspect_gltf_dependencies(
                "https://example.test/tiles/tile.i3dm",
                &nul,
                AssetBundleLimits::default()
            ),
            Err(AssetResolverError::InvalidUri("NUL-padded i3dm glTF URI"))
        ));
        let tab = legacy_tile(*b"i3dm", 32, 0, b"models/tree.gltf\t");
        assert!(matches!(
            inspect_gltf_dependencies(
                "https://example.test/tiles/tile.i3dm",
                &tab,
                AssetBundleLimits::default()
            ),
            Err(AssetResolverError::InvalidUri(_))
        ));
    }

    #[test]
    fn inspection_enforces_ranges_depth_dependency_count_and_kind_conflicts() {
        let mut truncated = test_glb(br#"{"asset":{"version":"2.0"}}"#);
        truncated.pop();
        assert!(matches!(
            inspect_gltf_dependencies("model.glb", &truncated, AssetBundleLimits::default()),
            Err(AssetResolverError::InvalidContainer(_))
        ));

        let leaf = legacy_tile(
            *b"b3dm",
            28,
            1,
            &test_glb(br#"{"asset":{"version":"2.0"}}"#),
        );
        let nested = composite(&[composite(&[leaf])]);
        let depth_limits = AssetBundleLimits {
            max_composite_depth: 1,
            ..AssetBundleLimits::default()
        };
        assert!(matches!(
            inspect_gltf_dependencies("tile.cmpt", &nested, depth_limits),
            Err(AssetResolverError::LimitExceeded("composite nesting depth"))
        ));

        let json = br#"{"buffers":[{"uri":"same.bin"}],"images":[{"uri":"same.bin"}]}"#;
        assert!(matches!(
            inspect_gltf_dependencies("model.gltf", json, AssetBundleLimits::default()),
            Err(AssetResolverError::ConflictingDependencyKind { .. })
        ));
    }

    #[test]
    fn inspection_rejects_legacy_alignment_and_glb_chunk_alignment_violations() {
        let glb = test_glb(br#"{"asset":{"version":"2.0"}}"#);
        let mut misaligned = legacy_tile(*b"b3dm", 28, 1, &glb);
        let feature_length = u32::from_le_bytes(misaligned[12..16].try_into().expect("field"));
        misaligned[12..16].copy_from_slice(&(feature_length - 1).to_le_bytes());
        misaligned[16..20].copy_from_slice(&1_u32.to_le_bytes());
        assert!(matches!(
            inspect_gltf_dependencies("tile.b3dm", &misaligned, AssetBundleLimits::default()),
            Err(AssetResolverError::InvalidContainer(
                "feature or batch table boundary is not 8-byte aligned"
            ))
        ));

        let mut bad_chunk = glb;
        let chunk_length = u32::from_le_bytes(bad_chunk[12..16].try_into().expect("field"));
        bad_chunk[12..16].copy_from_slice(&(chunk_length - 1).to_le_bytes());
        assert!(matches!(
            inspect_gltf_dependencies("model.glb", &bad_chunk, AssetBundleLimits::default()),
            Err(AssetResolverError::InvalidContainer(
                "GLB chunk is not 4-byte aligned"
            ))
        ));
    }

    #[test]
    fn uri_resolution_preserves_authority_and_normalizes_dot_segments() {
        assert_eq!(
            resolve_asset_uri(
                "https://host.test/a/b/model.gltf?token=1#part",
                "../textures/./base.png?x=2",
                1024
            )
            .expect("relative"),
            "https://host.test/a/textures/base.png?x=2"
        );
        assert_eq!(
            resolve_asset_uri("https://host.test/a/model.gltf", "/shared/a.bin", 1024)
                .expect("root relative"),
            "https://host.test/shared/a.bin"
        );
        assert_eq!(
            resolve_asset_uri("https://host.test/a/model.gltf", "s3://bucket/a.bin", 1024)
                .expect("absolute"),
            "s3://bucket/a.bin"
        );
    }

    fn test_glb(json: &[u8]) -> Vec<u8> {
        let mut json = json.to_vec();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let total = 20 + json.len();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"glTF");
        bytes.extend(2_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("test GLB length").to_le_bytes());
        bytes.extend(
            u32::try_from(json.len())
                .expect("test JSON length")
                .to_le_bytes(),
        );
        bytes.extend(GLB_JSON_CHUNK.to_le_bytes());
        bytes.extend(json);
        bytes
    }

    fn test_glb_v1(json: &[u8]) -> Vec<u8> {
        let mut json = json.to_vec();
        while !(20 + json.len()).is_multiple_of(4) {
            json.push(b' ');
        }
        let total = 20 + json.len();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"glTF");
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(
            u32::try_from(total)
                .expect("test GLB 1 length")
                .to_le_bytes(),
        );
        bytes.extend(
            u32::try_from(json.len())
                .expect("test GLB 1 JSON length")
                .to_le_bytes(),
        );
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(json);
        bytes
    }

    fn legacy_tile(
        magic: [u8; 4],
        header_bytes: usize,
        gltf_format: u32,
        payload: &[u8],
    ) -> Vec<u8> {
        let mut feature_json = b"{}".to_vec();
        while !(header_bytes + feature_json.len()).is_multiple_of(8) {
            feature_json.push(b' ');
        }
        let unpadded_total = header_bytes + feature_json.len() + payload.len();
        let total = unpadded_total.next_multiple_of(8);
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(magic);
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(u32::try_from(total).expect("tile length").to_le_bytes());
        bytes.extend(
            u32::try_from(feature_json.len())
                .expect("feature JSON length")
                .to_le_bytes(),
        );
        bytes.extend([0_u8; 12]);
        if header_bytes == I3DM_HEADER_BYTES {
            bytes.extend(gltf_format.to_le_bytes());
        }
        bytes.extend(feature_json);
        bytes.extend(payload);
        bytes.resize(total, if gltf_format == 0 { b' ' } else { 0 });
        bytes
    }

    fn composite(children: &[Vec<u8>]) -> Vec<u8> {
        let total = CMPT_HEADER_BYTES + children.iter().map(Vec::len).sum::<usize>();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(*b"cmpt");
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(
            u32::try_from(total)
                .expect("composite length")
                .to_le_bytes(),
        );
        bytes.extend(
            u32::try_from(children.len())
                .expect("child count")
                .to_le_bytes(),
        );
        for child in children {
            bytes.extend(child);
        }
        bytes
    }
}
