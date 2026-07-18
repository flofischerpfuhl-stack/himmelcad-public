//! Window/canvas-neutral surface, device and presentation lifecycle.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::{Arc, Mutex};

use crate::gpu_frame_timing::GpuFrameTimestampRecorder;
use crate::{
    adapter_capabilities, ClipVolume, DeviceCapabilities, GpuCalibrationSession, GpuDrawBatch,
    GpuFrameError, GpuFrameTargets, GpuHitNeighborhoodReadback, GpuPickReadbackError,
    GpuSharedRenderer, TransparencyStrategy, WorldVec3, SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME,
};

/// Linear working target used before the explicit presentation transfer.
///
/// The surface itself is deliberately configured as non-sRGB. This keeps the
/// browser WebGPU and WebGL2 canvas paths on the same contract: all geometry,
/// transparency and clear operations happen in linear light, and one final
/// fullscreen pass applies the linear-to-sRGB transfer exactly once.
const FALLBACK_LINEAR_FRAME_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const PREFERRED_LINEAR_FRAME_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// Cursor-centered GPU hit request for one presentable frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfacePickRequest {
    /// Physical top-left-origin viewport pixel.
    pub pixel: [u32; 2],
    /// Inclusive neighborhood radius used to collect nearby candidates.
    pub radius: u32,
}

/// Inputs needed to render one presentable mixed-entity frame.
#[derive(Debug, Clone, Copy)]
pub struct SurfaceFrame<'a> {
    /// Camera-relative world-to-clip matrix.
    pub view_projection: [[f32; 4]; 4],
    /// Current f64 project-world origin represented by render-space zero.
    pub floating_origin: WorldVec3,
    /// Active clip volumes in deterministic evaluation order.
    pub clip_volumes: &'a [&'a ClipVolume],
    /// Resident mixed-entity batches admitted for this frame.
    pub batches: &'a [&'a GpuDrawBatch],
    /// Linear clear color. The final presentation pass applies exactly one sRGB transfer.
    pub clear_color: wgpu::Color,
    /// Optional cursor neighborhood to copy from the ID/depth attachments.
    pub pick: Option<SurfacePickRequest>,
}

/// Non-fatal reason why a presentable frame was intentionally skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceSkipReason {
    /// The surface has a zero logical extent, normally while minimized.
    Suspended,
    /// Presentation acquisition timed out; the next frame may proceed normally.
    Timeout,
    /// The platform reports that the surface is currently occluded.
    Occluded,
    /// The swapchain was outdated and has been reconfigured for the next frame.
    Reconfigured,
}

/// Device-owned state failure that requires rebuilding the complete GPU host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuRecoveryReason {
    /// The browser, driver or operating system invalidated the logical device.
    DeviceLost,
    /// A GPU allocation exhausted the device memory available to this process.
    OutOfMemory,
}

/// Result of one surface render attempt.
#[derive(Debug)]
pub enum SurfaceFrameOutcome {
    /// The frame was submitted and presented.
    Presented {
        /// The acquired texture was suboptimal and the surface was reconfigured.
        reconfigured: bool,
    },
    /// An offscreen pick pass was submitted without acquiring a platform surface.
    Picked {
        /// Pending asynchronous ID/depth neighborhood readback.
        hit_readback: GpuHitNeighborhoodReadback,
    },
    /// No frame was submitted for a recoverable lifecycle reason.
    Skipped(SurfaceSkipReason),
    /// The platform surface itself was lost and must be recreated by the host.
    RecreateSurface,
    /// The logical device and every resource created from it must be rebuilt.
    RecreateDevice {
        /// Root cause reported by the device callback or an allocation scope.
        reason: GpuRecoveryReason,
    },
}

