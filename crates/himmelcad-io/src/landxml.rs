//! Canonical `LandXML` 1.2 civil-data import and export.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, AlignmentGeometry, CanonicalEntity, CrossfallBand, CurveGeometry,
    ElevationSurfaceGeometry, EntityTypeId, GeometryObject, Position, Representation,
    RepresentationAuthority, RepresentationRole, StationFunction, StationValue,
    TriangleMeshGeometry, TriangleMeshStorage, Vector3, VerticalAlignmentSegment, WidthBand,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::writer::Writer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::canonical_provider::{
    CanonicalExportPlan, CanonicalExportProvider, CanonicalExportRequest, CanonicalImportPackage,
    CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject, ExportOutput,
    FormatCapability, FormatProviderDescriptor, ImportProbe, ImportProbeRequest,
    ProviderContractError, ProviderOperationContext, ProviderProgress, CANONICAL_IO_SCHEMA_VERSION,
};
use crate::landxml_dom::{parse_xml, XmlNode};

/// Canonical format identifier emitted by the `LandXML` 1.2 provider.
pub const LANDXML_FORMAT_ID: &str = "landxml@1.2";
/// Stable canonical provider identifier for `LandXML` 1.2.
pub const LANDXML_PROVIDER_ID: &str = "hcad.io.landxml@1";
const FORMAT_ID: &str = LANDXML_FORMAT_ID;
const PROVIDER_ID: &str = LANDXML_PROVIDER_ID;
const LANDXML_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.2";
const MAX_ENTITIES: usize = 250_000;
const MAX_SURFACE_VERTICES: usize = 1_000_000;
const MAX_SURFACE_TRIANGLES: usize = 2_000_000;
const MAX_CURVE_SEGMENTS: usize = 500_000;

const LOSS_UNSUPPORTED_ELEMENTS: &str = "hcad.landxml.unsupported-elements@1";
const LOSS_UNSUPPORTED_HORIZONTAL: &str = "hcad.landxml.unsupported-horizontal-geometry@1";
const LOSS_UNSUPPORTED_PROFILE: &str = "hcad.landxml.unsupported-profile-geometry@1";
const LOSS_CROSS_SECTION: &str = "hcad.landxml.cross-section-not-representable@1";
const LOSS_QUAD_TRIANGULATED: &str = "hcad.landxml.quad-face-triangulated@1";
const LOSS_CRS_UNSPECIFIED: &str = "hcad.landxml.crs-unspecified@1";
const LOSS_EXPORT_UNSUPPORTED_ENTITY: &str = "hcad.landxml.export-unsupported-entity@1";
const LOSS_EXPORT_UNSUPPORTED_CURVE: &str = "hcad.landxml.export-unsupported-curve@1";
const LOSS_EXPORT_CORRIDOR_BANDS: &str = "hcad.landxml.export-corridor-bands-omitted@1";
const LOSS_EXPORT_SPIRAL_NUMERIC: &str = "hcad.landxml.export-spiral-end-numeric@1";
const LOSS_EXPORT_NAME_DISAMBIGUATED: &str = "hcad.landxml.export-name-disambiguated@1";
const LOSS_EXPORT_METADATA: &str = "hcad.landxml.export-entity-metadata-omitted@1";
const LOSS_EXPORT_VERTICAL: &str = "hcad.landxml.export-vertical-profile-omitted@1";

/// `LandXML` 1.2 units retained without implicit conversion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LandXmlUnits {
    /// `Metric` or `Imperial` container name.
    pub system: String,
    /// Exact `LandXML` linear-unit token.
    pub linear_unit: String,
    /// Remaining unit attributes, preserved verbatim.
    pub attributes: BTreeMap<String, String>,
}

/// `LandXML` coordinate-system attributes retained without reprojection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LandXmlCoordinateSystem {
    /// Exact attribute map from `CoordinateSystem`.
    pub attributes: BTreeMap<String, String>,
}

/// Document-level import report copied into every imported entity's provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LandXmlImportReport {
    /// Source units; coordinate numbers remain in this unit.
    pub units: LandXmlUnits,
    /// Optional CRS metadata. No implicit transformation occurs.
    pub coordinate_system: Option<LandXmlCoordinateSystem>,
    /// Explicit `LandXML` tuple interpretation.
    pub coordinate_order: String,
    /// Unsupported local element names encountered by this provider version.
    pub unsupported_elements: Vec<String>,
    /// Namespaced semantic-loss codes.
    pub loss_codes: Vec<String>,
}

