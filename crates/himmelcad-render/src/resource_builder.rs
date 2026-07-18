//! Conversion from decoded provider content into resident GPU batches.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::{DMat3, DMat4};
use sha2::{Digest, Sha256};

use crate::{
    DecodedAlphaMode, DecodedElevationRaster, DecodedGaussianSplat, DecodedGaussianSplats,
    DecodedGlb, DecodedInstancedModel, DecodedMeshPrimitive, DecodedPotreePoints,
    DecodedThreeDTilesContent, GpuAlphaMode, GpuDrawBatch, GpuFrameError, GpuIndexedMeshGeometry,
    GpuMaterial, GpuMeshInstanceInput, GpuMeshVertexInput, GpuModelResourceIdentity,
    GpuPresentationStyle, GpuSharedRenderer, GpuSplatVertex, GpuTextureColorSpace, GpuTextureData,
    GpuTextureMipChainData, GpuTextureResource, GpuTextureResourceIdentity,
    GpuTextureSamplerIdentity, GpuTextureUploadFormat, GpuTextureUploadLayout,
    GpuUploadedTextureIdentityInput, RenderProxyKind, RenderStyle, TransparencyStrategy, WorldVec3,
    SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE,
};

const INSTANCE_CHUNK_CELL_METRES: f64 = 4096.0;
const TEXTURE_DECODER_REVISION: u32 = 1;

/// Device-ready immutable texture bytes prepared before cache resolution.
#[derive(Debug, Clone)]
pub struct PreparedGpuTextureUpload {
    source_key: [u8; 32],
    /// Exact GPU upload identity, independent from URI and presentation style.
    pub identity: GpuTextureResourceIdentity,
    /// Base-level width.
    pub width: u32,
    /// Base-level height.
    pub height: u32,
    /// Complete mip count.
    pub mip_level_count: u32,
    /// Concrete device upload format.
    pub format: wgpu::TextureFormat,
    /// Mip-major tightly packed upload bytes.
    pub data: Vec<u8>,
}

impl PreparedGpuTextureUpload {
    /// Stable digest of the encoded source representation (or default white).
    #[must_use]
    pub const fn source_key(&self) -> [u8; 32] {
        self.source_key
    }

    /// Borrowed upload descriptor accepted by the shared GPU renderer.
    #[must_use]
    pub fn mip_chain(&self) -> GpuTextureMipChainData<'_> {
        GpuTextureMipChainData {
            width: self.width,
            height: self.height,
            mip_level_count: self.mip_level_count,
            format: self.format,
            data: &self.data,
        }
    }
}

/// Per-compilation source-image bindings to globally cached texture allocations.
#[derive(Debug, Clone, Default)]
pub struct PreparedGpuTextureResources {
    resources: BTreeMap<[u8; 32], GpuTextureResource>,
}

impl PreparedGpuTextureResources {
    /// Binds one prepared source representation to its cache-resolved allocation.
    pub fn bind(&mut self, upload: &PreparedGpuTextureUpload, resource: GpuTextureResource) {
        self.resources.insert(upload.source_key, resource);
    }

    /// Binds a previously catalogued source digest without decoding it again.
    pub fn bind_source(&mut self, source_key: [u8; 32], resource: GpuTextureResource) {
        self.resources.insert(source_key, resource);
    }

    fn resource_for_image(
        &self,
        image: Option<&crate::DecodedImage>,
    ) -> Option<GpuTextureResource> {
        self.resources.get(&texture_source_key(image)).cloned()
    }
}

