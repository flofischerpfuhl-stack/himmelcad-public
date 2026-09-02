//! Bounded, cancellation-aware GCP CSV parsing and mapping preview.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_gcp::{
    CsvColumnSelector, CsvDecimalSeparator, GcpCoordinate, GcpCsvImportMapping, GcpPoint,
    GcpPointId, GcpRole, GcpUncertainty,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_CSV_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 1_000_000;
const READ_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCsvPreviewRow {
    pub source_line: u64,
    pub point: GcpPoint,
    pub uncertainty_origin: GcpCsvUncertaintyOrigin,
}

/// Identifies whether each frozen one-sigma value came from the row or the import defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCsvUncertaintyOrigin {
    pub east_used_default: bool,
    pub north_used_default: bool,
    pub height_used_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCsvRowError {
    pub source_line: u64,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCsvPreview {
    pub source_path: String,
    pub source_sha256: ObjectHash,
    pub source_bytes: u64,
    pub header: Vec<String>,
    pub preview_rows: Vec<GcpCsvPreviewRow>,
    pub valid_point_count: u64,
    pub data_row_count: u64,
    pub errors: Vec<GcpCsvRowError>,
    pub preview_truncated: bool,
    pub requires_crs_decision: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpCsvImportResult {
    pub source_path: String,
    pub source_sha256: ObjectHash,
    pub source_bytes: u64,
    pub mapping: GcpCsvImportMapping,
    pub points: Vec<GcpPoint>,
}

#[derive(Debug, Error)]
pub enum GcpCsvImportError {
    #[error("invalid GCP CSV mapping: {0}")]
    InvalidMapping(String),
    #[error("GCP CSV is not a regular non-symlink file: {0}")]
    InvalidSource(PathBuf),
    #[error("GCP CSV exceeds the {MAX_CSV_BYTES}-byte safety limit")]
    SourceTooLarge,
    #[error("GCP CSV is not valid UTF-8")]
    InvalidUtf8,
    #[error("GCP CSV syntax error at source line {line}: {message}")]
    CsvSyntax { line: u64, message: &'static str },
    #[error("GCP CSV contains more than {MAX_RECORDS} records")]
    TooManyRecords,
    #[error("GCP CSV has no data rows")]
    Empty,
    #[error("GCP CSV contains {0} invalid row(s)")]
    InvalidRows(usize),
    #[error("GCP CSV import was cancelled")]
    Cancelled,
    #[error("GCP CSV I/O failed for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub fn preview_gcp_csv_file(
    path: &Path,
    mapping: &GcpCsvImportMapping,
    maximum_preview_rows: usize,
) -> Result<GcpCsvPreview, GcpCsvImportError> {
    let parsed = parse_file(path, mapping, || false)?;
    let preview_rows = parsed
        .valid_rows
        .iter()
        .take(maximum_preview_rows)
        .cloned()
        .collect::<Vec<_>>();
    Ok(GcpCsvPreview {
        source_path: parsed.source_path,
        source_sha256: parsed.source_sha256,
        source_bytes: parsed.source_bytes,
        header: parsed.header,
        preview_truncated: parsed.valid_rows.len() > preview_rows.len(),
        preview_rows,
        valid_point_count: u64::try_from(parsed.valid_rows.len()).unwrap_or(u64::MAX),
        data_row_count: parsed.data_row_count,
        errors: parsed.errors,
        requires_crs_decision: true,
    })
}

pub fn import_gcp_csv_file(
    path: &Path,
    mapping: GcpCsvImportMapping,
) -> Result<GcpCsvImportResult, GcpCsvImportError> {
    import_gcp_csv_file_with_cancel(path, mapping, || false)
}

pub fn import_gcp_csv_file_with_cancel<C>(
    path: &Path,
    mapping: GcpCsvImportMapping,
    is_cancelled: C,
) -> Result<GcpCsvImportResult, GcpCsvImportError>
where
    C: FnMut() -> bool,
{
    let parsed = parse_file(path, &mapping, is_cancelled)?;
    if !parsed.errors.is_empty() {
        return Err(GcpCsvImportError::InvalidRows(parsed.errors.len()));
    }
    Ok(GcpCsvImportResult {
        source_path: parsed.source_path,
        source_sha256: parsed.source_sha256,
        source_bytes: parsed.source_bytes,
        mapping,
        points: parsed.valid_rows.into_iter().map(|row| row.point).collect(),
    })
}

struct ParsedCsv {
    source_path: String,
    source_sha256: ObjectHash,
    source_bytes: u64,
    header: Vec<String>,
    valid_rows: Vec<GcpCsvPreviewRow>,
    data_row_count: u64,
    errors: Vec<GcpCsvRowError>,
}

fn parse_file<C>(
    path: &Path,
    mapping: &GcpCsvImportMapping,
    mut is_cancelled: C,
) -> Result<ParsedCsv, GcpCsvImportError>
where
    C: FnMut() -> bool,
{
    mapping
        .validate()
        .map_err(|error| GcpCsvImportError::InvalidMapping(error.to_string()))?;
    let canonical = canonical_source(path)?;
    let (bytes, source_sha256) = read_source(&canonical, &mut is_cancelled)?;
    let source_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let text =
        std::str::from_utf8(strip_utf8_bom(&bytes)).map_err(|_| GcpCsvImportError::InvalidUtf8)?;
    let mut records = parse_records(text, mapping.delimiter, &mut is_cancelled)?;
    if records.is_empty() {
        return Err(GcpCsvImportError::Empty);
    }
    let header = if mapping.has_header {
        records.remove(0).fields
    } else {
        Vec::new()
    };
    if records.is_empty() {
        return Err(GcpCsvImportError::Empty);
    }
    let columns = resolve_columns(mapping, &header)?;
    let mut errors = Vec::new();
    let mut valid_rows = Vec::new();
    let mut names = BTreeMap::<String, u64>::new();
    for record in &records {
        check_cancelled(&mut is_cancelled)?;
        match map_record(record, mapping, &columns) {
            Ok(row) => {
                let normalized = row.point.name.trim().to_owned();
                if let Some(previous) = names.get(&normalized) {
                    errors.push(GcpCsvRowError {
                        source_line: row.source_line,
                        field: "name".into(),
                        message: format!(
                            "GCP name '{normalized}' duplicates source line {previous}"
                        ),
                    });
                } else {
                    names.insert(normalized, row.source_line);
                    valid_rows.push(row);
                }
            }
            Err(error) => errors.push(error),
        }
    }
    Ok(ParsedCsv {
        source_path: canonical.to_string_lossy().into_owned(),
        source_sha256,
        source_bytes,
        header,
        valid_rows,
        data_row_count: u64::try_from(records.len()).unwrap_or(u64::MAX),
        errors,
    })
}

fn canonical_source(path: &Path) -> Result<PathBuf, GcpCsvImportError> {
    let link_metadata = path
        .symlink_metadata()
        .map_err(|source| GcpCsvImportError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(GcpCsvImportError::InvalidSource(path.to_path_buf()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|source| GcpCsvImportError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if canonical
        .metadata()
        .map_or(true, |metadata| !metadata.is_file())
    {
        return Err(GcpCsvImportError::InvalidSource(canonical));
    }
    Ok(canonical)
}

fn read_source<C>(
    path: &Path,
    is_cancelled: &mut C,
) -> Result<(Vec<u8>, ObjectHash), GcpCsvImportError>
where
    C: FnMut() -> bool,
{
    let size = path
        .metadata()
        .map_err(|source| GcpCsvImportError::Io {
            path: path.to_path_buf(),
            source,
        })?
        .len();
    if size > MAX_CSV_BYTES {
        return Err(GcpCsvImportError::SourceTooLarge);
    }
    let mut file = File::open(path).map_err(|source| GcpCsvImportError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES].into_boxed_slice();
    let mut hasher = Sha256::new();
    loop {
        check_cancelled(is_cancelled)?;
        let read = file
            .read(&mut buffer)
            .map_err(|source| GcpCsvImportError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        if u64::try_from(bytes.len())
            .unwrap_or(u64::MAX)
            .saturating_add(u64::try_from(read).unwrap_or(u64::MAX))
            > MAX_CSV_BYTES
        {
            return Err(GcpCsvImportError::SourceTooLarge);
        }
        hasher.update(&buffer[..read]);
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok((bytes, ObjectHash(hex::encode(hasher.finalize()))))
}

struct CsvRecord {
    source_line: u64,
    fields: Vec<String>,
}

fn parse_records<C>(
    text: &str,
    delimiter: char,
    is_cancelled: &mut C,
) -> Result<Vec<CsvRecord>, GcpCsvImportError>
where
    C: FnMut() -> bool,
{
    let mut records = Vec::new();
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut after_quote = false;
    let mut source_line = 1_u64;
    let mut record_line = 1_u64;
    let mut processed_characters = 0_u32;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        processed_characters = processed_characters.wrapping_add(1);
        if processed_characters % 16_384 == 0 {
            check_cancelled(is_cancelled)?;
        }
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    after_quote = true;
                }
            } else {
                source_line += u64::from(character == '\n');
                field.push(character);
            }
            continue;
        }
        if after_quote {
            if character == delimiter {
                fields.push(std::mem::take(&mut field));
                after_quote = false;
                continue;
            }
            if matches!(character, '\r' | '\n') {
                finish_record(&mut records, &mut fields, &mut field, record_line)?;
                if character == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                source_line += 1;
                record_line = source_line;
                after_quote = false;
                continue;
            }
            if character.is_whitespace() {
                continue;
            }
            return Err(GcpCsvImportError::CsvSyntax {
                line: source_line,
                message: "unexpected character after closing quote",
            });
        }
        match character {
            '"' if field.is_empty() => quoted = true,
            value if value == delimiter => fields.push(std::mem::take(&mut field)),
            '\r' | '\n' => {
                finish_record(&mut records, &mut fields, &mut field, record_line)?;
                if character == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                source_line += 1;
                record_line = source_line;
            }
            _ => field.push(character),
        }
    }
    if quoted {
        return Err(GcpCsvImportError::CsvSyntax {
            line: record_line,
            message: "unterminated quoted field",
        });
    }
    if !field.is_empty() || !fields.is_empty() || after_quote {
        finish_record(&mut records, &mut fields, &mut field, record_line)?;
    }
    Ok(records)
}

fn finish_record(
    records: &mut Vec<CsvRecord>,
    fields: &mut Vec<String>,
    field: &mut String,
    source_line: u64,
) -> Result<(), GcpCsvImportError> {
    fields.push(std::mem::take(field));
    if fields.iter().any(|value| !value.trim().is_empty()) {
        if records.len() >= MAX_RECORDS {
            return Err(GcpCsvImportError::TooManyRecords);
        }
        records.push(CsvRecord {
            source_line,
            fields: std::mem::take(fields),
        });
    } else {
        fields.clear();
    }
    Ok(())
}

struct ResolvedColumns {
    name: usize,
    east: usize,
    north: usize,
    height: usize,
    horizontal_stddev: Option<usize>,
    east_stddev: Option<usize>,
    north_stddev: Option<usize>,
    height_stddev: Option<usize>,
    code: Option<usize>,
    role: Option<usize>,
}

fn resolve_columns(
    mapping: &GcpCsvImportMapping,
    header: &[String],
) -> Result<ResolvedColumns, GcpCsvImportError> {
    let resolve =
        |selector: &CsvColumnSelector| resolve_column(selector, header, mapping.has_header);
    let columns = ResolvedColumns {
        name: resolve(&mapping.name)?,
        east: resolve(&mapping.east)?,
        north: resolve(&mapping.north)?,
        height: resolve(&mapping.height)?,
        horizontal_stddev: mapping
            .horizontal_stddev
            .as_ref()
            .map(resolve)
            .transpose()?,
        east_stddev: mapping.east_stddev.as_ref().map(resolve).transpose()?,
        north_stddev: mapping.north_stddev.as_ref().map(resolve).transpose()?,
        height_stddev: mapping.height_stddev.as_ref().map(resolve).transpose()?,
        code: mapping.code.as_ref().map(resolve).transpose()?,
        role: mapping.role.as_ref().map(resolve).transpose()?,
    };
    let mut unique = BTreeSet::new();
    for index in [
        Some(columns.name),
        Some(columns.east),
        Some(columns.north),
        Some(columns.height),
        columns.horizontal_stddev,
        columns.east_stddev,
        columns.north_stddev,
        columns.height_stddev,
        columns.code,
        columns.role,
    ]
    .into_iter()
    .flatten()
    {
        if !unique.insert(index) {
            return Err(GcpCsvImportError::InvalidMapping(
                "one CSV column is mapped to multiple fields".into(),
            ));
        }
    }
    Ok(columns)
}

fn resolve_column(
    selector: &CsvColumnSelector,
    header: &[String],
    has_header: bool,
) -> Result<usize, GcpCsvImportError> {
    match selector {
        CsvColumnSelector::Index(index) => Ok(usize::from(*index)),
        CsvColumnSelector::Header(name) if has_header => {
            let matches = header
                .iter()
                .enumerate()
                .filter(|(_, value)| value.trim().eq_ignore_ascii_case(name.trim()))
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [index] => Ok(*index),
                [] => Err(GcpCsvImportError::InvalidMapping(format!(
                    "header '{name}' does not exist"
                ))),
                _ => Err(GcpCsvImportError::InvalidMapping(format!(
                    "header '{name}' is duplicated"
                ))),
            }
        }
        CsvColumnSelector::Header(_) => Err(GcpCsvImportError::InvalidMapping(
            "header selector requires hasHeader=true".into(),
        )),
    }
}

fn map_record(
    record: &CsvRecord,
    mapping: &GcpCsvImportMapping,
    columns: &ResolvedColumns,
) -> Result<GcpCsvPreviewRow, GcpCsvRowError> {
    let name = field(record, columns.name, "name")?.trim().to_owned();
    if name.is_empty() {
        return Err(row_error(record.source_line, "name", "GCP name is empty"));
    }
    let east = parse_number(record, columns.east, "east", mapping.decimal_separator)?;
    let north = parse_number(record, columns.north, "north", mapping.decimal_separator)?;
    let height = parse_number(record, columns.height, "height", mapping.decimal_separator)?;
    let default_horizontal = mapping.default_uncertainty.horizontal_stddev_meters;
    let (horizontal_stddev, east_stddev, north_stddev, east_used_default, north_used_default) =
        if columns.horizontal_stddev.is_some() {
            let parsed = parse_optional_number(
                record,
                columns.horizontal_stddev,
                "horizontalStddev",
                mapping.decimal_separator,
            )?;
            let used_default = parsed.is_none();
            (
                parsed.unwrap_or(default_horizontal),
                None,
                None,
                used_default,
                used_default,
            )
        } else {
            let default_east = mapping.default_uncertainty.east_stddev_meters();
            let default_north = mapping.default_uncertainty.north_stddev_meters();
            let east = parse_optional_number(
                record,
                columns.east_stddev,
                "eastStddev",
                mapping.decimal_separator,
            )?;
            let north = parse_optional_number(
                record,
                columns.north_stddev,
                "northStddev",
                mapping.decimal_separator,
            )?;
            (
                default_horizontal,
                columns
                    .east_stddev
                    .map(|_| east.unwrap_or(default_east))
                    .or(mapping.default_uncertainty.east_stddev_meters),
                columns
                    .north_stddev
                    .map(|_| north.unwrap_or(default_north))
                    .or(mapping.default_uncertainty.north_stddev_meters),
                east.is_none(),
                north.is_none(),
            )
        };
    let parsed_height_stddev = parse_optional_number(
        record,
        columns.height_stddev,
        "heightStddev",
        mapping.decimal_separator,
    )?;
    let height_used_default = parsed_height_stddev.is_none();
    let height_stddev =
        parsed_height_stddev.unwrap_or(mapping.default_uncertainty.height_stddev_meters);
    if horizontal_stddev < 0.0
        || east_stddev.is_some_and(|value| value < 0.0)
        || north_stddev.is_some_and(|value| value < 0.0)
        || height_stddev < 0.0
    {
        return Err(row_error(
            record.source_line,
            "uncertainty",
            "standard deviations must not be negative",
        ));
    }
    let role = columns.role.map_or(Ok(mapping.default_role), |index| {
        let value = field(record, index, "role")?.trim();
        if value.is_empty() {
            Ok(mapping.default_role)
        } else {
            parse_role(value).ok_or_else(|| {
                row_error(
                    record.source_line,
                    "role",
                    "unknown GCP role or component mask",
                )
            })
        }
    })?;
    let code = columns
        .code
        .and_then(|index| record.fields.get(index))
        .map_or("", String::as_str)
        .trim()
        .to_owned();
    Ok(GcpCsvPreviewRow {
        source_line: record.source_line,
        point: GcpPoint {
            id: GcpPointId(name.clone()),
            name,
            code,
            coordinate: GcpCoordinate {
                east_meters: east,
                north_meters: north,
                height_meters: height,
            },
            uncertainty: GcpUncertainty {
                horizontal_stddev_meters: horizontal_stddev,
                east_stddev_meters: east_stddev,
                north_stddev_meters: north_stddev,
                height_stddev_meters: height_stddev,
            },
            role,
        },
        uncertainty_origin: GcpCsvUncertaintyOrigin {
            east_used_default,
            north_used_default,
            height_used_default,
        },
    })
}

fn field<'a>(
    record: &'a CsvRecord,
    index: usize,
    name: &'static str,
) -> Result<&'a str, GcpCsvRowError> {
    record
        .fields
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| row_error(record.source_line, name, "column is missing in this row"))
}

