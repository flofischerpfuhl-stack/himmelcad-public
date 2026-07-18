//! Stable identities for immutable decoded/GPU model resources.

use sha2::{Digest, Sha256};

/// Backend-relevant texture representation selected before material upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureProfile {
    /// Portable uncompressed sRGB/RGBA path.
    Rgba8 = 0,
    /// BC-family compressed texture target.
    Bc = 1,
    /// ETC2 compressed texture target.
    Etc2 = 2,
    /// ASTC compressed texture target.
    Astc = 3,
}

/// Stable color interpretation of uploaded texture channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureColorSpace {
    /// Channels are sampled without an sRGB transfer function.
    Linear = 0,
    /// RGB channels use the sRGB transfer function.
    Srgb = 1,
}

/// Stable byte ordering used to upload a complete texture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureUploadLayout {
    /// Complete, tightly packed mip levels in largest-to-smallest order.
    MipMajorTightlyPacked = 0,
}

/// Stable texture addressing mode used by an immutable sampler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureAddressMode {
    /// Clamp coordinates to the texture edge.
    ClampToEdge = 0,
    /// Repeat the texture outside the unit square.
    Repeat = 1,
    /// Mirror every other repetition.
    MirrorRepeat = 2,
    /// Use the explicitly selected border color outside the texture.
    ClampToBorder = 3,
}

/// Stable texture filtering mode used by an immutable sampler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureFilterMode {
    /// Select the nearest sample.
    Nearest = 0,
    /// Linearly interpolate adjacent samples.
    Linear = 1,
}

/// Stable comparison function used by a comparison sampler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureCompareFunction {
    /// Never pass.
    Never = 0,
    /// Pass when less.
    Less = 1,
    /// Pass when equal.
    Equal = 2,
    /// Pass when less or equal.
    LessEqual = 3,
    /// Pass when greater.
    Greater = 4,
    /// Pass when not equal.
    NotEqual = 5,
    /// Pass when greater or equal.
    GreaterEqual = 6,
    /// Always pass.
    Always = 7,
}

/// Stable optional sampler border color.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuTextureBorderColor {
    /// Transparent black in linear space.
    TransparentBlack = 0,
    /// Opaque black in linear space.
    OpaqueBlack = 1,
    /// Opaque white in linear space.
    OpaqueWhite = 2,
    /// Backend-defined clamp-to-zero behavior.
    Zero = 3,
}

/// Exact immutable sampler identity. Presentation uniforms are deliberately
/// excluded so differently styled owners can share the same allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GpuTextureSamplerIdentity {
    /// Horizontal addressing mode.
    pub address_u: GpuTextureAddressMode,
    /// Vertical addressing mode.
    pub address_v: GpuTextureAddressMode,
    /// Array/depth addressing mode.
    pub address_w: GpuTextureAddressMode,
    /// Magnification filter.
    pub mag_filter: GpuTextureFilterMode,
    /// Minification filter.
    pub min_filter: GpuTextureFilterMode,
    /// Mipmap filter.
    pub mipmap_filter: GpuTextureFilterMode,
    /// Exact IEEE-754 bits of the minimum mip LOD clamp.
    pub lod_min_clamp_bits: u32,
    /// Exact IEEE-754 bits of the maximum mip LOD clamp.
    pub lod_max_clamp_bits: u32,
    /// Optional comparison function.
    pub compare: Option<GpuTextureCompareFunction>,
    /// Maximum anisotropy, with one meaning disabled.
    pub anisotropy_clamp: u16,
    /// Optional clamp-to-border color.
    pub border_color: Option<GpuTextureBorderColor>,
}

impl GpuTextureSamplerIdentity {
    /// Repeat-and-linear sampler used by the current glTF material pipeline.
    pub const REPEAT_LINEAR: Self = Self {
        address_u: GpuTextureAddressMode::Repeat,
        address_v: GpuTextureAddressMode::Repeat,
        address_w: GpuTextureAddressMode::Repeat,
        mag_filter: GpuTextureFilterMode::Linear,
        min_filter: GpuTextureFilterMode::Linear,
        mipmap_filter: GpuTextureFilterMode::Linear,
        lod_min_clamp_bits: 0.0_f32.to_bits(),
        lod_max_clamp_bits: 32.0_f32.to_bits(),
        compare: None,
        anisotropy_clamp: 1,
        border_color: None,
    };

