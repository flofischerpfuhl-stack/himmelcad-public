//! Asynchronous whole-frame GPU timestamp readback.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

const TIMESTAMP_BYTES: u64 = 16;
const READBACK_SLOTS: usize = 3;

/// Stable diagnostics for the non-blocking GPU timestamp ring.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuFrameTimingDiagnostics {
    /// Timestamp queries are enabled on this device.
    pub supported: bool,
    /// Readbacks currently submitted or awaiting a map callback.
    pub pending_readbacks: usize,
    /// Most recently completed valid whole-frame duration.
    pub latest_gpu_ms: Option<f32>,
    /// Number of valid samples completed since device creation.
    pub completed_samples: u64,
    /// Frames not timed because every readback slot was still pending.
    pub saturated_frames: u64,
    /// Map failures, stale callbacks or invalid timestamp payloads.
    pub failed_readbacks: u64,
}

/// One completed asynchronous GPU timestamp result correlated to submission order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuFrameTimestampSample {
    /// Monotonic timed-frame submission sequence.
    pub sequence: u64,
    /// Whole-frame GPU duration.
    pub gpu_ms: f32,
}

impl GpuFrameTimingDiagnostics {
    pub(crate) const UNSUPPORTED: Self = Self {
        supported: false,
        pending_readbacks: 0,
        latest_gpu_ms: None,
        completed_samples: 0,
        saturated_frames: 0,
        failed_readbacks: 0,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GpuFrameTimingToken {
    slot: usize,
    generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotLifecycle {
    Available,
    Mapping { generation: u64 },
}

impl SlotLifecycle {
    fn begin(&mut self, generation: u64) -> bool {
        if *self != Self::Available {
            return false;
        }
        *self = Self::Mapping { generation };
        true
    }

    fn complete(&mut self, generation: u64) -> bool {
        if *self != (Self::Mapping { generation }) {
            return false;
        }
        *self = Self::Available;
        true
    }
}

#[derive(Debug, Clone, Copy)]
struct CallbackCompletion {
    generation: u64,
    mapped: bool,
}

struct TimestampReadbackSlot {
    buffer: wgpu::Buffer,
    lifecycle: SlotLifecycle,
    callback: Arc<Mutex<Option<CallbackCompletion>>>,
}

/// Device-local timestamp query and bounded asynchronous readback ring.
pub(crate) struct GpuFrameTimestampRecorder {
    query_set: wgpu::QuerySet,
    resolve_buffer: wgpu::Buffer,
    slots: Vec<TimestampReadbackSlot>,
    next_slot: usize,
    next_generation: u64,
    timestamp_period_ns: f32,
    diagnostics: GpuFrameTimingDiagnostics,
    newest_completed_generation: u64,
    completed_samples: VecDeque<GpuFrameTimestampSample>,
}

impl GpuFrameTimestampRecorder {
    pub(crate) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("himmelcad-frame-timestamps"),
            ty: wgpu::QueryType::Timestamp,
            count: 2,
        });
        let resolve_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-frame-timestamp-resolve"),
            size: TIMESTAMP_BYTES,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let slots = (0..READBACK_SLOTS)
            .map(|_| TimestampReadbackSlot {
                buffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("himmelcad-frame-timestamp-readback"),
                    size: TIMESTAMP_BYTES,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
                lifecycle: SlotLifecycle::Available,
                callback: Arc::new(Mutex::new(None)),
            })
            .collect();
        Self {
            query_set,
            resolve_buffer,
            slots,
            next_slot: 0,
            next_generation: 1,
            timestamp_period_ns: queue.get_timestamp_period(),
            diagnostics: GpuFrameTimingDiagnostics {
                supported: true,
                ..GpuFrameTimingDiagnostics::UNSUPPORTED
            },
            newest_completed_generation: 0,
            completed_samples: VecDeque::with_capacity(READBACK_SLOTS),
        }
    }

    pub(crate) fn query_set(&self) -> &wgpu::QuerySet {
        &self.query_set
    }

    pub(crate) fn sequence(token: GpuFrameTimingToken) -> u64 {
        token.generation
    }

    pub(crate) fn begin_frame(&mut self) -> Option<GpuFrameTimingToken> {
        for offset in 0..self.slots.len() {
            let slot = (self.next_slot + offset) % self.slots.len();
            let generation = self.next_generation;
            if self.slots[slot].lifecycle.begin(generation) {
                self.next_generation = self.next_generation.wrapping_add(1).max(1);
                self.next_slot = (slot + 1) % self.slots.len();
                self.diagnostics.pending_readbacks += 1;
                return Some(GpuFrameTimingToken { slot, generation });
            }
        }
        self.diagnostics.saturated_frames = self.diagnostics.saturated_frames.saturating_add(1);
        None
    }

