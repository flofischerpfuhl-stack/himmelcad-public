//! Deterministic, offline image-quality measurements for imported PhotoLab cameras.

use std::{
    f64::consts::PI,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use himmelcad_core::{
    entity::EntityId,
    hash::ObjectHash,
    photolab_jobs::{
        CancellationToken, JobProgress, PhotolabStage, PhotolabStageKind, ProgressMetrics,
    },
};
use image::{imageops::FilterType, ImageReader, RgbImage};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{image_commit::ProjectCameraImageRecord, job_runtime::JobWorkerContext};

pub const IMAGE_QUALITY_ALGORITHM_VERSION: &str = "himmelcad-image-quality-v1";

/// Frozen sampling and warning policy. Metrics remain available independently of warnings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityConfiguration {
    pub maximum_sample_edge: u32,
    pub shadow_clip_value: u8,
    pub highlight_clip_value: u8,
    pub edge_gradient_threshold: f64,
    pub clipping_warning_fraction: f64,
    pub low_sharpness_laplacian_variance: f64,
    pub low_texture_entropy_bits: f64,
    pub directional_blur_coherence: f64,
}

impl Default for ImageQualityConfiguration {
    fn default() -> Self {
        Self {
            maximum_sample_edge: 1_600,
            shadow_clip_value: 2,
            highlight_clip_value: 253,
            edge_gradient_threshold: 0.04,
            clipping_warning_fraction: 0.02,
            low_sharpness_laplacian_variance: 0.000_4,
            low_texture_entropy_bits: 4.0,
            directional_blur_coherence: 0.75,
        }
    }
}

