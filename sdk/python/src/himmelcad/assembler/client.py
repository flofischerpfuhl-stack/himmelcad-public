"""Low-level client: one Python method per canonical ``hcasm.agent-api@1`` method.

Every call is exactly one JSON-RPC request; nothing is batched, cached or
re-interpreted. :mod:`himmelcad.assembler.modeling` builds the idiomatic layer
on top of this class.
"""
from __future__ import annotations

import base64
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .transport import LoopbackTransport, StdioTransport, Transport

API_ID = "hcasm.agent-api"
API_VERSION = 1

#: The contract's methods (checked against ``apps/assembler/api/agent-api-v1.schema.json`` by the tests).
METHODS = (
    "api.hello", "api.describe",
    "document.get", "features.list", "feature.get", "bodies.list", "body.get", "body.copyUnlinked",
    "faces.list", "edges.list", "sketches.list", "sketch.fonts", "datums.list", "selection.get", "selection.set",
    "parameters.list", "parameter.create", "parameter.edit", "parameter.delete", "parameters.sweep",
    "measure.get", "measure.distance", "measure.angle", "measure.area", "measure.clearance", "measure.volume",
    "feature.create", "feature.edit", "feature.delete", "feature.suppress", "feature.rename",
    "sketch.addProfile", "sketch.addPolyline", "sketch.addArc", "sketch.addConstraint",
    "sketch.addDimension", "sketch.setDimension", "sketch.deleteItems",
    "sketch.addSpline", "sketch.addEllipse", "sketch.addSlot", "sketch.addPolygon", "sketch.addText",
    "sketch.mirror", "sketch.pattern", "sketch.editPattern", "sketch.offset", "sketch.roundCorner", "sketch.disconnect",
    "sketch.project", "sketch.unlinkProjection", "sketch.setReference",
    "transaction.begin", "transaction.preview", "transaction.commit", "transaction.cancel",
    "history.undo", "history.redo",
    "export.stl", "export.3mf", "export.obj", "export.step", "import.step",
    "project.new", "project.open", "project.save",
    "export.meshStats", "print.analyze", "print.orientations", "print.placeOnPlate", "print.orient",
    "checks.kinds", "checks.list", "checks.add", "checks.update", "checks.remove", "checks.run",
    "interop.formats", "import.mesh", "import.dxf", "export.dxf", "mesh.toSolid",
    "import.iges", "export.iges",
    "image.insert", "image.calibrate",
)


class _Null:
    """Sends an explicit JSON ``null`` (``None`` arguments are left out of a call)."""

    def __repr__(self) -> str:
        return "NULL"


#: Pass as a value to send ``null``, e.g. ``edit_parameter(pid, min=NULL)`` removes the lower bound.
NULL = _Null()


def _drop_none(params: Mapping[str, Any]) -> dict[str, Any]:
    return {key: (None if value is NULL else value) for key, value in params.items() if value is not None}


