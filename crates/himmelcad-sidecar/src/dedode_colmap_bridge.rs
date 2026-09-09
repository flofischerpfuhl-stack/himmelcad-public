//! Deterministic DeDoDe feature/match import for COLMAP's public text formats.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

use himmelcad_core::photolab_jobs::CancellationToken;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    dedode_runtime::{DedodeMatch, DedodeRunOutcome},
    image_commit::ProjectCameraImageRecord,
};

const COLMAP_DESCRIPTOR_COLUMNS: usize = 128;
const MAX_IMPORTED_FEATURES: usize = 50_000_000;
const COORDINATE_TOLERANCE_PIXELS: f32 = 0.25;
// WP-A7b X6 tunable: two pixels suppresses duplicate detections in a 256 px
// tile overlap without collapsing distinct nearby image structure.
const TILED_FEATURE_DEDUPLICATION_RADIUS_PX: f32 = 2.0;

/// One scored ALIKED feature recovered from a tile extraction result.
#[derive(Debug, Clone, PartialEq)]
pub struct TiledAlikedFeature {
    pub x: f32,
    pub y: f32,
    pub a11: f32,
    pub a12: f32,
    pub a21: f32,
    pub a22: f32,
    pub score: f32,
    pub descriptor: [f32; COLMAP_DESCRIPTOR_COLUMNS],
}

/// Stable tile identity and its offset in the resized source image.
#[derive(Debug, Clone, PartialEq)]
pub struct TiledAlikedFeatureSet {
    pub tile_index: u32,
    pub origin_x: u32,
    pub origin_y: u32,
    pub features: Vec<TiledAlikedFeature>,
}

/// Merges tile-local features into deterministic source-image coordinates.
///
/// Higher-scored overlap detections win within the X6 radius. The resulting
/// set is globally top-k bounded, so tiling never widens the requested per-image
/// feature budget.
pub fn merge_tiled_aliked_features(
    tiles: &[TiledAlikedFeatureSet],
    max_features: u32,
) -> Result<Vec<TiledAlikedFeature>, DedodeColmapBridgeError> {
    if max_features == 0 {
        return Err(DedodeColmapBridgeError::InvalidInput(
            "tiled ALIKED feature budget must be greater than zero".into(),
        ));
    }
    let mut candidates = Vec::new();
    for tile in tiles {
        for feature in &tile.features {
            if ![
                feature.x,
                feature.y,
                feature.a11,
                feature.a12,
                feature.a21,
                feature.a22,
                feature.score,
            ]
            .into_iter()
            .all(f32::is_finite)
                || !feature.descriptor.iter().all(|value| value.is_finite())
                || feature.x < 0.0
                || feature.y < 0.0
            {
                return Err(DedodeColmapBridgeError::InvalidInput(
                    "tiled ALIKED features require finite non-negative coordinates and finite metadata"
                        .into(),
                ));
            }
            let mut shifted = feature.clone();
            shifted.x += tile.origin_x as f32;
            shifted.y += tile.origin_y as f32;
            candidates.push((shifted, tile.tile_index));
        }
    }
    candidates.sort_by(|(left, left_tile), (right, right_tile)| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.x.total_cmp(&right.x))
            .then_with(|| left.y.total_cmp(&right.y))
            .then_with(|| compare_float_descriptors(&left.descriptor, &right.descriptor))
            .then_with(|| left.a11.total_cmp(&right.a11))
            .then_with(|| left.a12.total_cmp(&right.a12))
            .then_with(|| left.a21.total_cmp(&right.a21))
            .then_with(|| left.a22.total_cmp(&right.a22))
            .then_with(|| left_tile.cmp(right_tile))
    });

    let radius = TILED_FEATURE_DEDUPLICATION_RADIUS_PX;
    let radius_squared = radius * radius;
    let mut cells = BTreeMap::<(i64, i64), Vec<usize>>::new();
    let mut merged = Vec::with_capacity(
        candidates
            .len()
            .min(usize::try_from(max_features).unwrap_or(usize::MAX)),
    );
    for (feature, _) in candidates {
        let cell = (
            (feature.x / radius).floor() as i64,
            (feature.y / radius).floor() as i64,
        );
        let duplicate = (-1..=1).any(|offset_x| {
            (-1..=1).any(|offset_y| {
                cells
                    .get(&(cell.0 + offset_x, cell.1 + offset_y))
                    .into_iter()
                    .flatten()
                    .any(|&index| {
                        let existing: &TiledAlikedFeature = &merged[index];
                        let delta_x = existing.x - feature.x;
                        let delta_y = existing.y - feature.y;
                        delta_x * delta_x + delta_y * delta_y <= radius_squared
                    })
            })
        });
        if duplicate {
            continue;
        }
        cells.entry(cell).or_default().push(merged.len());
        merged.push(feature);
        if merged.len() == usize::try_from(max_features).unwrap_or(usize::MAX) {
            break;
        }
    }
    Ok(merged)
}

