//! Bounded Photolab worker orchestration for the sidecar.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use fs2::FileExt;
use himmelcad_core::{
    entity::EntityId,
    hash::ObjectHash,
    photolab_jobs::{
        CancellationToken, CheckpointCommitState, CheckpointDescriptor, CheckpointId, JobError,
        JobProgress, NewPhotolabJob, PhotolabJob, PhotolabJobDiskEstimate, PhotolabJobId,
        PhotolabJobKind, PhotolabJobMemory, PhotolabJobState, PhotolabMatchingMemoryReplan,
        PhotolabMemoryDegradation, PhotolabMemoryObservation, PhotolabMemoryTimeFirstChoice,
        PhotolabRasterPreparationMemory, PhotolabRasterPreparationStageMemory, PhotolabStageMemory,
        PhotolabWorkerTool, CHECKPOINT_SCHEMA_VERSION,
    },
    photolab_products::ProductKind,
};
use serde::{Deserialize, Serialize};
use tokio::{
    runtime::Handle,
    sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore},
    time::{sleep, timeout_at, Duration, Instant as TokioInstant},
};

// WP-B6 calibration governed by the release-polish plan's tunables register: 500 ms
// bounds memory-only terminal history without hot-looping a persistently failing disk.
const HISTORY_RETRY_INTERVAL: Duration = Duration::from_millis(500);

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

// WP-G1a-3g X6 tunables, derived from the 2026-09-10 45.8 M-point DSM probe:
// 3.3 GB CSV ~= 72.1 B/point, 4.0 GB FlatGeobuf ~= 87.4 B/point, and 2.9 GB
// GDAL temporary storage ~= 63.4 B/point. Each byte rate is rounded up so
// admission remains conservative as coordinate widths vary.
const DENSE_RASTER_CSV_BYTES_PER_POINT: u64 = 73;
const DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT: u64 = 88;
// Measured 2026-09-10 on the 45.8 M-point Sulzberg cloud: the CSV → FlatGeobuf →
// gdal_grid pipeline drove free space from 14.0 GB to zero (ENOSPC) although the
// scratch directory itself peaked at 10.5 GB; the difference is GDAL/OGR temporary
// and page-cache-backed writes that only show up as consumed space. The temp term
// therefore carries the whole measured gap (14.0 GB / 45.8 M ≈ 306 B/point in total).
const DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT: u64 = 145;
const DENSE_RASTER_HEADROOM_NUMERATOR: u64 = 11;
const DENSE_RASTER_HEADROOM_DENOMINATOR: u64 = 10;

// WP-A7j-b X6 calibration from the 2026-09-10 45.8 M-point Sulzberg DTM run:
// ogr2ogr peaked at 4.65 GB RSS (4.65 GB / 45.8 M ~= 101.5 B/point), so the
// measured rate is rounded to 100 B/point; gdal_grid's existing model remains
// 70 B/point pending a sampled production run through its worker scope.
// A 256 MiB fixed term covers process startup, GDAL metadata, and small jobs.
pub const RASTER_PREPARATION_BASE_BYTES: u64 = 256 * MIB;
pub const OGR2OGR_MEMORY_BYTES_PER_POINT: u64 = 100;
pub const GDAL_GRID_MEMORY_BYTES_PER_POINT: u64 = 70;
// The hard scope limit retains the existing A7 25% model headroom. File-backed
// pages are charged to the worker cgroup too, so add 1.5x of the stage's measured
// write working set instead of treating page cache as free memory.
const RASTER_PREPARATION_MODEL_HEADROOM_NUMERATOR: u64 = 5;
const RASTER_PREPARATION_MODEL_HEADROOM_DENOMINATOR: u64 = 4;
const RASTER_PREPARATION_WRITE_HEADROOM_NUMERATOR: u64 = 3;
const RASTER_PREPARATION_WRITE_HEADROOM_DENOMINATOR: u64 = 2;
const MINIMUM_RASTER_PREPARATION_LIMIT_BYTES: u64 = 2 * GIB;
pub const DEM_NEEDS_MORE_MEMORY_CODE: &str = "insufficientMemory";
pub const DEM_NEEDS_MORE_MEMORY_MESSAGE: &str = "DEM needs more memory than this machine has";
pub const OGR2OGR_PREPARATION_STAGE: &str = "Prepare dense points with ogr2ogr";
pub const GDAL_GRID_PREPARATION_STAGE: &str = "Rasterize DEM with gdal_grid";

// WP-A7 X6 calibration: the measured 21 MP ALIKED_N32 extraction used 15.7 GB,
// which is approximately 750 bytes per actual resized pixel. A later measured
// job may supply its observed calibration instead of this initial value.
pub const BYTES_PER_ACTUAL_PIXEL: u64 = 750;
/// WP-A7e X6 calibration for LightGlue's resident memory: twelve fp32
/// attention-sized activation layers plus the fixed base reproduce both
/// 2026-09-09 Sulzberg OOM incidents at 8,122 merged keypoints. Eight matcher
/// threads reached 28.8 GB and 26.4 GB anon RSS; this model predicts 27.5 GB.
pub const NEURAL_MATCHING_ATTENTION_LAYERS: u64 = 12;
pub const NEURAL_MATCHING_FIXED_BASE_BYTES: u64 = 256 * MIB;
pub const SIFT_MATCHING_BYTES_PER_WORKER: u64 = 256 * MIB;
// WP-A7 X6 policy: matching receives half the usable envelope so the sidecar,
// database cache, and publication path retain bounded headroom.
const MATCHING_STAGE_SHARE_NUMERATOR: u64 = 1;
const MATCHING_STAGE_SHARE_DENOMINATOR: u64 = 2;
/// Owner S23 (2026-09-08): PhotoLab uses all the memory the machine has, so neural
/// extraction workers are bounded only by the memory model (750 B per actual pixel per
/// worker, measured) and the logical CPU count — no fixed cap. On the 32 GB reference
/// laptop the model yields one worker; a 64 GB machine gets three.
const MAX_NEURAL_EXTRACTION_WORKERS: u16 = u16::MAX;
const EDGE_QUANTUM: u32 = 256;
const KEYPOINT_QUANTUM: u32 = 500;
// WP-A7b X6 tunable: 256 px is twice ALIKED's 128 px descriptor support, so a
// feature whose support crosses a tile boundary is fully represented in an overlap.
pub const EXTRACTION_TILE_OVERLAP_PX: u32 = 256;
// WP-A7b X6 tunable: tiles smaller than 1,024 px discard too much scene context;
// below this floor the explicit extraction-edge quality fallback applies instead.
pub const MIN_EXTRACTION_TILE_EDGE_PX: u32 = 1_024;
pub const ALIGNMENT_NEEDS_UNTILED_EXTRACTION_CODE: &str = "alignmentNeedsUntiledExtraction";
pub const ALIGNMENT_NEEDS_UNTILED_EXTRACTION_MESSAGE: &str =
    "Quality Hybrid needs untiled extraction on this machine — choose the Fast profile or reduce the image size";

/// Inputs known before an alignment job becomes visible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentMemoryRequest {
    pub usable_bytes: u64,
    pub logical_cpus: u16,
    pub image_dimensions: Vec<(u32, u32)>,
    pub max_image_edge: u32,
    pub keypoints: u32,
    pub neural_matching: bool,
    pub measured_extraction_bytes_per_pixel: Option<u64>,
}

/// Frozen time-first and quality-last choices applied to an alignment request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentMemoryPlan {
    pub memory: PhotolabJobMemory,
    pub extraction_edge: u32,
    pub keypoints: u32,
    pub extraction_workers: u16,
    pub matching_workers: u16,
    pub matching_unit_bytes: u64,
    pub extraction_unit_bytes: u64,
    pub matching_replanned: Option<PhotolabMatchingMemoryReplan>,
    pub sequential_pair_batches: bool,
    pub extraction_tiling: Option<AlignmentExtractionTiling>,
    pub predicted_peak_bytes: u64,
}

/// Deterministic grid for the largest resized image in one alignment admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentExtractionTiling {
    pub columns: u32,
    pub rows: u32,
    pub tiles: u32,
    pub overlap_px: u32,
}

/// Matcher settings recomputed from the database that will actually be consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentMatchingReplan {
    pub record: PhotolabMatchingMemoryReplan,
    pub keypoint_cap: u32,
    pub degradation: Option<PhotolabMemoryDegradation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlignmentMatchingMemoryRefusal {
    pub predicted_bytes: u64,
    pub available_bytes: u64,
}

/// One sequential DEM preparation unit and the resident cap applied to its worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterPreparationStagePlan {
    pub stage: &'static str,
    pub model_bytes: u64,
    pub resident_limit_bytes: u64,
}

/// Immutable dense-point-derived choices frozen before a DEM job becomes visible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterPreparationMemoryPlan {
    pub memory: PhotolabJobMemory,
    pub ogr2ogr: RasterPreparationStagePlan,
    pub gdal_grid: RasterPreparationStagePlan,
    pub predicted_peak_bytes: u64,
    pub refusal: Option<JobAdmissionRefusal>,
}

/// Plans the two sequential native preparation workers for a DEM.
#[must_use]
pub fn plan_raster_preparation_memory(
    point_count: u64,
    raster_output_bytes: u64,
    usable_bytes: u64,
) -> RasterPreparationMemoryPlan {
    let ogr2ogr_model_bytes = point_count
        .saturating_mul(OGR2OGR_MEMORY_BYTES_PER_POINT)
        .saturating_add(RASTER_PREPARATION_BASE_BYTES);
    let gdal_grid_model_bytes = point_count
        .saturating_mul(GDAL_GRID_MEMORY_BYTES_PER_POINT)
        .saturating_add(RASTER_PREPARATION_BASE_BYTES);
    let ogr2ogr_write_bytes = point_count.saturating_mul(DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT);
    let gdal_grid_write_bytes = point_count
        .saturating_mul(DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT)
        .saturating_add(raster_output_bytes);
    let ogr2ogr_limit_bytes =
        raster_preparation_limit_bytes(ogr2ogr_model_bytes, ogr2ogr_write_bytes);
    let gdal_grid_limit_bytes =
        raster_preparation_limit_bytes(gdal_grid_model_bytes, gdal_grid_write_bytes);
    let ogr2ogr = RasterPreparationStagePlan {
        stage: OGR2OGR_PREPARATION_STAGE,
        model_bytes: ogr2ogr_model_bytes,
        resident_limit_bytes: ogr2ogr_limit_bytes,
    };
    let gdal_grid = RasterPreparationStagePlan {
        stage: GDAL_GRID_PREPARATION_STAGE,
        model_bytes: gdal_grid_model_bytes,
        resident_limit_bytes: gdal_grid_limit_bytes,
    };
    let predicted_peak_bytes = ogr2ogr_limit_bytes.max(gdal_grid_limit_bytes);
    let refusal = (predicted_peak_bytes > usable_bytes).then(|| JobAdmissionRefusal {
        code: DEM_NEEDS_MORE_MEMORY_CODE.into(),
        message: DEM_NEEDS_MORE_MEMORY_MESSAGE.into(),
    });
    let memory = PhotolabJobMemory {
        envelope_bytes: usable_bytes,
        stages: vec![
            raster_preparation_stage_record(
                ogr2ogr,
                OGR2OGR_MEMORY_BYTES_PER_POINT,
                ogr2ogr_write_bytes,
            ),
            raster_preparation_stage_record(
                gdal_grid,
                GDAL_GRID_MEMORY_BYTES_PER_POINT,
                gdal_grid_write_bytes,
            ),
        ],
        time_first_choices: Vec::new(),
        degradations: Vec::new(),
        observations: Vec::new(),
        matching_replanned: None,
        raster_preparation: Some(PhotolabRasterPreparationMemory {
            point_count,
            ogr2ogr: PhotolabRasterPreparationStageMemory {
                model_bytes: ogr2ogr_model_bytes,
                resident_limit_bytes: ogr2ogr_limit_bytes,
            },
            gdal_grid: PhotolabRasterPreparationStageMemory {
                model_bytes: gdal_grid_model_bytes,
                resident_limit_bytes: gdal_grid_limit_bytes,
            },
        }),
    };
    RasterPreparationMemoryPlan {
        memory,
        ogr2ogr,
        gdal_grid,
        predicted_peak_bytes,
        refusal,
    }
}

fn raster_preparation_limit_bytes(model_bytes: u64, write_bytes: u64) -> u64 {
    let model_with_headroom = model_bytes
        .saturating_mul(RASTER_PREPARATION_MODEL_HEADROOM_NUMERATOR)
        .div_ceil(RASTER_PREPARATION_MODEL_HEADROOM_DENOMINATOR);
    let write_working_set = write_bytes
        .saturating_mul(RASTER_PREPARATION_WRITE_HEADROOM_NUMERATOR)
        .div_ceil(RASTER_PREPARATION_WRITE_HEADROOM_DENOMINATOR);
    model_with_headroom
        .saturating_add(write_working_set)
        .max(MINIMUM_RASTER_PREPARATION_LIMIT_BYTES)
}

fn raster_preparation_stage_record(
    plan: RasterPreparationStagePlan,
    bytes_per_point: u64,
    write_working_set_bytes: u64,
) -> PhotolabStageMemory {
    PhotolabStageMemory {
        stage: plan.stage.into(),
        peak_rss_bytes: 0,
        workers: 1,
        parameters: serde_json::json!({
            "baseBytes": RASTER_PREPARATION_BASE_BYTES,
            "bytesPerPoint": bytes_per_point,
            "modelBytes": plan.model_bytes,
            "writeWorkingSetBytes": write_working_set_bytes,
            "workerMemoryLimitBytes": plan.resident_limit_bytes,
        }),
    }
}

/// Neural extraction estimate for one image after long-edge resize.
#[must_use]
pub fn extraction_bytes_for_image(
    width: u32,
    height: u32,
    max_image_edge: u32,
    bytes_per_actual_pixel: u64,
) -> u64 {
    resized_pixel_count(width, height, max_image_edge).saturating_mul(bytes_per_actual_pixel)
}

/// LightGlue estimate for one worker at the requested keypoint cap.
#[must_use]
pub fn neural_matching_bytes_per_worker(keypoints: u32) -> u64 {
    u64::from(keypoints)
        .saturating_mul(u64::from(keypoints))
        .saturating_mul(4)
        .saturating_mul(NEURAL_MATCHING_ATTENTION_LAYERS)
        .saturating_add(NEURAL_MATCHING_FIXED_BASE_BYTES)
}

/// Resident-memory limit for one matcher attempt.
///
/// WP-A7f X6 policy: matching owns half of the usable envelope. The limit deliberately does not
/// depend on the calibration model because the Sulzberg incidents showed that matcher RSS is not
/// linear in thread count; the retry ladder discovers a safe count inside this fixed stage share.
#[must_use]
pub const fn matching_stage_memory_limit_bytes(usable_bytes: u64) -> u64 {
    usable_bytes.saturating_mul(MATCHING_STAGE_SHARE_NUMERATOR) / MATCHING_STAGE_SHARE_DENOMINATOR
}

/// Replans LightGlue from the maximum stored row count immediately before matching.
///
/// The admission cap remains authoritative even if a worker or an old extracted-feature cache
/// contains more rows. Stage share limits concurrency; only a single unit exceeding the complete
/// usable envelope permits an additional quality cap (owner D12/S23).
pub fn replan_alignment_matching(
    usable_bytes: u64,
    logical_cpus: u16,
    planned_keypoint_cap: u32,
    actual_max_keypoints: u32,
) -> Result<AlignmentMatchingReplan, AlignmentMatchingMemoryRefusal> {
    let mut keypoint_cap = actual_max_keypoints.min(planned_keypoint_cap);
    let mut degradation = (actual_max_keypoints > keypoint_cap).then(|| {
        PhotolabMemoryDegradation::MatchingKeypointsCapped {
            from: actual_max_keypoints,
            to: keypoint_cap,
        }
    });
    let mut matching_unit_bytes = neural_matching_bytes_per_worker(keypoint_cap);
    if matching_unit_bytes > usable_bytes {
        if keypoint_cap < KEYPOINT_QUANTUM {
            return Err(AlignmentMatchingMemoryRefusal {
                predicted_bytes: matching_unit_bytes,
                available_bytes: usable_bytes,
            });
        }
        let capped = largest_keypoint_cap_that_fits(keypoint_cap, usable_bytes);
        let capped_unit = neural_matching_bytes_per_worker(capped);
        if capped >= keypoint_cap || capped_unit > usable_bytes {
            return Err(AlignmentMatchingMemoryRefusal {
                predicted_bytes: matching_unit_bytes,
                available_bytes: usable_bytes,
            });
        }
        keypoint_cap = capped;
        matching_unit_bytes = capped_unit;
        degradation = Some(PhotolabMemoryDegradation::MatchingKeypointsCapped {
            from: actual_max_keypoints,
            to: keypoint_cap,
        });
    }
    let matching_budget = matching_stage_memory_limit_bytes(usable_bytes);
    let matching_workers = u16::try_from((matching_budget / matching_unit_bytes).max(1))
        .unwrap_or(u16::MAX)
        .min(logical_cpus.max(1));
    Ok(AlignmentMatchingReplan {
        record: PhotolabMatchingMemoryReplan {
            actual_max_keypoints,
            matching_workers,
            matching_unit_bytes,
        },
        keypoint_cap,
        degradation,
    })
}

