//! Canonical PhotoLab product import package wire contracts from ADR 0030.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_json;
use crate::hash::ObjectHash;
use crate::photolab_capture::PhotolabSpatialReference;
use crate::photolab_project::ProjectReferenceFrame;

pub const PRODUCT_IMPORT_PACKAGE_SCHEMA_ID: &str = "hcad.product-import-package-manifest@1";
pub const PRODUCT_LINEAGE_SCHEMA_ID: &str = "hcad.photolab-product-lineage@1";

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
        project_reference_frame: ProjectReferenceFrame,
    },
    LocalFrame,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductLineageIdentityV1 {
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_sha256: Option<ObjectHash>,
}

/// Frozen publication lineage. Optional members are permitted only with `partial` status and an
/// exact entry in the ready record's `missing_field_ids` array.
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
    pub normalized_format_id: String,
    pub source_alignment_entity_id: String,
    pub source_alignment_entity_version_hash: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_alignment_content_hash: Option<ObjectHash>,
    pub processing_set_choice: ProductLineageProcessingSetChoiceV1,
    pub camera_selection_sha256: ObjectHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope: Option<ProductLineageMaskScopeV1>,
    pub gcp_choice: ProductLineageGcpChoiceV1,
    #[serde(rename = "spatialReference")]
    pub spatial_reference: PhotolabSpatialReference,
    pub reference_frame: ProductLineageReferenceFrameV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithms: Option<Vec<ProductLineageIdentityV1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configurations: Option<Vec<ProductLineageIdentityV1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ProductLineageIdentityV1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_audit: Option<serde_json::Value>,
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
    validate_product_import_package_paths(&manifest)?;
    Ok(RetainedProductImportPackageManifestV1 {
        manifest,
        original_manifest_bytes: bytes.to_vec(),
    })
}

pub fn validate_product_import_package_paths(
    manifest: &ProductImportPackageManifestV1,
) -> Result<(), ProductImportPackageError> {
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
        if resource.media_type.trim().is_empty() || !resource_paths.insert(&resource.object_path) {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "invalid or duplicate resource path: {}",
                resource.object_path
            )));
        }
        validate_declared_reference(&exact, &resource.object_path)?;
    }
    let mut dataset_paths = BTreeSet::new();
    for dataset in &manifest.datasets {
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
    }
    for artifact in &manifest.artifacts {
        if artifact.media_type.trim().is_empty() {
            return Err(ProductImportPackageError::InvalidManifest(format!(
                "artifact media_type is empty: {}",
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
            normalized_format_id: "potree@2".into(),
            source_alignment_entity_id: "alignment-a".into(),
            source_alignment_entity_version_hash: ObjectHash::of_bytes(b"alignment"),
            source_alignment_content_hash: Some(ObjectHash::of_bytes(b"alignment")),
            processing_set_choice: ProductLineageProcessingSetChoiceV1::None,
            camera_selection_sha256: ObjectHash::of_bytes(b"cameras"),
            image_mask_scope: Some(ProductLineageMaskScopeV1::None),
            gcp_choice: ProductLineageGcpChoiceV1::None,
            spatial_reference: PhotolabSpatialReference::default(),
            reference_frame: ProductLineageReferenceFrameV1::LocalFrame,
            algorithms: Some(vec![]),
            configurations: Some(vec![]),
            tools: Some(vec![]),
            registration_audit: None,
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
                role: "dataset_root".into(),
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

    #[test]
    fn manifest_and_package_hash_golden() {
        let manifest = fixture();
        let bytes = canonical_json::to_vec(&manifest).unwrap();
        assert!(String::from_utf8(bytes)
            .unwrap()
            .starts_with(r#"{"admissions":[]"#));
        assert_eq!(
            manifest.package_sha256.as_str(),
            "5312b8a94c1aaffeb505acbc8046a3dc14b60c4b4af5369c6f5c807e0a001320"
        );
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
            schema_id: PRODUCT_IMPORT_PACKAGE_SCHEMA_ID.into(),
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
}
