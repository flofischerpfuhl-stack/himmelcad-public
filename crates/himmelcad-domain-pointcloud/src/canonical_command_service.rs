//! Point-cloud canonical command services independent of the sidecar host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use himmelcad_core::release_05_admissions::{
    DerivedSourceV1, MeshSourceRoleKindV1, MeshSourceRoleV1, MeshSourceRolesV1,
    MESH_SOURCE_ROLES_SCHEMA_ID,
};
use himmelcad_document::canonical_document::{
    CanonicalCommandTransaction, CanonicalEntityEdit, CanonicalEntityMutation,
    CanonicalJournalEntry, EntityVersionRef,
};
use himmelcad_document::domain_commands::{DomainImportProgress, PointCloudDocumentCommands};
use himmelcad_io::{
    CanonicalImportPackage, CanonicalJsonObject, CanonicalPreparedDataset, PreparedDatasetArtifact,
    CANONICAL_IO_SCHEMA_VERSION,
};
use himmelcad_model::canonical_resources::PointCloudDisplayStyle;
use himmelcad_model::entity::EntityId;
use himmelcad_model::entity_model::{
    built_in_type, CanonicalEntity, DepthSampling, DepthSemantics, ElevationSurfaceGeometry,
    EntityTypeId, GeometryObject, GeometryResource, OrthoGridMapping, RasterConnectivity,
    RasterImageGeometry, RasterInterpolation, RasterMapping, Representation,
    RepresentationAuthority, RepresentationRole, StreamedGeometry, Vector3,
};
use himmelcad_model::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash,
};
use himmelcad_model::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_model::hash::ObjectHash;

use crate::commands::{
    derived_point_dataset_id, derived_recipe_value, ground_dataset_id, segment_dataset_id,
    CanonicalGroundCommit, CanonicalGroundSource, CanonicalGroundSourceCapture,
    CanonicalRasterizeCommit, CanonicalSampleCommit, CanonicalSegmentCommit,
    CanonicalSegmentRevision, CanonicalSourceCaptureArtifact, CanonicalSourceCaptureProgress,
};
use crate::pointcloud_ground::{PreparedGroundDataset, PreparedGroundResult};
use crate::pointcloud_sampling::{
    PreparedHeightGrid, PreparedSampleResult, RasterAggregation, HEIGHT_GRID_FORMAT_ID,
    RASTERIZE_ALGORITHM_ID, SAMPLE_ALGORITHM_ID,
};
use crate::pointcloud_segment::{PreparedSegmentResult, SEGMENT_ALGORITHM_ID};

#[derive(Debug)]
pub enum PointCloudCommandError<E> {
    Backend(E),
    InvalidResidency(String),
    Io(std::io::Error),
    Json(serde_json::Error),
}
fn canonical_json<E>(
    media_type: &str,
    value: serde_json::Value,
) -> Result<CanonicalJsonObject, PointCloudCommandError<E>> {
    CanonicalJsonObject::new(media_type, value)
        .map_err(|error| PointCloudCommandError::<E>::InvalidResidency(error.to_string()))
}

fn merge_object<E>(
    mut value: serde_json::Value,
    key: &str,
    extension: serde_json::Value,
) -> Result<serde_json::Value, PointCloudCommandError<E>> {
    value
        .as_object_mut()
        .ok_or_else(|| {
            PointCloudCommandError::<E>::InvalidResidency(
                "point-cloud canonical component is not an object".to_owned(),
            )
        })?
        .insert(key.to_owned(), extension);
    Ok(value)
}

fn mesh_source_roles<E>(
    entity_id: &str,
    content_hash: &ObjectHash,
    source_role: &str,
    placement: himmelcad_core::entity_model::Transform3d,
    sampling_hash: Option<ObjectHash>,
) -> Result<MeshSourceRolesV1, PointCloudCommandError<E>> {
    Ok(MeshSourceRolesV1 {
        schema_id: MESH_SOURCE_ROLES_SCHEMA_ID.to_owned(),
        schema_version: 1,
        resource_id: format!("mesh-source-{entity_id}"),
        content_hash: ObjectHash::of_bytes(b""),
        roles: vec![MeshSourceRoleV1 {
            source: DerivedSourceV1 {
                entity_id: EntityId(entity_id.to_owned()),
                revision: 0,
                content_hash: content_hash.clone(),
                placement_revision: 0,
                role: source_role.to_owned(),
            },
            placement,
            // MT-D26's admitted enum has exactly five roles. A grid carries its exact
            // source role above and enters the draft through the Points evaluator.
            role: MeshSourceRoleKindV1::Points,
            sampling_tolerance: None,
            sampling_hash,
            boundary_hash: None,
            exclusion_hashes: Vec::new(),
        }],
    })
}

