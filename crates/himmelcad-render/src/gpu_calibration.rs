//! Incremental completion-fenced calibration on the actual selected `wgpu` device.

use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

use crate::{
    CalibrationObservation, DeviceCalibration, DeviceCalibrationAccumulator, GpuDrawBatch,
    GpuFrameError, GpuFrameTargets, GpuMeshVertexInput, GpuSharedRenderer, GpuSplatVertex,
    WorldVec3,
};

const TARGET_EDGE: u32 = 256;
const UPLOAD_BYTES: u64 = 8 * 1_048_576;
const SAMPLES_PER_CLASS: u8 = 3;
const TOTAL_SAMPLES: u8 = SAMPLES_PER_CLASS * 4;

#[cfg(not(target_arch = "wasm32"))]
struct CompletionTimer(Instant);

#[cfg(target_arch = "wasm32")]
struct CompletionTimer(f64);

impl CompletionTimer {
    fn start() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        {
            Self(Instant::now())
        }
        #[cfg(target_arch = "wasm32")]
        {
            Self(js_sys::Date::now())
        }
    }

    #[allow(clippy::cast_possible_truncation)]
    fn elapsed_ms(&self) -> f32 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.0.elapsed().as_secs_f32() * 1_000.0
        }
        #[cfg(target_arch = "wasm32")]
        {
            (js_sys::Date::now() - self.0) as f32
        }
    }
}

/// Progress of an incremental startup calibration session.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuCalibrationProgress {
    /// Successfully completed benchmark submissions.
    pub completed_samples: u8,
    /// Fixed total number of bounded submissions.
    pub total_samples: u8,
    /// Whether one submitted pass is awaiting GPU completion.
    pub in_flight: bool,
    /// Completed robust calibration once all passes finished.
    pub calibration: Option<DeviceCalibration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CalibrationClass {
    Upload,
    Points,
    Triangles,
    Splats,
    Complete,
}

impl CalibrationClass {
    fn next(self) -> Self {
        match self {
            Self::Upload => Self::Points,
            Self::Points => Self::Triangles,
            Self::Triangles => Self::Splats,
            Self::Splats | Self::Complete => Self::Complete,
        }
    }
}

#[derive(Debug)]
struct CalibrationState {
    accumulator: DeviceCalibrationAccumulator,
    class: CalibrationClass,
    samples_in_class: u8,
    completed_samples: u8,
    in_flight: bool,
}

/// Non-blocking benchmark suite using the production pipelines and selected adapter.
///
/// Call [`Self::step`] from the host event loop. It submits at most one bounded pass;
/// normal device polling completes that pass and unlocks the next step. No synchronous
/// wait is introduced in the browser or native interaction thread.
pub struct GpuCalibrationSession {
    state: Arc<Mutex<CalibrationState>>,
    color_texture: wgpu::Texture,
    targets: GpuFrameTargets,
    upload_source: Vec<u8>,
    upload_buffer: wgpu::Buffer,
    upload_sink: wgpu::Buffer,
    points: GpuDrawBatch,
    triangles: GpuDrawBatch,
    splats: GpuDrawBatch,
}

