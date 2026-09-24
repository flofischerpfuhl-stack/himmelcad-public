//! Narrow injected document-command interfaces used by domain runtimes.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::PathBuf;

use anyhow::Result;

use crate::canonical_document::{
    CanonicalCommandTransaction, CanonicalJournalEntry, EntityVersionRef,
};
use crate::canonical_import::CanonicalJsonObject;
use himmelcad_model::entity::EntityId;
use himmelcad_model::entity_model::{CanonicalEntity, GeometryObject, GeometryResource};
use himmelcad_model::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_model::hash::ObjectHash;
use himmelcad_model::surface::SurfacePoint;
use himmelcad_process::jobs::CancellationToken;

/// Immutable request for sampling one point-cloud source into a surface draft.
#[derive(Debug, Clone)]
pub struct SurfacePointCloudSampleRequest {
    pub source: EntityVersionRef,
    pub input_root: PathBuf,
    pub source_id: String,
    pub spacing: f64,
    pub placement: [f64; 16],
    pub visible_classes: BTreeSet<u8>,
}

/// Publication information required by the surface domain after journal-last commit.
#[derive(Debug, Clone)]
pub struct SurfaceDocumentCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub admission_count: usize,
}

/// Minimal document capabilities injected into the surface runtime.
///
/// Associated types keep provider staging and the domain snapshot out of the
/// foundation dependency graph while the methods remain explicit and narrow.
pub trait SurfaceDocumentCommands {
    type Snapshot;
    type StagedImport;

    fn surface_snapshot(&self) -> Result<Self::Snapshot>;
    fn surface_project_root(&self) -> Result<PathBuf>;
    fn surface_sample_point_cloud(
        &self,
        request: SurfacePointCloudSampleRequest,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SurfacePoint>>;
    fn surface_height_grid_bytes(&self, entity_id: &EntityId) -> Result<Vec<u8>>;
    fn surface_object_bytes(&self, object_hash: &ObjectHash) -> Result<Vec<u8>>;
    fn surface_publish_staged_import(
        &mut self,
        staged: &Self::StagedImport,
        command_id: &str,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<SurfaceDocumentCommit>;
}

/// Byte-measured phase of one domain-owned durable publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomainImportProgressPhase {
    Staging,
    Publishing,
}

/// Incremental byte progress for one domain-owned durable publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DomainImportProgress {
    pub phase: DomainImportProgressPhase,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

/// Immutable prepared artifact visible to a domain without exposing the concrete store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainPreparedArtifact {
    pub relative_path: PathBuf,
    pub resource: GeometryResource,
}

/// Prepared dataset inventory visible to point-cloud and registration services.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainPreparedDataset {
    pub dataset_id: String,
    pub format_id: String,
    pub entity_id: String,
    pub representation_slot: String,
    pub root_metadata: GeometryResource,
    pub artifacts: Vec<DomainPreparedArtifact>,
}

/// Exact live representation and optional prepared dataset exposed to a domain service.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainResidencyEntry {
    pub admission: CanonicalRepresentationAdmission,
    pub dataset: Option<DomainPreparedDataset>,
}

/// Narrow project-store capabilities required by point-cloud command services.
pub trait PointCloudDocumentCommands {
    type Error;
    type Package;
    type JsonObject;

    fn pointcloud_residency_entries(&self) -> Result<Vec<DomainResidencyEntry>, Self::Error>;
    fn pointcloud_object_byte_length(&self, object_hash: &ObjectHash) -> Result<u64, Self::Error>;
    fn pointcloud_object_path(&self, object_hash: &ObjectHash) -> Result<PathBuf, Self::Error>;
    fn pointcloud_read_object(&self, object_hash: &ObjectHash) -> Result<Vec<u8>, Self::Error>;
    fn pointcloud_materialize_verified_path(
        &self,
        source: &std::path::Path,
        destination: &std::path::Path,
        object_hash: &ObjectHash,
        byte_length: u64,
        progress: &mut dyn FnMut(u64) -> bool,
    ) -> Result<(), Self::Error>;
    fn pointcloud_publish_package(
        &mut self,
        package: Self::Package,
        dataset_roots: BTreeMap<String, PathBuf>,
        transaction: CanonicalCommandTransaction,
        progress: &mut dyn FnMut(DomainImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalJournalEntry, Self::Error>;
    fn pointcloud_entity(
        &self,
        entity_id: &EntityId,
    ) -> Result<Option<CanonicalEntity>, Self::Error>;
    fn pointcloud_put_json_object(&mut self, object: Self::JsonObject) -> Result<(), Self::Error>;
    fn pointcloud_append_transaction(
        &mut self,
        transaction: CanonicalCommandTransaction,
    ) -> Result<CanonicalJournalEntry, Self::Error>;
}

/// Narrow project-store capabilities required by registration sampling.
pub trait RegistrationDocumentCommands {
    type Error;

    fn registration_residency_entries(&self) -> Result<Vec<DomainResidencyEntry>, Self::Error>;
    fn registration_verified_object_source(
        &self,
        object_hash: &ObjectHash,
    ) -> Result<File, Self::Error>;
}

/// Narrow canonical-document capabilities required by drafting command services.
pub trait DraftingDocumentCommands {
    type Error;

    fn drafting_entities(&self) -> std::result::Result<Vec<CanonicalEntity>, Self::Error>;
    fn drafting_tombstone_exists(
        &self,
        entity_id: &EntityId,
    ) -> std::result::Result<bool, Self::Error>;
    fn drafting_read_object(
        &self,
        object_hash: &ObjectHash,
    ) -> std::result::Result<Vec<u8>, Self::Error>;
    fn drafting_put_json_object(
        &mut self,
        object: &CanonicalJsonObject,
    ) -> std::result::Result<(), Self::Error>;
    fn drafting_put_geometry_object(
        &mut self,
        geometry: &GeometryObject,
    ) -> std::result::Result<ObjectHash, Self::Error>;
    fn drafting_append_transaction(
        &mut self,
        transaction: CanonicalCommandTransaction,
    ) -> std::result::Result<CanonicalJournalEntry, Self::Error>;
    fn drafting_undo(
        &mut self,
        command_id: String,
        target_command_id: &str,
    ) -> std::result::Result<CanonicalJournalEntry, Self::Error>;
    fn drafting_redo(
        &mut self,
        command_id: String,
        target_command_id: &str,
    ) -> std::result::Result<CanonicalJournalEntry, Self::Error>;
}