/// Strict `LandXML` parse, mapping, or write failure.
#[derive(Debug, Error)]
pub enum LandXmlError {
    /// Filesystem failure.
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    /// XML tokenizer failure.
    #[error("XML: {0}")]
    QuickXml(#[from] quick_xml::Error),
    /// XML attribute failure.
    #[error("XML attribute: {0}")]
    Attribute(#[from] quick_xml::events::attributes::AttrError),
    /// XML escape failure.
    #[error("XML escape: {0}")]
    Escape(#[from] quick_xml::escape::EscapeError),
    /// XML encoding failure.
    #[error("XML encoding: {0}")]
    Encoding(#[from] quick_xml::encoding::EncodingError),
    /// Structurally invalid XML or `LandXML` root.
    #[error("invalid XML: {0}")]
    Xml(String),
    /// Civil semantic validation failure.
    #[error("invalid LandXML semantics: {0}")]
    Semantic(String),
    /// Explicit parser bound was exceeded.
    #[error("LandXML import limit: {0}")]
    Limit(String),
    /// Cooperative cancellation was observed.
    #[error("LandXML operation was cancelled")]
    Cancelled,
}

/// Canonical import/export provider for the supported `LandXML` 1.2 civil subset.
pub struct LandXmlProvider {
    descriptor: FormatProviderDescriptor,
}

impl LandXmlProvider {
    /// Creates the stateless provider.
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "LandXML 1.2 Civil".to_owned(),
                format_ids: vec![FORMAT_ID.to_owned()],
                extensions: vec!["xml".to_owned(), "landxml".to_owned()],
                media_types: vec!["application/vnd.landxml+xml".to_owned()],
                capabilities: vec![FormatCapability::Import, FormatCapability::Export],
            },
        }
    }
}

impl Default for LandXmlProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CanonicalImportProvider for LandXmlProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let prefix = String::from_utf8_lossy(request.prefix);
        let magic = prefix.contains("<LandXML")
            && (prefix.contains("version=\"1.2\"") || prefix.contains("version='1.2'"));
        let extension = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("landxml") || value.eq_ignore_ascii_case("xml")
            });
        if !magic && !extension {
            return Ok(None);
        }
        Ok(Some(ImportProbe {
            format_id: FORMAT_ID.to_owned(),
            confidence: if magic { 100 } else { 25 },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: LandXmlImportOptions = serde_json::from_value(request.options.clone())
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        context.report_progress(ProviderProgress {
            phase: "landxml-parse".to_owned(),
            completed: 0,
            total: request
                .source
                .metadata()
                .ok()
                .map(|metadata| metadata.len()),
            message: "parsing bounded LandXML tree".to_owned(),
        });
        let root = parse_xml(request.source, context).map_err(provider_error)?;
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let document = parse_document(&root, context).map_err(provider_error)?;
        let entity_count = document.entities.len() as u64;
        context.report_progress(ProviderProgress {
            phase: "landxml-map".to_owned(),
            completed: 0,
            total: Some(entity_count),
            message: "validating canonical civil entities".to_owned(),
        });
        let package = build_package(document, options.import_namespace.as_deref(), context)
            .map_err(provider_error)?;
        context.report_progress(ProviderProgress {
            phase: "landxml-map".to_owned(),
            completed: entity_count,
            total: Some(entity_count),
            message: "validated canonical civil entities".to_owned(),
        });
        Ok(package)
    }
}

impl CanonicalExportProvider for LandXmlProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn plan_export(
        &self,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError> {
        plan_export(&request)
    }

    fn export(
        &self,
        request: CanonicalExportRequest<'_>,
        plan: &CanonicalExportPlan,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<(), ProviderContractError> {
        execute_export(&request, plan, context)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LandXmlImportOptions {
    import_namespace: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LandXmlExportOptions {
    units: Option<LandXmlUnits>,
    coordinate_system: Option<LandXmlCoordinateSystem>,
}

struct ParsedDocument {
    report: LandXmlImportReport,
    entities: Vec<ParsedEntity>,
}

struct ParsedEntity {
    source_key: String,
    source_kind: &'static str,
    name: String,
    geometry: GeometryObject,
    type_id: &'static str,
    details: serde_json::Value,
}

fn parse_document(
    root: &XmlNode,
    context: &mut dyn ProviderOperationContext,
) -> Result<ParsedDocument, LandXmlError> {
    if root.name != "LandXML" || root.attr("version") != Some("1.2") {
        return Err(LandXmlError::Semantic(
            "root must be LandXML with version=\"1.2\"".to_owned(),
        ));
    }
    if root
        .attr("xmlns")
        .is_some_and(|namespace| namespace != LANDXML_NAMESPACE)
    {
        return Err(LandXmlError::Semantic(
            "default namespace does not identify LandXML 1.2".to_owned(),
        ));
    }
    let units = parse_units(root)?;
    let coordinate_system = root
        .child("CoordinateSystem")
        .map(|node| LandXmlCoordinateSystem {
            attributes: node.attributes.clone(),
        });
    let unsupported_elements = collect_unsupported_elements(root, context)?;
    let mut losses = BTreeSet::new();
    if !unsupported_elements.is_empty() {
        losses.insert(LOSS_UNSUPPORTED_ELEMENTS.to_owned());
    }
    if coordinate_system.is_none() {
        losses.insert(LOSS_CRS_UNSPECIFIED.to_owned());
    }
    let point_references = collect_cg_point_references(root, context)?;
    let mut entities = parse_cg_points(root, &point_references, context)?;
    parse_plan_features(root, &point_references, &mut entities, &mut losses, context)?;
    parse_alignments(root, &point_references, &mut entities, &mut losses, context)?;
    parse_surfaces(root, &mut entities, &mut losses, context)?;
    if entities.is_empty() {
        return Err(LandXmlError::Semantic(
            "supported LandXML document contains no importable civil entities".to_owned(),
        ));
    }
    if entities.len() > MAX_ENTITIES {
        return Err(LandXmlError::Limit(format!(
            "LandXML exceeds {MAX_ENTITIES} canonical entities"
        )));
    }
    Ok(ParsedDocument {
        report: LandXmlImportReport {
            units,
            coordinate_system,
            coordinate_order: "northing,easting,elevation -> y,x,z".to_owned(),
            unsupported_elements,
            loss_codes: losses.into_iter().collect(),
        },
        entities,
    })
}

fn parse_units(root: &XmlNode) -> Result<LandXmlUnits, LandXmlError> {
    let units = root
        .child("Units")
        .ok_or_else(|| LandXmlError::Semantic("Units element is required".to_owned()))?;
    let unit_nodes = units
        .children
        .iter()
        .filter(|child| matches!(child.name.as_str(), "Metric" | "Imperial"))
        .collect::<Vec<_>>();
    if unit_nodes.len() != 1 {
        return Err(LandXmlError::Semantic(
            "Units must contain exactly one Metric or Imperial element".to_owned(),
        ));
    }
    let node = unit_nodes[0];
    let linear_unit = node
        .attr("linearUnit")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| LandXmlError::Semantic("linearUnit is required".to_owned()))?;
    Ok(LandXmlUnits {
        system: node.name.clone(),
        linear_unit: linear_unit.to_owned(),
        attributes: node.attributes.clone(),
    })
}

fn collect_cg_point_references(
    root: &XmlNode,
    context: &dyn ProviderOperationContext,
) -> Result<BTreeMap<String, Position>, LandXmlError> {
    let mut output = BTreeMap::new();
    let Some(points) = root.child("CgPoints") else {
        return Ok(output);
    };
    for (index, point) in points.children_named("CgPoint").enumerate() {
        check_mapping_cancel(context, index)?;
        let name = required_attr(point, "name")?;
        let position = parse_position_text(&point.text, true)?;
        if output.insert(name.to_owned(), position).is_some() {
            return Err(LandXmlError::Semantic(format!(
                "duplicate CgPoint name {name}"
            )));
        }
    }
    Ok(output)
}

fn parse_cg_points(
    root: &XmlNode,
    references: &BTreeMap<String, Position>,
    context: &mut dyn ProviderOperationContext,
) -> Result<Vec<ParsedEntity>, LandXmlError> {
    let Some(points) = root.child("CgPoints") else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    for (index, node) in points.children_named("CgPoint").enumerate() {
        check_mapping_cancel(context, index)?;
        let name = required_attr(node, "name")?;
        let position = *references
            .get(name)
            .ok_or_else(|| LandXmlError::Semantic(format!("missing CgPoint {name}")))?;
        output.push(ParsedEntity {
            source_key: format!("CgPoint/{name}"),
            source_kind: "CgPoint",
            name: name.to_owned(),
            geometry: GeometryObject::Point { position },
            type_id: built_in_type::POINT,
            details: serde_json::json!({
                "code": node.attr("code"),
                "desc": node.attr("desc"),
            }),
        });
    }
    Ok(output)
}

fn parse_plan_features(
    root: &XmlNode,
    references: &BTreeMap<String, Position>,
    output: &mut Vec<ParsedEntity>,
    losses: &mut BTreeSet<String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), LandXmlError> {
    let Some(features) = root.child("PlanFeatures") else {
        return Ok(());
    };
    let mut names = BTreeSet::new();
    for (index, feature) in features.children_named("PlanFeature").enumerate() {
        check_mapping_cancel(context, index)?;
        let name = feature
            .attr("name")
            .map_or_else(|| format!("PlanFeature-{}", index + 1), str::to_owned);
        if !names.insert(name.clone()) {
            return Err(LandXmlError::Semantic(format!(
                "duplicate PlanFeature name {name}"
            )));
        }
        let Some(coord_geom) = feature.child("CoordGeom") else {
            losses.insert(LOSS_UNSUPPORTED_HORIZONTAL.to_owned());
            continue;
        };
        let curve = parse_coord_geom(coord_geom, references, losses)?;
        output.push(ParsedEntity {
            source_key: format!("PlanFeature/{name}"),
            source_kind: "PlanFeature",
            name,
            geometry: GeometryObject::Curve {
                curve: Box::new(curve),
            },
            type_id: built_in_type::CURVE,
            details: serde_json::json!({ "desc": feature.attr("desc") }),
        });
    }
    Ok(())
}

fn parse_coord_geom(
    node: &XmlNode,
    references: &BTreeMap<String, Position>,
    losses: &mut BTreeSet<String>,
) -> Result<CurveGeometry, LandXmlError> {
    if node.children.len() > MAX_CURVE_SEGMENTS {
        return Err(LandXmlError::Limit(format!(
            "CoordGeom exceeds {MAX_CURVE_SEGMENTS} segments"
        )));
    }
    let mut segments = Vec::new();
    for segment in &node.children {
        let parsed = match segment.name.as_str() {
            "Line" => Some(parse_line(segment, references)?),
            "Curve" => Some(parse_arc(segment, references)?),
            "Spiral" => Some(parse_spiral(segment, references)?),
            _ => {
                losses.insert(LOSS_UNSUPPORTED_HORIZONTAL.to_owned());
                None
            }
        };
        if let Some(parsed) = parsed {
            segments.push(parsed);
        }
    }
    match segments.len() {
        0 => Err(LandXmlError::Semantic(
            "CoordGeom has no supported Line, Curve, or Spiral".to_owned(),
        )),
        1 => Ok(segments.remove(0)),
        _ => Ok(CurveGeometry::Composite { segments }),
    }
}

fn parse_line(
    node: &XmlNode,
    references: &BTreeMap<String, Position>,
) -> Result<CurveGeometry, LandXmlError> {
    Ok(CurveGeometry::LineSegment {
        start: parse_position_node(required_child(node, "Start")?, references)?,
        end: parse_position_node(required_child(node, "End")?, references)?,
    })
}

fn parse_arc(
    node: &XmlNode,
    references: &BTreeMap<String, Position>,
) -> Result<CurveGeometry, LandXmlError> {
    let start = parse_position_node(required_child(node, "Start")?, references)?;
    let center = parse_position_node(required_child(node, "Center")?, references)?;
    let end = parse_position_node(required_child(node, "End")?, references)?;
    let rotation = parse_rotation(required_attr(node, "rot")?)?;
    let start_angle = (start.y - center.y).atan2(start.x - center.x);
    let end_angle = (end.y - center.y).atan2(end.x - center.x);
    let sweep = if rotation < 0.0 {
        -((start_angle - end_angle).rem_euclid(std::f64::consts::TAU))
    } else {
        (end_angle - start_angle).rem_euclid(std::f64::consts::TAU)
    };
    if sweep.abs() <= f64::EPSILON {
        return Err(LandXmlError::Semantic("Curve has zero XY sweep".to_owned()));
    }
    let radius_start = (start.x - center.x).hypot(start.y - center.y);
    let radius_end = (end.x - center.x).hypot(end.y - center.y);
    let tolerance = radius_start.max(radius_end).max(1.0) * 1.0e-8;
    if radius_start <= f64::EPSILON || (radius_start - radius_end).abs() > tolerance {
        return Err(LandXmlError::Semantic(
            "Curve Start/Center/End do not define one circle".to_owned(),
        ));
    }
    let angle = start_angle + sweep * 0.5;
    let z = interpolate_optional_height(start.z, end.z, 0.5)?;
    Ok(CurveGeometry::CircularArc {
        start,
        point_on_arc: Position {
            x: center.x + radius_start * angle.cos(),
            y: center.y + radius_start * angle.sin(),
            z,
        },
        end,
    })
}

fn parse_spiral(
    node: &XmlNode,
    references: &BTreeMap<String, Position>,
) -> Result<CurveGeometry, LandXmlError> {
    if node
        .attr("spiType")
        .is_some_and(|value| !value.eq_ignore_ascii_case("clothoid"))
    {
        return Err(LandXmlError::Semantic(
            "only clothoid LandXML spirals are supported".to_owned(),
        ));
    }
    let start = parse_position_node(required_child(node, "Start")?, references)?;
    let direction_point = node
        .child("PI")
        .or_else(|| node.child("End"))
        .ok_or_else(|| LandXmlError::Semantic("Spiral requires PI or End".to_owned()))?;
    let direction_point = parse_position_node(direction_point, references)?;
    let dx = direction_point.x - start.x;
    let dy = direction_point.y - start.y;
    let length_xy = dx.hypot(dy);
    if length_xy <= f64::EPSILON {
        return Err(LandXmlError::Semantic(
            "Spiral start tangent is undefined".to_owned(),
        ));
    }
    let length = parse_positive_attr(node, "length")?;
    let rotation = parse_rotation(required_attr(node, "rot")?)?;
    let start_curvature = parse_radius(node.attr("radiusStart"), rotation)?;
    let end_curvature = parse_radius(node.attr("radiusEnd"), rotation)?;
    if start_curvature.abs() <= f64::EPSILON && end_curvature.abs() <= f64::EPSILON {
        return Err(LandXmlError::Semantic(
            "Spiral cannot have infinite radius at both ends".to_owned(),
        ));
    }
    Ok(CurveGeometry::Clothoid {
        start,
        start_tangent: Vector3 {
            x: dx / length_xy,
            y: dy / length_xy,
            z: 0.0,
        },
        start_curvature,
        end_curvature,
        length,
        plane: None,
    })
}

fn parse_alignments(
    root: &XmlNode,
    references: &BTreeMap<String, Position>,
    output: &mut Vec<ParsedEntity>,
    losses: &mut BTreeSet<String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), LandXmlError> {
    let Some(alignments) = root.child("Alignments") else {
        return Ok(());
    };
    let mut names = BTreeSet::new();
    for (index, alignment) in alignments.children_named("Alignment").enumerate() {
        check_mapping_cancel(context, index)?;
        let name = required_attr(alignment, "name")?.to_owned();
        if !names.insert(name.clone()) {
            return Err(LandXmlError::Semantic(format!(
                "duplicate Alignment name {name}"
            )));
        }
        let coord_geom = required_child(alignment, "CoordGeom")?;
        let horizontal = parse_coord_geom(coord_geom, references, losses)?;
        let vertical = parse_vertical_alignment(alignment, losses)?;
        let (width_bands, crossfall_bands, cross_section_details) =
            parse_cross_sections(alignment, losses)?;
        let station_origin = alignment
            .attr("staStart")
            .map(parse_finite)
            .transpose()?
            .unwrap_or(0.0);
        output.push(ParsedEntity {
            source_key: format!("Alignment/{name}"),
            source_kind: "Alignment",
            name,
            geometry: GeometryObject::Alignment {
                alignment: Box::new(AlignmentGeometry {
                    horizontal,
                    vertical,
                    station_origin,
                    width_bands,
                    crossfall_bands,
                    slope_rules: Vec::new(),
                }),
            },
            type_id: built_in_type::ALIGNMENT,
            details: serde_json::json!({
                "desc": alignment.attr("desc"),
                "sourceLength": alignment.attr("length"),
                "crossSections": cross_section_details,
            }),
        });
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct VerticalControl {
    station: f64,
    elevation: f64,
    parabola_length: Option<f64>,
}

#[allow(clippy::too_many_lines)]
fn parse_vertical_alignment(
    alignment: &XmlNode,
    losses: &mut BTreeSet<String>,
) -> Result<Vec<VerticalAlignmentSegment>, LandXmlError> {
    let profiles = alignment.descendants_named("ProfAlign");
    let Some(profile) = profiles.first() else {
        return Ok(Vec::new());
    };
    if profiles.len() > 1 {
        losses.insert(LOSS_UNSUPPORTED_PROFILE.to_owned());
    }
    let mut controls = Vec::new();
    for node in &profile.children {
        match node.name.as_str() {
            "PVI" => {
                let [station, elevation] = parse_pair(&node.text)?;
                controls.push(VerticalControl {
                    station,
                    elevation,
                    parabola_length: None,
                });
            }
            "ParaCurve" => {
                let [station, elevation] = parse_pair(&node.text)?;
                controls.push(VerticalControl {
                    station,
                    elevation,
                    parabola_length: Some(parse_positive_attr(node, "length")?),
                });
            }
            _ => {
                losses.insert(LOSS_UNSUPPORTED_PROFILE.to_owned());
            }
        }
    }
    if controls.is_empty() {
        return Ok(Vec::new());
    }
    if controls.len() < 2
        || !controls
            .windows(2)
            .all(|pair| pair[0].station < pair[1].station)
    {
        return Err(LandXmlError::Semantic(
            "ProfAlign controls must have strictly increasing stations".to_owned(),
        ));
    }
    if controls
        .first()
        .is_some_and(|control| control.parabola_length.is_some())
        || controls
            .last()
            .is_some_and(|control| control.parabola_length.is_some())
    {
        return Err(LandXmlError::Semantic(
            "ParaCurve cannot be the first or last vertical control".to_owned(),
        ));
    }

    let mut output = Vec::new();
    let mut cursor_station = controls[0].station;
    let mut cursor_elevation = controls[0].elevation;
    for index in 1..controls.len() - 1 {
        let control = controls[index];
        let incoming_grade = grade(controls[index - 1], control)?;
        if let Some(length) = control.parabola_length {
            let outgoing_grade = grade(control, controls[index + 1])?;
            let start_station = control.station - length * 0.5;
            let end_station = control.station + length * 0.5;
            if start_station < cursor_station || end_station >= controls[index + 1].station {
                return Err(LandXmlError::Semantic(
                    "ParaCurve overlaps another vertical control".to_owned(),
                ));
            }
            push_grade_segment(
                &mut output,
                &mut cursor_station,
                &mut cursor_elevation,
                start_station,
                incoming_grade,
            )?;
            let expected_start = control.elevation - incoming_grade * length * 0.5;
            if (cursor_elevation - expected_start).abs() > 1.0e-8 * expected_start.abs().max(1.0) {
                return Err(LandXmlError::Semantic(
                    "ParaCurve is not continuous with incoming PVI grade".to_owned(),
                ));
            }
            output.push(VerticalAlignmentSegment::Parabolic {
                start_station,
                start_elevation: expected_start,
                start_grade: incoming_grade,
                end_grade: outgoing_grade,
                length,
            });
            cursor_station = end_station;
            cursor_elevation = expected_start + (incoming_grade + outgoing_grade) * 0.5 * length;
        } else {
            push_grade_segment(
                &mut output,
                &mut cursor_station,
                &mut cursor_elevation,
                control.station,
                incoming_grade,
            )?;
        }
    }
    let last_index = controls.len() - 1;
    push_grade_segment(
        &mut output,
        &mut cursor_station,
        &mut cursor_elevation,
        controls[last_index].station,
        grade(controls[last_index - 1], controls[last_index])?,
    )?;
    Ok(output)
}

fn grade(start: VerticalControl, end: VerticalControl) -> Result<f64, LandXmlError> {
    let length = end.station - start.station;
    if !length.is_finite() || length <= 0.0 {
        return Err(LandXmlError::Semantic(
            "vertical grade has non-positive length".to_owned(),
        ));
    }
    let value = (end.elevation - start.elevation) / length;
    finite(value, "vertical grade")
}

fn push_grade_segment(
    output: &mut Vec<VerticalAlignmentSegment>,
    cursor_station: &mut f64,
    cursor_elevation: &mut f64,
    end_station: f64,
    grade: f64,
) -> Result<(), LandXmlError> {
    let length = end_station - *cursor_station;
    if length < -f64::EPSILON {
        return Err(LandXmlError::Semantic(
            "vertical controls overlap".to_owned(),
        ));
    }
    if length > f64::EPSILON {
        output.push(VerticalAlignmentSegment::Grade {
            start_station: *cursor_station,
            start_elevation: *cursor_elevation,
            grade,
            length,
        });
        *cursor_elevation += grade * length;
        *cursor_station = end_station;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrossSectionDetail {
    station: f64,
    surfaces: BTreeMap<String, Vec<[f64; 2]>>,
}

type CrossSectionMapping = (Vec<WidthBand>, Vec<CrossfallBand>, Vec<CrossSectionDetail>);

#[allow(clippy::too_many_lines)]
fn parse_cross_sections(
    alignment: &XmlNode,
    losses: &mut BTreeSet<String>,
) -> Result<CrossSectionMapping, LandXmlError> {
    let sections = alignment.descendants_named("CrossSect");
    if sections.is_empty() {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    let mut details = Vec::new();
    let mut samples = BTreeMap::<String, Vec<(f64, [f64; 2], [f64; 2])>>::new();
    let mut last_station = None;
    for section in sections {
        let station = parse_finite(required_attr(section, "sta")?)?;
        if last_station.is_some_and(|last| station <= last) {
            return Err(LandXmlError::Semantic(
                "CrossSect stations must be strictly increasing".to_owned(),
            ));
        }
        last_station = Some(station);
        let mut detail_surfaces = BTreeMap::new();
        for surface in section.children_named("CrossSectSurf") {
            let name = required_attr(surface, "name")?.to_owned();
            let points = surface
                .children_named("CrossSectPnt")
                .map(|point| parse_pair(&point.text))
                .collect::<Result<Vec<_>, _>>()?;
            if detail_surfaces
                .insert(name.clone(), points.clone())
                .is_some()
            {
                return Err(LandXmlError::Semantic(format!(
                    "CrossSect at station {station} contains duplicate surface {name}"
                )));
            }
            if points.len() != 2 {
                losses.insert(LOSS_CROSS_SECTION.to_owned());
                continue;
            }
            let first = points[0];
            let second = points[1];
            let offset_tolerance = first[0].abs().max(second[0].abs()).max(1.0) * 1.0e-12;
            if first[0] * second[0] < 0.0 || (first[0] - second[0]).abs() <= offset_tolerance {
                losses.insert(LOSS_CROSS_SECTION.to_owned());
                continue;
            }
            let (inner, outer) = if first[0].abs() <= second[0].abs() {
                (first, second)
            } else {
                (second, first)
            };
            samples
                .entry(name)
                .or_default()
                .push((station, inner, outer));
        }
        details.push(CrossSectionDetail {
            station,
            surfaces: detail_surfaces,
        });
    }

    let mut widths = Vec::new();
    let mut crossfalls = Vec::new();
    for (name, values) in samples {
        if values.len() != details.len() {
            losses.insert(LOSS_CROSS_SECTION.to_owned());
            continue;
        }
        let id = stable_band_id(&name);
        let inner_offset = StationFunction {
            samples: values
                .iter()
                .map(|(station, inner, _)| StationValue {
                    station: *station,
                    value: inner[0],
                })
                .collect(),
        };
        let outer_offset = StationFunction {
            samples: values
                .iter()
                .map(|(station, _, outer)| StationValue {
                    station: *station,
                    value: outer[0],
                })
                .collect(),
        };
        let crossfall = StationFunction {
            samples: values
                .iter()
                .map(|(station, inner, outer)| StationValue {
                    station: *station,
                    value: (outer[1] - inner[1]) / (outer[0] - inner[0]),
                })
                .collect(),
        };
        widths.push(WidthBand {
            id: id.clone(),
            inner_offset: inner_offset.clone(),
            outer_offset: outer_offset.clone(),
        });
        crossfalls.push(CrossfallBand {
            id,
            from_offset: inner_offset,
            to_offset: outer_offset,
            crossfall,
        });
    }
    Ok((widths, crossfalls, details))
}

fn stable_band_id(name: &str) -> String {
    let mut output = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    output = output.trim_matches('-').to_owned();
    if output.is_empty() {
        "band".clone_into(&mut output);
    }
    format!(
        "{output}-{}",
        &hex::encode(Sha256::digest(name.as_bytes()))[..12]
    )
}

fn parse_surfaces(
    root: &XmlNode,
    output: &mut Vec<ParsedEntity>,
    losses: &mut BTreeSet<String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), LandXmlError> {
    let Some(surfaces) = root.child("Surfaces") else {
        return Ok(());
    };
    let mut names = BTreeSet::new();
    for (surface_index, surface) in surfaces.children_named("Surface").enumerate() {
        check_mapping_cancel(context, surface_index)?;
        let name = required_attr(surface, "name")?.to_owned();
        if !names.insert(name.clone()) {
            return Err(LandXmlError::Semantic(format!(
                "duplicate Surface name {name}"
            )));
        }
        let definition = required_child(surface, "Definition")?;
        if definition.attr("surfType") != Some("TIN") {
            losses.insert(LOSS_UNSUPPORTED_ELEMENTS.to_owned());
            continue;
        }
        let point_nodes = required_child(definition, "Pnts")?;
        let mut point_ids = BTreeMap::new();
        let mut positions = Vec::new();
        for (point_index, point) in point_nodes.children_named("P").enumerate() {
            check_mapping_cancel(context, point_index)?;
            if positions.len() >= MAX_SURFACE_VERTICES {
                return Err(LandXmlError::Limit(format!(
                    "surface {name} exceeds {MAX_SURFACE_VERTICES} vertices"
                )));
            }
            let id = required_attr(point, "id")?.to_owned();
            let position = parse_vector3_text(&point.text)?;
            let index = u32::try_from(positions.len())
                .map_err(|_| LandXmlError::Limit("surface vertex index exceeds u32".to_owned()))?;
            if point_ids.insert(id.clone(), index).is_some() {
                return Err(LandXmlError::Semantic(format!(
                    "surface {name} contains duplicate point id {id}"
                )));
            }
            positions.push(position);
        }
        let face_nodes = required_child(definition, "Faces")?;
        let mut indices = Vec::new();
        for (face_index, face) in face_nodes.children_named("F").enumerate() {
            check_mapping_cancel(context, face_index)?;
            let refs = split_tokens(&face.text);
            if !matches!(refs.len(), 3 | 4) {
                return Err(LandXmlError::Semantic(format!(
                    "surface {name} face must contain three or four point ids"
                )));
            }
            let resolved = refs
                .iter()
                .map(|id| {
                    point_ids.get(*id).copied().ok_or_else(|| {
                        LandXmlError::Semantic(format!(
                            "surface {name} face references unknown point id {id}"
                        ))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            indices.extend_from_slice(&resolved[..3]);
            if resolved.len() == 4 {
                indices.extend_from_slice(&[resolved[0], resolved[2], resolved[3]]);
                losses.insert(LOSS_QUAD_TRIANGULATED.to_owned());
            }
            if indices.len() / 3 > MAX_SURFACE_TRIANGLES {
                return Err(LandXmlError::Limit(format!(
                    "surface {name} exceeds {MAX_SURFACE_TRIANGLES} triangles"
                )));
            }
        }
        let breaklines = parse_breaklines(definition, &point_ids, &positions)?;
        let geometry = GeometryObject::ElevationSurface {
            surface: Box::new(ElevationSurfaceGeometry::Tin {
                mesh: TriangleMeshGeometry {
                    storage: TriangleMeshStorage::Inline {
                        positions,
                        indices,
                        normals: None,
                        texture_coordinates: None,
                    },
                    closed_manifold: false,
                    triangle_material_slots: None,
                    materials: None,
                },
                breaklines,
            }),
        };
        output.push(ParsedEntity {
            source_key: format!("Surface/{name}"),
            source_kind: "Surface",
            name,
            geometry,
            type_id: built_in_type::ELEVATION_SURFACE,
            details: serde_json::json!({
                "desc": surface.attr("desc"),
                "sourceType": definition.attr("surfType"),
            }),
        });
    }
    Ok(())
}

fn parse_breaklines(
    definition: &XmlNode,
    point_ids: &BTreeMap<String, u32>,
    positions: &[Vector3],
) -> Result<Vec<CurveGeometry>, LandXmlError> {
    let Some(container) = definition.child("Breaklines") else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    for breakline in container.children_named("Breakline") {
        let values = if let Some(list) = breakline.child("PntList3D") {
            parse_vector3_list(&list.text)?
        } else if let Some(list) = breakline.child("PntRefList3D") {
            split_tokens(&list.text)
                .iter()
                .map(|id| {
                    let index = point_ids.get(*id).ok_or_else(|| {
                        LandXmlError::Semantic(format!(
                            "breakline references unknown surface point id {id}"
                        ))
                    })?;
                    Ok(positions[*index as usize])
                })
                .collect::<Result<Vec<_>, LandXmlError>>()?
        } else {
            return Err(LandXmlError::Semantic(
                "Breakline requires PntList3D or PntRefList3D".to_owned(),
            ));
        };
        if values.len() < 2 {
            return Err(LandXmlError::Semantic(
                "Breakline requires at least two points".to_owned(),
            ));
        }
        output.push(CurveGeometry::Polyline {
            positions: values
                .into_iter()
                .map(|value| Position {
                    x: value.x,
                    y: value.y,
                    z: Some(value.z),
                })
                .collect(),
            closed: false,
        });
    }
    Ok(output)
}

fn build_package(
    document: ParsedDocument,
    import_namespace: Option<&str>,
    context: &dyn ProviderOperationContext,
) -> Result<CanonicalImportPackage, LandXmlError> {
    if import_namespace.is_some_and(|value| value.trim().is_empty() || value.contains('\0')) {
        return Err(LandXmlError::Semantic(
            "importNamespace must be non-empty and contain no NUL".to_owned(),
        ));
    }
    let namespace = import_namespace.unwrap_or("default");
    let report_value = serde_json::to_value(&document.report)
        .map_err(|error| LandXmlError::Semantic(error.to_string()))?;
    let report_hash = ObjectHash::of_bytes(
        &serde_json::to_vec(&report_value)
            .map_err(|error| LandXmlError::Semantic(error.to_string()))?,
    );
    let mut object_map = BTreeMap::<String, CanonicalJsonObject>::new();
    let relations = intern_object(
        &mut object_map,
        "application/vnd.himmelcad.relations+json",
        serde_json::json!([]),
    )?;
    let mut admissions = Vec::with_capacity(document.entities.len());
    for (index, parsed) in document.entities.into_iter().enumerate() {
        check_mapping_cancel(context, index)?;
        let geometry_ref = geometry_object_content_hash(&parsed.geometry)
            .map_err(|error| LandXmlError::Semantic(error.to_string()))?;
        let entity_id = stable_entity_id(namespace, &report_hash, &parsed.source_key);
        let components = intern_object(
            &mut object_map,
            "application/vnd.himmelcad.components+json",
            serde_json::json!({
                "hcad.landxml-source@1": {
                    "sourceKey": parsed.source_key,
                    "sourceKind": parsed.source_kind,
                }
            }),
        )?;
        let attributes = intern_object(
            &mut object_map,
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.landxml-import@1": {
                    "document": report_value,
                    "sourceKey": parsed.source_key,
                    "sourceKind": parsed.source_kind,
                    "details": parsed.details,
                }
            }),
        )?;
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref,
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id),
            revision: 0,
            type_id: EntityTypeId(parsed.type_id.to_owned()),
            name: parsed.name,
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![selected.clone()],
            components_ref: components,
            attributes_ref: attributes,
            relations_ref: relations.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized LandXML entity"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity)
            .map_err(|error| LandXmlError::Semantic(error.to_string()))?;
        validate_resolved_representation(&entity, &selected, &parsed.geometry)
            .map_err(|error| LandXmlError::Semantic(error.to_string()))?;
        admissions.push(CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot: "source".to_owned(),
            expected_generation: None,
            resolved_geometry: parsed.geometry,
        });
    }
    let package = CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: PROVIDER_ID.to_owned(),
        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
        admissions,
        objects: object_map.into_values().collect(),
        datasets: Vec::new(),
        resource_sets: Vec::new(),
        presentation_resources: Default::default(),
    };
    package
        .validate()
        .map_err(|error| LandXmlError::Semantic(error.to_string()))?;
    Ok(package)
}

fn intern_object(
    objects: &mut BTreeMap<String, CanonicalJsonObject>,
    media_type: &str,
    value: serde_json::Value,
) -> Result<ObjectHash, LandXmlError> {
    let object = CanonicalJsonObject::new(media_type, value)
        .map_err(|error| LandXmlError::Semantic(error.to_string()))?;
    let hash = object.object_hash.clone();
    objects.entry(hash.0.clone()).or_insert(object);
    Ok(hash)
}

fn stable_entity_id(namespace: &str, report_hash: &ObjectHash, source_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(PROVIDER_ID.as_bytes());
    digest.update([0]);
    digest.update(namespace.as_bytes());
    digest.update([0]);
    digest.update(report_hash.as_str().as_bytes());
    digest.update([0]);
    digest.update(source_key.as_bytes());
    format!("entity-landxml-{}", hex::encode(digest.finalize()))
}

fn required_attr<'a>(node: &'a XmlNode, name: &str) -> Result<&'a str, LandXmlError> {
    node.attr(name)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| LandXmlError::Semantic(format!("{} requires attribute {name}", node.name)))
}

fn required_child<'a>(node: &'a XmlNode, name: &str) -> Result<&'a XmlNode, LandXmlError> {
    node.child(name)
        .ok_or_else(|| LandXmlError::Semantic(format!("{} requires child {name}", node.name)))
}

fn split_tokens(text: &str) -> Vec<&str> {
    text.split_ascii_whitespace().collect()
}

fn parse_finite(value: &str) -> Result<f64, LandXmlError> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| LandXmlError::Semantic(format!("invalid finite number {value:?}")))?;
    finite(parsed, "number")
}

