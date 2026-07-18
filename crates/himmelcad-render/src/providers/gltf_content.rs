//! Validated GLB mesh decoding with retained material and texture information.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::{DMat3, DMat4, DVec3};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{WorldTransform, WorldVec3};

use super::gltf_metadata::{
    decode_legacy_batch_ids, decode_mesh_features, decode_primitive_property_attributes,
    decode_primitive_property_textures, decode_structural_metadata, DecodedFeatureIdBinding,
    DecodedFeatureTextureSample, DecodedLegacyBatchIds, DecodedMeshFeatureSet,
    DecodedPrimitivePropertyAttribute, DecodedPrimitivePropertyTexture,
    DecodedPropertyTextureSample, DecodedStructuralMetadata, DecodedTextureWrap,
};
use super::ResolvedAssetBundle;

/// One transformed mesh vertex ready for tile-local GPU packing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DecodedMeshVertex {
    /// Position relative to the selected f64 world origin.
    pub position: [f32; 3],
    /// World-space unit normal.
    pub normal: [f32; 3],
    /// First texture-coordinate set.
    pub tex_coord: [f32; 2],
    /// Linear vertex-color multiplier.
    pub color: [f32; 4],
}

/// glTF material alpha behavior.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum DecodedAlphaMode {
    /// Fully opaque.
    Opaque,
    /// Alpha cutoff.
    Mask {
        /// Fragments below this alpha are discarded.
        cutoff: f32,
    },
    /// Standard alpha blending.
    Blend,
}

/// Render-relevant PBR material properties retained from glTF.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedMaterial {
    /// Linear base-color factor.
    pub base_color_factor: [f32; 4],
    /// Index into [`DecodedGlb::images`] for the base-color texture.
    pub base_color_image: Option<usize>,
    /// Texture-coordinate set requested by the material.
    pub base_color_tex_coord: u32,
    /// Alpha behavior.
    pub alpha_mode: DecodedAlphaMode,
    /// Disable back-face culling.
    pub double_sided: bool,
}

/// One triangle primitive after node and 3D Tiles transforms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedMeshPrimitive {
    /// Exact f64 positions relative to [`DecodedGlb::world_origin`], retained
    /// only until an owned spatial pick index has been built.
    pub exact_positions: Vec<WorldVec3>,
    /// Tile-local vertices.
    pub vertices: Vec<DecodedMeshVertex>,
    /// Whether the source primitive explicitly declared texture coordinates.
    pub has_texture_coordinates: bool,
    /// Triangle-list indices.
    pub indices: Vec<u32>,
    /// Material binding.
    pub material: DecodedMaterial,
    /// Ordered feature ID sets with exact source-triangle classification.
    pub features: Vec<DecodedMeshFeatureSet>,
    /// Legacy `_BATCHID` values in exact source-triangle order.
    pub legacy_batch_ids: Option<DecodedLegacyBatchIds>,
    /// Primitive-bound vertex property metadata with exact source provenance.
    pub property_attributes: Vec<DecodedPrimitivePropertyAttribute>,
    /// Primitive-bound image property metadata.
    pub property_textures: Vec<DecodedPrimitivePropertyTexture>,
}

/// Encoded image retained until the texture decode/upload worker stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedImage {
    /// Declared MIME type such as `image/png` or `image/jpeg`.
    pub mime_type: String,
    /// Exact encoded image bytes from the GLB buffer view.
    pub bytes: Vec<u8>,
}

/// CPU-readable RGBA8 image retained only when a mesh-feature texture refers
/// to the corresponding glTF image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedFeatureImage {
    /// Texel width.
    pub width: u32,
    /// Texel height.
    pub height: u32,
    /// Row-major RGBA8 texels.
    pub rgba8: Vec<u8>,
}

impl DecodedFeatureImage {
    /// Samples the ordered feature-ID channels with glTF nearest filtering and
    /// sampler wrapping. Channel zero is the least-significant byte.
    #[must_use]
    pub fn feature_id(&self, sample: &DecodedFeatureTextureSample) -> Option<u64> {
        let texel = self.texel(sample.tex_coord, sample.wrap_s, sample.wrap_t)?;
        sample
            .channels
            .iter()
            .enumerate()
            .try_fold(0_u64, |feature_id, (byte_index, channel)| {
                let component = u64::from(texel[usize::from(*channel)]);
                Some(feature_id | (component << (byte_index * 8)))
            })
    }

    /// Samples and semantically decodes one property-texture value.
    pub fn property_value(
        &self,
        sample: &DecodedPropertyTextureSample,
    ) -> Result<Value, GlbDecodeError> {
        let texel = self
            .texel(sample.tex_coord, sample.wrap_s, sample.wrap_t)
            .ok_or_else(|| {
                GlbDecodeError::InvalidDocument("property texture sample is invalid".to_owned())
            })?;
        sample.decode_texel(texel)
    }

    fn texel(
        &self,
        tex_coord: [f64; 2],
        wrap_s: DecodedTextureWrap,
        wrap_t: DecodedTextureWrap,
    ) -> Option<[u8; 4]> {
        let x = nearest_texel(tex_coord[0], self.width, wrap_s)?;
        let y = nearest_texel(tex_coord[1], self.height, wrap_t)?;
        let pixel = usize::try_from(y)
            .ok()?
            .checked_mul(usize::try_from(self.width).ok()?)?
            .checked_add(usize::try_from(x).ok()?)?
            .checked_mul(4)?;
        self.rgba8.get(pixel..pixel + 4)?.try_into().ok()
    }
}

/// Complete decoded GLB content tile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedGlb {
    /// Exact origin subtracted before positions became f32.
    pub world_origin: WorldVec3,
    /// Node-instantiated triangle primitives.
    pub primitives: Vec<DecodedMeshPrimitive>,
    /// Embedded encoded images in glTF image-index order.
    pub images: Vec<DecodedImage>,
    /// Decoded feature-ID images keyed by their glTF image index. Unreferenced
    /// material images remain encoded and consume no duplicate CPU pixels.
    pub feature_images: BTreeMap<usize, DecodedFeatureImage>,
    /// Optional structural metadata addressed by primitive feature IDs.
    pub structural_metadata: Option<DecodedStructuralMetadata>,
}

/// GLB document or geometry decoding failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GlbDecodeError {
    /// glTF validation failed.
    InvalidDocument(String),
    /// A buffer or image uses an external URI not supplied with this content.
    ExternalResource(String),
    /// The GLB has no binary payload for its declared buffer views.
    MissingBinaryBlob,
    /// A primitive lacks mandatory positions.
    MissingPositions,
    /// Primitive topology cannot be represented as triangles.
    UnsupportedPrimitiveMode,
    /// Attribute and index counts are inconsistent.
    InvalidPrimitive,
    /// A world/local coordinate or normal transform is non-finite.
    CoordinateRange,
}

