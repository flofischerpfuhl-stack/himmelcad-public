//! Hardware-derived residency policy, startup calibration and runtime telemetry.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::{
    DeviceCapabilities, DeviceKind, FrameBudget, ResourceBudget, GPU_POINT_VERTEX_STRIDE_BYTES,
};

const MEBIBYTE: u64 = 1_048_576;
const GIBIBYTE: u64 = 1_073_741_824;
const GIBIBYTE_F64: f64 = 1_073_741_824.0;

/// Host inventory unavailable through portable graphics APIs alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInventory {
    /// Physical or safely allocatable GPU memory when the host can report it.
    pub gpu_memory_bytes: Option<u64>,
    /// Physical system memory when the host can report it.
    pub system_memory_bytes: Option<u64>,
    /// Logical CPU thread count available to the application.
    pub logical_cores: u16,
}

/// Bounded startup measurements used instead of adapter-name heuristics.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCalibration {
    /// Sustained upload throughput.
    pub upload_gib_per_second: f32,
    /// Sustained point vertex throughput.
    pub point_millions_per_second: f32,
    /// Sustained textured triangle throughput.
    pub triangle_millions_per_second: f32,
    /// Sustained Gaussian-splat throughput.
    pub splat_millions_per_second: f32,
}

/// One bounded benchmark observation recorded during startup calibration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CalibrationObservation {
    /// Bytes made GPU-visible over the measured wall-clock interval.
    Upload {
        /// Uploaded byte count.
        bytes: u64,
        /// Complete elapsed interval in milliseconds.
        elapsed_ms: f32,
    },
    /// Points rendered over a measured GPU or completion-fenced interval.
    Points {
        /// Rendered point count.
        count: u64,
        /// Complete elapsed interval in milliseconds.
        elapsed_ms: f32,
    },
    /// Textured triangles rendered over a measured GPU or completion-fenced interval.
    Triangles {
        /// Rendered triangle count.
        count: u64,
        /// Complete elapsed interval in milliseconds.
        elapsed_ms: f32,
    },
    /// Gaussian splats rendered over a measured GPU or completion-fenced interval.
    Splats {
        /// Rendered splat count.
        count: u64,
        /// Complete elapsed interval in milliseconds.
        elapsed_ms: f32,
    },
}

/// Robust accumulator for short, non-destructive startup calibration passes.
///
/// The host performs representative offscreen work and records completion-fenced
/// timings here. The median deliberately rejects shader warm-up, browser scheduling
/// and one-off driver stalls without identifying hardware by its marketing name.
#[derive(Debug, Default)]
pub struct DeviceCalibrationAccumulator {
    uploads: Vec<f32>,
    points: Vec<f32>,
    triangles: Vec<f32>,
    splats: Vec<f32>,
}

impl DeviceCalibrationAccumulator {
    /// Maximum retained observations per workload class.
    pub const MAX_SAMPLES_PER_CLASS: usize = 31;
    /// Minimum valid observations required for every workload class.
    pub const MIN_SAMPLES_PER_CLASS: usize = 3;

    /// Creates an empty calibration accumulator.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one valid observation, returning `false` for invalid or excess data.
    pub fn observe(&mut self, observation: CalibrationObservation) -> bool {
        let (samples, throughput) = match observation {
            CalibrationObservation::Upload { bytes, elapsed_ms } => (
                &mut self.uploads,
                throughput(bytes, elapsed_ms, GIBIBYTE_F64),
            ),
            CalibrationObservation::Points { count, elapsed_ms } => {
                (&mut self.points, throughput(count, elapsed_ms, 1_000_000.0))
            }
            CalibrationObservation::Triangles { count, elapsed_ms } => (
                &mut self.triangles,
                throughput(count, elapsed_ms, 1_000_000.0),
            ),
            CalibrationObservation::Splats { count, elapsed_ms } => {
                (&mut self.splats, throughput(count, elapsed_ms, 1_000_000.0))
            }
        };
        let Some(throughput) = throughput else {
            return false;
        };
        if samples.len() >= Self::MAX_SAMPLES_PER_CLASS {
            return false;
        }
        samples.push(throughput);
        true
    }

    /// Produces a calibration once every workload class has enough valid samples.
    #[must_use]
    pub fn calibration(&self) -> Option<DeviceCalibration> {
        Some(DeviceCalibration {
            upload_gib_per_second: median(&self.uploads)?,
            point_millions_per_second: median(&self.points)?,
            triangle_millions_per_second: median(&self.triangles)?,
            splat_millions_per_second: median(&self.splats)?,
        })
    }
}

/// Measured primitive admission ceiling for a target frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameWorkloadBudget {
    /// Point vertices that may be drawn at the calibrated target.
    pub points: u64,
    /// Textured triangles that may be drawn at the calibrated target.
    pub triangles: u64,
    /// Gaussian splats that may be drawn at the calibrated target.
    pub splats: u64,
}

/// Transparency implementation selected for the device feature floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransparencyStrategy {
    /// Weighted blended order-independent transparency.
    WeightedBlended,
    /// CPU/tile sorted conventional alpha blending.
    SortedAlpha,
}

impl TransparencyStrategy {
    /// Selects OIT from the formats and independent blending actually exposed
    /// by the adapter, including capable WebGL2/OpenGL implementations.
    #[must_use]
    pub fn for_capabilities(capabilities: &DeviceCapabilities) -> Self {
        if capabilities.supports(crate::DeviceFeature::WeightedBlendedOit) {
            Self::WeightedBlended
        } else {
            Self::SortedAlpha
        }
    }
}

