//! Render-independent authority for canonical entity state and command history.
//!
//! Transactions are prepared against one immutable document generation. A prepared
//! transaction contains every resulting entity state and can therefore be committed
//! without another fallible semantic step. Undo and redo are compensating forward
//! transactions; neither operation rewinds entity revisions or journal sequence.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::entity::EntityId;
use crate::entity_model::{built_in_type, CanonicalEntity, Representation, Transform3d};
use crate::entity_validation::{
    canonical_entity_version_hash, validate_canonical_entity_semantics,
};
use crate::hash::ObjectHash;

const JAVASCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

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
    fn field(&self) -> CanonicalEntityField {
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

    fn apply(&self, entity: &mut CanonicalEntity) {
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
    fn entity_id(&self) -> &EntityId {
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

#[derive(Debug, Clone)]
enum PreparedEntityState {
    Live(Box<CanonicalEntity>),
    Deleted(CanonicalEntityTombstone),
}

/// Fully validated transaction that can be committed without partial mutation.
#[derive(Debug, Clone)]
pub struct PreparedCanonicalTransaction {
    base_generation: u64,
    next_generation: u64,
    states: BTreeMap<String, PreparedEntityState>,
    journal_entry: CanonicalJournalEntry,
}

impl PreparedCanonicalTransaction {
    /// Immutable journal entry that will be appended by a successful commit.
    #[must_use]
    pub fn journal_entry(&self) -> &CanonicalJournalEntry {
        &self.journal_entry
    }

    /// Document generation against which this transaction was prepared.
    #[must_use]
    pub const fn base_generation(&self) -> u64 {
        self.base_generation
    }
}

/// Reason a canonical document transaction was rejected before mutation.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CanonicalDocumentError {
    /// A stable command identity is empty or contains a null character.
    #[error("canonical command id is invalid")]
    InvalidCommandId,
    /// This command identity already exists in the immutable journal.
    #[error("canonical command id is already journaled")]
    DuplicateCommandId,
    /// An atomic transaction must affect at least one entity.
    #[error("canonical transaction is empty")]
    EmptyTransaction,
    /// One transaction contains more than one transition for the same identity.
    #[error("canonical transaction mutates entity {entity_id:?} more than once")]
    DuplicateMutation { entity_id: EntityId },
    /// A stable identity was previously created and cannot be reused.
    #[error("canonical entity {entity_id:?} already exists or is tombstoned")]
    EntityAlreadyExists { entity_id: EntityId },
    /// The requested live entity does not exist.
    #[error("canonical entity {entity_id:?} is not live")]
    EntityNotFound { entity_id: EntityId },
    /// The requested deleted entity state does not exist.
    #[error("canonical entity {entity_id:?} has no tombstone")]
    TombstoneNotFound { entity_id: EntityId },
    /// The optimistic entity or tombstone revision/hash is stale.
    #[error("canonical state reference for {entity_id:?} is stale")]
    VersionConflict { entity_id: EntityId },
    /// A create command did not supply revision zero.
    #[error("new canonical entity {entity_id:?} must start at revision zero")]
    InvalidCreateRevision { entity_id: EntityId },
    /// A revision or journal sequence exceeded the JavaScript-safe wire range.
    #[error("canonical monotone revision or sequence is exhausted")]
    RevisionExhausted,
    /// An entity failed the canonical semantic admission gate.
    #[error("canonical entity {entity_id:?} is invalid")]
    InvalidEntity { entity_id: EntityId },
    /// An update contains no typed field edit.
    #[error("canonical update for {entity_id:?} is empty")]
    EmptyUpdate { entity_id: EntityId },
    /// An update assigns the same field more than once.
    #[error("canonical update for {entity_id:?} assigns {field:?} more than once")]
    DuplicateEdit {
        entity_id: EntityId,
        field: CanonicalEntityField,
    },
    /// A layer membership repeats the same layer identity.
    #[error("canonical entity {entity_id:?} repeats layer {layer_id:?}")]
    DuplicateLayer {
        entity_id: EntityId,
        layer_id: EntityId,
    },
    /// A hierarchy owner does not exist in the final transaction overlay.
    #[error("owner {owner_id:?} of canonical entity {entity_id:?} does not exist")]
    MissingOwner {
        entity_id: EntityId,
        owner_id: EntityId,
    },
    /// A layer membership does not exist in the final transaction overlay.
    #[error("layer {layer_id:?} of canonical entity {entity_id:?} does not exist")]
    MissingLayer {
        entity_id: EntityId,
        layer_id: EntityId,
    },
    /// A layer membership targets a live entity that is not a layer.
    #[error("layer reference {layer_id:?} of canonical entity {entity_id:?} is not a layer")]
    InvalidLayerType {
        entity_id: EntityId,
        layer_id: EntityId,
    },
    /// The final owner graph contains a cycle.
    #[error("canonical owner graph contains a cycle")]
    OwnerCycle,
    /// The final layer-membership graph contains a cycle.
    #[error("canonical layer graph contains a cycle")]
    LayerCycle,
    /// The prepared transaction no longer observes the current document generation.
    #[error("prepared canonical transaction is stale")]
    PreparedTransactionStale,
    /// The requested root command does not exist or is not an ordinary command.
    #[error("canonical root command {command_id:?} is unavailable")]
    CommandUnavailable { command_id: String },
    /// The requested command is already undone.
    #[error("canonical root command {command_id:?} is already undone")]
    CommandAlreadyUndone { command_id: String },
    /// The requested command has not been undone and cannot be redone.
    #[error("canonical root command {command_id:?} is not undone")]
    CommandNotUndone { command_id: String },
    /// A touched field changed after the command and cannot be compensated safely.
    #[error("canonical field {field:?} of {entity_id:?} conflicts with compensation")]
    TouchedFieldConflict {
        entity_id: EntityId,
        field: CanonicalEntityField,
    },
    /// Journal bytes do not describe a valid forward state transition.
    #[error("canonical journal entry is invalid")]
    InvalidJournalEntry,
}

/// Authoritative render-independent canonical entity document.
#[derive(Debug, Clone, Default)]
pub struct CanonicalDocument {
    entities: BTreeMap<String, CanonicalEntity>,
    tombstones: BTreeMap<String, CanonicalEntityTombstone>,
    journal: Vec<CanonicalJournalEntry>,
    command_ids: BTreeSet<String>,
    generation: u64,
}

impl CanonicalDocument {
    /// Current monotone document generation and journal sequence.
    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    /// Returns one current live entity.
    #[must_use]
    pub fn entity(&self, entity_id: &EntityId) -> Option<&CanonicalEntity> {
        self.entities.get(&entity_id.0)
    }

    /// Returns one current deleted entity state.
    #[must_use]
    pub fn tombstone(&self, entity_id: &EntityId) -> Option<&CanonicalEntityTombstone> {
        self.tombstones.get(&entity_id.0)
    }

    /// Iterates all current live entities in stable identity order.
    pub fn entities(&self) -> impl Iterator<Item = &CanonicalEntity> {
        self.entities.values()
    }

    /// Complete immutable journal in acceptance order.
    #[must_use]
    pub fn journal(&self) -> &[CanonicalJournalEntry] {
        &self.journal
    }

    /// Fully validates an ordinary transaction without mutating document state.
    pub fn prepare_transaction(
        &self,
        transaction: CanonicalCommandTransaction,
    ) -> Result<PreparedCanonicalTransaction, CanonicalDocumentError> {
        self.prepare_transaction_with_kind(transaction, CanonicalJournalEntryKind::Command, None)
    }

    /// Prepares a compensating forward transaction restoring a command's before state.
    ///
    /// Only fields originally owned by the target command participate in conflict
    /// detection. Unrelated later field edits are preserved in the new revision.
    pub fn prepare_undo(
        &self,
        command_id: String,
        target_command_id: &str,
    ) -> Result<PreparedCanonicalTransaction, CanonicalDocumentError> {
        let target = self.available_root_command(target_command_id)?.clone();
        if !self.root_command_is_active(target_command_id) {
            return Err(CanonicalDocumentError::CommandAlreadyUndone {
                command_id: target_command_id.to_owned(),
            });
        }
        let mutations = self.compensating_mutations(&target, false)?;
        self.prepare_transaction_with_kind(
            CanonicalCommandTransaction {
                command_id,
                mutations,
            },
            CanonicalJournalEntryKind::Undo,
            Some(target_command_id.to_owned()),
        )
    }

    /// Prepares a compensating forward transaction reapplying an undone command.
    pub fn prepare_redo(
        &self,
        command_id: String,
        target_command_id: &str,
    ) -> Result<PreparedCanonicalTransaction, CanonicalDocumentError> {
        let target = self.available_root_command(target_command_id)?.clone();
        if self.root_command_is_active(target_command_id) {
            return Err(CanonicalDocumentError::CommandNotUndone {
                command_id: target_command_id.to_owned(),
            });
        }
        let mutations = self.compensating_mutations(&target, true)?;
        self.prepare_transaction_with_kind(
            CanonicalCommandTransaction {
                command_id,
                mutations,
            },
            CanonicalJournalEntryKind::Redo,
            Some(target_command_id.to_owned()),
        )
    }

    /// Atomically commits one still-current prepared transaction.
    pub fn commit(
        &mut self,
        prepared: PreparedCanonicalTransaction,
    ) -> Result<CanonicalJournalEntry, CanonicalDocumentError> {
        if self.generation != prepared.base_generation
            || self
                .command_ids
                .contains(&prepared.journal_entry.command_id)
            || prepared.next_generation != self.generation.saturating_add(1)
        {
            return Err(CanonicalDocumentError::PreparedTransactionStale);
        }

        for (entity_id, state) in prepared.states {
            match state {
                PreparedEntityState::Live(entity) => {
                    self.tombstones.remove(&entity_id);
                    self.entities.insert(entity_id, *entity);
                }
                PreparedEntityState::Deleted(tombstone) => {
                    self.entities.remove(&entity_id);
                    self.tombstones.insert(entity_id, tombstone);
                }
            }
        }
        self.generation = prepared.next_generation;
        self.command_ids
            .insert(prepared.journal_entry.command_id.clone());
        self.journal.push(prepared.journal_entry.clone());
        Ok(prepared.journal_entry)
    }

    /// Prepares and atomically commits one ordinary transaction.
    pub fn execute(
        &mut self,
        transaction: CanonicalCommandTransaction,
    ) -> Result<CanonicalJournalEntry, CanonicalDocumentError> {
        let prepared = self.prepare_transaction(transaction)?;
        self.commit(prepared)
    }

    /// Reconstructs authoritative state by validating and replaying journal entries.
    pub fn from_journal(entries: &[CanonicalJournalEntry]) -> Result<Self, CanonicalDocumentError> {
        let mut document = Self::default();
        for entry in entries {
            let prepared = document.prepare_replayed_entry(entry.clone())?;
            document.commit(prepared)?;
        }
        Ok(document)
    }

    fn prepare_transaction_with_kind(
        &self,
        transaction: CanonicalCommandTransaction,
        kind: CanonicalJournalEntryKind,
        related_command_id: Option<String>,
    ) -> Result<PreparedCanonicalTransaction, CanonicalDocumentError> {
        self.validate_command_identity(&transaction.command_id)?;
        if transaction.mutations.is_empty() {
            return Err(CanonicalDocumentError::EmptyTransaction);
        }
        let next_generation = self.next_generation()?;
        let mut states = BTreeMap::new();
        let mut effects = Vec::with_capacity(transaction.mutations.len());

        for mutation in transaction.mutations {
            let entity_id = mutation.entity_id().clone();
            if states.contains_key(&entity_id.0) {
                return Err(CanonicalDocumentError::DuplicateMutation { entity_id });
            }
            let (state, effect) = self.prepare_mutation(mutation)?;
            states.insert(entity_id.0, state);
            effects.push(effect);
        }
        self.validate_final_overlay(&states)?;

        Ok(PreparedCanonicalTransaction {
            base_generation: self.generation,
            next_generation,
            states,
            journal_entry: CanonicalJournalEntry {
                sequence: next_generation,
                command_id: transaction.command_id,
                kind,
                related_command_id,
                effects,
            },
        })
    }

    fn prepare_mutation(
        &self,
        mutation: CanonicalEntityMutation,
    ) -> Result<(PreparedEntityState, CanonicalEntityEffect), CanonicalDocumentError> {
        match mutation {
            CanonicalEntityMutation::Create { entity } => self.prepare_create(entity),
            CanonicalEntityMutation::Update { expected, edits } => {
                self.prepare_update(expected, edits)
            }
            CanonicalEntityMutation::Delete { expected } => self.prepare_delete(&expected),
            CanonicalEntityMutation::Restore { expected, snapshot } => {
                self.prepare_restore(expected, snapshot)
            }
        }
    }

    fn prepare_create(
        &self,
        entity: CanonicalEntity,
    ) -> Result<(PreparedEntityState, CanonicalEntityEffect), CanonicalDocumentError> {
        if self.entities.contains_key(&entity.id.0) || self.tombstones.contains_key(&entity.id.0) {
            return Err(CanonicalDocumentError::EntityAlreadyExists {
                entity_id: entity.id,
            });
        }
        if entity.revision != 0 {
            return Err(CanonicalDocumentError::InvalidCreateRevision {
                entity_id: entity.id,
            });
        }
        validate_entity(&entity)?;
        let effect = CanonicalEntityEffect {
            entity_id: entity.id.clone(),
            before: None,
            after: Some(entity.clone()),
            touched_fields: all_entity_fields(),
        };
        Ok((PreparedEntityState::Live(Box::new(entity)), effect))
    }

    fn prepare_update(
        &self,
        expected: EntityVersionRef,
        edits: Vec<CanonicalEntityEdit>,
    ) -> Result<(PreparedEntityState, CanonicalEntityEffect), CanonicalDocumentError> {
        let current = self.entities.get(&expected.id.0).ok_or_else(|| {
            CanonicalDocumentError::EntityNotFound {
                entity_id: expected.id.clone(),
            }
        })?;
        validate_live_reference(current, &expected)?;
        if edits.is_empty() {
            return Err(CanonicalDocumentError::EmptyUpdate {
                entity_id: expected.id,
            });
        }

        let mut fields = BTreeSet::new();
        let mut after = current.clone();
        for edit in edits {
            let field = edit.field();
            if !fields.insert(field) {
                return Err(CanonicalDocumentError::DuplicateEdit {
                    entity_id: expected.id,
                    field,
                });
            }
            edit.apply(&mut after);
        }
        advance_entity_revision(&mut after)?;
        validate_entity(&after)?;
        let effect = CanonicalEntityEffect {
            entity_id: current.id.clone(),
            before: Some(current.clone()),
            after: Some(after.clone()),
            touched_fields: fields.into_iter().collect(),
        };
        Ok((PreparedEntityState::Live(Box::new(after)), effect))
    }

    fn prepare_delete(
        &self,
        expected: &EntityVersionRef,
    ) -> Result<(PreparedEntityState, CanonicalEntityEffect), CanonicalDocumentError> {
        let current = self.entities.get(&expected.id.0).ok_or_else(|| {
            CanonicalDocumentError::EntityNotFound {
                entity_id: expected.id.clone(),
            }
        })?;
        validate_live_reference(current, expected)?;
        let tombstone = tombstone_after(current)?;
        let effect = CanonicalEntityEffect {
            entity_id: current.id.clone(),
            before: Some(current.clone()),
            after: None,
            touched_fields: all_entity_fields(),
        };
        Ok((PreparedEntityState::Deleted(tombstone), effect))
    }

    fn prepare_restore(
        &self,
        expected: EntityVersionRef,
        mut snapshot: CanonicalEntity,
    ) -> Result<(PreparedEntityState, CanonicalEntityEffect), CanonicalDocumentError> {
        let tombstone = self.tombstones.get(&expected.id.0).ok_or_else(|| {
            CanonicalDocumentError::TombstoneNotFound {
                entity_id: expected.id.clone(),
            }
        })?;
        validate_tombstone_reference(tombstone, &expected)?;
        if snapshot.id != expected.id {
            return Err(CanonicalDocumentError::VersionConflict {
                entity_id: expected.id,
            });
        }
        snapshot.revision = next_revision(tombstone.revision)?;
        snapshot.version_hash = canonical_entity_version_hash(&snapshot).map_err(|_| {
            CanonicalDocumentError::InvalidEntity {
                entity_id: snapshot.id.clone(),
            }
        })?;
        validate_entity(&snapshot)?;
        let effect = CanonicalEntityEffect {
            entity_id: snapshot.id.clone(),
            before: None,
            after: Some(snapshot.clone()),
            touched_fields: all_entity_fields(),
        };
        Ok((PreparedEntityState::Live(Box::new(snapshot)), effect))
    }

    fn validate_final_overlay(
        &self,
        states: &BTreeMap<String, PreparedEntityState>,
    ) -> Result<(), CanonicalDocumentError> {
        let final_entities = self.final_entities(states);
        let entities_by_id: BTreeMap<&str, &CanonicalEntity> = final_entities
            .iter()
            .map(|entity| (entity.id.0.as_str(), *entity))
            .collect();
        let ids: BTreeSet<&str> = entities_by_id.keys().copied().collect();

        let mut owner_edges = Vec::new();
        let mut layer_edges = Vec::new();
        for entity in &final_entities {
            let mut unique_layers = BTreeSet::new();
            if let Some(owner) = &entity.owner {
                if !ids.contains(owner.0.as_str()) {
                    return Err(CanonicalDocumentError::MissingOwner {
                        entity_id: entity.id.clone(),
                        owner_id: owner.clone(),
                    });
                }
                owner_edges.push((entity.id.0.as_str(), owner.0.as_str()));
            }
            for layer_id in &entity.layer_ids {
                if !unique_layers.insert(layer_id.0.as_str()) {
                    return Err(CanonicalDocumentError::DuplicateLayer {
                        entity_id: entity.id.clone(),
                        layer_id: layer_id.clone(),
                    });
                }
                let layer = entities_by_id
                    .get(layer_id.0.as_str())
                    .copied()
                    .ok_or_else(|| CanonicalDocumentError::MissingLayer {
                        entity_id: entity.id.clone(),
                        layer_id: layer_id.clone(),
                    })?;
                if layer.type_id.0 != built_in_type::LAYER {
                    return Err(CanonicalDocumentError::InvalidLayerType {
                        entity_id: entity.id.clone(),
                        layer_id: layer_id.clone(),
                    });
                }
                layer_edges.push((entity.id.0.as_str(), layer_id.0.as_str()));
            }
        }

        if directed_graph_has_cycle(&ids, &owner_edges) {
            return Err(CanonicalDocumentError::OwnerCycle);
        }
        if directed_graph_has_cycle(&ids, &layer_edges) {
            return Err(CanonicalDocumentError::LayerCycle);
        }
        Ok(())
    }

    fn final_entities<'a>(
        &'a self,
        states: &'a BTreeMap<String, PreparedEntityState>,
    ) -> Vec<&'a CanonicalEntity> {
        let mut entities = Vec::with_capacity(self.entities.len() + states.len());
        for (entity_id, current) in &self.entities {
            match states.get(entity_id) {
                Some(PreparedEntityState::Live(entity)) => entities.push(entity.as_ref()),
                Some(PreparedEntityState::Deleted(_)) => {}
                None => entities.push(current),
            }
        }
        for (entity_id, state) in states {
            if !self.entities.contains_key(entity_id) {
                if let PreparedEntityState::Live(entity) = state {
                    entities.push(entity.as_ref());
                }
            }
        }
        entities
    }

    fn compensating_mutations(
        &self,
        target: &CanonicalJournalEntry,
        redo: bool,
    ) -> Result<Vec<CanonicalEntityMutation>, CanonicalDocumentError> {
        let mut mutations = Vec::with_capacity(target.effects.len());
        for effect in &target.effects {
            let (desired, required) = if redo {
                (&effect.after, &effect.before)
            } else {
                (&effect.before, &effect.after)
            };
            match (required, desired) {
                (Some(required), Some(desired)) => {
                    let current = self.entity(&effect.entity_id).ok_or_else(|| {
                        CanonicalDocumentError::EntityNotFound {
                            entity_id: effect.entity_id.clone(),
                        }
                    })?;
                    validate_touched_fields(current, required, &effect.touched_fields)?;
                    mutations.push(CanonicalEntityMutation::Update {
                        expected: EntityVersionRef::from_entity(current),
                        edits: edits_from_snapshot(desired, &effect.touched_fields)?,
                    });
                }
                (Some(required), None) => {
                    let current = self.entity(&effect.entity_id).ok_or_else(|| {
                        CanonicalDocumentError::EntityNotFound {
                            entity_id: effect.entity_id.clone(),
                        }
                    })?;
                    validate_touched_fields(current, required, &effect.touched_fields)?;
                    mutations.push(CanonicalEntityMutation::Delete {
                        expected: EntityVersionRef::from_entity(current),
                    });
                }
                (None, Some(desired)) => {
                    let tombstone = self.tombstone(&effect.entity_id).ok_or_else(|| {
                        CanonicalDocumentError::TombstoneNotFound {
                            entity_id: effect.entity_id.clone(),
                        }
                    })?;
                    mutations.push(CanonicalEntityMutation::Restore {
                        expected: EntityVersionRef::from_tombstone(tombstone),
                        snapshot: desired.clone(),
                    });
                }
                (None, None) => return Err(CanonicalDocumentError::InvalidJournalEntry),
            }
        }
        Ok(mutations)
    }

    fn available_root_command(
        &self,
        command_id: &str,
    ) -> Result<&CanonicalJournalEntry, CanonicalDocumentError> {
        self.journal
            .iter()
            .find(|entry| {
                entry.command_id == command_id && entry.kind == CanonicalJournalEntryKind::Command
            })
            .ok_or_else(|| CanonicalDocumentError::CommandUnavailable {
                command_id: command_id.to_owned(),
            })
    }

    fn root_command_is_active(&self, command_id: &str) -> bool {
        let mut active = true;
        for entry in &self.journal {
            if entry.related_command_id.as_deref() == Some(command_id) {
                active = entry.kind == CanonicalJournalEntryKind::Redo;
            }
        }
        active
    }

    fn prepare_replayed_entry(
        &self,
        entry: CanonicalJournalEntry,
    ) -> Result<PreparedCanonicalTransaction, CanonicalDocumentError> {
        self.validate_command_identity(&entry.command_id)?;
        let next_generation = self.next_generation()?;
        if entry.sequence != next_generation || entry.effects.is_empty() {
            return Err(CanonicalDocumentError::InvalidJournalEntry);
        }
        match entry.kind {
            CanonicalJournalEntryKind::Command if entry.related_command_id.is_none() => {}
            CanonicalJournalEntryKind::Undo | CanonicalJournalEntryKind::Redo => {
                let related = entry
                    .related_command_id
                    .as_deref()
                    .ok_or(CanonicalDocumentError::InvalidJournalEntry)?;
                self.available_root_command(related)?;
                let active = self.root_command_is_active(related);
                if (entry.kind == CanonicalJournalEntryKind::Undo && !active)
                    || (entry.kind == CanonicalJournalEntryKind::Redo && active)
                {
                    return Err(CanonicalDocumentError::InvalidJournalEntry);
                }
            }
            CanonicalJournalEntryKind::Command => {
                return Err(CanonicalDocumentError::InvalidJournalEntry);
            }
        }

        let mut states = BTreeMap::new();
        for effect in &entry.effects {
            if states.contains_key(&effect.entity_id.0) || !valid_touched_fields(effect) {
                return Err(CanonicalDocumentError::InvalidJournalEntry);
            }
            let state = self.replay_effect(effect)?;
            states.insert(effect.entity_id.0.clone(), state);
        }
        self.validate_final_overlay(&states)?;
        Ok(PreparedCanonicalTransaction {
            base_generation: self.generation,
            next_generation,
            states,
            journal_entry: entry,
        })
    }

    fn replay_effect(
        &self,
        effect: &CanonicalEntityEffect,
    ) -> Result<PreparedEntityState, CanonicalDocumentError> {
        match (&effect.before, &effect.after) {
            (None, Some(after)) => {
                if after.id != effect.entity_id {
                    return Err(CanonicalDocumentError::InvalidJournalEntry);
                }
                match self.tombstone(&effect.entity_id) {
                    Some(tombstone) => {
                        if after.revision != next_revision(tombstone.revision)? {
                            return Err(CanonicalDocumentError::InvalidJournalEntry);
                        }
                    }
                    None => {
                        if self.entity(&effect.entity_id).is_some() || after.revision != 0 {
                            return Err(CanonicalDocumentError::InvalidJournalEntry);
                        }
                    }
                }
                validate_entity(after)?;
                Ok(PreparedEntityState::Live(Box::new(after.clone())))
            }
            (Some(before), Some(after)) => {
                let current = self
                    .entity(&effect.entity_id)
                    .ok_or(CanonicalDocumentError::InvalidJournalEntry)?;
                if current != before
                    || before.id != effect.entity_id
                    || after.id != effect.entity_id
                    || after.revision != next_revision(before.revision)?
                {
                    return Err(CanonicalDocumentError::InvalidJournalEntry);
                }
                validate_entity(after)?;
                Ok(PreparedEntityState::Live(Box::new(after.clone())))
            }
            (Some(before), None) => {
                let current = self
                    .entity(&effect.entity_id)
                    .ok_or(CanonicalDocumentError::InvalidJournalEntry)?;
                if current != before || before.id != effect.entity_id {
                    return Err(CanonicalDocumentError::InvalidJournalEntry);
                }
                Ok(PreparedEntityState::Deleted(tombstone_after(before)?))
            }
            (None, None) => Err(CanonicalDocumentError::InvalidJournalEntry),
        }
    }

    fn validate_command_identity(&self, command_id: &str) -> Result<(), CanonicalDocumentError> {
        if command_id.trim().is_empty() || command_id.contains('\0') {
            return Err(CanonicalDocumentError::InvalidCommandId);
        }
        if self.command_ids.contains(command_id) {
            return Err(CanonicalDocumentError::DuplicateCommandId);
        }
        Ok(())
    }

    fn next_generation(&self) -> Result<u64, CanonicalDocumentError> {
        self.generation
            .checked_add(1)
            .filter(|value| *value <= JAVASCRIPT_SAFE_INTEGER_MAX)
            .ok_or(CanonicalDocumentError::RevisionExhausted)
    }
}

