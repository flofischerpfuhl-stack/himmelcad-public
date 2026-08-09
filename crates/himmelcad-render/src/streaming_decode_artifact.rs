//! Bounded, versioned CPU decode artifacts transferred between worker and viewer WASM.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::streaming_decode_artifact_wire::WireDecodedStreamingPayload;
use crate::{
    DecodedElevationRaster, DecodedGaussianSplats, DecodedPotreePoints, DecodedThreeDTilesContent,
};

const MAGIC: &[u8; 8] = b"HCDECODE";
const INPUT_MANIFEST_DOMAIN: &[u8] = b"HCDECODE-INPUT-MANIFEST\0";
const INPUT_MANIFEST_SCHEMA_VERSION: u16 = 1;
/// Current worker artifact wire version. Older layouts are intentionally rejected.
pub const DECODE_ARTIFACT_VERSION: u16 = 5;
/// Magic, version, body length and exact input-manifest SHA-256.
pub const DECODE_ARTIFACT_HEADER_BYTES: usize = 8 + 2 + 8 + 32;
/// Hard allocation ceiling for one worker result and one viewer ingest.
pub const MAX_DECODE_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
/// Hard aggregate encoded-input ceiling until provider chunking is available.
pub const MAX_WORKER_INPUT_BYTES: usize = 32 * 1024 * 1024;

/// Provider-neutral CPU result. It deliberately contains no GPU handles.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[allow(
    clippy::large_enum_variant,
    reason = "public cross-crate artifact API and versioned wire representation must remain stable"
)]
pub enum DecodedStreamingPayload {
    /// glTF or legacy 3D Tiles content.
    ThreeDTiles(DecodedThreeDTilesContent),
    /// Potree node point arrays.
    Potree(DecodedPotreePoints),
    /// Gaussian splat arrays.
    GaussianSplats(DecodedGaussianSplats),
    /// Decoded color/elevation mesh.
    Raster(DecodedElevationRaster),
}

/// Computes the versioned hierarchical manifest bound into every worker artifact.
///
/// Each named component contributes its exact byte length and SHA-256. The
/// small canonical manifest is then hashed once, avoiding any aggregate input
/// copy while keeping field order and meaning unambiguous across Rust and JS.
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn decode_artifact_input_hash(
    kind: &str,
    metadata_json: &str,
    primary: &[u8],
    bundle_manifest_json: &str,
    bundle: &[u8],
    secondary: &[u8],
    decode_parameters_json: &str,
) -> [u8; 32] {
    let components: [(&str, &[u8]); 7] = [
        ("kind", kind.as_bytes()),
        ("metadataJson", metadata_json.as_bytes()),
        ("primary", primary),
        ("bundleManifestJson", bundle_manifest_json.as_bytes()),
        ("bundle", bundle),
        ("secondary", secondary),
        ("decodeParametersJson", decode_parameters_json.as_bytes()),
    ];
    let mut manifest = Sha256::new();
    manifest.update(INPUT_MANIFEST_DOMAIN);
    manifest.update(INPUT_MANIFEST_SCHEMA_VERSION.to_le_bytes());
    manifest.update(
        u16::try_from(components.len())
            .expect("fixed component count fits u16")
            .to_le_bytes(),
    );
    for (name, bytes) in components {
        manifest.update(
            u16::try_from(name.len())
                .expect("fixed component name fits u16")
                .to_le_bytes(),
        );
        manifest.update(name.as_bytes());
        manifest.update(
            u64::try_from(bytes.len())
                .expect("usize always fits u64")
                .to_le_bytes(),
        );
        manifest.update(Sha256::digest(bytes));
    }
    manifest.finalize().into()
}

/// Encodes a hostile-input-bounded artifact with explicit framing.
pub fn encode_decode_artifact(
    input_hash: [u8; 32],
    payload: DecodedStreamingPayload,
) -> Result<Vec<u8>, String> {
    let wire = WireDecodedStreamingPayload::try_from(payload)?;
    let mut artifact = Vec::with_capacity(1024 * 1024);
    artifact.extend_from_slice(MAGIC);
    artifact.extend_from_slice(&DECODE_ARTIFACT_VERSION.to_le_bytes());
    artifact.extend_from_slice(&0_u64.to_le_bytes());
    artifact.extend_from_slice(&input_hash);
    let config = bincode::config::standard()
        .with_fixed_int_encoding()
        .with_limit::<67_108_864>();
    bincode::serde::encode_into_std_write(&wire, &mut artifact, config)
        .map_err(|error| error.to_string())?;
    let body_len = u64::try_from(artifact.len().saturating_sub(DECODE_ARTIFACT_HEADER_BYTES))
        .map_err(|_| "decode artifact is too large")?;
    if body_len > MAX_DECODE_ARTIFACT_BYTES {
        return Err("decode artifact exceeds 67108864 bytes".to_owned());
    }
    artifact[10..18].copy_from_slice(&body_len.to_le_bytes());
    Ok(artifact)
}

