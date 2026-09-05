# Himmel:CAD Builder completion program — master plan

> **Revision 2026-09-02 late (owner decision D9 accepted).** Release 0.5 is
> re-cut as **"DGM aus Scan"** and becomes the active commercial-alpha queue.
> The PhotoLab + Builder-alpha bundle, source-available roadmap positioning,
> temporary three-lane/token discipline, starter-level real-scan acceptance,
> and model-routing trial are incorporated below. Owner question count: zero.

> **Revision 2026-09-02 evening (owner batch 3).** Owner decision Q1 activates
> Branch A: Builder implementation runs now in parallel with the separately
> owned PhotoLab release effort. That historical revision added the owner-defined
> **M-RW — Trimble RealWorks starter** outcome, integrates its missing packages
> into the then-current queue and adopted the multi-session protocol in
> `COORDINATION.md`; D9 above supersedes its 0.5 sequencing and estimates.
> PhotoLab release gates retain priority whenever shared resources contend.
> Owner batch 3 introduces zero owner questions.

> **Revision 2026-09-02 (owner batch 2).** Owner decision D7 un-defers the
> Civil domain, and the rebuilt round-3 Registry admits it as `specified`.
> This revision incorporates owner statements batch 2, current C1 and P8–P11,
> the Civil review amendments, and the PhotoLab release-polish cross-product
> obligations. R1 gate 8 is **UNMET** until the Builder registration capability
> and PhotoLab WP-G1 pass together. No new owner question is introduced.

Status: execution plan, 2026-09-02. This is the last program document the
owner reads and the first document autonomous implementation reads.

## 0. Authority, outcome, and current boundary

The program outcome is a finished Builder in which a civil-engineering user can
open real survey data, navigate and edit it without interaction stalls, derive
auditable terrain and measurements, author semantic objects, compose a
scale-true plan, save/recover every deliberate act, and perform the same work
through the generated SDK and the embedded Agent without crossing the trust
boundary.

This plan sequences work; it does not weaken any owning contract. Authority is:

1. accepted ADRs and the normative documents indexed by `docs/README.md`;
2. `docs/DECISION-DOCTRINE.md` and `docs/FUNCTION-CONTRACT.md`;
3. `docs/CURRENT-DIRECTION.md` and owner decisions;
4. the domain decision record that owns the behavior;
5. this plan, for order, integration gates, and execution protocol.

If these disagree, the higher authority wins and the re-walk rule in §9.6 runs
before implementation continues. A milestone is not complete because its UI is
visible, its entity exists, or its catalog row is registered. It is complete
only when its user outcome, integrations, performance gates, persistence gates,
and demanding-user review pass together.

Program input snapshot:

| Input                    | State used by this plan                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder program registry | v3 baseline: 203 rows; 0 duplicate acts; 0 contradictory guarantees; 0 dangling decision ids; 0 unowned baseline capabilities; 0 open F1–F14 findings; all 15 baseline specs `specified`. M-RW's batch-3 spec/row delta requires the next registry re-walk before its new packages are ready. |
| Review findings          | Baseline review objections are dispositioned, including all 16 Civil findings. Batch-3 Pointcloud/Mesh amendments and the pending Registration/Stations spec must pass their own review before D-RW implementation.                                                                           |
| Normative prerequisites  | Registry §4.4 items 1–9 remain pending admissions rather than ADR authority except item 8, promoted to ADR 0030 (Proposed); pending additions include Civil schema, stable segment locator, local histories, and registration/station/panorama-depth resources.                               |
| Owner question           | None. Q1 was answered on 2026-09-02: Branch A is active.                                                                                                                                                                                                                                      |
| Current product priority | Builder implementation runs in parallel with the separately owned PhotoLab release effort; under `COORDINATION.md` §7, a failing PhotoLab release gate takes precedence on shared resources and Builder yields.                                                                               |
| Deferred programs        | Registration/stations is promoted into M-RW; its owning spec at `specs/registration-stations/registration-stations.md` is pending while being written. GIS and settings-content remain outside this 15-spec baseline. Civil is admitted by D7 and Registry §4.5.                              |

No agent may infer that a clean registry means the implementation exists. The
registry proves catalog consistency, not runtime completion.
Owner batch 3 question count: **0 owner questions**. The branch table remains
in §1 as the execution record; Branch A is now binding.

The round-3 Registry baseline is reproduced without reinterpretation below.
It is historical input for this amendment, not proof that the newly promoted
M-RW Registration/Stations domain or batch-3 rows have completed their re-walk:

| Check                                           | Count | Result                                                                                                                                                               |
| ----------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered function rows                        |   203 | all current catalog rows represented; shared acts and access contributions are registered once                                                                       |
| Duplicate acts                                  |     0 | pass; `derived.recipe-manage`, `file.import`, `draw.point`, `mesh.create-surface`, `inspect.point_info`, `view.mode`, and `document.history` each have one owner row |
| Contradictory guarantees                        |     0 | pass across surfaces, P8 histories, P9 permission/overlay state, P10 recipes, import/attach, and Plan/View ownership                                                 |
| Dangling decision ids in the reconciliation set |     0 | pass                                                                                                                                                                 |
| Unowned current-program capabilities            |     0 | pass; Gaussian-splat arrival is Pointcloud-owned and Civil is admitted                                                                                               |
| Open registry findings F1–F14                   |     0 | pass; F1 remained closed and F2–F14 are closed below                                                                                                                 |
| Pending current-program domains                 |     0 | pass; wave 1, wave 2, Civil, batch 2, and IF-D19–IF-D25 are registered                                                                                               |
| Specs at `specified`                            |    15 | every spec has registered rows, a current-doctrine re-walk, and no open registry finding                                                                             |
| Specs at `drafted`                              |     0 | pass                                                                                                                                                                 |

Cataloged-deferred rows remain registered, named contracts and are not unowned
acts. Missing runtime gates or pending ADR admissions are implementation
readiness blockers, not registry/specification-status failures.

## 0a. Releases and the two meanings of "done" (architect, 2026-09-02 late)

Owner decision D9 (`OWNER-DECISIONS.md`) supersedes D8's Release 0.5 cut while
retaining D8's Release 1.0 definition and temporary token discipline:

| Release                | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Nature                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.5 "DGM aus Scan"** | import → fluid view + HUD → viewing box with lock → ground extraction → **fence segmentation (keep inside / remove inside, S21)** → sampling/rasterize → lines with snapping (breaklines, boundary, tri-modal input) → DGM window with error fixing → DGM editing (region smoothing, downsampling) → DXF/LandXML export (exists) + measurement basics. **Excluded from 0.5:** classification beyond ground (segmentation is IN per S21), station view, registration UI, civil, specifications, plan editor, BIM. | internal alpha for the owner and 2–3 pilot offices; no installer/updater. All work remains on the 1.0 path; estimate 1.5–2 weekly Codex budgets and 2–3 weeks with three lanes. |
| **1.0**                | M-RW ("Trimble RealWorks starter", S16) + Gaussian-splat display (render provider exists; wiring + display properties)                                                                                                                                                                                                                                                                                                                                                                                           | first public Builder release                                                                                                                                                    |

Two meanings of "done" carry different estimates and both are reported:

- **Usable at starter level** — the owner and 2–3 pilot offices can complete the
  full 0.5 "DGM aus Scan" workflow end to end through visible UI on real scan
  datasets; each included slice's named interaction, correctness, persistence,
  recovery, and real-data gates pass; implementation review has no open
  blocker. No installer or updater is required for this acceptance. Estimate:
  1.5–2 weekly Codex budgets / 2–3 weeks with three lanes.