/// Host deployment class applied after adapter-specific calibration.
///
/// Desktop remains the default. Mobile/WebView constraints are explicit and
/// therefore can never become an accidental ceiling for a capable desktop GPU.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HardwareDeploymentProfile {
    /// Browser or desktop host with ordinary desktop resource ownership.
    #[default]
    Desktop,
    /// Memory- and thermally-bounded mobile browser or embedded WebView host.
    MobileWebView,
}

/// Complete initial resource, frame and quality ceiling for one adapter.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHardwarePolicy {
    /// Explicit host deployment class used to derive the policy.
    pub deployment_profile: HardwareDeploymentProfile,
    /// Shared point/mesh/raster/splat residency ceiling.
    pub resources: ResourceBudget,
    /// Per-frame work admission ceiling.
    pub frame: FrameBudget,
    /// Maximum hierarchy nodes visited by one idle streaming plan.
    pub maximum_traversed_nodes: u32,
    /// Latency-protecting streaming limits used only while interaction is active.
    pub interaction: InteractionStreamingPolicy,
    /// Per-frame primitive workload derived independently for each content class.
    pub workload: FrameWorkloadBudget,
    /// Maximum render resolution scale this device may use.
    pub maximum_render_scale: f32,
    /// Maximum scene-detail multiplier relative to the baseline SSE target.
    pub maximum_detail_scale: f32,
    /// Maximum multisample count supported and selected by policy.
    pub maximum_msaa_samples: u8,
    /// Concurrent CPU decode tasks.
    pub decoder_workers: u16,
    /// Concurrent network or local range requests.
    pub content_requests: u16,
    /// Transparency implementation.
    pub transparency: TransparencyStrategy,
}

/// Streaming work ceiling used while orbit, pan, zoom or an edit drag is active.
///
/// This limits disposable preparation work, not visible geometry correctness or
/// residency. Values remain device-derived so capable hardware is not reduced to
/// a low-end fixed tier.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionStreamingPolicy {
    /// Per-frame admission limits during interaction.
    pub frame: FrameBudget,
    /// Maximum hierarchy nodes visited by one interactive streaming plan.
    pub maximum_traversed_nodes: u32,
}

/// Deterministic hardware policy resolver.
#[derive(Debug, Default)]
pub struct HardwarePolicyResolver;

impl HardwarePolicyResolver {
    /// Resolves budgets without capping capable devices to low-end defaults.
    #[must_use]
    pub fn resolve(
        capabilities: &DeviceCapabilities,
        inventory: HardwareInventory,
        calibration: Option<DeviceCalibration>,
    ) -> ResolvedHardwarePolicy {
        Self::resolve_for_profile(
            capabilities,
            inventory,
            calibration,
            HardwareDeploymentProfile::Desktop,
        )
    }

    /// Resolves one explicit deployment profile without changing the desktop default.
    #[must_use]
    pub fn resolve_for_profile(
        capabilities: &DeviceCapabilities,
        inventory: HardwareInventory,
        calibration: Option<DeviceCalibration>,
        deployment_profile: HardwareDeploymentProfile,
    ) -> ResolvedHardwarePolicy {
        let gpu_memory = inventory
            .gpu_memory_bytes
            .unwrap_or_else(|| fallback_gpu_memory(capabilities.device_kind));
        let system_memory = inventory.system_memory_bytes.unwrap_or(8 * GIBIBYTE);
        let usable_gpu = fraction(gpu_memory, 3, 5).max(128 * MEBIBYTE);
        let gpu_buffers = fraction(usable_gpu, 11, 20);
        let gpu_textures = fraction(usable_gpu, 7, 20);
        let staging = fraction(usable_gpu, 1, 10).clamp(32 * MEBIBYTE, 512 * MEBIBYTE);
        let decoded_cpu = fraction(system_memory, 1, 5).max(256 * MEBIBYTE);
        let compressed_cpu = fraction(system_memory, 1, 10).max(128 * MEBIBYTE);
        let detail_class = calibration.map_or_else(
            || device_detail_class(capabilities.device_kind),
            calibration_detail_scale,
        );
        let points_from_memory = gpu_buffers / GPU_POINT_VERTEX_STRIDE_BYTES;
        let triangles_from_memory = gpu_buffers / 36;
        let target_frame_ms = if capabilities.device_kind == DeviceKind::Cpu
            && calibration.is_none_or(|_| detail_class < 0.9)
        {
            33.3
        } else {
            16.7
        };
        let upload_bytes = calibration.map_or(16 * MEBIBYTE, |measurement| {
            let bytes_per_frame = f64::from(measurement.upload_gib_per_second.max(0.05))
                * GIBIBYTE_F64
                * f64::from(target_frame_ms)
                / 1_000.0
                * 0.2;
            finite_u64(bytes_per_frame).clamp(4 * MEBIBYTE, 256 * MEBIBYTE)
        });
        let decoder_workers = inventory.logical_cores.saturating_sub(2).clamp(1, 16);
        let content_requests = decoder_workers.saturating_mul(2).clamp(4, 32);
        let max_msaa = preferred_msaa(capabilities.max_sample_count, detail_class);
        let workload = calibration.map_or_else(
            || fallback_workload(capabilities.device_kind, target_frame_ms),
            |measurement| calibrated_workload(measurement, target_frame_ms),
        );
        let transparency = TransparencyStrategy::for_capabilities(capabilities);
        let frame = FrameBudget {
            target_frame_ms,
            traversal_ms: (target_frame_ms * 0.08).clamp(0.75, 2.0),
            decode_ms: (target_frame_ms * 0.18).clamp(1.5, 6.0),
            upload_bytes,
            new_requests: content_requests.min(12),
        };
        let maximum_traversed_nodes =
            finite_u32(100_000.0 * f64::from(detail_class)).clamp(25_000, 1_000_000);
        let interactive_requests = finite_u32(f64::from(detail_class).ceil()).clamp(1, 8) as u16;
        let policy = ResolvedHardwarePolicy {
            deployment_profile,
            resources: ResourceBudget {
                cpu_compressed_bytes: compressed_cpu,
                cpu_decoded_bytes: decoded_cpu,
                gpu_buffer_bytes: gpu_buffers,
                gpu_texture_bytes: gpu_textures,
                staging_bytes: staging,
                points: points_from_memory,
                triangles: triangles_from_memory,
                splats: gpu_buffers / 32,
                draw_calls: finite_u32(2_000.0 * f64::from(detail_class)).clamp(500, 20_000),
            },
            frame,
            maximum_traversed_nodes,
            interaction: InteractionStreamingPolicy {
                frame: FrameBudget {
                    target_frame_ms,
                    traversal_ms: frame.traversal_ms * 0.5,
                    decode_ms: frame.decode_ms * 0.5,
                    upload_bytes: (frame.upload_bytes / 4).max(MEBIBYTE),
                    new_requests: interactive_requests.min(frame.new_requests),
                },
                maximum_traversed_nodes: (maximum_traversed_nodes / 64).clamp(2_000, 50_000),
            },
            workload,
            maximum_render_scale: detail_class.sqrt().clamp(0.75, 2.0),
            maximum_detail_scale: detail_class.clamp(0.5, 8.0),
            maximum_msaa_samples: max_msaa,
            decoder_workers,
            content_requests,
            transparency,
        };
        match deployment_profile {
            HardwareDeploymentProfile::Desktop => policy,
            HardwareDeploymentProfile::MobileWebView => mobile_webview_policy(policy),
        }
    }
}

