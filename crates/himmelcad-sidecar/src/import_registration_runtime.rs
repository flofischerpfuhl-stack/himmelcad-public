//! Host-side lifecycle for interactive registration of staged canonical imports.

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use himmelcad_core::{
    photolab_jobs::CancellationToken,
    registration::{
        fit_point_pairs_3d, fit_translation_point_pairs_3d, origin_and_project_north_transform,
        run_icp, IcpMode, IcpOptions, RegistrationError, RegistrationMethod, RegistrationPhase,
        RegistrationPointPair, RegistrationPreview, RegistrationRecipe, RegistrationTargetSample,
    },
    transform::{apply_similarity_3d, residual_report, Similarity3D, WorldPoint},
};
use himmelcad_io::{apply_registration_preview, CanonicalStagedImport};
use himmelcad_render::{
    BoundingVolume, DatasetId, HierarchySource, PotreeHierarchySource, WorldVec3,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_STAGED_RESOURCE_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_STAGED_RESOURCE_REQUESTS: u32 = 100_000;
const MAX_REGISTRATION_SAMPLE_NODE_BYTES: u64 = 16 * 1024 * 1024;

/// Path-free session state safe to expose to product UIs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRegistrationState {
    pub schema_version: u32,
    pub session_id: String,
    pub command_id: String,
    pub recipe: RegistrationRecipe,
    pub phase: RegistrationPhase,
    pub source_entity_count: u32,
    /// Path-free canonical preview. Product hosts may render inline geometry before commit.
    pub source_preview: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<RegistrationPreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One opaque, verified artifact descriptor. No host path crosses this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedResourceDescriptor {
    pub resource_id: String,
    pub relative_path: String,
    pub object_hash: String,
    pub media_type: String,
    pub byte_length: u64,
}

/// One prepared dataset available through the ephemeral registration capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedDatasetDescriptor {
    pub dataset_id: String,
    pub format_id: String,
    pub entity_id: String,
    pub representation_slot: String,
    pub root_resource_id: String,
    pub artifacts: Vec<StagedResourceDescriptor>,
}

/// One non-streamed resource set available during the reviewed preview only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedResourceSetDescriptor {
    pub resource_set_id: String,
    pub resources: Vec<StagedResourceDescriptor>,
}

/// Path-free capability inventory owned by one live registration session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedResourceInventory {
    pub schema_version: u32,
    pub session_id: String,
    pub capability: String,
    pub maximum_read_bytes: u64,
    pub datasets: Vec<StagedDatasetDescriptor>,
    pub resource_sets: Vec<StagedResourceSetDescriptor>,
}

/// One bounded resource read returned to the Electron protocol host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedResourceRead {
    pub schema_version: u32,
    pub resource_id: String,
    pub object_hash: String,
    pub media_type: String,
    pub offset: u64,
    pub byte_length: u64,
    pub total_byte_length: u64,
    pub bytes_base64: String,
}

/// Deterministic source samples and immutable provenance for reviewed ICP.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationSourceSamples {
    pub schema_version: u32,
    pub session_id: String,
    pub dataset_id: String,
    pub sampling_method: String,
    pub source_transform: Option<himmelcad_core::entity_model::Transform3d>,
    pub resource_hashes: Vec<String>,
    pub points: Vec<WorldPoint>,
}

#[derive(Debug, Clone)]
struct VerifiedStagedResource {
    descriptor: StagedResourceDescriptor,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct VerifiedStagedResources {
    inventory: StagedResourceInventory,
    resources: BTreeMap<String, VerifiedStagedResource>,
}

#[derive(Debug)]
struct Session {
    state: ImportRegistrationState,
    staged: Option<CanonicalStagedImport>,
    scratch_root: PathBuf,
    cancellation: CancellationToken,
    resource_capability: String,
    verified_resources: Option<VerifiedStagedResources>,
    resource_requests: u32,
}

/// Thread-safe registration-session owner shared by Builder and PhotoLab hosts.
#[derive(Debug, Default)]
pub struct ImportRegistrationRuntime {
    sessions: Mutex<BTreeMap<String, Session>>,
}

impl ImportRegistrationRuntime {
    /// Takes ownership of a provider-staged import. Nothing is published yet.
    pub fn begin(
        &self,
        session_id: String,
        command_id: String,
        recipe: RegistrationRecipe,
        staged: CanonicalStagedImport,
        scratch_root: PathBuf,
    ) -> Result<ImportRegistrationState, ImportRegistrationRuntimeError> {
        validate_identity(&session_id)?;
        validate_identity(&command_id)?;
        recipe.validate()?;
        staged.validate()?;
        let source_entity_count = u32::try_from(staged.package.admissions.len())
            .map_err(|_| ImportRegistrationRuntimeError::TooManyEntities)?;
        let (phase, preview) = automatic_preview(&recipe)?;
        let resource_capability =
            create_resource_capability(&session_id, &command_id, &scratch_root);
        let state = ImportRegistrationState {
            schema_version: 1,
            session_id: session_id.clone(),
            command_id,
            recipe,
            phase,
            source_entity_count,
            source_preview: serde_json::to_value(&staged.package)
                .map_err(|_| ImportRegistrationRuntimeError::InvalidPreview)?,
            preview,
            message: None,
        };
        let session = Session {
            state: state.clone(),
            staged: Some(staged),
            scratch_root,
            cancellation: CancellationToken::new(),
            resource_capability,
            verified_resources: None,
            resource_requests: 0,
        };
        let mut sessions = self
            .sessions
            .lock()
            .expect("registration sessions poisoned");
        match sessions.entry(session_id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(session);
            }
            std::collections::btree_map::Entry::Occupied(_) => {
                return Err(ImportRegistrationRuntimeError::DuplicateSession);
            }
        }
        Ok(state)
    }

