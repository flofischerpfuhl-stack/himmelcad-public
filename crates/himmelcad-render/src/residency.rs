//! Host-neutral asynchronous content lifecycle, accounting and eviction.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

use crate::{
    AdmissionCandidate, ContentKind, ResourceBudget, ResourceCost, SelectedTile, TileKey,
    TileResidency, GPU_POINT_VERTEX_STRIDE_BYTES,
};

/// Fine-grained asynchronous stage for one tile's complete visual content set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResidencyStage {
    /// No retained bytes and no task in flight.
    Unloaded,
    /// A local or network byte-range request is in flight.
    Fetching,
    /// Compressed bytes await an available decoder worker.
    QueuedDecode,
    /// A CPU decoder is running.
    Decoding,
    /// Decoded resources await the frame upload budget.
    QueuedUpload,
    /// GPU copies are in flight.
    Uploading,
    /// Complete provider resources are available for drawing.
    Resident,
    /// The last operation failed and is retained for diagnostics.
    Failed,
}

/// Generation-bearing authority carried by asynchronous fetch/decode/upload work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidencyTicket {
    /// Tile whose lifecycle this task may advance.
    pub key: TileKey,
    /// Entry generation; eviction, cancellation or retry invalidates older tasks.
    pub generation: u64,
}

/// Read-only lifecycle diagnostics for UI, tracing and tests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidencySnapshot {
    /// Tile address.
    pub key: TileKey,
    /// Detailed asynchronous stage.
    pub stage: ResidencyStage,
    /// Current generation.
    pub generation: u64,
    /// Resources currently retained by this entry.
    pub cost: ResourceCost,
    /// Latest frame in which the tile was drawn or explicitly touched.
    pub last_used_frame: u64,
    /// Latest provider/transport error, if any.
    pub last_error: Option<String>,
}

/// Aggregate lifecycle counts used by diagnostics and scale gates.
///
/// These counts deliberately distinguish live prefetched/decoded work from
/// resident GPU content and failed records. A single total cannot prove that
/// eviction released tombstones without also rejecting useful bounded caches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidencyStageCounts {
    /// Entries that retain neither work nor resources.
    pub unloaded: usize,
    /// Entries with an in-flight content request.
    pub fetching: usize,
    /// Entries waiting for a decoder worker.
    pub queued_decode: usize,
    /// Entries currently being decoded.
    pub decoding: usize,
    /// Decoded entries waiting for an upload budget.
    pub queued_upload: usize,
    /// Entries with GPU copies in flight.
    pub uploading: usize,
    /// Fully resident entries available to draw.
    pub resident: usize,
    /// Failed entries retained for explicit diagnostics or retry.
    pub failed: usize,
}

impl ResidencyStageCounts {
    /// Total number of entries represented by the stage counters.
    #[must_use]
    pub const fn total(self) -> usize {
        self.unloaded
            + self.fetching
            + self.queued_decode
            + self.decoding
            + self.queued_upload
            + self.uploading
            + self.resident
            + self.failed
    }
}

/// One resource set the caller must drop after an eviction decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictedResidency {
    /// Evicted tile.
    pub key: TileKey,
    /// Stage that was cancelled or removed.
    pub previous_stage: ResidencyStage,
    /// Cost removed from manager accounting.
    pub released: ResourceCost,
}

/// Result of enforcing a resource ceiling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictionPlan {
    /// Unpinned resources ordered from least recently used.
    pub evicted: Vec<EvictedResidency>,
    /// Cost still retained after eviction.
    pub remaining_cost: ResourceCost,
    /// False only when currently drawn/pinned content alone exceeds the ceiling.
    pub budget_satisfied: bool,
}

/// Invalid transition or stale asynchronous completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidencyError {
    /// A task completed after its tile was evicted, cancelled or retried.
    StaleTicket,
    /// The requested transition is not legal from the current stage.
    InvalidTransition {
        /// Current stage.
        current: ResidencyStage,
        /// Stage required by the operation.
        expected: ResidencyStage,
    },
}

impl Display for ResidencyError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StaleTicket => formatter.write_str("stale residency task completion"),
            Self::InvalidTransition { current, expected } => write!(
                formatter,
                "invalid residency transition from {current:?}; expected {expected:?}"
            ),
        }
    }
}

impl Error for ResidencyError {}

