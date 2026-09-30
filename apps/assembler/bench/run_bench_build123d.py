"""Runner for `build123d_tasks.py` (PLAN §5 comparison evidence).

Not part of the Assembler product; build123d is not a dependency of this
repository (Apache-2.0, installed into a throwaway venv only to run this
measurement — see `AGENT-API.md` "Comparison benchmark"). Usage::

    <venv>/Scripts/python.exe apps/assembler/bench/run_bench_build123d.py --out <dir>

For each task: source lines/characters of the task function (a *proxy* for
token cost — not a token count; see the caveat in `AGENT-API.md`), validity,
bbox vs. the hand calculation, volume vs. the hand calculation, STL/STEP
export success, and whether the result stays manually editable afterwards in
a GUI (no — build123d has no history/parameter GUI; the Python script is the
only editable representation).
"""
from __future__ import annotations

import argparse
import inspect
import json
import time
from pathlib import Path

from build123d import export_step, export_stl

from build123d_tasks import TASKS, TaskExpectation


def check(name: str, expectation: TaskExpectation, out_dir: Path) -> dict:
    part = expectation.part
    bbox = part.bounding_box()
    bbox_min = (round(bbox.min.X, 3), round(bbox.min.Y, 3), round(bbox.min.Z, 3))
    bbox_max = (round(bbox.max.X, 3), round(bbox.max.Y, 3), round(bbox.max.Z, 3))
    bbox_ok = all(abs(a - b) < 1e-2 for a, b in zip(bbox_min, expectation.bbox_min)) and all(
        abs(a - b) < 1e-2 for a, b in zip(bbox_max, expectation.bbox_max)
    )
    volume_ok = abs(part.volume - expectation.volume) <= expectation.volume_tolerance * abs(expectation.volume)

    stl_path = out_dir / f"{name}.stl"
    step_path = out_dir / f"{name}.step"
    export_stl(part, str(stl_path))
    export_step(part, str(step_path))

    return {
        "task": name,
        "valid": bool(part.is_valid),
        "bbox_ok": bbox_ok,
        "bbox_min": bbox_min,
        "bbox_max": bbox_max,
        "expected_bbox_min": expectation.bbox_min,
        "expected_bbox_max": expectation.bbox_max,
        "volume": part.volume,
        "expected_volume": expectation.volume,
        "volume_ok": volume_ok,
        "stl_bytes": stl_path.stat().st_size,
        "step_bytes": step_path.stat().st_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=r"D:\AgentWork\HimmelCAD-Assembler\bench-b123d")
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for name, build in TASKS.items():
        source = inspect.getsource(build)
        # Excludes the function's own `def .../return` scaffolding lines that
        # are identical across every task, closer to "modelling code" than
        # "function boilerplate": still counts imports once, globally, below.
        lines = [line for line in source.splitlines() if line.strip()]
        start = time.perf_counter()
        expectation = build()
        elapsed = time.perf_counter() - start
        result = check(name, expectation, out_dir)
        result["lines"] = len(lines)
        result["characters"] = len(source)
        result["seconds"] = round(elapsed, 3)
        results.append(result)
        print(
            f"{name:20s} valid={result['valid']!s:5} bbox_ok={result['bbox_ok']!s:5} "
            f"volume_ok={result['volume_ok']!s:5} volume={result['volume']:.2f} "
            f"(expected {result['expected_volume']:.2f}) lines={result['lines']} chars={result['characters']}"
        )

    (out_dir / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