/// Validates v5 framing, exact input identity and bounded binary/JSON wire data.
pub fn decode_artifact(
    bytes: &[u8],
    expected_input_hash: [u8; 32],
) -> Result<DecodedStreamingPayload, String> {
    let header = bytes
        .get(..DECODE_ARTIFACT_HEADER_BYTES)
        .ok_or_else(|| "decode artifact header is truncated".to_owned())?;
    if &header[..8] != MAGIC {
        return Err("decode artifact magic is invalid".to_owned());
    }
    let version = u16::from_le_bytes(header[8..10].try_into().map_err(|_| "bad version")?);
    if version != DECODE_ARTIFACT_VERSION {
        return Err("decode artifact version is unsupported".to_owned());
    }
    let declared_len = u64::from_le_bytes(header[10..18].try_into().map_err(|_| "bad length")?);
    if declared_len > MAX_DECODE_ARTIFACT_BYTES
        || usize::try_from(declared_len).ok()
            != Some(bytes.len().saturating_sub(DECODE_ARTIFACT_HEADER_BYTES))
    {
        return Err("decode artifact length is invalid".to_owned());
    }
    let artifact_input_hash: [u8; 32] = header[18..DECODE_ARTIFACT_HEADER_BYTES]
        .try_into()
        .map_err(|_| "decode artifact input hash is truncated")?;
    if artifact_input_hash != expected_input_hash {
        return Err("decode artifact input manifest hash mismatch".to_owned());
    }
    let config = bincode::config::standard()
        .with_fixed_int_encoding()
        .with_limit::<67_108_864>();
    let (wire, consumed): (WireDecodedStreamingPayload, usize) =
        bincode::serde::decode_from_slice(&bytes[DECODE_ARTIFACT_HEADER_BYTES..], config)
            .map_err(|error| error.to_string())?;
    if consumed != bytes.len().saturating_sub(DECODE_ARTIFACT_HEADER_BYTES) {
        return Err("decode artifact has trailing bytes".to_owned());
    }
    wire.try_into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_wrong_version_oversized_and_trailing_artifacts() {
        let hash = [7; 32];
        assert!(decode_artifact(b"short", hash).is_err());
        let mut header = Vec::from(*MAGIC);
        header.extend_from_slice(&(DECODE_ARTIFACT_VERSION + 1).to_le_bytes());
        header.extend_from_slice(&0_u64.to_le_bytes());
        header.extend_from_slice(&hash);
        assert!(decode_artifact(&header, hash).is_err());
        header[8..10].copy_from_slice(&DECODE_ARTIFACT_VERSION.to_le_bytes());
        header[10..18].copy_from_slice(&(MAX_DECODE_ARTIFACT_BYTES + 1).to_le_bytes());
        assert!(decode_artifact(&header, hash).is_err());
    }

    #[test]
    fn input_manifest_is_named_length_framed_and_ordered() {
        let first = decode_artifact_input_hash(
            "gltf",
            "{}",
            b"primary",
            "{}",
            b"bundle",
            b"secondary",
            "{}",
        );
        let same = decode_artifact_input_hash(
            "gltf",
            "{}",
            b"primary",
            "{}",
            b"bundle",
            b"secondary",
            "{}",
        );
        assert_eq!(first, same);
        assert_ne!(
            first,
            decode_artifact_input_hash(
                "gltf",
                "{}",
                b"primarybundle",
                "{}",
                b"",
                b"secondary",
                "{}",
            )
        );
        assert_ne!(
            first,
            decode_artifact_input_hash(
                "threeDTilesContainer",
                "{}",
                b"primary",
                "{}",
                b"bundle",
                b"secondary",
                "{}",
            )
        );
    }

    #[test]
    fn rust_typescript_manifest_vector_is_stable() {
        assert_eq!(
            decode_artifact_input_hash(
                "gltf",
                r#"{"slot":"primary","revision":7}"#,
                &[0, 1, 2, 255],
                r#"{"schemaVersion":1,"entries":[]}"#,
                &[9, 8, 7],
                &[],
                r#"{"layout":"fixed"}"#,
            ),
            [
                0x13, 0xa4, 0xab, 0x80, 0xa1, 0xd4, 0x5e, 0x3d, 0x7e, 0x33, 0x8f, 0x7f, 0xb3, 0xfe,
                0x4e, 0x53, 0x0f, 0x1f, 0x21, 0xad, 0xed, 0x30, 0xd2, 0x08, 0x1b, 0x64, 0x57, 0x96,
                0xc1, 0xf6, 0xda, 0x1a,
            ]
        );
    }

    #[test]
    fn v5_round_trips_gltf_and_pnts_metadata_values_and_rejects_tamper() {
        use std::collections::BTreeMap;

        use crate::{
            DecodedBatchedModel, DecodedGlb, DecodedPointTile, DecodedPotreePoints,
            DecodedStructuralMetadata, DecodedThreeDTilesContent, WorldVec3,
        };

        let mesh_metadata = serde_json::json!({
            "district": "central",
            "nested": { "exact": [1, true, null] }
        });
        let point_metadata = serde_json::json!({
            "classification": [2, 5],
            "temperature": 18.25
        });
        let payload =
            DecodedStreamingPayload::ThreeDTiles(DecodedThreeDTilesContent::Composite(vec![
                DecodedThreeDTilesContent::Mesh(DecodedBatchedModel {
                    glb: DecodedGlb {
                        world_origin: WorldVec3 {
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        primitives: Vec::new(),
                        images: Vec::new(),
                        feature_images: BTreeMap::new(),
                        structural_metadata: Some(DecodedStructuralMetadata {
                            schema: Some(serde_json::json!({ "classes": { "building": {} } })),
                            schema_uri: None,
                            property_tables: vec![serde_json::json!({
                                "class": "building",
                                "count": 1
                            })],
                            property_textures: vec![serde_json::json!({ "class": "surface" })],
                            property_attributes: vec![serde_json::json!({ "class": "vertex" })],
                            property_table_buffer_views: BTreeMap::new(),
                        }),
                    },
                    batch_length: 1,
                    feature_id: None,
                    batch_table_json: Some(mesh_metadata),
                    batch_table_binary: vec![1, 2, 3],
                    batch_table_hierarchy: None,
                }),
                DecodedThreeDTilesContent::Points(DecodedPointTile {
                    points: DecodedPotreePoints {
                        world_origin: WorldVec3 {
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        positions: vec![[1.0, 2.0, 3.0]],
                        colors: vec![[4, 5, 6, 255]],
                        civil_attributes: None,
                    },
                    batch_ids: Some(vec![0]),
                    batch_length: 1,
                    batch_table_json: Some(point_metadata),
                    batch_table_binary: Vec::new(),
                    batch_table_hierarchy: None,
                }),
            ]));
        let input_hash = [0x5a; 32];
        let artifact = encode_decode_artifact(input_hash, payload).expect("encode v4 artifact");
        let decoded = decode_artifact(&artifact, input_hash).expect("decode v4 artifact");
        let DecodedStreamingPayload::ThreeDTiles(DecodedThreeDTilesContent::Composite(children)) =
            decoded
        else {
            panic!("expected composite metadata payload");
        };
        let DecodedThreeDTilesContent::Mesh(mesh) = &children[0] else {
            panic!("expected glTF child");
        };
        assert_eq!(
            mesh.batch_table_json.as_ref().unwrap()["district"],
            "central"
        );
        assert_eq!(
            mesh.glb
                .structural_metadata
                .as_ref()
                .unwrap()
                .property_tables[0]["count"],
            1
        );
        let DecodedThreeDTilesContent::Points(points) = &children[1] else {
            panic!("expected PNTS child");
        };
        assert_eq!(
            points.batch_table_json.as_ref().unwrap()["temperature"],
            18.25
        );
        assert!(decode_artifact(&artifact, [0x5b; 32])
            .unwrap_err()
            .contains("manifest hash mismatch"));
        let mut trailing = artifact.clone();
        trailing.push(0);
        assert!(decode_artifact(&trailing, input_hash)
            .unwrap_err()
            .contains("length is invalid"));
        let mut v1 = artifact;
        v1[8..10].copy_from_slice(&1_u16.to_le_bytes());
        assert!(decode_artifact(&v1, input_hash)
            .unwrap_err()
            .contains("version is unsupported"));
    }

    #[test]
    fn v5_round_trips_potree_civil_attributes_exactly() {
        use crate::{PackedCivilPointAttributes, WorldVec3};

        let civil = PackedCivilPointAttributes::new(
            Some(65_535),
            Some(6),
            Some(2),
            Some(513),
            Some(4),
            true,
        );
        let payload = DecodedStreamingPayload::Potree(DecodedPotreePoints {
            world_origin: WorldVec3 {
                x: 500_000.0,
                y: 5_400_000.0,
                z: 100.0,
            },
            positions: vec![[0.125, -0.25, 0.5]],
            colors: vec![[10, 20, 30, 255]],
            civil_attributes: Some(vec![civil]),
        });
        let hash = [0xa5; 32];
        let artifact = encode_decode_artifact(hash, payload).expect("encode v4 civil artifact");
        let DecodedStreamingPayload::Potree(decoded) =
            decode_artifact(&artifact, hash).expect("decode v4 civil artifact")
        else {
            panic!("expected Potree payload");
        };
        assert_eq!(decoded.civil_attributes, Some(vec![civil]));
    }
}
