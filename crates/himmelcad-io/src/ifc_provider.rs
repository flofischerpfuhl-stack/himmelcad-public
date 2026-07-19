//! Canonical IFC2X3/IFC4/IFC4.3 STEP provider with exact-source authority.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::canonical_resources::{
    BimClassificationComponent, BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID,
};
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, AreaGeometry, BimClassification, CanonicalEntity, CurveGeometry, CurveLoop,
    CurveUse, EntityTypeId, GeometryObject, GeometryResource, Position, Representation,
    RepresentationAuthority, RepresentationRole, SolidGeometry, Transform3d, TriangleMeshGeometry,
    TriangleMeshStorage, Vector3,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::canonical_provider::{
    CanonicalExportPlan, CanonicalExportProvider, CanonicalExportRequest, CanonicalImportPackage,
    CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject, CanonicalResourceSet,
    ExportOutput, FormatCapability, FormatProviderDescriptor, ImportProbe, ImportProbeRequest,
    PreparedResourceArtifact, ProviderContractError, ProviderOperationContext, ProviderProgress,
    CANONICAL_IO_SCHEMA_VERSION,
};
use crate::ifc_step::{StepError, StepIndex, StepRecord, StepValue};

/// Stable canonical IFC provider identity.
pub const IFC_PROVIDER_ID: &str = "hcad.io.ifc-spf@1";
/// Exact IFC2X3 STEP format identity.
pub const IFC2X3_FORMAT_ID: &str = "hcad.format.ifc2x3-spf@1";
/// Exact IFC4 STEP format identity.
pub const IFC4_FORMAT_ID: &str = "hcad.format.ifc4-spf@1";
/// Exact IFC4.3 STEP format identity.
pub const IFC4X3_FORMAT_ID: &str = "hcad.format.ifc4x3-spf@1";
/// Explicit acceptance required when geometry remains source-only.
pub const LOSS_UNSUPPORTED_GEOMETRY: &str = "hcad.loss.ifc.unsupported-geometry@1";
/// Synthetic export is deliberately unavailable.
pub const LOSS_NOT_EXACT_SOURCE: &str = "hcad.loss.ifc.not-exact-source@1";

const IFC_MEDIA_TYPE: &str = "application/x-step";
const SOURCE_EXTENSION_TYPE: &str = "hcad.geometry.ifc-spf-record@1";
const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_PRODUCTS: usize = 2_000_000;
const MAX_VERTICES_PER_PRODUCT: usize = 25_000_000;
const MAX_TRIANGLES_PER_PRODUCT: usize = 25_000_000;

/// Production IFC provider. The resource root is caller-owned staging storage.
pub struct IfcCanonicalProvider {
    descriptor: FormatProviderDescriptor,
    resource_root: PathBuf,
}

impl IfcCanonicalProvider {
    /// Creates an IFC provider that publishes immutable source artifacts below `resource_root`.
    #[must_use]
    pub fn new(resource_root: PathBuf) -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: IFC_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "Industry Foundation Classes (IFC2X3 / IFC4 / IFC4.3 STEP)"
                    .to_owned(),
                format_ids: vec![
                    IFC2X3_FORMAT_ID.to_owned(),
                    IFC4_FORMAT_ID.to_owned(),
                    IFC4X3_FORMAT_ID.to_owned(),
                ],
                extensions: vec!["ifc".to_owned()],
                media_types: vec![IFC_MEDIA_TYPE.to_owned()],
                capabilities: vec![FormatCapability::Import, FormatCapability::Export],
            },
            resource_root,
        }
    }
}

