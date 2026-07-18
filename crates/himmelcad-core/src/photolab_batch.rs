//! Versioned Photolab batch DAG, scope, recovery and resource-planning contracts.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;
use crate::photolab::ResolvedAlignmentConfig;
use crate::photolab_gcp::GcpPointId;
use crate::photolab_matching::ImageId;
use crate::photolab_models::{HardwareCapabilities, ModelBackend};
use crate::photolab_products::DemSurfaceKind;

pub const BATCH_SCHEMA: &str = "himmelcad.photolab.batch";
pub const BATCH_SCHEMA_VERSION: u32 = 1;
const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BatchNodeId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProcessingSetId(pub String);

/// Immutable image membership to which every node and residual report is bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingSetScope {
    pub id: ProcessingSetId,
    pub label: String,
    pub image_ids: Vec<ImageId>,
    pub membership_sha256: ObjectHash,
}

impl ProcessingSetScope {
    pub fn new(
        id: ProcessingSetId,
        label: String,
        mut image_ids: Vec<ImageId>,
    ) -> Result<Self, BatchError> {
        image_ids.sort();
        if image_ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(BatchError::InvalidProcessingSet("image ids must be unique"));
        }
        let membership_sha256 = processing_set_hash(&id, &image_ids)?;
        let scope = Self {
            id,
            label,
            image_ids,
            membership_sha256,
        };
        scope.validate()?;
        Ok(scope)
    }

    pub fn validate(&self) -> Result<(), BatchError> {
        validate_id(&self.id.0, "processing set id")?;
        if self.label.trim().is_empty() {
            return Err(BatchError::InvalidProcessingSet("label must not be empty"));
        }
        if self.image_ids.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(BatchError::InvalidProcessingSet(
                "image ids must be sorted and unique",
            ));
        }
        let expected = processing_set_hash(&self.id, &self.image_ids)?;
        if self.membership_sha256 != expected {
            return Err(BatchError::InvalidProcessingSet(
                "membership hash does not match image ids",
            ));
        }
        Ok(())
    }
}

fn processing_set_hash(
    id: &ProcessingSetId,
    image_ids: &[ImageId],
) -> Result<ObjectHash, BatchError> {
    serde_json::to_vec(&(id, image_ids))
        .map(|bytes| ObjectHash::of_bytes(&bytes))
        .map_err(|error| BatchError::Serialization(error.to_string()))
}

/// Exact scope displayed above every GCP residual table and exported report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualReportScope {
    pub processing_set_id: ProcessingSetId,
    pub alignment_node_id: BatchNodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimization_node_id: Option<BatchNodeId>,
    pub camera_image_ids: Vec<ImageId>,
    pub control_point_ids: Vec<GcpPointId>,
    pub checkpoint_point_ids: Vec<GcpPointId>,
}

