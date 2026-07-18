//! Deterministic domain logic for Photolab's hybrid sparse-matching pipeline.
//!
//! Inference backends only produce hints, observations and metrics. This module
//! turns them into reproducible plans, quality decisions and feature tracks.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::photolab::{
    LargeMatchingBackend, MatchingScope, PairGraphMode, ResolvedAlignmentConfig,
    SparseMatchingBackend,
};

const PER_MILLE: u32 = 1_000;

/// Stable image identity within an alignment run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ImageId(pub u32);

/// Canonically ordered pair of distinct images.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePair {
    pub first: ImageId,
    pub second: ImageId,
}

impl ImagePair {
    /// Constructs a pair independent of input order.
    pub fn new(first: ImageId, second: ImageId) -> Result<Self, MatchingDomainError> {
        if first == second {
            return Err(MatchingDomainError::SelfPair(first));
        }
        Ok(if first < second {
            Self { first, second }
        } else {
            Self {
                first: second,
                second: first,
            }
        })
    }
}

/// Independent source proposing that two images overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairHintSource {
    Gnss,
    Sequence,
    Frustum,
    Retrieval,
}

/// Normalized pair proposal from metadata or a prepared spatial index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairHint {
    pub pair: ImagePair,
    pub source: PairHintSource,
    /// Source-specific confidence in `0..=1000`.
    pub confidence_per_mille: u16,
}

/// Deduplicated evidence for one candidate pair.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gnss_per_mille: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_per_mille: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frustum_per_mille: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retrieval_per_mille: Option<u16>,
}

impl PairEvidence {
    fn record(&mut self, source: PairHintSource, confidence: u16) {
        let slot = match source {
            PairHintSource::Gnss => &mut self.gnss_per_mille,
            PairHintSource::Sequence => &mut self.sequence_per_mille,
            PairHintSource::Frustum => &mut self.frustum_per_mille,
            PairHintSource::Retrieval => &mut self.retrieval_per_mille,
        };
        *slot = Some(slot.map_or(confidence, |current| current.max(confidence)));
    }

    fn value(&self, source: PairHintSource) -> Option<u16> {
        match source {
            PairHintSource::Gnss => self.gnss_per_mille,
            PairHintSource::Sequence => self.sequence_per_mille,
            PairHintSource::Frustum => self.frustum_per_mille,
            PairHintSource::Retrieval => self.retrieval_per_mille,
        }
    }

    fn priority(&self) -> u32 {
        u32::from(self.gnss_per_mille.unwrap_or_default()) * 3
            + u32::from(self.sequence_per_mille.unwrap_or_default()) * 2
            + u32::from(self.frustum_per_mille.unwrap_or_default()) * 4
            + u32::from(self.retrieval_per_mille.unwrap_or_default()) * 2
    }
}

/// Pair accepted into the matching graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePair {
    pub pair: ImagePair,
    pub evidence: PairEvidence,
    /// Deterministic scheduling priority; larger values run first.
    pub priority_score: u32,
}

/// Builds a deduplicated graph from GNSS, sequence, frustum and retrieval hints.
pub fn plan_candidate_pairs(
    config: &ResolvedAlignmentConfig,
    hints: &[PairHint],
) -> Result<Vec<CandidatePair>, MatchingDomainError> {
    let mut by_pair = BTreeMap::<ImagePair, PairEvidence>::new();
    for hint in hints {
        validate_per_mille(u32::from(hint.confidence_per_mille), "pair hint confidence")?;
        let pair = ImagePair::new(hint.pair.first, hint.pair.second)?;
        by_pair
            .entry(pair)
            .or_default()
            .record(hint.source, hint.confidence_per_mille);
    }

    let mut candidates = by_pair
        .into_iter()
        .filter_map(|(pair, evidence)| {
            evidence_passes(&evidence, config.pair_graph_mode).then(|| CandidatePair {
                pair,
                priority_score: evidence.priority(),
                evidence,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .priority_score
            .cmp(&left.priority_score)
            .then_with(|| left.pair.cmp(&right.pair))
    });
    Ok(candidates)
}

fn evidence_passes(evidence: &PairEvidence, mode: PairGraphMode) -> bool {
    let thresholds = match mode {
        PairGraphMode::ReferenceSequenceRetrieval => [300, 400, 250, 600],
        PairGraphMode::ExpandedReferenceSequenceRetrieval => [150, 200, 100, 450],
    };
    [
        PairHintSource::Gnss,
        PairHintSource::Sequence,
        PairHintSource::Frustum,
        PairHintSource::Retrieval,
    ]
    .into_iter()
    .zip(thresholds)
    .any(|(source, threshold)| {
        evidence
            .value(source)
            .is_some_and(|confidence| confidence >= threshold)
    })
}

/// Feature namespace. Cross-family identity is never inferred implicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureFamily {
    Aliked,
    Sift,
    Dedode,
    DenseRescue,
}

/// Runtime matcher represented by the domain plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatcherBackend {
    AlikedN32LightGlue,
    SiftLightGlue,
    DedodeV2G,
    DenseRescue,
}

