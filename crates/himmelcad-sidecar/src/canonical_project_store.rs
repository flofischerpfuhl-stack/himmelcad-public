//! Durable render-independent storage for canonical project state.
//!
//! Immutable objects are published before a command journal record. Import commits use a
//! project-local transaction directory whose synchronized `ready.json` marker is the recovery
//! boundary. Once that marker exists, opening the store either completes the journal-last commit
//! or reports corruption; an entity command is never appended before every referenced payload and
//! inventory is durable.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use fs2::FileExt;
use himmelcad_core::canonical_document::{
    CanonicalCommandTransaction, CanonicalDocument, CanonicalDocumentError, CanonicalJournalEntry,
    PreparedCanonicalTransaction,
};
use himmelcad_core::canonical_resource_catalog::CanonicalPresentationResourceSet;
use himmelcad_core::entity_model::{GeometryResource, Representation};
use himmelcad_core::entity_validation::geometry_object_content_hash;
use himmelcad_core::hash::ObjectHash;
use himmelcad_io::{
    CanonicalImportPackage, CanonicalJsonObject, CanonicalPreparedDataset, CanonicalResourceSet,
    ProviderContractError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const STORE_SCHEMA_VERSION: u32 = 1;
static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Durable descriptor of one imported immutable payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalStoredObject {
    /// Exact immutable payload hash.
    pub object_hash: ObjectHash,
    /// Semantic media type recorded by the import provider.
    pub media_type: String,
    /// Exact persisted byte length.
    pub byte_length: u64,
}

/// Durable representation-slot binding retained independently of render residency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalStoredAdmission {
    /// Stable canonical entity identity.
    pub entity_id: String,
    /// Stable provider/project representation slot.
    pub representation_slot: String,
    /// Exact representation selected for the slot.
    pub selected: Representation,
    /// Content address of the persisted resolved geometry object.
    pub geometry_ref: ObjectHash,
}

/// Durable provider and artifact inventory published by one import command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalImportInventory {
    /// Store contract version.
    pub schema_version: u32,
    /// Command that made the imported entities visible.
    pub command_id: String,
    /// Provider identity that created the package.
    pub provider_id: String,
    /// Exact provider implementation version.
    pub provider_version: String,
    /// Small JSON and resolved geometry objects.
    pub objects: Vec<CanonicalStoredObject>,
    /// Representation slots required to reconstruct provider admissions later.
    pub admissions: Vec<CanonicalStoredAdmission>,
    /// Complete prepared-dataset artifact inventories.
    pub datasets: Vec<CanonicalPreparedDataset>,
    /// Complete non-streamed binary resource-set inventories.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_sets: Vec<CanonicalResourceSet>,
    /// Exact immutable presentation resources required to reconstruct the
    /// provider package for a later loss-aware export.
    ///
    /// Empty is the backward-compatible meaning for inventories written
    /// before this field existed. Keeping empty sets out of the compact JSON
    /// also preserves their existing inventory hashes.
    #[serde(default, skip_serializing_if = "presentation_resources_are_empty")]
    pub presentation_resources: CanonicalPresentationResourceSet,
}

fn presentation_resources_are_empty(resources: &CanonicalPresentationResourceSet) -> bool {
    resources.textures.is_empty()
        && resources.materials.is_empty()
        && resources.material_tables.is_empty()
        && resources.hatch_patterns.is_empty()
        && resources.line_types.is_empty()
        && resources.annotation_styles.is_empty()
}

/// Host-owned roots containing every provider-prepared package payload.
#[derive(Debug, Clone, Default)]
pub struct CanonicalImportSourceRoots {
    /// Source root for every `CanonicalPreparedDataset`, keyed by dataset ID.
    pub datasets: BTreeMap<String, PathBuf>,
    /// Source root for every `CanonicalResourceSet`, keyed by resource-set ID.
    pub resource_sets: BTreeMap<String, PathBuf>,
}

/// Successful durable import publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalImportCommit {
    /// Forward journal record that published the entities.
    pub journal_entry: CanonicalJournalEntry,
    /// Durable provider/artifact inventory.
    pub inventory: CanonicalImportInventory,
}

/// Hash-framed deterministic journal record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredJournalRecord {
    schema_version: u32,
    entry_hash: ObjectHash,
    entry: CanonicalJournalEntry,
}

impl StoredJournalRecord {
    fn new(entry: CanonicalJournalEntry) -> Result<Self, CanonicalProjectStoreError> {
        let entry_hash = compact_hash(&entry)?;
        Ok(Self {
            schema_version: STORE_SCHEMA_VERSION,
            entry_hash,
            entry,
        })
    }