impl ResidualReportScope {
    fn validate(&self, processing_set: &ProcessingSetScope) -> Result<(), BatchError> {
        if self.processing_set_id != processing_set.id {
            return Err(BatchError::InvalidResidualScope(
                "processing set does not match report node",
            ));
        }
        validate_id(&self.alignment_node_id.0, "alignment node id")?;
        validate_sorted_unique(&self.camera_image_ids, "camera image ids")?;
        validate_sorted_unique(&self.control_point_ids, "control point ids")?;
        validate_sorted_unique(&self.checkpoint_point_ids, "checkpoint point ids")?;
        if self.control_point_ids.is_empty() && self.checkpoint_point_ids.is_empty() {
            return Err(BatchError::InvalidResidualScope(
                "at least one control or checkpoint is required",
            ));
        }
        if self
            .control_point_ids
            .iter()
            .any(|id| self.checkpoint_point_ids.binary_search(id).is_ok())
        {
            return Err(BatchError::InvalidResidualScope(
                "a GCP cannot be control and checkpoint in one report",
            ));
        }
        if self
            .camera_image_ids
            .iter()
            .any(|id| processing_set.image_ids.binary_search(id).is_err())
        {
            return Err(BatchError::InvalidResidualScope(
                "camera image lies outside the processing set",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchArtifactKind {
    ImportedImages,
    TransformedImages,
    QualityReport,
    Alignment,
    OptimizedAlignment,
    DepthMaps,
    DensePointCloud,
    ClassifiedGround,
    Dem,
    Orthomosaic,
    Mesh,
    GaussianSplat,
    ProcessingReport,
    ExportPackage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDependency {
    pub node_id: BatchNodeId,
    pub artifact: BatchArtifactKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuplicateImagePolicy {
    SkipIdentical,
    KeepSeparateReferences,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStageConfig {
    pub copy_sources_into_project: bool,
    pub recursive_folders: bool,
    pub duplicate_policy: DuplicateImagePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformStageConfig {
    pub frozen_transformation_sha256: ObjectHash,
    pub transform_horizontal: bool,
    pub transform_height: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityStageConfig {
    pub estimate_blur: bool,
    pub estimate_exposure: bool,
    pub minimum_quality_score: f64,
    pub automatically_disable_below_threshold: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignStageConfig {
    pub resolved: ResolvedAlignmentConfig,
    pub use_reference_positions: bool,
    pub generic_preselection: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizeStageConfig {
    pub optimization_snapshot_sha256: ObjectHash,
    pub focal_length: OptimizationParameterMode,
    pub principal_point: OptimizationParameterMode,
    pub distortion: OptimizationParameterMode,
    pub camera_positions: OptimizationParameterMode,
    pub residual_scope: ResidualReportScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OptimizationParameterMode {
    Fixed,
    Optimize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DepthFilterStrength {
    Mild,
    Moderate,
    Aggressive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthStageConfig {
    pub image_downscale: u8,
    pub filter: DepthFilterStrength,
    pub reuse_compatible_maps: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenseStageConfig {
    pub minimum_views: u8,
    pub retain_confidence: bool,
    pub calculate_colors: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundStageConfig {
    pub maximum_angle_degrees: f64,
    pub maximum_distance_meters: f64,
    pub cell_size_meters: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemStageConfig {
    pub surface: DemSurfaceKind,
    pub resolution_meters_per_pixel: f64,
    pub interpolate_nodata: bool,
    pub tile_size_pixels: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrthomosaicBlendMode {
    Mosaic,
    Average,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrthomosaicStageConfig {
    pub resolution_meters_per_pixel: f64,
    pub blend_mode: OrthomosaicBlendMode,
    pub color_correction: bool,
    pub fill_holes: bool,
    pub tile_size_pixels: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshStageConfig {
    pub target_face_count: u64,
    pub interpolate_holes: bool,
    pub build_texture: bool,
    pub texture_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SplatInitialization {
    DensePointCloud,
    MeshSurface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplatStageConfig {
    pub initialization: SplatInitialization,
    pub iterations: u32,
    pub spherical_harmonics_degree: u8,
    pub maximum_splats: u64,
    pub retain_training_checkpoints: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStageConfig {
    pub title: String,
    pub residual_scope: ResidualReportScope,
    pub include_processing_parameters: bool,
    pub include_hardware_audit: bool,
    pub include_lineage: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Las,
    Laz,
    E57,
    GeoTiff,
    Cog,
    Obj,
    Gltf,
    Ply,
    SplatPly,
    JsonReport,
    PdfReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub source_artifact: BatchArtifactKind,
    pub format: ExportFormat,
    pub relative_output_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStageConfig {
    pub items: Vec<ExportItem>,
    pub overwrite_existing: bool,
    pub write_checksums: bool,
}

/// Every stage has its own serializable configuration; no untyped option bag exists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "config", rename_all = "camelCase")]
pub enum BatchStageConfig {
    Import(ImportStageConfig),
    Transform(TransformStageConfig),
    Quality(QualityStageConfig),
    Align(AlignStageConfig),
    GcpOptimize(GcpOptimizeStageConfig),
    Depth(DepthStageConfig),
    Dense(DenseStageConfig),
    Ground(GroundStageConfig),
    Dem(DemStageConfig),
    Orthomosaic(OrthomosaicStageConfig),
    Mesh(MeshStageConfig),
    GaussianSplat(SplatStageConfig),
    Report(ReportStageConfig),
    Export(ExportStageConfig),
}

impl BatchStageConfig {
    #[must_use]
    pub const fn output(&self) -> BatchArtifactKind {
        match self {
            Self::Import(_) => BatchArtifactKind::ImportedImages,
            Self::Transform(_) => BatchArtifactKind::TransformedImages,
            Self::Quality(_) => BatchArtifactKind::QualityReport,
            Self::Align(_) => BatchArtifactKind::Alignment,
            Self::GcpOptimize(_) => BatchArtifactKind::OptimizedAlignment,
            Self::Depth(_) => BatchArtifactKind::DepthMaps,
            Self::Dense(_) => BatchArtifactKind::DensePointCloud,
            Self::Ground(_) => BatchArtifactKind::ClassifiedGround,
            Self::Dem(_) => BatchArtifactKind::Dem,
            Self::Orthomosaic(_) => BatchArtifactKind::Orthomosaic,
            Self::Mesh(_) => BatchArtifactKind::Mesh,
            Self::GaussianSplat(_) => BatchArtifactKind::GaussianSplat,
            Self::Report(_) => BatchArtifactKind::ProcessingReport,
            Self::Export(_) => BatchArtifactKind::ExportPackage,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchNode {
    pub id: BatchNodeId,
    pub label: String,
    pub processing_set_id: ProcessingSetId,
    pub dependencies: Vec<BatchDependency>,
    pub config: BatchStageConfig,
    pub enabled: bool,
}

/// Mandatory recovery behavior for every long-running batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeCheckpointPolicy {
    IntervalAndNodeBoundary,
    IntervalOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputCommitPolicy {
    AtomicDiscardPartialOnCancel,
    UnsafeDirectWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UncleanShutdownPolicy {
    ResumeFromCheckpoint,
    ManualRecoveryOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResiliencePolicy {
    pub autosave_interval_seconds: u16,
    pub checkpoint_interval_seconds: u16,
    pub cancellation_poll_interval_milliseconds: u16,
    pub node_checkpoints: NodeCheckpointPolicy,
    pub output_commit: OutputCommitPolicy,
    pub unclean_shutdown: UncleanShutdownPolicy,
}

impl BatchResiliencePolicy {
    pub fn validate(&self) -> Result<(), BatchError> {
        if !(5..=300).contains(&self.autosave_interval_seconds) {
            return Err(BatchError::InvalidResiliencePolicy(
                "autosave interval must be 5..=300 seconds",
            ));
        }
        if !(5..=900).contains(&self.checkpoint_interval_seconds) {
            return Err(BatchError::InvalidResiliencePolicy(
                "checkpoint interval must be 5..=900 seconds",
            ));
        }
        if !(10..=1_000).contains(&self.cancellation_poll_interval_milliseconds) {
            return Err(BatchError::InvalidResiliencePolicy(
                "cancellation polling must be 10..=1000 milliseconds",
            ));
        }
        if self.node_checkpoints != NodeCheckpointPolicy::IntervalAndNodeBoundary
            || self.output_commit != OutputCommitPolicy::AtomicDiscardPartialOnCancel
            || self.unclean_shutdown != UncleanShutdownPolicy::ResumeFromCheckpoint
        {
            return Err(BatchError::InvalidResiliencePolicy(
                "checkpoint, atomic commit, recovery and partial-output cleanup are mandatory",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabBatch {
    pub schema: String,
    pub schema_version: u32,
    pub name: String,
    pub processing_sets: Vec<ProcessingSetScope>,
    pub nodes: Vec<BatchNode>,
    pub resilience: BatchResiliencePolicy,
}

impl PhotolabBatch {
    pub fn validate(&self) -> Result<ValidatedBatch, BatchError> {
        validate_document_header(self)?;
        self.resilience.validate()?;
        let processing_sets = validate_processing_sets(self)?;
        let nodes = validate_node_index(self)?;
        validate_node_contracts(self, &processing_sets, &nodes)?;
        let topological_order = topological_order(&nodes)?;
        validate_report_lineage(self, &nodes)?;
        let lineages = build_lineages(&topological_order, &nodes, &processing_sets)?;
        let document_sha256 = serde_json::to_vec(self)
            .map(|bytes| ObjectHash::of_bytes(&bytes))
            .map_err(|error| BatchError::Serialization(error.to_string()))?;
        Ok(ValidatedBatch {
            batch: self.clone(),
            topological_order,
            lineages,
            document_sha256,
        })
    }

    pub fn to_json_pretty(&self) -> Result<String, BatchError> {
        self.validate()?;
        serde_json::to_string_pretty(self)
            .map_err(|error| BatchError::Serialization(error.to_string()))
    }

    pub fn from_json(json: &str) -> Result<ValidatedBatch, BatchError> {
        let value: serde_json::Value = serde_json::from_str(json)
            .map_err(|error| BatchError::Serialization(error.to_string()))?;
        let version = value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or(BatchError::MissingSchemaVersion)?;
        if version != u64::from(BATCH_SCHEMA_VERSION) {
            return Err(BatchError::UnsupportedSchemaVersion(version));
        }
        let batch: Self = serde_json::from_value(value)
            .map_err(|error| BatchError::Serialization(error.to_string()))?;
        batch.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchLineageInput {
    pub node_id: BatchNodeId,
    pub artifact: BatchArtifactKind,
    pub lineage_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchNodeLineage {
    pub node_id: BatchNodeId,
    pub processing_set_id: ProcessingSetId,
    pub processing_set_membership_sha256: ObjectHash,
    pub config_sha256: ObjectHash,
    pub inputs: Vec<BatchLineageInput>,
    pub lineage_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedBatch {
    batch: PhotolabBatch,
    topological_order: Vec<BatchNodeId>,
    lineages: Vec<BatchNodeLineage>,
    document_sha256: ObjectHash,
}

impl ValidatedBatch {
    #[must_use]
    pub const fn batch(&self) -> &PhotolabBatch {
        &self.batch
    }

    #[must_use]
    pub fn topological_order(&self) -> &[BatchNodeId] {
        &self.topological_order
    }

    #[must_use]
    pub const fn document_sha256(&self) -> &ObjectHash {
        &self.document_sha256
    }

    #[must_use]
    pub fn lineages(&self) -> &[BatchNodeLineage] {
        &self.lineages
    }
}

fn validate_document_header(batch: &PhotolabBatch) -> Result<(), BatchError> {
    if batch.schema != BATCH_SCHEMA {
        return Err(BatchError::InvalidSchema(batch.schema.clone()));
    }
    if batch.schema_version != BATCH_SCHEMA_VERSION {
        return Err(BatchError::UnsupportedSchemaVersion(u64::from(
            batch.schema_version,
        )));
    }
    if batch.name.trim().is_empty() {
        return Err(BatchError::EmptyBatchName);
    }
    if batch.nodes.is_empty() {
        return Err(BatchError::EmptyBatch);
    }
    Ok(())
}

fn validate_processing_sets(
    batch: &PhotolabBatch,
) -> Result<BTreeMap<ProcessingSetId, &ProcessingSetScope>, BatchError> {
    let mut sets = BTreeMap::new();
    for scope in &batch.processing_sets {
        scope.validate()?;
        if sets.insert(scope.id.clone(), scope).is_some() {
            return Err(BatchError::DuplicateProcessingSet(scope.id.clone()));
        }
    }
    if sets.is_empty() {
        return Err(BatchError::InvalidProcessingSet(
            "batch needs at least one processing set",
        ));
    }
    Ok(sets)
}

fn validate_node_index(
    batch: &PhotolabBatch,
) -> Result<BTreeMap<BatchNodeId, &BatchNode>, BatchError> {
    let mut nodes = BTreeMap::new();
    for node in &batch.nodes {
        validate_id(&node.id.0, "node id")?;
        if node.label.trim().is_empty() {
            return Err(BatchError::InvalidNode(node.id.clone(), "empty label"));
        }
        if nodes.insert(node.id.clone(), node).is_some() {
            return Err(BatchError::DuplicateNode(node.id.clone()));
        }
    }
    Ok(nodes)
}

fn validate_node_contracts(
    batch: &PhotolabBatch,
    processing_sets: &BTreeMap<ProcessingSetId, &ProcessingSetScope>,
    nodes: &BTreeMap<BatchNodeId, &BatchNode>,
) -> Result<(), BatchError> {
    for node in &batch.nodes {
        let scope = processing_sets
            .get(&node.processing_set_id)
            .ok_or_else(|| BatchError::UnknownProcessingSet(node.processing_set_id.clone()))?;
        if scope.image_ids.is_empty() && !matches!(node.config, BatchStageConfig::Import(_)) {
            let has_import = batch.nodes.iter().any(|candidate| {
                candidate.processing_set_id == node.processing_set_id
                    && matches!(candidate.config, BatchStageConfig::Import(_))
            });
            if !has_import {
                return Err(BatchError::InvalidProcessingSet(
                    "empty processing set needs an import node",
                ));
            }
        }
        validate_dependencies(node, nodes)?;
        validate_stage_config(node, scope)?;
    }
    Ok(())
}

fn validate_dependencies(
    node: &BatchNode,
    nodes: &BTreeMap<BatchNodeId, &BatchNode>,
) -> Result<(), BatchError> {
    let mut seen = BTreeSet::new();
    for dependency in &node.dependencies {
        if !seen.insert(dependency.node_id.clone()) {
            return Err(BatchError::DuplicateDependency {
                node: node.id.clone(),
                dependency: dependency.node_id.clone(),
            });
        }
        let producer =
            nodes
                .get(&dependency.node_id)
                .ok_or_else(|| BatchError::UnknownDependency {
                    node: node.id.clone(),
                    dependency: dependency.node_id.clone(),
                })?;
        if producer.config.output() != dependency.artifact {
            return Err(BatchError::DependencyArtifactMismatch {
                node: node.id.clone(),
                dependency: dependency.node_id.clone(),
            });
        }
        if producer.processing_set_id != node.processing_set_id {
            return Err(BatchError::CrossProcessingSetDependency {
                node: node.id.clone(),
                dependency: dependency.node_id.clone(),
            });
        }
        if node.enabled && !producer.enabled {
            return Err(BatchError::DisabledDependency {
                node: node.id.clone(),
                dependency: dependency.node_id.clone(),
            });
        }
    }
    validate_required_artifacts(node)
}

fn validate_required_artifacts(node: &BatchNode) -> Result<(), BatchError> {
    let artifacts: BTreeSet<_> = node.dependencies.iter().map(|item| item.artifact).collect();
    let has = |artifact| artifacts.contains(&artifact);
    let has_images =
        has(BatchArtifactKind::ImportedImages) || has(BatchArtifactKind::TransformedImages);
    let has_alignment =
        has(BatchArtifactKind::Alignment) || has(BatchArtifactKind::OptimizedAlignment);
    let valid = match &node.config {
        BatchStageConfig::Import(_) => artifacts.is_empty(),
        BatchStageConfig::Transform(_) => has(BatchArtifactKind::ImportedImages),
        BatchStageConfig::Quality(_) | BatchStageConfig::Align(_) => has_images,
        BatchStageConfig::GcpOptimize(_) => has(BatchArtifactKind::Alignment),
        BatchStageConfig::Depth(_) | BatchStageConfig::Report(_) => has_alignment,
        BatchStageConfig::Dense(_) => has(BatchArtifactKind::DepthMaps),
        BatchStageConfig::Ground(_) | BatchStageConfig::Mesh(_) => {
            has(BatchArtifactKind::DensePointCloud)
        }
        BatchStageConfig::Dem(config) => match config.surface {
            DemSurfaceKind::Dsm => {
                has(BatchArtifactKind::DensePointCloud) || has(BatchArtifactKind::ClassifiedGround)
            }
            DemSurfaceKind::Dtm => has(BatchArtifactKind::ClassifiedGround),
        },
        BatchStageConfig::Orthomosaic(_) => {
            has(BatchArtifactKind::Dem) && has_alignment && has_images
        }
        BatchStageConfig::GaussianSplat(config) => match config.initialization {
            SplatInitialization::DensePointCloud => has(BatchArtifactKind::DensePointCloud),
            SplatInitialization::MeshSurface => has(BatchArtifactKind::Mesh),
        },
        BatchStageConfig::Export(config) => {
            !config.items.is_empty() && config.items.iter().all(|item| has(item.source_artifact))
        }
    };
    if !valid {
        return Err(BatchError::MissingRequiredDependency(node.id.clone()));
    }
    Ok(())
}

fn validate_stage_config(
    node: &BatchNode,
    processing_set: &ProcessingSetScope,
) -> Result<(), BatchError> {
    match &node.config {
        BatchStageConfig::Import(config) if !config.copy_sources_into_project => {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "source images must be copied into the project",
            ))
        }
        BatchStageConfig::Transform(config) => {
            validate_hash(&config.frozen_transformation_sha256)
                .map_err(|reason| BatchError::InvalidStageConfig(node.id.clone(), reason))?;
            if !config.transform_horizontal && !config.transform_height {
                return Err(BatchError::InvalidStageConfig(
                    node.id.clone(),
                    "at least one coordinate component must be transformed",
                ));
            }
            Ok(())
        }
        BatchStageConfig::Quality(config)
            if !config.minimum_quality_score.is_finite()
                || !(0.0..=1.0).contains(&config.minimum_quality_score) =>
        {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "quality threshold must be in 0..=1",
            ))
        }
        BatchStageConfig::Align(config) => validate_alignment_config(node, config, processing_set),
        BatchStageConfig::GcpOptimize(config) => {
            validate_hash(&config.optimization_snapshot_sha256)
                .map_err(|reason| BatchError::InvalidStageConfig(node.id.clone(), reason))?;
            config.residual_scope.validate(processing_set)
        }
        BatchStageConfig::Depth(config) if !(1..=16).contains(&config.image_downscale) => Err(
            BatchError::InvalidStageConfig(node.id.clone(), "depth downscale must be 1..=16"),
        ),
        BatchStageConfig::Dense(config) if config.minimum_views < 2 => Err(
            BatchError::InvalidStageConfig(node.id.clone(), "dense fusion needs at least 2 views"),
        ),
        BatchStageConfig::Ground(config)
            if !positive(config.maximum_angle_degrees)
                || !positive(config.maximum_distance_meters)
                || !positive(config.cell_size_meters) =>
        {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "ground classification values must be positive and finite",
            ))
        }
        BatchStageConfig::Dem(config)
            if !positive(config.resolution_meters_per_pixel)
                || !valid_tile_size(config.tile_size_pixels) =>
        {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "invalid DEM resolution or tile size",
            ))
        }
        BatchStageConfig::Orthomosaic(config)
            if !positive(config.resolution_meters_per_pixel)
                || !valid_tile_size(config.tile_size_pixels) =>
        {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "invalid orthomosaic resolution or tile size",
            ))
        }
        BatchStageConfig::Mesh(config)
            if config.target_face_count == 0
                || (config.build_texture && !config.texture_size.is_power_of_two()) =>
        {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "mesh face count and texture size must be valid",
            ))
        }
        BatchStageConfig::GaussianSplat(config)
            if config.iterations == 0
                || config.maximum_splats == 0
                || config.spherical_harmonics_degree > 4 =>
        {
            Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "invalid splat iteration, count or SH degree",
            ))
        }
        BatchStageConfig::Report(config) => {
            if config.title.trim().is_empty() {
                return Err(BatchError::InvalidStageConfig(
                    node.id.clone(),
                    "report title must not be empty",
                ));
            }
            config.residual_scope.validate(processing_set)
        }
        BatchStageConfig::Export(config) => validate_export_config(node, config),
        _ => Ok(()),
    }
}

fn validate_alignment_config(
    node: &BatchNode,
    config: &AlignStageConfig,
    processing_set: &ProcessingSetScope,
) -> Result<(), BatchError> {
    if !config.resolved.offline_required
        || config.resolved.image_count as usize != processing_set.image_ids.len()
        || config.resolved.schema_version == 0
    {
        return Err(BatchError::InvalidStageConfig(
            node.id.clone(),
            "resolved offline alignment config does not match processing set",
        ));
    }
    validate_hash(&config.resolved.config_hash)
        .map_err(|reason| BatchError::InvalidStageConfig(node.id.clone(), reason))
}

fn validate_export_config(node: &BatchNode, config: &ExportStageConfig) -> Result<(), BatchError> {
    if config.items.is_empty() {
        return Err(BatchError::InvalidStageConfig(
            node.id.clone(),
            "export needs at least one item",
        ));
    }
    let mut paths = BTreeSet::new();
    for item in &config.items {
        let path = item.relative_output_path.trim();
        if path.is_empty()
            || path.starts_with('/')
            || path.starts_with('\\')
            || path.split(['/', '\\']).any(|part| part == "..")
            || !paths.insert(path)
        {
            return Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "export paths must be unique, relative and traversal-free",
            ));
        }
        if !export_format_supports(item.source_artifact, item.format) {
            return Err(BatchError::InvalidStageConfig(
                node.id.clone(),
                "export format does not support the selected artifact",
            ));
        }
    }
    Ok(())
}

const fn export_format_supports(artifact: BatchArtifactKind, format: ExportFormat) -> bool {
    match artifact {
        BatchArtifactKind::DensePointCloud | BatchArtifactKind::ClassifiedGround => matches!(
            format,
            ExportFormat::Las | ExportFormat::Laz | ExportFormat::E57 | ExportFormat::Ply
        ),
        BatchArtifactKind::Dem | BatchArtifactKind::Orthomosaic => {
            matches!(format, ExportFormat::GeoTiff | ExportFormat::Cog)
        }
        BatchArtifactKind::Mesh => matches!(
            format,
            ExportFormat::Obj | ExportFormat::Gltf | ExportFormat::Ply
        ),
        BatchArtifactKind::GaussianSplat => {
            matches!(format, ExportFormat::SplatPly | ExportFormat::Ply)
        }
        BatchArtifactKind::ProcessingReport | BatchArtifactKind::QualityReport => {
            matches!(format, ExportFormat::JsonReport | ExportFormat::PdfReport)
        }
        _ => false,
    }
}

fn topological_order(
    nodes: &BTreeMap<BatchNodeId, &BatchNode>,
) -> Result<Vec<BatchNodeId>, BatchError> {
    fn visit(
        id: &BatchNodeId,
        nodes: &BTreeMap<BatchNodeId, &BatchNode>,
        active: &mut BTreeSet<BatchNodeId>,
        visited: &mut BTreeSet<BatchNodeId>,
        order: &mut Vec<BatchNodeId>,
    ) -> Result<(), BatchError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !active.insert(id.clone()) {
            return Err(BatchError::CyclicDependency(id.clone()));
        }
        let node = nodes.get(id).ok_or_else(|| BatchError::UnknownDependency {
            node: id.clone(),
            dependency: id.clone(),
        })?;
        for dependency in &node.dependencies {
            visit(&dependency.node_id, nodes, active, visited, order)?;
        }
        active.remove(id);
        visited.insert(id.clone());
        order.push(id.clone());
        Ok(())
    }

    let mut active = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut order = Vec::with_capacity(nodes.len());
    for id in nodes.keys() {
        visit(id, nodes, &mut active, &mut visited, &mut order)?;
    }
    Ok(order)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashableNodeLineage<'a> {
    node_id: &'a BatchNodeId,
    processing_set_id: &'a ProcessingSetId,
    processing_set_membership_sha256: &'a ObjectHash,
    config_sha256: &'a ObjectHash,
    inputs: &'a [BatchLineageInput],
}

fn build_lineages(
    order: &[BatchNodeId],
    nodes: &BTreeMap<BatchNodeId, &BatchNode>,
    processing_sets: &BTreeMap<ProcessingSetId, &ProcessingSetScope>,
) -> Result<Vec<BatchNodeLineage>, BatchError> {
    let mut by_node = BTreeMap::<BatchNodeId, BatchNodeLineage>::new();
    for node_id in order {
        let node = nodes.get(node_id).expect("validated topological node");
        let processing_set = processing_sets
            .get(&node.processing_set_id)
            .expect("validated processing set");
        let config_sha256 = serde_json::to_vec(&node.config)
            .map(|bytes| ObjectHash::of_bytes(&bytes))
            .map_err(|error| BatchError::Serialization(error.to_string()))?;
        let mut inputs = Vec::with_capacity(node.dependencies.len());
        for dependency in &node.dependencies {
            let parent =
                by_node
                    .get(&dependency.node_id)
                    .ok_or_else(|| BatchError::UnknownDependency {
                        node: node.id.clone(),
                        dependency: dependency.node_id.clone(),
                    })?;
            inputs.push(BatchLineageInput {
                node_id: dependency.node_id.clone(),
                artifact: dependency.artifact,
                lineage_sha256: parent.lineage_sha256.clone(),
            });
        }
        inputs.sort_by(|left, right| left.node_id.cmp(&right.node_id));
        let hashable = HashableNodeLineage {
            node_id: &node.id,
            processing_set_id: &node.processing_set_id,
            processing_set_membership_sha256: &processing_set.membership_sha256,
            config_sha256: &config_sha256,
            inputs: &inputs,
        };
        let lineage_sha256 = serde_json::to_vec(&hashable)
            .map(|bytes| ObjectHash::of_bytes(&bytes))
            .map_err(|error| BatchError::Serialization(error.to_string()))?;
        by_node.insert(
            node.id.clone(),
            BatchNodeLineage {
                node_id: node.id.clone(),
                processing_set_id: node.processing_set_id.clone(),
                processing_set_membership_sha256: processing_set.membership_sha256.clone(),
                config_sha256,
                inputs,
                lineage_sha256,
            },
        );
    }
    Ok(order.iter().filter_map(|id| by_node.remove(id)).collect())
}

fn validate_report_lineage(
    batch: &PhotolabBatch,
    nodes: &BTreeMap<BatchNodeId, &BatchNode>,
) -> Result<(), BatchError> {
    for node in &batch.nodes {
        let scope = match &node.config {
            BatchStageConfig::GcpOptimize(config) => &config.residual_scope,
            BatchStageConfig::Report(config) => &config.residual_scope,
            _ => continue,
        };
        let alignment =
            nodes
                .get(&scope.alignment_node_id)
                .ok_or(BatchError::InvalidResidualScope(
                    "alignment node does not exist",
                ))?;
        if alignment.processing_set_id != node.processing_set_id
            || !matches!(alignment.config, BatchStageConfig::Align(_))
            || (!is_ancestor(&scope.alignment_node_id, &node.id, nodes)
                && scope.alignment_node_id != node.id)
        {
            return Err(BatchError::InvalidResidualScope(
                "alignment node is not an ancestor in this processing set",
            ));
        }
        if let Some(optimization_id) = &scope.optimization_node_id {
            let optimization =
                nodes
                    .get(optimization_id)
                    .ok_or(BatchError::InvalidResidualScope(
                        "optimization node does not exist",
                    ))?;
            if !matches!(optimization.config, BatchStageConfig::GcpOptimize(_))
                || !is_ancestor(optimization_id, &node.id, nodes)
            {
                return Err(BatchError::InvalidResidualScope(
                    "optimization node is not an ancestor of the report",
                ));
            }
        }
    }
    Ok(())
}

fn is_ancestor(
    ancestor: &BatchNodeId,
    descendant: &BatchNodeId,
    nodes: &BTreeMap<BatchNodeId, &BatchNode>,
) -> bool {
    let mut pending = vec![descendant];
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let Some(node) = nodes.get(id) else {
            continue;
        };
        for dependency in &node.dependencies {
            if &dependency.node_id == ancestor {
                return true;
            }
            pending.push(&dependency.node_id);
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDatasetEstimate {
    pub image_count: u64,
    pub total_source_pixels: u64,
    pub source_bytes: u64,
    pub gcp_count: u64,
    pub area_square_meters: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResourceEstimate {
    pub node_id: BatchNodeId,
    pub peak_ram_bytes: u64,
    pub peak_vram_bytes: u64,
    pub scratch_bytes: u64,
    pub estimated_output_bytes: u64,
    pub work_units: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePreflight {
    pub stages: Vec<StageResourceEstimate>,
    pub peak_ram_bytes: u64,
    pub peak_vram_bytes: u64,
    pub required_scratch_bytes: u64,
    pub estimated_output_bytes: u64,
    pub scratch_fits: bool,
    pub warnings: Vec<String>,
}

pub fn estimate_batch_resources(
    batch: &ValidatedBatch,
    dataset: BatchDatasetEstimate,
    available_scratch_bytes: u64,
) -> Result<ResourcePreflight, BatchError> {
    if dataset.image_count == 0
        || dataset.total_source_pixels == 0
        || !dataset.area_square_meters.is_finite()
        || dataset.area_square_meters < 0.0
    {
        return Err(BatchError::InvalidDatasetEstimate);
    }
    let nodes: BTreeMap<_, _> = batch
        .batch
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect();
    let mut stages = Vec::new();
    for id in &batch.topological_order {
        let node = nodes.get(id).expect("validated topological order");
        if node.enabled {
            stages.push(estimate_stage(node, dataset));
        }
    }
    let peak_ram_bytes = stages
        .iter()
        .map(|stage| stage.peak_ram_bytes)
        .max()
        .unwrap_or(0);
    let maximum_vram_bytes = stages
        .iter()
        .map(|stage| stage.peak_vram_bytes)
        .max()
        .unwrap_or(0);
    let required_scratch_bytes = stages.iter().fold(0_u64, |total, stage| {
        total.saturating_add(stage.scratch_bytes)
    });
    let estimated_output_bytes = stages.iter().fold(0_u64, |total, stage| {
        total.saturating_add(stage.estimated_output_bytes)
    });
    let scratch_fits = required_scratch_bytes <= available_scratch_bytes;
    let warnings = if scratch_fits {
        vec![]
    } else {
        vec![format!(
            "Temporary storage requirement of {} bytes exceeds the available {} bytes.",
            required_scratch_bytes, available_scratch_bytes
        )]
    };
    Ok(ResourcePreflight {
        stages,
        peak_ram_bytes,
        peak_vram_bytes: maximum_vram_bytes,
        required_scratch_bytes,
        estimated_output_bytes,
        scratch_fits,
        warnings,
    })
}

fn estimate_stage(node: &BatchNode, data: BatchDatasetEstimate) -> StageResourceEstimate {
    let pixels = data.total_source_pixels;
    let images = data.image_count;
    let (ram_n, vram_n, scratch_n, output_n, work_units) = match &node.config {
        BatchStageConfig::Import(_) | BatchStageConfig::Transform(_) => (1, 0, 1, 1, images),
        BatchStageConfig::Quality(_) | BatchStageConfig::Report(_) => (1, 0, 0, 1, images),
        BatchStageConfig::Align(_) => (2, 1, 3, 1, pixels / 1_000_000),
        BatchStageConfig::GcpOptimize(_) => (2, 0, 1, 1, data.gcp_count.max(1)),
        BatchStageConfig::Depth(_) => (3, 2, 6, 4, pixels / 500_000),
        BatchStageConfig::Dense(_) => (4, 2, 8, 5, pixels / 500_000),
        BatchStageConfig::Ground(_) => (3, 0, 2, 1, pixels / 2_000_000),
        BatchStageConfig::Dem(_) => (2, 1, 3, 2, pixels / 2_000_000),
        BatchStageConfig::Orthomosaic(_) => (3, 2, 5, 3, pixels / 1_000_000),
        BatchStageConfig::Mesh(_) => (4, 2, 4, 3, pixels / 1_000_000),
        BatchStageConfig::GaussianSplat(_) => (4, 4, 6, 4, pixels / 500_000),
        BatchStageConfig::Export(_) => (1, 0, 2, 2, images),
    };
    let base = (pixels / 8).max(64 * MIB);
    StageResourceEstimate {
        node_id: node.id.clone(),
        peak_ram_bytes: base.saturating_mul(ram_n),
        peak_vram_bytes: base.saturating_mul(vram_n),
        scratch_bytes: data.source_bytes.saturating_mul(scratch_n),
        estimated_output_bytes: data.source_bytes.saturating_mul(output_n),
        work_units: work_units.max(1),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptiveNodeSchedule {
    pub node_id: BatchNodeId,
    pub backend: ModelBackend,
    pub work_units_per_chunk: u64,
    pub max_concurrency: u16,
    pub cpu_threads_per_worker: u16,
    pub checkpoint_interval_seconds: u16,
    pub cancellation_poll_interval_milliseconds: u16,
    pub quality_config_sha256: ObjectHash,
    pub quality_preserved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExecutionPlan {
    pub schema_version: u32,
    pub batch_sha256: ObjectHash,
    pub offline_only: bool,
    pub schedules: Vec<AdaptiveNodeSchedule>,
    pub preflight: ResourcePreflight,
}

pub fn plan_batch_execution(
    batch: &ValidatedBatch,
    dataset: BatchDatasetEstimate,
    hardware: &HardwareCapabilities,
    available_scratch_bytes: u64,
) -> Result<BatchExecutionPlan, BatchError> {
    if hardware.ram_bytes < 512 * MIB
        || hardware.cpu.logical_cores == 0
        || hardware.cpu.physical_cores == 0
    {
        return Err(BatchError::InvalidHardware);
    }
    let preflight = estimate_batch_resources(batch, dataset, available_scratch_bytes)?;
    if !preflight.scratch_fits {
        return Err(BatchError::InsufficientScratch {
            required: preflight.required_scratch_bytes,
            available: available_scratch_bytes,
        });
    }
    let estimates: BTreeMap<_, _> = preflight
        .stages
        .iter()
        .map(|stage| (stage.node_id.clone(), stage))
        .collect();
    let nodes: BTreeMap<_, _> = batch
        .batch
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect();
    let mut schedules = Vec::new();
    for id in &batch.topological_order {
        let node = nodes.get(id).expect("validated node");
        if !node.enabled {
            continue;
        }
        let estimate = estimates.get(id).expect("enabled node estimate");
        schedules.push(schedule_node(
            node,
            estimate,
            hardware,
            &batch.batch.resilience,
        )?);
    }
    Ok(BatchExecutionPlan {
        schema_version: 1,
        batch_sha256: batch.document_sha256.clone(),
        offline_only: true,
        schedules,
        preflight,
    })
}

fn schedule_node(
    node: &BatchNode,
    estimate: &StageResourceEstimate,
    hardware: &HardwareCapabilities,
    resilience: &BatchResiliencePolicy,
) -> Result<AdaptiveNodeSchedule, BatchError> {
    let gpu_capable = matches!(
        node.config,
        BatchStageConfig::Align(_)
            | BatchStageConfig::Depth(_)
            | BatchStageConfig::Dense(_)
            | BatchStageConfig::Dem(_)
            | BatchStageConfig::Orthomosaic(_)
            | BatchStageConfig::Mesh(_)
            | BatchStageConfig::GaussianSplat(_)
    );
    let backend = if gpu_capable && hardware.cuda.is_some() {
        ModelBackend::Cuda
    } else if gpu_capable && hardware.vulkan.is_some() {
        ModelBackend::Vulkan
    } else {
        ModelBackend::Cpu
    };
    let available_memory = match backend {
        ModelBackend::Cpu => hardware.ram_bytes.saturating_mul(7) / 10,
        ModelBackend::Cuda | ModelBackend::Vulkan => {
            hardware
                .dedicated_vram_bytes
                .unwrap_or(hardware.ram_bytes / 4)
                .saturating_mul(8)
                / 10
        }
    }
    .max(64 * MIB);
    let requested_memory = match backend {
        ModelBackend::Cpu => estimate.peak_ram_bytes,
        ModelBackend::Cuda | ModelBackend::Vulkan => estimate.peak_vram_bytes.max(64 * MIB),
    };
    let chunks = requested_memory.div_ceil(available_memory).max(1);
    let work_units_per_chunk = estimate.work_units.div_ceil(chunks).max(1);
    let logical_cores = hardware.cpu.logical_cores.max(1);
    let memory_concurrency = (available_memory / requested_memory.max(1)).clamp(1, 32) as u16;
    let max_concurrency = memory_concurrency.min(logical_cores).max(1);
    let cpu_threads_per_worker = (logical_cores / max_concurrency).max(1);
    let quality_config_sha256 = serde_json::to_vec(&node.config)
        .map(|bytes| ObjectHash::of_bytes(&bytes))
        .map_err(|error| BatchError::Serialization(error.to_string()))?;
    Ok(AdaptiveNodeSchedule {
        node_id: node.id.clone(),
        backend,
        work_units_per_chunk,
        max_concurrency,
        cpu_threads_per_worker,
        checkpoint_interval_seconds: resilience.checkpoint_interval_seconds,
        cancellation_poll_interval_milliseconds: resilience.cancellation_poll_interval_milliseconds,
        quality_config_sha256,
        quality_preserved: true,
    })
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BatchError {
    #[error("batch schema '{0}' is not supported")]
    InvalidSchema(String),
    #[error("batch JSON has no schemaVersion")]
    MissingSchemaVersion,
    #[error("batch schema version {0} is not supported")]
    UnsupportedSchemaVersion(u64),
    #[error("batch name must not be empty")]
    EmptyBatchName,
    #[error("batch needs at least one node")]
    EmptyBatch,
    #[error("invalid processing set: {0}")]
    InvalidProcessingSet(&'static str),
    #[error("duplicate processing set '{0:?}'")]
    DuplicateProcessingSet(ProcessingSetId),
    #[error("unknown processing set '{0:?}'")]
    UnknownProcessingSet(ProcessingSetId),
    #[error("duplicate batch node '{0:?}'")]
    DuplicateNode(BatchNodeId),
    #[error("invalid node '{0:?}': {1}")]
    InvalidNode(BatchNodeId, &'static str),
    #[error("node '{node:?}' contains duplicate dependency '{dependency:?}'")]
    DuplicateDependency {
        node: BatchNodeId,
        dependency: BatchNodeId,
    },
    #[error("node '{node:?}' references unknown dependency '{dependency:?}'")]
    UnknownDependency {
        node: BatchNodeId,
        dependency: BatchNodeId,
    },
    #[error("node '{node:?}' declares the wrong artifact for dependency '{dependency:?}'")]
    DependencyArtifactMismatch {
        node: BatchNodeId,
        dependency: BatchNodeId,
    },
    #[error("node '{node:?}' depends on another processing set through '{dependency:?}'")]
    CrossProcessingSetDependency {
        node: BatchNodeId,
        dependency: BatchNodeId,
    },
    #[error("enabled node '{node:?}' depends on disabled node '{dependency:?}'")]
    DisabledDependency {
        node: BatchNodeId,
        dependency: BatchNodeId,
    },
    #[error("node '{0:?}' is missing a required typed dependency")]
    MissingRequiredDependency(BatchNodeId),
    #[error("node '{0:?}' has invalid configuration: {1}")]
    InvalidStageConfig(BatchNodeId, &'static str),
    #[error("batch dependency cycle contains '{0:?}'")]
    CyclicDependency(BatchNodeId),
    #[error("invalid residual report scope: {0}")]
    InvalidResidualScope(&'static str),
    #[error("invalid recovery policy: {0}")]
    InvalidResiliencePolicy(&'static str),
    #[error("batch dataset estimate is invalid")]
    InvalidDatasetEstimate,
    #[error("hardware snapshot is invalid")]
    InvalidHardware,
    #[error("scratch disk needs {required} bytes but only {available} bytes are available")]
    InsufficientScratch { required: u64, available: u64 },
    #[error("batch serialization failed: {0}")]
    Serialization(String),
}

fn validate_id(value: &str, field: &'static str) -> Result<(), BatchError> {
    if value.trim().is_empty() {
        Err(BatchError::InvalidNode(
            BatchNodeId(value.to_owned()),
            field,
        ))
    } else {
        Ok(())
    }
}

fn validate_sorted_unique<T: Ord>(values: &[T], field: &'static str) -> Result<(), BatchError> {
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        Err(BatchError::InvalidResidualScope(field))
    } else {
        Ok(())
    }
}

fn validate_hash(hash: &ObjectHash) -> Result<(), &'static str> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("SHA-256 hash is invalid")
    }
}

fn positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn valid_tile_size(size: u16) -> bool {
    size.is_power_of_two() && (128..=2_048).contains(&size)
}

#[cfg(test)]
mod tests {
    use crate::photolab::{
        resolve_alignment_profile, AlignmentQualityProfile, ResolveAlignmentProfileRequest,
    };
    use crate::photolab_models::{CpuCapabilities, HostOperatingSystem, VulkanCapabilities};

    use super::*;

    fn id(value: &str) -> BatchNodeId {
        BatchNodeId(value.into())
    }

    fn dependency(node: &str, artifact: BatchArtifactKind) -> BatchDependency {
        BatchDependency {
            node_id: id(node),
            artifact,
        }
    }

    fn processing_set() -> ProcessingSetScope {
        ProcessingSetScope::new(
            ProcessingSetId("flight-a".into()),
            "Flug A".into(),
            vec![ImageId(1), ImageId(2)],
        )
        .expect("processing set")
    }

    fn resilience() -> BatchResiliencePolicy {
        BatchResiliencePolicy {
            autosave_interval_seconds: 30,
            checkpoint_interval_seconds: 60,
            cancellation_poll_interval_milliseconds: 50,
            node_checkpoints: NodeCheckpointPolicy::IntervalAndNodeBoundary,
            output_commit: OutputCommitPolicy::AtomicDiscardPartialOnCancel,
            unclean_shutdown: UncleanShutdownPolicy::ResumeFromCheckpoint,
        }
    }

    fn alignment_config() -> AlignStageConfig {
        AlignStageConfig {
            resolved: resolve_alignment_profile(&ResolveAlignmentProfileRequest {
                profile: AlignmentQualityProfile::QualityHybrid,
                image_count: 2,
                max_image_edge_override: None,
                keypoints_per_megapixel_override: None,
            })
            .expect("alignment config"),
            use_reference_positions: true,
            generic_preselection: true,
        }
    }

    fn batch() -> PhotolabBatch {
        let set = processing_set();
        PhotolabBatch {
            schema: BATCH_SCHEMA.into(),
            schema_version: BATCH_SCHEMA_VERSION,
            name: "Survey products".into(),
            processing_sets: vec![set.clone()],
            nodes: vec![
                BatchNode {
                    id: id("import"),
                    label: "Import".into(),
                    processing_set_id: set.id.clone(),
                    dependencies: vec![],
                    config: BatchStageConfig::Import(ImportStageConfig {
                        copy_sources_into_project: true,
                        recursive_folders: true,
                        duplicate_policy: DuplicateImagePolicy::SkipIdentical,
                    }),
                    enabled: true,
                },
                BatchNode {
                    id: id("align"),
                    label: "Align".into(),
                    processing_set_id: set.id.clone(),
                    dependencies: vec![dependency("import", BatchArtifactKind::ImportedImages)],
                    config: BatchStageConfig::Align(alignment_config()),
                    enabled: true,
                },
                BatchNode {
                    id: id("depth"),
                    label: "Depth".into(),
                    processing_set_id: set.id.clone(),
                    dependencies: vec![dependency("align", BatchArtifactKind::Alignment)],
                    config: BatchStageConfig::Depth(DepthStageConfig {
                        image_downscale: 2,
                        filter: DepthFilterStrength::Mild,
                        reuse_compatible_maps: true,
                    }),
                    enabled: true,
                },
                BatchNode {
                    id: id("dense"),
                    label: "Dense".into(),
                    processing_set_id: set.id,
                    dependencies: vec![dependency("depth", BatchArtifactKind::DepthMaps)],
                    config: BatchStageConfig::Dense(DenseStageConfig {
                        minimum_views: 2,
                        retain_confidence: true,
                        calculate_colors: true,
                    }),
                    enabled: true,
                },
            ],
            resilience: resilience(),
        }
    }

    fn hardware(ram_bytes: u64) -> HardwareCapabilities {
        HardwareCapabilities {
            operating_system: HostOperatingSystem::Linux,
            ram_bytes,
            dedicated_vram_bytes: Some(4 * 1024 * MIB),
            cpu: CpuCapabilities {
                physical_cores: 4,
                logical_cores: 8,
                supports_avx2: true,
            },
            vulkan: Some(VulkanCapabilities {
                api_version: "1.3".into(),
                device_name: "Test GPU".into(),
            }),
            cuda: None,
        }
    }

    fn estimate() -> BatchDatasetEstimate {
        BatchDatasetEstimate {
            image_count: 2,
            total_source_pixels: 48_000_000,
            source_bytes: 32 * MIB,
            gcp_count: 8,
            area_square_meters: 10_000.0,
        }
    }

    #[test]
    fn valid_dag_has_stable_topological_order() {
        let validated = batch().validate().expect("valid batch");
        assert_eq!(
            validated.topological_order(),
            &[id("import"), id("align"), id("depth"), id("dense")]
        );
        assert_eq!(validated.lineages().len(), 4);
        assert_eq!(
            validated.lineages()[1].inputs[0].lineage_sha256,
            validated.lineages()[0].lineage_sha256
        );
    }

    #[test]
    fn cycle_is_rejected() {
        let mut batch = batch();
        batch.nodes[1]
            .dependencies
            .push(dependency("dense", BatchArtifactKind::DensePointCloud));
        let error = batch.validate().expect_err("cycle");
        assert!(matches!(error, BatchError::CyclicDependency(_)));
    }

    #[test]
    fn declared_dependency_artifact_must_match_producer() {
        let mut batch = batch();
        batch.nodes[1].dependencies[0].artifact = BatchArtifactKind::TransformedImages;
        assert!(matches!(
            batch.validate(),
            Err(BatchError::DependencyArtifactMismatch { .. })
        ));
    }

    #[test]
    fn processing_set_membership_is_tamper_evident() {
        let mut batch = batch();
        batch.processing_sets[0].image_ids.push(ImageId(3));
        assert!(matches!(
            batch.validate(),
            Err(BatchError::InvalidProcessingSet(_))
        ));
    }

    #[test]
    fn unsafe_recovery_policy_is_rejected() {
        let mut batch = batch();
        batch.resilience.output_commit = OutputCommitPolicy::UnsafeDirectWrite;
        assert!(matches!(
            batch.validate(),
            Err(BatchError::InvalidResiliencePolicy(_))
        ));
    }

    #[test]
    fn versioned_json_roundtrip_validates_again() {
        let batch = batch();
        let encoded = batch.to_json_pretty().expect("save");
        let decoded = PhotolabBatch::from_json(&encoded).expect("load");
        assert_eq!(decoded.batch(), &batch);
        assert_eq!(decoded.document_sha256().as_str().len(), 64);
    }

    #[test]
    fn unknown_json_version_is_rejected_before_decode() {
        let encoded = batch().to_json_pretty().expect("save");
        let replaced = encoded.replace("\"schemaVersion\": 1", "\"schemaVersion\": 99");
        assert_eq!(
            PhotolabBatch::from_json(&replaced),
            Err(BatchError::UnsupportedSchemaVersion(99))
        );
    }

    #[test]
    fn low_memory_changes_chunking_not_quality_hash() {
        let validated = batch().validate().expect("valid batch");
        let mut low_hardware = hardware(2 * 1024 * MIB);
        low_hardware.dedicated_vram_bytes = Some(128 * MIB);
        let mut high_hardware = hardware(32 * 1024 * MIB);
        high_hardware.dedicated_vram_bytes = Some(16 * 1024 * MIB);
        let low = plan_batch_execution(&validated, estimate(), &low_hardware, 2_000 * MIB)
            .expect("low memory plan");
        let high = plan_batch_execution(&validated, estimate(), &high_hardware, 2_000 * MIB)
            .expect("high memory plan");
        assert!(low
            .schedules
            .iter()
            .zip(&high.schedules)
            .all(
                |(left, right)| left.quality_config_sha256 == right.quality_config_sha256
                    && left.quality_preserved
                    && right.quality_preserved
            ));
        assert!(low
            .schedules
            .iter()
            .zip(&high.schedules)
            .any(|(left, right)| left.work_units_per_chunk != right.work_units_per_chunk));
    }

    #[test]
    fn enabled_node_cannot_use_disabled_output() {
        let mut batch = batch();
        batch.nodes[2].enabled = false;
        assert!(matches!(
            batch.validate(),
            Err(BatchError::DisabledDependency { .. })
        ));
    }

    #[test]
    fn scratch_preflight_prevents_doomed_run() {
        let validated = batch().validate().expect("valid batch");
        let error = plan_batch_execution(&validated, estimate(), &hardware(8 * 1024 * MIB), MIB)
            .expect_err("scratch must fail");
        assert!(matches!(error, BatchError::InsufficientScratch { .. }));
    }

    #[test]
    fn residual_scope_cannot_mix_processing_sets() {
        let scope = ResidualReportScope {
            processing_set_id: ProcessingSetId("other".into()),
            alignment_node_id: id("align"),
            optimization_node_id: None,
            camera_image_ids: vec![ImageId(1)],
            control_point_ids: vec![GcpPointId("gcp-1".into())],
            checkpoint_point_ids: vec![],
        };
        assert!(matches!(
            scope.validate(&processing_set()),
            Err(BatchError::InvalidResidualScope(_))
        ));
    }
}
