//! Shared canonical application control-plane runtime.
//!
//! Desktop UIs and automation clients enter the same dispatcher. The runtime
//! owns the durable project store and never exposes an in-memory-only mutation
//! path.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::{Path, PathBuf};

use himmelcad_core::app_protocol::{
    read_journal_page, validate_request_envelope, AppDocumentSnapshot, AppJournalReadError,
    AppProtocolEnvelopeError, AppProtocolError, AppProtocolRequest, AppProtocolRequestEnvelope,
    AppProtocolResponse, AppProtocolResponseEnvelope, APP_PROTOCOL_SCHEMA_ID,
};
use himmelcad_core::canonical_document::CanonicalDocumentError;
use himmelcad_core::canonical_document::{
    CanonicalCommandTransaction, CanonicalEntityEdit, CanonicalEntityMutation,
};
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{built_in_type, CanonicalEntity, EntityTypeId, GeometryObject};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::property_schema::{
    canonical_entity_property_schema, compile_multi_entity_property_edit, query_properties,
    PropertySchemaError,
};
use himmelcad_core::typed_artifact::{TypedArtifactDescriptor, TypedArtifactManifest};
use himmelcad_io::{
    CanonicalImportPackage, CanonicalJsonObject, CanonicalPreparedDataset, CanonicalStagedImport,
    CANONICAL_IO_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_project_store::{
    CanonicalImportCommit, CanonicalImportInventory, CanonicalImportProgress,
    CanonicalImportSourceRoots, CanonicalProjectStore, CanonicalProjectStoreError,
    CanonicalStoredObject,
};
use crate::import_registration_runtime::{
    sample_potree_open_files, ImportRegistrationRuntimeError, PotreeOpenFiles,
    RegistrationSourceSamples,
};

/// Process-internal verified CAS source used by the bounded automation lease
/// runtime. Its path is never serialized.
#[derive(Debug)]
pub struct AutomationObjectSource {
    pub metadata: CanonicalStoredObject,
    pub source: File,
    pub source_entity: Option<himmelcad_core::canonical_document::EntityVersionRef>,
    pub typed_artifact: Option<TypedArtifactDescriptor>,
    pub representation_slot: Option<String>,
    pub geometry_ref: Option<ObjectHash>,
}

/// One process-local owner of the currently open canonical project.
#[derive(Default)]
pub struct CanonicalAppRuntime {
    store: Option<CanonicalProjectStore>,
}

/// Versioned, path-free description of every live representation that can be
/// reconstructed from the canonical store after process restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalResidencyBootstrap {
    pub schema_version: u32,
    pub generation: u64,
    pub entries: Vec<CanonicalResidencyEntry>,
}

/// One exact live admission plus an optional prepared-dataset inventory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalResidencyEntry {
    pub provider_id: String,
    pub provider_version: String,
    pub admission: CanonicalRepresentationAdmission,
    pub dataset: Option<CanonicalPreparedDataset>,
}

