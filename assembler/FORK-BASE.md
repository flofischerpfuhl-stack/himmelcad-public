# Assembler render-core fork base

Pins the HimmelCAD commit and crate set that a future Assembler render fork
starts from (ADR 0033). This file records provenance only; it does not itself
perform the fork. No `assembler-render` (or similarly named) crate exists yet.

## Pinned base commit

- **Fork base (full repository HEAD at time of writing):**
  `ac076a1d29bf1ab3be646074f8bc2fc8f2ac5258` — matches the expected
  `ac076a1…`.
- **Last commit touching the four candidate crates:**
  `0a30d7deabe5b6088e79933135863cc26788eeeb` (2026-09-24), from

  ```sh
  git log -1 --format=%H -- crates/himmelcad-render crates/himmelcad-model crates/himmelcad-hardware-profile crates/himmelcad-prepared
  ```

Both hashes are recorded because the repository HEAD moves independently of
these four crates; the second hash is the actual content the fork would copy.

## Relation to the research base

The research conducted on 2026-09-28 (`assembler/research/2026-09-28/`) used
commit `b825a1ca4b57116d14828ca760325c51b84d0130` as its point of reference.
`b825a1c` is dated 2026-09-25, i.e. after the last commit that touched the
four crates (`0a30d7d`, 2026-09-24) and before the current HEAD (`ac076a1`,
2026-09-28).

```
git diff --stat b825a1ca4b57116d14828ca760325c51b84d0130 \
  ac076a1d29bf1ab3be646074f8bc2fc8f2ac5258 -- \
  crates/himmelcad-render crates/himmelcad-model \
  crates/himmelcad-hardware-profile crates/himmelcad-prepared
```

produces no output: the four crates are byte-identical between the research
base and the current HEAD. The newer HEAD (`ac076a1`) is used as the pinned
fork base instead of `b825a1c` because it is simply the current, more
up-to-date commit and carries no risk of missing an unrelated fix elsewhere
in the tree; it changes nothing about these four crates' content or
dependency graph relative to the research base.

## Candidate crates and their direct workspace dependencies

| Crate                        | Direct workspace (`path = ...`) dependencies                          | Notable external dependencies                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `himmelcad-model`            | none                                                                  | `glam`, `serde`, `serde_json`, `thiserror`, `sha2`, `hex`, optional `ts-rs` (feature `ts-bindings`)                                                                                                                            |
| `himmelcad-hardware-profile` | none                                                                  | `serde`, `thiserror`                                                                                                                                                                                                           |
| `himmelcad-prepared`         | `himmelcad-model`                                                     | `brotli-decompressor`, `glam`, `serde`, `serde_json`, `thiserror`                                                                                                                                                              |
| `himmelcad-render`           | `himmelcad-model`, `himmelcad-hardware-profile`, `himmelcad-prepared` | `wgpu` 30.0.0, `gltf`, `gltf-v1`, `draco-gltf`, `meshopt-rs`, `image`, `bevy_basisu_loader_sys`, `earcut`, `indexmap`, `bincode`, `bytemuck`, `glam`, `serde`/`serde_json`, `sha2`, `thiserror`, plus `js-sys` (wasm32 target) |

`himmelcad-render` is the widest dependency graph of the four: it pulls in
`himmelcad-model`, `himmelcad-hardware-profile` and `himmelcad-prepared`
transitively, plus the full wgpu/glTF/mesh-decoding stack. Higher viewer
layers above these four crates (civil/point-cloud/TIN-specific code, per
`assembler/PLAN.md` §4) are explicitly out of scope for the fork and are not
listed here.

## When the actual fork happens

The real fork — copying and renaming these crates — happens only when
Assembler first needs a real viewport (Phase 1 vertical slice or later), not
as part of Phase 0. At that point:

- New crate names are used (for example `assembler-render`,
  `assembler-model`, `assembler-hardware-profile`, `assembler-prepared`),
  distinct from the shared `himmelcad-*` crates.
- The forked crates form a separate dependency graph: they do not depend on,
  and are not depended on by, the shared `himmelcad-render` used by Builder,
  PhotoLab and WeltView.
- The commit pinned above is the intended starting point unless a later
  check at fork time finds a more suitable current state (per
  `assembler/PLAN.md` §4, step 1); such a change updates this file rather
  than silently drifting.
- Builder is never repointed at the fork; ADR 0033 governs this boundary.
