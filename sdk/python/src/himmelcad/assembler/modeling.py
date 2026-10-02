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
from .interop import InteropMixin
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


class Parameter:
    """A document parameter ("variable"): a named value usable from sketch dimension
    expressions and extrude/fillet/chamfer/shell size fields (``"wall * 2"``)."""

    def __init__(self, doc: Document, data: Mapping[str, Any]) -> None:
        self.doc = doc
        self.id = str(data["id"])
        self.name = str(data["name"])
        self.unit = str(data["unit"])
        self.value = float(data["value"])
        self.expression = data.get("expression")

    def __repr__(self) -> str:
        suffix = f" = {self.expression}" if self.expression else ""
        return f"Parameter({self.name!r}{suffix} -> {self.value}{self.unit})"

    def _refresh(self, data: Mapping[str, Any]) -> Parameter:
        self.name = str(data["name"])
        self.unit = str(data["unit"])
        self.value = float(data["value"])
        self.expression = data.get("expression")
        return self

    def set(self, value: float | None = None, *, expression: str | None = None, unit: str | None = None) -> Parameter:
        """Changes the value/expression/unit as one undo step: every sketch whose dimensions use it is
        re-solved and every dependent feature re-evaluates. Raises :class:`SketchConflictError` (nothing
        changed) when a dependent sketch cannot take the new value."""
        result = self.doc.client.edit_parameter(self.id, value=value, expression=expression, unit=unit)
        return self._refresh(result["parameter"])

    def rename(self, name: str) -> Parameter:
        """Renames the parameter; every expression referencing it by name is rewritten."""
        result = self.doc.client.edit_parameter(self.id, name=name)
        return self._refresh(result["parameter"])

    def delete(self) -> None:
        """Removes the parameter; raises :class:`ConflictError` (with ``.details["usages"]``) if still used."""
        self.doc.client.delete_parameter(self.id)


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
        #: Assembly folders of an imported STEP part (`Document.import_step`), else empty.
        self.item_path: tuple[str, ...] = ()

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


class Datum:
    """A construction plane or axis (a History step without a body); ``ref`` plugs it into
    sketch planes, mirror/split planes and revolve/pattern/mirror axes."""

    def __init__(self, doc: Document, feature: Feature, kind: str) -> None:
        self.doc = doc
        self.feature = feature
        self.kind = kind

    def __repr__(self) -> str:
        return f"Datum({self.kind} {self.feature.id!r})"

    @property
    def id(self) -> str:
        return self.feature.id

    @property
    def ref(self) -> dict[str, str]:
        return {"kind": "construction", "featureId": self.feature.id}

    def info(self) -> Mapping[str, Any]:
        """``{featureId, kind, frame, center, size}`` as evaluated (``datums.list``)."""
        for datum in self.doc.datums():
            if datum.get("featureId") == self.feature.id:
                return datum
        raise NotFoundError(raw_code="notFound", message=f"datum {self.feature.id} not found")


@dataclass(frozen=True)
class MirroredSketch:
    """A mirrored sketch or face of a Mirror step: its profiles extrude/revolve like a sketch's."""

    id: str
    on_body: str | None = None


@dataclass(frozen=True)
class MirrorResult:
    feature: Feature
    sketches: list[MirroredSketch]


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
        #: What `Document.import_dxf` reported (curves, connected end points, units, skipped entities).
        self.import_report: dict[str, Any] | None = None
        #: Id of the last sketch pattern made with :meth:`pattern` (for :meth:`edit_pattern`).
        self.last_pattern_id: str | None = None

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

    def text(self, text: str, height: float, *, position: tuple[float, float] = (0.0, 0.0), angle: float = 0.0, font: str = "inter", align: str = "left") -> str:
        """Text (cap ``height`` mm, anchored at ``position`` on the baseline: its start, centre or end by ``align``);
        every glyph is a profile. ``font``: an id from ``client.fonts()``. Returns its entity id."""
        result = self.doc.client.add_text(self._ensure(), text, position, height, angle=angle, font=font, align=align)
        missing = result.get("missingCharacters") or []
        if missing:
            raise AssemblerError(raw_code="invalidParams", message=f"characters not in the font: {' '.join(missing)}", hint="Use Latin characters.")
        return str(result["entityId"])

    def mirror(self, ids: Sequence[str], axis: str | SketchLine) -> list[str]:
        """Mirrors curves/points about a sketch line (symmetric constraints). Returns the created ids."""
        axis_id = axis.entity_id if isinstance(axis, SketchLine) else axis
        return list(self.doc.client.mirror_sketch(self.id, list(ids), axis_id)["createdIds"])

    def pattern(self, ids: Sequence[str], count: int, *, spacing: float | None = None, direction: tuple[float, float] = (1.0, 0.0), count2: int | None = None, spacing2: float | None = None, direction2: tuple[float, float] = (0.0, 1.0), center: tuple[float, float] | None = None, angle: float = 360.0) -> list[str]:
        """Linear pattern (``spacing`` along ``direction``; with ``count2``/``spacing2`` a grid along
        ``direction2`` too) or circular (``center``, total ``angle``). Returns the created ids; the
        pattern's id is :attr:`last_pattern_id` (for :meth:`edit_pattern`)."""
        client = self.doc.client
        if center is not None:
            result = client.pattern_sketch(self.id, list(ids), count, mode="circular", center=center, angle=angle)
        else:
            if spacing is None:
                raise ValueError("a linear pattern needs spacing")
            if count2 is not None and spacing2 is None:
                raise ValueError("a second direction needs spacing2")
            result = client.pattern_sketch(self.id, list(ids), count, direction=direction, spacing=spacing, count2=count2, direction2=direction2 if count2 is not None else None, spacing2=spacing2)
        self.last_pattern_id = result.get("patternId")
        return list(result["createdIds"])

    def edit_pattern(self, pattern_id: str | None = None, *, count: int | None = None, count2: int | None = None, angle: float | None = None) -> Mapping[str, Any]:
        """Changes a sketch pattern (default: the last one made here); its copies are rebuilt."""
        target = pattern_id or self.last_pattern_id
        if not target:
            raise ValueError("no pattern id given and no pattern made on this sketch")
        return self.doc.client.edit_pattern(self.id, target, count=count, count2=count2, angle=angle)

    def offset(self, ids: Sequence[str], distance: float, *, side: str = "outside", single: bool = False) -> list[str]:
        """Offsets the chains through ``ids`` (each loop to ``side``: outside/inside for closed loops,
        left/right for open chains). Returns the created ids."""
        return list(self.doc.client.offset_sketch(self.id, list(ids), distance, side=side, single=single)["createdIds"])

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