/// Adapter, configuration or frame failure that cannot be recovered silently.
#[derive(Debug)]
pub enum GpuSurfaceError {
    /// No adapter can present to this window or canvas.
    AdapterUnavailable(String),
    /// The selected adapter could not create a logical device.
    DeviceUnavailable(String),
    /// Adapter and surface have no compatible presentable format.
    IncompatibleSurface,
    /// Surface acquisition raised a validation error.
    SurfaceValidation,
    /// An uncaptured validation or internal device error indicates a renderer bug.
    DeviceError(String),
    /// Frame-state validation failed before submission.
    Frame(GpuFrameError),
    /// Requested pick copy was invalid.
    Pick(GpuPickReadbackError),
}

impl Display for GpuSurfaceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AdapterUnavailable(message) => {
                write!(formatter, "no compatible GPU adapter: {message}")
            }
            Self::DeviceUnavailable(message) => {
                write!(formatter, "GPU device creation failed: {message}")
            }
            Self::IncompatibleSurface => {
                formatter.write_str("GPU adapter cannot present to this surface")
            }
            Self::SurfaceValidation => {
                formatter.write_str("surface texture acquisition failed validation")
            }
            Self::DeviceError(message) => write!(formatter, "GPU device failure: {message}"),
            Self::Frame(error) => Display::fmt(error, formatter),
            Self::Pick(error) => Display::fmt(error, formatter),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GpuDeviceFault {
    Recoverable(GpuRecoveryReason),
    Fatal(String),
}

#[derive(Debug, Clone, Default)]
struct GpuDeviceFaultState(Arc<Mutex<Option<GpuDeviceFault>>>);

impl GpuDeviceFaultState {
    fn record(&self, fault: GpuDeviceFault) {
        let mut current = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.is_none() {
            *current = Some(fault);
        }
    }

    fn current(&self) -> Option<GpuDeviceFault> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Error for GpuSurfaceError {}

impl From<GpuFrameError> for GpuSurfaceError {
    fn from(value: GpuFrameError) -> Self {
        Self::Frame(value)
    }
}

impl From<GpuPickReadbackError> for GpuSurfaceError {
    fn from(value: GpuPickReadbackError) -> Self {
        Self::Pick(value)
    }
}

/// Shared presentation host for browser canvases and native/Electron windows.
///
/// Window-system integration owns creation of the `wgpu::Surface`; this type owns
/// everything from adapter selection onward and contains no winit, Electron or
/// browser-framework dependency.
pub struct GpuSurfaceHost<'window> {
    surface: Option<wgpu::Surface<'window>>,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    configuration: wgpu::SurfaceConfiguration,
    presentation_target: GpuPresentationTarget,
    presentation_renderer: GpuPresentationRenderer,
    linear_frame_format: wgpu::TextureFormat,
    frame_timing: Option<GpuFrameTimestampRecorder>,
    targets: GpuFrameTargets,
    renderer: GpuSharedRenderer,
    capabilities: DeviceCapabilities,
    device_fault: GpuDeviceFaultState,
    suspended: bool,
    sorted_alpha_cursor: usize,
}

