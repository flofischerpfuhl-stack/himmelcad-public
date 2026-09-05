# Demanding-user review — Draw domain spec (2026-09-01)

Document class: report/verification evidence. Static review; kernel/core
citations verified (snap_rank picking.rs:492-500, layer_ids Vec
entity_model.rs:1216, Clothoid entity_model.rs:302, DgmSnapProvider stub).
Strongest catalog+workflow spec so far (DR-D1/D2/D9 exemplary), but the core
scenario — drafting over a point cloud — breaks as written. Findings:

1. **Blocker — C2/DR-D2. Over a cloud, the cloud wins every snap.** Kernel
   ranks by snap kind before pixel distance; cloud points are
   `SnapKind::Point` (rank 0) and beat Vertex/Midpoint/Edge unconditionally
   — closing a polygon or dimensioning drafted vertices is impossible over
   a scan. _Resolution:_ per-source snap enables (cloud/DGM/authored) with
   mode defaults; authored-geometry snaps outrank cloud samples at equal
   radius in drafting tools; one-shot hold-key kind override; add
   "snap to own linework over dense cloud" to browser tests and the D1
   benchmark (which never asserts which candidate wins).
2. **Blocker — evidence rule. §3.3's terrain snapping cites
   `DgmSnapProvider` — a documented STUB in the legacy package the spec
   itself retires.** _Resolution:_ specify a NEW kernel DGM/terrain snap
   producer (ray intersection in the ranked pipeline), add to §6 New and §7;
   cite the stub as design evidence only.
3. **Major — B2/§3.1 contradiction: Escape mid-polyline commit or discard?**
   _Resolution:_ commit-on-end for ≥2 vertices on all three end paths
   (Enter, Escape tool rung, ribbon toggle); Ctrl+Z removes the whole
   polyline; rewrite B2's sentence; fix the §7 assertion.
4. **Major — C1/DR-D6. Tab is triple-booked (candidate cycling, input-bar
   focus, field traversal).** _Resolution:_ digit-typing auto-focuses the
   input bar (dynamic-input pattern); Tab stays candidate cycling in
   viewport, field traversal in the bar; specify the focus model in DR-D1.
5. **Major — E2 vs ui-platform. No arbitration between armed-tool clicks and
   platform select/context gestures.** _Resolution:_ armed tool captures
   LMB and RMB (no selection changes); RMB mid-construction opens a tool
   menu (Finish/Close/Undo vertex/Cancel) — also the discoverable finish
   path; decision record referencing UIP-D1/D5.
6. **Major — DR-D8/X5. The catalog cannot draft rib-civil W3** (no
   tangent-from-point, pivoted/buffered arcs, no clothoid tool — while
   `hcad.curve@1` has Clothoid and LandXML imports spirals: author/import
   asymmetry). _Resolution:_ add coupled/pivoted/buffered line-arc
   constructions + clothoid connector (DR-D6 provides solution cycling), or
   honestly re-scope DR-D8. Recommend adding.
7. **Major — catalog/A3. No post-commit editing story anywhere** (vertex
   grips, text content, dimension placement), and the §1 boundary points at
   a shared-edit spec that does not exist. _Resolution:_ add
   `draw.edit-vertices` grips + text double-click edit + dimension drag;
   name and register the owning spec for whole-entity transforms.
8. **Major — DR-D3/ADR 0022. Height gaps are silent and nothing can assign
   missing heights.** _Resolution:_ Z field always shows the pending
   vertex's acquisition ("Z: —" state, distinct marker); "require height"
   tool option; new `draw.assignHeights` (drape on DGM/cloud, typed/
   interpolated) closing the ADR 0022 admission loop; over-hole browser
   test.
9. **Major — DR-D4. `layer_ids` is a Vec; the layer chapter assumes a
   scalar.** _Resolution:_ decide: exactly-one-layer semantics for Draw
   ("assign" replaces, empty = Default), Vec reserved for future overlays;
   invariant tests; specify the Default layer's basics.
10. **Major — E2/X3. Commit-target layer races automation
    (`layers.setCurrent` mid-trace).** _Resolution:_ tool captures target
    layer at start (shown in tool options, changeable only there);
    `draw.*.create` takes an explicit optional `layer` parameter; race
    test.
11. **Major — A2. Maßketten (dimension chains) silently missing.**
    _Resolution:_ chain mode on `draw.dimension` (one journaled command,
    per-point anchors) or recorded deferral. Recommend adding.
12. **Major — A2. No drafting-time styling story (rib-civil W2's F9 half
    dropped).** _Resolution:_ style-by-layer default + per-entity D3
    specification override in tool options; consumption contract lives
    here (DR-D7 split applied to line/point/text specs).
13. **Major — E2. Viewing box missing from the consumer table: drafting
    snaps must be clip-aware, and locked-bake snapping conflicts with the
    full-precision promise.** _Resolution:_ active box excludes clipped
    geometry from candidates; locked box resolves cloud snaps against
    full-precision source points within the box (X2); benchmark + browser
    test variants.
14. **Minor — C3 citation overreach:** HV pattern says "visible but
    untouchable", not snappable — keep behavior, fix derivation.
15. **Minor — C4/DR-D10.** Current layer: journaling derivation is wrong
    (UIP-D3 proves agent-visibility ≠ journaling) and undo flipping the
    current layer is a trap. _Resolution:_ persisted + automation-writable,
    excluded from the undo chain; fix DR-D4 derivation.
16. **Minor — C1. No angle convention: project settings gain angle unit
    (gon/degrees) and direction reference (north azimuth); gon default for
    the target market (X6).**
17. **Minor — A2. Arc-in-polyline: tangential continuation as default when
    a previous segment exists; 3-point as alternative.**
18. **Minor — E1. Input bar (the most novel surface) needs a layout/focus
    criteria block; every tool names its step prompts.**
19. **Idea — auto-layer-per-Achse ("Achse <name>") on
    `alignment.createFromCurve` (rib-civil §2.3).**
20. **Idea — Hilfspunkte (export-excluded helper points) and
    station+offset points, queued with the alignment subsystem.**

Answered convincingly: A1, A3, B1, B3, C1/DR-D1, C4/DR-D5, D1 (runnable
calibrated gate), DR-D9 (X1-over-X4 exemplary), DR-D2, E3/§7, §8
dissolutions.

Owner-decision items: **none** — all findings resolve from
X1/X2/X3/X4/X5/X6, the E2 rules, UIP precedents, and ADR 0022.

System feedback (applied to contract 2026-09-01): code-claim drift rule
(file:line, stubs count as not existing); input-gesture arbitration rule in
E2; per-dossier-row catalog disposition rule in A2.
