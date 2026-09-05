//! Provider-neutral canonical import/export contracts.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use himmelcad_core::canonical_document::{CanonicalCommandTransaction, CanonicalEntityMutation};
use himmelcad_core::canonical_resource_catalog::{
    CanonicalPresentationResourceCatalog, CanonicalPresentationResourceSet,
};
use himmelcad_core::entity_model::{
    DepthSampling, ElevationSurfaceGeometry, GeometryObject, GeometryResource, RasterConnectivity,
    RasterImageGeometry, SolidGeometry, Transform3d, TriangleMeshGeometry, TriangleMeshStorage,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::registration::{
    compose_placement, similarity_transform3d, RegistrationPreview,
};
use himmelcad_core::typed_artifact::{
    TypedArtifactManifest, TYPED_ARTIFACT_MANIFEST_MEDIA_TYPE, TYPED_ARTIFACT_MANIFEST_NAME,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Current serialized provider/package contract version.
pub const CANONICAL_IO_SCHEMA_VERSION: u32 = 1;

/// Provider capability advertised before probing or execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FormatCapability {
    /// Reads an external format into a canonical package.
    Import,
    /// Writes canonical selections to an external format.
    Export,
}

/// Machine-readable provider options and the exact defaults applied to an empty object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOptionContract {
    /// JSON Schema describing the provider-owned options object.
    pub schema: serde_json::Value,
    /// Concrete immutable options used when the caller supplies `{}`.
    pub defaults: serde_json::Value,
}

impl ProviderOptionContract {
    /// Contract for a provider operation that accepts no options.
    #[must_use]
    pub fn none() -> Self {
        Self {
            schema: serde_json::json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            defaults: serde_json::json!({}),
        }
    }

    /// Builds a closed object schema from a JSON object of property schemas and defaults.
    #[must_use]
    pub fn object(properties: serde_json::Value, defaults: serde_json::Value) -> Self {
        Self {
            schema: serde_json::json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": properties,
                "additionalProperties": false
            }),
            defaults,
        }
    }

    fn validate(&self) -> Result<(), ProviderContractError> {
        let schema = self
            .schema
            .as_object()
            .ok_or(ProviderContractError::InvalidOptionContract)?;
        let properties = schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .ok_or(ProviderContractError::InvalidOptionContract)?;
        let defaults = self
            .defaults
            .as_object()
            .ok_or(ProviderContractError::InvalidOptionContract)?;
        if schema.get("type").and_then(serde_json::Value::as_str) != Some("object")
            || schema.get("$schema").and_then(serde_json::Value::as_str)
                != Some("https://json-schema.org/draft/2020-12/schema")
            || schema
                .get("additionalProperties")
                .and_then(serde_json::Value::as_bool)
                != Some(false)
            || defaults.keys().any(|key| !properties.contains_key(key))
        {
            return Err(ProviderContractError::InvalidOptionContract);
        }
        Ok(())
    }
}

/// Stable identity and format surface of one I/O provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormatProviderDescriptor {
    /// Contract schema version.
    pub schema_version: u32,
    /// Namespaced stable implementation ID.
    pub provider_id: String,
    /// Provider implementation version.
    pub provider_version: String,
    /// Human-readable format/provider name.
    pub display_name: String,
    /// Exact versioned format IDs this provider can produce or consume.
    pub format_ids: Vec<String>,
    /// Lower-case filename extensions without a leading dot.
    pub extensions: Vec<String>,
    /// Registered or namespaced media types.
    pub media_types: Vec<String>,
    /// Supported operation directions.
    pub capabilities: Vec<FormatCapability>,
    /// Import option schema and concrete defaults, when import is supported.
    pub import_options: Option<ProviderOptionContract>,
    /// Export option schema and concrete defaults, when export is supported.
    pub export_options: Option<ProviderOptionContract>,
}

impl FormatProviderDescriptor {
    /// Validates stable identity and deterministic matching fields.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        if self.schema_version != CANONICAL_IO_SCHEMA_VERSION
            || !valid_namespaced_id(&self.provider_id)
            || self.provider_version.trim().is_empty()
            || self.display_name.trim().is_empty()
            || self.format_ids.is_empty()
            || self.capabilities.is_empty()
            || self.capabilities.contains(&FormatCapability::Import)
                != self.import_options.is_some()
            || self.capabilities.contains(&FormatCapability::Export)
                != self.export_options.is_some()
            || !all_unique(self.format_ids.iter())
            || !all_unique(self.extensions.iter())
            || !all_unique(self.media_types.iter())
            || !all_unique(self.capabilities.iter())
            || self
                .format_ids
                .iter()
                .any(|value| !valid_namespaced_id(value))
            || self.extensions.iter().any(|value| {
                value.is_empty()
                    || value.starts_with('.')
                    || value.chars().any(|character| {
                        character.is_ascii_uppercase()
                            || !(character.is_ascii_alphanumeric()
                                || matches!(character, '-' | '_' | '+'))
                    })
            })
            || self
                .media_types
                .iter()
                .any(|value| value.trim().is_empty() || !value.contains('/'))
        {
            return Err(ProviderContractError::InvalidDescriptor);
        }
        if let Some(contract) = &self.import_options {
            contract.validate()?;
        }
        if let Some(contract) = &self.export_options {
            contract.validate()?;
        }
        Ok(())
    }
}

/// Bounded source information supplied to every import probe.
#[derive(Debug, Clone, Copy)]
pub struct ImportProbeRequest<'a> {
    /// Original source path; providers must not read the complete file in probe.
    pub path: &'a Path,
    /// Bounded file prefix read once by the host.
    pub prefix: &'a [u8],
    /// Optional trusted media type supplied by the host.
    pub media_type: Option<&'a str>,
}

/// One provider's positive format identification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProbe {
    /// Exact format selected from the provider descriptor.
    pub format_id: String,
    /// Confidence from 1 through 100; zero means no match and is not serialized.
    pub confidence: u8,
}

/// Deterministic registry decision returned before an expensive import starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProviderSelection {
    /// Selected provider.
    pub provider_id: String,
    /// Provider version observed during selection.
    pub provider_version: String,
    /// Selected exact source format.
    pub format_id: String,
    /// Winning confidence.
    pub confidence: u8,
}

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
            // An opaque extension payload may be the binary object itself
            // instead of a JSON descriptor. Exact hash identity makes that
            // resource reference unambiguous without teaching the common
            // contract format-specific payload fields.
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
    ///
    /// Immutable objects, dataset artifacts and resource-set payloads must already be staged and
    /// hash verified by the project store. Committing this transaction is the single publication
    /// point; multiple representation slots never create duplicate entity identities.
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