impl<'window> GpuSurfaceHost<'window> {
    /// Selects a surface-compatible adapter without feature-level bucketing and
    /// requests its full reported limits so capable devices remain capable.
    pub async fn request(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'window>,
        width: u32,
        height: u32,
        power_preference: wgpu::PowerPreference,
    ) -> Result<Self, GpuSurfaceError> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
                apply_limit_buckets: false,
            })
            .await
            .map_err(|error| GpuSurfaceError::AdapterUnavailable(error.to_string()))?;
        let surface_capabilities = surface.get_capabilities(&adapter);
        let format = choose_surface_format(&surface_capabilities.formats)
            .ok_or(GpuSurfaceError::IncompatibleSurface)?;
        let present_mode = choose_present_mode(&surface_capabilities.present_modes);
        let alpha_mode = choose_alpha_mode(&surface_capabilities.alpha_modes);
        let opportunistic_features = wgpu::Features::TIMESTAMP_QUERY
            | wgpu::Features::TEXTURE_COMPRESSION_BC
            | wgpu::Features::TEXTURE_COMPRESSION_ETC2
            | wgpu::Features::TEXTURE_COMPRESSION_ASTC
            | wgpu::Features::TEXTURE_COMPRESSION_ASTC_HDR;
        let timestamp_queries_reliable = reliable_timestamp_queries(adapter.get_info().device_type);
        let mut required_features = adapter.features() & opportunistic_features;
        if !timestamp_queries_reliable {
            required_features.remove(wgpu::Features::TIMESTAMP_QUERY);
        }
        let required_limits = adapter.limits();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("himmelcad-shared-render-device"),
                required_features,
                required_limits,
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|error| GpuSurfaceError::DeviceUnavailable(error.to_string()))?;
        let device_fault = GpuDeviceFaultState::default();
        let lost_state = device_fault.clone();
        device.set_device_lost_callback(move |reason, message| {
            if reason != wgpu::DeviceLostReason::Destroyed {
                let _ = message;
                lost_state.record(GpuDeviceFault::Recoverable(GpuRecoveryReason::DeviceLost));
            }
        });
        let error_state = device_fault.clone();
        device.on_uncaptured_error(Arc::new(move |error| match error {
            wgpu::Error::OutOfMemory { .. } => {
                error_state.record(GpuDeviceFault::Recoverable(GpuRecoveryReason::OutOfMemory))
            }
            wgpu::Error::Validation { description, .. } => {
                error_state.record(GpuDeviceFault::Fatal(format!("validation: {description}")));
            }
            wgpu::Error::Internal { description, .. } => {
                error_state.record(GpuDeviceFault::Fatal(format!("internal: {description}")));
            }
        }));
        bevy_basisu_loader_sys::basisu_init().await;
        let physical_width = width.max(1);
        let physical_height = height.max(1);
        let configuration = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: physical_width,
            height: physical_height,
            present_mode,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: Vec::new(),
        };
        surface.configure(&device, &configuration);
        let linear_frame_format = choose_linear_frame_format(&adapter);
        let presentation_renderer = GpuPresentationRenderer::new(&device, format);
        let presentation_target = presentation_renderer.create_target(
            &device,
            physical_width,
            physical_height,
            linear_frame_format,
        );
        let mut capabilities = adapter_capabilities(&adapter);
        if !required_features.contains(wgpu::Features::TIMESTAMP_QUERY) {
            capabilities
                .features
                .retain(|feature| *feature != crate::DeviceFeature::TimestampQueries);
        }
        let transparency = TransparencyStrategy::for_capabilities(&capabilities);
        let renderer = GpuSharedRenderer::new_with_transparency(
            &device,
            &queue,
            linear_frame_format,
            transparency,
        );
        let targets = renderer.create_frame_targets(&device, physical_width, physical_height);
        let frame_timing = required_features
            .contains(wgpu::Features::TIMESTAMP_QUERY)
            .then(|| GpuFrameTimestampRecorder::new(&device, &queue));
        Ok(Self {
            surface: Some(surface),
            adapter,
            device,
            queue,
            configuration,
            presentation_target,
            presentation_renderer,
            linear_frame_format,
            frame_timing,
            targets,
            renderer,
            capabilities,
            device_fault,
            suspended: width == 0 || height == 0,
            sorted_alpha_cursor: 0,
        })
    }

    /// Stable capabilities used by hardware policy and diagnostics.
    #[must_use]
    pub fn capabilities(&self) -> &DeviceCapabilities {
        &self.capabilities
    }

    /// Physical width and height of the allocated viewport targets.
    #[must_use]
    pub fn extent(&self) -> [u32; 2] {
        [self.configuration.width, self.configuration.height]
    }

    /// Selected presentable color format.
    #[must_use]
    pub fn surface_format(&self) -> wgpu::TextureFormat {
        self.configuration.format
    }

    /// Logical device used to create provider resources.
    #[must_use]
    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    /// Submission queue used to upload provider resources.
    #[must_use]
    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    /// Shared renderer used to create material resources.
    #[must_use]
    pub fn renderer(&self) -> &GpuSharedRenderer {
        &self.renderer
    }

    /// Non-blocking timestamp-query diagnostics for the whole presentation frame.
    #[must_use]
    pub fn gpu_frame_timing_diagnostics(&self) -> crate::GpuFrameTimingDiagnostics {
        self.frame_timing.as_ref().map_or(
            crate::GpuFrameTimingDiagnostics::UNSUPPORTED,
            GpuFrameTimestampRecorder::diagnostics,
        )
    }

    /// Takes the newest completed GPU duration once for runtime telemetry.
    /// Pending maps and unsupported devices return `None`.
    pub fn take_completed_gpu_frame_ms(&mut self) -> Option<f32> {
        self.poll_frame_timing();
        self.frame_timing
            .as_mut()
            .and_then(GpuFrameTimestampRecorder::take_completed_gpu_ms)
    }

    /// Creates a bounded, incremental benchmark suite for the selected device.
    ///
    /// The host can call `step` between ordinary frames and use its completed
    /// calibration to resolve hardware policy without adapter-name heuristics.
    pub fn create_calibration_session(&self) -> Result<GpuCalibrationSession, GpuFrameError> {
        GpuCalibrationSession::new_for_renderer(
            &self.device,
            &self.queue,
            self.linear_frame_format,
            &self.renderer,
        )
    }

    /// Resizes presentation and ID/depth targets. Zero extent suspends drawing
    /// without ever passing an invalid configuration to a graphics backend.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            self.suspended = true;
            return;
        }
        self.suspended = false;
        if self.configuration.width == width && self.configuration.height == height {
            return;
        }
        self.configuration.width = width;
        self.configuration.height = height;
        self.reconfigure();
        self.targets = self
            .renderer
            .create_frame_targets(&self.device, width, height);
        self.presentation_target = self.presentation_renderer.create_target(
            &self.device,
            width,
            height,
            self.linear_frame_format,
        );
    }

    /// Reconfigures the current surface after a platform or display change.
    pub fn reconfigure(&self) {
        if !self.suspended {
            if let Some(surface) = self.surface.as_ref() {
                surface.configure(&self.device, &self.configuration);
            }
        }
    }

    /// Replaces a lost platform surface while retaining the adapter, device and
    /// every resident provider resource owned by this host.
    pub fn replace_surface(
        &mut self,
        surface: wgpu::Surface<'window>,
    ) -> Result<(), GpuSurfaceError> {
        let capabilities = surface.get_capabilities(&self.adapter);
        let format = choose_surface_format(&capabilities.formats)
            .ok_or(GpuSurfaceError::IncompatibleSurface)?;
        self.configuration.present_mode = choose_present_mode(&capabilities.present_modes);
        self.configuration.alpha_mode = choose_alpha_mode(&capabilities.alpha_modes);
        if format != self.configuration.format {
            self.configuration.format = format;
            self.presentation_renderer = GpuPresentationRenderer::new(&self.device, format);
            self.presentation_target = self.presentation_renderer.create_target(
                &self.device,
                self.configuration.width,
                self.configuration.height,
                self.linear_frame_format,
            );
        }
        self.surface = Some(surface);
        self.reconfigure();
        Ok(())
    }

    fn prepare_batches<'batch>(
        &mut self,
        batches: &[&'batch GpuDrawBatch],
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
    ) -> Result<Vec<&'batch GpuDrawBatch>, GpuFrameError> {
        let mut prepared = batches.to_vec();
        if self.renderer.transparency_strategy() != TransparencyStrategy::SortedAlpha {
            return Ok(prepared);
        }
        let mut upload_budget = SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME;
        let batch_count = prepared.len();
        for offset in 0..batch_count {
            let index = (self.sorted_alpha_cursor + offset) % batch_count;
            let uploaded = prepared[index].prepare_sorted_alpha_with_budget(
                &self.queue,
                view_projection,
                floating_origin,
                upload_budget,
            )?;
            upload_budget = upload_budget.saturating_sub(uploaded);
        }
        if batch_count != 0 {
            self.sorted_alpha_cursor = (self.sorted_alpha_cursor + 1) % batch_count;
        }
        let mut depth_error = None;
        prepared.sort_by(|left, right| {
            let left = left.sorted_alpha_depth(view_projection, floating_origin);
            let right = right.sorted_alpha_depth(view_projection, floating_origin);
            match (left, right) {
                (Ok(left), Ok(right)) => left.total_cmp(&right),
                (Err(error), _) | (_, Err(error)) => {
                    depth_error = Some(error);
                    std::cmp::Ordering::Equal
                }
            }
        });
        if let Some(error) = depth_error {
            return Err(error);
        }
        Ok(prepared)
    }

    /// Renders, optionally encodes one pick neighborhood, submits and presents one frame.
    pub fn render(
        &mut self,
        frame: SurfaceFrame<'_>,
    ) -> Result<SurfaceFrameOutcome, GpuSurfaceError> {
        self.poll_device();
        if let Some(fault) = self.device_fault.current() {
            return match fault {
                GpuDeviceFault::Recoverable(reason) => {
                    Ok(SurfaceFrameOutcome::RecreateDevice { reason })
                }
                GpuDeviceFault::Fatal(message) => Err(GpuSurfaceError::DeviceError(message)),
            };
        }
        if self.suspended {
            return Ok(SurfaceFrameOutcome::Skipped(SurfaceSkipReason::Suspended));
        }
        if let Some(request) = frame.pick {
            self.renderer.update_frame(
                &self.queue,
                frame.view_projection,
                frame.floating_origin,
                frame.clip_volumes,
                [self.configuration.width, self.configuration.height],
            )?;
            let prepared_batches =
                self.prepare_batches(frame.batches, frame.view_projection, frame.floating_origin)?;
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("himmelcad-offscreen-pick-frame"),
                });
            self.renderer
                .encode_pick(&mut encoder, &self.targets, &prepared_batches);
            let hit_readback = self.targets.copy_hit_neighborhood(
                &self.device,
                &mut encoder,
                request.pixel[0],
                request.pixel[1],
                request.radius,
            )?;
            self.queue.submit([encoder.finish()]);
            return Ok(SurfaceFrameOutcome::Picked { hit_readback });
        }
        let Some(surface) = self.surface.as_ref() else {
            return Ok(SurfaceFrameOutcome::RecreateSurface);
        };
        let (surface_texture, suboptimal) = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) => (texture, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(texture) => (texture, true),
            wgpu::CurrentSurfaceTexture::Timeout => {
                return Ok(SurfaceFrameOutcome::Skipped(SurfaceSkipReason::Timeout));
            }
            wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(SurfaceFrameOutcome::Skipped(SurfaceSkipReason::Occluded));
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.reconfigure();
                return Ok(SurfaceFrameOutcome::Skipped(
                    SurfaceSkipReason::Reconfigured,
                ));
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.take();
                return Ok(SurfaceFrameOutcome::RecreateSurface);
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err(GpuSurfaceError::SurfaceValidation);
            }
        };
        self.renderer.update_frame(
            &self.queue,
            frame.view_projection,
            frame.floating_origin,
            frame.clip_volumes,
            [self.configuration.width, self.configuration.height],
        )?;
        let prepared_batches =
            self.prepare_batches(frame.batches, frame.view_projection, frame.floating_origin)?;
        let color_view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("himmelcad-surface-frame"),
            });
        let timing_token = frame
            .pick
            .is_none()
            .then(|| {
                self.frame_timing
                    .as_mut()
                    .and_then(GpuFrameTimestampRecorder::begin_frame)
            })
            .flatten();
        let timestamp_begin = timing_token.and_then(|_| {
            self.frame_timing
                .as_ref()
                .map(|timing| (timing.query_set(), 0))
        });
        self.renderer.encode_with_timestamp_begin(
            &mut encoder,
            &self.presentation_target.linear_view,
            &self.targets,
            &prepared_batches,
            frame.clear_color,
            frame.pick.is_some(),
            timestamp_begin,
        );
        self.presentation_renderer.encode(
            &mut encoder,
            &color_view,
            &self.presentation_target.bind_group,
            timing_token.and_then(|_| {
                self.frame_timing
                    .as_ref()
                    .map(|timing| (timing.query_set(), 1))
            }),
        );
        if let (Some(token), Some(timing)) = (timing_token, self.frame_timing.as_ref()) {
            timing.resolve(&mut encoder, token);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(surface_texture);
        if suboptimal {
            self.reconfigure();
        }
        Ok(SurfaceFrameOutcome::Presented {
            reconfigured: suboptimal,
        })
    }

    /// Re-queries surface capabilities after moving between displays.
    ///
    /// A format change rebuilds the format-specific pipelines. The actual adapter
    /// and device remain stable, so resident provider buffers stay valid.
    pub fn refresh_surface_capabilities(&mut self) -> Result<(), GpuSurfaceError> {
        let Some(surface) = self.surface.as_ref() else {
            return Err(GpuSurfaceError::IncompatibleSurface);
        };
        let surface_capabilities = surface.get_capabilities(&self.adapter);
        let format = choose_surface_format(&surface_capabilities.formats)
            .ok_or(GpuSurfaceError::IncompatibleSurface)?;
        self.configuration.present_mode = choose_present_mode(&surface_capabilities.present_modes);
        self.configuration.alpha_mode = choose_alpha_mode(&surface_capabilities.alpha_modes);
        if format != self.configuration.format {
            self.configuration.format = format;
            self.presentation_renderer = GpuPresentationRenderer::new(&self.device, format);
            self.presentation_target = self.presentation_renderer.create_target(
                &self.device,
                self.configuration.width,
                self.configuration.height,
                self.linear_frame_format,
            );
        }
        self.reconfigure();
        Ok(())
    }

    /// Marks a scoped allocation failure for recovery on the next frame.
    pub fn require_device_recovery(&self, reason: GpuRecoveryReason) {
        self.device_fault
            .record(GpuDeviceFault::Recoverable(reason));
    }

    fn poll_device(&mut self) {
        let _ignored_device_loss = self.device.poll(wgpu::PollType::Poll);
        if let Some(timing) = self.frame_timing.as_mut() {
            timing.collect_completed();
        }
    }

    fn poll_frame_timing(&mut self) {
        self.poll_device();
    }
}

