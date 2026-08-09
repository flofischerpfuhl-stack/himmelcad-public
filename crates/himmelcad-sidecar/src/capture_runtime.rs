//! Host capability probing and deterministic capture preparation.

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_capture::{
    select_video_frames, CaptureCapabilityInventory, CaptureClassificationBasis,
    CaptureDecodeOperation, CaptureDecodeSupport, CaptureMedium, DerivedCaptureArtifactProvenance,
    SystemToolCapability, VideoFrameCandidate, VideoFrameSelection, VideoFrameSelectionPolicy,
    VIDEO_FRAME_SELECTION_VERSION,
};
use himmelcad_core::photolab_images::{DiscoveredPhoto, PhotoFormat, PhotoImportBatch};
use himmelcad_io::import_photo_files_with_capabilities_and_progress;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const THUMBNAIL_FPS: u64 = 2;
const VIDEO_PREPARATION_VERSION: &str = "hcad-video-preparation-v1";

/// Optional executable overrides, primarily for signed release bundles and tests.
#[derive(Debug, Clone, Default)]
pub struct CaptureToolConfig {
    pub ffprobe: Option<PathBuf>,
    pub ffmpeg: Option<PathBuf>,
    pub magick: Option<PathBuf>,
}

impl CaptureToolConfig {
    #[must_use]
    pub fn from_environment() -> Self {
        Self {
            ffprobe: std::env::var_os("HCAD_FFPROBE").map(PathBuf::from),
            ffmpeg: std::env::var_os("HCAD_FFMPEG").map(PathBuf::from),
            magick: std::env::var_os("HCAD_MAGICK").map(PathBuf::from),
        }
    }
}

/// Probes actual decoder lists rather than assuming an executable supports a container.
#[must_use]
pub fn probe_capture_capabilities(config: &CaptureToolConfig) -> CaptureCapabilityInventory {
    let ffprobe_name = config
        .ffprobe
        .clone()
        .unwrap_or_else(|| PathBuf::from("ffprobe"));
    let ffmpeg_name = config
        .ffmpeg
        .clone()
        .unwrap_or_else(|| PathBuf::from("ffmpeg"));
    let magick_name = config
        .magick
        .clone()
        .unwrap_or_else(|| PathBuf::from("magick"));
    let ffprobe = probe_tool(&ffprobe_name, &["-version"]);
    let ffmpeg = probe_tool(&ffmpeg_name, &["-version"]);
    let ffmpeg_formats = successful_stdout(&ffmpeg_name, &["-hide_banner", "-decoders"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    let magick = probe_tool(&magick_name, &["-version"]);
    let magick_formats = successful_stdout(&magick_name, &["-list", "format"])
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut inventory = CaptureCapabilityInventory::portable_defaults();
    inventory.ffprobe = ffprobe;
    inventory.ffmpeg = ffmpeg.clone();
    for capability in &mut inventory.decoders {
        if matches!(capability.support, CaptureDecodeSupport::BuiltIn) {
            continue;
        }
        let tokens = format_tokens(capability.format);
        if magick.available && tokens.iter().any(|token| magick_formats.contains(token)) {
            capability.operation = CaptureDecodeOperation::TranscodeToPng;
            capability.support = CaptureDecodeSupport::SystemTool {
                tool: path_text(&magick_name),
                version: magick.version.clone().unwrap_or_else(|| "unknown".into()),
            };
        } else if ffmpeg.available && tokens.iter().any(|token| ffmpeg_formats.contains(token)) {
            capability.operation = CaptureDecodeOperation::TranscodeToPng;
            capability.support = CaptureDecodeSupport::SystemTool {
                tool: path_text(&ffmpeg_name),
                version: ffmpeg.version.clone().unwrap_or_else(|| "unknown".into()),
            };
        }
    }
    inventory
}

fn format_tokens(format: PhotoFormat) -> &'static [&'static str] {
    match format {
        PhotoFormat::Dng => &["dng", "rawvideo"],
        PhotoFormat::Heic | PhotoFormat::Heif => &["hevc", "heif", "heic"],
        PhotoFormat::Avif => &["av1", "avif"],
        PhotoFormat::CanonCr3 => &["cr3", "canon"],
        PhotoFormat::FujifilmRaf => &["raf", "fuji"],
        PhotoFormat::PhaseOneIiq => &["iiq", "phase one"],
        PhotoFormat::Jpeg => &["jpeg"],
        PhotoFormat::Tiff => &["tiff"],
        PhotoFormat::Png => &["png"],
    }
}

fn probe_tool(executable: &Path, arguments: &[&str]) -> SystemToolCapability {
    match Command::new(executable).args(arguments).output() {
        Ok(output) if output.status.success() => {
            let text = if output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr)
            } else {
                String::from_utf8_lossy(&output.stdout)
            };
            SystemToolCapability {
                available: true,
                executable: Some(path_text(executable)),
                version: text
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(|line| line.chars().take(256).collect()),
            }
        }
        _ => SystemToolCapability {
            available: false,
            executable: None,
            version: None,
        },
    }
}

