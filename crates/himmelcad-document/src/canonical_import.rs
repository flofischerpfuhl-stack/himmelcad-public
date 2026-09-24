//! Provider-neutral canonical import package contracts.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use himmelcad_model::canonical_resource_catalog::{
    CanonicalPresentationResourceCatalog, CanonicalPresentationResourceSet,
};
use himmelcad_model::entity_model::{
    DepthSampling, ElevationSurfaceGeometry, GeometryObject, GeometryResource, RasterConnectivity,
    RasterImageGeometry, SolidGeometry, TriangleMeshGeometry, TriangleMeshStorage,
};
use himmelcad_model::entity_validation::validate_resolved_representation;
use himmelcad_model::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_model::hash::ObjectHash;
use himmelcad_model::typed_artifact::{
    TypedArtifactManifest, TYPED_ARTIFACT_MANIFEST_MEDIA_TYPE, TYPED_ARTIFACT_MANIFEST_NAME,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_document::{CanonicalCommandTransaction, CanonicalEntityMutation};

/// Current serialized provider/package contract version.
pub const CANONICAL_IO_SCHEMA_VERSION: u32 = 1;

/// Immutable small JSON object referenced from canonical entity envelopes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalJsonObject {
    /// SHA-256 of the compact JSON bytes.
    pub object_hash: ObjectHash,
    /// Semantic JSON media type.
    pub media_type: String,
    /// Exact JSON value whose compact encoding is hashed.
    pub value: serde_json::Value,
}

impl CanonicalJsonObject {
    /// Creates a hash-bound JSON object.
    pub fn new(
        media_type: impl Into<String>,
        value: serde_json::Value,
    ) -> Result<Self, ProviderContractError> {
        let media_type = media_type.into();
        if media_type.trim().is_empty() {
            return Err(ProviderContractError::InvalidObject);
        }
        let bytes = serde_json::to_vec(&value).map_err(|_| ProviderContractError::InvalidObject)?;
        Ok(Self {
            object_hash: ObjectHash::of_bytes(&bytes),
            media_type,
            value,
        })
    }

    fn validate(&self) -> Result<(), ProviderContractError> {
        let expected = serde_json::to_vec(&self.value)
            .map(|bytes| ObjectHash::of_bytes(&bytes))
            .map_err(|_| ProviderContractError::InvalidObject)?;
        if self.media_type.trim().is_empty() || expected != self.object_hash {
            return Err(ProviderContractError::InvalidObject);
        }
        Ok(())
    }
}

/// One immutable prepared-dataset artifact kept outside the in-memory package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedDatasetArtifact {
    /// Safe relative path below the prepared dataset root.
    pub relative_path: PathBuf,
    /// Immutable artifact identity and exact length.
    pub resource: GeometryResource,
}

impl PreparedDatasetArtifact {
    /// Builds the fixed, content-addressed typed-layout artifact for one prepared dataset.
    pub fn typed_artifact_manifest(
        relative_path: PathBuf,
        manifest: &TypedArtifactManifest,
    ) -> Result<(Self, Vec<u8>), ProviderContractError> {
        manifest
            .validate()
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
        if relative_path.file_name().and_then(|name| name.to_str())
            != Some(TYPED_ARTIFACT_MANIFEST_NAME)
            || !safe_relative_path(&relative_path)
        {
            return Err(ProviderContractError::InvalidDatasetArtifact);
        }
        let bytes = serde_json::to_vec(manifest)
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
        let byte_length = u64::try_from(bytes.len())
            .map_err(|_| ProviderContractError::InvalidDatasetArtifact)?;
        Ok((
            Self {
                relative_path,
                resource: GeometryResource {
                    object_hash: ObjectHash::of_bytes(&bytes),
                    media_type: TYPED_ARTIFACT_MANIFEST_MEDIA_TYPE.to_owned(),
                    byte_length: Some(byte_length),
                },
            },
            bytes,
        ))
    }
}

/// Exact binding between a prepared dataset and one canonical representation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPreparedDataset {
    /// Stable project-local dataset identity.
    pub dataset_id: String,
    /// Provider-neutral exact format ID.
    pub format_id: String,
    /// Canonical entity owning the dataset.
    pub entity_id: String,
    /// Representation slot bound to the dataset.
    pub representation_slot: String,
    /// Root metadata resource referenced by canonical geometry.
    pub root_metadata: GeometryResource,
    /// Complete immutable artifact inventory.
    pub artifacts: Vec<PreparedDatasetArtifact>,
}

