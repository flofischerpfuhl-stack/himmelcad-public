use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::entity::{EntityId, EntitySnapshot, Vec3};

/// Wire-level snapshot of the project. The renderer mirrors this structure;
/// it is also persisted as `manifest.json` (with stable key ordering for
/// diff-friendliness).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub format_version: u32,
    pub project_id: String,
    pub name: String,
    pub root_entity: EntityId,
    pub entities: BTreeMap<String, EntitySnapshot>,
    pub render_offset: Vec3,
}