fn mobile_webview_policy(mut policy: ResolvedHardwarePolicy) -> ResolvedHardwarePolicy {
    policy.resources.cpu_compressed_bytes =
        policy.resources.cpu_compressed_bytes.min(512 * MEBIBYTE);
    policy.resources.cpu_decoded_bytes = policy.resources.cpu_decoded_bytes.min(GIBIBYTE);
    policy.resources.gpu_buffer_bytes = policy.resources.gpu_buffer_bytes.min(512 * MEBIBYTE);
    policy.resources.gpu_texture_bytes = policy.resources.gpu_texture_bytes.min(384 * MEBIBYTE);
    policy.resources.staging_bytes = policy.resources.staging_bytes.min(128 * MEBIBYTE);
    policy.resources.points = policy
        .resources
        .points
        .min(policy.resources.gpu_buffer_bytes / GPU_POINT_VERTEX_STRIDE_BYTES);
    policy.resources.triangles = policy
        .resources
        .triangles
        .min(policy.resources.gpu_buffer_bytes / 36);
    policy.resources.splats = policy
        .resources
        .splats
        .min(policy.resources.gpu_buffer_bytes / 32);
    policy.resources.draw_calls = policy.resources.draw_calls.min(4_000);

    policy.frame.target_frame_ms = 33.3;
    policy.frame.traversal_ms = policy.frame.traversal_ms.min(1.5);
    policy.frame.decode_ms = policy.frame.decode_ms.min(4.0);
    policy.frame.upload_bytes = policy.frame.upload_bytes.min(16 * MEBIBYTE);
    policy.frame.new_requests = policy.frame.new_requests.min(6);
    policy.maximum_traversed_nodes = policy.maximum_traversed_nodes.min(100_000);
    policy.interaction.frame.target_frame_ms = 33.3;
    policy.interaction.frame.traversal_ms = policy.interaction.frame.traversal_ms.min(0.75);
    policy.interaction.frame.decode_ms = policy.interaction.frame.decode_ms.min(2.0);
    policy.interaction.frame.upload_bytes = policy.interaction.frame.upload_bytes.min(4 * MEBIBYTE);
    policy.interaction.frame.new_requests = policy.interaction.frame.new_requests.min(2);
    policy.interaction.maximum_traversed_nodes =
        policy.interaction.maximum_traversed_nodes.min(10_000);
    policy.workload.points = policy.workload.points.min(6_000_000);
    policy.workload.triangles = policy.workload.triangles.min(3_000_000);
    policy.workload.splats = policy.workload.splats.min(1_500_000);
    policy.maximum_render_scale = policy.maximum_render_scale.min(1.0);
    policy.maximum_detail_scale = policy.maximum_detail_scale.min(1.0);
    policy.maximum_msaa_samples = policy.maximum_msaa_samples.min(2);
    policy.decoder_workers = policy.decoder_workers.min(4);
    policy.content_requests = policy.content_requests.min(8);
    policy
}

/// One completed frame timing sample.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingSample {
    /// Main-thread frame time.
    pub cpu_ms: f32,
    /// GPU frame time when timestamp queries are available.
    pub gpu_ms: Option<f32>,
    /// Whether pointer, camera or edit interaction is active.
    pub interacting: bool,
}

