//! DEM-guided, camera-based orthophoto preparation with bounded working memory.

use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::Duration,
};

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_jobs::CancellationToken;
use image::{ImageReader, RgbImage, RgbaImage};
use thiserror::Error;

use crate::{
    mvs_runtime::{MvsPinholeCamera, MvsSceneImage, MvsSceneManifest},
    process_group,
    raster_runtime::{OrthophotoSource, RasterBounds, RasterBuildSummary, RasterCrs, RasterGrid},
};

const TILE_SIZE: usize = 512;
const TILE_SIZE_U32: u32 = 512;
const TILE_SIZE_U64: u64 = 512;
const TILE_SIZE_F64: f64 = 512.0;
const IMAGE_CACHE_BYTES: usize = 384 * 1024 * 1024;
const MAX_TILE_CAMERAS: usize = 16;
const PROCESS_POLL: Duration = Duration::from_millis(15);

/// Pixel compositing used before GDAL creates the immutable raster pyramid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraBlendMode {
    /// Highest view-quality camera at each pixel.
    BestCamera,
    /// View-quality weighted mean of every usable camera.
    WeightedAverage,
    /// First usable camera in deterministic quality order.
    FirstCamera,
}

/// Controls bounded orthophoto preparation.
pub struct OrthophotoPreparation<'a> {
    pub scene_manifest_path: &'a Path,
    pub dem_dataset_root: &'a Path,
    pub dem_summary: &'a RasterBuildSummary,
    pub output_root: &'a Path,
    pub gdal_translate: &'a Path,
    pub grid: &'a RasterGrid,
    pub crs: &'a RasterCrs,
    /// Exact frozen WKT inherited from the DEM dependency.
    pub frozen_wkt: &'a str,
    pub blend_mode: CameraBlendMode,
    pub color_correction: bool,
    pub fill_holes: bool,
    pub cancellation: &'a CancellationToken,
}

