//! Validated feature identity and structural-metadata bindings for glTF 2.0.

use std::collections::{BTreeMap, BTreeSet};

use gltf::accessor::{DataType, Dimensions, Iter};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::gltf_content::GlbDecodeError;

const MESH_FEATURES: &str = "EXT_mesh_features";
const STRUCTURAL_METADATA: &str = "EXT_structural_metadata";

/// Top-level structural metadata retained independently of its UI presentation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedStructuralMetadata {
    /// Embedded metadata schema.
    pub schema: Option<Value>,
    /// Unresolved external schema URI declared by the glTF content.
    pub schema_uri: Option<String>,
    /// Binary property-table definitions in table-index order.
    pub property_tables: Vec<Value>,
    /// Image-backed property definitions in texture-index order.
    pub property_textures: Vec<Value>,
    /// Vertex-backed property definitions in attribute-index order.
    pub property_attributes: Vec<Value>,
    /// Exact bytes of only the buffer views referenced by property tables.
    pub property_table_buffer_views: BTreeMap<usize, Vec<u8>>,
}

impl DecodedStructuralMetadata {
    /// Decodes one property-table row without expanding the full binary table.
    /// Integer values that cannot round-trip through JavaScript are emitted as
    /// tagged decimal strings.
    pub fn property_table_row(
        &self,
        table_index: usize,
        feature_id: u32,
    ) -> Result<Value, GlbDecodeError> {
        let table = self
            .property_tables
            .get(table_index)
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("EXT_structural_metadata property table is missing"))?;
        let count = table
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("EXT_structural_metadata property table count is invalid"))?;
        if u64::from(feature_id) >= count {
            return Err(invalid(
                "EXT_structural_metadata property table row is out of range",
            ));
        }
        let class_name = table
            .get("class")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("EXT_structural_metadata property table class is invalid"))?;
        let class = self
            .schema
            .as_ref()
            .and_then(|schema| schema.get("classes"))
            .and_then(|classes| classes.get(class_name))
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("EXT_structural_metadata embedded class is missing"))?;
        let class_properties = class
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("EXT_structural_metadata class properties are invalid"))?;
        let table_properties = table
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("EXT_structural_metadata table properties are invalid"))?;
        let mut row = serde_json::Map::new();
        for (name, table_property) in table_properties {
            let class_property = class_properties
                .get(name)
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("EXT_structural_metadata class property is missing"))?;
            let table_property = table_property
                .as_object()
                .ok_or_else(|| invalid("EXT_structural_metadata table property is invalid"))?;
            row.insert(
                name.clone(),
                self.decode_property_value(
                    class_property,
                    table_property,
                    usize::try_from(feature_id).expect("u32 fits usize"),
                )?,
            );
        }
        Ok(Value::Object(row))
    }

    fn decode_property_value(
        &self,
        class_property: &serde_json::Map<String, Value>,
        table_property: &serde_json::Map<String, Value>,
        row: usize,
    ) -> Result<Value, GlbDecodeError> {
        let is_array = class_property
            .get("array")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !is_array {
            return self.decode_property_element(class_property, table_property, row);
        }
        let (start, end) = if let Some(count) = class_property
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
        {
            let start = row
                .checked_mul(count)
                .ok_or_else(|| invalid("EXT_structural_metadata fixed array offset overflows"))?;
            let end = start
                .checked_add(count)
                .ok_or_else(|| invalid("EXT_structural_metadata fixed array offset overflows"))?;
            (start, end)
        } else {
            let offsets = self.property_view(table_property, "arrayOffsets")?;
            let offset_type = table_property
                .get("arrayOffsetType")
                .and_then(Value::as_str)
                .unwrap_or("UINT32");
            (
                read_offset(offsets, row, offset_type)?,
                read_offset(offsets, row + 1, offset_type)?,
            )
        };
        if start > end {
            return Err(invalid("EXT_structural_metadata array offsets are invalid"));
        }
        if end - start > crate::decode_limits::MAX_METADATA_ARRAY_ELEMENTS {
            return Err(invalid(
                "EXT_structural_metadata array exceeds the decode budget",
            ));
        }
        Ok(Value::Array(
            (start..end)
                .map(|element| {
                    self.decode_property_element(class_property, table_property, element)
                })
                .collect::<Result<Vec<_>, _>>()?,
        ))
    }

    fn decode_property_element(
        &self,
        class_property: &serde_json::Map<String, Value>,
        table_property: &serde_json::Map<String, Value>,
        element: usize,
    ) -> Result<Value, GlbDecodeError> {
        let property_type = class_property
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("EXT_structural_metadata property type is invalid"))?;
        let values = self.property_view(table_property, "values")?;
        let raw = match property_type {
            "STRING" => {
                let offsets = self.property_view(table_property, "stringOffsets")?;
                let offset_type = table_property
                    .get("stringOffsetType")
                    .and_then(Value::as_str)
                    .unwrap_or("UINT32");
                let start = read_offset(offsets, element, offset_type)?;
                let end = read_offset(offsets, element + 1, offset_type)?;
                if start > end || end > values.len() {
                    return Err(invalid(
                        "EXT_structural_metadata string offsets are invalid",
                    ));
                }
                let value = std::str::from_utf8(&values[start..end])
                    .map_err(|_| invalid("EXT_structural_metadata string is not UTF-8"))?;
                Value::String(value.to_owned())
            }
            "BOOLEAN" => {
                let byte = values
                    .get(element / 8)
                    .ok_or_else(|| invalid("EXT_structural_metadata boolean is out of range"))?;
                Value::Bool(byte & (1 << (element % 8)) != 0)
            }
            "ENUM" => self.decode_enum_value(class_property, values, element)?,
            _ => {
                let component_type = class_property
                    .get("componentType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("EXT_structural_metadata component type is invalid"))?;
                let components = property_type_components(property_type)?;
                let size = component_size(component_type)?;
                let first = element
                    .checked_mul(components)
                    .and_then(|index| index.checked_mul(size))
                    .ok_or_else(|| invalid("EXT_structural_metadata property offset overflows"))?;
                let decoded = (0..components)
                    .map(|component| {
                        decode_component(values, first + component * size, component_type)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if components == 1 {
                    decoded.into_iter().next().expect("one component")
                } else {
                    Value::Array(decoded)
                }
            }
        };
        apply_property_semantics(class_property, table_property, raw)
    }

    fn decode_enum_value(
        &self,
        class_property: &serde_json::Map<String, Value>,
        values: &[u8],
        row: usize,
    ) -> Result<Value, GlbDecodeError> {
        let enum_name = class_property
            .get("enumType")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("EXT_structural_metadata enum type is invalid"))?;
        let definition = self
            .schema
            .as_ref()
            .and_then(|schema| schema.get("enums"))
            .and_then(|enums| enums.get(enum_name))
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("EXT_structural_metadata enum definition is missing"))?;
        let value_type = definition
            .get("valueType")
            .and_then(Value::as_str)
            .unwrap_or("UINT16");
        let enum_value = decode_unsigned_component(
            values,
            row.checked_mul(component_size(value_type)?)
                .ok_or_else(|| invalid("EXT_structural_metadata enum offset overflows"))?,
            value_type,
        )?;
        definition
            .get("values")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.get("value").and_then(Value::as_u64) == Some(enum_value))
            })
            .and_then(|entry| entry.get("name"))
            .and_then(Value::as_str)
            .map(|name| Value::String(name.to_owned()))
            .ok_or_else(|| invalid("EXT_structural_metadata enum value is undefined"))
    }

    fn property_view(
        &self,
        property: &serde_json::Map<String, Value>,
        key: &str,
    ) -> Result<&[u8], GlbDecodeError> {
        let index = property
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .ok_or_else(|| invalid("EXT_structural_metadata property buffer view is invalid"))?;
        self.property_table_buffer_views
            .get(&index)
            .map(Vec::as_slice)
            .ok_or_else(|| invalid("EXT_structural_metadata property buffer view is missing"))
    }
}

/// How one feature ID set is encoded by a mesh primitive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DecodedFeatureIdBinding {
    /// IDs are assigned to vertices by their vertex index.
    Implicit {
        /// Generated ID in source-vertex order.
        vertex_ids: Vec<u32>,
    },
    /// IDs are read from `_FEATURE_ID_n`.
    Attribute {
        /// Numeric suffix of the `_FEATURE_ID_n` semantic.
        attribute: u32,
        /// Decoded unsigned IDs in source-vertex order.
        vertex_ids: Vec<u32>,
    },
    /// IDs are sampled from texture channels at the exact hit coordinate.
    Texture {
        /// Texture index, coordinate set and little-endian channel selection.
        descriptor: Value,
        /// Decoded glTF image index.
        image_index: usize,
        /// Little-endian RGBA channel indices.
        channels: Vec<u8>,
        /// Transformed texture coordinates for each source triangle.
        triangle_tex_coords: Vec<[[f32; 2]; 3]>,
        /// Horizontal sampler wrapping.
        wrap_s: DecodedTextureWrap,
        /// Vertical sampler wrapping.
        wrap_t: DecodedTextureWrap,
    },
}

/// Exact feature-texture wrapping behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecodedTextureWrap {
    /// Clamp normalized coordinates to the edge texel.
    ClampToEdge,
    /// Mirror every second unit interval.
    MirroredRepeat,
    /// Repeat every unit interval.
    Repeat,
}