fn compare_float_descriptors(
    left: &[f32; COLMAP_DESCRIPTOR_COLUMNS],
    right: &[f32; COLMAP_DESCRIPTOR_COLUMNS],
) -> std::cmp::Ordering {
    left.iter()
        .zip(right)
        .map(|(left, right)| left.total_cmp(right))
        .find(|ordering| !ordering.is_eq())
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// Files consumed by COLMAP's `feature_importer` and `matches_importer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DedodeColmapImport {
    pub feature_directory: PathBuf,
    pub match_list_path: PathBuf,
    pub database_path: PathBuf,
    pub image_count: u32,
    pub feature_count: u64,
    pub pair_count: u32,
    pub match_count: u64,
}

#[derive(Debug, Error)]
pub enum DedodeColmapBridgeError {
    #[error("invalid DeDoDe-to-COLMAP input: {0}")]
    InvalidInput(String),
    #[error("DeDoDe-to-COLMAP import was cancelled")]
    Cancelled,
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone, Copy)]
struct FeatureCoordinate {
    x: f32,
    y: f32,
}

/// Aggregates pair-local observations into stable per-image feature indices.
///
/// The emitted descriptors are deterministic sentinels. They are deliberately
/// never passed through a descriptor matcher: only the explicitly imported
/// DeDoDe raw matches are geometrically verified by COLMAP.
pub fn prepare_dedode_colmap_import(
    outcome: &DedodeRunOutcome,
    cameras: &[ProjectCameraImageRecord],
    materialized_names: &[PathBuf],
    scratch: &Path,
    cancellation: &CancellationToken,
) -> Result<DedodeColmapImport, DedodeColmapBridgeError> {
    if cameras.len() != materialized_names.len() || cameras.len() < 2 {
        return Err(DedodeColmapBridgeError::InvalidInput(
            "camera and materialized-image lists must have the same length >= 2".into(),
        ));
    }
    if outcome.pairs.is_empty() {
        return Err(DedodeColmapBridgeError::InvalidInput(
            "DeDoDe outcome contains no image pairs".into(),
        ));
    }

    let mut image_names = BTreeMap::new();
    for (camera, name) in cameras.iter().zip(materialized_names) {
        validate_relative_image_name(name)?;
        if image_names
            .insert(camera.entity_id.0.clone(), name.clone())
            .is_some()
        {
            return Err(DedodeColmapBridgeError::InvalidInput(format!(
                "duplicate camera entity {}",
                camera.entity_id.0
            )));
        }
    }

    let mut features = image_names
        .keys()
        .map(|id| (id.clone(), BTreeMap::<u32, FeatureCoordinate>::new()))
        .collect::<BTreeMap<_, _>>();
    let mut ordered_pairs = outcome.pairs.iter().collect::<Vec<_>>();
    ordered_pairs.sort_by(|left, right| {
        (&left.pair.image_a, &left.pair.image_b).cmp(&(&right.pair.image_a, &right.pair.image_b))
    });
    let mut seen_pairs = BTreeSet::new();
    let mut total_matches = 0_u64;
    for pair in &ordered_pairs {
        check_cancelled(cancellation)?;
        if pair.pair.image_a == pair.pair.image_b
            || !image_names.contains_key(&pair.pair.image_a)
            || !image_names.contains_key(&pair.pair.image_b)
        {
            return Err(DedodeColmapBridgeError::InvalidInput(
                "every DeDoDe pair must reference two request cameras".into(),
            ));
        }
        let canonical = if pair.pair.image_a < pair.pair.image_b {
            (&pair.pair.image_a, &pair.pair.image_b)
        } else {
            (&pair.pair.image_b, &pair.pair.image_a)
        };
        if !seen_pairs.insert((canonical.0.clone(), canonical.1.clone())) {
            return Err(DedodeColmapBridgeError::InvalidInput(
                "duplicate DeDoDe image pair".into(),
            ));
        }
        let mut unique_matches = BTreeSet::new();
        for (match_index, item) in pair.matches.iter().enumerate() {
            if match_index % 1_024 == 0 {
                check_cancelled(cancellation)?;
            }
            validate_match(item)?;
            if !unique_matches.insert((item.feature_a, item.feature_b)) {
                return Err(DedodeColmapBridgeError::InvalidInput(
                    "duplicate raw match in DeDoDe pair".into(),
                ));
            }
            insert_feature(
                features
                    .get_mut(&pair.pair.image_a)
                    .expect("validated image A exists"),
                item.feature_a,
                item.x_a,
                item.y_a,
            )?;
            insert_feature(
                features
                    .get_mut(&pair.pair.image_b)
                    .expect("validated image B exists"),
                item.feature_b,
                item.x_b,
                item.y_b,
            )?;
        }
        total_matches = total_matches
            .checked_add(u64::try_from(pair.matches.len()).expect("usize fits u64"))
            .ok_or_else(|| DedodeColmapBridgeError::InvalidInput("match count overflow".into()))?;
    }
    let total_features = features.values().try_fold(0_usize, |total, values| {
        total
            .checked_add(values.len())
            .ok_or_else(|| DedodeColmapBridgeError::InvalidInput("feature count overflow".into()))
    })?;
    if total_features > MAX_IMPORTED_FEATURES {
        return Err(DedodeColmapBridgeError::InvalidInput(format!(
            "DeDoDe import exceeds {MAX_IMPORTED_FEATURES} features"
        )));
    }

    let feature_directory = scratch.join("features/dedode/import");
    let database_path = scratch.join("features/dedode/database.db");
    let match_list_path = scratch.join("features/dedode/raw-matches.txt");
    fs::create_dir_all(&feature_directory)?;

    let mut feature_indices = BTreeMap::new();
    for (entity_id, image_name) in &image_names {
        check_cancelled(cancellation)?;
        let values = features
            .get(entity_id)
            .expect("feature map is initialized for every image");
        if values.is_empty() {
            return Err(DedodeColmapBridgeError::InvalidInput(format!(
                "camera {entity_id} has no DeDoDe feature"
            )));
        }
        let index = values
            .keys()
            .enumerate()
            .map(|(position, worker_id)| {
                (
                    *worker_id,
                    u32::try_from(position).expect("bounded feature count fits u32"),
                )
            })
            .collect::<BTreeMap<_, _>>();
        feature_indices.insert(entity_id.clone(), index);
        let path = feature_directory.join(append_txt_extension(image_name)?);
        let mut bytes = Vec::with_capacity(values.len().saturating_mul(450));
        writeln!(&mut bytes, "{} {COLMAP_DESCRIPTOR_COLUMNS}", values.len())?;
        for (feature_index, (worker_id, coordinate)) in values.iter().enumerate() {
            if feature_index % 1_024 == 0 {
                check_cancelled(cancellation)?;
            }
            write!(
                &mut bytes,
                "{:.6} {:.6} 1.000000 0.000000",
                coordinate.x, coordinate.y
            )?;
            for descriptor in sentinel_descriptor(entity_id, *worker_id) {
                write!(&mut bytes, " {descriptor}")?;
            }
            bytes.push(b'\n');
        }
        atomic_write(&path, &bytes)?;
    }

    let mut match_bytes = Vec::new();
    for pair in ordered_pairs {
        check_cancelled(cancellation)?;
        let name_a = image_names
            .get(&pair.pair.image_a)
            .expect("validated image A exists");
        let name_b = image_names
            .get(&pair.pair.image_b)
            .expect("validated image B exists");
        writeln!(
            &mut match_bytes,
            "{} {}",
            path_text(name_a)?,
            path_text(name_b)?
        )?;
        let indices_a = &feature_indices[&pair.pair.image_a];
        let indices_b = &feature_indices[&pair.pair.image_b];
        let mut matches = pair.matches.iter().collect::<Vec<_>>();
        matches.sort_by_key(|item| (item.feature_a, item.feature_b));
        for (match_index, item) in matches.into_iter().enumerate() {
            if match_index % 1_024 == 0 {
                check_cancelled(cancellation)?;
            }
            writeln!(
                &mut match_bytes,
                "{} {}",
                indices_a[&item.feature_a], indices_b[&item.feature_b]
            )?;
        }
        match_bytes.push(b'\n');
    }
    atomic_write(&match_list_path, &match_bytes)?;

    Ok(DedodeColmapImport {
        feature_directory,
        match_list_path,
        database_path,
        image_count: u32::try_from(cameras.len()).expect("camera count fits u32"),
        feature_count: u64::try_from(total_features).expect("feature count fits u64"),
        pair_count: u32::try_from(outcome.pairs.len()).expect("pair count fits u32"),
        match_count: total_matches,
    })
}

