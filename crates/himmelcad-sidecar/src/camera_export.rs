//! Atomic export of a published alignment as a public COLMAP text package.

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::Path,
};

use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    colmap_runtime::ColmapIntrinsicsRefinement,
    product_export::{publish_replace, ProductExportError},
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraCalibrationExportGroup {
    pub group_id: String,
    pub camera_entity_ids: Vec<String>,
    pub intrinsics_refinement: ColmapIntrinsicsRefinement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CameraExportSummary {
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Error)]
pub enum CameraExportError {
    #[error("camera export was cancelled")]
    Cancelled,
    #[error("invalid COLMAP text model: {0}")]
    InvalidModel(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug)]
struct ColmapCameraRow {
    id: u64,
    model: String,
    width: u32,
    height: u32,
    parameters: Vec<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationFile<'a> {
    schema_version: u32,
    calibration_group_id: &'a str,
    camera_entity_ids: &'a [String],
    colmap_camera_id: u64,
    camera_model: CameraModelFile<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraModelFile<'a> {
    name: &'a str,
    width_pixels: u32,
    height_pixels: u32,
    parameters: Vec<CameraParameterFile<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraParameterFile<'a> {
    name: &'a str,
    value: f64,
    adjustment: &'static str,
}

pub fn export_cameras_atomic(
    source: &Path,
    destination: &Path,
    operation_id: &str,
    groups: &[CameraCalibrationExportGroup],
    cancellation: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<CameraExportSummary, CameraExportError> {
    validate_operation_id(operation_id)?;
    check_cancelled(cancellation)?;
    let source = source.canonicalize()?;
    if !source.is_dir() {
        return invalid("source is not a directory");
    }
    let parent = destination
        .parent()
        .ok_or_else(|| CameraExportError::InvalidModel("destination has no parent".into()))?
        .canonicalize()?;
    let name = destination
        .file_name()
        .ok_or_else(|| CameraExportError::InvalidModel("destination has no filename".into()))?;
    let destination = parent.join(name);
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return invalid("source and destination overlap");
    }
    let temporary = parent.join(format!(
        ".{}.{}.partial",
        name.to_string_lossy(),
        operation_id
    ));
    remove_directory_if_present(&temporary)?;
    let result = (|| {
        let cameras = read_cameras(&source.join("cameras.txt"))?;
        let effective_groups = effective_groups(&cameras, groups)?;
        let model_bytes = ["cameras.txt", "images.txt", "points3D.txt"]
            .iter()
            .try_fold(0_u64, |total, name| {
                let path = source.join(name).canonicalize()?;
                if !path.starts_with(&source) || !path.is_file() {
                    return invalid("COLMAP model file escaped its source directory");
                }
                total
                    .checked_add(path.metadata()?.len())
                    .ok_or_else(|| CameraExportError::InvalidModel("export size overflow".into()))
            })?;
        fs::create_dir(&temporary)?;
        let mut completed = 0_u64;
        for name in ["cameras.txt", "images.txt", "points3D.txt"] {
            completed = copy_file(
                &source.join(name),
                &temporary.join(name),
                cancellation,
                completed,
                model_bytes,
                &mut progress,
            )?;
        }
        let calibration_root = temporary.join("calibrations");
        fs::create_dir(&calibration_root)?;
        let mut bytes = model_bytes;
        for (index, (camera, group)) in cameras.iter().zip(&effective_groups).enumerate() {
            check_cancelled(cancellation)?;
            let directory = calibration_root.join(format!(
                "{:04}-{}",
                index + 1,
                safe_component(&group.group_id)
            ));
            fs::create_dir(&directory)?;
            let parameter_names = parameter_names(&camera.model, camera.parameters.len())?;
            let freeze_all =
                group.intrinsics_refinement == ColmapIntrinsicsRefinement::FreezeReliableEmbedded;
            let calibration = CalibrationFile {
                schema_version: 1,
                calibration_group_id: &group.group_id,
                camera_entity_ids: &group.camera_entity_ids,
                colmap_camera_id: camera.id,
                camera_model: CameraModelFile {
                    name: &camera.model,
                    width_pixels: camera.width,
                    height_pixels: camera.height,
                    parameters: parameter_names
                        .iter()
                        .zip(&camera.parameters)
                        .map(|(name, value)| CameraParameterFile {
                            name,
                            value: *value,
                            adjustment: if freeze_all || matches!(*name, "cx" | "cy") {
                                "fixed"
                            } else {
                                "refined"
                            },
                        })
                        .collect(),
                },
            };
            let encoded = serde_json::to_vec_pretty(&calibration)?;
            let path = directory.join("calibration.json");
            let mut writer = BufWriter::new(File::create(&path)?);
            writer.write_all(&encoded)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
            bytes = bytes.saturating_add(u64::try_from(encoded.len() + 1).unwrap_or(u64::MAX));
        }
        check_cancelled(cancellation)?;
        sync_directory_tree(&temporary)?;
        publish_replace(&temporary, &destination, operation_id).map_err(map_publish_error)?;
        Ok(CameraExportSummary {
            bytes,
            files: u64::try_from(3 + effective_groups.len()).unwrap_or(u64::MAX),
        })
    })();
    if result.is_err() {
        let _ = remove_directory_if_present(&temporary);
    }
    result
}

