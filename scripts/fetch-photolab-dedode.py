#!/usr/bin/env python3
"""Materialize the pinned DeDoDe-v2-G development worker; never used at runtime."""

from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import json

SOURCE_COMMIT = "6d156183f4dc84cd704ae779eebc8350995c5b06"
ARTIFACTS = (
    (
        "dedode-source.tar.gz",
        f"https://github.com/Parskatt/DeDoDe/archive/{SOURCE_COMMIT}.tar.gz",
        2_430_674,
        "798998134708a87aee34c5ff0d55ae1da7c49baedf3b173c43dee08e5ea71ae2",
    ),
    (
        "models/dedode_detector_L_v2.pth",
        "https://github.com/Parskatt/DeDoDe/releases/download/v2/dedode_detector_L_v2.pth",
        58_483_585,
        "4113809dd9e0367af013a45fc2255a6b243ff241cd06520d17a65d9e231bdc17",
    ),
    (
        "models/dedode_descriptor_G.pth",
        "https://github.com/Parskatt/DeDoDe/releases/download/dedode_pretrained_models/dedode_descriptor_G.pth",
        75_485_969,
        "ef6e3f2911bb3c179960db15545a2137d0746054bb5bad75559524ccab1fee41",
    ),
    (
        "models/dinov2_vitl14_pretrain.pth",
        "https://dl.fbaipublicfiles.com/dinov2/dinov2_vitl14/dinov2_vitl14_pretrain.pth",
        1_217_586_395,
        "d5383ea8f4877b2472eb973e0fd72d557c7da5d3611bd527ceeb1d7162cbf428",
    ),
)
TORCH_PACKAGES = (
    "torch==2.5.1",
    "torchvision==0.20.1",
)
INFERENCE_PACKAGES = (
    "numpy==2.1.3",
    "pillow==11.0.0",
    "einops==0.8.0",
    "filelock==3.16.1",
    "typing-extensions==4.12.2",
    "networkx==3.4.2",
    "jinja2==3.1.4",
    "fsspec==2024.10.0",
    "setuptools==75.1.0",
    "sympy==1.13.1",
    "mpmath==1.3.0",
    "markupsafe==3.0.2",
)


def digest(path: pathlib.Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def verified(path: pathlib.Path, size: int, sha256: str) -> bool:
    return path.is_file() and path.stat().st_size == size and digest(path) == sha256


def fetch(path: pathlib.Path, url: str, size: int, sha256: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if verified(path, size, sha256):
        print(f"verified {path}")
        return
    temporary = path.with_suffix(path.suffix + ".part")
    if verified(temporary, size, sha256):
        os.replace(temporary, path)
        print(f"verified {path}")
        return
    offset = temporary.stat().st_size if temporary.is_file() else 0
    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
    with urllib.request.urlopen(request) as response:
        append = offset > 0 and response.status == 206
        with temporary.open("ab" if append else "wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
    if not verified(temporary, size, sha256):
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"hash or byte-size mismatch for {url}")
    os.replace(temporary, path)


def extract_source(archive: pathlib.Path, destination: pathlib.Path) -> pathlib.Path:
    source_root = destination / f"DeDoDe-{SOURCE_COMMIT}"
    marker = source_root / "DeDoDe" / "model_zoo" / "dedode_models.py"
    if marker.is_file():
        return source_root
    if source_root.exists():
        shutil.rmtree(source_root)
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        for member in members:
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise RuntimeError("source archive contains path traversal")
        bundle.extractall(destination, members=members, filter="data")
    if not marker.is_file():
        raise RuntimeError("pinned DeDoDe source archive is incomplete")
    return source_root


def create_environment(root: pathlib.Path, torch_channel: str) -> pathlib.Path:
    environment = root / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if environment.exists():
        shutil.rmtree(environment)
    subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
    subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "--only-binary=:all:", *INFERENCE_PACKAGES,
    ], check=True)
    subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "--only-binary=:all:", "--no-deps", "--index-url",
        f"https://download.pytorch.org/whl/{torch_channel}", *TORCH_PACKAGES,
    ], check=True)
    return python


def offline_environment() -> dict[str, str]:
    environment = {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DEDODE_NO_NETWORK": "1",
        "PYTHONHASHSEED": "0",
        "LC_ALL": "C",
    }
    if os.name == "nt":
        for name in ("SystemRoot", "WINDIR"):
            if name in os.environ:
                environment[name] = os.environ[name]
    return environment


