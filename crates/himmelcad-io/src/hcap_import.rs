//! PhotoLab importer preparation for HimmelCAD Cap `.hcap` packages.
//!
//! Unpacks a ZIP with `manifest.json` + frames + `poses.jsonl` and maps poses
//! into [`himmelcad_core::photolab_capture::CapturePositionPrior`].
//! Full admission into a project store is wired in a follow-up milestone.

use std::io::{Cursor, Read};
use std::path::Path;

use serde::Deserialize;
use thiserror::Error;
use zip::ZipArchive;

use himmelcad_core::photolab_capture::{
    CapturePositionPrior, CapturePositionPriorSource, CapturePositionRole,
};

#[derive(Debug, Error)]
pub enum HcapImportError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("missing {0}")]
    Missing(&'static str),
    #[error("unsupported format {0}")]
    UnsupportedFormat(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HcapManifest {
    pub format: String,
    pub schema_version: u32,
    pub session_id: String,
    #[serde(default)]
    pub package_profile: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HcapPoseLine {
    pub frame_index: u32,
    pub latitude_degrees: f64,
    pub longitude_degrees: f64,
    #[serde(default)]
    pub height_meters: Option<f64>,
    pub covariance_enu_m2: [f64; 9],
    #[serde(default)]
    pub fix_type: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
}

#[derive(Debug)]
pub struct HcapImportPreview {
    pub session_id: String,
    pub schema_version: u32,
    pub package_profile: Option<String>,
    pub pose_count: usize,
    pub frame_paths: Vec<String>,
    pub priors: Vec<CapturePositionPrior>,
}

/// Opens a `.hcap` file or an exploded session directory and returns a preview
/// suitable for PhotoLab UI + tests. Does not mutate a project yet.
pub fn preview_hcap_path(path: &Path) -> Result<HcapImportPreview, HcapImportError> {
    if path.is_dir() {
        return preview_exploded(path);
    }
    let bytes = std::fs::read(path)?;
    preview_hcap_bytes(&bytes)
}

pub fn preview_hcap_bytes(bytes: &[u8]) -> Result<HcapImportPreview, HcapImportError> {
    let cursor = Cursor::new(bytes);
    let mut zip = ZipArchive::new(cursor)?;
    let mut manifest_raw = String::new();
    {
        let mut f = zip
            .by_name("manifest.json")
            .map_err(|_| HcapImportError::Missing("manifest.json"))?;
        f.read_to_string(&mut manifest_raw)?;
    }
    let manifest: HcapManifest = serde_json::from_str(&manifest_raw)?;
    if manifest.format != "himmelcap-session" {
        return Err(HcapImportError::UnsupportedFormat(manifest.format));
    }

    let mut poses_raw = String::new();
    if let Ok(mut f) = zip.by_name("poses.jsonl") {
        f.read_to_string(&mut poses_raw)?;
    }

    let mut frame_paths = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i)?;
        let name = f.name().to_string();
        if name.starts_with("media/frames/") && !name.ends_with('/') {
            frame_paths.push(name);
        }
    }
    frame_paths.sort();

    let priors = parse_poses_jsonl(&poses_raw);
    Ok(HcapImportPreview {
        session_id: manifest.session_id,
        schema_version: manifest.schema_version,
        package_profile: manifest.package_profile,
        pose_count: priors.len(),
        frame_paths,
        priors,
    })
}

fn preview_exploded(dir: &Path) -> Result<HcapImportPreview, HcapImportError> {
    let manifest_raw = std::fs::read_to_string(dir.join("manifest.json"))?;
    let manifest: HcapManifest = serde_json::from_str(&manifest_raw)?;
    if manifest.format != "himmelcap-session" {
        return Err(HcapImportError::UnsupportedFormat(manifest.format));
    }
    let poses_path = dir.join("poses.jsonl");
    let poses_raw = if poses_path.exists() {
        std::fs::read_to_string(poses_path)?
    } else {
        String::new()
    };
    let frames_dir = dir.join("media/frames");
    let mut frame_paths = Vec::new();
    if frames_dir.is_dir() {
        for e in std::fs::read_dir(frames_dir)? {
            let e = e?;
            if e.path().is_file() {
                frame_paths.push(format!(
                    "media/frames/{}",
                    e.file_name().to_string_lossy()
                ));
            }
        }
        frame_paths.sort();
    }
    let priors = parse_poses_jsonl(&poses_raw);
    Ok(HcapImportPreview {
        session_id: manifest.session_id,
        schema_version: manifest.schema_version,
        package_profile: manifest.package_profile,
        pose_count: priors.len(),
        frame_paths,
        priors,
    })
}

fn parse_poses_jsonl(raw: &str) -> Vec<CapturePositionPrior> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(pose) = serde_json::from_str::<HcapPoseLine>(line) else {
            continue;
        };
        out.push(CapturePositionPrior {
            latitude_degrees: pose.latitude_degrees,
            longitude_degrees: pose.longitude_degrees,
            height_meters: pose.height_meters,
            covariance_enu_m2: pose.covariance_enu_m2,
            source: CapturePositionPriorSource::HimmelCap,
            role: CapturePositionRole::PriorOnly,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;

    #[test]
    fn preview_minimal_zip() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = FileOptions::<()>::default();
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(
                br#"{"format":"himmelcap-session","schemaVersion":1,"sessionId":"s1"}"#,
            )
            .unwrap();
            zip.start_file("poses.jsonl", opts).unwrap();
            zip.write_all(
                br#"{"frameIndex":0,"latitudeDegrees":48.1,"longitudeDegrees":11.5,"covarianceEnuM2":[0.09,0,0,0,0.09,0,0,0,0.36],"fixType":"float","tier":"t2NtripFloat"}
"#,
            )
            .unwrap();
            zip.finish().unwrap();
        }
        let bytes = buf.into_inner();
        let preview = preview_hcap_bytes(&bytes).unwrap();
        assert_eq!(preview.session_id, "s1");
        assert_eq!(preview.pose_count, 1);
        assert_eq!(preview.priors[0].latitude_degrees, 48.1);
    }
}
