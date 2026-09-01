#!/usr/bin/env python3
"""Offline DeDoDe-v2-G inference worker for HimmelCAD PhotoLab."""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import pathlib
import struct
import sys
import types
from typing import Any

SCHEMA_VERSION = 1
MAGIC = b"HCDEDG01"


def _atomic_json(path: pathlib.Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def _load_runtime(source_root: pathlib.Path):
    sys.path.insert(0, str(source_root))
    # DeDoDe imports cv2 only for optional pose/augmentation helpers. PhotoLab
    # keeps geometry in Rust/COLMAP and does not incorporate an OpenCV wheel.
    sys.modules.setdefault("cv2", types.ModuleType("cv2"))
    import numpy as np
    import torch
    import torchvision
    from PIL import Image
    from DeDoDe import dedode_descriptor_G, dedode_detector_L

    return np, torch, torchvision, Image, dedode_detector_L, dedode_descriptor_G


def _preflight(source_root: pathlib.Path) -> int:
    try:
        _, torch, torchvision, _, _, _ = _load_runtime(source_root)
        imported = True
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "pythonVersion": ".".join(map(str, sys.version_info[:3])),
        "torchVersion": torch.__version__,
        "torchvisionVersion": torchvision.__version__,
        "dedodeImported": imported,
        "networkDisabled": os.environ.get("DEDODE_NO_NETWORK") == "1"
            and os.environ.get("HF_HUB_OFFLINE") == "1"
            and os.environ.get("TRANSFORMERS_OFFLINE") == "1",
    }, sort_keys=True))
    return 0


def _read_rgb(Image, np, torch, path: pathlib.Path, width: int, height: int, normalizer, device, mask_path=None):
    with Image.open(path) as image:
        original_width, original_height = image.size
        resized = image.convert("RGB").resize((width, height))
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
        array[~valid] = np.float32(0.5)
    tensor = torch.from_numpy(array).permute(2, 0, 1)
    return normalizer(tensor).unsqueeze(0).to(device), original_width, original_height, valid


def _retain_unmasked_keypoints(np, keypoints, confidence, valid):
    pixel_x = np.clip(((keypoints[:, 0] + 1.0) * 0.5 * valid.shape[1]).astype(np.int64), 0, valid.shape[1] - 1)
    pixel_y = np.clip(((keypoints[:, 1] + 1.0) * 0.5 * valid.shape[0]).astype(np.int64), 0, valid.shape[0] - 1)
    keep = valid[pixel_y, pixel_x]
    if not np.any(keep):
        raise ValueError("image mask excludes every DeDoDe feature location")
    return keypoints[keep], confidence[keep]


def _force_float32(torch, model) -> None:
    model.float()
    for module in model.modules():
        if hasattr(module, "amp"):
            module.amp = False
        if hasattr(module, "amp_dtype"):
            module.amp_dtype = torch.float32
    frozen = getattr(getattr(model, "encoder", None), "frozen_dinov2", None)
    if frozen is not None:
        frozen.amp = False
        frozen.amp_dtype = torch.float32
        frozen.dinov2_vitl14[0] = frozen.dinov2_vitl14[0].float()


def _save_features(np, path: pathlib.Path, keypoints, confidence, descriptions, width: int, height: int) -> None:
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


def _feature_path(root: pathlib.Path, image_id: str) -> pathlib.Path:
    """Map opaque image identifiers to portable, collision-resistant filenames."""
    digest = hashlib.sha256(image_id.encode("utf-8")).hexdigest()
    return root / f"{digest}.npz"


def _streaming_logsumexp(torch, left, right, block_size: int, inverse_temperature: float):
    rows, columns = left.shape[0], right.shape[0]
    row_lse = torch.full((rows,), -torch.inf, dtype=torch.float32, device=left.device)
    column_lse = torch.full((columns,), -torch.inf, dtype=torch.float32, device=left.device)
    for row_start in range(0, rows, block_size):
        row_stop = min(row_start + block_size, rows)
        row_block_lse = torch.full((row_stop - row_start,), -torch.inf, dtype=torch.float32, device=left.device)
        for column_start in range(0, columns, block_size):
            column_stop = min(column_start + block_size, columns)
            logits = inverse_temperature * (left[row_start:row_stop] @ right[column_start:column_stop].T)
            row_block_lse = torch.logaddexp(row_block_lse, torch.logsumexp(logits, dim=1))
            column_lse[column_start:column_stop] = torch.logaddexp(
                column_lse[column_start:column_stop], torch.logsumexp(logits, dim=0)
            )
        row_lse[row_start:row_stop] = row_block_lse
    return row_lse, column_lse


