# Demanding-user review — UI Platform owner-statements batch 2 (2026-09-02)

Document class: report/verification evidence

Static adversarial review scoped to the **Owner statements batch 2 —
2026-09-02** amendments in `ui-platform.md`, including the amended records and
new UIP-D19–D22. Verdict: **not ready for owner review**. Headline: **5
blockers, 7 major findings, 2 minor findings, 0 ideas**. The amendment has the
right high-level instincts—one persistent strip, domain-scoped histories,
non-destructive selection modes, a shared reticle, and semantic geometry
colors—but it is still an amendment brief rather than an executable platform
contract.

## Findings

1. **Severity: blocker. Contract question: catalog / A3.**

   **Objection:** I cannot implement or even audit the batch because its
   functions do not exist in the target's catalog or the live registry. The
   target header honestly says `drafted (registry pending)`
   (`ui-platform.md:3`), but §1 still contains only the pre-batch rows. The
   amendment later compresses the new work into four informal aggregate rows—
   `ui.global-controls`, `interaction.state`, `selection.mode`, and
   `history.local`—and explicitly says the rebuild is awaiting
   (`ui-platform.md:1140-1144`). That loses the separate acts required by the
   gap catalog: support visibility, Whole/Segments, the existing view-mode act,
   selectable-kind filtering, global labels, per-entity labels, three local
   histories, and requested interaction state
   (`OWNER-STATEMENTS-2026-09-02-GAP.md:128-137`). `REGISTRY.md` contains none
   of them, still says its sources are fourteen specs and P1–P7
   (`REGISTRY.md:3-19`), and still certifies UI Platform as specified and the
   whole registry clean (`REGISTRY.md:419-438,502-507`). It also keeps the old
   Civil deferral even though D7 un-deferred Civil. This is exactly the status
   lie the registry rule exists to prevent.

   The target has a second same-revision catalog contradiction: lines 50–54
   correctly activate Select/Edit's Paste in place contribution, while lines
   56–59 still say no spec owns clipboard and the action is cut. A registry
   reader cannot know which statement is current.

   **Proposed resolution:** Derived, vetoable decision from Builder README
   registry rules, X7, A2's per-row rule, and GAP-D1: revise §1 in the same
   transaction as the registry. Give every user act one row, including access,
   owning command/query, surface, performance class, implementation evidence,
   and owning/consuming spec. Keep `view.mode` as the existing View-owned act
   with a new strip access contribution; keep selection modes/history with
   Select/Edit; keep display/camera histories and labels/support overlays with
   View; keep UI Platform as surface/component owner. Register the reticle's
   gesture claims and a cursor-declaration matrix without inventing component
   commands. Remove the stale clipboard note, add Civil and P8–P10 to the
   registry audit basis, rerun duplicate-act/surface/gesture/state checks, and
   publish new counts. The status remains `drafted` until that report is clean.
   No owner decision is needed.

2. **Severity: blocker. Contract question: C1 / E2.**

   **Objection:** Tab still does two incompatible things in the same viewport
   state. The new platform rule is clear—Tab traverses fields and Up/Down
   cycles a live candidate set (`ui-platform.md:559`, UIP-D16 at
   `:833-847`)—but the target's own browser test still requires “Tab moves
   selection through candidates” (`:967-969`), and its implementation delta
   says kernel “Tab cycling” exists and stays (`:884-894`). The live controller
   really does consume Tab (`KernelNavigationController.ts:460-465`). The live
   registry still assigns idle Tab to candidate cycling twice
   (`REGISTRY.md:309-311,369-374`). Measure/Inspect retains the same obsolete
   prose at `measure-inspect.md:185-192`, even though its later gesture table
   says the opposite at `:573-574`. Civil itself calls this outstanding at
   `civil.md:965-966`. The batch therefore fails the registry's one-owner
   gesture rule and would ship whichever behavior the last handler happened to
   see.

   **Proposed resolution:** Derived from CURRENT C1, GAP-D2, X1/X7, and the
   registry arbitration rule: perform one atomic edit across the target,
   Measure/Inspect, the registry, controller delta, and tests. Tab/Shift+Tab is
   normal focus traversal and, for any armed coordinate tool, enters/traverses
   the shared construction bar without pointer movement. Up/Down cycles only
   while the candidate indicator is live; when a numeric field owns focus and
   no candidate indicator is live, its ordinary field behavior remains. Change
   the controller binding and its “stable Tab order” comments to gesture-neutral
   “stable candidate order.” Replace the target test with Up/Down assertions,
   including field focus, viewport focus, indicator invalidation, and no
   selection change from Tab. Do not leave the old prose as an amendment that a
   reader must mentally override.

