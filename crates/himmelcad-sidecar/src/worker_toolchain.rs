//! Admission-time inventory for external PhotoLab product workers.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use himmelcad_core::photolab_jobs::{PhotolabJobKind, PhotolabWorkerTool};

use crate::job_runtime::{JobAdmissionRefusal, WorkerToolchainAdmission};

pub const WORKER_TOOLCHAIN_MISSING_CODE: &str = "workerToolchainMissing";

/// Product stages whose external workers must be available before admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerProduct {
    Colmap,
    Alignment { dedode: bool },
    DepthMaps,
    DensePointCloud,
    Dem,
    Orthomosaic,
    Mesh { requires_colmap: bool },
    GaussianSplat,
}

/// Typed missing-worker reason retained until it is converted to job refusal state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerToolchainMissing {
    pub tool: String,
    pub expected_paths: Vec<PathBuf>,
    pub job_kind: PhotolabJobKind,
}

impl WorkerToolchainMissing {
    #[must_use]
    pub fn admission_refusal(&self) -> JobAdmissionRefusal {
        let expected = self.expected_paths.first().map_or_else(
            || "the staged worker runtime".into(),
            |path| path.display().to_string(),
        );
        JobAdmissionRefusal {
            code: WORKER_TOOLCHAIN_MISSING_CODE.into(),
            message: format!(
                "{} is missing — expected at {expected}; install or stage the worker runtime",
                self.tool
            ),
        }
    }
}

/// Complete admission result, including tools found before a fail-closed refusal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkerToolchainPreflight {
    pub tools: Vec<PhotolabWorkerTool>,
    pub refusal: Option<WorkerToolchainMissing>,
}

impl WorkerToolchainPreflight {
    #[must_use]
    pub fn into_admission(self) -> WorkerToolchainAdmission {
        WorkerToolchainAdmission {
            tools: self.tools,
            refusal: self
                .refusal
                .as_ref()
                .map(WorkerToolchainMissing::admission_refusal),
        }
    }
}

/// Resolves every external executable needed by the selected product chain.
///
/// This deliberately performs only bounded filesystem checks. Worker-specific
/// runtime construction retains its existing version/trust probe and supplies
/// versions there; admission must not launch subprocesses on the RPC path.
#[must_use]
pub fn worker_toolchain_preflight(
    job_kind: PhotolabJobKind,
    products: &[WorkerProduct],
) -> WorkerToolchainPreflight {
    worker_toolchain_preflight_with(&ResolutionContext::system(), job_kind, products)
}

#[derive(Debug, Clone)]
struct ToolRequirement {
    name: &'static str,
    expected_paths: Vec<PathBuf>,
    executable: bool,
}

#[derive(Debug, Clone)]
struct ResolutionContext {
    workspace_root: PathBuf,
    executable_dir: PathBuf,
    executable_suffix: &'static str,
    platform_directory: &'static str,
    environment: BTreeMap<OsString, OsString>,
}

impl ResolutionContext {
    fn system() -> Self {
        let environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
        let current_directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let executable = std::env::current_exe().ok();
        let executable_dir = executable
            .as_deref()
            .and_then(Path::parent)
            .map_or_else(|| current_directory.clone(), Path::to_path_buf);
        let workspace_root = environment
            .get(OsStr::new("HIMMELCAD_WORKSPACE_ROOT"))
            .map(PathBuf::from)
            .or_else(|| {
                executable
                    .as_deref()
                    .into_iter()
                    .flat_map(Path::ancestors)
                    .chain(current_directory.ancestors())
                    .find(|ancestor| {
                        ancestor.join("pnpm-workspace.yaml").is_file()
                            && ancestor.join("Cargo.toml").is_file()
                    })
                    .map(Path::to_path_buf)
            })
            .unwrap_or(current_directory);
        Self {
            workspace_root,
            executable_dir,
            executable_suffix: if cfg!(windows) { ".exe" } else { "" },
            platform_directory: if cfg!(windows) {
                "win32-x64"
            } else {
                "linux-x64"
            },
            environment,
        }
    }