/// Complete per-frame workload observation retained by the telemetry window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTelemetrySample {
    /// CPU/GPU latency and interaction state.
    pub timing: TimingSample,
    /// Bytes uploaded during the frame.
    pub uploaded_bytes: u64,
    /// Visible points submitted during the frame.
    pub points: u64,
    /// Visible triangles submitted during the frame.
    pub triangles: u64,
    /// Visible splats submitted during the frame.
    pub splats: u64,
    /// Submitted draw calls.
    pub draw_calls: u32,
    /// Complete GPU-resident bytes after submission.
    pub resident_gpu_bytes: u64,
}

/// Percentile distribution of valid frame durations.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTimeDistribution {
    /// Median duration.
    pub p50_ms: f32,
    /// 95th-percentile duration.
    pub p95_ms: f32,
    /// 99th-percentile duration.
    pub p99_ms: f32,
    /// Maximum duration in the window.
    pub maximum_ms: f32,
}

/// Aggregate diagnostics for a bounded recent frame window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTelemetrySnapshot {
    /// Number of frames represented.
    pub frames: usize,
    /// Main-thread timing distribution.
    pub cpu: FrameTimeDistribution,
    /// GPU timing distribution when at least one timestamp was reported.
    pub gpu: Option<FrameTimeDistribution>,
    /// Distribution of `max(cpu, gpu)` for every frame.
    pub effective: FrameTimeDistribution,
    /// Mean bytes uploaded per represented frame.
    pub mean_uploaded_bytes: u64,
    /// Peak complete GPU residency observed in the window.
    pub peak_resident_gpu_bytes: u64,
    /// Peak submitted points in one frame.
    pub peak_points: u64,
    /// Peak submitted triangles in one frame.
    pub peak_triangles: u64,
    /// Peak submitted splats in one frame.
    pub peak_splats: u64,
    /// Peak draw calls in one frame.
    pub peak_draw_calls: u32,
}

/// Fixed-capacity telemetry window with no unbounded long-session growth.
#[derive(Debug)]
pub struct FrameTelemetryWindow {
    capacity: usize,
    samples: VecDeque<FrameTelemetrySample>,
}

impl FrameTelemetryWindow {
    /// Creates a recent-frame window. Capacity is clamped to 8 through 4096.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.clamp(8, 4_096),
            samples: VecDeque::with_capacity(capacity.clamp(8, 4_096)),
        }
    }

    /// Adds one valid sample and evicts the oldest sample when the window is full.
    ///
    /// Invalid CPU timings or explicitly supplied invalid GPU timings are rejected
    /// as a whole so diagnostics and the quality governor see the same frame set.
    pub fn observe(&mut self, sample: FrameTelemetrySample) -> bool {
        if valid_duration(sample.timing.cpu_ms).is_none()
            || sample
                .timing
                .gpu_ms
                .is_some_and(|value| valid_duration(value).is_none())
        {
            return false;
        }
        if self.samples.len() == self.capacity {
            self.samples.pop_front();
        }
        self.samples.push_back(sample);
        true
    }

    /// Returns robust latency percentiles and workload peaks for recent frames.
    #[must_use]
    pub fn snapshot(&self) -> Option<FrameTelemetrySnapshot> {
        if self.samples.is_empty() {
            return None;
        }
        let cpu = self
            .samples
            .iter()
            .filter_map(|sample| valid_duration(sample.timing.cpu_ms))
            .collect::<Vec<_>>();
        let gpu = self
            .samples
            .iter()
            .filter_map(|sample| sample.timing.gpu_ms.and_then(valid_duration))
            .collect::<Vec<_>>();
        let effective = self
            .samples
            .iter()
            .filter_map(|sample| {
                let cpu = valid_duration(sample.timing.cpu_ms)?;
                Some(
                    sample
                        .timing
                        .gpu_ms
                        .and_then(valid_duration)
                        .map_or(cpu, |gpu| gpu.max(cpu)),
                )
            })
            .collect::<Vec<_>>();
        let uploaded = self.samples.iter().fold(0_u128, |total, sample| {
            total.saturating_add(u128::from(sample.uploaded_bytes))
        });
        Some(FrameTelemetrySnapshot {
            frames: self.samples.len(),
            cpu: distribution(cpu)?,
            gpu: distribution(gpu),
            effective: distribution(effective)?,
            mean_uploaded_bytes: u64::try_from(uploaded / self.samples.len() as u128)
                .unwrap_or(u64::MAX),
            peak_resident_gpu_bytes: self
                .samples
                .iter()
                .map(|sample| sample.resident_gpu_bytes)
                .max()
                .unwrap_or(0),
            peak_points: self
                .samples
                .iter()
                .map(|sample| sample.points)
                .max()
                .unwrap_or(0),
            peak_triangles: self
                .samples
                .iter()
                .map(|sample| sample.triangles)
                .max()
                .unwrap_or(0),
            peak_splats: self
                .samples
                .iter()
                .map(|sample| sample.splats)
                .max()
                .unwrap_or(0),
            peak_draw_calls: self
                .samples
                .iter()
                .map(|sample| sample.draw_calls)
                .max()
                .unwrap_or(0),
        })
    }
}

/// Current adaptive presentation quality.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeQualityState {
    /// Resolution relative to the viewport's physical pixel size.
    pub render_scale: f32,
    /// Detail relative to the baseline screen-space-error target.
    pub detail_scale: f32,
}

/// Result of observing a frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum QualityAdjustment {
    /// Hysteresis retained current quality.
    Unchanged,
    /// Quality was reduced to protect interaction latency.
    Reduced(RuntimeQualityState),
    /// Quality was increased because sustained headroom exists.
    Increased(RuntimeQualityState),
}