/// Returns the distinct encoded source digests used by base-color materials.
///
/// This deliberately performs no image decode or Basis/KTX2 transcode, so a
/// caller can resolve known source identities from a resident cache first.
#[must_use]
pub fn glb_texture_source_keys(glb: &DecodedGlb) -> Vec<[u8; 32]> {
    glb.primitives
        .iter()
        .filter_map(|primitive| {
            primitive
                .material
                .base_color_image
                .and_then(|index| glb.images.get(index))
                .map(|image| texture_source_key(Some(image)))
                .or_else(|| {
                    primitive
                        .material
                        .base_color_image
                        .is_none()
                        .then(|| texture_source_key(None))
                })
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Decodes/transcodes every base-color texture used by one glTF exactly once.
pub fn prepare_glb_texture_uploads(
    device: &wgpu::Device,
    glb: &DecodedGlb,
) -> Result<Vec<PreparedGpuTextureUpload>, ResourceBuildError> {
    let required = glb_texture_source_keys(glb).into_iter().collect();
    prepare_glb_texture_uploads_for_sources(device, glb, &required)
}

/// Decodes/transcodes only selected source digests used by one glTF.
///
/// This supports a source-to-upload-identity catalog: known resident sources
/// never enter the decoder/transcoder again, while cache misses still derive
/// identity exclusively from the exact bytes submitted to the GPU.
pub fn prepare_glb_texture_uploads_for_sources(
    device: &wgpu::Device,
    glb: &DecodedGlb,
    required: &BTreeSet<[u8; 32]>,
) -> Result<Vec<PreparedGpuTextureUpload>, ResourceBuildError> {
    let mut sources = BTreeMap::<[u8; 32], Option<usize>>::new();
    for primitive in &glb.primitives {
        let image_index = primitive.material.base_color_image;
        let image = image_index
            .map(|index| {
                glb.images
                    .get(index)
                    .ok_or(ResourceBuildError::MissingImage(index))
            })
            .transpose()?;
        let source_key = texture_source_key(image);
        if required.contains(&source_key) {
            sources.entry(source_key).or_insert(image_index);
        }
    }
    sources
        .into_iter()
        .map(|(source_key, image_index)| {
            let (width, height, mip_level_count, format, data) =
                if let Some(image_index) = image_index {
                    let image = &glb.images[image_index];
                    if image.mime_type == "image/ktx2" {
                        let texture =
                            crate::basis_texture::transcode_basis_texture(device, &image.bytes)
                                .map_err(|message| ResourceBuildError::ImageDecode {
                                    image_index,
                                    message,
                                })?;
                        (
                            texture.width,
                            texture.height,
                            texture.mip_level_count,
                            texture.format,
                            texture.data,
                        )
                    } else {
                        let decoded = crate::decode_limits::decode_bounded_image(&image.bytes)
                            .map_err(|error| ResourceBuildError::ImageDecode {
                                image_index,
                                message: error.to_string(),
                            })?;
                        let rgba = decoded.to_rgba8();
                        (
                            rgba.width(),
                            rgba.height(),
                            1,
                            wgpu::TextureFormat::Rgba8UnormSrgb,
                            rgba.into_raw(),
                        )
                    }
                } else {
                    (1, 1, 1, wgpu::TextureFormat::Rgba8UnormSrgb, vec![255; 4])
                };
            let mip_chain = GpuTextureMipChainData {
                width,
                height,
                mip_level_count,
                format,
                data: &data,
            };
            let identity = gpu_uploaded_texture_identity(
                mip_chain,
                GpuTextureColorSpace::Srgb,
                GpuTextureSamplerIdentity::REPEAT_LINEAR,
                TEXTURE_DECODER_REVISION,
            )
            .ok_or(GpuFrameError::InvalidTexture)?;
            Ok(PreparedGpuTextureUpload {
                source_key,
                identity,
                width,
                height,
                mip_level_count,
                format,
                data,
            })
        })
        .collect()
}

fn texture_source_key(image: Option<&crate::DecodedImage>) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"himmelcad-decoded-texture-source-v1\0");
    if let Some(image) = image {
        hash.update(image.mime_type.as_bytes());
        hash.update([0]);
        hash.update(&image.bytes);
    } else {
        hash.update(b"default-white");
    }
    hash.finalize().into()
}

/// Stable identity of the exact immutable indexed bytes uploaded for a decoded model.
#[must_use]
pub fn gpu_indexed_geometry_identity(glb: &DecodedGlb) -> GpuModelResourceIdentity {
    let mut hash = Sha256::new();
    hash.update(b"himmelcad-decoded-indexed-geometry-v1\0");
    hash.update(
        u64::try_from(glb.primitives.len())
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    for primitive in &glb.primitives {
        hash.update(
            u64::try_from(primitive.vertices.len())
                .unwrap_or(u64::MAX)
                .to_le_bytes(),
        );
        for vertex in mesh_vertices(primitive) {
            for value in vertex.position {
                hash.update(value.to_bits().to_le_bytes());
            }
            for value in vertex.normal {
                hash.update(value.to_bits().to_le_bytes());
            }
            for value in vertex.tex_coord {
                hash.update(value.to_bits().to_le_bytes());
            }
            for value in vertex.color {
                hash.update(value.to_bits().to_le_bytes());
            }
        }
        hash.update(
            u64::try_from(primitive.indices.len())
                .unwrap_or(u64::MAX)
                .to_le_bytes(),
        );
        for index in &primitive.indices {
            hash.update(index.to_le_bytes());
        }
    }
    GpuModelResourceIdentity::from_digest(hash.finalize().into())
}

/// Stable identity of the exact mip-major bytes selected for GPU upload.
///
/// This is the integration boundary for a kernel/viewer owner: decode or
/// transcode first, resolve the identity through the cache before invoking
/// `GpuSharedRenderer::create_mip_chain_texture_resource`, atomically stage the
/// resolved allocation, then create tile-local style uniforms around it.
/// A future `wgpu` format returns `None` until it receives a stable cache-key
/// representation.
#[must_use]
pub fn gpu_uploaded_texture_identity(
    texture: GpuTextureMipChainData<'_>,
    color_space: GpuTextureColorSpace,
    sampler: GpuTextureSamplerIdentity,
    decoder_revision: u32,
) -> Option<GpuTextureResourceIdentity> {
    let format = GpuTextureUploadFormat::from_wgpu(texture.format)?;
    Some(GpuTextureResourceIdentity::for_uploaded_texture(
        GpuUploadedTextureIdentityInput {
            width: texture.width,
            height: texture.height,
            mip_level_count: texture.mip_level_count,
            format,
            layout: GpuTextureUploadLayout::MipMajorTightlyPacked,
            color_space,
            sampler,
            decoder_revision,
            data: texture.data,
        },
    ))
}

/// Deterministic precision/pick-safe subset of one shared instanced model.
#[derive(Debug, Clone, PartialEq)]
pub struct InstancedModelChunk {
    /// Stable f64 origin used by every affine translation in the chunk.
    pub world_origin: WorldVec3,
    /// Source instance indices retained in source order.
    pub instance_indices: Vec<usize>,
}

/// Groups instances into bounded world cells and u32-safe primitive ranges.
#[must_use]
pub fn instanced_model_chunks(model: &DecodedInstancedModel) -> Vec<InstancedModelChunk> {
    let triangles = model
        .glb
        .primitives
        .iter()
        .map(|primitive| primitive.indices.len() / 3)
        .sum::<usize>()
        .max(1);
    let maximum_instances = usize::try_from(u32::MAX)
        .unwrap_or(usize::MAX)
        .checked_div(triangles)
        .unwrap_or(0)
        .max(1);
    let mut groups = BTreeMap::<([i64; 3], usize), Vec<usize>>::new();
    for (index, instance) in model.instances.iter().enumerate() {
        let transform = DMat4::from_cols_array(&instance.world_from_model.0);
        let translation = transform.w_axis.truncate();
        #[allow(clippy::cast_possible_truncation)]
        let cell = [
            (translation.x / INSTANCE_CHUNK_CELL_METRES).floor() as i64,
            (translation.y / INSTANCE_CHUNK_CELL_METRES).floor() as i64,
            (translation.z / INSTANCE_CHUNK_CELL_METRES).floor() as i64,
        ];
        groups
            .entry((cell, index / maximum_instances))
            .or_default()
            .push(index);
    }
    groups
        .into_iter()
        .map(|((cell, _), instance_indices)| InstancedModelChunk {
            world_origin: WorldVec3 {
                x: (cell[0] as f64 + 0.5) * INSTANCE_CHUNK_CELL_METRES,
                y: (cell[1] as f64 + 0.5) * INSTANCE_CHUNK_CELL_METRES,
                z: (cell[2] as f64 + 0.5) * INSTANCE_CHUNK_CELL_METRES,
            },
            instance_indices,
        })
        .collect()
}

/// Decoded content could not be converted into resident GPU resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceBuildError {
    /// GPU batch or texture validation failed.
    Gpu(GpuFrameError),
    /// Embedded image bytes are not a supported PNG or JPEG image.
    ImageDecode {
        /// glTF image index.
        image_index: usize,
        /// Decoder diagnostic.
        message: String,
    },
    /// Material references an image absent from the decoded GLB.
    MissingImage(usize),
    /// The render world did not allocate exactly one pick proxy per content leaf.
    PickSlotCount,
}

impl Display for ResourceBuildError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gpu(error) => Display::fmt(error, formatter),
            Self::ImageDecode {
                image_index,
                message,
            } => write!(
                formatter,
                "glTF image {image_index} decode failed: {message}"
            ),
            Self::MissingImage(index) => write!(formatter, "glTF image {index} is missing"),
            Self::PickSlotCount => {
                formatter.write_str("3D Tiles content leaf and pick-slot counts differ")
            }
        }
    }
}