class PrintReport:
    """Result of ``print.analyze`` with convenience accessors; ``raw`` is the full JSON."""

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw

    @property
    def findings(self) -> list[Mapping[str, Any]]:
        return list(self.raw.get("findings", []))

    def findings_of(self, kind: str) -> list[Mapping[str, Any]]:
        """Findings of one kind: ``overhang``, ``thinWall``, ``smallHole``, ``smallPin``, ``notWatertight``, ``invalidBrep``, ``buildVolume``, ``notOnPlate``."""
        return [f for f in self.findings if f.get("kind") == kind]

    @property
    def printable(self) -> bool:
        """No error-level findings (invalid B-rep, open mesh, does not fit the build volume)."""
        return not any(f.get("severity") == "error" for f in self.findings)

    @property
    def mass_g(self) -> float:
        return float(self.raw["totals"]["massG"])

    @property
    def cost(self) -> float:
        return float(self.raw["totals"]["cost"])

    def body(self, body: Body | str) -> Mapping[str, Any]:
        body_id = body if isinstance(body, str) else body.id
        for entry in self.raw.get("bodies", []):
            if entry["bodyId"] == body_id:
                return entry
        raise NotFoundError(raw_code="notFound", message=f"no body {body_id!r} in the report")


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


class Document(PrintToolsMixin, InteropMixin):
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
        """Starts ``assembler-headless`` (OCCT in a worker thread, no GUI) with an empty document."""
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
        reads = {"api.hello", "api.describe", "document.get", "features.list", "feature.get", "bodies.list", "body.get", "faces.list", "edges.list", "sketches.list", "selection.get", "print.analyze", "print.orientations", "export.meshStats", "parameters.list", "measure.get", "measure.distance", "measure.angle", "measure.area", "measure.volume"}
        return [call.method for call in self.log if call.method not in reads]

    # ---- parameters ---------------------------------------------------------------------
    def param(self, name: str, value: float | None = None, *, unit: str | None = None, expression: str | None = None) -> Parameter:
        """Gets, creates or edits a document parameter ("variable") by name.

        ``doc.param("wall", 2)`` creates ``wall`` (default unit ``"mm"``) or, if it
        already exists, sets its value to 2 — one canonical command either way
        (``parameter.create`` / ``parameter.edit``). ``doc.param("wall")`` (no
        value/expression/unit) just returns the existing parameter and raises
        :class:`NotFoundError` if there is none yet. ``doc.param("hole_d",
        expression="wall * 2")`` computes the value from other parameters.
        """
        existing = next((p for p in self.client.parameters() if p["name"] == name), None)
        if value is None and expression is None and unit is None:
            if existing is None:
                raise NotFoundError(raw_code="notFound", message=f'No parameter "{name}"', method="parameters.list")
            return Parameter(self, existing)
        if existing is None:
            result = self.client.create_parameter(name, unit=unit or "mm", value=value, expression=expression)
        else:
            result = self.client.edit_parameter(existing["id"], unit=unit, value=value, expression=expression)
        return Parameter(self, result["parameter"])

    @property
    def parameters(self) -> list[Parameter]:
        """Every document parameter, in creation order."""
        return [Parameter(self, p) for p in self.client.parameters()]

    # ---- measurement (the Measure panel's numbers; exact B-rep / kernel) ----------------------
    @staticmethod
    def _target(item: Body | Face | Edge | Sequence[float]) -> dict[str, Any]:
        if isinstance(item, Body):
            return {"kind": "body", "bodyId": item.id}
        if isinstance(item, Face):
            return {"kind": "face", "face": item.ref}
        if isinstance(item, Edge):
            return {"kind": "edge", "edge": item.ref}
        point = [float(v) for v in item]
        if len(point) != 3:
            raise ValueError("a point target is (x, y, z) in mm")
        return {"kind": "point", "point": point}

    def distance(self, a: Body | Face | Edge | Sequence[float], b: Body | Face | Edge | Sequence[float]) -> float:
        """Exact minimum distance in mm between bodies, faces, edges or points (kernel ``BRepExtrema``)."""
        return float(self.client.measure_distance(self._target(a), self._target(b))["distance"])

    def angle(self, a: Face | Edge, b: Face | Edge) -> float:
        """Angle in degrees between planar faces / straight edges (0 when parallel)."""
        return float(self.client.measure_angle(self._target(a), self._target(b))["angle"])

    def area(self, *faces: Face | FaceSet) -> float:
        """Exact total area in mm² of the faces (each counted once)."""
        refs = [f.ref for item in faces for f in (item if isinstance(item, FaceSet) else [item])]
        return float(self.client.measure_area(refs)["area"])

    def volume(self, *bodies: Body) -> Mapping[str, Any]:
        """Volume (mm³), mass (g, from the body material; PLA otherwise) and per-body rows; all bodies by default."""
        return self.client.measure_volume([b.id for b in bodies] if bodies else None)

    def measure(self, *items: Body | Face | Edge | Sequence[float]) -> Mapping[str, Any]:
        """Everything the Measure panel shows for these items (``values`` with label, value and unit)."""
        return self.client.measure([self._target(i) for i in items])

    # ---- sketches and features -------------------------------------------------------------
    def sketch(self, plane: str | Face | Datum = "XY", offset: float = 0.0) -> Sketch:
        """A sketch on ``"XY"``/``"XZ"``/``"YZ"`` (at ``offset`` mm), on a planar :class:`Face` or on a construction plane :class:`Datum`."""
        if isinstance(plane, Datum):
            return Sketch(self, plane.ref, None)
        if isinstance(plane, Face):
            return Sketch(self, {"kind": "face", "face": plane.ref}, plane.body_id)
        return Sketch(self, {"kind": "plane", "plane": plane.upper(), "offset": offset}, None)

    def _feature(self, result: Mapping[str, Any]) -> Feature:
        return Feature(self, str(result["featureId"]), str(result["kind"]), str(result["name"]))

    def extrude(self, profile: Sketch | MirroredSketch | Face, distance: float | None = None, *, expression: str | None = None, op: str = "new", target: Body | None = None, symmetric: bool = False, regions: Sequence[str] | None = None, name: str | None = None, body_name: str | None = None, through_all: bool = False, to: Face | Body | None = None, distance2: float | None = None, start_offset: float | None = None, taper: float | None = None) -> Body:
        """Extrudes a sketch (all regions, or the region keys in ``regions``) or pushes/pulls a planar face.

        ``distance`` or ``expression`` (a formula over ``doc.param(...)`` names, e.g.
        ``"wall * 2"``). ``op``: ``"new"`` body, ``"join"``, ``"cut"`` or
        ``"intersect"`` (with ``target``; default: the body the sketch lies on,
        else the last changed body). Extents (Shapr3D): ``through_all=True``
        goes through every body, ``to=`` a face (planar: its plane) or body
        stops at it — both in the direction of ``distance``'s sign (default
        +1). ``distance2`` extrudes the other side too (two sides),
        ``start_offset`` starts the extrude away from the profile. ``taper``
        (degrees) tilts the side walls: positive narrows the solid away from
        the start plane (holes widen), negative widens it (distance extents
        only). Returns the new or modified body.
        """
        if isinstance(profile, Face):
            ref: dict[str, Any] = {"kind": "face", "face": profile.ref}
            target_id = profile.body_id
        else:
            ref = {"kind": "sketch", "featureId": profile.id}
            if regions is not None:
                ref["regions"] = list(regions)
            target_id = target.id if target else profile.on_body
        params: dict[str, Any] = {"profile": ref, "symmetric": symmetric}
        if expression is not None:
            params["distanceExpression"] = expression
        else:
            params["distance"] = distance if distance is not None else 1.0
        if through_all and to is not None:
            raise ValueError("choose through_all or to=, not both")
        if through_all:
            params["extent"] = {"kind": "throughAll"}
        elif isinstance(to, Face):
            params["extent"] = {"kind": "toObject", "target": {"kind": "face", "face": to.ref}}
        elif isinstance(to, Body):
            params["extent"] = {"kind": "toObject", "target": {"kind": "body", "bodyId": to.id}}
        if distance2 is not None:
            params["distance2"] = distance2
        if start_offset is not None:
            params["startOffset"] = start_offset
        if taper:
            params["taper"] = taper
        if not isinstance(profile, Face) or op == "intersect":
            params["operation"] = op
            if op != "new" and target_id:
                params["targetBodyId"] = target_id
            if body_name:
                params["resultBodyName"] = body_name
        result = self.client.create_feature("extrude", params, name=name)
        feature = self._feature(result)
        if not isinstance(profile, Face) and op == "new":
            return Body(self, f"body:{feature.id}", feature)
        body_id = target_id or self._last_body_id(result)
        return Body(self, body_id, feature)

    # ---- construction planes and axes (Shapr3D "Construct") -------------------------------
    def _plane_ref(self, plane: str | Face | Datum | tuple[str, float]) -> dict[str, Any]:
        """``"XY"``/``"XZ"``/``"YZ"`` (or ``("XY", offset)``), a planar :class:`Face` or a plane :class:`Datum`."""
        if isinstance(plane, Datum):
            return plane.ref
        if isinstance(plane, Face):
            return {"kind": "face", "face": plane.ref}
        if isinstance(plane, tuple):
            return {"kind": "plane", "plane": plane[0].upper(), "offset": float(plane[1])}
        return {"kind": "plane", "plane": plane.upper(), "offset": 0.0}

    @staticmethod
    def _axis_ref(axis: str | Edge | SketchLine | Datum) -> dict[str, Any]:
        if isinstance(axis, str):
            return {"kind": "world", "axis": axis.upper()}
        if isinstance(axis, Edge):
            return {"kind": "edge", "edge": axis.ref}
        return dict(axis.ref)

    @staticmethod
    def _point_ref(point: Sequence[float] | Edge, near: Sequence[float] | None = None) -> dict[str, Any]:
        """A world point, or an :class:`Edge`: a circle's centre, else its midpoint (``near``: the end nearest to it)."""
        if isinstance(point, Edge):
            if near is not None:
                return {"kind": "edgeEnd", "edge": point.ref, "near": [float(v) for v in near]}
            return {"kind": "circleCenter" if point.curve == "circle" else "edgeMid", "edge": point.ref}
        return {"kind": "point", "point": [float(v) for v in point]}

    def _datum(self, kind: str, definition: dict[str, Any], flip: bool, name: str | None) -> Datum:
        params: dict[str, Any] = {"definition": definition}
        if flip:
            params["flip"] = True
        feature = self._feature(self.client.create_feature(kind, params, name=name))
        return Datum(self, feature, "plane" if kind == "constructionPlane" else "axis")

    def plane_offset(self, base: str | Face | Datum | tuple[str, float], distance: float, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction plane parallel to ``base`` (world plane, planar face or plane), ``distance`` along its normal."""
        return self._datum("constructionPlane", {"kind": "offset", "base": self._plane_ref(base), "distance": distance}, flip, name)

    def plane_angle(self, base: str | Face | Datum | tuple[str, float], axis: str | Edge | SketchLine | Datum, angle: float, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction plane through ``axis`` (parallel to ``base``), turned ``angle`` degrees from ``base``."""
        return self._datum("constructionPlane", {"kind": "angle", "base": self._plane_ref(base), "axis": self._axis_ref(axis), "angle": angle}, flip, name)

    def plane_through(self, a: Sequence[float] | Edge, b: Sequence[float] | Edge, c: Sequence[float] | Edge, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction plane through three points (world points or edges: circle centre / midpoint)."""
        points = [self._point_ref(p) for p in (a, b, c)]
        return self._datum("constructionPlane", {"kind": "threePoints", "points": points}, flip, name)

    def midplane(self, a: str | Face | Datum | tuple[str, float], b: str | Face | Datum | tuple[str, float], *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction plane halfway between two parallel planes/faces."""
        return self._datum("constructionPlane", {"kind": "midplane", "a": self._plane_ref(a), "b": self._plane_ref(b)}, flip, name)

    def plane_tangent(self, face: Face, angle: float = 0.0, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction plane tangent to a cylindrical face, ``angle`` degrees around its axis."""
        return self._datum("constructionPlane", {"kind": "tangent", "face": face.ref, "angle": angle}, flip, name)

    def axis_along(self, edge: Edge, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction axis along a straight edge (a circular edge: its axis)."""
        return self._datum("constructionAxis", {"kind": "edge", "edge": edge.ref}, flip, name)

    def axis_through(self, a: Sequence[float] | Edge, b: Sequence[float] | Edge, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction axis through two points."""
        return self._datum("constructionAxis", {"kind": "twoPoints", "a": self._point_ref(a), "b": self._point_ref(b)}, flip, name)

    def axis_of(self, face: Face, *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction axis of a cylindrical face (e.g. a hole)."""
        return self._datum("constructionAxis", {"kind": "cylinder", "face": face.ref}, flip, name)

    def axis_intersection(self, a: str | Face | Datum | tuple[str, float], b: str | Face | Datum | tuple[str, float], *, flip: bool = False, name: str | None = None) -> Datum:
        """Construction axis where two planes meet."""
        return self._datum("constructionAxis", {"kind": "planes", "a": self._plane_ref(a), "b": self._plane_ref(b)}, flip, name)

    def datums(self) -> list[Mapping[str, Any]]:
        """Construction planes/axes as evaluated (``datums.list``)."""
        return list(self.client.datums())

    def mirror(self, bodies: Iterable[Body] = (), *, plane: str | Face | Datum | tuple[str, float] = "YZ", axis: str | Edge | SketchLine | Datum | None = None, sketches: Iterable[Sketch] = (), faces: Iterable[Face] = (), keep: bool = True, name: str | None = None) -> MirrorResult:
        """Mirrors bodies, sketches and planar faces across ``plane`` (or about ``axis``: a half turn).

        Mirrored sketches/faces are profiles: ``result.sketches[i]`` (sketches first, then faces)
        can be extruded or revolved like a sketch.
        """
        sketch_list = list(sketches)
        face_list = list(faces)
        params: dict[str, Any] = {
            "bodyIds": [b.id for b in bodies],
            "plane": self._plane_ref(plane),
            "keepOriginal": keep,
        }
        if sketch_list:
            params["sketchIds"] = [s.id for s in sketch_list]
        if face_list:
            params["faces"] = [f.ref for f in face_list]
        if axis is not None:
            params["axis"] = self._axis_ref(axis)
        feature = self._feature(self.client.create_feature("mirror", params, name=name))
        derived = [MirroredSketch(f"{feature.id}:sketch:{i}") for i in range(len(sketch_list) + len(face_list))]
        return MirrorResult(feature, derived)

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

    def revolve(self, profile: Sketch | MirroredSketch | Face, axis: str | Edge | SketchLine | Datum, angle: float = 360.0, *, op: str = "new", target: Body | None = None, regions: Sequence[str] | None = None, name: str | None = None, body_name: str | None = None, pitch: float | None = None, turns: float | None = None, height: float | None = None, left_handed: bool = False) -> Body:
        """Revolves a sketch (all regions, or ``regions``) or a planar face about ``axis``:
        ``"X"``/``"Y"``/``"Z"`` (world axis through the origin), a straight/circular :class:`Edge`,
        or a :class:`SketchLine` (e.g. ``s.line((0, 0), (0, 10), construction=True)``).

        Helical revolve (springs, coils, thread ridges): give ``pitch`` (mm per turn; negative
        climbs against the axis) and ``turns`` or ``height`` (= ``|pitch| × turns``);
        ``left_handed`` for a left-hand helix. ``angle`` is then ignored."""
        helix: dict[str, Any] | None = None
        if pitch is not None:
            if turns is None and height is None:
                raise ValueError("a helix needs turns= or height=")
            count = turns if turns is not None else float(height) / abs(pitch)  # type: ignore[arg-type]
            helix = {"pitch": pitch, "turns": count}
            if left_handed:
                helix["leftHanded"] = True
        elif turns is not None or height is not None:
            raise ValueError("turns=/height= need pitch=")
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
        if helix is not None:
            params["helix"] = helix
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

    def fillet(self, edges: Edge | Iterable[Edge], radius: float | None = None, *, expression: str | None = None, name: str | None = None) -> Feature:
        """``radius`` or ``expression`` (a formula over ``doc.param(...)`` names, e.g. ``"wall / 2"``)."""
        params: dict[str, Any] = {"edges": self._edge_refs(edges)}
        if expression is not None:
            params["radiusExpression"] = expression
        else:
            params["radius"] = radius
        return self._feature(self.client.create_feature("fillet", params, name=name))

    def chamfer(self, edges: Edge | Iterable[Edge], distance: float | None = None, *, expression: str | None = None, name: str | None = None) -> Feature:
        """``distance`` or ``expression`` (a formula over ``doc.param(...)`` names)."""
        params: dict[str, Any] = {"edges": self._edge_refs(edges)}
        if expression is not None:
            params["distanceExpression"] = expression
        else:
            params["distance"] = distance
        return self._feature(self.client.create_feature("chamfer", params, name=name))

    def shell(self, open_faces: Face | Iterable[Face], thickness: float | None = None, *, expression: str | None = None, name: str | None = None) -> Feature:
        """Hollows the faces' body inwards, removing ``open_faces``. ``thickness`` or
        ``expression`` (a formula over ``doc.param(...)`` names)."""
        faces = [open_faces] if isinstance(open_faces, Face) else list(open_faces)
        params: dict[str, Any] = {"bodyId": faces[0].body_id, "faces": [f.ref for f in faces]}
        if expression is not None:
            params["thicknessExpression"] = expression
        else:
            params["thickness"] = thickness
        return self._feature(self.client.create_feature("shell", params, name=name))

    def offset_face(self, faces: Face | Iterable[Face], value: float, *, mode: str = "offset", opposite: Face | None = None, name: str | None = None) -> Feature:
        """Offset Face. ``mode="offset"``: moves the faces by ``value`` mm along their normals
        (negative removes material). With one face: ``"radius"``/``"diameter"`` set a cylindrical
        face to ``value``; ``"total"`` sets its distance to the parallel ``opposite`` face. Target
        values are re-measured on every evaluation."""
        items = [faces] if isinstance(faces, Face) else list(faces)
        params: dict[str, Any] = {"faces": [f.ref for f in items], "distance": value}
        if mode != "offset":
            params["mode"] = mode
        if opposite is not None:
            params["opposite"] = opposite.ref
        return self._feature(self.client.create_feature("offsetFace", params, name=name))

    def _boolean(self, operation: str, target: Body, tools: Sequence[Body], name: str | None, keep_target: bool = False, keep_tools: bool = False) -> Feature:
        params: dict[str, Any] = {"operation": operation, "targetBodyId": target.id, "toolBodyIds": [t.id for t in tools]}
        if keep_target:
            params["keepTarget"] = True
        if keep_tools:
            params["keepTools"] = True
        return self._feature(self.client.create_feature("boolean", params, name=name))

    def union(self, target: Body, *tools: Body, name: str | None = None, keep_target: bool = False, keep_tools: bool = False) -> Feature:
        """Fuses ``tools`` into ``target``; ``keep_target`` keeps the target and makes the result a new body ``body:<feature id>``."""
        return self._boolean("union", target, tools, name, keep_target, keep_tools)

    def subtract(self, target: Body, *tools: Body, name: str | None = None, keep_target: bool = False, keep_tools: bool = False) -> Feature:
        return self._boolean("subtract", target, tools, name, keep_target, keep_tools)

    def intersect(self, target: Body, *tools: Body, name: str | None = None, keep_target: bool = False, keep_tools: bool = False) -> Feature:
        return self._boolean("intersect", target, tools, name, keep_target, keep_tools)

    def move(self, body: Body, dx: float = 0.0, dy: float = 0.0, dz: float = 0.0, *, name: str | None = None) -> Feature:
        return self._feature(self.client.create_feature("move", {"bodyId": body.id, "dx": dx, "dy": dy, "dz": dz}, name=name))

    def scale(self, bodies: Body | Iterable[Body], factor: float | Sequence[float] = 1.0, *, center: Sequence[float] = (0.0, 0.0, 0.0), copy: bool = False, name: str | None = None) -> Feature:
        """Scales bodies about ``center``: ``factor`` a number (uniform) or ``(fx, fy, fz)`` per
        world axis (non-uniform; needs the HimmelCAD OCCT build). ``copy=True`` keeps the
        originals and adds scaled copies ``body:<feature id>:<i>`` (print fit tests)."""
        items = [bodies] if isinstance(bodies, Body) else list(bodies)
        params: dict[str, Any] = {"bodyIds": [b.id for b in items], "center": [float(v) for v in center], "copy": copy}
        if isinstance(factor, (int, float)):
            params["factor"] = float(factor)
        else:
            params["factor"] = 1.0
            params["factors"] = [float(v) for v in factor]
        return self._feature(self.client.create_feature("scale", params, name=name))

    def translate(self, bodies: Body | Iterable[Body], start: Sequence[float], end: Sequence[float], *, copy: bool = False, name: str | None = None) -> Feature:
        """Moves bodies point to point by ``end − start`` (world points, e.g. a vertex to another);
        ``copy=True`` keeps the originals and adds moved copies ``body:<feature id>:<i>``."""
        items = [bodies] if isinstance(bodies, Body) else list(bodies)
        params = {"bodyIds": [b.id for b in items], "from": [float(v) for v in start], "to": [float(v) for v in end], "copy": copy}
        return self._feature(self.client.create_feature("translate", params, name=name))

    def pattern_linear(self, bodies: Body | Iterable[Body], direction: str | Edge | SketchLine | Datum, count: int, spacing: float, *, total: bool = False, direction2: str | Edge | SketchLine | Datum | None = None, count2: int = 1, spacing2: float | None = None, direction3: str | Edge | SketchLine | Datum | None = None, count3: int = 1, spacing3: float | None = None, sketches: Sketch | Iterable[Sketch] | None = None, name: str | None = None) -> Feature:
        """Copies bodies ``count`` times along ``direction`` (``"X"``/``"Y"``/``"Z"``, an edge, …),
        ``spacing`` apart — or ``total=True``: ``spacing`` from the first to the last. ``direction2``
        with ``count2``/``spacing2`` makes a grid, ``direction3`` with ``count3``/``spacing3`` a
        block of layers (Shapr3D Pattern 3D: 1–3 directions, at most 1000 instances). ``sketches``
        patterns whole sketches too (derived sketches ``<step>:sketch:<n>``; ``bodies`` may be empty)."""
        items = [bodies] if isinstance(bodies, Body) else list(bodies)
        pattern: dict[str, Any] = {"kind": "linear", "direction": self._axis_ref(direction), "count": count, "spacing": spacing}
        if total:
            pattern["spacingMode"] = "total"
        if direction2 is not None:
            pattern["second"] = {"direction": self._axis_ref(direction2), "count": count2, "spacing": spacing if spacing2 is None else spacing2}
        if direction3 is not None:
            if direction2 is None:
                raise ValueError("a third direction needs direction2")
            pattern["third"] = {"direction": self._axis_ref(direction3), "count": count3, "spacing": spacing if spacing3 is None else spacing3}
        return self._feature(self.client.create_feature("pattern", self._pattern_params(items, sketches, pattern), name=name))

    @staticmethod
    def _pattern_params(items: Sequence[Body], sketches: Sketch | Iterable[Sketch] | None, pattern: dict[str, Any]) -> dict[str, Any]:
        params: dict[str, Any] = {"bodyIds": [b.id for b in items], "pattern": pattern}
        if sketches is not None:
            sketch_items = [sketches] if isinstance(sketches, Sketch) else list(sketches)
            params["sketchIds"] = [s.id for s in sketch_items]
        return params

    def pattern_circular(self, bodies: Body | Iterable[Body], axis: str | Edge | SketchLine | Datum, count: int, angle: float = 360.0, *, between: bool = False, uniform: bool = False, sketches: Sketch | Iterable[Sketch] | None = None, name: str | None = None) -> Feature:
        """Copies bodies ``count`` times about ``axis``: ``angle`` is the total (360 spreads them
        evenly) or with ``between=True`` the angle between neighbours; ``uniform=True`` keeps the
        copies' orientation (moved along the circle, not turned)."""
        items = [bodies] if isinstance(bodies, Body) else list(bodies)
        pattern: dict[str, Any] = {"kind": "circular", "axis": self._axis_ref(axis), "count": count, "angle": angle}
        if between:
            pattern["angleMode"] = "spacing"
        if uniform:
            pattern["uniform"] = True
        return self._feature(self.client.create_feature("pattern", self._pattern_params(items, sketches, pattern), name=name))

    def split(self, body: Body | Iterable[Body], plane: str | Face | Datum | tuple[str, float] = "XY", *, profile: Sketch | MirroredSketch | Face | None = None, regions: Sequence[str] | None = None, keep: bool = False, name: str | None = None) -> Feature:
        """Splits ``body`` into two bodies by ``plane`` (the positive side becomes ``body:<feature id>``)
        or by a sketch ``profile`` projected through the body (the inside becomes new); ``keep=True``
        keeps the original and makes both parts new bodies. Several bodies split with the same
        element in one step (each must be cut)."""
        items = [body] if isinstance(body, Body) else list(body)
        params: dict[str, Any] = {"bodyId": items[0].id, "plane": self._plane_ref(plane)}
        if len(items) > 1:
            params["bodyIds"] = [b.id for b in items[1:]]
        if profile is not None:
            if isinstance(profile, Face):
                params["profile"] = {"kind": "face", "face": profile.ref}
            else:
                ref: dict[str, Any] = {"kind": "sketch", "featureId": profile.id}
                if regions is not None:
                    ref["regions"] = list(regions)
                params["profile"] = ref
        if keep:
            params["keepOriginal"] = True
        return self._feature(self.client.create_feature("split", params, name=name))

    def _primitive(self, shape: str, sizes: dict[str, float], plane: str | Face | Datum | tuple[str, float], center: Sequence[float], op: str, target: Body | None, name: str | None, flip: bool | None = None) -> Body:
        params: dict[str, Any] = {"shape": shape, "plane": self._plane_ref(plane), "center": [float(v) for v in center], "operation": op, **sizes}
        # Like the Add tools: a cut on a face goes into the face (a pocket/hole) unless told otherwise.
        if flip if flip is not None else (op == "cut" and isinstance(plane, Face)):
            params["flip"] = True
        if op != "new":
            target_id = target.id if target else (plane.body_id if isinstance(plane, Face) else None)
            if target_id:
                params["targetBodyId"] = target_id
        result = self.client.create_feature("primitive", params, name=name)
        feature = self._feature(result)
        if op == "new":
            return Body(self, f"body:{feature.id}", feature)
        return Body(self, str(params.get("targetBodyId") or self._last_body_id(result)), feature)

    def box(self, width: float, depth: float, height: float, *, plane: str | Face | Datum | tuple[str, float] = "XY", center: Sequence[float] = (0.0, 0.0, 0.0), op: str = "new", target: Body | None = None, name: str | None = None, flip: bool | None = None) -> Body:
        """A box standing on ``plane``, its base centred at ``center`` (``width`` along the plane's u, ``depth`` along v)."""
        return self._primitive("box", {"width": width, "depth": depth, "height": height}, plane, center, op, target, name, flip)

    def cylinder(self, radius: float, height: float, *, plane: str | Face | Datum | tuple[str, float] = "XY", center: Sequence[float] = (0.0, 0.0, 0.0), op: str = "new", target: Body | None = None, name: str | None = None, flip: bool | None = None) -> Body:
        """A cylinder standing on ``plane`` (``op="cut"`` on a face makes a round pocket)."""
        return self._primitive("cylinder", {"radius": radius, "height": height}, plane, center, op, target, name, flip)

    def sphere(self, radius: float, *, plane: str | Face | Datum | tuple[str, float] = "XY", center: Sequence[float] = (0.0, 0.0, 0.0), op: str = "new", target: Body | None = None, name: str | None = None, flip: bool | None = None) -> Body:
        """A sphere resting on ``plane`` at ``center``."""
        return self._primitive("sphere", {"radius": radius}, plane, center, op, target, name, flip)

    def cone(self, radius: float, height: float, top_radius: float = 0.0, *, plane: str | Face | Datum | tuple[str, float] = "XY", center: Sequence[float] = (0.0, 0.0, 0.0), op: str = "new", target: Body | None = None, name: str | None = None, flip: bool | None = None) -> Body:
        """A cone (``top_radius`` 0) or frustum standing on ``plane``."""
        return self._primitive("cone", {"radius": radius, "radius2": top_radius, "height": height}, plane, center, op, target, name, flip)

    def torus(self, radius: float, tube_radius: float, *, plane: str | Face | Datum | tuple[str, float] = "XY", center: Sequence[float] = (0.0, 0.0, 0.0), op: str = "new", target: Body | None = None, name: str | None = None, flip: bool | None = None) -> Body:
        """A torus lying on ``plane``: ring ``radius``, ``tube_radius`` (smaller)."""
        return self._primitive("torus", {"radius": radius, "radius2": tube_radius}, plane, center, op, target, name, flip)

    def move_edge(self, edge: Edge, vector: Sequence[float], *, name: str | None = None) -> Feature:
        """Moves a straight edge between two planar faces by ``vector`` (world mm): both faces
        tilt about their far sides to follow it (Shapr3D Move on an edge)."""
        return self._feature(self.client.create_feature("moveEdge", {"edge": edge.ref, "vector": [float(v) for v in vector]}, name=name))

    def move_face(self, face: Face, vector: Sequence[float] = (0.0, 0.0, 0.0), *, turn: float | None = None, turn_axis: Sequence[float] | None = None, turn_point: Sequence[float] | None = None, name: str | None = None) -> Feature:
        """Moves a planar face by ``vector`` in any direction: along its normal it offsets,
        sideways its planar neighbours tilt to follow (Shapr3D Move on a face). ``turn`` (degrees,
        right-hand about ``turn_axis``, a direction in the face's plane, through ``turn_point``,
        default the face centre) then turns it; the neighbours follow. A round face (a hole wall
        or a boss) moves across its axis: the hole or boss moves."""
        params: dict[str, Any] = {"face": face.ref, "vector": [float(v) for v in vector]}
        if turn:
            if turn_axis is None:
                raise ValueError("turn= needs turn_axis= (a direction in the face's plane)")
            point = turn_point if turn_point is not None else face.centroid
            params["rotation"] = {"point": [float(v) for v in point], "axis": [float(v) for v in turn_axis], "angle": float(turn)}
        return self._feature(self.client.create_feature("moveFace", params, name=name))

    def copy_unlinked(self, body: Body, dx: float = 0.0, dy: float = 0.0, dz: float = 0.0, *, rx: float = 0.0, ry: float = 0.0, rz: float = 0.0, pivot: Sequence[float] | None = None, name: str | None = None) -> Body:
        """An unlinked copy of ``body`` (Shapr3D Move/Rotate copy with Link off): moved by
        ``dx/dy/dz`` and turned ``rx/ry/rz`` degrees about world X, Y, Z through ``pivot``
        (default its box centre). The copy keeps its exact geometry; later edits of the
        original's earlier steps do not change it."""
        params: dict[str, Any] = {"bodyId": body.id, "dx": dx, "dy": dy, "dz": dz, "rx": rx, "ry": ry, "rz": rz, "name": name}
        if pivot is not None:
            params["pivot"] = [float(v) for v in pivot]
        result = self.client.call("body.copyUnlinked", params)
        feature = Feature(self, str(result["featureId"]), "importStep", name or str(result["featureId"]))
        return Body(self, str(result["bodyId"]), feature)

    def _align_ref(self, ref: Face | Edge | SketchLine | Datum | str) -> dict[str, Any]:
        if isinstance(ref, Face):
            return {"kind": "face", "face": ref.ref}
        if isinstance(ref, Datum) and ref.kind == "plane":
            return {"kind": "plane", "plane": ref.ref}
        return {"kind": "axis", "axis": self._axis_ref(ref)}

    def align(self, moving: Face | Edge, target: Face | Edge | SketchLine | Datum | str, *, flip: bool = False, center: bool = True, offset: float = 0.0, turn: float = 0.0, name: str | None = None) -> Feature:
        """Align: moves the body of ``moving`` (a face or an edge of it) onto ``target`` (a face or
        edge of another body, a construction plane/axis, or ``"X"``/``"Y"``/``"Z"``). Planes land
        face to face (``flip``: same direction) with ``offset`` as a gap; axes (straight/round
        edges, cylindrical/conical faces) become coaxial (``flip`` turns end for end, ``offset``
        slides along the axis); a spherical face's centre goes onto a centre or an axis.
        ``center`` also brings the reference centres together; ``turn`` (degrees) then turns the
        body about the target normal or axis."""
        params: dict[str, Any] = {"bodyId": moving.body_id, "flip": flip, "center": center, "offset": offset}
        if turn:
            params["turn"] = turn
        if isinstance(moving, Face) and isinstance(target, Face) and moving.surface == "plane" and target.surface == "plane":
            params["face"] = moving.ref
            params["target"] = target.ref
        else:
            params["from"] = self._align_ref(moving)
            params["to"] = self._align_ref(target)
        return self._feature(self.client.create_feature("align", params, name=name))

    def replace_face(self, faces: Face | Iterable[Face], target: Face, *, name: str | None = None) -> Feature:
        """Replace Face: extends or trims planar ``faces`` (one body) until they lie on the surface
        of ``target`` (a planar or cylindrical face of any body). A planar target turns and offsets
        the faces (their neighbours follow); the replaced faces keep their keys."""
        items = [faces] if isinstance(faces, Face) else list(faces)
        params = {"faces": [f.ref for f in items], "target": target.ref}
        return self._feature(self.client.create_feature("replaceFace", params, name=name))

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

    def export_stl(self, path: str | Path, bodies: Iterable[Body] | None = None, *, ascii: bool = False, resolution: str | None = None) -> Path:
        """STL of the bodies in one file; ``resolution``: ``current``/``coarse``/``standard``/``fine``."""
        return self.client.export_to("stl", path, body_ids=None if bodies is None else [b.id for b in bodies], resolution=resolution, stl_format="ascii" if ascii else None)

    def export_3mf(self, path: str | Path, bodies: Iterable[Body] | None = None, *, resolution: str | None = None) -> Path:
        return self.client.export_to("3mf", path, body_ids=None if bodies is None else [b.id for b in bodies], resolution=resolution)

    # ---- 3D printing ------------------------------------------------------------------------------
    def printability(self, bodies: Iterable[Body] | None = None, **settings: Any) -> PrintReport:
        """Printability report; ``settings`` override the defaults (``overhangAngleDeg=50``, ``minWallMm=1.2``, ``material="PETG"`` …)."""
        report = self.client.print_analyze(body_ids=None if bodies is None else [b.id for b in bodies], settings=settings or None)
        return PrintReport(report)

    def place_on_plate(self, face: Face, *, name: str | None = None) -> Feature:
        """Lays a planar face flat on the build plate (one transform step; the body drops to Z = 0)."""
        result = self.client.place_on_plate(face.ref, name=name)
        return Feature(self, str(result["featureId"]), "transform", name or "Place on Plate")

    def orientations(self, body: Body, *, overhang_angle: float | None = None, limit: int = 3) -> list[Mapping[str, Any]]:
        """Candidate print orientations of ``body``, best first (overhang area, then height)."""
        return self.client.print_orientations(body.id, overhang_angle=overhang_angle, limit=limit)

    def orient(self, body: Body, *, rank: int | None = None, down: Vec3 | None = None, name: str | None = None) -> Feature:
        """Orients ``body`` for printing: the ``rank``-th candidate (default 1) or the outward direction ``down`` facing the plate."""
        if rank is None and down is None:
            rank = 1
        result = self.client.print_orient(body.id, rank=rank, down=down, name=name)
        return Feature(self, str(result["featureId"]), "transform", name or "Orient for Print")

    def mesh_stats(self, bodies: Iterable[Body] | None = None, *, resolution: str | None = None) -> Mapping[str, Any]:
        """Triangle counts and expected STL sizes for an export resolution (the export preview)."""
        return self.client.mesh_stats(body_ids=None if bodies is None else [b.id for b in bodies], resolution=resolution)

    # export_step / import_step / import_mesh / import_dxf / export_dxf / mesh_to_solid: InteropMixin (interop.py).

    def save(self, path: str | Path, *, name: str | None = None) -> Path:
        return self.client.save_project(path, name=name)

    def open(self, path: str | Path) -> Mapping[str, Any]:
        return self.client.open_project(path)

    def new(self, name: str | None = None) -> Mapping[str, Any]:
        return self.client.new_project(name)


__all__ = ["BBox", "Body", "Document", "Edge", "EdgeSet", "Face", "FaceSet", "Feature", "PrintReport", "Sketch", "SketchLine", "Transaction"]
