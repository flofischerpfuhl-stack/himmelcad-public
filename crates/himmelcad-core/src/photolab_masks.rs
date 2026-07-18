//! Immutable per-image exclusion masks and their compute-lineage contract.

use serde::{Deserialize, Serialize};

use crate::{entity::EntityId, hash::ObjectHash};

/// Binary raster object framing. Set bits are excluded from image processing.
pub const IMAGE_MASK_RASTER_MAGIC: &[u8; 8] = b"HCMASK01";
const MAX_IMAGE_MASK_PIXELS: u64 = 1_000_000_000;

/// One pixel-space brush sample. Coordinates refer to original image pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMaskBrushPoint {
    pub x_pixels: f64,
    pub y_pixels: f64,
}

/// Whether a brush stroke adds or removes excluded pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageMaskBrushMode {
    Add,
    Remove,
}

/// Immutable vector edit retained beside the resulting raster revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMaskBrushStroke {
    pub mode: ImageMaskBrushMode,
    pub radius_pixels: f64,
    pub points: Vec<ImageMaskBrushPoint>,
}

/// A canonical image-mask mutation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImageMaskEdit {
    Brush { stroke: ImageMaskBrushStroke },
    Clear,
    Restore { revision_sha256: ObjectHash },
}

/// Current revision for one imported image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMaskRevisionRecord {
    pub schema_version: u32,
    pub image_entity_id: EntityId,
    pub source_object_hash: ObjectHash,
    pub source_metadata_object_hash: ObjectHash,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_revision_sha256: Option<ObjectHash>,
    pub edit: ImageMaskEdit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raster_object_hash: Option<ObjectHash>,
    pub masked_pixel_count: u64,
}

/// Content-addressed catalog selecting one immutable revision per image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMaskCatalog {
    pub schema_version: u32,
    pub project_id: String,
    pub revisions: Vec<ImageMaskCatalogEntry>,
}

/// One current catalog entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMaskCatalogEntry {
    pub image_entity_id: EntityId,
    pub revision_sha256: ObjectHash,
}

/// Non-empty immutable mask passed to an alignment or MVS worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeImageMask {
    pub image_entity_id: EntityId,
    pub revision_sha256: ObjectHash,
    pub raster_object_hash: ObjectHash,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub masked_pixel_count: u64,
}

/// Exact mask selection frozen for one camera/processing-set scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMaskComputeScope {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_membership_sha256: Option<ObjectHash>,
    pub camera_entity_ids: Vec<EntityId>,
    pub masks: Vec<ComputeImageMask>,
    pub scope_sha256: ObjectHash,
}

/// Packed row-major raster. Set bits are excluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageMaskRaster {
    width: u32,
    height: u32,
    bits: Vec<u8>,
}

impl ImageMaskRaster {
    /// Creates an empty mask with bounded dimensions.
    pub fn empty(width: u32, height: u32) -> Result<Self, ImageMaskRasterError> {
        validate_dimensions(width, height)?;
        let bytes = packed_byte_len(width, height)?;
        Ok(Self {
            width,
            height,
            bits: vec![0; bytes],
        })
    }

    /// Decodes and validates a content-store raster object.
    pub fn decode(bytes: &[u8]) -> Result<Self, ImageMaskRasterError> {
        if bytes.len() < 24 || &bytes[..8] != IMAGE_MASK_RASTER_MAGIC {
            return Err(ImageMaskRasterError::InvalidFraming);
        }
        let width = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed mask header"));
        let height = u32::from_le_bytes(bytes[12..16].try_into().expect("fixed mask header"));
        let masked = u64::from_le_bytes(bytes[16..24].try_into().expect("fixed mask header"));
        validate_dimensions(width, height)?;
        let expected = packed_byte_len(width, height)?;
        if bytes.len() != 24 + expected {
            return Err(ImageMaskRasterError::InvalidFraming);
        }
        let raster = Self {
            width,
            height,
            bits: bytes[24..].to_vec(),
        };
        if raster.masked_pixel_count() != masked || raster.padding_bits_are_set() {
            return Err(ImageMaskRasterError::InvalidFraming);
        }
        Ok(raster)
    }