/// Condition under which a planned pass becomes runnable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PassCondition {
    Always,
    PairQualityGate,
    SparseRescueExhausted,
}

/// One ordered matcher pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchingPass {
    pub ordinal: u8,
    pub backend: MatcherBackend,
    pub condition: PassCondition,
}

/// Frozen backend plan derived solely from the resolved run configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendPassPlan {
    pub passes: Vec<MatchingPass>,
}

/// Resolves all sparse and dense matching passes.
pub fn plan_backend_passes(config: &ResolvedAlignmentConfig) -> BackendPassPlan {
    let mut passes = Vec::new();
    for configured in &config.sparse_backends {
        let (backend, scope) = match configured {
            SparseMatchingBackend::AlikedN32LightGlue => (
                MatcherBackend::AlikedN32LightGlue,
                config.learned_sparse_scope,
            ),
            SparseMatchingBackend::SiftLightGlue => {
                (MatcherBackend::SiftLightGlue, config.sift_scope)
            }
        };
        push_pass(&mut passes, backend, condition_for_scope(scope));
    }
    let large = match config.large_backend {
        LargeMatchingBackend::DedodeV2G => MatcherBackend::DedodeV2G,
    };
    push_pass(
        &mut passes,
        large,
        condition_for_scope(config.large_backend_scope),
    );
    if config.dense_rescue_enabled {
        push_pass(
            &mut passes,
            MatcherBackend::DenseRescue,
            PassCondition::SparseRescueExhausted,
        );
    }
    BackendPassPlan { passes }
}

fn push_pass(passes: &mut Vec<MatchingPass>, backend: MatcherBackend, condition: PassCondition) {
    passes.push(MatchingPass {
        ordinal: u8::try_from(passes.len()).unwrap_or(u8::MAX),
        backend,
        condition,
    });
}

const fn condition_for_scope(scope: MatchingScope) -> PassCondition {
    match scope {
        MatchingScope::AllCandidatePairs => PassCondition::Always,
        MatchingScope::QualityGated => PassCondition::PairQualityGate,
    }
}

/// Raw counts emitted by robust two-view verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairQualityInput {
    pub tentative_matches: u32,
    pub verified_inliers: u32,
    pub homography_inliers: u32,
    pub cheirality_inliers: u32,
    pub occupied_distribution_cells: u16,
    pub distribution_cell_count: u16,
    /// Median triangulation parallax in thousandths of a degree.
    pub median_parallax_millidegrees: u32,
    /// View-graph cycle agreement in `0..=1000`.
    pub cycle_consistency_per_mille: u16,
}

/// Inlier, distribution, parallax and degeneracy metrics for one pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairQuality {
    pub class: PairQualityClass,
    pub score_per_mille: u16,
    pub tentative_matches: u32,
    pub verified_inliers: u32,
    pub inlier_ratio_per_mille: u16,
    pub occupied_distribution_cells: u16,
    pub distribution_cell_count: u16,
    pub distribution_coverage_per_mille: u16,
    pub median_parallax_millidegrees: u32,
    pub homography_share_per_mille: u16,
    pub cheirality_ratio_per_mille: u16,
    pub cycle_consistency_per_mille: u16,
    pub homography_dominant_low_parallax: bool,
    pub insufficient_cheirality: bool,
    pub critically_low_parallax: bool,
}

/// Coarse class consumed by graph and rescue planning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairQualityClass {
    Degenerate,
    Weak,
    Usable,
    Strong,
}