fn successful_stdout(executable: &Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new(executable).args(arguments).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Immutable video/container probe result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSourceProbe {
    pub schema_version: u32,
    pub source_path: String,
    pub source_object_hash: ObjectHash,
    pub byte_size: u64,
    pub format_name: String,
    pub duration_microseconds: u64,
    pub video_codec: String,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub average_frame_rate: String,
    pub ffprobe_version: String,
    pub raw_container_metadata: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct FfprobeDocument {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    format_name: Option<String>,
    duration: Option<String>,
}

/// Probes a video without trusting extension or container tags as coordinates.
pub fn probe_video_source<C>(
    path: &Path,
    capabilities: &CaptureCapabilityInventory,
    mut cancelled: C,
) -> Result<VideoSourceProbe, CaptureRuntimeError>
where
    C: FnMut() -> bool,
{
    let executable = available_executable(&capabilities.ffprobe, "ffprobe")?;
    let (source_object_hash, byte_size) = hash_file(path, &mut cancelled)?;
    if cancelled() {
        return Err(CaptureRuntimeError::Cancelled);
    }
    let output = Command::new(executable)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|error| CaptureRuntimeError::ToolStart("ffprobe", error))?;
    if !output.status.success() {
        return Err(CaptureRuntimeError::ToolFailed {
            tool: "ffprobe",
            message: bounded_stderr(&output.stderr),
        });
    }
    let raw_container_metadata = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    let document = serde_json::from_value::<FfprobeDocument>(raw_container_metadata.clone())?;
    let stream = document
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or(CaptureRuntimeError::NoVideoStream)?;
    let format = document
        .format
        .ok_or(CaptureRuntimeError::NoContainerMetadata)?;
    let duration_seconds = format
        .duration
        .as_deref()
        .unwrap_or("0")
        .parse::<f64>()
        .map_err(|_| CaptureRuntimeError::InvalidContainerMetadata("duration"))?;
    if !duration_seconds.is_finite() || duration_seconds < 0.0 {
        return Err(CaptureRuntimeError::InvalidContainerMetadata("duration"));
    }
    Ok(VideoSourceProbe {
        schema_version: 1,
        source_path: path_text(path),
        source_object_hash,
        byte_size,
        format_name: format.format_name.unwrap_or_else(|| "unknown".into()),
        duration_microseconds: (duration_seconds * 1_000_000.0).round() as u64,
        video_codec: stream
            .codec_name
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        width_pixels: stream.width.unwrap_or(0),
        height_pixels: stream.height.unwrap_or(0),
        average_frame_rate: stream
            .avg_frame_rate
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        ffprobe_version: capabilities
            .ffprobe
            .version
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        raw_container_metadata,
    })
}

/// End-to-end request. Output remains content-addressed and can enter ordinary image commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareVideoFramesRequest {
    pub operation_id: String,
    pub source_path: String,
    pub artifact_root: String,
    pub checkpoint_path: String,
    #[serde(default)]
    pub selection: VideoFrameSelectionPolicy,
}

/// Request to normalize a RAW/HEIF source while retaining the original hash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareStillImageRequest {
    pub operation_id: String,
    pub source_path: String,
    pub format: PhotoFormat,
    pub artifact_root: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedStillImage {
    pub source_object_hash: ObjectHash,
    pub source_byte_size: u64,
    pub original_format: PhotoFormat,
    pub image: DiscoveredPhoto,
}

