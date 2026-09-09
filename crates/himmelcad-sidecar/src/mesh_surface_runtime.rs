//! Recoverable MT-D1 surface drafts and journal-last V-02 TIN publication.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use himmelcad_core::canonical_document::EntityVersionRef;
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, CurveGeometry, ElevationSurfaceGeometry, EntityTypeId,
    GeometryObject, Position, Representation, RepresentationAuthority, RepresentationRole,
    Transform3d, TriangleMeshGeometry, TriangleMeshStorage,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash,
};
use himmelcad_core::geometry_representation_registry::{
    CanonicalRepresentationAdmission, SectionIndexComponentType, SectionPositionComponentType,
    SectionTopologyPartitionManifest,
};
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::mesh_surface::{
    apply_surface_fix, check_surface_draft, downsample_surface_region_with_cancel,
    inspect_surface_region, smooth_surface_region_with_cancel, triangulate_surface_with_cancel,
    SurfaceCheckResult, SurfaceDownsampleParameters, SurfaceDraft, SurfaceEditMetrics,
    SurfaceEditRegion, SurfaceEditResult, SurfaceFixRequest, SurfaceFixResult, SurfaceLine,
    SurfaceMesh, SurfacePoint, SurfaceRegionSummary, SurfaceRules, SurfaceSmoothParameters,
    SurfaceSourceRole, SURFACE_ALGORITHM_ID, SURFACE_DOWNSAMPLE_ALGORITHM_ID,
    SURFACE_SMOOTH_ALGORITHM_ID,
};
use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_core::release_05_admissions::{
    seal_mesh_source_roles, DerivedSourceV1, MeshSourceRoleKindV1, MeshSourceRoleV1,
    MeshSourceRolesV1,
};
use himmelcad_io::{
    CanonicalImportPackage, CanonicalJsonObject, CanonicalStagedImport, StagedArtifactRoots,
    CANONICAL_IO_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};