#[derive(Debug, Error)]
pub enum OrthophotoPreparationError {
    #[error("invalid orthophoto input: {0}")]
    InvalidInput(String),
    #[error("orthophoto preparation was cancelled")]
    Cancelled,
    #[error("GDAL VRT preparation failed with exit code {0:?}")]
    GdalFailed(Option<i32>),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("image decode/encode error: {0}")]
    Image(#[from] image::ImageError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Orthorectifies every output tile directly from undistorted source cameras.
pub fn prepare_camera_orthophotos(
    request: &OrthophotoPreparation<'_>,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<OrthophotoSource>, OrthophotoPreparationError> {
    validate_request(request)?;
    if request.output_root.exists() {
        fs::remove_dir_all(request.output_root)?;
    }
    fs::create_dir_all(request.output_root)?;
    let scene_root = request
        .scene_manifest_path
        .parent()
        .ok_or_else(|| OrthophotoPreparationError::InvalidInput("scene path has no parent".into()))?
        .canonicalize()?;
    let scene: MvsSceneManifest = serde_json::from_slice(&fs::read(request.scene_manifest_path)?)?;
    if scene.images.is_empty() {
        return Err(OrthophotoPreparationError::InvalidInput(
            "scene contains no cameras".into(),
        ));
    }
    let mut dem = DemSampler::open(request.dem_dataset_root, request.dem_summary)?;
    let mut images = ImageCache::new(IMAGE_CACHE_BYTES);
    let columns = request.grid.width_pixels.div_ceil(TILE_SIZE_U32);
    let rows = request.grid.height_pixels.div_ceil(TILE_SIZE_U32);
    let total = u64::from(columns) * u64::from(rows);
    let mut sources = Vec::with_capacity(usize::try_from(total).unwrap_or(0));
    let mut covered_pixels = 0_u64;
    for row in 0..rows {
        for column in 0..columns {
            check_cancelled(request.cancellation)?;
            let bounds = tile_bounds(request.grid, column, row);
            let heights = sample_heights(&mut dem, bounds, request.grid.gsd, request.cancellation)?;
            let candidates = candidate_cameras(&scene.images, bounds, &heights);
            let rgba = render_tile(
                request,
                &scene_root,
                &candidates,
                &heights,
                bounds,
                &mut images,
            )?;
            covered_pixels = covered_pixels.saturating_add(
                rgba.pixels()
                    .filter(|pixel| pixel.0[3] != 0)
                    .count()
                    .try_into()
                    .unwrap_or(u64::MAX),
            );
            let source_id = format!("camera-{column}-{row}");
            let png = request.output_root.join(format!("{source_id}.png"));
            rgba.save_with_format(&png, image::ImageFormat::Png)?;
            let vrt = request.output_root.join(format!("{source_id}.vrt"));
            build_georeferenced_vrt(
                request.gdal_translate,
                &png,
                &vrt,
                bounds,
                request.frozen_wkt,
                request.cancellation,
            )?;
            sources.push(OrthophotoSource {
                source_id,
                warp_vrt_path: vrt.to_string_lossy().into_owned(),
                bounds,
                crs: request.crs.clone(),
            });
            progress(
                u64::from(row) * u64::from(columns) + u64::from(column) + 1,
                total,
            );
        }
    }
    validate_coverage(covered_pixels)?;
    Ok(sources)
}

fn validate_coverage(covered_pixels: u64) -> Result<(), OrthophotoPreparationError> {
    if covered_pixels == 0 {
        return Err(OrthophotoPreparationError::InvalidInput(
            "camera poses and the DEM do not overlap; orthomosaic would be fully transparent"
                .into(),
        ));
    }
    Ok(())
}

fn validate_request(request: &OrthophotoPreparation<'_>) -> Result<(), OrthophotoPreparationError> {
    if request.grid.gsd <= 0.0 || !request.grid.gsd.is_finite() {
        return Err(OrthophotoPreparationError::InvalidInput(
            "invalid output GSD".into(),
        ));
    }
    if request.dem_summary.levels.is_empty() {
        return Err(OrthophotoPreparationError::InvalidInput(
            "DEM has no pyramid levels".into(),
        ));
    }
    if request.dem_summary.crs != *request.crs {
        return Err(OrthophotoPreparationError::InvalidInput(
            "DEM and orthophoto CRS differ".into(),
        ));
    }
    if ObjectHash::of_bytes(request.frozen_wkt.as_bytes()) != request.crs.canonical_wkt_sha256 {
        return Err(OrthophotoPreparationError::InvalidInput(
            "frozen WKT does not match the DEM CRS contract".into(),
        ));
    }
    Ok(())
}

fn sample_heights(
    dem: &mut DemSampler,
    bounds: RasterBounds,
    gsd: f64,
    cancellation: &CancellationToken,
) -> Result<Vec<f32>, OrthophotoPreparationError> {
    let mut heights = vec![f32::NAN; TILE_SIZE * TILE_SIZE];
    for row in 0..TILE_SIZE {
        if row % 16 == 0 {
            check_cancelled(cancellation)?;
        }
        let row_world = f64::from(u32::try_from(row).expect("tile row is bounded"));
        let north = bounds.maximum_north - (row_world + 0.5) * gsd;
        for column in 0..TILE_SIZE {
            let column_world = f64::from(u32::try_from(column).expect("tile column is bounded"));
            let east = bounds.minimum_east + (column_world + 0.5) * gsd;
            heights[row * TILE_SIZE + column] = dem.sample(east, north)?;
        }
    }
    Ok(heights)
}

fn candidate_cameras<'a>(
    cameras: &'a [MvsSceneImage],
    bounds: RasterBounds,
    heights: &[f32],
) -> Vec<&'a MvsSceneImage> {
    let mut minimum_z = f64::INFINITY;
    let mut maximum_z = f64::NEG_INFINITY;
    for height in heights.iter().copied().filter(|value| value.is_finite()) {
        minimum_z = minimum_z.min(f64::from(height));
        maximum_z = maximum_z.max(f64::from(height));
    }
    if !minimum_z.is_finite() {
        return Vec::new();
    }
    let center = [
        (bounds.minimum_east + bounds.maximum_east) * 0.5,
        (bounds.minimum_north + bounds.maximum_north) * 0.5,
        (minimum_z + maximum_z) * 0.5,
    ];
    let mut ranked = cameras
        .iter()
        .filter_map(|camera| {
            camera_overlaps(camera, bounds, minimum_z, maximum_z)
                .then(|| view_quality(&camera.camera, center))
                .flatten()
                .map(|quality| (quality, camera))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| left.1.image_id.cmp(&right.1.image_id))
    });
    ranked
        .into_iter()
        .take(MAX_TILE_CAMERAS)
        .map(|(_, camera)| camera)
        .collect()
}