    /// Reads one path-free session snapshot.
    pub fn state(
        &self,
        session_id: &str,
    ) -> Result<ImportRegistrationState, ImportRegistrationRuntimeError> {
        self.sessions
            .lock()
            .expect("registration sessions poisoned")
            .get(session_id)
            .map(|session| session.state.clone())
            .ok_or(ImportRegistrationRuntimeError::UnknownSession)
    }

    /// Hash-verifies and publishes an opaque descriptor inventory for one live session.
    /// Verification happens outside the session mutex so cancellation remains observable.
    pub fn describe_resources(
        &self,
        session_id: &str,
    ) -> Result<StagedResourceInventory, ImportRegistrationRuntimeError> {
        let (capability, staged, cancellation) = {
            let sessions = self
                .sessions
                .lock()
                .expect("registration sessions poisoned");
            let session = sessions
                .get(session_id)
                .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
            if let Some(verified) = &session.verified_resources {
                return Ok(verified.inventory.clone());
            }
            (
                session.resource_capability.clone(),
                session
                    .staged
                    .clone()
                    .ok_or(ImportRegistrationRuntimeError::NotReady)?,
                session.cancellation.clone(),
            )
        };
        let verified = verify_staged_resources(session_id, &capability, &staged, &cancellation)?;
        let inventory = verified.inventory.clone();
        let mut sessions = self
            .sessions
            .lock()
            .expect("registration sessions poisoned");
        let session = sessions
            .get_mut(session_id)
            .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
        if session.resource_capability != capability || session.cancellation.is_cancel_requested() {
            return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
        }
        session.verified_resources = Some(verified);
        Ok(inventory)
    }

    /// Reads one bounded range through a verified, session-bound opaque capability.
    pub fn read_resource(
        &self,
        session_id: &str,
        capability: &str,
        resource_id: &str,
        offset: u64,
        byte_length: u64,
    ) -> Result<StagedResourceRead, ImportRegistrationRuntimeError> {
        if byte_length == 0 || byte_length > MAX_STAGED_RESOURCE_READ_BYTES {
            return Err(ImportRegistrationRuntimeError::ResourceReadTooLarge);
        }
        let (resource, cancellation) = {
            let mut sessions = self
                .sessions
                .lock()
                .expect("registration sessions poisoned");
            let session = sessions
                .get_mut(session_id)
                .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
            if session.resource_capability != capability
                || session.cancellation.is_cancel_requested()
            {
                return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
            }
            session.resource_requests = session.resource_requests.saturating_add(1);
            if session.resource_requests > MAX_STAGED_RESOURCE_REQUESTS {
                return Err(ImportRegistrationRuntimeError::ResourceRequestLimit);
            }
            let verified = session
                .verified_resources
                .as_ref()
                .ok_or(ImportRegistrationRuntimeError::ResourcesNotVerified)?;
            let resource = verified
                .resources
                .get(resource_id)
                .cloned()
                .ok_or(ImportRegistrationRuntimeError::UnknownResource)?;
            (resource, session.cancellation.clone())
        };
        let end = offset
            .checked_add(byte_length)
            .ok_or(ImportRegistrationRuntimeError::InvalidResourceRange)?;
        if end > resource.descriptor.byte_length {
            return Err(ImportRegistrationRuntimeError::InvalidResourceRange);
        }
        let metadata = fs::metadata(&resource.path)?;
        if !metadata.is_file() || metadata.len() != resource.descriptor.byte_length {
            return Err(ImportRegistrationRuntimeError::ResourceChanged);
        }
        let mut file = fs::File::open(&resource.path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![
            0_u8;
            usize::try_from(byte_length).map_err(|_| {
                ImportRegistrationRuntimeError::ResourceReadTooLarge
            })?
        ];
        let mut read = 0;
        while read < bytes.len() {
            if cancellation.is_cancel_requested() {
                return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
            }
            let count = file.read(&mut bytes[read..])?;
            if count == 0 {
                return Err(ImportRegistrationRuntimeError::ResourceChanged);
            }
            read += count;
        }
        Ok(StagedResourceRead {
            schema_version: 1,
            resource_id: resource.descriptor.resource_id,
            object_hash: resource.descriptor.object_hash,
            media_type: resource.descriptor.media_type,
            offset,
            byte_length,
            total_byte_length: resource.descriptor.byte_length,
            bytes_base64: encode_base64(&bytes),
        })
    }

    /// Extracts deterministic bounded samples from the additive Potree root node.
    /// The root is already a spatially representative coarse sample in Potree 2.
    pub fn source_samples(
        &self,
        session_id: &str,
        maximum_samples: usize,
    ) -> Result<RegistrationSourceSamples, ImportRegistrationRuntimeError> {
        if !(3..=himmelcad_core::registration::MAX_ICP_SAMPLES_PER_CLOUD).contains(&maximum_samples)
        {
            return Err(ImportRegistrationRuntimeError::InvalidSampleLimit);
        }
        let (dataset, verified, placement, cancellation) = {
            let sessions = self
                .sessions
                .lock()
                .expect("registration sessions poisoned");
            let session = sessions
                .get(session_id)
                .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
            if session.cancellation.is_cancel_requested() {
                return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
            }
            let staged = session
                .staged
                .as_ref()
                .ok_or(ImportRegistrationRuntimeError::NotReady)?;
            let dataset = staged
                .package
                .datasets
                .iter()
                .find(|dataset| dataset.format_id == "potree@2")
                .cloned()
                .ok_or(ImportRegistrationRuntimeError::UnsupportedSampleDataset)?;
            let placement = staged
                .package
                .admissions
                .iter()
                .find(|admission| {
                    admission.entity.id.0 == dataset.entity_id
                        && admission.representation_slot == dataset.representation_slot
                })
                .and_then(|admission| admission.entity.placement);
            (
                dataset,
                session
                    .verified_resources
                    .clone()
                    .ok_or(ImportRegistrationRuntimeError::ResourcesNotVerified)?,
                placement,
                session.cancellation.clone(),
            )
        };
        sample_potree_root(
            session_id,
            &dataset.dataset_id,
            &dataset.root_metadata.object_hash.0,
            placement,
            maximum_samples,
            &verified,
            &cancellation,
        )
    }

    /// Replaces all transient point pairs and computes a reviewed preview.
    pub fn preview_point_pairs(
        &self,
        session_id: &str,
        pairs: &[RegistrationPointPair],
    ) -> Result<ImportRegistrationState, ImportRegistrationRuntimeError> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("registration sessions poisoned");
        let session = sessions
            .get_mut(session_id)
            .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
        let RegistrationMethod::PointPairs { model, robust, .. } = session.state.recipe.method
        else {
            return Err(ImportRegistrationRuntimeError::WrongMethod);
        };
        session.state.phase = RegistrationPhase::Previewing;
        let preview = match model {
            himmelcad_core::transform::EmpiricalModelKind::Translation3D => {
                fit_translation_point_pairs_3d(pairs, robust)?
            }
            himmelcad_core::transform::EmpiricalModelKind::Rigid3D => {
                fit_point_pairs_3d(pairs, false, robust)?
            }
            himmelcad_core::transform::EmpiricalModelKind::Similarity3D => {
                fit_point_pairs_3d(pairs, true, robust)?
            }
            _ => return Err(ImportRegistrationRuntimeError::UnsupportedPointPairModel),
        };
        session.state.phase = if preview.accepted {
            RegistrationPhase::ReadyToCommit
        } else {
            RegistrationPhase::AwaitingFreshInteraction
        };
        session.state.preview = Some(preview);
        Ok(session.state.clone())
    }