impl CanonicalPreparedDataset {
    /// Returns the unique provider-neutral typed-layout manifest artifact, when published.
    pub fn typed_artifact_manifest(&self) -> Option<&PreparedDatasetArtifact> {
        self.artifacts.iter().find(|artifact| {
            artifact
                .relative_path
                .file_name()
                .and_then(|name| name.to_str())
                == Some(TYPED_ARTIFACT_MANIFEST_NAME)
                && artifact.resource.media_type == TYPED_ARTIFACT_MANIFEST_MEDIA_TYPE
        })
    }

    /// Validates parsed typed layouts against this dataset's exact immutable inventory.
    pub fn validate_typed_artifact_layouts(
        &self,
        manifest: &TypedArtifactManifest,
    ) -> Result<(), ProviderContractError> {
        manifest
            .validate()
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
        if self.typed_artifact_manifest().is_none()
            || manifest.artifacts.iter().any(|descriptor| {
                !self
                    .artifacts
                    .iter()
                    .any(|artifact| artifact.resource == descriptor.resource)
            })
        {
            return Err(ProviderContractError::InvalidDatasetArtifact);
        }
        Ok(())
    }
}

/// One immutable non-streamed binary resource staged from a provider-owned root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedResourceArtifact {
    /// Safe relative path below the resource-set source root.
    pub relative_path: PathBuf,
    /// Exact immutable hash, byte length and semantic media type.
    pub resource: GeometryResource,
}

/// Provider-neutral group of non-streamed immutable geometry resources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalResourceSet {
    /// Stable project-local identity unique across the import package and project.
    pub resource_set_id: String,
    /// Complete immutable binary payload inventory below one host-supplied source root.
    pub resources: Vec<PreparedResourceArtifact>,
}

/// Atomic provider output staged before a project command publishes anything.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalImportPackage {
    /// Contract schema version.
    pub schema_version: u32,
    /// Provider that created this package.
    pub provider_id: String,
    /// Exact provider implementation version.
    pub provider_version: String,
    /// Complete canonical representation admissions.
    pub admissions: Vec<CanonicalRepresentationAdmission>,
    /// Small immutable objects referenced by admitted entity envelopes.
    pub objects: Vec<CanonicalJsonObject>,
    /// Large prepared dataset bindings and artifact inventories.
    pub datasets: Vec<CanonicalPreparedDataset>,
    /// Non-streamed binary resources such as pixels, depth bands, textures and fonts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_sets: Vec<CanonicalResourceSet>,
    /// Exact immutable presentation resources published atomically with the geometry.
    #[serde(default, skip_serializing_if = "presentation_resources_are_empty")]
    pub presentation_resources: CanonicalPresentationResourceSet,
}

impl CanonicalImportPackage {
    /// Validates every object and cross-reference before project publication.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        if self.schema_version != CANONICAL_IO_SCHEMA_VERSION
            || !valid_namespaced_id(&self.provider_id)
            || self.provider_version.trim().is_empty()
            || self.admissions.is_empty()
        {
            return Err(ProviderContractError::InvalidPackage);
        }
        let mut presentation_catalog = CanonicalPresentationResourceCatalog::default();
        presentation_catalog
            .publish(self.presentation_resources.clone())
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;

        let mut entity_slots = BTreeMap::new();
        let mut entities = BTreeMap::new();
        for admission in &self.admissions {
            validate_resolved_representation(
                &admission.entity,
                &admission.selected,
                &admission.resolved_geometry,
            )
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
            validate_geometry_presentation_resources(
                &admission.resolved_geometry,
                &presentation_catalog,
            )?;
            let key = (
                admission.entity.id.0.clone(),
                admission.representation_slot.clone(),
            );
            if admission.representation_slot.trim().is_empty()
                || entity_slots.insert(key, admission).is_some()
            {
                return Err(ProviderContractError::InvalidPackage);
            }
            if entities
                .insert(admission.entity.id.0.clone(), &admission.entity)
                .is_some_and(|existing| existing != &admission.entity)
            {
                return Err(ProviderContractError::DivergentEntityAdmission);
            }
        }