    fn validate(&self) -> Result<(), CanonicalProjectStoreError> {
        if self.schema_version != STORE_SCHEMA_VERSION
            || compact_hash(&self.entry)? != self.entry_hash
        {
            return Err(CanonicalProjectStoreError::JournalHashMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDatasetInventory {
    schema_version: u32,
    inventory_hash: ObjectHash,
    dataset: CanonicalPreparedDataset,
}

impl StoredDatasetInventory {
    fn new(dataset: CanonicalPreparedDataset) -> Result<Self, CanonicalProjectStoreError> {
        let inventory_hash = compact_hash(&dataset)?;
        Ok(Self {
            schema_version: STORE_SCHEMA_VERSION,
            inventory_hash,
            dataset,
        })
    }

    fn validate(&self) -> Result<(), CanonicalProjectStoreError> {
        if self.schema_version != STORE_SCHEMA_VERSION
            || compact_hash(&self.dataset)? != self.inventory_hash
        {
            return Err(CanonicalProjectStoreError::InventoryHashMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredImportInventory {
    schema_version: u32,
    inventory_hash: ObjectHash,
    inventory: CanonicalImportInventory,
}

impl StoredImportInventory {
    fn new(inventory: CanonicalImportInventory) -> Result<Self, CanonicalProjectStoreError> {
        let inventory_hash = compact_hash(&inventory)?;
        Ok(Self {
            schema_version: STORE_SCHEMA_VERSION,
            inventory_hash,
            inventory,
        })
    }

    fn validate(&self) -> Result<(), CanonicalProjectStoreError> {
        if self.schema_version != STORE_SCHEMA_VERSION
            || compact_hash(&self.inventory)? != self.inventory_hash
        {
            return Err(CanonicalProjectStoreError::InventoryHashMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingDatasetFile {
    dataset_id: String,
    content_hash: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingCanonicalCommit {
    schema_version: u32,
    command_hash: ObjectHash,
    journal: StoredJournalRecord,
    object_hashes: Vec<ObjectHash>,
    dataset_files: Vec<PendingDatasetFile>,
    import_inventory_hash: Option<ObjectHash>,
}

impl PendingCanonicalCommit {
    fn validate(&self, transaction_name: &str) -> Result<(), CanonicalProjectStoreError> {
        self.journal.validate()?;
        if self.schema_version != STORE_SCHEMA_VERSION
            || self.command_hash != ObjectHash::of_bytes(self.journal.entry.command_id.as_bytes())
            || self.command_hash.as_str() != transaction_name
            || !unique_hashes(&self.object_hashes)
            || !unique_dataset_files(&self.dataset_files)
        {
            return Err(CanonicalProjectStoreError::InvalidPendingTransaction);
        }
        Ok(())
    }
}

/// Durable canonical project state with an exclusive process lock.
pub struct CanonicalProjectStore {
    root: PathBuf,
    document: CanonicalDocument,
    dataset_ids: BTreeSet<String>,
    resource_set_ids: BTreeSet<String>,
    lock: File,
}

/// Persistence or recovery rejection from the canonical project store.
#[derive(Debug, Error)]
pub enum CanonicalProjectStoreError {
    /// Filesystem operation failed.
    #[error("canonical project I/O: {0}")]
    Io(#[from] io::Error),
    /// Stored JSON is truncated or malformed.
    #[error("canonical project JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// Canonical document validation rejected a transaction or replay.
    #[error("canonical document: {0}")]
    Document(#[from] CanonicalDocumentError),
    /// Import provider package validation failed.
    #[error("canonical import package: {0}")]
    Provider(#[from] ProviderContractError),
    /// Another process currently owns the canonical store.
    #[error("canonical project store is already locked")]
    Locked,
    /// A supplied or stored SHA-256 identifier is malformed.
    #[error("canonical object hash is malformed")]
    InvalidHash,
    /// Immutable bytes do not match their declared content address.
    #[error("canonical object hash mismatch: expected {expected:?}, observed {observed:?}")]
    ObjectHashMismatch {
        expected: ObjectHash,
        observed: ObjectHash,
    },
    /// Immutable bytes do not match their declared exact length.
    #[error("canonical object length mismatch: expected {expected}, observed {observed}")]
    ObjectLengthMismatch { expected: u64, observed: u64 },
    /// A provider JSON object has no semantic media type.
    #[error("canonical JSON object media type is invalid")]
    InvalidJsonObject,
    /// One content address was previously catalogued with incompatible metadata.
    #[error("canonical object metadata conflicts with an existing catalogue entry")]
    ObjectMetadataConflict,
    /// A hash-framed journal record was modified.
    #[error("canonical journal record hash mismatch")]
    JournalHashMismatch,
    /// Journal filenames, sequence, or directory contents are inconsistent.
    #[error("canonical journal layout is invalid")]
    InvalidJournalLayout,
    /// A persisted import or dataset inventory was modified.
    #[error("canonical import inventory hash mismatch")]
    InventoryHashMismatch,
    /// A stable dataset identity is already published by this project.
    #[error("canonical dataset id {dataset_id:?} is already published")]
    DuplicateDatasetId { dataset_id: String },
    /// The host omitted a source root for a prepared dataset.
    #[error("canonical dataset {dataset_id:?} has no prepared source root")]
    MissingDatasetRoot { dataset_id: String },
    /// The host supplied a source root absent from the package.
    #[error("canonical dataset source root {dataset_id:?} is not used by the package")]
    UnexpectedDatasetRoot { dataset_id: String },
    /// A stable immutable resource-set identity is already published by this project.
    #[error("canonical resource set id {resource_set_id:?} is already published")]
    DuplicateResourceSetId { resource_set_id: String },
    /// The host omitted a source root for an immutable resource set.
    #[error("canonical resource set {resource_set_id:?} has no prepared source root")]
    MissingResourceSetRoot { resource_set_id: String },
    /// The host supplied a resource-set source root absent from the package.
    #[error("canonical resource set source root {resource_set_id:?} is not used by the package")]
    UnexpectedResourceSetRoot { resource_set_id: String },
    /// A non-streamed immutable geometry resource omitted its exact byte length.
    #[error("canonical immutable resource has no exact byte length")]
    MissingResourceLength,
    /// An artifact resolves outside its canonical prepared-dataset root.
    #[error("canonical artifact source escapes its prepared dataset root")]
    UnsafeArtifactSource,
    /// A synchronized transaction marker is malformed or inconsistent.
    #[error("canonical pending transaction is invalid")]
    InvalidPendingTransaction,
    /// Publication reached its durable recovery boundary but needs reopening to finish.
    #[error(
        "canonical transaction is ready and must be recovered from {transaction_dir:?}: {reason}"
    )]
    CommitPending {
        transaction_dir: PathBuf,
        reason: String,
    },
    /// A supposedly infallible in-memory commit diverged from its durable record.
    #[error("canonical durable/in-memory commit invariant failed")]
    CommitInvariant,
}

impl CanonicalProjectStore {
    /// Opens or creates the canonical project area, recovers ready commits, and replays history.
    pub fn open(project_root: impl AsRef<Path>) -> Result<Self, CanonicalProjectStoreError> {
        let root = project_root.as_ref().to_path_buf();
        ensure_layout(&root)?;
        let lock_path = canonical_root(&root).join("store.lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock_exclusive()
            .map_err(|error| match error.kind() {
                io::ErrorKind::WouldBlock => CanonicalProjectStoreError::Locked,
                _ => CanonicalProjectStoreError::Io(error),
            })?;

        let mut store = Self {
            root,
            document: CanonicalDocument::default(),
            dataset_ids: BTreeSet::new(),
            resource_set_ids: BTreeSet::new(),
            lock,
        };
        store.document = store.load_document()?;
        (store.dataset_ids, store.resource_set_ids) = store.load_inventory_ids()?;
        store.recover_pending_transactions()?;
        store.document = store.load_document()?;
        (store.dataset_ids, store.resource_set_ids) = store.load_inventory_ids()?;
        Ok(store)
    }

    /// Current replayed canonical document authority.
    #[must_use]
    pub const fn document(&self) -> &CanonicalDocument {
        &self.document
    }

    /// Project root containing the canonical store and immutable objects.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Persists and commits one ordinary canonical command transaction.
    pub fn commit_transaction(
        &mut self,
        transaction: CanonicalCommandTransaction,
    ) -> Result<CanonicalJournalEntry, CanonicalProjectStoreError> {
        let prepared = self.document.prepare_transaction(transaction)?;
        self.publish_prepared(prepared, Vec::new(), Vec::new(), None)
    }

    /// Persists one compensating undo as a new forward journal entry.
    pub fn commit_undo(
        &mut self,
        command_id: String,
        target_command_id: &str,
    ) -> Result<CanonicalJournalEntry, CanonicalProjectStoreError> {
        let prepared = self.document.prepare_undo(command_id, target_command_id)?;
        self.publish_prepared(prepared, Vec::new(), Vec::new(), None)
    }

    /// Persists one compensating redo as a new forward journal entry.
    pub fn commit_redo(
        &mut self,
        command_id: String,
        target_command_id: &str,
    ) -> Result<CanonicalJournalEntry, CanonicalProjectStoreError> {
        let prepared = self.document.prepare_redo(command_id, target_command_id)?;
        self.publish_prepared(prepared, Vec::new(), Vec::new(), None)
    }

    /// Stores one provider JSON object under the hash of its compact value bytes.
    pub fn put_json_object(
        &self,
        object: &CanonicalJsonObject,
    ) -> Result<ObjectHash, CanonicalProjectStoreError> {
        if object.media_type.trim().is_empty() {
            return Err(CanonicalProjectStoreError::InvalidJsonObject);
        }
        let bytes = serde_json::to_vec(&object.value)?;
        let object_hash = self.put_immutable_bytes(&object.object_hash, &bytes)?;
        self.write_object_metadata(&CanonicalStoredObject {
            object_hash: object_hash.clone(),
            media_type: object.media_type.clone(),
            byte_length: usize_length(bytes.len())?,
        })?;
        Ok(object_hash)
    }

    /// Stores immutable bytes without overwriting an existing content address.
    pub fn put_immutable_bytes(
        &self,
        expected_hash: &ObjectHash,
        bytes: &[u8],
    ) -> Result<ObjectHash, CanonicalProjectStoreError> {
        validate_hash(expected_hash)?;
        let observed = ObjectHash::of_bytes(bytes);
        if observed != *expected_hash {
            return Err(CanonicalProjectStoreError::ObjectHashMismatch {
                expected: expected_hash.clone(),
                observed,
            });
        }
        let destination = object_path(&self.root, expected_hash)?;
        let byte_length = usize_length(bytes.len())?;
        if destination.exists() {
            verify_file(&destination, expected_hash, Some(byte_length))?;
            return Ok(expected_hash.clone());
        }
        let temporary = unique_staging_file(&self.root, "object");
        write_new_synced(&temporary, bytes)?;
        let publish_result =
            publish_immutable_file(&temporary, &destination, expected_hash, Some(byte_length));
        let _ = fs::remove_file(&temporary);
        publish_result?;
        Ok(expected_hash.clone())
    }

    /// Reads and hash-verifies one immutable object lazily.
    pub fn read_object(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<Vec<u8>, CanonicalProjectStoreError> {
        let path = object_path(&self.root, object_hash)?;
        let bytes = fs::read(&path)?;
        let observed = ObjectHash::of_bytes(&bytes);
        if observed != *object_hash {
            return Err(CanonicalProjectStoreError::ObjectHashMismatch {
                expected: object_hash.clone(),
                observed,
            });
        }
        Ok(bytes)
    }

    /// Checks whether one well-formed content address is present without
    /// loading its payload.
    pub fn contains_object(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<bool, CanonicalProjectStoreError> {
        validate_hash(object_hash)?;
        Ok(object_path(&self.root, object_hash)?.is_file())
    }

    /// Returns the exact current byte length of one well-formed immutable
    /// object without exposing its host path. The content hash was verified
    /// before publication; small bootstrap objects are additionally re-read
    /// and hash-verified by the residency resolver.
    pub fn object_byte_length(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<u64, CanonicalProjectStoreError> {
        validate_hash(object_hash)?;
        Ok(fs::metadata(object_path(&self.root, object_hash)?)?.len())
    }

    /// Materializes one verified immutable object at a host-owned execution
    /// path. This is used only inside the sidecar when a provider requires its
    /// portable relative artifact layout for export; the path is never part of
    /// the renderer contract.
    pub fn materialize_object(
        &self,
        object_hash: &ObjectHash,
        destination: impl AsRef<Path>,
    ) -> Result<(), CanonicalProjectStoreError> {
        let source = object_path(&self.root, object_hash)?;
        verify_file(&source, object_hash, None)?;
        let destination = destination.as_ref();
        let parent = destination
            .parent()
            .ok_or(CanonicalProjectStoreError::UnsafeArtifactSource)?;
        fs::create_dir_all(parent)?;
        if destination.exists() {
            verify_file(destination, object_hash, None)?;
            return Ok(());
        }
        match fs::hard_link(&source, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                fs::copy(&source, destination)?;
            }
            Err(error) => return Err(error.into()),
        }
        verify_file(destination, object_hash, None)
    }

    /// Reads the semantic media type and exact byte length of an object written
    /// through the general object service.
    pub fn read_object_metadata(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<CanonicalStoredObject, CanonicalProjectStoreError> {
        let path = object_metadata_path(&self.root, object_hash)?;
        let metadata: CanonicalStoredObject = serde_json::from_slice(&fs::read(path)?)?;
        if metadata.object_hash != *object_hash
            || metadata.media_type.trim().is_empty()
            || metadata.byte_length == 0
        {
            return Err(CanonicalProjectStoreError::ObjectMetadataConflict);
        }
        verify_file(
            &object_path(&self.root, object_hash)?,
            object_hash,
            Some(metadata.byte_length),
        )?;
        Ok(metadata)
    }

    /// Resolves one immutable CAS object for another trusted sidecar runtime.
    ///
    /// The returned open handle is process-internal and must never cross an
    /// RPC or renderer boundary. The complete object is hash-verified through
    /// that exact handle before it is admitted as a ranged-read source.
    pub(crate) fn verified_object_source(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<(CanonicalStoredObject, File), CanonicalProjectStoreError> {
        let metadata = match self.read_object_metadata(object_hash) {
            Ok(metadata) => metadata,
            Err(CanonicalProjectStoreError::Io(error))
                if error.kind() == io::ErrorKind::NotFound =>
            {
                self.imported_object_metadata(object_hash)?
            }
            Err(error) => return Err(error),
        };
        let path = object_path(&self.root, object_hash)?;
        let mut source = File::open(path)?;
        verify_open_file(&mut source, object_hash, Some(metadata.byte_length))?;
        source.seek(SeekFrom::Start(0))?;
        Ok((metadata, source))
    }

    fn imported_object_metadata(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<CanonicalStoredObject, CanonicalProjectStoreError> {
        let mut resolved = None;
        for inventory in self.import_inventories()? {
            for metadata in inventory
                .objects
                .into_iter()
                .filter(|metadata| metadata.object_hash == *object_hash)
            {
                if resolved
                    .as_ref()
                    .is_some_and(|existing| existing != &metadata)
                {
                    return Err(CanonicalProjectStoreError::ObjectMetadataConflict);
                }
                resolved = Some(metadata);
            }
        }
        resolved.ok_or_else(|| {
            CanonicalProjectStoreError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                "canonical object metadata was not found",
            ))
        })
    }

    /// Returns validated import inventories in stable command-id order.
    pub fn import_inventories(
        &self,
    ) -> Result<Vec<CanonicalImportInventory>, CanonicalProjectStoreError> {
        let mut inventories = Vec::new();
        for entry in fs::read_dir(canonical_root(&self.root).join("imports"))? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                return Err(CanonicalProjectStoreError::InvalidJournalLayout);
            }
            let stored: StoredImportInventory = serde_json::from_slice(&fs::read(entry.path())?)?;
            stored.validate()?;
            if entry.file_name()
                != import_inventory_path(&self.root, &stored.inventory.command_id)
                    .file_name()
                    .ok_or(CanonicalProjectStoreError::InvalidJournalLayout)?
            {
                return Err(CanonicalProjectStoreError::InvalidJournalLayout);
            }
            inventories.push(stored.inventory);
        }
        inventories.sort_by(|left, right| left.command_id.cmp(&right.command_id));
        Ok(inventories)
    }

    /// Returns a bounded journal suffix after an already observed sequence.
    pub fn journal_since(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<CanonicalJournalEntry>, CanonicalProjectStoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        Ok(self
            .document
            .journal()
            .iter()
            .filter(|entry| entry.sequence > after_sequence)
            .take(limit)
            .cloned()
            .collect())
    }

    fn write_object_metadata(
        &self,
        metadata: &CanonicalStoredObject,
    ) -> Result<(), CanonicalProjectStoreError> {
        let destination = object_metadata_path(&self.root, &metadata.object_hash)?;
        let bytes = serde_json::to_vec(metadata)?;
        if destination.exists() {
            let existing: CanonicalStoredObject = serde_json::from_slice(&fs::read(destination)?)?;
            if existing != *metadata {
                return Err(CanonicalProjectStoreError::ObjectMetadataConflict);
            }
            return Ok(());
        }
        let temporary = unique_staging_file(&self.root, "object-metadata");
        write_new_synced(&temporary, &bytes)?;
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => sync_dir(
                destination
                    .parent()
                    .ok_or(CanonicalProjectStoreError::ObjectMetadataConflict)?,
            )?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let existing: CanonicalStoredObject =
                    serde_json::from_slice(&fs::read(&destination)?)?;
                if existing != *metadata {
                    let _ = fs::remove_file(&temporary);
                    return Err(CanonicalProjectStoreError::ObjectMetadataConflict);
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(CanonicalProjectStoreError::Io(error));
            }
        }
        let _ = fs::remove_file(temporary);
        Ok(())
    }

    /// Validates, stages and durably publishes an entire canonical import package.
    ///
    /// `source_roots` maps every package dataset and resource-set ID to its provider-prepared
    /// directory containing the declared relative artifacts. JSON objects, resolved geometry and
    /// artifacts become immutable project objects; the entity-create command is linked into the
    /// journal last.
    #[allow(clippy::too_many_lines)]
    pub fn publish_import_package(
        &mut self,
        package: &CanonicalImportPackage,
        source_roots: &CanonicalImportSourceRoots,
        command_id: &str,
    ) -> Result<CanonicalImportCommit, CanonicalProjectStoreError> {
        package.validate()?;
        self.validate_source_roots(package, source_roots)?;
        let transaction = package.entity_create_transaction(command_id.to_owned())?;
        let prepared = self.document.prepare_transaction(transaction)?;

        let transaction_dir = self.create_transaction_dir(command_id)?;
        let mut cleanup = StagingGuard::new(transaction_dir.clone());
        let staged_objects = transaction_dir.join("objects");
        fs::create_dir_all(&staged_objects)?;

        let mut stored_objects = BTreeMap::<String, CanonicalStoredObject>::new();
        let mut object_hashes = BTreeSet::<String>::new();
        for object in &package.objects {
            let bytes = serde_json::to_vec(&object.value)?;
            self.stage_bytes(
                &staged_objects,
                &object.object_hash,
                &bytes,
                &mut object_hashes,
            )?;
            stored_objects
                .entry(object.object_hash.0.clone())
                .or_insert(CanonicalStoredObject {
                    object_hash: object.object_hash.clone(),
                    media_type: object.media_type.clone(),
                    byte_length: u64::try_from(bytes.len()).map_err(|_| {
                        CanonicalProjectStoreError::ObjectLengthMismatch {
                            expected: u64::MAX,
                            observed: u64::MAX,
                        }
                    })?,
                });
        }
        for admission in &package.admissions {
            let bytes = serde_json::to_vec(&admission.resolved_geometry)?;
            let object_hash = geometry_object_content_hash(&admission.resolved_geometry)
                .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
            self.stage_bytes(&staged_objects, &object_hash, &bytes, &mut object_hashes)?;
            stored_objects
                .entry(object_hash.0.clone())
                .or_insert(CanonicalStoredObject {
                    object_hash,
                    media_type: "application/vnd.himmelcad.geometry+json".to_owned(),
                    byte_length: u64::try_from(bytes.len()).map_err(|_| {
                        CanonicalProjectStoreError::ObjectLengthMismatch {
                            expected: u64::MAX,
                            observed: u64::MAX,
                        }
                    })?,
                });
        }
        for dataset in &package.datasets {
            let root = source_roots
                .datasets
                .get(&dataset.dataset_id)
                .ok_or_else(|| CanonicalProjectStoreError::MissingDatasetRoot {
                    dataset_id: dataset.dataset_id.clone(),
                })?;
            let canonical_root = fs::canonicalize(root)?;
            for artifact in &dataset.artifacts {
                let source = fs::canonicalize(root.join(&artifact.relative_path))?;
                if !source.starts_with(&canonical_root) || !source.is_file() {
                    return Err(CanonicalProjectStoreError::UnsafeArtifactSource);
                }
                self.stage_file(
                    &staged_objects,
                    &source,
                    &artifact.resource,
                    &mut object_hashes,
                )?;
                let byte_length = artifact
                    .resource
                    .byte_length
                    .unwrap_or(fs::metadata(&source)?.len());
                stored_objects
                    .entry(artifact.resource.object_hash.0.clone())
                    .or_insert(CanonicalStoredObject {
                        object_hash: artifact.resource.object_hash.clone(),
                        media_type: artifact.resource.media_type.clone(),
                        byte_length,
                    });
            }
        }
        for resource_set in &package.resource_sets {
            let root = source_roots
                .resource_sets
                .get(&resource_set.resource_set_id)
                .ok_or_else(|| CanonicalProjectStoreError::MissingResourceSetRoot {
                    resource_set_id: resource_set.resource_set_id.clone(),
                })?;
            let canonical_root = fs::canonicalize(root)?;
            for artifact in &resource_set.resources {
                let source = fs::canonicalize(root.join(&artifact.relative_path))?;
                if !source.starts_with(&canonical_root) || !source.is_file() {
                    return Err(CanonicalProjectStoreError::UnsafeArtifactSource);
                }
                self.stage_file(
                    &staged_objects,
                    &source,
                    &artifact.resource,
                    &mut object_hashes,
                )?;
                let byte_length = artifact
                    .resource
                    .byte_length
                    .ok_or(CanonicalProjectStoreError::MissingResourceLength)?;
                stored_objects
                    .entry(artifact.resource.object_hash.0.clone())
                    .or_insert(CanonicalStoredObject {
                        object_hash: artifact.resource.object_hash.clone(),
                        media_type: artifact.resource.media_type.clone(),
                        byte_length,
                    });
            }
        }

        let mut dataset_files = Vec::with_capacity(package.datasets.len());
        fs::create_dir_all(transaction_dir.join("datasets"))?;
        for dataset in &package.datasets {
            let stored = StoredDatasetInventory::new(dataset.clone())?;
            let bytes = serde_json::to_vec(&stored)?;
            let content_hash = ObjectHash::of_bytes(&bytes);
            write_new_synced(
                &staged_dataset_path(&transaction_dir, &dataset.dataset_id),
                &bytes,
            )?;
            dataset_files.push(PendingDatasetFile {
                dataset_id: dataset.dataset_id.clone(),
                content_hash,
            });
        }

        let inventory = CanonicalImportInventory {
            schema_version: STORE_SCHEMA_VERSION,
            command_id: command_id.to_owned(),
            provider_id: package.provider_id.clone(),
            provider_version: package.provider_version.clone(),
            objects: stored_objects.into_values().collect(),
            admissions: package
                .admissions
                .iter()
                .map(|admission| CanonicalStoredAdmission {
                    entity_id: admission.entity.id.0.clone(),
                    representation_slot: admission.representation_slot.clone(),
                    selected: admission.selected.clone(),
                    geometry_ref: admission.selected.geometry_ref.clone(),
                })
                .collect(),
            datasets: package.datasets.clone(),
            resource_sets: package.resource_sets.clone(),
            presentation_resources: package.presentation_resources.clone(),
        };
        let stored_inventory = StoredImportInventory::new(inventory.clone())?;
        let import_bytes = serde_json::to_vec(&stored_inventory)?;
        let import_inventory_hash = ObjectHash::of_bytes(&import_bytes);
        write_new_synced(&transaction_dir.join("import.json"), &import_bytes)?;

        let entry = prepared.journal_entry().clone();
        let pending = PendingCanonicalCommit {
            schema_version: STORE_SCHEMA_VERSION,
            command_hash: ObjectHash::of_bytes(command_id.as_bytes()),
            journal: StoredJournalRecord::new(entry.clone())?,
            object_hashes: object_hashes.into_iter().map(ObjectHash).collect(),
            dataset_files,
            import_inventory_hash: Some(import_inventory_hash),
        };
        let journal_bytes = serde_json::to_vec(&pending.journal)?;
        write_new_synced(&transaction_dir.join("journal.json"), &journal_bytes)?;
        let marker_bytes = serde_json::to_vec(&pending)?;
        write_new_synced(&transaction_dir.join("ready.json"), &marker_bytes)?;
        sync_dir(&transaction_dir)?;
        cleanup.preserve();

        if let Err(error) = self.publish_pending_files(&transaction_dir, &pending) {
            return Err(CanonicalProjectStoreError::CommitPending {
                transaction_dir,
                reason: error.to_string(),
            });
        }
        self.commit_prepared_in_memory(prepared)?;
        for dataset in &package.datasets {
            self.dataset_ids.insert(dataset.dataset_id.clone());
        }
        for resource_set in &package.resource_sets {
            self.resource_set_ids
                .insert(resource_set.resource_set_id.clone());
        }
        fs::remove_dir_all(&transaction_dir)?;
        sync_dir(&transactions_root(&self.root))?;
        Ok(CanonicalImportCommit {
            journal_entry: entry,
            inventory,
        })
    }

    fn validate_source_roots(
        &self,
        package: &CanonicalImportPackage,
        source_roots: &CanonicalImportSourceRoots,
    ) -> Result<(), CanonicalProjectStoreError> {
        let package_ids: BTreeSet<&str> = package
            .datasets
            .iter()
            .map(|dataset| dataset.dataset_id.as_str())
            .collect();
        for dataset in &package.datasets {
            if self.dataset_ids.contains(&dataset.dataset_id) {
                return Err(CanonicalProjectStoreError::DuplicateDatasetId {
                    dataset_id: dataset.dataset_id.clone(),
                });
            }
            if !source_roots.datasets.contains_key(&dataset.dataset_id) {
                return Err(CanonicalProjectStoreError::MissingDatasetRoot {
                    dataset_id: dataset.dataset_id.clone(),
                });
            }
        }
        for dataset_id in source_roots.datasets.keys() {
            if !package_ids.contains(dataset_id.as_str()) {
                return Err(CanonicalProjectStoreError::UnexpectedDatasetRoot {
                    dataset_id: dataset_id.clone(),
                });
            }
        }
        let package_resource_set_ids: BTreeSet<&str> = package
            .resource_sets
            .iter()
            .map(|resource_set| resource_set.resource_set_id.as_str())
            .collect();
        for resource_set in &package.resource_sets {
            if self
                .resource_set_ids
                .contains(&resource_set.resource_set_id)
            {
                return Err(CanonicalProjectStoreError::DuplicateResourceSetId {
                    resource_set_id: resource_set.resource_set_id.clone(),
                });
            }
            if !source_roots
                .resource_sets
                .contains_key(&resource_set.resource_set_id)
            {
                return Err(CanonicalProjectStoreError::MissingResourceSetRoot {
                    resource_set_id: resource_set.resource_set_id.clone(),
                });
            }
        }
        for resource_set_id in source_roots.resource_sets.keys() {
            if !package_resource_set_ids.contains(resource_set_id.as_str()) {
                return Err(CanonicalProjectStoreError::UnexpectedResourceSetRoot {
                    resource_set_id: resource_set_id.clone(),
                });
            }
        }
        Ok(())
    }

    fn stage_bytes(
        &self,
        staged_objects: &Path,
        expected_hash: &ObjectHash,
        bytes: &[u8],
        object_hashes: &mut BTreeSet<String>,
    ) -> Result<(), CanonicalProjectStoreError> {
        validate_hash(expected_hash)?;
        let observed = ObjectHash::of_bytes(bytes);
        if observed != *expected_hash {
            return Err(CanonicalProjectStoreError::ObjectHashMismatch {
                expected: expected_hash.clone(),
                observed,
            });
        }
        let destination = object_path(&self.root, expected_hash)?;
        let byte_length = usize_length(bytes.len())?;
        if destination.exists() {
            verify_file(&destination, expected_hash, Some(byte_length))?;
        }
        let staged = staged_objects.join(expected_hash.as_str());
        if staged.exists() {
            verify_file(&staged, expected_hash, Some(byte_length))?;
        } else {
            write_new_synced(&staged, bytes)?;
        }
        object_hashes.insert(expected_hash.0.clone());
        Ok(())
    }

    fn stage_file(
        &self,
        staged_objects: &Path,
        source: &Path,
        resource: &GeometryResource,
        object_hashes: &mut BTreeSet<String>,
    ) -> Result<(), CanonicalProjectStoreError> {
        validate_hash(&resource.object_hash)?;
        let staged = staged_objects.join(resource.object_hash.as_str());
        if staged.exists() {
            verify_file(&staged, &resource.object_hash, resource.byte_length)?;
        } else {
            copy_new_verified(source, &staged, &resource.object_hash, resource.byte_length)?;
        }
        let destination = object_path(&self.root, &resource.object_hash)?;
        if destination.exists() {
            verify_file(&destination, &resource.object_hash, resource.byte_length)?;
        }
        object_hashes.insert(resource.object_hash.0.clone());
        Ok(())
    }

    fn publish_prepared(
        &mut self,
        prepared: PreparedCanonicalTransaction,
        object_hashes: Vec<ObjectHash>,
        dataset_files: Vec<PendingDatasetFile>,
        import_inventory_hash: Option<ObjectHash>,
    ) -> Result<CanonicalJournalEntry, CanonicalProjectStoreError> {
        let entry = prepared.journal_entry().clone();
        let transaction_dir = self.create_transaction_dir(&entry.command_id)?;
        let mut cleanup = StagingGuard::new(transaction_dir.clone());
        let pending = PendingCanonicalCommit {
            schema_version: STORE_SCHEMA_VERSION,
            command_hash: ObjectHash::of_bytes(entry.command_id.as_bytes()),
            journal: StoredJournalRecord::new(entry.clone())?,
            object_hashes,
            dataset_files,
            import_inventory_hash,
        };
        write_new_synced(
            &transaction_dir.join("journal.json"),
            &serde_json::to_vec(&pending.journal)?,
        )?;
        write_new_synced(
            &transaction_dir.join("ready.json"),
            &serde_json::to_vec(&pending)?,
        )?;
        sync_dir(&transaction_dir)?;
        cleanup.preserve();
        if let Err(error) = self.publish_pending_files(&transaction_dir, &pending) {
            return Err(CanonicalProjectStoreError::CommitPending {
                transaction_dir,
                reason: error.to_string(),
            });
        }
        self.commit_prepared_in_memory(prepared)?;
        fs::remove_dir_all(&transaction_dir)?;
        sync_dir(&transactions_root(&self.root))?;
        Ok(entry)
    }

    fn commit_prepared_in_memory(
        &mut self,
        prepared: PreparedCanonicalTransaction,
    ) -> Result<(), CanonicalProjectStoreError> {
        self.document
            .commit(prepared)
            .map(|_| ())
            .map_err(|_| CanonicalProjectStoreError::CommitInvariant)
    }

    fn create_transaction_dir(
        &self,
        command_id: &str,
    ) -> Result<PathBuf, CanonicalProjectStoreError> {
        let path =
            transactions_root(&self.root).join(ObjectHash::of_bytes(command_id.as_bytes()).0);
        fs::create_dir(&path)?;
        sync_dir(&transactions_root(&self.root))?;
        Ok(path)
    }

    fn publish_pending_files(
        &self,
        transaction_dir: &Path,
        pending: &PendingCanonicalCommit,
    ) -> Result<(), CanonicalProjectStoreError> {
        pending.validate(transaction_name(transaction_dir)?)?;
        for object_hash in &pending.object_hashes {
            let staged = transaction_dir.join("objects").join(object_hash.as_str());
            let destination = object_path(&self.root, object_hash)?;
            if destination.exists() {
                verify_file(&destination, object_hash, None)?;
            } else {
                publish_immutable_file(&staged, &destination, object_hash, None)?;
            }
        }
        for dataset_file in &pending.dataset_files {
            let staged = staged_dataset_path(transaction_dir, &dataset_file.dataset_id);
            let destination = dataset_inventory_path(&self.root, &dataset_file.dataset_id);
            publish_named_file(&staged, &destination, &dataset_file.content_hash)?;
        }
        if let Some(expected_hash) = &pending.import_inventory_hash {
            publish_named_file(
                &transaction_dir.join("import.json"),
                &import_inventory_path(&self.root, &pending.journal.entry.command_id),
                expected_hash,
            )?;
        }
        publish_named_file(
            &transaction_dir.join("journal.json"),
            &journal_path(&self.root, pending.journal.entry.sequence),
            &ObjectHash::of_bytes(&serde_json::to_vec(&pending.journal)?),
        )?;
        Ok(())
    }

    fn recover_pending_transactions(&mut self) -> Result<(), CanonicalProjectStoreError> {
        let mut pending = Vec::new();
        for entry in fs::read_dir(transactions_root(&self.root))? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                return Err(CanonicalProjectStoreError::InvalidPendingTransaction);
            }
            let path = entry.path();
            let marker = path.join("ready.json");
            if !marker.is_file() {
                fs::remove_dir_all(&path)?;
                continue;
            }
            let transaction: PendingCanonicalCommit = serde_json::from_slice(&fs::read(marker)?)?;
            transaction.validate(transaction_name(&path)?)?;
            pending.push((transaction.journal.entry.sequence, path, transaction));
        }
        pending.sort_by_key(|(sequence, _, _)| *sequence);

        for (_, path, transaction) in pending {
            let journal_destination = journal_path(&self.root, transaction.journal.entry.sequence);
            if journal_destination.exists() {
                let stored: StoredJournalRecord =
                    serde_json::from_slice(&fs::read(&journal_destination)?)?;
                stored.validate()?;
                if stored != transaction.journal {
                    return Err(CanonicalProjectStoreError::InvalidPendingTransaction);
                }
            } else {
                if transaction.journal.entry.sequence != self.document.generation() + 1 {
                    return Err(CanonicalProjectStoreError::InvalidPendingTransaction);
                }
                let mut entries = self.document.journal().to_vec();
                entries.push(transaction.journal.entry.clone());
                CanonicalDocument::from_journal(&entries)?;
            }
            self.publish_pending_files(&path, &transaction)?;
            if transaction.journal.entry.sequence > self.document.generation() {
                let mut entries = self.document.journal().to_vec();
                entries.push(transaction.journal.entry.clone());
                self.document = CanonicalDocument::from_journal(&entries)?;
            }
            fs::remove_dir_all(&path)?;
            sync_dir(&transactions_root(&self.root))?;
        }
        Ok(())
    }

    fn load_document(&self) -> Result<CanonicalDocument, CanonicalProjectStoreError> {
        let journal_root = canonical_root(&self.root).join("journal");
        let mut records = Vec::new();
        for entry in fs::read_dir(&journal_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                return Err(CanonicalProjectStoreError::InvalidJournalLayout);
            }
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| CanonicalProjectStoreError::InvalidJournalLayout)?;
            let sequence = parse_journal_file_name(&file_name)?;
            let record: StoredJournalRecord = serde_json::from_slice(&fs::read(entry.path())?)?;
            record.validate()?;
            if record.entry.sequence != sequence {
                return Err(CanonicalProjectStoreError::InvalidJournalLayout);
            }
            records.push(record);
        }
        records.sort_by_key(|record| record.entry.sequence);
        for (index, record) in records.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| CanonicalProjectStoreError::InvalidJournalLayout)?
                + 1;
            if record.entry.sequence != expected {
                return Err(CanonicalProjectStoreError::InvalidJournalLayout);
            }
        }
        let entries: Vec<_> = records.into_iter().map(|record| record.entry).collect();
        Ok(CanonicalDocument::from_journal(&entries)?)
    }

    fn load_inventory_ids(
        &self,
    ) -> Result<(BTreeSet<String>, BTreeSet<String>), CanonicalProjectStoreError> {
        let mut dataset_ids = BTreeSet::new();
        let mut resource_set_ids = BTreeSet::new();
        for entry in fs::read_dir(canonical_root(&self.root).join("datasets"))? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                return Err(CanonicalProjectStoreError::InventoryHashMismatch);
            }
            let inventory: StoredDatasetInventory =
                serde_json::from_slice(&fs::read(entry.path())?)?;
            inventory.validate()?;
            if entry.file_name() != dataset_file_name(&inventory.dataset.dataset_id)
                || !dataset_ids.insert(inventory.dataset.dataset_id)
            {
                return Err(CanonicalProjectStoreError::InventoryHashMismatch);
            }
        }
        for entry in fs::read_dir(canonical_root(&self.root).join("imports"))? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                return Err(CanonicalProjectStoreError::InventoryHashMismatch);
            }
            let inventory: StoredImportInventory =
                serde_json::from_slice(&fs::read(entry.path())?)?;
            inventory.validate()?;
            if entry.file_name()
                != import_inventory_path(&self.root, &inventory.inventory.command_id)
                    .file_name()
                    .ok_or(CanonicalProjectStoreError::InventoryHashMismatch)?
            {
                return Err(CanonicalProjectStoreError::InventoryHashMismatch);
            }
            for resource_set in &inventory.inventory.resource_sets {
                if !resource_set_ids.insert(resource_set.resource_set_id.clone()) {
                    return Err(CanonicalProjectStoreError::InventoryHashMismatch);
                }
            }
        }
        Ok((dataset_ids, resource_set_ids))
    }
}

impl Drop for CanonicalProjectStore {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock);
    }
}

struct StagingGuard {
    path: PathBuf,
    remove: bool,
}

impl StagingGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, remove: true }
    }

