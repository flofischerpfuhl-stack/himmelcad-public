//! Provider-neutral physical layouts for immutable binary geometry artifacts.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::entity_model::GeometryResource;

/// Stable file name used for one typed-artifact manifest inside a prepared dataset.
pub const TYPED_ARTIFACT_MANIFEST_NAME: &str = "hcad.typed-artifacts.json";

/// Semantic media type of [`TypedArtifactManifest`] JSON.
pub const TYPED_ARTIFACT_MANIFEST_MEDIA_TYPE: &str =
    "application/vnd.himmelcad.typed-artifacts+json;version=1";

/// Scalar stored by a dense array or interleaved field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactElementType {
    /// Unsigned 8-bit integer.
    Uint8,
    /// Signed 8-bit integer.
    Int8,
    /// Unsigned 16-bit integer.
    Uint16,
    /// Signed 16-bit integer.
    Int16,
    /// Unsigned 32-bit integer.
    Uint32,
    /// Signed 32-bit integer.
    Int32,
    /// Unsigned 64-bit integer.
    Uint64,
    /// Signed 64-bit integer.
    Int64,
    /// IEEE-754 32-bit float.
    Float32,
    /// IEEE-754 64-bit float.
    Float64,
}

impl ArtifactElementType {
    /// Exact storage width of one scalar.
    #[must_use]
    pub const fn byte_width(self) -> u64 {
        match self {
            Self::Uint8 | Self::Int8 => 1,
            Self::Uint16 | Self::Int16 => 2,
            Self::Uint32 | Self::Int32 | Self::Float32 => 4,
            Self::Uint64 | Self::Int64 | Self::Float64 => 8,
        }
    }
}

/// Byte order of a stored scalar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactEndianness {
    /// Byte order is irrelevant for one-byte scalars.
    NotApplicable,
    /// Least-significant byte first.
    Little,
    /// Most-significant byte first.
    Big,
}

/// Component-wise affine decode applied after reading stored scalar values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactAffineDecode {
    /// Multiplier per logical component.
    pub scale: Vec<f64>,
    /// Additive offset per logical component.
    pub offset: Vec<f64>,
}

/// Storage encoding of one independently addressable record chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactChunkEncoding {
    /// Records are stored directly in the addressed byte range.
    Raw,
    /// The addressed byte range is one Brotli stream which expands to the records.
    Brotli,
}

/// One physical range containing a known number of homogeneous records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRecordChunk {
    /// Provider-local stable chunk identity, for example an octree node ID.
    pub id: String,
    /// Byte offset from the beginning of the immutable backing resource.
    pub byte_offset: u64,
    /// Number of stored bytes, compressed when `encoding` is `brotli`.
    pub byte_length: u64,
    /// Number of decoded records in this chunk.
    pub record_count: u64,
    /// Exact storage encoding of this chunk.
    pub encoding: ArtifactChunkEncoding,
}

/// One field inside a fixed-stride interleaved record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterleavedArtifactField {
    /// Stable provider-authored field name.
    pub name: String,
    /// Semantic role independent from the source field spelling.
    pub semantic: String,
    /// Byte offset from the beginning of each decoded record.
    pub byte_offset: u64,
    /// Scalar storage type.
    pub element_type: ArtifactElementType,
    /// Logical component dimensions within one record.
    pub shape: Vec<u64>,
    /// Scalar byte order.
    pub endianness: ArtifactEndianness,
    /// Optional component strides. Absence means compact row-major components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_strides: Option<Vec<u64>>,
    /// Optional component-wise decode, for example quantized XYZ scale and offset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode: Option<ArtifactAffineDecode>,
}