        let mut object_hashes = BTreeSet::new();
        for object in &self.objects {
            object.validate()?;
            if !object_hashes.insert(object.object_hash.0.clone()) {
                return Err(ProviderContractError::InvalidObject);
            }
        }
        for admission in &self.admissions {
            for required in [
                &admission.entity.components_ref,
                &admission.entity.attributes_ref,
                &admission.entity.relations_ref,
            ] {
                if !object_hashes.contains(required.as_str()) {
                    return Err(ProviderContractError::MissingEntityObject);
                }
            }
        }

        let mut dataset_ids = BTreeSet::new();
        let mut dataset_slots = BTreeSet::new();
        let mut dataset_resources = BTreeMap::new();
        for dataset in &self.datasets {
            if dataset.dataset_id.trim().is_empty()
                || !valid_namespaced_id(&dataset.format_id)
                || dataset.representation_slot.trim().is_empty()
                || !dataset_ids.insert(dataset.dataset_id.clone())
                || !dataset_slots.insert((
                    dataset.entity_id.clone(),
                    dataset.representation_slot.clone(),
                ))
                || !valid_resource(&dataset.root_metadata)
            {
                return Err(ProviderContractError::InvalidDataset);
            }
            let admission = entity_slots
                .get(&(
                    dataset.entity_id.clone(),
                    dataset.representation_slot.clone(),
                ))
                .ok_or(ProviderContractError::MissingDatasetAdmission)?;
            let (format_id, metadata) = geometry_dataset_contract(&admission.resolved_geometry)
                .ok_or(ProviderContractError::InvalidDatasetGeometry)?;
            if format_id != dataset.format_id || metadata != &dataset.root_metadata {
                return Err(ProviderContractError::DatasetBindingMismatch);
            }
            let mut paths = BTreeSet::new();
            let mut typed_manifest_count = 0_u8;
            for artifact in &dataset.artifacts {
                if !safe_relative_path(&artifact.relative_path)
                    || !valid_resource(&artifact.resource)
                    || !paths.insert(artifact.relative_path.clone())
                    || !insert_exact_resource(&mut dataset_resources, &artifact.resource)
                {
                    return Err(ProviderContractError::InvalidDatasetArtifact);
                }
                if artifact
                    .relative_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    == Some(TYPED_ARTIFACT_MANIFEST_NAME)
                {
                    typed_manifest_count = typed_manifest_count.saturating_add(1);
                    if artifact.resource.media_type != TYPED_ARTIFACT_MANIFEST_MEDIA_TYPE {
                        return Err(ProviderContractError::InvalidDatasetArtifact);
                    }
                }
            }
            if typed_manifest_count > 1 {
                return Err(ProviderContractError::InvalidDatasetArtifact);
            }
            if !dataset
                .artifacts
                .iter()
                .any(|artifact| artifact.resource == dataset.root_metadata)
            {
                return Err(ProviderContractError::MissingRootMetadataArtifact);
            }
        }

        let mut resource_set_ids = BTreeSet::new();
        let mut resource_set_resources = BTreeMap::new();
        for resource_set in &self.resource_sets {
            if !valid_local_id(&resource_set.resource_set_id)
                || resource_set.resources.is_empty()
                || !resource_set_ids.insert(resource_set.resource_set_id.clone())
            {
                return Err(ProviderContractError::InvalidResourceSet);
            }
            let mut paths = BTreeSet::new();
            for artifact in &resource_set.resources {
                if !safe_relative_path(&artifact.relative_path)
                    || !valid_resource(&artifact.resource)
                    || !paths.insert(artifact.relative_path.clone())
                    || !insert_exact_resource(&mut resource_set_resources, &artifact.resource)
                {
                    return Err(ProviderContractError::InvalidResourceSet);
                }
            }
        }

