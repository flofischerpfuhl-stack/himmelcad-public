# PhotoLab workflow adoption audit — 2026-09-02

Document class: **Report**

Scope: PhotoLab release work against the Builder program workflow

Mode: read-only source and evidence audit; this report is the only authored artifact

Reviewer posture: daily-flight photogrammetry operator

## Verdict

**Not release-ready against the adopted workflow.** The implementation contains substantial real work—durable job history, checkpoint plumbing, cancellable atomic archive publication, recovery records, deterministic reports, offline-runtime contracts, visual baselines, and a broad PhotoLab UI—but its release plan was not re-derived through the function contract. More importantly, the current Electron boundary turns **Save** into an autosave-only working-copy flush even though PhotoLab is still archive-first, close can terminate after a failed drain, and long work is split between a renderer-polled sidecar job list and invisible side operations rather than UIP-D10's main-process registry.

As an operator, I can tolerate slow preprocessing. I cannot tolerate a Save button that does not update the archive I believe I am in, a close path that gives up and exits, or a reload that makes active import work disappear from the only progress surface.

Finding count: **12 total — 4 blockers, 7 majors, 1 minor.** There are **zero owner-decision items**. Every disposition below follows an existing axiom, precedent, accepted ADR, or documented release gate.

## Audit basis and method

The controlling workflow is explicit: both sessions use the contract and doctrine, and PhotoLab consumes the shared substrate rather than designing a parallel one (`docs/builder-program/COORDINATION.md:17-25`). Authority runs accepted ADR → normative document → specification → plan/report (`docs/README.md:6-16`), and a plan is never evidence that work exists (`docs/README.md:60-68`). The contract requires a user narrative and grounded reference behavior (`docs/FUNCTION-CONTRACT.md:39-75`), verified sibling semantics (`docs/FUNCTION-CONTRACT.md:77-84`), reachability/lifecycle (`docs/FUNCTION-CONTRACT.md:88-110`), quantified long-work and restart behavior (`docs/FUNCTION-CONTRACT.md:160-176`), passive-consumer/concurrency analysis (`docs/FUNCTION-CONTRACT.md:193-214`), and a named check for each claim (`docs/FUNCTION-CONTRACT.md:216-218`). Consequential decisions require Decision / Derivation / Rejected / Tunable (`docs/DECISION-DOCTRINE.md:168-177`).

The audit read the requested plan, renderer shell and panels, Electron main/preferences, sidecar project/job lifecycles, the controlling specifications, and current generated evidence. It also executed, on this tree on 2026-09-02:

- `pnpm photolab:check:english-ui` — pass.
- `pnpm photolab:test:preferences` — 6/6 pass.
- `pnpm photolab:test:processing-report` — pass.
- `pnpm photolab:test:project-files` — pass.
- `pnpm photolab:test:dialog-policy` — pass.
- `pnpm photolab:test:release-contract` — pass.
- `pnpm desktop:test:auto-update` — pass.
- `pnpm photolab:test:visual-baseline` — 10/10 pass.

These are useful deterministic checks, not release certification. The visual-baseline command is explicitly a PNG codec/comparator unit suite (`scripts/test-photolab-visual-baseline.mjs:3-12`), and the release contract constructs a synthetic package fixture (`scripts/test-photolab-release-contract.mjs:60-129`). `TEST-TIERS` says real data, native packages, real cancellation/resume, and matching-machine pixel comparison remain operator-run (`docs/TEST-TIERS.md:121-137`).

## Findings

### F01 — Blocker — Save no longer saves the PhotoLab archive

**Contract question / precedent:** sibling semantics A3; complete lifecycle B2; D1; X1; P5/P6; FP-D2; FP-D14.