    fn preserve(&mut self) {
        self.remove = false;
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.remove {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn ensure_layout(root: &Path) -> Result<(), CanonicalProjectStoreError> {
    for path in [
        root.to_path_buf(),
        root.join("objects"),
        canonical_root(root),
        canonical_root(root).join("journal"),
        canonical_root(root).join("datasets"),
        canonical_root(root).join("imports"),
        canonical_root(root).join("object-metadata"),
        root.join("tmp"),
        transactions_root(root),
    ] {
        fs::create_dir_all(&path)?;
    }
    sync_dir(root)?;
    Ok(())
}

fn canonical_root(root: &Path) -> PathBuf {
    root.join("canonical")
}

fn transactions_root(root: &Path) -> PathBuf {
    root.join("tmp").join("canonical-transactions")
}

fn journal_path(root: &Path, sequence: u64) -> PathBuf {
    canonical_root(root)
        .join("journal")
        .join(format!("{sequence:016}.json"))
}

fn dataset_file_name(dataset_id: &str) -> std::ffi::OsString {
    format!(
        "{}.json",
        ObjectHash::of_bytes(dataset_id.as_bytes()).as_str()
    )
    .into()
}

fn dataset_inventory_path(root: &Path, dataset_id: &str) -> PathBuf {
    canonical_root(root)
        .join("datasets")
        .join(dataset_file_name(dataset_id))
}

fn staged_dataset_path(transaction_dir: &Path, dataset_id: &str) -> PathBuf {
    transaction_dir
        .join("datasets")
        .join(dataset_file_name(dataset_id))
}

fn import_inventory_path(root: &Path, command_id: &str) -> PathBuf {
    canonical_root(root).join("imports").join(format!(
        "{}.json",
        ObjectHash::of_bytes(command_id.as_bytes()).as_str()
    ))
}

fn object_path(
    root: &Path,
    object_hash: &ObjectHash,
) -> Result<PathBuf, CanonicalProjectStoreError> {
    validate_hash(object_hash)?;
    let (prefix, remainder) = object_hash.as_str().split_at(2);
    Ok(root.join("objects").join(prefix).join(remainder))
}

fn object_metadata_path(
    root: &Path,
    object_hash: &ObjectHash,
) -> Result<PathBuf, CanonicalProjectStoreError> {
    validate_hash(object_hash)?;
    Ok(canonical_root(root)
        .join("object-metadata")
        .join(format!("{}.json", object_hash.as_str())))
}

fn validate_hash(object_hash: &ObjectHash) -> Result<(), CanonicalProjectStoreError> {
    if object_hash.as_str().len() != 64
        || !object_hash
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CanonicalProjectStoreError::InvalidHash);
    }
    Ok(())
}

fn compact_hash(value: &impl Serialize) -> Result<ObjectHash, CanonicalProjectStoreError> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(value)?))
}

