//! Canonical DWG import through the pinned MPL-2.0 acadrust fork.
//!
//! acadrust remains an isolated parser/model component. HimmelCAD owns the
//! bounded probe, resource limits, loss acceptance and canonical admission.
//! The decoded document is serialized to a private ASCII DXF staging file and
//! enters the existing DXF canonicalizer; this deliberately avoids a second
//! CAD entity model, store or renderer.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use acadrust::entities::EntityType;
use acadrust::io::{DwgReader, DxfWriter};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::canonical_provider::{
    CanonicalImportPackage, CanonicalImportProvider, CanonicalImportRequest, CanonicalJsonObject,
    FormatCapability, FormatProviderDescriptor, ImportProbe, ImportProbeRequest,
    ProviderContractError, ProviderOperationContext, ProviderOptionContract, ProviderProgress,
    StagedArtifactRoots, CANONICAL_IO_SCHEMA_VERSION,
};
use crate::dxf_provider::{DxfCanonicalProvider, DXF_FORMAT_ID};

/// Stable provider identity for the pinned fork boundary.
pub const DWG_PROVIDER_ID: &str = "hcad.io.acadrust-dwg@1";
/// Initial corpus-gated DWG revision family.
pub const DWG_FORMAT_ID: &str = "dwg@r13-r2018-acadrust-0.4.1";
/// Source contained an entity acadrust could not type.
pub const LOSS_UNKNOWN_ENTITY: &str = "hcad.loss.dwg.unknown-entity@1";
/// acadrust reported a not-implemented or not-supported record.
pub const LOSS_PARSER_DIAGNOSTIC: &str = "hcad.loss.dwg.parser-diagnostic@1";

const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTITY_COUNT: usize = 2_000_000;
const MAX_NOTIFICATION_COUNT: usize = 10_000;
const MAX_INTERMEDIATE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const SUPPORTED_SIGNATURES: [&[u8; 6]; 8] = [
    b"AC1012", b"AC1014", b"AC1015", b"AC1018", b"AC1021", b"AC1024", b"AC1027", b"AC1032",
];

/// Import-only provider. DWG export remains unadvertised until independent
/// application corpus gates prove the acadrust writer's fidelity.
pub struct DwgCanonicalProvider {
    descriptor: FormatProviderDescriptor,
    staging_root: PathBuf,
}

impl DwgCanonicalProvider {
    #[must_use]
    pub fn new(staging_root: PathBuf) -> Self {
        Self {
            descriptor: FormatProviderDescriptor {
                schema_version: CANONICAL_IO_SCHEMA_VERSION,
                provider_id: DWG_PROVIDER_ID.to_owned(),
                provider_version: format!("{}+acadrust-0.4.1", env!("CARGO_PKG_VERSION")),
                display_name: "DWG (vendored acadrust)".to_owned(),
                format_ids: vec![DWG_FORMAT_ID.to_owned()],
                extensions: vec!["dwg".to_owned()],
                media_types: vec!["image/vnd.dwg".to_owned(), "application/acad".to_owned()],
                capabilities: vec![FormatCapability::Import],
                import_options: Some(import_options()),
                export_options: None,
            },
            staging_root,
        }
    }
}

