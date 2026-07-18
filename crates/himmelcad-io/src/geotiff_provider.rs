//! Canonical `GeoTIFF` and Cloud Optimized `GeoTIFF` provider.
//!
//! The provider preserves the immutable source TIFF as a file-backed resource.
//! Canonical geometry owns the exact `f64` pixel-center mapping; TIFF tiles,
//! strips and overviews remain available to range/window readers without a
//! full-raster decode during import.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use geotiff_reader::{GeoTiffFile, GeoTiffOpenOptions};
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CanonicalEntity, DepthSampling, ElevationSurfaceGeometry, EntityTypeId,
    GeometryObject, GeometryResource, OrthoGridMapping, RasterCellDiagonal, RasterConnectivity,
    RasterImageGeometry, RasterInterpolation, RasterMapping, Representation,
    RepresentationAuthority, RepresentationRole, Vector3,
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
    CanonicalResourceSet, ExportOutput, FormatCapability, FormatProviderDescriptor, ImportProbe,
    ImportProbeRequest, PreparedDatasetArtifact, PreparedResourceArtifact, ProviderContractError,
    ProviderOperationContext, ProviderProgress, CANONICAL_IO_SCHEMA_VERSION,
};
use crate::geotiff_preparation::prepare_elevation_geotiff;

/// `GeoTIFF` 1.1 including locally range-readable COG storage.
pub const GEOTIFF_FORMAT_ID: &str = "geotiff@1.1";
/// Stable provider identity.
pub const GEOTIFF_PROVIDER_ID: &str = "hcad.io.geotiff-rust@1";

/// A georeferencing transform is required for canonical ortho-grid geometry.
pub const UNSUPPORTED_MISSING_TRANSFORM: &str = "hcad.unsupported.geotiff.missing-transform@1";
/// A usable horizontal CRS is required; no reprojection is guessed.
pub const UNSUPPORTED_MISSING_CRS: &str = "hcad.unsupported.geotiff.missing-crs@1";
/// The affine pixel basis is degenerate or contains non-finite coordinates.
pub const UNSUPPORTED_INVALID_TRANSFORM: &str = "hcad.unsupported.geotiff.invalid-transform@1";
/// Elevation import accepts exactly one numeric sample band.
pub const UNSUPPORTED_ELEVATION_BANDS: &str = "hcad.unsupported.geotiff.elevation-band-layout@1";
/// The TIFF sample layout is outside the exact canonical raster subset.
pub const UNSUPPORTED_SAMPLE_LAYOUT: &str = "hcad.unsupported.geotiff.sample-layout@1";
/// A DEM `NoData` tag must be a finite numeric sentinel or NaN.
pub const UNSUPPORTED_NODATA: &str = "hcad.unsupported.geotiff.nodata@1";
/// Export currently guarantees losslessness only by copying one preserved TIFF resource.
pub const LOSS_EXPORT_NOT_PASSTHROUGH: &str = "hcad.loss.geotiff.not-exact-passthrough@1";
/// More than one canonical raster cannot be represented by one TIFF output file.
pub const LOSS_EXPORT_MULTIPLE_ENTITIES: &str = "hcad.loss.geotiff.multiple-entities@1";

const TIFF_MEDIA_TYPE: &str = "image/tiff";
const COMPONENTS_MEDIA_TYPE: &str = "application/vnd.himmelcad.components+json";
const ATTRIBUTES_MEDIA_TYPE: &str = "application/vnd.himmelcad.attributes+json";
const RELATIONS_MEDIA_TYPE: &str = "application/vnd.himmelcad.relations+json";
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Pure-Rust canonical GeoTIFF/COG provider.
pub struct GeoTiffCanonicalProvider {
    descriptor: FormatProviderDescriptor,
    resource_root: PathBuf,
}

impl GeoTiffCanonicalProvider {
    /// Creates a provider whose immutable TIFF resources are staged below `resource_root`.
    #[must_use]
    pub fn new(resource_root: PathBuf) -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: GEOTIFF_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "GeoTIFF / Cloud Optimized GeoTIFF".to_owned(),
                format_ids: vec![GEOTIFF_FORMAT_ID.to_owned()],
                extensions: vec!["tif".to_owned(), "tiff".to_owned()],
                media_types: vec![TIFF_MEDIA_TYPE.to_owned(), "image/geotiff".to_owned()],
                capabilities: vec![FormatCapability::Import, FormatCapability::Export],
            },
            resource_root,
        }
    }
}