fn finite(value: f64, label: &str) -> Result<f64, LandXmlError> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(LandXmlError::Semantic(format!("{label} must be finite")))
    }
}

fn parse_positive_attr(node: &XmlNode, name: &str) -> Result<f64, LandXmlError> {
    let value = parse_finite(required_attr(node, name)?)?;
    if value > 0.0 {
        Ok(value)
    } else {
        Err(LandXmlError::Semantic(format!(
            "{} attribute {name} must be positive",
            node.name
        )))
    }
}

fn parse_pair(text: &str) -> Result<[f64; 2], LandXmlError> {
    let tokens = split_tokens(text);
    if tokens.len() != 2 {
        return Err(LandXmlError::Semantic(format!(
            "expected two numeric values, found {}",
            tokens.len()
        )));
    }
    Ok([parse_finite(tokens[0])?, parse_finite(tokens[1])?])
}

fn parse_position_text(text: &str, allow_2d: bool) -> Result<Position, LandXmlError> {
    let tokens = split_tokens(text);
    if !matches!(tokens.len(), 2 | 3) || (!allow_2d && tokens.len() != 3) {
        return Err(LandXmlError::Semantic(format!(
            "expected northing easting{} tuple, found {} values",
            if allow_2d {
                " [elevation]"
            } else {
                " elevation"
            },
            tokens.len()
        )));
    }
    Ok(Position {
        x: parse_finite(tokens[1])?,
        y: parse_finite(tokens[0])?,
        z: tokens.get(2).map(|value| parse_finite(value)).transpose()?,
    })
}

