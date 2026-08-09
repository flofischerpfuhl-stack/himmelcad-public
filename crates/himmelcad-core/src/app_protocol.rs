//! Versioned, language-neutral application control-plane contracts.
//!
//! The protocol transports canonical snapshots, exact CAS transactions and
//! schema-aware property operations. Product UIs and automation clients use the
//! same messages; neither receives a privileged mutation path.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::canonical_document::{
    CanonicalCommandTransaction, CanonicalDocument, CanonicalEntityTombstone, CanonicalJournalEntry,
};
use crate::entity_model::CanonicalEntity;
use crate::property_schema::{
    MultiEntityPropertyEditRequest, PropertyNamespaceSchema, PropertyQueryRequest,
    PropertyQueryResult,
};

/// Exact wire schema implemented by this core revision.
pub const APP_PROTOCOL_SCHEMA_ID: &str = "hcad.app-protocol@1";
/// Maximum journal entries returned in one control-plane response.
pub const APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE: u32 = 4_096;

/// Explicit extension map for independently versioned vendor or domain payloads.
///
/// Keys are namespaced schema identifiers. Values are relayed opaquely by core
/// versions that do not understand the namespace.
pub type AppProtocolExtensions = BTreeMap<String, serde_json::Value>;

/// One client request with correlation identity and lossless extensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppProtocolRequestEnvelope {
    /// Exact protocol revision.
    pub schema_id: String,
    /// Client-generated correlation identity.
    pub request_id: String,
    /// Typed operation available equally to UI and automation clients.
    pub request: AppProtocolRequest,
    /// Opaque independently versioned payloads preserved across relays.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: AppProtocolExtensions,
}

/// Operations on the shared application control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum AppProtocolRequest {
    /// Reads one internally consistent canonical document snapshot.
    ReadDocumentSnapshot,
    /// Reads a bounded durable-journal page after one accepted sequence.
    ReadJournal(AppJournalReadRequest),
    /// Reads advertised property schemas.
    ReadPropertySchemas,
    /// Projects properties across exact selected entity revisions.
    QueryProperties(PropertyQueryRequest),
    /// Compiles a schema-aware edit without committing it.
    CompilePropertyEdit(MultiEntityPropertyEditRequest),
    /// Commits one exact CAS-protected canonical transaction.
    ExecuteCanonicalTransaction(CanonicalCommandTransaction),
}

/// One correlated server response with lossless extensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppProtocolResponseEnvelope {
    /// Exact protocol revision.
    pub schema_id: String,
    /// Correlation identity copied from the request.
    pub request_id: String,
    /// Typed result or structured failure.
    pub response: AppProtocolResponse,
    /// Opaque independently versioned payloads preserved across relays.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: AppProtocolExtensions,
}

/// Results produced by the shared application control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum AppProtocolResponse {
    /// Complete canonical mirror bootstrap state.
    DocumentSnapshot(AppDocumentSnapshot),
    /// Bounded durable canonical journal page.
    JournalPage(AppJournalPage),
    /// Property schemas understood by this core revision.
    PropertySchemas(Vec<PropertyNamespaceSchema>),
    /// Shared/mixed/unavailable property projection.
    PropertyQuery(PropertyQueryResult),
    /// One validated but not yet committed canonical transaction.
    CompiledTransaction(CanonicalCommandTransaction),
    /// Journal entry proving an accepted canonical mutation.
    TransactionAccepted(CanonicalJournalEntry),
    /// Stable machine-readable request failure.
    Error(AppProtocolError),
}

/// Complete point-in-time canonical state used to initialize a mirror.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppDocumentSnapshot {
    /// Monotone document generation represented by every field below.
    pub generation: u64,
    /// Current live entities in stable identity order.
    pub entities: Vec<CanonicalEntity>,
    /// Current immutable tombstones in stable identity order.
    pub tombstones: Vec<CanonicalEntityTombstone>,
    /// Highest durable journal sequence included in this document generation.
    pub journal_head_sequence: u64,
}

impl AppDocumentSnapshot {
    /// Clones one internally consistent snapshot from the authoritative document.
    #[must_use]
    pub fn from_document(document: &CanonicalDocument) -> Self {
        Self {
            generation: document.generation(),
            entities: document.entities().cloned().collect(),
            tombstones: document.tombstones().cloned().collect(),
            journal_head_sequence: document.journal().last().map_or(0, |entry| entry.sequence),
        }
    }
}

/// Bounded request for durable journal entries after one sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppJournalReadRequest {
    /// Last sequence already held by the client; zero starts at the first entry.
    pub after_sequence: u64,
    /// Positive page size bounded by [`APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE`].
    pub limit: u32,
}

/// Bounded append-only journal page for mirror catch-up and audit clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppJournalPage {
    /// Sequence immediately preceding the first requested entry.
    pub after_sequence: u64,
    /// Entries in strict acceptance order.
    pub entries: Vec<CanonicalJournalEntry>,
    /// Highest sequence durable when this page was read.
    pub journal_head_sequence: u64,
    /// Whether another non-empty page exists after `entries`.
    pub has_more: bool,
}

