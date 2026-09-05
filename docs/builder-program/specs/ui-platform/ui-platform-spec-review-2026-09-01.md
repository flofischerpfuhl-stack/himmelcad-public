# Demanding-user review — UI platform domain specification (2026-09-01)

Document class: report/verification evidence. Static review; ~20 cited
source locations spot-verified against code; no builds or app runs.

Overall: second-best spec after the revised viewing box; evidence discipline
largely holds, §5 status column verified honest, §7 criteria genuinely
failable, §8 dissolutions written out. Findings, most severe first:

1. **Blocker — C2/E2/E1. Selection model undefined for the entity that fills
   the screen: the point cloud.** Micro-orbit landing on cloud points
   replaces a built selection with the whole scan; hover restyles a
   500M-point entity; accent treatment on points undefined; dossier §2.5
   leans away from bare-cloud click-select. _Resolution:_ decision record —
   cloud/splat entities are not click-selectable/hoverable in the viewport
   by default (clicks on bare points behave like void); selection via tree
   and RMB targeting; cloud selection treatment = bounding-box accent
   outline. G-UIP-1 must run its burst over a scene whose hovered entity is
   a giant cloud.
2. **Major — B2/A3. Escape ladder closes Agent/Specs/Plan islands on the way
   to deselect.** _Resolution:_ only detached function islands are Escape
   rungs; persistent workspace islands close only via x/toggle. "Active
   function panel closes" = active tab; Properties is never an Escape rung.
3. **Major — B3/doctrine rule 1. Detach collides with DESIGN-SYSTEM "tool
   parameters stay docked…" and the spec is silent.** _Resolution:_ amend the
   design-system sentence ("default docked; user-initiated detach permitted
   and remembered"), cite it, and add: a function's viewport interactions
   behave identically docked or detached.
4. **Major — E2/SYSTEM-001. Job registry in the renderer; jobs live in the
   main-spawned sidecar — a renderer reload orphans every running job.**
   _Resolution:_ registry of record in the main process, renderer mirrors
   and rehydrates on mount; browser test: reload mid-import → chip and
   cancel reappear. (Second consecutive lifecycle-ownership finding —
   SYSTEM-001 promote threshold is one recurrence away.)
5. **Major — C2. Multi-select mixed-property behavior unanswered on the
   spec's own Properties surface.** _Resolution:_ type-shared property set,
   mixed-value indication, count in header (X4 Revit); component test.
6. **Major — E2. Selection set after delete/hide/project-replace
   unspecified.** _Resolution:_ prune on journal apply (incl. automation and
   undo/redo replay); hidden stays selected; project replacement clears.
7. **Major — A2/X4. Click-again-deselect ports a touch gesture to desktop
   against every desktop reference; also forecloses double-click.**
   _Resolution:_ desktop pointer: clicking a selected sole entity keeps it;
   tap-again-deselect stays for touch. Record as stated X4 deviation.
8. **Major — B1/discoverability. Tab-cycling ambiguous picks has zero
   visible UI.** _Resolution:_ status bar "1 of 3 under cursor — Tab
   cycles" while candidate set is live; optional context-menu candidate
   list.
9. **Major — B2/X1. Global "focused input reverts" Escape rung deletes
   half-written agent prompts/console input.** _Resolution:_ scope the rung
   to commit/revert fields; free-text surfaces never discard content on
   Escape.
10. **Minor — A2 citation integrity:** "single-surface tablet UI" and
    "single-task field software" overreach dossier §2.1/W1 — reword to what
    the dossier supports (fixed panels, no documented job list).
11. **Minor — catalog. Paste-in-place references a clipboard capability no
    spec owns.** Add a registry row or cut with queue note.
12. **Minor — cross-spec. §3.5 claims the viewing-box bake registers as a
    job when backgrounded; viewing-box §1.3/B2 defines no backgrounding.**
    _Resolution:_ amend viewing-box §1.3/B2 (bake continues on panel close,
    registers as job, chip shows it).
13. **Minor — A1. Birth state of imports 2 and 3 in the "3 jobs" narrative
    unspecified.** _Resolution:_ unanswered imports register immediately as
    needs-input jobs; island advances to the next needs-input job.
14. **Minor — B1/X3. Detach/re-dock absent from automation with a
    non-covering justification.** _Resolution:_ add ui.panel.detach /
    ui.island.redock commands (wrap existing state).
15. **Minor — E1. Extend criteria 2/5/6 to both themes; add docked-vs-
    detached screenshot-diff criterion.**
16. **Idea — jobs island "apply to similar" affordance for 40-file import
    days; queue to file-project spec.**

Answered convincingly: B2 (closes historical correction #4 class), C1
(NumberInput/Slider pairing as invariant), C3, C4 (UIP-D9 best-derived
record), D1/D2 (named runnable gates), UIP-D6 command registry as anti-drift
structure, §3.5 sidecar mapping (modulo finding 4), verified-honest §5, E1
criteria character.

Owner-decision items: **none** — four candidates dissolved in writing
(cloud selectability, click-again, Escape scope, registry ownership).

System feedback (now applied to the contract 2026-09-01): "extreme member of
the class" rule added to E2. Lifecycle-ownership recurrence count: 2.
