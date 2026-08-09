//! Transactional, content-addressed commit of inspected Photolab images.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::entity::{EntityId, EntityKind, EntitySnapshot, Vec3, VisibilityState};
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_capture::PhotolabSpatialReference;
use himmelcad_core::photolab_crs::FrozenImportTransformation;
use himmelcad_core::photolab_images::{DiscoveredPhoto, ProjectedPhotoReference};
use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_core::photolab_products::{ImageProductStatus, ImageProductTag};
use himmelcad_core::photolab_project::{
    JournalCommandState, PhotolabJournalEntry, PhotolabProjectManifest, ProjectReferenceFrame,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
static COMMIT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One inspected image plus import-time status tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCommitItem {
    pub photo: DiscoveredPhoto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projected_reference: Option<ProjectedPhotoReference>,
    #[serde(default)]
    pub tags: BTreeSet<ImageProductTag>,
}

/// Atomic image-batch request. The CRS record must already be validated/frozen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitImagesParams {
    pub operation_id: String,
    pub images: Vec<ImageCommitItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transformation: Option<FrozenImportTransformation>,
    #[serde(default)]
    pub local_metric: bool,
}

/// Cancellation request for one active image commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelImageCommitParams {
    pub operation_id: String,
}

/// Immediate cancellation acknowledgement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelImageCommitResult {
    pub operation_id: String,
    pub cancellation_requested: bool,
}

/// Immutable metadata object referenced by a `CameraImage` entity version hash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraImageMetadataRecord {
    pub schema_version: u32,
    pub source_object_hash: ObjectHash,
    pub transformation_object_hash: ObjectHash,
    pub inspected_photo: DiscoveredPhoto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projected_reference: Option<ProjectedPhotoReference>,
    pub status_tags: BTreeSet<ImageProductTag>,
}

/// Read-only camera record returned to the renderer after opening a project.
/// The source path remains audit metadata; pixels are addressed exclusively by
/// the content hash through the restricted `hcad-image` protocol.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCameraImageRecord {
    pub entity_id: EntityId,
    pub name: String,
    pub metadata_object_hash: ObjectHash,
    pub metadata: CameraImageMetadataRecord,
}

/// Loads and verifies all camera metadata objects referenced by a manifest.
pub fn read_project_camera_images(
    project_root: &Path,
    manifest: &PhotolabProjectManifest,
) -> Result<Vec<ProjectCameraImageRecord>, ImageCommitError> {
    let mut legacy_axis_swap_by_transformation = BTreeMap::<String, bool>::new();
    let mut records = manifest
        .entities
        .values()
        .filter(|entity| entity.kind == EntityKind::CameraImage)
        .map(|entity| {
            let path = object_path(project_root, &entity.version_hash);
            let bytes = fs::read(&path)
                .map_err(|error| io_error("read camera metadata object", &path, error))?;
            let observed = ObjectHash::of_bytes(&bytes);
            if observed != entity.version_hash {
                return Err(ImageCommitError::ObjectHashMismatch {
                    path,
                    expected_hash: entity.version_hash.clone(),
                    observed_hash: observed,
                });
            }
            let mut metadata = serde_json::from_slice::<CameraImageMetadataRecord>(&bytes)?;
            if metadata.schema_version == 1 {
                let swap = if let Some(value) = legacy_axis_swap_by_transformation
                    .get(metadata.transformation_object_hash.as_str())
                {
                    *value
                } else {
                    let transformation_path =
                        object_path(project_root, &metadata.transformation_object_hash);
                    let transformation_bytes = fs::read(&transformation_path).map_err(|error| {
                        io_error(
                            "read image transformation object",
                            &transformation_path,
                            error,
                        )
                    })?;
                    if ObjectHash::of_bytes(&transformation_bytes)
                        != metadata.transformation_object_hash
                    {
                        return Err(ImageCommitError::ObjectHashMismatch {
                            path: transformation_path,
                            expected_hash: metadata.transformation_object_hash.clone(),
                            observed_hash: ObjectHash::of_bytes(&transformation_bytes),
                        });
                    }
                    let transformation = serde_json::from_slice::<FrozenImportTransformation>(
                        &transformation_bytes,
                    )?;
                    let swap = pipeline_ends_with_axis_swap(&transformation.pipeline.proj_pipeline);
                    legacy_axis_swap_by_transformation.insert(
                        metadata.transformation_object_hash.as_str().to_owned(),
                        swap,
                    );
                    swap
                };
                if swap {
                    if let Some(reference) = metadata.projected_reference.as_mut() {
                        std::mem::swap(&mut reference.easting, &mut reference.northing);
                    }
                }
            }
            if metadata.source_object_hash.as_str().len() != 64 {
                return Err(ImageCommitError::InvalidRequest(
                    "camera metadata contains an invalid source object hash",
                ));
            }
            Ok(ProjectCameraImageRecord {
                entity_id: entity.id.clone(),
                name: entity.name.clone(),
                metadata_object_hash: entity.version_hash.clone(),
                metadata,
            })
        })
        .collect::<Result<Vec<_>, ImageCommitError>>()?;
    records.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.entity_id.0.cmp(&right.entity_id.0))
    });
    Ok(records)
}

/// Per-request item result; duplicates reference the canonical entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedImageResult {
    pub source_path: String,
    pub entity_id: EntityId,
    pub source_object_hash: ObjectHash,
    pub metadata_object_hash: ObjectHash,
    pub duplicate: bool,
}

/// Result published only after journal and manifest commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitImagesResult {
    pub operation_id: String,
    pub images: Vec<CommittedImageResult>,
    pub imported_entity_count: u32,
    pub duplicate_count: u32,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
    pub transformation_object_hash: ObjectHash,
}

#[derive(Debug, Clone)]
struct PreparedImage {
    source_hash: ObjectHash,
    metadata_hash: ObjectHash,
    entity: EntitySnapshot,
}