/// Evaluates a result without platform-dependent floating-point thresholds.
pub fn assess_pair_quality(input: PairQualityInput) -> Result<PairQuality, MatchingDomainError> {
    if input.verified_inliers > input.tentative_matches
        || input.homography_inliers > input.tentative_matches
        || input.cheirality_inliers > input.verified_inliers
    {
        return Err(MatchingDomainError::InvalidMetric(
            "geometric inlier counts are inconsistent",
        ));
    }
    if input.distribution_cell_count == 0
        || input.occupied_distribution_cells > input.distribution_cell_count
    {
        return Err(MatchingDomainError::InvalidMetric(
            "distribution grid occupancy is inconsistent",
        ));
    }
    validate_per_mille(
        u32::from(input.cycle_consistency_per_mille),
        "cycle consistency",
    )?;

    let inliers = ratio(input.verified_inliers, input.tentative_matches);
    let coverage = ratio(
        u32::from(input.occupied_distribution_cells),
        u32::from(input.distribution_cell_count),
    );
    let homography = ratio(input.homography_inliers, input.verified_inliers);
    let cheirality = ratio(input.cheirality_inliers, input.verified_inliers);
    let parallax = input
        .median_parallax_millidegrees
        .saturating_mul(PER_MILLE)
        .checked_div(2_000)
        .unwrap_or_default()
        .min(PER_MILLE);
    let homography_dominant_low_parallax =
        homography >= 900 && input.median_parallax_millidegrees < 1_000;
    let insufficient_cheirality = input.verified_inliers > 0 && cheirality < 600;
    let critically_low_parallax = input.median_parallax_millidegrees < 150;
    let degenerate =
        homography_dominant_low_parallax || insufficient_cheirality || critically_low_parallax;
    let class = if degenerate {
        PairQualityClass::Degenerate
    } else if input.verified_inliers >= 40
        && inliers >= 300
        && coverage >= 500
        && input.median_parallax_millidegrees >= 1_000
        && cheirality >= 800
    {
        PairQualityClass::Strong
    } else if input.verified_inliers >= 15
        && inliers >= 150
        && coverage >= 250
        && input.median_parallax_millidegrees >= 300
        && cheirality >= 700
    {
        PairQualityClass::Usable
    } else {
        PairQualityClass::Weak
    };
    let score = (inliers * 3
        + coverage * 2
        + parallax * 2
        + cheirality * 2
        + u32::from(input.cycle_consistency_per_mille))
        / 10;

    Ok(PairQuality {
        class,
        score_per_mille: per_mille(score),
        tentative_matches: input.tentative_matches,
        verified_inliers: input.verified_inliers,
        inlier_ratio_per_mille: per_mille(inliers),
        occupied_distribution_cells: input.occupied_distribution_cells,
        distribution_cell_count: input.distribution_cell_count,
        distribution_coverage_per_mille: per_mille(coverage),
        median_parallax_millidegrees: input.median_parallax_millidegrees,
        homography_share_per_mille: per_mille(homography),
        cheirality_ratio_per_mille: per_mille(cheirality),
        cycle_consistency_per_mille: input.cycle_consistency_per_mille,
        homography_dominant_low_parallax,
        insufficient_cheirality,
        critically_low_parallax,
    })
}

/// Graph state used to decide whether a pair needs rescue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairGraphContext {
    pub first_image_degree: u16,
    pub second_image_degree: u16,
    pub connects_components: bool,
    pub expected_overlap: bool,
    pub registration_failed: bool,
}

/// Observable reason for rescue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RescueReason {
    WeakPairQuality,
    DegenerateGeometry,
    UnderconnectedImage,
    WeakComponentBridge,
    ExpectedOverlapMissing,
    RegistrationFailed,
}

/// Ordered rescue operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RescueAction {
    RunBackend { backend: MatcherBackend },
    ExpandPairGraph,
}

/// Deterministic rescue result with diagnostic causes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RescueDecision {
    pub required: bool,
    pub reasons: Vec<RescueReason>,
    pub actions: Vec<RescueAction>,
}