/// Transcodes through an advertised system capability; unsupported is never guessed.
pub fn prepare_still_image<C, P>(
    request: &PrepareStillImageRequest,
    capabilities: &CaptureCapabilityInventory,
    mut cancelled: C,
    mut progress: P,
) -> Result<PreparedStillImage, CaptureRuntimeError>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    validate_identity(&request.operation_id)?;
    progress(0.02, "Hashing immutable capture source");
    let source_path = Path::new(&request.source_path);
    let (source_object_hash, source_byte_size) = hash_file(source_path, &mut cancelled)?;
    let capability = capabilities
        .decoder(request.format)
        .ok_or(CaptureRuntimeError::UnsupportedFormat(request.format))?;
    let (tool, version) = match &capability.support {
        CaptureDecodeSupport::SystemTool { tool, version } => (tool, version),
        CaptureDecodeSupport::BuiltIn => {
            let images = import_photo_files_with_capabilities_and_progress(
                &[source_path.to_path_buf()],
                capabilities,
                &mut cancelled,
                |fraction, message| progress(0.1 + fraction * 0.88, message),
            )
            .ok_or(CaptureRuntimeError::Cancelled)?;
            let image = images
                .photos
                .into_iter()
                .next()
                .ok_or(CaptureRuntimeError::NoPreparedImage)?;
            return Ok(PreparedStillImage {
                source_object_hash,
                source_byte_size,
                original_format: request.format,
                image,
            });
        }
        CaptureDecodeSupport::Unsupported { .. } => {
            return Err(CaptureRuntimeError::UnsupportedFormat(request.format));
        }
    };
    fs::create_dir_all(&request.artifact_root)?;
    let temporary =
        Path::new(&request.artifact_root).join(format!(".{}.pending.png", request.operation_id));
    let tool_filename = Path::new(tool)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(tool)
        .to_ascii_lowercase();
    let mut command = Command::new(tool);
    if tool_filename.contains("magick") {
        command.arg(source_path).arg("-auto-orient").arg(&temporary);
    } else {
        command
            .args(["-v", "error", "-i"])
            .arg(source_path)
            .args(["-frames:v", "1"])
            .arg(&temporary);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CaptureRuntimeError::ToolStart("image transcoder", error))?;
    progress(0.2, "Decoding capture into a pipeline image");
    wait_for_child(&mut child, &mut cancelled, "image transcoder")?;
    let (artifact_hash, _) = hash_file(&temporary, &mut cancelled)?;
    let output = Path::new(&request.artifact_root).join(format!("{}.png", artifact_hash.as_str()));
    if output.exists() {
        let (existing, _) = hash_file(&output, &mut cancelled)?;
        if existing != artifact_hash {
            return Err(CaptureRuntimeError::HashCollision(output));
        }
        fs::remove_file(&temporary)?;
    } else {
        fs::rename(&temporary, &output)?;
    }
    let parameters_sha256 = ObjectHash::of_bytes(
        format!("{}:{:?}:png", VIDEO_PREPARATION_VERSION, request.format).as_bytes(),
    );
    let mut images = import_photo_files_with_capabilities_and_progress(
        std::slice::from_ref(&output),
        capabilities,
        &mut cancelled,
        |fraction, message| progress(0.72 + fraction * 0.26, message),
    )
    .ok_or(CaptureRuntimeError::Cancelled)?;
    let mut image = images
        .photos
        .pop()
        .ok_or(CaptureRuntimeError::NoPreparedImage)?;
    image.capture_source.basis = CaptureClassificationBasis::DerivedArtifact;
    image.derived_provenance = Some(DerivedCaptureArtifactProvenance {
        source_object_hash: source_object_hash.clone(),
        artifact_object_hash: image.sha256.clone(),
        operation: "captureImageTranscode".into(),
        algorithm_version: VIDEO_PREPARATION_VERSION.into(),
        parameters_sha256,
        source_timestamp_microseconds: None,
        source_frame_index: None,
        system_tool: Some(tool.clone()),
        system_tool_version: Some(version.clone()),
    });
    progress(
        1.0,
        "Capture source decoded without replacing the original hash",
    );
    Ok(PreparedStillImage {
        source_object_hash,
        source_byte_size,
        original_format: request.format,
        image,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedVideoFrames {
    pub source: VideoSourceProbe,
    pub source_archive_path: String,
    pub selection: VideoFrameSelection,
    pub images: PhotoImportBatch,
    pub checkpoint_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoPreparationCheckpoint {
    schema_version: u32,
    operation_id: String,
    algorithm_version: String,
    source_object_hash: ObjectHash,
    parameters_sha256: ObjectHash,
    stage: VideoPreparationStage,
    candidates: Vec<VideoFrameCandidate>,
    selection: Option<VideoFrameSelection>,
    prepared_paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum VideoPreparationStage {
    Probed,
    ThumbnailsMeasured,
    Selected,
    FramesPrepared,
    Completed,
    Cancelled,
}

/// Runs bounded thumbnail analysis, deterministic selection and full-frame materialization.
pub fn prepare_video_frames<C, P>(
    request: &PrepareVideoFramesRequest,
    capabilities: &CaptureCapabilityInventory,
    mut cancelled: C,
    mut progress: P,
) -> Result<PreparedVideoFrames, CaptureRuntimeError>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    validate_identity(&request.operation_id)?;
    let source_path = Path::new(&request.source_path);
    let artifact_root = Path::new(&request.artifact_root);
    let checkpoint_path = Path::new(&request.checkpoint_path);
    progress(0.01, "Hashing and probing immutable video source");
    let source = probe_video_source(source_path, capabilities, &mut cancelled)?;
    let parameters_sha256 = parameters_hash(&request.selection)?;
    let mut checkpoint = load_or_create_checkpoint(
        checkpoint_path,
        &request.operation_id,
        &source.source_object_hash,
        &parameters_sha256,
    )?;
    write_checkpoint(checkpoint_path, &checkpoint)?;
    check_cancelled(&mut cancelled, checkpoint_path, &mut checkpoint)?;

    let source_directory = artifact_root.join("sources");
    let frame_directory = artifact_root.join("frames");
    let scratch_directory = artifact_root.join(format!(".{}-thumbnails", request.operation_id));
    fs::create_dir_all(&source_directory)?;
    fs::create_dir_all(&frame_directory)?;
    let source_archive_path =
        source_directory.join(format!("{}.video", source.source_object_hash.as_str()));
    copy_verified_source(
        source_path,
        &source_archive_path,
        &source.source_object_hash,
        &mut cancelled,
        |fraction| progress(0.08 + fraction * 0.12, "Archiving immutable video source"),
    )?;
    check_cancelled(&mut cancelled, checkpoint_path, &mut checkpoint)?;

    let ffmpeg = available_executable(&capabilities.ffmpeg, "ffmpeg")?;
    if checkpoint.candidates.is_empty() {
        if scratch_directory.exists() {
            fs::remove_dir_all(&scratch_directory)?;
        }
        fs::create_dir(&scratch_directory)?;
        progress(0.22, "Extracting bounded analysis thumbnails");
        let thumbnail_pattern = scratch_directory.join("thumb-%08d.png");
        let mut child = Command::new(ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&source_archive_path)
            .args([
                "-vf",
                &format!("fps={THUMBNAIL_FPS},scale=320:-2"),
                "-fps_mode",
                "passthrough",
            ])
            .arg(&thumbnail_pattern)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| CaptureRuntimeError::ToolStart("ffmpeg", error))?;
        wait_for_child(&mut child, &mut cancelled, "ffmpeg thumbnail extraction")?;
        check_cancelled(&mut cancelled, checkpoint_path, &mut checkpoint)?;

        let thumbnail_paths = sorted_files(&scratch_directory, "png")?;
        let mut previous = None;
        for (index, path) in thumbnail_paths.iter().enumerate() {
            check_cancelled(&mut cancelled, checkpoint_path, &mut checkpoint)?;
            let image = image::open(path)?.into_luma8();
            let sharpness = stable_video_metric(normalized_laplacian_variance(&image));
            let motion = stable_video_metric(
                previous
                    .as_ref()
                    .map_or(0.25, |prior| normalized_frame_difference(prior, &image)),
            );
            let overlap = if previous.is_none() {
                0.75
            } else {
                stable_video_metric((1.0 - motion).clamp(0.0, 1.0))
            };
            checkpoint.candidates.push(VideoFrameCandidate {
                frame_index: index as u64,
                timestamp_microseconds: index as u64 * 1_000_000 / THUMBNAIL_FPS,
                width_pixels: source.width_pixels,
                height_pixels: source.height_pixels,
                sharpness,
                motion,
                overlap,
            });
            previous = Some(image);
            progress(
                0.42 + 0.18 * (index + 1) as f64 / thumbnail_paths.len().max(1) as f64,
                "Measuring sharpness, motion and overlap",
            );
        }
        checkpoint.stage = VideoPreparationStage::ThumbnailsMeasured;
        write_checkpoint(checkpoint_path, &checkpoint)?;
    }
    let selection = checkpoint
        .selection
        .clone()
        .unwrap_or_else(|| select_video_frames(&checkpoint.candidates, &request.selection));
    if selection.selected.is_empty() {
        return Err(CaptureRuntimeError::NoUsableFrames);
    }
    checkpoint.selection = Some(selection.clone());
    checkpoint.stage = VideoPreparationStage::Selected;
    write_checkpoint(checkpoint_path, &checkpoint)?;

    for (index, selected) in selection.selected.iter().enumerate() {
        check_cancelled(&mut cancelled, checkpoint_path, &mut checkpoint)?;
        let output_path = frame_directory.join(format!(
            "{}-{:08}-{:016}.png",
            &source.source_object_hash.as_str()[..16],
            selected.frame_index,
            selected.timestamp_microseconds
        ));
        let output_text = path_text(&output_path);
        if output_path.is_file() && checkpoint.prepared_paths.contains(&output_text) {
            continue;
        }
        let timestamp = format!(
            "{:.6}",
            selected.timestamp_microseconds as f64 / 1_000_000.0
        );
        let mut child = Command::new(ffmpeg)
            .args(["-v", "error", "-ss", &timestamp, "-i"])
            .arg(&source_archive_path)
            .args(["-frames:v", "1", "-map_metadata", "0"])
            .arg(&output_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| CaptureRuntimeError::ToolStart("ffmpeg", error))?;
        wait_for_child(&mut child, &mut cancelled, "ffmpeg frame extraction")?;
        checkpoint.prepared_paths.push(output_text);
        write_checkpoint(checkpoint_path, &checkpoint)?;
        progress(
            0.62 + 0.25 * (index + 1) as f64 / selection.selected.len() as f64,
            "Materializing selected full-resolution frames",
        );
    }
    checkpoint.stage = VideoPreparationStage::FramesPrepared;
    write_checkpoint(checkpoint_path, &checkpoint)?;

    let paths = checkpoint
        .prepared_paths
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let mut images = import_photo_files_with_capabilities_and_progress(
        &paths,
        capabilities,
        &mut cancelled,
        |fraction, _| {
            progress(
                0.88 + fraction * 0.1,
                "Validating selected frames as images",
            )
        },
    )
    .ok_or(CaptureRuntimeError::Cancelled)?;
    for (photo, selected) in images.photos.iter_mut().zip(selection.selected.iter()) {
        photo.capture_source.medium = CaptureMedium::VideoFrame;
        photo.capture_source.basis = CaptureClassificationBasis::DerivedArtifact;
        photo.derived_provenance = Some(DerivedCaptureArtifactProvenance {
            source_object_hash: source.source_object_hash.clone(),
            artifact_object_hash: photo.sha256.clone(),
            operation: "videoFrameSelection".into(),
            algorithm_version: VIDEO_FRAME_SELECTION_VERSION.into(),
            parameters_sha256: parameters_sha256.clone(),
            source_timestamp_microseconds: Some(selected.timestamp_microseconds),
            source_frame_index: Some(selected.frame_index),
            system_tool: capabilities.ffmpeg.executable.clone(),
            system_tool_version: capabilities.ffmpeg.version.clone(),
        });
    }
    checkpoint.stage = VideoPreparationStage::Completed;
    write_checkpoint(checkpoint_path, &checkpoint)?;
    if let Err(error) = fs::remove_dir_all(&scratch_directory) {
        tracing::warn!(path = %scratch_directory.display(), %error, "failed to remove video thumbnail scratch");
    }
    progress(
        1.0,
        "Video frames are ready for the ordinary image pipeline",
    );
    Ok(PreparedVideoFrames {
        source,
        source_archive_path: path_text(&source_archive_path),
        selection,
        images,
        checkpoint_path: path_text(checkpoint_path),
    })
}

fn stable_video_metric(value: f64) -> f64 {
    const PRECISION: f64 = 1_000_000_000_000.0;
    (value * PRECISION).round() / PRECISION
}

fn normalized_laplacian_variance(image: &image::GrayImage) -> f64 {
    if image.width() < 3 || image.height() < 3 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut square_sum = 0.0;
    let mut count = 0.0;
    for y in 1..image.height() - 1 {
        for x in 1..image.width() - 1 {
            let center = f64::from(image.get_pixel(x, y)[0]) * 4.0;
            let laplacian = center
                - f64::from(image.get_pixel(x - 1, y)[0])
                - f64::from(image.get_pixel(x + 1, y)[0])
                - f64::from(image.get_pixel(x, y - 1)[0])
                - f64::from(image.get_pixel(x, y + 1)[0]);
            sum += laplacian;
            square_sum += laplacian * laplacian;
            count += 1.0;
        }
    }
    let variance = (square_sum / count - (sum / count).powi(2)).max(0.0);
    (variance / (255.0 * 255.0)).clamp(0.0, 1.0)
}

fn normalized_frame_difference(first: &image::GrayImage, second: &image::GrayImage) -> f64 {
    let width = first.width().min(second.width());
    let height = first.height().min(second.height());
    if width == 0 || height == 0 {
        return 1.0;
    }
    let mut difference = 0_u64;
    for y in 0..height {
        for x in 0..width {
            difference += u64::from(first.get_pixel(x, y)[0].abs_diff(second.get_pixel(x, y)[0]));
        }
    }
    difference as f64 / (f64::from(width) * f64::from(height) * 255.0)
}

fn copy_verified_source<C, P>(
    source: &Path,
    target: &Path,
    expected_hash: &ObjectHash,
    cancelled: &mut C,
    mut progress: P,
) -> Result<(), CaptureRuntimeError>
where
    C: FnMut() -> bool,
    P: FnMut(f64),
{
    if target.exists() {
        let (observed, _) = hash_file(target, cancelled)?;
        if &observed == expected_hash {
            progress(1.0);
            return Ok(());
        }
        return Err(CaptureRuntimeError::HashCollision(target.to_path_buf()));
    }
    let temporary = target.with_extension("video.pending");
    let total = source.metadata()?.len();
    let mut reader = BufReader::new(File::open(source)?);
    let mut writer = File::create(&temporary)?;
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut copied = 0_u64;
    loop {
        if cancelled() {
            drop(writer);
            let _ = fs::remove_file(&temporary);
            return Err(CaptureRuntimeError::Cancelled);
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        copied += read as u64;
        progress(if total == 0 {
            1.0
        } else {
            copied as f64 / total as f64
        });
    }
    writer.sync_all()?;
    fs::rename(&temporary, target)?;
    let (observed, _) = hash_file(target, cancelled)?;
    if &observed != expected_hash {
        return Err(CaptureRuntimeError::HashMismatch);
    }
    Ok(())
}

fn wait_for_child<C>(
    child: &mut Child,
    cancelled: &mut C,
    tool: &'static str,
) -> Result<(), CaptureRuntimeError>
where
    C: FnMut() -> bool,
{
    loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CaptureRuntimeError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut stderr = Vec::new();
            if let Some(reader) = child.stderr.take() {
                reader.take(16 * 1024).read_to_end(&mut stderr)?;
            }
            return Err(CaptureRuntimeError::ToolFailed {
                tool,
                message: bounded_stderr(&stderr),
            });
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn hash_file<C>(path: &Path, cancelled: &mut C) -> Result<(ObjectHash, u64), CaptureRuntimeError>
where
    C: FnMut() -> bool,
{
    let mut reader = BufReader::new(File::open(path)?);
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        if cancelled() {
            return Err(CaptureRuntimeError::Cancelled);
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((ObjectHash(hex::encode(digest.finalize())), size))
}

fn parameters_hash(policy: &VideoFrameSelectionPolicy) -> Result<ObjectHash, CaptureRuntimeError> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(policy)?))
}

fn load_or_create_checkpoint(
    path: &Path,
    operation_id: &str,
    source_object_hash: &ObjectHash,
    parameters_sha256: &ObjectHash,
) -> Result<VideoPreparationCheckpoint, CaptureRuntimeError> {
    if path.is_file() {
        let existing = serde_json::from_slice::<VideoPreparationCheckpoint>(&fs::read(path)?)?;
        if existing.schema_version != 1
            || existing.operation_id != operation_id
            || existing.algorithm_version != VIDEO_PREPARATION_VERSION
            || &existing.source_object_hash != source_object_hash
            || &existing.parameters_sha256 != parameters_sha256
        {
            return Err(CaptureRuntimeError::CheckpointMismatch);
        }
        return Ok(existing);
    }
    Ok(VideoPreparationCheckpoint {
        schema_version: 1,
        operation_id: operation_id.to_owned(),
        algorithm_version: VIDEO_PREPARATION_VERSION.into(),
        source_object_hash: source_object_hash.clone(),
        parameters_sha256: parameters_sha256.clone(),
        stage: VideoPreparationStage::Probed,
        candidates: Vec::new(),
        selection: None,
        prepared_paths: Vec::new(),
    })
}

fn check_cancelled<C>(
    cancelled: &mut C,
    checkpoint_path: &Path,
    checkpoint: &mut VideoPreparationCheckpoint,
) -> Result<(), CaptureRuntimeError>
where
    C: FnMut() -> bool,
{
    if !cancelled() {
        return Ok(());
    }
    checkpoint.stage = VideoPreparationStage::Cancelled;
    write_checkpoint(checkpoint_path, checkpoint)?;
    Err(CaptureRuntimeError::Cancelled)
}

fn write_checkpoint(
    path: &Path,
    checkpoint: &VideoPreparationCheckpoint,
) -> Result<(), CaptureRuntimeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.pending");
    let mut bytes = serde_json::to_vec_pretty(checkpoint)?;
    bytes.push(b'\n');
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn sorted_files(root: &Path, extension: &str) -> Result<Vec<PathBuf>, CaptureRuntimeError> {
    let mut paths = fs::read_dir(root)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn available_executable<'a>(
    capability: &'a SystemToolCapability,
    name: &'static str,
) -> Result<&'a str, CaptureRuntimeError> {
    if !capability.available {
        return Err(CaptureRuntimeError::UnsupportedTool(name));
    }
    capability
        .executable
        .as_deref()
        .ok_or(CaptureRuntimeError::UnsupportedTool(name))
}

fn validate_identity(value: &str) -> Result<(), CaptureRuntimeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(CaptureRuntimeError::InvalidOperationId);
    }
    Ok(())
}

