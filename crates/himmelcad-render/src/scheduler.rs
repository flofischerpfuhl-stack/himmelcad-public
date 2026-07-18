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

        let mut queues: Vec<VecDeque<AdmissionCandidate>> =
            grouped.into_values().map(VecDeque::from).collect();
        if !queues.is_empty() {
            let rotation = self.fairness_cursor % queues.len();
            queues.rotate_left(rotation);
            self.fairness_cursor = (self.fairness_cursor + 1) % queues.len();
        }

        let mut admitted = Vec::new();
        let mut total_cost = baseline;
        let mut decode_ms = 0.0_f32;
        let mut upload_bytes = 0_u64;
        let mut new_requests = 0_u16;
        let mut remaining = queues.iter().map(VecDeque::len).sum::<usize>();
        while remaining > 0 {
            for queue in &mut queues {
                let Some(candidate) = queue.pop_front() else {
                    continue;
                };
                remaining -= 1;
                let next_cost = total_cost.saturating_add(candidate.cost);
                if !resource_budget.contains(next_cost) {
                    rejected.push(RejectedCandidate {
                        key: candidate.key,
                        reason: RejectionReason::ResourceBudget,
                    });
                    continue;
                }
                let next_decode = decode_ms + candidate.decode_ms.max(0.0);
                let next_upload = upload_bytes.saturating_add(candidate.upload_bytes);
                let next_requests =
                    new_requests.saturating_add(u16::from(candidate.starts_request));
                if next_decode > frame_budget.decode_ms
                    || next_upload > frame_budget.upload_bytes
                    || next_requests > frame_budget.new_requests
                {
                    rejected.push(RejectedCandidate {
                        key: candidate.key,
                        reason: RejectionReason::FrameBudget,
                    });
                    continue;
                }
                total_cost = next_cost;
                decode_ms = next_decode;
                upload_bytes = next_upload;
                new_requests = next_requests;
                admitted.push(candidate.key);
            }
        }

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
}