fn camera_overlaps(camera: &MvsSceneImage, bounds: RasterBounds, min_z: f64, max_z: f64) -> bool {
    let mut min_u = f64::INFINITY;
    let mut min_v = f64::INFINITY;
    let mut max_u = f64::NEG_INFINITY;
    let mut max_v = f64::NEG_INFINITY;
    for east in [bounds.minimum_east, bounds.maximum_east] {
        for north in [bounds.minimum_north, bounds.maximum_north] {
            for height in [min_z, max_z] {
                if let Some((u, v, _)) = project(&camera.camera, [east, north, height]) {
                    min_u = min_u.min(u);
                    min_v = min_v.min(v);
                    max_u = max_u.max(u);
                    max_v = max_v.max(v);
                }
            }
        }
    }
    min_u.is_finite()
        && max_u >= 0.0
        && max_v >= 0.0
        && min_u < f64::from(camera.width)
        && min_v < f64::from(camera.height)
}

fn render_tile(
    request: &OrthophotoPreparation<'_>,
    scene_root: &Path,
    candidates: &[&MvsSceneImage],
    heights: &[f32],
    bounds: RasterBounds,
    cache: &mut ImageCache,
) -> Result<RgbaImage, OrthophotoPreparationError> {
    let pixel_count = TILE_SIZE * TILE_SIZE;
    let mut red = vec![0.0_f64; pixel_count];
    let mut green = vec![0.0_f64; pixel_count];
    let mut blue = vec![0.0_f64; pixel_count];
    let mut weights = vec![0.0_f64; pixel_count];
    for camera in candidates {
        check_cancelled(request.cancellation)?;
        let source = scene_root.join(&camera.relative_path).canonicalize()?;
        if !source.starts_with(scene_root) {
            return Err(OrthophotoPreparationError::InvalidInput(
                "camera image escaped scene root".into(),
            ));
        }
        let cached = cache.load(&camera.image_id, &source)?;
        let correction = if request.color_correction {
            [
                (128.0 / cached.mean[0].max(1.0)).clamp(0.75, 1.33),
                (128.0 / cached.mean[1].max(1.0)).clamp(0.75, 1.33),
                (128.0 / cached.mean[2].max(1.0)).clamp(0.75, 1.33),
            ]
        } else {
            [1.0; 3]
        };
        for row in 0..TILE_SIZE {
            if row % 16 == 0 {
                check_cancelled(request.cancellation)?;
            }
            let row_world = f64::from(u32::try_from(row).expect("tile row is bounded"));
            let north = bounds.maximum_north - (row_world + 0.5) * request.grid.gsd;
            for column in 0..TILE_SIZE {
                let index = row * TILE_SIZE + column;
                let height = heights[index];
                if !height.is_finite() {
                    continue;
                }
                let column_world =
                    f64::from(u32::try_from(column).expect("tile column is bounded"));
                let east = bounds.minimum_east + (column_world + 0.5) * request.grid.gsd;
                let Some((u, v, quality)) =
                    project(&camera.camera, [east, north, f64::from(height)])
                else {
                    continue;
                };
                let Some(sample) = bilinear(&cached.pixels, u, v) else {
                    continue;
                };
                let sample = [
                    sample[0] * correction[0],
                    sample[1] * correction[1],
                    sample[2] * correction[2],
                ];
                match request.blend_mode {
                    CameraBlendMode::WeightedAverage => {
                        red[index] += sample[0] * quality;
                        green[index] += sample[1] * quality;
                        blue[index] += sample[2] * quality;
                        weights[index] += quality;
                    }
                    CameraBlendMode::BestCamera if quality > weights[index] => {
                        red[index] = sample[0];
                        green[index] = sample[1];
                        blue[index] = sample[2];
                        weights[index] = quality;
                    }
                    CameraBlendMode::FirstCamera if weights[index] == 0.0 => {
                        red[index] = sample[0];
                        green[index] = sample[1];
                        blue[index] = sample[2];
                        weights[index] = 1.0;
                    }
                    _ => {}
                }
            }
        }
    }
    let mut bytes = vec![0_u8; pixel_count * 4];
    for index in 0..pixel_count {
        let weight = weights[index];
        if weight <= 0.0 {
            continue;
        }
        let divisor = if request.blend_mode == CameraBlendMode::WeightedAverage {
            weight
        } else {
            1.0
        };
        bytes[index * 4] = channel(red[index] / divisor);
        bytes[index * 4 + 1] = channel(green[index] / divisor);
        bytes[index * 4 + 2] = channel(blue[index] / divisor);
        bytes[index * 4 + 3] = 255;
    }
    if request.fill_holes {
        fill_single_pixel_holes(&mut bytes);
    }
    RgbaImage::from_raw(TILE_SIZE_U32, TILE_SIZE_U32, bytes)
        .ok_or_else(|| OrthophotoPreparationError::InvalidInput("invalid RGBA tile".into()))
}

