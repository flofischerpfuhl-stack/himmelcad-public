//! Replayable commands for canonical entity mutations.

use std::collections::BTreeSet;

use glam::DMat4;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::entity::EntityId;
use crate::entity_model::{CanonicalEntity, Transform3d};
use crate::entity_validation::{
    canonical_entity_version_hash, validate_canonical_entity_semantics,
};
use crate::hash::ObjectHash;

const JAVASCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// Optimistic, replayable command that assigns an exact entity placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformEntityCommand {
    /// Stable command identity supplied by the authoritative command host.
    pub command_id: String,
    /// Stable entity identity.
    pub entity_id: EntityId,
    /// Exact canonical revision observed when the command was created.
    pub expected_revision: u64,
    /// Exact canonical version observed when the command was created.
    pub expected_version_hash: ObjectHash,
    /// Exact target placement. `None` remains distinct from an explicit identity placement.
    pub target_placement: Option<Transform3d>,
}

/// Exact before/after state produced by one accepted placement command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedEntityPlacementCommand {
    /// Stable command identity.
    pub command_id: String,
    /// Stable entity identity.
    pub entity_id: EntityId,
    /// Canonical entity before the mutation.
    pub before: CanonicalEntity,
    /// Canonical entity after the mutation.
    pub after: CanonicalEntity,
}

/// Stable operation kind stored in the append-only canonical command journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityCommandJournalKind {
    /// Ordinary absolute placement assignment.
    TransformEntity,
    /// Compensating forward command restoring a prior placement.
    UndoTransformEntity,
    /// Compensating forward command restoring an undone placement.
    RedoTransformEntity,
}

/// Immutable replay/audit record for one accepted canonical placement revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityCommandJournalEntry {
    /// Monotone journal sequence.
    pub sequence: u64,
    /// Stable command identity.
    pub command_id: String,
    /// Replay operation kind.
    pub kind: EntityCommandJournalKind,
    /// Stable canonical entity identity.
    pub entity_id: EntityId,
    /// Exact source revision.
    pub before_revision: u64,
    /// Exact source version hash.
    pub before_version_hash: ObjectHash,
    /// Exact optional source placement.
    pub before_placement: Option<Transform3d>,
    /// Exact resulting revision.
    pub after_revision: u64,
    /// Exact resulting version hash.
    pub after_version_hash: ObjectHash,
    /// Exact optional resulting placement.
    pub after_placement: Option<Transform3d>,
    /// Root command compensated or reapplied by undo/redo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_command_id: Option<String>,
}

/// In-memory authority for append-only journal sequencing and duplicate command rejection.
#[derive(Debug, Clone, Default)]
pub struct EntityCommandJournal {
    entries: Vec<EntityCommandJournalEntry>,
    command_ids: BTreeSet<String>,
    sequence: u64,
}

/// Reason a canonical entity command was rejected before publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum EntityCommandError {
    /// A stable command identity is required for journal/replay semantics.
    #[error("command id is invalid")]
    InvalidCommandId,
    /// The command targets another stable entity.
    #[error("command entity does not match the current canonical entity")]
    EntityMismatch,
    /// The optimistic revision or content hash is stale.
    #[error("command expected canonical revision is stale")]
    RevisionConflict,
    /// The supplied or resulting affine placement is invalid or non-invertible.
    #[error("command transform is not a finite invertible affine transform")]
    InvalidTransform,
    /// The next monotone revision cannot be represented safely on the JSON/JavaScript wire.
    #[error("canonical entity revision is exhausted")]
    RevisionExhausted,
    /// The resulting canonical entity failed semantic validation.
    #[error("resulting canonical entity is invalid")]
    InvalidEntity,
    /// A stable command identity was already accepted by this journal.
    #[error("command id is already journaled")]
    DuplicateCommandId,
    /// Journal sequence is exhausted or an entry was appended out of order.
    #[error("canonical command journal sequence is invalid")]
    InvalidJournalSequence,
}

impl EntityCommandJournal {
    /// Whether a command identity was already accepted.
    #[must_use]
    pub fn contains(&self, command_id: &str) -> bool {
        self.command_ids.contains(command_id)
    }