fn parse_vector3_text(text: &str) -> Result<Vector3, LandXmlError> {
    let position = parse_position_text(text, false)?;
    Ok(Vector3 {
        x: position.x,
        y: position.y,
        z: position.z.expect("3D parser requires elevation"),
    })
}

fn parse_vector3_list(text: &str) -> Result<Vec<Vector3>, LandXmlError> {
    let tokens = split_tokens(text);
    if tokens.len() < 6 || !tokens.len().is_multiple_of(3) {
        return Err(LandXmlError::Semantic(
            "PntList3D requires at least two northing/easting/elevation tuples".to_owned(),
        ));
    }
    tokens
        .chunks_exact(3)
        .map(|tuple| {
            Ok(Vector3 {
                x: parse_finite(tuple[1])?,
                y: parse_finite(tuple[0])?,
                z: parse_finite(tuple[2])?,
            })
        })
        .collect()
}

fn parse_position_node(
    node: &XmlNode,
    references: &BTreeMap<String, Position>,
) -> Result<Position, LandXmlError> {
    if let Some(reference) = node.attr("pntRef") {
        if !node.text.trim().is_empty() {
            return Err(LandXmlError::Semantic(format!(
                "{} cannot contain both pntRef and coordinates",
                node.name
            )));
        }
        references.get(reference).copied().ok_or_else(|| {
            LandXmlError::Semantic(format!(
                "{} references unknown CgPoint {reference}",
                node.name
            ))
        })
    } else {
        parse_position_text(&node.text, true)
    }
}

fn parse_rotation(value: &str) -> Result<f64, LandXmlError> {
    if value.eq_ignore_ascii_case("cw") {
        Ok(-1.0)
    } else if value.eq_ignore_ascii_case("ccw") {
        Ok(1.0)
    } else {
        Err(LandXmlError::Semantic(format!(
            "rotation must be cw or ccw, found {value}"
        )))
    }
}

fn parse_radius(value: Option<&str>, rotation: f64) -> Result<f64, LandXmlError> {
    let value = value.ok_or_else(|| {
        LandXmlError::Semantic("Spiral requires radiusStart and radiusEnd".to_owned())
    })?;
    if matches!(value.to_ascii_uppercase().as_str(), "INF" | "INFINITY") {
        Ok(0.0)
    } else {
        let radius = parse_finite(value)?;
        if radius <= 0.0 {
            Err(LandXmlError::Semantic(
                "spiral radius must be positive or INF".to_owned(),
            ))
        } else {
            Ok(rotation / radius)
        }
    }
}

fn interpolate_optional_height(
    start: Option<f64>,
    end: Option<f64>,
    parameter: f64,
) -> Result<Option<f64>, LandXmlError> {
    match (start, end) {
        (Some(start), Some(end)) => Ok(Some(start + (end - start) * parameter)),
        (None, None) => Ok(None),
        _ => Err(LandXmlError::Semantic(
            "arc endpoints must either both have elevation or both omit it".to_owned(),
        )),
    }
}

