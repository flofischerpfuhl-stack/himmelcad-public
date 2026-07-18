//! Strict, bounded Gaussian-splat PLY import, preparation and passthrough export.
//!
//! The source PLY remains an immutable authoritative artifact. Prepared PLY
//! tiles are deterministic render derivations admitted through the shared
//! `himmelcad-prepared-hierarchy@1` residency contract; no large source is
//! decoded into one in-memory entity and no missing splat field receives a
//! default value.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, EntityTypeId, GeometryObject, GeometryResource, Representation,
    RepresentationAuthority, RepresentationRole, StreamedGeometry,
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
    CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject, CanonicalPreparedDataset,
    ExportOutput, FormatCapability, FormatProviderDescriptor, ImportProbe, ImportProbeRequest,
    PreparedDatasetArtifact, ProviderContractError, ProviderOperationContext, ProviderProgress,
    CANONICAL_IO_SCHEMA_VERSION,
};

/// Exact Gaussian-splat PLY format handled by this provider.
pub const GAUSSIAN_SPLAT_PLY_FORMAT_ID: &str = "gaussian-splat-ply@1";
/// Stable provider identity.
pub const GAUSSIAN_SPLAT_PLY_PROVIDER_ID: &str = "hcad.io.gaussian-splat-ply@1";
/// Export cannot select exactly one Gaussian-splat entity.
pub const LOSS_SPLAT_EXPORT_SELECTION: &str =
    "hcad.loss.gaussian-splat-ply.multiple-or-non-splat@1";
/// Export has no unchanged authoritative source PLY.
pub const LOSS_SPLAT_EXPORT_NOT_PASSTHROUGH: &str =
    "hcad.loss.gaussian-splat-ply.not-exact-passthrough@1";

const PREPARED_FORMAT_ID: &str = "himmelcad-prepared-hierarchy@1";
const SOURCE_MEDIA_TYPE: &str = "application/vnd.himmelcad.gaussian-splat-ply";
const PLY_MEDIA_TYPE: &str = "application/ply";
const HEADER_LIMIT: u64 = 1024 * 1024;
const MAX_PROPERTIES: usize = 256;
const MAX_RECORD_BYTES: usize = 4096;
const DEFAULT_MAX_SPLATS: u64 = 2_000_000_000;
const DEFAULT_LEAF_SPLATS: u64 = 200_000;
const DEFAULT_INTERNAL_SAMPLE_SPLATS: u64 = 50_000;
const CANCEL_INTERVAL: u64 = 4096;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const SPOOL_STRIDE: usize = 56;
const SH_C0: f64 = 0.282_094_791_773_878_14;

/// Canonical Gaussian-splat PLY provider.
pub struct GaussianSplatPlyProvider {
    prepared_root: PathBuf,
    descriptor: FormatProviderDescriptor,
}

impl GaussianSplatPlyProvider {
    /// Creates a provider writing unpublished preparation below `prepared_root`.
    #[must_use]
    pub fn new(prepared_root: PathBuf) -> Self {
        Self {
            prepared_root,
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: GAUSSIAN_SPLAT_PLY_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "Gaussian Splat PLY".to_owned(),
                format_ids: vec![GAUSSIAN_SPLAT_PLY_FORMAT_ID.to_owned()],
                extensions: vec!["ply".to_owned()],
                media_types: vec![PLY_MEDIA_TYPE.to_owned(), SOURCE_MEDIA_TYPE.to_owned()],
                capabilities: vec![FormatCapability::Import, FormatCapability::Export],
            },
        }
    }
}

impl CanonicalImportProvider for GaussianSplatPlyProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        if !request.prefix.starts_with(b"ply\n") && !request.prefix.starts_with(b"ply\r\n") {
            return Ok(None);
        }
        let prefix = String::from_utf8_lossy(request.prefix);
        let inria = [
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity",
            "f_dc_0", "f_dc_1", "f_dc_2",
        ]
        .iter()
        .all(|name| {
            prefix.contains(&format!("property float {name}"))
                || prefix.contains(&format!("property float32 {name}"))
        });
        let rgba = ["scale_x", "scale_y", "scale_z", "qx", "qy", "qz", "qw"]
            .iter()
            .all(|name| {
                prefix.contains(&format!("property float {name}"))
                    || prefix.contains(&format!("property float32 {name}"))
            })
            && ["red", "green", "blue", "alpha"].iter().all(|name| {
                prefix.contains(&format!("property uchar {name}"))
                    || prefix.contains(&format!("property uint8 {name}"))
            });
        if !inria && !rgba {
            return Ok(None);
        }
        Ok(Some(ImportProbe {
            format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID.to_owned(),
            confidence: if request
                .path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("ply"))
            {
                98
            } else {
                88
            },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != GAUSSIAN_SPLAT_PLY_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: ImportOptions = serde_json::from_value(request.options.clone())
            .map_err(|error| provider_message(error.to_string()))?;
        options.validate()?;
        fs::create_dir_all(&self.prepared_root).map_err(provider_io)?;
        let mut staging = StagingDirectory::create(&self.prepared_root, request.source)?;
        let staged_source = staging.path.join("source.ply");
        let source_resource = copy_source(request.source, &staged_source, context)?;
        let header = parse_header(&staged_source)?;
        let schema = recognize_schema(&header)?;
        if header.vertex_count == 0 || header.vertex_count > options.maximum_splats {
            return Err(provider_message(format!(
                "Gaussian PLY vertex count {} violates maximumSplats {}",
                header.vertex_count, options.maximum_splats
            )));
        }
        validate_binary_length(&staged_source, &header)?;
        let prepared = prepare_dataset(
            &staged_source,
            &staging.path,
            &header,
            &schema,
            options,
            context,
        )?;
        let dataset_id = format!("splat-{}", source_resource.object_hash.as_str());
        let package = build_package(
            request.source,
            &dataset_id,
            &source_resource,
            &header,
            &schema,
            prepared,
        )?;
        package.validate()?;
        let final_root = self.prepared_root.join(&dataset_id);
        publish_staging(&mut staging, &final_root, &package.datasets[0].artifacts)?;
        context.report_progress(ProviderProgress {
            phase: "splat-admit".to_owned(),
            completed: header.vertex_count,
            total: Some(header.vertex_count),
            message: "Gaussian-splat hierarchy is canonical and ready".to_owned(),
        });
        Ok(package)
    }
}

