# Dependency and vendoring policy

## Product license boundary

Himmel:CAD is source-available under the Business Source License 1.1 (see
`LICENSE` and `LICENSING.md`), is dual-licensed commercially, and converts to
AGPL-3.0-or-later per version after four years. A dependency must be
compatible with all three before it enters product code or a shipped runtime;
in practice that means permissive or file-level copyleft licenses, plus LGPL
components only under the conditions in "Conditionally allowed: LGPL".

## Disallowed product inputs

- GPL, AGPL (as an input into product code; the repository's own future
  AGPL-3.0-or-later conversion is a distribution outcome, not an input), SSPL,
  and incompatible Commons Clause code.
- Copied, ported, translated, or derived implementation from incompatible code.
- Reference repositories under `libs/` as build inputs or vendored source.
- Runtime files whose license or complete dependency closure is unknown.

Reference implementations may guide requirements or black-box behavior, but a
clean implementation must come from standards, papers, independent derivation,
or compatible source.

## Conditionally allowed: LGPL

LGPL does not blanket-conflict with BUSL-1.1 distribution or with the
AGPL-3.0-or-later conversion, so it is not banned outright (owner intent U11
in `assembler/OWNER-INTENT.md`). This policy admits no LGPL component by
itself; a component enters only when every condition below is checked and
recorded for it by name (see the list after condition 7).

1. **Record it precisely, before it ships.** Exact component, version, LGPL
   variant (2.1-only, 2.1-or-later, 3.0, or a variant with a special exception
   such as OCCT's), and link type (dynamic/shared library, or separate
   process) go into `LICENSES/THIRD_PARTY.md` before the component enters a
   product.
2. **Stay a separately replaceable unit.** The LGPL component remains a
   shared/dynamic library or a separate process. No static linking into a
   BUSL-1.1 binary.
3. **Publish modifications under LGPL.** Changes to the LGPL component itself
   are published under its own LGPL, with corresponding source available for
   each shipped release. License texts and notices ship with the product.
4. **Do not contract around it.** Product terms must not forbid what the
   LGPL license requires to permit: modifying or replacing the library, and
   reverse-engineering it for the purpose of debugging such modifications.
5. **Derived/ported code stays LGPL.** Code derived from, or ported from, an
   LGPL source (for example a Rust port of FreeCAD logic) keeps its LGPL
   obligations regardless of source language: a separate crate or package,
   carrying LGPL headers and notices, never relicensed as BUSL-1.1.
6. **Check the future AGPL conversion per component.** LGPL-2.1-or-later and
   LGPL-3.0 components combine into a work distributed under
   AGPL-3.0-or-later without a separate compatibility case. An
   LGPL-2.1-only component (no "or later" grant) needs its own documented
   compatibility check before admission, recorded next to its
   `LICENSES/THIRD_PARTY.md` entry.
7. **Enforcement stays per-component, never blanket.** `deny.toml` and
   `scripts/check-licenses.mjs` gain an explicit exception for a concrete
   admitted component (name, version, license variant) when it is actually
   admitted. Neither file grants a general LGPL allowance.

Admitted so far (each recorded in `LICENSES/THIRD_PARTY.md` "Conditionally
admitted LGPL components"):

- `replicad-opencascadejs` 1.1.0 (OCCT 8.0.1, LGPL-2.1-only with the Open
  CASCADE exception), a runtime-loaded WebAssembly module in the Assembler
  CAD-kernel worker; admitted 2026-09-29 with an exception in
  `scripts/check-licenses.mjs` (no crate, so `deny.toml` is unchanged).
- `@salusoft89/planegcs` 1.2.0 (FreeCAD planeGCS, LGPL-2.0-or-later), a
  runtime-loaded WebAssembly module + JS chunk in the Assembler sketch-solver
  worker; admitted 2026-09-29 with an exception in `scripts/check-licenses.mjs`.

## Usually compatible inputs

MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, Zlib, CC0, Unlicense, and
MPL-2.0 with preserved file-level separation may be used when their exact terms
and complete transitive/runtime closure have been checked.

This list is guidance, not automatic approval. Dual licenses, optional features,
native binaries, models, fonts, datasets, and generated artifacts must be
checked separately.

## Required workflow

Before adding a dependency, model, dataset, binary runtime, or vendored code:

1. Verify the exact version and license in both the official source and lockfile
   or shipped artifact.
2. Audit relevant transitive and runtime dependencies.
3. Add or update the entry in `LICENSES/THIRD_PARTY.md`.
4. Record attribution, source revision, local modifications, and redistribution
   requirements.
5. For modified third-party source, prefer an explicit `vendor/<name>/`
   boundary with provenance over hidden patches.
6. Leave uncertain inputs out of product and release builds until resolved.

Product code lives in `apps/`, `packages/`, `crates/`, or explicitly documented
`vendor/` directories. `libs/` is reference material only.