/// Texture address derived from an exact triangle hit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedFeatureTextureSample {
    /// Image index in [`super::gltf_content::DecodedGlb::images`].
    pub image_index: usize,
    /// Interpolated, transformed texture coordinate.
    pub tex_coord: [f64; 2],
    /// Little-endian RGBA channel indices.
    pub channels: Vec<u8>,
    /// Horizontal wrapping.
    pub wrap_s: DecodedTextureWrap,
    /// Vertical wrapping.
    pub wrap_t: DecodedTextureWrap,
}

/// Texture address and schema semantics for one property at an exact hit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPropertyTextureSample {
    /// Metadata property name.
    pub name: String,
    /// Image index in the decoded glTF.
    pub image_index: usize,
    /// Interpolated, transformed texture coordinate.
    pub tex_coord: [f64; 2],
    /// Ordered RGBA byte channels; order is semantically significant.
    pub channels: Vec<u8>,
    /// Horizontal wrapping.
    pub wrap_s: DecodedTextureWrap,
    /// Vertical wrapping.
    pub wrap_t: DecodedTextureWrap,
    /// Class property schema.
    pub class_property: Value,
    /// Property-texture override definition.
    pub property: Value,
    /// Optional resolved enum definition.
    pub enum_definition: Option<Value>,
}

impl DecodedPropertyTextureSample {
    /// Decodes the selected RGBA8 texel using 3D Metadata raw-value and
    /// transform ordering.
    pub fn decode_texel(&self, texel: [u8; 4]) -> Result<Value, GlbDecodeError> {
        let class_property = self
            .class_property
            .as_object()
            .ok_or_else(|| invalid("property texture class property is invalid"))?;
        let property = self
            .property
            .as_object()
            .ok_or_else(|| invalid("property texture property is invalid"))?;
        let bytes = self
            .channels
            .iter()
            .map(|channel| texel[usize::from(*channel)])
            .collect::<Vec<_>>();
        decode_property_texture_bytes(
            class_property,
            property,
            self.enum_definition.as_ref(),
            &bytes,
        )
    }
}

/// One decoded property-texture property bound to a mesh primitive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPropertyTextureProperty {
    /// Lossless root property definition.
    pub descriptor: Value,
    /// Image index in the decoded glTF.
    pub image_index: usize,
    /// Ordered byte channels.
    pub channels: Vec<u8>,
    /// Transformed UVs by source triangle.
    pub triangle_tex_coords: Vec<[[f32; 2]; 3]>,
    /// Horizontal wrapping.
    pub wrap_s: DecodedTextureWrap,
    /// Vertical wrapping.
    pub wrap_t: DecodedTextureWrap,
    /// Class property schema.
    pub class_property: Value,
    /// Optional resolved enum definition.
    pub enum_definition: Option<Value>,
}

/// One primitive binding to a root property-texture definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPrimitivePropertyTexture {
    /// Index of the root property-texture definition.
    pub definition_index: usize,
    /// Schema class addressed by the definition.
    pub class_name: String,
    /// Lossless root definition.
    pub definition: Value,
    /// Decoded texture properties by schema property name.
    pub properties: BTreeMap<String, DecodedPropertyTextureProperty>,
}

impl DecodedPrimitivePropertyTexture {
    /// Produces exact property texture addresses for one triangle hit.
    #[must_use]
    pub fn samples_at_triangle(
        &self,
        triangle_index: usize,
        barycentric: [f64; 3],
    ) -> Vec<DecodedPropertyTextureSample> {
        if barycentric.iter().any(|weight| !weight.is_finite()) {
            return Vec::new();
        }
        self.properties
            .iter()
            .filter_map(|(name, property)| {
                let triangle = property.triangle_tex_coords.get(triangle_index)?;
                let tex_coord = [0, 1].map(|axis| {
                    triangle
                        .iter()
                        .zip(barycentric)
                        .map(|(tex_coord, weight)| f64::from(tex_coord[axis]) * weight)
                        .sum()
                });
                Some(DecodedPropertyTextureSample {
                    name: name.clone(),
                    image_index: property.image_index,
                    tex_coord,
                    channels: property.channels.clone(),
                    wrap_s: property.wrap_s,
                    wrap_t: property.wrap_t,
                    class_property: property.class_property.clone(),
                    property: property.descriptor.clone(),
                    enum_definition: property.enum_definition.clone(),
                })
            })
            .collect()
    }
}

/// One property stored in a glTF vertex attribute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPropertyAttributeProperty {
    /// Authoritative glTF custom attribute semantic, including its underscore.
    pub attribute: String,
    /// Semantically decoded values in source-vertex order.
    pub vertex_values: Vec<Value>,
}

/// One primitive binding to a root `EXT_structural_metadata.propertyAttributes`
/// definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedPrimitivePropertyAttribute {
    /// Index of the root property-attribute definition.
    pub definition_index: usize,
    /// Schema class addressed by the definition.
    pub class_name: String,
    /// Lossless root definition for diagnostics and future presentation.
    pub definition: Value,
    /// Decoded properties by schema property name.
    pub properties: BTreeMap<String, DecodedPropertyAttributeProperty>,
    /// Source vertex indices for every decoded triangle.
    pub triangle_vertex_indices: Vec<[u32; 3]>,
}

impl DecodedPrimitivePropertyAttribute {
    /// Returns all authoritative vertex values plus an explicitly named
    /// nearest-vertex value for one exact triangle hit. No unspecified surface
    /// interpolation is invented for discrete structural metadata.
    #[must_use]
    pub fn values_at_triangle(
        &self,
        triangle_index: usize,
        barycentric: [f64; 3],
    ) -> Option<Value> {
        if barycentric.iter().any(|weight| !weight.is_finite()) {
            return None;
        }
        let indices = *self.triangle_vertex_indices.get(triangle_index)?;
        let nearest_vertex = barycentric
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map_or(0, |(index, _)| index);
        let mut properties = serde_json::Map::new();
        for (name, property) in &self.properties {
            let vertex_values = indices
                .iter()
                .map(|index| {
                    usize::try_from(*index)
                        .ok()
                        .and_then(|index| property.vertex_values.get(index))
                        .cloned()
                })
                .collect::<Option<Vec<_>>>()?;
            properties.insert(
                name.clone(),
                serde_json::json!({
                    "attribute": property.attribute,
                    "vertexValues": vertex_values,
                    "nearestVertex": nearest_vertex,
                    "value": vertex_values[nearest_vertex],
                }),
            );
        }
        Some(serde_json::json!({
            "definitionIndex": self.definition_index,
            "class": self.class_name,
            "definition": self.definition,
            "sourceVertexIndices": indices,
            "properties": properties,
        }))
    }
}

/// Exact feature result for one source triangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecodedTriangleFeatureId {
    /// All triangle vertices identify the same non-null feature.
    Feature(u32),
    /// All triangle vertices carry the declared null feature ID.
    Null,
    /// Vertex IDs disagree, so an exact feature cannot be invented.
    Ambiguous,
    /// The feature set is texture-backed and must be sampled at the hit UV.
    Texture,
}

/// Legacy `_BATCHID` values retained in source-vertex and source-triangle order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedLegacyBatchIds {
    /// Raw non-negative integer ID for every source vertex.
    pub vertex_ids: Vec<u32>,
    /// Three source-vertex IDs for every decoded source triangle.
    pub triangle_vertex_ids: Vec<[u32; 3]>,
    /// Uniform or ambiguous feature classification in source-triangle order.
    pub triangle_ids: Vec<DecodedTriangleFeatureId>,
}

impl DecodedLegacyBatchIds {
    /// Retained heap bytes for source-vertex and source-triangle bindings.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        allocation_bytes::<u32>(self.vertex_ids.capacity())
            .saturating_add(allocation_bytes::<[u32; 3]>(
                self.triangle_vertex_ids.capacity(),
            ))
            .saturating_add(allocation_bytes::<DecodedTriangleFeatureId>(
                self.triangle_ids.capacity(),
            ))
    }

    /// Resolves an exact hit using the nearest source vertex when a triangle
    /// spans more than one legacy feature.
    #[must_use]
    pub fn feature_id_at_triangle(
        &self,
        triangle_index: usize,
        barycentric: [f64; 3],
    ) -> Option<DecodedTriangleFeatureId> {
        if barycentric.iter().any(|weight| !weight.is_finite()) {
            return None;
        }
        if let Some(uniform) = self.triangle_ids.get(triangle_index).copied() {
            if uniform != DecodedTriangleFeatureId::Ambiguous {
                return Some(uniform);
            }
        }
        let local_vertex = barycentric
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map_or(0, |(index, _)| index);
        self.triangle_vertex_ids
            .get(triangle_index)
            .and_then(|ids| ids.get(local_vertex))
            .copied()
            .map(DecodedTriangleFeatureId::Feature)
    }
}

fn allocation_bytes<T>(capacity: usize) -> u64 {
    u64::try_from(capacity)
        .unwrap_or(u64::MAX)
        .saturating_mul(u64::try_from(std::mem::size_of::<T>()).unwrap_or(u64::MAX))
}

