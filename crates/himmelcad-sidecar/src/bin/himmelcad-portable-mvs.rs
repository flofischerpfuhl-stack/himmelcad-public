//! Deterministic, tiled CPU reference worker for Photolab depth maps and dense fusion.

#![forbid(unsafe_code)]

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread,
};

use himmelcad_core::hash::ObjectHash;
use himmelcad_sidecar::mvs_runtime::{
    MvsCheckpoint, MvsComputeDevice, MvsDenseFusionEvidence, MvsDepthImageRecord, MvsDepthTileKey,
    MvsDepthTileRecord, MvsOutputIndex, MvsPinholeCamera, MvsSceneImage, MvsSceneManifest,
    MvsSettings, MvsWorkerRequest, MVS_DENSE_FUSION_ALGORITHM,
};
use image::{imageops::FilterType, GrayImage, Luma, RgbImage};
use serde::Serialize;
use sha2::{Digest, Sha256};

const VERSION: &str = "1.0.0";
const DEPTH_MAGIC: &[u8; 8] = b"HCDEPTH1";

#[path = "himmelcad_portable_mvs/fusion.rs"]
mod fusion;

fn main() {
    if let Err(error) = real_main() {
        event(&WorkerEvent::Log {
            level: "error",
            message: error.to_string(),
        });
        std::process::exit(1);
    }
}

fn real_main() -> Result<(), WorkerError> {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["--version"] {
        println!("himmelcad-portable-mvs {VERSION}");
        return Ok(());
    }
    if arguments.len() != 3 || arguments[0] != "run" || arguments[1] != "--request" {
        return Err(WorkerError::InvalidInput(
            "usage: himmelcad-portable-mvs run --request <request.json>".into(),
        ));
    }
    let request_path = PathBuf::from(&arguments[2]);
    let request: MvsWorkerRequest = serde_json::from_slice(&fs::read(request_path)?)?;
    validate_request(&request)?;
    let scene: MvsSceneManifest = serde_json::from_slice(&fs::read(&request.scene_manifest_path)?)?;
    let scene_root = request
        .scene_manifest_path
        .parent()
        .ok_or_else(|| WorkerError::InvalidInput("scene manifest has no parent".into()))?;
    fs::create_dir_all(&request.output_path)?;
    fs::create_dir_all(&request.checkpoint_path)?;
    let cancellation = Arc::new(AtomicBool::new(false));
    listen_for_cancel(cancellation.clone());
    run_cpu(&request, &scene, scene_root, &cancellation)
}

fn validate_request(request: &MvsWorkerRequest) -> Result<(), WorkerError> {
    if request.schema_version != 1 || request.network_policy != "offlineOnly" {
        return Err(WorkerError::InvalidInput(
            "unsupported request schema or network policy".into(),
        ));
    }
    if !matches!(request.device, MvsComputeDevice::Cpu { .. }) {
        return Err(WorkerError::InvalidInput(
            "this release is the CPU reference worker; GPU capability was not advertised".into(),
        ));
    }
    Ok(())
}