def _blockwise_dual_softmax(torch, descriptions_a, descriptions_b, block_size: int, threshold: float):
    left = torch.nn.functional.normalize(descriptions_a.float(), dim=-1)
    right = torch.nn.functional.normalize(descriptions_b.float(), dim=-1)
    rows, columns = left.shape[0], right.shape[0]
    row_lse, column_lse = _streaming_logsumexp(torch, left, right, block_size, 20.0)
    row_best_score = torch.full((rows,), -torch.inf, dtype=torch.float32, device=left.device)
    row_best_column = torch.zeros((rows,), dtype=torch.int64, device=left.device)
    column_best_score = torch.full((columns,), -torch.inf, dtype=torch.float32, device=left.device)
    column_best_row = torch.zeros((columns,), dtype=torch.int64, device=left.device)
    for row_start in range(0, rows, block_size):
        row_stop = min(row_start + block_size, rows)
        for column_start in range(0, columns, block_size):
            column_stop = min(column_start + block_size, columns)
            logits = 20.0 * (left[row_start:row_stop] @ right[column_start:column_stop].T)
            log_probability = logits * 2.0 - row_lse[row_start:row_stop, None] - column_lse[None, column_start:column_stop]
            block_row_score, block_row_column = torch.max(log_probability, dim=1)
            current_rows = row_best_score[row_start:row_stop]
            replace_rows = block_row_score > current_rows
            row_best_score[row_start:row_stop] = torch.where(replace_rows, block_row_score, current_rows)
            row_best_column[row_start:row_stop] = torch.where(
                replace_rows, block_row_column + column_start, row_best_column[row_start:row_stop]
            )
            block_column_score, block_column_row = torch.max(log_probability, dim=0)
            current_columns = column_best_score[column_start:column_stop]
            replace_columns = block_column_score > current_columns
            column_best_score[column_start:column_stop] = torch.where(replace_columns, block_column_score, current_columns)
            column_best_row[column_start:column_stop] = torch.where(
                replace_columns, block_column_row + row_start, column_best_row[column_start:column_stop]
            )
    row_indices = torch.arange(rows, device=left.device)
    mutual = column_best_row[row_best_column] == row_indices
    confidence = torch.exp(row_best_score)
    selected = mutual & (confidence > threshold)
    return row_indices[selected], row_best_column[selected], confidence[selected]


def _pixel_coordinates(np, normalized, width: int, height: int):
    output = normalized.astype(np.float32, copy=True)
    output[:, 0] = np.float32(width) * (output[:, 0] + np.float32(1.0)) / np.float32(2.0)
    output[:, 1] = np.float32(height) * (output[:, 1] + np.float32(1.0)) / np.float32(2.0)
    return output


def _write_pair(path: pathlib.Path, image_a: str, image_b: str, indices_a, indices_b, points_a, points_b, confidence) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    encoded_a, encoded_b = image_a.encode("utf-8"), image_b.encode("utf-8")
    with temporary.open("wb") as output:
        output.write(struct.pack("<I", len(encoded_a)))
        output.write(encoded_a)
        output.write(struct.pack("<I", len(encoded_b)))
        output.write(encoded_b)
        output.write(struct.pack("<I", len(indices_a)))
        for index in range(len(indices_a)):
            output.write(struct.pack(
                "<IIfffff",
                int(indices_a[index]), int(indices_b[index]),
                float(points_a[index, 0]), float(points_a[index, 1]),
                float(points_b[index, 0]), float(points_b[index, 1]),
                float(confidence[index]),
            ))
    os.replace(temporary, path)


