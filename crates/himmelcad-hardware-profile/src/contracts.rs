use serde::{Deserialize, Serialize};

/// Exact byte stride of the canonical compact point vertex.
pub const GPU_POINT_VERTEX_STRIDE_BYTES: u64 = 36;

/// Render backend selected for the current surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendKind {
    /// Browser or native WebGPU feature level.
    WebGpu,
    /// Permanent browser downlevel path through WebGL 2.
    WebGl2,
    /// Native Vulkan backend.
    Vulkan,
    /// Native Metal backend.
    Metal,
    /// Native Direct3D 12 backend.
    Direct3d12,
    /// Native OpenGL or OpenGL ES downlevel backend.
    OpenGl,
}

/// Broad physical-device class used by policy resolution and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    /// Discrete GPU with dedicated memory.
    DiscreteGpu,
    /// Integrated or unified-memory GPU.
    IntegratedGpu,
    /// Virtualized GPU.
    VirtualGpu,
    /// CPU or software adapter.
    Cpu,
    /// Adapter class was not reported.
    Other,
}

/// Optional adapter feature used to select fast or downlevel pipelines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceFeature {
    /// General compute shaders are available.
    Compute,
    /// Indirect draw and dispatch are available.
    IndirectExecution,
    /// Fragment shaders may write storage resources.
    FragmentWritableStorage,
    /// Adapter satisfies the complete WebGPU downlevel contract.
    WebGpuCompliant,
    /// Blendable half-float MRT attachments support weighted blended OIT.
    WeightedBlendedOit,
    /// GPU timestamp queries are available and reliable.
    TimestampQueries,
    /// BC-family block-compressed textures are available.
    TextureCompressionBc,
    /// ETC2/EAC block-compressed textures are available.
    TextureCompressionEtc2,
    /// ASTC LDR block-compressed textures are available.
    TextureCompressionAstc,
    /// ASTC HDR block-compressed textures are available.
    TextureCompressionAstcHdr,
}

/// Measured and queried capabilities used to resolve a device policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    /// Human-readable adapter name for diagnostics only.
    pub adapter_name: String,
    /// Physical device class.
    pub device_kind: DeviceKind,
    /// Active backend.
    pub backend: BackendKind,
    /// Driver name when the platform exposes it.
    pub driver: String,
    /// Driver version or implementation detail when exposed.
    pub driver_info: String,
    /// Supported optional features.
    pub features: Vec<DeviceFeature>,
    /// Maximum two-dimensional texture edge.
    pub max_texture_dimension_2d: u32,
    /// Maximum storage-buffer binding size in bytes.
    pub max_storage_buffer_binding_size: u64,
    /// Maximum buffer size in bytes.
    pub max_buffer_size: u64,
    /// Maximum supported MSAA sample count selected from tested formats.
    pub max_sample_count: u8,
}

impl DeviceCapabilities {
    /// Returns whether an optional feature is available.
    #[must_use]
    pub fn supports(&self, feature: DeviceFeature) -> bool {
        self.features.contains(&feature)
    }
}

/// Resource demand used by every provider and backend.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCost {
    /// Compressed bytes retained on the CPU.
    pub cpu_compressed_bytes: u64,
    /// Decoded bytes retained on the CPU.
    pub cpu_decoded_bytes: u64,
    /// GPU buffer bytes.
    pub gpu_buffer_bytes: u64,
    /// GPU texture bytes including resident mip levels.
    pub gpu_texture_bytes: u64,
    /// Temporary staging bytes required for upload.
    pub staging_bytes: u64,
    /// Rendered or resident point count.
    pub points: u64,
    /// Rendered or resident triangle count.
    pub triangles: u64,
    /// Rendered or resident splat count.
    pub splats: u64,
    /// Draw calls added by the content.
    pub draw_calls: u32,
}

impl ResourceCost {
    /// Adds costs without wrapping on overflow.
    #[must_use]
    pub fn saturating_add(self, other: Self) -> Self {
        Self {
            cpu_compressed_bytes: self
                .cpu_compressed_bytes
                .saturating_add(other.cpu_compressed_bytes),
            cpu_decoded_bytes: self
                .cpu_decoded_bytes
                .saturating_add(other.cpu_decoded_bytes),
            gpu_buffer_bytes: self.gpu_buffer_bytes.saturating_add(other.gpu_buffer_bytes),
            gpu_texture_bytes: self
                .gpu_texture_bytes
                .saturating_add(other.gpu_texture_bytes),
            staging_bytes: self.staging_bytes.saturating_add(other.staging_bytes),
            points: self.points.saturating_add(other.points),
            triangles: self.triangles.saturating_add(other.triangles),
            splats: self.splats.saturating_add(other.splats),
            draw_calls: self.draw_calls.saturating_add(other.draw_calls),
        }
    }