**Evidence:** The accepted File/Project specification verifies that PhotoLab currently has the *opposite* lifecycle from Builder: it is archive-first with a real Save, and explicitly queues—not adopts now—the future journal-implicit migration (`docs/builder-program/specs/file-project/file-project.md:526-546`, `:1011-1021`). The sidecar still implements that real operation: `save()` atomically writes the manifest and repacks an `.hcadx` source (`crates/himmelcad-sidecar/src/project_runtime.rs:8035-8075`), with candidate publication only after packing succeeds (`crates/himmelcad-sidecar/src/project_runtime.rs:11333-11385`). Electron does not call it. For an `.hcadx`, `project:save` calls only `photolab.project.autosave` and returns a snapshot (`apps/photolab/electron/main.ts:1286-1298`), while the renderer logs “All changes stored” (`apps/photolab/renderer/src/App.tsx:1240-1264`). Save As still changes the active source and lock (`crates/himmelcad-sidecar/src/project_runtime.rs:8119-8173`), contradicting WP-C3b's claim that it is merely a copy (`docs/implementation-plans/2026-09-photolab-release-polish.md:493-505`).

**Objection:** This is not a harmless early adoption of Builder D1. It changes the meaning of PhotoLab's established Save before FP-D14's queued migration, without migrating archive identity, Save As, snapshots, recovery copy, status language, or tests as one lifecycle.

**Proposed disposition — fix before release:** Restore Electron's `.hcadx` Save route to `photolab.project.save`, retain the current archive-first Save As “switch to the archive” behavior, and report success only after archive publication acknowledgement. Keep the working-copy autosave and truthful pending/failure indicator. Delete or supersede WP-C3b's premature lifecycle claim. **Defer** journal-implicit Save/Save-As-copy/snapshot migration as one FP-D14 package after release.

### F02 — Major — The release plan carries 38 packages without contract disposition

**Contract question / precedent:** A1–E3 in full; doctrine decision auditability; X7.

**Evidence:** The plan says it follows the contract but provides phases, Problem / Design / Acceptance blocks, and a review checklist (`docs/implementation-plans/2026-09-photolab-release-polish.md:3-36`, `:1088-1119`), not an A1–E3 disposition. It contains **38** work packages (`:46-1040`). Only WP-C3b has the required four-part decision record (`:493-505`). WP-G2 has a one-line “Decision” but no derivation, strongest rejected alternative, or tunability statement (`:1013-1040`). The plan's dated integration evidence covers a 24-image Fast subset and explicitly excludes kill/resume, merge, GCP optimization, DEM, ortho, mesh, and splat (`:1061-1078`). Acceptance criteria are prospective, not proof.

**Package inventory:**

| Packages | Missing workflow material | Evidence status in the plan |
| --- | --- | --- |
| A1, A2, A3, A4, A5, A6 | No complete A1–E3 disposition; no doctrine-form decision record | A5/A6 have real investigative observations; A1/A2 have partial 24-image evidence; no package has its complete acceptance proof |
| B1, B2, B3, B4, B5, B6 | No complete A1–E3 disposition; no doctrine-form decision record | Checkpoint/history/drain code exists, but kill/resume was not exercised; B4/B5/B6 acceptance is not evidenced |
| C1, C2, C3, C4, C5, C6, C7, C8, C9, C10 | No complete A1–E3 disposition; no doctrine-form decision record | Current surfaces show several packages landed; the plan has no package evidence ledger proving their whole acceptance criteria |
| C3b | No complete A1–E3 disposition; **has** a doctrine-form decision record | Decision conflicts with the newer authoritative FP-D14 disposition and current archive semantics; therefore not valid evidence of adoption |
| D1, D2, D3, D4 | No complete A1–E3 disposition; no doctrine-form decision record | Merge and the 135-image GCP scope were not exercised |
| E1, E2, E3, E4 | No complete A1–E3 disposition; no doctrine-form decision record | No executed acceptance evidence recorded |
| F1, F2, F3, F3b, F4 | No complete A1–E3 disposition; no doctrine-form decision record | Deterministic tests and generated visual/a11y artifacts now exist; native release and keyboard acceptance remain open |
| G1, G2 | No complete A1–E3 disposition; G2 is only a partial record | G1 explicitly keeps gate 8 open; G2's required command-row file is absent |

Thus **38/38 lack complete contract disposition, 37/38 lack a complete doctrine decision record, and 38/38 lack attached proof of every named acceptance criterion**. That statement audits the plan's evidence discipline; it does not claim that all 38 implementations are absent.

