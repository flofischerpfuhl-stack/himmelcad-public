//! Canonical PhotoLab product import package wire contracts from ADR 0030.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_json;
use crate::canonical_json::Decimal64;
use crate::hash::ObjectHash;
use crate::photolab_capture::PhotolabSpatialReference;
use crate::photolab_crs::{CrsDefinition, HeightReference};
use crate::photolab_project::ProjectReferenceFrame;

pub const PRODUCT_IMPORT_PACKAGE_SCHEMA_ID: &str = "hcad.product-import-package-manifest@1";
pub const PRODUCT_IMPORT_PACKAGE_READY_SCHEMA_ID: &str = "hcad.product-import-package-ready@1";
pub const PRODUCT_LINEAGE_SCHEMA_ID: &str = "hcad.photolab-product-lineage@1";
pub const PRODUCT_PUBLICATION_SCHEMA_ID: &str = "hcad.photolab-product-publication@1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageProducerV1 {
    pub product_id: String,
    pub product_version: String,
    pub build_hash: ObjectHash,
    pub canonical_schema_versions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageSourceV1 {
    pub project_id: String,
    pub project_fingerprint: ObjectHash,
    pub publication_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageProductV1 {
    pub entity_id: String,
    pub entity_version_hash: ObjectHash,
    pub content_hash: ObjectHash,
    pub kind: String,
    pub label: String,
    pub dataset_label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageLineageV1 {
    pub schema_id: String,
    pub lineage_object_sha256: ObjectHash,
    pub payload: ProductLineageV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageRepresentationSlotV1 {
    pub slot: String,
    pub kind: String,
    pub object_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageAdmissionV1 {
    pub entity_id: String,
    pub type_id: String,
    pub schema_version: u32,
    pub entity_object_path: String,
    pub entity_object_sha256: ObjectHash,
    pub representation_slots: Vec<ProductImportPackageRepresentationSlotV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageDatasetV1 {
    pub dataset_id: String,
    pub entity_id: String,
    pub slot: String,
    pub format_id: String,
    pub content_kind: String,
    pub root_path: String,
    pub root_sha256: ObjectHash,
    pub artifact_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageResourceV1 {
    pub resource_id: String,
    pub owner_entity_id: String,
    pub role: String,
    pub object_path: String,
    pub sha256: ObjectHash,
    pub byte_length: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageArtifactV1 {
    pub path: String,
    pub sha256: ObjectHash,
    pub byte_length: u64,
    pub media_type: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageCountsV1 {
    pub object_count: u64,
    pub artifact_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageManifestV1 {
    pub schema_id: String,
    pub manifest_id: String,
    pub producer: ProductImportPackageProducerV1,
    pub source: ProductImportPackageSourceV1,
    pub product: ProductImportPackageProductV1,
    pub lineage: ProductImportPackageLineageV1,
    pub admissions: Vec<ProductImportPackageAdmissionV1>,
    pub datasets: Vec<ProductImportPackageDatasetV1>,
    pub resources: Vec<ProductImportPackageResourceV1>,
    pub artifacts: Vec<ProductImportPackageArtifactV1>,
    pub required_features: Vec<String>,
    pub counts: ProductImportPackageCountsV1,
    pub package_sha256: ObjectHash,
}

impl ProductImportPackageManifestV1 {
    pub fn computed_package_sha256(
        &self,
    ) -> Result<ObjectHash, canonical_json::CanonicalJsonError> {
        canonical_json::sha256_omitting_member(self, "package_sha256").map(ObjectHash)
    }
}

/// Processing-set identity frozen at publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProductLineageProcessingSetChoiceV1 {
    Selected {
        id: String,
        version_hash: ObjectHash,
        membership_sha256: ObjectHash,
    },
    None,
    AllImportedCameras,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProductLineageMaskScopeV1 {
    Selected { scope_sha256: ObjectHash },
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProductLineageGcpChoiceV1 {
    Selected {
        entity_id: String,
        entity_version_hash: ObjectHash,
        snapshot_sha256: ObjectHash,
    },
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProductLineageReferenceFrameV1 {
    Frozen {
        project_reference_frame: ProductLineageProjectReferenceFrameV1,
    },
    LocalFrame,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductLineageIdentityV1 {
    pub id: String,
    pub sha256: ObjectHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductLineageAlignmentKindV1 {
    Single,
    MergedOverlap,
    MergedSharedControl,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLineageCrsWithEpochV1 {
    pub crs: CrsDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate_epoch: Option<ProductLineageCoordinateEpochV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLineageCoordinateEpochV1 {
    pub decimal_year: Decimal64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLineageFrozenCrsEndpointV1 {
    pub horizontal: ProductLineageCrsWithEpochV1,
    pub vertical: HeightReference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLineageProjectReferenceFrameV1 {
    pub target: ProductLineageFrozenCrsEndpointV1,
    pub established_by_transformation_sha256: ObjectHash,
}

impl ProductLineageProjectReferenceFrameV1 {
    pub fn from_project(
        value: &ProjectReferenceFrame,
    ) -> Result<Self, canonical_json::CanonicalJsonError> {
        Ok(Self {
            target: ProductLineageFrozenCrsEndpointV1 {
                horizontal: ProductLineageCrsWithEpochV1 {
                    crs: value.target.horizontal.crs.clone(),
                    coordinate_epoch: value
                        .target
                        .horizontal
                        .coordinate_epoch
                        .map(|epoch| Decimal64::from_f64(epoch.decimal_year))
                        .transpose()?
                        .map(|decimal_year| ProductLineageCoordinateEpochV1 { decimal_year }),
                },
                vertical: value.target.vertical.clone(),
            },
            established_by_transformation_sha256: value
                .established_by_transformation_sha256
                .clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductLineageResourceIdentityV1 {
    pub resource_id: ObjectHash,
    pub sha256: ObjectHash,
    pub byte_length: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProductLineageDemConnectivityV1 {
    PixelSteps,
    Continuous {
        diagonal: String,
        #[serde(rename = "maximumHeightJump")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maximum_height_jump: Option<Decimal64>,
    },
    Mask {
        resource: ProductLineageResourceIdentityV1,
        encoding: String,
        diagonal: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProductLineageDemSourceNoDataV1 {
    Numeric { value: Decimal64 },
    Nan,
    AlphaMask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductLineageDemValidityV1 {
    pub resource: ProductLineageResourceIdentityV1,
    pub encoding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PhotoLabDemFactsV1 {
    pub semantics: String,
    pub interpolation: String,
    pub connectivity: ProductLineageDemConnectivityV1,
    pub source_no_data: ProductLineageDemSourceNoDataV1,
    pub validity: ProductLineageDemValidityV1,
}

/// Exact IF-D26 frozen publication lineage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductLineageV1 {
    pub source_project_id: String,
    pub source_project_fingerprint: ObjectHash,
    pub product_entity_id: String,
    pub product_entity_version_hash: ObjectHash,
    pub product_content_hash: ObjectHash,
    pub publication_generation: u64,
    pub product_kind: String,
    pub product_label: String,
    pub dataset_label: String,
    pub source_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_format_id: Option<String>,
    pub source_alignment_kind: ProductLineageAlignmentKindV1,
    pub source_alignment_entity_id: String,
    pub source_alignment_entity_version_hash: ObjectHash,
    pub source_alignment_content_hash: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_inputs: Option<Vec<ProductLineageIdentityV1>>,
    pub processing_set_choice: ProductLineageProcessingSetChoiceV1,
    pub camera_selection_sha256: ObjectHash,
    pub image_mask_scope: ProductLineageMaskScopeV1,
    pub gcp_choice: ProductLineageGcpChoiceV1,
    #[serde(rename = "spatialReference")]
    pub spatial_reference: PhotolabSpatialReference,
    pub reference_frame: ProductLineageReferenceFrameV1,
    pub algorithms: Vec<ProductLineageIdentityV1>,
    pub configurations: Vec<ProductLineageIdentityV1>,
    pub tools: Vec<ProductLineageIdentityV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_audit: Option<ProductLineageIdentityV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dem_facts: Option<PhotoLabDemFactsV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceStatus {
    Complete,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductImportPackageReadyRecordV1 {
    pub schema_id: String,
    pub manifest_id: String,
    pub product_id: String,
    pub product_version_hash: ObjectHash,
    pub publication_generation: u64,
    pub normalized_format_id: String,
    pub manifest_sha256: ObjectHash,
    pub lineage_object_sha256: ObjectHash,
    pub provenance_status: ProvenanceStatus,
    pub missing_field_ids: Vec<String>,
    pub artifact_count: u64,
    pub object_count: u64,
    pub total_bytes: u64,
    /// Must remain the final member of this struct and the final member written on the wire.
    pub package_sha256: ObjectHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductDatasetDispositionV1 {
    Available,
    NeedsPreparation,
    NeedsRepublishRecompute,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductPublicationReasonCodeV1 {
    Available,
    NeedsRepublishRecompute,
    NeedsPreparation,
    NoPackage,
    UnsupportedFormat,
    InvalidPackage,
    UnsupportedPackageSchema,
}

impl ProductPublicationReasonCodeV1 {
    #[must_use]
    pub const fn disposition(self) -> ProductDatasetDispositionV1 {
        match self {
            Self::Available => ProductDatasetDispositionV1::Available,
            Self::NeedsPreparation | Self::NoPackage => {
                ProductDatasetDispositionV1::NeedsPreparation
            }
            Self::NeedsRepublishRecompute | Self::InvalidPackage => {
                ProductDatasetDispositionV1::NeedsRepublishRecompute
            }
            Self::UnsupportedFormat | Self::UnsupportedPackageSchema => {
                ProductDatasetDispositionV1::Unsupported
            }
        }
    }

    #[must_use]
    pub const fn base_copy(self) -> &'static str {
        match self {
            Self::Available => "Ready to import.",
            Self::NeedsRepublishRecompute => {
                "Republish or recompute this product in PhotoLab to capture complete provenance."
            }
            Self::NeedsPreparation => "Prepare this product in PhotoLab before importing.",
            Self::NoPackage => {
                "No import package is available. Republish this product in PhotoLab."
            }
            Self::UnsupportedFormat => "This product format is not supported by Builder.",
            Self::InvalidPackage => {
                "The import package is invalid. Republish or recompute this product in PhotoLab."
            }
            Self::UnsupportedPackageSchema => {
                "This product package version is not supported by this version of Builder."
            }
        }
    }
}

/// Applies the IF-D28 listing precedence to already-validated bounded summary facts.
#[must_use]
pub const fn select_product_publication_reason_code(
    unsupported_format: bool,
    unsupported_package_schema: bool,
    invalid_known_package: bool,
    complete_lineage: bool,
    has_prepared_binding: bool,
    has_package: bool,
) -> ProductPublicationReasonCodeV1 {
    if unsupported_format {
        ProductPublicationReasonCodeV1::UnsupportedFormat
    } else if unsupported_package_schema {
        ProductPublicationReasonCodeV1::UnsupportedPackageSchema
    } else if invalid_known_package {
        ProductPublicationReasonCodeV1::InvalidPackage
    } else if !complete_lineage {
        ProductPublicationReasonCodeV1::NeedsRepublishRecompute
    } else if !has_prepared_binding {
        ProductPublicationReasonCodeV1::NeedsPreparation
    } else if !has_package {
        ProductPublicationReasonCodeV1::NoPackage
    } else {
        ProductPublicationReasonCodeV1::Available
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PhotoLabProductPublicationPackageV1 {
    pub schema_id: String,
    pub manifest_id: String,
    pub package_relative_path: String,
    pub normalized_format_id: String,
    pub manifest_sha256: ObjectHash,
    pub artifact_count: u64,
    pub object_count: u64,
    pub total_bytes: u64,
    pub package_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PhotoLabProductPublicationRecordV1 {
    pub schema_id: String,
    pub publication_id: String,
    pub product_id: String,
    pub product_version_hash: ObjectHash,
    pub product_content_hash: ObjectHash,
    pub publication_generation: u64,
    pub lineage: ProductImportPackageLineageV1,
    pub provenance_status: ProvenanceStatus,
    pub missing_field_ids: Vec<String>,
    pub disposition: ProductDatasetDispositionV1,
    pub reason_code: ProductPublicationReasonCodeV1,
    pub package: Option<PhotoLabProductPublicationPackageV1>,
}

/// Derives the one IF-D29 identity shared by publication and package manifest.
pub fn product_publication_id(
    source_project_id: &str,
    product_entity_id: &str,
    product_entity_version_hash: &ObjectHash,
    publication_generation: u64,
) -> Result<String, canonical_json::CanonicalJsonError> {
    let preimage = serde_json::json!([
        source_project_id,
        product_entity_id,
        product_entity_version_hash,
        publication_generation
    ]);
    let bytes = canonical_json::to_vec(&preimage)?;
    Ok(format!("product-{}", ObjectHash::of_bytes(&bytes).as_str()))
}

/// Lossless recognized-manifest read: semantic fields plus the exact source bytes.
#[derive(Debug, Clone)]
pub struct RetainedProductImportPackageManifestV1 {
    pub manifest: ProductImportPackageManifestV1,
    pub original_manifest_bytes: Vec<u8>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProductImportPackageError {
    #[error("unsupported_package_schema")]
    UnsupportedPackageSchema,
    #[error("invalid product import package manifest: {0}")]
    InvalidManifest(String),
}

pub fn read_product_import_package_manifest(
    bytes: &[u8],
    supported_required_features: &BTreeSet<String>,
    supported_type_ids: &BTreeSet<String>,
) -> Result<RetainedProductImportPackageManifestV1, ProductImportPackageError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| ProductImportPackageError::InvalidManifest(error.to_string()))?;
    if value.get("schema_id").and_then(serde_json::Value::as_str)
        != Some(PRODUCT_IMPORT_PACKAGE_SCHEMA_ID)
    {
        return Err(ProductImportPackageError::UnsupportedPackageSchema);
    }
    let declared_package_sha256 = value
        .get("package_sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            ProductImportPackageError::InvalidManifest(
                "package_sha256 is missing or is not a string".to_owned(),
            )
        })?;
    let computed_package_sha256 = canonical_json::sha256_omitting_member(&value, "package_sha256")
        .map_err(|error| ProductImportPackageError::InvalidManifest(error.to_string()))?;
    if computed_package_sha256 != declared_package_sha256 {
        return Err(ProductImportPackageError::InvalidManifest(
            "package_sha256 does not match the canonical manifest payload".to_owned(),
        ));
    }
    let manifest: ProductImportPackageManifestV1 = serde_json::from_value(value)
        .map_err(|error| ProductImportPackageError::InvalidManifest(error.to_string()))?;
    if manifest
        .required_features
        .iter()
        .any(|feature| !supported_required_features.contains(feature))
    {
        return Err(ProductImportPackageError::UnsupportedPackageSchema);
    }
    if manifest.lineage.schema_id != PRODUCT_LINEAGE_SCHEMA_ID
        || manifest
            .admissions
            .iter()
            .any(|admission| !supported_type_ids.contains(&admission.type_id))
    {
        return Err(ProductImportPackageError::UnsupportedPackageSchema);
    }
    let lineage_bytes = canonical_json::to_vec(&manifest.lineage.payload)
        .map_err(|error| ProductImportPackageError::InvalidManifest(error.to_string()))?;
    if manifest.lineage.lineage_object_sha256 != ObjectHash::of_bytes(&lineage_bytes)
        || manifest.source.project_id != manifest.lineage.payload.source_project_id
        || manifest.source.project_fingerprint
            != manifest.lineage.payload.source_project_fingerprint
        || manifest.source.publication_generation != manifest.lineage.payload.publication_generation
        || manifest.product.entity_id != manifest.lineage.payload.product_entity_id
        || manifest.product.entity_version_hash
            != manifest.lineage.payload.product_entity_version_hash
        || manifest.product.content_hash != manifest.lineage.payload.product_content_hash
        || manifest.product.kind != manifest.lineage.payload.product_kind
        || manifest.product.label != manifest.lineage.payload.product_label
        || manifest.product.dataset_label != manifest.lineage.payload.dataset_label
    {
        return Err(ProductImportPackageError::InvalidManifest(
            "manifest source/product summary disagrees with lineage".to_owned(),
        ));
    }
    let missing = product_lineage_missing_field_ids(
        &serde_json::to_value(&manifest.lineage.payload)
            .map_err(|error| ProductImportPackageError::InvalidManifest(error.to_string()))?,
    )?;
    if !missing.is_empty() {
        return Err(ProductImportPackageError::InvalidManifest(format!(
            "package lineage is incomplete: {}",
            missing.join(", ")
        )));
    }
    validate_product_import_package_paths(&manifest)?;
    Ok(RetainedProductImportPackageManifestV1 {
        manifest,
        original_manifest_bytes: bytes.to_vec(),
    })
}

pub fn validate_product_import_package_paths(
    manifest: &ProductImportPackageManifestV1,
) -> Result<(), ProductImportPackageError> {
    const RESOURCE_ROLES: &[&str] = &[
        "lineage",
        "admission_entity",
        "representation_object",
        "canonical_object",
        "registration_audit",
        "dem_validity",
        "dem_connectivity",
    ];
    const ARTIFACT_ROLES: &[&str] = &[
        "lineage",
        "admission_entity",
        "representation_object",
        "canonical_object",
        "registration_audit",
        "dem_validity",
        "dem_connectivity",
        "dataset",
    ];
    if !matches!(
        manifest.product.kind.as_str(),
        "sparse" | "dense" | "dem" | "orthomosaic" | "mesh" | "gaussianSplat"
    ) || !matches!(
        manifest.lineage.payload.normalized_format_id.as_deref(),
        Some("potree@2" | "himmelcad-prepared-hierarchy@1")
    ) {
        return Err(ProductImportPackageError::InvalidManifest(
            "product kind or normalized format is not admitted".to_owned(),
        ));
    }
    let mut exact = BTreeSet::new();
    let mut folded = BTreeMap::<String, String>::new();
    for path in manifest
        .artifacts
        .iter()
        .map(|artifact| artifact.path.as_str())
    {
        validate_relative_posix_path(path)?;
        if !exact.insert(path.to_owned()) {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "duplicate declared path: {path}"
            )));
        }
        let case_folded = path.to_lowercase();
        if let Some(existing) = folded.insert(case_folded, path.to_owned()) {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "platform case-fold collision: {existing} and {path}"
            )));
        }
    }
    let mut resource_paths = BTreeSet::new();
    for resource in &manifest.resources {
        if resource.media_type.trim().is_empty()
            || resource.resource_id != resource.sha256.as_str()
            || !RESOURCE_ROLES.contains(&resource.role.as_str())
            || !resource_paths.insert(&resource.object_path)
        {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "invalid or duplicate resource path: {}",
                resource.object_path
            )));
        }
        validate_declared_reference(&exact, &resource.object_path)?;
    }
    if manifest.lineage.payload.product_kind == "dem" {
        let dem_facts = manifest.lineage.payload.dem_facts.as_ref().ok_or_else(|| {
            ProductImportPackageError::InvalidManifest(
                "dem_facts is required for a DEM package".to_owned(),
            )
        })?;
        validate_dem_facts(dem_facts)?;
        validate_dem_resource_binding(
            &manifest.resources,
            &dem_facts.validity.resource,
            "DEM validity",
        )?;
        if let ProductLineageDemConnectivityV1::Mask { resource, .. } = &dem_facts.connectivity {
            validate_dem_resource_binding(&manifest.resources, resource, "DEM mask connectivity")?;
        }
    }
    let mut dataset_paths = BTreeSet::new();
    for dataset in &manifest.datasets {
        if dataset.dataset_id.is_empty()
            || !matches!(
                dataset.format_id.as_str(),
                "potree@2" | "himmelcad-prepared-hierarchy@1"
            )
            || Some(dataset.format_id.as_str())
                != manifest.lineage.payload.normalized_format_id.as_deref()
            || !matches!(
                dataset.content_kind.as_str(),
                "potreePoints" | "raster" | "gltf" | "gaussianSplats"
            )
        {
            return Err(ProductImportPackageError::InvalidManifest(
                "dataset identity, format, or content kind is invalid".to_owned(),
            ));
        }
        if !dataset
            .artifact_paths
            .iter()
            .any(|path| path == &dataset.root_path)
        {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "dataset root is absent from artifact_paths: {}",
                dataset.root_path
            )));
        }
        for path in &dataset.artifact_paths {
            if !dataset_paths.insert(path) {
                return Err(ProductImportPackageError::InvalidManifest(format!(
                    "dataset artifact path is declared more than once: {path}"
                )));
            }
            validate_declared_reference(&exact, path)?;
        }
    }
    for admission in &manifest.admissions {
        validate_declared_reference(&exact, &admission.entity_object_path)?;
        if admission.representation_slots.iter().any(|slot| {
            !matches!(
                slot.kind.as_str(),
                "canonical" | "body" | "axis" | "footprint" | "boundary" | "alternate"
            )
        }) {
            return Err(ProductImportPackageError::InvalidManifest(
                "representation slot kind is invalid".to_owned(),
            ));
        }
    }
    for artifact in &manifest.artifacts {
        if artifact.media_type.trim().is_empty()
            || !ARTIFACT_ROLES.contains(&artifact.role.as_str())
        {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "artifact media type or role is invalid: {}",
                artifact.path
            )));
        }
    }
    let object_count = u64::try_from(manifest.resources.len()).map_err(|_| {
        ProductImportPackageError::InvalidManifest("object_count exceeds u64".to_owned())
    })?;
    let artifact_count = u64::try_from(manifest.artifacts.len()).map_err(|_| {
        ProductImportPackageError::InvalidManifest("artifact_count exceeds u64".to_owned())
    })?;
    let total_bytes = manifest
        .artifacts
        .iter()
        .try_fold(0_u64, |total, artifact| {
            total.checked_add(artifact.byte_length).ok_or_else(|| {
                ProductImportPackageError::InvalidManifest("total_bytes overflow".to_owned())
            })
        })?;
    if manifest.counts.object_count != object_count
        || manifest.counts.artifact_count != artifact_count
        || manifest.counts.total_bytes != total_bytes
    {
        return Err(ProductImportPackageError::InvalidManifest(
            "declared counts do not equal the complete inventory".to_owned(),
        ));
    }
    Ok(())
}

fn validate_dem_resource_binding(
    resources: &[ProductImportPackageResourceV1],
    identity: &ProductLineageResourceIdentityV1,
    label: &str,
) -> Result<(), ProductImportPackageError> {
    let resource = resources
        .iter()
        .find(|resource| resource.resource_id == identity.resource_id.as_str())
        .ok_or_else(|| {
            ProductImportPackageError::InvalidManifest(format!(
                "{label} resource is absent from the manifest resources"
            ))
        })?;
    if resource.sha256 != identity.sha256 || resource.byte_length != identity.byte_length {
        return Err(ProductImportPackageError::InvalidManifest(format!(
            "{label} resource binding disagrees with the manifest resources"
        )));
    }
    Ok(())
}

fn validate_dem_facts(facts: &PhotoLabDemFactsV1) -> Result<(), ProductImportPackageError> {
    let valid_diagonal =
        |value: &str| matches!(value, "topLeftToBottomRight" | "topRightToBottomLeft");
    let valid_connectivity = match &facts.connectivity {
        ProductLineageDemConnectivityV1::PixelSteps => true,
        ProductLineageDemConnectivityV1::Continuous { diagonal, .. } => valid_diagonal(diagonal),
        ProductLineageDemConnectivityV1::Mask {
            encoding, diagonal, ..
        } => encoding == "twoBitsPerCellLsb0" && valid_diagonal(diagonal),
    };
    if facts.semantics != "elevationZ"
        || !matches!(
            facts.interpolation.as_str(),
            "nearest" | "bilinear" | "discontinuityAware"
        )
        || !valid_connectivity
        || facts.validity.encoding != "bitsetLsb0"
    {
        return Err(ProductImportPackageError::InvalidManifest(
            "DEM facts contain invalid sampling or encoding values".to_owned(),
        ));
    }
    Ok(())
}

fn validate_declared_reference(
    artifacts: &BTreeSet<String>,
    path: &str,
) -> Result<(), ProductImportPackageError> {
    validate_relative_posix_path(path)?;
    if !artifacts.contains(path) {
        return Err(ProductImportPackageError::InvalidManifest(format!(
            "referenced path is absent from artifacts: {path}"
        )));
    }
    Ok(())
}

pub fn validate_relative_posix_path(path: &str) -> Result<(), ProductImportPackageError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ProductImportPackageError::InvalidManifest(format!(
            "invalid relative POSIX path: {path:?}"
        )));
    }
    Ok(())
}

/// Computes IF-D27 member paths for a structurally partial legacy lineage object.
pub fn product_lineage_missing_field_ids(
    value: &serde_json::Value,
) -> Result<Vec<String>, ProductImportPackageError> {
    const REQUIRED: &[&str] = &[
        "source_project_id",
        "source_project_fingerprint",
        "product_entity_id",
        "product_entity_version_hash",
        "product_content_hash",
        "publication_generation",
        "product_kind",
        "product_label",
        "dataset_label",
        "source_format",
        "source_alignment_kind",
        "source_alignment_entity_id",
        "source_alignment_entity_version_hash",
        "source_alignment_content_hash",
        "processing_set_choice",
        "camera_selection_sha256",
        "image_mask_scope",
        "gcp_choice",
        "spatialReference",
        "reference_frame",
        "algorithms",
        "configurations",
        "tools",
    ];
    let object = value.as_object().ok_or_else(|| {
        ProductImportPackageError::InvalidManifest("lineage payload is not an object".to_owned())
    })?;
    let mut missing = REQUIRED
        .iter()
        .filter(|member| !object.contains_key(**member))
        .map(|member| (*member).to_owned())
        .collect::<Vec<_>>();
    for member in [
        "algorithms",
        "configurations",
        "tools",
        "source_alignment_inputs",
    ] {
        let Some(value) = object.get(member) else {
            continue;
        };
        let items = value.as_array().ok_or_else(|| {
            ProductImportPackageError::InvalidManifest(format!("{member} is not an array"))
        })?;
        for (index, item) in items.iter().enumerate() {
            let item = item.as_object().ok_or_else(|| {
                ProductImportPackageError::InvalidManifest(format!(
                    "{member}[{index}] is not an object"
                ))
            })?;
            for field in ["id", "sha256"] {
                if !item.contains_key(field) {
                    missing.push(format!("{member}[{index}].{field}"));
                }
            }
            if item
                .get("id")
                .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
                || item.get("sha256").is_some_and(|value| {
                    value.as_str().is_none_or(|value| {
                        value.len() != 64
                            || !value
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                })
            {
                return Err(ProductImportPackageError::InvalidManifest(format!(
                    "{member}[{index}] has an invalid identity"
                )));
            }
        }
    }
    for (member, selected_fields) in [
        (
            "processing_set_choice",
            &["id", "version_hash", "membership_sha256"][..],
        ),
        ("image_mask_scope", &["scope_sha256"][..]),
        (
            "gcp_choice",
            &["entity_id", "entity_version_hash", "snapshot_sha256"][..],
        ),
    ] {
        let Some(choice) = object.get(member) else {
            continue;
        };
        let choice = choice.as_object().ok_or_else(|| {
            ProductImportPackageError::InvalidManifest(format!("{member} is not an object"))
        })?;
        match choice.get("kind") {
            None => missing.push(format!("{member}.kind")),
            Some(serde_json::Value::String(kind)) if kind == "selected" => {
                for field in selected_fields {
                    if !choice.contains_key(*field) {
                        missing.push(format!("{member}.{field}"));
                    }
                }
            }
            Some(serde_json::Value::String(kind))
                if match member {
                    "processing_set_choice" => {
                        matches!(kind.as_str(), "none" | "all_imported_cameras")
                    }
                    "image_mask_scope" | "gcp_choice" => kind == "none",
                    _ => false,
                } => {}
            Some(serde_json::Value::String(kind)) => {
                return Err(ProductImportPackageError::InvalidManifest(format!(
                    "{member}.kind has an invalid tag: {kind}"
                )))
            }
            Some(_) => {
                return Err(ProductImportPackageError::InvalidManifest(format!(
                    "{member}.kind has an invalid type"
                )))
            }
        }
    }
    if matches!(
        object
            .get("source_alignment_kind")
            .and_then(serde_json::Value::as_str),
        Some("merged_overlap" | "merged_shared_control")
    ) {
        match object.get("source_alignment_inputs") {
            None => missing.push("source_alignment_inputs".to_owned()),
            Some(serde_json::Value::Array(inputs)) if inputs.len() >= 2 => {}
            Some(_) => {
                return Err(ProductImportPackageError::InvalidManifest(
                    "source_alignment_inputs needs at least two identities".to_owned(),
                ))
            }
        }
    } else if object
        .get("source_alignment_kind")
        .and_then(serde_json::Value::as_str)
        == Some("single")
        && object.contains_key("source_alignment_inputs")
    {
        return Err(ProductImportPackageError::InvalidManifest(
            "source_alignment_inputs is inapplicable to a single alignment".to_owned(),
        ));
    }
    if object
        .get("product_kind")
        .and_then(serde_json::Value::as_str)
        == Some("dem")
        && !object.contains_key("dem_facts")
    {
        missing.push("dem_facts".to_owned());
    } else if object
        .get("product_kind")
        .and_then(serde_json::Value::as_str)
        != Some("dem")
        && object.contains_key("dem_facts")
    {
        return Err(ProductImportPackageError::InvalidManifest(
            "dem_facts is inapplicable to this product kind".to_owned(),
        ));
    }
    missing.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    missing.dedup();
    Ok(missing)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    fn fixture() -> ProductImportPackageManifestV1 {
        let lineage = ProductLineageV1 {
            source_project_id: "project-a".into(),
            source_project_fingerprint: ObjectHash::of_bytes(b"project"),
            product_entity_id: "entity-a".into(),
            product_entity_version_hash: ObjectHash::of_bytes(b"version"),
            product_content_hash: ObjectHash::of_bytes(b"content"),
            publication_generation: 7,
            product_kind: "sparse".into(),
            product_label: "Sparse point cloud".into(),
            dataset_label: "Sparse point cloud".into(),
            source_format: "potreeV2".into(),
            normalized_format_id: Some("potree@2".into()),
            source_alignment_kind: ProductLineageAlignmentKindV1::Single,
            source_alignment_entity_id: "alignment-a".into(),
            source_alignment_entity_version_hash: ObjectHash::of_bytes(b"alignment"),
            source_alignment_content_hash: ObjectHash::of_bytes(b"alignment"),
            source_alignment_inputs: None,
            processing_set_choice: ProductLineageProcessingSetChoiceV1::None,
            camera_selection_sha256: ObjectHash::of_bytes(b"cameras"),
            image_mask_scope: ProductLineageMaskScopeV1::None,
            gcp_choice: ProductLineageGcpChoiceV1::None,
            spatial_reference: PhotolabSpatialReference::default(),
            reference_frame: ProductLineageReferenceFrameV1::LocalFrame,
            algorithms: vec![],
            configurations: vec![],
            tools: vec![],
            registration_audit: None,
            dem_facts: None,
        };
        let lineage_bytes = canonical_json::to_vec(&lineage).unwrap();
        let mut manifest = ProductImportPackageManifestV1 {
            schema_id: PRODUCT_IMPORT_PACKAGE_SCHEMA_ID.into(),
            manifest_id: "manifest-a".into(),
            producer: ProductImportPackageProducerV1 {
                product_id: "himmelcad-photolab".into(),
                product_version: "1.0.0".into(),
                build_hash: ObjectHash::of_bytes(b"build"),
                canonical_schema_versions: vec!["hcad.point-cloud@1".into()],
            },
            source: ProductImportPackageSourceV1 {
                project_id: "project-a".into(),
                project_fingerprint: ObjectHash::of_bytes(b"project"),
                publication_generation: 7,
            },
            product: ProductImportPackageProductV1 {
                entity_id: "entity-a".into(),
                entity_version_hash: ObjectHash::of_bytes(b"version"),
                content_hash: ObjectHash::of_bytes(b"content"),
                kind: "sparse".into(),
                label: "Sparse point cloud".into(),
                dataset_label: "Sparse point cloud".into(),
            },
            lineage: ProductImportPackageLineageV1 {
                schema_id: PRODUCT_LINEAGE_SCHEMA_ID.into(),
                lineage_object_sha256: ObjectHash::of_bytes(&lineage_bytes),
                payload: lineage,
            },
            admissions: vec![],
            datasets: vec![],
            resources: vec![],
            artifacts: vec![ProductImportPackageArtifactV1 {
                path: "dataset/metadata.json".into(),
                sha256: ObjectHash::of_bytes(b"{}"),
                byte_length: 2,
                media_type: "application/json".into(),
                role: "dataset".into(),
            }],
            required_features: vec![],
            counts: ProductImportPackageCountsV1 {
                object_count: 0,
                artifact_count: 1,
                total_bytes: 2,
            },
            package_sha256: ObjectHash::of_bytes(b"pending"),
        };
        manifest.package_sha256 = manifest.computed_package_sha256().unwrap();
        manifest
    }

    fn dem_fixture() -> ProductImportPackageManifestV1 {
        let mut manifest = fixture();
        let validity = ProductLineageResourceIdentityV1 {
            resource_id: ObjectHash::of_bytes(b"validity"),
            sha256: ObjectHash::of_bytes(b"validity"),
            byte_length: 1,
            media_type: "application/octet-stream".into(),
        };
        manifest.product.kind = "dem".into();
        manifest.lineage.payload.product_kind = "dem".into();
        manifest.lineage.payload.normalized_format_id =
            Some("himmelcad-prepared-hierarchy@1".into());
        manifest.lineage.payload.dem_facts = Some(PhotoLabDemFactsV1 {
            semantics: "elevationZ".into(),
            interpolation: "bilinear".into(),
            connectivity: ProductLineageDemConnectivityV1::Continuous {
                diagonal: "topLeftToBottomRight".into(),
                maximum_height_jump: None,
            },
            source_no_data: ProductLineageDemSourceNoDataV1::Numeric {
                value: Decimal64::parse("-9999").unwrap(),
            },
            validity: ProductLineageDemValidityV1 {
                resource: validity.clone(),
                encoding: "bitsetLsb0".into(),
            },
        });
        manifest.artifacts.push(ProductImportPackageArtifactV1 {
            path: "dataset/view/validity.bin".into(),
            sha256: validity.sha256.clone(),
            byte_length: validity.byte_length,
            media_type: validity.media_type.clone(),
            role: "dataset".into(),
        });
        manifest.resources.push(ProductImportPackageResourceV1 {
            resource_id: validity.resource_id.0,
            owner_entity_id: "entity-a".into(),
            role: "dem_validity".into(),
            object_path: "dataset/view/validity.bin".into(),
            sha256: validity.sha256,
            byte_length: validity.byte_length,
            media_type: validity.media_type,
        });
        manifest.counts.object_count = 1;
        manifest.counts.artifact_count = 2;
        manifest.counts.total_bytes = 3;
        manifest
    }

    #[test]
    fn manifest_and_package_hash_golden() {
        let manifest = fixture();
        let bytes = canonical_json::to_vec(&manifest).unwrap();
        assert!(String::from_utf8(bytes)
            .unwrap()
            .starts_with(r#"{"admissions":[]"#));
        assert_eq!(
            manifest.package_sha256.as_str(),
            "9e76dc8473f10b9aa57a3e40d2407ace7982e7811bc2b18faa79d56dff75b49d"
        );
    }

    #[test]
    fn publication_identity_derivation_golden() {
        assert_eq!(
            product_publication_id(
                "project-a",
                "entity-a",
                &ObjectHash::of_bytes(b"version"),
                7,
            )
            .unwrap(),
            "product-2d23d41f2de5b361ffca34d6557d08b3a49eced57ae465287561155f0c798669"
        );
    }

    #[test]
    fn frozen_epoch_projects_to_decimal64_without_mutating_model() {
        let model = ProjectReferenceFrame {
            target: crate::photolab_crs::FrozenCrsEndpoint {
                horizontal: crate::photolab_crs::CrsWithEpoch {
                    crs: CrsDefinition::Epsg(7912),
                    coordinate_epoch: Some(crate::photolab_crs::CoordinateEpoch {
                        decimal_year: 2025.25,
                    }),
                },
                vertical: HeightReference::Ellipsoidal,
            },
            established_by_transformation_sha256: ObjectHash::of_bytes(b"transform"),
        };
        let original_bits = model
            .target
            .horizontal
            .coordinate_epoch
            .unwrap()
            .decimal_year
            .to_bits();
        let projected = ProductLineageProjectReferenceFrameV1::from_project(&model).unwrap();
        let bytes = canonical_json::to_vec(&projected).unwrap();
        assert!(String::from_utf8(bytes)
            .unwrap()
            .contains(r#""decimalYear":"2025.25""#));
        assert_eq!(
            model
                .target
                .horizontal
                .coordinate_epoch
                .unwrap()
                .decimal_year
                .to_bits(),
            original_bits
        );
    }

    #[test]
    fn reason_code_precedence_is_closed() {
        assert_eq!(
            select_product_publication_reason_code(true, true, true, false, false, false),
            ProductPublicationReasonCodeV1::UnsupportedFormat
        );
        assert_eq!(
            select_product_publication_reason_code(false, true, true, false, false, false),
            ProductPublicationReasonCodeV1::UnsupportedPackageSchema
        );
        assert_eq!(
            select_product_publication_reason_code(false, false, true, false, false, false),
            ProductPublicationReasonCodeV1::InvalidPackage
        );
        assert_eq!(
            select_product_publication_reason_code(false, false, false, false, false, false),
            ProductPublicationReasonCodeV1::NeedsRepublishRecompute
        );
        assert_eq!(
            select_product_publication_reason_code(false, false, false, true, false, false),
            ProductPublicationReasonCodeV1::NeedsPreparation
        );
        assert_eq!(
            select_product_publication_reason_code(false, false, false, true, true, false),
            ProductPublicationReasonCodeV1::NoPackage
        );
        assert_eq!(
            select_product_publication_reason_code(false, false, false, true, true, true),
            ProductPublicationReasonCodeV1::Available
        );
    }

    #[test]
    fn missing_lineage_ids_use_sorted_dot_and_bracket_paths() {
        let missing = product_lineage_missing_field_ids(&json!({
            "algorithms": [],
            "configurations": [],
            "tools": [{"id": "colmap@4.0"}, {"sha256": ObjectHash::of_bytes(b"tool")}],
            "processing_set_choice": {"kind": "selected", "id": "set"},
            "image_mask_scope": {"kind": "none"},
            "gcp_choice": {"kind": "none"}
        }))
        .unwrap();
        assert!(missing
            .windows(2)
            .all(|pair| pair[0].as_bytes() < pair[1].as_bytes()));
        assert!(missing.contains(&"processing_set_choice.membership_sha256".to_owned()));
        assert!(missing.contains(&"processing_set_choice.version_hash".to_owned()));
        assert!(missing.contains(&"tools[0].sha256".to_owned()));
        assert!(missing.contains(&"tools[1].id".to_owned()));
        assert!(!missing.contains(&"normalized_format_id".to_owned()));
    }

    #[test]
    fn unknown_schema_and_required_feature_fail_closed() {
        let supported_type_ids = BTreeSet::new();
        let mut manifest = fixture();
        manifest.schema_id = "hcad.product-import-package-manifest@2".into();
        let bytes = canonical_json::to_vec(&manifest).unwrap();
        assert_eq!(
            read_product_import_package_manifest(&bytes, &BTreeSet::new(), &supported_type_ids)
                .unwrap_err(),
            ProductImportPackageError::UnsupportedPackageSchema
        );

        let mut manifest = fixture();
        manifest.required_features.push("future.feature@1".into());
        manifest.package_sha256 = manifest.computed_package_sha256().unwrap();
        let bytes = canonical_json::to_vec(&manifest).unwrap();
        assert_eq!(
            read_product_import_package_manifest(&bytes, &BTreeSet::new(), &supported_type_ids)
                .unwrap_err(),
            ProductImportPackageError::UnsupportedPackageSchema
        );

        let mut manifest = fixture();
        manifest.admissions.push(ProductImportPackageAdmissionV1 {
            entity_id: "entity-a".into(),
            type_id: "future.product@1".into(),
            schema_version: 1,
            entity_object_path: "dataset/metadata.json".into(),
            entity_object_sha256: ObjectHash::of_bytes(b"{}"),
            representation_slots: vec![],
        });
        manifest.package_sha256 = manifest.computed_package_sha256().unwrap();
        let bytes = canonical_json::to_vec(&manifest).unwrap();
        assert_eq!(
            read_product_import_package_manifest(&bytes, &BTreeSet::new(), &supported_type_ids)
                .unwrap_err(),
            ProductImportPackageError::UnsupportedPackageSchema
        );
    }

    #[test]
    fn unknown_optional_fields_retain_original_bytes() {
        let manifest = fixture();
        let mut value = serde_json::to_value(&manifest).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("future".into(), json!({"z": 1}));
        let hash = canonical_json::sha256_omitting_member(&value, "package_sha256").unwrap();
        value["package_sha256"] = json!(hash);
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        let retained =
            read_product_import_package_manifest(&bytes, &BTreeSet::new(), &BTreeSet::new())
                .unwrap();
        assert_eq!(retained.original_manifest_bytes, bytes);
    }

    #[test]
    fn rejects_unsafe_duplicate_and_case_folded_paths() {
        for path in ["", "/absolute", "../escape", "a/../b", "a\\b", "a//b"] {
            assert!(validate_relative_posix_path(path).is_err(), "{path:?}");
        }
        let mut manifest = fixture();
        manifest.artifacts.push(ProductImportPackageArtifactV1 {
            path: "dataset/METADATA.json".into(),
            sha256: ObjectHash::of_bytes(b"other"),
            byte_length: 5,
            media_type: "application/json".into(),
            role: "dataset".into(),
        });
        assert!(validate_product_import_package_paths(&manifest).is_err());
        manifest.artifacts[1].path = manifest.artifacts[0].path.clone();
        assert!(validate_product_import_package_paths(&manifest).is_err());
    }

    #[test]
    fn ready_record_writes_package_hash_last() {
        let ready = ProductImportPackageReadyRecordV1 {
            schema_id: PRODUCT_IMPORT_PACKAGE_READY_SCHEMA_ID.into(),
            manifest_id: "manifest-a".into(),
            product_id: "entity-a".into(),
            product_version_hash: ObjectHash::of_bytes(b"version"),
            publication_generation: 7,
            normalized_format_id: "potree@2".into(),
            manifest_sha256: ObjectHash::of_bytes(b"manifest"),
            lineage_object_sha256: ObjectHash::of_bytes(b"lineage"),
            provenance_status: ProvenanceStatus::Complete,
            missing_field_ids: vec![],
            artifact_count: 4,
            object_count: 3,
            total_bytes: 20,
            package_sha256: ObjectHash::of_bytes(b"package"),
        };
        let bytes = serde_json::to_vec(&ready).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.ends_with(&format!(
            r#""package_sha256":"{}"}}"#,
            ready.package_sha256.as_str()
        )));
    }

    #[test]
    fn lineage_tagged_unions_use_snake_case_wire_tags() {
        assert_eq!(
            serde_json::to_value(ProductLineageProcessingSetChoiceV1::AllImportedCameras).unwrap(),
            json!({"kind": "all_imported_cameras"})
        );
        assert_eq!(
            serde_json::to_value(ProductLineageMaskScopeV1::Selected {
                scope_sha256: ObjectHash::of_bytes(b"scope")
            })
            .unwrap()["kind"],
            "selected"
        );
        assert_eq!(
            serde_json::to_value(ProductLineageReferenceFrameV1::LocalFrame).unwrap(),
            json!({"kind": "local_frame"})
        );
    }

    #[test]
    fn dem_facts_are_required_for_dem_packages_and_legacy_lineage_stays_partial() {
        let mut manifest = dem_fixture();
        manifest.lineage.payload.dem_facts = None;
        assert!(matches!(
            validate_product_import_package_paths(&manifest),
            Err(ProductImportPackageError::InvalidManifest(message))
                if message.contains("dem_facts is required")
        ));
        let value = serde_json::to_value(&manifest.lineage.payload).unwrap();
        assert_eq!(
            product_lineage_missing_field_ids(&value).unwrap(),
            vec!["dem_facts".to_owned()]
        );
        let publication = PhotoLabProductPublicationRecordV1 {
            schema_id: PRODUCT_PUBLICATION_SCHEMA_ID.into(),
            publication_id: "legacy-dem-publication".into(),
            product_id: manifest.product.entity_id.clone(),
            product_version_hash: manifest.product.entity_version_hash.clone(),
            product_content_hash: manifest.product.content_hash.clone(),
            publication_generation: manifest.source.publication_generation,
            lineage: manifest.lineage,
            provenance_status: ProvenanceStatus::Partial,
            missing_field_ids: vec!["dem_facts".into()],
            disposition: ProductDatasetDispositionV1::NeedsRepublishRecompute,
            reason_code: ProductPublicationReasonCodeV1::NeedsRepublishRecompute,
            package: None,
        };
        let older: PhotoLabProductPublicationRecordV1 =
            serde_json::from_value(serde_json::to_value(publication).unwrap()).unwrap();
        assert_eq!(older.provenance_status, ProvenanceStatus::Partial);
        assert_eq!(older.missing_field_ids, ["dem_facts"]);
        assert!(older.lineage.payload.dem_facts.is_none());
    }

    #[test]
    fn dem_resource_binding_mismatch_is_rejected() {
        let mut manifest = dem_fixture();
        manifest
            .lineage
            .payload
            .dem_facts
            .as_mut()
            .unwrap()
            .validity
            .resource
            .byte_length = 2;
        assert!(matches!(
            validate_product_import_package_paths(&manifest),
            Err(ProductImportPackageError::InvalidManifest(message))
                if message.contains("DEM validity resource binding disagrees")
        ));
    }

    #[test]
    fn dem_facts_use_the_exact_mixed_case_wire_shape() {
        let resource = ProductLineageResourceIdentityV1 {
            resource_id: ObjectHash::of_bytes(b"validity"),
            sha256: ObjectHash::of_bytes(b"validity"),
            byte_length: 1,
            media_type: "application/octet-stream".into(),
        };
        let value = serde_json::to_value(PhotoLabDemFactsV1 {
            semantics: "elevationZ".into(),
            interpolation: "bilinear".into(),
            connectivity: ProductLineageDemConnectivityV1::Continuous {
                diagonal: "topLeftToBottomRight".into(),
                maximum_height_jump: Some(Decimal64::parse("0.125").unwrap()),
            },
            source_no_data: ProductLineageDemSourceNoDataV1::Numeric {
                value: Decimal64::parse("-9999").unwrap(),
            },
            validity: ProductLineageDemValidityV1 {
                resource,
                encoding: "bitsetLsb0".into(),
            },
        })
        .unwrap();
        assert_eq!(value["connectivity"]["kind"], "continuous");
        assert_eq!(value["connectivity"]["maximumHeightJump"], "0.125");
        assert!(value["connectivity"].get("maximum_height_jump").is_none());
        assert!(value["validity"]["resource"].get("resource_id").is_some());
        assert!(value["validity"]["resource"].get("resourceId").is_none());
    }
}