/// Computes the immutable per-machine alignment memory choices.
#[must_use]
pub fn plan_alignment_memory(request: &AlignmentMemoryRequest) -> AlignmentMemoryPlan {
    let bytes_per_pixel = request
        .measured_extraction_bytes_per_pixel
        .filter(|value| *value > 0)
        .unwrap_or(BYTES_PER_ACTUAL_PIXEL);
    let requested_edge = request.max_image_edge.max(EDGE_QUANTUM);
    let extraction_budget = request.usable_bytes;
    let mut extraction_edge = requested_edge;
    let mut degradations = Vec::new();
    let mut time_first_choices = Vec::new();
    let mut extraction_tiling = None;
    let mut extraction_unit =
        maximum_extraction_bytes(&request.image_dimensions, extraction_edge, bytes_per_pixel);
    if extraction_unit > extraction_budget {
        if let Some((tiling, tile_bytes)) = smallest_extraction_tiling_that_fits(
            &request.image_dimensions,
            requested_edge,
            extraction_budget,
            bytes_per_pixel,
        ) {
            extraction_unit = tile_bytes;
            extraction_tiling = Some(tiling);
            time_first_choices.push(PhotolabMemoryTimeFirstChoice::ExtractionTiled {
                tiles: tiling.tiles,
                overlap_px: tiling.overlap_px,
            });
        } else {
            extraction_edge = largest_extraction_edge_that_fits(
                &request.image_dimensions,
                requested_edge,
                extraction_budget,
                bytes_per_pixel,
            );
            degradations.push(PhotolabMemoryDegradation::ExtractionEdgeReduced {
                from: requested_edge,
                to: extraction_edge,
                budget_bytes: extraction_budget,
            });
            extraction_unit = maximum_extraction_bytes(
                &request.image_dimensions,
                extraction_edge,
                bytes_per_pixel,
            );
        }
    }
    let logical = request.logical_cpus.max(1);
    let extraction_workers = if extraction_unit == 0 {
        1
    } else {
        u16::try_from((extraction_budget / extraction_unit).max(1))
            .unwrap_or(u16::MAX)
            .min(logical)
            .min(MAX_NEURAL_EXTRACTION_WORKERS)
            .max(1)
    };

    let matching_budget = matching_stage_memory_limit_bytes(request.usable_bytes);
    let mut keypoints = request.keypoints.max(KEYPOINT_QUANTUM);
    let matching_model = |value| {
        if request.neural_matching {
            neural_matching_bytes_per_worker(value)
        } else {
            SIFT_MATCHING_BYTES_PER_WORKER
        }
    };
    let mut matching_unit = matching_model(keypoints);
    // Stage shares limit concurrency only. Quality changes only when one unit cannot
    // fit in the complete usable envelope even as the sole worker (owner S23).
    if request.neural_matching && matching_unit > request.usable_bytes {
        let capped = largest_keypoint_cap_that_fits(keypoints, request.usable_bytes);
        degradations.push(PhotolabMemoryDegradation::MatchingKeypointsCapped {
            from: keypoints,
            to: capped,
        });
        keypoints = capped;
        matching_unit = matching_model(keypoints);
    }
    let matching_workers = if matching_unit == 0 {
        1
    } else {
        u16::try_from((matching_budget / matching_unit).max(1))
            .unwrap_or(u16::MAX)
            .min(logical)
            .max(1)
    };
    let sequential_pair_batches = matching_workers == 1;
    let predicted_peak_bytes = extraction_unit
        .saturating_mul(u64::from(extraction_workers))
        .max(matching_unit.saturating_mul(u64::from(matching_workers)));
    let actual_pixels = extraction_unit.checked_div(bytes_per_pixel).unwrap_or(0);
    let extraction_parameters = if let Some(tiling) = extraction_tiling {
        serde_json::json!({
            "actualPixels": actual_pixels,
            "bytesPerActualPixel": bytes_per_pixel,
            "maxImageSize": extraction_edge,
            "modelBytes": extraction_unit.saturating_mul(u64::from(extraction_workers)),
            "stageBudgetBytes": extraction_budget,
            "tileColumns": tiling.columns,
            "tileRows": tiling.rows,
            "tileOverlapPx": tiling.overlap_px,
        })
    } else {
        serde_json::json!({
            "actualPixels": actual_pixels,
            "bytesPerActualPixel": bytes_per_pixel,
            "maxImageSize": extraction_edge,
            "modelBytes": extraction_unit.saturating_mul(u64::from(extraction_workers)),
            "stageBudgetBytes": extraction_budget,
        })
    };
    let memory = PhotolabJobMemory {
        envelope_bytes: request.usable_bytes,
        stages: vec![
            PhotolabStageMemory {
                stage: "Extract ALIKED".into(),
                peak_rss_bytes: 0,
                workers: extraction_workers,
                parameters: extraction_parameters,
            },
            PhotolabStageMemory {
                stage: if request.neural_matching {
                    "Match ALIKED with LightGlue".into()
                } else {
                    "Match SIFT features".into()
                },
                peak_rss_bytes: 0,
                workers: matching_workers,
                parameters: serde_json::json!({
                    "keypoints": keypoints,
                    "modelBytes": matching_unit.saturating_mul(u64::from(matching_workers)),
                    "stageBudgetBytes": matching_budget,
                    "sequentialPairBatches": sequential_pair_batches,
                }),
            },
        ],
        time_first_choices,
        degradations,
        observations: Vec::new(),
        matching_replanned: None,
        raster_preparation: None,
    };
    AlignmentMemoryPlan {
        memory,
        extraction_edge,
        keypoints,
        extraction_workers,
        matching_workers,
        matching_unit_bytes: matching_unit,
        extraction_unit_bytes: extraction_unit,
        matching_replanned: None,
        sequential_pair_batches,
        extraction_tiling,
        predicted_peak_bytes,
    }
}

fn resized_pixel_count(width: u32, height: u32, max_image_edge: u32) -> u64 {
    let longest = width.max(height);
    if longest == 0 || max_image_edge == 0 {
        return 0;
    }
    if longest <= max_image_edge {
        return u64::from(width).saturating_mul(u64::from(height));
    }
    let resized_width =
        u64::from(width).saturating_mul(u64::from(max_image_edge)) / u64::from(longest);
    let resized_height =
        u64::from(height).saturating_mul(u64::from(max_image_edge)) / u64::from(longest);
    resized_width.saturating_mul(resized_height)
}

fn maximum_extraction_bytes(dimensions: &[(u32, u32)], edge: u32, bytes_per_pixel: u64) -> u64 {
    dimensions
        .iter()
        .map(|&(width, height)| extraction_bytes_for_image(width, height, edge, bytes_per_pixel))
        .max()
        .unwrap_or(0)
}

fn resized_dimensions(width: u32, height: u32, max_image_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest == 0 || max_image_edge == 0 || longest <= max_image_edge {
        return (width, height);
    }
    let resized_width =
        u64::from(width).saturating_mul(u64::from(max_image_edge)) / u64::from(longest);
    let resized_height =
        u64::from(height).saturating_mul(u64::from(max_image_edge)) / u64::from(longest);
    (
        u32::try_from(resized_width).unwrap_or(u32::MAX),
        u32::try_from(resized_height).unwrap_or(u32::MAX),
    )
}

fn tile_extent(length: u32, count: u32, overlap: u32) -> u32 {
    let covered = u64::from(length)
        .saturating_add(u64::from(count.saturating_sub(1)).saturating_mul(u64::from(overlap)));
    u32::try_from(covered.div_ceil(u64::from(count.max(1)))).unwrap_or(u32::MAX)
}

fn maximum_tile_axis_count(length: u32) -> u32 {
    if length <= MIN_EXTRACTION_TILE_EDGE_PX {
        return 1;
    }
    let usable_step = MIN_EXTRACTION_TILE_EDGE_PX - EXTRACTION_TILE_OVERLAP_PX;
    (length - EXTRACTION_TILE_OVERLAP_PX)
        .checked_div(usable_step)
        .unwrap_or(1)
        .max(1)
}

fn smallest_extraction_tiling_that_fits(
    dimensions: &[(u32, u32)],
    requested_edge: u32,
    budget_bytes: u64,
    bytes_per_pixel: u64,
) -> Option<(AlignmentExtractionTiling, u64)> {
    let &(source_width, source_height) = dimensions
        .iter()
        .max_by_key(|&&(width, height)| resized_pixel_count(width, height, requested_edge))?;
    let (width, height) = resized_dimensions(source_width, source_height, requested_edge);
    if width == 0 || height == 0 || bytes_per_pixel == 0 {
        return None;
    }
    let minimum_width = width.min(MIN_EXTRACTION_TILE_EDGE_PX);
    let minimum_height = height.min(MIN_EXTRACTION_TILE_EDGE_PX);
    if u64::from(minimum_width)
        .saturating_mul(u64::from(minimum_height))
        .saturating_mul(bytes_per_pixel)
        > budget_bytes
    {
        return None;
    }

    let max_columns = maximum_tile_axis_count(width);
    let max_rows = maximum_tile_axis_count(height);
    let max_tiles = max_columns.saturating_mul(max_rows);
    for tiles in 2..=max_tiles {
        let mut best: Option<(u64, u32, u32)> = None;
        for columns in 1..=max_columns.min(tiles) {
            if tiles % columns != 0 {
                continue;
            }
            let rows = tiles / columns;
            if rows > max_rows {
                continue;
            }
            let tile_width = tile_extent(width, columns, EXTRACTION_TILE_OVERLAP_PX);
            let tile_height = tile_extent(height, rows, EXTRACTION_TILE_OVERLAP_PX);
            if tile_width < minimum_width || tile_height < minimum_height {
                continue;
            }
            let tile_bytes = u64::from(tile_width)
                .saturating_mul(u64::from(tile_height))
                .saturating_mul(bytes_per_pixel);
            if tile_bytes > budget_bytes {
                continue;
            }
            let candidate = (tile_bytes, columns, rows);
            if best.is_none_or(|current| candidate < current) {
                best = Some(candidate);
            }
        }
        if let Some((tile_bytes, columns, rows)) = best {
            return Some((
                AlignmentExtractionTiling {
                    columns,
                    rows,
                    tiles,
                    overlap_px: EXTRACTION_TILE_OVERLAP_PX,
                },
                tile_bytes,
            ));
        }
    }
    None
}

fn largest_extraction_edge_that_fits(
    dimensions: &[(u32, u32)],
    requested: u32,
    budget_bytes: u64,
    bytes_per_pixel: u64,
) -> u32 {
    let mut edge = requested / EDGE_QUANTUM * EDGE_QUANTUM;
    while edge > EDGE_QUANTUM
        && maximum_extraction_bytes(dimensions, edge, bytes_per_pixel) > budget_bytes
    {
        edge = edge.saturating_sub(EDGE_QUANTUM);
    }
    edge.max(EDGE_QUANTUM)
}

pub fn largest_keypoint_cap_that_fits(requested: u32, budget_bytes: u64) -> u32 {
    let mut keypoints = requested / KEYPOINT_QUANTUM * KEYPOINT_QUANTUM;
    while keypoints > KEYPOINT_QUANTUM && neural_matching_bytes_per_worker(keypoints) > budget_bytes
    {
        keypoints = keypoints.saturating_sub(KEYPOINT_QUANTUM);
    }
    keypoints.max(KEYPOINT_QUANTUM)
}

#[derive(Debug, Clone, Copy)]
struct DiskEstimateTuning {
    kind: PhotolabJobKind,
    formula: DiskEstimateFormula,
}

#[derive(Debug, Clone, Copy)]
enum DiskEstimateFormula {
    Images {
        fixed_bytes: u64,
        bytes_per_image: u64,
        multiplier_numerator: u64,
        multiplier_denominator: u64,
    },
    RasterPyramid {
        bytes_per_pixel: u64,
        overview_numerator: u64,
        overview_denominator: u64,
        scratch_output_multiplier: u64,
    },
}

// WP-B4 X6 tunables. These deliberately over-budget scratch plus output: alignment keeps a
// 2 GiB database/tool reserve plus 8 MiB per image; depth maps reserve 40 MiB per image;
// dense fusion reserves 1.5 times that depth footprint; mesh and splat cover their large
// intermediate representations with fixed 2 GiB and 6 GiB reserves. Raster work is computed
// as four times a four-byte-per-pixel pyramid; 4/3 accounts for every power-of-two overview.
const DISK_ESTIMATE_TUNING: &[DiskEstimateTuning] = &[
    DiskEstimateTuning {
        kind: PhotolabJobKind::AlignPhotos,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 2 * GIB,
            bytes_per_image: 8 * MIB,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::MergeAlignments,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 2 * GIB,
            bytes_per_image: 8 * MIB,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildDepthMaps,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 0,
            bytes_per_image: 40 * MIB,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildDensePointCloud,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 0,
            bytes_per_image: 40 * MIB,
            multiplier_numerator: 3,
            multiplier_denominator: 2,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildDem,
        formula: DiskEstimateFormula::RasterPyramid {
            bytes_per_pixel: 4,
            overview_numerator: 4,
            overview_denominator: 3,
            scratch_output_multiplier: 4,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildOrthomosaic,
        formula: DiskEstimateFormula::RasterPyramid {
            bytes_per_pixel: 4,
            overview_numerator: 4,
            overview_denominator: 3,
            scratch_output_multiplier: 4,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildMesh,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 2 * GIB,
            bytes_per_image: 0,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildGaussianSplat,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 6 * GIB,
            bytes_per_image: 0,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
];

/// Immutable publication class used to serialize jobs that could overwrite the same lineage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PublicationTargetKind {
    Alignment,
    Optimization,
    DepthMaps,
    DensePointCloud,
    Dem,
    Orthomosaic,
    TexturedMesh,
    GaussianSplat,
}

/// Publication identity captured from a frozen request before scheduler admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationTarget {
    pub kind: PublicationTargetKind,
    pub target_entity_id: EntityId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage_target: Option<EntityId>,
}

impl PublicationTarget {
    #[must_use]
    pub const fn alignment(target_entity_id: EntityId, lineage_target: Option<EntityId>) -> Self {
        Self {
            kind: PublicationTargetKind::Alignment,
            target_entity_id,
            lineage_target,
        }
    }

    #[must_use]
    pub const fn optimization(
        target_entity_id: EntityId,
        lineage_target: Option<EntityId>,
    ) -> Self {
        Self {
            kind: PublicationTargetKind::Optimization,
            target_entity_id,
            lineage_target,
        }
    }

    #[must_use]
    pub const fn product(
        kind: ProductKind,
        target_entity_id: EntityId,
        lineage_target: Option<EntityId>,
    ) -> Self {
        let kind = match kind {
            ProductKind::DepthMaps => PublicationTargetKind::DepthMaps,
            ProductKind::DensePointCloud => PublicationTargetKind::DensePointCloud,
            ProductKind::Dem => PublicationTargetKind::Dem,
            ProductKind::Orthomosaic => PublicationTargetKind::Orthomosaic,
            ProductKind::TexturedMesh => PublicationTargetKind::TexturedMesh,
            ProductKind::GaussianSplat => PublicationTargetKind::GaussianSplat,
        };
        Self {
            kind,
            target_entity_id,
            lineage_target,
        }
    }

    fn description(&self) -> (&'static str, &'static str) {
        match self.kind {
            PublicationTargetKind::Alignment => ("an alignment", "target"),
            PublicationTargetKind::Optimization => ("an optimization", "alignment"),
            PublicationTargetKind::DepthMaps => ("depth maps", "alignment"),
            PublicationTargetKind::DensePointCloud => ("a dense point cloud", "alignment"),
            PublicationTargetKind::Dem => ("a DEM", "alignment"),
            PublicationTargetKind::Orthomosaic => ("an orthomosaic", "alignment"),
            PublicationTargetKind::TexturedMesh => ("a mesh", "alignment"),
            PublicationTargetKind::GaussianSplat => ("a Gaussian splat", "alignment"),
        }
    }
}

/// Inputs whose size determines the conservative scratch-plus-output estimate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskEstimateScale {
    Images(u64),
    RasterPixels(u64),
    DenseRaster {
        point_count: u64,
        raster_pixels: u64,
    },
    Fixed,
}

/// Measured scratch and predicted output components attached to raster admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskEstimateComponents {
    pub scratch_bytes: u64,
    pub output_bytes: u64,
    pub required_bytes: u64,
}

/// One free-space check attached to an immutable job admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskPreflight {
    pub required_bytes: u64,
    pub path: PathBuf,
}

/// Memory estimate and frozen per-machine choices checked before visibility.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryPreflight {
    pub predicted_bytes: u64,
    pub available_bytes: u64,
    /// Usable machine memory before subtracting running-job reservations.
    pub machine_usable_bytes: u64,
    pub memory: PhotolabJobMemory,
    pub refusal: Option<JobAdmissionRefusal>,
}

/// A fail-closed admission outcome that remains visible as a terminal job without starting work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobAdmissionRefusal {
    pub code: String,
    pub message: String,
}

/// Resolved worker evidence and an optional fail-closed toolchain refusal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkerToolchainAdmission {
    pub tools: Vec<PhotolabWorkerTool>,
    pub refusal: Option<JobAdmissionRefusal>,
}

impl MemoryPreflight {
    /// Freezes an envelope while explicitly warning that this stage has no bound yet.
    #[must_use]
    pub fn unbounded(available_bytes: u64, stage: impl Into<String>) -> Self {
        let stage = stage.into();
        Self {
            predicted_bytes: 0,
            available_bytes,
            machine_usable_bytes: available_bytes,
            memory: PhotolabJobMemory {
                envelope_bytes: available_bytes,
                stages: Vec::new(),
                time_first_choices: Vec::new(),
                degradations: Vec::new(),
                observations: vec![PhotolabMemoryObservation::UnboundedStage {
                    stage,
                    budget_bytes: available_bytes,
                }],
                matching_replanned: None,
                raster_preparation: None,
            },
            refusal: None,
        }
    }
}

impl DiskPreflight {
    #[must_use]
    pub fn for_job(kind: PhotolabJobKind, scale: DiskEstimateScale, path: PathBuf) -> Self {
        Self {
            required_bytes: estimate_job_bytes(kind, scale),
            path,
        }
    }
}

/// Returns the components of a dense-raster estimate before its 10% admission headroom.
#[must_use]
pub fn disk_estimate_components(
    kind: PhotolabJobKind,
    scale: DiskEstimateScale,
) -> DiskEstimateComponents {
    let output_bytes = estimate_raster_output_bytes(kind, scale);
    let scratch_bytes = match scale {
        DiskEstimateScale::DenseRaster { point_count, .. } => point_count.saturating_mul(
            DENSE_RASTER_CSV_BYTES_PER_POINT
                + DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT
                + DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT,
        ),
        _ => 0,
    };
    let required_bytes = if matches!(scale, DiskEstimateScale::DenseRaster { .. }) {
        scratch_bytes
            .saturating_add(output_bytes)
            .saturating_mul(DENSE_RASTER_HEADROOM_NUMERATOR)
            .saturating_add(DENSE_RASTER_HEADROOM_DENOMINATOR - 1)
            .saturating_div(DENSE_RASTER_HEADROOM_DENOMINATOR)
    } else {
        output_bytes
    };
    DiskEstimateComponents {
        scratch_bytes,
        output_bytes,
        required_bytes,
    }
}

