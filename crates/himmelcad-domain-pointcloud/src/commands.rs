//! Point-cloud command-family contracts shared with the sidecar orchestrator.

use std::path::PathBuf;

use himmelcad_document::canonical_document::{CanonicalJournalEntry, EntityVersionRef};
use himmelcad_model::canonical_resources::PointCloudDisplayStyle;
use himmelcad_model::entity_model::CanonicalEntity;
use himmelcad_model::hash::ObjectHash;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::pointcloud_ground::{PreparedGroundDataset, GROUND_ALGORITHM_ID};
use crate::pointcloud_segment::SEGMENT_ALGORITHM_ID;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPointCloudMetadata {
    pub point_count: u64,
    pub source_crs: Option<String>,
    pub source_units: Option<String>,
    pub placement_offset: [f64; 3],
    pub display: PointCloudDisplayStyle,
}

#[derive(Debug, Clone)]
pub struct CanonicalGroundSource {
    pub expected: EntityVersionRef,
    pub entity: CanonicalEntity,
    pub representation_slot: String,
    pub input_root: PathBuf,
    pub source_components: serde_json::Value,
    pub source_attributes: serde_json::Value,
    pub source_relations: serde_json::Value,
    pub source_style: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSourceCaptureProgress {
    pub artifact: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CanonicalSourceCaptureArtifact {
    pub artifact: String,
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub object_hash: ObjectHash,
    pub byte_length: u64,
}

#[derive(Debug, Clone)]
pub struct CanonicalGroundSourceCapture {
    pub source: CanonicalGroundSource,
    pub artifacts: Vec<CanonicalSourceCaptureArtifact>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalGroundCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub source_entity_id: String,
    pub source_revision: u64,
    pub ground_entity_id: String,
    pub ground_revision: u64,
    pub source_dataset_id: String,
    pub ground_dataset_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSegmentCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub revisions: Vec<CanonicalSegmentRevision>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSegmentRevision {
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
    pub retained_points: u64,
    pub removed_points: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalSampleCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalRasterizeCommit {
    pub journal_entry: CanonicalJournalEntry,
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
    pub entity_type: String,
    pub mesh_source_role: Option<String>,
}

pub fn ground_dataset_id(prefix: &str, dataset: &PreparedGroundDataset) -> String {
    let mut digest = Sha256::new();
    digest.update(GROUND_ALGORITHM_ID.as_bytes());
    digest.update(prefix.as_bytes());
    digest.update(dataset.point_count.to_le_bytes());
    for artifact in &dataset.artifacts {
        digest.update(artifact.relative_path.as_bytes());
        digest.update(artifact.object_hash.as_str().as_bytes());
        digest.update(artifact.byte_length.to_le_bytes());
    }
    format!("ground-{prefix}-{}", hex::encode(digest.finalize()))
}

pub fn segment_dataset_id(dataset: &PreparedGroundDataset) -> String {
    let mut digest = Sha256::new();
    digest.update(SEGMENT_ALGORITHM_ID.as_bytes());
    digest.update(dataset.point_count.to_le_bytes());
    for artifact in &dataset.artifacts {
        digest.update(artifact.relative_path.as_bytes());
        digest.update(artifact.object_hash.as_str().as_bytes());
        digest.update(artifact.byte_length.to_le_bytes());
    }
    format!("segment-{}", hex::encode(digest.finalize()))
}

pub fn derived_point_dataset_id(
    prefix: &str,
    algorithm_id: &str,
    dataset: &PreparedGroundDataset,
) -> String {
    let mut digest = Sha256::new();
    digest.update(algorithm_id.as_bytes());
    digest.update(prefix.as_bytes());
    digest.update(dataset.point_count.to_le_bytes());
    for artifact in &dataset.artifacts {
        digest.update(artifact.relative_path.as_bytes());
        digest.update(artifact.object_hash.as_str().as_bytes());
        digest.update(artifact.byte_length.to_le_bytes());
    }
    format!("{prefix}-{}", hex::encode(digest.finalize()))
}

#[allow(clippy::too_many_arguments)]
pub fn derived_recipe_value(
    recipe_id: &str,
    algorithm_id: &str,
    output_group_id: &str,
    slot_id: &str,
    output_role: &str,
    output_type: &str,
    output_hash: &ObjectHash,
    source: &CanonicalGroundSource,
    source_role: &str,
    parameters: serde_json::Value,
    source_fingerprint: ObjectHash,
    completed_at: String,
) -> serde_json::Value {
    serde_json::json!({
        "schemaId": "hcad.derived-recipe@1",
        "schemaVersion": 1,
        "recipeId": recipe_id,
        "recipeKind": algorithm_id,
        "generation": 1,
        "state": "linked-current",
        "outputGroupId": output_group_id,
        "outputs": [{
            "slotId": slot_id,
            "role": output_role,
            "outputId": output_group_id,
            "typeId": output_type,
            "locator": "source",
            "currentRevision": 0,
            "currentContentHash": output_hash,
            "status": "present",
        }],
        "sources": [{
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "placementRevision": source.entity.revision,
            "role": source_role,
        }],
        "parameterTypeId": algorithm_id,
        "parameters": parameters,
        "algorithmId": algorithm_id,
        "algorithmVersion": "1",
        "dependencyRecipeIds": [],
        "staleCauses": [],
        "lastSuccess": {
            "generation": 1,
            "sourceFingerprint": source_fingerprint,
            "outputs": [{
                "slotId": slot_id,
                "outputId": output_group_id,
                "revision": 0,
                "contentHash": output_hash,
            }],
            "completedAt": completed_at,
        },
        "lastError": null,
        "detach": null,
    })
}
