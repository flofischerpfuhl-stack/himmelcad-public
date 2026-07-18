//! Executable provider-neutral streaming lifecycle and frame orchestration.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::{
    admission_candidate_with_residency, estimate_tile_load, AdmissionPlan, AdmissionPlanner,
    EvictionPlan, FrameBudget, HierarchyPageRequest, ResidencyError, ResidencyManager,
    ResidencyStage, ResidencyTicket, ResourceBudget, ResourceCost, SelectedTile, TileKey,
    TileLoadEstimate, TileResidency, TileSelection,
};

/// Per-dataset admission frontier kept beyond the current frame's request
/// allowance. At 60 Hz this retains roughly one second of look-ahead while
/// preventing enormous visible hierarchies from producing enormous JSON plans.
const ADMISSION_LOOKAHEAD_FRAMES: usize = 64;

/// One bounded host operation emitted by the shared streaming coordinator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamingAction {
    /// Fetch every content reference needed to make one tile complete.
    FetchTile {
        /// Generation-bearing completion authority.
        ticket: ResidencyTicket,
        /// Provider descriptor retained for bounds, transform and all payloads.
        descriptor: Box<crate::TileDescriptor>,
    },
    /// Decode previously fetched bytes on an available worker.
    DecodeTile {
        /// Generation-bearing completion authority.
        ticket: ResidencyTicket,
    },
    /// Upload decoded resources under the current frame upload budget.
    UploadTile {
        /// Generation-bearing completion authority.
        ticket: ResidencyTicket,
    },
    /// Fetch a lazy provider hierarchy page before later traversal.
    FetchHierarchyPage {
        /// Provider page request, deduplicated until success or failure.
        request: HierarchyPageRequest,
    },
    /// Drop CPU/GPU resources and cancel every task bearing an older ticket.
    EvictTile {
        /// Tile whose provider-owned payloads must be released.
        key: TileKey,
    },
}

/// Deterministic work and draw decision for one mixed-dataset frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingFramePlan {
    /// Resident ADD/REPLACE-safe fallback set to draw this frame.
    pub render: Vec<TileKey>,
    /// Host operations in cancellation-safe execution order.
    pub actions: Vec<StreamingAction>,
    /// Shared cross-dataset admission decision.
    pub admission: AdmissionPlan,
    /// LRU resources removed before admitting new work.
    pub eviction: EvictionPlan,
    /// Estimated decoder time claimed by already fetched content.
    pub claimed_decode_ms: f32,
}

/// Runtime concurrency ceilings for provider I/O and CPU decoding.
///
/// Replacing this value never resets residency or invalidates live tickets.
/// Work already in flight is allowed to finish after a lower ceiling is
/// installed; only new fetch and decode claims are held back. Both ceilings
/// are kept at one or greater so a coordinator cannot deadlock permanently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingRuntimeLimits {
    /// Maximum simultaneous tile-content and lazy-hierarchy fetches.
    pub content_requests: usize,
    /// Maximum simultaneous decoder tasks in the `Decoding` stage.
    pub decoder_workers: usize,
}

impl StreamingRuntimeLimits {
    /// Creates normalized non-zero runtime ceilings.
    #[must_use]
    pub const fn new(decoder_workers: usize, content_requests: usize) -> Self {
        Self {
            content_requests: if content_requests == 0 {
                1
            } else {
                content_requests
            },
            decoder_workers: if decoder_workers == 0 {
                1
            } else {
                decoder_workers
            },
        }
    }
}

/// Shared runtime joining selection, fairness, residency and asynchronous work.
#[derive(Debug)]
pub struct StreamingCoordinator {
    residency: ResidencyManager,
    admission: AdmissionPlanner,
    tickets: BTreeMap<TileKey, ResidencyTicket>,
    estimates: BTreeMap<TileKey, TileLoadEstimate>,
    fetching: BTreeSet<TileKey>,
    queued_decodes: BTreeSet<TileKey>,
    decoding: BTreeSet<TileKey>,
    hierarchy_requests: BTreeSet<TileKey>,
    runtime_limits: StreamingRuntimeLimits,
}

impl Default for StreamingCoordinator {
    fn default() -> Self {
        Self::new(2)
    }
}

impl StreamingCoordinator {
    /// Creates a coordinator with a host-selected decode-worker ceiling.
    #[must_use]
    pub fn new(maximum_concurrent_decodes: usize) -> Self {
        Self {
            residency: ResidencyManager::new(),
            admission: AdmissionPlanner::new(),
            tickets: BTreeMap::new(),
            estimates: BTreeMap::new(),
            fetching: BTreeSet::new(),
            queued_decodes: BTreeSet::new(),
            decoding: BTreeSet::new(),
            hierarchy_requests: BTreeSet::new(),
            runtime_limits: StreamingRuntimeLimits::new(
                maximum_concurrent_decodes,
                usize::from(u16::MAX),
            ),
        }
    }

    /// Returns the bounded per-dataset unloaded-candidate frontier for one
    /// frame request allowance. This affects scheduling latency, never
    /// visibility, resident fallback coverage or eventual reachable detail.
    #[must_use]
    pub fn unloaded_candidate_limit(new_request_budget: u16) -> usize {
        usize::from(new_request_budget.max(1)).saturating_mul(ADMISSION_LOOKAHEAD_FRAMES)
    }

    /// Current I/O and decode concurrency ceilings.
    #[must_use]
    pub const fn runtime_limits(&self) -> StreamingRuntimeLimits {
        self.runtime_limits
    }

    /// Atomically replaces both concurrency ceilings without resetting
    /// residency, tickets, fairness state, or work already in flight.
    pub fn set_runtime_limits(&mut self, limits: StreamingRuntimeLimits) {
        self.runtime_limits =
            StreamingRuntimeLimits::new(limits.decoder_workers, limits.content_requests);
    }

    /// Number of tile-content and hierarchy-page requests currently occupying
    /// runtime I/O slots.
    #[must_use]
    pub fn in_flight_content_requests(&self) -> usize {
        self.in_flight_tile_content_requests()
            .saturating_add(self.hierarchy_requests.len())
    }

