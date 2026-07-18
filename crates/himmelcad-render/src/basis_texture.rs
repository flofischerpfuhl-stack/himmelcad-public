//! Device-specific Basis Universal transcoding for glTF KTX2 images.

use bevy_basisu_loader_sys::{
    BasisuTranscoder, ChannelType, SupportedTextureCompressionMethods, TranscodedTextureFormat,
};

/// One device-ready two-dimensional texture with a complete mip chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranscodedBasisTexture {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) mip_level_count: u32,
    pub(crate) format: wgpu::TextureFormat,
    pub(crate) data: Vec<u8>,
}

pub(crate) fn transcode_basis_texture(
    device: &wgpu::Device,
    encoded: &[u8],
) -> Result<TranscodedBasisTexture, String> {
    transcode_basis_texture_for_features(device.features(), encoded)
}

fn transcode_basis_texture_for_features(
    features: wgpu::Features,
    encoded: &[u8],
) -> Result<TranscodedBasisTexture, String> {
    preflight_ktx2(encoded)?;
    let mut transcoder = BasisuTranscoder::new();
    let info = transcoder
        .start(
            encoded.to_vec(),
            supported_compression(features),
            ChannelType::CHANNEL_UNDEFINED,
        )
        .ok_or_else(|| "invalid or unsupported Basis Universal KTX2 payload".to_owned())?;
    if info.layers > 1 || info.faces != 1 || info.width == 0 || info.height == 0 || info.levels == 0
    {
        return Err("glTF BasisU image must be a non-empty two-dimensional texture".to_owned());
    }
    let format = texture_format(info.preferred_target, info.is_srgb)
        .ok_or_else(|| format!("unsupported BasisU target {:?}", info.preferred_target))?;
    let data = transcoder
        .output(info.preferred_target)
        .ok_or_else(|| "Basis Universal texture transcoding failed".to_owned())?;
    let expected = mip_chain_byte_length(info.width, info.height, info.levels, format)?;
    if data.len() != expected {
        return Err(format!(
            "BasisU transcoder returned {} bytes, expected {expected}",
            data.len()
        ));
    }
    Ok(TranscodedBasisTexture {
        width: info.width,
        height: info.height,
        mip_level_count: info.levels,
        format,
        data,
    })
}

fn preflight_ktx2(encoded: &[u8]) -> Result<(), String> {
    const IDENTIFIER: &[u8; 12] = b"\xabKTX 20\xbb\r\n\x1a\n";
    if encoded.len() > crate::decode_limits::MAX_ENCODED_CONTENT_BYTES
        || encoded.get(..12) != Some(IDENTIFIER)
    {
        return Err("invalid or oversized Basis Universal KTX2 payload".to_owned());
    }
    let read = |offset: usize| {
        encoded
            .get(offset..offset + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
            .ok_or_else(|| "truncated Basis Universal KTX2 header".to_owned())
    };
    let width = read(20)?;
    let height = read(24)?;
    let depth = read(28)?;
    let layers = read(32)?;
    let faces = read(36)?;
    let levels = read(40)?;
    if width == 0
        || height == 0
        || width > crate::decode_limits::MAX_IMAGE_DIMENSION
        || height > crate::decode_limits::MAX_IMAGE_DIMENSION
        || depth > 1
        || layers > 1
        || faces != 1
        || levels > 32
    {
        return Err("glTF BasisU image exceeds the bounded 2D texture profile".to_owned());
    }
    let rgba8_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "BasisU base level byte length overflows".to_owned())?;
    if rgba8_bytes > crate::decode_limits::MAX_IMAGE_RGBA8_BYTES as u64 {
        return Err("BasisU decoded base level exceeds the image budget".to_owned());
    }
    Ok(())
}

pub(crate) fn transcode_basis_texture_rgba8(encoded: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut texture = transcode_basis_texture_for_features(wgpu::Features::empty(), encoded)?;
    if !matches!(
        texture.format,
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb
    ) {
        return Err("BasisU CPU decode did not produce RGBA8 texels".to_owned());
    }
    let byte_length = u64::from(texture.width)
        .checked_mul(u64::from(texture.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok())
        .ok_or_else(|| "BasisU feature texture dimensions exceed address space".to_owned())?;
    texture.data.truncate(byte_length);
    Ok((texture.width, texture.height, texture.data))
}

fn supported_compression(features: wgpu::Features) -> SupportedTextureCompressionMethods {
    let mut supported = SupportedTextureCompressionMethods::NONE;
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_BC) {
        supported |= SupportedTextureCompressionMethods::BC;
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_ETC2) {
        supported |= SupportedTextureCompressionMethods::ETC2;
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_ASTC) {
        supported |= SupportedTextureCompressionMethods::ASTC_LDR;
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_ASTC_HDR) {
        supported |= SupportedTextureCompressionMethods::ASTC_HDR;
    }
    supported
}

