//! Conversion of a validated COLMAP sparse reconstruction into the neutral MVS scene format.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use himmelcad_core::{
    hash::ObjectHash,
    photolab_gcp::ImageCoordinate,
    photolab_gcp_optimization::{
        GcpBundleTiePoint, GcpCameraModel, GcpSimilarityTransform, GcpTiePointMeasurement,
        OptimizedGcpCamera,
    },
    photolab_jobs::CancellationToken,
    photolab_masks::{ImageMaskComputeScope, ImageMaskRaster},
    photolab_matching::ImageId,
};
use image::{GrayImage, ImageFormat, Luma};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::image_mask_runtime::read_compute_mask_raster;
use crate::mvs_runtime::{MvsPinholeCamera, MvsSceneImage, MvsSceneManifest};

const POLL_INTERVAL: Duration = Duration::from_millis(15);

/// Prepared, content-pinned scene ready for `MvsRuntime`.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedMvsScene {
    pub manifest_path: PathBuf,
    pub manifest_sha256: ObjectHash,
    pub manifest: MvsSceneManifest,
}

/// Original-image camera calibration used by GCP marking and optimization.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedGcpCamera {
    pub image_name: PathBuf,
    pub camera: GcpCameraModel,
}

/// Re-reads a public COLMAP text model through PhotoLab's production parser.
pub fn validate_colmap_text_model(root: &Path) -> Result<(usize, usize), MvsSceneError> {
    let cameras = parse_cameras(&root.join("cameras.txt"))?;
    let images = parse_images(&root.join("images.txt"), &cameras)?;
    let _ = parse_points(&root.join("points3D.txt"), &images)?;
    Ok((cameras.len(), images.len()))
}

