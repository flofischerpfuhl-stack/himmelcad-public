//! Compute inventory and deterministic memory/concurrency budget derivation.

use serde::{Deserialize, Serialize};

const GIB: u64 = 1024 * 1024 * 1024;

/// Host operating system relevant to native probing and reviewed quirks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostOperatingSystem {
    /// Microsoft Windows.
    Windows,
    /// Linux.
    Linux,
}

/// CPU inventory used by compute scheduling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuCapabilities {
    /// Physical core count.
    pub physical_cores: u16,
    /// Logical processor count.
    pub logical_cores: u16,
    /// Whether AVX2 instructions are available.
    pub supports_avx2: bool,
}

/// Vulkan compute capability observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VulkanCapabilities {
    /// Reported Vulkan API version.
    pub api_version: String,
    /// Diagnostic device name; never used for quirk matching.
    pub device_name: String,
}

/// CUDA compute capability version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaComputeCapability {
    /// Major capability version.
    pub major: u8,
    /// Minor capability version.
    pub minor: u8,
}

/// CUDA capability observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaCapabilities {
    /// Diagnostic device name; never used for quirk matching.
    pub device_name: String,
    /// CUDA compute capability.
    pub compute_capability: CudaComputeCapability,
}

/// Snapshot taken before a run is queued. Planning performs no probing itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareCapabilities {
    /// Host OS.
    pub operating_system: HostOperatingSystem,
    /// Physical RAM bytes.
    pub ram_bytes: u64,
    /// Dedicated GPU memory when available.
    pub dedicated_vram_bytes: Option<u64>,
    /// CPU inventory.
    pub cpu: CpuCapabilities,
    /// Vulkan availability.
    pub vulkan: Option<VulkanCapabilities>,
    /// CUDA availability.
    pub cuda: Option<CudaCapabilities>,
}

/// Compute backend encoded by a packaged artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputeBackend {
    /// CPU execution.
    Cpu,
    /// Vulkan execution.
    Vulkan,
    /// CUDA execution.
    Cuda,
}

/// Hardware-sensitive limits for one compute backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendResourcePlan {
    /// Backend receiving these limits.
    pub backend: ComputeBackend,
    /// Tile edge in pixels.
    pub tile_edge_pixels: u32,
    /// Batch size.
    pub batch_size: u16,
    /// Maximum concurrent workers.
    pub max_concurrency: u16,
    /// CPU threads assigned per worker.
    pub cpu_threads_per_worker: u16,
}

/// Returns quality-equivalent compute backends in unchanged preference order.
#[must_use]
pub fn available_compute_backends(hardware: &HardwareCapabilities) -> Vec<ComputeBackend> {
    let mut backends = Vec::with_capacity(3);
    if hardware.cuda.is_some() {
        backends.push(ComputeBackend::Cuda);
    }
    if hardware.vulkan.is_some() {
        backends.push(ComputeBackend::Vulkan);
    }
    backends.push(ComputeBackend::Cpu);
    backends
}

/// Derives the unchanged 16/8/4 GiB backend resource tiers.
#[must_use]
pub fn derive_compute_budget(
    backend: ComputeBackend,
    hardware: &HardwareCapabilities,
) -> BackendResourcePlan {
    let usable_bytes = match backend {
        ComputeBackend::Cpu => hardware.ram_bytes,
        ComputeBackend::Vulkan | ComputeBackend::Cuda => hardware
            .dedicated_vram_bytes
            .unwrap_or(hardware.ram_bytes / 4),
    };
    let (tile_edge_pixels, batch_size, memory_concurrency) = if usable_bytes >= 16 * GIB {
        (4_096, 8, 8)
    } else if usable_bytes >= 8 * GIB {
        (3_072, 4, 4)
    } else if usable_bytes >= 4 * GIB {
        (2_048, 2, 2)
    } else {
        (1_024, 1, 1)
    };
    let logical_cores = hardware.cpu.logical_cores.max(1);
    let max_concurrency = memory_concurrency.min(logical_cores).max(1);
    let cpu_threads_per_worker = (logical_cores / max_concurrency).max(1);
    BackendResourcePlan {
        backend,
        tile_edge_pixels,
        batch_size,
        max_concurrency,
        cpu_threads_per_worker,
    }
}