The plan also leaves “owner defaults” for A2, B2, C3, C6, and E1/E2 (`docs/implementation-plans/2026-09-photolab-release-polish.md:1121-1124`), calls A6 an owner decision (`:243-248`), and treats F4 as owner-only (`:947-953`) without showing the escalation protocol's failed derivation (`docs/DECISION-DOCTRINE.md:66-81`). None needs to survive: one deterministic report follows X1/P7; unsupported Pause is removed by truthful-copy rules; explicit litter deletion confirmation follows X1; the functional batch surface beats a decorative duplicate under X1/X5; transparency-first QC follows X1; GPU runtimes defer under ADR 0013 until they can meet parity; native Windows certification is an executable platform gate, while signing can be declared out of release scope.

**Proposed disposition — fix before release:** Add, in the PhotoLab plan, a compact A1–E3 disposition and evidence row for every package; convert consequential choices to doctrine records or cite an accepted record unchanged; mark every unexecuted acceptance check open. Do not ask the owner any of the listed defaults. This report does not edit the plan because the audit was expressly read-only apart from this report.

### F03 — Major — Metashape-attributed design claims are not A2-grounded

**Contract question / precedent:** A2; X4; doctrine auditability rule 1.

**Evidence:** A2 requires each reference claim to cite specific repo-resident dossier or equivalent evidence and every catalog row to receive a disposition (`docs/FUNCTION-CONTRACT.md:43-75`). The plan uses Metashape behavior to choose or defer ground classes, QC philosophy, gradual selection, coverage presentation, report content, and LAS parameters (`docs/implementation-plans/2026-09-photolab-release-polish.md:180-185`, `:823-851`, `:870-881`, `:1048-1057`) without specific evidence citations. The repository's golden-dataset document is valid evidence for measured survey outputs and explicitly distinguishes the eight-image smoke from the 135-image acceptance (`docs/photolab-agisoft-golden-dataset.md:68-73`), but it is not cited for those UI/catalog claims and does not disposition a reference catalog.

**Proposed disposition — fix before release for release-scope claims:** Cite exact repo-resident evidence for each Metashape-derived behavior and list adopt/defer/reject. Mark unsupported claims unresearched. **Defer** non-release E1–E4 catalog breadth rather than presenting it as derived. No owner decision is needed: absent evidence means “unresearched,” not “ask the owner.”

### F04 — Blocker — Jobs and imports do not consume UIP-D10

**Contract question / precedent:** D1; E2; UIP-D10/UIP-D11; FP-D20; design-system progress/cancellation.

**Evidence:** UIP-D10 requires every job to register in Electron main immediately, mirror to renderers, and rehydrate chip/progress/cancel after reload (`docs/builder-program/specs/ui-platform/ui-platform.md:767-788`). PhotoLab instead polls `photolab.jobs.list` from renderer state every 500 ms (`apps/photolab/renderer/src/App.tsx:2217-2267`) and passes that array into a Jobs tab (`apps/photolab/renderer/src/App.tsx:4246-4275`; `apps/photolab/renderer/src/PhotolabBottomPanel.tsx:59-167`). The status bar has storage/images/GCP/snap/units but no global jobs chip (`apps/photolab/renderer/src/App.tsx:3772-3839`). The sidecar job list is durable and exposes cancel/resume (`crates/himmelcad-sidecar/src/job_runtime.rs:644-714`), which is valuable, but Electron main is only an allowlisted RPC proxy (`apps/photolab/electron/main.ts:559-564`), not the registry owner.

Image inspection/commit progress is rendered only inside the import island (`apps/photolab/renderer/src/ImageImportPanel.tsx:982-1046`, `:1817-1826`). The project runtime tracks archives, image commits, image inspections, masks, and GCP operations separately (`crates/himmelcad-sidecar/src/project_runtime.rs:2424-2434`), while its drain covers only archives and image commits (`:2450-2501`). These operations therefore have neither UIP-D10 reload recovery nor one complete lifecycle owner.

