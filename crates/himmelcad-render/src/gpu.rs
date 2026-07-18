//! `wgpu` adapter selection and capability extraction.

use crate::{BackendKind, DeviceCapabilities, DeviceFeature, DeviceKind};

/// User- or host-selected backend policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendPolicy {
    /// Use first-tier APIs and retain the GL/WebGL2 downlevel fallback.
    Automatic,
    /// Restrict the browser to WebGPU.
    WebGpuOnly,
    /// Force WebGL2 in WASM or OpenGL/OpenGL ES natively.
    GlDownlevel,
    /// Use only first-tier native backends.
    NativePrimary,
}

/// Returns the `wgpu` backend mask corresponding to a policy.
#[must_use]
pub fn enabled_backends(policy: BackendPolicy) -> wgpu::Backends {
    match policy {
        BackendPolicy::Automatic => wgpu::Backends::PRIMARY | wgpu::Backends::GL,
        BackendPolicy::WebGpuOnly => wgpu::Backends::BROWSER_WEBGPU,
        BackendPolicy::GlDownlevel => wgpu::Backends::GL,
        BackendPolicy::NativePrimary => {
            wgpu::Backends::VULKAN | wgpu::Backends::METAL | wgpu::Backends::DX12
        }
    }
}

/// Converts queried adapter limits and flags into the stable host contract.
#[must_use]
pub fn adapter_capabilities(adapter: &wgpu::Adapter) -> DeviceCapabilities {
    let info = adapter.get_info();
    let limits = adapter.limits();
    let features = adapter.features();
    let downlevel = adapter.get_downlevel_capabilities();
    let rgba8 = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm);
    let rgba16_float = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba16Float);
    let r8 = adapter.get_texture_format_features(wgpu::TextureFormat::R8Unorm);
    let max_sample_count = rgba8
        .flags
        .supported_sample_counts()
        .into_iter()
        .max()
        .and_then(|count| u8::try_from(count).ok())
        .unwrap_or(1);
    let mut optional_features = Vec::new();
    if downlevel
        .flags
        .contains(wgpu::DownlevelFlags::COMPUTE_SHADERS)
    {
        optional_features.push(DeviceFeature::Compute);
    }
    if downlevel
        .flags
        .contains(wgpu::DownlevelFlags::INDIRECT_EXECUTION)
    {
        optional_features.push(DeviceFeature::IndirectExecution);
    }
    if downlevel
        .flags
        .contains(wgpu::DownlevelFlags::FRAGMENT_WRITABLE_STORAGE)
    {
        optional_features.push(DeviceFeature::FragmentWritableStorage);
    }
    if downlevel.is_webgpu_compliant() {
        optional_features.push(DeviceFeature::WebGpuCompliant);
    }
    let blendable_attachment = |features: wgpu::TextureFormatFeatures| {
        features
            .allowed_usages
            .contains(wgpu::TextureUsages::RENDER_ATTACHMENT)
            && features
                .flags
                .contains(wgpu::TextureFormatFeatureFlags::BLENDABLE)
    };
    if limits.max_color_attachments >= 2
        && downlevel
            .flags
            .contains(wgpu::DownlevelFlags::INDEPENDENT_BLEND)
        && blendable_attachment(rgba16_float)
        && blendable_attachment(r8)
    {
        optional_features.push(DeviceFeature::WeightedBlendedOit);
    }
    if features.contains(wgpu::Features::TIMESTAMP_QUERY) {
        optional_features.push(DeviceFeature::TimestampQueries);
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_BC) {
        optional_features.push(DeviceFeature::TextureCompressionBc);
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_ETC2) {
        optional_features.push(DeviceFeature::TextureCompressionEtc2);
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_ASTC) {
        optional_features.push(DeviceFeature::TextureCompressionAstc);
    }
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_ASTC_HDR) {
        optional_features.push(DeviceFeature::TextureCompressionAstcHdr);
    }

    DeviceCapabilities {
        adapter_name: info.name,
        device_kind: device_kind(info.device_type),
        backend: backend_kind(info.backend),
        driver: info.driver,
        driver_info: info.driver_info,
        features: optional_features,
        max_texture_dimension_2d: limits.max_texture_dimension_2d,
        max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size,
        max_buffer_size: limits.max_buffer_size,
        max_sample_count,
    }
}

fn backend_kind(backend: wgpu::Backend) -> BackendKind {
    match backend {
        wgpu::Backend::Vulkan => BackendKind::Vulkan,
        wgpu::Backend::Metal => BackendKind::Metal,
        wgpu::Backend::Dx12 => BackendKind::Direct3d12,
        wgpu::Backend::Gl if cfg!(target_arch = "wasm32") => BackendKind::WebGl2,
        wgpu::Backend::Gl | wgpu::Backend::Noop => BackendKind::OpenGl,
        wgpu::Backend::BrowserWebGpu => BackendKind::WebGpu,
    }
}

fn device_kind(kind: wgpu::DeviceType) -> DeviceKind {
    match kind {
        wgpu::DeviceType::DiscreteGpu => DeviceKind::DiscreteGpu,
        wgpu::DeviceType::IntegratedGpu => DeviceKind::IntegratedGpu,
        wgpu::DeviceType::VirtualGpu => DeviceKind::VirtualGpu,
        wgpu::DeviceType::Cpu => DeviceKind::Cpu,
        wgpu::DeviceType::Other => DeviceKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::{enabled_backends, BackendPolicy};

    #[test]
    fn automatic_policy_includes_fast_and_downlevel_paths() {
        let backends = enabled_backends(BackendPolicy::Automatic);

        assert!(backends.contains(wgpu::Backends::PRIMARY));
        assert!(backends.contains(wgpu::Backends::GL));
    }

    #[test]
    fn forced_downlevel_does_not_enable_primary_backends() {
        assert_eq!(
            enabled_backends(BackendPolicy::GlDownlevel),
            wgpu::Backends::GL
        );
    }
}
