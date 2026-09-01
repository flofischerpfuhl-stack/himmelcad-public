# Dependency and vendoring policy

## Product license boundary

Himmel:CAD is source-available under the repository license. Commercial use or
distribution requires permission from the rights holder. A dependency must be
compatible with that distribution model before it enters product code or a
shipped runtime.

## Disallowed product inputs

- GPL, LGPL, AGPL, SSPL, and incompatible Commons Clause code.
- Copied, ported, translated, or derived implementation from incompatible code.
- Reference repositories under `libs/` as build inputs or vendored source.
- Runtime files whose license or complete dependency closure is unknown.

Reference implementations may guide requirements or black-box behavior, but a
clean implementation must come from standards, papers, independent derivation,
or compatible source.

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
