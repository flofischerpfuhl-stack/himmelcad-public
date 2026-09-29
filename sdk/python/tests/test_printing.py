"""Tests of the print-part helpers (``himmelcad.assembler.printing``): one command per call with the
canonical params, the metric table in sync with the app's, and (with a built headless server)
hand-calculated volumes on the real kernel."""
from __future__ import annotations

import math
import re
import shutil
import sys
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
HEADLESS = REPOSITORY_ROOT / "apps/assembler/dist/headless/headless/cli.js"
PRINT_FEATURES_TS = REPOSITORY_ROOT / "apps/assembler/renderer/src/model/printFeatures.ts"

sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad.assembler import (  # noqa: E402
    METRIC_HOLE_SIZES,
    AssemblerClient,
    Document,
    Face,
    SketchLine,
    StdioTransport,
    hole_diameter,
)
from himmelcad.assembler.modeling import Body  # noqa: E402


class Recorder:
    """Transport stub: records requests, answers feature.create/feature.get."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        self.requests.append((method, dict(params)))
        if method == "api.hello":
            return {"api": "hcasm.agent-api", "version": 1}
        if method == "feature.create":
            return {"featureId": f"feature-{params['kind']}-1", "kind": params["kind"], "name": params["kind"]}
        if method == "feature.get":
            return {"params": {"entities": [
                {"id": "p1", "kind": "point", "x": 0, "y": 0},
                {"id": "c1", "kind": "circle", "center": "p1", "radius": 1},
                {"id": "p2", "kind": "point", "x": 5, "y": 5},
                {"id": "p3", "kind": "point", "x": 9, "y": 9},
                {"id": "p4", "kind": "point", "x": 9, "y": 0},
                {"id": "l1", "kind": "line", "a": "p3", "b": "p4"},
            ]}}
        return {}

    def close(self) -> None:
        return None

    def last(self, method: str = "feature.create") -> dict[str, Any]:
        return [p for m, p in self.requests if m == method][-1]


TOP = Face("body:b", "b:end:0", "Top", "plane", (0.0, 0.0, 1.0), (0.0, 0.0, 5.0), 100.0)


class PrintHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rec = Recorder()
        self.doc = Document(AssemblerClient(self.rec))

    def test_metric_table_matches_the_app(self) -> None:
        text = PRINT_FEATURES_TS.read_text(encoding="utf-8")
        rows = re.findall(r"thread: '(M[\d.]+)',\s*clearanceFine: ([\d.]+),\s*clearanceNormal: ([\d.]+),\s*clearanceCoarse: ([\d.]+),\s*tapDrill: ([\d.]+),\s*counterboreDiameter: ([\d.]+),\s*counterboreDepth: ([\d.]+),\s*countersinkDiameter: ([\d.]+)", text)
        self.assertEqual(len(rows), 8)
        for thread, *values in rows:
            self.assertEqual(METRIC_HOLE_SIZES[thread], tuple(float(v) for v in values), thread)

    def test_hole_diameters(self) -> None:
        self.assertEqual(hole_diameter("M3"), 3.4)
        self.assertEqual(hole_diameter("M3", "tap"), 2.5)
        self.assertEqual(hole_diameter("M4", "clearance"), 4.2)
        with self.assertRaises(ValueError):
            hole_diameter("M7")

    def test_hole_is_one_command_with_counterbore_and_sketch_points(self) -> None:
        sketch = self.doc.sketch("XY")
        sketch.feature = type("F", (), {"id": "feature-sketch-9"})()  # type: ignore[assignment]
        self.doc.hole(TOP, [(10, 5)], sketch=sketch, size="M3", counterbore=True, thread=True)
        params = self.rec.last()
        self.assertEqual(params["kind"], "hole")
        p = params["params"]
        self.assertEqual(p["diameter"], 3.4)
        self.assertEqual((p["holeType"], p["counterboreDiameter"], p["counterboreDepth"]), ("counterbore", 6.5, 3.4))
        self.assertEqual(p["extent"], {"kind": "through"})
        self.assertEqual(p["thread"], "M3")
        entities = [pl.get("entityId") for pl in p["placements"]]
        self.assertEqual(entities, [None, "c1", "p2"], "circle centre and free point; line vertices skipped")
        creates = [m for m, _ in self.rec.requests if m == "feature.create"]
        self.assertEqual(len(creates), 1)

    def test_variants_send_canonical_params(self) -> None:
        body = Body(self.doc, "body:b")
        self.doc.fillet_by_rule(body, 1, rule="convex")
        self.assertEqual(self.rec.last()["params"], {"edges": [], "radius": 1, "rules": [{"kind": "convex", "bodyId": "body:b"}]})
        self.doc.fillet_by_rule(TOP, 0.5)
        self.assertEqual(self.rec.last()["params"]["rules"][0]["kind"], "faceEdges")
        self.doc.shell_walls(TOP, 1.2, outward=True, walls={TOP: 2})
        self.assertEqual(self.rec.last()["params"]["direction"], "outside")
        self.doc.boolean("subtract", body, Body(self.doc, "body:t"), keep_tools=True)
        self.assertEqual(self.rec.last()["params"]["keepTools"], True)
        self.doc.draft(TOP, 3, neutral="XY")
        self.assertEqual(self.rec.last()["params"]["neutral"], {"kind": "plane", "plane": "XY", "offset": 0.0})
        self.doc.rib([SketchLine("s", "l1")], 2)
        self.assertEqual(self.rec.last()["params"]["entityIds"], ["l1"])
        with self.assertRaises(ValueError):
            self.doc.rib([SketchLine("s", "l1"), SketchLine("t", "l2")], 2)


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class PrintHeadlessTests(unittest.TestCase):
    def test_bracket_with_screw_holes_gusset_and_label(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect_corner(0, 0, 40, 30)
            plate = doc.extrude(s, 5)
            doc.hole(plate.face(">Z"), [(10, 10), (30, 10)], size="M3", counterbore=True)
            cb = 2 * (math.pi * 1.7**2 * 5 + math.pi * (3.25**2 - 1.7**2) * 3.4)
            self.assertAlmostEqual(plate.volume, 6000 - cb, places=3)
            up = doc.sketch("XY", 5)
            up.rect_corner(0, 25, 40, 5)
            doc.join(up, 20, target=plate)
            rib = doc.sketch("YZ", 20)
            line = rib.line((25, 20), (10, 5))
            before = plate.volume
            doc.rib(line, 2, target=plate)
            self.assertAlmostEqual(plate.volume, before + 0.5 * 15 * 15 * 2, places=3)
            doc.fillet_by_rule(plate, 1, rule="concave")
            self.assertTrue(plate.valid)
            self.assertEqual(doc.errors(), {})


if __name__ == "__main__":
    unittest.main()
