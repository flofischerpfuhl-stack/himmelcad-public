---
id: parametric-part
name: Parametric part with named parameters
description: Drive a part's key sizes from named document parameters so the user can change them later in the Parameters panel; expression fields, sketch dimensions and rename rules.
version: 2
scope: built-in
tags: [parameters, modeling]
---

# Parametric part with named parameters

Parameters are named document values (`wall = 2 mm`) the user edits in the
Parameters panel; every expression field and sketch dimension that names
them follows.

1. Create the parameters first, one call each:
   `parameter.create {name: "width", value: 80, unit: "mm"}`,
   `parameter.create {name: "wall", value: 2, unit: "mm"}`,
   `parameter.create {name: "inner_w", expression: "width - 2 * wall"}`.
   Names: lower case with underscores, short and meaningful.
2. Use them in sketch dimensions: after `feature.create` sketch with
   `profiles`, the result lists the dimension names of each shape
   (`{x, y, width, height}`); bind them with
   `sketch.setDimension {featureId, dimension: "d3", expression: "width"}`.
3. Use them in feature sizes: `extrude` `distanceExpression: "height"`,
   `fillet` `radiusExpression`, `chamfer` `distanceExpression`, `shell`
   `thicknessExpression`, `hole` `diameterExpression`.
4. Check that the model follows: change a value with
   `parameter.edit {parameterId, value}` (the id is in the result of
   `parameter.create` and in `parameters.list`; `name` renames). It must
   evaluate without errors and change the bounding box; then
   `history.undo`.
5. Give the sizes the user will change a range: `parameter.edit
{parameterId, min, max, step}` (numbers or expressions; the Parameters
   panel shows a slider). Then test the whole range in one query,
   `parameters.sweep {parameters: [{parameterId}]}` (min, nominal, max; or
   `mode: "samples"`): every sample must rebuild (`ok`), and the stored
   checks (`checks.add`, e.g. a lid clearance) run on each sample — a
   sample whose check fails is not `ok`. Narrow the range or fix the
   model until every sample passes; the sweep never changes the document.

Rules:

- One parameter per independent design intent; derive the rest with
  expressions instead of duplicating numbers.
- Expressions use `+ - * / ( )` and other parameter names; lengths in mm,
  angles in degrees.
- A parameter that is still used cannot be deleted (`conflict` lists the
  usages); renaming rewrites every expression that names it.
- Tell the user which parameters to change for which effect.
