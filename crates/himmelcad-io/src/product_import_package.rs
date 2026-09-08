//! Consumer for immutable PhotoLab product import packages (ADR 0030).

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, DepthSemantics, ElevationSurfaceGeometry, GeometryObject,
    RasterCellDiagonal, RasterConnectivity, RasterInterpolation, RasterTriangleMaskEncoding,
};
use himmelcad_core::entity_validation::canonical_entity_version_hash;
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::product_import_package::{
    read_product_import_package_manifest, PhotoLabDemFactsV1, ProductImportPackageManifestV1,
    ProductImportPackageReadyRecordV1, ProductLineageDemConnectivityV1,
    ProductLineageDemSourceNoDataV1, ProvenanceStatus, PRODUCT_IMPORT_PACKAGE_READY_SCHEMA_ID,
};
use himmelcad_render::{
    ContentKind, DatasetId, PreparedHierarchyManifest, PreparedHierarchySource,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical_provider::{
    CanonicalImportPackage, CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject,
    CanonicalPreparedDataset, CanonicalResourceSet, FormatCapability, FormatProviderDescriptor,
    ImportProbe, ImportProbeRequest, PreparedDatasetArtifact, PreparedResourceArtifact,
    ProviderContractError, ProviderOperationContext, ProviderOptionContract, ProviderProgress,
    StagedArtifactRoots, CANONICAL_IO_SCHEMA_VERSION,
};

pub const PRODUCT_IMPORT_PACKAGE_PROVIDER_ID: &str = "hcad.io.photolab-product-package@1";
pub const PRODUCT_IMPORT_PACKAGE_FORMAT_ID: &str = "hcad.product-import-package@1";

/// Closed IF-D28 refusal surfaced unchanged by every product-import entry point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductImportPackageRefusal {
    pub reason_code: &'static str,
    pub message: String,
}

impl ProductImportPackageRefusal {
    fn invalid(diagnostic: impl Into<String>) -> Self {
        Self {
            reason_code: "invalid_package",
            message: format!(
                "The import package is invalid. Republish or recompute this product in PhotoLab. {}",
                diagnostic.into()
            ),
        }
    }

    fn unsupported(diagnostic: impl Into<String>) -> Self {
        Self {
            reason_code: "unsupported_package_schema",
            message: format!(
                "This product package version is not supported by this version of Builder. {}",
                diagnostic.into()
            ),
        }
    }

    fn unprepared(diagnostic: impl Into<String>) -> Self {
        Self {
            reason_code: "needs_preparation",
            message: format!(
                "Prepare this product in PhotoLab before importing. {}",
                diagnostic.into()
            ),
        }
    }

    fn lineage(diagnostic: impl Into<String>) -> Self {
        Self {
            reason_code: "needs_republish_recompute",
            message: format!(
                "Republish or recompute this product in PhotoLab to capture complete provenance. {}",
                diagnostic.into()
            ),
        }
    }
}

impl From<ProductImportPackageRefusal> for ProviderContractError {
    fn from(value: ProductImportPackageRefusal) -> Self {
        Self::ProductImportRefused {
            reason_code: value.reason_code,
            message: value.message,
        }
    }
}

/// Reads package admissions without copying or rewriting the authoritative package.
pub struct PhotoLabProductPackageProvider {
    descriptor: FormatProviderDescriptor,
    roots: Mutex<BTreeMap<String, PathBuf>>,
}

impl PhotoLabProductPackageProvider {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: PRODUCT_IMPORT_PACKAGE_PROVIDER_ID.to_owned(),
                provider_version: "1".to_owned(),
                display_name: "PhotoLab product package".to_owned(),
                format_ids: vec![PRODUCT_IMPORT_PACKAGE_FORMAT_ID.to_owned()],
                extensions: vec!["json".to_owned()],
                media_types: vec![
                    "application/vnd.himmelcad.product-import-package-ready+json".to_owned(),
                ],
                capabilities: vec![FormatCapability::Import],
                import_options: Some(ProviderOptionContract::none()),
                export_options: None,
            },
            roots: Mutex::new(BTreeMap::new()),
        }
    }
}