struct StagedImageBatch {
    transformation_hash: ObjectHash,
    indexed_items: Vec<(usize, ImageCommitItem)>,
    prepared_by_hash: BTreeMap<String, PreparedImage>,
    object_hashes: BTreeSet<String>,
}

/// Commits using the shared core cancellation token.
pub fn commit_images_transaction(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CommitImagesParams,
    cancellation: &CancellationToken,
) -> Result<CommitImagesResult, ImageCommitError> {
    commit_images_transaction_with_progress(project_root, manifest, params, cancellation, |_, _| {})
}

/// Transactional commit with observable, monotonic progress.
pub fn commit_images_transaction_with_progress<P>(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CommitImagesParams,
    cancellation: &CancellationToken,
    progress: P,
) -> Result<CommitImagesResult, ImageCommitError>
where
    P: FnMut(f64, &str),
{
    commit_images_with_cancel_and_progress(
        project_root,
        manifest,
        params,
        || cancellation.is_cancel_requested(),
        progress,
    )
}

/// Transaction implementation with injectable cancellation for deterministic tests.
pub fn commit_images_with_cancel<C>(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CommitImagesParams,
    is_cancelled: C,
) -> Result<CommitImagesResult, ImageCommitError>
where
    C: FnMut() -> bool,
{
    commit_images_with_cancel_and_progress(project_root, manifest, params, is_cancelled, |_, _| {})
}

fn commit_images_with_cancel_and_progress<C, P>(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CommitImagesParams,
    mut is_cancelled: C,
    mut progress: P,
) -> Result<CommitImagesResult, ImageCommitError>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    progress(0.01, "Validating image import transaction");
    validate_request(&params)?;
    ensure_project_layout(project_root)?;
    check_cancelled(&mut is_cancelled)?;

    let staging_path = project_root.join("tmp").join(format!(
        "image-commit-{}-{}",
        safe_component(&params.operation_id),
        COMMIT_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    create_directory(&staging_path, "create image commit staging")?;
    let staging = StagingGuard::new(staging_path);
    create_directory(&staging.path.join("incoming"), "create incoming staging")?;
    create_directory(&staging.path.join("objects"), "create object staging")?;
    create_directory(&staging.path.join("previews"), "create preview staging")?;

    let image_collection_id = find_image_collection(manifest)?;
    let batch = stage_image_batch(
        project_root,
        &staging.path,
        manifest,
        &image_collection_id,
        params.images,
        params.transformation.as_ref(),
        &mut is_cancelled,
        &mut progress,
    )?;
    progress(0.9, "Preparing the atomic project update");
    let (candidate_manifest, result_items, affected, before_refs, after_refs) = prepare_manifest(
        manifest,
        &image_collection_id,
        &batch.indexed_items,
        &batch.prepared_by_hash,
        &batch.transformation_hash,
        params.transformation.as_ref(),
    )?;
    check_cancelled(&mut is_cancelled)?;
    let mut published = publish_staged_objects(project_root, &staging.path, &batch.object_hashes)?;
    published.extend(publish_staged_previews(project_root, &staging.path)?);
    if is_cancelled() {
        rollback_published(&published)?;
        return Err(ImageCommitError::Cancelled);
    }
    progress(0.97, "Publishing image metadata and project journal");

    let journal = PhotolabJournalEntry {
        sequence: candidate_manifest.command_sequence,
        command_id: params.operation_id.clone(),
        command_kind: "PhotolabCommitImages".to_owned(),
        timestamp_unix_ms: candidate_manifest.modified_unix_ms,
        state: JournalCommandState::Committed,
        payload: serde_json::json!({
            "operationId": params.operation_id,
            "imageCount": result_items.len(),
            "transformationObjectHash": batch.transformation_hash,
        }),
        affected_entities: affected,
        before_refs,
        after_refs,
        message: Some("Images content-addressed and committed atomically".to_owned()),
    };
    write_journal(project_root, &journal)?;
    atomic_write_json(&project_root.join("manifest.json"), &candidate_manifest)?;
    *manifest = candidate_manifest;

    let duplicate_count = result_items.iter().filter(|item| item.duplicate).count();
    let imported_entity_count = result_items.len().saturating_sub(duplicate_count);
    let result = CommitImagesResult {
        operation_id: journal.command_id,
        images: result_items,
        imported_entity_count: u32::try_from(imported_entity_count).unwrap_or(u32::MAX),
        duplicate_count: u32::try_from(duplicate_count).unwrap_or(u32::MAX),
        autosave_generation: manifest.autosave_generation,
        journal_sequence: journal.sequence,
        transformation_object_hash: batch.transformation_hash,
    };
    progress(1.0, "Images imported atomically");
    Ok(result)
}

#[allow(clippy::too_many_arguments)] // Atomic staging keeps all commit inputs explicit.
fn stage_image_batch<C, P>(
    project_root: &Path,
    staging_root: &Path,
    manifest: &PhotolabProjectManifest,
    collection_id: &EntityId,
    images: Vec<ImageCommitItem>,
    transformation: Option<&FrozenImportTransformation>,
    is_cancelled: &mut C,
    progress: &mut P,
) -> Result<StagedImageBatch, ImageCommitError>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    let transformation_bytes = if let Some(transformation) = transformation {
        serde_json::to_vec(transformation)?
    } else {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "kind": "localMetric",
            "unit": "meter",
            "axes": "rightHandedZUp"
        }))?
    };
    let transformation_hash = ObjectHash::of_bytes(&transformation_bytes);
    stage_bytes_object(
        project_root,
        staging_root,
        &transformation_hash,
        &transformation_bytes,
    )?;
    let (indexed_items, canonical) =
        stage_verified_sources(project_root, staging_root, images, is_cancelled, progress)?;
    let (prepared_by_hash, mut object_hashes) = prepare_camera_metadata(
        project_root,
        staging_root,
        manifest,
        collection_id,
        canonical,
        &transformation_hash,
    )?;
    object_hashes.insert(transformation_hash.as_str().to_owned());
    Ok(StagedImageBatch {
        transformation_hash,
        indexed_items,
        prepared_by_hash,
        object_hashes,
    })
}