impl Default for IfcCanonicalProvider {
    fn default() -> Self {
        Self::new(std::env::temp_dir().join("himmelcad-ifc-resources"))
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct IfcImportOptions {
    accepted_loss_codes: BTreeSet<String>,
    import_namespace: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct IfcExportOptions {
    accepted_loss_codes: BTreeSet<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceComponent<'a> {
    schema_id: &'static str,
    schema: &'a str,
    step_id: u64,
    entity_type: &'a str,
    global_id: Option<&'a str>,
    source_resource: &'a GeometryResource,
}

#[derive(Debug)]
struct Product {
    step_id: u64,
    global_id: Option<String>,
    entity_type: String,
    name: String,
    owner_step_id: Option<u64>,
    placement: Transform3d,
    representation: Option<u64>,
    body: Option<GeometryObject>,
    unsupported_geometry: Vec<String>,
    properties: Vec<serde_json::Value>,
    classifications: Vec<serde_json::Value>,
}

#[derive(Debug)]
struct StagedSource {
    resource: GeometryResource,
    relative_path: PathBuf,
}

impl CanonicalImportProvider for IfcCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let extension = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("ifc"));
        let prefix = String::from_utf8_lossy(request.prefix).to_ascii_uppercase();
        let magic = prefix.contains("ISO-10303-21") && prefix.contains("FILE_SCHEMA");
        if !extension && !magic {
            return Ok(None);
        }
        let format_id = if prefix.contains("IFC4X3") {
            IFC4X3_FORMAT_ID
        } else if prefix.contains("IFC2X3") {
            IFC2X3_FORMAT_ID
        } else {
            IFC4_FORMAT_ID
        };
        Ok(Some(ImportProbe {
            format_id: format_id.to_owned(),
            confidence: if magic { 99 } else { 50 },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if !matches!(
            request.format_id,
            IFC2X3_FORMAT_ID | IFC4_FORMAT_ID | IFC4X3_FORMAT_ID
        ) {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: IfcImportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        let namespace = options.import_namespace.as_deref().unwrap_or("default");
        if namespace.trim().is_empty() || namespace.contains('\0') {
            return Err(provider_message("invalid IFC importNamespace"));
        }
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "index".to_owned(),
            completed: 0,
            total: fs::metadata(request.source).ok().map(|value| value.len()),
            message: "IFC STEP records werden bounded und lazy indexiert".to_owned(),
        });
        let index =
            StepIndex::build(request.source, || context.is_cancelled()).map_err(step_error)?;
        let expected_format = if index.schema.starts_with("IFC4X3") {
            IFC4X3_FORMAT_ID
        } else if index.schema == "IFC2X3" {
            IFC2X3_FORMAT_ID
        } else {
            IFC4_FORMAT_ID
        };
        if expected_format != request.format_id {
            return Err(provider_message(
                "probed IFC schema differs from execution format",
            ));
        }
        context.report_progress(ProviderProgress {
            phase: "index".to_owned(),
            completed: index.byte_length,
            total: Some(index.byte_length),
            message: format!("{} IFC records indexiert", index.records.len()),
        });
        let staged = stage_source(request.source, &self.resource_root, context)?;
        let mut products = map_products(&index, context)?;
        let unsupported = products
            .iter()
            .flat_map(|product| product.unsupported_geometry.iter())
            .next()
            .is_some();
        if unsupported
            && !options
                .accepted_loss_codes
                .contains(LOSS_UNSUPPORTED_GEOMETRY)
        {
            return Err(provider_message(format!(
                "IFC contains geometry outside the exact decoded subset; explicitly accept {LOSS_UNSUPPORTED_GEOMETRY} to retain it as source-authoritative ImportedFallback"
            )));
        }
        let package = build_package(request.source, &index, namespace, &staged, &mut products)?;
        package.validate()?;
        context.report_progress(ProviderProgress {
            phase: "admit".to_owned(),
            completed: products.len() as u64,
            total: Some(products.len() as u64),
            message: "IFC BIM entities und exakte Source-Authority sind validiert".to_owned(),
        });
        Ok(package)
    }
}

impl CanonicalExportProvider for IfcCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn plan_export(
        &self,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError> {
        if !matches!(
            request.format_id,
            IFC2X3_FORMAT_ID | IFC4_FORMAT_ID | IFC4X3_FORMAT_ID
        ) {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: IfcExportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        let exact = exact_source_artifact(request.package).is_some();
        let losses = if exact {
            Vec::new()
        } else {
            vec![LOSS_NOT_EXACT_SOURCE.to_owned()]
        };
        if losses
            .iter()
            .any(|loss| !options.accepted_loss_codes.contains(loss))
        {
            return Err(provider_message(
                "edited/synthetic IFC export is unavailable; exact source passthrough guard failed",
            ));
        }
        Ok(CanonicalExportPlan {
            format_id: request.format_id.to_owned(),
            outputs: vec![ExportOutput {
                relative_path: PathBuf::from(
                    request
                        .target
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("model.ifc"),
                ),
                media_type: IFC_MEDIA_TYPE.to_owned(),
            }],
            semantic_losses: losses,
        })
    }

    fn export(
        &self,
        request: CanonicalExportRequest<'_>,
        plan: &CanonicalExportPlan,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<(), ProviderContractError> {
        if !plan.semantic_losses.is_empty() {
            return Err(provider_message(
                "no lossy synthetic IFC writer is implemented",
            ));
        }
        let artifact = exact_source_artifact(request.package)
            .ok_or_else(|| provider_message("exact IFC source guard failed"))?;
        let source = self.resource_root.join(&artifact.relative_path);
        copy_verified(&source, request.target, &artifact.resource, context)
    }
}

fn map_products(
    index: &StepIndex,
    context: &mut dyn ProviderOperationContext,
) -> Result<Vec<Product>, ProviderContractError> {
    let ownership = ownership_map(index)?;
    let semantics = semantic_maps(index)?;
    let mut output = Vec::new();
    for (&id, location) in &index.records {
        if output.len() >= MAX_PRODUCTS {
            return Err(provider_message("IFC product budget exceeded"));
        }
        if !is_product_candidate(&location.entity_type) {
            continue;
        }
        check_cancelled(context)?;
        let record = index.record(id).map_err(step_error)?;
        let representation = direct_reference_of_type(index, &record, "IFCPRODUCTDEFINITIONSHAPE");
        let placement_id = direct_reference_of_type(index, &record, "IFCLOCALPLACEMENT");
        let likely_product =
            ownership.contains_key(&id) || representation.is_some() || placement_id.is_some();
        let Some(global_id) = record.arguments.first().and_then(string_value) else {
            continue;
        };
        if !valid_global_id(global_id) {
            if likely_product {
                return Err(provider_message("invalid IfcRoot GlobalId"));
            }
            continue;
        }
        let placement = placement_id
            .map(|placement| resolve_local_placement(index, placement, &mut BTreeSet::new()))
            .transpose()?
            .unwrap_or(Transform3d::IDENTITY);
        let mut unsupported_geometry = Vec::new();
        let body = if let Some(representation) = representation {
            let mapped = representation_body(index, representation)?;
            unsupported_geometry = mapped.unsupported;
            mapped.geometry
        } else {
            None
        };
        output.push(Product {
            step_id: id,
            global_id: Some(global_id.to_owned()),
            entity_type: record.entity_type,
            name: record
                .arguments
                .get(2)
                .and_then(string_value)
                .unwrap_or(location.entity_type.as_str())
                .to_owned(),
            owner_step_id: ownership.get(&id).copied(),
            placement,
            representation,
            body,
            unsupported_geometry,
            properties: semantics.properties.get(&id).cloned().unwrap_or_default(),
            classifications: semantics
                .classifications
                .get(&id)
                .cloned()
                .unwrap_or_default(),
        });
        if output.len() % 1000 == 0 {
            context.report_progress(ProviderProgress {
                phase: "decode".to_owned(),
                completed: output.len() as u64,
                total: None,
                message: "IFC Produkte, Placements und Repräsentationen werden aufgelöst"
                    .to_owned(),
            });
        }
    }
    if output.is_empty() {
        return Err(provider_message(
            "IFC contains no supported IfcRoot products",
        ));
    }
    Ok(output)
}

fn is_product_candidate(entity_type: &str) -> bool {
    entity_type.starts_with("IFC")
        && !entity_type.starts_with("IFCREL")
        && !entity_type.starts_with("IFCPROPERTY")
        && !entity_type.starts_with("IFCQUANTITY")
        && !entity_type.starts_with("IFCCLASSIFICATION")
        && !entity_type.starts_with("IFCMATERIAL")
        && !entity_type.starts_with("IFCPRESENTATION")
        && !entity_type.starts_with("IFCSTYLE")
        && !matches!(
            entity_type,
            "IFCOWNERHISTORY"
                | "IFCPROJECT"
                | "IFCAPPLICATION"
                | "IFCPERSON"
                | "IFCORGANIZATION"
                | "IFCPERSONANDORGANIZATION"
        )
}

fn direct_reference_of_type(index: &StepIndex, record: &StepRecord, wanted: &str) -> Option<u64> {
    record
        .arguments
        .iter()
        .filter_map(reference_value)
        .find(|id| {
            index
                .records
                .get(id)
                .is_some_and(|location| location.entity_type == wanted)
        })
}

fn ownership_map(index: &StepIndex) -> Result<BTreeMap<u64, u64>, ProviderContractError> {
    let mut result = BTreeMap::new();
    for relation_type in ["IFCRELCONTAINEDINSPATIALSTRUCTURE", "IFCRELAGGREGATES"] {
        for id in index.ids_of_type(relation_type) {
            let record = index.record(id).map_err(step_error)?;
            let (related_index, owner_index) = if relation_type == "IFCRELAGGREGATES" {
                (5, 4)
            } else {
                (4, 5)
            };
            let Some(owner) = record.arguments.get(owner_index).and_then(reference_value) else {
                continue;
            };
            if let Some(StepValue::List(related)) = record.arguments.get(related_index) {
                for child in related.iter().filter_map(reference_value) {
                    result.entry(child).or_insert(owner);
                }
            }
        }
    }
    Ok(result)
}

#[derive(Default)]
struct SemanticMaps {
    properties: BTreeMap<u64, Vec<serde_json::Value>>,
    classifications: BTreeMap<u64, Vec<serde_json::Value>>,
}

fn semantic_maps(index: &StepIndex) -> Result<SemanticMaps, ProviderContractError> {
    let mut result = SemanticMaps::default();
    for relation_id in index.ids_of_type("IFCRELDEFINESBYPROPERTIES") {
        let relation = index.record(relation_id).map_err(step_error)?;
        let related = relation
            .arguments
            .get(4)
            .and_then(list_references)
            .unwrap_or_default();
        let Some(property_definition) = relation.arguments.get(5).and_then(reference_value) else {
            continue;
        };
        let value = property_definition_json(index, property_definition)?;
        for product in related {
            result
                .properties
                .entry(product)
                .or_default()
                .push(value.clone());
        }
    }
    for relation_id in index.ids_of_type("IFCRELASSOCIATESCLASSIFICATION") {
        let relation = index.record(relation_id).map_err(step_error)?;
        let related = relation
            .arguments
            .get(4)
            .and_then(list_references)
            .unwrap_or_default();
        let Some(classification) = relation.arguments.get(5).and_then(reference_value) else {
            continue;
        };
        let record = index.record(classification).map_err(step_error)?;
        let value = serde_json::json!({
            "stepId": classification,
            "entityType": record.entity_type,
            "location": record.arguments.first().and_then(string_value),
            "identification": record.arguments.get(1).and_then(string_value),
            "name": record.arguments.get(2).and_then(string_value),
            "source": record.arguments.get(3).and_then(reference_value),
            "exactArguments": record.arguments.iter().map(step_value_json).collect::<Vec<_>>(),
        });
        for product in related {
            result
                .classifications
                .entry(product)
                .or_default()
                .push(value.clone());
        }
    }
    Ok(result)
}

fn property_definition_json(
    index: &StepIndex,
    id: u64,
) -> Result<serde_json::Value, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    let property_refs = record
        .arguments
        .iter()
        .rev()
        .find_map(list_references)
        .unwrap_or_default();
    let mut properties = Vec::with_capacity(property_refs.len());
    for property_id in property_refs {
        let property = index.record(property_id).map_err(step_error)?;
        properties.push(serde_json::json!({
            "stepId": property_id,
            "entityType": property.entity_type,
            "name": property.arguments.first().and_then(string_value),
            "description": property.arguments.get(1).and_then(string_value),
            "value": property.arguments.get(2).map(step_value_json),
            "unitStepId": property.arguments.get(3).and_then(reference_value),
            "exactArguments": property.arguments.iter().map(step_value_json).collect::<Vec<_>>(),
        }));
    }
    Ok(serde_json::json!({
        "stepId": id,
        "entityType": record.entity_type,
        "globalId": record.arguments.first().and_then(string_value),
        "name": record.arguments.get(2).and_then(string_value),
        "properties": properties,
    }))
}

fn step_value_json(value: &StepValue) -> serde_json::Value {
    match value {
        StepValue::Null => serde_json::Value::Null,
        StepValue::Omitted => serde_json::json!({ "omitted": true }),
        StepValue::Ref(value) => serde_json::json!({ "stepRef": value }),
        StepValue::Integer(value) => serde_json::json!(value),
        StepValue::Real(value) => serde_json::json!(value),
        StepValue::String(value) => serde_json::json!(value),
        StepValue::Enum(value) => serde_json::json!({ "enum": value }),
        StepValue::List(values) => {
            serde_json::Value::Array(values.iter().map(step_value_json).collect())
        }
        StepValue::Typed(kind, value) => {
            serde_json::json!({ "type": kind, "value": step_value_json(value) })
        }
    }
}

#[derive(Default)]
struct MeshBuild {
    positions: Vec<Vector3>,
    indices: Vec<u32>,
    unsupported: Vec<String>,
}

struct BodyBuild {
    geometry: Option<GeometryObject>,
    unsupported: Vec<String>,
}

fn representation_body(index: &StepIndex, id: u64) -> Result<BodyBuild, ProviderContractError> {
    let items = representation_items(index, id)?;
    if items.len() == 1
        && index
            .records
            .get(&items[0])
            .is_some_and(|location| location.entity_type == "IFCEXTRUDEDAREASOLID")
    {
        return Ok(BodyBuild {
            geometry: Some(extruded_area_solid(index, items[0])?),
            unsupported: Vec::new(),
        });
    }
    let mapped = representation_mesh_from_items(index, &items)?;
    let geometry = (mapped.unsupported.is_empty() && !mapped.indices.is_empty()).then(|| {
        GeometryObject::Surface3d {
            mesh: Box::new(TriangleMeshGeometry {
                storage: TriangleMeshStorage::Inline {
                    positions: mapped.positions,
                    indices: mapped.indices,
                    normals: None,
                    texture_coordinates: None,
                },
                closed_manifold: false,
                triangle_material_slots: None,
                materials: None,
            }),
        }
    });
    Ok(BodyBuild {
        geometry,
        unsupported: mapped.unsupported,
    })
}

fn representation_items(index: &StepIndex, id: u64) -> Result<Vec<u64>, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    let mut output = Vec::new();
    let representations = record
        .arguments
        .iter()
        .find_map(list_references)
        .unwrap_or_default();
    for representation in representations {
        let shape = index.record(representation).map_err(step_error)?;
        output.extend(
            shape
                .arguments
                .iter()
                .rev()
                .find_map(list_references)
                .unwrap_or_default(),
        );
    }
    Ok(output)
}

fn representation_mesh_from_items(
    index: &StepIndex,
    items: &[u64],
) -> Result<MeshBuild, ProviderContractError> {
    let mut mesh = MeshBuild::default();
    for &item in items {
        append_item(
            index,
            item,
            Transform3d::IDENTITY,
            &mut mesh,
            &mut BTreeSet::new(),
        )?;
    }
    Ok(mesh)
}

fn extruded_area_solid(
    index: &StepIndex,
    id: u64,
) -> Result<GeometryObject, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    let profile_id = record
        .arguments
        .first()
        .and_then(reference_value)
        .ok_or_else(|| provider_message("IfcExtrudedAreaSolid profile missing"))?;
    let solid_placement = record
        .arguments
        .get(1)
        .and_then(reference_value)
        .map(|value| axis_placement(index, value))
        .transpose()?
        .unwrap_or(Transform3d::IDENTITY);
    let direction_id = record
        .arguments
        .get(2)
        .and_then(reference_value)
        .ok_or_else(|| provider_message("IfcExtrudedAreaSolid direction missing"))?;
    let depth = record
        .arguments
        .get(3)
        .map(number)
        .transpose()?
        .filter(|value| *value > 0.0)
        .ok_or_else(|| provider_message("IfcExtrudedAreaSolid depth must be positive"))?;
    let direction = direction(index, direction_id)?;
    let direction = transform_vector(
        solid_placement,
        Vector3 {
            x: direction.x * depth,
            y: direction.y * depth,
            z: direction.z * depth,
        },
    );
    let profile = area_profile(index, profile_id, solid_placement)?;
    Ok(GeometryObject::Solid {
        solid: Box::new(SolidGeometry::Extrusion { profile, direction }),
    })
}

fn area_profile(
    index: &StepIndex,
    id: u64,
    solid_placement: Transform3d,
) -> Result<AreaGeometry, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    let local = match record.entity_type.as_str() {
        "IFCRECTANGLEPROFILEDEF" => {
            let profile_placement = record
                .arguments
                .get(2)
                .and_then(reference_value)
                .map(|value| axis_placement_2d(index, value))
                .transpose()?
                .unwrap_or(Transform3d::IDENTITY);
            let x = record
                .arguments
                .get(3)
                .map(number)
                .transpose()?
                .filter(|value| *value > 0.0)
                .ok_or_else(|| provider_message("IFC rectangle XDim invalid"))?;
            let y = record
                .arguments
                .get(4)
                .map(number)
                .transpose()?
                .filter(|value| *value > 0.0)
                .ok_or_else(|| provider_message("IFC rectangle YDim invalid"))?;
            let half_x = x * 0.5;
            let half_y = y * 0.5;
            (
                vec![
                    Vector3 {
                        x: -half_x,
                        y: -half_y,
                        z: 0.0,
                    },
                    Vector3 {
                        x: half_x,
                        y: -half_y,
                        z: 0.0,
                    },
                    Vector3 {
                        x: half_x,
                        y: half_y,
                        z: 0.0,
                    },
                    Vector3 {
                        x: -half_x,
                        y: half_y,
                        z: 0.0,
                    },
                ],
                profile_placement,
            )
        }
        "IFCARBITRARYCLOSEDPROFILEDEF" => {
            let curve = record
                .arguments
                .get(2)
                .and_then(reference_value)
                .ok_or_else(|| provider_message("IFC arbitrary profile curve missing"))?;
            (polyline_points(index, curve)?, Transform3d::IDENTITY)
        }
        _ => return Err(provider_message("unsupported IFC area profile")),
    };
    let placement = multiply(solid_placement, local.1);
    let positions = local
        .0
        .into_iter()
        .map(|point| {
            let point = transform_point(placement, point);
            Position {
                x: point.x,
                y: point.y,
                z: Some(point.z),
            }
        })
        .collect();
    Ok(AreaGeometry {
        outer: CurveLoop {
            uses: vec![CurveUse::Inline {
                curve: CurveGeometry::Polyline {
                    positions,
                    closed: true,
                },
                reversed: false,
            }],
        },
        holes: Vec::new(),
    })
}