/// One ordered `EXT_mesh_features.featureIds` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedMeshFeatureSet {
    /// Number of addressable non-null features.
    pub feature_count: u32,
    /// Optional application-facing identifier.
    pub label: Option<String>,
    /// Optional value that represents no feature.
    pub null_feature_id: Option<u32>,
    /// Optional property table indexed by the feature ID.
    pub property_table: Option<usize>,
    /// Authoritative ID storage.
    pub binding: DecodedFeatureIdBinding,
    /// Attribute/implicit IDs for each source triangle's three vertices.
    pub triangle_vertex_ids: Vec<[u32; 3]>,
    /// Exact feature classification in source triangle order.
    pub triangle_ids: Vec<DecodedTriangleFeatureId>,
}

impl DecodedMeshFeatureSet {
    /// Resolves an attribute or implicit feature at an exact triangle hit using
    /// the nearest-vertex rule from `EXT_mesh_features`.
    #[must_use]
    pub fn feature_id_at_triangle(
        &self,
        triangle_index: usize,
        barycentric: [f64; 3],
    ) -> Option<DecodedTriangleFeatureId> {
        if barycentric.iter().any(|weight| !weight.is_finite()) {
            return None;
        }
        if matches!(self.binding, DecodedFeatureIdBinding::Texture { .. }) {
            return Some(DecodedTriangleFeatureId::Texture);
        }
        if let Some(uniform) = self.triangle_ids.get(triangle_index).copied() {
            if uniform != DecodedTriangleFeatureId::Ambiguous {
                return Some(uniform);
            }
        }
        let local_vertex = barycentric
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map_or(0, |(index, _)| index);
        let id = *self
            .triangle_vertex_ids
            .get(triangle_index)?
            .get(local_vertex)?;
        Some(if Some(id) == self.null_feature_id {
            DecodedTriangleFeatureId::Null
        } else {
            DecodedTriangleFeatureId::Feature(id)
        })
    }

    /// Produces the exact texture address for a texture-backed feature set.
    #[must_use]
    pub fn feature_texture_sample_at_triangle(
        &self,
        triangle_index: usize,
        barycentric: [f64; 3],
    ) -> Option<DecodedFeatureTextureSample> {
        if barycentric.iter().any(|weight| !weight.is_finite()) {
            return None;
        }
        let DecodedFeatureIdBinding::Texture {
            image_index,
            channels,
            triangle_tex_coords,
            wrap_s,
            wrap_t,
            ..
        } = &self.binding
        else {
            return None;
        };
        let triangle = triangle_tex_coords.get(triangle_index)?;
        let tex_coord = [0, 1].map(|axis| {
            triangle
                .iter()
                .zip(barycentric)
                .map(|(tex_coord, weight)| f64::from(tex_coord[axis]) * weight)
                .sum()
        });
        Some(DecodedFeatureTextureSample {
            image_index: *image_index,
            tex_coord,
            channels: channels.clone(),
            wrap_s: *wrap_s,
            wrap_t: *wrap_t,
        })
    }
}

pub(super) fn decode_structural_metadata(
    gltf: &gltf::Gltf,
    blob: Option<&[u8]>,
) -> Result<Option<DecodedStructuralMetadata>, GlbDecodeError> {
    let Some(extension) = gltf.document.extension_value(STRUCTURAL_METADATA) else {
        return Ok(None);
    };
    let object = extension
        .as_object()
        .ok_or_else(|| invalid("EXT_structural_metadata is not an object"))?;
    let schema = object.get("schema").cloned();
    let schema_uri = object
        .get("schemaUri")
        .map(|value| {
            value
                .as_str()
                .filter(|uri| !uri.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| invalid("EXT_structural_metadata.schemaUri is invalid"))
        })
        .transpose()?;
    if schema.is_some() && schema_uri.is_some() {
        return Err(invalid(
            "EXT_structural_metadata schema and schemaUri are mutually exclusive",
        ));
    }
    if schema.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(invalid("EXT_structural_metadata.schema is not an object"));
    }
    let property_tables = object_array(object, "propertyTables")?;
    let property_table_buffer_views =
        retain_property_table_buffer_views(gltf, blob, &property_tables)?;
    Ok(Some(DecodedStructuralMetadata {
        schema,
        schema_uri,
        property_tables,
        property_textures: object_array(object, "propertyTextures")?,
        property_attributes: object_array(object, "propertyAttributes")?,
        property_table_buffer_views,
    }))
}

fn retain_property_table_buffer_views(
    gltf: &gltf::Gltf,
    blob: Option<&[u8]>,
    property_tables: &[Value],
) -> Result<BTreeMap<usize, Vec<u8>>, GlbDecodeError> {
    let mut indices = BTreeSet::new();
    for table in property_tables {
        let properties = table
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                invalid("EXT_structural_metadata property table properties are invalid")
            })?;
        for property in properties.values() {
            let property = property.as_object().ok_or_else(|| {
                invalid("EXT_structural_metadata property table property is invalid")
            })?;
            for key in ["values", "arrayOffsets", "stringOffsets"] {
                if let Some(index) = property.get(key) {
                    let index = index
                        .as_u64()
                        .and_then(|index| usize::try_from(index).ok())
                        .ok_or_else(|| invalid("EXT_structural_metadata buffer view is invalid"))?;
                    indices.insert(index);
                }
            }
        }
    }
    let mut retained = BTreeMap::new();
    for index in indices {
        let view = gltf
            .views()
            .nth(index)
            .ok_or_else(|| invalid("EXT_structural_metadata buffer view is out of range"))?;
        if !matches!(view.buffer().source(), gltf::buffer::Source::Bin) {
            return Err(invalid(
                "EXT_structural_metadata property table uses an external buffer",
            ));
        }
        let blob = blob.ok_or(GlbDecodeError::MissingBinaryBlob)?;
        let end = view
            .offset()
            .checked_add(view.length())
            .ok_or_else(|| invalid("EXT_structural_metadata buffer view overflows"))?;
        let bytes = blob
            .get(view.offset()..end)
            .ok_or_else(|| invalid("EXT_structural_metadata buffer view exceeds the BIN chunk"))?;
        retained.insert(index, bytes.to_vec());
    }
    Ok(retained)
}

pub(super) fn decode_mesh_features(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    property_table_count: usize,
) -> Result<Vec<DecodedMeshFeatureSet>, GlbDecodeError> {
    let Some(extension) = primitive.extension_value(MESH_FEATURES) else {
        return Ok(Vec::new());
    };
    let feature_ids = extension
        .get("featureIds")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| invalid("EXT_mesh_features.featureIds is missing or empty"))?;
    feature_ids
        .iter()
        .map(|entry| {
            decode_feature_set(
                primitive,
                gltf,
                blob,
                triangle_indices,
                vertex_count,
                property_table_count,
                entry,
            )
        })
        .collect()
}

