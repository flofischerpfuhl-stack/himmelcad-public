"""Python helpers of the Block 8 modelling parity: taper, helical revolve, scale, translate, primitives, move edge/face."""
from __future__ import annotations

import math
import shutil
import sys
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
HEADLESS = REPOSITORY_ROOT / "apps/assembler/dist/headless/headless/cli.js"

sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad.assembler import AssemblerClient, Body, Document, Edge, Face, StdioTransport  # noqa: E402


class RecordingTransport:
    """Answers every feature.create with a fresh id; records the requests."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.next_id = 1

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        self.requests.append((method, dict(params)))
        if method == "api.hello":
            return {"api": "hcasm.agent-api", "version": 1}
        if method == "feature.create":
            feature_id = f"feature-{params['kind']}-{self.next_id}"
            self.next_id += 1
            return {"featureId": feature_id, "kind": params["kind"], "name": feature_id, "bodies": [{"id": "body:x"}]}
        return {}

    def close(self) -> None:
        pass


class HelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = RecordingTransport()
        self.doc = Document(AssemblerClient(self.transport))

    def request(self, index: int = -1) -> dict[str, Any]:
        return self.transport.requests[index][1]

    def params(self, index: int = -1) -> dict[str, Any]:
        return self.request(index)["params"]

    def test_taper_and_helix_are_fields_of_their_feature(self) -> None:
        s = self.doc.sketch("XY")
        s.rect(10, 10)
        self.doc.extrude(s, 10, taper=5)
        self.assertEqual(self.params()["taper"], 5)
        self.doc.revolve(s, "Z", pitch=4, height=20, left_handed=True)
        self.assertEqual(self.params()["helix"], {"pitch": 4, "turns": 5.0, "leftHanded": True})
        with self.assertRaises(ValueError):
            self.doc.revolve(s, "Z", pitch=4)
        with self.assertRaises(ValueError):
            self.doc.revolve(s, "Z", turns=3)

    def test_scale_translate_and_primitives(self) -> None:
        a = Body(self.doc, "body:a")
        self.doc.scale(a, 1.02, copy=True)
        self.assertEqual(self.params(), {"bodyIds": ["body:a"], "center": [0.0, 0.0, 0.0], "copy": True, "factor": 1.02})
        self.doc.scale([a], (1, 1, 0.5), center=(1, 2, 3))
        self.assertEqual(self.params()["factors"], [1.0, 1.0, 0.5])
        self.doc.translate(a, (0, 0, 0), (5, 0, 0), copy=True)
        self.assertEqual(self.params(), {"bodyIds": ["body:a"], "from": [0.0, 0.0, 0.0], "to": [5.0, 0.0, 0.0], "copy": True})
        box = self.doc.box(10, 20, 30, center=(1, 2, 0))
        self.assertEqual(self.request()["kind"], "primitive")
        self.assertEqual(self.params()["shape"], "box")
        self.assertTrue(box.id.startswith("body:feature-primitive-"), box.id)
        top = Face("body:a", "a:end:0", "top", "plane", (0, 0, 1), (0, 0, 10), 100.0)
        self.doc.cylinder(3, 5, plane=top, op="cut")
        self.assertEqual(self.params()["plane"], {"kind": "face", "face": top.ref})
        self.assertEqual(self.params()["targetBodyId"], "body:a")
        self.doc.cone(5, 10, top_radius=2)
        self.assertEqual(self.params()["radius2"], 2)
        self.doc.torus(10, 2, plane=("XZ", 5))
        self.assertEqual(self.params()["plane"], {"kind": "plane", "plane": "XZ", "offset": 5.0})

    def test_move_edge_and_face(self) -> None:
        edge = Edge("body:a", "a|b", "", "line", (5, 0, 10), 10, (1, 0, 0), None)
        self.doc.move_edge(edge, (0, 0, 5))
        self.assertEqual(self.request()["kind"], "moveEdge")
        self.assertEqual(self.params(), {"edge": edge.ref, "vector": [0.0, 0.0, 5.0]})
        top = Face("body:a", "a:end:0", "top", "plane", (0, 0, 1), (0, 0, 10), 100.0)
        self.doc.move_face(top, (4, 0, 2))
        self.assertEqual(self.params(), {"face": top.ref, "vector": [4.0, 0.0, 2.0]})
        self.doc.move_face(top, turn=15, turn_axis=(1, 0, 0))
        self.assertEqual(self.params()["rotation"], {"point": [0.0, 0.0, 10.0], "axis": [1.0, 0.0, 0.0], "angle": 15.0})
        with self.assertRaises(ValueError):
            self.doc.move_face(top, turn=15)

    def test_pattern_grid_and_uniform_circle(self) -> None:
        a = Body(self.doc, "body:a")
        self.doc.pattern_linear(a, "X", 3, 20, total=True, direction2="Y", count2=2, spacing2=8)
        self.assertEqual(
            self.params()["pattern"],
            {"kind": "linear", "direction": {"kind": "world", "axis": "X"}, "count": 3, "spacing": 20, "spacingMode": "total", "second": {"direction": {"kind": "world", "axis": "Y"}, "count": 2, "spacing": 8}},
        )
        self.doc.pattern_circular([a], "Z", 4, 45, between=True, uniform=True)
        self.assertEqual(self.params()["pattern"]["angleMode"], "spacing")
        self.assertTrue(self.params()["pattern"]["uniform"])


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessBlock8Tests(unittest.TestCase):
    def test_spring_taper_and_fit_test_copy(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            profile = doc.sketch("XZ")
            profile.circle(1, center=(10, 0))
            spring = doc.revolve(profile, "Z", pitch=5, turns=2)
            self.assertAlmostEqual(spring.volume, math.pi * 2 * math.pi * 10 * 2, delta=2)
            s = doc.sketch("XY")
            s.rect_corner(30, 0, 20, 20)
            block = doc.extrude(s, 10, taper=10)
            top = 20 - 2 * 10 * math.tan(math.radians(10))
            self.assertAlmostEqual(block.volume, 10 / 3 * (400 + top * top + 20 * top), delta=0.05)
            doc.scale(block, 1.02, center=block.bbox.center, copy=True)
            self.assertEqual(len(doc.bodies()), 3)
            self.assertEqual(doc.errors(), {})

    def test_primitives_translate_and_move_edge(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            cube = doc.box(10, 10, 10, center=(5, 5, 0))
            self.assertAlmostEqual(cube.volume, 1000, places=6)
            edge = cube.edges().lines().filter(lambda e: abs(e.midpoint[1]) < 1e-6 and abs(e.midpoint[2] - 10) < 1e-6).one()
            doc.move_edge(edge, (0, 0, 5))
            self.assertAlmostEqual(cube.volume, 1250, places=3)
            ball = doc.sphere(5, center=(40, 0, 0))
            doc.translate(ball, (40, 0, 5), (40, 0, 25))
            self.assertAlmostEqual(ball.bbox.min[2], 20, places=3)
            doc.move_face(cube.face("<X"), (-2, 0, 0))
            self.assertAlmostEqual(cube.bbox.min[0], -2, places=6)
            self.assertEqual(doc.errors(), {})

    def test_split_by_profile_keeps_the_original(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            block = doc.box(20, 20, 10, center=(10, 10, 0))
            cutter = doc.sketch("XY", 30)
            cutter.circle(4, center=(10, 10))
            doc.split(block, profile=cutter, keep=True)
            self.assertEqual(len(doc.bodies()), 3)
            self.assertAlmostEqual(block.volume, 4000, places=6)
            self.assertEqual(doc.errors(), {})


if __name__ == "__main__":
    unittest.main()