/// One GPU batch retaining the heterogeneous content leaf that owns its pick slot.
#[derive(Debug)]
pub struct BuiltThreeDTilesBatch {
    /// Depth-first leaf index shared by every primitive of one GLB leaf.
    pub leaf_index: usize,
    /// Render pipeline class.
    pub kind: RenderProxyKind,
    /// Stable intrinsic f64 origin of the owning decoded leaf.
    pub world_origin: WorldVec3,
    /// Resident GPU batch.
    pub batch: GpuDrawBatch,
}

/// Number of collision-free render proxies required by heterogeneous content.
#[must_use]
pub fn required_three_d_tiles_proxy_slots(content: &DecodedThreeDTilesContent) -> usize {
    match content {
        DecodedThreeDTilesContent::Mesh(_) | DecodedThreeDTilesContent::Points(_) => 1,
        DecodedThreeDTilesContent::InstancedMesh(model) => instanced_model_chunks(model).len(),
        DecodedThreeDTilesContent::Composite(children) => children
            .iter()
            .map(required_three_d_tiles_proxy_slots)
            .sum(),
    }
}

/// Uploads a decoded 3D Tiles content tree with one global pick slot per leaf.
#[allow(clippy::too_many_arguments)]
pub fn build_three_d_tiles_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    proxy_slots: &[u32],
    content: &DecodedThreeDTilesContent,
    style: &RenderStyle,
    exaggeration_datum: f64,
) -> Result<Vec<BuiltThreeDTilesBatch>, ResourceBuildError> {
    build_three_d_tiles_batches_with_instanced_geometries(
        device,
        queue,
        renderer,
        label_prefix,
        proxy_slots,
        content,
        style,
        exaggeration_datum,
        &BTreeMap::new(),
    )
}