pub(super) fn decode_legacy_batch_ids(
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
) -> Result<Option<DecodedLegacyBatchIds>, GlbDecodeError> {
    // gltf-rs stores custom semantics without their leading underscore.
    let Some(accessor) = primitive.get(&gltf::Semantic::Extras("BATCHID".to_owned())) else {
        return Ok(None);
    };
    if accessor.dimensions() != Dimensions::Scalar
        || accessor.normalized()
        || accessor.count() != vertex_count
    {
        return Err(invalid("legacy _BATCHID accessor is invalid"));
    }
    let buffer = |buffer: gltf::Buffer<'_>| match buffer.source() {
        gltf::buffer::Source::Bin => blob,
        gltf::buffer::Source::Uri(_) => None,
    };
    let missing = || invalid("legacy _BATCHID accessor bytes are missing");
    let vertex_ids = match accessor.data_type() {
        DataType::I8 => Iter::<i8>::new(accessor, buffer)
            .ok_or_else(missing)?
            .map(|value| {
                u32::try_from(value).map_err(|_| invalid("legacy _BATCHID value is negative"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        DataType::I16 => Iter::<i16>::new(accessor, buffer)
            .ok_or_else(missing)?
            .map(|value| {
                u32::try_from(value).map_err(|_| invalid("legacy _BATCHID value is negative"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        DataType::U8 => Iter::<u8>::new(accessor, buffer)
            .ok_or_else(missing)?
            .map(u32::from)
            .collect(),
        DataType::U16 => Iter::<u16>::new(accessor, buffer)
            .ok_or_else(missing)?
            .map(u32::from)
            .collect(),
        DataType::U32 => Iter::<u32>::new(accessor, buffer)
            .ok_or_else(missing)?
            .collect(),
        DataType::F32 => Iter::<f32>::new(accessor, buffer)
            .ok_or_else(missing)?
            .map(legacy_float_batch_id)
            .collect::<Result<Vec<_>, _>>()?,
    };
    decoded_legacy_batch_ids(vertex_ids, triangle_indices).map(Some)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub(super) fn legacy_float_batch_id(value: f32) -> Result<u32, GlbDecodeError> {
    if !value.is_finite()
        || value < 0.0
        || value.fract() != 0.0
        || f64::from(value) > f64::from(u32::MAX)
    {
        return Err(invalid(
            "legacy floating-point _BATCHID is not a non-negative u32 integer",
        ));
    }
    Ok(value as u32)
}

pub(super) fn decoded_legacy_batch_ids(
    vertex_ids: Vec<u32>,
    triangle_indices: &[u32],
) -> Result<DecodedLegacyBatchIds, GlbDecodeError> {
    let (triangle_vertex_ids, triangle_ids) =
        triangle_ids_from_vertices(&vertex_ids, triangle_indices, None)?;
    Ok(DecodedLegacyBatchIds {
        vertex_ids,
        triangle_vertex_ids,
        triangle_ids,
    })
}

pub(super) fn decode_primitive_property_attributes(
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    metadata: Option<&DecodedStructuralMetadata>,
) -> Result<Vec<DecodedPrimitivePropertyAttribute>, GlbDecodeError> {
    let Some(extension) = primitive.extension_value(STRUCTURAL_METADATA) else {
        return Ok(Vec::new());
    };
    let Some(bindings) = extension.get("propertyAttributes") else {
        return Ok(Vec::new());
    };
    let bindings = bindings.as_array().ok_or_else(|| {
        invalid("EXT_structural_metadata primitive propertyAttributes is invalid")
    })?;
    let metadata = metadata.ok_or_else(|| {
        invalid("EXT_structural_metadata primitive has no root metadata definition")
    })?;
    bindings
        .iter()
        .map(|binding| {
            let index = binding
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                .ok_or_else(|| invalid("property attribute root index is invalid"))?;
            decode_primitive_property_attribute(
                primitive,
                blob,
                triangle_indices,
                vertex_count,
                metadata,
                index,
            )
        })
        .collect()
}

fn decode_primitive_property_attribute(
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    metadata: &DecodedStructuralMetadata,
    definition_index: usize,
) -> Result<DecodedPrimitivePropertyAttribute, GlbDecodeError> {
    let definition = metadata
        .property_attributes
        .get(definition_index)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("property attribute root index is out of range"))?;
    let class_name = definition
        .get("class")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("property attribute class is invalid"))?;
    let class_properties = metadata
        .schema
        .as_ref()
        .and_then(|schema| schema.get("classes"))
        .and_then(|classes| classes.get(class_name))
        .and_then(|class| class.get("properties"))
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("property attribute schema class is missing"))?;
    let definition_properties = definition
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("property attribute properties are invalid"))?;
    if class_properties.iter().any(|(name, property)| {
        property.get("required").and_then(Value::as_bool) == Some(true)
            && !definition_properties.contains_key(name)
    }) {
        return Err(invalid(
            "property attribute omits a required class property",
        ));
    }
    let properties = definition_properties
        .iter()
        .map(|(name, property)| {
            let class_property = class_properties
                .get(name)
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("property attribute class property is missing"))?;
            let property = property
                .as_object()
                .ok_or_else(|| invalid("property attribute property is invalid"))?;
            let attribute = property
                .get("attribute")
                .and_then(Value::as_str)
                .filter(|attribute| attribute.starts_with('_') && attribute.len() > 1)
                .ok_or_else(|| invalid("property attribute semantic is invalid"))?;
            let semantic = gltf::Semantic::Extras(attribute[1..].to_owned());
            let accessor = primitive
                .get(&semantic)
                .ok_or_else(|| invalid("property attribute accessor is missing"))?;
            let vertex_values = read_property_attribute_values(
                &accessor,
                blob,
                vertex_count,
                metadata,
                class_property,
                property,
            )?;
            Ok((
                name.clone(),
                DecodedPropertyAttributeProperty {
                    attribute: attribute.to_owned(),
                    vertex_values,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, GlbDecodeError>>()?;
    let triangle_vertex_indices = triangle_indices
        .chunks_exact(3)
        .map(|triangle| [triangle[0], triangle[1], triangle[2]])
        .collect();
    Ok(DecodedPrimitivePropertyAttribute {
        definition_index,
        class_name: class_name.to_owned(),
        definition: Value::Object(definition.clone()),
        properties,
        triangle_vertex_indices,
    })
}

fn read_property_attribute_values(
    accessor: &gltf::Accessor<'_>,
    blob: Option<&[u8]>,
    vertex_count: usize,
    metadata: &DecodedStructuralMetadata,
    class_property: &serde_json::Map<String, Value>,
    property: &serde_json::Map<String, Value>,
) -> Result<Vec<Value>, GlbDecodeError> {
    if accessor.sparse().is_some() || accessor.count() != vertex_count {
        return Err(invalid(
            "property attribute accessor count or storage is invalid",
        ));
    }
    if class_property.get("array").and_then(Value::as_bool) == Some(true) {
        return Err(invalid("property attributes cannot store array values"));
    }
    let property_type = class_property
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("property attribute type is invalid"))?;
    let (component_type, is_enum) = if property_type == "ENUM" {
        let enum_name = class_property
            .get("enumType")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("property attribute enum type is invalid"))?;
        let component_type = metadata
            .schema
            .as_ref()
            .and_then(|schema| schema.get("enums"))
            .and_then(|enums| enums.get(enum_name))
            .and_then(|definition| definition.get("valueType"))
            .and_then(Value::as_str)
            .unwrap_or("UINT16");
        (component_type, true)
    } else {
        (
            class_property
                .get("componentType")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("property attribute component type is invalid"))?,
            false,
        )
    };
    validate_property_attribute_accessor(accessor, property_type, component_type, class_property)?;
    let components = if is_enum {
        1
    } else {
        property_type_components(property_type)?
    };
    let component_bytes = component_size(component_type)?;
    let element_bytes = components
        .checked_mul(component_bytes)
        .ok_or_else(|| invalid("property attribute element size overflows"))?;
    let view = accessor
        .view()
        .ok_or_else(|| invalid("property attribute accessor has no buffer view"))?;
    if !matches!(view.buffer().source(), gltf::buffer::Source::Bin) {
        return Err(invalid("property attribute uses an external buffer"));
    }
    let bytes = blob.ok_or(GlbDecodeError::MissingBinaryBlob)?;
    let stride = view.stride().unwrap_or(element_bytes);
    if stride < element_bytes {
        return Err(invalid("property attribute byte stride is invalid"));
    }
    let first = view
        .offset()
        .checked_add(accessor.offset())
        .ok_or_else(|| invalid("property attribute byte offset overflows"))?;
    (0..vertex_count)
        .map(|vertex| {
            let offset =
                first
                    .checked_add(vertex.checked_mul(stride).ok_or_else(|| {
                        invalid("property attribute vertex byte offset overflows")
                    })?)
                    .ok_or_else(|| invalid("property attribute vertex byte offset overflows"))?;
            let raw_components = (0..components)
                .map(|component| {
                    decode_component(bytes, offset + component * component_bytes, component_type)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let raw = if components == 1 {
                raw_components.into_iter().next().expect("one component")
            } else {
                Value::Array(raw_components)
            };
            if is_enum {
                decode_property_attribute_enum(metadata, class_property, &raw)
            } else {
                apply_property_semantics(class_property, property, raw)
            }
        })
        .collect()
}

fn validate_property_attribute_accessor(
    accessor: &gltf::Accessor<'_>,
    property_type: &str,
    component_type: &str,
    class_property: &serde_json::Map<String, Value>,
) -> Result<(), GlbDecodeError> {
    let dimensions_match = match property_type {
        "ENUM" | "SCALAR" => accessor.dimensions() == Dimensions::Scalar,
        "VEC2" => accessor.dimensions() == Dimensions::Vec2,
        "VEC3" => accessor.dimensions() == Dimensions::Vec3,
        "VEC4" => accessor.dimensions() == Dimensions::Vec4,
        "MAT2" => accessor.dimensions() == Dimensions::Mat2,
        "MAT3" => accessor.dimensions() == Dimensions::Mat3,
        "MAT4" => accessor.dimensions() == Dimensions::Mat4,
        _ => false,
    };
    let component_match = matches!(
        (component_type, accessor.data_type()),
        ("INT8", DataType::I8)
            | ("UINT8", DataType::U8)
            | ("INT16", DataType::I16)
            | ("UINT16", DataType::U16)
            | ("FLOAT32", DataType::F32)
    );
    let normalized = class_property
        .get("normalized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !dimensions_match || !component_match || accessor.normalized() != normalized {
        return Err(invalid(
            "property attribute accessor does not match its schema",
        ));
    }
    Ok(())
}

fn decode_property_attribute_enum(
    metadata: &DecodedStructuralMetadata,
    class_property: &serde_json::Map<String, Value>,
    raw: &Value,
) -> Result<Value, GlbDecodeError> {
    let enum_name = class_property
        .get("enumType")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("property attribute enum type is invalid"))?;
    let value = raw
        .as_u64()
        .ok_or_else(|| invalid("property attribute enum value is invalid"))?;
    metadata
        .schema
        .as_ref()
        .and_then(|schema| schema.get("enums"))
        .and_then(|enums| enums.get(enum_name))
        .and_then(|definition| definition.get("values"))
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("value").and_then(Value::as_u64) == Some(value))
        })
        .and_then(|entry| entry.get("name"))
        .and_then(Value::as_str)
        .map(|name| Value::String(name.to_owned()))
        .ok_or_else(|| invalid("property attribute enum value is undefined"))
}

pub(super) fn decode_primitive_property_textures(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    metadata: Option<&DecodedStructuralMetadata>,
) -> Result<Vec<DecodedPrimitivePropertyTexture>, GlbDecodeError> {
    let Some(extension) = primitive.extension_value(STRUCTURAL_METADATA) else {
        return Ok(Vec::new());
    };
    let Some(bindings) = extension.get("propertyTextures") else {
        return Ok(Vec::new());
    };
    let bindings = bindings
        .as_array()
        .ok_or_else(|| invalid("EXT_structural_metadata primitive propertyTextures is invalid"))?;
    let metadata = metadata.ok_or_else(|| {
        invalid("EXT_structural_metadata primitive has no root metadata definition")
    })?;
    bindings
        .iter()
        .map(|binding| {
            let index = binding
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                .ok_or_else(|| invalid("property texture root index is invalid"))?;
            decode_primitive_property_texture(
                gltf,
                primitive,
                blob,
                triangle_indices,
                vertex_count,
                metadata,
                index,
            )
        })
        .collect()
}

fn decode_primitive_property_texture(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    metadata: &DecodedStructuralMetadata,
    definition_index: usize,
) -> Result<DecodedPrimitivePropertyTexture, GlbDecodeError> {
    let definition = metadata
        .property_textures
        .get(definition_index)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("property texture root index is out of range"))?;
    let class_name = definition
        .get("class")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("property texture class is invalid"))?;
    let class_properties = metadata
        .schema
        .as_ref()
        .and_then(|schema| schema.get("classes"))
        .and_then(|classes| classes.get(class_name))
        .and_then(|class| class.get("properties"))
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("property texture schema class is missing"))?;
    let definition_properties = definition
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("property texture properties are invalid"))?;
    if class_properties.iter().any(|(name, property)| {
        property.get("required").and_then(Value::as_bool) == Some(true)
            && !definition_properties.contains_key(name)
    }) {
        return Err(invalid("property texture omits a required class property"));
    }
    let properties = definition_properties
        .iter()
        .map(|(name, property)| {
            let class_property = class_properties
                .get(name)
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("property texture class property is missing"))?;
            let property = property
                .as_object()
                .ok_or_else(|| invalid("property texture property is invalid"))?;
            let channels = property_texture_channels(class_property, property, metadata)?;
            let texture = decode_property_texture_binding(
                gltf,
                primitive,
                blob,
                triangle_indices,
                vertex_count,
                property,
            )?;
            let enum_definition = class_property
                .get("enumType")
                .and_then(Value::as_str)
                .and_then(|name| metadata.schema.as_ref()?.get("enums")?.get(name))
                .cloned();
            Ok((
                name.clone(),
                DecodedPropertyTextureProperty {
                    descriptor: Value::Object(property.clone()),
                    image_index: texture.image_index,
                    channels,
                    triangle_tex_coords: texture.triangle_tex_coords,
                    wrap_s: texture.wrap_s,
                    wrap_t: texture.wrap_t,
                    class_property: Value::Object(class_property.clone()),
                    enum_definition,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, GlbDecodeError>>()?;
    Ok(DecodedPrimitivePropertyTexture {
        definition_index,
        class_name: class_name.to_owned(),
        definition: Value::Object(definition.clone()),
        properties,
    })
}

struct DecodedTextureBinding {
    image_index: usize,
    triangle_tex_coords: Vec<[[f32; 2]; 3]>,
    wrap_s: DecodedTextureWrap,
    wrap_t: DecodedTextureWrap,
}

fn decode_property_texture_binding(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    property: &serde_json::Map<String, Value>,
) -> Result<DecodedTextureBinding, GlbDecodeError> {
    let texture_index = usize::try_from(required_metadata_u32(property.get("index"), "index")?)
        .expect("u32 fits usize");
    let transform = property
        .get("extensions")
        .and_then(|extensions| extensions.get("KHR_texture_transform"))
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| invalid("property texture KHR_texture_transform is invalid"))
        })
        .transpose()?;
    let tex_coord_set = transform
        .and_then(|transform| transform.get("texCoord"))
        .map(|value| required_metadata_u32(Some(value), "transform texCoord"))
        .transpose()?
        .or(optional_metadata_u32(property.get("texCoord"), "texCoord")?)
        .unwrap_or(0);
    let gltf_texture = gltf
        .textures()
        .nth(texture_index)
        .ok_or_else(|| invalid("property texture index is out of range"))?;
    let image_index = super::gltf_content::texture_image_index(&gltf_texture)
        .ok_or_else(|| invalid("property texture image is missing"))?;
    let sampler = gltf_texture.sampler();
    if !matches!(
        sampler.min_filter(),
        None | Some(gltf::texture::MinFilter::Nearest | gltf::texture::MinFilter::Linear)
    ) {
        return Err(invalid("property texture mipmap sampler is unsupported"));
    }
    let wrap = |mode| match mode {
        gltf::texture::WrappingMode::ClampToEdge => DecodedTextureWrap::ClampToEdge,
        gltf::texture::WrappingMode::MirroredRepeat => DecodedTextureWrap::MirroredRepeat,
        gltf::texture::WrappingMode::Repeat => DecodedTextureWrap::Repeat,
    };
    let reader = primitive.reader(|buffer| match buffer.source() {
        gltf::buffer::Source::Bin => blob,
        gltf::buffer::Source::Uri(_) => None,
    });
    let mut tex_coords = reader
        .read_tex_coords(tex_coord_set)
        .map(|values| values.into_f32().collect::<Vec<_>>())
        .ok_or_else(|| invalid("property texture coordinates are missing"))?;
    if tex_coords.len() != vertex_count {
        return Err(invalid("property texture coordinate count is invalid"));
    }
    apply_texture_transform(&mut tex_coords, transform)?;
    let triangle_tex_coords = triangle_indices
        .chunks_exact(3)
        .map(|triangle| {
            let indices =
                [triangle[0], triangle[1], triangle[2]].map(|index| usize::try_from(index).ok());
            Ok([
                *tex_coords
                    .get(
                        indices[0]
                            .ok_or_else(|| invalid("property texture triangle is invalid"))?,
                    )
                    .ok_or_else(|| invalid("property texture triangle is invalid"))?,
                *tex_coords
                    .get(
                        indices[1]
                            .ok_or_else(|| invalid("property texture triangle is invalid"))?,
                    )
                    .ok_or_else(|| invalid("property texture triangle is invalid"))?,
                *tex_coords
                    .get(
                        indices[2]
                            .ok_or_else(|| invalid("property texture triangle is invalid"))?,
                    )
                    .ok_or_else(|| invalid("property texture triangle is invalid"))?,
            ])
        })
        .collect::<Result<Vec<_>, GlbDecodeError>>()?;
    Ok(DecodedTextureBinding {
        image_index,
        triangle_tex_coords,
        wrap_s: wrap(sampler.wrap_s()),
        wrap_t: wrap(sampler.wrap_t()),
    })
}

