//! LAS / LAZ importer (Phase 2, see ADR 0003).
//!
//! Strategy: shell out to vendored **`PotreeConverter`** to produce a
//! Potree 2.0 octree (`metadata.json` + `hierarchy.bin` + `octree.bin`)
//! inside the project cache directory. The renderer then streams the
//! octree via the vendored `@himmelcad/three-loader`; no raw point data
//! ever lives in our process memory and the runtime cost is independent
//! of total cloud size.
//!
//! Per `AGENTS.md` §1.6, `vendor/potreeconverter/<platform>/PotreeConverter`
//! is **part of `HimmelCAD`**: the binary is fetched on `pnpm install` (see
//! `scripts/fetch-vendor.mjs`, SHA-256-verified), the upstream license is
//! mirrored next to it, and we maintain a per-platform `VENDOR.md`.
//!
//! Each distinct prepared dataset becomes one content-addressed directory:
//!
//! ```text
//! <cache_dir>/
//!   potree-<datasetManifestSha256>/
//!     metadata.json
//!     hierarchy.bin
//!     octree.bin
//!     hcad.dataset.json
//!     log.txt          (PotreeConverter diagnostic; ignored)
//! ```
//!
//! The semantic entity ID remains independent from the immutable dataset ID.
//! Repeated imports may therefore produce distinct entities which share the
//! exact same verified prepared bytes.

use std::env;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, EntityTypeId, GeometryObject, GeometryResource, Representation,
    RepresentationAuthority, RepresentationRole, StreamedGeometry,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;

use crate::canonical_provider::{
    CanonicalImportPackage, CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject,
    CanonicalPreparedDataset, FormatCapability, FormatProviderDescriptor, ImportProbe,
    ImportProbeRequest, PreparedDatasetArtifact, ProviderContractError, ProviderOperationContext,
    ProviderProgress, CANONICAL_IO_SCHEMA_VERSION,
};
use crate::ImportError;

/// `PotreeConverter` output encoding. We pin **DEFAULT** (uncompressed
/// `octree.bin`) because three-loader 1.0.x doesn't ship BROTLI support
/// yet — see ADR 0003. Switch to `"BROTLI"` once vendor patch lands.
const ENCODING: &str = "DEFAULT";

/// Sampling method. `"poisson"` produces well-distributed coarse-LOD
/// representations at every octree level; the alternative `"random"`
/// is faster but visually noisier.
const SAMPLING: &str = "poisson";

const POTREE_FORMAT_ID: &str = "potree@2";
const DATASET_MANIFEST_NAME: &str = "hcad.dataset.json";
const HASH_BUFFER_BYTES: usize = 8 * 1024 * 1024;
const LAS_PROVIDER_ID: &str = "hcad.io.las-potree@1";

/// Production LAS/LAZ adapter for the provider-neutral canonical registry.
pub struct LasPotreeCanonicalProvider {
    cache_dir: PathBuf,
    descriptor: FormatProviderDescriptor,
}

impl LasPotreeCanonicalProvider {
    #[must_use]
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: LAS_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "LAS/LAZ to Potree 2".to_owned(),
                format_ids: vec!["las@1.4".to_owned(), "laz@1.4".to_owned()],
                extensions: vec!["las".to_owned(), "laz".to_owned()],
                media_types: vec![
                    "application/vnd.las".to_owned(),
                    "application/vnd.laszip".to_owned(),
                ],
                capabilities: vec![FormatCapability::Import],
            },
        }
    }
}

impl CanonicalImportProvider for LasPotreeCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let extension = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let magic = request.prefix.starts_with(b"LASF");
        let format_id = match extension.as_deref() {
            Some("laz") => "laz@1.4",
            Some("las") if magic => "las@1.4",
            _ if magic => "las@1.4",
            _ => return Ok(None),
        };
        Ok(Some(ImportProbe {
            format_id: format_id.to_owned(),
            confidence: if magic { 100 } else { 60 },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if !matches!(request.format_id, "las@1.4" | "laz@1.4") {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let context = Mutex::new(context);
        let summary = import_las_file_with_progress_and_cancel(
            request.source,
            &self.cache_dir,
            |update| {
                let completed = update
                    .fraction
                    .map_or(0, |fraction| (fraction.clamp(0.0, 1.0) * 10_000.0) as u64);
                context
                    .lock()
                    .expect("provider context lock poisoned")
                    .report_progress(ProviderProgress {
                        phase: "convert".to_owned(),
                        completed,
                        total: Some(10_000),
                        message: update.message,
                    });
            },
            || {
                context
                    .lock()
                    .expect("provider context lock poisoned")
                    .is_cancelled()
            },
        )
        .map_err(|error| match error {
            ImportError::Cancelled => ProviderContractError::Cancelled,
            other => ProviderContractError::Provider(other.to_string()),
        })?;
        summary
            .canonical_import_package()
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))
    }
}

/// One immutable file in a prepared Potree dataset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedPotreeFile {
    pub relative_path: String,
    pub object_hash: ObjectHash,
    pub byte_length: u64,
    pub media_type: String,
}

/// Content-addressed root over every runtime-authoritative Potree file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedPotreeManifest {
    pub schema_version: u32,
    pub format_id: String,
    pub encoding: String,
    pub sampling: String,
    pub point_count: u64,
    pub metadata: PreparedPotreeFile,
    pub hierarchy: PreparedPotreeFile,
    pub octree: PreparedPotreeFile,
}

