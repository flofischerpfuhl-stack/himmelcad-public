//! Compatibility exports for the raster domain.

pub use himmelcad_domain_raster::raster_runtime::*;

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use himmelcad_domain_photogrammetry::photolab_jobs::{
        JobProgress, NewPhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
        PhotolabStage, PhotolabStageKind,
    };
    use himmelcad_model::hash::ObjectHash;
    use himmelcad_process::jobs::ProgressMetrics;
    use himmelcad_process::worker::{WorkerMemoryLimitMode, WorkerMemoryLimitPlan};

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn hash(value: &str) -> ObjectHash {
        ObjectHash::of_bytes(value.as_bytes())
    }

    fn crs() -> RasterCrs {
        RasterCrs {
            horizontal: "EPSG:25832".into(),
            vertical: Some("EPSG:7837".into()),
            gdal_srs: "EPSG:25832+7837".into(),
            canonical_wkt_sha256: hash("target-wkt"),
        }
    }

    fn grid() -> RasterGrid {
        RasterGrid {
            bounds: RasterBounds {
                minimum_east: 500_000.0,
                minimum_north: 5_399_488.0,
                maximum_east: 500_512.0,
                maximum_north: 5_400_000.0,
            },
            width_pixels: 512,
            height_pixels: 512,
            gsd: 1.0,
            no_data: RasterNoDataValue::Numeric(-9999.0),
        }
    }

    fn elevation_command(path: &Path, output: &Path) -> RasterBuildCommand {
        RasterBuildCommand {
            job_id: "raster-test".into(),
            config_hash: hash("config"),
            input_hash: hash("input"),
            output_directory: output.to_string_lossy().into_owned(),
            crs: crs(),
            grid: grid(),
            product: RasterProductRequest::Elevation(ElevationRasterRequest {
                surface: ElevationSurface::Dsm,
                interpolation: ElevationInterpolation::Maximum {
                    radius: 1.5,
                    minimum_points: 1,
                },
                view_range: ElevationViewRange {
                    minimum_elevation: 400.0,
                    maximum_elevation: 600.0,
                },
                tiles: vec![ElevationInputTile {
                    tile_id: "tile-0-0".into(),
                    column: 0,
                    row: 0,
                    bounds: grid().bounds,
                    crs: crs(),
                    source: ElevationGeometrySource::Points {
                        path: path.to_string_lossy().into_owned(),
                        layer: "points".into(),
                        elevation_field: "elevation".into(),
                        classification_field: Some("classification".into()),
                        accepted_classifications: vec![2],
                    },
                }],
            }),
        }
    }

    #[cfg(unix)]
    fn install_fake_tools(
        directory: &Path,
        log: &Path,
        slow: bool,
        allocate_memory: bool,
    ) -> Vec<PathBuf> {
        let delay = if slow { "exec /bin/sleep 5" } else { ":" };
        let allocation = if allocate_memory {
            // Four MiB retained for 200 ms is enough for the 20 ms process-group sampler
            // without making this runtime-path gate expensive.
            "memory=$(/usr/bin/head -c 4194304 /dev/zero | /usr/bin/tr '\\000' x)\n/bin/sleep 0.2\n: \"$memory\""
        } else {
            ":"
        };
        let script = format!(
            r#"#!/bin/sh
name=${{0##*/}}
printf '%s|%s|%s\n' "$name" "$(ulimit -v)" "$PPID" >> '{log}'
{allocation}
if [ "$1" = "--version" ]; then
  printf '%s\n' 'GDAL 3.8.4, released 2024/02/08'
  exit 0
fi
if [ "$1" = "--formats" ]; then
  printf '%s\n' 'GTiff COG VRT PNG ENVI GPKG FlatGeobuf'
  exit 0
fi
if [ "$name" = "ogrinfo" ]; then
  printf '%s\n' '{{"driverShortName":"FlatGeobuf","layers":[{{"geometryFields":[{{"coordinateSystem":{{"wkt":"target-wkt"}}}}]}}]}}'
  exit 0
fi
last=
for argument in "$@"; do last=$argument; done
if [ "$name" = "gdalinfo" ]; then
  case "$last" in
    *product.cog.tif)
      printf '%s\n' '{{"driverShortName":"GTiff","size":[512,512],"coordinateSystem":{{"wkt":"target-wkt"}},"geoTransform":[500000.0,1.0,0.0,5400000.0,0.0,-1.0],"metadata":{{"IMAGE_STRUCTURE":{{"LAYOUT":"COG"}}}},"bands":[{{"noDataValue":-9999.0}}]}}'
      ;;
    *) printf '%s\n' '{{"driverShortName":"VRT","coordinateSystem":{{"wkt":"target-wkt"}}}}' ;;
  esac
  exit 0
fi
printf '%s|%s|%s|' "$name" "$PROJ_NETWORK" "$GDAL_DRIVER_PATH" >> '{log}'
for argument in "$@"; do printf '%s ' "$argument" >> '{log}'; done
printf '\n' >> '{log}'
{delay}
case "$last" in
  *.f32) dd if=/dev/zero of="$last" bs=1048576 count=1 status=none ;;
  *) printf '%s\n' 'fake GDAL output' > "$last" ;;