/// Uploads a content tree while reusing content-addressed instanced geometry.
#[allow(clippy::too_many_arguments)]
pub fn build_three_d_tiles_batches_with_instanced_geometries(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    proxy_slots: &[u32],
    content: &DecodedThreeDTilesContent,
    style: &RenderStyle,
    exaggeration_datum: f64,
    shared_geometries: &BTreeMap<GpuModelResourceIdentity, Vec<GpuIndexedMeshGeometry>>,
) -> Result<Vec<BuiltThreeDTilesBatch>, ResourceBuildError> {
    build_three_d_tiles_batches_with_resources(
        device,
        queue,
        renderer,
        label_prefix,
        proxy_slots,
        content,
        style,
        exaggeration_datum,
        shared_geometries,
        &PreparedGpuTextureResources::default(),
    )
}

/// Uploads a content tree while reusing immutable geometry and textures.
#[allow(clippy::too_many_arguments)]
pub fn build_three_d_tiles_batches_with_resources(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    proxy_slots: &[u32],
    content: &DecodedThreeDTilesContent,
    style: &RenderStyle,
    exaggeration_datum: f64,
    shared_geometries: &BTreeMap<GpuModelResourceIdentity, Vec<GpuIndexedMeshGeometry>>,
    shared_textures: &PreparedGpuTextureResources,
) -> Result<Vec<BuiltThreeDTilesBatch>, ResourceBuildError> {
    if proxy_slots.len() != required_three_d_tiles_proxy_slots(content) {
        return Err(ResourceBuildError::PickSlotCount);
    }
    let mut next_slot = 0;
    let mut batches = Vec::new();
    build_three_d_tiles_node(
        device,
        queue,
        renderer,
        label_prefix,
        proxy_slots,
        &mut next_slot,
        content,
        style,
        exaggeration_datum,
        shared_geometries,
        shared_textures,
        &mut batches,
    )?;
    Ok(batches)
}