fn project(camera: &MvsPinholeCamera, point: [f64; 3]) -> Option<(f64, f64, f64)> {
    let transform = camera.world_to_camera;
    let camera_x =
        transform[0] * point[0] + transform[1] * point[1] + transform[2] * point[2] + transform[3];
    let camera_y =
        transform[4] * point[0] + transform[5] * point[1] + transform[6] * point[2] + transform[7];
    let camera_z = transform[8] * point[0]
        + transform[9] * point[1]
        + transform[10] * point[2]
        + transform[11];
    if !camera_z.is_finite() || camera_z <= 1e-6 {
        return None;
    }
    let u = camera.fx * camera_x / camera_z + camera.cx;
    let v = camera.fy * camera_y / camera_z + camera.cy;
    let cosine =
        camera_z / (camera_x * camera_x + camera_y * camera_y + camera_z * camera_z).sqrt();
    let quality = cosine.max(0.0).powi(4);
    (u.is_finite() && v.is_finite() && quality > 1e-5).then_some((u, v, quality))
}

fn view_quality(camera: &MvsPinholeCamera, point: [f64; 3]) -> Option<f64> {
    project(camera, point).map(|(_, _, quality)| quality)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "image coordinates are checked against non-negative u32 image bounds first"
)]
fn bilinear(image: &RgbImage, u: f64, v: f64) -> Option<[f64; 3]> {
    if u < 0.0 || v < 0.0 || u >= f64::from(image.width() - 1) || v >= f64::from(image.height() - 1)
    {
        return None;
    }
    let x0 = u.floor() as u32;
    let y0 = v.floor() as u32;
    let dx = u - f64::from(x0);
    let dy = v - f64::from(y0);
    let mut result = [0.0_f64; 3];
    for (x, wx) in [(x0, 1.0 - dx), (x0 + 1, dx)] {
        for (y, wy) in [(y0, 1.0 - dy), (y0 + 1, dy)] {
            let pixel = image.get_pixel(x, y).0;
            for channel in 0..3 {
                result[channel] += f64::from(pixel[channel]) * wx * wy;
            }
        }
    }
    Some(result)
}

fn fill_single_pixel_holes(bytes: &mut [u8]) {
    let source = bytes.to_vec();
    for row in 1..TILE_SIZE - 1 {
        for column in 1..TILE_SIZE - 1 {
            let index = row * TILE_SIZE + column;
            if source[index * 4 + 3] != 0 {
                continue;
            }
            let neighbors = [index - 1, index + 1, index - TILE_SIZE, index + TILE_SIZE];
            let valid = neighbors
                .iter()
                .copied()
                .filter(|neighbor| source[neighbor * 4 + 3] == 255)
                .collect::<Vec<_>>();
            if valid.len() < 3 {
                continue;
            }
            for component in 0..3 {
                let sum = valid
                    .iter()
                    .map(|neighbor| u32::from(source[neighbor * 4 + component]))
                    .sum::<u32>();
                let count = u32::try_from(valid.len()).expect("four cardinal neighbors maximum");
                bytes[index * 4 + component] =
                    u8::try_from(sum / count).expect("mean of byte channels is a byte");
            }
            bytes[index * 4 + 3] = 255;
        }
    }
}

