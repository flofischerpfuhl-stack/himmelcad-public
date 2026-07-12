//! Wire contract between the Rust core and any frontend (Electron renderer or
//! WeltView WASM). When the `ts-bindings` feature is enabled, `cargo test`
//! emits TypeScript types into `packages/@himmelcad/data/src/generated/`.

use serde::{Deserialize, Serialize};

use crate::entity::EntityId;
use crate::photolab::ResolveAlignmentProfileRequest;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "PascalCase")]
pub enum CommandRequest {
    CreateProject {
        name: String,
    },
    OpenProject {
        path: String,
    },
    ImportPointCloudBatch {
        paths: Vec<String>,
    },
    RenameEntity {
        id: EntityId,
        new_name: String,
    },
    SetEntityVisibility {
        id: EntityId,
        visible: bool,
    },
    SetPanelState {
        panel: String,
        value: serde_json::Value,
    },
    ResolvePhotolabAlignmentProfile(ResolveAlignmentProfileRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub ok: bool,
    pub affected_entities: Vec<EntityId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CoreEvent {
    Log {
        level: String,
        message: String,
    },
    Progress {
        token: String,
        fraction: f32,
        label: String,
    },
    EntityChanged {
        id: EntityId,
    },
    ProjectChanged,
}