/// Plans remaining gated backends and graph expansion.
pub fn decide_pair_rescue(
    config: &ResolvedAlignmentConfig,
    quality: &PairQuality,
    graph: PairGraphContext,
    executed: &BTreeSet<MatcherBackend>,
) -> RescueDecision {
    let mut reasons = BTreeSet::new();
    match quality.class {
        PairQualityClass::Degenerate => {
            reasons.insert(RescueReason::DegenerateGeometry);
        }
        PairQualityClass::Weak => {
            reasons.insert(RescueReason::WeakPairQuality);
        }
        PairQualityClass::Usable | PairQualityClass::Strong => {}
    }
    if graph.first_image_degree < 2 || graph.second_image_degree < 2 {
        reasons.insert(RescueReason::UnderconnectedImage);
    }
    if graph.connects_components && quality.class < PairQualityClass::Strong {
        reasons.insert(RescueReason::WeakComponentBridge);
    }
    if graph.expected_overlap && quality.verified_inliers < 30 {
        reasons.insert(RescueReason::ExpectedOverlapMissing);
    }
    if graph.registration_failed {
        reasons.insert(RescueReason::RegistrationFailed);
    }
    let required = !reasons.is_empty();
    let mut actions = Vec::new();
    if required {
        for pass in plan_backend_passes(config).passes {
            if pass.condition != PassCondition::Always && !executed.contains(&pass.backend) {
                actions.push(RescueAction::RunBackend {
                    backend: pass.backend,
                });
            }
        }
        if graph.connects_components
            || graph.first_image_degree < 2
            || graph.second_image_degree < 2
        {
            actions.push(RescueAction::ExpandPairGraph);
        }
    }
    RescueDecision {
        required,
        reasons: reasons.into_iter().collect(),
        actions,
    }
}

fn ratio(numerator: u32, denominator: u32) -> u32 {
    if denominator == 0 {
        0
    } else {
        u32::try_from(
            u64::from(numerator).saturating_mul(u64::from(PER_MILLE)) / u64::from(denominator),
        )
        .unwrap_or(PER_MILLE)
        .min(PER_MILLE)
    }
}

fn per_mille(value: u32) -> u16 {
    u16::try_from(value.min(PER_MILLE)).unwrap_or(1_000)
}

fn validate_per_mille(value: u32, name: &'static str) -> Result<(), MatchingDomainError> {
    if value <= PER_MILLE {
        Ok(())
    } else {
        Err(MatchingDomainError::MetricOutOfRange { name, value })
    }
}

/// Validation failure in matching-domain input.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MatchingDomainError {
    #[error("an image cannot be paired with itself: {0:?}")]
    SelfPair(ImageId),
    #[error("invalid matching metric: {0}")]
    InvalidMetric(&'static str),
    #[error("{name} must be in 0..=1000, received {value}")]
    MetricOutOfRange { name: &'static str, value: u32 },
}

/// Exact feature observation; its family remains part of identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationId {
    pub image: ImageId,
    pub family: FeatureFamily,
    pub feature_index: u32,
}

/// Geometrically verified cross-image correspondence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedCorrespondence {
    pub first: ObservationId,
    pub second: ObservationId,
    pub geometry_confidence_per_mille: u16,
}

/// Explicit same-image evidence that two families observed the same point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationAliasEvidence {
    pub first: ObservationId,
    pub second: ObservationId,
    pub geometry_confidence_per_mille: u16,
}

/// Thresholds for conflict-free track construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMergePolicy {
    pub minimum_correspondence_confidence_per_mille: u16,
    pub minimum_alias_confidence_per_mille: u16,
}

impl Default for TrackMergePolicy {
    fn default() -> Self {
        Self {
            minimum_correspondence_confidence_per_mille: 650,
            minimum_alias_confidence_per_mille: 900,
        }
    }
}

/// Why proposed evidence was not used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackEdgeRejectionReason {
    BelowConfidence,
    AliasAcrossImages,
    AliasWithinFeatureFamily,
    AliasFamilyConflict,
    CorrespondenceWithinImage,
    ConflictingObservationForImage,
}

/// Rejected evidence retained for QA instead of silently dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "edgeType")]
pub enum RejectedTrackEdge {
    Alias {
        evidence: ObservationAliasEvidence,
        reason: TrackEdgeRejectionReason,
    },
    Correspondence {
        correspondence: VerifiedCorrespondence,
        reason: TrackEdgeRejectionReason,
    },
}

/// Canonical observation with retained cross-family aliases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackObservation {
    pub image: ImageId,
    pub primary: ObservationId,
    pub aliases: Vec<ObservationId>,
}

/// Conflict-free multi-view feature track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureTrack {
    pub track_index: u32,
    pub observations: Vec<TrackObservation>,
}

/// Track construction result including rejected evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMergeResult {
    pub tracks: Vec<FeatureTrack>,
    pub rejected_edges: Vec<RejectedTrackEdge>,
}