def _file_params(source: Path) -> dict[str, Any]:
    """A local file as base64 ``data`` + ``fileName`` (works for both transports)."""
    return {"data": base64.b64encode(source.read_bytes()).decode("ascii"), "fileName": source.name}


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

    def datums(self, scope: str | None = None) -> list[Mapping[str, Any]]:
        return self.call("datums.list", {"scope": scope})

    def selection(self) -> list[Mapping[str, Any]]:
        return self.call("selection.get")

    def set_selection(self, items: list[Mapping[str, Any]]) -> Mapping[str, Any]:
        return self.call("selection.set", {"items": items})

    def parameters(self) -> list[Mapping[str, Any]]:
        """Document parameters ("variables", `model/parameters.ts`), in creation order."""
        return self.call("parameters.list")

    def measure(self, items: Sequence[Mapping[str, Any]], *, scope: str | None = None) -> Mapping[str, Any]:
        """The Measure panel's measurement of 1..n targets (``{"kind": "body"|"face"|"edge"|"point", ...}``).

        Several edges/faces/bodies also give their sums ("Total length (n edges)", "Total area (n faces)",
        "Total volume"); distances come with their ΔX/ΔY/ΔZ components (secondary values)."""
        return self.call("measure.get", {"items": [dict(i) for i in items], "scope": scope})

    def measure_distance(self, a: Mapping[str, Any], b: Mapping[str, Any], *, scope: str | None = None) -> Mapping[str, Any]:
        """Exact minimum distance (kernel) between two targets, the closest points and ``delta`` (absolute X/Y/Z components)."""
        return self.call("measure.distance", {"a": dict(a), "b": dict(b), "scope": scope})

    def measure_angle(self, a: Mapping[str, Any], b: Mapping[str, Any], *, scope: str | None = None) -> Mapping[str, Any]:
        return self.call("measure.angle", {"a": dict(a), "b": dict(b), "scope": scope})

    def measure_area(self, faces: Sequence[Mapping[str, Any]], *, scope: str | None = None) -> Mapping[str, Any]:
        return self.call("measure.area", {"faces": [dict(f) for f in faces], "scope": scope})

    def measure_volume(self, body_ids: Sequence[str] | None = None, *, scope: str | None = None) -> Mapping[str, Any]:
        return self.call("measure.volume", {"bodyIds": None if body_ids is None else list(body_ids), "scope": scope})

    def measure_clearance(self, a: str | None = None, b: str | None = None, *, body_ids: Sequence[str] | None = None, below: float | None = None, overlap: bool | None = None, budget_ms: int | None = None, scope: str | None = None) -> Mapping[str, Any]:
        """Clearance of one body pair (``a``, ``b``), of every pair of ``body_ids`` or of all bodies:
        relation (clear/contact/overlap), exact distance, closest points, overlap volume and centre."""
        return self.call("measure.clearance", {"a": a, "b": b, "bodyIds": None if body_ids is None else list(body_ids), "below": below, "overlap": overlap, "budgetMs": budget_ms, "scope": scope})

    # ---- checks (stored requirements, CHECKS.md) ------------------------------------------
    def checks_kinds(self) -> list[Mapping[str, Any]]:
        return self.call("checks.kinds")

    def checks_list(self) -> Mapping[str, Any]:
        return self.call("checks.list")

    def check_add(self, kind: str, params: Mapping[str, Any], *, name: str | None = None, enabled: bool | None = None, expected_revision: int | None = None) -> Mapping[str, Any]:
        return self.call("checks.add", {"kind": kind, "params": dict(params), "name": name, "enabled": enabled, "expectedRevision": expected_revision})

    def check_update(self, check_id: str, *, params: Mapping[str, Any] | None = None, name: str | None = None, enabled: bool | None = None, clear_name: bool = False, expected_revision: int | None = None) -> Mapping[str, Any]:
        """``params`` replace the check's parameters as a whole; ``clear_name=True`` removes the label."""
        payload = _drop_none({"checkId": check_id, "params": None if params is None else dict(params), "name": name, "enabled": enabled, "expectedRevision": expected_revision})
        if clear_name:
            payload["name"] = None
        result = self.transport.request("checks.update", payload)
        if self.on_call is not None:
            self.on_call("checks.update", payload, result)
        return result

    def check_remove(self, check_id: str, *, expected_revision: int | None = None) -> Mapping[str, Any]:
        return self.call("checks.remove", {"checkId": check_id, "expectedRevision": expected_revision})

    def checks_run(self, ids: Sequence[str] | None = None, *, scope: str | None = None, budget_ms: int | None = None) -> Mapping[str, Any]:
        return self.call("checks.run", {"ids": None if ids is None else list(ids), "scope": scope, "budgetMs": budget_ms})

    # ---- commands ------------------------------------------------------------------------

    def create_parameter(self, name: str, *, unit: str | None = None, value: float | None = None, expression: str | None = None, min: float | str | None = None, max: float | str | None = None, step: float | str | None = None, expected_revision: int | None = None) -> Mapping[str, Any]:  # noqa: A002
        """``min``/``max`` bound the value (numbers, formulas or text with a unit); ``step`` is the slider increment."""
        return self.call("parameter.create", {"name": name, "unit": unit, "value": value, "expression": expression, "min": min, "max": max, "step": step, "expectedRevision": expected_revision})

    def edit_parameter(self, parameter_id: str, *, name: str | None = None, unit: str | None = None, value: float | None = None, expression: str | None = None, min: Any = None, max: Any = None, step: Any = None, expected_revision: int | None = None) -> Mapping[str, Any]:  # noqa: A002
        """A value outside ``min``/``max`` is refused (``invalidParams``, ``details.outOfRange``), never clamped.

        Pass :data:`NULL` as ``min``/``max``/``step`` to remove that bound."""
        return self.call("parameter.edit", {"parameterId": parameter_id, "name": name, "unit": unit, "value": value, "expression": expression, "min": min, "max": max, "step": step, "expectedRevision": expected_revision})

    def delete_parameter(self, parameter_id: str) -> Mapping[str, Any]:
        return self.call("parameter.delete", {"parameterId": parameter_id})

    def sweep_parameters(self, parameters: Sequence[Mapping[str, Any] | str], *, mode: str | None = None, samples: int | None = None, combine: str | None = None) -> Mapping[str, Any]:
        """``parameters.sweep``: rebuild the model over parameter ranges without changing it.

        ``parameters``: ids/names, or ``{"parameterId", "min"?, "max"?, "values"?}``. ``mode``:
        ``"range"`` (min/nominal/max) or ``"samples"`` (``samples`` values per parameter); ``combine``:
        ``"each"`` (one at a time) or ``"all"`` (every combination). Returns the report with one entry per
        sample (``outcome``, ``ok``, ``errors``, ``checks``, ...)."""
        entries = [{"parameterId": p} if isinstance(p, str) else dict(p) for p in parameters]
        return self.call("parameters.sweep", {"parameters": entries, "mode": mode, "samples": samples, "combine": combine})
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

    # ---- advanced sketch geometry (same builders as the app's sketch tools) ----

    def add_spline(self, feature_id: str, points: list[tuple[float, float]], *, mode: str = "fit", closed: bool = False, construction: bool = False) -> Mapping[str, Any]:
        """Spline through (``fit``) or controlled by (``control``) ``points``."""
        return self.call("sketch.addSpline", {"featureId": feature_id, "points": [[float(u), float(v)] for u, v in points], "mode": mode, "closed": closed, "construction": construction})

    def add_ellipse(self, feature_id: str, center: tuple[float, float], major_radius: float, minor_radius: float, *, angle: float = 0.0, arc: tuple[float, float] | None = None, dimension: bool = False, construction: bool = False) -> Mapping[str, Any]:
        """Ellipse (major axis along ``angle`` degrees); ``arc=(start°, end°)`` for an elliptical arc."""
        return self.call("sketch.addEllipse", {"featureId": feature_id, "center": list(center), "majorRadius": major_radius, "minorRadius": minor_radius, "angle": angle, "arc": list(arc) if arc else None, "dimension": dimension, "construction": construction})

    def add_slot(self, feature_id: str, start: tuple[float, float], end: tuple[float, float], width: float, *, arc_center: tuple[float, float] | None = None, clockwise: bool = False, dimension: bool = True, construction: bool = False) -> Mapping[str, Any]:
        """Slot between the centres ``start``/``end``; with ``arc_center`` an arc slot."""
        return self.call("sketch.addSlot", {"featureId": feature_id, "start": list(start), "end": list(end), "width": width, "arcCenter": list(arc_center) if arc_center else None, "clockwise": clockwise, "dimension": dimension, "construction": construction})

    def add_polygon(self, feature_id: str, center: tuple[float, float], radius: float, *, sides: int = 6, inscribed: bool = True, angle: float = 0.0, construction: bool = False) -> Mapping[str, Any]:
        """Regular polygon inscribed in (or circumscribed about) a construction circle of ``radius``."""
        return self.call("sketch.addPolygon", {"featureId": feature_id, "center": list(center), "radius": radius, "sides": sides, "inscribed": inscribed, "angle": angle, "construction": construction})

    def add_text(self, feature_id: str, text: str, position: tuple[float, float], height: float, *, angle: float = 0.0, font: str = "inter", align: str = "left", construction: bool = False) -> Mapping[str, Any]:
        """Text (cap ``height`` mm) anchored at ``position`` (``align``: the anchor is the baseline's start, centre or end); every glyph is a profile. ``font``: an id from :meth:`fonts`."""
        return self.call("sketch.addText", {"featureId": feature_id, "text": text, "position": list(position), "height": height, "angle": angle, "font": font, "align": align, "construction": construction})

    def fonts(self) -> list[Mapping[str, Any]]:
        """Fonts for sketch text: the bundled Inter, plus the computer's installed fonts in the desktop app (once listed there)."""
        return self.call("sketch.fonts")

    def mirror_sketch(self, feature_id: str, ids: list[str], axis: str) -> Mapping[str, Any]:
        """Mirrors sketch curves/points about the line ``axis`` (symmetric constraints)."""
        return self.call("sketch.mirror", {"featureId": feature_id, "ids": list(ids), "axis": axis})

    def pattern_sketch(self, feature_id: str, ids: list[str], count: int, *, mode: str = "linear", direction: tuple[float, float] | None = None, spacing: float | None = None, count2: int | None = None, direction2: tuple[float, float] | None = None, spacing2: float | None = None, center: tuple[float, float] | None = None, center_point_id: str | None = None, angle: float | None = None) -> Mapping[str, Any]:
        """Linear (``direction``, ``spacing``; with ``count2``/``direction2``/``spacing2`` a two-direction grid) or circular (``center``, ``angle``) sketch pattern. The result's ``patternId`` keeps it editable (:meth:`edit_pattern`)."""
        return self.call("sketch.pattern", {"featureId": feature_id, "ids": list(ids), "count": count, "mode": mode, "direction": list(direction) if direction else None, "spacing": spacing, "count2": count2, "direction2": list(direction2) if direction2 else None, "spacing2": spacing2, "center": list(center) if center else None, "centerPointId": center_point_id, "angle": angle})

    def edit_pattern(self, feature_id: str, pattern_id: str, *, count: int | None = None, count2: int | None = None, angle: float | None = None) -> Mapping[str, Any]:
        """Changes a recorded sketch pattern's ``count``, ``count2`` (two directions) or ``angle`` (circular); the copies are rebuilt."""
        return self.call("sketch.editPattern", {"featureId": feature_id, "patternId": pattern_id, "count": count, "count2": count2, "angle": angle})

    def offset_sketch(self, feature_id: str, ids: list[str], distance: float, *, side: str = "outside", single: bool = False) -> Mapping[str, Any]:
        """Offsets each curve's chain (``single``: only the curve) by ``distance``: closed loops ``outside``/``inside``, open chains ``left``/``right``."""
        return self.call("sketch.offset", {"featureId": feature_id, "ids": list(ids), "distance": distance, "side": side, "single": single})

    def round_corner(self, feature_id: str, point: str, size: float, *, mode: str = "fillet") -> Mapping[str, Any]:
        """Fillets (radius) or chamfers (set-back) the corner at ``point`` between two lines."""
        return self.call("sketch.roundCorner", {"featureId": feature_id, "point": point, "size": size, "mode": mode})

    def project(self, feature_id: str, *, edge: Mapping[str, Any] | None = None, face: Mapping[str, Any] | None = None, construction: bool = True) -> Mapping[str, Any]:
        """Projects a body edge or face outline into the sketch (associative)."""
        return self.call("sketch.project", {"featureId": feature_id, "edge": dict(edge) if edge else None, "face": dict(face) if face else None, "construction": construction})

    def disconnect(self, feature_id: str, ids: list[str]) -> Mapping[str, Any]:
        """Disconnect: curves meeting at the given shared points get their own points (coincidences removed)."""
        return self.call("sketch.disconnect", {"featureId": feature_id, "ids": list(ids)})

    def unlink_projection(self, feature_id: str, ids: list[str]) -> Mapping[str, Any]:
        """Unlinks projected geometry (projection ids or projected curve/point ids): it stays, free and editable."""
        return self.call("sketch.unlinkProjection", {"featureId": feature_id, "ids": list(ids)})

    def set_reference(self, feature_id: str, dimension: str, reference: bool = True) -> Mapping[str, Any]:
        """Turns a dimension into a reference (driven) dimension, or back with ``reference=False``."""
        return self.call("sketch.setReference", {"featureId": feature_id, "dimension": dimension, "reference": reference})

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

    def export(self, fmt: str, *, body_ids: list[str] | None = None, resolution: str | None = None, stl_format: str | None = None, **step: Any) -> bytes:
        """Returns the exported file bytes (``fmt``: ``stl``, ``3mf``, ``obj``, ``step`` or ``iges``).

        ``resolution`` (STL/3MF/OBJ): ``current`` (display mesh), ``coarse``, ``standard`` or ``fine``;
        ``stl_format``: ``binary`` (default) or ``ascii``. STEP options (keyword arguments):
        ``schema`` (``AP242``/``AP214``), ``unit`` (``mm``/``cm``/``m``/``in``), ``structure``
        (``flat``/``folders``) and ``visible_only``. IGES options (HimmelCAD OCCT build only):
        ``unit``, ``mode`` (``faces``/``brep``) and ``visible_only``.
        """
        params: dict[str, Any] = {"bodyIds": body_ids}
        if fmt in ("stl", "3mf", "obj"):
            params["resolution"] = resolution
        if fmt == "stl":
            params["format"] = stl_format
        if fmt == "step":
            unknown = set(step) - {"schema", "unit", "structure", "visible_only"}
            if unknown:
                raise TypeError(f"unknown STEP option(s): {', '.join(sorted(unknown))}")
            params.update(
                schema=step.get("schema"),
                unit=step.get("unit"),
                structure=step.get("structure"),
                visibleOnly=step.get("visible_only"),
            )
        elif fmt == "iges":
            unknown = set(step) - {"unit", "mode", "visible_only"}
            if unknown:
                raise TypeError(f"unknown IGES option(s): {', '.join(sorted(unknown))}")
            params.update(unit=step.get("unit"), mode=step.get("mode"), visibleOnly=step.get("visible_only"))
        elif step:
            raise TypeError(f"{', '.join(sorted(step))} only apply to STEP and IGES exports")
        result = self.call(f"export.{fmt}", params)
        return base64.b64decode(result["data"])

    def export_to(self, fmt: str, path: str | Path, *, body_ids: list[str] | None = None, resolution: str | None = None, stl_format: str | None = None, **step: Any) -> Path:
        """Writes an export locally (works for both transports; the app endpoint has no file access)."""
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.export(fmt, body_ids=body_ids, resolution=resolution, stl_format=stl_format, **step))
        return target

    # ---- 3D printing ---------------------------------------------------------------------
    def mesh_stats(self, *, body_ids: list[str] | None = None, resolution: str | None = None) -> Mapping[str, Any]:
        """Triangle counts and expected STL sizes at an export resolution."""
        return self.call("export.meshStats", {"bodyIds": body_ids, "resolution": resolution})

    def print_analyze(self, *, body_ids: list[str] | None = None, settings: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        """Printability report (overhangs, walls, holes, validity, material, build volume, findings)."""
        return self.call("print.analyze", {"bodyIds": body_ids, "settings": dict(settings) if settings else None})

    def print_orientations(self, body_id: str, *, overhang_angle: float | None = None, limit: int | None = None) -> list[Mapping[str, Any]]:
        return self.call("print.orientations", {"bodyId": body_id, "overhangAngleDeg": overhang_angle, "limit": limit})

    def place_on_plate(self, face: Mapping[str, Any], *, name: str | None = None) -> Mapping[str, Any]:
        return self.call("print.placeOnPlate", {"face": dict(face), "name": name})

    def print_orient(self, body_id: str, *, rank: int | None = None, down: tuple[float, float, float] | None = None, overhang_angle: float | None = None, name: str | None = None) -> Mapping[str, Any]:
        return self.call("print.orient", {"bodyId": body_id, "rank": rank, "down": None if down is None else [float(v) for v in down], "overhangAngleDeg": overhang_angle, "name": name})

    def import_step(self, path: str | Path, *, structure: str | None = None) -> Mapping[str, Any]:
        """One Import step. ``structure``: ``assembly`` (default: one body per placed part with
        names, colours and ``itemPath`` folders) or ``single`` (the whole file as one body)."""
        source = Path(path)
        return self.call("import.step", {**_file_params(source), "structure": structure})

    def import_iges(self, path: str | Path) -> Mapping[str, Any]:
        """One Import step from an IGES file (surfaces sewn into solids). Needs the HimmelCAD OCCT
        build; raises ``unsupported`` otherwise (``formats()`` reports availability)."""
        return self.call("import.iges", _file_params(Path(path)))

    # ---- import/export (interop) ----------------------------------------------------------------
    def formats(self) -> Mapping[str, Any]:
        """Import/export formats, what each keeps and whether this kernel build supports it (IGES)."""
        return self.call("interop.formats")

    def import_mesh(self, path: str | Path) -> Mapping[str, Any]:
        """STL, 3MF or OBJ as reference meshes (3MF: objects, transforms, unit, colours; OBJ: groups)."""
        return self.call("import.mesh", _file_params(Path(path)))

    def import_dxf(
        self,
        path: str | Path,
        *,
        plane: str | None = None,
        offset: float | None = None,
        face: Mapping[str, Any] | None = None,
        connect: bool | None = None,
        unit_scale: float | None = None,
        name: str | None = None,
    ) -> Mapping[str, Any]:
        """A DXF drawing as a new sketch on ``plane`` (``XY``/``XZ``/``YZ`` + ``offset``) or a planar
        ``face``; ``unit_scale`` (mm per drawing unit) overrides the file's ``$INSUNITS``."""
        return self.call(
            "import.dxf",
            {
                **_file_params(Path(path)),
                "plane": plane,
                "offset": offset,
                "face": dict(face) if face else None,
                "connect": connect,
                "unitScale": unit_scale,
                "name": name,
            },
        )

    def export_dxf(
        self,
        *,
        sketch_id: str | None = None,
        face: Mapping[str, Any] | None = None,
        version: str | None = None,
        include_construction: bool | None = None,
    ) -> bytes:
        """DXF bytes of a sketch (``sketch_id``) or a planar face outline (``face``); ``version`` ``R2000``/``R12``."""
        result = self.call(
            "export.dxf",
            {
                "sketchId": sketch_id,
                "face": dict(face) if face else None,
                "version": version,
                "includeConstruction": include_construction,
            },
        )
        return base64.b64decode(result["data"])

    def mesh_to_solid(self, mesh_id: str, *, name: str | None = None, hide_mesh: bool | None = None) -> Mapping[str, Any]:
        """Converts a closed reference mesh into a solid body (one step); fails with the reason otherwise."""
        return self.call("mesh.toSolid", {"meshId": mesh_id, "name": name, "hideMesh": hide_mesh})

    # ---- reference images (canvas) -------------------------------------------------------------
    def insert_image(
        self,
        path: str | Path,
        *,
        plane: Mapping[str, Any] | None = None,
        center: tuple[float, float] | None = None,
        width: float | None = None,
        rotation: float | None = None,
        opacity: float | None = None,
        name: str | None = None,
    ) -> Mapping[str, Any]:
        """A PNG/JPEG picture as a reference image (History step, stored in the project) on `plane`:
        `{"kind": "plane", "plane": "XY", "offset": 0}`, `{"kind": "face", "face": ...}` or
        `{"kind": "construction", "featureId": ...}`; `width` mm (the height follows), `opacity` 0.05-1."""
        return self.call(
            "image.insert",
            {
                **_file_params(Path(path)),
                "plane": dict(plane) if plane else None,
                "center": list(center) if center is not None else None,
                "width": width,
                "rotation": rotation,
                "opacity": opacity,
                "name": name,
            },
        )

    def calibrate_image(
        self, feature_id: str, a: tuple[float, ...], b: tuple[float, ...], distance: float
    ) -> Mapping[str, Any]:
        """Scales a reference image so points `a` and `b` (plane `(u, v)` or world `(x, y, z)`) are
        `distance` mm apart; it scales about `a`."""
        return self.call(
            "image.calibrate", {"featureId": feature_id, "a": list(a), "b": list(b), "distance": distance}
        )

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
