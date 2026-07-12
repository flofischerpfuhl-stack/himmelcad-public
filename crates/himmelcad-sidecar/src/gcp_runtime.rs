//! Atomic, content-addressed GCP imports, observations and optimization snapshots.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::entity::{
    Bounds3, EntityId, EntityKind, EntitySnapshot, Vec3, VisibilityState,
};
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_crs::FrozenImportTransformation;
use himmelcad_core::photolab_gcp::{
    build_gcp_residual_report_scope, build_optimization_snapshot, validate_gcp_observation,
    validate_gcp_points, GcpError, GcpObservation, GcpOptimizationScope, GcpPoint, GcpPointId,
    GcpResidualReportScope, GcpRole,
};
use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_core::photolab_project::{
    JournalCommandState, PhotolabJournalEntry, PhotolabProjectManifest, ProjectReferenceFrame,
};
use himmelcad_io::gcp_import::{
    import_gcp_csv_file_with_cancel, GcpCsvImportError, GcpCsvImportResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
static OPERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGcpsParams {
    pub operation_id: String,
    pub source_import: GcpCsvImportResult,
    pub transformed_points: Vec<GcpPoint>,
    pub transformation: FrozenImportTransformation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedGcpResult {
    pub point_id: String,
    pub entity_id: EntityId,
    pub metadata_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGcpsResult {
    pub operation_id: String,
    pub points: Vec<CommittedGcpResult>,
    pub source_csv_sha256: ObjectHash,
    pub transformation_sha256: ObjectHash,
    pub collection_sha256: ObjectHash,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelGcpOperationParams {
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelGcpOperationResult {
    pub operation_id: String,
    pub cancellation_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertGcpObservationParams {
    pub operation_id: String,
    pub expected_collection_sha256: ObjectHash,
    pub observation: GcpObservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertGcpObservationResult {
    pub operation_id: String,
    pub collection_sha256: ObjectHash,
    pub replaced_existing: bool,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
}

/// Explicit user edit of one point/image observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum GcpObservationEdit {
    /// Excludes a projection while retaining its coordinate for display.
    Block {
        coordinate: himmelcad_core::photolab_gcp::ImageCoordinate,
        reason: String,
    },
    /// Restores the last non-blocked observation from the immutable revision chain.
    Unblock,
    /// Removes a pinned manual, automatic, or predicted observation.
    Remove,
}

/// Optimistically concurrent edit of one persisted observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditGcpObservationParams {
    pub operation_id: String,
    pub expected_collection_sha256: ObjectHash,
    pub point_id: GcpPointId,
    pub image_id: himmelcad_core::photolab_matching::ImageId,
    pub edit: GcpObservationEdit,
}

/// Result of one journalled observation edit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditGcpObservationResult {
    pub operation_id: String,
    pub collection_sha256: ObjectHash,
    pub restored_state: Option<himmelcad_core::photolab_gcp::GcpObservationState>,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
}

/// Atomic multi-image observation update used by tie-point propagation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertGcpObservationsParams {
    pub operation_id: String,
    pub expected_collection_sha256: ObjectHash,
    pub observations: Vec<GcpObservation>,
    /// Automatic proposals must not replace explicit manual measurements.
    #[serde(default = "default_preserve_manual")]
    pub preserve_manual: bool,
}

const fn default_preserve_manual() -> bool {
    true
}

/// One-revision result for a propagated multi-image update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertGcpObservationsResult {
    pub operation_id: String,
    pub collection_sha256: ObjectHash,
    pub inserted_count: u32,
    pub replaced_count: u32,
    pub preserved_manual_count: u32,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGcpOptimizationSnapshotParams {
    pub operation_id: String,
    pub expected_collection_sha256: ObjectHash,
    pub scope: GcpOptimizationScope,
    /// Per-run role/mask overrides; the authoritative imported GCP catalog is unchanged.
    #[serde(default)]
    pub role_overrides: BTreeMap<GcpPointId, GcpRole>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGcpOptimizationSnapshotResult {
    pub operation_id: String,
    pub collection_sha256: ObjectHash,
    pub snapshot_sha256: ObjectHash,
    pub residual_scope_sha256: ObjectHash,
    pub residual_scope: GcpResidualReportScope,
    pub autosave_generation: u64,
    pub journal_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpPointRecord {
    pub point: GcpPoint,
    pub source_csv_sha256: ObjectHash,
    pub transformation_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCollectionRecord {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_collection_sha256: Option<ObjectHash>,
    pub points: Vec<GcpPointRecord>,
    pub observations: Vec<GcpObservation>,
}

impl GcpCollectionRecord {
    #[must_use]
    pub fn point_definitions(&self) -> Vec<GcpPoint> {
        self.points
            .iter()
            .map(|record| record.point.clone())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpPointMetadataRecord {
    pub schema_version: u32,
    pub point: GcpPoint,
    pub source_csv_sha256: ObjectHash,
    pub transformation_sha256: ObjectHash,
}

pub fn commit_gcps_transaction(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CommitGcpsParams,
    cancellation: &CancellationToken,
) -> Result<CommitGcpsResult, GcpRuntimeError> {
    validate_operation_id(&params.operation_id)?;
    validate_transformation(&params.transformation)?;
    check_cancelled(cancellation)?;
    let reparsed = import_gcp_csv_file_with_cancel(
        Path::new(&params.source_import.source_path),
        params.source_import.mapping.clone(),
        || cancellation.is_cancel_requested(),
    )?;
    validate_reparsed_source(&params.source_import, &reparsed)?;
    validate_transformed_points(&reparsed.points, &params.transformed_points)?;
    let group_id = find_reference_group(manifest)?;
    let (current_hash, current) = load_collection(project_root, manifest, &group_id)?;
    validate_new_points(&current, &params.transformed_points)?;
    let staging = create_staging(project_root, &params.operation_id)?;
    let result = commit_gcps_staged(
        project_root,
        manifest,
        params,
        reparsed,
        group_id,
        current_hash,
        current,
        &staging.path,
        cancellation,
    );
    drop(staging);
    result
}

#[allow(clippy::too_many_arguments)]
fn commit_gcps_staged(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CommitGcpsParams,
    reparsed: GcpCsvImportResult,
    group_id: EntityId,
    current_hash: Option<ObjectHash>,
    mut current: GcpCollectionRecord,
    staging_root: &Path,
    cancellation: &CancellationToken,
) -> Result<CommitGcpsResult, GcpRuntimeError> {
    if manifest
        .reference_frame
        .as_ref()
        .is_some_and(|frame| frame.target != params.transformation.target)
    {
        return Err(GcpRuntimeError::ProjectReferenceMismatch);
    }
    let first_coordinate = params
        .transformed_points
        .first()
        .map(|point| point.coordinate);
    let transformation_bytes = serde_json::to_vec(&params.transformation)?;
    let transformation_sha256 = stage_bytes(staging_root, &transformation_bytes)?;
    let source_csv_sha256 = stage_source_csv(
        Path::new(&reparsed.source_path),
        staging_root,
        &reparsed.source_sha256,
        reparsed.source_bytes,
        cancellation,
    )?;
    let import_bytes = serde_json::to_vec(&reparsed)?;
    let import_sha256 = stage_bytes(staging_root, &import_bytes)?;
    let mut committed = Vec::with_capacity(params.transformed_points.len());
    let mut entities = Vec::with_capacity(params.transformed_points.len());
    for point in params.transformed_points {
        check_cancelled(cancellation)?;
        let metadata = GcpPointMetadataRecord {
            schema_version: 1,
            point: point.clone(),
            source_csv_sha256: source_csv_sha256.clone(),
            transformation_sha256: transformation_sha256.clone(),
        };
        let metadata_sha256 = stage_bytes(staging_root, &serde_json::to_vec(&metadata)?)?;
        let entity_id = gcp_entity_id(&manifest.project_id, &point.id.0);
        entities.push(point_entity(
            entity_id.clone(),
            group_id.clone(),
            &point,
            metadata_sha256.clone(),
        ));
        committed.push(CommittedGcpResult {
            point_id: point.id.0.clone(),
            entity_id,
            metadata_sha256,
        });
        current.points.push(GcpPointRecord {
            point,
            source_csv_sha256: source_csv_sha256.clone(),
            transformation_sha256: transformation_sha256.clone(),
        });
    }
    current
        .points
        .sort_by(|left, right| left.point.id.cmp(&right.point.id));
    current.previous_collection_sha256 = current_hash.clone();
    let collection_sha256 = stage_bytes(staging_root, &serde_json::to_vec(&current)?)?;
    let mut candidate = prepare_gcp_manifest(manifest, &group_id, entities, &collection_sha256)?;
    if candidate.reference_frame.is_none() {
        candidate.reference_frame = Some(ProjectReferenceFrame {
            target: params.transformation.target.clone(),
            established_by_transformation_sha256: transformation_sha256.clone(),
        });
        if let Some(coordinate) = first_coordinate {
            candidate.render_offset = Vec3 {
                x: coordinate.east_meters,
                y: coordinate.north_meters,
                z: coordinate.height_meters,
            };
        }
    }
    check_cancelled(cancellation)?;
    let published = publish_objects(project_root, staging_root)?;
    if cancellation.is_cancel_requested() {
        rollback_published(&published)?;
        return Err(GcpRuntimeError::Cancelled);
    }
    let before_refs = current_hash.into_iter().collect::<Vec<_>>();
    let mut after_refs = committed
        .iter()
        .map(|point| point.metadata_sha256.clone())
        .collect::<Vec<_>>();
    after_refs.extend([
        source_csv_sha256.clone(),
        transformation_sha256.clone(),
        import_sha256,
        collection_sha256.clone(),
    ]);
    let affected = std::iter::once(group_id.clone())
        .chain(committed.iter().map(|point| point.entity_id.clone()))
        .collect::<Vec<_>>();
    let journal = committed_journal(
        &candidate,
        &params.operation_id,
        "PhotolabCommitGcps",
        serde_json::json!({
            "pointCount": committed.len(),
            "sourceCsvSha256": source_csv_sha256,
            "transformationSha256": transformation_sha256,
            "collectionSha256": collection_sha256,
        }),
        affected,
        before_refs,
        after_refs,
    );
    publish_command(project_root, &journal, &candidate, &published)?;
    *manifest = candidate;
    Ok(CommitGcpsResult {
        operation_id: params.operation_id,
        points: committed,
        source_csv_sha256,
        transformation_sha256,
        collection_sha256,
        autosave_generation: manifest.autosave_generation,
        journal_sequence: journal.sequence,
    })
}

pub fn upsert_gcp_observation_transaction(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: UpsertGcpObservationParams,
    cancellation: &CancellationToken,
) -> Result<UpsertGcpObservationResult, GcpRuntimeError> {
    validate_operation_id(&params.operation_id)?;
    check_cancelled(cancellation)?;
    let group_id = find_reference_group(manifest)?;
    let (current_hash, mut collection) =
        load_required_collection(project_root, manifest, &group_id)?;
    require_expected_hash(&params.expected_collection_sha256, &current_hash)?;
    validate_gcp_observation(&collection.point_definitions(), &params.observation)?;
    let key = (&params.observation.point_id, params.observation.image_id);
    let replaced_existing = collection
        .observations
        .iter()
        .any(|item| (&item.point_id, item.image_id) == key);
    collection
        .observations
        .retain(|item| (&item.point_id, item.image_id) != key);
    collection.observations.push(params.observation.clone());
    collection.observations.sort_by(|left, right| {
        left.point_id
            .cmp(&right.point_id)
            .then_with(|| left.image_id.cmp(&right.image_id))
    });
    collection.previous_collection_sha256 = Some(current_hash.clone());
    let bytes = serde_json::to_vec(&collection)?;
    let new_hash = ObjectHash::of_bytes(&bytes);
    check_cancelled(cancellation)?;
    let published = write_object(project_root, &new_hash, &bytes)?;
    if cancellation.is_cancel_requested() {
        rollback_optional(published.as_ref())?;
        return Err(GcpRuntimeError::Cancelled);
    }
    let mut candidate = manifest.clone();
    update_group_revision(&mut candidate, &group_id, &new_hash)?;
    touch_manifest(&mut candidate)?;
    let journal = committed_journal(
        &candidate,
        &params.operation_id,
        "PhotolabUpsertGcpObservation",
        serde_json::json!({
            "pointId": params.observation.point_id,
            "imageId": params.observation.image_id,
            "replacedExisting": replaced_existing,
            "collectionSha256": new_hash,
        }),
        vec![group_id],
        vec![current_hash],
        vec![new_hash.clone()],
    );
    let published = published.into_iter().collect::<Vec<_>>();
    publish_command(project_root, &journal, &candidate, &published)?;
    *manifest = candidate;
    Ok(UpsertGcpObservationResult {
        operation_id: params.operation_id,
        collection_sha256: new_hash,
        replaced_existing,
        autosave_generation: manifest.autosave_generation,
        journal_sequence: journal.sequence,
    })
}

/// Blocks, unblocks, or removes one observation in a single durable revision.
pub fn edit_gcp_observation_transaction(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: EditGcpObservationParams,
    cancellation: &CancellationToken,
) -> Result<EditGcpObservationResult, GcpRuntimeError> {
    validate_operation_id(&params.operation_id)?;
    check_cancelled(cancellation)?;
    let group_id = find_reference_group(manifest)?;
    let (current_hash, mut collection) =
        load_required_collection(project_root, manifest, &group_id)?;
    require_expected_hash(&params.expected_collection_sha256, &current_hash)?;
    if !collection
        .points
        .iter()
        .any(|record| record.point.id == params.point_id)
    {
        return Err(GcpRuntimeError::Domain(GcpError::UnknownPoint(
            params.point_id,
        )));
    }
    let key_matches = |observation: &GcpObservation| {
        observation.point_id == params.point_id && observation.image_id == params.image_id
    };
    let current_index = collection.observations.iter().position(key_matches);
    let (action_name, restored_state) = match &params.edit {
        GcpObservationEdit::Block { coordinate, reason } => {
            let blocked = GcpObservation {
                point_id: params.point_id.clone(),
                image_id: params.image_id,
                state: himmelcad_core::photolab_gcp::GcpObservationState::Blocked {
                    predicted_coordinate: Some(*coordinate),
                    reason: reason.clone(),
                },
            };
            validate_gcp_observation(&collection.point_definitions(), &blocked)?;
            if let Some(index) = current_index {
                collection.observations[index] = blocked;
            } else {
                collection.observations.push(blocked);
            }
            ("block", None)
        }
        GcpObservationEdit::Unblock => {
            let Some(index) = current_index else {
                return Err(GcpRuntimeError::ObservationMissing);
            };
            if !matches!(
                collection.observations[index].state,
                himmelcad_core::photolab_gcp::GcpObservationState::Blocked { .. }
            ) {
                return Err(GcpRuntimeError::ObservationNotBlocked);
            }
            let restored = restore_observation_before_block(
                project_root,
                collection.previous_collection_sha256.as_ref(),
                &params.point_id,
                params.image_id,
            )?;
            if let Some(observation) = restored.as_ref() {
                collection.observations[index] = observation.clone();
            } else {
                collection.observations.remove(index);
            }
            ("unblock", restored.map(|observation| observation.state))
        }
        GcpObservationEdit::Remove => {
            let Some(index) = current_index else {
                return Err(GcpRuntimeError::ObservationMissing);
            };
            collection.observations.remove(index);
            ("remove", None)
        }
    };
    collection.observations.sort_by(|left, right| {
        left.point_id
            .cmp(&right.point_id)
            .then_with(|| left.image_id.cmp(&right.image_id))
    });
    collection.previous_collection_sha256 = Some(current_hash.clone());
    let bytes = serde_json::to_vec(&collection)?;
    let new_hash = ObjectHash::of_bytes(&bytes);
    check_cancelled(cancellation)?;
    let published = write_object(project_root, &new_hash, &bytes)?;
    if cancellation.is_cancel_requested() {
        rollback_optional(published.as_ref())?;
        return Err(GcpRuntimeError::Cancelled);
    }
    let mut candidate = manifest.clone();
    update_group_revision(&mut candidate, &group_id, &new_hash)?;
    touch_manifest(&mut candidate)?;
    let journal = committed_journal(
        &candidate,
        &params.operation_id,
        "PhotolabEditGcpObservation",
        serde_json::json!({
            "action": action_name,
            "pointId": params.point_id,
            "imageId": params.image_id,
            "collectionSha256": new_hash,
        }),
        vec![group_id],
        vec![current_hash],
        vec![new_hash.clone()],
    );
    let published = published.into_iter().collect::<Vec<_>>();
    publish_command(project_root, &journal, &candidate, &published)?;
    *manifest = candidate;
    Ok(EditGcpObservationResult {
        operation_id: params.operation_id,
        collection_sha256: new_hash,
        restored_state,
        autosave_generation: manifest.autosave_generation,
        journal_sequence: journal.sequence,
    })
}

fn restore_observation_before_block(
    project_root: &Path,
    initial_hash: Option<&ObjectHash>,
    point_id: &GcpPointId,
    image_id: himmelcad_core::photolab_matching::ImageId,
) -> Result<Option<GcpObservation>, GcpRuntimeError> {
    let mut next = initial_hash.cloned();
    let mut visited = BTreeSet::new();
    while let Some(hash) = next {
        if !visited.insert(hash.as_str().to_owned()) {
            return Err(GcpRuntimeError::CollectionRevisionCycle);
        }
        let collection = load_collection_object(project_root, &hash)?;
        if let Some(observation) = collection
            .observations
            .iter()
            .find(|observation| {
                observation.point_id == *point_id && observation.image_id == image_id
            })
            .cloned()
        {
            if !matches!(
                observation.state,
                himmelcad_core::photolab_gcp::GcpObservationState::Blocked { .. }
            ) {
                return Ok(Some(observation));
            }
        } else {
            return Ok(None);
        }
        next = collection.previous_collection_sha256;
    }
    Ok(None)
}

fn load_collection_object(
    root: &Path,
    hash: &ObjectHash,
) -> Result<GcpCollectionRecord, GcpRuntimeError> {
    validate_hash(hash)?;
    let path = object_path(root, hash);
    let bytes = fs::read(&path).map_err(|source| GcpRuntimeError::Io {
        action: "read historical GCP collection",
        path,
        source,
    })?;
    if ObjectHash::of_bytes(&bytes) != *hash {
        return Err(GcpRuntimeError::ObjectHashMismatch);
    }
    let collection: GcpCollectionRecord = serde_json::from_slice(&bytes)?;
    if collection.schema_version != 1 {
        return Err(GcpRuntimeError::UnsupportedCollectionVersion(
            collection.schema_version,
        ));
    }
    validate_gcp_points(&collection.point_definitions())?;
    let definitions = collection.point_definitions();
    let mut observation_keys = BTreeSet::new();
    for observation in &collection.observations {
        validate_gcp_observation(&definitions, observation)?;
        if !observation_keys.insert((observation.point_id.clone(), observation.image_id)) {
            return Err(GcpRuntimeError::DuplicateStoredObservation);
        }
    }
    Ok(collection)
}

/// Commits all propagated observations in one content revision and one journal entry.
pub fn upsert_gcp_observations_transaction(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: UpsertGcpObservationsParams,
    cancellation: &CancellationToken,
) -> Result<UpsertGcpObservationsResult, GcpRuntimeError> {
    validate_operation_id(&params.operation_id)?;
    check_cancelled(cancellation)?;
    if params.observations.is_empty() {
        return Err(GcpRuntimeError::EmptyObservationBatch);
    }
    let group_id = find_reference_group(manifest)?;
    let (current_hash, mut collection) =
        load_required_collection(project_root, manifest, &group_id)?;
    require_expected_hash(&params.expected_collection_sha256, &current_hash)?;
    let definitions = collection.point_definitions();
    let mut incoming_keys = BTreeSet::new();
    for observation in &params.observations {
        validate_gcp_observation(&definitions, observation)?;
        if !incoming_keys.insert((observation.point_id.clone(), observation.image_id)) {
            return Err(GcpRuntimeError::DuplicateIncomingObservation);
        }
    }
    let mut inserted_count = 0_u32;
    let mut replaced_count = 0_u32;
    let mut preserved_manual_count = 0_u32;
    for observation in params.observations {
        check_cancelled(cancellation)?;
        let key = (&observation.point_id, observation.image_id);
        let current = collection
            .observations
            .iter()
            .position(|item| (&item.point_id, item.image_id) == key);
        if let Some(index) = current {
            let preserves_manual = params.preserve_manual
                && matches!(
                    collection.observations[index].state,
                    himmelcad_core::photolab_gcp::GcpObservationState::Manual { .. }
                )
                && !matches!(
                    observation.state,
                    himmelcad_core::photolab_gcp::GcpObservationState::Manual { .. }
                );
            if preserves_manual {
                preserved_manual_count = preserved_manual_count.saturating_add(1);
                continue;
            }
            collection.observations[index] = observation;
            replaced_count = replaced_count.saturating_add(1);
        } else {
            collection.observations.push(observation);
            inserted_count = inserted_count.saturating_add(1);
        }
    }
    collection.observations.sort_by(|left, right| {
        left.point_id
            .cmp(&right.point_id)
            .then_with(|| left.image_id.cmp(&right.image_id))
    });
    collection.previous_collection_sha256 = Some(current_hash.clone());
    let bytes = serde_json::to_vec(&collection)?;
    let new_hash = ObjectHash::of_bytes(&bytes);
    check_cancelled(cancellation)?;
    let published = write_object(project_root, &new_hash, &bytes)?;
    if cancellation.is_cancel_requested() {
        rollback_optional(published.as_ref())?;
        return Err(GcpRuntimeError::Cancelled);
    }
    let mut candidate = manifest.clone();
    update_group_revision(&mut candidate, &group_id, &new_hash)?;
    touch_manifest(&mut candidate)?;
    let journal = committed_journal(
        &candidate,
        &params.operation_id,
        "PhotolabUpsertGcpObservations",
        serde_json::json!({
            "insertedCount": inserted_count,
            "replacedCount": replaced_count,
            "preservedManualCount": preserved_manual_count,
            "collectionSha256": new_hash,
        }),
        vec![group_id],
        vec![current_hash],
        vec![new_hash.clone()],
    );
    let published = published.into_iter().collect::<Vec<_>>();
    publish_command(project_root, &journal, &candidate, &published)?;
    *manifest = candidate;
    Ok(UpsertGcpObservationsResult {
        operation_id: params.operation_id,
        collection_sha256: new_hash,
        inserted_count,
        replaced_count,
        preserved_manual_count,
        autosave_generation: manifest.autosave_generation,
        journal_sequence: journal.sequence,
    })
}

pub fn create_gcp_optimization_snapshot_transaction(
    project_root: &Path,
    manifest: &mut PhotolabProjectManifest,
    params: CreateGcpOptimizationSnapshotParams,
    cancellation: &CancellationToken,
) -> Result<CreateGcpOptimizationSnapshotResult, GcpRuntimeError> {
    validate_operation_id(&params.operation_id)?;
    check_cancelled(cancellation)?;
    let group_id = find_reference_group(manifest)?;
    let (collection_sha256, collection) =
        load_required_collection(project_root, manifest, &group_id)?;
    require_expected_hash(&params.expected_collection_sha256, &collection_sha256)?;
    let mut point_definitions = collection.point_definitions();
    for (point_id, role) in &params.role_overrides {
        let point = point_definitions
            .iter_mut()
            .find(|point| &point.id == point_id)
            .ok_or_else(|| GcpRuntimeError::Domain(GcpError::UnknownPoint(point_id.clone())))?;
        point.role = *role;
    }
    let snapshot =
        build_optimization_snapshot(params.scope, &point_definitions, &collection.observations)?;
    let snapshot_bytes = serde_json::to_vec(&snapshot)?;
    let snapshot_sha256 = ObjectHash::of_bytes(&snapshot_bytes);
    let residual_scope = build_gcp_residual_report_scope(
        &snapshot,
        collection_sha256.clone(),
        snapshot_sha256.clone(),
    )?;
    let residual_scope_bytes = serde_json::to_vec(&residual_scope)?;
    let residual_scope_sha256 = ObjectHash::of_bytes(&residual_scope_bytes);
    check_cancelled(cancellation)?;
    let snapshot_published = write_object(project_root, &snapshot_sha256, &snapshot_bytes)?;
    let scope_published =
        write_object(project_root, &residual_scope_sha256, &residual_scope_bytes)?;
    if cancellation.is_cancel_requested() {
        rollback_optional(scope_published.as_ref())?;
        rollback_optional(snapshot_published.as_ref())?;
        return Err(GcpRuntimeError::Cancelled);
    }
    let mut candidate = manifest.clone();
    touch_manifest(&mut candidate)?;
    let journal = committed_journal(
        &candidate,
        &params.operation_id,
        "PhotolabCreateGcpOptimizationSnapshot",
        serde_json::json!({
            "collectionSha256": collection_sha256,
            "snapshotSha256": snapshot_sha256,
            "residualScopeSha256": residual_scope_sha256,
        }),
        vec![group_id],
        vec![collection_sha256.clone()],
        vec![snapshot_sha256.clone(), residual_scope_sha256.clone()],
    );
    let published = [snapshot_published, scope_published]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    publish_command(project_root, &journal, &candidate, &published)?;
    *manifest = candidate;
    Ok(CreateGcpOptimizationSnapshotResult {
        operation_id: params.operation_id,
        collection_sha256,
        snapshot_sha256,
        residual_scope_sha256,
        residual_scope,
        autosave_generation: manifest.autosave_generation,
        journal_sequence: journal.sequence,
    })
}

pub fn read_gcp_collection(
    project_root: &Path,
    manifest: &PhotolabProjectManifest,
) -> Result<Option<(ObjectHash, GcpCollectionRecord)>, GcpRuntimeError> {
    let group_id = find_reference_group(manifest)?;
    let (hash, collection) = load_collection(project_root, manifest, &group_id)?;
    Ok(hash.map(|hash| (hash, collection)))
}

fn validate_reparsed_source(
    requested: &GcpCsvImportResult,
    reparsed: &GcpCsvImportResult,
) -> Result<(), GcpRuntimeError> {
    if requested.source_sha256 != reparsed.source_sha256
        || requested.source_bytes != reparsed.source_bytes
        || requested.points != reparsed.points
        || requested.mapping != reparsed.mapping
    {
        return Err(GcpRuntimeError::SourceChanged);
    }
    Ok(())
}

fn validate_transformed_points(
    source: &[GcpPoint],
    transformed: &[GcpPoint],
) -> Result<(), GcpRuntimeError> {
    validate_gcp_points(transformed)?;
    if source.len() != transformed.len() {
        return Err(GcpRuntimeError::InvalidTransformationResult(
            "point count changed",
        ));
    }
    for (source, transformed) in source.iter().zip(transformed) {
        if source.id != transformed.id
            || source.name != transformed.name
            || source.role != transformed.role
            || source.uncertainty != transformed.uncertainty
        {
            return Err(GcpRuntimeError::InvalidTransformationResult(
                "identity, role or uncertainty changed",
            ));
        }
    }
    Ok(())
}

fn validate_new_points(
    collection: &GcpCollectionRecord,
    incoming: &[GcpPoint],
) -> Result<(), GcpRuntimeError> {
    let ids = collection
        .points
        .iter()
        .map(|record| &record.point.id)
        .collect::<BTreeSet<_>>();
    let names = collection
        .points
        .iter()
        .map(|record| record.point.name.trim())
        .collect::<BTreeSet<_>>();
    if incoming
        .iter()
        .any(|point| ids.contains(&point.id) || names.contains(point.name.trim()))
    {
        return Err(GcpRuntimeError::DuplicateExistingPoint);
    }
    Ok(())
}

fn validate_transformation(
    transformation: &FrozenImportTransformation,
) -> Result<(), GcpRuntimeError> {
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
        return Err(GcpRuntimeError::InvalidCrsDecision);
    }
    validate_hash(&transformation.decision_sha256)?;
    for grid in &transformation.pipeline.grids {
        if grid.official_filename.trim().is_empty() || grid.local_path.trim().is_empty() {
            return Err(GcpRuntimeError::InvalidCrsDecision);
        }
        validate_hash(&grid.official_sha256)?;
    }
    Ok(())
}

fn prepare_gcp_manifest(
    manifest: &PhotolabProjectManifest,
    group_id: &EntityId,
    entities: Vec<EntitySnapshot>,
    collection_hash: &ObjectHash,
) -> Result<PhotolabProjectManifest, GcpRuntimeError> {
    let mut candidate = manifest.clone();
    for entity in entities {
        candidate.entities.insert(entity.id.0.clone(), entity);
    }
    let mut children = candidate
        .entities
        .values()
        .filter(|entity| {
            entity.kind == EntityKind::GroundControlPoint
                && entity.parent.as_ref() == Some(group_id)
        })
        .map(|entity| entity.id.clone())
        .collect::<Vec<_>>();
    children.sort_by(|left, right| left.0.cmp(&right.0));
    let group = candidate
        .entities
        .get_mut(&group_id.0)
        .ok_or(GcpRuntimeError::ReferenceGroupMissing)?;
    group.children = children;
    group.name = format!("Referenz & GCPs · {}", group.children.len());
    group.version_hash = collection_hash.clone();
    touch_manifest(&mut candidate)?;
    Ok(candidate)
}

fn point_entity(
    id: EntityId,
    parent: EntityId,
    point: &GcpPoint,
    version_hash: ObjectHash,
) -> EntitySnapshot {
    let coordinate = Vec3 {
        x: point.coordinate.east_meters,
        y: point.coordinate.north_meters,
        z: point.coordinate.height_meters,
    };
    EntitySnapshot {
        id,
        kind: EntityKind::GroundControlPoint,
        name: point.name.clone(),
        parent: Some(parent),
        children: vec![],
        visibility: VisibilityState::default(),
        version_hash,
        bounds: Some(Bounds3 {
            min: coordinate,
            max: coordinate,
        }),
    }
}

fn load_required_collection(
    root: &Path,
    manifest: &PhotolabProjectManifest,
    group_id: &EntityId,
) -> Result<(ObjectHash, GcpCollectionRecord), GcpRuntimeError> {
    let (hash, collection) = load_collection(root, manifest, group_id)?;
    hash.map(|hash| (hash, collection))
        .ok_or(GcpRuntimeError::CollectionMissing)
}

fn load_collection(
    root: &Path,
    manifest: &PhotolabProjectManifest,
    group_id: &EntityId,
) -> Result<(Option<ObjectHash>, GcpCollectionRecord), GcpRuntimeError> {
    let has_points = manifest.entities.values().any(|entity| {
        entity.kind == EntityKind::GroundControlPoint && entity.parent.as_ref() == Some(group_id)
    });
    if !has_points {
        return Ok((
            None,
            GcpCollectionRecord {
                schema_version: 1,
                previous_collection_sha256: None,
                points: vec![],
                observations: vec![],
            },
        ));
    }
    let group = manifest
        .entities
        .get(&group_id.0)
        .ok_or(GcpRuntimeError::ReferenceGroupMissing)?;
    validate_hash(&group.version_hash)?;
    let bytes =
        fs::read(object_path(root, &group.version_hash)).map_err(|source| GcpRuntimeError::Io {
            action: "read GCP collection",
            path: object_path(root, &group.version_hash),
            source,
        })?;
    if ObjectHash::of_bytes(&bytes) != group.version_hash {
        return Err(GcpRuntimeError::ObjectHashMismatch);
    }
    let collection: GcpCollectionRecord = serde_json::from_slice(&bytes)?;
    if collection.schema_version != 1 {
        return Err(GcpRuntimeError::UnsupportedCollectionVersion(
            collection.schema_version,
        ));
    }
    validate_gcp_points(&collection.point_definitions())?;
    let points = collection.point_definitions();
    let mut observation_keys = BTreeSet::new();
    for observation in &collection.observations {
        validate_gcp_observation(&points, observation)?;
        if !observation_keys.insert((observation.point_id.clone(), observation.image_id)) {
            return Err(GcpRuntimeError::DuplicateStoredObservation);
        }
    }
    Ok((Some(group.version_hash.clone()), collection))
}

fn update_group_revision(
    manifest: &mut PhotolabProjectManifest,
    group_id: &EntityId,
    hash: &ObjectHash,
) -> Result<(), GcpRuntimeError> {
    manifest
        .entities
        .get_mut(&group_id.0)
        .ok_or(GcpRuntimeError::ReferenceGroupMissing)?
        .version_hash = hash.clone();
    Ok(())
}

fn require_expected_hash(
    expected: &ObjectHash,
    actual: &ObjectHash,
) -> Result<(), GcpRuntimeError> {
    validate_hash(expected)?;
    if expected == actual {
        Ok(())
    } else {
        Err(GcpRuntimeError::RevisionConflict {
            expected: expected.clone(),
            actual: actual.clone(),
        })
    }
}

fn find_reference_group(manifest: &PhotolabProjectManifest) -> Result<EntityId, GcpRuntimeError> {
    let mut groups = manifest
        .entities
        .values()
        .filter(|entity| {
            entity.kind == EntityKind::Group && entity.name.starts_with("Referenz & GCPs")
        })
        .map(|entity| entity.id.clone());
    let group = groups
        .next()
        .ok_or(GcpRuntimeError::ReferenceGroupMissing)?;
    if groups.next().is_some() {
        return Err(GcpRuntimeError::MultipleReferenceGroups);
    }
    Ok(group)
}

fn gcp_entity_id(project_id: &str, point_id: &str) -> EntityId {
    EntityId(format!(
        "{project_id}:gcp:{}",
        ObjectHash::of_bytes(point_id.as_bytes()).as_str()
    ))
}

fn create_staging(root: &Path, operation_id: &str) -> Result<StagingGuard, GcpRuntimeError> {
    let path = root.join("tmp").join(format!(
        "gcp-{}-{}",
        safe_component(operation_id),
        OPERATION_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(path.join("objects")).map_err(|source| GcpRuntimeError::Io {
        action: "create GCP staging",
        path: path.clone(),
        source,
    })?;
    Ok(StagingGuard { path })
}

fn stage_source_csv(
    source: &Path,
    staging_root: &Path,
    expected_hash: &ObjectHash,
    expected_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<ObjectHash, GcpRuntimeError> {
    let staged = object_path(staging_root, expected_hash);
    create_parent(&staged)?;
    let mut input = File::open(source).map_err(|source_error| GcpRuntimeError::Io {
        action: "open GCP CSV",
        path: source.to_path_buf(),
        source: source_error,
    })?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staged)
        .map_err(|source_error| GcpRuntimeError::Io {
            action: "create staged GCP CSV",
            path: staged.clone(),
            source: source_error,
        })?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES].into_boxed_slice();
    let mut hasher = Sha256::new();
    let mut byte_count = 0_u64;
    loop {
        check_cancelled(cancellation)?;
        let read = input
            .read(&mut buffer)
            .map_err(|source_error| GcpRuntimeError::Io {
                action: "read GCP CSV",
                path: source.to_path_buf(),
                source: source_error,
            })?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|source_error| GcpRuntimeError::Io {
                action: "write staged GCP CSV",
                path: staged.clone(),
                source: source_error,
            })?;
        hasher.update(&buffer[..read]);
        byte_count = byte_count.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
    }
    output
        .sync_all()
        .map_err(|source_error| GcpRuntimeError::Io {
            action: "sync staged GCP CSV",
            path: staged,
            source: source_error,
        })?;
    let observed = ObjectHash(hex::encode(hasher.finalize()));
    if &observed != expected_hash || byte_count != expected_bytes {
        return Err(GcpRuntimeError::SourceChanged);
    }
    Ok(observed)
}

fn stage_bytes(root: &Path, bytes: &[u8]) -> Result<ObjectHash, GcpRuntimeError> {
    let hash = ObjectHash::of_bytes(bytes);
    let path = object_path(root, &hash);
    create_parent(&path)?;
    atomic_write_bytes(&path, bytes)?;
    Ok(hash)
}

fn publish_objects(root: &Path, staging: &Path) -> Result<Vec<PathBuf>, GcpRuntimeError> {
    let object_root = staging.join("objects");
    let mut files = Vec::new();
    collect_files(&object_root, &mut files)?;
    files.sort();
    let mut published = Vec::new();
    for source in files {
        let relative = source
            .strip_prefix(&object_root)
            .map_err(|_| GcpRuntimeError::InvalidProjectPath)?;
        let destination = root.join("objects").join(relative);
        if destination.is_file() {
            continue;
        }
        create_parent(&destination)?;
        fs::rename(&source, &destination).map_err(|error| GcpRuntimeError::Io {
            action: "publish GCP object",
            path: destination.clone(),
            source: error,
        })?;
        published.push(destination);
    }
    sync_directory(&root.join("objects"))?;
    Ok(published)
}

fn collect_files(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), GcpRuntimeError> {
    for entry in fs::read_dir(directory).map_err(|source| GcpRuntimeError::Io {
        action: "read staged object directory",
        path: directory.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| GcpRuntimeError::Io {
            action: "read staged object entry",
            path: directory.to_path_buf(),
            source,
        })?;
        let file_type = entry.file_type().map_err(|source| GcpRuntimeError::Io {
            action: "inspect staged object",
            path: entry.path(),
            source,
        })?;
        if file_type.is_dir() {
            collect_files(&entry.path(), output)?;
        } else if file_type.is_file() {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn write_object(
    root: &Path,
    hash: &ObjectHash,
    bytes: &[u8],
) -> Result<Option<PathBuf>, GcpRuntimeError> {
    let path = object_path(root, hash);
    if path.is_file() {
        return Ok(None);
    }
    create_parent(&path)?;
    atomic_write_bytes(&path, bytes)?;
    Ok(Some(path))
}

fn rollback_published(paths: &[PathBuf]) -> Result<(), GcpRuntimeError> {
    for path in paths.iter().rev() {
        rollback_optional(Some(path))?;
    }
    Ok(())
}

fn rollback_optional(path: Option<&PathBuf>) -> Result<(), GcpRuntimeError> {
    if let Some(path) = path {
        if path.is_file() {
            fs::remove_file(path).map_err(|source| GcpRuntimeError::Io {
                action: "roll back GCP object",
                path: path.clone(),
                source,
            })?;
        }
    }
    Ok(())
}

fn committed_journal(
    manifest: &PhotolabProjectManifest,
    operation_id: &str,
    command_kind: &str,
    payload: serde_json::Value,
    affected_entities: Vec<EntityId>,
    before_refs: Vec<ObjectHash>,
    after_refs: Vec<ObjectHash>,
) -> PhotolabJournalEntry {
    PhotolabJournalEntry {
        sequence: manifest.command_sequence,
        command_id: operation_id.to_owned(),
        command_kind: command_kind.to_owned(),
        timestamp_unix_ms: manifest.modified_unix_ms,
        state: JournalCommandState::Committed,
        payload,
        affected_entities,
        before_refs,
        after_refs,
        message: Some("GCP command committed atomically".into()),
    }
}

fn touch_manifest(manifest: &mut PhotolabProjectManifest) -> Result<(), GcpRuntimeError> {
    manifest.autosave_generation = manifest.autosave_generation.saturating_add(1);
    manifest.command_sequence = manifest.command_sequence.saturating_add(1);
    manifest.modified_unix_ms = unix_ms()?;
    manifest.clean_shutdown = false;
    Ok(())
}

fn write_journal(root: &Path, entry: &PhotolabJournalEntry) -> Result<(), GcpRuntimeError> {
    let path = root
        .join("journal")
        .join(format!("{:016}.json", entry.sequence));
    if path.exists() {
        return Err(GcpRuntimeError::JournalSequenceCollision(entry.sequence));
    }
    atomic_write_json(&path, entry)
}

fn publish_command(
    root: &Path,
    journal: &PhotolabJournalEntry,
    manifest: &PhotolabProjectManifest,
    newly_published_objects: &[PathBuf],
) -> Result<(), GcpRuntimeError> {
    if let Err(error) = write_journal(root, journal) {
        rollback_published(newly_published_objects)?;
        return Err(error);
    }
    if let Err(error) = atomic_write_json(&root.join("manifest.json"), manifest) {
        let journal_path = root
            .join("journal")
            .join(format!("{:016}.json", journal.sequence));
        if journal_path.is_file() {
            fs::remove_file(&journal_path).map_err(|source| GcpRuntimeError::Io {
                action: "roll back GCP journal",
                path: journal_path,
                source,
            })?;
            sync_directory(&root.join("journal"))?;
        }
        rollback_published(newly_published_objects)?;
        return Err(error);
    }
    Ok(())
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), GcpRuntimeError> {
    atomic_write_bytes(path, &serde_json::to_vec_pretty(value)?)
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), GcpRuntimeError> {
    let parent = path.parent().ok_or(GcpRuntimeError::InvalidProjectPath)?;
    fs::create_dir_all(parent).map_err(|source| GcpRuntimeError::Io {
        action: "create atomic write parent",
        path: parent.to_path_buf(),
        source,
    })?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("gcp"),
        OPERATION_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(source) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(GcpRuntimeError::Io {
            action: "write atomic GCP file",
            path: temporary,
            source,
        });
    }
    fs::rename(&temporary, path).map_err(|source| GcpRuntimeError::Io {
        action: "publish atomic GCP file",
        path: path.to_path_buf(),
        source,
    })?;
    sync_directory(parent)
}

fn object_path(root: &Path, hash: &ObjectHash) -> PathBuf {
    let (prefix, remainder) = hash.as_str().split_at(2);
    root.join("objects").join(prefix).join(remainder)
}

fn create_parent(path: &Path) -> Result<(), GcpRuntimeError> {
    let parent = path.parent().ok_or(GcpRuntimeError::InvalidProjectPath)?;
    fs::create_dir_all(parent).map_err(|source| GcpRuntimeError::Io {
        action: "create GCP object parent",
        path: parent.to_path_buf(),
        source,
    })
}

fn sync_directory(path: &Path) -> Result<(), GcpRuntimeError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| GcpRuntimeError::Io {
            action: "sync GCP directory",
            path: path.to_path_buf(),
            source,
        })
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

fn validate_operation_id(value: &str) -> Result<(), GcpRuntimeError> {
    if value.trim().is_empty() || value.len() > 128 {
        Err(GcpRuntimeError::InvalidOperationId)
    } else {
        Ok(())
    }
}

fn validate_hash(hash: &ObjectHash) -> Result<(), GcpRuntimeError> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(GcpRuntimeError::InvalidHash)
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), GcpRuntimeError> {
    if cancellation.is_cancel_requested() {
        Err(GcpRuntimeError::Cancelled)
    } else {
        Ok(())
    }
}

fn unix_ms() -> Result<u64, GcpRuntimeError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| GcpRuntimeError::Clock)?;
    u64::try_from(duration.as_millis()).map_err(|_| GcpRuntimeError::Clock)
}

struct StagingGuard {
    path: PathBuf,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug, Error)]
pub enum GcpRuntimeError {
    #[error("invalid GCP operation id")]
    InvalidOperationId,
    #[error("GCP operation cancelled")]
    Cancelled,
    #[error("explicit frozen CRS decision is missing or invalid")]
    InvalidCrsDecision,
    #[error("GCP target CRS/height frame differs from the established project reference frame")]
    ProjectReferenceMismatch,
    #[error("invalid content hash")]
    InvalidHash,
    #[error("GCP CSV changed after preview")]
    SourceChanged,
    #[error("transformed GCP result is invalid: {0}")]
    InvalidTransformationResult(&'static str),
    #[error("GCP id or name already exists in this collection")]
    DuplicateExistingPoint,
    #[error("Photolab reference group is missing")]
    ReferenceGroupMissing,
    #[error("Photolab manifest has multiple reference groups")]
    MultipleReferenceGroups,
    #[error("no committed GCP collection exists")]
    CollectionMissing,
    #[error("GCP collection schema version {0} is unsupported")]
    UnsupportedCollectionVersion(u32),
    #[error("GCP collection object hash does not match its content")]
    ObjectHashMismatch,
    #[error("GCP collection contains a duplicate stored observation")]
    DuplicateStoredObservation,
    #[error("the requested GCP observation does not exist")]
    ObservationMissing,
    #[error("the requested GCP observation is not blocked")]
    ObservationNotBlocked,
    #[error("the immutable GCP collection revision chain contains a cycle")]
    CollectionRevisionCycle,
    #[error("GCP observation batch cannot be empty")]
    EmptyObservationBatch,
    #[error("GCP observation batch contains a duplicate point/image key")]
    DuplicateIncomingObservation,
    #[error("GCP revision conflict: expected {expected:?}, actual {actual:?}")]
    RevisionConflict {
        expected: ObjectHash,
        actual: ObjectHash,
    },
    #[error("journal sequence {0} already exists")]
    JournalSequenceCollision(u64),
    #[error("invalid project path")]
    InvalidProjectPath,
    #[error("system clock cannot produce a project timestamp")]
    Clock,
    #[error("GCP import failed: {0}")]
    Import(#[from] GcpCsvImportError),
    #[error("GCP validation failed: {0}")]
    Domain(#[from] himmelcad_core::photolab_gcp::GcpError),
    #[error("GCP serialization failed: {0}")]
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
    use std::sync::atomic::{AtomicU64, Ordering};

    use himmelcad_core::photolab_crs::{
        CrsDatabaseVersions, CrsDefinition, CrsWithEpoch, FrozenCrsEndpoint,
        FrozenOperationPipeline, GeographicArea, HeightReference, OperationSelectionPolicy,
        VerticalOperationMode,
    };
    use himmelcad_core::photolab_gcp::{
        CsvColumnSelector, CsvDecimalSeparator, GcpCsvImportMapping, GcpObservationState, GcpRole,
        GcpUncertainty, ImageCoordinate,
    };
    use himmelcad_core::photolab_matching::ImageId;
    use himmelcad_core::photolab_project::initial_photolab_manifest;
    use himmelcad_io::gcp_import::import_gcp_csv_file;

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        csv: PathBuf,
        manifest: PhotolabProjectManifest,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "himmelcad-gcp-runtime-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            for child in ["objects", "journal", "tmp"] {
                fs::create_dir_all(root.join(child)).expect("project layout");
            }
            let csv = root.join("gcps.csv");
            fs::write(
                &csv,
                "Name;Ost;Nord;Höhe;Rolle\nA;500000,0;5400000,0;400,0;control_xyz\nB;500010,0;5400010,0;401,0;checkpoint_z\n",
            )
            .expect("CSV fixture");
            let manifest = initial_photolab_manifest("test-project".into(), "Test".into(), 1);
            Self {
                root,
                csv,
                manifest,
            }
        }

        fn import(&self) -> GcpCsvImportResult {
            import_gcp_csv_file(&self.csv, mapping()).expect("CSV import")
        }

        fn commit(&mut self) -> CommitGcpsResult {
            let source_import = self.import();
            commit_gcps_transaction(
                &self.root,
                &mut self.manifest,
                CommitGcpsParams {
                    operation_id: "commit-gcps".into(),
                    transformed_points: source_import.points.clone(),
                    source_import,
                    transformation: transformation(),
                },
                &CancellationToken::new(),
            )
            .expect("GCP commit")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn mapping() -> GcpCsvImportMapping {
        GcpCsvImportMapping {
            delimiter: ';',
            decimal_separator: CsvDecimalSeparator::Comma,
            has_header: true,
            name: CsvColumnSelector::Header("Name".into()),
            east: CsvColumnSelector::Header("Ost".into()),
            north: CsvColumnSelector::Header("Nord".into()),
            height: CsvColumnSelector::Header("Höhe".into()),
            horizontal_stddev: None,
            height_stddev: None,
            role: Some(CsvColumnSelector::Header("Rolle".into())),
            default_role: GcpRole::ControlXyz,
            default_uncertainty: GcpUncertainty {
                horizontal_stddev_meters: 0.01,
                height_stddev_meters: 0.02,
            },
        }
    }

    fn transformation() -> FrozenImportTransformation {
        FrozenImportTransformation {
            schema_version: 1,
            original: FrozenCrsEndpoint {
                horizontal: CrsWithEpoch {
                    crs: CrsDefinition::Epsg(4326),
                    coordinate_epoch: None,
                },
                vertical: HeightReference::Ellipsoidal,
            },
            target: FrozenCrsEndpoint {
                horizontal: CrsWithEpoch {
                    crs: CrsDefinition::Epsg(25832),
                    coordinate_epoch: None,
                },
                vertical: HeightReference::Orthometric {
                    vertical_crs: CrsDefinition::Epsg(7837),
                },
            },
            vertical_mode: VerticalOperationMode::Transform,
            area_of_interest: GeographicArea {
                west_longitude: 9.0,
                south_latitude: 48.0,
                east_longitude: 10.0,
                north_latitude: 49.0,
            },
            pipeline: FrozenOperationPipeline {
                operation_id: "fixture-operation".into(),
                operation_name: "Fixture".into(),
                proj_pipeline: "+proj=pipeline +step +proj=utm +zone=32".into(),
                expected_accuracy_mm: Some(10.0),
                ballpark: false,
                selection_policy: OperationSelectionPolicy::default(),
                grids: vec![],
            },
            database_versions: CrsDatabaseVersions {
                proj_version: "9.4.0".into(),
                epsg_database_version: "v11.004".into(),
            },
            decision_sha256: ObjectHash::of_bytes(b"decision"),
        }
    }

    fn manual(point: &str, image: u32, x: f64) -> GcpObservation {
        GcpObservation {
            point_id: himmelcad_core::photolab_gcp::GcpPointId(point.into()),
            image_id: ImageId(image),
            state: GcpObservationState::Manual {
                coordinate: ImageCoordinate {
                    x_pixels: x,
                    y_pixels: 200.0,
                },
            },
        }
    }

    #[test]
    fn commit_publishes_entities_collection_source_and_journal() {
        let mut fixture = Fixture::new();
        let result = fixture.commit();
        assert_eq!(result.points.len(), 2);
        assert_eq!(fixture.manifest.autosave_generation, 1);
        assert_eq!(fixture.manifest.command_sequence, 1);
        assert_eq!(
            fixture
                .manifest
                .entities
                .values()
                .filter(|entity| entity.kind == EntityKind::GroundControlPoint)
                .count(),
            2
        );
        assert!(object_path(&fixture.root, &result.source_csv_sha256).is_file());
        assert!(object_path(&fixture.root, &result.collection_sha256).is_file());
        assert!(fixture.root.join("journal/0000000000000001.json").is_file());
        let (_, collection) = read_gcp_collection(&fixture.root, &fixture.manifest)
            .expect("read collection")
            .expect("collection");
        assert_eq!(collection.points.len(), 2);
    }

    #[test]
    fn cancelled_import_does_not_mutate_manifest() {
        let mut fixture = Fixture::new();
        let source_import = fixture.import();
        let before = fixture.manifest.clone();
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let error = commit_gcps_transaction(
            &fixture.root,
            &mut fixture.manifest,
            CommitGcpsParams {
                operation_id: "cancel".into(),
                transformed_points: source_import.points.clone(),
                source_import,
                transformation: transformation(),
            },
            &cancellation,
        )
        .expect_err("cancelled");
        assert!(matches!(error, GcpRuntimeError::Cancelled));
        assert_eq!(fixture.manifest, before);
    }

    #[test]
    fn source_change_after_preview_is_rejected() {
        let mut fixture = Fixture::new();
        let source_import = fixture.import();
        fs::write(
            &fixture.csv,
            "Name;Ost;Nord;Höhe;Rolle\nC;1,0;2,0;3,0;disabled\n",
        )
        .expect("change source");
        let transformed_points = source_import.points.clone();
        let error = commit_gcps_transaction(
            &fixture.root,
            &mut fixture.manifest,
            CommitGcpsParams {
                operation_id: "changed".into(),
                source_import,
                transformed_points,
                transformation: transformation(),
            },
            &CancellationToken::new(),
        )
        .expect_err("changed source");
        assert!(matches!(error, GcpRuntimeError::SourceChanged));
    }

    #[test]
    fn journal_collision_rolls_back_new_objects_and_manifest() {
        let mut fixture = Fixture::new();
        let source_import = fixture.import();
        let source_hash = source_import.source_sha256.clone();
        let before = fixture.manifest.clone();
        fs::write(
            fixture.root.join("journal/0000000000000001.json"),
            b"occupied",
        )
        .expect("occupied journal sequence");
        let error = commit_gcps_transaction(
            &fixture.root,
            &mut fixture.manifest,
            CommitGcpsParams {
                operation_id: "collision".into(),
                transformed_points: source_import.points.clone(),
                source_import,
                transformation: transformation(),
            },
            &CancellationToken::new(),
        )
        .expect_err("journal collision");
        assert!(matches!(
            error,
            GcpRuntimeError::JournalSequenceCollision(1)
        ));
        assert_eq!(fixture.manifest, before);
        assert!(!object_path(&fixture.root, &source_hash).exists());
    }

    #[test]
    fn observation_upsert_supports_predicted_and_replacement() {
        let mut fixture = Fixture::new();
        let committed = fixture.commit();
        let predicted = GcpObservation {
            point_id: himmelcad_core::photolab_gcp::GcpPointId("A".into()),
            image_id: ImageId(1),
            state: GcpObservationState::Predicted {
                coordinate: ImageCoordinate {
                    x_pixels: 100.0,
                    y_pixels: 200.0,
                },
                confidence_per_mille: 800,
                source: "tie-point projection".into(),
            },
        };
        let first = upsert_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationParams {
                operation_id: "predict".into(),
                expected_collection_sha256: committed.collection_sha256,
                observation: predicted,
            },
            &CancellationToken::new(),
        )
        .expect("prediction");
        assert!(!first.replaced_existing);
        let second = upsert_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationParams {
                operation_id: "manual".into(),
                expected_collection_sha256: first.collection_sha256,
                observation: manual("A", 1, 101.0),
            },
            &CancellationToken::new(),
        )
        .expect("manual replacement");
        assert!(second.replaced_existing);
    }

    #[test]
    fn observation_edits_restore_the_immutable_pre_block_revision() {
        let mut fixture = Fixture::new();
        let committed = fixture.commit();
        let manual_result = upsert_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationParams {
                operation_id: "manual-before-block".into(),
                expected_collection_sha256: committed.collection_sha256,
                observation: manual("A", 1, 101.0),
            },
            &CancellationToken::new(),
        )
        .expect("manual observation");
        let blocked = edit_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            EditGcpObservationParams {
                operation_id: "block-observation".into(),
                expected_collection_sha256: manual_result.collection_sha256,
                point_id: GcpPointId("A".into()),
                image_id: ImageId(1),
                edit: GcpObservationEdit::Block {
                    coordinate: ImageCoordinate {
                        x_pixels: 101.0,
                        y_pixels: 200.0,
                    },
                    reason: "Excluded by user".into(),
                },
            },
            &CancellationToken::new(),
        )
        .expect("block observation");
        let unblocked = edit_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            EditGcpObservationParams {
                operation_id: "unblock-observation".into(),
                expected_collection_sha256: blocked.collection_sha256,
                point_id: GcpPointId("A".into()),
                image_id: ImageId(1),
                edit: GcpObservationEdit::Unblock,
            },
            &CancellationToken::new(),
        )
        .expect("unblock observation");
        assert!(matches!(
            unblocked.restored_state,
            Some(GcpObservationState::Manual { coordinate })
                if coordinate.x_pixels == 101.0 && coordinate.y_pixels == 200.0
        ));
        let (_, collection) = read_gcp_collection(&fixture.root, &fixture.manifest)
            .expect("read collection")
            .expect("collection");
        assert!(matches!(
            collection.observations.as_slice(),
            [GcpObservation {
                state: GcpObservationState::Manual { .. },
                ..
            }]
        ));
    }

    #[test]
    fn propagated_batch_is_atomic_and_preserves_manual_measurements() {
        let mut fixture = Fixture::new();
        let committed = fixture.commit();
        let first = upsert_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationParams {
                operation_id: "manual-seed".into(),
                expected_collection_sha256: committed.collection_sha256,
                observation: manual("A", 2, 111.0),
            },
            &CancellationToken::new(),
        )
        .expect("manual");
        let automatic = |image, x| GcpObservation {
            point_id: himmelcad_core::photolab_gcp::GcpPointId("A".into()),
            image_id: ImageId(image),
            state: GcpObservationState::Automatic {
                coordinate: ImageCoordinate {
                    x_pixels: x,
                    y_pixels: 200.0,
                },
                confidence_per_mille: 900,
            },
        };
        let result = upsert_gcp_observations_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationsParams {
                operation_id: "track-7".into(),
                expected_collection_sha256: first.collection_sha256,
                observations: vec![automatic(2, 222.0), automatic(3, 333.0)],
                preserve_manual: true,
            },
            &CancellationToken::new(),
        )
        .expect("batch");
        assert_eq!(result.inserted_count, 1);
        assert_eq!(result.replaced_count, 0);
        assert_eq!(result.preserved_manual_count, 1);
        assert_eq!(fixture.manifest.command_sequence, 3);
        let (_, collection) = read_gcp_collection(&fixture.root, &fixture.manifest)
            .expect("read")
            .expect("collection");
        assert!(matches!(
            &collection
                .observations
                .iter()
                .find(|value| value.image_id == ImageId(2))
                .expect("manual")
                .state,
            GcpObservationState::Manual { .. }
        ));
        assert!(matches!(
            &collection
                .observations
                .iter()
                .find(|value| value.image_id == ImageId(3))
                .expect("automatic")
                .state,
            GcpObservationState::Automatic { .. }
        ));
    }

    #[test]
    fn optimization_snapshot_returns_exact_residual_scope() {
        let mut fixture = Fixture::new();
        let committed = fixture.commit();
        let first = upsert_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationParams {
                operation_id: "obs-1".into(),
                expected_collection_sha256: committed.collection_sha256,
                observation: manual("A", 1, 100.0),
            },
            &CancellationToken::new(),
        )
        .expect("first observation");
        let second = upsert_gcp_observation_transaction(
            &fixture.root,
            &mut fixture.manifest,
            UpsertGcpObservationParams {
                operation_id: "obs-2".into(),
                expected_collection_sha256: first.collection_sha256,
                observation: manual("A", 2, 110.0),
            },
            &CancellationToken::new(),
        )
        .expect("second observation");
        let result = create_gcp_optimization_snapshot_transaction(
            &fixture.root,
            &mut fixture.manifest,
            CreateGcpOptimizationSnapshotParams {
                operation_id: "snapshot".into(),
                expected_collection_sha256: second.collection_sha256,
                scope: GcpOptimizationScope {
                    label: "Control A only".into(),
                    point_ids: vec![himmelcad_core::photolab_gcp::GcpPointId("A".into())],
                    camera_reference_image_ids: vec![],
                },
                role_overrides: BTreeMap::new(),
            },
            &CancellationToken::new(),
        )
        .expect("snapshot");
        assert_eq!(result.residual_scope.control_point_ids.len(), 1);
        assert!(result.residual_scope.checkpoint_point_ids.is_empty());
        assert!(object_path(&fixture.root, &result.snapshot_sha256).is_file());
        assert!(object_path(&fixture.root, &result.residual_scope_sha256).is_file());
    }
}
