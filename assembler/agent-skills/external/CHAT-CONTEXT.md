# HimmelCAD Assembler — context for chat assistants without tools

Paste this into a chat (claude.ai, ChatGPT, …) that cannot run programs.
The assistant writes a Python script; you run it on your computer, look at
the PNGs it writes and paste errors or pictures back.

## What to produce

A single Python 3.11+ script for the HimmelCAD Assembler SDK
(`sdk/python` in the HimmelCAD repository; run from a checkout after
`pnpm --filter @himmelcad/assembler build:headless`):

```python
from himmelcad.assembler import Document

with Document.headless() as doc:
    doc.param("wall", 2)                                   # named parameters
    base = doc.sketch("XY")
    base.rect(80, 50)                                      # centred rectangle, mm
    box = doc.extrude(base, 30, body_name="Case")
    doc.fillet(box.edges("|Z"), 4)                         # vertical edges
    doc.shell(box.face(">Z"), expression="wall")           # open top
    vents = doc.sketch(box.face("-Y and <Y"))              # the outer front wall
    for i in range(6):
        vents.rect(3, 14, center=(-15 + 6 * i, 15))
    doc.cut(vents, 3)                                      # into the wall
    report = doc.printability()
    print(report.printable, [f["message"] for f in report.findings])
    doc.render("iso", path="case-iso.png")                 # look at it
    doc.inspect().save("case")                             # four views
    doc.save("case.hcasm")                                 # open in the app, edit
```

## Rules for the script

- Units are millimetres, Z is up, the build plate is XY.
- Every call creates one editable History step (sketch → extrude →
  fillet …); never build meshes.
- Selectors: `">Z"` top-most, `"<Z"` bottom-most, `"+X"` facing +X,
  `"|Z"` parallel to Z (edges), `"%CYLINDER"`, combined with `and`
  (`"-Y and <Y"`: after a shell the inner wall faces -Y too). `.face()`
  needs exactly one match and lists the candidates otherwise.
- `doc.cut(sketch_on_face, depth)` cuts into the material; holes:
  `doc.hole(face, at=[(x, y)], size="M3")`.
- Use `doc.param(name, value)` and `expression=` for sizes the user may
  change later.
- Finish with `doc.printability()`, renders and `doc.save(...)`; print the
  bounding box (`body.bbox.size`) so the user can check the size.
- State the dimensions you assumed. Do not invent sizes of real products
  you do not know exactly.
