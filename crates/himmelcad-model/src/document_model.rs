//! Canonical document DTOs owned by the object model.

use serde::{Deserialize, Serialize};

use crate::entity::EntityId;
use crate::entity_model::{CanonicalEntity, Representation, Transform3d};
use crate::hash::ObjectHash;

/// Exact optimistic reference to one live entity or tombstone revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityVersionRef {
    /// Stable entity identity.
    pub id: EntityId,
    /// Exact monotone state revision.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub revision: u64,
    /// Exact content hash of the live entity envelope or tombstone.
    pub version_hash: ObjectHash,
}

impl EntityVersionRef {
    /// Builds an optimistic reference to a live canonical entity.
    #[must_use]
    pub fn from_entity(entity: &CanonicalEntity) -> Self {
        Self {
            id: entity.id.clone(),
            revision: entity.revision,
            version_hash: entity.version_hash.clone(),
        }
    }

    /// Builds an optimistic reference to a deleted entity state.
    #[must_use]
    pub fn from_tombstone(tombstone: &CanonicalEntityTombstone) -> Self {
        Self {
            id: tombstone.id.clone(),
            revision: tombstone.revision,
            version_hash: tombstone.version_hash.clone(),
        }
    }
}

/// Immutable deleted state preventing stable identity reuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalEntityTombstone {
    /// Stable deleted entity identity.
    pub id: EntityId,
    /// Monotone state revision assigned by deletion.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub revision: u64,
    /// Last live entity version removed by the deletion.
    pub deleted_entity_version_hash: ObjectHash,
    /// Content hash of this tombstone contract.
    pub version_hash: ObjectHash,
}

/// Canonical envelope field touched by an update or existence transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CanonicalEntityField {
    /// Versioned semantic type.
    TypeId,
    /// User-facing name.
    Name,
    /// Hierarchy owner.
    Owner,
    /// Layer memberships.
    LayerIds,
    /// Entity-level project placement.
    Placement,
    /// Immutable geometry representation set.
    Representations,
    /// Typed component-map reference.
    ComponentsRef,
    /// Attribute-table reference.
    AttributesRef,
    /// Relation-set reference.
    RelationsRef,
    /// Optional style assignment.
    StyleRef,
    /// Entity envelope schema version.
    SchemaVersion,
}

/// Typed absolute edit of one canonical entity envelope field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CanonicalEntityEdit {
    /// Assigns an exact user-facing name.
    SetName { name: String },
    /// Assigns an exact hierarchy owner.
    SetOwner { owner: Option<EntityId> },
    /// Assigns the complete ordered layer-membership set.
    SetLayerIds { layer_ids: Vec<EntityId> },
    /// Assigns an exact optional placement.
    SetPlacement { placement: Option<Transform3d> },
    /// Replaces the complete immutable representation set.
    SetRepresentations {
        representations: Vec<Representation>,
    },
    /// Assigns the typed component-map reference.
    SetComponentsRef { components_ref: ObjectHash },
    /// Assigns the attribute-table reference.
    SetAttributesRef { attributes_ref: ObjectHash },
    /// Assigns the relation-set reference.
    SetRelationsRef { relations_ref: ObjectHash },
    /// Assigns an exact optional style reference.
    SetStyleRef { style_ref: Option<ObjectHash> },
}

impl CanonicalEntityEdit {
    /// Returns the canonical field assigned by this edit.
    #[doc(hidden)]
    #[must_use]
    pub fn field(&self) -> CanonicalEntityField {
        match self {
            Self::SetName { .. } => CanonicalEntityField::Name,
            Self::SetOwner { .. } => CanonicalEntityField::Owner,
            Self::SetLayerIds { .. } => CanonicalEntityField::LayerIds,
            Self::SetPlacement { .. } => CanonicalEntityField::Placement,
            Self::SetRepresentations { .. } => CanonicalEntityField::Representations,
            Self::SetComponentsRef { .. } => CanonicalEntityField::ComponentsRef,
            Self::SetAttributesRef { .. } => CanonicalEntityField::AttributesRef,
            Self::SetRelationsRef { .. } => CanonicalEntityField::RelationsRef,
            Self::SetStyleRef { .. } => CanonicalEntityField::StyleRef,
        }
    }

