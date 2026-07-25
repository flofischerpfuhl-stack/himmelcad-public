//! Importers/exporters for `HimmelCAD`.
//!
//! Phase 1: LAS/LAZ. Phase 2+: DXF, IFC, E57, etc. Each format lives in its
//! own module and registers an Importer through the trait below.

#![forbid(unsafe_code)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use thiserror::Error;

pub mod canonical_provider;
pub mod dxf_provider;
pub mod e57_import;
pub mod gaussian_splat_provider;
pub mod gcp_import;
pub mod hcap_import;
mod geotiff_preparation;
pub mod geotiff_provider;
pub mod ifc_provider;
mod ifc_step;
pub mod landxml;
mod landxml_dom;
pub mod las_import;
pub mod photolab_image_import;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("unsupported format: {0}")]
    Unsupported(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("las error: {0}")]
    Las(String),
    #[error("PotreeConverter: {0}")]
    Converter(String),
    #[error("metadata: {0}")]
    Metadata(String),
    #[error("canonical import admission: {0}")]
    Canonical(String),
    #[error("import was cancelled")]
    Cancelled,
}

pub trait Importer {
    fn supports(&self, path: &Path) -> bool;
    fn import(&self, path: &Path) -> Result<ImportResult, ImportError>;
}

#[derive(Debug, Default)]
pub struct ImportResult {
    pub source_name: String,
    pub point_count: u64,
}

pub use canonical_provider::{
    CanonicalExportPlan, CanonicalExportProvider, CanonicalExportRequest, CanonicalImportPackage,
    CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject, CanonicalPreparedDataset,
    CanonicalResourceSet, ExportOutput, FormatCapability, FormatProviderDescriptor,
    FormatProviderRegistry, ImportProbe, ImportProbeRequest, ImportProviderSelection,
    PreparedDatasetArtifact, PreparedResourceArtifact, ProviderContractError,
    ProviderOperationContext, ProviderProgress, CANONICAL_IO_SCHEMA_VERSION,
};
pub use dxf_provider::{DxfCanonicalProvider, DXF_FORMAT_ID, DXF_PROVIDER_ID};
pub use e57_import::{
    transcode_e57_to_laz, E57CanonicalProvider, E57ImportError, E57ScanMetadata, E57ScanPose,
    E57SourceMetadata, E57TranscodeProgress, E57TranscodeSummary,
};
pub use gaussian_splat_provider::{
    GaussianSplatPlyProvider, GAUSSIAN_SPLAT_PLY_FORMAT_ID, GAUSSIAN_SPLAT_PLY_PROVIDER_ID,
    LOSS_SPLAT_EXPORT_NOT_PASSTHROUGH, LOSS_SPLAT_EXPORT_SELECTION,
};
pub use gcp_import::{
    import_gcp_csv_file, import_gcp_csv_file_with_cancel, preview_gcp_csv_file, GcpCsvImportResult,
    GcpCsvPreview, GcpCsvPreviewRow, GcpCsvRowError,
};
pub use geotiff_provider::{
    GeoTiffCanonicalProvider, GEOTIFF_FORMAT_ID, GEOTIFF_PROVIDER_ID,
    LOSS_EXPORT_MULTIPLE_ENTITIES, LOSS_EXPORT_NOT_PASSTHROUGH, UNSUPPORTED_ELEVATION_BANDS,
    UNSUPPORTED_INVALID_TRANSFORM, UNSUPPORTED_MISSING_CRS, UNSUPPORTED_MISSING_TRANSFORM,
    UNSUPPORTED_NODATA, UNSUPPORTED_SAMPLE_LAYOUT,
};
pub use ifc_provider::{
    IfcCanonicalProvider, IFC2X3_FORMAT_ID, IFC4X3_FORMAT_ID, IFC4_FORMAT_ID, IFC_PROVIDER_ID,
    LOSS_NOT_EXACT_SOURCE, LOSS_UNSUPPORTED_GEOMETRY,
};
pub use landxml::{
    LandXmlCoordinateSystem, LandXmlError, LandXmlImportReport, LandXmlProvider, LandXmlUnits,
    LANDXML_FORMAT_ID, LANDXML_PROVIDER_ID,
};
pub use las_import::{
    import_las_file, import_las_file_with_progress, import_las_file_with_progress_and_cancel,
    CanonicalImportJsonObject, ConverterProgress, LasImportSummary, LasPotreeCanonicalProvider,
    PreparedPotreeFile, PreparedPotreeManifest,
};
pub use photolab_image_import::{
    discover_photo_files, import_photo_files, import_photo_files_with_progress, PhotoDiscovery,
    PhotoImportCandidate,
};

