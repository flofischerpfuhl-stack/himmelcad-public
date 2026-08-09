//! Bounded, path-free automation query and bulk-data runtime.
//!
//! This module implements only the additional methods frozen by the
//! automation schema. Canonical commits continue to use `app.protocol` and
//! `executeCanonicalTransaction` in `CanonicalAppRuntime`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use himmelcad_core::canonical_document::{CanonicalCommandTransaction, EntityVersionRef};
use himmelcad_core::entity_model::CanonicalEntity;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::typed_artifact::{
    ArtifactElementType, ArtifactEndianness, TypedArtifactLayout,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::canonical_app_runtime::{AutomationObjectSource, CanonicalAppRuntime};

pub const MAX_PAGE_ITEMS: usize = 1_000;
pub const MAX_PAGE_BYTES: usize = 1_048_576;
pub const MAX_BULK_RANGE_BYTES: u64 = 8 * 1_024 * 1_024;
pub const MAX_SHAPE_RANK: usize = 8;
pub const MAX_SHAPE_ELEMENTS: u64 = 2_000_000_000;
const LEASE_LIFETIME: Duration = Duration::from_secs(5 * 60);
const CURSOR_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bounds3d {
    pub minimum: [f64; 3],
    pub maximum: [f64; 3],
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityFilter {
    #[serde(default)]
    pub type_ids: Vec<String>,
    #[serde(default)]
    pub owner_ids: Vec<String>,
    #[serde(default)]
    pub bounds: Option<Bounds3d>,
    #[serde(default)]
    pub include_descendants: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityPageRequest {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub generation: Option<u64>,
    pub limit: usize,
    pub byte_limit: usize,
    #[serde(default)]
    pub filter: Option<EntityFilter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityEnvelope {
    pub id: String,
    pub revision: u64,
    pub version_hash: String,
    pub type_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    pub layer_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds3d>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityPage {
    pub generation: u64,
    pub items: Vec<EntityEnvelope>,
    pub returned_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasDescribeRequest {
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasDescription {
    pub content_hash: String,
    pub media_type: String,
    pub byte_length: u64,
    pub logical_shape: Value,
    pub lease: BulkLeaseDescriptor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandValidateRequest {
    pub transaction: CanonicalCommandTransaction,
    pub accepted_loss_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanIssue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub details: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandValidationPlan {
    pub command_id: String,
    pub valid: bool,
    pub requires_confirmation: bool,
    pub losses: Vec<PlanIssue>,
    pub conflicts: Vec<PlanIssue>,
    pub plan_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandStatusRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandState {
    Queued,
    Running,
    Cancelling,
    Cancelled,
    Failed,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandStatus {
    pub operation_id: String,
    pub state: CommandState,
    pub completed: u64,
    pub total: u64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandCancelResult {
    pub operation_id: String,
    pub cancellation_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkLeaseDescriptor {
    pub lease_id: String,
    pub access_token: String,
    pub content_hash: String,
    pub media_type: String,
    pub element_type: String,
    pub shape: Vec<u64>,
    pub endianness: String,
    pub byte_length: u64,
    pub expires_at: String,
    pub max_readable_range: u64,
    pub remaining_read_budget: u64,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entity: Option<EntityVersionRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkReadRequest {
    pub lease_id: String,
    pub access_token: String,
    pub offset: u64,
    pub length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkReadResult {
    pub lease_id: String,
    pub offset: u64,
    pub byte_length: u64,
    pub encoding: String,
    pub data: String,
    pub remaining_read_budget: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkReleaseRequest {
    pub lease_id: String,
    pub access_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkReleaseResult {
    pub lease_id: String,
    pub released: bool,
}

#[derive(Debug, Error)]
pub enum AutomationRuntimeError {
    #[error("invalidRequest: {0}")]
    InvalidRequest(String),
    #[error("invalidCursor: cursor is unknown or revoked")]
    InvalidCursor,
    #[error("generationChanged: requested generation {requested}, current generation {current}")]
    GenerationChanged { requested: u64, current: u64 },
    #[error("pageLimitExceeded: item limit exceeds {MAX_PAGE_ITEMS}")]
    PageLimitExceeded,
    #[error("byteLimitExceeded: byte limit exceeds {MAX_PAGE_BYTES} or cannot fit one item")]
    ByteLimitExceeded,
    #[error("operationNotFound: unknown operation")]
    OperationNotFound,
    #[error("leaseExpired: lease expired")]
    LeaseExpired,
    #[error("leaseRevoked: lease is unknown, released, cancelled or belongs to another session")]
    LeaseRevoked,
    #[error("leaseRangeInvalid: requested range is outside the lease or exceeds {MAX_BULK_RANGE_BYTES} bytes")]
    LeaseRangeInvalid,
    #[error("leaseBudgetExhausted: requested read exceeds the remaining lease budget")]
    LeaseBudgetExhausted,
    #[error("hashMismatch: immutable bulk source changed after lease creation")]
    HashMismatch,
    #[error("internal: {0}")]
    Internal(String),
}

#[derive(Debug, Clone)]
struct CursorState {
    generation: u64,
    next_index: usize,
    filter: EntityFilter,
    expires: Instant,
}

#[derive(Debug)]
struct BulkLease {
    descriptor: BulkLeaseDescriptor,
    source: File,
    expires: Instant,
    remaining_budget: u64,
    operation_id: Option<String>,
}

#[derive(Debug, Default)]
struct RuntimeState {
    cursors: BTreeMap<String, CursorState>,
    leases: BTreeMap<String, BulkLease>,
    operations: BTreeMap<String, CommandStatus>,
    validation_plans: BTreeMap<String, ValidatedPlan>,
    consumed_approval_grants: BTreeSet<String>,
}

#[derive(Debug, Clone)]
struct ValidatedPlan {
    plan_hash: String,
    transaction_hash: String,
    generation: u64,
    requires_confirmation: bool,
}

/// One process/session-scoped automation runtime. Dropping it revokes all
/// cursors, operations and leases, including across a sidecar restart.
#[derive(Debug)]
pub struct AutomationRuntime {
    state: Mutex<RuntimeState>,
    secret: [u8; 32],
    approval_secret: Option<[u8; 32]>,
    approval_session: Option<String>,
    sequence: AtomicU64,
}

impl AutomationRuntime {
    /// Creates a runtime from OS entropy. Entropy failure is fatal because
    /// cursor and lease capabilities must not be predictable.
    pub fn new() -> Result<Self, AutomationRuntimeError> {
        let mut secret = [0_u8; 32];
        getrandom::fill(&mut secret).map_err(|error| {
            AutomationRuntimeError::Internal(format!("OS entropy unavailable: {error}"))
        })?;
        let approval_secret = std::env::var("HIMMELCAD_AUTOMATION_APPROVAL_SECRET").ok();
        let approval_session = std::env::var("HIMMELCAD_AUTOMATION_HOST_SESSION").ok();
        // Provider/worker children must never inherit product approval
        // authority. The values remain only in this runtime after startup.
        std::env::remove_var("HIMMELCAD_AUTOMATION_APPROVAL_SECRET");
        std::env::remove_var("HIMMELCAD_AUTOMATION_HOST_SESSION");
        let (approval_secret, approval_session) = match (approval_secret, approval_session) {
            (None, None) => (None, None),
            (Some(secret), Some(session))
                if session.len() >= 32
                    && session.len() <= 128
                    && session.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
            {
                let bytes = hex::decode(secret).map_err(|_| {
                    AutomationRuntimeError::Internal(
                        "automation approval secret is not hexadecimal".to_owned(),
                    )
                })?;
                let secret: [u8; 32] = bytes.try_into().map_err(|_| {
                    AutomationRuntimeError::Internal(
                        "automation approval secret must contain 32 bytes".to_owned(),
                    )
                })?;
                (Some(secret), Some(session))
            }
            _ => {
                return Err(AutomationRuntimeError::Internal(
                    "automation approval host configuration is incomplete or invalid".to_owned(),
                ));
            }
        };
        Ok(Self {
            state: Mutex::new(RuntimeState::default()),
            secret,
            approval_secret,
            approval_session,
            sequence: AtomicU64::new(1),
        })
    }
    pub fn entities_page(
        &self,
        request: EntityPageRequest,
        app: &CanonicalAppRuntime,
    ) -> Result<EntityPage, AutomationRuntimeError> {
        if request.limit == 0 || request.limit > MAX_PAGE_ITEMS {
            return Err(AutomationRuntimeError::PageLimitExceeded);
        }
        if request.byte_limit == 0 || request.byte_limit > MAX_PAGE_BYTES {
            return Err(AutomationRuntimeError::ByteLimitExceeded);
        }
        if request.cursor.as_ref().is_some_and(String::is_empty) {
            return Err(AutomationRuntimeError::InvalidCursor);
        }
        if let Some(filter) = &request.filter {
            validate_entity_filter(filter)?;
        }
        if request
            .filter
            .as_ref()
            .is_some_and(|filter| filter.bounds.is_some())
        {
            return Err(AutomationRuntimeError::InvalidRequest(
                "bounds filter is unsupported until canonical aggregate bounds are available"
                    .to_owned(),
            ));
        }
        let (generation, entities) = app
            .automation_entities()
            .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?;
        let (start, filter) = if let Some(cursor) = request.cursor.as_deref() {
            let state = self.take_cursor(cursor)?;
            if state.generation != generation {
                return Err(AutomationRuntimeError::GenerationChanged {
                    requested: state.generation,
                    current: generation,
                });
            }
            if request
                .generation
                .is_some_and(|value| value != state.generation)
                || request
                    .filter
                    .as_ref()
                    .is_some_and(|value| value != &state.filter)
            {
                return Err(AutomationRuntimeError::InvalidCursor);
            }
            (state.next_index, state.filter)
        } else {
            if request.generation.is_some_and(|value| value != generation) {
                return Err(AutomationRuntimeError::GenerationChanged {
                    requested: request.generation.unwrap_or_default(),
                    current: generation,
                });
            }
            (0, request.filter.unwrap_or_default())
        };
        let filtered = filter_entities(&entities, &filter);
        if start > filtered.len() {
            return Err(AutomationRuntimeError::InvalidCursor);
        }
        let mut items = Vec::new();
        let mut returned_bytes = 0_usize;
        let mut next_index = start;
        for entity in filtered.iter().skip(start).take(request.limit) {
            let envelope = entity_envelope(entity);
            let item_bytes = serde_json::to_vec(&envelope)
                .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?
                .len()
                + usize::from(!items.is_empty());
            if returned_bytes.saturating_add(item_bytes) > request.byte_limit {
                if items.is_empty() {
                    return Err(AutomationRuntimeError::ByteLimitExceeded);
                }
                break;
            }
            returned_bytes += item_bytes;
            items.push(envelope);
            next_index += 1;
        }
        let next_cursor = (next_index < filtered.len())
            .then(|| self.insert_cursor(generation, next_index, filter));
        Ok(EntityPage {
            generation,
            items,
            returned_bytes,
            next_cursor,
        })
    }

    pub fn describe_cas(
        &self,
        request: CasDescribeRequest,
        app: &CanonicalAppRuntime,
    ) -> Result<CasDescription, AutomationRuntimeError> {
        if !is_hash(&request.content_hash) {
            return Err(AutomationRuntimeError::InvalidRequest(
                "contentHash must be a lowercase SHA-256".to_owned(),
            ));
        }
        let source = app
            .automation_object_source(&ObjectHash(request.content_hash.clone()))
            .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?;
        let logical_shape = logical_shape(&source);
        let lease = self.create_file_lease(source, None)?;
        Ok(CasDescription {
            content_hash: request.content_hash,
            media_type: lease.media_type.clone(),
            byte_length: lease.byte_length,
            logical_shape,
            lease,
        })
    }

    pub fn validate_command(
        &self,
        request: CommandValidateRequest,
        app: &CanonicalAppRuntime,
    ) -> Result<CommandValidationPlan, AutomationRuntimeError> {
        if request.transaction.command_id.trim().is_empty()
            || request.transaction.mutations.is_empty()
        {
            return Err(AutomationRuntimeError::InvalidRequest(
                "transaction requires commandId and at least one mutation".to_owned(),
            ));
        }
        if request
            .accepted_loss_codes
            .iter()
            .any(|code| code.trim().is_empty())
        {
            return Err(AutomationRuntimeError::InvalidRequest(
                "acceptedLossCodes must contain non-empty values".to_owned(),
            ));
        }
        let mut accepted_loss_codes = request.accepted_loss_codes;
        accepted_loss_codes.sort();
        if accepted_loss_codes
            .windows(2)
            .any(|window| window[0] == window[1])
        {
            return Err(AutomationRuntimeError::InvalidRequest(
                "acceptedLossCodes must be unique".to_owned(),
            ));
        }
        let requires_confirmation = request.transaction.mutations.iter().any(|mutation| {
            matches!(
                mutation,
                himmelcad_core::canonical_document::CanonicalEntityMutation::Delete { .. }
            )
        });
        let mut conflicts = Vec::new();
        if let Err(message) = app.automation_validate_transaction(&request.transaction) {
            conflicts.push(PlanIssue {
                code: "conflict".to_owned(),
                message,
                entity_id: None,
                details: BTreeMap::new(),
            });
        }
        let losses = Vec::new();
        let plan_hash = validation_plan_hash(
            &request.transaction,
            &accepted_loss_codes,
            requires_confirmation,
            &losses,
            &conflicts,
        )?;
        let plan = CommandValidationPlan {
            command_id: request.transaction.command_id.clone(),
            valid: conflicts.is_empty(),
            requires_confirmation,
            losses,
            conflicts,
            plan_hash,
        };
        let generation = app
            .automation_entities()
            .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?
            .0;
        let transaction_hash = transaction_hash(&request.transaction)?;
        let mut state = self.state.lock().expect("automation runtime poisoned");
        state.validation_plans.insert(
            plan.command_id.clone(),
            ValidatedPlan {
                plan_hash: plan.plan_hash.clone(),
                transaction_hash,
                generation,
                requires_confirmation,
            },
        );
        state.operations.insert(
            plan.command_id.clone(),
            CommandStatus {
                operation_id: plan.command_id.clone(),
                state: CommandState::Completed,
                completed: 1,
                total: 1,
                message: "canonical transaction validation completed".to_owned(),
                error: None,
            },
        );
        Ok(plan)
    }

    pub fn command_status(
        &self,
        request: &CommandStatusRequest,
    ) -> Result<CommandStatus, AutomationRuntimeError> {
        validate_operation_id(&request.operation_id)?;
        self.prune_expired();
        self.state
            .lock()
            .expect("automation runtime poisoned")
            .operations
            .get(&request.operation_id)
            .cloned()
            .ok_or(AutomationRuntimeError::OperationNotFound)
    }

    pub fn cancel_command(
        &self,
        request: &CommandStatusRequest,
    ) -> Result<CommandCancelResult, AutomationRuntimeError> {
        validate_operation_id(&request.operation_id)?;
        let mut state = self.state.lock().expect("automation runtime poisoned");
        let operation = state
            .operations
            .get_mut(&request.operation_id)
            .ok_or(AutomationRuntimeError::OperationNotFound)?;
        let cancellation_requested = matches!(
            operation.state,
            CommandState::Queued | CommandState::Running
        );
        if cancellation_requested {
            operation.state = CommandState::Cancelling;
            operation.message = "cancellation requested".to_owned();
        }
        state.leases.retain(|_, lease| {
            lease.operation_id.as_deref() != Some(request.operation_id.as_str())
        });
        Ok(CommandCancelResult {
            operation_id: request.operation_id.clone(),
            cancellation_requested,
        })
    }

    /// Verifies and consumes one host-issued destructive-command grant. The
    /// grant is bound to this host session, validation plan, exact transaction
    /// hash and a short expiry. Automation clients can only forward it.
    pub fn authorize_confirmation_grant(
        &self,
        transaction: &CanonicalCommandTransaction,
        grant: &str,
        current_generation: u64,
    ) -> Result<(), AutomationRuntimeError> {
        let approval_secret = self.approval_secret.ok_or_else(|| {
            AutomationRuntimeError::InvalidRequest(
                "confirmationRequired: host approval service is unavailable".to_owned(),
            )
        })?;
        let approval_session = self.approval_session.as_deref().ok_or_else(|| {
            AutomationRuntimeError::InvalidRequest(
                "confirmationRequired: host approval session is unavailable".to_owned(),
            )
        })?;
        let fields = grant.split(':').collect::<Vec<_>>();
        if fields.len() != 6 || fields[0] != "v1" {
            return Err(confirmation_error("approval grant is malformed"));
        }
        let session = fields[1];
        let expires_millis = fields[2]
            .parse::<u64>()
            .map_err(|_| confirmation_error("approval expiry is invalid"))?;
        let grant_id = fields[3];
        let plan_hash = fields[4];
        let signature = fields[5];
        if session != approval_session
            || !is_hash(grant_id)
            || !is_hash(plan_hash)
            || !is_hash(signature)
        {
            return Err(confirmation_error("approval grant identity is invalid"));
        }
        let now_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let now_millis = u64::try_from(now_millis).unwrap_or(u64::MAX);
        if expires_millis < now_millis || expires_millis > now_millis.saturating_add(60_000) {
            return Err(confirmation_error("approval grant is stale"));
        }
        let signed = fields[..5].join(":");
        let expected_signature = approval_signature(&approval_secret, &signed);
        if !constant_time_eq(signature.as_bytes(), expected_signature.as_bytes()) {
            return Err(confirmation_error("approval signature is invalid"));
        }
        let observed_transaction_hash = transaction_hash(transaction)?;
        let mut state = self.state.lock().expect("automation runtime poisoned");
        if state.consumed_approval_grants.contains(grant_id) {
            return Err(confirmation_error("approval grant was already consumed"));
        }
        let plan = state
            .validation_plans
            .get(&transaction.command_id)
            .ok_or_else(|| confirmation_error("transaction has no current validation plan"))?;
        if !plan.requires_confirmation
            || plan.generation != current_generation
            || plan.plan_hash != plan_hash
            || plan.transaction_hash != observed_transaction_hash
        {
            return Err(confirmation_error(
                "approval does not match the current validation plan",
            ));
        }
        state.consumed_approval_grants.insert(grant_id.to_owned());
        state.validation_plans.remove(&transaction.command_id);
        Ok(())
    }

    pub fn bulk_read(
        &self,
        request: BulkReadRequest,
    ) -> Result<BulkReadResult, AutomationRuntimeError> {
        if request.length == 0 || request.length > MAX_BULK_RANGE_BYTES {
            return Err(AutomationRuntimeError::LeaseRangeInvalid);
        }
        let mut state = self.state.lock().expect("automation runtime poisoned");
        let lease = state
            .leases
            .get_mut(&request.lease_id)
            .ok_or(AutomationRuntimeError::LeaseRevoked)?;
        if !constant_time_eq(
            request.access_token.as_bytes(),
            lease.descriptor.access_token.as_bytes(),
        ) {
            return Err(AutomationRuntimeError::LeaseRevoked);
        }
        if Instant::now() >= lease.expires {
            state.leases.remove(&request.lease_id);
            return Err(AutomationRuntimeError::LeaseExpired);
        }
        let end = request
            .offset
            .checked_add(request.length)
            .ok_or(AutomationRuntimeError::LeaseRangeInvalid)?;
        if end > lease.descriptor.byte_length {
            return Err(AutomationRuntimeError::LeaseRangeInvalid);
        }
        if request.length > lease.remaining_budget {
            return Err(AutomationRuntimeError::LeaseBudgetExhausted);
        }
        let length = usize::try_from(request.length)
            .map_err(|_| AutomationRuntimeError::LeaseRangeInvalid)?;
        let mut bytes = vec![0_u8; length];
        if lease
            .source
            .metadata()
            .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?
            .len()
            != lease.descriptor.byte_length
        {
            return Err(AutomationRuntimeError::HashMismatch);
        }
        lease
            .source
            .seek(SeekFrom::Start(request.offset))
            .and_then(|_| lease.source.read_exact(&mut bytes))
            .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?;
        lease.remaining_budget -= request.length;
        lease.descriptor.remaining_read_budget = lease.remaining_budget;
        Ok(BulkReadResult {
            lease_id: request.lease_id,
            offset: request.offset,
            byte_length: request.length,
            encoding: "base64".to_owned(),
            data: encode_base64(&bytes),
            remaining_read_budget: lease.remaining_budget,
        })
    }

    pub fn bulk_release(
        &self,
        request: BulkReleaseRequest,
    ) -> Result<BulkReleaseResult, AutomationRuntimeError> {
        let mut state = self.state.lock().expect("automation runtime poisoned");
        prune_state(&mut state);
        let released = state.leases.get(&request.lease_id).is_some_and(|lease| {
            constant_time_eq(
                request.access_token.as_bytes(),
                lease.descriptor.access_token.as_bytes(),
            )
        });
        if released {
            state.leases.remove(&request.lease_id);
        }
        Ok(BulkReleaseResult {
            lease_id: request.lease_id,
            released,
        })
    }

    pub fn revoke_all(&self) {
        let mut state = self.state.lock().expect("automation runtime poisoned");
        state.cursors.clear();
        state.leases.clear();
        state.operations.clear();
        state.validation_plans.clear();
        state.consumed_approval_grants.clear();
    }

    fn create_file_lease(
        &self,
        source: AutomationObjectSource,
        operation_id: Option<String>,
    ) -> Result<BulkLeaseDescriptor, AutomationRuntimeError> {
        if source.metadata.byte_length > MAX_SHAPE_ELEMENTS {
            return Err(AutomationRuntimeError::InvalidRequest(
                "byte payload exceeds maximum shape elements".to_owned(),
            ));
        }
        let lease_id = self.opaque_token(b"lease-id");
        let access_token = self.opaque_token(b"lease-access");
        let expires = Instant::now() + LEASE_LIFETIME;
        if source
            .source
            .metadata()
            .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?
            .len()
            != source.metadata.byte_length
        {
            return Err(AutomationRuntimeError::HashMismatch);
        }
        let typed_layout = direct_typed_lease_layout(&source);
        let descriptor = BulkLeaseDescriptor {
            lease_id: lease_id.clone(),
            access_token,
            content_hash: source.metadata.object_hash.0,
            media_type: source.metadata.media_type,
            element_type: typed_layout
                .as_ref()
                .map_or_else(|| "bytes".to_owned(), |layout| layout.0.to_owned()),
            shape: typed_layout.as_ref().map_or_else(
                || vec![source.metadata.byte_length],
                |layout| layout.1.clone(),
            ),
            endianness: typed_layout
                .as_ref()
                .map_or_else(|| "notApplicable".to_owned(), |layout| layout.2.to_owned()),
            byte_length: source.metadata.byte_length,
            expires_at: rfc3339_after(LEASE_LIFETIME),
            max_readable_range: MAX_BULK_RANGE_BYTES,
            remaining_read_budget: source.metadata.byte_length,
            read_only: true,
            source_entity: source.source_entity,
        };
        self.state
            .lock()
            .expect("automation runtime poisoned")
            .leases
            .insert(
                lease_id,
                BulkLease {
                    descriptor: descriptor.clone(),
                    source: source.source,
                    expires,
                    remaining_budget: descriptor.remaining_read_budget,
                    operation_id,
                },
            );
        Ok(descriptor)
    }

    fn take_cursor(&self, token: &str) -> Result<CursorState, AutomationRuntimeError> {
        let mut state = self.state.lock().expect("automation runtime poisoned");
        prune_state(&mut state);
        state
            .cursors
            .remove(token)
            .filter(|cursor| cursor.expires > Instant::now())
            .ok_or(AutomationRuntimeError::InvalidCursor)
    }

    fn insert_cursor(&self, generation: u64, next_index: usize, filter: EntityFilter) -> String {
        let token = self.opaque_token(b"entity-cursor");
        self.state
            .lock()
            .expect("automation runtime poisoned")
            .cursors
            .insert(
                token.clone(),
                CursorState {
                    generation,
                    next_index,
                    filter,
                    expires: Instant::now() + CURSOR_LIFETIME,
                },
            );
        token
    }

    fn opaque_token(&self, purpose: &[u8]) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let mut hasher = Sha256::new();
        hasher.update(self.secret);
        hasher.update(purpose);
        hasher.update(sequence.to_le_bytes());
        hex::encode(hasher.finalize())
    }

    fn prune_expired(&self) {
        prune_state(&mut self.state.lock().expect("automation runtime poisoned"));
    }
}

fn prune_state(state: &mut RuntimeState) {
    let now = Instant::now();
    state.cursors.retain(|_, cursor| cursor.expires > now);
    state.leases.retain(|_, lease| lease.expires > now);
}

fn validate_entity_filter(filter: &EntityFilter) -> Result<(), AutomationRuntimeError> {
    for (label, values) in [
        ("typeIds", &filter.type_ids),
        ("ownerIds", &filter.owner_ids),
    ] {
        if values
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > 512)
            || values.iter().collect::<BTreeSet<_>>().len() != values.len()
        {
            return Err(AutomationRuntimeError::InvalidRequest(format!(
                "filter {label} must contain unique non-empty bounded identifiers"
            )));
        }
    }
    if let Some(bounds) = &filter.bounds {
        for axis in 0..3 {
            if !bounds.minimum[axis].is_finite()
                || !bounds.maximum[axis].is_finite()
                || bounds.minimum[axis] > bounds.maximum[axis]
            {
                return Err(AutomationRuntimeError::InvalidRequest(
                    "filter bounds must be finite and ordered".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_operation_id(operation_id: &str) -> Result<(), AutomationRuntimeError> {
    if operation_id.trim().is_empty()
        || operation_id.len() > 512
        || operation_id
            .chars()
            .any(|character| matches!(character, '\0' | '\n' | '\r'))
    {
        return Err(AutomationRuntimeError::InvalidRequest(
            "operationId is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn filter_entities<'a>(
    entities: &'a [CanonicalEntity],
    filter: &EntityFilter,
) -> Vec<&'a CanonicalEntity> {
    let types = filter
        .type_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let owners = filter
        .owner_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let owner_index = entities
        .iter()
        .map(|entity| {
            (
                entity.id.0.as_str(),
                entity.owner.as_ref().map(|owner| owner.0.as_str()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    entities
        .iter()
        .filter(|entity| types.is_empty() || types.contains(entity.type_id.0.as_str()))
        .filter(|entity| {
            if owners.is_empty() {
                return true;
            }
            if !filter.include_descendants {
                return entity
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owners.contains(owner.0.as_str()));
            }
            let mut owner = entity.owner.as_ref().map(|owner| owner.0.as_str());
            let mut visited = BTreeSet::new();
            while let Some(current) = owner {
                if owners.contains(current) {
                    return true;
                }
                if !visited.insert(current) {
                    return false;
                }
                owner = owner_index.get(current).and_then(|owner| *owner);
            }
            false
        })
        .collect()
}

fn entity_envelope(entity: &CanonicalEntity) -> EntityEnvelope {
    EntityEnvelope {
        id: entity.id.0.clone(),
        revision: entity.revision,
        version_hash: entity.version_hash.0.clone(),
        type_id: entity.type_id.0.clone(),
        name: entity.name.clone(),
        owner_id: entity.owner.as_ref().map(|owner| owner.0.clone()),
        layer_ids: entity
            .layer_ids
            .iter()
            .map(|layer| layer.0.clone())
            .collect(),
        bounds: None,
    }
}

fn logical_shape(source: &AutomationObjectSource) -> Value {
    let Some(descriptor) = &source.typed_artifact else {
        // A MIME type does not prove an element layout. Generic CAS objects
        // therefore remain bytes until an authoritative manifest binds them.
        return json!({ "kind": "bytes", "shape": [source.metadata.byte_length] });
    };
    json!({
        "kind": "typedArtifact",
        "semantic": descriptor.semantic,
        "layout": descriptor.layout,
        "representationSlot": source.representation_slot,
        "geometryRef": source.geometry_ref,
    })
}

fn direct_typed_lease_layout(
    source: &AutomationObjectSource,
) -> Option<(&'static str, Vec<u64>, &'static str)> {
    let descriptor = source.typed_artifact.as_ref()?;
    let TypedArtifactLayout::DenseArray {
        byte_offset,
        byte_length,
        element_type,
        shape,
        endianness,
        byte_strides,
        ..
    } = &descriptor.layout
    else {
        // Interleaved and encoded layouts remain byte leases; their complete
        // authoritative physical layout is still returned in logicalShape.
        return None;
    };
    if *byte_offset != 0
        || *byte_length != source.metadata.byte_length
        || byte_strides.is_some()
        || shape.len() > MAX_SHAPE_RANK
        || shape
            .iter()
            .try_fold(1_u64, |count, dimension| count.checked_mul(*dimension))
            .is_none_or(|count| count > MAX_SHAPE_ELEMENTS)
    {
        return None;
    }
    Some((
        automation_element_type(*element_type),
        shape.clone(),
        automation_endianness(*endianness),
    ))
}

const fn automation_element_type(element_type: ArtifactElementType) -> &'static str {
    match element_type {
        ArtifactElementType::Uint8 => "uint8",
        ArtifactElementType::Int8 => "int8",
        ArtifactElementType::Uint16 => "uint16",
        ArtifactElementType::Int16 => "int16",
        ArtifactElementType::Uint32 => "uint32",
        ArtifactElementType::Int32 => "int32",
        ArtifactElementType::Uint64 => "uint64",
        ArtifactElementType::Int64 => "int64",
        ArtifactElementType::Float32 => "float32",
        ArtifactElementType::Float64 => "float64",
    }
}

const fn automation_endianness(endianness: ArtifactEndianness) -> &'static str {
    match endianness {
        ArtifactEndianness::NotApplicable => "notApplicable",
        ArtifactEndianness::Little => "little",
        ArtifactEndianness::Big => "big",
    }
}

fn validation_plan_hash(
    transaction: &CanonicalCommandTransaction,
    accepted_loss_codes: &[String],
    requires_confirmation: bool,
    losses: &[PlanIssue],
    conflicts: &[PlanIssue],
) -> Result<String, AutomationRuntimeError> {
    let bytes = serde_json::to_vec(&json!({
        "transaction": transaction,
        "acceptedLossCodes": accepted_loss_codes,
        "requiresConfirmation": requires_confirmation,
        "losses": losses,
        "conflicts": conflicts,
    }))
    .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn transaction_hash(
    transaction: &CanonicalCommandTransaction,
) -> Result<String, AutomationRuntimeError> {
    let bytes = serde_json::to_vec(transaction)
        .map_err(|error| AutomationRuntimeError::Internal(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn approval_signature(secret: &[u8; 32], signed_fields: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts a 32-byte key");
    mac.update(signed_fields.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn confirmation_error(message: &str) -> AutomationRuntimeError {
    AutomationRuntimeError::InvalidRequest(format!("confirmationRequired: {message}"))
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(TABLE[usize::from(a >> 2)]));
        output.push(char::from(TABLE[usize::from(((a & 0x03) << 4) | (b >> 4))]));
        output.push(if chunk.len() > 1 {
            char::from(TABLE[usize::from(((b & 0x0f) << 2) | (c >> 6))])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(TABLE[usize::from(c & 0x3f)])
        } else {
            '='
        });
    }
    output
}

// RFC 3339 UTC formatter without adding a clock/time-zone dependency to the
// security boundary. The civil-date conversion is the public-domain
// days-from-civil inverse by Howard Hinnant.
fn rfc3339_after(duration: Duration) -> String {
    let seconds = SystemTime::now()
        .checked_add(duration)
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| {
            i64::try_from(value.as_secs()).unwrap_or(i64::MAX)
        });
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    use himmelcad_core::app_protocol::{
        AppProtocolRequest, AppProtocolRequestEnvelope, AppProtocolResponse, APP_PROTOCOL_SCHEMA_ID,
    };
    use himmelcad_core::canonical_document::CanonicalEntityMutation;
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::GeometryResource;
    use himmelcad_core::entity_validation::canonical_entity_version_hash;
    use himmelcad_core::typed_artifact::TypedArtifactDescriptor;

    use crate::canonical_project_store::CanonicalStoredObject;

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct TestProject {
        root: PathBuf,
        app: CanonicalAppRuntime,
    }

    impl TestProject {
        fn new(entity_count: usize) -> Self {
            let root = std::env::temp_dir().join(format!(
                "himmelcad-automation-runtime-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            let mut app = CanonicalAppRuntime::default();
            app.open(&root).expect("open canonical test project");
            if entity_count > 1 {
                let template = app.automation_entities().expect("entities").1[0].clone();
                let mut mutations = Vec::new();
                for index in 1..entity_count {
                    let mut entity = template.clone();
                    entity.id = EntityId(format!("entity-{index:04}"));
                    entity.name = format!("Entity {index}");
                    entity.owner = Some(EntityId("project-root".to_owned()));
                    entity.revision = 0;
                    entity.version_hash = canonical_entity_version_hash(&entity).expect("hash");
                    mutations.push(CanonicalEntityMutation::Create { entity });
                }
                commit(
                    &mut app,
                    CanonicalCommandTransaction {
                        command_id: "test.seed-entities".to_owned(),
                        mutations,
                    },
                );
            }
            Self { root, app }
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            self.app.close();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn commit(app: &mut CanonicalAppRuntime, transaction: CanonicalCommandTransaction) {
        let response = app.dispatch(AppProtocolRequestEnvelope {
            schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
            request_id: format!("test-request-{}", transaction.command_id),
            request: AppProtocolRequest::ExecuteCanonicalTransaction(transaction),
            extensions: BTreeMap::new(),
        });
        assert!(matches!(
            response.response,
            AppProtocolResponse::TransactionAccepted(_)
        ));
    }

    fn runtime_with_approval() -> AutomationRuntime {
        AutomationRuntime {
            state: Mutex::new(RuntimeState::default()),
            secret: [3; 32],
            approval_secret: Some([7; 32]),
            approval_session: Some("ab".repeat(24)),
            sequence: AtomicU64::new(1),
        }
    }

    fn issue_test_grant(
        runtime: &AutomationRuntime,
        plan_hash: &str,
        grant_id: &str,
        expires_millis: u64,
    ) -> String {
        let session = runtime.approval_session.as_deref().expect("session");
        let signed = format!("v1:{session}:{expires_millis}:{grant_id}:{plan_hash}");
        let signature = approval_signature(&[7; 32], &signed);
        format!("{signed}:{signature}")
    }

    #[test]
    fn base64_and_rfc3339_are_deterministically_well_formed() {
        assert_eq!(encode_base64(b"abcd"), "YWJjZA==");
        let timestamp = rfc3339_after(Duration::from_secs(60));
        assert_eq!(timestamp.len(), 20);
        assert_eq!(&timestamp[4..5], "-");
        assert!(timestamp.ends_with('Z'));
    }

    #[test]
    fn opaque_tokens_are_unique_and_access_comparison_is_strict() {
        let runtime = AutomationRuntime::new().expect("OS entropy");
        let first = runtime.opaque_token(b"lease");
        let second = runtime.opaque_token(b"lease");
        assert_ne!(first, second);
        assert!(constant_time_eq(first.as_bytes(), first.as_bytes()));
        assert!(!constant_time_eq(first.as_bytes(), second.as_bytes()));
    }

    #[test]
    fn entity_cursor_is_opaque_bounded_single_use_and_generation_bound() {
        let mut project = TestProject::new(4);
        let runtime = AutomationRuntime::new().expect("runtime");
        let first = runtime
            .entities_page(
                EntityPageRequest {
                    cursor: None,
                    generation: None,
                    limit: 1,
                    byte_limit: MAX_PAGE_BYTES,
                    filter: None,
                },
                &project.app,
            )
            .expect("first page");
        assert_eq!(first.items.len(), 1);
        assert!(first.returned_bytes <= MAX_PAGE_BYTES);
        let cursor = first.next_cursor.expect("next cursor");
        assert!(is_hash(&cursor));

        let template = project.app.automation_entities().expect("entities").1[0].clone();
        let mut entity = template;
        entity.id = EntityId("entity-later".to_owned());
        entity.name = "Later".to_owned();
        entity.revision = 0;
        entity.version_hash = canonical_entity_version_hash(&entity).expect("hash");
        commit(
            &mut project.app,
            CanonicalCommandTransaction {
                command_id: "test.change-generation".to_owned(),
                mutations: vec![CanonicalEntityMutation::Create { entity }],
            },
        );
        let error = runtime
            .entities_page(
                EntityPageRequest {
                    cursor: Some(cursor),
                    generation: Some(first.generation),
                    limit: 1,
                    byte_limit: MAX_PAGE_BYTES,
                    filter: None,
                },
                &project.app,
            )
            .expect_err("stale cursor");
        assert!(matches!(
            error,
            AutomationRuntimeError::GenerationChanged { .. }
        ));

        let unsupported = runtime.entities_page(
            EntityPageRequest {
                cursor: None,
                generation: None,
                limit: 1,
                byte_limit: MAX_PAGE_BYTES,
                filter: Some(EntityFilter {
                    bounds: Some(Bounds3d {
                        minimum: [0.0; 3],
                        maximum: [1.0; 3],
                    }),
                    ..EntityFilter::default()
                }),
            },
            &project.app,
        );
        assert!(matches!(
            unsupported,
            Err(AutomationRuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn cas_leases_enforce_hash_range_budget_expiry_release_and_restart_revoke() {
        let project = TestProject::new(1);
        let runtime = AutomationRuntime::new().expect("runtime");
        let root = project.app.automation_entities().expect("entities").1[0].clone();
        let description = runtime
            .describe_cas(
                CasDescribeRequest {
                    content_hash: root.components_ref.0,
                },
                &project.app,
            )
            .expect("description");
        assert!(!description
            .logical_shape
            .to_string()
            .contains(&project.root.display().to_string()));
        let request = BulkReadRequest {
            lease_id: description.lease.lease_id.clone(),
            access_token: description.lease.access_token.clone(),
            offset: 0,
            length: description.byte_length.min(4),
        };
        let read = runtime.bulk_read(request.clone()).expect("bounded read");
        assert_eq!(read.encoding, "base64");
        assert_eq!(read.byte_length, request.length);
        assert!(matches!(
            runtime.bulk_read(BulkReadRequest {
                offset: description.byte_length,
                length: 2,
                ..request.clone()
            }),
            Err(AutomationRuntimeError::LeaseRangeInvalid)
        ));
        let restarted = AutomationRuntime::new().expect("restarted runtime");
        assert!(matches!(
            restarted.bulk_read(request.clone()),
            Err(AutomationRuntimeError::LeaseRevoked)
        ));
        assert!(
            runtime
                .bulk_release(BulkReleaseRequest {
                    lease_id: request.lease_id.clone(),
                    access_token: request.access_token.clone(),
                })
                .expect("release")
                .released
        );
        assert!(matches!(
            runtime.bulk_read(request),
            Err(AutomationRuntimeError::LeaseRevoked)
        ));

        let expired = runtime
            .describe_cas(
                CasDescribeRequest {
                    content_hash: root.attributes_ref.0,
                },
                &project.app,
            )
            .expect("expiring lease");
        runtime
            .state
            .lock()
            .expect("state")
            .leases
            .get_mut(&expired.lease.lease_id)
            .expect("lease")
            .expires = Instant::now() - Duration::from_millis(1);
        assert!(matches!(
            runtime.bulk_read(BulkReadRequest {
                lease_id: expired.lease.lease_id,
                access_token: expired.lease.access_token,
                offset: 0,
                length: 1,
            }),
            Err(AutomationRuntimeError::LeaseExpired)
        ));
    }

    #[test]
    fn dense_full_resource_manifest_produces_a_typed_read_only_lease() {
        let path = std::env::temp_dir().join(format!(
            "himmelcad-typed-lease-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        let bytes = [0_f32, 1.0, 2.0, 3.0, 4.0, 5.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        fs::write(&path, &bytes).expect("typed fixture");
        let resource = GeometryResource {
            object_hash: ObjectHash::of_bytes(&bytes),
            media_type: "hcad.positions-f32le-xyz@1".to_owned(),
            byte_length: Some(u64::try_from(bytes.len()).expect("length")),
        };
        let source = AutomationObjectSource {
            metadata: CanonicalStoredObject {
                object_hash: resource.object_hash.clone(),
                media_type: resource.media_type.clone(),
                byte_length: resource.byte_length.expect("length"),
            },
            source: File::open(&path).expect("open typed fixture"),
            source_entity: None,
            typed_artifact: Some(TypedArtifactDescriptor {
                resource,
                semantic: "hcad.mesh.positions".to_owned(),
                layout: TypedArtifactLayout::DenseArray {
                    byte_offset: 0,
                    byte_length: u64::try_from(bytes.len()).expect("length"),
                    element_type: ArtifactElementType::Float32,
                    shape: vec![2, 3],
                    endianness: ArtifactEndianness::Little,
                    byte_strides: None,
                    decode: None,
                },
            }),
            representation_slot: Some("primary".to_owned()),
            geometry_ref: Some(ObjectHash::of_bytes(b"geometry")),
        };
        let shape = logical_shape(&source);
        assert_eq!(shape["kind"], "typedArtifact");
        let runtime = AutomationRuntime::new().expect("runtime");
        let lease = runtime
            .create_file_lease(source, None)
            .expect("typed lease");
        assert_eq!(lease.element_type, "float32");
        assert_eq!(lease.shape, [2, 3]);
        assert_eq!(lease.endianness, "little");
        assert!(lease.read_only);
        runtime.revoke_all();
        fs::remove_file(path).expect("cleanup typed fixture");
    }

    #[test]
    fn destructive_approval_is_plan_transaction_generation_ttl_and_replay_bound() {
        let project = TestProject::new(1);
        let runtime = runtime_with_approval();
        let (generation, entities) = project.app.automation_entities().expect("entities");
        let root = &entities[0];
        let transaction = CanonicalCommandTransaction {
            command_id: "automation.delete-root".to_owned(),
            mutations: vec![CanonicalEntityMutation::Delete {
                expected: EntityVersionRef {
                    id: root.id.clone(),
                    revision: root.revision,
                    version_hash: root.version_hash.clone(),
                },
            }],
        };
        let plan = runtime
            .validate_command(
                CommandValidateRequest {
                    transaction: transaction.clone(),
                    accepted_loss_codes: Vec::new(),
                },
                &project.app,
            )
            .expect("plan");
        assert!(plan.valid && plan.requires_confirmation);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_millis() as u64;
        let grant_id = "11".repeat(32);
        let grant = issue_test_grant(&runtime, &plan.plan_hash, &grant_id, now + 30_000);
        assert!(runtime
            .authorize_confirmation_grant(&transaction, &grant, generation + 1)
            .is_err());
        assert!(runtime
            .authorize_confirmation_grant(&transaction, &grant, generation)
            .is_ok());
        assert!(runtime
            .authorize_confirmation_grant(&transaction, &grant, generation)
            .is_err());

        let second = runtime
            .validate_command(
                CommandValidateRequest {
                    transaction: transaction.clone(),
                    accepted_loss_codes: Vec::new(),
                },
                &project.app,
            )
            .expect("second plan");
        let mut changed = transaction.clone();
        if let CanonicalEntityMutation::Delete { expected } = &mut changed.mutations[0] {
            expected.revision += 1;
        }
        let changed_grant =
            issue_test_grant(&runtime, &second.plan_hash, &"22".repeat(32), now + 30_000);
        assert!(runtime
            .authorize_confirmation_grant(&changed, &changed_grant, generation)
            .is_err());
        let expired = issue_test_grant(
            &runtime,
            &second.plan_hash,
            &"33".repeat(32),
            now.saturating_sub(1),
        );
        assert!(runtime
            .authorize_confirmation_grant(&transaction, &expired, generation)
            .is_err());
        let mut invalid_signature =
            issue_test_grant(&runtime, &second.plan_hash, &"44".repeat(32), now + 30_000);
        invalid_signature.replace_range(invalid_signature.len() - 1.., "0");
        assert!(runtime
            .authorize_confirmation_grant(&transaction, &invalid_signature, generation)
            .is_err());
    }
}
