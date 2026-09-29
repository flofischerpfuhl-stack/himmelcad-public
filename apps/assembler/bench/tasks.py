"""Five printable-part benchmark tasks written against ``himmelcad.assembler``.

Each task models one part through the idiomatic Python layer (one canonical
command per call) and returns the bodies to check with their hand-calculated
expectations. Dimensions in millimetres. ``run_bench.py`` executes them
through the headless CLI, checks validity/bbox/volume, exports 3MF/STL,
saves ``.hcasm`` and runs the reopen-and-edit load test.
"""
from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from himmelcad.assembler import Body, Document


@dataclass
class Expectation:
    body: Body
    bbox_min: tuple[float, float, float]
    bbox_max: tuple[float, float, float]
    volume: float
    #: Relative tolerance of the hand calculation (curved faces are exact B-rep, so this is tight).
    volume_tolerance: float = 1e-4


@dataclass
class TaskResult:
    expectations: list[Expectation]
    #: A parametric edit for the load test: (sketch feature id, dimension name, new value,
    #: expected bbox size of body 0 after it) - the History panel's sketch dimension edit.
    edit: tuple[str, str, float, tuple[float, float, float]] | None = None
    notes: list[str] = field(default_factory=list)


def rounded_rect_area(w: float, h: float, r: float) -> float:
    return w * h - (4 - math.pi) * r * r


def enclosure_with_lid(doc: Document) -> TaskResult:
    """60 x 40 x 25 box, 4 mm vertical corner fillets, shelled 2 mm with the top open; a 2 mm lid
    with a 3 mm locating lip (0.2 mm clearance, 1.8 mm corner fillets) printed beside it."""
    s = doc.sketch("XY")
    s.rect(60, 40)
    box = doc.extrude(s, 25, body_name="Enclosure")
    doc.fillet(box.edges("|Z"), 4)
    doc.shell(box.face(">Z"), 2)

    lid_sketch = doc.sketch("XY")
    lid_sketch.rect(60, 40, center=(75, 0))
    lid = doc.extrude(lid_sketch, 2, body_name="Lid")
    doc.fillet(lid.edges("|Z"), 4)
    lip = doc.sketch(lid.face(">Z"))
    lip.rect(55.6, 35.6, center=(75, 0))
    doc.join(lip, 3)
    doc.fillet(lid.edges("|Z and >Z"), 1.8)

    box_volume = rounded_rect_area(60, 40, 4) * 25 - rounded_rect_area(56, 36, 2) * 23
    lid_volume = rounded_rect_area(60, 40, 4) * 2 + rounded_rect_area(55.6, 35.6, 1.8) * 3
    return TaskResult(
        [
            Expectation(box, (-30, -20, 0), (30, 20, 25), box_volume),
            Expectation(lid, (45, -20, 0), (105, 20, 5), lid_volume),
        ],
        edit=(s.id, s.dimension(0, "width"), 70, (70, 40, 25)),
    )


def bracket_with_slot(doc: Document) -> TaskResult:
    """L-bracket: 60 x 30 x 5 base, 40 mm upright, R4 inner fillet, 20 x 6 slot in the base,
    two 5 mm screw holes in the upright, R3 front corners."""
    s = doc.sketch("XY")
    s.rect_corner(0, 0, 60, 30)
    bracket = doc.extrude(s, 5, body_name="Bracket")
    upright = doc.sketch(bracket.face(">Z"))
    upright.rect_corner(0, 25, 60, 5)
    doc.join(upright, 40)
    inner = bracket.edges("|X").filter(lambda e: abs(e.midpoint[1] - 25) < 1e-6 and abs(e.midpoint[2] - 5) < 1e-6)
    doc.fillet(inner, 4)
    base_top = bracket.faces("+Z").min("Z").one()
    slot = doc.sketch(base_top)
    slot.slot(20, 6, center=(30, 12))
    doc.cut(slot, 5)
    front = bracket.faces("-Y").filter(lambda f: abs(f.centroid[1] - 25) < 1e-6 and f.centroid[2] > 10).one()
    holes = doc.sketch(front)
    holes.circle(d=5, center=(15, 30))
    holes.circle(d=5, center=(45, 30))
    doc.cut(holes, 5)
    doc.fillet(bracket.edges("|Z and <Y"), 3)

    volume = (
        60 * 30 * 5
        + 60 * 5 * 40
        + (16 - math.pi * 4) * 60
        - (14 * 6 + math.pi * 9) * 5
        - 2 * math.pi * 2.5**2 * 5
        - 2 * (9 - math.pi * 9 / 4) * 5
    )
    return TaskResult(
        [Expectation(bracket, (0, 0, 0), (60, 30, 45), volume)],
        edit=(s.id, s.dimension(0, "height"), 36, (60, 36, 45)),
        notes=["The slot is a sketch macro (rectangle + two circles; their overlapping regions extrude together)."],
    )