impl Default for PhotoLabProductPackageProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CanonicalImportProvider for PhotoLabProductPackageProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let package_root = package_root(request.path);
        if request.path.is_dir()
            && package_root.join("ready.json").is_file()
            && package_root.join("manifest.json").is_file()
        {
            return Ok(Some(ImportProbe {
                format_id: PRODUCT_IMPORT_PACKAGE_FORMAT_ID.to_owned(),
                confidence: 100,
            }));
        }
        let file_name = request.path.file_name().and_then(|value| value.to_str());
        if matches!(file_name, Some("ready.json" | "manifest.json"))
            && (contains_bytes(
                request.prefix,
                PRODUCT_IMPORT_PACKAGE_READY_SCHEMA_ID.as_bytes(),
            ) || contains_bytes(request.prefix, b"hcad.product-import-package-manifest@1"))
        {
            return Ok(Some(ImportProbe {
                format_id: PRODUCT_IMPORT_PACKAGE_FORMAT_ID.to_owned(),
                confidence: 100,
            }));
        }
        Ok(None)
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != PRODUCT_IMPORT_PACKAGE_FORMAT_ID
            || request.options != &serde_json::json!({})
        {
            return Err(ProviderContractError::InvalidPackage);
        }
        let root = package_root(request.source);
        let (ready, manifest) = read_and_validate_package(&root, context)?;
        let package = canonical_package(&root, &ready, &manifest)?;
        let mut roots = self.roots.lock().expect("product package roots poisoned");
        for dataset in &package.datasets {
            roots.insert(dataset.dataset_id.clone(), root.clone());
        }
        for resource_set in &package.resource_sets {
            roots.insert(resource_set.resource_set_id.clone(), root.clone());
        }
        Ok(package)
    }

    fn staged_artifact_roots(
        &self,
        package: &CanonicalImportPackage,
    ) -> Result<StagedArtifactRoots, ProviderContractError> {
        let roots = self.roots.lock().expect("product package roots poisoned");
        let dataset_roots = package
            .datasets
            .iter()
            .map(|dataset| {
                roots
                    .get(&dataset.dataset_id)
                    .cloned()
                    .map(|root| (dataset.dataset_id.clone(), root))
                    .ok_or(ProviderContractError::InvalidArtifactRoots)
            })
            .collect::<Result<_, _>>()?;
        let resource_set_roots = package
            .resource_sets
            .iter()
            .map(|resource_set| {
                roots
                    .get(&resource_set.resource_set_id)
                    .cloned()
                    .map(|root| (resource_set.resource_set_id.clone(), root))
                    .ok_or(ProviderContractError::InvalidArtifactRoots)
            })
            .collect::<Result<_, _>>()?;
        Ok(StagedArtifactRoots {
            dataset_roots,
            resource_set_roots,
        })
    }
}

fn package_root(source: &Path) -> PathBuf {
    if source.is_dir() {
        source.to_path_buf()
    } else {
        source.parent().unwrap_or(source).to_path_buf()
    }
}