3. **Severity: blocker. Contract question: C1 / E2 / B2.**

   **Objection:** I activate the new 3D target in a sparse cloud and drag its X
   handle. The platform map says LMB drag is orbit/pan and a deviation must be
   stated (`ui-platform.md:540-560`); UIP-D22 merely says the target has axis
   and rotation handles (`:1127-1134,1170-1175`). It never claims handle-origin
   LMB drag, distinguishes it from camera drag, or says what LMB click, RMB,
   wheel, Tab, Escape, typing, Enter, `pointercancel`, focus transfer, or a
   trailing pointer-up does. Viewing Box and Draw consume the component, but
   neither can repair a missing shared component contract without forking it.
   This is the exact input-arbitration defect the CURRENT E2 addition was meant
   to catch.

   **Proposed resolution:** Derived from C1, E2, UIP-D14, X1/X5, and the shared
   gizmo precedent: make UIP-D22 a complete reticle state machine and add it to
   §3.6 plus the registry gesture map. A sub-threshold LMB click performs the
   domain's candidate pick; LMB drag beginning on an axis/plane/rotation handle
   exclusively manipulates that handle; off-handle LMB drag, RMB drag, MMB, and
   wheel retain camera navigation. Tab/Shift+Tab traverses typed origin and
   orientation fields; Up/Down cycles a live candidate set; printable input
   transfers to the matching field without moving the pointer; Enter confirms
   only through the owning domain; Escape is field revert → drag revert → armed
   target cancel; `pointercancel` equals drag revert; a trailing pointer-up after
   keyboard completion is ignored. Define project/local frame, rotation order,
   pivot, units, precision, constraint conflict, estimated/NoData behavior, and
   exact commit revalidation once in the component contract. Consumers then
   declare only domain authority and any expressly different gestures.

4. **Severity: blocker. Contract question: E2 / A3 / C2.**

   **Objection:** The promised “one effective state” is not actually one
   coherent permission model. UIP-D20 says UI Platform owns the four-state
   control and Select/Edit is the sole effective-state authority
   (`ui-platform.md:1155-1161`). SE-D19 says its resolver composes entity,
   ancestors, layer, kind, cloud class, attachment, isolate, and **global
   overlays** (`select-edit.md:1030-1044`). But the target also says the
   selectable-kind filter removes only selection candidates and never changes
   visibility or geometry (`ui-platform.md:1115-1117`), Labels affects only a
   label pass, and Support is a visibility overlay. Folding these orthogonal
   controls into one Hidden/Reference/Editable/Inert value makes a kind filter
   capable of suppressing snapping/editing, or makes a label toggle capable of
   changing entity permission. The command surface is split as well:
   `interaction.state.get/set/preview` in the target versus
   `selection.effective_state.explain` and `selection.mode.*` in Select/Edit
   (`ui-platform.md:1140-1144`; `select-edit.md:1052-1055`).

   The extreme members break the universal wording. An attached project cannot
   become Editable under D5; a raster can be selectable but has no geometric
   snap candidates; a cloud-class or 100,000-child parent may not support every
   requested transition. The target provides no capability matrix and no
   all-or-none result when one child cannot enter the requested state.

   **Proposed resolution:** Derived from X1/X3/X7, P4/P9, D5, GAP-D4, and
   SYSTEM-001: amend P9 and both owning specs at the source. P9's four-state
   result is a **permission ceiling**, intersected with each entity adapter's
   real capabilities; “Reference is snappable” means only where that entity
   exposes an exact snap provider. Its causes are entity, ancestor, layer,
   taxonomy kind/class, and attached-project requested state, with the stated
   Hidden > Inert > Reference > Editable precedence. Session isolate may impose
   Hidden. Keep kind filters, support visibility, and label visibility as named
   orthogonal overlays with separate effects; they never rewrite P9. Select/Edit
   owns one resolver/query and command-layer recheck; UI Platform owns only the
   control, preview, Mixed presentation, and command invocation. Domain adapters
   publish supported transitions and reasons. A parent update that any member
   cannot honor rejects whole with counts/reasons—never skips or silently
   weakens. Normalize the API names in one registry row per act.