#[allow(clippy::too_many_lines)]
fn texture_format(target: TranscodedTextureFormat, srgb: bool) -> Option<wgpu::TextureFormat> {
    use wgpu::{AstcBlock as Block, AstcChannel as Channel, TextureFormat as Format};

    let color_channel = if srgb {
        Channel::UnormSrgb
    } else {
        Channel::Unorm
    };
    Some(match target {
        TranscodedTextureFormat::cTFETC1_RGB => {
            if srgb {
                Format::Etc2Rgb8UnormSrgb
            } else {
                Format::Etc2Rgb8Unorm
            }
        }
        TranscodedTextureFormat::cTFETC2_RGBA => {
            if srgb {
                Format::Etc2Rgba8UnormSrgb
            } else {
                Format::Etc2Rgba8Unorm
            }
        }
        TranscodedTextureFormat::cTFBC1_RGB => {
            if srgb {
                Format::Bc1RgbaUnormSrgb
            } else {
                Format::Bc1RgbaUnorm
            }
        }
        TranscodedTextureFormat::cTFBC3_RGBA => {
            if srgb {
                Format::Bc3RgbaUnormSrgb
            } else {
                Format::Bc3RgbaUnorm
            }
        }
        TranscodedTextureFormat::cTFBC4_R => Format::Bc4RUnorm,
        TranscodedTextureFormat::cTFBC5_RG => Format::Bc5RgUnorm,
        TranscodedTextureFormat::cTFBC7_RGBA => {
            if srgb {
                Format::Bc7RgbaUnormSrgb
            } else {
                Format::Bc7RgbaUnorm
            }
        }
        TranscodedTextureFormat::cTFASTC_LDR_4x4_RGBA => Format::Astc {
            block: Block::B4x4,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_5x4_RGBA => Format::Astc {
            block: Block::B5x4,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_5x5_RGBA => Format::Astc {
            block: Block::B5x5,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_6x5_RGBA => Format::Astc {
            block: Block::B6x5,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_6x6_RGBA => Format::Astc {
            block: Block::B6x6,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_8x5_RGBA => Format::Astc {
            block: Block::B8x5,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_8x6_RGBA => Format::Astc {
            block: Block::B8x6,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_8x8_RGBA => Format::Astc {
            block: Block::B8x8,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_10x5_RGBA => Format::Astc {
            block: Block::B10x5,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_10x6_RGBA => Format::Astc {
            block: Block::B10x6,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_10x8_RGBA => Format::Astc {
            block: Block::B10x8,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_10x10_RGBA => Format::Astc {
            block: Block::B10x10,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_12x10_RGBA => Format::Astc {
            block: Block::B12x10,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFASTC_LDR_12x12_RGBA => Format::Astc {
            block: Block::B12x12,
            channel: color_channel,
        },
        TranscodedTextureFormat::cTFETC2_EAC_R11 => Format::EacR11Unorm,
        TranscodedTextureFormat::cTFETC2_EAC_RG11 => Format::EacRg11Unorm,
        TranscodedTextureFormat::cTFBC6H => Format::Bc6hRgbUfloat,
        TranscodedTextureFormat::cTFASTC_HDR_4x4_RGBA => Format::Astc {
            block: Block::B4x4,
            channel: Channel::Hdr,
        },
        TranscodedTextureFormat::cTFASTC_HDR_6x6_RGBA => Format::Astc {
            block: Block::B6x6,
            channel: Channel::Hdr,
        },
        TranscodedTextureFormat::cTFRGBA32 => {
            if srgb {
                Format::Rgba8UnormSrgb
            } else {
                Format::Rgba8Unorm
            }
        }
        TranscodedTextureFormat::cTFRGBA_HALF => Format::Rgba16Float,
        TranscodedTextureFormat::cTFRGB_9E5 => Format::Rgb9e5Ufloat,
        _ => return None,
    })
}

fn mip_chain_byte_length(
    width: u32,
    height: u32,
    levels: u32,
    format: wgpu::TextureFormat,
) -> Result<usize, String> {
    let block_size = u64::from(
        format
            .block_copy_size(None)
            .ok_or_else(|| "BasisU target has no color block size".to_owned())?,
    );
    let (block_width, block_height) = format.block_dimensions();
    let mut bytes = 0_u64;
    for level in 0..levels {
        let width = (width >> level).max(1);
        let height = (height >> level).max(1);
        let blocks_x = width.div_ceil(block_width);
        let blocks_y = height.div_ceil(block_height);
        bytes = bytes
            .checked_add(u64::from(blocks_x) * u64::from(blocks_y) * block_size)
            .ok_or_else(|| "BasisU mip-chain length overflows".to_owned())?;
    }
    usize::try_from(bytes).map_err(|error| format!("BasisU mip-chain is too large: {error}"))
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::{mip_chain_byte_length, preflight_ktx2, transcode_basis_texture_for_features};

    #[test]
    fn computes_uncompressed_and_block_compressed_mip_lengths() {
        assert_eq!(
            mip_chain_byte_length(8, 8, 4, wgpu::TextureFormat::Rgba8Unorm).expect("RGBA"),
            340
        );
        assert_eq!(
            mip_chain_byte_length(8, 8, 4, wgpu::TextureFormat::Bc7RgbaUnorm).expect("BC7"),
            112
        );
    }

    #[test]
    fn rejects_bomb_dimensions_before_starting_the_native_transcoder() {
        let mut header = vec![0_u8; 80];
        header[..12].copy_from_slice(b"\xabKTX 20\xbb\r\n\x1a\n");
        header[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
        header[24..28].copy_from_slice(&u32::MAX.to_le_bytes());
        header[36..40].copy_from_slice(&1_u32.to_le_bytes());
        header[40..44].copy_from_slice(&1_u32.to_le_bytes());
        assert!(preflight_ktx2(&header)
            .expect_err("oversized dimensions")
            .contains("bounded"));
    }

    #[tokio::test]
    async fn transcodes_pinned_etc1s_ktx2_with_the_uncompressed_fallback() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        bevy_basisu_loader_sys::basisu_init().await;
        let fixture: String = include_str!("../test-data/alpha0-etc1s-mips.ktx2.b64")
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .collect();
        let encoded = base64::engine::general_purpose::STANDARD
            .decode(fixture)
            .expect("pinned KTX2 base64");
        assert_eq!(encoded.len(), 2703);

        let texture =
            transcode_basis_texture_for_features(wgpu::Features::empty(), &encoded).expect("KTX2");
        assert!(texture.width > 0);
        assert!(texture.height > 0);
        assert!(texture.mip_level_count > 1);
        assert_eq!(texture.format, wgpu::TextureFormat::Rgba8UnormSrgb);
        assert_eq!(
            texture.data.len(),
            mip_chain_byte_length(
                texture.width,
                texture.height,
                texture.mip_level_count,
                texture.format
            )
            .expect("mip chain")
        );

        let bc_texture =
            transcode_basis_texture_for_features(wgpu::Features::TEXTURE_COMPRESSION_BC, &encoded)
                .expect("BC KTX2");
        assert_eq!(bc_texture.format, wgpu::TextureFormat::Bc7RgbaUnormSrgb);
        assert!(bc_texture.data.len() < texture.data.len());
    }

    #[tokio::test]
    async fn transcodes_pinned_uastc_zstd_ktx2_with_complete_mips() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        bevy_basisu_loader_sys::basisu_init().await;
        // KhronosGroup/glTF-Sample-Assets, CarConcept/Rib_N.ktx2 at main on
        // 2026-07-16. SHA-256:
        // 7bbd1d7776a087b48d3f7d50395d24840fd00dc5ab2622f8dce5685995df94d3
        let fixture: String =
            include_str!("../test-data/khronos-rib-normal-uastc-zstd-mips.ktx2.b64")
                .chars()
                .filter(|character| !character.is_ascii_whitespace())
                .collect();
        let encoded = base64::engine::general_purpose::STANDARD
            .decode(fixture)
            .expect("pinned Khronos UASTC KTX2 base64");
        assert_eq!(encoded.len(), 622);

        let texture =
            transcode_basis_texture_for_features(wgpu::Features::empty(), &encoded).expect("UASTC");
        assert_eq!((texture.width, texture.height), (32, 32));
        assert_eq!(texture.mip_level_count, 6);
        assert_eq!(texture.format, wgpu::TextureFormat::Rgba8Unorm);
        assert_eq!(texture.data.len(), 5_460);

        let bc_texture =
            transcode_basis_texture_for_features(wgpu::Features::TEXTURE_COMPRESSION_BC, &encoded)
                .expect("BC UASTC");
        assert_eq!(bc_texture.format, wgpu::TextureFormat::Bc7RgbaUnorm);
        assert_eq!(bc_texture.data.len(), 1_392);
    }
}
