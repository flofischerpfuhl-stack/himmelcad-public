//! Canonical drafting command logic behind an injected document capability.

use himmelcad_core::release_05_admissions::{
    validate_measurement, validate_point_acquisition, validate_support_role, MeasurementAnchorV1,
    MeasurementV1, PointAcquisitionV1, SupportRoleKindV1, SupportRoleV1, MEASUREMENT_SCHEMA_ID,
    RELEASE_05_SCHEMA_VERSION, SUPPORT_ROLE_SCHEMA_ID,
};
use himmelcad_document::canonical_document::{
    CanonicalCommandTransaction, CanonicalEntityEdit, CanonicalEntityMutation,
    CanonicalJournalEntry, EntityVersionRef,
};
use himmelcad_document::canonical_import::{CanonicalJsonObject, ProviderContractError};
use himmelcad_document::domain_commands::DraftingDocumentCommands;
use himmelcad_model::entity::EntityId;
use himmelcad_model::entity_model::{
    built_in_type, CanonicalEntity, CurveGeometry, EntityTypeId, GeometryObject, Position,
    Representation, RepresentationAuthority, RepresentationRole,
};
use himmelcad_model::entity_validation::{
    canonical_entity_version_hash, validate_resolved_representation,
};
use himmelcad_model::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_model::hash::ObjectHash;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const VIEW_BOOKMARK_SCHEMA_ID: &str = "hcad.view-bookmark@1";
const VIEWING_BOX_SCHEMA_ID: &str = "hcad.viewing-box@1";
const DRAW_CURVE_COMPONENT_SCHEMA_ID: &str = "hcad.draw-curve@1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewBookmarkRecord {
    pub schema_id: String,
    pub schema_version: u32,
    pub state: serde_json::Value,
    pub restore_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewBookmarkSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub state: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewBookmarkCommit {
    pub bookmark: CanonicalViewBookmarkSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewingBoxSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub state: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewingBoxCommit {
    pub viewing_box: CanonicalViewingBoxSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalViewingBoxDelete {
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMeasurementSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub measurement: MeasurementV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMeasurementCommit {
    pub measurement: CanonicalMeasurementSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMeasurementDelete {
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrawCurveRole {
    Plain,
    Breakline,
    Boundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DrawCurveTool {
    Line,
    Polyline,
    Boundary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawCurveInput {
    pub entity_id: String,
    pub expected_revision: Option<u64>,
    pub name: String,
    pub tool: DrawCurveTool,
    pub role: DrawCurveRole,
    pub closed: bool,
    pub vertices: Vec<Position>,
    pub acquisitions: Vec<PointAcquisitionV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrawCurveComponents {
    schema_id: String,
    schema_version: u32,
    tool: DrawCurveTool,
    role: DrawCurveRole,
    mesh_source_role: Option<String>,
    point_acquisitions: Vec<PointAcquisitionV1>,
    support_role: SupportRoleV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalDrawCurveSummary {
    pub entity_id: String,
    pub revision: u64,
    pub name: String,
    pub role: DrawCurveRole,
    pub closed: bool,
    pub vertices: Vec<Position>,
    pub acquisitions: Vec<PointAcquisitionV1>,
    pub admission: CanonicalRepresentationAdmission,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalDrawCurveCommit {
    pub curve: CanonicalDrawCurveSummary,
    pub journal_entry: CanonicalJournalEntry,
}

#[derive(Debug, Error)]
pub enum DraftingCommandError<E> {
    #[error(transparent)]
    Document(E),
    #[error("{0}")]
    InvalidResidency(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Provider(#[from] ProviderContractError),
}

pub struct DraftingCommandService;

impl DraftingCommandService {
    pub fn create_view_bookmark<Document>(
        document: &mut Document,
        command_id: String,
        entity_id: String,
        name: String,
        state: serde_json::Value,
    ) -> Result<CanonicalViewBookmarkCommit, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() || name.trim().is_empty() {
            return Err(invalid("bookmark command, entity id and name are required"));
        }
        validate_view_bookmark_state(&state)?;
        let record = CanonicalViewBookmarkRecord {
            schema_id: VIEW_BOOKMARK_SCHEMA_ID.to_owned(),
            schema_version: 1,
            state,
            restore_count: 0,
        };
        let components = bookmark_object(&record)?;
        let attributes = empty_json_object(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({}),
        )?;
        let relations = empty_json_object(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )?;
        document
            .drafting_put_json_object(&components)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&attributes)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&relations)
            .map_err(DraftingCommandError::Document)?;
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        let owner = project_owner(&entities);
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(VIEW_BOOKMARK_SCHEMA_ID.to_owned()),
            name: name.trim().to_owned(),
            owner,
            layer_ids: Vec::new(),
            placement: None,
            representations: Vec::new(),
            components_ref: components.object_hash,
            attributes_ref: attributes.object_hash,
            relations_ref: relations.object_hash,
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending view bookmark"),
        };
        entity.version_hash =
            canonical_entity_version_hash(&entity).map_err(|error| invalid(error.to_string()))?;
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![CanonicalEntityMutation::Create { entity }],
            })
            .map_err(DraftingCommandError::Document)?;
        let entity = journal_entry.effects[0]
            .after
            .as_ref()
            .ok_or_else(|| invalid("bookmark create produced no live entity"))?;
        let bookmark = read_view_bookmark(document, entity)?;
        Ok(CanonicalViewBookmarkCommit {
            bookmark,
            journal_entry,
        })
    }

    pub fn list_view_bookmarks<Document>(
        document: &Document,
    ) -> Result<Vec<CanonicalViewBookmarkSummary>, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        let mut result = entities
            .iter()
            .filter(|entity| entity.type_id.0 == VIEW_BOOKMARK_SCHEMA_ID)
            .map(|entity| read_view_bookmark(document, entity))
            .collect::<Result<Vec<_>, _>>()?;
        result.sort_by(|left, right| {
            (&left.name, &left.entity_id).cmp(&(&right.name, &right.entity_id))
        });
        Ok(result)
    }

    pub fn restore_view_bookmark<Document>(
        document: &mut Document,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewBookmarkCommit, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        let entity = find_entity(document, &entity_id)?
            .ok_or_else(|| invalid(format!("bookmark {entity_id:?} no longer exists")))?;
        if entity.type_id.0 != VIEW_BOOKMARK_SCHEMA_ID || entity.revision != expected_revision {
            return Err(invalid(format!(
                "bookmark {entity_id:?} is stale or has the wrong type"
            )));
        }
        let mut record: CanonicalViewBookmarkRecord = serde_json::from_slice(
            &document
                .drafting_read_object(&entity.components_ref)
                .map_err(DraftingCommandError::Document)?,
        )?;
        record.restore_count = record.restore_count.saturating_add(1);
        let components = bookmark_object(&record)?;
        document
            .drafting_put_json_object(&components)
            .map_err(DraftingCommandError::Document)?;
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![CanonicalEntityMutation::Update {
                    expected: EntityVersionRef {
                        id: entity.id,
                        revision: entity.revision,
                        version_hash: entity.version_hash,
                    },
                    edits: vec![CanonicalEntityEdit::SetComponentsRef {
                        components_ref: components.object_hash,
                    }],
                }],
            })
            .map_err(DraftingCommandError::Document)?;
        let entity = journal_entry.effects[0]
            .after
            .as_ref()
            .ok_or_else(|| invalid("bookmark restore produced no live entity"))?;
        let bookmark = read_view_bookmark(document, entity)?;
        Ok(CanonicalViewBookmarkCommit {
            bookmark,
            journal_entry,
        })
    }

    pub fn put_viewing_box<Document>(
        document: &mut Document,
        command_id: String,
        entity_id: String,
        name: String,
        expected_revision: Option<u64>,
        state: serde_json::Value,
    ) -> Result<CanonicalViewingBoxCommit, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        if command_id.trim().is_empty()
            || entity_id.trim().is_empty()
            || name.trim().is_empty()
            || !state.is_object()
        {
            return Err(invalid(
                "viewing-box command, id, name and object state are required",
            ));
        }
        let components = empty_json_object(
            "application/vnd.himmelcad.viewing-box+json",
            serde_json::json!({
                "schemaId": VIEWING_BOX_SCHEMA_ID,
                "schemaVersion": 1,
                "state": state,
            }),
        )?;
        document
            .drafting_put_json_object(&components)
            .map_err(DraftingCommandError::Document)?;
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        let existing = entities
            .iter()
            .find(|entity| entity.id.0 == entity_id)
            .cloned();
        let mutation = if let Some(entity) = existing {
            if entity.type_id.0 != VIEWING_BOX_SCHEMA_ID
                || expected_revision != Some(entity.revision)
            {
                return Err(invalid(format!(
                    "viewing box {entity_id:?} is stale or has the wrong type"
                )));
            }
            CanonicalEntityMutation::Update {
                expected: EntityVersionRef {
                    id: entity.id,
                    revision: entity.revision,
                    version_hash: entity.version_hash,
                },
                edits: vec![
                    CanonicalEntityEdit::SetName {
                        name: name.trim().to_owned(),
                    },
                    CanonicalEntityEdit::SetComponentsRef {
                        components_ref: components.object_hash,
                    },
                ],
            }
        } else {
            if expected_revision.is_some() {
                return Err(invalid(format!(
                    "viewing box {entity_id:?} no longer exists"
                )));
            }
            let attributes = empty_json_object(
                "application/vnd.himmelcad.attributes+json",
                serde_json::json!({}),
            )?;
            let relations = empty_json_object(
                "application/vnd.himmelcad.relations+json",
                serde_json::json!([]),
            )?;
            document
                .drafting_put_json_object(&attributes)
                .map_err(DraftingCommandError::Document)?;
            document
                .drafting_put_json_object(&relations)
                .map_err(DraftingCommandError::Document)?;
            let mut entity = CanonicalEntity {
                id: EntityId(entity_id),
                revision: 0,
                type_id: EntityTypeId(VIEWING_BOX_SCHEMA_ID.to_owned()),
                name: name.trim().to_owned(),
                owner: project_owner(&entities),
                layer_ids: Vec::new(),
                placement: None,
                representations: Vec::new(),
                components_ref: components.object_hash,
                attributes_ref: attributes.object_hash,
                relations_ref: relations.object_hash,
                style_ref: None,
                schema_version: 1,
                version_hash: ObjectHash::of_bytes(b"pending viewing box"),
            };
            entity.version_hash = canonical_entity_version_hash(&entity)
                .map_err(|error| invalid(error.to_string()))?;
            CanonicalEntityMutation::Create { entity }
        };
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![mutation],
            })
            .map_err(DraftingCommandError::Document)?;
        let entity = journal_entry.effects[0]
            .after
            .as_ref()
            .ok_or_else(|| invalid("viewing-box commit produced no live entity"))?;
        let viewing_box = read_viewing_box(document, entity)?;
        Ok(CanonicalViewingBoxCommit {
            viewing_box,
            journal_entry,
        })
    }

    pub fn list_viewing_boxes<Document>(
        document: &Document,
    ) -> Result<Vec<CanonicalViewingBoxSummary>, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?
            .iter()
            .filter(|entity| entity.type_id.0 == VIEWING_BOX_SCHEMA_ID)
            .map(|entity| read_viewing_box(document, entity))
            .collect()
    }

    pub fn delete_viewing_box<Document>(
        document: &mut Document,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewingBoxDelete, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() {
            return Err(invalid("viewing-box delete command and id are required"));
        }
        let entity = find_entity(document, &entity_id)?
            .ok_or_else(|| invalid(format!("viewing box {entity_id:?} no longer exists")))?;
        if entity.type_id.0 != VIEWING_BOX_SCHEMA_ID || entity.revision != expected_revision {
            return Err(invalid(format!(
                "viewing box {entity_id:?} is stale or has the wrong type"
            )));
        }
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef {
                        id: entity.id,
                        revision: entity.revision,
                        version_hash: entity.version_hash,
                    },
                }],
            })
            .map_err(DraftingCommandError::Document)?;
        Ok(CanonicalViewingBoxDelete { journal_entry })
    }

    /// Creates one admitted Release 0.5 measurement in one journal transaction.
    pub fn create_measurement<Document>(
        document: &mut Document,
        command_id: String,
        entity_id: String,
        name: String,
        measurement: MeasurementV1,
    ) -> Result<CanonicalMeasurementCommit, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() || name.trim().is_empty() {
            return Err(invalid(
                "measurement command, entity id and name are required",
            ));
        }
        validate_measurement(&measurement).map_err(|error| {
            invalid(format!(
                "measurement payload is outside the admitted 0.5 profile: {error}"
            ))
        })?;
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        if entities.iter().any(|entity| entity.id.0 == entity_id)
            || document
                .drafting_tombstone_exists(&EntityId(entity_id.clone()))
                .map_err(DraftingCommandError::Document)?
        {
            return Err(invalid(format!("measurement {entity_id:?} already exists")));
        }
        for anchor in &measurement.anchors {
            let MeasurementAnchorV1::Attached {
                entity_id,
                expected_revision,
                expected_version_hash,
                ..
            } = anchor
            else {
                continue;
            };
            let source = entities
                .iter()
                .find(|entity| entity.id == *entity_id)
                .ok_or_else(|| {
                    invalid(format!(
                        "attached measurement source {:?} no longer exists",
                        entity_id.0
                    ))
                })?;
            if source.revision != *expected_revision
                || source.version_hash != *expected_version_hash
            {
                return Err(invalid(format!(
                    "attached measurement source {:?} changed before commit",
                    entity_id.0
                )));
            }
        }
        let geometry = GeometryObject::Measurement {
            measurement: Box::new(measurement.clone()),
        };
        let geometry_ref = document
            .drafting_put_geometry_object(&geometry)
            .map_err(DraftingCommandError::Document)?;
        let components = empty_json_object(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({ "schemaId": "hcad.components@1" }),
        )?;
        let attributes = empty_json_object(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({ "schemaId": "hcad.attributes@1" }),
        )?;
        let relations = empty_json_object(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
        )?;
        document
            .drafting_put_json_object(&components)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&attributes)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&relations)
            .map_err(DraftingCommandError::Document)?;
        match entities
            .iter()
            .find(|entity| entity.id == measurement.layer_id)
        {
            Some(layer) if layer.type_id.0 == built_in_type::LAYER => {}
            Some(_) => {
                return Err(invalid(format!(
                    "measurement layer {:?} has the wrong type",
                    measurement.layer_id.0
                )));
            }
            None => {
                return Err(invalid(format!(
                    "measurement layer {:?} no longer exists",
                    measurement.layer_id.0
                )));
            }
        }
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(MEASUREMENT_SCHEMA_ID.to_owned()),
            name: name.trim().to_owned(),
            owner: project_owner(&entities),
            layer_ids: vec![measurement.layer_id.clone()],
            placement: None,
            representations: vec![Representation {
                role: RepresentationRole::Canonical,
                geometry_ref,
                authority: RepresentationAuthority::Authoritative,
                dependency_hash: None,
            }],
            components_ref: components.object_hash,
            attributes_ref: attributes.object_hash,
            relations_ref: relations.object_hash,
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending measurement"),
        };
        entity.version_hash =
            canonical_entity_version_hash(&entity).map_err(|error| invalid(error.to_string()))?;
        validate_resolved_representation(
            &entity,
            entity
                .representations
                .first()
                .expect("measurement representation"),
            &geometry,
        )
        .map_err(|error| invalid(error.to_string()))?;
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![CanonicalEntityMutation::Create { entity }],
            })
            .map_err(DraftingCommandError::Document)?;
        let entity = journal_entry
            .effects
            .last()
            .and_then(|effect| effect.after.as_ref())
            .ok_or_else(|| invalid("measurement create produced no live entity"))?;
        let measurement = read_measurement(document, entity)?;
        Ok(CanonicalMeasurementCommit {
            measurement,
            journal_entry,
        })
    }

    pub fn list_measurements<Document>(
        document: &Document,
    ) -> Result<Vec<CanonicalMeasurementSummary>, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        let mut result = entities
            .iter()
            .filter(|entity| entity.type_id.0 == MEASUREMENT_SCHEMA_ID)
            .map(|entity| read_measurement(document, entity))
            .collect::<Result<Vec<_>, _>>()?;
        result.sort_by(|left, right| {
            (&left.name, &left.entity_id).cmp(&(&right.name, &right.entity_id))
        });
        Ok(result)
    }

    pub fn get_measurement<Document>(
        document: &Document,
        entity_id: &str,
    ) -> Result<CanonicalMeasurementSummary, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        let entity = find_entity(document, entity_id)?
            .ok_or_else(|| invalid(format!("measurement {entity_id:?} no longer exists")))?;
        read_measurement(document, &entity)
    }

    pub fn delete_measurement<Document>(
        document: &mut Document,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalMeasurementDelete, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        if command_id.trim().is_empty() || entity_id.trim().is_empty() {
            return Err(invalid(
                "measurement delete command and entity id are required",
            ));
        }
        let entity = find_entity(document, &entity_id)?
            .ok_or_else(|| invalid(format!("measurement {entity_id:?} no longer exists")))?;
        if entity.type_id.0 != MEASUREMENT_SCHEMA_ID || entity.revision != expected_revision {
            return Err(invalid(format!(
                "measurement {entity_id:?} is stale or has the wrong type"
            )));
        }
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![CanonicalEntityMutation::Delete {
                    expected: EntityVersionRef::from_entity(&entity),
                }],
            })
            .map_err(DraftingCommandError::Document)?;
        Ok(CanonicalMeasurementDelete { journal_entry })
    }

    /// Creates or extends one authored linework entity.
    pub fn put_draw_curve<Document>(
        document: &mut Document,
        command_id: String,
        input: DrawCurveInput,
    ) -> Result<CanonicalDrawCurveCommit, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        validate_draw_curve_input(&command_id, &input)?;
        let geometry = GeometryObject::Curve {
            curve: Box::new(if input.tool == DrawCurveTool::Line {
                CurveGeometry::LineSegment {
                    start: input.vertices[0],
                    end: input.vertices[1],
                }
            } else {
                CurveGeometry::Polyline {
                    positions: input.vertices.clone(),
                    closed: input.closed,
                }
            }),
        };
        let support_role = SupportRoleV1 {
            schema_id: SUPPORT_ROLE_SCHEMA_ID.to_owned(),
            schema_version: RELEASE_05_SCHEMA_VERSION,
            role_kind: SupportRoleKindV1::DefiningCurve,
            defines: Vec::new(),
            provenance: "draw.vertex".to_owned(),
        };
        validate_support_role(&support_role)
            .map_err(|error| invalid(format!("invalid draw support role: {error}")))?;
        let components_value = DrawCurveComponents {
            schema_id: DRAW_CURVE_COMPONENT_SCHEMA_ID.to_owned(),
            schema_version: 1,
            tool: input.tool,
            role: input.role,
            mesh_source_role: match input.role {
                DrawCurveRole::Plain => None,
                DrawCurveRole::Breakline => Some("breakline".to_owned()),
                DrawCurveRole::Boundary if input.closed => Some("outer_boundary".to_owned()),
                DrawCurveRole::Boundary => None,
            },
            point_acquisitions: input.acquisitions.clone(),
            support_role,
        };
        let components = empty_json_object(
            "application/vnd.himmelcad.components+json",
            serde_json::to_value(&components_value)?,
        )?;
        let attributes = empty_json_object(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({ "schemaId": "hcad.attributes@1" }),
        )?;
        let relations = empty_json_object(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!({ "schemaId": "hcad.relations@1", "relations": [] }),
        )?;
        let geometry_ref = document
            .drafting_put_geometry_object(&geometry)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&components)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&attributes)
            .map_err(DraftingCommandError::Document)?;
        document
            .drafting_put_json_object(&relations)
            .map_err(DraftingCommandError::Document)?;
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref,
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        let existing = entities
            .iter()
            .find(|entity| entity.id.0 == input.entity_id)
            .cloned();
        let mutation = match (existing, input.expected_revision) {
            (None, None) => {
                let mut entity = CanonicalEntity {
                    id: EntityId(input.entity_id.clone()),
                    revision: 0,
                    type_id: EntityTypeId(built_in_type::CURVE.to_owned()),
                    name: input.name.trim().to_owned(),
                    owner: project_owner(&entities),
                    layer_ids: vec![EntityId("default-layer".to_owned())],
                    placement: None,
                    representations: vec![selected.clone()],
                    components_ref: components.object_hash.clone(),
                    attributes_ref: attributes.object_hash.clone(),
                    relations_ref: relations.object_hash.clone(),
                    style_ref: None,
                    schema_version: 1,
                    version_hash: ObjectHash::of_bytes(b"pending draw curve"),
                };
                entity.version_hash = canonical_entity_version_hash(&entity)
                    .map_err(|error| invalid(error.to_string()))?;
                validate_resolved_representation(&entity, &selected, &geometry)
                    .map_err(|error| invalid(error.to_string()))?;
                CanonicalEntityMutation::Create { entity }
            }
            (Some(entity), Some(expected_revision))
                if entity.type_id.0 == built_in_type::CURVE
                    && entity.revision == expected_revision =>
            {
                CanonicalEntityMutation::Update {
                    expected: EntityVersionRef::from_entity(&entity),
                    edits: vec![
                        CanonicalEntityEdit::SetRepresentations {
                            representations: vec![selected],
                        },
                        CanonicalEntityEdit::SetComponentsRef {
                            components_ref: components.object_hash,
                        },
                    ],
                }
            }
            _ => {
                return Err(invalid(format!(
                    "draw curve {:?} is stale, missing, or has the wrong type",
                    input.entity_id
                )));
            }
        };
        let journal_entry = document
            .drafting_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: vec![mutation],
            })
            .map_err(DraftingCommandError::Document)?;
        let entity = journal_entry
            .effects
            .iter()
            .find(|effect| effect.entity_id.0 == input.entity_id)
            .and_then(|effect| effect.after.as_ref())
            .ok_or_else(|| invalid("draw curve mutation produced no live entity"))?;
        let curve = read_draw_curve(document, entity)?;
        Ok(CanonicalDrawCurveCommit {
            curve,
            journal_entry,
        })
    }

    pub fn list_draw_curves<Document>(
        document: &Document,
    ) -> Result<Vec<CanonicalDrawCurveSummary>, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        let entities = document
            .drafting_entities()
            .map_err(DraftingCommandError::Document)?;
        let mut curves = entities
            .iter()
            .filter(|entity| entity.type_id.0 == built_in_type::CURVE)
            .filter_map(|entity| match read_draw_curve(document, entity) {
                Ok(curve) => Some(Ok(curve)),
                Err(DraftingCommandError::InvalidResidency(message))
                    if message.contains("is not authored draw linework") =>
                {
                    None
                }
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        curves.sort_by(|left, right| {
            (&left.name, &left.entity_id).cmp(&(&right.name, &right.entity_id))
        });
        Ok(curves)
    }

    pub fn undo_draw_curve<Document>(
        document: &mut Document,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        document
            .drafting_undo(command_id, &target_command_id)
            .map_err(DraftingCommandError::Document)
    }

    pub fn redo_draw_curve<Document>(
        document: &mut Document,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, DraftingCommandError<Document::Error>>
    where
        Document: DraftingDocumentCommands,
        Document::Error: std::error::Error + Send + Sync + 'static,
    {
        document
            .drafting_redo(command_id, &target_command_id)
            .map_err(DraftingCommandError::Document)
    }
}

fn invalid<E>(message: impl Into<String>) -> DraftingCommandError<E> {
    DraftingCommandError::InvalidResidency(message.into())
}

fn project_owner(entities: &[CanonicalEntity]) -> Option<EntityId> {
    entities
        .iter()
        .find(|entity| entity.owner.is_none() && entity.type_id.0 == built_in_type::GROUP)
        .map(|entity| entity.id.clone())
}

fn find_entity<Document>(
    document: &Document,
    entity_id: &str,
) -> Result<Option<CanonicalEntity>, DraftingCommandError<Document::Error>>
where
    Document: DraftingDocumentCommands,
    Document::Error: std::error::Error + Send + Sync + 'static,
{
    Ok(document
        .drafting_entities()
        .map_err(DraftingCommandError::Document)?
        .into_iter()
        .find(|entity| entity.id.0 == entity_id))
}

fn validate_view_bookmark_state<E>(
    state: &serde_json::Value,
) -> Result<(), DraftingCommandError<E>> {
    let object = state
        .as_object()
        .ok_or_else(|| invalid("bookmark state must be an object"))?;
    if object.get("schemaId").and_then(serde_json::Value::as_str)
        != Some("hcad.bookmark-view-state@1")
        || !object
            .get("camera")
            .is_some_and(serde_json::Value::is_object)
        || !object
            .get("presentation")
            .is_some_and(serde_json::Value::is_object)
        || !object
            .get("clipRefs")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(invalid(
            "bookmark state does not match hcad.bookmark-view-state@1",
        ));
    }
    Ok(())
}