fn build_georeferenced_vrt(
    executable: &Path,
    png: &Path,
    vrt: &Path,
    bounds: RasterBounds,
    srs: &str,
    cancellation: &CancellationToken,
) -> Result<(), OrthophotoPreparationError> {
    let mut command = Command::new(executable);
    command
        .args([
            "-of",
            "VRT",
            "-a_srs",
            srs,
            "-a_ullr",
            &bounds.minimum_east.to_string(),
            &bounds.maximum_north.to_string(),
            &bounds.maximum_east.to_string(),
            &bounds.minimum_north.to_string(),
        ])
        .arg(external_tool_path(png))
        .arg(external_tool_path(vrt))
        .env_clear()
        .env("PROJ_NETWORK", "OFF")
        .env("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR");
    if let Some(prefix) = executable.parent().and_then(Path::parent) {
        let gdal_data = prefix.join("share/gdal");
        if gdal_data.is_dir() {
            command.env("GDAL_DATA", external_tool_path(&gdal_data));
        }
        let proj_data = prefix.join("share/proj");
        if proj_data.is_dir() {
            command.env("PROJ_DATA", external_tool_path(&proj_data));
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = process_group::spawn(&mut command)?;
    loop {
        check_cancelled(cancellation).inspect_err(|_| {
            let _ = child.terminate_and_wait();
        })?;
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(OrthophotoPreparationError::GdalFailed(status.code()));
            }
            break;
        }
        thread::sleep(PROCESS_POLL);
    }
    // GDAL 3.4 writes VRT SRS values as normalized WKT1 even when -a_srs is
    // given the frozen WKT2 text. Restore the exact audited WKT2 contract so
    // dependent raster validation cannot silently change datum semantics.
    rewrite_vrt_srs(vrt, srs)
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

fn rewrite_vrt_srs(vrt: &Path, frozen_wkt: &str) -> Result<(), OrthophotoPreparationError> {
    let text = fs::read_to_string(vrt)?;
    let open = text
        .find("<SRS")
        .ok_or_else(|| OrthophotoPreparationError::InvalidInput("VRT SRS is missing".into()))?;
    let content_start = text[open..]
        .find('>')
        .map(|offset| open + offset + 1)
        .ok_or_else(|| OrthophotoPreparationError::InvalidInput("VRT SRS is malformed".into()))?;
    let content_end = text[content_start..]
        .find("</SRS>")
        .map(|offset| content_start + offset)
        .ok_or_else(|| OrthophotoPreparationError::InvalidInput("VRT SRS is malformed".into()))?;
    let escaped = frozen_wkt
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let rewritten = format!(
        "{}{}{}",
        &text[..content_start],
        escaped,
        &text[content_end..]
    );
    let pending = vrt.with_extension("vrt.wkt2.pending");
    fs::write(&pending, rewritten)?;
    fs::rename(pending, vrt)?;
    Ok(())
}

fn tile_bounds(grid: &RasterGrid, column: u32, row: u32) -> RasterBounds {
    let span = TILE_SIZE_F64 * grid.gsd;
    let minimum_east = grid.bounds.minimum_east + f64::from(column) * span;
    let maximum_north = grid.bounds.maximum_north - f64::from(row) * span;
    RasterBounds {
        minimum_east,
        minimum_north: maximum_north - span,
        maximum_east: minimum_east + span,
        maximum_north,
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), OrthophotoPreparationError> {
    if cancellation.is_cancel_requested() {
        Err(OrthophotoPreparationError::Cancelled)
    } else {
        Ok(())
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the rounded color channel is explicitly clamped to the u8 domain"
)]
fn channel(value: f64) -> u8 {
    value.clamp(0.0, 255.0).round() as u8
}

struct CachedImage {
    pixels: RgbImage,
    mean: [f64; 3],
    bytes: usize,
}

struct ImageCache {
    entries: HashMap<String, Arc<CachedImage>>,
    order: VecDeque<String>,
    bytes: usize,
    maximum_bytes: usize,
}

impl ImageCache {
    fn new(maximum_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            maximum_bytes,
        }
    }

    fn load(
        &mut self,
        key: &str,
        path: &Path,
    ) -> Result<Arc<CachedImage>, OrthophotoPreparationError> {
        if let Some(image) = self.entries.get(key).cloned() {
            self.touch(key);
            return Ok(image);
        }
        let pixels = ImageReader::open(path)?
            .with_guessed_format()?
            .decode()?
            .to_rgb8();
        let mean = image_mean(&pixels);
        let bytes = pixels.as_raw().len();
        let image = Arc::new(CachedImage {
            pixels,
            mean,
            bytes,
        });
        self.entries.insert(key.to_owned(), Arc::clone(&image));
        self.order.push_back(key.to_owned());
        self.bytes = self.bytes.saturating_add(bytes);
        while self.bytes > self.maximum_bytes && self.order.len() > 1 {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.bytes);
            }
        }
        Ok(image)
    }

    fn touch(&mut self, key: &str) {
        if let Some(index) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(index);
        }
        self.order.push_back(key.to_owned());
    }
}