    /// Subtracts costs without underflowing individual dimensions.
    #[must_use]
    pub fn saturating_sub(self, other: Self) -> Self {
        Self {
            cpu_compressed_bytes: self
                .cpu_compressed_bytes
                .saturating_sub(other.cpu_compressed_bytes),
            cpu_decoded_bytes: self
                .cpu_decoded_bytes
                .saturating_sub(other.cpu_decoded_bytes),
            gpu_buffer_bytes: self.gpu_buffer_bytes.saturating_sub(other.gpu_buffer_bytes),
            gpu_texture_bytes: self
                .gpu_texture_bytes
                .saturating_sub(other.gpu_texture_bytes),
            staging_bytes: self.staging_bytes.saturating_sub(other.staging_bytes),
            points: self.points.saturating_sub(other.points),
            triangles: self.triangles.saturating_sub(other.triangles),
            splats: self.splats.saturating_sub(other.splats),
            draw_calls: self.draw_calls.saturating_sub(other.draw_calls),
        }
    }
}

/// Device-policy limits shared by all visible content kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudget {
    /// Maximum compressed CPU residency.
    pub cpu_compressed_bytes: u64,
    /// Maximum decoded CPU residency.
    pub cpu_decoded_bytes: u64,
    /// Maximum GPU buffer residency.
    pub gpu_buffer_bytes: u64,
    /// Maximum GPU texture residency.
    pub gpu_texture_bytes: u64,
    /// Maximum staging bytes in flight.
    pub staging_bytes: u64,
    /// Maximum resident or selected points.
    pub points: u64,
    /// Maximum resident or selected triangles.
    pub triangles: u64,
    /// Maximum resident or selected splats.
    pub splats: u64,
    /// Maximum draw calls.
    pub draw_calls: u32,
}

impl ResourceBudget {
    /// Returns whether a combined cost fits every resource dimension.
    #[must_use]
    pub fn contains(self, cost: ResourceCost) -> bool {
        cost.cpu_compressed_bytes <= self.cpu_compressed_bytes
            && cost.cpu_decoded_bytes <= self.cpu_decoded_bytes
            && cost.gpu_buffer_bytes <= self.gpu_buffer_bytes
            && cost.gpu_texture_bytes <= self.gpu_texture_bytes
            && cost.staging_bytes <= self.staging_bytes
            && cost.points <= self.points
            && cost.triangles <= self.triangles
            && cost.splats <= self.splats
            && cost.draw_calls <= self.draw_calls
    }
}

/// Time-sensitive limits applied in addition to residency budgets.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameBudget {
    /// Target complete frame time in milliseconds.
    pub target_frame_ms: f32,
    /// CPU time granted to hierarchy traversal and scheduling.
    pub traversal_ms: f32,
    /// CPU decode time allowed to complete per frame.
    pub decode_ms: f32,
    /// Bytes that may be uploaded in one frame without explicit override.
    pub upload_bytes: u64,
    /// Maximum new content requests started in one frame.
    pub new_requests: u16,
}

/// Hardware class from Viewer Core addendum section 1.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrontierHardwareClass {
    /// Integrated/entry hardware floor.
    I,
    /// Laptop-workstation floor.
    W,
    /// Desktop discrete-GPU floor.
    D,
}

/// Hard per-frame ceiling for one background lane.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneWorkBudget {
    /// Point and splat samples admitted by the lane.
    pub points: u64,
    /// Selected GPU bytes admitted by the lane.
    pub bytes: u64,
    /// Draws admitted by the lane.
    pub draw_calls: u32,
    /// Upload bytes admitted by the lane.
    pub upload_bytes: u64,
    /// Decode milliseconds admitted by the lane.
    pub decode_ms: f32,
}

impl LaneWorkBudget {
    /// Compatibility value for callers predating protected scheduling.
    pub const UNLIMITED: Self = Self {
        points: u64::MAX,
        bytes: u64::MAX,
        draw_calls: u32::MAX,
        upload_bytes: u64::MAX,
        decode_ms: f32::MAX,
    };
}

/// Lane 4–6 ceilings carried by the class frontier policy.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundLaneBudgets {
    /// Coarse mesh/raster lane.
    pub lane4: LaneWorkBudget,
    /// Coarse cloud/splat lane.
    pub lane5: LaneWorkBudget,
    /// Cross-provider refinement lane.
    pub lane6: LaneWorkBudget,
}

impl BackgroundLaneBudgets {
    /// Compatibility value used by the pre-V-03 admission API.
    pub const UNLIMITED: Self = Self {
        lane4: LaneWorkBudget::UNLIMITED,
        lane5: LaneWorkBudget::UNLIMITED,
        lane6: LaneWorkBudget::UNLIMITED,
    };
}

const MEBIBYTE: u64 = 1_048_576;