impl Default for GeoTiffCanonicalProvider {
    fn default() -> Self {
        Self::new(env::temp_dir().join("himmelcad-geotiff-resources"))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RasterInterpretation {
    #[default]
    Auto,
    RasterImage,
    ElevationSurface,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct GeoTiffImportOptions {
    interpretation: RasterInterpretation,
    maximum_height_jump: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct GeoTiffExportOptions {
    accepted_loss_codes: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceMetadata {
    schema_id: &'static str,
    source_sha256: String,
    source_byte_length: u64,
    width: u32,
    height: u32,
    band_count: u32,
    bits_per_sample: Vec<u16>,
    sample_format: Vec<u16>,
    photometric_interpretation: Option<u16>,
    compression: u16,
    planar_configuration: u16,
    storage: StorageMetadata,
    overview_count: usize,
    epsg: Option<u32>,
    projected_epsg: Option<u16>,
    geographic_epsg: Option<u16>,
    vertical_epsg: Option<u16>,
    raster_type: u16,
    no_data: Option<String>,
    corner_transform: [f64; 6],
    pixel_center_origin: [f64; 2],
    source_crs_equals_display_crs: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum StorageMetadata {
    Tiled {
        tile_width: u32,
        tile_height: u32,
        range_readable: bool,
    },
    Stripped {
        rows_per_strip: u32,
        range_readable: bool,
    },
}

#[derive(Clone)]
struct StagedSource {
    resource: GeometryResource,
    relative_path: PathBuf,
}

impl CanonicalImportProvider for GeoTiffCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        if !has_tiff_magic(request.prefix) {
            return Ok(None);
        }
        let extension_matches = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "tif" | "tiff"));
        let media_matches = request.media_type.is_some_and(|value| {
            value.eq_ignore_ascii_case(TIFF_MEDIA_TYPE)
                || value.eq_ignore_ascii_case("image/geotiff")
        });
        Ok(Some(ImportProbe {
            format_id: GEOTIFF_FORMAT_ID.to_owned(),
            confidence: if extension_matches || media_matches {
                94
            } else {
                72
            },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != GEOTIFF_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: GeoTiffImportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        if options
            .maximum_height_jump
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(provider_message(UNSUPPORTED_INVALID_TRANSFORM));
        }
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "stage".to_owned(),
            completed: 0,
            total: fs::metadata(request.source).ok().map(|value| value.len()),
            message: "GeoTIFF wird unveränderlich und hashgebunden gestaged".to_owned(),
        });
        let staged = stage_source_file(request.source, &self.resource_root, context)?;
        let staged_path = self.resource_root.join(&staged.relative_path);
        context.report_progress(ProviderProgress {
            phase: "metadata".to_owned(),
            completed: staged.resource.byte_length.unwrap_or(0),
            total: staged.resource.byte_length,
            message: "GeoTIFF-Metadaten werden begrenzt gelesen".to_owned(),
        });
        let open_options = GeoTiffOpenOptions {
            block_cache_bytes: 8 * 1024 * 1024,
            block_cache_slots: 32,
            parse_budgets: tiff_reader::ParseBudgets {
                max_ifds: 256,
                max_ifd_entries: 4_096,
                max_tag_value_bytes: 16 * 1024 * 1024,
                max_metadata_value_bytes: 32 * 1024 * 1024,
            },
            decode_output_bytes: 16 * 1024 * 1024,
        };
        let geotiff =
            GeoTiffFile::open_with_options(&staged_path, open_options).map_err(map_open_error)?;
        let mapping = ortho_mapping(&geotiff)?;
        if geotiff.crs().horizontal().is_none() {
            return Err(provider_message(UNSUPPORTED_MISSING_CRS));
        }
        let base_ifd = geotiff
            .tiff()
            .ifd(geotiff.base_ifd_index())
            .map_err(provider_error)?;
        validate_sample_layout(base_ifd)?;
        let interpretation = resolve_interpretation(options.interpretation);
        if interpretation == RasterInterpretation::ElevationSurface && geotiff.band_count() != 1 {
            return Err(provider_message(UNSUPPORTED_ELEVATION_BANDS));
        }
        if interpretation == RasterInterpretation::ElevationSurface {
            validate_elevation_nodata(geotiff.nodata())?;
        }
        check_cancelled(context)?;
        let source = source_metadata(&geotiff, base_ifd, &staged.resource, mapping);
        let geometry = match interpretation {
            RasterInterpretation::RasterImage | RasterInterpretation::Auto => {
                GeometryObject::RasterImage {
                    raster: Box::new(RasterImageGeometry {
                        pixels: staged.resource.clone(),
                        width: geotiff.width(),
                        height: geotiff.height(),
                        mapping: RasterMapping::OrthoGrid(mapping),
                        depth: None,
                    }),
                }
            }
            RasterInterpretation::ElevationSurface => GeometryObject::ElevationSurface {
                surface: Box::new(ElevationSurfaceGeometry::Grid {
                    raster: staged.resource.clone(),
                    mapping,
                    sampling: DepthSampling {
                        semantics: himmelcad_core::entity_model::DepthSemantics::ElevationZ,
                        interpolation: RasterInterpolation::DiscontinuityAware,
                        connectivity: RasterConnectivity::Continuous {
                            maximum_height_jump: options.maximum_height_jump,
                            diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                        },
                    },
                }),
            },
        };
        let prepared = if interpretation == RasterInterpretation::ElevationSurface {
            Some(prepare_elevation_geotiff(
                &geotiff,
                &self.resource_root,
                &staged.resource,
                mapping,
                options.maximum_height_jump,
                context,
            )?)
        } else {
            None
        };
        let staged_for_dataset = staged.clone();
        let mut package = build_package(request.source, &source, geometry, interpretation, staged)?;
        if let Some(prepared) = prepared {
            let admission = package
                .admissions
                .first()
                .ok_or(ProviderContractError::InvalidPackage)?;
            let mut artifacts = vec![PreparedDatasetArtifact {
                relative_path: staged_for_dataset.relative_path,
                resource: staged_for_dataset.resource.clone(),
            }];
            artifacts.extend(prepared.artifacts);
            package.datasets.push(CanonicalPreparedDataset {
                dataset_id: prepared.dataset_id,
                format_id: staged_for_dataset.resource.media_type.clone(),
                entity_id: admission.entity.id.0.clone(),
                representation_slot: admission.representation_slot.clone(),
                root_metadata: staged_for_dataset.resource,
                artifacts,
            });
        }
        package.validate()?;
        context.report_progress(ProviderProgress {
            phase: "admit".to_owned(),
            completed: 1,
            total: Some(1),
            message: "GeoTIFF ist kanonisch und hashgebunden".to_owned(),
        });
        Ok(package)
    }
}

impl CanonicalExportProvider for GeoTiffCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn plan_export(
        &self,
        request: CanonicalExportRequest<'_>,
    ) -> Result<CanonicalExportPlan, ProviderContractError> {
        if request.format_id != GEOTIFF_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        request.package.validate()?;
        let mut losses = Vec::new();
        if request.package.admissions.len() != 1 {
            losses.push(LOSS_EXPORT_MULTIPLE_ENTITIES.to_owned());
        }
        if passthrough_artifact(request.package).is_none() {
            losses.push(LOSS_EXPORT_NOT_PASSTHROUGH.to_owned());
        }
        losses.sort();
        losses.dedup();
        let relative_path = request
            .target
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| provider_message("GeoTIFF export target must be a file path"))?;
        Ok(CanonicalExportPlan {
            format_id: GEOTIFF_FORMAT_ID.to_owned(),
            outputs: vec![ExportOutput {
                relative_path,
                media_type: TIFF_MEDIA_TYPE.to_owned(),
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
                "GeoTIFF export plan no longer matches the request",
            ));
        }
        let options: GeoTiffExportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        reject_unaccepted_losses(&plan.semantic_losses, &options.accepted_loss_codes)?;
        if !plan.semantic_losses.is_empty() {
            return Err(provider_message(LOSS_EXPORT_NOT_PASSTHROUGH));
        }
        let artifact = passthrough_artifact(request.package)
            .ok_or_else(|| provider_message(LOSS_EXPORT_NOT_PASSTHROUGH))?;
        let source = self.resource_root.join(&artifact.relative_path);
        copy_verified_resource(&source, request.target, &artifact.resource, context)?;
        Ok(())
    }
}

fn has_tiff_magic(prefix: &[u8]) -> bool {
    prefix.len() >= 4
        && (matches!(&prefix[..4], b"II\x2a\x00" | b"MM\x00\x2a")
            || (prefix.len() >= 8
                && matches!(
                    &prefix[..8],
                    b"II\x2b\x00\x08\x00\x00\x00" | b"MM\x00\x2b\x00\x08\x00\x00"
                )))
}

fn resolve_interpretation(requested: RasterInterpretation) -> RasterInterpretation {
    match requested {
        RasterInterpretation::Auto => RasterInterpretation::RasterImage,
        explicit => explicit,
    }
}

fn ortho_mapping(geotiff: &GeoTiffFile) -> Result<OrthoGridMapping, ProviderContractError> {
    let transform = geotiff
        .transform()
        .ok_or_else(|| provider_message(UNSUPPORTED_MISSING_TRANSFORM))?;
    let values = [
        transform.origin_x,
        transform.pixel_width,
        transform.skew_x,
        transform.origin_y,
        transform.skew_y,
        transform.pixel_height,
    ];
    let determinant =
        transform.pixel_width * transform.pixel_height - transform.skew_x * transform.skew_y;
    if values.iter().any(|value| !value.is_finite()) || determinant.abs() <= f64::EPSILON {
        return Err(provider_message(UNSUPPORTED_INVALID_TRANSFORM));
    }
    let (center_x, center_y) = transform.pixel_to_geo(0.5, 0.5);
    Ok(OrthoGridMapping {
        origin: Vector3 {
            x: center_x,
            y: center_y,
            z: 0.0,
        },
        column_step: Vector3 {
            x: transform.pixel_width,
            y: transform.skew_y,
            z: 0.0,
        },
        row_step: Vector3 {
            x: transform.skew_x,
            y: transform.pixel_height,
            z: 0.0,
        },
    })
}

fn validate_sample_layout(ifd: &tiff_reader::Ifd) -> Result<(), ProviderContractError> {
    let bands = usize::from(ifd.samples_per_pixel());
    let bits = ifd.bits_per_sample();
    let formats = ifd.sample_format();
    let counts_are_valid =
        (bits.len() == 1 || bits.len() == bands) && (formats.len() == 1 || formats.len() == bands);
    let bits_are_supported = bits.iter().all(|value| matches!(value, 8 | 16 | 32 | 64));
    let formats_are_supported = formats.iter().all(|value| matches!(value, 1..=3));
    if bands == 0 || !counts_are_valid || !bits_are_supported || !formats_are_supported {
        return Err(provider_message(UNSUPPORTED_SAMPLE_LAYOUT));
    }
    Ok(())
}

fn validate_elevation_nodata(value: Option<&str>) -> Result<(), ProviderContractError> {
    let Some(value) = value else {
        return Ok(());
    };
    let value = value.trim().trim_end_matches('\0');
    if value.eq_ignore_ascii_case("nan") {
        return Ok(());
    }
    if value.parse::<f64>().is_ok_and(f64::is_finite) {
        Ok(())
    } else {
        Err(provider_message(UNSUPPORTED_NODATA))
    }
}

fn source_metadata(
    geotiff: &GeoTiffFile,
    ifd: &tiff_reader::Ifd,
    resource: &GeometryResource,
    mapping: OrthoGridMapping,
) -> SourceMetadata {
    let transform = geotiff.transform().expect("mapping requires transform");
    let storage = if ifd.is_tiled() {
        StorageMetadata::Tiled {
            tile_width: ifd.tile_width().unwrap_or(0),
            tile_height: ifd.tile_height().unwrap_or(0),
            range_readable: true,
        }
    } else {
        StorageMetadata::Stripped {
            rows_per_strip: ifd.rows_per_strip().unwrap_or(0),
            range_readable: true,
        }
    };
    SourceMetadata {
        schema_id: "hcad.provenance.geotiff-source@1",
        source_sha256: resource.object_hash.0.clone(),
        source_byte_length: resource.byte_length.expect("staged resource length"),
        width: geotiff.width(),
        height: geotiff.height(),
        band_count: geotiff.band_count(),
        bits_per_sample: ifd.bits_per_sample(),
        sample_format: ifd.sample_format(),
        photometric_interpretation: ifd.photometric_interpretation(),
        compression: ifd.compression(),
        planar_configuration: ifd.planar_configuration(),
        storage,
        overview_count: geotiff.overview_count(),
        epsg: geotiff.epsg(),
        projected_epsg: geotiff.crs().projected_epsg(),
        geographic_epsg: geotiff.crs().geographic_epsg(),
        vertical_epsg: geotiff.crs().vertical_epsg(),
        raster_type: geotiff.crs().raster_type,
        no_data: geotiff.nodata().map(str::to_owned),
        corner_transform: [
            transform.origin_x,
            transform.pixel_width,
            transform.skew_x,
            transform.origin_y,
            transform.skew_y,
            transform.pixel_height,
        ],
        pixel_center_origin: [mapping.origin.x, mapping.origin.y],
        source_crs_equals_display_crs: true,
    }
}

fn build_package(
    source_path: &Path,
    source: &SourceMetadata,
    geometry: GeometryObject,
    interpretation: RasterInterpretation,
    staged: StagedSource,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let mut objects = BTreeMap::new();
    let components_ref = intern_object(
        &mut objects,
        COMPONENTS_MEDIA_TYPE,
        serde_json::json!({
            "hcad.geotiff-source@1": {
                "resourceRef": staged.resource.object_hash.clone(),
                "formatId": GEOTIFF_FORMAT_ID,
            }
        }),
    )?;
    let attributes_ref = intern_object(
        &mut objects,
        ATTRIBUTES_MEDIA_TYPE,
        serde_json::json!({
            "hcad.geotiff-import@1": {
                "sourceName": source_path.file_name().and_then(|value| value.to_str()),
                "interpretation": match interpretation {
                    RasterInterpretation::ElevationSurface => "elevationSurface",
                    RasterInterpretation::Auto | RasterInterpretation::RasterImage => "rasterImage",
                },
                "source": source,
            }
        }),
    )?;
    let relations_ref = intern_object(&mut objects, RELATIONS_MEDIA_TYPE, serde_json::json!([]))?;
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref: geometry_object_content_hash(&geometry).map_err(provider_error)?,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let type_id = match interpretation {
        RasterInterpretation::ElevationSurface => built_in_type::ELEVATION_SURFACE,
        RasterInterpretation::Auto | RasterInterpretation::RasterImage => {
            built_in_type::RASTER_IMAGE
        }
    };
    let mut entity = CanonicalEntity {
        id: EntityId(format!(
            "entity-geotiff-{}-{}",
            &staged.resource.object_hash.as_str()[..24],
            if type_id == built_in_type::ELEVATION_SURFACE {
                "elevation"
            } else {
                "image"
            }
        )),
        revision: 0,
        type_id: EntityTypeId(type_id.to_owned()),
        name: source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("GeoTIFF")
            .to_owned(),
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref,
        attributes_ref,
        relations_ref,
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"uninitialized GeoTIFF entity"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity).map_err(provider_error)?;
    validate_resolved_representation(&entity, &selected, &geometry).map_err(provider_error)?;
    Ok(CanonicalImportPackage {
        schema_version: CANONICAL_IO_SCHEMA_VERSION,
        provider_id: GEOTIFF_PROVIDER_ID.to_owned(),
        provider_version: env!("CARGO_PKG_VERSION").to_owned(),
        admissions: vec![CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot: "source".to_owned(),
            expected_generation: None,
            resolved_geometry: geometry,
        }],
        objects: objects.into_values().collect(),
        datasets: Vec::new(),
        resource_sets: vec![CanonicalResourceSet {
            resource_set_id: format!("geotiff-{}", &staged.resource.object_hash.as_str()[..24]),
            resources: vec![PreparedResourceArtifact {
                relative_path: staged.relative_path,
                resource: staged.resource,
            }],
        }],
        presentation_resources: Default::default(),
    })
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

fn stage_source_file(
    source: &Path,
    root: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<StagedSource, ProviderContractError> {
    let source_length = fs::metadata(source).map_err(provider_error)?.len();
    if source_length == 0 {
        return Err(provider_message(UNSUPPORTED_SAMPLE_LAYOUT));
    }
    let staging_root = root.join("geotiff").join(".staging");
    fs::create_dir_all(&staging_root).map_err(provider_error)?;
    let staging = staging_root.join(format!(
        "{}-{}.tif",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(provider_error)?
            .as_nanos()
    ));
    let mut guard = IncompleteFile::new(staging.clone());
    let mut input = BufReader::with_capacity(
        COPY_BUFFER_BYTES,
        File::open(source).map_err(provider_error)?,
    );
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(provider_error)?;
    let mut output = BufWriter::with_capacity(COPY_BUFFER_BYTES, output);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
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
            .ok_or_else(|| provider_message("GeoTIFF byte length overflow"))?;
        context.report_progress(ProviderProgress {
            phase: "stage".to_owned(),
            completed: copied,
            total: Some(source_length),
            message: "GeoTIFF wird unveränderlich und hashgebunden gestaged".to_owned(),
        });
    }
    output.flush().map_err(provider_error)?;
    output.get_ref().sync_all().map_err(provider_error)?;
    if copied != source_length
        || fs::metadata(source).map_err(provider_error)?.len() != source_length
    {
        return Err(provider_message("GeoTIFF source changed while importing"));
    }
    let hash = hex::encode(hasher.finalize());
    let relative_path = PathBuf::from("geotiff")
        .join(&hash[..2])
        .join(format!("{hash}.tif"));
    let destination = root.join(&relative_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(provider_error)?;
    }
    if destination.exists() {
        verify_file(&destination, &hash, copied)?;
        fs::remove_file(&staging).map_err(provider_error)?;
        guard.complete = true;
    } else {
        match fs::rename(&staging, &destination) {
            Ok(()) => guard.complete = true,
            Err(_error) if destination.exists() => {
                verify_file(&destination, &hash, copied)?;
                fs::remove_file(&staging).map_err(provider_error)?;
                guard.complete = true;
            }
            Err(error) => return Err(provider_error(error)),
        }
    }
    Ok(StagedSource {
        resource: GeometryResource {
            object_hash: ObjectHash(hash),
            media_type: GEOTIFF_FORMAT_ID.to_owned(),
            byte_length: Some(copied),
        },
        relative_path,
    })
}

fn passthrough_artifact(package: &CanonicalImportPackage) -> Option<&PreparedResourceArtifact> {
    if package.provider_id != GEOTIFF_PROVIDER_ID || package.admissions.len() != 1 {
        return None;
    }
    let admission = &package.admissions[0];
    if admission.entity.revision != 0 || admission.entity.placement.is_some() {
        return None;
    }
    let attributes = package
        .objects
        .iter()
        .find(|object| object.object_hash == admission.entity.attributes_ref)?;
    let import = attributes.value.get("hcad.geotiff-import@1")?;
    let source = import.get("source")?;
    let mapping = source_mapping(source)?;
    let resource = match &admission.resolved_geometry {
        GeometryObject::RasterImage { raster }
            if admission.entity.type_id.0 == built_in_type::RASTER_IMAGE
                && import.get("interpretation")?.as_str()? == "rasterImage"
                && raster.depth.is_none()
                && raster.width == json_u32(source.get("width")?)?
                && raster.height == json_u32(source.get("height")?)?
                && raster.mapping == RasterMapping::OrthoGrid(mapping) =>
        {
            &raster.pixels
        }
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Grid {
                raster,
                mapping: actual_mapping,
                sampling,
            } if admission.entity.type_id.0 == built_in_type::ELEVATION_SURFACE
                && import.get("interpretation")?.as_str()? == "elevationSurface"
                && *actual_mapping == mapping
                && sampling.semantics
                    == himmelcad_core::entity_model::DepthSemantics::ElevationZ
                && sampling.interpolation == RasterInterpolation::DiscontinuityAware
                && matches!(
                    sampling.connectivity,
                    RasterConnectivity::Continuous {
                        maximum_height_jump: None,
                        diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                    }
                ) =>
            {
                raster
            }
            _ => return None,
        },
        _ => return None,
    };
    if resource.media_type != GEOTIFF_FORMAT_ID {
        return None;
    }
    package
        .resource_sets
        .iter()
        .flat_map(|set| &set.resources)
        .find(|artifact| &artifact.resource == resource)
}

