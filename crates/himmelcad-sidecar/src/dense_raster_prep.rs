//! Compatibility exports and upper job-manager tests for dense raster preparation.

#[cfg(test)]
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(test)]
use himmelcad_core::hash::ObjectHash;
#[cfg(test)]
use himmelcad_core::photolab_jobs::CancellationToken;
#[cfg(test)]
use himmelcad_process::worker::{WorkerMemoryLimitMode, WorkerMemoryLimitPlan};
#[cfg(test)]
use himmelcad_spatial::ground_classification::PointClass;

pub use himmelcad_domain_raster::dense_raster_prep::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    fn command_argv(command: &Command) -> Vec<String> {
        std::iter::once(command.get_program())
            .chain(command.get_args())
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ogr2ogr_and_gdal_grid_scope_commands_use_hard_memory_max() {
        for executable in ["/fake/ogr2ogr", "/fake/gdal_grid"] {
            let plan = WorkerMemoryLimitPlan {
                mode: WorkerMemoryLimitMode::CgroupScope,
                enforced_limit_bytes: 12_345_678,
            };
            let command = himmelcad_process::worker::worker_command_for_plan(
                Path::new("/fake/systemd-run"),
                Path::new(executable),
                plan,
            );
            assert_eq!(
                command_argv(&command),
                [
                    "/fake/systemd-run",
                    "--user",
                    "--scope",
                    "--quiet",
                    "-p",
                    "MemoryMax=12345678",
                    "-p",
                    "MemorySwapMax=0",
                    "--collect",
                    "--",
                    "/usr/bin/prlimit",
                    "--core=0",
                    "--",
                    executable,
                ]
            );
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ogr2ogr_and_gdal_grid_fallback_commands_use_double_rlimit_as() {
        for executable in ["/fake/ogr2ogr", "/fake/gdal_grid"] {
            let plan = WorkerMemoryLimitPlan {
                mode: WorkerMemoryLimitMode::RlimitAs,
                enforced_limit_bytes: 24_691_356,
            };
            let command = himmelcad_process::worker::worker_command_for_plan(
                Path::new("/usr/bin/prlimit"),
                Path::new(executable),
                plan,
            );
            assert_eq!(
                command_argv(&command),
                ["/usr/bin/prlimit", "--as=24691356", "--", executable,]
            );
        }
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn fake_dem_job_records_bounded_ogr2ogr_and_gdal_grid_stages() {
        use crate::job_runtime::{
            plan_raster_preparation_memory, JobAdmission, JobManager, JobManagerConfig,
            MemoryPreflight,
        };
        use himmelcad_core::{
            hash::ObjectHash,
            photolab_jobs::{
                JobProgress, NewPhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
                PhotolabStage, PhotolabStageKind, ProgressMetrics,
            },
        };

        let plan = plan_raster_preparation_memory(1, 1, 4 * 1024 * 1024 * 1024);
        let execution_plan = plan.clone();
        let memory = plan.memory.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("fake DEM manager");
        let job_id = PhotolabJobId("fake-dem-memory".into());
        manager
            .start_with_admission(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::BuildDem,
                    config_hash: ObjectHash::of_bytes(b"fake-dem-config"),
                    input_hash: ObjectHash::of_bytes(b"fake-dem-input"),
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
                    for stage in [execution_plan.ogr2ogr, execution_plan.gdal_grid] {
                        let enforced_limit_bytes = stage.resident_limit_bytes.saturating_mul(2);
                        run_gdal_command_inner(
                            Path::new("/bin/true"),
                            &[],
                            None,
                            None,
                            &context.cancellation,
                            Some(GdalCommandMemory {
                                plan: stage,
                                sink: &context.memory,
                            }),
                            Some(WorkerMemoryLimitPlan {
                                mode: WorkerMemoryLimitMode::RlimitAs,
                                enforced_limit_bytes,
                            }),
                        )
                        .map_err(|error| {
                            crate::job_runtime::JobWorkerError::Failed {
                                code: "fakeDem".into(),
                                message: error.to_string(),
                            }
                        })?;
                    }
                    Ok(())
                },
            )
            .await
            .expect("start fake DEM");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("fake DEM terminal record");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert!(terminal.memory.observations.is_empty());
        for stage_plan in [plan.ogr2ogr, plan.gdal_grid] {
            let stage = terminal
                .memory
                .stages
                .iter()
                .find(|stage| stage.stage == stage_plan.stage)
                .expect("bounded preparation stage");
            assert_eq!(stage.parameters["modelBytes"], stage_plan.model_bytes);
            assert_eq!(stage.parameters["workerMemoryLimitMode"], "rlimitAs");
            assert_eq!(
                stage.parameters["workerMemoryLimitBytes"],
                stage_plan.resident_limit_bytes.saturating_mul(2)
            );
        }
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn fake_dem_memory_kill_records_typed_failure_and_degradation() {
        use crate::job_runtime::{
            plan_raster_preparation_memory, JobAdmission, JobManager, JobManagerConfig,
            JobWorkerError, MemoryPreflight,
        };
        use himmelcad_core::{
            hash::ObjectHash,
            photolab_jobs::{
                JobProgress, NewPhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
                PhotolabMemoryDegradation, PhotolabStage, PhotolabStageKind, ProgressMetrics,
            },
        };

        let plan = plan_raster_preparation_memory(1, 1, 4 * 1024 * 1024 * 1024);
        let stage = plan.gdal_grid;
        let memory = plan.memory.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("fake DEM manager");
        let job_id = PhotolabJobId("fake-dem-memory-kill".into());
        manager
            .start_with_admission(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::BuildDem,
                    config_hash: ObjectHash::of_bytes(b"fake-dem-kill-config"),
                    input_hash: ObjectHash::of_bytes(b"fake-dem-kill-input"),
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
                    let enforced_limit_bytes = stage.resident_limit_bytes.saturating_mul(2);
                    let error = run_gdal_command_inner(
                        Path::new("/bin/sh"),
                        &["-c".into(), "kill -9 $$".into()],
                        None,
                        None,
                        &context.cancellation,
                        Some(GdalCommandMemory {
                            plan: stage,
                            sink: &context.memory,
                        }),
                        Some(WorkerMemoryLimitPlan {
                            mode: WorkerMemoryLimitMode::RlimitAs,
                            enforced_limit_bytes,
                        }),
                    )
                    .expect_err("fake gdal_grid must be killed");
                    match error {
                        memory_error @ DenseRasterPrepError::WorkerMemoryLimit { .. } => {
                            Err(JobWorkerError::Failed {
                                code: "workerMemoryLimit".into(),
                                message: memory_error.to_string(),
                            })
                        }
                        other => Err(JobWorkerError::Failed {
                            code: "unexpected".into(),
                            message: other.to_string(),
                        }),
                    }
                },
            )
            .await
            .expect("start fake DEM memory kill");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("fake DEM kill terminal record");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "workerMemoryLimit"
        ));
        assert!(terminal
            .memory
            .degradations
            .iter()
            .any(|degradation| matches!(
                degradation,
                PhotolabMemoryDegradation::WorkerMemoryLimitHit { stage: recorded, .. }
                    if recorded == stage.stage
            )));
    }

    #[test]
    fn parses_colmap_sparse_points_without_losing_world_precision() {
        let point = parse_colmap_sparse_point(
            "42 500000.123456789 5400000.987654321 412.125 12 34 56 0.25 1 2",
        )
        .expect("valid record")
        .expect("point");
        assert!((point.coordinate[0] - 500_000.123_456_789).abs() < f64::EPSILON);
        assert!((point.coordinate[1] - 5_400_000.987_654_321).abs() < f64::EPSILON);
        assert_eq!(point.color, [12, 34, 56]);
        assert!((point.reprojection_error - 0.25).abs() < f64::EPSILON);
        assert!(parse_colmap_sparse_point("# comment").unwrap().is_none());
        assert!(parse_colmap_sparse_point("1 nan 2 3 4 5 6 0.1").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn gdal_arguments_strip_windows_verbatim_prefixes() {
        assert_eq!(
            external_tool_argument(r"\\?\C:\project\dense.csv"),
            r"C:\project\dense.csv"
        );
        assert_eq!(
            external_tool_argument(r"\\?\UNC\server\share\dense.csv"),
            r"\\server\share\dense.csv"
        );
        assert_eq!(external_tool_argument("EPSG:31468"), "EPSG:31468");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn gdal_failure_carries_command_code_and_stderr_verbatim() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("hcad-gdal-failure-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("fake_gdal_failure");
        fs::write(
            &executable,
            b"#!/bin/sh\nprintf 'captured stdout\\n'\nprintf 'known GDAL stderr line\\n' >&2\nexit 1\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();

        let error = run_owned_command(
            &executable,
            &["--known-argument".into()],
            &CancellationToken::new(),
        )
        .expect_err("fake GDAL command must fail");
        match error {
            DenseRasterPrepError::GdalFailed {
                command,
                code,
                stderr_tail,
            } => {
                assert!(command.contains("fake_gdal_failure"));
                assert!(command.contains("--known-argument"));
                assert_eq!(code, Some(1));
                assert_eq!(stderr_tail, "known GDAL stderr line\n");
            }
            other => panic!("unexpected error: {other}"),
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ogr2ogr_uses_the_job_raster_input_directory_for_gdal_temp() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "hcad-gdal-temp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("test root");
        let dense_ply = root.join("dense.ply");
        let mut dense = File::create(&dense_ply).expect("dense fixture");
        dense
            .write_all(b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\nend_header\n")
            .expect("PLY header");
        for value in [500_000.0_f64, 5_400_000.0, 100.0] {
            dense.write_all(&value.to_le_bytes()).expect("coordinate");
        }
        dense.write_all(&[1, 2, 3]).expect("colour");
        dense.write_all(&1.0_f32.to_le_bytes()).expect("confidence");
        drop(dense);

        let fake_ogr2ogr = root.join("ogr2ogr");
        fs::write(
            &fake_ogr2ogr,
            b"#!/bin/sh\nprintf '%s\\n%s\\n' \"$CPL_TMPDIR\" \"$GDAL_TMPDIR\" > \"$CPL_TMPDIR/invocation.txt\"\n: > \"$3\"\n",
        )
        .expect("fake ogr2ogr");
        let mut permissions = fs::metadata(&fake_ogr2ogr).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_ogr2ogr, permissions).unwrap();

        let output_root = root.join("raster-inputs/job-1");
        let vector = prepare_dense_vector(
            &dense_ply,
            &output_root,
            &fake_ogr2ogr,
            "EPSG:25832",
            &CancellationToken::new(),
        )
        .expect("prepare dense vector");
        assert_eq!(vector.point_count, 1);
        assert_eq!(
            fs::read_to_string(output_root.join("invocation.txt")).expect("captured environment"),
            format!("{0}\n{0}\n", output_root.display())
        );
        assert!(!output_root.join("dense.csv").exists());
        assert!(output_root.join("dense.fgb").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn las_header_bounds_include_quantized_sparse_extrema() {
        let minimum = [
            600_717.888_652_278_2,
            5_279_110.353_927_144,
            737.980_228_639_967_7,
        ];
        let maximum = [
            600_773.938_272_826_6,
            5_279_166.403_547_692,
            794.029_849_188_347_3,
        ];
        let scale = [0.001; 3];
        let mut header = Vec::new();
        write_las_header(&mut header, 1, minimum, maximum, scale, "test").unwrap();
        for (axis, offset) in [179, 195, 211].into_iter().enumerate() {
            let header_max = f64::from_le_bytes(header[offset..offset + 8].try_into().unwrap());
            let stored_max = minimum[axis]
                + f64::from(quantize_las_coordinate(
                    maximum[axis],
                    minimum[axis],
                    scale[axis],
                )) * scale[axis];
            assert_eq!(header_max, stored_max);
            assert!(header_max >= stored_max);
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn sparse_preparation_builds_potree_and_portable_ply() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("hcad-sparse-prep-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let points = root.join("points3D.txt");
        fs::write(
            &points,
            "# points\n1 500000.125 5400000.25 100.5 255 0 0 0.2 1 0\n2 500001.5 5400002.75 102.0 0 255 32 0.4 2 0\n",
        )
        .unwrap();
        let converter = root.join("PotreeConverter");
        fs::write(
            &converter,
            r#"#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
mkdir -p "$out"
printf '%s' '{"points":2,"offset":[500000,5400000,100],"boundingBox":{"min":[500000.125,5400000.25,100.5],"max":[500001.5,5400002.75,102.0]}}' > "$out/metadata.json"
: > "$out/hierarchy.bin"
: > "$out/octree.bin"
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&converter).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&converter, permissions).unwrap();
        let output = root.join("prepared");
        let prepared =
            prepare_sparse_potree(&points, &output, &converter, &CancellationToken::new())
                .expect("prepare sparse point cloud");
        assert_eq!(prepared.point_count, 2);
        assert_eq!(
            prepared.relative_metadata_path,
            PathBuf::from("octree/metadata.json")
        );
        assert_eq!(
            prepared.export_relative_path,
            Some(PathBuf::from("export.ply"))
        );
        assert!(prepared
            .bounds_min
            .iter()
            .zip([500_000.125, 5_400_000.25, 100.5])
            .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON));
        let export = fs::read(output.join("export.ply")).expect("portable PLY");
        assert!(export
            .windows(b"element vertex 2".len())
            .any(|window| window == b"element vertex 2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_non_ply_header() {
        let root = std::env::temp_dir().join(format!("hcad-dense-prep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("bad.ply"), b"not ply\n").unwrap();
        assert!(matches!(
            ply_to_csv(
                &root.join("bad.ply"),
                &root.join("x.csv"),
                None,
                &CancellationToken::new()
            ),
            Err(DenseRasterPrepError::InvalidPly(_))
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dense_layout_accepts_legacy_and_normal_enriched_vertices() {
        let legacy = "element vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\nend_header\n";
        let legacy = ply_vertex_layout(legacy).expect("legacy layout");
        assert_eq!(legacy.stride, 19);
        assert_eq!(legacy.coordinate_kind, PlyCoordinateKind::Float32);
        assert_eq!(required_dense_attributes(legacy).unwrap(), (12, 13, 14, 15));

        let enriched = format!(
            "{}property float nx\nproperty float ny\nproperty float nz\nend_header\n",
            legacy_header_without_end()
        );
        let enriched = ply_vertex_layout(&enriched).expect("normal layout");
        assert_eq!(enriched.stride, 31);
        assert_eq!(
            required_dense_attributes(enriched).unwrap(),
            (12, 13, 14, 15)
        );

        let double_header = "element vertex 1\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\nproperty float nx\nproperty float ny\nproperty float nz\nend_header\n";
        let double = ply_vertex_layout(double_header).expect("double layout");
        assert_eq!(double.stride, 43);
        assert_eq!(double.coordinate_kind, PlyCoordinateKind::Float64);
        assert_eq!(required_dense_attributes(double).unwrap(), (24, 25, 26, 27));
    }

    fn legacy_header_without_end() -> &'static str {
        "element vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\n"
    }

    #[test]
    fn double_coordinates_survive_las_roundtrip_at_projected_crs_magnitudes() {
        let root = std::env::temp_dir().join(format!(
            "hcad-dense-double-las-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let ply = root.join("dense.ply");
        let mut file = File::create(&ply).unwrap();
        // Absolute GK4-scale coordinates: float32 would quantize XY to ~0.5 m.
        file.write_all(b"ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\nend_header\n").unwrap();
        let points = [
            (
                [4_467_123.456_7_f64, 5_376_890.123_4_f64, 742.015_6_f64],
                [255_u8, 0, 0],
            ),
            (
                [4_467_123.789_1_f64, 5_376_890.456_8_f64, 742.348_9_f64],
                [0, 255, 0],
            ),
        ];
        for (coords, color) in points {
            for value in coords {
                file.write_all(&value.to_le_bytes()).unwrap();
            }
            file.write_all(&color).unwrap();
            file.write_all(&0.9_f32.to_le_bytes()).unwrap();
        }
        drop(file);

        let las = root.join("dense.las");
        ply_to_las(&ply, &las, &CancellationToken::new()).expect("las conversion");
        let bytes = fs::read(&las).expect("las bytes");
        assert!(bytes.len() >= 227 + 2 * 26);
        let scale = [
            f64::from_le_bytes(bytes[131..139].try_into().unwrap()),
            f64::from_le_bytes(bytes[139..147].try_into().unwrap()),
            f64::from_le_bytes(bytes[147..155].try_into().unwrap()),
        ];
        let offset = [
            f64::from_le_bytes(bytes[155..163].try_into().unwrap()),
            f64::from_le_bytes(bytes[163..171].try_into().unwrap()),
            f64::from_le_bytes(bytes[171..179].try_into().unwrap()),
        ];
        assert!(scale.iter().all(|value| (*value - 0.001).abs() < 1e-12));
        for (index, (coords, _)) in points.iter().enumerate() {
            let start = 227 + index * 26;
            let quantized = [
                i32::from_le_bytes(bytes[start..start + 4].try_into().unwrap()),
                i32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()),
                i32::from_le_bytes(bytes[start + 8..start + 12].try_into().unwrap()),
            ];
            for axis in 0..3 {
                let recovered = offset[axis] + f64::from(quantized[axis]) * scale[axis];
                assert!(
                    (recovered - coords[axis]).abs() < 0.001,
                    "axis {axis}: recovered {recovered} vs {}",
                    coords[axis]
                );
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn classification_sidecar_is_content_addressed_and_current_is_repointed() {
        let root =
            std::env::temp_dir().join(format!("hcad-dense-classification-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let dense_ply = root.join("dense.ply");
        fs::write(&dense_ply, b"placeholder").unwrap();
        let classes = [
            PointClass::Ground,
            PointClass::Unclassified,
            PointClass::Ground,
        ];
        let cancellation = CancellationToken::new();
        let hash = persist_dense_classification(&dense_ply, "first", &classes, &cancellation)
            .expect("publish classification");
        assert_eq!(hash, ObjectHash::of_bytes(&[2, 1, 2]));
        assert_eq!(
            fs::read(root.join("dense.classification.bin")).unwrap(),
            [2, 1, 2]
        );
        persist_dense_classification(&dense_ply, "reuse", &classes, &cancellation)
            .expect("reuse identical classification");
        assert!(root.join(classification_artifact_name(&hash)).is_file());
        // A DTM rebuilt with other SMRF parameters adds a second immutable
        // artifact and repoints the current file; nothing is overwritten.
        let other = persist_dense_classification(
            &dense_ply,
            "other-parameters",
            &[PointClass::Ground; 3],
            &cancellation,
        )
        .expect("second classification is content-addressed");
        assert_ne!(other, hash);
        assert_eq!(
            fs::read(root.join(classification_artifact_name(&hash))).unwrap(),
            [2, 1, 2]
        );
        assert_eq!(
            fs::read(root.join(classification_artifact_name(&other))).unwrap(),
            [2, 2, 2]
        );
        assert_eq!(
            fs::read(root.join("dense.classification.bin")).unwrap(),
            [2, 2, 2]
        );
        // Tampered immutable bytes are still detected on reuse.
        fs::write(root.join(classification_artifact_name(&other)), [2, 1, 1]).unwrap();
        let conflict = persist_dense_classification(
            &dense_ply,
            "tampered",
            &[PointClass::Ground; 3],
            &cancellation,
        )
        .expect_err("immutable conflict");
        assert!(matches!(
            conflict,
            DenseRasterPrepError::ClassificationConflict
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn system_gdal_accepts_the_streamed_flatgeobuf() {
        if !Path::new("/usr/bin/ogr2ogr").is_file() || !Path::new("/usr/bin/ogrinfo").is_file() {
            return;
        }
        let root =
            std::env::temp_dir().join(format!("hcad-dense-prep-gdal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let ply = root.join("dense.ply");
        let mut file = File::create(&ply).unwrap();
        file.write_all(b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float confidence\nend_header\n").unwrap();
        for (x, y, z, color) in [
            (500_000.125_f64, 5_400_000.25_f64, 100.5_f64, [255, 0, 0]),
            (500_001.5_f64, 5_400_000.0_f64, 101.0_f64, [0, 255, 0]),
            (500_000.0_f64, 5_400_001.75_f64, 102.0_f64, [0, 0, 255]),
        ] {
            for value in [x, y, z] {
                file.write_all(&value.to_le_bytes()).unwrap();
            }
            file.write_all(&color).unwrap();
            file.write_all(&1_f32.to_le_bytes()).unwrap();
        }
        drop(file);
        let cancellation = CancellationToken::new();
        let classifications = [
            PointClass::Ground,
            PointClass::Unclassified,
            PointClass::Ground,
        ];
        let vector = prepare_dense_vector_with_classification(
            &ply,
            &root.join("vector"),
            Path::new("/usr/bin/ogr2ogr"),
            "EPSG:25832",
            Some(&classifications),
            &cancellation,
        )
        .unwrap();
        assert_eq!(vector.point_count, 3);
        // GDAL >= 3.7: `-json` nests features under `layers[]` and only lists
        // them with `-features`.
        let layer = Command::new("/usr/bin/ogrinfo")
            .args(["-json", "-features"])
            .arg(&vector.flatgeobuf_path)
            .output()
            .expect("ogrinfo classification");
        assert!(layer.status.success());
        let layer: serde_json::Value = serde_json::from_slice(&layer.stdout).unwrap();
        let actual = layer["layers"][0]["features"]
            .as_array()
            .unwrap_or_else(|| panic!("ogrinfo json without features: {layer}"))
            .iter()
            .map(|feature| {
                let class = feature["properties"]["classification"].as_i64().unwrap();
                let z = feature["properties"]["z"].as_f64().unwrap();
                (z.to_bits(), class)
            })
            .collect::<Vec<_>>();
        // FlatGeobuf writes a spatial index and reorders features, so match
        // classes to points through their elevation rather than input order.
        let mut actual = actual;
        actual.sort_unstable();
        assert_eq!(
            actual,
            vec![
                (100.5_f64.to_bits(), 2),
                (101.0_f64.to_bits(), 1),
                (102.0_f64.to_bits(), 2)
            ]
        );
        let wkt =
            inspect_vector_wkt(Path::new("/usr/bin/ogrinfo"), &vector, &cancellation).unwrap();
        assert!(wkt.contains("ETRS89"));
        let converter = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../vendor/potreeconverter/linux-x64/PotreeConverter");
        if converter.is_file() {
            let potree =
                prepare_dense_potree(&ply, &root.join("potree"), &converter, &cancellation)
                    .unwrap();
            assert_eq!(potree.point_count, 3);
            assert!(root.join("potree/octree/metadata.json").is_file());
        }
        let _ = fs::remove_dir_all(root);
    }
}