    /// Runs bounded ICP from transient prepared samples. Samples are never retained.
    #[allow(clippy::too_many_arguments)] // Registration session inputs are an explicit API boundary.
    pub fn preview_icp<F>(
        &self,
        session_id: &str,
        source: &[WorldPoint],
        target: &[RegistrationTargetSample],
        initial: Similarity3D,
        mode: IcpMode,
        options: IcpOptions,
        mut progress: F,
    ) -> Result<ImportRegistrationState, ImportRegistrationRuntimeError>
    where
        F: FnMut(u32, u32, f64),
    {
        let cancellation = {
            let mut sessions = self
                .sessions
                .lock()
                .expect("registration sessions poisoned");
            let session = sessions
                .get_mut(session_id)
                .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
            if !matches!(
                session.state.recipe.method,
                RegistrationMethod::Icp { .. }
                    | RegistrationMethod::PointPairs {
                        offer_icp_refinement: true,
                        ..
                    }
            ) {
                return Err(ImportRegistrationRuntimeError::WrongMethod);
            }
            session.state.phase = RegistrationPhase::Previewing;
            session.cancellation.clone()
        };
        let preview_result = run_icp(
            source,
            target,
            initial,
            mode,
            options,
            |completed, total, overlap| {
                progress(completed, total, overlap);
                !cancellation.is_cancel_requested()
            },
        );
        let mut sessions = self
            .sessions
            .lock()
            .expect("registration sessions poisoned");
        if let Err(error) = preview_result {
            if cancellation.is_cancel_requested() {
                if let Some(session) = sessions.remove(session_id) {
                    cleanup_scratch(&session.scratch_root);
                }
            } else if let Some(session) = sessions.get_mut(session_id) {
                session.state.phase = RegistrationPhase::AwaitingFreshInteraction;
                session.state.message = Some(error.to_string());
            }
            return Err(error.into());
        }
        let preview = preview_result.expect("error handled above");
        let session = sessions
            .get_mut(session_id)
            .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
        session.state.phase = if preview.accepted {
            RegistrationPhase::ReadyToCommit
        } else {
            RegistrationPhase::AwaitingFreshInteraction
        };
        session.state.preview = Some(preview);
        Ok(session.state.clone())
    }

    /// Consumes a ready session and returns its registered staged package for atomic publication.
    pub fn take_ready(
        &self,
        session_id: &str,
    ) -> Result<(CanonicalStagedImport, String, PathBuf), ImportRegistrationRuntimeError> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("registration sessions poisoned");
        let session = sessions
            .get_mut(session_id)
            .ok_or(ImportRegistrationRuntimeError::UnknownSession)?;
        if session.state.phase != RegistrationPhase::ReadyToCommit {
            return Err(ImportRegistrationRuntimeError::NotReady);
        }
        let preview = session
            .state
            .preview
            .as_ref()
            .ok_or(ImportRegistrationRuntimeError::NotReady)?;
        let method_kind = method_kind(&session.state.recipe.method);
        let mut staged = session
            .staged
            .take()
            .ok_or(ImportRegistrationRuntimeError::NotReady)?;
        apply_registration_preview(
            &mut staged.package,
            &session.state.recipe.recipe_id,
            method_kind,
            preview,
        )?;
        session.state.phase = RegistrationPhase::Committing;
        Ok((
            staged,
            session.state.command_id.clone(),
            session.scratch_root.clone(),
        ))
    }

    /// Marks a consumed session complete and releases its temporary provider artifacts.
    pub fn finish_commit(&self, session_id: &str, success: bool) {
        let session = self
            .sessions
            .lock()
            .expect("registration sessions poisoned")
            .remove(session_id);
        if let Some(mut session) = session {
            session.state.phase = if success {
                RegistrationPhase::Completed
            } else {
                RegistrationPhase::Failed
            };
            cleanup_scratch(&session.scratch_root);
        }
    }

    /// Cancels a running preview or discards an uncommitted staged import.
    pub fn cancel(&self, session_id: &str) -> bool {
        let mut sessions = self
            .sessions
            .lock()
            .expect("registration sessions poisoned");
        let Some(session) = sessions.get_mut(session_id) else {
            return false;
        };
        let first = session.cancellation.request_cancel();
        if session.state.phase != RegistrationPhase::Previewing {
            let session = sessions.remove(session_id).expect("session exists");
            cleanup_scratch(&session.scratch_root);
        }
        first
    }
}

