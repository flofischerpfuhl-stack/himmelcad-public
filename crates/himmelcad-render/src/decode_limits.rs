//! Format-independent hard ceilings for attacker-controlled decode work.

use std::io::Cursor;

/// Maximum encoded bytes accepted by one independently streamed content leaf.
pub(crate) const MAX_ENCODED_CONTENT_BYTES: usize = 512 * 1024 * 1024;
/// Maximum materialized bytes retained by one decode stage.
pub(crate) const MAX_DECODED_CONTENT_BYTES: usize = 512 * 1024 * 1024;
/// Maximum decoded pixels retained for one image.
pub(crate) const MAX_IMAGE_RGBA8_BYTES: usize = 256 * 1024 * 1024;
/// Maximum width or height accepted by the shared image decoder.
pub(crate) const MAX_IMAGE_DIMENSION: u32 = 32_768;
/// Maximum instantiated vertices in one glTF leaf.
pub(crate) const MAX_GLTF_VERTICES: usize = 4_000_000;
/// Maximum instantiated triangle-list indices in one glTF leaf.
pub(crate) const MAX_GLTF_INDICES: usize = 12_000_000;
/// Maximum instantiated primitives in one glTF leaf.
pub(crate) const MAX_GLTF_PRIMITIVES: usize = 65_536;
/// Maximum scene graph nesting accepted by recursive glTF traversal.
pub(crate) const MAX_GLTF_SCENE_DEPTH: usize = 256;
/// Maximum points decoded from one independently streamed point leaf.
pub(crate) const MAX_POINT_COUNT: usize = 16_000_000;
/// Maximum transforms decoded from one independently streamed instance leaf.
pub(crate) const MAX_INSTANCE_COUNT: usize = 1_000_000;
/// Maximum immediate children declared by one composite tile.
pub(crate) const MAX_COMPOSITE_CHILDREN: usize = 4_096;
/// Maximum scalar properties decoded per Gaussian PLY vertex.
pub(crate) const MAX_GAUSSIAN_PROPERTIES: usize = 128;
/// Maximum JSON values expanded for one structural-metadata array sample.
pub(crate) const MAX_METADATA_ARRAY_ELEMENTS: usize = 1_000_000;

/// Decodes PNG/JPEG bytes with strict dimension ceilings and an allocation budget.
pub(crate) fn decode_bounded_image(bytes: &[u8]) -> Result<image::DynamicImage, image::ImageError> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_RGBA8_BYTES as u64);
    reader.limits(limits);
    let image = reader.decode()?;
    checked_image_rgba8_bytes(image.width(), image.height())
        .map_err(|kind| image::ImageError::Limits(image::error::LimitError::from_kind(kind)))?;
    Ok(image)
}

fn checked_image_rgba8_bytes(
    width: u32,
    height: u32,
) -> Result<usize, image::error::LimitErrorKind> {
    let length = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok())
        .ok_or(image::error::LimitErrorKind::InsufficientMemory)?;
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || length > MAX_IMAGE_RGBA8_BYTES
    {
        return Err(image::error::LimitErrorKind::InsufficientMemory);
    }
    Ok(length)
}

#[cfg(test)]
mod tests {
    use super::{checked_image_rgba8_bytes, MAX_IMAGE_DIMENSION};

    #[test]
    fn rejects_image_dimensions_before_output_allocation() {
        assert!(checked_image_rgba8_bytes(MAX_IMAGE_DIMENSION, 1).is_ok());
        assert!(checked_image_rgba8_bytes(MAX_IMAGE_DIMENSION + 1, 1).is_err());
        assert!(checked_image_rgba8_bytes(16_384, 16_384).is_err());
    }
}
