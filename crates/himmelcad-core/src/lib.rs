//! Authoritative project model.
//!
//! Renderer mirrors this. UI must not bypass commands. See `AGENTS.md` and
//! `docs/DATA-MODEL.md` for the binding rules.

#![forbid(unsafe_code)]

pub mod canonical_document;
pub mod canonical_resource_catalog;
pub mod canonical_resources;
pub mod contract;
pub mod entity;
pub mod entity_commands;
pub mod entity_model;
pub mod entity_validation;
pub mod geometry_representation_registry;
pub mod hash;
pub mod photolab;
pub mod photolab_batch;
pub mod photolab_crs;
pub mod photolab_gcp;
pub mod photolab_gcp_optimization;
pub mod photolab_images;
pub mod photolab_jobs;
pub mod photolab_masks;
pub mod photolab_matching;
pub mod photolab_models;
pub mod photolab_products;
pub mod photolab_project;
pub mod project;
pub mod transform;