/// Merges descending-confidence edges while enforcing one canonical
/// observation per image and track.
pub fn merge_feature_tracks(
    correspondences: &[VerifiedCorrespondence],
    alias_evidence: &[ObservationAliasEvidence],
    policy: TrackMergePolicy,
) -> Result<TrackMergeResult, MatchingDomainError> {
    validate_track_input(correspondences, alias_evidence, policy)?;
    let observations = collect_observations(correspondences, alias_evidence);
    let (groups, group_by_observation, mut rejected_edges) =
        build_alias_groups(&observations, alias_evidence, policy);
    let (tracks, correspondence_rejections) =
        merge_correspondence_groups(&groups, &group_by_observation, correspondences, policy);
    rejected_edges.extend(correspondence_rejections);
    Ok(TrackMergeResult {
        tracks,
        rejected_edges,
    })
}

fn validate_track_input(
    correspondences: &[VerifiedCorrespondence],
    aliases: &[ObservationAliasEvidence],
    policy: TrackMergePolicy,
) -> Result<(), MatchingDomainError> {
    validate_per_mille(
        u32::from(policy.minimum_correspondence_confidence_per_mille),
        "minimum correspondence confidence",
    )?;
    validate_per_mille(
        u32::from(policy.minimum_alias_confidence_per_mille),
        "minimum alias confidence",
    )?;
    for edge in correspondences {
        validate_per_mille(
            u32::from(edge.geometry_confidence_per_mille),
            "correspondence confidence",
        )?;
    }
    for edge in aliases {
        validate_per_mille(
            u32::from(edge.geometry_confidence_per_mille),
            "alias confidence",
        )?;
    }
    Ok(())
}

fn collect_observations(
    correspondences: &[VerifiedCorrespondence],
    aliases: &[ObservationAliasEvidence],
) -> Vec<ObservationId> {
    let mut observations = BTreeSet::new();
    for edge in correspondences {
        observations.extend([edge.first, edge.second]);
    }
    for edge in aliases {
        observations.extend([edge.first, edge.second]);
    }
    observations.into_iter().collect()
}

type AliasGroupResult = (
    Vec<TrackObservation>,
    BTreeMap<ObservationId, usize>,
    Vec<RejectedTrackEdge>,
);

fn build_alias_groups(
    observations: &[ObservationId],
    evidence: &[ObservationAliasEvidence],
    policy: TrackMergePolicy,
) -> AliasGroupResult {
    let indices = observations
        .iter()
        .enumerate()
        .map(|(index, observation)| (*observation, index))
        .collect::<BTreeMap<_, _>>();
    let mut sets = DisjointSet::new(observations.len());
    let mut families = observations
        .iter()
        .map(|observation| BTreeSet::from([observation.family]))
        .collect::<Vec<_>>();
    let mut rejected = Vec::new();
    let mut edges = evidence.to_vec();
    sort_alias_edges(&mut edges);

    for edge in edges {
        if let Some(reason) = alias_rejection(edge, policy) {
            rejected.push(RejectedTrackEdge::Alias {
                evidence: edge,
                reason,
            });
            continue;
        }
        let first = sets.find(indices[&edge.first]);
        let second = sets.find(indices[&edge.second]);
        if first == second {
            continue;
        }
        if !families[first].is_disjoint(&families[second]) {
            rejected.push(RejectedTrackEdge::Alias {
                evidence: edge,
                reason: TrackEdgeRejectionReason::AliasFamilyConflict,
            });
            continue;
        }
        let combined = families[first].union(&families[second]).copied().collect();
        let root = sets.union(first, second);
        families[root] = combined;
    }

    let groups = materialize_alias_groups(observations, &mut sets);
    let by_observation = groups
        .iter()
        .enumerate()
        .flat_map(|(index, group)| {
            group
                .aliases
                .iter()
                .copied()
                .map(move |observation| (observation, index))
        })
        .collect();
    (groups, by_observation, rejected)
}

fn alias_rejection(
    edge: ObservationAliasEvidence,
    policy: TrackMergePolicy,
) -> Option<TrackEdgeRejectionReason> {
    if edge.geometry_confidence_per_mille < policy.minimum_alias_confidence_per_mille {
        Some(TrackEdgeRejectionReason::BelowConfidence)
    } else if edge.first.image != edge.second.image {
        Some(TrackEdgeRejectionReason::AliasAcrossImages)
    } else if edge.first.family == edge.second.family {
        Some(TrackEdgeRejectionReason::AliasWithinFeatureFamily)
    } else {
        None
    }
}