    fn in_flight_tile_content_requests(&self) -> usize {
        self.fetching.len()
    }

    /// Number of decoder tasks currently occupying a runtime worker slot.
    #[must_use]
    pub fn active_decodes(&self) -> usize {
        self.decoding.len()
    }

    /// Read-only global lifecycle used by selectors and diagnostics.
    #[must_use]
    pub fn residency(&self) -> &ResidencyManager {
        &self.residency
    }

    /// Plans one frame across every provider selection under one resource policy.
    pub fn plan_frame(
        &mut self,
        selections: &[TileSelection],
        resource_budget: ResourceBudget,
        frame_budget: FrameBudget,
    ) -> Result<StreamingFramePlan, ResidencyError> {
        self.plan_frame_with_auxiliary(selections, &[], resource_budget, frame_budget)
    }

    /// Plans one frame while retaining auxiliary consumer residency without
    /// exposing those consumers through the primary draw set.
    ///
    /// Primary and auxiliary selections share hierarchy requests, admission,
    /// decode, upload and eviction state. Duplicate tile demand is coalesced by
    /// its highest screen-space error. Only primary fallback-safe tiles are
    /// returned in [`StreamingFramePlan::render`]; both draw sets are pinned for
    /// the frame so an auxiliary view cannot lose resident fallback content.
    pub fn plan_frame_with_auxiliary(
        &mut self,
        primary: &[TileSelection],
        auxiliary: &[TileSelection],
        resource_budget: ResourceBudget,
        frame_budget: FrameBudget,
    ) -> Result<StreamingFramePlan, ResidencyError> {
        let render = primary
            .iter()
            .flat_map(|selection| selection.render.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let active_render = primary
            .iter()
            .chain(auxiliary)
            .flat_map(|selection| selection.render.iter().cloned())
            .collect::<BTreeSet<_>>();
        let wanted = coalesce_wanted(primary, auxiliary);
        self.residency.begin_frame(active_render);
        let (mut eviction, mut actions) = self.evict_to_budget(resource_budget);
        if let Some(candidate) = wanted
            .iter()
            .copied()
            .filter(|tile| {
                matches!(
                    self.residency.residency(&tile.key),
                    TileResidency::Unloaded | TileResidency::Decoded
                )
            })
            .max_by(|left, right| selected_tile_priority(left, right))
            .and_then(|tile| {
                admission_candidate_with_residency(tile, self.residency.residency(&tile.key))
            })
        {
            let replacement_evictions = self.residency.evict_lru_for_admission(
                resource_budget,
                candidate.cost,
                &candidate.key,
            );
            for evicted in replacement_evictions {
                self.forget_tile(&evicted.key);
                actions.push(StreamingAction::EvictTile {
                    key: evicted.key.clone(),
                });
                eviction.evicted.push(evicted);
            }
            eviction.remaining_cost = self.residency.total_cost();
            eviction.budget_satisfied = resource_budget.contains(eviction.remaining_cost);
        }
        let hierarchy_actions =
            self.claim_hierarchy_pages(primary, auxiliary, usize::from(frame_budget.new_requests));
        let hierarchy_requests_started = u16::try_from(hierarchy_actions.len())
            .expect("hierarchy claims are bounded by the u16 frame request limit");
        actions.extend(hierarchy_actions);
        let (decode_actions, claimed_decode_ms) = self.claim_decodes(frame_budget.decode_ms)?;
        actions.extend(decode_actions);
        let remaining_frame_budget = FrameBudget {
            decode_ms: (frame_budget.decode_ms - claimed_decode_ms).max(0.0),
            new_requests: frame_budget
                .new_requests
                .saturating_sub(hierarchy_requests_started),
            ..frame_budget
        };
        let (admission, admission_actions) =
            self.admit(&wanted, resource_budget, remaining_frame_budget)?;
        actions.extend(admission_actions);

        Ok(StreamingFramePlan {
            render,
            actions,
            admission,
            eviction,
            claimed_decode_ms,
        })
    }

    fn evict_to_budget(
        &mut self,
        resource_budget: ResourceBudget,
    ) -> (EvictionPlan, Vec<StreamingAction>) {
        let eviction = self.residency.enforce_budget(resource_budget);
        let mut actions = Vec::with_capacity(eviction.evicted.len());
        for evicted in &eviction.evicted {
            self.forget_tile(&evicted.key);
            actions.push(StreamingAction::EvictTile {
                key: evicted.key.clone(),
            });
        }
        (eviction, actions)
    }

    fn claim_hierarchy_pages(
        &mut self,
        primary: &[TileSelection],
        auxiliary: &[TileSelection],
        maximum_new_requests: usize,
    ) -> Vec<StreamingAction> {
        let mut actions = Vec::new();
        let mut available_slots = self
            .runtime_limits
            .content_requests
            .saturating_sub(self.in_flight_content_requests())
            .min(maximum_new_requests);
        for request in primary
            .iter()
            .chain(auxiliary)
            .flat_map(|selection| &selection.hierarchy_pages)
        {
            if available_slots == 0 {
                break;
            }
            if self.hierarchy_requests.insert(request.owner.clone()) {
                actions.push(StreamingAction::FetchHierarchyPage {
                    request: request.clone(),
                });
                available_slots -= 1;
            }
        }
        actions
    }

    fn claim_decodes(
        &mut self,
        decode_budget_ms: f32,
    ) -> Result<(Vec<StreamingAction>, f32), ResidencyError> {
        let available_workers = self
            .runtime_limits
            .decoder_workers
            .saturating_sub(self.decoding.len());
        let queued = self
            .queued_decodes
            .iter()
            .filter_map(|key| {
                let ticket = self.tickets.get(key)?;
                let estimate = self
                    .estimates
                    .get(key)
                    .copied()
                    .unwrap_or(TileLoadEstimate {
                        cost: ResourceCost::default(),
                        decode_ms: 0.05,
                        upload_bytes: 0,
                    });
                Some((key.clone(), ticket.clone(), estimate.decode_ms))
            })
            .collect::<Vec<_>>();
        let mut claimed_ms = 0.0_f32;
        let mut actions = Vec::new();
        for (key, ticket, decode_ms) in queued.into_iter().take(available_workers) {
            if claimed_ms + decode_ms > decode_budget_ms {
                continue;
            }
            self.residency.begin_decode(&ticket)?;
            self.queued_decodes.remove(&key);
            self.decoding.insert(key);
            claimed_ms += decode_ms;
            actions.push(StreamingAction::DecodeTile { ticket });
        }
        Ok((actions, claimed_ms))
    }

    fn admit(
        &mut self,
        wanted: &[&SelectedTile],
        resource_budget: ResourceBudget,
        frame_budget: FrameBudget,
    ) -> Result<(AdmissionPlan, Vec<StreamingAction>), ResidencyError> {
        let available_content_requests = self
            .runtime_limits
            .content_requests
            .saturating_sub(self.in_flight_content_requests());
        let frame_budget = FrameBudget {
            new_requests: frame_budget
                .new_requests
                .min(u16::try_from(available_content_requests).unwrap_or(u16::MAX)),
            ..frame_budget
        };
        let candidates = self.bounded_admission_candidates(wanted, frame_budget.new_requests);
        let admission = self.admission.plan(
            self.residency.total_cost(),
            resource_budget,
            frame_budget,
            candidates,
        );
        let mut actions = Vec::new();
        for key in &admission.admitted {
            let tile = wanted
                .iter()
                .copied()
                .find(|tile| tile.key == *key)
                .expect("admission candidates originate in the coalesced wanted set");
            match self
                .residency
                .stage(key)
                .unwrap_or(ResidencyStage::Unloaded)
            {
                ResidencyStage::Unloaded | ResidencyStage::Failed => {
                    let ticket = self.residency.start_request(key.clone())?;
                    self.estimates.insert(key.clone(), estimate_tile_load(tile));
                    self.tickets.insert(key.clone(), ticket.clone());
                    self.fetching.insert(key.clone());
                    actions.push(StreamingAction::FetchTile {
                        ticket,
                        descriptor: Box::new(tile.descriptor.as_ref().clone()),
                    });
                }
                ResidencyStage::QueuedUpload => {
                    let ticket = self
                        .tickets
                        .get(key)
                        .expect("queued upload retains its live ticket")
                        .clone();
                    self.residency.begin_upload(&ticket)?;
                    actions.push(StreamingAction::UploadTile { ticket });
                }
                _ => {}
            }
        }
        Ok((admission, actions))
    }

    fn bounded_admission_candidates(
        &self,
        wanted: &[&SelectedTile],
        new_request_budget: u16,
    ) -> Vec<crate::AdmissionCandidate> {
        let per_dataset_limit = Self::unloaded_candidate_limit(new_request_budget);
        let mut decoded = Vec::<&SelectedTile>::new();
        let mut unloaded = BTreeMap::<&crate::DatasetId, Vec<&SelectedTile>>::new();
        for tile in wanted.iter().copied() {
            let residency = self.residency.residency(&tile.key);
            match residency {
                TileResidency::Decoded => decoded.push(tile),
                TileResidency::Unloaded => {
                    unloaded.entry(&tile.key.dataset_id).or_default().push(tile)
                }
                TileResidency::Requested | TileResidency::Resident | TileResidency::Failed => {}
            }
        }
        for group in unloaded.values_mut() {
            if group.len() > per_dataset_limit {
                group.select_nth_unstable_by(per_dataset_limit, |left, right| {
                    selected_tile_priority(right, left)
                });
                group.truncate(per_dataset_limit);
            }
        }
        decoded
            .into_iter()
            .map(|tile| (tile, TileResidency::Decoded))
            .chain(
                unloaded
                    .into_values()
                    .flatten()
                    .map(|tile| (tile, TileResidency::Unloaded)),
            )
            .filter_map(|(tile, residency)| admission_candidate_with_residency(tile, residency))
            .collect()
    }

    /// Advances a live request to the decoder queue using actual retained cost.
    pub fn fetched(
        &mut self,
        ticket: &ResidencyTicket,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        self.residency.fetched(ticket, retained_cost)?;
        self.fetching.remove(&ticket.key);
        self.queued_decodes.insert(ticket.key.clone());
        Ok(())
    }

    /// Advances a claimed decoder task to the frame-budgeted upload queue.
    pub fn decoded(
        &mut self,
        ticket: &ResidencyTicket,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        let result = self.residency.decoded(ticket, retained_cost);
        if result.is_ok() {
            self.decoding.remove(&ticket.key);
        }
        result
    }

    /// Publishes a completely uploaded tile for the next selector traversal.
    pub fn uploaded(
        &mut self,
        ticket: &ResidencyTicket,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        self.residency.uploaded(ticket, retained_cost)
    }

    /// Synchronizes globally deduplicated allocations owned outside tile entries.
    pub fn set_shared_resource_cost(&mut self, cost: ResourceCost) {
        self.residency.set_shared_cost(cost);
    }

    /// Records a task failure and frees its decode-worker slot for other data.
    pub fn failed(
        &mut self,
        ticket: &ResidencyTicket,
        message: impl Into<String>,
        retained_cost: ResourceCost,
    ) -> Result<(), ResidencyError> {
        let result = self.residency.fail(ticket, message, retained_cost);
        if result.is_ok() {
            self.fetching.remove(&ticket.key);
            self.queued_decodes.remove(&ticket.key);
            self.decoding.remove(&ticket.key);
        }
        result
    }

    /// Marks one lazy hierarchy request complete after its source was updated.
    pub fn hierarchy_page_completed(&mut self, owner: &TileKey) {
        self.hierarchy_requests.remove(owner);
    }

    /// Allows a failed hierarchy request to be admitted again explicitly.
    pub fn hierarchy_page_failed(&mut self, owner: &TileKey) {
        self.hierarchy_requests.remove(owner);
    }

    /// Detaches one dataset and returns provider-owned resources to release.
    pub fn remove_dataset(&mut self, dataset_id: &crate::DatasetId) -> Vec<StreamingAction> {
        let evicted = self.residency.remove_dataset(dataset_id);
        self.tickets.retain(|key, _| &key.dataset_id != dataset_id);
        self.estimates
            .retain(|key, _| &key.dataset_id != dataset_id);
        self.fetching.retain(|key| &key.dataset_id != dataset_id);
        self.queued_decodes
            .retain(|key| &key.dataset_id != dataset_id);
        self.decoding.retain(|key| &key.dataset_id != dataset_id);
        self.hierarchy_requests
            .retain(|key| &key.dataset_id != dataset_id);
        evicted
            .into_iter()
            .map(|entry| StreamingAction::EvictTile { key: entry.key })
            .collect()
    }

    fn forget_tile(&mut self, key: &TileKey) {
        self.tickets.remove(key);
        self.estimates.remove(key);
        self.fetching.remove(key);
        self.queued_decodes.remove(key);
        self.decoding.remove(key);
        self.hierarchy_requests.remove(key);
    }
}

fn coalesce_wanted<'a>(
    primary: &'a [TileSelection],
    auxiliary: &'a [TileSelection],
) -> Vec<&'a SelectedTile> {
    let capacity = primary
        .iter()
        .chain(auxiliary)
        .map(|selection| selection.wanted.len())
        .sum();
    let mut wanted = HashMap::<&TileKey, &SelectedTile>::with_capacity(capacity);
    for tile in primary
        .iter()
        .chain(auxiliary)
        .flat_map(|selection| selection.wanted.iter())
    {
        match wanted.get(&tile.key) {
            Some(existing) if existing.screen_space_error >= tile.screen_space_error => {}
            _ => {
                wanted.insert(&tile.key, tile);
            }
        }
    }
    wanted.into_values().collect()
}