/// Small immutable JSON object required by a canonical imported entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalImportJsonObject {
    pub object_hash: ObjectHash,
    pub media_type: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LasImportSummary {
    pub source_path: String,
    pub source_name: String,
    pub point_count_total: u64,
    /// Same as `point_count_total` now that `PotreeConverter` retains every
    /// input point (no decimation cap). Kept distinct for renderer-side
    /// "loaded / total" displays; will collapse to one field once the
    /// renderer logs are unified.
    pub point_count_loaded: u64,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    /// Coordinate offset `PotreeConverter` applied so the runtime can add
    /// it back when computing absolute world positions for snap or
    /// measurement output. Per-node positions in `octree.bin` are
    /// quantized via the per-axis `scale` (in metadata.json) relative
    /// to this offset.
    pub render_offset: [f64; 3],
    pub has_color: bool,
    pub has_intensity: bool,
    /// Absolute filesystem path to the content-addressed Potree directory inside
    /// the project cache (sidecar-side). The renderer never sees this
    /// path directly — only `dataset_id`, which the Electron host maps to
    /// `hcad-cache://local/<dataset_id>/...` URLs.
    pub potree_dir: String,
    /// Stable semantic identity of the newly imported point-cloud entity.
    pub entity_id: String,
    /// Content-addressed prepared dataset identity. Hosts use this as the
    /// `hcad-cache://local/<dataset_id>/...` path component.
    pub dataset_id: String,
    /// Immutable root over metadata, hierarchy and point payload bytes.
    pub dataset_manifest_hash: ObjectHash,
    pub dataset_manifest: PreparedPotreeManifest,
    /// Complete validated ADR-0016 admission consumed by the registry/viewer.
    pub canonical_admission: CanonicalRepresentationAdmission,
    /// Component, attribute and relation JSON whose hashes are referenced by
    /// `canonical_admission.entity` and can be copied into the project store.
    pub canonical_objects: Vec<CanonicalImportJsonObject>,
}

impl LasImportSummary {
    /// Revalidates the complete serialized importer-to-project contract.
    pub fn validate_canonical_contract(&self) -> Result<(), ImportError> {
        validate_resolved_representation(
            &self.canonical_admission.entity,
            &self.canonical_admission.selected,
            &self.canonical_admission.resolved_geometry,
        )
        .map_err(|error| ImportError::Canonical(error.to_string()))?;
        let manifest_bytes = serde_json::to_vec(&self.dataset_manifest)
            .map_err(|error| ImportError::Canonical(error.to_string()))?;
        if ObjectHash::of_bytes(&manifest_bytes) != self.dataset_manifest_hash
            || self.dataset_id != format!("potree-{}", self.dataset_manifest_hash.as_str())
        {
            return Err(ImportError::Canonical(
                "prepared dataset identity does not match its manifest".to_string(),
            ));
        }
        let GeometryObject::PointCloud { dataset } = &self.canonical_admission.resolved_geometry
        else {
            return Err(ImportError::Canonical(
                "LAS import did not produce point-cloud geometry".to_string(),
            ));
        };
        if dataset.format_id != self.dataset_manifest.format_id
            || dataset.metadata.object_hash != self.dataset_manifest.metadata.object_hash
            || dataset.metadata.byte_length != Some(self.dataset_manifest.metadata.byte_length)
            || dataset.element_count != Some(self.point_count_total)
        {
            return Err(ImportError::Canonical(
                "canonical point-cloud geometry does not match the prepared dataset".to_string(),
            ));
        }
        for object in &self.canonical_objects {
            let bytes = serde_json::to_vec(&object.value)
                .map_err(|error| ImportError::Canonical(error.to_string()))?;
            if ObjectHash::of_bytes(&bytes) != object.object_hash {
                return Err(ImportError::Canonical(
                    "canonical support object hash mismatch".to_string(),
                ));
            }
        }
        let entity = &self.canonical_admission.entity;
        if !self
            .canonical_objects
            .iter()
            .any(|object| object.object_hash == entity.components_ref)
            || !self
                .canonical_objects
                .iter()
                .any(|object| object.object_hash == entity.attributes_ref)
            || !self
                .canonical_objects
                .iter()
                .any(|object| object.object_hash == entity.relations_ref)
        {
            return Err(ImportError::Canonical(
                "canonical entity references a missing support object".to_string(),
            ));
        }
        Ok(())
    }

    /// Adapts the LAS/Potree result to the common atomic provider package.
    pub fn canonical_import_package(&self) -> Result<CanonicalImportPackage, ImportError> {
        self.validate_canonical_contract()?;
        let objects = self
            .canonical_objects
            .iter()
            .cloned()
            .map(|object| CanonicalJsonObject {
                object_hash: object.object_hash,
                media_type: object.media_type,
                value: object.value,
            })
            .collect::<Vec<_>>();
        let mut artifacts = [
            &self.dataset_manifest.metadata,
            &self.dataset_manifest.hierarchy,
            &self.dataset_manifest.octree,
        ]
        .into_iter()
        .map(|file| PreparedDatasetArtifact {
            relative_path: PathBuf::from(&file.relative_path),
            resource: GeometryResource {
                object_hash: file.object_hash.clone(),
                media_type: file.media_type.clone(),
                byte_length: Some(file.byte_length),
            },
        })
        .collect::<Vec<_>>();
        let manifest_bytes = serde_json::to_vec(&self.dataset_manifest)
            .map_err(|error| ImportError::Canonical(error.to_string()))?;
        artifacts.push(PreparedDatasetArtifact {
            relative_path: PathBuf::from(DATASET_MANIFEST_NAME),
            resource: GeometryResource {
                object_hash: self.dataset_manifest_hash.clone(),
                media_type: "application/vnd.himmelcad.prepared-dataset+json".to_owned(),
                byte_length: Some(manifest_bytes.len() as u64),
            },
        });
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: LAS_PROVIDER_ID.to_owned(),
            provider_version: env!("CARGO_PKG_VERSION").to_owned(),
            admissions: vec![self.canonical_admission.clone()],
            objects,
            datasets: vec![CanonicalPreparedDataset {
                dataset_id: self.dataset_id.clone(),
                format_id: self.dataset_manifest.format_id.clone(),
                entity_id: self.entity_id.clone(),
                representation_slot: self.canonical_admission.representation_slot.clone(),
                root_metadata: GeometryResource {
                    object_hash: self.dataset_manifest.metadata.object_hash.clone(),
                    media_type: self.dataset_manifest.metadata.media_type.clone(),
                    byte_length: Some(self.dataset_manifest.metadata.byte_length),
                },
                artifacts,
            }],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        package.validate().map_err(provider_contract_import_error)?;
        Ok(package)
    }
}

