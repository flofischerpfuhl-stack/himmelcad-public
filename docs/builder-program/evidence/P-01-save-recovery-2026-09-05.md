# P-01 — Builder save and recovery path

Date: 2026-09-05

## Outcome

Builder now has a complete working-project lifecycle on the S-07 durable journal substrate:

- **New** creates a user-chosen `.hcad` working directory.
- **Open** selects a `.hcad` directory. The split-menu archive action selects a `.hcadx` and asks for a new working-project destination before extracting it.
- **Recent** is a main-process MRU list persisted below Electron `userData`, de-duplicated and bounded to 10 entries by default. `HCAD_RECENT_PROJECT_LIMIT` tunes the bound from 1 to 100. Startup reads the cached list immediately and probes liveness concurrently with a bounded wait so a dead mount cannot stall the ribbon.
- **Save** uses S-07 `project.flush`, including its manual snapshot marker, and returns only after the journal head and manifest are durable.
- **Save As…** flushes first, then registers a cancellable S-05 `Saving archive` job. Packing reports scan/write/validate/publish phases and byte progress. It writes a hidden sibling candidate and exposes the final atomic rename as non-cancellable; cancellation or failure removes the candidate and leaves an existing destination unchanged.
- **Close** has no dirty-state prompt. It displays `Storing changes…`, offers **Cancel** while storing, drains local selection state, flushes/closes the canonical session, and only then unloads project UI/viewport resources. Cancel keeps or reopens the project after the durability boundary; it never abandons an accepted journal tail.
- **Relaunch recovery** attempts the last project first. A replayed crash tail produces the warning toast `Recovered N unsaved changes from <time>` with **Show in console**, and writes the same report to the console. A missing or unresponsive last project falls back visibly instead of failing silently.
- **Project replacement** uses the same close boundary before opening New/Open/Recent/archive destinations. Selection state is stored then unloaded, and the keyed viewport subtree is disposed without editing the S-08-owned viewport/HUD implementation.

The ribbon's former Project tab is now **File**. Its first group is New, Open, Recent, Save, Save As…, Close; Import remains the following group. Shared `Ribbon` actions support accessible primary/menu split controls and the Recent rows show a muted monospace path below the name. The gallery section **File surfaces** contains the Recent menu and recovery warning toast; dark and light shots were regenerated serially and inspected.

## Format and architecture decisions

- `.hcad` remains the mutable working-project directory and `.hcadx` remains the portable archive copy. Save As does not move or retarget the working project.
- A small canonical `manifest.json` (`hcad.project-manifest@1`) is atomically published at the S-07 durability boundary. It records project identity, generation, and journal-head sequence and makes canonical Builder projects valid archive inputs.
- Archive extraction retains the existing defensive entry/count/size/path checks. Working-project lock files are excluded.
- Owner decision D5 is only a seam here: the archive preserves canonical project/product data, but no project-as-block/xref behavior or fragment export was introduced. The planned fragment profile remains later work.

## Changed surfaces

- `apps/builder/electron/projectLifecycle.ts`, `main.ts`, and `preload.ts` — durable MRU/startup state, bounded liveness, native New/Open/archive/destination dialogs, lifecycle IPC, close handshake, and S-05 archive-job integration.
- `apps/builder/renderer/src/App.tsx`, `project.ts`, and `ribbon.ts` — lifecycle orchestration, flush/close/replacement boundary, recovery reporting, P11 dispatch, drag/drop project opening, and File ribbon surfaces.
- `packages/@himmelcad/ui/src/Ribbon.tsx` and `Ribbon.module.css` — reusable split-menu actions and two-line Recent menu copy; gallery File surfaces and regenerated shots.
- `apps/builder/test/projectLifecycle.test.ts` — persistent, bounded, de-duplicated MRU and extension/tuning checks.
- `schemas/automation/himmelcad-automation-v1.schema.json`, generated command tables/Python SDK, and app registry tests — P11 rows `project.new`, `project.open`, `project.recent`, `project.save`, `project.save_as`, and `project.close`.
- `crates/himmelcad-sidecar/src/project_archive.rs` — cancellable sibling-candidate archive replacement, canonical-manifest validation, working lock exclusion, and G-FP-2 regression coverage.

### Shared sidecar notice

The shared PhotoLab lane was not changed. Shared-file edits are limited to Builder canonical/archive routing and the format seam needed by Builder:

- `main.rs`: existing `handle`; new `handle_builder_archive_rpc`; new `emit_builder_archive_progress`.
- `canonical_app_runtime.rs`: new read-only `project_root` accessor.
- `canonical_project_store.rs`: `flush_group_commits`; new `publish_manifest`.
- `project_archive.rs`: new `pack_hcadx_replace_with_cancel`; `validate_manifest`; `is_excluded`; new cancellation/replacement test.

No PhotoLab RPC route, PhotoLab save/save-as handler, PhotoLab job, or PhotoLab manifest writer was edited.