impl CanonicalExportProvider for GaussianSplatPlyProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn plan_export(
        &self,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError> {
        if request.format_id != GAUSSIAN_SPLAT_PLY_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        request.package.validate()?;
        let mut losses = Vec::new();
        if request.package.admissions.len() != 1
            || !matches!(
                request.package.admissions[0].resolved_geometry,
                GeometryObject::GaussianSplatCloud { .. }
            )
        {
            losses.push(LOSS_SPLAT_EXPORT_SELECTION.to_owned());
        }
        if passthrough_source(request.package).is_none() {
            losses.push(LOSS_SPLAT_EXPORT_NOT_PASSTHROUGH.to_owned());
        }
        Ok(CanonicalExportPlan {
            format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID.to_owned(),
            outputs: vec![ExportOutput {
                relative_path: request
                    .target
                    .file_name()
                    .map(PathBuf::from)
                    .ok_or_else(|| provider_message("splat export target must be a file"))?,
                media_type: PLY_MEDIA_TYPE.to_owned(),
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
        if &expected != plan || !plan.semantic_losses.is_empty() {
            return Err(provider_message(
                plan.semantic_losses
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "splat export plan mismatch".to_owned()),
            ));
        }
        let (dataset_id, artifact) = passthrough_source(request.package)
            .ok_or_else(|| provider_message(LOSS_SPLAT_EXPORT_NOT_PASSTHROUGH))?;
        copy_verified(
            &self
                .prepared_root
                .join(dataset_id)
                .join(&artifact.relative_path),
            request.target,
            &artifact.resource,
            context,
            "splat-export",
        )
    }
}

#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportOptions {
    #[serde(default = "default_maximum_splats")]
    maximum_splats: u64,
    #[serde(default = "default_leaf_splats")]
    maximum_leaf_splats: u64,
    #[serde(default = "default_internal_sample_splats")]
    maximum_internal_sample_splats: u64,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            maximum_splats: DEFAULT_MAX_SPLATS,
            maximum_leaf_splats: DEFAULT_LEAF_SPLATS,
            maximum_internal_sample_splats: DEFAULT_INTERNAL_SAMPLE_SPLATS,
        }
    }
}

impl ImportOptions {
    fn validate(self) -> Result<(), ProviderContractError> {
        if self.maximum_splats == 0
            || self.maximum_leaf_splats == 0
            || self.maximum_internal_sample_splats == 0
            || self.maximum_leaf_splats > self.maximum_splats
            || self.maximum_internal_sample_splats > self.maximum_splats
        {
            return Err(provider_message(
                "invalid Gaussian-splat preparation limits",
            ));
        }
        Ok(())
    }
}

const fn default_maximum_splats() -> u64 {
    DEFAULT_MAX_SPLATS
}
const fn default_leaf_splats() -> u64 {
    DEFAULT_LEAF_SPLATS
}
const fn default_internal_sample_splats() -> u64 {
    DEFAULT_INTERNAL_SAMPLE_SPLATS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PlyEncoding {
    Ascii,
    BinaryLittleEndian,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScalarType {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl ScalarType {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "char" | "int8" => Self::I8,
            "uchar" | "uint8" => Self::U8,
            "short" | "int16" => Self::I16,
            "ushort" | "uint16" => Self::U16,
            "int" | "int32" => Self::I32,
            "uint" | "uint32" => Self::U32,
            "float" | "float32" => Self::F32,
            "double" | "float64" => Self::F64,
            _ => return None,
        })
    }
    const fn bytes(self) -> usize {
        match self {
            Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::F64 => 8,
        }
    }
    const fn is_float(self) -> bool {
        matches!(self, Self::F32 | Self::F64)
    }
}

#[derive(Debug, Clone)]
struct Property {
    name: String,
    scalar_type: ScalarType,
    offset: usize,
}

#[derive(Debug, Clone)]
struct PlyHeader {
    encoding: PlyEncoding,
    vertex_count: u64,
    properties: Vec<Property>,
    body_offset: u64,
    record_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SourceSchema {
    Inria3dgs { sh_degree: u8, has_normals: bool },
    HimmelCadRgba8,
}

fn parse_header(path: &Path) -> Result<PlyHeader, ProviderContractError> {
    let mut reader = BufReader::new(File::open(path).map_err(provider_io)?);
    let mut offset = 0_u64;
    let mut encoding = None;
    let mut vertex_count = None;
    let mut in_vertex = false;
    let mut saw_nonempty_other_element = false;
    let mut properties = Vec::new();
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line).map_err(provider_io)?;
        if count == 0 {
            return Err(provider_message("unterminated Gaussian PLY header"));
        }
        offset = offset
            .checked_add(count as u64)
            .ok_or_else(|| provider_message("PLY header overflow"))?;
        if offset > HEADER_LIMIT {
            return Err(provider_message("Gaussian PLY header exceeds 1 MiB"));
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        match fields.as_slice() {
            ["ply"] if offset == count as u64 => {}
            ["format", "ascii", "1.0"] => encoding = Some(PlyEncoding::Ascii),
            ["format", "binary_little_endian", "1.0"] => {
                encoding = Some(PlyEncoding::BinaryLittleEndian);
            }
            ["format", ..] => return Err(provider_message("unsupported Gaussian PLY encoding")),
            ["element", "vertex", count] if vertex_count.is_none() => {
                vertex_count = count.parse::<u64>().ok();
                in_vertex = true;
            }
            ["element", _, count] => {
                in_vertex = false;
                if count.parse::<u64>().ok().is_none_or(|value| value != 0) {
                    saw_nonempty_other_element = true;
                }
            }
            ["property", "list", ..] if in_vertex => {
                return Err(provider_message(
                    "list properties are invalid Gaussian vertices",
                ));
            }
            ["property", scalar, name] if in_vertex => {
                let scalar_type = ScalarType::parse(scalar)
                    .ok_or_else(|| provider_message(format!("unsupported PLY scalar {scalar}")))?;
                if properties
                    .iter()
                    .any(|property: &Property| property.name == *name)
                {
                    return Err(provider_message(format!("duplicate PLY property {name}")));
                }
                let property_offset = properties
                    .iter()
                    .map(|property: &Property| property.scalar_type.bytes())
                    .sum();
                properties.push(Property {
                    name: (*name).to_owned(),
                    scalar_type,
                    offset: property_offset,
                });
            }
            ["end_header"] => break,
            ["comment" | "obj_info", ..] | [] => {}
            _ => {
                return Err(provider_message(format!(
                    "unsupported Gaussian PLY header line: {}",
                    line.trim()
                )))
            }
        }
    }
    if saw_nonempty_other_element || properties.is_empty() || properties.len() > MAX_PROPERTIES {
        return Err(provider_message(
            "Gaussian PLY must contain only bounded scalar vertices",
        ));
    }
    let record_bytes = properties
        .iter()
        .try_fold(0_usize, |sum, property| {
            sum.checked_add(property.scalar_type.bytes())
        })
        .ok_or_else(|| provider_message("PLY record size overflow"))?;
    if record_bytes == 0 || record_bytes > MAX_RECORD_BYTES {
        return Err(provider_message(
            "Gaussian PLY record exceeds bounded layout",
        ));
    }
    Ok(PlyHeader {
        encoding: encoding.ok_or_else(|| provider_message("PLY format is missing"))?,
        vertex_count: vertex_count
            .ok_or_else(|| provider_message("PLY vertex count is missing"))?,
        properties,
        body_offset: offset,
        record_bytes,
    })
}

