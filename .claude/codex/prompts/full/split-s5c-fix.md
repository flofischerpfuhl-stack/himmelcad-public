SPLIT STEP 5c-FIX — remove crate-name aliasing. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Context: step 5c is in the working tree, uncommitted (`docs/builder-program/evidence/SPLIT-S5C-2026-09-24.md`). The move itself is accepted. The architect rejects the aliasing that let moved code compile unchanged:

1. `crates/himmelcad-sidecar/Cargo.toml` declares `himmelcad-core = { package = "himmelcad-domain-photogrammetry", … }`, so every `himmelcad_core::` path in the sidecar (including Builder-only code) resolves through the PhotoLab domain crate. Step 6 must build a Builder sidecar without photogrammetry; this alias makes that impossible and hides the real dependencies.
2. `crates/himmelcad-domain-photogrammetry/src/lib.rs` contains `extern crate self as himmelcad_core;` and `extern crate self as himmelcad_sidecar;` and re-exports the whole foundation (`pub use himmelcad_foundation_core::{…}` etc.) plus shim modules (`pub mod raster_runtime`, `pointcloud_export`, `dense_raster_prep`) so that old paths keep working inside the crate. The dependency `himmelcad-foundation-core = { package = "himmelcad-core" }` is another rename.

FIX (mechanical, zero behaviour change)
- Remove every `package = "…"` rename of a workspace crate in all `Cargo.toml` files; every crate uses its real name.
- Remove the `extern crate self as …` aliases and the blanket foundation re-exports/shim modules from the photogrammetry crate; rewrite `use`/path references in the moved code to the real crates (`himmelcad_model::…`, `himmelcad_document::…`, `himmelcad_prepared::…`, `himmelcad_process::…`, `himmelcad_transform::…`, `crate::…`). Keep a re-export only where an external consumer (sidecar, apps, tests) needs the old public path of a PhotoLab type — and then from the photogrammetry crate's own modules, never a re-export of foundation crates.
- In the sidecar, rewrite `himmelcad_core::photolab_*` / domain paths to `himmelcad_domain_photogrammetry::…` and foundation paths to their real crates, so `cargo tree -p himmelcad-sidecar` shows the true edges. Builder-only sidecar modules must not reach foundation types through the photogrammetry crate.
- Extend `scripts/check-module-dependencies.mjs` (+ fixtures) to FAIL on `package = ` renames of workspace crates in any workspace `Cargo.toml`, and on `extern crate self as` in any workspace crate.
- Fix multi-line `use` lists by hand, not by regex; run `cargo fmt` only on changed crates.

HARD RULES: no schema, serde, default, algorithm, file-format or wire change; tests move verbatim (Rust test count stays 1,237); NEVER `git stash`/`git reset`/`git checkout -- <path>`; Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4`; scratch only under `.build/split-s5c-fix/` (delete at the end); do not commit or push; do not run `bindings:generate`.

GATES (verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-domain-photogrammetry -j 4 -- --test-threads=2`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2`
- `pnpm check:modules`; `node --test scripts/check-module-dependencies.test.mjs`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`
- quote: `grep -rn 'package = ' crates/*/Cargo.toml`, `grep -rn 'extern crate self' crates --include=*.rs`, and `cargo tree -p himmelcad-sidecar --depth 1 -e normal`.

EVIDENCE: append a section "5c-fix" to `docs/builder-program/evidence/SPLIT-S5C-2026-09-24.md` with the rewrite summary, checker change, gates verbatim, measured time.
