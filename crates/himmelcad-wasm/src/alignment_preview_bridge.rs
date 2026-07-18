//! JSON boundary for incremental Civil-alignment preview sessions.

use std::collections::BTreeMap;
use std::sync::Arc;

use himmelcad_core::entity_model::{AlignmentGeometry, TriangleMeshGeometry};
use himmelcad_core::hash::ObjectHash;
use himmelcad_render::{
    AlignmentPreviewConfig, AlignmentPreviewEvaluator, AlignmentPreviewPartition,
    AlignmentPreviewPartitionUpdate, AlignmentPreviewRevision, AlignmentStationRange,
    AlignmentTargetSurfaceSnapshot, AlignmentTargetSurfaceUpdate,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignmentPreviewBuildRequest {
    alignment: AlignmentGeometry,
    alignment_version: ObjectHash,
    targets: Vec<AlignmentTargetSurfaceSnapshot>,
    config: AlignmentPreviewConfig,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignmentPreviewUpdateRequest {
    expected_generation: u64,
    alignment_version: ObjectHash,
    horizontal_path_version: ObjectHash,
    partitions: Vec<AlignmentPreviewPartitionUpdate>,
    targets: Vec<AlignmentTargetSurfaceUpdate>,
    affected: AlignmentStationRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentPreviewResponse<'a> {
    preview_id: &'a str,
    generation: u64,
    alignment_version: &'a ObjectHash,
    horizontal_path_version: &'a ObjectHash,
    partition_count: u32,
    parent_identity: Option<&'a ObjectHash>,
    identity: &'a ObjectHash,
    changed_partitions: Vec<AlignmentPreviewRenderPartition<'a>>,
    changed_proxy_ids: Vec<String>,
    workload: AlignmentPreviewWorkloadResponse,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentPreviewWorkloadResponse {
    partitions: u32,
    station_samples: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentPreviewRenderPartition<'a> {
    index: u32,
    station_range: AlignmentStationRange,
    identity: &'a ObjectHash,
    road_body: Vec<AlignmentPreviewRoadBodyRenderPart<'a>>,
    slopes: Vec<AlignmentPreviewSlopeRenderPart<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentPreviewRoadBodyRenderPart<'a> {
    proxy_id: String,
    band_id: &'a str,
    mesh: &'a TriangleMeshGeometry,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentPreviewSlopeRenderPart<'a> {
    proxy_id: String,
    rule_id: &'a str,
    source_band_id: &'a str,
    target_surface: &'a himmelcad_core::entity::EntityId,
    target_surface_version: &'a ObjectHash,
    geometry_version: &'a ObjectHash,
    mesh: &'a TriangleMeshGeometry,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AlignmentPreviewSessionStore {
    sessions: BTreeMap<String, AlignmentPreviewEvaluator>,
}

impl AlignmentPreviewSessionStore {
    pub(crate) fn build_json(
        &mut self,
        preview_id: &str,
        request_json: &str,
    ) -> Result<String, String> {
        validate_preview_id(preview_id)?;
        if self.sessions.contains_key(preview_id) {
            return Err("alignment preview ID is already active".to_owned());
        }
        let request: AlignmentPreviewBuildRequest = serde_json::from_str(request_json)
            .map_err(|error| format!("invalid alignment preview build request: {error}"))?;
        let evaluator = AlignmentPreviewEvaluator::build(
            &request.alignment,
            request.alignment_version,
            &request.targets,
            request.config,
        )
        .map_err(|error| error.to_string())?;
        let revision = evaluator.current();
        let response = serialize_response(preview_id, &evaluator, &revision)?;
        self.sessions.insert(preview_id.to_owned(), evaluator);
        Ok(response)
    }

    pub(crate) fn update_json(
        &mut self,
        preview_id: &str,
        request_json: &str,
    ) -> Result<String, String> {
        validate_preview_id(preview_id)?;
        let request: AlignmentPreviewUpdateRequest = serde_json::from_str(request_json)
            .map_err(|error| format!("invalid alignment preview update request: {error}"))?;
        let current = self
            .sessions
            .get(preview_id)
            .ok_or_else(|| "alignment preview ID is not active".to_owned())?;

        // The evaluator clone shares its immutable path and revision trees. Only
        // the successfully serialized candidate replaces the active generation.
        let mut candidate = current.clone();
        let revision = candidate
            .update(
                request.expected_generation,
                request.alignment_version,
                &request.horizontal_path_version,
                &request.partitions,
                &request.targets,
                request.affected,
            )
            .map_err(|error| error.to_string())?;
        let response = serialize_response(preview_id, &candidate, &revision)?;
        self.sessions.insert(preview_id.to_owned(), candidate);
        Ok(response)
    }

    pub(crate) fn retire(&mut self, preview_id: &str) -> Result<bool, String> {
        validate_preview_id(preview_id)?;
        Ok(self.sessions.remove(preview_id).is_some())
    }

    pub(crate) fn changed_partitions(
        &self,
        preview_id: &str,
    ) -> Result<Vec<Arc<AlignmentPreviewPartition>>, String> {
        let revision = self
            .sessions
            .get(preview_id)
            .ok_or_else(|| "alignment preview ID is not active".to_owned())?
            .current();
        Ok(revision.changed_partitions.clone())
    }

    pub(crate) fn all_proxy_ids(&self, preview_id: &str) -> Result<Vec<String>, String> {
        let revision = self
            .sessions
            .get(preview_id)
            .ok_or_else(|| "alignment preview ID is not active".to_owned())?
            .current();
        let mut ids = Vec::new();
        for index in 0..revision.partition_count {
            let partition = revision
                .partition(index)
                .expect("revision owns every preview partition");
            append_partition_proxy_ids(preview_id, partition, &mut ids);
        }
        Ok(ids)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.sessions.len()
    }
}

pub(crate) fn partition_proxy_ids(
    preview_id: &str,
    partitions: &[Arc<AlignmentPreviewPartition>],
) -> Vec<String> {
    let mut ids = Vec::new();
    for partition in partitions {
        append_partition_proxy_ids(preview_id, partition, &mut ids);
    }
    ids
}

fn append_partition_proxy_ids(
    preview_id: &str,
    partition: &AlignmentPreviewPartition,
    ids: &mut Vec<String>,
) {
    ids.extend(
        partition
            .road_body
            .iter()
            .map(|part| render_proxy_id(preview_id, partition.index, "road-body", &part.id)),
    );
    ids.extend(
        partition
            .slopes
            .iter()
            .map(|part| render_proxy_id(preview_id, partition.index, "slope", &part.rule_id)),
    );
}

fn validate_preview_id(preview_id: &str) -> Result<(), String> {
    if preview_id.is_empty() || preview_id.len() > 256 {
        return Err("alignment preview ID must contain 1 through 256 UTF-8 bytes".to_owned());
    }
    Ok(())
}

fn serialize_response(
    preview_id: &str,
    evaluator: &AlignmentPreviewEvaluator,
    revision: &AlignmentPreviewRevision,
) -> Result<String, String> {
    let changed_proxy_ids = partition_proxy_ids(preview_id, &revision.changed_partitions);
    let changed_partitions = revision
        .changed_partitions
        .iter()
        .map(|partition| render_partition(preview_id, partition))
        .collect();
    let workload = evaluator.last_workload();
    serde_json::to_string(&AlignmentPreviewResponse {
        preview_id,
        generation: revision.generation,
        alignment_version: &revision.alignment_version,
        horizontal_path_version: evaluator.horizontal_path_version(),
        partition_count: revision.partition_count,
        parent_identity: revision.parent_identity.as_ref(),
        identity: &revision.identity,
        changed_partitions,
        changed_proxy_ids,
        workload: AlignmentPreviewWorkloadResponse {
            partitions: workload.partitions,
            station_samples: workload.station_samples,
        },
    })
    .map_err(|error| format!("alignment preview response serialization failed: {error}"))
}

fn render_partition<'a>(
    preview_id: &str,
    partition: &'a AlignmentPreviewPartition,
) -> AlignmentPreviewRenderPartition<'a> {
    let road_body = partition
        .road_body
        .iter()
        .map(|part| {
            let proxy_id = render_proxy_id(preview_id, partition.index, "road-body", &part.id);
            AlignmentPreviewRoadBodyRenderPart {
                proxy_id,
                band_id: &part.id,
                mesh: &part.mesh,
            }
        })
        .collect();
    let slopes = partition
        .slopes
        .iter()
        .map(|part| {
            let proxy_id = render_proxy_id(preview_id, partition.index, "slope", &part.rule_id);
            AlignmentPreviewSlopeRenderPart {
                proxy_id,
                rule_id: &part.rule_id,
                source_band_id: &part.source_band_id,
                target_surface: &part.target_surface,
                target_surface_version: &part.target_surface_version,
                geometry_version: &part.geometry_version,
                mesh: &part.mesh,
            }
        })
        .collect();
    AlignmentPreviewRenderPartition {
        index: partition.index,
        station_range: partition.station_range,
        identity: &partition.identity,
        road_body,
        slopes,
    }
}

pub(crate) fn render_proxy_id(
    preview_id: &str,
    partition: u32,
    role: &str,
    authored_id: &str,
) -> String {
    let address = serde_json::to_vec(&(preview_id, partition, role, authored_id))
        .expect("alignment preview proxy address serializes");
    format!(
        "alignment-preview-{}",
        ObjectHash::of_bytes(&address).as_str()
    )
}

#[cfg(test)]
mod tests {
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        CurveGeometry, Position, SlopeRule, StationFunction, StationValue, Vector3,
        VerticalAlignmentSegment, WidthBand,
    };
    use serde_json::Value;

    use super::*;
    use himmelcad_render::{
        alignment_geometry_version, AlignmentDaylightSample, AlignmentPreviewPartitionUpdate,
        AlignmentRoadBandPartition, AlignmentRoadBandSample, AlignmentSlopeSnapshot,
        AlignmentTargetSurfacePartition,
    };

    fn station_function(value: f64) -> StationFunction {
        StationFunction {
            samples: vec![
                StationValue {
                    station: 0.0,
                    value,
                },
                StationValue {
                    station: 100.0,
                    value,
                },
            ],
        }
    }

    fn alignment() -> AlignmentGeometry {
        AlignmentGeometry {
            horizontal: CurveGeometry::LineSegment {
                start: Position {
                    x: 0.0,
                    y: 0.0,
                    z: Some(0.0),
                },
                end: Position {
                    x: 100.0,
                    y: 0.0,
                    z: Some(0.0),
                },
            },
            vertical: vec![VerticalAlignmentSegment::Grade {
                start_station: 0.0,
                start_elevation: 100.0,
                grade: 0.01,
                length: 100.0,
            }],
            station_origin: 0.0,
            width_bands: vec![WidthBand {
                id: "carriageway".to_owned(),
                inner_offset: station_function(0.0),
                outer_offset: station_function(4.0),
            }],
            crossfall_bands: Vec::new(),
            slope_rules: Vec::new(),
        }
    }

    fn config() -> AlignmentPreviewConfig {
        AlignmentPreviewConfig {
            chord_tolerance: 0.01,
            maximum_curve_segments: 32,
            partition_length: 50.0,
            sample_step: 10.0,
            maximum_partitions_per_update: 2,
            maximum_samples_per_partition: 16,
            maximum_road_bands_per_partition: 4,
            maximum_slope_rules_per_partition: 4,
        }
    }

    fn build_request() -> AlignmentPreviewBuildRequest {
        let alignment = alignment();
        AlignmentPreviewBuildRequest {
            alignment_version: alignment_geometry_version(&alignment).unwrap(),
            alignment,
            targets: Vec::new(),
            config: config(),
        }
    }

    fn sloped_build_request() -> AlignmentPreviewBuildRequest {
        let mut alignment = alignment();
        alignment.slope_rules.push(SlopeRule {
            id: "fill-right".to_owned(),
            source_band_id: "carriageway".to_owned(),
            target_surface: EntityId("ground".to_owned()),
            cut_ratio: 0.5,
            fill_ratio: 0.5,
        });
        let alignment_version = alignment_geometry_version(&alignment).unwrap();
        let partitions = (0..2)
            .map(|index| {
                let start = f64::from(index) * 50.0;
                let end = start + 50.0;
                AlignmentTargetSurfacePartition {
                    index,
                    station_range: AlignmentStationRange { start, end },
                    slopes: vec![AlignmentSlopeSnapshot {
                        rule_id: "fill-right".to_owned(),
                        source_band_id: "carriageway".to_owned(),
                        samples: vec![
                            AlignmentDaylightSample {
                                station: start,
                                source_offset: 4.0,
                                source_elevation: 100.0 + start * 0.01,
                                target_offset: 8.0,
                                target_elevation: 98.0 + start * 0.01,
                            },
                            AlignmentDaylightSample {
                                station: end,
                                source_offset: 4.0,
                                source_elevation: 100.0 + end * 0.01,
                                target_offset: 8.0,
                                target_elevation: 98.0 + end * 0.01,
                            },
                        ],
                    }],
                }
            })
            .collect();
        AlignmentPreviewBuildRequest {
            alignment,
            alignment_version: alignment_version.clone(),
            targets: vec![AlignmentTargetSurfaceSnapshot {
                target_surface: EntityId("ground".to_owned()),
                target_surface_version: ObjectHash::of_bytes(b"ground-v1"),
                source_alignment_version: alignment_version,
                partitions,
            }],
            config: config(),
        }
    }

    fn partition(index: u32, outer: f64) -> AlignmentPreviewPartitionUpdate {
        let start = f64::from(index) * 50.0;
        let end = start + 50.0;
        let sample = |station: f64| AlignmentRoadBandSample {
            station,
            inner: Vector3 {
                x: station,
                y: 0.0,
                z: 100.0 + station * 0.01,
            },
            outer: Vector3 {
                x: station,
                y: outer,
                z: 100.0 + station * 0.01,
            },
        };
        AlignmentPreviewPartitionUpdate {
            index,
            station_range: AlignmentStationRange { start, end },
            road_body: vec![AlignmentRoadBandPartition {
                id: "carriageway".to_owned(),
                samples: vec![sample(start), sample(end)],
            }],
        }
    }

    fn update_request(
        expected_generation: u64,
        horizontal_path_version: ObjectHash,
        outer: f64,
    ) -> AlignmentPreviewUpdateRequest {
        AlignmentPreviewUpdateRequest {
            expected_generation,
            alignment_version: ObjectHash::of_bytes(format!("alignment-{outer}").as_bytes()),
            horizontal_path_version,
            partitions: vec![partition(0, outer)],
            targets: Vec::new(),
            affected: AlignmentStationRange {
                start: 0.0,
                end: 50.0,
            },
        }
    }

    #[test]
    fn build_serializes_complete_changed_render_partitions_and_stable_proxy_ids() {
        let mut store = AlignmentPreviewSessionStore::default();
        let response = store
            .build_json("road-a", &serde_json::to_string(&build_request()).unwrap())
            .unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        let expected_proxy_ids =
            partition_proxy_ids("road-a", &store.changed_partitions("road-a").unwrap());
        let response_proxy_ids: Vec<String> =
            serde_json::from_value(response["changedProxyIds"].clone()).unwrap();
        assert_eq!(response["previewId"], "road-a");
        assert_eq!(response["generation"], 0);
        assert_eq!(response["partitionCount"], 2);
        assert_eq!(response["changedPartitions"].as_array().unwrap().len(), 2);
        assert_eq!(response["changedProxyIds"].as_array().unwrap().len(), 2);
        assert_eq!(response_proxy_ids, expected_proxy_ids);
        assert_eq!(store.all_proxy_ids("road-a").unwrap(), expected_proxy_ids);
        assert_eq!(
            response["changedPartitions"][0]["roadBody"][0]["proxyId"],
            response["changedProxyIds"][0]
        );
        assert!(response["changedPartitions"][0]["roadBody"][0]["mesh"].is_object());
        assert_eq!(response["workload"]["partitions"], 2);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn stale_and_failed_updates_leave_the_active_generation_atomic() {
        let mut store = AlignmentPreviewSessionStore::default();
        let built: Value = serde_json::from_str(
            &store
                .build_json("road-a", &serde_json::to_string(&build_request()).unwrap())
                .unwrap(),
        )
        .unwrap();
        let path_version: ObjectHash =
            serde_json::from_value(built["horizontalPathVersion"].clone()).unwrap();
        let initial_partition_proxy = built["changedProxyIds"][0].clone();

        let stale = update_request(7, path_version.clone(), 5.0);
        assert!(store
            .update_json("road-a", &serde_json::to_string(&stale).unwrap())
            .unwrap_err()
            .contains("stale preview generation"));

        let mut invalid = update_request(0, path_version.clone(), 5.0);
        invalid.partitions[0].road_body[0].samples.truncate(1);
        assert!(store
            .update_json("road-a", &serde_json::to_string(&invalid).unwrap())
            .is_err());

        let first: Value = serde_json::from_str(
            &store
                .update_json(
                    "road-a",
                    &serde_json::to_string(&update_request(0, path_version.clone(), 5.0)).unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(first["generation"], 1);
        assert_eq!(first["changedPartitions"].as_array().unwrap().len(), 1);
        assert_eq!(first["changedProxyIds"].as_array().unwrap().len(), 1);
        assert_eq!(first["changedProxyIds"][0], initial_partition_proxy);

        let second: Value = serde_json::from_str(
            &store
                .update_json(
                    "road-a",
                    &serde_json::to_string(&update_request(1, path_version, 6.0)).unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(second["generation"], 2);
    }

    #[test]
    fn slope_render_partitions_retain_rule_and_target_provenance() {
        let mut store = AlignmentPreviewSessionStore::default();
        let response: Value = serde_json::from_str(
            &store
                .build_json(
                    "road-slope",
                    &serde_json::to_string(&sloped_build_request()).unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        let slope = &response["changedPartitions"][0]["slopes"][0];
        assert_eq!(slope["ruleId"], "fill-right");
        assert_eq!(slope["sourceBandId"], "carriageway");
        assert_eq!(slope["targetSurface"], "ground");
        assert!(slope["targetSurfaceVersion"].is_string());
        assert!(slope["geometryVersion"].is_string());
        assert!(slope["mesh"].is_object());
        assert_eq!(response["changedProxyIds"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn retire_removes_exactly_one_session() {
        let mut store = AlignmentPreviewSessionStore::default();
        store
            .build_json("road-a", &serde_json::to_string(&build_request()).unwrap())
            .unwrap();
        assert!(store.retire("road-a").unwrap());
        assert!(!store.retire("road-a").unwrap());
        assert_eq!(store.len(), 0);
    }
}