#[derive(Debug, Clone)]
struct Entry {
    stage: ResidencyStage,
    generation: u64,
    cost: ResourceCost,
    last_used_frame: u64,
    pinned_frame: u64,
    last_error: Option<String>,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            stage: ResidencyStage::Unloaded,
            generation: 0,
            cost: ResourceCost::default(),
            last_used_frame: 0,
            pinned_frame: 0,
            last_error: None,
        }
    }
}

/// Global tile lifecycle shared by every streamed content provider.
#[derive(Debug, Default)]
pub struct ResidencyManager {
    entries: BTreeMap<TileKey, Entry>,
    evictable_lru: BTreeSet<(u64, TileKey)>,
    pinned_keys: BTreeSet<TileKey>,
    total_cost: ResourceCost,
    shared_cost: ResourceCost,
    frame: u64,
    next_generation: u64,
}

impl ResidencyManager {
    /// Creates an empty lifecycle manager.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Advances the frame epoch and pins exactly the fallback-safe draw set.
    ///
    /// Visible but unloaded `wanted` tiles remain admission candidates and do not
    /// pin old resources. Resident parents retained by REPLACE selection are in
    /// `rendered` and therefore cannot be evicted mid-frame.
    pub fn begin_frame(&mut self, rendered: impl IntoIterator<Item = TileKey>) {
        self.frame = self.frame.saturating_add(1).max(1);
        for key in std::mem::take(&mut self.pinned_keys) {
            if let Some(entry) = self.entries.get(&key) {
                self.evictable_lru
                    .insert((entry.last_used_frame, key.clone()));
            }
        }
        for key in rendered {
            if !self.pinned_keys.insert(key.clone()) {
                continue;
            }
            if let Some(entry) = self.entries.get(&key) {
                self.evictable_lru
                    .remove(&(entry.last_used_frame, key.clone()));
            }
            let entry = self.entries.entry(key).or_default();
            entry.pinned_frame = self.frame;
            entry.last_used_frame = self.frame;
        }
    }

    /// Coarse selector-facing state for one tile.
    #[must_use]
    pub fn residency(&self, key: &TileKey) -> TileResidency {
        match self.stage(key) {
            None | Some(ResidencyStage::Unloaded) => TileResidency::Unloaded,
            Some(
                ResidencyStage::Fetching | ResidencyStage::QueuedDecode | ResidencyStage::Decoding,
            ) => TileResidency::Requested,
            Some(ResidencyStage::QueuedUpload | ResidencyStage::Uploading) => {
                TileResidency::Decoded
            }
            Some(ResidencyStage::Resident) => TileResidency::Resident,
            Some(ResidencyStage::Failed) => TileResidency::Failed,
        }
    }

    /// Returns the exact lifecycle stage without cloning diagnostics payloads.
    #[must_use]
    pub fn stage(&self, key: &TileKey) -> Option<ResidencyStage> {
        self.entries.get(key).map(|entry| entry.stage)
    }

    /// Current aggregate retained resource cost.
    #[must_use]
    pub fn total_cost(&self) -> ResourceCost {
        self.total_cost
    }

    /// Globally shared allocations charged independently from tile ownership.
    #[must_use]
    pub fn shared_cost(&self) -> ResourceCost {
        self.shared_cost
    }

    /// Number of live or diagnostically retained lifecycle entries.
    #[must_use]
    pub fn tracked_entries(&self) -> usize {
        self.entries.len()
    }

    /// Counts retained lifecycle entries by exact stage.
    ///
    /// This is an on-demand diagnostics operation, not part of frame planning.
    #[must_use]
    pub fn stage_counts(&self) -> ResidencyStageCounts {
        let mut counts = ResidencyStageCounts::default();
        for entry in self.entries.values() {
            match entry.stage {
                ResidencyStage::Unloaded => counts.unloaded += 1,
                ResidencyStage::Fetching => counts.fetching += 1,
                ResidencyStage::QueuedDecode => counts.queued_decode += 1,
                ResidencyStage::Decoding => counts.decoding += 1,
                ResidencyStage::QueuedUpload => counts.queued_upload += 1,
                ResidencyStage::Uploading => counts.uploading += 1,
                ResidencyStage::Resident => counts.resident += 1,
                ResidencyStage::Failed => counts.failed += 1,
            }
        }
        debug_assert_eq!(counts.total(), self.entries.len());
        debug_assert_eq!(
            self.entries.len(),
            self.evictable_lru.len() + self.pinned_keys.len()
        );
        counts
    }

