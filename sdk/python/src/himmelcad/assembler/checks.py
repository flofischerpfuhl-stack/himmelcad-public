"""Stored checks and clearance helpers of :class:`~himmelcad.assembler.Document` (mixin).

A check is a requirement the document keeps and the app evaluates after every
rebuild (``assembler/CHECKS.md``): ``doc.add_check("clearance", a=lid, b=base,
min=0.3)``. Each helper is exactly one canonical method (``checks.add``,
``checks.update``, ``checks.remove``, ``checks.run``, ``measure.clearance``);
check edits are one undo step each. Results are structured: status, value,
unit, expected range, message and locations (body ids, face/edge keys,
closest points), whatever the user's workspace settings are.

>>> with Document.headless() as doc:                                   # doctest: +SKIP
...     lid_fit = doc.add_check("clearance", a=lid, b=base, min=0.3, name="Lid fit")
...     report = doc.run_checks()
...     if not report:                       # a failing or erroneous check
...         print(report.failed[0]["message"], report.failed[0]["locations"])
...     doc.clearance(lid, base)["relation"]  # "clear" | "contact" | "overlap"
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .client import AssemblerClient
    from .modeling import Body, Edge, Face

#: Parameters that take a measure target (body, face, edge or an (x, y, z) point).
_TARGET_PARAMS = {"distance": ("a", "b"), "angle": ("a", "b"), "length": ("target",)}


def _body_id(value: Any) -> Any:
    from .modeling import Body

    return value.id if isinstance(value, Body) else value


def _target(value: Any) -> Any:
    from .modeling import Body, Edge, Face

    if isinstance(value, Body):
        return {"kind": "body", "bodyId": value.id}
    if isinstance(value, Face):
        return {"kind": "face", "face": value.ref}
    if isinstance(value, Edge):
        return {"kind": "edge", "edge": value.ref}
    if isinstance(value, Mapping):
        return dict(value)
    point = [float(v) for v in value]
    if len(point) != 3:
        raise ValueError("a point target is (x, y, z) in mm")
    return {"kind": "point", "point": point}


def check_params(kind: str, params: Mapping[str, Any]) -> dict[str, Any]:
    """Canonical ``params`` of a check: model objects become ids / measure targets."""
    out: dict[str, Any] = {}
    targets = _TARGET_PARAMS.get(kind, ())
    for key, value in params.items():
        if value is None:
            continue
        if key in targets:
            out[key] = _target(value)
        elif key == "bodies":
            out[key] = [_body_id(b) for b in value]
        elif key in ("a", "b"):
            out[key] = _body_id(value)
        elif key == "size":
            out[key] = [float(v) for v in value]
        else:
            out[key] = value
    return out


class Check:
    """A stored check; ``result`` is the evaluation that came with the last add/update (if any)."""

    def __init__(self, doc: ChecksMixin, raw: Mapping[str, Any], result: Mapping[str, Any] | None = None) -> None:
        self.doc = doc
        self.raw = raw
        self.result = result

    @property
    def id(self) -> str:
        return str(self.raw["id"])

    @property
    def kind(self) -> str:
        return str(self.raw["kind"])

    @property
    def name(self) -> str:
        """The label, else the description from the parameters ("Clearance Lid ↔ Base ≥ 0.3 mm")."""
        return str(self.raw.get("name") or self.raw.get("displayName") or self.kind)

    @property
    def params(self) -> Mapping[str, Any]:
        return self.raw.get("params", {})

    @property
    def enabled(self) -> bool:
        return bool(self.raw.get("enabled", True))

    @property
    def passed(self) -> bool | None:
        """``True``/``False`` from ``result``; ``None`` when not evaluated."""
        if self.result is None:
            return None
        return self.result.get("status") == "pass"

    def update(self, *, name: str | None = None, enabled: bool | None = None, clear_name: bool = False, **params: Any) -> Check:
        """Changes parameters (merged into the current ones), label or on/off; one undo step."""
        merged = check_params(self.kind, {**self.params, **params}) if params else None
        result = self.doc.client.check_update(self.id, params=merged, name=name, enabled=enabled, clear_name=clear_name)
        updated = Check(self.doc, result["check"], result.get("result"))
        self.raw, self.result = updated.raw, updated.result
        return self

    def remove(self) -> None:
        """Deletes the check (one undo step)."""
        self.doc.client.check_remove(self.id)

    def __repr__(self) -> str:
        return f"Check({self.id!r}, {self.name!r})"


class CheckReport:
    """Result of ``checks.run``: ``bool(report)`` is ``True`` when no check fails or errs."""

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw

    @property
    def passed(self) -> bool:
        return bool(self.raw.get("passed"))

    def __bool__(self) -> bool:
        return self.passed

    @property
    def results(self) -> list[Mapping[str, Any]]:
        return list(self.raw.get("results", []))

    @property
    def failed(self) -> list[Mapping[str, Any]]:
        """Results that fail or could not be evaluated (``status`` fail/error/unsupported)."""
        return [r for r in self.results if r.get("status") in ("fail", "error", "unsupported")]

    @property
    def summary(self) -> Mapping[str, int]:
        return self.raw.get("summary", {})

    def by_name(self, name: str) -> Mapping[str, Any]:
        """The result of the check with this label (or description) or id."""
        for result in self.results:
            if result.get("name") == name or result.get("id") == name:
                return result
        raise KeyError(name)


class ChecksMixin:
    """Stored checks and clearance; mixed into :class:`~himmelcad.assembler.Document`."""

    client: AssemblerClient

    def add_check(self, kind: str, *, name: str | None = None, enabled: bool = True, **params: Any) -> Check:
        """Adds a stored check of ``kind`` (``doc.check_kinds()``) and evaluates it at once.

        Model objects are accepted: ``a``/``b`` of ``clearance`` take :class:`Body`, ``a``/``b`` of
        ``distance``/``angle`` and ``target`` of ``length`` take a Body, Face, Edge or (x, y, z) point,
        ``bodies`` a list of bodies. Ranges are ``min=``/``max=`` (mm, deg, mm³, g).
        """
        result = self.client.check_add(kind, check_params(kind, params), name=name, enabled=None if enabled else False)
        return Check(self, result["check"], result.get("result"))

    def checks(self) -> list[Check]:
        """The document's stored checks (with the app's latest result when it is current)."""
        return [Check(self, c, c.get("lastResult")) for c in self.client.checks_list()["checks"]]

    def check_kinds(self) -> list[Mapping[str, Any]]:
        """Kinds this build evaluates, with their parameter schemas."""
        return list(self.client.checks_kinds())

    def run_checks(self, checks: Iterable[Check | str] | None = None, *, scope: str | None = None) -> CheckReport:
        """Evaluates the checks now (all, or the given ones) on the committed or staged document."""
        ids = None if checks is None else [c.id if isinstance(c, Check) else str(c) for c in checks]
        return CheckReport(self.client.checks_run(ids, scope=scope))

    def clearance(self, a: Body, b: Body) -> Mapping[str, Any]:
        """Clearance of two bodies: ``relation`` (clear/contact/overlap), ``distance`` (mm), closest
        points, ``overlapVolume`` (mm³) and ``overlapCenter``."""
        return self.client.measure_clearance(a.id, b.id)["pairs"][0]

    def clearances(self, bodies: Sequence[Body] | None = None, *, below: float | None = None) -> list[Mapping[str, Any]]:
        """Clearance of every pair of ``bodies`` (default: all bodies); ``below`` keeps only pairs closer than that."""
        ids = None if bodies is None else [b.id for b in bodies]
        return list(self.client.measure_clearance(body_ids=ids, below=below)["pairs"])


__all__ = ["Check", "CheckReport", "ChecksMixin", "check_params"]