#[derive(Debug, Error)]
pub enum MvsSceneError {
    #[error("invalid COLMAP reconstruction: {0}")]
    InvalidModel(String),
    #[error("COLMAP scene preparation failed in {stage} with exit code {exit_code:?}")]
    ColmapFailed {
        stage: &'static str,
        exit_code: Option<i32>,
    },
    #[error("MVS scene preparation was cancelled")]
    Cancelled,
    #[error("MVS scene progress reporting failed: {0}")]
    Progress(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("image-mask encoding error: {0}")]
    Image(#[from] image::ImageError),
}

#[derive(Debug, Clone)]
struct ParsedImage {
    image_id: u64,
    camera_id: u64,
    name: PathBuf,
    camera: MvsPinholeCamera,
    center: [f64; 3],
}

#[derive(Debug, Clone)]
struct ParsedCamera {
    width: u32,
    height: u32,
    fx: f64,
    fy: f64,
    cx: f64,
    cy: f64,
    radial_distortion: [f64; 3],
    tangential_distortion: [f64; 2],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraMapEntry {
    entity_id: String,
    image_name: PathBuf,
}

struct UndistortionMaskInput {
    raster: ImageMaskRaster,
    original_camera: ParsedCamera,
}

/// Converts the selected sparse model to public text and returns calibrated original cameras.
pub fn prepare_gcp_cameras(
    colmap_executable: &Path,
    alignment_dataset: &Path,
    output_root: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<PreparedGcpCamera>, MvsSceneError> {
    let executable = canonical_file(colmap_executable)?;
    let alignment = alignment_dataset.canonicalize()?;
    let sparse = selected_sparse_model(&alignment)?;
    if output_root.exists() {
        fs::remove_dir_all(output_root)?;
    }
    fs::create_dir_all(output_root)?;
    run_colmap(
        &executable,
        "GCP camera model conversion",
        &[
            "model_converter".into(),
            "--input_path".into(),
            sparse.as_os_str().to_owned(),
            "--output_path".into(),
            output_root.as_os_str().to_owned(),
            "--output_type".into(),
            "TXT".into(),
        ],
        cancellation,
    )?;
    let cameras = parse_cameras(&output_root.join("cameras.txt"))?;
    let images = parse_images(&output_root.join("images.txt"), &cameras)?;
    images
        .into_iter()
        .map(|image| {
            let calibration = cameras.get(&image.camera_id).ok_or_else(|| {
                MvsSceneError::InvalidModel("image references unknown camera".into())
            })?;
            let transform = image.camera.world_to_camera;
            let rotation = [
                transform[0],
                transform[1],
                transform[2],
                transform[4],
                transform[5],
                transform[6],
                transform[8],
                transform[9],
                transform[10],
            ];
            let camera_to_reconstruction_rotation = [
                rotation[0],
                rotation[3],
                rotation[6],
                rotation[1],
                rotation[4],
                rotation[7],
                rotation[2],
                rotation[5],
                rotation[8],
            ];
            let image_id = u32::try_from(image.image_id)
                .map_err(|_| MvsSceneError::InvalidModel("COLMAP image id exceeds u32".into()))?;
            Ok(PreparedGcpCamera {
                image_name: image.name,
                camera: GcpCameraModel {
                    image_id: ImageId(image_id),
                    calibration_group_id: format!("colmap-camera-{}", image.camera_id),
                    intrinsics_policy:
                        himmelcad_core::photolab_gcp_optimization::GcpIntrinsicsPolicy::Auto,
                    width_pixels: calibration.width,
                    height_pixels: calibration.height,
                    focal_x_pixels: calibration.fx,
                    focal_y_pixels: calibration.fy,
                    principal_x_pixels: calibration.cx,
                    principal_y_pixels: calibration.cy,
                    radial_distortion: calibration.radial_distortion,
                    tangential_distortion: calibration.tangential_distortion,
                    camera_to_reconstruction_rotation,
                    center_reconstruction: image.center,
                    reference_center_world_meters: None,
                    reference_stddev_meters: None,
                },
            })
        })
        .collect()
}

/// Loads a deterministic, bounded subset of the converted COLMAP sparse tracks.
///
/// Coordinates and observations are streamed from the text model. Only selected
/// point ids are retained while scanning `images.txt`, so memory is proportional
/// to `maximum_points` rather than the complete reconstruction.
pub fn load_gcp_bundle_tie_points(
    converted_model_root: &Path,
    maximum_points: u32,
    cancellation: &CancellationToken,
) -> Result<Vec<GcpBundleTiePoint>, MvsSceneError> {
    let limit = usize::try_from(maximum_points).unwrap_or(usize::MAX);
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut points = load_bundle_point_coordinates(converted_model_root, limit, cancellation)?;
    attach_bundle_point_measurements(converted_model_root, &mut points, cancellation)?;
    points.retain(|point| point.measurements.len() >= 2);
    points.sort_by_key(|point| point.track_id);
    Ok(points)
}

fn load_bundle_point_coordinates(
    converted_model_root: &Path,
    limit: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<GcpBundleTiePoint>, MvsSceneError> {
    let point_file = FileLines::open(&converted_model_root.join("points3D.txt"))?;
    let mut points = Vec::with_capacity(limit.min(50_000));
    for (line_index, line) in point_file.enumerate() {
        if line_index % 4_096 == 0 {
            cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
        }
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let values = trimmed.split_ascii_whitespace().collect::<Vec<_>>();
        if values.len() < 8 {
            return Err(MvsSceneError::InvalidModel(
                "COLMAP points3D record is truncated".into(),
            ));
        }
        let track_id = parse_model_value::<u64>(values[0], "point id")?;
        let coordinate = [
            parse_model_value(values[1], "point X")?,
            parse_model_value(values[2], "point Y")?,
            parse_model_value(values[3], "point Z")?,
        ];
        if coordinate.iter().any(|value: &f64| !value.is_finite()) {
            return Err(MvsSceneError::InvalidModel(
                "COLMAP point coordinate is not finite".into(),
            ));
        }
        let track_length = values.len().saturating_sub(8) / 2;
        if track_length < 2 {
            continue;
        }
        points.push(GcpBundleTiePoint {
            track_id,
            reconstruction_coordinate: coordinate,
            measurements: Vec::with_capacity(track_length.min(32)),
        });
        if points.len() == limit {
            break;
        }
    }
    Ok(points)
}

fn attach_bundle_point_measurements(
    converted_model_root: &Path,
    points: &mut [GcpBundleTiePoint],
    cancellation: &CancellationToken,
) -> Result<(), MvsSceneError> {
    let indices = points
        .iter()
        .enumerate()
        .map(|(index, point)| (point.track_id, index))
        .collect::<BTreeMap<_, _>>();
    let mut reader = BufReader::new(fs::File::open(converted_model_root.join("images.txt"))?);
    let mut line = String::new();
    let mut image_count = 0_usize;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let header = line.trim();
        if header.is_empty() || header.starts_with('#') {
            continue;
        }
        image_count += 1;
        if image_count % 256 == 0 {
            cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
        }
        let image_id = parse_model_value::<u32>(
            header
                .split_ascii_whitespace()
                .next()
                .ok_or_else(|| MvsSceneError::InvalidModel("image id is missing".into()))?,
            "image id",
        )?;
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(MvsSceneError::InvalidModel(
                "COLMAP image observation line is missing".into(),
            ));
        }
        let mut values = line.split_ascii_whitespace();
        while let (Some(x), Some(y), Some(point_id)) = (values.next(), values.next(), values.next())
        {
            let signed_id = parse_model_value::<i64>(point_id, "observation point id")?;
            if signed_id < 0 {
                continue;
            }
            let Ok(track_id) = u64::try_from(signed_id) else {
                continue;
            };
            let Some(point_index) = indices.get(&track_id).copied() else {
                continue;
            };
            // Neural match imports can occasionally leave two feature indices
            // from the same image on one COLMAP point. Bundle adjustment needs
            // one ray per camera, so retain the first deterministic observation
            // instead of rejecting the complete, otherwise usable sparse model.
            if points[point_index]
                .measurements
                .iter()
                .any(|measurement| measurement.image_id == ImageId(image_id))
            {
                continue;
            }
            points[point_index]
                .measurements
                .push(GcpTiePointMeasurement {
                    image_id: ImageId(image_id),
                    coordinate: ImageCoordinate {
                        x_pixels: parse_model_value(x, "observation X")?,
                        y_pixels: parse_model_value(y, "observation Y")?,
                    },
                });
        }
    }
    Ok(())
}

struct FileLines {
    inner: std::io::Lines<BufReader<fs::File>>,
}

impl FileLines {
    fn open(path: &Path) -> Result<Self, std::io::Error> {
        Ok(Self {
            inner: BufReader::new(fs::File::open(path)?).lines(),
        })
    }
}

impl Iterator for FileLines {
    type Item = Result<String, std::io::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next()
    }
}

fn parse_model_value<T: std::str::FromStr>(value: &str, label: &str) -> Result<T, MvsSceneError> {
    value
        .parse()
        .map_err(|_| MvsSceneError::InvalidModel(format!("invalid COLMAP {label}")))
}

/// Runs only fixed COLMAP conversion commands and parses public text model files.
#[allow(clippy::too_many_arguments)] // Stable scene-preparation API keeps tool and calibration inputs explicit.
pub fn prepare_mvs_scene(
    colmap_executable: &Path,
    alignment_dataset: &Path,
    scene_root: &Path,
    coordinate_frame_id: &str,
    maximum_image_dimension: u32,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<&[OptimizedGcpCamera]>,
    cancellation: &CancellationToken,
) -> Result<PreparedMvsScene, MvsSceneError> {
    prepare_mvs_scene_impl(
        colmap_executable,
        alignment_dataset,
        scene_root,
        coordinate_frame_id,
        maximum_image_dimension,
        project_transform,
        optimized_cameras,
        None,
        None,
        cancellation,
        &mut |_, _| Ok(()),
    )
}

/// Prepares a scene and transforms the exact original-pixel masks into every undistorted view.
#[allow(clippy::too_many_arguments)]
pub fn prepare_mvs_scene_with_masks_and_progress<F>(
    colmap_executable: &Path,
    alignment_dataset: &Path,
    scene_root: &Path,
    coordinate_frame_id: &str,
    maximum_image_dimension: u32,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<&[OptimizedGcpCamera]>,
    project_root: &Path,
    image_mask_scope: &ImageMaskComputeScope,
    expected_image_count: usize,
    cancellation: &CancellationToken,
    mut progress: F,
) -> Result<PreparedMvsScene, MvsSceneError>
where
    F: FnMut(u64, u64) -> Result<(), MvsSceneError>,
{
    prepare_mvs_scene_impl(
        colmap_executable,
        alignment_dataset,
        scene_root,
        coordinate_frame_id,
        maximum_image_dimension,
        project_transform,
        optimized_cameras,
        Some((project_root, image_mask_scope)),
        Some(expected_image_count),
        cancellation,
        &mut progress,
    )
}

/// Prepares an MVS scene while reporting real undistortion and manifest work.
#[allow(clippy::too_many_arguments)]
pub fn prepare_mvs_scene_with_progress<F>(
    colmap_executable: &Path,
    alignment_dataset: &Path,
    scene_root: &Path,
    coordinate_frame_id: &str,
    maximum_image_dimension: u32,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<&[OptimizedGcpCamera]>,
    expected_image_count: usize,
    cancellation: &CancellationToken,
    mut progress: F,
) -> Result<PreparedMvsScene, MvsSceneError>
where
    F: FnMut(u64, u64) -> Result<(), MvsSceneError>,
{
    prepare_mvs_scene_impl(
        colmap_executable,
        alignment_dataset,
        scene_root,
        coordinate_frame_id,
        maximum_image_dimension,
        project_transform,
        optimized_cameras,
        None,
        Some(expected_image_count),
        cancellation,
        &mut progress,
    )
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn prepare_mvs_scene_impl(
    colmap_executable: &Path,
    alignment_dataset: &Path,
    scene_root: &Path,
    coordinate_frame_id: &str,
    maximum_image_dimension: u32,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<&[OptimizedGcpCamera]>,
    image_masks: Option<(&Path, &ImageMaskComputeScope)>,
    expected_image_count: Option<usize>,
    cancellation: &CancellationToken,
    progress: &mut dyn FnMut(u64, u64) -> Result<(), MvsSceneError>,
) -> Result<PreparedMvsScene, MvsSceneError> {
    cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
    let executable = canonical_file(colmap_executable)?;
    let alignment = alignment_dataset.canonicalize()?;
    let images = alignment.join("images");
    let sparse = selected_sparse_model(&alignment)?;
    if !images.is_dir() {
        return Err(MvsSceneError::InvalidModel(
            "alignment dataset has no selected sparse model or image directory".into(),
        ));
    }
    if scene_root.exists() {
        fs::remove_dir_all(scene_root)?;
    }
    fs::create_dir_all(scene_root)?;
    let progress_total = expected_image_count.map(|count| {
        u64::try_from(count)
            .unwrap_or(u64::MAX / 2)
            .saturating_mul(2)
            .saturating_add(2)
    });
    if let Some(total) = progress_total {
        progress(1, total)?;
    }
    let undistorter_input = scene_root.join("undistorter-input-model-txt");
    fs::create_dir_all(&undistorter_input)?;
    run_colmap(
        &executable,
        "portable image-name model conversion",
        &[
            "model_converter".into(),
            "--input_path".into(),
            external_tool_path(&sparse),
            "--output_path".into(),
            external_tool_path(&undistorter_input),
            "--output_type".into(),
            "TXT".into(),
        ],
        cancellation,
    )?;
    normalize_colmap_image_name_separators(&undistorter_input.join("images.txt"))?;
    let mut last_undistorted_count = 0_u64;
    run_colmap_with_poll(
        &executable,
        "image undistortion",
        &[
            "image_undistorter".into(),
            "--image_path".into(),
            external_tool_path(&images),
            "--input_path".into(),
            external_tool_path(&undistorter_input),
            "--output_path".into(),
            external_tool_path(scene_root),
            "--output_type".into(),
            "COLMAP".into(),
            "--max_image_size".into(),
            maximum_image_dimension.to_string().into(),
        ],
        cancellation,
        || {
            let (Some(expected), Some(total)) = (expected_image_count, progress_total) else {
                return Ok(());
            };
            let completed = count_regular_files(&scene_root.join("images"))?
                .min(u64::try_from(expected).unwrap_or(u64::MAX));
            if completed > last_undistorted_count {
                last_undistorted_count = completed;
                progress(completed.saturating_add(1), total)?;
            }
            Ok(())
        },
    )?;
    if let (Some(expected), Some(total)) = (expected_image_count, progress_total) {
        let completed = count_regular_files(&scene_root.join("images"))?;
        if completed != u64::try_from(expected).unwrap_or(u64::MAX) {
            return Err(MvsSceneError::InvalidModel(format!(
                "COLMAP image undistorter produced {completed}/{expected} images"
            )));
        }
        progress(
            u64::try_from(expected)
                .unwrap_or(u64::MAX)
                .saturating_add(1),
            total,
        )?;
    }
    let text_root = scene_root.join("model-txt");
    fs::create_dir_all(&text_root)?;
    run_colmap(
        &executable,
        "model conversion",
        &[
            "model_converter".into(),
            "--input_path".into(),
            external_tool_path(&scene_root.join("sparse")),
            "--output_path".into(),
            external_tool_path(&text_root),
            "--output_type".into(),
            "TXT".into(),
        ],
        cancellation,
    )?;
    if let (Some(expected), Some(total)) = (expected_image_count, progress_total) {
        progress(
            u64::try_from(expected)
                .unwrap_or(u64::MAX)
                .saturating_add(2),
            total,
        )?;
    }
    let cameras = parse_cameras(&text_root.join("cameras.txt"))?;
    let parsed_images = parse_images(&text_root.join("images.txt"), &cameras)?;
    if parsed_images.len() < 3 {
        return Err(MvsSceneError::InvalidModel(
            "portable multi-view stereo needs at least three registered images".into(),
        ));
    }
    if let Some(expected) = expected_image_count {
        if parsed_images.len() != expected {
            return Err(MvsSceneError::InvalidModel(format!(
                "alignment scope contains {expected} cameras but COLMAP prepared {} images",
                parsed_images.len()
            )));
        }
    }
    let (depths, covisibility) = parse_points(&text_root.join("points3D.txt"), &parsed_images)?;
    let fallback_depth = fallback_depth_range(&parsed_images);
    let image_ids = parsed_images
        .iter()
        .map(|image| image.image_id)
        .collect::<BTreeSet<_>>();
    let optimized_by_image = optimized_cameras
        .unwrap_or_default()
        .iter()
        .map(|camera| (u64::from(camera.image_id.0), camera))
        .collect::<BTreeMap<_, _>>();
    let undistortion_masks = if let Some((project_root, scope)) = image_masks {
        prepare_undistortion_masks(
            &executable,
            &alignment,
            &sparse,
            scene_root,
            project_root,
            scope,
            cancellation,
        )?
    } else {
        BTreeMap::new()
    };
    let mut scene_images = Vec::with_capacity(parsed_images.len());
    for (image_index, image) in parsed_images.iter().enumerate() {
        cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
        let source = scene_root.join("images").join(&image.name);
        let source = source.canonicalize()?;
        if !source.starts_with(scene_root.canonicalize()?) {
            return Err(MvsSceneError::InvalidModel(
                "undistorted image escaped scene root".into(),
            ));
        }
        let camera = cameras
            .get(&image.camera_id)
            .ok_or_else(|| MvsSceneError::InvalidModel("image references unknown camera".into()))?;
        let (minimum_depth, maximum_depth) = depths
            .get(&image.image_id)
            .and_then(|values| robust_depth_range(values))
            .unwrap_or(fallback_depth);
        let mut neighbors = covisibility
            .get(&image.image_id)
            .map(|counts| {
                let mut values = counts.iter().collect::<Vec<_>>();
                values.sort_by(|(id_a, count_a), (id_b, count_b)| {
                    count_b.cmp(count_a).then_with(|| id_a.cmp(id_b))
                });
                values
                    .into_iter()
                    .filter(|(id, _)| image_ids.contains(id))
                    .take(16)
                    .map(|(id, _)| id.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if neighbors.len() < 2 {
            neighbors = nearest_neighbors(image, &parsed_images, 16);
        }
        let mut scene_camera = image.camera.clone();
        let mut minimum_depth = minimum_depth;
        let mut maximum_depth = maximum_depth;
        if let Some(transform) = project_transform {
            scene_camera = transform_mvs_camera(&scene_camera, transform)?;
            minimum_depth *= transform.scale;
            maximum_depth *= transform.scale;
        }
        if let Some(optimized) = optimized_by_image.get(&image.image_id) {
            scene_camera = override_mvs_camera_pose(&scene_camera, optimized);
        }
        let (mask_relative_path, mask_sha256) =
            if let Some(mask) = undistortion_masks.get(&image.name) {
                let relative = PathBuf::from("masks")
                    .join(&image.name)
                    .with_extension("png");
                let destination = scene_root.join(&relative);
                write_undistorted_keep_mask(
                    &destination,
                    &mask.raster,
                    &mask.original_camera,
                    camera,
                    cancellation,
                )?;
                (Some(relative), Some(hash_file(&destination, cancellation)?))
            } else {
                (None, None)
            };
        scene_images.push(MvsSceneImage {
            image_id: image.image_id.to_string(),
            relative_path: PathBuf::from("images").join(&image.name),
            sha256: hash_file(&source, cancellation)?,
            mask_relative_path,
            mask_sha256,
            width: camera.width,
            height: camera.height,
            camera: scene_camera,
            minimum_depth,
            maximum_depth,
            neighbor_image_ids: neighbors,
        });
        if let (Some(expected), Some(total)) = (expected_image_count, progress_total) {
            progress(
                u64::try_from(expected)
                    .unwrap_or(u64::MAX)
                    .saturating_add(2)
                    .saturating_add(u64::try_from(image_index + 1).unwrap_or(u64::MAX)),
                total,
            )?;
        }
    }
    scene_images.sort_by(|left, right| left.image_id.cmp(&right.image_id));
    let manifest = MvsSceneManifest {
        schema_version: 1,
        coordinate_frame_id: safe_frame_id(coordinate_frame_id),
        image_mask_scope_sha256: image_masks.map(|(_, scope)| scope.scope_sha256.clone()),
        images: scene_images,
    };
    let bytes = serde_json::to_vec(&manifest)?;
    let manifest_sha256 = ObjectHash::of_bytes(&bytes);
    let manifest_path = scene_root.join("scene.json");
    let temporary = scene_root.join("scene.json.tmp");
    fs::write(&temporary, &bytes)?;
    fs::rename(temporary, &manifest_path)?;
    Ok(PreparedMvsScene {
        manifest_path,
        manifest_sha256,
        manifest,
    })
}

/// Loads a previously prepared immutable scene pinned by its manifest hash.
pub fn load_prepared_mvs_scene(
    manifest_path: &Path,
    expected_sha256: &ObjectHash,
    cancellation: &CancellationToken,
) -> Result<PreparedMvsScene, MvsSceneError> {
    cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
    let manifest_path = canonical_file(manifest_path)?;
    if manifest_path.file_name() != Some(std::ffi::OsStr::new("scene.json")) {
        return Err(MvsSceneError::InvalidModel(
            "cached MVS manifest is not named scene.json".into(),
        ));
    }
    let bytes = fs::read(&manifest_path)?;
    let observed = ObjectHash::of_bytes(&bytes);
    if &observed != expected_sha256 {
        return Err(MvsSceneError::InvalidModel(format!(
            "cached MVS scene hash differs: expected {}, observed {}",
            expected_sha256.0, observed.0
        )));
    }
    let manifest = serde_json::from_slice(&bytes)?;
    Ok(PreparedMvsScene {
        manifest_path,
        manifest_sha256: observed,
        manifest,
    })
}

fn override_mvs_camera_pose(
    camera: &MvsPinholeCamera,
    optimized: &OptimizedGcpCamera,
) -> MvsPinholeCamera {
    let rotation = transpose3(optimized.camera_to_world_rotation);
    let translation = scale3(mat3_vec(rotation, optimized.center_world_meters), -1.0);
    MvsPinholeCamera {
        fx: camera.fx,
        fy: camera.fy,
        cx: camera.cx,
        cy: camera.cy,
        world_to_camera: [
            rotation[0],
            rotation[1],
            rotation[2],
            translation[0],
            rotation[3],
            rotation[4],
            rotation[5],
            translation[1],
            rotation[6],
            rotation[7],
            rotation[8],
            translation[2],
        ],
    }
}

fn prepare_undistortion_masks(
    colmap_executable: &Path,
    alignment_root: &Path,
    sparse_model: &Path,
    scene_root: &Path,
    project_root: &Path,
    scope: &ImageMaskComputeScope,
    cancellation: &CancellationToken,
) -> Result<BTreeMap<PathBuf, UndistortionMaskInput>, MvsSceneError> {
    if scope.masks.is_empty() {
        return Ok(BTreeMap::new());
    }
    let original_text = scene_root.join("original-model-txt");
    fs::create_dir_all(&original_text)?;
    run_colmap(
        colmap_executable,
        "original camera model conversion for masks",
        &[
            "model_converter".into(),
            "--input_path".into(),
            external_tool_path(sparse_model),
            "--output_path".into(),
            external_tool_path(&original_text),
            "--output_type".into(),
            "TXT".into(),
        ],
        cancellation,
    )?;
    let original_cameras = parse_cameras(&original_text.join("cameras.txt"))?;
    let original_images = parse_images(&original_text.join("images.txt"), &original_cameras)?;
    let original_by_name = original_images
        .iter()
        .map(|image| (image.name.clone(), image))
        .collect::<BTreeMap<_, _>>();
    let camera_map: Vec<CameraMapEntry> =
        serde_json::from_slice(&fs::read(alignment_root.join("camera-map.json"))?)?;
    let mask_by_entity = scope
        .masks
        .iter()
        .map(|mask| (mask.image_entity_id.0.as_str(), mask))
        .collect::<BTreeMap<_, _>>();
    let mut result = BTreeMap::new();
    for mapping in camera_map {
        let Some(mask) = mask_by_entity.get(mapping.entity_id.as_str()).copied() else {
            continue;
        };
        let image = original_by_name.get(&mapping.image_name).ok_or_else(|| {
            MvsSceneError::InvalidModel(format!(
                "masked camera {} is absent from the selected sparse model",
                mapping.entity_id
            ))
        })?;
        let camera = original_cameras.get(&image.camera_id).ok_or_else(|| {
            MvsSceneError::InvalidModel("masked image references an unknown camera".into())
        })?;
        let raster = read_compute_mask_raster(project_root, mask)
            .map_err(|error| MvsSceneError::InvalidModel(error.to_string()))?;
        if raster.width() != camera.width || raster.height() != camera.height {
            return Err(MvsSceneError::InvalidModel(format!(
                "mask dimensions differ from the original COLMAP camera for {}",
                mapping.entity_id
            )));
        }
        result.insert(
            mapping.image_name,
            UndistortionMaskInput {
                raster,
                original_camera: camera.clone(),
            },
        );
    }
    if result.len() != scope.masks.len() {
        return Err(MvsSceneError::InvalidModel(
            "one or more scoped image masks could not be mapped into the alignment dataset".into(),
        ));
    }
    Ok(result)
}

fn write_undistorted_keep_mask(
    path: &Path,
    raster: &ImageMaskRaster,
    original: &ParsedCamera,
    undistorted: &ParsedCamera,
    cancellation: &CancellationToken,
) -> Result<(), MvsSceneError> {
    let mut output = GrayImage::new(undistorted.width, undistorted.height);
    for y in 0..undistorted.height {
        if y % 32 == 0 {
            cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
        }
        for x in 0..undistorted.width {
            let normalized_x = (f64::from(x) - undistorted.cx) / undistorted.fx;
            let normalized_y = (f64::from(y) - undistorted.cy) / undistorted.fy;
            let radius2 = normalized_x * normalized_x + normalized_y * normalized_y;
            let radial = 1.0
                + original.radial_distortion[0] * radius2
                + original.radial_distortion[1] * radius2 * radius2
                + original.radial_distortion[2] * radius2 * radius2 * radius2;
            let tangential_x =
                2.0 * original.tangential_distortion[0] * normalized_x * normalized_y
                    + original.tangential_distortion[1]
                        * (radius2 + 2.0 * normalized_x * normalized_x);
            let tangential_y = original.tangential_distortion[0]
                * (radius2 + 2.0 * normalized_y * normalized_y)
                + 2.0 * original.tangential_distortion[1] * normalized_x * normalized_y;
            let source_x = original.fx * (normalized_x * radial + tangential_x) + original.cx;
            let source_y = original.fy * (normalized_y * radial + tangential_y) + original.cy;
            let masked = source_x < -0.5
                || source_y < -0.5
                || source_x > f64::from(original.width) - 0.5
                || source_y > f64::from(original.height) - 0.5
                || raster.is_masked(
                    (source_x + 0.5)
                        .floor()
                        .clamp(0.0, f64::from(original.width - 1)) as u32,
                    (source_y + 0.5)
                        .floor()
                        .clamp(0.0, f64::from(original.height - 1)) as u32,
                );
            output.put_pixel(x, y, Luma([if masked { 0 } else { 255 }]));
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| MvsSceneError::InvalidModel("undistorted mask path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("png.pending");
    output.save_with_format(&temporary, ImageFormat::Png)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn transform_mvs_camera(
    camera: &MvsPinholeCamera,
    transform: GcpSimilarityTransform,
) -> Result<MvsPinholeCamera, MvsSceneError> {
    if !transform.scale.is_finite() || transform.scale <= 0.0 {
        return Err(MvsSceneError::InvalidModel(
            "GCP similarity has invalid scale".into(),
        ));
    }
    let source = camera.world_to_camera;
    let source_rotation = [
        source[0], source[1], source[2], source[4], source[5], source[6], source[8], source[9],
        source[10],
    ];
    let source_center = [
        -(source_rotation[0] * source[3]
            + source_rotation[3] * source[7]
            + source_rotation[6] * source[11]),
        -(source_rotation[1] * source[3]
            + source_rotation[4] * source[7]
            + source_rotation[7] * source[11]),
        -(source_rotation[2] * source[3]
            + source_rotation[5] * source[7]
            + source_rotation[8] * source[11]),
    ];
    let world_center = add3(
        scale3(mat3_vec(transform.rotation, source_center), transform.scale),
        transform.translation_meters,
    );
    let rotation = mat3_mul(source_rotation, transpose3(transform.rotation));
    let translation = scale3(mat3_vec(rotation, world_center), -1.0);
    Ok(MvsPinholeCamera {
        fx: camera.fx,
        fy: camera.fy,
        cx: camera.cx,
        cy: camera.cy,
        world_to_camera: [
            rotation[0],
            rotation[1],
            rotation[2],
            translation[0],
            rotation[3],
            rotation[4],
            rotation[5],
            translation[1],
            rotation[6],
            rotation[7],
            rotation[8],
            translation[2],
        ],
    })
}

fn mat3_vec(matrix: [f64; 9], vector: [f64; 3]) -> [f64; 3] {
    [
        matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
        matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
        matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
    ]
}

fn mat3_mul(left: [f64; 9], right: [f64; 9]) -> [f64; 9] {
    let mut result = [0.0; 9];
    for row in 0..3 {
        for column in 0..3 {
            result[row * 3 + column] = (0..3)
                .map(|inner| left[row * 3 + inner] * right[inner * 3 + column])
                .sum();
        }
    }
    result
}

fn transpose3(matrix: [f64; 9]) -> [f64; 9] {
    [
        matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5],
        matrix[8],
    ]
}

fn add3(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

fn scale3(value: [f64; 3], scale: f64) -> [f64; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn run_colmap(
    executable: &Path,
    stage: &'static str,
    arguments: &[std::ffi::OsString],
    cancellation: &CancellationToken,
) -> Result<(), MvsSceneError> {
    run_colmap_with_poll(executable, stage, arguments, cancellation, || Ok(()))
}

fn run_colmap_with_poll<F>(
    executable: &Path,
    stage: &'static str,
    arguments: &[std::ffi::OsString],
    cancellation: &CancellationToken,
    mut on_poll: F,
) -> Result<(), MvsSceneError>
where
    F: FnMut() -> Result<(), MvsSceneError>,
{
    let mut child = Command::new(executable)
        .args(arguments)
        .env_clear()
        .env("COLMAP_NO_NETWORK", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut last_progress_poll = Instant::now()
        .checked_sub(Duration::from_millis(250))
        .unwrap_or_else(Instant::now);
    loop {
        if cancellation.is_cancel_requested() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(MvsSceneError::Cancelled);
        }
        if last_progress_poll.elapsed() >= Duration::from_millis(250) {
            on_poll()?;
            last_progress_poll = Instant::now();
        }
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(MvsSceneError::ColmapFailed {
                    stage,
                    exit_code: status.code(),
                })
            };
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn count_regular_files(root: &Path) -> Result<u64, MvsSceneError> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(MvsSceneError::InvalidModel(
                "prepared MVS images contain a symbolic link".into(),
            ));
        }
        if kind.is_dir() {
            total = total.saturating_add(count_regular_files(&entry.path())?);
        } else if kind.is_file() {
            total = total.saturating_add(1);
        }
    }
    Ok(total)
}

fn normalize_colmap_image_name_separators(path: &Path) -> Result<(), MvsSceneError> {
    let source = fs::read_to_string(path)?;
    let mut expect_image_record = true;
    let mut normalized = String::with_capacity(source.len());
    for line in source.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        let line_ending = if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        if content.trim_start().starts_with('#') {
            normalized.push_str(content);
            normalized.push_str(line_ending);
            continue;
        }
        if expect_image_record {
            if content.trim().is_empty() {
                normalized.push_str(content);
            } else {
                normalized.push_str(&content.replace('\\', "/"));
                expect_image_record = false;
            }
        } else {
            normalized.push_str(content);
            expect_image_record = true;
        }
        normalized.push_str(line_ending);
    }
    fs::write(path, normalized)?;
    Ok(())
}

#[cfg(windows)]
fn external_tool_path(path: &Path) -> std::ffi::OsString {
    let value = path.as_os_str().to_string_lossy();
    if let Some(suffix) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{suffix}").into()
    } else if let Some(suffix) = value.strip_prefix(r"\\?\") {
        suffix.into()
    } else {
        path.as_os_str().to_owned()
    }
}

#[cfg(not(windows))]
fn external_tool_path(path: &Path) -> std::ffi::OsString {
    path.as_os_str().to_owned()
}

fn parse_cameras(path: &Path) -> Result<BTreeMap<u64, ParsedCamera>, MvsSceneError> {
    let mut result = BTreeMap::new();
    for line in data_lines(path)? {
        let values = line.split_whitespace().collect::<Vec<_>>();
        if values.len() < 8 {
            return Err(MvsSceneError::InvalidModel(
                "invalid cameras.txt row".into(),
            ));
        }
        let id = number::<u64>(values[0], "camera id")?;
        let width = number::<u32>(values[2], "camera width")?;
        let height = number::<u32>(values[3], "camera height")?;
        let params = values[4..]
            .iter()
            .map(|value| number::<f64>(value, "camera parameter"))
            .collect::<Result<Vec<_>, _>>()?;
        let (fx, fy, cx, cy, radial_distortion, tangential_distortion) = match values[1] {
            "PINHOLE" if params.len() == 4 => (
                params[0], params[1], params[2], params[3], [0.0; 3], [0.0; 2],
            ),
            "SIMPLE_PINHOLE" if params.len() == 3 => (
                params[0], params[0], params[1], params[2], [0.0; 3], [0.0; 2],
            ),
            "SIMPLE_RADIAL" if params.len() == 4 => (
                params[0],
                params[0],
                params[1],
                params[2],
                [params[3], 0.0, 0.0],
                [0.0; 2],
            ),
            "RADIAL" if params.len() == 5 => (
                params[0],
                params[0],
                params[1],
                params[2],
                [params[3], params[4], 0.0],
                [0.0; 2],
            ),
            "OPENCV" if params.len() == 8 => (
                params[0],
                params[1],
                params[2],
                params[3],
                [params[4], params[5], 0.0],
                [params[6], params[7]],
            ),
            "FULL_OPENCV" if params.len() == 12 => {
                // PhotoLab's GCP and portable-MVS camera model implements the full
                // Brown-Conrady numerator (k1,k2,k3,p1,p2), while the emitted DJI
                // calibration deliberately fixes COLMAP's rational denominator
                // k4,k5,k6 to zero. Never silently discard a refined denominator.
                if params[9..12].iter().any(|value| value.abs() > 1.0e-15) {
                    return Err(MvsSceneError::InvalidModel(
                        "FULL_OPENCV k4/k5/k6 must remain zero for PhotoLab GCP/MVS projection"
                            .into(),
                    ));
                }
                (
                    params[0],
                    params[1],
                    params[2],
                    params[3],
                    [params[4], params[5], params[8]],
                    [params[6], params[7]],
                )
            }
            model => {
                return Err(MvsSceneError::InvalidModel(format!(
                    "camera model {model} is not supported for GCP projection"
                )))
            }
        };
        result.insert(
            id,
            ParsedCamera {
                width,
                height,
                fx,
                fy,
                cx,
                cy,
                radial_distortion,
                tangential_distortion,
            },
        );
    }
    Ok(result)
}

fn parse_images(
    path: &Path,
    cameras: &BTreeMap<u64, ParsedCamera>,
) -> Result<Vec<ParsedImage>, MvsSceneError> {
    let text = fs::read_to_string(path)?;
    let mut lines = text
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'));
    let mut result = Vec::new();
    while let Some(header) = lines.next() {
        if header.trim().is_empty() {
            continue;
        }
        let values = header.split_whitespace().collect::<Vec<_>>();
        if values.len() < 10 {
            return Err(MvsSceneError::InvalidModel("invalid images.txt row".into()));
        }
        let image_id = number::<u64>(values[0], "image id")?;
        let quaternion = [
            number(values[1], "qw")?,
            number(values[2], "qx")?,
            number(values[3], "qy")?,
            number(values[4], "qz")?,
        ];
        let translation = [
            number(values[5], "tx")?,
            number(values[6], "ty")?,
            number(values[7], "tz")?,
        ];
        let camera_id = number::<u64>(values[8], "camera id")?;
        let intrinsics = cameras
            .get(&camera_id)
            .ok_or_else(|| MvsSceneError::InvalidModel("unknown camera id".into()))?;
        let name = PathBuf::from(values[9..].join(" "));
        validate_relative(&name)?;
        let rotation = quaternion_rotation(quaternion)?;
        let world_to_camera = [
            rotation[0][0],
            rotation[0][1],
            rotation[0][2],
            translation[0],
            rotation[1][0],
            rotation[1][1],
            rotation[1][2],
            translation[1],
            rotation[2][0],
            rotation[2][1],
            rotation[2][2],
            translation[2],
        ];
        let center = [
            -(rotation[0][0] * translation[0]
                + rotation[1][0] * translation[1]
                + rotation[2][0] * translation[2]),
            -(rotation[0][1] * translation[0]
                + rotation[1][1] * translation[1]
                + rotation[2][1] * translation[2]),
            -(rotation[0][2] * translation[0]
                + rotation[1][2] * translation[1]
                + rotation[2][2] * translation[2]),
        ];
        result.push(ParsedImage {
            image_id,
            camera_id,
            name,
            camera: MvsPinholeCamera {
                fx: intrinsics.fx,
                fy: intrinsics.fy,
                cx: intrinsics.cx,
                cy: intrinsics.cy,
                world_to_camera,
            },
            center,
        });
        let _observations = lines.next().ok_or_else(|| {
            MvsSceneError::InvalidModel("images.txt misses observation row".into())
        })?;
    }
    Ok(result)
}

type Depths = BTreeMap<u64, Vec<f64>>;
type Covisibility = BTreeMap<u64, BTreeMap<u64, u32>>;

fn parse_points(
    path: &Path,
    images: &[ParsedImage],
) -> Result<(Depths, Covisibility), MvsSceneError> {
    let lookup = images
        .iter()
        .map(|image| (image.image_id, image))
        .collect::<BTreeMap<_, _>>();
    let mut depths = BTreeMap::<u64, Vec<f64>>::new();
    let mut covisibility = BTreeMap::<u64, BTreeMap<u64, u32>>::new();
    for line in data_lines(path)? {
        let values = line.split_whitespace().collect::<Vec<_>>();
        if values.len() < 8 || (values.len() - 8) % 2 != 0 {
            return Err(MvsSceneError::InvalidModel(
                "invalid points3D.txt row".into(),
            ));
        }
        let point: [f64; 3] = [
            number(values[1], "point x")?,
            number(values[2], "point y")?,
            number(values[3], "point z")?,
        ];
        let mut track = values[8..]
            .chunks_exact(2)
            .map(|pair| number::<u64>(pair[0], "track image id"))
            .collect::<Result<Vec<_>, _>>()?;
        track.sort_unstable();
        track.dedup();
        track.retain(|id| lookup.contains_key(id));
        for image_id in &track {
            let image = lookup[image_id];
            let transform = image.camera.world_to_camera;
            let depth = transform[8] * point[0]
                + transform[9] * point[1]
                + transform[10] * point[2]
                + transform[11];
            if depth.is_finite() && depth > 0.0 {
                depths.entry(*image_id).or_default().push(depth);
            }
        }
        for (position, left) in track.iter().take(64).enumerate() {
            for right in track.iter().take(64).skip(position + 1) {
                *covisibility
                    .entry(*left)
                    .or_default()
                    .entry(*right)
                    .or_default() += 1;
                *covisibility
                    .entry(*right)
                    .or_default()
                    .entry(*left)
                    .or_default() += 1;
            }
        }
    }
    Ok((depths, covisibility))
}

fn robust_depth_range(values: &[f64]) -> Option<(f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let low = sorted[sorted.len().saturating_mul(2) / 100];
    let high = sorted[(sorted.len().saturating_mul(98) / 100).min(sorted.len() - 1)];
    let minimum = (low * 0.8).max(f64::EPSILON);
    let maximum = (high * 1.2).max(minimum * 1.01);
    Some((minimum, maximum))
}

fn fallback_depth_range(images: &[ParsedImage]) -> (f64, f64) {
    let mut baselines = Vec::new();
    for (index, left) in images.iter().enumerate() {
        for right in images.iter().skip(index + 1) {
            baselines.push(distance(left.center, right.center));
        }
    }
    baselines.retain(|value| value.is_finite() && *value > 0.0);
    baselines.sort_by(f64::total_cmp);
    let baseline = baselines.get(baselines.len() / 2).copied().unwrap_or(1.0);
    ((baseline * 0.1).max(0.001), (baseline * 1_000.0).max(1.0))
}

fn nearest_neighbors(image: &ParsedImage, images: &[ParsedImage], maximum: usize) -> Vec<String> {
    let mut values = images
        .iter()
        .filter(|candidate| candidate.image_id != image.image_id)
        .map(|candidate| (distance(image.center, candidate.center), candidate.image_id))
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    values
        .into_iter()
        .take(maximum)
        .map(|(_, id)| id.to_string())
        .collect()
}

fn distance(left: [f64; 3], right: [f64; 3]) -> f64 {
    ((left[0] - right[0]).powi(2) + (left[1] - right[1]).powi(2) + (left[2] - right[2]).powi(2))
        .sqrt()
}

fn quaternion_rotation(q: [f64; 4]) -> Result<[[f64; 3]; 3], MvsSceneError> {
    let norm = (q.iter().map(|value| value * value).sum::<f64>()).sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON {
        return Err(MvsSceneError::InvalidModel(
            "invalid image quaternion".into(),
        ));
    }
    let [w, x, y, z] = q.map(|value| value / norm);
    Ok([
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ])
}

fn data_lines(path: &Path) -> Result<Vec<String>, MvsSceneError> {
    Ok(fs::read_to_string(path)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect())
}

fn number<T: std::str::FromStr>(value: &str, field: &str) -> Result<T, MvsSceneError> {
    value
        .parse()
        .map_err(|_| MvsSceneError::InvalidModel(format!("invalid {field}")))
}

fn validate_relative(path: &Path) -> Result<(), MvsSceneError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        Err(MvsSceneError::InvalidModel("unsafe image path".into()))
    } else {
        Ok(())
    }
}

fn canonical_file(path: &Path) -> Result<PathBuf, MvsSceneError> {
    let path = path.canonicalize()?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(MvsSceneError::InvalidModel(
            "COLMAP executable is not a file".into(),
        ))
    }
}

fn hash_file(path: &Path, cancellation: &CancellationToken) -> Result<ObjectHash, MvsSceneError> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    loop {
        cancellation.check().map_err(|_| MvsSceneError::Cancelled)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn safe_frame_id(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "project-frame".into()
    } else {
        sanitized
    }
}

fn selected_sparse_model(alignment: &Path) -> Result<PathBuf, MvsSceneError> {
    for candidate in [
        alignment.join("sparse-aligned"),
        alignment.join("sparse-selected/0"),
    ] {
        if is_sparse_model(&candidate) {
            return Ok(candidate);
        }
    }
    for root in [
        alignment.join("sparse-global"),
        alignment.join("sparse-incremental"),
    ] {
        if !root.is_dir() {
            continue;
        }
        let mut candidates = fs::read_dir(&root)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|entry| entry.path())
            .filter(|path| is_sparse_model(path))
            .collect::<Vec<_>>();
        candidates.sort();
        if let Some(candidate) = candidates.into_iter().next() {
            return Ok(candidate);
        }
    }
    Err(MvsSceneError::InvalidModel(
        "alignment dataset has no selected sparse model".into(),
    ))
}

fn is_sparse_model(path: &Path) -> bool {
    path.is_dir()
        && (path.join("cameras.bin").is_file() || path.join("cameras.txt").is_file())
        && (path.join("images.bin").is_file() || path.join("images.txt").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undistorted_keep_mask_preserves_identity_pixels() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-mvs-mask-identity-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("mask root");
        let mut raster = ImageMaskRaster::empty(8, 6).expect("mask");
        raster.set_masked(3, 2, true);
        let camera = ParsedCamera {
            width: 8,
            height: 6,
            fx: 100.0,
            fy: 100.0,
            cx: 3.5,
            cy: 2.5,
            radial_distortion: [0.0; 3],
            tangential_distortion: [0.0; 2],
        };
        let path = root.join("identity.png");
        write_undistorted_keep_mask(&path, &raster, &camera, &camera, &CancellationToken::new())
            .expect("write identity mask");
        let image = image::open(&path).expect("read mask").to_luma8();
        assert_eq!(image.get_pixel(3, 2).0[0], 0);
        assert_eq!(image.get_pixel(2, 2).0[0], 255);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cached_scene_requires_the_published_manifest_hash() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-mvs-scene-cache-hash-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("scene root");
        let manifest = MvsSceneManifest {
            schema_version: 1,
            coordinate_frame_id: "frame".into(),
            image_mask_scope_sha256: None,
            images: Vec::new(),
        };
        let bytes = serde_json::to_vec(&manifest).expect("scene JSON");
        let path = root.join("scene.json");
        fs::write(&path, &bytes).expect("scene manifest");
        let expected = ObjectHash::of_bytes(&bytes);
        let loaded = load_prepared_mvs_scene(&path, &expected, &CancellationToken::new())
            .expect("pinned scene");
        assert_eq!(loaded.manifest_sha256, expected);
        assert!(load_prepared_mvs_scene(
            &path,
            &ObjectHash::of_bytes(b"different"),
            &CancellationToken::new(),
        )
        .is_err());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn colmap_image_names_are_normalized_without_touching_observation_rows() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-mvs-portable-image-names-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("model root");
        let path = root.join("images.txt");
        fs::write(
            &path,
            "# Image list\n1 1 0 0 0 0 0 0 1 calibration-000000\\image-00000000.jpg\n10 20 -1 30 40 7\n2 1 0 0 0 0 0 0 1 calibration-000000\\image-00000001.jpg\n\n",
        )
        .expect("image fixture");

        normalize_colmap_image_name_separators(&path).expect("normalize image names");

        let normalized = fs::read_to_string(&path).expect("normalized model");
        assert!(normalized.contains("calibration-000000/image-00000000.jpg"));
        assert!(normalized.contains("calibration-000000/image-00000001.jpg"));
        assert!(normalized.contains("10 20 -1 30 40 7"));
        assert!(!normalized.contains('\\'));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn external_tool_paths_strip_windows_verbatim_prefixes() {
        assert_eq!(
            external_tool_path(Path::new(r"\\?\C:\project\images")),
            std::ffi::OsString::from(r"C:\project\images")
        );
        assert_eq!(
            external_tool_path(Path::new(r"\\?\UNC\server\share\images")),
            std::ffi::OsString::from(r"\\server\share\images")
        );
    }

    fn temporary_model_root() -> PathBuf {
        std::env::temp_dir().join(format!("himmelcad-gcp-bundle-model-{}", std::process::id()))
    }

    #[test]
    fn quaternion_identity_builds_identity_rotation() {
        assert_eq!(
            quaternion_rotation([1.0, 0.0, 0.0, 0.0]).unwrap(),
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        );
    }

    #[test]
    fn robust_depth_range_rejects_empty_and_expands_data() {
        assert_eq!(robust_depth_range(&[]), None);
        let range = robust_depth_range(&[2.0, 3.0, 4.0]).unwrap();
        assert!(range.0 < 2.0 && range.1 > 4.0);
    }

    #[test]
    fn full_opencv_parser_preserves_brown_parameter_order_for_gcp_and_mvs() {
        let root = temporary_model_root().join("full-opencv-order");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("model root");
        fs::write(
            root.join("cameras.txt"),
            "1 FULL_OPENCV 5280 3956 3713.5 3714.5 2660.5 1961.5 -0.1 -0.002 0.0003 -0.0004 -0.015 0 0 0\n",
        )
        .expect("camera fixture");

        let cameras = parse_cameras(&root.join("cameras.txt")).expect("parse FULL_OPENCV");
        let camera = cameras.get(&1).expect("camera one");
        assert_eq!([camera.fx, camera.fy], [3713.5, 3714.5]);
        assert_eq!([camera.cx, camera.cy], [2660.5, 1961.5]);
        assert_eq!(camera.radial_distortion, [-0.1, -0.002, -0.015]);
        assert_eq!(camera.tangential_distortion, [0.0003, -0.0004]);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn full_opencv_parser_rejects_unmodelled_rational_denominator() {
        let root = temporary_model_root().join("full-opencv-denominator");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("model root");
        fs::write(
            root.join("cameras.txt"),
            "1 FULL_OPENCV 100 100 80 80 50 50 0 0 0 0 0 0.001 0 0\n",
        )
        .expect("camera fixture");

        let error = parse_cameras(&root.join("cameras.txt"))
            .expect_err("non-zero rational denominator must not be discarded");
        assert!(error.to_string().contains("k4/k5/k6 must remain zero"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn optimized_gcp_camera_overrides_pose_without_changing_undistorted_intrinsics() {
        let source = MvsPinholeCamera {
            fx: 500.0,
            fy: 510.0,
            cx: 250.0,
            cy: 200.0,
            world_to_camera: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        };
        let optimized = OptimizedGcpCamera {
            image_id: ImageId(7),
            calibration_group_id: "optimized-test-camera".into(),
            width_pixels: 1000,
            height_pixels: 800,
            focal_x_pixels: 1000.0,
            focal_y_pixels: 1000.0,
            principal_x_pixels: 500.0,
            principal_y_pixels: 400.0,
            radial_distortion: [0.0; 3],
            tangential_distortion: [0.0; 2],
            camera_to_world_rotation: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            center_world_meters: [10.0, 20.0, 30.0],
        };
        let result = override_mvs_camera_pose(&source, &optimized);
        assert_eq!(
            [result.fx, result.fy, result.cx, result.cy],
            [500.0, 510.0, 250.0, 200.0]
        );
        assert_eq!(
            [
                result.world_to_camera[3],
                result.world_to_camera[7],
                result.world_to_camera[11]
            ],
            [-10.0, -20.0, -30.0]
        );
    }

    #[test]
    fn bundle_tie_point_loader_is_bounded_and_joins_image_measurements() {
        let root = temporary_model_root();
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("model root");
        fs::write(
            root.join("points3D.txt"),
            "# points\n10 1 2 3 255 0 0 0.2 1 0 2 0\n20 4 5 6 0 255 0 0.3 1 1 2 1\n",
        )
        .expect("points");
        fs::write(
            root.join("images.txt"),
            "# images\n1 1 0 0 0 0 0 0 1 image-a.jpg\n100 200 10 105 205 10 300 400 20\n2 1 0 0 0 0 0 0 1 image-b.jpg\n110 210 10 310 410 20\n",
        )
        .expect("images");
        let points =
            load_gcp_bundle_tie_points(&root, 1, &CancellationToken::new()).expect("tie points");
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].track_id, 10);
        assert_eq!(points[0].measurements.len(), 2);
        assert_eq!(points[0].measurements[0].coordinate.x_pixels, 100.0);
        assert_eq!(points[0].measurements[1].coordinate.x_pixels, 110.0);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
