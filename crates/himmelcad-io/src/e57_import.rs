//! Bounded E57 import through the canonical point-cloud preparation path.
//!
//! E57 scan poses are applied while coordinates are still `f64`. The merged
//! stream is written to an unpublished LAZ staging file and then passed to the
//! same Potree 2 preparation path as native LAS/LAZ imports. Neither pass keeps
//! point records in memory.
//!
//! Embedded E57 image blobs are preserved as immutable resources. Projectable
//! images become canonical raster or panorama entities with exact source pose,
//! intrinsics and scan GUID association. Visual references remain explicitly
//! unprojectable; no depth image is invented from the station point cloud.
//! Scan GUIDs, names and exact poses remain in canonical attributes, while the
//! runtime point stream is merged. LAZ cannot retain E57 per-point validity,
//! row/column indices or arbitrary extension records through Potree: absent RGB
//! becomes black and absent intensity becomes zero, so per-point missingness is
//! not distinguishable after conversion. Declared scan-level availability and
//! the chosen intermediate coordinate quantization remain in provenance.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use e57::{
    Blob, CartesianCoordinate, E57Reader, Image, ImageBlob, ImageFormat, PointCloud, Projection,
    Transform,
};
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    built_in_type, CameraModel, CanonicalEntity, EntityTypeId, GeometryObject, GeometryResource,
    PanoramaGeometry, RasterImageGeometry, RasterMapping, Representation, RepresentationAuthority,
    RepresentationRole, Transform3d,
};
use himmelcad_core::entity_validation::{
    canonical_entity_version_hash, geometry_object_content_hash, validate_resolved_representation,
};
use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
use himmelcad_core::hash::ObjectHash;
use las::{Builder, Color, Point, Transform as LasTransform, Vector, Writer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::canonical_provider::{
    CanonicalImportPackage, CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject,
    CanonicalResourceSet, FormatCapability, FormatProviderDescriptor, ImportProbe,
    ImportProbeRequest, PreparedResourceArtifact, ProviderContractError, ProviderOperationContext,
    ProviderOptionContract, ProviderProgress, StagedArtifactRoots, CANONICAL_IO_SCHEMA_VERSION,
};
use crate::las_import::{import_las_file_with_progress_and_cancel, ConverterProgress};
use crate::ImportError;

const E57_FORMAT_ID: &str = "e57@1.0";
const E57_PROVIDER_ID: &str = "hcad.io.e57-potree@1";
const DEFAULT_RESOLUTION_METERS: f64 = 0.000_001;
const CANCEL_INTERVAL: u64 = 8_192;
const PROGRESS_INTERVAL: u64 = 65_536;
const MAX_COORDINATE_METADATA_BYTES: usize = 1024 * 1024;
const MAX_EMBEDDED_IMAGES: usize = 100_000;
const MAX_EMBEDDED_IMAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const IMAGE_PROGRESS_INTERVAL_BYTES: u64 = 4 * 1024 * 1024;

/// Source visual reference has no projectable camera model by definition.
pub const E57_LOSS_VISUAL_REFERENCE_UNPROJECTABLE: &str =
    "hcad.e57.visual-reference-unprojectable@1";
/// Spherical projection omitted one or both required angular pixel sizes.
pub const E57_LOSS_SPHERICAL_INTRINSICS_MISSING: &str = "hcad.e57.spherical-intrinsics-missing@1";
/// Image names an associated scan GUID that is absent from the source scan inventory.
pub const E57_LOSS_ASSOCIATED_SCAN_MISSING: &str = "hcad.e57.associated-scan-missing@1";
/// Exact source scan is only a member of the merged point-cloud entity.
pub const E57_LOSS_SCAN_MEMBER_NOT_ENTITY_ADDRESSABLE: &str =
    "hcad.e57.scan-member-not-entity-addressable@1";

/// Production E57 adapter for the provider-neutral canonical registry.
pub struct E57CanonicalProvider {
    cache_dir: PathBuf,
    descriptor: FormatProviderDescriptor,
}

impl E57CanonicalProvider {
    /// Creates an E57 provider whose immutable prepared datasets live below `cache_dir`.
    #[must_use]
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: E57_PROVIDER_ID.to_owned(),
                provider_version: env!("CARGO_PKG_VERSION").to_owned(),
                display_name: "ASTM E57 to Potree 2".to_owned(),
                format_ids: vec![E57_FORMAT_ID.to_owned()],
                extensions: vec!["e57".to_owned()],
                media_types: vec!["model/e57".to_owned()],
                capabilities: vec![FormatCapability::Import],
                import_options: Some(ProviderOptionContract::object(
                    serde_json::json!({
                        "coordinateResolutionMeters": {"type": "number", "exclusiveMinimum": 0.0}
                    }),
                    serde_json::json!({
                        "coordinateResolutionMeters": DEFAULT_RESOLUTION_METERS
                    }),
                )),
                export_options: None,
            },
        }
    }
}

impl CanonicalImportProvider for E57CanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let extension_matches = request
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("e57"));
        let magic_matches = request.prefix.starts_with(b"ASTM-E57");
        if !magic_matches && !extension_matches {
            return Ok(None);
        }
        Ok(Some(ImportProbe {
            format_id: E57_FORMAT_ID.to_owned(),
            confidence: if magic_matches { 100 } else { 55 },
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != E57_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: E57ImportOptions = serde_json::from_value(request.options.clone())
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        options.validate()?;

        let staging = StagingDirectory::create(&self.cache_dir, request.source)?;
        let laz_path = staging.path.join("merged-source.laz");
        let context = Mutex::new(context);
        let transcode = transcode_e57_to_laz(
            request.source,
            &laz_path,
            options.coordinate_resolution_meters,
            |update| {
                context
                    .lock()
                    .expect("provider context lock poisoned")
                    .report_progress(ProviderProgress {
                        phase: update.phase,
                        completed: update.completed,
                        total: update.total,
                        message: update.message,
                    });
            },
            || {
                context
                    .lock()
                    .expect("provider context lock poisoned")
                    .is_cancelled()
            },
        )
        .map_err(provider_error)?;

        let summary = import_las_file_with_progress_and_cancel(
            &laz_path,
            &self.cache_dir,
            |update| report_potree_progress(&context, update),
            || {
                context
                    .lock()
                    .expect("provider context lock poisoned")
                    .is_cancelled()
            },
        )
        .map_err(|error| match error {
            ImportError::Cancelled => ProviderContractError::Cancelled,
            other => ProviderContractError::Provider(other.to_string()),
        })?;
        let package = summary
            .canonical_import_package()
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
        let package = canonicalize_e57_package(package, request.source, &transcode)?;
        let context = context.into_inner().map_err(|_| {
            ProviderContractError::Provider("provider context lock poisoned".to_owned())
        })?;
        attach_e57_images(
            package,
            request.source,
            &self.cache_dir,
            &transcode,
            context,
        )
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
                        self.cache_dir.join(&dataset.dataset_id),
                    )
                })
                .collect(),
            resource_set_roots: package
                .resource_sets
                .iter()
                .map(|set| (set.resource_set_id.clone(), self.cache_dir.clone()))
                .collect(),
        })
    }
}

fn report_potree_progress(
    context: &Mutex<&mut dyn ProviderOperationContext>,
    update: ConverterProgress,
) {
    let completed = update.fraction.map_or(0, progress_units);
    context
        .lock()
        .expect("provider context lock poisoned")
        .report_progress(ProviderProgress {
            phase: "e57-prepare-potree".to_owned(),
            completed,
            total: Some(10_000),
            message: update.message,
        });
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn progress_units(fraction: f32) -> u64 {
    (fraction.clamp(0.0, 1.0) * 10_000.0).round() as u64
}

/// One phase update from the bounded E57-to-LAZ transcode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct E57TranscodeProgress {
    /// Stable phase name.
    pub phase: String,
    /// Processed source records in this phase.
    pub completed: u64,
    /// Known source-record total.
    pub total: Option<u64>,
    /// Short status text.
    pub message: String,
}

/// Exact E57 scan pose copied into canonical import provenance.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E57ScanPose {
    /// Unit quaternion in E57 `(w, x, y, z)` order.
    pub rotation_wxyz: [f64; 4],
    /// Translation in source coordinate units (E57 specifies metres).
    pub translation: [f64; 3],
}

/// Per-scan metadata retained after merging scan streams.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E57ScanMetadata {
    /// Source scan GUID if present.
    pub guid: Option<String>,
    /// Source scan name if present.
    pub name: Option<String>,
    /// Number of E57 records before validity filtering.
    pub source_record_count: u64,
    /// Number of emitted finite position records.
    pub emitted_point_count: u64,
    /// Whether the scan declares RGB attributes.
    pub has_color: bool,
    /// Whether the scan declares intensity.
    pub has_intensity: bool,
    /// Pose applied before LAZ quantization.
    pub pose: E57ScanPose,
}

/// File-level E57 metadata retained as canonical import provenance.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E57SourceMetadata {
    /// Root E57 GUID.
    pub guid: String,
    /// Optional source CRS/WKT text; no implicit reprojection is performed.
    pub coordinate_metadata: Option<String>,
    /// Number of embedded E57 image records discovered by the provider.
    pub embedded_image_count: u64,
    /// Total E57 point records across scans.
    pub source_record_count: u64,
    /// Total valid finite points written to the intermediate LAZ stream.
    pub emitted_point_count: u64,
    /// Ordered source scan inventory.
    pub scans: Vec<E57ScanMetadata>,
}

/// Summary of the bounded temporary LAZ transcode.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E57TranscodeSummary {
    /// Source metadata and exact poses.
    pub source: E57SourceMetadata,
    /// World-space bounds after applying every scan pose.
    pub bounds_min: [f64; 3],
    /// World-space bounds after applying every scan pose.
    pub bounds_max: [f64; 3],
    /// Per-axis LAZ quantization scale in metres.
    pub coordinate_scale: [f64; 3],
    /// Per-axis LAZ offset in source coordinates.
    pub coordinate_offset: [f64; 3],
    /// Whether at least one source scan has RGB.
    pub has_color: bool,
    /// Whether at least one source scan has intensity.
    pub has_intensity: bool,
}

