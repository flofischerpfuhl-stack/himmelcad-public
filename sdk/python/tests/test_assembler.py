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
        if method == "edges.list":
            return [
                {"bodyId": params["bodyId"], "key": "a|b", "name": "Line +Z", "curve": "line", "midpoint": [0, 0, 3], "length": 6, "direction": [0, 0, 1], "radius": None, "faceKeys": ["a", "b"]},
                {"bodyId": params["bodyId"], "key": "b|c", "name": "Circle", "curve": "circle", "midpoint": [5, 0, 6], "length": 31.4, "direction": None, "radius": 5, "faceKeys": ["b", "c"]},
            ]
        if method == "export.3mf":
            return {"data": base64.b64encode(b"PK\x03\x04").decode(), "byteLength": 4}
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

    def test_exports_are_written_by_the_client(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self.doc.export_3mf(Path(tmp) / "out" / "part.3mf")
            self.assertEqual(path.read_bytes(), b"PK\x03\x04")


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


if __name__ == "__main__":
    unittest.main()