type CanonicalSources = BTreeMap<String, (ImageCommitItem, ObjectHash)>;

fn stage_verified_sources<C, P>(
    project_root: &Path,
    staging_root: &Path,
    images: Vec<ImageCommitItem>,
    is_cancelled: &mut C,
    progress: &mut P,
) -> Result<(Vec<(usize, ImageCommitItem)>, CanonicalSources), ImageCommitError>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    let mut indexed_items = images.into_iter().enumerate().collect::<Vec<_>>();
    indexed_items.sort_by(|left, right| {
        left.1
            .photo
            .source_path
            .cmp(&right.1.photo.source_path)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut canonical = BTreeMap::new();
    let total = indexed_items.len();
    for (completed, (index, item)) in indexed_items.iter().enumerate() {
        check_cancelled(is_cancelled)?;
        let filename = source_file_name(&item.photo.source_path);
        progress(
            0.04 + 0.82 * completed as f64 / total.max(1) as f64,
            &format!("Copying image {} of {total}: {filename}", completed + 1),
        );
        let incoming = staging_root.join("incoming").join(format!("{index:08}"));
        let observed =
            copy_source_to_staging(Path::new(&item.photo.source_path), &incoming, is_cancelled)?;
        if observed.byte_size != item.photo.byte_size || observed.hash != item.photo.sha256 {
            return Err(ImageCommitError::SourceChanged {
                path: item.photo.source_path.clone(),
                expected_hash: item.photo.sha256.clone(),
                observed_hash: observed.hash,
                expected_bytes: item.photo.byte_size,
                observed_bytes: observed.byte_size,
            });
        }
        stage_verified_source_object(
            project_root,
            staging_root,
            &incoming,
            &observed.hash,
            &canonical,
        )?;
        stage_image_preview(
            Path::new(&item.photo.source_path),
            staging_root,
            &observed.hash,
        );
        canonical
            .entry(observed.hash.as_str().to_owned())
            .or_insert_with(|| (item.clone(), observed.hash));
        progress(
            0.04 + 0.82 * (completed + 1) as f64 / total.max(1) as f64,
            &format!("Verified image {} of {total}: {filename}", completed + 1),
        );
    }
    Ok((indexed_items, canonical))
}

fn stage_image_preview(source: &Path, staging_root: &Path, hash: &ObjectHash) {
    let destination = staging_root
        .join("previews")
        .join(format!("{}.jpg", hash.as_str()));
    if destination.is_file() {
        return;
    }
    let Ok(reader) = image::ImageReader::open(source) else {
        return;
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return;
    };
    let Ok(image) = reader.decode() else {
        return;
    };
    let preview = image.thumbnail(1_600, 1_600).to_rgb8();
    let _ = preview.save_with_format(destination, image::ImageFormat::Jpeg);
}

fn stage_verified_source_object(
    project_root: &Path,
    staging_root: &Path,
    incoming: &Path,
    hash: &ObjectHash,
    canonical: &CanonicalSources,
) -> Result<(), ImageCommitError> {
    if canonical.contains_key(hash.as_str()) || object_path(project_root, hash).is_file() {
        remove_file(incoming, "remove duplicate staged source")
    } else {
        let staged_object = object_path(staging_root, hash);
        create_parent(&staged_object)?;
        rename(incoming, &staged_object, "stage verified source object")
    }
}

fn prepare_camera_metadata(
    project_root: &Path,
    staging_root: &Path,
    manifest: &PhotolabProjectManifest,
    collection_id: &EntityId,
    canonical: CanonicalSources,
    transformation_hash: &ObjectHash,
) -> Result<(BTreeMap<String, PreparedImage>, BTreeSet<String>), ImageCommitError> {
    let mut prepared = BTreeMap::new();
    let mut object_hashes = BTreeSet::new();
    for (key, (item, source_hash)) in canonical {
        let entity_id = image_entity_id(&manifest.project_id, &source_hash);
        let metadata_hash = if let Some(entity) = manifest.entities.get(&entity_id.0) {
            entity.version_hash.clone()
        } else {
            let metadata = CameraImageMetadataRecord {
                schema_version: 2,
                source_object_hash: source_hash.clone(),
                transformation_object_hash: transformation_hash.clone(),
                inspected_photo: item.photo.clone(),
                projected_reference: item.projected_reference,
                status_tags: item.tags,
            };
            let bytes = serde_json::to_vec(&metadata)?;
            let hash = ObjectHash::of_bytes(&bytes);
            stage_bytes_object(project_root, staging_root, &hash, &bytes)?;
            object_hashes.insert(hash.as_str().to_owned());
            hash
        };
        object_hashes.insert(source_hash.as_str().to_owned());
        let entity = EntitySnapshot {
            id: entity_id,
            kind: EntityKind::CameraImage,
            name: source_file_name(&item.photo.source_path),
            parent: Some(collection_id.clone()),
            children: Vec::new(),
            visibility: VisibilityState::default(),
            version_hash: metadata_hash.clone(),
            bounds: None,
        };
        prepared.insert(
            key,
            PreparedImage {
                source_hash,
                metadata_hash,
                entity,
            },
        );
    }
    Ok((prepared, object_hashes))
}

fn pipeline_ends_with_axis_swap(pipeline: &str) -> bool {
    pipeline.rsplit("+step").next().is_some_and(|last| {
        last.split_ascii_whitespace()
            .any(|token| token == "+proj=axisswap")
            && last
                .split_ascii_whitespace()
                .any(|token| token == "+order=2,1")
    })
}

fn validate_request(params: &CommitImagesParams) -> Result<(), ImageCommitError> {
    if params.operation_id.trim().is_empty()
        || !params
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ImageCommitError::InvalidRequest(
            "operation id must use ASCII letters, digits, '-' or '_'",
        ));
    }
    if params.images.is_empty() {
        return Err(ImageCommitError::InvalidRequest(
            "at least one inspected image is required",
        ));
    }
    match (&params.transformation, params.local_metric) {
        (Some(transformation), false) => validate_frozen_transformation(transformation)?,
        (None, true) => {}
        _ => {
            return Err(ImageCommitError::InvalidRequest(
                "choose exactly one image reference: transformation or localMetric",
            ));
        }
    }
    for item in &params.images {
        if item.photo.source_path.trim().is_empty() || item.photo.byte_size == 0 {
            return Err(ImageCommitError::InvalidRequest(
                "source path and byte size must be non-empty",
            ));
        }
        validate_hash(&item.photo.sha256, "inspected image hash")?;
        let status = ImageProductStatus {
            image_id: himmelcad_core::photolab_matching::ImageId(0),
            tags: item.tags.clone(),
        };
        status
            .validate()
            .map_err(|_| ImageCommitError::InvalidRequest("invalid image status tags"))?;
        if item.tags.iter().any(|tag| {
            matches!(
                tag,
                ImageProductTag::Aligned
                    | ImageProductTag::DepthReady
                    | ImageProductTag::DepthStale
                    | ImageProductTag::Masked
            )
        }) {
            return Err(ImageCommitError::InvalidRequest(
                "alignment, depth, and mask tags cannot be set during image import",
            ));
        }
    }
    Ok(())
}

