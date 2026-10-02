---
id: printable-part
name: Design a printable part
description: Workflow from a plain-language request to a checked, editable, printable part, with the acceptance rules to meet before saying it is done.
version: 2
scope: built-in
tags: [workflow, printing, modeling]
---

# Design a printable part

Use this for any "make me a …" request. The result must be a normal,
editable History (sketches and features), never a mesh.

## 1. Understand the request

- List the dimensions the user gave. For every missing dimension pick a
  sensible printable default (walls 2 mm, fillets 1–3 mm, clearances
  0.2–0.4 mm for fits, M3 holes 3.4 mm) and say which defaults you chose.
- Never invent real-world sizes of products you do not know exactly (a
  board's hole spacing, a connector's position). Ask, or state the value
  as an assumption the user should check. Known references (for example
  Raspberry Pi 5: 85 × 56 mm board, M2.5 holes 58 × 49 mm apart, 3.5 mm
  from the short edge) may be used but must be named in the answer.
- Read `skills_read api-quickstart` once if you have not used the API in
  this session.

## 2. Model with a plan

1. `document.get` and `bodies.list`: build on what exists, do not wipe the
   user's work. Never call `project.new`/`project.open` unless asked.
2. Base shape: a sketch on `XY` (`feature.create` kind `sketch` with
   `profiles`) and an `extrude`. Prefer parameters for the sizes the user
   will want to change (see skill `parametric-part`).
3. Details in printing order: shell / pockets (`extrude` `cut`), holes
   (`hole` or circles cut), ribs, then fillets and chamfers last.
4. After every write check the result's `errors`; on `featureFailed` read
   `details` and the hint, change the parameters, do not retry blindly.
5. Name features and bodies so the History reads well ("Base", "Vents").

## 3. Look at it

- `view_render` (iso, shadedEdges) after the main shape and after the
  details; `view_inspect` once at the end (iso, front, top, right).
- Compare the picture with the request: openings on the right side,
  nothing floating, walls where they should be. Fix what is wrong.

## 4. Check printability (acceptance rules)

Run `print.analyze` (or `view_render` with `overlay: ["printFindings"]`).
The part is done only when:

- every body is valid (`brepValid`, `watertight`) and there are no feature
  errors;
- no `error` findings remain; overhang warnings are either fixed (chamfer
  45°, flip the part with `print.orient`) or explained to the user;
- walls are at least the nozzle-safe minimum (0.8 mm default `minWallMm`);
- holes and pins meet `minHoleMm`/`minPinMm`;
- the part fits the build volume if the user named a printer;
- the bounding box matches the requested outer size (`bodies.list` bbox);
- parts that must fit together (a lid on an enclosure, a pin in a hole,
  print-in-place parts) have the clearance the fit needs: measure it with
  `measure.clearance {a, b}` (`relation` must not be `overlap`) and keep
  it as a stored check, `checks.add {kind: "clearance", params: {a, b,
min: 0.2}}` (0.2–0.4 mm for a printed fit), so it is re-checked after
  every later change; `checks.run` must report `passed`. When the fit
  depends on a parameter, `parameters.sweep` over its range shows whether
  the check holds at the ends (skill `parametric-part`).

## 5. Report

Say what you built (main sizes, bodies), the defaults you assumed, the
printability result (findings left and why), and how to change the key
sizes (parameter names). Keep it short.