**Proposed disposition — fix before release:** Consume the Builder-lane UIP-D10 registry—do not build a PhotoLab-private registry. Register all release long work at admission, including archive, image inspect/commit, CRS/GCP/import and product work; provide the status chip → Jobs island → toast → console chain; rehydrate after renderer reload; route cancel through the registry. If the full side-channel migration cannot land safely, add registry adapters and complete drain hooks now, then migrate ownership post-release. The R1 cancel/recovery gates stay open until this is executed.

### F05 — Blocker — Close can abandon an unacknowledged durability boundary

**Contract question / precedent:** B2; D1; E2; X1; UIP-D14; design-system complete flow.

**Evidence:** Electron intercepts window close and starts quit (`apps/photolab/electron/main.ts:353-357`, `:2496-2504`). It races drain-and-close against 25 seconds, but both timeout and error flow into `finally`, which stops the sidecar and quits (`apps/photolab/electron/main.ts:2505-2535`). The sidecar correctly refuses to mark a session clean after either job or side-operation drain times out (`crates/himmelcad-sidecar/src/project_runtime.rs:8242-8253`), but Electron discards that refusal and closes anyway. The side-operation drain omits the active inspection, mask, and GCP maps noted in F04. The plan's own real integration did not exercise kill/resume (`docs/implementation-plans/2026-09-photolab-release-polish.md:1076-1078`).

**Proposed disposition — fix before release:** On drain timeout/failure, keep the window and sidecar alive; show what is still active, what remains safe, and **Retry / Cancel close / Force quit**. Force quit must be explicit, accurately describe recovery consequences, and never set clean shutdown. Include every side-operation owner in the drain or route it through UIP-D10. Execute close during each expensive stage and verify no child process, clean-shutdown lie, or partial canonical result.

### F06 — Major — Same-target admission and crash reconciliation remain incomplete

**Contract question / precedent:** E2; D1; X1; P5; SYSTEM-001.

**Evidence:** `JobManager::start_inner` rejects draining, duplicate job IDs, missing history scope, and capacity overflow, but has no publication-target key or conflicting-target admission (`crates/himmelcad-sidecar/src/job_runtime.rs:559-620`). The plan itself identifies last-writer-wins target collisions and side-channel gaps (`docs/implementation-plans/2026-09-photolab-release-polish.md:341-364`). It also identifies journal-before-manifest crash divergence and orphan datasets (`:366-387`). Current generic append still writes the journal before updating and autosaving the manifest (`crates/himmelcad-sidecar/src/project_runtime.rs:8025-8032`), while open-time cleanup shown here is specific to unpublished product-import packages (`:2817-2836`), not the general dataset quarantine promised by WP-B5.

**Proposed disposition — fix before release:** Add a frozen publication-target key at admission and reject queued/running collisions; prove atomic candidate → canonical publication and cancellation cleanup for every product kind. Land fault-injected manifest/journal reconciliation and orphan quarantine before claiming recovery. **Defer** performance refinements and migration of harmless bounded reads, not correctness ownership.

### F07 — Major — Escape and close are ad hoc, and text Escape can commit

**Contract question / precedent:** B2; E2 gesture reconciliation; UIP-D14; X5/P6; design-system input rule.

**Evidence:** UIP-D14 requires one dispatcher and exactly one rung per press—field revert, drag, menu, tool, modal, detached function, function tab, selection—and rejects ad hoc handlers (`docs/builder-program/specs/ui-platform/ui-platform.md:839-868`). Every `FloatingTaskIsland` installs its own window listener; one Escape can close every mounted non-modal island and it does not check focused input (`apps/photolab/renderer/src/FloatingTaskIsland.tsx:50-63`). Its modal handler also closes directly (`:79-85`). The image marker adds a capture-phase handler with `stopImmediatePropagation` (`apps/photolab/renderer/src/ImageWorkspace.tsx:964-974`). The shared entity rename commits on blur, while Escape only clears edit state (`packages/@himmelcad/ui/src/EntityTree.tsx:438-451`), violating the rule that text Escape reverts without the resulting blur committing (`docs/DESIGN-SYSTEM.md:147-150`). `FunctionPanel` exposes tabs and collapse but no close control (`packages/@himmelcad/ui/src/FunctionPanel.tsx:60-104`). The import close button remains enabled while `aria-busy` and immediately calls cancellation (`packages/@himmelcad/ui/src/ImportChat.tsx:15-47`).