fn materialize_alias_groups(
    observations: &[ObservationId],
    sets: &mut DisjointSet,
) -> Vec<TrackObservation> {
    let mut by_root = BTreeMap::<usize, Vec<ObservationId>>::new();
    for (index, observation) in observations.iter().copied().enumerate() {
        by_root
            .entry(sets.find(index))
            .or_default()
            .push(observation);
    }
    by_root
        .into_values()
        .map(|mut aliases| {
            aliases.sort_unstable();
            TrackObservation {
                image: aliases[0].image,
                primary: aliases[0],
                aliases,
            }
        })
        .collect()
}

fn sort_alias_edges(edges: &mut [ObservationAliasEvidence]) {
    edges.sort_by(|left, right| {
        right
            .geometry_confidence_per_mille
            .cmp(&left.geometry_confidence_per_mille)
            .then_with(|| {
                canonical_edge(left.first, left.second)
                    .cmp(&canonical_edge(right.first, right.second))
            })
    });
}

fn merge_correspondence_groups(
    groups: &[TrackObservation],
    group_by_observation: &BTreeMap<ObservationId, usize>,
    correspondences: &[VerifiedCorrespondence],
    policy: TrackMergePolicy,
) -> (Vec<FeatureTrack>, Vec<RejectedTrackEdge>) {
    let mut sets = DisjointSet::new(groups.len());
    let mut images = groups
        .iter()
        .map(|group| BTreeSet::from([group.image]))
        .collect::<Vec<_>>();
    let mut participating = BTreeSet::new();
    let mut rejected = Vec::new();
    let mut edges = correspondences.to_vec();
    sort_correspondences(&mut edges);

    for edge in edges {
        if let Some(reason) = correspondence_rejection(edge, policy) {
            rejected.push(RejectedTrackEdge::Correspondence {
                correspondence: edge,
                reason,
            });
            continue;
        }
        let first_group = group_by_observation[&edge.first];
        let second_group = group_by_observation[&edge.second];
        let first_root = sets.find(first_group);
        let second_root = sets.find(second_group);
        if first_root != second_root && !images[first_root].is_disjoint(&images[second_root]) {
            rejected.push(RejectedTrackEdge::Correspondence {
                correspondence: edge,
                reason: TrackEdgeRejectionReason::ConflictingObservationForImage,
            });
            continue;
        }
        participating.extend([first_group, second_group]);
        if first_root != second_root {
            let combined = images[first_root]
                .union(&images[second_root])
                .copied()
                .collect();
            let root = sets.union(first_root, second_root);
            images[root] = combined;
        }
    }
    (
        materialize_tracks(groups, &mut sets, participating),
        rejected,
    )
}

fn correspondence_rejection(
    edge: VerifiedCorrespondence,
    policy: TrackMergePolicy,
) -> Option<TrackEdgeRejectionReason> {
    if edge.geometry_confidence_per_mille < policy.minimum_correspondence_confidence_per_mille {
        Some(TrackEdgeRejectionReason::BelowConfidence)
    } else if edge.first.image == edge.second.image {
        Some(TrackEdgeRejectionReason::CorrespondenceWithinImage)
    } else {
        None
    }
}

fn sort_correspondences(edges: &mut [VerifiedCorrespondence]) {
    edges.sort_by(|left, right| {
        right
            .geometry_confidence_per_mille
            .cmp(&left.geometry_confidence_per_mille)
            .then_with(|| {
                canonical_edge(left.first, left.second)
                    .cmp(&canonical_edge(right.first, right.second))
            })
    });
}

fn materialize_tracks(
    groups: &[TrackObservation],
    sets: &mut DisjointSet,
    participating: BTreeSet<usize>,
) -> Vec<FeatureTrack> {
    let mut by_track = BTreeMap::<usize, Vec<TrackObservation>>::new();
    for group in participating {
        by_track
            .entry(sets.find(group))
            .or_default()
            .push(groups[group].clone());
    }
    let mut tracks = by_track
        .into_values()
        .filter(|track| track.len() >= 2)
        .collect::<Vec<_>>();
    for track in &mut tracks {
        track.sort_by_key(|observation| (observation.image, observation.primary));
    }
    tracks.sort_by_key(|track| track[0].primary);
    tracks
        .into_iter()
        .enumerate()
        .map(|(index, observations)| FeatureTrack {
            track_index: u32::try_from(index).unwrap_or(u32::MAX),
            observations,
        })
        .collect()
}

