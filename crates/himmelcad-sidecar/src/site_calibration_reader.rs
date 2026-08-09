//! Conservative site-calibration reader for explicit text exports.
//!
//! Trimble `.dc`/`.cal` are proprietary containers. HimmelCAD never guesses
//! offsets from opaque binary bytes: it accepts an auditable JSON contract and
//! a small explicit key/value interchange subset, otherwise fails closed.

use std::{collections::BTreeMap, fs, path::Path};

use himmelcad_core::{hash::ObjectHash, transform::Similarity3D};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Path-free, hash-bound calibration inspection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiteCalibrationInspection {
    pub schema_version: u32,
    pub source_sha256: ObjectHash,
    pub format: SiteCalibrationFormat,
    pub transform: Similarity3D,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Exactly identified supported interchange syntax.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SiteCalibrationFormat {
    HimmelcadJson,
    ExplicitText,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonCalibration {
    schema_id: String,
    transform: Similarity3D,
}

/// Inspects one `.cal`, `.dc`, `.jxl`, JSON or text export without trusting its extension.
pub fn inspect_site_calibration(
    path: &Path,
) -> Result<SiteCalibrationInspection, SiteCalibrationReaderError> {
    let bytes = fs::read(path)?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(SiteCalibrationReaderError::InvalidSize);
    }
    let source_sha256 = ObjectHash::of_bytes(&bytes);
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("dc"))
        {
            SiteCalibrationReaderError::UnsupportedBinaryDc
        } else {
            SiteCalibrationReaderError::NotText
        }
    })?;
    if let Ok(value) = serde_json::from_str::<JsonCalibration>(text) {
        if value.schema_id != "hcad.site-calibration@1" {
            return Err(SiteCalibrationReaderError::UnsupportedJsonSchema);
        }
        validate_transform(value.transform)?;
        return Ok(SiteCalibrationInspection {
            schema_version: 1,
            source_sha256,
            format: SiteCalibrationFormat::HimmelcadJson,
            transform: value.transform,
            warnings: Vec::new(),
        });
    }
    let values = explicit_values(text);
    let transform = Similarity3D {
        tx: required(&values, &["tx", "translation_x", "easting_offset"])?,
        ty: required(&values, &["ty", "translation_y", "northing_offset"])?,
        tz: required(&values, &["tz", "translation_z", "height_offset"])?,
        rx_radians: rotation(&values, "rx")?,
        ry_radians: rotation(&values, "ry")?,
        rz_radians: rotation(&values, "rz")?,
        scale: scale(&values)?,
    };
    validate_transform(transform)?;
    Ok(SiteCalibrationInspection {
        schema_version: 1,
        source_sha256,
        format: SiteCalibrationFormat::ExplicitText,
        transform,
        warnings: vec![
            "Proprietary .cal/.dc semantics are not inferred; values came from explicit named text fields"
                .to_owned(),
        ],
    })
}

fn explicit_values(text: &str) -> BTreeMap<String, f64> {
    let mut values = BTreeMap::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((key, raw_value)) = line.split_once('=').or_else(|| line.split_once(':')) {
            if let Ok(value) = raw_value.trim().parse::<f64>() {
                values.insert(normalize_key(key), value);
            }
        }
    }
    values
}

fn normalize_key(key: &str) -> String {
    key.trim()
        .to_ascii_lowercase()
        .replace([' ', '-', '.'], "_")
}

fn required(
    values: &BTreeMap<String, f64>,
    keys: &[&str],
) -> Result<f64, SiteCalibrationReaderError> {
    keys.iter()
        .find_map(|key| values.get(*key).copied())
        .ok_or_else(|| SiteCalibrationReaderError::MissingField(keys[0].to_owned()))
}

fn rotation(values: &BTreeMap<String, f64>, axis: &str) -> Result<f64, SiteCalibrationReaderError> {
    if let Some(value) = values.get(&format!("{axis}_radians")) {
        return Ok(*value);
    }
    if let Some(value) = values.get(&format!("{axis}_degrees")) {
        return Ok(value.to_radians());
    }
    if let Some(value) = values.get(&format!("{axis}_arc_seconds")) {
        return Ok((value / 3_600.0).to_radians());
    }
    values
        .get(axis)
        .copied()
        .ok_or_else(|| SiteCalibrationReaderError::MissingField(format!("{axis}_radians")))
}

fn scale(values: &BTreeMap<String, f64>) -> Result<f64, SiteCalibrationReaderError> {
    if let Some(value) = values.get("scale") {
        return Ok(*value);
    }
    if let Some(ppm) = values.get("scale_ppm") {
        return Ok(1.0 + ppm * 1e-6);
    }
    Err(SiteCalibrationReaderError::MissingField("scale".to_owned()))
}

fn validate_transform(value: Similarity3D) -> Result<(), SiteCalibrationReaderError> {
    if [
        value.tx,
        value.ty,
        value.tz,
        value.rx_radians,
        value.ry_radians,
        value.rz_radians,
        value.scale,
    ]
    .into_iter()
    .all(f64::is_finite)
        && value.scale > 0.0
    {
        Ok(())
    } else {
        Err(SiteCalibrationReaderError::InvalidTransform)
    }
}

/// Site-calibration reader failure.
#[derive(Debug, Error)]
pub enum SiteCalibrationReaderError {
    #[error("site-calibration input size is invalid")]
    InvalidSize,
    #[error("binary Trimble .dc is proprietary and cannot be decoded safely; export named calibration parameters or HimmelCAD JSON")]
    UnsupportedBinaryDc,
    #[error("site-calibration input is not UTF-8 text")]
    NotText,
    #[error("site-calibration JSON schema is unsupported")]
    UnsupportedJsonSchema,
    #[error("site-calibration field is missing: {0}")]
    MissingField(String),
    #[error("site-calibration transform is invalid")]
    InvalidTransform,
    #[error("site-calibration file cannot be read: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_explicit_cal_text_with_declared_rotation_units() {
        let root = std::env::temp_dir().join(format!(
            "hcad-site-cal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(
            &root,
            "tx=100\nty=200\ntz=3\nrx_arc_seconds=0\nry_arc_seconds=0\nrz_degrees=10\nscale_ppm=2\n",
        )
        .unwrap();
        let inspected = inspect_site_calibration(&root).expect("explicit calibration");
        assert_eq!(inspected.format, SiteCalibrationFormat::ExplicitText);
        assert!((inspected.transform.scale - 1.000_002).abs() < 1e-12);
        assert!((inspected.transform.rz_radians - 10_f64.to_radians()).abs() < 1e-12);
        fs::remove_file(root).ok();
    }

    #[test]
    fn opaque_binary_dc_fails_closed() {
        let root = std::env::temp_dir().join(format!("hcad-site-cal-{}.dc", std::process::id()));
        fs::write(&root, [0xff, 0x00, 0x81]).unwrap();
        assert!(matches!(
            inspect_site_calibration(&root),
            Err(SiteCalibrationReaderError::UnsupportedBinaryDc)
        ));
        fs::remove_file(root).ok();
    }
}