**Proposed disposition — fix before release:** Consume the shared Escape dispatcher, register each PhotoLab surface by rung, and remove global component listeners. Guard dirty fields so Escape restores the committed value and suppresses blur commit. Add the visible function close action and make busy import close communicate “Cancelling…” until acknowledged. Add interaction tests with two open islands, focused text, armed marker, modal, active function, and selection.

### F08 — Major — Selection is partly correct but violates D16/D18 lifecycle

**Contract question / precedent:** C2; UIP-D15–D18.

**Evidence:** PhotoLab deliberately selects project entities from the tree (`apps/photolab/renderer/src/App.tsx:3872-3891`); the 3D viewport exposes snap/log callbacks but no selection callback (`:4344-4349`). That is consistent with UIP-D15's exclusion of point clouds/splats from click/hover selection and its deliberate tree/console/automation routes (`docs/builder-program/specs/ui-platform/ui-platform.md:870-890`). The multi-selection properties surface correctly shows Count and common/Mixed values (`apps/photolab/renderer/src/SelectionPropertiesPanel.tsx:31-103`); D17 write-to-all is not applicable while these rows are read-only.

The lifecycle is not correct. `acceptProject` clears selection unless a caller opts out (`apps/photolab/renderer/src/App.tsx:840-913`), and ordinary rename/visibility/move/remove refreshes call it without preserving selection (`apps/photolab/renderer/src/App.tsx:3092-3105`). Therefore hiding an entity clears selection, while UIP-D18 requires hide to survive and deletion to prune only deleted IDs (`docs/builder-program/specs/ui-platform/ui-platform.md:931-949`). D16 also requires project-local persistence and revalidation rather than unconditional loss (`:892-912`).

**Proposed disposition — fix before release:** Preserve and revalidate selection after non-project-replacement snapshots; hide/rename/move retain it, deletion prunes only removed IDs, project-stream replacement switches to that project's stored selection, and stale IDs are rejected. Keep viewport cloud/splat click selection **not applicable with reason** under D15. Keep D17 batch edits **not applicable** until an editable common property exists.

### F09 — Major — P11 inputs are missing and PhotoLab has zero product-command parity

**Contract question / precedent:** B1; X3; P11.

**Evidence:** P11 requires one generated command table to drive canonical commands/queries, validate/status/cancel, console, and Python; raw RPC allowlisting is not an exposure mechanism (`docs/DECISION-DOCTRINE.md:157-166`). Electron maintains a hand-written renderer raw-RPC set spanning PhotoLab operations (`apps/photolab/electron/main.ts:221-305`). The console is a hand-written switch with a short vocabulary (`apps/photolab/renderer/src/App.tsx:3893-3913`). The automation host allows only generic app/automation/view methods and rejects everything else (`packages/@himmelcad/automation-host/index.cjs:79-101`, `:182-205`), so no PhotoLab product operation reaches an agent or Python. WP-G2 acknowledges that gap and promises `docs/photolab-automation-command-rows.md` (`docs/implementation-plans/2026-09-photolab-release-polish.md:1013-1039`); that file does not exist on this tree. Report export even catches “query not allowlisted” as a normal data-absence reason (`apps/photolab/renderer/src/PhotolabBottomPanel.tsx:579-615`).

**Proposed disposition — fix before release at the PhotoLab boundary:** Deliver the command rows and an executable UI-action-to-row coverage gate; remove “done” language from G2. **Defer with dependency:** Builder-lane generated table/router/SDK integration until that shared substrate lands, then consume it unchanged. Until then, keep PhotoLab raw methods renderer-internal and unavailable to external automation—do not widen the raw allowlist as a shortcut.