/// Failure of an explicit project lifecycle or staged import operation.
#[derive(Debug, Error)]
pub enum CanonicalAppRuntimeError {
    /// An operation requires an open canonical project.
    #[error("no canonical project is open")]
    ProjectNotOpen,
    /// Opening another project without first closing the current one is unsafe.
    #[error("a canonical project is already open")]
    ProjectAlreadyOpen,
    /// Durable canonical project storage rejected the operation.
    #[error(transparent)]
    Store(#[from] CanonicalProjectStoreError),
    #[error("canonical transaction references missing object {0:?}")]
    MissingObject(ObjectHash),
    /// Provider staging roots or the portable package are inconsistent.
    #[error("canonical staged import is invalid: {0}")]
    StagedImport(#[from] himmelcad_io::ProviderContractError),
    /// Persisted admissions or artifact inventories no longer agree with the
    /// live canonical document or immutable object store.
    #[error("canonical residency inventory is invalid: {0}")]
    InvalidResidency(String),
    /// A durable provider package cannot be reconstructed exactly for export.
    #[error("canonical import inventory cannot be reconstructed: {0}")]
    InvalidImportInventory(String),
    /// A live prepared point cloud could not provide bounded registration samples.
    #[error("canonical point-cloud registration samples are invalid: {0}")]
    RegistrationSamples(String),
}

impl CanonicalAppRuntime {
    /// Opens or creates one durable canonical project and replays its journal.
    pub fn open(
        &mut self,
        project_root: impl AsRef<Path>,
    ) -> Result<AppDocumentSnapshot, CanonicalAppRuntimeError> {
        let project_root = project_root.as_ref();
        if let Some(store) = &self.store {
            if store.root() == project_root {
                return Ok(AppDocumentSnapshot::from_document(store.document()));
            }
            return Err(CanonicalAppRuntimeError::ProjectAlreadyOpen);
        }
        let mut store = CanonicalProjectStore::open(project_root)?;
        if store.document().generation() == 0
            && store.document().entities().next().is_none()
            && store.document().tombstones().next().is_none()
        {
            seed_project_root(&mut store, project_root)?;
        }
        let snapshot = AppDocumentSnapshot::from_document(store.document());
        self.store = Some(store);
        Ok(snapshot)
    }

    /// Releases the exclusive canonical project lock.
    pub fn close(&mut self) -> bool {
        self.store.take().is_some()
    }

    /// Returns whether a canonical project currently owns this runtime.
    #[must_use]
    pub const fn is_open(&self) -> bool {
        self.store.is_some()
    }

    /// Returns an immutable, stable-order automation snapshot without
    /// exposing the project store or host paths.
    pub fn automation_entities(
        &self,
    ) -> Result<(u64, Vec<CanonicalEntity>), CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        Ok((
            store.document().generation(),
            store.document().entities().cloned().collect(),
        ))
    }

    /// Fully validates one canonical transaction against the current
    /// generation and immutable object inventory without mutating state.
    pub fn automation_validate_transaction(
        &self,
        transaction: &CanonicalCommandTransaction,
    ) -> Result<(), String> {
        let store = self.store().map_err(|error| error.to_string())?;
        validate_transaction_object_refs(store, transaction).map_err(|error| error.to_string())?;
        store
            .document()
            .prepare_transaction(transaction.clone())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Resolves and verifies one immutable CAS source for a sidecar-owned
    /// bounded bulk lease. Only the automation runtime receives the path.
    pub fn automation_object_source(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<AutomationObjectSource, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let (metadata, source) = store.verified_object_source(object_hash)?;
        let direct_source_entity = store.document().entities().find_map(|entity| {
            let references_hash = entity.components_ref == *object_hash
                || entity.attributes_ref == *object_hash
                || entity.relations_ref == *object_hash
                || entity.style_ref.as_ref() == Some(object_hash)
                || entity
                    .representations
                    .iter()
                    .any(|representation| representation.geometry_ref == *object_hash);
            references_hash.then(|| himmelcad_core::canonical_document::EntityVersionRef {
                id: entity.id.clone(),
                revision: entity.revision,
                version_hash: entity.version_hash.clone(),
            })
        });
        let resolved = resolve_automation_artifact(store, object_hash)?;
        Ok(AutomationObjectSource {
            metadata,
            source,
            source_entity: resolved.source_entity.or(direct_source_entity),
            typed_artifact: resolved.typed_artifact,
            representation_slot: resolved.representation_slot,
            geometry_ref: resolved.geometry_ref,
        })
    }

    /// Publishes a validated provider result through the same journal-last store
    /// used by all other canonical mutations.
    pub fn publish_staged_import(
        &mut self,
        staged: &CanonicalStagedImport,
        command_id: &str,
    ) -> Result<CanonicalImportCommit, CanonicalAppRuntimeError> {
        staged.validate()?;
        let source_roots = CanonicalImportSourceRoots {
            datasets: staged.roots.dataset_roots.clone(),
            resource_sets: staged.roots.resource_set_roots.clone(),
        };
        self.store_mut()?
            .publish_import_package(&staged.package, &source_roots, command_id)
            .map_err(Into::into)
    }

    /// Publishes a staged import and reports the real durable-store byte progress.
    pub fn publish_staged_import_with_progress(
        &mut self,
        staged: &CanonicalStagedImport,
        command_id: &str,
        progress: &mut dyn FnMut(CanonicalImportProgress),
    ) -> Result<CanonicalImportCommit, CanonicalAppRuntimeError> {
        staged.validate()?;
        let source_roots = CanonicalImportSourceRoots {
            datasets: staged.roots.dataset_roots.clone(),
            resource_sets: staged.roots.resource_set_roots.clone(),
        };
        self.store_mut()?
            .publish_import_package_with_progress(
                &staged.package,
                &source_roots,
                command_id,
                progress,
            )
            .map_err(Into::into)
    }

    /// Reconstructs exact admissions for live entities without exposing host
    /// paths. Deleted entities and superseded representation bindings are
    /// intentionally omitted.
    pub fn residency_bootstrap(
        &self,
    ) -> Result<CanonicalResidencyBootstrap, CanonicalAppRuntimeError> {
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let mut entries = Vec::new();
        let mut slots = std::collections::BTreeSet::new();
        for inventory in store.import_inventories()? {
            for stored in &inventory.admissions {
                let entity_id = EntityId(stored.entity_id.clone());
                let Some(entity) = store.document().entity(&entity_id) else {
                    continue;
                };
                if stored.geometry_ref != stored.selected.geometry_ref
                    || !entity
                        .representations
                        .iter()
                        .any(|representation| representation == &stored.selected)
                {
                    // The entity is live but this historical slot was replaced.
                    continue;
                }
                let slot = (stored.entity_id.clone(), stored.representation_slot.clone());
                if !slots.insert(slot.clone()) {
                    return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                        "duplicate live representation slot {slot:?}"
                    )));
                }
                let geometry_bytes = store.read_object(&stored.geometry_ref)?;
                let geometry: GeometryObject =
                    serde_json::from_slice(&geometry_bytes).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(error.to_string())
                    })?;
                validate_resolved_representation(entity, &stored.selected, &geometry).map_err(
                    |error| {
                        let observed = geometry_object_content_hash(&geometry)
                            .map(|hash| hash.0)
                            .unwrap_or_else(|hash_error| hash_error.to_string());
                        CanonicalAppRuntimeError::InvalidResidency(format!(
                            "entity {:?} slot {:?}: {error}; expected {}, observed {observed}",
                            stored.entity_id,
                            stored.representation_slot,
                            stored.selected.geometry_ref.0,
                        ))
                    },
                )?;
                let matching_datasets = inventory
                    .datasets
                    .iter()
                    .filter(|dataset| {
                        dataset.entity_id == stored.entity_id
                            && dataset.representation_slot == stored.representation_slot
                    })
                    .collect::<Vec<_>>();
                if matching_datasets.len() > 1 {
                    return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                        "multiple datasets bind representation slot {slot:?}"
                    )));
                }
                let dataset = matching_datasets.first().copied().cloned();
                if let Some(dataset) = &dataset {
                    validate_residency_dataset(store, dataset)?;
                }
                entries.push(CanonicalResidencyEntry {
                    provider_id: inventory.provider_id.clone(),
                    provider_version: inventory.provider_version.clone(),
                    admission: CanonicalRepresentationAdmission {
                        entity: entity.clone(),
                        selected: stored.selected.clone(),
                        representation_slot: stored.representation_slot.clone(),
                        expected_generation: None,
                        resolved_geometry: geometry,
                    },
                    dataset,
                });
            }
        }
        entries.sort_by(|left, right| {
            (
                &left.admission.entity.id.0,
                &left.admission.representation_slot,
            )
                .cmp(&(
                    &right.admission.entity.id.0,
                    &right.admission.representation_slot,
                ))
        });
        Ok(CanonicalResidencyBootstrap {
            schema_version: 1,
            generation: store.document().generation(),
            entries,
        })
    }

    /// Returns a deterministic bounded sample of one live committed Potree point cloud.
    pub fn registration_point_cloud_samples(
        &self,
        dataset_id: &str,
        maximum_samples: usize,
    ) -> Result<RegistrationSourceSamples, CanonicalAppRuntimeError> {
        let bootstrap = self.residency_bootstrap()?;
        let entry = bootstrap
            .entries
            .into_iter()
            .find(|entry| {
                entry
                    .dataset
                    .as_ref()
                    .is_some_and(|dataset| dataset.dataset_id == dataset_id)
            })
            .ok_or_else(|| {
                CanonicalAppRuntimeError::RegistrationSamples(format!(
                    "unknown live dataset {dataset_id:?}"
                ))
            })?;
        let dataset = entry.dataset.ok_or_else(|| {
            CanonicalAppRuntimeError::RegistrationSamples("dataset is missing".to_owned())
        })?;
        if dataset.format_id != "potree@2"
            || !matches!(
                entry.admission.resolved_geometry,
                GeometryObject::PointCloud { .. }
            )
        {
            return Err(CanonicalAppRuntimeError::RegistrationSamples(
                "dataset is not a Potree point cloud".to_owned(),
            ));
        }
        let metadata_hash = dataset.root_metadata.object_hash.clone();
        let hierarchy_hash = dataset
            .artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("hierarchy.bin"))
            .map(|artifact| artifact.resource.object_hash.clone())
            .ok_or_else(|| {
                CanonicalAppRuntimeError::RegistrationSamples(
                    "Potree hierarchy artifact is missing".to_owned(),
                )
            })?;
        let octree_hash = dataset
            .artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("octree.bin"))
            .map(|artifact| artifact.resource.object_hash.clone())
            .ok_or_else(|| {
                CanonicalAppRuntimeError::RegistrationSamples(
                    "Potree octree artifact is missing".to_owned(),
                )
            })?;
        let store = self
            .store
            .as_ref()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)?;
        let (_, mut metadata_file) = store.verified_object_source(&metadata_hash)?;
        let (_, mut hierarchy_file) = store.verified_object_source(&hierarchy_hash)?;
        let (_, mut octree_file) = store.verified_object_source(&octree_hash)?;
        sample_potree_open_files(
            "project-point-cloud",
            dataset_id,
            [metadata_hash.0, hierarchy_hash.0, octree_hash.0],
            entry.admission.entity.placement,
            maximum_samples,
            PotreeOpenFiles {
                metadata: &mut metadata_file,
                hierarchy: &mut hierarchy_file,
                octree: &mut octree_file,
            },
        )
        .map_err(registration_sample_error)
    }

    /// Reconstructs the exact currently-live canonical package published by
    /// one import command. The provider/version and immutable presentation
    /// resources come from the durable inventory; entity envelopes and
    /// geometry are resolved from the authoritative document and object store.
    pub fn reconstruct_import_package(
        &self,
        command_id: &str,
    ) -> Result<CanonicalImportPackage, CanonicalAppRuntimeError> {
        let store = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
        let inventory = store
            .import_inventories()?
            .into_iter()
            .find(|inventory| inventory.command_id == command_id)
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "unknown import command {command_id:?}"
                ))
            })?;
        let mut admissions = Vec::with_capacity(inventory.admissions.len());
        let mut required_json = BTreeSet::new();
        for stored in &inventory.admissions {
            let entity = store
                .document()
                .entity(&EntityId(stored.entity_id.clone()))
                .ok_or_else(|| {
                    CanonicalAppRuntimeError::InvalidImportInventory(format!(
                        "entity {:?} is no longer live",
                        stored.entity_id
                    ))
                })?
                .clone();
            if !entity.representations.contains(&stored.selected)
                || stored.geometry_ref != stored.selected.geometry_ref
            {
                return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "entity {:?} no longer has representation slot {:?}",
                    stored.entity_id, stored.representation_slot
                )));
            }
            let resolved_geometry: GeometryObject = serde_json::from_slice(
                &store.read_object(&stored.geometry_ref)?,
            )
            .map_err(|error| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "geometry {:?} is invalid: {error}",
                    stored.geometry_ref
                ))
            })?;
            validate_resolved_representation(&entity, &stored.selected, &resolved_geometry)
                .map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(error.to_string())
                })?;
            required_json.extend([
                entity.components_ref.0.clone(),
                entity.attributes_ref.0.clone(),
                entity.relations_ref.0.clone(),
            ]);
            admissions.push(CanonicalRepresentationAdmission {
                entity,
                selected: stored.selected.clone(),
                representation_slot: stored.representation_slot.clone(),
                expected_generation: None,
                resolved_geometry,
            });
        }
        let metadata = inventory
            .objects
            .iter()
            .map(|object| (object.object_hash.0.clone(), object))
            .collect::<BTreeMap<_, _>>();
        let mut objects = Vec::with_capacity(required_json.len());
        for object_hash_text in required_json {
            let object_hash = ObjectHash(object_hash_text.clone());
            let stored = metadata.get(&object_hash_text).ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "required JSON object {object_hash:?} is absent"
                ))
            })?;
            let bytes = store.read_object(&object_hash)?;
            if stored.byte_length != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
                return Err(CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "required JSON object {object_hash:?} has the wrong length"
                )));
            }
            objects.push(CanonicalJsonObject {
                object_hash,
                media_type: stored.media_type.clone(),
                value: serde_json::from_slice(&bytes).map_err(|error| {
                    CanonicalAppRuntimeError::InvalidImportInventory(format!(
                        "required JSON object is invalid: {error}"
                    ))
                })?,
            });
        }
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: inventory.provider_id,
            provider_version: inventory.provider_version,
            admissions,
            objects,
            datasets: inventory.datasets,
            resource_sets: inventory.resource_sets,
            presentation_resources: inventory.presentation_resources,
        };
        package
            .validate()
            .map_err(|error| CanonicalAppRuntimeError::InvalidImportInventory(error.to_string()))?;
        Ok(package)
    }

    /// Recreates provider-relative immutable artifact layouts below a
    /// sidecar-owned execution root for exact passthrough exporters.
    pub fn materialize_import_artifacts(
        &self,
        command_id: &str,
        prepared_root: &Path,
    ) -> Result<(), CanonicalAppRuntimeError> {
        let store = self
            .store()
            .map_err(|_| CanonicalAppRuntimeError::ProjectNotOpen)?;
        let inventory = store
            .import_inventories()?
            .into_iter()
            .find(|inventory| inventory.command_id == command_id)
            .ok_or_else(|| {
                CanonicalAppRuntimeError::InvalidImportInventory(format!(
                    "unknown import command {command_id:?}"
                ))
            })?;
        let mut destinations = BTreeMap::<PathBuf, ObjectHash>::new();
        for dataset in &inventory.datasets {
            for artifact in &dataset.artifacts {
                let destination = prepared_root
                    .join(&dataset.dataset_id)
                    .join(&artifact.relative_path);
                register_materialized_destination(
                    &mut destinations,
                    destination,
                    artifact.resource.object_hash.clone(),
                )?;
            }
        }
        for resource_set in &inventory.resource_sets {
            for artifact in &resource_set.resources {
                let destination = prepared_root.join(&artifact.relative_path);
                register_materialized_destination(
                    &mut destinations,
                    destination,
                    artifact.resource.object_hash.clone(),
                )?;
            }
        }
        for (destination, object_hash) in destinations {
            store.materialize_object(&object_hash, destination)?;
        }
        Ok(())
    }

    /// Dispatches one versioned application request and always returns a
    /// correlated protocol response, including structured failures.
    #[must_use]
    pub fn dispatch(
        &mut self,
        envelope: AppProtocolRequestEnvelope,
    ) -> AppProtocolResponseEnvelope {
        let request_id = envelope.request_id.clone();
        let extensions = envelope.extensions.clone();
        let response = match validate_request_envelope(&envelope) {
            Ok(()) => self.dispatch_valid(envelope.request),
            Err(error) => AppProtocolResponse::Error(map_envelope_error(error)),
        };
        AppProtocolResponseEnvelope {
            schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
            request_id,
            response,
            extensions,
        }
    }

    fn dispatch_valid(&mut self, request: AppProtocolRequest) -> AppProtocolResponse {
        let result = match request {
            AppProtocolRequest::ReadPropertySchemas => {
                return AppProtocolResponse::PropertySchemas(vec![
                    canonical_entity_property_schema(),
                ]);
            }
            AppProtocolRequest::ReadDocumentSnapshot => self.store().map(|store| {
                AppProtocolResponse::DocumentSnapshot(AppDocumentSnapshot::from_document(
                    store.document(),
                ))
            }),
            AppProtocolRequest::ReadJournal(request) => self.store().and_then(|store| {
                read_journal_page(store.document(), request)
                    .map(AppProtocolResponse::JournalPage)
                    .map_err(CanonicalAppDispatchError::from)
            }),
            AppProtocolRequest::QueryProperties(request) => self.store().and_then(|store| {
                query_properties(store.document(), &request)
                    .map(AppProtocolResponse::PropertyQuery)
                    .map_err(CanonicalAppDispatchError::from)
            }),
            AppProtocolRequest::CompilePropertyEdit(request) => self.store().and_then(|store| {
                compile_multi_entity_property_edit(store.document(), &request)
                    .map(AppProtocolResponse::CompiledTransaction)
                    .map_err(CanonicalAppDispatchError::from)
            }),
            AppProtocolRequest::ExecuteCanonicalTransaction(transaction) => {
                self.dispatch_store_mut().and_then(|store| {
                    validate_transaction_object_refs(store, &transaction)?;
                    store
                        .commit_transaction(transaction)
                        .map(AppProtocolResponse::TransactionAccepted)
                        .map_err(CanonicalAppDispatchError::from)
                })
            }
        };
        result.unwrap_or_else(|error| AppProtocolResponse::Error(error.into_protocol_error()))
    }

    fn store(&self) -> Result<&CanonicalProjectStore, CanonicalAppDispatchError> {
        self.store
            .as_ref()
            .ok_or(CanonicalAppDispatchError::ProjectNotOpen)
    }

    fn store_mut(&mut self) -> Result<&mut CanonicalProjectStore, CanonicalAppRuntimeError> {
        self.store
            .as_mut()
            .ok_or(CanonicalAppRuntimeError::ProjectNotOpen)
    }

    fn dispatch_store_mut(
        &mut self,
    ) -> Result<&mut CanonicalProjectStore, CanonicalAppDispatchError> {
        self.store
            .as_mut()
            .ok_or(CanonicalAppDispatchError::ProjectNotOpen)
    }
}