fn ground_dataset_contract<E>(
    prepared: &PreparedGroundDataset,
    dataset_id: &str,
    entity_id: &str,
    representation_slot: &str,
) -> Result<(CanonicalPreparedDataset, GeometryObject, Representation), PointCloudCommandError<E>> {
    let artifacts = prepared
        .artifacts
        .iter()
        .map(|artifact| PreparedDatasetArtifact {
            relative_path: PathBuf::from(&artifact.relative_path),
            resource: GeometryResource {
                object_hash: artifact.object_hash.clone(),
                media_type: artifact.media_type.clone(),
                byte_length: Some(artifact.byte_length),
            },
        })
        .collect::<Vec<_>>();
    let root_metadata = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == Path::new("metadata.json"))
        .map(|artifact| artifact.resource.clone())
        .ok_or_else(|| {
            PointCloudCommandError::<E>::InvalidResidency(
                "prepared ground dataset has no metadata".to_owned(),
            )
        })?;
    let dataset = CanonicalPreparedDataset {
        dataset_id: dataset_id.to_owned(),
        format_id: "potree@2".to_owned(),
        entity_id: entity_id.to_owned(),
        representation_slot: representation_slot.to_owned(),
        root_metadata: root_metadata.clone(),
        artifacts,
    };
    let geometry = GeometryObject::PointCloud {
        dataset: StreamedGeometry {
            format_id: "potree@2".to_owned(),
            metadata: root_metadata,
            element_count: Some(prepared.point_count),
        },
    };
    let representation = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry)
            .map_err(|error| PointCloudCommandError::<E>::InvalidResidency(error.to_string()))?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    Ok((dataset, geometry, representation))
}

impl<E> From<std::io::Error> for PointCloudCommandError<E> {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl<E> From<serde_json::Error> for PointCloudCommandError<E> {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub struct PointCloudQueryService<'a, D> {
    document: &'a D,
}

impl<'a, D> PointCloudQueryService<'a, D> {
    pub fn new(document: &'a D) -> Self {
        Self { document }
    }
}

impl<D> PointCloudQueryService<'_, D>
where
    D: PointCloudDocumentCommands,
{
    /// Captures one live point cloud and materializes its three Potree files for bounded work.
    pub fn prepare_ground_source(
        &self,
        expected: EntityVersionRef,
        input_root: PathBuf,
    ) -> Result<CanonicalGroundSource, PointCloudCommandError<D::Error>> {
        self.prepare_ground_source_with_progress(expected, input_root, &mut |_| true)
    }

    /// Captures a prepared point-cloud source with truthful byte progress and
    /// cancellation checks during immutable-object verification.
    pub fn prepare_ground_source_with_progress(
        &self,
        expected: EntityVersionRef,
        input_root: PathBuf,
        progress: &mut dyn FnMut(CanonicalSourceCaptureProgress) -> bool,
    ) -> Result<CanonicalGroundSource, PointCloudCommandError<D::Error>> {
        let capture = self.plan_ground_source_capture(expected, input_root)?;
        let mut completed_bytes = 0_u64;
        for artifact in &capture.artifacts {
            let artifact_name = artifact.artifact.clone();
            self.document
                .pointcloud_materialize_verified_path(
                    &artifact.source_path,
                    &artifact.destination_path,
                    &artifact.object_hash,
                    artifact.byte_length,
                    &mut |bytes| {
                        completed_bytes = completed_bytes.saturating_add(bytes);
                        progress(CanonicalSourceCaptureProgress {
                            artifact: artifact_name.clone(),
                            completed_bytes,
                            total_bytes: capture.total_bytes.max(1),
                        })
                    },
                )
                .map_err(PointCloudCommandError::Backend)?;
        }
        Ok(capture.source)
    }

    /// Resolves one immutable capture under the project lock without doing
    /// the long file verification. The caller can then verify/materialize the
    /// returned paths while canonical range reads remain responsive.
    pub fn plan_ground_source_capture(
        &self,
        expected: EntityVersionRef,
        input_root: PathBuf,
    ) -> Result<CanonicalGroundSourceCapture, PointCloudCommandError<D::Error>> {
        let entries = self
            .document
            .pointcloud_residency_entries()
            .map_err(PointCloudCommandError::Backend)?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.admission.entity.id == expected.id)
            .ok_or_else(|| {
                PointCloudCommandError::<D::Error>::InvalidResidency(
                    "selected point cloud has no live prepared dataset".to_owned(),
                )
            })?;
        if EntityVersionRef::from_entity(&entry.admission.entity) != expected {
            return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                "selected point-cloud revision changed before ground extraction".to_owned(),
            ));
        }
        let dataset = entry.dataset.ok_or_else(|| {
            PointCloudCommandError::<D::Error>::InvalidResidency(
                "selected point cloud is not a prepared dataset".to_owned(),
            )
        })?;
        if dataset.format_id != "potree@2" {
            return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                "ground extraction requires an uncompressed Potree 2 dataset".to_owned(),
            ));
        }
        std::fs::create_dir_all(&input_root)?;
        let store = self.document;
        let captured_artifacts = dataset
            .artifacts
            .iter()
            .filter_map(|artifact| {
                let name = artifact.relative_path.file_name()?.to_str()?;
                matches!(name, "metadata.json" | "hierarchy.bin" | "octree.bin")
                    .then_some((name.to_owned(), artifact))
            })
            .collect::<Vec<_>>();
        if captured_artifacts.len() != 3 {
            return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                "prepared point cloud is missing metadata.json, hierarchy.bin, or octree.bin"
                    .to_owned(),
            ));
        }
        let artifacts = captured_artifacts
            .into_iter()
            .map(|(name, artifact)| {
                let byte_length = artifact.resource.byte_length.map_or_else(
                    || store.pointcloud_object_byte_length(&artifact.resource.object_hash),
                    Ok,
                )?;
                Ok(CanonicalSourceCaptureArtifact {
                    source_path: store.pointcloud_object_path(&artifact.resource.object_hash)?,
                    destination_path: input_root.join(&name),
                    object_hash: artifact.resource.object_hash.clone(),
                    byte_length,
                    artifact: name,
                })
            })
            .collect::<Result<Vec<_>, D::Error>>()
            .map_err(PointCloudCommandError::Backend)?;
        let total_bytes = artifacts.iter().fold(0_u64, |total, artifact| {
            total.saturating_add(artifact.byte_length)
        });
        let entity = entry.admission.entity;
        Ok(CanonicalGroundSourceCapture {
            source: CanonicalGroundSource {
                expected,
                source_components: serde_json::from_slice(
                    &store
                        .pointcloud_read_object(&entity.components_ref)
                        .map_err(PointCloudCommandError::Backend)?,
                )?,
                source_attributes: serde_json::from_slice(
                    &store
                        .pointcloud_read_object(&entity.attributes_ref)
                        .map_err(PointCloudCommandError::Backend)?,
                )?,
                source_relations: serde_json::from_slice(
                    &store
                        .pointcloud_read_object(&entity.relations_ref)
                        .map_err(PointCloudCommandError::Backend)?,
                )?,
                source_style: entity
                    .style_ref
                    .as_ref()
                    .map(|hash| store.pointcloud_read_object(hash))
                    .transpose()
                    .map_err(PointCloudCommandError::Backend)?
                    .map(|bytes| serde_json::from_slice(&bytes))
                    .transpose()?,
                entity,
                representation_slot: entry.admission.representation_slot,
                input_root,
            },
            artifacts,
            total_bytes,
        })
    }
}