fn provider_contract_import_error(error: ProviderContractError) -> ImportError {
    ImportError::Canonical(error.to_string())
}

#[derive(Debug, Clone)]
pub struct ConverterProgress {
    pub fraction: Option<f32>,
    pub message: String,
}

pub fn import_las_file(path: &Path, cache_dir: &Path) -> Result<LasImportSummary, ImportError> {
    import_las_file_with_progress(path, cache_dir, |_| {})
}

#[allow(clippy::too_many_lines)]
pub fn import_las_file_with_progress<F>(
    path: &Path,
    cache_dir: &Path,
    progress: F,
) -> Result<LasImportSummary, ImportError>
where
    F: Fn(ConverterProgress) + Send + Sync,
{
    import_las_file_with_progress_and_cancel(path, cache_dir, progress, || false)
}

/// Converts, hashes and admits one LAS/LAZ source with cooperative cancellation.
///
/// Cancellation is checked while the converter runs and between every bounded
/// file-hash block. The unpublished staging directory is removed on every
/// cancelled or failed path.
#[allow(clippy::too_many_lines)]
pub fn import_las_file_with_progress_and_cancel<F, C>(
    path: &Path,
    cache_dir: &Path,
    progress: F,
    is_cancelled: C,
) -> Result<LasImportSummary, ImportError>
where
    F: Fn(ConverterProgress) + Send + Sync,
    C: Fn() -> bool + Send + Sync,
{
    check_cancelled(&is_cancelled)?;
    let converter = locate_potreeconverter()?;
    let entity_id = new_entity_id(path);
    let mut prepared_dir = PreparedDirectory::create(cache_dir, path)?;

    let source_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("import.las")
        .to_string();

    tracing::info!(
        converter = ?converter,
        target = ?prepared_dir.path,
        source = %path.display(),
        "PotreeConverter spawning"
    );

    let converter_progress = |update: ConverterProgress| {
        progress(ConverterProgress {
            fraction: update.fraction.map(|fraction| fraction * 0.9),
            message: update.message,
        });
    };
    let converter_output = run_converter_streaming(
        &converter,
        path,
        &prepared_dir.path,
        &converter_progress,
        &is_cancelled,
    )?;

    if !converter_output.status.success() {
        return Err(ImportError::Converter(format!(
            "exit {} — stderr: {} | stdout: {}",
            converter_output.status.code().unwrap_or(-1),
            tail(&converter_output.stderr_tail, 800),
            tail(&converter_output.stdout_tail, 400),
        )));
    }

    let metadata_path = prepared_dir.path.join("metadata.json");
    let metadata_bytes = std::fs::read(&metadata_path)
        .map_err(|e| ImportError::Metadata(format!("read {}: {e}", metadata_path.display())))?;
    let metadata: serde_json::Value = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| ImportError::Metadata(format!("parse {}: {e}", metadata_path.display())))?;

    let point_count = metadata
        .get("points")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let render_offset = parse_xyz(&metadata, "offset")?;
    let bb = metadata
        .get("boundingBox")
        .ok_or_else(|| ImportError::Metadata("missing boundingBox".to_string()))?;
    let bb_min = parse_xyz(bb, "min")?;
    let bb_max = parse_xyz(bb, "max")?;

    let attributes = metadata
        .get("attributes")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_color = attributes.iter().any(|a| {
        a.get("name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|n| matches!(n, "rgb" | "rgba" | "color"))
    });
    let has_intensity = attributes.iter().any(|a| {
        a.get("name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|n| n == "intensity")
    });

    let dataset_manifest =
        build_prepared_manifest(&prepared_dir.path, point_count, &progress, &is_cancelled)?;
    let manifest_bytes = serde_json::to_vec(&dataset_manifest)
        .map_err(|error| ImportError::Canonical(error.to_string()))?;
    let dataset_manifest_hash = ObjectHash::of_bytes(&manifest_bytes);
    std::fs::write(
        prepared_dir.path.join(DATASET_MANIFEST_NAME),
        &manifest_bytes,
    )?;
    let dataset_id = format!("potree-{}", dataset_manifest_hash.as_str());
    let entity_dir = publish_prepared_directory(
        cache_dir,
        &dataset_id,
        &dataset_manifest,
        &manifest_bytes,
        &mut prepared_dir,
        &is_cancelled,
    )?;
    let (canonical_admission, canonical_objects) = canonical_point_cloud_admission(
        &entity_id,
        &source_name,
        point_count,
        bb_min,
        bb_max,
        has_color,
        has_intensity,
        &dataset_manifest,
        &dataset_manifest_hash,
    )?;

    progress(ConverterProgress {
        fraction: Some(1.0),
        message: "canonical point-cloud admission ready".to_string(),
    });

    tracing::info!(
        entity = %entity_id,
        dataset = %dataset_id,
        points = point_count,
        bounds_min = ?bb_min,
        bounds_max = ?bb_max,
        "PotreeConverter completed"
    );

    let summary = LasImportSummary {
        source_path: path.to_string_lossy().into_owned(),
        source_name,
        point_count_total: point_count,
        point_count_loaded: point_count,
        bounds_min: bb_min,
        bounds_max: bb_max,
        render_offset,
        has_color,
        has_intensity,
        potree_dir: entity_dir.to_string_lossy().into_owned(),
        entity_id,
        dataset_id,
        dataset_manifest_hash,
        dataset_manifest,
        canonical_admission,
        canonical_objects,
    };
    summary.validate_canonical_contract()?;
    Ok(summary)
}

struct PreparedDirectory {
    path: PathBuf,
    published: bool,
}

impl PreparedDirectory {
    fn create(cache_dir: &Path, source: &Path) -> Result<Self, ImportError> {
        std::fs::create_dir_all(cache_dir)?;
        for attempt in 0_u32..32 {
            let nonce = import_nonce(source, attempt);
            let path = cache_dir.join(format!(".potree-import-{nonce}"));
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        published: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(ImportError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not allocate an isolated Potree import directory",
        )))
    }
}

