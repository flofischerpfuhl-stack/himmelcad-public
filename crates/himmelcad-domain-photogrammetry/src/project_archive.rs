//! PhotoLab validation adapter over the generic document archive.

use std::path::Path;

use crate::photolab_project::{PhotolabProjectManifest, PHOTOLAB_PROJECT_FORMAT_VERSION};
use himmelcad_document::project_archive::{
    ArchiveManifestValidator, CanonicalOrVersionedManifestValidator,
};
use himmelcad_process::jobs::CancellationToken;

use himmelcad_document::project_archive::{
    ArchiveProgress, ArchiveSummary, ProjectArchiveError, UnpackArchiveLimits,
};

#[derive(Debug, Clone, Copy, Default)]
pub struct PhotolabArchiveManifestValidator;

impl ArchiveManifestValidator for PhotolabArchiveManifestValidator {
    fn validate(&self, manifest_bytes: &[u8]) -> Result<(), ProjectArchiveError> {
        let value: serde_json::Value =
            serde_json::from_slice(manifest_bytes).map_err(ProjectArchiveError::InvalidManifest)?;
        if value.get("schemaId").and_then(serde_json::Value::as_str)
            == Some("hcad.project-manifest@1")
        {
            return CanonicalOrVersionedManifestValidator.validate(manifest_bytes);
        }
        let manifest: PhotolabProjectManifest =
            serde_json::from_value(value).map_err(ProjectArchiveError::InvalidManifest)?;
        if manifest.format_version != PHOTOLAB_PROJECT_FORMAT_VERSION {
            return Err(ProjectArchiveError::UnsupportedFormatVersion {
                found: manifest.format_version,
                supported: PHOTOLAB_PROJECT_FORMAT_VERSION,
            });
        }
        Ok(())
    }
}

pub fn unpack_hcadx<P>(
    archive_path: &Path,
    destination: &Path,
    limits: UnpackArchiveLimits,
    cancellation: &CancellationToken,
    progress: P,
) -> Result<ArchiveSummary, ProjectArchiveError>
where
    P: FnMut(ArchiveProgress),
{
    himmelcad_document::project_archive::unpack_hcadx_with_validator(
        archive_path,
        destination,
        limits,
        cancellation,
        progress,
        &PhotolabArchiveManifestValidator,
    )
}

pub fn unpack_hcadx_with_cancel<C, P>(
    archive_path: &Path,
    destination: &Path,
    limits: UnpackArchiveLimits,
    is_cancelled: C,
    progress: P,
) -> Result<ArchiveSummary, ProjectArchiveError>
where
    C: FnMut() -> bool,
    P: FnMut(ArchiveProgress),
{
    himmelcad_document::project_archive::unpack_hcadx_with_cancel_and_validator(
        archive_path,
        destination,
        limits,
        is_cancelled,
        progress,
        &PhotolabArchiveManifestValidator,
    )
}