/// Physical interpretation of one immutable artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TypedArtifactLayout {
    /// Bytes intentionally remain encoded or otherwise opaque.
    OpaqueBytes {
        /// Byte offset from the beginning of the backing resource.
        byte_offset: u64,
        /// Exact number of opaque bytes.
        byte_length: u64,
    },
    /// One homogeneous dense or explicitly strided array.
    DenseArray {
        /// Byte offset from the beginning of the backing resource.
        byte_offset: u64,
        /// Exact byte window occupied by this array.
        byte_length: u64,
        /// Scalar storage type.
        element_type: ArtifactElementType,
        /// Logical array dimensions.
        shape: Vec<u64>,
        /// Scalar byte order.
        endianness: ArtifactEndianness,
        /// Optional byte stride per dimension. Absence means compact row-major storage.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        byte_strides: Option<Vec<u64>>,
        /// Optional component-wise affine decode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decode: Option<ArtifactAffineDecode>,
    },
    /// Fixed-stride records split into independently encoded physical chunks.
    InterleavedRecords {
        /// Decoded bytes occupied by one record.
        record_stride: u64,
        /// Typed fields inside every decoded record.
        fields: Vec<InterleavedArtifactField>,
        /// Independently addressable chunks in the backing artifact.
        chunks: Vec<ArtifactRecordChunk>,
    },
}

/// One typed physical interpretation bound to an exact immutable resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypedArtifactDescriptor {
    /// Exact backing resource identity and stored byte length.
    pub resource: GeometryResource,
    /// Stable namespaced role such as `hcad.raster.elevation`.
    pub semantic: String,
    /// Authoritative physical layout.
    pub layout: TypedArtifactLayout,
}

/// Provider-neutral catalog of typed layouts for one prepared dataset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypedArtifactManifest {
    /// Exact manifest schema version.
    pub schema_version: u32,
    /// Layouts keyed by exact resource hash and semantic role.
    pub artifacts: Vec<TypedArtifactDescriptor>,
}

/// Rejection of ambiguous, out-of-bounds or internally inconsistent layout metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TypedArtifactError {
    /// Manifest version, resource identity or semantic identity is invalid.
    #[error("invalid typed artifact identity")]
    Identity,
    /// A byte range exceeds the exact backing resource.
    #[error("typed artifact byte range exceeds its resource")]
    Range,
    /// Shape, stride, scalar type or affine decode metadata is inconsistent.
    #[error("invalid typed artifact array layout")]
    Layout,
    /// Chunk identities or physical ranges overlap.
    #[error("invalid typed artifact chunk topology")]
    Chunk,
}

impl TypedArtifactManifest {
    /// Current immutable typed-artifact schema.
    pub const SCHEMA_VERSION: u32 = 1;

    /// Validates every resource, range, shape, stride and decode without inspecting media types.
    pub fn validate(&self) -> Result<(), TypedArtifactError> {
        if self.schema_version != Self::SCHEMA_VERSION || self.artifacts.is_empty() {
            return Err(TypedArtifactError::Identity);
        }
        let mut identities = BTreeSet::new();
        for artifact in &self.artifacts {
            validate_resource(&artifact.resource)?;
            if !valid_semantic(&artifact.semantic)
                || !identities.insert((
                    artifact.resource.object_hash.0.as_str(),
                    artifact.semantic.as_str(),
                ))
            {
                return Err(TypedArtifactError::Identity);
            }
            artifact.layout.validate(&artifact.resource)?;
        }
        Ok(())
    }
}

impl TypedArtifactLayout {
    /// Validates this layout against the exact backing resource length.
    pub fn validate(&self, resource: &GeometryResource) -> Result<(), TypedArtifactError> {
        let resource_length = resource.byte_length.ok_or(TypedArtifactError::Identity)?;
        match self {
            Self::OpaqueBytes {
                byte_offset,
                byte_length,
            } => validate_range(*byte_offset, *byte_length, resource_length),
            Self::DenseArray {
                byte_offset,
                byte_length,
                element_type,
                shape,
                endianness,
                byte_strides,
                decode,
            } => {
                validate_range(*byte_offset, *byte_length, resource_length)?;
                validate_array(
                    *byte_length,
                    *element_type,
                    shape,
                    *endianness,
                    byte_strides.as_deref(),
                    decode.as_ref(),
                )
            }
            Self::InterleavedRecords {
                record_stride,
                fields,
                chunks,
            } => validate_interleaved(resource_length, *record_stride, fields, chunks),
        }
    }
}

