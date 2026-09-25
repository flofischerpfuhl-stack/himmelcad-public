# Logo proposals 2026-09-25, round 4 (not approved)

Proposals only; the masters in `../../source/` are unchanged. Earlier rounds: `round-1/` to `round-3/`.
Each mark has a dark-background file and an `-on-light.svg` file for white backgrounds, where the
very light facets on the outline take darker tones of the same palette.

| File                       | Proposal                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `himmelcad.svg`            | Current Builder cloud (polygons unchanged), proposed as the general Himmel:CAD icon |
| `himmelcad-builder.svg`    | Builder: hard hat, front view, 12 facets                                            |
| `himmelcad-photolab.svg`   | PhotoLab: crystal with a light band                                                 |
| `himmelcad-cap.svg`        | Cap (on hold): prism-faceted camera aperture                                        |
| `himmelcad-weltview.svg`   | WeltView: globe centred on Africa/Europe, 45 facets                                 |
| `himmelcad-weltview-b.svg` | WeltView alternative: Atlantic view with the edge of the Americas, 52 facets        |

Continents come from Natural Earth 1:110m land (public domain), heavily simplified.
`overview-round-4.png` shows dark / white / app icon at 96, 48, 32, 16 px.
`generator/generate.py <out-dir>` rebuilds all files, including the berg:work set (needs numpy, scipy, matplotlib).