#[allow(clippy::too_many_lines)]
fn recognize_schema(header: &PlyHeader) -> Result<SourceSchema, ProviderContractError> {
    let map = header
        .properties
        .iter()
        .map(|property| (property.name.as_str(), property.scalar_type))
        .collect::<BTreeMap<_, _>>();
    let inria_required = [
        "x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
        "opacity", "f_dc_0", "f_dc_1", "f_dc_2",
    ];
    if inria_required.iter().all(|name| map.contains_key(name)) {
        for name in ["x", "y", "z"] {
            if !map[name].is_float() {
                return Err(provider_message(format!("{name} must be floating point")));
            }
        }
        for name in &inria_required[3..] {
            if map[name] != ScalarType::F32 {
                return Err(provider_message(format!(
                    "INRIA property {name} must be float32"
                )));
            }
        }
        let normals = ["nx", "ny", "nz"];
        let normal_count = normals
            .iter()
            .filter(|name| map.contains_key(**name))
            .count();
        if !matches!(normal_count, 0 | 3)
            || normals
                .iter()
                .filter(|name| map.contains_key(**name))
                .any(|name| map[*name] != ScalarType::F32)
        {
            return Err(provider_message(
                "INRIA normals must be a complete float32 triplet",
            ));
        }
        let mut rest = map
            .keys()
            .filter_map(|name| name.strip_prefix("f_rest_")?.parse::<usize>().ok())
            .collect::<Vec<_>>();
        rest.sort_unstable();
        if rest.iter().copied().ne(0..rest.len()) || !matches!(rest.len(), 0 | 9 | 24 | 45) {
            return Err(provider_message(
                "INRIA SH rest coefficients are incomplete or have unsupported degree",
            ));
        }
        for index in &rest {
            if map[format!("f_rest_{index}").as_str()] != ScalarType::F32 {
                return Err(provider_message("INRIA SH coefficients must be float32"));
            }
        }
        let allowed = inria_required
            .into_iter()
            .chain(normals.into_iter().take(normal_count))
            .map(str::to_owned)
            .chain(rest.iter().map(|index| format!("f_rest_{index}")))
            .collect::<BTreeSet<_>>();
        if map.keys().any(|name| !allowed.contains(*name)) {
            return Err(provider_message(
                "INRIA Gaussian PLY contains unknown vertex properties",
            ));
        }
        let degree = match rest.len() {
            0 => 0,
            9 => 1,
            24 => 2,
            45 => 3,
            _ => unreachable!(),
        };
        return Ok(SourceSchema::Inria3dgs {
            sh_degree: degree,
            has_normals: normal_count == 3,
        });
    }
    let rgba_required = [
        "x", "y", "z", "scale_x", "scale_y", "scale_z", "qx", "qy", "qz", "qw", "red", "green",
        "blue", "alpha",
    ];
    if rgba_required.iter().all(|name| map.contains_key(name)) && map.len() == rgba_required.len() {
        for name in ["x", "y", "z"] {
            if !map[name].is_float() {
                return Err(provider_message(format!("{name} must be floating point")));
            }
        }
        for name in ["scale_x", "scale_y", "scale_z", "qx", "qy", "qz", "qw"] {
            if map[name] != ScalarType::F32 {
                return Err(provider_message(format!(
                    "HimmelCAD property {name} must be float32"
                )));
            }
        }
        for name in ["red", "green", "blue", "alpha"] {
            if map[name] != ScalarType::U8 {
                return Err(provider_message(format!(
                    "HimmelCAD property {name} must be uint8"
                )));
            }
        }
        return Ok(SourceSchema::HimmelCadRgba8);
    }
    Err(provider_message(
        "PLY is not a complete recognized Gaussian-splat schema",
    ))
}

fn validate_binary_length(path: &Path, header: &PlyHeader) -> Result<(), ProviderContractError> {
    if header.encoding == PlyEncoding::BinaryLittleEndian {
        let expected = header
            .body_offset
            .checked_add(
                header
                    .vertex_count
                    .checked_mul(header.record_bytes as u64)
                    .ok_or_else(|| provider_message("PLY payload size overflow"))?,
            )
            .ok_or_else(|| provider_message("PLY file size overflow"))?;
        if path.metadata().map_err(provider_io)?.len() != expected {
            return Err(provider_message(
                "binary Gaussian PLY length does not exactly match its header",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct Splat {
    position: [f64; 3],
    scale: [f32; 3],
    rotation: [f32; 4],
    color: [u8; 4],
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn decode_splat(
    values: &[f64],
    header: &PlyHeader,
    schema: &SourceSchema,
) -> Result<Splat, ProviderContractError> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(provider_message(
            "Gaussian PLY contains a non-finite vertex property",
        ));
    }
    let get = |name: &str| -> Result<f64, ProviderContractError> {
        let index = header
            .properties
            .iter()
            .position(|property| property.name == name)
            .ok_or_else(|| provider_message(format!("missing required splat property {name}")))?;
        let value = values[index];
        value
            .is_finite()
            .then_some(value)
            .ok_or_else(|| provider_message(format!("non-finite splat property {name}")))
    };
    let position = [get("x")?, get("y")?, get("z")?];
    let (scale, quaternion, color) = match schema {
        SourceSchema::Inria3dgs { .. } => {
            let scale = [get("scale_0")?, get("scale_1")?, get("scale_2")?].map(f64::exp);
            if scale
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0 || *value > f64::from(f32::MAX))
            {
                return Err(provider_message(
                    "INRIA logarithmic scale is not representable",
                ));
            }
            let quaternion = [get("rot_1")?, get("rot_2")?, get("rot_3")?, get("rot_0")?];
            let rgb = [get("f_dc_0")?, get("f_dc_1")?, get("f_dc_2")?]
                .map(|coefficient| unit_byte(0.5 + SH_C0 * coefficient));
            let opacity = get("opacity")?;
            let alpha = if opacity >= 0.0 {
                unit_byte(1.0 / (1.0 + (-opacity).exp()))
            } else {
                let exponential = opacity.exp();
                unit_byte(exponential / (1.0 + exponential))
            };
            (
                scale.map(|value| value as f32),
                quaternion,
                [rgb[0], rgb[1], rgb[2], alpha],
            )
        }
        SourceSchema::HimmelCadRgba8 => (
            [get("scale_x")?, get("scale_y")?, get("scale_z")?].map(|value| value as f32),
            [get("qx")?, get("qy")?, get("qz")?, get("qw")?],
            [
                get("red")? as u8,
                get("green")? as u8,
                get("blue")? as u8,
                get("alpha")? as u8,
            ],
        ),
    };
    if scale
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(provider_message(
            "Gaussian scale must be finite and positive",
        ));
    }
    let norm = quaternion
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm <= 1.0e-12 {
        return Err(provider_message(
            "Gaussian quaternion has zero or invalid norm",
        ));
    }
    let rotation = quaternion.map(|value| (value / norm) as f32);
    if rotation.iter().any(|value| !value.is_finite()) {
        return Err(provider_message(
            "Gaussian quaternion is not f32-representable",
        ));
    }
    Ok(Splat {
        position,
        scale,
        rotation,
        color,
    })
}

fn unit_byte(value: f64) -> u8 {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let byte = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    byte
}

fn visit_source(
    path: &Path,
    header: &PlyHeader,
    schema: &SourceSchema,
    context: &mut dyn ProviderOperationContext,
    mut visitor: impl FnMut(Splat) -> Result<(), ProviderContractError>,
) -> Result<(), ProviderContractError> {
    let file = File::open(path).map_err(provider_io)?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(header.body_offset))
        .map_err(provider_io)?;
    context.report_progress(ProviderProgress {
        phase: "splat-decode".to_owned(),
        completed: 0,
        total: Some(header.vertex_count),
        message: "validating Gaussian splats without monolithic allocation".to_owned(),
    });
    match header.encoding {
        PlyEncoding::BinaryLittleEndian => {
            let mut record = vec![0_u8; header.record_bytes];
            let mut values = vec![0.0_f64; header.properties.len()];
            for index in 0..header.vertex_count {
                if index.is_multiple_of(CANCEL_INTERVAL) {
                    check_cancelled(context)?;
                    report_rows(context, "splat-decode", index, header.vertex_count);
                }
                reader.read_exact(&mut record).map_err(|error| {
                    provider_message(format!("truncated binary Gaussian PLY: {error}"))
                })?;
                for (property_index, property) in header.properties.iter().enumerate() {
                    values[property_index] = read_binary_scalar(&record, property)?;
                }
                visitor(decode_splat(&values, header, schema)?)?;
            }
        }
        PlyEncoding::Ascii => {
            let mut line = String::new();
            let mut values = vec![0.0_f64; header.properties.len()];
            for index in 0..header.vertex_count {
                if index.is_multiple_of(CANCEL_INTERVAL) {
                    check_cancelled(context)?;
                    report_rows(context, "splat-decode", index, header.vertex_count);
                }
                line.clear();
                if reader.read_line(&mut line).map_err(provider_io)? == 0 {
                    return Err(provider_message("truncated ASCII Gaussian PLY"));
                }
                let fields = line.split_whitespace().collect::<Vec<_>>();
                if fields.len() != header.properties.len() {
                    return Err(provider_message(format!(
                        "ASCII Gaussian PLY row {index} has wrong scalar count"
                    )));
                }
                for (property_index, (field, property)) in
                    fields.iter().zip(&header.properties).enumerate()
                {
                    values[property_index] = parse_ascii_scalar(field, property.scalar_type)?;
                }
                visitor(decode_splat(&values, header, schema)?)?;
            }
            let mut trailing = String::new();
            reader.read_to_string(&mut trailing).map_err(provider_io)?;
            if !trailing.trim().is_empty() {
                return Err(provider_message(
                    "ASCII Gaussian PLY has undeclared trailing payload",
                ));
            }
        }
    }
    check_cancelled(context)?;
    report_rows(
        context,
        "splat-decode",
        header.vertex_count,
        header.vertex_count,
    );
    Ok(())
}

fn parse_ascii_scalar(value: &str, scalar: ScalarType) -> Result<f64, ProviderContractError> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| provider_message("invalid ASCII PLY scalar"))?;
    if !parsed.is_finite() {
        return Err(provider_message("non-finite ASCII PLY scalar"));
    }
    let valid = match scalar {
        ScalarType::I8 => {
            parsed.fract() == 0.0 && (f64::from(i8::MIN)..=f64::from(i8::MAX)).contains(&parsed)
        }
        ScalarType::U8 => parsed.fract() == 0.0 && (0.0..=f64::from(u8::MAX)).contains(&parsed),
        ScalarType::I16 => {
            parsed.fract() == 0.0 && (f64::from(i16::MIN)..=f64::from(i16::MAX)).contains(&parsed)
        }
        ScalarType::U16 => parsed.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(&parsed),
        ScalarType::I32 => {
            parsed.fract() == 0.0 && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&parsed)
        }
        ScalarType::U32 => parsed.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&parsed),
        ScalarType::F32 => parsed.abs() <= f64::from(f32::MAX),
        ScalarType::F64 => true,
    };
    valid
        .then_some(parsed)
        .ok_or_else(|| provider_message("ASCII PLY scalar violates its declared type"))
}