impl Default for DwgCanonicalProvider {
    fn default() -> Self {
        Self::new(std::env::temp_dir().join("himmelcad-dwg-provider"))
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct DwgImportOptions {
    accepted_loss_codes: BTreeSet<String>,
}

impl CanonicalImportProvider for DwgCanonicalProvider {
    fn descriptor(&self) -> &FormatProviderDescriptor {
        &self.descriptor
    }

    fn probe(
        &self,
        request: ImportProbeRequest<'_>,
    ) -> Result<Option<ImportProbe>, ProviderContractError> {
        let signature = request.prefix.get(..6);
        if !SUPPORTED_SIGNATURES
            .iter()
            .any(|supported| signature == Some(supported.as_slice()))
        {
            return Ok(None);
        }
        Ok(Some(ImportProbe {
            format_id: DWG_FORMAT_ID.to_owned(),
            confidence: 100,
        }))
    }

    fn import(
        &self,
        request: CanonicalImportRequest<'_>,
        context: &mut dyn ProviderOperationContext,
    ) -> Result<CanonicalImportPackage, ProviderContractError> {
        if request.format_id != DWG_FORMAT_ID {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        let options: DwgImportOptions =
            serde_json::from_value(request.options.clone()).map_err(provider_error)?;
        check_cancelled(context)?;
        let metadata = fs::metadata(request.source).map_err(provider_error)?;
        if !metadata.is_file() || metadata.len() < 6 || metadata.len() > MAX_SOURCE_BYTES {
            return Err(provider_message(format!(
                "DWG source must be 6..={MAX_SOURCE_BYTES} bytes"
            )));
        }
        context.report_progress(ProviderProgress {
            phase: "scan".to_owned(),
            completed: 0,
            total: Some(metadata.len()),
            message: "DWG source is bounded and hashed".to_owned(),
        });
        let source_hash = hash_source(request.source, metadata.len(), context)?;
        let signature = read_signature(request.source)?;
        if !SUPPORTED_SIGNATURES
            .iter()
            .any(|supported| signature.as_slice() == supported.as_slice())
        {
            return Err(ProviderContractError::UnsupportedFormat);
        }
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "decode".to_owned(),
            completed: 0,
            total: Some(1),
            message: "Pinned acadrust parses DWG in strict mode".to_owned(),
        });
        let document = catch_unwind(AssertUnwindSafe(|| {
            let mut reader = DwgReader::from_file(request.source).map_err(provider_error)?;
            reader.read().map_err(provider_error)
        }))
        .map_err(|_| provider_message("acadrust panicked while parsing bounded DWG input"))??;
        check_cancelled(context)?;
        let entity_count = document.entity_count();
        if entity_count == 0 || entity_count > MAX_ENTITY_COUNT {
            return Err(provider_message(format!(
                "DWG entity count must be 1..={MAX_ENTITY_COUNT}"
            )));
        }
        if document.notifications.len() > MAX_NOTIFICATION_COUNT {
            return Err(provider_message(format!(
                "DWG diagnostics exceed {MAX_NOTIFICATION_COUNT} entries"
            )));
        }
        let mut required_losses = BTreeSet::new();
        if document
            .entities()
            .any(|entity| matches!(entity, EntityType::Unknown(_)))
        {
            required_losses.insert(LOSS_UNKNOWN_ENTITY.to_owned());
        }
        if document.notifications.iter().any(|notification| {
            matches!(
                notification.notification_type,
                acadrust::notification::NotificationType::NotImplemented
                    | acadrust::notification::NotificationType::NotSupported
            )
        }) {
            required_losses.insert(LOSS_PARSER_DIAGNOSTIC.to_owned());
        }
        reject_unaccepted_losses(&required_losses, &options.accepted_loss_codes)?;

        let work = WorkDirectory::create(&self.staging_root, &source_hash)?;
        let dxf_path = work.path.join("decoded.dxf");
        catch_unwind(AssertUnwindSafe(|| {
            DxfWriter::new(&document)
                .write_to_file(&dxf_path)
                .map_err(provider_error)
        }))
        .map_err(|_| provider_message("acadrust panicked while staging decoded DWG as DXF"))??;
        let intermediate_size = fs::metadata(&dxf_path).map_err(provider_error)?.len();
        if intermediate_size == 0 || intermediate_size > MAX_INTERMEDIATE_BYTES {
            return Err(provider_message(format!(
                "decoded DWG intermediate exceeds {MAX_INTERMEDIATE_BYTES} bytes"
            )));
        }
        check_cancelled(context)?;
        context.report_progress(ProviderProgress {
            phase: "canonicalize".to_owned(),
            completed: 0,
            total: Some(entity_count as u64),
            message: "Decoded CAD entities enter the shared canonical DXF mapper".to_owned(),
        });
        let dxf_provider =
            DxfCanonicalProvider::new(self.staging_root.join("canonical-dwg-resources"));
        let mut package = dxf_provider.import(
            CanonicalImportRequest {
                source: &dxf_path,
                format_id: DXF_FORMAT_ID,
                options: &serde_json::json!({"acceptedLossCodes": []}),
            },
            context,
        )?;
        package.provider_id = DWG_PROVIDER_ID.to_owned();
        package.provider_version = self.descriptor.provider_version.clone();
        let provenance = CanonicalJsonObject::new(
            "application/vnd.himmelcad.dwg-import-provenance+json",
            serde_json::json!({
                "schemaId": "hcad.provenance.dwg-import@1",
                "sourceSha256": source_hash,
                "sourceByteLength": metadata.len(),
                "sourceSignature": String::from_utf8_lossy(&signature),
                "acadrustVersion": "0.4.1",
                "providerVersion": self.descriptor.provider_version,
                "entityCount": entity_count,
                "intermediateDxfByteLength": intermediate_size,
                "acceptedLossCodes": required_losses,
                "diagnostics": document.notifications.iter().map(|notification| serde_json::json!({
                    "kind": notification.notification_type.to_string(),
                    "message": notification.message,
                })).collect::<Vec<_>>(),
            }),
        )?;
        package.objects.push(provenance);
        package
            .objects
            .sort_by(|left, right| left.object_hash.0.cmp(&right.object_hash.0));
        package.validate()?;
        context.report_progress(ProviderProgress {
            phase: "admit".to_owned(),
            completed: package.admissions.len() as u64,
            total: Some(package.admissions.len() as u64),
            message: "Canonical DWG import package validated".to_owned(),
        });
        Ok(package)
    }

    fn staged_artifact_roots(
        &self,
        package: &CanonicalImportPackage,
    ) -> Result<StagedArtifactRoots, ProviderContractError> {
        if !package.datasets.is_empty() {
            Err(ProviderContractError::InvalidArtifactRoots)
        } else {
            Ok(StagedArtifactRoots {
                dataset_roots: Default::default(),
                resource_set_roots: package
                    .resource_sets
                    .iter()
                    .map(|set| {
                        (
                            set.resource_set_id.clone(),
                            self.staging_root.join("canonical-dwg-resources"),
                        )
                    })
                    .collect(),
            })
        }
    }
}

fn import_options() -> ProviderOptionContract {
    ProviderOptionContract::object(
        serde_json::json!({
            "acceptedLossCodes": {"type": "array", "items": {"type": "string"}, "uniqueItems": true}
        }),
        serde_json::json!({"acceptedLossCodes": []}),
    )
}

fn read_signature(path: &Path) -> Result<[u8; 6], ProviderContractError> {
    let mut signature = [0_u8; 6];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .map_err(provider_error)?;
    Ok(signature)
}

fn hash_source(
    path: &Path,
    total: u64,
    context: &mut dyn ProviderOperationContext,
) -> Result<String, ProviderContractError> {
    let mut reader = BufReader::new(File::open(path).map_err(provider_error)?);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut completed = 0_u64;
    loop {
        check_cancelled(context)?;
        let read = reader.read(&mut buffer).map_err(provider_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        completed += read as u64;
        context.report_progress(ProviderProgress {
            phase: "scan".to_owned(),
            completed,
            total: Some(total),
            message: "DWG source is bounded and hashed".to_owned(),
        });
    }
    Ok(hex::encode(digest.finalize()))
}

fn reject_unaccepted_losses(
    required: &BTreeSet<String>,
    accepted: &BTreeSet<String>,
) -> Result<(), ProviderContractError> {
    let missing = required.difference(accepted).cloned().collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(provider_message(format!(
            "DWG import requires explicit acceptance of semantic losses: {}",
            missing.join(", ")
        )))
    }
}

fn check_cancelled(context: &dyn ProviderOperationContext) -> Result<(), ProviderContractError> {
    if context.is_cancelled() {
        Err(ProviderContractError::Cancelled)
    } else {
        Ok(())
    }
}

fn provider_error(error: impl std::fmt::Display) -> ProviderContractError {
    ProviderContractError::Provider(error.to_string())
}

fn provider_message(message: impl Into<String>) -> ProviderContractError {
    ProviderContractError::Provider(message.into())
}

struct WorkDirectory {
    path: PathBuf,
}

impl WorkDirectory {
    fn create(root: &Path, source_hash: &str) -> Result<Self, ProviderContractError> {
        fs::create_dir_all(root).map_err(provider_error)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(provider_error)?
            .as_nanos();
        let path = root.join(format!(
            ".dwg-{}-{}-{nonce}",
            &source_hash[..16],
            std::process::id()
        ));
        fs::create_dir(&path).map_err(provider_error)?;
        Ok(Self { path })
    }
}

impl Drop for WorkDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.path) {
            tracing::warn!(path = %self.path.display(), %error, "failed to remove DWG staging directory");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use acadrust::document::CadDocument;
    use acadrust::entities::{EntityType, Line};
    use acadrust::io::DwgWriter;
    use acadrust::types::{DxfVersion, Vector3};