/// Hysteretic governor that adapts presentation but never geometry truth.
#[derive(Debug)]
pub struct RuntimeQualityGovernor {
    ceiling: RuntimeQualityState,
    state: RuntimeQualityState,
    target_ms: f32,
    smoothed_ms: f32,
    overloaded_frames: u16,
    headroom_frames: u16,
}

impl RuntimeQualityGovernor {
    /// Starts at a conservative fraction of the device-specific ceiling.
    #[must_use]
    pub fn new(policy: ResolvedHardwarePolicy) -> Self {
        let ceiling = RuntimeQualityState {
            render_scale: policy.maximum_render_scale,
            detail_scale: policy.maximum_detail_scale,
        };
        Self {
            ceiling,
            state: RuntimeQualityState {
                render_scale: ceiling.render_scale.min(1.0),
                detail_scale: (ceiling.detail_scale * 0.75)
                    .max(0.5)
                    .min(ceiling.detail_scale),
            },
            target_ms: policy.frame.target_frame_ms,
            smoothed_ms: policy.frame.target_frame_ms,
            overloaded_frames: 0,
            headroom_frames: 0,
        }
    }

    /// Current presentation quality.
    #[must_use]
    pub fn state(&self) -> RuntimeQualityState {
        self.state
    }

    /// Applies a newly calibrated device policy without an upward quality jump.
    ///
    /// Lower ceilings take effect immediately. Higher ceilings only become
    /// reachable later through the ordinary sustained-headroom hysteresis.
    pub fn update_policy(&mut self, policy: ResolvedHardwarePolicy) -> QualityAdjustment {
        let previous = self.state;
        self.ceiling = RuntimeQualityState {
            render_scale: policy.maximum_render_scale,
            detail_scale: policy.maximum_detail_scale,
        };
        self.target_ms = policy.frame.target_frame_ms;
        self.state.render_scale = self.state.render_scale.min(self.ceiling.render_scale);
        self.state.detail_scale = self.state.detail_scale.min(self.ceiling.detail_scale);
        self.smoothed_ms = self.target_ms;
        self.overloaded_frames = 0;
        self.headroom_frames = 0;
        if self.state.render_scale < previous.render_scale
            || self.state.detail_scale < previous.detail_scale
        {
            QualityAdjustment::Reduced(self.state)
        } else {
            QualityAdjustment::Unchanged
        }
    }

    /// Observes a frame and adjusts only after sustained overload or headroom.
    pub fn observe(&mut self, sample: TimingSample) -> QualityAdjustment {
        let frame_ms = sample
            .gpu_ms
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map_or(sample.cpu_ms, |gpu| gpu.max(sample.cpu_ms));
        if !frame_ms.is_finite() || frame_ms < 0.0 {
            return QualityAdjustment::Unchanged;
        }
        self.smoothed_ms = self.smoothed_ms.mul_add(0.9, frame_ms * 0.1);
        let overload_threshold = if sample.interacting { 1.05 } else { 1.15 };
        if self.smoothed_ms > self.target_ms * overload_threshold {
            self.overloaded_frames = self.overloaded_frames.saturating_add(1);
            self.headroom_frames = 0;
        } else if self.smoothed_ms < self.target_ms * 0.72 {
            self.headroom_frames = self.headroom_frames.saturating_add(1);
            self.overloaded_frames = 0;
        } else {
            self.overloaded_frames = 0;
            self.headroom_frames = 0;
        }
        if self.overloaded_frames >= 8 {
            self.overloaded_frames = 0;
            let minimum_render_scale = self.ceiling.render_scale.min(0.5);
            let minimum_detail_scale = self.ceiling.detail_scale.min(0.35);
            self.state.render_scale = (self.state.render_scale * 0.9).max(minimum_render_scale);
            self.state.detail_scale = (self.state.detail_scale * 0.85).max(minimum_detail_scale);
            return QualityAdjustment::Reduced(self.state);
        }
        if self.headroom_frames >= 45 {
            self.headroom_frames = 0;
            self.state.render_scale =
                (self.state.render_scale * 1.05).min(self.ceiling.render_scale);
            self.state.detail_scale =
                (self.state.detail_scale * 1.08).min(self.ceiling.detail_scale);
            return QualityAdjustment::Increased(self.state);
        }
        QualityAdjustment::Unchanged
    }
}

fn fallback_gpu_memory(kind: DeviceKind) -> u64 {
    match kind {
        DeviceKind::DiscreteGpu => 4 * GIBIBYTE,
        DeviceKind::IntegratedGpu => GIBIBYTE,
        DeviceKind::VirtualGpu => 768 * MEBIBYTE,
        DeviceKind::Cpu => 256 * MEBIBYTE,
        DeviceKind::Other => 512 * MEBIBYTE,
    }
}

fn device_detail_class(kind: DeviceKind) -> f32 {
    match kind {
        DeviceKind::DiscreteGpu => 2.0,
        DeviceKind::IntegratedGpu => 1.0,
        DeviceKind::VirtualGpu => 0.8,
        DeviceKind::Cpu => 0.5,
        DeviceKind::Other => 0.75,
    }
}

