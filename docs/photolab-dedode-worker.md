# PhotoLab DeDoDe-v2-G worker contract

The Rust API is `himmelcad_sidecar::dedode_runtime`. A run receives verified
project camera records and an explicit candidate-pair list. It never receives a
free-form command line, database path or network URL. Images are hash-verified
and materialized through the same project-object helper as COLMAP.

## Trust and offline boundary

- A release calls `DedodeRuntime::preflight` with the expected manifest digest,
  detached signature and trusted key ID.
- The signed inventory names an exact CPython, ONNX Runtime, no-BLAS NumPy and
  Pillow version and inventories every regular file by relative path, byte
  length, SHA-256, source and SPDX license.
- The approved models are Detector-L-v2 (`4113809d…bdc17`, 58,483,585 bytes),
  Descriptor-G (`ef6e3f29…fee41`, 75,485,969 bytes) and DINOv2 ViT-L/14
  (`d5383ea8…bf428`, 1,217,586,395 bytes). Full hashes live in
  `dedode_runtime.rs` and `scripts/fetch-photolab-dedode.py`.
- Preflight rejects unlisted files, symlinks, special files, forbidden licenses,
  a model substitution, a runtime version mismatch or any hash/size mismatch.
- The process has an empty inherited environment, isolated home/temp/cache,
  offline flags and no runtime package/download operation.
  The local fetch script is a developer/build action and produces an explicitly
  untrusted runtime until release packaging signs a complete inventory.
- Stock PyTorch wheels are conversion/dev-only because their native closure can
  include `libgomp`. A release executes exact FP32 ONNX exports at 784 and 1176
  pixels. ONNX Runtime supplies the matrix kernels; NumPy is built with
  BLAS/LAPACK disabled, excluding libgfortran and libquadmath.

## Quality and resource contract

Detector, descriptor, weights, keypoint budget, inference dimensions, matching
threshold and FP32 numeric mode are immutable run inputs. CPU and CUDA execute
the same algorithm. Hardware policy may choose concurrency and the bounded
dual-softmax block size, but it may not remove a backend or lower a quality
parameter. Features are written image-by-image. Matching loads two feature
arrays and processes the similarity matrix in bounded blocks, so neither the
image count nor pair count creates an unbounded in-memory matrix.

The worker atomically checkpoints completed image IDs and pair IDs. Each pair
first becomes an isolated `pairs/########.hcdp`; only after all requested pairs
exist is the final container atomically assembled. Rust polls cancellation every
15 ms and force-kills the child immediately. Scratch outputs are never project
entities until a later validating command publishes them.

## Neutral `HCDEDG01` match container

All integers and floats are little-endian. Strings are UTF-8.

| Field       | Representation                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Magic       | 8 bytes: `HCDEDG01`                                                                            |
| Schema      | `u32`, currently `1`                                                                           |
| Pair count  | `u32`                                                                                          |
| Pair A ID   | `u32` byte length, then bytes                                                                  |
| Pair B ID   | `u32` byte length, then bytes                                                                  |
| Match count | `u32`                                                                                          |
| Match       | `u32 feature_a`, `u32 feature_b`, `f32 x_a`, `f32 y_a`, `f32 x_b`, `f32 y_b`, `f32 confidence` |

Pair records repeat in request order. The Rust importer requires an exact pair
set and count, finite in-image coordinates, confidence in `[0,1]`, feature
indices below the configured budget, mutual uniqueness and end-of-file directly
after the last record. This artifact contains candidate correspondences only.
COLMAP/Core must perform geometric verification before observations can enter a
track, sparse reconstruction or bundle adjustment.

## Development setup

Run `python3 scripts/fetch-photolab-dedode.py` for the build-time parity runtime,
then `scripts/convert-dedode-onnx.py` for both fixed Descriptor-G sizes. Release
staging uses `dedode_onnx_worker.py`; PyTorch output remains the parity oracle.
The two upstream sample images produce 1,024 features each and 429 mutual
matches in both paths. Corresponding descriptor cosine similarity is at least
0.9999997 in the current Linux audit. The runtime preflight is executed with an
empty environment and networking disabled.