    /// Replaces global shared-resource accounting without attributing the same
    /// allocation to every tile that references it.
    pub fn set_shared_cost(&mut self, cost: ResourceCost) {
        self.total_cost = self
            .total_cost
            .saturating_sub(self.shared_cost)
            .saturating_add(cost);
        self.shared_cost = cost;
    }

    /// Returns one diagnostics snapshot.
    #[must_use]
    pub fn snapshot(&self, key: &TileKey) -> Option<ResidencySnapshot> {
        self.entries.get(key).map(|entry| ResidencySnapshot {
            key: key.clone(),
            stage: entry.stage,
            generation: entry.generation,
            cost: entry.cost,
            last_used_frame: entry.last_used_frame,
            last_error: entry.last_error.clone(),
        })
    }

    /// Starts a new byte request or explicit retry.
    pub fn start_request(&mut self, key: TileKey) -> Result<ResidencyTicket, ResidencyError> {
        if self.entries.get(&key).is_some_and(|entry| {
            !matches!(
                entry.stage,
                ResidencyStage::Unloaded | ResidencyStage::Failed
            )
        }) {
            let current = self
                .entries
                .get(&key)
                .expect("checked residency entry exists")
                .stage;
            return Err(ResidencyError::InvalidTransition {
                current,
                expected: ResidencyStage::Unloaded,
            });
        }
        let generation = self.allocate_generation();
        let is_new = !self.entries.contains_key(&key);
        let entry = self.entries.entry(key.clone()).or_default();
        entry.generation = generation;
        entry.stage = ResidencyStage::Fetching;
        entry.last_error = None;
        if is_new && !self.pinned_keys.contains(&key) {
            self.evictable_lru
                .insert((entry.last_used_frame, key.clone()));
        }
        Ok(ResidencyTicket { key, generation })
    }

    /// Records fetched compressed bytes and queues decoding.
    pub fn fetched(
        &mut self,
        ticket: &ResidencyTicket,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        self.transition(
            ticket,
            ResidencyStage::Fetching,
            ResidencyStage::QueuedDecode,
            retained_cost,
        )
    }

    /// Claims a queued item for a decoder worker.
    pub fn begin_decode(&mut self, ticket: &ResidencyTicket) -> Result<(), ResidencyError> {
        self.transition_same_cost(
            ticket,
            ResidencyStage::QueuedDecode,
            ResidencyStage::Decoding,
        )
    }

    /// Records decoded CPU resources and queues GPU upload.
    pub fn decoded(
        &mut self,
        ticket: &ResidencyTicket,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        self.transition(
            ticket,
            ResidencyStage::Decoding,
            ResidencyStage::QueuedUpload,
            retained_cost,
        )
    }

    /// Claims decoded resources for a frame-budgeted upload.
    pub fn begin_upload(&mut self, ticket: &ResidencyTicket) -> Result<(), ResidencyError> {
        self.transition_same_cost(
            ticket,
            ResidencyStage::QueuedUpload,
            ResidencyStage::Uploading,
        )
    }

    /// Makes a completely uploaded provider resource available to selection.
    pub fn uploaded(
        &mut self,
        ticket: &ResidencyTicket,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        self.transition(
            ticket,
            ResidencyStage::Uploading,
            ResidencyStage::Resident,
            retained_cost,
        )?;
        let entry = self
            .entries
            .get_mut(&ticket.key)
            .expect("validated ticket retains its entry");
        if !self.pinned_keys.contains(&ticket.key) {
            self.evictable_lru
                .remove(&(entry.last_used_frame, ticket.key.clone()));
        }
        entry.last_used_frame = self.frame;
        if !self.pinned_keys.contains(&ticket.key) {
            self.evictable_lru
                .insert((entry.last_used_frame, ticket.key.clone()));
        }
        Ok(())
    }

    /// Records failure from any live task while invalidating late sibling work.
    pub fn fail(
        &mut self,
        ticket: &ResidencyTicket,
        message: impl Into<String>,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        self.validate_ticket(ticket)?;
        let invalidated_generation = self.allocate_generation();
        let entry = self
            .entries
            .get_mut(&ticket.key)
            .expect("validated ticket retains its entry");
        let previous = entry.cost;
        entry.generation = invalidated_generation;
        entry.stage = ResidencyStage::Failed;
        entry.cost = retained_cost;
        entry.last_error = Some(message.into());
        self.total_cost = self
            .total_cost
            .saturating_sub(previous)
            .saturating_add(retained_cost);
        Ok(())
    }