fn registration_sample_error(error: ImportRegistrationRuntimeError) -> CanonicalAppRuntimeError {
    CanonicalAppRuntimeError::RegistrationSamples(error.to_string())
}

fn register_materialized_destination(
    destinations: &mut BTreeMap<PathBuf, ObjectHash>,
    destination: PathBuf,
    object_hash: ObjectHash,
) -> Result<(), CanonicalAppRuntimeError> {
    if destinations
        .insert(destination, object_hash.clone())
        .is_some_and(|existing| existing != object_hash)
    {
        return Err(CanonicalAppRuntimeError::InvalidImportInventory(
            "two immutable artifacts require the same provider-relative path".to_owned(),
        ));
    }
    Ok(())
}

fn validate_residency_dataset(
    store: &CanonicalProjectStore,
    dataset: &CanonicalPreparedDataset,
) -> Result<(), CanonicalAppRuntimeError> {
    let root_artifact = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.resource.object_hash == dataset.root_metadata.object_hash)
        .ok_or_else(|| {
            CanonicalAppRuntimeError::InvalidResidency(format!(
                "dataset {:?} has no root-metadata artifact",
                dataset.dataset_id
            ))
        })?;
    if root_artifact.resource != dataset.root_metadata {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "dataset {:?} root metadata differs from its artifact inventory",
            dataset.dataset_id
        )));
    }
    for artifact in &dataset.artifacts {
        let observed = store.object_byte_length(&artifact.resource.object_hash)?;
        if artifact
            .resource
            .byte_length
            .is_some_and(|expected| expected != observed)
        {
            return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
                "dataset {:?} artifact {:?} has the wrong byte length",
                dataset.dataset_id, artifact.relative_path
            )));
        }
    }
    // Root metadata is small and controls all subsequent streaming. Re-read it
    // through the hash-verifying object API before issuing any residency URL.
    let root_bytes = store.read_object(&dataset.root_metadata.object_hash)?;
    if dataset
        .root_metadata
        .byte_length
        .is_some_and(|expected| expected != u64::try_from(root_bytes.len()).unwrap_or(u64::MAX))
    {
        return Err(CanonicalAppRuntimeError::InvalidResidency(format!(
            "dataset {:?} root metadata has the wrong byte length",
            dataset.dataset_id
        )));
    }
    Ok(())
}