/// E57 decode, validation, cancellation, or temporary-output failure.
#[derive(Debug, Error)]
pub enum E57ImportError {
    /// Filesystem failure.
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    /// Invalid or unsupported E57 data.
    #[error("E57: {0}")]
    E57(#[from] e57::Error),
    /// Intermediate LAS/LAZ encoding failure.
    #[error("LAZ staging: {0}")]
    Las(#[from] las::Error),
    /// Source metadata or point values violate the import contract.
    #[error("invalid E57 source: {0}")]
    InvalidSource(String),
    /// Cooperative cancellation was observed.
    #[error("E57 import was cancelled")]
    Cancelled,
}

/// Streams an E57 file into a temporary LAZ without retaining point arrays.
///
/// The first pass determines exact transformed bounds so that the LAS integer
/// transform cannot overflow. The second pass applies every E57 scan pose and
/// writes points. A failed or cancelled output is removed.
pub fn transcode_e57_to_laz<F, C>(
    source: &Path,
    destination: &Path,
    minimum_resolution_meters: f64,
    mut progress: F,
    is_cancelled: C,
) -> Result<E57TranscodeSummary, E57ImportError>
where
    F: FnMut(E57TranscodeProgress),
    C: Fn() -> bool,
{
    if !minimum_resolution_meters.is_finite() || minimum_resolution_meters <= 0.0 {
        return Err(E57ImportError::InvalidSource(
            "coordinateResolutionMeters must be finite and greater than zero".to_owned(),
        ));
    }
    check_cancelled(&is_cancelled)?;
    if destination.exists() {
        return Err(E57ImportError::InvalidSource(format!(
            "staging destination already exists: {}",
            destination.display()
        )));
    }
    let identity = SourceIdentity::read(source)?;
    let inspection = inspect_source(source, &mut progress, &is_cancelled)?;
    identity.verify(source)?;

    let transforms = las_transforms(
        inspection.bounds_min,
        inspection.bounds_max,
        minimum_resolution_meters,
    );
    let mut output = IncompleteOutput::new(destination);
    write_laz(
        source,
        destination,
        &inspection,
        transforms,
        &mut progress,
        &is_cancelled,
    )?;
    identity.verify(source)?;
    output.complete = true;

    Ok(E57TranscodeSummary {
        source: inspection.metadata,
        bounds_min: inspection.bounds_min,
        bounds_max: inspection.bounds_max,
        coordinate_scale: [transforms.x.scale, transforms.y.scale, transforms.z.scale],
        coordinate_offset: [
            transforms.x.offset,
            transforms.y.offset,
            transforms.z.offset,
        ],
        has_color: inspection.has_color,
        has_intensity: inspection.has_intensity,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct E57ImportOptions {
    #[serde(default = "default_coordinate_resolution")]
    coordinate_resolution_meters: f64,
}

impl Default for E57ImportOptions {
    fn default() -> Self {
        Self {
            coordinate_resolution_meters: default_coordinate_resolution(),
        }
    }
}

impl E57ImportOptions {
    fn validate(&self) -> Result<(), ProviderContractError> {
        if self.coordinate_resolution_meters.is_finite() && self.coordinate_resolution_meters > 0.0
        {
            Ok(())
        } else {
            Err(ProviderContractError::Provider(
                "coordinateResolutionMeters must be finite and greater than zero".to_owned(),
            ))
        }
    }
}

fn default_coordinate_resolution() -> f64 {
    DEFAULT_RESOLUTION_METERS
}

struct Inspection {
    metadata: E57SourceMetadata,
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    has_color: bool,
    has_intensity: bool,
}

fn inspect_source<F, C>(
    source: &Path,
    progress: &mut F,
    is_cancelled: &C,
) -> Result<Inspection, E57ImportError>
where
    F: FnMut(E57TranscodeProgress),
    C: Fn() -> bool,
{
    let mut reader = E57Reader::from_file(source)?;
    let pointclouds = reader.pointclouds();
    let total = checked_source_records(&pointclouds)?;
    let coordinate_metadata = reader.coordinate_metadata().map(str::to_owned);
    if coordinate_metadata
        .as_ref()
        .is_some_and(|value| value.len() > MAX_COORDINATE_METADATA_BYTES)
    {
        return Err(E57ImportError::InvalidSource(format!(
            "coordinate metadata exceeds {MAX_COORDINATE_METADATA_BYTES} bytes"
        )));
    }
    let mut bounds = BoundsAccumulator::default();
    let mut completed = 0_u64;
    let mut scans = Vec::with_capacity(pointclouds.len());
    let has_color = pointclouds.iter().any(PointCloud::has_color);
    let has_intensity = pointclouds.iter().any(PointCloud::has_intensity);
    progress(E57TranscodeProgress {
        phase: "e57-scan-bounds".to_owned(),
        completed: 0,
        total: Some(total),
        message: "reading transformed E57 bounds".to_owned(),
    });

    for pointcloud in &pointclouds {
        let mut emitted = 0_u64;
        let mut points = configured_reader(&mut reader, pointcloud)?;
        for result in &mut points {
            let point = result?;
            completed = completed.saturating_add(1);
            if let Some(position) = point_position(&point)? {
                bounds.observe(position);
                emitted = emitted.saturating_add(1);
            }
            if completed.is_multiple_of(CANCEL_INTERVAL) {
                check_cancelled(is_cancelled)?;
            }
            if completed.is_multiple_of(PROGRESS_INTERVAL) {
                progress(E57TranscodeProgress {
                    phase: "e57-scan-bounds".to_owned(),
                    completed,
                    total: Some(total),
                    message: "reading transformed E57 bounds".to_owned(),
                });
            }
        }
        scans.push(scan_metadata(pointcloud, emitted));
    }
    check_cancelled(is_cancelled)?;
    let (bounds_min, bounds_max) = bounds.finish()?;
    let emitted_point_count = scans
        .iter()
        .try_fold(0_u64, |sum, scan| sum.checked_add(scan.emitted_point_count))
        .ok_or_else(|| E57ImportError::InvalidSource("valid point count overflow".to_owned()))?;
    progress(E57TranscodeProgress {
        phase: "e57-scan-bounds".to_owned(),
        completed: total,
        total: Some(total),
        message: "transformed E57 bounds ready".to_owned(),
    });
    Ok(Inspection {
        metadata: E57SourceMetadata {
            guid: reader.guid().to_owned(),
            coordinate_metadata,
            embedded_image_count: u64::try_from(reader.images().len()).map_err(|_| {
                E57ImportError::InvalidSource("embedded image count overflow".to_owned())
            })?,
            source_record_count: total,
            emitted_point_count,
            scans,
        },
        bounds_min,
        bounds_max,
        has_color,
        has_intensity,
    })
}

fn write_laz<F, C>(
    source: &Path,
    destination: &Path,
    inspection: &Inspection,
    transforms: Vector<LasTransform>,
    progress: &mut F,
    is_cancelled: &C,
) -> Result<(), E57ImportError>
where
    F: FnMut(E57TranscodeProgress),
    C: Fn() -> bool,
{
    check_cancelled(is_cancelled)?;
    let mut reader = E57Reader::from_file(source)?;
    let pointclouds = reader.pointclouds();
    let mut builder = Builder::from((1, 4));
    builder.generating_software.clear();
    builder
        .generating_software
        .push_str("HimmelCAD E57 canonical importer");
    builder.system_identifier.clear();
    builder.system_identifier.push_str("E57 posed point stream");
    builder.point_format = las::point::Format::new(if inspection.has_color { 2 } else { 0 })?;
    builder.transforms = transforms;
    let header = builder.into_header()?;
    let mut writer = Writer::from_path(destination, header)?;
    let total = inspection.metadata.source_record_count;
    let mut completed = 0_u64;
    let mut emitted = 0_u64;
    progress(E57TranscodeProgress {
        phase: "e57-write-laz".to_owned(),
        completed: 0,
        total: Some(total),
        message: "writing posed E57 points to bounded LAZ staging".to_owned(),
    });
    for (scan_index, pointcloud) in pointclouds.iter().enumerate() {
        let point_source_id = u16::try_from(scan_index.saturating_add(1)).unwrap_or(u16::MAX);
        let mut points = configured_reader(&mut reader, pointcloud)?;
        for result in &mut points {
            let source_point = result?;
            completed = completed.saturating_add(1);
            if let Some([x, y, z]) = point_position(&source_point)? {
                let mut point = Point {
                    x,
                    y,
                    z,
                    point_source_id,
                    intensity: normalized_u16(source_point.intensity, "intensity")?.unwrap_or(0),
                    ..Point::default()
                };
                if inspection.has_color {
                    point.color = Some(match source_point.color {
                        Some(color) => Color::new(
                            normalized_u16(Some(color.red), "red")?.unwrap_or(0),
                            normalized_u16(Some(color.green), "green")?.unwrap_or(0),
                            normalized_u16(Some(color.blue), "blue")?.unwrap_or(0),
                        ),
                        None => Color::new(0, 0, 0),
                    });
                }
                writer.write_point(point)?;
                emitted = emitted.saturating_add(1);
            }
            if completed.is_multiple_of(CANCEL_INTERVAL) {
                check_cancelled(is_cancelled)?;
            }
            if completed.is_multiple_of(PROGRESS_INTERVAL) {
                progress(E57TranscodeProgress {
                    phase: "e57-write-laz".to_owned(),
                    completed,
                    total: Some(total),
                    message: "writing posed E57 points to bounded LAZ staging".to_owned(),
                });
            }
        }
    }
    check_cancelled(is_cancelled)?;
    if emitted != inspection.metadata.emitted_point_count {
        return Err(E57ImportError::InvalidSource(
            "E57 valid-point count changed between bounded passes".to_owned(),
        ));
    }
    writer.close()?;
    progress(E57TranscodeProgress {
        phase: "e57-write-laz".to_owned(),
        completed: total,
        total: Some(total),
        message: "posed E57 LAZ staging complete".to_owned(),
    });
    Ok(())
}

fn configured_reader<'a>(
    reader: &'a mut E57Reader<std::io::BufReader<std::fs::File>>,
    pointcloud: &PointCloud,
) -> Result<e57::PointCloudReaderSimple<'a, std::io::BufReader<std::fs::File>>, E57ImportError> {
    let mut points = reader.pointcloud_simple(pointcloud)?;
    points.apply_pose(true);
    points.spherical_to_cartesian(true);
    points.intensity_to_color(false);
    points.normalize_color(true);
    points.normalize_intensity(true);
    Ok(points)
}

fn checked_source_records(pointclouds: &[PointCloud]) -> Result<u64, E57ImportError> {
    pointclouds.iter().try_fold(0_u64, |sum, scan| {
        sum.checked_add(scan.records)
            .ok_or_else(|| E57ImportError::InvalidSource("source record count overflow".to_owned()))
    })
}

fn point_position(point: &e57::Point) -> Result<Option<[f64; 3]>, E57ImportError> {
    match point.cartesian {
        CartesianCoordinate::Valid { x, y, z } => {
            if [x, y, z].iter().all(|value| value.is_finite()) {
                Ok(Some([x, y, z]))
            } else {
                Err(E57ImportError::InvalidSource(
                    "valid Cartesian point contains a non-finite coordinate".to_owned(),
                ))
            }
        }
        CartesianCoordinate::Direction { .. } | CartesianCoordinate::Invalid => Ok(None),
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn normalized_u16(value: Option<f32>, name: &str) -> Result<Option<u16>, E57ImportError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !value.is_finite() {
        return Err(E57ImportError::InvalidSource(format!(
            "valid {name} value is not finite"
        )));
    }
    let scaled = (value.clamp(0.0, 1.0) * f32::from(u16::MAX)).round();
    Ok(Some(scaled as u16))
}

fn scan_metadata(pointcloud: &PointCloud, emitted_point_count: u64) -> E57ScanMetadata {
    let transform = pointcloud.transform.clone().unwrap_or_default();
    E57ScanMetadata {
        guid: pointcloud.guid.clone(),
        name: pointcloud.name.clone(),
        source_record_count: pointcloud.records,
        emitted_point_count,
        has_color: pointcloud.has_color(),
        has_intensity: pointcloud.has_intensity(),
        pose: pose(&transform),
    }
}

fn pose(transform: &Transform) -> E57ScanPose {
    E57ScanPose {
        rotation_wxyz: [
            transform.rotation.w,
            transform.rotation.x,
            transform.rotation.y,
            transform.rotation.z,
        ],
        translation: [
            transform.translation.x,
            transform.translation.y,
            transform.translation.z,
        ],
    }
}

fn las_transforms(min: [f64; 3], max: [f64; 3], minimum_resolution: f64) -> Vector<LasTransform> {
    fn axis(min: f64, max: f64, minimum_resolution: f64) -> LasTransform {
        let extent = max - min;
        LasTransform {
            scale: minimum_resolution.max(extent / 4_000_000_000.0),
            offset: min + extent * 0.5,
        }
    }
    Vector {
        x: axis(min[0], max[0], minimum_resolution),
        y: axis(min[1], max[1], minimum_resolution),
        z: axis(min[2], max[2], minimum_resolution),
    }
}

#[derive(Default)]
struct BoundsAccumulator {
    min: [f64; 3],
    max: [f64; 3],
    initialized: bool,
}

impl BoundsAccumulator {
    fn observe(&mut self, point: [f64; 3]) {
        if !self.initialized {
            self.min = point;
            self.max = point;
            self.initialized = true;
            return;
        }
        for (axis, coordinate) in point.into_iter().enumerate() {
            self.min[axis] = self.min[axis].min(coordinate);
            self.max[axis] = self.max[axis].max(coordinate);
        }
    }

    fn finish(self) -> Result<([f64; 3], [f64; 3]), E57ImportError> {
        if self.initialized {
            Ok((self.min, self.max))
        } else {
            Err(E57ImportError::InvalidSource(
                "E57 contains no valid finite point positions".to_owned(),
            ))
        }
    }
}

struct IncompleteOutput<'a> {
    path: &'a Path,
    complete: bool,
}

impl<'a> IncompleteOutput<'a> {
    fn new(path: &'a Path) -> Self {
        Self {
            path,
            complete: false,
        }
    }
}

impl Drop for IncompleteOutput<'_> {
    fn drop(&mut self) {
        if !self.complete {
            let _ = std::fs::remove_file(self.path);
        }
    }
}

struct StagingDirectory {
    path: PathBuf,
}

impl StagingDirectory {
    fn create(cache_dir: &Path, source: &Path) -> Result<Self, ProviderContractError> {
        std::fs::create_dir_all(cache_dir)
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        for attempt in 0_u32..32 {
            let path = cache_dir.join(format!(".e57-import-{}", staging_nonce(source, attempt)));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(ProviderContractError::Provider(error.to_string())),
            }
        }
        Err(ProviderContractError::Provider(
            "could not allocate isolated E57 staging directory".to_owned(),
        ))
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn staging_nonce(source: &Path, attempt: u32) -> String {
    let mut digest = Sha256::new();
    digest.update(source.as_os_str().to_string_lossy().as_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(attempt.to_le_bytes());
    if let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) {
        digest.update(duration.as_secs().to_le_bytes());
        digest.update(duration.subsec_nanos().to_le_bytes());
    }
    hex::encode(digest.finalize())
}

struct SourceIdentity {
    byte_length: u64,
    modified: Option<SystemTime>,
}

impl SourceIdentity {
    fn read(path: &Path) -> Result<Self, E57ImportError> {
        let metadata = path.metadata()?;
        Ok(Self {
            byte_length: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }

    fn verify(&self, path: &Path) -> Result<(), E57ImportError> {
        let current = Self::read(path)?;
        if self.byte_length == current.byte_length && self.modified == current.modified {
            Ok(())
        } else {
            Err(E57ImportError::InvalidSource(
                "E57 source changed during import".to_owned(),
            ))
        }
    }
}

fn check_cancelled<C>(is_cancelled: &C) -> Result<(), E57ImportError>
where
    C: Fn() -> bool,
{
    if is_cancelled() {
        Err(E57ImportError::Cancelled)
    } else {
        Ok(())
    }
}

fn provider_error(error: E57ImportError) -> ProviderContractError {
    match error {
        E57ImportError::Cancelled => ProviderContractError::Cancelled,
        other => ProviderContractError::Provider(other.to_string()),
    }
}

fn canonicalize_e57_package(
    mut package: CanonicalImportPackage,
    source_path: &Path,
    summary: &E57TranscodeSummary,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    package.provider_id.clear();
    package.provider_id.push_str(E57_PROVIDER_ID);
    package.provider_version.clear();
    package.provider_version.push_str(env!("CARGO_PKG_VERSION"));
    let source_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("import.e57");
    if package.admissions.len() != 1 {
        return Err(ProviderContractError::InvalidPackage);
    }
    let admission = package
        .admissions
        .first_mut()
        .ok_or(ProviderContractError::InvalidPackage)?;
    if !matches!(
        admission.resolved_geometry,
        GeometryObject::PointCloud { .. }
    ) {
        return Err(ProviderContractError::InvalidPackage);
    }
    let old_attributes_ref = admission.entity.attributes_ref.clone();
    let attributes = package
        .objects
        .iter_mut()
        .find(|object| object.object_hash == old_attributes_ref)
        .ok_or(ProviderContractError::MissingEntityObject)?;
    let map = attributes
        .value
        .as_object_mut()
        .ok_or(ProviderContractError::InvalidObject)?;
    if let Some(point_cloud) = map
        .get_mut("hcad.point-cloud-import@1")
        .and_then(serde_json::Value::as_object_mut)
    {
        point_cloud.insert(
            "sourceName".to_owned(),
            serde_json::Value::String(source_name.to_owned()),
        );
        point_cloud.insert(
            "hasColor".to_owned(),
            serde_json::Value::Bool(summary.has_color),
        );
        point_cloud.insert(
            "hasIntensity".to_owned(),
            serde_json::Value::Bool(summary.has_intensity),
        );
    }
    map.insert(
        "hcad.e57-import@1".to_owned(),
        serde_json::to_value(summary)
            .map_err(|error| ProviderContractError::Canonical(error.to_string()))?,
    );
    let attributes_bytes = serde_json::to_vec(&attributes.value)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    attributes.object_hash = himmelcad_core::hash::ObjectHash::of_bytes(&attributes_bytes);
    admission.entity.attributes_ref = attributes.object_hash.clone();
    admission.entity.name.clear();
    admission.entity.name.push_str(source_name);
    admission.entity.version_hash = canonical_entity_version_hash(&admission.entity)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    package.validate()?;
    Ok(package)
}

#[allow(clippy::too_many_lines)]
fn attach_e57_images(
    mut package: CanonicalImportPackage,
    source_path: &Path,
    resource_root: &Path,
    summary: &E57TranscodeSummary,
    context: &mut dyn ProviderOperationContext,
) -> Result<CanonicalImportPackage, ProviderContractError> {
    let identity = SourceIdentity::read(source_path).map_err(provider_error)?;
    let mut reader = E57Reader::from_file(source_path).map_err(|error| {
        ProviderContractError::Provider(format!("E57 image inventory: {error}"))
    })?;
    let images = reader.images();
    if images.len() > MAX_EMBEDDED_IMAGES
        || u64::try_from(images.len()).ok() != Some(summary.source.embedded_image_count)
    {
        return Err(ProviderContractError::Provider(
            "E57 embedded image inventory changed or exceeds the bounded limit".to_owned(),
        ));
    }
    if images.is_empty() {
        identity.verify(source_path).map_err(provider_error)?;
        package.validate()?;
        return Ok(package);
    }

    let spherical_presence = spherical_intrinsic_presence(reader.xml(), images.len())?;
    let total_bytes = image_blob_total(&images)?;
    context.report_progress(ProviderProgress {
        phase: "e57-extract-images".to_owned(),
        completed: 0,
        total: Some(total_bytes),
        message: "extracting immutable E57 image resources".to_owned(),
    });
    let point_cloud_entity = package
        .admissions
        .iter()
        .find(|admission| {
            matches!(
                admission.resolved_geometry,
                GeometryObject::PointCloud { .. }
            )
        })
        .map(|admission| admission.entity.id.clone())
        .ok_or(ProviderContractError::InvalidPackage)?;
    let scan_guids = scan_guid_inventory(summary)?;
    let mut artifacts = BTreeMap::<String, PreparedResourceArtifact>::new();
    let mut completed = 0_u64;

    for (index, image) in images.iter().enumerate() {
        if context.is_cancelled() {
            return Err(ProviderContractError::Cancelled);
        }
        let pose = image_transform(image.transform.as_ref())?;
        let association = scan_association(
            image.pointcloud_guid.as_deref(),
            &scan_guids,
            summary.source.scans.len(),
            &point_cloud_entity,
        );
        if let Some(visual) = &image.visual_reference {
            let pixels = extract_image_blob(
                &mut reader,
                &visual.blob,
                resource_root,
                context,
                &mut completed,
                total_bytes,
            )?;
            insert_resource_artifact(&mut artifacts, pixels.clone())?;
            let parameters = intern_object(
                &mut package.objects,
                "application/vnd.himmelcad.camera-model+json",
                serde_json::json!({
                    "schemaVersion": 1,
                    "sourceFormat": E57_FORMAT_ID,
                    "projection": "visualReference",
                    "projectable": false,
                    "reason": "E57 visual reference representations carry no camera model"
                }),
            )?;
            let model = CameraModel::Extension {
                model_id: "hcad.camera.e57-visual-reference@1".to_owned(),
                parameters,
            };
            add_image_admission(
                &mut package,
                image,
                index,
                "visualReference",
                visual.properties.width,
                visual.properties.height,
                &pixels.resource,
                model.clone(),
                pose,
                false,
                &association,
                &[E57_LOSS_VISUAL_REFERENCE_UNPROJECTABLE],
            )?;
            if let Some(mask) = &visual.mask {
                add_mask_admission(
                    &mut package,
                    &mut reader,
                    resource_root,
                    context,
                    &mut completed,
                    total_bytes,
                    &mut artifacts,
                    image,
                    index,
                    "visualReferenceMask",
                    visual.properties.width,
                    visual.properties.height,
                    mask,
                    model,
                    pose,
                    &association,
                )?;
            }
        }
        if let Some(projection) = &image.projection {
            attach_projected_image(
                &mut package,
                &mut reader,
                resource_root,
                context,
                &mut completed,
                total_bytes,
                &mut artifacts,
                image,
                index,
                projection,
                spherical_presence[index],
                pose,
                &association,
            )?;
        }
    }
    identity.verify(source_path).map_err(provider_error)?;
    context.report_progress(ProviderProgress {
        phase: "e57-extract-images".to_owned(),
        completed: total_bytes,
        total: Some(total_bytes),
        message: "embedded E57 image resources ready".to_owned(),
    });
    if !artifacts.is_empty() {
        let mut digest = Sha256::new();
        digest.update(summary.source.guid.as_bytes());
        for hash in artifacts.keys() {
            digest.update(hash.as_bytes());
        }
        package.resource_sets.push(CanonicalResourceSet {
            resource_set_id: format!("e57-images-{}", hex::encode(digest.finalize())),
            resources: artifacts.into_values().collect(),
        });
    }
    package.validate()?;
    Ok(package)
}

#[derive(Clone, Copy, Default)]
struct SphericalIntrinsicPresence {
    pixel_width: bool,
    pixel_height: bool,
}

fn spherical_intrinsic_presence(
    xml: &str,
    image_count: usize,
) -> Result<Vec<SphericalIntrinsicPresence>, ProviderContractError> {
    use quick_xml::events::Event;

    let mut reader = quick_xml::Reader::from_str(xml);
    let mut result = Vec::new();
    let mut images_container_depth = None;
    let mut current_image_depth = None;
    let mut spherical_depth = None;
    let mut depth = 0_usize;
    let mut current = SphericalIntrinsicPresence::default();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                depth += 1;
                match event.local_name().as_ref() {
                    b"images2D" => images_container_depth = Some(depth),
                    b"vectorChild"
                        if images_container_depth.is_some_and(|images| depth == images + 1)
                            && current_image_depth.is_none() =>
                    {
                        current_image_depth = Some(depth);
                        current = SphericalIntrinsicPresence::default();
                    }
                    b"sphericalRepresentation" if current_image_depth.is_some() => {
                        spherical_depth = Some(depth);
                    }
                    b"pixelWidth" if spherical_depth.is_some() => current.pixel_width = true,
                    b"pixelHeight" if spherical_depth.is_some() => current.pixel_height = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(event)) => match event.local_name().as_ref() {
                b"pixelWidth" if spherical_depth.is_some() => current.pixel_width = true,
                b"pixelHeight" if spherical_depth.is_some() => current.pixel_height = true,
                _ => {}
            },
            Ok(Event::End(event)) => {
                if spherical_depth == Some(depth)
                    && event.local_name().as_ref() == b"sphericalRepresentation"
                {
                    spherical_depth = None;
                }
                if current_image_depth == Some(depth)
                    && event.local_name().as_ref() == b"vectorChild"
                {
                    result.push(current);
                    current_image_depth = None;
                }
                if images_container_depth == Some(depth)
                    && event.local_name().as_ref() == b"images2D"
                {
                    images_container_depth = None;
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(ProviderContractError::Provider(format!(
                    "invalid E57 XML while preserving spherical intrinsics: {error}"
                )))
            }
        }
    }
    if result.len() != image_count {
        return Err(ProviderContractError::Provider(
            "E57 XML image inventory could not be matched exactly".to_owned(),
        ));
    }
    Ok(result)
}

fn image_blob_total(images: &[Image]) -> Result<u64, ProviderContractError> {
    let mut total = 0_u64;
    let mut add = |blob: &Blob| -> Result<(), ProviderContractError> {
        if blob.length == 0 || blob.length > MAX_EMBEDDED_IMAGE_BYTES {
            return Err(ProviderContractError::Provider(format!(
                "E57 embedded image blob length {} violates the bounded contract",
                blob.length
            )));
        }
        total = total.checked_add(blob.length).ok_or_else(|| {
            ProviderContractError::Provider("E57 embedded image byte count overflow".to_owned())
        })?;
        if total > MAX_EMBEDDED_IMAGE_BYTES {
            return Err(ProviderContractError::Provider(format!(
                "E57 embedded images exceed {MAX_EMBEDDED_IMAGE_BYTES} bytes"
            )));
        }
        Ok(())
    };
    for image in images {
        if let Some(visual) = &image.visual_reference {
            add(&visual.blob.data)?;
            if let Some(mask) = &visual.mask {
                add(mask)?;
            }
        }
        if let Some(projection) = &image.projection {
            match projection {
                Projection::Pinhole(value) => {
                    add(&value.blob.data)?;
                    if let Some(mask) = &value.mask {
                        add(mask)?;
                    }
                }
                Projection::Spherical(value) => {
                    add(&value.blob.data)?;
                    if let Some(mask) = &value.mask {
                        add(mask)?;
                    }
                }
                Projection::Cylindrical(value) => {
                    add(&value.blob.data)?;
                    if let Some(mask) = &value.mask {
                        add(mask)?;
                    }
                }
            }
        }
    }
    Ok(total)
}

#[derive(Clone)]
struct ScanAssociation {
    source_guid: Option<String>,
    station_entity: Option<EntityId>,
    status: &'static str,
    losses: Vec<&'static str>,
}

fn scan_guid_inventory(
    summary: &E57TranscodeSummary,
) -> Result<BTreeSet<String>, ProviderContractError> {
    let mut result = BTreeSet::new();
    for guid in summary
        .source
        .scans
        .iter()
        .filter_map(|scan| scan.guid.as_ref())
    {
        if !result.insert(guid.clone()) {
            return Err(ProviderContractError::Provider(format!(
                "duplicate E57 scan GUID {guid} prevents exact image association"
            )));
        }
    }
    Ok(result)
}

fn scan_association(
    source_guid: Option<&str>,
    scan_guids: &BTreeSet<String>,
    scan_count: usize,
    merged_entity: &EntityId,
) -> ScanAssociation {
    match source_guid {
        None => ScanAssociation {
            source_guid: None,
            station_entity: None,
            status: "unassociated",
            losses: Vec::new(),
        },
        Some(guid) if !scan_guids.contains(guid) => ScanAssociation {
            source_guid: Some(guid.to_owned()),
            station_entity: None,
            status: "sourceScanMissing",
            losses: vec![E57_LOSS_ASSOCIATED_SCAN_MISSING],
        },
        Some(guid) if scan_count == 1 => ScanAssociation {
            source_guid: Some(guid.to_owned()),
            station_entity: Some(merged_entity.clone()),
            status: "exactEntity",
            losses: Vec::new(),
        },
        Some(guid) => ScanAssociation {
            source_guid: Some(guid.to_owned()),
            station_entity: None,
            status: "exactMergedMember",
            losses: vec![E57_LOSS_SCAN_MEMBER_NOT_ENTITY_ADDRESSABLE],
        },
    }
}

fn image_transform(transform: Option<&Transform>) -> Result<Transform3d, ProviderContractError> {
    let transform = transform.cloned().unwrap_or_default();
    let rotation = transform.rotation;
    let values = [
        rotation.w,
        rotation.x,
        rotation.y,
        rotation.z,
        transform.translation.x,
        transform.translation.y,
        transform.translation.z,
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return Err(ProviderContractError::Provider(
            "E57 image pose contains a non-finite value".to_owned(),
        ));
    }
    let norm_squared = rotation.w * rotation.w
        + rotation.x * rotation.x
        + rotation.y * rotation.y
        + rotation.z * rotation.z;
    if rotation.w < 0.0 || (norm_squared - 1.0).abs() > 1.0e-9 {
        return Err(ProviderContractError::Provider(
            "E57 image pose quaternion is not a canonical unit quaternion".to_owned(),
        ));
    }
    let (quaternion_w, quaternion_x, quaternion_y, quaternion_z) =
        (rotation.w, rotation.x, rotation.y, rotation.z);
    Ok(Transform3d([
        1.0 - 2.0 * (quaternion_y * quaternion_y + quaternion_z * quaternion_z),
        2.0 * (quaternion_x * quaternion_y + quaternion_z * quaternion_w),
        2.0 * (quaternion_x * quaternion_z - quaternion_y * quaternion_w),
        0.0,
        2.0 * (quaternion_x * quaternion_y - quaternion_z * quaternion_w),
        1.0 - 2.0 * (quaternion_x * quaternion_x + quaternion_z * quaternion_z),
        2.0 * (quaternion_y * quaternion_z + quaternion_x * quaternion_w),
        0.0,
        2.0 * (quaternion_x * quaternion_z + quaternion_y * quaternion_w),
        2.0 * (quaternion_y * quaternion_z - quaternion_x * quaternion_w),
        1.0 - 2.0 * (quaternion_x * quaternion_x + quaternion_y * quaternion_y),
        0.0,
        transform.translation.x,
        transform.translation.y,
        transform.translation.z,
        1.0,
    ]))
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn attach_projected_image(
    package: &mut CanonicalImportPackage,
    reader: &mut E57Reader<BufReader<File>>,
    resource_root: &Path,
    context: &mut dyn ProviderOperationContext,
    completed: &mut u64,
    total: u64,
    artifacts: &mut BTreeMap<String, PreparedResourceArtifact>,
    image: &Image,
    index: usize,
    projection: &Projection,
    spherical_presence: SphericalIntrinsicPresence,
    pose: Transform3d,
    association: &ScanAssociation,
) -> Result<(), ProviderContractError> {
    let (role, width, height, blob, mask, model, panorama, projectable, losses) = match projection {
        Projection::Pinhole(value) => {
            let p = &value.properties;
            if [
                p.focal_length,
                p.pixel_width,
                p.pixel_height,
                p.principal_x,
                p.principal_y,
            ]
            .iter()
            .any(|value| !value.is_finite())
                || p.focal_length <= 0.0
                || p.pixel_width <= 0.0
                || p.pixel_height <= 0.0
            {
                return Err(ProviderContractError::Provider(
                    "invalid E57 pinhole camera intrinsics".to_owned(),
                ));
            }
            (
                "pinhole",
                p.width,
                p.height,
                &value.blob,
                value.mask.as_ref(),
                CameraModel::Pinhole {
                    focal_x: p.focal_length / p.pixel_width,
                    focal_y: p.focal_length / p.pixel_height,
                    center_x: p.principal_x,
                    center_y: p.principal_y,
                    distortion_model: None,
                    distortion_parameters: Vec::new(),
                },
                false,
                true,
                Vec::new(),
            )
        }
        Projection::Spherical(value) => {
            let p = &value.properties;
            if [p.pixel_width, p.pixel_height]
                .iter()
                .any(|value| !value.is_finite())
                || p.pixel_width <= 0.0
                || p.pixel_height <= 0.0
            {
                return Err(ProviderContractError::Provider(
                    "invalid E57 spherical camera intrinsics".to_owned(),
                ));
            }
            let explicit = spherical_presence.pixel_width && spherical_presence.pixel_height;
            let full_width = std::f64::consts::TAU / f64::from(p.width);
            let full_height = std::f64::consts::PI / f64::from(p.height);
            let full = explicit
                && (p.pixel_width - full_width).abs() <= 1.0e-12
                && (p.pixel_height - full_height).abs() <= 1.0e-12;
            let model = if full {
                CameraModel::Equirectangular
            } else {
                let parameters = intern_object(
                    &mut package.objects,
                    "application/vnd.himmelcad.camera-model+json",
                    serde_json::json!({
                        "schemaVersion": 1,
                        "sourceFormat": E57_FORMAT_ID,
                        "projection": "spherical",
                        "projectable": explicit,
                        "pixelAngularWidth": p.pixel_width,
                        "pixelAngularHeight": p.pixel_height,
                        "imageWidth": p.width,
                        "imageHeight": p.height,
                        "sourcePixelAngularWidthPresent": spherical_presence.pixel_width,
                        "sourcePixelAngularHeightPresent": spherical_presence.pixel_height
                    }),
                )?;
                CameraModel::Extension {
                    model_id: "hcad.camera.e57-spherical@1".to_owned(),
                    parameters,
                }
            };
            let losses = if explicit {
                Vec::new()
            } else {
                vec![E57_LOSS_SPHERICAL_INTRINSICS_MISSING]
            };
            (
                "spherical",
                p.width,
                p.height,
                &value.blob,
                value.mask.as_ref(),
                model,
                explicit,
                explicit,
                losses,
            )
        }
        Projection::Cylindrical(value) => {
            let p = &value.properties;
            if [p.radius, p.principal_y, p.pixel_width, p.pixel_height]
                .iter()
                .any(|value| !value.is_finite())
                || p.radius <= 0.0
                || p.pixel_width <= 0.0
                || p.pixel_height <= 0.0
            {
                return Err(ProviderContractError::Provider(
                    "invalid E57 cylindrical camera intrinsics".to_owned(),
                ));
            }
            let parameters = intern_object(
                &mut package.objects,
                "application/vnd.himmelcad.camera-model+json",
                serde_json::json!({
                    "schemaVersion": 1,
                    "sourceFormat": E57_FORMAT_ID,
                    "projection": "cylindrical",
                    "projectable": true,
                    "radiusMeters": p.radius,
                    "principalPointY": p.principal_y,
                    "pixelAngularWidth": p.pixel_width,
                    "pixelHeightMeters": p.pixel_height,
                    "imageWidth": p.width,
                    "imageHeight": p.height
                }),
            )?;
            (
                "cylindrical",
                p.width,
                p.height,
                &value.blob,
                value.mask.as_ref(),
                CameraModel::Extension {
                    model_id: "hcad.camera.e57-cylindrical@1".to_owned(),
                    parameters,
                },
                true,
                true,
                Vec::new(),
            )
        }
    };
    let pixels = extract_image_blob(reader, blob, resource_root, context, completed, total)?;
    insert_resource_artifact(artifacts, pixels.clone())?;
    add_image_admission(
        package,
        image,
        index,
        role,
        width,
        height,
        &pixels.resource,
        model.clone(),
        pose,
        panorama,
        association,
        &losses,
    )?;
    if let Some(mask) = mask {
        add_mask_admission(
            package,
            reader,
            resource_root,
            context,
            completed,
            total,
            artifacts,
            image,
            index,
            &format!("{role}Mask"),
            width,
            height,
            mask,
            model,
            pose,
            association,
        )?;
    }
    let _ = projectable;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_mask_admission(
    package: &mut CanonicalImportPackage,
    reader: &mut E57Reader<BufReader<File>>,
    resource_root: &Path,
    context: &mut dyn ProviderOperationContext,
    completed: &mut u64,
    total: u64,
    artifacts: &mut BTreeMap<String, PreparedResourceArtifact>,
    image: &Image,
    index: usize,
    role: &str,
    width: u32,
    height: u32,
    mask: &Blob,
    model: CameraModel,
    pose: Transform3d,
    association: &ScanAssociation,
) -> Result<(), ProviderContractError> {
    let artifact = extract_blob(
        reader,
        mask,
        &ImageFormat::Png,
        resource_root,
        context,
        completed,
        total,
    )?;
    insert_resource_artifact(artifacts, artifact.clone())?;
    add_image_admission(
        package,
        image,
        index,
        role,
        width,
        height,
        &artifact.resource,
        model,
        pose,
        false,
        association,
        &[],
    )
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn add_image_admission(
    package: &mut CanonicalImportPackage,
    image: &Image,
    index: usize,
    role: &str,
    width: u32,
    height: u32,
    pixels: &GeometryResource,
    model: CameraModel,
    pose: Transform3d,
    panorama: bool,
    association: &ScanAssociation,
    representation_losses: &[&str],
) -> Result<(), ProviderContractError> {
    let components_ref = intern_object(
        &mut package.objects,
        "application/vnd.himmelcad.components+json",
        serde_json::json!({
            "hcad.e57-image-source@1": {
                "sourceImageIndex": index,
                "sourceImageGuid": image.guid,
                "representation": role
            }
        }),
    )?;
    let mut losses = association.losses.clone();
    losses.extend_from_slice(representation_losses);
    losses.sort_unstable();
    losses.dedup();
    let attributes_ref = intern_object(
        &mut package.objects,
        "application/vnd.himmelcad.attributes+json",
        serde_json::json!({
            "hcad.e57-image@1": {
                "sourceImageIndex": index,
                "sourceImageGuid": image.guid,
                "name": image.name,
                "description": image.description,
                "sensorVendor": image.sensor_vendor,
                "sensorModel": image.sensor_model,
                "sensorSerialNumber": image.sensor_serial,
                "representation": role,
                "associatedData3DGuid": association.source_guid,
                "associationStatus": association.status,
                "lossCodes": losses,
                "depth": null,
                "depthDerivation": {
                    "status": "notRun",
                    "recipeId": "hcad.derivation.e57-station-pointcloud-depth@1"
                }
            }
        }),
    )?;
    let relations = association
        .station_entity
        .as_ref()
        .map_or_else(Vec::new, |target| {
            vec![serde_json::json!({
                "relationType": "hcad.relation.e57-associated-scan@1",
                "targetEntityId": target.0,
                "sourceScanGuid": association.source_guid
            })]
        });
    let relations_ref = intern_object(
        &mut package.objects,
        "application/vnd.himmelcad.relations+json",
        serde_json::Value::Array(relations),
    )?;
    let raster = RasterImageGeometry {
        pixels: pixels.clone(),
        width,
        height,
        mapping: RasterMapping::Camera { model, pose },
        depth: None,
    };
    let (type_id, geometry) = if panorama {
        (
            built_in_type::PANORAMA,
            GeometryObject::Panorama {
                panorama: Box::new(PanoramaGeometry {
                    image: raster,
                    station_point_cloud: association.station_entity.clone(),
                }),
            },
        )
    } else {
        (
            built_in_type::RASTER_IMAGE,
            GeometryObject::RasterImage {
                raster: Box::new(raster),
            },
        )
    };
    let geometry_ref = geometry_object_content_hash(&geometry)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    let selected = Representation {
        role: RepresentationRole::Canonical,
        geometry_ref,
        authority: RepresentationAuthority::Authoritative,
        dependency_hash: None,
    };
    let mut id_digest = Sha256::new();
    id_digest.update(image.guid.as_deref().unwrap_or("").as_bytes());
    id_digest.update(index.to_le_bytes());
    id_digest.update(role.as_bytes());
    id_digest.update(pixels.object_hash.as_str().as_bytes());
    let mut entity = CanonicalEntity {
        id: EntityId(format!("e57-image-{}", hex::encode(id_digest.finalize()))),
        revision: 0,
        type_id: EntityTypeId(type_id.to_owned()),
        name: image
            .name
            .clone()
            .unwrap_or_else(|| format!("E57 image {} ({role})", index + 1)),
        owner: None,
        layer_ids: Vec::new(),
        placement: None,
        representations: vec![selected.clone()],
        components_ref,
        attributes_ref,
        relations_ref,
        style_ref: None,
        schema_version: 1,
        version_hash: ObjectHash::of_bytes(b"uninitialized"),
    };
    entity.version_hash = canonical_entity_version_hash(&entity)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    validate_resolved_representation(&entity, &selected, &geometry)
        .map_err(|error| ProviderContractError::Canonical(error.to_string()))?;
    package.admissions.push(CanonicalRepresentationAdmission {
        entity,
        selected,
        representation_slot: "source".to_owned(),
        expected_generation: None,
        resolved_geometry: geometry,
    });
    Ok(())
}

fn intern_object(
    objects: &mut Vec<CanonicalJsonObject>,
    media_type: &str,
    value: serde_json::Value,
) -> Result<ObjectHash, ProviderContractError> {
    let candidate = CanonicalJsonObject::new(media_type, value)?;
    if let Some(existing) = objects
        .iter()
        .find(|object| object.object_hash == candidate.object_hash)
    {
        if existing != &candidate {
            return Err(ProviderContractError::InvalidObject);
        }
        return Ok(existing.object_hash.clone());
    }
    let hash = candidate.object_hash.clone();
    objects.push(candidate);
    Ok(hash)
}

fn insert_resource_artifact(
    artifacts: &mut BTreeMap<String, PreparedResourceArtifact>,
    artifact: PreparedResourceArtifact,
) -> Result<(), ProviderContractError> {
    let key = artifact.resource.object_hash.0.clone();
    if let Some(existing) = artifacts.get(&key) {
        if existing != &artifact {
            return Err(ProviderContractError::Provider(
                "identical E57 image bytes have conflicting resource descriptors".to_owned(),
            ));
        }
    } else {
        artifacts.insert(key, artifact);
    }
    Ok(())
}

fn extract_image_blob(
    reader: &mut E57Reader<BufReader<File>>,
    blob: &ImageBlob,
    resource_root: &Path,
    context: &mut dyn ProviderOperationContext,
    completed: &mut u64,
    total: u64,
) -> Result<PreparedResourceArtifact, ProviderContractError> {
    extract_blob(
        reader,
        &blob.data,
        &blob.format,
        resource_root,
        context,
        completed,
        total,
    )
}

#[allow(clippy::too_many_arguments)]
fn extract_blob(
    reader: &mut E57Reader<BufReader<File>>,
    blob: &Blob,
    format: &ImageFormat,
    resource_root: &Path,
    context: &mut dyn ProviderOperationContext,
    completed: &mut u64,
    total: u64,
) -> Result<PreparedResourceArtifact, ProviderContractError> {
    if context.is_cancelled() {
        return Err(ProviderContractError::Cancelled);
    }
    let directory = resource_root.join("e57-image-resources");
    std::fs::create_dir_all(&directory)
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    let stage_path = directory.join(format!(".{}.stage", staging_nonce(resource_root, 0)));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&stage_path)
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    let mut stage = IncompleteOutput::new(&stage_path);
    let (hash, length) = {
        let mut sink = ImageBlobSink::new(file, blob.length, context, completed, total);
        if let Err(error) = reader.blob(blob, &mut sink) {
            if sink.context.is_cancelled() {
                return Err(ProviderContractError::Cancelled);
            }
            return Err(ProviderContractError::Provider(format!(
                "E57 image blob: {error}"
            )));
        }
        sink.finish()?
    };
    let (extension, media_type) = match format {
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
    };
    let relative_path =
        PathBuf::from("e57-image-resources").join(format!("{}.{extension}", hash.as_str()));
    let destination = resource_root.join(&relative_path);
    if destination.exists() {
        verify_resource_file(&destination, &hash, length)?;
        std::fs::remove_file(&stage_path)
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    } else {
        std::fs::rename(&stage_path, &destination)
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
    }
    stage.complete = true;
    Ok(PreparedResourceArtifact {
        relative_path,
        resource: GeometryResource {
            object_hash: hash,
            media_type: media_type.to_owned(),
            byte_length: Some(length),
        },
    })
}

struct ImageBlobSink<'a> {
    writer: BufWriter<File>,
    digest: Sha256,
    expected: u64,
    written: u64,
    context: &'a mut dyn ProviderOperationContext,
    completed: &'a mut u64,
    total: u64,
    next_progress: u64,
}

impl<'a> ImageBlobSink<'a> {
    fn new(
        file: File,
        expected: u64,
        context: &'a mut dyn ProviderOperationContext,
        completed: &'a mut u64,
        total: u64,
    ) -> Self {
        Self {
            writer: BufWriter::new(file),
            digest: Sha256::new(),
            expected,
            written: 0,
            context,
            completed,
            total,
            next_progress: IMAGE_PROGRESS_INTERVAL_BYTES,
        }
    }

    fn finish(mut self) -> Result<(ObjectHash, u64), ProviderContractError> {
        self.writer
            .flush()
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        self.writer
            .get_ref()
            .sync_all()
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        if self.written != self.expected {
            return Err(ProviderContractError::Provider(format!(
                "E57 image blob length changed: expected {}, read {}",
                self.expected, self.written
            )));
        }
        Ok((
            ObjectHash(hex::encode(self.digest.finalize())),
            self.written,
        ))
    }
}

impl Write for ImageBlobSink<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.context.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "E57 import cancelled",
            ));
        }
        let count = self.writer.write(buffer)?;
        self.digest.update(&buffer[..count]);
        self.written = self.written.saturating_add(count as u64);
        *self.completed = self.completed.saturating_add(count as u64);
        if self.written > self.expected {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "E57 blob exceeds declared length",
            ));
        }
        if *self.completed >= self.next_progress {
            self.context.report_progress(ProviderProgress {
                phase: "e57-extract-images".to_owned(),
                completed: *self.completed,
                total: Some(self.total),
                message: "extracting immutable E57 image resources".to_owned(),
            });
            self.next_progress = self.completed.saturating_add(IMAGE_PROGRESS_INTERVAL_BYTES);
        }
        Ok(count)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