fn property_texture_channels(
    class_property: &serde_json::Map<String, Value>,
    property: &serde_json::Map<String, Value>,
    metadata: &DecodedStructuralMetadata,
) -> Result<Vec<u8>, GlbDecodeError> {
    let channels = property.get("channels").map_or_else(
        || Ok(vec![0_u8]),
        |value| {
            value
                .as_array()
                .filter(|channels| !channels.is_empty() && channels.len() <= 4)
                .ok_or_else(|| invalid("property texture channels are invalid"))?
                .iter()
                .map(|channel| {
                    channel
                        .as_u64()
                        .and_then(|channel| u8::try_from(channel).ok())
                        .filter(|channel| *channel <= 3)
                        .ok_or_else(|| invalid("property texture channel is invalid"))
                })
                .collect::<Result<Vec<_>, _>>()
        },
    )?;
    if channels.iter().copied().collect::<BTreeSet<_>>().len() != channels.len() {
        return Err(invalid("property texture channels contain duplicates"));
    }
    let expected = property_texture_byte_length(class_property, metadata)?;
    if channels.len() != expected {
        return Err(invalid(
            "property texture channel count does not match its schema",
        ));
    }
    Ok(channels)
}

fn property_texture_byte_length(
    class_property: &serde_json::Map<String, Value>,
    metadata: &DecodedStructuralMetadata,
) -> Result<usize, GlbDecodeError> {
    let property_type = class_property
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("property texture type is invalid"))?;
    let array_count = if class_property.get("array").and_then(Value::as_bool) == Some(true) {
        class_property
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
            .filter(|count| *count > 0)
            .ok_or_else(|| invalid("property textures require a fixed array count"))?
    } else {
        1
    };
    if property_type == "BOOLEAN" {
        if class_property.contains_key("noData") {
            return Err(invalid("property texture booleans cannot declare noData"));
        }
        return Ok(array_count.div_ceil(8));
    }
    if property_type == "STRING" {
        return Err(invalid("property textures cannot store strings"));
    }
    let (components, component_type) = if property_type == "ENUM" {
        let enum_name = class_property
            .get("enumType")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("property texture enum type is invalid"))?;
        let component_type = metadata
            .schema
            .as_ref()
            .and_then(|schema| schema.get("enums"))
            .and_then(|enums| enums.get(enum_name))
            .and_then(|definition| definition.get("valueType"))
            .and_then(Value::as_str)
            .unwrap_or("UINT16");
        (1, component_type)
    } else {
        (
            property_type_components(property_type)?,
            class_property
                .get("componentType")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("property texture component type is invalid"))?,
        )
    };
    components
        .checked_mul(array_count)
        .and_then(|count| count.checked_mul(component_size(component_type).ok()?))
        .filter(|bytes| *bytes <= 4)
        .ok_or_else(|| invalid("property texture value does not fit RGBA8 channels"))
}

