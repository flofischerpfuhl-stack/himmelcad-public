"""Print-part helpers of :class:`~himmelcad.assembler.Document` (mixin).

Hole (standard metric sizes and printed fits), emboss/engrave (planar or
wrapped around a cylinder), draft, rib, thicken, and the Fillet/Chamfer/
Shell/Boolean variants. Like every modelling call, each helper issues
exactly **one** ``feature.create`` and returns the editable history feature.

The metric table holds **sizes only** (ISO 273 clearance holes, tap drills,
DIN 974-1 counterbores, ISO 15065 countersinks); ``thread=True`` stores a
cosmetic thread label, no thread geometry. Keep :data:`METRIC_HOLE_SIZES`
in sync with ``apps/assembler/renderer/src/model/printFeatures.ts`` (a test
compares them).

>>> with Document.headless() as doc:                        # doctest: +SKIP
...     s = doc.sketch("XY"); s.rect(40, 30)
...     plate = doc.extrude(s, 5)
...     doc.hole(plate.face(">Z"), [(-10, 0), (10, 0)], size="M3", counterbore=True)
...     doc.fillet_by_rule(plate, 0.5, rule="convex")
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .client import AssemblerClient
    from .modeling import Body, Edge, Face, Feature, Sketch, SketchLine

#: thread -> (clearance close, normal, loose, tap drill, counterbore Ø, counterbore depth, countersink Ø), mm.
METRIC_HOLE_SIZES: dict[str, tuple[float, float, float, float, float, float, float]] = {
    "M2": (2.2, 2.4, 2.6, 1.6, 4.3, 2.4, 4.4),
    "M2.5": (2.7, 2.9, 3.1, 2.05, 5.0, 2.9, 5.5),
    "M3": (3.2, 3.4, 3.6, 2.5, 6.5, 3.4, 6.3),
    "M4": (4.3, 4.5, 4.8, 3.3, 8.0, 4.4, 9.4),
    "M5": (5.3, 5.5, 5.8, 4.2, 10.0, 5.4, 10.4),
    "M6": (6.4, 6.6, 7.0, 5.0, 11.0, 6.4, 12.6),
    "M8": (8.4, 9.0, 10.0, 6.8, 15.0, 8.4, 17.3),
    "M10": (10.5, 11.0, 12.0, 8.5, 18.0, 10.4, 20.0),
}

#: Printed fits around a pin of the nominal diameter (added to it), FDM starting points.
PRINT_FITS: dict[str, float] = {"press": 0.0, "snug": 0.1, "clearance": 0.2, "loose": 0.4}

_ISO_FITS = {"close": 0, "normal": 1, "loose-iso": 2, "tap": 3}


def hole_diameter(size: str, fit: str = "normal") -> float:
    """Diameter of a standard hole: ISO fits ``close``/``normal``/``loose-iso``/``tap`` or a printed fit
    (``press``, ``snug``, ``clearance``, ``loose``) around a pin of the nominal size."""
    if size not in METRIC_HOLE_SIZES:
        raise ValueError(f"unknown size {size!r}; one of {', '.join(METRIC_HOLE_SIZES)}")
    if fit in _ISO_FITS:
        return METRIC_HOLE_SIZES[size][_ISO_FITS[fit]]
    if fit in PRINT_FITS:
        return round(float(size[1:]) + PRINT_FITS[fit], 3)
    raise ValueError(f"unknown fit {fit!r}; one of {', '.join([*_ISO_FITS, *PRINT_FITS])}")


def _face_list(faces: Face | Iterable[Face]) -> list[Face]:
    from .modeling import Face

    items = [faces] if isinstance(faces, Face) else list(faces)
    if not items:
        raise ValueError("no faces given (did a selector match nothing?)")
    return items


def _edge_refs(edges: Edge | Iterable[Edge]) -> list[dict[str, str]]:
    from .modeling import Edge

    items = [edges] if isinstance(edges, Edge) else list(edges)
    if not items:
        raise ValueError("no edges given (did a selector match nothing?)")
    return [e.ref for e in items]


class PrintToolsMixin:
    """Print-part modelling helpers; mixed into :class:`~himmelcad.assembler.Document`."""

    client: AssemblerClient

    def _feature(self, result: Mapping[str, Any]) -> Feature:  # pragma: no cover - provided by Document
        raise NotImplementedError

    # ---- holes --------------------------------------------------------------------------
    def hole(
        self,
        face: Face,
        at: Sequence[tuple[float, float]] | None = None,
        *,
        sketch: Sketch | None = None,
        size: str | None = None,
        fit: str = "normal",
        diameter: float | None = None,
        depth: float | None = None,
        counterbore: bool | tuple[float, float] = False,
        countersink: bool | tuple[float, float] = False,
        thread: bool = False,
        name: str | None = None,
    ) -> Feature:
        """Holes in a planar ``face`` at ``at`` (u, v points in the face frame: world X/Y on a top face)
        and/or at the circle centres and free points of ``sketch``.

        Size: ``diameter`` in mm, or a standard ``size`` (``"M2"`` ... ``"M10"``) with a ``fit``
        (see :func:`hole_diameter`). ``depth=None`` drills through all. ``counterbore``/``countersink``:
        ``True`` for the standard head of ``size``, or explicit ``(diameter, depth)`` /
        ``(diameter, angle)``. ``thread=True`` stores a cosmetic ``size`` thread label (no geometry).
        """
        placements: list[dict[str, Any]] = [{"kind": "point", "u": float(u), "v": float(v)} for u, v in (at or [])]
        if sketch is not None:
            placements += self._sketch_hole_points(sketch)
        if not placements:
            raise ValueError("give hole positions (at=[(u, v)]) or a sketch with points/circles")
        if diameter is None:
            if size is None:
                raise ValueError("give a diameter or a standard size")
            diameter = hole_diameter(size, fit)
        row = METRIC_HOLE_SIZES.get(size or "")
        params: dict[str, Any] = {
            "face": face.ref,
            "placements": placements,
            "diameter": diameter,
            "holeType": "simple",
            "extent": {"kind": "through"} if depth is None else {"kind": "blind", "depth": depth},
        }
        if counterbore:
            cb = counterbore if isinstance(counterbore, tuple) else ((row[4], row[5]) if row else (diameter * 1.9, diameter))
            params.update(holeType="counterbore", counterboreDiameter=cb[0], counterboreDepth=cb[1])
        elif countersink:
            cs = countersink if isinstance(countersink, tuple) else ((row[6], 90.0) if row else (diameter * 1.9, 90.0))
            params.update(holeType="countersink", countersinkDiameter=cs[0], countersinkAngle=cs[1])
        if thread:
            if size is None:
                raise ValueError("a cosmetic thread label needs a standard size")
            params["thread"] = size
        if size is not None:
            params["preset"] = f"{size} {fit}"
        return self._feature(self.client.create_feature("hole", params, name=name))

    def _sketch_hole_points(self, sketch: Sketch) -> list[dict[str, Any]]:
        entities = self.client.feature(sketch.id)["params"].get("entities", [])
        used: set[str] = set()
        for e in entities:
            if e["kind"] == "line":
                used.update((e["a"], e["b"]))
            elif e["kind"] == "arc":
                used.update((e["start"], e["end"]))
        centres = {e["center"] for e in entities if e["kind"] in ("circle", "arc")}
        out = [{"kind": "sketchPoint", "featureId": sketch.id, "entityId": e["id"]} for e in entities if e["kind"] == "circle" and not e.get("construction")]
        out += [
            {"kind": "sketchPoint", "featureId": sketch.id, "entityId": e["id"]}
            for e in entities
            if e["kind"] == "point" and e["id"] not in used and e["id"] not in centres and not e.get("construction")
        ]
        return out

    # ---- emboss / engrave -------------------------------------------------------------------
    def emboss(self, profile: Sketch, face: Face, depth: float, *, regions: Sequence[str] | None = None, name: str | None = None) -> Feature:
        """Raises the sketch profiles by ``depth`` on a planar face (sketch parallel to it) or wrapped
        around a cylindrical face (sketch plane parallel to the axis). Negative ``depth`` engraves."""
        ref: dict[str, Any] = {"kind": "sketch", "featureId": profile.id}
        if regions is not None:
            ref["regions"] = list(regions)
        return self._feature(self.client.create_feature("emboss", {"profile": ref, "face": face.ref, "depth": depth}, name=name))

    def engrave(self, profile: Sketch, face: Face, depth: float, **kwargs: Any) -> Feature:
        """:meth:`emboss` into the material (``depth`` mm deep)."""
        return self.emboss(profile, face, -abs(depth), **kwargs)

    # ---- draft, rib, thicken -------------------------------------------------------------------
    def draft(self, faces: Face | Iterable[Face], angle: float, *, neutral: Face | str = "XY", offset: float = 0.0, flip: bool = False, name: str | None = None) -> Feature:
        """Tilts side faces by ``angle`` degrees about the neutral plane (a face, e.g. the bottom, or
        ``"XY"``/``"XZ"``/``"YZ"`` at ``offset``). Positive narrows the part away from the neutral plane."""
        from .modeling import Face

        plane: dict[str, Any] = {"kind": "face", "face": neutral.ref} if isinstance(neutral, Face) else {"kind": "plane", "plane": neutral.upper(), "offset": offset}
        items = _face_list(faces)
        return self._feature(self.client.create_feature("draft", {"faces": [f.ref for f in items], "neutral": plane, "angle": angle, "flip": flip}, name=name))

    def rib(self, lines: SketchLine | Iterable[SketchLine], thickness: float, *, flip: bool = False, target: Body | None = None, name: str | None = None) -> Feature:
        """A rib/gusset from open sketch lines, ``thickness`` across the sketch plane, filled to the body."""
        from .modeling import SketchLine

        items = [lines] if isinstance(lines, SketchLine) else list(lines)
        if not items:
            raise ValueError("no rib lines given")
        sketch_ids = {line.feature_id for line in items}
        if len(sketch_ids) != 1:
            raise ValueError("all rib lines must belong to one sketch")
        params: dict[str, Any] = {"sketchId": items[0].feature_id, "entityIds": [line.entity_id for line in items], "thickness": thickness, "flip": flip}
        if target is not None:
            params["targetBodyId"] = target.id
        return self._feature(self.client.create_feature("rib", params, name=name))

    def thicken(self, source: Face | Iterable[Face] | Sketch, thickness: float, *, direction: str = "outside", op: str = "new", target: Body | None = None, name: str | None = None) -> Feature:
        """Faces (or a sketch's profiles) thickened into a solid: ``direction`` outside/inside/both."""
        from .modeling import Sketch

        if isinstance(source, Sketch):
            src: dict[str, Any] = {"kind": "profile", "profile": {"kind": "sketch", "featureId": source.id}}
        else:
            src = {"kind": "faces", "faces": [f.ref for f in _face_list(source)]}
        params: dict[str, Any] = {"source": src, "thickness": thickness, "direction": direction, "operation": op}
        if op != "new" and target is not None:
            params["targetBodyId"] = target.id
        return self._feature(self.client.create_feature("thicken", params, name=name))

    # ---- fillet / chamfer / shell / boolean variants -------------------------------------------
    def fillet_variable(self, edges: Edge | Iterable[Edge], start_radius: float, end_radius: float, *, name: str | None = None) -> Feature:
        """Fillet whose radius changes linearly from ``start_radius`` to ``end_radius`` along each edge chain."""
        return self._feature(self.client.create_feature("fillet", {"edges": _edge_refs(edges), "radius": start_radius, "radius2": end_radius}, name=name))

    def fillet_by_rule(self, target: Body | Face | Iterable[Face], radius: float, *, rule: str = "concave", name: str | None = None) -> Feature:
        """Fillets edges chosen by rule, re-evaluated on every edit: every edge of the given faces, or every
        ``"concave"`` (inside) / ``"convex"`` (outside) edge of a body."""
        from .modeling import Body

        if isinstance(target, Body):
            if rule not in ("concave", "convex"):
                raise ValueError("rule must be 'concave' or 'convex' for a body")
            rules: list[dict[str, Any]] = [{"kind": rule, "bodyId": target.id}]
        else:
            rules = [{"kind": "faceEdges", "face": f.ref} for f in _face_list(target)]
        return self._feature(self.client.create_feature("fillet", {"edges": [], "radius": radius, "rules": rules}, name=name))

    def chamfer_two_distances(self, edges: Edge | Iterable[Edge], distance1: float, distance2: float, *, flip: bool = False, name: str | None = None) -> Feature:
        """Asymmetric chamfer; ``flip`` measures ``distance1`` on the other face of each edge."""
        params: dict[str, Any] = {"edges": _edge_refs(edges), "distance": distance1, "mode": "twoDistances", "distance2": distance2}
        if flip:
            params["flip"] = True
        return self._feature(self.client.create_feature("chamfer", params, name=name))

    def chamfer_distance_angle(self, edges: Edge | Iterable[Edge], distance: float, angle: float, *, flip: bool = False, name: str | None = None) -> Feature:
        """Chamfer of ``distance`` on one face at ``angle`` degrees from it."""
        params: dict[str, Any] = {"edges": _edge_refs(edges), "distance": distance, "mode": "distanceAngle", "angle": angle}
        if flip:
            params["flip"] = True
        return self._feature(self.client.create_feature("chamfer", params, name=name))

    def shell_walls(self, open_faces: Face | Iterable[Face], thickness: float, *, outward: bool = False, walls: Mapping[Face, float] | None = None, name: str | None = None) -> Feature:
        """Shell with walls growing ``outward`` (the body becomes the cavity) and/or walls of their own
        thickness (``walls={face: mm}``)."""
        faces = _face_list(open_faces)
        params: dict[str, Any] = {"bodyId": faces[0].body_id, "faces": [f.ref for f in faces], "thickness": thickness}
        if outward:
            params["direction"] = "outside"
        if walls:
            params["faceThickness"] = [{"face": f.ref, "thickness": t} for f, t in walls.items()]
        return self._feature(self.client.create_feature("shell", params, name=name))

    def boolean(self, operation: str, target: Body, *tools: Body, keep_tools: bool = False, name: str | None = None) -> Feature:
        """Union/subtract/intersect of ``tools`` into ``target``; ``keep_tools`` keeps the tool bodies."""
        if operation not in ("union", "subtract", "intersect"):
            raise ValueError("operation must be union, subtract or intersect")
        params: dict[str, Any] = {"operation": operation, "targetBodyId": target.id, "toolBodyIds": [t.id for t in tools]}
        if keep_tools:
            params["keepTools"] = True
        return self._feature(self.client.create_feature("boolean", params, name=name))


__all__ = ["METRIC_HOLE_SIZES", "PRINT_FITS", "PrintToolsMixin", "hole_diameter"]
