//! Importers/exporters for Himmelcad.
//!
//! Phase 1: LAS/LAZ via a permissively licensed crate. Phase 2+: DXF, IFC,
//! E57, etc. Each format lives in its own module and registers an Importer
//! through the trait below.

#![forbid(unsafe_code)]

use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("unsupported format: {0}")]
    Unsupported(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
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
