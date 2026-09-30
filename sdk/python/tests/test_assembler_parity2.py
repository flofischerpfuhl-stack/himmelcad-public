"""Python helpers of the Shapr3D parity round 2: construction planes/axes, extrude extents, mirror targets."""
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

from himmelcad.assembler import AssemblerClient, Datum, Document, Edge, Face, StdioTransport  # noqa: E402


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
        if method == "datums.list":
            return [{"featureId": "feature-constructionPlane-1", "kind": "plane"}]
        return {}

    def close(self) -> None:
        pass


class HelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = RecordingTransport()
        self.doc = Document(AssemblerClient(self.transport))

    def params(self, index: int = -1) -> dict[str, Any]:
        return self.transport.requests[index][1]["params"]

    def test_construction_helpers_are_one_canonical_command_each(self) -> None:
        top = Face("body:b", "f:end:0", "top", "plane", (0, 0, 1), (0, 0, 6), 100.0)
        plane = self.doc.plane_offset(top, 5)
        self.assertIsInstance(plane, Datum)
        self.assertEqual(self.params(), {"definition": {"kind": "offset", "base": {"kind": "face", "face": top.ref}, "distance": 5}})
        self.doc.midplane(("XY", 0), ("XY", 10), flip=True)
        self.assertEqual(self.params()["flip"], True)
        self.assertEqual(self.params()["definition"]["a"], {"kind": "plane", "plane": "XY", "offset": 0.0})
        edge = Edge("body:b", "a|b", "", "circle", (0, 0, 0), 10, None, 3)
        self.doc.plane_through((0, 0, 0), edge, (1, 0, 0))
        self.assertEqual(self.params()["definition"]["points"][1], {"kind": "circleCenter", "edge": edge.ref})
        axis = self.doc.axis_intersection("XZ", "YZ")
        self.assertEqual(axis.ref, {"kind": "construction", "featureId": axis.id})
        self.doc.plane_angle("XY", axis, 30)
        self.assertEqual(self.params()["definition"]["axis"], axis.ref)
        sketch = self.doc.sketch(plane)
        sketch.rect(4, 4)
        self.assertEqual(self.params()["plane"], plane.ref)
        self.assertEqual(plane.info()["kind"], "plane")

    def test_extrude_extents_and_mirror_targets(self) -> None:
        s = self.doc.sketch("XY")
        s.rect(10, 10)
        self.doc.extrude(s, -1, op="cut", through_all=True, start_offset=2)
        p = self.params()
        self.assertEqual(p["extent"], {"kind": "throughAll"})
        self.assertEqual(p["startOffset"], 2)
        top = Face("body:b", "f:end:0", "top", "plane", (0, 0, 1), (0, 0, 6), 100.0)
        self.doc.extrude(s, 1, to=top, op="intersect", distance2=3)
        p = self.params()
        self.assertEqual(p["extent"], {"kind": "toObject", "target": {"kind": "face", "face": top.ref}})
        self.assertEqual((p["operation"], p["distance2"]), ("intersect", 3))
        result = self.doc.mirror(sketches=[s], plane="YZ", axis="Z")
        self.assertEqual(self.params()["sketchIds"], [s.id])
        self.assertEqual(self.params()["axis"], {"kind": "world", "axis": "Z"})
        self.assertEqual(result.sketches[0].id, f"{result.feature.id}:sketch:0")
        with self.assertRaises(ValueError):
            self.doc.extrude(s, 1, through_all=True, to=top)


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessParityTests(unittest.TestCase):
    def test_plane_sketch_through_all_and_mirrored_profile(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect_corner(0, 0, 20, 20)
            block = doc.extrude(s, 10)
            plane = doc.plane_offset(block.face(">Z"), 20)
            self.assertEqual(plane.info()["kind"], "plane")
            hole = doc.sketch(plane)
            hole.circle(3, center=(10, 10))
            doc.extrude(hole, -1, op="cut", target=block, through_all=True)
            self.assertAlmostEqual(block.volume, 4000 - math.pi * 9 * 10, places=3)
            mirrored = doc.mirror(sketches=[s], plane="YZ")
            copy = doc.extrude(mirrored.sketches[0], 5)
            self.assertEqual(copy.bbox.size, (20.0, 20.0, 5.0))
            self.assertLess(copy.bbox.max[0], 1e-9)
            axis = doc.axis_intersection("XZ", "YZ")
            self.assertEqual(len(doc.datums()), 2)
            self.assertEqual(axis.info()["kind"], "axis")
            self.assertEqual(doc.errors(), {})


if __name__ == "__main__":
    unittest.main()