5. **Severity: blocker. Contract question: C4.**

   **Objection:** “Four histories” still does not tell me what Undo will
   restore. UIP-D19 promises clear scope but never supplies it
   (`ui-platform.md:1146-1153`). Selection mode, selectable-kind filter,
   selected segment locators, P9 requested states, global Support/Labels,
   per-entity label choices, view mode, projection, and camera pose are not
   assigned to concrete histories. Nor are branch truncation after undo,
   coalescing boundaries, project switch, close/reopen, app restart, crash, or
   corruption behavior defined here. The old C4 answer says selection does not
   survive restart (`ui-platform.md:444-450`); the same-day File amendment says
   Selection, Display, and Camera histories persist and restore
   (`file-project.md:1351-1371`). Restoring a history whose current state was
   deliberately cleared is not deterministic. Generic `history.local` also
   conflicts with Select/Edit's named `selection.history.*` surface.

   **Proposed resolution:** Derived from P8, CURRENT C4, P5, X3/X5, FP-D21,
   VD-D14, and SE-D19: publish an affected-state table and make all three specs
   cite it verbatim. Document history owns canonical entity changes, including
   support roles and per-entity label policy, and remains the only Ctrl+Z path.
   Selection history owns set membership, Whole/Segments, kind filters, and
   segment tokens. Display history owns requested P9 display/permission changes,
   isolate, global Support/Labels overlays, and other visibility presentation.
   Camera history owns camera pose/pivot, projection, and 3D/2.5D/2D mode.
   Each local action records once at gesture end, truncates its redo branch on a
   new action, has its own explicit get/undo/redo/clear commands and visible
   control, and never triggers another history. Persist current state and its
   history per project in the versioned ViewState/local-state store as FP-D21
   requires; project replacement clears the active in-memory streams but
   reopening rehydrates that project's streams. Corruption resets only the
   named stream and logs it. Define history depth/coalescing as X6 tunables and
   update the obsolete “does not survive restart” text in place.

6. **Severity: major. Contract question: A2.**

   **Objection:** The batch ignores the corrected dossiers it was explicitly
   waiting for. The target's old A2 table dispositions only the former Access
   selection summary (`ui-platform.md:407-420`), and the batch claims exact
   Trimble color attribution remains “unresearched” (`:1187-1189`). The current
   dossier now proves the opposite: Access selection is blue, not orange;
   direction arrows are stakeout-contextual; universal point-square selection
   is unsupported (`trimble-perspective.md:342-361`). It also proves that
   Access has three project-data states—Selectable, Visible, Off—not the target's
   four; there is no Editable state, the icon meanings differ from the owner's
   sketch, parent Mixed has two distinct summaries, and arbitrary Ctrl/Shift
   multi-row application is not documented (`trimble-perspective.md:304-340`).

   UIP-D22 likewise provides no A2 answer for the reticle. The corrected
   RealWorks dossier says constrained coordinate picking, an oriented UCS,
   smart cloud picks, point construction, and a translation-only flat-target
   manipulator exist, but one generic freely translatable/rotatable point
   reticle does not (`realworks.md:350-412`). “No RealWorks precedent” is now a
   researched result and must be cited, not silently omitted. This violates
   evidence-precedes-spec and the per-dossier-row disposition rule.

   **Proposed resolution:** Add batch-specific A2 dispositions before the
   decisions. For Access: reject blue in favor of the owner's orange geometry
   selection token, explicitly as owner taste under DESIGN-SYSTEM; adapt
   direction arrows from stakeout-only to every directed selected/active curve;
   reject a claimed universal square precedent; map Access Selectable to
   Himmel:CAD Reference, Visible to Inert only as an approximation, Off to
   Hidden, and label Editable as a Himmel:CAD-native state; adopt parent/mixed
   summaries while recording arbitrary multi-row selection as native. For
   RealWorks: adopt constrained picks, oriented-frame and smart-pick inputs;
   record the movable/rotatable shared reticle as an owner-requested
   Himmel:CAD-native synthesis with no exact RealWorks precedent. Fix the
   “unresearched” sentence. These are derived dispositions, not owner questions.