fn source_mapping(source: &serde_json::Value) -> Option<OrthoGridMapping> {
    let transform = source.get("cornerTransform")?.as_array()?;
    let center = source.get("pixelCenterOrigin")?.as_array()?;
    if transform.len() != 6 || center.len() != 2 {
        return None;
    }
    Some(OrthoGridMapping {
        origin: Vector3 {
            x: center[0].as_f64()?,
            y: center[1].as_f64()?,
            z: 0.0,
        },
        column_step: Vector3 {
            x: transform[1].as_f64()?,
            y: transform[4].as_f64()?,
            z: 0.0,
        },
        row_step: Vector3 {
            x: transform[2].as_f64()?,
            y: transform[5].as_f64()?,
            z: 0.0,
        },
    })
}

fn json_u32(value: &serde_json::Value) -> Option<u32> {
    u32::try_from(value.as_u64()?).ok()
}

fn copy_verified_resource(
    source: &Path,
    target: &Path,
    expected: &GeometryResource,
    context: &mut dyn ProviderOperationContext,
) -> Result<(), ProviderContractError> {
    check_cancelled(context)?;
    if target.exists() {
        return Err(provider_message(
            "GeoTIFF export target already exists; refusing a non-atomic overwrite",
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| provider_message("GeoTIFF export target has no parent"))?;
    fs::create_dir_all(parent).map_err(provider_error)?;
    let staging = target.with_extension(format!(
        "tif.hcad-stage-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(provider_error)?
            .as_nanos()
    ));
    let mut guard = IncompleteFile::new(staging.clone());
    let mut input = BufReader::with_capacity(
        COPY_BUFFER_BYTES,
        File::open(source).map_err(provider_error)?,
    );
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(provider_error)?;
    let mut output = BufWriter::with_capacity(COPY_BUFFER_BYTES, output);
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
        context.report_progress(ProviderProgress {
            phase: "write".to_owned(),
            completed: copied,
            total: expected.byte_length,
            message: "GeoTIFF wird hashverifiziert exportiert".to_owned(),
        });
    }
    output.flush().map_err(provider_error)?;
    output.get_ref().sync_all().map_err(provider_error)?;
    let hash = hex::encode(hasher.finalize());
    if expected.byte_length != Some(copied) || expected.object_hash.as_str() != hash {
        return Err(provider_message(
            "GeoTIFF resource hash or byte length differs from the canonical descriptor",
        ));
    }
    fs::rename(&staging, target).map_err(provider_error)?;
    guard.complete = true;
    Ok(())
}

fn verify_file(
    path: &Path,
    expected_hash: &str,
    expected_length: u64,
) -> Result<(), ProviderContractError> {
    let mut reader =
        BufReader::with_capacity(COPY_BUFFER_BYTES, File::open(path).map_err(provider_error)?);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut length = 0_u64;
    loop {
        let count = reader.read(&mut buffer).map_err(provider_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        length += count as u64;
    }
    if length != expected_length || hex::encode(hasher.finalize()) != expected_hash {
        return Err(provider_message(
            "existing GeoTIFF resource failed immutable hash verification",
        ));
    }
    Ok(())
}

fn reject_unaccepted_losses(
    required: &[String],
    accepted: &BTreeSet<String>,
) -> Result<(), ProviderContractError> {
    if let Some(loss) = required.iter().find(|loss| !accepted.contains(*loss)) {
        return Err(provider_message(&format!(
            "unaccepted GeoTIFF semantic loss: {loss}"
        )));
    }
    Ok(())
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

fn map_open_error(error: geotiff_reader::Error) -> ProviderContractError {
    match error {
        geotiff_reader::Error::NotGeoTiff | geotiff_reader::Error::NoGeoTransform => {
            provider_message(UNSUPPORTED_MISSING_TRANSFORM)
        }
        geotiff_reader::Error::InvalidGeoKeyDirectory
        | geotiff_reader::Error::UnsupportedModelType(_)
        | geotiff_reader::Error::UnknownEpsg(_) => provider_message(UNSUPPORTED_MISSING_CRS),
        other => provider_error(other),
    }
}

fn provider_message(message: &str) -> ProviderContractError {
    ProviderContractError::Provider(message.to_owned())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geotiff_preparation::{F64_TILE_BYTES, HEIGHT_MEDIA_TYPE, HIERARCHY_MEDIA_TYPE};
    use geotiff_writer::{CogBuilder, Compression, GeoTiffBuilder, Resampling};
    use himmelcad_render::{DatasetId, HierarchySource, PreparedHierarchySource, TileId};
    use ndarray::{Array2, Array3};

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

    fn temp_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "himmelcad-geotiff-test-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn write_dem(path: &Path) {
        let values = Array2::from_shape_vec(
            (3, 4),
            vec![
                100.0_f32, 101.0, -9999.0, 103.0, 110.0, 111.0, 112.0, 113.0, 120.0, 121.0, 122.0,
                123.0,
            ],
        )
        .expect("DEM shape");
        GeoTiffBuilder::new(4, 3)
            .projected_epsg(25832)
            .origin(500_000.0, 5_400_000.0)
            .pixel_scale(0.25, 0.5)
            .nodata("-9999")
            .compression(Compression::Deflate)
            .write_2d(path, values.view())
            .expect("write DEM");
    }

    fn write_rgb_cog(path: &Path) {
        let mut values = Array3::<u8>::zeros((32, 32, 3));
        for row in 0..32 {
            for column in 0..32 {
                values[[row, column, 0]] = row as u8;
                values[[row, column, 1]] = column as u8;
                values[[row, column, 2]] = 127;
            }
        }
        CogBuilder::new(
            GeoTiffBuilder::new(32, 32)
                .bands(3)
                .projected_epsg(25832)
                .origin(400_000.0, 5_300_000.0)
                .pixel_scale(0.1, 0.1)
                .tile_size(16, 16)
                .compression(Compression::Deflate),
        )
        .overview_levels(vec![2])
        .resampling(Resampling::NearestNeighbor)
        .write_3d(path, values.view())
        .expect("write RGB COG");
    }

    fn import_options(interpretation: &str) -> serde_json::Value {
        serde_json::json!({ "interpretation": interpretation })
    }

    #[test]
    fn probe_is_bounded_and_recognizes_classic_and_big_tiff_headers() {
        let provider = GeoTiffCanonicalProvider::default();
        let classic = provider
            .probe(ImportProbeRequest {
                path: Path::new("ortho.bin"),
                prefix: b"II\x2a\x00trailing bytes are irrelevant",
                media_type: None,
            })
            .expect("probe")
            .expect("classic TIFF");
        assert_eq!(classic.confidence, 72);
        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("surface.tif"),
                prefix: b"MM\x00\x2b\x00\x08\x00\x00",
                media_type: None,
            })
            .expect("probe")
            .is_some());
        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("fake.tif"),
                prefix: b"not a tiff",
                media_type: Some(TIFF_MEDIA_TYPE),
            })
            .expect("probe")
            .is_none());
    }

    #[test]
    fn dem_import_preserves_f64_source_mapping_nodata_and_file_backing() {
        let root = temp_root("dem");
        let source = root.join("source.tif");
        let resources = root.join("resources");
        write_dem(&source);
        let provider = GeoTiffCanonicalProvider::new(resources.clone());
        let mut context = TestContext::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GEOTIFF_FORMAT_ID,
                    options: &import_options("elevationSurface"),
                },
                &mut context,
            )
            .expect("import DEM");
        package.validate().expect("valid package");
        let GeometryObject::ElevationSurface { surface } = &package.admissions[0].resolved_geometry
        else {
            panic!("expected elevation surface");
        };
        let ElevationSurfaceGeometry::Grid {
            mapping, raster, ..
        } = surface.as_ref()
        else {
            panic!("expected grid");
        };
        assert_eq!(mapping.origin.x, 500_000.125);
        assert_eq!(mapping.origin.y, 5_399_999.75);
        assert_eq!(mapping.column_step.x, 0.25);
        assert_eq!(mapping.row_step.y, -0.5);
        assert_eq!(package.admissions[0].entity.placement, None);
        let artifact = &package.resource_sets[0].resources[0];
        assert_eq!(&artifact.resource, raster);
        assert_eq!(
            fs::read(resources.join(&artifact.relative_path)).expect("staged"),
            fs::read(&source).expect("source")
        );
        assert_eq!(package.datasets.len(), 1);
        let dataset = &package.datasets[0];
        assert_eq!(dataset.format_id, GEOTIFF_FORMAT_ID);
        assert_eq!(&dataset.root_metadata, raster);
        assert_eq!(dataset.artifacts.len(), 4);
        let manifest = dataset
            .artifacts
            .iter()
            .find(|artifact| artifact.resource.media_type == HIERARCHY_MEDIA_TYPE)
            .expect("viewer manifest");
        let manifest_bytes =
            fs::read(resources.join(&manifest.relative_path)).expect("viewer manifest bytes");
        assert_eq!(
            manifest.resource.object_hash,
            ObjectHash::of_bytes(&manifest_bytes)
        );
        let mut hierarchy = PreparedHierarchySource::from_json(
            DatasetId(dataset.dataset_id.clone()),
            "hcad://fixture/viewer/manifest.json",
            &manifest_bytes,
        )
        .expect("render-core hierarchy");
        let tile = hierarchy
            .tile(&TileId("L00/0/0".to_owned()))
            .expect("tile query")
            .expect("root tile");
        assert_eq!(tile.contents.len(), 1);
        let decoder = tile.contents[0]
            .decoder_parameters
            .as_ref()
            .expect("raster decoder contract");
        assert_eq!(
            decoder["mapping"]["origin"],
            serde_json::json!([500_000.125, 5_399_999.75])
        );
        assert_eq!(decoder["elevationEncoding"]["kind"], "float64LittleEndian");
        let height = dataset
            .artifacts
            .iter()
            .find(|artifact| artifact.resource.media_type == HEIGHT_MEDIA_TYPE)
            .expect("prepared height tile");
        assert_eq!(height.resource.byte_length, Some(F64_TILE_BYTES));
        let height_bytes =
            fs::read(resources.join(&height.relative_path)).expect("height tile bytes");
        let heights = height_bytes
            .chunks_exact(8)
            .take(4)
            .map(|sample| f64::from_le_bytes(sample.try_into().expect("sample")))
            .collect::<Vec<_>>();
        assert_eq!(heights[0], 100.0);
        assert_eq!(heights[1], 101.0);
        assert!(heights[2].is_nan());
        assert_eq!(heights[3], 103.0);
        let attributes = package
            .objects
            .iter()
            .find(|object| object.object_hash == package.admissions[0].entity.attributes_ref)
            .expect("attributes");
        assert_eq!(
            attributes.value["hcad.geotiff-import@1"]["source"]["noData"],
            "-9999"
        );
        assert_eq!(
            attributes.value["hcad.geotiff-import@1"]["source"]["sourceCrsEqualsDisplayCrs"],
            true
        );
        assert!(context
            .progress
            .iter()
            .any(|progress| progress.phase == "stage"));

        let repeated = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GEOTIFF_FORMAT_ID,
                    options: &import_options("elevationSurface"),
                },
                &mut TestContext::default(),
            )
            .expect("repeat deterministic DEM import");
        assert_eq!(repeated.datasets, package.datasets);
        let staging = resources.join("geotiff/.prepared-staging");
        assert_eq!(
            fs::read_dir(staging)
                .expect("prepared staging directory")
                .count(),
            0
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cog_import_stays_one_range_readable_tiled_resource_and_roundtrips_exactly() {
        let root = temp_root("cog-roundtrip");
        let source = root.join("source-cog.tif");
        let resources = root.join("resources");
        let target = root.join("exported-cog.tif");
        write_rgb_cog(&source);
        let provider = GeoTiffCanonicalProvider::new(resources);
        let mut context = TestContext::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GEOTIFF_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut context,
            )
            .expect("import COG");
        assert_eq!(package.resource_sets.len(), 1);
        assert_eq!(package.resource_sets[0].resources.len(), 1);
        let attributes = package
            .objects
            .iter()
            .find(|object| object.object_hash == package.admissions[0].entity.attributes_ref)
            .expect("attributes");
        assert_eq!(
            attributes.value["hcad.geotiff-import@1"]["source"]["storage"]["kind"],
            "tiled"
        );
        assert_eq!(
            attributes.value["hcad.geotiff-import@1"]["source"]["storage"]["rangeReadable"],
            true
        );
        assert_eq!(
            attributes.value["hcad.geotiff-import@1"]["source"]["overviewCount"],
            1
        );
        let request = CanonicalExportRequest {
            target: &target,
            format_id: GEOTIFF_FORMAT_ID,
            package: &package,
            options: &serde_json::json!({}),
        };
        let plan = provider
            .plan_export(CanonicalExportRequest { ..request })
            .expect("plan");
        assert!(plan.semantic_losses.is_empty());
        provider
            .export(request, &plan, &mut context)
            .expect("export");
        assert_eq!(
            fs::read(&source).expect("source"),
            fs::read(&target).expect("target")
        );
        let reopened = GeoTiffFile::open(&target).expect("reopen export");
        assert_eq!(reopened.overview_count(), 1);
        assert_eq!(
            (reopened.width(), reopened.height(), reopened.band_count()),
            (32, 32, 3)
        );

        let mut moved = package.clone();
        moved.admissions[0].entity.placement = Some(himmelcad_core::entity_model::Transform3d([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 10.0, 0.0, 0.0, 1.0,
        ]));
        moved.admissions[0].entity.version_hash =
            canonical_entity_version_hash(&moved.admissions[0].entity).expect("moved hash");
        let moved_target = root.join("moved.tif");
        let moved_plan = provider
            .plan_export(CanonicalExportRequest {
                target: &moved_target,
                format_id: GEOTIFF_FORMAT_ID,
                package: &moved,
                options: &serde_json::json!({}),
            })
            .expect("moved plan");
        assert_eq!(
            moved_plan.semantic_losses,
            vec![LOSS_EXPORT_NOT_PASSTHROUGH]
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cancellation_and_tampered_resource_fail_closed_without_output() {
        let root = temp_root("fail-closed");
        let source = root.join("source.tif");
        let resources = root.join("resources");
        let target = root.join("target.tif");
        write_dem(&source);
        let provider = GeoTiffCanonicalProvider::new(resources.clone());
        let mut cancelled = TestContext {
            cancelled: true,
            ..TestContext::default()
        };
        let error = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GEOTIFF_FORMAT_ID,
                    options: &import_options("elevationSurface"),
                },
                &mut cancelled,
            )
            .expect_err("cancelled");
        assert_eq!(error, ProviderContractError::Cancelled);

        let mut context = TestContext::default();
        let package = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GEOTIFF_FORMAT_ID,
                    options: &import_options("elevationSurface"),
                },
                &mut context,
            )
            .expect("import");
        let artifact = &package.resource_sets[0].resources[0];
        fs::write(resources.join(&artifact.relative_path), b"tampered").expect("tamper");
        let request = CanonicalExportRequest {
            target: &target,
            format_id: GEOTIFF_FORMAT_ID,
            package: &package,
            options: &serde_json::json!({}),
        };
        let plan = provider
            .plan_export(CanonicalExportRequest { ..request })
            .expect("plan");
        let error = provider
            .export(request, &plan, &mut context)
            .expect_err("tamper rejected");
        assert!(error.to_string().contains("hash or byte length"));
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn missing_georeferencing_is_rejected_with_a_stable_unsupported_code() {
        let root = temp_root("missing-georeferencing");
        let source = root.join("plain.tif");
        let values = Array2::<u8>::zeros((2, 2));
        GeoTiffBuilder::new(2, 2)
            .write_2d(&source, values.view())
            .expect("plain TIFF");
        let provider = GeoTiffCanonicalProvider::new(root.join("resources"));
        let error = provider
            .import(
                CanonicalImportRequest {
                    source: &source,
                    format_id: GEOTIFF_FORMAT_ID,
                    options: &serde_json::json!({}),
                },
                &mut TestContext::default(),
            )
            .expect_err("missing georeferencing");
        assert!(
            error.to_string().contains(UNSUPPORTED_MISSING_TRANSFORM),
            "unexpected error: {error}"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