fn insert_feature(
    features: &mut BTreeMap<u32, FeatureCoordinate>,
    id: u32,
    x: f32,
    y: f32,
) -> Result<(), DedodeColmapBridgeError> {
    match features.get(&id) {
        Some(existing)
            if (existing.x - x).abs() > COORDINATE_TOLERANCE_PIXELS
                || (existing.y - y).abs() > COORDINATE_TOLERANCE_PIXELS =>
        {
            Err(DedodeColmapBridgeError::InvalidInput(format!(
                "DeDoDe feature {id} has inconsistent coordinates across pairs"
            )))
        }
        Some(_) => Ok(()),
        None => {
            features.insert(id, FeatureCoordinate { x, y });
            Ok(())
        }
    }
}

fn validate_match(item: &DedodeMatch) -> Result<(), DedodeColmapBridgeError> {
    if [item.x_a, item.y_a, item.x_b, item.y_b, item.confidence]
        .into_iter()
        .all(f32::is_finite)
        && (0.0..=1.0).contains(&item.confidence)
    {
        Ok(())
    } else {
        Err(DedodeColmapBridgeError::InvalidInput(
            "non-finite coordinate or confidence outside [0, 1]".into(),
        ))
    }
}

fn sentinel_descriptor(entity_id: &str, feature_id: u32) -> [u8; COLMAP_DESCRIPTOR_COLUMNS] {
    let mut result = [0_u8; COLMAP_DESCRIPTOR_COLUMNS];
    for block in 0..4_u8 {
        let mut hash = Sha256::new();
        hash.update(b"himmelcad-dedode-colmap-sentinel-v1\0");
        hash.update(entity_id.as_bytes());
        hash.update(feature_id.to_le_bytes());
        hash.update([block]);
        let digest = hash.finalize();
        let start = usize::from(block) * digest.len();
        result[start..start + digest.len()].copy_from_slice(&digest);
    }
    result
}