fn validate_entity(entity: &CanonicalEntity) -> Result<(), CanonicalDocumentError> {
    validate_canonical_entity_semantics(entity).map_err(|_| CanonicalDocumentError::InvalidEntity {
        entity_id: entity.id.clone(),
    })
}

fn validate_live_reference(
    current: &CanonicalEntity,
    expected: &EntityVersionRef,
) -> Result<(), CanonicalDocumentError> {
    if current.id != expected.id
        || current.revision != expected.revision
        || current.version_hash != expected.version_hash
    {
        return Err(CanonicalDocumentError::VersionConflict {
            entity_id: expected.id.clone(),
        });
    }
    Ok(())
}

fn validate_tombstone_reference(
    current: &CanonicalEntityTombstone,
    expected: &EntityVersionRef,
) -> Result<(), CanonicalDocumentError> {
    if current.id != expected.id
        || current.revision != expected.revision
        || current.version_hash != expected.version_hash
    {
        return Err(CanonicalDocumentError::VersionConflict {
            entity_id: expected.id.clone(),
        });
    }
    Ok(())
}

fn advance_entity_revision(entity: &mut CanonicalEntity) -> Result<(), CanonicalDocumentError> {
    entity.revision = next_revision(entity.revision)?;
    entity.version_hash = canonical_entity_version_hash(entity).map_err(|_| {
        CanonicalDocumentError::InvalidEntity {
            entity_id: entity.id.clone(),
        }
    })?;
    Ok(())
}