    /// Cancels and removes one tile, invalidating every outstanding ticket.
    pub fn evict(&mut self, key: &TileKey) -> Option<EvictedResidency> {
        let entry = self.entries.remove(key)?;
        self.evictable_lru
            .remove(&(entry.last_used_frame, key.clone()));
        self.pinned_keys.remove(key);
        let previous_stage = entry.stage;
        let released = entry.cost;
        self.total_cost = self.total_cost.saturating_sub(released);
        Some(EvictedResidency {
            key: key.clone(),
            previous_stage,
            released,
        })
    }

    /// Evicts unpinned resources in LRU order until every budget dimension fits.
    #[must_use]
    pub fn enforce_budget(&mut self, budget: ResourceBudget) -> EvictionPlan {
        if budget.contains(self.total_cost) {
            return EvictionPlan {
                evicted: Vec::new(),
                remaining_cost: self.total_cost,
                budget_satisfied: true,
            };
        }
        let mut evicted = Vec::new();
        while !budget.contains(self.total_cost) {
            let Some((_, key)) = self.evictable_lru.iter().next().cloned() else {
                break;
            };
            if let Some(item) = self.evict(&key) {
                evicted.push(item);
            }
        }
        EvictionPlan {
            evicted,
            remaining_cost: self.total_cost,
            budget_satisfied: budget.contains(self.total_cost),
        }
    }

    /// Evicts unpinned LRU cache entries until one higher-priority admission
    /// can fit alongside the resources it already retains.
    ///
    /// Merely being within the current budget is not sufficient during camera
    /// movement: a full cache must still be replaceable by newly visible work.
    /// The candidate itself is protected because a queued upload already owns
    /// decoded bytes that form part of the current baseline. Frame-pinned
    /// fallback content is never removed here.
    pub fn evict_lru_for_admission(
        &mut self,
        budget: ResourceBudget,
        additional_cost: ResourceCost,
        protected: &TileKey,
    ) -> Vec<EvictedResidency> {
        if budget.contains(self.total_cost.saturating_add(additional_cost))
            || !budget.contains(additional_cost)
        {
            return Vec::new();
        }
        let mut evicted = Vec::new();
        while !budget.contains(self.total_cost.saturating_add(additional_cost)) {
            let combined = self.total_cost.saturating_add(additional_cost);
            let Some((_, key)) = self
                .evictable_lru
                .iter()
                .fold(
                    None::<(&(u64, TileKey), u8)>,
                    |best, candidate @ (_, key)| {
                        if key == protected {
                            return best;
                        }
                        let score = self.entries.get(key).map_or(0, |entry| {
                            over_budget_relief_score(entry.cost, combined, budget)
                        });
                        if score == 0 || best.is_some_and(|(_, best_score)| best_score >= score) {
                            best
                        } else {
                            Some((candidate, score))
                        }
                    },
                )
                .map(|(entry, _)| entry.clone())
            else {
                break;
            };
            if let Some(item) = self.evict(&key) {
                evicted.push(item);
            }
        }
        evicted
    }

    /// Removes every entry belonging to a detached dataset.
    pub fn remove_dataset(&mut self, dataset_id: &crate::DatasetId) -> Vec<EvictedResidency> {
        let keys: Vec<_> = self
            .entries
            .keys()
            .filter(|key| &key.dataset_id == dataset_id)
            .cloned()
            .collect();
        keys.iter().filter_map(|key| self.evict(key)).collect()
    }

    fn transition_same_cost(
        &mut self,
        ticket: &ResidencyTicket,
        expected: ResidencyStage,
        next: ResidencyStage,
    ) -> Result<(), ResidencyError> {
        let cost = self.valid_entry(ticket)?.cost;
        self.transition(ticket, expected, next, cost)
    }

    fn transition(
        &mut self,
        ticket: &ResidencyTicket,
        expected: ResidencyStage,
        next: ResidencyStage,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        let entry = self.valid_entry(ticket)?;
        if entry.stage != expected {
            return Err(ResidencyError::InvalidTransition {
                current: entry.stage,
                expected,
            });
        }
        let previous = entry.cost;
        entry.stage = next;
        entry.cost = retained_cost;
        self.total_cost = self
            .total_cost
            .saturating_sub(previous)
            .saturating_add(retained_cost);
        Ok(())
    }

    fn valid_entry(&mut self, ticket: &ResidencyTicket) -> Result<&mut Entry, ResidencyError> {
        self.validate_ticket(ticket)?;
        Ok(self
            .entries
            .get_mut(&ticket.key)
            .expect("validated ticket retains its entry"))
    }

