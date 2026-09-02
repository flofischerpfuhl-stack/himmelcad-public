//! Atomic, cancellable export of validated PhotoLab product files and packages.

use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::camera_export::{
    export_cameras_atomic, CameraCalibrationExportGroup, CameraExportError,
};
use crate::pointcloud_export::{
    transcode_ply_atomic, PointCloudExportError, PointCloudExportFormat,
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductExportSourceKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductExportSource {
    pub source_path: PathBuf,
    pub kind: ProductExportSourceKind,
    pub suggested_name: String,
    #[serde(default)]
    pub conversion: ProductExportConversion,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProductExportConversion {
    #[default]
    Copy,
    PointCloud {
        format: PointCloudExportFormat,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        crs_wkt: Option<String>,
    },
    Cameras {
        calibration_groups: Vec<CameraCalibrationExportGroup>,
    },
}

#[derive(Debug, Clone)]
pub struct ProductExportRequest {
    pub operation_id: String,
    pub source: ProductExportSource,
    pub destination_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductExportSummary {
    pub destination_path: String,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Error)]
pub enum ProductExportError {
    #[error("invalid export request: {0}")]
    InvalidRequest(String),
    #[error("product export was cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn export_product(
    request: &ProductExportRequest,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<ProductExportSummary, ProductExportError> {
    validate_component(&request.operation_id)?;
    check_cancelled(cancellation)?;
    let source = request.source.source_path.canonicalize()?;
    match request.source.kind {
        ProductExportSourceKind::File if !source.is_file() => {
            return Err(ProductExportError::InvalidRequest(
                "export source is not a regular file".into(),
            ));
        }
        ProductExportSourceKind::Directory if !source.is_dir() => {
            return Err(ProductExportError::InvalidRequest(
                "export source is not a directory".into(),
            ));
        }
        _ => {}
    }
    let destination_parent = request
        .destination_path
        .parent()
        .ok_or_else(|| ProductExportError::InvalidRequest("destination has no parent".into()))?
        .canonicalize()?;
    let destination_name = request
        .destination_path
        .file_name()
        .ok_or_else(|| ProductExportError::InvalidRequest("destination has no filename".into()))?;
    let destination = destination_parent.join(destination_name);
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err(ProductExportError::InvalidRequest(
            "source and destination overlap".into(),
        ));
    }
    if let ProductExportConversion::PointCloud { format, crs_wkt } = &request.source.conversion {
        let source_bytes = source.metadata()?.len().max(1);
        let summary = transcode_ply_atomic(
            &source,
            &destination,
            &request.operation_id,
            *format,
            crs_wkt.as_deref(),
            cancellation,
            |completed_points, total_points| {
                let completed_bytes = completed_points
                    .saturating_mul(source_bytes)
                    .checked_div(total_points.max(1))
                    .unwrap_or(0)
                    .min(source_bytes);
                progress(completed_bytes, source_bytes);
            },
        )
        .map_err(map_pointcloud_error)?;
        return Ok(ProductExportSummary {
            destination_path: destination.to_string_lossy().into_owned(),
            bytes: summary.bytes,
            files: 1,
        });
    }
    if let ProductExportConversion::Cameras { calibration_groups } = &request.source.conversion {
        let summary = export_cameras_atomic(
            &source,
            &destination,
            &request.operation_id,
            calibration_groups,
            cancellation,
            progress,
        )
        .map_err(map_camera_error)?;
        return Ok(ProductExportSummary {
            destination_path: destination.to_string_lossy().into_owned(),
            bytes: summary.bytes,
            files: summary.files,
        });
    }
    let temporary = destination_parent.join(format!(
        ".{}.{}.partial",
        destination_name.to_string_lossy(),
        request.operation_id
    ));
    remove_path(&temporary)?;
    let entries = collect_files(&source, request.source.kind, cancellation)?;
    let total_bytes = entries.iter().try_fold(0_u64, |total, entry| {
        entry
            .bytes
            .checked_add(total)
            .ok_or_else(|| ProductExportError::InvalidRequest("export size overflow".into()))
    })?;
    let result = (|| {
        match request.source.kind {
            ProductExportSourceKind::File => {
                copy_file(
                    &entries[0].source,
                    &temporary,
                    cancellation,
                    total_bytes,
                    0,
                    &mut progress,
                )?;
            }
            ProductExportSourceKind::Directory => {
                fs::create_dir(&temporary)?;
                let mut completed = 0_u64;
                for entry in &entries {
                    check_cancelled(cancellation)?;
                    let output = temporary.join(&entry.relative);
                    if let Some(parent) = output.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    completed = copy_file(
                        &entry.source,
                        &output,
                        cancellation,
                        total_bytes,
                        completed,
                        &mut progress,
                    )?;
                }
            }
        }
        check_cancelled(cancellation)?;
        publish_replace(&temporary, &destination, &request.operation_id)?;
        Ok(ProductExportSummary {
            destination_path: destination.to_string_lossy().into_owned(),
            bytes: total_bytes,
            files: u64::try_from(entries.len()).unwrap_or(u64::MAX),
        })
    })();
    if result.is_err() {
        let _ = remove_path(&temporary);
    }
    result
}

#[derive(Debug)]
struct ExportEntry {
    source: PathBuf,
    relative: PathBuf,
    bytes: u64,
}

fn collect_files(
    source: &Path,
    kind: ProductExportSourceKind,
    cancellation: &CancellationToken,
) -> Result<Vec<ExportEntry>, ProductExportError> {
    if kind == ProductExportSourceKind::File {
        return Ok(vec![ExportEntry {
            source: source.to_path_buf(),
            relative: PathBuf::new(),
            bytes: source.metadata()?.len(),
        }]);
    }
    let mut pending = vec![source.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        check_cancelled(cancellation)?;
        let mut children = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children.into_iter().rev() {
            let file_type = child.file_type()?;
            if file_type.is_symlink() {
                return Err(ProductExportError::InvalidRequest(
                    "product package contains a symbolic link".into(),
                ));
            }
            if file_type.is_dir() {
                pending.push(child.path());
            } else if file_type.is_file() {
                let path = child.path();
                files.push(ExportEntry {
                    relative: path
                        .strip_prefix(source)
                        .expect("walk stays below source")
                        .to_path_buf(),
                    bytes: child.metadata()?.len(),
                    source: path,
                });
            }
        }
    }
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    if files.is_empty() {
        return Err(ProductExportError::InvalidRequest(
            "product package is empty".into(),
        ));
    }
    Ok(files)
}

fn copy_file(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
    total: u64,
    mut completed: u64,
    progress: &mut impl FnMut(u64, u64),
) -> Result<u64, ProductExportError> {
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, File::open(source)?);
    let output = File::create(destination)?;
    let mut writer = BufWriter::with_capacity(COPY_BUFFER_BYTES, output);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES].into_boxed_slice();
    loop {
        check_cancelled(cancellation)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        completed = completed.saturating_add(u64::try_from(read).expect("buffer length is u64"));
        progress(completed, total);
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(completed)
}

pub(crate) fn publish_replace(
    temporary: &Path,
    destination: &Path,
    operation_id: &str,
) -> Result<(), ProductExportError> {
    let backup = destination.with_file_name(format!(
        ".{}.{}.backup",
        destination
            .file_name()
            .expect("validated destination")
            .to_string_lossy(),
        operation_id
    ));
    remove_path(&backup)?;
    if destination.exists() {
        fs::rename(destination, &backup)?;
    }
    if let Err(error) = fs::rename(temporary, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(error.into());
    }
    remove_path(&backup)
}

fn map_pointcloud_error(error: PointCloudExportError) -> ProductExportError {
    match error {
        PointCloudExportError::Cancelled => ProductExportError::Cancelled,
        PointCloudExportError::Io(error) => ProductExportError::Io(error),
        PointCloudExportError::InvalidPly(message) => ProductExportError::InvalidRequest(message),
        PointCloudExportError::Las(error) => ProductExportError::InvalidRequest(error.to_string()),
    }
}

fn map_camera_error(error: CameraExportError) -> ProductExportError {
    match error {
        CameraExportError::Cancelled => ProductExportError::Cancelled,
        CameraExportError::Io(error) => ProductExportError::Io(error),
        CameraExportError::InvalidModel(message) => ProductExportError::InvalidRequest(message),
        CameraExportError::Json(error) => ProductExportError::InvalidRequest(error.to_string()),
    }
}

fn remove_path(path: &Path) -> Result<(), ProductExportError> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn validate_component(value: &str) -> Result<(), ProductExportError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ProductExportError::InvalidRequest(
            "operation id is not a safe path component".into(),
        ));
    }
    Ok(())
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), ProductExportError> {
    if cancellation.is_cancel_requested() {
        Err(ProductExportError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "himmelcad-export-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    #[test]
    fn file_export_replaces_only_after_a_complete_copy() {
        let root = root("file");
        let source = root.join("source.tif");
        let destination = root.join("output.tif");
        fs::write(&source, vec![42_u8; COPY_BUFFER_BYTES + 17]).expect("source");
        fs::write(&destination, b"old").expect("old destination");
        let summary = export_product(
            &ProductExportRequest {
                operation_id: "export-1".into(),
                source: ProductExportSource {
                    source_path: source,
                    kind: ProductExportSourceKind::File,
                    suggested_name: "map.tif".into(),
                    conversion: ProductExportConversion::Copy,
                },
                destination_path: destination.clone(),
            },
            &CancellationToken::new(),
            |_, _| {},
        )
        .expect("export");
        assert_eq!(summary.files, 1);
        assert_eq!(
            fs::read(destination).expect("output").len(),
            COPY_BUFFER_BYTES + 17
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn pre_cancelled_export_preserves_existing_destination() {
        let root = root("cancel");
        let source = root.join("source.ply");
        let destination = root.join("output.ply");
        fs::write(&source, b"new").expect("source");
        fs::write(&destination, b"old").expect("destination");
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let error = export_product(
            &ProductExportRequest {
                operation_id: "export-2".into(),
                source: ProductExportSource {
                    source_path: source,
                    kind: ProductExportSourceKind::File,
                    suggested_name: "cloud.ply".into(),
                    conversion: ProductExportConversion::Copy,
                },
                destination_path: destination.clone(),
            },
            &cancellation,
            |_, _| {},
        )
        .expect_err("cancelled");
        assert!(matches!(error, ProductExportError::Cancelled));
        assert_eq!(fs::read(destination).expect("destination"), b"old");
        fs::remove_dir_all(root).expect("cleanup");
    }
}