fn collect_unsupported_elements(
    root: &XmlNode,
    context: &dyn ProviderOperationContext,
) -> Result<Vec<String>, LandXmlError> {
    const KNOWN: &[&str] = &[
        "LandXML",
        "Units",
        "Metric",
        "Imperial",
        "CoordinateSystem",
        "CgPoints",
        "CgPoint",
        "PlanFeatures",
        "PlanFeature",
        "Alignments",
        "Alignment",
        "CoordGeom",
        "Line",
        "Curve",
        "Spiral",
        "Start",
        "Center",
        "PI",
        "End",
        "Profile",
        "ProfAlign",
        "PVI",
        "ParaCurve",
        "CrossSects",
        "CrossSect",
        "CrossSectSurf",
        "CrossSectPnt",
        "Surfaces",
        "Surface",
        "Definition",
        "Pnts",
        "P",
        "Faces",
        "F",
        "Breaklines",
        "Breakline",
        "PntList3D",
        "PntRefList3D",
    ];
    fn visit(
        node: &XmlNode,
        output: &mut BTreeSet<String>,
        context: &dyn ProviderOperationContext,
        visited: &mut usize,
    ) -> Result<(), LandXmlError> {
        check_mapping_cancel(context, *visited)?;
        *visited = visited.saturating_add(1);
        if !KNOWN.contains(&node.name.as_str()) {
            output.insert(node.name.clone());
        }
        for child in &node.children {
            visit(child, output, context, visited)?;
        }
        Ok(())
    }
    let mut output = BTreeSet::new();
    let mut visited = 0;
    visit(root, &mut output, context, &mut visited)?;
    Ok(output.into_iter().collect())
}

fn provider_error(error: LandXmlError) -> ProviderContractError {
    match error {
        LandXmlError::Cancelled => ProviderContractError::Cancelled,
        other => ProviderContractError::Provider(other.to_string()),
    }
}

fn check_mapping_cancel(
    context: &dyn ProviderOperationContext,
    index: usize,
) -> Result<(), LandXmlError> {
    if index.is_multiple_of(1_024) && context.is_cancelled() {
        Err(LandXmlError::Cancelled)
    } else {
        Ok(())
    }
}

fn plan_export(
    request: &CanonicalExportRequest<'_>,
) -> Result<CanonicalExportPlan, ProviderContractError> {
    if request.format_id != FORMAT_ID {
        return Err(ProviderContractError::UnsupportedFormat);
    }
    request.package.validate()?;
    let options: LandXmlExportOptions = serde_json::from_value(request.options.clone())
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    let _metadata = resolve_export_metadata(request.package, &options)?;
    let output_name = request
        .target
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            ProviderContractError::Provider("export target needs a file name".to_owned())
        })?;
    let mut losses = imported_loss_codes(request.package)?;
    let mut names = BTreeSet::new();
    for admission in &request.package.admissions {
        if admission.entity.placement.is_some() {
            losses.insert(LOSS_EXPORT_UNSUPPORTED_ENTITY.to_owned());
        }
        if admission.entity.owner.is_some()
            || !admission.entity.layer_ids.is_empty()
            || admission.entity.style_ref.is_some()
            || has_non_landxml_metadata(request.package, admission)?
        {
            losses.insert(LOSS_EXPORT_METADATA.to_owned());
        }
        collect_export_losses(&admission.resolved_geometry, &mut losses);
        let key = (
            export_group(&admission.resolved_geometry),
            admission.entity.name.clone(),
        );
        if admission.entity.name.trim().is_empty() {
            losses.insert(LOSS_EXPORT_NAME_DISAMBIGUATED.to_owned());
        }
        if !names.insert(key) {
            losses.insert(LOSS_EXPORT_NAME_DISAMBIGUATED.to_owned());
        }
    }
    Ok(CanonicalExportPlan {
        format_id: FORMAT_ID.to_owned(),
        outputs: vec![ExportOutput {
            relative_path: PathBuf::from(output_name),
            media_type: "application/vnd.landxml+xml".to_owned(),
        }],
        semantic_losses: losses.into_iter().collect(),
    })
}

fn resolve_export_metadata(
    package: &CanonicalImportPackage,
    options: &LandXmlExportOptions,
) -> Result<(LandXmlUnits, Option<LandXmlCoordinateSystem>), ProviderContractError> {
    let imported = package_report(package)?;
    let units = options
        .units
        .clone()
        .or_else(|| imported.as_ref().map(|report| report.units.clone()))
        .ok_or_else(|| {
            ProviderContractError::Provider(
                "LandXML export requires explicit units or LandXML import provenance".to_owned(),
            )
        })?;
    if units.linear_unit.trim().is_empty()
        || !matches!(units.system.as_str(), "Metric" | "Imperial")
    {
        return Err(ProviderContractError::Provider(
            "LandXML export units are invalid".to_owned(),
        ));
    }
    let coordinate_system = options.coordinate_system.clone().or_else(|| {
        imported
            .as_ref()
            .and_then(|report| report.coordinate_system.clone())
    });
    Ok((units, coordinate_system))
}

fn package_report(
    package: &CanonicalImportPackage,
) -> Result<Option<LandXmlImportReport>, ProviderContractError> {
    let mut selected = None;
    for admission in &package.admissions {
        let Some(object) = package
            .objects
            .iter()
            .find(|object| object.object_hash == admission.entity.attributes_ref)
        else {
            return Err(ProviderContractError::MissingEntityObject);
        };
        let Some(document) = object
            .value
            .get("hcad.landxml-import@1")
            .and_then(|value| value.get("document"))
        else {
            continue;
        };
        let report: LandXmlImportReport = serde_json::from_value(document.clone())
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        if selected
            .as_ref()
            .is_some_and(|existing| existing != &report)
        {
            return Err(ProviderContractError::Provider(
                "selected entities carry incompatible LandXML document metadata".to_owned(),
            ));
        }
        selected = Some(report);
    }
    Ok(selected)
}

fn imported_loss_codes(
    package: &CanonicalImportPackage,
) -> Result<BTreeSet<String>, ProviderContractError> {
    Ok(package_report(package)?
        .map(|report| report.loss_codes.into_iter().collect())
        .unwrap_or_default())
}

fn has_non_landxml_metadata(
    package: &CanonicalImportPackage,
    admission: &CanonicalRepresentationAdmission,
) -> Result<bool, ProviderContractError> {
    let object = package
        .objects
        .iter()
        .find(|object| object.object_hash == admission.entity.attributes_ref)
        .ok_or(ProviderContractError::MissingEntityObject)?;
    let attributes_are_lossy = object.value.as_object().is_some_and(|attributes| {
        attributes.iter().any(|(key, value)| {
            if key != "hcad.landxml-import@1" {
                return true;
            }
            value
                .get("details")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|details| {
                    details.iter().any(|(detail_key, detail)| {
                        detail_key != "sourceType" && json_has_value(detail)
                    })
                })
        })
    });
    let components = package
        .objects
        .iter()
        .find(|object| object.object_hash == admission.entity.components_ref)
        .ok_or(ProviderContractError::MissingEntityObject)?;
    let components_are_lossy = components
        .value
        .as_object()
        .is_some_and(|values| values.keys().any(|key| key != "hcad.landxml-source@1"));
    let relations = package
        .objects
        .iter()
        .find(|object| object.object_hash == admission.entity.relations_ref)
        .ok_or(ProviderContractError::MissingEntityObject)?;
    let relations_are_lossy = relations
        .value
        .as_array()
        .is_none_or(|values| !values.is_empty());
    Ok(attributes_are_lossy || components_are_lossy || relations_are_lossy)
}

fn json_has_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(values) => values.iter().any(json_has_value),
        serde_json::Value::Object(values) => values.values().any(json_has_value),
    }
}

fn export_group(geometry: &GeometryObject) -> &'static str {
    match geometry {
        GeometryObject::Point { .. } => "point",
        GeometryObject::Curve { .. } => "plan-feature",
        GeometryObject::Alignment { .. } => "alignment",
        GeometryObject::ElevationSurface { .. } => "surface",
        _ => "unsupported",
    }
}

fn collect_export_losses(geometry: &GeometryObject, losses: &mut BTreeSet<String>) {
    match geometry {
        GeometryObject::Point { .. } => {}
        GeometryObject::Curve { curve } => collect_curve_losses(curve, losses),
        GeometryObject::Alignment { alignment } => {
            collect_curve_losses(&alignment.horizontal, losses);
            if !vertical_continuous(&alignment.vertical) {
                losses.insert(LOSS_EXPORT_VERTICAL.to_owned());
            }
            if !alignment.width_bands.is_empty()
                || !alignment.crossfall_bands.is_empty()
                || !alignment.slope_rules.is_empty()
            {
                losses.insert(LOSS_EXPORT_CORRIDOR_BANDS.to_owned());
            }
        }
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, breaklines } => {
                if !matches!(mesh.storage, TriangleMeshStorage::Inline { .. }) {
                    losses.insert(LOSS_EXPORT_UNSUPPORTED_ENTITY.to_owned());
                }
                if mesh.materials.is_some()
                    || mesh.triangle_material_slots.is_some()
                    || matches!(
                        &mesh.storage,
                        TriangleMeshStorage::Inline {
                            normals: Some(_),
                            ..
                        } | TriangleMeshStorage::Inline {
                            texture_coordinates: Some(_),
                            ..
                        }
                    )
                {
                    losses.insert(LOSS_EXPORT_METADATA.to_owned());
                }
                for breakline in breaklines {
                    if !matches!(
                        breakline,
                        CurveGeometry::Polyline { positions, .. }
                            if positions.iter().all(|position| position.z.is_some())
                    ) {
                        losses.insert(LOSS_EXPORT_UNSUPPORTED_CURVE.to_owned());
                    }
                }
            }
            ElevationSurfaceGeometry::Grid { .. } => {
                losses.insert(LOSS_EXPORT_UNSUPPORTED_ENTITY.to_owned());
            }
        },
        _ => {
            losses.insert(LOSS_EXPORT_UNSUPPORTED_ENTITY.to_owned());
        }
    }
}

fn collect_curve_losses(curve: &CurveGeometry, losses: &mut BTreeSet<String>) {
    match curve {
        CurveGeometry::LineSegment { .. } | CurveGeometry::Polyline { .. } => {}
        CurveGeometry::CircularArc { .. } => {
            if arc_center(curve).is_none() {
                losses.insert(LOSS_EXPORT_UNSUPPORTED_CURVE.to_owned());
            }
        }
        CurveGeometry::Clothoid {
            start_curvature,
            end_curvature,
            ..
        } => {
            if *start_curvature != 0.0
                && *end_curvature != 0.0
                && start_curvature.signum() != end_curvature.signum()
            {
                losses.insert(LOSS_EXPORT_UNSUPPORTED_CURVE.to_owned());
            } else {
                losses.insert(LOSS_EXPORT_SPIRAL_NUMERIC.to_owned());
            }
        }
        CurveGeometry::Composite { segments } => {
            for segment in segments {
                collect_curve_losses(segment, losses);
            }
        }
        _ => {
            losses.insert(LOSS_EXPORT_UNSUPPORTED_CURVE.to_owned());
        }
    }
}

