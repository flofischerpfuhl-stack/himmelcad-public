"""Python mirror of view renders and skills: ``doc.render``, ``doc.inspect``, ``doc.skills``, ``doc.skill``."""
from __future__ import annotations

import base64
import shutil
import sys
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
HEADLESS = REPOSITORY_ROOT / "apps/assembler/dist/headless/headless/cli.js"

sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad.assembler import AssemblerClient, Document, Inspection, Render, StdioTransport  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


class FakeTransport:
    """Answers the view and skill methods; records the requests."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        self.requests.append((method, dict(params)))
        data = base64.b64encode(PNG).decode("ascii")
        if method == "api.hello":
            return {"api": "hcasm.agent-api", "version": 1}
        if method == "view.render":
            return {"mediaType": "image/png", "data": data, "width": 64, "height": 48, "renderer": "software", "view": {"name": "iso"}, "findings": {"count": 0}}
        if method == "view.inspect":
            return {"images": [{"view": {"name": "top"}, "data": data, "width": 32, "height": 32}], "manifest": {"bodies": []}}
        if method == "skills.list":
            return {"skills": [{"id": "a"}], "total": 2, "nextCursor": 1} if not params.get("cursor") else {"skills": [{"id": "b"}], "total": 2, "nextCursor": None}
        if method == "skills.read":
            return {"text": "x" * 3, "nextOffset": 3} if not params.get("offset") else {"text": "y", "nextOffset": None}
        return {}

    def close(self) -> None:
        pass


class ViewHelperTests(unittest.TestCase):
    def test_render_and_inspect_map_to_one_call_each(self) -> None:
        transport = FakeTransport()
        doc = Document(AssemblerClient(transport))
        with tempfile.TemporaryDirectory() as directory:
            shot = doc.render({"azimuth": -60, "elevation": 20}, displayMode="xray", path=Path(directory) / "a.png")
            self.assertIsInstance(shot, Render)
            self.assertEqual(shot.png, PNG)
            self.assertEqual((Path(directory) / "a.png").read_bytes(), PNG)
            bundle = doc.inspect(["top"], overlay=["printFindings"])
            self.assertIsInstance(bundle, Inspection)
            paths = bundle.save(Path(directory) / "part")
            self.assertEqual(paths[0].name, "part-top.png")
        method, params = transport.requests[1]
        self.assertEqual(method, "view.render")
        self.assertEqual(params, {"view": {"azimuth": -60, "elevation": 20}, "displayMode": "xray"})
        self.assertEqual(transport.requests[2], ("view.inspect", {"views": ["top"], "overlay": ["printFindings"]}))

    def test_skills_read_every_page(self) -> None:
        doc = Document(AssemblerClient(FakeTransport()))
        self.assertEqual([s["id"] for s in doc.skills()], ["a", "b"])
        self.assertEqual(doc.skill("a"), "xxxy")


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessViewTests(unittest.TestCase):
    def test_render_inspect_and_skills_against_the_headless_app(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect(40, 20)
            plate = doc.extrude(s, 5)
            shot = doc.render("front", width=160, height=120, highlight={"bodyIds": [plate.id]})
            self.assertTrue(shot.png.startswith(b"\x89PNG"))
            self.assertEqual((shot.width, shot.height, shot.renderer), (160, 120, "software"))
            bundle = doc.inspect(size=96)
            self.assertEqual(len(bundle.renders), 4)
            self.assertEqual(bundle.manifest["bodies"][0]["bbox"]["size"], [40, 20, 5])
            self.assertIn("printable-part", [s["id"] for s in doc.skills()])
            self.assertIn("acceptance rules", doc.skill("printable-part"))


if __name__ == "__main__":
    unittest.main()