#[derive(Default)]
struct ResolvedAutomationArtifact {
    source_entity: Option<himmelcad_core::canonical_document::EntityVersionRef>,
    typed_artifact: Option<TypedArtifactDescriptor>,
    representation_slot: Option<String>,
    geometry_ref: Option<ObjectHash>,
}

fn resolve_automation_artifact(
    store: &CanonicalProjectStore,
    object_hash: &ObjectHash,
) -> Result<ResolvedAutomationArtifact, CanonicalAppRuntimeError> {
    let mut bindings = Vec::new();
    let mut descriptors = Vec::new();
    for inventory in store.import_inventories()? {
        for dataset in &inventory.datasets {
            if !dataset
                .artifacts
                .iter()
                .any(|artifact| artifact.resource.object_hash == *object_hash)
            {
                continue;
            }
            if let Some(binding) = live_inventory_binding(
                store,
                &inventory,
                &dataset.entity_id,
                &dataset.representation_slot,
            ) {
                bindings.push(binding);
            }
            if let Some(manifest_artifact) = dataset.typed_artifact_manifest() {
                let bytes = store.read_object(&manifest_artifact.resource.object_hash)?;
                let manifest: TypedArtifactManifest =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(format!(
                            "typed artifact manifest for dataset {:?} is invalid: {error}",
                            dataset.dataset_id
                        ))
                    })?;
                dataset
                    .validate_typed_artifact_layouts(&manifest)
                    .map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(error.to_string())
                    })?;
                descriptors.extend(
                    manifest
                        .artifacts
                        .into_iter()
                        .filter(|descriptor| descriptor.resource.object_hash == *object_hash),
                );
            }
        }
        if inventory.resource_sets.iter().any(|resource_set| {
            resource_set
                .resources
                .iter()
                .any(|artifact| artifact.resource.object_hash == *object_hash)
        }) {
            for admission in &inventory.admissions {
                let Some(binding) = live_inventory_binding(
                    store,
                    &inventory,
                    &admission.entity_id,
                    &admission.representation_slot,
                ) else {
                    continue;
                };
                let geometry = store.read_object(&admission.geometry_ref)?;
                let value: serde_json::Value =
                    serde_json::from_slice(&geometry).map_err(|error| {
                        CanonicalAppRuntimeError::InvalidResidency(format!(
                            "resolved geometry {:?} is invalid: {error}",
                            admission.geometry_ref
                        ))
                    })?;
                if value_references_object_hash(&value, object_hash.as_str()) {
                    bindings.push(binding);
                }
            }
        }
    }
    bindings.sort_by(|left, right| {
        (&left.0.id.0, &left.1, &left.2 .0).cmp(&(&right.0.id.0, &right.1, &right.2 .0))
    });
    bindings.dedup();
    let typed_artifact = descriptors
        .first()
        .filter(|first| descriptors.iter().all(|descriptor| descriptor == *first))
        .cloned();
    let (source_entity, representation_slot, geometry_ref) = if bindings.len() == 1 {
        let (entity, slot, geometry_ref) = bindings.remove(0);
        (Some(entity), Some(slot), Some(geometry_ref))
    } else {
        (None, None, None)
    };
    Ok(ResolvedAutomationArtifact {
        source_entity,
        typed_artifact,
        representation_slot,
        geometry_ref,
    })
}

