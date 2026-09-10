//! Typed access to the subset of COLMAP's SQLite feature schema used by PhotoLab.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use thiserror::Error;

pub const ALIKED_DESCRIPTOR_DIMENSIONS: usize = 128;
pub const ALIKED_DESCRIPTOR_BYTES_PER_ROW: usize = ALIKED_DESCRIPTOR_DIMENSIONS * size_of::<f32>();
pub const SIFT_DESCRIPTOR_BYTES_PER_ROW: usize = 128;

/// COLMAP keypoint geometry. COLMAP 4.0 writes the six-column affine form for
/// every extractor; the other documented layouts remain readable for fixtures
/// and older databases.
#[derive(Debug, Clone, PartialEq)]
pub enum ColmapKeypointMatrix {
    Coordinates(Vec<[f32; 2]>),
    Similarity(Vec<[f32; 4]>),
    Affine(Vec<[f32; 6]>),
}

impl ColmapKeypointMatrix {
    #[must_use]
    pub fn rows(&self) -> usize {
        match self {
            Self::Coordinates(rows) => rows.len(),
            Self::Similarity(rows) => rows.len(),
            Self::Affine(rows) => rows.len(),
        }
    }

    #[must_use]
    pub const fn columns(&self) -> usize {
        match self {
            Self::Coordinates(_) => 2,
            Self::Similarity(_) => 4,
            Self::Affine(_) => 6,
        }
    }

    fn append_le_bytes(&self, output: &mut Vec<u8>) {
        match self {
            Self::Coordinates(rows) => append_float_rows(rows, output),
            Self::Similarity(rows) => append_float_rows(rows, output),
            Self::Affine(rows) => append_float_rows(rows, output),
        }
    }

    fn truncate(&mut self, rows: usize) {
        match self {
            Self::Coordinates(values) => values.truncate(rows),
            Self::Similarity(values) => values.truncate(rows),
            Self::Affine(values) => values.truncate(rows),
        }
    }

    fn select_rows(&mut self, indices: &[usize]) {
        match self {
            Self::Coordinates(rows) => *rows = indices.iter().map(|&index| rows[index]).collect(),
            Self::Similarity(rows) => *rows = indices.iter().map(|&index| rows[index]).collect(),
            Self::Affine(rows) => *rows = indices.iter().map(|&index| rows[index]).collect(),
        }
    }

    fn coordinates(&self, index: usize) -> (f32, f32) {
        match self {
            Self::Coordinates(rows) => (rows[index][0], rows[index][1]),
            Self::Similarity(rows) => (rows[index][0], rows[index][1]),
            Self::Affine(rows) => (rows[index][0], rows[index][1]),
        }
    }
}

/// Descriptor storage supported by COLMAP 4.0's SIFT and ALIKED extractors.
#[derive(Debug, Clone, PartialEq)]
pub enum ColmapDescriptorMatrix {
    SiftU8(Vec<[u8; SIFT_DESCRIPTOR_BYTES_PER_ROW]>),
    AlikedN16RotF32(Vec<[f32; ALIKED_DESCRIPTOR_DIMENSIONS]>),
    AlikedN32F32(Vec<[f32; ALIKED_DESCRIPTOR_DIMENSIONS]>),
}

impl ColmapDescriptorMatrix {
    #[must_use]
    pub fn rows(&self) -> usize {
        match self {
            Self::SiftU8(rows) => rows.len(),
            Self::AlikedN16RotF32(rows) | Self::AlikedN32F32(rows) => rows.len(),
        }
    }

    #[must_use]
    pub const fn bytes_per_row(&self) -> usize {
        match self {
            Self::SiftU8(_) => SIFT_DESCRIPTOR_BYTES_PER_ROW,
            Self::AlikedN16RotF32(_) | Self::AlikedN32F32(_) => ALIKED_DESCRIPTOR_BYTES_PER_ROW,
        }
    }

