//! Deterministic global admission planning across all dataset kinds.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::{DatasetId, FrameBudget, ResourceBudget, ResourceCost, TileId};

/// Viewer Core frame lane. Ordering is semantic: lower-numbered lanes are
/// always planned before higher-numbered refinement work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameLane {
    /// Current camera, clear/depth and active clipping.
    Lane1CameraClip,
    /// Cursor, tools, grips, selection and pick identifiers.
    Lane2Interaction,
    /// Canonical vectors, text and measurement graphics.
    Lane3Canonical,
    /// Coarse mesh and raster fallbacks.
    Lane4MeshRasterFallback,
    /// Coarse point-cloud and splat fallbacks.
    Lane5CloudSplatFallback,
    /// Cloud, splat, mesh and raster refinement and optional effects.
    Lane6Refinement,
}

impl FrameLane {
    /// Whether work in this lane may consume only background remainder.
    #[must_use]
    pub const fn is_background(self) -> bool {
        matches!(
            self,
            Self::Lane4MeshRasterFallback | Self::Lane5CloudSplatFallback | Self::Lane6Refinement
        )
    }
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

    /// Returns the ceiling for a background lane. Protected lanes have no
    /// droppable lane ceiling and therefore return `None`.
    #[must_use]
    pub const fn for_lane(self, lane: FrameLane) -> Option<LaneWorkBudget> {
        match lane {
            FrameLane::Lane4MeshRasterFallback => Some(self.lane4),
            FrameLane::Lane5CloudSplatFallback => Some(self.lane5),
            FrameLane::Lane6Refinement => Some(self.lane6),
            FrameLane::Lane1CameraClip
            | FrameLane::Lane2Interaction
            | FrameLane::Lane3Canonical => None,
        }
    }
}

/// Exact work admitted to one lane in the current frame.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneWorkUsage {
    /// Point and splat samples.
    pub points: u64,
    /// GPU bytes.
    pub bytes: u64,
    /// Draw count.
    pub draw_calls: u32,
    /// Uploaded bytes.
    pub upload_bytes: u64,
    /// Estimated decode milliseconds.
    pub decode_ms: f32,
}

impl LaneWorkUsage {
    fn with_candidate(self, candidate: &AdmissionCandidate) -> Self {
        Self {
            points: self
                .points
                .saturating_add(candidate.cost.points)
                .saturating_add(candidate.cost.splats),
            bytes: self.bytes.saturating_add(
                candidate
                    .cost
                    .gpu_buffer_bytes
                    .saturating_add(candidate.cost.gpu_texture_bytes),
            ),
            draw_calls: self.draw_calls.saturating_add(candidate.cost.draw_calls),
            upload_bytes: self.upload_bytes.saturating_add(candidate.upload_bytes),
            decode_ms: self.decode_ms + candidate.decode_ms.max(0.0),
        }
    }
}

/// Globally unique streamed tile address.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileKey {
    /// Dataset identity.
    pub dataset_id: DatasetId,
    /// Provider-local tile identity.
    pub tile_id: TileId,
}

/// One visible tile proposed by a hierarchy selector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionCandidate {
    /// Tile address.
    pub key: TileKey,
    /// Protected or remainder lane owning this work.
    pub lane: FrameLane,
    /// Higher values are admitted first within a dataset.
    pub benefit: f64,
    /// Complete incremental residency cost.
    pub cost: ResourceCost,
    /// Estimated CPU decoding time.
    pub decode_ms: f32,
    /// Bytes uploaded if admitted this frame.
    pub upload_bytes: u64,
    /// Whether admission starts a new content request.
    pub starts_request: bool,
}

/// Reason a visible candidate was not admitted this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectionReason {
    /// Candidate would exceed the hard selected/resident point ceiling.
    PointBudget,
    /// Candidate would exceed a CPU, GPU, staging or upload byte ceiling.
    ByteBudget,
    /// Candidate would exceed the hard draw-call ceiling.
    DrawBudget,
    /// Candidate exceeded at least one global residency dimension.
    ResourceBudget,
    /// Candidate exceeded per-frame decode, upload or request limits.
    FrameBudget,
    /// Candidate exceeded its lane's hard point/splat ceiling.
    LanePointBudget,
    /// Candidate exceeded its lane's hard GPU-byte ceiling.
    LaneByteBudget,
    /// Candidate exceeded its lane's hard draw ceiling.
    LaneDrawBudget,
    /// Candidate exceeded its lane's hard upload ceiling.
    LaneUploadBudget,
    /// Candidate exceeded its lane's hard decode ceiling.
    LaneDecodeBudget,
    /// Candidate priority was NaN or infinite.
    InvalidBenefit,
}