#[allow(clippy::too_many_arguments)]
fn build_three_d_tiles_node(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    proxy_slots: &[u32],
    next_slot: &mut usize,
    content: &DecodedThreeDTilesContent,
    style: &RenderStyle,
    exaggeration_datum: f64,
    shared_geometries: &BTreeMap<GpuModelResourceIdentity, Vec<GpuIndexedMeshGeometry>>,
    shared_textures: &PreparedGpuTextureResources,
    output: &mut Vec<BuiltThreeDTilesBatch>,
) -> Result<(), ResourceBuildError> {
    match content {
        DecodedThreeDTilesContent::Mesh(mesh) => {
            let leaf_index = *next_slot;
            let slot = proxy_slots[leaf_index];
            *next_slot += 1;
            let leaf_style = GpuPresentationStyle::from_render_style(
                style,
                mesh.glb.world_origin,
                exaggeration_datum,
            )?;
            output.extend(
                build_glb_batches_with_textures(
                    device,
                    queue,
                    renderer,
                    label_prefix,
                    slot,
                    &mesh.glb,
                    &leaf_style,
                    shared_textures,
                )?
                .into_iter()
                .map(|batch| BuiltThreeDTilesBatch {
                    leaf_index,
                    kind: RenderProxyKind::Triangles,
                    world_origin: mesh.glb.world_origin,
                    batch,
                }),
            );
        }
        DecodedThreeDTilesContent::Points(points) => {
            let leaf_index = *next_slot;
            let slot = proxy_slots[leaf_index];
            *next_slot += 1;
            let leaf_style = GpuPresentationStyle::from_render_style(
                style,
                points.points.world_origin,
                exaggeration_datum,
            )?;
            output.push(BuiltThreeDTilesBatch {
                leaf_index,
                kind: RenderProxyKind::Points,
                world_origin: points.points.world_origin,
                batch: build_potree_batch(
                    device,
                    queue,
                    renderer,
                    label_prefix,
                    slot,
                    &points.points,
                    &leaf_style,
                )?,
            });
        }
        DecodedThreeDTilesContent::InstancedMesh(model) => {
            let total_triangles = model
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.indices.len() / 3)
                .sum::<usize>();
            for (chunk_index, chunk) in instanced_model_chunks(model).into_iter().enumerate() {
                let leaf_index = *next_slot;
                let slot = proxy_slots[leaf_index];
                *next_slot += 1;
                let leaf_style = GpuPresentationStyle::from_render_style(
                    style,
                    chunk.world_origin,
                    exaggeration_datum,
                )?;
                let instances = chunk
                    .instance_indices
                    .iter()
                    .enumerate()
                    .map(|(local_index, source_index)| {
                        let source = &model.instances[*source_index];
                        let mut transform = DMat4::from_cols_array(&source.world_from_model.0);
                        transform.w_axis.x -= chunk.world_origin.x;
                        transform.w_axis.y -= chunk.world_origin.y;
                        transform.w_axis.z -= chunk.world_origin.z;
                        let source_rows = transform.transpose().to_cols_array_2d();
                        let mut rows = [[0.0_f32; 4]; 3];
                        for row in 0..3 {
                            for column in 0..4 {
                                rows[row][column] = f64_to_f32_instance(source_rows[row][column])?;
                            }
                        }
                        let linear = DMat3::from_mat4(transform);
                        let normal = if linear.determinant().abs() > f64::MIN_POSITIVE {
                            linear.inverse().transpose()
                        } else {
                            DMat3::IDENTITY
                        };
                        let source_normal_rows = normal.transpose().to_cols_array_2d();
                        let mut normal_rows = [[0.0_f32; 4]; 3];
                        for row in 0..3 {
                            for column in 0..3 {
                                normal_rows[row][column] =
                                    f64_to_f32_instance(source_normal_rows[row][column])?;
                            }
                        }
                        let primitive_offset = local_index
                            .checked_mul(total_triangles)
                            .and_then(|value| u32::try_from(value).ok())
                            .ok_or(GpuFrameError::TooManyVertices)?;
                        Ok(GpuMeshInstanceInput::new(
                            rows,
                            normal_rows,
                            slot,
                            primitive_offset,
                        ))
                    })
                    .collect::<Result<Vec<_>, ResourceBuildError>>()?;
                let identity = gpu_indexed_geometry_identity(&model.glb);
                let built = if let Some(geometries) = shared_geometries.get(&identity) {
                    build_instanced_glb_batches_with_geometries_and_textures(
                        device,
                        queue,
                        renderer,
                        &format!("{label_prefix}-instances-{chunk_index}"),
                        &model.glb,
                        geometries,
                        &instances,
                        &leaf_style,
                        shared_textures,
                    )?
                } else {
                    build_instanced_glb_batches(
                        device,
                        queue,
                        renderer,
                        &format!("{label_prefix}-instances-{chunk_index}"),
                        &model.glb,
                        &instances,
                        &leaf_style,
                    )?
                };
                output.extend(built.into_iter().map(|batch| BuiltThreeDTilesBatch {
                    leaf_index,
                    kind: RenderProxyKind::Triangles,
                    world_origin: chunk.world_origin,
                    batch,
                }));
            }
        }
        DecodedThreeDTilesContent::Composite(children) => {
            for (index, child) in children.iter().enumerate() {
                build_three_d_tiles_node(
                    device,
                    queue,
                    renderer,
                    &format!("{label_prefix}-{index}"),
                    proxy_slots,
                    next_slot,
                    child,
                    style,
                    exaggeration_datum,
                    shared_geometries,
                    shared_textures,
                    output,
                )?;
            }
        }
    }
    Ok(())
}

impl Error for ResourceBuildError {}

impl From<GpuFrameError> for ResourceBuildError {
    fn from(error: GpuFrameError) -> Self {
        Self::Gpu(error)
    }
}

/// Uploads one decoded Potree node using the compact point vertex format.
pub fn build_potree_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    proxy_slot: u32,
    points: &DecodedPotreePoints,
    style: &GpuPresentationStyle,
) -> Result<GpuDrawBatch, GpuFrameError> {
    let batch = GpuDrawBatch::new_potree_points_with_queue(
        device,
        queue,
        label,
        proxy_slot,
        &points.positions,
        &points.colors,
        points.civil_attributes.as_deref(),
    )?;
    let material = renderer.create_styled_material(
        device,
        queue,
        &format!("{label}-style"),
        GpuTextureData {
            width: 1,
            height: 1,
            rgba8: &[255; 4],
        },
        if style.opacity() < 1.0 {
            GpuAlphaMode::Blend
        } else {
            GpuAlphaMode::Opaque
        },
        *style,
    )?;
    Ok(batch.with_material(material))
}

/// Uploads decoded splats into the shared transparent, clip and pick pipelines.
pub fn build_gaussian_splat_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    proxy_slot: u32,
    decoded: &DecodedGaussianSplats,
    style: &GpuPresentationStyle,
) -> Result<GpuDrawBatch, GpuFrameError> {
    build_gaussian_splat_block(
        device,
        queue,
        renderer,
        label,
        proxy_slot,
        &decoded.splats,
        style,
        0,
    )
}