#[allow(
    clippy::cast_precision_loss,
    reason = "sampled image sums and count are far below f64's exact integer range"
)]
fn image_mean(image: &RgbImage) -> [f64; 3] {
    let mut sums = [0_u64; 3];
    let mut count = 0_u64;
    for pixel in image.pixels().step_by(16) {
        for (sum, component) in sums.iter_mut().zip(pixel.0) {
            *sum += u64::from(component);
        }
        count += 1;
    }
    if count == 0 {
        return [128.0; 3];
    }
    sums.map(|sum| sum as f64 / count as f64)
}

struct DemSampler {
    root: PathBuf,
    level: crate::raster_runtime::RasterLevelSummary,
    tiles: HashMap<(u32, u32), Arc<Vec<f32>>>,
    order: VecDeque<(u32, u32)>,
}

impl DemSampler {
    fn open(root: &Path, summary: &RasterBuildSummary) -> Result<Self, OrthophotoPreparationError> {
        let level = summary.levels.first().cloned().ok_or_else(|| {
            OrthophotoPreparationError::InvalidInput("DEM has no level zero".into())
        })?;
        Ok(Self {
            root: root.canonicalize()?,
            level,
            tiles: HashMap::new(),
            order: VecDeque::new(),
        })
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "finite non-negative DEM pixel coordinates are range-checked against u32 tiles"
    )]
    fn sample(&mut self, east: f64, north: f64) -> Result<f32, OrthophotoPreparationError> {
        let x = ((east - self.level.bounds.minimum_east) / self.level.gsd).floor();
        let y = ((self.level.bounds.maximum_north - north) / self.level.gsd).floor();
        if x < 0.0 || y < 0.0 {
            return Ok(f32::NAN);
        }
        let pixel_x = x as u64;
        let pixel_y = y as u64;
        let tile_x = u32::try_from(pixel_x / TILE_SIZE_U64)
            .map_err(|_| OrthophotoPreparationError::InvalidInput("DEM x index overflow".into()))?;
        let tile_y = u32::try_from(pixel_y / TILE_SIZE_U64)
            .map_err(|_| OrthophotoPreparationError::InvalidInput("DEM y index overflow".into()))?;
        if tile_x >= self.level.columns || tile_y >= self.level.rows {
            return Ok(f32::NAN);
        }
        let tile = self.load_tile(tile_x, tile_y)?;
        let local_x = usize::try_from(pixel_x % TILE_SIZE_U64).expect("tile coordinate bounded");
        let local_y = usize::try_from(pixel_y % TILE_SIZE_U64).expect("tile coordinate bounded");
        Ok(tile[local_y * TILE_SIZE + local_x])
    }

    fn load_tile(
        &mut self,
        column: u32,
        row: u32,
    ) -> Result<Arc<Vec<f32>>, OrthophotoPreparationError> {
        let key = (column, row);
        if let Some(tile) = self.tiles.get(&key).cloned() {
            self.touch(key);
            return Ok(tile);
        }
        let path = self.root.join(format!(
            "view/height/L{:02}/{column}/{row}.f32",
            self.level.level
        ));
        let bytes = fs::read(path)?;
        if bytes.len() != TILE_SIZE * TILE_SIZE * 4 {
            return Err(OrthophotoPreparationError::InvalidInput(
                "DEM tile is not a 512x512 Float32 tile".into(),
            ));
        }
        let values = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("fixed slice")))
            .collect::<Vec<_>>();
        let tile = Arc::new(values);
        self.tiles.insert(key, Arc::clone(&tile));
        self.order.push_back(key);
        while self.order.len() > 16 {
            if let Some(oldest) = self.order.pop_front() {
                self.tiles.remove(&oldest);
            }
        }
        Ok(tile)
    }

    fn touch(&mut self, key: (u32, u32)) {
        if let Some(index) = self.order.iter().position(|candidate| *candidate == key) {
            self.order.remove(index);
        }
        self.order.push_back(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn gdal_vrt_paths_strip_windows_verbatim_prefixes() {
        assert_eq!(
            external_tool_path(Path::new(r"\\?\C:\project\tile.png")),
            std::ffi::OsString::from(r"C:\project\tile.png")
        );
        assert_eq!(
            external_tool_path(Path::new(r"\\?\UNC\server\share\tile.png")),
            std::ffi::OsString::from(r"\\server\share\tile.png")
        );
    }
    use image::Rgb;

    fn camera() -> MvsPinholeCamera {
        MvsPinholeCamera {
            fx: 100.0,
            fy: 100.0,
            cx: 50.0,
            cy: 40.0,
            world_to_camera: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        }
    }

    #[test]
    fn projection_uses_world_to_camera_and_positive_depth() {
        let (u, v, quality) = project(&camera(), [1.0, 2.0, 10.0]).expect("visible point");
        assert!((u - 60.0).abs() < 1e-9);
        assert!((v - 60.0).abs() < 1e-9);
        assert!(quality > 0.8);
        assert!(project(&camera(), [0.0, 0.0, -1.0]).is_none());
    }

    #[test]
    fn bilinear_sampling_interpolates_all_channels() {
        let mut image = RgbImage::new(2, 2);
        image.put_pixel(0, 0, Rgb([0, 0, 0]));
        image.put_pixel(1, 0, Rgb([100, 0, 0]));
        image.put_pixel(0, 1, Rgb([0, 100, 0]));
        image.put_pixel(1, 1, Rgb([100, 100, 200]));
        let sample = bilinear(&image, 0.5, 0.5).expect("interior sample");
        assert!((sample[0] - 50.0).abs() < 1e-5);
        assert!((sample[1] - 50.0).abs() < 1e-5);
        assert!((sample[2] - 50.0).abs() < 1e-5);
    }

    #[test]
    fn hole_fill_requires_three_valid_cardinal_neighbors() {
        let mut bytes = vec![0_u8; TILE_SIZE * TILE_SIZE * 4];
        let center = 10 * TILE_SIZE + 10;
        for neighbor in [center - 1, center + 1, center - TILE_SIZE] {
            bytes[neighbor * 4..neighbor * 4 + 4].copy_from_slice(&[30, 60, 90, 255]);
        }
        fill_single_pixel_holes(&mut bytes);
        assert_eq!(&bytes[center * 4..center * 4 + 4], &[30, 60, 90, 255]);
    }

    #[test]
    fn a_fully_transparent_orthomosaic_is_rejected() {
        assert!(validate_coverage(0).is_err());
        assert!(validate_coverage(1).is_ok());
    }

    #[test]
    fn vrt_rewrite_preserves_the_exact_frozen_wkt_as_xml_text() {
        let path = std::env::temp_dir().join(format!("hcad-ortho-wkt-{}.vrt", std::process::id()));
        fs::write(
            &path,
            "<VRTDataset><SRS dataAxisToSRSAxisMapping=\"1,2\">old</SRS></VRTDataset>",
        )
        .unwrap();
        rewrite_vrt_srs(&path, "PROJCRS[\"A & B\",ID[\"EPSG\",1]]").unwrap();
        let result = fs::read_to_string(&path).unwrap();
        assert!(result.contains("PROJCRS[\"A &amp; B\",ID[\"EPSG\",1]]"));
        assert!(!result.contains(">old</SRS>"));
        fs::remove_file(path).unwrap();
    }
}