fn usize_length(value: usize) -> Result<u64, CanonicalProjectStoreError> {
    u64::try_from(value).map_err(|_| CanonicalProjectStoreError::ObjectLengthMismatch {
        expected: u64::MAX,
        observed: u64::MAX,
    })
}

fn unique_hashes(hashes: &[ObjectHash]) -> bool {
    let mut unique = BTreeSet::new();
    hashes.iter().all(|hash| unique.insert(hash.as_str()))
}

fn unique_dataset_files(files: &[PendingDatasetFile]) -> bool {
    let mut unique = BTreeSet::new();
    files
        .iter()
        .all(|file| unique.insert(file.dataset_id.as_str()))
}

fn transaction_name(path: &Path) -> Result<&str, CanonicalProjectStoreError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or(CanonicalProjectStoreError::InvalidPendingTransaction)
}

fn parse_journal_file_name(file_name: &str) -> Result<u64, CanonicalProjectStoreError> {
    let digits = file_name
        .strip_suffix(".json")
        .filter(|digits| digits.len() == 16 && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or(CanonicalProjectStoreError::InvalidJournalLayout)?;
    digits
        .parse()
        .map_err(|_| CanonicalProjectStoreError::InvalidJournalLayout)
}

fn unique_staging_file(root: &Path, prefix: &str) -> PathBuf {
    let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = root.join("tmp").join(format!(
        ".canonical-{prefix}-{}-{sequence}.tmp",
        std::process::id()
    ));
    path
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), CanonicalProjectStoreError> {
    let parent = path
        .parent()
        .ok_or(CanonicalProjectStoreError::InvalidPendingTransaction)?;
    fs::create_dir_all(parent)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    sync_dir(parent)?;
    Ok(())
}

fn copy_new_verified(
    source: &Path,
    destination: &Path,
    expected_hash: &ObjectHash,
    expected_length: Option<u64>,
) -> Result<(), CanonicalProjectStoreError> {
    let input = File::open(source)?;
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    let mut hasher = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        length = length
            .checked_add(u64::try_from(read).map_err(|_| {
                CanonicalProjectStoreError::ObjectLengthMismatch {
                    expected: u64::MAX,
                    observed: u64::MAX,
                }
            })?)
            .ok_or(CanonicalProjectStoreError::ObjectLengthMismatch {
                expected: u64::MAX,
                observed: u64::MAX,
            })?;
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    let observed = ObjectHash(hex::encode(hasher.finalize()));
    if observed != *expected_hash {
        let _ = fs::remove_file(destination);
        return Err(CanonicalProjectStoreError::ObjectHashMismatch {
            expected: expected_hash.clone(),
            observed,
        });
    }
    if let Some(expected) = expected_length {
        if length != expected {
            let _ = fs::remove_file(destination);
            return Err(CanonicalProjectStoreError::ObjectLengthMismatch {
                expected,
                observed: length,
            });
        }
    }
    sync_dir(
        destination
            .parent()
            .ok_or(CanonicalProjectStoreError::InvalidPendingTransaction)?,
    )?;
    Ok(())
}

fn verify_file(
    path: &Path,
    expected_hash: &ObjectHash,
    expected_length: Option<u64>,
) -> Result<(), CanonicalProjectStoreError> {
    let mut file = File::open(path)?;
    verify_open_file(&mut file, expected_hash, expected_length)
}

fn verify_open_file(
    file: &mut File,
    expected_hash: &ObjectHash,
    expected_length: Option<u64>,
) -> Result<(), CanonicalProjectStoreError> {
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        length = length
            .checked_add(u64::try_from(read).map_err(|_| {
                CanonicalProjectStoreError::ObjectLengthMismatch {
                    expected: u64::MAX,
                    observed: u64::MAX,
                }
            })?)
            .ok_or(CanonicalProjectStoreError::ObjectLengthMismatch {
                expected: u64::MAX,
                observed: u64::MAX,
            })?;
    }
    let observed = ObjectHash(hex::encode(hasher.finalize()));
    if observed != *expected_hash {
        return Err(CanonicalProjectStoreError::ObjectHashMismatch {
            expected: expected_hash.clone(),
            observed,
        });
    }
    if let Some(expected) = expected_length {
        if length != expected {
            return Err(CanonicalProjectStoreError::ObjectLengthMismatch {
                expected,
                observed: length,
            });
        }
    }
    Ok(())
}

