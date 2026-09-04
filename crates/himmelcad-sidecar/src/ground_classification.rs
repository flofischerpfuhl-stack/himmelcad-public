//! Deterministic SMRF ground classification for dense PhotoLab point clouds.

use std::collections::VecDeque;

use himmelcad_core::photolab_jobs::CancellationToken;
use thiserror::Error;

/// The dense-grid ceiling keeps allocation bounded while still admitting large survey sites.
/// Raise `cell_size_m` when a site would exceed this X6 operational tuning limit.
pub const MAX_GRID_CELLS: u64 = 200_000_000;

/// X6 cancellation cadence: bounds stop latency without making progress reporting noisy.
const CLASSIFICATION_CHUNK_POINTS: usize = 8_192;
/// X6 cancellation cadence for morphology: bounds latency on very wide or tall grids.
const GRID_CANCELLATION_ROWS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SmrfParams {
    pub cell_size_m: f64,
    pub slope: f64,
    pub max_window_m: f64,
    pub initial_distance_m: f64,
}

impl Default for SmrfParams {
    fn default() -> Self {
        Self {
            // About 2–5 times typical UAV GSD: enough samples per cell without hiding structures.
            cell_size_m: 1.0,
            // A 15% terrain tolerance retains common surveyed ramps and embankments.
            slope: 0.15,
            // Eighteen metres removes typical building footprints without a city-scale kernel.
            max_window_m: 18.0,
            // Half a metre tolerates dense-cloud noise and low vegetation near the terrain surface.
            initial_distance_m: 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PointClass {
    Unclassified = 1,
    Ground = 2,
}

impl From<PointClass> for u8 {
    fn from(value: PointClass) -> Self {
        value as Self
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum GroundClassificationError {
    #[error("ground classification was cancelled")]
    Cancelled,
    #[error("invalid SMRF parameters: {0}")]
    InvalidParameters(&'static str),
    #[error(
        "ground-classification grid needs {cells} cells, exceeding the {maximum} cell limit; raise the ground-classification cell size"
    )]
    GridTooLarge { cells: u64, maximum: u64 },
    #[error("ground-classification grid dimensions overflow")]
    GridDimensionsOverflow,
    #[error("point {index} has a non-finite coordinate")]
    NonFinitePoint { index: usize },
}

#[derive(Debug)]
struct Grid {
    origin_x: f64,
    origin_y: f64,
    width: usize,
    height: usize,
    minimum_surface: Vec<f64>,
}

/// Classifies points with a deterministic simple morphological filter (SMRF).
///
/// Work is single-threaded and every traversal and tie break follows index order, so identical
/// inputs and parameters produce byte-identical class arrays.
pub fn classify_ground(
    points: &[Point3],
    params: &SmrfParams,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<PointClass>, GroundClassificationError> {
    validate_params(params)?;
    let total = u64::try_from(points.len()).unwrap_or(u64::MAX);
    progress(0, total);
    check_cancelled(cancellation)?;
    if points.is_empty() {
        return Ok(Vec::new());
    }

    let mut grid = build_minimum_grid(points, params, cancellation, &mut progress)?;
    // Windows larger than the grid extent produce the same opening and cannot remove new cells.
    let max_radius = window_radius(params)?.min(grid.width.max(grid.height));
    let filled = inpaint_nearest(
        &grid.minimum_surface,
        grid.width,
        grid.height,
        max_radius,
        cancellation,
    )?;
    let mut removed = vec![false; filled.len()];
    for radius in 1..=max_radius {
        check_cancelled(cancellation)?;
        let opened = morphological_opening(&filled, grid.width, grid.height, radius, cancellation)?;
        let window_size_m = radius as f64 * params.cell_size_m;
        let threshold = params.initial_distance_m + params.slope * window_size_m;
        for index in 0..filled.len() {
            if index.is_multiple_of(CLASSIFICATION_CHUNK_POINTS) {
                check_cancelled(cancellation)?;
            }
            if filled[index].is_finite()
                && opened[index].is_finite()
                && filled[index] - opened[index] > threshold
            {
                removed[index] = true;
            }
        }
    }

    for (index, elevation) in grid.minimum_surface.iter_mut().enumerate() {
        if removed[index] {
            *elevation = f64::NAN;
        }
    }
    let provisional = inpaint_nearest(
        &grid.minimum_surface,
        grid.width,
        grid.height,
        max_radius,
        cancellation,
    )?;
    let point_threshold = params.initial_distance_m + params.slope * params.cell_size_m;
    let mut classes = Vec::with_capacity(points.len());
    let halfway = total / 2;
    for (index, point) in points.iter().enumerate() {
        if index.is_multiple_of(CLASSIFICATION_CHUNK_POINTS) {
            check_cancelled(cancellation)?;
            let completed = halfway.saturating_add(
                u64::try_from(index)
                    .unwrap_or(u64::MAX)
                    .saturating_mul(total.saturating_sub(halfway))
                    / total.max(1),
            );
            progress(completed.min(total), total);
        }
        let surface = interpolated_surface(point, &grid, &provisional, params.cell_size_m);
        let column = coordinate_index(point.x, grid.origin_x, params.cell_size_m, grid.width);
        let row = coordinate_index(point.y, grid.origin_y, params.cell_size_m, grid.height);
        classes.push(
            if !removed[row * grid.width + column]
                && surface.is_some_and(|value| point.z - value <= point_threshold)
            {
                PointClass::Ground
            } else {
                PointClass::Unclassified
            },
        );
    }
    check_cancelled(cancellation)?;
    progress(total, total);
    Ok(classes)
}

fn validate_params(params: &SmrfParams) -> Result<(), GroundClassificationError> {
    if !params.cell_size_m.is_finite() || params.cell_size_m <= 0.0 {
        return Err(GroundClassificationError::InvalidParameters(
            "cell size must be positive and finite",
        ));
    }
    if !params.slope.is_finite() || !(0.0..=1.0).contains(&params.slope) || params.slope == 0.0 {
        return Err(GroundClassificationError::InvalidParameters(
            "slope must be finite and in (0, 1]",
        ));
    }
    if !params.max_window_m.is_finite() || params.max_window_m < params.cell_size_m {
        return Err(GroundClassificationError::InvalidParameters(
            "maximum window must be finite and at least one cell",
        ));
    }
    if !params.initial_distance_m.is_finite() || params.initial_distance_m < 0.0 {
        return Err(GroundClassificationError::InvalidParameters(
            "initial distance must be non-negative and finite",
        ));
    }
    Ok(())
}

fn build_minimum_grid(
    points: &[Point3],
    params: &SmrfParams,
    cancellation: &CancellationToken,
    progress: &mut impl FnMut(u64, u64),
) -> Result<Grid, GroundClassificationError> {
    let mut minimum = [f64::INFINITY; 2];
    let mut maximum = [f64::NEG_INFINITY; 2];
    for (index, point) in points.iter().enumerate() {
        if index.is_multiple_of(CLASSIFICATION_CHUNK_POINTS) {
            check_cancelled(cancellation)?;
        }
        if !point.x.is_finite() || !point.y.is_finite() || !point.z.is_finite() {
            return Err(GroundClassificationError::NonFinitePoint { index });
        }
        minimum[0] = minimum[0].min(point.x);
        minimum[1] = minimum[1].min(point.y);
        maximum[0] = maximum[0].max(point.x);
        maximum[1] = maximum[1].max(point.y);
    }
    let width = grid_dimension(minimum[0], maximum[0], params.cell_size_m)?;
    let height = grid_dimension(minimum[1], maximum[1], params.cell_size_m)?;
    let cells = u64::try_from(width)
        .ok()
        .and_then(|width| {
            u64::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(GroundClassificationError::GridDimensionsOverflow)?;
    if cells > MAX_GRID_CELLS {
        return Err(GroundClassificationError::GridTooLarge {
            cells,
            maximum: MAX_GRID_CELLS,
        });
    }
    let cell_count =
        usize::try_from(cells).map_err(|_| GroundClassificationError::GridDimensionsOverflow)?;
    let mut minimum_surface = vec![f64::NAN; cell_count];
    let total = u64::try_from(points.len()).unwrap_or(u64::MAX);
    for (index, point) in points.iter().enumerate() {
        if index.is_multiple_of(CLASSIFICATION_CHUNK_POINTS) {
            check_cancelled(cancellation)?;
            progress(u64::try_from(index).unwrap_or(u64::MAX) / 2, total);
        }
        let column = coordinate_index(point.x, minimum[0], params.cell_size_m, width);
        let row = coordinate_index(point.y, minimum[1], params.cell_size_m, height);
        let cell = row * width + column;
        minimum_surface[cell] = if minimum_surface[cell].is_nan() {
            point.z
        } else {
            minimum_surface[cell].min(point.z)
        };
    }
    Ok(Grid {
        origin_x: minimum[0],
        origin_y: minimum[1],
        width,
        height,
        minimum_surface,
    })
}

fn grid_dimension(
    minimum: f64,
    maximum: f64,
    cell_size: f64,
) -> Result<usize, GroundClassificationError> {
    let cells = ((maximum - minimum) / cell_size).floor() + 1.0;
    if !cells.is_finite() || cells < 1.0 || cells > usize::MAX as f64 {
        return Err(GroundClassificationError::GridDimensionsOverflow);
    }
    Ok(cells as usize)
}

fn coordinate_index(value: f64, origin: f64, cell_size: f64, limit: usize) -> usize {
    // Bounds were derived from the same finite points, so clamping only absorbs quotient rounding.
    (((value - origin) / cell_size).floor() as usize).min(limit - 1)
}

fn window_radius(params: &SmrfParams) -> Result<usize, GroundClassificationError> {
    let radius = (params.max_window_m / params.cell_size_m).ceil();
    if !radius.is_finite() || radius < 1.0 || radius > usize::MAX as f64 {
        return Err(GroundClassificationError::GridDimensionsOverflow);
    }
    Ok(radius as usize)
}

fn inpaint_nearest(
    surface: &[f64],
    width: usize,
    height: usize,
    maximum_radius: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<f64>, GroundClassificationError> {
    let mut output = surface.to_vec();
    let mut distance_squared = vec![u64::MAX; surface.len()];
    let mut source = vec![u32::MAX; surface.len()];
    let mut queue = VecDeque::new();
    for (index, value) in surface.iter().enumerate() {
        if value.is_finite() {
            distance_squared[index] = 0;
            source[index] = u32::try_from(index).unwrap_or(u32::MAX);
            queue.push_back(index);
        }
    }
    let maximum_distance_squared = u64::try_from(maximum_radius)
        .unwrap_or(u64::MAX)
        .saturating_pow(2);
    let neighbours = [
        (-1_isize, -1_isize),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    ];
    let mut visited = 0_usize;
    while let Some(index) = queue.pop_front() {
        if visited.is_multiple_of(CLASSIFICATION_CHUNK_POINTS) {
            check_cancelled(cancellation)?;
        }
        visited += 1;
        let x = index % width;
        let y = index / width;
        for (dx, dy) in neighbours {
            let Some(nx) = x.checked_add_signed(dx).filter(|value| *value < width) else {
                continue;
            };
            let Some(ny) = y.checked_add_signed(dy).filter(|value| *value < height) else {
                continue;
            };
            let neighbour = ny * width + nx;
            let candidate_source = source[index];
            let source_index = usize::try_from(candidate_source).unwrap_or(0);
            let source_x = source_index % width;
            let source_y = source_index / width;
            let dx = u64::try_from(nx.abs_diff(source_x)).unwrap_or(u64::MAX);
            let dy = u64::try_from(ny.abs_diff(source_y)).unwrap_or(u64::MAX);
            let candidate_distance_squared =
                dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
            if candidate_distance_squared > maximum_distance_squared {
                continue;
            }
            if candidate_distance_squared < distance_squared[neighbour]
                || (candidate_distance_squared == distance_squared[neighbour]
                    && candidate_source < source[neighbour])
            {
                distance_squared[neighbour] = candidate_distance_squared;
                source[neighbour] = candidate_source;
                output[neighbour] = surface[usize::try_from(candidate_source).unwrap_or(0)];
                queue.push_back(neighbour);
            }
        }
    }
    Ok(output)
}

fn morphological_opening(
    surface: &[f64],
    width: usize,
    height: usize,
    radius: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<f64>, GroundClassificationError> {
    let eroded = rectangular_extreme(surface, width, height, radius, true, cancellation)?;
    rectangular_extreme(&eroded, width, height, radius, false, cancellation)
}

fn rectangular_extreme(
    input: &[f64],
    width: usize,
    height: usize,
    radius: usize,
    minimum: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<f64>, GroundClassificationError> {
    let mut horizontal = vec![f64::NAN; input.len()];
    for row in 0..height {
        if row.is_multiple_of(GRID_CANCELLATION_ROWS) {
            check_cancelled(cancellation)?;
        }
        let offset = row * width;
        sliding_extreme(
            &input[offset..offset + width],
            &mut horizontal[offset..offset + width],
            radius,
            minimum,
        );
    }
    let mut output = vec![f64::NAN; input.len()];
    let mut column = vec![f64::NAN; height];
    let mut filtered = vec![f64::NAN; height];
    for x in 0..width {
        if x.is_multiple_of(GRID_CANCELLATION_ROWS) {
            check_cancelled(cancellation)?;
        }
        for y in 0..height {
            column[y] = horizontal[y * width + x];
        }
        sliding_extreme(&column, &mut filtered, radius, minimum);
        for y in 0..height {
            output[y * width + x] = filtered[y];
        }
    }
    Ok(output)
}

fn sliding_extreme(input: &[f64], output: &mut [f64], radius: usize, minimum: bool) {
    let mut deque = VecDeque::<usize>::new();
    let mut next = 0_usize;
    for center in 0..input.len() {
        let end = center.saturating_add(radius).min(input.len() - 1);
        while next <= end {
            if input[next].is_finite() {
                while let Some(&back) = deque.back() {
                    let ordered = if minimum {
                        input[next] < input[back]
                    } else {
                        input[next] > input[back]
                    };
                    if !ordered {
                        break;
                    }
                    deque.pop_back();
                }
                deque.push_back(next);
            }
            next += 1;
        }
        let start = center.saturating_sub(radius);
        while deque.front().is_some_and(|index| *index < start) {
            deque.pop_front();
        }
        output[center] = deque.front().map_or(f64::NAN, |index| input[*index]);
    }
}

fn interpolated_surface(
    point: &Point3,
    grid: &Grid,
    surface: &[f64],
    cell_size: f64,
) -> Option<f64> {
    let gx = ((point.x - grid.origin_x) / cell_size).clamp(0.0, (grid.width - 1) as f64);
    let gy = ((point.y - grid.origin_y) / cell_size).clamp(0.0, (grid.height - 1) as f64);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = x0.saturating_add(1).min(grid.width - 1);
    let y1 = y0.saturating_add(1).min(grid.height - 1);
    let tx = gx - x0 as f64;
    let ty = gy - y0 as f64;
    let samples = [
        (surface[y0 * grid.width + x0], (1.0 - tx) * (1.0 - ty)),
        (surface[y0 * grid.width + x1], tx * (1.0 - ty)),
        (surface[y1 * grid.width + x0], (1.0 - tx) * ty),
        (surface[y1 * grid.width + x1], tx * ty),
    ];
    let mut weighted = 0.0;
    let mut weight = 0.0;
    for (value, sample_weight) in samples {
        if value.is_finite() && sample_weight > 0.0 {
            weighted += value * sample_weight;
            weight += sample_weight;
        }
    }
    (weight > 0.0).then_some(weighted / weight)
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), GroundClassificationError> {
    if cancellation.is_cancel_requested() {
        Err(GroundClassificationError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[derive(Clone, Copy)]
    struct LabelledPoint {
        point: Point3,
        ground: bool,
        roof: bool,
    }

    fn gaussian_pair(state: &mut u64) -> (f64, f64) {
        let mut uniform = || {
            *state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            ((*state >> 11) as f64 + 1.0) / ((1_u64 << 53) as f64 + 1.0)
        };
        let u1 = uniform();
        let u2 = uniform();
        let radius = (-2.0 * u1.ln()).sqrt();
        let angle = std::f64::consts::TAU * u2;
        (radius * angle.cos(), radius * angle.sin())
    }

    fn synthetic_scene() -> Vec<LabelledPoint> {
        let boxes = [
            (8.0, 8.0, 2.0, 3.0),
            (24.0, 12.0, 6.0, 6.0),
            (45.0, 20.0, 12.0, 10.0),
        ];
        let mut points = Vec::new();
        let mut state = 7_u64;
        let mut spare = None;
        for y in 0..=60 {
            for x in 0..=70 {
                let xf = f64::from(x);
                let yf = f64::from(y);
                let under_box = boxes.iter().any(|(cx, cy, size, _)| {
                    (xf - cx).abs() <= size / 2.0 && (yf - cy).abs() <= size / 2.0
                });
                if under_box {
                    continue;
                }
                let noise = spare.take().unwrap_or_else(|| {
                    let (first, second) = gaussian_pair(&mut state);
                    spare = Some(second);
                    first
                });
                points.push(LabelledPoint {
                    point: Point3 {
                        x: xf,
                        y: yf,
                        z: 100.0 + 0.15 * xf + noise * 0.03,
                    },
                    ground: true,
                    roof: false,
                });
            }
        }
        for (cx, cy, size, height) in boxes {
            let half_steps = (size * 2.0) as i32;
            for yi in -half_steps..=half_steps {
                for xi in -half_steps..=half_steps {
                    let x = cx + f64::from(xi) * 0.25;
                    let y = cy + f64::from(yi) * 0.25;
                    points.push(LabelledPoint {
                        point: Point3 {
                            x,
                            y,
                            z: 100.0 + 0.15 * x + height,
                        },
                        ground: false,
                        roof: true,
                    });
                }
            }
        }
        points
    }

    #[test]
    fn synthetic_plane_ramp_and_boxes_meet_quality_bounds() {
        let scene = synthetic_scene();
        let points = scene.iter().map(|point| point.point).collect::<Vec<_>>();
        let classes = classify_ground(
            &points,
            &SmrfParams::default(),
            &CancellationToken::new(),
            |_, _| {},
        )
        .expect("classification");
        let true_ground = scene.iter().filter(|point| point.ground).count();
        let classified_ground = classes
            .iter()
            .filter(|class| **class == PointClass::Ground)
            .count();
        let correctly_ground = scene
            .iter()
            .zip(&classes)
            .filter(|(point, class)| point.ground && **class == PointClass::Ground)
            .count();
        let recall = correctly_ground as f64 / true_ground as f64;
        let precision = correctly_ground as f64 / classified_ground as f64;
        eprintln!("synthetic SMRF recall={recall:.6} precision={precision:.6}");
        assert!(recall >= 0.98, "ground recall {recall}");
        assert!(precision >= 0.98, "ground precision {precision}");
        assert!(scene
            .iter()
            .zip(classes)
            .filter(|(point, _)| point.roof)
            .all(|(_, class)| class == PointClass::Unclassified));
    }

    #[test]
    fn two_runs_have_identical_classification_sha256() {
        let points = synthetic_scene()
            .into_iter()
            .map(|point| point.point)
            .collect::<Vec<_>>();
        let run = || {
            classify_ground(
                &points,
                &SmrfParams::default(),
                &CancellationToken::new(),
                |_, _| {},
            )
            .expect("classification")
            .into_iter()
            .map(u8::from)
            .collect::<Vec<_>>()
        };
        let first = run();
        let second = run();
        assert_eq!(first, second);
        let first_hash = Sha256::digest(&first);
        let second_hash = Sha256::digest(&second);
        eprintln!("classification SHA-256 {first_hash:x}");
        assert_eq!(first_hash, second_hash);
    }

    #[test]
    fn cancellation_returns_within_one_point_chunk() {
        let points = (0..CLASSIFICATION_CHUNK_POINTS * 3)
            .map(|index| Point3 {
                x: (index % 200) as f64,
                y: (index / 200) as f64,
                z: 0.0,
            })
            .collect::<Vec<_>>();
        let cancellation = CancellationToken::new();
        let signal = cancellation.clone();
        let mut requested_at = None;
        let mut last_progress = 0;
        let error = classify_ground(
            &points,
            &SmrfParams::default(),
            &cancellation,
            |completed, _| {
                last_progress = completed;
                if completed > 0 && requested_at.is_none() {
                    requested_at = Some(completed);
                    signal.request_cancel();
                }
            },
        )
        .expect_err("cancelled");
        assert_eq!(error, GroundClassificationError::Cancelled);
        assert!(last_progress - requested_at.unwrap_or(0) <= CLASSIFICATION_CHUNK_POINTS as u64);
    }

    #[test]
    fn oversized_grid_is_rejected_with_cell_size_guidance() {
        let points = [
            Point3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            Point3 {
                x: 20_000.0,
                y: 20_000.0,
                z: 0.0,
            },
        ];
        let error = classify_ground(
            &points,
            &SmrfParams::default(),
            &CancellationToken::new(),
            |_, _| {},
        )
        .expect_err("grid guard");
        assert!(matches!(
            error,
            GroundClassificationError::GridTooLarge { .. }
        ));
        assert!(error
            .to_string()
            .contains("raise the ground-classification cell size"));
    }
}