impl Display for GlbDecodeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDocument(message) => write!(formatter, "invalid glTF document: {message}"),
            Self::ExternalResource(uri) => write!(formatter, "external glTF resource: {uri}"),
            Self::MissingBinaryBlob => formatter.write_str("GLB binary blob is missing"),
            Self::MissingPositions => formatter.write_str("glTF primitive has no positions"),
            Self::UnsupportedPrimitiveMode => {
                formatter.write_str("glTF primitive is not a triangle topology")
            }
            Self::InvalidPrimitive => formatter.write_str("invalid glTF primitive attributes"),
            Self::CoordinateRange => {
                formatter.write_str("glTF transformed coordinate cannot be represented")
            }
        }
    }
}

impl Error for GlbDecodeError {}

/// Decodes embedded GLB content and applies node plus 3D Tiles transforms in f64.
pub fn decode_glb(
    bytes: &[u8],
    content_transform: WorldTransform,
    world_origin: WorldVec3,
) -> Result<DecodedGlb, GlbDecodeError> {
    decode_glb_with_origin(bytes, content_transform, Some(world_origin))
}

/// Decodes GLB content around an intrinsic f64 anchor derived from its fully
/// transformed world-space geometry rather than from the active camera.
pub fn decode_glb_intrinsic(
    bytes: &[u8],
    content_transform: WorldTransform,
) -> Result<DecodedGlb, GlbDecodeError> {
    decode_glb_with_origin(bytes, content_transform, None)
}

/// Resolves an arbitrary glTF 2.0 JSON/GLB document into one self-contained
/// decode input while preserving the document URI as the relative-reference owner.
pub fn decode_gltf_with_resources(
    document_uri: &str,
    bytes: &[u8],
    resources: &ResolvedAssetBundle,
    content_transform: WorldTransform,
    world_origin: WorldVec3,
) -> Result<DecodedGlb, GlbDecodeError> {
    let materialized =
        super::gltf_materialize::materialize_resolved_gltf(document_uri, bytes, resources)?;
    decode_glb(&materialized, content_transform, world_origin)
}

/// Resource-resolved variant of [`decode_glb_intrinsic`] for JSON glTF, GLB,
/// external buffers/images and external structural-metadata schemas.
pub fn decode_gltf_intrinsic_with_resources(
    document_uri: &str,
    bytes: &[u8],
    resources: &ResolvedAssetBundle,
    content_transform: WorldTransform,
) -> Result<DecodedGlb, GlbDecodeError> {
    let materialized =
        super::gltf_materialize::materialize_resolved_gltf(document_uri, bytes, resources)?;
    decode_glb_intrinsic(&materialized, content_transform)
}

fn decode_glb_with_origin(
    bytes: &[u8],
    content_transform: WorldTransform,
    explicit_origin: Option<WorldVec3>,
) -> Result<DecodedGlb, GlbDecodeError> {
    if bytes.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES {
        return Err(GlbDecodeError::InvalidDocument(
            "glTF content exceeds the encoded leaf limit".to_owned(),
        ));
    }
    if explicit_origin.is_some_and(|origin| !finite_world(origin))
        || content_transform.0.iter().any(|value| !value.is_finite())
    {
        return Err(GlbDecodeError::CoordinateRange);
    }
    if bytes.get(4..8) == Some(1_u32.to_le_bytes().as_slice()) {
        return explicit_origin.map_or_else(
            || super::gltf_v1_content::decode_glb_v1_intrinsic(bytes, content_transform),
            |world_origin| {
                super::gltf_v1_content::decode_glb_v1(bytes, content_transform, world_origin)
            },
        );
    }
    let meshopt_materialized = super::gltf_meshopt::materialize_meshopt_glb(bytes)?;
    let bytes = meshopt_materialized.as_deref().unwrap_or(bytes);
    let draco_materialized = super::gltf_draco::materialize_draco_glb(bytes)?;
    let bytes = draco_materialized.as_deref().unwrap_or(bytes);
    let basisu_materialized = super::gltf_basisu::materialize_basisu_sources(bytes)?;
    let bytes = basisu_materialized.as_deref().unwrap_or(bytes);
    let gltf = gltf::Gltf::from_slice(bytes)
        .map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))?;
    for buffer in gltf.buffers() {
        if let gltf::buffer::Source::Uri(uri) = buffer.source() {
            return Err(GlbDecodeError::ExternalResource(uri.to_owned()));
        }
    }
    let blob = gltf.blob.as_deref();
    if gltf.buffers().next().is_some() && blob.is_none() {
        return Err(GlbDecodeError::MissingBinaryBlob);
    }
    validate_image_budget(&gltf)?;
    let images = decode_images(&gltf, blob)?;
    let structural_metadata = decode_structural_metadata(&gltf, blob)?;
    // glTF is Y-up while the 3D Tiles local Cartesian frame is Z-up. This
    // basis conversion precedes the accumulated tileset transform.
    let y_up_to_z_up = DMat4::from_cols(
        glam::DVec4::new(1.0, 0.0, 0.0, 0.0),
        glam::DVec4::new(0.0, 0.0, 1.0, 0.0),
        glam::DVec4::new(0.0, -1.0, 0.0, 0.0),
        glam::DVec4::W,
    );
    let tile_transform = DMat4::from_cols_array(&content_transform.0) * y_up_to_z_up;
    let mut primitives = Vec::new();
    let scene = gltf
        .default_scene()
        .or_else(|| gltf.scenes().next())
        .ok_or_else(|| GlbDecodeError::InvalidDocument("scene is missing".to_owned()))?;
    // Intrinsic mode deliberately streams POSITION accessors once for f64
    // bounds, then reads them again while constructing final f32 vertices.
    // The GLB document is parsed only once and the bounds pass allocates no
    // per-vertex buffer, bounding peak memory for very large mesh leaves.
    let world_origin =
        explicit_origin.map_or_else(|| intrinsic_scene_origin(&scene, tile_transform, blob), Ok)?;
    let mut budget = MeshDecodeBudget::default();
    for node in scene.nodes() {
        decode_node(
            &gltf,
            &node,
            tile_transform,
            blob,
            world_origin,
            structural_metadata.as_ref(),
            &mut primitives,
            0,
            &mut budget,
        )?;
    }
    let feature_images = decode_feature_images(&primitives, &images)?;
    Ok(DecodedGlb {
        world_origin,
        primitives,
        images,
        feature_images,
        structural_metadata,
    })
}