fn validate_resource(resource: &GeometryResource) -> Result<(), TypedArtifactError> {
    let hash = resource.object_hash.as_str();
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || resource.media_type.trim().is_empty()
        || resource.byte_length.is_none_or(|length| length == 0)
    {
        return Err(TypedArtifactError::Identity);
    }
    Ok(())
}

fn valid_semantic(value: &str) -> bool {
    !value.trim().is_empty() && value.contains('.') && !value.chars().any(char::is_whitespace)
}

fn validate_range(
    offset: u64,
    length: u64,
    resource_length: u64,
) -> Result<(), TypedArtifactError> {
    if length == 0
        || offset
            .checked_add(length)
            .is_none_or(|end| end > resource_length)
    {
        return Err(TypedArtifactError::Range);
    }
    Ok(())
}

fn validate_array(
    byte_length: u64,
    element_type: ArtifactElementType,
    shape: &[u64],
    endianness: ArtifactEndianness,
    byte_strides: Option<&[u64]>,
    decode: Option<&ArtifactAffineDecode>,
) -> Result<(), TypedArtifactError> {
    if shape.is_empty()
        || shape.contains(&0)
        || (element_type.byte_width() == 1) != (endianness == ArtifactEndianness::NotApplicable)
    {
        return Err(TypedArtifactError::Layout);
    }
    let span = if let Some(strides) = byte_strides {
        if strides.len() != shape.len() || strides.contains(&0) {
            return Err(TypedArtifactError::Layout);
        }
        shape
            .iter()
            .zip(strides)
            .try_fold(element_type.byte_width(), |span, (dimension, stride)| {
                dimension
                    .checked_sub(1)
                    .and_then(|extent| extent.checked_mul(*stride))
                    .and_then(|extent| span.checked_add(extent))
            })
            .ok_or(TypedArtifactError::Layout)?
    } else {
        shape
            .iter()
            .try_fold(element_type.byte_width(), |bytes, dimension| {
                bytes.checked_mul(*dimension)
            })
            .ok_or(TypedArtifactError::Layout)?
    };
    if span > byte_length {
        return Err(TypedArtifactError::Layout);
    }
    if byte_strides.is_none() && span != byte_length {
        return Err(TypedArtifactError::Layout);
    }
    validate_decode(shape, decode)
}

fn validate_decode(
    shape: &[u64],
    decode: Option<&ArtifactAffineDecode>,
) -> Result<(), TypedArtifactError> {
    let Some(decode) = decode else {
        return Ok(());
    };
    let components = usize::try_from(*shape.last().ok_or(TypedArtifactError::Layout)?)
        .map_err(|_| TypedArtifactError::Layout)?;
    if decode.scale.len() != components
        || decode.offset.len() != components
        || decode.scale.iter().any(|value| !value.is_finite())
        || decode.offset.iter().any(|value| !value.is_finite())
    {
        return Err(TypedArtifactError::Layout);
    }
    Ok(())
}

fn validate_interleaved(
    resource_length: u64,
    record_stride: u64,
    fields: &[InterleavedArtifactField],
    chunks: &[ArtifactRecordChunk],
) -> Result<(), TypedArtifactError> {
    if record_stride == 0 || fields.is_empty() || chunks.is_empty() {
        return Err(TypedArtifactError::Layout);
    }
    let mut field_names = BTreeSet::new();
    for field in fields {
        if field.name.trim().is_empty()
            || !valid_semantic(&field.semantic)
            || !field_names.insert(field.name.as_str())
        {
            return Err(TypedArtifactError::Identity);
        }
        let field_length = array_span(
            field.element_type,
            &field.shape,
            field.byte_strides.as_deref(),
        )?;
        validate_array(
            field_length,
            field.element_type,
            &field.shape,
            field.endianness,
            field.byte_strides.as_deref(),
            field.decode.as_ref(),
        )?;
        if field
            .byte_offset
            .checked_add(field_length)
            .is_none_or(|end| end > record_stride)
        {
            return Err(TypedArtifactError::Layout);
        }
    }
    let mut chunk_ids = BTreeSet::new();
    let mut ranges = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if chunk.id.trim().is_empty()
            || chunk.record_count == 0
            || !chunk_ids.insert(chunk.id.as_str())
        {
            return Err(TypedArtifactError::Chunk);
        }
        validate_range(chunk.byte_offset, chunk.byte_length, resource_length)?;
        if chunk.encoding == ArtifactChunkEncoding::Raw
            && chunk
                .record_count
                .checked_mul(record_stride)
                .is_none_or(|length| length != chunk.byte_length)
        {
            return Err(TypedArtifactError::Chunk);
        }
        ranges.push((chunk.byte_offset, chunk.byte_offset + chunk.byte_length));
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(TypedArtifactError::Chunk);
    }
    Ok(())
}