fn execute_export(
    request: &CanonicalExportRequest<'_>,
    plan: &CanonicalExportPlan,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let expected = plan_export(&CanonicalExportRequest {
        target: request.target,
        format_id: request.format_id,
        package: request.package,
        options: request.options,
    })?;
    if plan != &expected {
        return Err(ProviderContractError::Provider(
            "LandXML export plan changed before execution".to_owned(),
        ));
    }
    if context.is_cancelled() {
        return Err(ProviderContractError::Cancelled);
    }
    if request.target.exists() {
        return Err(ProviderContractError::Provider(
            "LandXML export target already exists; refusing a non-atomic overwrite".to_owned(),
        ));
    }
    let options: LandXmlExportOptions = serde_json::from_value(request.options.clone())
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    let metadata = resolve_export_metadata(request.package, &options)?;
    let parent = request.target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    let file_name = request
        .target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ProviderContractError::Provider("invalid export file name".to_owned()))?;
    let staging_path = parent.join(format!(
        ".{file_name}.landxml-{}-{}.tmp",
        std::process::id(),
        export_nonce(request.package)
    ));
    let mut staging = AtomicOutput::create(staging_path)?;
    context.report_progress(ProviderProgress {
        phase: "landxml-write".to_owned(),
        completed: 0,
        total: Some(request.package.admissions.len() as u64),
        message: "writing staged LandXML 1.2".to_owned(),
    });
    write_landxml(
        staging.file_mut(),
        request.package,
        &metadata.0,
        metadata.1.as_ref(),
        context,
    )?;
    staging
        .file_mut()
        .flush()
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    staging
        .file_mut()
        .get_ref()
        .sync_all()
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    if context.is_cancelled() {
        return Err(ProviderContractError::Cancelled);
    }
    staging.publish(request.target)?;
    Ok(())
}

struct AtomicOutput {
    path: PathBuf,
    file: Option<BufWriter<File>>,
    published: bool,
}

impl AtomicOutput {
    fn create(path: PathBuf) -> Result<Self, ProviderContractError> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        Ok(Self {
            path,
            file: Some(BufWriter::new(file)),
            published: false,
        })
    }

    fn file_mut(&mut self) -> &mut BufWriter<File> {
        self.file.as_mut().expect("staging file remains open")
    }

    fn publish(&mut self, target: &Path) -> Result<(), ProviderContractError> {
        let writer = self.file.take().expect("staging file remains open");
        writer
            .into_inner()
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        std::fs::rename(&self.path, target)
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        self.published = true;
        Ok(())
    }
}