    use crate::canonical_provider::ProviderOperationContext;
    use crate::viewer_contract_test_support::assert_provider_package_reaches_viewer;

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

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("hcad-dwg-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).expect("test root");
        root
    }

    fn write_line_dwg(path: &Path, version: DxfVersion) {
        let mut document = CadDocument::with_version(version);
        document
            .add_entity(EntityType::Line(Line::from_points(
                Vector3::new(1.0, 2.0, 3.0),
                Vector3::new(4.0, 6.0, 3.0),
            )))
            .expect("line");
        DwgWriter::write_to_file(path, &document).expect("DWG fixture");
    }

    #[test]
    fn bounded_probe_requires_a_supported_dwg_signature() {
        let provider = DwgCanonicalProvider::default();
        let matched = provider
            .probe(ImportProbeRequest {
                path: Path::new("drawing.bin"),
                prefix: b"AC1032more",
                media_type: None,
            })
            .expect("probe")
            .expect("match");
        assert_eq!(matched.confidence, 100);
        assert!(provider
            .probe(ImportProbeRequest {
                path: Path::new("fake.dwg"),
                prefix: b"not-a-dwg",
                media_type: Some("image/vnd.dwg"),
            })
            .expect("probe")
            .is_none());
    }

    #[test]
    fn corpus_supported_revisions_reach_the_common_canonical_viewer_path() {
        let root = temp_root("viewer");
        let provider = DwgCanonicalProvider::new(root.join("staging"));
        for version in [
            DxfVersion::AC1012,
            DxfVersion::AC1014,
            DxfVersion::AC1015,
            DxfVersion::AC1018,
            DxfVersion::AC1021,
            DxfVersion::AC1024,
            DxfVersion::AC1027,
            DxfVersion::AC1032,
        ] {
            let source = root.join(format!("line-{}.dwg", version.as_str()));
            write_line_dwg(&source, version);
            let mut context = TestContext::default();
            let package = provider
                .import(
                    CanonicalImportRequest {
                        source: &source,
                        format_id: DWG_FORMAT_ID,
                        options: &serde_json::json!({"acceptedLossCodes": []}),
                    },
                    &mut context,
                )
                .unwrap_or_else(|error| {
                    panic!("canonical {} DWG import: {error}", version.as_str())
                });
            assert_eq!(package.provider_id, DWG_PROVIDER_ID);
            assert_provider_package_reaches_viewer(&package);
            assert!(context.progress.iter().any(|value| value.phase == "decode"));
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn malformed_and_cancelled_sources_fail_without_publication() {
        let root = temp_root("malformed");
        let malformed = root.join("malformed.dwg");
        fs::write(&malformed, b"AC1015truncated").expect("fixture");
        let provider = DwgCanonicalProvider::new(root.join("staging"));
        let mut context = TestContext::default();
        assert!(provider
            .import(
                CanonicalImportRequest {
                    source: &malformed,
                    format_id: DWG_FORMAT_ID,
                    options: &serde_json::json!({"acceptedLossCodes": []}),
                },
                &mut context,
            )
            .is_err());
        let mut cancelled = TestContext {
            cancelled: true,
            progress: Vec::new(),
        };
        assert_eq!(
            provider.import(
                CanonicalImportRequest {
                    source: &malformed,
                    format_id: DWG_FORMAT_ID,
                    options: &serde_json::json!({"acceptedLossCodes": []}),
                },
                &mut cancelled,
            ),
            Err(ProviderContractError::Cancelled)
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