fn read_and_validate_package(
    root: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<
    (
        ProductImportPackageReadyRecordV1,
        ProductImportPackageManifestV1,
    ),
    ProviderContractError,
> {
    let ready_bytes = std::fs::read(root.join("ready.json"))
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
    let ready_value: Value = serde_json::from_slice(&ready_bytes)
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
    if ready_value.get("schema_id").and_then(Value::as_str)
        != Some(PRODUCT_IMPORT_PACKAGE_READY_SCHEMA_ID)
    {
        return Err(ProductImportPackageRefusal::unsupported(
            "ready.json has an unknown schema id",
        )
        .into());
    }
    if last_object_member(&ready_bytes) != Some("package_sha256") {
        return Err(ProductImportPackageRefusal::invalid(
            "ready.json did not publish package_sha256 last",
        )
        .into());
    }
    validate_ready_members(&ready_value)?;
    let ready: ProductImportPackageReadyRecordV1 = serde_json::from_value(ready_value)
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;

    let manifest_bytes = std::fs::read(root.join("manifest.json"))
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
    if ObjectHash::of_bytes(&manifest_bytes) != ready.manifest_sha256 {
        return Err(ProductImportPackageRefusal::invalid(
            "manifest_sha256 does not match manifest.json",
        )
        .into());
    }
    let supported_types = BTreeSet::from([
        built_in_type::POINT_CLOUD.to_owned(),
        built_in_type::GAUSSIAN_SPLAT_CLOUD.to_owned(),
        built_in_type::ELEVATION_SURFACE.to_owned(),
        built_in_type::SURFACE_3D.to_owned(),
        built_in_type::OBJECT_3D.to_owned(),
    ]);
    let retained = read_product_import_package_manifest(
        &manifest_bytes,
        &BTreeSet::new(),
        &supported_types,
    )
    .map_err(|error| match error {
        himmelcad_core::product_import_package::ProductImportPackageError::UnsupportedPackageSchema => {
            ProductImportPackageRefusal::unsupported(error.to_string())
        }
        _ => ProductImportPackageRefusal::invalid(error.to_string()),
    })?;
    let manifest = retained.manifest;
    validate_ready_agreement(&ready, &manifest)?;
    if ready.provenance_status != ProvenanceStatus::Complete || !ready.missing_field_ids.is_empty()
    {
        return Err(ProductImportPackageRefusal::lineage(
            "the ready record has incomplete lineage",
        )
        .into());
    }
    validate_arrival_row(&manifest)?;

    let total = manifest.counts.total_bytes;
    let mut completed = 0_u64;
    let progress_message = format!("Validating PhotoLab product · {}", manifest.product.label);
    context.report_progress(ProviderProgress {
        phase: "validate".to_owned(),
        completed: 0,
        total: Some(total),
        message: progress_message.clone(),
    });
    for artifact in &manifest.artifacts {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let path = root.join(&artifact.path);
        let canonical_root = root
            .canonicalize()
            .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
        let canonical_path = path
            .canonicalize()
            .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
        if !canonical_path.starts_with(&canonical_root) || !canonical_path.is_file() {
            return Err(ProductImportPackageRefusal::invalid(format!(
                "declared artifact escaped the package root: {}",
                artifact.path
            ))
            .into());
        }
        let (hash, length) = hash_file(
            &canonical_path,
            context,
            completed,
            total,
            &progress_message,
        )?;
        if length != artifact.byte_length || hash != artifact.sha256 {
            return Err(ProductImportPackageRefusal::invalid(format!(
                "declared artifact hash or length changed: {}",
                artifact.path
            ))
            .into());
        }
        completed = completed.saturating_add(length);
    }
    Ok((ready, manifest))
}

fn validate_ready_members(ready: &Value) -> Result<(), ProviderContractError> {
    const MEMBERS: &[&str] = &[
        "schema_id",
        "manifest_id",
        "product_id",
        "product_version_hash",
        "publication_generation",
        "normalized_format_id",
        "manifest_sha256",
        "lineage_object_sha256",
        "provenance_status",
        "missing_field_ids",
        "artifact_count",
        "object_count",
        "total_bytes",
        "package_sha256",
    ];
    let Some(object) = ready.as_object() else {
        return Err(ProductImportPackageRefusal::invalid("ready.json is not an object").into());
    };
    let expected = MEMBERS.iter().copied().collect::<BTreeSet<_>>();
    let observed = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if observed != expected {
        return Err(ProductImportPackageRefusal::invalid(
            "ready.json does not have the exact V1 member set",
        )
        .into());
    }
    Ok(())
}

fn hash_file(
    path: &Path,
    context: &mut dyn ProviderOperationContext,
    completed_before: u64,
    total: u64,
    message: &str,
) -> Result<(ObjectHash, u64), ProviderContractError> {
    let file = File::open(path)
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut digest = Sha256::new();
    let mut length = 0_u64;
    loop {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        length = length
            .checked_add(u64::try_from(read).expect("bounded read length fits u64"))
            .ok_or_else(|| ProductImportPackageRefusal::invalid("artifact length overflow"))?;
        context.report_progress(ProviderProgress {
            phase: "validate".to_owned(),
            completed: completed_before.saturating_add(length).min(total),
            total: Some(total),
            message: message.to_owned(),
        });
    }
    Ok((ObjectHash(hex::encode(digest.finalize())), length))
}

fn validate_ready_agreement(
    ready: &ProductImportPackageReadyRecordV1,
    manifest: &ProductImportPackageManifestV1,
) -> Result<(), ProviderContractError> {
    let agrees = ready.manifest_id == manifest.manifest_id
        && ready.product_id == manifest.product.entity_id
        && ready.product_version_hash == manifest.product.entity_version_hash
        && ready.publication_generation == manifest.source.publication_generation
        && Some(ready.normalized_format_id.as_str())
            == manifest.lineage.payload.normalized_format_id.as_deref()
        && ready.lineage_object_sha256 == manifest.lineage.lineage_object_sha256
        && ready.artifact_count == manifest.counts.artifact_count
        && ready.object_count == manifest.counts.object_count
        && ready.total_bytes == manifest.counts.total_bytes
        && ready.package_sha256 == manifest.package_sha256;
    if !agrees {
        return Err(
            ProductImportPackageRefusal::invalid("ready.json and manifest.json disagree").into(),
        );
    }
    Ok(())
}

fn validate_arrival_row(
    manifest: &ProductImportPackageManifestV1,
) -> Result<(), ProviderContractError> {
    if manifest.admissions.len() != 1 || manifest.datasets.len() != 1 {
        return Err(ProductImportPackageRefusal::invalid(
            "V1 product packages require one admission and one prepared dataset",
        )
        .into());
    }
    let admission = &manifest.admissions[0];
    let dataset = &manifest.datasets[0];
    let accepted = match manifest.product.kind.as_str() {
        "sparse" | "dense" => {
            admission.type_id == built_in_type::POINT_CLOUD
                && dataset.format_id == "potree@2"
                && dataset.content_kind == "potreePoints"
        }
        "dem" => {
            admission.type_id == built_in_type::ELEVATION_SURFACE
                && dataset.format_id == "himmelcad-prepared-hierarchy@1"
                && dataset.content_kind == "raster"
        }
        "mesh" => {
            matches!(
                admission.type_id.as_str(),
                built_in_type::SURFACE_3D | built_in_type::OBJECT_3D
            ) && dataset.format_id == "himmelcad-prepared-hierarchy@1"
                && dataset.content_kind == "gltf"
        }
        "gaussianSplat" => {
            admission.type_id == built_in_type::GAUSSIAN_SPLAT_CLOUD
                && dataset.format_id == "himmelcad-prepared-hierarchy@1"
                && dataset.content_kind == "gaussianSplats"
        }
        "orthomosaic" => {
            return Err(ProductImportPackageRefusal::unprepared(
                "PlanGrid2D admission is not available in this schema revision",
            )
            .into());
        }
        _ => false,
    };
    if !accepted {
        return Err(ProductImportPackageRefusal::invalid(
            "product kind, entity type, prepared format, and content kind do not agree",
        )
        .into());
    }
    if dataset.entity_id != admission.entity_id
        || dataset.entity_id != manifest.product.entity_id
        || admission.representation_slots.len() != 1
        || admission.representation_slots[0].slot != dataset.slot
        || admission.representation_slots[0].object_sha256 != manifest.product.content_hash
    {
        return Err(ProductImportPackageRefusal::invalid(
            "admission and dataset bindings disagree",
        )
        .into());
    }
    Ok(())
}

fn canonical_package(
    root: &Path,
    ready: &ProductImportPackageReadyRecordV1,
    manifest: &ProductImportPackageManifestV1,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let admission_record = &manifest.admissions[0];
    let dataset_record = &manifest.datasets[0];
    let mut entity: CanonicalEntity = read_json(root, &admission_record.entity_object_path)?;
    if entity.id.0 != admission_record.entity_id
        || entity.type_id.0 != admission_record.type_id
        || entity.schema_version != admission_record.schema_version
        || hash_small_file(root, &admission_record.entity_object_path)?
            != admission_record.entity_object_sha256
    {
        return Err(ProductImportPackageRefusal::invalid(
            "canonical entity envelope disagrees with the manifest",
        )
        .into());
    }

    let representation_record = &admission_record.representation_slots[0];
    let geometry_resource = manifest
        .resources
        .iter()
        .find(|resource| resource.sha256 == representation_record.object_sha256)
        .ok_or_else(|| ProductImportPackageRefusal::invalid("representation object is absent"))?;
    let geometry: GeometryObject = read_json(root, &geometry_resource.object_path)?;
    let selected = entity
        .representations
        .iter()
        .find(|representation| representation.geometry_ref == representation_record.object_sha256)
        .cloned()
        .ok_or_else(|| ProductImportPackageRefusal::invalid("entity representation is absent"))?;

    let original_entity_id = entity.id.0.clone();
    let destination_id = format!("photolab-product-{}", ready.package_sha256.as_str());
    entity.id.0 = destination_id.clone();
    entity.owner = None;

    let mut objects = Vec::new();
    for (hash, media_type) in [
        (
            &entity.components_ref,
            "application/vnd.himmelcad.components+json",
        ),
        (
            &entity.attributes_ref,
            "application/vnd.himmelcad.attributes+json",
        ),
        (
            &entity.relations_ref,
            "application/vnd.himmelcad.relations+json",
        ),
    ] {
        let resource = manifest
            .resources
            .iter()
            .find(|resource| &resource.sha256 == hash)
            .ok_or_else(|| {
                ProductImportPackageRefusal::invalid("canonical entity object is absent")
            })?;
        let value: Value = read_json(root, &resource.object_path)?;
        objects.push(CanonicalJsonObject::new(media_type, value)?);
    }

    let component_index = objects
        .iter()
        .position(|object| object.object_hash == entity.components_ref)
        .ok_or_else(|| ProductImportPackageRefusal::invalid("component object is absent"))?;
    let lineage_resource = manifest
        .resources
        .iter()
        .find(|resource| resource.role == "lineage")
        .ok_or_else(|| ProductImportPackageRefusal::lineage("lineage object is absent"))?;
    let lineage_bytes = read_small_file(root, &lineage_resource.object_path)?;
    if ObjectHash::of_bytes(&lineage_bytes) != manifest.lineage.lineage_object_sha256 {
        return Err(ProductImportPackageRefusal::lineage("lineage bytes changed").into());
    }
    let component_map = objects[component_index]
        .value
        .as_object_mut()
        .ok_or_else(|| ProductImportPackageRefusal::invalid("component map is not an object"))?;
    component_map.insert(
        "hcad.photolab-product-provenance@1".to_owned(),
        serde_json::json!({
            "schemaId": "hcad.photolab-product-provenance@1",
            "product": manifest.product.label,
            "productKind": manifest.product.kind,
            "sourceProjectId": manifest.source.project_id,
            "sourceProductId": original_entity_id,
            "sourceProductVersionHash": manifest.product.entity_version_hash,
            "publicationGeneration": manifest.source.publication_generation,
            "manifestId": manifest.manifest_id,
            "lineageObjectSha256": manifest.lineage.lineage_object_sha256,
            "lineagePayloadUtf8": String::from_utf8(lineage_bytes).map_err(|_| ProductImportPackageRefusal::lineage("lineage is not UTF-8"))?,
            "packageSha256": manifest.package_sha256,
            "provenanceStatus": "complete"
        }),
    );
    objects[component_index] = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        objects[component_index].value.clone(),
    )?;
    entity.components_ref = objects[component_index].object_hash.clone();
    entity.version_hash = canonical_entity_version_hash(&entity)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;

    let dataset_artifacts = dataset_record
        .artifact_paths
        .iter()
        .map(|path| {
            let artifact = manifest
                .artifacts
                .iter()
                .find(|artifact| &artifact.path == path)
                .ok_or_else(|| {
                    ProductImportPackageRefusal::invalid(format!(
                        "dataset artifact is absent: {path}"
                    ))
                })?;
            Ok(PreparedDatasetArtifact {
                relative_path: PathBuf::from(path),
                resource: himmelcad_core::entity_model::GeometryResource {
                    object_hash: artifact.sha256.clone(),
                    media_type: artifact.media_type.clone(),
                    byte_length: Some(artifact.byte_length),
                },
            })
        })
        .collect::<Result<Vec<_>, ProductImportPackageRefusal>>()?;
    let root_artifact = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.path == dataset_record.root_path)
        .ok_or_else(|| ProductImportPackageRefusal::invalid("dataset root artifact is absent"))?;
    validate_prepared_root(root, manifest, dataset_record, root_artifact, &geometry)?;
    let destination_dataset_id = format!("photolab-{}-0", ready.package_sha256.as_str());
    let dataset = CanonicalPreparedDataset {
        dataset_id: destination_dataset_id,
        format_id: dataset_record.format_id.clone(),
        entity_id: destination_id.clone(),
        representation_slot: dataset_record.slot.clone(),
        root_metadata: himmelcad_core::entity_model::GeometryResource {
            object_hash: root_artifact.sha256.clone(),
            media_type: root_artifact.media_type.clone(),
            byte_length: Some(root_artifact.byte_length),
        },
        artifacts: dataset_artifacts,
    };

    let geometry_json = serde_json::to_string(&geometry)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    let dataset_paths = dataset_record
        .artifact_paths
        .iter()
        .collect::<BTreeSet<_>>();
    let binary_resources = manifest
        .resources
        .iter()
        .filter(|resource| {
            !dataset_paths.contains(&resource.object_path)
                && geometry_json.contains(resource.sha256.as_str())
                && resource.sha256 != representation_record.object_sha256
        })
        .map(|resource| PreparedResourceArtifact {
            relative_path: PathBuf::from(&resource.object_path),
            resource: himmelcad_core::entity_model::GeometryResource {
                object_hash: resource.sha256.clone(),
                media_type: resource.media_type.clone(),
                byte_length: Some(resource.byte_length),
            },
        })
        .collect::<Vec<_>>();
    let resource_sets = if binary_resources.is_empty() {
        Vec::new()
    } else {
        vec![CanonicalResourceSet {
            resource_set_id: format!("photolab-{}-resources", ready.package_sha256.as_str()),
            resources: binary_resources,
        }]
    };

    let admission = CanonicalRepresentationAdmission {
        entity,
        selected,
        representation_slot: dataset_record.slot.clone(),
        expected_generation: None,
        resolved_geometry: geometry,
    };
    let package = CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: PRODUCT_IMPORT_PACKAGE_PROVIDER_ID.to_owned(),
        provider_version: "1".to_owned(),
        admissions: vec![admission],
        objects,
        datasets: vec![dataset],
        resource_sets,
        presentation_resources: Default::default(),
    };
    package.validate()?;
    Ok(package)
}