/// Applies one reviewed registration preview to every staged entity before publication.
///
/// The operation only changes canonical entity placements and their attribute provenance.
/// Prepared geometry bytes remain immutable and reusable. Point-pair observations are not
/// persisted; only the accepted transform and aggregate diagnostics enter the audit record.
pub fn apply_registration_preview(
    package: &mut CanonicalImportPackage,
    recipe_id: &str,
    method_kind: &str,
    preview: &RegistrationPreview,
) -> Result<(), ProviderContractError> {
    if recipe_id.trim().is_empty() || method_kind.trim().is_empty() || !preview.accepted {
        return Err(ProviderContractError::InvalidPackage);
    }
    package.validate()?;
    let registration = similarity_transform3d(preview.transform);
    let audit = serde_json::json!({
        "schemaId": "hcad.import-registration-audit@1",
        "recipeId": recipe_id,
        "method": method_kind,
        "transform": registration,
        "diagnostics": {
            "iterations": preview.iterations,
            "matchedSamples": preview.matched_samples,
            "overlapRatio": preview.overlap_ratio,
            "converged": preview.converged,
            "rmsHorizontalMeters": preview.residuals.rms_horizontal_meters,
            "rmsVerticalMeters": preview.residuals.rms_vertical_meters,
            "rmsSpatialMeters": preview.residuals.rms_spatial_meters,
            "maxSpatialMeters": preview.residuals.max_spatial_meters,
            "warnings": preview.warnings,
        }
    });

    let mut rewritten_attributes = BTreeMap::<String, ObjectHash>::new();
    for admission in &mut package.admissions {
        admission.entity.placement = Some(compose_placement(
            registration,
            admission.entity.placement.unwrap_or(Transform3d::IDENTITY),
        ));
        let old_attributes = admission.entity.attributes_ref.0.clone();
        let next_attributes = if let Some(existing) = rewritten_attributes.get(&old_attributes) {
            existing.clone()
        } else {
            let source = package
                .objects
                .iter()
                .find(|object| object.object_hash.as_str() == old_attributes)
                .ok_or(ProviderContractError::MissingEntityObject)?;
            let mut value = source.value.clone();
            let map = value
                .as_object_mut()
                .ok_or(ProviderContractError::InvalidObject)?;
            map.insert("hcad.import-registration@1".to_owned(), audit.clone());
            let object = CanonicalJsonObject::new(source.media_type.clone(), value)?;
            let object_hash = object.object_hash.clone();
            package.objects.push(object);
            rewritten_attributes.insert(old_attributes, object_hash.clone());
            object_hash
        };
        admission.entity.attributes_ref = next_attributes;
        admission.entity.version_hash = canonical_entity_version_hash(&admission.entity)
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    }
    package.validate()
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

/// Monotone operation progress emitted by expensive providers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProgress {
    /// Stable phase name such as `scan`, `convert`, `hash`, or `write`.
    pub phase: String,
    /// Completed work units.
    pub completed: u64,
    /// Total work units when known.
    pub total: Option<u64>,
    /// Short user-facing status.
    pub message: String,
}

/// Host-owned cancellation and progress boundary.
pub trait ProviderOperationContext: Send {
    /// Whether the operation must stop before its next expensive step.
    fn is_cancelled(&self) -> bool;
    /// Publishes one monotone phase snapshot.
    fn report_progress(&mut self, progress: ProviderProgress);
}

/// Import execution request after deterministic probing.
#[derive(Debug, Clone, Copy)]
pub struct CanonicalImportRequest<'a> {
    /// Source file or directory.
    pub source: &'a Path,
    /// Exact format selected during probing.
    pub format_id: &'a str,
    /// Provider-specific immutable options.
    pub options: &'a serde_json::Value,
}

/// Host-local roots for immutable artifacts created during one import execution.
///
/// These paths deliberately never enter the portable canonical package. The host uses them only
/// while staging and hash-verifying the package into its own project store.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StagedArtifactRoots {
    /// Exact source root for every prepared dataset ID in the package.
    pub dataset_roots: BTreeMap<String, PathBuf>,
    /// Exact source root for every resource-set ID in the package.
    pub resource_set_roots: BTreeMap<String, PathBuf>,
}

impl StagedArtifactRoots {
    fn validate(&self, package: &CanonicalImportPackage) -> Result<(), ProviderContractError> {
        let dataset_ids = package
            .datasets
            .iter()
            .map(|dataset| dataset.dataset_id.as_str())
            .collect::<BTreeSet<_>>();
        let resource_set_ids = package
            .resource_sets
            .iter()
            .map(|resource_set| resource_set.resource_set_id.as_str())
            .collect::<BTreeSet<_>>();
        if self.dataset_roots.len() != dataset_ids.len()
            || self.resource_set_roots.len() != resource_set_ids.len()
            || self
                .dataset_roots
                .iter()
                .any(|(id, root)| !dataset_ids.contains(id.as_str()) || root.as_os_str().is_empty())
            || self.resource_set_roots.iter().any(|(id, root)| {
                !resource_set_ids.contains(id.as_str()) || root.as_os_str().is_empty()
            })
        {
            return Err(ProviderContractError::InvalidArtifactRoots);
        }
        Ok(())
    }
}

/// Validated portable package paired with its non-serialized provider-local staging roots.
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalStagedImport {
    /// Portable, serializable canonical import package.
    pub package: CanonicalImportPackage,
    /// Host-local artifact roots valid for this execution result only.
    pub roots: StagedArtifactRoots,
}

impl CanonicalStagedImport {
    /// Validates both the portable package and the exact root inventory.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        self.package.validate()?;
        self.roots.validate(&self.package)
    }
}

/// One output file declared before an export mutates external state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOutput {
    /// Safe relative path below the requested export target.
    pub relative_path: PathBuf,
    /// Intended media type.
    pub media_type: String,
}

/// Pure export decision including every known semantic loss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalExportPlan {
    /// Exact destination format.
    pub format_id: String,
    /// Files that execution will create.
    pub outputs: Vec<ExportOutput>,
    /// Namespaced loss codes; empty means a lossless plan.
    pub semantic_losses: Vec<String>,
}