fn parse_number(
    record: &CsvRecord,
    index: usize,
    name: &'static str,
    decimal: CsvDecimalSeparator,
) -> Result<f64, GcpCsvRowError> {
    let value = field(record, index, name)?.trim();
    let normalized = match decimal {
        CsvDecimalSeparator::Point => value.to_owned(),
        CsvDecimalSeparator::Comma => value.replace(',', "."),
    };
    let parsed = normalized.parse::<f64>().map_err(|_| {
        row_error(
            record.source_line,
            name,
            "value is not a valid decimal number",
        )
    })?;
    if parsed.is_finite() {
        Ok(parsed)
    } else {
        Err(row_error(record.source_line, name, "value must be finite"))
    }
}

fn parse_optional_number(
    record: &CsvRecord,
    index: Option<usize>,
    name: &'static str,
    decimal: CsvDecimalSeparator,
) -> Result<Option<f64>, GcpCsvRowError> {
    let Some(index) = index else {
        return Ok(None);
    };
    let Some(value) = record.fields.get(index) else {
        return Ok(None);
    };
    if value.trim().is_empty() {
        Ok(None)
    } else {
        parse_number(record, index, name, decimal).map(Some)
    }
}

fn parse_role(value: &str) -> Option<GcpRole> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' ', '/'], "_");
    match normalized.as_str() {
        "control_xyz" | "control" | "gcp_xyz" => Some(GcpRole::ControlXyz),
        "control_xy" | "gcp_xy" => Some(GcpRole::ControlXy),
        "control_z" | "gcp_z" => Some(GcpRole::ControlZ),
        "checkpoint_xyz" | "checkpoint" | "check_xyz" => Some(GcpRole::CheckpointXyz),
        "checkpoint_xy" | "check_xy" => Some(GcpRole::CheckpointXy),
        "checkpoint_z" | "check_z" => Some(GcpRole::CheckpointZ),
        "disabled" | "ignore" | "off" => Some(GcpRole::Disabled),
        _ => None,
    }
}