fn run_cpu(
    request: &MvsWorkerRequest,
    scene: &MvsSceneManifest,
    scene_root: &Path,
    cancellation: &AtomicBool,
) -> Result<(), WorkerError> {
    let worker_threads = match request.device {
        MvsComputeDevice::Cpu { threads } => usize::from(threads),
        _ => 1,
    };
    let image_lookup = scene
        .images
        .iter()
        .map(|image| (image.image_id.as_str(), image))
        .collect::<BTreeMap<_, _>>();
    let tile_total = scene
        .images
        .iter()
        .map(|image| count_tiles(image, &request.settings))
        .sum::<u64>();
    let raw_root = request.output_path.join("raw");
    let tile_root = request.output_path.join("depth");
    fs::create_dir_all(&raw_root)?;
    fs::create_dir_all(&tile_root)?;
    let mut checkpoint_keys = resume_keys(request)?;
    let mut depth_images = Vec::with_capacity(scene.images.len());
    let mut completed_tiles = u64::try_from(checkpoint_keys.len())
        .unwrap_or(u64::MAX)
        .min(tile_total);

    for image in &scene.images {
        check_cancel(cancellation)?;
        let reference =
            load_depth_view(scene_root, image, request.settings.maximum_image_dimension)?;
        let expected_keys = tile_keys_for_image(
            &image.image_id,
            reference.gray.width(),
            reference.gray.height(),
            &request.settings,
        );
        let raw_path = raw_root.join(format!("{}.raw", image.image_id));
        if expected_keys
            .iter()
            .all(|key| checkpoint_keys.contains(key))
            && raw_path.is_file()
        {
            validate_raw_depth_dimensions(
                &raw_path,
                reference.gray.width(),
                reference.gray.height(),
            )?;
            let records =
                read_existing_tile_records(&tile_root, &request.output_path, &expected_keys)?;
            event(&WorkerEvent::Progress {
                stage: "depthEstimation",
                completed_units: completed_tiles,
                total_units: tile_total,
                completed_bytes: 0,
            });
            depth_images.push(MvsDepthImageRecord {
                image_id: image.image_id.clone(),
                width: image.width,
                height: image.height,
                camera: image.camera.clone(),
                tiles: records,
            });
            continue;
        }
        let neighbor_images = image
            .neighbor_image_ids
            .iter()
            .take(usize::from(request.settings.matching_views))
            .map(|id| {
                image_lookup
                    .get(id.as_str())
                    .copied()
                    .ok_or_else(|| WorkerError::InvalidInput(format!("unknown neighbor {id}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut neighbors = Vec::with_capacity(neighbor_images.len());
        for neighbor in neighbor_images {
            neighbors.push(load_depth_view(
                scene_root,
                neighbor,
                request.settings.maximum_image_dimension,
            )?);
        }
        let mut records = estimate_image_pyramid(
            &reference,
            &neighbors,
            image,
            &request.settings,
            &tile_root,
            &raw_path,
            worker_threads,
            cancellation,
            |key| {
                if checkpoint_keys.insert(key) {
                    completed_tiles += 1;
                }
                event(&WorkerEvent::Progress {
                    stage: "depthEstimation",
                    completed_units: completed_tiles,
                    total_units: tile_total,
                    completed_bytes: 0,
                });
                if completed_tiles % u64::from(request.settings.checkpoint_every_tiles) == 0 {
                    write_checkpoint(request, &checkpoint_keys, completed_tiles, false)?;
                }
                Ok(())
            },
        )?;
        records.sort_by(|left, right| left.key.cmp(&right.key));
        depth_images.push(MvsDepthImageRecord {
            image_id: image.image_id.clone(),
            width: image.width,
            height: image.height,
            camera: image.camera.clone(),
            tiles: records,
        });
    }

    if request.resume_geometric_consistency_complete {
        for completed in 1..=scene.images.len() {
            event(&WorkerEvent::Progress {
                stage: "geometricConsistency",
                completed_units: completed as u64,
                total_units: scene.images.len() as u64,
                completed_bytes: 0,
            });
        }
    } else {
        geometric_consistency(
            request,
            scene,
            &image_lookup,
            &raw_root,
            &tile_root,
            &mut depth_images,
            worker_threads,
            cancellation,
        )?;
    }
    let dense_point_cloud = if request.fuse_dense_point_cloud {
        event(&WorkerEvent::Progress {
            stage: "denseFusion",
            completed_units: 0,
            total_units: scene.images.len() as u64,
            completed_bytes: 0,
        });
        Some(fuse_dense_cloud(
            request,
            scene,
            scene_root,
            &raw_root,
            &checkpoint_keys,
            completed_tiles,
            cancellation,
        )?)
    } else {
        None
    };
    let output = MvsOutputIndex {
        schema_version: 1,
        job_id: request.job_id.clone(),
        scene_manifest_sha256: request.scene_manifest_sha256.clone(),
        settings_sha256: request.settings_sha256.clone(),
        device: request.device.clone(),
        depth_images,
        dense_point_cloud,
    };
    atomic_json(&request.output_path.join("index.json"), &output)?;
    write_checkpoint(request, &checkpoint_keys, completed_tiles, true)?;
    Ok(())
}

#[derive(Clone)]
struct LoadedView {
    gray: GrayImage,
    rgb: RgbImage,
    /// 255 means usable; zero means excluded by the immutable source-image mask.
    mask: GrayImage,
    camera: MvsPinholeCamera,
}

#[derive(Clone)]
struct DepthBuffer {
    width: u32,
    height: u32,
    depth: Vec<f32>,
    confidence: Vec<f32>,
}

fn load_view(root: &Path, image: &MvsSceneImage, maximum: u32) -> Result<LoadedView, WorkerError> {
    let decoded = image::open(root.join(&image.relative_path))?;
    let scale = f64::from(maximum) / f64::from(image.width.max(image.height));
    let scale = scale.min(1.0);
    let width = (f64::from(image.width) * scale).round().max(1.0) as u32;
    let height = (f64::from(image.height) * scale).round().max(1.0) as u32;
    let rgb = decoded
        .resize_exact(width, height, FilterType::Lanczos3)
        .to_rgb8();
    let gray = image::DynamicImage::ImageRgb8(rgb.clone()).to_luma8();
    let mask = load_keep_mask(root, image, width, height)?;
    Ok(LoadedView {
        gray,
        rgb,
        mask,
        camera: scaled_camera(&image.camera, scale),
    })
}

fn load_depth_view(
    root: &Path,
    image: &MvsSceneImage,
    maximum: u32,
) -> Result<LoadedView, WorkerError> {
    let decoded = image::open(root.join(&image.relative_path))?;
    let scale = (f64::from(maximum) / f64::from(image.width.max(image.height))).min(1.0);
    let width = (f64::from(image.width) * scale).round().max(1.0) as u32;
    let height = (f64::from(image.height) * scale).round().max(1.0) as u32;
    let gray = decoded
        .resize_exact(width, height, FilterType::Lanczos3)
        .to_luma8();
    let mask = load_keep_mask(root, image, width, height)?;
    Ok(LoadedView {
        gray,
        rgb: RgbImage::new(1, 1),
        mask,
        camera: scaled_camera(&image.camera, scale),
    })
}

fn load_keep_mask(
    root: &Path,
    image: &MvsSceneImage,
    width: u32,
    height: u32,
) -> Result<GrayImage, WorkerError> {
    let Some(relative_path) = &image.mask_relative_path else {
        return Ok(GrayImage::from_pixel(width, height, Luma([255])));
    };
    let decoded = image::open(root.join(relative_path))?.to_luma8();
    if decoded.dimensions() != (image.width, image.height) {
        return Err(WorkerError::InvalidInput(format!(
            "keep mask dimensions differ from scene image {}",
            image.image_id
        )));
    }
    Ok(image::imageops::resize(
        &decoded,
        width,
        height,
        FilterType::Nearest,
    ))
}

fn scaled_camera(camera: &MvsPinholeCamera, scale: f64) -> MvsPinholeCamera {
    MvsPinholeCamera {
        fx: camera.fx * scale,
        fy: camera.fy * scale,
        cx: camera.cx * scale,
        cy: camera.cy * scale,
        world_to_camera: camera.world_to_camera,
    }
}

fn estimate_image_pyramid(
    reference: &LoadedView,
    neighbors: &[LoadedView],
    scene_image: &MvsSceneImage,
    settings: &MvsSettings,
    tile_root: &Path,
    raw_path: &Path,
    worker_threads: usize,
    cancellation: &AtomicBool,
    mut on_tile: impl FnMut(MvsDepthTileKey) -> Result<(), WorkerError>,
) -> Result<Vec<MvsDepthTileRecord>, WorkerError> {
    let mut previous: Option<DepthBuffer> = None;
    let mut records = Vec::new();
    for level in (0..settings.pyramid_levels).rev() {
        check_cancel(cancellation)?;
        let divisor = 1_u32 << u32::from(level);
        let width = reference.gray.width().div_ceil(divisor).max(1);
        let height = reference.gray.height().div_ceil(divisor).max(1);
        let reference_gray =
            image::imageops::resize(&reference.gray, width, height, FilterType::Triangle);
        let reference_mask =
            image::imageops::resize(&reference.mask, width, height, FilterType::Nearest);
        let camera = scaled_camera(&reference.camera, 1.0 / f64::from(divisor));
        let neighbor_levels = neighbors
            .iter()
            .map(|neighbor| LoadedLevel {
                gray: image::imageops::resize(
                    &neighbor.gray,
                    neighbor.gray.width().div_ceil(divisor).max(1),
                    neighbor.gray.height().div_ceil(divisor).max(1),
                    FilterType::Triangle,
                ),
                mask: image::imageops::resize(
                    &neighbor.mask,
                    neighbor.mask.width().div_ceil(divisor).max(1),
                    neighbor.mask.height().div_ceil(divisor).max(1),
                    FilterType::Nearest,
                ),
                camera: scaled_camera(&neighbor.camera, 1.0 / f64::from(divisor)),
            })
            .collect::<Vec<_>>();
        if level == 0 {
            let mut level_records = estimate_finest_level_tiled(
                &reference_gray,
                &reference_mask,
                &camera,
                &neighbor_levels,
                scene_image.minimum_depth as f32,
                scene_image.maximum_depth as f32,
                settings,
                previous.as_ref(),
                tile_root,
                &scene_image.image_id,
                raw_path,
                worker_threads,
                cancellation,
            )?;
            for record in &level_records {
                on_tile(record.key.clone())?;
            }
            records.append(&mut level_records);
            break;
        }
        let buffer = estimate_level(
            &reference_gray,
            &reference_mask,
            &camera,
            &neighbor_levels,
            scene_image.minimum_depth as f32,
            scene_image.maximum_depth as f32,
            settings,
            previous.as_ref(),
            worker_threads,
            cancellation,
        )?;
        let mut level_records = write_tiles(
            tile_root,
            &scene_image.image_id,
            level,
            &buffer,
            settings.tile_size,
        )?;
        for record in &level_records {
            on_tile(record.key.clone())?;
        }
        records.append(&mut level_records);
        previous = Some(buffer);
    }
    Ok(records)
}

#[allow(clippy::too_many_arguments)]
fn estimate_finest_level_tiled(
    reference: &GrayImage,
    reference_mask: &GrayImage,
    reference_camera: &MvsPinholeCamera,
    neighbors: &[LoadedLevel],
    minimum_depth: f32,
    maximum_depth: f32,
    settings: &MvsSettings,
    previous: Option<&DepthBuffer>,
    tile_root: &Path,
    image_id: &str,
    raw_path: &Path,
    worker_threads: usize,
    cancellation: &AtomicBool,
) -> Result<Vec<MvsDepthTileRecord>, WorkerError> {
    let temporary_raw = raw_path.with_extension("raw.pending");
    let mut raw = File::create(&temporary_raw)?;
    raw.write_all(b"HCRAWDP1")?;
    raw.write_all(&reference.width().to_le_bytes())?;
    raw.write_all(&reference.height().to_le_bytes())?;
    let payload_bytes = u64::from(reference.width())
        .checked_mul(u64::from(reference.height()))
        .and_then(|pixels| pixels.checked_mul(8))
        .ok_or_else(|| WorkerError::InvalidInput("raw depth size overflow".into()))?;
    raw.set_len(16_u64.saturating_add(payload_bytes))?;
    let tiles_x = reference.width().div_ceil(settings.tile_size);
    let tiles_y = reference.height().div_ceil(settings.tile_size);
    let mut records = Vec::with_capacity((tiles_x * tiles_y) as usize);
    let jobs = (0..tiles_y)
        .flat_map(|tile_y| (0..tiles_x).map(move |tile_x| (tile_x, tile_y)))
        .collect::<Vec<_>>();
    // A portrait/landscape image commonly has only two 512 px tiles along its
    // long edge. Splitting work only at tile boundaries left half of a
    // four-core CPU idle for the dominant finest level.
    let parallelize_inside_tiles = jobs.len() < worker_threads.max(1);
    let workers = if parallelize_inside_tiles {
        1
    } else {
        worker_threads.max(1).min(jobs.len().max(1))
    };
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let (sender, receiver) = mpsc::sync_channel(workers.saturating_mul(2).max(1));
    let mut first_error = None;
    thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let jobs = &jobs;
            let next = &next;
            let failed = &failed;
            scope.spawn(move || {
                while !failed.load(Ordering::Acquire) {
                    let job_index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&(tile_x, tile_y)) = jobs.get(job_index) else {
                        break;
                    };
                    let start_x = tile_x * settings.tile_size;
                    let start_y = tile_y * settings.tile_size;
                    let width = settings.tile_size.min(reference.width() - start_x);
                    let height = settings.tile_size.min(reference.height() - start_y);
                    let result = if parallelize_inside_tiles {
                        estimate_level_region_parallel(
                            reference,
                            reference_mask,
                            reference_camera,
                            neighbors,
                            minimum_depth,
                            maximum_depth,
                            settings,
                            previous,
                            start_x,
                            start_y,
                            width,
                            height,
                            worker_threads,
                            cancellation,
                        )
                    } else {
                        estimate_level_region(
                            reference,
                            reference_mask,
                            reference_camera,
                            neighbors,
                            minimum_depth,
                            maximum_depth,
                            settings,
                            previous,
                            start_x,
                            start_y,
                            width,
                            height,
                            cancellation,
                        )
                    };
                    let is_error = result.is_err();
                    if sender
                        .send((tile_x, tile_y, width, height, result))
                        .is_err()
                    {
                        break;
                    }
                    if is_error {
                        failed.store(true, Ordering::Release);
                    }
                }
            });
        }
        drop(sender);
        while let Ok((tile_x, tile_y, width, height, result)) = receiver.recv() {
            match result {
                Ok(buffer) if first_error.is_none() => {
                    let start_x = tile_x * settings.tile_size;
                    let start_y = tile_y * settings.tile_size;
                    match write_tile_region(
                        tile_root, image_id, 0, tile_x, tile_y, &buffer, 0, 0, width, height,
                    )
                    .and_then(|record| {
                        write_raw_region(&mut raw, reference.width(), start_x, start_y, &buffer)?;
                        Ok(record)
                    }) {
                        Ok(record) => records.push(record),
                        Err(error) => {
                            failed.store(true, Ordering::Release);
                            first_error = Some(error);
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
    });
    if let Some(error) = first_error {
        let _ = fs::remove_file(&temporary_raw);
        return Err(error);
    }
    records.sort_by(|left, right| left.key.cmp(&right.key));
    raw.sync_all()?;
    drop(raw);
    if raw_path.exists() {
        fs::remove_file(raw_path)?;
    }
    fs::rename(temporary_raw, raw_path)?;
    Ok(records)
}

fn write_raw_region(
    file: &mut File,
    full_width: u32,
    start_x: u32,
    start_y: u32,
    buffer: &DepthBuffer,
) -> Result<(), WorkerError> {
    let row_bytes = usize::try_from(u64::from(buffer.width) * 8)
        .map_err(|_| WorkerError::InvalidInput("raw depth row is too wide".into()))?;
    let mut row = Vec::with_capacity(row_bytes);
    for y in 0..buffer.height {
        row.clear();
        for x in 0..buffer.width {
            let offset = index(buffer.width, x, y);
            row.extend_from_slice(&buffer.depth[offset].to_le_bytes());
            row.extend_from_slice(&buffer.confidence[offset].to_le_bytes());
        }
        let pixel_offset = u64::from(start_y + y)
            .checked_mul(u64::from(full_width))
            .and_then(|value| value.checked_add(u64::from(start_x)))
            .ok_or_else(|| WorkerError::InvalidInput("raw depth offset overflow".into()))?;
        file.seek(SeekFrom::Start(16 + pixel_offset * 8))?;
        file.write_all(&row)?;
    }
    Ok(())
}

struct LoadedLevel {
    gray: GrayImage,
    mask: GrayImage,
    camera: MvsPinholeCamera,
}

struct PreparedNeighbor<'a> {
    gray: &'a GrayImage,
    mask: &'a GrayImage,
    projection: PlaneProjection,
}

#[derive(Clone, Copy)]
struct PlaneProjection {
    x: ProjectionRow,
    y: ProjectionRow,
    z: ProjectionRow,
}

#[derive(Clone, Copy)]
struct ProjectionRow {
    pixel_x: f64,
    pixel_y: f64,
    constant: f64,
    inverse_depth: f64,
}

impl PlaneProjection {
    fn between(reference: &MvsPinholeCamera, source: &MvsPinholeCamera) -> Self {
        let reference_matrix = &reference.world_to_camera;
        let source_matrix = &source.world_to_camera;
        let mut relative_rotation = [[0.0_f64; 3]; 3];
        for row in 0..3 {
            for column in 0..3 {
                relative_rotation[row][column] = (0..3)
                    .map(|axis| source_matrix[row * 4 + axis] * reference_matrix[column * 4 + axis])
                    .sum();
            }
        }
        let reference_translation = [
            reference_matrix[3],
            reference_matrix[7],
            reference_matrix[11],
        ];
        let source_translation = [source_matrix[3], source_matrix[7], source_matrix[11]];
        let mut relative_translation = source_translation;
        for row in 0..3 {
            relative_translation[row] -= (0..3)
                .map(|axis| relative_rotation[row][axis] * reference_translation[axis])
                .sum::<f64>();
        }

        let camera_row = |row: usize| ProjectionRow {
            pixel_x: relative_rotation[row][0] / reference.fx,
            pixel_y: relative_rotation[row][1] / reference.fy,
            constant: relative_rotation[row][2]
                - relative_rotation[row][0] * reference.cx / reference.fx
                - relative_rotation[row][1] * reference.cy / reference.fy,
            inverse_depth: relative_translation[row],
        };
        let camera_x = camera_row(0);
        let camera_y = camera_row(1);
        let camera_z = camera_row(2);
        Self {
            x: camera_x.scaled(source.fx).plus(camera_z.scaled(source.cx)),
            y: camera_y.scaled(source.fy).plus(camera_z.scaled(source.cy)),
            z: camera_z,
        }
    }
}

impl ProjectionRow {
    fn scaled(self, factor: f64) -> Self {
        Self {
            pixel_x: self.pixel_x * factor,
            pixel_y: self.pixel_y * factor,
            constant: self.constant * factor,
            inverse_depth: self.inverse_depth * factor,
        }
    }

    fn plus(self, other: Self) -> Self {
        Self {
            pixel_x: self.pixel_x + other.pixel_x,
            pixel_y: self.pixel_y + other.pixel_y,
            constant: self.constant + other.constant,
            inverse_depth: self.inverse_depth + other.inverse_depth,
        }
    }

    fn at(self, x: f64, y: f64, inverse_depth: f64) -> f64 {
        self.pixel_x * x + self.pixel_y * y + self.constant + self.inverse_depth * inverse_depth
    }
}

struct ReferencePatch {
    count: f32,
    sum: f32,
    variance: f32,
    values: [f32; 289],
}

fn estimate_level(
    reference: &GrayImage,
    reference_mask: &GrayImage,
    reference_camera: &MvsPinholeCamera,
    neighbors: &[LoadedLevel],
    minimum_depth: f32,
    maximum_depth: f32,
    settings: &MvsSettings,
    previous: Option<&DepthBuffer>,
    worker_threads: usize,
    cancellation: &AtomicBool,
) -> Result<DepthBuffer, WorkerError> {
    estimate_level_region_parallel(
        reference,
        reference_mask,
        reference_camera,
        neighbors,
        minimum_depth,
        maximum_depth,
        settings,
        previous,
        0,
        0,
        reference.width(),
        reference.height(),
        worker_threads,
        cancellation,
    )
}

#[allow(clippy::too_many_arguments)]
fn estimate_level_region_parallel(
    reference: &GrayImage,
    reference_mask: &GrayImage,
    reference_camera: &MvsPinholeCamera,
    neighbors: &[LoadedLevel],
    minimum_depth: f32,
    maximum_depth: f32,
    settings: &MvsSettings,
    previous: Option<&DepthBuffer>,
    start_x: u32,
    start_y: u32,
    width: u32,
    height: u32,
    worker_threads: usize,
    cancellation: &AtomicBool,
) -> Result<DepthBuffer, WorkerError> {
    let workers = worker_threads.max(1).min(height as usize);
    if workers == 1 {
        return estimate_level_region(
            reference,
            reference_mask,
            reference_camera,
            neighbors,
            minimum_depth,
            maximum_depth,
            settings,
            previous,
            start_x,
            start_y,
            width,
            height,
            cancellation,
        );
    }
    let rows_per_worker = height.div_ceil(workers as u32);
    let (sender, receiver) = mpsc::sync_channel(workers);
    thread::scope(|scope| {
        for worker in 0..workers {
            let local_start = (worker as u32).saturating_mul(rows_per_worker);
            if local_start >= height {
                continue;
            }
            let band_height = rows_per_worker.min(height - local_start);
            let sender = sender.clone();
            scope.spawn(move || {
                let result = estimate_level_region(
                    reference,
                    reference_mask,
                    reference_camera,
                    neighbors,
                    minimum_depth,
                    maximum_depth,
                    settings,
                    previous,
                    start_x,
                    start_y + local_start,
                    width,
                    band_height,
                    cancellation,
                );
                let _ = sender.send((local_start, result));
            });
        }
        drop(sender);
        let pixel_count = usize::try_from(u64::from(width) * u64::from(height))
            .map_err(|_| WorkerError::InvalidInput("image is too large".into()))?;
        let mut output = DepthBuffer {
            width,
            height,
            depth: vec![0.0; pixel_count],
            confidence: vec![0.0; pixel_count],
        };
        for (local_start, result) in receiver {
            let band = result?;
            let destination = usize::try_from(u64::from(local_start) * u64::from(width))
                .map_err(|_| WorkerError::InvalidInput("image row offset overflow".into()))?;
            output.depth[destination..destination + band.depth.len()].copy_from_slice(&band.depth);
            output.confidence[destination..destination + band.confidence.len()]
                .copy_from_slice(&band.confidence);
        }
        Ok(output)
    })
}

#[allow(clippy::too_many_arguments)]
fn estimate_level_region(
    reference: &GrayImage,
    reference_mask: &GrayImage,
    reference_camera: &MvsPinholeCamera,
    neighbors: &[LoadedLevel],
    minimum_depth: f32,
    maximum_depth: f32,
    settings: &MvsSettings,
    previous: Option<&DepthBuffer>,
    start_x: u32,
    start_y: u32,
    width: u32,
    height: u32,
    cancellation: &AtomicBool,
) -> Result<DepthBuffer, WorkerError> {
    let pixel_count = usize::try_from(u64::from(width) * u64::from(height))
        .map_err(|_| WorkerError::InvalidInput("image is too large".into()))?;
    let mut depth = vec![0.0_f32; pixel_count];
    let mut confidence = vec![0.0_f32; pixel_count];
    let inverse_near = 1.0 / minimum_depth;
    let inverse_far = 1.0 / maximum_depth;
    let full_step = (inverse_near - inverse_far) / f32::from(settings.depth_hypotheses.max(2) - 1);
    let radius = i32::from(settings.patch_radius);
    let prepared_neighbors = neighbors
        .iter()
        .map(|neighbor| PreparedNeighbor {
            gray: &neighbor.gray,
            mask: &neighbor.mask,
            projection: PlaneProjection::between(reference_camera, &neighbor.camera),
        })
        .collect::<Vec<_>>();
    for local_y in 0..height {
        check_cancel(cancellation)?;
        let y = start_y + local_y;
        for local_x in 0..width {
            if local_x % 32 == 0 {
                check_cancel(cancellation)?;
            }
            let x = start_x + local_x;
            if x < settings.patch_radius.into()
                || y < settings.patch_radius.into()
                || x + u32::from(settings.patch_radius) >= reference.width()
                || y + u32::from(settings.patch_radius) >= reference.height()
            {
                continue;
            }
            if !patch_is_unmasked(reference_mask, x, y, radius) {
                continue;
            }
            let patch = reference_patch(reference, x, y, radius);
            let prior = previous.and_then(|coarse| {
                let px = (x / 2).min(coarse.width.saturating_sub(1));
                let py = (y / 2).min(coarse.height.saturating_sub(1));
                let value = coarse.depth[index(coarse.width, px, py)];
                (value > 0.0).then_some(value)
            });
            let mut best_depth = 0.0;
            let mut best_score = -1.0_f32;
            let mut second_score = -1.0_f32;
            if let Some(prior) = prior {
                let center = 1.0 / prior;
                let span = full_step * 4.0;
                evaluate_candidates(
                    &prepared_neighbors,
                    x,
                    y,
                    radius,
                    &patch,
                    (0..9).map(|sample| {
                        let offset = (sample as f32 - 4.0) / 4.0;
                        1.0 / (center + span * offset).clamp(inverse_far, inverse_near)
                    }),
                    &mut best_depth,
                    &mut best_score,
                    &mut second_score,
                );
            } else {
                evaluate_candidates(
                    &prepared_neighbors,
                    x,
                    y,
                    radius,
                    &patch,
                    (0..settings.depth_hypotheses)
                        .map(|sample| 1.0 / (inverse_far + full_step * f32::from(sample))),
                    &mut best_depth,
                    &mut best_score,
                    &mut second_score,
                );
            }
            let mut span = full_step * 2.0;
            for _ in 0..settings.patchmatch_iterations {
                if best_depth <= 0.0 {
                    break;
                }
                let center = 1.0 / best_depth;
                evaluate_candidates(
                    &prepared_neighbors,
                    x,
                    y,
                    radius,
                    &patch,
                    [-2, -1, 1, 2].into_iter().map(|offset| {
                        1.0 / (center + span * offset as f32 / 2.0).clamp(inverse_far, inverse_near)
                    }),
                    &mut best_depth,
                    &mut best_score,
                    &mut second_score,
                );
                span *= 0.5;
            }
            let score_confidence = ((best_score + 1.0) * 0.5).clamp(0.0, 1.0);
            let separation = ((best_score - second_score) * 0.5).clamp(0.0, 1.0);
            let value_confidence = score_confidence * (0.5 + 0.5 * separation);
            if value_confidence >= settings.minimum_confidence {
                let offset = index(width, local_x, local_y);
                depth[offset] = best_depth;
                confidence[offset] = value_confidence;
            }
        }
    }
    Ok(DepthBuffer {
        width,
        height,
        depth,
        confidence,
    })
}

#[allow(clippy::too_many_arguments)]
fn evaluate_candidates(
    neighbors: &[PreparedNeighbor<'_>],
    x: u32,
    y: u32,
    radius: i32,
    reference_patch: &ReferencePatch,
    candidates: impl Iterator<Item = f32>,
    best_depth: &mut f32,
    best_score: &mut f32,
    second_score: &mut f32,
) {
    for candidate in candidates {
        if !candidate.is_finite() || candidate <= 0.0 {
            continue;
        }
        let mut scores = [-1.0_f32; 4];
        let mut score_count = 0_usize;
        for score in neighbors.iter().filter_map(|neighbor| {
            ncc_score_prepared(neighbor, x, y, candidate, radius, reference_patch)
        }) {
            let occupied = score_count.min(4);
            let insert_at = scores[..occupied]
                .iter()
                .position(|current| score > *current)
                .unwrap_or(occupied);
            if insert_at < 4 {
                for index in (insert_at + 1..4).rev() {
                    scores[index] = scores[index - 1];
                }
                scores[insert_at] = score;
            }
            score_count += 1;
        }
        if score_count < 2 {
            continue;
        }
        let keep = score_count.min(4);
        let score = scores[..keep].iter().sum::<f32>() / keep as f32;
        if score > *best_score {
            *second_score = *best_score;
            *best_score = score;
            *best_depth = candidate;
        } else if score > *second_score {
            *second_score = score;
        }
    }
}

fn reference_patch(reference: &GrayImage, x: u32, y: u32, radius: i32) -> ReferencePatch {
    let width = reference.width() as usize;
    let pixels = reference.as_raw();
    let mut count = 0_u32;
    let mut sum = 0.0_f32;
    let mut sum_squares = 0.0_f32;
    let mut values = [0.0_f32; 289];
    for dy in -radius..=radius {
        let row =
            usize::try_from(i64::from(y) + i64::from(dy)).expect("patch is in bounds") * width;
        for dx in -radius..=radius {
            let column = usize::try_from(i64::from(x) + i64::from(dx)).expect("patch is in bounds");
            let value = f32::from(pixels[row + column]) / 255.0;
            values[count as usize] = value;
            count += 1;
            sum += value;
            sum_squares += value * value;
        }
    }
    let count = count as f32;
    ReferencePatch {
        count,
        sum,
        variance: (sum_squares - sum * sum / count).max(0.0),
        values,
    }
}

fn patch_is_unmasked(mask: &GrayImage, x: u32, y: u32, radius: i32) -> bool {
    (-radius..=radius).all(|dy| {
        (-radius..=radius).all(|dx| {
            let px = u32::try_from(i64::from(x) + i64::from(dx)).expect("patch is in bounds");
            let py = u32::try_from(i64::from(y) + i64::from(dy)).expect("patch is in bounds");
            mask.get_pixel(px, py).0[0] != 0
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn ncc_score_prepared(
    source: &PreparedNeighbor<'_>,
    x: u32,
    y: u32,
    depth: f32,
    radius: i32,
    reference_patch: &ReferencePatch,
) -> Option<f32> {
    let source_width = source.gray.width();
    let source_height = source.gray.height();
    let inverse_depth = 1.0 / f64::from(depth);
    let start_x = f64::from(x) - f64::from(radius);
    let start_y = f64::from(y) - f64::from(radius);
    let row_start_x = source.projection.x.at(start_x, start_y, inverse_depth);
    let row_start_y = source.projection.y.at(start_x, start_y, inverse_depth);
    let row_start_z = source.projection.z.at(start_x, start_y, inverse_depth);
    let last_offset = f64::from(radius * 2);
    for (offset_x, offset_y) in [
        (0.0, 0.0),
        (last_offset, 0.0),
        (0.0, last_offset),
        (last_offset, last_offset),
    ] {
        let denominator = row_start_z
            + source.projection.z.pixel_x * offset_x
            + source.projection.z.pixel_y * offset_y;
        if denominator <= 0.0 {
            return None;
        }
        let reciprocal = 1.0 / denominator;
        let sx = (row_start_x
            + source.projection.x.pixel_x * offset_x
            + source.projection.x.pixel_y * offset_y)
            * reciprocal;
        let sy = (row_start_y
            + source.projection.y.pixel_x * offset_x
            + source.projection.y.pixel_y * offset_y)
            * reciprocal;
        if sx < 0.0
            || sy < 0.0
            || sx >= f64::from(source_width.saturating_sub(1))
            || sy >= f64::from(source_height.saturating_sub(1))
        {
            return None;
        }
    }
    let mut sum_b = 0.0_f32;
    let mut sum_bb = 0.0_f32;
    let mut sum_ab = 0.0_f32;
    let mut patch_offset = 0_usize;
    for dy in -radius..=radius {
        let row_offset = f64::from(dy + radius);
        let mut numerator_x = row_start_x + source.projection.x.pixel_y * row_offset;
        let mut numerator_y = row_start_y + source.projection.y.pixel_y * row_offset;
        let mut denominator = row_start_z + source.projection.z.pixel_y * row_offset;
        for _ in -radius..=radius {
            let reciprocal = 1.0 / denominator;
            let sx = numerator_x * reciprocal;
            let sy = numerator_y * reciprocal;
            if bilinear_mask_excluded(source.mask, sx, sy) {
                return None;
            }
            let a = reference_patch.values[patch_offset];
            patch_offset += 1;
            let b = bilinear_gray(source.gray, sx, sy);
            sum_b += b;
            sum_bb += b * b;
            sum_ab += a * b;
            numerator_x += source.projection.x.pixel_x;
            numerator_y += source.projection.y.pixel_x;
            denominator += source.projection.z.pixel_x;
        }
    }
    let covariance = sum_ab - reference_patch.sum * sum_b / reference_patch.count;
    let variance_b = (sum_bb - sum_b * sum_b / reference_patch.count).max(0.0);
    let denominator = (reference_patch.variance * variance_b).sqrt();
    (denominator > 1.0e-6).then_some((covariance / denominator).clamp(-1.0, 1.0))
}

fn bilinear_mask_excluded(mask: &GrayImage, x: f64, y: f64) -> bool {
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(mask.width() - 1);
    let y1 = (y0 + 1).min(mask.height() - 1);
    [
        mask.get_pixel(x0, y0).0[0],
        mask.get_pixel(x1, y0).0[0],
        mask.get_pixel(x0, y1).0[0],
        mask.get_pixel(x1, y1).0[0],
    ]
    .into_iter()
    .any(|value| value == 0)
}

fn bilinear_gray(image: &GrayImage, x: f64, y: f64) -> f32 {
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(image.width() - 1);
    let y1 = (y0 + 1).min(image.height() - 1);
    let tx = (x - f64::from(x0)) as f32;
    let ty = (y - f64::from(y0)) as f32;
    let width = image.width() as usize;
    let pixels = image.as_raw();
    let x0 = x0 as usize;
    let x1 = x1 as usize;
    let y0 = y0 as usize;
    let y1 = y1 as usize;
    let p00 = f32::from(pixels[y0 * width + x0]);
    let p10 = f32::from(pixels[y0 * width + x1]);
    let p01 = f32::from(pixels[y1 * width + x0]);
    let p11 = f32::from(pixels[y1 * width + x1]);
    let top = p00 + (p10 - p00) * tx;
    let bottom = p01 + (p11 - p01) * tx;
    (top + (bottom - top) * ty) / 255.0
}

fn backproject(camera: &MvsPinholeCamera, x: f64, y: f64, depth: f64) -> [f64; 3] {
    let camera_point = [
        (x - camera.cx) / camera.fx * depth,
        (y - camera.cy) / camera.fy * depth,
        depth,
    ];
    let matrix = &camera.world_to_camera;
    let translated = [
        camera_point[0] - matrix[3],
        camera_point[1] - matrix[7],
        camera_point[2] - matrix[11],
    ];
    [
        matrix[0] * translated[0] + matrix[4] * translated[1] + matrix[8] * translated[2],
        matrix[1] * translated[0] + matrix[5] * translated[1] + matrix[9] * translated[2],
        matrix[2] * translated[0] + matrix[6] * translated[1] + matrix[10] * translated[2],
    ]
}

fn project(camera: &MvsPinholeCamera, world: [f64; 3]) -> Option<(f64, f64, f64)> {
    let matrix = &camera.world_to_camera;
    let x = matrix[0] * world[0] + matrix[1] * world[1] + matrix[2] * world[2] + matrix[3];
    let y = matrix[4] * world[0] + matrix[5] * world[1] + matrix[6] * world[2] + matrix[7];
    let z = matrix[8] * world[0] + matrix[9] * world[1] + matrix[10] * world[2] + matrix[11];
    (z > 0.0).then_some((
        camera.fx * x / z + camera.cx,
        camera.fy * y / z + camera.cy,
        z,
    ))
}

#[allow(clippy::too_many_arguments)]
fn geometric_consistency(
    request: &MvsWorkerRequest,
    scene: &MvsSceneManifest,
    image_lookup: &BTreeMap<&str, &MvsSceneImage>,
    raw_root: &Path,
    tile_root: &Path,
    depth_images: &mut [MvsDepthImageRecord],
    worker_threads: usize,
    cancellation: &AtomicBool,
) -> Result<(), WorkerError> {
    event(&WorkerEvent::Progress {
        stage: "geometricConsistency",
        completed_units: 0,
        total_units: scene.images.len() as u64,
        completed_bytes: 0,
    });
    if worker_threads > 1 && scene.images.len() > 1 {
        return geometric_consistency_parallel(
            request,
            scene,
            image_lookup,
            raw_root,
            tile_root,
            depth_images,
            worker_threads,
            cancellation,
        );
    }
    for (image_index, image) in scene.images.iter().enumerate() {
        check_cancel(cancellation)?;
        let reference_path = raw_root.join(format!("{}.raw", image.image_id));
        let mut reference_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&reference_path)?;
        let (reference_width, reference_height) = read_raw_header(&mut reference_file)?;
        let reference_scale_x = f64::from(reference_width) / f64::from(image.width);
        let reference_scale_y = f64::from(reference_height) / f64::from(image.height);
        let reference_camera =
            scaled_camera_xy(&image.camera, reference_scale_x, reference_scale_y);
        let mut neighbors = image
            .neighbor_image_ids
            .iter()
            .take(usize::from(request.settings.matching_views))
            .map(|id| {
                let source = image_lookup
                    .get(id.as_str())
                    .copied()
                    .ok_or_else(|| WorkerError::InvalidInput(format!("unknown neighbor {id}")))?;
                let buffer = RawDepthRowCache::open(&raw_root.join(format!("{id}.raw")))?;
                let camera = scaled_camera_xy(
                    &source.camera,
                    f64::from(buffer.width) / f64::from(source.width),
                    f64::from(buffer.height) / f64::from(source.height),
                );
                Ok((buffer, camera))
            })
            .collect::<Result<Vec<_>, WorkerError>>()?;
        let neighbor_count = neighbors.len().max(1);
        let tiles_x = reference_width.div_ceil(request.settings.tile_size);
        let tiles_y = reference_height.div_ceil(request.settings.tile_size);
        let mut replacement = Vec::with_capacity((tiles_x * tiles_y) as usize);
        for tile_y in 0..tiles_y {
            for tile_x in 0..tiles_x {
                check_cancel(cancellation)?;
                let start_x = tile_x * request.settings.tile_size;
                let start_y = tile_y * request.settings.tile_size;
                let width = request.settings.tile_size.min(reference_width - start_x);
                let height = request.settings.tile_size.min(reference_height - start_y);
                let mut reference = read_raw_region(
                    &mut reference_file,
                    reference_width,
                    start_x,
                    start_y,
                    width,
                    height,
                )?;
                for local_y in 0..height {
                    check_cancel(cancellation)?;
                    let y = start_y + local_y;
                    for local_x in 0..width {
                        let x = start_x + local_x;
                        let offset = index(width, local_x, local_y);
                        let depth = reference.depth[offset];
                        if depth <= 0.0 {
                            continue;
                        }
                        let world = backproject(
                            &reference_camera,
                            f64::from(x),
                            f64::from(y),
                            f64::from(depth),
                        );
                        let mut consistent = 0_u8;
                        for (source, camera) in &mut neighbors {
                            let Some((sx, sy, projected_depth)) = project(camera, world) else {
                                continue;
                            };
                            let ix = sx.round() as i64;
                            let iy = sy.round() as i64;
                            if ix < 0
                                || iy < 0
                                || ix >= i64::from(source.width)
                                || iy >= i64::from(source.height)
                            {
                                continue;
                            }
                            let observed = source.depth_at(ix as u32, iy as u32)?;
                            if observed > 0.0
                                && ((f64::from(observed) - projected_depth).abs()
                                    / projected_depth.max(f64::EPSILON))
                                    <= f64::from(request.settings.geometric_relative_tolerance)
                            {
                                consistent = consistent.saturating_add(1);
                            }
                        }
                        if consistent < request.settings.minimum_consistent_views {
                            reference.depth[offset] = 0.0;
                            reference.confidence[offset] = 0.0;
                        } else {
                            reference.confidence[offset] *=
                                f32::from(consistent) / neighbor_count as f32;
                        }
                    }
                }
                write_raw_region(
                    &mut reference_file,
                    reference_width,
                    start_x,
                    start_y,
                    &reference,
                )?;
                replacement.push(write_tile_region(
                    tile_root,
                    &image.image_id,
                    0,
                    tile_x,
                    tile_y,
                    &reference,
                    0,
                    0,
                    width,
                    height,
                )?);
            }
        }
        reference_file.sync_all()?;
        let output = depth_images
            .iter_mut()
            .find(|candidate| candidate.image_id == image.image_id)
            .ok_or_else(|| WorkerError::InvalidInput("missing depth output record".into()))?;
        output.tiles.retain(|tile| tile.key.level != 0);
        output.tiles.extend(replacement);
        output.tiles.sort_by(|left, right| left.key.cmp(&right.key));
        event(&WorkerEvent::Progress {
            stage: "geometricConsistency",
            completed_units: (image_index + 1) as u64,
            total_units: scene.images.len() as u64,
            completed_bytes: 0,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn geometric_consistency_parallel(
    request: &MvsWorkerRequest,
    scene: &MvsSceneManifest,
    image_lookup: &BTreeMap<&str, &MvsSceneImage>,
    raw_root: &Path,
    tile_root: &Path,
    depth_images: &mut [MvsDepthImageRecord],
    worker_threads: usize,
    cancellation: &AtomicBool,
) -> Result<(), WorkerError> {
    let workers = worker_threads.max(1).min(scene.images.len());
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let (sender, receiver) = mpsc::sync_channel(workers.saturating_mul(2));
    thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let next = &next;
            let failed = &failed;
            scope.spawn(move || {
                while !failed.load(Ordering::Acquire) {
                    let image_index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(image) = scene.images.get(image_index) else {
                        break;
                    };
                    let result = geometric_consistency_image(
                        request,
                        image,
                        image_lookup,
                        raw_root,
                        tile_root,
                        cancellation,
                    );
                    let is_error = result.is_err();
                    if sender.send((image_index, result)).is_err() {
                        break;
                    }
                    if is_error {
                        failed.store(true, Ordering::Release);
                    }
                }
            });
        }
        drop(sender);
        let mut completed = 0_u64;
        let mut first_error = None;
        for (image_index, result) in receiver {
            match result {
                Ok(replacement) if first_error.is_none() => {
                    let image = &scene.images[image_index];
                    let output = depth_images
                        .iter_mut()
                        .find(|candidate| candidate.image_id == image.image_id)
                        .ok_or_else(|| {
                            WorkerError::InvalidInput("missing depth output record".into())
                        })?;
                    output.tiles.retain(|tile| tile.key.level != 0);
                    output.tiles.extend(replacement);
                    output.tiles.sort_by(|left, right| left.key.cmp(&right.key));
                    completed += 1;
                    event(&WorkerEvent::Progress {
                        stage: "geometricConsistency",
                        completed_units: completed,
                        total_units: scene.images.len() as u64,
                        completed_bytes: 0,
                    });
                }
                Ok(_) => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(())
        }
    })
}

fn geometric_consistency_image(
    request: &MvsWorkerRequest,
    image: &MvsSceneImage,
    image_lookup: &BTreeMap<&str, &MvsSceneImage>,
    raw_root: &Path,
    tile_root: &Path,
    cancellation: &AtomicBool,
) -> Result<Vec<MvsDepthTileRecord>, WorkerError> {
    check_cancel(cancellation)?;
    let reference_path = raw_root.join(format!("{}.raw", image.image_id));
    let mut reference_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&reference_path)?;
    let (reference_width, reference_height) = read_raw_header(&mut reference_file)?;
    let reference_scale_x = f64::from(reference_width) / f64::from(image.width);
    let reference_scale_y = f64::from(reference_height) / f64::from(image.height);
    let reference_camera = scaled_camera_xy(&image.camera, reference_scale_x, reference_scale_y);
    let mut neighbors = image
        .neighbor_image_ids
        .iter()
        .take(usize::from(request.settings.matching_views))
        .map(|id| {
            let source = image_lookup
                .get(id.as_str())
                .copied()
                .ok_or_else(|| WorkerError::InvalidInput(format!("unknown neighbor {id}")))?;
            let buffer = RawDepthRowCache::open(&raw_root.join(format!("{id}.raw")))?;
            let camera = scaled_camera_xy(
                &source.camera,
                f64::from(buffer.width) / f64::from(source.width),
                f64::from(buffer.height) / f64::from(source.height),
            );
            Ok((buffer, camera))
        })
        .collect::<Result<Vec<_>, WorkerError>>()?;
    let neighbor_count = neighbors.len().max(1);
    let tiles_x = reference_width.div_ceil(request.settings.tile_size);
    let tiles_y = reference_height.div_ceil(request.settings.tile_size);
    let mut replacement = Vec::with_capacity((tiles_x * tiles_y) as usize);
    for tile_y in 0..tiles_y {
        for tile_x in 0..tiles_x {
            check_cancel(cancellation)?;
            let start_x = tile_x * request.settings.tile_size;
            let start_y = tile_y * request.settings.tile_size;
            let width = request.settings.tile_size.min(reference_width - start_x);
            let height = request.settings.tile_size.min(reference_height - start_y);
            let mut reference = read_raw_region(
                &mut reference_file,
                reference_width,
                start_x,
                start_y,
                width,
                height,
            )?;
            for local_y in 0..height {
                check_cancel(cancellation)?;
                let y = start_y + local_y;
                for local_x in 0..width {
                    let x = start_x + local_x;
                    let offset = index(width, local_x, local_y);
                    let depth = reference.depth[offset];
                    if depth <= 0.0 {
                        continue;
                    }
                    let world = backproject(
                        &reference_camera,
                        f64::from(x),
                        f64::from(y),
                        f64::from(depth),
                    );
                    let mut consistent = 0_u8;
                    for (source, camera) in &mut neighbors {
                        let Some((sx, sy, projected_depth)) = project(camera, world) else {
                            continue;
                        };
                        let ix = sx.round() as i64;
                        let iy = sy.round() as i64;
                        if ix < 0
                            || iy < 0
                            || ix >= i64::from(source.width)
                            || iy >= i64::from(source.height)
                        {
                            continue;
                        }
                        let observed = source.depth_at(ix as u32, iy as u32)?;
                        if observed > 0.0
                            && ((f64::from(observed) - projected_depth).abs()
                                / projected_depth.max(f64::EPSILON))
                                <= f64::from(request.settings.geometric_relative_tolerance)
                        {
                            consistent = consistent.saturating_add(1);
                        }
                    }
                    if consistent < request.settings.minimum_consistent_views {
                        reference.depth[offset] = 0.0;
                        reference.confidence[offset] = 0.0;
                    } else {
                        reference.confidence[offset] *=
                            f32::from(consistent) / neighbor_count as f32;
                    }
                }
            }
            write_raw_region(
                &mut reference_file,
                reference_width,
                start_x,
                start_y,
                &reference,
            )?;
            replacement.push(write_tile_region(
                tile_root,
                &image.image_id,
                0,
                tile_x,
                tile_y,
                &reference,
                0,
                0,
                width,
                height,
            )?);
        }
    }
    reference_file.sync_all()?;
    Ok(replacement)
}

struct RawDepthRowCache {
    file: File,
    width: u32,
    height: u32,
    rows: VecDeque<(u32, Vec<f32>)>,
}

impl RawDepthRowCache {
    fn open(path: &Path) -> Result<Self, WorkerError> {
        let mut file = File::open(path)?;
        let (width, height) = read_raw_header(&mut file)?;
        Ok(Self {
            file,
            width,
            height,
            rows: VecDeque::with_capacity(16),
        })
    }

    fn depth_at(&mut self, x: u32, y: u32) -> Result<f32, WorkerError> {
        if x >= self.width || y >= self.height {
            return Ok(0.0);
        }
        if let Some(index) = self.rows.iter().position(|(row, _)| *row == y) {
            let cached = self.rows.remove(index).expect("located row exists");
            let value = cached.1[usize::try_from(x).expect("u32 fits usize")];
            self.rows.push_back(cached);
            return Ok(value);
        }
        let mut row = vec![0.0_f32; usize::try_from(self.width).expect("u32 fits usize")];
        self.file.seek(SeekFrom::Start(
            16 + u64::from(y) * u64::from(self.width) * 8,
        ))?;
        let mut encoded = vec![0_u8; row.len() * 8];
        self.file.read_exact(&mut encoded)?;
        for (value, sample) in row.iter_mut().zip(encoded.chunks_exact(8)) {
            *value = f32::from_le_bytes(sample[0..4].try_into().expect("fixed chunk"));
        }
        let value = row[usize::try_from(x).expect("u32 fits usize")];
        if self.rows.len() == 16 {
            self.rows.pop_front();
        }
        self.rows.push_back((y, row));
        Ok(value)
    }
}

fn read_raw_header(file: &mut File) -> Result<(u32, u32), WorkerError> {
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; 16];
    file.read_exact(&mut header)?;
    if &header[0..8] != b"HCRAWDP1" {
        return Err(WorkerError::InvalidInput("invalid raw depth cache".into()));
    }
    let width = u32::from_le_bytes(header[8..12].try_into().expect("fixed slice"));
    let height = u32::from_le_bytes(header[12..16].try_into().expect("fixed slice"));
    let expected = 16_u64
        .checked_add(u64::from(width) * u64::from(height) * 8)
        .ok_or_else(|| WorkerError::InvalidInput("raw depth size overflow".into()))?;
    if width == 0 || height == 0 || file.metadata()?.len() != expected {
        return Err(WorkerError::InvalidInput(
            "raw depth cache dimensions are invalid".into(),
        ));
    }
    Ok((width, height))
}

fn read_raw_region(
    file: &mut File,
    full_width: u32,
    start_x: u32,
    start_y: u32,
    width: u32,
    height: u32,
) -> Result<DepthBuffer, WorkerError> {
    let mut depth = Vec::with_capacity((width * height) as usize);
    let mut confidence = Vec::with_capacity((width * height) as usize);
    let mut encoded = vec![0_u8; width as usize * 8];
    for y in 0..height {
        let pixel_offset = u64::from(start_y + y) * u64::from(full_width) + u64::from(start_x);
        file.seek(SeekFrom::Start(16 + pixel_offset * 8))?;
        file.read_exact(&mut encoded)?;
        for sample in encoded.chunks_exact(8) {
            depth.push(f32::from_le_bytes(
                sample[0..4].try_into().expect("fixed slice"),
            ));
            confidence.push(f32::from_le_bytes(
                sample[4..8].try_into().expect("fixed slice"),
            ));
        }
    }
    Ok(DepthBuffer {
        width,
        height,
        depth,
        confidence,
    })
}

fn scaled_camera_xy(camera: &MvsPinholeCamera, scale_x: f64, scale_y: f64) -> MvsPinholeCamera {
    MvsPinholeCamera {
        fx: camera.fx * scale_x,
        fy: camera.fy * scale_y,
        cx: camera.cx * scale_x,
        cy: camera.cy * scale_y,
        world_to_camera: camera.world_to_camera,
    }
}

fn tile_keys_for_image(
    image_id: &str,
    width: u32,
    height: u32,
    settings: &MvsSettings,
) -> Vec<MvsDepthTileKey> {
    let mut keys = Vec::new();
    for level in 0..settings.pyramid_levels {
        let divisor = 1_u32 << u32::from(level);
        let level_width = width.div_ceil(divisor).max(1);
        let level_height = height.div_ceil(divisor).max(1);
        for y in 0..level_height.div_ceil(settings.tile_size) {
            for x in 0..level_width.div_ceil(settings.tile_size) {
                keys.push(MvsDepthTileKey {
                    image_id: image_id.into(),
                    level,
                    x,
                    y,
                });
            }
        }
    }
    keys
}

fn read_existing_tile_records(
    tile_root: &Path,
    output_root: &Path,
    keys: &[MvsDepthTileKey],
) -> Result<Vec<MvsDepthTileRecord>, WorkerError> {
    let mut records = Vec::with_capacity(keys.len());
    for key in keys {
        let path = tile_root
            .join(&key.image_id)
            .join(key.level.to_string())
            .join(format!("{}_{}.hcdt", key.x, key.y));
        let mut file = File::open(&path)?;
        let mut header = [0_u8; 40];
        file.read_exact(&mut header)?;
        if &header[0..8] != DEPTH_MAGIC {
            return Err(WorkerError::InvalidInput(
                "resume depth tile has invalid magic".into(),
            ));
        }
        let values = header[8..]
            .chunks_exact(4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("fixed chunk")))
            .collect::<Vec<_>>();
        let [schema, level, x, y, width, height, channels, scalar_bytes] = values.as_slice() else {
            return Err(WorkerError::InvalidInput(
                "resume depth tile header is incomplete".into(),
            ));
        };
        if *schema != 1
            || *level != u32::from(key.level)
            || *x != key.x
            || *y != key.y
            || *channels != 2
            || *scalar_bytes != 4
            || *width == 0
            || *height == 0
        {
            return Err(WorkerError::InvalidInput(
                "resume depth tile header differs from checkpoint".into(),
            ));
        }
        let pixel_count = u64::from(*width) * u64::from(*height);
        if file.metadata()?.len() != 40 + pixel_count * 8 {
            return Err(WorkerError::InvalidInput(
                "resume depth tile is truncated".into(),
            ));
        }
        let mut valid_pixels = 0_u64;
        let mut sample = [0_u8; 8];
        for _ in 0..pixel_count {
            file.read_exact(&mut sample)?;
            let depth = f32::from_le_bytes(sample[0..4].try_into().expect("fixed slice"));
            let confidence = f32::from_le_bytes(sample[4..8].try_into().expect("fixed slice"));
            if !depth.is_finite() || !confidence.is_finite() {
                return Err(WorkerError::InvalidInput(
                    "resume depth tile contains a non-finite value".into(),
                ));
            }
            valid_pixels += u64::from(depth > 0.0);
        }
        records.push(MvsDepthTileRecord {
            key: key.clone(),
            relative_path: path
                .strip_prefix(output_root)
                .map_err(|_| WorkerError::InvalidInput("resume tile escaped output".into()))?
                .to_owned(),
            sha256: hash_file(&path)?,
            width: *width,
            height: *height,
            valid_pixels,
        });
    }
    Ok(records)
}

fn write_tiles(
    root: &Path,
    image_id: &str,
    level: u8,
    buffer: &DepthBuffer,
    tile_size: u32,
) -> Result<Vec<MvsDepthTileRecord>, WorkerError> {
    let directory = root.join(image_id).join(level.to_string());
    fs::create_dir_all(&directory)?;
    let tiles_x = buffer.width.div_ceil(tile_size);
    let tiles_y = buffer.height.div_ceil(tile_size);
    let mut records = Vec::with_capacity((tiles_x * tiles_y) as usize);
    for tile_y in 0..tiles_y {
        for tile_x in 0..tiles_x {
            let start_x = tile_x * tile_size;
            let start_y = tile_y * tile_size;
            let width = tile_size.min(buffer.width - start_x);
            let height = tile_size.min(buffer.height - start_y);
            records.push(write_tile_region(
                root, image_id, level, tile_x, tile_y, buffer, start_x, start_y, width, height,
            )?);
        }
    }
    Ok(records)
}

#[allow(clippy::too_many_arguments)]
fn write_tile_region(
    root: &Path,
    image_id: &str,
    level: u8,
    tile_x: u32,
    tile_y: u32,
    buffer: &DepthBuffer,
    start_x: u32,
    start_y: u32,
    width: u32,
    height: u32,
) -> Result<MvsDepthTileRecord, WorkerError> {
    let directory = root.join(image_id).join(level.to_string());
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{tile_x}_{tile_y}.hcdt"));
    let temporary = path.with_extension("hcdt.pending");
    let mut file = File::create(&temporary)?;
    file.write_all(DEPTH_MAGIC)?;
    for value in [1, u32::from(level), tile_x, tile_y, width, height, 2, 4] {
        file.write_all(&value.to_le_bytes())?;
    }
    let mut valid_pixels = 0_u64;
    for y in 0..height {
        for x in 0..width {
            let offset = index(buffer.width, start_x + x, start_y + y);
            let depth = buffer.depth[offset];
            let confidence = buffer.confidence[offset];
            file.write_all(&depth.to_le_bytes())?;
            file.write_all(&confidence.to_le_bytes())?;
            valid_pixels += u64::from(depth > 0.0);
        }
    }
    file.sync_all()?;
    drop(file);
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(temporary, &path)?;
    Ok(MvsDepthTileRecord {
        key: MvsDepthTileKey {
            image_id: image_id.into(),
            level,
            x: tile_x,
            y: tile_y,
        },
        relative_path: path
            .strip_prefix(root.parent().unwrap_or(root))
            .map_err(|_| WorkerError::InvalidInput("tile path escaped output".into()))?
            .to_owned(),
        sha256: hash_file(&path)?,
        width,
        height,
        valid_pixels,
    })
}

fn validate_raw_depth_dimensions(
    path: &Path,
    expected_width: u32,
    expected_height: u32,
) -> Result<(), WorkerError> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; 16];
    file.read_exact(&mut header)?;
    let width = u32::from_le_bytes(header[8..12].try_into().expect("fixed slice"));
    let height = u32::from_le_bytes(header[12..16].try_into().expect("fixed slice"));
    let expected_bytes = 16_u64
        .checked_add(u64::from(width) * u64::from(height) * 8)
        .ok_or_else(|| WorkerError::InvalidInput("raw depth size overflow".into()))?;
    if &header[0..8] != b"HCRAWDP1"
        || width != expected_width
        || height != expected_height
        || file.metadata()?.len() != expected_bytes
    {
        return Err(WorkerError::InvalidInput(
            "resume raw depth cache is incompatible".into(),
        ));
    }
    Ok(())
}

fn fuse_dense_cloud(
    request: &MvsWorkerRequest,
    scene: &MvsSceneManifest,
    scene_root: &Path,
    raw_root: &Path,
    checkpoint_keys: &BTreeSet<MvsDepthTileKey>,
    completed_tiles: u64,
    cancellation: &AtomicBool,
) -> Result<himmelcad_sidecar::mvs_runtime::MvsDenseCloudRecord, WorkerError> {
    let footprints = fusion::FootprintStatistics::from_values(
        scene
            .images
            .iter()
            .map(|image| {
                let scale = (f64::from(request.settings.maximum_image_dimension)
                    / f64::from(image.width.max(image.height)))
                .min(1.0);
                let fx = image.camera.fx * scale;
                let fy = image.camera.fy * scale;
                let representative_depth = (image.minimum_depth * image.maximum_depth).sqrt();
                representative_depth / (fx * fy).sqrt()
            })
            .collect(),
    )?;
    // One depth pixel is the smallest defensible scene sampling cell. Hardware
    // pressure changes the number of external-sort runs, never this resolution.
    let voxel_size_meters = footprints.median;
    let ordered_image_ids = scene
        .images
        .iter()
        .map(|image| image.image_id.clone())
        .collect::<Vec<_>>();
    let work_root = request.output_path.join("fusion-work");
    let mut spool = fusion::FusionSpool::open(
        &work_root,
        &request.job_id,
        &request.scene_manifest_sha256,
        &request.settings_sha256,
        voxel_size_meters,
        &ordered_image_ids,
        fusion::DEFAULT_BUFFERED_SAMPLES,
    )?;
    let completed_images = spool.completed_image_count();
    let payload_path = request.output_path.join("dense.vertices");
    for (image_index, image) in scene.images.iter().enumerate() {
        if image_index < completed_images {
            event(&WorkerEvent::Progress {
                stage: "denseFusion",
                completed_units: (image_index + 1) as u64,
                total_units: scene.images.len() as u64,
                completed_bytes: 0,
            });
            continue;
        }
        check_cancel(cancellation)?;
        let view_index = u32::try_from(image_index).map_err(|_| {
            WorkerError::InvalidInput("dense fusion supports at most 2^32 source views".into())
        })?;
        let mut depth_file = File::open(raw_root.join(format!("{}.raw", image.image_id)))?;
        let (depth_width, depth_height) = read_raw_header(&mut depth_file)?;
        let loaded = load_view(scene_root, image, request.settings.maximum_image_dimension)?;
        let camera = scaled_camera_xy(
            &image.camera,
            f64::from(depth_width) / f64::from(image.width),
            f64::from(depth_height) / f64::from(image.height),
        );
        for start_y in (0..depth_height).step_by(64) {
            check_cancel(cancellation)?;
            let height = 64.min(depth_height - start_y);
            let read_start_y = start_y.saturating_sub(1);
            let read_end_y = (start_y + height + 1).min(depth_height);
            let depth = read_raw_region(
                &mut depth_file,
                depth_width,
                0,
                read_start_y,
                depth_width,
                read_end_y - read_start_y,
            )?;
            for local_y in 0..height {
                let y = start_y + local_y;
                let band_y = y - read_start_y;
                for x in 0..depth_width {
                    let offset = index(depth_width, x, band_y);
                    let value = depth.depth[offset];
                    if value <= 0.0 {
                        continue;
                    }
                    let world = backproject(&camera, f64::from(x), f64::from(y), f64::from(value));
                    let normal = estimate_surface_normal(
                        &camera,
                        x,
                        y,
                        depth_width,
                        depth_height,
                        read_start_y,
                        &depth,
                        world,
                    );
                    let color = if request.settings.calculate_colors {
                        let color_x = x.min(loaded.rgb.width() - 1);
                        let color_y = y.min(loaded.rgb.height() - 1);
                        loaded.rgb.get_pixel(color_x, color_y).0
                    } else {
                        [0, 0, 0]
                    };
                    spool.push(
                        fusion::FusionSample {
                            view_index,
                            position: world,
                            color,
                            confidence: depth.confidence[offset],
                            normal,
                            pixel_footprint_meters: f64::from(value)
                                / (camera.fx * camera.fy).sqrt(),
                        },
                        cancellation,
                    )?;
                }
            }
        }
        spool.finish_image(&image.image_id, cancellation)?;
        write_checkpoint(request, checkpoint_keys, completed_tiles.max(1), true)?;
        event(&WorkerEvent::Progress {
            stage: "denseFusion",
            completed_units: (image_index + 1) as u64,
            total_units: scene.images.len() as u64,
            completed_bytes: 0,
        });
    }
    let fusion_result = spool.finish(
        &payload_path,
        request.settings.calculate_colors,
        request.settings.retain_confidence_attribute,
        cancellation,
    )?;
    let vertex_count = fusion_result.fused_sample_count;
    if vertex_count == 0 {
        return Err(WorkerError::InvalidInput(
            "geometric consistency rejected every dense point".into(),
        ));
    }
    let dense_path = request.output_path.join("dense.ply");
    let temporary = dense_path.with_extension("ply.pending");
    let mut output = File::create(&temporary)?;
    write!(
        output,
        "ply\nformat binary_little_endian 1.0\nelement vertex {vertex_count}\nproperty double x\nproperty double y\nproperty double z\n"
    )?;
    if request.settings.calculate_colors {
        output.write_all(b"property uchar red\nproperty uchar green\nproperty uchar blue\n")?;
    }
    if request.settings.retain_confidence_attribute {
        output.write_all(b"property float confidence\n")?;
    }
    output.write_all(b"property float nx\nproperty float ny\nproperty float nz\n")?;
    output.write_all(b"end_header\n")?;
    io::copy(&mut File::open(&payload_path)?, &mut output)?;
    output.sync_all()?;
    drop(output);
    if dense_path.exists() {
        fs::remove_file(&dense_path)?;
    }
    fs::rename(temporary, &dense_path)?;
    fs::remove_file(payload_path)?;
    let record = himmelcad_sidecar::mvs_runtime::MvsDenseCloudRecord {
        relative_path: PathBuf::from("dense.ply"),
        sha256: hash_file(&dense_path)?,
        vertex_count,
        bytes: dense_path.metadata()?.len(),
        fusion: Some(MvsDenseFusionEvidence {
            algorithm: MVS_DENSE_FUSION_ALGORITHM.into(),
            raw_sample_count: fusion_result.raw_sample_count,
            fused_sample_count: fusion_result.fused_sample_count,
            voxel_size_meters,
            minimum_representative_pixel_footprint_meters: footprints.minimum,
            median_representative_pixel_footprint_meters: footprints.median,
            maximum_representative_pixel_footprint_meters: footprints.maximum,
            external_sort_runs: fusion_result.external_sort_runs,
            maximum_buffered_samples: fusion_result.maximum_buffered_samples,
        }),
    };
    fs::remove_dir_all(work_root)?;
    Ok(record)
}

#[allow(clippy::too_many_arguments)]
fn estimate_surface_normal(
    camera: &MvsPinholeCamera,
    x: u32,
    y: u32,
    full_width: u32,
    full_height: u32,
    band_start_y: u32,
    depth: &DepthBuffer,
    world: [f64; 3],
) -> [f32; 3] {
    let x0 = x.saturating_sub(1);
    let x1 = (x + 1).min(full_width - 1);
    let y0 = y.saturating_sub(1);
    let y1 = (y + 1).min(full_height - 1);
    let sample = |sample_x: u32, sample_y: u32| -> Option<[f64; 3]> {
        let local_y = sample_y.checked_sub(band_start_y)?;
        if sample_x >= depth.width || local_y >= depth.height {
            return None;
        }
        let value = *depth.depth.get(index(depth.width, sample_x, local_y))?;
        (value > 0.0).then(|| {
            backproject(
                camera,
                f64::from(sample_x),
                f64::from(sample_y),
                f64::from(value),
            )
        })
    };
    let camera_center = camera_center(camera);
    let toward_camera = subtract(camera_center, world);
    let normal = sample(x0, y)
        .zip(sample(x1, y))
        .zip(sample(x, y0).zip(sample(x, y1)))
        .map(|((left, right), (top, bottom))| {
            // Image Y points down. dy × dx therefore points approximately
            // toward an aerial camera above the reconstructed surface.
            cross(subtract(bottom, top), subtract(right, left))
        })
        .filter(|candidate| squared_length(*candidate) > 1.0e-20)
        .unwrap_or(toward_camera);
    let oriented = if dot(normal, toward_camera) < 0.0 {
        [-normal[0], -normal[1], -normal[2]]
    } else {
        normal
    };
    normalize(oriented).unwrap_or([0.0, 0.0, 1.0])
}

fn camera_center(camera: &MvsPinholeCamera) -> [f64; 3] {
    let matrix = camera.world_to_camera;
    [
        -(matrix[0] * matrix[3] + matrix[4] * matrix[7] + matrix[8] * matrix[11]),
        -(matrix[1] * matrix[3] + matrix[5] * matrix[7] + matrix[9] * matrix[11]),
        -(matrix[2] * matrix[3] + matrix[6] * matrix[7] + matrix[10] * matrix[11]),
    ]
}

fn subtract(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

fn cross(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn squared_length(value: [f64; 3]) -> f64 {
    dot(value, value)
}

fn normalize(value: [f64; 3]) -> Option<[f32; 3]> {
    let length = squared_length(value).sqrt();
    (length.is_finite() && length > 1.0e-12).then(|| {
        [
            (value[0] / length) as f32,
            (value[1] / length) as f32,
            (value[2] / length) as f32,
        ]
    })
}

fn count_tiles(image: &MvsSceneImage, settings: &MvsSettings) -> u64 {
    let scale = (f64::from(settings.maximum_image_dimension)
        / f64::from(image.width.max(image.height)))
    .min(1.0);
    let base_width = (f64::from(image.width) * scale).round().max(1.0) as u32;
    let base_height = (f64::from(image.height) * scale).round().max(1.0) as u32;
    (0..settings.pyramid_levels)
        .map(|level| {
            let divisor = 1_u32 << u32::from(level);
            let width = base_width.div_ceil(divisor).max(1);
            let height = base_height.div_ceil(divisor).max(1);
            u64::from(width.div_ceil(settings.tile_size))
                * u64::from(height.div_ceil(settings.tile_size))
        })
        .sum()
}

fn write_checkpoint(
    request: &MvsWorkerRequest,
    keys: &BTreeSet<MvsDepthTileKey>,
    sequence: u64,
    geometric_consistency_complete: bool,
) -> Result<(), WorkerError> {
    let sequence = sequence.max(1);
    let checkpoint = MvsCheckpoint {
        schema_version: 1,
        job_id: request.job_id.clone(),
        scene_manifest_sha256: request.scene_manifest_sha256.clone(),
        settings_sha256: request.settings_sha256.clone(),
        sequence,
        completed_tiles: keys.clone(),
        geometric_consistency_complete,
    };
    atomic_json(
        &request
            .checkpoint_path
            .join(format!("checkpoint-{sequence:012}.json")),
        &checkpoint,
    )?;
    event(&WorkerEvent::Checkpoint {
        sequence,
        completed_tiles: keys.len() as u64,
    });
    Ok(())
}

fn resume_keys(request: &MvsWorkerRequest) -> Result<BTreeSet<MvsDepthTileKey>, WorkerError> {
    let Some(path) = &request.resume_checkpoint_path else {
        return Ok(BTreeSet::new());
    };
    let checkpoint: MvsCheckpoint = serde_json::from_slice(&fs::read(path)?)?;
    Ok(checkpoint.completed_tiles)
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), WorkerError> {
    let temporary = path.with_extension("json.pending");
    let mut file = File::create(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<ObjectHash, WorkerError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn index(width: u32, x: u32, y: u32) -> usize {
    usize::try_from(u64::from(y) * u64::from(width) + u64::from(x))
        .expect("validated image dimensions fit usize")
}

fn listen_for_cancel(cancelled: Arc<AtomicBool>) {
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.contains("\"cancel\"") {
                cancelled.store(true, Ordering::Release);
                event(&WorkerEvent::CancelAcknowledged);
                break;
            }
        }
    });
}

fn check_cancel(cancelled: &AtomicBool) -> Result<(), WorkerError> {
    if cancelled.load(Ordering::Acquire) {
        Err(WorkerError::Cancelled)
    } else {
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum WorkerEvent<'a> {
    Progress {
        stage: &'a str,
        completed_units: u64,
        total_units: u64,
        completed_bytes: u64,
    },
    Checkpoint {
        sequence: u64,
        completed_tiles: u64,
    },
    Log {
        level: &'a str,
        message: String,
    },
    CancelAcknowledged,
}

fn event(value: &WorkerEvent<'_>) {
    if let Ok(line) = serde_json::to_string(value) {
        println!("{line}");
    }
}

#[derive(Debug, thiserror::Error)]
enum WorkerError {
    #[error("invalid worker input: {0}")]
    InvalidInput(String),
    #[error("MVS job cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("image decoding failed: {0}")]
    Image(#[from] image::ImageError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_sidecar::mvs_runtime::{validate_output_directory, MvsRunRequest};
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "himmelcad-portable-mvs-e2e-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, AtomicOrdering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn projection_round_trip_is_stable() {
        let camera = MvsPinholeCamera {
            fx: 800.0,
            fy: 810.0,
            cx: 500.0,
            cy: 400.0,
            world_to_camera: [1.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0, -3.0, 0.0, 0.0, 1.0, 5.0],
        };
        let world = backproject(&camera, 480.0, 390.0, 20.0);
        let (x, y, depth) = project(&camera, world).expect("projection");
        assert!((x - 480.0).abs() < 1.0e-9);
        assert!((y - 390.0).abs() < 1.0e-9);
        assert!((depth - 20.0).abs() < 1.0e-9);
    }

    #[test]
    fn prepared_plane_projection_matches_camera_projection() {
        let reference = MvsPinholeCamera {
            fx: 812.0,
            fy: 809.0,
            cx: 503.0,
            cy: 397.0,
            world_to_camera: [
                0.9998, -0.0175, 0.008, 2.0, 0.0174, 0.9998, 0.011, -3.0, -0.0082, -0.0108, 0.9999,
                5.0,
            ],
        };
        let source = MvsPinholeCamera {
            fx: 798.0,
            fy: 801.0,
            cx: 490.0,
            cy: 405.0,
            world_to_camera: [
                0.9994, 0.028, -0.018, -4.0, -0.0278, 0.9995, 0.012, 1.5, 0.0183, -0.0115, 0.9998,
                6.0,
            ],
        };
        let prepared = PlaneProjection::between(&reference, &source);
        for (x, y, depth) in [
            (480.0, 390.0, 20.0),
            (100.0, 75.0, 8.0),
            (900.0, 700.0, 45.0),
        ] {
            let expected =
                project(&source, backproject(&reference, x, y, depth)).expect("projected point");
            let inverse_depth = 1.0 / depth;
            let denominator = prepared.z.at(x, y, inverse_depth);
            let actual_x = prepared.x.at(x, y, inverse_depth) / denominator;
            let actual_y = prepared.y.at(x, y, inverse_depth) / denominator;
            assert!((actual_x - expected.0).abs() < 1.0e-8);
            assert!((actual_y - expected.1).abs() < 1.0e-8);
            assert_eq!(denominator > 0.0, expected.2 > 0.0);
        }
    }

    #[test]
    fn tile_count_includes_every_pyramid_level() {
        let image = MvsSceneImage {
            image_id: "image".into(),
            relative_path: "image.jpg".into(),
            sha256: ObjectHash::of_bytes(b"image"),
            mask_relative_path: None,
            mask_sha256: None,
            width: 1024,
            height: 1024,
            camera: MvsPinholeCamera {
                fx: 1.0,
                fy: 1.0,
                cx: 0.0,
                cy: 0.0,
                world_to_camera: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            },
            minimum_depth: 1.0,
            maximum_depth: 2.0,
            neighbor_image_ids: vec!["a".into(), "b".into()],
        };
        let settings = MvsSettings {
            maximum_image_dimension: 1024,
            tile_size: 512,
            pyramid_levels: 3,
            ..MvsSettings::default()
        };
        assert_eq!(count_tiles(&image, &settings), 6);
        assert_eq!(tile_keys_for_image("image", 1024, 1024, &settings).len(), 6);
    }

    #[test]
    fn resume_tile_records_are_revalidated_from_copied_output() {
        let directory = TestDirectory::new();
        let output = directory.0.join("output");
        let depth = output.join("depth");
        fs::create_dir_all(&depth).expect("depth root");
        let buffer = DepthBuffer {
            width: 2,
            height: 1,
            depth: vec![5.0, 0.0],
            confidence: vec![0.8, 0.0],
        };
        let written = write_tiles(&depth, "image", 0, &buffer, 512).expect("write tile");
        let keys = written
            .iter()
            .map(|record| record.key.clone())
            .collect::<Vec<_>>();
        let resumed = read_existing_tile_records(&depth, &output, &keys).expect("resume tiles");
        assert_eq!(resumed, written);
    }

    #[test]
    fn plane_sweep_recovers_synthetic_frontoparallel_depth() {
        let width = 96;
        let height = 64;
        let mut reference = GrayImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let value = ((x * 37 + y * 71 + x * y * 3) % 251) as u8;
                reference.put_pixel(x, y, image::Luma([value]));
            }
        }
        let reference_camera = test_camera(0.0);
        let keep_mask = GrayImage::from_pixel(width, height, Luma([255]));
        let mut neighbors = [1_i32, 2, 3]
            .into_iter()
            .map(|baseline| {
                let shift = baseline * 4;
                let mut source = GrayImage::new(width, height);
                for y in 0..height {
                    for x in 0..width {
                        let reference_x = i64::from(x) + i64::from(shift);
                        if (0..i64::from(width)).contains(&reference_x) {
                            source.put_pixel(x, y, *reference.get_pixel(reference_x as u32, y));
                        }
                    }
                }
                LoadedLevel {
                    gray: source,
                    mask: keep_mask.clone(),
                    camera: test_camera(-f64::from(baseline)),
                }
            })
            .collect::<Vec<_>>();
        let settings = MvsSettings {
            patch_radius: 2,
            patchmatch_iterations: 3,
            depth_hypotheses: 64,
            minimum_confidence: 0.05,
            ..MvsSettings::default()
        };
        let result = estimate_level(
            &reference,
            &keep_mask,
            &reference_camera,
            &neighbors,
            5.0,
            20.0,
            &settings,
            None,
            4,
            &AtomicBool::new(false),
        )
        .expect("synthetic depth");
        let recovered = result.depth[index(width, 48, 32)];
        assert!((recovered - 10.0).abs() < 1.0, "recovered {recovered}");

        let mut masked_reference = keep_mask.clone();
        masked_reference.put_pixel(48, 32, Luma([0]));
        let masked = estimate_level(
            &reference,
            &masked_reference,
            &reference_camera,
            &neighbors,
            5.0,
            20.0,
            &settings,
            None,
            4,
            &AtomicBool::new(false),
        )
        .expect("masked reference depth");
        assert_eq!(masked.depth[index(width, 48, 32)], 0.0);
        assert_eq!(masked.confidence[index(width, 48, 32)], 0.0);

        for neighbor in &mut neighbors {
            neighbor.mask.fill(0);
        }
        let source_masked = estimate_level(
            &reference,
            &keep_mask,
            &reference_camera,
            &neighbors,
            5.0,
            20.0,
            &settings,
            None,
            4,
            &AtomicBool::new(false),
        )
        .expect("masked source depth");
        assert!(source_masked.depth.iter().all(|value| *value == 0.0));
        for neighbor in &mut neighbors {
            neighbor.mask.fill(255);
        }

        let directory = TestDirectory::new();
        let tile_root = directory.0.join("output/depth");
        let raw_path = directory.0.join("output/raw/image.raw");
        fs::create_dir_all(raw_path.parent().expect("raw parent")).expect("raw root");
        let mut tiled_settings = settings.clone();
        tiled_settings.tile_size = 32;
        let records = estimate_finest_level_tiled(
            &reference,
            &keep_mask,
            &reference_camera,
            &neighbors,
            5.0,
            20.0,
            &tiled_settings,
            None,
            &tile_root,
            "image",
            &raw_path,
            2,
            &AtomicBool::new(false),
        )
        .expect("tiled finest level");
        assert_eq!(records.len(), 6);
        let mut raw = File::open(raw_path).expect("raw output");
        read_raw_header(&mut raw).expect("raw header");
        let tiled = read_raw_region(&mut raw, width, 0, 0, width, height).expect("raw region");
        assert_eq!(tiled.depth, result.depth);
        assert_eq!(tiled.confidence, result.confidence);
    }

    #[test]
    fn executable_pipeline_writes_validated_depth_and_dense_products() {
        let directory = TestDirectory::new();
        let scene_root = directory.0.join("scene");
        let output = directory.0.join("output");
        let checkpoints = directory.0.join("checkpoints");
        fs::create_dir_all(&scene_root).expect("scene root");
        fs::create_dir_all(&output).expect("output root");
        fs::create_dir_all(&checkpoints).expect("checkpoint root");
        let width = 48;
        let height = 32;
        let mut base = GrayImage::new(width + 16, height);
        for y in 0..height {
            for x in 0..base.width() {
                base.put_pixel(
                    x,
                    y,
                    image::Luma([((x * 37 + y * 71 + x * y * 3) % 251) as u8]),
                );
            }
        }
        let ids = ["a", "b", "c", "d"];
        let mut images = Vec::new();
        for (camera_index, id) in ids.iter().enumerate() {
            let shift = u32::try_from(camera_index * 2).expect("small shift");
            let mut rgb = RgbImage::new(width, height);
            for y in 0..height {
                for x in 0..width {
                    let value = base.get_pixel(x + shift, y).0[0];
                    rgb.put_pixel(x, y, image::Rgb([value, value, value]));
                }
            }
            let relative = PathBuf::from(format!("{id}.png"));
            rgb.save(scene_root.join(&relative)).expect("save view");
            let bytes = fs::read(scene_root.join(&relative)).expect("view bytes");
            images.push(MvsSceneImage {
                image_id: (*id).into(),
                relative_path: relative,
                sha256: ObjectHash::of_bytes(&bytes),
                mask_relative_path: None,
                mask_sha256: None,
                width,
                height,
                camera: MvsPinholeCamera {
                    fx: 20.0,
                    fy: 20.0,
                    cx: 24.0,
                    cy: 16.0,
                    world_to_camera: [
                        1.0,
                        0.0,
                        0.0,
                        -(camera_index as f64),
                        0.0,
                        1.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0,
                    ],
                },
                minimum_depth: 7.0,
                maximum_depth: 14.0,
                neighbor_image_ids: ids
                    .iter()
                    .filter(|candidate| *candidate != id)
                    .map(|candidate| (*candidate).into())
                    .collect(),
            });
        }
        let scene = MvsSceneManifest {
            schema_version: 1,
            coordinate_frame_id: "synthetic".into(),
            image_mask_scope_sha256: None,
            images,
        };
        let scene_path = scene_root.join("scene.json");
        let scene_bytes = serde_json::to_vec_pretty(&scene).expect("scene json");
        fs::write(&scene_path, &scene_bytes).expect("write scene");
        let settings = MvsSettings {
            maximum_image_dimension: 256,
            tile_size: 128,
            tile_overlap: 8,
            pyramid_levels: 1,
            patch_radius: 1,
            patchmatch_iterations: 2,
            depth_hypotheses: 32,
            matching_views: 3,
            minimum_consistent_views: 2,
            geometric_relative_tolerance: 0.2,
            minimum_confidence: 0.01,
            retain_confidence_attribute: true,
            calculate_colors: true,
            checkpoint_every_tiles: 1,
        };
        let settings_sha256 =
            ObjectHash::of_bytes(&serde_json::to_vec(&settings).expect("settings serialization"));
        let worker_request = MvsWorkerRequest {
            schema_version: 1,
            job_id: "synthetic-e2e".into(),
            scene_manifest_path: scene_path.clone(),
            scene_manifest_sha256: ObjectHash::of_bytes(&scene_bytes),
            settings: settings.clone(),
            settings_sha256: settings_sha256.clone(),
            device: MvsComputeDevice::Cpu { threads: 1 },
            fuse_dense_point_cloud: true,
            output_path: output.clone(),
            checkpoint_path: checkpoints.clone(),
            resume_checkpoint_path: None,
            resume_geometric_consistency_complete: false,
            network_policy: "offlineOnly".into(),
        };
        run_cpu(
            &worker_request,
            &scene,
            &scene_root,
            &AtomicBool::new(false),
        )
        .expect("full worker pipeline");
        let public_request = MvsRunRequest {
            job_id: worker_request.job_id.clone(),
            scene_manifest_path: scene_path,
            scene_manifest_sha256: worker_request.scene_manifest_sha256,
            device: worker_request.device,
            settings,
            fuse_dense_point_cloud: true,
            resume: None,
        };
        let validated = validate_output_directory(
            &output,
            &public_request,
            &scene,
            &settings_sha256,
            &himmelcad_core::photolab_jobs::CancellationToken::new(),
        )
        .expect("runtime validates worker output");
        assert_eq!(validated.depth_images.len(), 4);
        let dense_record = validated.dense_point_cloud.expect("dense point cloud");
        let fusion = dense_record.fusion.expect("fusion evidence");
        assert_eq!(fusion.algorithm, MVS_DENSE_FUSION_ALGORITHM);
        assert!(fusion.raw_sample_count >= fusion.fused_sample_count);
        assert_eq!(fusion.fused_sample_count, dense_record.vertex_count);
        let final_checkpoint: MvsCheckpoint = serde_json::from_slice(
            &fs::read(checkpoints.join("checkpoint-000000000004.json")).expect("final checkpoint"),
        )
        .expect("checkpoint json");
        assert!(final_checkpoint.geometric_consistency_complete);
        let dense = fs::read(output.join("dense.ply")).expect("dense PLY");
        assert!(dense
            .windows(b"property double x".len())
            .any(|window| window == b"property double x"));
        assert!(dense
            .windows(b"property float nx".len())
            .any(|window| window == b"property float nx"));
    }

    fn test_camera(tx: f64) -> MvsPinholeCamera {
        MvsPinholeCamera {
            fx: 40.0,
            fy: 40.0,
            cx: 48.0,
            cy: 32.0,
            world_to_camera: [1.0, 0.0, 0.0, tx, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        }
    }
}
