"""Tests of the stored-checks and clearance helpers (``himmelcad.assembler.checks``): one canonical
command per call with model objects turned into ids/targets, the report accessors, and (with a built
headless server) an enclosure + lid whose clearance check fails, is fixed and passes."""
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

from himmelcad.assembler import AssemblerClient, Check, CheckReport, Document, Face, StdioTransport  # noqa: E402
from himmelcad.assembler.modeling import Body  # noqa: E402


class Recorder:
    """Transport stub: records requests, answers the checks methods."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        self.requests.append((method, dict(params)))
        if method == "api.hello":
            return {"api": "hcasm.agent-api", "version": 1}
        if method in ("checks.add", "checks.update"):
            check = {"id": "check-1", "kind": params.get("kind", "clearance"), "params": params.get("params", {}), "enabled": True, "displayName": "Clearance"}
            return {"check": check, "revision": 3, "result": {"id": "check-1", "status": "fail", "message": "overlap"}}
        if method == "checks.run":
            return {"passed": False, "summary": {"total": 2, "passed": 1, "failed": 1, "errors": 0, "disabled": 0}, "results": [
                {"id": "check-1", "name": "Lid fit", "status": "fail", "message": "overlap"},
                {"id": "check-2", "name": "Body count 2", "status": "pass", "message": "2"},
            ]}
        if method == "checks.list":
            return {"revision": 3, "checks": [{"id": "check-1", "kind": "clearance", "params": {"min": 0.3}, "enabled": True, "displayName": "Clearance all bodies ≥ 0.3 mm"}]}
        if method == "measure.clearance":
            return {"unit": "mm", "pairs": [{"a": params.get("a"), "b": params.get("b"), "relation": "clear", "distance": 0.4}], "checkedPairs": 1, "skipped": []}
        return {}

    def close(self) -> None:
        return None

    def last(self, method: str) -> dict[str, Any]:
        return [p for m, p in self.requests if m == method][-1]


TOP = Face("body:b", "b:end:0", "Top", "plane", (0.0, 0.0, 1.0), (0.0, 0.0, 5.0), 100.0)


class CheckHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rec = Recorder()
        self.doc = Document(AssemblerClient(self.rec))

    def test_add_check_sends_canonical_params(self) -> None:
        lid, base = Body(self.doc, "body:lid"), Body(self.doc, "body:base")
        check = self.doc.add_check("clearance", a=lid, b=base, min=0.3, name="Lid fit")
        self.assertIsInstance(check, Check)
        self.assertEqual(self.rec.last("checks.add"), {"kind": "clearance", "params": {"a": "body:lid", "b": "body:base", "min": 0.3}, "name": "Lid fit"})
        self.assertIs(check.passed, False)
        self.doc.add_check("distance", a=TOP, b=(0, 0, 0), min=4, max=6)
        params = self.rec.last("checks.add")["params"]
        self.assertEqual(params["a"], {"kind": "face", "face": TOP.ref})
        self.assertEqual(params["b"], {"kind": "point", "point": [0.0, 0.0, 0.0]})
        self.doc.add_check("volume", bodies=[lid], max=1000, enabled=False)
        self.assertEqual(self.rec.last("checks.add")["params"], {"bodies": ["body:lid"], "max": 1000})
        self.assertEqual(self.rec.last("checks.add")["enabled"], False)

    def test_update_remove_and_name_clearing(self) -> None:
        check = self.doc.add_check("clearance", min=0.3)
        check.update(min=0.5)
        self.assertEqual(self.rec.last("checks.update"), {"checkId": "check-1", "params": {"min": 0.5}})
        check.update(clear_name=True)
        self.assertEqual(self.rec.last("checks.update"), {"checkId": "check-1", "name": None})
        check.remove()
        self.assertEqual(self.rec.last("checks.remove"), {"checkId": "check-1"})

    def test_report_and_listing(self) -> None:
        report = self.doc.run_checks(scope="staged")
        self.assertIsInstance(report, CheckReport)
        self.assertFalse(report)
        self.assertEqual([r["id"] for r in report.failed], ["check-1"])
        self.assertEqual(report.by_name("Body count 2")["status"], "pass")
        self.assertEqual(self.rec.last("checks.run"), {"scope": "staged"})
        self.assertEqual([c.name for c in self.doc.checks()], ["Clearance all bodies ≥ 0.3 mm"])
        self.assertNotIn("checks.run", self.doc.commands)

    def test_clearance_helpers(self) -> None:
        lid, base = Body(self.doc, "body:lid"), Body(self.doc, "body:base")
        self.assertEqual(self.doc.clearance(lid, base)["distance"], 0.4)
        self.assertEqual(self.rec.last("measure.clearance"), {"a": "body:lid", "b": "body:base"})
        self.doc.clearances(below=0.5)
        self.assertEqual(self.rec.last("measure.clearance"), {"below": 0.5})


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class ChecksHeadlessTests(unittest.TestCase):
    def test_enclosure_and_lid_clearance_check_fails_then_passes(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect_corner(0, 0, 40, 30)
            base = doc.extrude(s, 20)
            doc.shell(base.face(">Z"), 2)
            lid_sketch = doc.sketch("XY", 19)
            lid_sketch.rect_corner(0, 0, 40, 30)
            lid = doc.extrude(lid_sketch, 3)
            fit = doc.add_check("clearance", a=lid, b=base, min=0.2, name="Lid fit")
            self.assertIs(fit.passed, False)
            self.assertEqual(doc.clearance(lid, base)["relation"], "overlap")
            report = doc.run_checks()
            self.assertFalse(report)
            self.assertIn("overlap", report.by_name("Lid fit")["message"])
            doc.move(lid, dz=1.4)
            report = doc.run_checks()
            self.assertTrue(report, report.failed)
            self.assertAlmostEqual(report.by_name("Lid fit")["value"], 0.4, places=6)
            self.assertEqual(len(doc.checks()), 1)


if __name__ == "__main__":
    unittest.main()