def _assemble_matches(path: pathlib.Path, pair_files: list[pathlib.Path]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as output:
        output.write(MAGIC)
        output.write(struct.pack("<II", SCHEMA_VERSION, len(pair_files)))
        for pair_file in pair_files:
            with pair_file.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
    os.replace(temporary, path)


def _run(request_path: pathlib.Path, source_root: pathlib.Path) -> int:
    request: dict[str, Any] = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("schemaVersion") != SCHEMA_VERSION or request.get("numericMode") != "float32":
        raise ValueError("unsupported request schema or numeric mode")
    np, torch, _, Image, detector_factory, descriptor_factory = _load_runtime(source_root)
    torch.manual_seed(0)
    np.random.seed(0)
    torch.set_grad_enabled(False)
    torch.use_deterministic_algorithms(True)
    device_spec = request["device"]
    if device_spec["kind"] == "cpu":
        device = torch.device("cpu")
    elif device_spec["kind"] == "cuda":
        gpu_index = int(device_spec["gpuIndex"])
        if not torch.cuda.is_available() or gpu_index >= torch.cuda.device_count():
            raise RuntimeError("requested CUDA device is unavailable")
        device = torch.device(f"cuda:{gpu_index}")
    else:
        raise ValueError("unsupported compute device")
    load_options = {"map_location": "cpu"}
    if "weights_only" in inspect.signature(torch.load).parameters:
        load_options["weights_only"] = True
    detector_weights = torch.load(request["detectorV2Weights"], **load_options)
    descriptor_weights = torch.load(request["descriptorGWeights"], **load_options)
    dinov2_weights = torch.load(request["dinov2Vitl14Weights"], **load_options)
    detector = detector_factory(device=device, weights=detector_weights)
    descriptor = descriptor_factory(device=device, weights=descriptor_weights, dinov2_weights=dinov2_weights)
    _force_float32(torch, detector)
    _force_float32(torch, descriptor)
    detector.to(device).eval()
    descriptor.to(device).eval()
    del detector_weights, descriptor_weights, dinov2_weights

    scratch = pathlib.Path(request["scratchRoot"]).resolve(strict=True)
    feature_root, pair_root = scratch / "features", scratch / "pairs"
    checkpoint_path = scratch / "checkpoint.json"
    images = request["images"]
    completed_images: list[str] = []
    for index, image in enumerate(images):
        image_id = image["id"]
        tensor, original_width, original_height, valid = _read_rgb(
            Image, np, torch, pathlib.Path(image["path"]),
            int(request["inferenceWidth"]), int(request["inferenceHeight"]), detector.normalizer, device,
            image.get("maskPath"),
        )
        detections = detector.detect({"image": tensor}, num_keypoints=int(request["maxKeypoints"]))
        keypoints = detections["keypoints"]
        confidence = detections["confidence"]
        filtered_keypoints, filtered_confidence = _retain_unmasked_keypoints(
            np, keypoints[0].float().cpu().numpy(), confidence[0].float().cpu().numpy(), valid
        )
        keypoints = torch.from_numpy(filtered_keypoints).to(device).unsqueeze(0)
        confidence = torch.from_numpy(filtered_confidence).to(device).unsqueeze(0)
        descriptions = descriptor.describe_keypoints({"image": tensor}, keypoints)["descriptions"]
        _save_features(
            np, _feature_path(feature_root, image_id),
            keypoints[0].float().cpu().numpy(), confidence[0].float().cpu().numpy(),
            descriptions[0].float().cpu().numpy(), original_width, original_height,
        )
        completed_images.append(image_id)
        _atomic_json(checkpoint_path, {"schemaVersion": 1, "completedImages": completed_images, "completedPairs": []})
        print(f"HC_PROGRESS|features|{index + 1}|{len(images)}", flush=True)
        del tensor, detections, keypoints, confidence, descriptions
        if device.type == "cuda":
            torch.cuda.empty_cache()

    pair_files: list[pathlib.Path] = []
    completed_pairs: list[str] = []
    for index, pair in enumerate(request["pairs"]):
        image_a, image_b = pair["imageA"], pair["imageB"]
        with np.load(_feature_path(feature_root, image_a), allow_pickle=False) as features_a:
            keypoints_a = features_a["keypoints"].copy()
            descriptions_a = features_a["descriptions"].copy()
            width_a, height_a = int(features_a["width"][0]), int(features_a["height"][0])
        with np.load(_feature_path(feature_root, image_b), allow_pickle=False) as features_b:
            keypoints_b = features_b["keypoints"].copy()
            descriptions_b = features_b["descriptions"].copy()
            width_b, height_b = int(features_b["width"][0]), int(features_b["height"][0])
        indices_a, indices_b, confidence = _blockwise_dual_softmax(
            torch, torch.from_numpy(descriptions_a).to(device), torch.from_numpy(descriptions_b).to(device),
            int(request["matchBlockSize"]), float(request["matchThreshold"]),
        )
        indices_a_np, indices_b_np = indices_a.cpu().numpy(), indices_b.cpu().numpy()
        points_a = _pixel_coordinates(np, keypoints_a[indices_a_np], width_a, height_a)
        points_b = _pixel_coordinates(np, keypoints_b[indices_b_np], width_b, height_b)
        confidence_np = confidence.float().cpu().numpy()
        pair_file = pair_root / f"{index:08}.hcdp"
        _write_pair(pair_file, image_a, image_b, indices_a_np, indices_b_np, points_a, points_b, confidence_np)
        pair_files.append(pair_file)
        completed_pairs.append(f"{image_a}:{image_b}")
        if (index + 1) % int(request["checkpointIntervalPairs"]) == 0 or index + 1 == len(request["pairs"]):
            _atomic_json(checkpoint_path, {"schemaVersion": 1, "completedImages": completed_images, "completedPairs": completed_pairs})
        print(f"HC_PROGRESS|pairs|{index + 1}|{len(request['pairs'])}", flush=True)

    matches_path = scratch / "matches.hcdm"
    _assemble_matches(matches_path, pair_files)
    _atomic_json(scratch / "result.json", {
        "schemaVersion": SCHEMA_VERSION,
        "jobId": request["jobId"],
        "backend": "dedode-v2-g",
        "numericMode": "float32",
        "imageCount": len(images),
        "pairCount": len(request["pairs"]),
        "matchesPath": "matches.hcdm",
        "checkpointPath": "checkpoint.json",
    })
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--run", type=pathlib.Path)
    parser.add_argument("--dedode-source", type=pathlib.Path, required=True)
    arguments = parser.parse_args()
    source_root = arguments.dedode_source.resolve(strict=True)
    if arguments.preflight:
        return _preflight(source_root)
    return _run(arguments.run.resolve(strict=True), source_root)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
