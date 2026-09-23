//! Canonical object-property schema and wire DTOs.

use serde::{Deserialize, Serialize};

use crate::document_model::EntityVersionRef;
use crate::entity::EntityId;
use crate::entity_model::{EntityTypeId, Transform3d};
use crate::hash::ObjectHash;

/// Exact schema for the first canonical entity property namespace.
pub const CANONICAL_ENTITY_PROPERTY_SCHEMA_ID: &str = "hcad.property-schema.entity@1";
/// Exact schema for a property query request.
pub const PROPERTY_QUERY_REQUEST_SCHEMA_ID: &str = "hcad.property-query-request@1";
/// Exact schema for a property query result.
pub const PROPERTY_QUERY_RESULT_SCHEMA_ID: &str = "hcad.property-query-result@1";
/// Exact schema for an atomic multi-entity property edit request.
pub const PROPERTY_EDIT_REQUEST_SCHEMA_ID: &str = "hcad.property-edit-request@1";

/// Versioned namespace for canonical entity envelope properties.
pub const CANONICAL_ENTITY_PROPERTY_NAMESPACE: &str = "hcad.entity@1";
/// Stable semantic type property name.
pub const ENTITY_PROPERTY_TYPE_ID: &str = "typeId";
/// Stable user-facing name property name.
pub const ENTITY_PROPERTY_NAME: &str = "name";
/// Stable hierarchy owner property name.
pub const ENTITY_PROPERTY_OWNER: &str = "owner";
/// Stable layer membership property name.
pub const ENTITY_PROPERTY_LAYER_IDS: &str = "layerIds";
/// Stable placement property name.
pub const ENTITY_PROPERTY_PLACEMENT: &str = "placement";
/// Stable typed component-map reference property name.
pub const ENTITY_PROPERTY_COMPONENTS_REF: &str = "componentsRef";
/// Stable attribute-table reference property name.
pub const ENTITY_PROPERTY_ATTRIBUTES_REF: &str = "attributesRef";
/// Stable relation-set reference property name.
pub const ENTITY_PROPERTY_RELATIONS_REF: &str = "relationsRef";
/// Stable style reference property name.
pub const ENTITY_PROPERTY_STYLE_REF: &str = "styleRef";

/// Stable namespaced property identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyId {
    /// Versioned namespace owning the property semantics.
    pub namespace: String,
    /// Stable property name within the namespace.
    pub name: String,
}

impl PropertyId {
    /// Builds an identity in the canonical entity namespace.
    #[must_use]
    pub fn canonical_entity(name: impl Into<String>) -> Self {
        Self {
            namespace: CANONICAL_ENTITY_PROPERTY_NAMESPACE.to_owned(),
            name: name.into(),
        }
    }
}

/// Language-neutral value type declared by a property schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyValueType {
    /// UTF-8 text.
    Text,
    /// A versioned semantic entity type identifier.
    EntityType,
    /// An optional stable entity reference.
    OptionalEntityReference,
    /// An ordered list of stable entity references.
    EntityReferences,
    /// An optional affine placement.
    OptionalTransform3d,
    /// An immutable content address.
    ContentHash,
    /// An optional immutable content address.
    OptionalContentHash,
}

/// Whether the canonical property compiler accepts assignments to a property.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyEditability {
    /// The value is queryable but cannot be assigned through this schema.
    ReadOnly,
    /// The value compiles to a typed canonical entity edit.
    Writable,
}

/// One stable property definition in a versioned namespace schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyDefinition {
    /// Stable namespaced identity.
    pub id: PropertyId,
    /// Localization key interpreted by the application UI.
    pub display_name_key: String,
    /// Exact language-neutral value type.
    pub value_type: PropertyValueType,
    /// Supported edit behavior.
    pub editability: PropertyEditability,
}

/// Versioned schema advertised to all application clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyNamespaceSchema {
    /// Exact schema revision.
    pub schema_id: String,
    /// Versioned property namespace.
    pub namespace: String,
    /// Stable ordered property definitions.
    pub properties: Vec<PropertyDefinition>,
}