fn next_revision(revision: u64) -> Result<u64, CanonicalDocumentError> {
    revision
        .checked_add(1)
        .filter(|value| *value <= JAVASCRIPT_SAFE_INTEGER_MAX)
        .ok_or(CanonicalDocumentError::RevisionExhausted)
}

fn tombstone_after(
    entity: &CanonicalEntity,
) -> Result<CanonicalEntityTombstone, CanonicalDocumentError> {
    let mut tombstone = CanonicalEntityTombstone {
        id: entity.id.clone(),
        revision: next_revision(entity.revision)?,
        deleted_entity_version_hash: entity.version_hash.clone(),
        version_hash: ObjectHash(String::new()),
    };
    tombstone.version_hash = tombstone_version_hash(&tombstone)?;
    Ok(tombstone)
}

fn tombstone_version_hash(
    tombstone: &CanonicalEntityTombstone,
) -> Result<ObjectHash, CanonicalDocumentError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TombstoneHashInput<'a> {
        id: &'a EntityId,
        revision: u64,
        deleted_entity_version_hash: &'a ObjectHash,
    }

    let bytes = serde_json::to_vec(&TombstoneHashInput {
        id: &tombstone.id,
        revision: tombstone.revision,
        deleted_entity_version_hash: &tombstone.deleted_entity_version_hash,
    })
    .map_err(|_| CanonicalDocumentError::InvalidJournalEntry)?;
    Ok(ObjectHash::of_bytes(&bytes))
}

