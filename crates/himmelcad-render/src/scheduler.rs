//! Deterministic global admission planning across all dataset kinds.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::{DatasetId, FrameBudget, ResourceBudget, ResourceCost, TileId};

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
    /// Candidate priority was NaN or infinite.
    InvalidBenefit,
}

/// Rejected tile with an explicit diagnostic reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedCandidate {
    /// Tile address.
    pub key: TileKey,
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
}

/// Stateful round-robin planner preventing one dataset from consuming all slack.
#[derive(Debug, Default)]
pub struct AdmissionPlanner {
    fairness_cursor: usize,
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
        let mut rejected = Vec::new();
        let mut grouped: BTreeMap<DatasetId, Vec<AdmissionCandidate>> = BTreeMap::new();
        for candidate in candidates {
            if !candidate.benefit.is_finite() {
                rejected.push(RejectedCandidate {
                    key: candidate.key,
                    reason: RejectionReason::InvalidBenefit,
                });
                continue;
            }
            grouped
                .entry(candidate.key.dataset_id.clone())
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

        let mut queues: Vec<WeightedDatasetQueue> = grouped
            .into_values()
            .map(|candidates| WeightedDatasetQueue {
                weight: candidates
                    .first()
                    .map_or(1.0, |candidate| candidate.benefit.max(f64::MIN_POSITIVE)),
                virtual_finish: 0.0,
                candidates: VecDeque::from(candidates),
            })
            .collect();
        if !queues.is_empty() {
            let rotation = self.fairness_cursor % queues.len();
            queues.rotate_left(rotation);
            self.fairness_cursor = (self.fairness_cursor + 1) % queues.len();
        }

        let mut admitted = Vec::new();
        let mut deferred_frame = Vec::new();
        let mut total_cost = baseline;
        let mut decode_ms = 0.0_f32;
        let mut upload_bytes = 0_u64;
        let mut new_requests = 0_u16;
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
                    reason: resource_rejection_reason(next_cost, resource_budget),
                });
                continue;
            }
            let next_decode = decode_ms + candidate.decode_ms.max(0.0);
            let next_upload = upload_bytes.saturating_add(candidate.upload_bytes);
            let next_requests = new_requests.saturating_add(u16::from(candidate.starts_request));
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
            admitted.push(candidate.key);
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
            }) {
                let candidate = deferred_frame.remove(index);
                total_cost = total_cost.saturating_add(candidate.cost);
                decode_ms += candidate.decode_ms.max(0.0);
                upload_bytes = upload_bytes.saturating_add(candidate.upload_bytes);
                new_requests = new_requests.saturating_add(u16::from(candidate.starts_request));
                admitted.push(candidate.key);
            }
        }
        rejected.extend(
            deferred_frame
                .into_iter()
                .map(|candidate| RejectedCandidate {
                    key: candidate.key,
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

#[cfg(test)]
mod tests {
    use super::{AdmissionCandidate, AdmissionPlanner, RejectionReason, TileKey};
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
}