7. **Severity: major. Contract question: E1.**

   **Objection:** The visual contract gives two mutually exclusive answers for
   selected geometry. The old workflow and UIP-D4 require the generic accent
   outline (`ui-platform.md:123-126,613-629`), and §7 still makes a solid 1 px
   accent outline the screenshot oracle for every selected pickable entity
   (`:1013-1019`). The batch instead requires orange directed curves, orange
   point squares, anchor-only symbol emphasis, and blue support geometry
   (`:1119-1125`). Saying D21 “amends” D4/D15 does not remove the old failable
   criterion. `packages/@himmelcad/theme/src/tokens.css:5-10,47-61` contains
   UI accent/selection-border rules only; no geometry-selection orange, support
   blue, direction, anchor, component, reticle, prohibited, or cursor tokens
   exist. The batch also leaves selected areas, surfaces, solids, rasters,
   cloud bounding boxes, and non-directed BIM bodies without a result. Those are
   the extreme and least-typical members of the class.

   **Proposed resolution:** Derived from DESIGN-SYSTEM's corrected geometry
   rule, E1, S2/G5, X6, and dossier rule 2: rewrite §2.2, UIP-D4/D15, and §7 in
   place and commit one in-repo batch-2 visual artifact. Name the shared token
   identifiers and exact dark/light values; certify contrast over dense clouds,
   rasters, and dark/light model geometry. Add a class matrix for directed
   curves, points, symbol anchors, areas, surfaces/solids, BIM bodies and
   eligible subcomponents, rasters, cloud/splat bounding boxes, support
   geometry, hover, active construction, and disabled/inert/reference states.
   Pair color with arrow/square/anchor/dash/outline cues. State directly:
   orange is owner taste; Access blue is deliberately not adopted. Keep the
   spec drafted until the artifact contains no conflicting oracle.

8. **Severity: major. Contract question: B1.**

   **Objection:** Several visible bottom-strip actions have no automation or
   console twin. The only aggregate API named for the strip is read-only
   `ui.global_controls.get` (`ui-platform.md:1140-1144`). Nothing names how an
   agent sets Support visibility or global Labels, how it changes an individual
   entity's label policy, previews/applies a P9 parent change, or invokes each
   local history without relying on an ambiguous aggregate. The target says
   View and Select/Edit remain state owners, but it does not give a reachability
   matrix or canonical routing. A visible toggle with only a UI path violates
   X3 and B1.

   **Proposed resolution:** Adopt the gap catalog's separation, normalized to
   the registry's dotted lowercase/snake-case convention: named get/set for
   support overlay, global labels, per-entity labels, view mode, selection
   granularity, selectable-kind filter, requested P9 state preview/apply, and
   selection/display/camera history get/undo/redo/clear. UI Platform contributes
   the strip/tree/menu surfaces; it does not wrap them in a second state store.
   Add ribbon/context/Properties/console/agent/Python/keyboard presence or
   explicit absence with reason for every row. Trust-surface asymmetry does not
   apply to any of these actions.