/// Returns the property schema for the canonical entity envelope.
#[must_use]
pub fn canonical_entity_property_schema() -> PropertyNamespaceSchema {
    PropertyNamespaceSchema {
        schema_id: CANONICAL_ENTITY_PROPERTY_SCHEMA_ID.to_owned(),
        namespace: CANONICAL_ENTITY_PROPERTY_NAMESPACE.to_owned(),
        properties: vec![
            definition(
                ENTITY_PROPERTY_TYPE_ID,
                PropertyValueType::EntityType,
                PropertyEditability::ReadOnly,
            ),
            definition(
                ENTITY_PROPERTY_NAME,
                PropertyValueType::Text,
                PropertyEditability::Writable,
            ),
            definition(
                ENTITY_PROPERTY_OWNER,
                PropertyValueType::OptionalEntityReference,
                PropertyEditability::Writable,
            ),
            definition(
                ENTITY_PROPERTY_LAYER_IDS,
                PropertyValueType::EntityReferences,
                PropertyEditability::Writable,
            ),
            definition(
                ENTITY_PROPERTY_PLACEMENT,
                PropertyValueType::OptionalTransform3d,
                PropertyEditability::Writable,
            ),
            definition(
                ENTITY_PROPERTY_COMPONENTS_REF,
                PropertyValueType::ContentHash,
                PropertyEditability::ReadOnly,
            ),
            definition(
                ENTITY_PROPERTY_ATTRIBUTES_REF,
                PropertyValueType::ContentHash,
                PropertyEditability::ReadOnly,
            ),
            definition(
                ENTITY_PROPERTY_RELATIONS_REF,
                PropertyValueType::ContentHash,
                PropertyEditability::ReadOnly,
            ),
            definition(
                ENTITY_PROPERTY_STYLE_REF,
                PropertyValueType::OptionalContentHash,
                PropertyEditability::Writable,
            ),
        ],
    }
}

/// Typed JSON-safe property value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PropertyValue {
    /// UTF-8 text.
    Text { value: String },
    /// Versioned semantic entity type.
    EntityType { value: EntityTypeId },
    /// Optional stable entity reference.
    OptionalEntityReference { value: Option<EntityId> },
    /// Ordered stable entity references.
    EntityReferences { values: Vec<EntityId> },
    /// Optional affine placement.
    OptionalTransform3d { value: Option<Transform3d> },
    /// Immutable content address.
    ContentHash { value: ObjectHash },
    /// Optional immutable content address.
    OptionalContentHash { value: Option<ObjectHash> },
}

/// Requested exact entity revisions and property identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyQueryRequest {
    /// Exact request schema revision.
    pub schema_id: String,
    /// Exact selected revisions observed by the client.
    pub entities: Vec<EntityVersionRef>,
    /// Requested properties. Empty means every property in the built-in schema.
    pub properties: Vec<PropertyId>,
}

/// Why a requested property cannot be projected for the selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyUnavailableReason {
    /// No registered schema owns this exact property identity.
    UnknownProperty,
}

/// Aggregated property state across an exact selection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PropertyAggregateState {
    /// Every selected entity has the same value.
    Shared { value: PropertyValue },
    /// Selected entities have different values.
    Mixed,
    /// The property cannot be interpreted by this core revision.
    Unavailable {
        /// Stable machine-readable cause.
        reason: PropertyUnavailableReason,
    },
}

/// One projected row for a multi-entity property panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyQueryRow {
    /// Exact requested identity, including unknown namespaces.
    pub property_id: PropertyId,
    /// Known definition, absent when this core must preserve the identity opaquely.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<PropertyDefinition>,
    /// Shared, mixed or unavailable selection state.
    pub aggregate: PropertyAggregateState,
}

/// Property projection for an exact canonical selection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyQueryResult {
    /// Exact result schema revision.
    pub schema_id: String,
    /// Revisions against which every row was evaluated.
    pub entities: Vec<EntityVersionRef>,
    /// Stable ordered property rows.
    pub properties: Vec<PropertyQueryRow>,
}

/// One exact value assigned to every selected entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyAssignment {
    /// Writable property identity.
    pub property_id: PropertyId,
    /// Exact target value.
    pub value: PropertyValue,
}

/// Atomic property edit over exact entity revisions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultiEntityPropertyEditRequest {
    /// Exact edit request schema revision.
    pub schema_id: String,
    /// Globally unique canonical command identity.
    pub command_id: String,
    /// Exact selected revisions originally queried by the client.
    pub entities: Vec<EntityVersionRef>,
    /// Assignments applied uniformly to every selected entity.
    pub assignments: Vec<PropertyAssignment>,
}

fn definition(
    name: &str,
    value_type: PropertyValueType,
    editability: PropertyEditability,
) -> PropertyDefinition {
    PropertyDefinition {
        id: PropertyId::canonical_entity(name),
        display_name_key: format!("property.entity.{name}"),
        value_type,
        editability,
    }
}
