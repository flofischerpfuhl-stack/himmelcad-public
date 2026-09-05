# Demanding-user review — View domain spec (2026-09-02)

Document class: report/verification evidence. Static review against the
CURRENT contract (incl. A2 silence rule) and doctrine (incl. P4); every
checked file:line claim verified. Best-cited catalog so far. Findings:

1. **Blocker — E2/A3/C4 (registry-level). Color mode and point size are
   double-owned:** pointcloud spec = per-entity journaled canonical style
   (removes `view.color-mode` ribbon button, × multiplier for size); this
   spec revives both as global un-journaled presentation. Bookmarks §2.2
   only work under the view model. _Resolution:_ two-layer model per
   revit.md §2.5/§2.6 (object styles below, per-view overrides above): one
   shared decision record cited by both specs — pointcloud keeps canonical
   per-entity display; View's Color mode becomes a view-level override with
   "Follow entity display" default, un-journaled, bookmark-captured. Point
   size: adopt pointcloud's model; decide bookmark capture of the
   multiplier explicitly (recommend no).
2. **Blocker — D1/E3. Migrating gates onto `view.diagnostics.sample`
   silently changes the metric:** FrameTelemetry measures render cost
   (cpu/gpu/effective), not presentation cadence — React drag-sync jank
   invisible; overlay-state sampling and input driving cannot migrate.
   _Resolution:_ add a presented-frame-interval distribution to the
   telemetry window; D1 gates run on interval p95; only measurement
   migrates to `sample`; revise VB-D7 in viewing-box.md itself (doctrine
   rule 2), not by implication.
3. **Major — A2. Two absence claims refuted by the repo's own dossiers:**
   revit.md §2.6 documents view filters/templates; realworks.md §2.6
   documents saved camera view stations. _Resolution:_ re-ground bookmarks
   and presentation on them; extend dossiers where absence is claimed.
4. **Major — VD-D1/C3. `clip.clear`/bookmark restore vs a LOCKED box:**
   deactivation must preserve lock state and the revision-keyed cache;
   re-activation with a stale key runs the VB §1.3 auto-rebake (long-
   running, not "<1 s" — extreme-member rule); reclassify bookmark restore
   accordingly.
5. **Major — E2. Still cites VB-D13's picking-only phrasing; P4 extends to
   destructive applies** (fence delete with an active section must not eat
   hidden storeys). Re-cite P4; add the §7 test.
6. **Major — B1/C4. ViewState v2 unspecified and VD-D3's "protocol already
   carries" is false three ways:** scopedClips are value-typed (the
   automation channel is a live third clip channel), ViewPresentation has
   no color mode/point size, `transparent` background is protocol-valid but
   spec-forbidden interactively. _Resolution:_ specify v2 — entity-
   referenced clips (value-clips materialize as canonical sections),
   presentation gains the finding-1 fields, drop interactive transparent;
   list the schema bump + SDK changes in §6.
7. **Major — A3/X7. PhotoLab ships the identical presentation assert**
   (apps/photolab/renderer/src/App.tsx:4076-4085); record the class
   disposition (adopt typed model with its subset, or reasoned deferral).
8. **Major — E2 gesture arbitration. HUD-Escape is an unregistered Escape
   claimant; section-placement arm has no gesture table.** _Resolution:_
   HUD closes from toggle/chip only (no Escape); section placement =
   one-shot LMB capture, RMB per UIP-D5, Escape at the tool rung.
9. **Major — C4/E2. Bookmark "display state" boundary untested against its
   class:** per-entity opacity/class visibility excluded without a
   decision; hiddenEntityIds today merges canonical + automation-local
   hides — restore must not promote view-local hides into canonical edits.
   _Resolution:_ record the capture boundary (view layer only: camera,
   presentation incl. overrides, canonical-visibility snapshot, clip
   references); deleted hidden referents degrade like deleted clips.
10. **Minor — A2 dispositions missing for RealWorks View rows**
    (Walkthrough/Fly-to, cloud transparency, display shortcuts, station
    markers); the walk/fly absence claim is false vs realworks.md §2.10.
11. **Minor — E1 criteria mapping:** sections inherit criterion 3 (grip
    stability under drag), not criterion 6 (locked state, which sections
    lack).
12. **Minor — B1.** "Section here" = Horizontal at picked elevation
    (family switchable in the panel); state quick-surface rows agreeing
    with UIP-D13; disable the projection toggle in 2D with explanation.
13. **Minor — E2/D2.** HUD idle state ("0 FPS" reads as a hang);
    `sample` accumulates privately and returns frames:0 cleanly — never a
    hidden write to the HUD's window.
14. **Minor — VD-D6.** `showSelectionOutline` needs a home in the typed
    model (keep automation-only, default true, recorded — or drop in v2).
15. **Idea — bookmark thumbnails** (realworks.md §2.6 precedent; screenshot
    pipeline exists).
16. **Idea — "Copy diagnostics" button on the HUD.**

Answered convincingly: A1, B2/B3, C1, C2, VD-D2 (correct C3 rejection),
VD-D4/D5 journal split (modulo finding 1), VD-D7, VD-D9, VD-D11 (genuine
sequencing discipline), D2, §7 structure, §8 dissolution form.

Owner-decision items: **none** (both candidates dissolved: two-layer model
derivable from X4 + revit.md; sibling-metric revision closed by doctrine
rule 2).

System feedback (applied 2026-09-02): A2 absence checks are dossier-wide;
registry rows are written at specification time and cross-spec capability
claims must cite and revise the other spec's decision record; doctrine/
contract changes invalidate un-rechecked "specified" status.