/// Export request carrying a previously validated canonical selection.
#[derive(Debug)]
pub struct CanonicalExportRequest<'a> {
    /// Destination file or directory.
    pub target: &'a Path,
    /// Exact requested format.
    pub format_id: &'a str,
    /// Canonical package selected for export.
    pub package: &'a CanonicalImportPackage,
    /// Provider-specific immutable options.
    pub options: &'a serde_json::Value,
}

/// Format-specific canonical import provider.
pub trait CanonicalImportProvider: Send + Sync {
    /// Stable descriptor.
    fn descriptor(&self) -> &FormatProviderDescriptor;
    /// Bounded format probe; `None` means no match.
    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError>;
    /// Expensive conversion into one atomic canonical package.
    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError>;
    /// Returns execution-local roots for every artifact inventory in `package`.
    fn staged_artifact_roots(
        &self,
        package: &CanonicalImportPackage,
    ) -> Result<StagedArtifactRoots, ProviderContractError> {
        let roots = StagedArtifactRoots::default();
        roots.validate(package)?;
        Ok(roots)
    }
}

/// Format-specific canonical export provider.
pub trait CanonicalExportProvider: Send + Sync {
    /// Stable descriptor.
    fn descriptor(&self) -> &FormatProviderDescriptor;
    /// Pure plan that declares all files and semantic loss.
    fn plan_export(
        &self,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError>;
    /// Executes an accepted plan.
    fn export(
        &self,
        request: CanonicalExportRequest<'_>,
        plan: &CanonicalExportPlan,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<(), ProviderContractError>;
}

/// Deterministic import/export provider registry.
#[derive(Default)]
pub struct FormatProviderRegistry {
    importers: BTreeMap<String, Arc<dyn CanonicalImportProvider>>,
    exporters: BTreeMap<String, Arc<dyn CanonicalExportProvider>>,
}

impl FormatProviderRegistry {
    /// Registers one importer by stable provider ID.
    pub fn register_importer(
        &mut self,
        provider: Arc<dyn CanonicalImportProvider>,
    ) -> Result<(), ProviderContractError> {
        let descriptor = provider.descriptor();
        descriptor.validate()?;
        if !descriptor.capabilities.contains(&FormatCapability::Import)
            || self.importers.contains_key(&descriptor.provider_id)
            || self
                .exporters
                .get(&descriptor.provider_id)
                .is_some_and(|registered| registered.descriptor() != descriptor)
        {
            return Err(ProviderContractError::DuplicateProvider);
        }
        self.importers
            .insert(descriptor.provider_id.clone(), provider);
        Ok(())
    }

    /// Registers one exporter by stable provider ID.
    pub fn register_exporter(
        &mut self,
        provider: Arc<dyn CanonicalExportProvider>,
    ) -> Result<(), ProviderContractError> {
        let descriptor = provider.descriptor();
        descriptor.validate()?;
        if !descriptor.capabilities.contains(&FormatCapability::Export)
            || self.exporters.contains_key(&descriptor.provider_id)
            || self
                .importers
                .get(&descriptor.provider_id)
                .is_some_and(|registered| registered.descriptor() != descriptor)
        {
            return Err(ProviderContractError::DuplicateProvider);
        }
        self.exporters
            .insert(descriptor.provider_id.clone(), provider);
        Ok(())
    }

    /// Enumerates unique descriptors in stable provider-ID order.
    #[must_use]
    pub fn descriptors(&self) -> Vec<FormatProviderDescriptor> {
        let mut descriptors = self
            .importers
            .values()
            .map(|provider| {
                (
                    provider.descriptor().provider_id.clone(),
                    provider.descriptor().clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        for provider in self.exporters.values() {
            descriptors
                .entry(provider.descriptor().provider_id.clone())
                .or_insert_with(|| provider.descriptor().clone());
        }
        descriptors.into_values().collect()
    }

    /// Enumerates import-capable descriptors in stable provider-ID order.
    #[must_use]
    pub fn import_descriptors(&self) -> Vec<FormatProviderDescriptor> {
        self.importers
            .values()
            .map(|provider| provider.descriptor().clone())
            .collect()
    }

    /// Enumerates export-capable descriptors in stable provider-ID order.
    #[must_use]
    pub fn export_descriptors(&self) -> Vec<FormatProviderDescriptor> {
        self.exporters
            .values()
            .map(|provider| provider.descriptor().clone())
            .collect()
    }

    /// Selects one importer without depending on registration order.
    pub fn select_importer(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<ImportProviderSelection, ProviderContractError> {
        let mut matches = Vec::new();
        for provider in self.importers.values() {
            let Some(probe) = provider.probe(request)? else {
                continue;
            };
            let descriptor = provider.descriptor();
            if !(1..=100).contains(&probe.confidence)
                || !descriptor.format_ids.contains(&probe.format_id)
            {
                return Err(ProviderContractError::InvalidProbe);
            }
            matches.push(ImportProviderSelection {
                provider_id: descriptor.provider_id.clone(),
                provider_version: descriptor.provider_version.clone(),
                format_id: probe.format_id,
                confidence: probe.confidence,
            });
        }
        matches.sort_unstable_by(|left, right| {
            right
                .confidence
                .cmp(&left.confidence)
                .then_with(|| left.provider_id.cmp(&right.provider_id))
        });
        let selected = matches
            .first()
            .cloned()
            .ok_or(ProviderContractError::UnsupportedFormat)?;
        if matches
            .get(1)
            .is_some_and(|other| other.confidence == selected.confidence)
        {
            return Err(ProviderContractError::AmbiguousFormat);
        }
        Ok(selected)
    }

    /// Executes exactly the provider/version/format selected during probing.
    pub fn import(
        &self,
        selection: &ImportProviderSelection,
        source: &Path,
        options: &serde_json::Value,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalStagedImport, ProviderContractError> {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let provider = self
            .importers
            .get(&selection.provider_id)
            .ok_or(ProviderContractError::ProviderChanged)?;
        let descriptor = provider.descriptor();
        if descriptor.provider_version != selection.provider_version
            || !descriptor.format_ids.contains(&selection.format_id)
        {
            return Err(ProviderContractError::ProviderChanged);
        }
        let package = provider.import(
            CanonicalImportRequest {
                source,
                format_id: &selection.format_id,
                options,
            },
            context,
        )?;
        package.validate()?;
        if package.provider_id != selection.provider_id
            || package.provider_version != selection.provider_version
        {
            return Err(ProviderContractError::ProviderChanged);
        }
        let staged = CanonicalStagedImport {
            roots: provider.staged_artifact_roots(&package)?,
            package,
        };
        staged.validate()?;
        Ok(staged)
    }

    /// Resolves one explicitly selected exporter.
    pub fn exporter(
        &self,
        provider_id: &str,
    ) -> Result<Arc<dyn CanonicalExportProvider>, ProviderContractError> {
        self.exporters
            .get(provider_id)
            .cloned()
            .ok_or(ProviderContractError::UnsupportedFormat)
    }

    /// Produces and validates an export plan through one explicitly selected provider.
    pub fn plan_export(
        &self,
        provider_id: &str,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError> {
        request.package.validate()?;
        let provider = self.exporter(provider_id)?;
        let descriptor = provider.descriptor();
        if !descriptor
            .format_ids
            .iter()
            .any(|id| id == request.format_id)
        {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let plan = provider.plan_export(request)?;
        validate_export_plan(&plan, descriptor)?;
        Ok(plan)
    }

    /// Executes an unchanged registry plan after checking cancellation and loss-plan parity.
    pub fn execute_export(
        &self,
        provider_id: &str,
        request: CanonicalExportRequest<'_>,
        plan: &CanonicalExportPlan,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<(), ProviderContractError> {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let provider = self.exporter(provider_id)?;
        let descriptor = provider.descriptor();
        validate_export_plan(plan, descriptor)?;
        let current = provider.plan_export(CanonicalExportRequest {
            target: request.target,
            format_id: request.format_id,
            package: request.package,
            options: request.options,
        })?;
        validate_export_plan(&current, descriptor)?;
        if &current != plan {
            return Err(ProviderContractError::ExportPlanChanged);
        }
        provider.export(request, plan, context)
    }
}

fn validate_export_plan(
    plan: &CanonicalExportPlan,
    descriptor: &FormatProviderDescriptor,
) -> Result<(), ProviderContractError> {
    let mut outputs = BTreeSet::new();
    let mut losses = BTreeSet::new();
    if !descriptor.format_ids.contains(&plan.format_id)
        || plan.outputs.is_empty()
        || plan.outputs.iter().any(|output| {
            !safe_relative_path(&output.relative_path)
                || output.media_type.trim().is_empty()
                || !outputs.insert(output.relative_path.clone())
        })
        || plan
            .semantic_losses
            .iter()
            .any(|loss| !valid_namespaced_id(loss) || !losses.insert(loss))
    {
        return Err(ProviderContractError::InvalidExportPlan);
    }
    Ok(())
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

fn mesh_dataset_contract(
    mesh: &himmelcad_core::entity_model::TriangleMeshGeometry,
) -> Option<(&str, &GeometryResource)> {
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
        // ADR 0031 item 1: saved measurements carry exact anchors and
        // provenance only, no content-addressed resources.
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

fn all_unique<'a, T>(mut values: impl Iterator<Item = &'a T>) -> bool
where
    T: Ord + 'a,
{
    let mut unique = BTreeSet::new();
    values.all(|value| unique.insert(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::canonical_document::CanonicalDocument;
    use himmelcad_core::canonical_resources::{
        CanonicalResourceRef, LinearRgba, MaterialAlphaMode, MaterialResource,
        MaterialTableResource, MaterialTextureSlot, TextureColorSpace, TextureFilter,
        TextureResource, TextureResourceBinding, TextureWrapMode, MATERIAL_RESOURCE_SCHEMA_ID,
        MATERIAL_TABLE_RESOURCE_SCHEMA_ID, TEXTURE_RESOURCE_SCHEMA_ID,
    };
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        built_in_type, CameraModel, CanonicalEntity, DepthField, DepthSemantics, EntityTypeId,
        PanoramaGeometry, RasterCellDiagonal, RasterConfidenceBand, RasterConfidenceEncoding,
        RasterConnectivity, RasterInterpolation, RasterMapping, RasterTriangleMaskEncoding,
        RasterValidityEncoding, RasterValidityMask, Representation, RepresentationAuthority,
        RepresentationRole, StreamedGeometry, Transform3d, Vector3,
    };
    use himmelcad_core::entity_validation::{
        canonical_entity_version_hash, geometry_object_content_hash,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    struct MockImporter {
        descriptor: FormatProviderDescriptor,
        confidence: u8,
        package: CanonicalImportPackage,
    }

    struct MockExporter {
        descriptor: FormatProviderDescriptor,
        executions: Arc<AtomicUsize>,
    }

    impl CanonicalExportProvider for MockExporter {
        fn descriptor(&self) -> &FormatProviderDescriptor {
            &self.descriptor
        }

        fn plan_export(
            &self,
            request: CanonicalExportRequest<'_>,
        ) -> Result<CanonicalExportPlan, ProviderContractError> {
            Ok(CanonicalExportPlan {
                format_id: request.format_id.to_owned(),
                outputs: vec![ExportOutput {
                    relative_path: PathBuf::from("survey.mock"),
                    media_type: "application/vnd.mock".to_owned(),
                }],
                semantic_losses: vec!["hcad.loss.mock-identity@1".to_owned()],
            })
        }

        fn export(
            &self,
            _request: CanonicalExportRequest<'_>,
            _plan: &CanonicalExportPlan,
            _context: &mut dyn ProviderOperationContext,
        ) -> Result<(), ProviderContractError> {
            self.executions.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    impl CanonicalImportProvider for MockImporter {
        fn descriptor(&self) -> &FormatProviderDescriptor {
            &self.descriptor
        }

        fn probe(
            &self,
            _request: ImportProbeRequest<'_>,
        ) -> Result<Option<ImportProbe>, ProviderContractError> {
            Ok(Some(ImportProbe {
                format_id: self.descriptor.format_ids[0].clone(),
                confidence: self.confidence,
            }))
        }

        fn import(
            &self,
            _request: CanonicalImportRequest<'_>,
            _context: &mut dyn ProviderOperationContext,
        ) -> Result<CanonicalImportPackage, ProviderContractError> {
            Ok(self.package.clone())
        }

        fn staged_artifact_roots(
            &self,
            package: &CanonicalImportPackage,
        ) -> Result<StagedArtifactRoots, ProviderContractError> {
            Ok(StagedArtifactRoots {
                dataset_roots: package
                    .datasets
                    .iter()
                    .map(|dataset| {
                        (
                            dataset.dataset_id.clone(),
                            PathBuf::from("/mock").join(&dataset.dataset_id),
                        )
                    })
                    .collect(),
                resource_set_roots: package
                    .resource_sets
                    .iter()
                    .map(|set| {
                        (
                            set.resource_set_id.clone(),
                            PathBuf::from("/mock/resources"),
                        )
                    })
                    .collect(),
            })
        }
    }

    #[derive(Default)]
    struct TestContext {
        cancelled: bool,
        progress: Vec<ProviderProgress>,
    }

    impl ProviderOperationContext for TestContext {
        fn is_cancelled(&self) -> bool {
            self.cancelled
        }

        fn report_progress(&mut self, progress: ProviderProgress) {
            self.progress.push(progress);
        }
    }

    #[test]
    fn canonical_package_binds_dataset_artifacts_to_exact_entity_slot() {
        let package = point_cloud_package("test.io.potree@1");
        package.validate().expect("valid canonical import package");

        let mut escaped = package.clone();
        escaped.datasets[0].artifacts[0].relative_path = PathBuf::from("../metadata.json");
        assert_eq!(
            escaped.validate(),
            Err(ProviderContractError::InvalidDatasetArtifact)
        );

        let mut wrong_root = package.clone();
        wrong_root.datasets[0].root_metadata.object_hash = ObjectHash::of_bytes(b"other");
        assert_eq!(
            wrong_root.validate(),
            Err(ProviderContractError::DatasetBindingMismatch)
        );

        let mut missing_object = package;
        missing_object.objects.pop();
        assert_eq!(
            missing_object.validate(),
            Err(ProviderContractError::MissingEntityObject)
        );
    }

    #[test]
    fn representation_slots_publish_one_document_entity_or_reject_divergence() {
        let mut package = point_cloud_package("test.io.multi-slot@1");
        let mut alternate = package.admissions[0].clone();
        alternate.representation_slot = "measurement".to_owned();
        package.admissions.push(alternate);

        let transaction = package
            .entity_create_transaction("import-scan")
            .expect("one entity transaction");
        assert_eq!(transaction.mutations.len(), 1);
        let mut document = CanonicalDocument::default();
        document.execute(transaction).expect("atomic publication");
        assert_eq!(document.entities().count(), 1);

        let mut divergent = package;
        divergent.admissions[1].entity.name = "Contradicting name".to_owned();
        divergent.admissions[1].entity.version_hash =
            canonical_entity_version_hash(&divergent.admissions[1].entity)
                .expect("divergent entity remains internally valid");
        assert_eq!(
            divergent.validate(),
            Err(ProviderContractError::DivergentEntityAdmission)
        );
    }

    #[test]
    fn registry_selection_is_confidence_based_and_ties_are_explicit() {
        let package = point_cloud_package("test.io.high@1");
        let mut registry = FormatProviderRegistry::default();
        registry
            .register_importer(Arc::new(MockImporter {
                descriptor: descriptor("test.io.low@1", "1.0.0"),
                confidence: 70,
                package: point_cloud_package("test.io.low@1"),
            }))
            .expect("low importer");
        registry
            .register_importer(Arc::new(MockImporter {
                descriptor: descriptor("test.io.high@1", "1.0.0"),
                confidence: 95,
                package,
            }))
            .expect("high importer");
        let request = ImportProbeRequest {
            path: Path::new("survey.laz"),
            prefix: b"LASF",
            media_type: None,
        };
        let selected = registry.select_importer(request).expect("winner");
        assert_eq!(selected.provider_id, "test.io.high@1");

        let imported = registry
            .import(
                &selected,
                request.path,
                &serde_json::json!({}),
                &mut TestContext::default(),
            )
            .expect("selected provider executes");
        assert_eq!(imported.package.provider_id, selected.provider_id);

        let mut tied = FormatProviderRegistry::default();
        for provider_id in ["test.io.a@1", "test.io.b@1"] {
            tied.register_importer(Arc::new(MockImporter {
                descriptor: descriptor(provider_id, "1.0.0"),
                confidence: 90,
                package: point_cloud_package(provider_id),
            }))
            .expect("tie importer");
        }
        assert_eq!(
            tied.select_importer(request),
            Err(ProviderContractError::AmbiguousFormat)
        );
    }

    #[test]
    fn registry_enumerates_unique_descriptors_with_explicit_option_defaults() {
        let mut registry = FormatProviderRegistry::default();
        let descriptor = import_export_descriptor("test.io.enumerated@1", "1.2.3");
        registry
            .register_importer(Arc::new(MockImporter {
                descriptor: descriptor.clone(),
                confidence: 100,
                package: point_cloud_package("test.io.enumerated@1"),
            }))
            .expect("import registration");
        registry
            .register_exporter(Arc::new(MockExporter {
                descriptor: descriptor.clone(),
                executions: Arc::new(AtomicUsize::new(0)),
            }))
            .expect("matching export registration");

        assert_eq!(registry.descriptors(), vec![descriptor.clone()]);
        assert_eq!(registry.import_descriptors(), vec![descriptor.clone()]);
        assert_eq!(registry.export_descriptors(), vec![descriptor.clone()]);
        assert_eq!(
            descriptor
                .import_options
                .as_ref()
                .expect("import options")
                .defaults,
            serde_json::json!({"quality": "balanced"})
        );

        let mut mismatched = descriptor;
        mismatched.display_name = "Different implementation".to_owned();
        let mut mismatched_registry = FormatProviderRegistry::default();
        mismatched_registry
            .register_importer(Arc::new(MockImporter {
                descriptor: import_export_descriptor("test.io.enumerated@1", "1.2.3"),
                confidence: 100,
                package: point_cloud_package("test.io.enumerated@1"),
            }))
            .expect("mismatch import registration");
        assert_eq!(
            mismatched_registry.register_exporter(Arc::new(MockExporter {
                descriptor: mismatched,
                executions: Arc::new(AtomicUsize::new(0)),
            })),
            Err(ProviderContractError::DuplicateProvider)
        );

        let mut invalid_options = import_export_descriptor("test.io.options@1", "1.0.0");
        invalid_options
            .import_options
            .as_mut()
            .expect("import options")
            .defaults = serde_json::json!({"undeclared": true});
        assert_eq!(
            invalid_options.validate(),
            Err(ProviderContractError::InvalidOptionContract)
        );
    }

    #[test]
    fn staged_import_keeps_roots_outside_the_portable_package() {
        let provider_id = "test.io.staged@1";
        let mut registry = FormatProviderRegistry::default();
        registry
            .register_importer(Arc::new(MockImporter {
                descriptor: descriptor(provider_id, "1.0.0"),
                confidence: 100,
                package: point_cloud_package(provider_id),
            }))
            .expect("importer");
        let probe = ImportProbeRequest {
            path: Path::new("survey.laz"),
            prefix: b"LASF",
            media_type: None,
        };
        let selection = registry.select_importer(probe).expect("selection");
        let staged = registry
            .import(
                &selection,
                probe.path,
                &serde_json::json!({}),
                &mut TestContext::default(),
            )
            .expect("staged import");
        assert_eq!(
            staged.roots.dataset_roots.get("potree-scan"),
            Some(&PathBuf::from("/mock/potree-scan"))
        );
        let portable = serde_json::to_string(&staged.package).expect("portable package JSON");
        assert!(!portable.contains("/mock"));

        let rootless = CanonicalStagedImport {
            package: staged.package,
            roots: StagedArtifactRoots::default(),
        };
        assert_eq!(
            rootless.validate(),
            Err(ProviderContractError::InvalidArtifactRoots)
        );
    }

    #[test]
    fn accepted_registration_rewrites_placement_and_audit_without_pick_coordinates() {
        let mut package = point_cloud_package("test.io.registration@1");
        let before_hash = package.admissions[0].entity.version_hash.clone();
        let preview = RegistrationPreview {
            transform: himmelcad_core::transform::Similarity3D {
                tx: 12.0,
                ty: -4.0,
                tz: 3.0,
                rx_radians: 0.0,
                ry_radians: 0.0,
                rz_radians: 0.0,
                scale: 1.0,
            },
            residuals: himmelcad_core::transform::ResidualReport {
                count: 3,
                rms_horizontal_meters: 0.0,
                rms_vertical_meters: 0.0,
                rms_spatial_meters: 0.0,
                max_spatial_meters: 0.0,
                points: Vec::new(),
                out_of_bounds_indices: Vec::new(),
                warnings: Vec::new(),
            },
            iterations: 1,
            matched_samples: 3,
            overlap_ratio: 1.0,
            converged: true,
            accepted: true,
            warnings: Vec::new(),
        };

        apply_registration_preview(&mut package, "site-fit", "pointPairs", &preview)
            .expect("accepted registration");

        let entity = &package.admissions[0].entity;
        let placement = entity.placement.expect("registered placement");
        assert_eq!(
            [placement.0[12], placement.0[13], placement.0[14]],
            [12.0, -4.0, 3.0]
        );
        assert_ne!(entity.version_hash, before_hash);
        let attributes = package
            .objects
            .iter()
            .find(|object| object.object_hash == entity.attributes_ref)
            .expect("rewritten attributes");
        let audit = &attributes.value["hcad.import-registration@1"];
        assert_eq!(audit["recipeId"], "site-fit");
        assert_eq!(audit["method"], "pointPairs");
        let serialized = serde_json::to_string(audit).expect("audit JSON");
        assert!(!serialized.contains("source"));
        assert!(!serialized.contains("target"));
        package
            .validate()
            .expect("registered package remains valid");
    }

    #[test]
    fn registry_export_requires_plan_parity_and_observes_cancellation() {
        let provider_id = "test.io.export@1";
        let executions = Arc::new(AtomicUsize::new(0));
        let mut registry = FormatProviderRegistry::default();
        registry
            .register_exporter(Arc::new(MockExporter {
                descriptor: import_export_descriptor(provider_id, "1.0.0"),
                executions: executions.clone(),
            }))
            .expect("exporter");
        let package = point_cloud_package("test.io.source@1");
        let options = serde_json::json!({});
        let target = Path::new("survey.mock");
        let request = || CanonicalExportRequest {
            target,
            format_id: "las@1.4",
            package: &package,
            options: &options,
        };
        let plan = registry
            .plan_export(provider_id, request())
            .expect("registry plan");

        let mut changed = plan.clone();
        changed
            .semantic_losses
            .push("hcad.loss.added-after-review@1".to_owned());
        assert_eq!(
            registry.execute_export(
                provider_id,
                request(),
                &changed,
                &mut TestContext::default(),
            ),
            Err(ProviderContractError::ExportPlanChanged)
        );
        assert_eq!(executions.load(Ordering::SeqCst), 0);

        let mut cancelled = TestContext {
            cancelled: true,
            ..TestContext::default()
        };
        assert_eq!(
            registry.execute_export(provider_id, request(), &plan, &mut cancelled),
            Err(ProviderContractError::Cancelled)
        );
        assert_eq!(executions.load(Ordering::SeqCst), 0);

        registry
            .execute_export(provider_id, request(), &plan, &mut TestContext::default())
            .expect("matching plan executes");
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancellation_prevents_provider_execution() {
        let provider_id = "test.io.cancel@1";
        let mut registry = FormatProviderRegistry::default();
        registry
            .register_importer(Arc::new(MockImporter {
                descriptor: descriptor(provider_id, "1.0.0"),
                confidence: 100,
                package: point_cloud_package(provider_id),
            }))
            .expect("importer");
        let request = ImportProbeRequest {
            path: Path::new("survey.laz"),
            prefix: b"LASF",
            media_type: None,
        };
        let selected = registry.select_importer(request).expect("selection");
        let mut context = TestContext {
            cancelled: true,
            ..TestContext::default()
        };
        assert_eq!(
            registry.import(
                &selected,
                request.path,
                &serde_json::json!({}),
                &mut context,
            ),
            Err(ProviderContractError::Cancelled)
        );
    }

    #[test]
    fn resource_sets_cover_shared_mesh_texture_once_and_allow_exact_deduplication() {
        let mesh_a = resource(b"mesh-a", "model/gltf-binary");
        let mesh_b = resource(b"mesh-b", "model/gltf-binary");
        let texture = resource(b"shared-texture", "image/png");
        let (presentation_resources, material_table) = presentation_materials(texture.clone());
        let package = binary_package(
            vec![
                (
                    "surface-a",
                    built_in_type::SURFACE_3D,
                    resource_mesh(mesh_a.clone(), material_table.clone()),
                ),
                (
                    "surface-b",
                    built_in_type::SURFACE_3D,
                    resource_mesh(mesh_b.clone(), material_table),
                ),
            ],
            vec![CanonicalResourceSet {
                resource_set_id: "meshes".to_owned(),
                resources: vec![
                    resource_artifact("mesh-a.glb", mesh_a),
                    resource_artifact("mesh-b.glb", mesh_b),
                    resource_artifact("texture.png", texture.clone()),
                ],
            }],
            presentation_resources,
        );
        package.validate().expect("shared texture declared once");

        let mut exact_duplicate = package.clone();
        exact_duplicate.resource_sets.push(CanonicalResourceSet {
            resource_set_id: "shared-cache".to_owned(),
            resources: vec![resource_artifact("copy/texture.png", texture)],
        });
        exact_duplicate
            .validate()
            .expect("exact content-addressed deduplication is allowed");

        let mut duplicate_id = exact_duplicate.clone();
        duplicate_id.resource_sets[1].resource_set_id = "meshes".to_owned();
        assert_eq!(
            duplicate_id.validate(),
            Err(ProviderContractError::InvalidResourceSet)
        );

        let mut missing = package.clone();
        missing.resource_sets[0].resources.pop();
        assert_eq!(
            missing.validate(),
            Err(ProviderContractError::MissingGeometryResource)
        );

        let mut unreferenced = package.clone();
        unreferenced.resource_sets[0]
            .resources
            .push(resource_artifact(
                "unused.bin",
                resource(b"unused", "application/octet-stream"),
            ));
        assert_eq!(
            unreferenced.validate(),
            Err(ProviderContractError::UnreferencedGeometryResource)
        );

        let mut descriptor_tamper = package.clone();
        descriptor_tamper.resource_sets[0].resources[2]
            .resource
            .media_type = "image/jpeg".to_owned();
        assert_eq!(
            descriptor_tamper.validate(),
            Err(ProviderContractError::MissingGeometryResource)
        );

        let mut escaped = package;
        escaped.resource_sets[0].resources[0].relative_path = PathBuf::from("../mesh-a.glb");
        assert_eq!(
            escaped.validate(),
            Err(ProviderContractError::InvalidResourceSet)
        );
    }

    #[test]
    fn panorama_pixels_and_every_depth_band_are_atomically_declared() {
        let pixels = resource(&[1; 36], "image/rgba8");
        let depth = resource(&[2; 72], "application/vnd.himmelcad.depth-f64le");
        let validity = resource(&[3; 2], "application/vnd.himmelcad.raster-validity+bitset");
        let confidence = resource(
            &[4; 9],
            "application/vnd.himmelcad.raster-confidence+unorm8",
        );
        let connectivity = resource(
            &[5; 2],
            "application/vnd.himmelcad.raster-connectivity+bitset",
        );
        let station = Vector3 {
            x: 100.0,
            y: 200.0,
            z: 300.0,
        };
        let mut pose = Transform3d::IDENTITY;
        pose.0[12] = station.x;
        pose.0[13] = station.y;
        pose.0[14] = station.z;
        let geometry = GeometryObject::Panorama {
            panorama: Box::new(PanoramaGeometry {
                image: RasterImageGeometry {
                    pixels: pixels.clone(),
                    width: 3,
                    height: 3,
                    mapping: RasterMapping::Camera {
                        model: CameraModel::Equirectangular,
                        pose,
                    },
                    depth: Some(DepthField {
                        values: depth.clone(),
                        validity: Some(RasterValidityMask {
                            resource: validity.clone(),
                            encoding: RasterValidityEncoding::BitsetLsb0,
                        }),
                        confidence: Some(RasterConfidenceBand {
                            resource: confidence.clone(),
                            encoding: RasterConfidenceEncoding::Unorm8,
                        }),
                        sampling: DepthSampling {
                            semantics: DepthSemantics::RayDistance,
                            interpolation: RasterInterpolation::DiscontinuityAware,
                            connectivity: RasterConnectivity::Mask {
                                resource: connectivity.clone(),
                                encoding: RasterTriangleMaskEncoding::TwoBitsPerCellLsb0,
                                diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                            },
                        },
                    }),
                },
                station_point_cloud: None,
            }),
        };
        let package = binary_package(
            vec![("panorama", built_in_type::PANORAMA, geometry)],
            vec![CanonicalResourceSet {
                resource_set_id: "panorama-bands".to_owned(),
                resources: vec![
                    resource_artifact("pixels.rgba", pixels),
                    resource_artifact("depth.f64le", depth),
                    resource_artifact("validity.bits", validity),
                    resource_artifact("confidence.u8", confidence),
                    resource_artifact("connectivity.bits", connectivity),
                ],
            }],
            CanonicalPresentationResourceSet::default(),
        );
        package.validate().expect("complete panorama resource set");

        let serialized = serde_json::to_value(&package).expect("serialize package");
        let mut legacy = serialized;
        legacy
            .as_object_mut()
            .expect("package object")
            .remove("resourceSets");
        let decoded: CanonicalImportPackage =
            serde_json::from_value(legacy).expect("old empty package remains readable");
        assert!(decoded.resource_sets.is_empty());
    }

    fn resource(bytes: &[u8], media_type: &str) -> GeometryResource {
        GeometryResource {
            object_hash: ObjectHash::of_bytes(bytes),
            media_type: media_type.to_owned(),
            byte_length: Some(u64::try_from(bytes.len()).expect("fixture length")),
        }
    }

    fn resource_artifact(path: &str, resource: GeometryResource) -> PreparedResourceArtifact {
        PreparedResourceArtifact {
            relative_path: PathBuf::from(path),
            resource,
        }
    }

    fn presentation_materials(
        pixels: GeometryResource,
    ) -> (CanonicalPresentationResourceSet, CanonicalResourceRef) {
        let texture = TextureResource {
            schema_id: TEXTURE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "shared-texture".to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed"),
            pixels,
            color_space: TextureColorSpace::Srgb,
            wrap_u: TextureWrapMode::Repeat,
            wrap_v: TextureWrapMode::Repeat,
            mag_filter: TextureFilter::Linear,
            min_filter: TextureFilter::Linear,
        }
        .seal()
        .expect("texture hash");
        let material = MaterialResource {
            schema_id: MATERIAL_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "shared-material".to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed"),
            name: None,
            base_color: LinearRgba {
                red: 1.0,
                green: 1.0,
                blue: 1.0,
                alpha: 1.0,
            },
            emissive: [0.0; 3],
            metallic: 0.0,
            roughness: 1.0,
            alpha_mode: MaterialAlphaMode::Opaque,
            alpha_cutoff: None,
            double_sided: false,
            texture_bindings: vec![TextureResourceBinding {
                slot: MaterialTextureSlot::BaseColor,
                texture: texture.resource_ref(),
                texture_coordinate_set: 0,
                transform: None,
            }],
        }
        .seal()
        .expect("material hash");
        let table = MaterialTableResource {
            schema_id: MATERIAL_TABLE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: "shared-material-table".to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed"),
            materials: vec![material.resource_ref()],
        }
        .seal()
        .expect("material-table hash");
        let reference = table.resource_ref();
        (
            CanonicalPresentationResourceSet {
                textures: vec![texture],
                materials: vec![material],
                material_tables: vec![table],
                ..CanonicalPresentationResourceSet::default()
            },
            reference,
        )
    }

    fn resource_mesh(mesh: GeometryResource, materials: CanonicalResourceRef) -> GeometryObject {
        GeometryObject::Surface3d {
            mesh: Box::new(TriangleMeshGeometry {
                storage: TriangleMeshStorage::Resource { resource: mesh },
                closed_manifold: false,
                triangle_material_slots: None,
                materials: Some(materials),
            }),
        }
    }

    fn binary_package(
        geometries: Vec<(&str, &str, GeometryObject)>,
        resource_sets: Vec<CanonicalResourceSet>,
        presentation_resources: CanonicalPresentationResourceSet,
    ) -> CanonicalImportPackage {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({}),
        )
        .expect("components");
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({"fixture": true}),
        )
        .expect("attributes");
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )
        .expect("relations");
        let admissions = geometries
            .into_iter()
            .map(|(entity_id, type_id, geometry)| {
                let selected = Representation {
                    role: RepresentationRole::Canonical,
                    geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
                    authority: RepresentationAuthority::Authoritative,
                    dependency_hash: None,
                };
                let mut entity = CanonicalEntity {
                    id: EntityId(entity_id.to_owned()),
                    revision: 0,
                    type_id: EntityTypeId(type_id.to_owned()),
                    name: entity_id.to_owned(),
                    owner: None,
                    layer_ids: Vec::new(),
                    placement: None,
                    representations: vec![selected.clone()],
                    components_ref: components.object_hash.clone(),
                    attributes_ref: attributes.object_hash.clone(),
                    relations_ref: relations.object_hash.clone(),
                    style_ref: None,
                    schema_version: 1,
                    version_hash: ObjectHash::of_bytes(b"pending"),
                };
                entity.version_hash =
                    canonical_entity_version_hash(&entity).expect("entity version hash");
                CanonicalRepresentationAdmission {
                    entity,
                    selected,
                    representation_slot: "source".to_owned(),
                    expected_generation: None,
                    resolved_geometry: geometry,
                }
            })
            .collect();
        CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "test.io.binary@1".to_owned(),
            provider_version: "1.0.0".to_owned(),
            admissions,
            objects: vec![components, attributes, relations],
            datasets: Vec::new(),
            resource_sets,
            presentation_resources,
        }
    }

    fn descriptor(provider_id: &str, version: &str) -> FormatProviderDescriptor {
        FormatProviderDescriptor {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: provider_id.to_owned(),
            provider_version: version.to_owned(),
            display_name: "Mock LAS".to_owned(),
            format_ids: vec!["las@1.4".to_owned()],
            extensions: vec!["las".to_owned(), "laz".to_owned()],
            media_types: vec!["application/vnd.las".to_owned()],
            capabilities: vec![FormatCapability::Import],
            import_options: Some(ProviderOptionContract::none()),
            export_options: None,
        }
    }

    fn import_export_descriptor(provider_id: &str, version: &str) -> FormatProviderDescriptor {
        FormatProviderDescriptor {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: provider_id.to_owned(),
            provider_version: version.to_owned(),
            display_name: "Mock import/export".to_owned(),
            format_ids: vec!["las@1.4".to_owned()],
            extensions: vec!["mock".to_owned()],
            media_types: vec!["application/vnd.mock".to_owned()],
            capabilities: vec![FormatCapability::Import, FormatCapability::Export],
            import_options: Some(ProviderOptionContract::object(
                serde_json::json!({
                    "quality": {"type": "string", "enum": ["balanced", "maximum"]}
                }),
                serde_json::json!({"quality": "balanced"}),
            )),
            export_options: Some(ProviderOptionContract::none()),
        }
    }

    fn point_cloud_package(provider_id: &str) -> CanonicalImportPackage {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({"hcad.prepared-dataset@1": {"formatId": "potree@2"}}),
        )
        .expect("components");
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({"pointCount": 1}),
        )
        .expect("attributes");
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )
        .expect("relations");
        let root_metadata = GeometryResource {
            object_hash: ObjectHash::of_bytes(b"potree metadata"),
            media_type: "potree@2".to_owned(),
            byte_length: Some(15),
        };
        let geometry = GeometryObject::PointCloud {
            dataset: StreamedGeometry {
                format_id: "potree@2".to_owned(),
                metadata: root_metadata.clone(),
                element_count: Some(1),
            },
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId("scan".to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: "Scan".to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![selected.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"pending"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: provider_id.to_owned(),
            provider_version: "1.0.0".to_owned(),
            admissions: vec![CanonicalRepresentationAdmission {
                entity,
                selected,
                representation_slot: "source".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            }],
            objects: vec![components, attributes, relations],
            datasets: vec![CanonicalPreparedDataset {
                dataset_id: "potree-scan".to_owned(),
                format_id: "potree@2".to_owned(),
                entity_id: "scan".to_owned(),
                representation_slot: "source".to_owned(),
                root_metadata: root_metadata.clone(),
                artifacts: vec![PreparedDatasetArtifact {
                    relative_path: PathBuf::from("metadata.json"),
                    resource: root_metadata,
                }],
            }],
            resource_sets: Vec::new(),
            presentation_resources: CanonicalPresentationResourceSet::default(),
        }
    }
}