fn validate_prepared_root(
    root: &Path,
    manifest: &ProductImportPackageManifestV1,
    dataset: &himmelcad_core::product_import_package::ProductImportPackageDatasetV1,
    root_artifact: &himmelcad_core::product_import_package::ProductImportPackageArtifactV1,
    geometry: &GeometryObject,
) -> Result<(), ProviderContractError> {
    if dataset.format_id != "himmelcad-prepared-hierarchy@1" {
        return Ok(());
    }
    let bytes = read_small_file(root, &dataset.root_path)?;
    PreparedHierarchySource::from_json(
        DatasetId(dataset.dataset_id.clone()),
        "hcad://photolab-package/dataset/manifest.json",
        &bytes,
    )
    .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
    let hierarchy: PreparedHierarchyManifest = serde_json::from_slice(&bytes)
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?;
    let expected_kind = match dataset.content_kind.as_str() {
        "raster" => ContentKind::Raster,
        "gltf" => ContentKind::Gltf,
        "gaussianSplats" => ContentKind::GaussianSplats,
        _ => {
            return Err(ProductImportPackageRefusal::invalid(
                "prepared hierarchy content kind is unsupported",
            )
            .into())
        }
    };
    let contents = hierarchy
        .tiles
        .iter()
        .flat_map(|tile| tile.contents.iter())
        .collect::<Vec<_>>();
    if contents.is_empty() || contents.iter().any(|content| content.kind != expected_kind) {
        return Err(ProductImportPackageRefusal::invalid(
            "prepared hierarchy contents disagree with the manifest row",
        )
        .into());
    }
    if manifest.product.kind == "dem" {
        let facts = manifest
            .lineage
            .payload
            .dem_facts
            .as_ref()
            .ok_or_else(|| ProductImportPackageRefusal::invalid("DEM facts are absent"))?;
        validate_dem_geometry(facts, root_artifact, geometry)?;
        for content in contents {
            validate_dem_decoder(facts, content.decoder_parameters.as_ref())?;
        }
    }
    Ok(())
}