fn create_resource_capability(session_id: &str, command_id: &str, scratch_root: &Path) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut digest = Sha256::new();
    digest.update(b"hcad-staged-resource-capability-v1\0");
    digest.update(session_id.as_bytes());
    digest.update(b"\0");
    digest.update(command_id.as_bytes());
    digest.update(b"\0");
    digest.update(scratch_root.as_os_str().as_encoded_bytes());
    digest.update(b"\0");
    digest.update(std::process::id().to_le_bytes());
    digest.update(now.to_le_bytes());
    hex::encode(digest.finalize())
}

#[allow(clippy::too_many_arguments)]
fn sample_potree_root(
    session_id: &str,
    dataset_id: &str,
    root_metadata_hash: &str,
    placement: Option<himmelcad_core::entity_model::Transform3d>,
    maximum_samples: usize,
    verified: &VerifiedStagedResources,
    cancellation: &CancellationToken,
) -> Result<RegistrationSourceSamples, ImportRegistrationRuntimeError> {
    let dataset = verified
        .inventory
        .datasets
        .iter()
        .find(|dataset| dataset.dataset_id == dataset_id)
        .ok_or(ImportRegistrationRuntimeError::UnsupportedSampleDataset)?;
    let metadata_descriptor = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.object_hash == root_metadata_hash)
        .ok_or(ImportRegistrationRuntimeError::MissingRootResource)?;
    let hierarchy_descriptor = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("hierarchy.bin"))
        .ok_or(ImportRegistrationRuntimeError::MissingSampleArtifact)?;
    let octree_descriptor = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("octree.bin"))
        .ok_or(ImportRegistrationRuntimeError::MissingSampleArtifact)?;
    let metadata = read_verified_full(verified, metadata_descriptor, cancellation)?;
    let metadata_json: serde_json::Value = serde_json::from_slice(&metadata)
        .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let first_chunk_size = metadata_json
        .pointer("/hierarchy/firstChunkSize")
        .and_then(serde_json::Value::as_u64)
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    if first_chunk_size == 0 || first_chunk_size > MAX_REGISTRATION_SAMPLE_NODE_BYTES {
        return Err(ImportRegistrationRuntimeError::SampleNodeTooLarge);
    }
    let hierarchy = read_verified_range(
        verified,
        hierarchy_descriptor,
        0,
        first_chunk_size,
        cancellation,
    )?;
    let mut source = PotreeHierarchySource::from_bytes(
        DatasetId(dataset_id.to_owned()),
        "hcad-staged://registration/metadata.json",
        &metadata,
        &hierarchy,
    )
    .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let root_id = source
        .roots()
        .first()
        .cloned()
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let root = source
        .tile(&root_id)
        .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreeMetadata)?
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let content = root
        .contents
        .first()
        .ok_or(ImportRegistrationRuntimeError::MissingSampleArtifact)?;
    let offset = content
        .byte_offset
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let byte_length = content
        .byte_length
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let point_count = content
        .primitive_count
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    if byte_length == 0 || byte_length > MAX_REGISTRATION_SAMPLE_NODE_BYTES {
        return Err(ImportRegistrationRuntimeError::SampleNodeTooLarge);
    }
    let payload = read_verified_range(
        verified,
        octree_descriptor,
        offset,
        byte_length,
        cancellation,
    )?;
    let origin = match root.bounds {
        BoundingVolume::AxisAlignedBox { bounds } => WorldVec3 {
            x: (bounds.min.x + bounds.max.x) * 0.5,
            y: (bounds.min.y + bounds.max.y) * 0.5,
            z: (bounds.min.z + bounds.max.z) * 0.5,
        },
        _ => return Err(ImportRegistrationRuntimeError::InvalidPotreeMetadata),
    };
    let decoded = source
        .point_layout()
        .decode_node(&payload, point_count, origin)
        .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreePayload)?;
    if decoded.positions.len() < 3 {
        return Err(ImportRegistrationRuntimeError::InsufficientSourceSamples);
    }
    let count = maximum_samples.min(decoded.positions.len());
    let mut points = Vec::with_capacity(count);
    for index in 0..count {
        let source_index = index * decoded.positions.len() / count;
        let local = decoded.positions[source_index];
        let point = WorldPoint::new(
            decoded.world_origin.x + f64::from(local[0]),
            decoded.world_origin.y + f64::from(local[1]),
            decoded.world_origin.z + f64::from(local[2]),
        );
        points.push(apply_optional_placement(point, placement));
    }
    Ok(RegistrationSourceSamples {
        schema_version: 1,
        session_id: session_id.to_owned(),
        dataset_id: dataset_id.to_owned(),
        sampling_method: "potree-additive-root-even-v1".to_owned(),
        source_transform: placement,
        resource_hashes: vec![
            metadata_descriptor.object_hash.clone(),
            hierarchy_descriptor.object_hash.clone(),
            octree_descriptor.object_hash.clone(),
        ],
        points,
    })
}

/// Open, hash-verified files for one committed Potree dataset.
pub(crate) struct PotreeOpenFiles<'a> {
    pub metadata: &'a mut fs::File,
    pub hierarchy: &'a mut fs::File,
    pub octree: &'a mut fs::File,
}

