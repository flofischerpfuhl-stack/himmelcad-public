SPLIT STEP 5d — project store into document, drafting domain, automation runtime into command. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-S4A-2026-09-23.md` ("What stayed and why": `canonical_project_store`); `docs/builder-program/evidence/SPLIT-S5B-2026-09-23.md` and `SPLIT-S5C-2026-09-24.md` incl. their "Architect review" sections (rejected constructs); then the code you move.

GOAL (zero behaviour change)
1. `canonical_project_store` (sidecar, ~3.4k lines) moves into `himmelcad-document`. It is blocked because it owns `himmelcad_io::{CanonicalImportPackage, CanonicalJsonObject, CanonicalPreparedDataset, CanonicalResourceSet, ProviderContractError}`. Move those provider/package contract types down into `himmelcad-model` (or `himmelcad-document` if they are document-level) so that io re-exports them and the store no longer needs io; if the import-publication adapter needs io behaviour (not just types), split that adapter off and leave it in the sidecar — record why.
2. New `crates/himmelcad-domain-drafting` (layer domain): measurement, drawing/construction, view bookmarks and viewing-box/fence command logic now living in `canonical_app_runtime.rs` and `main.rs` helpers — the logic only; route dispatch stays in the legacy registry module (step 6 moves routes). Use the pattern accepted in 5b: domain services behind narrow traits in `himmelcad-document::domain_commands`, implemented by the sidecar.
3. `automation_runtime` (sidecar, ~1.6k lines) moves into `himmelcad-command` if it only needs command-layer and foundation crates; otherwise record why.
4. What remains in `canonical_app_runtime.rs` should be the sidecar's orchestration and trait implementations only; list what is left and why.
5. Compatibility re-exports at old sidecar paths; list consumers. New crate in `scripts/module-layers.json` as `domain`; allowlist only shrinks.

REJECTED CONSTRUCTS (checker enforces; do not attempt): `include!` of files outside the crate; `#[macro_export]` in domain crates; macros expanding into another crate; `package =` renames of workspace crates; `extern crate self as …`; blanket re-exports of foundation crates from a domain crate; duplicate type definitions in two crates.

HARD RULES
- Store crash safety moves verbatim: journal-last order, ready marker, fsyncs, write-ahead intent, recovery and quarantine code, group-commit behaviour. No schema, serde, default, algorithm, file-format or wire change.
- Tests move verbatim — never change scratch paths, temp directories or timing bounds. Rust `#[test]`/`#[tokio::test]` count across `crates/` stays 1,237 (report before/after).
- NEVER `git stash`, `git reset`, `git checkout -- <path>`; HEAD comparisons only via `git worktree add .build/split-s5d/head HEAD` with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split-head`; remove the worktree AND that target directory afterwards (the external SSD filled up in 5c).
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4`. Before building check `df -h /media/oem/ZusatzSSD1`; if < 15 GB free run `cargo clean -p himmelcad-sidecar` in that target dir. Never copy the repo or datasets; scratch only under `.build/split-s5d/`, delete at the end. Do not commit or push. Do not run `bindings:generate`. Fix `use` lists by hand. If you change a source path that scripts or docs name literally (e.g. `scripts/*.mjs` reading `crates/.../*.rs`), update those references and list them.

GATES (verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-document -p himmelcad-model -p himmelcad-io -p himmelcad-command -p himmelcad-domain-drafting -j 4 -- --test-threads=2`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2`
- the group-commit gate alone: `cargo test -p himmelcad-document group_commit_machine_gate -j 4` (or its new location) — must pass when run alone
- `pnpm check:modules`; `node --test scripts/check-module-dependencies.test.mjs`; `pnpm test:dxf-registration-import`; `pnpm --filter @himmelcad/builder test`; `pnpm --filter @himmelcad/app test`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`
- quote: `grep -rn 'include!(' crates --include=*.rs | grep -v 'include_str\|include_bytes'`, `grep -rn macro_export crates/himmelcad-domain-*`, `grep -rn 'package = ' crates/*/Cargo.toml`, `grep -rn 'extern crate self' crates --include=*.rs`, `wc -l crates/himmelcad-sidecar/src/*.rs`.

EVIDENCE `docs/builder-program/evidence/SPLIT-S5D-2026-09-24.md`: moved items (from → to, lines), contracts moved down, traits introduced, what stayed and why, compatibility consumers, allowlist diff, test counts, gates verbatim, what was NOT verified, measured wall-clock time.