fn decode_feature_set(
    primitive: &gltf::Primitive<'_>,
    gltf: &gltf::Gltf,
    blob: Option<&[u8]>,
    triangle_indices: &[u32],
    vertex_count: usize,
    property_table_count: usize,
    entry: &Value,
) -> Result<DecodedMeshFeatureSet, GlbDecodeError> {
    let object = entry
        .as_object()
        .ok_or_else(|| invalid("EXT_mesh_features feature ID set is not an object"))?;
    let feature_count = required_u32(object.get("featureCount"), "featureCount")?;
    if feature_count == 0 {
        return Err(invalid("EXT_mesh_features.featureCount is zero"));
    }
    let null_feature_id = optional_u32(object.get("nullFeatureId"), "nullFeatureId")?;
    let property_table = optional_u32(object.get("propertyTable"), "propertyTable")?
        .map(|index| usize::try_from(index).expect("u32 fits usize"));
    if property_table.is_some_and(|index| index >= property_table_count) {
        return Err(invalid("EXT_mesh_features.propertyTable is out of range"));
    }
    let label = object
        .get("label")
        .map(|value| {
            let label = value
                .as_str()
                .ok_or_else(|| invalid("EXT_mesh_features.label is not a string"))?;
            if valid_label(label) {
                Ok(label.to_owned())
            } else {
                Err(invalid("EXT_mesh_features.label is invalid"))
            }
        })
        .transpose()?;
    let attribute = optional_u32(object.get("attribute"), "attribute")?;
    let texture = object.get("texture");
    if attribute.is_some() && texture.is_some() {
        return Err(invalid(
            "EXT_mesh_features attribute and texture are mutually exclusive",
        ));
    }
    let binding = if let Some(attribute) = attribute {
        // gltf-rs stores custom semantic names without their leading underscore.
        let semantic = gltf::Semantic::Extras(format!("FEATURE_ID_{attribute}"));
        let accessor = primitive
            .get(&semantic)
            .ok_or_else(|| invalid("EXT_mesh_features attribute is missing"))?;
        let vertex_ids = read_feature_ids(accessor, blob, vertex_count)?;
        validate_ids(&vertex_ids, feature_count, null_feature_id)?;
        DecodedFeatureIdBinding::Attribute {
            attribute,
            vertex_ids,
        }
    } else if let Some(texture) = texture {
        decode_feature_texture(
            gltf,
            primitive,
            blob,
            texture,
            triangle_indices,
            vertex_count,
        )?
    } else {
        let vertex_ids = (0..vertex_count)
            .map(|index| u32::try_from(index).map_err(|_| invalid("too many implicit feature IDs")))
            .collect::<Result<Vec<_>, _>>()?;
        validate_ids(&vertex_ids, feature_count, null_feature_id)?;
        DecodedFeatureIdBinding::Implicit { vertex_ids }
    };
    let (triangle_vertex_ids, triangle_ids) =
        triangle_feature_ids(&binding, triangle_indices, null_feature_id)?;
    Ok(DecodedMeshFeatureSet {
        feature_count,
        label,
        null_feature_id,
        property_table,
        binding,
        triangle_vertex_ids,
        triangle_ids,
    })
}

fn read_feature_ids(
    accessor: gltf::Accessor<'_>,
    blob: Option<&[u8]>,
    vertex_count: usize,
) -> Result<Vec<u32>, GlbDecodeError> {
    if accessor.dimensions() != Dimensions::Scalar
        || accessor.normalized()
        || accessor.count() != vertex_count
    {
        return Err(invalid("EXT_mesh_features attribute accessor is invalid"));
    }
    let buffer = |buffer: gltf::Buffer<'_>| match buffer.source() {
        gltf::buffer::Source::Bin => blob,
        gltf::buffer::Source::Uri(_) => None,
    };
    match accessor.data_type() {
        DataType::U8 => Iter::<u8>::new(accessor, buffer)
            .map(|values| values.map(u32::from).collect())
            .ok_or_else(|| invalid("EXT_mesh_features attribute bytes are missing")),
        DataType::U16 => Iter::<u16>::new(accessor, buffer)
            .map(|values| values.map(u32::from).collect())
            .ok_or_else(|| invalid("EXT_mesh_features attribute bytes are missing")),
        DataType::U32 => Iter::<u32>::new(accessor, buffer)
            .map(Iterator::collect)
            .ok_or_else(|| invalid("EXT_mesh_features attribute bytes are missing")),
        _ => Err(invalid(
            "EXT_mesh_features attribute must use an unsigned integer component",
        )),
    }
}

fn validate_ids(
    ids: &[u32],
    feature_count: u32,
    null_feature_id: Option<u32>,
) -> Result<(), GlbDecodeError> {
    if ids
        .iter()
        .any(|id| Some(*id) != null_feature_id && *id >= feature_count)
    {
        Err(invalid("EXT_mesh_features feature ID is out of range"))
    } else {
        Ok(())
    }
}

fn triangle_feature_ids(
    binding: &DecodedFeatureIdBinding,
    indices: &[u32],
    null_feature_id: Option<u32>,
) -> Result<(Vec<[u32; 3]>, Vec<DecodedTriangleFeatureId>), GlbDecodeError> {
    let ids = match binding {
        DecodedFeatureIdBinding::Implicit { vertex_ids }
        | DecodedFeatureIdBinding::Attribute { vertex_ids, .. } => vertex_ids,
        DecodedFeatureIdBinding::Texture { .. } => {
            return Ok((
                Vec::new(),
                vec![DecodedTriangleFeatureId::Texture; indices.len() / 3],
            ));
        }
    };
    triangle_ids_from_vertices(ids, indices, null_feature_id)
}