    /// Converts every backend-relevant field of a `wgpu` sampler descriptor.
    /// The diagnostic label is intentionally excluded from allocation identity.
    #[must_use]
    pub fn from_wgpu(descriptor: &wgpu::SamplerDescriptor<'_>) -> Self {
        let address = |mode| match mode {
            wgpu::AddressMode::ClampToEdge => GpuTextureAddressMode::ClampToEdge,
            wgpu::AddressMode::Repeat => GpuTextureAddressMode::Repeat,
            wgpu::AddressMode::MirrorRepeat => GpuTextureAddressMode::MirrorRepeat,
            wgpu::AddressMode::ClampToBorder => GpuTextureAddressMode::ClampToBorder,
        };
        let filter = |mode| match mode {
            wgpu::FilterMode::Nearest => GpuTextureFilterMode::Nearest,
            wgpu::FilterMode::Linear => GpuTextureFilterMode::Linear,
        };
        let mipmap_filter = |mode| match mode {
            wgpu::MipmapFilterMode::Nearest => GpuTextureFilterMode::Nearest,
            wgpu::MipmapFilterMode::Linear => GpuTextureFilterMode::Linear,
        };
        let compare = descriptor.compare.map(|function| match function {
            wgpu::CompareFunction::Never => GpuTextureCompareFunction::Never,
            wgpu::CompareFunction::Less => GpuTextureCompareFunction::Less,
            wgpu::CompareFunction::Equal => GpuTextureCompareFunction::Equal,
            wgpu::CompareFunction::LessEqual => GpuTextureCompareFunction::LessEqual,
            wgpu::CompareFunction::Greater => GpuTextureCompareFunction::Greater,
            wgpu::CompareFunction::NotEqual => GpuTextureCompareFunction::NotEqual,
            wgpu::CompareFunction::GreaterEqual => GpuTextureCompareFunction::GreaterEqual,
            wgpu::CompareFunction::Always => GpuTextureCompareFunction::Always,
        });
        let border_color = descriptor.border_color.map(|color| match color {
            wgpu::SamplerBorderColor::TransparentBlack => GpuTextureBorderColor::TransparentBlack,
            wgpu::SamplerBorderColor::OpaqueBlack => GpuTextureBorderColor::OpaqueBlack,
            wgpu::SamplerBorderColor::OpaqueWhite => GpuTextureBorderColor::OpaqueWhite,
            wgpu::SamplerBorderColor::Zero => GpuTextureBorderColor::Zero,
        });
        Self {
            address_u: address(descriptor.address_mode_u),
            address_v: address(descriptor.address_mode_v),
            address_w: address(descriptor.address_mode_w),
            mag_filter: filter(descriptor.mag_filter),
            min_filter: filter(descriptor.min_filter),
            mipmap_filter: mipmap_filter(descriptor.mipmap_filter),
            lod_min_clamp_bits: descriptor.lod_min_clamp.to_bits(),
            lod_max_clamp_bits: descriptor.lod_max_clamp.to_bits(),
            compare,
            anisotropy_clamp: descriptor.anisotropy_clamp,
            border_color,
        }
    }

    fn update_hash(self, hash: &mut Sha256) {
        hash.update([
            self.address_u as u8,
            self.address_v as u8,
            self.address_w as u8,
            self.mag_filter as u8,
            self.min_filter as u8,
            self.mipmap_filter as u8,
        ]);
        hash.update(self.lod_min_clamp_bits.to_le_bytes());
        hash.update(self.lod_max_clamp_bits.to_le_bytes());
        hash.update([self.compare.map_or(u8::MAX, |value| value as u8)]);
        hash.update(self.anisotropy_clamp.to_le_bytes());
        hash.update([self.border_color.map_or(u8::MAX, |value| value as u8)]);
    }
}