fn bounded_stderr(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(16 * 1024)])
        .trim()
        .to_owned()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Capture preparation failure with actionable unsupported-tool distinctions.
#[derive(Debug, Error)]
pub enum CaptureRuntimeError {
    #[error("capture operation was cancelled; its checkpoint is resumable")]
    Cancelled,
    #[error("required system capability is unavailable: {0}")]
    UnsupportedTool(&'static str),
    #[error("failed to start {0}: {1}")]
    ToolStart(&'static str, #[source] std::io::Error),
    #[error("{tool} failed: {message}")]
    ToolFailed { tool: &'static str, message: String },
    #[error("video has no decodable video stream")]
    NoVideoStream,
    #[error("video container metadata is absent")]
    NoContainerMetadata,
    #[error("video container field is invalid: {0}")]
    InvalidContainerMetadata(&'static str),
    #[error("video quality policy rejected every candidate frame")]
    NoUsableFrames,
    #[error("capture format is unsupported by the frozen host capability snapshot: {0:?}")]
    UnsupportedFormat(PhotoFormat),
    #[error("capture transcoder produced no ordinary image")]
    NoPreparedImage,
    #[error("video checkpoint does not match operation, source hash, policy or algorithm version")]
    CheckpointMismatch,
    #[error("operationId must be 1..128 ASCII letters, digits, '.', '-' or '_'")]
    InvalidOperationId,
    #[error("content-addressed target already contains different bytes: {0}")]
    HashCollision(PathBuf),
    #[error("copied source hash does not match the immutable source hash")]
    HashMismatch,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Image(#[from] image::ImageError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_system_tools_are_explicitly_unsupported() {
        let missing = PathBuf::from("hcad-definitely-missing-capture-tool");
        let inventory = probe_capture_capabilities(&CaptureToolConfig {
            ffprobe: Some(missing.clone()),
            ffmpeg: Some(missing.clone()),
            magick: Some(missing),
        });
        assert!(!inventory.ffprobe.available);
        assert!(!inventory.ffmpeg.available);
        assert!(inventory
            .decoder(PhotoFormat::Heic)
            .is_some_and(|capability| matches!(
                capability.support,
                CaptureDecodeSupport::Unsupported { .. }
            )));
    }

    #[test]
    fn thumbnail_metrics_separate_sharpness_and_motion() {
        let mut flat = image::GrayImage::new(8, 8);
        let mut edge = image::GrayImage::new(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                flat.put_pixel(x, y, image::Luma([100]));
                edge.put_pixel(x, y, image::Luma([if x < 4 { 0 } else { 255 }]));
            }
        }
        assert!(normalized_laplacian_variance(&edge) > normalized_laplacian_variance(&flat));
        assert!(normalized_frame_difference(&flat, &edge) > 0.0);
    }

    #[test]
    fn checkpoint_resumes_only_the_exact_source_and_policy() {
        let root = std::env::temp_dir().join(format!(
            "hcad-capture-checkpoint-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir(&root).expect("checkpoint directory");
        let path = root.join("checkpoint.json");
        let source = ObjectHash::of_bytes(b"video");
        let parameters = ObjectHash::of_bytes(b"policy");
        let mut checkpoint =
            load_or_create_checkpoint(&path, "video-1", &source, &parameters).expect("new");
        checkpoint.candidates.push(VideoFrameCandidate {
            frame_index: 2,
            timestamp_microseconds: 500_000,
            width_pixels: 1920,
            height_pixels: 1080,
            sharpness: 0.5,
            motion: 0.1,
            overlap: 0.8,
        });
        write_checkpoint(&path, &checkpoint).expect("write checkpoint");

        let resumed =
            load_or_create_checkpoint(&path, "video-1", &source, &parameters).expect("resume");
        assert_eq!(resumed.candidates.len(), 1);
        assert!(matches!(
            load_or_create_checkpoint(
                &path,
                "video-1",
                &ObjectHash::of_bytes(b"different"),
                &parameters
            ),
            Err(CaptureRuntimeError::CheckpointMismatch)
        ));
        fs::remove_dir_all(root).expect("cleanup checkpoint directory");
    }

    /// Exercises the actual ffprobe/ffmpeg process boundary. It is ignored in
    /// portable CI because HimmelCAD intentionally does not bundle FFmpeg.
    /// Run with explicit executable paths:
    ///
    /// `HCAD_M5_TEST_FFMPEG=/path/ffmpeg HCAD_M5_TEST_FFPROBE=/path/ffprobe \
    /// cargo test -p himmelcad-sidecar capture_runtime::tests::real_ffmpeg_video_gate -- --ignored`
    #[test]
    #[ignore = "requires explicit external FFmpeg and FFprobe executables"]
    fn real_ffmpeg_video_gate() {
        let ffmpeg = PathBuf::from(
            std::env::var_os("HCAD_M5_TEST_FFMPEG")
                .expect("HCAD_M5_TEST_FFMPEG must name the test executable"),
        );
        let ffprobe = PathBuf::from(
            std::env::var_os("HCAD_M5_TEST_FFPROBE")
                .expect("HCAD_M5_TEST_FFPROBE must name the test executable"),
        );
        let root = std::env::temp_dir().join(format!(
            "hcad-real-ffmpeg-gate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir(&root).expect("test directory");
        let source = root.join("source.mp4");
        let generated = Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x480:rate=10:duration=2",
                "-c:v",
                "mpeg4",
                "-q:v",
                "4",
                "-y",
            ])
            .arg(&source)
            .status()
            .expect("start synthetic video generation");
        assert!(generated.success(), "synthetic video generation failed");

        let capabilities = probe_capture_capabilities(&CaptureToolConfig {
            ffprobe: Some(ffprobe),
            ffmpeg: Some(ffmpeg),
            magick: Some(root.join("missing-magick")),
        });
        assert!(capabilities.ffprobe.available);
        assert!(capabilities.ffmpeg.available);
        let request = PrepareVideoFramesRequest {
            operation_id: "real-ffmpeg-gate".into(),
            source_path: path_text(&source),
            artifact_root: path_text(&root.join("artifacts")),
            checkpoint_path: path_text(&root.join("checkpoint.json")),
            selection: VideoFrameSelectionPolicy {
                maximum_frames: 3,
                minimum_interval_microseconds: 400_000,
                minimum_width_pixels: 640,
                minimum_height_pixels: 480,
                minimum_sharpness: 0.0,
                maximum_motion: 1.0,
                minimum_overlap: 0.0,
                maximum_overlap: 1.0,
            },
        };

        let first = prepare_video_frames(&request, &capabilities, || false, |_, _| {})
            .expect("prepare real video frames");
        assert!(!first.images.photos.is_empty());
        assert_eq!(first.images.photos.len(), first.selection.selected.len());
        assert!(Path::new(&first.source_archive_path).is_file());
        for photo in &first.images.photos {
            assert_eq!(photo.capture_source.medium, CaptureMedium::VideoFrame);
            let provenance = photo
                .derived_provenance
                .as_ref()
                .expect("video frame provenance");
            assert_eq!(
                provenance.source_object_hash,
                first.source.source_object_hash
            );
            assert_eq!(provenance.artifact_object_hash, photo.sha256);
        }

        // A second identical call must resume from the completed checkpoint and
        // return byte-identical selected frame hashes.
        let resumed = prepare_video_frames(&request, &capabilities, || false, |_, _| {})
            .expect("resume completed video preparation");
        assert_eq!(resumed.selection, first.selection);
        assert_eq!(
            resumed
                .images
                .photos
                .iter()
                .map(|photo| &photo.sha256)
                .collect::<Vec<_>>(),
            first
                .images
                .photos
                .iter()
                .map(|photo| &photo.sha256)
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(root).expect("cleanup real ffmpeg gate");
    }
}