fn read_binary_scalar(bytes: &[u8], property: &Property) -> Result<f64, ProviderContractError> {
    let offset = property.offset;
    let end = offset
        .checked_add(property.scalar_type.bytes())
        .ok_or_else(|| provider_message("PLY scalar offset overflow"))?;
    let value = bytes
        .get(offset..end)
        .ok_or_else(|| provider_message("truncated PLY scalar"))?;
    Ok(match property.scalar_type {
        ScalarType::I8 => f64::from(i8::from_le_bytes([value[0]])),
        ScalarType::U8 => f64::from(value[0]),
        ScalarType::I16 => f64::from(i16::from_le_bytes(
            value.try_into().expect("length checked"),
        )),
        ScalarType::U16 => f64::from(u16::from_le_bytes(
            value.try_into().expect("length checked"),
        )),
        ScalarType::I32 => f64::from(i32::from_le_bytes(
            value.try_into().expect("length checked"),
        )),
        ScalarType::U32 => f64::from(u32::from_le_bytes(
            value.try_into().expect("length checked"),
        )),
        ScalarType::F32 => f64::from(f32::from_le_bytes(
            value.try_into().expect("length checked"),
        )),
        ScalarType::F64 => f64::from_le_bytes(value.try_into().expect("length checked")),
    })
}

#[derive(Debug, Clone, Copy)]
struct Stats {
    count: u64,
    center_min: [f64; 3],
    center_max: [f64; 3],
    maximum_scale: f64,
}

impl Stats {
    const fn empty() -> Self {
        Self {
            count: 0,
            center_min: [f64::INFINITY; 3],
            center_max: [f64::NEG_INFINITY; 3],
            maximum_scale: 0.0,
        }
    }
    fn observe(&mut self, splat: Splat) -> Result<(), ProviderContractError> {
        self.count = self
            .count
            .checked_add(1)
            .ok_or_else(|| provider_message("splat count overflow"))?;
        self.maximum_scale = self
            .maximum_scale
            .max(splat.scale.into_iter().map(f64::from).fold(0.0, f64::max));
        for axis in 0..3 {
            self.center_min[axis] = self.center_min[axis].min(splat.position[axis]);
            self.center_max[axis] = self.center_max[axis].max(splat.position[axis]);
        }
        Ok(())
    }
    fn bounds(self) -> BoundsDto {
        let expansion = self.maximum_scale * 3.0;
        BoundsDto {
            min: PointDto {
                x: self.center_min[0] - expansion,
                y: self.center_min[1] - expansion,
                z: self.center_min[2] - expansion,
            },
            max: PointDto {
                x: self.center_max[0] + expansion,
                y: self.center_max[1] + expansion,
                z: self.center_max[2] + expansion,
            },
        }
    }
    fn diagonal(self) -> f64 {
        ((self.center_max[0] - self.center_min[0]).powi(2)
            + (self.center_max[1] - self.center_min[1]).powi(2)
            + (self.center_max[2] - self.center_min[2]).powi(2))
        .sqrt()
    }
}

fn write_spool_splat(writer: &mut impl Write, splat: Splat) -> Result<(), ProviderContractError> {
    for value in splat.position {
        writer
            .write_all(&value.to_le_bytes())
            .map_err(provider_io)?;
    }
    for value in splat.scale {
        writer
            .write_all(&value.to_le_bytes())
            .map_err(provider_io)?;
    }
    for value in splat.rotation {
        writer
            .write_all(&value.to_le_bytes())
            .map_err(provider_io)?;
    }
    writer.write_all(&splat.color).map_err(provider_io)
}

fn read_spool_splat(bytes: &[u8; SPOOL_STRIDE]) -> Splat {
    let f64_at =
        |offset| f64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("fixed spool"));
    let f32_at =
        |offset| f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("fixed spool"));
    Splat {
        position: [f64_at(0), f64_at(8), f64_at(16)],
        scale: [f32_at(24), f32_at(28), f32_at(32)],
        rotation: [f32_at(36), f32_at(40), f32_at(44), f32_at(48)],
        color: bytes[52..56].try_into().expect("fixed spool"),
    }
}

