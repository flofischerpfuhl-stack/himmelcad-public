//! Canonical ASCII DXF import/export provider.
//!
//! `dxf-rs` is deliberately kept behind this module. The provider admits only
//! geometry it can map without guessing and records an exact serialized source
//! entity beside each admission. Unchanged imported entities can therefore be
//! written byte-semantically through dxf-rs, while edited or newly authored
//! entities are regenerated from canonical geometry.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dxf::entities::{
    Arc, Circle, Ellipse, Entity, EntityType, Face3D, Insert, Line, LwPolyline, ModelPoint,
    Polyline, Spline,
};
use dxf::enums::AcadVersion;
use dxf::tables::{Layer, LineType};
use dxf::{Block, Color, Drawing, Point, Vector};
use himmelcad_core::canonical_resources::{
    validate_block_definition_set, validate_line_type_resource, BlockDefinition, BlockMember,
    BlockMemberAttributes, BlockMemberSource, BlockMemberStyle, BlockPlacementComposition,
    CanonicalResourceRef, LineTypeElement, LineTypePattern, LineTypeResource,
    BLOCK_DEFINITION_SCHEMA_ID, LINE_TYPE_RESOURCE_SCHEMA_ID,
};
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, BlockInstanceGeometry, CanonicalEntity, CurveGeometry, EntityTypeId,
    GeometryObject, GeometryResource, Position, Representation, RepresentationAuthority,
    RepresentationRole, TextGeometry, TextSpace, Transform3d, TriangleMeshGeometry,
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

/// Exact format ID for the provider's ASCII DXF surface.
pub const DXF_FORMAT_ID: &str = "dxf@r12-r2018-ascii";
/// Stable provider identity.
pub const DXF_PROVIDER_ID: &str = "hcad.io.dxf-rs@1";

const ENTITY_SOURCE_MEDIA_TYPE: &str = "application/vnd.himmelcad.dxf-entity-source+json";
const BLOCK_SOURCE_MEDIA_TYPE: &str = "application/vnd.himmelcad.dxf-block-source+json";
const LAYER_RESOURCE_MEDIA_TYPE: &str = "application/vnd.himmelcad.dxf-layer-resource+json";
const STYLE_RESOURCE_MEDIA_TYPE: &str = "application/vnd.himmelcad.dxf-entity-style+json";
const LINE_TYPE_RESOURCE_MEDIA_TYPE: &str = "application/vnd.himmelcad.line-type-resource+json";
const BLOCK_DEFINITION_MEDIA_TYPE: &str = "application/vnd.himmelcad.block-definition+json";
const COMPONENTS_MEDIA_TYPE: &str = "application/vnd.himmelcad.components+json";
const RELATIONS_MEDIA_TYPE: &str = "application/vnd.himmelcad.relations+json";

/// dxf-rs 0.6.1 has no HATCH entity implementation.
pub const LOSS_UNSUPPORTED_HATCH: &str = "hcad.loss.dxf.unsupported-hatch@1";
/// dxf-rs exposes REGION only as opaque ACIS custom data.
pub const LOSS_OPAQUE_REGION: &str = "hcad.loss.dxf.opaque-region@1";
/// Source entity type is outside the canonical DXF subset.
pub const LOSS_UNSUPPORTED_ENTITY: &str = "hcad.loss.dxf.unsupported-entity@1";
/// Object-coordinate-system geometry is outside the currently exact XY mapping.
pub const LOSS_NON_XY_OCS: &str = "hcad.loss.dxf.non-xy-ocs@1";
/// INSERT array semantics cannot be represented by one canonical block instance.
pub const LOSS_INSERT_ARRAY: &str = "hcad.loss.dxf.insert-array@1";
/// A canonical entity has no DXF representation and would be omitted.
pub const LOSS_ENTITY_OMITTED: &str = "hcad.loss.dxf.entity-omitted@1";
/// Canonical entity metadata has no DXF destination.
pub const LOSS_METADATA: &str = "hcad.loss.dxf.metadata-not-representable@1";
/// One canonical mesh entity is emitted as several DXF 3DFACE entities.
pub const LOSS_MESH_PARTITION: &str = "hcad.loss.dxf.mesh-entity-partition@1";
/// Compound canonical curve identity is emitted as independent DXF entities.
pub const LOSS_COMPOSITE_IDENTITY: &str = "hcad.loss.dxf.composite-identity@1";
/// A canonical block definition cannot be materialized in DXF.
pub const LOSS_BLOCK_DEFINITION: &str = "hcad.loss.dxf.block-definition-unavailable@1";
/// DXF has no stable slot for `HimmelCAD` entity IDs and version hashes.
pub const LOSS_CANONICAL_IDENTITY: &str = "hcad.loss.dxf.canonical-identity@1";

/// Production DXF provider implementing both canonical directions.
pub struct DxfCanonicalProvider {
    descriptor: FormatProviderDescriptor,
    resource_root: PathBuf,
}

impl DxfCanonicalProvider {
    /// Creates the pinned dxf-rs provider.
    #[must_use]
    pub fn new(resource_root: PathBuf) -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: DXF_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "ASCII DXF (dxf-rs)".to_owned(),
                format_ids: vec![DXF_FORMAT_ID.to_owned()],
                extensions: vec!["dxf".to_owned()],
                media_types: vec!["image/vnd.dxf".to_owned(), "application/dxf".to_owned()],
                capabilities: vec![FormatCapability::Import, FormatCapability::Export],
            },
            resource_root,
        }
    }
}

