"""Python helpers of Block 9 parameters: ranges (min/max/step), NULL, and parameters.sweep."""
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

from himmelcad.assembler import NULL, AssemblerClient, Document, InvalidParamsError, StdioTransport  # noqa: E402


class RecordingTransport:
    """Answers parameter calls with the parameter as sent; records the requests."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        self.requests.append((method, dict(params)))
        if method == "api.hello":
            return {"api": "hcasm.agent-api", "version": 1}
        if method == "parameters.list":
            return [{"id": "p1", "name": "wall", "unit": "mm", "value": 2}]
        if method in ("parameter.create", "parameter.edit"):
            return {"parameter": {"id": "p1", "name": "wall", "unit": "mm", "value": 2, "min": 1, "max": 4}}
        return {"samples": [], "passed": 0, "failed": 0, "total": 0}

    def close(self) -> None:
        pass


class HelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = RecordingTransport()
        self.doc = Document(AssemblerClient(self.transport))

    def last(self) -> tuple[str, dict[str, Any]]:
        return self.transport.requests[-1]

    def test_range_fields_and_null(self) -> None:
        wall = self.doc.param("wall", 2, min=1, max="height / 4", step=0.2)
        method, params = self.last()
        self.assertEqual(method, "parameter.edit")
        self.assertEqual((params["min"], params["max"], params["step"]), (1, "height / 4", 0.2))
        self.assertEqual((wall.min, wall.max, wall.step), (1.0, 4.0, None))
        wall.set_range(max=NULL)
        _, params = self.last()
        self.assertIn("max", params)
        self.assertIsNone(params["max"], "NULL sends an explicit null")
        self.assertNotIn("min", params, "None leaves a bound out")
        self.assertEqual(repr(NULL), "NULL")

    def test_sweep_payload(self) -> None:
        self.doc.sweep("wall", {"parameterId": "height", "min": 10, "max": 20}, mode="samples", samples=3, combine="all")
        method, params = self.last()
        self.assertEqual(method, "parameters.sweep")
        self.assertEqual(params["parameters"], [{"parameterId": "wall"}, {"parameterId": "height", "min": 10, "max": 20}])
        self.assertEqual((params["mode"], params["samples"], params["combine"]), ("samples", 3, "all"))
        self.assertNotIn("parameters.sweep", self.doc.commands, "a sweep is a query")


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessBlock9Tests(unittest.TestCase):
    def test_range_refusal_and_sweep(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            h = doc.param("h", 10, min=2, max=30)
            r = doc.param("r", 2, min=0.5, max=12, step=0.5)
            s = doc.sketch("XY")
            s.rect(40, 30)
            plate = doc.extrude(s, expression="h")
            top = plate.edges().lines().filter(lambda e: abs(e.midpoint[2] - 10) < 1e-6 and e.direction is not None and abs(e.direction[0]) > 0.99).sorted_by("Y")[0]
            doc.fillet(top, expression="r")
            self.assertEqual(doc.errors(), {})
            with self.assertRaises(InvalidParamsError) as caught:
                h.set(40)
            self.assertEqual(caught.exception.details["outOfRange"]["name"], "h")
            self.assertEqual(doc.param("h").value, 10, "nothing changed, nothing clamped")

            report = r.sweep()
            values = [(s["values"]["r"], s["ok"]) for s in report["samples"]]
            self.assertEqual(values, [(2, True), (0.5, True), (12, False)])
            failing = report["samples"][2]
            self.assertEqual(failing["outcome"], "rebuilt")
            self.assertTrue(failing["errors"][0]["featureName"].startswith("Fillet"))
            self.assertIsNone(failing["checks"], "no checks module: null")
            grid = doc.sweep(h, r, mode="samples", samples=2, combine="all")
            self.assertEqual(grid["total"], 4)
            self.assertEqual(doc.param("r").value, 2, "a sweep never changes the document")


if __name__ == "__main__":
    unittest.main()