    pub(crate) fn resolve(&self, encoder: &mut wgpu::CommandEncoder, token: GpuFrameTimingToken) {
        encoder.resolve_query_set(&self.query_set, 0..2, &self.resolve_buffer, 0);
        encoder.copy_buffer_to_buffer(
            &self.resolve_buffer,
            0,
            &self.slots[token.slot].buffer,
            0,
            TIMESTAMP_BYTES,
        );
        let callback = Arc::clone(&self.slots[token.slot].callback);
        encoder.map_buffer_on_submit(
            &self.slots[token.slot].buffer,
            wgpu::MapMode::Read,
            ..,
            move |result| {
                let completion = CallbackCompletion {
                    generation: token.generation,
                    mapped: result.is_ok(),
                };
                if let Ok(mut state) = callback.lock() {
                    *state = Some(completion);
                }
            },
        );
    }

    pub(crate) fn collect_completed(&mut self) {
        for slot in &mut self.slots {
            let completion = slot
                .callback
                .lock()
                .ok()
                .and_then(|mut callback| callback.take());
            let Some(completion) = completion else {
                continue;
            };
            if !slot.lifecycle.complete(completion.generation) {
                self.diagnostics.failed_readbacks =
                    self.diagnostics.failed_readbacks.saturating_add(1);
                continue;
            }
            self.diagnostics.pending_readbacks =
                self.diagnostics.pending_readbacks.saturating_sub(1);
            if !completion.mapped {
                self.diagnostics.failed_readbacks =
                    self.diagnostics.failed_readbacks.saturating_add(1);
                continue;
            }
            let decoded = slot
                .buffer
                .slice(..)
                .get_mapped_range()
                .ok()
                .and_then(|mapped| decode_timestamp_ms(&mapped, self.timestamp_period_ns));
            slot.buffer.unmap();
            let Some(gpu_ms) = decoded else {
                self.diagnostics.failed_readbacks =
                    self.diagnostics.failed_readbacks.saturating_add(1);
                continue;
            };
            self.diagnostics.completed_samples =
                self.diagnostics.completed_samples.saturating_add(1);
            if completion.generation >= self.newest_completed_generation {
                self.newest_completed_generation = completion.generation;
                self.diagnostics.latest_gpu_ms = Some(gpu_ms);
            }
            if self.completed_samples.len() == READBACK_SLOTS {
                self.completed_samples.pop_front();
            }
            self.completed_samples.push_back(GpuFrameTimestampSample {
                sequence: completion.generation,
                gpu_ms,
            });
        }
    }

    pub(crate) fn take_completed_sample(&mut self) -> Option<GpuFrameTimestampSample> {
        self.completed_samples.pop_front()
    }

    pub(crate) fn diagnostics(&self) -> GpuFrameTimingDiagnostics {
        self.diagnostics
    }
}

fn decode_timestamp_ms(bytes: &[u8], timestamp_period_ns: f32) -> Option<f32> {
    if bytes.len() < TIMESTAMP_BYTES as usize
        || !timestamp_period_ns.is_finite()
        || timestamp_period_ns <= 0.0
    {
        return None;
    }
    let start = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
    let end = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let ticks = end.checked_sub(start)?;
    if ticks == 0 {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let milliseconds = ticks as f32 * timestamp_period_ns / 1_000_000.0;
    (milliseconds.is_finite() && milliseconds > 0.0).then_some(milliseconds)
}

#[cfg(test)]
mod tests {
    use super::{decode_timestamp_ms, SlotLifecycle};

    #[test]
    fn timestamp_payload_decodes_ticks_with_device_period() {
        let mut bytes = [0_u8; 16];
        bytes[0..8].copy_from_slice(&1_000_u64.to_le_bytes());
        bytes[8..16].copy_from_slice(&3_500_u64.to_le_bytes());
        assert_eq!(decode_timestamp_ms(&bytes, 2.0), Some(0.005));
        assert_eq!(decode_timestamp_ms(&bytes[..8], 2.0), None);
        assert_eq!(decode_timestamp_ms(&bytes, f32::NAN), None);
    }

    #[test]
    fn timestamp_payload_rejects_reversed_or_empty_intervals() {
        let payload = |start: u64, end: u64| {
            let mut bytes = [0_u8; 16];
            bytes[0..8].copy_from_slice(&start.to_le_bytes());
            bytes[8..16].copy_from_slice(&end.to_le_bytes());
            bytes
        };
        assert_eq!(decode_timestamp_ms(&payload(8, 7), 1.0), None);
        assert_eq!(decode_timestamp_ms(&payload(8, 8), 1.0), None);
    }

    #[test]
    fn slot_lifecycle_rejects_reuse_and_stale_completion() {
        let mut slot = SlotLifecycle::Available;
        assert!(slot.begin(7));
        assert!(!slot.begin(8));
        assert!(!slot.complete(6));
        assert!(slot.complete(7));
        assert!(slot.begin(8));
    }
}