    fn environment_path(&self, name: &str) -> Option<PathBuf> {
        self.environment.get(OsStr::new(name)).map(PathBuf::from)
    }

    fn executable_name(&self, stem: &str) -> String {
        format!("{stem}{}", self.executable_suffix)
    }

    fn overridden_or(&self, variable: &str, fallback: PathBuf) -> Vec<PathBuf> {
        vec![self.environment_path(variable).unwrap_or(fallback)]
    }

    fn colmap(&self) -> ToolRequirement {
        ToolRequirement {
            name: "COLMAP",
            expected_paths: self.overridden_or(
                "HIMMELCAD_COLMAP_EXECUTABLE",
                self.workspace_root
                    .join("vendor/colmap")
                    .join(self.platform_directory)
                    .join("bin")
                    .join(self.executable_name("colmap")),
            ),
            executable: true,
        }
    }

    fn potree(&self) -> ToolRequirement {
        ToolRequirement {
            name: "PotreeConverter",
            expected_paths: self.overridden_or(
                "HIMMELCAD_POTREE_CONVERTER",
                self.workspace_root
                    .join("vendor/potreeconverter")
                    .join(self.platform_directory)
                    .join(self.executable_name("PotreeConverter")),
            ),
            executable: true,
        }
    }

    fn portable_mvs(&self) -> ToolRequirement {
        ToolRequirement {
            name: "Portable MVS",
            expected_paths: vec![self
                .executable_dir
                .join(self.executable_name("himmelcad-portable-mvs"))],
            executable: true,
        }
    }

    fn brush(&self) -> ToolRequirement {
        ToolRequirement {
            name: "Brush",
            expected_paths: self.overridden_or(
                "HIMMELCAD_BRUSH_EXECUTABLE",
                self.workspace_root
                    .join("vendor/brush")
                    .join(self.platform_directory)
                    .join(self.executable_name("brush_app")),
            ),
            executable: true,
        }
    }

    fn dedode(&self) -> [ToolRequirement; 2] {
        let onnx = self.environment_path("HIMMELCAD_DEDODE_ONNX_ROOT");
        let root = self
            .environment_path("HIMMELCAD_DEDODE_ROOT")
            .unwrap_or_else(|| self.workspace_root.join("vendor/dedode/dev"));
        let python_fallback = if onnx.is_some() {
            self.workspace_root
                .join(".build/dedode-runtime")
                .join(self.platform_directory)
                .join(if self.executable_suffix == ".exe" {
                    "python/python.exe"
                } else {
                    "python/bin/python3.12"
                })
        } else if self.executable_suffix == ".exe" {
            root.join(".venv/Scripts/python.exe")
        } else {
            root.join(".venv/bin/python")
        };
        let worker_fallback = if onnx.is_some() {
            self.workspace_root
                .join("apps/photolab/workers/dedode/dedode_onnx_worker.py")
        } else {
            self.workspace_root
                .join("apps/photolab/workers/dedode/dedode_worker.py")
        };
        [
            ToolRequirement {
                name: "DeDoDe Python",
                expected_paths: self.overridden_or("HIMMELCAD_DEDODE_PYTHON", python_fallback),
                executable: true,
            },
            ToolRequirement {
                name: "DeDoDe runner",
                expected_paths: self.overridden_or("HIMMELCAD_DEDODE_WORKER", worker_fallback),
                // Python opens the runner as data; an executable bit would be a false contract.
                executable: false,
            },
        ]
    }