/// Rejected tile with an explicit diagnostic reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedCandidate {
    /// Tile address.
    pub key: TileKey,
    /// Lane whose hard limit rejected this work.
    pub lane: FrameLane,
    /// Admission failure class.
    pub reason: RejectionReason,
}

/// Deterministic result consumed by request, decode and upload stages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionPlan {
    /// Tiles admitted in fair scheduling order.
    pub admitted: Vec<TileKey>,
    /// Tiles not admitted in this frame.
    pub rejected: Vec<RejectedCandidate>,
    /// Residency cost after all admissions.
    pub total_cost: ResourceCost,
    /// Estimated decode time admitted this frame.
    pub decode_ms: f32,
    /// Upload bytes admitted this frame.
    pub upload_bytes: u64,
    /// New requests admitted this frame.
    pub new_requests: u16,
    /// Exact admitted work in lanes 1 through 6.
    pub lane_usage: [LaneWorkUsage; 6],
}

/// Stateful round-robin planner preventing one dataset from consuming all slack.
#[derive(Debug, Default)]
pub struct AdmissionPlanner {
    fairness_cursor: [usize; 6],
}

impl AdmissionPlanner {
    /// Creates a planner with deterministic initial dataset order.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Admits visible candidates under shared residency and per-frame budgets.
    ///
    /// Candidates are sorted by benefit inside each dataset. The planner then
    /// takes at most one candidate per dataset per round and rotates the first
    /// dataset between calls. Work is proportional to visible hierarchy nodes,
    /// never source primitives.
    #[must_use]
    pub fn plan(
        &mut self,
        baseline: ResourceCost,
        resource_budget: ResourceBudget,
        frame_budget: FrameBudget,
        candidates: impl IntoIterator<Item = AdmissionCandidate>,
    ) -> AdmissionPlan {
        self.plan_with_lane_budgets(
            baseline,
            resource_budget,
            frame_budget,
            BackgroundLaneBudgets::UNLIMITED,
            candidates,
        )
    }