esac
"#,
            log = log.display(),
            delay = delay,
            allocation = allocation,
        );
        [
            "gdal_grid",
            "gdal_rasterize",
            "gdalwarp",
            "gdalbuildvrt",
            "gdal_translate",
            "gdalinfo",
            "ogrinfo",
            "ogr2ogr",
        ]
        .into_iter()
        .map(|name| {
            let path = directory.join(name);
            fs::write(&path, &script).expect("fake tool script");
            let mut permissions = fs::metadata(&path).expect("fake metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).expect("fake executable permissions");
            path
        })
        .collect()
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn fake_dem_runtime_scopes_and_samples_every_gdal_child() {
        use crate::job_runtime::{
            JobAdmission, JobManager, JobManagerConfig, JobWorkerError, MemoryPreflight,
        };

        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build/codex-scratch/a7jc")
            .join(format!(
                "fake-dem-runtime-{}-{sequence}",
                std::process::id()
            ));
        let tools = root.join("tools");
        let input = root.join("input");
        let staging = root.join("staging");
        let output_root = root.join("output");
        let data = root.join("gdal-data");
        let proj = root.join("proj-data");
        for directory in [&tools, &input, &staging, &output_root, &data, &proj] {
            fs::create_dir_all(directory).expect("test directory");
        }
        let log = root.join("gdal.log");
        let tool_paths = install_fake_tools(&tools, &log, false, true);
        let fake_ogr2ogr = tool_paths[7].clone();
        let points = input.join("points.fgb");
        fs::write(&points, b"fake FlatGeobuf").expect("fake input");
        let runtime = RasterRuntime::open(GdalToolchainConfig {
            gdal_grid_path: tool_paths[0].clone(),
            gdal_rasterize_path: tool_paths[1].clone(),
            gdalwarp_path: tool_paths[2].clone(),
            gdalbuildvrt_path: tool_paths[3].clone(),
            gdal_translate_path: tool_paths[4].clone(),
            gdalinfo_path: tool_paths[5].clone(),
            ogrinfo_path: tool_paths[6].clone(),
            gdal_data_directory: data,
            proj_data_directory: proj,
            allowed_input_roots: vec![input],
            staging_root: staging,
            allowed_output_roots: vec![output_root.clone()],
            max_parallel_processes: 4,
            threads_per_process: 2,
        })
        .expect("fake runtime");
        let destination = output_root.join("published");
        let command = elevation_command(&points, &destination);
        let plan = crate::job_runtime::plan_raster_preparation_memory(1, 1, 4 * 1024 * 1024 * 1024);
        let ogr_plan = plan.ogr2ogr;
        let gdal_plan = plan.gdal_grid;
        let memory = plan.memory.clone();
        let ogr_explicit_limit = ogr_plan.resident_limit_bytes.saturating_mul(2);
        let gdal_explicit_limit = gdal_plan.resident_limit_bytes.saturating_mul(2);
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("fake DEM manager");
        let job_id = PhotolabJobId("fake-dem-runtime-memory".into());
        let handle = tokio::runtime::Handle::current();
        manager
            .start_with_admission(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::BuildDem,
                    config_hash: ObjectHash::of_bytes(b"fake-dem-runtime-config"),
                    input_hash: ObjectHash::of_bytes(b"fake-dem-runtime-input"),
                    progress: JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Preparing,
                            index: 0,
                            stage_count: 1,
                            label: "Prepare DEM".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    },
                },
                JobAdmission {
                    memory_preflight: Some(MemoryPreflight {
                        predicted_bytes: plan.predicted_peak_bytes,
                        available_bytes: memory.envelope_bytes,
                        machine_usable_bytes: memory.envelope_bytes,
                        memory,
                        refusal: None,
                    }),
                    ..Default::default()
                },
                move |context| {
                    crate::dense_raster_prep::run_fake_gdal_stage_with_memory(
                        &fake_ogr2ogr,
                        &["--version".into()],
                        &context.cancellation,
                        ogr_plan,
                        &context.memory,
                        WorkerMemoryLimitPlan {
                            mode: WorkerMemoryLimitMode::RlimitAs,
                            enforced_limit_bytes: ogr_explicit_limit,
                        },
                    )
                    .map_err(|error| JobWorkerError::Failed {
                        code: "fakeDemOgr".into(),
                        message: error.to_string(),
                    })?;
                    let runtime_memory =
                        RasterRuntimeMemory::new(gdal_plan, context.memory.clone())
                            .with_worker_plan_override(WorkerMemoryLimitPlan {
                                mode: WorkerMemoryLimitMode::RlimitAs,
                                enforced_limit_bytes: gdal_explicit_limit,
                            });
                    handle
                        .block_on(runtime.execute(
                            &command,
                            &context.cancellation,
                            None,
                            Some(runtime_memory),
                            |_| {},
                        ))
                        .map(|_| ())
                        .map_err(|error| JobWorkerError::Failed {
                            code: "fakeDemRuntime".into(),
                            message: error.to_string(),
                        })
                },
            )
            .await
            .expect("start fake DEM runtime");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("fake DEM runtime terminal record");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        for (stage_plan, expected_limit) in [
            (ogr_plan, ogr_explicit_limit),
            (gdal_plan, gdal_explicit_limit),
        ] {
            let stage = terminal
                .memory
                .stages
                .iter()
                .find(|stage| stage.stage == stage_plan.stage)
                .expect("bounded GDAL memory stage");
            assert_eq!(stage.parameters["workerMemoryLimitMode"], "rlimitAs");
            assert_eq!(stage.parameters["workerMemoryLimitBytes"], expected_limit);
            assert!(stage.peak_rss_bytes > 0, "fake tool must be sampled");
        }

        let log_text = fs::read_to_string(&log).expect("fake GDAL log");
        let expected_virtual_kib = (gdal_explicit_limit / 1024).to_string();
        for tool in [
            "gdal_grid",
            "gdal_rasterize",
            "gdalwarp",
            "gdalbuildvrt",
            "gdal_translate",
            "gdalinfo",
            "ogrinfo",
            "ogr2ogr",
        ] {
            assert!(
                log_text.lines().any(|line| {
                    let mut fields = line.split('|');
                    fields.next() == Some(tool)
                        && fields.next() == Some(expected_virtual_kib.as_str())
                }),
                "{tool} did not run under the frozen worker limit"
            );
        }
        fs::remove_dir_all(root).expect("test cleanup");
    }
}