impl GpuCalibrationSession {
    /// Allocates bounded representative workloads compatible with a renderer format.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        color_format: wgpu::TextureFormat,
    ) -> Result<Self, GpuFrameError> {
        let color_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("himmelcad-calibration-color"),
            size: wgpu::Extent3d {
                width: TARGET_EDGE,
                height: TARGET_EDGE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: color_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let upload_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-calibration-upload"),
            size: UPLOAD_BYTES,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let upload_sink = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-calibration-upload-sink"),
            size: UPLOAD_BYTES,
            usage: wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Ok(Self {
            state: Arc::new(Mutex::new(CalibrationState {
                accumulator: DeviceCalibrationAccumulator::new(),
                class: CalibrationClass::Upload,
                samples_in_class: 0,
                completed_samples: 0,
                in_flight: false,
            })),
            color_texture,
            targets: GpuFrameTargets::new(device, TARGET_EDGE, TARGET_EDGE),
            upload_source: vec![0x5a; usize::try_from(UPLOAD_BYTES).expect("bounded upload")],
            upload_buffer,
            upload_sink,
            points: calibration_points(device, queue)?,
            triangles: calibration_triangles(device, queue)?,
            splats: calibration_splats(device, queue)?,
        })
    }

    /// Allocates workloads and attachments matching an existing renderer's
    /// capability-selected transparency path.
    pub fn new_for_renderer(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        color_format: wgpu::TextureFormat,
        renderer: &GpuSharedRenderer,
    ) -> Result<Self, GpuFrameError> {
        let mut session = Self::new(device, queue, color_format)?;
        session.targets = renderer.create_frame_targets(device, TARGET_EDGE, TARGET_EDGE);
        Ok(session)
    }

    /// Returns current progress without waiting for the GPU.
    #[must_use]
    pub fn progress(&self) -> GpuCalibrationProgress {
        let state = lock_state(&self.state);
        GpuCalibrationProgress {
            completed_samples: state.completed_samples,
            total_samples: TOTAL_SAMPLES,
            in_flight: state.in_flight,
            calibration: state.accumulator.calibration(),
        }
    }

    /// Submits the next pass, or returns `false` while a pass is in flight or complete.
    pub fn step(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        renderer: &GpuSharedRenderer,
    ) -> Result<bool, GpuFrameError> {
        let class = {
            let mut state = lock_state(&self.state);
            if state.in_flight || state.class == CalibrationClass::Complete {
                return Ok(false);
            }
            state.in_flight = true;
            state.class
        };
        let started = CompletionTimer::start();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("himmelcad-calibration-pass"),
        });
        let observation = match self.encode_class(class, queue, renderer, &mut encoder) {
            Ok(observation) => observation,
            Err(error) => {
                lock_state(&self.state).in_flight = false;
                return Err(error);
            }
        };
        let state = Arc::clone(&self.state);
        let command_buffer = encoder.finish();
        command_buffer.on_submitted_work_done(move || {
            let elapsed_ms = started.elapsed_ms();
            let mut state = lock_state(&state);
            if state.accumulator.observe(observation.finish(elapsed_ms)) {
                state.samples_in_class = state.samples_in_class.saturating_add(1);
                state.completed_samples = state.completed_samples.saturating_add(1);
                if state.samples_in_class == SAMPLES_PER_CLASS {
                    state.samples_in_class = 0;
                    state.class = state.class.next();
                }
            }
            state.in_flight = false;
        });
        queue.submit([command_buffer]);
        Ok(true)
    }

    fn encode_class(
        &self,
        class: CalibrationClass,
        queue: &wgpu::Queue,
        renderer: &GpuSharedRenderer,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<PendingObservation, GpuFrameError> {
        match class {
            CalibrationClass::Upload => {
                queue.write_buffer(&self.upload_buffer, 0, &self.upload_source);
                encoder.copy_buffer_to_buffer(
                    &self.upload_buffer,
                    0,
                    &self.upload_sink,
                    0,
                    UPLOAD_BYTES,
                );
                Ok(PendingObservation::Upload(UPLOAD_BYTES))
            }
            CalibrationClass::Points => {
                self.encode_workload(queue, renderer, encoder, &self.points, 16)?;
                Ok(PendingObservation::Points(16_384 * 16))
            }
            CalibrationClass::Triangles => {
                self.encode_workload(queue, renderer, encoder, &self.triangles, 8)?;
                Ok(PendingObservation::Triangles(32_768 * 8))
            }
            CalibrationClass::Splats => {
                self.encode_workload(queue, renderer, encoder, &self.splats, 16)?;
                Ok(PendingObservation::Splats(4_096 * 16))
            }
            CalibrationClass::Complete => unreachable!("complete session rejected before encoding"),
        }
    }

    fn encode_workload(
        &self,
        queue: &wgpu::Queue,
        renderer: &GpuSharedRenderer,
        encoder: &mut wgpu::CommandEncoder,
        batch: &GpuDrawBatch,
        repetitions: usize,
    ) -> Result<(), GpuFrameError> {
        renderer.update_frame(
            queue,
            identity(),
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            &[],
            [TARGET_EDGE, TARGET_EDGE],
        )?;
        let color_view = self
            .color_texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let batches = std::iter::repeat_n(batch, repetitions).collect::<Vec<_>>();
        renderer.encode(
            encoder,
            &color_view,
            &self.targets,
            &batches,
            wgpu::Color::BLACK,
            false,
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
enum PendingObservation {
    Upload(u64),
    Points(u64),
    Triangles(u64),
    Splats(u64),
}

impl PendingObservation {
    fn finish(self, elapsed_ms: f32) -> CalibrationObservation {
        match self {
            Self::Upload(bytes) => CalibrationObservation::Upload { bytes, elapsed_ms },
            Self::Points(count) => CalibrationObservation::Points { count, elapsed_ms },
            Self::Triangles(count) => CalibrationObservation::Triangles { count, elapsed_ms },
            Self::Splats(count) => CalibrationObservation::Splats { count, elapsed_ms },
        }
    }
}

fn lock_state(state: &Arc<Mutex<CalibrationState>>) -> MutexGuard<'_, CalibrationState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn calibration_points(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> Result<GpuDrawBatch, GpuFrameError> {
    let positions = (0_u32..16_384)
        .map(|index| grid_position(index, 128, 0.6))
        .collect::<Vec<_>>();
    GpuDrawBatch::new_points_with_queue(
        device,
        queue,
        "himmelcad-calibration-points",
        1,
        &positions,
        &vec![[128, 192, 255, 255]; positions.len()],
    )
}

fn calibration_triangles(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> Result<GpuDrawBatch, GpuFrameError> {
    let mut vertices = Vec::with_capacity(128 * 128 * 4);
    let mut indices = Vec::with_capacity(128 * 128 * 6);
    for cell in 0_u32..16_384 {
        let [x, y, z] = grid_position(cell, 128, 0.5);
        let half = 1.0 / 128.0;
        let base = u32::try_from(vertices.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        for position in [
            [x - half, y - half, z],
            [x + half, y - half, z],
            [x + half, y + half, z],
            [x - half, y + half, z],
        ] {
            vertices.push(GpuMeshVertexInput {
                position,
                normal: [0.0, 0.0, 1.0],
                tex_coord: [0.5, 0.5],
                additional_tex_coords: [[0.0; 2]; 7],
                color: [0.6, 0.7, 0.8, 1.0],
            });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    GpuDrawBatch::new_indexed_mesh_with_queue(
        device,
        queue,
        "himmelcad-calibration-triangles",
        2,
        0,
        &vertices,
        &indices,
        false,
    )
}

fn calibration_splats(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> Result<GpuDrawBatch, GpuFrameError> {
    let splats = (0_u32..4_096)
        .map(|index| GpuSplatVertex {
            position: grid_position(index, 64, 0.4),
            color: [128, 192, 255, 96],
            scale: [0.012, 0.008, 0.004],
            rotation: [0.0, 0.0, 0.0, 1.0],
            proxy_slot: 3,
            primitive_slot: index,
        })
        .collect::<Vec<_>>();
    GpuDrawBatch::new_gaussian_splats_for_transparency_with_queue(
        device,
        queue,
        "himmelcad-calibration-splats",
        &splats,
        crate::TransparencyStrategy::SortedAlpha,
    )
}

fn grid_position(index: u32, edge: u32, z: f32) -> [f32; 3] {
    let x = index % edge;
    let y = index / edge;
    let denominator =
        f32::from(u16::try_from(edge.saturating_sub(1)).expect("calibration grid edge fits u16"));
    let x = f32::from(u16::try_from(x).expect("calibration grid X fits u16"));
    let y = f32::from(u16::try_from(y).expect("calibration grid Y fits u16"));
    [
        (x / denominator).mul_add(1.8, -0.9),
        (y / denominator).mul_add(1.8, -0.9),
        z,
    ]
}

fn identity() -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::GpuCalibrationSession;
    use crate::GpuSharedRenderer;

    #[tokio::test]
    async fn real_device_completes_incremental_calibration() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(descriptor);
        let Ok(adapter) = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
        else {
            return;
        };
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("himmelcad-calibration-test-device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..wgpu::DeviceDescriptor::default()
            })
            .await
            .expect("calibration test device");
        let renderer = GpuSharedRenderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        let session = GpuCalibrationSession::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm)
            .expect("calibration session");

        while session.progress().calibration.is_none() {
            assert!(session
                .step(&device, &queue, &renderer)
                .expect("calibration step"));
            device
                .poll(wgpu::PollType::wait_indefinitely())
                .expect("calibration poll");
        }
        let progress = session.progress();
        let calibration = progress.calibration.expect("complete calibration");
        assert_eq!(progress.completed_samples, progress.total_samples);
        assert!(calibration.upload_gib_per_second > 0.0);
        assert!(calibration.point_millions_per_second > 0.0);
        assert!(calibration.triangle_millions_per_second > 0.0);
        assert!(calibration.splat_millions_per_second > 0.0);
    }
}