### F10 — Minor — Cursor applicability is sound, but the adopted record is misidentified

**Contract question / precedent:** UIP-D22–D26; input consistency.

**Evidence:** `COORDINATION.md` calls UIP-D22 the cursor vocabulary (`docs/builder-program/COORDINATION.md:17-20`), but authoritative UIP-D22 is `Shared3DTarget` (`docs/builder-program/specs/ui-platform/ui-platform.md:1628-1635`); the cursor vocabulary is UIP-D24 (`:1645-1650`). The same spec explicitly says PhotoLab does not currently expose Builder taxonomies, histories, selection modes, or reticle, so those controls are inapplicable until a shared viewer surface gains them (`:1542-1547`). PhotoLab's local 2D image/GCP surfaces currently use ordinary semantic CSS cursors such as grab/grabbing/crosshair/not-allowed (`apps/photolab/renderer/src/ImageWorkspace.module.css:86-100`; `apps/photolab/renderer/src/GcpImageMarkerOverlay.module.css:34-97`).

**Proposed disposition — not applicable before release, with reason:** Do not retrofit Builder's 3D cursor stack or Shared3DTarget into current PhotoLab image marking. Correct the record citation during the next normative coordination edit. **Post-release:** when PhotoLab adopts a shared 3D selection/tool surface, consume UIP-D22 Shared3DTarget, UIP-D23 histories, UIP-D24 cursor resolver, UIP-D25 snapshot, and UIP-D26 gates together; do not retain local cursor precedence.

### F11 — Blocker — No R1 gate is currently proven closed

**Contract question / precedent:** E3; R1 gates; X1.

**Evidence:** R1 defines eight release gates (`docs/ROADMAP.md:7-20`). Current evidence classifies as follows:

| R1 gate | Evidence audit | Status and required disposition |
| --- | --- | --- |
| 1. Complete workflows from import to published deliverables | **Executed but partial:** 24-image import, alignment, depth, dense and LAZ completed; GCP optimization, DEM, ortho, mesh and splat explicitly not run (`docs/implementation-plans/2026-09-photolab-release-polish.md:1061-1078`). | **Open — fix before release:** execute all supported deliverables on a fresh release build. |
| 2. Real-data accuracy/quality | **Executed and failed:** the current 135-image Fast diagnostic passes GCP figures but fails alignment RMS; it is not Quality Hybrid, and no complete 135-image all-product result has passed (`docs/photolab-agisoft-golden-dataset.md:206-230`). | **Open — fix before release:** pass the frozen Quality Hybrid gate; do not substitute the eight-image smoke (`:68-73`). |
| 3. Deterministic lineage, reports, recovery/resume | **Mixed:** deterministic report/project checks passed in this audit; durable job history/checkpoints exist; kill/resume was not exercised (`docs/implementation-plans/2026-09-photolab-release-polish.md:1076-1078`). | **Open — fix before release:** execute crash/reopen/resume and compare frozen lineage/report bytes. |
| 4. Bounded cancellation for every expensive stage | **Asserted for real data:** the documented deterministic gate does not start the sidecar/backend (`docs/photolab-cancellation-matrix.md:3-13`); the real matrix is operator-run (`docs/TEST-TIERS.md:128-133`). | **Open — fix before release:** execute every real stage, close, and external-child case with bounds and destination-cleanliness checks. |
| 5. Offline runtimes and license closure | **Historical executed evidence:** ADR 0013 records a 2026-07-14 Windows payload/inventory and Wine worker execution, but says native Windows remained a separate gate (`docs/adr/0013-photolab-offline-release-runtimes.md:70-82`). The synthetic release-contract test passed in this audit. | **Open for current candidate:** rerun both-platform inventories and native startup for the exact candidate. |
| 6. Installable packages and update behavior | **Contract executed, platform certification incomplete:** update and synthetic packaging contracts passed here; ADR 0013 requires native Linux/Windows installer-followed-by-startup (`docs/adr/0013-photolab-offline-release-runtimes.md:88-106`). | **Open — fix before release:** native package/install/startup on every supported platform. If Windows is not supported in this release, say so; signing may be deferred, native certification may not be asserted. |
| 7. English, design system, accessibility, visual quality | **Mixed:** English passed; 84 baseline captures exist; bounded axe rules are currently zero-blocker (`.build/visual-regression/a11y-summary.md:1-7`), but the same report records keyboard-unreachable ribbon/panel controls across surfaces (`:96-143`). The comparator unit suite passed, not the matching-machine pixel comparison (`docs/TEST-TIERS.md:104-115`). | **Open — fix before release:** keyboard reachability/focus, actual pixel comparison, and human screenshot review. |
| 8. Outputs canonical for Builder/WeltView | **Asserted/open:** WP-G1 itself says the gate stays open until Builder register/reopen/Save As and WeltView read-only tests pass for every renderable kind (`docs/implementation-plans/2026-09-photolab-release-polish.md:997-1011`). | **Open — post-release only if R1 is re-scoped in the authoritative roadmap; otherwise fix before release.** A plan cannot silently waive it. |

