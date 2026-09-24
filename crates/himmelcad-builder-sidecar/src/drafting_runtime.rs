//! Builder-only drafting command adaptation for the shared canonical runtime.

use himmelcad_core::release_05_admissions::MeasurementV1;
use himmelcad_document::canonical_document::CanonicalJournalEntry;
use himmelcad_domain_drafting::{
    CanonicalDrawCurveCommit, CanonicalDrawCurveSummary, CanonicalMeasurementCommit,
    CanonicalMeasurementDelete, CanonicalMeasurementSummary, CanonicalViewBookmarkCommit,
    CanonicalViewBookmarkSummary, CanonicalViewingBoxCommit, CanonicalViewingBoxDelete,
    CanonicalViewingBoxSummary, DraftingCommandError, DraftingCommandService, DrawCurveInput,
};
use himmelcad_sidecar::canonical_app_runtime::{CanonicalAppRuntime, CanonicalAppRuntimeError};

pub(crate) trait BuilderDraftingCommands {
    fn create_view_bookmark(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        state: serde_json::Value,
    ) -> Result<CanonicalViewBookmarkCommit, CanonicalAppRuntimeError>;
    fn list_view_bookmarks(
        &self,
    ) -> Result<Vec<CanonicalViewBookmarkSummary>, CanonicalAppRuntimeError>;
    fn restore_view_bookmark(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewBookmarkCommit, CanonicalAppRuntimeError>;
    fn put_viewing_box(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        expected_revision: Option<u64>,
        state: serde_json::Value,
    ) -> Result<CanonicalViewingBoxCommit, CanonicalAppRuntimeError>;
    fn list_viewing_boxes(
        &self,
    ) -> Result<Vec<CanonicalViewingBoxSummary>, CanonicalAppRuntimeError>;
    fn delete_viewing_box(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewingBoxDelete, CanonicalAppRuntimeError>;
    fn create_measurement(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        measurement: MeasurementV1,
    ) -> Result<CanonicalMeasurementCommit, CanonicalAppRuntimeError>;
    fn list_measurements(
        &self,
    ) -> Result<Vec<CanonicalMeasurementSummary>, CanonicalAppRuntimeError>;
    fn get_measurement(
        &self,
        entity_id: &str,
    ) -> Result<CanonicalMeasurementSummary, CanonicalAppRuntimeError>;
    fn delete_measurement(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalMeasurementDelete, CanonicalAppRuntimeError>;
    fn put_draw_curve(
        &mut self,
        command_id: String,
        input: DrawCurveInput,
    ) -> Result<CanonicalDrawCurveCommit, CanonicalAppRuntimeError>;
    fn list_draw_curves(&self) -> Result<Vec<CanonicalDrawCurveSummary>, CanonicalAppRuntimeError>;
    fn undo_draw_curve(
        &mut self,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError>;
    fn redo_draw_curve(
        &mut self,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError>;
}

impl BuilderDraftingCommands for CanonicalAppRuntime {
    fn create_view_bookmark(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        state: serde_json::Value,
    ) -> Result<CanonicalViewBookmarkCommit, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::create_view_bookmark(
            self, command_id, entity_id, name, state,
        ))
    }

    fn list_view_bookmarks(
        &self,
    ) -> Result<Vec<CanonicalViewBookmarkSummary>, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::list_view_bookmarks(self))
    }

    fn restore_view_bookmark(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewBookmarkCommit, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::restore_view_bookmark(
            self,
            command_id,
            entity_id,
            expected_revision,
        ))
    }

    fn put_viewing_box(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        expected_revision: Option<u64>,
        state: serde_json::Value,
    ) -> Result<CanonicalViewingBoxCommit, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::put_viewing_box(
            self,
            command_id,
            entity_id,
            name,
            expected_revision,
            state,
        ))
    }

    fn list_viewing_boxes(
        &self,
    ) -> Result<Vec<CanonicalViewingBoxSummary>, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::list_viewing_boxes(self))
    }

    fn delete_viewing_box(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalViewingBoxDelete, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::delete_viewing_box(
            self,
            command_id,
            entity_id,
            expected_revision,
        ))
    }

    fn create_measurement(
        &mut self,
        command_id: String,
        entity_id: String,
        name: String,
        measurement: MeasurementV1,
    ) -> Result<CanonicalMeasurementCommit, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::create_measurement(
            self,
            command_id,
            entity_id,
            name,
            measurement,
        ))
    }

    fn list_measurements(
        &self,
    ) -> Result<Vec<CanonicalMeasurementSummary>, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::list_measurements(self))
    }

    fn get_measurement(
        &self,
        entity_id: &str,
    ) -> Result<CanonicalMeasurementSummary, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::get_measurement(self, entity_id))
    }

    fn delete_measurement(
        &mut self,
        command_id: String,
        entity_id: String,
        expected_revision: u64,
    ) -> Result<CanonicalMeasurementDelete, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::delete_measurement(
            self,
            command_id,
            entity_id,
            expected_revision,
        ))
    }

    fn put_draw_curve(
        &mut self,
        command_id: String,
        input: DrawCurveInput,
    ) -> Result<CanonicalDrawCurveCommit, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::put_draw_curve(
            self, command_id, input,
        ))
    }

    fn list_draw_curves(&self) -> Result<Vec<CanonicalDrawCurveSummary>, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::list_draw_curves(self))
    }

    fn undo_draw_curve(
        &mut self,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::undo_draw_curve(
            self,
            command_id,
            target_command_id,
        ))
    }

    fn redo_draw_curve(
        &mut self,
        command_id: String,
        target_command_id: String,
    ) -> Result<CanonicalJournalEntry, CanonicalAppRuntimeError> {
        drafting_result(DraftingCommandService::redo_draw_curve(
            self,
            command_id,
            target_command_id,
        ))
    }
}

fn drafting_result<T>(
    result: Result<T, DraftingCommandError<CanonicalAppRuntimeError>>,
) -> Result<T, CanonicalAppRuntimeError> {
    result.map_err(|error| match error {
        DraftingCommandError::Document(error) => error,
        DraftingCommandError::InvalidResidency(message) => {
            CanonicalAppRuntimeError::InvalidResidency(message)
        }
        DraftingCommandError::Json(error) => CanonicalAppRuntimeError::SnapshotJson(error),
        DraftingCommandError::Provider(error) => CanonicalAppRuntimeError::StagedImport(error),
    })
}