    /// Admits protected work first, then fair datasets inside each background
    /// lane without exceeding that lane's point/byte/draw/upload/decode caps.
    #[must_use]
    pub fn plan_with_lane_budgets(
        &mut self,
        baseline: ResourceCost,
        resource_budget: ResourceBudget,
        frame_budget: FrameBudget,
        lane_budgets: BackgroundLaneBudgets,
        candidates: impl IntoIterator<Item = AdmissionCandidate>,
    ) -> AdmissionPlan {
        let mut rejected = Vec::new();
        let mut grouped: BTreeMap<(FrameLane, DatasetId), Vec<AdmissionCandidate>> =
            BTreeMap::new();
        for candidate in candidates {
            if !candidate.benefit.is_finite() {
                rejected.push(RejectedCandidate {
                    key: candidate.key,
                    lane: candidate.lane,
                    reason: RejectionReason::InvalidBenefit,
                });
                continue;
            }
            grouped
                .entry((candidate.lane, candidate.key.dataset_id.clone()))
                .or_default()
                .push(candidate);
        }
        for group in grouped.values_mut() {
            group.sort_by(|left, right| {
                right
                    .benefit
                    .total_cmp(&left.benefit)
                    .then_with(|| left.key.tile_id.cmp(&right.key.tile_id))
            });
        }

        let mut admitted = Vec::new();
        let mut deferred_frame = Vec::new();
        let mut total_cost = baseline;
        let mut decode_ms = 0.0_f32;
        let mut upload_bytes = 0_u64;
        let mut new_requests = 0_u16;
        let mut lane_usage = [LaneWorkUsage::default(); 6];
        for (lane_index, lane) in [
            FrameLane::Lane1CameraClip,
            FrameLane::Lane2Interaction,
            FrameLane::Lane3Canonical,
            FrameLane::Lane4MeshRasterFallback,
            FrameLane::Lane5CloudSplatFallback,
            FrameLane::Lane6Refinement,
        ]
        .into_iter()
        .enumerate()
        {
            let lane_groups = grouped
                .iter()
                .filter(|((candidate_lane, _), _)| *candidate_lane == lane)
                .map(|(_, candidates)| candidates.clone())
                .collect::<Vec<_>>();
            let mut queues = lane_groups
                .into_iter()
                .map(|candidates| WeightedDatasetQueue {
                    weight: candidates
                        .first()
                        .map_or(1.0, |candidate| candidate.benefit.max(f64::MIN_POSITIVE)),
                    virtual_finish: 0.0,
                    candidates: VecDeque::from(candidates),
                })
                .collect::<Vec<_>>();
            if !queues.is_empty() {
                let rotation = self.fairness_cursor[lane_index] % queues.len();
                queues.rotate_left(rotation);
                self.fairness_cursor[lane_index] =
                    (self.fairness_cursor[lane_index] + 1) % queues.len();
            }
            let mut remaining = queues
                .iter()
                .map(|queue| queue.candidates.len())
                .sum::<usize>();
            while remaining > 0 {
                let Some(index) = queues
                    .iter()
                    .enumerate()
                    .filter(|(_, queue)| !queue.candidates.is_empty())
                    .min_by(|(_, left), (_, right)| {
                        left.virtual_finish.total_cmp(&right.virtual_finish)
                    })
                    .map(|(index, _)| index)
                else {
                    break;
                };
                let queue = &mut queues[index];
                let candidate = queue
                    .candidates
                    .pop_front()
                    .expect("non-empty weighted dataset queue");
                queue.virtual_finish += 1.0 / queue.weight;
                remaining -= 1;
                let next_cost = total_cost.saturating_add(candidate.cost);
                if !resource_budget.contains(next_cost) {
                    rejected.push(RejectedCandidate {
                        key: candidate.key,
                        lane: candidate.lane,
                        reason: resource_rejection_reason(next_cost, resource_budget),
                    });
                    continue;
                }
                let next_lane = lane_usage[lane_index].with_candidate(&candidate);
                if let Some(budget) = lane_budgets.for_lane(lane) {
                    if let Some(reason) = lane_rejection_reason(next_lane, budget) {
                        rejected.push(RejectedCandidate {
                            key: candidate.key,
                            lane: candidate.lane,
                            reason,
                        });
                        continue;
                    }
                }
                let next_decode = decode_ms + candidate.decode_ms.max(0.0);
                let next_upload = upload_bytes.saturating_add(candidate.upload_bytes);
                let next_requests =
                    new_requests.saturating_add(u16::from(candidate.starts_request));
                if next_decode > frame_budget.decode_ms
                    || next_upload > frame_budget.upload_bytes
                    || next_requests > frame_budget.new_requests
                {
                    deferred_frame.push(candidate);
                    continue;
                }
                total_cost = next_cost;
                decode_ms = next_decode;
                upload_bytes = next_upload;
                new_requests = next_requests;
                lane_usage[lane_index] = next_lane;
                admitted.push(candidate.key);
            }
        }

        // A frame allowance is a latency target rather than a permanent size
        // ceiling. If every otherwise valid candidate is larger than that
        // target, claim exactly one so a large tile cannot starve forever.
        if admitted.is_empty() {
            deferred_frame.sort_by(|left, right| {
                right
                    .benefit
                    .total_cmp(&left.benefit)
                    .then_with(|| left.key.cmp(&right.key))
            });
            if let Some(index) = deferred_frame.iter().position(|candidate| {
                (!candidate.starts_request || frame_budget.new_requests > 0)
                    && (candidate.decode_ms <= 0.0 || frame_budget.decode_ms > 0.0)
                    && (candidate.upload_bytes == 0 || frame_budget.upload_bytes > 0)
                    && lane_budgets.for_lane(candidate.lane).is_none_or(|budget| {
                        lane_rejection_reason(
                            lane_usage[lane_index(candidate.lane)].with_candidate(candidate),
                            budget,
                        )
                        .is_none()
                    })
            }) {
                let candidate = deferred_frame.remove(index);
                total_cost = total_cost.saturating_add(candidate.cost);
                decode_ms += candidate.decode_ms.max(0.0);
                upload_bytes = upload_bytes.saturating_add(candidate.upload_bytes);
                new_requests = new_requests.saturating_add(u16::from(candidate.starts_request));
                let index = lane_index(candidate.lane);
                lane_usage[index] = lane_usage[index].with_candidate(&candidate);
                admitted.push(candidate.key);
            }
        }
        rejected.extend(
            deferred_frame
                .into_iter()
                .map(|candidate| RejectedCandidate {
                    key: candidate.key,
                    lane: candidate.lane,
                    reason: RejectionReason::FrameBudget,
                }),
        );

        AdmissionPlan {
            admitted,
            rejected,
            total_cost,
            decode_ms,
            upload_bytes,
            new_requests,
            lane_usage,
        }
    }
}

