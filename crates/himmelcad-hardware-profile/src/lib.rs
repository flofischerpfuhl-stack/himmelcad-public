//! Portable hardware identity, observations, quirks, and resource-budget policy.
//!
//! Native process and filesystem probing is compiled only for non-WASM targets.
//! The crate deliberately has no renderer, async-runtime, or file-lock dependency.

#![deny(missing_docs, rust_2018_idioms, unsafe_op_in_unsafe_fn)]
#![forbid(unsafe_code)]

mod compute;
mod contracts;
mod generated_quirks;
mod hardware_policy;
mod quirks;

#[cfg(not(target_arch = "wasm32"))]
pub mod native;

pub use compute::{
    adaptive_job_concurrency, available_compute_backends, default_job_concurrency,
    derive_compute_budget, memory_os_ui_reserve_bytes, usable_compute_memory_bytes,
    BackendResourcePlan, ComputeBackend, CpuCapabilities, CudaCapabilities, CudaComputeCapability,
    HardwareCapabilities, HostOperatingSystem, VulkanCapabilities,
};
pub use contracts::{
    BackendKind, BackgroundLaneBudgets, DeviceCapabilities, DeviceFeature, DeviceKind, FrameBudget,
    FrontierBudget, FrontierHardwareClass, LaneWorkBudget, ResourceBudget, ResourceCost,
    GPU_POINT_VERTEX_STRIDE_BYTES,
};
pub use hardware_policy::{
    CalibrationObservation, DeviceCalibration, DeviceCalibrationAccumulator, FrameTelemetrySample,
    FrameTelemetrySnapshot, FrameTelemetryWindow, FrameTimeDistribution, FrameWorkloadBudget,
    GovernorPressure, GovernorTunables, HardwareDeploymentProfile, HardwareInventory,
    HardwarePolicyResolver, InteractionStreamingPolicy, MotionPolicyTunables, QualityAdjustment,
    ResolvedHardwarePolicy, RuntimeQualityGovernor, RuntimeQualityReason, RuntimeQualityState,
    RuntimeQualityTier, TimingSample, TransparencyStrategy,
};
pub use quirks::{
    resolve_quirks, reviewed_quirks, HardwareQuirk, HardwareQuirkActions, HardwareQuirkMatch,
    HardwareQuirkResolution, HardwareQuirkValidationError, HardwareQuirkVersion,
};
