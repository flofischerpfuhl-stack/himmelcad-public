//! Placeholder IFC provider module (WIP).
//!
//! Kept so the crate compiles while the STEP-backed IFC importer is completed elsewhere.

#![allow(dead_code)]

/// Marker that IFC import is not yet wired through this module.
#[derive(Debug, Clone, Copy, Default)]
pub struct IfcProviderStub;