struct WeightedDatasetQueue {
    candidates: VecDeque<AdmissionCandidate>,
    weight: f64,
    virtual_finish: f64,
}

fn resource_rejection_reason(cost: ResourceCost, budget: ResourceBudget) -> RejectionReason {
    if cost.points > budget.points {
        RejectionReason::PointBudget
    } else if cost.gpu_buffer_bytes > budget.gpu_buffer_bytes
        || cost.gpu_texture_bytes > budget.gpu_texture_bytes
        || cost.cpu_compressed_bytes > budget.cpu_compressed_bytes
        || cost.cpu_decoded_bytes > budget.cpu_decoded_bytes
        || cost.staging_bytes > budget.staging_bytes
    {
        RejectionReason::ByteBudget
    } else if cost.draw_calls > budget.draw_calls {
        RejectionReason::DrawBudget
    } else {
        RejectionReason::ResourceBudget
    }
}

fn lane_index(lane: FrameLane) -> usize {
    match lane {
        FrameLane::Lane1CameraClip => 0,
        FrameLane::Lane2Interaction => 1,
        FrameLane::Lane3Canonical => 2,
        FrameLane::Lane4MeshRasterFallback => 3,
        FrameLane::Lane5CloudSplatFallback => 4,
        FrameLane::Lane6Refinement => 5,
    }
}