/// Samples one hash-verified committed Potree dataset without exposing project paths.
pub(crate) fn sample_potree_open_files(
    owner_id: &str,
    dataset_id: &str,
    resource_hashes: [String; 3],
    placement: Option<himmelcad_core::entity_model::Transform3d>,
    maximum_samples: usize,
    files: PotreeOpenFiles<'_>,
) -> Result<RegistrationSourceSamples, ImportRegistrationRuntimeError> {
    if !(3..=himmelcad_core::registration::MAX_ICP_SAMPLES_PER_CLOUD).contains(&maximum_samples) {
        return Err(ImportRegistrationRuntimeError::InvalidSampleLimit);
    }
    let metadata_length = files.metadata.metadata()?.len();
    if metadata_length == 0 || metadata_length > MAX_REGISTRATION_SAMPLE_NODE_BYTES {
        return Err(ImportRegistrationRuntimeError::SampleNodeTooLarge);
    }
    let cancellation = CancellationToken::new();
    let metadata = read_open_range(files.metadata, 0, metadata_length, &cancellation)?;
    let metadata_json: serde_json::Value = serde_json::from_slice(&metadata)
        .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let first_chunk_size = metadata_json
        .pointer("/hierarchy/firstChunkSize")
        .and_then(serde_json::Value::as_u64)
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    if first_chunk_size == 0 || first_chunk_size > MAX_REGISTRATION_SAMPLE_NODE_BYTES {
        return Err(ImportRegistrationRuntimeError::SampleNodeTooLarge);
    }
    let hierarchy = read_open_range(files.hierarchy, 0, first_chunk_size, &cancellation)?;
    let mut source = PotreeHierarchySource::from_bytes(
        DatasetId(dataset_id.to_owned()),
        "hcad-project://canonical/metadata.json",
        &metadata,
        &hierarchy,
    )
    .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let root_id = source
        .roots()
        .first()
        .cloned()
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let root = source
        .tile(&root_id)
        .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreeMetadata)?
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let content = root
        .contents
        .first()
        .ok_or(ImportRegistrationRuntimeError::MissingSampleArtifact)?;
    let offset = content
        .byte_offset
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let byte_length = content
        .byte_length
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    let point_count = content
        .primitive_count
        .ok_or(ImportRegistrationRuntimeError::InvalidPotreeMetadata)?;
    if byte_length == 0 || byte_length > MAX_REGISTRATION_SAMPLE_NODE_BYTES {
        return Err(ImportRegistrationRuntimeError::SampleNodeTooLarge);
    }
    let payload = read_open_range(files.octree, offset, byte_length, &cancellation)?;
    let origin = match root.bounds {
        BoundingVolume::AxisAlignedBox { bounds } => WorldVec3 {
            x: (bounds.min.x + bounds.max.x) * 0.5,
            y: (bounds.min.y + bounds.max.y) * 0.5,
            z: (bounds.min.z + bounds.max.z) * 0.5,
        },
        _ => return Err(ImportRegistrationRuntimeError::InvalidPotreeMetadata),
    };
    let decoded = source
        .point_layout()
        .decode_node(&payload, point_count, origin)
        .map_err(|_| ImportRegistrationRuntimeError::InvalidPotreePayload)?;
    if decoded.positions.len() < 3 {
        return Err(ImportRegistrationRuntimeError::InsufficientSourceSamples);
    }
    let count = maximum_samples.min(decoded.positions.len());
    let mut points = Vec::with_capacity(count);
    for index in 0..count {
        let source_index = index * decoded.positions.len() / count;
        let local = decoded.positions[source_index];
        points.push(apply_optional_placement(
            WorldPoint::new(
                decoded.world_origin.x + f64::from(local[0]),
                decoded.world_origin.y + f64::from(local[1]),
                decoded.world_origin.z + f64::from(local[2]),
            ),
            placement,
        ));
    }
    Ok(RegistrationSourceSamples {
        schema_version: 1,
        session_id: owner_id.to_owned(),
        dataset_id: dataset_id.to_owned(),
        sampling_method: "potree-additive-root-even-v1".to_owned(),
        source_transform: placement,
        resource_hashes: resource_hashes.into(),
        points,
    })
}