fn array_span(
    element_type: ArtifactElementType,
    shape: &[u64],
    byte_strides: Option<&[u64]>,
) -> Result<u64, TypedArtifactError> {
    if shape.is_empty() || shape.contains(&0) {
        return Err(TypedArtifactError::Layout);
    }
    if let Some(strides) = byte_strides {
        if strides.len() != shape.len() || strides.contains(&0) {
            return Err(TypedArtifactError::Layout);
        }
        return shape
            .iter()
            .zip(strides)
            .try_fold(element_type.byte_width(), |span, (dimension, stride)| {
                dimension
                    .checked_sub(1)
                    .and_then(|extent| extent.checked_mul(*stride))
                    .and_then(|extent| span.checked_add(extent))
            })
            .ok_or(TypedArtifactError::Layout);
    }
    shape
        .iter()
        .try_fold(element_type.byte_width(), |bytes, dimension| {
            bytes.checked_mul(*dimension)
        })
        .ok_or(TypedArtifactError::Layout)
}

#[cfg(test)]
mod tests {
    use crate::geometry_representation_registry::{
        SectionIndexComponentType, SectionPositionComponentType, SectionTopologyPartitionManifest,
    };
    use crate::hash::ObjectHash;

    use super::*;

    fn resource(length: u64) -> GeometryResource {
        GeometryResource {
            object_hash: ObjectHash::of_bytes(b"typed-artifact"),
            media_type: "application/octet-stream".to_owned(),
            byte_length: Some(length),
        }
    }

    fn named_resource(name: &[u8], length: u64) -> GeometryResource {
        GeometryResource {
            object_hash: ObjectHash::of_bytes(name),
            media_type: "application/octet-stream".to_owned(),
            byte_length: Some(length),
        }
    }