    /// Applies this exact edit to an entity envelope.
    #[doc(hidden)]
    pub fn apply(&self, entity: &mut CanonicalEntity) {
        match self {
            Self::SetName { name } => entity.name.clone_from(name),
            Self::SetOwner { owner } => entity.owner.clone_from(owner),
            Self::SetLayerIds { layer_ids } => entity.layer_ids.clone_from(layer_ids),
            Self::SetPlacement { placement } => entity.placement = *placement,
            Self::SetRepresentations { representations } => {
                entity.representations.clone_from(representations);
            }
            Self::SetComponentsRef { components_ref } => {
                entity.components_ref.clone_from(components_ref);
            }
            Self::SetAttributesRef { attributes_ref } => {
                entity.attributes_ref.clone_from(attributes_ref);
            }
            Self::SetRelationsRef { relations_ref } => {
                entity.relations_ref.clone_from(relations_ref);
            }
            Self::SetStyleRef { style_ref } => entity.style_ref.clone_from(style_ref),
        }
    }
}

/// One state transition inside an atomic canonical command transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(
        tag = "operation",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CanonicalEntityMutation {
    /// Creates a never-before-used stable identity at revision zero.
    Create { entity: CanonicalEntity },
    /// Applies typed absolute edits to an exact live entity revision.
    Update {
        expected: EntityVersionRef,
        edits: Vec<CanonicalEntityEdit>,
    },
    /// Replaces an exact live entity revision with a tombstone.
    Delete { expected: EntityVersionRef },
    /// Restores a prior snapshot over an exact tombstone as a new revision.
    Restore {
        expected: EntityVersionRef,
        snapshot: CanonicalEntity,
    },
}

impl CanonicalEntityMutation {
    /// Returns the stable identity affected by this transition.
    #[doc(hidden)]
    #[must_use]
    pub fn entity_id(&self) -> &EntityId {
        match self {
            Self::Create { entity } => &entity.id,
            Self::Update { expected, .. }
            | Self::Delete { expected }
            | Self::Restore { expected, .. } => &expected.id,
        }
    }
}

/// Atomic user-authored canonical transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalCommandTransaction {
    /// Stable, globally unique command identity.
    pub command_id: String,
    /// Entity transitions committed all-or-none in the supplied order.
    pub mutations: Vec<CanonicalEntityMutation>,
}

/// Forward operation represented by one immutable journal entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CanonicalJournalEntryKind {
    /// Ordinary user-authored transaction.
    Command,
    /// Compensating transaction restoring a command's before state.
    Undo,
    /// Compensating transaction restoring an undone command's after state.
    Redo,
}

/// Exact state effect accepted for one stable entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalEntityEffect {
    /// Stable affected identity.
    pub entity_id: EntityId,
    /// Live state before the transaction, or `None` for create/restore.
    pub before: Option<CanonicalEntity>,
    /// Live state after the transaction, or `None` for delete.
    pub after: Option<CanonicalEntity>,
    /// Semantic fields owned by this effect for conflict-aware compensation.
    pub touched_fields: Vec<CanonicalEntityField>,
}

/// Serializable immutable record of one committed forward transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalJournalEntry {
    /// Monotone JavaScript-safe acceptance sequence.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub sequence: u64,
    /// Stable unique identity of this forward transaction.
    pub command_id: String,
    /// Whether this is an ordinary command or a compensation.
    pub kind: CanonicalJournalEntryKind,
    /// Original command compensated or reapplied by undo/redo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_command_id: Option<String>,
    /// Complete immutable entity snapshots affected by this transaction.
    pub effects: Vec<CanonicalEntityEffect>,
}