/// Uploads decoded splats as bounded, independently sortable downlevel blocks.
/// Primitive pick slots remain global to the source tile across every block.
pub fn build_gaussian_splat_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    proxy_slot: u32,
    decoded: &DecodedGaussianSplats,
    style: &GpuPresentationStyle,
) -> Result<Vec<GpuDrawBatch>, GpuFrameError> {
    if renderer.transparency_strategy() == crate::TransparencyStrategy::WeightedBlended {
        return build_gaussian_splat_batch(
            device, queue, renderer, label, proxy_slot, decoded, style,
        )
        .map(|batch| vec![batch]);
    }
    decoded
        .splats
        .chunks(crate::SORTED_ALPHA_SPLAT_BLOCK_SIZE)
        .enumerate()
        .map(|(block_index, splats)| {
            let first = block_index
                .checked_mul(crate::SORTED_ALPHA_SPLAT_BLOCK_SIZE)
                .ok_or(GpuFrameError::TooManyVertices)?;
            build_gaussian_splat_block(
                device,
                queue,
                renderer,
                &format!("{label}-sort-block-{block_index}"),
                proxy_slot,
                splats,
                style,
                first,
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_gaussian_splat_block(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    proxy_slot: u32,
    decoded: &[DecodedGaussianSplat],
    style: &GpuPresentationStyle,
    primitive_base: usize,
) -> Result<GpuDrawBatch, GpuFrameError> {
    if proxy_slot == 0 {
        return Err(GpuFrameError::InvalidProxySlot);
    }
    let splats = decoded
        .iter()
        .enumerate()
        .map(|(primitive_slot, splat)| {
            let primitive_slot = primitive_base
                .checked_add(primitive_slot)
                .ok_or(GpuFrameError::TooManyVertices)?;
            Ok(GpuSplatVertex {
                position: splat.position,
                color: splat.color,
                scale: splat.scale,
                rotation: splat.rotation,
                proxy_slot,
                primitive_slot: u32::try_from(primitive_slot)
                    .map_err(|_| GpuFrameError::TooManyVertices)?,
            })
        })
        .collect::<Result<Vec<_>, GpuFrameError>>()?;
    let batch = GpuDrawBatch::new_gaussian_splats_for_transparency_with_queue(
        device,
        queue,
        label,
        &splats,
        renderer.transparency_strategy(),
    )?;
    let material = renderer.create_styled_material(
        device,
        queue,
        &format!("{label}-style"),
        GpuTextureData {
            width: 1,
            height: 1,
            rgba8: &[255; 4],
        },
        GpuAlphaMode::Blend,
        *style,
    )?;
    Ok(batch.with_material(material))
}

/// Uploads an elevation raster mesh and its original sRGB orthophoto texture.
pub fn build_elevation_raster_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    proxy_slot: u32,
    raster: &DecodedElevationRaster,
    style: &GpuPresentationStyle,
) -> Result<GpuDrawBatch, ResourceBuildError> {
    let batch = GpuDrawBatch::new_indexed_mesh_with_queue(
        device,
        queue,
        label,
        proxy_slot,
        0,
        &raster.vertices,
        &raster.indices,
        false,
    )?
    .with_declared_texture_coordinates(true);
    let material = renderer.create_styled_material(
        device,
        queue,
        &format!("{label}-color"),
        GpuTextureData {
            width: raster.color_width,
            height: raster.color_height,
            rgba8: &raster.rgba8,
        },
        raster_alpha_mode(&raster.rgba8),
        *style,
    )?;
    Ok(batch.with_material(material))
}

fn raster_alpha_mode(rgba8: &[u8]) -> GpuAlphaMode {
    if rgba8.chunks_exact(4).any(|pixel| pixel[3] != 255) {
        GpuAlphaMode::Blend
    } else {
        GpuAlphaMode::Opaque
    }
}

/// Uploads all GLB primitives while preserving one collision-free triangle-ID range.
#[allow(clippy::too_many_lines)]
pub fn build_glb_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    proxy_slot: u32,
    glb: &DecodedGlb,
    style: &GpuPresentationStyle,
) -> Result<Vec<GpuDrawBatch>, ResourceBuildError> {
    build_glb_batches_with_textures(
        device,
        queue,
        renderer,
        label_prefix,
        proxy_slot,
        glb,
        style,
        &PreparedGpuTextureResources::default(),
    )
}

/// Uploads GLB geometry with owner-local styles around shared textures.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn build_glb_batches_with_textures(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    proxy_slot: u32,
    glb: &DecodedGlb,
    style: &GpuPresentationStyle,
    shared_textures: &PreparedGpuTextureResources,
) -> Result<Vec<GpuDrawBatch>, ResourceBuildError> {
    let mut primitive_base = 0_u32;
    let mut batches = Vec::with_capacity(glb.primitives.len());
    for (index, primitive) in glb.primitives.iter().enumerate() {
        let label = format!("{label_prefix}-{index}");
        let vertices = mesh_vertices(primitive);
        let transparent = matches!(primitive.material.alpha_mode, DecodedAlphaMode::Blend)
            || primitive.material.base_color_factor[3] < 1.0;
        let mut batch = GpuDrawBatch::new_indexed_mesh_with_queue(
            device,
            queue,
            &label,
            proxy_slot,
            primitive_base,
            &vertices,
            &primitive.indices,
            transparent,
        )?
        .with_declared_texture_coordinates(primitive.has_texture_coordinates);
        batch = batch.with_material(build_glb_material(
            device,
            queue,
            renderer,
            &label,
            glb,
            primitive,
            style,
            shared_textures,
        )?);
        batches.push(batch);
        let triangle_count = u32::try_from(primitive.indices.len() / 3)
            .map_err(|_| GpuFrameError::TooManyVertices)?;
        primitive_base = primitive_base
            .checked_add(triangle_count)
            .ok_or(GpuFrameError::TooManyVertices)?;
    }
    Ok(batches)
}

/// Uploads shared GLB geometry once per chunk and one compact instance buffer.
pub fn build_instanced_glb_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    glb: &DecodedGlb,
    instances: &[GpuMeshInstanceInput],
    style: &GpuPresentationStyle,
) -> Result<Vec<GpuDrawBatch>, ResourceBuildError> {
    let geometries = build_instanced_glb_geometries_with_queue(device, queue, label_prefix, glb)?;
    build_instanced_glb_batches_with_geometries(
        device,
        queue,
        renderer,
        label_prefix,
        glb,
        &geometries,
        instances,
        style,
    )
}