    /// Builds the next immutable record without mutating journal state.
    pub fn prepare(
        &self,
        applied: &AppliedEntityPlacementCommand,
        kind: EntityCommandJournalKind,
        related_command_id: Option<String>,
    ) -> Result<EntityCommandJournalEntry, EntityCommandError> {
        if applied.command_id.trim().is_empty() || applied.command_id.contains('\0') {
            return Err(EntityCommandError::InvalidCommandId);
        }
        if self.contains(&applied.command_id) {
            return Err(EntityCommandError::DuplicateCommandId);
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .filter(|value| *value <= JAVASCRIPT_SAFE_INTEGER_MAX)
            .ok_or(EntityCommandError::InvalidJournalSequence)?;
        Ok(EntityCommandJournalEntry {
            sequence,
            command_id: applied.command_id.clone(),
            kind,
            entity_id: applied.entity_id.clone(),
            before_revision: applied.before.revision,
            before_version_hash: applied.before.version_hash.clone(),
            before_placement: applied.before.placement,
            after_revision: applied.after.revision,
            after_version_hash: applied.after.version_hash.clone(),
            after_placement: applied.after.placement,
            related_command_id,
        })
    }

    /// Appends one previously prepared record in exact sequence order.
    pub fn append(&mut self, entry: EntityCommandJournalEntry) -> Result<(), EntityCommandError> {
        if self.contains(&entry.command_id) {
            return Err(EntityCommandError::DuplicateCommandId);
        }
        let expected = self
            .sequence
            .checked_add(1)
            .ok_or(EntityCommandError::InvalidJournalSequence)?;
        if entry.sequence != expected || entry.sequence > JAVASCRIPT_SAFE_INTEGER_MAX {
            return Err(EntityCommandError::InvalidJournalSequence);
        }
        self.sequence = entry.sequence;
        self.command_ids.insert(entry.command_id.clone());
        self.entries.push(entry);
        Ok(())
    }

    /// Complete immutable record sequence in acceptance order.
    #[must_use]
    pub fn entries(&self) -> &[EntityCommandJournalEntry] {
        &self.entries
    }

    /// Next sequence that would be assigned by [`Self::prepare`].
    #[must_use]
    pub fn next_sequence(&self) -> Option<u64> {
        self.sequence
            .checked_add(1)
            .filter(|value| *value <= JAVASCRIPT_SAFE_INTEGER_MAX)
    }
}

/// Assigns an exact placement without mutating the supplied immutable entity revision.
pub fn apply_transform_entity(
    current: &CanonicalEntity,
    command: &TransformEntityCommand,
) -> Result<AppliedEntityPlacementCommand, EntityCommandError> {
    validate_command_target(
        current,
        &command.command_id,
        &command.entity_id,
        command.expected_revision,
        &command.expected_version_hash,
    )?;
    if command
        .target_placement
        .is_some_and(|placement| !valid_invertible_affine(placement))
    {
        return Err(EntityCommandError::InvalidTransform);
    }
    apply_exact_optional_placement(current, &command.command_id, command.target_placement)
}

/// Restores an exact prior placement as a new monotone revision for undo/redo.
///
/// This never rewinds a revision. The returned entity is therefore safe to publish through the
/// same compare-and-swap path as an ordinary edit.
pub fn restore_entity_placement(
    current: &CanonicalEntity,
    command_id: &str,
    expected_revision: u64,
    expected_version_hash: &ObjectHash,
    placement: Option<Transform3d>,
) -> Result<AppliedEntityPlacementCommand, EntityCommandError> {
    validate_command_target(
        current,
        command_id,
        &current.id,
        expected_revision,
        expected_version_hash,
    )?;
    if placement.is_some_and(|value| !valid_invertible_affine(value)) {
        return Err(EntityCommandError::InvalidTransform);
    }
    apply_exact_optional_placement(current, command_id, placement)
}

fn apply_exact_optional_placement(
    current: &CanonicalEntity,
    command_id: &str,
    placement: Option<Transform3d>,
) -> Result<AppliedEntityPlacementCommand, EntityCommandError> {
    let revision = current
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= JAVASCRIPT_SAFE_INTEGER_MAX)
        .ok_or(EntityCommandError::RevisionExhausted)?;
    let mut after = current.clone();
    after.revision = revision;
    after.placement = placement;
    after.version_hash =
        canonical_entity_version_hash(&after).map_err(|_| EntityCommandError::InvalidEntity)?;
    validate_canonical_entity_semantics(&after).map_err(|_| EntityCommandError::InvalidEntity)?;
    Ok(AppliedEntityPlacementCommand {
        command_id: command_id.to_owned(),
        entity_id: current.id.clone(),
        before: current.clone(),
        after,
    })
}

fn validate_command_target(
    current: &CanonicalEntity,
    command_id: &str,
    entity_id: &EntityId,
    expected_revision: u64,
    expected_version_hash: &ObjectHash,
) -> Result<(), EntityCommandError> {
    if command_id.trim().is_empty() || command_id.contains('\0') {
        return Err(EntityCommandError::InvalidCommandId);
    }
    if &current.id != entity_id {
        return Err(EntityCommandError::EntityMismatch);
    }
    if current.revision != expected_revision || &current.version_hash != expected_version_hash {
        return Err(EntityCommandError::RevisionConflict);
    }
    Ok(())
}