    #[test]
    fn validates_dense_affine_array_without_media_inference() {
        let manifest = TypedArtifactManifest {
            schema_version: TypedArtifactManifest::SCHEMA_VERSION,
            artifacts: vec![TypedArtifactDescriptor {
                resource: resource(96),
                semantic: "hcad.mesh.positions".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: 96,
                    element_type: ArtifactElementType::Float64,
                    shape: vec![4, 3],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: Some(ArtifactAffineDecode {
                        scale: vec![1.0; 3],
                        offset: vec![10.0, 20.0, 30.0],
                    }),
                },
            }],
        };
        assert_eq!(manifest.validate(), Ok(()));
    }

    #[test]
    fn validates_raw_and_brotli_interleaved_chunks() {
        let manifest = TypedArtifactManifest {
            schema_version: TypedArtifactManifest::SCHEMA_VERSION,
            artifacts: vec![TypedArtifactDescriptor {
                resource: resource(160),
                semantic: "hcad.pointcloud.records".to_owned(),
                layout: TypedArtifactLayout::InterleavedRecords {
                    record_stride: 16,
                    fields: vec![InterleavedArtifactField {
                        name: "position".to_owned(),
                        semantic: "hcad.point.position".to_owned(),
                        byte_offset: 0,
                        element_type: ArtifactElementType::Int32,
                        shape: vec![3],
                        endianness: ArtifactEndianness::Little,
                        byte_strides: None,
                        decode: Some(ArtifactAffineDecode {
                            scale: vec![0.001; 3],
                            offset: vec![1.0, 2.0, 3.0],
                        }),
                    }],
                    chunks: vec![
                        ArtifactRecordChunk {
                            id: "r".to_owned(),
                            byte_offset: 0,
                            byte_length: 80,
                            record_count: 5,
                            encoding: ArtifactChunkEncoding::Raw,
                        },
                        ArtifactRecordChunk {
                            id: "r0".to_owned(),
                            byte_offset: 80,
                            byte_length: 40,
                            record_count: 5,
                            encoding: ArtifactChunkEncoding::Brotli,
                        },
                    ],
                },
            }],
        };
        assert_eq!(manifest.validate(), Ok(()));
    }

    #[test]
    fn rejects_overlapping_chunks_and_fake_dense_shapes() {
        let mut manifest = TypedArtifactManifest {
            schema_version: TypedArtifactManifest::SCHEMA_VERSION,
            artifacts: vec![TypedArtifactDescriptor {
                resource: resource(64),
                semantic: "hcad.pointcloud.records".to_owned(),
                layout: TypedArtifactLayout::InterleavedRecords {
                    record_stride: 4,
                    fields: vec![InterleavedArtifactField {
                        name: "value".to_owned(),
                        semantic: "hcad.point.value".to_owned(),
                        byte_offset: 0,
                        element_type: ArtifactElementType::Uint32,
                        shape: vec![1],
                        endianness: ArtifactEndianness::Little,
                        byte_strides: None,
                        decode: None,
                    }],
                    chunks: vec![
                        ArtifactRecordChunk {
                            id: "a".to_owned(),
                            byte_offset: 0,
                            byte_length: 16,
                            record_count: 4,
                            encoding: ArtifactChunkEncoding::Raw,
                        },
                        ArtifactRecordChunk {
                            id: "b".to_owned(),
                            byte_offset: 8,
                            byte_length: 16,
                            record_count: 4,
                            encoding: ArtifactChunkEncoding::Raw,
                        },
                    ],
                },
            }],
        };
        assert_eq!(manifest.validate(), Err(TypedArtifactError::Chunk));

        manifest.artifacts[0].layout = TypedArtifactLayout::DenseArray {
            byte_offset: 0,
            byte_length: 64,
            element_type: ArtifactElementType::Float64,
            shape: vec![99, 3],
            endianness: ArtifactEndianness::Little,
            byte_strides: None,
            decode: None,
        };
        assert_eq!(manifest.validate(), Err(TypedArtifactError::Layout));
    }

    #[test]
    fn section_topology_maps_to_dense_position_index_and_material_arrays() {
        let topology = SectionTopologyPartitionManifest {
            schema_version: SectionTopologyPartitionManifest::SCHEMA_VERSION,
            origin: [100.0, 200.0, 300.0],
            positions: named_resource(b"positions", 24),
            position_component_type: SectionPositionComponentType::Float32,
            vertex_count: 2,
            indices: named_resource(b"indices", 6),
            index_component_type: SectionIndexComponentType::Uint16,
            index_count: 3,
            material_slots: Some(named_resource(b"materials", 4)),
        };
        let descriptors = topology
            .typed_artifact_descriptors()
            .expect("typed topology");
        assert_eq!(descriptors.len(), 3);
        assert!(matches!(
            &descriptors[0].layout,
            TypedArtifactLayout::DenseArray {
                element_type: ArtifactElementType::Float32,
                shape,
                decode: Some(ArtifactAffineDecode { offset, .. }),
                ..
            } if shape == &[2, 3] && offset == &[100.0, 200.0, 300.0]
        ));
        assert!(matches!(
            &descriptors[1].layout,
            TypedArtifactLayout::DenseArray {
                element_type: ArtifactElementType::Uint16,
                shape,
                ..
            } if shape == &[3]
        ));
        assert!(matches!(
            &descriptors[2].layout,
            TypedArtifactLayout::DenseArray {
                element_type: ArtifactElementType::Uint32,
                shape,
                ..
            } if shape == &[1]
        ));
    }
}
