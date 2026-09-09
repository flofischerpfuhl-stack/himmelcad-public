# A7c — tiled ALIKED extraction (PhotoLab package, architect takeover), 2026-09-09

Run 17:40–18:13 by the architect's Codex lane while the PhotoLab session was offline (owner instruction: PhotoLab completion is part of Release 0.5). Brief: `.claude/codex/prompts/full/impl-A7c.md` = takeover preamble + PhotoLab's `a7c.md`; the saved partials under `.build/codex-partials/a7c/` were consulted, not applied blindly.

Landed: tiled ALIKED extraction with a deterministic float32 merge kernel (`dedode_colmap_bridge.rs`), serializable tiling plan (`job_runtime.rs`), COLMAP feature-DB reader (`colmap_feature_db.rs`, new; `rusqlite` 0.37 bundled — a new dependency, recorded as a deviation from the lane's "no new dependencies" rule because the COLMAP database is SQLite), primary-store selection and admission override (`main.rs`), summary fixtures (`project_runtime.rs`).

Verification (implementer, target/photolab): focused A7c tests 8/8; sidecar lib 324 passed, 8 ignored, 2 failures outside A7c (`g_mi_command_measurements_round_trip_and_delete_atomically`, `group_commit_machine_gate_reports_p95_latency` — Builder-lane, re-checked after R-02); sidecar main bin 97; portable MVS 13; core 240 + 1; PhotoLab 86 + 8; formatting, PhotoLab typecheck, English UI check green. Architect: staged-snapshot verification (root tsc -b, sidecar check) before commit.

Not run: the tiled-extraction smoke (`a7c-run.md`; load was 8.8 at the decision point) — command recorded in `.claude/codex/out/impl-A7c.last.md`; runs when load < 3 and ≥ 20 GB are free.

Contract gaps (doctrine rule 2, for the PhotoLab session): WP-A7c item 1 — COLMAP's schema stores no ALIKED score, the permitted row-order/size proxy is used; item 3 — "DeDoDe: out of scope, refuse typed" has no admission-time condition; ALIKED alone is tiled, SIFT/DeDoDe untiled, Quality Hybrid is not refused for needing tiling.
