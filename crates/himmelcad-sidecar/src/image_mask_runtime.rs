//! Durable image-mask rasterization and compute materialization.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use himmelcad_core::{
    hash::ObjectHash,
    photolab_jobs::CancellationToken,
    photolab_masks::{
        ComputeImageMask, ImageMaskBrushMode, ImageMaskBrushPoint, ImageMaskBrushStroke,
        ImageMaskRaster, ImageMaskRasterError,
    },
};
use image::{GrayImage, ImageFormat, Luma};
use thiserror::Error;

/// Applies a vector brush edit to the original-resolution packed raster.
pub fn apply_brush_stroke(
    raster: &mut ImageMaskRaster,
    stroke: &ImageMaskBrushStroke,
    cancellation: &CancellationToken,
) -> Result<(), ImageMaskRuntimeError> {
    validate_stroke(stroke)?;
    if stroke.points.len() == 1 {
        paint_segment(
            raster,
            stroke.points[0],
            stroke.points[0],
            stroke.radius_pixels,
            stroke.mode == ImageMaskBrushMode::Add,
            cancellation,
        )?;
    } else {
        for (index, pair) in stroke.points.windows(2).enumerate() {
            if index % 16 == 0 {
                cancellation
                    .check()
                    .map_err(|_| ImageMaskRuntimeError::Cancelled)?;
            }
            paint_segment(
                raster,
                pair[0],
                pair[1],
                stroke.radius_pixels,
                stroke.mode == ImageMaskBrushMode::Add,
                cancellation,
            )?;
        }
    }
    cancellation
        .check()
        .map_err(|_| ImageMaskRuntimeError::Cancelled)
}

/// Reads one verified packed raster object.
pub fn read_compute_mask_raster(
    project_root: &Path,
    mask: &ComputeImageMask,
) -> Result<ImageMaskRaster, ImageMaskRuntimeError> {
    validate_hash(&mask.raster_object_hash)?;
    let (prefix, remainder) = mask.raster_object_hash.as_str().split_at(2);
    let path = project_root.join("objects").join(prefix).join(remainder);
    let bytes = fs::read(&path)?;
    let observed = ObjectHash::of_bytes(&bytes);
    if observed != mask.raster_object_hash {
        return Err(ImageMaskRuntimeError::HashMismatch {
            expected: mask.raster_object_hash.clone(),
            observed,
        });
    }
    let raster = ImageMaskRaster::decode(&bytes).map_err(ImageMaskRuntimeError::Raster)?;
    if raster.width() != mask.width_pixels
        || raster.height() != mask.height_pixels
        || raster.masked_pixel_count() != mask.masked_pixel_count
        || mask.masked_pixel_count == 0
    {
        return Err(ImageMaskRuntimeError::InvalidMask(
            "compute mask dimensions or pixel count differ from its revision".into(),
        ));
    }
    Ok(raster)
}

/// Writes COLMAP-compatible keep masks. Black pixels are excluded; white pixels are valid.
pub fn materialize_colmap_masks(
    project_root: &Path,
    masks: &[ComputeImageMask],
    image_paths: &BTreeMap<&str, &Path>,
    mask_root: &Path,
    cancellation: &CancellationToken,
) -> Result<(), ImageMaskRuntimeError> {
    if masks.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(mask_root)?;
    for mask in masks {
        cancellation
            .check()
            .map_err(|_| ImageMaskRuntimeError::Cancelled)?;
        let relative = image_paths
            .get(mask.image_entity_id.0.as_str())
            .ok_or_else(|| {
                ImageMaskRuntimeError::InvalidMask(format!(
                    "mask references camera outside the materialized scope: {}",
                    mask.image_entity_id.0
                ))
            })?;
        let raster = read_compute_mask_raster(project_root, mask)?;
        let output = mask_root.join(relative).with_extension(format!(
            "{}.png",
            relative
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("image")
        ));
        write_keep_mask_png(&output, &raster, cancellation)?;
    }
    Ok(())
}

