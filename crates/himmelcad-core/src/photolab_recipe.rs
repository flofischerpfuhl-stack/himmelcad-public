//! Unattended PhotoLab recipe templates and immutable concrete run plans.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;
use crate::photolab_batch::{
    BatchArtifactKind, BatchNodeId, BatchResiliencePolicy, BatchStageConfig, DemStageConfig,
    DenseStageConfig, DepthFilterStrength, DepthStageConfig, MeshStageConfig, NodeCheckpointPolicy,
    OrthomosaicBlendMode, OrthomosaicStageConfig, OutputCommitPolicy, ProcessingSetScope,
    SplatInitialization, SplatStageConfig, UncleanShutdownPolicy,
};
use crate::photolab_products::DemSurfaceKind;

pub const RECIPE_SCHEMA: &str = "himmelcad.photolab.recipe";
pub const RECIPE_SCHEMA_VERSION: u32 = 1;
pub const CONCRETE_RUN_SCHEMA: &str = "himmelcad.photolab.concrete-batch-run";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecipePortId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ArtifactSlotId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePort {
    pub id: RecipePortId,
    pub artifact: BatchArtifactKind,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeNodeTemplate {
    pub id: BatchNodeId,
    pub label: String,
    pub inputs: Vec<RecipePort>,
    pub outputs: Vec<RecipePort>,
    pub config: BatchStageConfig,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePortRef {
    pub node_id: BatchNodeId,
    pub port_id: RecipePortId,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeEdge {
    pub from: RecipePortRef,
    pub to: RecipePortRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinearUnit {
    Meter,
    FootInternational,
    FootUsSurvey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeightReference {
    Ellipsoidal { datum: String },
    Orthometric { vertical_crs: String },
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage2d {
    pub minimum: [f64; 2],
    pub maximum: [f64; 2],
}

impl Coverage2d {
    fn validate(self) -> bool {
        self.minimum
            .iter()
            .chain(self.maximum.iter())
            .all(|value| value.is_finite())
            && self.minimum[0] < self.maximum[0]
            && self.minimum[1] < self.maximum[1]
    }

    fn contains(self, required: Self) -> bool {
        self.minimum[0] <= required.minimum[0]
            && self.minimum[1] <= required.minimum[1]
            && self.maximum[0] >= required.maximum[0]
            && self.maximum[1] >= required.maximum[1]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoDataDefinition {
    None,
    Value { value: f64 },
    Mask { mask_sha256: ObjectHash },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterArtifactMetadata {
    pub horizontal_crs_sha256: ObjectHash,
    pub height_reference: HeightReference,
    pub linear_unit: LinearUnit,
    pub coverage: Coverage2d,
    pub resolution: [f64; 2],
    pub nodata: NoDataDefinition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterSlotRequirements {
    pub horizontal_crs_sha256: ObjectHash,
    pub height_reference: HeightReference,
    pub linear_unit: LinearUnit,
    pub required_coverage: Coverage2d,
    pub maximum_resolution: [f64; 2],
    pub allow_nodata: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactRequirements {
    Any,
    Raster(RasterSlotRequirements),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalArtifactSlot {
    pub id: ArtifactSlotId,
    pub label: String,
    pub artifact: BatchArtifactKind,
    pub required: bool,
    pub target: RecipePortRef,
    pub requirements: ArtifactRequirements,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeTemplate {
    pub schema: String,
    pub schema_version: u32,
    pub template_id: String,
    pub name: String,
    pub nodes: Vec<RecipeNodeTemplate>,
    pub edges: Vec<RecipeEdge>,
    pub external_slots: Vec<ExternalArtifactSlot>,
    pub resilience: BatchResiliencePolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenProjectArtifact {
    pub artifact: BatchArtifactKind,
    pub entity_id: String,
    pub entity_revision: u64,
    pub entity_version_sha256: ObjectHash,
    pub content_sha256: ObjectHash,
    pub provider_id: String,
    pub provider_version: String,
    pub format_id: String,
    pub provider_config_sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raster: Option<RasterArtifactMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalArtifactBinding {
    pub slot_id: ArtifactSlotId,
    pub artifact: FrozenProjectArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecipeReadinessIssueKind {
    InvalidTemplate,
    MissingBinding,
    UnexpectedBinding,
    ArtifactKindMismatch,
    InvalidArtifactIdentity,
    MissingRasterMetadata,
    CrsMismatch,
    HeightReferenceMismatch,
    UnitMismatch,
    InsufficientCoverage,
    ResolutionTooCoarse,
    NoDataNotAllowed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeReadinessIssue {
    pub kind: RecipeReadinessIssueKind,
    pub slot_id: Option<ArtifactSlotId>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeReadiness {
    pub ready: bool,
    pub issues: Vec<RecipeReadinessIssue>,
}

impl RecipeTemplate {
    pub fn validate(&self) -> Result<(), RecipeError> {
        if self.schema != RECIPE_SCHEMA
            || self.schema_version != RECIPE_SCHEMA_VERSION
            || self.template_id.trim().is_empty()
            || self.name.trim().is_empty()
            || self.nodes.is_empty()
        {
            return Err(RecipeError::InvalidTemplate);
        }
        self.resilience
            .validate()
            .map_err(|_| RecipeError::InvalidTemplate)?;
        let mut nodes = BTreeMap::new();
        for node in &self.nodes {
            validate_token(&node.id.0)?;
            if node.label.trim().is_empty() || nodes.insert(node.id.clone(), node).is_some() {
                return Err(RecipeError::InvalidTemplate);
            }
            validate_ports(node)?;
            let outputs = node
                .outputs
                .iter()
                .filter(|port| port.artifact == node.config.output())
                .count();
            if outputs != 1 {
                return Err(RecipeError::InvalidTemplate);
            }
        }
        let mut occupied_inputs = BTreeSet::new();
        for edge in &self.edges {
            let output = resolve_port(&nodes, &edge.from, false)?;
            let input = resolve_port(&nodes, &edge.to, true)?;
            if output.artifact != input.artifact || !occupied_inputs.insert(edge.to.clone()) {
                return Err(RecipeError::InvalidTemplate);
            }
        }
        let mut slots = BTreeSet::new();
        for slot in &self.external_slots {
            validate_token(&slot.id.0)?;
            if slot.label.trim().is_empty() || !slots.insert(slot.id.clone()) {
                return Err(RecipeError::InvalidTemplate);
            }
            let input = resolve_port(&nodes, &slot.target, true)?;
            if input.artifact != slot.artifact || !occupied_inputs.insert(slot.target.clone()) {
                return Err(RecipeError::InvalidTemplate);
            }
            validate_requirements(&slot.requirements)?;
        }
        for node in self.nodes.iter().filter(|node| node.enabled) {
            for input in node.inputs.iter().filter(|port| port.required) {
                let target = RecipePortRef {
                    node_id: node.id.clone(),
                    port_id: input.id.clone(),
                };
                if !occupied_inputs.contains(&target) {
                    return Err(RecipeError::InvalidTemplate);
                }
            }
        }
        topological_nodes(self, &nodes)?;
        Ok(())
    }

    #[must_use]
    pub fn readiness(&self, bindings: &[ExternalArtifactBinding]) -> RecipeReadiness {
        let mut issues = Vec::new();
        if self.validate().is_err() {
            issues.push(issue(
                RecipeReadinessIssueKind::InvalidTemplate,
                None,
                "Recipe template is invalid",
            ));
            return RecipeReadiness {
                ready: false,
                issues,
            };
        }
        let slots = self
            .external_slots
            .iter()
            .map(|slot| (&slot.id, slot))
            .collect::<BTreeMap<_, _>>();
        let mut seen = BTreeSet::new();
        for binding in bindings {
            if !seen.insert(binding.slot_id.clone()) {
                issues.push(issue(
                    RecipeReadinessIssueKind::UnexpectedBinding,
                    Some(binding.slot_id.clone()),
                    "Artifact slot is bound more than once",
                ));
                continue;
            }
            let Some(slot) = slots.get(&binding.slot_id) else {
                issues.push(issue(
                    RecipeReadinessIssueKind::UnexpectedBinding,
                    Some(binding.slot_id.clone()),
                    "Binding does not belong to this recipe",
                ));
                continue;
            };
            validate_binding(slot, &binding.artifact, &mut issues);
        }
        for slot in self.external_slots.iter().filter(|slot| slot.required) {
            if !seen.contains(&slot.id) {
                issues.push(issue(
                    RecipeReadinessIssueKind::MissingBinding,
                    Some(slot.id.clone()),
                    "Required artifact must be selected before Run",
                ));
            }
        }
        RecipeReadiness {
            ready: issues.is_empty(),
            issues,
        }
    }

    pub fn instantiate(
        &self,
        run_id: String,
        processing_set: ProcessingSetScope,
        bindings: Vec<ExternalArtifactBinding>,
    ) -> Result<ConcreteBatchRun, RecipeError> {
        self.validate()?;
        processing_set
            .validate()
            .map_err(|_| RecipeError::InvalidProcessingSet)?;
        let readiness = self.readiness(&bindings);
        if !readiness.ready {
            return Err(RecipeError::NotReady(readiness.issues));
        }
        validate_token(&run_id)?;
        let template_sha256 = hash(self)?;
        let mut frozen_nodes = self
            .nodes
            .iter()
            .filter(|node| node.enabled)
            .map(|node| {
                Ok(FrozenRecipeNode {
                    id: node.id.clone(),
                    config_sha256: hash(&node.config)?,
                    config: node.config.clone(),
                })
            })
            .collect::<Result<Vec<_>, RecipeError>>()?;
        frozen_nodes.sort_by(|left, right| left.id.cmp(&right.id));
        let mut bindings = bindings;
        bindings.sort_by(|left, right| left.slot_id.cmp(&right.slot_id));
        let plan_sha256 = hash(&(
            &run_id,
            &template_sha256,
            &processing_set,
            &frozen_nodes,
            &self.edges,
            &bindings,
            &self.resilience,
        ))?;
        Ok(ConcreteBatchRun {
            schema: CONCRETE_RUN_SCHEMA.into(),
            schema_version: RECIPE_SCHEMA_VERSION,
            run_id,
            template_sha256,
            plan_sha256,
            processing_set,
            nodes: frozen_nodes,
            edges: self.edges.clone(),
            external_bindings: bindings,
            resilience: self.resilience.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenRecipeNode {
    pub id: BatchNodeId,
    pub config_sha256: ObjectHash,
    pub config: BatchStageConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcreteBatchRun {
    pub schema: String,
    pub schema_version: u32,
    pub run_id: String,
    pub template_sha256: ObjectHash,
    pub plan_sha256: ObjectHash,
    pub processing_set: ProcessingSetScope,
    pub nodes: Vec<FrozenRecipeNode>,
    pub edges: Vec<RecipeEdge>,
    pub external_bindings: Vec<ExternalArtifactBinding>,
    pub resilience: BatchResiliencePolicy,
}

impl ConcreteBatchRun {
    pub fn validate(&self) -> Result<(), RecipeError> {
        if self.schema != CONCRETE_RUN_SCHEMA
            || self.schema_version != RECIPE_SCHEMA_VERSION
            || self.nodes.is_empty()
        {
            return Err(RecipeError::InvalidRun);
        }
        validate_token(&self.run_id)?;
        self.processing_set
            .validate()
            .map_err(|_| RecipeError::InvalidRun)?;
        self.resilience
            .validate()
            .map_err(|_| RecipeError::InvalidRun)?;
        for node in &self.nodes {
            if hash(&node.config)? != node.config_sha256 {
                return Err(RecipeError::InvalidRun);
            }
        }
        let expected = hash(&(
            &self.run_id,
            &self.template_sha256,
            &self.processing_set,
            &self.nodes,
            &self.edges,
            &self.external_bindings,
            &self.resilience,
        ))?;
        if expected != self.plan_sha256 {
            return Err(RecipeError::InvalidRun);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchRunState {
    Queued,
    Running,
    Cancelling,
    Cancelled,
    Failed,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRunProgress {
    pub plan_sha256: ObjectHash,
    pub state: BatchRunState,
    pub completed_nodes: u32,
    pub total_nodes: u32,
    pub completed_units: u64,
    pub total_units: u64,
}

impl BatchRunProgress {
    pub fn validate_successor(&self, next: &Self) -> Result<(), RecipeError> {
        if self.plan_sha256 != next.plan_sha256
            || next.total_nodes != self.total_nodes
            || next.total_units != self.total_units
            || next.completed_nodes < self.completed_nodes
            || next.completed_units < self.completed_units
            || next.completed_nodes > next.total_nodes
            || next.completed_units > next.total_units
            || !valid_state_transition(self.state, next.state)
            || (next.state == BatchRunState::Completed
                && (next.completed_nodes != next.total_nodes
                    || next.completed_units != next.total_units))
            || terminal(self.state) && *next != *self
        {
            return Err(RecipeError::InvalidProgress);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRunCheckpoint {
    pub schema_version: u32,
    pub plan_sha256: ObjectHash,
    pub completed_node_ids: Vec<BatchNodeId>,
    pub committed_output_sha256: Vec<ObjectHash>,
    pub progress: BatchRunProgress,
}

impl BatchRunCheckpoint {
    pub fn validate_for_resume(&self, run: &ConcreteBatchRun) -> Result<(), RecipeError> {
        run.validate()?;
        let known = run
            .nodes
            .iter()
            .map(|node| &node.id)
            .collect::<BTreeSet<_>>();
        let completed = self.completed_node_ids.iter().collect::<BTreeSet<_>>();
        if self.schema_version != RECIPE_SCHEMA_VERSION
            || self.plan_sha256 != run.plan_sha256
            || self.progress.plan_sha256 != run.plan_sha256
            || completed.len() != self.completed_node_ids.len()
            || self.completed_node_ids.iter().any(|id| !known.contains(id))
            || usize::try_from(self.progress.completed_nodes).ok() != Some(completed.len())
            || usize::try_from(self.progress.total_nodes).ok() != Some(run.nodes.len())
            || self.committed_output_sha256.len() != completed.len()
            || self
                .committed_output_sha256
                .iter()
                .any(|hash| !valid_hash(hash))
        {
            return Err(RecipeError::CheckpointDoesNotMatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchIoDirection {
    Import,
    Export,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProductIoMapping {
    pub artifact: BatchArtifactKind,
    pub direction: BatchIoDirection,
    pub provider_id: String,
    pub provider_version: String,
    pub format_id: String,
}

#[must_use]
pub fn standard_product_io_mappings() -> Vec<BatchProductIoMapping> {
    vec![
        mapping(
            BatchArtifactKind::Dem,
            BatchIoDirection::Import,
            "hcad.io.geotiff-rust@1",
            "geotiff@1.1",
        ),
        mapping(
            BatchArtifactKind::Dem,
            BatchIoDirection::Export,
            "hcad.io.geotiff-rust@1",
            "geotiff@1.1",
        ),
        mapping(
            BatchArtifactKind::Orthomosaic,
            BatchIoDirection::Export,
            "hcad.io.geotiff-rust@1",
            "geotiff@1.1",
        ),
        mapping(
            BatchArtifactKind::GaussianSplat,
            BatchIoDirection::Export,
            "hcad.io.gaussian-splat-ply@1",
            "gaussian-splat-ply@1",
        ),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StandardRecipeKind {
    AllProducts,
    OrthomosaicFromExternalDem,
}

/// Builds shipped symbolic templates. Every input is resolved before execution.
pub fn standard_recipe(
    kind: StandardRecipeKind,
    external_dem_requirements: Option<RasterSlotRequirements>,
) -> Result<RecipeTemplate, RecipeError> {
    let external_dem = kind == StandardRecipeKind::OrthomosaicFromExternalDem;
    let mut nodes = Vec::new();
    if !external_dem {
        nodes.extend([
            recipe_node(
                "depth",
                "Depth maps",
                vec![port("alignment", BatchArtifactKind::Alignment, true)],
                BatchStageConfig::Depth(DepthStageConfig {
                    image_downscale: 2,
                    filter: DepthFilterStrength::Moderate,
                    reuse_compatible_maps: true,
                }),
            ),
            recipe_node(
                "dense",
                "Dense point cloud",
                vec![port("depth", BatchArtifactKind::DepthMaps, true)],
                BatchStageConfig::Dense(DenseStageConfig {
                    minimum_views: 3,
                    retain_confidence: true,
                    calculate_colors: true,
                }),
            ),
        ]);
        nodes.push(recipe_node(
            "dem",
            "DEM",
            vec![port("dense", BatchArtifactKind::DensePointCloud, true)],
            BatchStageConfig::Dem(DemStageConfig {
                surface: DemSurfaceKind::Dsm,
                resolution_meters_per_pixel: 0.05,
                interpolate_nodata: true,
                tile_size_pixels: 512,
            }),
        ));
    }
    nodes.push(recipe_node(
        "ortho",
        "Orthomosaic",
        vec![
            port("images", BatchArtifactKind::ImportedImages, true),
            port("alignment", BatchArtifactKind::Alignment, true),
            port("dem", BatchArtifactKind::Dem, true),
        ],
        BatchStageConfig::Orthomosaic(OrthomosaicStageConfig {
            resolution_meters_per_pixel: 0.05,
            blend_mode: OrthomosaicBlendMode::Mosaic,
            color_correction: true,
            fill_holes: true,
            tile_size_pixels: 512,
        }),
    ));
    if !external_dem {
        nodes.extend([
            recipe_node(
                "mesh",
                "Textured mesh",
                vec![port("dense", BatchArtifactKind::DensePointCloud, true)],
                BatchStageConfig::Mesh(MeshStageConfig {
                    target_face_count: 5_000_000,
                    interpolate_holes: true,
                    build_texture: true,
                    texture_size: 8192,
                }),
            ),
            recipe_node(
                "splat",
                "Gaussian splat",
                vec![port("mesh", BatchArtifactKind::Mesh, true)],
                BatchStageConfig::GaussianSplat(SplatStageConfig {
                    initialization: SplatInitialization::MeshSurface,
                    iterations: 30_000,
                    spherical_harmonics_degree: 3,
                    maximum_splats: 20_000_000,
                    retain_training_checkpoints: true,
                }),
            ),
        ]);
    }
    let mut edges = Vec::new();
    if !external_dem {
        edges.extend([
            edge("depth", "out", "dense", "depth"),
            edge("dense", "out", "dem", "dense"),
            edge("dem", "out", "ortho", "dem"),
            edge("dense", "out", "mesh", "dense"),
            edge("mesh", "out", "splat", "mesh"),
        ]);
    }
    let mut external_slots = vec![slot(
        "images",
        "Imported images",
        BatchArtifactKind::ImportedImages,
        "ortho",
        "images",
    )];
    if external_dem {
        external_slots.push(slot(
            "alignment",
            "Alignment",
            BatchArtifactKind::Alignment,
            "ortho",
            "alignment",
        ));
    } else {
        external_slots.extend([
            slot(
                "alignment",
                "Alignment",
                BatchArtifactKind::Alignment,
                "depth",
                "alignment",
            ),
            slot(
                "ortho-alignment",
                "Orthomosaic alignment",
                BatchArtifactKind::Alignment,
                "ortho",
                "alignment",
            ),
        ]);
    }
    if external_dem {
        let requirements = external_dem_requirements.ok_or(RecipeError::InvalidTemplate)?;
        validate_requirements(&ArtifactRequirements::Raster(requirements.clone()))?;
        let mut dem_slot = slot(
            "dem",
            "Explicit elevation model",
            BatchArtifactKind::Dem,
            "ortho",
            "dem",
        );
        dem_slot.requirements = ArtifactRequirements::Raster(requirements);
        external_slots.push(dem_slot);
    }
    let template = RecipeTemplate {
        schema: RECIPE_SCHEMA.into(),
        schema_version: RECIPE_SCHEMA_VERSION,
        template_id: match kind {
            StandardRecipeKind::AllProducts => "standard.all-products",
            StandardRecipeKind::OrthomosaicFromExternalDem => "standard.ortho-external-dem",
        }
        .into(),
        name: match kind {
            StandardRecipeKind::AllProducts => "All products",
            StandardRecipeKind::OrthomosaicFromExternalDem => "Orthomosaic from selected DEM",
        }
        .into(),
        nodes,
        edges,
        external_slots,
        resilience: standard_resilience(),
    };
    template.validate()?;
    Ok(template)
}

fn standard_resilience() -> BatchResiliencePolicy {
    BatchResiliencePolicy {
        autosave_interval_seconds: 30,
        checkpoint_interval_seconds: 30,
        cancellation_poll_interval_milliseconds: 100,
        node_checkpoints: NodeCheckpointPolicy::IntervalAndNodeBoundary,
        output_commit: OutputCommitPolicy::AtomicDiscardPartialOnCancel,
        unclean_shutdown: UncleanShutdownPolicy::ResumeFromCheckpoint,
    }
}

fn recipe_node(
    id: &str,
    label: &str,
    inputs: Vec<RecipePort>,
    config: BatchStageConfig,
) -> RecipeNodeTemplate {
    let output = config.output();
    RecipeNodeTemplate {
        id: BatchNodeId(id.into()),
        label: label.into(),
        inputs,
        outputs: vec![port("out", output, false)],
        config,
        enabled: true,
    }
}

fn port(id: &str, artifact: BatchArtifactKind, required: bool) -> RecipePort {
    RecipePort {
        id: RecipePortId(id.into()),
        artifact,
        required,
    }
}

fn reference(node: &str, port: &str) -> RecipePortRef {
    RecipePortRef {
        node_id: BatchNodeId(node.into()),
        port_id: RecipePortId(port.into()),
    }
}

fn edge(from_node: &str, from_port: &str, to_node: &str, to_port: &str) -> RecipeEdge {
    RecipeEdge {
        from: reference(from_node, from_port),
        to: reference(to_node, to_port),
    }
}

fn slot(
    id: &str,
    label: &str,
    artifact: BatchArtifactKind,
    node: &str,
    port: &str,
) -> ExternalArtifactSlot {
    ExternalArtifactSlot {
        id: ArtifactSlotId(id.into()),
        label: label.into(),
        artifact,
        required: true,
        target: reference(node, port),
        requirements: ArtifactRequirements::Any,
    }
}

fn mapping(
    artifact: BatchArtifactKind,
    direction: BatchIoDirection,
    provider_id: &str,
    format_id: &str,
) -> BatchProductIoMapping {
    BatchProductIoMapping {
        artifact,
        direction,
        provider_id: provider_id.into(),
        provider_version: "1".into(),
        format_id: format_id.into(),
    }
}

fn validate_ports(node: &RecipeNodeTemplate) -> Result<(), RecipeError> {
    let mut ids = BTreeSet::new();
    for port in node.inputs.iter().chain(&node.outputs) {
        validate_token(&port.id.0)?;
        if !ids.insert(port.id.clone()) {
            return Err(RecipeError::InvalidTemplate);
        }
    }
    Ok(())
}

fn resolve_port<'a>(
    nodes: &BTreeMap<BatchNodeId, &'a RecipeNodeTemplate>,
    reference: &RecipePortRef,
    input: bool,
) -> Result<&'a RecipePort, RecipeError> {
    let node = nodes
        .get(&reference.node_id)
        .ok_or(RecipeError::InvalidTemplate)?;
    let ports = if input { &node.inputs } else { &node.outputs };
    ports
        .iter()
        .find(|port| port.id == reference.port_id)
        .ok_or(RecipeError::InvalidTemplate)
}

fn validate_requirements(requirements: &ArtifactRequirements) -> Result<(), RecipeError> {
    if let ArtifactRequirements::Raster(requirements) = requirements {
        if !valid_hash(&requirements.horizontal_crs_sha256)
            || !requirements.required_coverage.validate()
            || requirements
                .maximum_resolution
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(RecipeError::InvalidTemplate);
        }
    }
    Ok(())
}

fn validate_binding(
    slot: &ExternalArtifactSlot,
    artifact: &FrozenProjectArtifact,
    issues: &mut Vec<RecipeReadinessIssue>,
) {
    let slot_id = Some(slot.id.clone());
    if artifact.entity_id.trim().is_empty()
        || artifact.entity_revision == 0
        || artifact.provider_id.trim().is_empty()
        || artifact.provider_version.trim().is_empty()
        || artifact.format_id.trim().is_empty()
        || !valid_hash(&artifact.entity_version_sha256)
        || !valid_hash(&artifact.content_sha256)
        || !valid_hash(&artifact.provider_config_sha256)
    {
        issues.push(issue(
            RecipeReadinessIssueKind::InvalidArtifactIdentity,
            slot_id,
            "Artifact identity, revision, provider and hashes must be frozen",
        ));
        return;
    }
    if artifact.artifact != slot.artifact {
        issues.push(issue(
            RecipeReadinessIssueKind::ArtifactKindMismatch,
            slot_id,
            "Bound artifact has the wrong product kind",
        ));
        return;
    }
    let ArtifactRequirements::Raster(required) = &slot.requirements else {
        return;
    };
    let Some(actual) = &artifact.raster else {
        issues.push(issue(
            RecipeReadinessIssueKind::MissingRasterMetadata,
            slot_id,
            "Raster metadata is required",
        ));
        return;
    };
    if actual.horizontal_crs_sha256 != required.horizontal_crs_sha256 {
        issues.push(issue(
            RecipeReadinessIssueKind::CrsMismatch,
            slot_id.clone(),
            "Raster CRS does not match the project",
        ));
    }
    if actual.height_reference != required.height_reference {
        issues.push(issue(
            RecipeReadinessIssueKind::HeightReferenceMismatch,
            slot_id.clone(),
            "Raster height reference does not match",
        ));
    }
    if actual.linear_unit != required.linear_unit {
        issues.push(issue(
            RecipeReadinessIssueKind::UnitMismatch,
            slot_id.clone(),
            "Raster linear unit does not match",
        ));
    }
    if !actual.coverage.validate() || !actual.coverage.contains(required.required_coverage) {
        issues.push(issue(
            RecipeReadinessIssueKind::InsufficientCoverage,
            slot_id.clone(),
            "Raster does not cover the processing area",
        ));
    }
    if actual
        .resolution
        .iter()
        .zip(required.maximum_resolution)
        .any(|(actual, maximum)| !actual.is_finite() || *actual <= 0.0 || *actual > maximum)
    {
        issues.push(issue(
            RecipeReadinessIssueKind::ResolutionTooCoarse,
            slot_id.clone(),
            "Raster resolution is too coarse",
        ));
    }
    if !required.allow_nodata && !matches!(actual.nodata, NoDataDefinition::None) {
        issues.push(issue(
            RecipeReadinessIssueKind::NoDataNotAllowed,
            slot_id,
            "Raster NoData is not permitted for this slot",
        ));
    }
}

fn issue(
    kind: RecipeReadinessIssueKind,
    slot_id: Option<ArtifactSlotId>,
    message: &str,
) -> RecipeReadinessIssue {
    RecipeReadinessIssue {
        kind,
        slot_id,
        message: message.into(),
    }
}

fn topological_nodes(
    template: &RecipeTemplate,
    nodes: &BTreeMap<BatchNodeId, &RecipeNodeTemplate>,
) -> Result<Vec<BatchNodeId>, RecipeError> {
    let mut indegree = nodes
        .keys()
        .map(|id| (id.clone(), 0_usize))
        .collect::<BTreeMap<_, _>>();
    let mut outgoing: BTreeMap<BatchNodeId, Vec<BatchNodeId>> = BTreeMap::new();
    for edge in &template.edges {
        *indegree
            .get_mut(&edge.to.node_id)
            .ok_or(RecipeError::InvalidTemplate)? += 1;
        outgoing
            .entry(edge.from.node_id.clone())
            .or_default()
            .push(edge.to.node_id.clone());
    }
    let mut ready = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
        .collect::<BTreeSet<_>>();
    let mut result = Vec::new();
    while let Some(id) = ready.pop_first() {
        result.push(id.clone());
        for target in outgoing.get(&id).into_iter().flatten() {
            let count = indegree
                .get_mut(target)
                .ok_or(RecipeError::InvalidTemplate)?;
            *count -= 1;
            if *count == 0 {
                ready.insert(target.clone());
            }
        }
    }
    if result.len() == nodes.len() {
        Ok(result)
    } else {
        Err(RecipeError::Cycle)
    }
}

fn validate_token(value: &str) -> Result<(), RecipeError> {
    if value.is_empty()
        || value.len() > 160
        || value.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':'))
        })
    {
        Err(RecipeError::InvalidTemplate)
    } else {
        Ok(())
    }
}

fn valid_hash(hash: &ObjectHash) -> bool {
    hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hash(value: &impl Serialize) -> Result<ObjectHash, RecipeError> {
    serde_json::to_vec(value)
        .map(|bytes| ObjectHash::of_bytes(&bytes))
        .map_err(|error| RecipeError::Serialization(error.to_string()))
}

const fn terminal(state: BatchRunState) -> bool {
    matches!(
        state,
        BatchRunState::Cancelled | BatchRunState::Failed | BatchRunState::Completed
    )
}

const fn valid_state_transition(current: BatchRunState, next: BatchRunState) -> bool {
    matches!(
        (current, next),
        (
            BatchRunState::Queued,
            BatchRunState::Queued | BatchRunState::Running
        ) | (
            BatchRunState::Queued | BatchRunState::Running,
            BatchRunState::Cancelling | BatchRunState::Cancelled | BatchRunState::Failed
        ) | (
            BatchRunState::Running,
            BatchRunState::Running | BatchRunState::Completed
        ) | (
            BatchRunState::Cancelling,
            BatchRunState::Cancelling | BatchRunState::Cancelled | BatchRunState::Failed
        ) | (BatchRunState::Cancelled, BatchRunState::Cancelled)
            | (BatchRunState::Failed, BatchRunState::Failed)
            | (BatchRunState::Completed, BatchRunState::Completed)
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RecipeError {
    #[error("invalid recipe template")]
    InvalidTemplate,
    #[error("recipe graph contains a cycle")]
    Cycle,
    #[error("recipe is not ready: {0:?}")]
    NotReady(Vec<RecipeReadinessIssue>),
    #[error("invalid processing set")]
    InvalidProcessingSet,
    #[error("invalid concrete batch run")]
    InvalidRun,
    #[error("batch progress is not monotonic")]
    InvalidProgress,
    #[error("checkpoint does not belong to the concrete run")]
    CheckpointDoesNotMatch,
    #[error("recipe serialization failed: {0}")]
    Serialization(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photolab_batch::{ProcessingSetId, ProcessingSetScope};
    use crate::photolab_matching::ImageId;

    fn object(label: &[u8]) -> ObjectHash {
        ObjectHash::of_bytes(label)
    }

    fn requirements() -> RasterSlotRequirements {
        RasterSlotRequirements {
            horizontal_crs_sha256: object(b"crs"),
            height_reference: HeightReference::Orthometric {
                vertical_crs: "EPSG:7837".into(),
            },
            linear_unit: LinearUnit::Meter,
            required_coverage: Coverage2d {
                minimum: [100.0, 200.0],
                maximum: [200.0, 300.0],
            },
            maximum_resolution: [0.1, 0.1],
            allow_nodata: false,
        }
    }

    fn dem() -> FrozenProjectArtifact {
        FrozenProjectArtifact {
            artifact: BatchArtifactKind::Dem,
            entity_id: "project:dem:surveyed".into(),
            entity_revision: 7,
            entity_version_sha256: object(b"entity-version"),
            content_sha256: object(b"dem-content"),
            provider_id: "hcad.io.geotiff-rust@1".into(),
            provider_version: "1.0.0".into(),
            format_id: "geotiff@1.1".into(),
            provider_config_sha256: object(b"provider-config"),
            raster: Some(RasterArtifactMetadata {
                horizontal_crs_sha256: object(b"crs"),
                height_reference: HeightReference::Orthometric {
                    vertical_crs: "EPSG:7837".into(),
                },
                linear_unit: LinearUnit::Meter,
                coverage: Coverage2d {
                    minimum: [90.0, 190.0],
                    maximum: [210.0, 310.0],
                },
                resolution: [0.05, 0.05],
                nodata: NoDataDefinition::None,
            }),
        }
    }

    fn generic(artifact: BatchArtifactKind, label: &[u8]) -> FrozenProjectArtifact {
        FrozenProjectArtifact {
            artifact,
            entity_id: format!("project:{}", String::from_utf8_lossy(label)),
            entity_revision: 1,
            entity_version_sha256: object(&[label, b"-entity"].concat()),
            content_sha256: object(&[label, b"-content"].concat()),
            provider_id: "hcad.project.canonical@1".into(),
            provider_version: "1.0.0".into(),
            format_id: "hcad-canonical@1".into(),
            provider_config_sha256: object(&[label, b"-config"].concat()),
            raster: None,
        }
    }

    fn bindings() -> Vec<ExternalArtifactBinding> {
        vec![
            ExternalArtifactBinding {
                slot_id: ArtifactSlotId("alignment".into()),
                artifact: generic(BatchArtifactKind::Alignment, b"alignment"),
            },
            ExternalArtifactBinding {
                slot_id: ArtifactSlotId("images".into()),
                artifact: generic(BatchArtifactKind::ImportedImages, b"images"),
            },
            ExternalArtifactBinding {
                slot_id: ArtifactSlotId("dem".into()),
                artifact: dem(),
            },
        ]
    }

    fn processing_set() -> ProcessingSetScope {
        ProcessingSetScope::new(
            ProcessingSetId("processing-set-1".into()),
            "Survey".into(),
            vec![ImageId(1), ImageId(2)],
        )
        .expect("processing set")
    }

    #[test]
    fn external_dem_recipe_is_never_ready_without_an_explicit_binding() {
        let template = standard_recipe(
            StandardRecipeKind::OrthomosaicFromExternalDem,
            Some(requirements()),
        )
        .expect("template");
        let readiness = template.readiness(&bindings()[..2]);
        assert!(!readiness.ready);
        assert!(readiness.issues.iter().any(|issue| {
            issue.kind == RecipeReadinessIssueKind::MissingBinding
                && issue.slot_id == Some(ArtifactSlotId("dem".into()))
        }));
    }

    #[test]
    fn raster_readiness_checks_crs_height_unit_coverage_resolution_and_nodata() {
        let template = standard_recipe(
            StandardRecipeKind::OrthomosaicFromExternalDem,
            Some(requirements()),
        )
        .expect("template");
        let mut invalid = bindings();
        let raster = invalid[2].artifact.raster.as_mut().expect("raster");
        raster.horizontal_crs_sha256 = object(b"wrong-crs");
        raster.height_reference = HeightReference::Local;
        raster.linear_unit = LinearUnit::FootInternational;
        raster.coverage.maximum = [150.0, 250.0];
        raster.resolution = [0.5, 0.5];
        raster.nodata = NoDataDefinition::Value { value: -9999.0 };
        let kinds = template
            .readiness(&invalid)
            .issues
            .into_iter()
            .map(|issue| issue.kind)
            .collect::<BTreeSet<_>>();
        for expected in [
            RecipeReadinessIssueKind::CrsMismatch,
            RecipeReadinessIssueKind::HeightReferenceMismatch,
            RecipeReadinessIssueKind::UnitMismatch,
            RecipeReadinessIssueKind::InsufficientCoverage,
            RecipeReadinessIssueKind::ResolutionTooCoarse,
            RecipeReadinessIssueKind::NoDataNotAllowed,
        ] {
            assert!(kinds.contains(&expected));
        }
    }

    #[test]
    fn concrete_run_freezes_every_identity_and_rejects_tampering() {
        let template = standard_recipe(
            StandardRecipeKind::OrthomosaicFromExternalDem,
            Some(requirements()),
        )
        .expect("template");
        let run = template
            .instantiate("run-2026-07-20".into(), processing_set(), bindings())
            .expect("concrete run");
        run.validate().expect("valid run");
        assert_eq!(
            run.external_bindings
                .iter()
                .find(|binding| binding.slot_id.0 == "dem")
                .expect("DEM binding")
                .artifact
                .entity_revision,
            7
        );
        let mut tampered = run.clone();
        tampered
            .external_bindings
            .iter_mut()
            .find(|binding| binding.slot_id.0 == "dem")
            .expect("DEM binding")
            .artifact
            .content_sha256 = object(b"changed");
        assert_eq!(tampered.validate(), Err(RecipeError::InvalidRun));
    }

    #[test]
    fn resume_requires_the_exact_concrete_plan_and_has_no_user_input_state() {
        let run = standard_recipe(
            StandardRecipeKind::OrthomosaicFromExternalDem,
            Some(requirements()),
        )
        .expect("template")
        .instantiate("run-1".into(), processing_set(), bindings())
        .expect("run");
        let progress = BatchRunProgress {
            plan_sha256: run.plan_sha256.clone(),
            state: BatchRunState::Running,
            completed_nodes: 1,
            total_nodes: u32::try_from(run.nodes.len()).expect("node count"),
            completed_units: 10,
            total_units: 100,
        };
        let checkpoint = BatchRunCheckpoint {
            schema_version: RECIPE_SCHEMA_VERSION,
            plan_sha256: run.plan_sha256.clone(),
            completed_node_ids: vec![BatchNodeId("ortho".into())],
            committed_output_sha256: vec![object(b"depth-output")],
            progress,
        };
        checkpoint.validate_for_resume(&run).expect("resume");
        let completed = BatchRunProgress {
            plan_sha256: run.plan_sha256.clone(),
            state: BatchRunState::Completed,
            completed_nodes: 1,
            total_nodes: 1,
            completed_units: 100,
            total_units: 100,
        };
        checkpoint
            .progress
            .validate_successor(&completed)
            .expect("legal monotone completion");
        let mut incomplete = completed.clone();
        incomplete.completed_units = 99;
        assert_eq!(
            checkpoint.progress.validate_successor(&incomplete),
            Err(RecipeError::InvalidProgress)
        );
        let states = serde_json::to_string(&[
            BatchRunState::Queued,
            BatchRunState::Running,
            BatchRunState::Cancelling,
            BatchRunState::Cancelled,
            BatchRunState::Failed,
            BatchRunState::Completed,
        ])
        .expect("states");
        assert!(!states.to_ascii_lowercase().contains("userinput"));
    }

    #[test]
    fn io_mappings_are_exact_provider_facade_routes() {
        let mappings = standard_product_io_mappings();
        assert!(mappings.iter().any(|mapping| {
            mapping.artifact == BatchArtifactKind::Dem
                && mapping.direction == BatchIoDirection::Import
                && mapping.provider_id == "hcad.io.geotiff-rust@1"
                && mapping.format_id == "geotiff@1.1"
        }));
        assert!(mappings.iter().all(|mapping| {
            !mapping.provider_id.trim().is_empty()
                && !mapping.provider_version.trim().is_empty()
                && !mapping.format_id.trim().is_empty()
        }));
    }
}