fn choose_surface_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    formats
        .iter()
        .copied()
        .find(|format| {
            !format.is_srgb()
                && matches!(
                    format,
                    wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
                )
        })
        .or_else(|| formats.iter().copied().find(|format| !format.is_srgb()))
        .or_else(|| formats.first().copied())
}

fn choose_linear_frame_format(adapter: &wgpu::Adapter) -> wgpu::TextureFormat {
    let required = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    let preferred = adapter.get_texture_format_features(PREFERRED_LINEAR_FRAME_FORMAT);
    if preferred.allowed_usages.contains(required) {
        PREFERRED_LINEAR_FRAME_FORMAT
    } else {
        FALLBACK_LINEAR_FRAME_FORMAT
    }
}

fn reliable_timestamp_queries(device_type: wgpu::DeviceType) -> bool {
    // Browser fallback adapters can report TIMESTAMP_QUERY while rejecting
    // another MAP_READ after their asynchronous timestamp readbacks. Treat
    // timestamp support as a reliability capability: software CPU adapters do
    // not enable it, while every hardware GPU keeps the full timing path.
    device_type != wgpu::DeviceType::Cpu
}

struct GpuPresentationTarget {
    _linear_texture: wgpu::Texture,
    linear_view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
}

struct GpuPresentationRenderer {
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
}