/// Writes one grayscale keep-mask PNG without changing its pixel grid.
pub fn write_keep_mask_png(
    path: &Path,
    raster: &ImageMaskRaster,
    cancellation: &CancellationToken,
) -> Result<(), ImageMaskRuntimeError> {
    let mut image = GrayImage::new(raster.width(), raster.height());
    for y in 0..raster.height() {
        if y % 64 == 0 {
            cancellation
                .check()
                .map_err(|_| ImageMaskRuntimeError::Cancelled)?;
        }
        for x in 0..raster.width() {
            image.put_pixel(x, y, Luma([if raster.is_masked(x, y) { 0 } else { 255 }]));
        }
    }
    let parent = path.parent().ok_or_else(|| {
        ImageMaskRuntimeError::InvalidMask("mask output path has no parent".into())
    })?;
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);
    image.save_with_format(&temporary, ImageFormat::Png)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn validate_stroke(stroke: &ImageMaskBrushStroke) -> Result<(), ImageMaskRuntimeError> {
    if !stroke.radius_pixels.is_finite()
        || !(0.5..=4_096.0).contains(&stroke.radius_pixels)
        || stroke.points.is_empty()
        || stroke.points.len() > 10_000
        || stroke.points.iter().any(|point| {
            !point.x_pixels.is_finite()
                || !point.y_pixels.is_finite()
                || point.x_pixels.abs() > 1_000_000.0
                || point.y_pixels.abs() > 1_000_000.0
        })
    {
        return Err(ImageMaskRuntimeError::InvalidMask(
            "brush needs 1..=10000 finite points and radius 0.5..=4096 pixels".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn paint_segment(
    raster: &mut ImageMaskRaster,
    start: ImageMaskBrushPoint,
    end: ImageMaskBrushPoint,
    radius: f64,
    value: bool,
    cancellation: &CancellationToken,
) -> Result<(), ImageMaskRuntimeError> {
    let minimum_x = ((start.x_pixels.min(end.x_pixels) - radius).floor() as i64)
        .clamp(0, i64::from(raster.width().saturating_sub(1))) as u32;
    let maximum_x = ((start.x_pixels.max(end.x_pixels) + radius).ceil() as i64)
        .clamp(0, i64::from(raster.width().saturating_sub(1))) as u32;
    let minimum_y = ((start.y_pixels.min(end.y_pixels) - radius).floor() as i64)
        .clamp(0, i64::from(raster.height().saturating_sub(1))) as u32;
    let maximum_y = ((start.y_pixels.max(end.y_pixels) + radius).ceil() as i64)
        .clamp(0, i64::from(raster.height().saturating_sub(1))) as u32;
    let dx = end.x_pixels - start.x_pixels;
    let dy = end.y_pixels - start.y_pixels;
    let squared_length = dx * dx + dy * dy;
    let squared_radius = radius * radius;
    for y in minimum_y..=maximum_y {
        if (y - minimum_y) % 32 == 0 {
            cancellation
                .check()
                .map_err(|_| ImageMaskRuntimeError::Cancelled)?;
        }
        let py = f64::from(y) + 0.5;
        for x in minimum_x..=maximum_x {
            let px = f64::from(x) + 0.5;
            let projection = if squared_length <= f64::EPSILON {
                0.0
            } else {
                (((px - start.x_pixels) * dx + (py - start.y_pixels) * dy) / squared_length)
                    .clamp(0.0, 1.0)
            };
            let closest_x = start.x_pixels + projection * dx;
            let closest_y = start.y_pixels + projection * dy;
            let distance_x = px - closest_x;
            let distance_y = py - closest_y;
            if distance_x * distance_x + distance_y * distance_y <= squared_radius {
                raster.set_masked(x, y, value);
            }
        }
    }
    Ok(())
}

fn validate_hash(hash: &ObjectHash) -> Result<(), ImageMaskRuntimeError> {
    if hash.as_str().len() == 64
        && hash
            .as_str()
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        Ok(())
    } else {
        Err(ImageMaskRuntimeError::InvalidMask(
            "mask object hash is invalid".into(),
        ))
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(format!(".{}.tmp", std::process::id()));
    PathBuf::from(value)
}

/// Failure while editing or materializing an image mask.
#[derive(Debug, Error)]
pub enum ImageMaskRuntimeError {
    #[error("image-mask operation was cancelled")]
    Cancelled,
    #[error("invalid image mask: {0}")]
    InvalidMask(String),
    #[error("image-mask raster is invalid: {0:?}")]
    Raster(ImageMaskRasterError),
    #[error("image-mask object hash differs: expected {expected:?}, observed {observed:?}")]
    HashMismatch {
        expected: ObjectHash,
        observed: ObjectHash,
    },
    #[error("image-mask I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("image-mask PNG encoding failed: {0}")]
    Image(#[from] image::ImageError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::entity::EntityId;

    #[test]
    fn add_remove_and_clear_semantics_are_pixel_stable() {
        let cancellation = CancellationToken::new();
        let mut raster = ImageMaskRaster::empty(32, 24).expect("raster");
        apply_brush_stroke(
            &mut raster,
            &ImageMaskBrushStroke {
                mode: ImageMaskBrushMode::Add,
                radius_pixels: 3.0,
                points: vec![
                    ImageMaskBrushPoint {
                        x_pixels: 5.0,
                        y_pixels: 5.0,
                    },
                    ImageMaskBrushPoint {
                        x_pixels: 20.0,
                        y_pixels: 5.0,
                    },
                ],
            },
            &cancellation,
        )
        .expect("add stroke");
        assert!(raster.is_masked(10, 5));
        assert!(raster.masked_pixel_count() > 50);

        apply_brush_stroke(
            &mut raster,
            &ImageMaskBrushStroke {
                mode: ImageMaskBrushMode::Remove,
                radius_pixels: 2.0,
                points: vec![ImageMaskBrushPoint {
                    x_pixels: 10.5,
                    y_pixels: 5.5,
                }],
            },
            &cancellation,
        )
        .expect("remove stroke");
        assert!(!raster.is_masked(10, 5));
        raster.clear();
        assert_eq!(raster.masked_pixel_count(), 0);
    }

    #[test]
    fn cancellation_does_not_report_a_completed_edit() {
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let mut raster = ImageMaskRaster::empty(32, 24).expect("raster");
        let error = apply_brush_stroke(
            &mut raster,
            &ImageMaskBrushStroke {
                mode: ImageMaskBrushMode::Add,
                radius_pixels: 2.0,
                points: vec![ImageMaskBrushPoint {
                    x_pixels: 5.0,
                    y_pixels: 5.0,
                }],
            },
            &cancellation,
        )
        .expect_err("cancelled");
        assert!(matches!(error, ImageMaskRuntimeError::Cancelled));
    }

    #[test]
    fn colmap_materialization_is_black_for_excluded_original_pixels() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-image-mask-materialize-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let project = root.join("project");
        let output = root.join("output");
        let mut raster = ImageMaskRaster::empty(7, 5).expect("raster");
        raster.set_masked(2, 3, true);
        let bytes = raster.encode();
        let hash = ObjectHash::of_bytes(&bytes);
        let (prefix, remainder) = hash.as_str().split_at(2);
        let object = project.join("objects").join(prefix).join(remainder);
        fs::create_dir_all(object.parent().expect("object parent")).expect("objects");
        fs::write(&object, bytes).expect("raster object");
        let mask = ComputeImageMask {
            image_entity_id: EntityId("camera-a".into()),
            revision_sha256: ObjectHash::of_bytes(b"revision"),
            raster_object_hash: hash,
            width_pixels: 7,
            height_pixels: 5,
            masked_pixel_count: 1,
        };
        let relative = Path::new("nested/camera.jpg");
        let paths = BTreeMap::from([("camera-a", relative)]);
        materialize_colmap_masks(
            &project,
            &[mask],
            &paths,
            &output,
            &CancellationToken::new(),
        )
        .expect("materialize mask");
        let keep = image::open(output.join("nested/camera.jpg.png"))
            .expect("keep mask")
            .to_luma8();
        assert_eq!(keep.dimensions(), (7, 5));
        assert_eq!(keep.get_pixel(2, 3).0[0], 0);
        assert_eq!(keep.get_pixel(1, 3).0[0], 255);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