fn validate_dem_geometry(
    facts: &PhotoLabDemFactsV1,
    root_artifact: &himmelcad_core::product_import_package::ProductImportPackageArtifactV1,
    geometry: &GeometryObject,
) -> Result<(), ProviderContractError> {
    let GeometryObject::ElevationSurface { surface } = geometry else {
        return Err(ProductImportPackageRefusal::invalid(
            "DEM geometry is not an elevation surface",
        )
        .into());
    };
    let ElevationSurfaceGeometry::Grid {
        raster, sampling, ..
    } = surface.as_ref()
    else {
        return Err(ProductImportPackageRefusal::invalid("DEM geometry is not a Grid").into());
    };
    let interpolation_agrees = matches!(sampling.interpolation, RasterInterpolation::Bilinear)
        && facts.interpolation == "bilinear";
    let semantics_agree =
        matches!(sampling.semantics, DepthSemantics::ElevationZ) && facts.semantics == "elevationZ";
    let connectivity_agrees = match (&sampling.connectivity, &facts.connectivity) {
        (RasterConnectivity::PixelSteps, ProductLineageDemConnectivityV1::PixelSteps) => true,
        (
            RasterConnectivity::Continuous {
                maximum_height_jump,
                diagonal,
            },
            ProductLineageDemConnectivityV1::Continuous {
                maximum_height_jump: fact_jump,
                diagonal: fact_diagonal,
            },
        ) => {
            maximum_height_jump.map(f64::to_bits)
                == fact_jump.as_ref().map(|value| value.to_f64().to_bits())
                && diagonal_name(*diagonal) == fact_diagonal
        }
        (
            RasterConnectivity::Mask {
                resource,
                encoding: RasterTriangleMaskEncoding::TwoBitsPerCellLsb0,
                diagonal,
            },
            ProductLineageDemConnectivityV1::Mask {
                resource: fact_resource,
                encoding,
                diagonal: fact_diagonal,
            },
        ) => {
            resource.object_hash == fact_resource.sha256
                && resource.byte_length == Some(fact_resource.byte_length)
                && resource.media_type == fact_resource.media_type
                && encoding == "twoBitsPerCellLsb0"
                && diagonal_name(*diagonal) == fact_diagonal
        }
        _ => false,
    };
    if raster.object_hash != root_artifact.sha256
        || raster.byte_length != Some(root_artifact.byte_length)
        || !semantics_agree
        || !interpolation_agrees
        || !connectivity_agrees
    {
        return Err(ProductImportPackageRefusal::invalid(
            "DEM Grid sampling does not bind the frozen DEM facts",
        )
        .into());
    }
    Ok(())
}