impl Drop for PreparedDirectory {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn build_prepared_manifest(
    directory: &Path,
    point_count: u64,
    progress: &(dyn Fn(ConverterProgress) + Send + Sync),
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<PreparedPotreeManifest, ImportError> {
    check_cancelled(is_cancelled)?;
    let specifications = [
        ("metadata.json", "application/json"),
        ("hierarchy.bin", "application/vnd.potree.hierarchy"),
        ("octree.bin", "application/vnd.potree.points"),
    ];
    let total_bytes = specifications.iter().try_fold(0_u64, |total, (name, _)| {
        directory
            .join(name)
            .metadata()
            .map(|metadata| total.saturating_add(metadata.len()))
    })?;
    let mut completed_bytes = 0_u64;
    let mut files = Vec::with_capacity(specifications.len());
    for (name, media_type) in specifications {
        let path = directory.join(name);
        let file = File::open(&path)?;
        let file_bytes = file.metadata()?.len();
        let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, file);
        let mut digest = Sha256::new();
        let mut hashed = 0_u64;
        let mut buffer = vec![0_u8; HASH_BUFFER_BYTES].into_boxed_slice();
        loop {
            check_cancelled(is_cancelled)?;
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
            hashed = hashed.saturating_add(read as u64);
            let progress_units = if total_bytes == 0 {
                10_000_u16
            } else {
                let completed = u128::from(completed_bytes.saturating_add(hashed));
                let total = u128::from(total_bytes);
                u16::try_from((completed.saturating_mul(10_000) / total).min(10_000))
                    .expect("bounded progress fits u16")
            };
            let fraction = f32::from(progress_units) / 10_000.0;
            progress(ConverterProgress {
                fraction: Some(0.9 + 0.09 * fraction),
                message: format!("hashing prepared dataset: {name}"),
            });
        }
        if hashed != file_bytes {
            return Err(ImportError::Canonical(format!(
                "prepared file changed while hashing: {}",
                path.display()
            )));
        }
        completed_bytes = completed_bytes.saturating_add(hashed);
        files.push(PreparedPotreeFile {
            relative_path: name.to_string(),
            object_hash: ObjectHash(hex::encode(digest.finalize())),
            byte_length: hashed,
            media_type: media_type.to_string(),
        });
    }
    let mut files = files.into_iter();
    Ok(PreparedPotreeManifest {
        schema_version: 1,
        format_id: POTREE_FORMAT_ID.to_string(),
        encoding: ENCODING.to_string(),
        sampling: SAMPLING.to_string(),
        point_count,
        metadata: files.next().expect("three prepared files were built"),
        hierarchy: files.next().expect("three prepared files were built"),
        octree: files.next().expect("three prepared files were built"),
    })
}

fn publish_prepared_directory(
    cache_dir: &Path,
    dataset_id: &str,
    manifest: &PreparedPotreeManifest,
    manifest_bytes: &[u8],
    prepared: &mut PreparedDirectory,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<PathBuf, ImportError> {
    check_cancelled(is_cancelled)?;
    let destination = cache_dir.join(dataset_id);
    if destination.exists() {
        let existing = std::fs::read(destination.join(DATASET_MANIFEST_NAME))?;
        if existing != manifest_bytes {
            return Err(ImportError::Canonical(format!(
                "content-addressed dataset collision at {}",
                destination.display()
            )));
        }
        verify_prepared_files(&destination, manifest, is_cancelled)?;
        return Ok(destination);
    }
    std::fs::rename(&prepared.path, &destination)?;
    prepared.published = true;
    Ok(destination)
}

fn verify_prepared_files(
    directory: &Path,
    manifest: &PreparedPotreeManifest,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<(), ImportError> {
    for file in [&manifest.metadata, &manifest.hierarchy, &manifest.octree] {
        let path = directory.join(&file.relative_path);
        let (object_hash, byte_length) = streaming_file_hash(&path, is_cancelled)?;
        if byte_length != file.byte_length || object_hash != file.object_hash {
            return Err(ImportError::Canonical(format!(
                "content-addressed dataset file is corrupt: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn streaming_file_hash(
    path: &Path,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<(ObjectHash, u64), ImportError> {
    let file = File::open(path)?;
    let expected_length = file.metadata()?.len();
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, file);
    let mut digest = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES].into_boxed_slice();
    loop {
        check_cancelled(is_cancelled)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        byte_length = byte_length.saturating_add(read as u64);
    }
    if byte_length != expected_length {
        return Err(ImportError::Canonical(format!(
            "prepared file changed while hashing: {}",
            path.display()
        )));
    }
    Ok((ObjectHash(hex::encode(digest.finalize())), byte_length))
}

#[allow(clippy::too_many_arguments)]
fn canonical_point_cloud_admission(
    entity_id: &str,
    source_name: &str,
    point_count: u64,
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    has_color: bool,
    has_intensity: bool,
    manifest: &PreparedPotreeManifest,
    manifest_hash: &ObjectHash,
) -> Result<
    (
        CanonicalRepresentationAdmission,
        Vec<CanonicalImportJsonObject>,
    ),
    ImportError,
> {
    let components = serde_json::json!({
        "hcad.prepared-dataset@1": {
            "formatId": manifest.format_id,
            "manifestRef": manifest_hash,
        }
    });
    let attributes = serde_json::json!({
        "hcad.point-cloud-import@1": {
            "sourceName": source_name,
            "pointCount": point_count,
            "boundsMin": bounds_min,
            "boundsMax": bounds_max,
            "hasColor": has_color,
            "hasIntensity": has_intensity,
        }
    });
    let relations = serde_json::json!([]);
    let canonical_objects = [
        ("application/vnd.himmelcad.components+json", components),
        ("application/vnd.himmelcad.attributes+json", attributes),
        ("application/vnd.himmelcad.relations+json", relations),
    ]
    .into_iter()
    .map(|(media_type, value)| {
        serde_json::to_vec(&value)
            .map(|bytes| CanonicalImportJsonObject {
                object_hash: ObjectHash::of_bytes(&bytes),
                media_type: media_type.to_string(),
                value,
            })
            .map_err(|error| ImportError::Canonical(error.to_string()))
    })
    .collect::<Result<Vec<_>, _>>()?;

    let geometry = GeometryObject::PointCloud {
        dataset: StreamedGeometry {
            format_id: manifest.format_id.clone(),
            metadata: GeometryResource {
                object_hash: manifest.metadata.object_hash.clone(),
                media_type: manifest.metadata.media_type.clone(),
                byte_length: Some(manifest.metadata.byte_length),
            },
            element_count: Some(point_count),
        },
    };
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry)
            .map_err(|error| ImportError::Canonical(error.to_string()))?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let mut entity = CanonicalEntity {
        id: EntityId(entity_id.to_string()),
        revision: 0,
        type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_string()),
        name: source_name.to_string(),
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref: canonical_objects[0].object_hash.clone(),
        attributes_ref: canonical_objects[1].object_hash.clone(),
        relations_ref: canonical_objects[2].object_hash.clone(),
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"uninitialized canonical LAS import"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)
        .map_err(|error| ImportError::Canonical(error.to_string()))?;
    validate_resolved_representation(&entity, &selected, &geometry)
        .map_err(|error| ImportError::Canonical(error.to_string()))?;
    Ok((
        CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot: "source".to_string(),
            expected_generation: None,
            resolved_geometry: geometry,
        },
        canonical_objects,
    ))
}

fn check_cancelled(is_cancelled: &(dyn Fn() -> bool + Send + Sync)) -> Result<(), ImportError> {
    if is_cancelled() {
        Err(ImportError::Cancelled)
    } else {
        Ok(())
    }
}

struct ConverterOutput {
    status: ExitStatus,
    stdout_tail: String,
    stderr_tail: String,
}

struct StreamLine {
    stream: &'static str,
    line: String,
}

fn run_converter_streaming(
    converter: &Path,
    source: &Path,
    entity_dir: &Path,
    progress: &(dyn Fn(ConverterProgress) + Send + Sync),
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<ConverterOutput, ImportError> {
    progress(ConverterProgress {
        fraction: Some(0.01),
        message: "starting PotreeConverter".to_string(),
    });

    let mut child = Command::new(converter)
        .arg(source)
        .arg("-o")
        .arg(entity_dir)
        .arg("--encoding")
        .arg(ENCODING)
        .arg("-m")
        .arg(SAMPLING)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ImportError::Converter(format!("spawn failed: {e}")))?;

    let (tx, rx) = mpsc::channel::<StreamLine>();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ImportError::Converter("failed to capture converter stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ImportError::Converter("failed to capture converter stderr".to_string()))?;
    let stdout_thread = spawn_stream_reader(stdout, "stdout", tx.clone());
    let stderr_thread = spawn_stream_reader(stderr, "stderr", tx);

    let mut stdout_tail = String::new();
    let mut stderr_tail = String::new();
    let mut progress_state = ConverterProgressState::default();
    let status = loop {
        if is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(ImportError::Cancelled);
        }
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(line) => handle_converter_line(
                &line,
                &mut stdout_tail,
                &mut stderr_tail,
                &mut progress_state,
                progress,
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(done) = child
                    .try_wait()
                    .map_err(|e| ImportError::Converter(format!("wait failed: {e}")))?
                {
                    break done;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break child
                    .wait()
                    .map_err(|e| ImportError::Converter(format!("wait failed: {e}")))?;
            }
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    while let Ok(line) = rx.try_recv() {
        handle_converter_line(
            &line,
            &mut stdout_tail,
            &mut stderr_tail,
            &mut progress_state,
            progress,
        );
    }

    progress(ConverterProgress {
        fraction: Some(1.0),
        message: "PotreeConverter finished".to_string(),
    });

    Ok(ConverterOutput {
        status,
        stdout_tail,
        stderr_tail,
    })
}

fn spawn_stream_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    tx: mpsc::Sender<StreamLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0_u8; 4096];
        let mut line = String::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = String::from_utf8_lossy(&buf[..n]);
            for ch in chunk.chars() {
                if ch == '\n' || ch == '\r' {
                    emit_stream_line(stream, &mut line, &tx);
                } else {
                    line.push(ch);
                }
            }
        }
        emit_stream_line(stream, &mut line, &tx);
    })
}

fn emit_stream_line(stream: &'static str, line: &mut String, tx: &mpsc::Sender<StreamLine>) {
    let cleaned = strip_ansi(line).trim().to_string();
    line.clear();
    if cleaned.is_empty() {
        return;
    }
    let _ = tx.send(StreamLine {
        stream,
        line: cleaned,
    });
}

fn handle_converter_line(
    line: &StreamLine,
    stdout_tail: &mut String,
    stderr_tail: &mut String,
    progress_state: &mut ConverterProgressState,
    progress: &(dyn Fn(ConverterProgress) + Send + Sync),
) {
    if line.stream == "stderr" {
        push_tail(stderr_tail, &line.line, 4_000);
    } else {
        push_tail(stdout_tail, &line.line, 2_000);
    }
    if let Some(update) = progress_state.observe(&line.line) {
        progress(update);
    }
}

#[derive(Default)]
struct ConverterProgressState {
    last_fraction: f32,
    last_phase: &'static str,
}

impl ConverterProgressState {
    fn observe(&mut self, line: &str) -> Option<ConverterProgress> {
        let lower = line.to_ascii_lowercase();
        let (phase, start, end) = if lower.contains("counting") {
            ("counting points", 0.03_f32, 0.22_f32)
        } else if lower.contains("creating chunks")
            || lower.contains("chunking")
            || lower.contains("distribute")
        {
            ("creating chunks", 0.22_f32, 0.55_f32)
        } else if lower.contains("indexing") || lower.contains("sampling") {
            ("indexing octree", 0.55_f32, 0.96_f32)
        } else if lower.contains("writing") || lower.contains("metadata") {
            ("writing metadata", 0.96_f32, 0.99_f32)
        } else {
            ("converting", self.last_fraction, 0.99_f32)
        };

        let local = percent_from_line(line).or_else(|| ratio_from_line(line));
        let mut next = local.map_or(start, |f| start + (end - start) * f);
        next = next.clamp(0.0, 0.99_f32);
        if next < self.last_fraction {
            next = self.last_fraction;
        }

        let phase_changed = phase != self.last_phase;
        if !phase_changed && next - self.last_fraction < 0.005 {
            return None;
        }

        self.last_phase = phase;
        self.last_fraction = next;
        Some(ConverterProgress {
            fraction: Some(next),
            message: format!("{phase}: {}", compact_line(line, 96)),
        })
    }
}

fn parse_xyz(parent: &serde_json::Value, key: &str) -> Result<[f64; 3], ImportError> {
    let arr = parent
        .get(key)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ImportError::Metadata(format!("missing or non-array {key}")))?;
    if arr.len() != 3 {
        return Err(ImportError::Metadata(format!(
            "expected 3 elements in {key}, got {}",
            arr.len()
        )));
    }
    let coord = |i: usize| -> Result<f64, ImportError> {
        arr[i]
            .as_f64()
            .ok_or_else(|| ImportError::Metadata(format!("{key}[{i}] not a number")))
    };
    Ok([coord(0)?, coord(1)?, coord(2)?])
}