fn polyline_points(index: &StepIndex, id: u64) -> Result<Vec<Vector3>, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCPOLYLINE" {
        return Err(provider_message(
            "only IfcPolyline arbitrary profiles are supported",
        ));
    }
    let refs = record
        .arguments
        .first()
        .and_then(list_references)
        .ok_or_else(|| provider_message("IFC profile polyline points missing"))?;
    if refs.len() < 3 {
        return Err(provider_message(
            "IFC profile polyline requires three points",
        ));
    }
    let mut points = refs
        .into_iter()
        .map(|point| cartesian_point(index, point))
        .collect::<Result<Vec<_>, _>>()?;
    if points.first() == points.last() {
        points.pop();
    }
    Ok(points)
}

fn axis_placement_2d(index: &StepIndex, id: u64) -> Result<Transform3d, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCAXIS2PLACEMENT2D" {
        return Err(provider_message("expected IfcAxis2Placement2D"));
    }
    let origin = record
        .arguments
        .first()
        .and_then(reference_value)
        .map(|value| cartesian_point(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        });
    let x = record
        .arguments
        .get(1)
        .and_then(reference_value)
        .map(|value| direction(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
    let x = normalized(Vector3 {
        x: x.x,
        y: x.y,
        z: 0.0,
    })?;
    let y = Vector3 {
        x: -x.y,
        y: x.x,
        z: 0.0,
    };
    Ok(Transform3d([
        x.x, x.y, 0.0, 0.0, y.x, y.y, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, origin.x, origin.y, origin.z,
        1.0,
    ]))
}

fn append_item(
    index: &StepIndex,
    id: u64,
    transform: Transform3d,
    mesh: &mut MeshBuild,
    active: &mut BTreeSet<u64>,
) -> Result<(), ProviderContractError> {
    if !active.insert(id) {
        return Err(provider_message("recursive IFC representation map"));
    }
    let record = index.record(id).map_err(step_error)?;
    match record.entity_type.as_str() {
        "IFCTRIANGULATEDFACESET" => append_triangulated(index, &record, transform, mesh)?,
        "IFCPOLYGONALFACESET" => append_polygonal(index, &record, transform, mesh)?,
        "IFCFACETEDBREP" => append_faceted_brep(index, &record, transform, mesh)?,
        "IFCMAPPEDITEM" => {
            let source = record
                .arguments
                .first()
                .and_then(reference_value)
                .ok_or_else(|| provider_message("IfcMappedItem.MappingSource is missing"))?;
            let target = record
                .arguments
                .get(1)
                .and_then(reference_value)
                .ok_or_else(|| provider_message("IfcMappedItem.MappingTarget is missing"))?;
            let source_record = index.record(source).map_err(step_error)?;
            if source_record.entity_type != "IFCREPRESENTATIONMAP" {
                return Err(provider_message(
                    "IfcMappedItem source is not a representation map",
                ));
            }
            let origin = source_record
                .arguments
                .first()
                .and_then(reference_value)
                .map(|value| axis_placement(index, value))
                .transpose()?
                .unwrap_or(Transform3d::IDENTITY);
            let target = transformation_operator(index, target)?;
            let mapped = multiply(transform, multiply(target, inverse_rigid(origin)?));
            let representation = source_record
                .arguments
                .get(1)
                .and_then(reference_value)
                .ok_or_else(|| provider_message("IfcRepresentationMap mapping is missing"))?;
            let representation = index.record(representation).map_err(step_error)?;
            let items = representation
                .arguments
                .iter()
                .rev()
                .find_map(list_references)
                .unwrap_or_default();
            for item in items {
                append_item(index, item, mapped, mesh, active)?;
            }
        }
        unsupported => mesh.unsupported.push(unsupported.to_owned()),
    }
    active.remove(&id);
    Ok(())
}

fn append_faceted_brep(
    index: &StepIndex,
    record: &StepRecord,
    transform: Transform3d,
    mesh: &mut MeshBuild,
) -> Result<(), ProviderContractError> {
    let shell_id = record
        .arguments
        .first()
        .and_then(reference_value)
        .ok_or_else(|| provider_message("IfcFacetedBrep outer shell is missing"))?;
    let shell = index.record(shell_id).map_err(step_error)?;
    if shell.entity_type != "IFCCLOSEDSHELL" {
        return Err(provider_message(
            "IfcFacetedBrep requires an IfcClosedShell",
        ));
    }
    let face_refs = shell
        .arguments
        .first()
        .and_then(list_references)
        .ok_or_else(|| provider_message("IfcClosedShell faces are missing"))?;
    for face_id in face_refs {
        let face = index.record(face_id).map_err(step_error)?;
        if face.entity_type != "IFCFACE" {
            return Err(provider_message("IfcClosedShell contains a non-face item"));
        }
        let bound_refs = face
            .arguments
            .first()
            .and_then(list_references)
            .ok_or_else(|| provider_message("IfcFace bounds are missing"))?;
        if bound_refs.len() != 1 {
            // Holes require constrained triangulation. Retain exact source authority
            // instead of silently filling an inner bound.
            mesh.unsupported.push("IFCFACEBOUND".to_owned());
            continue;
        }
        let bound = index.record(bound_refs[0]).map_err(step_error)?;
        if bound.entity_type != "IFCFACEOUTERBOUND" {
            mesh.unsupported.push(bound.entity_type);
            continue;
        }
        let loop_id = bound
            .arguments
            .first()
            .and_then(reference_value)
            .ok_or_else(|| provider_message("IfcFaceOuterBound loop is missing"))?;
        let polygon_loop = index.record(loop_id).map_err(step_error)?;
        if polygon_loop.entity_type != "IFCPOLYLOOP" {
            mesh.unsupported.push(polygon_loop.entity_type);
            continue;
        }
        let point_refs = polygon_loop
            .arguments
            .first()
            .and_then(list_references)
            .ok_or_else(|| provider_message("IfcPolyLoop points are missing"))?;
        let mut points = point_refs
            .into_iter()
            .map(|point_id| cartesian_point(index, point_id))
            .collect::<Result<Vec<_>, _>>()?;
        if points.first() == points.last() {
            points.pop();
        }
        let mut polygon = (0..points.len()).collect::<Vec<_>>();
        if matches!(bound.arguments.get(1), Some(StepValue::Enum(value)) if value == "F") {
            polygon.reverse();
        }
        ensure_mesh_budget(mesh, points.len(), points.len().saturating_sub(2))?;
        let base = u32::try_from(mesh.positions.len())
            .map_err(|_| provider_message("IFC vertex index overflow"))?;
        let triangles = match triangulate_planar_polygon(&points, &polygon) {
            Ok(triangles) => triangles,
            Err(_) => {
                // A malformed or non-planar loop is not safe to fan-fill. Mark
                // only this product as source-authoritative fallback so one bad
                // Revit face cannot abort every other exact IFC entity.
                mesh.unsupported.push("IFCPOLYLOOP".to_owned());
                continue;
            }
        };
        mesh.positions.extend(
            points
                .into_iter()
                .map(|point| transform_point(transform, point)),
        );
        for [a, b, c] in triangles {
            mesh.indices.extend([base + a, base + b, base + c]);
        }
    }
    Ok(())
}

fn append_triangulated(
    index: &StepIndex,
    record: &StepRecord,
    transform: Transform3d,
    mesh: &mut MeshBuild,
) -> Result<(), ProviderContractError> {
    let coordinate_ref = record
        .arguments
        .first()
        .and_then(reference_value)
        .ok_or_else(|| provider_message("IfcTriangulatedFaceSet coordinates missing"))?;
    let coordinates = cartesian_point_list(index, coordinate_ref)?;
    let coord_index = record
        .arguments
        .get(3)
        .and_then(list_values)
        .ok_or_else(|| provider_message("IfcTriangulatedFaceSet CoordIndex missing"))?;
    let pn_index = record.arguments.get(4).and_then(list_values);
    let base = u32::try_from(mesh.positions.len())
        .map_err(|_| provider_message("IFC vertex index overflow"))?;
    ensure_mesh_budget(mesh, coordinates.len(), coord_index.len())?;
    mesh.positions.extend(
        coordinates
            .into_iter()
            .map(|value| transform_point(transform, value)),
    );
    for triangle in coord_index {
        let values = list_values(triangle)
            .ok_or_else(|| provider_message("IFC triangle index is not a list"))?;
        if values.len() != 3 {
            return Err(provider_message(
                "IFC triangle must have exactly three indices",
            ));
        }
        for value in values {
            let mut index_value = positive_index(value)?;
            if let Some(pn) = pn_index {
                index_value = positive_index(
                    pn.get(index_value)
                        .ok_or_else(|| provider_message("IFC PnIndex out of bounds"))?,
                )?;
            }
            if index_value >= mesh.positions.len() - usize::try_from(base).unwrap_or(0) {
                return Err(provider_message("IFC CoordIndex out of bounds"));
            }
            mesh.indices
                .push(base + u32::try_from(index_value).map_err(provider_error)?);
        }
    }
    Ok(())
}

fn append_polygonal(
    index: &StepIndex,
    record: &StepRecord,
    transform: Transform3d,
    mesh: &mut MeshBuild,
) -> Result<(), ProviderContractError> {
    let coordinate_ref = record
        .arguments
        .first()
        .and_then(reference_value)
        .ok_or_else(|| provider_message("IfcPolygonalFaceSet coordinates missing"))?;
    let coordinates = cartesian_point_list(index, coordinate_ref)?;
    let face_refs = record
        .arguments
        .get(2)
        .and_then(list_references)
        .ok_or_else(|| provider_message("IfcPolygonalFaceSet faces missing"))?;
    let pn_index = record.arguments.get(3).and_then(list_values);
    let base = u32::try_from(mesh.positions.len())
        .map_err(|_| provider_message("IFC vertex index overflow"))?;
    ensure_mesh_budget(mesh, coordinates.len(), face_refs.len().saturating_mul(4))?;
    mesh.positions.extend(
        coordinates
            .iter()
            .copied()
            .map(|value| transform_point(transform, value)),
    );
    for face_ref in face_refs {
        let face = index.record(face_ref).map_err(step_error)?;
        if face.entity_type == "IFCINDEXEDPOLYGONALFACEWITHVOIDS" {
            mesh.unsupported.push(face.entity_type);
            continue;
        }
        if face.entity_type != "IFCINDEXEDPOLYGONALFACE" {
            return Err(provider_message("invalid IFC polygon face reference"));
        }
        let values = face
            .arguments
            .first()
            .and_then(list_values)
            .ok_or_else(|| provider_message("IFC polygon indices missing"))?;
        let mut polygon = Vec::with_capacity(values.len());
        for value in values {
            let mut value = positive_index(value)?;
            if let Some(pn) = pn_index {
                value = positive_index(
                    pn.get(value)
                        .ok_or_else(|| provider_message("IFC PnIndex out of bounds"))?,
                )?;
            }
            if value >= coordinates.len() {
                return Err(provider_message("IFC polygon index out of bounds"));
            }
            polygon.push(value);
        }
        for [a, b, c] in triangulate_planar_polygon(&coordinates, &polygon)? {
            mesh.indices.extend([base + a, base + b, base + c]);
        }
    }
    Ok(())
}

fn triangulate_planar_polygon(
    points: &[Vector3],
    polygon: &[usize],
) -> Result<Vec<[u32; 3]>, ProviderContractError> {
    if polygon.len() < 3 {
        return Err(provider_message(
            "IFC polygon has fewer than three vertices",
        ));
    }
    let normal = polygon_normal(points, polygon)?;
    let drop_axis = if normal.x.abs() >= normal.y.abs() && normal.x.abs() >= normal.z.abs() {
        0
    } else if normal.y.abs() >= normal.z.abs() {
        1
    } else {
        2
    };
    let projected = polygon
        .iter()
        .map(|&index| project(points[index], drop_axis))
        .collect::<Vec<_>>();
    let area = signed_area(&projected);
    if area.abs() <= 1.0e-14 {
        return Err(provider_message("IFC polygon is degenerate"));
    }
    let ccw = area > 0.0;
    let mut remaining = (0..polygon.len()).collect::<Vec<_>>();
    let mut triangles = Vec::with_capacity(polygon.len() - 2);
    while remaining.len() > 3 {
        let mut ear = None;
        for cursor in 0..remaining.len() {
            let previous = remaining[(cursor + remaining.len() - 1) % remaining.len()];
            let current = remaining[cursor];
            let next = remaining[(cursor + 1) % remaining.len()];
            if convex(
                projected[previous],
                projected[current],
                projected[next],
                ccw,
            ) && !remaining.iter().copied().any(|candidate| {
                candidate != previous
                    && candidate != current
                    && candidate != next
                    && inside_triangle(
                        projected[candidate],
                        projected[previous],
                        projected[current],
                        projected[next],
                    )
            }) {
                ear = Some((cursor, previous, current, next));
                break;
            }
        }
        let Some((cursor, a, b, c)) = ear else {
            return Err(provider_message(
                "IFC polygon is self-intersecting or non-planar",
            ));
        };
        triangles.push([
            to_u32(polygon[a])?,
            to_u32(polygon[b])?,
            to_u32(polygon[c])?,
        ]);
        remaining.remove(cursor);
    }
    triangles.push([
        to_u32(polygon[remaining[0]])?,
        to_u32(polygon[remaining[1]])?,
        to_u32(polygon[remaining[2]])?,
    ]);
    Ok(triangles)
}

fn polygon_normal(points: &[Vector3], polygon: &[usize]) -> Result<Vector3, ProviderContractError> {
    let mut normal = Vector3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };
    for index in 0..polygon.len() {
        let current = points[polygon[index]];
        let next = points[polygon[(index + 1) % polygon.len()]];
        normal.x += (current.y - next.y) * (current.z + next.z);
        normal.y += (current.z - next.z) * (current.x + next.x);
        normal.z += (current.x - next.x) * (current.y + next.y);
    }
    let length = (normal.x * normal.x + normal.y * normal.y + normal.z * normal.z).sqrt();
    if !length.is_finite() || length <= 1.0e-12 {
        return Err(provider_message("IFC polygon normal is undefined"));
    }
    Ok(Vector3 {
        x: normal.x / length,
        y: normal.y / length,
        z: normal.z / length,
    })
}