def pipe_adapter(doc: Document) -> TaskResult:
    """Reducer 30 -> 20 mm OD, 16 mm bore, 26 mm x 12 mm socket, 1 mm chamfers. Built from
    stacked extrusions."""
    s = doc.sketch("XY")
    s.circle(d=30)
    adapter = doc.extrude(s, 15, body_name="Adapter")
    neck = doc.sketch(adapter.face(">Z"))
    neck.circle(d=20)
    doc.join(neck, 20)
    bore = doc.sketch(adapter.face(">Z"))
    bore.circle(d=16)
    doc.cut(bore, 35)
    socket = doc.sketch(adapter.face("<Z"))
    socket.circle(d=26)
    doc.cut(socket, 12)
    top_outer = adapter.edges("%CIRCLE and >Z").filter(lambda e: e.radius is not None and abs(e.radius - 10) < 1e-6)
    doc.chamfer(top_outer, 1)
    step_outer = adapter.edges("%CIRCLE").filter(lambda e: abs(e.midpoint[2] - 15) < 1e-6 and e.radius is not None and abs(e.radius - 15) < 1e-6)
    doc.chamfer(step_outer, 1)

    ring = lambda r_centroid: 2 * math.pi * r_centroid * 0.5  # noqa: E731 - 1 x 1 mm chamfer ring
    volume = (
        math.pi * 15**2 * 15
        + math.pi * 10**2 * 20
        - math.pi * 8**2 * 35
        - math.pi * (13**2 - 8**2) * 12
        - ring(10 - 1 / 3)
        - ring(15 - 1 / 3)
    )
    return TaskResult(
        [Expectation(adapter, (-15, -15, 0), (15, 15, 35), volume)],
        edit=(neck.id, neck.dimension(0, "diameter"), 22, (30, 30, 35)),
        notes=["Stacked cylinder extrusions (same printed result as a revolve; kept for comparability with earlier runs)."],
    )


def phone_stand(doc: Document) -> TaskResult:
    """80 x 70 x 6 base, 8 mm back rest 80 mm high, 14 mm front lip with a 16 mm cable notch,
    R5/R3 inner fillets. Upright back rest."""
    s = doc.sketch("XY")
    s.rect_corner(0, 0, 80, 70)
    stand = doc.extrude(s, 6, body_name="Phone stand")
    top = stand.face(">Z")
    back = doc.sketch(top)
    back.rect_corner(0, 50, 80, 8)
    doc.join(back, 80)
    lip = doc.sketch(top)
    lip.rect_corner(0, 0, 80, 6)
    doc.join(lip, 14)
    base_top_edges = stand.edges("|X").filter(lambda e: abs(e.midpoint[2] - 6) < 1e-6)
    doc.fillet(base_top_edges.filter(lambda e: abs(e.midpoint[1] - 50) < 1e-6), 5)
    doc.fillet(base_top_edges.filter(lambda e: abs(e.midpoint[1] - 6) < 1e-6), 3)
    # The lip front and the base front are coplanar (y = 0) and merge into one face.
    lip_front = stand.face("-Y and <Y")
    notch = doc.sketch(lip_front)
    notch.rect_corner(32, 10, 16, 11)
    doc.cut(notch, 6)

    volume = 80 * 70 * 6 + 80 * 8 * 80 + 80 * 6 * 14 - 16 * 6 * 10 + (25 - math.pi * 25 / 4) * 80 + (9 - math.pi * 9 / 4) * 80
    return TaskResult(
        [Expectation(stand, (0, 0, 0), (80, 70, 86), volume)],
        edit=(back.id, back.dimension(0, "height"), 10, (80, 70, 86)),
        notes=["Upright back rest kept for comparability (an inclined one is now expressible with a sketch polyline or Move/Rotate)."],
    )


def cable_clip(doc: Document) -> TaskResult:
    """Snap-in clip for a 10 mm cable: 14 mm ring, 5 mm opening, 24 x 5 mm screw tab with two
    3.5 mm holes, R1.5 tab corners; 8 mm tall."""
    s = doc.sketch("XY")
    s.circle(7)
    clip = doc.extrude(s, 8, body_name="Cable clip")
    tab = doc.sketch("XY")
    tab.rect_corner(-12, -11, 24, 5)
    doc.join(tab, 8, target=clip)
    bore = doc.sketch(clip.face(">Z"))
    bore.circle(5)
    doc.cut(bore, 8)
    opening = doc.sketch(clip.face(">Z"))
    opening.rect_corner(-2.5, 3, 5, 5)
    doc.cut(opening, 8)
    tab_bottom = clip.face("-Y and <Y")
    holes = doc.sketch(tab_bottom)
    holes.circle(1.75, center=(-8, 4))
    holes.circle(1.75, center=(8, 4))
    doc.cut(holes, 5)
    doc.fillet(clip.edges("|Z and <Y"), 1.5)

    d = 6.0
    segment = 49 * math.acos(d / 7) - d * math.sqrt(49 - d * d)
    steps = 20000
    opening_area = sum(
        (math.sqrt(49 - x * x) - math.sqrt(25 - x * x)) * (5 / steps)
        for x in ((-2.5 + (i + 0.5) * 5 / steps) for i in range(steps))
    )
    volume = (
        math.pi * 49 * 8
        + 24 * 5 * 8
        - segment * 8
        - math.pi * 25 * 8
        - opening_area * 8
        - 2 * math.pi * 1.75**2 * 5
        - 2 * (2.25 - math.pi * 2.25 / 4) * 8
    )
    return TaskResult(
        [Expectation(clip, (-12, -11, 0), (12, math.sqrt(49 - 2.5**2), 8), volume, volume_tolerance=1e-3)],
        edit=(bore.id, bore.dimension(0, "diameter"), 10.4, (24, 11 + math.sqrt(49 - 2.5**2), 8)),
    )


TASKS: dict[str, Callable[[Document], TaskResult]] = {
    "enclosure-with-lid": enclosure_with_lid,
    "bracket-with-slot": bracket_with_slot,
    "pipe-adapter": pipe_adapter,
    "phone-stand": phone_stand,
    "cable-clip": cable_clip,
}