/// Scheduler metadata captured alongside the frozen compute request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobAdmission {
    pub publication_targets: Vec<PublicationTarget>,
    pub disk_preflight: Option<DiskPreflight>,
    pub memory_preflight: Option<MemoryPreflight>,
    pub toolchain_preflight: Option<WorkerToolchainAdmission>,
}

/// OS/UI reserve deducted before per-stage budgets are assigned.
#[must_use]
pub fn memory_os_ui_reserve_bytes(physical_memory_bytes: u64) -> u64 {
    // WP-A7 X6 tunable: reserve the larger of 4 GiB or 12.5% so small machines
    // retain a usable desktop while larger machines scale their system headroom.
    (4 * GIB).max(physical_memory_bytes / 8)
}

#[must_use]
pub fn estimate_job_bytes(kind: PhotolabJobKind, scale: DiskEstimateScale) -> u64 {
    let Some(tuning) = DISK_ESTIMATE_TUNING.iter().find(|entry| entry.kind == kind) else {
        return 0;
    };
    match (tuning.formula, scale) {
        (
            DiskEstimateFormula::Images {
                fixed_bytes,
                bytes_per_image,
                multiplier_numerator,
                multiplier_denominator,
            },
            DiskEstimateScale::Images(image_count),
        ) => fixed_bytes.saturating_add(
            bytes_per_image
                .saturating_mul(image_count)
                .saturating_mul(multiplier_numerator)
                .saturating_add(multiplier_denominator - 1)
                .saturating_div(multiplier_denominator),
        ),
        (DiskEstimateFormula::Images { fixed_bytes, .. }, DiskEstimateScale::Fixed) => fixed_bytes,
        (
            DiskEstimateFormula::RasterPyramid {
                bytes_per_pixel,
                overview_numerator,
                overview_denominator,
                scratch_output_multiplier,
            },
            DiskEstimateScale::RasterPixels(pixels)
            | DiskEstimateScale::DenseRaster {
                raster_pixels: pixels,
                ..
            },
        ) => {
            let output_bytes = pixels
                .saturating_mul(bytes_per_pixel)
                .saturating_mul(overview_numerator)
                .saturating_add(overview_denominator - 1)
                .saturating_div(overview_denominator)
                .saturating_mul(scratch_output_multiplier);
            if let DiskEstimateScale::DenseRaster { point_count, .. } = scale {
                let scratch_bytes = point_count.saturating_mul(
                    DENSE_RASTER_CSV_BYTES_PER_POINT
                        + DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT
                        + DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT,
                );
                scratch_bytes
                    .saturating_add(output_bytes)
                    .saturating_mul(DENSE_RASTER_HEADROOM_NUMERATOR)
                    .saturating_add(DENSE_RASTER_HEADROOM_DENOMINATOR - 1)
                    .saturating_div(DENSE_RASTER_HEADROOM_DENOMINATOR)
            } else {
                output_bytes
            }
        }
        _ => 0,
    }
}

fn estimate_raster_output_bytes(kind: PhotolabJobKind, scale: DiskEstimateScale) -> u64 {
    let raster_pixels = match scale {
        DiskEstimateScale::RasterPixels(raster_pixels)
        | DiskEstimateScale::DenseRaster { raster_pixels, .. } => raster_pixels,
        _ => return 0,
    };
    estimate_job_bytes(kind, DiskEstimateScale::RasterPixels(raster_pixels))
}

/// Returns the level-zero pixel count for a finite projected extent and GSD.
#[must_use]
pub fn raster_pixel_count(minimum: [f64; 3], maximum: [f64; 3], gsd: f64) -> Option<u64> {
    if !gsd.is_finite()
        || gsd <= 0.0
        || minimum[..2]
            .iter()
            .chain(&maximum[..2])
            .any(|value| !value.is_finite())
        || minimum[0] >= maximum[0]
        || minimum[1] >= maximum[1]
    {
        return None;
    }
    let width = ((maximum[0] - minimum[0]) / gsd).ceil();
    let height = ((maximum[1] - minimum[1]) / gsd).ceil();
    if width > u64::MAX as f64 || height > u64::MAX as f64 {
        return None;
    }
    (width as u64).checked_mul(height as u64)
}

type DiskAvailability = dyn Fn(&Path) -> Result<u64, String> + Send + Sync;

/// Immutable project identity captured when a job is admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobHistoryScope {
    pub project_id: String,
    pub project_root: PathBuf,
}

/// Opaque, integrity-bound request retained beside a durable job record.
///
/// The sidecar owns this value. Renderers only identify the history job they
/// want resumed and never reconstruct execution parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenJobRequest {
    pub schema_version: u32,
    pub method: String,
    pub params: serde_json::Value,
    pub job_kind: PhotolabJobKind,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub binding_sha256: ObjectHash,
}

impl FrozenJobRequest {
    pub fn new(
        method: impl Into<String>,
        params: serde_json::Value,
        job: &NewPhotolabJob,
    ) -> Result<Self, serde_json::Error> {
        let method = method.into();
        let binding_sha256 = frozen_request_binding_hash(
            &method,
            &params,
            job.kind,
            &job.config_hash,
            &job.input_hash,
        )?;
        Ok(Self {
            schema_version: 1,
            method,
            params,
            job_kind: job.kind,
            config_hash: job.config_hash.clone(),
            input_hash: job.input_hash.clone(),
            binding_sha256,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported frozen job request schema".into());
        }
        let expected = frozen_request_binding_hash(
            &self.method,
            &self.params,
            self.job_kind,
            &self.config_hash,
            &self.input_hash,
        )
        .map_err(|error| error.to_string())?;
        if self.binding_sha256 != expected {
            return Err("frozen job request binding hash does not match its payload".into());
        }
        Ok(())
    }
}

fn frozen_request_binding_hash(
    method: &str,
    params: &serde_json::Value,
    kind: PhotolabJobKind,
    config_hash: &ObjectHash,
    input_hash: &ObjectHash,
) -> Result<ObjectHash, serde_json::Error> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        1_u32,
        method,
        params,
        kind,
        config_hash,
        input_hash,
    ))?))
}

/// Project storage adapter used by the process-local scheduler.
pub trait JobHistoryPersistence: Send + Sync {
    /// Returns the project that currently owns newly admitted jobs.
    fn current_scope(&self) -> Result<Option<JobHistoryScope>, String>;

    /// Returns all durable records for the currently open project.
    fn load_current(&self) -> Result<Vec<PhotolabJob>, String>;

    /// Atomically upserts one lifecycle snapshot in its captured project.
    fn persist(
        &self,
        scope: &JobHistoryScope,
        job: &PhotolabJob,
        frozen_request: Option<&FrozenJobRequest>,
    ) -> Result<(), String>;

    /// Active project-runtime operations exposed through the global jobs surface.
    fn list_side_operations(&self) -> Result<Vec<PhotolabJob>, String> {
        Ok(Vec::new())
    }

    /// Returns an active side operation, if this history owner has one with the id.
    fn side_operation_status(
        &self,
        _job_id: &PhotolabJobId,
    ) -> Result<Option<PhotolabJob>, String> {
        Ok(None)
    }

    /// Requests cancellation from the original side-operation owner.
    fn cancel_side_operation(
        &self,
        _job_id: &PhotolabJobId,
    ) -> Result<Option<CancelJobResult>, String> {
        Ok(None)
    }
}

/// Bounded scheduling policy for one sidecar process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobManagerConfig {
    pub max_concurrency: usize,
    pub max_queued: usize,
}

impl JobManagerConfig {
    fn capacity(self) -> Result<usize, JobManagerError> {
        if self.max_concurrency == 0 {
            return Err(JobManagerError::InvalidConfig(
                "max_concurrency must be greater than zero",
            ));
        }
        self.max_concurrency
            .checked_add(self.max_queued)
            .ok_or(JobManagerError::InvalidConfig(
                "max_concurrency plus max_queued overflows usize",
            ))
    }
}

/// RPC input for `photolab.jobs.start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobParams {
    pub job: NewPhotolabJob,
}

/// Immediate response after a job was admitted to the bounded queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobResult {
    pub job: PhotolabJob,
}

/// RPC input for `photolab.jobs.list`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListJobsParams {
    #[serde(default)]
    pub include_terminal: bool,
}

/// RPC input shared by status and cancel operations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdParams {
    pub job_id: PhotolabJobId,
}

/// Result of a cancellation request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelJobResult {
    pub first_request: bool,
    pub job: PhotolabJob,
}

/// Outcome of a bounded cancellation drain before project replacement or shutdown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    /// Jobs that reached a terminal state within the requested deadline.
    pub terminal: usize,
    /// Jobs force-classified as failed after the deadline elapsed.
    pub timed_out: Vec<PhotolabJobId>,
}

impl DrainReport {
    /// An empty report proves that no jobs needed draining.
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            terminal: 0,
            timed_out: Vec::new(),
        }
    }

    /// Only a drain with no timed-out workers permits a clean project close.
    #[must_use]
    pub fn completed(&self) -> bool {
        self.timed_out.is_empty()
    }
}

/// Failure reported intentionally by a compute worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobWorkerError {
    Cancelled,
    Failed { code: String, message: String },
}

impl std::fmt::Display for JobWorkerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("job worker observed cancellation"),
            Self::Failed { code, message } => {
                write!(formatter, "job worker failed with {code}: {message}")
            }
        }
    }
}

impl std::error::Error for JobWorkerError {}

impl From<JobManagerError> for JobWorkerError {
    fn from(error: JobManagerError) -> Self {
        Self::Failed {
            code: "runtimeSink".into(),
            message: error.to_string(),
        }
    }
}

/// Result returned by a blocking compute worker.
pub type JobWorkerResult = Result<(), JobWorkerError>;

/// Cheap progress callback scoped to one job.
#[derive(Debug, Clone)]
pub struct ProgressSink {
    manager: JobManager,
    job_id: PhotolabJobId,
    stage_base: u32,
    stage_count: Option<u32>,
}

impl ProgressSink {
    /// Reports a monotone progress point to the authoritative core record.
    pub async fn report(&self, progress: JobProgress) -> Result<PhotolabJob, JobManagerError> {
        self.manager
            .update_progress(&self.job_id, self.map_progress(progress))
            .await
    }

    /// Blocking variant for code already executing inside `spawn_blocking`.
    pub fn report_blocking(&self, progress: JobProgress) -> Result<PhotolabJob, JobManagerError> {
        self.manager.runtime.block_on(
            self.manager
                .update_progress(&self.job_id, self.map_progress(progress)),
        )
    }

    fn map_progress(&self, mut progress: JobProgress) -> JobProgress {
        if let Some(stage_count) = self.stage_count {
            progress.stage.index = self.stage_base.saturating_add(progress.stage.index);
            progress.stage.stage_count = stage_count;
        }
        progress
    }
}

/// Cheap checkpoint callback scoped to one job.
#[derive(Debug, Clone)]
pub struct CheckpointSink {
    manager: JobManager,
    job_id: PhotolabJobId,
    job_kind: PhotolabJobKind,
    config_hash: ObjectHash,
    input_hash: ObjectHash,
    stage_base: u32,
    stage_count: Option<u32>,
}

impl CheckpointSink {
    /// Records a committed checkpoint descriptor.
    pub async fn record(
        &self,
        checkpoint: &CheckpointDescriptor,
    ) -> Result<PhotolabJob, JobManagerError> {
        self.manager
            .record_checkpoint(&self.job_id, checkpoint)
            .await
    }

    /// Blocking variant for code already executing inside `spawn_blocking`.
    pub fn record_blocking(
        &self,
        checkpoint: &CheckpointDescriptor,
    ) -> Result<PhotolabJob, JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_checkpoint(&self.job_id, checkpoint))
    }

    /// Returns the parent job kind represented by this sink.
    #[must_use]
    pub const fn job_kind(&self) -> PhotolabJobKind {
        self.job_kind
    }

    /// Records metadata for a payload that has already been durably committed.
    pub async fn record_committed(
        &self,
        sequence: u64,
        progress: JobProgress,
        checkpoint_id: impl Into<String>,
        payload_hash: ObjectHash,
    ) -> Result<PhotolabJob, JobManagerError> {
        let checkpoint =
            self.committed_descriptor(sequence, progress, checkpoint_id.into(), payload_hash);
        self.record(&checkpoint).await
    }

    /// Blocking variant for supervised native workers.
    pub fn record_committed_blocking(
        &self,
        sequence: u64,
        progress: JobProgress,
        checkpoint_id: impl Into<String>,
        payload_hash: ObjectHash,
    ) -> Result<PhotolabJob, JobManagerError> {
        let checkpoint =
            self.committed_descriptor(sequence, progress, checkpoint_id.into(), payload_hash);
        self.record_blocking(&checkpoint)
    }

    fn committed_descriptor(
        &self,
        sequence: u64,
        progress: JobProgress,
        checkpoint_id: String,
        payload_hash: ObjectHash,
    ) -> CheckpointDescriptor {
        CheckpointDescriptor {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            checkpoint_id: CheckpointId(checkpoint_id),
            job_id: self.job_id.clone(),
            job_kind: self.job_kind,
            sequence,
            progress: self.map_progress(progress),
            config_hash: self.config_hash.clone(),
            input_hash: self.input_hash.clone(),
            commit_state: CheckpointCommitState::Committed { payload_hash },
        }
    }

    fn map_progress(&self, mut progress: JobProgress) -> JobProgress {
        if let Some(stage_count) = self.stage_count {
            progress.stage.index = self.stage_base.saturating_add(progress.stage.index);
            progress.stage.stage_count = stage_count;
        }
        progress
    }
}

/// Cheap diagnostic callback scoped to one job.
#[derive(Debug, Clone)]
pub struct JobDiagnosticSink {
    manager: JobManager,
    job_id: PhotolabJobId,
}

/// Cheap memory-evidence callback scoped to one job.
#[derive(Debug, Clone)]
pub struct JobMemorySink {
    manager: JobManager,
    job_id: PhotolabJobId,
}

impl JobMemorySink {
    /// Persists a sampled subprocess-group peak from blocking worker code.
    pub fn record_stage_peak_blocking(
        &self,
        stage: impl Into<String>,
        peak_rss_bytes: u64,
        workers: u16,
        parameters: serde_json::Value,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_stage_memory(
                &self.job_id,
                PhotolabStageMemory {
                    stage: stage.into(),
                    peak_rss_bytes,
                    workers,
                    parameters,
                },
            ))
    }

    /// Records an uncalibrated stage as warning-level typed evidence.
    pub fn record_unbounded_stage_blocking(
        &self,
        stage: impl Into<String>,
    ) -> Result<(), JobManagerError> {
        self.manager.runtime.block_on(
            self.manager
                .record_unbounded_memory_stage(&self.job_id, stage.into()),
        )
    }

    /// Persists the database-derived matcher plan before the matcher can start.
    pub fn record_matching_replan_blocking(
        &self,
        replan: PhotolabMatchingMemoryReplan,
        keypoint_cap: u32,
        degradation: Option<PhotolabMemoryDegradation>,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_matching_replan(
                &self.job_id,
                replan,
                keypoint_cap,
                degradation,
            ))
    }

    /// Persists a child-process envelope breach before returning the typed worker error.
    pub fn record_worker_memory_limit_hit_blocking(
        &self,
        stage: impl Into<String>,
        limit_bytes: u64,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_worker_memory_limit_hit(
                &self.job_id,
                stage.into(),
                limit_bytes,
            ))
    }

    /// Persists one matcher thread-count fallback before the next attempt starts.
    pub fn record_matching_threads_halved_blocking(
        &self,
        from: u16,
        to: u16,
        observed_peak_bytes: u64,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_matching_threads_halved(
                &self.job_id,
                from,
                to,
                observed_peak_bytes,
            ))
    }

    /// Records the thread count used by the successful matcher attempt.
    pub fn record_matching_threads_blocking(
        &self,
        stage: impl Into<String>,
        threads: u16,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(
                self.manager
                    .record_matching_threads(&self.job_id, stage.into(), threads),
            )
    }
}

impl JobDiagnosticSink {
    /// Persists a non-fatal diagnostic from blocking worker code.
    pub fn record_blocking(&self, diagnostic: impl Into<String>) -> Result<(), JobManagerError> {
        self.manager.runtime.block_on(
            self.manager
                .record_terminal_diagnostic(&self.job_id, diagnostic.into()),
        )
    }
}

/// Capabilities handed to a blocking Photolab compute worker.
#[derive(Debug, Clone)]
pub struct JobWorkerContext {
    pub cancellation: CancellationToken,
    pub progress: ProgressSink,
    pub checkpoints: CheckpointSink,
    pub diagnostics: JobDiagnosticSink,
    pub memory: JobMemorySink,
}

impl JobWorkerContext {
    /// Converts the core cancellation signal into the worker result contract.
    pub fn check_cancelled(&self) -> JobWorkerResult {
        self.cancellation
            .check()
            .map_err(|_| JobWorkerError::Cancelled)
    }

    /// Maps a worker-local stage plan into one immutable parent job plan.
    #[must_use]
    pub fn with_progress_window(&self, stage_base: u32, stage_count: u32) -> Self {
        let mut mapped = self.clone();
        mapped.progress.stage_base = stage_base;
        mapped.progress.stage_count = Some(stage_count);
        mapped.checkpoints.stage_base = stage_base;
        mapped.checkpoints.stage_count = Some(stage_count);
        mapped
    }
}

struct ManagedJob {
    job: PhotolabJob,
    publication_targets: Vec<PublicationTarget>,
    cancellation: CancellationToken,
    updates: watch::Sender<PhotolabJob>,
    worker_updates: watch::Sender<bool>,
    worker_active: bool,
    history_scope: Option<JobHistoryScope>,
    frozen_request: Option<FrozenJobRequest>,
    history_dirty: bool,
    last_history_persisted_at: Instant,
    memory_reservation_bytes: u64,
}

struct JobManagerInner {
    config: JobManagerConfig,
    capacity: usize,
    concurrency: Arc<Semaphore>,
    jobs: Mutex<BTreeMap<String, ManagedJob>>,
    history: Option<Arc<dyn JobHistoryPersistence>>,
    disk_availability: Arc<DiskAvailability>,
    draining: AtomicBool,
}

/// Thread-safe and Tokio-safe bounded job registry and supervisor.
#[derive(Clone)]
pub struct JobManager {
    inner: Arc<JobManagerInner>,
    runtime: Handle,
}

impl std::fmt::Debug for JobManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("JobManager")
            .field("config", &self.inner.config)
            .finish_non_exhaustive()
    }
}

