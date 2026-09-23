//! Bounded Photolab worker orchestration for the sidecar.

use himmelcad_core::photolab_jobs::{
    PhotolabJobMemory, PhotolabMatchingMemoryReplan, PhotolabMemoryDegradation,
    PhotolabMemoryTimeFirstChoice, PhotolabRasterPreparationMemory,
    PhotolabRasterPreparationStageMemory, PhotolabStageMemory,
};
use serde::{Deserialize, Serialize};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT: u64 = 88;
const DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT: u64 = 145;

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
/// WP-A7k X6 calibration for LightGlue's resident memory: twenty-one fp32
/// attention-sized activation layers plus the fixed base fit the measured one-
/// and two-thread runs at 8,122 merged keypoints. The model deliberately
/// over-predicts the incomplete and OOM-terminated higher-concurrency runs.
///
/// | Matcher threads | Observed peak | Model prediction |
/// | ---: | ---: | ---: |
/// | 1 | 6.0 GiB (WIN-07/WIN-09) | 5.81 GB |
/// | 2 | 12.11 GB (smoke #5 attempt 2) | 11.62 GB |
/// | 4 | at least 14.52 GB; killed at cap (smoke #5 attempt 1) | 23.24 GB |
/// | 8 | 26.4–28.8 GB; kernel OOM kills (2026-09-09) | 46.48 GB |
pub const NEURAL_MATCHING_ATTENTION_LAYERS: u64 = 21;
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