/// Uploads immutable indexed GLB geometry through unmapped queue-backed buffers.
pub fn build_instanced_glb_geometries_with_queue(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label_prefix: &str,
    glb: &DecodedGlb,
) -> Result<Vec<GpuIndexedMeshGeometry>, ResourceBuildError> {
    let mut primitive_base = 0_u32;
    let mut geometries = Vec::with_capacity(glb.primitives.len());
    for (index, primitive) in glb.primitives.iter().enumerate() {
        let label = format!("{label_prefix}-shared-{index}");
        let vertices = mesh_vertices(primitive);
        geometries.push(GpuIndexedMeshGeometry::new_with_primitive_base_and_queue(
            device,
            queue,
            &label,
            primitive_base,
            &vertices,
            &primitive.indices,
        )?);
        primitive_base = primitive_base
            .checked_add(
                u32::try_from(primitive.indices.len() / 3)
                    .map_err(|_| GpuFrameError::TooManyVertices)?,
            )
            .ok_or(GpuFrameError::TooManyVertices)?;
    }
    Ok(geometries)
}

/// Builds tile-specific instance/material batches over immutable model geometry.
#[allow(clippy::too_many_arguments)]
pub fn build_instanced_glb_batches_with_geometries(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    glb: &DecodedGlb,
    geometries: &[GpuIndexedMeshGeometry],
    instances: &[GpuMeshInstanceInput],
    style: &GpuPresentationStyle,
) -> Result<Vec<GpuDrawBatch>, ResourceBuildError> {
    build_instanced_glb_batches_with_geometries_and_textures(
        device,
        queue,
        renderer,
        label_prefix,
        glb,
        geometries,
        instances,
        style,
        &PreparedGpuTextureResources::default(),
    )
}

/// Builds owner-local instance/style state around shared geometry and textures.
#[allow(clippy::too_many_arguments)]
pub fn build_instanced_glb_batches_with_geometries_and_textures(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label_prefix: &str,
    glb: &DecodedGlb,
    geometries: &[GpuIndexedMeshGeometry],
    instances: &[GpuMeshInstanceInput],
    style: &GpuPresentationStyle,
    shared_textures: &PreparedGpuTextureResources,
) -> Result<Vec<GpuDrawBatch>, ResourceBuildError> {
    if instances.is_empty() {
        return Err(GpuFrameError::EmptyBatch.into());
    }
    if geometries.len() != glb.primitives.len() {
        return Err(GpuFrameError::InvalidMeshIndices.into());
    }
    let sorted_alpha = renderer.transparency_strategy() == TransparencyStrategy::SortedAlpha;
    let block_count = if sorted_alpha {
        instances
            .len()
            .div_ceil(SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE)
    } else {
        1
    };
    let mut batches = Vec::with_capacity(glb.primitives.len().saturating_mul(block_count));
    for (index, primitive) in glb.primitives.iter().enumerate() {
        let label = format!("{label_prefix}-{index}");
        let transparent = matches!(primitive.material.alpha_mode, DecodedAlphaMode::Blend)
            || primitive.material.base_color_factor[3] < 1.0;
        let block_size = if sorted_alpha {
            SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE
        } else {
            instances.len()
        };
        let mut blocks = instances.chunks(block_size);
        let first_instances = blocks.next().expect("validated non-empty instance list");
        let mut batch =
            GpuDrawBatch::new_instanced_shared_indexed_mesh_for_transparency_with_queue(
                device,
                queue,
                &geometries[index],
                first_instances,
                transparent,
                renderer.transparency_strategy(),
            )?
            .with_declared_texture_coordinates(primitive.has_texture_coordinates);
        batch = batch.with_material(build_glb_material(
            device,
            queue,
            renderer,
            &label,
            glb,
            primitive,
            style,
            shared_textures,
        )?);
        let block_batches = blocks
            .map(|instances| batch.fork_with_mesh_instances_and_queue(device, queue, instances))
            .collect::<Result<Vec<_>, _>>()?;
        batches.push(batch);
        batches.extend(block_batches);
    }
    Ok(batches)
}

