//! Schema-aware property projection and atomic multi-entity edit compilation.
//!
//! This module deliberately edits only canonical envelope fields. Component and
//! attribute payloads remain immutable, content-addressed resources; an envelope
//! edit therefore preserves every understood and opaque namespaced payload.

use std::collections::BTreeSet;

use thiserror::Error;

pub use himmelcad_model::property_schema::*;

use crate::canonical_document::{
    CanonicalCommandTransaction, CanonicalDocument, CanonicalDocumentError, CanonicalEntityEdit,
    CanonicalEntityMutation, EntityVersionRef,
};
use crate::entity::EntityId;
#[cfg(test)]
use crate::entity_model::EntityTypeId;
#[cfg(test)]
use crate::hash::ObjectHash;

/// Failure to query or compile canonical properties.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PropertySchemaError {
    /// A request declares a schema revision this core does not implement.
    #[error("property request schema is unsupported")]
    UnsupportedRequestSchema,
    /// At least one exact entity revision is required.
    #[error("property selection is empty")]
    EmptySelection,
    /// The same stable identity occurs more than once in a selection.
    #[error("property selection repeats entity {entity_id:?}")]
    DuplicateEntity { entity_id: EntityId },
    /// An edit must assign at least one property.
    #[error("property edit has no assignments")]
    EmptyEdit,
    /// An edit assigns the same property more than once.
    #[error("property edit repeats one assignment")]
    DuplicateAssignment,
    /// A query requests the same property more than once.
    #[error("property query repeats one property")]
    DuplicateQueryProperty,
    /// No schema owns the requested edit property.
    #[error("property is unknown to this core revision")]
    UnknownProperty,
    /// The schema marks the requested property read-only.
    #[error("property is read-only")]
    ReadOnlyProperty,
    /// The value variant does not match the schema definition.
    #[error("property value does not match its schema")]
    ValueTypeMismatch,
    /// Canonical CAS or semantic validation rejected the compiled transaction.
    #[error(transparent)]
    Canonical(#[from] CanonicalDocumentError),
}

/// Projects shared, mixed and unavailable property states for an exact selection.
pub fn query_properties(
    document: &CanonicalDocument,
    request: &PropertyQueryRequest,
) -> Result<PropertyQueryResult, PropertySchemaError> {
    if request.schema_id != PROPERTY_QUERY_REQUEST_SCHEMA_ID {
        return Err(PropertySchemaError::UnsupportedRequestSchema);
    }
    let entities = resolve_exact_selection(document, &request.entities)?;
    let schema = canonical_entity_property_schema();
    let requested = if request.properties.is_empty() {
        schema
            .properties
            .iter()
            .map(|definition| definition.id.clone())
            .collect()
    } else {
        ensure_unique_properties(&request.properties)?;
        request.properties.clone()
    };

    let properties = requested
        .into_iter()
        .map(|property_id| {
            let Some(definition) = find_definition(&schema, &property_id).cloned() else {
                return PropertyQueryRow {
                    property_id,
                    definition: None,
                    aggregate: PropertyAggregateState::Unavailable {
                        reason: PropertyUnavailableReason::UnknownProperty,
                    },
                };
            };
            let first = entity_value(entities[0], &property_id)
                .expect("registered canonical property must be projectable");
            let mixed = entities.iter().skip(1).any(|entity| {
                entity_value(entity, &property_id).is_none_or(|candidate| candidate != first)
            });
            PropertyQueryRow {
                property_id,
                definition: Some(definition),
                aggregate: if mixed {
                    PropertyAggregateState::Mixed
                } else {
                    PropertyAggregateState::Shared { value: first }
                },
            }
        })
        .collect();

    Ok(PropertyQueryResult {
        schema_id: PROPERTY_QUERY_RESULT_SCHEMA_ID.to_owned(),
        entities: request.entities.clone(),
        properties,
    })
}

