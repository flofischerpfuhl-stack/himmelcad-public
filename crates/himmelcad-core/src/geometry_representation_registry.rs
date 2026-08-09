//! Serializable canonical representation admission contracts.
//!
//! The concrete provider/evaluated-mesh/section registry lives in
//! `himmelcad-render`. Core owns only the stable DTO vocabulary shared with
//! importers, storage and generated TypeScript contracts.

use serde::{Deserialize, Serialize};

use crate::entity::EntityId;
use crate::entity_model::{CanonicalEntity, GeometryObject, GeometryResource, Representation};
use crate::hash::ObjectHash;
use crate::typed_artifact::{
    ArtifactAffineDecode, ArtifactElementType, ArtifactEndianness, TypedArtifactDescriptor,
    TypedArtifactError, TypedArtifactLayout, TypedArtifactManifest,
};

/// One canonical representation requested for atomic registry admission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalRepresentationAdmission {
    /// Complete canonical entity envelope shared by every admitted slot.
    pub entity: CanonicalEntity,
    /// Exact member of `entity.representations` selected for this slot.
    pub selected: Representation,
    /// Stable project/provider-owned slot identity.
    pub representation_slot: String,
    /// Compare-and-swap generation; `None` is valid only when the slot never existed.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number | null"))]
    pub expected_generation: Option<u64>,
    /// Resolved canonical geometry whose content hash must equal `selected.geometryRef`.
    pub resolved_geometry: GeometryObject,
}

/// Scalar storage used by one authoritative topology position buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SectionPositionComponentType {
    /// Three little-endian IEEE-754 f32 components relative to `origin`.
    Float32,
    /// Three little-endian IEEE-754 f64 components relative to `origin`.
    Float64,
}

/// Scalar storage used by one authoritative triangle index buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SectionIndexComponentType {
    /// Little-endian unsigned 16-bit indices.
    Uint16,
    /// Little-endian unsigned 32-bit indices.
    Uint32,
}

/// Immutable resources needed to evaluate one exact topology partition.
///
/// Its canonical JSON content hash is the `topologyHash` stored in the compact
/// evaluated-mesh part descriptor. Render tiles may use unrelated LOD payloads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionTopologyPartitionManifest {
    /// Permanent manifest schema.
    pub schema_version: u32,
    /// f64 project-world anchor added after decoding every local position.
    pub origin: [f64; 3],
    /// Packed XYZ position buffer.
    pub positions: GeometryResource,
    /// Position scalar encoding.
    pub position_component_type: SectionPositionComponentType,
    /// Exact number of position triples.
    pub vertex_count: u32,
    /// Packed triangle-list index buffer.
    pub indices: GeometryResource,
    /// Index scalar encoding.
    pub index_component_type: SectionIndexComponentType,
    /// Exact number of indices; divisible by three.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub index_count: u64,
    /// Optional packed little-endian u32 material slot per triangle.
    pub material_slots: Option<GeometryResource>,
}

impl SectionTopologyPartitionManifest {
    /// Current immutable topology-partition schema.
    pub const SCHEMA_VERSION: u32 = 1;

    /// Canonical descriptor identity referenced by `SectionTopologyPart`.
    pub fn content_hash(&self) -> Result<ObjectHash, serde_json::Error> {
        serde_json::to_vec(self).map(|bytes| ObjectHash::of_bytes(&bytes))
    }

    /// Converts the authoritative topology resources into provider-neutral typed layouts.
    pub fn typed_artifact_descriptors(
        &self,
    ) -> Result<Vec<TypedArtifactDescriptor>, TypedArtifactError> {
        if self.vertex_count == 0 || self.index_count == 0 || self.index_count % 3 != 0 {
            return Err(TypedArtifactError::Layout);
        }
        let (position_element_type, position_byte_length) = match self.position_component_type {
            SectionPositionComponentType::Float32 => (
                ArtifactElementType::Float32,
                u64::from(self.vertex_count)
                    .checked_mul(3)
                    .and_then(|count| count.checked_mul(4)),
            ),
            SectionPositionComponentType::Float64 => (
                ArtifactElementType::Float64,
                u64::from(self.vertex_count)
                    .checked_mul(3)
                    .and_then(|count| count.checked_mul(8)),
            ),
        };
        let position_byte_length = position_byte_length.ok_or(TypedArtifactError::Layout)?;
        let (index_element_type, index_byte_length) = match self.index_component_type {
            SectionIndexComponentType::Uint16 => {
                (ArtifactElementType::Uint16, self.index_count.checked_mul(2))
            }
            SectionIndexComponentType::Uint32 => {
                (ArtifactElementType::Uint32, self.index_count.checked_mul(4))
            }
        };
        let index_byte_length = index_byte_length.ok_or(TypedArtifactError::Layout)?;
        let mut descriptors = vec![
            TypedArtifactDescriptor {
                resource: self.positions.clone(),
                semantic: "hcad.mesh.positions".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: position_byte_length,
                    element_type: position_element_type,
                    shape: vec![u64::from(self.vertex_count), 3],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: Some(ArtifactAffineDecode {
                        scale: vec![1.0; 3],
                        offset: self.origin.to_vec(),
                    }),
                },
            },
            TypedArtifactDescriptor {
                resource: self.indices.clone(),
                semantic: "hcad.mesh.triangle-indices".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: index_byte_length,
                    element_type: index_element_type,
                    shape: vec![self.index_count],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: None,
                },
            },
        ];
        if let Some(material_slots) = &self.material_slots {
            let triangle_count = self.index_count / 3;
            descriptors.push(TypedArtifactDescriptor {
                resource: material_slots.clone(),
                semantic: "hcad.mesh.material-slots".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: triangle_count
                        .checked_mul(4)
                        .ok_or(TypedArtifactError::Layout)?,
                    element_type: ArtifactElementType::Uint32,
                    shape: vec![triangle_count],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: None,
                },
            });
        }
        TypedArtifactManifest {
            schema_version: TypedArtifactManifest::SCHEMA_VERSION,
            artifacts: descriptors.clone(),
        }
        .validate()?;
        Ok(descriptors)
    }
}

/// Immutable identity of one canonical representation revision.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryRepresentationSlotKey {
    /// Stable semantic entity identity.
    pub entity_id: EntityId,
    /// Stable project/provider-owned representation slot.
    pub representation_slot: String,
}

/// Immutable identity of one canonical representation revision.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryRepresentationKey {
    /// Stable slot whose immutable revision this key identifies.
    pub slot: GeometryRepresentationSlotKey,
    /// Monotone canonical entity revision.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub entity_revision: u64,
    /// Hash of the complete canonical entity envelope.
    pub entity_version_hash: ObjectHash,
    /// Content address of the exact resolved geometry.
    pub geometry_ref: ObjectHash,
}

/// Small stable reference returned after an atomic publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryRepresentationBindingRef {
    /// Immutable entity/slot/revision identity; `key.slot` is the compare-and-swap target.
    pub key: GeometryRepresentationKey,
    /// Monotone slot generation used for compare-and-swap.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub generation: u64,
}