#[derive(Debug)]
struct Prepared {
    manifest_resource: GeometryResource,
    artifacts: Vec<PreparedDatasetArtifact>,
    tile_count: u64,
    stats: Stats,
}

#[derive(Debug)]
struct PendingNode {
    id: String,
    parent: Option<String>,
    spool: PathBuf,
    stats: Stats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedManifest {
    schema_version: u32,
    roots: Vec<String>,
    tiles: Vec<TileDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TileDto {
    id: String,
    parent: Option<String>,
    children: Vec<String>,
    bounds: TaggedBounds,
    content_transform: [f64; 16],
    geometric_error: f64,
    refinement: &'static str,
    contents: Vec<ContentDto>,
    child_page: Option<serde_json::Value>,
    provider_metadata: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentDto {
    kind: &'static str,
    uri: String,
    byte_offset: Option<u64>,
    byte_length: Option<u64>,
    primitive_count: Option<u64>,
    content_hash: Option<String>,
    decoder_parameters: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TaggedBounds {
    AxisAlignedBox { bounds: BoundsDto },
}

#[derive(Debug, Clone, Copy, Serialize)]
struct BoundsDto {
    min: PointDto,
    max: PointDto,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct PointDto {
    x: f64,
    y: f64,
    z: f64,
}

#[allow(clippy::too_many_lines)]
fn prepare_dataset(
    source: &Path,
    staging: &Path,
    header: &PlyHeader,
    schema: &SourceSchema,
    options: ImportOptions,
    context: &mut dyn ProviderOperationContext,
) -> Result<Prepared, ProviderContractError> {
    let work = staging.join("work");
    let tiles_root = staging.join("tiles");
    fs::create_dir_all(&work).map_err(provider_io)?;
    fs::create_dir_all(&tiles_root).map_err(provider_io)?;
    let root_spool = work.join("r.spool");
    let mut root_writer = BufWriter::new(File::create(&root_spool).map_err(provider_io)?);
    let mut root_stats = Stats::empty();
    visit_source(source, header, schema, context, |splat| {
        root_stats.observe(splat)?;
        write_spool_splat(&mut root_writer, splat)
    })?;
    root_writer.flush().map_err(provider_io)?;
    if root_stats.count != header.vertex_count {
        return Err(provider_message(
            "Gaussian source count changed during preparation",
        ));
    }
    let mut pending = VecDeque::from([PendingNode {
        id: "r".to_owned(),
        parent: None,
        spool: root_spool,
        stats: root_stats,
    }]);
    let mut tiles = Vec::new();
    let mut artifacts = vec![artifact_for(
        staging,
        Path::new("source.ply"),
        SOURCE_MEDIA_TYPE,
        context,
    )?];
    let mut processed = 0_u64;
    while let Some(node) = pending.pop_front() {
        check_cancelled(context)?;
        let leaf = node.stats.count <= options.maximum_leaf_splats;
        let content_count = if leaf {
            node.stats.count
        } else {
            node.stats.count.min(options.maximum_internal_sample_splats)
        };
        let tile_relative = PathBuf::from("tiles").join(format!("{}.ply", node.id));
        write_tile_ply(
            &node.spool,
            &staging.join(&tile_relative),
            node.stats.count,
            content_count,
            context,
        )?;
        let tile_artifact = artifact_for(staging, &tile_relative, PLY_MEDIA_TYPE, context)?;
        let mut children = Vec::new();
        if !leaf {
            let left_id = format!("{}0", node.id);
            let right_id = format!("{}1", node.id);
            let (left, right) = split_spool(&node, &work, &left_id, &right_id, context)?;
            children = vec![left_id, right_id];
            pending.push_back(left);
            pending.push_back(right);
        }
        fs::remove_file(&node.spool).map_err(provider_io)?;
        let error = if leaf {
            (node.stats.maximum_scale * 2.0).max(0.001)
        } else {
            node.stats
                .diagonal()
                .max(node.stats.maximum_scale * 2.0)
                .max(0.001)
        };
        tiles.push(TileDto {
            id: node.id.clone(), parent: node.parent, children,
            bounds: TaggedBounds::AxisAlignedBox { bounds: node.stats.bounds() },
            content_transform: [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0],
            geometric_error: error,
            refinement: "replace",
            contents: vec![ContentDto {
                kind: "gaussianSplats", uri: tile_relative.to_string_lossy().replace('\\', "/"),
                byte_offset: None, byte_length: tile_artifact.resource.byte_length,
                primitive_count: Some(content_count), content_hash: Some(tile_artifact.resource.object_hash.0.clone()),
                decoder_parameters: serde_json::json!({"schemaVersion":1,"schema":"himmelcadRgba8","sourceDerivation":"hcad.gaussian-splat-render-derivation@1"}),
            }],
            child_page: None,
            provider_metadata: serde_json::json!({"sourceSplatCount":node.stats.count,"renderSplatCount":content_count,"maximumScale":node.stats.maximum_scale}),
        });
        artifacts.push(tile_artifact);
        processed = processed.saturating_add(node.stats.count);
        context.report_progress(ProviderProgress {
            phase: "splat-partition".to_owned(),
            completed: processed.min(header.vertex_count),
            total: Some(header.vertex_count),
            message: "building bounded Gaussian-splat residency tiles".to_owned(),
        });
    }
    tiles.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    let manifest = PreparedManifest {
        schema_version: 1,
        roots: vec!["r".to_owned()],
        tiles,
    };
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|error| provider_message(error.to_string()))?;
    let manifest_path = staging.join("manifest.json");
    write_atomic_bytes(&manifest_path, &manifest_bytes)?;
    let manifest_artifact = artifact_for(
        staging,
        Path::new("manifest.json"),
        PREPARED_FORMAT_ID,
        context,
    )?;
    let manifest_resource = manifest_artifact.resource.clone();
    artifacts.push(manifest_artifact);
    fs::remove_dir_all(work).map_err(provider_io)?;
    Ok(Prepared {
        manifest_resource,
        tile_count: u64::try_from(manifest.tiles.len()).unwrap_or(u64::MAX),
        artifacts,
        stats: root_stats,
    })
}

fn split_spool(
    node: &PendingNode,
    work: &Path,
    left_id: &str,
    right_id: &str,
    context: &dyn ProviderOperationContext,
) -> Result<(PendingNode, PendingNode), ProviderContractError> {
    let extents = [0, 1, 2].map(|axis| node.stats.center_max[axis] - node.stats.center_min[axis]);
    let axis = extents
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))
        .map_or(0, |(axis, _)| axis);
    let midpoint = node.stats.center_min[axis] + extents[axis] * 0.5;
    let degenerate = extents[axis] <= f64::EPSILON;
    let left_path = work.join(format!("{left_id}.spool"));
    let right_path = work.join(format!("{right_id}.spool"));
    let mut left_writer = BufWriter::new(File::create(&left_path).map_err(provider_io)?);
    let mut right_writer = BufWriter::new(File::create(&right_path).map_err(provider_io)?);
    let mut left_stats = Stats::empty();
    let mut right_stats = Stats::empty();
    let mut reader = BufReader::new(File::open(&node.spool).map_err(provider_io)?);
    let mut record = [0_u8; SPOOL_STRIDE];
    for index in 0..node.stats.count {
        if index.is_multiple_of(CANCEL_INTERVAL) {
            check_cancelled(context)?;
        }
        reader.read_exact(&mut record).map_err(provider_io)?;
        let splat = read_spool_splat(&record);
        let left = if degenerate {
            index % 2 == 0
        } else {
            splat.position[axis] <= midpoint
        };
        if left {
            left_writer.write_all(&record).map_err(provider_io)?;
            left_stats.observe(splat)?;
        } else {
            right_writer.write_all(&record).map_err(provider_io)?;
            right_stats.observe(splat)?;
        }
    }
    left_writer.flush().map_err(provider_io)?;
    right_writer.flush().map_err(provider_io)?;
    if left_stats.count == 0 || right_stats.count == 0 {
        return Err(provider_message(
            "Gaussian spatial partition failed to make progress",
        ));
    }
    Ok((
        PendingNode {
            id: left_id.to_owned(),
            parent: Some(node.id.clone()),
            spool: left_path,
            stats: left_stats,
        },
        PendingNode {
            id: right_id.to_owned(),
            parent: Some(node.id.clone()),
            spool: right_path,
            stats: right_stats,
        },
    ))
}

fn write_tile_ply(
    spool: &Path,
    output: &Path,
    source_count: u64,
    output_count: u64,
    context: &dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    let mut writer = BufWriter::new(File::create(output).map_err(provider_io)?);
    write!(writer, "ply\nformat binary_little_endian 1.0\ncomment HimmelCAD prepared Gaussian splat tile\nelement vertex {output_count}\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n").map_err(provider_io)?;
    let mut reader = BufReader::new(File::open(spool).map_err(provider_io)?);
    let mut record = [0_u8; SPOOL_STRIDE];
    let mut written = 0_u64;
    for index in 0..source_count {
        if index.is_multiple_of(CANCEL_INTERVAL) {
            check_cancelled(context)?;
        }
        reader.read_exact(&mut record).map_err(provider_io)?;
        let next_index = u64::try_from(
            (u128::from(written) * u128::from(source_count)) / u128::from(output_count),
        )
        .expect("sample index never exceeds the u64 source count");
        if index == next_index && written < output_count {
            writer.write_all(&record).map_err(provider_io)?;
            written += 1;
        }
    }
    if written != output_count {
        return Err(provider_message(
            "deterministic splat sample cardinality mismatch",
        ));
    }
    writer.flush().map_err(provider_io)?;
    writer.get_ref().sync_all().map_err(provider_io)
}

fn build_package(
    source_path: &Path,
    dataset_id: &str,
    source_resource: &GeometryResource,
    header: &PlyHeader,
    schema: &SourceSchema,
    prepared: Prepared,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let components = CanonicalJsonObject::new(
        "application/vnd.himmelcad.components+json",
        serde_json::json!({
            "hcad.prepared-dataset@1": {
                "formatId": PREPARED_FORMAT_ID,
                "renderDerivation": "hcad.gaussian-splat-render-derivation@1"
            }
        }),
    )?;
    let attributes = CanonicalJsonObject::new(
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({
            "hcad.gaussian-splat-ply-source@1": {
                "sourceSha256": source_resource.object_hash,
                "sourceByteLength": source_resource.byte_length,
                "sourceEncoding": header.encoding,
                "sourceSchema": schema,
                "splatCount": header.vertex_count,
                "bounds": prepared.stats.bounds(),
                "maximumScale": prepared.stats.maximum_scale,
                "tileCount": prepared.tile_count,
                "coordinateSemantics": "source XYZ preserved; PLY declares no CRS, pose or axis conversion",
                "colorSemantics": match schema {
                    SourceSchema::Inria3dgs { .. } => "SH coefficients authoritative; prepared RGB uses clamp(0.5 + C0*f_dc) and opacity sigmoid to RGBA8",
                    SourceSchema::HimmelCadRgba8 => "linear scale, normalized XYZW quaternion and RGBA8 preserved in prepared tiles"
                },
                "authoritativeSourceArtifact": "source.ply"
            }
        }),
    )?;
    let relations = CanonicalJsonObject::new(
        "application/vnd.himmelcad.relations+json",
        serde_json::json!([]),
    )?;
    let geometry = GeometryObject::GaussianSplatCloud {
        dataset: StreamedGeometry {
            format_id: PREPARED_FORMAT_ID.to_owned(),
            metadata: prepared.manifest_resource.clone(),
            element_count: Some(header.vertex_count),
        },
    };
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry)
            .map_err(|error| provider_message(error.to_string()))?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let entity_id = format!("gaussian-splat-{}", source_resource.object_hash.as_str());
    let mut entity = CanonicalEntity {
        id: EntityId(entity_id.clone()),
        revision: 0,
        type_id: EntityTypeId(built_in_type::GAUSSIAN_SPLAT_CLOUD.to_owned()),
        name: source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Gaussian splats")
            .to_owned(),
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref: components.object_hash.clone(),
        attributes_ref: attributes.object_hash.clone(),
        relations_ref: relations.object_hash.clone(),
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"uninitialized Gaussian splat entity"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)
        .map_err(|error| provider_message(error.to_string()))?;
    validate_resolved_representation(&entity, &selected, &geometry)
        .map_err(|error| provider_message(error.to_string()))?;
    Ok(CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: GAUSSIAN_SPLAT_PLY_PROVIDER_ID.to_owned(),
        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
        admissions: vec![CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot: "source".to_owned(),
            expected_generation: None,
            resolved_geometry: geometry,
        }],
        objects: vec![components, attributes, relations],
        datasets: vec![CanonicalPreparedDataset {
            dataset_id: dataset_id.to_owned(),
            format_id: PREPARED_FORMAT_ID.to_owned(),
            entity_id,
            representation_slot: "source".to_owned(),
            root_metadata: prepared.manifest_resource,
            artifacts: prepared.artifacts,
        }],
        resource_sets: Vec::new(),
        presentation_resources: Default::default(),
    })
}

