//! Cancellable RPC-facing lifecycle around the offline PROJ runtime.

use std::{collections::HashMap, sync::Arc};

use himmelcad_core::{
    photolab_crs::{FrozenImportTransformation, ImportTransformationDecision},
    photolab_jobs::CancellationToken,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::crs_runtime::{CrsRuntimeError, OperationDiscovery, OperationQuery, ProjRuntime};

/// An operation id makes discovery/freezing independently cancellable over JSON-RPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverCrsOperationsParams {
    pub operation_id: String,
    pub query: OperationQuery,
}

/// A complete user decision to validate, rediscover and freeze.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreezeCrsOperationParams {
    pub operation_id: String,
    pub decision: ImportTransformationDecision,
}

/// Shared cancellation input for CRS discovery and freezing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelCrsOperationParams {
    pub operation_id: String,
}

/// Immediate acknowledgement; the running process observes the same token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelCrsOperationResult {
    pub operation_id: String,
    pub cancellation_requested: bool,
}

/// Serializes operation ids while allowing discovery and cancellation RPCs to run concurrently.
#[derive(Debug, Clone)]
pub struct CrsService {
    runtime: Arc<ProjRuntime>,
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl CrsService {
    #[must_use]
    pub fn new(runtime: ProjRuntime) -> Self {
        Self {
            runtime: Arc::new(runtime),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn discover(
        &self,
        params: DiscoverCrsOperationsParams,
    ) -> Result<OperationDiscovery, CrsServiceError> {
        let token = self.begin(&params.operation_id).await?;
        let result = self
            .runtime
            .discover_operations(&params.query, &token)
            .await
            .map_err(CrsServiceError::Runtime);
        self.finish(&params.operation_id).await;
        result
    }

    pub async fn freeze(
        &self,
        params: FreezeCrsOperationParams,
    ) -> Result<FrozenImportTransformation, CrsServiceError> {
        let token = self.begin(&params.operation_id).await?;
        let frozen = params
            .decision
            .validate_and_freeze()
            .map_err(|error| CrsServiceError::Decision(error.to_string()));
        let result = match frozen {
            Ok(frozen) => self
                .runtime
                .validate_frozen(&frozen, &token)
                .await
                .map(|_| frozen)
                .map_err(CrsServiceError::Runtime),
            Err(error) => Err(error),
        };
        self.finish(&params.operation_id).await;
        result
    }

    pub async fn cancel(&self, params: CancelCrsOperationParams) -> CancelCrsOperationResult {
        let active = self.active.lock().await;
        let cancellation_requested = active
            .get(&params.operation_id)
            .is_some_and(CancellationToken::request_cancel);
        CancelCrsOperationResult {
            operation_id: params.operation_id,
            cancellation_requested,
        }
    }

    pub async fn transform_text(
        &self,
        operation_id: &str,
        frozen: &FrozenImportTransformation,
        input: &str,
    ) -> Result<String, CrsServiceError> {
        let token = self.begin(operation_id).await?;
        let result = async {
            self.runtime.validate_frozen(frozen, &token).await?;
            let mut input_bytes = input.as_bytes();
            let mut output = Vec::new();
            self.runtime
                .transform_stream(frozen, &mut input_bytes, &mut output, &token)
                .await?;
            String::from_utf8(output)
                .map_err(|error| CrsServiceError::MalformedCoordinates(error.to_string()))
        }
        .await;
        self.finish(operation_id).await;
        result
    }

    async fn begin(&self, operation_id: &str) -> Result<CancellationToken, CrsServiceError> {
        validate_operation_id(operation_id)?;
        let mut active = self.active.lock().await;
        if active.contains_key(operation_id) {
            return Err(CrsServiceError::DuplicateOperation(operation_id.to_owned()));
        }
        let token = CancellationToken::new();
        active.insert(operation_id.to_owned(), token.clone());
        Ok(token)
    }

    async fn finish(&self, operation_id: &str) {
        self.active.lock().await.remove(operation_id);
    }
}

fn validate_operation_id(operation_id: &str) -> Result<(), CrsServiceError> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'))
    {
        return Err(CrsServiceError::InvalidOperationId);
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum CrsServiceError {
    #[error("invalid CRS operation id")]
    InvalidOperationId,
    #[error("CRS operation is already active: {0}")]
    DuplicateOperation(String),
    #[error("CRS decision is invalid: {0}")]
    Decision(String),
    #[error(transparent)]
    Runtime(#[from] CrsRuntimeError),
    #[error("transformed coordinate output is malformed: {0}")]
    MalformedCoordinates(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_ids_are_restricted_to_rpc_safe_ascii() {
        assert!(validate_operation_id("crs-discover_42.1").is_ok());
        assert!(matches!(
            validate_operation_id("../../kill"),
            Err(CrsServiceError::InvalidOperationId)
        ));
        assert!(matches!(
            validate_operation_id(""),
            Err(CrsServiceError::InvalidOperationId)
        ));
    }
}
