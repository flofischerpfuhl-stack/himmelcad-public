# Demanding-user review — File & project domain spec (2026-09-01)

Document class: report/verification evidence. Static review; code citations
spot-checked; one platform claim web-verified (Electron dialog limitation).
Strong spec overall — export-consent wiring, honest passthrough disclosure,
honest §4 delta. Findings, most severe first:

1. **Blocker — C4/E2. Snapshot restore erases its own safety net.** Restore
   to A deletes later snapshots including the just-created "Before
   restoring" safety snapshot; restore scope never defined. _Resolution:_
   snapshots are journal markers about history, exempt from restore (VCS-tag
   semantics); everything else canonical in scope. Tests: restore preserves
   all snapshots; restore-then-Ctrl+Z round-trips.
2. **Blocker — E2/X1. Attach has no units/CRS contract and no placement
   transform.** Silent misalignment of survey data; non-georeferenced
   sources cannot be positioned at all. _Resolution:_ attach compares
   CRS/units — identical → identity, different → refuse with explicit
   transform offer (never silent); reference gets a journaled placement
   transform (identity default, gizmo + numeric twins, automation-settable).
   Tests: CRS-mismatch rejection; placement round-trip.
3. **Blocker — E2. Attach-bake residency and archive travel unspecified;
   §1.5/§1.7 contradict.** _Resolution:_ bake lives in the host project's
   prepared-data store keyed on source manifest revision, retained until
   unreferenced by journal/undo, travels in `.hcadx`; missing source renders
   the last bake read-only with an unresolved badge; Save As discloses
   "includes baked content of N attached projects (sources not included)".
4. **Major — B1. Open dialog cannot be file+directory picker on
   Windows/Linux** (PhotoLab's `['openFile','openDirectory']` at
   apps/photolab/electron/main.ts:1159 is a live defect on Linux).
   _Resolution:_ Open = directory picker for `.hcad`; dropdown "Open
   archive…" for `.hcadx`; drag-drop accepts both; fix PhotoLab handler
   (A3 share-back).
5. **Major — A3/SYSTEM-001. PhotoLab is archive-first with a real Save — the
   opposite lifecycle of D1; "match PhotoLab" untenable.** _Resolution:_
   state the divergence with D1 as reason; queue PhotoLab migration to
   journal-implicit lifecycle in FP-D14; narrow "match" to progress
   presentation, copy, preferences backend.
6. **Major — B1/FP-D2. Ctrl+S is unhandled.** _Resolution:_ bind to an
   affirmation — status-bar pulse + transient "All changes stored —
   Snapshots capture restore points" toast (first uses), console-logged;
   optional second-press snapshot offer.
7. **Major — B1/X4. Undo/Redo only on the File tab.** _Resolution:_
   persistent ribbon-adjacent strip visible on every tab; File·History may
   duplicate.
8. **Major — E2/FP-D2. The "All changes stored" indicator has no failure
   state.** _Resolution:_ on journal-append failure flip to loud "Changes
   are NOT being stored — <reason>"; commands that cannot journal are
   rejected with the error triple; injected-write-failure integration test.
9. **Major — catalog. No disk-space stewardship (immutable store + append
   journal never shrinks).** _Resolution:_ `file.maintenance` / Settings >
   Project > Storage: size by category, "Clean up unreachable data" with
   preview, long-running journaled, `project.maintenance.run`.
10. **Minor — D1.** Undo of a bulk restore is long-running; classify
    bounded-to-long-running with inline progress.
11. **Minor — E2.** Recent-list liveness must not block on dead mounts:
    render from cache, probe async with timeout.
12. **Minor — E1/copy.** Unknown loss codes render as raw code + count,
    never dropped; all-formats-disabled point-cloud case gets one honest
    empty-state sentence.
13. **Minor — C4/FP-D10.** Name the third settings scope: project view
    state (in-project, non-journaled, restored on open, automation-readable).
14. **Minor — E1.** Named visual references overreach (PhotoLab surfaces are
    native OS dialogs; snapshots reference is an unimplemented spec) — the
    written criteria are the primary reference; say so.
15. **Minor — B1/A3.** Builder `snapshot.*` vs `photolab.project.snapshot`
    semantic collision; queue PhotoLab RPC rename (`project.state`).
16. **Minor — E2.** State what a file-manager copy of an open project yields
    (recoverable journal prefix); Save As is the supported live backup;
    cloud-sync warning as idea.
17. **Minor — E2.** Project switch / app quit during running export/pack:
    prompt once, automation gets named rejection.
18. **Idea — named export presets** (P1-class, `export.plan --preset`) — the
    weekly-deliverable accelerator; RIB Dateivorbelegung precedent.
19. **Idea — snapshots list shows "N commands since (last: …)"** from the
    journal.

Answered convincingly: A2 (all checked citations hold — a first), B2, B3,
C1, C2, C3, FP-D5/D6/D11, D2, E3, honest §4 delta.

Owner-decision items: **none** (finding 7's persistent strip stays within
D2's letter — reported as vetoable derived decision).

System feedback (applied to contract 2026-09-01): A3 sibling claims need
verified semantics; C4 restore-class operations must define their
affected-state set.