fn validate_dem_decoder(
    facts: &PhotoLabDemFactsV1,
    parameters: Option<&Value>,
) -> Result<(), ProviderContractError> {
    let parameters = parameters.and_then(Value::as_object).ok_or_else(|| {
        ProductImportPackageRefusal::invalid("DEM tile decoder parameters are absent")
    })?;
    let validity = parameters
        .get("validityReference")
        .and_then(Value::as_object)
        .ok_or_else(|| ProductImportPackageRefusal::invalid("DEM validityReference is absent"))?;
    let validity_agrees = validity.get("contentHash").and_then(Value::as_str)
        == Some(facts.validity.resource.sha256.as_str())
        && validity.get("byteLength").and_then(Value::as_u64)
            == Some(facts.validity.resource.byte_length)
        && validity.get("byteOffset").is_some_and(Value::is_null)
        && facts.validity.encoding == "bitsetLsb0";
    let interpolation_agrees = parameters.get("interpolation").and_then(Value::as_str)
        == Some(facts.interpolation.as_str());
    let topology_agrees = parameters
        .get("topology")
        .and_then(Value::as_object)
        .is_some_and(|topology| match &facts.connectivity {
            ProductLineageDemConnectivityV1::PixelSteps => {
                topology.get("kind").and_then(Value::as_str) == Some("pixelSteps")
            }
            ProductLineageDemConnectivityV1::Continuous {
                diagonal,
                maximum_height_jump,
            } => {
                topology.get("kind").and_then(Value::as_str) == Some("continuous")
                    && topology.get("diagonal").and_then(Value::as_str) == Some(diagonal.as_str())
                    && match (maximum_height_jump, topology.get("maximumHeightJump")) {
                        (None, None | Some(Value::Null)) => true,
                        (Some(expected), Some(observed)) => observed
                            .as_f64()
                            .is_some_and(|value| value.to_bits() == expected.to_f64().to_bits()),
                        _ => false,
                    }
            }
            ProductLineageDemConnectivityV1::Mask {
                resource,
                encoding,
                diagonal,
            } => {
                let reference = parameters
                    .get("triangleMaskReference")
                    .and_then(Value::as_object);
                topology.get("kind").and_then(Value::as_str) == Some("mask")
                    && topology.get("diagonal").and_then(Value::as_str) == Some(diagonal.as_str())
                    && topology.get("encoding").and_then(Value::as_str) == Some(encoding.as_str())
                    && reference.is_some_and(|reference| {
                        reference.get("contentHash").and_then(Value::as_str)
                            == Some(resource.sha256.as_str())
                            && reference.get("byteLength").and_then(Value::as_u64)
                                == Some(resource.byte_length)
                    })
            }
        });
    let no_data_agrees = match (&facts.source_no_data, parameters.get("noData")) {
        (ProductLineageDemSourceNoDataV1::Nan, Some(value)) => {
            value.get("kind").and_then(Value::as_str) == Some("nan")
        }
        (ProductLineageDemSourceNoDataV1::AlphaMask, Some(value)) => {
            value.get("kind").and_then(Value::as_str) == Some("alphaMask")
        }
        (ProductLineageDemSourceNoDataV1::Numeric { value }, Some(observed)) => {
            observed.get("kind").and_then(Value::as_str) == Some("numeric")
                && observed
                    .get("value")
                    .and_then(Value::as_f64)
                    .is_some_and(|observed| observed.to_bits() == value.to_f64().to_bits())
        }
        _ => false,
    };
    if !validity_agrees || !interpolation_agrees || !topology_agrees || !no_data_agrees {
        return Err(ProductImportPackageRefusal::invalid(
            "DEM decoder parameters do not bind the frozen DEM facts",
        )
        .into());
    }
    Ok(())
}