fn verify_resource_file(
    path: &Path,
    expected_hash: &ObjectHash,
    expected_length: u64,
) -> Result<(), ProviderContractError> {
    if path
        .metadata()
        .map_err(|error| ProviderContractError::Provider(error.to_string()))?
        .len()
        != expected_length
    {
        return Err(ProviderContractError::Provider(format!(
            "immutable E57 resource collision at {}",
            path.display()
        )));
    }
    let mut reader = BufReader::new(
        File::open(path).map_err(|error| ProviderContractError::Provider(error.to_string()))?,
    );
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| ProviderContractError::Provider(error.to_string()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if ObjectHash(hex::encode(digest.finalize())) != *expected_hash {
        return Err(ProviderContractError::Provider(format!(
            "immutable E57 resource hash collision at {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use e57::{
        CylindricalImageProperties, E57Writer, PinholeImageProperties, Quaternion, RawValues,
        Record, RecordDataType, RecordName, RecordValue, SphericalImageProperties, Translation,
        VisualReferenceImageProperties,
    };
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        built_in_type, CanonicalEntity, EntityTypeId, GeometryResource, Representation,
        RepresentationAuthority, RepresentationRole, StreamedGeometry,
    };
    use himmelcad_core::entity_validation::geometry_object_content_hash;
    use himmelcad_core::geometry_representation_registry::CanonicalRepresentationAdmission;
    use himmelcad_core::hash::ObjectHash;

    use crate::canonical_provider::{
        CanonicalJsonObject, CanonicalPreparedDataset, PreparedDatasetArtifact,
    };

    #[test]
    fn descriptor_and_probe_are_bounded_and_versioned() {
        let provider = E57CanonicalProvider::new(PathBuf::from("cache"));
        provider.descriptor().validate().unwrap();
        assert_eq!(
            Some(ImportProbe {
                format_id: E57_FORMAT_ID.to_owned(),
                confidence: 100,
            }),
            provider
                .probe(ImportProbeRequest {
                    path: Path::new("scan.bin"),
                    prefix: b"ASTM-E57trailing bytes",
                    media_type: None,
                })
                .unwrap()
        );
        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("scan.bin"),
                prefix: b"not-e57",
                media_type: None,
            })
            .unwrap()
            .is_none());
    }

    #[test]
    fn tiny_fixture_applies_pose_and_preserves_color_and_intensity() {
        let directory = TestDirectory::new("posed");
        let source = directory.path.join("fixture.e57");
        let destination = directory.path.join("fixture.laz");
        write_fixture(&source);

        let summary =
            transcode_e57_to_laz(&source, &destination, 0.000_001, |_| {}, || false).unwrap();
        assert_eq!(2, summary.source.emitted_point_count);
        assert_vector_close(summary.bounds_min, [101.0, 202.0, 303.0]);
        assert_vector_close(summary.bounds_max, [104.0, 205.0, 306.0]);
        assert!(summary.has_color);
        assert!(summary.has_intensity);
        assert_vector_close(
            summary.source.scans[0].pose.translation,
            [100.0, 200.0, 300.0],
        );

        let mut reader = las::Reader::from_path(&destination).unwrap();
        let points = reader.points().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(2, points.len());
        assert!((points[0].x - 101.0).abs() <= summary.coordinate_scale[0]);
        assert!((points[0].y - 202.0).abs() <= summary.coordinate_scale[1]);
        assert!((points[0].z - 303.0).abs() <= summary.coordinate_scale[2]);
        assert_eq!(Some(Color::new(u16::MAX, 0, 32_896)), points[0].color);
        assert!((i32::from(points[0].intensity) - 16_384).abs() <= 1);
    }

    #[test]
    fn cancellation_leaves_no_partial_laz() {
        let directory = TestDirectory::new("cancel");
        let source = directory.path.join("fixture.e57");
        let destination = directory.path.join("fixture.laz");
        write_fixture(&source);
        let result = transcode_e57_to_laz(&source, &destination, 0.001, |_| {}, || true);
        assert!(matches!(result, Err(E57ImportError::Cancelled)));
        assert!(!destination.exists());
    }

    #[test]
    fn canonical_output_is_retagged_with_e57_provenance_and_revalidates() {
        let package = canonicalize_e57_package(
            canonical_point_cloud_package(),
            Path::new("survey.e57"),
            &fixture_summary(),
        )
        .unwrap();
        package.validate().unwrap();
        assert_eq!(E57_PROVIDER_ID, package.provider_id);
        assert_eq!("survey.e57", package.admissions[0].entity.name);
        let attributes_ref = &package.admissions[0].entity.attributes_ref;
        let attributes = package
            .objects
            .iter()
            .find(|object| &object.object_hash == attributes_ref)
            .unwrap();
        assert_eq!(
            Some("root-guid"),
            attributes.value["hcad.e57-import@1"]["source"]["guid"].as_str()
        );
        assert_eq!(
            Some("survey.e57"),
            attributes.value["hcad.point-cloud-import@1"]["sourceName"].as_str()
        );
    }

    #[test]
    fn embedded_images_are_immutable_canonical_resources_with_exact_camera_semantics() {
        let directory = TestDirectory::new("images");
        let source = directory.path.join("images.e57");
        let laz = directory.path.join("images.laz");
        let resources = directory.path.join("resources");
        write_image_fixture(&source, false, false);
        let summary = transcode_e57_to_laz(&source, &laz, 0.000_001, |_| {}, || false).unwrap();
        assert_eq!(4, summary.source.embedded_image_count);
        let base =
            canonicalize_e57_package(canonical_point_cloud_package(), &source, &summary).unwrap();
        let mut context = TestContext::default();
        let package =
            attach_e57_images(base.clone(), &source, &resources, &summary, &mut context).unwrap();
        package.validate().unwrap();
        assert_eq!(7, package.admissions.len());
        assert_eq!(1, package.resource_sets.len());
        assert_eq!(1, package.resource_sets[0].resources.len());
        let artifact = &package.resource_sets[0].resources[0];
        assert_eq!(Some(TINY_PNG.len() as u64), artifact.resource.byte_length);
        assert_eq!(
            ObjectHash::of_bytes(TINY_PNG),
            artifact.resource.object_hash
        );
        assert_eq!(
            TINY_PNG,
            fs::read(resources.join(&artifact.relative_path)).unwrap()
        );

        let mut saw_pinhole = false;
        let mut saw_spherical = false;
        let mut saw_cylindrical = false;
        let mut saw_visual = false;
        for admission in &package.admissions {
            match &admission.resolved_geometry {
                GeometryObject::RasterImage { raster } => {
                    assert!(raster.depth.is_none());
                    if let RasterMapping::Camera { model, pose } = &raster.mapping {
                        match model {
                            CameraModel::Pinhole {
                                focal_x,
                                focal_y,
                                center_x,
                                center_y,
                                ..
                            } => {
                                assert_eq!(
                                    [10.0, 20.0, 30.0],
                                    [pose.0[12], pose.0[13], pose.0[14]]
                                );
                                assert!((*focal_x - 1000.0).abs() < 1.0e-9);
                                assert!((*focal_y - 500.0).abs() < 1.0e-9);
                                assert_eq!((0.5, 0.5), (*center_x, *center_y));
                                saw_pinhole = true;
                            }
                            CameraModel::Extension { model_id, .. }
                                if model_id == "hcad.camera.e57-visual-reference@1" =>
                            {
                                saw_visual = true
                            }
                            _ => {}
                        }
                    }
                }
                GeometryObject::Panorama { panorama } => {
                    assert!(panorama.image.depth.is_none());
                    assert_eq!(
                        Some(EntityId("entity-e57-test".to_owned())),
                        panorama.station_point_cloud
                    );
                    match &panorama.image.mapping {
                        RasterMapping::Camera {
                            model: CameraModel::Equirectangular,
                            pose,
                        } => {
                            assert_eq!([10.0, 20.0, 30.0], [pose.0[12], pose.0[13], pose.0[14]]);
                            saw_spherical = true;
                        }
                        RasterMapping::Camera {
                            model: CameraModel::Extension { model_id, .. },
                            ..
                        } if model_id == "hcad.camera.e57-cylindrical@1" => saw_cylindrical = true,
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        assert!(saw_pinhole && saw_spherical && saw_cylindrical && saw_visual);
        assert!(context
            .progress
            .first()
            .is_some_and(|progress| progress.completed == 0));
        assert!(context
            .progress
            .last()
            .is_some_and(|progress| progress.completed == progress.total.unwrap()));

        let mut second_context = TestContext::default();
        let repeated =
            attach_e57_images(base, &source, &resources, &summary, &mut second_context).unwrap();
        assert_eq!(package, repeated);
    }

    #[test]
    fn omitted_spherical_intrinsics_are_not_invented_as_equirectangular() {
        let directory = TestDirectory::new("spherical-missing");
        let source = directory.path.join("missing.e57");
        let laz = directory.path.join("missing.laz");
        let resources = directory.path.join("resources");
        write_image_fixture(&source, true, false);
        let summary = transcode_e57_to_laz(&source, &laz, 0.001, |_| {}, || false).unwrap();
        let base =
            canonicalize_e57_package(canonical_point_cloud_package(), &source, &summary).unwrap();
        let package = attach_e57_images(
            base,
            &source,
            &resources,
            &summary,
            &mut TestContext::default(),
        )
        .unwrap();
        let spherical = package
            .admissions
            .iter()
            .find(|admission| {
                let attributes = package
                    .objects
                    .iter()
                    .find(|object| object.object_hash == admission.entity.attributes_ref)
                    .unwrap();
                attributes.value["hcad.e57-image@1"]["representation"] == "spherical"
            })
            .unwrap();
        let GeometryObject::RasterImage { raster } = &spherical.resolved_geometry else {
            panic!("missing spherical raster")
        };
        assert!(matches!(
            &raster.mapping,
            RasterMapping::Camera { model: CameraModel::Extension { model_id, .. }, .. }
                if model_id == "hcad.camera.e57-spherical@1"
        ));
        let attributes = package
            .objects
            .iter()
            .find(|object| object.object_hash == spherical.entity.attributes_ref)
            .unwrap();
        assert!(attributes.value["hcad.e57-image@1"]["lossCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == E57_LOSS_SPHERICAL_INTRINSICS_MISSING));
    }

    #[test]
    fn invalid_pinhole_intrinsics_fail_closed_before_package_publication() {
        let directory = TestDirectory::new("invalid-pinhole");
        let source = directory.path.join("invalid.e57");
        let laz = directory.path.join("invalid.laz");
        write_image_fixture(&source, false, true);
        let summary = transcode_e57_to_laz(&source, &laz, 0.001, |_| {}, || false).unwrap();
        let base =
            canonicalize_e57_package(canonical_point_cloud_package(), &source, &summary).unwrap();
        let result = attach_e57_images(
            base,
            &source,
            &directory.path.join("resources"),
            &summary,
            &mut TestContext::default(),
        );
        assert!(
            matches!(result, Err(ProviderContractError::Provider(message)) if message.contains("pinhole"))
        );
    }

    #[test]
    fn cancelled_image_extraction_publishes_no_partial_stage_file() {
        let directory = TestDirectory::new("image-cancel");
        let source = directory.path.join("images.e57");
        let laz = directory.path.join("images.laz");
        let resources = directory.path.join("resources");
        write_image_fixture(&source, false, false);
        let summary = transcode_e57_to_laz(&source, &laz, 0.001, |_| {}, || false).unwrap();
        let base =
            canonicalize_e57_package(canonical_point_cloud_package(), &source, &summary).unwrap();
        let mut context = TestContext {
            cancelled: true,
            progress: Vec::new(),
        };
        assert!(matches!(
            attach_e57_images(base, &source, &resources, &summary, &mut context),
            Err(ProviderContractError::Cancelled)
        ));
        let stages = if resources.exists() {
            fs::read_dir(&resources)
                .unwrap()
                .flatten()
                .flat_map(|entry| fs::read_dir(entry.path()).into_iter().flatten().flatten())
                .filter(|entry| entry.file_name().to_string_lossy().contains(".stage"))
                .count()
        } else {
            0
        };
        assert_eq!(0, stages);
    }

    #[test]
    fn scan_association_never_promotes_a_merged_member_or_missing_guid() {
        let scans = BTreeSet::from(["scan-a".to_owned(), "scan-b".to_owned()]);
        let merged = EntityId("merged".to_owned());
        let member = scan_association(Some("scan-a"), &scans, 2, &merged);
        assert_eq!("exactMergedMember", member.status);
        assert!(member.station_entity.is_none());
        assert_eq!(
            vec![E57_LOSS_SCAN_MEMBER_NOT_ENTITY_ADDRESSABLE],
            member.losses
        );

        let missing = scan_association(Some("scan-c"), &scans, 2, &merged);
        assert_eq!(Some("scan-c".to_owned()), missing.source_guid);
        assert_eq!("sourceScanMissing", missing.status);
        assert_eq!(vec![E57_LOSS_ASSOCIATED_SCAN_MISSING], missing.losses);
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

    const TINY_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31,
        0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    fn write_image_fixture(path: &Path, omit_spherical_intrinsics: bool, invalid_pinhole: bool) {
        let prototype = vec![
            double_record(RecordName::CartesianX),
            double_record(RecordName::CartesianY),
            double_record(RecordName::CartesianZ),
        ];
        let mut writer = E57Writer::from_file(path, "root-guid").unwrap();
        {
            let mut pointcloud = writer.add_pointcloud("scan-guid", prototype).unwrap();
            pointcloud
                .add_point(vec![
                    RecordValue::Double(1.0),
                    RecordValue::Double(2.0),
                    RecordValue::Double(3.0),
                ])
                .unwrap();
            pointcloud.finalize().unwrap();
        }
        let image_pose = Transform {
            rotation: Quaternion::default(),
            translation: Translation {
                x: 10.0,
                y: 20.0,
                z: 30.0,
            },
        };
        {
            let mut image = writer.add_image("pinhole-image").unwrap();
            image.set_name("pinhole station image");
            image.set_pointcloud_guid("scan-guid");
            image.set_transform(image_pose.clone());
            let mut visual_bytes = TINY_PNG;
            image
                .add_visual_reference(
                    ImageFormat::Png,
                    &mut visual_bytes,
                    VisualReferenceImageProperties {
                        width: 1,
                        height: 1,
                    },
                    None,
                )
                .unwrap();
            let mut pinhole_bytes = TINY_PNG;
            let mut pinhole_mask_bytes = TINY_PNG;
            image
                .add_pinhole(
                    ImageFormat::Png,
                    &mut pinhole_bytes,
                    PinholeImageProperties {
                        width: 1,
                        height: 1,
                        focal_length: 0.01,
                        pixel_width: if invalid_pinhole { 0.0 } else { 0.000_01 },
                        pixel_height: 0.000_02,
                        principal_x: 0.5,
                        principal_y: 0.5,
                    },
                    Some(&mut pinhole_mask_bytes),
                )
                .unwrap();
            image.finalize().unwrap();
        }
        {
            let mut image = writer.add_image("spherical-image").unwrap();
            image.set_pointcloud_guid("scan-guid");
            image.set_transform(image_pose.clone());
            let mut spherical_bytes = TINY_PNG;
            image
                .add_spherical(
                    ImageFormat::Png,
                    &mut spherical_bytes,
                    SphericalImageProperties {
                        width: 2,
                        height: 1,
                        pixel_width: std::f64::consts::PI,
                        pixel_height: std::f64::consts::PI,
                    },
                    None,
                )
                .unwrap();
            image.finalize().unwrap();
        }
        {
            let mut image = writer.add_image("cylindrical-image").unwrap();
            image.set_pointcloud_guid("scan-guid");
            image.set_transform(image_pose);
            let mut cylindrical_bytes = TINY_PNG;
            image
                .add_cylindrical(
                    ImageFormat::Png,
                    &mut cylindrical_bytes,
                    CylindricalImageProperties {
                        width: 1,
                        height: 1,
                        radius: 1.0,
                        principal_y: 0.5,
                        pixel_width: 0.1,
                        pixel_height: 0.001,
                    },
                    None,
                )
                .unwrap();
            image.finalize().unwrap();
        }
        {
            let mut image = writer.add_image("visual-image").unwrap();
            let mut visual_bytes = TINY_PNG;
            image
                .add_visual_reference(
                    ImageFormat::Png,
                    &mut visual_bytes,
                    VisualReferenceImageProperties {
                        width: 1,
                        height: 1,
                    },
                    None,
                )
                .unwrap();
            image.finalize().unwrap();
        }
        writer
            .finalize_customized_xml(|xml| {
                // e57 0.11.13's deterministic cylindrical writer misspells this
                // standard tag as `readius`; repair the writer fixture itself.
                let xml = xml
                    .replace("<readius", "<radius")
                    .replace("</readius", "</radius");
                if omit_spherical_intrinsics {
                    let mut in_spherical = false;
                    Ok(xml
                        .lines()
                        .filter(|line| {
                            if line.contains("<sphericalRepresentation") {
                                in_spherical = true;
                            }
                            let remove = in_spherical
                                && (line.contains("<pixelWidth") || line.contains("<pixelHeight"));
                            if line.contains("</sphericalRepresentation") {
                                in_spherical = false;
                            }
                            !remove
                        })
                        .collect::<Vec<_>>()
                        .join("\n"))
                } else {
                    Ok(xml)
                }
            })
            .unwrap();
    }

    fn write_fixture(path: &Path) {
        let prototype = vec![
            double_record(RecordName::CartesianX),
            double_record(RecordName::CartesianY),
            double_record(RecordName::CartesianZ),
            Record {
                name: RecordName::Intensity,
                data_type: RecordDataType::Single {
                    min: Some(0.0),
                    max: Some(1.0),
                },
            },
            color_record(RecordName::ColorRed),
            color_record(RecordName::ColorGreen),
            color_record(RecordName::ColorBlue),
        ];
        let mut writer = E57Writer::from_file(path, "root-guid").unwrap();
        writer.set_coordinate_metadata(Some("LOCAL_CS[\"fixture\"]".to_owned()));
        {
            let mut pointcloud = writer.add_pointcloud("scan-guid", prototype).unwrap();
            pointcloud.set_name(Some("station one".to_owned()));
            pointcloud.set_transform(Some(Transform {
                rotation: Quaternion::default(),
                translation: Translation {
                    x: 100.0,
                    y: 200.0,
                    z: 300.0,
                },
            }));
            pointcloud
                .add_point(fixture_values(1.0, 2.0, 3.0, 0.25, 255, 0, 128))
                .unwrap();
            pointcloud
                .add_point(fixture_values(4.0, 5.0, 6.0, 0.75, 0, 255, 64))
                .unwrap();
            pointcloud.finalize().unwrap();
        }
        writer.finalize().unwrap();
    }

    fn double_record(name: RecordName) -> Record {
        Record {
            name,
            data_type: RecordDataType::Double {
                min: None,
                max: None,
            },
        }
    }

    fn color_record(name: RecordName) -> Record {
        Record {
            name,
            data_type: RecordDataType::Integer { min: 0, max: 255 },
        }
    }

    fn fixture_values(
        x: f64,
        y: f64,
        z: f64,
        intensity: f32,
        red: i64,
        green: i64,
        blue: i64,
    ) -> RawValues {
        vec![
            RecordValue::Double(x),
            RecordValue::Double(y),
            RecordValue::Double(z),
            RecordValue::Single(intensity),
            RecordValue::Integer(red),
            RecordValue::Integer(green),
            RecordValue::Integer(blue),
        ]
    }

    fn assert_vector_close(actual: [f64; 3], expected: [f64; 3]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < f64::EPSILON);
        }
    }

    fn fixture_summary() -> E57TranscodeSummary {
        E57TranscodeSummary {
            source: E57SourceMetadata {
                guid: "root-guid".to_owned(),
                coordinate_metadata: Some("LOCAL_CS[\"fixture\"]".to_owned()),
                embedded_image_count: 0,
                source_record_count: 2,
                emitted_point_count: 2,
                scans: vec![E57ScanMetadata {
                    guid: Some("scan-guid".to_owned()),
                    name: Some("station one".to_owned()),
                    source_record_count: 2,
                    emitted_point_count: 2,
                    has_color: true,
                    has_intensity: true,
                    pose: E57ScanPose {
                        rotation_wxyz: [1.0, 0.0, 0.0, 0.0],
                        translation: [100.0, 200.0, 300.0],
                    },
                }],
            },
            bounds_min: [101.0, 202.0, 303.0],
            bounds_max: [104.0, 205.0, 306.0],
            coordinate_scale: [0.000_001; 3],
            coordinate_offset: [102.5, 203.5, 304.5],
            has_color: true,
            has_intensity: true,
        }
    }

    fn canonical_point_cloud_package() -> CanonicalImportPackage {
        let components = CanonicalJsonObject::new(
            "application/vnd.himmelcad.components+json",
            serde_json::json!({}),
        )
        .unwrap();
        let attributes = CanonicalJsonObject::new(
            "application/vnd.himmelcad.attributes+json",
            serde_json::json!({
                "hcad.point-cloud-import@1": {
                    "sourceName": "merged-source.laz",
                    "pointCount": 2,
                    "hasColor": true,
                    "hasIntensity": true,
                }
            }),
        )
        .unwrap();
        let relations = CanonicalJsonObject::new(
            "application/vnd.himmelcad.relations+json",
            serde_json::json!([]),
        )
        .unwrap();
        let metadata_bytes = b"{}";
        let metadata = GeometryResource {
            object_hash: ObjectHash::of_bytes(metadata_bytes),
            media_type: "application/json".to_owned(),
            byte_length: Some(metadata_bytes.len() as u64),
        };
        let geometry = GeometryObject::PointCloud {
            dataset: StreamedGeometry {
                format_id: "potree@2".to_owned(),
                metadata: metadata.clone(),
                element_count: Some(2),
            },
        };
        let selected = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(&geometry).unwrap(),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId("entity-e57-test".to_owned()),
            revision: 0,
            type_id: EntityTypeId(built_in_type::POINT_CLOUD.to_owned()),
            name: "merged-source.laz".to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![selected.clone()],
            components_ref: components.object_hash.clone(),
            attributes_ref: attributes.object_hash.clone(),
            relations_ref: relations.object_hash.clone(),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).unwrap();
        CanonicalImportPackage {
            schema_version: CANONICAL_IO_SCHEMA_VERSION,
            provider_id: "hcad.io.las-potree@1".to_owned(),
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
                dataset_id: "potree-e57-test".to_owned(),
                format_id: "potree@2".to_owned(),
                entity_id: "entity-e57-test".to_owned(),
                representation_slot: "source".to_owned(),
                root_metadata: metadata.clone(),
                artifacts: vec![PreparedDatasetArtifact {
                    relative_path: PathBuf::from("metadata.json"),
                    resource: metadata,
                }],
            }],
            resource_sets: Vec::new(),
            presentation_resources: Default::default(),
        }
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hcad-e57-test-{label}-{}",
                staging_nonce(Path::new(label), 0)
            ));
            fs::create_dir(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