fn triangle_ids_from_vertices(
    ids: &[u32],
    indices: &[u32],
    null_feature_id: Option<u32>,
) -> Result<(Vec<[u32; 3]>, Vec<DecodedTriangleFeatureId>), GlbDecodeError> {
    let triangle_vertex_ids = indices
        .chunks_exact(3)
        .map(|triangle| {
            let mut values = [0_u32; 3];
            for (output, index) in values.iter_mut().zip(triangle) {
                *output = usize::try_from(*index)
                    .ok()
                    .and_then(|index| ids.get(index))
                    .copied()
                    .ok_or_else(|| invalid("feature ID triangle index is invalid"))?;
            }
            Ok(values)
        })
        .collect::<Result<Vec<[u32; 3]>, _>>()?;
    let triangle_ids = triangle_vertex_ids
        .iter()
        .map(|values| {
            if values[0] != values[1] || values[0] != values[2] {
                Ok(DecodedTriangleFeatureId::Ambiguous)
            } else if Some(values[0]) == null_feature_id {
                Ok(DecodedTriangleFeatureId::Null)
            } else {
                Ok(DecodedTriangleFeatureId::Feature(values[0]))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((triangle_vertex_ids, triangle_ids))
}

fn decode_feature_texture(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    texture: &Value,
    triangle_indices: &[u32],
    vertex_count: usize,
) -> Result<DecodedFeatureIdBinding, GlbDecodeError> {
    let object = texture
        .as_object()
        .ok_or_else(|| invalid("EXT_mesh_features.texture is not an object"))?;
    let texture_index = usize::try_from(required_u32(object.get("index"), "texture.index")?)
        .expect("u32 fits usize");
    let transform_value = object
        .get("extensions")
        .and_then(|extensions| extensions.get("KHR_texture_transform"));
    let transform = transform_value
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| invalid("EXT_mesh_features KHR_texture_transform is not an object"))
        })
        .transpose()?;
    let tex_coord_set = transform
        .and_then(|transform| transform.get("texCoord"))
        .map(|value| required_u32(Some(value), "texture transform texCoord"))
        .transpose()?
        .or(optional_u32(object.get("texCoord"), "texture.texCoord")?)
        .unwrap_or(0);
    let channels = feature_texture_channels(object)?;
    let gltf_texture = gltf
        .textures()
        .nth(texture_index)
        .ok_or_else(|| invalid("EXT_mesh_features texture index is out of range"))?;
    let image_index = super::gltf_content::texture_image_index(&gltf_texture)
        .ok_or_else(|| invalid("EXT_mesh_features texture image is missing"))?;
    let sampler = gltf_texture.sampler();
    if sampler.mag_filter() != Some(gltf::texture::MagFilter::Nearest)
        || !matches!(
            sampler.min_filter(),
            Some(
                gltf::texture::MinFilter::Nearest | gltf::texture::MinFilter::NearestMipmapNearest
            )
        )
    {
        return Err(invalid("EXT_mesh_features texture sampler is not nearest"));
    }
    let wrap = |mode| match mode {
        gltf::texture::WrappingMode::ClampToEdge => DecodedTextureWrap::ClampToEdge,
        gltf::texture::WrappingMode::MirroredRepeat => DecodedTextureWrap::MirroredRepeat,
        gltf::texture::WrappingMode::Repeat => DecodedTextureWrap::Repeat,
    };
    let reader = primitive.reader(|buffer| match buffer.source() {
        gltf::buffer::Source::Bin => blob,
        gltf::buffer::Source::Uri(_) => None,
    });
    let mut tex_coords = reader
        .read_tex_coords(tex_coord_set)
        .map(|values| values.into_f32().collect::<Vec<_>>())
        .ok_or_else(|| invalid("EXT_mesh_features texture coordinates are missing"))?;
    if tex_coords.len() != vertex_count {
        return Err(invalid(
            "EXT_mesh_features texture coordinate count is invalid",
        ));
    }
    apply_texture_transform(&mut tex_coords, transform)?;
    let triangle_tex_coords = triangle_indices
        .chunks_exact(3)
        .map(|triangle| {
            let mut values = [[0.0_f32; 2]; 3];
            for (output, index) in values.iter_mut().zip(triangle) {
                *output = usize::try_from(*index)
                    .ok()
                    .and_then(|index| tex_coords.get(index))
                    .copied()
                    .ok_or_else(|| invalid("EXT_mesh_features texture triangle is invalid"))?;
            }
            Ok(values)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DecodedFeatureIdBinding::Texture {
        descriptor: texture.clone(),
        image_index,
        channels,
        triangle_tex_coords,
        wrap_s: wrap(sampler.wrap_s()),
        wrap_t: wrap(sampler.wrap_t()),
    })
}

fn feature_texture_channels(
    object: &serde_json::Map<String, Value>,
) -> Result<Vec<u8>, GlbDecodeError> {
    let channels = object.get("channels").map_or_else(
        || Ok(vec![0_u8]),
        |value| {
            value
                .as_array()
                .filter(|channels| !channels.is_empty() && channels.len() <= 4)
                .ok_or_else(|| invalid("EXT_mesh_features.texture.channels is invalid"))?
                .iter()
                .map(|channel| {
                    required_u32(Some(channel), "texture.channels").and_then(|channel| {
                        u8::try_from(channel)
                            .map_err(|_| invalid("EXT_mesh_features texture channel is invalid"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        },
    )?;
    if channels.iter().any(|channel| *channel > 3)
        || channels.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid("EXT_mesh_features.texture.channels is invalid"));
    }
    Ok(channels)
}

fn apply_texture_transform(
    tex_coords: &mut [[f32; 2]],
    transform: Option<&serde_json::Map<String, Value>>,
) -> Result<(), GlbDecodeError> {
    let Some(transform) = transform else {
        return Ok(());
    };
    let offset = optional_vec2(
        transform.get("offset"),
        [0.0, 0.0],
        "texture transform offset",
    )?;
    let scale = optional_vec2(
        transform.get("scale"),
        [1.0, 1.0],
        "texture transform scale",
    )?;
    let rotation = transform.get("rotation").map_or(Ok(0.0), |value| {
        value
            .as_f64()
            .filter(|rotation| rotation.is_finite())
            .ok_or_else(|| invalid("EXT_mesh_features texture rotation is invalid"))
    })?;
    let (sin, cos) = rotation.sin_cos();
    for tex_coord in tex_coords {
        let x = f64::from(tex_coord[0]) * scale[0];
        let y = f64::from(tex_coord[1]) * scale[1];
        let transformed = [offset[0] + cos * x - sin * y, offset[1] + sin * x + cos * y];
        if transformed.iter().any(|value| !value.is_finite()) {
            return Err(invalid(
                "EXT_mesh_features transformed texture coordinate is invalid",
            ));
        }
        #[allow(clippy::cast_possible_truncation)]
        {
            *tex_coord = [transformed[0] as f32, transformed[1] as f32];
        }
    }
    Ok(())
}

fn optional_vec2(
    value: Option<&Value>,
    default: [f64; 2],
    field: &str,
) -> Result<[f64; 2], GlbDecodeError> {
    let Some(value) = value else {
        return Ok(default);
    };
    let values = value
        .as_array()
        .filter(|values| values.len() == 2)
        .ok_or_else(|| invalid(&format!("EXT_mesh_features {field} is invalid")))?;
    let parsed = [0, 1].map(|index| values[index].as_f64());
    match parsed {
        [Some(x), Some(y)] if x.is_finite() && y.is_finite() => Ok([x, y]),
        _ => Err(invalid(&format!("EXT_mesh_features {field} is invalid"))),
    }
}

fn property_type_components(property_type: &str) -> Result<usize, GlbDecodeError> {
    match property_type {
        "SCALAR" => Ok(1),
        "VEC2" => Ok(2),
        "VEC3" => Ok(3),
        "VEC4" | "MAT2" => Ok(4),
        "MAT3" => Ok(9),
        "MAT4" => Ok(16),
        _ => Err(invalid(
            "EXT_structural_metadata property type is unsupported",
        )),
    }
}

fn apply_property_semantics(
    class_property: &serde_json::Map<String, Value>,
    table_property: &serde_json::Map<String, Value>,
    raw: Value,
) -> Result<Value, GlbDecodeError> {
    if class_property.get("noData") == Some(&raw) {
        return Ok(class_property
            .get("default")
            .cloned()
            .unwrap_or(Value::Null));
    }
    let normalized = class_property
        .get("normalized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let scale = table_property
        .get("scale")
        .or_else(|| class_property.get("scale"));
    let offset = table_property
        .get("offset")
        .or_else(|| class_property.get("offset"));
    if !normalized && scale.is_none() && offset.is_none() {
        return Ok(raw);
    }
    let component_type = class_property
        .get("componentType")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            invalid("EXT_structural_metadata numeric transform has no component type")
        })?;
    transform_property_components(&raw, normalized, component_type, scale, offset)
}

fn decode_property_texture_bytes(
    class_property: &serde_json::Map<String, Value>,
    property: &serde_json::Map<String, Value>,
    enum_definition: Option<&Value>,
    bytes: &[u8],
) -> Result<Value, GlbDecodeError> {
    let property_type = class_property
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("property texture type is invalid"))?;
    let is_array = class_property.get("array").and_then(Value::as_bool) == Some(true);
    let count = if is_array {
        class_property
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
            .ok_or_else(|| invalid("property texture array count is invalid"))?
    } else {
        1
    };
    if count > crate::decode_limits::MAX_METADATA_ARRAY_ELEMENTS {
        return Err(invalid("property texture array exceeds the decode budget"));
    }
    if property_type == "BOOLEAN" {
        if count.div_ceil(8) > bytes.len() {
            return Err(invalid("property texture boolean is out of range"));
        }
        let values = (0..count)
            .map(|index| {
                bytes
                    .get(index / 8)
                    .map(|byte| Value::Bool(byte & (1 << (index % 8)) != 0))
                    .ok_or_else(|| invalid("property texture boolean is out of range"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(if is_array {
            Value::Array(values)
        } else {
            values.into_iter().next().expect("one boolean")
        });
    }
    let (components, component_type) = if property_type == "ENUM" {
        let definition = enum_definition
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("property texture enum definition is missing"))?;
        (
            1,
            definition
                .get("valueType")
                .and_then(Value::as_str)
                .unwrap_or("UINT16"),
        )
    } else {
        (
            property_type_components(property_type)?,
            class_property
                .get("componentType")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("property texture component type is invalid"))?,
        )
    };
    let component_bytes = component_size(component_type)?;
    let required_bytes = count
        .checked_mul(components)
        .and_then(|components| components.checked_mul(component_bytes))
        .ok_or_else(|| invalid("property texture byte length overflows"))?;
    if required_bytes > bytes.len() {
        return Err(invalid("property texture value is out of range"));
    }
    let mut elements = Vec::with_capacity(count);
    for element in 0..count {
        let first = element
            .checked_mul(components)
            .and_then(|offset| offset.checked_mul(component_bytes))
            .ok_or_else(|| invalid("property texture element offset overflows"))?;
        let values = (0..components)
            .map(|component| {
                decode_component(bytes, first + component * component_bytes, component_type)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let raw = if components == 1 {
            values.into_iter().next().expect("one component")
        } else {
            Value::Array(values)
        };
        elements.push(if property_type == "ENUM" {
            decode_texture_enum_value(
                enum_definition.expect("validated enum definition"),
                class_property,
                &raw,
            )?
        } else {
            apply_property_semantics(class_property, property, raw)?
        });
    }
    Ok(if is_array {
        Value::Array(elements)
    } else {
        elements.into_iter().next().expect("one element")
    })
}

fn decode_texture_enum_value(
    definition: &Value,
    class_property: &serde_json::Map<String, Value>,
    raw: &Value,
) -> Result<Value, GlbDecodeError> {
    let entry = definition
        .get("values")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries.iter().find(|entry| {
                entry.get("value").is_some_and(|value| {
                    value
                        .as_i64()
                        .zip(raw.as_i64())
                        .is_some_and(|(left, right)| left == right)
                        || value
                            .as_u64()
                            .zip(raw.as_u64())
                            .is_some_and(|(left, right)| left == right)
                })
            })
        })
        .and_then(|entry| entry.get("name"))
        .and_then(Value::as_str)
        .map(|name| Value::String(name.to_owned()))
        .ok_or_else(|| invalid("property texture enum value is undefined"))?;
    apply_property_semantics(class_property, &serde_json::Map::new(), entry)
}

fn transform_property_components(
    raw: &Value,
    normalized: bool,
    component_type: &str,
    scale: Option<&Value>,
    offset: Option<&Value>,
) -> Result<Value, GlbDecodeError> {
    if let Some(values) = raw.as_array() {
        if values.iter().any(Value::is_array) {
            return Ok(Value::Array(
                values
                    .iter()
                    .map(|value| {
                        transform_property_components(
                            value,
                            normalized,
                            component_type,
                            scale,
                            offset,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ));
        }
        return Ok(Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    transform_property_number(
                        value,
                        normalized,
                        component_type,
                        component_parameter(scale, index),
                        component_parameter(offset, index),
                    )
                })
                .collect::<Result<Vec<_>, _>>()?,
        ));
    }
    transform_property_number(raw, normalized, component_type, scale, offset)
}

fn component_parameter(value: Option<&Value>, index: usize) -> Option<&Value> {
    value.and_then(|value| {
        value
            .as_array()
            .and_then(|values| values.get(index))
            .or(Some(value))
    })
}

fn transform_property_number(
    raw: &Value,
    normalized: bool,
    component_type: &str,
    scale: Option<&Value>,
    offset: Option<&Value>,
) -> Result<Value, GlbDecodeError> {
    let mut value = raw
        .as_f64()
        .ok_or_else(|| invalid("EXT_structural_metadata transformed value is not numeric"))?;
    if normalized {
        value = match component_type {
            "INT8" => (value / f64::from(i8::MAX)).max(-1.0),
            "UINT8" => value / f64::from(u8::MAX),
            "INT16" => (value / f64::from(i16::MAX)).max(-1.0),
            "UINT16" => value / f64::from(u16::MAX),
            "INT32" => (value / f64::from(i32::MAX)).max(-1.0),
            "UINT32" => value / f64::from(u32::MAX),
            "INT64" => (value / 9.223_372_036_854_776e18).max(-1.0),
            "UINT64" => value / 1.844_674_407_370_955_2e19,
            _ => {
                return Err(invalid(
                    "EXT_structural_metadata normalized component type is invalid",
                ));
            }
        };
    }
    let scale = scale.map_or(Ok(1.0), json_number)?;
    let offset = offset.map_or(Ok(0.0), json_number)?;
    finite_float_json(offset + scale * value)
}

fn json_number(value: &Value) -> Result<f64, GlbDecodeError> {
    value
        .as_f64()
        .ok_or_else(|| invalid("EXT_structural_metadata transform parameter is not numeric"))
}

fn component_size(component_type: &str) -> Result<usize, GlbDecodeError> {
    match component_type {
        "INT8" | "UINT8" => Ok(1),
        "INT16" | "UINT16" => Ok(2),
        "INT32" | "UINT32" | "FLOAT32" => Ok(4),
        "INT64" | "UINT64" | "FLOAT64" => Ok(8),
        _ => Err(invalid(
            "EXT_structural_metadata component type is unsupported",
        )),
    }
}

fn decode_component(
    bytes: &[u8],
    offset: usize,
    component_type: &str,
) -> Result<Value, GlbDecodeError> {
    let value = match component_type {
        "INT8" => Value::from(i64::from(i8::from_le_bytes(read_bytes(bytes, offset)?))),
        "UINT8" => Value::from(u64::from(read_bytes::<1>(bytes, offset)?[0])),
        "INT16" => Value::from(i64::from(i16::from_le_bytes(read_bytes(bytes, offset)?))),
        "UINT16" => Value::from(u64::from(u16::from_le_bytes(read_bytes(bytes, offset)?))),
        "INT32" => Value::from(i64::from(i32::from_le_bytes(read_bytes(bytes, offset)?))),
        "UINT32" => Value::from(u64::from(u32::from_le_bytes(read_bytes(bytes, offset)?))),
        "INT64" => exact_i64_json(i64::from_le_bytes(read_bytes(bytes, offset)?)),
        "UINT64" => exact_u64_json(u64::from_le_bytes(read_bytes(bytes, offset)?)),
        "FLOAT32" => finite_float_json(f64::from(f32::from_le_bytes(read_bytes(bytes, offset)?)))?,
        "FLOAT64" => finite_float_json(f64::from_le_bytes(read_bytes(bytes, offset)?))?,
        _ => {
            return Err(invalid(
                "EXT_structural_metadata component type is unsupported",
            ));
        }
    };
    Ok(value)
}

fn decode_unsigned_component(
    bytes: &[u8],
    offset: usize,
    component_type: &str,
) -> Result<u64, GlbDecodeError> {
    match component_type {
        "UINT8" => Ok(u64::from(read_bytes::<1>(bytes, offset)?[0])),
        "UINT16" => Ok(u64::from(u16::from_le_bytes(read_bytes(bytes, offset)?))),
        "UINT32" => Ok(u64::from(u32::from_le_bytes(read_bytes(bytes, offset)?))),
        "UINT64" => Ok(u64::from_le_bytes(read_bytes(bytes, offset)?)),
        _ => Err(invalid(
            "EXT_structural_metadata unsigned component type is invalid",
        )),
    }
}

fn read_offset(bytes: &[u8], index: usize, offset_type: &str) -> Result<usize, GlbDecodeError> {
    let size = component_size(offset_type)?;
    let byte_offset = index
        .checked_mul(size)
        .ok_or_else(|| invalid("EXT_structural_metadata offset index overflows"))?;
    let value = decode_unsigned_component(bytes, byte_offset, offset_type)?;
    usize::try_from(value)
        .map_err(|_| invalid("EXT_structural_metadata offset exceeds address space"))
}

fn read_bytes<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], GlbDecodeError> {
    bytes
        .get(offset..offset.saturating_add(N))
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| invalid("EXT_structural_metadata property value is out of range"))
}

fn finite_float_json(value: f64) -> Result<Value, GlbDecodeError> {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| invalid("EXT_structural_metadata float is not finite"))
}

fn exact_i64_json(value: i64) -> Value {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        Value::from(value)
    } else {
        serde_json::json!({ "integerType": "INT64", "value": value.to_string() })
    }
}

fn exact_u64_json(value: u64) -> Value {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if value <= MAX_SAFE_INTEGER {
        Value::from(value)
    } else {
        serde_json::json!({ "integerType": "UINT64", "value": value.to_string() })
    }
}

fn object_array(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<Vec<Value>, GlbDecodeError> {
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid(&format!("EXT_structural_metadata.{key} is not an array")))?;
    if values.iter().any(|entry| !entry.is_object()) {
        return Err(invalid(&format!(
            "EXT_structural_metadata.{key} contains a non-object"
        )));
    }
    Ok(values.clone())
}

fn required_u32(value: Option<&Value>, field: &str) -> Result<u32, GlbDecodeError> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| invalid(&format!("EXT_mesh_features.{field} is invalid")))
}

