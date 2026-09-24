//! Runtime-neutral raster job progress, memory, and checkpoint contracts.

use std::pin::Pin;

use himmelcad_model::hash::ObjectHash;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterPhase {
    Validating,
    Rasterizing,
    Orthorectifying,
    Mosaicking,
    BuildingPyramid,
    ExportingCog,
    ValidatingCog,
    Committing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterProgress {
    pub phase: RasterPhase,
    pub completed_steps: u64,
    pub total_steps: u64,
    pub current_step: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterPreparationStagePlan {
    pub stage: &'static str,
    pub model_bytes: u64,
    pub resident_limit_bytes: u64,
}

pub trait RasterMemorySink: std::fmt::Debug + Send + Sync {
    fn record_stage_peak(
        &self,
        stage: &'static str,
        peak_rss_bytes: u64,
        workers: u16,
        parameters: Value,
    ) -> Result<(), String>;

    fn record_worker_memory_limit_hit(
        &self,
        stage: &'static str,
        limit_bytes: u64,
    ) -> Result<(), String>;
}

pub trait RasterCheckpointSink: std::fmt::Debug + Send + Sync {
    fn accepts_raster_checkpoints(&self) -> bool;

    fn record_raster_committed<'a>(
        &'a self,
        sequence: u64,
        progress: RasterProgress,
        checkpoint_id: String,
        payload_hash: ObjectHash,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

pub fn raster_checkpoint_content_key(
    kind: &str,
    config_hash: &ObjectHash,
    input_hash: &ObjectHash,
) -> Result<String, &'static str> {
    if !matches!(kind, "buildDem" | "buildOrthomosaic") {
        return Err("unsupported raster checkpoint kind");
    }
    serde_json::to_vec(&(kind, config_hash, input_hash))
        .map(|bytes| ObjectHash::of_bytes(&bytes).0)
        .map_err(|_| "failed to serialize raster checkpoint identity")
}
