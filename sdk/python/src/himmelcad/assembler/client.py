"""Low-level client: one Python method per canonical ``hcasm.agent-api@1`` method.

Every call is exactly one JSON-RPC request; nothing is batched, cached or
re-interpreted. :mod:`himmelcad.assembler.modeling` builds the idiomatic layer
on top of this class.
"""
from __future__ import annotations

import base64
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .transport import LoopbackTransport, StdioTransport, Transport

API_ID = "hcasm.agent-api"
API_VERSION = 1

#: The contract's methods (checked against ``apps/assembler/api/agent-api-v1.schema.json`` by the tests).
METHODS = (
    "api.hello", "api.describe",
    "document.get", "features.list", "feature.get", "bodies.list", "body.get",
    "faces.list", "edges.list", "sketches.list", "selection.get", "selection.set",
    "parameters.list", "parameter.create", "parameter.edit", "parameter.delete",
    "feature.create", "feature.edit", "feature.delete", "feature.suppress", "feature.rename",
    "sketch.addProfile", "sketch.addPolyline", "sketch.addArc", "sketch.addConstraint",
    "sketch.addDimension", "sketch.setDimension", "sketch.deleteItems",
    "transaction.begin", "transaction.preview", "transaction.commit", "transaction.cancel",
    "history.undo", "history.redo",
    "export.stl", "export.3mf", "export.step", "import.step",
    "project.new", "project.open", "project.save",
)


def _drop_none(params: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in params.items() if value is not None}


