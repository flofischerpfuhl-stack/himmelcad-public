"""View renders and assistant skills (``view.render``, ``view.inspect``, ``skills.*``).

Mixed into :class:`~himmelcad.assembler.Document`::

    with Document.headless() as doc:
        ...
        doc.render("iso", path="part.png")                  # one PNG
        shot = doc.render({"azimuth": -60, "elevation": 25}, section={"axis": "y"})
        shot.save("cut.png")
        bundle = doc.inspect(overlay=["printFindings"])     # iso, front, top, right + manifest
        bundle.save("renders/part")                         # part-iso.png, part-front.png, …
        print(doc.skill("printable-part"))                  # the workflow text
"""
from __future__ import annotations

import base64
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .client import AssemblerClient
    from .modeling import Body


@dataclass
class Render:
    """One ``view.render`` result: the PNG bytes and what was drawn."""

    png: bytes
    width: int
    height: int
    renderer: str
    view: Mapping[str, Any]
    raw: Mapping[str, Any]

    def save(self, path: str | Path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.png)
        return target

    @property
    def findings(self) -> Mapping[str, Any] | None:
        """The printability findings of an ``overlay=["printFindings"]`` render."""
        return self.raw.get("findings")


@dataclass
class Inspection:
    """A ``view.inspect`` bundle: one :class:`Render` per view and the manifest."""

    renders: list[Render]
    manifest: Mapping[str, Any]

    def save(self, prefix: str | Path) -> list[Path]:
        """Writes ``<prefix>-<view>.png`` per view."""
        base = Path(prefix)
        paths = []
        for render in self.renders:
            name = render.view.get("name") or f"az{render.view.get('azimuth')}-el{render.view.get('elevation')}"
            paths.append(render.save(base.parent / f"{base.name}-{name}.png"))
        return paths


def _render(result: Mapping[str, Any], fallback_path: Path | None = None) -> Render:
    if "data" in result:
        data = base64.b64decode(str(result["data"]))
    elif fallback_path is not None:
        data = fallback_path.read_bytes()
    else:  # pragma: no cover - the server always answers with data or a path
        data = Path(str(result["path"])).read_bytes()
    return Render(
        png=data,
        width=int(result.get("width", 0)),
        height=int(result.get("height", 0)),
        renderer=str(result.get("renderer", "")),
        view=dict(result.get("view") or {}),
        raw=result,
    )


class ViewMixin:
    """``doc.render``, ``doc.inspect``, ``doc.skills``, ``doc.skill``."""

    client: AssemblerClient

    def render(
        self,
        view: str | Mapping[str, float] = "iso",
        *,
        bodies: Iterable[Body] | None = None,
        path: str | Path | None = None,
        **options: Any,
    ) -> Render:
        """Renders the model (``view.render``). ``options`` are the contract's parameters
        (``projection``, ``width``, ``height``, ``highlight``, ``tint``, ``section``, ``displayMode``,
        ``overlay``, ``background`` …). ``path``: also write the PNG there."""
        params: dict[str, Any] = {"view": dict(view) if isinstance(view, Mapping) else view, **options}
        if bodies is not None:
            params["bodyIds"] = [b.id for b in bodies]
        result = self.client.view_render(**params)
        render = _render(result)
        if path is not None:
            render.save(path)
        return render

    def inspect(self, views: Iterable[str | Mapping[str, float]] | None = None, *, bodies: Iterable[Body] | None = None, **options: Any) -> Inspection:
        """Standard views plus a manifest of bodies, feature errors and findings (``view.inspect``)."""
        params: dict[str, Any] = dict(options)
        if views is not None:
            params["views"] = [dict(v) if isinstance(v, Mapping) else v for v in views]
        if bodies is not None:
            params["bodyIds"] = [b.id for b in bodies]
        result = self.client.view_inspect(**params)
        return Inspection([_render(image) for image in result.get("images", [])], result.get("manifest", {}))

    def skills(self, query: str | None = None) -> list[Mapping[str, Any]]:
        """The skill index (built-in workflows and the project's own), all pages."""
        entries: list[Mapping[str, Any]] = []
        cursor: int | None = 0
        while cursor is not None:
            page = self.client.skills_list(query=query, cursor=cursor, limit=50)
            entries.extend(page.get("skills", []))
            cursor = page.get("nextCursor")
        return entries

    def skill(self, skill_id: str) -> str:
        """The whole Markdown body of one skill (reads every page)."""
        parts: list[str] = []
        offset: int | None = 0
        while offset is not None:
            page = self.client.skills_read(skill_id, offset=offset, max_chars=16384)
            parts.append(str(page.get("text", "")))
            offset = page.get("nextOffset")
        return "".join(parts)