**Proposed disposition — fix before release:** Treat the release as gated, not “polished.” Produce one immutable evidence ledger for the exact candidate: commit/build identity, command, capabilities, platform/hardware, artifact path/hash, result, and explicit skips. Current score is **0/8 proven closed**; partial/historical runs remain valuable evidence, not passes.

### F12 — Major — Current visual evidence disproves a complete accessibility claim

**Contract question / precedent:** E1/E3; design-system verification; R1 gate 7.

**Evidence:** WP-F3b records the first run's 766 critical and 2,035 serious axe findings and requires serious/critical near zero plus keyboard focus reaching controls (`docs/implementation-plans/2026-09-photolab-release-polish.md:933-945`). Current generated axe evidence is genuinely improved to zero within its stated bounded rules (`.build/visual-regression/a11y-summary.md:1-7`), and the checked-in exception list is empty (`apps/photolab/test/a11y-exceptions.json:1-4`). But keyboard reachability in that same run reports unreachable controls on essentially every non-modal surface (`.build/visual-regression/a11y-summary.md:96-143`). F3's full acceptance therefore has not passed. The deterministic dialog-policy test only source-matches a few properties (`scripts/test-photolab-dialog-policy.mjs:7-28`); it cannot prove Escape ordering, focus reachability, or running Electron behavior.

**Proposed disposition — fix before release:** Keep the historical first-run count labeled historical, attach the current generated report to the evidence ledger, make keyboard reachability a failing gate rather than an informational appendix, run matching-environment pixel comparison, and perform the contract-required screenshot comparison. No accessibility exception is justified merely because axe reports zero.

## Substrate adoption disposition summary

| Record | PhotoLab disposition |
| --- | --- |
| Gesture map §3.6 / UIP-D14 | **Contradicted.** Replace component-global Escape listeners with the shared ordered dispatcher before release (F07). |
| UIP-D10/UIP-D11 jobs | **Contradicted.** Sidecar durability is useful but does not satisfy main-process ownership, chip/island recovery, or side-operation coverage (F04/F05). |
| UIP-D15 | **Consumed for current cloud/splat viewport:** no click/hover selection; deliberate tree selection exists. |
| UIP-D16 | **Contradicted:** selection is cleared rather than project-local/revalidated (F08). |
| UIP-D17 | **Partially consumed:** Count/Mixed common read-only properties exist; write-to-all is not applicable until a common editable property exists. |
| UIP-D18 | **Contradicted:** hide/rename/move can clear all selection; deletion does not merely prune (F08). |
| UIP-D22 | **Not applicable today:** Shared3DTarget is not exposed in PhotoLab. |
| UIP-D23 | **Not applicable today:** Builder interaction histories are not exposed in PhotoLab. |
| UIP-D24 | **Current 3D resolver not applicable; future shared surface must consume it.** Local 2D semantic cursors are acceptable (F10). |
| UIP-D25/UIP-D26 | **Applicable to future shared interaction snapshots and to >1 s shared-state propagation; long work already needs UIP-D10 now.** |
| FP-D2 / FP-D19 | **Do not transplant Builder lifecycle piecemeal.** Preserve real archive Save now; reuse truthful status and off-interaction persistence guarantees. |
| FP-D14 | **Binding queue:** migrate PhotoLab to journal-implicit lifecycle later as one complete package (F01). |
| P11 | **Missing:** PhotoLab supplies rows/gates now; consumes Builder-lane generated registry later (F09). |

