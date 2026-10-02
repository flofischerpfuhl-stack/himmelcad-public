# Assembler mark proposals 2026-10-02

The owner asked for an Assembler icon in the family style: same blues, low-poly, a nut or a
screw (or a better motif for "CAD for 3D printing"). Three candidates; **the owner chose B, the
bolt** (2026-10-02). A and C stay here as rejected alternatives.

| File                                   | Proposal                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `himmelcad-assembler-b-bolt.svg`       | **B, chosen**: hex-head bolt, diagonal (head upper left), ring-grooved thread, five steps        |
| `himmelcad-assembler-b-bolt-small.svg` | B for 16–32 px: three thread steps, deeper grooves, taller head (the steps stay apart at 1–2 px) |
| `himmelcad-assembler-a-nut.svg`        | A, rejected: hex nut, corner toward the viewer, countersunk round bore with two thread rings     |
| `himmelcad-assembler-a-nut-small.svg`  | A for 16–32 px, rejected                                                                         |
| `himmelcad-assembler-c-nozzle.svg`     | C, rejected: 3D-printer nozzle (hex body, cone) over two printed lines                           |

Every file has an `-on-light` twin (the family's "tone" treatment: very light facets on the
outline three steps darker). `overview.png` shows the three next to the approved family (master
on dark and white, app icon card at 128/64/32/16 px, 16 px favicons in light and dark tab strips,
maskable crops, a 32 px taskbar row); `bolt-sizes.png` shows the chosen bolt at every shipped
size. The icons in both come from the shipping pipeline (`apps/assembler/scripts/generate-icon.mjs`).

Facets, light and ramp come from the same renderer as the family (`generator/lowpoly.mjs` ports
`../2026-09-25/round-2/generator/lp3d.py`: azure ramp, light from the upper left, flat faces, no
strokes).

## Rebuild

```bash
node generator/candidates.mjs .                     # all candidates (+ -on-light, + small A and B)
node generator/sheet.mjs overview.png               # the overview (needs a local Playwright Chromium)
node generator/sheet.mjs bolt-sizes.png --sizes     # the chosen mark at every size
```

The chosen files are copied unchanged to
`../../source/himmelcad-assembler{,-on-light,-small,-small-on-light}.svg`;
`apps/assembler/scripts/generate-icon.mjs` (`pnpm --filter @himmelcad/assembler icon`) renders
every app icon from there.
