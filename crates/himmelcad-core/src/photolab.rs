//! Authoritative Photolab processing-profile contracts.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;

/// User-facing quality choice. The profile is resolved before a run is queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlignmentQualityProfile {
    /// Dual sparse matching on every candidate pair with quality-gated large backends.
    QualityHybrid,
    /// Expanded graph and the largest approved feature budgets.
    MaximumRobustness,
    /// Learned sparse primary path with classical and large backends as rescue.
    Fast,
}

/// Sparse feature/matcher combinations supported by the frozen plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SparseMatchingBackend {
    AlikedN32LightGlue,
    SiftLightGlue,
}

/// Scope on which a backend is scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchingScope {
    AllCandidatePairs,
    QualityGated,
}

/// Candidate-pair graph breadth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairGraphMode {
    ReferenceSequenceRetrieval,
    ExpandedReferenceSequenceRetrieval,
}

/// Approved large learned sparse backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LargeMatchingBackend {
    DedodeV2G,
}

/// Request sent by UI, CLI or scripting before queueing an alignment run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAlignmentProfileRequest {
    pub profile: AlignmentQualityProfile,
    pub image_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_image_edge_override: Option<u32>,
}

/// Fully resolved, immutable alignment settings persisted with a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAlignmentConfig {
    pub schema_version: u32,
    pub profile: AlignmentQualityProfile,
    pub image_count: u32,
    pub offline_required: bool,
    pub pair_graph_mode: PairGraphMode,
    pub sparse_backends: Vec<SparseMatchingBackend>,
    pub learned_sparse_scope: MatchingScope,
    pub sift_scope: MatchingScope,
    pub large_backend: LargeMatchingBackend,
    pub large_backend_scope: MatchingScope,
    pub dense_rescue_enabled: bool,
    pub max_image_edge: u32,
    pub keypoints_per_megapixel: u32,
    pub checkpoint_pair_block_size: u32,
    pub cancellation_check_pair_interval: u32,
    pub config_hash: ObjectHash,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ResolveAlignmentProfileError {
    #[error("photo alignment needs at least two images")]
    TooFewImages,
    #[error("max image edge must be between 1024 and 32768 pixels")]
    InvalidMaxImageEdge,
    #[error("failed to serialize resolved alignment configuration: {0}")]
    Serialization(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HashableAlignmentConfig<'a> {
    schema_version: u32,
    profile: AlignmentQualityProfile,
    image_count: u32,
    offline_required: bool,
    pair_graph_mode: PairGraphMode,
    sparse_backends: &'a [SparseMatchingBackend],
    learned_sparse_scope: MatchingScope,
    sift_scope: MatchingScope,
    large_backend: LargeMatchingBackend,
    large_backend_scope: MatchingScope,
    dense_rescue_enabled: bool,
    max_image_edge: u32,
    keypoints_per_megapixel: u32,
    checkpoint_pair_block_size: u32,
    cancellation_check_pair_interval: u32,
}

/// Resolves a user-facing profile into the complete configuration persisted by a run.
pub fn resolve_alignment_profile(
    request: &ResolveAlignmentProfileRequest,
) -> Result<ResolvedAlignmentConfig, ResolveAlignmentProfileError> {
    if request.image_count < 2 {
        return Err(ResolveAlignmentProfileError::TooFewImages);
    }

    let (
        pair_graph_mode,
        learned_sparse_scope,
        sift_scope,
        large_backend_scope,
        default_max_image_edge,
        keypoints_per_megapixel,
        checkpoint_pair_block_size,
    ) = match request.profile {
        AlignmentQualityProfile::QualityHybrid => (
            PairGraphMode::ReferenceSequenceRetrieval,
            MatchingScope::AllCandidatePairs,
            MatchingScope::AllCandidatePairs,
            MatchingScope::QualityGated,
            8_192,
            8_000,
            32,
        ),
        AlignmentQualityProfile::MaximumRobustness => (
            PairGraphMode::ExpandedReferenceSequenceRetrieval,
            MatchingScope::AllCandidatePairs,
            MatchingScope::AllCandidatePairs,
            MatchingScope::AllCandidatePairs,
            12_000,
            12_000,
            16,
        ),
        AlignmentQualityProfile::Fast => (
            PairGraphMode::ReferenceSequenceRetrieval,
            MatchingScope::AllCandidatePairs,
            MatchingScope::QualityGated,
            MatchingScope::QualityGated,
            6_000,
            6_000,
            64,
        ),
    };

    let max_image_edge = request
        .max_image_edge_override
        .unwrap_or(default_max_image_edge);
    if !(1_024..=32_768).contains(&max_image_edge) {
        return Err(ResolveAlignmentProfileError::InvalidMaxImageEdge);
    }

    let sparse_backends = vec![
        SparseMatchingBackend::AlikedN32LightGlue,
        SparseMatchingBackend::SiftLightGlue,
    ];
    let hashable = HashableAlignmentConfig {
        schema_version: 1,
        profile: request.profile,
        image_count: request.image_count,
        offline_required: true,
        pair_graph_mode,
        sparse_backends: &sparse_backends,
        learned_sparse_scope,
        sift_scope,
        large_backend: LargeMatchingBackend::DedodeV2G,
        large_backend_scope,
        dense_rescue_enabled: true,
        max_image_edge,
        keypoints_per_megapixel,
        checkpoint_pair_block_size,
        cancellation_check_pair_interval: 4,
    };
    let encoded = serde_json::to_vec(&hashable)
        .map_err(|error| ResolveAlignmentProfileError::Serialization(error.to_string()))?;

    Ok(ResolvedAlignmentConfig {
        schema_version: hashable.schema_version,
        profile: hashable.profile,
        image_count: hashable.image_count,
        offline_required: hashable.offline_required,
        pair_graph_mode: hashable.pair_graph_mode,
        sparse_backends: sparse_backends.clone(),
        learned_sparse_scope: hashable.learned_sparse_scope,
        sift_scope: hashable.sift_scope,
        large_backend: hashable.large_backend,
        large_backend_scope: hashable.large_backend_scope,
        dense_rescue_enabled: hashable.dense_rescue_enabled,
        max_image_edge: hashable.max_image_edge,
        keypoints_per_megapixel: hashable.keypoints_per_megapixel,
        checkpoint_pair_block_size: hashable.checkpoint_pair_block_size,
        cancellation_check_pair_interval: hashable.cancellation_check_pair_interval,
        config_hash: ObjectHash::of_bytes(&encoded),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(profile: AlignmentQualityProfile) -> ResolveAlignmentProfileRequest {
        ResolveAlignmentProfileRequest {
            profile,
            image_count: 218,
            max_image_edge_override: None,
        }
    }

    #[test]
    fn quality_hybrid_matches_both_sparse_backends_on_all_candidate_pairs() {
        let config = resolve_alignment_profile(&request(AlignmentQualityProfile::QualityHybrid))
            .expect("quality profile must resolve");

        assert_eq!(config.sparse_backends.len(), 2);
        assert_eq!(
            config.learned_sparse_scope,
            MatchingScope::AllCandidatePairs
        );
        assert_eq!(config.sift_scope, MatchingScope::AllCandidatePairs);
        assert_eq!(config.large_backend_scope, MatchingScope::QualityGated);
        assert!(config.offline_required);
        assert!(config.dense_rescue_enabled);
    }

    #[test]
    fn maximum_uses_expanded_graph_and_all_pair_large_backend() {
        let config =
            resolve_alignment_profile(&request(AlignmentQualityProfile::MaximumRobustness))
                .expect("maximum profile must resolve");

        assert_eq!(
            config.pair_graph_mode,
            PairGraphMode::ExpandedReferenceSequenceRetrieval
        );
        assert_eq!(config.large_backend_scope, MatchingScope::AllCandidatePairs);
        assert!(config.keypoints_per_megapixel > 8_000);
    }

    #[test]
    fn fast_keeps_sift_as_quality_gated_rescue() {
        let config = resolve_alignment_profile(&request(AlignmentQualityProfile::Fast))
            .expect("fast profile must resolve");

        assert_eq!(config.sift_scope, MatchingScope::QualityGated);
        assert_eq!(
            config.learned_sparse_scope,
            MatchingScope::AllCandidatePairs
        );
    }

    #[test]
    fn hash_is_stable_and_changes_with_profile() {
        let first = resolve_alignment_profile(&request(AlignmentQualityProfile::QualityHybrid))
            .expect("quality profile must resolve");
        let repeated = resolve_alignment_profile(&request(AlignmentQualityProfile::QualityHybrid))
            .expect("quality profile must resolve repeatedly");
        let maximum =
            resolve_alignment_profile(&request(AlignmentQualityProfile::MaximumRobustness))
                .expect("maximum profile must resolve");

        assert_eq!(first.config_hash, repeated.config_hash);
        assert_ne!(first.config_hash, maximum.config_hash);
    }

    #[test]
    fn rejects_non_alignment_input_and_invalid_override() {
        let too_few = ResolveAlignmentProfileRequest {
            profile: AlignmentQualityProfile::QualityHybrid,
            image_count: 1,
            max_image_edge_override: None,
        };
        assert_eq!(
            resolve_alignment_profile(&too_few),
            Err(ResolveAlignmentProfileError::TooFewImages)
        );

        let invalid_edge = ResolveAlignmentProfileRequest {
            profile: AlignmentQualityProfile::QualityHybrid,
            image_count: 2,
            max_image_edge_override: Some(512),
        };
        assert_eq!(
            resolve_alignment_profile(&invalid_edge),
            Err(ResolveAlignmentProfileError::InvalidMaxImageEdge)
        );
    }
}