9. **Severity: major. Contract question: D1 / E3.**

   **Objection:** The new continuous and extreme interactions have no runnable
   gate. UIP-D22 adds target translation/rotation and per-pointer cursor
   composition; UIP-D21 adds direction arrows, stable screen-space squares,
   anchor/component manifests, and segment highlighting; UIP-D20 adds a mixed,
   paged 100,000-node tree. The amendment says tests cover them
   (`ui-platform.md:1177-1183`) but names no script, latency/frame metric,
   memory bound, time-to-first-preview, cancellation bound, or capability
   routing. Existing G-UIP-1 covers hover over a giant cloud and G-UIP-2 covers
   island/splitter drags only (`:977-984`). A static repository search found no
   UI selection/reticle/cursor benchmark; the only relevant existing script is
   `scripts/benchmark-builder-viewing-box.mjs`, whose gate does not exercise the
   shared target or 100,000-node propagation. “Paged” and “bounded” are not
   budgets.

   **Proposed resolution:** Derived from D1/E3, X1/X2, P3/X6, and TEST-TIERS:
   add a self-launching `browser-gpu` gate for target/segment/component/cursor
   motion with presented-frame-interval p95 ≤ 2× target frame time, visible
   cursor/reticle response by the next presented frame, zero stale committed
   coordinates, and bounded component-manifest work. Add a deterministic
   100,000-node tree gate with a stated first-page/preview budget and peak
   memory. If all-or-none propagation cannot finish in <1 s, classify it as a
   registered job with real progress, cancellation between bounded batches,
   restart policy, and atomic publication; do not disguise it as bounded UI.
   Register the scripts in push/release routing and fail missing capability.

10. **Severity: major. Contract question: E2.**

    **Objection:** The amendment creates shared state but never walks its passive
    consumers. There is no table saying what Hidden/Reference/Editable/Inert,
    Support, Labels, Whole/Segments, or kind filters do to point/splat, mesh/CAD,
    raster, BIM component and annotation render passes; picking/snapping;
    measurements; active Draw/Move/Viewing Box/Section tools; selection and
    segment tokens; Properties/tree; Plan capture/export; project export;
    automation; or WeltView/PhotoLab where shared controls apply. The dangerous
    race is immediate: while I am drawing from a support point, another surface
    changes its node to Inert or hides Support. The spec does not say whether the
    armed candidate disappears, the preview re-resolves, or commit rejects.
    Likewise, a parent propagation racing a canonical edit, import, delete, or
    attachment re-sync has no revision/CAS contract. “Failed bulk changes publish
    none” is necessary but not enough.

    **Proposed resolution:** Derived from SYSTEM-001, P4/P5/P9, X1, and E2: add
    a consumer matrix and race rules. Render and pick/snap consumers recompute
    from the same versioned effective snapshot; an active tool pins the candidate
    identity but revalidates state and revision at commit, visibly invalidating
    its preview when eligibility disappears. Selection membership survives hide
    per UIP-D18, but edits reject with every effective cause. Segment tokens
    remap/prune on parent revision as SE-D19 states. Parent preview captures the
    taxonomy generation; apply CAS-rejects on membership/state change and
    publishes all or none. Define Plan/export behavior explicitly—view captures
    may honor display state, while canonical project export must not silently
    drop hidden data. Sibling apps either consume the shared state or record why
    the domain is inapplicable. Add failure/crash recovery and tests for each
    named race.

11. **Severity: major. Contract question: A3 / catalog.**

    **Objection:** The batch-wide cite-and-revise check is still not clean around
    MT-D25. MT-D25 is titled “One dependency recipe record” and says Draw,
    Civil, Raster, and BIM cite the same state machine while rejecting multiple
    domain-specific dependency machines (`mesh-terrain.md:1141-1154`). Civil
    then says every accepted Civil derivative has exactly one
    `hcad.civil.derived-recipe@1` and a materialized surface additionally uses
    MT-D25 (`civil.md:976-1009`). Draw says it owns a curve recipe while citing
    the “common recipe contract” (`draw.md:1120-1125`); BIM and Raster similarly
    expose domain recipe commands while calling MT-D25 the single machine
    (`bim-specs.md:1640-1646`; `raster.md:837-842`). This can be read as either
    one physical record, one lifecycle protocol, or two co-authoritative recipes
    for one output. The registry has not decided which, so the batch still has a
    contradictory guarantee even though the target claims cross-spec consumers
    are reconciled.

    **Proposed resolution:** Derived from P10, X1/X3/X7, and the cite-and-revise
    rule: change MT-D25 from “one record for all domains” to one shared,
    versioned **derived-recipe lifecycle protocol**. Every derived output has
    exactly one owning recipe envelope with a typed domain payload and the common
    linked/stale/regenerate/detach/auto-detach/error/DAG behavior. A Civil
    corridor recipe owns the Civil result; a separately published Mesh surface
    is a second output with one Mesh recipe that references the upstream Civil
    recipe id/generation—never a second recipe for the same output. Commands stay
    with the output owner. Amend Draw/BIM/Raster/Civil wording and registry rows
    to that exact model before certifying the batch. This resolves the ambiguity
    without changing UIP-D19–D22's ownership.

