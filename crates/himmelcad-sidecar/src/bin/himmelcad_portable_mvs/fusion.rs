//! Deterministic bounded-memory cross-view fusion for the portable MVS worker.

use std::{
    cmp::Ordering,
    collections::BinaryHeap,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

use himmelcad_core::hash::ObjectHash;
use serde::{Deserialize, Serialize};

use super::{atomic_json, check_cancel, WorkerError};

pub(super) const DEFAULT_BUFFERED_SAMPLES: usize = 250_000;
const RECORD_BYTES: u64 = 87;
const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
const NORMAL_DOT_THRESHOLD: f64 = 0.5;
const POSITION_TOLERANCE_PIXELS: f64 = 1.5;
const MAX_ACTIVE_CLUSTERS_PER_VOXEL: usize = 64;
const MAX_OPEN_SORT_RUNS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct FootprintStatistics {
    pub minimum: f64,
    pub median: f64,
    pub maximum: f64,
}

impl FootprintStatistics {
    pub(super) fn from_values(mut values: Vec<f64>) -> Result<Self, WorkerError> {
        values.retain(|value| value.is_finite() && *value > 0.0);
        if values.is_empty() {
            return Err(WorkerError::InvalidInput(
                "dense fusion has no valid depth-pixel footprint".into(),
            ));
        }
        values.sort_by(f64::total_cmp);
        Ok(Self {
            minimum: values[0],
            median: values[values.len() / 2],
            maximum: values[values.len() - 1],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct FusionSample {
    pub view_index: u32,
    pub position: [f64; 3],
    pub color: [u8; 3],
    pub confidence: f32,
    pub normal: [f32; 3],
    pub pixel_footprint_meters: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct VoxelKey([i64; 3]);

#[derive(Debug, Clone, Copy)]
struct SortedSample {
    key: VoxelKey,
    ordinal: u64,
    sample: FusionSample,
}

impl SortedSample {
    fn new(sample: FusionSample, voxel_size: f64, ordinal: u64) -> Result<Self, WorkerError> {
        if sample
            .position
            .iter()
            .any(|coordinate| !coordinate.is_finite())
            || !sample.pixel_footprint_meters.is_finite()
            || sample.pixel_footprint_meters <= 0.0
            || !sample.confidence.is_finite()
        {
            return Err(WorkerError::InvalidInput(
                "dense fusion received a non-finite sample".into(),
            ));
        }
        let mut key = [0_i64; 3];
        for (target, coordinate) in key.iter_mut().zip(sample.position) {
            let quantized = (coordinate / voxel_size).floor();
            if quantized < i64::MIN as f64 || quantized > i64::MAX as f64 {
                return Err(WorkerError::InvalidInput(
                    "dense fusion voxel address overflow".into(),
                ));
            }
            *target = quantized as i64;
        }
        Ok(Self {
            key: VoxelKey(key),
            ordinal,
            sample,
        })
    }

    fn write_to(&self, writer: &mut impl Write) -> Result<(), WorkerError> {
        for value in self.key.0 {
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.write_all(&self.ordinal.to_le_bytes())?;
        writer.write_all(&self.sample.view_index.to_le_bytes())?;
        for value in self.sample.position {
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.write_all(&self.sample.color)?;
        writer.write_all(&self.sample.confidence.to_le_bytes())?;
        for value in self.sample.normal {
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.write_all(&self.sample.pixel_footprint_meters.to_le_bytes())?;
        Ok(())
    }

    fn read_from(reader: &mut impl Read) -> Result<Option<Self>, WorkerError> {
        let mut first = [0_u8; 8];
        match reader.read_exact(&mut first) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let mut key = [0_i64; 3];
        key[0] = i64::from_le_bytes(first);
        for target in &mut key[1..] {
            *target = read_i64(reader)?;
        }
        let ordinal = read_u64(reader)?;
        let view_index = read_u32(reader)?;
        let mut position = [0_f64; 3];
        for target in &mut position {
            *target = read_f64(reader)?;
        }
        let mut color = [0_u8; 3];
        reader.read_exact(&mut color)?;
        let confidence = read_f32(reader)?;
        let mut normal = [0_f32; 3];
        for target in &mut normal {
            *target = read_f32(reader)?;
        }
        let pixel_footprint_meters = read_f64(reader)?;
        Ok(Some(Self {
            key: VoxelKey(key),
            ordinal,
            sample: FusionSample {
                view_index,
                position,
                color,
                confidence,
                normal,
                pixel_footprint_meters,
            },
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FusionCheckpoint {
    schema_version: u32,
    job_id: String,
    scene_manifest_sha256: ObjectHash,
    settings_sha256: ObjectHash,
    voxel_size_meters: f64,
    completed_image_ids: Vec<String>,
    committed_run_count: u32,
    raw_sample_count: u64,
}

pub(super) struct FusionSpool {
    root: PathBuf,
    checkpoint_path: PathBuf,
    checkpoint: FusionCheckpoint,
    buffer: Vec<SortedSample>,
    buffer_limit: usize,
    next_ordinal: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct FusionResult {
    pub raw_sample_count: u64,
    pub fused_sample_count: u64,
    pub external_sort_runs: u32,
    pub maximum_buffered_samples: u32,
}

impl FusionSpool {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn open(
        root: &Path,
        job_id: &str,
        scene_manifest_sha256: &ObjectHash,
        settings_sha256: &ObjectHash,
        voxel_size_meters: f64,
        ordered_image_ids: &[String],
        buffer_limit: usize,
    ) -> Result<Self, WorkerError> {
        if !voxel_size_meters.is_finite() || voxel_size_meters <= 0.0 || buffer_limit == 0 {
            return Err(WorkerError::InvalidInput(
                "dense fusion sampling configuration is invalid".into(),
            ));
        }
        let checkpoint_path = root.join("checkpoint.json");
        let checkpoint = if checkpoint_path.is_file() {
            let checkpoint: FusionCheckpoint =
                serde_json::from_slice(&fs::read(&checkpoint_path)?)?;
            if checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION
                || checkpoint.job_id != job_id
                || &checkpoint.scene_manifest_sha256 != scene_manifest_sha256
                || &checkpoint.settings_sha256 != settings_sha256
                || checkpoint.voxel_size_meters.to_bits() != voxel_size_meters.to_bits()
                || checkpoint.completed_image_ids.len() > ordered_image_ids.len()
                || checkpoint.completed_image_ids
                    != ordered_image_ids[..checkpoint.completed_image_ids.len()]
            {
                return Err(WorkerError::InvalidInput(
                    "dense fusion checkpoint is incompatible".into(),
                ));
            }
            checkpoint
        } else {
            if root.exists() {
                fs::remove_dir_all(root)?;
            }
            fs::create_dir_all(root)?;
            FusionCheckpoint {
                schema_version: CHECKPOINT_SCHEMA_VERSION,
                job_id: job_id.into(),
                scene_manifest_sha256: scene_manifest_sha256.clone(),
                settings_sha256: settings_sha256.clone(),
                voxel_size_meters,
                completed_image_ids: Vec::new(),
                committed_run_count: 0,
                raw_sample_count: 0,
            }
        };
        fs::create_dir_all(root)?;
        for index in 0..checkpoint.committed_run_count {
            let path = run_path(root, index);
            let bytes = path
                .metadata()
                .map_err(|_| {
                    WorkerError::InvalidInput("dense fusion checkpoint run is missing".into())
                })?
                .len();
            if bytes == 0 || bytes % RECORD_BYTES != 0 {
                return Err(WorkerError::InvalidInput(
                    "dense fusion checkpoint run is truncated".into(),
                ));
            }
        }
        for entry in fs::read_dir(root)? {
            let path = entry?.path();
            let Some(index) = run_index(&path) else {
                continue;
            };
            if index >= checkpoint.committed_run_count {
                fs::remove_file(path)?;
            }
        }
        let next_ordinal = checkpoint.raw_sample_count;
        Ok(Self {
            root: root.to_owned(),
            checkpoint_path,
            checkpoint,
            buffer: Vec::with_capacity(buffer_limit.min(65_536)),
            buffer_limit,
            next_ordinal,
        })
    }

    pub(super) fn completed_image_count(&self) -> usize {
        self.checkpoint.completed_image_ids.len()
    }

    pub(super) fn push(
        &mut self,
        sample: FusionSample,
        cancellation: &AtomicBool,
    ) -> Result<(), WorkerError> {
        check_cancel(cancellation)?;
        self.buffer.push(SortedSample::new(
            sample,
            self.checkpoint.voxel_size_meters,
            self.next_ordinal,
        )?);
        self.next_ordinal = self.next_ordinal.checked_add(1).ok_or_else(|| {
            WorkerError::InvalidInput("dense fusion sample counter overflow".into())
        })?;
        if self.buffer.len() >= self.buffer_limit {
            self.flush_run(cancellation)?;
        }
        Ok(())
    }

    pub(super) fn finish_image(
        &mut self,
        image_id: &str,
        cancellation: &AtomicBool,
    ) -> Result<(), WorkerError> {
        check_cancel(cancellation)?;
        self.flush_run(cancellation)?;
        self.checkpoint.completed_image_ids.push(image_id.into());
        self.checkpoint.raw_sample_count = self.next_ordinal;
        atomic_json(&self.checkpoint_path, &self.checkpoint)
    }

    pub(super) fn finish(
        mut self,
        payload_path: &Path,
        calculate_colors: bool,
        retain_confidence: bool,
        cancellation: &AtomicBool,
    ) -> Result<FusionResult, WorkerError> {
        self.flush_run(cancellation)?;
        if self.checkpoint.committed_run_count == 0 {
            return Err(WorkerError::InvalidInput(
                "geometric consistency rejected every dense point".into(),
            ));
        }
        let fused_sample_count = merge_runs(
            &self.root,
            self.checkpoint.committed_run_count,
            payload_path,
            calculate_colors,
            retain_confidence,
            cancellation,
        )?;
        Ok(FusionResult {
            raw_sample_count: self.next_ordinal,
            fused_sample_count,
            external_sort_runs: self.checkpoint.committed_run_count,
            maximum_buffered_samples: u32::try_from(self.buffer_limit).unwrap_or(u32::MAX),
        })
    }

    fn flush_run(&mut self, cancellation: &AtomicBool) -> Result<(), WorkerError> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        check_cancel(cancellation)?;
        self.buffer.sort_by(|left, right| {
            left.key
                .cmp(&right.key)
                .then_with(|| left.ordinal.cmp(&right.ordinal))
        });
        let path = run_path(&self.root, self.checkpoint.committed_run_count);
        let temporary = path.with_extension("bin.pending");
        let mut writer = BufWriter::new(File::create(&temporary)?);
        for (index, sample) in self.buffer.iter().enumerate() {
            if index % 16_384 == 0 {
                check_cancel(cancellation)?;
            }
            sample.write_to(&mut writer)?;
        }
        writer.flush()?;
        let file = writer.into_inner().map_err(|error| error.into_error())?;
        file.sync_all()?;
        drop(file);
        fs::rename(temporary, path)?;
        self.buffer.clear();
        self.checkpoint.committed_run_count = self
            .checkpoint
            .committed_run_count
            .checked_add(1)
            .ok_or_else(|| WorkerError::InvalidInput("too many dense fusion runs".into()))?;
        Ok(())
    }
}

fn merge_runs(
    root: &Path,
    run_count: u32,
    payload_path: &Path,
    calculate_colors: bool,
    retain_confidence: bool,
    cancellation: &AtomicBool,
) -> Result<u64, WorkerError> {
    let initial_runs = (0..run_count)
        .map(|index| run_path(root, index))
        .collect::<Vec<_>>();
    let merge_runs = compact_runs(root, initial_runs, cancellation)?;
    let mut readers = merge_runs
        .iter()
        .map(|path| File::open(path).map(BufReader::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = BinaryHeap::new();
    for (run_index, reader) in readers.iter_mut().enumerate() {
        if let Some(sample) = SortedSample::read_from(reader)? {
            heap.push(HeapItem { run_index, sample });
        }
    }
    let temporary = payload_path.with_extension("vertices.pending");
    let mut output = BufWriter::new(File::create(&temporary)?);
    let mut active_key = None;
    let mut active_clusters = Vec::with_capacity(MAX_ACTIVE_CLUSTERS_PER_VOXEL);
    let mut fused_count = 0_u64;
    let mut visited = 0_u64;
    while let Some(item) = heap.pop() {
        if visited % 16_384 == 0 {
            check_cancel(cancellation)?;
        }
        visited += 1;
        if active_key.is_some_and(|key| key != item.sample.key) {
            fused_count += write_active_clusters(
                &mut active_clusters,
                &mut output,
                calculate_colors,
                retain_confidence,
            )?;
        }
        active_key = Some(item.sample.key);
        fused_count += add_sample_to_clusters(
            item.sample.sample,
            &mut active_clusters,
            &mut output,
            calculate_colors,
            retain_confidence,
        )?;
        if let Some(next) = SortedSample::read_from(&mut readers[item.run_index])? {
            heap.push(HeapItem {
                run_index: item.run_index,
                sample: next,
            });
        }
    }
    fused_count += write_active_clusters(
        &mut active_clusters,
        &mut output,
        calculate_colors,
        retain_confidence,
    )?;
    output.flush()?;
    let file = output.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    drop(file);
    if payload_path.exists() {
        fs::remove_file(payload_path)?;
    }
    fs::rename(temporary, payload_path)?;
    Ok(fused_count)
}

fn compact_runs(
    root: &Path,
    mut paths: Vec<PathBuf>,
    cancellation: &AtomicBool,
) -> Result<Vec<PathBuf>, WorkerError> {
    let mut pass = 0_u32;
    while paths.len() > MAX_OPEN_SORT_RUNS {
        let mut next = Vec::with_capacity(paths.len().div_ceil(MAX_OPEN_SORT_RUNS));
        for (group_index, group) in paths.chunks(MAX_OPEN_SORT_RUNS).enumerate() {
            check_cancel(cancellation)?;
            let path = root.join(format!("merge-{pass:04}-{group_index:08}.bin"));
            merge_sample_runs(group, &path, cancellation)?;
            next.push(path);
        }
        paths = next;
        pass = pass
            .checked_add(1)
            .ok_or_else(|| WorkerError::InvalidInput("too many dense merge passes".into()))?;
    }
    Ok(paths)
}

fn merge_sample_runs(
    paths: &[PathBuf],
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<(), WorkerError> {
    let mut readers = paths
        .iter()
        .map(|path| File::open(path).map(BufReader::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = BinaryHeap::new();
    for (run_index, reader) in readers.iter_mut().enumerate() {
        if let Some(sample) = SortedSample::read_from(reader)? {
            heap.push(HeapItem { run_index, sample });
        }
    }
    let temporary = output_path.with_extension("bin.pending");
    let mut output = BufWriter::new(File::create(&temporary)?);
    let mut visited = 0_u64;
    while let Some(item) = heap.pop() {
        if visited % 16_384 == 0 {
            check_cancel(cancellation)?;
        }
        visited += 1;
        item.sample.write_to(&mut output)?;
        if let Some(next) = SortedSample::read_from(&mut readers[item.run_index])? {
            heap.push(HeapItem {
                run_index: item.run_index,
                sample: next,
            });
        }
    }
    output.flush()?;
    let file = output.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    drop(file);
    if output_path.exists() {
        fs::remove_file(output_path)?;
    }
    fs::rename(temporary, output_path)?;
    Ok(())
}

#[derive(Debug)]
struct HeapItem {
    run_index: usize,
    sample: SortedSample,
}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.sample.key == other.sample.key
            && self.sample.ordinal == other.sample.ordinal
            && self.run_index == other.run_index
    }
}

impl Eq for HeapItem {}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .sample
            .key
            .cmp(&self.sample.key)
            .then_with(|| other.sample.ordinal.cmp(&self.sample.ordinal))
            .then_with(|| other.run_index.cmp(&self.run_index))
    }
}

#[derive(Debug, Clone)]
struct Aggregate {
    view_indices: Vec<u32>,
    weight: f64,
    position_sum: [f64; 3],
    color_sum: [f64; 3],
    confidence_sum: f64,
    normal_sum: [f64; 3],
    footprint_sum: f64,
}

impl Aggregate {
    fn new(sample: FusionSample) -> Self {
        let weight = sample_weight(sample.confidence);
        Self {
            view_indices: vec![sample.view_index],
            weight,
            position_sum: sample.position.map(|value| value * weight),
            color_sum: sample.color.map(|value| f64::from(value) * weight),
            confidence_sum: f64::from(sample.confidence.max(0.0)) * weight,
            normal_sum: sample.normal.map(|value| f64::from(value) * weight),
            footprint_sum: sample.pixel_footprint_meters * weight,
        }
    }

    fn centroid(&self) -> [f64; 3] {
        self.position_sum.map(|value| value / self.weight)
    }

    fn footprint(&self) -> f64 {
        self.footprint_sum / self.weight
    }

    fn normal(&self) -> [f64; 3] {
        normalized(self.normal_sum).unwrap_or([0.0, 0.0, 1.0])
    }

    fn accepts(&self, sample: FusionSample) -> bool {
        if self.view_indices.contains(&sample.view_index) {
            return false;
        }
        let centroid = self.centroid();
        let distance_squared = centroid
            .iter()
            .zip(sample.position)
            .map(|(left, right)| (left - right).powi(2))
            .sum::<f64>();
        let tolerance =
            POSITION_TOLERANCE_PIXELS * self.footprint().max(sample.pixel_footprint_meters);
        let sample_normal = normalized(sample.normal.map(f64::from)).unwrap_or([0.0, 0.0, 1.0]);
        distance_squared <= tolerance * tolerance
            && dot(self.normal(), sample_normal) >= NORMAL_DOT_THRESHOLD
    }

    fn add(&mut self, sample: FusionSample) {
        let weight = sample_weight(sample.confidence);
        self.view_indices.push(sample.view_index);
        self.weight += weight;
        for axis in 0..3 {
            self.position_sum[axis] += sample.position[axis] * weight;
            self.color_sum[axis] += f64::from(sample.color[axis]) * weight;
            self.normal_sum[axis] += f64::from(sample.normal[axis]) * weight;
        }
        self.confidence_sum += f64::from(sample.confidence.max(0.0)) * weight;
        self.footprint_sum += sample.pixel_footprint_meters * weight;
    }

    fn write(
        &self,
        output: &mut impl Write,
        calculate_colors: bool,
        retain_confidence: bool,
    ) -> Result<(), WorkerError> {
        // World coordinates must stay float64. Absolute projected CRS values
        // (e.g. GK4 ~4e6 m) lose ~0.5 m of XY precision when quantized to f32,
        // which shows up as a regular grid and multi-Z stacks in dense products.
        for value in self.centroid() {
            output.write_all(&value.to_le_bytes())?;
        }
        if calculate_colors {
            for value in self.color_sum {
                output.write_all(&[(value / self.weight).round().clamp(0.0, 255.0) as u8])?;
            }
        }
        if retain_confidence {
            output.write_all(&((self.confidence_sum / self.weight) as f32).to_le_bytes())?;
        }
        for value in self.normal() {
            output.write_all(&(value as f32).to_le_bytes())?;
        }
        Ok(())
    }
}

fn add_sample_to_clusters(
    sample: FusionSample,
    active: &mut Vec<Aggregate>,
    output: &mut impl Write,
    calculate_colors: bool,
    retain_confidence: bool,
) -> Result<u64, WorkerError> {
    let best = active
        .iter()
        .enumerate()
        .filter(|(_, aggregate)| aggregate.accepts(sample))
        .map(|(index, aggregate)| {
            let center = aggregate.centroid();
            let distance = center
                .iter()
                .zip(sample.position)
                .map(|(left, right)| (left - right).powi(2))
                .sum::<f64>();
            (index, distance)
        })
        .min_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)));
    if let Some((index, _)) = best {
        active[index].add(sample);
        return Ok(0);
    }
    let written = if active.len() == MAX_ACTIVE_CLUSTERS_PER_VOXEL {
        active[0].write(output, calculate_colors, retain_confidence)?;
        active.remove(0);
        1
    } else {
        0
    };
    active.push(Aggregate::new(sample));
    Ok(written)
}

fn write_active_clusters(
    active: &mut Vec<Aggregate>,
    output: &mut impl Write,
    calculate_colors: bool,
    retain_confidence: bool,
) -> Result<u64, WorkerError> {
    let written = active.len() as u64;
    for aggregate in active.drain(..) {
        aggregate.write(output, calculate_colors, retain_confidence)?;
    }
    Ok(written)
}

fn sample_weight(confidence: f32) -> f64 {
    f64::from(confidence.max(0.0)).max(1.0e-6)
}

fn normalized(value: [f64; 3]) -> Option<[f64; 3]> {
    let length = dot(value, value).sqrt();
    (length.is_finite() && length > 1.0e-12).then(|| value.map(|item| item / length))
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn run_path(root: &Path, index: u32) -> PathBuf {
    root.join(format!("run-{index:08}.bin"))
}

fn run_index(path: &Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    name.strip_prefix("run-")?
        .strip_suffix(".bin")?
        .parse()
        .ok()
}

fn read_i64(reader: &mut impl Read) -> Result<i64, WorkerError> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(i64::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64, WorkerError> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, WorkerError> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_f64(reader: &mut impl Read) -> Result<f64, WorkerError> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(f64::from_le_bytes(bytes))
}

fn read_f32(reader: &mut impl Read) -> Result<f32, WorkerError> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(f32::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicBool, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn sample(
        view_index: u32,
        position: [f64; 3],
        color: [u8; 3],
        confidence: f32,
        footprint: f64,
    ) -> FusionSample {
        FusionSample {
            view_index,
            position,
            color,
            confidence,
            normal: [0.0, 0.0, 1.0],
            pixel_footprint_meters: footprint,
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("hcad-fusion-{label}-{nonce}"));
        fs::create_dir_all(&path).expect("temp root");
        path
    }

    fn run(samples: &[FusionSample], buffer_limit: usize) -> (Vec<u8>, FusionResult) {
        let root = temp_root("run");
        let work = root.join("work");
        let payload = root.join("payload.bin");
        let hash = ObjectHash::of_bytes(b"fixture");
        let images = vec!["image-a".to_owned()];
        let cancellation = AtomicBool::new(false);
        let mut spool = FusionSpool::open(&work, "job", &hash, &hash, 0.1, &images, buffer_limit)
            .expect("spool");
        for value in samples {
            spool.push(*value, &cancellation).expect("push");
        }
        spool.finish_image("image-a", &cancellation).expect("image");
        let result = spool
            .finish(&payload, true, true, &cancellation)
            .expect("finish");
        let bytes = fs::read(&payload).expect("payload");
        fs::remove_dir_all(root).expect("cleanup");
        (bytes, result)
    }

    #[test]
    fn overlapping_views_merge_with_confidence_weighted_attributes() {
        let (bytes, result) = run(
            &[
                sample(0, [0.02, 0.02, 1.0], [255, 0, 0], 1.0, 0.02),
                sample(1, [0.03, 0.02, 1.0], [0, 0, 255], 3.0, 0.02),
            ],
            8,
        );
        assert_eq!(result.raw_sample_count, 2);
        assert_eq!(result.fused_sample_count, 1);
        assert_eq!(f64::from_le_bytes(bytes[0..8].try_into().unwrap()), 0.0275);
        // xyz are float64 (24 bytes), then uchar RGB.
        assert_eq!(&bytes[24..27], &[64, 0, 191]);
    }

    #[test]
    fn neighboring_pixels_from_one_view_are_not_counted_as_cross_view_support() {
        let (_, result) = run(
            &[
                sample(0, [0.02, 0.02, 1.0], [10, 20, 30], 1.0, 0.02),
                sample(0, [0.025, 0.02, 1.0], [10, 20, 30], 1.0, 0.02),
            ],
            8,
        );
        assert_eq!(result.fused_sample_count, 2);
    }

    #[test]
    fn parallax_separated_surfaces_remain_distinct() {
        let (_, result) = run(
            &[
                sample(0, [0.01, 0.01, 1.0], [0, 0, 0], 1.0, 0.01),
                sample(1, [0.08, 0.01, 1.0], [0, 0, 0], 1.0, 0.01),
            ],
            8,
        );
        assert_eq!(result.fused_sample_count, 2);
    }

    #[test]
    fn different_ground_sample_distances_use_the_larger_local_footprint() {
        let (_, result) = run(
            &[
                sample(0, [0.01, 0.01, 1.0], [0, 0, 0], 1.0, 0.01),
                sample(1, [0.035, 0.01, 1.0], [0, 0, 0], 1.0, 0.02),
            ],
            8,
        );
        assert_eq!(result.fused_sample_count, 1);
    }

    #[test]
    fn external_chunk_size_does_not_change_output_bytes() {
        let samples = (0..257)
            .map(|index| {
                let x = f64::from(index % 9) * 0.1 + 0.01;
                let y = f64::from(index / 9) * 0.1 + 0.01;
                sample(index % 4, [x, y, 1.0], [index as u8, 10, 20], 0.8, 0.02)
            })
            .collect::<Vec<_>>();
        let (small, small_result) = run(&samples, 1);
        let (large, large_result) = run(&samples, 1_000);
        assert_eq!(small, large);
        assert_eq!(
            small_result.fused_sample_count,
            large_result.fused_sample_count
        );
        assert!(small_result.external_sort_runs > large_result.external_sort_runs);
    }

    #[test]
    fn cancellation_stops_before_publishing_a_payload() {
        let root = temp_root("cancel");
        let work = root.join("work");
        let payload = root.join("payload.bin");
        let hash = ObjectHash::of_bytes(b"fixture");
        let images = vec!["image-a".to_owned()];
        let cancellation = AtomicBool::new(false);
        let mut spool =
            FusionSpool::open(&work, "job", &hash, &hash, 0.1, &images, 2).expect("spool");
        spool
            .push(
                sample(0, [0.01, 0.01, 1.0], [0, 0, 0], 1.0, 0.01),
                &cancellation,
            )
            .expect("first");
        spool
            .finish_image("image-a", &cancellation)
            .expect("durable image checkpoint");
        cancellation.store(true, Ordering::Release);
        assert!(matches!(
            spool.finish(&payload, true, true, &cancellation),
            Err(WorkerError::Cancelled)
        ));
        assert!(!payload.exists());
        assert!(work.join("checkpoint.json").is_file());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn resume_reuses_only_committed_image_runs() {
        let root = temp_root("resume");
        let work = root.join("work");
        let payload = root.join("payload.bin");
        let hash = ObjectHash::of_bytes(b"fixture");
        let images = vec!["image-a".to_owned(), "image-b".to_owned()];
        let cancellation = AtomicBool::new(false);
        let first = sample(0, [0.01, 0.01, 1.0], [255, 0, 0], 1.0, 0.02);
        let second = sample(1, [0.02, 0.01, 1.0], [0, 0, 255], 1.0, 0.02);

        let mut interrupted =
            FusionSpool::open(&work, "job", &hash, &hash, 0.1, &images, 1).expect("open");
        interrupted.push(first, &cancellation).expect("push a");
        interrupted
            .finish_image("image-a", &cancellation)
            .expect("commit a");
        drop(interrupted);

        let mut resumed =
            FusionSpool::open(&work, "job", &hash, &hash, 0.1, &images, 1).expect("resume");
        assert_eq!(resumed.completed_image_count(), 1);
        resumed.push(second, &cancellation).expect("push b");
        resumed
            .finish_image("image-b", &cancellation)
            .expect("commit b");
        let resumed_result = resumed
            .finish(&payload, true, true, &cancellation)
            .expect("finish");

        let (expected, expected_result) = run(&[first, second], 1);
        assert_eq!(fs::read(&payload).expect("payload"), expected);
        assert_eq!(resumed_result.raw_sample_count, 2);
        assert_eq!(
            resumed_result.fused_sample_count,
            expected_result.fused_sample_count
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