- **Milestone closed** — every M-RW gate incl. real-data fixtures, the measured
  TRW comparison protocol, station-view preprocessing budgets, and the
  pending data-model admissions/ADRs. Estimate (this plan's §6 tables): 8–12
  calendar weeks with sustained lanes, extendable whenever a failing PhotoLab
  release gate takes priority.

Token discipline (D8): specs change only from implementation findings; one
demanding-user review per implementation slice; the implementer brief
(`.claude/codex/prompts/_impl_brief.md`) replaces broad reading lists;
reasoning effort `medium` by default, `high` for reviews and design-heavy
substrate slices; I-07 (deterministic registry linter) replaces LLM registry
rebuilds; three lanes, not six.

## 0b. Commercial target and go-to-market

D9 is accepted. The first commercial target is a bundle of production-ready
PhotoLab and the Builder 0.5 alpha ("DGM aus Scan") for pilot offices. Position
the bundle as source-available under a restrictive license with a transparent
roadmap: free surveyors from the Trimble/Autodesk stranglehold, sell the useful
core now at a fraction of the incumbent cost, and use the specifications and
registry as roadmap evidence.

Architect caveats are binding: publish no dates; the delivered core must be
daily-usable for the first customer; and PhotoLab R1 gates must be executed,
not asserted. **Model routing trial:** run I-03 on `gpt-5.6-terra` as an A/B
trial against I-02 on `gpt-5.6-sol` at `medium`, measuring total tokens and
review findings before any broader routing change.

## 1. Q1 execution branches — Branch A active

Q1 asked whether Builder implementation may start in parallel with PhotoLab or
whether PhotoLab retains exclusive implementation priority. The owner selected
Branch A on 2026-09-02. Both branches are retained as the decision record; the
active branch is marked and uses the same ordered queue.

| Rule                          | **Branch A — ACTIVE: Builder starts now in parallel**                                                                                                                       | Branch B — inactive alternative                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation                    | **Active by owner decision, 2026-09-02**                                                                                                                                    | Retained for decision history; not active                                                                                                                       |
| First work                    | Execute I-01 through I-07, then the minimum shared substrate and D9's ordered 0.5 slices                                                                                    | Execute I-01 through I-07, then X-P11/X-R1 as PhotoLab-serving work                                                                                             |
| Why iteration work is allowed | It shortens both product loops and reduces verification false failures                                                                                                      | It directly improves PhotoLab development, verification, and release work                                                                                       |
| Shared platform               | Implement after I-07; prioritize shared packages and prove PhotoLab compatibility                                                                                           | X-P11 and the Builder half of X-R1 are allowed because PhotoLab consumes them; otherwise planning, registry upkeep, benchmark design, and read-only audits only |
| Pure Builder domains          | May start only after the shared substrate milestone passes; they must not take capacity needed by a failing PhotoLab release gate                                           | Forbidden until PhotoLab releases or the owner changes Q1                                                                                                       |
| PhotoLab regression rule      | Every shared change runs affected PhotoLab gates before merge; a failing PhotoLab release gate takes priority on shared resources and Builder yields (`COORDINATION.md` §7) | PhotoLab gates are the purpose and primary acceptance condition                                                                                                 |
| Stop line                     | Stop only at an unmet prerequisite, failed gate, or genuine doctrine escalation                                                                                             | Stop after X-P11/X-R1, or earlier at their unmet ADR/gate prerequisite; maintain plans and evidence without other feature-code expansion                        |

Branch A is binding under `docs/CURRENT-DIRECTION.md` and
`OWNER-DECISIONS.md`. Work therefore proceeds beyond the shared substrate when
its prerequisites pass, but parallel execution never means unrestricted file
concurrency: `COORDINATION.md` owns path lanes, single-writer shared substrate,
Cargo target separation, daily sync, and the PhotoLab priority rule. Branch B
requires a future explicit owner reversal; agents do not infer it from a delay
or a failed gate.

## 2. Sequencing doctrine

### 2.1 Rules derived from the doctrine

| Doctrine                                          | Program rule                                                                                                          | Observable consequence                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| X1 correctness, data integrity, security          | Admit schemas and authority before persisting new state                                                               | No substitute measurement, edit-lock, ViewState, Plan, snapshot, or journal-actor record ships before its ADR/migration       |
| X1 priority order                                 | Performance work never weakens correctness to gain speed                                                              | Cache/link/profile changes run correctness and release-artifact parity gates                                                  |
| X2 spend preprocessing, protect interaction       | Build jobs, prepared artifacts, and iteration infrastructure before feature breadth                                   | Long work leaves input/render threads; dev and verification loops are measured first                                          |
| X3/P1 canonical deliberate state and agent parity | One command/query contract serves UI, console, Python, and Agent                                                      | Schema/generator/host/SDK changes land as one sequenced transaction                                                           |
| X3 trust asymmetry                                | User-only approvals are absent from automation by construction                                                        | Agent comes after the shared trust and I/O boundaries stabilize                                                               |
| X4 reference posture                              | Reference-backed workflows set defaults without overriding X1                                                         | Domain sequencing follows the adopted workflows, not toolbar similarity                                                       |
| X5 interaction symmetry                           | Typed/picked, do/undo, open/close, link/pin, and hide/show pairs ship together                                        | No one-sided tool or lifecycle is counted as a milestone outcome                                                              |
| X6/P3 delegated calibration                       | Agents set and revise numeric thresholds only with committed evidence                                                 | Every tunable gate records hardware, fixture, before/after, and rationale                                                     |
| X7 precedent class                                | Shared interaction, job, persistence, and style records land once                                                     | Consumers cite the platform record and do not fork it locally                                                                 |
| P4 visible-set rule                               | Geometry acts capture clips and explicit hides, never natural occlusion                                               | Cross-domain real-data gates exercise identical visible-set arguments                                                         |
| P5 persistence off interaction                    | Gestures journal once at completion; heavy bytes are job artifacts                                                    | Every milestone carries the FP-D19 zero-mid-gesture-write and durability gates                                                |
| P6 universal affordances                          | Save, Undo, Escape, double-click, and context completion retain honest effects                                        | Mechanism migrations include affordance regression tests                                                                      |
| P7 office conventions are user data               | Codes, layers, units, layouts, and report defaults stay editable                                                      | BIM/import/Plan gates use more than one catalog and convention fixture                                                        |
| C1 tri-modal numeric parity                       | Coordinate-bearing continuous input uses pick, constrained pick, and typed paths                                      | Tab/Shift+Tab traverse fields; Up/Down cycle live candidates; all three paths share preview, validation, and commit           |
| P8 domain-scoped undo                             | Document, selection, display/visibility, and camera keep four histories                                               | Ctrl+Z remains document-only; each local history has an explicit path, restore scope, persistence, and corruption boundary    |
| P9 composed interaction state                     | One resolver composes requested node state, ancestors, layer/type/project overlays, capabilities, and global overlays | UI and automation expose the effective state and every cause; bulk changes preview and apply atomically                       |
| P10 derived-recipe lifecycle                      | One shared DAG/CAS recipe model owns linked, stale, regenerating, error, detached, and source-missing states          | Derived domains add typed payloads, never private lifecycle graphs; last-good truth and explicit regeneration survive restart |
| P11 generated command table                       | One command table drives UI operations, console vocabulary, automation host, and Python SDK                           | Builder and PhotoLab consume the same validate/status/cancel lifecycle; raw RPC allowlists are not an exposure mechanism      |

### 2.2 Hard ordering rules

1. The iteration-speed package I-01–I-07 runs first and in order.
2. X-P11 follows I-07; X-R1 follows X-P11 and accepted ADR 0030. Both are
   PhotoLab-serving cross-product closure under active Branch A.
3. Schema/authority admissions run before stateful consumers.
4. UI Platform gesture, selection, job, command, and base-component contracts
   run before domain-specific surfaces.
5. ViewState v2 and the shared Select/Edit gizmo run before geometry domains
   rely on visibility, placement previews, or captured views.
6. P8 histories, the P9 effective-state resolver, support/segment selection,
   the shared 3D target, and the semantic cursor vocabulary land as shared
   substrate before Draw or Civil consumes them.
7. File/Project durability and reachability run before large imports, derived
   artifacts, Plan roots, Agent transcripts, or exact heavy undo.
8. Domain work follows the dependency graph in §4; cycles are broken at an
   explicit producer/consumer interface and closed by an integration gate.
9. Automation exposure follows canonical UI/core behavior, but the schema,
   generator, host, Python SDK, and capability negotiation merge together.
10. Plan and Agent are late integrators, not places to invent missing domain
    behavior.
11. Release is an outcome across the largest and least members, not a cleanup
    phase.

## 3. Iteration-speed package — mandatory first tranche

Measure on the same machine, power mode, dependency state, and worktree. Record
raw samples plus median and p95 in `.build/verify/iteration-baseline.json` (or
its implemented successor). A task is not done with an anecdotal speedup.
I-01 is **in progress as of 2026-09-02**; I-02–I-07 remain ordered behind it.

| Queue | Task                                                            | Before measurement                                                                                                                                                                         | Required change                                                                                                                                                                          | After/pass measurement                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-01  | Repair verifier Cargo discovery                                 | Run a representative Rust/schema `pnpm verify:changed` ten times from the agent environment; record bare-`cargo` ENOENT/failure rate and time to failure                                   | Make the planner use one cross-platform Cargo resolver (`CARGO`, known toolchain locations, then PATH), shared with `scripts/run-cargo.mjs`; add planner/runner tests                    | 10/10 plans launch the intended pinned Cargo; zero bare-spawn PATH failures; task id/args and nonzero exit propagation remain exact; compare time-to-useful-result                                                    |
| I-02  | Remove unconditional release WASM work from development         | Five cold and five unchanged warm starts of `pnpm dev:photolab` and `pnpm dev:builder`; record time to Vite ready, Cargo invocations, wasm-bindgen/wasm-opt invocations, and rebuilt bytes | Split development staging from release artifact staging; key dev artifacts on source/toolchain inputs; keep release optimization in build/package/release gates                          | An unchanged second dev start invokes zero release Cargo/wasm-bindgen/wasm-opt work; changed WASM rebuilds only affected artifacts; release artifact/hash gate remains byte-valid; report median/p95 start delta      |
| I-03  | Eliminate redundant TypeScript programs with project references | Trace `pnpm typecheck`, affected `verify:changed`, and app dev Electron compile; record each source-file check count, process count, CPU time, wall time, and cache reuse                  | Add coherent composite/project references and incremental build info; remove overlapping `tsc --noEmit` programs while preserving renderer/electron/test boundaries                      | No source is checked by two programs for the same purpose; an unchanged repeat reuses build info; clean and incremental diagnostics equal the baseline; report median/p95 wall and CPU deltas                         |
| I-04  | Make the verifier a bounded parallel DAG runner                 | Replay representative docs, TS, Rust, viewer, and release plans serially; capture ordered task set, result, wall time, peak CPU/RAM, and first-failure behavior                            | Execute independent tasks concurrently with a configurable cap; serialize tasks sharing output dirs, package staging, external targets, or mutable fixtures; cancel safely after failure | Planned task set and pass/fail result are identical; conflicting tasks never overlap; 10 repeated runs have no flakes/orphans; report critical path, wall-time delta, peak resources, and first-failure latency       |
| I-05  | Add optional mold and sccache acceleration                      | Measure five clean and ten one-file incremental Rust debug/test builds with current linker/cache; capture compile, link, cache, binary, and test results                                   | Detect/configure `mold` and `sccache` without making them runtime dependencies; retain deterministic fallback and CI/release compatibility; follow dependency policy                     | Warm builds report cache hit statistics and link timings; fallback without either tool passes; test binaries/results match; release inventory and platform linkers are unchanged; report clean/incremental median/p95 |
| I-06  | Tune the Rust development profile                               | Measure clean and one-file rebuilds plus representative core, sidecar, viewer, import, and PhotoLab runtime smoke under current dev profile                                                | Tune codegen/debug/incremental settings for edit-test work; keep release profile and correctness-sensitive test behavior explicit                                                        | Clean/incremental build delta is recorded; all representative tests and debug assertions pass; interaction/compute calibration is never claimed from a weakened dev build; release output/profile diff is empty       |
| I-07  | Add a deterministic registry linter                             | Capture the current registry counts and a fixture set containing one duplicate act, contradictory guarantee, dangling decision id, unowned capability, and status mismatch                 | Implement a deterministic, agent-runnable linter over registry/spec metadata; replace recurring LLM registry rebuilds without weakening the later implementation-finding re-walk         | Clean registry returns the pinned counts; each invalid fixture fails for exactly its expected reason; output is stable across ten runs and is wired into affected verification                                        |

Package acceptance gates:

| Gate                  | Agent-runnable meaning                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `G-INFRA-CARGO`       | Planner self-test plus a real changed Rust task proves one Cargo resolver and exact failures  |
| `G-INFRA-WASM-DEV`    | Cold/warm Builder and PhotoLab starts prove keyed dev staging and release-artifact separation |
| `G-INFRA-TSC`         | Clean/incremental graph trace proves no redundant checking and identical diagnostics          |
| `G-INFRA-RUNNER`      | Serial-versus-parallel plan replay proves task/result equivalence and conflict serialization  |
| `G-INFRA-RUST-CACHE`  | With/without-tool matrix proves mold/sccache acceleration is optional and correct             |
| `G-INFRA-DEV-PROFILE` | Profile diff plus representative test/release matrix proves only dev iteration changed        |

I-07's deterministic fixture suite is its acceptance evidence; it does not
invent a specification gate id. The registry re-walk still runs when an
implementation finding changes a contract.

No optimization lands if its own measurement harness is not committed. The
baseline may reveal no improvement; correctness-preserving no-gain experiments
are reverted or documented, not rationalized as completed speed work.

## 4. Dependency graph

### 4.1 Platform and state spine

The graph is read left to right. An arrow means the consumer must adopt the
provider record and pass the named boundary gate before its milestone closes.

```text
iteration package
  -> P11 generated command table
  -> PhotoLab product-dataset registration bridge (R1 gate 8)
  -> UI Platform (base controls, gesture map, selection, command surfaces, jobs)
  -> File/Project P5 durability + data-model/format ADRs
  -> ViewState v2 + Viewing Box
  -> Select/Edit shared gizmo and editability
  -> P8 four histories + P9 effective-state resolver
  -> support/segment selection + shared 3D target/cursor vocabulary
  -> Draw and Import foundation
  -> Pointcloud -> Raster <-> Mesh/Terrain -> Measure/Inspect
  -> Draw + Pointcloud + Mesh/Terrain + View + Select/Edit -> Civil
  -> Civil -> Mesh/Terrain bake
  -> Civil -> BIM/Import/Plan
  -> BIM/Specifications <-> coded Import integration
  -> Plan Editor
  -> Agent/SDK whole-workflow parity
  -> cross-product/package release
```

### 4.2 Decision-record consumption edges

| Provider record(s)                  | Direct consumers                                                                                             | Why it orders work                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UIP-D1/D2/D3/D5/D14                 | VB-D5/D6, DR-D1/D14, PC-D2, RA-D10, MI-D5/D6, SE-D1/D16, PE-D1, AG-D11                                       | One gesture/selection/Escape arbitration must exist before any armed tool                                                                                           |
| UIP-D6/D12/D13/D17/D18              | Every contextual domain; especially SE-D2/D15, FP panels, BS editor, IF registration                         | Shared components and registry prevent surface-specific behavior forks                                                                                              |
| UIP-D10/D11                         | FP-D20, IF-D1/D7/D15, MT-D10/D17, RA-D13, PE-D14/D19, AG-D7                                                  | Long work needs one main-process lifecycle before domains launch jobs                                                                                               |
| UIP-D19–D24, SE-D19, VD-D14, FP-D21 | Draw, View, Viewing Box, Pointcloud, Raster, Mesh, Civil, Plan, Agent                                        | P8 histories, P9 effective-state causes, support/segment modes, 3D target, and cursor vocabulary are shared substrate rather than domain-local state                |
| FP-D2/D4/D11/D16/D19                | VD-D4, MI-D11, IF-D15, MT-D2/D17, PE-D2/D3/D7, AG-D6/D14/D19                                                 | Durability, restore, undo, and reachability precede every persistent product root                                                                                   |
| VD-D3/D8/D13                        | PC-D11/D12, RA-D1, MT-D6, SE-D10, PE-D4/D6, MI-D11                                                           | ViewState v2 is the canonical visibility/presentation/bookmark boundary                                                                                             |
| VB-D3/D7/D8/D13                     | SE-D3, IF-D4, DR-D15, PC-D16, MT-D15, RA-D12, MI-D5, AG-D12                                                  | Placement revisions, P4 scope, and presented-frame cadence are shared facts                                                                                         |
| SE-D1/D3/D9/D14/D15                 | FP-D15, RA-D4, MI-D3/D6, MT-D4/D7/D19, BS-D20, PE-D5                                                         | Placement preview, locks, capabilities, and delete plans affect passive consumers                                                                                   |
| DR-D1/D2/D4/D9/D12/D13/D16          | SE-D1, MI-D2/D5/D7, MT-D5/D12, PE-D17, BS-D19/D20                                                            | Numeric entry, snap truth, layers, dimensions, and current specification are Draw-owned                                                                             |
| PC-D1/D2/D7/D9/D10/D11/D16          | SE-D5/D6, RA-D8, MT-D9/D14, MI-D9, PE-D7                                                                     | Fence overlay, masks, extraction, ortho arrival, analysis ownership, and point style precede consumers                                                              |
| RA-D4/D5/D7/D13                     | SE-D3, MT-D6/D22, PE-D7, IF-D6                                                                               | Drape revision, grid display, Grid-to-Tin, and staged-image recovery cross domains                                                                                  |
| MT-D4/D6/D12/D17/D20                | DR-D13, RA-D5/D7, MI surface consumers, PE-D7, FP-D5/D6                                                      | Terrain becomes the snap/display/quantity producer only after bounded recoverable creation                                                                          |
| MT-D25/D31/D32                      | DR-D20, CIV-D15, RA-D15, BS-D24, SE-D20, IF-D18, FP-D22, AG-D22, PE-D21, MI-D14                              | One P10 recipe DAG and atomic last-good/restore model precedes every linked derived output and passive consumer                                                     |
| MI-D2/D3/D6/D8/D11                  | SE-D14, DR-D9, IF-D10, FP-D4/D5, PE-D17                                                                      | Measurement schema, anchors, non-transformability, report, and restore have multiple consumers                                                                      |
| CIV-D1–D24                          | View, Mesh/Terrain, Pointcloud, Select/Edit, BIM, Raster, File/Project, Import, Plan, Measure/Inspect, Agent | Civil owns alignment/profile/corridor/slope/station semantics; consumers retain rigid-section, sampling, publication, persistence, export, and automation ownership |
| BS-D12/D14/D18–D22                  | PE-D6/D10, DR-D16, IF-D5/D8, UIP-D8/D14                                                                      | Presentation, schedules, catalog grammar, current spec, generation, and sewer semantics meet here                                                                   |
| IF-D4/D5/D8/D12/D15                 | FP-D13/D16, PC/RA/MT/MI/BS consumers, AG-D4/D5                                                               | Import identity, descriptor UI, coded generation, public I/O, and heavy undo must be stable before automation                                                       |
| PE-D2/D4–D7/D10/D13/D18/D19         | FP restore/reachability, View bookmarks, BIM schedules, Draw dimensions, Agent export                        | Plan is a late compositor of exact earlier-domain revisions and artifacts                                                                                           |
| AG-D3/D4/D5/D13/D14/D17/D20/D21     | Automation schema, all owning commands, PhotoLab/WeltView/store                                              | Agent is the final parity/trust/sibling integration, not an alternate command layer                                                                                 |
| P11, UIP-D6, AG-D13                 | PhotoLab WP-G2, IF-D20, FP-D5, Builder console/SDK, WeltView read-only queries                               | One generated command table must exist before PhotoLab operations or product-dataset registration are exposed                                                       |
| IF-D19–IF-D25, ADR 0030             | PhotoLab WP-G1, Builder registration, WeltView, File/Project, Agent                                          | Canonical package/provenance admission and bounded listing precede R1 gate 8 registration and cross-product reopen                                                  |

### 4.3 Cycle breaks

| Cycle                                     | First seam                                                                                                               | Second implementation                                                                                                       | Closing gate                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Raster display ↔ Mesh Grid/Tin            | Land RA-D5 display value and RA-D7 typed arrival interface without Tin fabrication                                       | Implement MT-D6/MT-D22 consumer and Grid compilation/section path                                                           | `G-RA-DISPLAY` + G-MT-2/G-MT-4 + real Grid→Tin round trip       |
| Draw terrain snapping ↔ Mesh producer     | Land DR-D13 producer interface and exact snap oracle                                                                     | Register MT-D12 Rust BVH producer; never revive TS stubs                                                                    | Shared Draw/MT browser gate plus real breakline-to-terrain flow |
| BIM coded objects ↔ Import descriptors    | Land BS-D18–D21 catalog/resolve/generation command contracts                                                             | Implement IF-D5/IF-D8 column mapping and call the BIM planner inside one transaction                                        | coded CSV real-data flow + BIM automation + import undo         |
| Plan filters/schedules ↔ View/BIM         | Keep View bookmark ownership and BIM schedule definition fixed                                                           | Implement PE-D6/PE-D10 as consumers/placement owner                                                                         | `G-PE-REAL-EXPORT` with two filters and a live schedule         |
| Agent public import ↔ Import registration | Land IF-D12 bounded public outcome and user-only confirmation                                                            | Generate AG-D4/D5 schema/host/SDK surface together                                                                          | `G-AG-IO`, `G-AG-E2E`, `automation.sdk`                         |
| Civil corridor ↔ Mesh surface             | Civil publishes a revision-bound corridor/pit manifest and owns its recipe; Mesh exposes the typed draft/check interface | Mesh alone validates and publishes the baked `Surface3d`; the materialized Mesh output references the upstream Civil recipe | `G-CIV-3`, `G-CIV-4`, `G-B2-MESH-RECOVERY`, `G-B2-E2E`          |
| Civil profiles ↔ Pointcloud sampling      | Pointcloud PC-D17/PC-D18 publishes immutable, provenance-bound mean-grid/station-corridor sampling products              | Civil consumes only bounded exact revisions for profiles/fit and owns station/profile semantics                             | `G-B2-PC-MEAN-SAMPLE`, `G-CIV-SCALE-FIT`, `G-CIV-SCALE-PROFILE` |
| View rigid section ↔ Draw line            | Draw owns the source line and tri-modal input; View VD-D15 owns direction/depth/local-frame section state                | Draw edits emit one revision invalidation; View updates live only while the rigid mapping remains unambiguous               | `G-B2-GESTURE-C1`, `G-B2-SECTION`                               |

## 5. Ordered autonomous queue

The queue is dependency order, not an estimate. D9 makes Release 0.5 the active
cut. I-01–I-07 run first and in order. Only the minimum reusable substrate may
precede the first domain slice; substrate rows must not absorb deferred domain
behavior. X-R1 and PhotoLab R1 continue in their separately owned lane because
the commercial bundle requires executed R1 gates, but they do not block an
otherwise-ready Builder domain slice unless a shared contract is consumed.

| Order | Work package                                                                | Prerequisites                                                                                | Named exit evidence                                                                                                                                                                                         |
| ----: | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | I-01 Cargo resolver — **in progress 2026-09-02**                            | none                                                                                         | `G-INFRA-CARGO` and before/after record                                                                                                                                                                     |
|     2 | I-02 keyed dev WASM staging                                                 | I-01                                                                                         | `G-INFRA-WASM-DEV`; Builder + PhotoLab warm start                                                                                                                                                           |
|     3 | I-03 TypeScript project references                                          | I-02                                                                                         | `G-INFRA-TSC`; clean/incremental diagnostics parity                                                                                                                                                         |
|     4 | I-04 bounded parallel verifier                                              | I-03                                                                                         | `G-INFRA-RUNNER`; repeated no-flake equivalence                                                                                                                                                             |
|     5 | I-05 optional mold/sccache                                                  | I-04                                                                                         | `G-INFRA-RUST-CACHE`; deterministic fallback                                                                                                                                                                |
|     6 | I-06 Rust dev profile                                                       | I-05                                                                                         | `G-INFRA-DEV-PROFILE`; release profile untouched                                                                                                                                                            |
|     7 | I-07 deterministic registry linter                                          | I-06                                                                                         | deterministic duplicate-act, contradictory-guarantee, dangling-id, ownership, and status checks over pinned fixtures; no LLM registry rebuild                                                               |
|     8 | X-P11 one generated command table **(minimum substrate)**                   | I-07                                                                                         | PhotoLab WP-G2 plus Builder/PhotoLab table-to-console/host/Python staleness and validate/status/cancel gates                                                                                                |
|     9 | S-01 admissions and migrations **(minimum substrate)**                      | I-07; Branch A                                                                               | only the accepted Registry §4.4 admissions required by the 0.5 path; schema/migration gates                                                                                                                 |
|    10 | S-02 shared theme/base controls **(minimum substrate)**                     | S-01                                                                                         | UIP-D12 components, accessibility captures, and SE-D18 axis tokens                                                                                                                                          |
|    11 | S-03 gesture/Escape arbiter **(minimum substrate)**                         | S-02                                                                                         | registered 0.5 mouse/touch/keyboard rows; browser collision gate and `G-B2-GESTURE-C1`                                                                                                                      |
|    12 | S-04 selection + S-05 jobs + S-06 command surfaces **(minimum substrate)**  | S-02/S-03                                                                                    | UIP-D2/D3/D6/D10/D11/D13/D15–D18; selection extremes and command/context/console/SDK parity; real job progress/cancel/restart                                                                               |
|    13 | S-07 journal + S-08 ViewState/HUD **(minimum substrate)**                   | S-01/S-03/S-05                                                                               | FP-D19 group commit; VD-D3/D8/D13 migration and presented-frame HUD; `G-B2-HISTORY` for the histories used by 0.5                                                                                           |
|    14 | S-B2-P9/G5-G11 + S-10 0.5 interaction subset **(minimum substrate)**        | S-03/S-04/S-08; required support-role, segment-locator, and point-acquisition admissions     | `G-B2-P9-TREE`, `G-B2-SELECTION-VISUAL`, `G-B2-SEGMENTS`, `G-B2-INPUT`; only editability, cursor/target, support-geometry, and input behavior consumed by the 0.5 tools                                     |
|    15 | P-01 save/recovery + D-02 scan import/view subset **(minimum substrate)**   | S-05/S-07/S-08/S-10                                                                          | working open/save/flush/restart path; `G-IF-1`, `G-IF-2`, `G-IF-3`, `G-IF-6`; real scan imports reach a fluid view and truthful presented-frame HUD without unbounded staging                               |
|    16 | **0.5-01 Viewing box lock/bake** (S-09)                                     | S-08; S-10 interaction subset; imported real scan                                            | VB-D7 presented-frame cadence and VB-D8 mixed-scene lock parity, including placement-revision bake                                                                                                          |
|    17 | **0.5-02 Ground extraction (Pointcloud)** (ground-only D-RW-03/D-03 subset) | 0.5-01; D-02; S-04/S-05; admitted Pointcloud→Mesh hand-off                                   | outdoor-ground assertions within `G-RW-EXTRACT-GROUND-FLOOR`, P4, typed UI/automation parity, deterministic class/extract results, and ground-cloud→DGM hand-off; the full ground+floor gate is not claimed |
|    18 | **0.5-03 Sampling/rasterize** (PC-D8/PC-D17, MT-D26)                        | 0.5-02; S-05; prepared ground-cloud data                                                     | `G-B2-PC-MEAN-SAMPLE`: mean-height grid, deterministic ties, bounded streaming, provenance, source immutability, and real-data oracle                                                                       |
|    19 | **0.5-04 Draw line/polyline with snapping + input bar** (D-01 subset)       | 0.5-03; S-03/S-08/S-10; S-B2-G5-G6/G7-G11; P-01                                              | `G-DR-INPUT`, `G-B2-INPUT`, and `G-B2-GESTURE-C1`; real scanned-street breakline and closed-boundary flow with click/constrain/type equivalence                                                             |
|    20 | **0.5-05 DGM creation window** (D-05 creation/check subset)                 | 0.5-03/0.5-04; S-05/S-07; recipe/source-role admissions                                      | `G-B2-MESH-DRAFT-RULES`, `G-MT-1`, `G-MT-3`, `G-MT-5`, and `G-B2-MESH-RECOVERY`; error list/fixes, constrained breaklines/boundary, one atomic publish, cancel/restart, real DGM flow                       |
|    21 | **0.5-06 DGM editing: region smoothing, then downsampling** (D-RW-05/06)    | 0.5-05; D-01 subset; S-05; derived-recipe, mesh-role, simplification/error-policy admissions | `G-RW-DGM-SMOOTH` then `G-RW-DGM-DOWNSAMPLE`; outside-region identity, protected breaklines/boundaries, certified error, deterministic bake, undo/cancel/restart                                            |
|    22 | **0.5-07 DXF/LandXML export UI wiring** (P-01/FP-D5/D6 subset)              | 0.5-05; 0.5-06 for edited-product coverage; X-P11                                            | existing `io.export.plan/execute`; File export component/browser plan-loss parity; Mesh §6 changed DXF round-trip and `G-MT-5` Brandenburg LandXML import→edit→export→re-import equality                    |
|    23 | **0.5-08 Measurement basics** (D-06 subset)                                 | 0.5-01; D-01/D-03/D-05 subsets; measurement admission                                        | single point, 2D/3D distance, and Δz through `G-MI-UNIT-MATH`, `G-MI-UNIT-ANCHOR`, `G-MI-COMMAND`, `G-MI-GESTURE`, `G-MI-VISIBLE-PRECISION`, and `G-MI-CONTINUOUS`                                          |

The following packages are **deferred for Release 0.5** and may not jump the
ordered slices above. They remain registered 1.0-path work rather than deleted
scope:

| Deferred package(s)                       | 0.5 boundary                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D-03 remainder                            | classification beyond ground, generic segmentation/classification breadth, floor extraction, and non-ground extraction are deferred        |
| D-RW-01, D-RW-02                          | registration UI and station view are excluded                                                                                              |
| D-04, D-RW-04                             | Raster-domain breadth and high-performance orthophoto import are deferred; only the mean-height product needed by the DGM path is included |
| D-05 remainder, D-RW-07                   | volumes, contours beyond acceptance needs, general 3D mesh repair, broad display modes, and the measured RealWorks comparison are deferred |
| D-06 remainder                            | area/facade, reports, point-info breadth, and measurement kinds beyond point, 2D/3D distance, and Δz are deferred                          |
| D-CIV                                     | all Civil alignment/profile/corridor/slope/pit work is excluded                                                                            |
| D-07                                      | specifications and BIM are excluded                                                                                                        |
| D-08                                      | coded import/update integration and its BIM/Civil consumers are deferred                                                                   |
| D-09                                      | Plan Editor is excluded                                                                                                                    |
| D-10                                      | broad Agent workflow waits for stable 1.0 schemas; canonical command parity required by included 0.5 slices is not deferred                |
| R-01 and Gaussian-splat display           | public Builder release, installer/updater, full release-candidate closure, and splat display wait for 1.0                                  |
| Cataloged-deferred functions in the specs | stay cataloged; promotion still requires owning-spec workflow depth, gates, and a registry re-walk                                         |

DR-D8 is no longer a Civil deferral. D7 and the round-3 Registry transfer
alignment, profile, corridor, slope/pit, station, and Civil-standard semantics
to D-CIV/CIV-D1–D24 while Draw retains primitive point/curve construction,
snaps, support geometry, and the single shared `draw.alignment` access row.
X-P11 and X-R1 coordinate respectively with PhotoLab WP-G2 and WP-G1 in
`docs/implementation-plans/2026-09-photolab-release-polish.md`; they do not
create a Builder-private command table or product-dataset bridge.

## 6. Milestones — user outcomes, integration gates, and demos

### M0 — A change reaches trustworthy feedback quickly

| Field              | Contract                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome            | A developer or autonomous agent changes Rust, TypeScript, WASM, or verification code and receives the right focused result without PATH failures or avoidable release rebuilds |
| Included work      | I-01–I-07; verification planner/runner; deterministic registry linter; Builder and PhotoLab dev starts                                                                         |
| Integration gates  | `G-INFRA-CARGO`, `G-INFRA-WASM-DEV`, `G-INFRA-TSC`, `G-INFRA-RUNNER`, `G-INFRA-RUST-CACHE`, `G-INFRA-DEV-PROFILE`                                                              |
| Performance gate   | Committed cold/warm and serial/parallel before/after samples; no speed claim without median/p95 and correctness equivalence                                                    |
| Owner-visible demo | Change one PhotoLab TS file, one shared Rust file, and one viewer-WASM file; show only the affected work reruns and an unchanged restart performs no release WASM build        |

### M-0.5 — DGM aus Scan

This is the accepted D9 commercial-alpha outcome. It is **usable at starter
level** only when the owner and 2–3 pilot offices can use visible UI to complete
the same real-scan workflow without implementation assistance. There is no
installer/updater gate for 0.5.

| Order | User outcome                            | Required predecessor(s)                                                  | Acceptance gates                                                                                                                                 |
| ----: | --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | Viewing box locks and bakes             | I-01–I-07; minimum substrate; imported scan                              | VB-D7 and VB-D8                                                                                                                                  |
|     2 | Ground is extracted from the pointcloud | viewing box; Pointcloud→Mesh hand-off                                    | outdoor-ground assertions within `G-RW-EXTRACT-GROUND-FLOOR`; the full ground+floor gate remains open because floor is deferred for 0.5          |
|     3 | Ground is sampled/rasterized            | extracted ground cloud; registered job substrate                         | `G-B2-PC-MEAN-SAMPLE`                                                                                                                            |
|     4 | Breaklines and boundary are drawn       | sampling; shared snap/target/input substrate                             | `G-DR-INPUT`, `G-B2-INPUT`, `G-B2-GESTURE-C1`                                                                                                    |
|     5 | DGM is checked, fixed, and created      | sampled ground; breaklines/boundary; Mesh admissions                     | `G-B2-MESH-DRAFT-RULES`, `G-MT-1`, `G-MT-3`, `G-MT-5`, `G-B2-MESH-RECOVERY`                                                                      |
|     6 | DGM is smoothed and downsampled         | committed DGM; derived-recipe and simplification/error-policy admissions | `G-RW-DGM-SMOOTH`, then `G-RW-DGM-DOWNSAMPLE`                                                                                                    |
|     7 | DGM is exported to DXF/LandXML          | created/edited DGM; X-P11; File export UI                                | `io.export.plan/execute` plan/loss parity; Mesh §6 changed DXF round-trip and `G-MT-5` Brandenburg LandXML import→edit→export→re-import equality |
|     8 | Basic measurements are made             | exact point/curve/surface candidates; measurement admission              | `G-MI-UNIT-MATH`, `G-MI-UNIT-ANCHOR`, `G-MI-COMMAND`, `G-MI-GESTURE`, `G-MI-VISIBLE-PRECISION`, `G-MI-CONTINUOUS`                                |

The acceptance run uses checksum-pinned, license-recorded real scan datasets
representative of the owner and pilot offices. It must prove import, fluid view
and truthful HUD, save/restart recovery, the ordered workflow above, exact
export review/round-trip, cancellation of long work within the owning budgets,
and no silent source mutation or invented domain truth. Every included slice's
interaction, correctness, persistence, recovery, automation-parity, and
real-data obligations must pass, and the demanding-user implementation review
must have no open blocker. A partial UI path or an unexecuted gate is not
starter-level acceptance.

### M-RW — Trimble RealWorks starter (owner outcome)

This is an **OWNER OUTCOME**, not a feature-count substitute for the package
gates or an assertion that any listed capability already exists. The outcome
definition is copied verbatim from S16:

> The complete Builder shell stands, and of the functions the point-cloud
> set is implemented: segmentation, classification, terrain (ground)
> extraction, floor extraction, clipping box, views, cloud-to-cloud
> registration, the station view (the owner's approach: compute a panorama
> depth image from the E57 panorama image or from the station's own cloud),
> spatial sampling, rasterize (mean height per grid cell as described in
> S10). All measurement tools (single point, 2D distance, 3D distance,
> Δz, …). Orthophoto import that performs very well. Viewer performance
> improved again so that it beats TRW. At least line and point creation
> tools work, with line editing (split, trim, parallel, …). Surfaces and
> DGMs can be created and edited well (S15). Volume generation works and
> volumes can be computed. At least the start of specification management
> stands. PhotoLab production-ready in parallel, by a separate session that
> must adopt this program's workflow.

M-RW reuses the existing package spine. Only gaps that had no package receive
new `D-RW-*` rows in §5; none creates a parallel core, renderer, importer,
command surface, job system, or UI package.

| M-RW outcome member                                 | Package(s) on the existing queue                    | Prerequisites                                                    | Owning specification and gate                                                                                    |
| --------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Complete Builder shell                              | S-02–S-10, S-B2 substrate, P-01                     | I-01–I-07; S-01 admissions; X-P11 where commands are exposed     | UI Platform, File/Project, View, Select/Edit; M1/M2 gates                                                        |
| Segmentation and classification                     | D-03                                                | S-03–S-05; S-09; D-01/D-02                                       | Pointcloud PC-D1–D6; `G-PC-A`–`G-PC-E`                                                                           |
| Terrain/ground and floor extraction                 | **D-RW-03**                                         | D-03/S-04/S-05/S-09; admitted Pointcloud→Mesh hand-off           | `specs/pointcloud/pointcloud.md` batch-3 amendment; `G-RW-EXTRACT-GROUND-FLOOR` on real data                     |
| Clipping box and views                              | S-08/S-09                                           | S-01/S-03/S-07                                                   | View Domain and Viewing Box; VD gates plus VB-D7/VB-D8                                                           |
| Cloud-to-cloud registration UI                      | **D-RW-01**                                         | D-02/D-03/S-05/S-08/S-09; registration/station admissions        | `specs/registration-stations/registration-stations.md` (**pending; being written**); `G-RW-REGISTRATION`         |
| Station view with panorama depth image              | **D-RW-02**                                         | D-RW-01/S-08/S-09; station/panorama/depth admissions             | `specs/registration-stations/registration-stations.md` (**pending; being written**); `G-RW-STATION-DEPTH`        |
| Spatial sampling and mean-height rasterize          | D-03                                                | D-02/S-05; point-cloud prepared data                             | Pointcloud PC-D8/PC-D17 and Mesh MT-D26; `G-B2-PC-MEAN-SAMPLE`                                                   |
| All measurement tools                               | D-06                                                | D-01/D-03/D-05/S-01 measurement admission                        | Measure/Inspect MI-D1–MI-D14; every `G-MI-*` gate                                                                |
| Orthophoto import performs very well                | **D-RW-04**                                         | D-02/D-04/S-05/S-08; real tiled/untiled fixtures                 | Import/Formats owns import; Raster owns arrival/display; `G-RW-ORTHO-IMPORT`                                     |
| Viewer beats TRW—a measured claim only              | **D-RW-07**                                         | Completed M-RW viewing workloads, HUD, fixed comparison fixtures | View Domain owns presented-frame instrumentation; workload specs own fidelity; `G-RW-VIEWER-COMPARE` below       |
| Point/line creation and split/trim/parallel editing | S-10/D-01 plus S-B2-G5-G6/G7-G11                    | Shared input, gizmo, segment locator, recipe admissions          | Draw and Select/Edit; `G-DR-INPUT`, `G-DR-DERIVED`, `G-B2-INPUT`, `G-B2-SEGMENTS`                                |
| Surface/DGM creation and editing                    | D-05                                                | D-01/D-03/D-04; recipe/source-role admissions                    | Mesh/Terrain; G-MT-1–G-MT-5 and batch-2 Mesh gates                                                               |
| Region-scoped DGM smoothing (S15/G13)               | **D-RW-05**                                         | D-05/D-01/S-05; recipe/source-role admissions                    | `specs/mesh-terrain/mesh-terrain.md` batch-3 amendment; `G-RW-DGM-SMOOTH`                                        |
| Intelligent triangle downsampling                   | **D-RW-06**                                         | D-05/D-RW-05/S-05; admitted error/recipe policy                  | `specs/mesh-terrain/mesh-terrain.md` batch-3 amendment; `G-RW-DGM-DOWNSAMPLE`                                    |
| Volume generation and computation                   | D-05                                                | Completed surface inputs and quantity/export seams               | Mesh/Terrain volume/solid records; G-MT gates plus `G-B2-SOLID`                                                  |
| Start of specification management                   | D-07                                                | D-01/D-06/D-CIV/S-02                                             | BIM/Specifications catalog/current-spec/apply slice and its core/editor/apply gates                              |
| PhotoLab production-ready in parallel               | PhotoLab release plan; not duplicated in this queue | Separate PhotoLab-owned lane plus shared X-P11/X-R1 seams        | `docs/implementation-plans/2026-09-photolab-release-polish.md`; its R1 gates, with `COORDINATION.md` §7 priority |

`G-RW-VIEWER-COMPARE` is the named **RW-VIEW-1 comparison protocol**. On the
same workstation, display refresh, viewport dimensions, power mode, and driver,
Builder and the pinned Trimble RealWorks version load the same source datasets
with documented equivalent visible content, point budget, projection, clipping,
and warm-cache posture. A repeatable camera/input trace covers orbit, pan, zoom,
clipping-box manipulation, segmentation preview, classification recolor, and
station view. At least five runs per product report p50/p95/max intervals between
presented frames, input-to-present p95, dropped input, time to first useful
frame, memory, fixture hash, and quality deviations. “Viewer beats TRW” may be
published only when Builder's median-of-runs presented-frame-interval p95 is
strictly lower in every claimed scenario, input-to-present is no worse, neither
product drops scripted input, and the demanding-user review accepts content
equivalence. Otherwise the evidence reports the measured result without the
claim.

#### Release 0.5 execution horizon

The planning estimate is 1.5–2 weekly Codex budgets and 2–3 weeks with the
temporary three-lane discipline. This is not a public date or acceptance by
calendar. I-01–I-07 and the minimum substrate precede the eight ordered M-0.5
domain slices. PhotoLab R1 executes in its coordinated lane; a failing shared
PhotoLab gate retains priority. Estimates are revised from executed gate
evidence and never shortened by counting partial UI as a complete slice.

### M1 — The workspace responds as one coherent application

| Field                  | Contract                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome                | A user can point, select, open contextual actions, drag panels, cancel work, and press Escape without gesture collisions, lost state, or app-specific chrome |
| Included specs/records | UI Platform UIP-D1–D18; FP-D19/D20 substrate; SE-D18 theme tokens                                                                                            |
| Integration gates      | UI component suite; gesture browser suite; `G-UIP-1`, `G-UIP-2`; three-real-import job/reload gate; automation selection/jobs/layout parity                  |
| Performance gate       | Presented-frame-interval p95 ≤ 2× target during hover, island drag, and splitter drag; click→highlight ≤150 ms p95                                           |
| P5 gate                | No continuous panel/selection gesture writes canonical state mid-drag; main-owned jobs rehydrate after renderer reload                                       |
| Owner-visible demo     | Start three imports, cancel one, detach/redock a function, select through context menu/tree/viewport, reload the renderer, and continue the surviving jobs   |

### M2 — A project reopens exactly where deliberate work left it

| Field                  | Contract                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome                | A user can create/open, edit, flush, snapshot, restore, undo, archive, attach, relocate, and recover a project without silent loss or invented coordinates                       |
| Included specs/records | File/Project FP-D1–D20; View VD-D1–D13; Viewing Box VB-D1–D14; Select/Edit SE-D1–D18; accepted schema ADRs                                                                       |
| Integration gates      | File changed/push/real-data suites; VD browser/real-data gates; VB-D7/VB-D8; G-SE-CORE/UI/INPUT/P4/1/2/3/REAL/CLIPBOARD/SDK                                                      |
| Performance gate       | All viewport interactions use VB-D7 presented-frame intervals; View section/preset cadence ≤2×; SE input-to-present ≤50 ms p95 and fence result ≤150 ms p95                      |
| P5 gate                | Zero journal writes during a drag, exactly one at completion; gesture-end→durability ack ≤100 ms p95; ack→indicator ≤50 ms p95                                                   |
| Owner-visible demo     | Move a clipped cloud with a locked box, save a snapshot, attach a second project with explicit CRS posture, hide/isolate, restart, restore, and undo each deliberate action once |

### M3 — Field observations become editable construction geometry

| Field                  | Contract                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome                | A user imports real points/linework, resolves placement visibly, drafts against exact candidates, edits a point cloud, and retains source truth and undo                                                     |
| Included specs/records | Draw DR-D1–D16; Import IF-D1–D3/D5–D8/D11/D13/D14; Pointcloud PC-D1–D16; File/Select/View consumers                                                                                                          |
| Integration gates      | Draw changed/browser/real street gates; G-IF-1/2/3/4/ASCII; G-PC-A–E; P4 clipped-scene and SDK parity                                                                                                        |
| Performance gate       | Draw 200-vertex scene interval p95 ≤2× and snap query ≤4 ms p95; PC fence interval ≤2×, apply/restyle <1 s, edited/extracted parity ≤1.1× native                                                             |
| P5 gate                | Each import is a registered job; each fence apply/draft completion is one transaction; cancel publishes no partial entity or dataset                                                                         |
| Owner-visible demo     | Drop mixed survey files, map a German decimal-comma CSV, review its transform, draft a breakline over the cloud, classify/extract inside a clipped fence, restart, and undo without duplicating source bytes |

### M4 — Survey reality yields auditable terrain, raster, and quantities

| Field                  | Contract                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome                | A user georeferences and drapes imagery, creates and repairs terrain without invented Z, snaps and measures exact geometry, and exports reproducible quantities                                                                                                                       |
| Included specs/records | Raster RA-D1–D15; Mesh/Terrain MT-D1–D32; Measure/Inspect MI-D1–D14; PC/Draw/File arrivals; batch-2 source roles, P10 recipes, hull/solid/strata, and signed-difference products                                                                                                      |
| Integration gates      | G-RA-UNIT/UI/BROWSER/1/2/REAL/SDK/DISPLAY; G-MT-1–5 and Brandenburg/LandXML gate; every G-MI-\* gate; `G-B2-PC-MEAN-SAMPLE`, `G-B2-MESH-DRAFT-RULES`, `G-B2-MESH-RECOVERY`, `G-B2-SOLID`, `G-B2-STRATA`, `G-B2-RASTER-DIFFERENCE`                                                     |
| Performance gate       | RA/MT/MI continuous interactions use presented-frame-interval p95 ≤2×; MT display switch ≤300 ms; MI snap ≤4 ms and click/select ≤150 ms                                                                                                                                              |
| P5 gate                | Mesh ≥60 s work checkpoints and resumes; 500M logical-point flow meets MT-D17 resource/cancel budgets; reports and heavy artifacts stay off interaction/journal payloads                                                                                                              |
| Owner-visible demo     | Georeference a scan, convert a Grid to editable Tin, create a DGM from cloud+breakline/form-line/rules without mutating sources, resolve crossings explicitly, create distinct Cut/Fill solids and a signed difference Grid, measure quantities, restart mid-job, and export evidence |

### M5 — A road or pit is designed from measured reality

| Field                  | Contract                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome                | A civil user turns measured edges, clouds, surfaces, polygons, and BIM faces into auditable horizontal/vertical alignments, profiles, corridors, slopes, and an excavation pit without losing source truth                                                       |
| Included specs/records | Civil CIV-D1–D24; D7/DR-D8 ownership transfer; Draw/Pointcloud/Mesh/View/Select inputs; Raster/BIM/File/Import/Plan/Measure/Agent consumers                                                                                                                      |
| Integration gates      | `G-CIV-CORE`, `G-CIV-FIT-UNIT`, `G-CIV-PIT-UNIT`, `G-CIV-CATALOG`, `G-CIV-ENGLISH`, `G-CIV-1`…`G-CIV-7`, `G-CIV-SCALE-FIT`, `G-CIV-SCALE-PROFILE`, `G-CIV-SCALE-PIT`; `G-B2-SECTION`; Civil↔Mesh and PC seams                                                    |
| Performance gate       | Fit/profile input p95 ≤100 ms and frame p95 ≤2× target; 10/100 km corridor and 500M logical-cloud profile gates meet CIV-D22 progress, cancel, memory, disk, checkpoint, restart, CAS, and completion bounds                                                     |
| P5 gate                | Fit/profile previews never journal per frame; every accepted act is one command; long corridor/pit/profile work checkpoints exact recipe generations and preserves one atomic last-good result                                                                   |
| Owner-visible demo     | Fit a true line/arc/clothoid road axis from two measured edges, edit its vertical profile and width bands, build a corridor, derive slopes and a pit from surveyed/BIM boundaries, restart during work, inspect station/offset, bake through Mesh, and undo once |

### M6 — Field codes become editable semantic construction objects

| Field                  | Contract                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome                | A user maintains an editable specification catalog, sets a current type, generates role-based BIM objects from point/line/area observations, and updates imported data without losing local edits                                 |
| Included specs/records | BIM BS-D1–D22, especially D18–D22; Draw DR-D4/D16; Import IF-D4/D5/D8/D12/D15–D17; UI shortcuts/generator surfaces                                                                                                                |
| Integration gates      | BIM core/component/browser/render/editor/apply/real-data/automation gates; G-IF-5/6/7/8; coded CSV and IFC stable-identity update                                                                                                 |
| Performance gate       | ≥10⁴ occurrence orbit interval p95 ≤2×; editor preview within one frame budget; 10⁴-entity apply/multi-edit <1 s; import remains responsive during old+new retention                                                              |
| P5 gate                | Generation/import is one reviewed transaction; 80 GB-class update refuses before write without old+new+sandbox capacity and retains exact undo roots                                                                              |
| Owner-visible demo     | Import two catalogs with different code grammars, pin/set a specification, turn surveyed point/line/area observations into a manhole/wall/room, complete missing truth, re-import a changed IFC, resolve conflicts, and undo once |

### M7 — A producer issues a scale-true, reproducible construction plan

| Field                  | Contract                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome                | A user composes sheets in a dedicated window, places exact model views and schedules, sees staleness, pins issued content, and exports deterministic PDF/SVG without omitted renderer classes                                                                      |
| Included specs/records | Plan PE-D1–D21; View bookmarks/ViewState; Draw dimensions; BIM schedules; File reachability/publication; Civil profiles/corridors; rigid sections; Raster difference, Mesh solid, and PC capture inputs                                                            |
| Integration gates      | G-PE-UNIT/STORE/CANVAS-UI/ELECTRON/CANVAS/CAPTURE-500M/PACKAGE/REAL-EXPORT/LICENSE; `G-B2-PLAN-CANVAS`; `automation.sdk`; physical scale check                                                                                                                     |
| Performance gate       | Plan interactions use presented-frame-interval p95 ≤2× even during capture; PE-D19 50 ms enqueue, 250 ms first progress/cancel ack, 2 s cancel terminal, calibrated 10/30 s warm capture and resource ceilings                                                     |
| P5 gate                | One completed canvas act is one journal command; capture/export use immutable job artifacts; project close follows Wait/Cancel and rejects late generation publication                                                                                             |
| Owner-visible demo     | Open the native Plan window on a second display, create A1/1:250 viewports with filters and a schedule, add a model dimension, edit the model to make one view stale, refresh/pin, export twice byte-identically, print-measure the scale, then restore a snapshot |

### M8 — Human and Agent can finish the same job safely on release builds

| Field                  | Contract                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome                | A user can ask the embedded Agent or use Python to perform the same canonical workflow with bounded context, one-step action undo, user-only approvals, durable sanitized history, and no sibling-app data loss                                                    |
| Included specs/records | Agent AG-D1–D22; P11; IF-D12/IF-D19–IF-D25; FP-D5/D11/D22; all registered domain commands; one generated command table; PhotoLab/WeltView preservation and product-dataset registration                                                                            |
| Integration gates      | changed host/security/store tests; `automation.sdk`; G-AG-DOC/UI/IO/E2E; `G-B2-E2E`; `G-IF-PD-1`…`G-IF-PD-6`; `G-R1-8`; Linux/Windows package, real-data, and cross-product archive gates                                                                          |
| Performance gate       | 100,000-row transcript presented-frame interval p95 ≤2× and input echo ≤50 ms p95; context/page ceilings fail closed; long I/O remains a UIP-D10 job                                                                                                               |
| P5 gate                | Transcript chunks publish object-before-head; one Agent action is one journal batch root; restart restores zero grants and never stores secrets/raw authority                                                                                                      |
| Owner-visible demo     | Register a PhotoLab product through canonical contracts, reopen it in Builder and WeltView, then ask Agent/Python to replay the measured-road-to-Plan workflow, undo the Agent action once, restart, and show unsupported methods and user-only grants fail closed |

## 7. Program-wide gates

### 7.1 Presented-frame performance rule

Every continuous gate uses the VB-D7 metric: intervals between presented
frames while scripted input continues. Render-body CPU/GPU duration alone is
not a substitute. The common report records target refresh interval, p50/p95/
max presented interval, input-to-present latency where specified, dropped
input, fixture identity, renderer/backend, hardware, power mode, and competing
jobs.

| Interaction family   | Required named gates                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Platform/navigation  | G-UIP-1/2; VD section/preset/HUD; VB-D7/VB-D8                                                                     |
| Editing              | Draw smoothness; G-PC-A/C/D/E; G-SE-1/2/3; G-RA-1/2; G-B2-INPUT/SELECTION-VISUAL/SEGMENTS                         |
| Analysis/composition | G-MT-1/2/4/5; G-MI-CONTINUOUS; G-CIV-1/2/3/4/7 and Civil scale gates; BIM render/editor; G-PE-CANVAS/CAPTURE-500M |
| Agent                | G-AG-UI while streaming/typing and job activity continue                                                          |

Changing a numeric threshold is allowed under X6 only with a committed before/
after report, a fixture/hardware rationale, and no change to the metric class.

### 7.2 Persistence and recovery rule

Every milestone after M0 must prove:

| P5 assertion                 | Failure condition                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Gesture preview is transient | Any canonical journal or disk flush during pointer motion                                                                     |
| Gesture commit is singular   | Zero or more than one root entry for one completed act                                                                        |
| Durability is truthful       | UI says stored before the append/group-commit acknowledgement                                                                 |
| Heavy bytes are indirect     | Geometry, transcript, capture, raster, or mesh buffers appear in journal payloads rather than immutable objects/job artifacts |
| Cancel is bounded            | Work ignores its named polling/ack/terminal budget or publishes a partial result                                              |
| Restart is explicit          | A multi-minute job silently restarts from zero or claims resume without verified partitions                                   |
| Undo is physical             | Required old objects were collected or disk was not preflighted before exact heavy undo                                       |
| Late results are fenced      | Old project generation/revision publishes after switch, restore, delete, or supersession                                      |

### 7.3 TEST-TIERS routing

| Tier    | Program use                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| changed | Focused schema/core/component tests and generated artifacts for every modified owner/consumer                                             |
| commit  | Changed gates plus format/lint/English UI where routed                                                                                    |
| push    | Browser/Electron/sidecar integration and risk-triggered continuous gates                                                                  |
| release | All release-always gates; missing `browser-gpu`, `real-data`, `large-data`, `linux-package`, or `windows-package` fails rather than skips |

An agent may run a higher tier early. It may never downgrade a required tier to
get a green result.

## 8. Owner-visible demonstrations and evidence

Each milestone produces one replayable script or fixture recipe, screenshots in
both themes where the spec requires them, machine-readable timing/resource
output, and a short narrative of what the user did and what survived restart.

The owner sees outcomes, not implementation inventory:

| Evidence              | Required content                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Demo recording/recipe | Start state, user intent, exact inputs, actions, cancel/recovery path, final deliverable   |
| Gate ledger           | Gate id, command, tier, capabilities, hardware/fixture, pass/fail, artifact links          |
| Performance delta     | Baseline/current p50/p95/max, metric definition, regression explanation                    |
| Persistence trace     | Preview writes, journal roots, durability ack, immutable roots, restart/cancel observation |
| Integration trace     | Owning record plus every passive consumer exercised                                        |
| Demanding-user report | Objections, severities, dispositions, and any intentionally deferred follow-up             |

Owner batch 2 adds the following cross-domain gates. These are specification
obligations, not evidence of implementation; any named launcher that does not
yet exist remains explicitly unverified and blocks the applicable milestone.

| Gate                           | Tier                                   | Required proof                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `G-B2-GESTURE-C1`              | changed + push browser                 | Static claimant scan plus interaction test proves Tab only traverses construction fields and Up/Down only cycles candidates across UI, Draw, Civil, PC, Raster, Plan, Select, registry.                       |
| `G-B2-INPUT`                   | changed + push browser-gpu             | Line/point click/constrain/type equivalence, Z/ΔZ/slope refusal cases, one journal entry, no pointer motion on typing, GAP-V1/V5.                                                                             |
| `G-B2-SELECTION-VISUAL`        | push browser-gpu                       | Entity adapter matrix, both themes/scales, direction/shape/anchor/support/BIM eligibility, cloud extreme and GAP-V2.                                                                                          |
| `G-B2-HISTORY`                 | changed + push                         | Interleaved document/selection/display/camera changes prove four histories, explicit restore scopes, restart behavior, Ctrl+Z document-only.                                                                  |
| `G-B2-P9-TREE`                 | changed + push                         | Four states, ancestor/layer/type/project composition, Mixed, bulk atomicity, 1M-node paged fixture, automation parity and GAP-V4.                                                                             |
| `G-B2-SEGMENTS`                | changed + push                         | Whole↔Segments changes no geometry; segment locator survives/invalidates deterministically; trim/edit dispatch one parent command and undo.                                                                   |
| `G-B2-SECTION`                 | changed + push browser-gpu             | Line/direction/depth/arrow create, exact frame, live source edit, delete/unresolved, camera history, clip-plane non-regression and GAP-V6.                                                                    |
| `G-CIV-CORE`…`G-CIV-SCALE-PIT` | existing Civil plan tiers              | Run the named Civil §8 gates; candidate/residual, profile, corridor, robust pit, real-data, SDK and import coverage.                                                                                          |
| `G-B2-PC-MEAN-SAMPLE`          | changed + real-data                    | Independent recomputation proves nearest existing point to cell mean Z and synthetic center/mean Z; empty/one-point/extreme cells, deterministic ties, bounded streaming, provenance and source immutability. |
| `G-B2-MESH-DRAFT-RULES`        | changed + push                         | Form-line topology; ordered exclusions; auto-boundary; 2D crop acquisition/error jumps; draft undo; explicit Apply-to-source separation.                                                                      |
| `G-B2-MESH-RECOVERY`           | push + release real-data               | 500M logical-point Civil/cloud draft closes/reopens/restarts/cancels, rejects source mismatch, and publishes once under MT-D17 budgets.                                                                       |
| `G-B2-SOLID`                   | changed + push + real-data             | Analytic planes/crossings/holes/disjoint/NoData/non-manifold fixtures; source sign; volume cross-check; solid/report distinction; automation parity and GAP-V9.                                               |
| `G-B2-STRATA`                  | changed + push                         | Ordered, missing, crossing and pinching strata; no invented interpolation; BIM schema-to-Mesh transaction and round trip.                                                                                     |
| `G-B2-RASTER-DIFFERENCE`       | changed + push browser-gpu + real-data | Analytic signed cell values, surface/cloud combinations, NoData, stale/regenerate, legend, export/round-trip and GAP-V10.                                                                                     |
| `G-B2-PLAN-CANVAS`             | push browser + Electron                | Infinite pan/zoom, finite paper, island dock/restore, P8 layout history, minimum width, multi-monitor/DPI restart and GAP-V11.                                                                                |
| `G-B2-CATALOG`                 | commit                                 | Unique ids, every mutation's automation path, no duplicate Civil/Mesh/Draw act, no silent deferred-row pruning, mutual citations, registry/spec status consistency.                                           |
| `G-B2-E2E`                     | release                                | DWG bases → slopes/pit → Mesh surface → alignment/corridor/profile/section → solid/difference raster → Plan capture/export → SDK replay with identical canonical results.                                     |

Owner batch 3 adds the M-RW gap gates. Their owning specs must supply the
fixture details and launchers before implementation can call the corresponding
package complete; the pending Registration/Stations spec is cited rather than
preempted here.

| Gate                        | Tier                                   | Required proof                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `G-RW-REGISTRATION`         | changed + push + real-data             | Cloud-to-cloud point-pair/target acquisition, ICP preview and quality evidence, user-owned commit, cancellation/recovery, P4 capture, and exact automation boundary on a real multi-station dataset.                  |
| `G-RW-STATION-DEPTH`        | push browser-gpu + real-data           | E57 panorama and station-cloud depth paths bind the exact station/camera, handle missing imagery honestly, pick/measure against depth consistently, restart, and meet presented-frame gates.                          |
| `G-RW-EXTRACT-GROUND-FLOOR` | changed + push + real-data             | Parameterized ground classification and planar-floor detection within P4 scope produce class and optional extraction results, preserve the source, use typed tolerance twins, and hand ground output to DGM creation. |
| `G-RW-DGM-SMOOTH`           | changed + push + real-data             | Marked-region preview and both S15 fill strategies preserve protected topology and source data, commit once, undo exactly, reject unsafe/non-finite results, and recover from cancellation/restart.                   |
| `G-RW-DGM-DOWNSAMPLE`       | changed + push + large-data            | Deterministic triangle reduction preserves boundaries/breaklines and the admitted error metric, previews quality/cost, stays bounded, cancels/restarts, and never silently changes domain truth.                      |
| `G-RW-ORTHO-IMPORT`         | changed + push browser-gpu + real-data | Representative tiled and untiled orthophotos stream with truthful progress/cancel/restart and resource ceilings; report time to first presented tile and pan/zoom presented-frame intervals.                          |
| `G-RW-VIEWER-COMPARE`       | release browser-gpu + real-data        | Execute RW-VIEW-1 exactly; retain the raw Builder/TRW runs and content-equivalence review. No “beats TRW” wording is allowed unless every stated pass condition holds.                                                |

The rebuilt Registry's named round-3 gate index is retained verbatim:

| Domain                  | Named gates registered by the current spec                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Civil                   | `G-CIV-CORE`, `G-CIV-FIT-UNIT`, `G-CIV-PIT-UNIT`, `G-CIV-CATALOG`, `G-CIV-ENGLISH`, `G-CIV-1`…`G-CIV-7`, `G-CIV-SCALE-FIT`, `G-CIV-SCALE-PROFILE`, `G-CIV-SCALE-PIT` |
| Draw                    | DR-D22: `G-DR-INPUT`, `G-DR-DERIVED`                                                                                                                                 |
| View                    | `G-VD-SECTION-LIVE`                                                                                                                                                  |
| Import/PhotoLab dataset | IF-D19–IF-D25: `G-IF-PD-1`…`G-IF-PD-6`, `G-R1-8`                                                                                                                     |
| Mesh batch 2            | MT-D31's calibrated batch-2 work/recovery gate matrix and MT-D32 passive-consumer/atomic-restore matrix                                                              |
| UI Platform batch 2     | UIP-D23–UIP-D26 history/state/cursor/continuous gate matrix                                                                                                          |

Cross-product release closure is separate and currently open:

| Gate                       | Current state                  | Closure                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `G-R1-8`                   | **UNMET** on 2026-09-02        | X-R1 implements Import/Formats' **register a PhotoLab product dataset** capability in Builder while PhotoLab WP-G1 publishes the admitted package/provenance; every available renderable product then registers, reopens, saves as `.hcadx`, and opens read-only in WeltView with exact identity, bindings, provenance, render, pick, and snap semantics. |
| P11 generated-table parity | specified, implementation open | X-P11/PhotoLab WP-G2 supplies one generated command table consumed by Builder and PhotoLab UI operations, console, automation host, and Python SDK, with validate/status/cancel and user-only trust boundaries.                                                                                                                                           |

## 9. Autonomous execution protocol

### 9.1 Roles

Claude is the architect and orchestrates. Codex implementation lanes execute.
The architect owns
queue selection, dependency/cross-spec reconciliation, doctrine interpretation,
and the weekly derived-decision digest. Codex implements the selected vertical
slice, runs the gates, performs the demanding-user implementation review, and
reports evidence. Codex does not silently redesign an owning record; Claude
does not count an architectural disposition as implementation evidence.

### 9.2 Multi-session and lane protocol

`docs/builder-program/COORDINATION.md` is the authority for simultaneous
Builder and PhotoLab work. The following is a routing summary, not a second
protocol:

| Rule                 | Required execution behavior                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ownership            | Builder, PhotoLab, shared-substrate, and normative-document paths follow the ownership table in `COORDINATION.md`; shared files use announce → edit → announce landed, with one editor per file.                                                                                                 |
| Three Codex lanes    | Under D8's temporary token discipline, lanes may prepare or implement independent packages, but they do not bypass §2 prerequisites, package gates, or single-writer paths. Cargo concurrency is isolated from file ownership; it is not permission to edit the same shared module concurrently. |
| Cargo targets        | Every session/lane sets a unique `CARGO_TARGET_DIR=target/<session-or-lane>` (for example `target/builder-i01` or `target/photolab-release`). No two active lanes share a target directory. Release gates use a clean lane.                                                                      |
| Shared substrate     | Shared packages, root configuration, schemas, SDK, verification scripts, and shared Rust entry points remain one coordinated implementation lane within the three-lane cap. Builder implements shared substrate once and runs affected PhotoLab gates before completion.                         |
| Daily sync           | Each Builder and PhotoLab session sends one cross-session sync per day containing landed packages, shared-file intents for the next day, and open findings.                                                                                                                                      |
| Priority             | When shared resources contend, a failing PhotoLab release gate takes precedence and Builder yields, per `COORDINATION.md` §7.                                                                                                                                                                    |
| Findings and commits | An implementation mismatch is reported to the owning spec before code diverges. Each session commits only owned paths and announced shared changes.                                                                                                                                              |

### 9.3 Picking the next task

At the start of every implementation turn, the architect and executor apply
this deterministic selection algorithm:

1. Read `docs/CURRENT-DIRECTION.md`, the Q1 Branch A owner decision in
   `OWNER-DECISIONS.md`, this plan's §1 branch record, and `COORDINATION.md`.
2. Read the current `REGISTRY.md`; reject a task whose owning row is absent,
   duplicated, open, or lower than its implementation needs.
3. Find the earliest incomplete milestone in §6.
4. Within it, select the lowest numbered unfinished §5 package whose
   prerequisites and capabilities are available.
5. Prefer the smallest vertical slice that closes a user action plus all
   consumers over a horizontal model/UI-only slice.
6. Confirm the package fits an available path/Cargo lane and cannot starve a
   failing PhotoLab release gate; otherwise advance an independent ready package.
7. Record the package id, owning records, consumers, expected gates, and stop
   conditions before editing.

Agents do not cherry-pick a visually satisfying later feature, batch unrelated
cleanup, or promote a cataloged-deferred function because nearby code is open.

### 9.4 Definition of done

A work package is done only when all rows pass:

| Dimension             | Done condition                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User flow             | Discovery, entry, typed/pointer parity, confirmation, cancellation, close, recovery, contextual access, and accessible semantics work                    |
| Canonical behavior    | Query/command, CAS, journal/undo, persistence, failure, and security boundaries match the owning records                                                 |
| Whole system          | All callers, passive consumers, sibling packages/apps, context menus, console, schema, host, Python SDK, formats, migrations, docs, and tests are traced |
| Performance           | Every continuous/long extreme has its named runnable gate and measured result; presented-frame interval is used where required                           |
| P5                    | No interaction-path persistence; one completion entry; truthful acknowledgement; job/restart/cancel/retention behavior passes                            |
| Verification          | Required changed/push/release gates pass with capabilities; missing capability fails where TEST-TIERS requires it                                        |
| Review                | A fresh demanding-user implementation review exercises the real workflow and has no unresolved blocker/major finding                                     |
| Completion discipline | `CURRENT-DIRECTION.md` records completed capability and evidence; missing/partial labels change only after proof; follow-up scope is named               |

“Tests pass” is necessary but not sufficient. A demanding user must be able to
complete the stated milestone demo using the visible UI and the generated
automation path.

### 9.5 Demanding-user implementation review

The review is performed after implementation and before milestone closure. It
uses the applicable `*-spec-review-*.md` objections as regression prompts,
tests the least and largest class members, and inspects real code paths rather
than declarations. It must distinguish executed evidence from read evidence.

Any blocker or major finding reopens the package. Minor findings are fixed in
the package unless deferral is explicitly justified by the completion
discipline and registered. Ideas do not enter the queue without evidence and a
dependency placement.

### 9.6 Contract/doctrine re-walk rule

When `FUNCTION-CONTRACT.md`, `DECISION-DOCTRINE.md`, an accepted ADR, or an
owning decision record changes:

1. Mark every affected `specified` row provisionally stale.
2. Search all specs, consumers, gates, schemas, SDKs, formats, and migrations
   for the changed concept.
3. Cite-and-revise both sides of every dependency edge in §4.
4. Re-run registry duplicate-act/surface/state/gesture/shortcut/job/command
   checks.
5. Re-run the affected review objections and named gates.
6. Restore `specified`/done status only when the re-walk evidence is committed.

No agent may say “the contract changed after this spec” and continue on the old
meaning.

### 9.7 Escalation and vacation behavior

Use the doctrine escalation protocol before asking anything. A candidate
escalates only if existing axioms/precedents cannot decide it, the alternatives
materially affect product identity/scope/money/licensing or an explicitly
reserved boundary, and safe progress cannot continue without the choice.

The target is zero owner escalations. Derived decisions are implemented as
vetoable records and placed in the weekly digest. Genuine escalations are
batched; during the owner's vacation the architect selects the safest
no-expansion posture, records the blocked package, and advances independent
earlier work. It never fabricates domain truth or broadens scope to avoid a
wait. There is no known owner escalation after the Q1 Branch A decision; agents
do not reopen Q1.

### 9.8 Weekly owner digest

The owner reads one weekly digest, not agent transcripts. It contains:

| Section                   | Content                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Outcomes                  | Milestone demos newly passing, in user language                                     |
| Evidence                  | Gate ids, failures fixed, performance and P5 deltas                                 |
| Derived decisions to veto | Decision, derivation, rejected alternatives, affected records, veto deadline/status |
| Next queue                | Next five ready packages and their prerequisites                                    |
| Risks                     | Changed likelihood/impact, leading indicator, mitigation owner                      |
| Escalations               | Batched genuine items; target and expected count zero                               |

A one-line owner veto names the decision and replacement direction. The
architect records it in the owning decision/ADR and triggers §9.6.

## 10. Open reconciliation and implementation-evidence queue

### 10.1 Cross-spec-needs closure audit

Every item reported in `.claude/codex/out/cross-spec-needs.md` is represented
below. “Reconciled” means the reciprocal spec/registry wording landed; it does
not mean its runtime is implemented.

| Order | Reported need                                                                                    | Owning spec/document                         | Planning state                       | Execution action                                       |
| ----: | ------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
|  C-01 | Raster rows, PC-D9 arrival, Mesh fan-in, View lower layer, staged image hand-off                 | Raster / Registry / View / Mesh / Import     | reconciled                           | Implement RA-D5/D7/D8/D13 boundaries in D-04/D-05      |
|  C-02 | Measure ribbon, Draw boundary, PC inspection rows, File export, registry gestures                | Measure / View / Draw / PC / File            | reconciled                           | Implement in D-06 and run G-MI-CONSUMERS               |
| C-02a | Pointcloud amendment reported no additional reconciliation need                                  | Pointcloud                                   | no item reported                     | Preserve PC-D1–D16 ownership while closing consumers   |
|  C-03 | `hcad.measurement@1` admission                                                                   | Data Model / ADR owner                       | open implementation prerequisite     | S-01 before D-06                                       |
|  C-04 | Shared gizmo consumption, paste-in-place surface, Select rows/shortcuts                          | Select / File / UI Platform / Registry       | reconciled                           | S-06/S-10 and G-SE-\*                                  |
|  C-05 | `.hcadx` fragment profile and operation spool                                                    | Project Format / Select                      | planned normative text; runtime open | S-01 format ADR, then G-SE-FRAGMENT                    |
|  C-06 | `hcad.component.edit-lock@1`                                                                     | Data Model / Select / Draw                   | open implementation prerequisite     | S-01 then S-10 effective-editability gate              |
|  C-07 | Viewing-box bake placement key and transform preview behavior                                    | Viewing Box / Select                         | reconciled                           | S-09/S-10 shared consumer gate                         |
|  C-08 | Gizmo axis/hover/active theme tokens                                                             | Theme / Select                               | open implementation                  | S-02 before S-10                                       |
|  C-09 | Three Select benchmark scripts and fail-not-skip capability routing                              | Verification / Select                        | open implementation                  | S-10; prerequisite for Select completion evidence      |
|  C-10 | Plan dedicated window, View/BIM ownership, File restore/reachability, Draw dimension access      | Plan / UI / View / BIM / File / Draw         | reconciled                           | D-09 integration gates                                 |
|  C-11 | Plan authority, `.hcplan` exchange, capture consumption                                          | PLAN-EDITOR-EXPORT / Project Format / Plan   | planned normative text; runtime open | S-01 authority ADR then G-PE-PACKAGE/REAL-EXPORT       |
|  C-12 | Excalidraw host-history seam, runtime/font inventory, notices                                    | Plan fork / dependency/license owners        | open hard prerequisite               | D-09 begins with PE-D18 and G-PE-LICENSE               |
|  C-13 | Agent/import public boundary and bounded status, no public registration mutation                 | Agent / Import                               | reconciled                           | D-08/D-10; G-AG-IO + G-IF-7                            |
|  C-14 | Automation schema/generator/SDK/host synchronization                                             | Automation owner / Agent / PhotoLab          | open implementation                  | X-P11 first; D-10 consumes it; `automation.sdk`        |
|  C-15 | Agent journal actor/batch schema and migration                                                   | Core / Project Format / Agent                | open ADR/implementation prerequisite | S-01, then AG-D14/D20 tests                            |
|  C-16 | PhotoLab/WeltView negotiation, product-dataset registration, and unknown Agent data preservation | Shared store / Import / Agent / sibling apps | open; R1 gate 8 UNMET                | X-R1 then D-10 release fixture; Cap unchanged          |
|  C-17 | Import ownership, apply-to-similar, jobs, ASCII/IFC/BIM hand-offs                                | Import / File / UI / PC / BIM                | reconciled                           | D-02/D-08; G-IF-4/5/ASCII                              |
|  C-18 | Mesh render values, Raster Grid arrival, terrain snap, PC hand-off, volume export                | Mesh / View / Raster / Draw / PC / File      | reconciled                           | D-05 and shared cycle gates                            |
|  C-19 | P5/P6 re-walk of wave-1 specs                                                                    | Viewing Box / UI / Draw / PC / BIM / View    | reconciled in specs                  | Re-run as implementation review at M1–M6               |
|  C-20 | Registry-gated status and F8 naming                                                              | Registry / all specs                         | reconciled; zero findings            | Check before every task and after schema changes       |
|  C-21 | D6 catalog grammar, current specification, role generation, coded import, sewer rows             | BIM / Draw / Import / UI                     | reconciled under P7                  | D-07/D-08 with two different grammar fixtures          |
|  C-22 | P7 office-convention sweep                                                                       | All data/default/report owners               | reconciled in specs                  | Demanding reviews reject product-mandated office truth |
|  C-23 | C1/P8/P9/P10 batch-2 re-walk and Registry rebuild                                                | UI / Select / View / File / all consumers    | reconciled; 203 rows, 15 specified   | S-B2 substrate; run every `G-B2-*` owner gate          |
|  C-24 | Civil ownership and DR-D8 un-deferral                                                            | Civil / Draw / PC / Mesh / View / Select     | reconciled; Civil `specified`        | D-CIV and all named `G-CIV-*` gates                    |
|  C-25 | P11 generated command table                                                                      | UI Platform / Agent / PhotoLab / SDK         | specified; implementation open       | X-P11 / PhotoLab WP-G2 before X-R1 or D-10             |
|  C-26 | PhotoLab product datasets open canonically in Builder/WeltView                                   | Import / File / Agent / PhotoLab / WeltView  | specified; `G-R1-8` UNMET            | X-R1 plus PhotoLab WP-G1 after ADR 0030 acceptance     |

### 10.2 Review residuals by specification

The review reports contain no undispositioned textual blocker or major after
their revisions and the registry rebuild. The open queue is the implementation
proof those reviews demanded:

| Priority | Spec/review        | Residual proof owner                             | Required closure                                                                                                                         |
| -------: | ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
|        1 | UI Platform        | S-02–S-06/S-B2-P8/S-B2-P9/S-B2-G5-G6/S-B2-G7-G11 | shared controls, four histories, P9 resolver presentation, support/selection modes, target/cursor, G-UIP-1/2, batch-2 gates, real reload |
|        2 | File/Project       | S-07/P-01                                        | P5 latency, exact restore/reachability, long-job lifecycle, Save truth                                                                   |
|        3 | View Domain        | S-08                                             | ViewState v2 migration, interval metric, bookmarks, display layers, and stale-bake restoration                                           |
|        4 | Viewing Box        | S-09                                             | placement-keyed bake, P4, lock parity, mixed-scene VB-D7/VB-D8 evidence                                                                  |
|        5 | Select/Edit        | S-01/S-02/S-10/S-B2-P8/S-B2-P9/S-B2-G5-G6        | edit-lock and locator admissions, fragment runtime, P9 causes, histories, support/segment modes, tokens, missing benchmark launchers     |
|        6 | Draw               | D-01/S-B2-G5-G6/S-B2-G7-G11                      | tri-modal C1 input, support/segment adapters, 3D target/cursor, exact own-linework snap, all finish paths, P4, real terrain arrival      |
|        7 | Pointcloud         | D-03                                             | G-PC-A–E launchers/fixtures and native post-edit parity                                                                                  |
|        8 | Raster             | D-04                                             | evidence-only placement, recovery, Grid/Plan variants, real display/drape gates                                                          |
|        9 | Mesh/Terrain       | D-05                                             | content-addressed P10 drafts, 500M/restart, form-line/rules, hull/solid/strata gates, quantity/contour honesty                           |
|       10 | Measure/Inspect    | S-01/D-06                                        | measurement ADR, exact anchor/schema migration, 100,000-row report and facade gates                                                      |
|      10a | Civil              | S-01/D-CIV                                       | Civil schema admission; all 16 review resolutions; creatable core/UI/scale/real-data/automation gates                                    |
|       11 | BIM/Specifications | D-07                                             | canonical catalog/current-spec/generation, ≥10⁴ render/apply gates, exact exchange evidence                                              |
|       12 | Import/Formats     | X-R1/D-02/D-08                                   | PhotoLab dataset register/list and G-R1-8; source-token race, phase recovery, 80 GB exact undo, ASCII large                              |
|       13 | Plan Editor        | S-01/D-09                                        | Plan-root ADR, infinite-canvas gate, license/font/fork audit, native OS lifecycle, pass-complete capture, `.hcplan` v3                   |
|       14 | Agent              | X-P11/S-01/D-10                                  | one generated table, actor/batch schema, transcript atomicity/sanitization, trust tests, docs, sibling preservation                      |

The Mesh review's multi-surface batch/preset idea stays after the single-surface
workflow and G-MT-5. It enters implementation only if repeated use supplies P1
evidence; otherwise automation remains the repeat path.

### 10.3 ADR and normative prerequisite bundle

Registry §4.4 is the source ledger. Its pending-admission text is retained
verbatim here so queue work cannot silently narrow it:

1. `hcad.measurement@1` — canonical saved measurement geometry with exact
   anchors, measurement plane, verification/provenance state, and role
   migration (measure-inspect spec).
2. Edit-lock component — canonical entity edit lock, distinct from layer
   lock, with effective-editability resolution and command rejection
   semantics (select-edit spec).
3. ViewState v2 — entity-referenced clips, pinned Plan-viewport state,
   independent visibility/filter predicates, update policy, exact captured
   revisions (view-domain and plan-editor specs).
4. Plan root — canonical project-root sheets, elements, viewports, bindings,
   schedules, libraries, and revision/CAS rules (plan-editor spec).
5. Snapshot markers — named project snapshot markers over journal
   generations, including restore linkage and retention semantics
   (file-project spec).
6. `hcad.derived-recipe@1` — the recipe component of derived entities
   (sources by id + revision + parameters, linked/detached state, last
   regeneration, DAG constraints) per doctrine P10 and mesh-terrain
   MT-D25; and `hcad.mesh-source-roles@1` — boundary / breakline / form-line
   / exclusion roles of surface sources (mesh-terrain spec).
7. Point-acquisition provenance (how a point was acquired: pick, typed,
   3D-target estimate, field code — draw DR-D21), a support-role component
   (defining points/lines of higher-order entities, draw/select-edit), and
   the offset/parallel recipe schema (a `hcad.derived-recipe@1` profile,
   draw).
8. (Promoted 2026-09-02 to ADR 0030, Proposed — see "Immutable
   resources".)
9. Journal actor metadata and Agent batch/root records — so an agent turn
   groups child commands, preserves per-command author/audit identity,
   resumes after restart, and retains heavy-undo inputs, while preserving
   human/SDK/agent command equivalence; transcript state never becomes
   project authority (agent spec).
10. Civil schema bundle — alignments including circular vertical segments and
    vertical clothoids, station equations/regions, slope-derivation components,
    Civil standards, and corridor/pit/profile manifests (CIV-D16–CIV-D23).
11. Stable segment locator — `{parent_id,parent_revision,locator}` with
    deterministic semantic remap-or-prune behavior (SE-D19/DR-D18/BS-D23).
12. Local histories — selection, display/visibility, and camera streams with
    independent persistence, corruption scope, and undo/redo actions
    (P8/UIP-D19/SE-D19/VD-D14/FP-D21).

The execution mapping below adds consumers and sequencing; it does not replace
that ledger.

| Item                                                         | Must define before code persists it                                                                                                                               | Consumers blocked                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `hcad.measurement@1`                                         | versioned geometry/anchors/plane/provenance, migration, unknown-reader preservation, undo/export                                                                  | Measure, File, View, Select, Plan                           |
| `hcad.component.edit-lock@1`                                 | self/ancestor/layer causes, validation, query, legacy projection, migration                                                                                       | Select, Draw, BIM, SDK                                      |
| ViewState v2                                                 | entity clip refs, split hides/isolate, presentation/filter state, pinned revisions, v1 behavior                                                                   | View, Plan, Agent, File                                     |
| Plan root                                                    | product-root schema, immutable object refs, CAS, snapshot/GC reachability, `.hcplan` exchange                                                                     | Plan, File, View, BIM                                       |
| Snapshot markers                                             | generations, restore linkage, retention, safety marker, undo semantics                                                                                            | File, Plan, Measurement, Agent                              |
| Journal actor/batch                                          | deterministic version/hash, privacy-safe ids, child audit, undo/redo/replay, legacy/unknown versions                                                              | Agent, core, schema, Python, siblings                       |
| Fragment profile                                             | manifest/spool/ready boundary, quotas, CRS/unit review, collision/GC/recovery                                                                                     | Select cross-project exchange                               |
| `hcad.derived-recipe@1` + `hcad.mesh-source-roles@1`         | common P10 sources/revisions/parameters, linked/detached/last-good state, DAG/CAS; boundary/breakline/form-line/exclusion roles                                   | Draw, Civil, Mesh, Raster, BIM, Select, Import, File, Agent |
| Point-acquisition provenance + support role + offset profile | pick/typed/3D-target/field-code acquisition; explicit support metadata; typed offset/parallel recipe                                                              | Draw, Select, UI, Civil, File, SDK                          |
| PhotoLab import package/provenance (Registry item 8)         | ADR 0030 is Proposed and must be accepted before `hcad.product-import-package-manifest@1`, `hcad.photolab-product-lineage@1`, or read-only provenance persistence | X-R1, PhotoLab WP-G1, Builder, WeltView                     |
| Civil schema bundle                                          | circular/clothoid verticals, station equations/regions, slope derivation, Civil standards, corridor/pit/profile manifests                                         | D-CIV and all Civil consumers                               |
| Stable segment locator                                       | `{parent_id,parent_revision,locator}` identity and deterministic semantic remap-or-prune                                                                          | Select, Draw, BIM, fragments, SDK                           |
| Local histories                                              | selection, display/visibility, and camera streams with independent persistence, corruption, restore, and undo/redo scopes                                         | S-B2-P8, UI, View, Select, File                             |

These decisions are derived implementation prerequisites, not new owner
questions. They undergo the normal ADR review/acceptance process and the
demanding-user review before consumers persist data.

## 11. Risk register

Likelihood and impact are current judgments, not promises. Update them in the
weekly digest when evidence changes.

| Risk                                                                                                | Likelihood  | Impact   | Leading indicator                                                                                                                                 | Mitigation / owner                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-spec ownership drifts during implementation                                                   | High        | Critical | A consumer adds local state/command/gesture or changes a sibling record one-sidedly                                                               | Claude maintains §4 edges; Codex includes cite-and-revise and integration tests in every slice                                                                                   |
| New data models are implemented before accepted ADRs                                                | High        | Critical | Ad-hoc JSON/component fields appear for measurement, edit lock, ViewState, Plan, snapshot, or actor data                                          | S-01 is a hard gate; schema/migration/unknown-reader tests land before consumers                                                                                                 |
| P5 is violated by convenient autosave or heavy undo                                                 | High        | Critical | frame spikes correlate with append/fsync; journal payloads grow with datasets; old objects vanish                                                 | FP-D19 instrumentation always on in interaction gates; object reachability/disk preflight tests                                                                                  |
| Select/Edit benchmark prose is mistaken for runnable evidence                                       | High        | High     | G-SE ids report skip or no script exists                                                                                                          | Create launchers in S-10, register capability routing, fail release when absent                                                                                                  |
| Plan pass-complete capture is much harder than its existing screenshot substrate                    | High        | Critical | exporter omits or reorders point/splat/raster/transparency/section passes                                                                         | Implement PE-D7 partition contract before UI polish; gate deliberate overlap and empty views                                                                                     |
| Plan vendored fork/font licensing blocks late                                                       | Medium-high | Critical | no exact font hashes/embedding rights or second undo authority remains                                                                            | Make PE-D18/G-PE-LICENSE the first D-09 task, not a release cleanup                                                                                                              |
| PhotoLab lifecycle diverges from shared File/Project semantics (FP-D14 class)                       | High        | High     | shared store/window/job change passes Builder but breaks PhotoLab close/recent/archive behavior                                                   | Branch A requires affected PhotoLab gates on every shared change; retain explicit per-product lifecycle matrix                                                                   |
| PhotoLab/WeltView drop unknown new product data                                                     | Medium-high | Critical | round-trip fixture changes object/root bytes or unsupported methods appear available                                                              | AG-D21 capability negotiation and byte-preservation release fixtures before D-10 closes                                                                                          |
| Import/BIM cycle creates duplicate truth                                                            | Medium-high | Critical | format-id branches generate objects directly or BIM parses source files                                                                           | Enforce IF parses / BIM resolves+generates seam and one transaction in coded real-data gate                                                                                      |
| View/display layers fork between PC/Raster/Mesh/Plan                                                | Medium-high | High     | a new global mode mutates canonical style or a Plan filter changes entities                                                                       | VD-D8/VD-D13 are the only upper layer; shared mixed-scene display gate                                                                                                           |
| P10 recipe graphs create cascading invalidation, cycles, or stale last-good truth                   | High        | Critical | a domain adds a private dependency graph; regeneration fans out without bounds; late results replace newer generations                            | MT-D25 owns one DAG/CAS lifecycle; admit typed payloads first; gate cycle rejection, invalidation fan-out, last-good atomic restore, detach/relink, and source loss              |
| Civil numerics pass toy fixtures but fail long corridors, repeated stations, or degenerate topology | High        | Critical | fit/profile/pit output changes with partition order, non-finite values leak, station references become ambiguous, or cancel/restart hashes differ | D-CIV runs independent residual/evaluator checks plus all core, 10/100 km, 500M-cloud, pit-topology, LandXML, CAS, cancel, and restart gates before Plan/BIM consumers           |
| Registration/Stations starts before its pending spec and data admissions are accepted               | High        | Critical | D-RW-01/D-RW-02 invent station, panorama, depth, registration-session, or commit state in app code                                                | Keep both packages blocked until `specs/registration-stations/registration-stations.md`, registry re-walk, demanding-user review, schemas, migrations, and sibling behavior land |
| “Viewer beats TRW” escapes as an unmeasured or unequal comparison                                   | Medium-high | High     | marketing/demo text cites render-body time, unmatched point budgets/content, one run, or no raw RealWorks baseline                                | Permit the phrase only after `G-RW-VIEWER-COMPARE` executes RW-VIEW-1 and passes every presented-frame, input, fidelity, fixture, and review condition                           |
| Dossier attributions regress into product claims or invented authority                              | Medium-high | High     | an implementation or test treats a corrected inference, partial dossier capability, or vendor convention as adopted product truth                 | Preserve the Civil review's exact-row/dossier-wide dispositions; require source/owner/inference/product-decision labels and P7 editable standards in demanding-user review       |
| Long Mesh/Plan/Import jobs pass small fixtures but fail operationally                               | High        | High     | no truthful early progress, rising RSS/disk, restart from zero, late cancel                                                                       | G-MT-5, G-PE-CAPTURE-500M, G-IF-5 use extreme fixtures and hard resource/restart bounds                                                                                          |
| P11 tables fork between products, console, host, and SDK                                            | High        | Critical | UI action lacks a generated row, a console command is hand-listed, or raw RPC allowlisting bypasses validation                                    | X-P11/PhotoLab WP-G2 lands one generated source with staleness tests and shared validate/status/cancel/user-only trust gates before X-R1 or D-10                                 |
| R1 gate 8 remains superficially closed by file compatibility alone                                  | High        | Critical | PhotoLab output opens only through private viewers, loses provenance, or differs after Builder Save As/WeltView reopen                            | Keep `G-R1-8` UNMET until X-R1 + WP-G1 pass every available renderable kind through canonical registration, identity/hash/provenance comparison, and render/pick/snap checks     |
| Parallel verifier introduces races/flakes                                                           | Medium      | High     | intermittent output-dir deletion, port collision, or differing task set                                                                           | Explicit conflict keys, serial equivalence replay, ten-run no-flake gate before enabling by default                                                                              |
| mold/sccache/profile changes hide correctness or platform differences                               | Medium      | High     | only accelerated machine passes; release binary/inventory changes                                                                                 | Optional detection/fallback matrix; release profile/linkers untouched; artifact parity gate                                                                                      |
| Rate limits or agent/tool availability interrupt autonomous work                                    | High        | Medium   | repeated provider throttles, context/tool failures, unavailable package capability                                                                | Keep tasks checkpointed and repo-driven; no correctness depends on live model/network response; resume from gate ledger; batch non-urgent tool work                              |
| Required release capabilities are unavailable                                                       | Medium      | High     | browser-gpu/real-data/large-data/native package tasks skip on ordinary runners                                                                    | Capability-aware scheduling; missing release capability is fail, not skip; reserve native/real-data runners early                                                                |
| Owner returns to a volume of opaque derived choices                                                 | Medium      | Medium   | decisions scattered across transcripts or merged without derivation                                                                               | Weekly veto digest with one-line decisions, evidence, and affected records                                                                                                       |

The risks most likely to bite first are ownership drift, premature schema
implementation, P5 regressions, P11 drift, Civil numeric/recipe complexity, and
PhotoLab lifecycle divergence. Plan capture, R1 gate 8, and licensing are the
most likely late critical-path surprises if not pulled to their named packages.

## 12. Completion and release rule

Builder is complete only when M0–M8 and the intermediate M-RW owner outcome all
pass on the required capability matrix, the Registry remains at a clean current
re-walk (the pre-batch-3 2026-09-02 baseline was 203 rows, 0 duplicate acts, 0
contradictory guarantees, 0 open F1–F14 findings, and all 15 baseline specs
`specified`; the post-M-RW registry must also admit and specify every batch-3
row/domain), every accepted schema has migration and
unknown-version behavior, all continuous gates report presented-frame
intervals, every deliberate gesture and Agent action has truthful one-step
persistence/undo semantics, and the final demanding-user review has no blocker
or major finding.

The release candidate must also prove:

- native Linux and Windows application/package behavior;
- real-data and large-data workflows with cancellation and restart;
- byte-safe archive/open/save behavior across compatible sibling products;
- dependency, license, runtime, font, model, dataset, and notice closure;
- generated automation schema/SDK/doc staleness checks;
- one P11 command table consumed by Builder and PhotoLab UI operations,
  consoles, automation host, and Python SDK;
- `G-R1-8` closure through canonical PhotoLab publication, Builder
  registration/Save As, and WeltView read-only reopen;
- scale-true Plan output and physical handoff;
- recovery after renderer, sidecar, app, and interrupted external-publication
  failures.

The program ends on a user outcome: a producer can take an actual surveyed
project from source files to an auditable, recoverable, scale-true deliverable
through either visible controls or the same canonical automation contracts,
without losing truth, interaction performance, or authority boundaries.

- **I-03 terra trial (2026-09-02 night):** gpt-5.6-terra (medium) reverted the whole project-references change and declared `G-INFRA-TSC` BLOCKED on a claimed `@himmelcad/data` public-API defect (`EntityId`, `SnapResult`, `SnapTargetMask` "not exported"). Architect check: those types ARE exported from `packages/@himmelcad/data/src/index.ts` (lines 9, 1360, 1365); the failure is declaration-redirect resolution under `composite` (the `@himmelcad/data` path alias vs the emitted declaration entry), i.e. a configuration problem the run misdiagnosed as an API defect. Evidence file kept (`evidence/I-03-ts-project-references-2026-09-02.md`) with this correction. Disposition: I-03b re-run on gpt-5.6-sol with the alias/declaration-entry finding stated up front; terra A/B verdict: honest revert and evidence discipline good, root-cause analysis unreliable — do not route diagnosis-heavy substrate work to terra.

- **Queue status (architect, 2026-09-02 night):** I-01 PASS, I-02 PASS (warm baseline still open), I-03 blocked → I-03b queued behind the PhotoLab lane's E1 landing, I-04 landed (`G-INFRA-RUNNER` PASS: serial 85.2 s → 38.6 s at `--jobs 4`, 10/10 repeated runs flake-free, cargo-lane exclusivity proven, evidence `evidence/I-04-parallel-verifier-2026-09-02.md`), I-07 PASS (linter fully green after the batch-2 catalog rows). **Disposition of I-05/I-06:** deferred behind S-01…S-10 and the 0.5 slices. Derivation: D8 token discipline (park non-gate packages) + both packages are measurement programs (five clean and ten incremental Rust builds each) that cost hours of machine time and tens of GB in a lane that shares disk with PhotoLab's release gates, while no 0.5 slice depends on them (X1 priority: correctness before speed of builds). Tunable: yes — revisit when a 0.5 slice's turnaround is demonstrably build-bound.

- **I-03b landed (2026-09-02 night, gpt-5.6-sol medium):** `G-INFRA-TSC` PASS — one 15-project `tsc -b` graph, cold 35.4 s, warm 2.0 s (5.7 % of cold; architect re-measured 2.5 s), identical diagnostics probe, PhotoLab/Builder/WeltView typechecks green, no data exports changed, `.tsbuild/` ignored. Confirms the §10 terra note: the first attempt's "API defect" was a resolution problem. Queue continues: S-02 running; S-01 (ADR 0031 admissions, D12) brief ready, launch sequenced behind the PhotoLab lane's WP-H2 edit of `data/src/index.ts`.

- **Segmentation joins 0.5 (owner statement S21, 2026-09-03):** new slice **0.5-02a Fence segmentation** (Pointcloud PC fence rows: keep-inside / remove-inside on the visible set per P4, one journaled transaction per apply, baked reduced dataset per P2, undo restores the source cloud) inserted between 0.5-02 ground extraction and 0.5-03 sampling; gate `G-PC-B` fence subset + `G-RW-SEGMENT` from M-RW. Predecessors: D-02 import/view, S-04 selection, S-05 jobs. Estimate +0.15 weekly budget.

- **Viewer Core program V-00 (2026-09-04, owner: the 3D view is the core):** dossier `dossiers/viewer-performance-2026-09-04.md`, addendum `specs/view/viewer-core-addendum.md` (VC-D1–VC-D12, hardware classes I/W/D with numeric guarantees, D-RW-07 protocol), baseline script `scripts/perf/viewer-baseline.mjs` (first run blocked by a missing wasm `Measurement` arm, fixed by the architect; rerun pending). Queue insertion: **V-01 measurement authority** runs next to S-04/S-05 (kernel instrumentation first, HUD seam with S-08); **V-02 prepared visible frontier** joins D-02; **V-03 protected scheduler/governor** and **V-06 3D↔2D continuum** precede 0.5-01; **V-04/V-05** may overlap after V-03; **V-07/V-08** belong to M-RW closure. 0.5 estimate +0.5 weekly budget, +1 week.

- **Queue status 2026-09-04 17:40:** S-01, S-02 (+S-02b/c after G17 review), S-03, S-04, S-05 landed (uncommitted, Builder lane); S-04/S-05 landed 13:41/13:38 with app 34/34, viewer 125/125, selection history 1 000 undo 9.5 ms, 10⁵-id toggle 13 ms; S-05 main-process registry with reload rehydration, real-import cancel test, bridge-level three-import fallback (no physical fixtures in checkout). V-01 launched 17:40 alone. Next: S-06 command surfaces (needs UIP-D6 runtime registry — S-04 exposed 'Select under cursor' data for it), S-07/S-08, P-01, D-02 + V-02.