        let mut required_resources = BTreeMap::new();
        let mut streamed_metadata = BTreeMap::new();
        for admission in &self.admissions {
            collect_geometry_resources(
                &admission.resolved_geometry,
                &mut required_resources,
                &mut streamed_metadata,
            )?;
            if let GeometryObject::Extension { payload, .. } = &admission.resolved_geometry {
                if let Some(resource) = resource_set_resources.get(payload.as_str()) {
                    collect_required_resource(resource, &mut required_resources)?;
                }
            }
        }
        collect_presentation_binary_resources(
            &self.presentation_resources,
            &mut required_resources,
        )?;
        for resource in streamed_metadata.values() {
            if !resource_is_exactly_declared(&dataset_resources, resource) {
                return Err(ProviderContractError::MissingGeometryResource);
            }
        }
        for resource in required_resources.values() {
            if !resource_is_exactly_declared(&dataset_resources, resource)
                && !resource_is_exactly_declared(&resource_set_resources, resource)
            {
                return Err(ProviderContractError::MissingGeometryResource);
            }
        }
        if resource_set_resources
            .values()
            .any(|resource| !resource_is_exactly_declared(&required_resources, resource))
        {
            return Err(ProviderContractError::UnreferencedGeometryResource);
        }
        Ok(())
    }

    /// Builds the entity-creation half of one atomic project import command.
    pub fn entity_create_transaction(
        &self,
        command_id: impl Into<String>,
    ) -> Result<CanonicalCommandTransaction, ProviderContractError> {
        self.validate()?;
        let mut entities = BTreeMap::new();
        for admission in &self.admissions {
            entities
                .entry(admission.entity.id.0.clone())
                .or_insert_with(|| admission.entity.clone());
        }
        Ok(CanonicalCommandTransaction {
            command_id: command_id.into(),
            mutations: entities
                .into_values()
                .map(|entity| CanonicalEntityMutation::Create { entity })
                .collect(),
        })
    }
}

fn presentation_resources_are_empty(resources: &CanonicalPresentationResourceSet) -> bool {
    resources.textures.is_empty()
        && resources.materials.is_empty()
        && resources.material_tables.is_empty()
        && resources.hatch_patterns.is_empty()
        && resources.line_types.is_empty()
        && resources.annotation_styles.is_empty()
}

fn validate_geometry_presentation_resources(
    geometry: &GeometryObject,
    catalog: &CanonicalPresentationResourceCatalog,
) -> Result<(), ProviderContractError> {
    let mesh = match geometry {
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, .. } => Some(mesh),
            _ => None,
        },
        GeometryObject::Surface3d { mesh } => Some(mesh.as_ref()),
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => Some(mesh),
            _ => None,
        },
        _ => None,
    };
    if let Some(reference) = mesh.and_then(|mesh| mesh.materials.as_ref()) {
        if catalog.material_table(reference).is_none() {
            return Err(ProviderContractError::MissingPresentationResource);
        }
    }
    Ok(())
}

fn collect_presentation_binary_resources(
    resources: &CanonicalPresentationResourceSet,
    required: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    for texture in &resources.textures {
        collect_required_resource(&texture.pixels, required)?;
    }
    for annotation in &resources.annotation_styles {
        collect_required_resource(&annotation.font, required)?;
    }
    Ok(())
}

fn geometry_dataset_contract(geometry: &GeometryObject) -> Option<(&str, &GeometryResource)> {
    match geometry {
        GeometryObject::PointCloud { dataset } | GeometryObject::GaussianSplatCloud { dataset } => {
            Some((&dataset.format_id, &dataset.metadata))
        }
        GeometryObject::RasterImage { raster } => Some((&raster.pixels.media_type, &raster.pixels)),
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Grid { raster, .. } => Some((&raster.media_type, raster)),
            ElevationSurfaceGeometry::Tin { mesh, .. } => mesh_dataset_contract(mesh),
        },
        GeometryObject::Surface3d { mesh } => mesh_dataset_contract(mesh),
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => mesh_dataset_contract(mesh),
            SolidGeometry::Brep { resource } => Some((&resource.media_type, resource)),
            _ => None,
        },
        _ => None,
    }
}

fn mesh_dataset_contract(mesh: &TriangleMeshGeometry) -> Option<(&str, &GeometryResource)> {
    match &mesh.storage {
        TriangleMeshStorage::Resource { resource } => Some((&resource.media_type, resource)),
        TriangleMeshStorage::Inline { .. } => None,
    }
}