fn live_inventory_binding(
    store: &CanonicalProjectStore,
    inventory: &CanonicalImportInventory,
    entity_id: &str,
    representation_slot: &str,
) -> Option<(
    himmelcad_core::canonical_document::EntityVersionRef,
    String,
    ObjectHash,
)> {
    let admission = inventory.admissions.iter().find(|admission| {
        admission.entity_id == entity_id && admission.representation_slot == representation_slot
    })?;
    let entity = store.document().entity(&EntityId(entity_id.to_owned()))?;
    if admission.geometry_ref != admission.selected.geometry_ref
        || !entity.representations.contains(&admission.selected)
    {
        return None;
    }
    Some((
        himmelcad_core::canonical_document::EntityVersionRef {
            id: entity.id.clone(),
            revision: entity.revision,
            version_hash: entity.version_hash.clone(),
        },
        representation_slot.to_owned(),
        admission.geometry_ref.clone(),
    ))
}

fn value_references_object_hash(value: &serde_json::Value, object_hash: &str) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            object.get("objectHash").and_then(serde_json::Value::as_str) == Some(object_hash)
                || object
                    .values()
                    .any(|child| value_references_object_hash(child, object_hash))
        }
        serde_json::Value::Array(values) => values
            .iter()
            .any(|child| value_references_object_hash(child, object_hash)),
        _ => false,
    }
}

fn seed_project_root(
    store: &mut CanonicalProjectStore,
    project_root: &Path,
) -> Result<(), CanonicalProjectStoreError> {
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({ "schemaId": "hcad.components@1" }),
    )?;
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({ "schemaId": "hcad.attributes@1" }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
    )?;
    store.put_json_object(&components)?;
    store.put_json_object(&attributes)?;
    store.put_json_object(&relations)?;
    let name = project_root
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("Untitled")
        .to_owned();
    let mut root = CanonicalEntity {
        id: EntityId("project-root".to_owned()),
        revision: 0,
        type_id: EntityTypeId(built_in_type::GROUP.to_owned()),
        name,
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: Vec::new(),
        components_ref: components.object_hash,
        attributes_ref: attributes.object_hash,
        relations_ref: relations.object_hash,
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending"),
    };
    root.version_hash = canonical_entity_version_hash(&root)
        .map_err(|_| CanonicalProjectStoreError::CommitInvariant)?;
    store.commit_transaction(CanonicalCommandTransaction {
        command_id: "system.create-project-root@1".to_owned(),
        mutations: vec![CanonicalEntityMutation::Create { entity: root }],
    })?;
    Ok(())
}