fn project(value: Vector3, drop_axis: usize) -> [f64; 2] {
    match drop_axis {
        0 => [value.y, value.z],
        1 => [value.x, value.z],
        _ => [value.x, value.y],
    }
}

fn signed_area(points: &[[f64; 2]]) -> f64 {
    (0..points.len())
        .map(|index| {
            let next = (index + 1) % points.len();
            points[index][0] * points[next][1] - points[next][0] * points[index][1]
        })
        .sum::<f64>()
        * 0.5
}

fn cross2(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn convex(a: [f64; 2], b: [f64; 2], c: [f64; 2], ccw: bool) -> bool {
    if ccw {
        cross2(a, b, c) > 1.0e-14
    } else {
        cross2(a, b, c) < -1.0e-14
    }
}

fn inside_triangle(p: [f64; 2], a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> bool {
    let ab = cross2(a, b, p);
    let bc = cross2(b, c, p);
    let ca = cross2(c, a, p);
    (ab >= -1.0e-14 && bc >= -1.0e-14 && ca >= -1.0e-14)
        || (ab <= 1.0e-14 && bc <= 1.0e-14 && ca <= 1.0e-14)
}

fn cartesian_point_list(index: &StepIndex, id: u64) -> Result<Vec<Vector3>, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCCARTESIANPOINTLIST3D" {
        return Err(provider_message("IFC face set coordinates are not 3D"));
    }
    let rows = record
        .arguments
        .first()
        .and_then(list_values)
        .ok_or_else(|| provider_message("IFC coordinate list missing"))?;
    if rows.len() > MAX_VERTICES_PER_PRODUCT {
        return Err(provider_message("IFC coordinate budget exceeded"));
    }
    rows.iter()
        .map(|row| {
            let values = list_values(row)
                .ok_or_else(|| provider_message("IFC coordinate row is not a list"))?;
            if values.len() != 3 {
                return Err(provider_message(
                    "IFC 3D coordinate must contain three values",
                ));
            }
            Ok(Vector3 {
                x: number(&values[0])?,
                y: number(&values[1])?,
                z: number(&values[2])?,
            })
        })
        .collect()
}