fn valid_invertible_affine(transform: Transform3d) -> bool {
    let matrix = DMat4::from_cols_array(&transform.0);
    transform.0.iter().all(|value| value.is_finite())
        && transform.0[3].abs() <= f64::EPSILON
        && transform.0[7].abs() <= f64::EPSILON
        && transform.0[11].abs() <= f64::EPSILON
        && (transform.0[15] - 1.0).abs() <= f64::EPSILON
        && matrix.determinant().is_finite()
        && matrix.determinant().abs() > f64::EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity_model::{built_in_type, EntityTypeId};
    use crate::entity_validation::canonical_entity_version_hash;

    fn entity() -> CanonicalEntity {
        let mut entity = CanonicalEntity {
            id: EntityId("survey-point".to_owned()),
            revision: 7,
            type_id: EntityTypeId(built_in_type::GROUP.to_owned()),
            name: "Survey point".to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: ObjectHash("1".repeat(64)),
            attributes_ref: ObjectHash("2".repeat(64)),
            relations_ref: ObjectHash("3".repeat(64)),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash("0".repeat(64)),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("fixture hash");
        entity
    }

    fn translation(x: f64, y: f64, z: f64) -> Transform3d {
        let mut transform = Transform3d::IDENTITY;
        transform.0[12] = x;
        transform.0[13] = y;
        transform.0[14] = z;
        transform
    }

    #[test]
    fn transform_is_project_space_monotone_and_replay_guarded() {
        let current = entity();
        let applied = apply_transform_entity(
            &current,
            &TransformEntityCommand {
                command_id: "move-1".to_owned(),
                entity_id: current.id.clone(),
                expected_revision: current.revision,
                expected_version_hash: current.version_hash.clone(),
                target_placement: Some(translation(10.0, -2.0, 0.5)),
            },
        )
        .expect("transform");
        assert_eq!(applied.after.revision, 8);
        assert_eq!(applied.after.placement, Some(translation(10.0, -2.0, 0.5)));
        assert_ne!(applied.after.version_hash, current.version_hash);
        assert_eq!(
            apply_transform_entity(
                &applied.after,
                &TransformEntityCommand {
                    command_id: "move-1".to_owned(),
                    entity_id: current.id.clone(),
                    expected_revision: current.revision,
                    expected_version_hash: current.version_hash.clone(),
                    target_placement: Some(translation(10.0, -2.0, 0.5)),
                },
            ),
            Err(EntityCommandError::RevisionConflict)
        );
    }

    #[test]
    fn undo_restores_exact_optional_placement_as_a_new_revision() {
        let current = entity();
        let moved = apply_transform_entity(
            &current,
            &TransformEntityCommand {
                command_id: "move-1".to_owned(),
                entity_id: current.id.clone(),
                expected_revision: current.revision,
                expected_version_hash: current.version_hash.clone(),
                target_placement: Some(translation(3.0, 4.0, 5.0)),
            },
        )
        .expect("move");
        let undone = restore_entity_placement(
            &moved.after,
            "undo-1",
            moved.after.revision,
            &moved.after.version_hash,
            moved.before.placement,
        )
        .expect("undo");
        assert_eq!(undone.after.revision, 9);
        assert_eq!(undone.after.placement, None);
        assert_ne!(undone.after.version_hash, current.version_hash);
    }

    #[test]
    fn singular_transform_is_rejected_without_a_revision() {
        let current = entity();
        let mut singular = Transform3d::IDENTITY;
        singular.0[0] = 0.0;
        assert_eq!(
            apply_transform_entity(
                &current,
                &TransformEntityCommand {
                    command_id: "move-singular".to_owned(),
                    entity_id: current.id.clone(),
                    expected_revision: current.revision,
                    expected_version_hash: current.version_hash.clone(),
                    target_placement: Some(singular),
                },
            ),
            Err(EntityCommandError::InvalidTransform)
        );
    }

    #[test]
    fn explicit_absent_target_does_not_canonicalize_to_identity() {
        let current = entity();
        let applied = apply_transform_entity(
            &current,
            &TransformEntityCommand {
                command_id: "preserve-none".to_owned(),
                entity_id: current.id.clone(),
                expected_revision: current.revision,
                expected_version_hash: current.version_hash.clone(),
                target_placement: None,
            },
        )
        .expect("absolute absent placement");
        assert_eq!(applied.before.placement, None);
        assert_eq!(applied.after.placement, None);
        assert_eq!(applied.after.revision, current.revision + 1);
    }

    #[test]
    fn journal_is_append_only_and_rejects_duplicate_command_ids() {
        let current = entity();
        let applied = apply_transform_entity(
            &current,
            &TransformEntityCommand {
                command_id: "journaled-move".to_owned(),
                entity_id: current.id.clone(),
                expected_revision: current.revision,
                expected_version_hash: current.version_hash.clone(),
                target_placement: Some(translation(1.0, 2.0, 3.0)),
            },
        )
        .expect("move");
        let mut journal = EntityCommandJournal::default();
        let entry = journal
            .prepare(&applied, EntityCommandJournalKind::TransformEntity, None)
            .expect("prepare journal");
        journal.append(entry.clone()).expect("append journal");
        assert_eq!(journal.entries(), &[entry]);
        assert_eq!(journal.next_sequence(), Some(2));
        assert_eq!(
            journal.prepare(&applied, EntityCommandJournalKind::TransformEntity, None),
            Err(EntityCommandError::DuplicateCommandId)
        );
        assert_eq!(
            journal.append(journal.entries()[0].clone()),
            Err(EntityCommandError::DuplicateCommandId)
        );
    }
}