#[derive(Debug, Error)]
enum CanonicalAppDispatchError {
    #[error("no canonical project is open")]
    ProjectNotOpen,
    #[error(transparent)]
    Journal(#[from] AppJournalReadError),
    #[error(transparent)]
    Property(#[from] PropertySchemaError),
    #[error(transparent)]
    Store(#[from] CanonicalProjectStoreError),
    #[error("canonical transaction references missing object {0:?}")]
    MissingObject(ObjectHash),
}

impl CanonicalAppDispatchError {
    fn into_protocol_error(self) -> AppProtocolError {
        let code = match &self {
            Self::ProjectNotOpen => "hcad.app.project-not-open",
            Self::Journal(AppJournalReadError::InvalidLimit) => "hcad.app.journal.invalid-limit",
            Self::Journal(AppJournalReadError::SequenceAheadOfJournal) => {
                "hcad.app.journal.cursor-ahead"
            }
            Self::Property(PropertySchemaError::Canonical(error)) => document_error_code(error),
            Self::Property(_) => "hcad.app.property.invalid-request",
            Self::Store(CanonicalProjectStoreError::Document(error)) => document_error_code(error),
            Self::Store(_) => "hcad.app.store.failure",
            Self::MissingObject(_) => "hcad.app.object.not-found",
        };
        AppProtocolError {
            code: code.to_owned(),
            message: self.to_string(),
            details: BTreeMap::new(),
        }
    }
}

fn validate_transaction_object_refs(
    store: &CanonicalProjectStore,
    transaction: &CanonicalCommandTransaction,
) -> Result<(), CanonicalAppDispatchError> {
    let mut references = Vec::new();
    for mutation in &transaction.mutations {
        match mutation {
            CanonicalEntityMutation::Create { entity }
            | CanonicalEntityMutation::Restore {
                snapshot: entity, ..
            } => collect_entity_object_refs(entity, &mut references),
            CanonicalEntityMutation::Update { edits, .. } => {
                for edit in edits {
                    match edit {
                        CanonicalEntityEdit::SetRepresentations { representations } => references
                            .extend(
                                representations
                                    .iter()
                                    .map(|representation| &representation.geometry_ref),
                            ),
                        CanonicalEntityEdit::SetComponentsRef { components_ref } => {
                            references.push(components_ref);
                        }
                        CanonicalEntityEdit::SetAttributesRef { attributes_ref } => {
                            references.push(attributes_ref);
                        }
                        CanonicalEntityEdit::SetRelationsRef { relations_ref } => {
                            references.push(relations_ref);
                        }
                        CanonicalEntityEdit::SetStyleRef {
                            style_ref: Some(style_ref),
                        } => references.push(style_ref),
                        CanonicalEntityEdit::SetName { .. }
                        | CanonicalEntityEdit::SetOwner { .. }
                        | CanonicalEntityEdit::SetLayerIds { .. }
                        | CanonicalEntityEdit::SetPlacement { .. }
                        | CanonicalEntityEdit::SetStyleRef { style_ref: None } => {}
                    }
                }
            }
            CanonicalEntityMutation::Delete { .. } => {}
        }
    }
    references.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
    references.dedup();
    for object_hash in references {
        if !store.contains_object(object_hash)? {
            return Err(CanonicalAppDispatchError::MissingObject(
                object_hash.clone(),
            ));
        }
    }
    Ok(())
}

fn collect_entity_object_refs<'a>(
    entity: &'a CanonicalEntity,
    references: &mut Vec<&'a ObjectHash>,
) {
    references.push(&entity.components_ref);
    references.push(&entity.attributes_ref);
    references.push(&entity.relations_ref);
    if let Some(style_ref) = &entity.style_ref {
        references.push(style_ref);
    }
    references.extend(
        entity
            .representations
            .iter()
            .map(|representation| &representation.geometry_ref),
    );
}

fn document_error_code(error: &CanonicalDocumentError) -> &'static str {
    match error {
        CanonicalDocumentError::VersionConflict { .. }
        | CanonicalDocumentError::PreparedTransactionStale
        | CanonicalDocumentError::DuplicateCommandId => "hcad.app.document.conflict",
        CanonicalDocumentError::EntityNotFound { .. }
        | CanonicalDocumentError::TombstoneNotFound { .. }
        | CanonicalDocumentError::CommandUnavailable { .. } => "hcad.app.document.not-found",
        _ => "hcad.app.document.invalid-transaction",
    }
}

fn map_envelope_error(error: AppProtocolEnvelopeError) -> AppProtocolError {
    AppProtocolError {
        code: match error {
            AppProtocolEnvelopeError::UnsupportedSchema => "hcad.app.protocol.unsupported-schema",
            AppProtocolEnvelopeError::InvalidRequestId => "hcad.app.protocol.invalid-request-id",
        }
        .to_owned(),
        message: error.to_string(),
        details: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use himmelcad_core::app_protocol::{
        AppJournalReadRequest, AppProtocolExtensions, AppProtocolRequest,
        AppProtocolRequestEnvelope, AppProtocolResponse, APP_PROTOCOL_SCHEMA_ID,
    };
    use himmelcad_core::canonical_document::{
        CanonicalCommandTransaction, CanonicalEntityMutation, EntityVersionRef,
    };
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        built_in_type, CanonicalEntity, EntityTypeId, GeometryResource, Representation,
        RepresentationAuthority, RepresentationRole, StreamedGeometry,
    };
    use himmelcad_core::entity_validation::{
        canonical_entity_version_hash, geometry_object_content_hash,
    };
    use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
    use himmelcad_core::hash::ObjectHash;
    use himmelcad_core::typed_artifact::{
        ArtifactElementType, ArtifactEndianness, TypedArtifactDescriptor, TypedArtifactLayout,
        TypedArtifactManifest, TYPED_ARTIFACT_MANIFEST_NAME,
    };
    use himmelcad_io::{
        CanonicalImportPackage, PreparedDatasetArtifact, StagedArtifactRoots,
        CANONICAL_IO_SCHEMA_VERSION,
    };
    use serde_json::json;

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn temp_project(label: &str) -> std::path::PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "himmelcad-app-runtime-{label}-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        path
    }

