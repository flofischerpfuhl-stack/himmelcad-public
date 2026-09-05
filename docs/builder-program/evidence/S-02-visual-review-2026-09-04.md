# S-02 base controls — architect visual review (G17)

Reviewed: `packages/@himmelcad/ui/gallery/shots/{dark,light}.png` and the
dark section shots for Button, NumberInput, Dialog, Menu, Toast (1280 px,
2026-09-04). Verdict: the token discipline, Dark Islands surfaces, focus rings
and typography are consistent across all 24 sections and both themes; five
corrections before S-02 counts as landed.

| #   | Component | Finding                                                                                                                                                                                                                                                                                    | Required change                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Button    | The `default` row shows a secondary-looking "Save" while hover/focus/disabled/loading show the primary blue — the state rows mix two variants, so the primary default state is never shown.                                                                                                | Gallery: one row block per variant (primary, secondary, quiet, danger), each with default/hover/focus-visible/disabled; loading only on primary. Component: verify all four variants exist and use only tokens; danger uses the error token family.                                                                                                                                                            |
| 2   | Dialog    | The `default` fixture is a stub: a tiny dialog whose only action is unstyled text "OK" (reads as a label). The confirm fixtures show only Cancel; a confirmation dialog needs its primary/destructive action.                                                                              | Gallery: one realistic fixture — title "Delete 3 entities?", body sentence, footer right-aligned with secondary Cancel and danger "Delete" (primary position, rightmost), width 420 px, 16 px padding, footer separated by the divider token. States: default, focus-visible on Delete, close-button hover. Component: footer slot must accept the action pair; initial focus on the least destructive action. |
| 3   | Menu      | In the `hover` row both items are highlighted, in `focus-visible` both items carry focus rings. Exactly one item may be hovered/focused at a time (roving focus). Whether this is the fixture's simulation class applied to every item or the component's state handling must be verified. | Fix the fixture to mark one item; add a test that at most one `[data-focused]`/focused item exists after ArrowDown; if the component itself renders multiple focus rings, fix the roving-tabindex implementation. Also: the `default` row's single tall box ("Open") is not a realistic menu — show the same three-item menu in every row.                                                                     |
| 4   | Toast     | Rows labelled default/hover/focus-visible actually differ by accent colour (blue, orange, green) — those are kinds (info, warning, success), not states, so the labels lie and the error kind is never shown.                                                                              | Gallery: rows by kind — info, success, warning, error (error with `aria-live=assertive` and an action slot "Retry"), plus one row for close-button hover/focus. Component: kind → accent token mapping documented.                                                                                                                                                                                             |
| 5   | All       | Hover is simulated via a forced class; for Button the hover surface is barely distinguishable from default in dark theme (Save vs Save project rows differ only by width).                                                                                                                 | Ensure the hover state raises the surface by exactly one token step (`--hc-surface-raised` or the existing hover token) so hover is visible in both themes; verify in the gallery shot by pixel difference between default and hover rows (script check: the two rows must differ).                                                                                                                            |

Not findings (accepted as is): NumberInput (right-aligned value, unit suffix,
invalid state with message), Spinner, Tooltip, Slider, ProgressBar, Select,
Checkbox, Radio, IslandTabs, FunctionPanel, EntityTree, StatusBar, EmptyState,
OverlayChip, Splitter, TitleBar, EdgeStrip, PanelToggles.

## Corrections applied

The five numbered findings were corrected on 2026-09-04. The gallery now
shows every Button variant and required state, the complete destructive Dialog,
single-item Menu hover/focus with realistic groups, all four Toast kinds and
close-control states, and a pixel assertion that rejects identical primary
Button default/hover rows in either theme.

Regenerated evidence:

- `packages/@himmelcad/ui/gallery/shots/light/button.png`
- `packages/@himmelcad/ui/gallery/shots/light/dialog.png`
- `packages/@himmelcad/ui/gallery/shots/light/menu.png`
- `packages/@himmelcad/ui/gallery/shots/light/toast.png`
- `packages/@himmelcad/ui/gallery/shots/dark/button.png`
- `packages/@himmelcad/ui/gallery/shots/dark/dialog.png`
- `packages/@himmelcad/ui/gallery/shots/dark/menu.png`
- `packages/@himmelcad/ui/gallery/shots/dark/toast.png`

## Architect acceptance (2026-09-04, after S-02b)

Reviewed the regenerated dark section shots for Button, Dialog, Menu, Toast (and the light sheet): all five findings are resolved as briefed — four Button variants with distinct hover/focus/disabled rows and loading on primary; a realistic destructive Dialog (Cancel left, danger Delete right, focus on Delete shown); Menu with exactly one hovered/focused item and separators; Toast rows by kind with the error kind carrying a Retry action. S-02 counts as **landed under G17**.

S-02c — The light Dialog defect was stale/mixed generated evidence: concurrent
`gallery:shots` runs shared the same preview port, build directory, and output
paths, allowing one run to capture or remove another run's artifacts. The
rendered Cancel buttons were enabled and resolved the correct secondary tokens.
Gallery capture is now mutually exclusive (a concurrent run is rejected) and
rejects text-to-fill contrast below 4.5:1 for Cancel in every Dialog row in
both themes.