fn effective_groups(
    cameras: &[ColmapCameraRow],
    groups: &[CameraCalibrationExportGroup],
) -> Result<Vec<CameraCalibrationExportGroup>, CameraExportError> {
    if groups.is_empty() {
        return Ok(cameras
            .iter()
            .map(|camera| CameraCalibrationExportGroup {
                group_id: format!("colmap-camera-{}", camera.id),
                camera_entity_ids: Vec::new(),
                intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
            })
            .collect());
    }
    if groups.len() != cameras.len() {
        return invalid("alignment calibration-group count differs from cameras.txt");
    }
    Ok(groups.to_vec())
}

fn read_cameras(path: &Path) -> Result<Vec<ColmapCameraRow>, CameraExportError> {
    let mut cameras = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 {
            return invalid("cameras.txt row is truncated");
        }
        let row = ColmapCameraRow {
            id: parse(fields[0], "camera id")?,
            model: fields[1].to_owned(),
            width: parse(fields[2], "camera width")?,
            height: parse(fields[3], "camera height")?,
            parameters: fields[4..]
                .iter()
                .map(|value| parse(value, "camera parameter"))
                .collect::<Result<Vec<_>, _>>()?,
        };
        if row.width == 0
            || row.height == 0
            || row.parameters.iter().any(|value| !value.is_finite())
        {
            return invalid("cameras.txt contains invalid dimensions or parameters");
        }
        parameter_names(&row.model, row.parameters.len())?;
        cameras.push(row);
    }
    if cameras.is_empty() {
        return invalid("cameras.txt contains no cameras");
    }
    cameras.sort_by_key(|camera| camera.id);
    if cameras.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return invalid("cameras.txt contains duplicate camera ids");
    }
    Ok(cameras)
}

fn parameter_names(
    model: &str,
    count: usize,
) -> Result<&'static [&'static str], CameraExportError> {
    let names: &'static [&'static str] = match model {
        "SIMPLE_PINHOLE" => &["f", "cx", "cy"],
        "PINHOLE" => &["fx", "fy", "cx", "cy"],
        "SIMPLE_RADIAL" => &["f", "cx", "cy", "k1"],
        "RADIAL" => &["f", "cx", "cy", "k1", "k2"],
        "OPENCV" => &["fx", "fy", "cx", "cy", "k1", "k2", "p1", "p2"],
        "FULL_OPENCV" => &[
            "fx", "fy", "cx", "cy", "k1", "k2", "p1", "p2", "k3", "k4", "k5", "k6",
        ],
        _ => return invalid(&format!("unsupported camera model {model}")),
    };
    if names.len() != count {
        return invalid(&format!(
            "camera model {model} has the wrong parameter count"
        ));
    }
    Ok(names)
}