/// ASTC block footprint selected by a device transcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuAstcBlock {
    /// 4x4 texel block.
    B4x4 = 0,
    /// 5x4 texel block.
    B5x4 = 1,
    /// 5x5 texel block.
    B5x5 = 2,
    /// 6x5 texel block.
    B6x5 = 3,
    /// 6x6 texel block.
    B6x6 = 4,
    /// 8x5 texel block.
    B8x5 = 5,
    /// 8x6 texel block.
    B8x6 = 6,
    /// 8x8 texel block.
    B8x8 = 7,
    /// 10x5 texel block.
    B10x5 = 8,
    /// 10x6 texel block.
    B10x6 = 9,
    /// 10x8 texel block.
    B10x8 = 10,
    /// 10x10 texel block.
    B10x10 = 11,
    /// 12x10 texel block.
    B12x10 = 12,
    /// 12x12 texel block.
    B12x12 = 13,
}

/// ASTC channel interpretation selected by a device transcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum GpuAstcChannel {
    /// Linear normalized channels.
    Unorm = 0,
    /// sRGB color channels.
    UnormSrgb = 1,
    /// High-dynamic-range channels.
    Hdr = 2,
}

/// Exact device upload format relevant to the current image decoders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum GpuTextureUploadFormat {
    /// Linear RGBA8.
    Rgba8Unorm,
    /// sRGB RGBA8.
    Rgba8UnormSrgb,
    /// Linear RGBA16 float.
    Rgba16Float,
    /// Shared-exponent RGB9E5.
    Rgb9e5Ufloat,
    /// Linear BC1.
    Bc1RgbaUnorm,
    /// sRGB BC1.
    Bc1RgbaUnormSrgb,
    /// Linear BC3.
    Bc3RgbaUnorm,
    /// sRGB BC3.
    Bc3RgbaUnormSrgb,
    /// Linear BC4.
    Bc4RUnorm,
    /// Linear BC5.
    Bc5RgUnorm,
    /// Unsigned-float BC6H.
    Bc6hRgbUfloat,
    /// Linear BC7.
    Bc7RgbaUnorm,
    /// sRGB BC7.
    Bc7RgbaUnormSrgb,
    /// Linear ETC2 RGB8.
    Etc2Rgb8Unorm,
    /// sRGB ETC2 RGB8.
    Etc2Rgb8UnormSrgb,
    /// Linear ETC2 RGBA8.
    Etc2Rgba8Unorm,
    /// sRGB ETC2 RGBA8.
    Etc2Rgba8UnormSrgb,
    /// Linear single-channel EAC.
    EacR11Unorm,
    /// Linear two-channel EAC.
    EacRg11Unorm,
    /// ASTC with an exact block footprint and channel interpretation.
    Astc {
        /// Compressed block footprint.
        block: GpuAstcBlock,
        /// Channel interpretation.
        channel: GpuAstcChannel,
    },
}