fn validate_frozen_transformation(
    transformation: &FrozenImportTransformation,
) -> Result<(), ImageCommitError> {
    if transformation.schema_version == 0
        || transformation.pipeline.operation_id.trim().is_empty()
        || transformation.pipeline.operation_name.trim().is_empty()
        || transformation.pipeline.proj_pipeline.trim().is_empty()
        || transformation
            .database_versions
            .proj_version
            .trim()
            .is_empty()
        || transformation
            .database_versions
            .epsg_database_version
            .trim()
            .is_empty()
    {
        return Err(ImageCommitError::InvalidTransformation);
    }
    validate_hash(&transformation.decision_sha256, "CRS decision hash")?;
    for grid in &transformation.pipeline.grids {
        if grid.official_filename.trim().is_empty() || grid.local_path.trim().is_empty() {
            return Err(ImageCommitError::InvalidTransformation);
        }
        if let Some(hash) = &grid.official_sha256 {
            validate_hash(hash, "CRS grid hash")?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct ObservedSource {
    hash: ObjectHash,
    byte_size: u64,
}

fn copy_source_to_staging<C>(
    source: &Path,
    destination: &Path,
    is_cancelled: &mut C,
) -> Result<ObservedSource, ImageCommitError>
where
    C: FnMut() -> bool,
{
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| io_error("inspect source image", source, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ImageCommitError::InvalidSource(source.to_path_buf()));
    }
    let canonical = fs::canonicalize(source)
        .map_err(|error| io_error("canonicalize source image", source, error))?;
    create_parent(destination)?;
    let mut input =
        File::open(&canonical).map_err(|error| io_error("open source image", &canonical, error))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| io_error("create staged image", destination, error))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        check_cancelled(is_cancelled)?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| io_error("read source image", source, error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| io_error("write staged image", destination, error))?;
        total = total
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or(ImageCommitError::SourceTooLarge)?;
    }
    output
        .sync_all()
        .map_err(|error| io_error("sync staged image", destination, error))?;
    Ok(ObservedSource {
        hash: ObjectHash(hex::encode(hasher.finalize())),
        byte_size: total,
    })
}

fn stage_bytes_object(
    project_root: &Path,
    staging_root: &Path,
    hash: &ObjectHash,
    bytes: &[u8],
) -> Result<(), ImageCommitError> {
    if object_path(project_root, hash).is_file() || object_path(staging_root, hash).is_file() {
        return Ok(());
    }
    let path = object_path(staging_root, hash);
    create_parent(&path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| io_error("create staged object", &path, error))?;
    file.write_all(bytes)
        .map_err(|error| io_error("write staged object", &path, error))?;
    file.sync_all()
        .map_err(|error| io_error("sync staged object", &path, error))
}

type ManifestPreparation = (
    PhotolabProjectManifest,
    Vec<CommittedImageResult>,
    Vec<EntityId>,
    Vec<ObjectHash>,
    Vec<ObjectHash>,
);