impl JobManager {
    /// Creates a manager attached to the current Tokio runtime.
    pub fn new(config: JobManagerConfig) -> Result<Self, JobManagerError> {
        let runtime = Handle::try_current().map_err(|_| JobManagerError::NoTokioRuntime)?;
        Self::with_runtime_and_history(config, runtime, None)
    }

    /// Creates a manager whose lifecycle records are durable per project.
    pub fn new_with_history(
        config: JobManagerConfig,
        history: Arc<dyn JobHistoryPersistence>,
    ) -> Result<Self, JobManagerError> {
        let runtime = Handle::try_current().map_err(|_| JobManagerError::NoTokioRuntime)?;
        Self::with_runtime_and_history(config, runtime, Some(history))
    }

    /// Creates a manager for an explicitly supplied runtime handle.
    pub fn with_runtime(
        config: JobManagerConfig,
        runtime: Handle,
    ) -> Result<Self, JobManagerError> {
        Self::with_runtime_and_history(config, runtime, None)
    }

    fn with_runtime_and_history(
        config: JobManagerConfig,
        runtime: Handle,
        history: Option<Arc<dyn JobHistoryPersistence>>,
    ) -> Result<Self, JobManagerError> {
        Self::with_runtime_history_and_disk_availability(
            config,
            runtime,
            history,
            Arc::new(system_available_bytes),
        )
    }

    fn with_runtime_history_and_disk_availability(
        config: JobManagerConfig,
        runtime: Handle,
        history: Option<Arc<dyn JobHistoryPersistence>>,
        disk_availability: Arc<DiskAvailability>,
    ) -> Result<Self, JobManagerError> {
        let capacity = config.capacity()?;
        let inner = Arc::new(JobManagerInner {
            config,
            capacity,
            concurrency: Arc::new(Semaphore::new(config.max_concurrency)),
            jobs: Mutex::new(BTreeMap::new()),
            history,
            disk_availability,
            draining: AtomicBool::new(false),
        });
        if inner.history.is_some() {
            let weak_inner = Arc::downgrade(&inner);
            runtime.spawn(async move {
                loop {
                    sleep(HISTORY_RETRY_INTERVAL).await;
                    let Some(inner) = weak_inner.upgrade() else {
                        break;
                    };
                    let history = inner.history.clone();
                    let mut jobs = inner.jobs.lock().await;
                    for managed in jobs.values_mut() {
                        retry_history_persistence(history.as_ref(), managed);
                    }
                }
            });
        }
        Ok(Self { inner, runtime })
    }

    /// Admits a job without waiting for a worker slot or blocking the RPC loop.
    pub async fn start<F>(
        &self,
        request: NewPhotolabJob,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        self.start_inner(request, None, JobAdmission::default(), None, work)
            .await
    }

    /// Admits a job with publication serialization and an optional free-space preflight.
    pub async fn start_with_admission<F>(
        &self,
        request: NewPhotolabJob,
        admission: JobAdmission,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        self.start_inner(request, None, admission, None, work).await
    }

