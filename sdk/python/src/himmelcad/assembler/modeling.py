"""Idiomatic modelling layer for HimmelCAD Assembler — familiar to CadQuery/build123d users.

Every modelling call issues exactly **one** canonical command (``feature.create``,
``feature.edit``, ``sketch.addProfile``, ``sketch.setDimension`` …) through :class:`AssemblerClient`
— except ``Sketch.edit_profile`` (one ``sketch.setDimension`` per changed dimension) and a
first ``polyline``/``line`` on a new sketch (which also creates the sketch feature);
``Document.log`` records them. The result is a normal parametric feature history
— sketches, extrudes, fillets — that opens and stays editable in the desktop app.
Nothing is baked into meshes, and there is no ``bpy`` emulation.

Conventions: millimetres, Z up. Sketches on the construction planes use
``XY`` (u=X, v=Y), ``XZ`` (u=X, v=Z), ``YZ`` (u=Y, v=Z); a sketch on an
axis-aligned planar face uses the same world axes as the parallel plane.

>>> with Document.headless() as doc:
...     s = doc.sketch("XY")
...     s.rect(80, 50)
...     plate = doc.extrude(s, 6)
...     doc.fillet(plate.edges("|Z"), 3)
...     doc.export_3mf("plate.3mf")
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

from .client import AssemblerClient
from .errors import AssemblerError, NotFoundError
from .printing import PrintToolsMixin

Vec3 = tuple[float, float, float]
_AXES = {"X": 0, "Y": 1, "Z": 2}


def _vec(value: Any) -> Vec3 | None:
    return None if value is None else (float(value[0]), float(value[1]), float(value[2]))


def _axis(axis: str) -> int:
    try:
        return _AXES[axis.upper()]
    except KeyError as error:
        raise ValueError(f"axis must be X, Y or Z, not {axis!r}") from error


@dataclass(frozen=True)
class BBox:
    min: Vec3
    max: Vec3

    @property
    def size(self) -> Vec3:
        return (self.max[0] - self.min[0], self.max[1] - self.min[1], self.max[2] - self.min[2])

    @property
    def center(self) -> Vec3:
        return ((self.max[0] + self.min[0]) / 2, (self.max[1] + self.min[1]) / 2, (self.max[2] + self.min[2]) / 2)


@dataclass(frozen=True)
class Face:
    """A B-rep face, addressed by its stable naming key (never an index)."""

    body_id: str
    key: str
    name: str
    surface: str
    normal: Vec3 | None
    centroid: Vec3
    area: float
    edge_keys: tuple[str, ...] = ()

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> Face:
        return cls(str(data["bodyId"]), str(data["key"]), str(data["name"]), str(data["surface"]), _vec(data.get("normal")), _vec(data["centroid"]) or (0.0, 0.0, 0.0), float(data["area"]), tuple(data.get("edgeKeys", ())))

    @property
    def ref(self) -> dict[str, str]:
        return {"bodyId": self.body_id, "key": self.key}


@dataclass(frozen=True)
class Edge:
    """A B-rep edge (key ``"<faceKeyA>|<faceKeyB>"``)."""

    body_id: str
    key: str
    name: str
    curve: str
    midpoint: Vec3
    length: float
    direction: Vec3 | None
    radius: float | None
    face_keys: tuple[str, ...] = ()

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> Edge:
        radius = data.get("radius")
        return cls(str(data["bodyId"]), str(data["key"]), str(data["name"]), str(data["curve"]), _vec(data["midpoint"]) or (0.0, 0.0, 0.0), float(data["length"]), _vec(data.get("direction")), None if radius is None else float(radius), tuple(data.get("faceKeys", ())))

    @property
    def ref(self) -> dict[str, str]:
        return {"bodyId": self.body_id, "key": self.key}


T = TypeVar("T", Face, Edge)


class _Selection(list[T]):
    """A list of faces/edges with chainable, CadQuery-flavoured filters (client side)."""

    def _position(self, item: T) -> Vec3:
        return item.centroid if isinstance(item, Face) else item.midpoint

    def _new(self, items: Iterable[T]) -> _Selection[T]:
        return type(self)(items)

    def filter(self, predicate: Callable[[T], bool] | None = None, **equals: Any) -> _Selection[T]:
        """``edges.filter(curve="circle")``, ``faces.filter(lambda f: f.area > 100)``."""
        return self._new(item for item in self if (predicate is None or predicate(item)) and all(getattr(item, k) == v for k, v in equals.items()))

    def max(self, axis: str, tolerance: float = 1e-6) -> _Selection[T]:
        """Items with the largest centre coordinate along ``axis`` (ties kept) — CadQuery ``>Z``."""
        if not self:
            return self._new(())
        i = _axis(axis)
        top = max(self._position(item)[i] for item in self)
        return self._new(item for item in self if abs(self._position(item)[i] - top) <= tolerance)

    def min(self, axis: str, tolerance: float = 1e-6) -> _Selection[T]:
        if not self:
            return self._new(())
        i = _axis(axis)
        low = min(self._position(item)[i] for item in self)
        return self._new(item for item in self if abs(self._position(item)[i] - low) <= tolerance)

    def sorted_by(self, axis: str) -> _Selection[T]:
        i = _axis(axis)
        return self._new(sorted(self, key=lambda item: self._position(item)[i]))

    def one(self) -> T:
        if len(self) != 1:
            raise ValueError(f"expected exactly one item, got {len(self)}: {[item.name for item in self]}")
        return self[0]

    def refs(self) -> list[dict[str, str]]:
        return [item.ref for item in self]


class FaceSet(_Selection[Face]):
    def planar(self) -> FaceSet:
        return FaceSet(f for f in self if f.surface == "plane")


class EdgeSet(_Selection[Edge]):
    def lines(self) -> EdgeSet:
        return EdgeSet(e for e in self if e.curve == "line")

    def circles(self) -> EdgeSet:
        return EdgeSet(e for e in self if e.curve == "circle")

    def of_face(self, face: Face) -> EdgeSet:
        """Boundary edges of ``face`` (CadQuery ``.faces(...).edges()``)."""
        return EdgeSet(e for e in self if face.key in e.face_keys)


class Feature:
    """A history card. ``edit`` changes its parameters; downstream features re-evaluate."""

    def __init__(self, doc: Document, feature_id: str, kind: str, name: str) -> None:
        self.doc, self.id, self.kind, self.name = doc, feature_id, kind, name

    def __repr__(self) -> str:
        return f"Feature({self.id!r}, kind={self.kind!r}, name={self.name!r})"

    @property
    def params(self) -> Mapping[str, Any]:
        return self.doc.client.feature(self.id)["params"]

    def edit(self, **params: Any) -> Feature:
        self.doc.client.edit_feature(self.id, params)
        return self

    def suppress(self, suppressed: bool = True) -> Feature:
        self.doc.client.suppress_feature(self.id, suppressed)
        return self

    def rename(self, name: str) -> Feature:
        self.doc.client.rename_feature(self.id, name)
        self.name = name
        return self

    def delete(self) -> None:
        self.doc.client.delete_feature(self.id)


class Body:
    """A solid body (id ``body:<creating feature id>``); geometry queries always read the current state."""

    def __init__(self, doc: Document, body_id: str, feature: Feature | None = None) -> None:
        self.doc, self.id, self.feature = doc, body_id, feature

    def __repr__(self) -> str:
        return f"Body({self.id!r})"

    def info(self) -> Mapping[str, Any]:
        return self.doc.client.body(self.id)

    @property
    def name(self) -> str:
        return str(self.info()["name"])

    @property
    def bbox(self) -> BBox:
        box = self.info()["bbox"]
        return BBox(_vec(box["min"]) or (0.0, 0.0, 0.0), _vec(box["max"]) or (0.0, 0.0, 0.0))

    @property
    def volume(self) -> float:
        return float(self.info()["volume"])

    @property
    def area(self) -> float:
        return float(self.info()["area"])

    @property
    def valid(self) -> bool:
        return bool(self.info()["valid"])

    def faces(self, select: str | None = None) -> FaceSet:
        """Faces, optionally by server-side selector (``">Z"``, ``"+Y"``, ``"%CYLINDER"``…)."""
        return FaceSet(Face.from_wire(f) for f in self.doc.client.faces(self.id, select))

    def face(self, select: str) -> Face:
        faces = self.faces(select)
        if len(faces) != 1:
            raise NotFoundError(raw_code="referenceNotFound", message=f"selector {select!r} matched {len(faces)} faces of {self.id}", hint="Combine terms with ' and ' or filter the FaceSet in Python.", details={"candidates": [f.name for f in faces]})
        return faces[0]

    def edges(self, select: str | None = None) -> EdgeSet:
        """Edges, optionally by server-side selector (``"|Z"``, ``"%CIRCLE"``, ``"%LINE and >Z"``…)."""
        return EdgeSet(Edge.from_wire(e) for e in self.doc.client.edges(self.id, select))


@dataclass(frozen=True)
class SketchLine:
    """A straight sketch line (construction lines included), usable as a revolve axis or pattern direction."""

    feature_id: str
    entity_id: str

    @property
    def ref(self) -> dict[str, str]:
        return {"kind": "sketchLine", "featureId": self.feature_id, "entityId": self.entity_id}


class Sketch:
    """A constrained sketch; the first shape creates the sketch feature, later ones are added (one command each).

    ``rect``/``circle`` add fully dimensioned shapes (position from the sketch origin + size);
    their dimensions stay editable by role (``s.edit_profile(0, width=90)``) or by name
    (``s.set_dimension("d3", 90)``). ``polyline``/``line`` add plain geometry (axis-aligned
    segments constrained horizontal/vertical); a ``construction`` line never bounds a profile.
    """

    def __init__(self, doc: Document, plane: Mapping[str, Any], on_body: str | None) -> None:
        self.doc = doc
        self.plane = dict(plane)
        self.on_body = on_body
        self.feature: Feature | None = None
        self.profiles: list[dict[str, Any]] = []
        #: Per shape: its dimension names by role (``{"x": "d1", "y": "d2", "width": "d3", "height": "d4"}``).
        self.dimensions: list[dict[str, str]] = []

    @property
    def id(self) -> str:
        if self.feature is None:
            raise AssemblerError(raw_code="invalidParams", message="the sketch has no geometry yet", hint="Add a rect/circle/polyline before using the sketch.")
        return self.feature.id

    def _ensure(self) -> str:
        if self.feature is None:
            result = self.doc.client.create_feature("sketch", {"plane": self.plane})
            self.feature = Feature(self.doc, result["featureId"], "sketch", result["name"])
        return self.feature.id

    def _add(self, profile: dict[str, Any]) -> int:
        if self.feature is None:
            result = self.doc.client.create_feature("sketch", {"plane": self.plane, "profiles": [profile]})
            self.feature = Feature(self.doc, result["featureId"], "sketch", result["name"])
            shapes = result.get("shapes") or [{}]
            shape = shapes[0]
        else:
            shape = self.doc.client.add_profile(self.feature.id, profile).get("shape") or {}
        self.profiles.append(profile)
        self.dimensions.append(dict(shape.get("dimensions") or {}))
        return len(self.profiles) - 1

    def rect(self, width: float, height: float, *, center: tuple[float, float] = (0.0, 0.0)) -> int:
        """Axis-aligned rectangle centred on ``center`` (like CadQuery ``rect``). Returns the shape index."""
        return self._add({"kind": "rectangle", "x": center[0] - width / 2, "y": center[1] - height / 2, "width": width, "height": height})

    def rect_corner(self, x: float, y: float, width: float, height: float) -> int:
        """Rectangle from corner ``(x, y)``."""
        return self._add({"kind": "rectangle", "x": x, "y": y, "width": width, "height": height})

    def circle(self, radius: float | None = None, *, d: float | None = None, center: tuple[float, float] = (0.0, 0.0)) -> int:
        if (radius is None) == (d is None):
            raise ValueError("give exactly one of radius or d")
        r = radius if radius is not None else d / 2  # type: ignore[operator]
        return self._add({"kind": "circle", "cx": center[0], "cy": center[1], "radius": r})

    def slot(self, length: float, width: float, *, center: tuple[float, float] = (0.0, 0.0), vertical: bool = False) -> list[int]:
        """Axis-aligned stadium slot (overall ``length`` x ``width``).

        Convenience macro: three shape commands (a rectangle and two end circles);
        the overlapping regions extrude together into one slot. Each stays editable
        in the app.
        """
        straight = max(length - width, 0.0)
        cx, cy = center
        if vertical:
            indices = [self.rect(width, straight, center=center)] if straight > 0 else []
            ends = [(cx, cy - straight / 2), (cx, cy + straight / 2)]
        else:
            indices = [self.rect(straight, width, center=center)] if straight > 0 else []
            ends = [(cx - straight / 2, cy), (cx + straight / 2, cy)]
        indices += [self.circle(width / 2, center=end) for end in ends]
        return indices

    def polyline(self, points: Sequence[tuple[float, float]], *, closed: bool = True, construction: bool = False) -> list[SketchLine]:
        """Connected lines through ``points`` (closed by default: a profile). Returns the lines."""
        result = self.doc.client.add_polyline(self._ensure(), list(points), closed=closed, construction=construction)
        return [SketchLine(self.id, line_id) for line_id in result.get("lineIds", [])]

    def line(self, start: tuple[float, float], end: tuple[float, float], *, construction: bool = False) -> SketchLine:
        """One line; ``construction=True`` makes a reference line, e.g. a revolve axis."""
        lines = self.polyline([start, end], closed=False, construction=construction)
        if not lines:
            raise AssemblerError(raw_code="internal", message="the server returned no line id")
        return lines[0]

    # ---- advanced geometry (one command each, the app's sketch-tool builders) ----

    def spline(self, points: Sequence[tuple[float, float]], *, control: bool = False, closed: bool = False, construction: bool = False) -> str:
        """Spline through ``points`` (or with them as control polygon, ``control=True``). Returns its entity id."""
        result = self.doc.client.add_spline(self._ensure(), list(points), mode="control" if control else "fit", closed=closed, construction=construction)
        return str(result["entityId"])

    def ellipse(self, major_radius: float, minor_radius: float, *, center: tuple[float, float] = (0.0, 0.0), angle: float = 0.0, arc: tuple[float, float] | None = None, dimension: bool = True, construction: bool = False) -> str:
        """Ellipse (``arc=(start°, end°)``: elliptical arc), axis radii dimensioned by default. Returns its entity id."""
        result = self.doc.client.add_ellipse(self._ensure(), center, major_radius, minor_radius, angle=angle, arc=arc, dimension=dimension, construction=construction)
        return str(result["entityId"])

    def slot_between(self, start: tuple[float, float], end: tuple[float, float], width: float, *, construction: bool = False) -> list[str]:
        """A true slot (one profile) between the centres ``start`` and ``end``, centre distance and width dimensioned."""
        return list(self.doc.client.add_slot(self._ensure(), start, end, width, construction=construction)["curveIds"])

    def arc_slot(self, center: tuple[float, float], start: tuple[float, float], end: tuple[float, float], width: float, *, clockwise: bool = False) -> list[str]:
        """An arc slot along the circle around ``center`` through ``start``, to the angle of ``end``."""
        return list(self.doc.client.add_slot(self._ensure(), start, end, width, arc_center=center, clockwise=clockwise)["curveIds"])

    def polygon(self, radius: float, sides: int = 6, *, center: tuple[float, float] = (0.0, 0.0), inscribed: bool = True, angle: float = 0.0) -> list[str]:
        """Regular polygon inscribed in (``inscribed=False``: around) a construction circle. Returns the line ids."""
        return list(self.doc.client.add_polygon(self._ensure(), center, radius, sides=sides, inscribed=inscribed, angle=angle)["lineIds"])

    def text(self, text: str, height: float, *, position: tuple[float, float] = (0.0, 0.0), angle: float = 0.0) -> str:
        """Text (cap ``height`` mm, baseline starting at ``position``); every glyph is a profile. Returns its entity id."""
        result = self.doc.client.add_text(self._ensure(), text, position, height, angle=angle)
        missing = result.get("missingCharacters") or []
        if missing:
            raise AssemblerError(raw_code="invalidParams", message=f"characters not in the font: {' '.join(missing)}", hint="Use Latin characters.")
        return str(result["entityId"])

    def mirror(self, ids: Sequence[str], axis: str | SketchLine) -> list[str]:
        """Mirrors curves/points about a sketch line (symmetric constraints). Returns the created ids."""
        axis_id = axis.entity_id if isinstance(axis, SketchLine) else axis
        return list(self.doc.client.mirror_sketch(self.id, list(ids), axis_id)["createdIds"])

    def pattern(self, ids: Sequence[str], count: int, *, spacing: float | None = None, direction: tuple[float, float] = (1.0, 0.0), center: tuple[float, float] | None = None, angle: float = 360.0) -> list[str]:
        """Linear pattern (``spacing`` along ``direction``) or circular (``center``, total ``angle``). Returns the created ids."""
        client = self.doc.client
        if center is not None:
            result = client.pattern_sketch(self.id, list(ids), count, mode="circular", center=center, angle=angle)
        else:
            if spacing is None:
                raise ValueError("a linear pattern needs spacing")
            result = client.pattern_sketch(self.id, list(ids), count, direction=direction, spacing=spacing)
        return list(result["createdIds"])

    def fillet_corner(self, point: str, radius: float) -> list[str]:
        """Rounds the corner at sketch point ``point`` between two lines."""
        return list(self.doc.client.round_corner(self.id, point, radius)["createdIds"])

    def chamfer_corner(self, point: str, distance: float) -> list[str]:
        """Bevels the corner at sketch point ``point`` (equal set-backs)."""
        return list(self.doc.client.round_corner(self.id, point, distance, mode="chamfer")["createdIds"])

    def project(self, source: Face | Edge, *, construction: bool = True) -> list[str]:
        """Projects a body face outline or edge into the sketch (follows the source). Returns the curve ids."""
        if isinstance(source, Face):
            result = self.doc.client.project(self._ensure(), face=source.ref, construction=construction)
        else:
            result = self.doc.client.project(self._ensure(), edge=source.ref, construction=construction)
        return list(result["entityIds"])

    def set_reference(self, name: str, reference: bool = True) -> None:
        """Makes dimension ``name`` a reference dimension (measures only), or driving again."""
        self.doc.client.set_reference(self.id, name, reference)

    def dimension(self, index: int, role: str) -> str:
        """Name of a shape's dimension (roles: rectangle x, y, width, height; circle cx, cy, diameter)."""
        try:
            return self.dimensions[index][role]
        except (IndexError, KeyError) as error:
            raise ValueError(f"shape {index} has no dimension {role!r}") from error

    def set_dimension(self, name: str, value: float | None = None, *, expression: str | None = None) -> Mapping[str, Any]:
        """Changes a dimension by name (``"d3"``) to a value or an expression over other names (``"d1 / 2"``)."""
        return self.doc.client.set_dimension(self.id, name, value=value, expression=expression)

    def edit_profile(self, index: int, **changes: Any) -> None:
        """Changes one shape's dimensions, e.g. ``s.edit_profile(0, width=90)`` (one command per dimension).

        Rectangle: ``x``, ``y`` (corner), ``width``, ``height``; circle: ``cx``, ``cy``, ``radius``/``d``.
        """
        for key, value in changes.items():
            role, amount = key, float(value)
            if key == "radius":
                role, amount = "diameter", 2 * float(value)
            elif key == "d":
                role = "diameter"
            self.set_dimension(self.dimension(index, role), abs(amount))
        self.profiles[index] = {**self.profiles[index], **changes}

    def regions(self) -> list[Mapping[str, Any]]:
        """The sketch's closed regions (profiles) with their stable keys."""
        for sketch in self.doc.client.sketches():
            if sketch["featureId"] == self.id:
                return list(sketch.get("regions", []))
        return []