fn resolve_local_placement(
    index: &StepIndex,
    id: u64,
    active: &mut BTreeSet<u64>,
) -> Result<Transform3d, ProviderContractError> {
    if !active.insert(id) {
        return Err(provider_message("recursive IfcLocalPlacement"));
    }
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCLOCALPLACEMENT" {
        return Err(provider_message(
            "unsupported non-local IFC object placement",
        ));
    }
    let parent = record.arguments.first().and_then(reference_value);
    let relative = record
        .arguments
        .get(1)
        .and_then(reference_value)
        .map(|value| axis_placement(index, value))
        .transpose()?
        .unwrap_or(Transform3d::IDENTITY);
    let result = if let Some(parent) = parent {
        multiply(resolve_local_placement(index, parent, active)?, relative)
    } else {
        relative
    };
    active.remove(&id);
    Ok(result)
}

fn axis_placement(index: &StepIndex, id: u64) -> Result<Transform3d, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCAXIS2PLACEMENT3D" {
        return Err(provider_message("only IfcAxis2Placement3D is supported"));
    }
    let origin = record
        .arguments
        .first()
        .and_then(reference_value)
        .map(|value| cartesian_point(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        });
    let z = record
        .arguments
        .get(1)
        .and_then(reference_value)
        .map(|value| direction(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 0.0,
            y: 0.0,
            z: 1.0,
        });
    let x_hint = record
        .arguments
        .get(2)
        .and_then(reference_value)
        .map(|value| direction(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
    frame(origin, z, x_hint)
}

fn transformation_operator(
    index: &StepIndex,
    id: u64,
) -> Result<Transform3d, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if !record
        .entity_type
        .starts_with("IFCCARTESIANTRANSFORMATIONOPERATOR3D")
    {
        return Err(provider_message("unsupported IFC mapping target"));
    }
    let origin = record
        .arguments
        .get(2)
        .and_then(reference_value)
        .map(|value| cartesian_point(index, value))
        .transpose()?
        .ok_or_else(|| provider_message("IFC mapping target origin missing"))?;
    let x = record
        .arguments
        .first()
        .and_then(reference_value)
        .map(|value| direction(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
    let y = record
        .arguments
        .get(1)
        .and_then(reference_value)
        .map(|value| direction(index, value))
        .transpose()?
        .unwrap_or(Vector3 {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        });
    let z = record
        .arguments
        .get(4)
        .and_then(reference_value)
        .map(|value| direction(index, value))
        .transpose()?
        .unwrap_or_else(|| cross(x, y));
    let scale_x = record
        .arguments
        .get(3)
        .and_then(number_optional)
        .unwrap_or(1.0);
    let (scale_y, scale_z) = if record.entity_type.ends_with("NONUNIFORM") {
        (
            record
                .arguments
                .get(5)
                .and_then(number_optional)
                .unwrap_or(scale_x),
            record
                .arguments
                .get(6)
                .and_then(number_optional)
                .unwrap_or(scale_x),
        )
    } else {
        (scale_x, scale_x)
    };
    if [scale_x, scale_y, scale_z]
        .iter()
        .any(|scale| !scale.is_finite() || *scale == 0.0)
        || dot(x, y).abs() > 1.0e-10
        || dot(x, z).abs() > 1.0e-10
        || dot(y, z).abs() > 1.0e-10
        || dot(cross(x, y), z) < 1.0 - 1.0e-10
    {
        return Err(provider_message("invalid IFC mapping scale"));
    }
    Ok(Transform3d([
        x.x * scale_x,
        x.y * scale_x,
        x.z * scale_x,
        0.0,
        y.x * scale_y,
        y.y * scale_y,
        y.z * scale_y,
        0.0,
        z.x * scale_z,
        z.y * scale_z,
        z.z * scale_z,
        0.0,
        origin.x,
        origin.y,
        origin.z,
        1.0,
    ]))
}

fn frame(
    origin: Vector3,
    z: Vector3,
    x_hint: Vector3,
) -> Result<Transform3d, ProviderContractError> {
    let z = normalized(z)?;
    let y = normalized(cross(z, x_hint))?;
    let x = cross(y, z);
    Ok(Transform3d([
        x.x, x.y, x.z, 0.0, y.x, y.y, y.z, 0.0, z.x, z.y, z.z, 0.0, origin.x, origin.y, origin.z,
        1.0,
    ]))
}

fn cartesian_point(index: &StepIndex, id: u64) -> Result<Vector3, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCCARTESIANPOINT" {
        return Err(provider_message("expected IfcCartesianPoint"));
    }
    let values = record
        .arguments
        .first()
        .and_then(list_values)
        .ok_or_else(|| provider_message("IfcCartesianPoint coordinates missing"))?;
    Ok(Vector3 {
        x: values.first().map(number).transpose()?.unwrap_or(0.0),
        y: values.get(1).map(number).transpose()?.unwrap_or(0.0),
        z: values.get(2).map(number).transpose()?.unwrap_or(0.0),
    })
}

fn direction(index: &StepIndex, id: u64) -> Result<Vector3, ProviderContractError> {
    let record = index.record(id).map_err(step_error)?;
    if record.entity_type != "IFCDIRECTION" {
        return Err(provider_message("expected IfcDirection"));
    }
    let values = record
        .arguments
        .first()
        .and_then(list_values)
        .ok_or_else(|| provider_message("IfcDirection ratios missing"))?;
    normalized(Vector3 {
        x: values.first().map(number).transpose()?.unwrap_or(0.0),
        y: values.get(1).map(number).transpose()?.unwrap_or(0.0),
        z: values.get(2).map(number).transpose()?.unwrap_or(0.0),
    })
}