fn validate_relative_image_name(path: &Path) -> Result<(), DedodeColmapBridgeError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        Err(DedodeColmapBridgeError::InvalidInput(format!(
            "unsafe materialized image name {}",
            path.display()
        )))
    } else {
        Ok(())
    }
}

fn append_txt_extension(path: &Path) -> Result<PathBuf, DedodeColmapBridgeError> {
    let text = path_text(path)?;
    Ok(PathBuf::from(format!("{text}.txt")))
}

fn path_text(path: &Path) -> Result<&str, DedodeColmapBridgeError> {
    path.to_str().ok_or_else(|| {
        DedodeColmapBridgeError::InvalidInput(format!(
            "COLMAP text import requires UTF-8 image names: {}",
            path.display()
        ))
    })
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), DedodeColmapBridgeError> {
    if cancellation.is_cancel_requested() {
        Err(DedodeColmapBridgeError::Cancelled)
    } else {
        Ok(())
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), io::Error> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "output has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("himmelcad-partial");
    fs::write(&temporary, bytes)?;
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dedode_runtime::{
            DedodeImagePair, DedodePairMatches, DedodeToolIdentity, DedodeWorkerResult,
        },
        image_commit::{CameraImageMetadataRecord, ProjectCameraImageRecord},
    };
    use himmelcad_core::{
        entity::EntityId,
        hash::ObjectHash,
        photolab_images::{DiscoveredPhoto, PhotoFormat, PhotoMetadata},
    };

    fn camera(id: &str) -> ProjectCameraImageRecord {
        ProjectCameraImageRecord {
            entity_id: EntityId(id.into()),
            name: format!("{id}.jpg"),
            metadata_object_hash: ObjectHash::of_bytes(id.as_bytes()),
            metadata: CameraImageMetadataRecord {
                schema_version: 1,
                source_object_hash: ObjectHash::of_bytes(id.as_bytes()),
                transformation_object_hash: ObjectHash::of_bytes(b"transform"),
                inspected_photo: DiscoveredPhoto {
                    source_path: format!("/{id}.jpg"),
                    format: PhotoFormat::Jpeg,
                    byte_size: 1,
                    sha256: ObjectHash::of_bytes(id.as_bytes()),
                    metadata: PhotoMetadata::default(),
                    capture_source: Default::default(),
                    decoder_capability: None,
                    position_prior: None,
                    derived_provenance: None,
                    duplicate_of: None,
                },
                projected_reference: None,
                status_tags: BTreeSet::new(),
            },
        }
    }

    fn outcome(pairs: Vec<DedodePairMatches>) -> DedodeRunOutcome {
        DedodeRunOutcome {
            tool: DedodeToolIdentity {
                tool_id: "dedode".into(),
                version: "test".into(),
                manifest_sha256: ObjectHash::of_bytes(b"dedode-manifest"),
            },
            scratch_path: "/scratch".into(),
            result_path: "/scratch/result.json".into(),
            result_sha256: ObjectHash::of_bytes(b"result"),
            matches_path: "/scratch/matches.bin".into(),
            matches_sha256: ObjectHash::of_bytes(b"matches"),
            matches_bytes: 10,
            worker_result: DedodeWorkerResult {
                schema_version: 1,
                job_id: "job".into(),
                backend: "dedode-v2-g".into(),
                numeric_mode: "fp32".into(),
                image_count: 3,
                pair_count: u32::try_from(pairs.len()).expect("pair count"),
                matches_path: "matches.bin".into(),
                checkpoint_path: "checkpoint.json".into(),
            },
            pairs,
        }
    }

    fn pair(a: &str, b: &str, matches: Vec<DedodeMatch>) -> DedodePairMatches {
        DedodePairMatches {
            pair: DedodeImagePair {
                image_a: a.into(),
                image_b: b.into(),
            },
            matches,
        }
    }

    fn tiled_feature(x: f32, y: f32, score: f32, descriptor: u8) -> TiledAlikedFeature {
        TiledAlikedFeature {
            x,
            y,
            a11: 1.0,
            a12: 0.0,
            a21: 0.0,
            a22: 1.0,
            score,
            descriptor: [f32::from(descriptor); COLMAP_DESCRIPTOR_COLUMNS],
        }
    }

    fn synthetic_two_by_two_tiles() -> Vec<TiledAlikedFeatureSet> {
        vec![
            TiledAlikedFeatureSet {
                tile_index: 0,
                origin_x: 0,
                origin_y: 0,
                features: vec![
                    tiled_feature(100.0, 50.0, 0.4, 1),
                    tiled_feature(10.0, 10.0, 0.7, 2),
                ],
            },
            TiledAlikedFeatureSet {
                tile_index: 1,
                origin_x: 100,
                origin_y: 0,
                features: vec![
                    tiled_feature(0.0, 50.0, 0.9, 3),
                    tiled_feature(20.0, 20.0, 0.6, 4),
                ],
            },
            TiledAlikedFeatureSet {
                tile_index: 2,
                origin_x: 0,
                origin_y: 100,
                features: vec![tiled_feature(20.0, 20.0, 0.5, 5)],
            },
            TiledAlikedFeatureSet {
                tile_index: 3,
                origin_x: 100,
                origin_y: 100,
                features: vec![tiled_feature(5.0, 7.0, 0.8, 6)],
            },
        ]
    }

    #[test]
    fn tiled_feature_merge_shifts_coordinates_and_keeps_higher_overlap_score() {
        let merged = merge_tiled_aliked_features(&synthetic_two_by_two_tiles(), 20)
            .expect("merge tiled features");

        assert!(merged
            .iter()
            .any(|feature| feature.x == 105.0 && feature.y == 107.0));
        let overlap = merged
            .iter()
            .filter(|feature| feature.x == 100.0 && feature.y == 50.0)
            .collect::<Vec<_>>();
        assert_eq!(overlap.len(), 1);
        assert_eq!(overlap[0].score, 0.9);
        assert_eq!(overlap[0].descriptor[0], 3.0);
    }

    #[test]
    fn tiled_feature_merge_applies_global_top_k_after_deduplication() {
        let merged = merge_tiled_aliked_features(&synthetic_two_by_two_tiles(), 3)
            .expect("merge tiled features");

        assert_eq!(merged.len(), 3);
        assert_eq!(
            merged
                .iter()
                .map(|feature| feature.score)
                .collect::<Vec<_>>(),
            vec![0.9, 0.8, 0.7]
        );
    }

    #[test]
    fn tiled_feature_merge_is_deterministic_across_input_order() {
        let tiles = synthetic_two_by_two_tiles();
        let expected = merge_tiled_aliked_features(&tiles, 20).expect("first merge");
        let mut reversed = tiles;
        reversed.reverse();
        for tile in &mut reversed {
            tile.features.reverse();
        }

        assert_eq!(
            merge_tiled_aliked_features(&reversed, 20).expect("reordered merge"),
            expected
        );
    }

    #[test]
    fn aggregates_features_and_emits_stable_public_colmap_text() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-dedode-bridge-{}-{}",
            std::process::id(),
            ObjectHash::of_bytes(b"stable").as_str()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create root");
        let cameras = vec![camera("a"), camera("b"), camera("c")];
        let names = vec!["000/a.jpg".into(), "001/b.jpg".into(), "002/c.jpg".into()];
        let result = outcome(vec![
            pair(
                "b",
                "c",
                vec![DedodeMatch {
                    feature_a: 9,
                    feature_b: 4,
                    x_a: 30.0,
                    y_a: 40.0,
                    x_b: 50.0,
                    y_b: 60.0,
                    confidence: 0.8,
                }],
            ),
            pair(
                "a",
                "b",
                vec![DedodeMatch {
                    feature_a: 7,
                    feature_b: 9,
                    x_a: 10.0,
                    y_a: 20.0,
                    x_b: 30.0,
                    y_b: 40.0,
                    confidence: 0.9,
                }],
            ),
        ]);
        let import = prepare_dedode_colmap_import(
            &result,
            &cameras,
            &names,
            &root,
            &CancellationToken::new(),
        )
        .expect("prepare import");
        assert_eq!(import.feature_count, 3);
        assert_eq!(import.match_count, 2);
        assert!(root.join("features/dedode/import/000/a.jpg.txt").is_file());
        let matches = fs::read_to_string(import.match_list_path).expect("read matches");
        assert_eq!(
            matches,
            "000/a.jpg 001/b.jpg\n0 0\n\n001/b.jpg 002/c.jpg\n0 0\n\n"
        );
        let feature = fs::read_to_string(root.join("features/dedode/import/001/b.jpg.txt"))
            .expect("read feature file");
        assert!(feature.starts_with("1 128\n30.000000 40.000000 1.000000 0.000000 "));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_inconsistent_cross_pair_feature_coordinates() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-dedode-bridge-reject-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create root");
        let cameras = vec![camera("a"), camera("b"), camera("c")];
        let names = vec!["a.jpg".into(), "b.jpg".into(), "c.jpg".into()];
        let result = outcome(vec![
            pair(
                "a",
                "b",
                vec![DedodeMatch {
                    feature_a: 1,
                    feature_b: 2,
                    x_a: 1.0,
                    y_a: 2.0,
                    x_b: 3.0,
                    y_b: 4.0,
                    confidence: 1.0,
                }],
            ),
            pair(
                "a",
                "c",
                vec![DedodeMatch {
                    feature_a: 1,
                    feature_b: 3,
                    x_a: 2.0,
                    y_a: 2.0,
                    x_b: 5.0,
                    y_b: 6.0,
                    confidence: 1.0,
                }],
            ),
        ]);
        let error = prepare_dedode_colmap_import(
            &result,
            &cameras,
            &names,
            &root,
            &CancellationToken::new(),
        )
        .expect_err("inconsistent feature must fail");
        assert!(error.to_string().contains("inconsistent coordinates"));
        let _ = fs::remove_dir_all(root);
    }
}