fn bookmark_object<E>(
    record: &CanonicalViewBookmarkRecord,
) -> Result<CanonicalJsonObject, DraftingCommandError<E>> {
    empty_json_object(
        "application/vnd.himmelcad.view-bookmark+json",
        serde_json::to_value(record)?,
    )
}

fn empty_json_object<E>(
    media_type: &str,
    value: serde_json::Value,
) -> Result<CanonicalJsonObject, DraftingCommandError<E>> {
    let bytes = serde_json::to_vec(&value)?;
    Ok(CanonicalJsonObject {
        object_hash: ObjectHash::of_bytes(&bytes),
        media_type: media_type.to_owned(),
        value,
    })
}

fn read_view_bookmark<Document>(
    document: &Document,
    entity: &CanonicalEntity,
) -> Result<CanonicalViewBookmarkSummary, DraftingCommandError<Document::Error>>
where
    Document: DraftingDocumentCommands,
    Document::Error: std::error::Error + Send + Sync + 'static,
{
    let record: CanonicalViewBookmarkRecord = serde_json::from_slice(
        &document
            .drafting_read_object(&entity.components_ref)
            .map_err(DraftingCommandError::Document)?,
    )?;
    if record.schema_id != VIEW_BOOKMARK_SCHEMA_ID || record.schema_version != 1 {
        return Err(invalid(format!(
            "bookmark {:?} has an unsupported component",
            entity.id.0
        )));
    }
    validate_view_bookmark_state(&record.state)?;
    Ok(CanonicalViewBookmarkSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        state: record.state,
    })
}