fn build_glb_material(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    glb: &DecodedGlb,
    primitive: &DecodedMeshPrimitive,
    style: &GpuPresentationStyle,
    shared_textures: &PreparedGpuTextureResources,
) -> Result<GpuMaterial, ResourceBuildError> {
    let image = primitive
        .material
        .base_color_image
        .map(|image_index| {
            glb.images
                .get(image_index)
                .ok_or(ResourceBuildError::MissingImage(image_index))
        })
        .transpose()?;
    let alpha_mode = match primitive.material.alpha_mode {
        DecodedAlphaMode::Mask { cutoff } => GpuAlphaMode::Mask { cutoff },
        mode => gpu_alpha_mode(mode),
    };
    if let Some(texture) = shared_textures.resource_for_image(image) {
        return renderer
            .create_styled_material_from_texture(
                device,
                queue,
                &format!("{label}-cached-texture"),
                &texture,
                alpha_mode,
                *style,
            )
            .map_err(Into::into);
    }
    if let Some(image_index) = primitive.material.base_color_image {
        let image = image.expect("validated material image exists");
        if image.mime_type == "image/ktx2" {
            let texture = crate::basis_texture::transcode_basis_texture(device, &image.bytes)
                .map_err(|message| ResourceBuildError::ImageDecode {
                    image_index,
                    message,
                })?;
            return renderer
                .create_styled_mip_chain_material(
                    device,
                    queue,
                    &format!("{label}-base-color"),
                    GpuTextureMipChainData {
                        width: texture.width,
                        height: texture.height,
                        mip_level_count: texture.mip_level_count,
                        format: texture.format,
                        data: &texture.data,
                    },
                    gpu_alpha_mode(primitive.material.alpha_mode),
                    *style,
                )
                .map_err(Into::into);
        }
        let decoded =
            crate::decode_limits::decode_bounded_image(&image.bytes).map_err(|error| {
                ResourceBuildError::ImageDecode {
                    image_index,
                    message: error.to_string(),
                }
            })?;
        let rgba = decoded.to_rgba8();
        return renderer
            .create_styled_material(
                device,
                queue,
                &format!("{label}-base-color"),
                GpuTextureData {
                    width: rgba.width(),
                    height: rgba.height(),
                    rgba8: rgba.as_raw(),
                },
                gpu_alpha_mode(primitive.material.alpha_mode),
                *style,
            )
            .map_err(Into::into);
    }
    renderer
        .create_styled_material(
            device,
            queue,
            &format!("{label}-style"),
            GpuTextureData {
                width: 1,
                height: 1,
                rgba8: &[255; 4],
            },
            alpha_mode,
            *style,
        )
        .map_err(Into::into)
}

fn f64_to_f32_instance(value: f64) -> Result<f32, ResourceBuildError> {
    #[allow(clippy::cast_possible_truncation)]
    let value = value as f32;
    value
        .is_finite()
        .then_some(value)
        .ok_or_else(|| GpuFrameError::NonFiniteFrameValue.into())
}

fn gpu_alpha_mode(mode: DecodedAlphaMode) -> GpuAlphaMode {
    match mode {
        DecodedAlphaMode::Opaque => GpuAlphaMode::Opaque,
        DecodedAlphaMode::Mask { cutoff } => GpuAlphaMode::Mask { cutoff },
        DecodedAlphaMode::Blend => GpuAlphaMode::Blend,
    }
}

fn mesh_vertices(primitive: &DecodedMeshPrimitive) -> Vec<GpuMeshVertexInput> {
    primitive
        .vertices
        .iter()
        .map(|vertex| GpuMeshVertexInput {
            position: vertex.position,
            normal: vertex.normal,
            tex_coord: vertex.tex_coord,
            color: std::array::from_fn(|channel| {
                vertex.color[channel] * primitive.material.base_color_factor[channel]
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::raster_alpha_mode;
    use crate::GpuAlphaMode;

    #[test]
    fn raster_alpha_selects_blending_only_for_non_opaque_texels() {
        assert_eq!(
            raster_alpha_mode(&[10, 20, 30, 255, 40, 50, 60, 255]),
            GpuAlphaMode::Opaque
        );
        assert_eq!(
            raster_alpha_mode(&[10, 20, 30, 255, 40, 50, 60, 0]),
            GpuAlphaMode::Blend
        );
    }
}