fn prepare_manifest(
    manifest: &PhotolabProjectManifest,
    collection_id: &EntityId,
    indexed_items: &[(usize, ImageCommitItem)],
    prepared: &BTreeMap<String, PreparedImage>,
    transformation_hash: &ObjectHash,
    transformation: Option<&FrozenImportTransformation>,
) -> Result<ManifestPreparation, ImageCommitError> {
    let mut candidate = manifest.clone();
    if let Some(transformation) = transformation {
        candidate.spatial_reference = PhotolabSpatialReference::CrsBacked;
        if let Some(reference_frame) = &candidate.reference_frame {
            if reference_frame.target != transformation.target {
                return Err(ImageCommitError::ProjectReferenceMismatch);
            }
        } else {
            candidate.reference_frame = Some(ProjectReferenceFrame {
                target: transformation.target.clone(),
                established_by_transformation_sha256: transformation_hash.clone(),
            });
            if let Some(reference) = indexed_items
                .iter()
                .find_map(|(_, item)| item.projected_reference.as_ref())
            {
                candidate.render_offset = Vec3 {
                    x: reference.easting,
                    y: reference.northing,
                    z: reference.transformed_height_meters.unwrap_or_default(),
                };
            }
        }
    } else {
        if candidate.reference_frame.is_some()
            || !matches!(
                candidate.spatial_reference,
                PhotolabSpatialReference::LocalMetric { .. }
            )
        {
            return Err(ImageCommitError::ProjectReferenceMismatch);
        }
        if indexed_items
            .iter()
            .any(|(_, item)| item.projected_reference.is_some())
        {
            return Err(ImageCommitError::InvalidRequest(
                "local metric image imports cannot contain projected references",
            ));
        }
    }
    let collection_before = candidate
        .entities
        .get(&collection_id.0)
        .ok_or(ImageCommitError::ImageCollectionMissing)?
        .version_hash
        .clone();
    let mut affected = Vec::from([collection_id.clone()]);
    for image in prepared.values() {
        if !candidate.entities.contains_key(&image.entity.id.0) {
            candidate
                .entities
                .insert(image.entity.id.0.clone(), image.entity.clone());
            affected.push(image.entity.id.clone());
        }
    }

    let mut camera_children = candidate
        .entities
        .values()
        .filter(|entity| {
            entity.kind == EntityKind::CameraImage && entity.parent.as_ref() == Some(collection_id)
        })
        .map(|entity| entity.id.clone())
        .collect::<Vec<_>>();
    camera_children.sort_by(|left, right| left.0.cmp(&right.0));
    let collection = candidate
        .entities
        .get_mut(&collection_id.0)
        .ok_or(ImageCommitError::ImageCollectionMissing)?;
    collection.children = camera_children;
    collection.name = format!("Images · {}", collection.children.len());
    let collection_version = serde_json::to_vec(&(
        &collection.name,
        &collection.children,
        &collection.visibility,
    ))?;
    collection.version_hash = ObjectHash::of_bytes(&collection_version);

    let originally_existing = manifest.entities.keys().cloned().collect::<BTreeSet<_>>();
    let mut ordered = indexed_items.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, _)| *index);
    let mut seen_hashes = BTreeSet::new();
    let results = ordered
        .into_iter()
        .map(|(_, item)| {
            let key = item.photo.sha256.as_str().to_owned();
            let image = &prepared[&key];
            let duplicate =
                originally_existing.contains(&image.entity.id.0) || !seen_hashes.insert(key);
            CommittedImageResult {
                source_path: item.photo.source_path.clone(),
                entity_id: image.entity.id.clone(),
                source_object_hash: image.source_hash.clone(),
                metadata_object_hash: image.metadata_hash.clone(),
                duplicate,
            }
        })
        .collect::<Vec<_>>();

    candidate.autosave_generation = candidate.autosave_generation.saturating_add(1);
    candidate.command_sequence = candidate.command_sequence.saturating_add(1);
    candidate.modified_unix_ms = unix_ms()?;
    candidate.clean_shutdown = false;
    let mut refs = BTreeMap::new();
    refs.insert(
        transformation_hash.as_str().to_owned(),
        transformation_hash.clone(),
    );
    refs.insert(
        collection.version_hash.as_str().to_owned(),
        collection.version_hash.clone(),
    );
    for image in prepared.values() {
        refs.insert(
            image.source_hash.as_str().to_owned(),
            image.source_hash.clone(),
        );
        refs.insert(
            image.metadata_hash.as_str().to_owned(),
            image.metadata_hash.clone(),
        );
    }
    Ok((
        candidate,
        results,
        affected,
        vec![collection_before],
        refs.into_values().collect(),
    ))
}

fn publish_staged_objects(
    project_root: &Path,
    staging_root: &Path,
    hashes: &BTreeSet<String>,
) -> Result<Vec<PathBuf>, ImageCommitError> {
    let mut published = Vec::new();
    for value in hashes {
        let hash = ObjectHash(value.clone());
        let source = object_path(staging_root, &hash);
        let destination = object_path(project_root, &hash);
        if destination.is_file() || !source.is_file() {
            continue;
        }
        create_parent(&destination)?;
        if let Err(error) = fs::rename(&source, &destination) {
            let _ = rollback_published(&published);
            return Err(io_error(
                "publish content-addressed object",
                &destination,
                error,
            ));
        }
        published.push(destination);
        if let Some(parent) = published.last().and_then(|path| path.parent()) {
            if let Err(error) = sync_directory(parent) {
                let _ = rollback_published(&published);
                return Err(error);
            }
        }
    }
    sync_directory(&project_root.join("objects"))?;
    Ok(published)
}

fn publish_staged_previews(
    project_root: &Path,
    staging_root: &Path,
) -> Result<Vec<PathBuf>, ImageCommitError> {
    let source_root = staging_root.join("previews");
    let destination_root = project_root.join("previews");
    create_directory(&destination_root, "create project previews")?;
    let mut published = Vec::new();
    for entry in fs::read_dir(&source_root)
        .map_err(|error| io_error("read staged previews", &source_root, error))?
    {
        let entry = entry.map_err(|error| io_error("read staged preview", &source_root, error))?;
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        let destination = destination_root.join(entry.file_name());
        if destination.is_file() {
            continue;
        }
        rename(&source, &destination, "publish image preview")?;
        published.push(destination);
    }
    sync_directory(&destination_root)?;
    Ok(published)
}

fn rollback_published(paths: &[PathBuf]) -> Result<(), ImageCommitError> {
    for path in paths.iter().rev() {
        if path.is_file() {
            remove_file(path, "roll back unreferenced object")?;
        }
    }
    Ok(())
}

fn find_image_collection(manifest: &PhotolabProjectManifest) -> Result<EntityId, ImageCommitError> {
    let mut collections = manifest
        .entities
        .values()
        .filter(|entity| entity.kind == EntityKind::ImageCollection)
        .map(|entity| entity.id.clone());
    let collection = collections
        .next()
        .ok_or(ImageCommitError::ImageCollectionMissing)?;
    if collections.next().is_some() {
        return Err(ImageCommitError::MultipleImageCollections);
    }
    Ok(collection)
}

fn image_entity_id(project_id: &str, source_hash: &ObjectHash) -> EntityId {
    EntityId(format!("{project_id}:image:{}", source_hash.as_str()))
}

