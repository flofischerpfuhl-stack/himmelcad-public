# HimmelCAD Branding Assets

The files under `logos/source/` are the unmodified vector masters supplied by
the product owner. They are authoritative and must not be reformatted or
optimized in place.

| Product            | Master                                       | Role                      | SHA-256                                                            |
| ------------------ | -------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| HimmelCAD Builder  | `himmelcad-builder-primary.svg`              | Primary “Azure Tech” mark | `3a919e417991335abca348488744b20e89a17a871c67b8e7c87d3d0a56d8b001` |
| HimmelCAD Builder  | `himmelcad-builder-reserve-hoodie-ready.svg` | Retained reserve mark     | `55db337467be8d98795dc4fbf9dffddd90e69ba0f87c0d8c62a9cc744fad4754` |
| HimmelCAD PhotoLab | `himmelcad-photolab.svg`                     | Primary PhotoLab mark     | `d85081f0030c65284bf077a5d290f584a819c7dedf183e51e7f8b7c0d4163f10` |

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