fn optional_u32(value: Option<&Value>, field: &str) -> Result<Option<u32>, GlbDecodeError> {
    value
        .map(|value| required_u32(Some(value), field))
        .transpose()
}

fn required_metadata_u32(value: Option<&Value>, field: &str) -> Result<u32, GlbDecodeError> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| invalid(&format!("EXT_structural_metadata.{field} is invalid")))
}

fn optional_metadata_u32(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<u32>, GlbDecodeError> {
    value
        .map(|value| required_metadata_u32(Some(value), field))
        .transpose()
}

fn valid_label(label: &str) -> bool {
    let mut characters = label.chars();
    characters
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn invalid(message: &str) -> GlbDecodeError {
    GlbDecodeError::InvalidDocument(message.to_owned())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::DecodedStructuralMetadata;

    #[test]
    fn decodes_boolean_string_arrays_and_applies_numeric_semantics_in_order() {
        let metadata = DecodedStructuralMetadata {
            schema: Some(json!({
                "classes": {
                    "asset": {
                        "properties": {
                            "flags": { "type": "BOOLEAN", "array": true, "count": 3 },
                            "names": { "type": "STRING", "array": true },
                            "quality": {
                                "type": "SCALAR",
                                "componentType": "UINT8",
                                "normalized": true,
                                "scale": 2,
                                "offset": 10,
                                "noData": 255,
                                "default": -1
                            }
                        }
                    }
                }
            })),
            schema_uri: None,
            property_tables: vec![json!({
                "class": "asset",
                "count": 2,
                "properties": {
                    "flags": { "values": 0 },
                    "names": {
                        "values": 1,
                        "stringOffsets": 2,
                        "arrayOffsets": 3
                    },
                    "quality": { "values": 4, "scale": 4 }
                }
            })],
            property_textures: Vec::new(),
            property_attributes: Vec::new(),
            property_table_buffer_views: BTreeMap::from([
                (0, vec![0b0010_1101]),
                (1, b"abcz".to_vec()),
                (2, u32_bytes(&[0, 1, 3, 4])),
                (3, u32_bytes(&[0, 2, 3])),
                (4, vec![128, 255]),
            ]),
        };

        let first = metadata.property_table_row(0, 0).expect("first row");
        assert_eq!(first["flags"], json!([true, false, true]));
        assert_eq!(first["names"], json!(["a", "bc"]));
        assert!(
            (first["quality"].as_f64().expect("quality") - (10.0 + 4.0 * 128.0 / 255.0)).abs()
                < 1.0e-12
        );
        let second = metadata.property_table_row(0, 1).expect("second row");
        assert_eq!(second["flags"], json!([true, false, true]));
        assert_eq!(second["names"], json!(["z"]));
        assert_eq!(second["quality"], -1);
    }

    #[test]
    fn rejects_property_array_bomb_before_json_value_allocation() {
        let metadata = DecodedStructuralMetadata {
            schema: Some(json!({
                "classes": {
                    "asset": {
                        "properties": {
                            "values": {
                                "type": "SCALAR",
                                "componentType": "UINT8",
                                "array": true,
                                "count": 1_000_001
                            }
                        }
                    }
                }
            })),
            schema_uri: None,
            property_tables: vec![json!({
                "class": "asset",
                "count": 1,
                "properties": { "values": { "values": 0 } }
            })],
            property_textures: Vec::new(),
            property_attributes: Vec::new(),
            property_table_buffer_views: BTreeMap::new(),
        };
        let error = metadata
            .property_table_row(0, 0)
            .expect_err("oversized metadata array");
        assert!(error.to_string().contains("decode budget"));
    }

    fn u32_bytes(values: &[u32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }
}