## Concurrency and failure recovery

- Canonical edits and archive packing share the existing canonical runtime mutex. Save As drains the journal and holds that boundary through packing, so the archive represents one stable journal head.
- Cancellation is accepted during journal flush and archive writing. A pre-pack cancellation is remembered; an in-flight cancellation reaches the sidecar operation registry. The final sibling rename is deliberately a short non-cancellable phase.
- Window close and application quit use a renderer/main-process handshake. The sidecar is not stopped until the renderer confirms the close-time flush.
- MRU preference writes are serialized, fsynced, and atomically renamed. Preference corruption is reported and ignored without jeopardizing project data.
- Recent/open/startup paths are validated in the main process. Archive destinations must not already exist; `.hcadx` is never treated as a mutable project.

## Gates and verification

### G-FP-1 — exact journal head after close/reopen

Covered by the sidecar canonical-runtime/store reopen suites, notably `protocol_commits_reopens_and_pages_the_durable_journal`, close-time drain tests, snapshot-marker round trips, and crash-tail recovery. The archive manifest is published from the same durable generation/head boundary.

### G-FP-2 — no partial archive after interruption

`g_fp_2_cancelled_replacement_preserves_existing_archive_and_cleans_candidates` exercises cancellation during replacement and verifies both that the prior destination survives byte-for-byte and that no sibling candidate remains. The S-05 bridge reports cancelled/failed distinctly; publish begins only at the atomic rename phase.

### G-FP-3 — imports/jobs/project/MRU survive relaunch

- Existing S-05 `three-import bridge gate keeps progress and cancellation across reload` covers three concurrent registered import jobs and rehydrated chips/cancellation.
- `residency_reopens_exact_staged_point_cloud_and_filters_deleted_entity` covers canonical imported-residency reopen at the durable head.
- Existing selection tests cover store/unload/rehydrate on project replacement.
- New `G-FP-3 recent project list is durable, de-duplicated and bounded` covers MRU restart persistence and last-project ordering.

### Commands

- `pnpm --filter @himmelcad/app test` — **passed**, 43/43.
- `pnpm --filter @himmelcad/builder test` — **passed**, 9/9.
- `pnpm --filter @himmelcad/ui test` — **passed**, 33/33, including axe fixtures.
- `python3 scripts/generate-automation-sdk.py --check` — **passed**; generated SDK is current.
- `pnpm exec tsc -p apps/builder/tsconfig.typecheck-electron.json --noEmit` — **passed**.
- `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs check -p himmelcad-sidecar` — **passed** before the concurrent S-08 render-model edits, with the pre-existing dead-code warning for `ProjectRuntime::product_export_source`.
- `CARGO_TARGET_DIR=target/builder cargo test -p himmelcad-sidecar` — **blocked before test execution outside P-01** in its single requested end-of-pass invocation: concurrent S-08 changes made `TileDescriptor.prepared_point_metadata` required while `crates/himmelcad-io/src/geotiff_preparation.rs:516` and `slpk_provider.rs:881` still omit it. Cargo exited 101. P-01 did not edit either file or the shared render descriptor.
- Scoped `git diff --check` on P-01 surfaces — **passed**.
- `pnpm --filter @himmelcad/builder typecheck` — **blocked outside P-01** by concurrent S-08 changes in protected viewer/HUD files: `KernelStreamingFramePlan.frontier` is absent from five viewer test fixtures, and `BuilderKernelViewport.tsx` lacks labels for four new telemetry reason keys.
- `pnpm --filter @himmelcad/photolab typecheck` — **blocked outside P-01** by the same five S-08 viewer fixtures. P-01 did not edit those files.

## Not verified / follow-up

- No destructive OS-level kill was injected into a live packaged Electron process. The archive cancellation/cleanup invariant is verified at the filesystem implementation boundary, and the renderer/main job bridge is covered separately.
- The G-FP-3 pieces are covered by real canonical import/residency, three-job rehydration, replacement-state, and persistent-MRU tests, but not by one end-to-end packaged-Electron script importing three external source files and killing/relaunching the process.
- POSIX sibling rename replacement was exercised on this Linux runner. Windows rename-over-existing behavior is not relied upon by the UI because Save As rejects an existing destination, but was not run on Windows.
- S-08 owns camera/display ViewState, HUD, and viewport code. P-01 intentionally uses its project boundary and keyed disposal seam and did not alter those protected implementations.

## Architect review (G17, 2026-09-05)

`gallery/shots/dark/file-surfaces.png`: Recent menu (name + muted mono path) and the warning-kind recovery toast with "Show in console" match the brief — accepted. Fixture nit for the next ui-fixes pass: the toast overflows the section column so its close button is clipped; widen the fixture container, not the toast. Final typecheck/sidecar test verification deferred to V-02's landing (its in-flight `KernelStreamingFramePlan.frontier`/`prepared_point_metadata` changes blocked P-01's last gates); commit follows that verification.