    fn to_blob(&self) -> Vec<u8> {
        match self {
            Self::SiftU8(rows) => rows.iter().flatten().copied().collect(),
            Self::AlikedN16RotF32(rows) | Self::AlikedN32F32(rows) => {
                let mut output = Vec::with_capacity(rows.len() * ALIKED_DESCRIPTOR_BYTES_PER_ROW);
                append_float_rows(rows, &mut output);
                output
            }
        }
    }

    const fn extractor_type(&self) -> i64 {
        // COLMAP 4.0's FeatureExtractorType enum is zero-based after UNDEFINED=-1.
        match self {
            Self::SiftU8(_) => 0,
            Self::AlikedN16RotF32(_) => 1,
            Self::AlikedN32F32(_) => 2,
        }
    }

    fn truncate(&mut self, rows: usize) {
        match self {
            Self::SiftU8(values) => values.truncate(rows),
            Self::AlikedN16RotF32(values) | Self::AlikedN32F32(values) => values.truncate(rows),
        }
    }

    fn select_rows(&mut self, indices: &[usize]) {
        match self {
            Self::SiftU8(rows) => *rows = indices.iter().map(|&index| rows[index]).collect(),
            Self::AlikedN16RotF32(rows) | Self::AlikedN32F32(rows) => {
                *rows = indices.iter().map(|&index| rows[index]).collect();
            }
        }
    }
}