fn calibration_detail_scale(calibration: DeviceCalibration) -> f32 {
    if !calibration.upload_gib_per_second.is_finite()
        || !calibration.point_millions_per_second.is_finite()
        || !calibration.triangle_millions_per_second.is_finite()
        || !calibration.splat_millions_per_second.is_finite()
    {
        return 1.0;
    }
    let upload = (calibration.upload_gib_per_second / 2.0).sqrt();
    let points = (calibration.point_millions_per_second / 500.0).sqrt();
    let triangles = (calibration.triangle_millions_per_second / 250.0).sqrt();
    let splats = (calibration.splat_millions_per_second / 150.0).sqrt();
    let mut dimensions = [upload, points, triangles, splats];
    dimensions.sort_by(f32::total_cmp);
    ((dimensions[0] + dimensions[1] * 2.0 + dimensions[2]) / 4.0).clamp(0.5, 8.0)
}

fn calibrated_workload(
    calibration: DeviceCalibration,
    target_frame_ms: f32,
) -> FrameWorkloadBudget {
    let seconds = f64::from(target_frame_ms) / 1_000.0;
    let admission_fraction = 0.7_f64;
    FrameWorkloadBudget {
        points: finite_u64(
            f64::from(calibration.point_millions_per_second.max(0.0))
                * 1_000_000.0
                * seconds
                * admission_fraction,
        ),
        triangles: finite_u64(
            f64::from(calibration.triangle_millions_per_second.max(0.0))
                * 1_000_000.0
                * seconds
                * admission_fraction,
        ),
        splats: finite_u64(
            f64::from(calibration.splat_millions_per_second.max(0.0))
                * 1_000_000.0
                * seconds
                * admission_fraction,
        ),
    }
}

fn fallback_workload(kind: DeviceKind, target_frame_ms: f32) -> FrameWorkloadBudget {
    let class = f64::from(device_detail_class(kind));
    let frame_ratio = f64::from(target_frame_ms) / 16.7;
    FrameWorkloadBudget {
        points: finite_u64(4_000_000.0 * class * frame_ratio),
        triangles: finite_u64(2_000_000.0 * class * frame_ratio),
        splats: finite_u64(1_000_000.0 * class * frame_ratio),
    }
}

fn throughput(count: u64, elapsed_ms: f32, unit: f64) -> Option<f32> {
    if count == 0 || !elapsed_ms.is_finite() || elapsed_ms <= 0.0 {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let value = count as f64 / unit / (f64::from(elapsed_ms) / 1_000.0);
    if !value.is_finite() || value <= 0.0 || value > f64::from(f32::MAX) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(value as f32)
}

fn median(samples: &[f32]) -> Option<f32> {
    if samples.len() < DeviceCalibrationAccumulator::MIN_SAMPLES_PER_CLASS {
        return None;
    }
    let mut ordered = samples.to_vec();
    ordered.sort_by(f32::total_cmp);
    Some(ordered[ordered.len() / 2])
}

fn valid_duration(value: f32) -> Option<f32> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn distribution(mut samples: Vec<f32>) -> Option<FrameTimeDistribution> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(f32::total_cmp);
    Some(FrameTimeDistribution {
        p50_ms: percentile(&samples, 50),
        p95_ms: percentile(&samples, 95),
        p99_ms: percentile(&samples, 99),
        maximum_ms: *samples.last()?,
    })
}

fn percentile(sorted: &[f32], percentage: usize) -> f32 {
    let numerator = sorted.len().saturating_sub(1).saturating_mul(percentage);
    let index = numerator.div_ceil(100).min(sorted.len().saturating_sub(1));
    sorted[index]
}

fn preferred_msaa(supported: u8, detail_class: f32) -> u8 {
    let desired = if detail_class >= 1.5 { 4 } else { 2 };
    [8, 4, 2, 1]
        .into_iter()
        .find(|samples| *samples <= desired && *samples <= supported)
        .unwrap_or(1)
}

fn fraction(value: u64, numerator: u64, denominator: u64) -> u64 {
    value.saturating_div(denominator).saturating_mul(numerator)
}

fn finite_u64(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let converted = value as u64;
    converted
}