fn canonical_edge(first: ObservationId, second: ObservationId) -> (ObservationId, ObservationId) {
    if first <= second {
        (first, second)
    } else {
        (second, first)
    }
}

#[derive(Debug)]
struct DisjointSet {
    parent: Vec<usize>,
    size: Vec<usize>,
}

impl DisjointSet {
    fn new(len: usize) -> Self {
        Self {
            parent: (0..len).collect(),
            size: vec![1; len],
        }
    }

    fn find(&mut self, index: usize) -> usize {
        let mut root = index;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        let mut current = index;
        while self.parent[current] != current {
            let parent = self.parent[current];
            self.parent[current] = root;
            current = parent;
        }
        root
    }

    fn union(&mut self, first: usize, second: usize) -> usize {
        let mut first = self.find(first);
        let mut second = self.find(second);
        if first == second {
            return first;
        }
        if self.size[first] < self.size[second]
            || (self.size[first] == self.size[second] && second < first)
        {
            std::mem::swap(&mut first, &mut second);
        }
        self.parent[second] = first;
        self.size[first] += self.size[second];
        first
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photolab::{
        resolve_alignment_profile, AlignmentQualityProfile, ResolveAlignmentProfileRequest,
    };

    fn config(profile: AlignmentQualityProfile) -> ResolvedAlignmentConfig {
        resolve_alignment_profile(&ResolveAlignmentProfileRequest {
            profile,
            image_count: 20,
            max_image_edge_override: None,
            keypoints_per_megapixel_override: None,
        })
        .expect("profile should resolve")
    }

    fn pair(first: u32, second: u32) -> ImagePair {
        ImagePair::new(ImageId(first), ImageId(second)).expect("pair should be valid")
    }

    fn observation(image: u32, family: FeatureFamily, feature_index: u32) -> ObservationId {
        ObservationId {
            image: ImageId(image),
            family,
            feature_index,
        }
    }

    #[test]
    fn candidate_planning_deduplicates_and_expands() {
        let hints = [
            PairHint {
                pair: pair(2, 1),
                source: PairHintSource::Gnss,
                confidence_per_mille: 350,
            },
            PairHint {
                pair: pair(1, 2),
                source: PairHintSource::Frustum,
                confidence_per_mille: 700,
            },
            PairHint {
                pair: pair(3, 4),
                source: PairHintSource::Sequence,
                confidence_per_mille: 250,
            },
        ];
        let quality = plan_candidate_pairs(&config(AlignmentQualityProfile::QualityHybrid), &hints)
            .expect("quality candidates should plan");
        let expanded =
            plan_candidate_pairs(&config(AlignmentQualityProfile::MaximumRobustness), &hints)
                .expect("expanded candidates should plan");

        assert_eq!(quality.len(), 1);
        assert_eq!(quality[0].pair, pair(1, 2));
        assert_eq!(quality[0].evidence.gnss_per_mille, Some(350));
        assert_eq!(quality[0].evidence.frustum_per_mille, Some(700));
        assert_eq!(expanded.len(), 2);
    }

    #[test]
    fn backend_plan_respects_profile_scopes() {
        let quality = plan_backend_passes(&config(AlignmentQualityProfile::QualityHybrid));
        assert_eq!(quality.passes[0].condition, PassCondition::Always);
        assert_eq!(quality.passes[1].condition, PassCondition::Always);
        assert_eq!(quality.passes[2].condition, PassCondition::PairQualityGate);
        assert_eq!(
            quality.passes[3].condition,
            PassCondition::SparseRescueExhausted
        );

        let fast = plan_backend_passes(&config(AlignmentQualityProfile::Fast));
        assert_eq!(fast.passes[1].backend, MatcherBackend::SiftLightGlue);
        assert_eq!(fast.passes[1].condition, PassCondition::PairQualityGate);
    }

    #[test]
    fn quality_assessment_detects_good_and_degenerate_geometry() {
        let strong = assess_pair_quality(PairQualityInput {
            tentative_matches: 100,
            verified_inliers: 70,
            homography_inliers: 20,
            cheirality_inliers: 65,
            occupied_distribution_cells: 14,
            distribution_cell_count: 16,
            median_parallax_millidegrees: 2_500,
            cycle_consistency_per_mille: 950,
        })
        .expect("metrics should be valid");
        assert_eq!(strong.class, PairQualityClass::Strong);
        assert_eq!(strong.inlier_ratio_per_mille, 700);

        let degenerate = assess_pair_quality(PairQualityInput {
            tentative_matches: 100,
            verified_inliers: 80,
            homography_inliers: 78,
            cheirality_inliers: 75,
            occupied_distribution_cells: 15,
            distribution_cell_count: 16,
            median_parallax_millidegrees: 200,
            cycle_consistency_per_mille: 900,
        })
        .expect("metrics should be valid");
        assert_eq!(degenerate.class, PairQualityClass::Degenerate);
        assert!(degenerate.homography_dominant_low_parallax);
    }

    #[test]
    fn rescue_uses_remaining_backends_and_expands_bridge() {
        let quality = assess_pair_quality(PairQualityInput {
            tentative_matches: 40,
            verified_inliers: 8,
            homography_inliers: 3,
            cheirality_inliers: 7,
            occupied_distribution_cells: 2,
            distribution_cell_count: 16,
            median_parallax_millidegrees: 500,
            cycle_consistency_per_mille: 500,
        })
        .expect("metrics should be valid");
        let decision = decide_pair_rescue(
            &config(AlignmentQualityProfile::Fast),
            &quality,
            PairGraphContext {
                first_image_degree: 1,
                second_image_degree: 3,
                connects_components: true,
                expected_overlap: true,
                registration_failed: false,
            },
            &BTreeSet::from([MatcherBackend::AlikedN32LightGlue]),
        );
        assert!(decision.required);
        assert!(decision.actions.contains(&RescueAction::RunBackend {
            backend: MatcherBackend::SiftLightGlue,
        }));
        assert!(decision.actions.contains(&RescueAction::ExpandPairGraph));
    }

    #[test]
    fn aliases_preserve_families_but_form_one_observation() {
        let learned = observation(1, FeatureFamily::Aliked, 10);
        let sift = observation(1, FeatureFamily::Sift, 42);
        let other = observation(2, FeatureFamily::Aliked, 11);
        let result = merge_feature_tracks(
            &[
                VerifiedCorrespondence {
                    first: learned,
                    second: other,
                    geometry_confidence_per_mille: 920,
                },
                VerifiedCorrespondence {
                    first: sift,
                    second: other,
                    geometry_confidence_per_mille: 910,
                },
            ],
            &[ObservationAliasEvidence {
                first: learned,
                second: sift,
                geometry_confidence_per_mille: 970,
            }],
            TrackMergePolicy::default(),
        )
        .expect("aliases should merge");

        assert_eq!(result.tracks.len(), 1);
        assert_eq!(result.tracks[0].observations.len(), 2);
        assert_eq!(result.tracks[0].observations[0].aliases.len(), 2);
        assert!(result.rejected_edges.is_empty());
    }

    #[test]
    fn lower_confidence_edge_cannot_create_image_conflict() {
        let one_a = observation(1, FeatureFamily::Aliked, 1);
        let one_b = observation(1, FeatureFamily::Aliked, 2);
        let two = observation(2, FeatureFamily::Aliked, 3);
        let three = observation(3, FeatureFamily::Aliked, 4);
        let result = merge_feature_tracks(
            &[
                VerifiedCorrespondence {
                    first: one_a,
                    second: two,
                    geometry_confidence_per_mille: 950,
                },
                VerifiedCorrespondence {
                    first: one_b,
                    second: three,
                    geometry_confidence_per_mille: 900,
                },
                VerifiedCorrespondence {
                    first: two,
                    second: three,
                    geometry_confidence_per_mille: 700,
                },
            ],
            &[],
            TrackMergePolicy::default(),
        )
        .expect("conflict should be reported");

        assert_eq!(result.tracks.len(), 2);
        assert!(result.rejected_edges.iter().any(|edge| matches!(
            edge,
            RejectedTrackEdge::Correspondence {
                reason: TrackEdgeRejectionReason::ConflictingObservationForImage,
                ..
            }
        )));
    }

    #[test]
    fn domain_outputs_round_trip_through_serde() {
        let quality = assess_pair_quality(PairQualityInput {
            tentative_matches: 50,
            verified_inliers: 30,
            homography_inliers: 10,
            cheirality_inliers: 28,
            occupied_distribution_cells: 10,
            distribution_cell_count: 16,
            median_parallax_millidegrees: 1_500,
            cycle_consistency_per_mille: 800,
        })
        .expect("metrics should be valid");
        let json = serde_json::to_string(&quality).expect("serialize");
        let decoded: PairQuality = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(decoded, quality);
    }
}