impl GpuTextureUploadFormat {
    /// Maps a concrete `wgpu` upload format into the stable cache-key domain.
    /// Unsupported future formats must add an explicit stable variant before
    /// they can participate in immutable sharing.
    #[must_use]
    pub fn from_wgpu(format: wgpu::TextureFormat) -> Option<Self> {
        use wgpu::{AstcBlock as Block, AstcChannel as Channel, TextureFormat as Format};

        let astc_block = |block| {
            Some(match block {
                Block::B4x4 => GpuAstcBlock::B4x4,
                Block::B5x4 => GpuAstcBlock::B5x4,
                Block::B5x5 => GpuAstcBlock::B5x5,
                Block::B6x5 => GpuAstcBlock::B6x5,
                Block::B6x6 => GpuAstcBlock::B6x6,
                Block::B8x5 => GpuAstcBlock::B8x5,
                Block::B8x6 => GpuAstcBlock::B8x6,
                Block::B8x8 => GpuAstcBlock::B8x8,
                Block::B10x5 => GpuAstcBlock::B10x5,
                Block::B10x6 => GpuAstcBlock::B10x6,
                Block::B10x8 => GpuAstcBlock::B10x8,
                Block::B10x10 => GpuAstcBlock::B10x10,
                Block::B12x10 => GpuAstcBlock::B12x10,
                Block::B12x12 => GpuAstcBlock::B12x12,
            })
        };
        let astc_channel = |channel| {
            Some(match channel {
                Channel::Unorm => GpuAstcChannel::Unorm,
                Channel::UnormSrgb => GpuAstcChannel::UnormSrgb,
                Channel::Hdr => GpuAstcChannel::Hdr,
            })
        };
        Some(match format {
            Format::Rgba8Unorm => Self::Rgba8Unorm,
            Format::Rgba8UnormSrgb => Self::Rgba8UnormSrgb,
            Format::Rgba16Float => Self::Rgba16Float,
            Format::Rgb9e5Ufloat => Self::Rgb9e5Ufloat,
            Format::Bc1RgbaUnorm => Self::Bc1RgbaUnorm,
            Format::Bc1RgbaUnormSrgb => Self::Bc1RgbaUnormSrgb,
            Format::Bc3RgbaUnorm => Self::Bc3RgbaUnorm,
            Format::Bc3RgbaUnormSrgb => Self::Bc3RgbaUnormSrgb,
            Format::Bc4RUnorm => Self::Bc4RUnorm,
            Format::Bc5RgUnorm => Self::Bc5RgUnorm,
            Format::Bc6hRgbUfloat => Self::Bc6hRgbUfloat,
            Format::Bc7RgbaUnorm => Self::Bc7RgbaUnorm,
            Format::Bc7RgbaUnormSrgb => Self::Bc7RgbaUnormSrgb,
            Format::Etc2Rgb8Unorm => Self::Etc2Rgb8Unorm,
            Format::Etc2Rgb8UnormSrgb => Self::Etc2Rgb8UnormSrgb,
            Format::Etc2Rgba8Unorm => Self::Etc2Rgba8Unorm,
            Format::Etc2Rgba8UnormSrgb => Self::Etc2Rgba8UnormSrgb,
            Format::EacR11Unorm => Self::EacR11Unorm,
            Format::EacRg11Unorm => Self::EacRg11Unorm,
            Format::Astc { block, channel } => Self::Astc {
                block: astc_block(block)?,
                channel: astc_channel(channel)?,
            },
            _ => return None,
        })
    }

    fn update_hash(self, hash: &mut Sha256) {
        let (tag, block, channel) = match self {
            Self::Rgba8Unorm => (0, 0, 0),
            Self::Rgba8UnormSrgb => (1, 0, 0),
            Self::Rgba16Float => (2, 0, 0),
            Self::Rgb9e5Ufloat => (3, 0, 0),
            Self::Bc1RgbaUnorm => (4, 0, 0),
            Self::Bc1RgbaUnormSrgb => (5, 0, 0),
            Self::Bc3RgbaUnorm => (6, 0, 0),
            Self::Bc3RgbaUnormSrgb => (7, 0, 0),
            Self::Bc4RUnorm => (8, 0, 0),
            Self::Bc5RgUnorm => (9, 0, 0),
            Self::Bc6hRgbUfloat => (10, 0, 0),
            Self::Bc7RgbaUnorm => (11, 0, 0),
            Self::Bc7RgbaUnormSrgb => (12, 0, 0),
            Self::Etc2Rgb8Unorm => (13, 0, 0),
            Self::Etc2Rgb8UnormSrgb => (14, 0, 0),
            Self::Etc2Rgba8Unorm => (15, 0, 0),
            Self::Etc2Rgba8UnormSrgb => (16, 0, 0),
            Self::EacR11Unorm => (17, 0, 0),
            Self::EacRg11Unorm => (18, 0, 0),
            Self::Astc { block, channel } => (19, block as u8, channel as u8),
        };
        hash.update([tag, block, channel]);
    }
}

