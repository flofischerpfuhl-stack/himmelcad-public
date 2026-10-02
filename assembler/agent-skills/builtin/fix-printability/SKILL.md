---
id: fix-printability
name: Fix printability findings
description: How to read print.analyze findings and fix each kind in the History (overhangs, thin walls, small holes, invalid bodies, build volume) without breaking the part.
version: 1
scope: built-in
tags: [printing, repair]
---

# Fix printability findings

1. `print.analyze` (optionally with the user's `settings`, e.g.
   `{material: "PETG", minWallMm: 1.2}`). Findings have `kind`,
   `severity`, `bodyId`, `faceKeys` and a `message`.
2. Look at them: `view_render` with `overlay: ["printFindings"]` colours the
   affected faces (errors red, warnings amber).
3. Fix the most severe first, one change at a time, re-analyse after each.

| Finding                        | Usual fix                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalidBrep`, `notWatertight` | Find the step with an error (`features.list` → `error`), edit or suppress it; avoid zero-thickness joins (overlap joined solids by ≥ 0.01 mm).                                                                                                     |
| `overhang`                     | First try orientation: `print.orientations` then `print.orient {bodyId, rank: 1}`. Else replace the downward face edge with a 45° `chamfer`, or add a `draft`. Small overhangs below ~5 mm are often fine — say so instead of changing the design. |
| `thinWall`                     | Increase the `shell`/`thicken` thickness or the sketch dimension that makes the wall; the finding's `value` is the thinnest sampled thickness.                                                                                                     |
| `smallHole`                    | Enlarge the hole to at least `minHoleMm` (print clearance +0.2–0.4 mm) or note that it will be drilled.                                                                                                                                            |
| `smallPin`                     | Thicken the pin or make it a separate part.                                                                                                                                                                                                        |
| `buildVolume`                  | Scale is not a fix; split the part (`split`) or ask the user.                                                                                                                                                                                      |
| `notOnPlate`                   | `print.placeOnPlate` with the face that should touch the plate.                                                                                                                                                                                    |

Rules:

- Edit the feature that causes the problem (`feature.edit`,
  `sketch.setDimension`, `parameter.edit`); do not stack corrective
  features on top when a size can be changed.
- Never delete the user's features to make a finding disappear; deleting
  needs the user's approval anyway.
- Keep the outer dimensions the user asked for unless they agree.
- Finish with a final `print.analyze` and list what is left and why.