impl ImageQualityConfiguration {
    pub fn validate(&self) -> Result<(), ImageQualityRuntimeError> {
        if !(256..=4_096).contains(&self.maximum_sample_edge) {
            return Err(ImageQualityRuntimeError::InvalidConfiguration(
                "maximum sample edge must be between 256 and 4096 pixels".into(),
            ));
        }
        if self.shadow_clip_value >= self.highlight_clip_value {
            return Err(ImageQualityRuntimeError::InvalidConfiguration(
                "shadow clip value must be lower than highlight clip value".into(),
            ));
        }
        for (label, value) in [
            ("edge gradient threshold", self.edge_gradient_threshold),
            ("clipping warning fraction", self.clipping_warning_fraction),
            (
                "low sharpness threshold",
                self.low_sharpness_laplacian_variance,
            ),
            ("low texture threshold", self.low_texture_entropy_bits),
            (
                "directional blur coherence",
                self.directional_blur_coherence,
            ),
        ] {
            if !value.is_finite() || value < 0.0 {
                return Err(ImageQualityRuntimeError::InvalidConfiguration(format!(
                    "{label} must be finite and non-negative"
                )));
            }
        }
        if self.clipping_warning_fraction > 1.0 || self.directional_blur_coherence > 1.0 {
            return Err(ImageQualityRuntimeError::InvalidConfiguration(
                "fraction and coherence thresholds cannot exceed one".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_set_membership_sha256: Option<ObjectHash>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageQualityWarning {
    ShadowClipping,
    HighlightClipping,
    LowSharpness,
    LowTexture,
    DirectionalBlurRisk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityMetrics {
    /// Variance of the normalized five-point luminance Laplacian.
    pub laplacian_variance: f64,
    /// Mean squared normalized Sobel gradient (Tenengrad energy).
    pub tenengrad: f64,
    /// Structure-tensor coherence in [0,1]; high values plus low sharpness indicate blur risk.
    pub directional_gradient_coherence: f64,
    pub dominant_gradient_angle_degrees: f64,
    pub mean_luminance: f64,
    pub shadow_clipped_fraction: f64,
    pub highlight_clipped_fraction: f64,
    pub texture_entropy_bits: f64,
    pub textured_pixel_fraction: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ImageQualityOutcome {
    Measured {
        metrics: ImageQualityMetrics,
        warnings: Vec<ImageQualityWarning>,
    },
    Unavailable {
        reason: String,
    },
}

/// Persisted per-image result with enough lineage to reject stale publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityAnalysisRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub image_entity_id: EntityId,
    pub image_name: String,
    pub source_object_hash: ObjectHash,
    pub source_metadata_object_hash: ObjectHash,
    pub algorithm_version: String,
    pub configuration_sha256: ObjectHash,
    pub analyzed_at_unix_ms: u64,
    pub original_width_pixels: u32,
    pub original_height_pixels: u32,
    pub sample_width_pixels: u32,
    pub sample_height_pixels: u32,
    pub sampled_pixel_count: u64,
    #[serde(flatten)]
    pub scope: ImageQualityScope,
    pub outcome: ImageQualityOutcome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityCatalog {
    pub schema_version: u32,
    pub project_id: String,
    pub analyses: Vec<ImageQualityAnalysisRecord>,
}

#[derive(Debug, Error)]
pub enum ImageQualityRuntimeError {
    #[error("image-quality analysis was cancelled")]
    Cancelled,
    #[error("invalid image-quality configuration: {0}")]
    InvalidConfiguration(String),
    #[error("image-quality progress could not be published: {0}")]
    Progress(String),
}

pub fn analyze_project_images(
    project_root: &Path,
    job_id: &str,
    cameras: &[ProjectCameraImageRecord],
    scope: &ImageQualityScope,
    configuration: &ImageQualityConfiguration,
    context: &JobWorkerContext,
) -> Result<Vec<ImageQualityAnalysisRecord>, ImageQualityRuntimeError> {
    configuration.validate()?;
    let configuration_sha256 = ObjectHash::of_bytes(
        &serde_json::to_vec(configuration)
            .map_err(|error| ImageQualityRuntimeError::InvalidConfiguration(error.to_string()))?,
    );
    let total_units = u64::try_from(cameras.len()).unwrap_or(u64::MAX);
    let total_bytes = cameras.iter().fold(0_u64, |sum, camera| {
        sum.saturating_add(camera.metadata.inspected_photo.byte_size)
    });
    report_progress(context, 0, total_units, 0, total_bytes)?;
    let mut results = Vec::with_capacity(cameras.len());
    let mut completed_bytes = 0_u64;
    for (index, camera) in cameras.iter().enumerate() {
        check_cancelled(context)?;
        let source = source_object_path(project_root, &camera.metadata.source_object_hash);
        let result = analyze_one_image(
            &source,
            job_id,
            camera,
            scope,
            configuration,
            &configuration_sha256,
            context,
        )?;
        completed_bytes = completed_bytes.saturating_add(camera.metadata.inspected_photo.byte_size);
        results.push(result);
        report_progress(
            context,
            u64::try_from(index + 1).unwrap_or(u64::MAX),
            total_units,
            completed_bytes,
            total_bytes,
        )?;
    }
    check_cancelled(context)?;
    Ok(results)
}

fn analyze_one_image(
    path: &Path,
    job_id: &str,
    camera: &ProjectCameraImageRecord,
    scope: &ImageQualityScope,
    configuration: &ImageQualityConfiguration,
    configuration_sha256: &ObjectHash,
    context: &JobWorkerContext,
) -> Result<ImageQualityAnalysisRecord, ImageQualityRuntimeError> {
    let analyzed_at_unix_ms = unix_time_ms();
    let source = analyze_source(path, configuration, &context.cancellation)?;
    Ok(ImageQualityAnalysisRecord {
        schema_version: 1,
        job_id: job_id.to_owned(),
        image_entity_id: camera.entity_id.clone(),
        image_name: camera.name.clone(),
        source_object_hash: camera.metadata.source_object_hash.clone(),
        source_metadata_object_hash: camera.metadata_object_hash.clone(),
        algorithm_version: IMAGE_QUALITY_ALGORITHM_VERSION.into(),
        configuration_sha256: configuration_sha256.clone(),
        analyzed_at_unix_ms,
        original_width_pixels: source.original_width_pixels,
        original_height_pixels: source.original_height_pixels,
        sample_width_pixels: source.sample_width_pixels,
        sample_height_pixels: source.sample_height_pixels,
        sampled_pixel_count: source.sampled_pixel_count,
        scope: scope.clone(),
        outcome: source.outcome,
    })
}

struct SourceAnalysis {
    original_width_pixels: u32,
    original_height_pixels: u32,
    sample_width_pixels: u32,
    sample_height_pixels: u32,
    sampled_pixel_count: u64,
    outcome: ImageQualityOutcome,
}

fn analyze_source(
    path: &Path,
    configuration: &ImageQualityConfiguration,
    cancellation: &CancellationToken,
) -> Result<SourceAnalysis, ImageQualityRuntimeError> {
    check_token(cancellation)?;
    let decoded = ImageReader::open(path)
        .map_err(|error| error.to_string())
        .and_then(|reader| {
            reader
                .with_guessed_format()
                .map_err(|error| error.to_string())
        })
        .and_then(|reader| reader.decode().map_err(|error| error.to_string()));
    check_token(cancellation)?;
    let (original_width_pixels, original_height_pixels, sample, failure) = match decoded {
        Ok(image) => {
            let original_width = image.width();
            let original_height = image.height();
            let rgb = image.to_rgb8();
            check_token(cancellation)?;
            let maximum = original_width.max(original_height);
            let sample = if maximum > configuration.maximum_sample_edge {
                let scale = f64::from(configuration.maximum_sample_edge) / f64::from(maximum);
                let width = (f64::from(original_width) * scale).round().max(1.0) as u32;
                let height = (f64::from(original_height) * scale).round().max(1.0) as u32;
                image::imageops::resize(&rgb, width, height, FilterType::Triangle)
            } else {
                rgb
            };
            check_token(cancellation)?;
            (original_width, original_height, Some(sample), None)
        }
        Err(error) => (
            0,
            0,
            None,
            Some(format!("Image pixels could not be decoded: {error}")),
        ),
    };
    let (sample_width_pixels, sample_height_pixels, sampled_pixel_count, outcome) =
        if let Some(sample) = sample {
            let width = sample.width();
            let height = sample.height();
            let count = u64::from(width) * u64::from(height);
            if width < 3 || height < 3 {
                (
                    width,
                    height,
                    count,
                    ImageQualityOutcome::Unavailable {
                        reason: "Image is too small for spatial quality measurements".into(),
                    },
                )
            } else {
                let (metrics, warnings) = measure_sample(&sample, configuration, cancellation)?;
                (
                    width,
                    height,
                    count,
                    ImageQualityOutcome::Measured { metrics, warnings },
                )
            }
        } else {
            (
                0,
                0,
                0,
                ImageQualityOutcome::Unavailable {
                    reason: failure.unwrap_or_else(|| "Image pixels are unavailable".into()),
                },
            )
        };
    Ok(SourceAnalysis {
        original_width_pixels,
        original_height_pixels,
        sample_width_pixels,
        sample_height_pixels,
        sampled_pixel_count,
        outcome,
    })
}

fn measure_sample(
    image: &RgbImage,
    configuration: &ImageQualityConfiguration,
    cancellation: &CancellationToken,
) -> Result<(ImageQualityMetrics, Vec<ImageQualityWarning>), ImageQualityRuntimeError> {
    let width = image.width() as usize;
    let height = image.height() as usize;
    let count = width.saturating_mul(height);
    let mut luminance = vec![0.0_f64; count];
    let mut histogram = [0_u64; 256];
    let mut luminance_sum = 0.0;
    let mut shadow_clipped = 0_u64;
    let mut highlight_clipped = 0_u64;
    for y in 0..height {
        if y % 32 == 0 {
            check_token(cancellation)?;
        }
        for x in 0..width {
            let pixel = image.get_pixel(x as u32, y as u32).0;
            let value = (0.212_6 * f64::from(pixel[0])
                + 0.715_2 * f64::from(pixel[1])
                + 0.072_2 * f64::from(pixel[2]))
                / 255.0;
            luminance[y * width + x] = value;
            luminance_sum += value;
            let bin = (value * 255.0).round().clamp(0.0, 255.0) as usize;
            histogram[bin] = histogram[bin].saturating_add(1);
            if pixel
                .iter()
                .all(|channel| *channel <= configuration.shadow_clip_value)
            {
                shadow_clipped = shadow_clipped.saturating_add(1);
            }
            if pixel
                .iter()
                .any(|channel| *channel >= configuration.highlight_clip_value)
            {
                highlight_clipped = highlight_clipped.saturating_add(1);
            }
        }
    }

    let spatial_count = (width - 2).saturating_mul(height - 2) as f64;
    let mut laplacian_sum = 0.0;
    let mut laplacian_squared_sum = 0.0;
    let mut gradient_energy_sum = 0.0;
    let mut tensor_xx = 0.0;
    let mut tensor_xy = 0.0;
    let mut tensor_yy = 0.0;
    let mut textured_pixels = 0_u64;
    for y in 1..height - 1 {
        if y % 32 == 0 {
            check_token(cancellation)?;
        }
        for x in 1..width - 1 {
            let at = |dx: isize, dy: isize| -> f64 {
                luminance[((y as isize + dy) as usize) * width + (x as isize + dx) as usize]
            };
            let center = at(0, 0);
            let laplacian = (4.0 * center - at(-1, 0) - at(1, 0) - at(0, -1) - at(0, 1)) / 4.0;
            laplacian_sum += laplacian;
            laplacian_squared_sum += laplacian * laplacian;
            let gradient_x =
                (-at(-1, -1) + at(1, -1) - 2.0 * at(-1, 0) + 2.0 * at(1, 0) - at(-1, 1) + at(1, 1))
                    / 4.0;
            let gradient_y =
                (-at(-1, -1) - 2.0 * at(0, -1) - at(1, -1) + at(-1, 1) + 2.0 * at(0, 1) + at(1, 1))
                    / 4.0;
            let energy = gradient_x * gradient_x + gradient_y * gradient_y;
            gradient_energy_sum += energy;
            tensor_xx += gradient_x * gradient_x;
            tensor_xy += gradient_x * gradient_y;
            tensor_yy += gradient_y * gradient_y;
            if energy.sqrt() >= configuration.edge_gradient_threshold {
                textured_pixels = textured_pixels.saturating_add(1);
            }
        }
    }
    let laplacian_mean = laplacian_sum / spatial_count;
    let laplacian_variance =
        (laplacian_squared_sum / spatial_count - laplacian_mean * laplacian_mean).max(0.0);
    let tensor_trace = tensor_xx + tensor_yy;
    let directional_gradient_coherence = if tensor_trace <= f64::EPSILON {
        0.0
    } else {
        (((tensor_xx - tensor_yy).powi(2) + 4.0 * tensor_xy.powi(2)).sqrt() / tensor_trace)
            .clamp(0.0, 1.0)
    };
    let dominant_gradient_angle_degrees =
        (0.5 * (2.0 * tensor_xy).atan2(tensor_xx - tensor_yy) * 180.0 / PI).rem_euclid(180.0);
    let pixel_count = count as f64;
    let texture_entropy_bits = histogram.iter().fold(0.0, |entropy, frequency| {
        if *frequency == 0 {
            entropy
        } else {
            let probability = *frequency as f64 / pixel_count;
            entropy - probability * probability.log2()
        }
    });
    let metrics = ImageQualityMetrics {
        laplacian_variance,
        tenengrad: gradient_energy_sum / spatial_count,
        directional_gradient_coherence,
        dominant_gradient_angle_degrees,
        mean_luminance: luminance_sum / pixel_count,
        shadow_clipped_fraction: shadow_clipped as f64 / pixel_count,
        highlight_clipped_fraction: highlight_clipped as f64 / pixel_count,
        texture_entropy_bits,
        textured_pixel_fraction: textured_pixels as f64 / spatial_count,
    };
    let mut warnings = Vec::new();
    if metrics.shadow_clipped_fraction >= configuration.clipping_warning_fraction {
        warnings.push(ImageQualityWarning::ShadowClipping);
    }
    if metrics.highlight_clipped_fraction >= configuration.clipping_warning_fraction {
        warnings.push(ImageQualityWarning::HighlightClipping);
    }
    if metrics.laplacian_variance < configuration.low_sharpness_laplacian_variance {
        warnings.push(ImageQualityWarning::LowSharpness);
    }
    if metrics.texture_entropy_bits < configuration.low_texture_entropy_bits {
        warnings.push(ImageQualityWarning::LowTexture);
    }
    if metrics.directional_gradient_coherence >= configuration.directional_blur_coherence
        && metrics.laplacian_variance < configuration.low_sharpness_laplacian_variance * 4.0
    {
        warnings.push(ImageQualityWarning::DirectionalBlurRisk);
    }
    Ok((metrics, warnings))
}

fn report_progress(
    context: &JobWorkerContext,
    completed_units: u64,
    total_units: u64,
    completed_bytes: u64,
    total_bytes: u64,
) -> Result<(), ImageQualityRuntimeError> {
    context
        .progress
        .report_blocking(JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::ImageAnalysis,
                index: 0,
                stage_count: 1,
                label: "Analyze image quality".into(),
            },
            metrics: ProgressMetrics {
                completed_units,
                total_units: Some(total_units),
                completed_bytes,
                total_bytes: Some(total_bytes),
            },
        })
        .map(|_| ())
        .map_err(|error| ImageQualityRuntimeError::Progress(error.to_string()))
}

fn check_cancelled(context: &JobWorkerContext) -> Result<(), ImageQualityRuntimeError> {
    check_token(&context.cancellation)
}

fn check_token(cancellation: &CancellationToken) -> Result<(), ImageQualityRuntimeError> {
    cancellation
        .check()
        .map_err(|_| ImageQualityRuntimeError::Cancelled)
}

fn source_object_path(root: &Path, hash: &ObjectHash) -> PathBuf {
    let (prefix, remainder) = hash.as_str().split_at(2);
    root.join("objects").join(prefix).join(remainder)
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measured_metrics_respond_to_texture_and_clipping() {
        let cancellation = CancellationToken::new();
        let config = ImageQualityConfiguration::default();
        let flat = RgbImage::from_pixel(64, 64, image::Rgb([0, 0, 0]));
        let (flat_metrics, flat_warnings) = measure_sample(&flat, &config, &cancellation).unwrap();
        assert_eq!(flat_metrics.laplacian_variance, 0.0);
        assert_eq!(flat_metrics.texture_entropy_bits, 0.0);
        assert_eq!(flat_metrics.shadow_clipped_fraction, 1.0);
        assert!(flat_warnings.contains(&ImageQualityWarning::ShadowClipping));
        assert!(flat_warnings.contains(&ImageQualityWarning::LowSharpness));

        let checker = RgbImage::from_fn(64, 64, |x, y| {
            if (x / 4 + y / 4) % 2 == 0 {
                image::Rgb([32, 80, 160])
            } else {
                image::Rgb([220, 170, 40])
            }
        });
        let (checker_metrics, _) = measure_sample(&checker, &config, &cancellation).unwrap();
        assert!(checker_metrics.laplacian_variance > flat_metrics.laplacian_variance);
        assert!(checker_metrics.tenengrad > flat_metrics.tenengrad);
        assert!(checker_metrics.texture_entropy_bits > flat_metrics.texture_entropy_bits);
        assert!(checker_metrics.textured_pixel_fraction > 0.0);
    }

    #[test]
    fn cancellation_is_checked_inside_pixel_loops() {
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let image = RgbImage::from_pixel(128, 128, image::Rgb([120, 120, 120]));
        assert!(matches!(
            measure_sample(&image, &ImageQualityConfiguration::default(), &cancellation),
            Err(ImageQualityRuntimeError::Cancelled)
        ));
    }

    #[test]
    fn source_objects_use_the_project_content_store_layout() {
        let hash = ObjectHash::of_bytes(b"survey image pixels");
        let value = hash.as_str();
        assert_eq!(
            source_object_path(Path::new("/project"), &hash),
            Path::new("/project/objects")
                .join(&value[..2])
                .join(&value[2..])
        );
    }

    #[test]
    fn extensionless_content_store_jpeg_is_decoded_and_measured() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "himmelcad-image-quality-codec-{}-{unique}",
            std::process::id()
        ));
        let image = RgbImage::from_fn(96, 64, |x, y| {
            if (x / 8 + y / 8) % 2 == 0 {
                image::Rgb([20, 80, 180])
            } else {
                image::Rgb([230, 180, 30])
            }
        });
        let hash = ObjectHash::of_bytes(image.as_raw());
        let path = source_object_path(&root, &hash);
        std::fs::create_dir_all(path.parent().expect("object parent")).expect("object directory");
        let file = std::fs::File::create(&path).expect("object file");
        image::codecs::jpeg::JpegEncoder::new_with_quality(file, 92)
            .encode_image(&image)
            .expect("JPEG encode");

        let analysis = analyze_source(
            &path,
            &ImageQualityConfiguration::default(),
            &CancellationToken::new(),
        )
        .expect("analysis");
        assert_eq!(analysis.original_width_pixels, 96);
        assert_eq!(analysis.original_height_pixels, 64);
        assert_eq!(analysis.sampled_pixel_count, 96 * 64);
        assert!(matches!(
            analysis.outcome,
            ImageQualityOutcome::Measured { .. }
        ));
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
