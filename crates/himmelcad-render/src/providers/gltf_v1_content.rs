//! Sandboxed glTF 1.0 compatibility for legacy `b3dm` archives.

use std::collections::BTreeMap;
use std::io::Cursor;

use glam::{DMat3, DMat4, DVec3, DVec4};
use gltf_v1::json::accessor::{ComponentType, Type};
use gltf_v1::json::mesh::{PrimitiveMode, Semantic};
use gltf_v1::material::TexProperty;
use image::{ColorType, ImageEncoder};

use super::gltf_content::{
    DecodedAlphaMode, DecodedGlb, DecodedImage, DecodedMaterial, DecodedMeshPrimitive,
    DecodedMeshVertex, GlbDecodeError,
};
use super::gltf_metadata::{
    decoded_legacy_batch_ids, legacy_float_batch_id, DecodedLegacyBatchIds,
};
use crate::{WorldTransform, WorldVec3};

pub(super) fn decode_glb_v1(
    bytes: &[u8],
    content_transform: WorldTransform,
    world_origin: WorldVec3,
) -> Result<DecodedGlb, GlbDecodeError> {
    decode_glb_v1_with_origin(bytes, content_transform, Some(world_origin))
}

pub(super) fn decode_glb_v1_intrinsic(
    bytes: &[u8],
    content_transform: WorldTransform,
) -> Result<DecodedGlb, GlbDecodeError> {
    decode_glb_v1_with_origin(bytes, content_transform, None)
}

fn decode_glb_v1_with_origin(
    bytes: &[u8],
    content_transform: WorldTransform,
    explicit_origin: Option<WorldVec3>,
) -> Result<DecodedGlb, GlbDecodeError> {
    let raw_document = glb_v1_json(bytes)?;
    let rtc_center = glb_v1_rtc_center(&raw_document)?;
    let batch_bindings = legacy_batch_bindings(&raw_document)?;
    // Legacy 3D Tiles adds `_BATCHID`, which the generic glTF 1 validator does
    // not recognize. Geometry access below validates every consumed range and
    // ignores only unknown semantics.
    let gltf = gltf_v1::Gltf::from_slice_without_validation(bytes)
        .map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))?;
    validate_material_techniques(&gltf.document)?;
    let buffers = gltf_v1::import_buffers(&gltf.document, None, gltf.blob.clone())
        .map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))?;
    let accessors = gltf
        .document
        .accessors()
        .map(|accessor| (accessor.index().to_owned(), accessor))
        .collect::<BTreeMap<_, _>>();
    let (images, image_indices) = decode_images(&gltf, &buffers)?;
    let scene = gltf
        .default_scene()
        .or_else(|| gltf.scenes().next())
        .ok_or_else(|| GlbDecodeError::InvalidDocument("scene is missing".to_owned()))?;
    let y_up_to_z_up = DMat4::from_cols(
        DVec4::new(1.0, 0.0, 0.0, 0.0),
        DVec4::new(0.0, 0.0, 1.0, 0.0),
        DVec4::new(0.0, -1.0, 0.0, 0.0),
        DVec4::W,
    );
    let root_transform = DMat4::from_cols_array(&content_transform.0)
        * DMat4::from_translation(rtc_center)
        * y_up_to_z_up;
    // The intrinsic bounds pass streams accessor bytes without retaining a
    // duplicate f64 vertex array; a second read produces the permanent f32
    // leaf-local vertices after the stable anchor is known.
    let world_origin = explicit_origin.map_or_else(
        || intrinsic_scene_origin(&scene, root_transform, &buffers),
        Ok,
    )?;
    let mut primitives = Vec::new();
    for node in scene.nodes() {
        decode_node(
            &node,
            root_transform,
            &buffers,
            &image_indices,
            &batch_bindings,
            &accessors,
            world_origin,
            &mut primitives,
        )?;
    }
    Ok(DecodedGlb {
        world_origin,
        primitives,
        images,
        feature_images: std::collections::BTreeMap::new(),
        structural_metadata: None,
    })
}