fn read_open_range(
    file: &mut fs::File,
    offset: u64,
    byte_length: u64,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, ImportRegistrationRuntimeError> {
    let end = offset
        .checked_add(byte_length)
        .ok_or(ImportRegistrationRuntimeError::InvalidResourceRange)?;
    if end > file.metadata()?.len() {
        return Err(ImportRegistrationRuntimeError::InvalidResourceRange);
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![
        0;
        usize::try_from(byte_length)
            .map_err(|_| ImportRegistrationRuntimeError::SampleNodeTooLarge)?
    ];
    let mut read = 0;
    while read < bytes.len() {
        if cancellation.is_cancel_requested() {
            return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
        }
        let count = file.read(&mut bytes[read..])?;
        if count == 0 {
            return Err(ImportRegistrationRuntimeError::ResourceChanged);
        }
        read += count;
    }
    Ok(bytes)
}

fn read_verified_full(
    verified: &VerifiedStagedResources,
    descriptor: &StagedResourceDescriptor,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, ImportRegistrationRuntimeError> {
    if descriptor.byte_length > MAX_REGISTRATION_SAMPLE_NODE_BYTES {
        return Err(ImportRegistrationRuntimeError::SampleNodeTooLarge);
    }
    read_verified_range(
        verified,
        descriptor,
        0,
        descriptor.byte_length,
        cancellation,
    )
}

fn read_verified_range(
    verified: &VerifiedStagedResources,
    descriptor: &StagedResourceDescriptor,
    offset: u64,
    byte_length: u64,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, ImportRegistrationRuntimeError> {
    let resource = verified
        .resources
        .get(&descriptor.resource_id)
        .ok_or(ImportRegistrationRuntimeError::UnknownResource)?;
    let end = offset
        .checked_add(byte_length)
        .ok_or(ImportRegistrationRuntimeError::InvalidResourceRange)?;
    if end > descriptor.byte_length {
        return Err(ImportRegistrationRuntimeError::InvalidResourceRange);
    }
    let mut file = fs::File::open(&resource.path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![
        0;
        usize::try_from(byte_length)
            .map_err(|_| ImportRegistrationRuntimeError::SampleNodeTooLarge)?
    ];
    let mut read = 0;
    while read < bytes.len() {
        if cancellation.is_cancel_requested() {
            return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
        }
        let count = file.read(&mut bytes[read..])?;
        if count == 0 {
            return Err(ImportRegistrationRuntimeError::ResourceChanged);
        }
        read += count;
    }
    Ok(bytes)
}

fn apply_optional_placement(
    point: WorldPoint,
    placement: Option<himmelcad_core::entity_model::Transform3d>,
) -> WorldPoint {
    let Some(matrix) = placement else {
        return point;
    };
    WorldPoint::new(
        matrix.0[0] * point.x + matrix.0[4] * point.y + matrix.0[8] * point.z + matrix.0[12],
        matrix.0[1] * point.x + matrix.0[5] * point.y + matrix.0[9] * point.z + matrix.0[13],
        matrix.0[2] * point.x + matrix.0[6] * point.y + matrix.0[10] * point.z + matrix.0[14],
    )
}

fn verify_staged_resources(
    session_id: &str,
    capability: &str,
    staged: &CanonicalStagedImport,
    cancellation: &CancellationToken,
) -> Result<VerifiedStagedResources, ImportRegistrationRuntimeError> {
    let mut resources = BTreeMap::new();
    let mut datasets = Vec::with_capacity(staged.package.datasets.len());
    for dataset in &staged.package.datasets {
        let root = staged
            .roots
            .dataset_roots
            .get(&dataset.dataset_id)
            .ok_or(ImportRegistrationRuntimeError::MissingResourceRoot)?;
        let mut artifacts = Vec::with_capacity(dataset.artifacts.len());
        let mut root_resource_id = None;
        for artifact in &dataset.artifacts {
            let descriptor = verify_artifact(
                capability,
                "dataset",
                &dataset.dataset_id,
                root,
                &artifact.relative_path,
                artifact.resource.object_hash.as_str(),
                &artifact.resource.media_type,
                artifact.resource.byte_length,
                cancellation,
            )?;
            if artifact.resource.object_hash == dataset.root_metadata.object_hash {
                root_resource_id = Some(descriptor.0.resource_id.clone());
            }
            insert_verified_resource(&mut resources, descriptor.clone())?;
            artifacts.push(descriptor.0);
        }
        datasets.push(StagedDatasetDescriptor {
            dataset_id: dataset.dataset_id.clone(),
            format_id: dataset.format_id.clone(),
            entity_id: dataset.entity_id.clone(),
            representation_slot: dataset.representation_slot.clone(),
            root_resource_id: root_resource_id
                .ok_or(ImportRegistrationRuntimeError::MissingRootResource)?,
            artifacts,
        });
    }
    let mut resource_sets = Vec::with_capacity(staged.package.resource_sets.len());
    for resource_set in &staged.package.resource_sets {
        let root = staged
            .roots
            .resource_set_roots
            .get(&resource_set.resource_set_id)
            .ok_or(ImportRegistrationRuntimeError::MissingResourceRoot)?;
        let mut descriptors = Vec::with_capacity(resource_set.resources.len());
        for artifact in &resource_set.resources {
            let descriptor = verify_artifact(
                capability,
                "resource-set",
                &resource_set.resource_set_id,
                root,
                &artifact.relative_path,
                artifact.resource.object_hash.as_str(),
                &artifact.resource.media_type,
                artifact.resource.byte_length,
                cancellation,
            )?;
            insert_verified_resource(&mut resources, descriptor.clone())?;
            descriptors.push(descriptor.0);
        }
        resource_sets.push(StagedResourceSetDescriptor {
            resource_set_id: resource_set.resource_set_id.clone(),
            resources: descriptors,
        });
    }
    Ok(VerifiedStagedResources {
        inventory: StagedResourceInventory {
            schema_version: 1,
            session_id: session_id.to_owned(),
            capability: capability.to_owned(),
            maximum_read_bytes: MAX_STAGED_RESOURCE_READ_BYTES,
            datasets,
            resource_sets,
        },
        resources,
    })
}

#[allow(clippy::too_many_arguments)]
fn verify_artifact(
    capability: &str,
    kind: &str,
    owner_id: &str,
    root: &Path,
    relative_path: &Path,
    object_hash: &str,
    media_type: &str,
    byte_length: Option<u64>,
    cancellation: &CancellationToken,
) -> Result<(StagedResourceDescriptor, PathBuf), ImportRegistrationRuntimeError> {
    let relative = relative_path
        .to_str()
        .ok_or(ImportRegistrationRuntimeError::InvalidResourcePath)?;
    if relative.is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || media_type.trim().is_empty()
    {
        return Err(ImportRegistrationRuntimeError::InvalidResourcePath);
    }
    let expected_length =
        byte_length.ok_or(ImportRegistrationRuntimeError::UnknownResourceLength)?;
    let canonical_root = fs::canonicalize(root)?;
    let path = fs::canonicalize(root.join(relative_path))?;
    if !path.starts_with(&canonical_root) {
        return Err(ImportRegistrationRuntimeError::InvalidResourcePath);
    }
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() || metadata.len() != expected_length {
        return Err(ImportRegistrationRuntimeError::ResourceChanged);
    }
    let observed_hash = hash_file(&path, cancellation)?;
    if observed_hash != object_hash {
        return Err(ImportRegistrationRuntimeError::ResourceHashMismatch);
    }
    let mut id_hash = Sha256::new();
    id_hash.update(capability.as_bytes());
    id_hash.update(b"\0");
    id_hash.update(kind.as_bytes());
    id_hash.update(b"\0");
    id_hash.update(owner_id.as_bytes());
    id_hash.update(b"\0");
    id_hash.update(relative.as_bytes());
    id_hash.update(b"\0");
    id_hash.update(object_hash.as_bytes());
    let descriptor = StagedResourceDescriptor {
        resource_id: hex::encode(id_hash.finalize()),
        relative_path: relative.replace('\\', "/"),
        object_hash: object_hash.to_owned(),
        media_type: media_type.to_owned(),
        byte_length: expected_length,
    };
    Ok((descriptor, path))
}

fn insert_verified_resource(
    resources: &mut BTreeMap<String, VerifiedStagedResource>,
    value: (StagedResourceDescriptor, PathBuf),
) -> Result<(), ImportRegistrationRuntimeError> {
    let resource = VerifiedStagedResource {
        descriptor: value.0,
        path: value.1,
    };
    if resources
        .insert(resource.descriptor.resource_id.clone(), resource)
        .is_some()
    {
        return Err(ImportRegistrationRuntimeError::ResourceIdCollision);
    }
    Ok(())
}

fn hash_file(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<String, ImportRegistrationRuntimeError> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        if cancellation.is_cancel_requested() {
            return Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked);
        }
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(TABLE[usize::from(a >> 2)]));
        output.push(char::from(TABLE[usize::from(((a & 0x03) << 4) | (b >> 4))]));
        output.push(if chunk.len() > 1 {
            char::from(TABLE[usize::from(((b & 0x0f) << 2) | (c >> 6))])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(TABLE[usize::from(c & 0x3f)])
        } else {
            '='
        });
    }
    output
}

impl Drop for ImportRegistrationRuntime {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for session in sessions.values() {
                cleanup_scratch(&session.scratch_root);
            }
        }
    }
}

