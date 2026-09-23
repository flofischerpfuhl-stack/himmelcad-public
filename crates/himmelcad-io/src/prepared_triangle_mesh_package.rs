use std::fs;
use std::path::{Path, PathBuf};

use himmelcad_model::entity::EntityId;
use himmelcad_model::entity_model::GeometryResource;
use himmelcad_model::geometry_representation_registry::SectionTopologyPartitionManifest;
use himmelcad_model::hash::ObjectHash;
use himmelcad_model::typed_artifact::{TypedArtifactManifest, TYPED_ARTIFACT_MANIFEST_NAME};
use himmelcad_prepared::mesh_tiler::PreparedMeshProduct;
use himmelcad_prepared::prepared_triangle_mesh::PreparedTriangleMeshError;

use crate::{CanonicalPreparedDataset, PreparedDatasetArtifact};

/// Seals a prepared triangle hierarchy into the provider-neutral V-02 dataset
/// contract. The returned inventory is validated against every staged byte.
pub fn package_prepared_triangle_mesh(
    dataset_root: &Path,
    prepared: &PreparedMeshProduct,
    entity_id: &EntityId,
) -> Result<CanonicalPreparedDataset, PreparedTriangleMeshError> {
    let render_path = prepared
        .kernel_manifest_relative_path
        .as_ref()
        .ok_or_else(|| {
            PreparedTriangleMeshError::InvalidSource("prepared mesh has no kernel manifest".into())
        })?;
    let render = prepared.kernel_manifest_resource.as_ref().ok_or_else(|| {
        PreparedTriangleMeshError::InvalidSource("prepared mesh has no kernel resource".into())
    })?;
    let descriptor_path = prepared
        .preparation_descriptor_relative_path
        .as_ref()
        .ok_or_else(|| {
            PreparedTriangleMeshError::InvalidSource(
                "prepared mesh has no preparation descriptor".into(),
            )
        })?;
    let descriptor = prepared
        .preparation_descriptor_resource
        .as_ref()
        .ok_or_else(|| {
            PreparedTriangleMeshError::InvalidSource(
                "prepared mesh has no preparation resource".into(),
            )
        })?;
    let topology = prepared.section_topology.as_ref().ok_or_else(|| {
        PreparedTriangleMeshError::InvalidSource("prepared mesh has no section topology".into())
    })?;
    let topology_parent = topology
        .manifest_relative_path
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut artifacts = vec![
        verified_artifact(dataset_root, render_path, render)?,
        verified_artifact(dataset_root, descriptor_path, descriptor)?,
        verified_artifact(
            dataset_root,
            &topology.manifest_relative_path,
            &topology.manifest_resource,
        )?,
    ];
    let mut layouts = Vec::new();
    for part in &topology.parts {
        let manifest_relative = topology_parent.join(safe_relative_url(&part.manifest_url)?);
        let bytes = fs::read(dataset_root.join(&manifest_relative))?;
        let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(&bytes)?;
        if manifest
            .content_hash()
            .map_err(PreparedTriangleMeshError::Json)?
            .as_str()
            != part.topology_hash
        {
            return Err(PreparedTriangleMeshError::InvalidSource(format!(
                "section topology hash mismatch for {}",
                part.part_id
            )));
        }
        let manifest_resource = GeometryResource {
            object_hash: ObjectHash::of_bytes(&bytes),
            media_type: "hcad.section-topology-partition@1".to_owned(),
            byte_length: Some(bytes.len() as u64),
        };
        artifacts.push(verified_artifact(
            dataset_root,
            &manifest_relative,
            &manifest_resource,
        )?);
        artifacts.push(verified_artifact(
            dataset_root,
            &topology_parent.join(safe_relative_url(&part.position_url)?),
            &manifest.positions,
        )?);
        artifacts.push(verified_artifact(
            dataset_root,
            &topology_parent.join(safe_relative_url(&part.index_url)?),
            &manifest.indices,
        )?);
        if let (Some(url), Some(resource)) = (&part.material_slot_url, &manifest.material_slots) {
            artifacts.push(verified_artifact(
                dataset_root,
                &topology_parent.join(safe_relative_url(url)?),
                resource,
            )?);
        } else if part.material_slot_url.is_some() != manifest.material_slots.is_some() {
            return Err(PreparedTriangleMeshError::InvalidSource(
                "section topology material inventory mismatch".into(),
            ));
        }
        layouts.extend(
            manifest
                .typed_artifact_descriptors()
                .map_err(|error| PreparedTriangleMeshError::InvalidSource(error.to_string()))?,
        );
    }
    let typed = TypedArtifactManifest {
        schema_version: TypedArtifactManifest::SCHEMA_VERSION,
        artifacts: layouts,
    };
    typed
        .validate()
        .map_err(|error| PreparedTriangleMeshError::InvalidSource(error.to_string()))?;
    let typed_relative = topology_parent.join(TYPED_ARTIFACT_MANIFEST_NAME);
    let (typed_artifact, typed_bytes) =
        PreparedDatasetArtifact::typed_artifact_manifest(typed_relative.clone(), &typed)
            .map_err(|error| PreparedTriangleMeshError::InvalidSource(error.to_string()))?;
    fs::write(dataset_root.join(&typed_relative), typed_bytes)?;
    artifacts.push(typed_artifact);
    artifacts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    artifacts.dedup_by(|left, right| left.relative_path == right.relative_path);
    let dataset = CanonicalPreparedDataset {
        dataset_id: format!("surface-tin-{}", render.object_hash.as_str()),
        format_id: render.media_type.clone(),
        entity_id: entity_id.0.clone(),
        representation_slot: "source".to_owned(),
        root_metadata: render.clone(),
        artifacts,
    };
    dataset
        .validate_typed_artifact_layouts(&typed)
        .map_err(|error| PreparedTriangleMeshError::InvalidSource(error.to_string()))?;
    Ok(dataset)
}

fn safe_relative_url(value: &str) -> Result<PathBuf, PreparedTriangleMeshError> {
    let path = PathBuf::from(value);
    if value.trim().is_empty()
        || value.contains('\\')
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(PreparedTriangleMeshError::InvalidSource(
            "prepared mesh artifact path escaped its dataset".into(),
        ));
    }
    Ok(path)
}

fn verified_artifact(
    root: &Path,
    relative_path: &Path,
    expected: &GeometryResource,
) -> Result<PreparedDatasetArtifact, PreparedTriangleMeshError> {
    safe_relative_url(relative_path.to_str().unwrap_or_default())?;
    let bytes = fs::read(root.join(relative_path))?;
    if ObjectHash::of_bytes(&bytes) != expected.object_hash
        || expected.byte_length != Some(bytes.len() as u64)
    {
        return Err(PreparedTriangleMeshError::InvalidSource(format!(
            "prepared mesh artifact does not match {}",
            relative_path.display()
        )));
    }
    Ok(PreparedDatasetArtifact {
        relative_path: relative_path.to_owned(),
        resource: expected.clone(),
    })
}