/// Builds the production canonical import registry shared by desktop hosts.
///
/// All expensive providers publish into the same caller-owned prepared-data
/// root but retain independent content-addressed dataset directories.
pub fn canonical_builtin_import_registry(
    prepared_data_root: PathBuf,
) -> Result<FormatProviderRegistry, ProviderContractError> {
    let mut registry = FormatProviderRegistry::default();
    registry.register_importer(Arc::new(LasPotreeCanonicalProvider::new(
        prepared_data_root.clone(),
    )))?;
    registry.register_importer(Arc::new(E57CanonicalProvider::new(
        prepared_data_root.clone(),
    )))?;
    let dxf = Arc::new(DxfCanonicalProvider::new(prepared_data_root.clone()));
    registry.register_importer(dxf.clone())?;
    registry.register_exporter(dxf)?;
    let landxml = Arc::new(LandXmlProvider::new());
    registry.register_importer(landxml.clone())?;
    registry.register_exporter(landxml)?;
    let splats = Arc::new(GaussianSplatPlyProvider::new(prepared_data_root.clone()));
    registry.register_importer(splats.clone())?;
    registry.register_exporter(splats)?;
    let ifc = Arc::new(IfcCanonicalProvider::new(prepared_data_root.clone()));
    registry.register_importer(ifc.clone())?;
    registry.register_exporter(ifc)?;
    let geotiff = Arc::new(GeoTiffCanonicalProvider::new(prepared_data_root));
    registry.register_importer(geotiff.clone())?;
    registry.register_exporter(geotiff)?;
    Ok(registry)
}

#[cfg(test)]
pub(crate) mod viewer_contract_test_support {
    use himmelcad_core::entity_model::{ElevationSurfaceGeometry, GeometryObject, SolidGeometry};
    use himmelcad_render::{
        required_entity_proxy_slots, resolve_entity_point_world,
        tessellate_entity_strokes_with_associations, EntityCompilationOptions, FloatingOrigin,
        RenderStyle, UnresolvedHeightDisplay, WorldVec3,
    };

    use crate::CanonicalImportPackage;

    /// Provider-to-viewer evidence shared by the real format fixture tests.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct ViewerContractEvidence {
        pub(crate) direct_admissions: usize,
        pub(crate) delegated_admissions: usize,
        pub(crate) source_stroke_parts: usize,
        pub(crate) source_points: usize,
    }

    /// Proves that a validated provider package reaches the production inline
    /// Render-Core contract without reinterpreting geometry in an app adapter.
    pub(crate) fn assert_provider_package_reaches_viewer(
        package: &CanonicalImportPackage,
    ) -> ViewerContractEvidence {
        package.validate().expect("canonical provider package");
        let mut evidence = ViewerContractEvidence {
            direct_admissions: 0,
            delegated_admissions: 0,
            source_stroke_parts: 0,
            source_points: 0,
        };

        for admission in &package.admissions {
            let options = EntityCompilationOptions {
                floating_origin: FloatingOrigin::new(
                    1_024.0,
                    WorldVec3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                )
                .expect("test floating origin"),
                unresolved_height: UnresolvedHeightDisplay::ViewPlane { elevation: 0.0 },
                chord_tolerance: 0.001,
                maximum_curve_segments: 4_096,
                line_width: 1.0,
                plane_extent: 10.0,
                fill_areas: true,
                style: RenderStyle::default(),
                exaggeration_datum: 0.0,
                placement: admission.entity.placement,
            };
            let delegated = match &admission.resolved_geometry {
                GeometryObject::PointCloud { .. }
                | GeometryObject::GaussianSplatCloud { .. }
                | GeometryObject::Block { .. }
                | GeometryObject::Extension { .. } => true,
                GeometryObject::ElevationSurface { surface } => {
                    matches!(surface.as_ref(), ElevationSurfaceGeometry::Grid { .. })
                }
                GeometryObject::Solid { solid } => matches!(
                    solid.as_ref(),
                    SolidGeometry::Brep { .. } | SolidGeometry::Extension { .. }
                ),
                _ => false,
            };
            if delegated {
                evidence.delegated_admissions += 1;
                continue;
            }

            let slots = required_entity_proxy_slots(&admission.resolved_geometry, true)
                .expect("provider geometry must enter the common Render-Core proxy contract");
            assert!(
                slots > 0,
                "viewer admission must allocate a stable proxy slot"
            );
            evidence.direct_admissions += 1;

            if let GeometryObject::Point { position } = &admission.resolved_geometry {
                let world = resolve_entity_point_world(*position, &options)
                    .expect("provider point must retain exact f64 placement semantics");
                assert!(world.x.is_finite() && world.y.is_finite() && world.z.is_finite());
                evidence.source_points += 1;
            }

            let strokes = tessellate_entity_strokes_with_associations(
                &admission.resolved_geometry,
                &options,
                |entity_id, expected_version| {
                    package.admissions.iter().find_map(|candidate| {
                        if &candidate.entity.id != entity_id
                            || expected_version
                                .is_some_and(|version| version != &candidate.entity.version_hash)
                        {
                            return None;
                        }
                        match &candidate.resolved_geometry {
                            GeometryObject::Curve { curve } => Some(curve.as_ref().clone()),
                            _ => None,
                        }
                    })
                },
            )
            .expect("provider strokes must use the common f64 source tessellator");
            assert!(strokes
                .iter()
                .flat_map(|stroke| &stroke.segments)
                .all(|segment| segment.start.x.is_finite() && segment.end.x.is_finite()));
            evidence.source_stroke_parts += strokes.len();
        }

        assert!(evidence.direct_admissions > 0);
        evidence
    }
}

