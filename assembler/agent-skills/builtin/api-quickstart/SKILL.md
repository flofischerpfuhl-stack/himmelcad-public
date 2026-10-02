---
id: api-quickstart
name: Modeling API quick start
description: The hcasm.agent-api@1 calls a part needs, as JSON - sketch profiles, extrude/cut/join, fillet with selectors, shell, holes, references and errors.
version: 1
scope: built-in
tags: [api, modeling]
---

# Modeling API quick start

Units are millimetres, Z is up, the build plate is XY. Every write is one
History step the user can edit and undo. Look up exact parameters with
`hcasm_methods {method: "…"}` or a feature kind with
`hcasm_methods {kind: "extrude"}`.

## Sketch and extrude

```json
{
  "method": "feature.create",
  "params": {
    "kind": "sketch",
    "name": "Base sketch",
    "params": {
      "plane": { "kind": "plane", "plane": "XY", "offset": 0 },
      "profiles": [{ "kind": "rectangle", "x": -40, "y": -25, "width": 80, "height": 50 }]
    }
  }
}
```

The result has `featureId`, `regions` and per shape the dimension names
(`shapes[0].dimensions.width`). Circles: `{"kind": "circle", "cx": 0,
"cy": 0, "radius": 3}`. More shapes in an existing sketch:
`sketch.addProfile {featureId, profile}`; polylines `sketch.addPolyline`.

```json
{
  "method": "feature.create",
  "params": {
    "kind": "extrude",
    "params": {
      "profile": { "kind": "sketch", "featureId": "sketch-1" },
      "distance": 20,
      "operation": "new",
      "resultBodyName": "Case"
    }
  }
}
```

`operation`: `new`, `join`, `cut`, `intersect` (with `targetBodyId`).
Bodies are named `body:<extrude id>`. A sketch on a face:
`"plane": {"kind": "face", "face": {"bodyId": "body:extrude-1", "select": ">Z"}}`
— its (u, v) are the parallel world axes for axis-aligned faces. An
extrude from a face sketch goes along the face's outward normal: cut into
the material with a **negative** `distance` (`-3`). A cut that misses the
body removes nothing and is not an error — check `faceCount`/`volume` in
the result or render it.

## References and selectors

Faces/edges are `{bodyId, key}` (from `faces.list`/`edges.list`) or a
selector `{bodyId, select}`: `>Z` top-most, `<Z` bottom-most, `+X` facing
+X, `|Z` parallel to Z (edges), `#Z` perpendicular, `%PLANE`,
`%CYLINDER`, `%CIRCLE`, combined with `and` (`"|Z and >X"`).

```json
{"method": "feature.create", "params": {"kind": "fillet",
  "params": {"edges": [{"bodyId": "body:extrude-1", "select": "|Z"}], "radius": 4}}}
{"method": "feature.create", "params": {"kind": "shell",
  "params": {"bodyId": "body:extrude-1", "faces": [{"bodyId": "body:extrude-1", "select": ">Z"}],
             "thickness": 2}}}
```

## Holes, cut-outs, patterns

- Through holes: circles in a sketch on the face, `extrude` with
  `operation: "cut"` and `extent: {"kind": "throughAll"}` (or a
  distance), or the `hole` kind (`hcasm_methods {kind: "hole"}`).
- Rows of vents/slots: one slot or rectangle, then `sketch.pattern`
  (linear/circular) before the cut — one editable step instead of many.

## Checking

- `bodies.list`: `valid`, `bbox.min/max/size`, `volume`.
- `features.list`: per step `error`/`warning`.
- `print.analyze`: printability findings (see skill `fix-printability`).
- `view_render` / `view_inspect`: look at it.

## Errors

Errors carry `code`, `message`, `hint` and `details`:
`referenceNotFound` lists similar keys, `featureFailed` names the failing
feature (nothing was committed), `sketchConflict` names constraints,
`busy` means the user is using a tool — wait and retry, `conflict` means
the document changed — re-read it.
