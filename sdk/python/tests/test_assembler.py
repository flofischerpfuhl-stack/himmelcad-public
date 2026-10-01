"""Tests of the hand-maintained ``himmelcad.assembler`` client (Assembler agent API)."""
from __future__ import annotations

import base64
import json
import shutil
import sys
import tempfile
import threading
import unittest
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
SCHEMA = REPOSITORY_ROOT / "apps/assembler/api/agent-api-v1.schema.json"
HEADLESS = REPOSITORY_ROOT / "apps/assembler/dist/headless/headless/cli.js"

sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad.assembler import (  # noqa: E402
    METHODS,
    AssemblerClient,
    ConflictError,
    Document,
    Edge,
    EdgeSet,
    FeatureFailedError,
    KernelTimeoutError,
    LoopbackTransport,
    ReferenceNotFoundError,
    SketchConflictError,
    StdioTransport,
    TransportError,
)
from himmelcad.assembler.errors import ERROR_CODES, error_from_rpc  # noqa: E402
from himmelcad.errors import HimmelcadError  # noqa: E402


class FakeTransport:
    """Records requests and answers from a script of results (or raises contract errors)."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, Mapping[str, Any]]] = []
        self.next_id = 1
        self.parameters: dict[str, dict[str, Any]] = {}
        self.next_param_id = 1

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        self.requests.append((method, dict(params)))
        if method == "api.hello":
            return {"api": "hcasm.agent-api", "version": 1}
        if method == "feature.create":
            feature_id = f"feature-{params['kind']}-{self.next_id}"
            self.next_id += 1
            return {"featureId": feature_id, "kind": params["kind"], "name": f"{params['kind']} {self.next_id}", "bodies": [{"id": "body:feature-extrude-2"}]}
        if method == "transaction.begin":
            return {"transactionId": "tx-1"}
        if method == "parameters.list":
            return list(self.parameters.values())
        if method == "parameter.create":
            param_id = f"param-{self.next_param_id}"
            self.next_param_id += 1
            record = {"id": param_id, "name": params["name"], "unit": params.get("unit") or "mm", "value": params.get("value") or 0.0}
            if params.get("expression") is not None:
                record["expression"] = params["expression"]
            self.parameters[param_id] = record
            return {"parameter": record}
        if method == "parameter.edit":
            record = dict(self.parameters[params["parameterId"]])
            for key, dest in (("name", "name"), ("unit", "unit"), ("value", "value")):
                if params.get(key) is not None:
                    record[dest] = params[key]
            if params.get("expression") is not None:
                record["expression"] = params["expression"]
            self.parameters[params["parameterId"]] = record
            return {"parameter": record}
        if method == "parameter.delete":
            del self.parameters[params["parameterId"]]
            return {"parameterId": params["parameterId"]}
        if method == "edges.list":
            return [
                {"bodyId": params["bodyId"], "key": "a|b", "name": "Line +Z", "curve": "line", "midpoint": [0, 0, 3], "length": 6, "direction": [0, 0, 1], "radius": None, "faceKeys": ["a", "b"]},
                {"bodyId": params["bodyId"], "key": "b|c", "name": "Circle", "curve": "circle", "midpoint": [5, 0, 6], "length": 31.4, "direction": None, "radius": 5, "faceKeys": ["b", "c"]},
            ]
        if method == "export.3mf":
            return {"data": base64.b64encode(b"PK\x03\x04").decode(), "byteLength": 4}
        if method == "export.stl":
            return {"data": base64.b64encode(b"solid x\nendsolid x\n").decode(), "byteLength": 19}
        if method in ("print.placeOnPlate", "print.orient"):
            return {"featureId": "feature-transform-9", "bodyId": "body:b"}
        if method == "measure.distance":
            return {"distance": 4.0, "pointA": [0, 0, 6], "pointB": [0, 0, 10], "unit": "mm", "exact": True}
        if method == "measure.angle":
            return {"angle": 90.0, "unit": "deg", "parallel": False}
        if method == "measure.area":
            return {"area": 12.5, "unit": "mm²", "faces": []}
        if method == "print.analyze":
            return {"totals": {"bodies": 1, "massG": 12.5, "cost": 0.25}, "bodies": [{"bodyId": "body:b"}], "findings": [{"kind": "overhang", "severity": "warning"}]}
        return {}

    def close(self) -> None:
        return None

    @property
    def methods(self) -> list[str]:
        return [m for m, _ in self.requests if m != "api.hello"]


class ContractTests(unittest.TestCase):
    def test_method_table_matches_the_checked_in_contract(self) -> None:
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(schema["api"], "hcasm.agent-api")
        self.assertEqual(schema["version"], 1)
        self.assertEqual(sorted(METHODS), sorted(schema["methods"]))
        self.assertEqual(sorted(ERROR_CODES), sorted(schema["errorCodes"]))

    def test_errors_are_typed_and_carry_repair_data(self) -> None:
        error = error_from_rpc({"code": -32005, "message": "no edge", "data": {"code": "referenceNotFound", "message": "no edge \"x\"", "hint": "use edges.list", "details": {"candidates": [{"key": "a|b"}]}}}, "feature.create")
        self.assertIsInstance(error, ReferenceNotFoundError)
        self.assertIsInstance(error, HimmelcadError)
        self.assertEqual(error.raw_code, "referenceNotFound")
        self.assertEqual(error.hint, "use edges.list")
        self.assertEqual(error.candidates, [{"key": "a|b"}])
        self.assertIn("hint: use edges.list", str(error))
        self.assertIsInstance(error_from_rpc({"data": {"code": "featureFailed", "message": "x"}}), FeatureFailedError)
        conflict = error_from_rpc({"data": {"code": "conflict", "message": "x"}})
        self.assertIsInstance(conflict, ConflictError)
        self.assertTrue(conflict.retryable)
        timeout = error_from_rpc({"code": -32016, "data": {"code": "kernelTimeout", "message": "stopped", "details": {"committed": False, "budgetMs": 120000}}})
        self.assertIsInstance(timeout, KernelTimeoutError)
        self.assertEqual(timeout.budget_ms, 120000)
        self.assertFalse(timeout.retryable)


class ModelingLayerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = FakeTransport()
        self.doc = Document(AssemblerClient(self.transport))

    def test_each_modelling_call_is_one_canonical_command(self) -> None:
        s = self.doc.sketch("XY")
        s.rect(80, 50)
        s.circle(d=6, center=(10, 0))
        body = self.doc.extrude(s, 6)
        self.doc.fillet(body.edges("|Z").lines(), 2)
        self.assertEqual(self.transport.methods, ["feature.create", "sketch.addProfile", "feature.create", "edges.list", "feature.create"])
        self.assertEqual(self.doc.commands, ["feature.create", "sketch.addProfile", "feature.create", "feature.create"])
        sketch_params = self.transport.requests[1][1]["params"]
        self.assertEqual(sketch_params["plane"], {"kind": "plane", "plane": "XY", "offset": 0.0})
        self.assertEqual(sketch_params["profiles"], [{"kind": "rectangle", "x": -40.0, "y": -25.0, "width": 80, "height": 50}])
        extrude = self.transport.requests[3][1]
        self.assertEqual(extrude["kind"], "extrude")
        self.assertEqual(extrude["params"]["profile"], {"kind": "sketch", "featureId": "feature-sketch-1"})
        self.assertEqual(extrude["params"]["operation"], "new")
        self.assertEqual(body.id, "body:feature-extrude-2")
        fillet = self.transport.requests[-1][1]
        self.assertEqual(fillet["params"], {"edges": [{"bodyId": "body:feature-extrude-2", "key": "a|b"}], "radius": 2})

    def test_face_sketch_cut_goes_into_the_material_of_its_body(self) -> None:
        from himmelcad.assembler import Face

        top = Face("body:b", "f:end:0", "top", "plane", (0, 0, 1), (0, 0, 6), 100.0)
        s = self.doc.sketch(top)
        s.circle(3)
        self.doc.cut(s, 6)
        cut = self.transport.requests[-1][1]["params"]
        self.assertEqual(cut["distance"], -6)
        self.assertEqual(cut["operation"], "cut")
        self.assertEqual(cut["targetBodyId"], "body:b")

    def test_slot_macro_is_three_profile_commands(self) -> None:
        s = self.doc.sketch("XY")
        s.slot(30, 6)
        self.assertEqual(self.transport.methods, ["feature.create", "sketch.addProfile", "sketch.addProfile"])

    def test_transaction_commits_on_success_and_cancels_on_error(self) -> None:
        with self.doc.transaction("Lid"):
            self.doc.sketch("XY").rect(10, 10)
        self.assertEqual(self.transport.methods, ["transaction.begin", "feature.create", "transaction.commit"])
        self.transport.requests.clear()
        with self.assertRaises(RuntimeError):
            with self.doc.transaction("Broken"):
                raise RuntimeError("agent bug")
        self.assertEqual(self.transport.methods, ["transaction.begin", "transaction.cancel"])

    def test_selections_filter_client_side(self) -> None:
        edges = EdgeSet([
            Edge("b", "k1", "l1", "line", (0, 0, 0), 5, (1, 0, 0), None, ("x", "top")),
            Edge("b", "k2", "l2", "line", (0, 0, 6), 5, (1, 0, 0), None, ("top", "y")),
            Edge("b", "k3", "c", "circle", (0, 0, 6), 9, None, 3.0, ("z", "w")),
        ])
        self.assertEqual([e.key for e in edges.max("Z")], ["k2", "k3"])
        self.assertEqual([e.key for e in edges.max("Z").lines()], ["k2"])
        self.assertEqual([e.key for e in edges.filter(curve="circle")], ["k3"])
        self.assertEqual(edges.filter(lambda e: e.length > 6).one().key, "k3")
        with self.assertRaises(ValueError):
            self.doc.fillet(edges.filter(curve="ellipse"), 1)

    def test_advanced_sketch_geometry_is_one_canonical_command_each(self) -> None:
        canned = {
            "sketch.addSpline": {"entityId": "s1", "pointIds": ["p1", "p2"], "handleIds": ["p3", "p4"]},
            "sketch.addEllipse": {"entityId": "e1"},
            "sketch.addSlot": {"curveIds": ["l1", "a1", "l2", "a2"]},
            "sketch.addPolygon": {"lineIds": ["l3", "l4", "l5"]},
            "sketch.addText": {"entityId": "t1", "missingCharacters": []},
            "sketch.mirror": {"createdIds": ["l9"]},
            "sketch.pattern": {"createdIds": ["c2", "c3"]},
            "sketch.roundCorner": {"createdIds": ["a3"]},
            "sketch.project": {"entityIds": ["l10"]},
        }
        original = self.transport.request

        def request(method: str, params: Mapping[str, Any]) -> Any:
            result = original(method, params)
            return canned.get(method, result)

        self.transport.request = request  # type: ignore[method-assign]
        s = self.doc.sketch("XY")
        self.assertEqual(s.spline([(0, 0), (10, 5), (20, 0)]), "s1")
        self.assertEqual(s.ellipse(10, 4, angle=30), "e1")
        self.assertEqual(len(s.slot_between((0, 0), (30, 0), 8)), 4)
        self.assertEqual(s.polygon(10, 3, inscribed=False), ["l3", "l4", "l5"])
        self.assertEqual(s.text("Hi", 5), "t1")
        self.assertEqual(s.mirror(["l3"], "l1"), ["l9"])
        self.assertEqual(s.pattern(["c1"], 3, spacing=10), ["c2", "c3"])
        self.assertEqual(s.fillet_corner("p5", 2), ["a3"])
        from himmelcad.assembler import Face

        self.assertEqual(s.project(Face("body:b", "x:end:0", "top", "plane", (0, 0, 1), (0, 0, 6), 1.0)), ["l10"])
        s.set_reference("d1")
        self.assertEqual(
            self.transport.methods,
            ["feature.create", "sketch.addSpline", "sketch.addEllipse", "sketch.addSlot", "sketch.addPolygon", "sketch.addText", "sketch.mirror", "sketch.pattern", "sketch.roundCorner", "sketch.project", "sketch.setReference"],
        )
        polygon = self.transport.requests[5][1]
        self.assertEqual(polygon["inscribed"], False)
        project = self.transport.requests[10][1]
        self.assertEqual(project["face"], {"bodyId": "body:b", "key": "x:end:0"})
        self.assertNotIn("edge", project)
        with self.assertRaises(ValueError):
            s.pattern(["c1"], 3)

    def test_param_creates_then_edits_by_name_and_feeds_a_feature_expression(self) -> None:
        from himmelcad.assembler import NotFoundError

        with self.assertRaises(NotFoundError):
            self.doc.param("wall")
        wall = self.doc.param("wall", 2)
        self.assertEqual(wall.value, 2)
        self.assertEqual(wall.unit, "mm")
        self.assertEqual(self.transport.methods[-1], "parameter.create")
        # Calling doc.param("wall", 3) again edits the same parameter (create then edit).
        wall = self.doc.param("wall", 3)
        self.assertEqual(self.transport.methods[-1], "parameter.edit")
        self.assertEqual(wall.value, 3)
        self.assertEqual(len(self.doc.parameters), 1)

        s = self.doc.sketch("XY")
        s.rect(80, 50)
        body = self.doc.extrude(s, expression="wall * 2")
        extrude_params = self.transport.requests[-1][1]["params"]
        self.assertEqual(extrude_params["distanceExpression"], "wall * 2")
        self.assertNotIn("distance", extrude_params)
        self.assertIsNotNone(body)

        wall.rename("thickness")
        self.assertEqual(self.doc.param("thickness").value, 3)
        wall.delete()
        self.assertEqual(self.doc.parameters, [])

    def test_measure_queries_are_one_canonical_read_each(self) -> None:
        from himmelcad.assembler import Body, Face

        plate = Body(self.doc, "body:b")
        top = Face("body:b", "x:end:0", "top", "plane", (0, 0, 1), (0, 0, 6), 1.0)
        self.assertEqual(self.doc.distance(plate, (0, 0, 10)), 4.0)
        self.assertEqual(self.doc.angle(top, top), 90.0)
        self.assertEqual(self.doc.area(top), 12.5)
        self.assertEqual(
            [m for m, _ in self.transport.requests[-3:]],
            ["measure.distance", "measure.angle", "measure.area"],
        )
        distance = self.transport.requests[-3][1]
        self.assertEqual(distance["a"], {"kind": "body", "bodyId": "body:b"})
        self.assertEqual(distance["b"], {"kind": "point", "point": [0.0, 0.0, 10.0]})
        self.assertEqual(self.transport.requests[-1][1]["faces"], [{"bodyId": "body:b", "key": "x:end:0"}])
        self.assertEqual(self.doc.commands, [], "measurements are reads")
        with self.assertRaises(ValueError):
            self.doc.distance(plate, (1, 2))
    def test_exports_are_written_by_the_client(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self.doc.export_3mf(Path(tmp) / "out" / "part.3mf")
            self.assertEqual(path.read_bytes(), b"PK\x03\x04")
            self.doc.export_stl(Path(tmp) / "part.stl", ascii=True, resolution="fine")
            self.assertEqual(self.transport.requests[-1], ("export.stl", {"resolution": "fine", "format": "ascii"}))

    def test_print_helpers_are_one_command_each(self) -> None:
        from himmelcad.assembler import Body, Face

        body = Body(self.doc, "body:b")
        bottom = Face("body:b", "f:side:0", "side", "plane", (1, 0, 0), (5, 0, 3), 60.0)
        report = self.doc.printability(overhangAngleDeg=50, material="PETG")
        self.assertEqual(self.transport.requests[-1], ("print.analyze", {"settings": {"overhangAngleDeg": 50, "material": "PETG"}}))
        self.assertTrue(report.printable)
        self.assertEqual(report.mass_g, 12.5)
        self.assertEqual(len(report.findings_of("overhang")), 1)
        placed = self.doc.place_on_plate(bottom)
        self.assertEqual(self.transport.requests[-1], ("print.placeOnPlate", {"face": {"bodyId": "body:b", "key": "f:side:0"}}))
        self.assertEqual(placed.kind, "transform")
        self.doc.orient(body)
        self.assertEqual(self.transport.requests[-1], ("print.orient", {"bodyId": "body:b", "rank": 1}))
        self.doc.orient(body, down=(0, 1, 0))
        self.assertEqual(self.transport.requests[-1], ("print.orient", {"bodyId": "body:b", "down": [0.0, 1.0, 0.0]}))
        self.doc.mesh_stats(resolution="coarse")
        self.assertEqual(self.transport.requests[-1], ("export.meshStats", {"resolution": "coarse"}))
        self.assertEqual(self.doc.commands[-3:], ["print.placeOnPlate", "print.orient", "print.orient"])


class LoopbackTransportTests(unittest.TestCase):
    def test_refuses_non_loopback_urls(self) -> None:
        with self.assertRaises(TransportError):
            LoopbackTransport("http://example.com:8080/rpc", "t")

    def test_sends_the_bearer_token_and_maps_errors(self) -> None:
        seen: list[dict[str, str]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append({"auth": self.headers.get("Authorization", ""), "origin": self.headers.get("Origin", "")})
                if self.headers.get("Authorization") != "Bearer secret":
                    payload = {"jsonrpc": "2.0", "id": None, "error": {"code": -32003, "message": "no", "data": {"code": "permissionDenied", "message": "Missing or wrong bearer token"}}}
                    status = 401
                else:
                    payload = {"jsonrpc": "2.0", "id": body["id"], "result": {"method": body["method"]}}
                    status = 200
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: Any) -> None:
                return None

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/rpc"
            ok = LoopbackTransport.from_connection(json.dumps({"url": url, "token": "secret"}))
            self.assertEqual(ok.request("document.get", {}), {"method": "document.get"})
            with self.assertRaises(HimmelcadError) as caught:
                LoopbackTransport(url, "wrong").request("document.get", {})
            self.assertEqual(caught.exception.raw_code, "permissionDenied")
            self.assertEqual(seen[0], {"auth": "Bearer secret", "origin": ""})
        finally:
            server.shutdown()
            server.server_close()


@unittest.skipUnless(shutil.which("node") and HEADLESS.is_file(), "needs node and a built assembler-headless (pnpm --filter @himmelcad/assembler build:headless)")
class HeadlessIntegrationTests(unittest.TestCase):
    def test_plate_with_holes_round_trip(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc, tempfile.TemporaryDirectory() as tmp:
            s = doc.sketch("XY")
            s.rect(80, 50)
            plate = doc.extrude(s, 6)
            doc.fillet(plate.edges("|Z"), 3)
            holes = doc.sketch(plate.face(">Z"))
            holes.circle(d=6, center=(20, 0))
            holes.circle(d=6, center=(-20, 0))
            doc.cut(holes, 6)
            self.assertTrue(plate.valid)
            self.assertEqual(plate.bbox.size, (80.0, 50.0, 6.0))
            import math

            expected = 80 * 50 * 6 - 4 * (9 - math.pi * 9 / 4) * 6 - 2 * math.pi * 9 * 6
            self.assertAlmostEqual(plate.volume, expected, places=3)
            with self.assertRaises(ReferenceNotFoundError) as caught:
                doc.fillet([Edge(plate.id, "nope|nope", "", "line", (0, 0, 0), 1, None, None)], 1)
            self.assertTrue(caught.exception.candidates)
            with self.assertRaises(FeatureFailedError):
                doc.fillet(plate.edges("|Z"), 30)
            s.edit_profile(0, width=90)  # an early parametric edit re-evaluates the history
            self.assertEqual(plate.bbox.size[0], 90.0)
            doc.undo()
            saved = doc.save(Path(tmp) / "plate.hcasm")
            doc.new()
            self.assertEqual(doc.bodies(), [])
            doc.open(saved)
            self.assertEqual(len(doc.features()), 5)
            self.assertEqual(doc.errors(), {})
            out = doc.export_3mf(Path(tmp) / "plate.3mf")
            self.assertTrue(out.read_bytes().startswith(b"PK"))

    def test_constrained_sketch_revolve_about_a_construction_line(self) -> None:
        import math

        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XZ")
            s.polyline([(5, 0), (15, 0), (15, 4), (9, 4), (9, 10), (5, 10)])
            axis = s.line((0, -2), (0, 12), construction=True)
            self.assertEqual(len(s.regions()), 1)
            part = doc.revolve(s, axis)
            ring = lambda r0, r1, h: math.pi * (r1 * r1 - r0 * r0) * h  # noqa: E731
            self.assertAlmostEqual(part.volume, ring(5, 15, 4) + ring(5, 9, 6), places=3)
            # A redundant constraint is rejected by the solver with its diagnosis.
            with self.assertRaises(SketchConflictError) as caught:
                doc.client.add_constraint(s.id, "horizontal", ["l1"])
            self.assertTrue(caught.exception.redundant or caught.exception.conflicting)
            # Lock the inner corner, dimension the bottom width and drive it: the revolved part follows.
            doc.client.add_constraint(s.id, "fixed", ["p1"])
            dim = doc.client.add_dimension(s.id, "distance", ["l1"], value=10)
            self.assertEqual(dim["name"], "d1")
            s.set_dimension("d1", 12)
            self.assertAlmostEqual(part.bbox.size[0], 2 * 17, places=6)
            self.assertEqual(doc.errors(), {})

    def test_print_workflow(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc, tempfile.TemporaryDirectory() as tmp:
            s = doc.sketch("XY")
            s.rect(30, 20)
            plate = doc.extrude(s, 6)
            holes = doc.sketch(plate.face(">Z"))
            holes.circle(d=1.5)
            doc.cut(holes, 6)
            report = doc.printability(minHoleMm=2)
            self.assertTrue(report.printable)
            self.assertEqual([h["diameterMm"] for h in report.body(plate)["holes"]], [1.5])
            self.assertEqual(len(report.findings_of("smallHole")), 1)
            doc.place_on_plate(plate.face("+X"))
            self.assertAlmostEqual(plate.bbox.size[2], 30.0, places=6)
            self.assertAlmostEqual(plate.bbox.min[2], 0.0, places=6)
            best = doc.orientations(plate)[0]
            self.assertEqual(best["rank"], 1)
            doc.orient(plate)
            self.assertAlmostEqual(plate.bbox.size[2], 6.0, places=6)
            coarse = doc.mesh_stats(resolution="coarse")["triangles"]
            fine = doc.mesh_stats(resolution="fine")["triangles"]
            self.assertGreater(fine, coarse)
            out = doc.export_stl(Path(tmp) / "plate.stl", ascii=True, resolution="coarse")
            self.assertEqual(out.read_text().count("facet normal"), coarse)

    def test_shape_dimensions_by_role(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect(60, 40)
            s.circle(d=10, center=(50, 0))
            self.assertEqual(s.dimensions[0], {"x": "d1", "y": "d2", "width": "d3", "height": "d4"})
            self.assertEqual(s.dimension(1, "diameter"), "d7")
            body = doc.extrude(s, 5)
            s.edit_profile(1, radius=6)
            self.assertEqual(body.bbox.max[0], 56.0)

    def test_advanced_sketch_geometry_extrudes(self) -> None:
        import math

        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.slot_between((0, 0), (30, 0), 8)
            slot = doc.extrude(s, 2)
            self.assertTrue(slot.valid)
            self.assertAlmostEqual(slot.volume, (30 * 8 + math.pi * 16) * 2, places=4)
            # A true slot is one profile.
            self.assertEqual(len(s.regions()), 1)
            label = doc.sketch("XY", 1.0)
            label.text("OK", 4, position=(2, -2))
            self.assertEqual(len(label.regions()), 2, "one region per glyph, counters open")
            doc.cut(label, 1)  # engraved 1 mm deep into the top
            self.assertTrue(slot.valid)
            self.assertLess(slot.volume, (30 * 8 + math.pi * 16) * 2)
            # A projection follows its source.
            top = doc.sketch("XY", 10.0)
            top.project(slot.face("<Z"), construction=False)
            area = lambda: top.regions()[0]["area"]  # noqa: E731
            self.assertAlmostEqual(area(), 30 * 8 + math.pi * 16, places=3)
            s.set_dimension("d2", 10)  # slot width
            self.assertAlmostEqual(area(), 30 * 10 + math.pi * 25, places=3)
            self.assertEqual(doc.errors(), {})

    def test_document_parameters_drive_a_sketch_dimension_and_an_extrude(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            wall = doc.param("wall", 2)
            s = doc.sketch("XY")
            s.rect(80, 50)
            plate = doc.extrude(s, expression="wall * 3")
            self.assertEqual(plate.bbox.size[2], 6.0)
            # A sketch dimension expression also reads a document parameter (falls
            # back to it once the sketch's own dimension names don't match).
            width_dim = s.dimensions[0]["width"]
            s.set_dimension(width_dim, expression="wall * 40")
            self.assertEqual(plate.bbox.size[0], 80.0)

            # Changing the parameter re-solves every sketch that reads it and
            # re-resolves every feature `*Expression` field — one undo step.
            steps = len(doc.features())
            wall.set(3)
            self.assertEqual(plate.bbox.size[2], 9.0)
            self.assertEqual(plate.bbox.size[0], 120.0)
            self.assertEqual(len(doc.features()), steps)
            doc.undo()
            self.assertEqual(doc.param("wall").value, 2.0)
            self.assertEqual(plate.bbox.size[0], 80.0)
            self.assertEqual(plate.bbox.size[2], 6.0)
            doc.redo()
            self.assertEqual(plate.bbox.size[0], 120.0)

            # A value the sketch cannot satisfy (width 0) is refused as a whole.
            with self.assertRaises(SketchConflictError):
                wall.set(0)
            self.assertEqual(doc.param("wall").value, 3.0)
            self.assertEqual(plate.bbox.size, (120.0, 50.0, 9.0))
            # Renaming rewrites the extrude's stored expression and the sketch
            # dimension's expression alike.
            wall.rename("thickness")
            self.assertEqual(doc.feature(plate.feature.id).params["distanceExpression"], "thickness * 3")
            renamed_sketch = next(sk for sk in doc.client.sketches() if sk["featureId"] == s.id)
            renamed_dim = next(d for d in renamed_sketch["dimensions"] if d["name"] == width_dim)
            self.assertEqual(renamed_dim["expression"], "thickness * 40")

            # A parameter still read by a dimension/feature expression cannot be deleted.
            with self.assertRaises(ConflictError) as caught:
                wall.delete()
            self.assertTrue(caught.exception.details.get("usages"))

    def test_measure_matches_the_geometry(self) -> None:
        with Document(AssemblerClient(StdioTransport())) as doc:
            s = doc.sketch("XY")
            s.rect(80, 50)
            plate = doc.extrude(s, 6)
            self.assertAlmostEqual(doc.distance(plate.face(">Z"), (0, 0, 16)), 10.0, places=6)
            self.assertAlmostEqual(doc.angle(plate.face(">Z"), plate.face(">X")), 90.0, places=6)
            self.assertAlmostEqual(doc.area(plate.face(">Z")), 80 * 50, places=6)
            volume = doc.volume(plate)
            self.assertAlmostEqual(volume["volume"], 80 * 50 * 6, places=4)
            self.assertAlmostEqual(volume["mass"], 80 * 50 * 6 * 1.24 / 1000, places=6)
            panel = doc.measure(plate.face(">Z"), plate.face("<Z"))
            self.assertEqual(panel["title"], "Parallel faces")
            self.assertAlmostEqual(panel["values"][0]["value"], 6.0, places=9)

    def test_interop_step_assembly_mesh_solid_dxf(self) -> None:
        """Import/export helpers (one canonical command each) against the interop fixtures."""
        import math

        fixtures = REPOSITORY_ROOT / "apps/assembler/test/fixtures/interop"
        with Document(AssemblerClient(StdioTransport())) as doc, tempfile.TemporaryDirectory() as tmp:
            formats = doc.formats()
            iges = next(f for f in formats["import"] if f["format"] == "iges")
            himmelcad_occt = bool(formats["kernel"]["igesRead"])
            self.assertEqual(iges["available"], himmelcad_occt)
            parts = doc.import_step(fixtures / "robot-assembly.step")
            self.assertEqual([p.name for p in parts], ["Base plate", "Link", "Pin", "Link", "Pin"])
            self.assertEqual(parts[4].item_path, ("Robot", "Arm (2)"))
            self.assertEqual(len(doc.features()), 1)
            out = doc.export_step(Path(tmp) / "robot-ap214.step", schema="AP214", unit="in")
            self.assertIn(b"AUTOMOTIVE_DESIGN", out.read_bytes())
            self.assertIn(b"CONVERSION_BASED_UNIT('INCH'", out.read_bytes())
            if himmelcad_occt:
                # HimmelCAD OCCT build: IGES round trip (export.iges -> import.iges).
                igs = doc.export_iges(Path(tmp) / "robot.igs", parts[:2], unit="in")
                self.assertIn(b"4HINCH", igs.read_bytes())
                back = doc.import_iges(igs)
                self.assertEqual(len(back), 2)
                self.assertAlmostEqual(back[0].volume, parts[0].volume, places=3)
            else:
                with self.assertRaises(HimmelcadError) as refused:
                    doc.client.import_iges(fixtures / "plate.dxf")
                self.assertIn("IGES is not in this build", str(refused.exception))

            meshes = doc.import_mesh(fixtures / "parts.3mf")
            self.assertEqual([(m.name, m.color, m.folder) for m in meshes], [("Cube", "#FF0000", ("parts",)), ("Pair", "#FF0000", ("parts",)), ("Wedge", "#33AA55", ("parts",))])
            bracket = doc.import_mesh(fixtures / "l-bracket.stl")[0]
            solid = doc.mesh_to_solid(bracket)
            self.assertEqual(len(solid.faces()), 8)
            self.assertAlmostEqual(solid.volume, 6000.0, places=6)
            doc.fillet(solid.edges("|Z").max("x").min("y"), 3)
            self.assertAlmostEqual(solid.volume, 6000 - (9 - math.pi * 9 / 4) * 10, places=3)
            open_box = doc.import_mesh(fixtures / "open-box.stl")[0]
            with self.assertRaises(HimmelcadError) as caught:
                doc.mesh_to_solid(open_box)
            self.assertIn("open edges", str(caught.exception))

            sketch = doc.import_dxf(fixtures / "plate.dxf", plane="XZ", offset=5)
            self.assertEqual(sketch.import_report["connected"], 7)
            self.assertGreaterEqual(len(sketch.regions()), 5)
            dxf = doc.export_dxf(Path(tmp) / "plate-r12.dxf", sketch=sketch, version="R12")
            self.assertIn(b"AC1009", dxf.read_bytes())
            face_dxf = doc.export_dxf(Path(tmp) / "top.dxf", face=solid.face(">Z"))
            self.assertIn(b"ARC", face_dxf.read_bytes())


if __name__ == "__main__":
    unittest.main()