use crate::canonical_app_runtime::CanonicalAppRuntime;
use crate::mesh_tiler::{PreparedMeshProduct, PreparedSectionTopologyPart};
use crate::pointcloud_ground::GroundScope;
use crate::pointcloud_sampling::{
    read_surface_points, HEIGHT_GRID_HEADER_BYTES, HEIGHT_GRID_MAGIC, HEIGHT_GRID_RECORD_BYTES,
};
use crate::prepared_triangle_mesh::{
    build_prepared_triangle_mesh, package_prepared_triangle_mesh, PreparedTriangleMeshOptions,
    TriangleRecord,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceSourceRequest {
    pub source: EntityVersionRef,
    pub role: SurfaceSourceRole,
    #[serde(default)]
    pub visible_classes: BTreeSet<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSurfaceDraftRequest {
    pub draft_id: String,
    pub name: String,
    pub sources: Vec<SurfaceSourceRequest>,
    pub rules: SurfaceRules,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceSourceSummary {
    pub entity_id: String,
    pub name: String,
    pub role: SurfaceSourceRole,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceDraftSummary {
    pub schema_id: String,
    pub draft_id: String,
    pub sources: Vec<SurfaceSourceSummary>,
    pub checkpoint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceDraftCheckpoint {
    schema_id: String,
    draft: SurfaceDraft,
    source_requests: Vec<SurfaceSourceRequest>,
    source_summaries: Vec<SurfaceSourceSummary>,
    #[serde(default)]
    source_placements: BTreeMap<String, Transform3d>,
    #[serde(default)]
    output_owner: Option<EntityId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfacePublishResult {
    pub schema_id: String,
    pub algorithm_id: String,
    pub draft_id: String,
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
    pub triangles: u64,
    pub area: f64,
    pub z_range: [f64; 2],
    pub residual: himmelcad_core::mesh_surface::SurfaceResidual,
    pub journal_entry: himmelcad_core::canonical_document::CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditRegionRequest {
    pub edit_id: String,
    pub target: EntityVersionRef,
    pub region: SurfaceEditRegion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditRegionResult {
    pub schema_id: String,
    pub edit_id: String,
    pub target_entity_id: String,
    pub target_revision: u64,
    pub summary: SurfaceRegionSummary,
    pub checkpoint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditPreview {
    pub schema_id: String,
    pub edit_id: String,
    pub algorithm_id: String,
    pub metrics: SurfaceEditMetrics,
    /// Bounded operation overlay; large previews keep the certified result in
    /// staging and return only the first deterministic triangle partition.
    pub positions: Vec<[f64; 3]>,
    pub indices: Vec<u32>,
    pub constrained_edges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditBakeRequest {
    pub edit_id: String,
    pub operation_id: String,
    pub progress_key: String,
    pub command_id: String,
    pub output_entity_id: String,
    pub output_name: String,
    #[serde(default)]
    pub smooth: Option<SurfaceSmoothParameters>,
    #[serde(default)]
    pub downsample: Option<SurfaceDownsampleParameters>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditBakeResult {
    pub schema_id: String,
    pub edit_id: String,
    pub algorithm_id: String,
    pub source_entity_id: String,
    pub entity_id: String,
    pub revision: u64,
    pub dataset_id: String,
    pub metrics: SurfaceEditMetrics,
    pub journal_entry: himmelcad_core::canonical_document::CanonicalJournalEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceEditCheckpoint {
    schema_id: String,
    edit_id: String,
    target: EntityVersionRef,
    region: SurfaceEditRegion,
    #[serde(default)]
    preview_algorithm_id: Option<String>,
    #[serde(default)]
    preview_parameters: Option<serde_json::Value>,
    #[serde(default)]
    preview_result_hash: Option<ObjectHash>,
    state: String,
}

#[derive(Debug, Clone)]
struct LoadedSurface {
    entity: CanonicalEntity,
    representation_slot: String,
    mesh: SurfaceMesh,
    breaklines: Vec<CurveGeometry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SectionTopologyIndexOwned {
    schema_version: u32,
    parts: Vec<PreparedSectionTopologyPart>,
}

pub fn create_surface_draft(
    runtime: &CanonicalAppRuntime,
    request: CreateSurfaceDraftRequest,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(f64, &str),
) -> Result<SurfaceDraftSummary> {
    validate_id(&request.draft_id, "draftId")?;
    anyhow::ensure!(!request.name.trim().is_empty(), "surface name is empty");
    anyhow::ensure!(!request.sources.is_empty(), "surface has no sources");
    let root = draft_root(runtime, &request.draft_id)?;
    fs::create_dir_all(&root)?;
    let bootstrap = runtime.residency_bootstrap()?;
    let draw = runtime.list_draw_curves()?;
    let mut points = Vec::new();
    let mut lines = Vec::new();
    let mut summaries = Vec::new();
    let mut source_placements = BTreeMap::new();
    let mut output_owner = None;
    for (index, source) in request.sources.iter().enumerate() {
        cancellation.check()?;
        let entry = bootstrap
            .entries
            .iter()
            .find(|entry| EntityVersionRef::from_entity(&entry.admission.entity) == source.source);
        let draw_curve = draw.iter().find(|curve| {
            curve.entity_id == source.source.id.0
                && curve.revision == source.source.revision
                && curve.admission.entity.version_hash == source.source.version_hash
        });
        let before = points.len()
            + lines
                .iter()
                .map(|line: &SurfaceLine| line.vertices.len())
                .sum::<usize>();
        let name = if let Some(curve) = draw_curve {
            anyhow::ensure!(
                source.role != SurfaceSourceRole::Points,
                "polyline source requires a line role"
            );
            let placement = curve
                .admission
                .entity
                .placement
                .unwrap_or(Transform3d::IDENTITY);
            lines.push(SurfaceLine {
                source_id: source.source.id.0.clone(),
                role: source.role,
                vertices: curve
                    .vertices
                    .iter()
                    .enumerate()
                    .map(|(vertex, position)| {
                        surface_point(&source.source.id.0, vertex, *position, placement)
                    })
                    .collect(),
                closed: curve.closed,
            });
            source_placements.insert(source.source.id.0.clone(), placement);
            output_owner = output_owner.or_else(|| curve.admission.entity.owner.clone());
            curve.name.clone()
        } else {
            let entry =
                entry.context("surface source is stale, missing, or has no live representation")?;
            let placement = entry
                .admission
                .entity
                .placement
                .unwrap_or(Transform3d::IDENTITY);
            source_placements.insert(source.source.id.0.clone(), placement);
            output_owner = output_owner.or_else(|| entry.admission.entity.owner.clone());
            match &entry.admission.resolved_geometry {
                GeometryObject::Point { position } => {
                    anyhow::ensure!(
                        source.role == SurfaceSourceRole::Points,
                        "point source requires points role"
                    );
                    points.push(surface_point(&source.source.id.0, 0, *position, placement));
                }
                GeometryObject::Curve { curve } => {
                    anyhow::ensure!(
                        source.role != SurfaceSourceRole::Points,
                        "polyline source requires a line role"
                    );
                    let (positions, closed) = polyline_positions(curve)?;
                    lines.push(SurfaceLine {
                        source_id: source.source.id.0.clone(),
                        role: source.role,
                        vertices: positions
                            .into_iter()
                            .enumerate()
                            .map(|(vertex, position)| {
                                surface_point(&source.source.id.0, vertex, position, placement)
                            })
                            .collect(),
                        closed,
                    });
                }
                GeometryObject::PointCloud { .. } => {
                    anyhow::ensure!(
                        source.role == SurfaceSourceRole::Points,
                        "point cloud requires points role"
                    );
                    let input = root.join(format!("source-{index}"));
                    let captured = runtime.prepare_ground_source(source.source.clone(), input)?;
                    let mut scope = GroundScope::default();
                    scope.placement = placement.0;
                    if !source.visible_classes.is_empty() {
                        scope.visible_classes = source.visible_classes.clone();
                    }
                    points.extend(read_surface_points(
                        &captured.input_root.join("metadata.json"),
                        &captured.input_root.join("hierarchy.bin"),
                        &captured.input_root.join("octree.bin"),
                        &source.source.id.0,
                        request.rules.thin_cloud_spacing,
                        &scope,
                        cancellation,
                        |_| {},
                    )?);
                }
                GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
                    ElevationSurfaceGeometry::Grid {
                        raster, mapping, ..
                    } => {
                        anyhow::ensure!(
                            source.role == SurfaceSourceRole::Points,
                            "grid source requires points role"
                        );
                        let mut object = runtime.automation_object_source(&raster.object_hash)?;
                        points.extend(read_height_grid(
                            &mut object.source,
                            &source.source.id.0,
                            placement,
                            mapping.origin.x,
                            mapping.origin.y,
                        )?);
                    }
                    _ => anyhow::bail!("an existing TIN is not admitted as a point source"),
                },
                _ => anyhow::bail!("unsupported surface source geometry"),
            }
            entry.admission.entity.name.clone()
        };
        let after = points.len() + lines.iter().map(|line| line.vertices.len()).sum::<usize>();
        summaries.push(SurfaceSourceSummary {
            entity_id: source.source.id.0.clone(),
            name,
            role: source.role,
            count: (after - before) as u64,
        });
        progress(
            (index + 1) as f64 / request.sources.len() as f64,
            "Capturing source snapshot",
        );
    }
    let checkpoint = SurfaceDraftCheckpoint {
        schema_id: "hcad.mesh.surface-draft-checkpoint@1".into(),
        draft: SurfaceDraft {
            draft_id: request.draft_id.clone(),
            name: request.name,
            points,
            lines,
            rules: request.rules,
            excluded_source_ids: BTreeSet::new(),
            excluded_point_ids: BTreeSet::new(),
        },
        source_requests: request.sources,
        source_summaries: summaries.clone(),
        source_placements,
        output_owner,
    };
    write_checkpoint(&root, &checkpoint)?;
    Ok(SurfaceDraftSummary {
        schema_id: "hcad.mesh.surface-draft-result@1".into(),
        draft_id: checkpoint.draft.draft_id,
        sources: summaries,
        checkpoint: "captured".into(),
    })
}

pub fn check_persisted_surface(
    runtime: &CanonicalAppRuntime,
    draft_id: &str,
) -> Result<SurfaceCheckResult> {
    let checkpoint = read_checkpoint(&draft_root(runtime, draft_id)?)?;
    Ok(check_surface_draft(&checkpoint.draft)?)
}

pub fn fix_persisted_surface(
    runtime: &CanonicalAppRuntime,
    draft_id: &str,
    request: &SurfaceFixRequest,
) -> Result<SurfaceFixResult> {
    let root = draft_root(runtime, draft_id)?;
    let mut checkpoint = read_checkpoint(&root)?;
    let fixed = apply_surface_fix(&checkpoint.draft, request)?;
    checkpoint.draft = fixed.draft.clone();
    write_checkpoint(&root, &checkpoint)?;
    Ok(fixed)
}

pub fn publish_persisted_surface(
    runtime: &mut CanonicalAppRuntime,
    draft_id: &str,
    output_entity_id: String,
    command_id: String,
    completed_at: String,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(f64, &str),
) -> Result<SurfacePublishResult> {
    validate_id(&output_entity_id, "outputEntityId")?;
    let root = draft_root(runtime, draft_id)?;
    let checkpoint = read_checkpoint(&root)?;
    progress(0.02, "Triangulate");
    let mesh =
        triangulate_surface_with_cancel(&checkpoint.draft, || cancellation.is_cancel_requested())?;
    cancellation.check()?;
    progress(0.42, "Constrain");
    let prepared_root = root.join("prepared");
    let triangles = mesh.indices.chunks_exact(3).map(|indices| TriangleRecord {
        positions: [
            mesh.positions[indices[0] as usize],
            mesh.positions[indices[1] as usize],
            mesh.positions[indices[2] as usize],
        ],
        material_slot: None,
        texture_coordinates: None,
    });
    let prepared = build_prepared_triangle_mesh(
        triangles,
        &prepared_root,
        PreparedTriangleMeshOptions::default(),
        cancellation,
    )?;
    progress(0.72, "Validate");
    let entity_id = EntityId(output_entity_id.clone());
    let staged = staged_surface_package(
        &checkpoint,
        &mesh,
        &prepared,
        &prepared_root,
        &entity_id,
        &completed_at,
    )?;
    cancellation.check()?;
    progress(0.82, "Bake");
    let commit = runtime.publish_staged_import_with_progress_and_cancel(
        &staged,
        &command_id,
        &mut |_| {},
        &|| cancellation.is_cancel_requested(),
    )?;
    commit
        .inventory
        .admissions
        .first()
        .context("surface publish returned no admission")?;
    let dataset = staged
        .package
        .datasets
        .first()
        .context("surface publish returned no dataset")?;
    progress(1.0, "Surface ready");
    Ok(SurfacePublishResult {
        schema_id: "hcad.mesh.surface-result@1".into(),
        algorithm_id: SURFACE_ALGORITHM_ID.into(),
        draft_id: draft_id.into(),
        entity_id: output_entity_id,
        revision: 0,
        dataset_id: dataset.dataset_id.clone(),
        triangles: prepared.triangle_count,
        area: mesh.projected_area,
        z_range: mesh.z_range,
        residual: mesh.source_residual,
        journal_entry: commit.journal_entry,
    })
}

pub fn select_surface_edit_region(
    runtime: &CanonicalAppRuntime,
    request: SurfaceEditRegionRequest,
) -> Result<SurfaceEditRegionResult> {
    validate_id(&request.edit_id, "editId")?;
    let loaded = load_surface(runtime, &request.target)?;
    let summary = inspect_surface_region(&loaded.mesh, &request.region)?;
    let checkpoint = SurfaceEditCheckpoint {
        schema_id: "hcad.mesh.surface-edit-checkpoint@1".into(),
        edit_id: request.edit_id.clone(),
        target: request.target.clone(),
        region: request.region,
        preview_algorithm_id: None,
        preview_parameters: None,
        preview_result_hash: None,
        state: "region_selected".into(),
    };
    write_edit_checkpoint(&edit_root(runtime, &request.edit_id)?, &checkpoint)?;
    Ok(SurfaceEditRegionResult {
        schema_id: "hcad.mesh.edit-region-result@1".into(),
        edit_id: request.edit_id,
        target_entity_id: request.target.id.0,
        target_revision: request.target.revision,
        summary,
        checkpoint: checkpoint.state,
    })
}

pub fn preview_surface_smoothing(
    runtime: &CanonicalAppRuntime,
    edit_id: &str,
    parameters: &SurfaceSmoothParameters,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(f64, &str),
) -> Result<SurfaceEditPreview> {
    preview_surface_edit(
        runtime,
        edit_id,
        SURFACE_SMOOTH_ALGORITHM_ID,
        serde_json::to_value(parameters)?,
        cancellation,
        &mut progress,
        |mesh, region, cancellation| {
            smooth_surface_region_with_cancel(mesh, region, parameters, || {
                cancellation.is_cancel_requested()
            })
        },
    )
}

pub fn preview_surface_downsample(
    runtime: &CanonicalAppRuntime,
    edit_id: &str,
    parameters: &SurfaceDownsampleParameters,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(f64, &str),
) -> Result<SurfaceEditPreview> {
    preview_surface_edit(
        runtime,
        edit_id,
        SURFACE_DOWNSAMPLE_ALGORITHM_ID,
        serde_json::to_value(parameters)?,
        cancellation,
        &mut progress,
        |mesh, region, cancellation| {
            downsample_surface_region_with_cancel(mesh, region, parameters, || {
                cancellation.is_cancel_requested()
            })
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn preview_surface_edit(
    runtime: &CanonicalAppRuntime,
    edit_id: &str,
    algorithm_id: &str,
    parameters: serde_json::Value,
    cancellation: &CancellationToken,
    progress: &mut impl FnMut(f64, &str),
    evaluate: impl FnOnce(
        &SurfaceMesh,
        &SurfaceEditRegion,
        &CancellationToken,
    )
        -> Result<SurfaceEditResult, himmelcad_core::mesh_surface::SurfaceEditError>,
) -> Result<SurfaceEditPreview> {
    let root = edit_root(runtime, edit_id)?;
    let mut checkpoint = read_edit_checkpoint(&root)?;
    progress(0.05, "Verify source");
    let loaded = load_surface(runtime, &checkpoint.target)?;
    cancellation.check()?;
    progress(0.2, "Cut region");
    let result = evaluate(&loaded.mesh, &checkpoint.region, cancellation)?;
    cancellation.check()?;
    progress(0.85, "Certify result");
    checkpoint.preview_algorithm_id = Some(algorithm_id.into());
    checkpoint.preview_parameters = Some(parameters);
    checkpoint.preview_result_hash = Some(result.metrics.result_hash.clone());
    checkpoint.state = "preview_ready".into();
    write_edit_checkpoint(&root, &checkpoint)?;
    let (positions, indices, constrained_edges) = preview_partition(&result.mesh, 20_000);
    progress(1.0, "Preview ready");
    Ok(SurfaceEditPreview {
        schema_id: "hcad.mesh.surface-edit-preview@1".into(),
        edit_id: edit_id.into(),
        algorithm_id: algorithm_id.into(),
        metrics: result.metrics,
        positions,
        indices,
        constrained_edges,
    })
}

pub fn bake_surface_edit(
    runtime: &mut CanonicalAppRuntime,
    request: &SurfaceEditBakeRequest,
    completed_at: &str,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(f64, &str),
) -> Result<SurfaceEditBakeResult> {
    validate_id(&request.edit_id, "editId")?;
    validate_id(&request.output_entity_id, "outputEntityId")?;
    anyhow::ensure!(
        !request.output_name.trim().is_empty(),
        "output name is empty"
    );
    anyhow::ensure!(
        request.smooth.is_some() ^ request.downsample.is_some(),
        "bake requires exactly one edit parameter payload"
    );
    let root = edit_root(runtime, &request.edit_id)?;
    let mut checkpoint = read_edit_checkpoint(&root)?;
    checkpoint.state = "baking".into();
    write_edit_checkpoint(&root, &checkpoint)?;
    progress(0.03, "Verify source");
    let loaded = load_surface(runtime, &checkpoint.target)?;
    cancellation.check()?;
    progress(0.12, "Cut region");
    let (algorithm_id, parameter_type_id, parameters, result) =
        if let Some(parameters) = &request.smooth {
            (
                SURFACE_SMOOTH_ALGORITHM_ID,
                "hcad.mesh.smooth-region-parameters@1",
                serde_json::to_value(parameters)?,
                smooth_surface_region_with_cancel(
                    &loaded.mesh,
                    &checkpoint.region,
                    parameters,
                    || cancellation.is_cancel_requested(),
                )?,
            )
        } else {
            let parameters = request
                .downsample
                .as_ref()
                .expect("exclusive payload checked");
            (
                SURFACE_DOWNSAMPLE_ALGORITHM_ID,
                "hcad.mesh.simplify-terrain@1",
                serde_json::to_value(parameters)?,
                downsample_surface_region_with_cancel(
                    &loaded.mesh,
                    &checkpoint.region,
                    parameters,
                    || cancellation.is_cancel_requested(),
                )?,
            )
        };
    cancellation.check()?;
    if checkpoint.preview_algorithm_id.as_deref() == Some(algorithm_id)
        && checkpoint.preview_parameters.as_ref() == Some(&parameters)
    {
        anyhow::ensure!(
            checkpoint.preview_result_hash.as_ref() == Some(&result.metrics.result_hash),
            "deterministic bake differs from the verified preview"
        );
    }
    progress(0.48, "Prepare triangles");
    let prepared_root = root
        .join("prepared")
        .join(result.metrics.result_hash.as_str());
    let triangles = result
        .mesh
        .indices
        .chunks_exact(3)
        .map(|indices| TriangleRecord {
            positions: [
                result.mesh.positions[indices[0] as usize],
                result.mesh.positions[indices[1] as usize],
                result.mesh.positions[indices[2] as usize],
            ],
            material_slot: None,
            texture_coordinates: None,
        });
    let prepared = build_prepared_triangle_mesh(
        triangles,
        &prepared_root,
        PreparedTriangleMeshOptions::default(),
        cancellation,
    )?;
    progress(0.75, "Validate certificate");
    anyhow::ensure!(
        request.downsample.is_none() || result.metrics.error.certified,
        "downsample certificate does not meet the requested target"
    );
    let entity_id = EntityId(request.output_entity_id.clone());
    let staged = staged_edited_surface_package(
        &loaded,
        &checkpoint,
        &result,
        &prepared,
        &prepared_root,
        &entity_id,
        &request.output_name,
        algorithm_id,
        parameter_type_id,
        parameters,
        completed_at,
    )?;
    cancellation.check()?;
    progress(0.84, "Publish generation");
    let commit = runtime.publish_staged_import_with_progress_and_cancel(
        &staged,
        &request.command_id,
        &mut |_| {},
        &|| cancellation.is_cancel_requested(),
    )?;
    let dataset = staged
        .package
        .datasets
        .first()
        .context("surface edit publish returned no dataset")?;
    checkpoint.state = "completed".into();
    write_edit_checkpoint(&root, &checkpoint)?;
    progress(1.0, "Surface ready");
    Ok(SurfaceEditBakeResult {
        schema_id: "hcad.mesh.surface-edit-result@1".into(),
        edit_id: request.edit_id.clone(),
        algorithm_id: algorithm_id.into(),
        source_entity_id: loaded.entity.id.0,
        entity_id: request.output_entity_id.clone(),
        revision: 0,
        dataset_id: dataset.dataset_id.clone(),
        metrics: result.metrics,
        journal_entry: commit.journal_entry,
    })
}

#[allow(clippy::too_many_arguments)]
fn staged_edited_surface_package(
    source: &LoadedSurface,
    checkpoint: &SurfaceEditCheckpoint,
    result: &SurfaceEditResult,
    prepared: &PreparedMeshProduct,
    prepared_root: &Path,
    entity_id: &EntityId,
    output_name: &str,
    algorithm_id: &str,
    parameter_type_id: &str,
    parameters: serde_json::Value,
    completed_at: &str,
) -> Result<CanonicalStagedImport> {
    let render = prepared
        .kernel_manifest_resource
        .clone()
        .context("prepared edited TIN has no render manifest")?;
    let dataset = package_prepared_triangle_mesh(prepared_root, prepared, entity_id)?;
    let geometry = GeometryObject::ElevationSurface {
        surface: Box::new(ElevationSurfaceGeometry::Tin {
            mesh: TriangleMeshGeometry {
                storage: TriangleMeshStorage::Resource {
                    resource: render.clone(),
                },
                closed_manifold: false,
                triangle_material_slots: None,
                materials: None,
            },
            breaklines: source.breaklines.clone(),
        }),
    };
    let geometry_ref = geometry_object_content_hash(&geometry)?;
    let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
        "target": checkpoint.target,
        "region": checkpoint.region,
        "parameters": parameters,
        "algorithmId": algorithm_id,
    }))?);
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({
            "hcad.prepared-dataset@1": {
                "formatId": dataset.format_id,
                "manifestRef": dataset.root_metadata.object_hash,
                "sectionTopologyRef": prepared.section_topology.as_ref().map(|value| &value.manifest_resource.object_hash),
            },
        }),
    )?;
    let recipe = serde_json::json!({
        "schemaId": "hcad.derived-recipe@1",
        "schemaVersion": 1,
        "recipeId": format!("surface-edit-recipe:{}", checkpoint.edit_id),
        "recipeKind": algorithm_id,
        "generation": 1,
        "state": "linked-current",
        "outputGroupId": entity_id,
        "outputs": [{
            "slotId": "surface",
            "role": "tin",
            "outputId": entity_id,
            "typeId": built_in_type::ELEVATION_SURFACE,
            "locator": "source",
            "currentRevision": 0,
            "currentContentHash": geometry_ref,
            "status": "present"
        }],
        "sources": [{
            "entityId": checkpoint.target.id,
            "revision": checkpoint.target.revision,
            "contentHash": checkpoint.target.version_hash,
            "placementRevision": checkpoint.target.revision,
            "role": "source_surface"
        }],
        "parameterTypeId": parameter_type_id,
        "parameters": { "region": checkpoint.region, "operation": parameters },
        "algorithmId": algorithm_id,
        "algorithmVersion": env!("CARGO_PKG_VERSION"),
        "dependencyRecipeIds": [],
        "staleCauses": [],
        "lastSuccess": {
            "generation": 1,
            "sourceFingerprint": source_fingerprint,
            "outputs": [{
                "slotId": "surface",
                "outputId": entity_id,
                "revision": 0,
                "contentHash": geometry_ref
            }],
            "completedAt": completed_at
        },
        "lastError": null,
        "detach": null
    });
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({
            "hcad.derived-recipe@1": recipe,
            "hcad.mesh.surface-edit-result@1": result.metrics,
        }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!({
            "schemaId": "hcad.relations@1",
            "relations": [{
                "relationType": "hcad.derived-from@1",
                "target": checkpoint.target.id,
                "expectedVersion": checkpoint.target.version_hash,
                "parameters": source_fingerprint
            }]
        }),
    )?;
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_ref.clone(),
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: Some(source_fingerprint),
    };
    let mut entity = CanonicalEntity {
        id: entity_id.clone(),
        revision: 0,
        type_id: EntityTypeId(built_in_type::ELEVATION_SURFACE.into()),
        name: output_name.into(),
        owner: source.entity.owner.clone(),
        layer_ids: source.entity.layer_ids.clone(),
        placement: source.entity.placement,
        representations: vec![selected.clone()],
        components_ref: components.object_hash.clone(),
        attributes_ref: attributes.object_hash.clone(),
        relations_ref: relations.object_hash.clone(),
        style_ref: source.entity.style_ref.clone(),
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending edited surface entity"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)?;
    let mut roots = StagedArtifactRoots::default();
    roots
        .dataset_roots
        .insert(dataset.dataset_id.clone(), prepared_root.to_owned());
    Ok(CanonicalStagedImport {
        package: CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: algorithm_id.into(),
            provider_version: env!("CARGO_PKG_VERSION").into(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity,
                selected,
                representation_slot: source.representation_slot.clone(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects: vec![components, attributes, relations],
            datasets: vec![dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        },
        roots,
    })
}

fn load_surface(
    runtime: &CanonicalAppRuntime,
    expected: &EntityVersionRef,
) -> Result<LoadedSurface> {
    let bootstrap = runtime.residency_bootstrap()?;
    let entry = bootstrap
        .entries
        .into_iter()
        .find(|entry| EntityVersionRef::from_entity(&entry.admission.entity) == *expected)
        .context("surface is stale, missing, or has no live representation")?;
    let GeometryObject::ElevationSurface { surface } = &entry.admission.resolved_geometry else {
        anyhow::bail!("selected entity is not an elevation surface");
    };
    let ElevationSurfaceGeometry::Tin { mesh, breaklines } = surface.as_ref() else {
        anyhow::bail!("surface editing requires a TIN; convert the Grid first");
    };
    let (positions, indices) = match &mesh.storage {
        TriangleMeshStorage::Inline {
            positions, indices, ..
        } => (
            positions
                .iter()
                .map(|point| [point.x, point.y, point.z])
                .collect(),
            indices.clone(),
        ),
        TriangleMeshStorage::Resource { .. } => load_prepared_topology(
            runtime,
            entry.dataset.as_ref().context("TIN dataset is missing")?,
        )?,
    };
    let mut coordinate_index = BTreeMap::<[u64; 3], u32>::new();
    for (index, point) in positions.iter().enumerate() {
        coordinate_index
            .entry(point.map(f64::to_bits))
            .or_insert(u32::try_from(index)?);
    }
    let mut constrained_edges = Vec::new();
    for curve in breaklines {
        let CurveGeometry::Polyline {
            positions: line,
            closed,
        } = curve
        else {
            anyhow::bail!("TIN breakline is not a polyline");
        };
        let line_indices = line
            .iter()
            .map(|point| {
                let z = point
                    .z
                    .context("TIN breakline has no authoritative height")?;
                coordinate_index
                    .get(&[point.x.to_bits(), point.y.to_bits(), z.to_bits()])
                    .copied()
                    .context("TIN breakline vertex is absent from authoritative topology")
            })
            .collect::<Result<Vec<_>>>()?;
        constrained_edges.extend(line_indices.windows(2).map(|edge| [edge[0], edge[1]]));
        if *closed && line_indices.len() > 2 {
            constrained_edges.push([*line_indices.last().expect("closed line"), line_indices[0]]);
        }
    }
    let mut area = 0.0;
    let mut z_range = [f64::INFINITY, f64::NEG_INFINITY];
    for point in &positions {
        z_range[0] = z_range[0].min(point[2]);
        z_range[1] = z_range[1].max(point[2]);
    }
    for triangle in indices.chunks_exact(3) {
        let a = positions[triangle[0] as usize];
        let b = positions[triangle[1] as usize];
        let c = positions[triangle[2] as usize];
        area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs() * 0.5;
    }
    Ok(LoadedSurface {
        entity: entry.admission.entity,
        representation_slot: entry.admission.representation_slot,
        mesh: SurfaceMesh {
            source_residual: himmelcad_core::mesh_surface::SurfaceResidual {
                count: positions.len(),
                mean_absolute: 0.0,
                maximum_absolute: 0.0,
            },
            positions,
            indices,
            constrained_edges,
            projected_area: area,
            z_range,
        },
        breaklines: breaklines.clone(),
    })
}

fn load_prepared_topology(
    runtime: &CanonicalAppRuntime,
    dataset: &himmelcad_io::CanonicalPreparedDataset,
) -> Result<(Vec<[f64; 3]>, Vec<u32>)> {
    let topology = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.resource.media_type == "hcad.section-topology-index@2")
        .context("TIN has no authoritative section topology")?;
    let index: SectionTopologyIndexOwned =
        serde_json::from_slice(&read_object(runtime, &topology.resource.object_hash)?)?;
    anyhow::ensure!(
        index.schema_version == 2,
        "unsupported section topology index"
    );
    let mut positions = Vec::<[f64; 3]>::new();
    let mut indices = Vec::<u32>::new();
    let mut coordinate_index = BTreeMap::<[u64; 3], u32>::new();
    for part in index.parts {
        let manifest_hash = ObjectHash(part.topology_hash);
        let manifest: SectionTopologyPartitionManifest =
            serde_json::from_slice(&read_object(runtime, &manifest_hash)?)?;
        let position_bytes = read_object(runtime, &manifest.positions.object_hash)?;
        let local_positions = decode_positions(&position_bytes, &manifest)?;
        let index_bytes = read_object(runtime, &manifest.indices.object_hash)?;
        let local_indices = decode_indices(&index_bytes, &manifest)?;
        let mut remap = Vec::with_capacity(local_positions.len());
        for point in local_positions {
            let global = if let Some(index) = coordinate_index.get(&point.map(f64::to_bits)) {
                *index
            } else {
                let index = u32::try_from(positions.len())?;
                coordinate_index.insert(point.map(f64::to_bits), index);
                positions.push(point);
                index
            };
            remap.push(global);
        }
        indices.extend(local_indices.into_iter().map(|index| remap[index as usize]));
    }
    Ok((positions, indices))
}

fn decode_positions(
    bytes: &[u8],
    manifest: &SectionTopologyPartitionManifest,
) -> Result<Vec<[f64; 3]>> {
    let width = match manifest.position_component_type {
        SectionPositionComponentType::Float32 => 4,
        SectionPositionComponentType::Float64 => 8,
    };
    anyhow::ensure!(
        bytes.len() == manifest.vertex_count as usize * 3 * width,
        "section position byte length changed"
    );
    let mut positions = Vec::with_capacity(manifest.vertex_count as usize);
    for vertex in 0..manifest.vertex_count as usize {
        let mut point = [0.0; 3];
        for axis in 0..3 {
            let offset = (vertex * 3 + axis) * width;
            point[axis] = match manifest.position_component_type {
                SectionPositionComponentType::Float32 => {
                    f32::from_le_bytes(bytes[offset..offset + 4].try_into()?) as f64
                }
                SectionPositionComponentType::Float64 => {
                    f64::from_le_bytes(bytes[offset..offset + 8].try_into()?)
                }
            } + manifest.origin[axis];
        }
        positions.push(point);
    }
    Ok(positions)
}

fn decode_indices(bytes: &[u8], manifest: &SectionTopologyPartitionManifest) -> Result<Vec<u32>> {
    let width = match manifest.index_component_type {
        SectionIndexComponentType::Uint16 => 2,
        SectionIndexComponentType::Uint32 => 4,
    };
    let count = usize::try_from(manifest.index_count)?;
    anyhow::ensure!(
        bytes.len() == count * width,
        "section index byte length changed"
    );
    (0..count)
        .map(|index| {
            let offset = index * width;
            Ok(match manifest.index_component_type {
                SectionIndexComponentType::Uint16 => {
                    u16::from_le_bytes(bytes[offset..offset + 2].try_into()?) as u32
                }
                SectionIndexComponentType::Uint32 => {
                    u32::from_le_bytes(bytes[offset..offset + 4].try_into()?)
                }
            })
        })
        .collect()
}

fn read_object(runtime: &CanonicalAppRuntime, hash: &ObjectHash) -> Result<Vec<u8>> {
    let mut source = runtime.automation_object_source(hash)?.source;
    let mut bytes = Vec::new();
    source.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn preview_partition(
    mesh: &SurfaceMesh,
    maximum_triangles: usize,
) -> (Vec<[f64; 3]>, Vec<u32>, Vec<[u32; 2]>) {
    let source_indices = mesh
        .indices
        .iter()
        .take(maximum_triangles.saturating_mul(3));
    let mut positions = Vec::new();
    let mut remap = BTreeMap::<u32, u32>::new();
    let mut indices = Vec::new();
    for source in source_indices {
        let output = if let Some(index) = remap.get(source) {
            *index
        } else {
            let index = u32::try_from(positions.len()).unwrap_or(u32::MAX);
            positions.push(mesh.positions[*source as usize]);
            remap.insert(*source, index);
            index
        };
        indices.push(output);
    }
    let constrained_edges = mesh
        .constrained_edges
        .iter()
        .filter_map(|edge| Some([*remap.get(&edge[0])?, *remap.get(&edge[1])?]))
        .collect();
    (positions, indices, constrained_edges)
}

fn edit_root(runtime: &CanonicalAppRuntime, edit_id: &str) -> Result<PathBuf> {
    validate_id(edit_id, "editId")?;
    Ok(runtime
        .project_root()?
        .join(".staging/mesh-surface-edit")
        .join(edit_id))
}

fn write_edit_checkpoint(root: &Path, checkpoint: &SurfaceEditCheckpoint) -> Result<()> {
    fs::create_dir_all(root)?;
    let pending = root.join("edit.json.pending");
    fs::write(&pending, serde_json::to_vec(checkpoint)?)?;
    fs::rename(pending, root.join("edit.json"))?;
    Ok(())
}

fn read_edit_checkpoint(root: &Path) -> Result<SurfaceEditCheckpoint> {
    let checkpoint: SurfaceEditCheckpoint =
        serde_json::from_slice(&fs::read(root.join("edit.json"))?)?;
    anyhow::ensure!(
        checkpoint.schema_id == "hcad.mesh.surface-edit-checkpoint@1",
        "unsupported surface edit checkpoint"
    );
    Ok(checkpoint)
}

fn staged_surface_package(
    checkpoint: &SurfaceDraftCheckpoint,
    mesh: &SurfaceMesh,
    prepared: &PreparedMeshProduct,
    prepared_root: &Path,
    entity_id: &EntityId,
    completed_at: &str,
) -> Result<CanonicalStagedImport> {
    let render = prepared
        .kernel_manifest_resource
        .clone()
        .context("prepared TIN has no render manifest")?;
    let dataset = package_prepared_triangle_mesh(prepared_root, prepared, entity_id)?;
    let geometry = GeometryObject::ElevationSurface {
        surface: Box::new(ElevationSurfaceGeometry::Tin {
            mesh: TriangleMeshGeometry {
                storage: TriangleMeshStorage::Resource {
                    resource: render.clone(),
                },
                closed_manifold: false,
                triangle_material_slots: None,
                materials: None,
            },
            breaklines: checkpoint
                .draft
                .lines
                .iter()
                .filter(|line| {
                    line.role == SurfaceSourceRole::Breakline
                        && !checkpoint
                            .draft
                            .excluded_source_ids
                            .contains(&line.source_id)
                })
                .map(|line| CurveGeometry::Polyline {
                    positions: line
                        .vertices
                        .iter()
                        .map(|point| Position {
                            x: point.position[0],
                            y: point.position[1],
                            z: point.z,
                        })
                        .collect(),
                    closed: line.closed,
                })
                .collect(),
        }),
    };
    let geometry_ref = geometry_object_content_hash(&geometry)?;
    let source_fingerprint =
        ObjectHash::of_bytes(&serde_json::to_vec(&checkpoint.source_requests)?);
    let role_entries = checkpoint
        .source_requests
        .iter()
        .map(|request| MeshSourceRoleV1 {
            source: DerivedSourceV1 {
                entity_id: request.source.id.clone(),
                revision: request.source.revision,
                content_hash: request.source.version_hash.clone(),
                placement_revision: request.source.revision,
                role: source_role_name(request.role).into(),
            },
            placement: checkpoint
                .source_placements
                .get(&request.source.id.0)
                .copied()
                .unwrap_or(Transform3d::IDENTITY),
            role: admitted_role(request.role),
            sampling_tolerance: (request.role == SurfaceSourceRole::Points)
                .then_some(checkpoint.draft.rules.thin_cloud_spacing),
            sampling_hash: (request.role == SurfaceSourceRole::Points)
                .then_some(source_fingerprint.clone()),
            boundary_hash: matches!(
                request.role,
                SurfaceSourceRole::OuterBoundary | SurfaceSourceRole::Hole
            )
            .then_some(request.source.version_hash.clone()),
            exclusion_hashes: Vec::new(),
        })
        .collect();
    let roles = seal_mesh_source_roles(MeshSourceRolesV1 {
        schema_id: "hcad.mesh-source-roles@1".into(),
        schema_version: 1,
        resource_id: format!("mesh-source-roles:{}", checkpoint.draft.draft_id),
        content_hash: ObjectHash::of_bytes(b"pending"),
        roles: role_entries,
    })?;
    let owner = checkpoint.output_owner.clone();
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({
            "hcad.prepared-dataset@1": {
                "formatId": dataset.format_id,
                "manifestRef": dataset.root_metadata.object_hash,
                "sectionTopologyRef": prepared.section_topology.as_ref().map(|value| &value.manifest_resource.object_hash),
            },
            "hcad.mesh-source-roles@1": roles,
        }),
    )?;
    let recipe = serde_json::json!({
        "schemaId": "hcad.derived-recipe@1", "schemaVersion": 1,
        "recipeId": format!("surface-recipe:{}", checkpoint.draft.draft_id),
        "recipeKind": "surface_tin", "generation": 1, "state": "linked-current",
        "outputGroupId": owner.clone(), "outputs": [{"slotId":"surface", "role":"tin", "outputId":entity_id, "typeId":built_in_type::ELEVATION_SURFACE, "locator":"source", "currentRevision":0, "currentContentHash":geometry_ref, "status":"present"}],
        "sources": checkpoint.source_requests.iter().map(|value| serde_json::json!({"entityId":value.source.id,"revision":value.source.revision,"contentHash":value.source.version_hash,"placementRevision":value.source.revision,"role":source_role_name(value.role)})).collect::<Vec<_>>(),
        "parameterTypeId":"hcad.mesh.surface-rules@1", "parameters":checkpoint.draft.rules,
        "algorithmId":SURFACE_ALGORITHM_ID, "algorithmVersion":env!("CARGO_PKG_VERSION"),
        "dependencyRecipeIds":[], "staleCauses":[],
        "lastSuccess":{"generation":1,"sourceFingerprint":source_fingerprint,"outputs":[{"slotId":"surface","outputId":entity_id,"revision":0,"contentHash":geometry_ref}],"completedAt":completed_at},
        "lastError":null,"detach":null
    });
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({
            "hcad.derived-recipe@1": recipe,
            "hcad.mesh.surface-result@1": {"triangles": prepared.triangle_count, "area":mesh.projected_area,"zRange":mesh.z_range,"residual":mesh.source_residual}
        }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!({
            "schemaId":"hcad.relations@1","relations":checkpoint.source_requests.iter().map(|value| serde_json::json!({"relationType":"hcad.derived-from@1","target":value.source.id,"expectedVersion":value.source.version_hash,"parameters":source_fingerprint})).collect::<Vec<_>>()
        }),
    )?;
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_ref.clone(),
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: Some(source_fingerprint),
    };
    let mut entity = CanonicalEntity {
        id: entity_id.clone(),
        revision: 0,
        type_id: EntityTypeId(built_in_type::ELEVATION_SURFACE.into()),
        name: checkpoint.draft.name.clone(),
        owner,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref: components.object_hash.clone(),
        attributes_ref: attributes.object_hash.clone(),
        relations_ref: relations.object_hash.clone(),
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending surface entity"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)?;
    let mut roots = StagedArtifactRoots::default();
    roots
        .dataset_roots
        .insert(dataset.dataset_id.clone(), prepared_root.to_owned());
    Ok(CanonicalStagedImport {
        package: CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "hcad.mesh.surface@1".into(),
            provider_version: env!("CARGO_PKG_VERSION").into(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity,
                selected,
                representation_slot: "source".into(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects: vec![components, attributes, relations],
            datasets: vec![dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        },
        roots,
    })
}

fn polyline_positions(curve: &CurveGeometry) -> Result<(Vec<Position>, bool)> {
    match curve {
        CurveGeometry::LineSegment { start, end } => Ok((vec![*start, *end], false)),
        CurveGeometry::Polyline { positions, closed } => Ok((positions.clone(), *closed)),
        _ => anyhow::bail!("surface source must be a line or polyline"),
    }
}

fn surface_point(
    source: &str,
    index: usize,
    point: Position,
    placement: Transform3d,
) -> SurfacePoint {
    let m = placement.0;
    let z = point
        .z
        .map(|z| m[2] * point.x + m[6] * point.y + m[10] * z + m[14]);
    SurfacePoint {
        point_id: format!("{source}:{index}"),
        source_id: source.into(),
        position: [
            m[0] * point.x + m[4] * point.y + point.z.unwrap_or(0.0) * m[8] + m[12],
            m[1] * point.x + m[5] * point.y + point.z.unwrap_or(0.0) * m[9] + m[13],
        ],
        z,
    }
}

fn read_height_grid(
    file: &mut File,
    source: &str,
    placement: Transform3d,
    fallback_x: f64,
    fallback_y: f64,
) -> Result<Vec<SurfacePoint>> {
    let mut header = [0_u8; HEIGHT_GRID_HEADER_BYTES];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut header)?;
    anyhow::ensure!(
        &header[..8] == HEIGHT_GRID_MAGIC,
        "invalid height-grid magic"
    );
    let width = u32::from_le_bytes(header[8..12].try_into()?) as usize;
    let height = u32::from_le_bytes(header[12..16].try_into()?) as usize;
    let origin_x = f64::from_le_bytes(header[16..24].try_into()?).to_owned();
    let origin_y = f64::from_le_bytes(header[24..32].try_into()?).to_owned();
    let cell = f64::from_le_bytes(header[32..40].try_into()?);
    let origin_x = if origin_x.is_finite() {
        origin_x
    } else {
        fallback_x
    };
    let origin_y = if origin_y.is_finite() {
        origin_y
    } else {
        fallback_y
    };
    let mut result = Vec::new();
    let mut record = [0_u8; HEIGHT_GRID_RECORD_BYTES];
    for row in 0..height {
        for column in 0..width {
            file.read_exact(&mut record)?;
            if record[0] == 0 {
                continue;
            }
            let z = f64::from_le_bytes(record[1..9].try_into()?);
            result.push(surface_point(
                source,
                row * width + column,
                Position {
                    x: origin_x + column as f64 * cell,
                    y: origin_y + row as f64 * cell,
                    z: Some(z),
                },
                placement,
            ));
        }
    }
    Ok(result)
}

fn draft_root(runtime: &CanonicalAppRuntime, draft_id: &str) -> Result<PathBuf> {
    validate_id(draft_id, "draftId")?;
    Ok(runtime
        .project_root()?
        .join(".staging/mesh-surface")
        .join(draft_id))
}

fn validate_id(value: &str, label: &str) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "{label} is invalid"
    );
    Ok(())
}

fn write_checkpoint(root: &Path, checkpoint: &SurfaceDraftCheckpoint) -> Result<()> {
    fs::create_dir_all(root)?;
    let pending = root.join("draft.json.pending");
    fs::write(&pending, serde_json::to_vec(checkpoint)?)?;
    fs::rename(pending, root.join("draft.json"))?;
    Ok(())
}

fn read_checkpoint(root: &Path) -> Result<SurfaceDraftCheckpoint> {
    let checkpoint: SurfaceDraftCheckpoint =
        serde_json::from_slice(&fs::read(root.join("draft.json"))?)?;
    anyhow::ensure!(
        checkpoint.schema_id == "hcad.mesh.surface-draft-checkpoint@1",
        "unsupported surface checkpoint"
    );
    Ok(checkpoint)
}

fn admitted_role(role: SurfaceSourceRole) -> MeshSourceRoleKindV1 {
    match role {
        SurfaceSourceRole::Points => MeshSourceRoleKindV1::Points,
        SurfaceSourceRole::Breakline => MeshSourceRoleKindV1::Breakline,
        SurfaceSourceRole::FormLine => MeshSourceRoleKindV1::FormLine,
        SurfaceSourceRole::OuterBoundary => MeshSourceRoleKindV1::OuterBoundary,
        SurfaceSourceRole::Hole => MeshSourceRoleKindV1::Hole,
    }
}

fn source_role_name(role: SurfaceSourceRole) -> &'static str {
    match role {
        SurfaceSourceRole::Points => "points",
        SurfaceSourceRole::Breakline => "breakline",
        SurfaceSourceRole::FormLine => "form_line",
        SurfaceSourceRole::OuterBoundary => "outer_boundary",
        SurfaceSourceRole::Hole => "hole",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mesh_surface_checkpoint_restarts_without_partial_publish_state() {
        let temp = std::env::temp_dir().join(format!(
            "hcad-mesh-surface-checkpoint-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let checkpoint = SurfaceDraftCheckpoint {
            schema_id: "hcad.mesh.surface-draft-checkpoint@1".into(),
            draft: SurfaceDraft {
                draft_id: "restart".into(),
                name: "DGM".into(),
                points: Vec::new(),
                lines: Vec::new(),
                rules: SurfaceRules::default(),
                excluded_source_ids: BTreeSet::new(),
                excluded_point_ids: BTreeSet::new(),
            },
            source_requests: Vec::new(),
            source_summaries: Vec::new(),
            source_placements: BTreeMap::new(),
            output_owner: None,
        };
        write_checkpoint(&temp, &checkpoint).expect("checkpoint");
        assert_eq!(read_checkpoint(&temp).expect("restart"), checkpoint);
        assert!(!temp.join("prepared").exists());
        fs::remove_dir_all(&temp).expect("remove test checkpoint");
    }

    #[test]
    fn mesh_surface_edit_checkpoint_restarts_without_partial_generation() {
        let temp = std::env::temp_dir().join(format!(
            "hcad-mesh-surface-edit-checkpoint-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let checkpoint = SurfaceEditCheckpoint {
            schema_id: "hcad.mesh.surface-edit-checkpoint@1".into(),
            edit_id: "edit-restart".into(),
            target: EntityVersionRef {
                id: EntityId("surface-a".into()),
                revision: 4,
                version_hash: ObjectHash::of_bytes(b"surface-a@4"),
            },
            region: SurfaceEditRegion {
                source: himmelcad_core::mesh_surface::SurfaceRegionSource::Fence,
                polygon: vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]],
            },
            preview_algorithm_id: Some(SURFACE_SMOOTH_ALGORITHM_ID.into()),
            preview_parameters: Some(serde_json::json!({"filter":"gaussian","radius":1.0})),
            preview_result_hash: Some(ObjectHash::of_bytes(b"preview")),
            state: "baking".into(),
        };
        write_edit_checkpoint(&temp, &checkpoint).expect("checkpoint");
        assert_eq!(read_edit_checkpoint(&temp).expect("restart"), checkpoint);
        assert!(!temp.join("prepared").exists());
        fs::remove_dir_all(&temp).expect("remove test checkpoint");
    }
}