fn read_viewing_box<Document>(
    document: &Document,
    entity: &CanonicalEntity,
) -> Result<CanonicalViewingBoxSummary, DraftingCommandError<Document::Error>>
where
    Document: DraftingDocumentCommands,
    Document::Error: std::error::Error + Send + Sync + 'static,
{
    let value: serde_json::Value = serde_json::from_slice(
        &document
            .drafting_read_object(&entity.components_ref)
            .map_err(DraftingCommandError::Document)?,
    )?;
    let state = value.get("state").cloned().ok_or_else(|| {
        invalid(format!(
            "viewing box {:?} has no state component",
            entity.id.0
        ))
    })?;
    if value.get("schemaId").and_then(serde_json::Value::as_str) != Some(VIEWING_BOX_SCHEMA_ID)
        || value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
        || !state.is_object()
    {
        return Err(invalid(format!(
            "viewing box {:?} has an unsupported component",
            entity.id.0
        )));
    }
    Ok(CanonicalViewingBoxSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        state,
    })
}

fn read_measurement<Document>(
    document: &Document,
    entity: &CanonicalEntity,
) -> Result<CanonicalMeasurementSummary, DraftingCommandError<Document::Error>>
where
    Document: DraftingDocumentCommands,
    Document::Error: std::error::Error + Send + Sync + 'static,
{
    if entity.type_id.0 != MEASUREMENT_SCHEMA_ID
        || entity.placement.is_some()
        || entity.layer_ids.len() != 1
    {
        return Err(invalid(format!(
            "measurement {:?} has an incompatible entity envelope",
            entity.id.0
        )));
    }
    let representation = entity
        .representations
        .iter()
        .find(|representation| {
            representation.role == RepresentationRole::Canonical
                && representation.authority == RepresentationAuthority::Authoritative
        })
        .ok_or_else(|| {
            invalid(format!(
                "measurement {:?} has no authoritative geometry",
                entity.id.0
            ))
        })?;
    let geometry: GeometryObject = serde_json::from_slice(
        &document
            .drafting_read_object(&representation.geometry_ref)
            .map_err(DraftingCommandError::Document)?,
    )?;
    let GeometryObject::Measurement { measurement } = geometry else {
        return Err(invalid(format!(
            "measurement {:?} has the wrong geometry kind",
            entity.id.0
        )));
    };
    validate_measurement(&measurement).map_err(|error| {
        invalid(format!(
            "measurement {:?} failed admission: {error}",
            entity.id.0
        ))
    })?;
    if measurement.layer_id != entity.layer_ids[0] {
        return Err(invalid(format!(
            "measurement {:?} layer payload differs from its entity envelope",
            entity.id.0
        )));
    }
    Ok(CanonicalMeasurementSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        measurement: *measurement,
    })
}