fn source_file_name(source_path: &str) -> String {
    Path::new(source_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Image")
        .to_owned()
}

fn object_path(root: &Path, hash: &ObjectHash) -> PathBuf {
    let (prefix, remainder) = hash.as_str().split_at(2);
    root.join("objects").join(prefix).join(remainder)
}

fn write_journal(
    project_root: &Path,
    entry: &PhotolabJournalEntry,
) -> Result<(), ImageCommitError> {
    let path = project_root
        .join("journal")
        .join(format!("{:016}.json", entry.sequence));
    if path.exists() {
        return Err(ImageCommitError::JournalSequenceCollision(entry.sequence));
    }
    atomic_write_json(&path, entry)
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), ImageCommitError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let parent = path.parent().ok_or(ImageCommitError::InvalidProjectPath)?;
    create_directory(parent, "create atomic write parent")?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("write"),
        COMMIT_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| io_error("create atomic file", &temporary, error))?;
        file.write_all(&bytes)
            .map_err(|error| io_error("write atomic file", &temporary, error))?;
        file.sync_all()
            .map_err(|error| io_error("sync atomic file", &temporary, error))?;
    }
    rename(&temporary, path, "publish atomic file")?;
    sync_directory(parent)
}

fn ensure_project_layout(root: &Path) -> Result<(), ImageCommitError> {
    for child in ["objects", "journal", "previews", "tmp"] {
        create_directory(&root.join(child), "create project directory")?;
    }
    Ok(())
}

fn create_parent(path: &Path) -> Result<(), ImageCommitError> {
    let parent = path.parent().ok_or(ImageCommitError::InvalidProjectPath)?;
    create_directory(parent, "create object parent")
}

fn create_directory(path: &Path, action: &'static str) -> Result<(), ImageCommitError> {
    fs::create_dir_all(path).map_err(|error| io_error(action, path, error))
}

fn rename(source: &Path, destination: &Path, action: &'static str) -> Result<(), ImageCommitError> {
    fs::rename(source, destination).map_err(|error| io_error(action, destination, error))
}

fn remove_file(path: &Path, action: &'static str) -> Result<(), ImageCommitError> {
    fs::remove_file(path).map_err(|error| io_error(action, path, error))
}

fn sync_directory(path: &Path) -> Result<(), ImageCommitError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("sync directory", path, error))
}

fn check_cancelled<C>(is_cancelled: &mut C) -> Result<(), ImageCommitError>
where
    C: FnMut() -> bool,
{
    if is_cancelled() {
        Err(ImageCommitError::Cancelled)
    } else {
        Ok(())
    }
}

fn validate_hash(hash: &ObjectHash, field: &'static str) -> Result<(), ImageCommitError> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(ImageCommitError::InvalidHash(field))
    }
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn unix_ms() -> Result<u64, ImageCommitError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ImageCommitError::ClockBeforeEpoch)?;
    u64::try_from(duration.as_millis()).map_err(|_| ImageCommitError::ClockOverflow)
}

fn io_error(action: &'static str, path: &Path, source: std::io::Error) -> ImageCommitError {
    ImageCommitError::Io {
        action,
        path: path.to_path_buf(),
        source,
    }
}

struct StagingGuard {
    path: PathBuf,
}

