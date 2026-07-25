//! Verified import of HimmelCAD Cap `.hcap` session packages.
//!
//! Admission deliberately stops before project mutation: the archive is
//! validated and its frames are materialized into an operation-scoped staging
//! directory, then passed through PhotoLab's normal image inspection contract.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
};

use himmelcad_core::{
    photolab_images::{
        CaptureTime, CaptureTimeReference, DjiRtkMetadata, ExifGpsPosition, ImportedHeight,
        PhotoImportBatch,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zip::ZipArchive;

use crate::photolab_image_import::import_photo_files_with_progress;

const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum HcapImportError {
    #[error("failed to read .hcap package: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid .hcap ZIP: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("invalid .hcap JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("missing required .hcap entry: {0}")]
    MissingEntry(String),
    #[error("unsupported .hcap format: {0}")]
    UnsupportedFormat(String),
    #[error(
        ".hcap schema version {observed} is newer than this PhotoLab supports (maximum {supported})"
    )]
    SchemaTooNew { observed: u32, supported: u32 },
    #[error("invalid .hcap package: {0}")]
    InvalidPackage(String),
    #[error("checksum mismatch for {path}: expected {expected}, observed {observed}")]
    ChecksumMismatch {
        path: String,
        expected: String,
        observed: String,
    },
    #[error(".hcap import was cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcapManifest {
    format: String,
    schema_version: u32,
    session_id: String,
    #[serde(default)]
    package_profile: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    capture: HcapCapture,
    media: HcapMedia,
    #[serde(default)]
    export: Option<HcapExport>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcapCapture {
    frame_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcapMedia {
    frames: Vec<HcapFrame>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcapFrame {
    index: u32,
    path: String,
    sha256: String,
    #[serde(default)]
    captured_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcapExport {
    #[serde(default)]
    project_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcapPose {
    frame_index: u32,
    #[serde(default)]
    timestamp_utc: Option<String>,
    latitude_degrees: f64,
    longitude_degrees: f64,
    #[serde(default)]
    height_meters: Option<f64>,
    covariance_enu_m2: [f64; 9],
    #[serde(default)]
    fix_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HcapImportPreview {
    pub session_id: String,
    pub display_name: String,
    pub schema_version: u32,
    pub package_profile: Option<String>,
    pub created_at: Option<String>,
    pub frame_count: usize,
    pub pose_count: usize,
    pub warnings: Vec<String>,
    pub batch: PhotoImportBatch,
}

/// Validates, verifies and stages one `.hcap` package without mutating a project.
pub fn import_hcap_path_with_progress<C, P>(
    source: &Path,
    staging_root: &Path,
    mut cancelled: C,
    mut progress: P,
) -> Result<HcapImportPreview, HcapImportError>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    if cancelled() {
        return Err(HcapImportError::Cancelled);
    }
    if !source
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("hcap"))
    {
        return Err(HcapImportError::InvalidPackage(
            "the selected file must use the .hcap extension".into(),
        ));
    }
    if staging_root.exists() {
        return Err(HcapImportError::InvalidPackage(format!(
            "staging directory already exists: {}",
            staging_root.display()
        )));
    }

    progress(0.01, "Opening HimmelCAD Cap package");
    let file = File::open(source)?;
    let mut archive = ZipArchive::new(file)?;
    validate_archive_inventory(&mut archive)?;

    let manifest_bytes = read_required_entry(&mut archive, "manifest.json")?;
    let manifest: HcapManifest = serde_json::from_slice(&manifest_bytes)?;
    validate_manifest(&manifest)?;

    progress(0.04, "Verifying package checksums");
    let checksums_raw = read_required_entry(&mut archive, "checksums.sha256")?;
    let checksums = parse_checksums(&checksums_raw)?;
    verify_archive_checksums(&mut archive, &checksums, &mut cancelled, &mut progress)?;

    let poses_raw = read_required_entry(&mut archive, "poses.jsonl")?;
    let poses = parse_poses(&poses_raw)?;
    let pose_by_frame = poses
        .iter()
        .map(|pose| (pose.frame_index, pose))
        .collect::<BTreeMap<_, _>>();

    fs::create_dir_all(staging_root)?;
    let frames_root = staging_root.join("frames");
    fs::create_dir_all(&frames_root)?;
    let mut staged_paths = Vec::with_capacity(manifest.media.frames.len());
    let mut frame_by_staged_path = BTreeMap::<String, &HcapFrame>::new();
    let frame_total = manifest.media.frames.len();
    for (position, frame) in manifest.media.frames.iter().enumerate() {
        if cancelled() {
            return Err(HcapImportError::Cancelled);
        }
        validate_payload_path(&frame.path, "media/frames/")?;
        let bytes = read_required_entry(&mut archive, &frame.path)?;
        let observed = sha256_hex(&bytes);
        if !observed.eq_ignore_ascii_case(&frame.sha256) {
            return Err(HcapImportError::ChecksumMismatch {
                path: frame.path.clone(),
                expected: frame.sha256.clone(),
                observed,
            });
        }
        let filename = Path::new(&frame.path)
            .file_name()
            .ok_or_else(|| HcapImportError::InvalidPackage("frame path has no filename".into()))?;
        let staged = frames_root.join(filename);
        fs::write(&staged, bytes)?;
        let staged_key = path_string(&staged);
        frame_by_staged_path.insert(staged_key, frame);
        staged_paths.push(staged);
        progress(
            0.45 + 0.15 * (position + 1) as f64 / frame_total.max(1) as f64,
            &format!("Staging Cap frame {} of {frame_total}", position + 1),
        );
    }

    let mut batch = import_photo_files_with_progress(
        &staged_paths,
        &mut cancelled,
        |fraction, message| progress(0.60 + fraction * 0.38, message),
    )
    .ok_or(HcapImportError::Cancelled)?;

    let mut warnings = Vec::new();
    for photo in &mut batch.photos {
        let Some(frame) = frame_by_staged_path.get(&photo.source_path) else {
            warnings.push(format!(
                "Inspected frame was not declared by manifest: {}",
                photo.source_path
            ));
            continue;
        };
        let Some(pose) = pose_by_frame.get(&frame.index) else {
            warnings.push(format!("Frame {} has no positioning prior", frame.index));
            continue;
        };
        apply_pose_metadata(photo, frame, pose);
    }

    progress(1.0, "HimmelCAD Cap package ready for project import");
    Ok(HcapImportPreview {
        session_id: manifest.session_id.clone(),
        display_name: manifest
            .export
            .as_ref()
            .and_then(|value| value.project_name.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("HimmelCAD Cap {}", manifest.session_id)),
        schema_version: manifest.schema_version,
        package_profile: manifest.package_profile,
        created_at: manifest.created_at,
        frame_count: manifest.media.frames.len(),
        pose_count: poses.len(),
        warnings,
        batch,
    })
}

fn validate_manifest(manifest: &HcapManifest) -> Result<(), HcapImportError> {
    if manifest.format != "himmelcap-session" {
        return Err(HcapImportError::UnsupportedFormat(manifest.format.clone()));
    }
    if manifest.schema_version > SUPPORTED_SCHEMA_VERSION {
        return Err(HcapImportError::SchemaTooNew {
            observed: manifest.schema_version,
            supported: SUPPORTED_SCHEMA_VERSION,
        });
    }
    if manifest.schema_version == 0 {
        return Err(HcapImportError::InvalidPackage(
            "schemaVersion must be at least 1".into(),
        ));
    }
    if manifest.session_id.trim().is_empty() {
        return Err(HcapImportError::InvalidPackage(
            "sessionId must not be empty".into(),
        ));
    }
    if manifest.capture.frame_count != manifest.media.frames.len() {
        return Err(HcapImportError::InvalidPackage(format!(
            "capture.frameCount is {}, but media.frames contains {} entries",
            manifest.capture.frame_count,
            manifest.media.frames.len()
        )));
    }
    if manifest.media.frames.len() < 2 {
        return Err(HcapImportError::InvalidPackage(
            "a reconstructable Cap session needs at least two frames".into(),
        ));
    }
    let mut indices = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut filenames = BTreeSet::new();
    for frame in &manifest.media.frames {
        if !indices.insert(frame.index) {
            return Err(HcapImportError::InvalidPackage(format!(
                "duplicate frame index {}",
                frame.index
            )));
        }
        if !paths.insert(frame.path.as_str()) {
            return Err(HcapImportError::InvalidPackage(format!(
                "duplicate frame path {}",
                frame.path
            )));
        }
        validate_payload_path(&frame.path, "media/frames/")?;
        let filename = Path::new(&frame.path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                HcapImportError::InvalidPackage(format!(
                    "frame path has no UTF-8 filename: {}",
                    frame.path
                ))
            })?
            .to_ascii_lowercase();
        if !filenames.insert(filename) {
            return Err(HcapImportError::InvalidPackage(format!(
                "frame filenames collide on a case-insensitive filesystem: {}",
                frame.path
            )));
        }
        validate_sha256(&frame.sha256, &frame.path)?;
    }
    Ok(())
}

fn validate_archive_inventory<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(), HcapImportError> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(HcapImportError::InvalidPackage(format!(
            "archive contains too many entries ({})",
            archive.len()
        )));
    }
    let mut total = 0_u64;
    let mut names = BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = entry.name().to_owned();
        validate_relative_path(&name)?;
        if !names.insert(name.clone()) {
            return Err(HcapImportError::InvalidPackage(format!(
                "duplicate ZIP entry: {name}"
            )));
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(HcapImportError::InvalidPackage(format!(
                "ZIP entry is too large: {name}"
            )));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| HcapImportError::InvalidPackage("archive size overflow".into()))?;
        if total > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(HcapImportError::InvalidPackage(
                "archive expands beyond the PhotoLab safety limit".into(),
            ));
        }
    }
    Ok(())
}

