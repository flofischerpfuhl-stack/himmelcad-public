"""Runs the five printable-part tasks through ``assembler-headless`` and records evidence.

Usage (repository root, after ``pnpm --filter @himmelcad/assembler build:headless``)::

    python apps/assembler/bench/run_bench.py [--out D:/AgentWork/HimmelCAD-Asm-agentapi/bench]

Per task: canonical commands issued, wall time, validity, bbox and volume against a hand
calculation, 3MF + STL export, ``.hcasm`` save, and a load test in a *fresh* headless
process: reopen the file (strict format validation, full re-evaluation), compare, apply a
parametric edit to an early sketch dimension (``sketch.setDimension``, the command the
app's History-panel dimension edit maps to) and check that the whole history still evaluates.
Writes ``results.json`` and prints a Markdown table.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPOSITORY_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "sdk/python/src"))
sys.path.insert(0, str(HERE))

from himmelcad.assembler import AssemblerClient, AssemblerError, Document  # noqa: E402
from tasks import TASKS, TaskResult  # noqa: E402

TOL = 1e-3


def close(a: tuple[float, ...], b: tuple[float, ...], tol: float = TOL) -> bool:
    return all(abs(x - y) <= tol for x, y in zip(a, b, strict=True))


def check(result: TaskResult) -> list[dict[str, Any]]:
    rows = []
    for e in result.expectations:
        info = e.body.info()
        bbox_min = tuple(info["bbox"]["min"])
        bbox_max = tuple(info["bbox"]["max"])
        volume = float(info["volume"])
        rows.append({
            "body": info["name"],
            "bodyId": e.body.id,
            "valid": bool(info["valid"]),
            "bboxMin": bbox_min,
            "bboxMax": bbox_max,
            "bboxOk": close(bbox_min, e.bbox_min) and close(bbox_max, e.bbox_max),
            "volume": round(volume, 3),
            "expectedVolume": round(e.volume, 3),
            "volumeOk": abs(volume - e.volume) <= e.volume_tolerance * e.volume,
            "faces": info["faceCount"],
        })
    return rows


def load_test(hcasm: Path, expected: list[dict[str, Any]], edit: tuple[str, str, float, tuple[float, float, float]] | None) -> dict[str, Any]:
    """Reopens the saved project in a fresh headless process and edits it."""
    with AssemblerClient.headless() as client:
        opened = client.open_project(hcasm)
        bodies = {b["id"]: b for b in opened["bodies"]}
        reopened_ok = not opened["errors"] and all(
            b["bodyId"] in bodies and bodies[b["bodyId"]]["valid"] and abs(bodies[b["bodyId"]]["volume"] - b["volume"]) <= 1e-3
            for b in expected
        )
        out: dict[str, Any] = {"reopened": reopened_ok, "features": len(client.features())}
        if edit is not None:
            feature_id, dimension, value, size = edit
            try:
                edited = client.set_dimension(feature_id, dimension, value=value)
                body = next(b for b in edited["bodies"] if b["id"] == expected[0]["bodyId"])
                out["editOk"] = not edited["errors"] and body["valid"] and close(tuple(body["bbox"]["size"]), size)
                out["editErrors"] = edited["errors"]
                out["undoOk"] = client.undo()["featureCount"] == out["features"]
            except AssemblerError as error:
                out["editOk"] = False
                out["editErrors"] = {"_": str(error)}
        return out


def run(name: str, out_dir: Path) -> dict[str, Any]:
    record: dict[str, Any] = {"task": name}
    started = time.perf_counter()
    try:
        with Document.headless(name=name) as doc:
            result = TASKS[name](doc)
            record["modelSeconds"] = round(time.perf_counter() - started, 2)
            record["commands"] = doc.commands
            record["commandCount"] = len(doc.commands)
            record["queryCount"] = len(doc.log) - len(doc.commands)
            record["errors"] = doc.errors()
            record["bodies"] = check(result)
            record["notes"] = result.notes
            out_dir.mkdir(parents=True, exist_ok=True)
            three_mf = doc.export_3mf(out_dir / f"{name}.3mf")
            stl = doc.export_stl(out_dir / f"{name}.stl")
            hcasm = doc.save(out_dir / f"{name}.hcasm")
            record["exports"] = {"3mf": three_mf.stat().st_size, "stl": stl.stat().st_size, "hcasm": hcasm.stat().st_size}
        record["load"] = load_test(hcasm, record["bodies"], result.edit)
        record["ok"] = (
            not record["errors"]
            and all(b["valid"] and b["bboxOk"] and b["volumeOk"] for b in record["bodies"])
            and record["load"]["reopened"]
            and record["load"].get("editOk", True)
        )
    except Exception as error:  # noqa: BLE001 - the benchmark records failures instead of stopping
        record["ok"] = False
        record["failure"] = f"{type(error).__name__}: {error}"
        record["traceback"] = traceback.format_exc()
    record["totalSeconds"] = round(time.perf_counter() - started, 2)
    return record


def table(records: list[dict[str, Any]]) -> str:
    lines = [
        "| Task | Commands (queries) | Valid | BBox | Volume mm³ (expected) | 3MF / STL bytes | Reopen | Edit + undo | Time s |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in records:
        if "bodies" not in r:
            lines.append(f"| {r['task']} | – | – | – | – | – | – | – | {r['totalSeconds']} (failed: {r.get('failure')}) |")
            continue
        bodies = r["bodies"]
        volume = "; ".join(f"{b['volume']:.1f} ({b['expectedVolume']:.1f})" for b in bodies)
        load = r.get("load", {})
        lines.append(
            f"| {r['task']} | {r['commandCount']} ({r['queryCount']}) | {'yes' if all(b['valid'] for b in bodies) else 'NO'} "
            f"| {'ok' if all(b['bboxOk'] for b in bodies) else 'MISMATCH'} | {volume} "
            f"| {r['exports']['3mf']} / {r['exports']['stl']} | {'yes' if load.get('reopened') else 'NO'} "
            f"| {'yes' if load.get('editOk') and load.get('undoOk') else 'NO'} | {r['totalSeconds']} |"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("D:/AgentWork/HimmelCAD-Asm-agentapi/bench"))
    parser.add_argument("tasks", nargs="*", default=list(TASKS))
    args = parser.parse_args()
    records = [run(name, args.out) for name in args.tasks]
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(table(records))
    for r in records:
        if not r["ok"]:
            print(f"\n{r['task']} FAILED: {r.get('failure', '')}\n{json.dumps({k: r.get(k) for k in ('errors', 'bodies', 'load')}, indent=1)}\n{r.get('traceback', '')}")
    return 0 if all(r["ok"] for r in records) else 1


if __name__ == "__main__":
    raise SystemExit(main())
