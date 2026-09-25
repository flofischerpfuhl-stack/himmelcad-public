# Himmel:CAD Branding Assets

The files under `logos/source/` are the unmodified vector masters supplied by
the product owner. They are authoritative and must not be reformatted or
optimized in place.

| Product                  | Master                                       | Role                                                          | SHA-256                                                            |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Himmel:CAD, Builder      | `himmelcad-builder-primary.svg`              | Cloud: general Himmel:CAD icon, Builder until it gets its own | `3a919e417991335abca348488744b20e89a17a871c67b8e7c87d3d0a56d8b001` |
| Himmel:CAD               | `himmelcad-on-light.svg`                     | Cloud for light backgrounds                                   | `4d6cac100259d20d882340c4a0ad38508c402f660493fe8c4474fc25972c1dc8` |
| Himmel:CAD Builder       | `himmelcad-builder-reserve-hoodie-ready.svg` | Retained reserve mark                                         | `55db337467be8d98795dc4fbf9dffddd90e69ba0f87c0d8c62a9cc744fad4754` |
| Himmel:CAD PhotoLab      | `himmelcad-photolab.svg`                     | Crystal, primary PhotoLab mark                                | `462b9ebd2dd701c3d7fa9d1ec50f4ea6a3c95f9b318fab3a3a545663bf92c310` |
| Himmel:CAD PhotoLab      | `himmelcad-photolab-on-light.svg`            | Crystal for light backgrounds                                 | `298a988dce99087a802d3a9284437831bdc6a7485f7f31ab3170531dee7f1fcb` |
| Himmel:CAD WeltView      | `himmelcad-weltview.svg`                     | Globe, primary WeltView mark                                  | `051bfb9b2f8d4b5f90552fbeb5485634171d102f5de3126dcc6777d810cb56bd` |
| Himmel:CAD WeltView      | `himmelcad-weltview-on-light.svg`            | Globe for light backgrounds                                   | `67b65c929959c4841163e3f29c76b41ca9f49cc88a3789ed52c35b5b694a66bf` |
| Himmel:CAD Cap (on hold) | `himmelcad-cap.svg`                          | Aperture, kept for Cap                                        | `72e6130ab1b27cc5fdbb1357de54eef2f7f0f6ed567d352dab3a4c5edf3da90a` |
| Himmel:CAD Cap (on hold) | `himmelcad-cap-on-light.svg`                 | Aperture for light backgrounds                                | `10838ae50b60690c68a798ec6fdc35d9fab8f87c957137e5f17eacf553ce80dd` |

The PhotoLab crystal, WeltView globe, Cap aperture and all `-on-light` masters
were approved by the product owner on 2026-09-25. They come from the low-poly
logo round in `logos/proposals/2026-09-25/`, where `generator/` rebuilds them.
`-on-light` masters darken the lightest outline facets so the mark holds on
white; they have no generated icon sets. WeltView uses its masters directly
(`apps/weltview/public/favicon.svg`, `apps/weltview/src/assets/weltview-mark.svg`);
Cap's icon set is generated but not wired into the Flutter app while Cap is on hold.

Run `pnpm branding:generate` from the repository root to regenerate the app
icon PNG sizes and multi-resolution Windows ICO files. OS app icons place the
optically centred original mark on an opaque black rounded-square card; only
the pixels outside the rounded corners are transparent. The un-carded
`mark-512.png` remains available for title bars and in-product branding.

The generator verifies the exact master hashes, uses a fixed epoch, strips time
metadata, and publishes `icon.png`, `icon.ico`, and `mark.png` to the selected
desktop applications' `build/` directories. `pnpm branding:check` regenerates
into a temporary directory and byte-checks every committed derivative.

The generated asset directories are committed so packaging does not depend on
Inkscape or ImageMagick being available on release machines. Any change to a
vector master must be explicitly supplied and approved by the product owner.
