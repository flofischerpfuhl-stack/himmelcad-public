"""Import/export helpers of :class:`~himmelcad.assembler.Document` (mixin).

Every helper is exactly one canonical command (``import.step``, ``import.iges``,
``import.mesh``, ``import.dxf``, ``export.dxf``, ``export.step``, ``export.iges``,
``mesh.toSolid``), so a script produces the same History steps as the app's File menu.
IGES needs the HimmelCAD OCCT build (``formats()["kernel"]["igesRead"]``).

>>> with Document.headless() as doc:                                    # doctest: +SKIP
...     parts = doc.import_step("robot.step")          # one Import step, one body per part
...     [(p.name, p.item_path) for p in parts]
...     mesh = doc.import_mesh("bracket.stl")[0]        # a reference mesh
...     solid = doc.mesh_to_solid(mesh)                 # closed mesh -> B-rep body
...     doc.fillet(solid.edges("|Z").max("x"), 2)
...     sketch = doc.import_dxf("plate.dxf", plane="XY")
...     doc.export_dxf("plate-out.dxf", sketch=sketch)
...     doc.export_step("kit.step", structure="folders", schema="AP214", unit="in")
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .client import AssemblerClient
    from .modeling import Body, Face, Feature, Sketch


@dataclass(frozen=True)
class ReferenceMesh:
    """An imported mesh (STL/3MF/OBJ): shown, measured and exported, never a kernel input."""

    id: str
    name: str
    color: str | None
    folder: tuple[str, ...]
    triangles: int

    @property
    def body_id(self) -> str:
        """The ``mesh:`` id the mesh has in ``bodies.list``-style listings and selections."""
        return f"mesh:{self.id}"


class InteropMixin:
    """Import/export helpers; mixed into :class:`~himmelcad.assembler.Document`."""

    client: AssemblerClient

    def _feature(self, result: Mapping[str, Any]) -> Feature:  # pragma: no cover - provided by Document
        raise NotImplementedError

    def formats(self) -> Mapping[str, Any]:
        """What each format imports/exports and keeps, and what this kernel build supports (IGES)."""
        return self.client.formats()

    def import_step(self, path: str | Path, *, structure: str = "assembly") -> list[Body]:
        """Imports a STEP file as one History step; with ``structure="assembly"`` (default) one body
        per placed part, named and coloured from the file (``Body.item_path``: its assembly folders)."""
        from .modeling import Body

        result = self.client.import_step(path, structure=structure)
        feature = self._feature(result)
        paths = {p["bodyId"]: tuple(p.get("itemPath", [])) for p in result.get("parts", [])}
        bodies = []
        for body_id in result.get("createdBodyIds", []):
            body = Body(self, body_id, feature)  # type: ignore[arg-type]
            body.item_path = paths.get(body_id, ())
            bodies.append(body)
        return bodies

    def import_iges(self, path: str | Path) -> list[Body]:
        """Imports an IGES file as one History step: sewn surfaces become solid bodies (open ones
        stay surface bodies), named after the file. HimmelCAD OCCT build only; raises
        :class:`~himmelcad.assembler.AssemblerError` (``unsupported``) otherwise."""
        from .modeling import Body

        result = self.client.import_iges(path)
        feature = self._feature(result)
        return [Body(self, body_id, feature) for body_id in result.get("createdBodyIds", [])]  # type: ignore[arg-type]

    def import_mesh(self, path: str | Path) -> list[ReferenceMesh]:
        """STL, 3MF or OBJ as reference meshes (3MF: one per build item; OBJ: one per group)."""
        result = self.client.import_mesh(path)
        return [
            ReferenceMesh(
                id=str(m["meshId"]),
                name=str(m["name"]),
                color=m.get("color"),
                folder=tuple(m.get("folder", [])),
                triangles=int(m["triangles"]),
            )
            for m in result["meshes"]
        ]

    def import_dxf(
        self,
        path: str | Path,
        *,
        plane: str = "XY",
        offset: float = 0.0,
        face: Face | None = None,
        connect: bool = True,
        unit_scale: float | None = None,
        name: str | None = None,
    ) -> Sketch:
        """A DXF drawing as a new sketch (one step) on ``plane`` at ``offset`` or on a planar ``face``.

        End points are joined unless ``connect=False``; ``unit_scale`` (mm per drawing unit)
        overrides ``$INSUNITS``. The returned sketch's regions are its closed profiles.
        """
        from .modeling import Feature, Sketch

        plane_ref: dict[str, Any] = {"kind": "face", "face": face.ref} if face is not None else {"kind": "plane", "plane": plane.upper(), "offset": offset}
        result = self.client.import_dxf(
            path,
            plane=None if face is not None else plane.upper(),
            offset=None if face is not None else offset,
            face=face.ref if face is not None else None,
            connect=connect,
            unit_scale=unit_scale,
            name=name,
        )
        sketch = Sketch(self, plane_ref, face.body_id if face is not None else None)  # type: ignore[arg-type]
        sketch.feature = Feature(self, str(result["featureId"]), "sketch", str(result["name"]))  # type: ignore[arg-type]
        sketch.import_report = dict(result)
        return sketch

    def export_dxf(
        self,
        path: str | Path,
        *,
        sketch: Sketch | None = None,
        face: Face | None = None,
        version: str = "R2000",
        include_construction: bool = True,
    ) -> Path:
        """Writes a sketch (``sketch``) or a planar face outline (``face``) as DXF (``R2000``/``R12``)."""
        if (sketch is None) == (face is None):
            raise ValueError("give exactly one of sketch= or face=")
        data = self.client.export_dxf(
            sketch_id=sketch.id if sketch is not None else None,
            face=face.ref if face is not None else None,
            version=version,
            include_construction=include_construction,
        )
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def mesh_to_solid(self, mesh: ReferenceMesh | str, *, name: str | None = None, hide_mesh: bool = True) -> Body:
        """Converts a closed, manifold reference mesh into a solid body (one "Mesh to Solid" step).

        Raises :class:`~himmelcad.assembler.AssemblerError` (``unsupported``) with the reason for an
        open, non-manifold, multi-part or too large mesh.
        """
        from .modeling import Body

        mesh_id = mesh.id if isinstance(mesh, ReferenceMesh) else mesh
        result = self.client.mesh_to_solid(mesh_id, name=name, hide_mesh=hide_mesh)
        return Body(self, str(result["bodyId"]), self._feature(result))  # type: ignore[arg-type]

    def export_step(
        self,
        path: str | Path,
        bodies: Iterable[Body] | None = None,
        *,
        schema: str | None = None,
        unit: str | None = None,
        structure: str | None = None,
        visible_only: bool | None = None,
    ) -> Path:
        """Exact B-rep STEP with names and colours: ``schema`` ``AP242``/``AP214``, ``unit``
        ``mm``/``cm``/``m``/``in``, ``structure`` ``flat`` or ``folders`` (Items folders as sub-assemblies)."""
        return self.client.export_to(
            "step",
            path,
            body_ids=None if bodies is None else [b.id for b in bodies],
            schema=schema,
            unit=unit,
            structure=structure,
            visible_only=visible_only,
        )

    def export_iges(
        self,
        path: str | Path,
        bodies: Iterable[Body] | None = None,
        *,
        unit: str | None = None,
        mode: str | None = None,
        visible_only: bool | None = None,
    ) -> Path:
        """Exact-geometry IGES (no names/colours): ``mode`` ``faces`` (trimmed surfaces, default) or
        ``brep`` (MSBO solids), ``unit`` ``mm``/``cm``/``m``/``in``. HimmelCAD OCCT build only."""
        return self.client.export_to(
            "iges",
            path,
            body_ids=None if bodies is None else [b.id for b in bodies],
            unit=unit,
            mode=mode,
            visible_only=visible_only,
        )


__all__ = ["InteropMixin", "ReferenceMesh"]
