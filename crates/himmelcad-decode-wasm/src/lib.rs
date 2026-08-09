//! CPU-only WASM boundary for transferable mixed-provider streaming decode.

#![forbid(unsafe_code)]

use himmelcad_render::{
    decode_artifact_input_hash, decode_encoded_elevation_raster,
    decode_gaussian_splat_interleaved_v1, decode_gaussian_splat_ply,
    decode_three_d_tiles_content_intrinsic_with_resources, encode_decode_artifact,
    AssetBundleLimits, BoundingVolume, DecodedStreamingPayload, EncodedElevationRasterInput,
    PotreePointLayout, PreparedRasterTileContract, ResolvedAssetEntry, SharedAssetBlobCache,
    ThreeDTilesContentKind, WorldTransform, MAX_WORKER_INPUT_BYTES,
};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Current linear-memory commitment of this decoder instance.
#[wasm_bindgen]
pub fn decode_worker_linear_memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0).saturating_mul(65_536)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreeDTilesMetadata {
    content_uri: String,
    content_kind: ThreeDTilesContentKind,
    #[serde(default)]
    content_transform: Option<WorldTransform>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PotreeMetadata {
    bounds: BoundingVolume,
    point_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GaussianMetadata {
    maximum_splats: usize,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GaussianDecodeParameters {
    #[serde(default)]
    encoding: Option<String>,
    #[serde(default)]
    origin: Option<[f64; 3]>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterMetadata {
    bounds: BoundingVolume,
    contract: PreparedRasterTileContract,
    elevation_payload_byte_length: usize,
    validity_payload_byte_length: usize,
    confidence_payload_byte_length: usize,
    triangle_mask_payload_byte_length: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    schema_version: u32,
    entries: Vec<ResolvedAssetEntry>,
}

/// Decodes one bounded CPU payload. The module contains no viewer or GPU host.
#[wasm_bindgen]
pub fn decode_streaming_payload(
    kind: &str,
    metadata_json: &str,
    primary: &[u8],
    bundle_manifest_json: &str,
    bundle: &[u8],
    secondary: &[u8],
    decode_parameters_json: &str,
) -> Result<Vec<u8>, JsValue> {
    let aggregate = aggregate_worker_input_bytes([
        primary.len(),
        bundle.len(),
        secondary.len(),
        kind.len(),
        metadata_json.len(),
        bundle_manifest_json.len(),
        decode_parameters_json.len(),
    ])
    .ok_or_else(|| error("worker decode input byte length overflow"))?;
    if aggregate == 0 || aggregate > MAX_WORKER_INPUT_BYTES {
        return Err(error(
            "worker decode input must contain 1 through 33554432 aggregate bytes",
        ));
    }
    let input_hash = decode_artifact_input_hash(
        kind,
        metadata_json,
        primary,
        bundle_manifest_json,
        bundle,
        secondary,
        decode_parameters_json,
    );
    let payload = match kind {
        "gltf" | "threeDTilesContainer" => {
            let metadata: ThreeDTilesMetadata = parse(metadata_json)?;
            let manifest: BundleManifest = parse(bundle_manifest_json)?;
            if manifest.schema_version != 1 {
                return Err(error("resolved bundle schemaVersion must be 1"));
            }
            let cache = SharedAssetBlobCache::new();
            let resources = cache
                .prepare_packed(manifest.entries, bundle.to_vec(), limits())
                .map_err(js_error)?;
            DecodedStreamingPayload::ThreeDTiles(
                decode_three_d_tiles_content_intrinsic_with_resources(
                    &metadata.content_uri,
                    metadata.content_kind,
                    primary,
                    resources.bundle(),
                    metadata
                        .content_transform
                        .unwrap_or(WorldTransform::IDENTITY),
                )
                .map_err(js_error)?,
            )
        }
        "potreePoints" => {
            let metadata: PotreeMetadata = parse(metadata_json)?;
            let layout: PotreePointLayout = parse(decode_parameters_json)?;
            let anchor = metadata
                .bounds
                .stable_anchor()
                .ok_or_else(|| error("Potree bounds have no stable anchor"))?;
            DecodedStreamingPayload::Potree(
                layout
                    .decode_node(primary, metadata.point_count, anchor)
                    .map_err(js_error)?,
            )
        }
        "gaussianSplats" => {
            let metadata: GaussianMetadata = parse(metadata_json)?;
            let parameters = if decode_parameters_json.is_empty() {
                GaussianDecodeParameters::default()
            } else {
                parse(decode_parameters_json)?
            };
            let decoded = if parameters.encoding.as_deref() == Some("hcsplatInterleavedV1") {
                let [x, y, z] = parameters
                    .origin
                    .ok_or_else(|| error("HCSP v1 decode requires a tile origin"))?;
                decode_gaussian_splat_interleaved_v1(
                    primary,
                    metadata.maximum_splats,
                    himmelcad_render::WorldVec3 { x, y, z },
                )
                .map_err(js_error)?
            } else {
                decode_gaussian_splat_ply(primary, metadata.maximum_splats).map_err(js_error)?
            };
            DecodedStreamingPayload::GaussianSplats(decoded)
        }
        "raster" => {
            let metadata: RasterMetadata = parse(metadata_json)?;
            let (mapping, topology) = metadata
                .contract
                .elevation_grid_decode_semantics()
                .map_err(js_error)?;
            let (color_width, color_height, elevation_width, elevation_height) =
                metadata.contract.decode_dimensions().map_err(js_error)?;
            let (elevations, validity_mask, confidence, triangle_mask) = split_raster_bands(
                secondary,
                metadata.elevation_payload_byte_length,
                metadata.validity_payload_byte_length,
                metadata.confidence_payload_byte_length,
                metadata.triangle_mask_payload_byte_length,
            )
            .map_err(error)?;
            metadata
                .contract
                .validate_payloads(
                    primary,
                    elevations,
                    validity_mask,
                    confidence,
                    triangle_mask,
                )
                .map_err(js_error)?;
            let anchor = metadata
                .bounds
                .stable_anchor()
                .ok_or_else(|| error("raster bounds have no stable anchor"))?;
            DecodedStreamingPayload::Raster(
                decode_encoded_elevation_raster(
                    EncodedElevationRasterInput {
                        width: elevation_width,
                        height: elevation_height,
                        color_width,
                        color_height,
                        color: primary,
                        elevations,
                        validity_mask,
                        triangle_mask,
                        color_encoding: metadata.contract.color_encoding,
                        elevation_encoding: metadata.contract.depth_encoding,
                        no_data: metadata.contract.no_data,
                        mapping,
                        topology,
                    },
                    anchor,
                )
                .map_err(js_error)?,
            )
        }
        _ => return Err(error("streaming worker decoder kind is unknown")),
    };
    encode_decode_artifact(input_hash, payload).map_err(js_error)
}

type RasterBandSlices<'a> = (
    &'a [u8],
    Option<&'a [u8]>,
    Option<&'a [u8]>,
    Option<&'a [u8]>,
);

fn split_raster_bands(
    packed: &[u8],
    elevation_length: usize,
    validity_length: usize,
    confidence_length: usize,
    triangle_mask_length: usize,
) -> Result<RasterBandSlices<'_>, &'static str> {
    let validity_end = elevation_length
        .checked_add(validity_length)
        .ok_or("raster side-band byte length overflow")?;
    let confidence_end = validity_end
        .checked_add(confidence_length)
        .ok_or("raster side-band byte length overflow")?;
    let total = confidence_end
        .checked_add(triangle_mask_length)
        .ok_or("raster side-band byte length overflow")?;
    if total != packed.len() {
        return Err("raster side-band byte lengths do not match payload");
    }
    let elevations = &packed[..elevation_length];
    let validity = (validity_length != 0).then_some(&packed[elevation_length..validity_end]);
    let confidence = (confidence_length != 0).then_some(&packed[validity_end..confidence_end]);
    let triangle_mask = (triangle_mask_length != 0).then_some(&packed[confidence_end..total]);
    Ok((elevations, validity, confidence, triangle_mask))
}

fn aggregate_worker_input_bytes(lengths: [usize; 7]) -> Option<usize> {
    lengths.into_iter().try_fold(0_usize, usize::checked_add)
}

fn parse<'a, T: Deserialize<'a>>(json: &'a str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(js_error)
}

fn limits() -> AssetBundleLimits {
    AssetBundleLimits {
        max_entries: 4_096,
        max_unique_assets: 4_096,
        // A single asset is part of the aggregate transferable worker blob;
        // its ceiling can never exceed that blob's hard input ceiling.
        max_asset_bytes: (64 * 1024 * 1024).min(MAX_WORKER_INPUT_BYTES),
        max_blob_bytes: MAX_WORKER_INPUT_BYTES,
        max_uri_bytes: 16 * 1024,
        max_document_bytes: MAX_WORKER_INPUT_BYTES,
        max_dependencies: 4_096,
        max_composite_depth: 8,
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_asset_limits_fit_the_aggregate_input_ceiling() {
        let limits = limits();
        assert!(limits.max_asset_bytes <= limits.max_blob_bytes);
        assert_eq!(limits.max_blob_bytes, MAX_WORKER_INPUT_BYTES);
        SharedAssetBlobCache::new()
            .prepare_packed(Vec::new(), Vec::new(), limits)
            .expect("worker asset limits must be internally valid");
    }

    #[test]
    fn worker_input_ceiling_includes_all_json_and_kind_bytes() {
        assert_eq!(
            aggregate_worker_input_bytes([1, 2, 3, 4, 5, 6, 7]),
            Some(28)
        );
        assert!(
            aggregate_worker_input_bytes([1, 0, 0, 0, MAX_WORKER_INPUT_BYTES, 0, 0,])
                .is_some_and(|bytes| bytes > MAX_WORKER_INPUT_BYTES)
        );
        assert!(aggregate_worker_input_bytes([usize::MAX, 1, 0, 0, 0, 0, 0]).is_none());
    }

    #[test]
    fn raster_side_bands_are_split_without_copying_or_ambiguity() {
        let packed = [1_u8, 2, 3, 4, 5, 6, 7, 8, 9];
        let (elevation, validity, confidence, triangles) =
            split_raster_bands(&packed, 4, 1, 2, 2).expect("exact bands");
        assert_eq!(elevation, [1, 2, 3, 4]);
        assert_eq!(validity, Some([5].as_slice()));
        assert_eq!(confidence, Some([6, 7].as_slice()));
        assert_eq!(triangles, Some([8, 9].as_slice()));
        assert!(split_raster_bands(&packed, 4, 1, 2, 1).is_err());
    }

    #[test]
    fn small_gltf_decodes_through_the_worker_boundary() {
        let document = br#"{
            "asset":{"version":"2.0"},
            "buffers":[{"byteLength":44,"uri":"data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAAAAABAAIAAAA="}],
            "bufferViews":[
                {"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":6}
            ],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}
            ],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1,"mode":4}]}],
            "nodes":[{"mesh":0}],"scene":0,"scenes":[{"nodes":[0]}]
        }"#;
        let resources = SharedAssetBlobCache::new()
            .prepare_packed(Vec::new(), Vec::new(), limits())
            .expect("worker limits must admit an empty resolved bundle");
        let decoded = decode_three_d_tiles_content_intrinsic_with_resources(
            "memory:///empty.gltf",
            ThreeDTilesContentKind::Gltf,
            document,
            resources.bundle(),
            WorldTransform::IDENTITY,
        )
        .expect("small glTF worker decode must succeed");
        let artifact =
            encode_decode_artifact([9; 32], DecodedStreamingPayload::ThreeDTiles(decoded))
                .expect("worker artifact encoding must succeed");
        assert!(artifact.starts_with(b"HCDECODE"));
    }
}