fn artifact_for(
    root: &Path,
    relative: &Path,
    media_type: &str,
    context: &dyn ProviderOperationContext,
) -> Result<PreparedDatasetArtifact, ProviderContractError> {
    let path = root.join(relative);
    let (hash, length) = hash_file(&path, Some(context))?;
    Ok(PreparedDatasetArtifact {
        relative_path: relative.to_owned(),
        resource: GeometryResource {
            object_hash: hash,
            media_type: media_type.to_owned(),
            byte_length: Some(length),
        },
    })
}

fn copy_source(
    source: &Path,
    destination: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<GeometryResource, ProviderContractError> {
    let total = source.metadata().map_err(provider_io)?.len();
    if total == 0 {
        return Err(provider_message("Gaussian PLY is empty"));
    }
    context.report_progress(ProviderProgress {
        phase: "splat-stage".to_owned(),
        completed: 0,
        total: Some(total),
        message: "staging authoritative Gaussian PLY".to_owned(),
    });
    let mut input = BufReader::new(File::open(source).map_err(provider_io)?);
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(provider_io)?;
    let mut output = BufWriter::new(output);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut completed = 0_u64;
    loop {
        check_cancelled(context)?;
        let count = input.read(&mut buffer).map_err(provider_io)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(provider_io)?;
        digest.update(&buffer[..count]);
        completed = completed
            .checked_add(count as u64)
            .ok_or_else(|| provider_message("source byte count overflow"))?;
        context.report_progress(ProviderProgress {
            phase: "splat-stage".to_owned(),
            completed,
            total: Some(total),
            message: "staging authoritative Gaussian PLY".to_owned(),
        });
    }
    output.flush().map_err(provider_io)?;
    output.get_ref().sync_all().map_err(provider_io)?;
    if completed != total {
        return Err(provider_message("Gaussian PLY changed while staging"));
    }
    Ok(GeometryResource {
        object_hash: ObjectHash(hex::encode(digest.finalize())),
        media_type: SOURCE_MEDIA_TYPE.to_owned(),
        byte_length: Some(completed),
    })
}

fn hash_file(
    path: &Path,
    context: Option<&dyn ProviderOperationContext>,
) -> Result<(ObjectHash, u64), ProviderContractError> {
    let mut reader = BufReader::new(File::open(path).map_err(provider_io)?);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut length = 0_u64;
    loop {
        if let Some(context) = context {
            check_cancelled(context)?;
        }
        let count = reader.read(&mut buffer).map_err(provider_io)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        length = length
            .checked_add(count as u64)
            .ok_or_else(|| provider_message("artifact length overflow"))?;
    }
    Ok((ObjectHash(hex::encode(digest.finalize())), length))
}

fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), ProviderContractError> {
    let temporary = path.with_extension("json.pending");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(provider_io)?;
    file.write_all(bytes).map_err(provider_io)?;
    file.sync_all().map_err(provider_io)?;
    fs::rename(temporary, path).map_err(provider_io)
}

