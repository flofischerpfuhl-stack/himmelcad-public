//! Registration command services independent of the sidecar host.

use himmelcad_document::domain_commands::RegistrationDocumentCommands;
use himmelcad_model::entity_model::GeometryObject;

use crate::import_registration_runtime::{
    sample_potree_open_files, ImportRegistrationRuntimeError, PotreeOpenFiles,
    RegistrationSourceSamples,
};

#[derive(Debug)]
pub enum RegistrationCommandError<E> {
    Backend(E),
    InvalidSamples(String),
    Sampling(ImportRegistrationRuntimeError),
}

/// Returns a deterministic bounded sample of one live committed Potree point cloud.
pub fn registration_point_cloud_samples<D>(
    document: &D,
    dataset_id: &str,
    maximum_samples: usize,
) -> Result<RegistrationSourceSamples, RegistrationCommandError<D::Error>>
where
    D: RegistrationDocumentCommands,
{
    let entry = document
        .registration_residency_entries()
        .map_err(RegistrationCommandError::Backend)?
        .into_iter()
        .find(|entry| {
            entry
                .dataset
                .as_ref()
                .is_some_and(|dataset| dataset.dataset_id == dataset_id)
        })
        .ok_or_else(|| {
            RegistrationCommandError::InvalidSamples(format!("unknown live dataset {dataset_id:?}"))
        })?;
    let dataset = entry
        .dataset
        .ok_or_else(|| RegistrationCommandError::InvalidSamples("dataset is missing".to_owned()))?;
    if dataset.format_id != "potree@2"
        || !matches!(
            entry.admission.resolved_geometry,
            GeometryObject::PointCloud { .. }
        )
    {
        return Err(RegistrationCommandError::InvalidSamples(
            "dataset is not a Potree point cloud".to_owned(),
        ));
    }
    let metadata_hash = dataset.root_metadata.object_hash.clone();
    let hierarchy_hash = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("hierarchy.bin"))
        .map(|artifact| artifact.resource.object_hash.clone())
        .ok_or_else(|| {
            RegistrationCommandError::InvalidSamples(
                "Potree hierarchy artifact is missing".to_owned(),
            )
        })?;
    let octree_hash = dataset
        .artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("octree.bin"))
        .map(|artifact| artifact.resource.object_hash.clone())
        .ok_or_else(|| {
            RegistrationCommandError::InvalidSamples("Potree octree artifact is missing".to_owned())
        })?;
    let mut metadata_file = document
        .registration_verified_object_source(&metadata_hash)
        .map_err(RegistrationCommandError::Backend)?;
    let mut hierarchy_file = document
        .registration_verified_object_source(&hierarchy_hash)
        .map_err(RegistrationCommandError::Backend)?;
    let mut octree_file = document
        .registration_verified_object_source(&octree_hash)
        .map_err(RegistrationCommandError::Backend)?;
    sample_potree_open_files(
        "project-point-cloud",
        dataset_id,
        [metadata_hash.0, hierarchy_hash.0, octree_hash.0],
        entry.admission.entity.placement,
        maximum_samples,
        PotreeOpenFiles {
            metadata: &mut metadata_file,
            hierarchy: &mut hierarchy_file,
            octree: &mut octree_file,
        },
    )
    .map_err(RegistrationCommandError::Sampling)
}