#[cfg(test)]
mod canonical_registry_tests {
    use super::*;

    #[test]
    fn built_in_registry_selects_real_scan_providers_by_bounded_magic() {
        let registry =
            canonical_builtin_import_registry(PathBuf::from("/cache")).expect("built-in registry");
        let las = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("survey.bin"),
                prefix: b"LASF\0\0\0\0",
                media_type: None,
            })
            .expect("LAS provider");
        assert_eq!(las.provider_id, "hcad.io.las-potree@1");

        let e57 = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("survey.bin"),
                prefix: b"ASTM-E57trailing bytes",
                media_type: None,
            })
            .expect("E57 provider");
        assert_eq!(e57.provider_id, "hcad.io.e57-potree@1");

        let dxf = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("drawing.bin"),
                prefix: b"0\nSECTION\n2\nHEADER\n",
                media_type: None,
            })
            .expect("DXF provider");
        assert_eq!(dxf.provider_id, DXF_PROVIDER_ID);
        assert!(registry.exporter(DXF_PROVIDER_ID).is_ok());

        let landxml = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("civil.data"),
                prefix: br#"<?xml version="1.0"?><LandXML version="1.2">"#,
                media_type: None,
            })
            .expect("LandXML provider");
        assert_eq!(landxml.provider_id, LANDXML_PROVIDER_ID);

        let splat = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("scene.ply"),
                prefix: b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n",
                media_type: Some("application/ply"),
            })
            .expect("Gaussian-splat PLY provider");
        assert_eq!(splat.provider_id, GAUSSIAN_SPLAT_PLY_PROVIDER_ID);
        assert!(registry.exporter(GAUSSIAN_SPLAT_PLY_PROVIDER_ID).is_ok());

        let ifc = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("bridge.ifc"),
                prefix: b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X3_ADD2'));",
                media_type: Some("application/x-step"),
            })
            .expect("IFC4.3 STEP provider");
        assert_eq!(ifc.provider_id, IFC_PROVIDER_ID);
        assert_eq!(ifc.format_id, IFC4X3_FORMAT_ID);
        assert!(registry.exporter(IFC_PROVIDER_ID).is_ok());

        let geotiff = registry
            .select_importer(ImportProbeRequest {
                path: Path::new("orthomosaic.tif"),
                prefix: b"II\x2a\x00\x08\x00\x00\x00",
                media_type: Some("image/tiff"),
            })
            .expect("GeoTIFF provider");
        assert_eq!(geotiff.provider_id, GEOTIFF_PROVIDER_ID);
    }
}