/// OS/UI reserve deducted before per-stage budgets are assigned.
#[must_use]
pub const fn memory_os_ui_reserve_bytes(physical_memory_bytes: u64) -> u64 {
    let proportional = physical_memory_bytes / 8;
    let fixed = 4 * GIB;
    if fixed > proportional {
        fixed
    } else {
        proportional
    }
}

/// Remaining machine memory after the OS/UI reserve and running-job holds.
#[must_use]
pub const fn usable_compute_memory_bytes(physical_memory_bytes: u64, running_holds: u64) -> u64 {
    physical_memory_bytes
        .saturating_sub(memory_os_ui_reserve_bytes(physical_memory_bytes))
        .saturating_sub(running_holds)
}

/// Default job concurrency from physical cores, preserving the existing 1..8 ceiling.
#[must_use]
pub fn default_job_concurrency(logical_cpus: usize, physical_cpus: usize) -> usize {
    physical_cpus
        .max(1)
        .min(logical_cpus.max(1))
        .div_ceil(2)
        .clamp(1, 8)
}

/// Testable combined CPU and memory concurrency policy retained from the product host.
#[must_use]
pub fn adaptive_job_concurrency(
    logical_cpus: usize,
    physical_cpus: usize,
    ram_bytes: u64,
) -> usize {
    const RESERVED_FOR_OS_AND_UI: u64 = 4 * GIB;
    const RESERVED_PER_COMPUTE_JOB: u64 = 12 * GIB;
    let cpu_slots = physical_cpus.max(1).min(logical_cpus.max(1)).div_ceil(2);
    let memory_slots = ram_bytes
        .saturating_sub(RESERVED_FOR_OS_AND_UI)
        .checked_div(RESERVED_PER_COMPUTE_JOB)
        .unwrap_or(0)
        .max(1);
    cpu_slots
        .min(usize::try_from(memory_slots).unwrap_or(usize::MAX))
        .clamp(1, 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_budget_tiers_and_backend_order_are_unchanged() {
        let hardware = HardwareCapabilities {
            operating_system: HostOperatingSystem::Linux,
            ram_bytes: 32 * GIB,
            dedicated_vram_bytes: Some(8 * GIB),
            cpu: CpuCapabilities {
                physical_cores: 8,
                logical_cores: 16,
                supports_avx2: true,
            },
            vulkan: Some(VulkanCapabilities {
                api_version: "1.3".into(),
                device_name: "test".into(),
            }),
            cuda: Some(CudaCapabilities {
                device_name: "test".into(),
                compute_capability: CudaComputeCapability { major: 8, minor: 6 },
            }),
        };
        assert_eq!(
            available_compute_backends(&hardware),
            [
                ComputeBackend::Cuda,
                ComputeBackend::Vulkan,
                ComputeBackend::Cpu
            ]
        );
        let plan = derive_compute_budget(ComputeBackend::Cuda, &hardware);
        assert_eq!(
            (plan.tile_edge_pixels, plan.batch_size, plan.max_concurrency),
            (3_072, 4, 4)
        );
    }

    #[test]
    fn memory_and_concurrency_values_are_unchanged() {
        assert_eq!(memory_os_ui_reserve_bytes(16 * GIB), 4 * GIB);
        assert_eq!(memory_os_ui_reserve_bytes(64 * GIB), 8 * GIB);
        assert_eq!(usable_compute_memory_bytes(16 * GIB, 2 * GIB), 10 * GIB);
        assert_eq!(default_job_concurrency(16, 8), 4);
        assert_eq!(adaptive_job_concurrency(16, 8, 32 * GIB), 2);
    }
}