    /// Encodes the canonical binary representation.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(24 + self.bits.len());
        bytes.extend_from_slice(IMAGE_MASK_RASTER_MAGIC);
        bytes.extend_from_slice(&self.width.to_le_bytes());
        bytes.extend_from_slice(&self.height.to_le_bytes());
        bytes.extend_from_slice(&self.masked_pixel_count().to_le_bytes());
        bytes.extend_from_slice(&self.bits);
        bytes
    }

    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// Returns whether the original-image pixel is excluded.
    #[must_use]
    pub fn is_masked(&self, x: u32, y: u32) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        let pixel = u64::from(y) * u64::from(self.width) + u64::from(x);
        let byte = usize::try_from(pixel / 8).expect("validated raster fits usize");
        self.bits[byte] & (1 << (pixel % 8)) != 0
    }

    /// Sets one original-image pixel and returns whether it changed.
    pub fn set_masked(&mut self, x: u32, y: u32, masked: bool) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        let pixel = u64::from(y) * u64::from(self.width) + u64::from(x);
        let byte = usize::try_from(pixel / 8).expect("validated raster fits usize");
        let flag = 1 << (pixel % 8);
        let previous = self.bits[byte] & flag != 0;
        if masked {
            self.bits[byte] |= flag;
        } else {
            self.bits[byte] &= !flag;
        }
        previous != masked
    }

    /// Clears every excluded pixel.
    pub fn clear(&mut self) {
        self.bits.fill(0);
    }

    #[must_use]
    pub fn masked_pixel_count(&self) -> u64 {
        self.bits
            .iter()
            .map(|value| u64::from(value.count_ones()))
            .sum()
    }

    fn padding_bits_are_set(&self) -> bool {
        let pixels = u64::from(self.width) * u64::from(self.height);
        let remainder = pixels % 8;
        remainder != 0
            && self.bits.last().is_some_and(|last| {
                let allowed = (1_u16 << remainder) as u8 - 1;
                last & !allowed != 0
            })
    }
}

/// Invalid image-mask raster object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageMaskRasterError {
    InvalidDimensions,
    SizeOverflow,
    InvalidFraming,
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), ImageMaskRasterError> {
    if width == 0
        || height == 0
        || width > 200_000
        || height > 200_000
        || u64::from(width) * u64::from(height) > MAX_IMAGE_MASK_PIXELS
    {
        Err(ImageMaskRasterError::InvalidDimensions)
    } else {
        packed_byte_len(width, height).map(|_| ())
    }
}

fn packed_byte_len(width: u32, height: u32) -> Result<usize, ImageMaskRasterError> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(ImageMaskRasterError::SizeOverflow)?;
    usize::try_from(pixels.div_ceil(8)).map_err(|_| ImageMaskRasterError::SizeOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raster_round_trip_is_canonical_and_rejects_padding_bits() {
        let mut raster = ImageMaskRaster::empty(9, 3).expect("empty mask");
        assert!(raster.set_masked(0, 0, true));
        assert!(raster.set_masked(8, 2, true));
        assert!(!raster.set_masked(8, 2, true));
        let encoded = raster.encode();
        assert_eq!(ImageMaskRaster::decode(&encoded).expect("decode"), raster);
        assert_eq!(raster.masked_pixel_count(), 2);

        let mut invalid = encoded;
        *invalid.last_mut().expect("payload") |= 0b1000_0000;
        assert_eq!(
            ImageMaskRaster::decode(&invalid),
            Err(ImageMaskRasterError::InvalidFraming)
        );
    }

    #[test]
    fn mask_contract_serializes_with_stable_camel_case_tags() {
        let edit = ImageMaskEdit::Brush {
            stroke: ImageMaskBrushStroke {
                mode: ImageMaskBrushMode::Remove,
                radius_pixels: 12.5,
                points: vec![ImageMaskBrushPoint {
                    x_pixels: 10.0,
                    y_pixels: 20.0,
                }],
            },
        };
        let value = serde_json::to_value(edit).expect("serialize mask edit");
        assert_eq!(value["kind"], "brush");
        assert_eq!(value["stroke"]["mode"], "remove");
        assert_eq!(value["stroke"]["radiusPixels"], 12.5);
    }
}