fn lane_rejection_reason(usage: LaneWorkUsage, budget: LaneWorkBudget) -> Option<RejectionReason> {
    if usage.points > budget.points {
        Some(RejectionReason::LanePointBudget)
    } else if usage.bytes > budget.bytes {
        Some(RejectionReason::LaneByteBudget)
    } else if usage.draw_calls > budget.draw_calls {
        Some(RejectionReason::LaneDrawBudget)
    } else if usage.upload_bytes > budget.upload_bytes {
        Some(RejectionReason::LaneUploadBudget)
    } else if usage.decode_ms > budget.decode_ms {
        Some(RejectionReason::LaneDecodeBudget)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AdmissionCandidate, AdmissionPlanner, BackgroundLaneBudgets, FrameLane, LaneWorkBudget,
        RejectionReason, TileKey,
    };
    use crate::{DatasetId, FrameBudget, ResourceBudget, ResourceCost, TileId};

    fn key(dataset: &str, tile: &str) -> TileKey {
        TileKey {
            dataset_id: DatasetId(dataset.to_owned()),
            tile_id: TileId(tile.to_owned()),
        }
    }

    fn candidate(dataset: &str, tile: &str, benefit: f64, gpu_bytes: u64) -> AdmissionCandidate {
        AdmissionCandidate {
            key: key(dataset, tile),
            lane: FrameLane::Lane6Refinement,
            benefit,
            cost: ResourceCost {
                gpu_buffer_bytes: gpu_bytes,
                ..ResourceCost::default()
            },
            decode_ms: 0.25,
            upload_bytes: gpu_bytes,
            starts_request: true,
        }
    }

    fn lane_candidate(
        dataset: &str,
        tile: &str,
        lane: FrameLane,
        benefit: f64,
        points: u64,
    ) -> AdmissionCandidate {
        let mut candidate = candidate(dataset, tile, benefit, points.saturating_mul(16));
        candidate.lane = lane;
        candidate.cost.points = points;
        candidate.cost.draw_calls = 1;
        candidate
    }

    fn resource_budget(gpu_bytes: u64) -> ResourceBudget {
        ResourceBudget {
            cpu_compressed_bytes: u64::MAX,
            cpu_decoded_bytes: u64::MAX,
            gpu_buffer_bytes: gpu_bytes,
            gpu_texture_bytes: u64::MAX,
            staging_bytes: u64::MAX,
            points: u64::MAX,
            triangles: u64::MAX,
            splats: u64::MAX,
            draw_calls: u32::MAX,
        }
    }

    fn frame_budget(requests: u16) -> FrameBudget {
        FrameBudget {
            target_frame_ms: 16.7,
            traversal_ms: 1.0,
            decode_ms: 10.0,
            upload_bytes: u64::MAX,
            new_requests: requests,
        }
    }

    #[test]
    fn first_round_admits_one_tile_from_each_dataset() {
        let mut planner = AdmissionPlanner::new();
        let plan = planner.plan(
            ResourceCost::default(),
            resource_budget(300),
            frame_budget(3),
            [
                candidate("points", "p-high", 100.0, 100),
                candidate("points", "p-next", 90.0, 100),
                candidate("mesh", "m-high", 80.0, 100),
            ],
        );

        assert_eq!(
            plan.admitted,
            vec![
                key("mesh", "m-high"),
                key("points", "p-high"),
                key("points", "p-next")
            ]
        );
    }

    #[test]
    fn dataset_order_rotates_when_the_budget_only_fits_one() {
        let mut planner = AdmissionPlanner::new();
        let candidates = || {
            [
                candidate("mesh", "root", 1.0, 100),
                candidate("points", "root", 1.0, 100),
            ]
        };
        let first = planner.plan(
            ResourceCost::default(),
            resource_budget(100),
            frame_budget(2),
            candidates(),
        );
        let second = planner.plan(
            ResourceCost::default(),
            resource_budget(100),
            frame_budget(2),
            candidates(),
        );

        assert_ne!(first.admitted, second.admitted);
        assert_eq!(first.admitted.len(), 1);
        assert_eq!(second.admitted.len(), 1);
    }

    #[test]
    fn datasets_share_budget_in_proportion_to_projected_error_not_arrival_order() {
        let candidates = || {
            (0..10)
                .flat_map(|index| {
                    [
                        candidate("high-error", &format!("h-{index}"), 100.0, 100),
                        candidate("low-error", &format!("l-{index}"), 25.0, 100),
                    ]
                })
                .collect::<Vec<_>>()
        };
        let mut forward = AdmissionPlanner::new();
        let first = forward.plan(
            ResourceCost::default(),
            resource_budget(1_000),
            frame_budget(10),
            candidates(),
        );
        let mut reverse = AdmissionPlanner::new();
        let second = reverse.plan(
            ResourceCost::default(),
            resource_budget(1_000),
            frame_budget(10),
            candidates().into_iter().rev(),
        );
        let distribution = |plan: &super::AdmissionPlan| {
            (
                plan.admitted
                    .iter()
                    .filter(|key| key.dataset_id.0 == "high-error")
                    .count(),
                plan.admitted
                    .iter()
                    .filter(|key| key.dataset_id.0 == "low-error")
                    .count(),
            )
        };

        assert_eq!(distribution(&first), distribution(&second));
        assert_eq!(distribution(&first), (8, 2));
    }

    #[test]
    fn frame_request_budget_is_independent_from_residency_budget() {
        let mut planner = AdmissionPlanner::new();
        let plan = planner.plan(
            ResourceCost::default(),
            resource_budget(1_000),
            frame_budget(1),
            [
                candidate("points", "a", 2.0, 100),
                candidate("mesh", "b", 1.0, 100),
            ],
        );

        assert_eq!(plan.admitted.len(), 1);
        assert_eq!(plan.rejected.len(), 1);
        assert_eq!(plan.rejected[0].reason, RejectionReason::FrameBudget);
    }

    #[test]
    fn oversized_frame_work_makes_single_item_progress() {
        let mut planner = AdmissionPlanner::new();
        let plan = planner.plan(
            ResourceCost::default(),
            resource_budget(1_000),
            FrameBudget {
                decode_ms: 0.1,
                upload_bytes: 50,
                new_requests: 1,
                ..frame_budget(1)
            },
            [candidate("points", "large", 10.0, 100)],
        );

        assert_eq!(plan.admitted, vec![key("points", "large")]);
        assert!(plan.decode_ms > 0.1);
        assert_eq!(plan.upload_bytes, 100);
    }

    #[test]
    fn zero_frame_allowance_remains_a_hard_pause() {
        let mut planner = AdmissionPlanner::new();
        let plan = planner.plan(
            ResourceCost::default(),
            resource_budget(1_000),
            FrameBudget {
                decode_ms: 0.0,
                upload_bytes: 0,
                new_requests: 0,
                ..frame_budget(0)
            },
            [candidate("points", "paused", 10.0, 100)],
        );

        assert!(plan.admitted.is_empty());
        assert_eq!(plan.rejected.len(), 1);
        assert_eq!(plan.rejected[0].reason, RejectionReason::FrameBudget);
    }

    #[test]
    fn g_vc_mixed_protected_work_is_first_and_cloud_density_degrades() {
        let mut planner = AdmissionPlanner::new();
        let lane = |points, bytes, draws| LaneWorkBudget {
            points,
            bytes,
            draw_calls: draws,
            upload_bytes: u64::MAX,
            decode_ms: f32::MAX,
        };
        let plan = planner.plan_with_lane_budgets(
            ResourceCost::default(),
            resource_budget(u64::MAX),
            FrameBudget {
                upload_bytes: u64::MAX,
                new_requests: 64,
                ..frame_budget(64)
            },
            BackgroundLaneBudgets {
                lane4: lane(1_000_000, u64::MAX, 8),
                lane5: lane(4_000_000, u64::MAX, 8),
                lane6: lane(4_000_000, u64::MAX, 8),
            },
            [
                lane_candidate("camera", "camera", FrameLane::Lane1CameraClip, 1.0, 0),
                lane_candidate("selection", "pick", FrameLane::Lane2Interaction, 1.0, 0),
                lane_candidate("lines", "5000-lines", FrameLane::Lane3Canonical, 1.0, 0),
                lane_candidate("labels", "500-labels", FrameLane::Lane3Canonical, 1.0, 0),
                lane_candidate(
                    "mesh",
                    "mesh-root",
                    FrameLane::Lane4MeshRasterFallback,
                    30.0,
                    0,
                ),
                lane_candidate(
                    "raster",
                    "raster-root",
                    FrameLane::Lane4MeshRasterFallback,
                    25.0,
                    0,
                ),
                lane_candidate(
                    "cloud-a",
                    "cloud-root",
                    FrameLane::Lane5CloudSplatFallback,
                    100.0,
                    4_000_000,
                ),
                lane_candidate(
                    "cloud-b",
                    "cloud-over-budget",
                    FrameLane::Lane5CloudSplatFallback,
                    90.0,
                    4_000_000,
                ),
                lane_candidate(
                    "splats",
                    "splat-refine",
                    FrameLane::Lane6Refinement,
                    80.0,
                    2_000_000,
                ),
            ],
        );

        assert_eq!(
            &plan.admitted[..4],
            [
                key("camera", "camera"),
                key("selection", "pick"),
                key("labels", "500-labels"),
                key("lines", "5000-lines"),
            ]
        );
        assert!(plan.rejected.iter().all(|item| item.lane.is_background()));
        assert!(plan
            .rejected
            .iter()
            .any(|item| item.reason == RejectionReason::LanePointBudget));
        assert_eq!(plan.lane_usage[2].draw_calls, 2);
        assert_eq!(plan.lane_usage[4].points, 4_000_000);
    }

    #[test]
    fn mixed_provider_fairness_is_stable_under_per_lane_caps() {
        let candidates = || {
            ["cloud", "mesh", "raster", "splats"]
                .into_iter()
                .flat_map(|dataset| {
                    (0..4).map(move |index| {
                        lane_candidate(
                            dataset,
                            &format!("{dataset}-{index}"),
                            FrameLane::Lane6Refinement,
                            100.0 - f64::from(index),
                            10,
                        )
                    })
                })
                .collect::<Vec<_>>()
        };
        let lanes = BackgroundLaneBudgets {
            lane4: LaneWorkBudget::UNLIMITED,
            lane5: LaneWorkBudget::UNLIMITED,
            lane6: LaneWorkBudget {
                points: 80,
                bytes: u64::MAX,
                draw_calls: 8,
                upload_bytes: u64::MAX,
                decode_ms: f32::MAX,
            },
        };
        let mut forward = AdmissionPlanner::new();
        let first = forward.plan_with_lane_budgets(
            ResourceCost::default(),
            resource_budget(u64::MAX),
            frame_budget(16),
            lanes,
            candidates(),
        );
        let mut reverse = AdmissionPlanner::new();
        let second = reverse.plan_with_lane_budgets(
            ResourceCost::default(),
            resource_budget(u64::MAX),
            frame_budget(16),
            lanes,
            candidates().into_iter().rev(),
        );
        let counts = |plan: &super::AdmissionPlan| {
            ["cloud", "mesh", "raster", "splats"].map(|dataset| {
                plan.admitted
                    .iter()
                    .filter(|key| key.dataset_id.0 == dataset)
                    .count()
            })
        };
        assert_eq!(counts(&first), [2, 2, 2, 2]);
        assert_eq!(counts(&first), counts(&second));
    }
}