fn parse_checksums(raw: &[u8]) -> Result<BTreeMap<String, String>, HcapImportError> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| HcapImportError::InvalidPackage("checksums.sha256 is not UTF-8".into()))?;
    let mut checksums = BTreeMap::new();
    for (line_index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((hash, path)) = line.split_once("  ") else {
            return Err(HcapImportError::InvalidPackage(format!(
                "invalid checksum line {}",
                line_index + 1
            )));
        };
        validate_relative_path(path)?;
        validate_sha256(hash, path)?;
        if checksums.insert(path.to_owned(), hash.to_owned()).is_some() {
            return Err(HcapImportError::InvalidPackage(format!(
                "duplicate checksum entry: {path}"
            )));
        }
    }
    Ok(checksums)
}

fn verify_archive_checksums<R, C, P>(
    archive: &mut ZipArchive<R>,
    checksums: &BTreeMap<String, String>,
    cancelled: &mut C,
    progress: &mut P,
) -> Result<(), HcapImportError>
where
    R: Read + Seek,
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    let expected_entries = archive
        .file_names()
        .filter(|name| !name.ends_with('/') && *name != "checksums.sha256")
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let checksum_entries = checksums.keys().cloned().collect::<BTreeSet<_>>();
    if expected_entries != checksum_entries {
        let missing = expected_entries
            .difference(&checksum_entries)
            .next()
            .map(String::as_str);
        let unknown = checksum_entries
            .difference(&expected_entries)
            .next()
            .map(String::as_str);
        return Err(HcapImportError::InvalidPackage(format!(
            "checksum inventory does not match archive (missing: {}, unknown: {})",
            missing.unwrap_or("none"),
            unknown.unwrap_or("none")
        )));
    }
    let total = checksums.len();
    for (index, (path, expected)) in checksums.iter().enumerate() {
        if cancelled() {
            return Err(HcapImportError::Cancelled);
        }
        let observed = sha256_hex(&read_required_entry(archive, path)?);
        if !observed.eq_ignore_ascii_case(expected) {
            return Err(HcapImportError::ChecksumMismatch {
                path: path.clone(),
                expected: expected.clone(),
                observed,
            });
        }
        progress(
            0.04 + 0.40 * (index + 1) as f64 / total.max(1) as f64,
            &format!("Verifying package file {} of {total}", index + 1),
        );
    }
    Ok(())
}

