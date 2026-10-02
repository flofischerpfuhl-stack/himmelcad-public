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

from himmelcad.assembler import AssemblerClient, Document, Face, StdioTransport  # noqa: E402


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

    def test_replace_face(self) -> None:
        top = Face("body:a", "a:end:0", "top", "plane", (0, 0, 1), (0, 0, 10), 100.0)
        other = Face("body:b", "b:end:0", "top", "plane", (0, 0, 1), (20, 0, 16), 100.0)
        self.doc.replace_face(top, other)
        self.assertEqual(self.request()["kind"], "replaceFace")
        self.assertEqual(self.params(), {"faces": [top.ref], "target": other.ref})
        self.doc.replace_face([top], other, name="Flush")
        self.assertEqual(self.request()["name"], "Flush")


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


if __name__ == "__main__":
    unittest.main()
