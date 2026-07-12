//! Read-only host capability probing for quality-equivalent resource planning.

use std::{collections::BTreeSet, fs, process::Command};

use himmelcad_core::photolab_models::{
    CpuCapabilities, CudaCapabilities, CudaComputeCapability, HardwareCapabilities,
    HostOperatingSystem, VulkanCapabilities,
};
use thiserror::Error;

const MIB: u64 = 1024 * 1024;

/// Probe failures never trigger a lower-quality algorithm; the caller may use CPU-safe limits.
#[derive(Debug, Error)]
pub enum HardwareProbeError {
    #[error("host memory could not be determined")]
    MissingMemory,
    #[error("host has no available CPU threads")]
    MissingCpu,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Captures one immutable hardware snapshot used for a queued run.
pub fn probe_hardware() -> Result<HardwareCapabilities, HardwareProbeError> {
    let logical = u16::try_from(std::thread::available_parallelism()?.get())
        .unwrap_or(u16::MAX)
        .max(1);
    let (ram_bytes, physical) = host_memory_and_physical_cores(logical)?;
    let (cuda, dedicated_vram_bytes) = probe_nvidia();
    Ok(HardwareCapabilities {
        operating_system: if cfg!(windows) {
            HostOperatingSystem::Windows
        } else {
            HostOperatingSystem::Linux
        },
        ram_bytes,
        dedicated_vram_bytes,
        cpu: CpuCapabilities {
            physical_cores: physical.max(1).min(logical),
            logical_cores: logical,
            supports_avx2: supports_avx2(),
        },
        vulkan: probe_vulkan(),
        cuda,
    })
}

fn host_memory_and_physical_cores(logical: u16) -> Result<(u64, u16), HardwareProbeError> {
    #[cfg(target_os = "linux")]
    {
        let meminfo = fs::read_to_string("/proc/meminfo")?;
        let ram_bytes = parse_linux_memory(&meminfo).ok_or(HardwareProbeError::MissingMemory)?;
        let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let physical = parse_linux_physical_cores(&cpuinfo).unwrap_or_else(|| (logical / 2).max(1));
        return Ok((ram_bytes, physical));
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("wmic")
            .args(["ComputerSystem", "get", "TotalPhysicalMemory", "/value"])
            .output()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let ram_bytes = text
            .lines()
            .find_map(|line| line.trim().strip_prefix("TotalPhysicalMemory="))
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(HardwareProbeError::MissingMemory)?;
        return Ok((ram_bytes, (logical / 2).max(1)));
    }
    #[allow(unreachable_code)]
    Err(HardwareProbeError::MissingMemory)
}

fn parse_linux_memory(text: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let mut fields = line.split_ascii_whitespace();
        if fields.next()? != "MemTotal:" {
            return None;
        }
        fields.next()?.parse::<u64>().ok()?.checked_mul(1024)
    })
}

fn parse_linux_physical_cores(text: &str) -> Option<u16> {
    let mut package = None;
    let mut core = None;
    let mut identities = BTreeSet::new();
    for line in text.lines().chain(std::iter::once("")) {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(package), Some(core)) = (package.take(), core.take()) {
                identities.insert((package, core));
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "physical id" => package = value.trim().parse::<u32>().ok(),
            "core id" => core = value.trim().parse::<u32>().ok(),
            _ => {}
        }
    }
    u16::try_from(identities.len())
        .ok()
        .filter(|count| *count > 0)
}

fn probe_nvidia() -> (Option<CudaCapabilities>, Option<u64>) {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total,compute_cap",
            "--format=csv,noheader,nounits",
        ])
        .output();
    let Ok(output) = output else {
        return (None, None);
    };
    if !output.status.success() {
        return (None, None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(line) = text.lines().next() else {
        return (None, None);
    };
    parse_nvidia_line(line).unwrap_or((None, None))
}

fn parse_nvidia_line(line: &str) -> Option<(Option<CudaCapabilities>, Option<u64>)> {
    let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
    let [name, memory_mib, capability] = fields.as_slice() else {
        return None;
    };
    if name.is_empty() || name.len() > 256 {
        return None;
    }
    let memory = memory_mib.parse::<u64>().ok()?.checked_mul(MIB)?;
    let (major, minor) = capability.split_once('.')?;
    let capability = CudaComputeCapability {
        major: major.parse().ok()?,
        minor: minor.parse().ok()?,
    };
    Some((
        Some(CudaCapabilities {
            device_name: (*name).to_owned(),
            compute_capability: capability,
        }),
        Some(memory),
    ))
}

fn probe_vulkan() -> Option<VulkanCapabilities> {
    let output = Command::new("vulkaninfo").arg("--summary").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_vulkan_summary(&String::from_utf8_lossy(&output.stdout))
}

fn parse_vulkan_summary(text: &str) -> Option<VulkanCapabilities> {
    let device_name = text.lines().find_map(|line| {
        line.split_once("deviceName")
            .and_then(|(_, value)| value.split_once('=').map(|(_, value)| value.trim()))
            .filter(|value| !value.is_empty() && value.len() <= 256)
    })?;
    let api_version = text.lines().find_map(|line| {
        line.split_once("apiVersion")
            .and_then(|(_, value)| value.split_once('=').map(|(_, value)| value.trim()))
            .filter(|value| !value.is_empty() && value.len() <= 64)
    })?;
    Some(VulkanCapabilities {
        api_version: api_version.to_owned(),
        device_name: device_name.to_owned(),
    })
}

fn supports_avx2() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        return std::is_x86_feature_detected!("avx2");
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_memory_and_physical_topology() {
        assert_eq!(
            parse_linux_memory("MemTotal:       16384 kB\n"),
            Some(16 * MIB)
        );
        let cpu = "physical id : 0\ncore id : 0\n\nphysical id : 0\ncore id : 1\n\nphysical id : 0\ncore id : 1\n";
        assert_eq!(parse_linux_physical_cores(cpu), Some(2));
    }

    #[test]
    fn parses_nvidia_and_vulkan_without_localized_free_form_values() {
        let (cuda, vram) = parse_nvidia_line("Quadro M2200, 4096, 5.2").expect("valid NVIDIA line");
        assert_eq!(vram, Some(4096 * MIB));
        assert_eq!(cuda.expect("CUDA").compute_capability.major, 5);
        let vulkan =
            parse_vulkan_summary("GPU0:\n\tapiVersion = 1.3.280\n\tdeviceName = Intel Graphics\n")
                .expect("Vulkan");
        assert_eq!(vulkan.device_name, "Intel Graphics");
    }
}