fn selected_tile_priority(left: &SelectedTile, right: &SelectedTile) -> std::cmp::Ordering {
    left.screen_space_error
        .total_cmp(&right.screen_space_error)
        .then_with(|| right.key.cmp(&left.key))
}

#[cfg(test)]
mod tests {
    use super::{
        coalesce_wanted, StreamingAction, StreamingCoordinator, StreamingRuntimeLimits,
        ADMISSION_LOOKAHEAD_FRAMES,
    };

    #[test]
    fn auxiliary_draws_are_pinned_without_leaking_into_primary_render() {
        let mut coordinator = StreamingCoordinator::default();
        let primary = selection("primary", ContentKind::PotreePoints, 10.0);
        let auxiliary = selection("auxiliary", ContentKind::Gltf, 20.0);
        make_resident(&mut coordinator, &primary, 100);
        make_resident(&mut coordinator, &auxiliary, 100);

        let primary_key = primary.wanted[0].key.clone();
        let auxiliary_key = auxiliary.wanted[0].key.clone();
        let primary_draw = render_only(primary_key.clone());
        let auxiliary_draw = render_only(auxiliary_key.clone());
        let plan = coordinator
            .plan_frame_with_auxiliary(
                &[primary_draw],
                &[auxiliary_draw],
                zero_budget(),
                frame_budget(),
            )
            .expect("primary and auxiliary draw frame");

        assert_eq!(plan.render, vec![primary_key.clone()]);
        assert!(plan.eviction.evicted.is_empty());
        assert!(!plan.eviction.budget_satisfied);
        assert_eq!(
            coordinator
                .residency()
                .snapshot(&primary_key)
                .expect("primary remains resident")
                .stage,
            ResidencyStage::Resident
        );
        assert_eq!(
            coordinator
                .residency()
                .snapshot(&auxiliary_key)
                .expect("auxiliary remains resident")
                .stage,
            ResidencyStage::Resident
        );
    }