/// Reads a bounded journal page without copying the complete history.
pub fn read_journal_page(
    document: &CanonicalDocument,
    request: AppJournalReadRequest,
) -> Result<AppJournalPage, AppJournalReadError> {
    if request.limit == 0 || request.limit > APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE {
        return Err(AppJournalReadError::InvalidLimit);
    }
    let head = document.journal().last().map_or(0, |entry| entry.sequence);
    if request.after_sequence > head {
        return Err(AppJournalReadError::SequenceAheadOfJournal);
    }
    let limit = usize::try_from(request.limit).map_err(|_| AppJournalReadError::InvalidLimit)?;
    let start = document
        .journal()
        .partition_point(|entry| entry.sequence <= request.after_sequence);
    let end = start.saturating_add(limit).min(document.journal().len());
    let entries = document.journal()[start..end].to_vec();
    let last_returned = entries
        .last()
        .map_or(request.after_sequence, |entry| entry.sequence);
    Ok(AppJournalPage {
        after_sequence: request.after_sequence,
        entries,
        journal_head_sequence: head,
        has_more: last_returned < head,
    })
}

/// Failure to read one bounded durable-journal page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AppJournalReadError {
    /// Page size is zero or exceeds the protocol maximum.
    #[error("application journal page limit is invalid")]
    InvalidLimit,
    /// The cursor points beyond the current durable journal head.
    #[error("application journal cursor is ahead of the durable journal")]
    SequenceAheadOfJournal,
}

/// Structured language-neutral protocol failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppProtocolError {
    /// Stable namespaced error code.
    pub code: String,
    /// Human-readable diagnostic suitable for logs.
    pub message: String,
    /// Optional structured context that does not alter error semantics.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, serde_json::Value>,
}

/// Validates the common envelope fields before dispatch.
pub fn validate_request_envelope(
    envelope: &AppProtocolRequestEnvelope,
) -> Result<(), AppProtocolEnvelopeError> {
    if envelope.schema_id != APP_PROTOCOL_SCHEMA_ID {
        return Err(AppProtocolEnvelopeError::UnsupportedSchema);
    }
    if envelope.request_id.trim().is_empty() || envelope.request_id.contains('\0') {
        return Err(AppProtocolEnvelopeError::InvalidRequestId);
    }
    Ok(())
}

/// Failure to admit an application protocol envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AppProtocolEnvelopeError {
    /// The client requested another protocol revision.
    #[error("application protocol schema is unsupported")]
    UnsupportedSchema,
    /// Correlation identity is empty or contains a null character.
    #[error("application protocol request id is invalid")]
    InvalidRequestId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_extension_namespaces_round_trip_losslessly() {
        let envelope = AppProtocolRequestEnvelope {
            schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
            request_id: "request-42".to_owned(),
            request: AppProtocolRequest::ReadPropertySchemas,
            extensions: BTreeMap::from([(
                "vendor.survey.request@7".to_owned(),
                json!({
                    "nested": [1, {"futureField": true}],
                    "nullValue": null
                }),
            )]),
        };

        let bytes = serde_json::to_vec(&envelope).expect("serialize envelope");
        let decoded: AppProtocolRequestEnvelope =
            serde_json::from_slice(&bytes).expect("deserialize envelope");

        assert_eq!(decoded, envelope);
        validate_request_envelope(&decoded).expect("valid envelope");
    }

    #[test]
    fn protocol_revision_and_request_identity_are_admission_gates() {
        let mut envelope = AppProtocolRequestEnvelope {
            schema_id: "hcad.app-protocol@2".to_owned(),
            request_id: "request".to_owned(),
            request: AppProtocolRequest::ReadDocumentSnapshot,
            extensions: BTreeMap::new(),
        };
        assert_eq!(
            validate_request_envelope(&envelope),
            Err(AppProtocolEnvelopeError::UnsupportedSchema)
        );
        envelope.schema_id = APP_PROTOCOL_SCHEMA_ID.to_owned();
        envelope.request_id = String::new();
        assert_eq!(
            validate_request_envelope(&envelope),
            Err(AppProtocolEnvelopeError::InvalidRequestId)
        );
    }

    #[test]
    fn journal_reads_are_bounded_and_reject_cursors_ahead_of_the_head() {
        let document = CanonicalDocument::default();
        let page = read_journal_page(
            &document,
            AppJournalReadRequest {
                after_sequence: 0,
                limit: 32,
            },
        )
        .expect("empty journal page");
        assert!(page.entries.is_empty());
        assert_eq!(page.journal_head_sequence, 0);
        assert!(!page.has_more);

        assert_eq!(
            read_journal_page(
                &document,
                AppJournalReadRequest {
                    after_sequence: 0,
                    limit: 0,
                },
            ),
            Err(AppJournalReadError::InvalidLimit)
        );
        assert_eq!(
            read_journal_page(
                &document,
                AppJournalReadRequest {
                    after_sequence: 1,
                    limit: 1,
                },
            ),
            Err(AppJournalReadError::SequenceAheadOfJournal)
        );
    }
}