## Safe to adopt before release

These changes preserve current PhotoLab product identity and reduce data/recovery risk:

1. Restore real archive Save and truthful archive acknowledgement; retain current Save As switch semantics.
2. Consume UIP-D10 for release long work, or at minimum add shared-registry adapters plus complete drain hooks while the full owner migration lands.
3. Refuse close on failed/timed-out drain and expose retry/cancel/explicit-force-quit.
4. Add same-target admission, fault-injected crash reconciliation, and orphan quarantine.
5. Consume the shared Escape ladder; fix rename Escape/blur, function close, and cancelling states.
6. Preserve/revalidate selection for hide/rename/move and prune only deleted IDs.
7. Fix the combined open-file/open-directory dialog defect already queued by FP-D14 (`apps/photolab/electron/main.ts:1239-1253`); use platform-appropriate separate paths rather than an option Electron supports only on macOS.
8. Deliver PhotoLab P11 command rows and executable UI coverage without exposing raw RPCs.
9. Execute and archive the actual R1 gates for the exact release candidate, including keyboard reachability.

## Post-release migration

These are coherent migrations, not safe last-minute semantic swaps:

1. FP-D14's journal-implicit PhotoLab lifecycle: visible Save as verified flush, Save As as copy, named snapshots, terminology cleanup, and all archive/recovery/MRU tests in one change.
2. Full ownership migration of all side operations into the shared UIP-D10 registry after pre-release adapters/drain coverage remove the correctness hole.
3. Generated P11 table/router/Python SDK integration when the Builder-owned substrate lands; PhotoLab consumes it rather than creating a parallel registry.
4. UIP-D22–D26 Shared3DTarget, histories, cursor resolver, shared snapshot, and extreme interaction gates when PhotoLab actually exposes those shared 3D tool semantics.
5. Non-release E1–E4 QC/catalog breadth after A2 evidence and complete A1–E3 specifications exist.
6. Optional GPU runtime delivery only through a new parity/licensing/inventory decision consistent with ADR 0013; current CPU correctness remains authoritative.

## Zero-owner-question audit

No question survives the doctrine escalation protocol. Numeric thresholds are X6 tunables. Unsupported UI is removed or disabled by truthful-copy rules. Current archive semantics are already established by verified sibling analysis and FP-D14. GPU delivery and signing may be explicitly deferred as release scope with their consequences stated; native certification cannot be converted into an owner preference. Reference gaps become “unresearched.” Shared substrate ownership is already assigned by `COORDINATION.md`.

## System feedback

1. **The workflow was appended, not adopted.** The release plan predates or evolved alongside the contract and later added C3b/G1/G2 without re-auditing the earlier packages. Require a machine-checkable package footer containing A1–E3 disposition, decision-record citations, and evidence IDs before a release-plan package can be marked complete.
2. **SYSTEM-001 recurs at ownership boundaries.** The renderer, Electron, sidecar job manager, and project runtime each own part of cancellation/close/save. Add one lifecycle ownership table for every long operation: admission owner, progress owner, cancel owner, drain owner, checkpoint policy, publication target, crash result, passive consumers.
3. **Evidence needs a ledger separate from mutable plans.** Record exact commit/build, command, capabilities, machine/platform, input hash, output hash/path, and result. A historical prose paragraph must not be mistaken for a current-candidate pass.
4. **Static contract tests are named too broadly.** Keep them, but label output as synthetic/source-contract evidence so `release-contract` and `visual-baseline` cannot be read as native release or visual-regression certification.
5. **Correct the substrate citation.** Coordination names UIP-D22 as the cursor record; the authoritative cursor record is UIP-D24. This small mismatch is exactly how parallel designs begin.