class Transaction:
    """``with doc.transaction("Lid"):`` — staged, previewable, one undo step; cancelled on exceptions."""

    def __init__(self, doc: Document, label: str | None) -> None:
        self.doc, self.label = doc, label
        self.id: str | None = None
        self.result: Mapping[str, Any] | None = None
        self._done = False

    def __enter__(self) -> Transaction:
        self.id = str(self.doc.client.begin(self.label)["transactionId"])
        return self

    def preview(self) -> Mapping[str, Any]:
        return self.doc.client.preview()

    def cancel(self) -> None:
        if not self._done:
            self.doc.client.cancel()
            self._done = True

    def __exit__(self, exc_type: object, _exc: object, _tb: object) -> None:
        if self._done:
            return
        if exc_type is not None:
            self.cancel()
            return
        self.result = self.doc.client.commit()
        self._done = True


@dataclass
class _LoggedCall:
    method: str
    params: Mapping[str, Any]


class Document(PrintToolsMixin):
    """An Assembler document driven through canonical commands (print-part helpers: :mod:`.printing`)."""

    def __init__(self, client: AssemblerClient) -> None:
        self.client = client
        self.log: list[_LoggedCall] = []
        previous = client.on_call

        def record(method: str, params: Mapping[str, Any], result: Any) -> None:
            self.log.append(_LoggedCall(method, params))
            if previous is not None:
                previous(method, params, result)

        client.on_call = record
        if client.session is None:
            client.hello()

    # ---- construction ------------------------------------------------------------------
    @classmethod
    def headless(cls, command: list[str] | None = None, *, name: str | None = None) -> Document:
        """Starts ``assembler-headless`` (in-process OCCT, no GUI) with an empty document."""
        doc = cls(AssemblerClient.headless(command))
        if name:
            doc.client.new_project(name)
        return doc

    @classmethod
    def connect_app(cls, connection: str | None = None) -> Document:
        """Drives the document open in the desktop app (Agent access must be on)."""
        return cls(AssemblerClient.connect_app(connection))

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> Document:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    @property
    def commands(self) -> list[str]:
        """Methods issued so far that change or export the document (for benchmarks/audits)."""
        reads = {"api.hello", "api.describe", "document.get", "features.list", "feature.get", "bodies.list", "body.get", "faces.list", "edges.list", "sketches.list", "selection.get"}
        return [call.method for call in self.log if call.method not in reads]

    # ---- sketches and features -------------------------------------------------------------
    def sketch(self, plane: str | Face = "XY", offset: float = 0.0) -> Sketch:
        """A sketch on ``"XY"``/``"XZ"``/``"YZ"`` (at ``offset`` mm) or on a planar :class:`Face`."""
        if isinstance(plane, Face):
            return Sketch(self, {"kind": "face", "face": plane.ref}, plane.body_id)
        return Sketch(self, {"kind": "plane", "plane": plane.upper(), "offset": offset}, None)

    def _feature(self, result: Mapping[str, Any]) -> Feature:
        return Feature(self, str(result["featureId"]), str(result["kind"]), str(result["name"]))

    def extrude(self, profile: Sketch | Face, distance: float, *, op: str = "new", target: Body | None = None, symmetric: bool = False, regions: Sequence[str] | None = None, name: str | None = None, body_name: str | None = None) -> Body:
        """Extrudes a sketch (all regions, or the region keys in ``regions``) or pushes/pulls a planar face.

        ``op``: ``"new"`` body, ``"join"`` or ``"cut"`` (into ``target``; default: the
        body the sketch lies on, else the last changed body). Returns the new
        or modified body.
        """
        if isinstance(profile, Face):
            ref: dict[str, Any] = {"kind": "face", "face": profile.ref}
            target_id = profile.body_id
        else:
            ref = {"kind": "sketch", "featureId": profile.id}
            if regions is not None:
                ref["regions"] = list(regions)
            target_id = target.id if target else profile.on_body
        params: dict[str, Any] = {"profile": ref, "distance": distance, "symmetric": symmetric}
        if isinstance(profile, Sketch):
            params["operation"] = op
            if op != "new" and target_id:
                params["targetBodyId"] = target_id
            if body_name:
                params["resultBodyName"] = body_name
        result = self.client.create_feature("extrude", params, name=name)
        feature = self._feature(result)
        if isinstance(profile, Sketch) and op == "new":
            return Body(self, f"body:{feature.id}", feature)
        body_id = target_id or self._last_body_id(result)
        return Body(self, body_id, feature)

    def _last_body_id(self, result: Mapping[str, Any]) -> str:
        bodies = result.get("bodies") or []
        if not bodies:
            raise NotFoundError(raw_code="notFound", message="the document has no body")
        return str(bodies[-1]["id"])

    def join(self, sketch: Sketch, height: float, *, target: Body | None = None, **kwargs: Any) -> Body:
        """Extrudes ``sketch`` by ``height`` and fuses it into ``target`` (default: the sketch's body)."""
        return self.extrude(sketch, height, op="join", target=target, **kwargs)

    def cut(self, sketch: Sketch, depth: float, *, target: Body | None = None, **kwargs: Any) -> Body:
        """Cuts ``depth`` mm: into the material for a sketch on a face (against its outward
        normal), along the plane normal for a construction-plane sketch."""
        distance = -abs(depth) if sketch.on_body else abs(depth)
        return self.extrude(sketch, distance, op="cut", target=target, **kwargs)

    def revolve(self, profile: Sketch | Face, axis: str | Edge | SketchLine, angle: float = 360.0, *, op: str = "new", target: Body | None = None, regions: Sequence[str] | None = None, name: str | None = None, body_name: str | None = None) -> Body:
        """Revolves a sketch (all regions, or ``regions``) or a planar face about ``axis``:
        ``"X"``/``"Y"``/``"Z"`` (world axis through the origin), a straight/circular :class:`Edge`,
        or a :class:`SketchLine` (e.g. ``s.line((0, 0), (0, 10), construction=True)``)."""
        if isinstance(axis, str):
            axis_ref: dict[str, Any] = {"kind": "world", "axis": axis.upper()}
        elif isinstance(axis, Edge):
            axis_ref = {"kind": "edge", "edge": axis.ref}
        else:
            axis_ref = axis.ref
        if isinstance(profile, Face):
            ref: dict[str, Any] = {"kind": "face", "face": profile.ref}
            target_id = target.id if target else profile.body_id
        else:
            ref = {"kind": "sketch", "featureId": profile.id}
            if regions is not None:
                ref["regions"] = list(regions)
            target_id = target.id if target else profile.on_body
        params: dict[str, Any] = {"profile": ref, "axis": axis_ref, "angle": angle, "operation": op}
        if op != "new" and target_id:
            params["targetBodyId"] = target_id
        if body_name:
            params["resultBodyName"] = body_name
        result = self.client.create_feature("revolve", params, name=name)
        feature = self._feature(result)
        if op == "new":
            return Body(self, f"body:{feature.id}", feature)
        return Body(self, target_id or self._last_body_id(result), feature)

    @staticmethod
    def _edge_refs(edges: Edge | Iterable[Edge]) -> list[dict[str, str]]:
        items = [edges] if isinstance(edges, Edge) else list(edges)
        if not items:
            raise ValueError("no edges given (did a selector match nothing?)")
        return [e.ref for e in items]

    def fillet(self, edges: Edge | Iterable[Edge], radius: float, *, name: str | None = None) -> Feature:
        return self._feature(self.client.create_feature("fillet", {"edges": self._edge_refs(edges), "radius": radius}, name=name))

    def chamfer(self, edges: Edge | Iterable[Edge], distance: float, *, name: str | None = None) -> Feature:
        return self._feature(self.client.create_feature("chamfer", {"edges": self._edge_refs(edges), "distance": distance}, name=name))

    def shell(self, open_faces: Face | Iterable[Face], thickness: float, *, name: str | None = None) -> Feature:
        """Hollows the faces' body inwards, removing ``open_faces``."""
        faces = [open_faces] if isinstance(open_faces, Face) else list(open_faces)
        return self._feature(self.client.create_feature("shell", {"bodyId": faces[0].body_id, "faces": [f.ref for f in faces], "thickness": thickness}, name=name))

    def _boolean(self, operation: str, target: Body, tools: Sequence[Body], name: str | None) -> Feature:
        return self._feature(self.client.create_feature("boolean", {"operation": operation, "targetBodyId": target.id, "toolBodyIds": [t.id for t in tools]}, name=name))

    def union(self, target: Body, *tools: Body, name: str | None = None) -> Feature:
        return self._boolean("union", target, tools, name)

    def subtract(self, target: Body, *tools: Body, name: str | None = None) -> Feature:
        return self._boolean("subtract", target, tools, name)

    def intersect(self, target: Body, *tools: Body, name: str | None = None) -> Feature:
        return self._boolean("intersect", target, tools, name)

    def move(self, body: Body, dx: float = 0.0, dy: float = 0.0, dz: float = 0.0, *, name: str | None = None) -> Feature:
        return self._feature(self.client.create_feature("move", {"bodyId": body.id, "dx": dx, "dy": dy, "dz": dz}, name=name))

    def color(self, body: Body, rgb_hex: str, *, name: str | None = None) -> Feature:
        return self._feature(self.client.create_feature("setAppearance", {"bodyId": body.id, "color": rgb_hex}, name=name))

    def create(self, kind: str, *, name: str | None = None, **params: Any) -> Feature:
        """Any feature kind by its canonical params (for kinds without a helper yet)."""
        return self._feature(self.client.create_feature(kind, params, name=name))

    # ---- queries ------------------------------------------------------------------------------
    def info(self) -> Mapping[str, Any]:
        return self.client.document()

    def features(self) -> list[Feature]:
        return [Feature(self, f["id"], f["kind"], f["name"]) for f in self.client.features()]

    def feature(self, feature_id: str) -> Feature:
        f = self.client.feature(feature_id)
        return Feature(self, f["id"], f["kind"], f["name"])

    def bodies(self) -> list[Body]:
        return [Body(self, b["id"]) for b in self.client.bodies()]

    def body(self, name_or_id: str) -> Body:
        for b in self.client.bodies():
            if name_or_id in (b["id"], b["name"]):
                return Body(self, b["id"])
        raise NotFoundError(raw_code="notFound", message=f"no body {name_or_id!r}")

    def errors(self) -> dict[str, str]:
        """Per-feature evaluation errors of the current state (empty when everything evaluates)."""
        return {f["id"]: f["error"] for f in self.client.features() if f.get("error")}

    # ---- history, transactions, files ----------------------------------------------------------
    def undo(self) -> Mapping[str, Any]:
        return self.client.undo()

    def redo(self) -> Mapping[str, Any]:
        return self.client.redo()

    def transaction(self, label: str | None = None) -> Transaction:
        return Transaction(self, label)

    def export_stl(self, path: str | Path, bodies: Iterable[Body] | None = None) -> Path:
        return self.client.export_to("stl", path, body_ids=None if bodies is None else [b.id for b in bodies])

    def export_3mf(self, path: str | Path, bodies: Iterable[Body] | None = None) -> Path:
        return self.client.export_to("3mf", path, body_ids=None if bodies is None else [b.id for b in bodies])

    def export_step(self, path: str | Path, bodies: Iterable[Body] | None = None) -> Path:
        return self.client.export_to("step", path, body_ids=None if bodies is None else [b.id for b in bodies])

    def import_step(self, path: str | Path) -> list[Body]:
        result = self.client.import_step(path)
        feature = self._feature(result)
        return [Body(self, body_id, feature) for body_id in result.get("createdBodyIds", [])]

    def save(self, path: str | Path, *, name: str | None = None) -> Path:
        return self.client.save_project(path, name=name)

    def open(self, path: str | Path) -> Mapping[str, Any]:
        return self.client.open_project(path)

    def new(self, name: str | None = None) -> Mapping[str, Any]:
        return self.client.new_project(name)


__all__ = ["BBox", "Body", "Document", "Edge", "EdgeSet", "Face", "FaceSet", "Feature", "Sketch", "SketchLine", "Transaction"]