    #[test]
    fn auxiliary_demand_and_pages_share_primary_scheduling() {
        let mut coordinator = StreamingCoordinator::default();
        let primary_key = TileKey {
            dataset_id: DatasetId("primary-visible".to_owned()),
            tile_id: TileId("fallback".to_owned()),
        };
        let primary = render_only(primary_key.clone());
        let mut auxiliary = selection("target", ContentKind::Gltf, 40.0);
        auxiliary
            .hierarchy_pages
            .push(hierarchy_page("target", "page"));

        let plan = coordinator
            .plan_frame_with_auxiliary(
                &[primary],
                &[auxiliary.clone()],
                unlimited_budget(),
                frame_budget(),
            )
            .expect("auxiliary scheduling frame");

        assert_eq!(plan.render, vec![primary_key]);
        assert_eq!(fetch_tickets(&plan.actions).len(), 1);
        assert_eq!(
            plan.actions
                .iter()
                .filter(|action| matches!(action, StreamingAction::FetchHierarchyPage { .. }))
                .count(),
            1
        );
        assert_eq!(fetch_tickets(&plan.actions)[0].key, auxiliary.wanted[0].key);
    }

    #[test]
    fn duplicate_primary_and_auxiliary_demand_uses_maximum_sse_once() {
        let mut primary = selection("shared", ContentKind::Gltf, 2.0);
        let mut auxiliary = primary.clone().with_sse(200.0);
        std::sync::Arc::make_mut(&mut primary.wanted[0].descriptor).contents[0].uri =
            "https://example.invalid/primary".to_owned();
        std::sync::Arc::make_mut(&mut auxiliary.wanted[0].descriptor).contents[0].uri =
            "https://example.invalid/auxiliary".to_owned();
        let page = hierarchy_page("shared", "page");
        primary.hierarchy_pages.push(page.clone());
        auxiliary.hierarchy_pages.push(page);

        let wanted = coalesce_wanted(
            std::slice::from_ref(&primary),
            std::slice::from_ref(&auxiliary),
        );
        assert_eq!(wanted.len(), 1);
        assert_eq!(wanted[0].screen_space_error, 200.0);

        let mut coordinator = StreamingCoordinator::default();
        let plan = coordinator
            .plan_frame_with_auxiliary(&[primary], &[auxiliary], unlimited_budget(), frame_budget())
            .expect("coalesced source and target demand");
        let fetches = plan
            .actions
            .iter()
            .filter_map(|action| match action {
                StreamingAction::FetchTile { descriptor, .. } => Some(descriptor),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(fetches.len(), 1);
        assert_eq!(
            fetches[0].contents[0].uri,
            "https://example.invalid/auxiliary"
        );
        assert_eq!(
            plan.actions
                .iter()
                .filter(|action| matches!(action, StreamingAction::FetchHierarchyPage { .. }))
                .count(),
            1
        );
    }
    use crate::{
        BoundingVolume, ContentKind, ContentReference, DatasetId, FrameBudget,
        HierarchyPageReference, HierarchyPageRequest, RefinementMode, ResidencyStage,
        ResourceBudget, ResourceCost, SelectedTile, TileDescriptor, TileId, TileKey, TileResidency,
        TileSelection, WorldAabb, WorldTransform, WorldVec3,
    };

    #[test]
    fn point_and_mesh_tiles_share_one_end_to_end_lifecycle() {
        let mut coordinator = StreamingCoordinator::new(1);
        let budget = unlimited_budget();
        let frame = frame_budget();
        let points = selection("points", ContentKind::PotreePoints, 10.0);
        let mesh = selection("mesh", ContentKind::Gltf, 9.0);

        let first = coordinator
            .plan_frame(&[points.clone(), mesh.clone()], budget, frame)
            .expect("request frame");
        assert_eq!(
            first
                .actions
                .iter()
                .filter(|action| matches!(action, StreamingAction::FetchTile { .. }))
                .count(),
            2
        );
        let tickets = first
            .actions
            .iter()
            .filter_map(|action| match action {
                StreamingAction::FetchTile { ticket, .. } => Some(ticket.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        for ticket in &tickets {
            coordinator
                .fetched(ticket, compressed_cost(100))
                .expect("fetch completion");
        }

        let decode_one = coordinator
            .plan_frame(&[points.clone(), mesh.clone()], budget, frame)
            .expect("decode frame");
        let first_decode = decode_one
            .actions
            .iter()
            .find_map(|action| match action {
                StreamingAction::DecodeTile { ticket } => Some(ticket.clone()),
                _ => None,
            })
            .expect("one decoder worker is used");
        coordinator
            .decoded(&first_decode, decoded_cost(200))
            .expect("decode completion");

        let upload_and_decode = coordinator
            .plan_frame(&[points, mesh], budget, frame)
            .expect("mixed work frame");
        assert!(upload_and_decode
            .actions
            .iter()
            .any(|action| matches!(action, StreamingAction::UploadTile { .. })));
        assert!(upload_and_decode
            .actions
            .iter()
            .any(|action| matches!(action, StreamingAction::DecodeTile { .. })));
    }

    #[test]
    fn eviction_invalidates_ticket_and_emits_provider_drop() {
        let mut coordinator = StreamingCoordinator::default();
        let selection = selection("points", ContentKind::PotreePoints, 10.0);
        let first = coordinator
            .plan_frame(&[selection.clone()], unlimited_budget(), frame_budget())
            .expect("request");
        let ticket = first
            .actions
            .iter()
            .find_map(|action| match action {
                StreamingAction::FetchTile { ticket, .. } => Some(ticket.clone()),
                _ => None,
            })
            .expect("fetch");
        coordinator
            .fetched(&ticket, compressed_cost(100))
            .expect("fetched");

        let empty = TileSelection {
            wanted: Vec::new(),
            render: Vec::new(),
            hierarchy_pages: Vec::new(),
            traversed_nodes: 0,
            culled_nodes: 0,
            work_limit_reached: false,
        };
        let plan = coordinator
            .plan_frame(&[empty], zero_budget(), frame_budget())
            .expect("evict frame");
        assert!(plan
            .actions
            .iter()
            .any(|action| matches!(action, StreamingAction::EvictTile { .. })));
        assert!(coordinator.decoded(&ticket, decoded_cost(200)).is_err());
    }

    #[test]
    fn camera_reentry_replaces_a_full_unpinned_cache_before_admission() {
        let mut coordinator = StreamingCoordinator::default();
        let old = selection("old-view", ContentKind::PotreePoints, 1.0);
        let new = selection("new-view", ContentKind::PotreePoints, 100.0);
        let estimate = crate::estimate_tile_load(&new.wanted[0]);
        let budget = ResourceBudget {
            cpu_compressed_bytes: estimate.cost.cpu_compressed_bytes,
            cpu_decoded_bytes: estimate.cost.cpu_decoded_bytes,
            gpu_buffer_bytes: estimate.cost.gpu_buffer_bytes,
            gpu_texture_bytes: estimate.cost.gpu_texture_bytes,
            staging_bytes: estimate.cost.staging_bytes,
            points: estimate.cost.points,
            triangles: estimate.cost.triangles,
            splats: estimate.cost.splats,
            draw_calls: estimate.cost.draw_calls,
        };

        let requested = coordinator
            .plan_frame(&[old.clone()], unlimited_budget(), frame_budget())
            .expect("old request");
        let old_ticket = fetch_tickets(&requested.actions)
            .into_iter()
            .next()
            .expect("old fetch ticket");
        coordinator
            .fetched(&old_ticket, compressed_cost(100))
            .expect("old fetched");
        let decode = coordinator
            .plan_frame(&[old.clone()], unlimited_budget(), frame_budget())
            .expect("old decode");
        let old_ticket = decode_tickets(&decode.actions)
            .into_iter()
            .next()
            .expect("old decode ticket");
        coordinator
            .decoded(&old_ticket, decoded_cost(160))
            .expect("old decoded");
        let upload = coordinator
            .plan_frame(&[old], unlimited_budget(), frame_budget())
            .expect("old upload");
        assert!(upload.actions.iter().any(|action| {
            matches!(action, StreamingAction::UploadTile { ticket } if ticket == &old_ticket)
        }));
        coordinator
            .uploaded(
                &old_ticket,
                ResourceCost {
                    gpu_buffer_bytes: estimate.cost.gpu_buffer_bytes,
                    points: estimate.cost.points,
                    draw_calls: estimate.cost.draw_calls,
                    ..ResourceCost::default()
                },
            )
            .expect("old resident");

        let replacement = coordinator
            .plan_frame(&[new.clone()], budget, frame_budget())
            .expect("replacement frame");

        assert!(matches!(
            replacement.actions.first(),
            Some(StreamingAction::EvictTile { key }) if key.dataset_id.0 == "old-view"
        ));
        assert!(replacement.actions.iter().any(|action| {
            matches!(action, StreamingAction::FetchTile { ticket, .. } if ticket.key == new.wanted[0].key)
        }));
        assert!(coordinator
            .residency()
            .snapshot(&TileKey {
                dataset_id: DatasetId("old-view".to_owned()),
                tile_id: TileId("tile-0".to_owned()),
            })
            .is_none());
    }

    #[test]
    fn runtime_limits_change_concurrency_without_changing_final_residency() {
        let selection = selection_many("tiles", ContentKind::Gltf, 6);
        let mut low = StreamingCoordinator::new(8);
        low.set_runtime_limits(StreamingRuntimeLimits::new(1, 1));
        let low_peaks = drive_to_resident(&mut low, &selection);

        let mut high = StreamingCoordinator::new(8);
        high.set_runtime_limits(StreamingRuntimeLimits::new(3, 3));
        let high_peaks = drive_to_resident(&mut high, &selection);

        assert_eq!(low_peaks, (1, 1));
        assert_eq!(high_peaks, (3, 3));
        for tile in &selection.wanted {
            assert_eq!(
                low.residency()
                    .snapshot(&tile.key)
                    .expect("low-limit tile")
                    .stage,
                ResidencyStage::Resident
            );
            assert_eq!(
                high.residency()
                    .snapshot(&tile.key)
                    .expect("high-limit tile")
                    .stage,
                ResidencyStage::Resident
            );
        }
    }

    #[test]
    fn enormous_visible_set_emits_a_bounded_admission_frontier() {
        let mut coordinator = StreamingCoordinator::default();
        let selection = selection_many("large", ContentKind::PotreePoints, 10_000);
        let frame = FrameBudget {
            new_requests: 1,
            ..frame_budget()
        };

        let first = coordinator
            .plan_frame(&[selection.clone()], unlimited_budget(), frame)
            .expect("bounded first frame");
        assert_eq!(first.admission.admitted.len(), 1);
        assert_eq!(
            first.admission.rejected.len(),
            ADMISSION_LOOKAHEAD_FRAMES - 1
        );
        assert_eq!(fetch_tickets(&first.actions).len(), 1);

        let second = coordinator
            .plan_frame(&[selection], unlimited_budget(), frame)
            .expect("bounded follow-up frame");
        assert_eq!(second.admission.admitted.len(), 1);
        assert_eq!(
            second.admission.rejected.len(),
            ADMISSION_LOOKAHEAD_FRAMES - 1
        );
        assert_eq!(fetch_tickets(&second.actions).len(), 1);
    }

    #[test]
    fn reconfiguration_preserves_residency_and_live_generations() {
        let selection = selection_many("tiles", ContentKind::Gltf, 5);
        let mut coordinator = StreamingCoordinator::new(8);
        coordinator.set_runtime_limits(StreamingRuntimeLimits::new(2, 2));

        let first = coordinator
            .plan_frame(
                &[selection.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("initial requests");
        let first_tickets = fetch_tickets(&first.actions);
        assert_eq!(first_tickets.len(), 2);
        assert_eq!(coordinator.in_flight_content_requests(), 2);

        coordinator.set_runtime_limits(StreamingRuntimeLimits::new(1, 1));
        let held = coordinator
            .plan_frame(
                &[selection.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("lowered limit frame");
        assert!(fetch_tickets(&held.actions).is_empty());
        for ticket in &first_tickets {
            let snapshot = coordinator
                .residency()
                .snapshot(&ticket.key)
                .expect("live fetch retained");
            assert_eq!(snapshot.stage, ResidencyStage::Fetching);
            assert_eq!(snapshot.generation, ticket.generation);
            coordinator
                .fetched(ticket, compressed_cost(100))
                .expect("fetch drains under lower ceiling");
        }

        let low_decode = coordinator
            .plan_frame(
                &[selection.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("lowered decode frame");
        let running_before_raise = decode_tickets(&low_decode.actions);
        let fetching_before_raise = fetch_tickets(&low_decode.actions);
        assert_eq!(running_before_raise.len(), 1);
        assert_eq!(fetching_before_raise.len(), 1);
        assert_eq!(coordinator.active_decodes(), 1);

        coordinator.set_runtime_limits(StreamingRuntimeLimits::new(3, 3));
        let raised = coordinator
            .plan_frame(
                &[selection.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("raised limit frame");
        let additionally_decoding = decode_tickets(&raised.actions);
        let additionally_fetching = fetch_tickets(&raised.actions);
        assert_eq!(additionally_decoding.len(), 1);
        assert_eq!(additionally_fetching.len(), 2);
        assert_eq!(coordinator.active_decodes(), 2);
        assert_eq!(coordinator.in_flight_content_requests(), 3);

        for ticket in running_before_raise
            .iter()
            .chain(additionally_decoding.iter())
        {
            coordinator
                .decoded(ticket, decoded_cost(200))
                .expect("existing decode completes after reconfiguration");
        }
        for ticket in fetching_before_raise
            .iter()
            .chain(additionally_fetching.iter())
        {
            coordinator
                .fetched(ticket, compressed_cost(100))
                .expect("newly released fetch slot completes");
        }
        drive_to_resident(&mut coordinator, &selection);
        for tile in &selection.wanted {
            assert_eq!(
                coordinator
                    .residency()
                    .snapshot(&tile.key)
                    .expect("reconfigured tile")
                    .stage,
                ResidencyStage::Resident
            );
        }
    }

    #[test]
    fn hierarchy_and_tile_fetches_share_the_content_request_ceiling() {
        let mut selection = selection_many("tiles", ContentKind::Gltf, 3);
        let hierarchy_owner = TileKey {
            dataset_id: DatasetId("tiles".to_owned()),
            tile_id: TileId("hierarchy-owner".to_owned()),
        };
        selection.hierarchy_pages.push(HierarchyPageRequest {
            owner: hierarchy_owner.clone(),
            reference: HierarchyPageReference {
                uri: "https://example.invalid/hierarchy.bin".to_owned(),
                byte_offset: Some(0),
                byte_length: Some(128),
                content_hash: None,
                decoder_parameters: None,
            },
        });
        let mut coordinator = StreamingCoordinator::new(2);
        coordinator.set_runtime_limits(StreamingRuntimeLimits::new(2, 2));

        let first = coordinator
            .plan_frame(
                &[selection.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("mixed hierarchy/content requests");
        let hierarchy_count = first
            .actions
            .iter()
            .filter(|action| matches!(action, StreamingAction::FetchHierarchyPage { .. }))
            .count();
        let tile_tickets = fetch_tickets(&first.actions);
        assert_eq!(hierarchy_count, 1);
        assert_eq!(tile_tickets.len(), 1);
        assert_eq!(coordinator.in_flight_content_requests(), 2);

        let held = coordinator
            .plan_frame(
                &[selection.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("full mixed request ceiling");
        assert!(held.actions.iter().all(|action| !matches!(
            action,
            StreamingAction::FetchHierarchyPage { .. } | StreamingAction::FetchTile { .. }
        )));

        coordinator.hierarchy_page_completed(&hierarchy_owner);
        coordinator
            .fetched(&tile_tickets[0], compressed_cost(100))
            .expect("tile request completes");
        selection.hierarchy_pages.clear();
        let released = coordinator
            .plan_frame(&[selection], unlimited_budget(), concurrency_frame_budget())
            .expect("released mixed request slots");
        assert_eq!(fetch_tickets(&released.actions).len(), 2);
        assert_eq!(coordinator.in_flight_content_requests(), 2);
    }

    #[test]
    fn removing_dataset_cancels_every_stage_and_releases_runtime_slots() {
        let mut retired = selection_many("retired", ContentKind::Gltf, 3);
        retired
            .hierarchy_pages
            .push(hierarchy_page("retired", "hierarchy-owner"));
        let retained = selection("retained", ContentKind::PotreePoints, 1.0);
        let mut coordinator = StreamingCoordinator::new(2);
        coordinator.set_runtime_limits(StreamingRuntimeLimits::new(2, 4));

        let planned = coordinator
            .plan_frame(
                &[retired, retained.clone()],
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("mixed dataset plan");
        assert!(coordinator.in_flight_content_requests() > 0);
        let retired_ticket = fetch_tickets(&planned.actions)
            .into_iter()
            .find(|ticket| ticket.key.dataset_id.0 == "retired")
            .expect("retired dataset fetch");
        coordinator
            .fetched(&retired_ticket, compressed_cost(100))
            .expect("retired fetch completes");

        let actions = coordinator.remove_dataset(&DatasetId("retired".to_owned()));
        assert!(actions.iter().all(|action| matches!(
            action,
            StreamingAction::EvictTile { key } if key.dataset_id.0 == "retired"
        )));
        assert!(coordinator
            .residency()
            .snapshot(&retired_ticket.key)
            .is_none());
        assert!(coordinator
            .tickets
            .keys()
            .all(|key| key.dataset_id.0 != "retired"));
        assert!(coordinator
            .hierarchy_requests
            .iter()
            .all(|key| key.dataset_id.0 != "retired"));
        assert!(coordinator.in_flight_content_requests() <= 1);

        let replanned = coordinator
            .plan_frame(
                std::slice::from_ref(&retained),
                unlimited_budget(),
                concurrency_frame_budget(),
            )
            .expect("retained dataset continues");
        assert!(replanned.actions.iter().all(|action| match action {
            StreamingAction::FetchTile { ticket, .. }
            | StreamingAction::DecodeTile { ticket }
            | StreamingAction::UploadTile { ticket } => ticket.key.dataset_id.0 != "retired",
            StreamingAction::FetchHierarchyPage { request } => {
                request.owner.dataset_id.0 != "retired"
            }
            StreamingAction::EvictTile { key } => key.dataset_id.0 != "retired",
        }));
    }

    fn drive_to_resident(
        coordinator: &mut StreamingCoordinator,
        selection: &TileSelection,
    ) -> (usize, usize) {
        let mut peak_fetches = 0;
        let mut peak_decodes = 0;
        for _ in 0..32 {
            let plan = coordinator
                .plan_frame(
                    &[selection.clone()],
                    unlimited_budget(),
                    concurrency_frame_budget(),
                )
                .expect("streaming frame");
            peak_fetches = peak_fetches.max(fetch_tickets(&plan.actions).len());
            peak_decodes = peak_decodes.max(decode_tickets(&plan.actions).len());
            for action in plan.actions {
                match action {
                    StreamingAction::FetchTile { ticket, .. } => coordinator
                        .fetched(&ticket, compressed_cost(100))
                        .expect("fetch completion"),
                    StreamingAction::DecodeTile { ticket } => coordinator
                        .decoded(&ticket, decoded_cost(200))
                        .expect("decode completion"),
                    StreamingAction::UploadTile { ticket } => coordinator
                        .uploaded(&ticket, ResourceCost::default())
                        .expect("upload completion"),
                    StreamingAction::FetchHierarchyPage { .. }
                    | StreamingAction::EvictTile { .. } => {}
                }
            }
            if selection.wanted.iter().all(|tile| {
                coordinator
                    .residency()
                    .snapshot(&tile.key)
                    .is_some_and(|snapshot| snapshot.stage == ResidencyStage::Resident)
            }) {
                return (peak_fetches, peak_decodes);
            }
        }
        panic!("streaming did not converge to complete residency");
    }

    fn fetch_tickets(actions: &[StreamingAction]) -> Vec<crate::ResidencyTicket> {
        actions
            .iter()
            .filter_map(|action| match action {
                StreamingAction::FetchTile { ticket, .. } => Some(ticket.clone()),
                _ => None,
            })
            .collect()
    }

    fn decode_tickets(actions: &[StreamingAction]) -> Vec<crate::ResidencyTicket> {
        actions
            .iter()
            .filter_map(|action| match action {
                StreamingAction::DecodeTile { ticket } => Some(ticket.clone()),
                _ => None,
            })
            .collect()
    }

    fn make_resident(
        coordinator: &mut StreamingCoordinator,
        selection: &TileSelection,
        gpu_bytes: u64,
    ) {
        let request = coordinator
            .plan_frame(
                std::slice::from_ref(selection),
                unlimited_budget(),
                frame_budget(),
            )
            .expect("resident fixture request");
        let ticket = fetch_tickets(&request.actions)
            .into_iter()
            .next()
            .expect("resident fixture fetch");
        coordinator
            .fetched(&ticket, compressed_cost(10))
            .expect("resident fixture fetched");
        let decode = coordinator
            .plan_frame(
                std::slice::from_ref(selection),
                unlimited_budget(),
                frame_budget(),
            )
            .expect("resident fixture decode");
        let ticket = decode_tickets(&decode.actions)
            .into_iter()
            .next()
            .expect("resident fixture decode claim");
        coordinator
            .decoded(&ticket, decoded_cost(20))
            .expect("resident fixture decoded");
        let upload = coordinator
            .plan_frame(
                std::slice::from_ref(selection),
                unlimited_budget(),
                frame_budget(),
            )
            .expect("resident fixture upload");
        assert!(upload.actions.iter().any(
            |action| matches!(action, StreamingAction::UploadTile { ticket: upload } if upload == &ticket)
        ));
        coordinator
            .uploaded(
                &ticket,
                ResourceCost {
                    gpu_buffer_bytes: gpu_bytes,
                    draw_calls: 1,
                    ..ResourceCost::default()
                },
            )
            .expect("resident fixture published");
    }

    fn render_only(key: TileKey) -> TileSelection {
        TileSelection {
            wanted: Vec::new(),
            render: vec![key],
            hierarchy_pages: Vec::new(),
            traversed_nodes: 0,
            culled_nodes: 0,
            work_limit_reached: false,
        }
    }

    fn hierarchy_page(dataset: &str, tile: &str) -> HierarchyPageRequest {
        HierarchyPageRequest {
            owner: TileKey {
                dataset_id: DatasetId(dataset.to_owned()),
                tile_id: TileId(tile.to_owned()),
            },
            reference: HierarchyPageReference {
                uri: format!("https://example.invalid/{dataset}/{tile}.bin"),
                byte_offset: Some(0),
                byte_length: Some(128),
                content_hash: None,
                decoder_parameters: None,
            },
        }
    }

    fn selection(dataset: &str, kind: ContentKind, sse: f64) -> TileSelection {
        selection_many(dataset, kind, 1).with_sse(sse)
    }

    trait SelectionTestExt {
        fn with_sse(self, sse: f64) -> Self;
    }

    impl SelectionTestExt for TileSelection {
        fn with_sse(mut self, sse: f64) -> Self {
            self.wanted[0].screen_space_error = sse;
            self
        }
    }

    fn selection_many(dataset: &str, kind: ContentKind, count: usize) -> TileSelection {
        let wanted = (0..count)
            .map(|index| selected_tile(dataset, &format!("tile-{index}"), kind))
            .collect();
        TileSelection {
            wanted,
            render: Vec::new(),
            hierarchy_pages: Vec::new(),
            traversed_nodes: count,
            culled_nodes: 0,
            work_limit_reached: false,
        }
    }

    fn selected_tile(dataset: &str, tile_id: &str, kind: ContentKind) -> SelectedTile {
        let key = TileKey {
            dataset_id: DatasetId(dataset.to_owned()),
            tile_id: TileId(tile_id.to_owned()),
        };
        let descriptor = TileDescriptor {
            id: key.tile_id.clone(),
            parent: None,
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
            geometric_error: 1.0,
            refinement: RefinementMode::Replace,
            content_transform: WorldTransform::IDENTITY,
            contents: vec![ContentReference {
                kind,
                uri: format!("https://example.invalid/{dataset}"),
                byte_offset: None,
                byte_length: Some(100),
                primitive_count: Some(10),
                content_hash: None,
                decoder_parameters: None,
            }],
            children: Vec::new(),
            child_page: None,
            provider_metadata: None,
        };
        SelectedTile {
            key,
            screen_space_error: 10.0,
            residency: TileResidency::Unloaded,
            descriptor: std::sync::Arc::new(descriptor),
        }
    }

    fn frame_budget() -> FrameBudget {
        FrameBudget {
            target_frame_ms: 16.7,
            traversal_ms: 1.0,
            decode_ms: 10.0,
            upload_bytes: u64::MAX,
            new_requests: 8,
        }
    }

    fn concurrency_frame_budget() -> FrameBudget {
        FrameBudget {
            decode_ms: 1_000.0,
            new_requests: u16::MAX,
            ..frame_budget()
        }
    }

    fn unlimited_budget() -> ResourceBudget {
        ResourceBudget {
            cpu_compressed_bytes: u64::MAX,
            cpu_decoded_bytes: u64::MAX,
            gpu_buffer_bytes: u64::MAX,
            gpu_texture_bytes: u64::MAX,
            staging_bytes: u64::MAX,
            points: u64::MAX,
            triangles: u64::MAX,
            splats: u64::MAX,
            draw_calls: u32::MAX,
        }
    }

    fn zero_budget() -> ResourceBudget {
        ResourceBudget {
            cpu_compressed_bytes: 0,
            cpu_decoded_bytes: 0,
            gpu_buffer_bytes: 0,
            gpu_texture_bytes: 0,
            staging_bytes: 0,
            points: 0,
            triangles: 0,
            splats: 0,
            draw_calls: 0,
        }
    }

    fn compressed_cost(bytes: u64) -> ResourceCost {
        ResourceCost {
            cpu_compressed_bytes: bytes,
            ..ResourceCost::default()
        }
    }

    fn decoded_cost(bytes: u64) -> ResourceCost {
        ResourceCost {
            cpu_decoded_bytes: bytes,
            ..ResourceCost::default()
        }
    }
}