    /// Admits a resumable job and atomically retains its sidecar-owned request.
    pub async fn start_with_frozen_request<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: FrozenJobRequest,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        frozen_request
            .validate()
            .map_err(JobManagerError::InvalidFrozenRequest)?;
        if frozen_request.job_kind != request.kind
            || frozen_request.config_hash != request.config_hash
            || frozen_request.input_hash != request.input_hash
        {
            return Err(JobManagerError::InvalidFrozenRequest(
                "frozen request identity does not match the admitted job".into(),
            ));
        }
        self.start_inner(
            request,
            Some(frozen_request),
            JobAdmission::default(),
            None,
            work,
        )
        .await
    }

    /// Admits a resumable job with frozen publication and disk metadata.
    pub async fn start_with_frozen_request_and_admission<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: FrozenJobRequest,
        admission: JobAdmission,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        frozen_request
            .validate()
            .map_err(JobManagerError::InvalidFrozenRequest)?;
        if frozen_request.job_kind != request.kind
            || frozen_request.config_hash != request.config_hash
            || frozen_request.input_hash != request.input_hash
        {
            return Err(JobManagerError::InvalidFrozenRequest(
                "frozen request identity does not match the admitted job".into(),
            ));
        }
        self.start_inner(request, Some(frozen_request), admission, None, work)
            .await
    }

    /// Admits a resumable raster job and records its measured scratch estimate before visibility.
    pub async fn start_with_frozen_request_and_disk_admission<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: FrozenJobRequest,
        admission: JobAdmission,
        disk_estimate: DiskEstimateComponents,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        frozen_request
            .validate()
            .map_err(JobManagerError::InvalidFrozenRequest)?;
        if frozen_request.job_kind != request.kind
            || frozen_request.config_hash != request.config_hash
            || frozen_request.input_hash != request.input_hash
        {
            return Err(JobManagerError::InvalidFrozenRequest(
                "frozen request identity does not match the admitted job".into(),
            ));
        }
        self.start_inner(
            request,
            Some(frozen_request),
            admission,
            Some(disk_estimate),
            work,
        )
        .await
    }

    /// Test and non-resumable counterpart of raster disk admission.
    pub async fn start_with_disk_admission<F>(
        &self,
        request: NewPhotolabJob,
        admission: JobAdmission,
        disk_estimate: DiskEstimateComponents,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        self.start_inner(request, None, admission, Some(disk_estimate), work)
            .await
    }

    async fn start_inner<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: Option<FrozenJobRequest>,
        mut admission: JobAdmission,
        disk_estimate: Option<DiskEstimateComponents>,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        if self.inner.draining.load(Ordering::Acquire) {
            return Err(JobManagerError::SchedulerDraining);
        }
        let mut unique_targets = Vec::with_capacity(admission.publication_targets.len());
        for target in admission.publication_targets.drain(..) {
            if !unique_targets.contains(&target) {
                unique_targets.push(target);
            }
        }
        admission.publication_targets = unique_targets;
        let refusal = admission
            .toolchain_preflight
            .as_ref()
            .and_then(|preflight| preflight.refusal.clone())
            .or_else(|| {
                admission
                    .memory_preflight
                    .as_ref()
                    .and_then(|preflight| preflight.refusal.clone())
            });
        if disk_estimate.is_some() && admission.disk_preflight.is_none() {
            return Err(JobManagerError::DiskPreflight(
                "disk estimate has no matching free-space preflight".into(),
            ));
        }
        let mut admitted_disk_estimate = None;
        if refusal.is_none() {
            if let Some(preflight) = admission.disk_preflight.as_ref() {
                if let Some(components) = disk_estimate {
                    if components.required_bytes != preflight.required_bytes {
                        return Err(JobManagerError::DiskPreflight(format!(
                            "disk estimate requires {} bytes but preflight requires {} bytes",
                            components.required_bytes, preflight.required_bytes
                        )));
                    }
                }
                let path = preflight.path.clone();
                let required_bytes = preflight.required_bytes;
                let availability = Arc::clone(&self.inner.disk_availability);
                let available_bytes = tokio::task::spawn_blocking(move || availability(&path))
                    .await
                    .map_err(|error| JobManagerError::DiskPreflight(error.to_string()))?
                    .map_err(JobManagerError::DiskPreflight)?;
                if available_bytes < required_bytes {
                    return Err(JobManagerError::InsufficientDisk {
                        required_bytes,
                        available_bytes,
                        path: preflight.path.clone(),
                        job_kind: disk_estimate.map(|_| request.kind),
                        scratch_bytes: disk_estimate.map(|estimate| estimate.scratch_bytes),
                    });
                }
                if let Some(components) = disk_estimate {
                    admitted_disk_estimate = Some(PhotolabJobDiskEstimate {
                        scratch_bytes: components.scratch_bytes,
                        output_bytes: components.output_bytes,
                        available_bytes,
                        volume: preflight.path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
        if refusal.is_none() {
            if let Some(preflight) = admission.memory_preflight.as_ref() {
                if preflight.predicted_bytes > preflight.available_bytes {
                    return Err(JobManagerError::InsufficientMemory {
                        predicted_bytes: preflight.predicted_bytes,
                        available_bytes: preflight.available_bytes,
                    });
                }
            }
        }
        let mut job = PhotolabJob::new(request)?;
        if let Some(preflight) = admission.toolchain_preflight.as_ref() {
            job.set_toolchain(preflight.tools.clone());
        }
        if let Some(preflight) = admission.memory_preflight.as_ref() {
            job.set_memory_plan(preflight.memory.clone());
        }
        if let Some(disk_estimate) = admitted_disk_estimate {
            job.set_disk_estimate(disk_estimate);
        }
        if let Some(refusal) = refusal.as_ref() {
            job.transition_to(PhotolabJobState::Failed {
                code: refusal.code.clone(),
                message: refusal.message.clone(),
            })?;
        }
        let key = job.id.0.clone();
        let cancellation = CancellationToken::new();
        let history_scope = self.current_history_scope()?;
        if self.inner.history.is_some() && history_scope.is_none() {
            return Err(JobManagerError::HistoryPersistence(
                "no PhotoLab project is open for this job".into(),
            ));
        }
        {
            let mut jobs = self.inner.jobs.lock().await;
            if self.inner.draining.load(Ordering::Acquire) {
                return Err(JobManagerError::SchedulerDraining);
            }
            if jobs.contains_key(&key) {
                return Err(JobManagerError::DuplicateJobId(job.id));
            }
            if refusal.is_none() {
                if let Some(preflight) = admission.memory_preflight.as_ref() {
                    let running_holds = jobs
                        .values()
                        .filter(|managed| managed.job.state == PhotolabJobState::Running)
                        .map(|managed| managed.memory_reservation_bytes)
                        .fold(0_u64, u64::saturating_add);
                    let available_bytes =
                        preflight.machine_usable_bytes.saturating_sub(running_holds);
                    if preflight.predicted_bytes > available_bytes {
                        return Err(JobManagerError::InsufficientMemory {
                            predicted_bytes: preflight.predicted_bytes,
                            available_bytes,
                        });
                    }
                    job.memory.envelope_bytes = available_bytes;
                }
            }
            if refusal.is_none() {
                for managed in jobs
                    .values()
                    .filter(|managed| !is_terminal(&managed.job.state))
                {
                    if let Some(target) = admission
                        .publication_targets
                        .iter()
                        .find(|target| managed.publication_targets.contains(target))
                    {
                        return Err(JobManagerError::ConflictingTarget {
                            running_job_id: managed.job.id.clone(),
                            target: target.clone(),
                            state: if matches!(managed.job.state, PhotolabJobState::Queued) {
                                ConflictingJobState::Queued
                            } else {
                                ConflictingJobState::Running
                            },
                        });
                    }
                }
                let active = jobs
                    .values()
                    .filter(|managed| !is_terminal(&managed.job.state))
                    .count();
                if active >= self.inner.capacity {
                    return Err(JobManagerError::QueueFull {
                        max_concurrency: self.inner.config.max_concurrency,
                        max_queued: self.inner.config.max_queued,
                    });
                }
            }
            let (updates, _) = watch::channel(job.clone());
            let worker_active = refusal.is_none();
            let (worker_updates, _) = watch::channel(worker_active);
            jobs.insert(
                key.clone(),
                ManagedJob {
                    job: job.clone(),
                    publication_targets: admission.publication_targets,
                    cancellation: cancellation.clone(),
                    updates,
                    worker_updates,
                    worker_active,
                    history_scope: history_scope.clone(),
                    frozen_request: frozen_request.clone(),
                    history_dirty: false,
                    last_history_persisted_at: Instant::now(),
                    memory_reservation_bytes: if worker_active {
                        admission
                            .memory_preflight
                            .as_ref()
                            .map_or(0, |preflight| preflight.predicted_bytes)
                    } else {
                        0
                    },
                },
            );
            if let (Some(history), Some(scope)) = (&self.inner.history, &history_scope) {
                if let Err(message) = history.persist(scope, &job, frozen_request.as_ref()) {
                    jobs.remove(&key);
                    return Err(JobManagerError::HistoryPersistence(message));
                }
            }
        }

        if refusal.is_some() {
            return Ok(StartJobResult { job });
        }

        let manager = self.clone();
        let job_id = job.id.clone();
        let worker_job_id = job_id.clone();
        let job_kind = job.kind;
        let config_hash = job.config_hash.clone();
        let input_hash = job.input_hash.clone();
        self.runtime.spawn(async move {
            manager
                .supervise_inner(
                    job_id,
                    job_kind,
                    config_hash,
                    input_hash,
                    cancellation,
                    work,
                )
                .await;
            manager.mark_worker_inactive(&worker_job_id).await;
        });
        Ok(StartJobResult { job })
    }

    /// Returns a stable snapshot sorted by job identifier.
    pub async fn list(&self, params: ListJobsParams) -> Result<Vec<PhotolabJob>, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let mut records = self
            .inner
            .history
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), |history| history.load_current())
            .map_err(JobManagerError::HistoryPersistence)?
            .into_iter()
            .map(|job| (job.id.0.clone(), job))
            .collect::<BTreeMap<_, _>>();
        let mut jobs = self.inner.jobs.lock().await;
        for managed in jobs.values_mut() {
            retry_history_persistence(self.inner.history.as_ref(), managed);
            if self.inner.history.is_some() && managed.history_scope != current_scope {
                continue;
            }
            records.insert(managed.job.id.0.clone(), managed.job.clone());
        }
        let mut records = records
            .into_values()
            .filter(|job| params.include_terminal || !is_terminal(&job.state))
            .collect::<Vec<_>>();
        if let Some(history) = &self.inner.history {
            records.extend(
                history
                    .list_side_operations()
                    .map_err(JobManagerError::HistoryPersistence)?,
            );
        }
        records.sort_by(|left, right| left.id.0.cmp(&right.id.0));
        Ok(records)
    }

    /// Returns the current authoritative record for one job.
    pub async fn status(&self, job_id: &PhotolabJobId) -> Result<PhotolabJob, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let jobs = self.inner.jobs.lock().await;
        if let Some(job) = jobs
            .get(&job_id.0)
            .filter(|managed| {
                self.inner.history.is_none() || managed.history_scope == current_scope
            })
            .map(|managed| managed.job.clone())
        {
            return Ok(job);
        }
        drop(jobs);
        if let Some(job) = self
            .inner
            .history
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), |history| history.load_current())
            .map_err(JobManagerError::HistoryPersistence)?
            .into_iter()
            .find(|job| job.id == *job_id)
        {
            return Ok(job);
        }
        if let Some(history) = &self.inner.history {
            if let Some(job) = history
                .side_operation_status(job_id)
                .map_err(JobManagerError::HistoryPersistence)?
            {
                return Ok(job);
            }
        }
        Err(JobManagerError::JobNotFound(job_id.clone()))
    }

    /// Returns the per-machine envelope after the OS/UI reserve and running-job holds.
    pub async fn usable_memory_bytes(&self, physical_memory_bytes: u64) -> u64 {
        let jobs = self.inner.jobs.lock().await;
        let running_holds = jobs
            .values()
            .filter(|managed| managed.job.state == PhotolabJobState::Running)
            .map(|managed| managed.memory_reservation_bytes)
            .fold(0_u64, u64::saturating_add);
        physical_memory_bytes
            .saturating_sub(memory_os_ui_reserve_bytes(physical_memory_bytes))
            .saturating_sub(running_holds)
    }

    /// Latest measured ALIKED extraction calibration available in current project history.
    pub async fn measured_extraction_bytes_per_pixel(&self) -> Option<u64> {
        self.list(ListJobsParams {
            include_terminal: true,
        })
        .await
        .ok()?
        .into_iter()
        .flat_map(|job| job.memory.stages)
        .filter(|stage| stage.stage == "Extract ALIKED" && stage.peak_rss_bytes > 0)
        .filter_map(|stage| {
            let pixels = stage.parameters.get("actualPixels")?.as_u64()?;
            (pixels > 0).then(|| stage.peak_rss_bytes / pixels)
        })
        .filter(|value| *value > 0)
        .last()
    }

    /// Makes cancellation visible before returning to the caller.
    pub async fn cancel(&self, job_id: &PhotolabJobId) -> Result<CancelJobResult, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0).filter(|managed| {
            self.inner.history.is_none() || managed.history_scope == current_scope
        }) else {
            drop(jobs);
            if let Some(history) = &self.inner.history {
                if let Some(result) = history
                    .cancel_side_operation(job_id)
                    .map_err(JobManagerError::HistoryPersistence)?
                {
                    return Ok(result);
                }
            }
            return Err(JobManagerError::JobNotFound(job_id.clone()));
        };
        let was_queued = managed.job.state == PhotolabJobState::Queued;
        let first_request = managed.job.request_cancel(&managed.cancellation)?;
        if was_queued {
            managed.job.transition_to(PhotolabJobState::Cancelled)?;
        }
        self.publish_durable(managed);
        Ok(CancelJobResult {
            first_request,
            job: managed.job.clone(),
        })
    }

    /// Requests cancellation for every non-terminal job before a project session changes.
    pub async fn cancel_all(&self) -> Vec<PhotolabJob> {
        let mut jobs = self.inner.jobs.lock().await;
        let mut changed = Vec::new();
        for managed in jobs.values_mut() {
            if is_terminal(&managed.job.state) {
                continue;
            }
            let was_queued = managed.job.state == PhotolabJobState::Queued;
            if managed.job.request_cancel(&managed.cancellation).is_err() {
                continue;
            }
            if was_queued {
                if let Err(error) = managed.job.transition_to(PhotolabJobState::Cancelled) {
                    tracing::error!(job_id = %managed.job.id.0, %error, "failed to cancel queued job");
                }
            }
            self.publish_durable(managed);
            changed.push(managed.job.clone());
        }
        changed
    }

    /// Cancels every active job and waits up to one shared deadline for terminal states.
    ///
    /// Admission remains closed after this call so a project close or replacement can
    /// follow without a new worker racing into the old session. Call
    /// [`Self::resume_admission`] only after a non-shutdown project transition finishes.
    pub async fn drain(&self, deadline: Duration) -> DrainReport {
        self.inner.draining.store(true, Ordering::Release);
        self.cancel_all().await;
        let ids = self
            .inner
            .jobs
            .lock()
            .await
            .values()
            .filter(|managed| managed.worker_active)
            .map(|managed| managed.job.id.clone())
            .collect::<Vec<_>>();
        let cutoff = TokioInstant::now() + deadline;
        let mut terminal = 0;
        let mut timed_out = Vec::new();

        for job_id in ids {
            match timeout_at(cutoff, self.wait_for_worker_stopped(&job_id)).await {
                Ok(Ok(_)) => terminal += 1,
                Ok(Err(error)) => {
                    tracing::error!(job_id = %job_id.0, %error, "job drain waiter failed");
                    timed_out.push(job_id);
                }
                Err(_) => timed_out.push(job_id),
            }
        }

        if !timed_out.is_empty() {
            let diagnostic = format!(
                "The worker did not stop within the bounded drain deadline of {} ms. The project was not marked as cleanly closed.",
                deadline.as_millis()
            );
            let mut jobs = self.inner.jobs.lock().await;
            let mut forced = Vec::with_capacity(timed_out.len());
            for job_id in timed_out {
                let Some(managed) = jobs.get_mut(&job_id.0) else {
                    continue;
                };
                forced.push(job_id);
                if is_terminal(&managed.job.state) {
                    continue;
                }
                managed.job.record_terminal_diagnostic(diagnostic.clone());
                set_failed(managed, "drainTimeout", diagnostic.clone());
                self.publish_durable(managed);
            }
            timed_out = forced;
        }

        DrainReport {
            terminal,
            timed_out,
        }
    }

    /// Reopens admission after a completed project close/create/open transition.
    pub fn resume_admission(&self) {
        self.inner.draining.store(false, Ordering::Release);
    }

    /// Waits asynchronously for a terminal state; useful for shutdown and tests.
    pub async fn wait_for_terminal(
        &self,
        job_id: &PhotolabJobId,
    ) -> Result<PhotolabJob, JobManagerError> {
        let mut updates = {
            let jobs = self.inner.jobs.lock().await;
            jobs.get(&job_id.0)
                .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?
                .updates
                .subscribe()
        };
        loop {
            let job = updates.borrow().clone();
            if is_terminal(&job.state) {
                return Ok(job);
            }
            updates
                .changed()
                .await
                .map_err(|_| JobManagerError::UpdateChannelClosed(job_id.clone()))?;
        }
    }

    async fn wait_for_worker_stopped(&self, job_id: &PhotolabJobId) -> Result<(), JobManagerError> {
        let mut updates = {
            let jobs = self.inner.jobs.lock().await;
            jobs.get(&job_id.0)
                .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?
                .worker_updates
                .subscribe()
        };
        loop {
            if !*updates.borrow() {
                return Ok(());
            }
            updates
                .changed()
                .await
                .map_err(|_| JobManagerError::UpdateChannelClosed(job_id.clone()))?;
        }
    }

    async fn supervise_inner<F>(
        &self,
        job_id: PhotolabJobId,
        job_kind: PhotolabJobKind,
        config_hash: ObjectHash,
        input_hash: ObjectHash,
        cancellation: CancellationToken,
        work: F,
    ) where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        let Ok(permit) = self.inner.concurrency.clone().acquire_owned().await else {
            self.fail_job(&job_id, "schedulerClosed", "job scheduler closed")
                .await;
            return;
        };
        let compute_lease = match acquire_compute_lease(&cancellation).await {
            Ok(Some(lease)) => lease,
            Ok(None) => return,
            Err(error) => {
                self.fail_job(
                    &job_id,
                    "computeLease",
                    &format!("failed to acquire the cross-process compute lease: {error}"),
                )
                .await;
                return;
            }
        };
        if !self.mark_running(&job_id).await {
            return;
        }

        let context = JobWorkerContext {
            cancellation,
            progress: ProgressSink {
                manager: self.clone(),
                job_id: job_id.clone(),
                stage_base: 0,
                stage_count: None,
            },
            checkpoints: CheckpointSink {
                manager: self.clone(),
                job_id: job_id.clone(),
                job_kind,
                config_hash,
                input_hash,
                stage_base: 0,
                stage_count: None,
            },
            diagnostics: JobDiagnosticSink {
                manager: self.clone(),
                job_id: job_id.clone(),
            },
            memory: JobMemorySink {
                manager: self.clone(),
                job_id: job_id.clone(),
            },
        };
        let outcome = tokio::task::spawn_blocking(move || work(context)).await;
        self.finish_worker(&job_id, outcome, permit).await;
        drop(compute_lease);
    }

    async fn mark_worker_inactive(&self, job_id: &PhotolabJobId) {
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0) else {
            return;
        };
        managed.worker_active = false;
        managed.worker_updates.send_replace(false);
        if !is_terminal(&managed.job.state) && managed.cancellation.is_cancel_requested() {
            transition_or_fail(managed, PhotolabJobState::Cancelled);
            self.publish_durable(managed);
        }
    }

    async fn mark_running(&self, job_id: &PhotolabJobId) -> bool {
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0) else {
            return false;
        };
        if is_terminal(&managed.job.state) {
            return false;
        }
        if let Err(error) = managed.job.transition_to(PhotolabJobState::Running) {
            set_failed(managed, "invalidState", error.to_string());
            self.publish_durable(managed);
            return false;
        }
        self.publish_durable(managed);
        true
    }

    async fn finish_worker(
        &self,
        job_id: &PhotolabJobId,
        outcome: Result<JobWorkerResult, tokio::task::JoinError>,
        _permit: OwnedSemaphorePermit,
    ) {
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0) else {
            return;
        };
        if is_terminal(&managed.job.state) {
            return;
        }
        match outcome {
            Ok(Ok(())) if managed.job.state == PhotolabJobState::CancelRequested => {
                transition_or_fail(managed, PhotolabJobState::Cancelled);
            }
            Ok(Ok(())) => {
                complete_progress(managed);
                transition_or_fail(managed, PhotolabJobState::Completed);
            }
            Ok(Err(JobWorkerError::Cancelled)) if managed.cancellation.is_cancel_requested() => {
                if managed.job.state != PhotolabJobState::CancelRequested {
                    if let Err(error) = managed.job.request_cancel(&managed.cancellation) {
                        tracing::error!(job_id = %managed.job.id.0, %error, "failed to record worker cancellation request");
                    }
                }
                transition_or_fail(managed, PhotolabJobState::Cancelled);
            }
            Ok(Err(JobWorkerError::Cancelled)) => set_failed(
                managed,
                "unexpectedCancellation",
                "worker returned cancellation without a manager request".into(),
            ),
            Ok(Err(JobWorkerError::Failed { code, message })) => {
                set_failed(managed, &code, message);
            }
            Err(error) => set_failed(managed, "workerJoin", error.to_string()),
        }
        self.publish_durable(managed);
    }

    async fn fail_job(&self, job_id: &PhotolabJobId, code: &str, message: &str) {
        let mut jobs = self.inner.jobs.lock().await;
        if let Some(managed) = jobs.get_mut(&job_id.0) {
            set_failed(managed, code, message.into());
            self.publish_durable(managed);
        }
    }

    async fn update_progress(
        &self,
        job_id: &PhotolabJobId,
        progress: JobProgress,
    ) -> Result<PhotolabJob, JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let stage_changed = managed.job.progress.stage.index != progress.stage.index;
        managed.job.update_progress(progress)?;
        if stage_changed || managed.last_history_persisted_at.elapsed() >= Duration::from_secs(1) {
            self.publish_durable(managed);
        } else {
            publish(managed);
        }
        Ok(managed.job.clone())
    }

    async fn record_checkpoint(
        &self,
        job_id: &PhotolabJobId,
        checkpoint: &CheckpointDescriptor,
    ) -> Result<PhotolabJob, JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        managed.job.record_checkpoint(checkpoint)?;
        self.publish_durable(managed);
        Ok(managed.job.clone())
    }

    async fn record_terminal_diagnostic(
        &self,
        job_id: &PhotolabJobId,
        diagnostic: String,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        managed.job.record_terminal_diagnostic(diagnostic);
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_stage_memory(
        &self,
        job_id: &PhotolabJobId,
        stage: PhotolabStageMemory,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        managed.job.record_stage_memory(stage);
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_matching_replan(
        &self,
        job_id: &PhotolabJobId,
        replan: PhotolabMatchingMemoryReplan,
        keypoint_cap: u32,
        degradation: Option<PhotolabMemoryDegradation>,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        if let Some(degradation) = degradation {
            if !managed.job.memory.degradations.contains(&degradation) {
                managed.job.memory.degradations.push(degradation);
            }
        }
        if let Some(stage) = managed
            .job
            .memory
            .stages
            .iter_mut()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
        {
            stage.workers = replan.matching_workers;
            let parameters = stage
                .parameters
                .as_object_mut()
                .expect("alignment matcher parameters are an object");
            parameters.insert(
                "actualMaxKeypoints".into(),
                replan.actual_max_keypoints.into(),
            );
            parameters.insert("keypoints".into(), keypoint_cap.into());
            parameters.insert(
                "matchingUnitBytes".into(),
                replan.matching_unit_bytes.into(),
            );
            parameters.insert(
                "modelBytes".into(),
                replan
                    .matching_unit_bytes
                    .saturating_mul(u64::from(replan.matching_workers))
                    .into(),
            );
            parameters.insert(
                "sequentialPairBatches".into(),
                (replan.matching_workers == 1).into(),
            );
        }
        managed.job.memory.matching_replanned = Some(replan);
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_worker_memory_limit_hit(
        &self,
        job_id: &PhotolabJobId,
        stage: String,
        limit_bytes: u64,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let degradation = PhotolabMemoryDegradation::WorkerMemoryLimitHit { stage, limit_bytes };
        if !managed.job.memory.degradations.contains(&degradation) {
            managed.job.memory.degradations.push(degradation);
            self.publish_durable(managed);
        }
        Ok(())
    }

    async fn record_matching_threads_halved(
        &self,
        job_id: &PhotolabJobId,
        from: u16,
        to: u16,
        observed_peak_bytes: u64,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let degradation = PhotolabMemoryDegradation::MatchingThreadsHalved {
            from,
            to,
            observed_peak_bytes,
        };
        if !managed.job.memory.degradations.contains(&degradation) {
            managed.job.memory.degradations.push(degradation);
        }
        if let Some(stage) = managed
            .job
            .memory
            .stages
            .iter_mut()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
        {
            stage.workers = to;
            if let Some(parameters) = stage.parameters.as_object_mut() {
                parameters.insert("sequentialPairBatches".into(), (to == 1).into());
            }
        }
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_matching_threads(
        &self,
        job_id: &PhotolabJobId,
        stage_name: String,
        threads: u16,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        if let Some(stage) = managed
            .job
            .memory
            .stages
            .iter_mut()
            .find(|stage| stage.stage == stage_name)
        {
            stage.workers = threads;
            if let Some(parameters) = stage.parameters.as_object_mut() {
                parameters.insert("sequentialPairBatches".into(), (threads == 1).into());
            }
            self.publish_durable(managed);
        }
        Ok(())
    }

    async fn record_unbounded_memory_stage(
        &self,
        job_id: &PhotolabJobId,
        stage: String,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let observation = PhotolabMemoryObservation::UnboundedStage {
            stage,
            budget_bytes: managed.job.memory.envelope_bytes,
        };
        if !managed.job.memory.observations.contains(&observation) {
            managed.job.memory.observations.push(observation);
            self.publish_durable(managed);
        }
        Ok(())
    }

    fn current_history_scope(&self) -> Result<Option<JobHistoryScope>, JobManagerError> {
        self.inner
            .history
            .as_ref()
            .map_or_else(|| Ok(None), |history| history.current_scope())
            .map_err(JobManagerError::HistoryPersistence)
    }

    fn publish_durable(&self, managed: &mut ManagedJob) {
        let (Some(history), Some(scope)) = (&self.inner.history, &managed.history_scope) else {
            publish(managed);
            return;
        };
        match history.persist(scope, &managed.job, managed.frozen_request.as_ref()) {
            Ok(()) => {
                managed.history_dirty = false;
                managed.last_history_persisted_at = Instant::now();
            }
            Err(error) => {
                managed.history_dirty = true;
                tracing::error!(
                    job_id = managed.job.id.0,
                    project_id = scope.project_id,
                    %error,
                    "failed to persist PhotoLab job lifecycle snapshot"
                );
            }
        }
        publish(managed);
    }
}

fn retry_history_persistence(
    history: Option<&Arc<dyn JobHistoryPersistence>>,
    managed: &mut ManagedJob,
) {
    if !managed.history_dirty {
        return;
    }
    let (Some(history), Some(scope)) = (history, &managed.history_scope) else {
        return;
    };
    if let Err(error) = history.persist(scope, &managed.job, managed.frozen_request.as_ref()) {
        tracing::error!(
            job_id = managed.job.id.0,
            project_id = scope.project_id,
            %error,
            "failed to retry PhotoLab job lifecycle persistence"
        );
    } else {
        managed.history_dirty = false;
        managed.last_history_persisted_at = Instant::now();
    }
}

async fn acquire_compute_lease(cancellation: &CancellationToken) -> io::Result<Option<File>> {
    let path = compute_lease_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    loop {
        if cancellation.is_cancel_requested() {
            return Ok(None);
        }
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn compute_lease_path() -> PathBuf {
    if let Some(path) = std::env::var_os("HIMMELCAD_COMPUTE_LEASE_PATH") {
        return PathBuf::from(path);
    }
    // Test processes must never queue behind a real sidecar's machine-wide
    // lease: on 2026-09-02 a running golden e2e sidecar held the shared lock and
    // every bounded cancellation timing test timed out before its worker could
    // spawn. `cfg(test)` covers the library's own tests; the binary's test
    // harness links the non-test library, so also recognise the runtime
    // environment cargo sets for `cargo test`/`cargo run` processes (a packaged
    // sidecar launched by Electron never carries `CARGO_MANIFEST_DIR`).
    if cfg!(test) || std::env::var_os("CARGO_MANIFEST_DIR").is_some() {
        return std::env::temp_dir().join(format!(
            "himmelcad-photolab-compute-test-{}.lock",
            std::process::id()
        ));
    }
    std::env::temp_dir().join("himmelcad-photolab-compute.lock")
}

fn publish(managed: &ManagedJob) {
    managed.updates.send_replace(managed.job.clone());
}

fn is_terminal(state: &PhotolabJobState) -> bool {
    matches!(
        state,
        PhotolabJobState::Cancelled | PhotolabJobState::Completed | PhotolabJobState::Failed { .. }
    )
}

fn transition_or_fail(managed: &mut ManagedJob, state: PhotolabJobState) {
    if let Err(error) = managed.job.transition_to(state) {
        set_failed(managed, "invalidState", error.to_string());
    }
}

fn complete_progress(managed: &mut ManagedJob) {
    managed.job.progress.stage.index = managed.job.progress.stage.stage_count.saturating_sub(1);
    if let Some(total) = managed.job.progress.metrics.total_units {
        managed.job.progress.metrics.completed_units = total;
    }
    if let Some(total) = managed.job.progress.metrics.total_bytes {
        managed.job.progress.metrics.completed_bytes = total;
    }
}

fn set_failed(managed: &mut ManagedJob, code: &str, message: String) {
    let failed = PhotolabJobState::Failed {
        code: code.into(),
        message,
    };
    if let Err(error) = managed.job.transition_to(failed) {
        tracing::error!(job_id = %managed.job.id.0, failure_code = code, %error, "failed to record terminal job failure");
    }
}

fn system_available_bytes(path: &Path) -> Result<u64, String> {
    let mut probe = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?
            .join(path)
    };
    loop {
        match probe.try_exists() {
            Ok(true) => break,
            Ok(false) => {
                if !probe.pop() {
                    return Err(format!(
                        "no existing ancestor found for free-space probe at {}",
                        path.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "failed to resolve an existing ancestor for {}: {error}",
                    path.display()
                ));
            }
        }
    }
    fs2::available_space(&probe).map_err(|error| {
        format!(
            "failed to inspect free space for {} via {}: {error}",
            path.display(),
            probe.display()
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictingJobState {
    Queued,
    Running,
}

/// Scheduling and authoritative-state failures returned to RPC integration.
#[derive(Debug, PartialEq, Eq)]
pub enum JobManagerError {
    InvalidConfig(&'static str),
    InvalidFrozenRequest(String),
    NoTokioRuntime,
    SchedulerDraining,
    DuplicateJobId(PhotolabJobId),
    QueueFull {
        max_concurrency: usize,
        max_queued: usize,
    },
    ConflictingTarget {
        running_job_id: PhotolabJobId,
        target: PublicationTarget,
        state: ConflictingJobState,
    },
    InsufficientDisk {
        required_bytes: u64,
        available_bytes: u64,
        path: PathBuf,
        job_kind: Option<PhotolabJobKind>,
        scratch_bytes: Option<u64>,
    },
    InsufficientMemory {
        predicted_bytes: u64,
        available_bytes: u64,
    },
    DiskPreflight(String),
    JobNotFound(PhotolabJobId),
    UpdateChannelClosed(PhotolabJobId),
    HistoryPersistence(String),
    Core(JobError),
}

impl From<JobError> for JobManagerError {
    fn from(error: JobError) -> Self {
        Self::Core(error)
    }
}

impl std::fmt::Display for JobManagerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => {
                write!(formatter, "invalid job manager configuration: {message}")
            }
            Self::InvalidFrozenRequest(message) => {
                write!(formatter, "invalid frozen job request: {message}")
            }
            Self::NoTokioRuntime => formatter.write_str(
                "JobManager must be created inside a Tokio runtime or with an explicit handle",
            ),
            Self::SchedulerDraining => {
                formatter.write_str("job scheduler is draining for a project transition")
            }
            Self::DuplicateJobId(id) => write!(formatter, "job {id:?} already exists"),
            Self::QueueFull {
                max_concurrency,
                max_queued,
            } => write!(
                formatter,
                "job queue is full ({max_concurrency} running, {max_queued} queued)"
            ),
            Self::ConflictingTarget {
                running_job_id,
                target,
                state,
            } => {
                let (publication, target_name) = target.description();
                let state = match state {
                    ConflictingJobState::Queued => "queued",
                    ConflictingJobState::Running => "running",
                };
                write!(
                    formatter,
                    "{} for this {target_name} is already {state} (job {}). Wait for it or cancel it.",
                    sentence_start(publication),
                    running_job_id.0
                )
            }
            Self::InsufficientDisk {
                required_bytes,
                available_bytes,
                path,
                job_kind,
                scratch_bytes,
            } => match (job_kind, scratch_bytes) {
                (Some(PhotolabJobKind::BuildDem), Some(scratch_bytes)) => write!(
                    formatter,
                    "Not enough disk for the DEM: needs about {} of scratch, {} free",
                    format_decimal_gigabytes(*scratch_bytes),
                    format_decimal_gigabytes(*available_bytes)
                ),
                (Some(PhotolabJobKind::BuildOrthomosaic), _) => write!(
                    formatter,
                    "Not enough disk for the orthomosaic: about {} needed, {} free.",
                    format_bytes(*required_bytes),
                    format_bytes(*available_bytes)
                ),
                _ => write!(
                    formatter,
                    "Not enough free space on {}: about {} needed, {} free.",
                    path.display(),
                    format_bytes(*required_bytes),
                    format_bytes(*available_bytes)
                ),
            },
            Self::InsufficientMemory {
                predicted_bytes,
                available_bytes,
            } => write!(
                formatter,
                "Not enough memory: about {} needed for the smallest safe unit, {} available.",
                format_bytes(*predicted_bytes),
                format_bytes(*available_bytes)
            ),
            Self::DiskPreflight(message) => write!(formatter, "disk preflight failed: {message}"),
            Self::JobNotFound(id) => write!(formatter, "job {id:?} was not found"),
            Self::UpdateChannelClosed(id) => {
                write!(formatter, "job {id:?} update channel closed unexpectedly")
            }
            Self::HistoryPersistence(message) => {
                write!(formatter, "job history persistence failed: {message}")
            }
            Self::Core(error) => error.fmt(formatter),
        }
    }
}

fn sentence_start(value: &'static str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: &[(&str, u64)] = &[("TB", GIB * 1024), ("GB", GIB), ("MB", MIB), ("KB", 1024)];
    for (label, unit) in UNITS {
        if bytes >= *unit {
            if bytes % *unit == 0 {
                return format!("{} {label}", bytes / *unit);
            }
            return format!("{:.1} {label}", bytes as f64 / *unit as f64);
        }
    }
    format!("{bytes} bytes")
}

fn format_decimal_gigabytes(bytes: u64) -> String {
    const DECIMAL_GB: u64 = 1_000_000_000;
    format!("{:.1} GB", bytes as f64 / DECIMAL_GB as f64)
}

impl std::error::Error for JobManagerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Core(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Mutex as StdMutex,
    };

    use himmelcad_core::{
        entity::EntityId,
        hash::ObjectHash,
        photolab_jobs::{
            CheckpointDescriptor, CheckpointId, JobProgress, NewPendingCheckpoint, PhotolabJobKind,
            PhotolabStage, PhotolabStageKind, ProgressMetrics,
        },
        photolab_products::ProductKind,
    };

    use super::*;

    #[derive(Default)]
    struct MemoryHistory {
        current: StdMutex<Option<JobHistoryScope>>,
        records: StdMutex<BTreeMap<String, BTreeMap<String, PhotolabJob>>>,
        frozen_requests: StdMutex<BTreeMap<String, FrozenJobRequest>>,
        persist_count: AtomicUsize,
    }

    impl MemoryHistory {
        fn select(&self, project_id: &str) {
            *self.current.lock().expect("history current") = Some(JobHistoryScope {
                project_id: project_id.into(),
                project_root: PathBuf::from(format!("/{project_id}")),
            });
        }
    }

    impl JobHistoryPersistence for MemoryHistory {
        fn current_scope(&self) -> Result<Option<JobHistoryScope>, String> {
            Ok(self
                .current
                .lock()
                .map_err(|error| error.to_string())?
                .clone())
        }

        fn load_current(&self) -> Result<Vec<PhotolabJob>, String> {
            let project_id = self
                .current
                .lock()
                .map_err(|error| error.to_string())?
                .as_ref()
                .map(|scope| scope.project_id.clone());
            let records = self.records.lock().map_err(|error| error.to_string())?;
            Ok(project_id
                .and_then(|project_id| records.get(&project_id))
                .map_or_else(Vec::new, |jobs| jobs.values().cloned().collect()))
        }

        fn persist(
            &self,
            scope: &JobHistoryScope,
            job: &PhotolabJob,
            frozen_request: Option<&FrozenJobRequest>,
        ) -> Result<(), String> {
            self.persist_count.fetch_add(1, Ordering::Relaxed);
            self.records
                .lock()
                .map_err(|error| error.to_string())?
                .entry(scope.project_id.clone())
                .or_default()
                .insert(job.id.0.clone(), job.clone());
            if let Some(frozen_request) = frozen_request {
                self.frozen_requests
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(job.id.0.clone(), frozen_request.clone());
            }
            Ok(())
        }
    }

    struct FailingThenSucceedingHistory {
        inner: MemoryHistory,
        terminal_failures_remaining: AtomicUsize,
    }

    impl FailingThenSucceedingHistory {
        fn new() -> Self {
            Self {
                inner: MemoryHistory::default(),
                terminal_failures_remaining: AtomicUsize::new(1),
            }
        }

        fn select(&self, project_id: &str) {
            self.inner.select(project_id);
        }

        fn persisted_job(&self, project_id: &str, job_id: &str) -> Option<PhotolabJob> {
            self.inner
                .records
                .lock()
                .expect("history records")
                .get(project_id)
                .and_then(|jobs| jobs.get(job_id))
                .cloned()
        }
    }

    impl JobHistoryPersistence for FailingThenSucceedingHistory {
        fn current_scope(&self) -> Result<Option<JobHistoryScope>, String> {
            self.inner.current_scope()
        }

        fn load_current(&self) -> Result<Vec<PhotolabJob>, String> {
            self.inner.load_current()
        }

        fn persist(
            &self,
            scope: &JobHistoryScope,
            job: &PhotolabJob,
            frozen_request: Option<&FrozenJobRequest>,
        ) -> Result<(), String> {
            if is_terminal(&job.state)
                && self
                    .terminal_failures_remaining
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                        remaining.checked_sub(1)
                    })
                    .is_ok()
            {
                return Err("injected terminal history write failure".into());
            }
            self.inner.persist(scope, job, frozen_request)
        }
    }

    fn hash(value: &str) -> ObjectHash {
        ObjectHash::of_bytes(value.as_bytes())
    }

    fn progress(done: u64) -> JobProgress {
        JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::FeatureExtraction,
                index: 0,
                stage_count: 1,
                label: "Extract features".into(),
            },
            metrics: ProgressMetrics {
                completed_units: done,
                total_units: Some(10),
                completed_bytes: done * 100,
                total_bytes: Some(1_000),
            },
        }
    }

    #[tokio::test]
    async fn resumable_start_persists_the_hash_bound_request_before_work_runs() {
        let history = Arc::new(MemoryHistory::default());
        history.select("project-a");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        let request = request("resume-job");
        let frozen = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": "resume-job" }),
            &request,
        )
        .expect("frozen request");
        manager
            .start_with_frozen_request(request, frozen.clone(), |_| Ok(()))
            .await
            .expect("start resumable job");
        assert_eq!(
            history
                .frozen_requests
                .lock()
                .expect("frozen requests")
                .get("resume-job"),
            Some(&frozen)
        );
        let terminal = manager
            .wait_for_terminal(&PhotolabJobId("resume-job".into()))
            .await
            .expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
    }

    #[tokio::test]
    async fn background_tick_retries_a_failed_terminal_history_write_without_listing() {
        let history = Arc::new(FailingThenSucceedingHistory::new());
        history.select("retry-project");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        let job_id = PhotolabJobId("retry-terminal-job".into());
        manager
            .start(request(&job_id.0), |_| Ok(()))
            .await
            .expect("start job");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("terminal memory state");
        assert_eq!(terminal.state, PhotolabJobState::Completed);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if history
                    .persisted_job("retry-project", &job_id.0)
                    .is_some_and(|job| job.state == PhotolabJobState::Completed)
                {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("background history retry");
    }

    #[test]
    fn frozen_request_binding_rejects_payload_tampering() {
        let request = request("bound-job");
        let mut frozen = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": "bound-job" }),
            &request,
        )
        .expect("frozen request");
        frozen.validate().expect("valid binding");
        frozen.params["operationId"] = serde_json::json!("other-job");
        assert!(frozen.validate().is_err());
    }

    #[tokio::test]
    async fn recoverable_history_job_is_resubmitted_with_resume_work() {
        let history = Arc::new(MemoryHistory::default());
        history.select("project-a");
        let scope = history
            .current_scope()
            .expect("scope")
            .expect("selected scope");
        let request = request_for_kind("resume-history", PhotolabJobKind::BuildGaussianSplat);
        let frozen = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": "resume-history" }),
            &request,
        )
        .expect("frozen request");
        let mut interrupted = PhotolabJob::new(request.clone()).expect("history job");
        interrupted
            .transition_to(PhotolabJobState::Running)
            .expect("running");
        interrupted
            .transition_to(PhotolabJobState::Failed {
                code: "interruptedRecoverable".into(),
                message: "Resume is available.".into(),
            })
            .expect("interrupted");
        history
            .persist(&scope, &interrupted, Some(&frozen))
            .expect("persist history");

        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history,
        )
        .expect("manager");
        assert_eq!(
            manager
                .status(&request.id)
                .await
                .expect("history status")
                .state,
            interrupted.state
        );
        let resumed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let resumed_in_worker = resumed.clone();
        manager
            .start_with_frozen_request(request.clone(), frozen, move |_| {
                resumed_in_worker.store(true, Ordering::Release);
                Ok(())
            })
            .await
            .expect("resubmit");
        let terminal = manager
            .wait_for_terminal(&request.id)
            .await
            .expect("resumed terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert!(resumed.load(Ordering::Acquire));
    }

    fn request(id: &str) -> NewPhotolabJob {
        request_for_kind(id, PhotolabJobKind::AlignPhotos)
    }

    fn request_for_kind(id: &str, kind: PhotolabJobKind) -> NewPhotolabJob {
        NewPhotolabJob {
            id: PhotolabJobId(id.into()),
            kind,
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            progress: progress(0),
        }
    }

    async fn assert_durable_checkpoint_updates_job(kind: PhotolabJobKind, id: &str) {
        let manager = manager(1, 0);
        let job_id = PhotolabJobId(id.into());
        let directory = std::env::temp_dir().join(format!(
            "himmelcad-job-checkpoint-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("checkpoint test directory");
        let checkpoint_path = directory.join("checkpoint.bin");
        let worker_path = checkpoint_path.clone();
        let checkpoint_id = id.to_owned();
        manager
            .start(request_for_kind(id, kind), move |context| {
                let pending = worker_path.with_extension("pending");
                let payload = b"durable runtime checkpoint";
                let mut file = File::create(&pending).expect("create pending checkpoint");
                file.write_all(payload).expect("write checkpoint payload");
                file.sync_all().expect("sync checkpoint payload");
                drop(file);
                fs::rename(&pending, &worker_path).expect("commit checkpoint payload");
                #[cfg(unix)]
                File::open(worker_path.parent().expect("checkpoint parent"))
                    .expect("open checkpoint parent")
                    .sync_all()
                    .expect("sync checkpoint parent");
                context.checkpoints.record_committed_blocking(
                    7,
                    checkpoint_progress(kind),
                    format!("{checkpoint_id}:checkpoint:7"),
                    ObjectHash::of_bytes(payload),
                )?;
                Ok(())
            })
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&job_id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert_eq!(terminal.last_checkpoint_sequence, Some(7));
        assert!(checkpoint_path.is_file());
        fs::remove_dir_all(directory).expect("checkpoint test cleanup");
    }

    fn checkpoint_progress(kind: PhotolabJobKind) -> JobProgress {
        let stage_kind = match kind {
            PhotolabJobKind::BuildDepthMaps => PhotolabStageKind::DepthEstimation,
            PhotolabJobKind::BuildDensePointCloud => PhotolabStageKind::DenseFusion,
            PhotolabJobKind::BuildDem | PhotolabJobKind::BuildOrthomosaic => {
                PhotolabStageKind::Rasterization
            }
            PhotolabJobKind::BuildGaussianSplat => PhotolabStageKind::SplatOptimization,
            PhotolabJobKind::Batch => PhotolabStageKind::Finalizing,
            _ => PhotolabStageKind::Preparing,
        };
        JobProgress {
            stage: PhotolabStage {
                kind: stage_kind,
                index: 0,
                stage_count: 1,
                label: "Commit durable checkpoint".into(),
            },
            metrics: ProgressMetrics {
                completed_units: 1,
                total_units: Some(1),
                completed_bytes: 0,
                total_bytes: None,
            },
        }
    }

    fn manager(concurrency: usize, queued: usize) -> JobManager {
        JobManager::new(JobManagerConfig {
            max_concurrency: concurrency,
            max_queued: queued,
        })
        .expect("manager")
    }

    fn admission(targets: Vec<PublicationTarget>) -> JobAdmission {
        JobAdmission {
            publication_targets: targets,
            disk_preflight: None,
            memory_preflight: None,
            toolchain_preflight: None,
        }
    }

    #[test]
    fn system_available_bytes_matches_fs2_for_existing_temp_directory() {
        let directory = std::env::temp_dir().join(format!(
            "himmelcad-system-available-existing-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create free-space test directory");

        let measured = system_available_bytes(&directory).expect("measure available space");
        let expected = fs2::available_space(&directory).expect("fs2 available space");
        assert!(measured > 0);
        assert_eq!(measured, expected);

        fs::remove_dir_all(directory).expect("remove free-space test directory");
    }

    #[test]
    fn system_available_bytes_uses_parent_for_nonexistent_child() {
        let directory = std::env::temp_dir().join(format!(
            "himmelcad-system-available-parent-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create free-space parent directory");
        let missing = directory.join("not-created").join("target");

        let measured = system_available_bytes(&missing).expect("measure parent available space");
        let expected = fs2::available_space(&directory).expect("fs2 parent available space");
        assert_eq!(measured, expected);

        fs::remove_dir_all(directory).expect("remove free-space parent directory");
    }

    fn dem_target(alignment: &str, lineage: Option<&str>) -> PublicationTarget {
        PublicationTarget::product(
            ProductKind::Dem,
            EntityId(alignment.into()),
            lineage.map(|value| EntityId(value.into())),
        )
    }

    #[test]
    fn disk_estimate_table_matches_wp_b4_calibration() {
        assert_eq!(
            estimate_job_bytes(PhotolabJobKind::AlignPhotos, DiskEstimateScale::Images(10)),
            2 * GIB + 80 * MIB
        );
        assert_eq!(
            estimate_job_bytes(
                PhotolabJobKind::BuildDepthMaps,
                DiskEstimateScale::Images(10)
            ),
            400 * MIB
        );
        assert_eq!(
            estimate_job_bytes(
                PhotolabJobKind::BuildDensePointCloud,
                DiskEstimateScale::Images(10)
            ),
            600 * MIB
        );
        assert_eq!(
            estimate_job_bytes(
                PhotolabJobKind::BuildDem,
                DiskEstimateScale::RasterPixels(3)
            ),
            64
        );
        assert_eq!(
            estimate_job_bytes(PhotolabJobKind::BuildMesh, DiskEstimateScale::Fixed),
            2 * GIB
        );
        assert_eq!(
            estimate_job_bytes(
                PhotolabJobKind::BuildGaussianSplat,
                DiskEstimateScale::Fixed
            ),
            6 * GIB
        );
    }

    #[test]
    fn dense_raster_estimate_matches_the_45_8_million_point_probe() {
        let scale = DiskEstimateScale::DenseRaster {
            point_count: 45_800_000,
            raster_pixels: 3,
        };
        let estimate = disk_estimate_components(PhotolabJobKind::BuildDem, scale);
        assert_eq!(estimate.scratch_bytes, 14_014_800_000);
        assert_eq!(estimate.output_bytes, 64);
        assert_eq!(
            estimate.required_bytes,
            (14_014_800_000_u64 + 64).saturating_mul(11).div_ceil(10)
        );
        assert_eq!(
            estimate_job_bytes(PhotolabJobKind::BuildDem, scale),
            estimate.required_bytes
        );
    }

    #[test]
    fn raster_preparation_model_matches_the_45_8_million_point_probe() {
        let plan = plan_raster_preparation_memory(45_800_000, 64, 20 * GIB);
        let within_five_percent = |actual: u64, expected: u64| {
            actual.abs_diff(expected) <= expected.saturating_mul(5) / 100
        };
        assert!(within_five_percent(plan.ogr2ogr.model_bytes, 4_900_000_000));
        assert!(within_five_percent(
            plan.gdal_grid.model_bytes,
            3_500_000_000
        ));
        assert_eq!(plan.ogr2ogr.model_bytes, 4_848_435_456);
        assert_eq!(plan.gdal_grid.model_bytes, 3_474_435_456);
        assert!(plan.memory.observations.is_empty());
        assert!(plan.refusal.is_none());
    }

    #[test]
    fn raster_preparation_refuses_when_one_unit_exceeds_the_usable_envelope() {
        let admitted = plan_raster_preparation_memory(45_800_000, 64, 20 * GIB);
        let refused = plan_raster_preparation_memory(
            45_800_000,
            64,
            admitted.predicted_peak_bytes.saturating_sub(1),
        );
        assert_eq!(
            refused.refusal,
            Some(JobAdmissionRefusal {
                code: DEM_NEEDS_MORE_MEMORY_CODE.into(),
                message: DEM_NEEDS_MORE_MEMORY_MESSAGE.into(),
            })
        );
        assert!(refused.memory.degradations.is_empty());
        assert!(refused.memory.time_first_choices.is_empty());
    }

    #[tokio::test]
    async fn raster_preparation_refusal_is_typed_visible_and_starts_no_worker() {
        let plan = plan_raster_preparation_memory(45_800_000, 64, 8 * GIB);
        assert!(plan.refusal.is_some());
        let worker_started = Arc::new(AtomicBool::new(false));
        let worker_flag = Arc::clone(&worker_started);
        let manager = manager(1, 0);
        let started = manager
            .start_with_admission(
                request_for_kind("dem-memory-refusal", PhotolabJobKind::BuildDem),
                JobAdmission {
                    memory_preflight: Some(MemoryPreflight {
                        predicted_bytes: plan.predicted_peak_bytes,
                        available_bytes: plan.memory.envelope_bytes,
                        machine_usable_bytes: plan.memory.envelope_bytes,
                        memory: plan.memory,
                        refusal: plan.refusal,
                    }),
                    ..Default::default()
                },
                move |_| {
                    worker_flag.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .expect("typed refusal remains visible");
        assert!(matches!(
            started.job.state,
            PhotolabJobState::Failed { ref code, ref message }
                if code == DEM_NEEDS_MORE_MEMORY_CODE && message == DEM_NEEDS_MORE_MEMORY_MESSAGE
        ));
        assert!(!worker_started.load(Ordering::Acquire));
        assert!(started.job.memory.raster_preparation.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn same_running_or_queued_publication_target_is_rejected() {
        let manager = manager(1, 2);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start_with_admission(
                request("running-dem"),
                admission(vec![dem_target("alignment-a", None)]),
                move |_| {
                    started_tx.send(()).expect("started");
                    release_rx.recv().expect("release");
                    Ok(())
                },
            )
            .await
            .expect("running target admitted");
        started_rx.recv().expect("running worker started");

        let running = manager
            .start_with_admission(
                request("running-conflict"),
                admission(vec![dem_target("alignment-a", None)]),
                |_| Ok(()),
            )
            .await;
        assert_eq!(
            running.expect_err("running target must conflict").to_string(),
            "A DEM for this alignment is already running (job running-dem). Wait for it or cancel it."
        );

        manager
            .start_with_admission(
                request("queued-dem"),
                admission(vec![dem_target("alignment-b", None)]),
                |_| Ok(()),
            )
            .await
            .expect("different queued target admitted");
        let queued = manager
            .start_with_admission(
                request("queued-conflict"),
                admission(vec![dem_target("alignment-b", None)]),
                |_| Ok(()),
            )
            .await;
        assert_eq!(
            queued.expect_err("queued target must conflict").to_string(),
            "A DEM for this alignment is already queued (job queued-dem). Wait for it or cancel it."
        );
        release_tx.send(()).expect("release running worker");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn different_lineage_target_and_terminal_target_are_admitted() {
        let manager = manager(2, 1);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start_with_admission(
                request("lineage-a"),
                admission(vec![dem_target("alignment-a", Some("gcp-a"))]),
                move |_| {
                    started_tx.send(()).expect("started");
                    release_rx.recv().expect("release");
                    Ok(())
                },
            )
            .await
            .expect("first lineage admitted");
        started_rx.recv().expect("worker started");
        manager
            .start_with_admission(
                request("lineage-b"),
                admission(vec![dem_target("alignment-a", Some("gcp-b"))]),
                |_| Ok(()),
            )
            .await
            .expect("different lineage admitted");
        release_tx.send(()).expect("release first lineage");
        manager
            .wait_for_terminal(&PhotolabJobId("lineage-a".into()))
            .await
            .expect("first lineage terminal");
        manager
            .start_with_admission(
                request("after-terminal"),
                admission(vec![dem_target("alignment-a", Some("gcp-a"))]),
                |_| Ok(()),
            )
            .await
            .expect("terminal target does not conflict");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_target_union_conflicts_on_any_member() {
        let manager = manager(1, 1);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start_with_admission(
                request("batch"),
                admission(vec![
                    PublicationTarget::product(
                        ProductKind::DepthMaps,
                        EntityId("alignment-a".into()),
                        None,
                    ),
                    dem_target("alignment-a", None),
                ]),
                move |_| {
                    started_tx.send(()).expect("started");
                    release_rx.recv().expect("release");
                    Ok(())
                },
            )
            .await
            .expect("batch admitted");
        started_rx.recv().expect("batch worker started");
        let conflict = manager
            .start_with_admission(
                request("single-dem"),
                admission(vec![dem_target("alignment-a", None)]),
                |_| Ok(()),
            )
            .await;
        assert!(matches!(
            conflict,
            Err(JobManagerError::ConflictingTarget { .. })
        ));
        release_tx.send(()).expect("release batch");
    }

    #[tokio::test]
    async fn disk_preflight_rejects_before_admission_with_injected_availability() {
        let manager = JobManager::with_runtime_history_and_disk_availability(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            Handle::current(),
            None,
            Arc::new(|_| Ok(GIB)),
        )
        .expect("manager");
        let path = PathBuf::from("/working-copy");
        let error = manager
            .start_with_admission(
                request("disk-rejected"),
                JobAdmission {
                    publication_targets: vec![],
                    disk_preflight: Some(DiskPreflight::for_job(
                        PhotolabJobKind::BuildMesh,
                        DiskEstimateScale::Fixed,
                        path.clone(),
                    )),
                    memory_preflight: None,
                    toolchain_preflight: None,
                },
                |_| Ok(()),
            )
            .await
            .expect_err("insufficient disk must reject");
        assert_eq!(
            error,
            JobManagerError::InsufficientDisk {
                required_bytes: 2 * GIB,
                available_bytes: GIB,
                path,
                job_kind: None,
                scratch_bytes: None,
            }
        );
        assert!(manager
            .list(ListJobsParams {
                include_terminal: true
            })
            .await
            .expect("list")
            .is_empty());
    }

    #[tokio::test]
    async fn dense_raster_disk_refusal_starts_no_worker_and_carries_both_numbers() {
        let components = disk_estimate_components(
            PhotolabJobKind::BuildDem,
            DiskEstimateScale::DenseRaster {
                point_count: 45_800_000,
                raster_pixels: 3,
            },
        );
        let available_bytes = components.required_bytes - 1;
        let manager = JobManager::with_runtime_history_and_disk_availability(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            Handle::current(),
            None,
            Arc::new(move |_| Ok(available_bytes)),
        )
        .expect("manager");
        let worker_started = Arc::new(AtomicBool::new(false));
        let worker_flag = Arc::clone(&worker_started);
        let path = PathBuf::from("/project/.photolab/raster-inputs/dem-job");
        let error = manager
            .start_with_disk_admission(
                request_for_kind("dem-job", PhotolabJobKind::BuildDem),
                JobAdmission {
                    publication_targets: Vec::new(),
                    disk_preflight: Some(DiskPreflight {
                        required_bytes: components.required_bytes,
                        path: path.clone(),
                    }),
                    memory_preflight: None,
                    toolchain_preflight: None,
                },
                components,
                move |_| {
                    worker_flag.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .expect_err("insufficient dense-raster disk must reject");
        assert_eq!(
            error.to_string(),
            "Not enough disk for the DEM: needs about 14.0 GB of scratch, 15.4 GB free"
        );
        assert_eq!(
            error,
            JobManagerError::InsufficientDisk {
                required_bytes: components.required_bytes,
                available_bytes,
                path,
                job_kind: Some(PhotolabJobKind::BuildDem),
                scratch_bytes: Some(components.scratch_bytes),
            }
        );
        assert!(!worker_started.load(Ordering::Acquire));
        assert!(manager
            .list(ListJobsParams {
                include_terminal: true,
            })
            .await
            .expect("list")
            .is_empty());
    }

    #[tokio::test]
    async fn dense_raster_disk_admission_records_estimate_before_worker_runs() {
        let components = disk_estimate_components(
            PhotolabJobKind::BuildDem,
            DiskEstimateScale::DenseRaster {
                point_count: 45_800_000,
                raster_pixels: 3,
            },
        );
        let available_bytes = components.required_bytes + GIB;
        let manager = JobManager::with_runtime_history_and_disk_availability(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            Handle::current(),
            None,
            Arc::new(move |_| Ok(available_bytes)),
        )
        .expect("manager");
        let path = PathBuf::from("/project/.photolab/raster-inputs/dem-job");
        let started = manager
            .start_with_disk_admission(
                request_for_kind("dem-job", PhotolabJobKind::BuildDem),
                JobAdmission {
                    publication_targets: Vec::new(),
                    disk_preflight: Some(DiskPreflight {
                        required_bytes: components.required_bytes,
                        path: path.clone(),
                    }),
                    memory_preflight: None,
                    toolchain_preflight: None,
                },
                components,
                |_| Ok(()),
            )
            .await
            .expect("sufficient dense-raster disk must admit");
        assert_eq!(
            started.job.disk_estimate,
            Some(PhotolabJobDiskEstimate {
                scratch_bytes: components.scratch_bytes,
                output_bytes: components.output_bytes,
                available_bytes,
                volume: path.to_string_lossy().into_owned(),
            })
        );
        manager
            .wait_for_terminal(&PhotolabJobId("dem-job".into()))
            .await
            .expect("worker completed");
    }

    #[tokio::test]
    async fn durable_history_is_filtered_by_current_project_and_receives_terminal_state() {
        let history = Arc::new(MemoryHistory::default());
        history.select("project-a");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        manager
            .start(request("project-a-job"), |_| Ok(()))
            .await
            .expect("start");
        manager
            .wait_for_terminal(&PhotolabJobId("project-a-job".into()))
            .await
            .expect("terminal");
        assert!(matches!(
            history
                .load_current()
                .expect("durable history")
                .first()
                .map(|job| &job.state),
            Some(PhotolabJobState::Completed)
        ));

        history.select("project-b");
        assert!(manager
            .list(ListJobsParams {
                include_terminal: true,
            })
            .await
            .expect("project-b list")
            .is_empty());
        assert!(matches!(
            manager.status(&PhotolabJobId("project-a-job".into())).await,
            Err(JobManagerError::JobNotFound(_))
        ));
    }

    #[tokio::test]
    async fn frequent_progress_is_throttled_but_stage_and_terminal_are_durable() {
        let history = Arc::new(MemoryHistory::default());
        history.select("progress-project");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        let mut job = request("progress-job");
        job.progress.stage.stage_count = 2;
        manager
            .start(job, move |context| {
                for completed in 0..100 {
                    context.progress.report_blocking(JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::FeatureMatching,
                            index: 1,
                            stage_count: 2,
                            label: "Match features".into(),
                        },
                        metrics: ProgressMetrics {
                            completed_units: completed,
                            total_units: Some(100),
                            completed_bytes: completed * 10,
                            total_bytes: Some(1_000),
                        },
                    })?;
                }
                Ok(())
            })
            .await
            .expect("start");
        manager
            .wait_for_terminal(&PhotolabJobId("progress-job".into()))
            .await
            .expect("terminal");
        let writes = history.persist_count.load(Ordering::Relaxed);
        assert!(
            (4..20).contains(&writes),
            "queued, running, stage transition, and terminal should be durable without one write per progress event; got {writes} writes"
        );
    }

    fn committed_checkpoint(job_id: &str) -> CheckpointDescriptor {
        let mut checkpoint = CheckpointDescriptor::pending(NewPendingCheckpoint {
            checkpoint_id: CheckpointId("checkpoint-1".into()),
            job_id: PhotolabJobId(job_id.into()),
            job_kind: PhotolabJobKind::AlignPhotos,
            sequence: 1,
            progress: progress(5),
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            temporary_object_key: "tmp/checkpoint-1".into(),
            expected_payload_hash: hash("payload"),
        })
        .expect("pending checkpoint");
        checkpoint.commit(hash("payload")).expect("commit");
        checkpoint
    }

    #[test]
    fn configuration_requires_non_zero_concurrency() {
        assert!(matches!(
            JobManagerConfig {
                max_concurrency: 0,
                max_queued: 1,
            }
            .capacity(),
            Err(JobManagerError::InvalidConfig(_))
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_and_concurrency_are_bounded_without_blocking_start() {
        let manager = manager(1, 1);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start(request("first"), move |_| {
                started_tx.send(()).expect("signal start");
                release_rx.recv().expect("release");
                Ok(())
            })
            .await
            .expect("first admitted");
        started_rx.recv().expect("first running");
        manager
            .start(request("second"), |_| Ok(()))
            .await
            .expect("second queued");
        let full = manager.start(request("third"), |_| Ok(())).await;
        assert!(matches!(full, Err(JobManagerError::QueueFull { .. })));
        assert_eq!(
            manager
                .list(ListJobsParams::default())
                .await
                .expect("list")
                .len(),
            2
        );
        release_tx.send(()).expect("release first");
        manager
            .wait_for_terminal(&PhotolabJobId("first".into()))
            .await
            .expect("first finishes");
        manager
            .wait_for_terminal(&PhotolabJobId("second".into()))
            .await
            .expect("second finishes");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compute_lease_serializes_workers_across_managers() {
        let first_manager = manager(1, 0);
        let second_manager = manager(1, 0);
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        first_manager
            .start(request("lease-first"), move |_| {
                first_started_tx.send(()).expect("signal first start");
                release_first_rx.recv().expect("release first");
                Ok(())
            })
            .await
            .expect("first admitted");
        first_started_rx.recv().expect("first running");

        let (second_started_tx, second_started_rx) = mpsc::channel();
        second_manager
            .start(request("lease-second"), move |_| {
                second_started_tx.send(()).expect("signal second start");
                Ok(())
            })
            .await
            .expect("second admitted");
        assert!(second_started_rx
            .recv_timeout(Duration::from_millis(250))
            .is_err());

        release_first_tx.send(()).expect("release first");
        first_manager
            .wait_for_terminal(&PhotolabJobId("lease-first".into()))
            .await
            .expect("first terminal");
        second_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second starts after first releases the lease");
        second_manager
            .wait_for_terminal(&PhotolabJobId("lease-second".into()))
            .await
            .expect("second terminal");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_is_immediately_visible_and_reaches_worker() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("cancel-me".into());
        let (started_tx, started_rx) = mpsc::channel();
        manager
            .start(request(&id.0), move |context| {
                started_tx.send(()).expect("signal worker start");
                loop {
                    context.check_cancelled()?;
                    std::thread::yield_now();
                }
            })
            .await
            .expect("admitted");
        started_rx.recv().expect("worker started");
        let result = manager.cancel(&id).await.expect("cancel");
        assert!(matches!(
            result.job.state,
            PhotolabJobState::CancelRequested | PhotolabJobState::Cancelled
        ));
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_all_protects_a_project_session_change() {
        let manager = manager(1, 2);
        let (started_tx, started_rx) = mpsc::channel();
        manager
            .start(request("running"), move |context| {
                started_tx.send(()).expect("signal worker start");
                loop {
                    context.check_cancelled()?;
                    std::thread::yield_now();
                }
            })
            .await
            .expect("running admitted");
        started_rx.recv().expect("worker started");
        manager
            .start(request("queued"), |_| Ok(()))
            .await
            .expect("queued admitted");

        let changed = manager.cancel_all().await;
        assert_eq!(changed.len(), 2);
        assert_eq!(
            manager
                .wait_for_terminal(&PhotolabJobId("running".into()))
                .await
                .expect("running terminal")
                .state,
            PhotolabJobState::Cancelled
        );
        assert_eq!(
            manager
                .wait_for_terminal(&PhotolabJobId("queued".into()))
                .await
                .expect("queued terminal")
                .state,
            PhotolabJobState::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drain_cancels_a_slow_worker_and_reports_terminal_state() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("drain-slow-worker".into());
        let (started_tx, started_rx) = mpsc::channel();
        let cancellation_observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_observed = Arc::clone(&cancellation_observed);
        manager
            .start(request(&id.0), move |context| {
                started_tx.send(()).expect("signal worker start");
                loop {
                    if context.cancellation.is_cancel_requested() {
                        worker_observed.store(true, Ordering::Release);
                        return Err(JobWorkerError::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
            .await
            .expect("admitted");
        started_rx.recv().expect("worker started");

        let report = manager.drain(Duration::from_secs(1)).await;

        assert_eq!(report.terminal, 1);
        assert!(report.timed_out.is_empty());
        assert!(cancellation_observed.load(Ordering::Acquire));
        assert_eq!(
            manager.status(&id).await.expect("terminal status").state,
            PhotolabJobState::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drain_timeout_force_marks_the_job_failed_with_a_diagnostic() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("drain-timeout-worker".into());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start(request(&id.0), move |_| {
                started_tx.send(()).expect("signal worker start");
                release_rx.recv().expect("release timed-out worker");
                Ok(())
            })
            .await
            .expect("admitted");
        started_rx.recv().expect("worker started");

        let report = manager.drain(Duration::from_millis(20)).await;
        assert_eq!(report.terminal, 0);
        assert_eq!(report.timed_out, vec![id.clone()]);
        let terminal = manager.status(&id).await.expect("forced terminal status");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "drainTimeout"
        ));
        assert!(terminal
            .terminal_diagnostic
            .as_deref()
            .is_some_and(|diagnostic| diagnostic.contains("20 ms")));
        let repeated = manager.drain(Duration::from_millis(20)).await;
        assert_eq!(repeated.timed_out, vec![id.clone()]);
        release_tx.send(()).expect("release worker after assertion");
        let completed = manager.drain(Duration::from_secs(1)).await;
        assert_eq!(completed.terminal, 1);
        assert!(completed.timed_out.is_empty());
    }

    #[tokio::test]
    async fn worker_sinks_publish_progress_and_checkpoint() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("sinks".into());
        let worker_id = id.clone();
        manager
            .start(request(&id.0), move |context| {
                context.progress.report_blocking(progress(5))?;
                context
                    .checkpoints
                    .record_blocking(&committed_checkpoint(&worker_id.0))?;
                Ok(())
            })
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert_eq!(terminal.progress.metrics.completed_units, 10);
        assert_eq!(terminal.progress.metrics.completed_bytes, 1_000);
        assert_eq!(terminal.last_checkpoint_sequence, Some(1));
    }

    #[tokio::test]
    async fn durable_depth_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildDepthMaps,
            "durable-depth-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn durable_dense_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildDensePointCloud,
            "durable-dense-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn durable_dem_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(PhotolabJobKind::BuildDem, "durable-dem-checkpoint")
            .await;
    }

    #[tokio::test]
    async fn durable_orthomosaic_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildOrthomosaic,
            "durable-orthomosaic-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn durable_batch_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(PhotolabJobKind::Batch, "durable-batch-checkpoint")
            .await;
    }

    #[tokio::test]
    async fn durable_splat_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildGaussianSplat,
            "durable-splat-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn cancellation_retains_non_fatal_terminal_diagnostic() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("cancel-diagnostic".into());
        let worker_id = id.clone();
        manager
            .start(request(&id.0), move |context| {
                context
                    .diagnostics
                    .record_blocking("checkpoint write failed after retry")?;
                context.cancellation.request_cancel();
                Err(JobWorkerError::Cancelled)
            })
            .await
            .expect("admitted");
        let terminal = manager
            .wait_for_terminal(&worker_id)
            .await
            .expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        assert_eq!(
            terminal.terminal_diagnostic.as_deref(),
            Some("checkpoint write failed after retry")
        );
    }

    #[tokio::test]
    async fn progress_window_maps_child_stages_into_immutable_parent_plan() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("mapped-progress".into());
        let mut parent = request(&id.0);
        parent.progress.stage.stage_count = 65;
        manager
            .start(parent, move |context| {
                let mapped = context.with_progress_window(7, 65);
                let mut child = progress(4);
                child.stage.index = 2;
                child.stage.stage_count = 3;
                mapped.progress.report_blocking(child)?;
                Ok(())
            })
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert_eq!(terminal.progress.stage.index, 64);
        assert_eq!(terminal.progress.stage.stage_count, 65);
    }

    #[tokio::test]
    async fn worker_panic_becomes_failed_join_status() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("panic".into());
        manager
            .start(request(&id.0), |_| panic!("worker exploded"))
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "workerJoin"
        ));
    }

    #[tokio::test]
    async fn closed_scheduler_uses_fail_job_without_deadlocking() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("closed-scheduler".into());
        manager.inner.concurrency.close();
        manager
            .start(request(&id.0), |_| panic!("worker must not start"))
            .await
            .expect("job is admitted before async scheduling");

        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "schedulerClosed"
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_job_cancels_without_consuming_worker_slot() {
        let manager = manager(1, 1);
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start(request("running"), move |_| {
                release_rx.recv().expect("release");
                Ok(())
            })
            .await
            .expect("running admitted");
        let queued = PhotolabJobId("queued".into());
        manager
            .start(request(&queued.0), |_| panic!("queued worker must not run"))
            .await
            .expect("queued admitted");
        let cancelled = manager.cancel(&queued).await.expect("cancel queued");
        assert_eq!(cancelled.job.state, PhotolabJobState::Cancelled);
        release_tx.send(()).expect("release");
    }

    fn alignment_memory_request(usable_gib: u64) -> AlignmentMemoryRequest {
        AlignmentMemoryRequest {
            usable_bytes: usable_gib * GIB,
            logical_cpus: 8,
            image_dimensions: vec![(5_280, 3_956)],
            max_image_edge: 8_192,
            keypoints: 24_000,
            neural_matching: true,
            measured_extraction_bytes_per_pixel: None,
        }
    }

    #[test]
    fn measured_alignment_memory_models_match_calibration_points() {
        let extraction = extraction_bytes_for_image(5_280, 3_956, 8_192, 750);
        assert_eq!(extraction, 15_665_760_000);
        assert!((extraction as f64 / 1_000_000_000.0 - 15.7).abs() < 0.1);

        let matching = neural_matching_bytes_per_worker(8_122);
        assert_eq!(matching, 3_434_845_888);
        assert!((matching as f64 / 1_000_000_000.0 - 3.43).abs() / 3.43 < 0.01);
        let eight_threads = matching.saturating_mul(8);
        assert_eq!(eight_threads, 27_478_767_104);
        assert!((eight_threads as f64 / 1_000_000_000.0 - 27.5).abs() < 0.1);
    }

    #[test]
    fn matching_replan_caps_an_oversized_database_before_launch() {
        let replan = replan_alignment_matching(29 * GIB, 8, 24_000, 48_000)
            .expect("the planned 24k matcher unit fits");
        assert_eq!(replan.keypoint_cap, 24_000);
        assert_eq!(replan.record.actual_max_keypoints, 48_000);
        assert_eq!(replan.record.matching_workers, 1);
        assert_eq!(replan.record.matching_unit_bytes, 27_916_435_456);
        assert_eq!(
            replan.degradation,
            Some(PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 48_000,
                to: 24_000,
            })
        );
    }

    #[test]
    fn sixteen_gib_caps_the_planned_24k_unit_to_the_largest_fitting_quantum() {
        let replan = replan_alignment_matching(16 * GIB, 8, 24_000, 48_000)
            .expect("a capped matcher unit fits 16 GiB");
        assert_eq!(replan.keypoint_cap, 18_500);
        assert_eq!(replan.record.matching_workers, 1);
        assert_eq!(replan.record.matching_unit_bytes, 16_696_435_456);
        assert_eq!(
            replan.degradation,
            Some(PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 48_000,
                to: 18_500,
            })
        );
    }

    #[test]
    fn matching_replan_refuses_when_even_the_minimum_unit_cannot_fit() {
        let available = NEURAL_MATCHING_FIXED_BASE_BYTES;
        let refusal = replan_alignment_matching(available, 8, 24_000, 48_000)
            .expect_err("the minimum 500-keypoint unit exceeds this envelope");
        assert!(refusal.predicted_bytes > refusal.available_bytes);
        assert_eq!(refusal.available_bytes, available);
    }

    #[tokio::test]
    async fn matching_replan_and_worker_limit_hit_are_persisted_before_failure() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("memory-limit-record".into());
        manager
            .start(request(&id.0), |context| {
                context
                    .memory
                    .record_matching_replan_blocking(
                        PhotolabMatchingMemoryReplan {
                            actual_max_keypoints: 24_000,
                            matching_workers: 1,
                            matching_unit_bytes: 27_916_435_456,
                        },
                        24_000,
                        None,
                    )
                    .map_err(|error| JobWorkerError::Failed {
                        code: "memoryRecord".into(),
                        message: error.to_string(),
                    })?;
                context
                    .memory
                    .record_worker_memory_limit_hit_blocking("Match ALIKED with LightGlue", 8 * GIB)
                    .map_err(|error| JobWorkerError::Failed {
                        code: "memoryRecord".into(),
                        message: error.to_string(),
                    })?;
                Err(JobWorkerError::Failed {
                    code: "workerMemoryLimit".into(),
                    message: "bounded test failure".into(),
                })
            })
            .await
            .expect("admit memory-record test");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "workerMemoryLimit"
        ));
        assert_eq!(
            terminal.memory.matching_replanned,
            Some(PhotolabMatchingMemoryReplan {
                actual_max_keypoints: 24_000,
                matching_workers: 1,
                matching_unit_bytes: 27_916_435_456,
            })
        );
        assert!(terminal.memory.degradations.contains(
            &PhotolabMemoryDegradation::WorkerMemoryLimitHit {
                stage: "Match ALIKED with LightGlue".into(),
                limit_bytes: 8 * GIB,
            }
        ));
    }

    #[test]
    fn calibrated_matching_plan_uses_the_reference_machine_envelope() {
        let mut fast = alignment_memory_request(29);
        fast.usable_bytes = 29_100_000_000;
        fast.keypoints = 8_192;
        let fast_plan = plan_alignment_memory(&fast);
        assert_eq!(fast_plan.matching_unit_bytes, 3_489_660_928);
        assert_eq!(fast_plan.matching_workers, 4);
        assert!(fast_plan.memory.degradations.is_empty());
        let matching_stage = fast_plan
            .memory
            .stages
            .iter()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
            .expect("matching stage memory");
        assert_eq!(
            matching_stage.parameters.get("modelBytes"),
            Some(&serde_json::json!(13_958_643_712_u64))
        );

        let mut quality = fast.clone();
        quality.keypoints = 24_000;
        let quality_plan = plan_alignment_memory(&quality);
        assert_eq!(quality_plan.matching_unit_bytes, 27_916_435_456);
        assert_eq!(quality_plan.matching_workers, 1);
        assert_eq!(quality_plan.keypoints, 24_000);
        assert!(quality_plan.memory.degradations.is_empty());

        quality.usable_bytes = 16_000_000_000;
        let constrained = plan_alignment_memory(&quality);
        assert_eq!(constrained.keypoints, 18_000);
        assert_eq!(constrained.matching_unit_bytes, 15_820_435_456);
        assert_eq!(constrained.matching_workers, 1);
        assert!(constrained.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 18_000,
            }
        ));
    }

    #[test]
    fn matching_stage_limit_is_half_the_reference_envelope_regardless_of_model() {
        let usable_bytes = 29_100_000_000;
        let expected_limit = 14_550_000_000;
        assert_eq!(
            matching_stage_memory_limit_bytes(usable_bytes),
            expected_limit
        );
        for keypoints in [8_192, 24_000] {
            let mut request = alignment_memory_request(29);
            request.usable_bytes = usable_bytes;
            request.keypoints = keypoints;
            let plan = plan_alignment_memory(&request);
            let matching = plan
                .memory
                .stages
                .iter()
                .find(|stage| stage.stage == "Match ALIKED with LightGlue")
                .expect("matching stage memory");
            assert_eq!(
                matching.parameters.get("stageBudgetBytes"),
                Some(&serde_json::json!(expected_limit))
            );
        }
    }

    #[test]
    fn alignment_memory_plan_applies_time_before_quality() {
        // The 32 GB reference laptop: 31 GiB physical minus the 4 GiB reserve ≈ 27 GiB
        // usable — one full-resolution extraction (15.7 GB) fits once, so one worker,
        // slower, with no quality degradation (owner S23).
        let plan_laptop = plan_alignment_memory(&alignment_memory_request(27));
        assert_eq!(plan_laptop.extraction_workers, 1);
        // The calibrated 24k unit occupies nearly the full envelope, so matching is sequential.
        assert_eq!(plan_laptop.matching_workers, 1);
        assert_eq!(plan_laptop.extraction_edge, 8_192);
        assert_eq!(plan_laptop.keypoints, 24_000);
        assert_eq!(plan_laptop.extraction_tiling, None);
        assert!(plan_laptop.memory.degradations.is_empty());

        // 32 GiB usable (≈ 36 GB machine): two extractions fit side by side; the calibrated
        // 24k matcher remains sequential. No fixed worker cap (owner S23).
        let plan_32 = plan_alignment_memory(&alignment_memory_request(32));
        assert_eq!(plan_32.extraction_workers, 2);
        assert_eq!(plan_32.matching_workers, 1);
        assert!(plan_32.sequential_pair_batches);
        assert_eq!(plan_32.extraction_edge, 8_192);
        assert_eq!(plan_32.keypoints, 24_000);
        assert_eq!(plan_32.extraction_tiling, None);
        assert!(plan_32.memory.degradations.is_empty());

        // 64 GB class (56 GiB usable): three extraction workers, still no degradation —
        // more memory only buys time.
        let plan_64 = plan_alignment_memory(&alignment_memory_request(56));
        assert_eq!(plan_64.extraction_workers, 3);
        assert_eq!(plan_64.matching_workers, 1);
        assert_eq!(plan_64.extraction_edge, 8_192);
        assert_eq!(plan_64.keypoints, 24_000);
        assert_eq!(plan_64.extraction_tiling, None);
        assert!(plan_64.memory.degradations.is_empty());

        let plan_16 = plan_alignment_memory(&alignment_memory_request(16));
        assert_eq!(plan_16.extraction_workers, 1);
        assert_eq!(plan_16.matching_workers, 1);
        assert!(plan_16.sequential_pair_batches);
        assert_eq!(plan_16.extraction_edge, 8_192);
        assert_eq!(plan_16.keypoints, 18_500);
        assert_eq!(plan_16.extraction_tiling, None);
        assert!(plan_16.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 18_500,
            }
        ));

        // The 16 GB gate host reports 14.3 GB available. After the 4 GiB reserve,
        // 10.3 GiB usable keeps the requested feature budget and splits the 21 MP
        // image into the smallest fitting grid: two horizontal tiles.
        let mut gate_request = alignment_memory_request(10);
        gate_request.usable_bytes = 103 * GIB / 10;
        gate_request.logical_cpus = 4;
        let plan_gate = plan_alignment_memory(&gate_request);
        assert_eq!(plan_gate.extraction_workers, 1);
        assert_eq!(plan_gate.matching_workers, 1);
        assert!(plan_gate.sequential_pair_batches);
        assert_eq!(plan_gate.extraction_edge, 8_192);
        assert_eq!(plan_gate.keypoints, 14_500);
        assert_eq!(
            plan_gate.extraction_tiling,
            Some(AlignmentExtractionTiling {
                columns: 2,
                rows: 1,
                tiles: 2,
                overlap_px: EXTRACTION_TILE_OVERLAP_PX,
            })
        );
        assert_eq!(
            plan_gate.memory.time_first_choices,
            vec![PhotolabMemoryTimeFirstChoice::ExtractionTiled {
                tiles: 2,
                overlap_px: EXTRACTION_TILE_OVERLAP_PX,
            }]
        );
        assert!(plan_gate.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 14_500,
            }
        ));

        let plan_8 = plan_alignment_memory(&alignment_memory_request(8));
        assert_eq!(plan_8.extraction_workers, 1);
        assert_eq!(plan_8.matching_workers, 1);
        assert!(plan_8.sequential_pair_batches);
        assert_eq!(plan_8.extraction_edge, 8_192);
        assert_eq!(plan_8.keypoints, 13_000);
        assert_eq!(plan_8.extraction_tiling.expect("tiled extraction").tiles, 2);
        assert!(plan_8.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 13_000,
            }
        ));
    }

    #[tokio::test]
    async fn memory_preflight_refuses_only_when_smallest_unit_cannot_fit() {
        let manager = manager(1, 0);
        let tiny = plan_alignment_memory(&AlignmentMemoryRequest {
            usable_bytes: 128 * MIB,
            ..alignment_memory_request(8)
        });
        assert_eq!(tiny.extraction_tiling, None);
        assert!(matches!(
            tiny.memory.degradations.first(),
            Some(PhotolabMemoryDegradation::ExtractionEdgeReduced { .. })
        ));
        assert!(tiny.predicted_peak_bytes > 128 * MIB);
        let predicted_bytes = tiny.predicted_peak_bytes;
        let started = Arc::new(AtomicBool::new(false));
        let started_in_worker = started.clone();
        let error = manager
            .start_with_admission(
                request("memory-rejected"),
                JobAdmission {
                    publication_targets: Vec::new(),
                    disk_preflight: None,
                    memory_preflight: Some(MemoryPreflight {
                        predicted_bytes,
                        available_bytes: 128 * MIB,
                        machine_usable_bytes: 128 * MIB,
                        memory: tiny.memory,
                        refusal: None,
                    }),
                    toolchain_preflight: None,
                },
                move |_| {
                    started_in_worker.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .expect_err("an impossible unit must be refused");
        assert_eq!(
            error,
            JobManagerError::InsufficientMemory {
                predicted_bytes,
                available_bytes: 128 * MIB,
            }
        );
        assert!(!started.load(Ordering::Acquire));

        for usable_gib in [32, 16, 8] {
            let plan = plan_alignment_memory(&alignment_memory_request(usable_gib));
            assert!(plan.predicted_peak_bytes <= usable_gib * GIB);
        }
    }

    #[tokio::test]
    async fn typed_admission_refusal_records_the_memory_plan_without_starting_a_worker() {
        let manager = manager(1, 0);
        let plan = plan_alignment_memory(&alignment_memory_request(8));
        let tiling = plan.extraction_tiling.expect("tiled extraction plan");
        let started = Arc::new(AtomicBool::new(false));
        let started_in_worker = started.clone();
        let result = manager
            .start_with_admission(
                request("quality-hybrid-refused"),
                JobAdmission {
                    publication_targets: Vec::new(),
                    disk_preflight: None,
                    memory_preflight: Some(MemoryPreflight {
                        predicted_bytes: plan.predicted_peak_bytes,
                        available_bytes: 8 * GIB,
                        machine_usable_bytes: 8 * GIB,
                        memory: plan.memory.clone(),
                        refusal: Some(JobAdmissionRefusal {
                            code: ALIGNMENT_NEEDS_UNTILED_EXTRACTION_CODE.into(),
                            message: ALIGNMENT_NEEDS_UNTILED_EXTRACTION_MESSAGE.into(),
                        }),
                    }),
                    toolchain_preflight: None,
                },
                move |_| {
                    started_in_worker.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .expect("typed refusal must be recorded");

        assert_eq!(
            result.job.state,
            PhotolabJobState::Failed {
                code: ALIGNMENT_NEEDS_UNTILED_EXTRACTION_CODE.into(),
                message: ALIGNMENT_NEEDS_UNTILED_EXTRACTION_MESSAGE.into(),
            }
        );
        assert!(!started.load(Ordering::Acquire));
        assert_eq!(result.job.memory.envelope_bytes, 8 * GIB);
        assert!(result.job.memory.time_first_choices.contains(
            &PhotolabMemoryTimeFirstChoice::ExtractionTiled {
                tiles: tiling.tiles,
                overlap_px: tiling.overlap_px,
            }
        ));
        assert_eq!(
            result.job.memory.stages[0].parameters["maxImageSize"],
            serde_json::json!(8_192)
        );

        let fast_proceeded = Arc::new(AtomicBool::new(false));
        let fast_proceeded_in_worker = fast_proceeded.clone();
        manager
            .start_with_admission(
                request("fast-tiled-proceeds"),
                JobAdmission {
                    publication_targets: Vec::new(),
                    disk_preflight: None,
                    memory_preflight: Some(MemoryPreflight {
                        predicted_bytes: plan.predicted_peak_bytes,
                        available_bytes: 8 * GIB,
                        machine_usable_bytes: 8 * GIB,
                        memory: plan.memory,
                        refusal: None,
                    }),
                    toolchain_preflight: None,
                },
                move |_| {
                    fast_proceeded_in_worker.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .expect("Fast tiled extraction proceeds");
        manager
            .wait_for_terminal(&PhotolabJobId("fast-tiled-proceeds".into()))
            .await
            .expect("worker completes");
        assert!(fast_proceeded.load(Ordering::Acquire));

        let untiled_plan = plan_alignment_memory(&alignment_memory_request(16));
        assert_eq!(untiled_plan.extraction_tiling, None);
        let quality_proceeded = Arc::new(AtomicBool::new(false));
        let quality_proceeded_in_worker = quality_proceeded.clone();
        manager
            .start_with_admission(
                request("quality-hybrid-untiled-proceeds"),
                JobAdmission {
                    publication_targets: Vec::new(),
                    disk_preflight: None,
                    memory_preflight: Some(MemoryPreflight {
                        predicted_bytes: untiled_plan.predicted_peak_bytes,
                        available_bytes: 16 * GIB,
                        machine_usable_bytes: 16 * GIB,
                        memory: untiled_plan.memory,
                        refusal: None,
                    }),
                    toolchain_preflight: None,
                },
                move |_| {
                    quality_proceeded_in_worker.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .expect("Quality Hybrid untiled extraction proceeds");
        manager
            .wait_for_terminal(&PhotolabJobId("quality-hybrid-untiled-proceeds".into()))
            .await
            .expect("worker completes");
        assert!(quality_proceeded.load(Ordering::Acquire));
    }
}