/// Exact immutable input used to identify an uploaded texture and sampler.
#[derive(Debug, Clone, Copy)]
pub struct GpuUploadedTextureIdentityInput<'a> {
    /// Base mip width.
    pub width: u32,
    /// Base mip height.
    pub height: u32,
    /// Complete mip count.
    pub mip_level_count: u32,
    /// Chosen backend upload/transcode format.
    pub format: GpuTextureUploadFormat,
    /// Byte ordering of `data`.
    pub layout: GpuTextureUploadLayout,
    /// Color interpretation independent from the container or URI.
    pub color_space: GpuTextureColorSpace,
    /// Exact immutable sampler state.
    pub sampler: GpuTextureSamplerIdentity,
    /// Revision of the decoder/transcoder path producing these bytes.
    pub decoder_revision: u32,
    /// Exact bytes submitted to the GPU.
    pub data: &'a [u8],
}

/// Content-derived identity of immutable decoded indexed geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GpuModelResourceIdentity([u8; 32]);

impl GpuModelResourceIdentity {
    pub(crate) const fn from_digest(digest: [u8; 32]) -> Self {
        Self(digest)
    }

    /// Hashes a normalized, self-contained glTF/GLB source and every decode
    /// revision that can change uploaded vertex/index bytes.
    #[must_use]
    pub fn for_self_contained_source(
        source: &[u8],
        decoder_revision: u32,
        vertex_layout_revision: u32,
    ) -> Self {
        let mut hash = Sha256::new();
        hash.update(b"himmelcad-gpu-model-v1\0");
        hash.update(decoder_revision.to_le_bytes());
        hash.update(vertex_layout_revision.to_le_bytes());
        hash.update(
            u64::try_from(source.len())
                .unwrap_or(u64::MAX)
                .to_le_bytes(),
        );
        hash.update(source);
        Self(hash.finalize().into())
    }

    /// Digest bytes suitable for deterministic cache keys and diagnostics.
    #[must_use]
    pub const fn digest(self) -> [u8; 32] {
        self.0
    }
}

/// Content-derived identity of an immutable uploaded material/texture set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GpuMaterialResourceIdentity([u8; 32]);

/// Content-derived identity of one immutable uploaded texture/sampler pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GpuTextureResourceIdentity([u8; 32]);

impl GpuTextureResourceIdentity {
    /// Hashes the exact uploaded texture representation and sampler state.
    /// Source URI, entity identity and presentation style are intentionally
    /// absent from this contract.
    #[must_use]
    pub fn for_uploaded_texture(input: GpuUploadedTextureIdentityInput<'_>) -> Self {
        let mut hash = Sha256::new();
        hash.update(b"himmelcad-gpu-texture-v1\0");
        hash.update(input.width.to_le_bytes());
        hash.update(input.height.to_le_bytes());
        hash.update(input.mip_level_count.to_le_bytes());
        input.format.update_hash(&mut hash);
        hash.update([input.layout as u8, input.color_space as u8]);
        input.sampler.update_hash(&mut hash);
        hash.update(input.decoder_revision.to_le_bytes());
        hash.update(
            u64::try_from(input.data.len())
                .unwrap_or(u64::MAX)
                .to_le_bytes(),
        );
        hash.update(input.data);
        Self(hash.finalize().into())
    }

    /// Digest bytes suitable for deterministic cache keys and diagnostics.
    #[must_use]
    pub const fn digest(self) -> [u8; 32] {
        self.0
    }
}

impl GpuMaterialResourceIdentity {
    /// Derives a primitive material key from model content plus the selected
    /// backend texture profile and material decoder revision.
    #[must_use]
    pub fn for_primitive(
        model: GpuModelResourceIdentity,
        primitive_index: u32,
        texture_profile: GpuTextureProfile,
        material_decoder_revision: u32,
    ) -> Self {
        let mut hash = Sha256::new();
        hash.update(b"himmelcad-gpu-material-v1\0");
        hash.update(model.digest());
        hash.update(primitive_index.to_le_bytes());
        hash.update([texture_profile as u8]);
        hash.update(material_decoder_revision.to_le_bytes());
        Self(hash.finalize().into())
    }

