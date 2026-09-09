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
}

/// Features for one image. COLMAP does not persist ALIKED detector scores, so
/// callers that need ranking must use the stable extractor row order.
#[derive(Debug, Clone, PartialEq)]
pub struct ColmapImageFeatures {
    pub image_id: i64,
    pub keypoints: ColmapKeypointMatrix,
    pub descriptors: ColmapDescriptorMatrix,
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
    Ok(ColmapImageFeatures {
        image_id,
        keypoints,
        descriptors,
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
    transaction.commit()?;
    Ok(())
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
        let columns = |table: &str| {
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
        };
        assert_eq!(
            columns("keypoints"),
            [
                ("image_id", "INTEGER"),
                ("rows", "INTEGER"),
                ("cols", "INTEGER"),
                ("data", "BLOB")
            ]
            .map(|(name, kind)| (name.to_owned(), kind.to_owned()))
        );
        assert_eq!(
            columns("descriptors"),
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
        write_image_features(&path, 7, &keypoints, &descriptors).expect("write ALIKED features");
        let round_trip =
            read_image_features(&path, "tiles/tile.png").expect("read ALIKED features");
        assert_eq!(round_trip.image_id, 7);
        assert_eq!(round_trip.keypoints, keypoints);
        assert_eq!(round_trip.descriptors, descriptors);

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
        drop(connection);
        fs::remove_file(path).expect("remove fixture");
    }
}