fn build_package(
    source_path: &Path,
    index: &StepIndex,
    namespace: &str,
    staged: &StagedSource,
    products: &mut [Product],
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let model_metadata = model_metadata(index)?;
    let id_map = products
        .iter()
        .map(|product| {
            (
                product.step_id,
                EntityId(stable_entity_id(
                    namespace,
                    product,
                    &staged.resource.object_hash,
                )),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut objects = BTreeMap::<String, CanonicalJsonObject>::new();
    let relations_empty = intern_object(
        &mut objects,
        "application/vnd.himmelcad.relations+json",
        serde_json::json!([]),
    )?;
    let source_payload = staged.resource.object_hash.clone();
    let source_geometry = GeometryObject::Extension {
        type_id: SOURCE_EXTENSION_TYPE.to_owned(),
        payload: source_payload,
    };
    let source_geometry_hash =
        geometry_object_content_hash(&source_geometry).map_err(provider_error)?;
    let mut admissions = Vec::new();
    for product in products {
        let entity_id = id_map
            .get(&product.step_id)
            .cloned()
            .expect("product id map");
        let component = SourceComponent {
            schema_id: "hcad.component.ifc-source@1",
            schema: &index.schema,
            step_id: product.step_id,
            entity_type: &product.entity_type,
            global_id: product.global_id.as_deref(),
            source_resource: &staged.resource,
        };
        let bim_classification = BimClassificationComponent {
            schema_id: BIM_CLASSIFICATION_COMPONENT_SCHEMA_ID.to_owned(),
            content_hash: ObjectHash::of_bytes(b"uninitialized IFC BIM classification"),
            classifications: vec![BimClassification {
                system: format!("IFC {}", index.schema),
                code: product.entity_type.clone(),
                predefined_type: None,
            }],
        }
        .seal()
        .map_err(provider_error)?;
        let components_ref = intern_object(
            &mut objects,
            "application/vnd.himmelcad.components+json",
            serde_json::json!({
                "hcad.ifc-source@1": component,
                "hcad.component.bim-classification@1": bim_classification,
            }),
        )?;
        let attributes_ref = intern_object(
            &mut objects,
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.ifc-import@1": {
                    "sourceName": source_path.file_name().and_then(|value| value.to_str()),
                    "schema": index.schema,
                    "stepId": product.step_id,
                    "globalId": product.global_id,
                    "entityType": product.entity_type,
                    "representationStepId": product.representation,
                    "unsupportedGeometryTypes": product.unsupported_geometry,
                    "propertySets": product.properties,
                    "externalClassifications": product.classifications,
                    "modelCoordinates": model_metadata.clone(),
                    "sourceEqualsDisplayCoordinates": true,
                    "implicitReprojection": false,
                }
            }),
        )?;
        let relations_ref =
            if let Some(owner) = product.owner_step_id.and_then(|id| id_map.get(&id)) {
                intern_object(
                    &mut objects,
                    "application/vnd.himmelcad.relations+json",
                    serde_json::json!([{
                        "relationType": "hcad.ifc-spatially-contained-by@1",
                        "target": owner,
                        "expectedVersion": serde_json::Value::Null,
                        "parameters": serde_json::Value::Null,
                    }]),
                )?
            } else {
                relations_empty.clone()
            };
        let fallback = Representation {
            role: RepresentationRole::Alternate,
            geometry_ref: source_geometry_hash.clone(),
            authority: RepresentationAuthority::ImportedFallback,
            dependency_hash: None,
        };
        let mut representations = vec![fallback.clone()];
        let body_geometry = product.body.take();
        let body_representation = body_geometry
            .as_ref()
            .map(|geometry| {
                Ok::<_, ProviderContractError>(Representation {
                    role: RepresentationRole::Body,
                    geometry_ref: geometry_object_content_hash(geometry).map_err(provider_error)?,
                    authority: RepresentationAuthority::Derived,
                    dependency_hash: Some(staged.resource.object_hash.clone()),
                })
            })
            .transpose()?;
        if let Some(body) = &body_representation {
            representations.push(body.clone());
        }
        let mut entity = CanonicalEntity {
            id: entity_id,
            revision: 0,
            type_id: EntityTypeId(built_in_type::BIM_OBJECT.to_owned()),
            name: product.name.clone(),
            owner: product
                .owner_step_id
                .and_then(|id| id_map.get(&id).cloned()),
            layer_ids: Vec::new(),
            placement: Some(product.placement),
            representations,
            components_ref,
            attributes_ref,
            relations_ref,
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized IFC entity"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).map_err(provider_error)?;
        validate_resolved_representation(&entity, &fallback, &source_geometry)
            .map_err(provider_error)?;
        admissions.push(CanonicalRepresentationAdmission {
            entity: entity.clone(),
            selected: fallback,
            representation_slot: "ifc-source".to_owned(),
            expected_generation: None,
            resolved_geometry: source_geometry.clone(),
        });
        if let (Some(selected), Some(geometry)) = (body_representation, body_geometry) {
            validate_resolved_representation(&entity, &selected, &geometry)
                .map_err(provider_error)?;
            admissions.push(CanonicalRepresentationAdmission {
                entity,
                selected,
                representation_slot: "body".to_owned(),
                expected_generation: None,
                resolved_geometry: geometry,
            });
        }
    }
    Ok(CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: IFC_PROVIDER_ID.to_owned(),
        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
        admissions,
        objects: objects.into_values().collect(),
        datasets: Vec::new(),
        resource_sets: vec![CanonicalResourceSet {
            resource_set_id: format!("ifc-{}", &staged.resource.object_hash.as_str()[..24]),
            resources: vec![PreparedResourceArtifact {
                relative_path: staged.relative_path.clone(),
                resource: staged.resource.clone(),
            }],
        }],
        presentation_resources: Default::default(),
    })
}

fn model_metadata(index: &StepIndex) -> Result<serde_json::Value, ProviderContractError> {
    fn records_of_types(
        index: &StepIndex,
        types: &[&str],
    ) -> Result<Vec<serde_json::Value>, ProviderContractError> {
        let mut output = Vec::new();
        for entity_type in types {
            for id in index.ids_of_type(entity_type) {
                let record = index.record(id).map_err(step_error)?;
                output.push(serde_json::json!({
                    "stepId": id,
                    "entityType": record.entity_type,
                    "exactArguments": record.arguments.iter().map(step_value_json).collect::<Vec<_>>(),
                }));
            }
        }
        Ok(output)
    }
    Ok(serde_json::json!({
        "schema": index.schema,
        "unitAssignments": records_of_types(index, &["IFCUNITASSIGNMENT"])?,
        "projectedCrs": records_of_types(index, &["IFCPROJECTEDCRS"])?,
        "coordinateOperations": records_of_types(index, &["IFCMAPCONVERSION", "IFCMAPCONVERSIONSCALED"] )?,
        "georeferencingAppliedToCoordinates": false,
        "sourceDisplayTransform": "identity",
    }))
}