fn all_entity_fields() -> Vec<CanonicalEntityField> {
    vec![
        CanonicalEntityField::TypeId,
        CanonicalEntityField::Name,
        CanonicalEntityField::Owner,
        CanonicalEntityField::LayerIds,
        CanonicalEntityField::Placement,
        CanonicalEntityField::Representations,
        CanonicalEntityField::ComponentsRef,
        CanonicalEntityField::AttributesRef,
        CanonicalEntityField::RelationsRef,
        CanonicalEntityField::StyleRef,
        CanonicalEntityField::SchemaVersion,
    ]
}

fn valid_touched_fields(effect: &CanonicalEntityEffect) -> bool {
    if effect.touched_fields.is_empty() {
        return false;
    }
    let fields: BTreeSet<_> = effect.touched_fields.iter().copied().collect();
    if fields.len() != effect.touched_fields.len() {
        return false;
    }
    if effect.before.is_none() || effect.after.is_none() {
        return effect.touched_fields == all_entity_fields();
    }
    let before = effect.before.as_ref().expect("checked above");
    let after = effect.after.as_ref().expect("checked above");
    all_entity_fields()
        .into_iter()
        .filter(|field| !field_matches(before, after, *field))
        .all(|field| fields.contains(&field))
}

fn validate_touched_fields(
    current: &CanonicalEntity,
    required: &CanonicalEntity,
    fields: &[CanonicalEntityField],
) -> Result<(), CanonicalDocumentError> {
    for field in fields {
        if !field_matches(current, required, *field) {
            return Err(CanonicalDocumentError::TouchedFieldConflict {
                entity_id: current.id.clone(),
                field: *field,
            });
        }
    }
    Ok(())
}