fn publish_immutable_file(
    staged: &Path,
    destination: &Path,
    expected_hash: &ObjectHash,
    expected_length: Option<u64>,
) -> Result<(), CanonicalProjectStoreError> {
    verify_file(staged, expected_hash, expected_length)?;
    publish_link(staged, destination)?;
    verify_file(destination, expected_hash, expected_length)
}

fn publish_named_file(
    staged: &Path,
    destination: &Path,
    expected_hash: &ObjectHash,
) -> Result<(), CanonicalProjectStoreError> {
    verify_file(staged, expected_hash, None)?;
    if destination.exists() {
        verify_file(destination, expected_hash, None)?;
        return Ok(());
    }
    publish_link(staged, destination)?;
    verify_file(destination, expected_hash, None)
}

fn publish_link(staged: &Path, destination: &Path) -> Result<(), CanonicalProjectStoreError> {
    let parent = destination
        .parent()
        .ok_or(CanonicalProjectStoreError::InvalidPendingTransaction)?;
    let parent_existed = parent.exists();
    fs::create_dir_all(parent)?;
    if !parent_existed {
        if let Some(grandparent) = parent.parent() {
            sync_dir(grandparent)?;
        }
    }
    match fs::hard_link(staged, destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    sync_dir(parent)?;
    Ok(())
}

fn sync_dir(path: &Path) -> Result<(), CanonicalProjectStoreError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::canonical_document::{CanonicalEntityMutation, EntityVersionRef};
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        built_in_type, CanonicalEntity, EntityTypeId, GeometryObject, OrthoGridMapping,
        RasterImageGeometry, RasterMapping, Representation, RepresentationAuthority,
        RepresentationRole, StreamedGeometry, Vector3,
    };
    use himmelcad_core::entity_validation::canonical_entity_version_hash;
    use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
    use himmelcad_io::{
        PreparedDatasetArtifact, PreparedResourceArtifact, CANONICAL_IO_SCHEMA_VERSION,
    };

    fn temp_project(label: &str) -> PathBuf {
        let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "himmelcad-canonical-store-{label}-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        path
    }

    fn package(entity_id: &str, dataset_id: &str) -> CanonicalImportPackage {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({"hcad.prepared-dataset@1": {"formatId": "potree@2"}}),
        )
        .expect("components");
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({"pointCount": 1}),
        )
        .expect("attributes");
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )
        .expect("relations");
        let root_metadata = GeometryResource {
            object_hash: ObjectHash::of_bytes(b"potree metadata"),
            media_type: "potree@2".to_owned(),
            byte_length: Some(15),
        };
        let geometry = GeometryObject::PointCloud {
            dataset: StreamedGeometry {
                format_id: "potree@2".to_owned(),
                metadata: root_metadata.clone(),
                element_count: Some(1),
            },
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id.to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: "Scan".to_owned(),
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
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "test.io.potree@1".to_owned(),
            provider_version: "1.0.0".to_owned(),
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
                format_id: "potree@2".to_owned(),
                entity_id: entity_id.to_owned(),
                representation_slot: "source".to_owned(),
                root_metadata: root_metadata.clone(),
                artifacts: vec![PreparedDatasetArtifact {
                    relative_path: PathBuf::from("metadata.json"),
                    resource: root_metadata,
                }],
            }],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        }
    }

    fn artifact_root(project: &Path, label: &str) -> PathBuf {
        let root = project.join(format!("source-{label}"));
        fs::create_dir_all(&root).expect("source root");
        fs::write(root.join("metadata.json"), b"potree metadata").expect("artifact");
        root
    }

    fn dataset_sources(dataset_id: &str, root: PathBuf) -> CanonicalImportSourceRoots {
        CanonicalImportSourceRoots {
            datasets: BTreeMap::from([(dataset_id.to_owned(), root)]),
            resource_sets: BTreeMap::new(),
        }
    }

    fn resource_package(entity_id: &str, resource_set_ids: &[&str]) -> CanonicalImportPackage {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({}),
        )
        .expect("components");
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({"fixture": true}),
        )
        .expect("attributes");
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )
        .expect("relations");
        let pixels = GeometryResource {
            object_hash: ObjectHash::of_bytes(b"raster pixels"),
            media_type: "image/rgba8".to_owned(),
            byte_length: Some(13),
        };
        let geometry = GeometryObject::RasterImage {
            raster: Box::new(RasterImageGeometry {
                pixels: pixels.clone(),
                width: 1,
                height: 1,
                mapping: RasterMapping::OrthoGrid(OrthoGridMapping {
                    origin: Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    column_step: Vector3 {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    row_step: Vector3 {
                        x: 0.0,
                        y: 1.0,
                        z: 0.0,
                    },
                }),
                depth: None,
            }),
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id.to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::RASTER_IMAGE.to_owned()),
            name: "Raster".to_owned(),
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
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "test.io.raster@1".to_owned(),
            provider_version: "1.0.0".to_owned(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity,
                selected,
                representation_slot: "source".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects: vec![components, attributes, relations],
            datasets: Vec::new(),
            resource_sets: resource_set_ids
                .iter()
                .map(|resource_set_id| CanonicalResourceSet {
                    resource_set_id: (*resource_set_id).to_owned(),
                    resources: vec![PreparedResourceArtifact {
                        relative_path: PathBuf::from("pixels.bin"),
                        resource: pixels.clone(),
                    }],
                })
                .collect(),
            presentation_resources: Default::default(),
        }
    }

    fn resource_sources(project: &Path, resource_set_ids: &[&str]) -> CanonicalImportSourceRoots {
        let mut resource_sets = BTreeMap::new();
        for resource_set_id in resource_set_ids {
            let root = project.join(format!("resource-{resource_set_id}"));
            fs::create_dir_all(&root).expect("resource root");
            fs::write(root.join("pixels.bin"), b"raster pixels").expect("resource payload");
            resource_sets.insert((*resource_set_id).to_owned(), root);
        }
        CanonicalImportSourceRoots {
            datasets: BTreeMap::new(),
            resource_sets,
        }
    }

    #[test]
    fn import_persists_objects_inventory_and_replays_document() {
        let root = temp_project("replay");
        let source = artifact_root(&root, "a");
        let package = package("scan-a", "dataset-a");
        let roots = dataset_sources("dataset-a", source);
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        let committed = store
            .publish_import_package(&package, &roots, "import-a")
            .expect("publish import");
        assert_eq!(committed.journal_entry.sequence, 1);
        assert!(store
            .document()
            .entity(&EntityId("scan-a".to_owned()))
            .is_some());
        drop(store);

        let reopened = CanonicalProjectStore::open(&root).expect("reopen");
        assert_eq!(reopened.document().generation(), 1);
        assert!(reopened
            .document()
            .entity(&EntityId("scan-a".to_owned()))
            .is_some());
        assert!(dataset_inventory_path(&root, "dataset-a").is_file());
        assert!(import_inventory_path(&root, "import-a").is_file());
        assert!(!String::from_utf8(
            fs::read(import_inventory_path(&root, "import-a")).expect("inventory bytes")
        )
        .expect("inventory utf8")
        .contains("presentationResources"));
        assert_eq!(
            reopened
                .import_inventories()
                .expect("validated import inventory"),
            vec![committed.inventory]
        );
        assert_eq!(
            reopened.journal_since(0, 16).expect("journal suffix"),
            vec![committed.journal_entry]
        );
        assert!(reopened
            .journal_since(1, 16)
            .expect("empty journal suffix")
            .is_empty());
        let artifact = package.datasets[0].root_metadata.object_hash.clone();
        assert_eq!(
            reopened.read_object(&artifact).expect("artifact"),
            b"potree metadata"
        );
        drop(reopened);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn resource_sets_publish_atomically_and_deduplicate_immutable_bytes() {
        let root = temp_project("resource-publish");
        let package = resource_package("raster", &["pixels-a", "pixels-b"]);
        let sources = resource_sources(&root, &["pixels-a", "pixels-b"]);
        let pixels = package.resource_sets[0].resources[0]
            .resource
            .object_hash
            .clone();
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        let committed = store
            .publish_import_package(&package, &sources, "import-raster")
            .expect("publish resources");
        assert_eq!(committed.inventory.resource_sets.len(), 2);
        assert_eq!(
            committed
                .inventory
                .objects
                .iter()
                .filter(|object| object.object_hash == pixels)
                .count(),
            1
        );
        let duplicate_package = resource_package("other-raster", &["pixels-a"]);
        let duplicate_sources = CanonicalImportSourceRoots {
            datasets: BTreeMap::new(),
            resource_sets: BTreeMap::from([(
                "pixels-a".to_owned(),
                sources.resource_sets["pixels-a"].clone(),
            )]),
        };
        assert!(matches!(
            store.publish_import_package(
                &duplicate_package,
                &duplicate_sources,
                "duplicate-resource-set"
            ),
            Err(CanonicalProjectStoreError::DuplicateResourceSetId { .. })
        ));
        drop(store);

        let reopened = CanonicalProjectStore::open(&root).expect("reopen");
        assert_eq!(
            reopened.read_object(&pixels).expect("resource bytes"),
            b"raster pixels"
        );
        assert!(reopened.resource_set_ids.contains("pixels-a"));
        assert!(reopened.resource_set_ids.contains("pixels-b"));
        assert!(import_inventory_path(&root, "import-raster").is_file());
        drop(reopened);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn tampered_or_missing_resource_set_sources_never_append_a_command() {
        let root = temp_project("resource-reject");
        let package = resource_package("raster", &["pixels"]);
        let mut sources = resource_sources(&root, &["pixels"]);
        fs::write(
            sources
                .resource_sets
                .get("pixels")
                .expect("root")
                .join("pixels.bin"),
            b"tampered",
        )
        .expect("tamper source");
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        assert!(matches!(
            store.publish_import_package(&package, &sources, "tampered-resource"),
            Err(CanonicalProjectStoreError::ObjectHashMismatch { .. })
                | Err(CanonicalProjectStoreError::ObjectLengthMismatch { .. })
        ));
        assert_eq!(store.document().generation(), 0);
        assert_eq!(
            fs::read_dir(canonical_root(&root).join("journal"))
                .expect("journal dir")
                .count(),
            0
        );

        sources.resource_sets.clear();
        assert!(matches!(
            store.publish_import_package(&package, &sources, "missing-resource"),
            Err(CanonicalProjectStoreError::MissingResourceSetRoot { .. })
        ));
        assert_eq!(store.document().generation(), 0);
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn resource_set_symlink_cannot_escape_its_canonical_source_root() {
        use std::os::unix::fs::symlink;

        let root = temp_project("resource-symlink-escape");
        let package = resource_package("raster", &["pixels"]);
        let sources = resource_sources(&root, &["pixels"]);
        let source_root = &sources.resource_sets["pixels"];
        let payload = source_root.join("pixels.bin");
        fs::remove_file(&payload).expect("remove in-root fixture");
        let outside = root.join("outside-pixels.bin");
        fs::write(&outside, b"raster pixels").expect("outside payload");
        symlink(&outside, &payload).expect("escape symlink");
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        assert!(matches!(
            store.publish_import_package(&package, &sources, "escaped-resource"),
            Err(CanonicalProjectStoreError::UnsafeArtifactSource)
        ));
        assert_eq!(store.document().generation(), 0);
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn ready_resource_set_transaction_recovers_before_journal_publication() {
        let root = temp_project("resource-recovery");
        let package = resource_package("recovered-raster", &["pixels"]);
        let sources = resource_sources(&root, &["pixels"]);
        package.validate().expect("valid package");
        let store = CanonicalProjectStore::open(&root).expect("open");
        let prepared = store
            .document()
            .prepare_transaction(
                package
                    .entity_create_transaction("recover-resource")
                    .expect("transaction"),
            )
            .expect("prepare");
        let transaction_dir = store
            .create_transaction_dir("recover-resource")
            .expect("transaction dir");
        let staged_objects = transaction_dir.join("objects");
        fs::create_dir_all(&staged_objects).expect("staged objects");
        let artifact = &package.resource_sets[0].resources[0];
        let source = sources.resource_sets["pixels"].join(&artifact.relative_path);
        let mut object_hashes = BTreeSet::new();
        store
            .stage_file(
                &staged_objects,
                &source,
                &artifact.resource,
                &mut object_hashes,
            )
            .expect("stage resource");
        let inventory = CanonicalImportInventory {
            schema_version: STORE_SCHEMA_VERSION,
            command_id: "recover-resource".to_owned(),
            provider_id: package.provider_id.clone(),
            provider_version: package.provider_version.clone(),
            objects: vec![CanonicalStoredObject {
                object_hash: artifact.resource.object_hash.clone(),
                media_type: artifact.resource.media_type.clone(),
                byte_length: artifact.resource.byte_length.expect("exact length"),
            }],
            admissions: Vec::new(),
            datasets: Vec::new(),
            resource_sets: package.resource_sets.clone(),
            presentation_resources: package.presentation_resources.clone(),
        };
        let stored_inventory = StoredImportInventory::new(inventory).expect("stored inventory");
        let import_bytes = serde_json::to_vec(&stored_inventory).expect("inventory bytes");
        let import_inventory_hash = ObjectHash::of_bytes(&import_bytes);
        write_new_synced(&transaction_dir.join("import.json"), &import_bytes)
            .expect("stage inventory");
        let pending = PendingCanonicalCommit {
            schema_version: STORE_SCHEMA_VERSION,
            command_hash: ObjectHash::of_bytes(b"recover-resource"),
            journal: StoredJournalRecord::new(prepared.journal_entry().clone())
                .expect("journal record"),
            object_hashes: object_hashes.into_iter().map(ObjectHash).collect(),
            dataset_files: Vec::new(),
            import_inventory_hash: Some(import_inventory_hash),
        };
        write_new_synced(
            &transaction_dir.join("journal.json"),
            &serde_json::to_vec(&pending.journal).expect("journal bytes"),
        )
        .expect("stage journal");
        write_new_synced(
            &transaction_dir.join("ready.json"),
            &serde_json::to_vec(&pending).expect("marker bytes"),
        )
        .expect("ready marker");
        drop(store);

        assert!(!journal_path(&root, 1).exists());
        let reopened = CanonicalProjectStore::open(&root).expect("recover open");
        assert!(journal_path(&root, 1).is_file());
        assert!(reopened.resource_set_ids.contains("pixels"));
        assert_eq!(
            reopened
                .read_object(&artifact.resource.object_hash)
                .expect("recovered resource"),
            b"raster pixels"
        );
        assert!(import_inventory_path(&root, "recover-resource").is_file());
        drop(reopened);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn ready_transaction_is_completed_on_open_with_journal_last() {
        let root = temp_project("recovery");
        let entity = package("recovered-scan", "dataset").admissions[0]
            .entity
            .clone();
        let store = CanonicalProjectStore::open(&root).expect("open");
        let prepared = store
            .document()
            .prepare_transaction(CanonicalCommandTransaction {
                command_id: "recover-command".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create {
                    entity: entity.clone(),
                }],
            })
            .expect("prepare");
        let transaction_dir = store
            .create_transaction_dir("recover-command")
            .expect("transaction dir");
        let pending = PendingCanonicalCommit {
            schema_version: STORE_SCHEMA_VERSION,
            command_hash: ObjectHash::of_bytes(b"recover-command"),
            journal: StoredJournalRecord::new(prepared.journal_entry().clone())
                .expect("journal record"),
            object_hashes: Vec::new(),
            dataset_files: Vec::new(),
            import_inventory_hash: None,
        };
        write_new_synced(
            &transaction_dir.join("journal.json"),
            &serde_json::to_vec(&pending.journal).expect("journal bytes"),
        )
        .expect("stage journal");
        write_new_synced(
            &transaction_dir.join("ready.json"),
            &serde_json::to_vec(&pending).expect("marker bytes"),
        )
        .expect("ready marker");
        drop(store);

        assert!(!journal_path(&root, 1).exists());
        let reopened = CanonicalProjectStore::open(&root).expect("recover open");
        assert!(journal_path(&root, 1).is_file());
        assert!(reopened.document().entity(&entity.id).is_some());
        assert_eq!(reopened.document().generation(), 1);
        assert_eq!(
            fs::read_dir(transactions_root(&root))
                .expect("transaction dir")
                .count(),
            0
        );
        drop(reopened);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn tampered_object_and_journal_are_rejected() {
        let root = temp_project("tamper");
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        let bytes = b"immutable";
        let hash = ObjectHash::of_bytes(bytes);
        store.put_immutable_bytes(&hash, bytes).expect("put");
        fs::write(object_path(&root, &hash).expect("path"), b"tampered").expect("tamper object");
        assert!(matches!(
            store.read_object(&hash),
            Err(CanonicalProjectStoreError::ObjectHashMismatch { .. })
        ));

        let entity = package("scan", "dataset").admissions[0].entity.clone();
        store
            .commit_transaction(CanonicalCommandTransaction {
                command_id: "create".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create { entity }],
            })
            .expect("journal command");
        drop(store);
        let journal = journal_path(&root, 1);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&journal).expect("journal bytes"))
                .expect("journal JSON");
        value["entry"]["commandId"] = serde_json::json!("tampered-command");
        fs::write(&journal, serde_json::to_vec(&value).expect("tampered JSON"))
            .expect("tamper journal");
        assert!(matches!(
            CanonicalProjectStore::open(&root),
            Err(CanonicalProjectStoreError::JournalHashMismatch)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn truncated_journal_fails_open_instead_of_losing_tail() {
        let root = temp_project("truncated");
        let entity = package("scan", "dataset").admissions[0].entity.clone();
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        store
            .commit_transaction(CanonicalCommandTransaction {
                command_id: "create".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create { entity }],
            })
            .expect("journal command");
        drop(store);
        fs::write(journal_path(&root, 1), b"{\"schemaVersion\":1").expect("truncate journal");
        assert!(matches!(
            CanonicalProjectStore::open(&root),
            Err(CanonicalProjectStoreError::Json(_))
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn duplicate_entity_dataset_and_object_never_overwrite() {
        let root = temp_project("duplicates");
        let source_a = artifact_root(&root, "a");
        let source_b = artifact_root(&root, "b");
        let first = package("scan-a", "dataset-a");
        let roots = dataset_sources("dataset-a", source_a);
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        store
            .publish_import_package(&first, &roots, "import-a")
            .expect("first import");
        let object =
            CanonicalJsonObject::new("application/json", serde_json::json!({"same": true}))
                .expect("object");
        let first_hash = store.put_json_object(&object).expect("first object");
        let second_hash = store.put_json_object(&object).expect("deduplicated object");
        assert_eq!(first_hash, second_hash);
        assert_eq!(
            store
                .read_object_metadata(&first_hash)
                .expect("object metadata"),
            CanonicalStoredObject {
                object_hash: first_hash.clone(),
                media_type: "application/json".to_owned(),
                byte_length: u64::try_from(serde_json::to_vec(&object.value).unwrap().len())
                    .unwrap(),
            }
        );
        let conflicting_media = CanonicalJsonObject {
            object_hash: first_hash.clone(),
            media_type: "application/vnd.himmelcad.attributes+json".to_owned(),
            value: object.value.clone(),
        };
        assert!(matches!(
            store.put_json_object(&conflicting_media),
            Err(CanonicalProjectStoreError::ObjectMetadataConflict)
        ));

        let duplicate_entity = package("scan-a", "dataset-b");
        let duplicate_entity_roots = dataset_sources("dataset-b", source_b.clone());
        assert!(matches!(
            store.publish_import_package(
                &duplicate_entity,
                &duplicate_entity_roots,
                "duplicate-entity"
            ),
            Err(CanonicalProjectStoreError::Document(
                CanonicalDocumentError::EntityAlreadyExists { .. }
            ))
        ));

        let duplicate_dataset = package("scan-b", "dataset-a");
        let duplicate_dataset_roots = dataset_sources("dataset-a", source_b);
        assert!(matches!(
            store.publish_import_package(
                &duplicate_dataset,
                &duplicate_dataset_roots,
                "duplicate-dataset"
            ),
            Err(CanonicalProjectStoreError::DuplicateDatasetId { .. })
        ));
        assert_eq!(store.document().journal().len(), 1);
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn failed_artifact_validation_never_appends_import_command() {
        let root = temp_project("failed-import");
        let source = artifact_root(&root, "bad");
        fs::write(source.join("metadata.json"), b"wrong bytes").expect("corrupt source");
        let package = package("scan", "dataset");
        let roots = dataset_sources("dataset", source);
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        assert!(matches!(
            store.publish_import_package(&package, &roots, "failed"),
            Err(CanonicalProjectStoreError::ObjectHashMismatch { .. })
                | Err(CanonicalProjectStoreError::ObjectLengthMismatch { .. })
        ));
        assert_eq!(store.document().generation(), 0);
        assert_eq!(
            fs::read_dir(canonical_root(&root).join("journal"))
                .expect("journal dir")
                .count(),
            0
        );
        assert_eq!(
            fs::read_dir(transactions_root(&root))
                .expect("transaction dir")
                .count(),
            0
        );
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn delete_command_replays_tombstone_through_sidecar_store() {
        let root = temp_project("delete");
        let entity = package("scan", "dataset").admissions[0].entity.clone();
        let mut store = CanonicalProjectStore::open(&root).expect("open");
        store
            .commit_transaction(CanonicalCommandTransaction {
                command_id: "create".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create {
                    entity: entity.clone(),
                }],
            })
            .expect("create");
        let current = store.document().entity(&entity.id).expect("live").clone();
        store
            .commit_transaction(CanonicalCommandTransaction {
                command_id: "delete".to_owned(),
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef::from_entity(&current),
                }],
            })
            .expect("delete");
        drop(store);
        let reopened = CanonicalProjectStore::open(&root).expect("reopen");
        assert!(reopened.document().entity(&entity.id).is_none());
        assert!(reopened.document().tombstone(&entity.id).is_some());
        drop(reopened);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn verified_open_handle_survives_same_length_path_replacement_without_toctou() {
        let root = temp_project("verified-open-handle");
        let store = CanonicalProjectStore::open(&root).expect("open store");
        let object = CanonicalJsonObject::new("application/json", serde_json::Value::Null)
            .expect("canonical object");
        let expected = store.put_json_object(&object).expect("publish object");
        let path = object_path(&root, &expected).expect("object path");
        let replacement = root.join("replacement.bin");
        fs::write(&replacement, b"evil").expect("replacement");
        let (metadata, mut source) = store
            .verified_object_source(&expected)
            .expect("open and verify canonical object through its leased handle");
        assert_eq!(metadata.byte_length, 4);
        fs::rename(&replacement, &path).expect("replace path with same-length object");
        source.seek(SeekFrom::Start(0)).expect("rewind");
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes).expect("read leased handle");
        assert_eq!(bytes, b"null");
        assert_eq!(fs::read(&path).expect("replacement path"), b"evil");
        drop(source);
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