/// Tunable hard limits for the visible prepared frontier.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontierBudget {
    /// Hardware class whose checked-in policy selected these values.
    pub hardware_class: FrontierHardwareClass,
    /// Maximum submitted point samples in one frame.
    pub points: u64,
    /// Maximum selected GPU buffer bytes in one frame.
    pub bytes: u64,
    /// Maximum selected draw calls in one frame.
    pub draw_calls: u32,
    /// Hard per-frame remainder caps for lanes 4–6 at rest.
    #[serde(default = "unlimited_background_lanes")]
    pub background_lanes: BackgroundLaneBudgets,
    /// Motion policy: coarse fallback lanes stay live while refinement is paused.
    #[serde(default = "unlimited_background_lanes")]
    pub motion_background_lanes: BackgroundLaneBudgets,
}

impl FrontierBudget {
    /// Checked-in V-02 class defaults.
    #[must_use]
    pub const fn for_hardware_class(hardware_class: FrontierHardwareClass) -> Self {
        match hardware_class {
            FrontierHardwareClass::I => Self::class(hardware_class, 4_000_000, 96, 1_000, 1),
            FrontierHardwareClass::W => Self::class(hardware_class, 8_000_000, 192, 2_000, 2),
            FrontierHardwareClass::D => Self::class(hardware_class, 16_000_000, 384, 4_000, 4),
        }
    }

    const fn class(
        hardware_class: FrontierHardwareClass,
        points: u64,
        mebibytes: u64,
        draw_calls: u32,
        multiplier: u64,
    ) -> Self {
        let lanes = class_lane_budgets(multiplier);
        Self {
            hardware_class,
            points,
            bytes: mebibytes * MEBIBYTE,
            draw_calls,
            background_lanes: lanes,
            motion_background_lanes: motion_lane_budgets(lanes),
        }
    }

    /// Compatibility ceiling used by callers that do not distinguish visible-frontier limits.
    #[must_use]
    pub const fn from_resource_budget(budget: ResourceBudget) -> Self {
        Self {
            hardware_class: FrontierHardwareClass::W,
            points: budget.points,
            bytes: budget
                .gpu_buffer_bytes
                .saturating_add(budget.gpu_texture_bytes),
            draw_calls: budget.draw_calls,
            background_lanes: BackgroundLaneBudgets::UNLIMITED,
            motion_background_lanes: BackgroundLaneBudgets::UNLIMITED,
        }
    }

    /// Resolves lane upload/decode remainder from the measured frame policy.
    #[must_use]
    pub fn with_frame_budget(mut self, frame: FrameBudget) -> Self {
        let upload = split_u64(frame.upload_bytes);
        let decode = split_f32(frame.decode_ms);
        self.background_lanes.lane4.upload_bytes = upload[0];
        self.background_lanes.lane5.upload_bytes = upload[1];
        self.background_lanes.lane6.upload_bytes = upload[2];
        self.background_lanes.lane4.decode_ms = decode[0];
        self.background_lanes.lane5.decode_ms = decode[1];
        self.background_lanes.lane6.decode_ms = decode[2];
        self.motion_background_lanes = motion_lane_budgets(self.background_lanes);
        self
    }
}

const fn class_lane_budgets(multiplier: u64) -> BackgroundLaneBudgets {
    let multiplier_u32 = multiplier as u32;
    BackgroundLaneBudgets {
        lane4: LaneWorkBudget {
            points: 500_000 * multiplier,
            bytes: 28 * MEBIBYTE * multiplier,
            draw_calls: 300 * multiplier_u32,
            upload_bytes: 4 * MEBIBYTE * multiplier,
            decode_ms: 0.5 * multiplier as f32,
        },
        lane5: LaneWorkBudget {
            points: 2_000_000 * multiplier,
            bytes: 34 * MEBIBYTE * multiplier,
            draw_calls: 350 * multiplier_u32,
            upload_bytes: 6 * MEBIBYTE * multiplier,
            decode_ms: 0.6 * multiplier as f32,
        },
        lane6: LaneWorkBudget {
            points: 1_500_000 * multiplier,
            bytes: 34 * MEBIBYTE * multiplier,
            draw_calls: 350 * multiplier_u32,
            upload_bytes: 6 * MEBIBYTE * multiplier,
            decode_ms: 0.4 * multiplier as f32,
        },
    }
}

const fn motion_lane_budgets(mut lanes: BackgroundLaneBudgets) -> BackgroundLaneBudgets {
    lanes.lane6 = LaneWorkBudget {
        points: 0,
        bytes: 0,
        draw_calls: 0,
        upload_bytes: 0,
        decode_ms: 0.0,
    };
    lanes
}

const fn unlimited_background_lanes() -> BackgroundLaneBudgets {
    BackgroundLaneBudgets::UNLIMITED
}

fn split_u64(total: u64) -> [u64; 3] {
    let lane4 = total.saturating_mul(30) / 100;
    let lane5 = total.saturating_mul(35) / 100;
    [
        lane4,
        lane5,
        total.saturating_sub(lane4).saturating_sub(lane5),
    ]
}

fn split_f32(total: f32) -> [f32; 3] {
    let bounded = total.max(0.0);
    [bounded * 0.3, bounded * 0.35, bounded * 0.35]
}