fn diagonal_name(value: RasterCellDiagonal) -> &'static str {
    match value {
        RasterCellDiagonal::TopLeftToBottomRight => "topLeftToBottomRight",
        RasterCellDiagonal::TopRightToBottomLeft => "topRightToBottomLeft",
    }
}

fn read_json<T: serde::de::DeserializeOwned>(
    root: &Path,
    path: &str,
) -> Result<T, ProviderContractError> {
    serde_json::from_slice(&read_small_file(root, path)?)
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()).into())
}

fn hash_small_file(root: &Path, path: &str) -> Result<ObjectHash, ProviderContractError> {
    Ok(ObjectHash::of_bytes(&read_small_file(root, path)?))
}

fn read_small_file(root: &Path, path: &str) -> Result<Vec<u8>, ProviderContractError> {
    const MAX_CANONICAL_JSON_BYTES: u64 = 16 * 1024 * 1024;
    let source = root.join(path);
    let length = source
        .metadata()
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()))?
        .len();
    if length > MAX_CANONICAL_JSON_BYTES {
        return Err(ProductImportPackageRefusal::invalid(format!(
            "canonical JSON exceeds the 16 MiB bound: {path}"
        ))
        .into());
    }
    std::fs::read(source)
        .map_err(|error| ProductImportPackageRefusal::invalid(error.to_string()).into())
}

