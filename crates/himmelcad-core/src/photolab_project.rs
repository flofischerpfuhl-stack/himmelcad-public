//! Persisted Photolab project, journal, and session contracts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::entity::{EntityId, EntitySnapshot, Vec3};
use crate::hash::ObjectHash;
use crate::photolab_crs::FrozenCrsEndpoint;

/// Current on-disk schema version for Photolab `.hcad` working projects.
pub const PHOTOLAB_PROJECT_FORMAT_VERSION: u32 = 1;

/// Atomic manifest written into the root of a `.hcad` working directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabProjectManifest {
    pub format_version: u32,
    #[serde(default = "legacy_coordinate_axis_contract_version")]
    pub coordinate_axis_contract_version: u32,
    pub project_id: String,
    pub name: String,
    pub created_unix_ms: u64,
    pub modified_unix_ms: u64,
    pub autosave_generation: u64,
    pub command_sequence: u64,
    pub clean_shutdown: bool,
    pub root_entity: EntityId,
    pub entities: BTreeMap<String, EntitySnapshot>,
    pub render_offset: Vec3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_frame: Option<ProjectReferenceFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_quality_catalog_hash: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_catalog_hash: Option<ObjectHash>,
    #[serde(default)]
    pub active_runs: Vec<String>,
}

/// Cartesian world frame established by the first georeferenced import.
/// Later datasets must explicitly target this exact horizontal/vertical frame;
/// the engine never silently reprojects already committed geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReferenceFrame {
    pub target: FrozenCrsEndpoint,
    pub established_by_transformation_sha256: ObjectHash,
}

/// Command lifecycle recorded by the append-only journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalCommandState {
    Started,
    Committed,
    Cancelled,
    Failed,
}

/// One replayable journal record. Large payloads are referenced by object hash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabJournalEntry {
    pub sequence: u64,
    pub command_id: String,
    pub command_kind: String,
    pub timestamp_unix_ms: u64,
    pub state: JournalCommandState,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub affected_entities: Vec<EntityId>,
    #[serde(default)]
    pub before_refs: Vec<ObjectHash>,
    #[serde(default)]
    pub after_refs: Vec<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Source and local working paths are explicit so network projects never hide I/O behavior.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionSummary {
    pub session_id: String,
    pub source_path: String,
    pub working_path: String,
    pub uses_local_working_copy: bool,
    pub recovery_available: bool,
    pub read_only: bool,
    pub autosave_generation: u64,
    pub last_saved_generation: u64,
}

/// Snapshot returned to the renderer after creating or opening a project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPhotolabProjectResult {
    pub session: ProjectSessionSummary,
    pub manifest: PhotolabProjectManifest,
}

/// Creates the deterministic initial tree for a new Photolab project.
#[must_use]
pub fn initial_photolab_manifest(
    project_id: String,
    name: String,
    timestamp_unix_ms: u64,
) -> PhotolabProjectManifest {
    let root_id = EntityId(format!("{project_id}:root"));
    let survey_id = EntityId(format!("{project_id}:survey:1"));
    let images_id = EntityId(format!("{project_id}:images"));
    let reference_id = EntityId(format!("{project_id}:reference"));
    let products_id = EntityId(format!("{project_id}:products"));

    let mut entities = BTreeMap::new();
    entities.insert(
        root_id.0.clone(),
        entity(
            root_id.clone(),
            crate::entity::EntityKind::ProjectRoot,
            name.clone(),
            None,
            vec![survey_id.clone()],
        ),
    );
    entities.insert(
        survey_id.0.clone(),
        entity(
            survey_id.clone(),
            crate::entity::EntityKind::Survey,
            "Survey 01".to_owned(),
            Some(root_id.clone()),
            vec![images_id.clone(), reference_id.clone(), products_id.clone()],
        ),
    );
    entities.insert(
        images_id.0.clone(),
        entity(
            images_id,
            crate::entity::EntityKind::ImageCollection,
            "Images · 0".to_owned(),
            Some(survey_id.clone()),
            Vec::new(),
        ),
    );
    entities.insert(
        reference_id.0.clone(),
        entity(
            reference_id,
            crate::entity::EntityKind::Group,
            "Reference & GCPs".to_owned(),
            Some(survey_id.clone()),
            Vec::new(),
        ),
    );
    entities.insert(
        products_id.0.clone(),
        entity(
            products_id,
            crate::entity::EntityKind::Group,
            "Products".to_owned(),
            Some(survey_id),
            Vec::new(),
        ),
    );

    PhotolabProjectManifest {
        format_version: PHOTOLAB_PROJECT_FORMAT_VERSION,
        coordinate_axis_contract_version: 2,
        project_id,
        name,
        created_unix_ms: timestamp_unix_ms,
        modified_unix_ms: timestamp_unix_ms,
        autosave_generation: 0,
        command_sequence: 0,
        clean_shutdown: true,
        root_entity: root_id,
        entities,
        render_offset: Vec3::default(),
        reference_frame: None,
        image_quality_catalog_hash: None,
        image_mask_catalog_hash: None,
        active_runs: Vec::new(),
    }
}

const fn legacy_coordinate_axis_contract_version() -> u32 {
    1
}

fn entity(
    id: EntityId,
    kind: crate::entity::EntityKind,
    name: String,
    parent: Option<EntityId>,
    children: Vec<EntityId>,
) -> EntitySnapshot {
    let hash_input = format!("{}:{kind:?}:{name}", id.0);
    EntitySnapshot {
        id,
        kind,
        name,
        parent,
        children,
        visibility: crate::entity::VisibilityState::default(),
        version_hash: ObjectHash::of_bytes(hash_input.as_bytes()),
        bounds: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_manifest_contains_explicit_photolab_tree() {
        let manifest = initial_photolab_manifest("project-1".to_owned(), "Test".to_owned(), 42);

        assert_eq!(manifest.entities.len(), 5);
        assert_eq!(manifest.root_entity.0, "project-1:root");
        assert_eq!(manifest.format_version, PHOTOLAB_PROJECT_FORMAT_VERSION);
        assert!(manifest
            .entities
            .values()
            .any(|entity| entity.kind == crate::entity::EntityKind::ImageCollection));
    }

    #[test]
    fn manifest_serializes_with_stable_camel_case_contract() {
        let manifest = initial_photolab_manifest("project-2".to_owned(), "Test".to_owned(), 42);
        let value = serde_json::to_value(manifest).expect("manifest must serialize");

        assert_eq!(value["formatVersion"], 1);
        assert_eq!(value["coordinateAxisContractVersion"], 2);
        assert_eq!(value["autosaveGeneration"], 0);
        assert_eq!(value["cleanShutdown"], true);
        assert!(value["entities"]["project-2:root"]["versionHash"].is_string());
        assert!(value["entities"]["project-2:root"]["version_hash"].is_null());
    }
}
