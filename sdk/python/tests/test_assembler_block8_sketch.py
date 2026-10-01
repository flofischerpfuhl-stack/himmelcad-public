"""Python helpers of Assembler Block 8 (sketching): two-direction and editable sketch patterns, offset of
loops (splines/ellipses included), measured distance components."""
from __future__ import annotations

import json
import math
import shutil
import struct
import sys
import tempfile
import unittest
import zlib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
HEADLESS = REPOSITORY_ROOT / "apps/assembler/dist/headless/headless/cli.js"

sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad.assembler import AssemblerClient, Document, StdioTransport  # noqa: E402


def _png(width: int, height: int) -> bytes:
    """A valid one-colour PNG."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + b"\x80\x80\x80" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


class RecordingTransport:
    """Answers feature.create with a fresh id and sketch commands with canned results; records requests."""

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
            return {"featureId": feature_id, "kind": params["kind"], "name": feature_id, "shapes": [{}]}
        if method == "sketch.pattern":
            return {"patternId": "pat1", "createdIds": ["c2", "c3"]}
        if method == "sketch.editPattern":
            return {"patternId": params["patternId"], "pattern": {"id": params["patternId"]}}
        if method == "sketch.offset":
            return {"createdIds": ["s9"]}
        return {}

    def close(self) -> None:
        pass


class HelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = RecordingTransport()
        self.doc = Document(AssemblerClient(self.transport))

    def last(self) -> tuple[str, dict[str, Any]]:
        return self.transport.requests[-1]

    def test_pattern_in_two_directions_then_edited(self) -> None:
        s = self.doc.sketch("XY")
        s.circle(2)
        self.assertEqual(s.pattern(["c1"], 3, spacing=10, count2=2, spacing2=5), ["c2", "c3"])
        method, params = self.last()
        self.assertEqual(method, "sketch.pattern")
        self.assertEqual((params["count2"], params["spacing2"], params["direction2"]), (2, 5, [0.0, 1.0]))
        self.assertEqual(s.last_pattern_id, "pat1")
        s.edit_pattern(count=5)
        self.assertEqual(self.last(), ("sketch.editPattern", {"featureId": s.id, "patternId": "pat1", "count": 5}))
        s.edit_pattern("pat7", angle=90)
        self.assertEqual(self.last()[1]["angle"], 90)
        with self.assertRaises(ValueError):
            s.pattern(["c1"], 3, spacing=10, count2=2)

    def test_reference_image_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            picture = Path(folder) / "plan.png"
            picture.write_bytes(_png(4, 2))
            self.doc.client.insert_image(picture, plane={"kind": "plane", "plane": "XZ"}, width=40, opacity=0.5)
        method, params = self.last()
        self.assertEqual(method, "image.insert")
        self.assertEqual((params["fileName"], params["width"], params["opacity"]), ("plan.png", 40, 0.5))
        self.assertNotIn("rotation", params)
        self.doc.client.calibrate_image("feature-referenceImage-1", (0, 0), (10, 0), 25)
        self.assertEqual(
            self.last(),
            ("image.calibrate", {"featureId": "feature-referenceImage-1", "a": [0, 0], "b": [10, 0], "distance": 25}),
        )

    def test_offset_is_one_command(self) -> None:
        s = self.doc.sketch("XY")
        s.circle(2)
        self.assertEqual(s.offset(["e1"], 1.5, side="inside"), ["s9"])
        self.assertEqual(
            self.last(),
            ("sketch.offset", {"featureId": s.id, "ids": ["e1"], "distance": 1.5, "side": "inside", "single": False}),
        )


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessBlock8Tests(unittest.TestCase):
    def test_grid_pattern_edit_and_extrude(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.circle(2, center=(0, 0))
            sketch = next(x for x in doc.client.sketches() if x["featureId"] == s.id)
            circle = next(e["id"] for e in sketch["entities"] if e["kind"] == "circle")
            s.pattern([circle], 3, spacing=10, count2=2, spacing2=8)
            s.edit_pattern(count=4)
            sketch = next(x for x in doc.client.sketches() if x["featureId"] == s.id)
            self.assertEqual(sum(1 for e in sketch["entities"] if e["kind"] == "circle"), 8)
            self.assertEqual(sketch["patterns"][0]["count"], 4)
            body = doc.extrude(s, 3)
            self.assertAlmostEqual(body.volume, 8 * math.pi * 4 * 3, places=3)
            self.assertEqual(doc.errors(), {})

    def test_ellipse_offset_and_distance_components(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            ellipse = s.ellipse(10, 5, dimension=False)
            created = s.offset([ellipse], 1, side="outside")
            sketch = next(x for x in doc.client.sketches() if x["featureId"] == s.id)
            splines = [e for e in sketch["entities"] if e["kind"] == "spline"]
            self.assertEqual([e["id"] for e in splines if e["id"] in created], [splines[0]["id"]])
            self.assertEqual(len(sketch["regions"]), 2, "the ellipse and the ring around it")
            ring = min(sketch["regions"], key=lambda r: r["area"])  # the ellipse itself is 50π
            perimeter_approx = math.pi * (3 * 15 - math.sqrt((30 + 5) * (10 + 15)))  # Ramanujan
            self.assertAlmostEqual(ring["area"], perimeter_approx * 1 + math.pi, delta=0.05)
            a = doc.sketch("XY")
            a.rect_corner(0, 0, 10, 10)
            first = doc.extrude(a, 5)
            b = doc.sketch("XY", 10)
            b.rect_corner(30, 0, 10, 10)
            second = doc.extrude(b, 5)
            result = doc.client.measure_distance({"kind": "body", "bodyId": first.id}, {"kind": "body", "bodyId": second.id})
            self.assertEqual([round(v, 6) for v in result["delta"]], [20.0, 0.0, 5.0])

    def test_reference_image_is_saved_with_the_project(self) -> None:
        with tempfile.TemporaryDirectory() as folder, Document(AssemblerClient(StdioTransport())) as doc:
            picture = Path(folder) / "plan.png"
            picture.write_bytes(_png(40, 20))
            inserted = doc.client.insert_image(picture, center=(5, 5))
            self.assertEqual((inserted["width"], inserted["height"]), (100, 50))
            calibrated = doc.client.calibrate_image(inserted["featureId"], (0, 0), (50, 0), 25)
            self.assertAlmostEqual(calibrated["width"], 50)
            saved = json.loads(doc.client.save_project(Path(folder) / "canvas.hcasm").read_text(encoding="utf-8"))
            self.assertEqual(len(saved["images"]), 1)
            self.assertEqual(saved["features"][0]["kind"], "referenceImage")


if __name__ == "__main__":
    unittest.main()