/// Compiles one schema-checked edit into a single atomic canonical transaction.
///
/// The exact request revisions are copied into every mutation. A preflight against
/// `document` catches stale CAS references and cross-entity hierarchy violations;
/// committing later remains CAS-protected by [`CanonicalDocument`].
pub fn compile_multi_entity_property_edit(
    document: &CanonicalDocument,
    request: &MultiEntityPropertyEditRequest,
) -> Result<CanonicalCommandTransaction, PropertySchemaError> {
    if request.schema_id != PROPERTY_EDIT_REQUEST_SCHEMA_ID {
        return Err(PropertySchemaError::UnsupportedRequestSchema);
    }
    resolve_exact_selection(document, &request.entities)?;
    if request.assignments.is_empty() {
        return Err(PropertySchemaError::EmptyEdit);
    }

    let schema = canonical_entity_property_schema();
    let mut assignment_ids = BTreeSet::new();
    let mut edits = Vec::with_capacity(request.assignments.len());
    for assignment in &request.assignments {
        if !assignment_ids.insert(assignment.property_id.clone()) {
            return Err(PropertySchemaError::DuplicateAssignment);
        }
        let definition = find_definition(&schema, &assignment.property_id)
            .ok_or(PropertySchemaError::UnknownProperty)?;
        if definition.editability != PropertyEditability::Writable {
            return Err(PropertySchemaError::ReadOnlyProperty);
        }
        edits.push(compile_assignment(assignment)?);
    }

    let transaction = CanonicalCommandTransaction {
        command_id: request.command_id.clone(),
        mutations: request
            .entities
            .iter()
            .cloned()
            .map(|expected| CanonicalEntityMutation::Update {
                expected,
                edits: edits.clone(),
            })
            .collect(),
    };
    document.prepare_transaction(transaction.clone())?;
    Ok(transaction)
}

fn find_definition<'a>(
    schema: &'a PropertyNamespaceSchema,
    property_id: &PropertyId,
) -> Option<&'a PropertyDefinition> {
    schema
        .properties
        .iter()
        .find(|definition| definition.id == *property_id)
}

fn ensure_unique_properties(properties: &[PropertyId]) -> Result<(), PropertySchemaError> {
    let mut unique = BTreeSet::new();
    if properties
        .iter()
        .all(|property| unique.insert(property.clone()))
    {
        Ok(())
    } else {
        Err(PropertySchemaError::DuplicateQueryProperty)
    }
}

fn resolve_exact_selection<'a>(
    document: &'a CanonicalDocument,
    expected: &[EntityVersionRef],
) -> Result<Vec<&'a crate::entity_model::CanonicalEntity>, PropertySchemaError> {
    if expected.is_empty() {
        return Err(PropertySchemaError::EmptySelection);
    }
    let mut ids = BTreeSet::new();
    let mut entities = Vec::with_capacity(expected.len());
    for reference in expected {
        if !ids.insert(reference.id.0.as_str()) {
            return Err(PropertySchemaError::DuplicateEntity {
                entity_id: reference.id.clone(),
            });
        }
        let entity = document.entity(&reference.id).ok_or_else(|| {
            CanonicalDocumentError::EntityNotFound {
                entity_id: reference.id.clone(),
            }
        })?;
        if entity.revision != reference.revision || entity.version_hash != reference.version_hash {
            return Err(CanonicalDocumentError::VersionConflict {
                entity_id: reference.id.clone(),
            }
            .into());
        }
        entities.push(entity);
    }
    Ok(entities)
}

fn entity_value(
    entity: &crate::entity_model::CanonicalEntity,
    property_id: &PropertyId,
) -> Option<PropertyValue> {
    if property_id.namespace != CANONICAL_ENTITY_PROPERTY_NAMESPACE {
        return None;
    }
    Some(match property_id.name.as_str() {
        ENTITY_PROPERTY_TYPE_ID => PropertyValue::EntityType {
            value: entity.type_id.clone(),
        },
        ENTITY_PROPERTY_NAME => PropertyValue::Text {
            value: entity.name.clone(),
        },
        ENTITY_PROPERTY_OWNER => PropertyValue::OptionalEntityReference {
            value: entity.owner.clone(),
        },
        ENTITY_PROPERTY_LAYER_IDS => PropertyValue::EntityReferences {
            values: entity.layer_ids.clone(),
        },
        ENTITY_PROPERTY_PLACEMENT => PropertyValue::OptionalTransform3d {
            value: entity.placement,
        },
        ENTITY_PROPERTY_COMPONENTS_REF => PropertyValue::ContentHash {
            value: entity.components_ref.clone(),
        },
        ENTITY_PROPERTY_ATTRIBUTES_REF => PropertyValue::ContentHash {
            value: entity.attributes_ref.clone(),
        },
        ENTITY_PROPERTY_RELATIONS_REF => PropertyValue::ContentHash {
            value: entity.relations_ref.clone(),
        },
        ENTITY_PROPERTY_STYLE_REF => PropertyValue::OptionalContentHash {
            value: entity.style_ref.clone(),
        },
        _ => return None,
    })
}

