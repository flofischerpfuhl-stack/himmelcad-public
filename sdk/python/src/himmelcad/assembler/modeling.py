"""Idiomatic modelling layer for HimmelCAD Assembler â€” familiar to CadQuery/build123d users.

Every modelling call issues exactly **one** canonical command (``feature.create``,
``feature.edit``, ``sketch.addProfile`` â€¦) through :class:`AssemblerClient`;
``Document.log`` records them. The result is a normal parametric feature history
â€” sketches, extrudes, fillets â€” that opens and stays editable in the desktop app.
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
        """Items with the largest centre coordinate along ``axis`` (ties kept) â€” CadQuery ``>Z``."""
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
        """Faces, optionally by server-side selector (``">Z"``, ``"+Y"``, ``"%CYLINDER"``â€¦)."""
        return FaceSet(Face.from_wire(f) for f in self.doc.client.faces(self.id, select))

    def face(self, select: str) -> Face:
        faces = self.faces(select)
        if len(faces) != 1:
            raise NotFoundError(raw_code="referenceNotFound", message=f"selector {select!r} matched {len(faces)} faces of {self.id}", hint="Combine terms with ' and ' or filter the FaceSet in Python.", details={"candidates": [f.name for f in faces]})
        return faces[0]

    def edges(self, select: str | None = None) -> EdgeSet:
        """Edges, optionally by server-side selector (``"|Z"``, ``"%CIRCLE"``, ``"%LINE and >Z"``â€¦)."""
        return EdgeSet(Edge.from_wire(e) for e in self.doc.client.edges(self.id, select))


class Sketch:
    """A sketch; the first profile creates the sketch feature, later ones add profiles (one command each)."""

    def __init__(self, doc: Document, plane: Mapping[str, Any], on_body: str | None) -> None:
        self.doc = doc
        self.plane = dict(plane)
        self.on_body = on_body
        self.feature: Feature | None = None
        self.profiles: list[dict[str, Any]] = []

    @property
    def id(self) -> str:
        if self.feature is None:
            raise AssemblerError(raw_code="invalidParams", message="the sketch has no profile yet", hint="Add a rect/circle before extruding.")
        return self.feature.id

    def _add(self, profile: dict[str, Any]) -> int:
        if self.feature is None:
            result = self.doc.client.create_feature("sketch", {"plane": self.plane, "profiles": [profile]})
            self.feature = Feature(self.doc, result["featureId"], "sketch", result["name"])
        else:
            self.doc.client.add_profile(self.feature.id, profile)
        self.profiles.append(profile)
        return len(self.profiles) - 1

    def rect(self, width: float, height: float, *, center: tuple[float, float] = (0.0, 0.0)) -> int:
        """Axis-aligned rectangle centred on ``center`` (like CadQuery ``rect``). Returns the profile index."""
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

        Convenience macro: three canonical profile commands (a rectangle and two
        end circles); extruding the sketch fuses them into one slot. Each stays
        editable in the app.
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

    def edit_profile(self, index: int, **changes: Any) -> None:
        """Changes one profile's dimensions, e.g. ``s.edit_profile(0, width=90)``."""
        profile = {**self.profiles[index], **changes}
        self.doc.client.edit_profile(self.id, index, profile)
        self.profiles[index] = profile


class Transaction:
    """``with doc.transaction("Lid"):`` â€” staged, previewable, one undo step; cancelled on exceptions."""

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


class Document:
    """An Assembler document driven through canonical commands."""

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

    def extrude(self, profile: Sketch | Face, distance: float, *, op: str = "new", target: Body | None = None, symmetric: bool = False, profile_index: int | None = None, name: str | None = None, body_name: str | None = None) -> Body:
        """Extrudes a sketch (all profiles, or ``profile_index``) or pushes/pulls a planar face.

        ``op``: ``"new"`` body, ``"join"`` or ``"cut"`` (into ``target``; default: the
        body the sketch lies on, else the last changed body). Returns the new
        or modified body.
        """
        if isinstance(profile, Face):
            ref: dict[str, Any] = {"kind": "face", "face": profile.ref}
            target_id = profile.body_id
        else:
            ref = {"kind": "sketch", "featureId": profile.id}
            if profile_index is not None:
                ref["profileIndex"] = profile_index
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


__all__ = ["BBox", "Body", "Document", "Edge", "EdgeSet", "Face", "FaceSet", "Feature", "Sketch", "Transaction"]