    fn gdal(&self) -> Vec<ToolRequirement> {
        let root = self.environment_path("HIMMELCAD_GDAL_ROOT");
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
        .map(|name| ToolRequirement {
            name: match name {
                "gdal_grid" => "GDAL grid",
                "gdal_rasterize" => "GDAL rasterize",
                "gdalwarp" => "GDAL warp",
                "gdalbuildvrt" => "GDAL build VRT",
                "gdal_translate" => "GDAL translate",
                "gdalinfo" => "GDAL info",
                "ogrinfo" => "OGR info",
                "ogr2ogr" => "OGR converter",
                _ => unreachable!(),
            },
            expected_paths: vec![root.as_ref().map_or_else(
                || PathBuf::from("/usr/bin").join(self.executable_name(name)),
                |root| root.join("bin").join(self.executable_name(name)),
            )],
            executable: true,
        })
        .collect()
    }

    fn proj(&self) -> [ToolRequirement; 2] {
        let root = self.environment_path("HIMMELCAD_PROJ_ROOT").or_else(|| {
            let bundled = self.executable_dir.join("workers/proj");
            bundled.is_dir().then_some(bundled)
        });
        let path = |name: &str| {
            root.as_ref().map_or_else(
                || PathBuf::from("/usr/bin").join(self.executable_name(name)),
                |root| root.join("bin").join(self.executable_name(name)),
            )
        };
        [
            ToolRequirement {
                name: "PROJ info",
                expected_paths: vec![path("projinfo")],
                executable: true,
            },
            ToolRequirement {
                name: "PROJ cct",
                expected_paths: vec![path("cct")],
                executable: true,
            },
        ]
    }
}

fn worker_toolchain_preflight_with(
    context: &ResolutionContext,
    job_kind: PhotolabJobKind,
    products: &[WorkerProduct],
) -> WorkerToolchainPreflight {
    let mut requirements = Vec::new();
    for product in products {
        match product {
            WorkerProduct::Colmap => requirements.push(context.colmap()),
            WorkerProduct::Alignment { dedode } => {
                requirements.push(context.colmap());
                if *dedode {
                    requirements.extend(context.dedode());
                }
                requirements.push(context.potree());
            }
            WorkerProduct::DepthMaps => {
                requirements.push(context.colmap());
                requirements.push(context.portable_mvs());
            }
            WorkerProduct::DensePointCloud => {
                requirements.push(context.colmap());
                requirements.push(context.portable_mvs());
                requirements.push(context.potree());
            }
            WorkerProduct::Dem => {
                requirements.extend(context.gdal());
                requirements.extend(context.proj());
            }
            WorkerProduct::Orthomosaic => {
                requirements.push(context.colmap());
                requirements.extend(context.gdal());
                requirements.extend(context.proj());
            }
            WorkerProduct::Mesh { requires_colmap } => {
                if *requires_colmap {
                    requirements.push(context.colmap());
                }
            }
            WorkerProduct::GaussianSplat => requirements.push(context.brush()),
        }
    }

    let mut seen = BTreeSet::new();
    let mut tools = Vec::new();
    for requirement in requirements {
        let Some(path) = requirement.expected_paths.iter().find(|path| {
            tool_is_available(path, requirement.executable, context.executable_suffix)
        }) else {
            return WorkerToolchainPreflight {
                tools,
                refusal: Some(WorkerToolchainMissing {
                    tool: requirement.name.into(),
                    expected_paths: requirement.expected_paths,
                    job_kind,
                }),
            };
        };
        let identity = (requirement.name, path.clone());
        if seen.insert(identity) {
            tools.push(PhotolabWorkerTool {
                tool: requirement.name.into(),
                path: path.display().to_string(),
                version: None,
            });
        }
    }
    WorkerToolchainPreflight {
        tools,
        refusal: None,
    }
}

fn tool_is_available(path: &Path, executable: bool, executable_suffix: &str) -> bool {
    if !path.is_file() {
        return false;
    }
    if executable_suffix == ".exe"
        && path
            .extension()
            .and_then(OsStr::to_str)
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return false;
    }
    !executable || file_is_executable(path)
}