fn validate_draw_curve_input<E>(
    command_id: &str,
    input: &DrawCurveInput,
) -> Result<(), DraftingCommandError<E>> {
    if command_id.trim().is_empty()
        || input.entity_id.trim().is_empty()
        || input.name.trim().is_empty()
        || input.vertices.len() < 2
        || input.vertices.len() != input.acquisitions.len()
        || (input.tool == DrawCurveTool::Line && (input.vertices.len() != 2 || input.closed))
        || (input.closed && (input.tool == DrawCurveTool::Line || input.vertices.len() < 3))
        || (input.role == DrawCurveRole::Boundary && input.tool != DrawCurveTool::Boundary)
        || (input.tool == DrawCurveTool::Boundary && input.role != DrawCurveRole::Boundary)
    {
        return Err(invalid(
            "draw curve input has invalid identity, topology, role, or vertex counts",
        ));
    }
    for (position, acquisition) in input.vertices.iter().zip(&input.acquisitions) {
        validate_point_acquisition(acquisition)
            .map_err(|error| invalid(format!("draw vertex acquisition is invalid: {error}")))?;
        if acquisition.final_coordinate != *position {
            return Err(invalid(
                "draw vertex differs from its acquisition coordinate",
            ));
        }
    }
    Ok(())
}

fn read_draw_curve<Document>(
    document: &Document,
    entity: &CanonicalEntity,
) -> Result<CanonicalDrawCurveSummary, DraftingCommandError<Document::Error>>
where
    Document: DraftingDocumentCommands,
    Document::Error: std::error::Error + Send + Sync + 'static,
{
    let components: DrawCurveComponents = serde_json::from_slice(
        &document
            .drafting_read_object(&entity.components_ref)
            .map_err(DraftingCommandError::Document)?,
    )
    .map_err(|_| {
        invalid(format!(
            "curve {:?} is not authored draw linework",
            entity.id.0
        ))
    })?;
    if components.schema_id != DRAW_CURVE_COMPONENT_SCHEMA_ID || components.schema_version != 1 {
        return Err(invalid(format!(
            "curve {:?} is not authored draw linework",
            entity.id.0
        )));
    }
    validate_support_role(&components.support_role).map_err(|error| {
        invalid(format!(
            "draw curve {:?} support role is invalid: {error}",
            entity.id.0
        ))
    })?;
    let selected = entity
        .representations
        .iter()
        .find(|representation| {
            representation.role == RepresentationRole::Canonical
                && representation.authority == RepresentationAuthority::Authoritative
        })
        .cloned()
        .ok_or_else(|| {
            invalid(format!(
                "draw curve {:?} has no authoritative geometry",
                entity.id.0
            ))
        })?;
    let resolved_geometry: GeometryObject = serde_json::from_slice(
        &document
            .drafting_read_object(&selected.geometry_ref)
            .map_err(DraftingCommandError::Document)?,
    )?;
    validate_resolved_representation(entity, &selected, &resolved_geometry).map_err(|error| {
        invalid(format!(
            "draw curve {:?} failed representation validation: {error}",
            entity.id.0
        ))
    })?;
    let GeometryObject::Curve { curve } = &resolved_geometry else {
        return Err(invalid(format!(
            "draw curve {:?} has the wrong geometry kind",
            entity.id.0
        )));
    };
    let (vertices, closed) = match curve.as_ref() {
        CurveGeometry::LineSegment { start, end } => (vec![*start, *end], false),
        CurveGeometry::Polyline { positions, closed } => (positions.clone(), *closed),
        _ => {
            return Err(invalid(format!(
                "draw curve {:?} has an unsupported curve kind",
                entity.id.0
            )));
        }
    };
    let input = DrawCurveInput {
        entity_id: entity.id.0.clone(),
        expected_revision: Some(entity.revision),
        name: entity.name.clone(),
        tool: components.tool,
        role: components.role,
        closed,
        vertices: vertices.clone(),
        acquisitions: components.point_acquisitions.clone(),
    };
    validate_draw_curve_input("read", &input)?;
    Ok(CanonicalDrawCurveSummary {
        entity_id: entity.id.0.clone(),
        revision: entity.revision,
        name: entity.name.clone(),
        role: components.role,
        closed,
        vertices,
        acquisitions: components.point_acquisitions,
        admission: CanonicalRepresentationAdmission {
            entity: entity.clone(),
            selected,
            representation_slot: "primary".to_owned(),
            expected_generation: None,
            resolved_geometry,
        },
    })
}