fn last_object_member(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(bytes).ok()?.trim_end();
    let end = text.rfind('}')?;
    let before = &text[..end];
    let colon = before.rfind(':')?;
    let key_end = before[..colon].rfind('"')?;
    let key_start = before[..key_end].rfind('"')?;
    Some(&before[key_start + 1..key_end])
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|part| part == needle)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[derive(Default)]
    struct Context;

    impl ProviderOperationContext for Context {
        fn is_cancelled(&self) -> bool {
            false
        }

        fn report_progress(&mut self, _progress: ProviderProgress) {}
    }

    #[test]
    fn ready_record_requires_package_hash_as_the_last_member() {
        assert_eq!(
            last_object_member(br#"{"schema_id":"x","package_sha256":"abc"}"#),
            Some("package_sha256")
        );
        assert_eq!(
            last_object_member(br#"{"package_sha256":"abc","artifact_count":1}"#),
            Some("artifact_count")
        );
    }

    #[test]
    fn provider_descriptor_is_stable_and_valid() {
        PhotoLabProductPackageProvider::new()
            .descriptor()
            .validate()
            .expect("descriptor");
    }

    fn landed_package_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad/.photolab/\
             product-import-packages/product-e5cb1a6337969eeddf390cff7877137131d3c96b30874551aede4921756dd4ea",
        )
    }

    fn refusal(error: ProviderContractError) -> &'static str {
        match error {
            ProviderContractError::ProductImportRefused { reason_code, .. } => reason_code,
            other => panic!("typed product refusal expected, got {other}"),
        }
    }

    #[test]
    fn package_refusals_preserve_closed_if_d28_reason_codes() {
        let landed = landed_package_root();
        if !landed.join("ready.json").is_file() {
            return;
        }
        let root =
            std::env::temp_dir().join(format!("himmelcad-product-refusal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temporary package");
        let manifest_bytes = fs::read(landed.join("manifest.json")).expect("manifest fixture");
        let mut ready: ProductImportPackageReadyRecordV1 =
            serde_json::from_slice(&fs::read(landed.join("ready.json")).expect("ready fixture"))
                .expect("ready record");
        let provider = PhotoLabProductPackageProvider::new();

        ready.schema_id = "hcad.product-import-package-ready@2".to_owned();
        fs::write(
            root.join("ready.json"),
            serde_json::to_vec(&ready).expect("ready bytes"),
        )
        .expect("write ready");
        assert_eq!(
            refusal(
                provider
                    .import(
                        CanonicalImportRequest {
                            source: &root,
                            format_id: PRODUCT_IMPORT_PACKAGE_FORMAT_ID,
                            options: &serde_json::json!({}),
                        },
                        &mut Context,
                    )
                    .expect_err("unknown ready schema"),
            ),
            "unsupported_package_schema"
        );

        ready = serde_json::from_slice(
            &fs::read(landed.join("ready.json")).expect("fresh ready fixture"),
        )
        .expect("fresh ready record");
        fs::write(
            root.join("ready.json"),
            serde_json::to_vec(&ready).expect("ready bytes"),
        )
        .expect("write ready");
        fs::write(root.join("manifest.json"), b"{}").expect("invalid manifest");
        assert_eq!(
            refusal(
                provider
                    .import(
                        CanonicalImportRequest {
                            source: &root,
                            format_id: PRODUCT_IMPORT_PACKAGE_FORMAT_ID,
                            options: &serde_json::json!({}),
                        },
                        &mut Context,
                    )
                    .expect_err("invalid manifest hash"),
            ),
            "invalid_package"
        );

        ready.provenance_status = ProvenanceStatus::Partial;
        ready.missing_field_ids = vec!["tools".to_owned()];
        fs::write(
            root.join("ready.json"),
            serde_json::to_vec(&ready).expect("ready bytes"),
        )
        .expect("write ready");
        fs::write(root.join("manifest.json"), manifest_bytes).expect("valid manifest");
        assert_eq!(
            refusal(
                provider
                    .import(
                        CanonicalImportRequest {
                            source: &root,
                            format_id: PRODUCT_IMPORT_PACKAGE_FORMAT_ID,
                            options: &serde_json::json!({}),
                        },
                        &mut Context,
                    )
                    .expect_err("incomplete lineage"),
            ),
            "needs_republish_recompute"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn landed_photolab_package_validates_without_rewriting_the_authority() {
        let root = landed_package_root();
        if !root.join("ready.json").is_file() {
            return;
        }
        let provider = PhotoLabProductPackageProvider::new();
        for source in [root.clone(), root.join("ready.json")] {
            let prefix = if source.is_file() {
                fs::read(&source).expect("ready prefix")
            } else {
                Vec::new()
            };
            let selection = provider
                .probe(ImportProbeRequest {
                    path: &source,
                    prefix: &prefix,
                    media_type: None,
                })
                .expect("probe")
                .expect("package selection");
            let package = provider
                .import(
                    CanonicalImportRequest {
                        source: &source,
                        format_id: &selection.format_id,
                        options: &serde_json::json!({}),
                    },
                    &mut Context,
                )
                .expect("landed package");
            assert_eq!(package.admissions.len(), 1);
            assert_eq!(package.datasets[0].format_id, "potree@2");
            assert!(package.objects.iter().any(|object| {
                object
                    .value
                    .get("hcad.photolab-product-provenance@1")
                    .is_some()
            }));
        }
        assert!(root.join("ready.json").is_file());
    }
}