#[cfg(unix)]
fn file_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn file_is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };

    use himmelcad_core::{
        hash::ObjectHash,
        photolab_jobs::{
            JobProgress, NewPhotolabJob, PhotolabJobId, PhotolabJobState, PhotolabStage,
            PhotolabStageKind, ProgressMetrics,
        },
    };

    use crate::job_runtime::{JobAdmission, JobManager, JobManagerConfig};

    use super::*;

    struct Fixture {
        root: PathBuf,
        context: ResolutionContext,
    }

    impl Fixture {
        fn new(suffix: &'static str) -> Self {
            let unique = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            );
            let root = std::env::current_dir()
                .expect("current directory")
                .join(".build/codex-scratch/win08/tests")
                .join(unique);
            let workspace_root = root.join("workspace");
            let executable_dir = root.join("runtime");
            let geo = executable_dir.join("workers/geo");
            let mut environment = BTreeMap::new();
            let paths = [
                (
                    "HIMMELCAD_COLMAP_EXECUTABLE",
                    executable_dir.join(format!("workers/colmap/bin/colmap{suffix}")),
                ),
                (
                    "HIMMELCAD_POTREE_CONVERTER",
                    executable_dir.join(format!("workers/potree/PotreeConverter{suffix}")),
                ),
                (
                    "HIMMELCAD_DEDODE_PYTHON",
                    executable_dir.join(format!("workers/dedode/python/python{suffix}")),
                ),
                (
                    "HIMMELCAD_DEDODE_WORKER",
                    executable_dir.join("workers/dedode/dedode_onnx_worker.py"),
                ),
                (
                    "HIMMELCAD_BRUSH_EXECUTABLE",
                    executable_dir.join(format!("workers/brush/brush_app{suffix}")),
                ),
            ];
            for (name, path) in paths {
                environment.insert(OsString::from(name), path.into_os_string());
            }
            environment.insert(
                OsString::from("HIMMELCAD_GDAL_ROOT"),
                geo.clone().into_os_string(),
            );
            environment.insert(OsString::from("HIMMELCAD_PROJ_ROOT"), geo.into_os_string());
            let context = ResolutionContext {
                workspace_root,
                executable_dir,
                executable_suffix: suffix,
                platform_directory: if suffix == ".exe" {
                    "win32-x64"
                } else {
                    "linux-x64"
                },
                environment,
            };
            Self { root, context }
        }

        fn install_all(&self) {
            let products = all_products();
            let requirements = requirements_for(&self.context, &products);
            for requirement in requirements {
                let path = &requirement.expected_paths[0];
                fs::create_dir_all(path.parent().expect("tool parent"))
                    .expect("create tool parent");
                let contents: &[u8] = if requirement.executable {
                    b"tool\n"
                } else {
                    b"runner\n"
                };
                fs::write(path, contents).expect("write tool");
                if requirement.executable {
                    make_executable(path);
                }
            }
        }

        fn path(&self, variable: &str) -> PathBuf {
            self.context
                .environment_path(variable)
                .expect("fixture path")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn all_products() -> Vec<WorkerProduct> {
        vec![
            WorkerProduct::Alignment { dedode: true },
            WorkerProduct::DepthMaps,
            WorkerProduct::DensePointCloud,
            WorkerProduct::Dem,
            WorkerProduct::Orthomosaic,
            WorkerProduct::Mesh {
                requires_colmap: true,
            },
            WorkerProduct::GaussianSplat,
        ]
    }

    fn requirements_for(
        context: &ResolutionContext,
        products: &[WorkerProduct],
    ) -> Vec<ToolRequirement> {
        let mut requirements = Vec::new();
        for product in products {
            match product {
                WorkerProduct::Colmap => requirements.push(context.colmap()),
                WorkerProduct::Alignment { dedode } => {
                    requirements.push(context.colmap());
                    if *dedode {
                        requirements.extend(context.dedode());
                    }
                    requirements.push(context.potree());
                }
                WorkerProduct::DepthMaps => {
                    requirements.push(context.colmap());
                    requirements.push(context.portable_mvs());
                }
                WorkerProduct::DensePointCloud => {
                    requirements.push(context.colmap());
                    requirements.push(context.portable_mvs());
                    requirements.push(context.potree());
                }
                WorkerProduct::Dem => {
                    requirements.extend(context.gdal());
                    requirements.extend(context.proj());
                }
                WorkerProduct::Orthomosaic => {
                    requirements.push(context.colmap());
                    requirements.extend(context.gdal());
                    requirements.extend(context.proj());
                }
                WorkerProduct::Mesh { requires_colmap } => {
                    if *requires_colmap {
                        requirements.push(context.colmap());
                    }
                }
                WorkerProduct::GaussianSplat => requirements.push(context.brush()),
            }
        }
        requirements
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path).expect("tool metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("make tool executable");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    #[test]
    fn fake_runtime_with_every_product_tool_passes() {
        let fixture = Fixture::new("");
        fixture.install_all();

        let result = worker_toolchain_preflight_with(
            &fixture.context,
            PhotolabJobKind::Batch,
            &all_products(),
        );

        assert!(result.refusal.is_none());
        assert_eq!(result.tools.len(), 16);
    }

    #[tokio::test]
    async fn missing_potree_refuses_alignment_without_starting_worker() {
        let fixture = Fixture::new("");
        fixture.install_all();
        fs::remove_file(fixture.path("HIMMELCAD_POTREE_CONVERTER")).expect("remove Potree");
        let preflight = worker_toolchain_preflight_with(
            &fixture.context,
            PhotolabJobKind::AlignPhotos,
            &[WorkerProduct::Alignment { dedode: false }],
        );
        let missing = preflight.refusal.as_ref().expect("typed refusal");
        assert_eq!(missing.tool, "PotreeConverter");
        assert_eq!(missing.job_kind, PhotolabJobKind::AlignPhotos);
        assert_eq!(
            missing.expected_paths,
            vec![fixture.path("HIMMELCAD_POTREE_CONVERTER")]
        );

        let started = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&started);
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 1,
        })
        .expect("manager");
        let result = manager
            .start_with_admission(
                NewPhotolabJob {
                    id: PhotolabJobId("missing-potree".into()),
                    kind: PhotolabJobKind::AlignPhotos,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Preparing,
                            index: 0,
                            stage_count: 1,
                            label: "Prepare alignment".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    },
                },
                JobAdmission {
                    toolchain_preflight: Some(preflight.into_admission()),
                    ..JobAdmission::default()
                },
                move |_| {
                    observed.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .expect("typed admission result");

        assert!(!started.load(Ordering::SeqCst));
        assert!(matches!(
            result.job.state,
            PhotolabJobState::Failed { ref code, ref message }
                if code == WORKER_TOOLCHAIN_MISSING_CODE
                    && message.contains("PotreeConverter is missing")
                    && message.contains("install or stage the worker runtime")
        ));
    }

    #[test]
    fn windows_layout_requires_exe_names() {
        let mut fixture = Fixture::new(".exe");
        fixture.install_all();
        let required = fixture.path("HIMMELCAD_POTREE_CONVERTER");
        let wrong = required.with_extension("");
        fs::rename(&required, &wrong).expect("rename without exe suffix");
        fixture.context.environment.insert(
            OsString::from("HIMMELCAD_POTREE_CONVERTER"),
            wrong.into_os_string(),
        );

        let result = worker_toolchain_preflight_with(
            &fixture.context,
            PhotolabJobKind::AlignPhotos,
            &[WorkerProduct::Alignment { dedode: false }],
        );

        let missing = result.refusal.expect("missing .exe refusal");
        assert_eq!(missing.tool, "PotreeConverter");
        assert!(missing.expected_paths[0].extension().is_none());
    }
}
