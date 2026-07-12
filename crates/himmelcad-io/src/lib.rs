//! Importers/exporters for HimmelCAD.
//!
//! Phase 1: LAS/LAZ. Phase 2+: DXF, IFC, E57, etc. Each format lives in its
//! own module and registers an Importer through the trait below.

#![forbid(unsafe_code)]

use std::path::Path;

use thiserror::Error;

pub mod gcp_import;
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

pub use gcp_import::{
    import_gcp_csv_file, import_gcp_csv_file_with_cancel, preview_gcp_csv_file, GcpCsvImportResult,
    GcpCsvPreview, GcpCsvPreviewRow, GcpCsvRowError,
};
pub use las_import::{
    import_las_file, import_las_file_with_progress, ConverterProgress, LasImportSummary,
};
pub use photolab_image_import::{
    discover_photo_files, import_photo_files, PhotoDiscovery, PhotoImportCandidate,
};
