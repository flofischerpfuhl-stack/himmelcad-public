//! Bincode-safe wire mirrors for decoded payload fields containing `serde_json::Value`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    DecodedBatchedModel, DecodedElevationRaster, DecodedFeatureIdBinding, DecodedFeatureImage,
    DecodedGaussianSplats, DecodedGlb, DecodedImage, DecodedInstancedModel, DecodedLegacyBatchIds,
    DecodedLegacyBatchTableHierarchy, DecodedMaterial, DecodedMeshFeatureSet, DecodedMeshInstance,
    DecodedMeshPrimitive, DecodedMeshVertex, DecodedPointTile, DecodedPotreePoints,
    DecodedPrimitivePropertyAttribute, DecodedPrimitivePropertyTexture,
    DecodedPropertyAttributeProperty, DecodedPropertyTextureProperty, DecodedStructuralMetadata,
    DecodedTextureWrap, DecodedThreeDTilesContent, DecodedTriangleFeatureId, WorldVec3,
};

use super::streaming_decode_artifact::DecodedStreamingPayload;

#[derive(Debug, Serialize, Deserialize)]
pub(super) enum WireDecodedStreamingPayload {
    ThreeDTiles(WireThreeDTilesContent),
    Potree(DecodedPotreePoints),
    GaussianSplats(DecodedGaussianSplats),
    Raster(DecodedElevationRaster),
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) enum WireThreeDTilesContent {
    Mesh(WireBatchedModel),
    Points(WirePointTile),
    InstancedMesh(WireInstancedModel),
    Composite(Vec<WireThreeDTilesContent>),
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct WireBatchedModel {
    glb: WireGlb,
    batch_length: u32,
    feature_id: Option<u32>,
    batch_table_json: Option<JsonBytes>,
    batch_table_binary: Vec<u8>,
    batch_table_hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct WireInstancedModel {
    glb: WireGlb,
    instances: Vec<DecodedMeshInstance>,
    batch_length: u32,
    batch_table_json: Option<JsonBytes>,
    batch_table_binary: Vec<u8>,
    batch_table_hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct WirePointTile {
    points: DecodedPotreePoints,
    batch_ids: Option<Vec<u32>>,
    batch_length: u32,
    batch_table_json: Option<JsonBytes>,
    batch_table_binary: Vec<u8>,
    batch_table_hierarchy: Option<DecodedLegacyBatchTableHierarchy>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WireGlb {
    world_origin: WorldVec3,
    primitives: Vec<WireMeshPrimitive>,
    images: Vec<DecodedImage>,
    feature_images: BTreeMap<usize, DecodedFeatureImage>,
    structural_metadata: Option<WireStructuralMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WireMeshPrimitive {
    exact_positions: Vec<WorldVec3>,
    vertices: Vec<DecodedMeshVertex>,
    has_texture_coordinates: bool,
    indices: Vec<u32>,
    material: DecodedMaterial,
    features: Vec<WireMeshFeatureSet>,
    legacy_batch_ids: Option<DecodedLegacyBatchIds>,
    property_attributes: Vec<WirePrimitivePropertyAttribute>,
    property_textures: Vec<WirePrimitivePropertyTexture>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WireStructuralMetadata {
    schema: Option<JsonBytes>,
    schema_uri: Option<String>,
    property_tables: Vec<JsonBytes>,
    property_textures: Vec<JsonBytes>,
    property_attributes: Vec<JsonBytes>,
    property_table_buffer_views: BTreeMap<usize, Vec<u8>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WireMeshFeatureSet {
    feature_count: u32,
    label: Option<String>,
    null_feature_id: Option<u32>,
    property_table: Option<usize>,
    binding: WireFeatureIdBinding,
    triangle_vertex_ids: Vec<[u32; 3]>,
    triangle_ids: Vec<DecodedTriangleFeatureId>,
}

#[derive(Debug, Serialize, Deserialize)]
enum WireFeatureIdBinding {
    Implicit {
        vertex_ids: Vec<u32>,
    },
    Attribute {
        attribute: u32,
        vertex_ids: Vec<u32>,
    },
    Texture {
        descriptor: JsonBytes,
        image_index: usize,
        channels: Vec<u8>,
        triangle_tex_coords: Vec<[[f32; 2]; 3]>,
        wrap_s: DecodedTextureWrap,
        wrap_t: DecodedTextureWrap,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct WirePrimitivePropertyTexture {
    definition_index: usize,
    class_name: String,
    definition: JsonBytes,
    properties: BTreeMap<String, WirePropertyTextureProperty>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WirePropertyTextureProperty {
    descriptor: JsonBytes,
    image_index: usize,
    channels: Vec<u8>,
    triangle_tex_coords: Vec<[[f32; 2]; 3]>,
    wrap_s: DecodedTextureWrap,
    wrap_t: DecodedTextureWrap,
    class_property: JsonBytes,
    enum_definition: Option<JsonBytes>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WirePrimitivePropertyAttribute {
    definition_index: usize,
    class_name: String,
    definition: JsonBytes,
    properties: BTreeMap<String, WirePropertyAttributeProperty>,
    triangle_vertex_indices: Vec<[u32; 3]>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WirePropertyAttributeProperty {
    attribute: String,
    vertex_values: Vec<JsonBytes>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonBytes(Vec<u8>);

impl TryFrom<DecodedStreamingPayload> for WireDecodedStreamingPayload {
    type Error = String;

    fn try_from(payload: DecodedStreamingPayload) -> Result<Self, Self::Error> {
        Ok(match payload {
            DecodedStreamingPayload::ThreeDTiles(content) => Self::ThreeDTiles(content.try_into()?),
            DecodedStreamingPayload::Potree(points) => Self::Potree(points),
            DecodedStreamingPayload::GaussianSplats(splats) => Self::GaussianSplats(splats),
            DecodedStreamingPayload::Raster(raster) => Self::Raster(raster),
        })
    }
}

impl TryFrom<WireDecodedStreamingPayload> for DecodedStreamingPayload {
    type Error = String;

    fn try_from(payload: WireDecodedStreamingPayload) -> Result<Self, Self::Error> {
        Ok(match payload {
            WireDecodedStreamingPayload::ThreeDTiles(content) => {
                Self::ThreeDTiles(content.try_into()?)
            }
            WireDecodedStreamingPayload::Potree(points) => Self::Potree(points),
            WireDecodedStreamingPayload::GaussianSplats(splats) => Self::GaussianSplats(splats),
            WireDecodedStreamingPayload::Raster(raster) => Self::Raster(raster),
        })
    }
}

impl TryFrom<DecodedThreeDTilesContent> for WireThreeDTilesContent {
    type Error = String;

    fn try_from(content: DecodedThreeDTilesContent) -> Result<Self, Self::Error> {
        Ok(match content {
            DecodedThreeDTilesContent::Mesh(model) => Self::Mesh(model.try_into()?),
            DecodedThreeDTilesContent::Points(points) => Self::Points(points.try_into()?),
            DecodedThreeDTilesContent::InstancedMesh(model) => {
                Self::InstancedMesh(model.try_into()?)
            }
            DecodedThreeDTilesContent::Composite(children) => Self::Composite(
                children
                    .into_iter()
                    .map(TryInto::try_into)
                    .collect::<Result<_, _>>()?,
            ),
        })
    }
}

impl TryFrom<WireThreeDTilesContent> for DecodedThreeDTilesContent {
    type Error = String;

    fn try_from(content: WireThreeDTilesContent) -> Result<Self, Self::Error> {
        Ok(match content {
            WireThreeDTilesContent::Mesh(model) => Self::Mesh(model.try_into()?),
            WireThreeDTilesContent::Points(points) => Self::Points(points.try_into()?),
            WireThreeDTilesContent::InstancedMesh(model) => Self::InstancedMesh(model.try_into()?),
            WireThreeDTilesContent::Composite(children) => Self::Composite(
                children
                    .into_iter()
                    .map(TryInto::try_into)
                    .collect::<Result<_, _>>()?,
            ),
        })
    }
}

impl TryFrom<DecodedBatchedModel> for WireBatchedModel {
    type Error = String;

    fn try_from(model: DecodedBatchedModel) -> Result<Self, Self::Error> {
        Ok(Self {
            glb: model.glb.try_into()?,
            batch_length: model.batch_length,
            feature_id: model.feature_id,
            batch_table_json: encode_optional_json(model.batch_table_json)?,
            batch_table_binary: model.batch_table_binary,
            batch_table_hierarchy: model.batch_table_hierarchy,
        })
    }
}

impl TryFrom<WireBatchedModel> for DecodedBatchedModel {
    type Error = String;

    fn try_from(model: WireBatchedModel) -> Result<Self, Self::Error> {
        Ok(Self {
            glb: model.glb.try_into()?,
            batch_length: model.batch_length,
            feature_id: model.feature_id,
            batch_table_json: decode_optional_json(model.batch_table_json)?,
            batch_table_binary: model.batch_table_binary,
            batch_table_hierarchy: model.batch_table_hierarchy,
        })
    }
}

impl TryFrom<DecodedInstancedModel> for WireInstancedModel {
    type Error = String;

    fn try_from(model: DecodedInstancedModel) -> Result<Self, Self::Error> {
        Ok(Self {
            glb: model.glb.try_into()?,
            instances: model.instances,
            batch_length: model.batch_length,
            batch_table_json: encode_optional_json(model.batch_table_json)?,
            batch_table_binary: model.batch_table_binary,
            batch_table_hierarchy: model.batch_table_hierarchy,
        })
    }
}

impl TryFrom<WireInstancedModel> for DecodedInstancedModel {
    type Error = String;

    fn try_from(model: WireInstancedModel) -> Result<Self, Self::Error> {
        Ok(Self {
            glb: model.glb.try_into()?,
            instances: model.instances,
            batch_length: model.batch_length,
            batch_table_json: decode_optional_json(model.batch_table_json)?,
            batch_table_binary: model.batch_table_binary,
            batch_table_hierarchy: model.batch_table_hierarchy,
        })
    }
}

impl TryFrom<DecodedPointTile> for WirePointTile {
    type Error = String;

    fn try_from(points: DecodedPointTile) -> Result<Self, Self::Error> {
        Ok(Self {
            points: points.points,
            batch_ids: points.batch_ids,
            batch_length: points.batch_length,
            batch_table_json: encode_optional_json(points.batch_table_json)?,
            batch_table_binary: points.batch_table_binary,
            batch_table_hierarchy: points.batch_table_hierarchy,
        })
    }
}

impl TryFrom<WirePointTile> for DecodedPointTile {
    type Error = String;

    fn try_from(points: WirePointTile) -> Result<Self, Self::Error> {
        Ok(Self {
            points: points.points,
            batch_ids: points.batch_ids,
            batch_length: points.batch_length,
            batch_table_json: decode_optional_json(points.batch_table_json)?,
            batch_table_binary: points.batch_table_binary,
            batch_table_hierarchy: points.batch_table_hierarchy,
        })
    }
}

impl TryFrom<DecodedGlb> for WireGlb {
    type Error = String;

    fn try_from(glb: DecodedGlb) -> Result<Self, Self::Error> {
        Ok(Self {
            world_origin: glb.world_origin,
            primitives: glb
                .primitives
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            images: glb.images,
            feature_images: glb.feature_images,
            structural_metadata: glb.structural_metadata.map(TryInto::try_into).transpose()?,
        })
    }
}

impl TryFrom<WireGlb> for DecodedGlb {
    type Error = String;

    fn try_from(glb: WireGlb) -> Result<Self, Self::Error> {
        Ok(Self {
            world_origin: glb.world_origin,
            primitives: glb
                .primitives
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            images: glb.images,
            feature_images: glb.feature_images,
            structural_metadata: glb.structural_metadata.map(TryInto::try_into).transpose()?,
        })
    }
}

impl TryFrom<DecodedMeshPrimitive> for WireMeshPrimitive {
    type Error = String;

    fn try_from(primitive: DecodedMeshPrimitive) -> Result<Self, Self::Error> {
        Ok(Self {
            exact_positions: primitive.exact_positions,
            vertices: primitive.vertices,
            has_texture_coordinates: primitive.has_texture_coordinates,
            indices: primitive.indices,
            material: primitive.material,
            features: primitive
                .features
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            legacy_batch_ids: primitive.legacy_batch_ids,
            property_attributes: primitive
                .property_attributes
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            property_textures: primitive
                .property_textures
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
        })
    }
}

impl TryFrom<WireMeshPrimitive> for DecodedMeshPrimitive {
    type Error = String;

    fn try_from(primitive: WireMeshPrimitive) -> Result<Self, Self::Error> {
        Ok(Self {
            exact_positions: primitive.exact_positions,
            vertices: primitive.vertices,
            has_texture_coordinates: primitive.has_texture_coordinates,
            indices: primitive.indices,
            material: primitive.material,
            features: primitive
                .features
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            legacy_batch_ids: primitive.legacy_batch_ids,
            property_attributes: primitive
                .property_attributes
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            property_textures: primitive
                .property_textures
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
        })
    }
}

impl TryFrom<DecodedStructuralMetadata> for WireStructuralMetadata {
    type Error = String;

    fn try_from(metadata: DecodedStructuralMetadata) -> Result<Self, Self::Error> {
        Ok(Self {
            schema: encode_optional_json(metadata.schema)?,
            schema_uri: metadata.schema_uri,
            property_tables: encode_json_values(metadata.property_tables)?,
            property_textures: encode_json_values(metadata.property_textures)?,
            property_attributes: encode_json_values(metadata.property_attributes)?,
            property_table_buffer_views: metadata.property_table_buffer_views,
        })
    }
}

impl TryFrom<WireStructuralMetadata> for DecodedStructuralMetadata {
    type Error = String;

    fn try_from(metadata: WireStructuralMetadata) -> Result<Self, Self::Error> {
        Ok(Self {
            schema: decode_optional_json(metadata.schema)?,
            schema_uri: metadata.schema_uri,
            property_tables: decode_json_values(metadata.property_tables)?,
            property_textures: decode_json_values(metadata.property_textures)?,
            property_attributes: decode_json_values(metadata.property_attributes)?,
            property_table_buffer_views: metadata.property_table_buffer_views,
        })
    }
}

impl TryFrom<DecodedMeshFeatureSet> for WireMeshFeatureSet {
    type Error = String;

    fn try_from(feature: DecodedMeshFeatureSet) -> Result<Self, Self::Error> {
        Ok(Self {
            feature_count: feature.feature_count,
            label: feature.label,
            null_feature_id: feature.null_feature_id,
            property_table: feature.property_table,
            binding: feature.binding.try_into()?,
            triangle_vertex_ids: feature.triangle_vertex_ids,
            triangle_ids: feature.triangle_ids,
        })
    }
}

impl TryFrom<WireMeshFeatureSet> for DecodedMeshFeatureSet {
    type Error = String;

    fn try_from(feature: WireMeshFeatureSet) -> Result<Self, Self::Error> {
        Ok(Self {
            feature_count: feature.feature_count,
            label: feature.label,
            null_feature_id: feature.null_feature_id,
            property_table: feature.property_table,
            binding: feature.binding.try_into()?,
            triangle_vertex_ids: feature.triangle_vertex_ids,
            triangle_ids: feature.triangle_ids,
        })
    }
}

impl TryFrom<DecodedFeatureIdBinding> for WireFeatureIdBinding {
    type Error = String;

    fn try_from(binding: DecodedFeatureIdBinding) -> Result<Self, Self::Error> {
        Ok(match binding {
            DecodedFeatureIdBinding::Implicit { vertex_ids } => Self::Implicit { vertex_ids },
            DecodedFeatureIdBinding::Attribute {
                attribute,
                vertex_ids,
            } => Self::Attribute {
                attribute,
                vertex_ids,
            },
            DecodedFeatureIdBinding::Texture {
                descriptor,
                image_index,
                channels,
                triangle_tex_coords,
                wrap_s,
                wrap_t,
            } => Self::Texture {
                descriptor: encode_json(descriptor)?,
                image_index,
                channels,
                triangle_tex_coords,
                wrap_s,
                wrap_t,
            },
        })
    }
}

impl TryFrom<WireFeatureIdBinding> for DecodedFeatureIdBinding {
    type Error = String;

    fn try_from(binding: WireFeatureIdBinding) -> Result<Self, Self::Error> {
        Ok(match binding {
            WireFeatureIdBinding::Implicit { vertex_ids } => Self::Implicit { vertex_ids },
            WireFeatureIdBinding::Attribute {
                attribute,
                vertex_ids,
            } => Self::Attribute {
                attribute,
                vertex_ids,
            },
            WireFeatureIdBinding::Texture {
                descriptor,
                image_index,
                channels,
                triangle_tex_coords,
                wrap_s,
                wrap_t,
            } => Self::Texture {
                descriptor: decode_json(descriptor)?,
                image_index,
                channels,
                triangle_tex_coords,
                wrap_s,
                wrap_t,
            },
        })
    }
}

impl TryFrom<DecodedPrimitivePropertyTexture> for WirePrimitivePropertyTexture {
    type Error = String;

    fn try_from(texture: DecodedPrimitivePropertyTexture) -> Result<Self, Self::Error> {
        Ok(Self {
            definition_index: texture.definition_index,
            class_name: texture.class_name,
            definition: encode_json(texture.definition)?,
            properties: texture
                .properties
                .into_iter()
                .map(|(name, property)| Ok((name, property.try_into()?)))
                .collect::<Result<_, String>>()?,
        })
    }
}

impl TryFrom<WirePrimitivePropertyTexture> for DecodedPrimitivePropertyTexture {
    type Error = String;

    fn try_from(texture: WirePrimitivePropertyTexture) -> Result<Self, Self::Error> {
        Ok(Self {
            definition_index: texture.definition_index,
            class_name: texture.class_name,
            definition: decode_json(texture.definition)?,
            properties: texture
                .properties
                .into_iter()
                .map(|(name, property)| Ok((name, property.try_into()?)))
                .collect::<Result<_, String>>()?,
        })
    }
}

impl TryFrom<DecodedPropertyTextureProperty> for WirePropertyTextureProperty {
    type Error = String;

    fn try_from(property: DecodedPropertyTextureProperty) -> Result<Self, Self::Error> {
        Ok(Self {
            descriptor: encode_json(property.descriptor)?,
            image_index: property.image_index,
            channels: property.channels,
            triangle_tex_coords: property.triangle_tex_coords,
            wrap_s: property.wrap_s,
            wrap_t: property.wrap_t,
            class_property: encode_json(property.class_property)?,
            enum_definition: encode_optional_json(property.enum_definition)?,
        })
    }
}

impl TryFrom<WirePropertyTextureProperty> for DecodedPropertyTextureProperty {
    type Error = String;

    fn try_from(property: WirePropertyTextureProperty) -> Result<Self, Self::Error> {
        Ok(Self {
            descriptor: decode_json(property.descriptor)?,
            image_index: property.image_index,
            channels: property.channels,
            triangle_tex_coords: property.triangle_tex_coords,
            wrap_s: property.wrap_s,
            wrap_t: property.wrap_t,
            class_property: decode_json(property.class_property)?,
            enum_definition: decode_optional_json(property.enum_definition)?,
        })
    }
}

impl TryFrom<DecodedPrimitivePropertyAttribute> for WirePrimitivePropertyAttribute {
    type Error = String;

    fn try_from(attribute: DecodedPrimitivePropertyAttribute) -> Result<Self, Self::Error> {
        Ok(Self {
            definition_index: attribute.definition_index,
            class_name: attribute.class_name,
            definition: encode_json(attribute.definition)?,
            properties: attribute
                .properties
                .into_iter()
                .map(|(name, property)| Ok((name, property.try_into()?)))
                .collect::<Result<_, String>>()?,
            triangle_vertex_indices: attribute.triangle_vertex_indices,
        })
    }
}

impl TryFrom<WirePrimitivePropertyAttribute> for DecodedPrimitivePropertyAttribute {
    type Error = String;

    fn try_from(attribute: WirePrimitivePropertyAttribute) -> Result<Self, Self::Error> {
        Ok(Self {
            definition_index: attribute.definition_index,
            class_name: attribute.class_name,
            definition: decode_json(attribute.definition)?,
            properties: attribute
                .properties
                .into_iter()
                .map(|(name, property)| Ok((name, property.try_into()?)))
                .collect::<Result<_, String>>()?,
            triangle_vertex_indices: attribute.triangle_vertex_indices,
        })
    }
}

impl TryFrom<DecodedPropertyAttributeProperty> for WirePropertyAttributeProperty {
    type Error = String;

    fn try_from(property: DecodedPropertyAttributeProperty) -> Result<Self, Self::Error> {
        Ok(Self {
            attribute: property.attribute,
            vertex_values: encode_json_values(property.vertex_values)?,
        })
    }
}

impl TryFrom<WirePropertyAttributeProperty> for DecodedPropertyAttributeProperty {
    type Error = String;

    fn try_from(property: WirePropertyAttributeProperty) -> Result<Self, Self::Error> {
        Ok(Self {
            attribute: property.attribute,
            vertex_values: decode_json_values(property.vertex_values)?,
        })
    }
}

fn encode_json(value: serde_json::Value) -> Result<JsonBytes, String> {
    serde_json::to_vec(&value)
        .map(JsonBytes)
        .map_err(|error| format!("decode artifact metadata JSON encode failed: {error}"))
}

fn decode_json(value: JsonBytes) -> Result<serde_json::Value, String> {
    serde_json::from_slice(&value.0)
        .map_err(|error| format!("decode artifact metadata JSON decode failed: {error}"))
}

fn encode_optional_json(value: Option<serde_json::Value>) -> Result<Option<JsonBytes>, String> {
    value.map(encode_json).transpose()
}

fn decode_optional_json(value: Option<JsonBytes>) -> Result<Option<serde_json::Value>, String> {
    value.map(decode_json).transpose()
}

fn encode_json_values(values: Vec<serde_json::Value>) -> Result<Vec<JsonBytes>, String> {
    values.into_iter().map(encode_json).collect()
}

fn decode_json_values(values: Vec<JsonBytes>) -> Result<Vec<serde_json::Value>, String> {
    values.into_iter().map(decode_json).collect()
}
