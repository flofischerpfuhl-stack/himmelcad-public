//! Compatibility exports and canonical document adapter for the surface domain.

use std::io::Read;

use anyhow::Result;
use himmelcad_document::domain_commands::{
    SurfaceDocumentCommands, SurfaceDocumentCommit, SurfacePointCloudSampleRequest,
};
use himmelcad_domain_pointcloud::pointcloud_ground::GroundScope;
use himmelcad_domain_pointcloud::pointcloud_sampling::read_surface_points;
use himmelcad_domain_surface::mesh_surface::SurfacePoint;
use himmelcad_domain_surface::mesh_surface_runtime::{
    SurfaceAdmissionSnapshot as DomainAdmissionSnapshot,
    SurfaceDocumentSnapshot as DomainDocumentSnapshot,
    SurfaceDrawCurveSnapshot as DomainDrawCurveSnapshot,
};
use himmelcad_io::CanonicalStagedImport;
use himmelcad_model::entity::EntityId;
use himmelcad_model::hash::ObjectHash;
use himmelcad_process::jobs::CancellationToken;

use crate::drafting_runtime::BuilderDraftingCommands;
use himmelcad_sidecar::canonical_app_runtime::CanonicalAppRuntime;

pub(crate) struct SurfaceRuntimeAdapter<'a>(&'a mut CanonicalAppRuntime);

impl<'a> SurfaceRuntimeAdapter<'a> {
    pub(crate) fn new(runtime: &'a mut CanonicalAppRuntime) -> Self {
        Self(runtime)
    }
}

impl SurfaceDocumentCommands for SurfaceRuntimeAdapter<'_> {
    type Snapshot = DomainDocumentSnapshot;
    type StagedImport = CanonicalStagedImport;

    fn surface_snapshot(&self) -> Result<Self::Snapshot> {
        let entries = self
            .0
            .residency_bootstrap()?
            .entries
            .into_iter()
            .map(|entry| DomainAdmissionSnapshot {
                admission: entry.admission,
                dataset: entry.dataset,
            })
            .collect();
        let draw_curves = self
            .0
            .list_draw_curves()?
            .into_iter()
            .map(|curve| DomainDrawCurveSnapshot {
                entity_id: curve.entity_id,
                revision: curve.revision,
                name: curve.name,
                closed: curve.closed,
                vertices: curve.vertices,
                admission: curve.admission,
            })
            .collect();
        Ok(DomainDocumentSnapshot {
            entries,
            draw_curves,
        })
    }

    fn surface_project_root(&self) -> Result<std::path::PathBuf> {
        Ok(self.0.project_root()?)
    }

    fn surface_sample_point_cloud(
        &self,
        request: SurfacePointCloudSampleRequest,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SurfacePoint>> {
        let captured = self
            .0
            .prepare_ground_source(request.source, request.input_root)?;
        let mut scope = GroundScope::default();
        scope.placement = request.placement;
        if !request.visible_classes.is_empty() {
            scope.visible_classes = request.visible_classes;
        }
        Ok(read_surface_points(
            &captured.input_root.join("metadata.json"),
            &captured.input_root.join("hierarchy.bin"),
            &captured.input_root.join("octree.bin"),
            &request.source_id,
            request.spacing,
            &scope,
            cancellation,
            |_| {},
        )?)
    }

    fn surface_height_grid_bytes(&self, entity_id: &EntityId) -> Result<Vec<u8>> {
        let mut source = self.0.height_grid_artifact_source(entity_id)?.source;
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    fn surface_object_bytes(&self, object_hash: &ObjectHash) -> Result<Vec<u8>> {
        let mut source = self.0.automation_object_source(object_hash)?.source;
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    fn surface_publish_staged_import(
        &mut self,
        staged: &Self::StagedImport,
        command_id: &str,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<SurfaceDocumentCommit> {
        let commit = self.0.publish_staged_import_with_progress_and_cancel(
            staged,
            command_id,
            &mut |_| {},
            is_cancelled,
        )?;
        Ok(SurfaceDocumentCommit {
            journal_entry: commit.journal_entry,
            admission_count: commit.inventory.admissions.len(),
        })
    }
}

pub use himmelcad_domain_surface::mesh_surface_runtime::*;