fn validate_material_techniques(document: &gltf_v1::Document) -> Result<(), GlbDecodeError> {
    let root = document.as_json();
    for material in root.materials.values() {
        let technique = material.technique.as_ref().ok_or_else(|| {
            GlbDecodeError::InvalidDocument("glTF 1 material has no technique".to_owned())
        })?;
        if !root.techniques.contains_key(technique.value()) {
            return Err(GlbDecodeError::InvalidDocument(
                "glTF 1 material references a missing technique".to_owned(),
            ));
        }
    }
    for mesh in root.meshes.values() {
        for primitive in &mesh.primitives {
            if !root.materials.contains_key(primitive.material.value()) {
                return Err(GlbDecodeError::InvalidDocument(
                    "glTF 1 primitive references a missing material".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn glb_v1_json(bytes: &[u8]) -> Result<serde_json::Value, GlbDecodeError> {
    const HEADER_BYTES: usize = 20;
    if bytes.len() < HEADER_BYTES || bytes.get(..4) != Some(b"glTF") {
        return Err(GlbDecodeError::InvalidDocument(
            "invalid GLB 1 header".to_owned(),
        ));
    }
    let read = |offset: usize| {
        bytes
            .get(offset..offset + 4)
            .and_then(|value| value.try_into().ok())
            .map(u32::from_le_bytes)
            .ok_or_else(|| GlbDecodeError::InvalidDocument("truncated GLB 1 header".to_owned()))
    };
    if read(4)? != 1 {
        return Err(GlbDecodeError::InvalidDocument(
            "unsupported GLB 1 version".to_owned(),
        ));
    }
    let declared = usize::try_from(read(8)?)
        .map_err(|_| GlbDecodeError::InvalidDocument("GLB 1 is too large".to_owned()))?;
    if declared != bytes.len() || !declared.is_multiple_of(4) {
        return Err(GlbDecodeError::InvalidDocument(
            "invalid GLB 1 byteLength".to_owned(),
        ));
    }
    let json_length = usize::try_from(read(12)?)
        .map_err(|_| GlbDecodeError::InvalidDocument("GLB 1 JSON is too large".to_owned()))?;
    let body_offset = HEADER_BYTES
        .checked_add(json_length)
        .filter(|offset| *offset <= bytes.len())
        .ok_or_else(|| GlbDecodeError::InvalidDocument("truncated GLB 1 JSON".to_owned()))?;
    if json_length == 0 || !body_offset.is_multiple_of(4) || read(16)? != 0 {
        return Err(GlbDecodeError::InvalidDocument(
            "invalid GLB 1 JSON header".to_owned(),
        ));
    }
    let json = bytes
        .get(HEADER_BYTES..body_offset)
        .ok_or_else(|| GlbDecodeError::InvalidDocument("truncated GLB 1 JSON".to_owned()))?;
    serde_json::from_slice(json).map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))
}

fn glb_v1_rtc_center(document: &serde_json::Value) -> Result<DVec3, GlbDecodeError> {
    let Some(extension) = document
        .get("extensions")
        .and_then(|extensions| extensions.get("CESIUM_RTC"))
    else {
        return Ok(DVec3::ZERO);
    };
    let center = extension
        .get("center")
        .and_then(serde_json::Value::as_array)
        .filter(|center| center.len() == 3)
        .ok_or_else(|| {
            GlbDecodeError::InvalidDocument(
                "CESIUM_RTC.center must contain three numbers".to_owned(),
            )
        })?;
    let center = DVec3::new(
        center[0].as_f64().ok_or_else(|| {
            GlbDecodeError::InvalidDocument("CESIUM_RTC.center[0] is not a number".to_owned())
        })?,
        center[1].as_f64().ok_or_else(|| {
            GlbDecodeError::InvalidDocument("CESIUM_RTC.center[1] is not a number".to_owned())
        })?,
        center[2].as_f64().ok_or_else(|| {
            GlbDecodeError::InvalidDocument("CESIUM_RTC.center[2] is not a number".to_owned())
        })?,
    );
    if !center.is_finite() {
        return Err(GlbDecodeError::CoordinateRange);
    }
    Ok(center)
}

fn legacy_batch_bindings(
    document: &serde_json::Value,
) -> Result<BTreeMap<String, BTreeMap<usize, String>>, GlbDecodeError> {
    let mut bindings = BTreeMap::new();
    let Some(meshes) = document
        .get("meshes")
        .and_then(serde_json::Value::as_object)
    else {
        return Ok(bindings);
    };
    for (mesh_id, mesh) in meshes {
        let primitives = mesh
            .get("primitives")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                GlbDecodeError::InvalidDocument("glTF 1 mesh primitives are invalid".to_owned())
            })?;
        for (primitive_index, primitive) in primitives.iter().enumerate() {
            let Some(accessor) = primitive
                .get("attributes")
                .and_then(|attributes| attributes.get("_BATCHID"))
            else {
                continue;
            };
            let accessor = accessor.as_str().ok_or_else(|| {
                GlbDecodeError::InvalidDocument(
                    "glTF 1 _BATCHID accessor reference is invalid".to_owned(),
                )
            })?;
            bindings
                .entry(mesh_id.clone())
                .or_insert_with(BTreeMap::new)
                .insert(primitive_index, accessor.to_owned());
        }
    }
    Ok(bindings)
}

fn intrinsic_scene_origin(
    scene: &gltf_v1::scene::Scene<'_>,
    root_transform: DMat4,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
) -> Result<WorldVec3, GlbDecodeError> {
    let mut bounds = None;
    for node in scene.nodes() {
        accumulate_node_bounds(&node, root_transform, buffers, &mut bounds)?;
    }
    let (minimum, maximum) = bounds.ok_or(GlbDecodeError::MissingPositions)?;
    let center = minimum + (maximum - minimum) * 0.5;
    if !center.is_finite() {
        return Err(GlbDecodeError::CoordinateRange);
    }
    Ok(WorldVec3 {
        x: center.x,
        y: center.y,
        z: center.z,
    })
}

fn accumulate_node_bounds(
    node: &gltf_v1::Node<'_>,
    parent_transform: DMat4,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
    bounds: &mut Option<(DVec3, DVec3)>,
) -> Result<(), GlbDecodeError> {
    let transform = parent_transform * node_transform(node);
    for mesh in node.meshes() {
        for primitive in mesh.primitives() {
            let accessor = primitive
                .get(&Semantic::Positions)
                .ok_or(GlbDecodeError::MissingPositions)?;
            for position in read_f32_vectors(&accessor, buffers, 3)? {
                let homogeneous = transform * DVec3::from_array(position).extend(1.0);
                if !homogeneous.is_finite() || homogeneous.w.abs() <= f64::EPSILON {
                    return Err(GlbDecodeError::CoordinateRange);
                }
                let world = homogeneous.truncate() / homogeneous.w;
                if let Some((minimum, maximum)) = bounds {
                    *minimum = minimum.min(world);
                    *maximum = maximum.max(world);
                } else {
                    *bounds = Some((world, world));
                }
            }
        }
    }
    for child in node.children() {
        accumulate_node_bounds(&child, transform, buffers, bounds)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn decode_node(
    node: &gltf_v1::Node<'_>,
    parent_transform: DMat4,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
    image_indices: &BTreeMap<String, usize>,
    batch_bindings: &BTreeMap<String, BTreeMap<usize, String>>,
    accessors: &BTreeMap<String, gltf_v1::Accessor<'_>>,
    world_origin: WorldVec3,
    output: &mut Vec<DecodedMeshPrimitive>,
) -> Result<(), GlbDecodeError> {
    let transform = parent_transform * node_transform(node);
    for mesh in node.meshes() {
        for primitive in mesh.primitives() {
            let batch_accessor = batch_bindings
                .get(mesh.index())
                .and_then(|primitives| primitives.get(&primitive.index()))
                .and_then(|accessor| accessors.get(accessor));
            output.push(decode_primitive(
                &primitive,
                transform,
                buffers,
                image_indices,
                batch_accessor,
                world_origin,
            )?);
        }
    }
    for child in node.children() {
        decode_node(
            &child,
            transform,
            buffers,
            image_indices,
            batch_bindings,
            accessors,
            world_origin,
            output,
        )?;
    }
    Ok(())
}

#[allow(clippy::cast_possible_truncation)]
fn decode_primitive(
    primitive: &gltf_v1::mesh::Primitive<'_>,
    transform: DMat4,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
    image_indices: &BTreeMap<String, usize>,
    batch_accessor: Option<&gltf_v1::Accessor<'_>>,
    world_origin: WorldVec3,
) -> Result<DecodedMeshPrimitive, GlbDecodeError> {
    let position_accessor = primitive
        .get(&Semantic::Positions)
        .ok_or(GlbDecodeError::MissingPositions)?;
    let source_positions = read_f32_vectors(&position_accessor, buffers, 3)?;
    let mut indices = primitive.indices().map_or_else(
        || {
            (0..source_positions.len())
                .map(u32::try_from)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| GlbDecodeError::InvalidPrimitive)
        },
        |accessor| read_indices(&accessor, buffers),
    )?;
    indices = triangle_indices(primitive.mode(), &indices)?;
    if indices
        .iter()
        .any(|index| usize::try_from(*index).map_or(true, |index| index >= source_positions.len()))
    {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let source_normals = primitive
        .get(&Semantic::Normals)
        .map(|accessor| read_f32_vectors(&accessor, buffers, 3))
        .transpose()?;
    let tex_coords = primitive
        .get(&Semantic::TexCoords(0))
        .map(|accessor| read_f32_vectors(&accessor, buffers, 2))
        .transpose()?;
    let has_texture_coordinates = tex_coords.is_some();
    let colors = primitive
        .get(&Semantic::Colors(0))
        .map(|accessor| read_colors(&accessor, buffers))
        .transpose()?;
    for count in [
        source_normals.as_ref().map(Vec::len),
        tex_coords.as_ref().map(Vec::len),
        colors.as_ref().map(Vec::len),
    ]
    .into_iter()
    .flatten()
    {
        if count != source_positions.len() {
            return Err(GlbDecodeError::InvalidPrimitive);
        }
    }
    let normal_matrix = normal_transform(transform)?;
    let origin = DVec3::new(world_origin.x, world_origin.y, world_origin.z);
    let mut vertices = Vec::with_capacity(source_positions.len());
    let mut exact_positions = Vec::with_capacity(source_positions.len());
    for (index, position) in source_positions.into_iter().enumerate() {
        let world = transform * DVec3::from_array(position).extend(1.0);
        if !world.is_finite() || world.w.abs() <= f64::EPSILON {
            return Err(GlbDecodeError::CoordinateRange);
        }
        let normal = source_normals.as_ref().map_or([0.0; 3], |normals| {
            let transformed = normal_matrix * DVec3::from_array(normals[index]);
            if transformed.length_squared() > f64::EPSILON {
                transformed.normalize().as_vec3().to_array()
            } else {
                [0.0; 3]
            }
        });
        let relative = world.truncate() / world.w - origin;
        exact_positions.push(WorldVec3 {
            x: relative.x,
            y: relative.y,
            z: relative.z,
        });
        vertices.push(DecodedMeshVertex {
            position: f32_vec(relative)?,
            normal,
            tex_coord: tex_coords
                .as_ref()
                .map_or([0.0; 2], |values| values[index].map(|value| value as f32)),
            color: colors.as_ref().map_or([1.0; 4], |values| values[index]),
        });
    }
    if source_normals.is_none() {
        generate_normals(&mut vertices, &indices);
    }
    let legacy_batch_ids = batch_accessor
        .map(|accessor| read_legacy_batch_ids(accessor, buffers, vertices.len(), &indices))
        .transpose()?;
    let material = primitive.material();
    Ok(DecodedMeshPrimitive {
        exact_positions,
        vertices,
        has_texture_coordinates,
        indices,
        material: decode_material(&material, image_indices),
        features: Vec::new(),
        legacy_batch_ids,
        property_attributes: Vec::new(),
        property_textures: Vec::new(),
    })
}

fn decode_material(
    material: &gltf_v1::material::Material<'_>,
    image_indices: &BTreeMap<String, usize>,
) -> DecodedMaterial {
    let diffuse = material.diffuse();
    let (base_color_factor, base_color_image) = match diffuse {
        TexProperty::Color(color) => (color, None),
        TexProperty::Texture(texture) => (
            [1.0; 4],
            image_indices.get(texture.source().index()).copied(),
        ),
    };
    let base_color_image = base_color_image.or_else(|| {
        [material.ambient(), material.emission()]
            .into_iter()
            .find_map(|property| match property {
                TexProperty::Texture(texture) => {
                    image_indices.get(texture.source().index()).copied()
                }
                TexProperty::Color(_) => None,
            })
    });
    let opacity = material.transparency().clamp(0.0, 1.0);
    let mut base_color_factor = base_color_factor;
    base_color_factor[3] *= opacity;
    DecodedMaterial {
        base_color_factor,
        base_color_image,
        base_color_tex_coord: 0,
        alpha_mode: if material.transparent() || base_color_factor[3] < 1.0 {
            DecodedAlphaMode::Blend
        } else {
            DecodedAlphaMode::Opaque
        },
        double_sided: material.double_sided(),
    }
}

fn decode_images(
    gltf: &gltf_v1::Gltf,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
) -> Result<(Vec<DecodedImage>, BTreeMap<String, usize>), GlbDecodeError> {
    let decoded = gltf_v1::import_images(&gltf.document, None, buffers)
        .map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))?;
    let mut images = Vec::with_capacity(decoded.len());
    let mut indices = BTreeMap::new();
    for image in gltf.images() {
        let data = decoded
            .get(image.index())
            .ok_or_else(|| GlbDecodeError::InvalidDocument("image data is missing".to_owned()))?;
        let rgba = image_to_rgba(data)?;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(Cursor::new(&mut png))
            .write_image(&rgba, data.width, data.height, ColorType::Rgba8.into())
            .map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))?;
        indices.insert(image.index().to_owned(), images.len());
        images.push(DecodedImage {
            mime_type: "image/png".to_owned(),
            bytes: png,
        });
    }
    Ok((images, indices))
}