/// Features for one image, including sidecar-owned ALIKED detector scores when
/// the extractor supplied a complete row-aligned set.
#[derive(Debug, Clone, PartialEq)]
pub struct ColmapImageFeatures {
    pub image_id: i64,
    pub keypoints: ColmapKeypointMatrix,
    pub descriptors: ColmapDescriptorMatrix,
    pub scores: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeypointCapOrdering {
    Score,
    Proxy,
}

impl KeypointCapOrdering {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Score => "score",
            Self::Proxy => "proxy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColmapFeatureCapSummary {
    pub maximum_before_cap: u32,
    pub maximum_after_cap: u32,
    pub ordering: KeypointCapOrdering,
}

#[derive(Debug, Error)]
pub enum ColmapFeatureDbError {
    #[error("COLMAP database image is missing: {0}")]
    MissingImage(String),
    #[error("invalid COLMAP feature database schema: {0}")]
    InvalidSchema(String),
    #[error("unsupported COLMAP keypoint layout with {0} columns")]
    UnsupportedKeypointLayout(i64),
    #[error("unsupported COLMAP descriptor layout with {0} bytes per row")]
    UnsupportedDescriptorLayout(i64),
    #[error("invalid COLMAP feature data: {0}")]
    InvalidData(String),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Opens a COLMAP database without creating or mutating it and returns the
/// feature rows belonging to `image_name`.
pub fn read_image_features(
    database_path: &Path,
    image_name: &str,
) -> Result<ColmapImageFeatures, ColmapFeatureDbError> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let image_id = connection
        .query_row(
            "SELECT image_id FROM images WHERE name = ?1",
            [image_name],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| ColmapFeatureDbError::MissingImage(image_name.to_owned()))?;
    let (keypoint_rows, keypoint_columns, keypoint_blob) = read_matrix_row(
        &connection,
        "SELECT rows, cols, data FROM keypoints WHERE image_id = ?1",
        image_id,
        "keypoints",
    )?;
    let keypoints = decode_keypoints(keypoint_rows, keypoint_columns, &keypoint_blob)?;
    let (descriptor_rows, descriptor_columns, descriptor_blob, descriptor_type) = connection
        .query_row(
            "SELECT rows, cols, data, type FROM descriptors WHERE image_id = ?1",
            [image_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            ColmapFeatureDbError::InvalidSchema(format!(
                "descriptors has no row for image id {image_id}"
            ))
        })?;
    if descriptor_rows < 0 || descriptor_columns < 0 {
        return Err(ColmapFeatureDbError::InvalidData(
            "descriptors contains a negative matrix shape".into(),
        ));
    }
    if descriptor_rows != keypoint_rows {
        return Err(ColmapFeatureDbError::InvalidData(format!(
            "keypoint row count {keypoint_rows} differs from descriptor row count {descriptor_rows}"
        )));
    }
    let descriptors = decode_descriptors(
        descriptor_rows,
        descriptor_columns,
        descriptor_type,
        &descriptor_blob,
    )?;
    let scores = read_keypoint_scores(&connection, image_id, keypoints.rows())?;
    Ok(ColmapImageFeatures {
        image_id,
        keypoints,
        descriptors,
        scores,
    })
}

/// Replaces one image's keypoints and descriptors in one immediate transaction.
/// The image row must already have been created by COLMAP's image reader so its
/// camera, frame and metadata relationships remain authoritative.
pub fn write_image_features(
    database_path: &Path,
    image_id: i64,
    keypoints: &ColmapKeypointMatrix,
    descriptors: &ColmapDescriptorMatrix,
) -> Result<(), ColmapFeatureDbError> {
    write_image_features_with_scores(database_path, image_id, keypoints, descriptors, None)
}

/// Replaces one image's keypoints, descriptors and optional row-aligned scores
/// in one immediate transaction.
pub fn write_image_features_with_scores(
    database_path: &Path,
    image_id: i64,
    keypoints: &ColmapKeypointMatrix,
    descriptors: &ColmapDescriptorMatrix,
    scores: Option<&[f32]>,
) -> Result<(), ColmapFeatureDbError> {
    if image_id <= 0 {
        return Err(ColmapFeatureDbError::InvalidData(
            "image id must be positive".into(),
        ));
    }
    if keypoints.rows() != descriptors.rows() {
        return Err(ColmapFeatureDbError::InvalidData(format!(
            "keypoint row count {} differs from descriptor row count {}",
            keypoints.rows(),
            descriptors.rows()
        )));
    }
    validate_finite_keypoints(keypoints)?;
    validate_finite_descriptors(descriptors)?;
    if let Some(scores) = scores {
        if scores.len() != keypoints.rows() {
            return Err(ColmapFeatureDbError::InvalidData(format!(
                "keypoint row count {} differs from score row count {}",
                keypoints.rows(),
                scores.len()
            )));
        }
        if !scores.iter().all(|score| score.is_finite()) {
            return Err(ColmapFeatureDbError::InvalidData(
                "keypoint scores contain a non-finite float".into(),
            ));
        }
    }
    let rows = i64::try_from(keypoints.rows()).map_err(|_| {
        ColmapFeatureDbError::InvalidData("feature row count exceeds SQLite range".into())
    })?;
    let keypoint_columns = i64::try_from(keypoints.columns()).expect("keypoint columns fit i64");
    let descriptor_columns =
        i64::try_from(descriptors.bytes_per_row()).expect("descriptor columns fit i64");
    let mut keypoint_blob =
        Vec::with_capacity(keypoints.rows() * keypoints.columns() * size_of::<f32>());
    keypoints.append_le_bytes(&mut keypoint_blob);
    let descriptor_blob = descriptors.to_blob();

    let mut connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let image_exists = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM images WHERE image_id = ?1)",
        [image_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !image_exists {
        return Err(ColmapFeatureDbError::MissingImage(image_id.to_string()));
    }
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS himmelcad_keypoint_scores (\
             image_id INTEGER NOT NULL,\
             row_index INTEGER NOT NULL,\
             score REAL NOT NULL,\
             PRIMARY KEY(image_id, row_index),\
             FOREIGN KEY(image_id) REFERENCES images(image_id) ON DELETE CASCADE\
         );",
    )?;
    assert_score_table_schema(&transaction)?;
    transaction.execute(
        "INSERT OR REPLACE INTO keypoints(image_id, rows, cols, data) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![image_id, rows, keypoint_columns, keypoint_blob],
    )?;
    transaction.execute(
        "INSERT OR REPLACE INTO descriptors(image_id, rows, cols, data, type) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            image_id,
            rows,
            descriptor_columns,
            descriptor_blob,
            descriptors.extractor_type()
        ],
    )?;
    transaction.execute(
        "DELETE FROM himmelcad_keypoint_scores WHERE image_id = ?1",
        [image_id],
    )?;
    if let Some(scores) = scores {
        let mut statement = transaction.prepare(
            "INSERT INTO himmelcad_keypoint_scores(image_id, row_index, score) \
             VALUES (?1, ?2, ?3)",
        )?;
        for (row_index, score) in scores.iter().copied().enumerate() {
            let row_index = i64::try_from(row_index).map_err(|_| {
                ColmapFeatureDbError::InvalidData("score row index exceeds SQLite range".into())
            })?;
            statement.execute(rusqlite::params![image_id, row_index, f64::from(score)])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

/// Returns the largest stored keypoint row count without loading descriptor blobs.
pub fn maximum_keypoint_count(database_path: &Path) -> Result<u32, ColmapFeatureDbError> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let rows = connection.query_row("SELECT COALESCE(MAX(rows), 0) FROM keypoints", [], |row| {
        row.get::<_, i64>(0)
    })?;
    if rows < 0 {
        return Err(ColmapFeatureDbError::InvalidData(
            "keypoints contains a negative matrix shape".into(),
        ));
    }
    u32::try_from(rows).map_err(|_| {
        ColmapFeatureDbError::InvalidData("keypoint row count exceeds u32 range".into())
    })
}

/// Deterministically trims every image by true score when complete side-table
/// rows exist, otherwise by the stable extractor row-order proxy.
pub fn cap_database_features(
    database_path: &Path,
    cap: u32,
) -> Result<ColmapFeatureCapSummary, ColmapFeatureDbError> {
    if cap == 0 {
        return Err(ColmapFeatureDbError::InvalidData(
            "feature cap must be greater than zero".into(),
        ));
    }
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let image_names = {
        let mut statement = connection.prepare("SELECT name FROM images ORDER BY image_id")?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        names
    };
    drop(connection);

    let cap = usize::try_from(cap).unwrap_or(usize::MAX);
    let mut maximum_before_cap = 0_usize;
    let mut maximum_after_cap = 0_usize;
    let mut ordering = KeypointCapOrdering::Score;
    for image_name in image_names {
        let mut features = read_image_features(database_path, &image_name)?;
        maximum_before_cap = maximum_before_cap.max(features.keypoints.rows());
        if let Some(scores) = features.scores.take() {
            let mut indices = (0..features.keypoints.rows()).collect::<Vec<_>>();
            indices.sort_by(|&left, &right| {
                let (left_x, left_y) = features.keypoints.coordinates(left);
                let (right_x, right_y) = features.keypoints.coordinates(right);
                scores[right]
                    .total_cmp(&scores[left])
                    .then_with(|| left_x.total_cmp(&right_x))
                    .then_with(|| left_y.total_cmp(&right_y))
                    .then_with(|| left.cmp(&right))
            });
            indices.truncate(cap);
            features.keypoints.select_rows(&indices);
            features.descriptors.select_rows(&indices);
            features.scores = Some(indices.iter().map(|&index| scores[index]).collect());
        } else {
            ordering = KeypointCapOrdering::Proxy;
            features.keypoints.truncate(cap);
            features.descriptors.truncate(cap);
        }
        maximum_after_cap = maximum_after_cap.max(features.keypoints.rows());
        write_image_features_with_scores(
            database_path,
            features.image_id,
            &features.keypoints,
            &features.descriptors,
            features.scores.as_deref(),
        )?;
    }
    Ok(ColmapFeatureCapSummary {
        maximum_before_cap: u32::try_from(maximum_before_cap).map_err(|_| {
            ColmapFeatureDbError::InvalidData("keypoint row count exceeds u32 range".into())
        })?,
        maximum_after_cap: u32::try_from(maximum_after_cap).map_err(|_| {
            ColmapFeatureDbError::InvalidData("keypoint row count exceeds u32 range".into())
        })?,
        ordering,
    })
}

fn read_keypoint_scores(
    connection: &Connection,
    image_id: i64,
    expected_rows: usize,
) -> Result<Option<Vec<f32>>, ColmapFeatureDbError> {
    let table_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'himmelcad_keypoint_scores')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !table_exists {
        return Ok(None);
    }
    assert_score_table_schema(connection)?;
    let mut statement = connection.prepare(
        "SELECT row_index, score FROM himmelcad_keypoint_scores \
         WHERE image_id = ?1 ORDER BY row_index",
    )?;
    let rows = statement
        .query_map([image_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() != expected_rows
        || rows
            .iter()
            .enumerate()
            .any(|(expected, (actual, _))| i64::try_from(expected).ok() != Some(*actual))
    {
        return Ok(None);
    }
    rows.into_iter()
        .map(|(_, score)| {
            let score = score as f32;
            if score.is_finite() {
                Ok(score)
            } else {
                Err(ColmapFeatureDbError::InvalidData(
                    "keypoint scores contain a non-finite float".into(),
                ))
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn assert_score_table_schema(connection: &Connection) -> Result<(), ColmapFeatureDbError> {
    let mut statement = connection.prepare("PRAGMA table_info(himmelcad_keypoint_scores)")?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let expected = [
        ("image_id".to_owned(), "INTEGER".to_owned(), 1, 1),
        ("row_index".to_owned(), "INTEGER".to_owned(), 1, 2),
        ("score".to_owned(), "REAL".to_owned(), 1, 0),
    ];
    if columns == expected {
        Ok(())
    } else {
        Err(ColmapFeatureDbError::InvalidSchema(format!(
            "himmelcad_keypoint_scores columns differ from the sidecar schema: {columns:?}"
        )))
    }
}

fn read_matrix_row(
    connection: &Connection,
    query: &str,
    image_id: i64,
    table: &str,
) -> Result<(i64, i64, Vec<u8>), ColmapFeatureDbError> {
    let row = connection
        .query_row(query, [image_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
            ))
        })
        .optional()?
        .ok_or_else(|| {
            ColmapFeatureDbError::InvalidSchema(format!(
                "{table} has no row for image id {image_id}"
            ))
        })?;
    if row.0 < 0 || row.1 < 0 {
        return Err(ColmapFeatureDbError::InvalidData(format!(
            "{table} contains a negative matrix shape"
        )));
    }
    Ok(row)
}

fn decode_keypoints(
    rows: i64,
    columns: i64,
    blob: &[u8],
) -> Result<ColmapKeypointMatrix, ColmapFeatureDbError> {
    let rows = usize::try_from(rows).map_err(|_| {
        ColmapFeatureDbError::InvalidData("keypoint row count exceeds memory range".into())
    })?;
    let columns_usize = usize::try_from(columns).map_err(|_| {
        ColmapFeatureDbError::InvalidData("keypoint column count exceeds memory range".into())
    })?;
    let expected = rows
        .checked_mul(columns_usize)
        .and_then(|value| value.checked_mul(size_of::<f32>()))
        .ok_or_else(|| ColmapFeatureDbError::InvalidData("keypoint blob size overflow".into()))?;
    if blob.len() != expected {
        return Err(ColmapFeatureDbError::InvalidData(format!(
            "keypoint blob has {} bytes; expected {expected}",
            blob.len()
        )));
    }
    match columns {
        2 => Ok(ColmapKeypointMatrix::Coordinates(decode_float_rows(blob)?)),
        4 => Ok(ColmapKeypointMatrix::Similarity(decode_float_rows(blob)?)),
        6 => Ok(ColmapKeypointMatrix::Affine(decode_float_rows(blob)?)),
        _ => Err(ColmapFeatureDbError::UnsupportedKeypointLayout(columns)),
    }
}

fn decode_descriptors(
    rows: i64,
    bytes_per_row: i64,
    extractor_type: i64,
    blob: &[u8],
) -> Result<ColmapDescriptorMatrix, ColmapFeatureDbError> {
    let rows = usize::try_from(rows).map_err(|_| {
        ColmapFeatureDbError::InvalidData("descriptor row count exceeds memory range".into())
    })?;
    let bytes_per_row_usize = usize::try_from(bytes_per_row).map_err(|_| {
        ColmapFeatureDbError::InvalidData("descriptor width exceeds memory range".into())
    })?;
    let expected = rows
        .checked_mul(bytes_per_row_usize)
        .ok_or_else(|| ColmapFeatureDbError::InvalidData("descriptor blob size overflow".into()))?;
    if blob.len() != expected {
        return Err(ColmapFeatureDbError::InvalidData(format!(
            "descriptor blob has {} bytes; expected {expected}",
            blob.len()
        )));
    }
    match (bytes_per_row_usize, extractor_type) {
        (SIFT_DESCRIPTOR_BYTES_PER_ROW, 0) => {
            let values = blob
                .chunks_exact(SIFT_DESCRIPTOR_BYTES_PER_ROW)
                .map(|row| row.try_into().expect("validated SIFT descriptor width"))
                .collect();
            Ok(ColmapDescriptorMatrix::SiftU8(values))
        }
        (ALIKED_DESCRIPTOR_BYTES_PER_ROW, 1) => Ok(ColmapDescriptorMatrix::AlikedN16RotF32(
            decode_float_rows(blob)?,
        )),
        (ALIKED_DESCRIPTOR_BYTES_PER_ROW, 2) => Ok(ColmapDescriptorMatrix::AlikedN32F32(
            decode_float_rows(blob)?,
        )),
        (_, -1 | 0 | 1 | 2) => Err(ColmapFeatureDbError::UnsupportedDescriptorLayout(
            bytes_per_row,
        )),
        _ => {
            return Err(ColmapFeatureDbError::InvalidData(format!(
                "unsupported COLMAP feature extractor type {extractor_type}"
            )))
        }
    }
}

fn append_float_rows<const COLUMNS: usize>(rows: &[[f32; COLUMNS]], output: &mut Vec<u8>) {
    for value in rows.iter().flatten() {
        output.extend_from_slice(&value.to_le_bytes());
    }
}

fn decode_float_rows<const COLUMNS: usize>(
    blob: &[u8],
) -> Result<Vec<[f32; COLUMNS]>, ColmapFeatureDbError> {
    let bytes_per_row = COLUMNS * size_of::<f32>();
    if !blob.len().is_multiple_of(bytes_per_row) {
        return Err(ColmapFeatureDbError::InvalidData(
            "float matrix blob is not row-aligned".into(),
        ));
    }
    blob.chunks_exact(bytes_per_row)
        .map(|row| {
            let mut values = [0.0_f32; COLUMNS];
            for (value, bytes) in values.iter_mut().zip(row.chunks_exact(size_of::<f32>())) {
                *value = f32::from_le_bytes(bytes.try_into().expect("four-byte float chunk"));
            }
            if values.iter().all(|value| value.is_finite()) {
                Ok(values)
            } else {
                Err(ColmapFeatureDbError::InvalidData(
                    "feature matrix contains a non-finite float".into(),
                ))
            }
        })
        .collect()
}

fn validate_finite_keypoints(keypoints: &ColmapKeypointMatrix) -> Result<(), ColmapFeatureDbError> {
    let finite = match keypoints {
        ColmapKeypointMatrix::Coordinates(rows) => {
            rows.iter().flatten().all(|value| value.is_finite())
        }
        ColmapKeypointMatrix::Similarity(rows) => {
            rows.iter().flatten().all(|value| value.is_finite())
        }
        ColmapKeypointMatrix::Affine(rows) => rows.iter().flatten().all(|value| value.is_finite()),
    };
    if finite {
        Ok(())
    } else {
        Err(ColmapFeatureDbError::InvalidData(
            "keypoint matrix contains a non-finite float".into(),
        ))
    }
}

fn validate_finite_descriptors(
    descriptors: &ColmapDescriptorMatrix,
) -> Result<(), ColmapFeatureDbError> {
    if matches!(
        descriptors,
        ColmapDescriptorMatrix::AlikedN16RotF32(rows)
        | ColmapDescriptorMatrix::AlikedN32F32(rows)
            if !rows.iter().flatten().all(|value| value.is_finite())
    ) {
        Err(ColmapFeatureDbError::InvalidData(
            "descriptor matrix contains a non-finite float".into(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "himmelcad-colmap-feature-db-{}-{nonce}.db",
            std::process::id()
        ))
    }

    #[test]
    fn round_trips_the_colmap_4_aliked_schema() {
        let path = fixture_path();
        let connection = Connection::open(&path).expect("create fixture database");
        connection
            .execute_batch(
                "CREATE TABLE images (image_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, camera_id INTEGER NOT NULL);\
                 CREATE TABLE keypoints (image_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB, FOREIGN KEY(image_id) REFERENCES images(image_id) ON DELETE CASCADE);\
                 CREATE TABLE descriptors (image_id INTEGER PRIMARY KEY NOT NULL, type INTEGER NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB, FOREIGN KEY(image_id) REFERENCES images(image_id) ON DELETE CASCADE);\
                 INSERT INTO images(image_id, name, camera_id) VALUES (7, 'tiles/tile.png', 3);",
            )
            .expect("create COLMAP schema fixture");
        fn columns(connection: &Connection, table: &str) -> Vec<(String, String)> {
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .expect("read fixture schema");
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })
                .expect("query fixture schema")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect fixture schema")
        }
        assert_eq!(
            columns(&connection, "keypoints"),
            [
                ("image_id", "INTEGER"),
                ("rows", "INTEGER"),
                ("cols", "INTEGER"),
                ("data", "BLOB")
            ]
            .map(|(name, kind)| (name.to_owned(), kind.to_owned()))
        );
        assert_eq!(
            columns(&connection, "descriptors"),
            [
                ("image_id", "INTEGER"),
                ("type", "INTEGER"),
                ("rows", "INTEGER"),
                ("cols", "INTEGER"),
                ("data", "BLOB"),
            ]
            .map(|(name, kind)| (name.to_owned(), kind.to_owned()))
        );
        drop(connection);

        let keypoints = ColmapKeypointMatrix::Affine(vec![
            [1.5, 2.5, 1.0, 0.0, 0.0, 1.0],
            [9.0, 8.0, 1.0, 0.0, 0.0, 1.0],
        ]);
        let descriptors = ColmapDescriptorMatrix::AlikedN16RotF32(vec![
            [0.25; ALIKED_DESCRIPTOR_DIMENSIONS],
            [-0.5; ALIKED_DESCRIPTOR_DIMENSIONS],
        ]);
        let scores = [0.125, 0.875];
        write_image_features_with_scores(&path, 7, &keypoints, &descriptors, Some(&scores))
            .expect("write ALIKED features");
        let round_trip =
            read_image_features(&path, "tiles/tile.png").expect("read ALIKED features");
        assert_eq!(round_trip.image_id, 7);
        assert_eq!(round_trip.keypoints, keypoints);
        assert_eq!(round_trip.descriptors, descriptors);
        assert_eq!(round_trip.scores, Some(scores.to_vec()));

        let connection = Connection::open(&path).expect("reopen fixture");
        assert_eq!(
            connection
                .query_row(
                    "SELECT rows, cols, length(data) FROM keypoints",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    }
                )
                .expect("keypoint layout"),
            (2, 6, 48)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT rows, cols, length(data), type FROM descriptors",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    }
                )
                .expect("descriptor layout"),
            (2, 512, 1_024, 1)
        );
        assert_eq!(
            columns(&connection, "himmelcad_keypoint_scores"),
            [
                ("image_id", "INTEGER"),
                ("row_index", "INTEGER"),
                ("score", "REAL"),
            ]
            .map(|(name, kind)| (name.to_owned(), kind.to_owned()))
        );
        assert_eq!(
            connection
                .prepare(
                    "SELECT image_id, row_index, score FROM himmelcad_keypoint_scores \
                     ORDER BY row_index",
                )
                .expect("read score rows")
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, f64>(2)?,
                    ))
                })
                .expect("query score rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect score rows"),
            [(7, 0, 0.125), (7, 1, 0.875)]
        );
        drop(connection);
        fs::remove_file(path).expect("remove fixture");
    }

    fn write_cap_fixture(path: &Path, scores: Option<&[f32]>) {
        let connection = Connection::open(path).expect("create cap fixture database");
        connection
            .execute_batch(
                "CREATE TABLE images (image_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, camera_id INTEGER NOT NULL);\
                 CREATE TABLE keypoints (image_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);\
                 CREATE TABLE descriptors (image_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB, type INTEGER NOT NULL);\
                 INSERT INTO images(image_id, name, camera_id) VALUES (1, 'image.jpg', 1);",
            )
            .expect("create cap fixture schema");
        drop(connection);
        write_image_features_with_scores(
            path,
            1,
            &ColmapKeypointMatrix::Affine(vec![
                [30.0, 4.0, 1.0, 0.0, 0.0, 1.0],
                [10.0, 2.0, 1.0, 0.0, 0.0, 1.0],
                [20.0, 3.0, 1.0, 0.0, 0.0, 1.0],
                [40.0, 5.0, 1.0, 0.0, 0.0, 1.0],
                [50.0, 6.0, 1.0, 0.0, 0.0, 1.0],
                [60.0, 7.0, 1.0, 0.0, 0.0, 1.0],
            ]),
            &ColmapDescriptorMatrix::AlikedN32F32(
                (0..6).map(|index| [index as f32; 128]).collect(),
            ),
            scores,
        )
        .expect("write cap fixture features");
    }

    fn feature_set_hash(path: &Path) -> [u8; 32] {
        let features = read_image_features(path, "image.jpg").expect("read capped fixture");
        let mut bytes = Vec::new();
        features.keypoints.append_le_bytes(&mut bytes);
        bytes.extend(features.descriptors.to_blob());
        if let Some(scores) = features.scores {
            for score in scores {
                bytes.extend_from_slice(&score.to_le_bytes());
            }
        }
        Sha256::digest(bytes).into()
    }

    #[test]
    fn database_cap_keeps_exactly_the_stable_row_order_prefix() {
        let first = fixture_path();
        let second = fixture_path().with_extension("second.db");
        write_cap_fixture(&first, None);
        write_cap_fixture(&second, None);
        for path in [&first, &second] {
            assert_eq!(maximum_keypoint_count(path).expect("maximum before"), 6);
            assert_eq!(
                cap_database_features(path, 3).expect("cap fixture"),
                ColmapFeatureCapSummary {
                    maximum_before_cap: 6,
                    maximum_after_cap: 3,
                    ordering: KeypointCapOrdering::Proxy,
                }
            );
            assert_eq!(maximum_keypoint_count(path).expect("maximum after"), 3);
        }
        assert_eq!(feature_set_hash(&first), feature_set_hash(&second));
        let capped = read_image_features(&first, "image.jpg").expect("read capped rows");
        assert!(matches!(
            capped.keypoints,
            ColmapKeypointMatrix::Affine(ref rows)
                if rows.iter().map(|row| row[0]).collect::<Vec<_>>() == [30.0, 10.0, 20.0]
        ));
        fs::remove_file(first).expect("remove first cap fixture");
        fs::remove_file(second).expect("remove second cap fixture");
    }

    #[test]
    fn database_cap_uses_scores_with_xy_ties_and_is_hash_deterministic() {
        let first = fixture_path();
        let second = fixture_path().with_extension("second.db");
        let scores = [0.4, 0.9, 0.9, 0.3, 0.2, 0.1];
        write_cap_fixture(&first, Some(&scores));
        write_cap_fixture(&second, Some(&scores));
        for path in [&first, &second] {
            assert_eq!(
                cap_database_features(path, 3).expect("cap scored fixture"),
                ColmapFeatureCapSummary {
                    maximum_before_cap: 6,
                    maximum_after_cap: 3,
                    ordering: KeypointCapOrdering::Score,
                }
            );
        }
        assert_eq!(feature_set_hash(&first), feature_set_hash(&second));
        let capped = read_image_features(&first, "image.jpg").expect("read scored rows");
        assert!(matches!(
            capped.keypoints,
            ColmapKeypointMatrix::Affine(ref rows)
                if rows.iter().map(|row| row[0]).collect::<Vec<_>>() == [10.0, 20.0, 30.0]
        ));
        assert_eq!(capped.scores, Some(vec![0.9, 0.9, 0.4]));
        fs::remove_file(first).expect("remove first scored fixture");
        fs::remove_file(second).expect("remove second scored fixture");
    }
}