/// Resolve the platform-specific `PotreeConverter` binary.
///
/// Resolution order:
/// 1. `HIMMELCAD_VENDOR_DIR` env override (used by CI and the packaged build).
/// 2. `<workspace_root>/vendor/potreeconverter/<platform>/PotreeConverter` —
///    the dev layout populated by `scripts/fetch-vendor.mjs`.
fn locate_potreeconverter() -> Result<PathBuf, ImportError> {
    let platform_dir = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else {
        return Err(ImportError::Converter(
            "unsupported platform for PotreeConverter".to_string(),
        ));
    };
    let exe_name = if cfg!(target_os = "windows") {
        "PotreeConverter.exe"
    } else {
        "PotreeConverter"
    };

    if let Ok(env_dir) = env::var("HIMMELCAD_VENDOR_DIR") {
        let candidate = PathBuf::from(env_dir)
            .join("potreeconverter")
            .join(platform_dir)
            .join(exe_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest
        .join("../..")
        .join("vendor")
        .join("potreeconverter")
        .join(platform_dir)
        .join(exe_name);
    if dev_path.exists() {
        return Ok(dev_path.canonicalize().unwrap_or(dev_path));
    }

    Err(ImportError::Converter(format!(
        "PotreeConverter not found at {} — run `pnpm install` (the postinstall hook \
         fetches it) or `node scripts/fetch-vendor.mjs` manually",
        dev_path.display()
    )))
}

fn new_entity_id(path: &Path) -> String {
    format!("entity-{}", import_nonce(path, 0))
}

fn import_nonce(path: &Path, attempt: u32) -> String {
    let mut digest = Sha256::new();
    digest.update(path.as_os_str().to_string_lossy().as_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(attempt.to_le_bytes());
    if let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        digest.update(duration.as_secs().to_le_bytes());
        digest.update(duration.subsec_nanos().to_le_bytes());
    }
    hex::encode(digest.finalize())
}

fn tail(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.trim().to_string();
    }
    let skip = s.chars().count() - max_chars;
    let trimmed: String = s.chars().skip(skip).collect();
    format!("…{}", trimmed.trim())
}

fn push_tail(buf: &mut String, line: &str, max_chars: usize) {
    buf.push_str(line);
    buf.push('\n');
    let count = buf.chars().count();
    if count > max_chars {
        let skip = count - max_chars;
        *buf = buf.chars().skip(skip).collect();
    }
}

fn compact_line(line: &str, max_chars: usize) -> String {
    let one_line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max_chars {
        return one_line;
    }
    let mut out = one_line
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        if chars.peek() == Some(&'[') {
            let _ = chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

fn percent_from_line(line: &str) -> Option<f32> {
    for (idx, ch) in line.char_indices() {
        if ch != '%' {
            continue;
        }
        let prefix = &line[..idx];
        let start = prefix
            .rfind(|c: char| !(c.is_ascii_digit() || c == '.' || c.is_ascii_whitespace()))
            .map_or(0, |i| i + 1);
        let raw = prefix[start..].trim();
        if raw.is_empty() {
            continue;
        }
        if let Ok(value) = raw.parse::<f32>() {
            if (0.0..=100.0).contains(&value) {
                return Some(value / 100.0);
            }
        }
    }
    None
}

fn ratio_from_line(line: &str) -> Option<f32> {
    for (idx, ch) in line.char_indices() {
        if ch != '/' {
            continue;
        }
        let before = &line[..idx];
        let after = &line[idx + 1..];
        let left_start = before
            .rfind(|c: char| !c.is_ascii_digit())
            .map_or(0, |i| i + 1);
        let right_end = after
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after.len());
        let left = before[left_start..].trim();
        let right = after[..right_end].trim();
        if left.is_empty() || right.is_empty() {
            continue;
        }
        let current = left.parse::<f32>().ok()?;
        let total = right.parse::<f32>().ok()?;
        if total > 0.0 && current >= 0.0 && current <= total {
            return Some((current / total).clamp(0.0, 1.0));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "himmelcad-las-import-test-{name}-{}",
                import_nonce(Path::new(name), 0)
            ));
            std::fs::create_dir_all(&path).expect("test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_prepared_files(directory: &Path) {
        std::fs::write(
            directory.join("metadata.json"),
            br#"{"points":3,"encoding":"DEFAULT"}"#,
        )
        .expect("metadata");
        std::fs::write(directory.join("hierarchy.bin"), [1_u8, 2, 3, 4]).expect("hierarchy");
        std::fs::write(directory.join("octree.bin"), [5_u8, 6, 7, 8, 9]).expect("octree");
    }

    #[test]
    fn las_provider_descriptor_and_probe_are_registry_safe() {
        let provider = LasPotreeCanonicalProvider::new(PathBuf::from("/cache"));
        provider
            .descriptor()
            .validate()
            .expect("valid provider descriptor");

        let las = provider
            .probe(ImportProbeRequest {
                path: Path::new("survey.las"),
                media_type: None,
                prefix: b"LASF\0\0\0\0",
            })
            .expect("LAS probe")
            .expect("LAS match");
        assert_eq!(las.format_id, "las@1.4");
        assert_eq!(las.confidence, 100);

        let laz = provider
            .probe(ImportProbeRequest {
                path: Path::new("survey.laz"),
                media_type: None,
                prefix: b"LASF\0\0\0\0",
            })
            .expect("LAZ probe")
            .expect("LAZ match");
        assert_eq!(laz.format_id, "laz@1.4");

        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("notes.txt"),
                media_type: Some("text/plain"),
                prefix: b"not a point cloud",
            })
            .expect("non-LAS probe")
            .is_none());
    }

    #[test]
    fn prepared_dataset_identity_is_deterministic_and_deduplicated() {
        let root = TestDirectory::new("dedup");
        let mut first = PreparedDirectory::create(&root.0, Path::new("survey.laz"))
            .expect("first staging directory");
        write_prepared_files(&first.path);
        let manifest =
            build_prepared_manifest(&first.path, 3, &|_| {}, &|| false).expect("manifest");
        let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest JSON");
        std::fs::write(first.path.join(DATASET_MANIFEST_NAME), &manifest_bytes)
            .expect("manifest file");
        let manifest_hash = ObjectHash::of_bytes(&manifest_bytes);
        let dataset_id = format!("potree-{}", manifest_hash.as_str());
        let published = publish_prepared_directory(
            &root.0,
            &dataset_id,
            &manifest,
            &manifest_bytes,
            &mut first,
            &|| false,
        )
        .expect("first publication");

        let mut second = PreparedDirectory::create(&root.0, Path::new("copy.laz"))
            .expect("second staging directory");
        write_prepared_files(&second.path);
        let second_manifest =
            build_prepared_manifest(&second.path, 3, &|_| {}, &|| false).expect("second manifest");
        assert_eq!(second_manifest, manifest);
        let reused = publish_prepared_directory(
            &root.0,
            &dataset_id,
            &second_manifest,
            &manifest_bytes,
            &mut second,
            &|| false,
        )
        .expect("deduplicated publication");

        assert_eq!(reused, published);
        assert!(published.join("octree.bin").is_file());
    }

    #[test]
    fn cancellation_during_hashing_removes_unpublished_dataset() {
        let root = TestDirectory::new("cancel-hash");
        let staging_path;
        {
            let staging = PreparedDirectory::create(&root.0, Path::new("survey.laz"))
                .expect("staging directory");
            staging_path = staging.path.clone();
            write_prepared_files(&staging.path);
            let checks = AtomicUsize::new(0);
            let result = build_prepared_manifest(&staging.path, 3, &|_| {}, &|| {
                checks.fetch_add(1, Ordering::Relaxed) >= 1
            });
            assert!(matches!(result, Err(ImportError::Cancelled)));
        }
        assert!(!staging_path.exists());
    }

    #[test]
    fn canonical_las_summary_revalidates_as_one_contract() {
        let manifest = PreparedPotreeManifest {
            schema_version: 1,
            format_id: POTREE_FORMAT_ID.to_string(),
            encoding: ENCODING.to_string(),
            sampling: SAMPLING.to_string(),
            point_count: 42,
            metadata: PreparedPotreeFile {
                relative_path: "metadata.json".to_string(),
                object_hash: ObjectHash::of_bytes(b"metadata"),
                byte_length: 8,
                media_type: "application/json".to_string(),
            },
            hierarchy: PreparedPotreeFile {
                relative_path: "hierarchy.bin".to_string(),
                object_hash: ObjectHash::of_bytes(b"hierarchy"),
                byte_length: 9,
                media_type: "application/vnd.potree.hierarchy".to_string(),
            },
            octree: PreparedPotreeFile {
                relative_path: "octree.bin".to_string(),
                object_hash: ObjectHash::of_bytes(b"octree"),
                byte_length: 6,
                media_type: "application/vnd.potree.points".to_string(),
            },
        };
        let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest JSON");
        let manifest_hash = ObjectHash::of_bytes(&manifest_bytes);
        let (admission, objects) = canonical_point_cloud_admission(
            "entity-survey",
            "survey.laz",
            42,
            [1.0, 2.0, 3.0],
            [4.0, 5.0, 6.0],
            true,
            true,
            &manifest,
            &manifest_hash,
        )
        .expect("canonical admission");
        let summary = LasImportSummary {
            source_path: "/survey.laz".to_string(),
            source_name: "survey.laz".to_string(),
            point_count_total: 42,
            point_count_loaded: 42,
            bounds_min: [1.0, 2.0, 3.0],
            bounds_max: [4.0, 5.0, 6.0],
            render_offset: [0.0, 0.0, 0.0],
            has_color: true,
            has_intensity: true,
            potree_dir: "/cache/dataset".to_string(),
            entity_id: "entity-survey".to_string(),
            dataset_id: format!("potree-{}", manifest_hash.as_str()),
            dataset_manifest_hash: manifest_hash,
            dataset_manifest: manifest,
            canonical_admission: admission,
            canonical_objects: objects,
        };

        summary
            .validate_canonical_contract()
            .expect("complete canonical import contract");
        let package = summary
            .canonical_import_package()
            .expect("common canonical provider package");
        assert_eq!(package.admissions.len(), 1);
        assert_eq!(package.datasets.len(), 1);
        assert_eq!(package.datasets[0].artifacts.len(), 4);
        assert_eq!(
            summary.canonical_admission.entity.type_id.0,
            built_in_type::POINT_CLOUD
        );
        assert_eq!(summary.canonical_admission.representation_slot, "source");
    }

    #[test]
    fn canonical_contract_rejects_tampered_support_object() {
        let manifest = PreparedPotreeManifest {
            schema_version: 1,
            format_id: POTREE_FORMAT_ID.to_string(),
            encoding: ENCODING.to_string(),
            sampling: SAMPLING.to_string(),
            point_count: 1,
            metadata: PreparedPotreeFile {
                relative_path: "metadata.json".to_string(),
                object_hash: ObjectHash::of_bytes(b"metadata"),
                byte_length: 8,
                media_type: "application/json".to_string(),
            },
            hierarchy: PreparedPotreeFile {
                relative_path: "hierarchy.bin".to_string(),
                object_hash: ObjectHash::of_bytes(b"hierarchy"),
                byte_length: 9,
                media_type: "application/vnd.potree.hierarchy".to_string(),
            },
            octree: PreparedPotreeFile {
                relative_path: "octree.bin".to_string(),
                object_hash: ObjectHash::of_bytes(b"octree"),
                byte_length: 6,
                media_type: "application/vnd.potree.points".to_string(),
            },
        };
        let manifest_hash =
            ObjectHash::of_bytes(&serde_json::to_vec(&manifest).expect("manifest JSON"));
        let (admission, mut objects) = canonical_point_cloud_admission(
            "entity-survey",
            "survey.laz",
            1,
            [0.0; 3],
            [1.0; 3],
            false,
            false,
            &manifest,
            &manifest_hash,
        )
        .expect("canonical admission");
        objects[0].value = serde_json::json!({"tampered": true});
        let summary = LasImportSummary {
            source_path: "/survey.laz".to_string(),
            source_name: "survey.laz".to_string(),
            point_count_total: 1,
            point_count_loaded: 1,
            bounds_min: [0.0; 3],
            bounds_max: [1.0; 3],
            render_offset: [0.0; 3],
            has_color: false,
            has_intensity: false,
            potree_dir: "/cache/dataset".to_string(),
            entity_id: "entity-survey".to_string(),
            dataset_id: format!("potree-{}", manifest_hash.as_str()),
            dataset_manifest_hash: manifest_hash,
            dataset_manifest: manifest,
            canonical_admission: admission,
            canonical_objects: objects,
        };

        assert!(summary.validate_canonical_contract().is_err());
    }
}