fn image_to_rgba(data: &gltf_v1::image::Data) -> Result<Vec<u8>, GlbDecodeError> {
    use gltf_v1::image::Format;
    match data.format {
        Format::R8G8B8A8 => Ok(data.pixels.clone()),
        Format::R8G8B8 => Ok(data
            .pixels
            .chunks_exact(3)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect()),
        Format::R8 => Ok(data
            .pixels
            .iter()
            .flat_map(|value| [*value, *value, *value, 255])
            .collect()),
        _ => Err(GlbDecodeError::InvalidDocument(
            "unsupported glTF 1 image pixel format".to_owned(),
        )),
    }
}

fn accessor_bytes<'a>(
    accessor: &gltf_v1::Accessor<'_>,
    buffers: &'a indexmap::IndexMap<String, gltf_v1::buffer::Data>,
) -> Result<(&'a [u8], usize), GlbDecodeError> {
    let view = accessor.view();
    let buffer = buffers
        .get(view.buffer().index())
        .ok_or(GlbDecodeError::MissingBinaryBlob)?;
    let components = usize::try_from(accessor.accessor_type().get_num_components())
        .map_err(|_| GlbDecodeError::InvalidPrimitive)?;
    let element_size = usize::try_from(accessor.component_type().size())
        .ok()
        .and_then(|size| size.checked_mul(components))
        .ok_or(GlbDecodeError::InvalidPrimitive)?;
    // glTF 1 exporters commonly serialize zero to mean tightly packed.
    let stride = accessor
        .stride()
        .filter(|stride| *stride != 0)
        .unwrap_or(element_size);
    if stride < element_size {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let start = view
        .offset()
        .checked_add(accessor.offset())
        .ok_or(GlbDecodeError::InvalidPrimitive)?;
    let length = accessor
        .count()
        .saturating_sub(1)
        .checked_mul(stride)
        .and_then(|length| length.checked_add(element_size))
        .ok_or(GlbDecodeError::InvalidPrimitive)?;
    let bytes = buffer
        .get(start..start.saturating_add(length))
        .ok_or(GlbDecodeError::InvalidPrimitive)?;
    Ok((bytes, stride))
}

fn read_f32_vectors<const N: usize>(
    accessor: &gltf_v1::Accessor<'_>,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
    components: usize,
) -> Result<Vec<[f64; N]>, GlbDecodeError> {
    if accessor.component_type() != ComponentType::Float
        || usize::try_from(accessor.accessor_type().get_num_components()).ok() != Some(components)
        || components != N
    {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let (bytes, stride) = accessor_bytes(accessor, buffers)?;
    (0..accessor.count())
        .map(|index| {
            let start = index * stride;
            let mut value = [0.0; N];
            for (component, target) in value.iter_mut().enumerate() {
                let offset = start + component * 4;
                *target = f64::from(f32::from_le_bytes(
                    bytes[offset..offset + 4]
                        .try_into()
                        .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                ));
            }
            Ok(value)
        })
        .collect()
}

fn read_indices(
    accessor: &gltf_v1::Accessor<'_>,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
) -> Result<Vec<u32>, GlbDecodeError> {
    if accessor.accessor_type() != Type::SCALAR {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let (bytes, stride) = accessor_bytes(accessor, buffers)?;
    (0..accessor.count())
        .map(|index| {
            let start = index * stride;
            match accessor.component_type() {
                ComponentType::UnsignedByte => Ok(u32::from(bytes[start])),
                ComponentType::UnsignedShort => Ok(u32::from(u16::from_le_bytes(
                    bytes[start..start + 2]
                        .try_into()
                        .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                ))),
                ComponentType::UnsignedInt => Ok(u32::from_le_bytes(
                    bytes[start..start + 4]
                        .try_into()
                        .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                )),
                _ => Err(GlbDecodeError::InvalidPrimitive),
            }
        })
        .collect()
}

fn read_legacy_batch_ids(
    accessor: &gltf_v1::Accessor<'_>,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
    vertex_count: usize,
    triangle_indices: &[u32],
) -> Result<DecodedLegacyBatchIds, GlbDecodeError> {
    if accessor.accessor_type() != Type::SCALAR || accessor.count() != vertex_count {
        return Err(GlbDecodeError::InvalidDocument(
            "glTF 1 legacy _BATCHID accessor is invalid".to_owned(),
        ));
    }
    let (bytes, stride) = accessor_bytes(accessor, buffers)?;
    let vertex_ids = (0..accessor.count())
        .map(|index| {
            let start = index
                .checked_mul(stride)
                .ok_or(GlbDecodeError::InvalidPrimitive)?;
            match accessor.component_type() {
                ComponentType::Byte => {
                    u32::try_from(i8::from_le_bytes([bytes[start]])).map_err(|_| {
                        GlbDecodeError::InvalidDocument(
                            "glTF 1 legacy _BATCHID value is negative".to_owned(),
                        )
                    })
                }
                ComponentType::UnsignedByte => Ok(u32::from(bytes[start])),
                ComponentType::Short => {
                    let value = i16::from_le_bytes(
                        bytes[start..start + 2]
                            .try_into()
                            .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                    );
                    u32::try_from(value).map_err(|_| {
                        GlbDecodeError::InvalidDocument(
                            "glTF 1 legacy _BATCHID value is negative".to_owned(),
                        )
                    })
                }
                ComponentType::UnsignedShort => Ok(u32::from(u16::from_le_bytes(
                    bytes[start..start + 2]
                        .try_into()
                        .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                ))),
                ComponentType::UnsignedInt => Ok(u32::from_le_bytes(
                    bytes[start..start + 4]
                        .try_into()
                        .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                )),
                ComponentType::Float => legacy_float_batch_id(f32::from_le_bytes(
                    bytes[start..start + 4]
                        .try_into()
                        .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                )),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    decoded_legacy_batch_ids(vertex_ids, triangle_indices)
}

fn read_colors(
    accessor: &gltf_v1::Accessor<'_>,
    buffers: &indexmap::IndexMap<String, gltf_v1::buffer::Data>,
) -> Result<Vec<[f32; 4]>, GlbDecodeError> {
    let components = usize::try_from(accessor.accessor_type().get_num_components())
        .map_err(|_| GlbDecodeError::InvalidPrimitive)?;
    if !matches!(components, 3 | 4) {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let (bytes, stride) = accessor_bytes(accessor, buffers)?;
    (0..accessor.count())
        .map(|index| {
            let start = index * stride;
            let mut color = [1.0; 4];
            for (component, target) in color.iter_mut().enumerate().take(components) {
                let offset = start
                    + component
                        * usize::try_from(accessor.component_type().size())
                            .map_err(|_| GlbDecodeError::InvalidPrimitive)?;
                *target = match accessor.component_type() {
                    ComponentType::Float => f32::from_le_bytes(
                        bytes[offset..offset + 4]
                            .try_into()
                            .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                    ),
                    ComponentType::UnsignedByte => f32::from(bytes[offset]) / 255.0,
                    ComponentType::UnsignedShort => {
                        f32::from(u16::from_le_bytes(
                            bytes[offset..offset + 2]
                                .try_into()
                                .map_err(|_| GlbDecodeError::InvalidPrimitive)?,
                        )) / 65_535.0
                    }
                    _ => return Err(GlbDecodeError::InvalidPrimitive),
                };
            }
            Ok(color)
        })
        .collect()
}

fn triangle_indices(mode: PrimitiveMode, source: &[u32]) -> Result<Vec<u32>, GlbDecodeError> {
    match mode {
        PrimitiveMode::Triangles if source.len().is_multiple_of(3) => Ok(source.to_vec()),
        PrimitiveMode::TriangleStrip if source.len() >= 3 => Ok((2..source.len())
            .flat_map(|index| {
                if index % 2 == 0 {
                    [source[index - 2], source[index - 1], source[index]]
                } else {
                    [source[index - 1], source[index - 2], source[index]]
                }
            })
            .collect()),
        PrimitiveMode::TriangleFan if source.len() >= 3 => Ok((2..source.len())
            .flat_map(|index| [source[0], source[index - 1], source[index]])
            .collect()),
        _ => Err(GlbDecodeError::UnsupportedPrimitiveMode),
    }
}

fn node_transform(node: &gltf_v1::Node<'_>) -> DMat4 {
    let matrix = node.transform().matrix();
    DMat4::from_cols_array(&std::array::from_fn(|index| {
        f64::from(matrix[index / 4][index % 4])
    }))
}

fn normal_transform(transform: DMat4) -> Result<DMat3, GlbDecodeError> {
    let linear = DMat3::from_cols(
        transform.x_axis.truncate(),
        transform.y_axis.truncate(),
        transform.z_axis.truncate(),
    );
    if !linear.determinant().is_finite() || linear.determinant().abs() <= f64::EPSILON {
        return Err(GlbDecodeError::CoordinateRange);
    }
    Ok(linear.inverse().transpose())
}

fn generate_normals(vertices: &mut [DecodedMeshVertex], indices: &[u32]) {
    let mut accumulated = vec![DVec3::ZERO; vertices.len()];
    for triangle in indices.chunks_exact(3) {
        let [Ok(a), Ok(b), Ok(c)] = [
            usize::try_from(triangle[0]),
            usize::try_from(triangle[1]),
            usize::try_from(triangle[2]),
        ] else {
            continue;
        };
        let first = DVec3::from_array(vertices[a].position.map(f64::from));
        let second = DVec3::from_array(vertices[b].position.map(f64::from));
        let third = DVec3::from_array(vertices[c].position.map(f64::from));
        let normal = (second - first).cross(third - first);
        accumulated[a] += normal;
        accumulated[b] += normal;
        accumulated[c] += normal;
    }
    for (vertex, normal) in vertices.iter_mut().zip(accumulated) {
        vertex.normal = if normal.length_squared() > f64::EPSILON {
            normal.normalize().as_vec3().to_array()
        } else {
            [0.0, 0.0, 1.0]
        };
    }
}

fn f32_vec(value: DVec3) -> Result<[f32; 3], GlbDecodeError> {
    #[allow(clippy::cast_possible_truncation)]
    let converted = [value.x as f32, value.y as f32, value.z as f32];
    converted
        .iter()
        .all(|component| component.is_finite())
        .then_some(converted)
        .ok_or(GlbDecodeError::CoordinateRange)
}

#[cfg(test)]
mod tests {
    use super::decode_glb_v1;
    use crate::{WorldTransform, WorldVec3};

    #[test]
    fn cesium_rtc_translates_after_y_up_to_z_up_conversion() {
        let glb = triangle_glb_v1(Some("[100.0,200.0,300.0]"), None);
        let mut content_transform = WorldTransform::IDENTITY;
        content_transform.0[12] = 10.0;
        content_transform.0[13] = 20.0;
        content_transform.0[14] = 30.0;
        let decoded = decode_glb_v1(
            &glb,
            content_transform,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("GLB 1 CESIUM_RTC");
        assert_eq!(
            decoded.primitives[0].vertices[0].position,
            [110.0, 220.0, 330.0]
        );
        assert_eq!(
            decoded.primitives[0].vertices[2].position,
            [110.0, 220.0, 331.0]
        );
    }

    #[test]
    fn malformed_cesium_rtc_is_rejected_instead_of_silently_ignored() {
        let glb = triangle_glb_v1(Some("[1.0,2.0]"), None);
        let error = decode_glb_v1(
            &glb,
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect_err("malformed center");
        assert!(error.to_string().contains("CESIUM_RTC.center"));
    }

    #[test]
    fn retains_glb_v1_batch_ids_in_exact_source_triangle_order() {
        let decoded = decode_glb_v1(
            &triangle_glb_v1(None, Some([0.0, 1.0, 1.0])),
            WorldTransform::IDENTITY,
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("GLB 1 _BATCHID");
        let ids = decoded.primitives[0]
            .legacy_batch_ids
            .as_ref()
            .expect("legacy feature IDs");
        assert_eq!(ids.vertex_ids, [0, 1, 1]);
        assert_eq!(ids.triangle_vertex_ids, [[0, 1, 1]]);
        assert_eq!(
            ids.feature_id_at_triangle(0, [0.8, 0.1, 0.1]),
            Some(crate::DecodedTriangleFeatureId::Feature(0))
        );
    }

    fn triangle_glb_v1(rtc_center: Option<&str>, batch_ids: Option<[f32; 3]>) -> Vec<u8> {
        let mut body = Vec::new();
        for position in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for component in position {
                body.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2] {
            body.extend(index.to_le_bytes());
        }
        while !body.len().is_multiple_of(4) {
            body.push(0);
        }
        let batch_offset = body.len();
        if let Some(batch_ids) = batch_ids {
            for feature_id in batch_ids {
                body.extend(feature_id.to_le_bytes());
            }
        }
        let body_byte_length = body.len();
        while !body.len().is_multiple_of(4) {
            body.push(0);
        }
        let rtc = rtc_center.map_or_else(String::new, |center| {
            format!(
                r#","extensionsUsed":["CESIUM_RTC"],"extensions":{{"CESIUM_RTC":{{"center":{center}}}}}"#
            )
        });
        let batch_view = batch_ids.map_or_else(String::new, |_| {
            format!(
                r#","batchView":{{"buffer":"binary_glTF","byteOffset":{batch_offset},"byteLength":12,"target":34962}}"#
            )
        });
        let batch_accessor = batch_ids.map_or_else(String::new, |_| {
            r#","batchIds":{"bufferView":"batchView","byteOffset":0,"componentType":5126,"count":3,"type":"SCALAR","min":[0],"max":[1]}"#.to_owned()
        });
        let batch_attribute = batch_ids
            .map(|_| r#","_BATCHID":"batchIds""#)
            .unwrap_or_default();
        let mut json = format!(
            r#"{{"asset":{{"version":"1.0"}},"buffers":{{"binary_glTF":{{"uri":"","byteLength":{body_byte_length},"type":"arraybuffer"}}}},"bufferViews":{{"positionsView":{{"buffer":"binary_glTF","byteOffset":0,"byteLength":36,"target":34962}},"indicesView":{{"buffer":"binary_glTF","byteOffset":36,"byteLength":6,"target":34963}}{batch_view}}},"accessors":{{"positions":{{"bufferView":"positionsView","byteOffset":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},"indices":{{"bufferView":"indicesView","byteOffset":0,"componentType":5123,"count":3,"type":"SCALAR","min":[0],"max":[2]}}{batch_accessor}}},"techniques":{{"technique":{{"parameters":{{}},"attributes":{{}},"program":"unused","uniforms":{{}}}}}},"materials":{{"material":{{"technique":"technique","values":{{}}}}}},"meshes":{{"mesh":{{"primitives":[{{"attributes":{{"POSITION":"positions"{batch_attribute}}},"indices":"indices","material":"material","mode":4}}]}}}},"nodes":{{"node":{{"meshes":["mesh"]}}}},"scenes":{{"scene":{{"nodes":["node"]}}}},"scene":"scene"{rtc}}}"#
        )
        .into_bytes();
        while !(20 + json.len()).is_multiple_of(4) {
            json.push(b' ');
        }
        let total = 20 + json.len() + body.len();
        let mut glb = Vec::with_capacity(total);
        glb.extend(*b"glTF");
        glb.extend(1_u32.to_le_bytes());
        glb.extend(u32::try_from(total).expect("GLB length").to_le_bytes());
        glb.extend(
            u32::try_from(json.len())
                .expect("JSON length")
                .to_le_bytes(),
        );
        glb.extend(0_u32.to_le_bytes());
        glb.extend(json);
        glb.extend(body);
        glb
    }
}
