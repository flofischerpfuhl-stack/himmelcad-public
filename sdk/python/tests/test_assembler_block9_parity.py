"""Python helpers of the Block 9 parity: Replace Face."""
from __future__ import annotations

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
        if method == "body.copyUnlinked":
            return {"featureId": "feature-importStep-9", "bodyId": "body:feature-importStep-9"}
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

    def test_replace_face(self) -> None:
        top = Face("body:a", "a:end:0", "top", "plane", (0, 0, 1), (0, 0, 10), 100.0)
        other = Face("body:b", "b:end:0", "top", "plane", (0, 0, 1), (20, 0, 16), 100.0)
        self.doc.replace_face(top, other)
        self.assertEqual(self.request()["kind"], "replaceFace")
        self.assertEqual(self.params(), {"faces": [top.ref], "target": other.ref})
        self.doc.replace_face([top], other, name="Flush")
        self.assertEqual(self.request()["name"], "Flush")

    def test_align_planes_axes_and_datums(self) -> None:
        top = Face("body:a", "a:end:0", "top", "plane", (0, 0, 1), (0, 0, 10), 100.0)
        other = Face("body:b", "b:end:0", "top", "plane", (0, 0, 1), (20, 0, 16), 100.0)
        self.doc.align(top, other, offset=1)
        self.assertEqual(self.params(), {"bodyId": "body:a", "flip": False, "center": True, "offset": 1, "face": top.ref, "target": other.ref})
        rim = Edge("body:a", "a|b", "", "circle", (2, 0, 0), 12.5, None, 2.0)
        wall = Face("body:b", "b:side:0", "side", "cylinder", None, (5, 0, 10), 600.0)
        self.doc.align(rim, wall, flip=True)
        self.assertEqual(self.params()["from"], {"kind": "axis", "axis": {"kind": "edge", "edge": rim.ref}})
        self.assertEqual(self.params()["to"], {"kind": "face", "face": wall.ref})
        self.assertTrue(self.params()["flip"])
        self.doc.align(rim, "Z", center=False, turn=30)
        self.assertEqual(self.params()["to"], {"kind": "axis", "axis": {"kind": "world", "axis": "Z"}})
        self.assertEqual(self.params()["turn"], 30)

    def test_split_several_bodies(self) -> None:
        a, b = Body(self.doc, "body:a"), Body(self.doc, "body:b")
        self.doc.split([a, b], ("XY", 4))
        self.assertEqual(self.params()["bodyId"], "body:a")
        self.assertEqual(self.params()["bodyIds"], ["body:b"])
        self.doc.split(a)
        self.assertNotIn("bodyIds", self.params())

    def test_pattern_three_directions(self) -> None:
        a = Body(self.doc, "body:a")
        self.doc.pattern_linear(a, "X", 3, 10, direction2="Y", count2=2, direction3="Z", count3=2, spacing3=8)
        self.assertEqual(self.params()["pattern"]["third"], {"direction": {"kind": "world", "axis": "Z"}, "count": 2, "spacing": 8})
        with self.assertRaises(ValueError):
            self.doc.pattern_linear(a, "X", 3, 10, direction3="Z")
        s = self.doc.sketch("XY")
        s.rect(4, 4)
        self.doc.pattern_circular([], "Z", 4, sketches=s)
        self.assertEqual(self.params()["bodyIds"], [])
        self.assertEqual(self.params()["sketchIds"], [s.id])

    def test_copy_unlinked(self) -> None:
        copy = self.doc.copy_unlinked(Body(self.doc, "body:a"), 20, rz=90, pivot=(0, 0, 0))
        self.assertEqual(self.transport.requests[-1][0], "body.copyUnlinked")
        self.assertEqual(self.request(), {"bodyId": "body:a", "dx": 20, "dy": 0.0, "dz": 0.0, "rx": 0.0, "ry": 0.0, "rz": 90, "pivot": [0.0, 0.0, 0.0]})
        self.assertEqual(copy.id, "body:feature-importStep-9")


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessBlock9Tests(unittest.TestCase):
    def test_replace_face_makes_a_top_flush(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            low = doc.box(10, 10, 10, center=(5, 5, 0))
            high = doc.box(10, 10, 16, center=(25, 5, 0))
            doc.replace_face(low.face(">Z"), high.face(">Z"))
            self.assertAlmostEqual(low.volume, 1600, places=3)
            self.assertAlmostEqual(low.bbox.max[2], 16, places=6)
            self.assertEqual(doc.errors(), {})

    def test_align_pin_coaxial_with_a_post(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            pin = doc.cylinder(2, 10, center=(30, 10, 0))
            post = doc.cylinder(5, 20)
            rim = pin.edges().circles().filter(lambda e: abs(e.midpoint[2]) < 1e-6).one()
            top = post.edges().circles().filter(lambda e: abs(e.midpoint[2] - 20) < 1e-6).one()
            doc.align(rim, top)
            self.assertAlmostEqual(pin.bbox.min[2], 20, places=6)
            self.assertAlmostEqual((pin.bbox.min[0] + pin.bbox.max[0]) / 2, 0, places=6)
            self.assertEqual(doc.errors(), {})

    def test_unlinked_copy_keeps_its_geometry(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect(10, 10)
            block = doc.extrude(s, 10)
            copy = doc.copy_unlinked(block, 30)
            self.assertAlmostEqual(copy.volume, 1000, places=3)
            self.assertAlmostEqual(copy.bbox.min[0], 25, places=6)
            self.assertEqual(doc.errors(), {})


if __name__ == "__main__":
    unittest.main()