fn parse_poses(raw: &[u8]) -> Result<Vec<HcapPose>, HcapImportError> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| HcapImportError::InvalidPackage("poses.jsonl is not UTF-8".into()))?;
    let mut poses = Vec::new();
    let mut frame_indices = BTreeSet::new();
    for (line_index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let pose = serde_json::from_str::<HcapPose>(line).map_err(|error| {
            HcapImportError::InvalidPackage(format!(
                "invalid poses.jsonl line {}: {error}",
                line_index + 1
            ))
        })?;
        validate_pose(&pose, line_index + 1)?;
        if !frame_indices.insert(pose.frame_index) {
            return Err(HcapImportError::InvalidPackage(format!(
                "duplicate pose for frame {}",
                pose.frame_index
            )));
        }
        poses.push(pose);
    }
    Ok(poses)
}

fn validate_pose(pose: &HcapPose, line: usize) -> Result<(), HcapImportError> {
    let valid_position = pose.latitude_degrees.is_finite()
        && (-90.0..=90.0).contains(&pose.latitude_degrees)
        && pose.longitude_degrees.is_finite()
        && (-180.0..=180.0).contains(&pose.longitude_degrees)
        && pose.height_meters.is_none_or(f64::is_finite);
    let valid_covariance = pose
        .covariance_enu_m2
        .iter()
        .all(|value| value.is_finite())
        && pose.covariance_enu_m2[0] >= 0.0
        && pose.covariance_enu_m2[4] >= 0.0
        && pose.covariance_enu_m2[8] >= 0.0;
    if !valid_position || !valid_covariance {
        return Err(HcapImportError::InvalidPackage(format!(
            "invalid position or covariance on poses.jsonl line {line}"
        )));
    }
    Ok(())
}