fn valid_resource(resource: &GeometryResource) -> bool {
    let hash = resource.object_hash.as_str();
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && !resource.media_type.trim().is_empty()
        && resource.byte_length.is_some_and(|length| length > 0)
}

fn valid_local_id(value: &str) -> bool {
    !value.trim().is_empty()
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_whitespace())
}

fn insert_exact_resource(
    resources: &mut BTreeMap<String, GeometryResource>,
    resource: &GeometryResource,
) -> bool {
    match resources.entry(resource.object_hash.0.clone()) {
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert(resource.clone());
            true
        }
        std::collections::btree_map::Entry::Occupied(entry) => entry.get() == resource,
    }
}

fn resource_is_exactly_declared(
    resources: &BTreeMap<String, GeometryResource>,
    resource: &GeometryResource,
) -> bool {
    resources
        .get(resource.object_hash.as_str())
        .is_some_and(|declared| declared == resource)
}

fn collect_geometry_resources(
    geometry: &GeometryObject,
    required: &mut BTreeMap<String, GeometryResource>,
    streamed: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    match geometry {
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, .. } => collect_mesh_resources(mesh, required)?,
            ElevationSurfaceGeometry::Grid {
                raster, sampling, ..
            } => {
                collect_required_resource(raster, required)?;
                collect_sampling_resources(sampling, required)?;
            }
        },
        GeometryObject::Surface3d { mesh } => collect_mesh_resources(mesh, required)?,
        GeometryObject::RasterImage { raster } => collect_raster_resources(raster, required)?,
        GeometryObject::PointCloud { dataset } | GeometryObject::GaussianSplatCloud { dataset } => {
            collect_exact_resource(&dataset.metadata, streamed)?;
        }
        GeometryObject::Panorama { panorama } => {
            collect_raster_resources(&panorama.image, required)?;
        }
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => collect_mesh_resources(mesh, required)?,
            SolidGeometry::Brep { resource } => collect_required_resource(resource, required)?,
            _ => {}
        },
        GeometryObject::Text { text } => collect_required_resource(&text.font, required)?,
        GeometryObject::Label { label } => collect_required_resource(&label.text.font, required)?,
        GeometryObject::Dimension { dimension } => {
            collect_required_resource(&dimension.style, required)?;
        }
        GeometryObject::Point { .. }
        | GeometryObject::Curve { .. }
        | GeometryObject::Area { .. }
        | GeometryObject::Plane { .. }
        | GeometryObject::Alignment { .. }
        | GeometryObject::Block { .. }
        | GeometryObject::Measurement { .. }
        | GeometryObject::Extension { .. } => {}
    }
    Ok(())
}

fn collect_mesh_resources(
    mesh: &TriangleMeshGeometry,
    required: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    if let TriangleMeshStorage::Resource { resource } = &mesh.storage {
        collect_required_resource(resource, required)?;
    }
    Ok(())
}

fn collect_raster_resources(
    raster: &RasterImageGeometry,
    required: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    collect_required_resource(&raster.pixels, required)?;
    if let Some(depth) = &raster.depth {
        collect_required_resource(&depth.values, required)?;
        if let Some(validity) = &depth.validity {
            collect_required_resource(&validity.resource, required)?;
        }
        if let Some(confidence) = &depth.confidence {
            collect_required_resource(&confidence.resource, required)?;
        }
        collect_sampling_resources(&depth.sampling, required)?;
    }
    Ok(())
}

fn collect_sampling_resources(
    sampling: &DepthSampling,
    required: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    if let RasterConnectivity::Mask { resource, .. } = &sampling.connectivity {
        collect_required_resource(resource, required)?;
    }
    Ok(())
}

fn collect_required_resource(
    resource: &GeometryResource,
    required: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    if !valid_resource(resource) || !insert_exact_resource(required, resource) {
        return Err(ProviderContractError::MissingGeometryResource);
    }
    Ok(())
}

fn collect_exact_resource(
    resource: &GeometryResource,
    resources: &mut BTreeMap<String, GeometryResource>,
) -> Result<(), ProviderContractError> {
    if !valid_resource(resource) || !insert_exact_resource(resources, resource) {
        return Err(ProviderContractError::MissingGeometryResource);
    }
    Ok(())
}