    fn validate_ticket(&self, ticket: &ResidencyTicket) -> Result<(), ResidencyError> {
        let entry = self
            .entries
            .get(&ticket.key)
            .ok_or(ResidencyError::StaleTicket)?;
        if entry.generation != ticket.generation {
            return Err(ResidencyError::StaleTicket);
        }
        Ok(())
    }

    fn allocate_generation(&mut self) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        self.next_generation
    }
}

fn over_budget_relief_score(
    cost: ResourceCost,
    combined: ResourceCost,
    budget: ResourceBudget,
) -> u8 {
    [
        combined.cpu_compressed_bytes > budget.cpu_compressed_bytes
            && cost.cpu_compressed_bytes > 0,
        combined.cpu_decoded_bytes > budget.cpu_decoded_bytes && cost.cpu_decoded_bytes > 0,
        combined.gpu_buffer_bytes > budget.gpu_buffer_bytes && cost.gpu_buffer_bytes > 0,
        combined.gpu_texture_bytes > budget.gpu_texture_bytes && cost.gpu_texture_bytes > 0,
        combined.staging_bytes > budget.staging_bytes && cost.staging_bytes > 0,
        combined.points > budget.points && cost.points > 0,
        combined.triangles > budget.triangles && cost.triangles > 0,
        combined.splats > budget.splats && cost.splats > 0,
        combined.draw_calls > budget.draw_calls && cost.draw_calls > 0,
    ]
    .into_iter()
    .map(u8::from)
    .sum()
}

/// Provider-independent cost estimate used before content bytes are decoded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileLoadEstimate {
    /// Complete approximate residency cost.
    pub cost: ResourceCost,
    /// Approximate decoder time used only for admission throttling.
    pub decode_ms: f32,
    /// Approximate bytes copied to GPU resources.
    pub upload_bytes: u64,
}

/// Builds one admission candidate from hierarchy metadata and current lifecycle.
///
/// Failed tiles require an explicit retry and are intentionally not returned.
#[must_use]
pub fn admission_candidate(tile: &SelectedTile) -> Option<AdmissionCandidate> {
    admission_candidate_with_residency(tile, tile.residency)
}

/// Builds an admission candidate using authoritative runtime residency without
/// copying the selected tile or its shared provider descriptor.
#[must_use]
pub fn admission_candidate_with_residency(
    tile: &SelectedTile,
    residency: TileResidency,
) -> Option<AdmissionCandidate> {
    let estimate = estimate_tile_load(tile);
    let (cost, decode_ms, upload_bytes, starts_request) = match residency {
        TileResidency::Unloaded => (
            estimate.cost,
            estimate.decode_ms,
            estimate.upload_bytes,
            true,
        ),
        TileResidency::Decoded => (
            ResourceCost {
                gpu_buffer_bytes: estimate.cost.gpu_buffer_bytes,
                gpu_texture_bytes: estimate.cost.gpu_texture_bytes,
                staging_bytes: estimate.cost.staging_bytes,
                points: estimate.cost.points,
                triangles: estimate.cost.triangles,
                splats: estimate.cost.splats,
                draw_calls: estimate.cost.draw_calls,
                ..ResourceCost::default()
            },
            0.0,
            estimate.upload_bytes,
            false,
        ),
        TileResidency::Requested | TileResidency::Resident | TileResidency::Failed => return None,
    };
    Some(AdmissionCandidate {
        key: tile.key.clone(),
        benefit: tile.screen_space_error.max(0.0),
        cost,
        decode_ms,
        upload_bytes,
        starts_request,
    })
}