fn publish_staging(
    staging: &mut StagingDirectory,
    destination: &Path,
    artifacts: &[PreparedDatasetArtifact],
) -> Result<(), ProviderContractError> {
    if destination.exists() {
        for artifact in artifacts {
            verify_file(
                &destination.join(&artifact.relative_path),
                &artifact.resource,
            )?;
        }
        return Ok(());
    }
    fs::rename(&staging.path, destination).map_err(provider_io)?;
    staging.published = true;
    for artifact in artifacts {
        verify_file(
            &destination.join(&artifact.relative_path),
            &artifact.resource,
        )?;
    }
    Ok(())
}

fn passthrough_source(
    package: &CanonicalImportPackage,
) -> Option<(&str, &PreparedDatasetArtifact)> {
    if package.admissions.len() != 1
        || !matches!(
            package.admissions[0].resolved_geometry,
            GeometryObject::GaussianSplatCloud { .. }
        )
    {
        return None;
    }
    package.datasets.iter().find_map(|dataset| {
        dataset
            .artifacts
            .iter()
            .find(|artifact| {
                artifact.relative_path == Path::new("source.ply")
                    && artifact.resource.media_type == SOURCE_MEDIA_TYPE
            })
            .map(|artifact| (dataset.dataset_id.as_str(), artifact))
    })
}