impl Drop for AtomicOutput {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn export_nonce(package: &CanonicalImportPackage) -> String {
    let mut digest = Sha256::new();
    for admission in &package.admissions {
        digest.update(admission.entity.version_hash.as_str().as_bytes());
    }
    hex::encode(digest.finalize())[..16].to_owned()
}

fn write_landxml(
    output: &mut BufWriter<File>,
    package: &CanonicalImportPackage,
    units: &LandXmlUnits,
    coordinate_system: Option<&LandXmlCoordinateSystem>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let mut writer = Writer::new_with_indent(output, b' ', 2);
    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .map_err(|error| write_error(&error))?;
    write_start(
        &mut writer,
        "LandXML",
        &[
            ("xmlns", LANDXML_NAMESPACE.to_owned()),
            ("version", "1.2".to_owned()),
        ],
    )?;
    write_units(&mut writer, units)?;
    if let Some(coordinate_system) = coordinate_system {
        write_empty_map(
            &mut writer,
            "CoordinateSystem",
            &coordinate_system.attributes,
        )?;
    }
    let export_names = export_names(package);
    write_points(&mut writer, package, &export_names, context)?;
    write_plan_features(&mut writer, package, &export_names, context)?;
    write_alignments(&mut writer, package, &export_names, context)?;
    write_surfaces(&mut writer, package, &export_names, context)?;
    writer
        .write_event(Event::End(BytesEnd::new("LandXML")))
        .map_err(|error| write_error(&error))?;
    context.report_progress(ProviderProgress {
        phase: "landxml-write".to_owned(),
        completed: package.admissions.len() as u64,
        total: Some(package.admissions.len() as u64),
        message: "wrote staged LandXML 1.2".to_owned(),
    });
    Ok(())
}

fn export_names(package: &CanonicalImportPackage) -> BTreeMap<String, String> {
    let mut counts = BTreeMap::<(String, String), usize>::new();
    let mut output = BTreeMap::new();
    for admission in &package.admissions {
        let key = (
            export_group(&admission.resolved_geometry).to_owned(),
            admission.entity.name.clone(),
        );
        let count = counts.entry(key).or_default();
        *count += 1;
        let id_suffix = admission.entity.id.0.chars().take(12).collect::<String>();
        let base = if admission.entity.name.trim().is_empty() {
            "unnamed".to_owned()
        } else {
            admission.entity.name.clone()
        };
        let name = if *count == 1 && !admission.entity.name.trim().is_empty() {
            base
        } else {
            format!("{base}~{id_suffix}")
        };
        output.insert(admission.entity.id.0.clone(), name);
    }
    output
}

fn write_units<W: Write>(
    writer: &mut Writer<W>,
    units: &LandXmlUnits,
) -> Result<(), ProviderContractError> {
    write_start(writer, "Units", &[])?;
    let mut attributes = units.attributes.clone();
    attributes.insert("linearUnit".to_owned(), units.linear_unit.clone());
    write_empty_map(writer, &units.system, &attributes)?;
    write_end(writer, "Units")
}

fn write_points<W: Write>(
    writer: &mut Writer<W>,
    package: &CanonicalImportPackage,
    names: &BTreeMap<String, String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let points = package
        .admissions
        .iter()
        .filter(|admission| {
            admission.entity.placement.is_none()
                && matches!(admission.resolved_geometry, GeometryObject::Point { .. })
        })
        .collect::<Vec<_>>();
    if points.is_empty() {
        return Ok(());
    }
    write_start(writer, "CgPoints", &[])?;
    for admission in points {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let GeometryObject::Point { position } = admission.resolved_geometry else {
            unreachable!();
        };
        write_text_element(
            writer,
            "CgPoint",
            &[("name", names[&admission.entity.id.0].clone())],
            &position_text(position),
        )?;
    }
    write_end(writer, "CgPoints")
}

fn write_plan_features<W: Write>(
    writer: &mut Writer<W>,
    package: &CanonicalImportPackage,
    names: &BTreeMap<String, String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let curves = package
        .admissions
        .iter()
        .filter_map(|admission| match &admission.resolved_geometry {
            GeometryObject::Curve { curve }
                if admission.entity.placement.is_none() && curve_exportable(curve) =>
            {
                Some((admission, curve.as_ref()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if curves.is_empty() {
        return Ok(());
    }
    write_start(writer, "PlanFeatures", &[])?;
    for (admission, curve) in curves {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        write_start(
            writer,
            "PlanFeature",
            &[("name", names[&admission.entity.id.0].clone())],
        )?;
        write_start(writer, "CoordGeom", &[])?;
        write_curve(writer, curve)?;
        write_end(writer, "CoordGeom")?;
        write_end(writer, "PlanFeature")?;
    }
    write_end(writer, "PlanFeatures")
}

fn write_alignments<W: Write>(
    writer: &mut Writer<W>,
    package: &CanonicalImportPackage,
    names: &BTreeMap<String, String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let alignments = package
        .admissions
        .iter()
        .filter_map(|admission| match &admission.resolved_geometry {
            GeometryObject::Alignment { alignment }
                if admission.entity.placement.is_none()
                    && curve_exportable(&alignment.horizontal) =>
            {
                Some((admission, alignment.as_ref()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if alignments.is_empty() {
        return Ok(());
    }
    write_start(writer, "Alignments", &[])?;
    for (admission, alignment) in alignments {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        write_start(
            writer,
            "Alignment",
            &[
                ("name", names[&admission.entity.id.0].clone()),
                ("staStart", number(alignment.station_origin)),
            ],
        )?;
        write_start(writer, "CoordGeom", &[])?;
        write_curve(writer, &alignment.horizontal)?;
        write_end(writer, "CoordGeom")?;
        write_vertical(writer, &alignment.vertical)?;
        write_end(writer, "Alignment")?;
    }
    write_end(writer, "Alignments")
}

fn write_vertical<W: Write>(
    writer: &mut Writer<W>,
    segments: &[VerticalAlignmentSegment],
) -> Result<(), ProviderContractError> {
    if segments.is_empty() || !vertical_continuous(segments) {
        return Ok(());
    }
    write_start(writer, "Profile", &[])?;
    write_start(writer, "ProfAlign", &[("name", "profile".to_owned())])?;
    let (start_station, start_elevation) = vertical_start(segments[0]);
    write_text_element(
        writer,
        "PVI",
        &[],
        &format!("{} {}", number(start_station), number(start_elevation)),
    )?;
    for (index, segment) in segments.iter().enumerate() {
        match *segment {
            VerticalAlignmentSegment::Grade {
                start_station,
                start_elevation,
                grade,
                length,
            } => {
                if !segments
                    .get(index + 1)
                    .is_some_and(|next| matches!(next, VerticalAlignmentSegment::Parabolic { .. }))
                {
                    write_text_element(
                        writer,
                        "PVI",
                        &[],
                        &format!(
                            "{} {}",
                            number(start_station + length),
                            number(start_elevation + grade * length)
                        ),
                    )?;
                }
            }
            VerticalAlignmentSegment::Parabolic {
                start_station,
                start_elevation,
                start_grade,
                end_grade,
                length,
            } => {
                let pvi_station = start_station + length * 0.5;
                let pvi_elevation = start_elevation + start_grade * length * 0.5;
                write_text_element(
                    writer,
                    "ParaCurve",
                    &[("length", number(length))],
                    &format!("{} {}", number(pvi_station), number(pvi_elevation)),
                )?;
                if index + 1 == segments.len() {
                    let end_elevation = start_elevation + (start_grade + end_grade) * 0.5 * length;
                    write_text_element(
                        writer,
                        "PVI",
                        &[],
                        &format!(
                            "{} {}",
                            number(start_station + length),
                            number(end_elevation)
                        ),
                    )?;
                }
            }
        }
    }
    write_end(writer, "ProfAlign")?;
    write_end(writer, "Profile")
}

fn vertical_start(segment: VerticalAlignmentSegment) -> (f64, f64) {
    match segment {
        VerticalAlignmentSegment::Grade {
            start_station,
            start_elevation,
            ..
        }
        | VerticalAlignmentSegment::Parabolic {
            start_station,
            start_elevation,
            ..
        } => (start_station, start_elevation),
    }
}

fn vertical_end(segment: VerticalAlignmentSegment) -> (f64, f64, f64) {
    match segment {
        VerticalAlignmentSegment::Grade {
            start_station,
            start_elevation,
            grade,
            length,
        } => (
            start_station + length,
            start_elevation + grade * length,
            grade,
        ),
        VerticalAlignmentSegment::Parabolic {
            start_station,
            start_elevation,
            start_grade,
            end_grade,
            length,
        } => (
            start_station + length,
            start_elevation + (start_grade + end_grade) * 0.5 * length,
            end_grade,
        ),
    }
}

fn vertical_continuous(segments: &[VerticalAlignmentSegment]) -> bool {
    segments.windows(2).all(|pair| {
        let (station, elevation, _) = vertical_end(pair[0]);
        let (next_station, next_elevation) = vertical_start(pair[1]);
        (station - next_station).abs() <= 1.0e-9
            && (elevation - next_elevation).abs() <= 1.0e-8 * elevation.abs().max(1.0)
    })
}

fn write_surfaces<W: Write>(
    writer: &mut Writer<W>,
    package: &CanonicalImportPackage,
    names: &BTreeMap<String, String>,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let surfaces = package
        .admissions
        .iter()
        .filter_map(|admission| match &admission.resolved_geometry {
            GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
                ElevationSurfaceGeometry::Tin { mesh, breaklines }
                    if admission.entity.placement.is_none()
                        && matches!(mesh.storage, TriangleMeshStorage::Inline { .. }) =>
                {
                    Some((admission, mesh, breaklines))
                }
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>();
    if surfaces.is_empty() {
        return Ok(());
    }
    write_start(writer, "Surfaces", &[])?;
    for (admission, mesh, breaklines) in surfaces {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let TriangleMeshStorage::Inline {
            positions, indices, ..
        } = &mesh.storage
        else {
            unreachable!();
        };
        write_start(
            writer,
            "Surface",
            &[("name", names[&admission.entity.id.0].clone())],
        )?;
        write_start(writer, "Definition", &[("surfType", "TIN".to_owned())])?;
        write_start(writer, "Pnts", &[])?;
        for (index, position) in positions.iter().enumerate() {
            write_text_element(
                writer,
                "P",
                &[("id", (index + 1).to_string())],
                &vector_text(*position),
            )?;
        }
        write_end(writer, "Pnts")?;
        write_start(writer, "Faces", &[])?;
        for face in indices.chunks_exact(3) {
            write_text_element(
                writer,
                "F",
                &[],
                &format!("{} {} {}", face[0] + 1, face[1] + 1, face[2] + 1),
            )?;
        }
        write_end(writer, "Faces")?;
        let exportable_breaklines = breaklines
            .iter()
            .filter_map(|breakline| match breakline {
                CurveGeometry::Polyline { positions, .. }
                    if positions.iter().all(|position| position.z.is_some()) =>
                {
                    Some(positions)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if !exportable_breaklines.is_empty() {
            write_start(writer, "Breaklines", &[])?;
            for (index, positions) in exportable_breaklines.into_iter().enumerate() {
                let text = positions
                    .iter()
                    .map(|position| position_text_3d(*position))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(" ");
                write_start(
                    writer,
                    "Breakline",
                    &[("name", format!("breakline-{}", index + 1))],
                )?;
                write_text_element(writer, "PntList3D", &[], &text)?;
                write_end(writer, "Breakline")?;
            }
            write_end(writer, "Breaklines")?;
        }
        write_end(writer, "Definition")?;
        write_end(writer, "Surface")?;
    }
    write_end(writer, "Surfaces")
}

fn curve_exportable(curve: &CurveGeometry) -> bool {
    match curve {
        CurveGeometry::LineSegment { .. } | CurveGeometry::Polyline { .. } => true,
        CurveGeometry::CircularArc { .. } => arc_center(curve).is_some(),
        CurveGeometry::Clothoid {
            start_curvature,
            end_curvature,
            ..
        } => {
            *start_curvature == 0.0
                || *end_curvature == 0.0
                || start_curvature.signum() == end_curvature.signum()
        }
        CurveGeometry::Composite { segments } => segments.iter().all(curve_exportable),
        _ => false,
    }
}

fn write_curve<W: Write>(
    writer: &mut Writer<W>,
    curve: &CurveGeometry,
) -> Result<(), ProviderContractError> {
    match curve {
        CurveGeometry::LineSegment { start, end } => write_line(writer, *start, *end),
        CurveGeometry::Polyline { positions, closed } => {
            for pair in positions.windows(2) {
                write_line(writer, pair[0], pair[1])?;
            }
            if *closed && positions.len() > 2 {
                write_line(
                    writer,
                    *positions.last().expect("polyline is nonempty"),
                    positions[0],
                )?;
            }
            Ok(())
        }
        CurveGeometry::CircularArc { start, end, .. } => {
            let (center, rotation) = arc_center(curve).ok_or_else(|| {
                ProviderContractError::Provider("degenerate circular arc".to_owned())
            })?;
            write_start(writer, "Curve", &[("rot", rotation.to_owned())])?;
            write_position(writer, "Start", *start)?;
            write_position(writer, "Center", center)?;
            write_position(writer, "End", *end)?;
            write_end(writer, "Curve")
        }
        CurveGeometry::Clothoid {
            start,
            start_tangent,
            start_curvature,
            end_curvature,
            length,
            ..
        } => {
            let (end, pi) = clothoid_export_points(
                *start,
                *start_tangent,
                *start_curvature,
                *end_curvature,
                *length,
            );
            let sign = if end_curvature.abs() > f64::EPSILON {
                end_curvature.signum()
            } else {
                start_curvature.signum()
            };
            write_start(
                writer,
                "Spiral",
                &[
                    ("spiType", "clothoid".to_owned()),
                    ("rot", if sign < 0.0 { "cw" } else { "ccw" }.to_owned()),
                    ("length", number(*length)),
                    ("radiusStart", radius_text(*start_curvature)),
                    ("radiusEnd", radius_text(*end_curvature)),
                ],
            )?;
            write_position(writer, "Start", *start)?;
            write_position(writer, "PI", pi)?;
            write_position(writer, "End", end)?;
            write_end(writer, "Spiral")
        }
        CurveGeometry::Composite { segments } => {
            for segment in segments {
                write_curve(writer, segment)?;
            }
            Ok(())
        }
        _ => Err(ProviderContractError::Provider(
            "curve was not accepted by the LandXML export plan".to_owned(),
        )),
    }
}

fn write_line<W: Write>(
    writer: &mut Writer<W>,
    start: Position,
    end: Position,
) -> Result<(), ProviderContractError> {
    write_start(writer, "Line", &[])?;
    write_position(writer, "Start", start)?;
    write_position(writer, "End", end)?;
    write_end(writer, "Line")
}

fn arc_center(curve: &CurveGeometry) -> Option<(Position, &'static str)> {
    let CurveGeometry::CircularArc {
        start,
        point_on_arc,
        end,
    } = curve
    else {
        return None;
    };
    let ax = start.x;
    let ay = start.y;
    let bx = point_on_arc.x;
    let by = point_on_arc.y;
    let cx = end.x;
    let cy = end.y;
    let denominator = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if !denominator.is_finite() || denominator.abs() <= f64::EPSILON {
        return None;
    }
    let aa = ax * ax + ay * ay;
    let bb = bx * bx + by * by;
    let cc = cx * cx + cy * cy;
    let x = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / denominator;
    let y = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / denominator;
    let cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    let z = match (start.z, end.z) {
        (Some(start), Some(end)) => Some((start + end) * 0.5),
        (None, None) => None,
        _ => return None,
    };
    Some((Position { x, y, z }, if cross < 0.0 { "cw" } else { "ccw" }))
}

fn clothoid_export_points(
    start: Position,
    tangent: Vector3,
    start_curvature: f64,
    end_curvature: f64,
    length: f64,
) -> (Position, Position) {
    const STEPS: usize = 2_048;
    let heading = tangent.y.atan2(tangent.x);
    let mut x = start.x;
    let mut y = start.y;
    let step = length / 2_048.0;
    let mut station = step * 0.5;
    for _ in 0..STEPS {
        let theta = heading
            + start_curvature * station
            + (end_curvature - start_curvature) * station * station / (2.0 * length);
        x += theta.cos() * step;
        y += theta.sin() * step;
        station += step;
    }
    let tangent_length = (length * 0.25).max(1.0);
    (
        Position { x, y, z: start.z },
        Position {
            x: start.x + tangent.x * tangent_length,
            y: start.y + tangent.y * tangent_length,
            z: start.z,
        },
    )
}

fn radius_text(curvature: f64) -> String {
    if curvature.abs() <= f64::EPSILON {
        "INF".to_owned()
    } else {
        number(1.0 / curvature.abs())
    }
}

fn position_text(position: Position) -> String {
    match position.z {
        Some(z) => format!(
            "{} {} {}",
            number(position.y),
            number(position.x),
            number(z)
        ),
        None => format!("{} {}", number(position.y), number(position.x)),
    }
}

fn position_text_3d(position: Position) -> Result<String, ProviderContractError> {
    let z = position.z.ok_or_else(|| {
        ProviderContractError::Provider("3D breakline position has unknown elevation".to_owned())
    })?;
    Ok(format!(
        "{} {} {}",
        number(position.y),
        number(position.x),
        number(z)
    ))
}

fn vector_text(position: Vector3) -> String {
    format!(
        "{} {} {}",
        number(position.y),
        number(position.x),
        number(position.z)
    )
}

fn number(value: f64) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        value.to_string()
    }
}

fn write_position<W: Write>(
    writer: &mut Writer<W>,
    name: &str,
    position: Position,
) -> Result<(), ProviderContractError> {
    write_text_element(writer, name, &[], &position_text(position))
}

fn write_start<W: Write>(
    writer: &mut Writer<W>,
    name: &str,
    attributes: &[(&str, String)],
) -> Result<(), ProviderContractError> {
    let mut start = BytesStart::new(name);
    for (key, value) in attributes {
        start.push_attribute((*key, value.as_str()));
    }
    writer
        .write_event(Event::Start(start))
        .map_err(|error| write_error(&error))
}

fn write_end<W: Write>(writer: &mut Writer<W>, name: &str) -> Result<(), ProviderContractError> {
    writer
        .write_event(Event::End(BytesEnd::new(name)))
        .map_err(|error| write_error(&error))
}

fn write_text_element<W: Write>(
    writer: &mut Writer<W>,
    name: &str,
    attributes: &[(&str, String)],
    text: &str,
) -> Result<(), ProviderContractError> {
    write_start(writer, name, attributes)?;
    writer
        .write_event(Event::Text(BytesText::new(text)))
        .map_err(|error| write_error(&error))?;
    write_end(writer, name)
}

fn write_empty_map<W: Write>(
    writer: &mut Writer<W>,
    name: &str,
    attributes: &BTreeMap<String, String>,
) -> Result<(), ProviderContractError> {
    let mut start = BytesStart::new(name);
    for (key, value) in attributes {
        start.push_attribute((key.as_str(), value.as_str()));
    }
    writer
        .write_event(Event::Empty(start))
        .map_err(|error| write_error(&error))
}

fn write_error(error: &std::io::Error) -> ProviderContractError {
    ProviderContractError::Provider(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const CIVIL_ZOO: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units>
    <Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter"/>
  </Units>
  <CoordinateSystem name="ETRS89 / UTM zone 32N" epsgCode="25832"/>
  <CgPoints>
    <CgPoint name="P1" code="GCP">5800000 500000 100</CgPoint>
    <CgPoint name="P2">5800010 500010 100.5</CgPoint>
    <CgPoint name="P2D">5800020 500020</CgPoint>
  </CgPoints>
  <PlanFeatures>
    <PlanFeature name="Parcel edge">
      <CoordGeom>
        <Line><Start>0 0 100</Start><End>0 10 100</End></Line>
        <Curve rot="ccw"><Start>0 10 100</Start><Center>10 10 100</Center><End>10 20 100</End></Curve>
      </CoordGeom>
    </PlanFeature>
  </PlanFeatures>
  <Alignments>
    <Alignment name="Road A" staStart="1000" length="170">
      <CoordGeom>
        <Line><Start>100 100 100</Start><End>100 200 100</End></Line>
        <Curve rot="ccw"><Start>100 200 100</Start><Center>150 200 100</Center><End>150 250 100</End></Curve>
        <Spiral spiType="clothoid" rot="ccw" length="20" radiusStart="50" radiusEnd="INF">
          <Start>150 250 100</Start><PI>160 250 100</PI><End>169.9 251.3 100</End>
        </Spiral>
      </CoordGeom>
      <Profile>
        <ProfAlign name="Finished grade">
          <PVI>1000 100</PVI>
          <ParaCurve length="20">1050 101</ParaCurve>
          <PVI>1100 103</PVI>
        </ProfAlign>
      </Profile>
      <CrossSects>
        <CrossSect sta="1000">
          <CrossSectSurf name="right-lane"><CrossSectPnt>0 100</CrossSectPnt><CrossSectPnt>5 100.1</CrossSectPnt></CrossSectSurf>
        </CrossSect>
        <CrossSect sta="1100">
          <CrossSectSurf name="right-lane"><CrossSectPnt>0 103</CrossSectPnt><CrossSectPnt>6 103.18</CrossSectPnt></CrossSectSurf>
        </CrossSect>
      </CrossSects>
    </Alignment>
  </Alignments>
  <Surfaces>
    <Surface name="Existing ground">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 100</P><P id="2">0 10 101</P><P id="3">10 10 102</P><P id="4">10 0 101</P>
        </Pnts>
        <Faces><F>1 2 3 4</F></Faces>
        <Breaklines><Breakline name="ridge"><PntRefList3D>1 3</PntRefList3D></Breakline></Breaklines>
      </Definition>
    </Surface>
  </Surfaces>
  <FutureCivilExtension mode="preserve-in-provenance"/>
</LandXML>
"#;

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

    struct CancelAfterContext {
        checks: Cell<usize>,
        threshold: usize,
        progress: Vec<ProviderProgress>,
    }

    impl ProviderOperationContext for CancelAfterContext {
        fn is_cancelled(&self) -> bool {
            let current = self.checks.get();
            self.checks.set(current.saturating_add(1));
            current >= self.threshold
        }

        fn report_progress(&mut self, progress: ProviderProgress) {
            self.progress.push(progress);
        }
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "himmelcad-landxml-test-{}-{timestamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn import_fixture(path: &Path) -> CanonicalImportPackage {
        let mut context = TestContext::default();
        CanonicalImportProvider::import(
            &LandXmlProvider::new(),
            CanonicalImportRequest {
                source: path,
                format_id: LANDXML_FORMAT_ID,
                options: &serde_json::json!({}),
            },
            &mut context,
        )
        .expect("import LandXML fixture")
    }

    #[test]
    fn civil_zoo_import_is_deterministic_valid_and_explicit_about_loss() {
        let directory = TestDirectory::new();
        let source = directory.path("civil-zoo.landxml");
        fs::write(&source, CIVIL_ZOO).expect("write fixture");

        let first = import_fixture(&source);
        let second = import_fixture(&source);
        assert_eq!(first, second);
        first.validate().expect("canonical package");
        assert_eq!(first.admissions.len(), 6);
        assert!(first.datasets.is_empty());
        assert!(first.resource_sets.is_empty());

        let report = package_report(&first)
            .expect("read report")
            .expect("LandXML report");
        assert_eq!(report.units.system, "Metric");
        assert_eq!(report.units.linear_unit, "meter");
        assert_eq!(
            report
                .coordinate_system
                .as_ref()
                .and_then(|system| system.attributes.get("epsgCode")),
            Some(&"25832".to_owned())
        );
        assert_eq!(report.unsupported_elements, ["FutureCivilExtension"]);
        assert!(report
            .loss_codes
            .contains(&LOSS_UNSUPPORTED_ELEMENTS.to_owned()));
        assert!(report
            .loss_codes
            .contains(&LOSS_QUAD_TRIANGULATED.to_owned()));

        let alignment = first
            .admissions
            .iter()
            .find_map(|admission| match &admission.resolved_geometry {
                GeometryObject::Alignment { alignment } => Some(alignment),
                _ => None,
            })
            .expect("alignment");
        assert_eq!(alignment.vertical.len(), 3);
        assert_eq!(alignment.width_bands.len(), 1);
        assert_eq!(alignment.crossfall_bands.len(), 1);
        assert_eq!(alignment.station_origin, 1000.0);

        let (positions, indices, breaklines) = first
            .admissions
            .iter()
            .find_map(|admission| match &admission.resolved_geometry {
                GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
                    ElevationSurfaceGeometry::Tin { mesh, breaklines } => match &mesh.storage {
                        TriangleMeshStorage::Inline {
                            positions, indices, ..
                        } => Some((positions, indices, breaklines)),
                        TriangleMeshStorage::Resource { .. } => None,
                    },
                    ElevationSurfaceGeometry::Grid { .. } => None,
                },
                _ => None,
            })
            .expect("TIN surface");
        assert_eq!(positions.len(), 4);
        assert_eq!(indices, &[0, 1, 2, 0, 2, 3]);
        assert_eq!(breaklines.len(), 1);
    }

    #[test]
    fn export_plan_roundtrips_supported_civil_geometry_and_declares_omissions() {
        let directory = TestDirectory::new();
        let source = directory.path("civil-zoo.landxml");
        let target = directory.path("roundtrip.landxml");
        fs::write(&source, CIVIL_ZOO).expect("write fixture");
        let package = import_fixture(&source);
        let provider = LandXmlProvider::new();
        let options = serde_json::json!({});
        let request = CanonicalExportRequest {
            target: &target,
            format_id: LANDXML_FORMAT_ID,
            package: &package,
            options: &options,
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
        .expect("plan export");
        assert!(plan
            .semantic_losses
            .contains(&LOSS_EXPORT_SPIRAL_NUMERIC.to_owned()));
        assert!(plan
            .semantic_losses
            .contains(&LOSS_EXPORT_CORRIDOR_BANDS.to_owned()));
        assert!(plan
            .semantic_losses
            .contains(&LOSS_EXPORT_METADATA.to_owned()));

        let mut context = TestContext::default();
        CanonicalExportProvider::export(&provider, request, &plan, &mut context)
            .expect("atomic export");
        assert!(target.is_file());
        assert_eq!(
            context.progress.last().map(|progress| progress.completed),
            Some(package.admissions.len() as u64)
        );

        let roundtrip = import_fixture(&target);
        roundtrip.validate().expect("roundtrip package");
        assert_eq!(roundtrip.admissions.len(), package.admissions.len());
        for expected_group in ["point", "plan-feature", "alignment", "surface"] {
            assert_eq!(
                package
                    .admissions
                    .iter()
                    .filter(|admission| export_group(&admission.resolved_geometry) == expected_group)
                    .count(),
                roundtrip
                    .admissions
                    .iter()
                    .filter(|admission| export_group(&admission.resolved_geometry) == expected_group)
                    .count()
            );
        }
        let roundtrip_alignment = roundtrip
            .admissions
            .iter()
            .find_map(|admission| match &admission.resolved_geometry {
                GeometryObject::Alignment { alignment } => Some(alignment),
                _ => None,
            })
            .expect("roundtrip alignment");
        assert_eq!(roundtrip_alignment.vertical.len(), 3);
        assert!(roundtrip_alignment.width_bands.is_empty());
        assert!(roundtrip_alignment.crossfall_bands.is_empty());
        assert_eq!(roundtrip_alignment.station_origin, 1000.0);
    }

    #[test]
    fn strict_references_and_dtds_fail_closed() {
        let directory = TestDirectory::new();
        let provider = LandXmlProvider::new();
        for (name, xml) in [
            (
                "missing-reference.landxml",
                CIVIL_ZOO.replace("<Start>0 0 100</Start>", "<Start pntRef=\"MISSING\"/>"),
            ),
            (
                "doctype.landxml",
                CIVIL_ZOO.replace(
                    "<LandXML ",
                    "<!DOCTYPE LandXML [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><LandXML ",
                ),
            ),
        ] {
            let source = directory.path(name);
            fs::write(&source, xml).expect("write invalid fixture");
            let mut context = TestContext::default();
            let result = CanonicalImportProvider::import(
                &provider,
                CanonicalImportRequest {
                    source: &source,
                    format_id: LANDXML_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut context,
            );
            assert!(matches!(result, Err(ProviderContractError::Provider(_))));
        }
    }

    #[test]
    fn cancelled_export_leaves_no_target_or_staging_file() {
        let directory = TestDirectory::new();
        let source = directory.path("civil-zoo.landxml");
        let target = directory.path("cancelled.landxml");
        fs::write(&source, CIVIL_ZOO).expect("write fixture");
        let package = import_fixture(&source);
        let provider = LandXmlProvider::new();
        let options = serde_json::json!({});
        let request = CanonicalExportRequest {
            target: &target,
            format_id: LANDXML_FORMAT_ID,
            package: &package,
            options: &options,
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
        .expect("plan export");
        let mut context = CancelAfterContext {
            checks: Cell::new(0),
            threshold: 2,
            progress: Vec::new(),
        };
        assert_eq!(
            CanonicalExportProvider::export(&provider, request, &plan, &mut context),
            Err(ProviderContractError::Cancelled)
        );
        assert!(!target.exists());
        let leftovers = fs::read_dir(&directory.0)
            .expect("list test directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".landxml-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn cancellation_is_observed_during_canonical_mapping() {
        let directory = TestDirectory::new();
        let source = directory.path("civil-zoo.landxml");
        fs::write(&source, CIVIL_ZOO).expect("write fixture");
        let mut context = CancelAfterContext {
            checks: Cell::new(0),
            threshold: 2,
            progress: Vec::new(),
        };
        let result = CanonicalImportProvider::import(
            &LandXmlProvider::new(),
            CanonicalImportRequest {
                source: &source,
                format_id: LANDXML_FORMAT_ID,
                options: &serde_json::json!({}),
            },
            &mut context,
        );
        assert_eq!(result, Err(ProviderContractError::Cancelled));
    }
}