    /// Digest bytes suitable for deterministic cache keys and diagnostics.
    #[must_use]
    pub const fn digest(self) -> [u8; 32] {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_content_and_decode_profile_based_not_uri_based() {
        let source = b"normalized self-contained glb";
        let from_first_uri = GpuModelResourceIdentity::for_self_contained_source(source, 3, 7);
        let from_second_uri = GpuModelResourceIdentity::for_self_contained_source(source, 3, 7);
        assert_eq!(from_first_uri, from_second_uri);
        assert_ne!(
            from_first_uri,
            GpuModelResourceIdentity::for_self_contained_source(b"different bytes", 3, 7)
        );
        assert_ne!(
            from_first_uri,
            GpuModelResourceIdentity::for_self_contained_source(source, 4, 7)
        );
    }

    #[test]
    fn material_identity_changes_with_primitive_backend_or_decoder() {
        let model = GpuModelResourceIdentity::for_self_contained_source(b"glb", 1, 1);
        let base = GpuMaterialResourceIdentity::for_primitive(model, 0, GpuTextureProfile::Bc, 2);
        assert_ne!(
            base,
            GpuMaterialResourceIdentity::for_primitive(model, 1, GpuTextureProfile::Bc, 2)
        );
        assert_ne!(
            base,
            GpuMaterialResourceIdentity::for_primitive(model, 0, GpuTextureProfile::Etc2, 2)
        );
        assert_ne!(
            base,
            GpuMaterialResourceIdentity::for_primitive(model, 0, GpuTextureProfile::Bc, 3)
        );
    }

    #[test]
    fn uploaded_texture_identity_covers_bytes_layout_color_sampler_and_revision() {
        let base = GpuUploadedTextureIdentityInput {
            width: 4,
            height: 4,
            mip_level_count: 2,
            format: GpuTextureUploadFormat::Bc7RgbaUnormSrgb,
            layout: GpuTextureUploadLayout::MipMajorTightlyPacked,
            color_space: GpuTextureColorSpace::Srgb,
            sampler: GpuTextureSamplerIdentity::REPEAT_LINEAR,
            decoder_revision: 9,
            data: &[1, 2, 3, 4],
        };
        let identity = GpuTextureResourceIdentity::for_uploaded_texture(base);
        assert_ne!(
            identity,
            GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
                data: &[1, 2, 3, 5],
                ..base
            })
        );
        assert_ne!(
            identity,
            GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
                format: GpuTextureUploadFormat::Rgba8UnormSrgb,
                ..base
            })
        );
        assert_ne!(
            identity,
            GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
                mip_level_count: 1,
                ..base
            })
        );
        assert_ne!(
            identity,
            GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
                color_space: GpuTextureColorSpace::Linear,
                ..base
            })
        );
        assert_ne!(
            identity,
            GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
                sampler: GpuTextureSamplerIdentity {
                    address_u: GpuTextureAddressMode::ClampToEdge,
                    ..GpuTextureSamplerIdentity::REPEAT_LINEAR
                },
                ..base
            })
        );
        assert_ne!(
            identity,
            GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
                decoder_revision: 10,
                ..base
            })
        );
    }

    #[test]
    fn sampler_identity_maps_every_current_repeat_linear_field() {
        let descriptor = wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..wgpu::SamplerDescriptor::default()
        };
        assert_eq!(
            GpuTextureSamplerIdentity::from_wgpu(&descriptor),
            GpuTextureSamplerIdentity::REPEAT_LINEAR
        );
        let comparison = wgpu::SamplerDescriptor {
            compare: Some(wgpu::CompareFunction::LessEqual),
            lod_max_clamp: 7.5,
            anisotropy_clamp: 4,
            ..descriptor
        };
        assert_ne!(
            GpuTextureSamplerIdentity::from_wgpu(&comparison),
            GpuTextureSamplerIdentity::REPEAT_LINEAR
        );
    }
}