pub struct PointCloudCommandService<'a, D> {
    document: &'a mut D,
}

impl<'a, D> PointCloudCommandService<'a, D> {
    pub fn new(document: &'a mut D) -> Self {
        Self { document }
    }
}

impl<D> PointCloudCommandService<'_, D>
where
    D: PointCloudDocumentCommands<
        Package = CanonicalImportPackage,
        JsonObject = CanonicalJsonObject,
    >,
{
    pub fn publish_ground_extraction(
        &mut self,
        source: CanonicalGroundSource,
        prepared: &PreparedGroundResult,
        command_id: String,
        ground_entity_id: String,
        output_name: String,
        parameters: serde_json::Value,
        scope: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(DomainImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalGroundCommit, PointCloudCommandError<D::Error>> {
        let recipe_parameters = serde_json::json!({
            "smrf": parameters.clone(),
            "scope": scope.clone(),
        });
        let source_dataset_id = ground_dataset_id("classified", &prepared.source);
        let ground_dataset_id = ground_dataset_id("ground", &prepared.extracted);
        let (source_dataset, source_geometry, source_representation) = ground_dataset_contract(
            &prepared.source,
            &source_dataset_id,
            &source.entity.id.0,
            &source.representation_slot,
        )?;
        let (ground_dataset, ground_geometry, ground_representation) = ground_dataset_contract(
            &prepared.extracted,
            &ground_dataset_id,
            &ground_entity_id,
            "source",
        )?;

        let source_components = merge_object(
            source.source_components,
            "hcad.prepared-dataset@1",
            serde_json::json!({ "formatId": "potree@2", "datasetId": source_dataset_id }),
        )?;
        let source_attributes = merge_object(
            source.source_attributes,
            "hcad.point-cloud-ground-classification@1",
            serde_json::json!({
                "algorithmId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
                "parameters": parameters.clone(),
                "scope": scope.clone(),
                "membershipSha256": prepared.summary.membership_sha256,
                "summary": prepared.summary,
            }),
        )?;
        let source_components_object = canonical_json(
            "application/vnd.himmelcad.components+json",
            source_components,
        )?;
        let source_attributes_object = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            source_attributes,
        )?;
        let source_relations_object = canonical_json(
            "application/vnd.himmelcad.relations+json",
            source.source_relations,
        )?;

        let ground_geometry_hash = ground_representation.geometry_ref.clone();
        let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "parameters": recipe_parameters,
        }))?);
        let recipe_id = format!(
            "ground-recipe-{}",
            &prepared.summary.membership_sha256.0[..24]
        );
        let recipe = serde_json::json!({
            "schemaId": "hcad.derived-recipe@1",
            "schemaVersion": 1,
            "recipeId": recipe_id,
            "recipeKind": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
            "generation": 1,
            "state": "linked-current",
            "outputGroupId": ground_entity_id,
            "outputs": [{
                "slotId": "ground",
                "role": "ground_cloud",
                "outputId": ground_entity_id,
                "typeId": built_in_type::POINT_CLOUD,
                "locator": "source",
                "currentRevision": 0,
                "currentContentHash": ground_geometry_hash,
                "status": "present"
            }],
            "sources": [{
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "contentHash": source.entity.version_hash,
                "placementRevision": source.entity.revision,
                "role": "outdoor_ground_source"
            }],
            "parameterTypeId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
            "parameters": recipe_parameters,
            "algorithmId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
            "algorithmVersion": "1",
            "dependencyRecipeIds": [],
            "staleCauses": [],
            "lastSuccess": {
                "generation": 1,
                "sourceFingerprint": source_fingerprint,
                "outputs": [{
                    "slotId": "ground",
                    "outputId": ground_entity_id,
                    "revision": 0,
                    "contentHash": ground_geometry_hash
                }],
                "completedAt": completed_at
            },
            "lastError": null,
            "detach": null
        });
        let mut mesh_source_roles = MeshSourceRolesV1 {
            schema_id: MESH_SOURCE_ROLES_SCHEMA_ID.to_owned(),
            schema_version: 1,
            resource_id: format!("mesh-source-{ground_entity_id}"),
            content_hash: ObjectHash::of_bytes(b""),
            roles: vec![MeshSourceRoleV1 {
                source: DerivedSourceV1 {
                    entity_id: EntityId(ground_entity_id.clone()),
                    revision: 0,
                    content_hash: ground_geometry_hash.clone(),
                    placement_revision: 0,
                    role: "ground_cloud".to_owned(),
                },
                placement: source
                    .entity
                    .placement
                    .unwrap_or(himmelcad_core::entity_model::Transform3d::IDENTITY),
                role: MeshSourceRoleKindV1::Points,
                sampling_tolerance: None,
                sampling_hash: None,
                boundary_hash: None,
                exclusion_hashes: Vec::new(),
            }],
        };
        mesh_source_roles.content_hash =
            ObjectHash::of_bytes(&serde_json::to_vec(&mesh_source_roles)?);
        let ground_components_object = canonical_json(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({
                "hcad.prepared-dataset@1": {
                    "formatId": "potree@2",
                    "datasetId": ground_dataset_id
                },
                "hcad.mesh-source-roles@1": mesh_source_roles
            }),
        )?;
        let ground_attributes_object = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.point-cloud-ground@1": {
                    "algorithmId": crate::pointcloud_ground::GROUND_ALGORITHM_ID,
                    "membershipSha256": prepared.summary.membership_sha256,
                    "summary": prepared.summary
                },
                "hcad.derived-recipe@1": recipe
            }),
        )?;
        let ground_relations_object = canonical_json(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([{
                "kind": "derivedFrom",
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "role": "outdoor_ground_source"
            }]),
        )?;
        let style_object = source
            .source_style
            .map(|value| {
                canonical_json("application/vnd.himmelcad.point-cloud-display+json", value)
            })
            .transpose()?;

        let mut source_after = source.entity.clone();
        source_after.revision = source_after.revision.saturating_add(1);
        source_after.representations = vec![source_representation.clone()];
        source_after.components_ref = source_components_object.object_hash.clone();
        source_after.attributes_ref = source_attributes_object.object_hash.clone();
        source_after.version_hash =
            canonical_entity_version_hash(&source_after).map_err(|error| {
                PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
            })?;
        let mut ground_entity = CanonicalEntity {
            id: EntityId(ground_entity_id.clone()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: output_name,
            owner: source.entity.owner.clone(),
            layer_ids: source.entity.layer_ids.clone(),
            placement: source.entity.placement,
            representations: vec![ground_representation.clone()],
            components_ref: ground_components_object.object_hash.clone(),
            attributes_ref: ground_attributes_object.object_hash.clone(),
            relations_ref: ground_relations_object.object_hash.clone(),
            style_ref: style_object
                .as_ref()
                .map(|object| object.object_hash.clone()),
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized ground cloud"),
        };
        ground_entity.version_hash =
            canonical_entity_version_hash(&ground_entity).map_err(|error| {
                PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
            })?;

        let mut objects = vec![
            source_components_object,
            source_attributes_object,
            source_relations_object,
            ground_components_object,
            ground_attributes_object,
            ground_relations_object,
        ];
        if let Some(style) = style_object {
            if !objects
                .iter()
                .any(|object| object.object_hash == style.object_hash)
            {
                objects.push(style);
            }
        }
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "hcad.pointcloud.ground-progressive@1".to_owned(),
            provider_version: "1".to_owned(),
            admissions: vec![
                CanonicalRepresentationAdmission {
                    entity: source_after.clone(),
                    selected: source_representation.clone(),
                    representation_slot: source.representation_slot,
                    expected_generation: None,
                    resolved_geometry: source_geometry,
                },
                CanonicalRepresentationAdmission {
                    entity: ground_entity.clone(),
                    selected: ground_representation,
                    representation_slot: "source".to_owned(),
                    expected_generation: None,
                    resolved_geometry: ground_geometry,
                },
            ],
            objects,
            datasets: vec![source_dataset, ground_dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let roots = [
            (source_dataset_id.clone(), prepared.source.root.clone()),
            (ground_dataset_id.clone(), prepared.extracted.root.clone()),
        ]
        .into_iter()
        .collect();
        let transaction = CanonicalCommandTransaction {
            command_id,
            mutations: vec![
                CanonicalEntityMutation::Update {
                    expected: source.expected,
                    edits: vec![
                        CanonicalEntityEdit::SetRepresentations {
                            representations: source_after.representations.clone(),
                        },
                        CanonicalEntityEdit::SetComponentsRef {
                            components_ref: source_after.components_ref.clone(),
                        },
                        CanonicalEntityEdit::SetAttributesRef {
                            attributes_ref: source_after.attributes_ref.clone(),
                        },
                    ],
                },
                CanonicalEntityMutation::Create {
                    entity: ground_entity.clone(),
                },
            ],
        };
        let journal_entry = self
            .document
            .pointcloud_publish_package(package, roots, transaction, progress, is_cancelled)
            .map_err(PointCloudCommandError::Backend)?;
        Ok(CanonicalGroundCommit {
            journal_entry,
            source_entity_id: source_after.id.0,
            source_revision: source_after.revision,
            ground_entity_id: ground_entity.id.0,
            ground_revision: ground_entity.revision,
            source_dataset_id,
            ground_dataset_id,
        })
    }

    /// Publishes every fully baked source revision in one journal transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_pointcloud_segmentation(
        &mut self,
        sources: Vec<(
            CanonicalGroundSource,
            PreparedSegmentResult,
            serde_json::Value,
        )>,
        command_id: String,
        volume: serde_json::Value,
        side: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(DomainImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalSegmentCommit, PointCloudCommandError<D::Error>> {
        if sources.is_empty() {
            return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                "segmentation requires at least one source".to_owned(),
            ));
        }
        let mut admissions = Vec::with_capacity(sources.len());
        let mut datasets = Vec::with_capacity(sources.len());
        let mut objects = Vec::with_capacity(sources.len() * 3);
        let mut roots = BTreeMap::new();
        let mut mutations = Vec::with_capacity(sources.len());
        let mut revisions = Vec::with_capacity(sources.len());

        for (source, prepared, scope) in sources {
            let dataset_id = segment_dataset_id(&prepared.dataset);
            let (dataset, geometry, representation) = ground_dataset_contract(
                &prepared.dataset,
                &dataset_id,
                &source.entity.id.0,
                &source.representation_slot,
            )?;
            let next_revision = source.entity.revision.saturating_add(1);
            let geometry_hash = representation.geometry_ref.clone();
            let generation = source
                .source_attributes
                .get("hcad.point-cloud-edit-chain@1")
                .and_then(|value| value.get("edits"))
                .and_then(serde_json::Value::as_array)
                .map_or(1_u64, |edits| edits.len() as u64 + 1);
            let source_fingerprint =
                ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
                    "entityId": source.entity.id,
                    "revision": source.entity.revision,
                    "contentHash": source.entity.version_hash,
                    "volume": volume,
                    "side": side,
                    "scope": scope,
                }))?);
            let recipe_id = format!("segment-recipe-{}", &source_fingerprint.0[..24]);
            let recipe = serde_json::json!({
                "schemaId": "hcad.derived-recipe@1",
                "schemaVersion": 1,
                "recipeId": recipe_id,
                "recipeKind": SEGMENT_ALGORITHM_ID,
                "generation": generation,
                "state": "linked-current",
                "outputGroupId": source.entity.id,
                "outputs": [{
                    "slotId": source.representation_slot,
                    "role": "edited_cloud",
                    "outputId": source.entity.id,
                    "typeId": built_in_type::POINT_CLOUD,
                    "locator": source.representation_slot,
                    "currentRevision": next_revision,
                    "currentContentHash": geometry_hash,
                    "status": "present"
                }],
                "sources": [{
                    "entityId": source.entity.id,
                    "revision": source.entity.revision,
                    "contentHash": source.entity.version_hash,
                    "placementRevision": source.entity.revision,
                    "role": "source_revision"
                }],
                "parameterTypeId": SEGMENT_ALGORITHM_ID,
                "parameters": { "volume": volume, "side": side, "scope": scope },
                "algorithmId": SEGMENT_ALGORITHM_ID,
                "algorithmVersion": "1",
                "dependencyRecipeIds": [],
                "staleCauses": [],
                "lastSuccess": {
                    "generation": generation,
                    "sourceFingerprint": source_fingerprint,
                    "outputs": [{
                        "slotId": source.representation_slot,
                        "outputId": source.entity.id,
                        "revision": next_revision,
                        "contentHash": geometry_hash
                    }],
                    "completedAt": completed_at
                },
                "lastError": null,
                "detach": null
            });
            let mut edit_chain = source
                .source_attributes
                .get("hcad.point-cloud-edit-chain@1")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "schemaVersion": 1, "edits": [] }));
            let edits = edit_chain
                .get_mut("edits")
                .and_then(serde_json::Value::as_array_mut)
                .ok_or_else(|| {
                    PointCloudCommandError::<D::Error>::InvalidResidency(
                        "point-cloud edit chain is malformed".to_owned(),
                    )
                })?;
            edits.push(recipe.clone());
            let components = merge_object(
                source.source_components,
                "hcad.prepared-dataset@1",
                serde_json::json!({ "formatId": "potree@2", "datasetId": dataset_id }),
            )?;
            let attributes = merge_object(
                merge_object(
                    source.source_attributes,
                    "hcad.point-cloud-edit-chain@1",
                    edit_chain,
                )?,
                "hcad.derived-recipe@1",
                recipe,
            )?;
            let components_object =
                canonical_json("application/vnd.himmelcad.components+json", components)?;
            let attributes_object =
                canonical_json("application/vnd.himmelcad.attributes+json", attributes)?;
            let relations_object = canonical_json(
                "application/vnd.himmelcad.relations+json",
                source.source_relations,
            )?;
            let mut entity_after = source.entity.clone();
            entity_after.revision = next_revision;
            entity_after.representations = vec![representation.clone()];
            entity_after.components_ref = components_object.object_hash.clone();
            entity_after.attributes_ref = attributes_object.object_hash.clone();
            entity_after.relations_ref = relations_object.object_hash.clone();
            entity_after.version_hash =
                canonical_entity_version_hash(&entity_after).map_err(|error| {
                    PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
                })?;

            mutations.push(CanonicalEntityMutation::Update {
                expected: source.expected,
                edits: vec![
                    CanonicalEntityEdit::SetRepresentations {
                        representations: entity_after.representations.clone(),
                    },
                    CanonicalEntityEdit::SetComponentsRef {
                        components_ref: entity_after.components_ref.clone(),
                    },
                    CanonicalEntityEdit::SetAttributesRef {
                        attributes_ref: entity_after.attributes_ref.clone(),
                    },
                    CanonicalEntityEdit::SetRelationsRef {
                        relations_ref: entity_after.relations_ref.clone(),
                    },
                ],
            });
            roots.insert(dataset_id.clone(), prepared.dataset.root.clone());
            datasets.push(dataset);
            objects.extend([components_object, attributes_object, relations_object]);
            admissions.push(CanonicalRepresentationAdmission {
                entity: entity_after.clone(),
                selected: representation,
                representation_slot: source.representation_slot,
                expected_generation: None,
                resolved_geometry: geometry,
            });
            revisions.push(CanonicalSegmentRevision {
                entity_id: entity_after.id.0,
                revision: entity_after.revision,
                dataset_id,
                retained_points: prepared.summary.retained_points,
                removed_points: prepared.summary.removed_points,
            });
        }

        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: SEGMENT_ALGORITHM_ID.to_owned(),
            provider_version: "1".to_owned(),
            admissions,
            objects,
            datasets,
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let journal_entry = self
            .document
            .pointcloud_publish_package(
                package,
                roots,
                CanonicalCommandTransaction {
                    command_id,
                    mutations,
                },
                progress,
                is_cancelled,
            )
            .map_err(PointCloudCommandError::Backend)?;
        Ok(CanonicalSegmentCommit {
            journal_entry,
            revisions,
        })
    }

    /// Publishes one PC-D8 sampled cloud without changing the captured source revision.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_sampled_cloud(
        &mut self,
        source: CanonicalGroundSource,
        prepared: &PreparedSampleResult,
        command_id: String,
        entity_id: String,
        output_name: String,
        parameters: serde_json::Value,
        scope: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(DomainImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalSampleCommit, PointCloudCommandError<D::Error>> {
        self.ensure_pointcloud_source_current(&source.expected)?;
        let dataset_id = derived_point_dataset_id("sample", SAMPLE_ALGORITHM_ID, &prepared.sampled);
        let (dataset, geometry, representation) =
            ground_dataset_contract(&prepared.sampled, &dataset_id, &entity_id, "source")?;
        let geometry_hash = representation.geometry_ref.clone();
        let recipe_parameters = serde_json::json!({
            "sampling": parameters,
            "scope": scope,
            "randomSeed": crate::pointcloud_sampling::RANDOM_SEED,
            "stableTieRule": prepared.summary.stable_tie_rule,
        });
        let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "parameters": recipe_parameters,
        }))?);
        let recipe_id = format!(
            "sample-recipe-{}",
            &prepared.summary.selection_sha256.as_str()[..24]
        );
        let recipe = derived_recipe_value(
            &recipe_id,
            SAMPLE_ALGORITHM_ID,
            &entity_id,
            "sampled",
            "sampled_cloud",
            built_in_type::POINT_CLOUD,
            &geometry_hash,
            &source,
            "point_cloud_source",
            recipe_parameters,
            source_fingerprint,
            completed_at,
        );
        let mut mesh_source_roles = mesh_source_roles(
            &entity_id,
            &geometry_hash,
            "sampled_cloud",
            source
                .entity
                .placement
                .unwrap_or(himmelcad_core::entity_model::Transform3d::IDENTITY),
            Some(prepared.summary.selection_sha256.clone()),
        )?;
        mesh_source_roles.content_hash =
            ObjectHash::of_bytes(&serde_json::to_vec(&mesh_source_roles)?);
        let components = canonical_json(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({
                "hcad.prepared-dataset@1": {
                    "formatId": "potree@2",
                    "datasetId": dataset_id,
                },
                "hcad.mesh-source-roles@1": mesh_source_roles,
            }),
        )?;
        let attributes = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.pointcloud.sample@1": {
                    "algorithmId": SAMPLE_ALGORITHM_ID,
                    "summary": prepared.summary,
                },
                "hcad.derived-recipe@1": recipe,
            }),
        )?;
        let relations = canonical_json(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([{
                "kind": "derivedFrom",
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "role": "point_cloud_source",
            }]),
        )?;
        let style = source
            .source_style
            .map(|value| {
                canonical_json("application/vnd.himmelcad.point-cloud-display+json", value)
            })
            .transpose()?;
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: output_name,
            owner: source.entity.owner.clone(),
            layer_ids: source.entity.layer_ids.clone(),
            placement: source.entity.placement,
            representations: vec![representation.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: style.as_ref().map(|value| value.object_hash.clone()),
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized sampled cloud"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).map_err(|error| {
            PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
        })?;
        let mut objects = vec![components, attributes, relations];
        if let Some(style) = style {
            objects.push(style);
        }
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: SAMPLE_ALGORITHM_ID.to_owned(),
            provider_version: "1".to_owned(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity: entity.clone(),
                selected: representation,
                representation_slot: "source".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects,
            datasets: vec![dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let roots = [(dataset_id.clone(), prepared.sampled.root.clone())]
            .into_iter()
            .collect();
        let transaction = CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Create {
                entity: entity.clone(),
            }],
        };
        let journal_entry = self
            .document
            .pointcloud_publish_package(package, roots, transaction, progress, is_cancelled)
            .map_err(PointCloudCommandError::Backend)?;
        Ok(CanonicalSampleCommit {
            journal_entry,
            entity_id: entity.id.0,
            revision: entity.revision,
            dataset_id,
        })
    }

    /// Publishes one PC-D17 prepared grid. Count rasters remain RasterImage and are not Mesh height sources.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_height_grid(
        &mut self,
        source: CanonicalGroundSource,
        prepared: &PreparedHeightGrid,
        command_id: String,
        entity_id: String,
        output_name: String,
        parameters: serde_json::Value,
        scope: serde_json::Value,
        completed_at: String,
        progress: &mut dyn FnMut(DomainImportProgress),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<CanonicalRasterizeCommit, PointCloudCommandError<D::Error>> {
        self.ensure_pointcloud_source_current(&source.expected)?;
        let resource = GeometryResource {
            object_hash: prepared.viewer_manifest.object_hash.clone(),
            media_type: prepared.viewer_manifest.media_type.clone(),
            byte_length: Some(prepared.viewer_manifest.byte_length),
        };
        let mapping = OrthoGridMapping {
            origin: Vector3 {
                x: prepared.summary.origin[0],
                y: prepared.summary.origin[1],
                z: 0.0,
            },
            column_step: Vector3 {
                x: prepared.summary.cell_size_m,
                y: 0.0,
                z: 0.0,
            },
            row_step: Vector3 {
                x: 0.0,
                y: prepared.summary.cell_size_m,
                z: 0.0,
            },
        };
        let (entity_type, geometry) = if prepared.summary.aggregation == RasterAggregation::Count {
            (
                built_in_type::RASTER_IMAGE,
                GeometryObject::RasterImage {
                    raster: Box::new(RasterImageGeometry {
                        pixels: resource.clone(),
                        width: prepared.summary.width,
                        height: prepared.summary.height,
                        mapping: RasterMapping::OrthoGrid(mapping),
                        depth: None,
                    }),
                },
            )
        } else {
            (
                built_in_type::ELEVATION_SURFACE,
                GeometryObject::ElevationSurface {
                    surface: Box::new(ElevationSurfaceGeometry::Grid {
                        raster: resource.clone(),
                        mapping,
                        sampling: DepthSampling {
                            semantics: DepthSemantics::ElevationZ,
                            interpolation: RasterInterpolation::Nearest,
                            connectivity: RasterConnectivity::PixelSteps,
                        },
                    }),
                },
            )
        };
        let representation = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).map_err(|error| {
                PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
            })?,
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let geometry_hash = representation.geometry_ref.clone();
        let dataset_id = format!(
            "height-grid-{}",
            &prepared.summary.cell_sha256.as_str()[..32]
        );
        let dataset = CanonicalPreparedDataset {
            dataset_id: dataset_id.clone(),
            format_id: HEIGHT_GRID_FORMAT_ID.to_owned(),
            entity_id: entity_id.clone(),
            representation_slot: "source".to_owned(),
            root_metadata: resource,
            artifacts: std::iter::once(&prepared.artifact)
                .chain(std::iter::once(&prepared.viewer_manifest))
                .chain(prepared.viewer_artifacts.iter())
                .map(|artifact| PreparedDatasetArtifact {
                    relative_path: PathBuf::from(&artifact.relative_path),
                    resource: GeometryResource {
                        object_hash: artifact.object_hash.clone(),
                        media_type: artifact.media_type.clone(),
                        byte_length: Some(artifact.byte_length),
                    },
                })
                .collect(),
        };
        let recipe_parameters = serde_json::json!({
            "rasterize": parameters,
            "scope": scope,
            "cellRecord": "valid:u8,value:f64le,count:u64le,variance:f64le",
        });
        let source_fingerprint = ObjectHash::of_bytes(&serde_json::to_vec(&serde_json::json!({
            "entityId": source.entity.id,
            "revision": source.entity.revision,
            "contentHash": source.entity.version_hash,
            "parameters": recipe_parameters,
        }))?);
        let recipe_id = format!(
            "height-grid-recipe-{}",
            &prepared.summary.cell_sha256.as_str()[..24]
        );
        let output_role = if prepared.summary.mesh_eligible {
            "grid_source"
        } else {
            "count_grid"
        };
        let recipe = derived_recipe_value(
            &recipe_id,
            RASTERIZE_ALGORITHM_ID,
            &entity_id,
            "grid",
            output_role,
            entity_type,
            &geometry_hash,
            &source,
            "point_cloud_source",
            recipe_parameters,
            source_fingerprint,
            completed_at,
        );
        let mesh_roles = if prepared.summary.mesh_eligible {
            let mut value = mesh_source_roles(
                &entity_id,
                &geometry_hash,
                "grid_source",
                himmelcad_core::entity_model::Transform3d::IDENTITY,
                Some(prepared.summary.cell_sha256.clone()),
            )?;
            value.content_hash = ObjectHash::of_bytes(&serde_json::to_vec(&value)?);
            Some(value)
        } else {
            None
        };
        let mut component_value = serde_json::json!({
            "hcad.prepared-dataset@1": {
                "formatId": HEIGHT_GRID_FORMAT_ID,
                "datasetId": dataset_id,
            }
        });
        if let Some(mesh_roles) = mesh_roles {
            component_value
                .as_object_mut()
                .expect("component object")
                .insert(
                    "hcad.mesh-source-roles@1".to_owned(),
                    serde_json::to_value(mesh_roles)?,
                );
        }
        let components =
            canonical_json("application/vnd.himmelcad.components+json", component_value)?;
        let attributes = canonical_json(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.pointcloud.height-grid@1": {
                    "algorithmId": RASTERIZE_ALGORITHM_ID,
                    "summary": prepared.summary,
                    "outputRole": output_role,
                },
                "hcad.derived-recipe@1": recipe,
            }),
        )?;
        let relations = canonical_json(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([{
                "kind": "derivedFrom",
                "entityId": source.entity.id,
                "revision": source.entity.revision,
                "role": "point_cloud_source",
            }]),
        )?;
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(entity_type.to_owned()),
            name: output_name,
            owner: source.entity.owner.clone(),
            layer_ids: source.entity.layer_ids.clone(),
            // Rasterization is in project XY/Z after applying the captured source placement.
            placement: None,
            representations: vec![representation.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized height grid"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).map_err(|error| {
            PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
        })?;
        let package = CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: RASTERIZE_ALGORITHM_ID.to_owned(),
            provider_version: "1".to_owned(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity: entity.clone(),
                selected: representation,
                representation_slot: "source".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects: vec![components, attributes, relations],
            datasets: vec![dataset],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        };
        let roots = [(dataset_id.clone(), prepared.root.clone())]
            .into_iter()
            .collect();
        let transaction = CanonicalCommandTransaction {
            command_id,
            mutations: vec![CanonicalEntityMutation::Create {
                entity: entity.clone(),
            }],
        };
        let journal_entry = self
            .document
            .pointcloud_publish_package(package, roots, transaction, progress, is_cancelled)
            .map_err(PointCloudCommandError::Backend)?;
        Ok(CanonicalRasterizeCommit {
            journal_entry,
            entity_id: entity.id.0,
            revision: entity.revision,
            dataset_id,
            entity_type: entity_type.to_owned(),
            mesh_source_role: prepared
                .summary
                .mesh_eligible
                .then(|| "grid_source".to_owned()),
        })
    }

    fn ensure_pointcloud_source_current(
        &self,
        expected: &EntityVersionRef,
    ) -> Result<(), PointCloudCommandError<D::Error>> {
        let current = self
            .document
            .pointcloud_residency_entries()
            .map_err(PointCloudCommandError::Backend)?
            .into_iter()
            .find(|entry| entry.admission.entity.id == expected.id)
            .map(|entry| EntityVersionRef::from_entity(&entry.admission.entity));
        if current.as_ref() != Some(expected) {
            return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                "source point-cloud revision changed before derived publication".to_owned(),
            ));
        }
        Ok(())
    }

    /// Persists one canonical display resource and assigns it to exact live clouds.
    pub fn set_point_cloud_display(
        &mut self,
        command_id: String,
        entities: Vec<EntityVersionRef>,
        display: PointCloudDisplayStyle,
    ) -> Result<CanonicalJournalEntry, PointCloudCommandError<D::Error>> {
        display.validate().map_err(|error| {
            PointCloudCommandError::<D::Error>::InvalidResidency(error.to_string())
        })?;
        if entities.is_empty() {
            return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                "point-cloud display edit requires at least one entity".to_owned(),
            ));
        }
        let value = serde_json::to_value(&display)?;
        let bytes = serde_json::to_vec(&value)?;
        let style_ref = ObjectHash::of_bytes(&bytes);
        let object = CanonicalJsonObject {
            object_hash: style_ref.clone(),
            media_type: "application/vnd.himmelcad.point-cloud-display+json".to_owned(),
            value,
        };
        for expected in &entities {
            let entity = self
                .document
                .pointcloud_entity(&expected.id)
                .map_err(PointCloudCommandError::Backend)?
                .ok_or_else(|| {
                    PointCloudCommandError::<D::Error>::InvalidResidency(format!(
                        "point-cloud entity {:?} is no longer live",
                        expected.id.0
                    ))
                })?;
            if entity.type_id.0 != built_in_type::POINT_CLOUD {
                return Err(PointCloudCommandError::<D::Error>::InvalidResidency(
                    format!("entity {:?} is not a point cloud", expected.id.0),
                ));
            }
        }
        self.document
            .pointcloud_put_json_object(object)
            .map_err(PointCloudCommandError::Backend)?;
        self.document
            .pointcloud_append_transaction(CanonicalCommandTransaction {
                command_id,
                mutations: entities
                    .into_iter()
                    .map(|expected| CanonicalEntityMutation::Update {
                        expected,
                        edits: vec![CanonicalEntityEdit::SetStyleRef {
                            style_ref: Some(style_ref.clone()),
                        }],
                    })
                    .collect(),
            })
            .map_err(PointCloudCommandError::Backend)
    }
}