fn finite_u32(value: f64) -> u32 {
    u32::try_from(finite_u64(value)).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::{
        CalibrationObservation, DeviceCalibration, DeviceCalibrationAccumulator,
        FrameTelemetrySample, FrameTelemetryWindow, HardwareDeploymentProfile, HardwareInventory,
        HardwarePolicyResolver, QualityAdjustment, RuntimeQualityGovernor, RuntimeQualityState,
        TimingSample, TransparencyStrategy,
    };
    use crate::GPU_POINT_VERTEX_STRIDE_BYTES;
    use crate::{BackendKind, DeviceCapabilities, DeviceFeature, DeviceKind};

    #[test]
    fn reported_high_end_memory_is_not_capped_to_low_end_budget() {
        let low = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::IntegratedGpu),
            inventory(1),
            None,
        );
        let high = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::DiscreteGpu),
            inventory(24),
            None,
        );

        assert!(high.resources.gpu_buffer_bytes > low.resources.gpu_buffer_bytes * 10);
        assert!(high.resources.gpu_texture_bytes > low.resources.gpu_texture_bytes * 10);
        assert!(high.maximum_detail_scale > low.maximum_detail_scale);
    }

    #[test]
    fn mobile_webview_limits_are_explicit_and_never_cap_desktop() {
        let capabilities = capabilities(DeviceKind::DiscreteGpu);
        let inventory = inventory(24);
        let calibration = DeviceCalibration {
            upload_gib_per_second: 8.0,
            point_millions_per_second: 2_000.0,
            triangle_millions_per_second: 1_000.0,
            splat_millions_per_second: 600.0,
        };
        let desktop = HardwarePolicyResolver::resolve_for_profile(
            &capabilities,
            inventory,
            Some(calibration),
            HardwareDeploymentProfile::Desktop,
        );
        let mobile = HardwarePolicyResolver::resolve_for_profile(
            &capabilities,
            inventory,
            Some(calibration),
            HardwareDeploymentProfile::MobileWebView,
        );
        let repeated_desktop =
            HardwarePolicyResolver::resolve(&capabilities, inventory, Some(calibration));

        assert_eq!(desktop, repeated_desktop);
        assert_eq!(
            desktop.deployment_profile,
            HardwareDeploymentProfile::Desktop
        );
        assert_eq!(
            mobile.deployment_profile,
            HardwareDeploymentProfile::MobileWebView
        );
        assert_eq!(mobile.frame.target_frame_ms, 33.3);
        assert_eq!(mobile.interaction.frame.target_frame_ms, 33.3);
        assert!(mobile.resources.gpu_buffer_bytes <= 512 * super::MEBIBYTE);
        assert!(mobile.resources.gpu_texture_bytes <= 384 * super::MEBIBYTE);
        assert!(mobile.maximum_render_scale <= 1.0);
        assert!(mobile.maximum_detail_scale <= 1.0);
        assert!(mobile.maximum_msaa_samples <= 2);
        assert!(mobile.decoder_workers <= 4);
        assert!(mobile.content_requests <= 8);
        assert!(desktop.resources.gpu_buffer_bytes > mobile.resources.gpu_buffer_bytes);
        assert!(desktop.maximum_detail_scale > mobile.maximum_detail_scale);
        assert!(desktop.maximum_render_scale > mobile.maximum_render_scale);
    }

    #[test]
    fn interaction_streaming_protects_latency_without_a_low_end_global_cap() {
        let low = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::IntegratedGpu),
            inventory(1),
            None,
        );
        let high = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::DiscreteGpu),
            inventory(24),
            None,
        );

        for policy in [low, high] {
            assert!(policy.interaction.frame.traversal_ms < policy.frame.traversal_ms);
            assert!(policy.interaction.frame.decode_ms < policy.frame.decode_ms);
            assert!(policy.interaction.frame.upload_bytes < policy.frame.upload_bytes);
            assert!(policy.interaction.frame.new_requests < policy.frame.new_requests);
            assert!(policy.interaction.maximum_traversed_nodes < policy.maximum_traversed_nodes);
        }
        assert!(high.interaction.maximum_traversed_nodes > low.interaction.maximum_traversed_nodes);
        assert!(high.interaction.frame.new_requests > low.interaction.frame.new_requests);
    }

    #[test]
    fn point_memory_budget_uses_the_uploaded_vertex_stride() {
        let policy = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::DiscreteGpu),
            inventory(8),
            None,
        );

        assert_eq!(
            policy.resources.points,
            policy.resources.gpu_buffer_bytes / GPU_POINT_VERTEX_STRIDE_BYTES
        );
    }

    #[test]
    fn calibration_uses_medians_and_separates_primitive_workloads() {
        let mut accumulator = DeviceCalibrationAccumulator::new();
        for elapsed_ms in [10.0, 11.0, 500.0, 9.0, 10.5] {
            assert!(accumulator.observe(CalibrationObservation::Upload {
                bytes: super::GIBIBYTE,
                elapsed_ms,
            }));
            assert!(accumulator.observe(CalibrationObservation::Points {
                count: 10_000_000,
                elapsed_ms,
            }));
            assert!(accumulator.observe(CalibrationObservation::Triangles {
                count: 4_000_000,
                elapsed_ms,
            }));
            assert!(accumulator.observe(CalibrationObservation::Splats {
                count: 2_000_000,
                elapsed_ms,
            }));
        }
        let calibration = accumulator.calibration().expect("complete calibration");
        assert!(calibration.upload_gib_per_second > 90.0);
        assert!(calibration.point_millions_per_second > 900.0);
        assert!(calibration.triangle_millions_per_second > 350.0);
        assert!(calibration.splat_millions_per_second > 180.0);

        let policy = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::IntegratedGpu),
            inventory(8),
            Some(calibration),
        );
        assert!(policy.workload.points > policy.workload.triangles);
        assert!(policy.workload.triangles > policy.workload.splats);
        assert_eq!(policy.transparency, TransparencyStrategy::WeightedBlended);
    }

    #[test]
    fn calibration_rejects_incomplete_and_invalid_measurements() {
        let mut accumulator = DeviceCalibrationAccumulator::new();
        assert!(!accumulator.observe(CalibrationObservation::Points {
            count: 0,
            elapsed_ms: 1.0,
        }));
        assert!(!accumulator.observe(CalibrationObservation::Upload {
            bytes: 1,
            elapsed_ms: f32::NAN,
        }));
        assert!(accumulator.calibration().is_none());
    }

    #[test]
    fn measured_browser_adapter_is_not_permanently_limited_by_anonymous_cpu_metadata() {
        let policy = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::Cpu),
            HardwareInventory {
                gpu_memory_bytes: None,
                system_memory_bytes: Some(16 * super::GIBIBYTE),
                logical_cores: 12,
            },
            Some(DeviceCalibration {
                upload_gib_per_second: 4.0,
                point_millions_per_second: 1_000.0,
                triangle_millions_per_second: 500.0,
                splat_millions_per_second: 300.0,
            }),
        );

        assert_eq!(policy.frame.target_frame_ms, 16.7);
        assert!(policy.maximum_detail_scale > 1.0);
        assert!(policy.maximum_render_scale > 1.0);
    }

    #[test]
    fn telemetry_is_bounded_and_reports_latency_percentiles_and_peaks() {
        let mut telemetry = FrameTelemetryWindow::new(8);
        for frame in 0_u16..10 {
            assert!(telemetry.observe(FrameTelemetrySample {
                timing: TimingSample {
                    cpu_ms: f32::from(frame),
                    gpu_ms: Some(f32::from(frame) + 1.0),
                    interacting: false,
                },
                uploaded_bytes: u64::from(frame) * 100,
                points: u64::from(frame) * 1_000,
                triangles: u64::from(frame) * 500,
                splats: u64::from(frame) * 250,
                draw_calls: u32::from(frame),
                resident_gpu_bytes: u64::from(frame) * 10_000,
            }));
        }
        let snapshot = telemetry.snapshot().expect("non-empty window");
        assert_eq!(snapshot.frames, 8);
        assert!((snapshot.cpu.p50_ms - 6.0).abs() < f32::EPSILON);
        assert!((snapshot.cpu.p99_ms - 9.0).abs() < f32::EPSILON);
        assert!((snapshot.effective.maximum_ms - 10.0).abs() < f32::EPSILON);
        assert_eq!(snapshot.peak_points, 9_000);
        assert_eq!(snapshot.peak_resident_gpu_bytes, 90_000);
    }

    #[test]
    fn telemetry_rejects_invalid_samples_without_consuming_window_capacity() {
        let mut telemetry = FrameTelemetryWindow::new(8);
        assert!(!telemetry.observe(FrameTelemetrySample {
            timing: TimingSample {
                cpu_ms: f32::NAN,
                gpu_ms: None,
                interacting: false,
            },
            uploaded_bytes: 0,
            points: 0,
            triangles: 0,
            splats: 0,
            draw_calls: 0,
            resident_gpu_bytes: 0,
        }));
        assert!(!telemetry.observe(FrameTelemetrySample {
            timing: TimingSample {
                cpu_ms: 1.0,
                gpu_ms: Some(-1.0),
                interacting: false,
            },
            uploaded_bytes: 0,
            points: 0,
            triangles: 0,
            splats: 0,
            draw_calls: 0,
            resident_gpu_bytes: 0,
        }));
        assert!(telemetry.snapshot().is_none());
    }

    #[test]
    fn governor_uses_hysteresis_then_recovers_toward_device_ceiling() {
        let policy = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::DiscreteGpu),
            inventory(12),
            None,
        );
        let mut governor = RuntimeQualityGovernor::new(policy);
        let initial = governor.state();
        let mut reduction = QualityAdjustment::Unchanged;
        for _ in 0..20 {
            reduction = governor.observe(TimingSample {
                cpu_ms: 30.0,
                gpu_ms: Some(35.0),
                interacting: true,
            });
            if matches!(reduction, QualityAdjustment::Reduced(_)) {
                break;
            }
        }
        assert!(matches!(reduction, QualityAdjustment::Reduced(_)));
        assert!(governor.state().detail_scale < initial.detail_scale);

        let reduced = governor.state();
        for _ in 0..80 {
            governor.observe(TimingSample {
                cpu_ms: 4.0,
                gpu_ms: Some(5.0),
                interacting: false,
            });
        }
        assert!(governor.state().detail_scale > reduced.detail_scale);
        assert!(governor.state().detail_scale <= policy.maximum_detail_scale);
    }

    #[test]
    fn recalibration_applies_lower_ceiling_without_upward_jump() {
        let policy = HardwarePolicyResolver::resolve(
            &capabilities(DeviceKind::DiscreteGpu),
            inventory(12),
            None,
        );
        let mut governor = RuntimeQualityGovernor::new(policy);
        let initial = governor.state();

        let mut lower = policy;
        lower.maximum_render_scale = 0.75;
        lower.maximum_detail_scale = 0.5;
        lower.frame.target_frame_ms = 33.3;
        assert!(matches!(
            governor.update_policy(lower),
            QualityAdjustment::Reduced(_)
        ));
        assert_eq!(
            governor.state(),
            RuntimeQualityState {
                render_scale: 0.75,
                detail_scale: 0.5,
            }
        );

        assert_eq!(governor.update_policy(policy), QualityAdjustment::Unchanged);
        assert_eq!(
            governor.state(),
            RuntimeQualityState {
                render_scale: 0.75,
                detail_scale: 0.5,
            }
        );
        assert!(initial.render_scale >= governor.state().render_scale);
        assert!(initial.detail_scale >= governor.state().detail_scale);
    }

    fn inventory(gpu_gib: u64) -> HardwareInventory {
        HardwareInventory {
            gpu_memory_bytes: Some(gpu_gib * super::GIBIBYTE),
            system_memory_bytes: Some(32 * super::GIBIBYTE),
            logical_cores: 16,
        }
    }

    fn capabilities(kind: DeviceKind) -> DeviceCapabilities {
        DeviceCapabilities {
            adapter_name: "test".to_owned(),
            device_kind: kind,
            backend: BackendKind::Vulkan,
            driver: "test".to_owned(),
            driver_info: String::new(),
            features: vec![
                DeviceFeature::WebGpuCompliant,
                DeviceFeature::WeightedBlendedOit,
            ],
            max_texture_dimension_2d: 16_384,
            max_storage_buffer_binding_size: 1 << 30,
            max_buffer_size: 1 << 32,
            max_sample_count: 8,
        }
    }
}