fn copy_verified(
    source: &Path,
    destination: &Path,
    resource: &GeometryResource,
    context: &mut dyn ProviderOperationContext,
    phase: &str,
) -> Result<(), ProviderContractError> {
    verify_file_with_context(source, resource, Some(context))?;
    check_cancelled(context)?;
    if destination.exists() {
        return Err(provider_message("export target already exists"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| provider_message("export target has no parent"))?;
    fs::create_dir_all(parent).map_err(provider_io)?;
    let temporary = parent.join(format!(
        ".{}.partial",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("splats.ply")
    ));
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(provider_io)?;
    }
    let result = (|| {
        let mut input = BufReader::new(File::open(source).map_err(provider_io)?);
        let mut output = BufWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(provider_io)?,
        );
        let total = resource.byte_length.unwrap_or(0);
        let mut completed = 0_u64;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        loop {
            check_cancelled(context)?;
            let count = input.read(&mut buffer).map_err(provider_io)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(provider_io)?;
            completed += count as u64;
            context.report_progress(ProviderProgress {
                phase: phase.to_owned(),
                completed,
                total: Some(total),
                message: "exporting exact Gaussian PLY".to_owned(),
            });
        }
        output.flush().map_err(provider_io)?;
        output.get_ref().sync_all().map_err(provider_io)?;
        verify_file_with_context(&temporary, resource, Some(context))?;
        fs::rename(&temporary, destination).map_err(provider_io)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn verify_file(path: &Path, resource: &GeometryResource) -> Result<(), ProviderContractError> {
    verify_file_with_context(path, resource, None)
}

fn verify_file_with_context(
    path: &Path,
    resource: &GeometryResource,
    context: Option<&dyn ProviderOperationContext>,
) -> Result<(), ProviderContractError> {
    let (hash, length) = hash_file(path, context)?;
    if hash != resource.object_hash || Some(length) != resource.byte_length {
        return Err(provider_message(format!(
            "artifact hash/length mismatch: {}",
            path.display()
        )));
    }
    Ok(())
}

struct StagingDirectory {
    path: PathBuf,
    published: bool,
}

impl StagingDirectory {
    fn create(root: &Path, source: &Path) -> Result<Self, ProviderContractError> {
        for attempt in 0..32_u32 {
            let path = root.join(format!(".splat-import-{}", nonce(source, attempt)));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        published: false,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(provider_io(error)),
            }
        }
        Err(provider_message(
            "could not allocate Gaussian-splat staging directory",
        ))
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn nonce(source: &Path, attempt: u32) -> String {
    let mut digest = Sha256::new();
    digest.update(source.as_os_str().to_string_lossy().as_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(attempt.to_le_bytes());
    if let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) {
        digest.update(duration.as_nanos().to_le_bytes());
    }
    hex::encode(digest.finalize())
}

fn report_rows(
    context: &mut dyn ProviderOperationContext,
    phase: &str,
    completed: u64,
    total: u64,
) {
    context.report_progress(ProviderProgress {
        phase: phase.to_owned(),
        completed,
        total: Some(total),
        message: "streaming Gaussian splat records".to_owned(),
    });
}

fn check_cancelled(context: &dyn ProviderOperationContext) -> Result<(), ProviderContractError> {
    if context.is_cancelled() {
        Err(ProviderContractError::Cancelled)
    } else {
        Ok(())
    }
}

fn provider_message(message: impl Into<String>) -> ProviderContractError {
    ProviderContractError::Provider(message.into())
}

#[allow(clippy::needless_pass_by_value)]
fn provider_io(error: std::io::Error) -> ProviderContractError {
    provider_message(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hcad-splat-provider-{label}-{}",
                nonce(Path::new(label), 0)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const INRIA_HEADER: &str = "ply\nformat ascii 1.0\ncomment 3D Gaussian Splatting INRIA\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n";

    #[test]
    fn ascii_inria_prepares_hierarchy_and_roundtrips_source_exactly() {
        let root = TempRoot::new("ascii");
        let source = root.0.join("scene.ply");
        let mut bytes = INRIA_HEADER.as_bytes().to_vec();
        bytes.extend_from_slice(b"1000000 2000000 3 0 0 0 0 0 0 2 -2 -2 -2 1 0 0 0\n1000010 2000010 8 0 0 0 1 -1 0 -2 -1 -1 -1 1 0 0 0\n");
        fs::write(&source, &bytes).unwrap();
        let provider = GaussianSplatPlyProvider::new(root.0.join("prepared"));
        let request = CanonicalImportRequest {
            source: &source,
            format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
            options: &serde_json::json!({"maximumSplats":10,"maximumLeafSplats":1,"maximumInternalSampleSplats":1}),
        };
        let mut context = TestContext::default();
        let package = provider.import(request, &mut context).unwrap();
        package.validate().unwrap();
        assert!(matches!(
            package.admissions[0].resolved_geometry,
            GeometryObject::GaussianSplatCloud { .. }
        ));
        assert_eq!(5, package.datasets[0].artifacts.len());
        let dataset_root = root
            .0
            .join("prepared")
            .join(&package.datasets[0].dataset_id);
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(dataset_root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(3, manifest["tiles"].as_array().unwrap().len());
        assert_eq!(
            Some(1),
            manifest["tiles"][0]["contents"][0]["primitiveCount"].as_u64()
        );
        assert!(context
            .progress
            .windows(2)
            .all(|pair| pair[0].phase != pair[1].phase || pair[0].completed <= pair[1].completed));

        let target = root.0.join("roundtrip.ply");
        let plan = provider
            .plan_export(CanonicalExportRequest {
                target: &target,
                format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                package: &package,
                options: &serde_json::json!({}),
            })
            .unwrap();
        assert!(plan.semantic_losses.is_empty());
        provider
            .export(
                CanonicalExportRequest {
                    target: &target,
                    format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                    package: &package,
                    options: &serde_json::json!({}),
                },
                &plan,
                &mut TestContext::default(),
            )
            .unwrap();
        assert_eq!(bytes, fs::read(target).unwrap());

        let mut without_source = package.clone();
        without_source.datasets[0]
            .artifacts
            .retain(|artifact| artifact.relative_path != Path::new("source.ply"));
        without_source.validate().unwrap();
        let lossy = provider
            .plan_export(CanonicalExportRequest {
                target: &root.0.join("not-authoritative.ply"),
                format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                package: &without_source,
                options: &serde_json::json!({}),
            })
            .unwrap();
        assert_eq!(
            vec![LOSS_SPLAT_EXPORT_NOT_PASSTHROUGH.to_owned()],
            lossy.semantic_losses
        );

        assert!(provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                    options: &serde_json::json!({
                        "maximumSplats": 1,
                        "maximumLeafSplats": 1,
                        "maximumInternalSampleSplats": 1
                    }),
                },
                &mut TestContext::default(),
            )
            .is_err());

        let repeated = provider
            .import(request, &mut TestContext::default())
            .unwrap();
        assert_eq!(package, repeated);
    }

    #[test]
    fn binary_himmelcad_rgba8_is_strictly_accepted() {
        let root = TempRoot::new("binary");
        let source = root.0.join("hc.ply");
        let mut bytes = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n".to_vec();
        for value in [7.0_f64, 8.0, 9.0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [0.1_f32, 0.2, 0.3, 0.0, 0.0, 0.0, 1.0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&[10, 20, 30, 40]);
        fs::write(&source, bytes).unwrap();
        let provider = GaussianSplatPlyProvider::new(root.0.join("prepared"));
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut TestContext::default(),
            )
            .unwrap();
        package.validate().unwrap();
        assert_eq!(
            Some(1),
            package.admissions[0].resolved_geometry_element_count()
        );
    }

    #[test]
    fn malformed_missing_nonfinite_and_incomplete_sh_fail_closed() {
        let root = TempRoot::new("invalid");
        let provider = GaussianSplatPlyProvider::new(root.0.join("prepared"));
        let cases = [
            ("missing.ply", "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n".to_owned()),
            ("nonfinite.ply", format!("{INRIA_HEADER}nan 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0\n0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0\n")),
            ("rest.ply", INRIA_HEADER.replace("property float opacity\n", "property float f_rest_0\nproperty float opacity\n") + "0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0\n0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0\n"),
        ];
        for (name, value) in cases {
            let source = root.0.join(name);
            fs::write(&source, value).unwrap();
            assert!(provider
                .import(
                    CanonicalImportRequest {
                        source: &source,
                        format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                        options: &serde_json::json!({}),
                    },
                    &mut TestContext::default()
                )
                .is_err());
        }
    }

    #[test]
    fn cancellation_removes_unpublished_preparation() {
        let root = TempRoot::new("cancel");
        let source = root.0.join("scene.ply");
        fs::write(&source, format!("{INRIA_HEADER}0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0\n1 1 1 0 0 0 0 0 0 0 0 0 0 1 0 0 0\n")).unwrap();
        let prepared = root.0.join("prepared");
        let provider = GaussianSplatPlyProvider::new(prepared.clone());
        let result = provider.import(
            CanonicalImportRequest {
                source: &source,
                format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                options: &serde_json::json!({}),
            },
            &mut TestContext {
                cancelled: true,
                progress: Vec::new(),
            },
        );
        assert!(matches!(result, Err(ProviderContractError::Cancelled)));
        assert!(fs::read_dir(prepared).unwrap().next().is_none());
    }

    #[test]
    #[ignore = "rare synthetic scale-preparation gate"]
    fn synthetic_scale_preparation_keeps_every_tile_bounded() {
        const SPLAT_COUNT: u64 = 16_385;
        const MAX_LEAF_SPLATS: u64 = 512;
        const MAX_INTERNAL_SAMPLE_SPLATS: u64 = 128;

        let root = TempRoot::new("synthetic-scale");
        let source = root.0.join("scale.ply");
        let mut bytes = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex {SPLAT_COUNT}\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n"
        )
        .into_bytes();
        for index in 0..SPLAT_COUNT {
            let x = index as f64;
            let y = ((index * 37) % 997) as f64;
            let z = ((index * 101) % 313) as f64;
            for value in [x, y, z] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in [0.1_f32, 0.2, 0.3, 0.0, 0.0, 0.0, 1.0] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes.extend_from_slice(&[10, 20, 30, 255]);
        }
        fs::write(&source, bytes).unwrap();

        let prepared = root.0.join("prepared");
        let provider = GaussianSplatPlyProvider::new(prepared.clone());
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GAUSSIAN_SPLAT_PLY_FORMAT_ID,
                    options: &serde_json::json!({
                        "maximumSplats": SPLAT_COUNT,
                        "maximumLeafSplats": MAX_LEAF_SPLATS,
                        "maximumInternalSampleSplats": MAX_INTERNAL_SAMPLE_SPLATS
                    }),
                },
                &mut TestContext::default(),
            )
            .unwrap();

        let dataset_root = prepared.join(&package.datasets[0].dataset_id);
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(dataset_root.join("manifest.json")).unwrap()).unwrap();
        let tiles = manifest["tiles"].as_array().unwrap();
        assert!(tiles.len() > 32);
        for tile in tiles {
            let count = tile["contents"][0]["primitiveCount"].as_u64().unwrap();
            let has_children = !tile["children"].as_array().unwrap().is_empty();
            let limit = if has_children {
                MAX_INTERNAL_SAMPLE_SPLATS
            } else {
                MAX_LEAF_SPLATS
            };
            assert!(count <= limit, "tile count {count} exceeds limit {limit}");
        }
    }

    trait GeometryCount {
        fn resolved_geometry_element_count(&self) -> Option<u64>;
    }
    impl GeometryCount for CanonicalRepresentationAdmission {
        fn resolved_geometry_element_count(&self) -> Option<u64> {
            match &self.resolved_geometry {
                GeometryObject::GaussianSplatCloud { dataset } => dataset.element_count,
                _ => None,
            }
        }
    }
}