fn validate_image_budget(gltf: &gltf::Gltf) -> Result<(), GlbDecodeError> {
    let mut retained_bytes = 0_usize;
    for image in gltf.images() {
        if let gltf::image::Source::View { view, .. } = image.source() {
            retained_bytes = retained_bytes
                .checked_add(view.length())
                .ok_or_else(limit_error)?;
            if retained_bytes > crate::decode_limits::MAX_DECODED_CONTENT_BYTES {
                return Err(GlbDecodeError::InvalidDocument(
                    "glTF retained images exceed the leaf budget".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn decode_feature_images(
    primitives: &[DecodedMeshPrimitive],
    images: &[DecodedImage],
) -> Result<BTreeMap<usize, DecodedFeatureImage>, GlbDecodeError> {
    let mut image_indices = primitives
        .iter()
        .flat_map(|primitive| &primitive.features)
        .filter_map(|feature| match feature.binding {
            DecodedFeatureIdBinding::Texture { image_index, .. } => Some(image_index),
            DecodedFeatureIdBinding::Implicit { .. }
            | DecodedFeatureIdBinding::Attribute { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    image_indices.extend(
        primitives
            .iter()
            .flat_map(|primitive| &primitive.property_textures)
            .flat_map(|texture| texture.properties.values())
            .map(|property| property.image_index),
    );
    image_indices
        .into_iter()
        .map(|image_index| {
            let image = images.get(image_index).ok_or_else(|| {
                GlbDecodeError::InvalidDocument(
                    "EXT_mesh_features texture image is missing".to_owned(),
                )
            })?;
            let decoded = if image.mime_type == "image/ktx2" {
                let (width, height, rgba8) =
                    crate::basis_texture::transcode_basis_texture_rgba8(&image.bytes)
                        .map_err(GlbDecodeError::InvalidDocument)?;
                DecodedFeatureImage {
                    width,
                    height,
                    rgba8,
                }
            } else {
                let rgba = crate::decode_limits::decode_bounded_image(&image.bytes)
                    .map_err(|error| GlbDecodeError::InvalidDocument(error.to_string()))?
                    .into_rgba8();
                DecodedFeatureImage {
                    width: rgba.width(),
                    height: rgba.height(),
                    rgba8: rgba.into_raw(),
                }
            };
            if decoded.width == 0 || decoded.height == 0 {
                return Err(GlbDecodeError::InvalidDocument(
                    "EXT_mesh_features texture image is empty".to_owned(),
                ));
            }
            Ok((image_index, decoded))
        })
        .collect()
}

fn nearest_texel(value: f64, dimension: u32, wrap: DecodedTextureWrap) -> Option<u32> {
    if !value.is_finite() || dimension == 0 {
        return None;
    }
    let wrapped = match wrap {
        DecodedTextureWrap::ClampToEdge => value.clamp(0.0, 1.0),
        DecodedTextureWrap::Repeat => value.rem_euclid(1.0),
        DecodedTextureWrap::MirroredRepeat => {
            let periodic = value.rem_euclid(2.0);
            if periodic <= 1.0 {
                periodic
            } else {
                2.0 - periodic
            }
        }
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(((wrapped * f64::from(dimension)).floor() as u32).min(dimension - 1))
}

fn intrinsic_scene_origin(
    scene: &gltf::Scene<'_>,
    root_transform: DMat4,
    blob: Option<&[u8]>,
) -> Result<WorldVec3, GlbDecodeError> {
    let mut bounds = None;
    let mut budget = MeshDecodeBudget::default();
    for node in scene.nodes() {
        accumulate_node_bounds(&node, root_transform, blob, &mut bounds, 0, &mut budget)?;
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
    node: &gltf::Node<'_>,
    parent_transform: DMat4,
    blob: Option<&[u8]>,
    bounds: &mut Option<(DVec3, DVec3)>,
    depth: usize,
    budget: &mut MeshDecodeBudget,
) -> Result<(), GlbDecodeError> {
    if depth >= crate::decode_limits::MAX_GLTF_SCENE_DEPTH {
        return Err(GlbDecodeError::InvalidDocument(
            "glTF scene graph exceeds the nesting limit".to_owned(),
        ));
    }
    let transform = parent_transform * node_transform(node);
    if let Some(mesh) = node.mesh() {
        for primitive in mesh.primitives() {
            budget.reserve(&primitive)?;
            let reader = primitive.reader(|buffer| match buffer.source() {
                gltf::buffer::Source::Bin => blob,
                gltf::buffer::Source::Uri(_) => None,
            });
            let positions = reader
                .read_positions()
                .ok_or(GlbDecodeError::MissingPositions)?;
            for position in positions {
                let world = transform.transform_point3(DVec3::from_array(position.map(f64::from)));
                if !world.is_finite() {
                    return Err(GlbDecodeError::CoordinateRange);
                }
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
        accumulate_node_bounds(&child, transform, blob, bounds, depth + 1, budget)?;
    }
    Ok(())
}

fn decode_node(
    gltf: &gltf::Gltf,
    node: &gltf::Node<'_>,
    parent_transform: DMat4,
    blob: Option<&[u8]>,
    world_origin: WorldVec3,
    structural_metadata: Option<&DecodedStructuralMetadata>,
    output: &mut Vec<DecodedMeshPrimitive>,
    depth: usize,
    budget: &mut MeshDecodeBudget,
) -> Result<(), GlbDecodeError> {
    if depth >= crate::decode_limits::MAX_GLTF_SCENE_DEPTH {
        return Err(GlbDecodeError::InvalidDocument(
            "glTF scene graph exceeds the nesting limit".to_owned(),
        ));
    }
    let transform = parent_transform * node_transform(node);
    if let Some(mesh) = node.mesh() {
        for primitive in mesh.primitives() {
            budget.reserve(&primitive)?;
            output.push(decode_primitive(
                gltf,
                &primitive,
                transform,
                blob,
                world_origin,
                structural_metadata,
            )?);
        }
    }
    for child in node.children() {
        decode_node(
            gltf,
            &child,
            transform,
            blob,
            world_origin,
            structural_metadata,
            output,
            depth + 1,
            budget,
        )?;
    }
    Ok(())
}

#[derive(Default)]
struct MeshDecodeBudget {
    vertices: usize,
    indices: usize,
    primitives: usize,
}

impl MeshDecodeBudget {
    fn reserve(&mut self, primitive: &gltf::Primitive<'_>) -> Result<(), GlbDecodeError> {
        let vertices = primitive
            .get(&gltf::Semantic::Positions)
            .ok_or(GlbDecodeError::MissingPositions)?
            .count();
        let source_indices = primitive
            .indices()
            .map_or(vertices, |accessor| accessor.count());
        let indices = match primitive.mode() {
            gltf::mesh::Mode::Triangles => source_indices,
            gltf::mesh::Mode::TriangleStrip | gltf::mesh::Mode::TriangleFan => source_indices
                .saturating_sub(2)
                .checked_mul(3)
                .ok_or_else(|| {
                    GlbDecodeError::InvalidDocument(
                        "glTF expanded index count overflows".to_owned(),
                    )
                })?,
            gltf::mesh::Mode::Points
            | gltf::mesh::Mode::Lines
            | gltf::mesh::Mode::LineLoop
            | gltf::mesh::Mode::LineStrip => return Err(GlbDecodeError::UnsupportedPrimitiveMode),
        };
        self.vertices = self
            .vertices
            .checked_add(vertices)
            .ok_or_else(limit_error)?;
        self.indices = self.indices.checked_add(indices).ok_or_else(limit_error)?;
        self.primitives = self.primitives.checked_add(1).ok_or_else(limit_error)?;
        if self.vertices > crate::decode_limits::MAX_GLTF_VERTICES
            || self.indices > crate::decode_limits::MAX_GLTF_INDICES
            || self.primitives > crate::decode_limits::MAX_GLTF_PRIMITIVES
        {
            return Err(limit_error());
        }
        Ok(())
    }
}

fn limit_error() -> GlbDecodeError {
    GlbDecodeError::InvalidDocument("glTF decoded geometry exceeds the leaf budget".to_owned())
}

fn decode_primitive(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    transform: DMat4,
    blob: Option<&[u8]>,
    world_origin: WorldVec3,
    structural_metadata: Option<&DecodedStructuralMetadata>,
) -> Result<DecodedMeshPrimitive, GlbDecodeError> {
    let reader = primitive.reader(|buffer| match buffer.source() {
        gltf::buffer::Source::Bin => blob,
        gltf::buffer::Source::Uri(_) => None,
    });
    let source_positions = reader
        .read_positions()
        .ok_or(GlbDecodeError::MissingPositions)?
        .collect::<Vec<_>>();
    let source_indices = reader.read_indices().map_or_else(
        || {
            (0..source_positions.len())
                .map(u32::try_from)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| GlbDecodeError::InvalidPrimitive)
        },
        |indices| Ok(indices.into_u32().collect()),
    )?;
    let indices = triangle_indices(primitive.mode(), &source_indices)?;
    if indices
        .iter()
        .any(|index| usize::try_from(*index).map_or(true, |index| index >= source_positions.len()))
    {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let source_normals = reader.read_normals().map(Iterator::collect::<Vec<_>>);
    if source_normals
        .as_ref()
        .is_some_and(|normals| normals.len() != source_positions.len())
    {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let tex_coords = reader.read_tex_coords(0);
    let has_texture_coordinates = tex_coords.is_some();
    let tex_coords = tex_coords.map_or_else(
        || vec![[0.0; 2]; source_positions.len()],
        |values| values.into_f32().collect::<Vec<_>>(),
    );
    let colors = reader.read_colors(0).map_or_else(
        || vec![[1.0; 4]; source_positions.len()],
        |values| values.into_rgba_f32().collect::<Vec<_>>(),
    );
    if tex_coords.len() != source_positions.len() || colors.len() != source_positions.len() {
        return Err(GlbDecodeError::InvalidPrimitive);
    }
    let normal_transform = normal_transform(transform)?;
    let mut vertices = Vec::with_capacity(source_positions.len());
    let mut exact_positions = Vec::with_capacity(source_positions.len());
    for (index, position) in source_positions.iter().enumerate() {
        let world = transform.transform_point3(DVec3::from_array(position.map(f64::from)));
        let relative = world - world_vector(world_origin);
        let normal = source_normals.as_ref().map_or(DVec3::ZERO, |normals| {
            normal_transform * DVec3::from_array(normals[index].map(f64::from))
        });
        let position = f32_vec(relative)?;
        let normal = if normal.length_squared() > f64::EPSILON {
            f32_vec(normal.normalize())?
        } else {
            [0.0; 3]
        };
        exact_positions.push(WorldVec3 {
            x: relative.x,
            y: relative.y,
            z: relative.z,
        });
        vertices.push(DecodedMeshVertex {
            position,
            normal,
            tex_coord: tex_coords[index],
            color: colors[index],
        });
    }
    if source_normals.is_none() {
        generate_normals(&mut vertices, &indices);
    }
    let (features, legacy_batch_ids, property_attributes, property_textures) =
        decode_primitive_metadata(
            gltf,
            primitive,
            blob,
            &indices,
            source_positions.len(),
            structural_metadata,
        )?;
    Ok(DecodedMeshPrimitive {
        exact_positions,
        vertices,
        has_texture_coordinates,
        indices,
        material: decode_material(&primitive.material()),
        features,
        legacy_batch_ids,
        property_attributes,
        property_textures,
    })
}

type DecodedPrimitiveMetadata = (
    Vec<DecodedMeshFeatureSet>,
    Option<DecodedLegacyBatchIds>,
    Vec<DecodedPrimitivePropertyAttribute>,
    Vec<DecodedPrimitivePropertyTexture>,
);

fn decode_primitive_metadata(
    gltf: &gltf::Gltf,
    primitive: &gltf::Primitive<'_>,
    blob: Option<&[u8]>,
    indices: &[u32],
    vertex_count: usize,
    structural_metadata: Option<&DecodedStructuralMetadata>,
) -> Result<DecodedPrimitiveMetadata, GlbDecodeError> {
    Ok((
        decode_mesh_features(
            gltf,
            primitive,
            blob,
            indices,
            vertex_count,
            structural_metadata.map_or(0, |metadata| metadata.property_tables.len()),
        )?,
        decode_legacy_batch_ids(primitive, blob, indices, vertex_count)?,
        decode_primitive_property_attributes(
            primitive,
            blob,
            indices,
            vertex_count,
            structural_metadata,
        )?,
        decode_primitive_property_textures(
            gltf,
            primitive,
            blob,
            indices,
            vertex_count,
            structural_metadata,
        )?,
    ))
}

fn decode_material(material: &gltf::Material<'_>) -> DecodedMaterial {
    let pbr = material.pbr_metallic_roughness();
    let texture = pbr.base_color_texture();
    let alpha_mode = match material.alpha_mode() {
        gltf::material::AlphaMode::Opaque => DecodedAlphaMode::Opaque,
        gltf::material::AlphaMode::Mask => DecodedAlphaMode::Mask {
            cutoff: material.alpha_cutoff().unwrap_or(0.5),
        },
        gltf::material::AlphaMode::Blend => DecodedAlphaMode::Blend,
    };
    DecodedMaterial {
        base_color_factor: pbr.base_color_factor(),
        base_color_image: texture
            .as_ref()
            .and_then(|info| texture_image_index(&info.texture())),
        base_color_tex_coord: texture.as_ref().map_or(0, gltf::texture::Info::tex_coord),
        alpha_mode,
        double_sided: material.double_sided(),
    }
}

pub(super) fn texture_image_index(texture: &gltf::Texture<'_>) -> Option<usize> {
    texture
        .extension_value("KHR_texture_basisu")
        .and_then(|extension| extension.get("source"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .or_else(|| texture.source().map(|image| image.index()))
}

fn decode_images(
    gltf: &gltf::Gltf,
    blob: Option<&[u8]>,
) -> Result<Vec<DecodedImage>, GlbDecodeError> {
    gltf.images()
        .map(|image| match image.source() {
            gltf::image::Source::View { view, mime_type } => {
                if let gltf::buffer::Source::Uri(uri) = view.buffer().source() {
                    return Err(GlbDecodeError::ExternalResource(uri.to_owned()));
                }
                let blob = blob.ok_or(GlbDecodeError::MissingBinaryBlob)?;
                let end = view
                    .offset()
                    .checked_add(view.length())
                    .ok_or(GlbDecodeError::InvalidPrimitive)?;
                let bytes = blob
                    .get(view.offset()..end)
                    .ok_or(GlbDecodeError::InvalidPrimitive)?
                    .to_vec();
                Ok(DecodedImage {
                    mime_type: mime_type.to_owned(),
                    bytes,
                })
            }
            gltf::image::Source::Uri { uri, .. } => {
                Err(GlbDecodeError::ExternalResource(uri.to_owned()))
            }
        })
        .collect()
}

fn triangle_indices(mode: gltf::mesh::Mode, source: &[u32]) -> Result<Vec<u32>, GlbDecodeError> {
    match mode {
        gltf::mesh::Mode::Triangles => {
            if !source.len().is_multiple_of(3) {
                return Err(GlbDecodeError::InvalidPrimitive);
            }
            Ok(source.to_vec())
        }
        gltf::mesh::Mode::TriangleStrip => {
            let mut result = Vec::with_capacity(source.len().saturating_sub(2) * 3);
            for index in 2..source.len() {
                let triangle = if index % 2 == 0 {
                    [source[index - 2], source[index - 1], source[index]]
                } else {
                    [source[index - 1], source[index - 2], source[index]]
                };
                if triangle[0] != triangle[1]
                    && triangle[1] != triangle[2]
                    && triangle[0] != triangle[2]
                {
                    result.extend(triangle);
                }
            }
            Ok(result)
        }
        gltf::mesh::Mode::TriangleFan => {
            let mut result = Vec::with_capacity(source.len().saturating_sub(2) * 3);
            for index in 2..source.len() {
                result.extend([source[0], source[index - 1], source[index]]);
            }
            Ok(result)
        }
        gltf::mesh::Mode::Points
        | gltf::mesh::Mode::Lines
        | gltf::mesh::Mode::LineLoop
        | gltf::mesh::Mode::LineStrip => Err(GlbDecodeError::UnsupportedPrimitiveMode),
    }
}

fn generate_normals(vertices: &mut [DecodedMeshVertex], indices: &[u32]) {
    let mut accumulators = vec![DVec3::ZERO; vertices.len()];
    for triangle in indices.chunks_exact(3) {
        let (Ok(a), Ok(b), Ok(c)) = (
            usize::try_from(triangle[0]),
            usize::try_from(triangle[1]),
            usize::try_from(triangle[2]),
        ) else {
            continue;
        };
        let first = DVec3::from_array(vertices[a].position.map(f64::from));
        let second = DVec3::from_array(vertices[b].position.map(f64::from));
        let third = DVec3::from_array(vertices[c].position.map(f64::from));
        let normal = (second - first).cross(third - first);
        accumulators[a] += normal;
        accumulators[b] += normal;
        accumulators[c] += normal;
    }
    for (vertex, normal) in vertices.iter_mut().zip(accumulators) {
        vertex.normal = if normal.length_squared() > f64::EPSILON {
            normal.normalize().as_vec3().to_array()
        } else {
            [0.0, 0.0, 1.0]
        };
    }
}

fn node_transform(node: &gltf::Node<'_>) -> DMat4 {
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
    let determinant = linear.determinant();
    if !determinant.is_finite() || determinant.abs() <= f64::EPSILON {
        return Err(GlbDecodeError::CoordinateRange);
    }
    Ok(linear.inverse().transpose())
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

fn world_vector(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn finite_world(value: WorldVec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

#[cfg(test)]
mod tests {
    use glam::{DMat4, DVec3};

    use super::{decode_glb, decode_glb_intrinsic, DecodedFeatureImage};
    use crate::{
        DecodedFeatureIdBinding, DecodedFeatureTextureSample, DecodedTextureWrap,
        DecodedTriangleFeatureId,
    };
    use crate::{WorldTransform, WorldVec3};

    #[test]
    fn decodes_glb_node_and_tile_transforms_before_f32_origin_subtraction() {
        let glb = triangle_glb();
        let tile = DMat4::from_translation(DVec3::new(1_000.0, 2_000.0, 3_000.0));
        let decoded = decode_glb(
            &glb,
            WorldTransform(tile.to_cols_array()),
            WorldVec3 {
                x: 1_100.0,
                y: 1_700.0,
                z: 3_200.0,
            },
        )
        .expect("GLB");

        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices, [0, 1, 2]);
        assert_vec3(decoded.primitives[0].vertices[0].position, [0.0, 0.0, 0.0]);
        assert_vec3(decoded.primitives[0].vertices[1].position, [1.0, 0.0, 0.0]);
        assert_vec3(decoded.primitives[0].vertices[2].position, [0.0, 0.0, 1.0]);
        assert_vec3(decoded.primitives[0].vertices[0].normal, [0.0, -1.0, 0.0]);
        assert_eq!(
            decoded.primitives[0].exact_positions[1],
            WorldVec3 {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }
        );
    }

    #[test]
    fn intrinsic_glb_anchor_comes_from_transformed_leaf_bounds() {
        let glb = triangle_glb();
        let tile = DMat4::from_translation(DVec3::new(6_378_137.25, 4_812_345.5, 512.125));
        let decoded = decode_glb_intrinsic(&glb, WorldTransform(tile.to_cols_array()))
            .expect("intrinsic GLB");

        assert!((decoded.world_origin.x - 6_378_237.75).abs() < 1.0e-9);
        assert!((decoded.world_origin.y - 4_812_045.5).abs() < 1.0e-9);
        assert!((decoded.world_origin.z - 712.625).abs() < 1.0e-9);
        assert_eq!(
            decoded.primitives[0].vertices[0].position,
            [-0.5, 0.0, -0.5]
        );
        assert_eq!(decoded.primitives[0].vertices[2].position, [-0.5, 0.0, 0.5]);
        assert_eq!(decoded.primitives[0].exact_positions[0].x, -0.5);
        assert_eq!(decoded.primitives[0].exact_positions[2].z, 0.5);
    }

    #[test]
    fn decodes_required_meshopt_attribute_and_triangle_views() {
        let glb = meshopt_triangle_glb();
        let decoded = decode_glb_intrinsic(&glb, WorldTransform::IDENTITY).expect("meshopt GLB");

        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices, [0, 1, 2]);
        assert_vec3(
            decoded.primitives[0].vertices[0].position,
            [-0.5, 0.0, -0.5],
        );
        assert_vec3(decoded.primitives[0].vertices[1].position, [0.5, 0.0, -0.5]);
        assert_vec3(decoded.primitives[0].vertices[2].position, [-0.5, 0.0, 0.5]);
    }

    #[test]
    fn rejects_invalid_meshopt_attribute_stride() {
        let mut glb = meshopt_triangle_glb();
        let marker = b"\"byteStride\":12,\"count\"";
        let offset = glb
            .windows(marker.len())
            .position(|window| window == marker)
            .expect("stride marker");
        glb[offset + 13..offset + 15].copy_from_slice(b"10");

        let error = decode_glb_intrinsic(&glb, WorldTransform::IDENTITY)
            .expect_err("invalid meshopt stride");
        assert!(error.to_string().contains("attribute stride"));
    }

    #[test]
    fn rejects_sparse_accessor_bomb_count_before_vertex_collection() {
        let json = serde_json::json!({
            "asset": { "version": "2.0" },
            "buffers": [{ "byteLength": 16 }],
            "bufferViews": [
                { "buffer": 0, "byteOffset": 0, "byteLength": 1 },
                { "buffer": 0, "byteOffset": 4, "byteLength": 12 }
            ],
            "accessors": [{
                "componentType": 5126,
                "count": 4_000_001,
                "type": "VEC3",
                "min": [0, 0, 0],
                "max": [0, 0, 0],
                "sparse": {
                    "count": 1,
                    "indices": { "bufferView": 0, "componentType": 5121 },
                    "values": { "bufferView": 1 }
                }
            }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "mode": 4 }] }],
            "nodes": [{ "mesh": 0 }],
            "scenes": [{ "nodes": [0] }],
            "scene": 0
        });
        let glb = encode_test_glb(json.to_string(), vec![0; 16]);
        let error = decode_glb_intrinsic(&glb, WorldTransform::IDENTITY)
            .expect_err("oversized sparse accessor");
        assert!(error.to_string().contains("leaf budget"), "{error}");
    }

    #[test]
    fn decodes_required_draco_primitive_through_the_shared_glb_path() {
        let glb = draco_triangle_glb();
        let decoded = decode_glb_intrinsic(&glb, WorldTransform::IDENTITY).expect("Draco GLB");

        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices.len(), 3);
        let mut positions: Vec<_> = decoded.primitives[0]
            .vertices
            .iter()
            .map(|vertex| vertex.position)
            .collect();
        positions.sort_by(|left, right| left.partial_cmp(right).expect("finite positions"));
        assert_eq!(
            positions,
            [[-0.5, 0.0, -0.5], [-0.5, 0.0, 0.5], [0.5, 0.0, -0.5]]
        );
    }

    #[test]
    fn resolves_required_basisu_texture_source_and_retains_ktx2_bytes() {
        let glb = basisu_texture_triangle_glb();
        let decoded = decode_glb_intrinsic(&glb, WorldTransform::IDENTITY).expect("BasisU GLB");

        assert_eq!(decoded.primitives[0].material.base_color_image, Some(0));
        assert_eq!(decoded.images[0].mime_type, "image/ktx2");
        assert_eq!(decoded.images[0].bytes, b"\xABKTX 20\xBB\r\n\x1A\n");
    }

    #[test]
    fn retains_structural_metadata_and_maps_feature_attributes_to_source_triangles() {
        let decoded = decode_glb_intrinsic(&feature_metadata_glb(), WorldTransform::IDENTITY)
            .expect("feature metadata GLB");

        let metadata = decoded
            .structural_metadata
            .as_ref()
            .expect("structural metadata");
        assert_eq!(metadata.property_tables.len(), 1);
        assert_eq!(metadata.property_tables[0]["class"], "building");
        assert_eq!(metadata.property_table_buffer_views.len(), 3);
        assert_eq!(
            metadata.property_table_row(0, 1).expect("property row"),
            serde_json::json!({ "height": 27.25, "name": "tower" })
        );
        let feature = &decoded.primitives[0].features[0];
        assert_eq!(feature.feature_count, 2);
        assert_eq!(feature.label.as_deref(), Some("buildingId"));
        assert_eq!(feature.property_table, Some(0));
        assert_eq!(
            feature.triangle_ids,
            [
                DecodedTriangleFeatureId::Ambiguous,
                DecodedTriangleFeatureId::Feature(1)
            ]
        );
        assert_eq!(
            feature.feature_id_at_triangle(0, [0.8, 0.1, 0.1]),
            Some(DecodedTriangleFeatureId::Feature(0))
        );
        assert_eq!(
            feature.feature_id_at_triangle(0, [0.1, 0.1, 0.8]),
            Some(DecodedTriangleFeatureId::Feature(1))
        );
        let DecodedFeatureIdBinding::Attribute {
            attribute,
            vertex_ids,
        } = &feature.binding
        else {
            panic!("expected feature attribute");
        };
        assert_eq!(*attribute, 0);
        assert_eq!(vertex_ids, &[0, 0, 1, 1, 1, 1]);

        let property_attribute = &decoded.primitives[0].property_attributes[0];
        let picked = property_attribute
            .values_at_triangle(0, [0.1, 0.8, 0.1])
            .expect("property attribute hit");
        assert_eq!(picked["sourceVertexIndices"], serde_json::json!([0, 1, 2]));
        assert_eq!(
            picked["properties"]["temperature"]["vertexValues"],
            serde_json::json!([21.0, 41.0, 61.0])
        );
        assert_eq!(picked["properties"]["temperature"]["nearestVertex"], 1);
        assert_eq!(picked["properties"]["temperature"]["value"], 41.0);
        assert_eq!(
            picked["properties"]["classification"]["vertexValues"],
            serde_json::json!(["ground", "roof", "roof"])
        );
        assert_eq!(picked["properties"]["classification"]["value"], "roof");
    }

    #[test]
    fn samples_little_endian_feature_channels_with_exact_wrap_modes() {
        let image = DecodedFeatureImage {
            width: 2,
            height: 2,
            rgba8: vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255],
        };
        let sample = DecodedFeatureTextureSample {
            image_index: 0,
            tex_coord: [1.1, -0.1],
            channels: vec![2, 0],
            wrap_s: DecodedTextureWrap::Repeat,
            wrap_t: DecodedTextureWrap::MirroredRepeat,
        };
        assert_eq!(image.feature_id(&sample), Some(1_u64 << 8 | 3));

        let clamped = DecodedFeatureTextureSample {
            tex_coord: [1.0, 1.0],
            channels: vec![0, 1, 2],
            wrap_s: DecodedTextureWrap::ClampToEdge,
            wrap_t: DecodedTextureWrap::ClampToEdge,
            ..sample
        };
        assert_eq!(image.feature_id(&clamped), Some(10 | 11 << 8 | 12 << 16));
    }

    fn triangle_glb() -> Vec<u8> {
        let mut binary = Vec::new();
        for position in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2] {
            binary.extend(index.to_le_bytes());
        }
        let binary_length = binary.len();
        while !binary.len().is_multiple_of(8) {
            binary.push(0);
        }
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{binary_length}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36,"target":34962}},{{"buffer":0,"byteOffset":36,"byteLength":6,"target":34963}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"mode":4}}]}}],"nodes":[{{"mesh":0,"translation":[100,200,300]}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
        );
        let mut json = json.into_bytes();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let total_length = 12 + 8 + json.len() + 8 + binary.len();
        let mut glb = Vec::with_capacity(total_length);
        glb.extend(*b"glTF");
        glb.extend(2_u32.to_le_bytes());
        glb.extend(u32::try_from(total_length).expect("GLB size").to_le_bytes());
        glb.extend(u32::try_from(json.len()).expect("JSON size").to_le_bytes());
        glb.extend(0x4E4F_534A_u32.to_le_bytes());
        glb.extend(json);
        glb.extend(u32::try_from(binary.len()).expect("BIN size").to_le_bytes());
        glb.extend(0x004E_4942_u32.to_le_bytes());
        glb.extend(binary);
        glb
    }

    fn feature_metadata_glb() -> Vec<u8> {
        let mut binary = Vec::new();
        for position in [
            [0.0_f32, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
        ] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2, 3, 4, 5] {
            binary.extend(index.to_le_bytes());
        }
        binary.extend([0_u8, 0, 1, 1, 1, 1]);
        while !binary.len().is_multiple_of(8) {
            binary.push(0);
        }
        let height_offset = binary.len();
        for height in [12.5_f32, 27.25] {
            binary.extend(height.to_le_bytes());
        }
        let name_offset = binary.len();
        binary.extend(b"westtower");
        while !binary.len().is_multiple_of(8) {
            binary.push(0);
        }
        let name_offsets_offset = binary.len();
        for offset in [0_u32, 4, 9] {
            binary.extend(offset.to_le_bytes());
        }
        while !binary.len().is_multiple_of(8) {
            binary.push(0);
        }
        let temperature_offset = binary.len();
        for temperature in [10.0_f32, 20.0, 30.0, 40.0, 50.0, 60.0] {
            binary.extend(temperature.to_le_bytes());
        }
        let classification_offset = binary.len();
        for classification in [0_u16, 1, 1, 0, 1, 0] {
            binary.extend(classification.to_le_bytes());
        }
        let binary_length = binary.len();
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"extensionsUsed":["EXT_mesh_features","EXT_structural_metadata"],"extensions":{{"EXT_structural_metadata":{{"schema":{{"id":"test","enums":{{"surfaceClass":{{"valueType":"UINT16","values":[{{"name":"ground","value":0}},{{"name":"roof","value":1}}]}}}},"classes":{{"building":{{"properties":{{"height":{{"type":"SCALAR","componentType":"FLOAT32"}},"name":{{"type":"STRING"}},"temperature":{{"type":"SCALAR","componentType":"FLOAT32"}},"classification":{{"type":"ENUM","enumType":"surfaceClass"}}}}}}}}}},"propertyTables":[{{"class":"building","count":2,"properties":{{"height":{{"values":3}},"name":{{"values":4,"stringOffsets":5}}}}}}],"propertyAttributes":[{{"class":"building","properties":{{"temperature":{{"attribute":"_TEMPERATURE","scale":2,"offset":1}},"classification":{{"attribute":"_CLASSIFICATION"}}}}}}]}}}},"buffers":[{{"byteLength":{binary_length}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":72,"target":34962}},{{"buffer":0,"byteOffset":72,"byteLength":12,"target":34963}},{{"buffer":0,"byteOffset":84,"byteLength":6,"target":34962}},{{"buffer":0,"byteOffset":{height_offset},"byteLength":8}},{{"buffer":0,"byteOffset":{name_offset},"byteLength":9}},{{"buffer":0,"byteOffset":{name_offsets_offset},"byteLength":12}},{{"buffer":0,"byteOffset":{temperature_offset},"byteLength":24,"target":34962}},{{"buffer":0,"byteOffset":{classification_offset},"byteLength":12,"target":34962}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":6,"type":"VEC3","min":[0,0,0],"max":[3,1,0]}},{{"bufferView":1,"componentType":5123,"count":6,"type":"SCALAR"}},{{"bufferView":2,"componentType":5121,"count":6,"type":"SCALAR"}},{{"bufferView":6,"componentType":5126,"count":6,"type":"SCALAR"}},{{"bufferView":7,"componentType":5123,"count":6,"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"_FEATURE_ID_0":2,"_TEMPERATURE":3,"_CLASSIFICATION":4}},"indices":1,"mode":4,"extensions":{{"EXT_mesh_features":{{"featureIds":[{{"featureCount":2,"label":"buildingId","attribute":0,"propertyTable":0}}]}},"EXT_structural_metadata":{{"propertyAttributes":[0]}}}}}}]}}],"nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
        );
        encode_test_glb(json, binary)
    }

    fn meshopt_triangle_glb() -> Vec<u8> {
        use meshopt_rs::index::{buffer as index_buffer, IndexEncodingVersion};
        use meshopt_rs::vertex::{buffer as vertex_buffer, VertexEncodingVersion};

        let positions = [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let mut encoded_positions =
            vec![
                0_u8;
                vertex_buffer::encode_vertex_buffer_bound(positions.len(), size_of::<[f32; 3]>())
            ];
        let position_length = vertex_buffer::encode_vertex_buffer(
            &mut encoded_positions,
            &positions,
            VertexEncodingVersion::V0,
        )
        .expect("encode positions");
        encoded_positions.truncate(position_length);

        let indices = [0_u32, 1, 2];
        let mut encoded_indices =
            vec![0_u8; index_buffer::encode_index_buffer_bound(indices.len(), positions.len())];
        let index_length = index_buffer::encode_index_buffer(
            &mut encoded_indices,
            &indices,
            IndexEncodingVersion::V0,
        )
        .expect("encode indices");
        encoded_indices.truncate(index_length);

        let index_offset = encoded_positions.len();
        let mut binary = encoded_positions;
        binary.extend(encoded_indices);
        let binary_length = binary.len();
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"extensionsUsed":["EXT_meshopt_compression"],"extensionsRequired":["EXT_meshopt_compression"],"buffers":[{{"byteLength":{binary_length}}}],"bufferViews":[{{"buffer":0,"byteLength":36,"byteStride":12,"target":34962,"extensions":{{"EXT_meshopt_compression":{{"buffer":0,"byteOffset":0,"byteLength":{position_length},"byteStride":12,"count":3,"mode":"ATTRIBUTES","filter":"NONE"}}}}}},{{"buffer":0,"byteLength":6,"target":34963,"extensions":{{"EXT_meshopt_compression":{{"buffer":0,"byteOffset":{index_offset},"byteLength":{index_length},"byteStride":2,"count":3,"mode":"TRIANGLES","filter":"NONE"}}}}}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"mode":4}}]}}],"nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
        );
        encode_test_glb(json, binary)
    }

    fn draco_triangle_glb() -> Vec<u8> {
        use draco_core::draco_types::DataType;
        use draco_core::encoder_buffer::EncoderBuffer;
        use draco_core::encoder_options::EncoderOptions;
        use draco_core::geometry_attribute::{GeometryAttributeType, PointAttribute};
        use draco_core::geometry_indices::PointIndex;
        use draco_core::mesh::Mesh;
        use draco_core::mesh_encoder::MeshEncoder;

        let positions = [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let mut mesh = Mesh::new();
        let mut attribute = PointAttribute::new();
        attribute.init(
            GeometryAttributeType::Position,
            3,
            DataType::Float32,
            false,
            positions.len(),
        );
        for (index, position) in positions.iter().enumerate() {
            let bytes: Vec<u8> = position
                .iter()
                .flat_map(|component| component.to_le_bytes())
                .collect();
            attribute.buffer_mut().write(index * 12, &bytes);
        }
        mesh.add_attribute(attribute);
        mesh.add_face([PointIndex(0), PointIndex(1), PointIndex(2)]);
        let mut encoder = MeshEncoder::new();
        encoder.set_mesh(mesh);
        let mut encoded = EncoderBuffer::new();
        encoder
            .encode(&EncoderOptions::default(), &mut encoded)
            .expect("encode Draco triangle");
        let binary = encoded.data().to_vec();
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"extensionsUsed":["KHR_draco_mesh_compression"],"extensionsRequired":["KHR_draco_mesh_compression"],"buffers":[{{"byteLength":{}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{}}}],"accessors":[{{"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},{{"componentType":5125,"count":3,"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"mode":4,"extensions":{{"KHR_draco_mesh_compression":{{"bufferView":0,"attributes":{{"POSITION":0}}}}}}}}]}}],"nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#,
            binary.len(),
            binary.len()
        );
        let mut padded_binary = binary;
        while !padded_binary.len().is_multiple_of(4) {
            padded_binary.push(0);
        }
        encode_test_glb(json, padded_binary)
    }

    fn basisu_texture_triangle_glb() -> Vec<u8> {
        let mut binary = Vec::new();
        for position in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for component in position {
                binary.extend(component.to_le_bytes());
            }
        }
        for index in [0_u16, 1, 2] {
            binary.extend(index.to_le_bytes());
        }
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let image_offset = binary.len();
        let image = b"\xABKTX 20\xBB\r\n\x1A\n";
        binary.extend(image);
        let binary_length = binary.len();
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"extensionsUsed":["KHR_texture_basisu"],"extensionsRequired":["KHR_texture_basisu"],"buffers":[{{"byteLength":{binary_length}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36,"target":34962}},{{"buffer":0,"byteOffset":36,"byteLength":6,"target":34963}},{{"buffer":0,"byteOffset":{image_offset},"byteLength":12}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"images":[{{"bufferView":2,"mimeType":"image/ktx2"}}],"textures":[{{"extensions":{{"KHR_texture_basisu":{{"source":0}}}}}}],"materials":[{{"pbrMetallicRoughness":{{"baseColorTexture":{{"index":0}}}}}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"material":0,"mode":4}}]}}],"nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
        );
        encode_test_glb(json, binary)
    }

    fn encode_test_glb(json: String, binary: Vec<u8>) -> Vec<u8> {
        let mut json = json.into_bytes();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let total_length = 12 + 8 + json.len() + 8 + binary.len();
        let mut glb = Vec::with_capacity(total_length);
        glb.extend(*b"glTF");
        glb.extend(2_u32.to_le_bytes());
        glb.extend(u32::try_from(total_length).expect("GLB size").to_le_bytes());
        glb.extend(u32::try_from(json.len()).expect("JSON size").to_le_bytes());
        glb.extend(0x4E4F_534A_u32.to_le_bytes());
        glb.extend(json);
        glb.extend(u32::try_from(binary.len()).expect("BIN size").to_le_bytes());
        glb.extend(0x004E_4942_u32.to_le_bytes());
        glb.extend(binary);
        glb
    }

    fn assert_vec3(actual: [f32; 3], expected: [f32; 3]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < f32::EPSILON);
        }
    }
}