def verify_worker(python: pathlib.Path, source_root: pathlib.Path) -> str:
    repository = pathlib.Path(__file__).resolve().parent.parent
    worker = repository / "apps/photolab/workers/dedode/dedode_worker.py"
    completed = subprocess.run(
        [str(python), "-I", "-B", "-s", str(worker), "--preflight", "--dedode-source", str(source_root)],
        check=True,
        capture_output=True,
        text=True,
        env=offline_environment(),
    )
    return completed.stdout.strip()


def smoke_inference(python: pathlib.Path, source_root: pathlib.Path, root: pathlib.Path) -> str:
    repository = pathlib.Path(__file__).resolve().parent.parent
    worker = repository / "apps/photolab/workers/dedode/dedode_worker.py"
    scratch = root / "smoke"
    if scratch.exists():
        shutil.rmtree(scratch)
    for directory in ("images", "features", "pairs", "home", "tmp", "cache"):
        (scratch / directory).mkdir(parents=True, exist_ok=True)
    image_a = source_root / "assets/im_A.jpg"
    image_b = source_root / "assets/im_B.jpg"
    request = {
        "schemaVersion": 1,
        "jobId": "dedode-smoke",
        "scratchRoot": str(scratch),
        "images": [
            {"id": "project:smoke:image:a", "path": str(image_a)},
            {"id": "project:smoke:image:b", "path": str(image_b)},
        ],
        "pairs": [{"imageA": "project:smoke:image:a", "imageB": "project:smoke:image:b"}],
        "device": {"kind": "cpu"},
        "numericMode": "float32",
        "maxKeypoints": 1024,
        "inferenceWidth": 196,
        "inferenceHeight": 196,
        "matchThreshold": 0.01,
        "matchBlockSize": 128,
        "checkpointIntervalPairs": 1,
        "detectorV2Weights": str(root / "models/dedode_detector_L_v2.pth"),
        "descriptorGWeights": str(root / "models/dedode_descriptor_G.pth"),
        "dinov2Vitl14Weights": str(root / "models/dinov2_vitl14_pretrain.pth"),
    }
    request_path = scratch / "run-request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    environment = offline_environment() | {
        "HOME": str(scratch / "home"), "TMPDIR": str(scratch / "tmp"),
        "TEMP": str(scratch / "tmp"), "TMP": str(scratch / "tmp"),
        "XDG_CACHE_HOME": str(scratch / "cache"), "TORCH_HOME": str(scratch / "cache/torch"),
        "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
    }
    completed = subprocess.run(
        [str(python), "-I", "-B", "-s", str(worker), "--run", str(request_path), "--dedode-source", str(source_root)],
        check=True, capture_output=True, text=True, env=environment,
    )
    result = json.loads((scratch / "result.json").read_text(encoding="utf-8"))
    matches = scratch / result["matchesPath"]
    if not matches.is_file() or matches.stat().st_size <= 16:
        raise RuntimeError("inference smoke test produced no framed match artifact")
    return completed.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("vendor/dedode/dev"))
    parser.add_argument("--skip-python-environment", action="store_true")
    parser.add_argument("--torch-channel", choices=("cpu", "cu124"), default="cpu")
    parser.add_argument("--smoke-inference", action="store_true")
    arguments = parser.parse_args()
    root = arguments.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for relative, url, size, sha256 in ARTIFACTS:
        fetch(root / relative, url, size, sha256)
    source_root = extract_source(root / "dedode-source.tar.gz", root)
    python = pathlib.Path(sys.executable) if arguments.skip_python_environment else create_environment(root, arguments.torch_channel)
    preflight = verify_worker(python, source_root)
    smoke = smoke_inference(python, source_root, root) if arguments.smoke_inference else None
    print(f"python={python}")
    print(f"source={source_root}")
    print(f"detector={root / 'models/dedode_detector_L_v2.pth'}")
    print(f"descriptor={root / 'models/dedode_descriptor_G.pth'}")
    print(f"dinov2={root / 'models/dinov2_vitl14_pretrain.pth'}")
    print(f"preflight={preflight}")
    if smoke is not None:
        print(f"smoke={smoke}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