/// Estimates resource dimensions conservatively from hierarchy metadata.
#[must_use]
pub fn estimate_tile_load(tile: &SelectedTile) -> TileLoadEstimate {
    const MEBIBYTE: u64 = 1_048_576;
    let mut cost = ResourceCost::default();
    let mut upload_bytes = 0_u64;
    for content in &tile.descriptor.contents {
        let primitive_count = content.primitive_count.unwrap_or_else(|| {
            content
                .byte_length
                .unwrap_or(MEBIBYTE)
                .saturating_div(24)
                .max(1)
        });
        let compressed = content.byte_length.unwrap_or_else(|| match content.kind {
            ContentKind::PotreePoints => primitive_count.saturating_mul(16),
            ContentKind::Gltf | ContentKind::ThreeDTilesContainer => {
                primitive_count.saturating_mul(24)
            }
            ContentKind::Raster => primitive_count.saturating_mul(2),
            ContentKind::GaussianSplats => primitive_count.saturating_mul(20),
            ContentKind::CadProxy => primitive_count.saturating_mul(24),
        });
        cost.cpu_compressed_bytes = cost.cpu_compressed_bytes.saturating_add(compressed);
        match content.kind {
            ContentKind::PotreePoints => {
                let gpu = primitive_count.saturating_mul(GPU_POINT_VERTEX_STRIDE_BYTES);
                cost.cpu_decoded_bytes = cost
                    .cpu_decoded_bytes
                    .saturating_add(primitive_count.saturating_mul(16));
                cost.gpu_buffer_bytes = cost.gpu_buffer_bytes.saturating_add(gpu);
                cost.points = cost.points.saturating_add(primitive_count);
                upload_bytes = upload_bytes.saturating_add(gpu);
            }
            ContentKind::Gltf | ContentKind::ThreeDTilesContainer | ContentKind::CadProxy => {
                let gpu = primitive_count.saturating_mul(3).saturating_mul(32);
                cost.cpu_decoded_bytes = cost.cpu_decoded_bytes.saturating_add(gpu);
                cost.gpu_buffer_bytes = cost.gpu_buffer_bytes.saturating_add(gpu);
                cost.triangles = cost.triangles.saturating_add(primitive_count);
                upload_bytes = upload_bytes.saturating_add(gpu);
            }
            ContentKind::Raster => {
                let texture = primitive_count.saturating_mul(4).saturating_mul(4) / 3;
                cost.cpu_decoded_bytes = cost
                    .cpu_decoded_bytes
                    .saturating_add(primitive_count.saturating_mul(4));
                cost.gpu_texture_bytes = cost.gpu_texture_bytes.saturating_add(texture);
                upload_bytes = upload_bytes.saturating_add(texture);
            }
            ContentKind::GaussianSplats => {
                let gpu = primitive_count.saturating_mul(32);
                cost.cpu_decoded_bytes = cost.cpu_decoded_bytes.saturating_add(gpu);
                cost.gpu_buffer_bytes = cost.gpu_buffer_bytes.saturating_add(gpu);
                cost.splats = cost.splats.saturating_add(primitive_count);
                upload_bytes = upload_bytes.saturating_add(gpu);
            }
        }
        cost.draw_calls = cost.draw_calls.saturating_add(1);
    }
    cost.staging_bytes = upload_bytes.min(64 * MEBIBYTE);
    let bounded_compressed = cost.cpu_compressed_bytes.min(64 * MEBIBYTE);
    let whole_mib = u32::try_from(bounded_compressed / MEBIBYTE).unwrap_or(64);
    let remaining_bytes = u32::try_from(bounded_compressed % MEBIBYTE).unwrap_or(0);
    let compressed_mib = f64::from(whole_mib) + f64::from(remaining_bytes) / 1_048_576.0;
    #[allow(clippy::cast_possible_truncation)]
    let decode_ms = (compressed_mib * 0.35).clamp(0.05, 20.0) as f32;
    TileLoadEstimate {
        cost,
        decode_ms,
        upload_bytes,
    }
}