12. **Severity: major. Contract question: E1 / E2.**

    **Objection:** G11 says every tool declares its cursor subset, but the batch
    does not prove that universal claim. Only Draw, Select/Edit,
    Measure/Inspect, and View Domain provide explicit declarations in their new
    sections. Pointcloud consumes the 3D target without declaring the cursor
    states (`pointcloud.md:1143-1149`); Raster, Mesh/Terrain, BIM, Import, Agent,
    Plan, File/Attach, and Viewing Box do not supply a complete UIP-D22 mapping or
    explicit inapplicability. The registry has a gesture table but no cursor
    declaration table. UIP-D22 also omits cursor precedence: prohibited versus
    snap marker, handle glyph versus 3D target, and wait versus an otherwise
    navigable viewport. Screenshots of each glyph cannot prove that the correct
    glyph appears in the correct state.

    **Proposed resolution:** Derived from G11, E1/E2, X7, and the registry
    single-owner rule: add a registry cursor matrix with one row per armed tool
    and surface, including explicit n/a entries. Define platform precedence:
    prohibited on an invalid claimed input; handle glyph on a hittable active
    handle; 3D target while its placement mode is armed; pick crosshair plus at
    most one snap-kind marker/Fangkreis on a valid candidate; bounded-work wait
    only over the blocked surface and never over still-available navigation.
    Define cursor invalidation on camera motion, tool cancel, state/filter
    changes, device loss, and stale candidates. Require every touched spec to
    cite that row rather than merely mention UIP-D22.

13. **Severity: minor. Contract question: B1 / E1.**

    **Objection:** “Always visible” quietly becomes “may disappear into one
    explicit overflow.” The target says every S3 control is present in the strip
    (`ui-platform.md:1103-1108`) but its E1 failure condition permits controls to
    disappear behind overflow (`:1177-1183`). At 150% scale on the minimum-width
    window I may lose the only visible indication that Segments, a kind filter,
    or Support suppression is active. That is a dangerous hidden mode, not just
    compact chrome.

    **Proposed resolution:** Keep the strip itself and every active non-default
    mode visibly summarized at all widths. At the compact breakpoint, collapse
    labels to tokenized icons/chips and use one overflow for inactive/default
    controls; the overflow trigger carries badges for every hidden non-default
    state and an accessible summary. Mode-changing items remain keyboard
    reachable and expose a tooltip/label. Add minimum-width and 150% screenshots
    for default and all-non-default states. Breakpoint values remain X6 tunables.

14. **Severity: minor. Contract question: A3 (code-evidence rule).**

    **Objection:** Several inherited code citations no longer prove the semantics
    that the batch relies on. The target cites `Select.tsx:113` for hardcoded
    `zIndex: 10050` (`ui-platform.md:353-356,750-757`), but the value is at
    `packages/@himmelcad/ui/src/Select.tsx:100-110`; line 113 begins an effect.
    It cites `EntityTree.tsx:178-186` for Ctrl+A selecting visible siblings, but
    the actual membership collection/application is at `:183-190`. It cites
    `EntityTree.tsx:197-212` for replace/Ctrl-toggle/Shift-range semantics, while
    the replace/toggle dispatch is at `:221-223`. Most importantly for the new
    candidate rule, `WgpuKernelViewer.ts:3149-3152` is only a comment promising
    stable “Tab order”; the actual sort/dedup behavior is in
    `crates/himmelcad-render/src/picking.rs:398-434`. The claims are mostly true,
    but the cited lines are not the evidence, and the Tab wording is now stale.

    **Proposed resolution:** Replace each citation with the executing lines and
    cite declarations/comments only as interface intent. Point stable candidate
    ordering to the Rust sort/dedup plus the TypeScript consumption path; rename
    comments to gesture-neutral candidate order. Refresh all target citations
    after the batch edit and treat any stub/deprecated surface as absent. No
    other batch-adjacent cited code location inspected was a stub.