fn apply_pose_metadata(
    photo: &mut himmelcad_core::photolab_images::DiscoveredPhoto,
    frame: &HcapFrame,
    pose: &HcapPose,
) {
    let altitude = pose.height_meters.map(ImportedHeight::unknown_reference);
    photo.metadata.exif.gps = Some(ExifGpsPosition {
        latitude_degrees: pose.latitude_degrees,
        longitude_degrees: pose.longitude_degrees,
        altitude,
    });
    photo.metadata.exif.captured_at = pose
        .timestamp_utc
        .as_ref()
        .or(frame.captured_at.as_ref())
        .map(|value| CaptureTime {
            value: value.clone(),
            reference: CaptureTimeReference::EmbeddedUtcOffset,
        });
    photo.metadata.dji_xmp.latitude_degrees = Some(pose.latitude_degrees);
    photo.metadata.dji_xmp.longitude_degrees = Some(pose.longitude_degrees);
    photo.metadata.dji_xmp.absolute_altitude = altitude;
    photo.metadata.dji_xmp.rtk = Some(DjiRtkMetadata {
        flag: pose.fix_type.as_deref().map(|value| {
            if value.eq_ignore_ascii_case("fix") {
                "fixed".to_owned()
            } else {
                value.to_owned()
            }
        }),
        standard_deviation_longitude_meters: Some(pose.covariance_enu_m2[0].sqrt()),
        standard_deviation_latitude_meters: Some(pose.covariance_enu_m2[4].sqrt()),
        standard_deviation_height_meters: Some(pose.covariance_enu_m2[8].sqrt()),
    });
}

