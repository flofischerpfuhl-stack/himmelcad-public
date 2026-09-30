"""The same five printable-part benchmark tasks as ``tasks.py``, modelled with
**build123d** (Apache-2.0, not shipped with HimmelCAD Assembler — installed
into a throwaway venv only for this measurement, see `AGENT-API.md`
"Comparison benchmark"). Each function returns the finished
:class:`build123d.Part` and the same hand-calculated expectations `tasks.py`
uses, so `run_bench_build123d.py` checks both against one source of truth.

Written independently of the Assembler scripts' exact construction steps
(build123d has direct box/cylinder primitives the Assembler agent API does not
expose; matching the *parts*, not the *steps*, is the fair comparison — see
the design note in `AGENT-API.md`). Edge/face selection uses coordinate
filters (`e.center()`, `e.arc_center`, `e.radius`) rather than named
references, which is itself part of what the benchmark measures.
"""
from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

from build123d import (
    Align,
    Axis,
    Box,
    Cylinder,
    GeomType,
    Part,
    Pos,
    Rotation,
    SlotOverall,
    chamfer,
    extrude,
    fillet,
    offset,
)


@dataclass
class TaskExpectation:
    part: Part
    bbox_min: tuple[float, float, float]
    bbox_max: tuple[float, float, float]
    volume: float
    volume_tolerance: float = 1e-4


def _circle_edges(part: Part):
    return [e for e in part.edges() if e.geom_type == GeomType.CIRCLE]


def enclosure_with_lid() -> TaskExpectation:
    box = Box(60, 40, 25, align=(Align.MIN, Align.MIN, Align.MIN))
    box = fillet([e for e in box.edges().filter_by(Axis.Z)], radius=4)
    top = box.faces().sort_by(Axis.Z)[-1]
    box = offset(box, amount=-2, openings=top)

    def rounded_rect(w: float, h: float, r: float) -> float:
        return w * h - (4 - math.pi) * r * r

    volume = rounded_rect(60, 40, 4) * 25 - rounded_rect(56, 36, 2) * 23
    return TaskExpectation(box, (0, 0, 0), (60, 40, 25), volume)


def bracket_with_slot() -> TaskExpectation:
    base = Box(60, 30, 5, align=(Align.MIN, Align.MIN, Align.MIN))
    upright = Pos(0, 25, 5) * Box(60, 5, 40, align=(Align.MIN, Align.MIN, Align.MIN))
    bracket = base + upright
    inner = [e for e in bracket.edges() if abs(e.center().Y - 25) < 1e-6 and abs(e.center().Z - 5) < 1e-6 and e.length > 50]
    bracket = fillet(inner, radius=4)
    slot = extrude(Pos(30, 12, 0) * SlotOverall(20, 6, align=(Align.CENTER, Align.CENTER)), amount=5)
    bracket = bracket - slot
    h1 = Pos(15, 27.5, 30) * Rotation(90, 0, 0) * Cylinder(2.5, 10)
    h2 = Pos(45, 27.5, 30) * Rotation(90, 0, 0) * Cylinder(2.5, 10)
    bracket = bracket - h1 - h2
    front = [e for e in bracket.edges() if abs(e.center().Y) < 1e-6 and e.length < 10 and abs(e.center().X) < 1]
    front += [e for e in bracket.edges() if abs(e.center().Y) < 1e-6 and e.length < 10 and abs(e.center().X - 60) < 1]
    bracket = fillet(front, radius=3)

    volume = (
        60 * 30 * 5
        + 60 * 5 * 40
        + (16 - math.pi * 4) * 60
        - (14 * 6 + math.pi * 9) * 5
        - 2 * math.pi * 2.5**2 * 5
        - 2 * (9 - math.pi * 9 / 4) * 5
    )
    return TaskExpectation(bracket, (0, 0, 0), (60, 30, 45), volume)


