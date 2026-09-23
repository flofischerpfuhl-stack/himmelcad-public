//! Authoritative project model.
//!
//! Renderer mirrors this. UI must not bypass commands. See `AGENTS.md` and
//! `docs/DATA-MODEL.md` for the binding rules.

#![forbid(unsafe_code)]

pub mod app_protocol;
pub use himmelcad_document::canonical_document;
pub use himmelcad_document::canonical_json;
pub use himmelcad_model::canonical_resource_catalog;
pub use himmelcad_model::canonical_resources;
pub mod contract;
pub use himmelcad_document::entity_commands;
pub use himmelcad_model::entity;
pub use himmelcad_model::entity_model;
pub use himmelcad_model::entity_validation;
pub use himmelcad_model::geometry_representation_registry;
pub use himmelcad_model::hash;
pub mod mesh_surface;
pub mod photolab;
pub mod photolab_batch;
pub mod photolab_capture;
pub mod photolab_crs;
pub mod photolab_gcp;
pub mod photolab_gcp_local_estimate;
pub mod photolab_gcp_optimization;
pub mod photolab_images;
pub mod photolab_jobs;
pub mod photolab_masks;
pub mod photolab_matching;
pub mod photolab_models;
pub mod photolab_products;
pub mod photolab_project;
pub mod photolab_recipe;
pub mod product_import_package;
pub use himmelcad_document::project;
pub mod property_schema;
pub mod registration;
pub mod release_05_admissions;
pub use himmelcad_model::typed_artifact;
pub use himmelcad_transform::transform;
pub use himmelcad_transform::transform_geometry;