pub use himmelcad_command::job_runtime::*;

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        fs::{self, File},
        io::Write,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Arc, Mutex as StdMutex,
        },
        time::Duration,
    };

    use himmelcad_core::{
        entity::EntityId,
        hash::ObjectHash,
        photolab_jobs::{
            CheckpointDescriptor, CheckpointId, JobProgress, NewPendingCheckpoint, NewPhotolabJob,
            PhotolabJob, PhotolabJobDiskEstimate, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
            PhotolabStage, PhotolabStageKind, ProgressMetrics,
        },
        photolab_products::ProductKind,
    };
    use tokio::{runtime::Handle, time::sleep};

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
        assert_eq!(matching, 5_809_653_712);
        assert!((matching as f64 / 1_000_000_000.0 - 5.81).abs() / 5.81 < 0.01);
        let eight_threads = matching.saturating_mul(8);
        assert_eq!(eight_threads, 46_477_229_696);
        assert!((eight_threads as f64 / 1_000_000_000.0 - 46.5).abs() < 0.1);
    }

    #[test]
    fn matching_replan_caps_an_oversized_database_before_launch() {
        let replan = replan_alignment_matching(29 * GIB, 8, 24_000, 48_000)
            .expect("the planned 24k matcher unit fits");
        assert_eq!(replan.keypoint_cap, 19_000);
        assert_eq!(replan.record.actual_max_keypoints, 48_000);
        assert_eq!(replan.record.matching_workers, 1);
        assert_eq!(replan.record.matching_unit_bytes, 30_592_435_456);
        assert_eq!(
            replan.degradation,
            Some(PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 48_000,
                to: 19_000,
            })
        );
    }

    #[test]
    fn sixteen_gib_caps_the_planned_24k_unit_to_the_largest_fitting_quantum() {
        let replan = replan_alignment_matching(16 * GIB, 8, 24_000, 48_000)
            .expect("a capped matcher unit fits 16 GiB");
        assert_eq!(replan.keypoint_cap, 14_000);
        assert_eq!(replan.record.matching_workers, 1);
        assert_eq!(replan.record.matching_unit_bytes, 16_732_435_456);
        assert_eq!(
            replan.degradation,
            Some(PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 48_000,
                to: 14_000,
            })
        );
    }

    #[test]
    fn windows_sixteen_gb_gate_keeps_the_observed_8_122_keypoints() {
        let replan = replan_alignment_matching(10_660_000_000, 4, 24_000, 8_122)
            .expect("one measured matcher thread fits the usable envelope");
        assert_eq!(replan.keypoint_cap, 8_122);
        assert_eq!(replan.record.actual_max_keypoints, 8_122);
        assert_eq!(replan.record.matching_workers, 1);
        assert_eq!(replan.record.matching_unit_bytes, 5_809_653_712);
        assert_eq!(replan.degradation, None);
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
                            matching_unit_bytes: 48_652_435_456,
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
                matching_unit_bytes: 48_652_435_456,
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
        assert_eq!(fast_plan.matching_unit_bytes, 5_905_580_032);
        assert_eq!(fast_plan.matching_workers, 2);
        assert!(fast_plan.memory.degradations.is_empty());
        let matching_stage = fast_plan
            .memory
            .stages
            .iter()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
            .expect("matching stage memory");
        assert_eq!(
            matching_stage.parameters.get("modelBytes"),
            Some(&serde_json::json!(11_811_160_064_u64))
        );

        let mut quality = fast.clone();
        quality.keypoints = 24_000;
        let quality_plan = plan_alignment_memory(&quality);
        assert_eq!(quality_plan.matching_unit_bytes, 29_017_435_456);
        assert_eq!(quality_plan.matching_workers, 1);
        assert_eq!(quality_plan.keypoints, 18_500);
        assert!(quality_plan.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 18_500,
            }
        ));

        quality.usable_bytes = 16_000_000_000;
        let constrained = plan_alignment_memory(&quality);
        assert_eq!(constrained.keypoints, 13_500);
        assert_eq!(constrained.matching_unit_bytes, 15_577_435_456);
        assert_eq!(constrained.matching_workers, 1);
        assert!(constrained.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 13_500,
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
        // slower, before the independent matching-quality fit is applied (owner S23).
        let plan_laptop = plan_alignment_memory(&alignment_memory_request(27));
        assert_eq!(plan_laptop.extraction_workers, 1);
        // The calibrated model preserves time-before-quality, then caps only because one 24k
        // matching unit cannot fit the complete usable envelope.
        assert_eq!(plan_laptop.matching_workers, 1);
        assert_eq!(plan_laptop.extraction_edge, 8_192);
        assert_eq!(plan_laptop.keypoints, 18_000);
        assert_eq!(plan_laptop.extraction_tiling, None);
        assert!(plan_laptop.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 18_000,
            }
        ));

        // 32 GiB usable (≈ 36 GB machine): two extractions fit side by side; the calibrated
        // 24k matcher remains sequential and is capped only enough for one unit to fit.
        // There is no fixed worker cap (owner S23).
        let plan_32 = plan_alignment_memory(&alignment_memory_request(32));
        assert_eq!(plan_32.extraction_workers, 2);
        assert_eq!(plan_32.matching_workers, 1);
        assert!(plan_32.sequential_pair_batches);
        assert_eq!(plan_32.extraction_edge, 8_192);
        assert_eq!(plan_32.keypoints, 20_000);
        assert_eq!(plan_32.extraction_tiling, None);
        assert!(plan_32.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 20_000,
            }
        ));

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
        assert_eq!(plan_16.keypoints, 14_000);
        assert_eq!(plan_16.extraction_tiling, None);
        assert!(plan_16.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 14_000,
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
        assert_eq!(plan_gate.keypoints, 11_000);
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
                to: 11_000,
            }
        ));

        let plan_8 = plan_alignment_memory(&alignment_memory_request(8));
        assert_eq!(plan_8.extraction_workers, 1);
        assert_eq!(plan_8.matching_workers, 1);
        assert!(plan_8.sequential_pair_batches);
        assert_eq!(plan_8.extraction_edge, 8_192);
        assert_eq!(plan_8.keypoints, 9_500);
        assert_eq!(plan_8.extraction_tiling.expect("tiled extraction").tiles, 2);
        assert!(plan_8.memory.degradations.contains(
            &PhotolabMemoryDegradation::MatchingKeypointsCapped {
                from: 24_000,
                to: 9_500,
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