fn copy_file(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
    mut completed: u64,
    total: u64,
    progress: &mut impl FnMut(u64, u64),
) -> Result<u64, CameraExportError> {
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, File::open(source)?);
    let mut writer = BufWriter::with_capacity(COPY_BUFFER_BYTES, File::create(destination)?);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        check_cancelled(cancellation)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        completed = completed.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        progress(completed, total.max(1));
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(completed)
}

fn sync_directory_tree(root: &Path) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            sync_directory_tree(&path)?;
        } else {
            OpenOptions::new().write(true).open(path)?.sync_all()?;
        }
    }
    File::open(root)?.sync_all()
}

fn safe_component(value: &str) -> String {
    let value = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>();
    if value.is_empty() {
        "calibration-group".into()
    } else {
        value
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), CameraExportError> {
    if cancellation.is_cancel_requested() {
        Err(CameraExportError::Cancelled)
    } else {
        Ok(())
    }
}

fn validate_operation_id(value: &str) -> Result<(), CameraExportError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return invalid("operation id is not a safe path component");
    }
    Ok(())
}

fn remove_directory_if_present(path: &Path) -> Result<(), std::io::Error> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn map_publish_error(error: ProductExportError) -> CameraExportError {
    match error {
        ProductExportError::Cancelled => CameraExportError::Cancelled,
        ProductExportError::Io(error) => CameraExportError::Io(error),
        ProductExportError::InvalidRequest(message) => CameraExportError::InvalidModel(message),
    }
}

fn parse<T>(value: &str, label: &str) -> Result<T, CameraExportError>
where
    T: std::str::FromStr,
{
    value
        .parse()
        .map_err(|_| CameraExportError::InvalidModel(format!("invalid {label}")))
}

fn invalid<T>(message: &str) -> Result<T, CameraExportError> {
    Err(CameraExportError::InvalidModel(message.into()))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn root() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "himmelcad-camera-export-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("root");
        root
    }

    #[test]
    fn camera_package_round_trips_through_mvs_colmap_reader() {
        let root = root();
        let source = root.join("model");
        fs::create_dir(&source).expect("model");
        fs::write(
            source.join("cameras.txt"),
            "1 OPENCV 100 80 90 91 50 40 0.01 -0.02 0.001 -0.001\n",
        )
        .expect("cameras");
        fs::write(
            source.join("images.txt"),
            "1 1 0 0 0 0 0 0 1 image.jpg\n10 20 1\n",
        )
        .expect("images");
        fs::write(source.join("points3D.txt"), "1 0 0 10 255 0 0 0.2 1 0\n").expect("points");
        let destination = root.join("survey-cameras");
        let summary = export_cameras_atomic(
            &source,
            &destination,
            "camera-test",
            &[CameraCalibrationExportGroup {
                group_id: "flight-a".into(),
                camera_entity_ids: vec!["image-entity".into()],
                intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
            }],
            &CancellationToken::new(),
            |_, _| {},
        )
        .expect("export");
        assert_eq!(summary.files, 4);
        assert_eq!(
            crate::mvs_scene::validate_colmap_text_model(&destination).expect("round trip"),
            (1, 1)
        );
        let calibration: serde_json::Value = serde_json::from_slice(
            &fs::read(destination.join("calibrations/0001-flight-a/calibration.json"))
                .expect("calibration"),
        )
        .expect("JSON");
        assert_eq!(calibration["cameraModel"]["name"], "OPENCV");
        assert_eq!(
            calibration["cameraModel"]["parameters"][0]["adjustment"],
            "refined"
        );
        assert_eq!(
            calibration["cameraModel"]["parameters"][2]["adjustment"],
            "fixed"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
