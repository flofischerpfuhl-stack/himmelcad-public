# HimmelCAD Design System

Binding visual and interaction rules for **all** HimmelCAD products
(PhotoLab, Builder, WeltView, later reserved products). Implementation lives in
`packages/@himmelcad/theme` and `packages/@himmelcad/ui`. Product apps compose
modules; they do not invent one-off chrome.

## Brand writing

| Context                                       | Form                                                                |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Stylized wordmark / splash / marketing chrome | `himmel:CAD`, `HIMMEL:CAD`, or `himmel:cad` — **always with colon** |
| Plain prose / docs / legal                    | `HimmelCAD` without colon is OK                                     |
| Product suffix                                | space + product, e.g. `PHOTOLAB`, `BUILDER`                         |

## Fonts (exactly four roles)

| Role       | Token                                | Use                                                            |
| ---------- | ------------------------------------ | -------------------------------------------------------------- |
| UI         | `--hc-font-ui` (Inter)               | Ribbon, panels, tabs, forms, tree labels                       |
| Mono       | `--hc-font-mono` (JetBrains Mono)    | Console, coordinates, hashes, numeric fields, code-like values |
| Display    | `--hc-font-display` (Kamikaze)       | Compact wordmark in title bar                                  |
| Display 3D | `--hc-font-display-3d` (Kamikaze 3D) | Console brand splash only                                      |

Do not introduce extra typefaces. Do not use display fonts for body copy.

## Color

- **One accent blue:** `--hc-accent-base` (`#1597f2`). Rare use: primary buttons, focus ring, solid accent selection border, links that truly need emphasis.
- **No blue washes, soft fills, or accent gradients** for selection or hover.
- **Status only:** success / warning / error — each as **filled** or **border** variant. No half-transparent status backgrounds unless a dedicated token is added later for both themes.
- Themes: `.hc-theme-dark` (default) and `.hc-theme-light` (Cloudflare-like light void + white islands). Apply on `document.documentElement`.

## Selection & pressed states

Two allowed kinds:

1. **Neutral active / pressed** — slightly brighter/darker grey (`--hc-press-bg` / `--hc-active-bg`), optional stronger border. Used for tabs, list rows, ribbon actions when “current”.
2. **Accent outline** — solid 1px `--hc-accent-base` border, **no** accent fill. Used when the selection is a primary target (e.g. geometry selection chrome, critical radio).

Forbidden: translucent blue backgrounds, blue gradients, mixed ad-hoc styles.

## Islands & tabs

- Panels float on `--hc-bg-void` with `--hc-radius-island` and `--hc-shadow-island`.
- **Floating island tabs** (View/Images, Function/Properties, Tree/Layers) use `IslandTabs` with `variant="floating"`:
  - **identical** surface as main islands: `--hc-bg-island` + `--hc-shadow-island` + `--hc-radius-island` (no different grey, no softer border),
  - host must be `AppShell` `floatingLeftTabs` / `floatingViewportTabs` / `floatingRightTabs` so there is **no** outer radius wrapping the tabs,
  - left edge aligned with the island they control,
  - sentence case (not ALL CAPS),
  - horizontally scrollable when many tabs,
  - neutral active (label only; no accent wash).
- **Console / bottom result tabs** use `IslandTabs` with `variant="strip"`: attached to the island surface, **not** floating pills.
- Viewport overlay controls use `OverlayChip` and always anchor **bottom-left** (tools) / **bottom-right** (coordinates) in **every** workspace (View and Images).

## Expand / collapse chevrons

Standard tree disclosure:

- **Collapsed** → chevron right (`>`)
- **Expanded** → chevron down (`v`)

Use `ExpandChevron` from `@himmelcad/ui`. Do not invert this. Ribbon collapse (whole chrome up/down) may use up/down for the ribbon itself only.

## Controls

Native browser checkboxes, selects, alerts, and toasts are **forbidden** in product UI.

Use shared modules:

- `Checkbox`
- `Select`
- `EmptyState` (console-family empty: mono-friendly, same density as console body)
- future: `Toast` / `Dialog` only as designed modules

Sizes: default control height `--hc-size-control-h` (28px); compact variant allowed.

## Empty states

Jobs, Accuracy, Report, and similar panes must match the **console family**:

- same panel background language (`--hc-bg-island-lo` body),
- same typography scale,
- short title + one-line hint,
- no large illustration stacks that make empty panes look like different products.

## Function surface: panel vs popup

Heuristic for PhotoLab / Builder:

| Use **right Function panel** when                              | Use **modal / popup** when                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Parameters for an active tool while viewport stays interactive | Multi-step wizard that needs full focus (project New/Open risk, destructive confirm) |
| Settings that benefit from seeing the scene/image              | Large dual-pane editors (CRS transform map) that would crush the viewport if docked  |
| Short forms (align options, product params)                    | Blocking safety (overwrite project, discard unsaved)                                 |
| Inspect / properties of selection                              | Rare “focus mode” report builders                                                    |

Rule of thumb: **if the user still needs to click the view or compare to geometry, dock it.**  
**If a wrong click in the view would be harmful or the form is a multi-stage commit, popup.**

Import review can start docked; promote to popup only if field density forces it.

## Import / transform layout

Image import and GCP import share one pattern:

- Same section order, field components, primary/secondary actions.
- **Transform blocks (height and horizontal)** are twins:
  - **Left:** current / source system
  - **Right:** target system
  - Search by EPSG; empty query shows five defaults (most common + recent user choices)
  - Explicit **No transform** option on both

## Console brand intro

On first empty console session (product may override subtitle):

1. Latin **Pater Noster** + crucifix ASCII art
2. Latin **Ave Maria** + Madonna ASCII art
3. Display splash `HIMMEL:CAD`
4. Product subtitle line

## Module library

Shared building blocks live under `packages/@himmelcad/ui` and must stay Electron-free. Products only wire domain content into slots (tree, function body, viewport, bottom tabs).

See also: `docs/CURRENT-DIRECTION.md`, `AGENTS.md` § UI.
