# Viewing box — visual reference criteria (E1 artifact)

Status: reference artifact for `viewing-box.md` E1 (2026-09-01). Per the
function contract, the E1 reference must exist in-repo when the spec is
marked specified. No third-party screenshots are committed (repository
license discipline); this file is instead the written comparison artifact:
each criterion below is concrete enough to fail an implementation
screenshot or a scripted check against. Numeric values are tunable (X6).

Composition baseline: the existing Himmel:CAD viewing-box overlay (edges,
face arrows, rotation rings) and the shared right-panel controls, theme
tokens only. Reference-product grounding, by dossier source URL:

- RealWorks Limit Box grips and toolbar — `dossiers/realworks.md` §2.5/W3,
  sources: https://www.laserinst.com/news/limitboxtoolinrealworks ,
  https://www.linkedin.com/pulse/thinking-outside-limit-box-jason-hayes
- RealWorks v12.4 "jumping grips" regression (the anti-goal) —
  `dossiers/realworks.md` §4 [18]:
  https://www.laserscanningforum.com/forum/viewtopic.php?t=20858
- Trimble Perspective limit box (active handle + affected face highlight) —
  `dossiers/trimble-perspective.md` §2.3 [S5]:
  https://help.fieldsystems.trimble.com/perspective/limit-box.htm

## Failable criteria

1. **Handle legibility.** In both themes, over a dense true-color cloud at
   default point size, every face arrow and visible ring is identifiable in
   a static screenshot at 100% zoom. Handle strokes use theme tokens with a
   contrast treatment (halo or dual-stroke), not raw accent lines. Fails if
   any handle is indistinguishable from cloud content in either theme.
2. **Active-state highlight.** Hovering or dragging a handle highlights the
   handle and its affected face distinctly from all idle handles
   (Perspective [S5] pattern, mapped to the shared accent token). Fails if
   a hover screenshot cannot be told apart from the idle screenshot.
3. **Grip stability under drag** (the RealWorks [18] regression class),
   asserted from the VB-D7 benchmark's sampled states, not by eye:
   - the anchored opposite face's projected screen position drifts ≤ 1 px
     over a full scripted face drag;
   - the dragged face tracks the pointer monotonically along the drag axis
     — no frame-to-frame reversal or jump exceeding the pointer travel of
     that interval;
   - every sampled intermediate state lies on the path between drag start
     and current pointer position (no transient wrong poses).
4. **In/out legibility.** Keep-inside and remove-inside are distinguishable
   from the viewport alone — the discarded side's overlay restyle (edge
   treatment and face tint) differs visibly between the two operations.
   Fails if the two screenshots differ only in point content.
5. **Status chip.** With the panel closed and a box active, the chip shows
   the truncated box name plus a lock glyph when locked; the tooltip names
   the operation. Fails on generic copy ("Box") or missing lock state.
6. **Locked panel state.** Locked: fields render in the shared read-only
   style, and a "Locked — unlock to edit" state line is present. Fails if
   fields merely ignore input while looking editable.
7. **No one-off chrome.** Overlay colors, chip, and panel controls resolve
   to `@himmelcad/theme` tokens and `@himmelcad/ui` modules; a code-review
   grep for literal colors/radii in the viewing-box surfaces returns none.

Implementation review compares actual screenshots (both themes, both
operations, idle/hover/drag/locked) against criteria 1–2 and 4–6, and the
benchmark's state samples against criterion 3.