fn automatic_preview(
    recipe: &RegistrationRecipe,
) -> Result<(RegistrationPhase, Option<RegistrationPreview>), ImportRegistrationRuntimeError> {
    let transform = match recipe.method {
        RegistrationMethod::SourceCoordinates { .. } => Some(identity()),
        RegistrationMethod::OriginAndProjectNorth {
            source_origin,
            target_origin,
            project_north_degrees,
            scale,
        } => Some(origin_and_project_north_transform(
            source_origin,
            target_origin,
            project_north_degrees,
            scale,
        )?),
        RegistrationMethod::ManualPlacement { transform } => Some(transform),
        RegistrationMethod::PointPairs { .. } | RegistrationMethod::Icp { .. } => None,
    };
    Ok(match transform {
        Some(transform) => (
            RegistrationPhase::ReadyToCommit,
            Some(automatic_registration_preview(transform)),
        ),
        None => (RegistrationPhase::AwaitingFreshInteraction, None),
    })
}

fn automatic_registration_preview(transform: Similarity3D) -> RegistrationPreview {
    let empty = residual_report(&[], |point| apply_similarity_3d(transform, point));
    RegistrationPreview {
        transform,
        residuals: empty,
        iterations: 0,
        matched_samples: 0,
        overlap_ratio: 1.0,
        converged: true,
        accepted: true,
        warnings: Vec::new(),
    }
}

fn identity() -> Similarity3D {
    Similarity3D {
        tx: 0.0,
        ty: 0.0,
        tz: 0.0,
        rx_radians: 0.0,
        ry_radians: 0.0,
        rz_radians: 0.0,
        scale: 1.0,
    }
}

fn method_kind(method: &RegistrationMethod) -> &'static str {
    match method {
        RegistrationMethod::SourceCoordinates { .. } => "sourceCoordinates",
        RegistrationMethod::OriginAndProjectNorth { .. } => "originAndProjectNorth",
        RegistrationMethod::ManualPlacement { .. } => "manualPlacement",
        RegistrationMethod::PointPairs { .. } => "pointPairs",
        RegistrationMethod::Icp { .. } => "icp",
    }
}

fn validate_identity(value: &str) -> Result<(), ImportRegistrationRuntimeError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Err(ImportRegistrationRuntimeError::InvalidIdentity)
    } else {
        Ok(())
    }
}

fn cleanup_scratch(path: &PathBuf) {
    if let Err(error) = fs::remove_dir_all(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), %error, "failed to remove registration scratch");
        }
    }
}