class AssemblerClient:
    """Canonical command/query client. ``on_call(method, params, result)`` observes every call."""

    def __init__(self, transport: Transport, *, on_call: Callable[[str, Mapping[str, Any], Any], None] | None = None) -> None:
        self.transport = transport
        self.on_call = on_call
        self.session: Mapping[str, Any] | None = None

    @classmethod
    def headless(cls, command: list[str] | None = None, **kwargs: Any) -> AssemblerClient:
        client = cls(StdioTransport(command), **kwargs)
        client.hello()
        return client

    @classmethod
    def connect_app(cls, connection: str | None = None, **kwargs: Any) -> AssemblerClient:
        client = cls(LoopbackTransport.from_connection(connection), **kwargs)
        client.hello()
        return client

    def call(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        payload = _drop_none(params or {})
        result = self.transport.request(method, payload)
        if self.on_call is not None:
            self.on_call(method, payload, result)
        return result

    def close(self) -> None:
        self.transport.close()

    def __enter__(self) -> AssemblerClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ---- meta / queries ---------------------------------------------------------------
    def hello(self, client: str = "himmelcad-python") -> Mapping[str, Any]:
        self.session = self.call("api.hello", {"client": client, "versions": [API_VERSION]})
        return self.session

    def describe(self) -> Mapping[str, Any]:
        return self.call("api.describe")

    def document(self) -> Mapping[str, Any]:
        return self.call("document.get")

    def features(self, scope: str | None = None) -> list[Mapping[str, Any]]:
        return self.call("features.list", {"scope": scope})

    def feature(self, feature_id: str, scope: str | None = None) -> Mapping[str, Any]:
        return self.call("feature.get", {"featureId": feature_id, "scope": scope})

    def bodies(self, scope: str | None = None) -> list[Mapping[str, Any]]:
        return self.call("bodies.list", {"scope": scope})

    def body(self, body_id: str, scope: str | None = None) -> Mapping[str, Any]:
        return self.call("body.get", {"bodyId": body_id, "scope": scope})

    def faces(self, body_id: str, select: str | None = None, scope: str | None = None) -> list[Mapping[str, Any]]:
        return self.call("faces.list", {"bodyId": body_id, "select": select, "scope": scope})

    def edges(self, body_id: str, select: str | None = None, scope: str | None = None) -> list[Mapping[str, Any]]:
        return self.call("edges.list", {"bodyId": body_id, "select": select, "scope": scope})

    def sketches(self, scope: str | None = None) -> list[Mapping[str, Any]]:
        return self.call("sketches.list", {"scope": scope})

    def selection(self) -> list[Mapping[str, Any]]:
        return self.call("selection.get")

    def set_selection(self, items: list[Mapping[str, Any]]) -> Mapping[str, Any]:
        return self.call("selection.set", {"items": items})

    def parameters(self) -> list[Mapping[str, Any]]:
        """Document parameters ("variables", `model/parameters.ts`), in creation order."""
        return self.call("parameters.list")

    # ---- commands ------------------------------------------------------------------------

    def create_parameter(self, name: str, *, unit: str | None = None, value: float | None = None, expression: str | None = None, expected_revision: int | None = None) -> Mapping[str, Any]:
        return self.call("parameter.create", {"name": name, "unit": unit, "value": value, "expression": expression, "expectedRevision": expected_revision})

    def edit_parameter(self, parameter_id: str, *, name: str | None = None, unit: str | None = None, value: float | None = None, expression: str | None = None, expected_revision: int | None = None) -> Mapping[str, Any]:
        return self.call("parameter.edit", {"parameterId": parameter_id, "name": name, "unit": unit, "value": value, "expression": expression, "expectedRevision": expected_revision})

    def delete_parameter(self, parameter_id: str) -> Mapping[str, Any]:
        return self.call("parameter.delete", {"parameterId": parameter_id})
    def create_feature(self, kind: str, params: Mapping[str, Any], *, name: str | None = None, expected_revision: int | None = None) -> Mapping[str, Any]:
        return self.call("feature.create", {"kind": kind, "params": dict(params), "name": name, "expectedRevision": expected_revision})

    def edit_feature(self, feature_id: str, params: Mapping[str, Any], *, expected_revision: int | None = None) -> Mapping[str, Any]:
        return self.call("feature.edit", {"featureId": feature_id, "params": dict(params), "expectedRevision": expected_revision})

    def delete_feature(self, feature_id: str) -> Mapping[str, Any]:
        return self.call("feature.delete", {"featureId": feature_id})

    def suppress_feature(self, feature_id: str, suppressed: bool = True) -> Mapping[str, Any]:
        return self.call("feature.suppress", {"featureId": feature_id, "suppressed": suppressed})

    def rename_feature(self, feature_id: str, name: str) -> Mapping[str, Any]:
        return self.call("feature.rename", {"featureId": feature_id, "name": name})

    def add_profile(self, feature_id: str, profile: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.call("sketch.addProfile", {"featureId": feature_id, "profile": dict(profile)})

    def add_polyline(self, feature_id: str, points: list[tuple[float, float]], *, closed: bool = False, construction: bool = False, auto_constrain: bool = True) -> Mapping[str, Any]:
        return self.call("sketch.addPolyline", {"featureId": feature_id, "points": [[float(u), float(v)] for u, v in points], "closed": closed, "construction": construction, "autoConstrain": auto_constrain})

    def add_arc(self, feature_id: str, center: tuple[float, float], start: tuple[float, float], end: tuple[float, float], *, construction: bool = False) -> Mapping[str, Any]:
        return self.call("sketch.addArc", {"featureId": feature_id, "center": list(center), "start": list(start), "end": list(end), "construction": construction})

    def add_constraint(self, feature_id: str, kind: str, refs: list[str]) -> Mapping[str, Any]:
        return self.call("sketch.addConstraint", {"featureId": feature_id, "kind": kind, "refs": list(refs)})

    def add_dimension(self, feature_id: str, kind: str, refs: list[str], *, value: float | None = None, expression: str | None = None, name: str | None = None) -> Mapping[str, Any]:
        return self.call("sketch.addDimension", {"featureId": feature_id, "kind": kind, "refs": list(refs), "value": value, "expression": expression, "name": name})

    def set_dimension(self, feature_id: str, dimension: str, *, value: float | None = None, expression: str | None = None) -> Mapping[str, Any]:
        """Changes a sketch dimension by id or name (``"d3"``) to a value or an expression (``"d1 / 2"``)."""
        return self.call("sketch.setDimension", {"featureId": feature_id, "dimension": dimension, "value": value, "expression": expression})

    def delete_sketch_items(self, feature_id: str, ids: list[str]) -> Mapping[str, Any]:
        return self.call("sketch.deleteItems", {"featureId": feature_id, "ids": list(ids)})

    def begin(self, label: str | None = None) -> Mapping[str, Any]:
        return self.call("transaction.begin", {"label": label})

    def preview(self) -> Mapping[str, Any]:
        return self.call("transaction.preview")

    def commit(self, *, allow_errors: bool | None = None) -> Mapping[str, Any]:
        return self.call("transaction.commit", {"allowErrors": allow_errors})

    def cancel(self) -> Mapping[str, Any]:
        return self.call("transaction.cancel")

    def undo(self) -> Mapping[str, Any]:
        return self.call("history.undo")

    def redo(self) -> Mapping[str, Any]:
        return self.call("history.redo")

    def export(self, fmt: str, *, body_ids: list[str] | None = None) -> bytes:
        """Returns the exported file bytes (``fmt``: ``stl``, ``3mf`` or ``step``)."""
        result = self.call(f"export.{fmt}", {"bodyIds": body_ids})
        return base64.b64decode(result["data"])

    def export_to(self, fmt: str, path: str | Path, *, body_ids: list[str] | None = None) -> Path:
        """Writes an export locally (works for both transports; the app endpoint has no file access)."""
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.export(fmt, body_ids=body_ids))
        return target

    def import_step(self, path: str | Path) -> Mapping[str, Any]:
        source = Path(path)
        return self.call("import.step", {"data": base64.b64encode(source.read_bytes()).decode("ascii"), "fileName": source.name})

    def new_project(self, name: str | None = None) -> Mapping[str, Any]:
        return self.call("project.new", {"name": name})

    def open_project(self, path: str | Path) -> Mapping[str, Any]:
        return self.call("project.open", {"text": Path(path).read_text(encoding="utf-8")})

    def save_project(self, path: str | Path, *, name: str | None = None) -> Path:
        result = self.call("project.save", {"name": name})
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(result["text"], encoding="utf-8")
        return target