## Contract questions answered convincingly

**B3** is answered convincingly: a persistent bottom strip for global state, a
left taxonomy control for hierarchy state, and shared platform components with
domain-owned commands are the right surface boundaries. The shared-reticle
choice itself is also directionally correct, but its C1/B2/E2 contract is not
complete enough to count those questions as answered.

## Executed vs. read

**Executed:** no build, application, dev server, test, benchmark, or browser was
run, per the static-review instruction. I executed only non-mutating repository
searches and line reads, including registry/citation searches, source-file
existence checks, and a check for named UI/reticle/cursor benchmark artifacts.
No web research was performed; the current corrected in-repository dossiers
were the authoritative evidence needed for the scoped precedent checks.

**Read:** `.claude/agents/demanding-user.md`; `docs/CURRENT-DIRECTION.md`,
`docs/README.md`, the complete CURRENT `docs/FUNCTION-CONTRACT.md`, the complete
CURRENT `docs/DECISION-DOCTRINE.md` including X1–X7 and P1–P10,
`docs/DESIGN-SYSTEM.md`, `docs/AGENT-FEEDBACK.md` SYSTEM-001, and
`docs/TEST-TIERS.md`; Builder-program `README.md`, `OWNER-DECISIONS.md`, the
complete `REGISTRY.md`, `OWNER-STATEMENTS-2026-09-02.md`, and the GAP file; the
complete target; the viewing-box gold-standard spec; the complete prior UI
Platform and Select/Edit demanding-user reviews; the complete corrected Trimble
Perspective/Access and RealWorks dossiers and Revit's cited W3/source sections;
the relevant batch-2 amendments in all touched sibling specs, with focused full
reads of UIP-D19–D22, SE-D19/20, VD-D14/15, FP-D21/22, MT-D25–D27, Civil
CIV-D15, and the Tab/cursor claimants; and every source location cited by the
target, following semantics beyond a named handler where needed. The older A2
claims about Perspective fixed UI areas, touch selection/context behavior,
absence of a documented job list, and Revit mixed-property editing are supported
by their cited dossier text; findings 6 and 14 cover the failed batch evidence
and code-citation cases.

## Owner-decision items

**None — count 0.** The escalation protocol dissolves every candidate. Surface
and state ownership follows X3/X7 plus the registry; Tab and reticle arbitration
follow C1/E2/X1; history scope follows P8/C4/P5; Access deviations follow X4 plus
the explicit owner-taste rule already in DESIGN-SYSTEM; token values and budgets
are X6/P3 calibrations; consumer and failure rules follow SYSTEM-001/P4; and the
recipe correction follows P10/X7. None presents an axiom conflict,
product-identity/scope/money/licensing decision, or owner-reserved boundary. All
resolutions above are derived, visible, and vetoable—not questions.

## System feedback

The contract questions did their job: catalog, A2, C1, C4, D1, E1, and E2 each
exposed a concrete failure that prose-level “Applied” claims had hidden. No
X1–X7 axiom failed. Doctrine precedent **P9 did fail to close its class cleanly**:
its derivation compresses Access's actual Selectable/Visible/Off behavior into a
four-state claim, treats “snappable” as universal rather than capability-bound,
and says nothing about orthogonal overlays or precedence. Per doctrine rule 2,
P9 should be corrected at the source to the permission-ceiling/capability-
intersection model in finding 4. P8 and P10 are adequate; their consumers failed
to provide restore scope and to distinguish one shared lifecycle protocol from
one physical recipe record.
