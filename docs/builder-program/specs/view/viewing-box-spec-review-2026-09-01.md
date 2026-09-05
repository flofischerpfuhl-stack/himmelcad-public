# Demanding-user review — viewing box workflow specification (2026-09-01)

Document class: report/verification evidence. Static review of
`docs/builder-program/specs/view/viewing-box.md` against the function
contract, decision doctrine, design system, SYSTEM-001, the prior
implementation review, owner decisions D1–D5, all four dossiers (written
_after_ the spec — see findings 2 and 4), and viewer/kernel sources.

Overall: best-structured spec in the repo so far; the §4 disposition table is
honest. But the spec was written before its own evidence base existed: two of
four A2 reference claims and one decision-record premise are contradicted by
the dossiers, the visual reference points at screenshots nobody captured, and
driving the workflow as a RealWorks user surfaced two correctness holes in
the lock design.

## Findings

1. **Blocker — C3/E2 (X1). Lock as specified un-clips every non-point entity.**
   §1.3/VB-D3 drop the six clip planes on lock, but the clip volume is shared
   by points, splats, rasters, CAD, and mesh passes
   (`WgpuKernelViewer.ts:474`). The bake replaces only points: lock a
   stairwell in a scan+BIM project and the whole building model pops back.
   _Resolution:_ drop planes only for passes whose data the bake replaces;
   all other passes keep them (cheap — plane cost was only significant
   against the massive cloud). VB-D8's parity scene must contain a
   cloud+mesh mix so regressions fail the gate.
2. **Blocker — E1. Visual reference is a dangling pointer** (re-commits
   historical correction #2): cites screenshots in a "view-domain dossier"
   that does not exist; dossiers are text-only.
   _Resolution:_ commit the reference artifact before implementation
   (mockup or concrete written comparison criteria: handle prominence,
   in/out restyle legibility, grip stability under drag — cf. RealWorks
   v12.4 "jumping grips" regression, realworks.md [18]).
3. **Major — C2/A2. Spec never says whether tools see through the clip.**
   Nothing in picking is clip-aware today: measure inside the box and snap
   to an invisible point on the far side of a clipped wall — a wrong number
   in a survey deliverable. _Resolution:_ while a box is active, picking,
   snapping, selection, and measurement exclude clipped points (locked: they
   run against the bake). Browser interaction test: pick through a clipped
   region must not return an outside point.
4. **Major — A2/VB-D9, auditability. Three reference claims contradicted or
   unsupported by the repo's own dossiers.** (a) VB-D9's "no reference binds
   a default limit-box key" is false — RealWorks binds **F4**
   (realworks.md, W3). (b) "RealWorks: Limit Box with in/out modes" —
   in/out-keep belongs to the segmentation tool; the Limit Box has only a
   show/hide-outside toggle. (c) "RIB Civil: clip volumes are
   typed-coordinate-first" — the dossier documents no clip volumes; the true
   support is the F5-Box norm "every mouse construction has a numeric twin"
   (rib-civil.md). _Resolution:_ re-ground A2 on dossier line items;
   re-derive VB-D4 from X5 + segmentation precedent; reopen VB-D9 with F4 as
   the registry-level recommendation (X4; no owner needed).
5. **Major — C1/B2. Escape while typing is missing from the ladder; blur
   commits an abandoned half-typed value** (panel close blurs the field and
   moves the box). _Resolution:_ new rung — Escape in a focused input
   reverts and keeps the panel open; closing mid-edit discards, never
   commits. Panel component tests.
6. **Major — A1/B1. The second box has no birth path; the ribbon button is
   double-booked** (placement starter in §1.1 vs panel toggle in §1.6).
   _Resolution:_ ribbon button is strictly a panel toggle; "New box" in the
   panel and the quick-surface entry start placement; zero boxes auto-starts
   placement.
7. **Major — C3/E2 (X1). Bake invalidation keys only on box geometry.**
   Segment-delete inside the box, import, or transform leaves stale baked
   points. _Resolution:_ key on (box geometry, operation, source dataset
   revision); source change while locked auto-rebakes with the §1.3 progress
   state. Command-layer test.
8. **Major — C3 (X2). Lock × Remove-inside bakes ~99% of the cloud for no
   payoff.** _Resolution:_ when the kept-region estimate exceeds a tunable
   fraction of resident points (X6; start 50%), lock degrades to edit-freeze
   with planes retained, with explaining copy. Decision record, threshold
   tunable.
9. **Minor — B2.** §1.1 and §1.6 contradict on Escape during placement; the
   ladder (§1.6) is canonical — Escape cancels placement only, second Escape
   closes. Fix §1.1.
10. **Minor — D1.** Plain orbit with an active _unlocked_ box has no named
    gate. _Resolution:_ add an orbit-with-unlocked-box burst to the VB-D7
    script, same p95 threshold.
11. **Minor — B1.** Quick-surface "Place viewing box here" triggers over
    empty space where the picked point resolves to nothing. _Resolution:_
    over geometry use the picked point; over void seed centered on the
    current view (Perspective precedent, trimble-perspective.md §2.3).
12. **Minor — A2/X4.** RealWorks stores _and shares_ limit boxes (box files
    for the free viewer, realworks.md [87]); spec is silent. _Resolution:_
    record: boxes travel inside `.hcadx` now (D1); standalone box
    export/import queues with VB-D11.
13. **Minor — copy.** The status chip says "Box" though the box has a name
    and lock state. _Resolution:_ chip = box name (truncated) + lock glyph;
    operation in tooltip.
14. **Idea — catalog.** Trimble Access storey-slicing and reference-azimuth
    alignment (trimble-perspective.md §2.4/§5) missing even from the
    deferred list — add to the VB-D11 queue.
15. **Idea — C3/X2.** Bake could _densify_: RealWorks Limit Box Extraction
    pulls fresh full-density points from raw scans for the boxed region
    (realworks.md [88]). Optional refine-beyond-display-density bake would
    beat the reference. Queue with VB-D11.

## Answered convincingly

A1 (drivable narrative), A3 (sibling mapping incl. `VectorEditor`
share-back), B3, C1 (modulo finding 5), C2 (modulo finding 3), C4/VB-D1/VB-D2
(canonical-from-placement dissolves three prior blockers), D2, E2's
automation-cancels-drag and no-partial-bake rules, §6's zero owner items with
written dissolutions. VB-D7/VB-D8 are well-calibrated and agent-runnable.

## Executed vs. read

Executed: greps/listings across kernel sources (clip-pass sharing,
`removeInside`, hardcoded scope), TEST-TIERS capability names, dossier
searches; two pre-dossier web searches (superseded and confirmed by the
dossiers). Read: spec, both prior reviews, contract, doctrine, design system,
AGENT-FEEDBACK, CURRENT-DIRECTION, program README, all four dossiers. Not
executed: builds, dev app, benchmarks — performance claims assessed on paper.

## Owner-decision items

**None.** All findings resolve from X1/X2/X4/X5/X6, doctrine rule 2, or the
design system's complete-flows section.

## System feedback (planning-system pilot)

Contract questions were right but under-answered by the author (findings 1,
3, 5, 7, 8 landed inside C3/C2/B2/E2). Four system gaps, now fixed in the
normative documents (2026-09-01): A2 citation-integrity +
evidence-precedes-specification; E1 reference-artifact-must-exist; E2
consumer enumeration (passive readers); DESIGN-SYSTEM Escape-in-text-input
rule. No doctrine axiom failed; the exposed failure mode was sequencing —
specification before evidence.
