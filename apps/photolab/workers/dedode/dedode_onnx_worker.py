#!/usr/bin/env python3
"""Offline DeDoDe-v2-G inference through the permissive ONNX Runtime.

The exported graphs contain the exact pinned Detector-L-v2, Descriptor-G and
DINOv2 ViT-L/14 weights.  PyTorch is used at build time only and is never part
of a PhotoLab release runtime.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import struct
import sys
from typing import Any

SCHEMA_VERSION = 1
MAGIC = b"HCDEDG01"
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


def _atomic_json(path: pathlib.Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def _load_runtime():
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    return np, ort, Image


def _preflight(model_root: pathlib.Path) -> int:
    try:
        np, ort, Image = _load_runtime()
        _required_models(model_root, 784, 784)
        _required_models(model_root, 1176, 1176)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "schemaVersion": SCHEMA_VERSION,
                "pythonVersion": ".".join(map(str, sys.version_info[:3])),
                "runtimeBackend": "onnxruntime",
                "runtimeVersion": ort.__version__,
                "numpyVersion": np.__version__,
                "pillowVersion": Image.__version__,
                "dedodeImported": True,
                "networkDisabled": os.environ.get("DEDODE_NO_NETWORK") == "1"
                and os.environ.get("HF_HUB_OFFLINE") == "1"
                and os.environ.get("TRANSFORMERS_OFFLINE") == "1",
            },
            sort_keys=True,
        )
    )
    return 0


def _required_models(model_root: pathlib.Path, width: int, height: int):
    detector = (model_root / "dedode-detector-l-v2.onnx").resolve(strict=True)
    descriptor = (
        model_root / f"{width}x{height}" / "dedode-descriptor-g.onnx"
    ).resolve(strict=True)
    similarity = (model_root / "dedode-block-similarity.onnx").resolve(strict=True)
    return detector, descriptor, similarity


def _session(ort, path: pathlib.Path, device: dict[str, Any]):
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    if device["kind"] == "cpu":
        providers = ["CPUExecutionProvider"]
    elif device["kind"] == "cuda":
        available = set(ort.get_available_providers())
        if "CUDAExecutionProvider" not in available:
            raise RuntimeError("requested CUDA device is unavailable in the signed ONNX runtime")
        providers = [
            (
                "CUDAExecutionProvider",
                {"device_id": int(device["gpuIndex"]), "cudnn_conv_algo_search": "DEFAULT"},
            ),
            "CPUExecutionProvider",
        ]
    else:
        raise ValueError("unsupported compute device")
    return ort.InferenceSession(str(path), sess_options=options, providers=providers)


def _read_rgb(Image, np, path: pathlib.Path, width: int, height: int, mask_path=None):
    with Image.open(path) as image:
        original_width, original_height = image.size
        resized = image.convert("RGB").resize((width, height), Image.Resampling.BICUBIC)
        array = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
    valid = np.ones((height, width), dtype=bool)
    if mask_path is not None:
        with Image.open(mask_path) as mask:
            if mask.size != (original_width, original_height):
                raise ValueError("image mask dimensions differ from source pixels")
            valid = np.asarray(
                mask.convert("L").resize((width, height), Image.Resampling.NEAREST),
                dtype=np.uint8,
            ) > 127
        for channel, mean in enumerate(MEAN):
            array[:, :, channel][~valid] = np.float32(mean)
    array = array.transpose(2, 0, 1)
    for channel in range(3):
        array[channel] = (array[channel] - np.float32(MEAN[channel])) / np.float32(STD[channel])
    return np.ascontiguousarray(array[None]), original_width, original_height, valid


def _separable_density(np, score):
    kernel = np.exp(-(np.linspace(-2.0, 2.0, num=51, dtype=np.float32) ** 2))
    source = (score + np.float32(1e-6)) * np.float32(10000.0)
    radius = len(kernel) // 2
    horizontal_source = np.pad(source, ((0, 0), (radius, radius)), mode="constant")
    horizontal = np.zeros_like(source)
    for index, weight in enumerate(kernel):
        horizontal += weight * horizontal_source[:, index : index + source.shape[1]]
    vertical_source = np.pad(horizontal, ((radius, radius), (0, 0)), mode="constant")
    density = np.zeros_like(source)
    for index, weight in enumerate(kernel):
        density += weight * vertical_source[index : index + source.shape[0], :]
    return density


def _detect(np, logits, count: int, valid_mask):
    if logits.ndim != 4 or logits.shape[0] != 1:
        raise ValueError(f"unexpected detector output shape: {logits.shape}")
    _, channels, height, width = logits.shape
    flat = logits.reshape(channels * height * width).astype(np.float32, copy=False)
    maximum = np.max(flat)
    probability = np.exp(flat - maximum, dtype=np.float32)
    probability /= np.sum(probability, dtype=np.float64)
    score = probability.reshape(channels, height * width).sum(axis=0).reshape(height, width)
    score *= (_separable_density(np, score) + np.float32(1e-8)) ** np.float32(-0.5)
    sample_y = np.minimum(
        valid_mask.shape[0] - 1,
        ((np.arange(height, dtype=np.float64) + 0.5) * valid_mask.shape[0] / height).astype(np.int64),
    )
    sample_x = np.minimum(
        valid_mask.shape[1] - 1,
        ((np.arange(width, dtype=np.float64) + 0.5) * valid_mask.shape[1] / width).astype(np.int64),
    )
    valid = valid_mask[sample_y[:, None], sample_x[None, :]]
    score[~valid] = -np.inf
    count = min(count, int(np.count_nonzero(valid)))
    if count == 0:
        raise ValueError("image mask excludes every DeDoDe feature location")
    indices = np.argpartition(score.reshape(-1), -count)[-count:]
    order = np.argsort(score.reshape(-1)[indices])[::-1]
    indices = indices[order].astype(np.int64, copy=False)
    ys = indices // width
    xs = indices % width
    keypoints = np.empty((count, 2), dtype=np.float32)
    keypoints[:, 0] = -1.0 + 1.0 / width + (2.0 * xs.astype(np.float32) / width)
    keypoints[:, 1] = -1.0 + 1.0 / height + (2.0 * ys.astype(np.float32) / height)
    confidence = score.reshape(-1)[indices].astype(np.float32, copy=False)
    return keypoints, confidence, indices


def _descriptions(np, grid, indices):
    if grid.ndim != 4 or grid.shape[0] != 1:
        raise ValueError(f"unexpected descriptor output shape: {grid.shape}")
    _, channels, height, width = grid.shape
    if int(indices.max(initial=0)) >= height * width:
        raise ValueError("detector and descriptor grids have incompatible dimensions")
    return np.ascontiguousarray(grid[0].reshape(channels, -1)[:, indices].T, dtype=np.float32)


def _save_features(np, path, keypoints, confidence, descriptions, width, height):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as output:
        np.savez(
            output,
            keypoints=keypoints,
            confidence=confidence,
            descriptions=descriptions,
            width=np.asarray([width], dtype=np.uint32),
            height=np.asarray([height], dtype=np.uint32),
        )
    os.replace(temporary, path)


def _logsumexp(np, values, axis):
    maximum = np.max(values, axis=axis)
    return maximum + np.log(np.sum(np.exp(values - np.expand_dims(maximum, axis)), axis=axis))


def _similarity(session, left, right):
    return session.run(["similarity"], {"left": left, "right": right})[0]


def _blockwise_dual_softmax(np, session, descriptions_a, descriptions_b, block_size, threshold):
    left = descriptions_a.astype(np.float32, copy=False)
    right = descriptions_b.astype(np.float32, copy=False)
    left /= np.maximum(np.sqrt(np.sum(left * left, axis=1, keepdims=True)), np.float32(1e-12))
    right /= np.maximum(np.sqrt(np.sum(right * right, axis=1, keepdims=True)), np.float32(1e-12))
    rows, columns = left.shape[0], right.shape[0]
    row_lse = np.full(rows, -np.inf, dtype=np.float32)
    column_lse = np.full(columns, -np.inf, dtype=np.float32)
    for row_start in range(0, rows, block_size):
        row_stop = min(row_start + block_size, rows)
        row_block_lse = np.full(row_stop - row_start, -np.inf, dtype=np.float32)
        for column_start in range(0, columns, block_size):
            column_stop = min(column_start + block_size, columns)
            logits = np.float32(20.0) * _similarity(
                session, left[row_start:row_stop], right[column_start:column_stop]
            )
            row_block_lse = np.logaddexp(row_block_lse, _logsumexp(np, logits, axis=1))
            column_lse[column_start:column_stop] = np.logaddexp(
                column_lse[column_start:column_stop], _logsumexp(np, logits, axis=0)
            )
        row_lse[row_start:row_stop] = row_block_lse
    row_best_score = np.full(rows, -np.inf, dtype=np.float32)
    row_best_column = np.zeros(rows, dtype=np.int64)
    column_best_score = np.full(columns, -np.inf, dtype=np.float32)
    column_best_row = np.zeros(columns, dtype=np.int64)
    for row_start in range(0, rows, block_size):
        row_stop = min(row_start + block_size, rows)
        for column_start in range(0, columns, block_size):
            column_stop = min(column_start + block_size, columns)
            logits = np.float32(20.0) * _similarity(
                session, left[row_start:row_stop], right[column_start:column_stop]
            )
            log_probability = (
                logits * np.float32(2.0)
                - row_lse[row_start:row_stop, None]
                - column_lse[None, column_start:column_stop]
            )
            block_columns = np.argmax(log_probability, axis=1)
            block_scores = log_probability[np.arange(row_stop - row_start), block_columns]
            replace = block_scores > row_best_score[row_start:row_stop]
            row_best_score[row_start:row_stop][replace] = block_scores[replace]
            row_best_column[row_start:row_stop][replace] = block_columns[replace] + column_start
            block_rows = np.argmax(log_probability, axis=0)
            block_scores = log_probability[block_rows, np.arange(column_stop - column_start)]
            replace = block_scores > column_best_score[column_start:column_stop]
            column_best_score[column_start:column_stop][replace] = block_scores[replace]
            column_best_row[column_start:column_stop][replace] = block_rows[replace] + row_start
    row_indices = np.arange(rows, dtype=np.int64)
    confidence = np.exp(row_best_score, dtype=np.float32)
    selected = (column_best_row[row_best_column] == row_indices) & (confidence > threshold)
    return row_indices[selected], row_best_column[selected], confidence[selected]


def _pixel_coordinates(np, normalized, width, height):
    output = normalized.astype(np.float32, copy=True)
    output[:, 0] = np.float32(width) * (output[:, 0] + np.float32(1.0)) / np.float32(2.0)
    output[:, 1] = np.float32(height) * (output[:, 1] + np.float32(1.0)) / np.float32(2.0)
    return output


def _write_pair(path, image_a, image_b, indices_a, indices_b, points_a, points_b, confidence):
    temporary = path.with_suffix(path.suffix + ".tmp")
    encoded_a, encoded_b = image_a.encode("utf-8"), image_b.encode("utf-8")
    with temporary.open("wb") as output:
        output.write(struct.pack("<I", len(encoded_a)))
        output.write(encoded_a)
        output.write(struct.pack("<I", len(encoded_b)))
        output.write(encoded_b)
        output.write(struct.pack("<I", len(indices_a)))
        for index in range(len(indices_a)):
            output.write(
                struct.pack(
                    "<IIfffff",
                    int(indices_a[index]),
                    int(indices_b[index]),
                    float(points_a[index, 0]),
                    float(points_a[index, 1]),
                    float(points_b[index, 0]),
                    float(points_b[index, 1]),
                    float(confidence[index]),
                )
            )
    os.replace(temporary, path)


def _assemble_matches(path, pair_files):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as output:
        output.write(MAGIC)
        output.write(struct.pack("<II", SCHEMA_VERSION, len(pair_files)))
        for pair_file in pair_files:
            with pair_file.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
    os.replace(temporary, path)


def _run(request_path: pathlib.Path, model_root: pathlib.Path) -> int:
    request: dict[str, Any] = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("schemaVersion") != SCHEMA_VERSION or request.get("numericMode") != "float32":
        raise ValueError("unsupported request schema or numeric mode")
    np, ort, Image = _load_runtime()
    width, height = int(request["inferenceWidth"]), int(request["inferenceHeight"])
    detector_path, descriptor_path, similarity_path = _required_models(model_root, width, height)
    detector = _session(ort, detector_path, request["device"])
    descriptor = _session(ort, descriptor_path, request["device"])
    similarity = _session(ort, similarity_path, request["device"])
    scratch = pathlib.Path(request["scratchRoot"]).resolve(strict=True)
    feature_root, pair_root = scratch / "features", scratch / "pairs"
    checkpoint_path = scratch / "checkpoint.json"
    images = request["images"]
    completed_images: list[str] = []
    for index, image in enumerate(images):
        image_id = image["id"]
        tensor, original_width, original_height, valid = _read_rgb(
            Image, np, pathlib.Path(image["path"]), width, height, image.get("maskPath")
        )
        logits = detector.run(["keypoint_logits"], {"image": tensor})[0]
        keypoints, confidence, feature_indices = _detect(
            np, logits, int(request["maxKeypoints"]), valid
        )
        description_grid = descriptor.run(["description_grid"], {"image": tensor})[0]
        descriptions = _descriptions(np, description_grid, feature_indices)
        _save_features(
            np,
            feature_root / f"{image_id}.npz",
            keypoints,
            confidence,
            descriptions,
            original_width,
            original_height,
        )
        completed_images.append(image_id)
        _atomic_json(
            checkpoint_path,
            {"schemaVersion": 1, "completedImages": completed_images, "completedPairs": []},
        )
        print(f"HC_PROGRESS|features|{index + 1}|{len(images)}", flush=True)
    pair_files: list[pathlib.Path] = []
    completed_pairs: list[str] = []
    for index, pair in enumerate(request["pairs"]):
        image_a, image_b = pair["imageA"], pair["imageB"]
        with np.load(feature_root / f"{image_a}.npz", allow_pickle=False) as features_a:
            keypoints_a = features_a["keypoints"].copy()
            descriptions_a = features_a["descriptions"].copy()
            width_a, height_a = int(features_a["width"][0]), int(features_a["height"][0])
        with np.load(feature_root / f"{image_b}.npz", allow_pickle=False) as features_b:
            keypoints_b = features_b["keypoints"].copy()
            descriptions_b = features_b["descriptions"].copy()
            width_b, height_b = int(features_b["width"][0]), int(features_b["height"][0])
        indices_a, indices_b, confidence = _blockwise_dual_softmax(
            np,
            similarity,
            descriptions_a,
            descriptions_b,
            int(request["matchBlockSize"]),
            float(request["matchThreshold"]),
        )
        points_a = _pixel_coordinates(np, keypoints_a[indices_a], width_a, height_a)
        points_b = _pixel_coordinates(np, keypoints_b[indices_b], width_b, height_b)
        pair_file = pair_root / f"{index:08}.hcdp"
        _write_pair(pair_file, image_a, image_b, indices_a, indices_b, points_a, points_b, confidence)
        pair_files.append(pair_file)
        completed_pairs.append(f"{image_a}:{image_b}")
        if (index + 1) % int(request["checkpointIntervalPairs"]) == 0 or index + 1 == len(request["pairs"]):
            _atomic_json(
                checkpoint_path,
                {
                    "schemaVersion": 1,
                    "completedImages": completed_images,
                    "completedPairs": completed_pairs,
                },
            )
        print(f"HC_PROGRESS|pairs|{index + 1}|{len(request['pairs'])}", flush=True)
    matches_path = scratch / "matches.hcdm"
    _assemble_matches(matches_path, pair_files)
    _atomic_json(
        scratch / "result.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "jobId": request["jobId"],
            "backend": "dedode-v2-g",
            "numericMode": "float32",
            "imageCount": len(images),
            "pairCount": len(request["pairs"]),
            "matchesPath": "matches.hcdm",
            "checkpointPath": "checkpoint.json",
        },
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--run", type=pathlib.Path)
    parser.add_argument("--dedode-source", type=pathlib.Path, required=True)
    arguments = parser.parse_args()
    model_root = arguments.dedode_source.resolve(strict=True)
    if arguments.preflight:
        return _preflight(model_root)
    return _run(arguments.run.resolve(strict=True), model_root)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