impl GpuPresentationRenderer {
    fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("himmelcad-presentation-bind-group-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("himmelcad-presentation-pipeline-layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("himmelcad-presentation-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/presentation.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("himmelcad-presentation-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some(if surface_format.is_srgb() {
                    "fragment_linear"
                } else {
                    "fragment_encoded"
                }),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        Self {
            bind_group_layout,
            pipeline,
        }
    }

    fn create_target(
        &self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) -> GpuPresentationTarget {
        let linear_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("himmelcad-linear-frame"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let linear_view = linear_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("himmelcad-presentation-bind-group"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&linear_view),
            }],
        });
        GpuPresentationTarget {
            _linear_texture: linear_texture,
            linear_view,
            bind_group,
        }
    }

    fn encode(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        surface_view: &wgpu::TextureView,
        bind_group: &wgpu::BindGroup,
        timestamp_end: Option<(&wgpu::QuerySet, u32)>,
    ) {
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: surface_view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })];
        let timestamp_writes =
            timestamp_end.map(|(query_set, index)| wgpu::RenderPassTimestampWrites {
                query_set,
                beginning_of_pass_write_index: None,
                end_of_pass_write_index: Some(index),
            });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("himmelcad-presentation-pass"),
            color_attachments: &attachments,
            depth_stencil_attachment: None,
            timestamp_writes,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