impl Default for DxfCanonicalProvider {
    fn default() -> Self {
        Self::new(env::temp_dir().join("himmelcad-dxf-resources"))
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct DxfImportOptions {
    accepted_loss_codes: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct DxfExportOptions {
    accepted_loss_codes: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DxfEntitySource {
    schema_id: String,
    source_geometry_ref: ObjectHash,
    source_style_ref: ObjectHash,
    source_placement: Option<Transform3d>,
    entity: Entity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DxfFontReference {
    schema_id: String,
    text_style_name: String,
    primary_font_file_name: String,
    big_font_file_name: String,
    width_factor: f64,
    oblique_angle_degrees: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DxfBlockSource {
    schema_id: String,
    definition_id: String,
    definition_hash: ObjectHash,
    block: Block,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DxfLayerResource {
    schema_id: String,
    resource_id: String,
    name: String,
    color: DxfColor,
    line_type_name: String,
    plotted: bool,
    layer_on: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DxfEntityStyleResource {
    schema_id: String,
    resource_id: String,
    layer_name: String,
    line_type_name: String,
    color: DxfColor,
    true_color: Option<u32>,
    line_type_scale: f64,
    visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum DxfColor {
    ByLayer,
    ByBlock,
    ByEntity,
    Index(u8),
}

#[derive(Debug)]
struct SourceScan {
    sha256: String,
    unsupported_tags: BTreeSet<String>,
}

#[derive(Default)]
struct ObjectStore {
    by_hash: BTreeMap<String, CanonicalJsonObject>,
}

type DxfBlockIndex = BTreeMap<String, (String, ObjectHash)>;

impl ObjectStore {
    fn insert_value(
        &mut self,
        media_type: &str,
        value: serde_json::Value,
    ) -> Result<ObjectHash, ProviderContractError> {
        let object = CanonicalJsonObject::new(media_type, value)?;
        let hash = object.object_hash.clone();
        self.by_hash.entry(hash.0.clone()).or_insert(object);
        Ok(hash)
    }

    fn insert<T: Serialize>(
        &mut self,
        media_type: &str,
        value: &T,
    ) -> Result<ObjectHash, ProviderContractError> {
        let value = serde_json::to_value(value).map_err(provider_error)?;
        self.insert_value(media_type, value)
    }

    fn into_values(self) -> Vec<CanonicalJsonObject> {
        self.by_hash.into_values().collect()
    }
}

impl CanonicalImportProvider for DxfCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        if request.prefix.starts_with(b"AutoCAD Binary DXF") {
            return Ok(None);
        }
        let extension = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("dxf"));
        let prefix = String::from_utf8_lossy(request.prefix);
        let ascii_magic = prefix.contains("SECTION") && prefix.contains("HEADER");
        if !extension && !ascii_magic {
            return Ok(None);
        }
        Ok(Some(ImportProbe {
            format_id: DXF_FORMAT_ID.to_owned(),
            confidence: if ascii_magic { 98 } else { 55 },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != DXF_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: DxfImportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "scan".to_owned(),
            completed: 0,
            total: fs::metadata(request.source).ok().map(|value| value.len()),
            message: "DXF-Struktur und Dateihash werden geprüft".to_owned(),
        });
        let scan = scan_ascii_source(request.source, context)?;
        let required_losses = source_loss_codes(&scan.unsupported_tags);
        reject_unaccepted_losses(&required_losses, &options.accepted_loss_codes)?;
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "decode".to_owned(),
            completed: 0,
            total: None,
            message: "DXF wird mit dxf-rs dekodiert".to_owned(),
        });
        let drawing = Drawing::load_file(request.source).map_err(provider_error)?;
        let mut package = drawing_to_package(
            &drawing,
            &scan.sha256,
            &required_losses,
            &self.resource_root,
            context,
        )?;
        package.validate()?;
        package
            .objects
            .sort_by(|left, right| left.object_hash.0.cmp(&right.object_hash.0));
        context.report_progress(ProviderProgress {
            phase: "admit".to_owned(),
            completed: package.admissions.len() as u64,
            total: Some(package.admissions.len() as u64),
            message: "Kanonisches DXF-Paket ist atomar validiert".to_owned(),
        });
        Ok(package)
    }
}

impl CanonicalExportProvider for DxfCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn plan_export(
        &self,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError> {
        if request.format_id != DXF_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        request.package.validate()?;
        let mut losses = export_loss_codes(request.package)?;
        losses.sort();
        losses.dedup();
        let relative_path = request
            .target
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| provider_message("DXF export target must be a file path"))?;
        Ok(CanonicalExportPlan {
            format_id: DXF_FORMAT_ID.to_owned(),
            outputs: vec![ExportOutput {
                relative_path,
                media_type: "image/vnd.dxf".to_owned(),
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
        let expected = self.plan_export(CanonicalExportRequest {
            target: request.target,
            format_id: request.format_id,
            package: request.package,
            options: request.options,
        })?;
        if &expected != plan {
            return Err(provider_message(
                "DXF export plan no longer matches the request",
            ));
        }
        let options: DxfExportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        reject_unaccepted_losses(&plan.semantic_losses, &options.accepted_loss_codes)?;
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "encode".to_owned(),
            completed: 0,
            total: Some(request.package.admissions.len() as u64),
            message: "Kanonische Geometrie wird als DXF aufgebaut".to_owned(),
        });
        let drawing = package_to_drawing(request.package, context)?;
        atomic_save_ascii(&drawing, request.target)?;
        context.report_progress(ProviderProgress {
            phase: "write".to_owned(),
            completed: 1,
            total: Some(1),
            message: "DXF wurde atomar veröffentlicht".to_owned(),
        });
        Ok(())
    }
}

fn scan_ascii_source(
    path: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<SourceScan, ProviderContractError> {
    let mut prefix = [0_u8; 22];
    let mut prefix_file = File::open(path).map_err(provider_error)?;
    let count = prefix_file.read(&mut prefix).map_err(provider_error)?;
    if prefix[..count].starts_with(b"AutoCAD Binary DXF") {
        return Err(provider_message(
            "hcad.loss.dxf.binary-source@1: binary DXF is rejected because unsupported entity detection cannot be complete",
        ));
    }
    let file = File::open(path).map_err(provider_error)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut unsupported_tags = BTreeSet::new();
    let mut section = String::new();
    let mut pending_section = false;
    let mut code_line = String::new();
    let mut value_line = String::new();
    let mut bytes_read = 0_u64;
    loop {
        code_line.clear();
        let code_bytes = reader.read_line(&mut code_line).map_err(provider_error)?;
        if code_bytes == 0 {
            break;
        }
        hasher.update(code_line.as_bytes());
        bytes_read += code_bytes as u64;
        value_line.clear();
        let value_bytes = reader.read_line(&mut value_line).map_err(provider_error)?;
        if value_bytes == 0 {
            return Err(provider_message("truncated DXF group-code pair"));
        }
        hasher.update(value_line.as_bytes());
        bytes_read += value_bytes as u64;
        let code = code_line.trim().parse::<i32>().map_err(provider_error)?;
        let value = value_line.trim_end_matches(['\r', '\n']).trim();
        if pending_section && code == 2 {
            section = value.to_ascii_uppercase();
            pending_section = false;
        } else if code == 0 && value.eq_ignore_ascii_case("SECTION") {
            pending_section = true;
        } else if code == 0 && value.eq_ignore_ascii_case("ENDSEC") {
            section.clear();
        } else if code == 0
            && matches!(section.as_str(), "ENTITIES" | "BLOCKS")
            && !supported_structural_or_entity_tag(value)
        {
            unsupported_tags.insert(value.to_ascii_uppercase());
        }
        if bytes_read % (1024 * 1024) < (code_bytes + value_bytes) as u64 {
            check_cancelled(context)?;
            context.report_progress(ProviderProgress {
                phase: "scan".to_owned(),
                completed: bytes_read,
                total: fs::metadata(path).ok().map(|value| value.len()),
                message: "DXF-Struktur wird geprüft".to_owned(),
            });
        }
    }
    Ok(SourceScan {
        sha256: hex::encode(hasher.finalize()),
        unsupported_tags,
    })
}

fn supported_structural_or_entity_tag(tag: &str) -> bool {
    matches!(
        tag.to_ascii_uppercase().as_str(),
        "BLOCK"
            | "ENDBLK"
            | "POINT"
            | "LINE"
            | "LWPOLYLINE"
            | "POLYLINE"
            | "VERTEX"
            | "SEQEND"
            | "ARC"
            | "CIRCLE"
            | "ELLIPSE"
            | "SPLINE"
            | "3DFACE"
            | "TEXT"
            | "MTEXT"
            | "DIMENSION"
            | "INSERT"
    )
}

fn source_loss_codes(tags: &BTreeSet<String>) -> Vec<String> {
    let mut losses = BTreeSet::new();
    for tag in tags {
        losses.insert(match tag.as_str() {
            "HATCH" => LOSS_UNSUPPORTED_HATCH.to_owned(),
            "REGION" => LOSS_OPAQUE_REGION.to_owned(),
            _ => format!("{LOSS_UNSUPPORTED_ENTITY}:{tag}"),
        });
    }
    losses.into_iter().collect()
}

fn prepare_font_resources(
    drawing: &Drawing,
    resource_root: &Path,
) -> Result<
    (
        BTreeMap<String, GeometryResource>,
        Vec<PreparedResourceArtifact>,
    ),
    ProviderContractError,
> {
    let mut used = BTreeSet::new();
    for entity in drawing.entities() {
        match &entity.specific {
            EntityType::Text(text) => {
                used.insert(text.text_style_name.to_ascii_uppercase());
            }
            EntityType::MText(text) => {
                used.insert(text.text_style_name.to_ascii_uppercase());
            }
            _ => {}
        }
    }
    if used.is_empty() {
        return Ok((BTreeMap::new(), Vec::new()));
    }
    let styles = drawing
        .styles()
        .map(|style| (style.name.to_ascii_uppercase(), style))
        .collect::<BTreeMap<_, _>>();
    let mut resources = BTreeMap::new();
    let mut artifacts = BTreeMap::new();
    for style_name in used {
        let style = styles.get(&style_name);
        let descriptor = DxfFontReference {
            schema_id: "hcad.resource.dxf-font-reference@1".to_owned(),
            text_style_name: style_name.clone(),
            primary_font_file_name: style.map_or_else(
                || "txt".to_owned(),
                |value| value.primary_font_file_name.clone(),
            ),
            big_font_file_name: style
                .map_or_else(String::new, |value| value.big_font_file_name.clone()),
            width_factor: style.map_or(1.0, |value| value.width_factor),
            oblique_angle_degrees: style.map_or(0.0, |value| value.oblique_angle),
        };
        let bytes = serde_json::to_vec(&descriptor).map_err(provider_error)?;
        let object_hash = ObjectHash::of_bytes(&bytes);
        let relative_path =
            PathBuf::from("dxf-font-references").join(format!("{}.json", object_hash.as_str()));
        stage_immutable_resource(resource_root, &relative_path, &bytes)?;
        let resource = GeometryResource {
            object_hash: object_hash.clone(),
            media_type: "application/vnd.himmelcad.dxf-font-reference+json".to_owned(),
            byte_length: Some(bytes.len() as u64),
        };
        artifacts
            .entry(object_hash.0.clone())
            .or_insert_with(|| PreparedResourceArtifact {
                relative_path,
                resource: resource.clone(),
            });
        resources.insert(style_name, resource);
    }
    Ok((resources, artifacts.into_values().collect()))
}

fn stage_immutable_resource(
    root: &Path,
    relative_path: &Path,
    bytes: &[u8],
) -> Result<(), ProviderContractError> {
    let destination = root.join(relative_path);
    if destination.exists() {
        let existing = fs::read(&destination).map_err(provider_error)?;
        if ObjectHash::of_bytes(&existing) != ObjectHash::of_bytes(bytes) {
            return Err(provider_message(
                "existing DXF font-reference resource failed hash verification",
            ));
        }
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| provider_message("invalid prepared DXF resource path"))?;
    fs::create_dir_all(parent).map_err(provider_error)?;
    let staging = destination.with_extension(format!(
        "json.hcad-stage-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(provider_error)?
            .as_nanos()
    ));
    let mut guard = IncompleteFile::new(staging.clone());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(provider_error)?;
    file.write_all(bytes).map_err(provider_error)?;
    file.sync_all().map_err(provider_error)?;
    match fs::rename(&staging, &destination) {
        Ok(()) => guard.complete = true,
        Err(error) if destination.exists() => {
            let existing = fs::read(&destination).map_err(provider_error)?;
            if ObjectHash::of_bytes(&existing) != ObjectHash::of_bytes(bytes) {
                return Err(provider_error(error));
            }
        }
        Err(error) => return Err(provider_error(error)),
    }
    Ok(())
}

fn drawing_to_package(
    drawing: &Drawing,
    source_hash: &str,
    accepted_source_losses: &[String],
    resource_root: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let mut objects = ObjectStore::default();
    let components_ref = objects.insert_value(COMPONENTS_MEDIA_TYPE, serde_json::json!({}))?;
    let relations_ref = objects.insert_value(RELATIONS_MEDIA_TYPE, serde_json::json!([]))?;
    let (font_resources, font_artifacts) = prepare_font_resources(drawing, resource_root)?;

    let mut resource_refs = Vec::new();
    for line_type in drawing.line_types() {
        let resource = canonical_line_type(line_type, source_hash)?;
        validate_line_type_resource(&resource).map_err(provider_error)?;
        resource_refs.push(resource.resource_ref());
        objects.insert(LINE_TYPE_RESOURCE_MEDIA_TYPE, &resource)?;
    }
    for layer in drawing.layers() {
        objects.insert(
            LAYER_RESOURCE_MEDIA_TYPE,
            &DxfLayerResource {
                schema_id: "hcad.resource.dxf-layer@1".to_owned(),
                resource_id: stable_resource_id("layer", source_hash, &layer.name),
                name: layer.name.clone(),
                color: color_to_resource(&layer.color),
                line_type_name: layer.line_type_name.clone(),
                plotted: layer.is_layer_plotted,
                layer_on: layer.is_layer_on,
            },
        )?;
    }

    let (block_definitions, block_hashes) = import_block_definitions(
        drawing,
        source_hash,
        &font_resources,
        &mut objects,
        &mut resource_refs,
    )?;
    validate_block_definition_set(&block_definitions, &[], &resource_refs, &[])
        .map_err(provider_error)?;
    for definition in &block_definitions {
        objects.insert(BLOCK_DEFINITION_MEDIA_TYPE, definition)?;
    }

    let total = drawing.entities().count();
    let mut admissions = Vec::with_capacity(total);
    for (index, entity) in drawing.entities().enumerate() {
        check_cancelled(context)?;
        if let Some(admission) = import_entity_admission(
            entity,
            index,
            source_hash,
            &block_hashes,
            &font_resources,
            components_ref.clone(),
            relations_ref.clone(),
            &mut objects,
        )? {
            admissions.push(admission);
        }
        if index % 256 == 0 || index + 1 == total {
            context.report_progress(ProviderProgress {
                phase: "canonicalize".to_owned(),
                completed: (index + 1) as u64,
                total: Some(total as u64),
                message: "DXF-Entities werden kanonisch abgebildet".to_owned(),
            });
        }
    }
    if admissions.is_empty() {
        return Err(provider_message(
            "DXF contains no entities in the supported canonical subset",
        ));
    }
    if !accepted_source_losses.is_empty() {
        objects.insert_value(
            "application/vnd.himmelcad.dxf-import-losses+json",
            serde_json::json!({
                "schemaId": "hcad.provenance.dxf-import-losses@1",
                "acceptedLossCodes": accepted_source_losses,
            }),
        )?;
    }
    Ok(CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: DXF_PROVIDER_ID.to_owned(),
        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
        admissions,
        objects: objects.into_values(),
        datasets: Vec::new(),
        resource_sets: if font_artifacts.is_empty() {
            Vec::new()
        } else {
            vec![CanonicalResourceSet {
                resource_set_id: format!("dxf-fonts-{}", &source_hash[..16]),
                resources: font_artifacts,
            }]
        },
        presentation_resources: Default::default(),
    })
}

#[allow(clippy::too_many_arguments)]
fn import_entity_admission(
    source: &Entity,
    index: usize,
    source_hash: &str,
    block_hashes: &DxfBlockIndex,
    font_resources: &BTreeMap<String, GeometryResource>,
    components_ref: ObjectHash,
    relations_ref: ObjectHash,
    objects: &mut ObjectStore,
) -> Result<Option<CanonicalRepresentationAdmission>, ProviderContractError> {
    let Some(mut conversion) = entity_to_geometry(source, block_hashes, font_resources)? else {
        return Ok(None);
    };
    if matches!(conversion.geometry, GeometryObject::Extension { .. }) {
        let mut semantic_source = source.clone();
        semantic_source.common.handle = dxf::Handle::empty();
        let payload = objects.insert(
            "application/vnd.himmelcad.dxf-extension-payload+json",
            &semantic_source,
        )?;
        conversion.geometry = GeometryObject::Extension {
            type_id: conversion.type_id.to_owned(),
            payload,
        };
    }
    let style = DxfEntityStyleResource {
        schema_id: "hcad.resource.dxf-entity-style@1".to_owned(),
        resource_id: stable_resource_id(
            "style",
            source_hash,
            &format!("{}:{index}", source.common.handle.as_string()),
        ),
        layer_name: source.common.layer.clone(),
        line_type_name: source.common.line_type_name.clone(),
        color: color_to_resource(&source.common.color),
        true_color: u32::try_from(source.common.color_24_bit)
            .ok()
            .filter(|value| *value != 0),
        line_type_scale: source.common.line_type_scale,
        visible: source.common.is_visible,
    };
    let style_ref = objects.insert(STYLE_RESOURCE_MEDIA_TYPE, &style)?;
    let geometry_ref =
        geometry_object_content_hash(&conversion.geometry).map_err(provider_error)?;
    let source_object = DxfEntitySource {
        schema_id: "hcad.source.dxf-entity@1".to_owned(),
        source_geometry_ref: geometry_ref.clone(),
        source_style_ref: style_ref.clone(),
        source_placement: conversion.placement,
        entity: source.clone(),
    };
    let attributes_ref = objects.insert(ENTITY_SOURCE_MEDIA_TYPE, &source_object)?;
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let id_suffix = if source.common.handle.is_empty() {
        format!("index-{index}")
    } else {
        format!("handle-{}", source.common.handle.as_string())
    };
    let mut canonical = CanonicalEntity {
        id: EntityId(format!("dxf-{}-{id_suffix}", &source_hash[..16])),
        revision: 0,
        type_id: EntityTypeId(conversion.type_id.to_owned()),
        name: entity_display_name(source, index),
        owner: None,
        layer_ids: Vec::new(),
        placement: conversion.placement,
        representations: vec![selected.clone()],
        components_ref,
        attributes_ref,
        relations_ref,
        style_ref: Some(style_ref),
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"pending dxf entity hash"),
    };
    canonical.version_hash = canonical_entity_version_hash(&canonical).map_err(provider_error)?;
    validate_resolved_representation(&canonical, &selected, &conversion.geometry)
        .map_err(provider_error)?;
    Ok(Some(CanonicalRepresentationAdmission {
        entity: canonical,
        selected,
        representation_slot: "source".to_owned(),
        expected_generation: None,
        resolved_geometry: conversion.geometry,
    }))
}

struct EntityConversion {
    type_id: &'static str,
    geometry: GeometryObject,
    placement: Option<Transform3d>,
}

#[allow(clippy::too_many_lines)]
fn entity_to_geometry(
    entity: &Entity,
    block_hashes: &DxfBlockIndex,
    font_resources: &BTreeMap<String, GeometryResource>,
) -> Result<Option<EntityConversion>, ProviderContractError> {
    let (type_id, geometry, placement) = match &entity.specific {
        EntityType::ModelPoint(value) => (
            built_in_type::POINT,
            GeometryObject::Point {
                position: position(&value.location),
            },
            None,
        ),
        EntityType::Line(value) => (
            built_in_type::CURVE,
            GeometryObject::Curve {
                curve: Box::new(CurveGeometry::LineSegment {
                    start: position(&value.p1),
                    end: position(&value.p2),
                }),
            },
            None,
        ),
        EntityType::LwPolyline(value) => {
            ensure_z_normal(&value.extrusion_direction)?;
            (
                built_in_type::CURVE,
                GeometryObject::Curve {
                    curve: Box::new(lw_polyline_curve(value, entity.common.elevation)?),
                },
                None,
            )
        }
        EntityType::Polyline(value) if !value.is_3d_polygon_mesh() && !value.is_polyface_mesh() => {
            ensure_z_normal(&value.normal)?;
            (
                built_in_type::CURVE,
                GeometryObject::Curve {
                    curve: Box::new(polyline_curve(value)?),
                },
                None,
            )
        }
        EntityType::Arc(value) => {
            ensure_z_normal(&value.normal)?;
            (
                built_in_type::CURVE,
                GeometryObject::Curve {
                    curve: Box::new(arc_curve(value)?),
                },
                None,
            )
        }
        EntityType::Circle(value) => {
            ensure_z_normal(&value.normal)?;
            (
                built_in_type::CURVE,
                GeometryObject::Curve {
                    curve: Box::new(CurveGeometry::Circle {
                        center: position(&value.center),
                        radius: value.radius,
                        plane: None,
                    }),
                },
                None,
            )
        }
        EntityType::Ellipse(value) => {
            ensure_z_normal(&value.normal)?;
            let major_axis = vector(&value.major_axis);
            let minor_radius = vector_length(major_axis) * value.minor_axis_ratio;
            let full = normalized_sweep(value.start_parameter, value.end_parameter);
            let curve = if (full - std::f64::consts::TAU).abs() <= 1.0e-10 {
                CurveGeometry::Ellipse {
                    center: position(&value.center),
                    major_axis,
                    minor_radius,
                    plane: None,
                }
            } else {
                CurveGeometry::EllipticArc {
                    center: position(&value.center),
                    major_axis,
                    minor_radius,
                    start_parameter: value.start_parameter,
                    sweep_parameter: full,
                    plane: None,
                }
            };
            (
                built_in_type::CURVE,
                GeometryObject::Curve {
                    curve: Box::new(curve),
                },
                None,
            )
        }
        EntityType::Spline(value) => (
            built_in_type::CURVE,
            GeometryObject::Curve {
                curve: Box::new(spline_curve(value)?),
            },
            None,
        ),
        EntityType::Face3D(value) => (
            built_in_type::SURFACE_3D,
            GeometryObject::Surface3d {
                mesh: Box::new(face_geometry(value)),
            },
            None,
        ),
        EntityType::Insert(value) => {
            ensure_z_normal(&value.extrusion_direction)?;
            if value.column_count != 1 || value.row_count != 1 {
                return Err(provider_message(LOSS_INSERT_ARRAY));
            }
            let (definition_id, definition_hash) =
                block_hashes.get(&value.name).ok_or_else(|| {
                    provider_message(format!("missing DXF block definition: {}", value.name))
                })?;
            (
                built_in_type::BLOCK,
                GeometryObject::Block {
                    instance: Box::new(BlockInstanceGeometry {
                        definition_id: definition_id.clone(),
                        definition_hash: definition_hash.clone(),
                        placement: insert_transform(value),
                        overrides: None,
                    }),
                },
                None,
            )
        }
        EntityType::Text(value) => {
            ensure_z_normal(&value.normal)?;
            let Some(font) = font_resources
                .get(&value.text_style_name.to_ascii_uppercase())
                .cloned()
            else {
                return extension_conversion(entity, "hcad.dxf-text@1").map(Some);
            };
            (
                built_in_type::TEXT,
                GeometryObject::Text {
                    text: Box::new(TextGeometry {
                        text: value.value.clone(),
                        anchor: position(&value.location),
                        space: TextSpace::World,
                        height: value.text_height,
                        font,
                    }),
                },
                Some(rotation_about_position(&value.location, value.rotation)),
            )
        }
        EntityType::MText(value) => {
            ensure_z_normal(&value.extrusion_direction)?;
            let Some(font) = font_resources
                .get(&value.text_style_name.to_ascii_uppercase())
                .cloned()
            else {
                return extension_conversion(entity, "hcad.dxf-text@1").map(Some);
            };
            let mut text = value.text.clone();
            for extension in &value.extended_text {
                text.push_str(extension);
            }
            (
                built_in_type::TEXT,
                GeometryObject::Text {
                    text: Box::new(TextGeometry {
                        text,
                        anchor: position(&value.insertion_point),
                        space: TextSpace::World,
                        height: value.initial_text_height,
                        font,
                    }),
                },
                Some(rotation_about_position(
                    &value.insertion_point,
                    value.rotation_angle,
                )),
            )
        }
        EntityType::RotatedDimension(_)
        | EntityType::RadialDimension(_)
        | EntityType::DiameterDimension(_)
        | EntityType::AngularThreePointDimension(_)
        | EntityType::OrdinateDimension(_) => {
            return extension_conversion(entity, "hcad.dxf-dimension@1").map(Some);
        }
        _ => return Ok(None),
    };
    Ok(Some(EntityConversion {
        type_id,
        geometry,
        placement,
    }))
}

fn extension_conversion(
    entity: &Entity,
    type_id: &'static str,
) -> Result<EntityConversion, ProviderContractError> {
    let payload = serde_json::to_vec(entity).map_err(provider_error)?;
    Ok(EntityConversion {
        type_id,
        geometry: GeometryObject::Extension {
            type_id: type_id.to_owned(),
            payload: ObjectHash::of_bytes(&payload),
        },
        placement: None,
    })
}

fn import_block_definitions(
    drawing: &Drawing,
    source_hash: &str,
    font_resources: &BTreeMap<String, GeometryResource>,
    objects: &mut ObjectStore,
    resource_refs: &mut Vec<CanonicalResourceRef>,
) -> Result<(Vec<BlockDefinition>, DxfBlockIndex), ProviderContractError> {
    let blocks = drawing
        .blocks()
        .filter(|block| !block.name.starts_with('*'))
        .collect::<Vec<_>>();
    let mut unresolved = blocks;
    let mut definitions = Vec::new();
    let mut hashes = BTreeMap::new();
    while !unresolved.is_empty() {
        let mut progress = false;
        let mut remaining = Vec::new();
        for block in unresolved {
            let nested_ready = block.entities.iter().all(|entity| match &entity.specific {
                EntityType::Insert(insert) => hashes.contains_key(&insert.name),
                _ => true,
            });
            if !nested_ready {
                remaining.push(block);
                continue;
            }
            let definition_id = stable_resource_id("block", source_hash, &block.name);
            let mut members = Vec::with_capacity(block.entities.len());
            for (index, entity) in block.entities.iter().enumerate() {
                let Some(conversion) = entity_to_geometry(entity, &hashes, font_resources)? else {
                    return Err(provider_message(format!(
                        "{LOSS_UNSUPPORTED_ENTITY}: block {} member {index}",
                        block.name
                    )));
                };
                members.push(BlockMember {
                    member_id: format!("member-{index}"),
                    placement: conversion.placement.unwrap_or(Transform3d::IDENTITY),
                    style: BlockMemberStyle::Inherit,
                    attributes: BlockMemberAttributes::Inherit,
                    source: BlockMemberSource::Inline {
                        geometry: conversion.geometry,
                    },
                });
            }
            let definition = BlockDefinition {
                schema_id: BLOCK_DEFINITION_SCHEMA_ID.to_owned(),
                definition_id: definition_id.clone(),
                content_hash: ObjectHash::of_bytes(b"pending dxf block hash"),
                placement_composition: BlockPlacementComposition::InstanceThenMember,
                members,
            }
            .seal()
            .map_err(provider_error)?;
            let source = DxfBlockSource {
                schema_id: "hcad.source.dxf-block@1".to_owned(),
                definition_id: definition_id.clone(),
                definition_hash: definition.content_hash.clone(),
                block: block.clone(),
            };
            objects.insert(BLOCK_SOURCE_MEDIA_TYPE, &source)?;
            resource_refs.push(definition.resource_ref());
            hashes.insert(
                block.name.clone(),
                (definition_id, definition.content_hash.clone()),
            );
            definitions.push(definition);
            progress = true;
        }
        if !progress {
            return Err(provider_message(
                "hcad.loss.dxf.cyclic-block-reference@1: cyclic DXF block definitions cannot be content-addressed",
            ));
        }
        unresolved = remaining;
    }
    Ok((definitions, hashes))
}

fn canonical_line_type(
    source: &LineType,
    source_hash: &str,
) -> Result<LineTypeResource, ProviderContractError> {
    if source
        .complex_line_type_element_types
        .iter()
        .any(|value| *value != 0)
        || source.shape_numbers.iter().any(|value| *value != 0)
        || source.text_strings.iter().any(|value| !value.is_empty())
    {
        return Err(provider_message(
            "hcad.loss.dxf.complex-linetype@1: complex DXF linetypes are not canonicalized",
        ));
    }
    let pattern = if source.dash_dot_space_lengths.is_empty()
        || source.name.eq_ignore_ascii_case("CONTINUOUS")
    {
        LineTypePattern::Continuous
    } else {
        LineTypePattern::Repeating {
            elements: source
                .dash_dot_space_lengths
                .iter()
                .map(|value| {
                    if *value > 0.0 {
                        LineTypeElement::Dash { length: *value }
                    } else if *value < 0.0 {
                        LineTypeElement::Gap {
                            length: value.abs(),
                        }
                    } else {
                        LineTypeElement::Dot
                    }
                })
                .collect(),
        }
    };
    LineTypeResource {
        schema_id: LINE_TYPE_RESOURCE_SCHEMA_ID.to_owned(),
        resource_id: stable_resource_id("linetype", source_hash, &source.name),
        content_hash: ObjectHash::of_bytes(b"pending dxf linetype hash"),
        name: Some(source.name.clone()),
        pattern,
    }
    .seal()
    .map_err(provider_error)
}

fn lw_polyline_curve(
    value: &LwPolyline,
    elevation: f64,
) -> Result<CurveGeometry, ProviderContractError> {
    let positions = value
        .vertices
        .iter()
        .map(|vertex| Position {
            x: vertex.x,
            y: vertex.y,
            z: Some(elevation),
        })
        .collect::<Vec<_>>();
    let bulges = value
        .vertices
        .iter()
        .map(|vertex| vertex.bulge)
        .collect::<Vec<_>>();
    polyline_with_bulges(positions, &bulges, value.is_closed())
}

fn polyline_curve(value: &Polyline) -> Result<CurveGeometry, ProviderContractError> {
    let vertices = value.vertices().collect::<Vec<_>>();
    let positions = vertices
        .iter()
        .map(|vertex| position(&vertex.location))
        .collect::<Vec<_>>();
    let bulges = vertices
        .iter()
        .map(|vertex| vertex.bulge)
        .collect::<Vec<_>>();
    polyline_with_bulges(positions, &bulges, value.is_closed())
}

fn polyline_with_bulges(
    positions: Vec<Position>,
    bulges: &[f64],
    closed: bool,
) -> Result<CurveGeometry, ProviderContractError> {
    if positions.len() < 2 || positions.len() != bulges.len() {
        return Err(provider_message("invalid DXF polyline vertex count"));
    }
    if bulges.iter().all(|value| value.abs() <= f64::EPSILON) {
        return Ok(CurveGeometry::Polyline { positions, closed });
    }
    let segment_count = if closed {
        positions.len()
    } else {
        positions.len() - 1
    };
    let mut segments = Vec::with_capacity(segment_count);
    for index in 0..segment_count {
        let start = positions[index];
        let end = positions[(index + 1) % positions.len()];
        let bulge = bulges[index];
        if bulge.abs() <= f64::EPSILON {
            segments.push(CurveGeometry::LineSegment { start, end });
        } else {
            segments.push(bulge_arc(start, end, bulge)?);
        }
    }
    Ok(CurveGeometry::Composite { segments })
}

fn bulge_arc(
    start: Position,
    end: Position,
    bulge: f64,
) -> Result<CurveGeometry, ProviderContractError> {
    if start.z != end.z || !bulge.is_finite() || bulge.abs() <= f64::EPSILON {
        return Err(provider_message("invalid DXF polyline bulge"));
    }
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let chord = dx.hypot(dy);
    if chord <= f64::EPSILON {
        return Err(provider_message("zero-length DXF bulge segment"));
    }
    let sweep = 4.0 * bulge.atan();
    let midpoint_x = (start.x + end.x) * 0.5;
    let midpoint_y = (start.y + end.y) * 0.5;
    let distance = chord * (1.0 - bulge * bulge) / (4.0 * bulge);
    let center_x = midpoint_x - dy / chord * distance;
    let center_y = midpoint_y + dx / chord * distance;
    let start_angle = (start.y - center_y).atan2(start.x - center_x);
    let middle_angle = start_angle + sweep * 0.5;
    let radius = (start.x - center_x).hypot(start.y - center_y);
    Ok(CurveGeometry::CircularArc {
        start,
        point_on_arc: Position {
            x: center_x + radius * middle_angle.cos(),
            y: center_y + radius * middle_angle.sin(),
            z: start.z,
        },
        end,
    })
}

fn arc_curve(value: &Arc) -> Result<CurveGeometry, ProviderContractError> {
    if !value.radius.is_finite() || value.radius <= 0.0 {
        return Err(provider_message("invalid DXF arc radius"));
    }
    let start = value.start_angle.to_radians();
    let sweep = normalized_sweep(start, value.end_angle.to_radians());
    let middle = start + sweep * 0.5;
    Ok(CurveGeometry::CircularArc {
        start: circle_point(&value.center, value.radius, start),
        point_on_arc: circle_point(&value.center, value.radius, middle),
        end: circle_point(&value.center, value.radius, start + sweep),
    })
}

fn spline_curve(value: &Spline) -> Result<CurveGeometry, ProviderContractError> {
    let degree = u16::try_from(value.degree_of_curve)
        .map_err(|_| provider_message("invalid DXF spline degree"))?;
    let weights = if value.weight_values.is_empty() {
        None
    } else {
        Some(value.weight_values.clone())
    };
    Ok(CurveGeometry::Spline {
        degree,
        control_points: value.control_points.iter().map(position).collect(),
        knots: value.knot_values.clone(),
        weights,
        closed: value.is_closed(),
    })
}

fn face_geometry(value: &Face3D) -> TriangleMeshGeometry {
    let triangle = value.third_corner == value.fourth_corner;
    let positions = if triangle {
        vec![
            vector_point(&value.first_corner),
            vector_point(&value.second_corner),
            vector_point(&value.third_corner),
        ]
    } else {
        vec![
            vector_point(&value.first_corner),
            vector_point(&value.second_corner),
            vector_point(&value.third_corner),
            vector_point(&value.fourth_corner),
        ]
    };
    let indices = if triangle {
        vec![0, 1, 2]
    } else {
        vec![0, 1, 2, 0, 2, 3]
    };
    TriangleMeshGeometry {
        storage: TriangleMeshStorage::Inline {
            positions,
            indices,
            normals: None,
            texture_coordinates: None,
        },
        closed_manifold: false,
        triangle_material_slots: None,
        materials: None,
    }
}

fn package_to_drawing(
    package: &CanonicalImportPackage,
    context: &mut dyn ProviderOperationContext,
) -> Result<Drawing, ProviderContractError> {
    let object_index = package
        .objects
        .iter()
        .map(|object| (object.object_hash.as_str(), object))
        .collect::<BTreeMap<_, _>>();
    let mut drawing = Drawing::new();
    drawing.header.version = AcadVersion::R2018;
    restore_tables(package, &mut drawing)?;
    let block_names = restore_blocks(package, &mut drawing)?;
    let mut admissions = package.admissions.iter().collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.entity.id.0.cmp(&right.entity.id.0));
    for (index, admission) in admissions.into_iter().enumerate() {
        check_cancelled(context)?;
        if let Some(source) = exact_source_entity(admission, &object_index)? {
            drawing.add_entity(source);
        } else {
            let mut entities =
                canonical_geometry_to_entities(&admission.resolved_geometry, &block_names)?;
            apply_entity_placement(&mut entities, admission.entity.placement);
            for entity in entities {
                drawing.add_entity(entity);
            }
        }
        if index % 256 == 0 || index + 1 == package.admissions.len() {
            context.report_progress(ProviderProgress {
                phase: "encode".to_owned(),
                completed: (index + 1) as u64,
                total: Some(package.admissions.len() as u64),
                message: "DXF-Entities werden aufgebaut".to_owned(),
            });
        }
    }
    Ok(drawing)
}

fn exact_source_entity(
    admission: &CanonicalRepresentationAdmission,
    objects: &BTreeMap<&str, &CanonicalJsonObject>,
) -> Result<Option<Entity>, ProviderContractError> {
    let Some(object) = objects.get(admission.entity.attributes_ref.as_str()) else {
        return Ok(None);
    };
    if object.media_type != ENTITY_SOURCE_MEDIA_TYPE {
        return Ok(None);
    }
    let source: DxfEntitySource =
        serde_json::from_value(object.value.clone()).map_err(provider_error)?;
    if source.source_geometry_ref == admission.selected.geometry_ref
        && admission.entity.style_ref.as_ref() == Some(&source.source_style_ref)
        && admission.entity.placement == source.source_placement
    {
        Ok(Some(source.entity))
    } else {
        Ok(None)
    }
}

fn restore_tables(
    package: &CanonicalImportPackage,
    drawing: &mut Drawing,
) -> Result<(), ProviderContractError> {
    for object in &package.objects {
        match object.media_type.as_str() {
            LAYER_RESOURCE_MEDIA_TYPE => {
                let source: DxfLayerResource =
                    serde_json::from_value(object.value.clone()).map_err(provider_error)?;
                if drawing.layers().any(|layer| layer.name == source.name) {
                    continue;
                }
                let mut layer = Layer {
                    name: source.name,
                    color: resource_to_color(source.color),
                    line_type_name: source.line_type_name,
                    is_layer_plotted: source.plotted,
                    is_layer_on: source.layer_on,
                    ..Default::default()
                };
                if !layer.is_layer_on {
                    layer.color.turn_off();
                }
                drawing.add_layer(layer);
            }
            LINE_TYPE_RESOURCE_MEDIA_TYPE => {
                let resource: LineTypeResource =
                    serde_json::from_value(object.value.clone()).map_err(provider_error)?;
                let Some(name) = resource.name else {
                    continue;
                };
                if drawing.line_types().any(|line_type| line_type.name == name) {
                    continue;
                }
                let mut line_type = LineType {
                    name,
                    ..Default::default()
                };
                if let LineTypePattern::Repeating { elements } = resource.pattern {
                    line_type.dash_dot_space_lengths = elements
                        .into_iter()
                        .map(|element| match element {
                            LineTypeElement::Dash { length } => length,
                            LineTypeElement::Gap { length } => -length,
                            LineTypeElement::Dot => 0.0,
                        })
                        .collect();
                    line_type.element_count = i32::try_from(line_type.dash_dot_space_lengths.len())
                        .map_err(provider_error)?;
                    line_type.total_pattern_length = line_type
                        .dash_dot_space_lengths
                        .iter()
                        .map(|value| value.abs())
                        .sum();
                }
                drawing.add_line_type(line_type);
            }
            _ => {}
        }
    }
    Ok(())
}

fn restore_blocks(
    package: &CanonicalImportPackage,
    drawing: &mut Drawing,
) -> Result<BTreeMap<String, String>, ProviderContractError> {
    let mut definition_by_id = BTreeMap::new();
    for object in &package.objects {
        if object.media_type == BLOCK_DEFINITION_MEDIA_TYPE {
            let definition: BlockDefinition =
                serde_json::from_value(object.value.clone()).map_err(provider_error)?;
            definition_by_id.insert(definition.definition_id.clone(), definition);
        }
    }
    let mut block_names = definition_by_id
        .keys()
        .map(|definition_id| (definition_id.clone(), definition_id.clone()))
        .collect::<BTreeMap<_, _>>();
    for object in &package.objects {
        if object.media_type == BLOCK_SOURCE_MEDIA_TYPE {
            let source: DxfBlockSource =
                serde_json::from_value(object.value.clone()).map_err(provider_error)?;
            if definition_by_id
                .get(&source.definition_id)
                .is_some_and(|definition| definition.content_hash == source.definition_hash)
            {
                block_names.insert(source.definition_id, source.block.name);
            }
        }
    }
    let mut restored = BTreeSet::new();
    for object in &package.objects {
        if object.media_type != BLOCK_SOURCE_MEDIA_TYPE {
            continue;
        }
        let source: DxfBlockSource =
            serde_json::from_value(object.value.clone()).map_err(provider_error)?;
        if definition_by_id
            .get(&source.definition_id)
            .is_some_and(|definition| definition.content_hash == source.definition_hash)
        {
            restored.insert(source.definition_id.clone());
            drawing.add_block(source.block);
        }
    }
    for definition in definition_by_id.values() {
        if restored.contains(&definition.definition_id) {
            continue;
        }
        let mut block = Block {
            name: block_names
                .get(&definition.definition_id)
                .cloned()
                .unwrap_or_else(|| definition.definition_id.clone()),
            ..Default::default()
        };
        for member in &definition.members {
            let BlockMemberSource::Inline { geometry, .. } = &member.source else {
                continue;
            };
            block
                .entities
                .extend(canonical_geometry_to_entities(geometry, &block_names)?);
        }
        drawing.add_block(block);
    }
    Ok(block_names)
}

fn canonical_geometry_to_entities(
    geometry: &GeometryObject,
    block_names: &BTreeMap<String, String>,
) -> Result<Vec<Entity>, ProviderContractError> {
    match geometry {
        GeometryObject::Point { position: value } => Ok(vec![Entity::new(EntityType::ModelPoint(
            ModelPoint::new(point(value)),
        ))]),
        GeometryObject::Curve { curve } => curve_to_entities(curve),
        GeometryObject::Surface3d { mesh } => mesh_to_faces(mesh),
        GeometryObject::Block { instance } => {
            let (location, scale, rotation) = decompose_insert_transform(instance.placement)?;
            Ok(vec![Entity::new(EntityType::Insert(Insert {
                name: block_names
                    .get(&instance.definition_id)
                    .cloned()
                    .unwrap_or_else(|| instance.definition_id.clone()),
                location,
                x_scale_factor: scale[0],
                y_scale_factor: scale[1],
                z_scale_factor: scale[2],
                rotation,
                ..Default::default()
            }))])
        }
        GeometryObject::Text { text } => {
            Ok(vec![Entity::new(EntityType::Text(dxf::entities::Text {
                location: point(&text.anchor),
                text_height: text.height,
                value: text.text.clone(),
                ..Default::default()
            }))])
        }
        _ => Ok(Vec::new()),
    }
}

fn apply_entity_placement(entities: &mut [Entity], placement: Option<Transform3d>) {
    let Some(placement) = placement else {
        return;
    };
    if entities.len() == 1 {
        if let EntityType::Text(text) = &mut entities[0].specific {
            let matrix = placement.0;
            let rotation = matrix[1].atan2(matrix[0]);
            let (sin, cos) = rotation.sin_cos();
            let anchor = &text.location;
            let expected_x = anchor.x - cos * anchor.x + sin * anchor.y;
            let expected_y = anchor.y - sin * anchor.x - cos * anchor.y;
            if (matrix[0] - cos).abs() <= 1.0e-9
                && (matrix[1] - sin).abs() <= 1.0e-9
                && (matrix[4] + sin).abs() <= 1.0e-9
                && (matrix[5] - cos).abs() <= 1.0e-9
                && (matrix[12] - expected_x).abs() <= 1.0e-9
                && (matrix[13] - expected_y).abs() <= 1.0e-9
            {
                text.rotation = rotation.to_degrees();
            }
        }
    }
}

fn curve_to_entities(curve: &CurveGeometry) -> Result<Vec<Entity>, ProviderContractError> {
    let entities = match curve {
        CurveGeometry::LineSegment { start, end } => vec![Entity::new(EntityType::Line(
            Line::new(point(start), point(end)),
        ))],
        CurveGeometry::Polyline { positions, closed } => {
            let mut polyline = Polyline::default();
            polyline.set_is_closed(*closed);
            polyline.set_is_3d_polyline(positions.iter().any(|position| position.z != Some(0.0)));
            let mut drawing = Drawing::new();
            for value in positions {
                polyline.add_vertex(
                    &mut drawing,
                    dxf::entities::Vertex {
                        location: point(value),
                        ..Default::default()
                    },
                );
            }
            vec![Entity::new(EntityType::Polyline(polyline))]
        }
        CurveGeometry::CircularArc {
            start,
            point_on_arc,
            end,
        } => vec![Entity::new(EntityType::Arc(three_point_arc(
            *start,
            *point_on_arc,
            *end,
        )?))],
        CurveGeometry::Circle {
            center,
            radius,
            plane,
        } if plane.is_none() => vec![Entity::new(EntityType::Circle(Circle::new(
            point(center),
            *radius,
        )))],
        CurveGeometry::Ellipse {
            center,
            major_axis,
            minor_radius,
            plane,
        } if plane.is_none() => vec![Entity::new(EntityType::Ellipse(Ellipse {
            center: point(center),
            major_axis: dxf_vector(*major_axis),
            minor_axis_ratio: *minor_radius / vector_length(*major_axis),
            ..Default::default()
        }))],
        CurveGeometry::EllipticArc {
            center,
            major_axis,
            minor_radius,
            start_parameter,
            sweep_parameter,
            plane,
        } if plane.is_none()
            && *sweep_parameter > 0.0
            && *sweep_parameter <= std::f64::consts::TAU =>
        {
            vec![Entity::new(EntityType::Ellipse(Ellipse {
                center: point(center),
                major_axis: dxf_vector(*major_axis),
                minor_axis_ratio: *minor_radius / vector_length(*major_axis),
                start_parameter: *start_parameter,
                end_parameter: *start_parameter + *sweep_parameter,
                ..Default::default()
            }))]
        }
        CurveGeometry::Spline {
            degree,
            control_points,
            knots,
            weights,
            closed,
        } => {
            let mut spline = Spline {
                degree_of_curve: i32::from(*degree),
                control_points: control_points.iter().map(point).collect(),
                knot_values: knots.clone(),
                weight_values: weights.clone().unwrap_or_default(),
                ..Default::default()
            };
            spline.set_is_closed(*closed);
            spline.set_is_rational(weights.is_some());
            vec![Entity::new(EntityType::Spline(spline))]
        }
        CurveGeometry::Composite { segments } => {
            let mut result = Vec::new();
            for segment in segments {
                result.extend(curve_to_entities(segment)?);
            }
            result
        }
        _ => Vec::new(),
    };
    Ok(entities)
}

fn mesh_to_faces(mesh: &TriangleMeshGeometry) -> Result<Vec<Entity>, ProviderContractError> {
    let TriangleMeshStorage::Inline {
        positions, indices, ..
    } = &mesh.storage
    else {
        return Ok(Vec::new());
    };
    let mut result = Vec::with_capacity(indices.len() / 3);
    for triangle in indices.chunks_exact(3) {
        let a = positions
            .get(triangle[0] as usize)
            .ok_or_else(|| provider_message("invalid canonical mesh index"))?;
        let b = positions
            .get(triangle[1] as usize)
            .ok_or_else(|| provider_message("invalid canonical mesh index"))?;
        let c = positions
            .get(triangle[2] as usize)
            .ok_or_else(|| provider_message("invalid canonical mesh index"))?;
        result.push(Entity::new(EntityType::Face3D(Face3D::new(
            vector3_point(*a),
            vector3_point(*b),
            vector3_point(*c),
            vector3_point(*c),
        ))));
    }
    Ok(result)
}

fn export_loss_codes(
    package: &CanonicalImportPackage,
) -> Result<Vec<String>, ProviderContractError> {
    let objects = package
        .objects
        .iter()
        .map(|object| (object.object_hash.as_str(), object))
        .collect::<BTreeMap<_, _>>();
    let mut losses = BTreeSet::new();
    if !package.admissions.is_empty() {
        losses.insert(LOSS_CANONICAL_IDENTITY.to_owned());
    }
    for object in &package.objects {
        if object.media_type == "application/vnd.himmelcad.dxf-import-losses+json" {
            let accepted = object
                .value
                .get("acceptedLossCodes")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| provider_message("invalid DXF import-loss provenance"))?;
            for loss in accepted {
                let loss = loss
                    .as_str()
                    .ok_or_else(|| provider_message("invalid DXF import loss code"))?;
                losses.insert(loss.to_owned());
            }
        }
    }
    for admission in &package.admissions {
        if exact_source_entity(admission, &objects)?.is_some() {
            continue;
        }
        if admission.entity.owner.is_some()
            || !admission.entity.layer_ids.is_empty()
            || admission.entity.placement.is_some()
            || admission.entity.style_ref.is_some()
            || !admission.entity.name.is_empty()
            || [
                &admission.entity.components_ref,
                &admission.entity.attributes_ref,
                &admission.entity.relations_ref,
            ]
            .iter()
            .any(|hash| {
                objects
                    .get(hash.as_str())
                    .is_some_and(|object| json_has_content(&object.value))
            })
        {
            losses.insert(LOSS_METADATA.to_owned());
        }
        match &admission.resolved_geometry {
            GeometryObject::Point { .. } | GeometryObject::Block { .. } => {}
            GeometryObject::Text { .. } => {
                losses.insert(LOSS_METADATA.to_owned());
            }
            GeometryObject::Curve { curve } => collect_curve_losses(curve, &mut losses),
            GeometryObject::Surface3d { mesh } => match &mesh.storage {
                TriangleMeshStorage::Inline { indices, .. } if !indices.is_empty() => {
                    if indices.len() > 3 {
                        losses.insert(LOSS_MESH_PARTITION.to_owned());
                    }
                }
                _ => {
                    losses.insert(LOSS_ENTITY_OMITTED.to_owned());
                }
            },
            _ => {
                losses.insert(LOSS_ENTITY_OMITTED.to_owned());
            }
        }
    }
    for admission in &package.admissions {
        if let GeometryObject::Block { instance } = &admission.resolved_geometry {
            let definition = package.objects.iter().find_map(|object| {
                (object.media_type == BLOCK_DEFINITION_MEDIA_TYPE)
                    .then(|| serde_json::from_value::<BlockDefinition>(object.value.clone()).ok())
                    .flatten()
                    .filter(|definition| {
                        definition.definition_id == instance.definition_id
                            && definition.content_hash == instance.definition_hash
                    })
            });
            let Some(definition) = definition else {
                losses.insert(LOSS_BLOCK_DEFINITION.to_owned());
                continue;
            };
            let exact_source = package.objects.iter().any(|object| {
                object.media_type == BLOCK_SOURCE_MEDIA_TYPE
                    && serde_json::from_value::<DxfBlockSource>(object.value.clone())
                        .ok()
                        .is_some_and(|source| {
                            source.definition_id == definition.definition_id
                                && source.definition_hash == definition.content_hash
                        })
            });
            if exact_source {
                continue;
            }
            for member in &definition.members {
                if member.placement != Transform3d::IDENTITY {
                    losses.insert(LOSS_METADATA.to_owned());
                }
                if !matches!(member.style, BlockMemberStyle::Inherit)
                    || !matches!(member.attributes, BlockMemberAttributes::Inherit)
                {
                    losses.insert(LOSS_METADATA.to_owned());
                }
                match &member.source {
                    BlockMemberSource::EntityReference { .. } => {
                        losses.insert(LOSS_BLOCK_DEFINITION.to_owned());
                    }
                    BlockMemberSource::Inline { geometry } => {
                        collect_geometry_losses(geometry, &mut losses);
                    }
                }
            }
        }
    }
    Ok(losses.into_iter().collect())
}

fn json_has_content(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Object(object) => !object.is_empty(),
        serde_json::Value::Array(array) => !array.is_empty(),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
    }
}

fn collect_geometry_losses(geometry: &GeometryObject, losses: &mut BTreeSet<String>) {
    match geometry {
        GeometryObject::Point { .. } | GeometryObject::Block { .. } => {}
        GeometryObject::Text { .. } => {
            losses.insert(LOSS_METADATA.to_owned());
        }
        GeometryObject::Curve { curve } => collect_curve_losses(curve, losses),
        GeometryObject::Surface3d { mesh } => match &mesh.storage {
            TriangleMeshStorage::Inline { indices, .. } if !indices.is_empty() => {
                if indices.len() > 3 {
                    losses.insert(LOSS_MESH_PARTITION.to_owned());
                }
            }
            _ => {
                losses.insert(LOSS_ENTITY_OMITTED.to_owned());
            }
        },
        _ => {
            losses.insert(LOSS_ENTITY_OMITTED.to_owned());
        }
    }
}

fn collect_curve_losses(curve: &CurveGeometry, losses: &mut BTreeSet<String>) {
    match curve {
        CurveGeometry::LineSegment { .. }
        | CurveGeometry::Polyline { .. }
        | CurveGeometry::CircularArc { .. }
        | CurveGeometry::Spline { .. } => {}
        CurveGeometry::Circle { plane, .. }
        | CurveGeometry::Ellipse { plane, .. }
        | CurveGeometry::EllipticArc { plane, .. }
            if plane.is_none() => {}
        CurveGeometry::Composite { segments } => {
            losses.insert(LOSS_COMPOSITE_IDENTITY.to_owned());
            for segment in segments {
                collect_curve_losses(segment, losses);
            }
        }
        _ => {
            losses.insert(LOSS_ENTITY_OMITTED.to_owned());
        }
    }
}

fn atomic_save_ascii(drawing: &Drawing, target: &Path) -> Result<(), ProviderContractError> {
    if target.exists() {
        return Err(provider_message(
            "DXF export target already exists; refusing a non-atomic overwrite",
        ));
    }
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(provider_error)?;
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| provider_message("invalid DXF export filename"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(provider_error)?
        .as_nanos();
    let staging = parent.join(format!(
        ".{file_name}.hcad-stage-{}-{nonce}",
        std::process::id()
    ));
    let mut guard = IncompleteFile::new(staging.clone());
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(provider_error)?;
    let mut writer = BufWriter::new(file);
    drawing.save(&mut writer).map_err(provider_error)?;
    writer.flush().map_err(provider_error)?;
    let file = writer
        .into_inner()
        .map_err(|error| provider_message(error.to_string()))?;
    file.sync_all().map_err(provider_error)?;
    fs::rename(&staging, target).map_err(provider_error)?;
    guard.complete = true;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

struct IncompleteFile {
    path: PathBuf,
    complete: bool,
}

impl IncompleteFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            complete: false,
        }
    }
}

impl Drop for IncompleteFile {
    fn drop(&mut self) {
        if !self.complete {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn three_point_arc(
    start: Position,
    middle: Position,
    end: Position,
) -> Result<Arc, ProviderContractError> {
    if start.z != middle.z || middle.z != end.z {
        return Err(provider_message(LOSS_NON_XY_OCS));
    }
    let denominator = 2.0
        * (start.x * (middle.y - end.y)
            + middle.x * (end.y - start.y)
            + end.x * (start.y - middle.y));
    if denominator.abs() <= 1.0e-12 {
        return Err(provider_message("degenerate canonical circular arc"));
    }
    let start_sq = start.x * start.x + start.y * start.y;
    let middle_sq = middle.x * middle.x + middle.y * middle.y;
    let end_sq = end.x * end.x + end.y * end.y;
    let center_x = (start_sq * (middle.y - end.y)
        + middle_sq * (end.y - start.y)
        + end_sq * (start.y - middle.y))
        / denominator;
    let center_y = (start_sq * (end.x - middle.x)
        + middle_sq * (start.x - end.x)
        + end_sq * (middle.x - start.x))
        / denominator;
    let mut start_angle = (start.y - center_y).atan2(start.x - center_x).to_degrees();
    let middle_angle = (middle.y - center_y).atan2(middle.x - center_x);
    let mut end_angle = (end.y - center_y).atan2(end.x - center_x).to_degrees();
    if start_angle < 0.0 {
        start_angle += 360.0;
    }
    if end_angle < 0.0 {
        end_angle += 360.0;
    }
    let ccw_sweep = normalized_sweep(start_angle.to_radians(), end_angle.to_radians());
    let middle_sweep = normalized_sweep(start_angle.to_radians(), middle_angle);
    if middle_sweep > ccw_sweep {
        std::mem::swap(&mut start_angle, &mut end_angle);
    }
    Ok(Arc::new(
        Point::new(center_x, center_y, start.z.unwrap_or(0.0)),
        (start.x - center_x).hypot(start.y - center_y),
        start_angle,
        end_angle,
    ))
}

fn insert_transform(insert: &Insert) -> Transform3d {
    let angle = insert.rotation.to_radians();
    let (sin, cos) = angle.sin_cos();
    Transform3d([
        cos * insert.x_scale_factor,
        sin * insert.x_scale_factor,
        0.0,
        0.0,
        -sin * insert.y_scale_factor,
        cos * insert.y_scale_factor,
        0.0,
        0.0,
        0.0,
        0.0,
        insert.z_scale_factor,
        0.0,
        insert.location.x,
        insert.location.y,
        insert.location.z,
        1.0,
    ])
}

fn rotation_about_position(anchor: &Point, rotation_degrees: f64) -> Transform3d {
    let angle = rotation_degrees.to_radians();
    let (sin, cos) = angle.sin_cos();
    let translated_x = anchor.x - cos * anchor.x + sin * anchor.y;
    let translated_y = anchor.y - sin * anchor.x - cos * anchor.y;
    Transform3d([
        cos,
        sin,
        0.0,
        0.0,
        -sin,
        cos,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        translated_x,
        translated_y,
        0.0,
        1.0,
    ])
}

fn decompose_insert_transform(
    transform: Transform3d,
) -> Result<(Point, [f64; 3], f64), ProviderContractError> {
    let m = transform.0;
    if m[2].abs() > 1.0e-10
        || m[3].abs() > 1.0e-10
        || m[6].abs() > 1.0e-10
        || m[7].abs() > 1.0e-10
        || m[8].abs() > 1.0e-10
        || m[9].abs() > 1.0e-10
        || m[11].abs() > 1.0e-10
        || (m[15] - 1.0).abs() > 1.0e-10
    {
        return Err(provider_message(LOSS_NON_XY_OCS));
    }
    let sx = m[0].hypot(m[1]);
    let sy = m[4].hypot(m[5]);
    if sx <= f64::EPSILON || sy <= f64::EPSILON || m[10].abs() <= f64::EPSILON {
        return Err(provider_message("singular canonical block transform"));
    }
    let rotation = m[1].atan2(m[0]).to_degrees();
    if (m[4] + rotation.to_radians().sin() * sy).abs() > 1.0e-9
        || (m[5] - rotation.to_radians().cos() * sy).abs() > 1.0e-9
    {
        return Err(provider_message("DXF INSERT cannot represent shear"));
    }
    Ok((Point::new(m[12], m[13], m[14]), [sx, sy, m[10]], rotation))
}

fn color_to_resource(color: &Color) -> DxfColor {
    if color.is_by_layer() {
        DxfColor::ByLayer
    } else if color.is_by_block() {
        DxfColor::ByBlock
    } else if color.is_by_entity() {
        DxfColor::ByEntity
    } else {
        color.index().map_or(DxfColor::ByLayer, DxfColor::Index)
    }
}

fn resource_to_color(color: DxfColor) -> Color {
    match color {
        DxfColor::ByLayer => Color::by_layer(),
        DxfColor::ByBlock => Color::by_block(),
        DxfColor::ByEntity => Color::by_entity(),
        DxfColor::Index(value) => Color::from_index(value),
    }
}

fn position(value: &Point) -> Position {
    Position {
        x: value.x,
        y: value.y,
        z: Some(value.z),
    }
}

fn point(value: &Position) -> Point {
    Point::new(value.x, value.y, value.z.unwrap_or(0.0))
}

fn vector(value: &Vector) -> Vector3 {
    Vector3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

fn dxf_vector(value: Vector3) -> Vector {
    Vector::new(value.x, value.y, value.z)
}

fn vector_point(value: &Point) -> Vector3 {
    Vector3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

fn vector3_point(value: Vector3) -> Point {
    Point::new(value.x, value.y, value.z)
}

fn vector_length(value: Vector3) -> f64 {
    value.x.hypot(value.y).hypot(value.z)
}

fn circle_point(center: &Point, radius: f64, angle: f64) -> Position {
    Position {
        x: center.x + radius * angle.cos(),
        y: center.y + radius * angle.sin(),
        z: Some(center.z),
    }
}

fn normalized_sweep(start: f64, end: f64) -> f64 {
    let delta = end - start;
    if (delta.abs() - std::f64::consts::TAU).abs() <= 1.0e-10 {
        return std::f64::consts::TAU;
    }
    let mut sweep = delta % std::f64::consts::TAU;
    if sweep <= 0.0 {
        sweep += std::f64::consts::TAU;
    }
    sweep
}

fn ensure_z_normal(value: &Vector) -> Result<(), ProviderContractError> {
    if value.x.abs() <= 1.0e-12 && value.y.abs() <= 1.0e-12 && value.z > 0.0 {
        Ok(())
    } else {
        Err(provider_message(LOSS_NON_XY_OCS))
    }
}

fn stable_resource_id(kind: &str, source_hash: &str, source_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(source_hash.as_bytes());
    hasher.update([0]);
    hasher.update(source_id.as_bytes());
    format!("dxf-{kind}-{}", &hex::encode(hasher.finalize())[..24])
}

fn entity_display_name(entity: &Entity, index: usize) -> String {
    let kind = match &entity.specific {
        EntityType::ModelPoint(_) => "Point",
        EntityType::Line(_) => "Line",
        EntityType::LwPolyline(_) | EntityType::Polyline(_) => "Polyline",
        EntityType::Arc(_) => "Arc",
        EntityType::Circle(_) => "Circle",
        EntityType::Ellipse(_) => "Ellipse",
        EntityType::Spline(_) => "Spline",
        EntityType::Face3D(_) => "3D Face",
        EntityType::Text(_) | EntityType::MText(_) => "Text",
        EntityType::RotatedDimension(_)
        | EntityType::RadialDimension(_)
        | EntityType::DiameterDimension(_)
        | EntityType::AngularThreePointDimension(_)
        | EntityType::OrdinateDimension(_) => "Dimension",
        EntityType::Insert(value) => return format!("Block {}", value.name),
        _ => "DXF Entity",
    };
    format!("{kind} {}", index + 1)
}

fn reject_unaccepted_losses(
    required: &[String],
    accepted: &BTreeSet<String>,
) -> Result<(), ProviderContractError> {
    let missing = required
        .iter()
        .filter(|loss| !accepted.contains(*loss))
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(provider_message(format!(
            "DXF operation requires explicit acceptance of semantic losses: {}",
            missing.join(", ")
        )))
    }
}

fn check_cancelled(context: &dyn ProviderOperationContext) -> Result<(), ProviderContractError> {
    if context.is_cancelled() {
        Err(ProviderContractError::Cancelled)
    } else {
        Ok(())
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
    use crate::canonical_provider::{
        CanonicalExportProvider, CanonicalImportProvider, CanonicalImportRequest,
        ProviderOperationContext,
    };

    #[derive(Default)]
    struct TestContext {
        progress: Vec<ProviderProgress>,
    }

    impl ProviderOperationContext for TestContext {
        fn is_cancelled(&self) -> bool {
            false
        }

        fn report_progress(&mut self, progress: ProviderProgress) {
            self.progress.push(progress);
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        env::temp_dir().join(format!(
            "hcad-dxf-{name}-{}-{nonce}.dxf",
            std::process::id()
        ))
    }

    #[test]
    fn deterministic_zoo_round_trips_semantically_without_losses() {
        let source = temp_file("source");
        fs::write(
            &source,
            include_bytes!("../tests/fixtures/dxf/canonical-zoo.dxf"),
        )
        .expect("write fixture");
        let provider = DxfCanonicalProvider::new(env::temp_dir().join("hcad-dxf-test-resources"));
        let mut context = TestContext::default();
        let options = serde_json::json!({});
        let first = CanonicalImportProvider::import(
            &provider,
            CanonicalImportRequest {
                source: &source,
                format_id: DXF_FORMAT_ID,
                options: &options,
            },
            &mut context,
        )
        .expect("first import");
        assert!(first.admissions.len() >= 8);
        assert_eq!(
            first
                .admissions
                .iter()
                .filter(|admission| matches!(
                    admission.resolved_geometry,
                    GeometryObject::Text { .. }
                ))
                .count(),
            2
        );
        assert!(first.admissions.iter().any(|admission| matches!(
            &admission.resolved_geometry,
            GeometryObject::Extension { type_id, .. } if type_id == "hcad.dxf-dimension@1"
        )));
        assert_eq!(first.resource_sets.len(), 1);
        let target = temp_file("target");
        let export_options = serde_json::json!({
            "acceptedLossCodes": [LOSS_CANONICAL_IDENTITY],
        });
        let request = CanonicalExportRequest {
            target: &target,
            format_id: DXF_FORMAT_ID,
            package: &first,
            options: &export_options,
        };
        let plan = CanonicalExportProvider::plan_export(
            &provider,
            CanonicalExportRequest {
                target: request.target,
                format_id: request.format_id,
                package: request.package,
                options: request.options,
            },
        )
        .expect("plan");
        assert_eq!(plan.semantic_losses, vec![LOSS_CANONICAL_IDENTITY]);
        CanonicalExportProvider::export(&provider, request, &plan, &mut context).expect("export");
        let second = CanonicalImportProvider::import(
            &provider,
            CanonicalImportRequest {
                source: &target,
                format_id: DXF_FORMAT_ID,
                options: &options,
            },
            &mut context,
        )
        .expect("second import");
        assert_eq!(
            semantic_dxf_entities(&first),
            semantic_dxf_entities(&second)
        );
        let _ = fs::remove_file(source);
        let _ = fs::remove_file(target);
    }

    fn semantic_dxf_entities(package: &CanonicalImportPackage) -> Vec<String> {
        let objects = package
            .objects
            .iter()
            .map(|object| (object.object_hash.as_str(), object))
            .collect::<BTreeMap<_, _>>();
        let mut entities = package
            .admissions
            .iter()
            .map(|admission| match &admission.resolved_geometry {
                GeometryObject::Extension { .. } => {
                    let entity = exact_source_entity(admission, &objects)
                        .expect("source entity")
                        .expect("fixture extensions retain exact source entities");
                    serde_json::to_string(&entity.specific)
                        .expect("specific DXF extension semantics")
                }
                GeometryObject::Block { instance } => {
                    serde_json::to_string(&("block", instance.placement)).expect("block placement")
                }
                geometry => serde_json::to_string(&(geometry, admission.entity.placement))
                    .expect("canonical geometry and placement"),
            })
            .collect::<Vec<_>>();
        entities.sort();
        entities
    }

    #[test]
    fn hatch_requires_exact_loss_acceptance() {
        let source = temp_file("hatch");
        fs::write(
            &source,
            b"0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nHATCH\n8\n0\n0\nPOINT\n8\n0\n10\n1.0\n20\n2.0\n30\n3.0\n0\nENDSEC\n0\nEOF\n",
        )
        .expect("write hatch source");
        let provider = DxfCanonicalProvider::new(env::temp_dir().join("hcad-dxf-test-resources"));
        let mut context = TestContext::default();
        let error = CanonicalImportProvider::import(
            &provider,
            CanonicalImportRequest {
                source: &source,
                format_id: DXF_FORMAT_ID,
                options: &serde_json::json!({}),
            },
            &mut context,
        )
        .expect_err("unaccepted HATCH loss must fail");
        assert!(error.to_string().contains(LOSS_UNSUPPORTED_HATCH));
        let accepted = serde_json::json!({
            "acceptedLossCodes": [LOSS_UNSUPPORTED_HATCH],
        });
        let package = CanonicalImportProvider::import(
            &provider,
            CanonicalImportRequest {
                source: &source,
                format_id: DXF_FORMAT_ID,
                options: &accepted,
            },
            &mut context,
        )
        .expect("explicitly accepted HATCH omission");
        let target = temp_file("hatch-export");
        let plan = CanonicalExportProvider::plan_export(
            &provider,
            CanonicalExportRequest {
                target: &target,
                format_id: DXF_FORMAT_ID,
                package: &package,
                options: &accepted,
            },
        )
        .expect("loss plan");
        assert!(plan
            .semantic_losses
            .iter()
            .any(|loss| loss == LOSS_UNSUPPORTED_HATCH));
        let _ = fs::remove_file(source);
    }

    #[test]
    fn bulge_is_kept_as_analytic_arc_in_a_composite_curve() {
        let curve = polyline_with_bulges(
            vec![
                Position {
                    x: 0.0,
                    y: 0.0,
                    z: Some(0.0),
                },
                Position {
                    x: 2.0,
                    y: 0.0,
                    z: Some(0.0),
                },
            ],
            &[1.0, 0.0],
            false,
        )
        .expect("bulge curve");
        let CurveGeometry::Composite { segments } = curve else {
            panic!("bulge must produce composite geometry");
        };
        assert!(matches!(segments[0], CurveGeometry::CircularArc { .. }));
    }
}