impl StagingGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Transactional image commit failure.
#[derive(Debug, Error)]
pub enum ImageCommitError {
    #[error("invalid image commit request: {0}")]
    InvalidRequest(&'static str),
    #[error("frozen CRS transformation is invalid")]
    InvalidTransformation,
    #[error(
        "image import target CRS/height frame differs from the established project reference frame"
    )]
    ProjectReferenceMismatch,
    #[error("invalid SHA-256 in {0}")]
    InvalidHash(&'static str),
    #[error("image commit cancelled")]
    Cancelled,
    #[error("source image is not a regular non-symlink file: {0}")]
    InvalidSource(PathBuf),
    #[error("source image changed after inspection: {path}")]
    SourceChanged {
        path: String,
        expected_hash: ObjectHash,
        observed_hash: ObjectHash,
        expected_bytes: u64,
        observed_bytes: u64,
    },
    #[error("content-addressed object hash mismatch at {path}")]
    ObjectHashMismatch {
        path: PathBuf,
        expected_hash: ObjectHash,
        observed_hash: ObjectHash,
    },
    #[error("source image exceeds supported byte count")]
    SourceTooLarge,
    #[error("Photolab manifest has no image collection")]
    ImageCollectionMissing,
    #[error("Photolab manifest has multiple image collections")]
    MultipleImageCollections,
    #[error("journal sequence {0} already exists")]
    JournalSequenceCollision(u64),
    #[error("invalid project path")]
    InvalidProjectPath,
    #[error("system clock lies before Unix epoch")]
    ClockBeforeEpoch,
    #[error("system clock does not fit u64 milliseconds")]
    ClockOverflow,
    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("{action} failed for {path}: {source}")]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use himmelcad_core::photolab_crs::{
        CrsDatabaseVersions, CrsDefinition, CrsWithEpoch, FrozenCrsEndpoint,
        FrozenOperationPipeline, GeographicArea, HeightReference, OperationSelectionPolicy,
        VerticalOperationMode,
    };
    use himmelcad_core::photolab_images::{PhotoFormat, PhotoMetadata, ProjectedPhotoReference};
    use himmelcad_core::photolab_project::initial_photolab_manifest;

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "himmelcad-image-commit-{name}-{}-{}",
                std::process::id(),
                COMMIT_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn frozen_transformation() -> FrozenImportTransformation {
        let endpoint = FrozenCrsEndpoint {
            horizontal: CrsWithEpoch {
                crs: CrsDefinition::Epsg(25832),
                coordinate_epoch: None,
            },
            vertical: HeightReference::Unknown,
        };
        FrozenImportTransformation {
            schema_version: 1,
            original: endpoint.clone(),
            target: endpoint,
            vertical_mode: VerticalOperationMode::PreserveValues,
            area_of_interest: GeographicArea {
                west_longitude: 9.0,
                south_latitude: 48.0,
                east_longitude: 10.0,
                north_latitude: 49.0,
            },
            pipeline: FrozenOperationPipeline {
                operation_id: "EPSG:25832".to_owned(),
                operation_name: "Identity test operation".to_owned(),
                proj_pipeline: "+proj=noop".to_owned(),
                expected_accuracy_mm: Some(0.0),
                ballpark: false,
                selection_policy: OperationSelectionPolicy::default(),
                grids: Vec::new(),
            },
            database_versions: CrsDatabaseVersions {
                proj_version: "test-proj".to_owned(),
                epsg_database_version: "test-epsg".to_owned(),
            },
            decision_sha256: ObjectHash::of_bytes(b"decision"),
        }
    }

    fn write_source(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let source = root.join(name);
        fs::write(&source, bytes).expect("write source fixture");
        source
    }

    fn inspected(path: &Path, bytes: &[u8]) -> ImageCommitItem {
        ImageCommitItem {
            photo: DiscoveredPhoto {
                source_path: path.to_string_lossy().into_owned(),
                format: PhotoFormat::Jpeg,
                byte_size: u64::try_from(bytes.len()).expect("fixture size"),
                sha256: ObjectHash::of_bytes(bytes),
                metadata: PhotoMetadata::default(),
                capture_source: Default::default(),
                decoder_capability: None,
                position_prior: None,
                derived_provenance: None,
                duplicate_of: None,
            },
            projected_reference: None,
            tags: BTreeSet::from([ImageProductTag::RtkFixed]),
        }
    }

    fn request(operation_id: &str, images: Vec<ImageCommitItem>) -> CommitImagesParams {
        CommitImagesParams {
            operation_id: operation_id.to_owned(),
            images,
            transformation: Some(frozen_transformation()),
            local_metric: false,
        }
    }

    fn manifest() -> PhotolabProjectManifest {
        initial_photolab_manifest("project-test".to_owned(), "Test".to_owned(), 1)
    }

    fn camera_count(manifest: &PhotolabProjectManifest) -> usize {
        manifest
            .entities
            .values()
            .filter(|entity| entity.kind == EntityKind::CameraImage)
            .count()
    }

    #[test]
    fn import_cannot_forge_the_derived_mask_tag() {
        let directory = TestDirectory::new("masked-import-tag");
        let bytes = b"camera image bytes";
        let source = write_source(&directory.0, "masked.jpg", bytes);
        let mut item = inspected(&source, bytes);
        item.tags.insert(ImageProductTag::Masked);
        let error = validate_request(&request("masked-import", vec![item]))
            .expect_err("mask tag must come from a real mask revision");
        assert!(matches!(error, ImageCommitError::InvalidRequest(_)));
    }

    #[test]
    fn duplicate_content_creates_one_object_and_one_entity() {
        let directory = TestDirectory::new("duplicates");
        let bytes = b"same camera image bytes";
        let first = write_source(&directory.0, "a.jpg", bytes);
        let second = write_source(&directory.0, "b.jpg", bytes);
        let mut manifest = manifest();

        let result = commit_images_with_cancel(
            &directory.0,
            &mut manifest,
            request(
                "duplicates",
                vec![inspected(&first, bytes), inspected(&second, bytes)],
            ),
            || false,
        )
        .expect("duplicate batch should commit");

        assert_eq!(result.imported_entity_count, 1);
        assert_eq!(result.duplicate_count, 1);
        assert_eq!(camera_count(&manifest), 1);
        assert!(object_path(&directory.0, &ObjectHash::of_bytes(bytes)).is_file());
        let entity = manifest
            .entities
            .values()
            .find(|entity| entity.kind == EntityKind::CameraImage)
            .expect("camera entity");
        let metadata: CameraImageMetadataRecord = serde_json::from_slice(
            &fs::read(object_path(&directory.0, &entity.version_hash)).expect("read metadata"),
        )
        .expect("decode metadata");
        assert!(metadata.status_tags.contains(&ImageProductTag::RtkFixed));

        let repeated = commit_images_with_cancel(
            &directory.0,
            &mut manifest,
            request("duplicate-reimport", vec![inspected(&first, bytes)]),
            || false,
        )
        .expect("existing content should deduplicate");
        assert_eq!(repeated.imported_entity_count, 0);
        assert_eq!(repeated.duplicate_count, 1);
        assert_eq!(camera_count(&manifest), 1);
    }

    #[test]
    fn local_metric_images_commit_without_a_crs_or_projected_reference() {
        let directory = TestDirectory::new("local-metric");
        let bytes = b"ordinary phone image";
        let source = write_source(&directory.0, "phone.jpg", bytes);
        let mut manifest = manifest();
        let params = CommitImagesParams {
            operation_id: "local-metric".into(),
            images: vec![inspected(&source, bytes)],
            transformation: None,
            local_metric: true,
        };

        let result = commit_images_with_cancel(&directory.0, &mut manifest, params, || false)
            .expect("local metric image commit");

        assert!(manifest.reference_frame.is_none());
        assert!(matches!(
            manifest.spatial_reference,
            PhotolabSpatialReference::LocalMetric { .. }
        ));
        let reference: serde_json::Value = serde_json::from_slice(
            &fs::read(object_path(
                &directory.0,
                &result.transformation_object_hash,
            ))
            .expect("local reference object"),
        )
        .expect("local reference JSON");
        assert_eq!(reference["kind"], "localMetric");
    }

    #[test]
    fn changed_source_is_rejected_before_publication() {
        let directory = TestDirectory::new("changed");
        let inspected_bytes = b"original image";
        let source = write_source(&directory.0, "changed.jpg", inspected_bytes);
        let item = inspected(&source, inspected_bytes);
        fs::write(&source, b"changed after inspection").expect("mutate source");
        let mut manifest = manifest();
        let before = manifest.clone();

        let result = commit_images_with_cancel(
            &directory.0,
            &mut manifest,
            request("changed", vec![item]),
            || false,
        );
        assert!(matches!(
            result,
            Err(ImageCommitError::SourceChanged { .. })
        ));
        assert_eq!(manifest, before);
        assert_eq!(camera_count(&manifest), 0);
        assert!(!object_path(&directory.0, &ObjectHash::of_bytes(inspected_bytes)).exists());
    }

    #[test]
    fn cancellation_cleans_staging_and_leaves_manifest_untouched() {
        let directory = TestDirectory::new("cancel");
        let bytes = vec![42_u8; COPY_BUFFER_BYTES * 3];
        let source = write_source(&directory.0, "large.jpg", &bytes);
        let mut manifest = manifest();
        let before = manifest.clone();
        let checks = Cell::new(0_u32);

        let result = commit_images_with_cancel(
            &directory.0,
            &mut manifest,
            request("cancel", vec![inspected(&source, &bytes)]),
            || {
                checks.set(checks.get() + 1);
                checks.get() >= 5
            },
        );
        assert!(matches!(result, Err(ImageCommitError::Cancelled)));
        assert_eq!(manifest, before);
        assert_eq!(camera_count(&manifest), 0);
        assert_eq!(
            fs::read_dir(directory.0.join("tmp"))
                .expect("read tmp")
                .count(),
            0
        );
    }

    #[test]
    fn one_invalid_source_aborts_the_entire_batch_atomically() {
        let directory = TestDirectory::new("atomic-batch");
        let first_bytes = b"valid first image";
        let second_bytes = b"second image before mutation";
        let first = write_source(&directory.0, "first.jpg", first_bytes);
        let second = write_source(&directory.0, "second.jpg", second_bytes);
        let first_item = inspected(&first, first_bytes);
        let second_item = inspected(&second, second_bytes);
        fs::write(&second, b"mutated second image").expect("mutate second source");
        let mut manifest = manifest();
        let before = manifest.clone();

        let result = commit_images_with_cancel(
            &directory.0,
            &mut manifest,
            request("atomic", vec![first_item, second_item]),
            || false,
        );
        assert!(matches!(
            result,
            Err(ImageCommitError::SourceChanged { .. })
        ));
        assert_eq!(manifest, before);
        assert_eq!(camera_count(&manifest), 0);
        assert_eq!(
            fs::read_dir(directory.0.join("journal"))
                .expect("read journal")
                .count(),
            0
        );
        assert!(!object_path(&directory.0, &ObjectHash::of_bytes(first_bytes)).exists());
    }

    #[test]
    fn legacy_axis_swapped_camera_references_are_read_as_easting_northing() {
        let directory = TestDirectory::new("legacy-axis-contract");
        ensure_project_layout(&directory.0).expect("project layout");
        let mut transformation = frozen_transformation();
        transformation.pipeline.proj_pipeline =
            "+proj=pipeline +step +proj=tmerc +step +proj=axisswap +order=2,1".to_owned();
        let transformation_bytes = serde_json::to_vec(&transformation).expect("transformation");
        let transformation_hash = ObjectHash::of_bytes(&transformation_bytes);
        let transformation_path = object_path(&directory.0, &transformation_hash);
        create_parent(&transformation_path).expect("transformation parent");
        fs::write(&transformation_path, transformation_bytes).expect("transformation object");

        let source_hash = ObjectHash::of_bytes(b"legacy-camera-source");
        let metadata = CameraImageMetadataRecord {
            schema_version: 1,
            source_object_hash: source_hash,
            transformation_object_hash: transformation_hash,
            inspected_photo: DiscoveredPhoto {
                source_path: "/legacy.jpg".to_owned(),
                format: PhotoFormat::Jpeg,
                byte_size: 1,
                sha256: ObjectHash::of_bytes(b"legacy-camera-source"),
                metadata: PhotoMetadata::default(),
                capture_source: Default::default(),
                decoder_capability: None,
                position_prior: None,
                derived_provenance: None,
                duplicate_of: None,
            },
            projected_reference: Some(ProjectedPhotoReference {
                source_latitude_degrees: 47.65,
                source_longitude_degrees: 10.34,
                source_height_meters: Some(783.0),
                easting: 5_281_200.5,
                northing: 4_375_550.25,
                transformed_height_meters: Some(735.8),
                transformation_decision_sha256: ObjectHash::of_bytes(b"decision"),
            }),
            status_tags: BTreeSet::new(),
        };
        let metadata_bytes = serde_json::to_vec(&metadata).expect("metadata");
        let metadata_hash = ObjectHash::of_bytes(&metadata_bytes);
        let metadata_path = object_path(&directory.0, &metadata_hash);
        create_parent(&metadata_path).expect("metadata parent");
        fs::write(&metadata_path, metadata_bytes).expect("metadata object");

        let mut manifest = manifest();
        let images = find_image_collection(&manifest).expect("image collection");
        let camera_id = EntityId("project-test:image:legacy".to_owned());
        manifest.entities.insert(
            camera_id.0.clone(),
            EntitySnapshot {
                id: camera_id,
                kind: EntityKind::CameraImage,
                name: "legacy.jpg".to_owned(),
                parent: Some(images),
                children: Vec::new(),
                visibility: VisibilityState::default(),
                version_hash: metadata_hash,
                bounds: None,
            },
        );

        let records = read_project_camera_images(&directory.0, &manifest).expect("camera records");
        let reference = records[0]
            .metadata
            .projected_reference
            .as_ref()
            .expect("projected reference");
        assert_eq!(reference.easting, 4_375_550.25);
        assert_eq!(reference.northing, 5_281_200.5);
        assert_eq!(reference.transformed_height_meters, Some(735.8));
    }
}