fn field_matches(
    left: &CanonicalEntity,
    right: &CanonicalEntity,
    field: CanonicalEntityField,
) -> bool {
    match field {
        CanonicalEntityField::TypeId => left.type_id == right.type_id,
        CanonicalEntityField::Name => left.name == right.name,
        CanonicalEntityField::Owner => left.owner == right.owner,
        CanonicalEntityField::LayerIds => left.layer_ids == right.layer_ids,
        CanonicalEntityField::Placement => left.placement == right.placement,
        CanonicalEntityField::Representations => left.representations == right.representations,
        CanonicalEntityField::ComponentsRef => left.components_ref == right.components_ref,
        CanonicalEntityField::AttributesRef => left.attributes_ref == right.attributes_ref,
        CanonicalEntityField::RelationsRef => left.relations_ref == right.relations_ref,
        CanonicalEntityField::StyleRef => left.style_ref == right.style_ref,
        CanonicalEntityField::SchemaVersion => left.schema_version == right.schema_version,
    }
}

fn edits_from_snapshot(
    snapshot: &CanonicalEntity,
    fields: &[CanonicalEntityField],
) -> Result<Vec<CanonicalEntityEdit>, CanonicalDocumentError> {
    let mut edits = Vec::with_capacity(fields.len());
    for field in fields {
        edits.push(match field {
            CanonicalEntityField::Name => CanonicalEntityEdit::SetName {
                name: snapshot.name.clone(),
            },
            CanonicalEntityField::Owner => CanonicalEntityEdit::SetOwner {
                owner: snapshot.owner.clone(),
            },
            CanonicalEntityField::LayerIds => CanonicalEntityEdit::SetLayerIds {
                layer_ids: snapshot.layer_ids.clone(),
            },
            CanonicalEntityField::Placement => CanonicalEntityEdit::SetPlacement {
                placement: snapshot.placement,
            },
            CanonicalEntityField::Representations => CanonicalEntityEdit::SetRepresentations {
                representations: snapshot.representations.clone(),
            },
            CanonicalEntityField::ComponentsRef => CanonicalEntityEdit::SetComponentsRef {
                components_ref: snapshot.components_ref.clone(),
            },
            CanonicalEntityField::AttributesRef => CanonicalEntityEdit::SetAttributesRef {
                attributes_ref: snapshot.attributes_ref.clone(),
            },
            CanonicalEntityField::RelationsRef => CanonicalEntityEdit::SetRelationsRef {
                relations_ref: snapshot.relations_ref.clone(),
            },
            CanonicalEntityField::StyleRef => CanonicalEntityEdit::SetStyleRef {
                style_ref: snapshot.style_ref.clone(),
            },
            CanonicalEntityField::TypeId | CanonicalEntityField::SchemaVersion => {
                return Err(CanonicalDocumentError::InvalidJournalEntry);
            }
        });
    }
    Ok(edits)
}

