# Demanding-user review — Pointcloud domain spec (2026-09-01)

Document class: report/verification evidence. Static review; ~28 file:line
code citations verified accurate (most honest §5 delta in the repo); 11 of 12
realworks.md citations hold. Findings, most severe first:

1. **Blocker — E2/C2 (X1, now doctrine P4). Fence applies act on points the
   user cannot see** — the world-space prism punches through the active
   viewing box and hidden classes, silently deleting in clipped-away storeys
   and blanked-out classes. _Resolution:_ effective apply set = fence volume
   ∩ active clip volume ∩ visible classes (occlusion included); journaled
   command captures the effective scope as world-space arguments (camera-
   free replay). Real-data test: delete with keep-inside box touches zero
   outside-box points.
2. **Blocker — PC-D5/C4 (X1). The stored prism is not what the user fenced
   in a perspective view** (drawn shape = polygonal frustum with apex at the
   eye; tint and apply disagree with depth). _Resolution:_ store the volume
   matching the projection — prism for ortho, frustum (apex + polygon /
   plane set) for perspective; both camera-free once computed. Rust
   round-trip test: tint membership == apply membership under perspective.
3. **Major — A2 evidence rule. "RealWorks merges implicitly in registration
   groups" is invented over a dossier gap and wrong** (explicit merge,
   Ctrl+M in Trimble's shortcut list). _Resolution:_ extend realworks.md
   with the merge evidence first (doctrine rule 2), then restate A2:
   explicit merge adopted; keep-sources deviation reasoned from X1;
   recommend Ctrl+M to the registry.
4. **Major — A1/D1. The fence tool's gesture map does not exist** (LMB
   lasso vs LMB orbit; polygon clicks vs click-select; open fence vertices
   are screen coordinates — what happens on zoom mid-fence?). _Resolution:_
   armed fence: LMB draws, MMB+wheel navigate, RMB pans; navigation with an
   OPEN fence is rejected with a status-line explanation (v1); log the
   reference's mid-fence behavior as a dossier gap.
5. **Major — A2/X4 (PC-D11). Display-mode reference posture misread**
   (Perspective color/size are view-level, not per-cloud) **and the
   scene-wide recolor workflow lost** (23-cloud project → "everything to
   intensity" becomes select-23-then-edit). _Resolution:_ fix the
   derivation, state the per-entity choice as an X3/P1 deviation, make the
   scene-wide path first-class: Ctrl+A-visible + one Mixed edit = one
   journaled command; optional View-tab accelerator issuing exactly that
   command.
6. **Major — C2. §2.1 and §3.1 contradict on selection change mid-tool.**
   _Resolution:_ bind the target at fence-close ("Applies to: 3 clouds" in
   the panel); selection changes affect only the next fence.
7. **Major — E2/D1 (PC-D1). Mask/compaction lifecycle gaps:** (a) freshly
   streamed tiles must be masked too, not just resident nodes; (b) 15
   applies in 10 minutes: coalesce — compaction targets newest revision,
   superseded jobs dropped, queue depth ≤1/entity; (c) Ctrl+Z at 60% bake:
   undo cancels/supersedes in-flight compaction, nothing partial published
   (test); (d) locked viewing boxes must rebake on settled revisions with
   debouncing, not twice per apply (note against VB-D3).
8. **Major — B2/C4 (PC-D6). Classes island has no lifecycle; class
   visibility has no state class.** _Resolution:_ island B2 per VB-D14
   class; class visibility is canonical journaled state (X3/P1 + journaled
   box-activation precedent); own row in both E2 tables; exports include
   class-hidden points and the dialog says so.
9. **Major — D1/E3 (PC-D14). Gates have thresholds but no names/scripts;
   parity baselines lack a recipe.** _Resolution:_ gate ids G-PC-A…E with
   script names; parity script crops the source LAS to the surviving region
   offline and imports the crop natively; same scripted orbit for both.
10. **Minor — C1/B1 (PC-D11).** Define "Auto" point size + reset affordance;
    relabel console/ribbon control as unitless × multiplier (1.0 default);
    automation renders at ×1.0 unless their view state sets it.
11. **Minor — C1.** "Rectangle fences accept typed extents": define as world
    units on the view plane anchored at the first corner, or drop the claim
    with reason.
12. **Minor — C4/B2.** Closed-but-unapplied fence: Ctrl+Z removes the
    closing edge and resumes per-vertex undo; Escape discards it.
13. **Minor — A2/E3.** render_world.rs:59 documents the absent-attribute
    fallback for PointIntensity, not PointClassification — verify the
    shader path, test classification-absent fallback, cite the right line.
14. **Minor — registry.** Viewing-box extract button is shipped here but
    queued in VB-D11 — un-queue it there (one-line wiring onto
    `pointcloud.extract`). Also: the fence overlay "reuses" select.box/
    lasso overlays that do not exist — state the fence BUILDS the shared
    overlay and selection tools adopt it.
15. **Minor — B1/E2.** No disabled Analyze buttons (group absent until the
    follow-up spec); extract/sample over zero points fails with explanation;
    merge of whole clouds keeps the union of station links (unlike extract —
    one distinguishing sentence).
16. **Idea — fence panel shows the active scope ("Scoped to: Stairwell B")
    with a jump to the box panel.**

Answered convincingly: A1 (modulo 4/6), A3, B3, C3 (lock lesson fully
internalized), C4/PC-D1 (mask-delta undo), D2, PC-D3, PC-D6 sidecar fix at
source, PC-D7, PC-D12 multiselect (verified against revit.md), PC-D13,
line-accurate §5.

Owner-decision items: **none** (class-visibility candidate dissolved via
X3 + journaled-activation precedent).

System feedback (applied 2026-09-01): A2 silence rule (no dossier line item
= unresearched, even for absence claims); VB-D13 generalized to doctrine
precedent P4 ("anything that acts on geometry acts on the visible set").