fn compile_assignment(
    assignment: &PropertyAssignment,
) -> Result<CanonicalEntityEdit, PropertySchemaError> {
    if assignment.property_id.namespace != CANONICAL_ENTITY_PROPERTY_NAMESPACE {
        return Err(PropertySchemaError::UnknownProperty);
    }
    match (assignment.property_id.name.as_str(), &assignment.value) {
        (ENTITY_PROPERTY_NAME, PropertyValue::Text { value }) => Ok(CanonicalEntityEdit::SetName {
            name: value.clone(),
        }),
        (ENTITY_PROPERTY_OWNER, PropertyValue::OptionalEntityReference { value }) => {
            Ok(CanonicalEntityEdit::SetOwner {
                owner: value.clone(),
            })
        }
        (ENTITY_PROPERTY_LAYER_IDS, PropertyValue::EntityReferences { values }) => {
            Ok(CanonicalEntityEdit::SetLayerIds {
                layer_ids: values.clone(),
            })
        }
        (ENTITY_PROPERTY_PLACEMENT, PropertyValue::OptionalTransform3d { value }) => {
            Ok(CanonicalEntityEdit::SetPlacement { placement: *value })
        }
        (ENTITY_PROPERTY_STYLE_REF, PropertyValue::OptionalContentHash { value }) => {
            Ok(CanonicalEntityEdit::SetStyleRef {
                style_ref: value.clone(),
            })
        }
        (
            ENTITY_PROPERTY_TYPE_ID
            | ENTITY_PROPERTY_COMPONENTS_REF
            | ENTITY_PROPERTY_ATTRIBUTES_REF
            | ENTITY_PROPERTY_RELATIONS_REF,
            _,
        ) => Err(PropertySchemaError::ReadOnlyProperty),
        (
            ENTITY_PROPERTY_NAME
            | ENTITY_PROPERTY_OWNER
            | ENTITY_PROPERTY_LAYER_IDS
            | ENTITY_PROPERTY_PLACEMENT
            | ENTITY_PROPERTY_STYLE_REF,
            _,
        ) => Err(PropertySchemaError::ValueTypeMismatch),
        _ => Err(PropertySchemaError::UnknownProperty),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_document::CanonicalEntityMutation;
    use crate::entity_model::{built_in_type, CanonicalEntity};
    use crate::entity_validation::canonical_entity_version_hash;

    fn hash(byte: char) -> ObjectHash {
        ObjectHash(byte.to_string().repeat(64))
    }

    fn entity(id: &str, name: &str, opaque_hash_byte: char) -> CanonicalEntity {
        let mut entity = CanonicalEntity {
            id: EntityId(id.to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::GROUP.to_owned()),
            name: name.to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: hash(opaque_hash_byte),
            attributes_ref: hash(char::from_u32(opaque_hash_byte as u32 + 1).expect("test char")),
            relations_ref: hash(char::from_u32(opaque_hash_byte as u32 + 2).expect("test char")),
            style_ref: None,
            schema_version: 1,
            version_hash: hash('0'),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("fixture hash");
        entity
    }

    fn seeded_document() -> CanonicalDocument {
        let mut document = CanonicalDocument::default();
        document
            .execute(CanonicalCommandTransaction {
                command_id: "seed-properties".to_owned(),
                mutations: vec![
                    CanonicalEntityMutation::Create {
                        entity: entity("first", "Shared", '1'),
                    },
                    CanonicalEntityMutation::Create {
                        entity: entity("second", "Shared", '4'),
                    },
                ],
            })
            .expect("seed document");
        document
    }

    fn selection(document: &CanonicalDocument) -> Vec<EntityVersionRef> {
        ["first", "second"]
            .into_iter()
            .map(|id| {
                EntityVersionRef::from_entity(
                    document
                        .entity(&EntityId(id.to_owned()))
                        .expect("selected entity"),
                )
            })
            .collect()
    }

    #[test]
    fn query_reports_shared_mixed_and_unknown_namespace_rows() {
        let mut document = seeded_document();
        let second = document
            .entity(&EntityId("second".to_owned()))
            .expect("second")
            .clone();
        document
            .execute(CanonicalCommandTransaction {
                command_id: "different-owner".to_owned(),
                mutations: vec![CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&second),
                    edits: vec![CanonicalEntityEdit::SetOwner {
                        owner: Some(EntityId("first".to_owned())),
                    }],
                }],
            })
            .expect("set owner");

        let result = query_properties(
            &document,
            &PropertyQueryRequest {
                schema_id: PROPERTY_QUERY_REQUEST_SCHEMA_ID.to_owned(),
                entities: selection(&document),
                properties: vec![
                    PropertyId::canonical_entity(ENTITY_PROPERTY_NAME),
                    PropertyId::canonical_entity(ENTITY_PROPERTY_OWNER),
                    PropertyId {
                        namespace: "vendor.survey@7".to_owned(),
                        name: "quality".to_owned(),
                    },
                ],
            },
        )
        .expect("property query");

        assert!(matches!(
            result.properties[0].aggregate,
            PropertyAggregateState::Shared {
                value: PropertyValue::Text { ref value }
            } if value == "Shared"
        ));
        assert_eq!(
            result.properties[1].aggregate,
            PropertyAggregateState::Mixed
        );
        assert!(matches!(
            result.properties[2].aggregate,
            PropertyAggregateState::Unavailable {
                reason: PropertyUnavailableReason::UnknownProperty
            }
        ));
        assert_eq!(
            result.properties[2].property_id.namespace,
            "vendor.survey@7"
        );
    }

    #[test]
    fn multi_edit_is_one_transaction_and_preserves_opaque_resource_namespaces() {
        let mut document = seeded_document();
        let selected = selection(&document);
        let before: Vec<_> = selected
            .iter()
            .map(|reference| document.entity(&reference.id).expect("entity").clone())
            .collect();
        let transaction = compile_multi_entity_property_edit(
            &document,
            &MultiEntityPropertyEditRequest {
                schema_id: PROPERTY_EDIT_REQUEST_SCHEMA_ID.to_owned(),
                command_id: "rename-selection".to_owned(),
                entities: selected.clone(),
                assignments: vec![PropertyAssignment {
                    property_id: PropertyId::canonical_entity(ENTITY_PROPERTY_NAME),
                    value: PropertyValue::Text {
                        value: "Matched".to_owned(),
                    },
                }],
            },
        )
        .expect("compile edit");

        assert_eq!(transaction.mutations.len(), 2);
        for (mutation, expected) in transaction.mutations.iter().zip(&selected) {
            assert!(matches!(
                mutation,
                CanonicalEntityMutation::Update { expected: actual, .. } if actual == expected
            ));
        }
        let entry = document.execute(transaction).expect("atomic edit");
        assert_eq!(entry.effects.len(), 2);
        assert_eq!(document.journal().len(), 2);
        for original in before {
            let changed = document.entity(&original.id).expect("changed entity");
            assert_eq!(changed.name, "Matched");
            assert_eq!(changed.components_ref, original.components_ref);
            assert_eq!(changed.attributes_ref, original.attributes_ref);
            assert_eq!(changed.relations_ref, original.relations_ref);
            assert_eq!(changed.revision, original.revision + 1);
        }
    }

    #[test]
    fn stale_selection_and_schema_mismatch_fail_before_transaction_publication() {
        let document = seeded_document();
        let mut stale = selection(&document);
        stale[0].revision += 1;
        let error = compile_multi_entity_property_edit(
            &document,
            &MultiEntityPropertyEditRequest {
                schema_id: PROPERTY_EDIT_REQUEST_SCHEMA_ID.to_owned(),
                command_id: "stale-edit".to_owned(),
                entities: stale,
                assignments: vec![PropertyAssignment {
                    property_id: PropertyId::canonical_entity(ENTITY_PROPERTY_NAME),
                    value: PropertyValue::Text {
                        value: "Never committed".to_owned(),
                    },
                }],
            },
        )
        .expect_err("stale CAS must fail");
        assert!(matches!(
            error,
            PropertySchemaError::Canonical(CanonicalDocumentError::VersionConflict { .. })
        ));

        let error = compile_multi_entity_property_edit(
            &document,
            &MultiEntityPropertyEditRequest {
                schema_id: PROPERTY_EDIT_REQUEST_SCHEMA_ID.to_owned(),
                command_id: "wrong-type".to_owned(),
                entities: selection(&document),
                assignments: vec![PropertyAssignment {
                    property_id: PropertyId::canonical_entity(ENTITY_PROPERTY_NAME),
                    value: PropertyValue::EntityReferences { values: Vec::new() },
                }],
            },
        )
        .expect_err("schema type mismatch");
        assert_eq!(error, PropertySchemaError::ValueTypeMismatch);
        assert_eq!(document.generation(), 1);
    }
}