/// Registration-session failure.
#[derive(Debug, Error)]
pub enum ImportRegistrationRuntimeError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Registration(#[from] RegistrationError),
    #[error(transparent)]
    Provider(#[from] himmelcad_io::ProviderContractError),
    #[error("registration session identity is invalid")]
    InvalidIdentity,
    #[error("registration session already exists")]
    DuplicateSession,
    #[error("registration session is unknown")]
    UnknownSession,
    #[error("registration method does not support this preview")]
    WrongMethod,
    #[error("this point-pair model is not yet available for 3D import placement")]
    UnsupportedPointPairModel,
    #[error("registration preview is not ready to commit")]
    NotReady,
    #[error("staged import contains too many entities")]
    TooManyEntities,
    #[error("staged import preview cannot be serialized")]
    InvalidPreview,
    #[error("staged-resource capability has been revoked")]
    ResourceCapabilityRevoked,
    #[error("staged resources must be verified before reading")]
    ResourcesNotVerified,
    #[error("staged-resource root is missing")]
    MissingResourceRoot,
    #[error("prepared dataset root metadata is missing")]
    MissingRootResource,
    #[error("staged-resource path is invalid")]
    InvalidResourcePath,
    #[error("staged resource has no exact byte length")]
    UnknownResourceLength,
    #[error("staged resource changed after provider preparation")]
    ResourceChanged,
    #[error("staged resource hash does not match its immutable descriptor")]
    ResourceHashMismatch,
    #[error("staged-resource identity collision")]
    ResourceIdCollision,
    #[error("staged resource is unknown")]
    UnknownResource,
    #[error("staged-resource range is invalid")]
    InvalidResourceRange,
    #[error("staged-resource read exceeds the four MiB request bound")]
    ResourceReadTooLarge,
    #[error("staged-resource request budget exhausted")]
    ResourceRequestLimit,
    #[error("registration source sample limit is invalid")]
    InvalidSampleLimit,
    #[error("prepared dataset does not support deterministic registration sampling")]
    UnsupportedSampleDataset,
    #[error("prepared dataset is missing a sampling artifact")]
    MissingSampleArtifact,
    #[error("Potree sampling metadata is invalid")]
    InvalidPotreeMetadata,
    #[error("Potree sampling payload is invalid")]
    InvalidPotreePayload,
    #[error("prepared root node exceeds the bounded sampling limit")]
    SampleNodeTooLarge,
    #[error("prepared dataset has fewer than three source samples")]
    InsufficientSourceSamples,
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::{
        canonical_resource_catalog::CanonicalPresentationResourceSet,
        entity_model::GeometryResource, hash::ObjectHash,
    };
    use himmelcad_io::{
        CanonicalImportPackage, CanonicalPreparedDataset, PreparedDatasetArtifact,
        StagedArtifactRoots, CANONICAL_IO_SCHEMA_VERSION,
    };

    #[test]
    fn interactive_recipe_starts_awaiting_fresh_input() {
        let recipe = RegistrationRecipe {
            schema_version: 1,
            recipe_id: "pairs".into(),
            label: "Pairs".into(),
            method: RegistrationMethod::PointPairs {
                model: himmelcad_core::transform::EmpiricalModelKind::Similarity3D,
                robust: Default::default(),
                offer_icp_refinement: true,
            },
        };
        let (phase, preview) = automatic_preview(&recipe).expect("preview");
        assert_eq!(phase, RegistrationPhase::AwaitingFreshInteraction);
        assert!(preview.is_none());
    }

    #[test]
    fn automatic_origin_recipe_is_ready_without_picks() {
        let recipe = RegistrationRecipe {
            schema_version: 1,
            recipe_id: "bim-origin".into(),
            label: "BIM origin".into(),
            method: RegistrationMethod::OriginAndProjectNorth {
                source_origin: WorldPoint::new(0.0, 0.0, 0.0),
                target_origin: WorldPoint::new(100.0, 200.0, 3.0),
                project_north_degrees: 10.0,
                scale: 1.0,
            },
        };
        let (phase, preview) = automatic_preview(&recipe).expect("preview");
        assert_eq!(phase, RegistrationPhase::ReadyToCommit);
        assert!(preview.expect("automatic preview").accepted);
    }

    #[test]
    fn staged_resource_capability_reads_bounded_bytes_and_revokes_on_cancel() {
        let (runtime, root) = resource_runtime("cancel");
        let inventory = runtime
            .describe_resources("session-cancel")
            .expect("inventory");
        let resource = &inventory.datasets[0].artifacts[0];
        let read = runtime
            .read_resource(
                "session-cancel",
                &inventory.capability,
                &resource.resource_id,
                1,
                3,
            )
            .expect("bounded read");
        assert_eq!(read.bytes_base64, "YmNk");
        assert!(matches!(
            runtime.read_resource(
                "session-cancel",
                &"0".repeat(64),
                &resource.resource_id,
                0,
                1,
            ),
            Err(ImportRegistrationRuntimeError::ResourceCapabilityRevoked)
        ));
        assert!(runtime.cancel("session-cancel"));
        assert!(!root.exists());
        assert!(matches!(
            runtime.describe_resources("session-cancel"),
            Err(ImportRegistrationRuntimeError::UnknownSession)
        ));
    }

    #[test]
    fn staged_resource_capability_revokes_on_commit_finish_and_runtime_drop() {
        let (runtime, commit_root) = resource_runtime("commit");
        runtime
            .describe_resources("session-commit")
            .expect("inventory");
        runtime.finish_commit("session-commit", true);
        assert!(!commit_root.exists());
        assert!(matches!(
            runtime.describe_resources("session-commit"),
            Err(ImportRegistrationRuntimeError::UnknownSession)
        ));

        let (runtime, restart_root) = resource_runtime("restart");
        runtime
            .describe_resources("session-restart")
            .expect("inventory");
        drop(runtime);
        assert!(!restart_root.exists());
    }

    fn resource_runtime(suffix: &str) -> (ImportRegistrationRuntime, PathBuf) {
        let session_id = format!("session-{suffix}");
        let root = std::env::temp_dir().join(format!(
            "hcad-registration-resource-test-{}-{suffix}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("scratch");
        let bytes = b"abcdef";
        fs::write(root.join("metadata.json"), bytes).expect("artifact");
        let resource = GeometryResource {
            object_hash: ObjectHash::of_bytes(bytes),
            media_type: "application/json".into(),
            byte_length: Some(bytes.len() as u64),
        };
        let staged = CanonicalStagedImport {
            package: CanonicalImportPackage {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: "test.registration@1".into(),
                provider_version: "1".into(),
                admissions: Vec::new(),
                objects: Vec::new(),
                datasets: vec![CanonicalPreparedDataset {
                    dataset_id: "dataset".into(),
                    format_id: "potree@2".into(),
                    entity_id: "entity".into(),
                    representation_slot: "primary".into(),
                    root_metadata: resource.clone(),
                    artifacts: vec![PreparedDatasetArtifact {
                        relative_path: PathBuf::from("metadata.json"),
                        resource,
                    }],
                }],
                resource_sets: Vec::new(),
                presentation_resources: CanonicalPresentationResourceSet::default(),
            },
            roots: StagedArtifactRoots {
                dataset_roots: BTreeMap::from([("dataset".into(), root.clone())]),
                resource_set_roots: BTreeMap::new(),
            },
        };
        let recipe = RegistrationRecipe {
            schema_version: 1,
            recipe_id: "resource-test".into(),
            label: "Resource test".into(),
            method: RegistrationMethod::SourceCoordinates {
                frozen_transform_sha256: None,
            },
        };
        let state = ImportRegistrationState {
            schema_version: 1,
            session_id: session_id.clone(),
            command_id: format!("command-{suffix}"),
            recipe,
            phase: RegistrationPhase::ReadyToCommit,
            source_entity_count: 0,
            source_preview: serde_json::Value::Null,
            preview: Some(automatic_registration_preview(identity())),
            message: None,
        };
        let runtime = ImportRegistrationRuntime::default();
        runtime.sessions.lock().expect("sessions").insert(
            session_id,
            Session {
                state,
                staged: Some(staged),
                scratch_root: root.clone(),
                cancellation: CancellationToken::new(),
                resource_capability: "a".repeat(64),
                verified_resources: None,
                resource_requests: 0,
            },
        );
        (runtime, root)
    }
}