fn stage_source(
    source: &Path,
    root: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<StagedSource, ProviderContractError> {
    let length = fs::metadata(source).map_err(provider_error)?.len();
    let staging_root = root.join("ifc").join(".staging");
    fs::create_dir_all(&staging_root).map_err(provider_error)?;
    let staging = staging_root.join(format!(
        "{}-{}.ifc",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(provider_error)?
            .as_nanos()
    ));
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(provider_error)?;
    let mut output = BufWriter::with_capacity(COPY_BUFFER_BYTES, output);
    let mut input = BufReader::with_capacity(
        COPY_BUFFER_BYTES,
        File::open(source).map_err(provider_error)?,
    );
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    loop {
        check_cancelled(context)?;
        let count = input.read(&mut buffer).map_err(provider_error)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(provider_error)?;
        hasher.update(&buffer[..count]);
        copied = copied
            .checked_add(count as u64)
            .ok_or_else(|| provider_message("IFC source length overflow"))?;
        context.report_progress(ProviderProgress {
            phase: "stage".to_owned(),
            completed: copied,
            total: Some(length),
            message: "IFC source wird unverändert hashgebunden gestaged".to_owned(),
        });
    }
    output.flush().map_err(provider_error)?;
    output.get_ref().sync_all().map_err(provider_error)?;
    if copied != length {
        fs::remove_file(&staging).ok();
        return Err(provider_message("IFC source changed during import"));
    }
    let hash = hex::encode(hasher.finalize());
    let relative_path = PathBuf::from("ifc")
        .join(&hash[..2])
        .join(format!("{hash}.ifc"));
    let destination = root.join(&relative_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(provider_error)?;
    }
    if destination.exists() {
        verify_file(&destination, &hash, copied)?;
        fs::remove_file(&staging).map_err(provider_error)?;
    } else {
        fs::rename(&staging, &destination).map_err(provider_error)?;
    }
    Ok(StagedSource {
        resource: GeometryResource {
            object_hash: ObjectHash(hash),
            media_type: IFC_MEDIA_TYPE.to_owned(),
            byte_length: Some(copied),
        },
        relative_path,
    })
}

fn exact_source_artifact(package: &CanonicalImportPackage) -> Option<&PreparedResourceArtifact> {
    if package.provider_id != IFC_PROVIDER_ID || package.resource_sets.len() != 1 {
        return None;
    }
    if package.admissions.iter().any(|admission| {
        admission.entity.revision != 0
            || canonical_entity_version_hash(&admission.entity)
                .map_or(true, |hash| admission.entity.version_hash != hash)
    }) {
        return None;
    }
    let artifact = package.resource_sets[0].resources.first()?;
    if package.resource_sets[0].resources.len() != 1
        || artifact.resource.media_type != IFC_MEDIA_TYPE
    {
        return None;
    }
    let source_hash = &artifact.resource.object_hash;
    if !package.admissions.iter().filter(|admission| admission.representation_slot == "ifc-source").all(|admission| matches!(&admission.resolved_geometry, GeometryObject::Extension { type_id, payload } if type_id == SOURCE_EXTENSION_TYPE && payload == source_hash)) { return None; }
    Some(artifact)
}

fn copy_verified(
    source: &Path,
    target: &Path,
    expected: &GeometryResource,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    if target.exists() {
        return Err(provider_message("IFC export target exists"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(provider_error)?;
    }
    let staging = target.with_extension(format!("ifc.hcad-stage-{}", std::process::id()));
    let mut input = BufReader::with_capacity(
        COPY_BUFFER_BYTES,
        File::open(source).map_err(provider_error)?,
    );
    let mut output = BufWriter::with_capacity(
        COPY_BUFFER_BYTES,
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(provider_error)?,
    );
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    loop {
        check_cancelled(context)?;
        let count = input.read(&mut buffer).map_err(provider_error)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(provider_error)?;
        hasher.update(&buffer[..count]);
        copied += count as u64;
    }
    output.flush().map_err(provider_error)?;
    output.get_ref().sync_all().map_err(provider_error)?;
    if expected.byte_length != Some(copied)
        || expected.object_hash.as_str() != hex::encode(hasher.finalize())
    {
        fs::remove_file(&staging).ok();
        return Err(provider_message("IFC source hash guard failed"));
    }
    fs::rename(staging, target).map_err(provider_error)
}

fn verify_file(path: &Path, hash: &str, length: u64) -> Result<(), ProviderContractError> {
    let mut input =
        BufReader::with_capacity(COPY_BUFFER_BYTES, File::open(path).map_err(provider_error)?);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut actual = 0_u64;
    loop {
        let count = input.read(&mut buffer).map_err(provider_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        actual += count as u64;
    }
    if actual != length || hex::encode(hasher.finalize()) != hash {
        return Err(provider_message(
            "existing IFC resource failed immutable verification",
        ));
    }
    Ok(())
}

fn intern_object(
    objects: &mut BTreeMap<String, CanonicalJsonObject>,
    media_type: &str,
    value: serde_json::Value,
) -> Result<ObjectHash, ProviderContractError> {
    let object = CanonicalJsonObject::new(media_type, value)?;
    let hash = object.object_hash.clone();
    objects.entry(hash.0.clone()).or_insert(object);
    Ok(hash)
}

fn stable_entity_id(namespace: &str, product: &Product, source: &ObjectHash) -> String {
    if let Some(global_id) = &product.global_id {
        return format!("ifc-{global_id}");
    }
    let mut hash = Sha256::new();
    hash.update(IFC_PROVIDER_ID);
    hash.update([0]);
    hash.update(namespace);
    hash.update([0]);
    hash.update(source.as_str());
    hash.update([0]);
    hash.update(product.step_id.to_le_bytes());
    format!("ifc-step-{}", hex::encode(hash.finalize()))
}

fn valid_global_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
}
fn reference_value(value: &StepValue) -> Option<u64> {
    if let StepValue::Ref(value) = value {
        Some(*value)
    } else {
        None
    }
}
fn string_value(value: &StepValue) -> Option<&str> {
    if let StepValue::String(value) = value {
        Some(value)
    } else {
        None
    }
}
fn list_values(value: &StepValue) -> Option<&[StepValue]> {
    if let StepValue::List(value) = value {
        Some(value)
    } else {
        None
    }
}
fn list_references(value: &StepValue) -> Option<Vec<u64>> {
    let values = list_values(value)?;
    let refs = values
        .iter()
        .map(reference_value)
        .collect::<Option<Vec<_>>>()?;
    (!refs.is_empty()).then_some(refs)
}
fn number(value: &StepValue) -> Result<f64, ProviderContractError> {
    match value {
        StepValue::Integer(value) => {
            const MAX_EXACT_F64_INTEGER: u64 = 9_007_199_254_740_992;
            if value.unsigned_abs() > MAX_EXACT_F64_INTEGER {
                return Err(provider_message(
                    "IFC integer coordinate exceeds exact f64 range",
                ));
            }
            value.to_string().parse::<f64>().map_err(provider_error)
        }
        StepValue::Real(value) => Ok(*value),
        StepValue::Typed(_, value) => number(value),
        _ => Err(provider_message("expected IFC number")),
    }
}
fn number_optional(value: &StepValue) -> Option<f64> {
    number(value).ok()
}
fn positive_index(value: &StepValue) -> Result<usize, ProviderContractError> {
    match value {
        StepValue::Integer(value) if *value > 0 => {
            usize::try_from(*value - 1).map_err(provider_error)
        }
        _ => Err(provider_message("IFC index is not positive")),
    }
}
fn to_u32(value: usize) -> Result<u32, ProviderContractError> {
    u32::try_from(value).map_err(provider_error)
}
fn ensure_mesh_budget(
    mesh: &MeshBuild,
    vertices: usize,
    faces: usize,
) -> Result<(), ProviderContractError> {
    if mesh.positions.len().saturating_add(vertices) > MAX_VERTICES_PER_PRODUCT
        || mesh.indices.len() / 3usize + faces > MAX_TRIANGLES_PER_PRODUCT
    {
        Err(provider_message("IFC per-product mesh budget exceeded"))
    } else {
        Ok(())
    }
}
fn normalized(value: Vector3) -> Result<Vector3, ProviderContractError> {
    let length = (value.x * value.x + value.y * value.y + value.z * value.z).sqrt();
    if !length.is_finite() || length <= 1.0e-14 {
        Err(provider_message("IFC direction is degenerate"))
    } else {
        Ok(Vector3 {
            x: value.x / length,
            y: value.y / length,
            z: value.z / length,
        })
    }
}
fn cross(a: Vector3, b: Vector3) -> Vector3 {
    Vector3 {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    }
}
fn dot(a: Vector3, b: Vector3) -> f64 {
    a.x * b.x + a.y * b.y + a.z * b.z
}
fn inverse_rigid(transform: Transform3d) -> Result<Transform3d, ProviderContractError> {
    let m = transform.0;
    let x = Vector3 {
        x: m[0],
        y: m[1],
        z: m[2],
    };
    let y = Vector3 {
        x: m[4],
        y: m[5],
        z: m[6],
    };
    let z = Vector3 {
        x: m[8],
        y: m[9],
        z: m[10],
    };
    let translation = Vector3 {
        x: m[12],
        y: m[13],
        z: m[14],
    };
    let finite = m.iter().all(|value| value.is_finite());
    let unit = |axis: Vector3| (dot(axis, axis) - 1.0).abs() <= 1.0e-10;
    if !finite
        || m[3].abs() > 1.0e-12
        || m[7].abs() > 1.0e-12
        || m[11].abs() > 1.0e-12
        || (m[15] - 1.0).abs() > 1.0e-12
        || !unit(x)
        || !unit(y)
        || !unit(z)
        || dot(x, y).abs() > 1.0e-10
        || dot(x, z).abs() > 1.0e-10
        || dot(y, z).abs() > 1.0e-10
        || dot(cross(x, y), z) < 1.0 - 1.0e-10
    {
        return Err(provider_message(
            "IFC mapping origin is not a rigid placement",
        ));
    }
    let inverse_translation = Vector3 {
        x: -dot(x, translation),
        y: -dot(y, translation),
        z: -dot(z, translation),
    };
    Ok(Transform3d([
        x.x,
        y.x,
        z.x,
        0.0,
        x.y,
        y.y,
        z.y,
        0.0,
        x.z,
        y.z,
        z.z,
        0.0,
        inverse_translation.x,
        inverse_translation.y,
        inverse_translation.z,
        1.0,
    ]))
}
fn transform_point(transform: Transform3d, value: Vector3) -> Vector3 {
    let m = transform.0;
    Vector3 {
        x: m[0] * value.x + m[4] * value.y + m[8] * value.z + m[12],
        y: m[1] * value.x + m[5] * value.y + m[9] * value.z + m[13],
        z: m[2] * value.x + m[6] * value.y + m[10] * value.z + m[14],
    }
}
fn transform_vector(transform: Transform3d, value: Vector3) -> Vector3 {
    let m = transform.0;
    Vector3 {
        x: m[0] * value.x + m[4] * value.y + m[8] * value.z,
        y: m[1] * value.x + m[5] * value.y + m[9] * value.z,
        z: m[2] * value.x + m[6] * value.y + m[10] * value.z,
    }
}
fn multiply(left: Transform3d, right: Transform3d) -> Transform3d {
    let mut result = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            result[column * 4 + row] = (0..4)
                .map(|inner| left.0[inner * 4 + row] * right.0[column * 4 + inner])
                .sum();
        }
    }
    Transform3d(result)
}
fn check_cancelled(context: &dyn ProviderOperationContext) -> Result<(), ProviderContractError> {
    if context.is_cancelled() {
        Err(ProviderContractError::Cancelled)
    } else {
        Ok(())
    }
}
fn step_error(error: StepError) -> ProviderContractError {
    match error {
        StepError::Syntax("cancelled") => ProviderContractError::Cancelled,
        other => provider_error(other),
    }
}
fn provider_error(error: impl std::fmt::Display) -> ProviderContractError {
    ProviderContractError::Provider(error.to_string())
}
fn provider_message(message: impl Into<String>) -> ProviderContractError {
    ProviderContractError::Provider(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_provider::ProviderProgress;

    #[derive(Default)]
    struct Context {
        cancelled: bool,
        progress: Vec<ProviderProgress>,
    }
    impl ProviderOperationContext for Context {
        fn is_cancelled(&self) -> bool {
            self.cancelled
        }
        fn report_progress(&mut self, progress: ProviderProgress) {
            self.progress.push(progress);
        }
    }

    fn fixture() -> String {
        "ISO-10303-21;HEADER;FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');FILE_NAME('tiny.ifc','2026-01-01T00:00:00',(),(),'', '', '');FILE_SCHEMA(('IFC4X3_ADD2'));ENDSEC;DATA;#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.),(0.,2.,0.)));#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3),(1,3,4)),$);#3=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#2));#4=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));#5=IFCCARTESIANPOINT((100.,200.,3.));#6=IFCAXIS2PLACEMENT3D(#5,$,$);#7=IFCLOCALPLACEMENT($,#6);#8=IFCBUILDINGELEMENTPROXY('0abcdefghijklmnopqrstu',$,'Road object',$,$,#7,#4,$,$);ENDSEC;END-ISO-10303-21;".to_owned()
    }
    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "hcad-ifc-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn integer_geometry_values_fail_before_f64_precision_loss() {
        assert_eq!(
            number(&StepValue::Integer(9_007_199_254_740_992))
                .unwrap()
                .to_bits(),
            9_007_199_254_740_992.0_f64.to_bits()
        );
        assert!(number(&StepValue::Integer(9_007_199_254_740_993)).is_err());
        assert!(number(&StepValue::Integer(i64::MIN)).is_err());
    }

    #[test]
    fn imports_ifc43_tessellation_with_exact_source_and_placement() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("tiny.ifc");
        fs::write(&source, fixture()).unwrap();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let mut context = Context::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: IFC4X3_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut context,
            )
            .expect("import");
        package.validate().expect("package");
        assert_eq!(package.resource_sets.len(), 1);
        assert_eq!(package.admissions.len(), 2);
        let body = package
            .admissions
            .iter()
            .find(|value| value.representation_slot == "body")
            .unwrap();
        assert_eq!(body.entity.id.0, "ifc-0abcdefghijklmnopqrstu");
        assert_eq!(body.entity.placement.unwrap().0[12..15], [100., 200., 3.]);
        match &body.resolved_geometry {
            GeometryObject::Surface3d { mesh } => match &mesh.storage {
                TriangleMeshStorage::Inline {
                    positions, indices, ..
                } => {
                    assert_eq!(positions.len(), 4);
                    assert_eq!(indices.len(), 6)
                }
                _ => panic!("inline"),
            },
            _ => panic!("mesh"),
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn imports_ifc2x3_faceted_brep_without_filling_inner_bounds() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("faceted.ifc");
        let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((2.,0.,0.));\
#3=IFCCARTESIANPOINT((0.,2.,0.));#4=IFCPOLYLOOP((#1,#2,#3));\
#5=IFCFACEOUTERBOUND(#4,.T.);#6=IFCFACE((#5));#7=IFCCLOSEDSHELL((#6));\
#8=IFCFACETEDBREP(#7);#9=IFCSHAPEREPRESENTATION($,'Body','Brep',(#8));\
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#9));\
#11=IFCBUILDINGELEMENTPROXY('0abcdefghijklmnopqrstu',$,'Faceted',$,$,$,#10,$,$);\
ENDSEC;END-ISO-10303-21;";
        fs::write(&source, text).unwrap();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let probe = provider
            .probe(ImportProbeRequest {
                path: &source,
                prefix: text.as_bytes(),
                media_type: None,
            })
            .unwrap()
            .expect("IFC2X3 probe");
        assert_eq!(probe.format_id, IFC2X3_FORMAT_ID);
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: IFC2X3_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut Context::default(),
            )
            .expect("IFC2X3 import");
        let body = package
            .admissions
            .iter()
            .find(|value| value.representation_slot == "body")
            .expect("renderable faceted body");
        match &body.resolved_geometry {
            GeometryObject::Surface3d { mesh } => match &mesh.storage {
                TriangleMeshStorage::Inline {
                    positions, indices, ..
                } => {
                    assert_eq!(positions.len(), 3);
                    assert_eq!(indices, &[0, 1, 2]);
                }
                _ => panic!("faceted BRep must stay inline"),
            },
            _ => panic!("faceted BRep must become a surface"),
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    #[ignore = "explicit real-world IFC compatibility gate"]
    fn imports_explicit_real_ifc_fixture_with_at_least_one_renderable_body() {
        let source = std::env::var_os("HCAD_IFC_FIXTURE")
            .map(PathBuf::from)
            .expect("HCAD_IFC_FIXTURE must name an IFC file");
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let mut prefix = vec![0_u8; 64 * 1024];
        let read = std::io::Read::read(&mut fs::File::open(&source).unwrap(), &mut prefix).unwrap();
        prefix.truncate(read);
        let probe = provider
            .probe(ImportProbeRequest {
                path: &source,
                prefix: &prefix,
                media_type: Some(IFC_MEDIA_TYPE),
            })
            .unwrap()
            .expect("real IFC probe");
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: &probe.format_id,
                    options: &serde_json::json!({
                        "acceptedLossCodes": [LOSS_UNSUPPORTED_GEOMETRY],
                    }),
                },
                &mut Context::default(),
            )
            .expect("real IFC import");
        package.validate().expect("real IFC canonical package");
        assert!(
            package
                .admissions
                .iter()
                .any(|value| value.representation_slot == "body"),
            "fixture must publish at least one renderable body"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn representation_map_applies_inverse_origin_and_mapping_target_once() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("mapped.ifc");
        let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\
#1=IFCCARTESIANPOINTLIST3D(((10.,0.,0.),(11.,0.,0.),(10.,1.,0.)));\
#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);\
#3=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#2));\
#4=IFCCARTESIANPOINT((10.,0.,0.));\
#5=IFCAXIS2PLACEMENT3D(#4,$,$);\
#6=IFCREPRESENTATIONMAP(#5,#3);\
#7=IFCCARTESIANPOINT((100.,0.,0.));\
#8=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#7,1.,$);\
#9=IFCMAPPEDITEM(#6,#8);\
#10=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#9));\
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#10));\
#12=IFCBUILDINGELEMENTPROXY('0abcdefghijklmnopqrstu',$,'Mapped',$,$,$,#11,$,$);\
ENDSEC;END-ISO-10303-21;";
        fs::write(&source, text).unwrap();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let mut context = Context::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: IFC4_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut context,
            )
            .expect("mapped import");
        let body = package
            .admissions
            .iter()
            .find(|admission| admission.representation_slot == "body")
            .expect("mapped body");
        let GeometryObject::Surface3d { mesh } = &body.resolved_geometry else {
            panic!("mapped tessellation must remain an open surface");
        };
        let TriangleMeshStorage::Inline {
            positions, indices, ..
        } = &mesh.storage
        else {
            panic!("mapped tessellation must be inline");
        };
        assert_eq!(indices, &[0, 1, 2]);
        assert_eq!(
            positions,
            &[
                Vector3 {
                    x: 100.0,
                    y: 0.0,
                    z: 0.0,
                },
                Vector3 {
                    x: 101.0,
                    y: 0.0,
                    z: 0.0,
                },
                Vector3 {
                    x: 100.0,
                    y: 1.0,
                    z: 0.0,
                },
            ]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unsupported_geometry_requires_acceptance_and_remains_source_authoritative() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("unsupported.ifc");
        let text = fixture().replace(
            "#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3),(1,3,4)),$)",
            "#2=IFCADVANCEDBREP(#1)",
        );
        fs::write(&source, text).unwrap();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let mut context = Context::default();
        let rejected = provider.import(
            CanonicalImportRequest {
                source: &source,
                format_id: IFC4X3_FORMAT_ID,
                options: &serde_json::json!({}),
            },
            &mut context,
        );
        assert!(rejected.is_err());
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: IFC4X3_FORMAT_ID,
                    options: &serde_json::json!({"acceptedLossCodes":[LOSS_UNSUPPORTED_GEOMETRY]}),
                },
                &mut context,
            )
            .expect("fallback");
        assert_eq!(package.admissions.len(), 1);
        assert_eq!(
            package.admissions[0].selected.authority,
            RepresentationAuthority::ImportedFallback
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn imports_exact_rectangle_extrusion_and_property_set() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("extrusion.ifc");
        let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);#4=IFCRECTANGLEPROFILEDEF(.AREA.,'Rect',$,2.,1.);#5=IFCDIRECTION((0.,0.,1.));#6=IFCEXTRUDEDAREASOLID(#4,$,#5,3.);#7=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6));#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));#9=IFCWALL('1abcdefghijklmnopqrstu',$,'Wall',$,$,#3,#8,$,$);#10=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F90'),$);#11=IFCPROPERTYSET('2abcdefghijklmnopqrstu',$,'Pset_WallCommon',$,(#10));#12=IFCRELDEFINESBYPROPERTIES('3abcdefghijklmnopqrstu',$,$,$,(#9),#11);ENDSEC;END-ISO-10303-21;";
        fs::write(&source, text).unwrap();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let mut context = Context::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: IFC4_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut context,
            )
            .expect("extrusion import");
        let body = package
            .admissions
            .iter()
            .find(|admission| admission.representation_slot == "body")
            .expect("body");
        assert!(matches!(
            body.resolved_geometry,
            GeometryObject::Solid { .. }
        ));
        let attributes = package
            .objects
            .iter()
            .find(|object| object.object_hash == body.entity.attributes_ref)
            .expect("attributes");
        assert_eq!(
            attributes.value["hcad.ifc-import@1"]["propertySets"][0]["name"],
            "Pset_WallCommon"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn official_buildingsmart_fixture_is_checksum_pinned_and_preserves_spatial_owner() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ifc/buildingsmart-tessellated-item.ifc");
        let bytes = fs::read(&source).expect("official fixture");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "f580ad408fc131b9d9ebbb2871b2cfc180573a65e40dc01b4cf91b5cbc232195"
        );
        let root = temp_root();
        let provider = IfcCanonicalProvider::new(root.join("resources"));
        let mut context = Context::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: IFC4_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut context,
            )
            .expect("official buildingSMART IFC import");
        let viewer_evidence =
            crate::viewer_contract_test_support::assert_provider_package_reaches_viewer(&package);
        assert_eq!(
            viewer_evidence.direct_admissions + viewer_evidence.delegated_admissions,
            package.admissions.len()
        );
        let proxy = package
            .admissions
            .iter()
            .find(|admission| admission.entity.id.0 == "ifc-1kTvXnbbzCWw8lcMd1dR4o")
            .expect("proxy admission");
        assert_eq!(
            proxy.entity.owner.as_ref().map(|owner| owner.0.as_str()),
            Some("ifc-2FCZDorxHDT8NI01kdXi8P")
        );
        assert_eq!(proxy.entity.placement.expect("placement").0[12], 1000.0);
        fs::remove_dir_all(root).ok();
    }
}
