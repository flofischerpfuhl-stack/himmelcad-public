#!/usr/bin/env python3
"""Dynamically validate the exact staged Windows automation Python runtime."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import textwrap


SMOKE = r'''
import json
import math
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

assert sys.platform == "win32", sys.platform
import numpy as np

assert np.__version__ == "2.2.6", np.__version__
values = np.arange(12, dtype=np.float64).reshape(3, 4)
assert values.flags.c_contiguous
assert np.array_equal(values.sum(axis=1), np.array([6.0, 22.0, 38.0]))
product = np.array([[1.0, 2.0], [3.0, 4.0]]) @ np.array([[2.0, 0.0], [1.0, 2.0]])
assert np.allclose(product, np.array([[4.0, 4.0], [10.0, 8.0]]))

real_matrix = np.array([[4.0, 1.0], [1.0, 3.0]])
real_rhs = np.array([1.0, 2.0])
for dtype, tolerance in ((np.float32, 2e-5), (np.float64, 1e-11)):
    a = real_matrix.astype(dtype)
    b = real_rhs.astype(dtype)
    assert np.allclose(a @ a, np.array([[17.0, 7.0], [7.0, 10.0]], dtype=dtype), rtol=tolerance, atol=tolerance)
    solved = np.linalg.solve(a, b)
    assert np.allclose(a @ solved, b, rtol=tolerance, atol=tolerance)
    inverse = np.linalg.inv(a)
    assert np.allclose(a @ inverse, np.eye(2, dtype=dtype), rtol=tolerance, atol=tolerance)
    chol = np.linalg.cholesky(a)
    assert np.allclose(chol @ chol.T, a, rtol=tolerance, atol=tolerance)
    q, r = np.linalg.qr(a)
    assert np.allclose(q @ r, a, rtol=tolerance, atol=tolerance)
    assert np.allclose(q.T @ q, np.eye(2, dtype=dtype), rtol=tolerance, atol=tolerance)
    eigenvalues, eigenvectors = np.linalg.eigh(a)
    assert np.allclose(a @ eigenvectors, eigenvectors * eigenvalues, rtol=tolerance, atol=tolerance)
    general_values, general_vectors = np.linalg.eig(a)
    assert np.allclose(a @ general_vectors, general_vectors * general_values, rtol=tolerance, atol=tolerance)
    u, singular, vt = np.linalg.svd(a, full_matrices=False)
    assert np.allclose((u * singular) @ vt, a, rtol=tolerance, atol=tolerance)
    least, _, _, _ = np.linalg.lstsq(a, b, rcond=None)
    assert np.allclose(a @ least, b, rtol=tolerance, atol=tolerance)

complex_matrix = np.array([[3.0 + 0.0j, 1.0 - 2.0j], [1.0 + 2.0j, 4.0 + 0.0j]])
complex_rhs = np.array([1.0 + 1.0j, 2.0 - 0.5j])
for dtype, tolerance in ((np.complex64, 3e-5), (np.complex128, 2e-11)):
    a = complex_matrix.astype(dtype)
    b = complex_rhs.astype(dtype)
    solved = np.linalg.solve(a, b)
    assert np.allclose(a @ solved, b, rtol=tolerance, atol=tolerance)
    inverse = np.linalg.inv(a)
    assert np.allclose(a @ inverse, np.eye(2, dtype=dtype), rtol=tolerance, atol=tolerance)
    chol = np.linalg.cholesky(a)
    assert np.allclose(chol @ chol.conj().T, a, rtol=tolerance, atol=tolerance)
    q, r = np.linalg.qr(a)
    assert np.allclose(q @ r, a, rtol=tolerance, atol=tolerance)
    eigenvalues, eigenvectors = np.linalg.eigh(a)
    assert np.allclose(a @ eigenvectors, eigenvectors * eigenvalues, rtol=tolerance, atol=tolerance)
    general_values, general_vectors = np.linalg.eig(a)
    assert np.allclose(a @ general_vectors, general_vectors * general_values, rtol=tolerance, atol=tolerance)
    u, singular, vh = np.linalg.svd(a, full_matrices=False)
    assert np.allclose((u * singular) @ vh, a, rtol=tolerance, atol=tolerance)
    least, _, _, _ = np.linalg.lstsq(a, b, rcond=None)
    assert np.allclose(a @ least, b, rtol=tolerance, atol=tolerance)

singular_matrix = np.array([[1.0, 2.0], [2.0, 4.0]])
for operation in (np.linalg.solve, lambda a, _: np.linalg.inv(a)):
    try:
        operation(singular_matrix, np.ones(2))
    except np.linalg.LinAlgError:
        pass
    else:
        raise AssertionError("singular system did not raise LinAlgError")
try:
    np.linalg.cholesky(np.array([[1.0, 2.0], [2.0, 1.0]]))
except np.linalg.LinAlgError:
    pass
else:
    raise AssertionError("non-positive-definite matrix did not raise LinAlgError")

hilbert = 1.0 / (np.arange(8)[:, None] + np.arange(8)[None, :] + 1.0)
assert np.linalg.cond(hilbert) > 1e9
hilbert_solution = np.linalg.solve(hilbert, hilbert @ np.ones(8))
assert np.linalg.norm(hilbert @ hilbert_solution - hilbert @ np.ones(8), ord=np.inf) < 1e-9

def threaded_linalg(_):
    matrix = np.arange(1, 17, dtype=np.float64).reshape(4, 4) + np.eye(4)
    u, s, vh = np.linalg.svd(matrix, full_matrices=False)
    return np.max(np.abs((u * s) @ vh - matrix))

with ThreadPoolExecutor(max_workers=4) as pool:
    assert max(pool.map(threaded_linalg, range(12))) < 1e-10

children = [
    subprocess.Popen(
        [sys.executable, "-I", "-c", "import numpy as n; assert n.arange(4).sum() == 6"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for _ in range(4)
]
for child in children:
    stdout, stderr = child.communicate(timeout=30)
    assert child.returncode == 0, (child.returncode, stdout, stderr)

config = json.dumps(np.__config__.show(mode="dicts"), sort_keys=True).lower()
assert "himmelcad-reference-f2c" in config, config
for forbidden in ("openblas", "mkl", "gfortran", "libgomp", "libiomp", "blas.dll", "lapack.dll"):
    assert forbidden not in config, (forbidden, config)

if not __NUMPY_ONLY__:
    import cv2

    assert cv2.__version__ == "4.13.0", cv2.__version__
    build = cv2.getBuildInformation().lower()
    for forbidden in ("openblas", "gfortran", "libgomp", "libiomp"):
        assert forbidden not in build, forbidden
    image = np.zeros((32, 48, 3), dtype=np.uint8)
    image[4:28, 8:40] = (17, 91, 203)
    ok, encoded = cv2.imencode(".png", image)
    assert ok and encoded.dtype == np.uint8 and encoded.size > 32
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    assert decoded is not None and np.array_equal(decoded, image)
    sift = cv2.SIFT_create(nfeatures=32)
    keypoints, descriptors = sift.detectAndCompute(
        cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), None
    )
    assert isinstance(keypoints, tuple)
    assert descriptors is None or descriptors.shape[1] == 128

print("WINDOWS_AUTOMATION_RUNTIME_SMOKE_OK", np.__version__, "numpy-only" if __NUMPY_ONLY__ else cv2.__version__, flush=True)
'''


def _windows_path(path: Path) -> str:
    resolved = path.resolve()
    return "Z:" + str(resolved).replace("/", "\\")


def _kill_wineserver(wine: Path, prefix: Path) -> None:
    wineserver = wine.with_name("wineserver")
    if not wineserver.is_file():
        return
    subprocess.run(
        [str(wineserver), "-k"],
        env={**os.environ, "WINEPREFIX": str(prefix.resolve())},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=10,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python-root", required=True, type=Path)
    parser.add_argument("--numpy-only", action="store_true")
    parser.add_argument("--wine-executable", type=Path)
    parser.add_argument("--wine-prefix", type=Path)
    parser.add_argument("--xvfb-run", default="xvfb-run")
    parser.add_argument("--timeout-seconds", type=int, default=90)
    args = parser.parse_args()

    root = args.python_root.resolve()
    executable = root / "python.exe"
    if not executable.is_file():
        parser.error(f"missing Windows CPython executable: {executable}")
    code = textwrap.dedent(SMOKE).replace("__NUMPY_ONLY__", repr(args.numpy_only))
    env = {
        **os.environ,
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": "",
        "PYTHONDONTWRITEBYTECODE": "1",
    }

    if os.name == "nt":
        if args.wine_executable or args.wine_prefix:
            parser.error("Wine arguments are not valid on native Windows")
        command = [str(executable), "-I", "-X", "utf8", "-c", code]
    else:
        if not args.wine_executable or not args.wine_prefix:
            parser.error("Linux requires --wine-executable and --wine-prefix")
        wine = args.wine_executable.resolve()
        prefix = args.wine_prefix.resolve()
        if not wine.is_file():
            parser.error(f"missing Wine executable: {wine}")
        prefix.mkdir(parents=True, exist_ok=True)
        env.update(
            {
                "WINEPREFIX": str(prefix),
                "WINEDLLOVERRIDES": "winemenubuilder.exe=d;winedbg.exe=d",
                "WINEDEBUG": "-all",
            }
        )
        command = [
            args.xvfb_run,
            "-a",
            str(wine),
            _windows_path(executable),
            "-I",
            "-X",
            "utf8",
            "-c",
            code,
        ]

    try:
        completed = subprocess.run(
            command,
            env=env,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=args.timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        if args.wine_executable and args.wine_prefix:
            _kill_wineserver(args.wine_executable.resolve(), args.wine_prefix.resolve())
        raise SystemExit(f"Windows runtime smoke timed out: {error}") from error

    if args.wine_executable and args.wine_prefix:
        _kill_wineserver(args.wine_executable.resolve(), args.wine_prefix.resolve())
    if completed.stdout:
        print(completed.stdout, end="")
    if completed.stderr:
        print(completed.stderr, end="", file=sys.stderr)
    if completed.returncode != 0:
        raise SystemExit(f"Windows runtime smoke failed with exit code {completed.returncode}")
    if "CRASHES ARE TO BE EXPECTED" in completed.stderr:
        raise SystemExit("NumPy reports its compiler/runtime combination as experimental")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