fn read_required_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &str,
) -> Result<Vec<u8>, HcapImportError> {
    let mut entry = archive
        .by_name(path)
        .map_err(|_| HcapImportError::MissingEntry(path.to_owned()))?;
    let capacity = usize::try_from(entry.size()).map_err(|_| {
        HcapImportError::InvalidPackage(format!("ZIP entry is too large for this host: {path}"))
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    entry.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn validate_payload_path(path: &str, prefix: &str) -> Result<(), HcapImportError> {
    validate_relative_path(path)?;
    let relative = path.strip_prefix(prefix);
    if relative.is_none_or(|value| value.is_empty() || value.contains('/')) || path.ends_with('/') {
        return Err(HcapImportError::InvalidPackage(format!(
            "payload path must be a file below {prefix}: {path}"
        )));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), HcapImportError> {
    if path.is_empty()
        || path.contains('\\')
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(HcapImportError::InvalidPackage(format!(
            "unsafe archive path: {path}"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, path: &str) -> Result<(), HcapImportError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HcapImportError::InvalidPackage(format!(
            "invalid SHA-256 for {path}"
        )));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use zip::write::SimpleFileOptions;

    use super::*;

    fn package(schema_version: u32, corrupt_frame: bool, unsafe_path: bool) -> Vec<u8> {
        let frame_a = b"\xff\xd8\xff\xd9".to_vec();
        let frame_b = b"\xff\xd8\xff\xd9\x00".to_vec();
        let path_a = if unsafe_path {
            "../outside.jpg"
        } else {
            "media/frames/000001.jpg"
        };
        let manifest = serde_json::json!({
            "format": "himmelcap-session",
            "schemaVersion": schema_version,
            "sessionId": "session-1",
            "createdAt": "2026-07-25T10:00:00Z",
            "capture": { "frameCount": 2 },
            "media": { "frames": [
                { "index": 0, "path": path_a, "sha256": sha256_hex(&frame_a) },
                { "index": 1, "path": "media/frames/000002.jpg", "sha256": sha256_hex(&frame_b) }
            ]},
            "export": { "projectName": "Test trench" }
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let poses = concat!(
            "{\"frameIndex\":0,\"latitudeDegrees\":48.1,\"longitudeDegrees\":11.5,",
            "\"covarianceEnuM2\":[0.01,0,0,0,0.01,0,0,0,0.04],\"fixType\":\"fixed\"}\n",
            "{\"frameIndex\":1,\"latitudeDegrees\":48.1001,\"longitudeDegrees\":11.5001,",
            "\"covarianceEnuM2\":[0.04,0,0,0,0.04,0,0,0,0.16],\"fixType\":\"float\"}\n"
        )
        .as_bytes()
        .to_vec();
        let listed_frame_a = if corrupt_frame {
            b"not-the-frame".to_vec()
        } else {
            frame_a.clone()
        };
        let checksums = format!(
            "{}  manifest.json\n{}  poses.jsonl\n{}  {path_a}\n{}  media/frames/000002.jpg\n",
            sha256_hex(&manifest_bytes),
            sha256_hex(&poses),
            sha256_hex(&listed_frame_a),
            sha256_hex(&frame_b),
        );
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = SimpleFileOptions::default();
            for (path, bytes) in [
                ("manifest.json", manifest_bytes.as_slice()),
                ("poses.jsonl", poses.as_slice()),
                (path_a, frame_a.as_slice()),
                ("media/frames/000002.jpg", frame_b.as_slice()),
                ("checksums.sha256", checksums.as_bytes()),
            ] {
                writer.start_file(path, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn write_package(bytes: &[u8], name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-hcap-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("test.hcap");
        fs::write(&source, bytes).unwrap();
        (source, root.join("staging"))
    }

    #[test]
    fn imports_verified_frames_and_applies_pose_metadata() {
        let (source, staging) = write_package(&package(1, false, false), "valid");
        let preview =
            import_hcap_path_with_progress(&source, &staging, || false, |_, _| {}).unwrap();
        assert_eq!(preview.display_name, "Test trench");
        assert_eq!(preview.frame_count, 2);
        assert_eq!(preview.pose_count, 2);
        assert_eq!(preview.batch.photos.len(), 2);
        assert_eq!(
            preview.batch.photos[0]
                .metadata
                .preferred_gps_position()
                .unwrap()
                .latitude_degrees,
            48.1
        );
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn rejects_checksum_mismatch() {
        let (source, staging) = write_package(&package(1, true, false), "checksum");
        let error =
            import_hcap_path_with_progress(&source, &staging, || false, |_, _| {}).unwrap_err();
        assert!(matches!(error, HcapImportError::ChecksumMismatch { .. }));
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn rejects_newer_schema() {
        let (source, staging) = write_package(&package(2, false, false), "schema");
        let error =
            import_hcap_path_with_progress(&source, &staging, || false, |_, _| {}).unwrap_err();
        assert!(matches!(error, HcapImportError::SchemaTooNew { .. }));
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn rejects_path_traversal() {
        let (source, staging) = write_package(&package(1, false, true), "traversal");
        let error =
            import_hcap_path_with_progress(&source, &staging, || false, |_, _| {}).unwrap_err();
        assert!(matches!(error, HcapImportError::InvalidPackage(_)));
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }
}
