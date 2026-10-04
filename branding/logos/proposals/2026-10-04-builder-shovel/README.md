# Builder shovel mark proposals 2026-10-04

The owner asked for a new Builder mark with a shovel. **The owner chose c2 (2026-10-04)**; it is
copied unchanged to `../../source/himmelcad-builder{,-on-light}.svg` (the generator gives the
chosen variant the master's title and id) and replaces the hard hat.

| File                       | Proposal                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| `himmelcad-builder-f1.svg` | Continuous mitred frame grip, +25 % (round 9, liked)               |
| `himmelcad-builder-c1.svg` | f1 with the outer top corners cut (mitre tips no longer stick out) |
| `himmelcad-builder-c2.svg` | c1 with the grip 10 % smaller                                      |
| `himmelcad-builder-c3.svg` | c1 with the grip 20 % smaller                                      |

Owner feedback 2026-10-04: upright, a shovel and not a spade; straight front view; the blade facets mirror about the vertical centre line (positions, not tones). Diagonal and spade variants dropped. Round 3: b-stout "feels off in its proportions" (maybe a rounder tip, a smaller blade), hence b1 to b7. Round 4: take the Bundeswehr folding spade as the model, far fewer blade facets, blade-to-shaft ratio was wrong; the b variants are replaced by k1 to k4. Round 5: the Trimble Earthworks app icon as a further model (compact, thick shaft, box grip), hence t1 to t3; k2 kept for comparison. Trimble is a competitor in machine control: take the proportions only, not the look. Round 6: start from k3 and move a bit toward those exaggerated proportions; the shaft must visibly join the blade (lofted socket), hence m1 to m3. Round 7: the owner picked m1; remove the locking nut and let the shaft reach less deep into the blade, hence n1 to n3. Round 8: from n3, the triangular grip's edges as thick as the shaft, hence g1 to g3. Round 9: g1 is the best, but the grip must be one continuous geometry (no overlapping prisms, mitred corners, shaft running into the frame), hence f1 to f3. Round 10: f1 is very good, but the mitre tips made the grip far too large; smaller overall, same bar width, hence c1 to c3 (cut top corners). `c2-large.png` shows c2 at 512 px.

Every file has an `-on-light` twin (the family's "tone" treatment). `overview-cut.png` shows each on
dark, on white and at 32/16 px.

Facets, light and ramp come from the family renderer
(`../2026-10-02-assembler/generator/lowpoly.mjs`).

## Rebuild

```bash
node generator/candidates.mjs .
```