fn choose_present_mode(modes: &[wgpu::PresentMode]) -> wgpu::PresentMode {
    if modes.contains(&wgpu::PresentMode::AutoVsync) {
        wgpu::PresentMode::AutoVsync
    } else if modes.contains(&wgpu::PresentMode::Fifo) {
        wgpu::PresentMode::Fifo
    } else {
        modes.first().copied().unwrap_or(wgpu::PresentMode::Fifo)
    }
}

fn choose_alpha_mode(modes: &[wgpu::CompositeAlphaMode]) -> wgpu::CompositeAlphaMode {
    if modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
        wgpu::CompositeAlphaMode::Opaque
    } else {
        modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Auto)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        choose_alpha_mode, choose_present_mode, choose_surface_format, reliable_timestamp_queries,
        GpuDeviceFault, GpuDeviceFaultState, GpuRecoveryReason,
    };

    #[test]
    fn device_fault_is_latched_until_the_host_is_rebuilt() {
        let state = GpuDeviceFaultState::default();
        state.record(GpuDeviceFault::Recoverable(GpuRecoveryReason::OutOfMemory));
        state.record(GpuDeviceFault::Recoverable(GpuRecoveryReason::DeviceLost));

        assert_eq!(
            state.current(),
            Some(GpuDeviceFault::Recoverable(GpuRecoveryReason::OutOfMemory))
        );
    }

    #[test]
    fn software_adapter_does_not_claim_reliable_timestamp_readback() {
        assert!(!reliable_timestamp_queries(wgpu::DeviceType::Cpu));
        assert!(reliable_timestamp_queries(wgpu::DeviceType::DiscreteGpu));
        assert!(reliable_timestamp_queries(wgpu::DeviceType::IntegratedGpu));
        assert!(reliable_timestamp_queries(wgpu::DeviceType::VirtualGpu));
        assert!(reliable_timestamp_queries(wgpu::DeviceType::Other));
    }

    #[test]
    fn surface_format_prefers_non_srgb_eight_bit_presentation_storage() {
        assert_eq!(
            choose_surface_format(&[
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureFormat::Rgba8UnormSrgb,
                wgpu::TextureFormat::Bgra8Unorm,
                wgpu::TextureFormat::Bgra8UnormSrgb,
            ]),
            Some(wgpu::TextureFormat::Bgra8Unorm)
        );
    }

    #[test]
    fn surface_format_keeps_an_srgb_only_platform_compatible() {
        assert_eq!(
            choose_surface_format(&[wgpu::TextureFormat::Rgba8UnormSrgb]),
            Some(wgpu::TextureFormat::Rgba8UnormSrgb)
        );
    }

    #[test]
    fn presentation_prefers_portable_vsync_and_opaque_compositing() {
        assert_eq!(
            choose_present_mode(&[wgpu::PresentMode::Immediate, wgpu::PresentMode::Fifo]),
            wgpu::PresentMode::Fifo
        );
        assert_eq!(
            choose_alpha_mode(&[
                wgpu::CompositeAlphaMode::PreMultiplied,
                wgpu::CompositeAlphaMode::Opaque,
            ]),
            wgpu::CompositeAlphaMode::Opaque
        );
    }
}