fn safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            let Component::Normal(value) = component else {
                return false;
            };
            let value = value.to_string_lossy();
            !value.contains(['\0', '\\', '/']) && value != "." && value != ".."
        })
}

fn valid_namespaced_id(value: &str) -> bool {
    !value.trim().is_empty()
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_whitespace())
        && value.contains('@')
}

/// Rejection from the common provider or canonical package boundary.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProviderContractError {
    /// Provider descriptor is malformed or unsupported.
    #[error("invalid format provider descriptor")]
    InvalidDescriptor,
    /// Provider option schema/default metadata is malformed.
    #[error("invalid provider option contract")]
    InvalidOptionContract,
    /// Provider ID is already registered or lacks the requested capability.
    #[error("duplicate or capability-incompatible format provider")]
    DuplicateProvider,
    /// No provider positively identified the source or destination format.
    #[error("unsupported format")]
    UnsupportedFormat,
    /// Two providers returned the same winning confidence.
    #[error("ambiguous format provider selection")]
    AmbiguousFormat,
    /// Provider returned a confidence or format outside its descriptor.
    #[error("invalid provider probe result")]
    InvalidProbe,
    /// Provider/version changed between probe and execution.
    #[error("selected format provider changed before execution")]
    ProviderChanged,
    /// Operation was cancelled before publication.
    #[error("provider operation was cancelled")]
    Cancelled,
    /// A PhotoLab product package was refused with one closed IF-D28 reason code.
    #[error("product import refused ({reason_code}): {message}")]
    ProductImportRefused {
        reason_code: &'static str,
        message: String,
    },
    /// Provider did not return one exact local root per staged artifact inventory.
    #[error("invalid or incomplete provider artifact roots")]
    InvalidArtifactRoots,
    /// Export plan is malformed, lossy without exact codes, or outside the provider descriptor.
    #[error("invalid canonical export plan")]
    InvalidExportPlan,
    /// Provider planning no longer matches the plan accepted by the caller.
    #[error("canonical export plan changed before execution")]
    ExportPlanChanged,
    /// Canonical geometry/entity validation rejected provider output.
    #[error("canonical provider output: {0}")]
    Canonical(String),
    /// Package identity or cardinality is malformed.
    #[error("invalid canonical import package")]
    InvalidPackage,
    /// Small immutable object hash or media type is invalid.
    #[error("invalid canonical JSON object")]
    InvalidObject,
    /// Entity component/attribute/relation object is absent.
    #[error("canonical entity references an object missing from the package")]
    MissingEntityObject,
    /// Two slots claim different envelopes for the same stable entity identity.
    #[error("canonical representation slots disagree on their entity envelope")]
    DivergentEntityAdmission,
    /// Prepared dataset identity or root resource is malformed.
    #[error("invalid prepared dataset")]
    InvalidDataset,
    /// Dataset binding has no matching canonical entity/slot admission.
    #[error("prepared dataset has no matching canonical admission")]
    MissingDatasetAdmission,
    /// Geometry kind does not expose a prepared dataset contract.
    #[error("canonical geometry is not provider-backed")]
    InvalidDatasetGeometry,
    /// Dataset format or root metadata differs from canonical geometry.
    #[error("prepared dataset binding differs from canonical geometry")]
    DatasetBindingMismatch,
    /// Artifact path, resource, or identity is invalid.
    #[error("invalid prepared dataset artifact")]
    InvalidDatasetArtifact,
    /// Root metadata was not included in the immutable artifact inventory.
    #[error("prepared dataset artifact inventory omits root metadata")]
    MissingRootMetadataArtifact,
    /// A binary resource set has an invalid ID, path, descriptor or duplicate.
    #[error("invalid canonical binary resource set")]
    InvalidResourceSet,
    /// Admitted geometry references bytes absent from datasets and resource sets.
    #[error("canonical geometry resource is missing from the import package")]
    MissingGeometryResource,
    /// Geometry references an exact presentation revision absent from the package.
    #[error("canonical presentation resource is missing from the import package")]
    MissingPresentationResource,
    /// A resource-set payload is not referenced by any admitted geometry object.
    #[error("canonical binary resource set contains an unreferenced payload")]
    UnreferencedGeometryResource,
    /// Provider-specific execution failed without publishing a package.
    #[error("format provider failed: {0}")]
    Provider(String),
}