def pipe_adapter() -> TaskExpectation:
    base = Cylinder(15, 15, align=(Align.CENTER, Align.CENTER, Align.MIN))
    neck = Pos(0, 0, 15) * Cylinder(10, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
    adapter = base + neck
    adapter -= Cylinder(8, 35, align=(Align.CENTER, Align.CENTER, Align.MIN))
    adapter -= Cylinder(13, 12, align=(Align.CENTER, Align.CENTER, Align.MIN))
    top_outer = [e for e in _circle_edges(adapter) if abs(e.arc_center.Z - 35) < 1e-6 and abs(e.radius - 10) < 1e-6]
    step_outer = [e for e in _circle_edges(adapter) if abs(e.arc_center.Z - 15) < 1e-6 and abs(e.radius - 15) < 1e-6]
    adapter = chamfer(top_outer + step_outer, length=1)

    ring = lambda r_centroid: 2 * math.pi * r_centroid * 0.5  # noqa: E731
    volume = (
        math.pi * 15**2 * 15
        + math.pi * 10**2 * 20
        - math.pi * 8**2 * 35
        - math.pi * (13**2 - 8**2) * 12
        - ring(10 - 1 / 3)
        - ring(15 - 1 / 3)
    )
    return TaskExpectation(adapter, (-15, -15, 0), (15, 15, 35), volume)


def phone_stand() -> TaskExpectation:
    base = Box(80, 70, 6, align=(Align.MIN, Align.MIN, Align.MIN))
    back = Pos(0, 50, 6) * Box(80, 8, 80, align=(Align.MIN, Align.MIN, Align.MIN))
    lip = Pos(0, 0, 6) * Box(80, 6, 14, align=(Align.MIN, Align.MIN, Align.MIN))
    stand = base + back + lip
    back_edge = [e for e in stand.edges() if abs(e.center().Y - 50) < 1e-6 and abs(e.center().Z - 6) < 1e-6 and e.length > 70]
    stand = fillet(back_edge, radius=5)
    # Re-queried from the *just-filleted* solid: edges captured before an
    # earlier fillet/chamfer point at the pre-operation solid (`topo_parent`)
    # and silently drop that operation if reused afterwards — a footgun the
    # Assembler API's stable named keys do not have.
    front_edge = [e for e in stand.edges() if abs(e.center().Y - 6) < 1e-6 and abs(e.center().Z - 6) < 1e-6 and e.length > 70]
    stand = fillet(front_edge, radius=3)
    notch = Pos(40, 3, 17.5) * Box(16, 6, 15, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    stand -= notch

    volume = (
        80 * 70 * 6
        + 80 * 8 * 80
        + 80 * 6 * 14
        - 16 * 6 * 10
        + (25 - math.pi * 25 / 4) * 80
        + (9 - math.pi * 9 / 4) * 80
    )
    return TaskExpectation(stand, (0, 0, 0), (80, 70, 86), volume)


def cable_clip() -> TaskExpectation:
    ring = Cylinder(7, 8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    tab = Pos(0, -11, 0) * Box(24, 5, 8, align=(Align.CENTER, Align.MIN, Align.MIN))
    clip = ring + tab
    clip -= Cylinder(5, 8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    clip -= Pos(0, 3, 0) * Box(5, 10, 8, align=(Align.CENTER, Align.MIN, Align.MIN))
    h1 = Pos(-8, -7, 0) * Cylinder(1.75, 10, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    h2 = Pos(8, -7, 0) * Cylinder(1.75, 10, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    clip = clip - h1 - h2
    tab_front = [e for e in clip.edges() if abs(e.center().Y + 11) < 1e-6 and e.length < 10 and abs(abs(e.center().X) - 12) < 1]
    clip = fillet(tab_front, radius=1.5)

    # Numerically integrated opening area, same method `tasks.py` uses (the
    # opening trims the ring, so there is no closed-form circular-segment area).
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
    return TaskExpectation(
        clip,
        (-12, -11, 0),
        (12, math.sqrt(49 - 2.5**2), 8),
        volume,
        volume_tolerance=1.2e-2,  # box-based notch/tab modelling, not the exact same construction as tasks.py
    )


TASKS: dict[str, Callable[[], TaskExpectation]] = {
    "enclosure-with-lid": enclosure_with_lid,
    "bracket-with-slot": bracket_with_slot,
    "pipe-adapter": pipe_adapter,
    "phone-stand": phone_stand,
    "cable-clip": cable_clip,
}