/// Returns keys present in `wanted` but not currently participating in work.
#[must_use]
pub fn idle_wanted_keys(manager: &ResidencyManager, wanted: &[SelectedTile]) -> BTreeSet<TileKey> {
    wanted
        .iter()
        .filter(|tile| manager.residency(&tile.key) == TileResidency::Unloaded)
        .map(|tile| tile.key.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{estimate_tile_load, ResidencyError, ResidencyManager, ResidencyStage};
    use crate::{
        BoundingVolume, ContentKind, ContentReference, DatasetId, RefinementMode, ResourceBudget,
        ResourceCost, SelectedTile, TileDescriptor, TileId, TileKey, TileResidency, WorldAabb,
        WorldTransform, WorldVec3, GPU_POINT_VERTEX_STRIDE_BYTES,
    };

    fn key(name: &str) -> TileKey {
        TileKey {
            dataset_id: DatasetId("dataset".to_owned()),
            tile_id: TileId(name.to_owned()),
        }
    }

    fn cost(bytes: u64) -> ResourceCost {
        ResourceCost {
            gpu_buffer_bytes: bytes,
            ..ResourceCost::default()
        }
    }

    fn budget(bytes: u64) -> ResourceBudget {
        ResourceBudget {
            cpu_compressed_bytes: u64::MAX,
            cpu_decoded_bytes: u64::MAX,
            gpu_buffer_bytes: bytes,
            gpu_texture_bytes: u64::MAX,
            staging_bytes: u64::MAX,
            points: u64::MAX,
            triangles: u64::MAX,
            splats: u64::MAX,
            draw_calls: u32::MAX,
        }
    }

    fn make_resident(manager: &mut ResidencyManager, tile: TileKey, bytes: u64) {
        make_resident_with_cost(manager, tile, cost(bytes));
    }

    fn make_resident_with_cost(
        manager: &mut ResidencyManager,
        tile: TileKey,
        resident_cost: ResourceCost,
    ) {
        let ticket = manager.start_request(tile).expect("start");
        manager.fetched(&ticket, cost(10)).expect("fetched");
        manager.begin_decode(&ticket).expect("decode");
        manager.decoded(&ticket, cost(20)).expect("decoded");
        manager.begin_upload(&ticket).expect("upload");
        manager.uploaded(&ticket, resident_cost).expect("resident");
    }

    #[test]
    fn potree_tile_estimate_uses_uploaded_stride_without_changing_cpu_estimates() {
        let point_count = 10;
        let source_bytes = 900;
        let key = key("potree-cost");
        let tile = SelectedTile {
            key: key.clone(),
            screen_space_error: 1.0,
            residency: TileResidency::Unloaded,
            descriptor: std::sync::Arc::new(TileDescriptor {
                id: key.tile_id,
                parent: None,
                children: Vec::new(),
                bounds: BoundingVolume::AxisAlignedBox {
                    bounds: WorldAabb {
                        min: WorldVec3 {
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        max: WorldVec3 {
                            x: 1.0,
                            y: 1.0,
                            z: 1.0,
                        },
                    },
                },
                content_transform: WorldTransform::IDENTITY,
                geometric_error: 1.0,
                refinement: RefinementMode::Add,
                contents: vec![ContentReference {
                    kind: ContentKind::PotreePoints,
                    uri: "https://example.invalid/octree.bin".to_owned(),
                    byte_offset: Some(0),
                    byte_length: Some(source_bytes),
                    primitive_count: Some(point_count),
                    content_hash: None,
                    decoder_parameters: None,
                }],
                child_page: None,
                provider_metadata: None,
            }),
        };

        let estimate = estimate_tile_load(&tile);
        assert_eq!(estimate.cost.cpu_compressed_bytes, source_bytes);
        assert_eq!(estimate.cost.cpu_decoded_bytes, point_count * 16);
        assert_eq!(
            estimate.cost.gpu_buffer_bytes,
            point_count * GPU_POINT_VERTEX_STRIDE_BYTES
        );
        assert_eq!(estimate.upload_bytes, estimate.cost.gpu_buffer_bytes);
    }

    #[test]
    fn asynchronous_stages_account_snapshots_without_double_counting() {
        let mut manager = ResidencyManager::new();
        let tile = key("root");
        let ticket = manager.start_request(tile.clone()).expect("start");
        manager.fetched(&ticket, cost(10)).expect("fetched");
        manager.begin_decode(&ticket).expect("decode");
        manager.decoded(&ticket, cost(20)).expect("decoded");
        assert_eq!(manager.total_cost(), cost(20));
        assert_eq!(manager.residency(&tile), TileResidency::Decoded);
        manager.begin_upload(&ticket).expect("upload");
        manager.uploaded(&ticket, cost(30)).expect("resident");

        assert_eq!(manager.total_cost(), cost(30));
        assert_eq!(
            manager.snapshot(&tile).expect("snapshot").stage,
            ResidencyStage::Resident
        );
    }

    #[test]
    fn eviction_invalidates_late_async_completion() {
        let mut manager = ResidencyManager::new();
        let tile = key("root");
        let ticket = manager.start_request(tile.clone()).expect("start");
        manager.fetched(&ticket, cost(10)).expect("fetched");
        manager.evict(&tile).expect("evicted");

        assert_eq!(
            manager.begin_decode(&ticket),
            Err(ResidencyError::StaleTicket)
        );
        assert!(manager.snapshot(&tile).is_none());

        let replacement = manager.start_request(tile).expect("restart");
        assert_ne!(replacement.generation, ticket.generation);
        assert_eq!(
            manager.begin_decode(&ticket),
            Err(ResidencyError::StaleTicket)
        );
    }

    #[test]
    fn failure_invalidates_sibling_completion_and_retry_uses_new_generation() {
        let mut manager = ResidencyManager::new();
        let tile = key("retry");
        let first = manager.start_request(tile.clone()).expect("start");
        manager
            .fail(&first, "decode rejected", cost(12))
            .expect("fail live request");
        assert_eq!(
            manager.begin_decode(&first),
            Err(ResidencyError::StaleTicket)
        );
        assert_eq!(manager.total_cost(), cost(12));

        let retry = manager.start_request(tile).expect("retry");
        assert_ne!(retry.generation, first.generation);
        assert_eq!(
            manager.begin_decode(&first),
            Err(ResidencyError::StaleTicket)
        );
    }

    #[test]
    fn long_navigation_does_not_retain_evicted_tile_tombstones() {
        let mut manager = ResidencyManager::new();
        let mut last_generation = 0;
        for index in 0..100_000 {
            let tile = key(&format!("corridor-{index}"));
            let ticket = manager.start_request(tile.clone()).expect("start tile");
            assert!(ticket.generation > last_generation);
            last_generation = ticket.generation;
            manager.evict(&tile).expect("evict tile");
        }
        assert_eq!(manager.tracked_entries(), 0);
        assert_eq!(manager.stage_counts().total(), 0);
        assert_eq!(manager.total_cost(), ResourceCost::default());
    }

    #[test]
    fn budget_evicts_lru_but_never_current_render_fallback() {
        let mut manager = ResidencyManager::new();
        let old = key("old");
        let fallback = key("fallback");
        make_resident(&mut manager, old.clone(), 100);
        manager.begin_frame([old.clone()]);
        make_resident(&mut manager, fallback.clone(), 100);
        manager.begin_frame([fallback.clone()]);

        let plan = manager.enforce_budget(budget(100));

        assert!(plan.budget_satisfied);
        assert_eq!(plan.evicted.len(), 1);
        assert_eq!(plan.evicted[0].key, old);
        assert_eq!(manager.residency(&fallback), TileResidency::Resident);
    }

    #[test]
    fn full_cache_makes_room_for_new_visible_admission_without_touching_pinned_fallback() {
        let mut manager = ResidencyManager::new();
        let stale = key("stale-cache");
        let fallback = key("visible-fallback");
        let wanted = key("new-visible");
        make_resident(&mut manager, stale.clone(), 100);
        manager.begin_frame([]);

        let evicted = manager.evict_lru_for_admission(budget(100), cost(100), &wanted);

        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].key, stale);
        assert_eq!(manager.total_cost(), ResourceCost::default());

        make_resident(&mut manager, fallback.clone(), 100);
        manager.begin_frame([fallback.clone()]);
        assert!(manager
            .evict_lru_for_admission(budget(100), cost(100), &wanted)
            .is_empty());
        assert_eq!(manager.residency(&fallback), TileResidency::Resident);
    }

    #[test]
    fn admission_evicts_content_that_relaxes_the_constrained_resource_dimension() {
        let mut manager = ResidencyManager::new();
        let mesh = key("a-old-mesh");
        let points = key("z-newer-points");
        make_resident_with_cost(
            &mut manager,
            mesh.clone(),
            ResourceCost {
                triangles: 100,
                draw_calls: 1,
                ..ResourceCost::default()
            },
        );
        make_resident_with_cost(
            &mut manager,
            points.clone(),
            ResourceCost {
                points: 100,
                draw_calls: 1,
                ..ResourceCost::default()
            },
        );
        let mut resource_budget = budget(u64::MAX);
        resource_budget.points = 100;
        resource_budget.draw_calls = 3;
        let wanted = key("replacement-points");
        let evicted = manager.evict_lru_for_admission(
            resource_budget,
            ResourceCost {
                points: 100,
                draw_calls: 1,
                ..ResourceCost::default()
            },
            &wanted,
        );

        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].key, points);
        assert_eq!(manager.residency(&mesh), TileResidency::Resident);
    }

    #[test]
    fn shared_cost_is_global_and_never_subtracted_with_one_tile() {
        let mut manager = ResidencyManager::new();
        let first = key("first");
        let second = key("second");
        make_resident(&mut manager, first.clone(), 40);
        make_resident(&mut manager, second, 40);
        manager.set_shared_cost(cost(60));
        assert_eq!(manager.total_cost(), cost(140));
        assert_eq!(manager.shared_cost(), cost(60));

        manager.evict(&first).expect("first resident tile");
        assert_eq!(manager.total_cost(), cost(100));
        manager.set_shared_cost(ResourceCost::default());
        assert_eq!(manager.total_cost(), cost(40));
    }
}