fn directed_graph_has_cycle(nodes: &BTreeSet<&str>, edges: &[(&str, &str)]) -> bool {
    let mut indegree: BTreeMap<&str, usize> = nodes.iter().map(|node| (*node, 0_usize)).collect();
    let mut outgoing: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (source, target) in edges {
        *indegree.entry(target).or_default() += 1;
        outgoing.entry(source).or_default().push(target);
    }
    let mut queue: VecDeque<&str> = indegree
        .iter()
        .filter_map(|(node, degree)| (*degree == 0).then_some(*node))
        .collect();
    let mut visited = 0_usize;
    while let Some(node) = queue.pop_front() {
        visited += 1;
        if let Some(targets) = outgoing.get(node) {
            for target in targets {
                let degree = indegree
                    .get_mut(target)
                    .expect("validated graph target must be a node");
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target);
                }
            }
        }
    }
    visited != indegree.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity_model::EntityTypeId;

    fn hash(byte: char) -> ObjectHash {
        ObjectHash(byte.to_string().repeat(64))
    }

    fn organizational_entity(id: &str, type_id: &str) -> CanonicalEntity {
        let mut entity = CanonicalEntity {
            id: EntityId(id.to_owned()),
            revision: 0,
            type_id: EntityTypeId(type_id.to_owned()),
            name: id.to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: hash('1'),
            attributes_ref: hash('2'),
            relations_ref: hash('3'),
            style_ref: None,
            schema_version: 1,
            version_hash: hash('0'),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("fixture hash");
        entity
    }

    fn create(command_id: &str, entities: Vec<CanonicalEntity>) -> CanonicalCommandTransaction {
        CanonicalCommandTransaction {
            command_id: command_id.to_owned(),
            mutations: entities
                .into_iter()
                .map(|entity| CanonicalEntityMutation::Create { entity })
                .collect(),
        }
    }

    fn update(
        command_id: &str,
        entity: &CanonicalEntity,
        edits: Vec<CanonicalEntityEdit>,
    ) -> CanonicalCommandTransaction {
        CanonicalCommandTransaction {
            command_id: command_id.to_owned(),
            mutations: vec![CanonicalEntityMutation::Update {
                expected: EntityVersionRef::from_entity(entity),
                edits,
            }],
        }
    }

    #[test]
    fn multi_entity_create_resolves_forward_owner_and_layer_references() {
        let mut root = organizational_entity("root", built_in_type::GROUP);
        let layer = organizational_entity("survey-layer", built_in_type::LAYER);
        let mut child = organizational_entity("child", built_in_type::GROUP);
        child.owner = Some(root.id.clone());
        child.layer_ids = vec![layer.id.clone()];
        child.version_hash = canonical_entity_version_hash(&child).expect("child hash");
        root.version_hash = canonical_entity_version_hash(&root).expect("root hash");

        let mut document = CanonicalDocument::default();
        let entry = document
            .execute(create("create-tree", vec![child.clone(), layer, root]))
            .expect("atomic forward-reference create");

        assert_eq!(entry.sequence, 1);
        assert_eq!(document.entity(&child.id), Some(&child));
        assert_eq!(document.entities().count(), 3);
    }

    #[test]
    fn stale_member_rejects_whole_batch_without_mutation() {
        let first = organizational_entity("first", built_in_type::GROUP);
        let second = organizational_entity("second", built_in_type::GROUP);
        let mut document = CanonicalDocument::default();
        document
            .execute(create("seed", vec![first.clone(), second.clone()]))
            .expect("seed");
        let current_first = document.entity(&first.id).expect("first").clone();
        let current_second = document.entity(&second.id).expect("second").clone();
        let mut stale = EntityVersionRef::from_entity(&current_second);
        stale.revision += 1;

        let result = document.prepare_transaction(CanonicalCommandTransaction {
            command_id: "invalid-batch".to_owned(),
            mutations: vec![
                CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&current_first),
                    edits: vec![CanonicalEntityEdit::SetName {
                        name: "changed".to_owned(),
                    }],
                },
                CanonicalEntityMutation::Update {
                    expected: stale,
                    edits: vec![CanonicalEntityEdit::SetName {
                        name: "also changed".to_owned(),
                    }],
                },
            ],
        });

        assert!(matches!(
            result,
            Err(CanonicalDocumentError::VersionConflict { .. })
        ));
        assert_eq!(document.generation(), 1);
        assert_eq!(document.journal().len(), 1);
        assert_eq!(document.entity(&first.id), Some(&current_first));
        assert_eq!(document.entity(&second.id), Some(&current_second));
    }

    #[test]
    fn prepared_transactions_are_generation_guarded() {
        let first = organizational_entity("first", built_in_type::GROUP);
        let second = organizational_entity("second", built_in_type::GROUP);
        let mut document = CanonicalDocument::default();
        let stale = document
            .prepare_transaction(create("prepared-first", vec![first]))
            .expect("prepare first");
        document
            .execute(create("committed-second", vec![second]))
            .expect("commit second");

        assert_eq!(
            document.commit(stale),
            Err(CanonicalDocumentError::PreparedTransactionStale)
        );
        assert_eq!(document.entities().count(), 1);
        assert_eq!(document.journal().len(), 1);
    }

    #[test]
    fn delete_tombstone_and_restore_keep_identity_and_advance_revision() {
        let entity = organizational_entity("stable", built_in_type::GROUP);
        let mut document = CanonicalDocument::default();
        document
            .execute(create("create", vec![entity.clone()]))
            .expect("create");
        let current = document.entity(&entity.id).expect("live").clone();
        document
            .execute(CanonicalCommandTransaction {
                command_id: "delete".to_owned(),
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef::from_entity(&current),
                }],
            })
            .expect("delete");
        let tombstone = document.tombstone(&entity.id).expect("tombstone").clone();
        assert_eq!(tombstone.revision, 1);
        assert!(matches!(
            document.prepare_transaction(create("reuse", vec![entity.clone()])),
            Err(CanonicalDocumentError::EntityAlreadyExists { .. })
        ));

        document
            .execute(CanonicalCommandTransaction {
                command_id: "restore".to_owned(),
                mutations: vec![CanonicalEntityMutation::Restore {
                    expected: EntityVersionRef::from_tombstone(&tombstone),
                    snapshot: entity.clone(),
                }],
            })
            .expect("restore");
        let restored = document.entity(&entity.id).expect("restored");
        assert_eq!(restored.revision, 2);
        assert_eq!(restored.name, entity.name);
        assert_ne!(restored.version_hash, entity.version_hash);
        assert!(document.tombstone(&entity.id).is_none());
    }

    #[test]
    fn owner_and_layer_cycles_are_rejected_before_commit() {
        let mut owner_a = organizational_entity("owner-a", built_in_type::GROUP);
        let mut owner_b = organizational_entity("owner-b", built_in_type::GROUP);
        owner_a.owner = Some(owner_b.id.clone());
        owner_b.owner = Some(owner_a.id.clone());
        owner_a.version_hash = canonical_entity_version_hash(&owner_a).expect("owner a hash");
        owner_b.version_hash = canonical_entity_version_hash(&owner_b).expect("owner b hash");
        let document = CanonicalDocument::default();
        assert!(matches!(
            document.prepare_transaction(create("owner-cycle", vec![owner_a, owner_b])),
            Err(CanonicalDocumentError::OwnerCycle)
        ));

        let mut layer_a = organizational_entity("layer-a", built_in_type::LAYER);
        let mut layer_b = organizational_entity("layer-b", built_in_type::LAYER);
        layer_a.layer_ids = vec![layer_b.id.clone()];
        layer_b.layer_ids = vec![layer_a.id.clone()];
        layer_a.version_hash = canonical_entity_version_hash(&layer_a).expect("layer a hash");
        layer_b.version_hash = canonical_entity_version_hash(&layer_b).expect("layer b hash");
        assert!(matches!(
            document.prepare_transaction(create("layer-cycle", vec![layer_a, layer_b])),
            Err(CanonicalDocumentError::LayerCycle)
        ));
        assert_eq!(document.generation(), 0);
    }

    #[test]
    fn undo_and_redo_rebase_over_unrelated_fields_but_conflict_on_touched_fields() {
        let entity = organizational_entity("editable", built_in_type::GROUP);
        let mut document = CanonicalDocument::default();
        document
            .execute(create("create", vec![entity.clone()]))
            .expect("create");
        let current = document.entity(&entity.id).expect("entity").clone();
        document
            .execute(update(
                "rename",
                &current,
                vec![CanonicalEntityEdit::SetName {
                    name: "Renamed".to_owned(),
                }],
            ))
            .expect("rename");
        let renamed = document.entity(&entity.id).expect("renamed").clone();
        document
            .execute(update(
                "attributes",
                &renamed,
                vec![CanonicalEntityEdit::SetAttributesRef {
                    attributes_ref: hash('a'),
                }],
            ))
            .expect("attributes");

        let undo = document
            .prepare_undo("undo-rename".to_owned(), "rename")
            .expect("field-aware undo");
        document.commit(undo).expect("commit undo");
        let undone = document.entity(&entity.id).expect("undone").clone();
        assert_eq!(undone.name, "editable");
        assert_eq!(undone.attributes_ref, hash('a'));

        let redo = document
            .prepare_redo("redo-rename".to_owned(), "rename")
            .expect("field-aware redo");
        document.commit(redo).expect("commit redo");
        let redone = document.entity(&entity.id).expect("redone").clone();
        assert_eq!(redone.name, "Renamed");
        assert_eq!(redone.attributes_ref, hash('a'));

        document
            .execute(update(
                "rename-again",
                &redone,
                vec![CanonicalEntityEdit::SetName {
                    name: "Third name".to_owned(),
                }],
            ))
            .expect("second rename");
        let error = document
            .prepare_undo("conflicting-undo".to_owned(), "rename")
            .expect_err("touched name must conflict");
        assert_eq!(
            error,
            CanonicalDocumentError::TouchedFieldConflict {
                entity_id: entity.id,
                field: CanonicalEntityField::Name,
            }
        );
    }

    #[test]
    fn serialized_journal_replays_complete_forward_state() {
        let entity = organizational_entity("replay", built_in_type::GROUP);
        let mut document = CanonicalDocument::default();
        document
            .execute(create("create", vec![entity.clone()]))
            .expect("create");
        let current = document.entity(&entity.id).expect("entity").clone();
        document
            .execute(update(
                "rename",
                &current,
                vec![CanonicalEntityEdit::SetName {
                    name: "Replayed".to_owned(),
                }],
            ))
            .expect("rename");
        let undo = document
            .prepare_undo("undo".to_owned(), "rename")
            .expect("undo");
        document.commit(undo).expect("commit undo");

        let json = serde_json::to_string(document.journal()).expect("serialize journal");
        let entries: Vec<CanonicalJournalEntry> =
            serde_json::from_str(&json).expect("deserialize journal");
        let replayed = CanonicalDocument::from_journal(&entries).expect("replay journal");

        assert_eq!(replayed.generation(), document.generation());
        assert_eq!(replayed.journal(), document.journal());
        assert_eq!(replayed.entity(&entity.id), document.entity(&entity.id));
    }

    #[test]
    fn javascript_safe_revision_limit_rejects_mutation() {
        let mut entity = organizational_entity("exhausted", built_in_type::GROUP);
        entity.revision = JAVASCRIPT_SAFE_INTEGER_MAX;
        entity.version_hash = canonical_entity_version_hash(&entity).expect("max revision hash");
        let mut document = CanonicalDocument::default();
        document
            .execute(create("create-max", vec![entity.clone()]))
            .expect_err("create must require revision zero");
        assert_eq!(
            next_revision(JAVASCRIPT_SAFE_INTEGER_MAX),
            Err(CanonicalDocumentError::RevisionExhausted)
        );
    }
}