    fn entity(id: &str, name: &str) -> CanonicalEntity {
        let mut entity = CanonicalEntity {
            id: EntityId(id.to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::GROUP.to_owned()),
            name: name.to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: ObjectHash::of_bytes(b"components"),
            attributes_ref: ObjectHash::of_bytes(b"attributes"),
            relations_ref: ObjectHash::of_bytes(b"relations"),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        entity
    }

    fn staged_point_cloud(root: &Path) -> CanonicalStagedImport {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            json!({"schemaId": "hcad.components@1"}),
        )
        .expect("components");
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            json!({"pointCount": 1}),
        )
        .expect("attributes");
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            json!({"relations": []}),
        )
        .expect("relations");
        let metadata_bytes = br#"{"points":1,"boundingBox":{"min":[0,0,0],"max":[1,1,1]}}"#;
        let metadata = GeometryResource {
            object_hash: ObjectHash::of_bytes(metadata_bytes),
            media_type: "application/json".to_owned(),
            byte_length: Some(u64::try_from(metadata_bytes.len()).expect("length")),
        };
        let point_bytes = [0_f32, 0.5, 1.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let points = GeometryResource {
            object_hash: ObjectHash::of_bytes(&point_bytes),
            media_type: "hcad.positions-f32le-xyz@1".to_owned(),
            byte_length: Some(u64::try_from(point_bytes.len()).expect("point length")),
        };
        let typed_manifest = TypedArtifactManifest {
            schema_version: TypedArtifactManifest::SCHEMA_VERSION,
            artifacts: vec![TypedArtifactDescriptor {
                resource: points.clone(),
                semantic: "hcad.point-cloud.positions".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: points.byte_length.expect("point length"),
                    element_type: ArtifactElementType::Float32,
                    shape: vec![1, 3],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: None,
                },
            }],
        };
        let (typed_artifact, typed_bytes) = PreparedDatasetArtifact::typed_artifact_manifest(
            PathBuf::from(TYPED_ARTIFACT_MANIFEST_NAME),
            &typed_manifest,
        )
        .expect("typed manifest");
        let geometry = GeometryObject::PointCloud {
            dataset: StreamedGeometry {
                format_id: "potree@2".to_owned(),
                metadata: metadata.clone(),
                element_count: Some(1),
            },
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut cloud = CanonicalEntity {
            id: EntityId("cloud-a".to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: "Cloud".to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![selected.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending"),
        };
        cloud.version_hash = canonical_entity_version_hash(&cloud).expect("entity hash");
        let dataset_root = root.join("prepared-point-cloud");
        fs::create_dir_all(&dataset_root).expect("dataset root");
        fs::write(dataset_root.join("metadata.json"), metadata_bytes).expect("metadata");
        fs::write(dataset_root.join("points.bin"), point_bytes).expect("points");
        fs::write(dataset_root.join(TYPED_ARTIFACT_MANIFEST_NAME), typed_bytes)
            .expect("typed manifest");
        CanonicalStagedImport {
            package: CanonicalImportPackage {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: "test.potree@1".to_owned(),
                provider_version: "1".to_owned(),
                admissions: vec![CanonicalRepresentationAdmission {
                    entity: cloud,
                    selected,
                    representation_slot: "source".to_owned(),
                    expected_generation: None,
                    resolved_geometry: geometry,
                }],
                objects: vec![components, attributes, relations],
                datasets: vec![CanonicalPreparedDataset {
                    dataset_id: "dataset-a".to_owned(),
                    format_id: "potree@2".to_owned(),
                    entity_id: "cloud-a".to_owned(),
                    representation_slot: "source".to_owned(),
                    root_metadata: metadata.clone(),
                    artifacts: vec![
                        PreparedDatasetArtifact {
                            relative_path: PathBuf::from("metadata.json"),
                            resource: metadata,
                        },
                        PreparedDatasetArtifact {
                            relative_path: PathBuf::from("points.bin"),
                            resource: points,
                        },
                        typed_artifact,
                    ],
                }],
                resource_sets: Vec::new(),
                presentation_resources: Default::default(),
            },
            roots: StagedArtifactRoots {
                dataset_roots: BTreeMap::from([("dataset-a".to_owned(), dataset_root)]),
                resource_set_roots: BTreeMap::new(),
            },
        }
    }

    fn request(method: AppProtocolRequest) -> AppProtocolRequestEnvelope {
        AppProtocolRequestEnvelope {
            schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
            request_id: "request-1".to_owned(),
            request: method,
            extensions: AppProtocolExtensions::from([(
                "test.extension@1".to_owned(),
                json!({"opaque": [1, 2, 3]}),
            )]),
        }
    }

    #[test]
    fn protocol_commits_reopens_and_pages_the_durable_journal() {
        let root = temp_project("roundtrip");
        let mut runtime = CanonicalAppRuntime::default();
        let opened = runtime.open(&root).expect("open project");
        assert_eq!(
            runtime.open(&root).expect("idempotent reopen"),
            opened,
            "renderer reload must not replace or reject the same project"
        );
        let project_root = opened.entities[0].clone();

        let accepted = runtime.dispatch(request(AppProtocolRequest::ExecuteCanonicalTransaction(
            CanonicalCommandTransaction {
                command_id: "rename-project".to_owned(),
                mutations: vec![CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&project_root),
                    edits: vec![CanonicalEntityEdit::SetName {
                        name: "Renamed".to_owned(),
                    }],
                }],
            },
        )));
        assert_eq!(
            accepted.extensions["test.extension@1"],
            json!({"opaque": [1, 2, 3]})
        );
        let AppProtocolResponse::TransactionAccepted(entry) = accepted.response else {
            panic!("accepted transaction expected");
        };
        let renamed = entry.effects[0].after.clone().expect("renamed entity");
        assert!(runtime.close());

        let snapshot = runtime.open(&root).expect("reopen project");
        assert_eq!(snapshot.entities, vec![renamed]);
        let page = runtime.dispatch(request(AppProtocolRequest::ReadJournal(
            AppJournalReadRequest {
                after_sequence: 0,
                limit: 10,
            },
        )));
        let AppProtocolResponse::JournalPage(page) = page.response else {
            panic!("journal response expected");
        };
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.journal_head_sequence, 2);
        assert!(!page.has_more);

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn stale_property_selection_fails_closed_with_conflict_code() {
        let root = temp_project("conflict");
        let mut runtime = CanonicalAppRuntime::default();
        let snapshot = runtime.open(&root).expect("open project");
        let project_root = snapshot.entities[0].clone();

        let mut stale_hash = project_root.version_hash.clone();
        let replacement = if stale_hash.as_str().starts_with('0') {
            "1"
        } else {
            "0"
        };
        stale_hash.0.replace_range(0..1, replacement);
        let response = runtime.dispatch(request(AppProtocolRequest::QueryProperties(
            himmelcad_core::property_schema::PropertyQueryRequest {
                schema_id: himmelcad_core::property_schema::PROPERTY_QUERY_REQUEST_SCHEMA_ID
                    .to_owned(),
                entities: vec![EntityVersionRef {
                    id: project_root.id,
                    revision: 0,
                    version_hash: stale_hash,
                }],
                properties: Vec::new(),
            },
        )));
        let AppProtocolResponse::Error(error) = response.response else {
            panic!("structured conflict expected");
        };
        assert_eq!(error.code, "hcad.app.document.conflict");

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn canonical_create_rejects_unpublished_object_references() {
        let root = temp_project("missing-object");
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        let response = runtime.dispatch(request(AppProtocolRequest::ExecuteCanonicalTransaction(
            CanonicalCommandTransaction {
                command_id: "unsafe-create".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create {
                    entity: entity("unsafe", "Unsafe"),
                }],
            },
        )));
        let AppProtocolResponse::Error(error) = response.response else {
            panic!("missing object error expected");
        };
        assert_eq!(error.code, "hcad.app.object.not-found");

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn schemas_are_discoverable_without_an_open_project() {
        let mut runtime = CanonicalAppRuntime::default();
        let response = runtime.dispatch(request(AppProtocolRequest::ReadPropertySchemas));
        let AppProtocolResponse::PropertySchemas(schemas) = response.response else {
            panic!("property schemas expected");
        };
        assert_eq!(schemas.len(), 1);
    }

    #[test]
    fn residency_bootstrap_is_path_free_and_generation_bound() {
        let root = temp_project("residency-empty");
        let mut runtime = CanonicalAppRuntime::default();
        let snapshot = runtime.open(&root).expect("open project");
        let bootstrap = runtime.residency_bootstrap().expect("bootstrap");
        assert_eq!(bootstrap.schema_version, 1);
        assert_eq!(bootstrap.generation, snapshot.generation);
        assert!(bootstrap.entries.is_empty());
        let encoded = serde_json::to_string(&bootstrap).expect("encode bootstrap");
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn residency_reopens_exact_staged_point_cloud_and_filters_deleted_entity() {
        let root = temp_project("residency-point-cloud");
        let staged = staged_point_cloud(&root);
        let mut runtime = CanonicalAppRuntime::default();
        runtime.open(&root).expect("open project");
        runtime
            .publish_staged_import(&staged, "import-cloud")
            .expect("publish cloud");
        runtime.close();
        runtime.open(&root).expect("reopen project");

        let bootstrap = runtime.residency_bootstrap().expect("bootstrap");
        assert_eq!(bootstrap.entries.len(), 1);
        assert_eq!(bootstrap.entries[0].admission.entity.id.0, "cloud-a");
        assert_eq!(
            bootstrap.entries[0]
                .dataset
                .as_ref()
                .expect("dataset")
                .dataset_id,
            "dataset-a"
        );
        let encoded = serde_json::to_string(&bootstrap).expect("encode bootstrap");
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));

        let points = staged.package.datasets[0]
            .artifacts
            .iter()
            .find(|artifact| artifact.resource.media_type == "hcad.positions-f32le-xyz@1")
            .expect("typed point artifact");
        let source = runtime
            .automation_object_source(&points.resource.object_hash)
            .expect("resolve typed artifact");
        assert_eq!(
            source
                .source_entity
                .as_ref()
                .map(|entity| entity.id.0.as_str()),
            Some("cloud-a")
        );
        assert_eq!(source.representation_slot.as_deref(), Some("source"));
        assert_eq!(
            source.geometry_ref.as_ref(),
            Some(&bootstrap.entries[0].admission.selected.geometry_ref)
        );
        assert!(matches!(
            source.typed_artifact.as_ref().map(|artifact| &artifact.layout),
            Some(TypedArtifactLayout::DenseArray {
                element_type: ArtifactElementType::Float32,
                shape,
                byte_strides: None,
                ..
            }) if shape == &[1, 3]
        ));

        let reconstructed = runtime
            .reconstruct_import_package("import-cloud")
            .expect("reconstruct package after restart");
        assert_eq!(reconstructed.provider_id, staged.package.provider_id);
        assert_eq!(
            reconstructed.provider_version,
            staged.package.provider_version
        );
        assert_eq!(reconstructed.admissions, staged.package.admissions);
        assert_eq!(reconstructed.datasets, staged.package.datasets);
        assert_eq!(
            reconstructed.presentation_resources,
            staged.package.presentation_resources
        );
        let materialized = root.join("export-materialized");
        runtime
            .materialize_import_artifacts("import-cloud", &materialized)
            .expect("materialize exact artifact layout");
        assert_eq!(
            fs::read(materialized.join("dataset-a/metadata.json")).expect("metadata bytes"),
            fs::read(staged.roots.dataset_roots["dataset-a"].join("metadata.json"))
                .expect("source metadata")
        );

        let cloud = bootstrap.entries[0].admission.entity.clone();
        let deleted = runtime.dispatch(request(AppProtocolRequest::ExecuteCanonicalTransaction(
            CanonicalCommandTransaction {
                command_id: "delete-cloud".to_owned(),
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef::from_entity(&cloud),
                }],
            },
        )));
        assert!(matches!(
            deleted.response,
            AppProtocolResponse::TransactionAccepted(_)
        ));
        assert!(runtime
            .residency_bootstrap()
            .expect("bootstrap after delete")
            .entries
            .is_empty());

        runtime.close();
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
