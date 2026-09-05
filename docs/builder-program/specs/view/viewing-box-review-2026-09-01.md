# Demanding-user review — viewing box implementation (2026-09-01)

Document class: report/verification evidence (static code review, nothing
executed). Input for the viewing-box workflow specification.

## Status of the six historical owner corrections

1. Drag frame-budget gate: partially resolved — benchmark script exists
   (`scripts/benchmark-builder-viewing-box.mjs`) but is wired into no verify
   tier or CI, requires a hand-started dev app, and covers face-resize only.
2. Visual reference: unresolved as process — no spec, no named reference, no
   screenshot comparison exists.
3. Lock ⇒ frozen clip ⇒ speedup: not implemented; the only toggle disables
   clipping (the opposite trade).
4. Open/close symmetry: mostly resolved (ribbon toggles, panel tab), but no
   explicit close affordance on the panel and no Escape behavior.
5. Numeric parity: partial and partly dead — the Center editor renders only
   in mode `'move'`, which no UI path can ever set; rotation has only ±15°
   buttons, no typed or displayed angle.
6. Named/saved boxes: not implemented; box state is one React `useState`,
   lost on reload; "Remove box" is one-click destructive with no undo.

## Findings beyond the six

- **Blocker (C3):** no lock; every frame evaluates six clip planes against
  the full dataset even when the box is final.
- **Blocker (C4):** no persistence/naming; unrecoverable one-click removal.
- **Blocker (C1):** surveyed coordinates cannot be typed (dead Center
  editor); rotation cannot be typed or read.
- **Major (B2):** Escape does nothing anywhere; `pointercancel` mid-drag
  commits the partial drag instead of reverting
  (`finishViewingBoxInteraction`, BuilderKernelViewport.tsx ~774–785).
- **Major (C2/E2):** gizmo handles stay armed in every tool context (15 px
  capture-phase hit test steals gestures); no persistent "clip active"
  indicator when the panel is closed.
- **Major (B1):** no console command, no context-menu entry, no shortcut;
  automation `view.state.get` does not report the user viewing box — an AI
  agent receives clipped renders with no record a clip exists.
- **Major (E3/D1):** smoothness gate not agent-runnable (manual dev app +
  CDP 9223), absent from verify tiers; assertion tolerates ~18 fps
  (p95 ≤ max(55 ms, 3.5× target)); ring rotation unbenchmarked.
- **Major (correctness):** sub-threshold click jitter commits a tiny
  unintended resize and leaves an uncancelled rAF preview that republishes
  stale state after commit (BuilderKernelViewport.tsx ~729/774).
- **Minor (C1):** `VectorEditor` live-applies each keystroke, swallows
  values below minimum while typing, no Enter-commit, no units, precision
  ignores project settings.
- **Minor (A2):** only `keepInside`; RealWorks/Perspective also offer the
  inverse; kernel already supports `removeInside`.
- **Minor:** placement log reports size from `halfExtents.x` only; clip
  scope hardcoded `'builder:viewing-box'` while state carries an `id`.
- **Idea (A2):** align box to view / picked face; extract box contents into
  a new entity (natural pairing with lock-bake per P2); double-click face to
  type its dimension.

## Convincingly answered already

B3 (right panel is the correct surface), the drag-pipeline engineering half
of D1 (rAF coalescing, `setInteracting`, `previewCap` handling, refs instead
of React state), and the kernel-math test tier (`kernel-viewing-box.test.ts`).

## Resolved by owner precedent (2026-09-01)

- Named boxes are canonical entities, automation-visible (P1).
- Lock bakes a reduced resident dataset; memory traded for speed; lock and
  segment-extract must feel identically fast (P2).
- Gate calibration delegated (P3); chosen: p95 ≤ 2× target frame time, face
  and ring drags, wired behind the GPU capability in the verify plan.