fn row_error(line: u64, field: &str, message: &str) -> GcpCsvRowError {
    GcpCsvRowError {
        source_line: line,
        field: field.into(),
        message: message.into(),
    }
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)
}

fn check_cancelled<C>(is_cancelled: &mut C) -> Result<(), GcpCsvImportError>
where
    C: FnMut() -> bool,
{
    if is_cancelled() {
        Err(GcpCsvImportError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct CsvFixture(PathBuf);

    impl CsvFixture {
        fn new(content: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "himmelcad-gcp-import-{}-{}.csv",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::write(&path, content).expect("fixture");
            Self(path)
        }
    }

    impl Drop for CsvFixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn mapping() -> GcpCsvImportMapping {
        GcpCsvImportMapping {
            delimiter: ';',
            decimal_separator: CsvDecimalSeparator::Comma,
            has_header: true,
            name: CsvColumnSelector::Header("Name".into()),
            east: CsvColumnSelector::Header("Ost".into()),
            north: CsvColumnSelector::Header("Nord".into()),
            height: CsvColumnSelector::Header("Höhe".into()),
            horizontal_stddev: Some(CsvColumnSelector::Header("SigmaXY".into())),
            east_stddev: None,
            north_stddev: None,
            height_stddev: Some(CsvColumnSelector::Header("SigmaZ".into())),
            code: None,
            role: Some(CsvColumnSelector::Header("Rolle".into())),
            default_role: GcpRole::ControlXyz,
            default_uncertainty: GcpUncertainty {
                horizontal_stddev_meters: 0.01,
                east_stddev_meters: None,
                north_stddev_meters: None,
                height_stddev_meters: 0.02,
            },
        }
    }

    #[test]
    fn preview_maps_decimal_role_mask_and_uncertainty() {
        let file = CsvFixture::new(
            "Name;Ost;Nord;Höhe;SigmaXY;SigmaZ;Rolle\nGCP 1;500000,25;5400000,5;410,2;0,01;0,02;control_xy\nCP 2;500100,0;5400100,0;411,0;;;checkpoint_z\n",
        );
        let preview = preview_gcp_csv_file(&file.0, &mapping(), 1).expect("preview");
        assert!(preview.errors.is_empty());
        assert_eq!(preview.valid_point_count, 2);
        assert_eq!(preview.preview_rows[0].point.role, GcpRole::ControlXy);
        assert!(
            (preview.preview_rows[0].point.coordinate.east_meters - 500_000.25).abs()
                < f64::EPSILON
        );
        assert!(preview.preview_truncated);
        assert!(preview.requires_crs_decision);
        assert_eq!(
            preview.preview_rows[0].uncertainty_origin,
            GcpCsvUncertaintyOrigin {
                east_used_default: false,
                north_used_default: false,
                height_used_default: false,
            }
        );
    }

    #[test]
    fn mixed_axis_accuracy_code_and_missing_values_are_frozen_per_row() {
        let file = CsvFixture::new(
            "Name;E;N;H;dE;dN;dH;Description\nRTK;1,0;2,0;3,0;0,020;0,015;0,030;RTK fixed\nTS;4,0;5,0;6,0;0,005;0,006;0,008;Total station\nFallback;7,0;8,0;9,0;;;;\n",
        );
        let mut mapping = mapping();
        mapping.east = CsvColumnSelector::Header("e".into());
        mapping.north = CsvColumnSelector::Header("n".into());
        mapping.height = CsvColumnSelector::Header("h".into());
        mapping.horizontal_stddev = None;
        mapping.east_stddev = Some(CsvColumnSelector::Header("DE".into()));
        mapping.north_stddev = Some(CsvColumnSelector::Header("dn".into()));
        mapping.height_stddev = Some(CsvColumnSelector::Header("Dh".into()));
        mapping.code = Some(CsvColumnSelector::Header("description".into()));
        mapping.role = None;
        let result = import_gcp_csv_file(&file.0, mapping).expect("mixed import");

        assert_eq!(result.points[0].code, "RTK fixed");
        assert_eq!(result.points[1].code, "Total station");
        assert_eq!(result.points[1].uncertainty.east_stddev_meters, Some(0.005));
        assert_eq!(
            result.points[1].uncertainty.north_stddev_meters,
            Some(0.006)
        );
        assert_eq!(result.points[1].uncertainty.height_stddev_meters, 0.008);
        assert_eq!(result.points[2].uncertainty.east_stddev_meters, Some(0.01));
        assert_eq!(result.points[2].uncertainty.north_stddev_meters, Some(0.01));
        assert_eq!(result.points[2].uncertainty.height_stddev_meters, 0.02);

        let preview = preview_gcp_csv_file(&file.0, &result.mapping, 10).expect("preview");
        assert_eq!(
            preview.preview_rows[2].uncertainty_origin,
            GcpCsvUncertaintyOrigin {
                east_used_default: true,
                north_used_default: true,
                height_used_default: true,
            }
        );
    }

    #[test]
    fn point_decimal_accuracy_columns_use_the_selected_decimal_separator() {
        let file = CsvFixture::new(
            "name,east,north,height,sH,sV,code\nP1,1.0,2.0,3.0,0.005,0.010,stone nail\nP2,4.0,5.0,6.0,,,paint mark\n",
        );
        let mapping = GcpCsvImportMapping {
            delimiter: ',',
            decimal_separator: CsvDecimalSeparator::Point,
            has_header: true,
            name: CsvColumnSelector::Header("NAME".into()),
            east: CsvColumnSelector::Header("East".into()),
            north: CsvColumnSelector::Header("North".into()),
            height: CsvColumnSelector::Header("Height".into()),
            horizontal_stddev: Some(CsvColumnSelector::Header("sh".into())),
            east_stddev: None,
            north_stddev: None,
            height_stddev: Some(CsvColumnSelector::Header("sv".into())),
            code: Some(CsvColumnSelector::Header("CODE".into())),
            role: None,
            default_role: GcpRole::ControlXyz,
            default_uncertainty: GcpUncertainty {
                horizontal_stddev_meters: 0.02,
                east_stddev_meters: None,
                north_stddev_meters: None,
                height_stddev_meters: 0.03,
            },
        };
        let preview = preview_gcp_csv_file(&file.0, &mapping, 10).expect("preview");
        assert_eq!(
            preview.preview_rows[0]
                .point
                .uncertainty
                .horizontal_stddev_meters,
            0.005
        );
        assert_eq!(
            preview.preview_rows[0]
                .point
                .uncertainty
                .height_stddev_meters,
            0.01
        );
        assert_eq!(
            preview.preview_rows[1]
                .point
                .uncertainty
                .horizontal_stddev_meters,
            0.02
        );
        assert_eq!(
            preview.preview_rows[1]
                .point
                .uncertainty
                .height_stddev_meters,
            0.03
        );
        assert!(preview.preview_rows[1].uncertainty_origin.east_used_default);
        assert!(
            preview.preview_rows[1]
                .uncertainty_origin
                .height_used_default
        );
    }

    #[test]
    fn quoted_delimiter_and_newline_are_supported() {
        let file = CsvFixture::new(
            "Name;Ost;Nord;Höhe;SigmaXY;SigmaZ;Rolle\n\"GCP;\n1\";1,0;2,0;3,0;;;disabled\n",
        );
        let result = import_gcp_csv_file(&file.0, mapping()).expect("import");
        assert_eq!(result.points[0].name, "GCP;\n1");
    }

    #[test]
    fn duplicate_names_are_row_errors_and_block_import() {
        let file = CsvFixture::new(
            "Name;Ost;Nord;Höhe;SigmaXY;SigmaZ;Rolle\nA;1,0;2,0;3,0;;;control_xyz\nA;4,0;5,0;6,0;;;checkpoint_xyz\n",
        );
        let preview = preview_gcp_csv_file(&file.0, &mapping(), 10).expect("preview");
        assert_eq!(preview.errors.len(), 1);
        assert!(matches!(
            import_gcp_csv_file(&file.0, mapping()),
            Err(GcpCsvImportError::InvalidRows(1))
        ));
    }

    #[test]
    fn non_finite_and_unknown_role_are_reported() {
        let file =
            CsvFixture::new("Name;Ost;Nord;Höhe;SigmaXY;SigmaZ;Rolle\nA;NaN;2,0;3,0;;;mystery\n");
        let preview = preview_gcp_csv_file(&file.0, &mapping(), 10).expect("preview");
        assert_eq!(preview.errors.len(), 1);
        assert_eq!(preview.errors[0].field, "east");
    }

    #[test]
    fn cancellation_is_checked_while_reading() {
        let file =
            CsvFixture::new("Name;Ost;Nord;Höhe;SigmaXY;SigmaZ;Rolle\nA;1,0;2,0;3,0;;;disabled\n");
        assert!(matches!(
            import_gcp_csv_file_with_cancel(&file.0, mapping(), || true),
            Err(GcpCsvImportError::Cancelled)
        ));
    }

    #[test]
    fn malformed_quote_is_rejected() {
        let file = CsvFixture::new(
            "Name;Ost;Nord;Höhe;SigmaXY;SigmaZ;Rolle\n\"A;1,0;2,0;3,0;;;disabled\n",
        );
        assert!(matches!(
            preview_gcp_csv_file(&file.0, &mapping(), 10),
            Err(GcpCsvImportError::CsvSyntax { .. })
        ));
    }
}
