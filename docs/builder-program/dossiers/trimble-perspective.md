# Reference dossier: Trimble Perspective (and Trimble Access)

Document class: reference-product research (evidence for A2 derivations,
never normative). Researched 2026-09-01 and extended 2026-09-02 via web
sources; see the source lists and evidence-quality statement below.

## 1. Overview and reference role

Trimble Perspective is the field software that controls Trimble X7/X9/X12
laser scanners from a tablet: it captures scans, auto-registers them in the
field, and lets the operator view, measure, and verify the point cloud on
site. Trimble Access is Trimble's general surveying field software; its map
view displays scans and point clouds (SX10/SX12) alongside CAD/BIM data and
contributes a second data point for limit-box and selection design.

Reference role for Himmel:CAD (per `docs/FUNCTION-CONTRACT.md` A2): the
viewing/navigation reference. Perspective is interesting precisely because it
makes multi-hundred-million-point projects feel navigable on a mid-tier
tablet — the same constraint class as Himmel:CAD's weak-hardware tier. Its
answers are structural, not brute-force: image-backed station views, on-demand
densification, station-level visibility filters, and a persistent limit box.

## 2. Function catalog

### 2.1 Views and navigation modes

Perspective has three primary views plus a toggle area to switch among them
(UI area F) and per-view display settings (UI area G) [S1, S2]:

- **Map View** — locked top-down 2D view of all stations. Pan with one
  finger, pinch to zoom, double-tap for a 1.75x zoom step. Toolbar: switch
  to 3D View, Magnify, Zoom Extents, view presets (Top / Front / Right),
  view options, rendering options [S2].
- **3D View** — free navigation over the whole dataset: one-finger drag
  orbits _around the tapped position_ (pivot at picked point, not screen
  center), two-finger drag pans, pinch or scroll zooms. Parallel and
  perspective projection modes are both available [S3]. An orbit widget with
  X/Y/Z axis handles snaps the view to an axis (reported in search results
  for the 3D View page; exact widget details thin — flag).
- **Station View** — "a full-dome visualization of the whole scan data from
  the current station position", i.e. a panorama-style view from the scanner
  origin: one finger rotates around the station position, pinch zooms.
  If panoramas were captured, a Preview or High Quality panorama image can be
  overlaid and toggled against the luminance-image rendering [S4]. Entered by
  tapping a station marker, the stations list, or prev/next arrows; exited
  back to Map View via a thumbnail in the corner [S4].

There is **no free walk/fly mode** documented; Station View is the
first-person mechanism, deliberately constrained to real scanner positions.
(Absence claim: the help portal's view topics are Map/3D/Station only [S1–S4].)

### 2.2 Point cloud display modes

Rendering options (shared between Map View and 3D View) [S2, S3]:

- Color sources: single color per station, single color per scan, intensity
  (grayscale or color-coded), true color, color by elevation, one color per
  registration set.
- Point size adjustment.
- Normal-based filtering (hide points facing away from the screen).
- Background black/white; 2D grid or origin cross; station markers, labels,
  and registration links on/off; annotations and precision points on/off.
- Station View additionally renders unmeasured areas in red and can switch
  between luminance image, true color, and panorama overlay [S4].

Trimble Access offers the same family: scan color, station color, gray-scaled
intensity, color-coded intensity, color by elevation (with typed min/max),
uniform cloud color, plus point size — under Map settings [S8].

Not documented: any frame-rate, timing, or diagnostics overlay — the help
portal's view and rendering topics [S1–S4] list none (absence line item,
checked 2026-09-02 for the View-domain spec's A2 absence claim).

### 2.3 Limit box (Perspective)

- Activated from the tools area; a box with manipulators appears centered on
  the current view or point cloud center [S5].
- Grab handles: extent handles per face (2D: per box line; 3D: only on
  visible faces), a rotation handle for Z-axis rotation; the active handle
  and affected face highlight blue [S5].
- Numeric parity is partial: a "Limit Box Vertical Extent" field types the
  height, and a slider moves the box vertically at constant extent; no
  documented typed center/rotation [S5].
- Persistent: "will retain its position and size after you close and reopen
  the Limit Box tool, the project, or Trimble Perspective"; since 2025.10 a
  previous limit box can be restored (clock icon) [S5, S10].
- Doubles as an export scope: contents export to LAS 1.2/1.4 or E57, with
  panoramas embedded for stations inside the box [S5, S10].
- Disabled in Station View [S5].

### 2.4 Limit box (Trimble Access)

- Purpose: "exclude parts of the map to view more clearly the area you are
  interested in", especially inside point clouds and BIM models [S7].
- Sliders for vertical, left/right, front/back face pairs; tap-and-hold a
  slider button opens numeric entry for exact limits [S7].
- "Reset limits" refits the box to the current zoom/orbit; a Reference
  azimuth field aligns box faces with, e.g., a building facade [S7, S8].
- Slicing workflow: lock the thickness and move top/center/bottom to step
  through building storeys [S7].
- Extents persist between sessions [S7].

### 2.5 Selection and points

- Perspective selection is object-tap-based: stations, annotations,
  precision points, and measurements are selected by tapping in any view or
  in list panels; delete removes from all views [S6]. No documented free
  rectangle/lasso point-region selection in the viewport (the limit box and
  Magnify fill that role). Flag: thin evidence for what exactly is
  tap-selectable on bare cloud points outside tools.
- Trimble Access map selection: tap to select (blue highlight), tap again to
  deselect, double-tap empty space to clear, rectangle and polygon drag
  selection tools, tap-and-hold context menu with "Clear selection" /
  "List selection"; an ambiguous tap opens a disambiguation list [S9].

### 2.6 Measurement tools (Perspective)

Five types, picked by tapping points on the cloud in Map, Station, or 3D
View [S6]:

- Single point (3D position; Station View also shows distance from scanner
  origin), slope distance (with signed slope %), horizontal distance (XY
  projection), vertical clearance (Z axis), area+perimeter (>= 3 points,
  Map View).
- Results stack in a Measurements panel recording origin station and view;
  eye-icon visibility toggles, deletion, and point editing by dragging in
  Map/Station views; results auto-save to the project and export as TDX [S6].

### 2.7 Clipping/section aids beyond the limit box

- **Magnify** ("clip and zoom"): pick a point and a box size (0.1–10 m);
  Perspective "loads more points inside the clipping box", from one station
  or from all (including hidden) stations [S11].
- **View options as data filters**: show/hide all stations, show only the N
  most recent stations (N from Settings), show only stations nearest a
  selected one [S2, S11].
- Per-station and per-scan show/hide toggles in the Stations List [S4].
- Historic note: before the limit box existed, the lack of any slicer was a
  named practitioner complaint; the 3D limit box replaced the Slice Tool
  [S5, S13].

## 3. Key workflows (user's perspective) and what makes them feel fast

**W1 — Fresh scan appears.** The operator taps Start; the scanner captures
(X7: up to 500k pts/s) and the data downloads to the tablet while they carry
the instrument to the next setup; "once the download step is completed, the
captured data displays as a point cloud in the Map View and as a station in
the Stations List panel", already auto-registered to previous stations
[S12, S14]. _Feels fast because_: the user never waits at a progress bar to
see data — capture, download, and registration overlap with walking; and the
first thing shown is a top-down 2D map (cheap projection), not a full 3D
render.

**W2 — Inspect a fresh station.** Tap the station marker to enter Station
View. The full-dome _luminance image_ renders instantly and looks dense
because it is an image, not a point render; the operator sweeps around with
one finger, pinches into a detail, and toggles the panorama overlay for
photo-realism [S4]. _Feels fast because_: image-backed rendering decouples
perceived density from point budget; navigation is a constrained 2-DOF
rotation around a fixed origin, so there is no pivot hunting and no
depth-dependent cost.

**W3 — Verify registration between two stations.** In Map View, enable
"display nearest stations" to hide everything but the relevant neighbors,
color the cloud per-station, then Magnify: type a box size, tap a wall
junction — Perspective loads _more_ points inside the clipping box only, and
the operator checks for color-separated double walls; repeat at a second
spot [S2, S11]. _Feels fast because_: the default display is coarse and
densification is explicit, local, and user-triggered — full density is paid
for 10 m3, never the whole project. This is the clearest documented LOD
mechanism: base display decimated, on-demand refinement.

**W4 — Set a limit box and work inside it.** Open Limit Box; a box appears
centered on the view. Drag extent handles (active face highlights blue),
drag the rotation handle to align with the building, type the vertical
extent, slide the box up a storey. The box persists across tool, project,
and app restarts; when done it becomes the export scope (LAS/E57) [S5].
_Feels fast because_: everything outside is culled, so subsequent orbiting
touches a fraction of the data; persistence means the cost of setting it up
is amortized across sessions.

**W5 — Measure a clearance.** Open Measurement, choose Vertical Clearance,
tap floor then ceiling in Station View; the result appears immediately with
the value stacked into the Measurements panel, editable later by dragging
the points [S6]. _Feels fast because_: picking runs against the station's
structured range panorama (per-station data, scanner-origin geometry), and
results persist without a save step.

**W6 — Switch display modes.** Open rendering options from the display
settings area; flip intensity-grayscale -> per-station color -> elevation;
bump point size; hide markers/links [S2]. Documentation shows no reload or
progress step for recoloring — color modes are per-point attributes already
resident. (Inference from absence; flag as unverified.)

**Degradation summary (what the docs support):** base views render a
decimated cloud; density on demand via Magnify only; station-level
visibility filters (recent/nearest/hidden) shrink the working set; Station
View substitutes imagery for points; the limit box culls hard. Not
documented: whether point budget drops _during_ a drag (motion decimation)
— flag as unknown.

## 4. Practitioner sentiment

Direct forum access was Cloudflare-blocked; quotes below come from search
snippets of laserscanningforum.com threads and are thinner evidence than
the help-portal claims.

- Praise (field productivity/real-time viewing): "the ability to use the
  tablet to register in the field has really helped out the productivity and
  drastically reduced missed scan locations by having the ability to see
  what you scan in real time" [S13].
- Praise (turnaround): data is "ready to export the second the scan is
  finished"; start-of-first-scan to registered E57/RCP on a USB stick can
  beat office workflows [S13].
- Complaint (compute headroom): tablet processing "is not as fast as
  processing raw scans in TRW (Import and Register)" — heavy refinement
  still goes to the desktop [S13].
- Complaint (historical, since addressed): "Perspective didn't have any kind
  of slicer tool to visually verify registration", called a "big issue"
  before the 3D limit box shipped [S13, S5].
- Cautionary signal: thread titles "Is the Trimble X7 a good fit for large
  scale projects and datasets???" and "Trimble X7 and FieldLink crashes on
  large projects" indicate scaling concerns on very large jobs; thread
  bodies could not be retrieved — treat as unconfirmed [S13].

## 5. Mapping hints to the Himmel:CAD View tab and viewport model

Current Builder View tab: Camera (Frame All, 3D, 2.5D, 2D, Viewing Box) and
Style (Background, Point Size, Performance, Color Mode); Select tab (Box,
Lasso); Inspect tab (Distance, Angle) — `apps/builder/renderer/src/ribbon.ts`.

- **View presets**: Perspective's 2D Map View is a _locked_ top-down mode
  with its own cheap navigation (pan/zoom only), not just a camera position;
  Builder's 2D/2.5D/3D split matches this pattern well. Adopt Top/Front/
  Right presets and parallel-vs-perspective projection as explicit toggles.
- **Orbit pivot**: Perspective orbits around the _tapped position_. The
  Builder viewport should keep pick-point pivoting as the default orbit
  behavior — this is a large part of "navigation never feels lost".
- **Viewing box**: Perspective/Access validate the owner's corrections
  already recorded in `docs/builder-program/specs/view/viewing-box-review-2026-09-01.md`:
  persistence across sessions (C4) and numeric entry (C1) are table stakes
  in both references; Access adds slider+typed hybrid per face pair,
  "reset to current view", azimuth alignment, and thickness-locked storey
  slicing — a strong candidate feature for the locked box (C3). Perspective
  additionally treats the box as an export/extract scope, matching the
  owner precedent that lock bakes a reduced dataset and pairs with
  segment-extract.
- **On-demand densification**: Magnify (decimated base + user-triggered
  local full density) is the reference pattern for Builder's Performance
  governor: never densify globally; densify where the user points.
- **Station-scoped viewing**: when Himmel:CAD knows scan origins, a
  station-view mode (constrained rotation around the origin, image-backed
  where imagery exists) is the reference answer to first-person inspection
  — cheaper and less disorienting than a free walk mode.
- **Selection/deselection**: Access's model maps directly to the Builder
  viewport: tap selects (highlight), tap again deselects, double-tap empty
  space clears, rectangle/polygon drag tools (Builder: Box/Lasso),
  tap-and-hold opens the context menu, ambiguous picks open a
  disambiguation list. The "softkey changes meaning with selection"
  (Measure vs Stakeout) is the reference for selection-sensitive quick
  surfaces.
- **Measurements as persistent entities**: Perspective stacks measurements
  in a panel, keeps them visible/toggleable, auto-saves, and allows point
  editing later. Builder's Inspect tools should produce journaled entities
  with visibility toggles, not transient readouts (C4).
- **Color modes**: the six-mode set (per-scan, per-station, intensity gray/
  color, elevation with typed min/max, uniform) is the reference catalog
  for Builder's Color Mode; per-station coloring exists chiefly as a
  registration-QA tool and should ship together with any registration
  feature.

## 6. Sources

- [S1] User Interface — https://help.fieldsystems.trimble.com/perspective/user-interface.htm
- [S2] Map View (toolbar, gestures, rendering options) — https://help.fieldsystems.trimble.com/perspective/map-view.htm
- [S3] 3D View (gestures, projections) — https://help.fieldsystems.trimble.com/perspective/3d-view.htm
- [S4] Station View (full-dome, panorama, gestures) — https://help.fieldsystems.trimble.com/perspective/station-view.htm
- [S5] Limit Box (handles, persistence, export, Station View restriction) — https://help.fieldsystems.trimble.com/perspective/limit-box.htm
- [S6] Measurement Tool (five types, panel, TDX) — https://help.fieldsystems.trimble.com/perspective/measure.htm ; Points Tool — https://help.fieldsystems.trimble.com/perspective/create-points.htm
- [S7] Trimble Access Limit box — https://help.fieldsystems.trimble.com/trimble-access/latest/en/map-limit-box.htm
- [S8] Trimble Access Map settings (color modes, point size, reference azimuth) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/map-options.htm
- [S9] Trimble Access map selection — https://help.fieldsystems.trimble.com/trimble-access/latest/en/map-feature-selection.htm
- [S10] Perspective 2025.10 release notes (limit box redesign, restore, LAS 1.4) — https://help.fieldsystems.trimble.com/perspective/2025.10.htm
- [S11] Magnify / Display Nearest (registration check) — https://help.fieldsystems.trimble.com/perspective/check-graphically-the-registration-result.htm
- [S12] Capture Scans (download -> Map View display) — https://help.fieldsystems.trimble.com/perspective/capture-scans.htm ; product page — https://geospatial.trimble.com/en/products/software/trimble-perspective
- [S13] Laser Scanning Forum threads (via search snippets only; direct access blocked): "Is the Trimble X7 a good fit for large scale projects" — https://www.laserscanningforum.com/forum/viewtopic.php?t=18727 ; "New Release Trimble Perspective" — https://www.laserscanningforum.com/forum/viewtopic.php?t=19768 ; "Trimble X7 and FieldLink crashes on large projects" — https://laserscanningforum.com/forum/viewtopic.php?t=22791 ; X7 review — https://topotronix.com/en/blog/trimble-x7-review
- [S14] Trimble X7 datasheet (500k pts/s, auto-registration) — https://www.buildingpointmwgc.com/wp-content/uploads/2025/07/Trimble-X7-Datasheet.pdf

**Evidence quality.** Sections 2, 3, and 7 rest almost entirely on Trimble's
official help portal (fetched 2026-09-01 and 2026-09-02) and are strong for feature
existence and interaction detail; workflow narratives interpolate ordering
but not features. Section 7 is strong for the three Access layer states,
their official SVG icons, parent mixed-state summaries, and blue selection;
it is deliberately thin on a Layer-manager multi-row gesture and a universal
selected-point marker shape because Trimble documents neither. Other weak
spots, flagged inline: the 3D-view orbit axis widget (search-result evidence
only), whether recoloring is reload-free, whether any motion-time decimation
exists, and exactly what is tap-selectable on bare points in Perspective.
Section 4 is the thinnest: forum pages were Cloudflare-blocked, so all
practitioner quotes come from search-result snippets and the large-project
scaling complaints are title-level evidence only. No claim in this dossier
is invented; every uncertain claim carries a flag.

## 7. Trimble Access layer states and selection rendering

### 7.1 Layer-manager state machine and hierarchy

The current (2026.10) Trimble Access help documents **three**, not four,
states for vector project data: `Selectable > Visible > Off`. `Visible`
features are displayed but cannot be selected; `Off` files have no icon, are
not displayed, and are not linked to the job. CSV/TXT point files omit the
visible-only state (`Selectable > Off`), while raster images omit the
selectable state (`Visible > Off`). There is no Layer-manager `Editable`
state; older official help is explicit that features in linked map files can
be made visible/selectable but cannot be edited or deleted [A15].

The visuals are also more specific than “empty / dashed / full checkbox.”
The official assets used on the help page show: **Off = no icon** (not an
empty box); **Visible = a standalone dark check mark**; **Selectable = a dark
check inside a dark dashed square**. Thus the dashed-square icon means fully
selectable, not an intermediate visible-only state, and the plain check means
visible-not-selectable [A15, A16].

Files are parents of their contained layers. Tapping the file row cycles the
whole file through its supported states; contained layers initially inherit
the file setting, after which an expanded child row can be changed
individually. The parent then becomes a summary rather than forcing a false
single state: “some layers not visible” uses a pale/gray dashed square with a
pale/gray check, while “some layers not selectable” uses a pale/gray dashed
square with a dark check. These are two mixed-child summaries, not extra
editable states [A15, A16].

The documented bulk controls are parent-row propagation and `All` / `None`
softkeys (for example on the Features and Scans tabs). The Scans tab permits
several scans/regions to be visible together and can show or hide all of them.
The current Layer-manager topics describe changing child rows one at a time;
they do **not** document Ctrl/Shift row multi-selection or a touch multi-select
gesture for applying one state change to an arbitrary subset. Treat such a
gesture as unverified rather than borrowing Trimble Business Center behavior
[A17, A18].

### 7.2 Selection appearance in the 2D/3D map

Trimble Access does **not** use orange for normal map selection. The official
selection topic says that a selected point, line, arc, polyline, or polygon is
shown **blue**; rectangle/polygon-selected items are also colored blue, and
deselection restores the usual color. This applies to the Map, whose toolbar
supports both plan and predefined/orbited 3D views [A19, A20].

Direction arrows are contextual, not part of every selected-line highlight.
They are drawn when a line, arc, or polyline is selected **for stakeout**; the
end nearest the tap becomes the start, and tapping nearer the other end (or
using `Reverse direction`) reverses it. The source does not assign an orange
color to either the blue selected item or these arrows [A19, A21].

For points, the sourced invariant is blue selection, not a special universal
marker shape. Normal point glyphs can be configured as a uniform dot,
method-based symbols, or Feature Library symbols, so the help does not support
a claim that selection always replaces them with one fixed reticle/marker.
The defensible reference rule is “recolor the selected point blue”; any size,
halo, or shape change remains unverified [A19, A22].

### Sources for section 7

- [A15] Trimble Access 2026.10, Managing project data layers (state cycles,
  parent/child behavior, mixed-state icons) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/layer-manager-project-data.htm ; 2024 help stating that child layers initially share the file setting — https://help.fieldsystems.trimble.com/trimble-access/2024.00/en/Layer-manager-map-files.htm ; historical official clarification that linked features are not editable/deletable — https://help.fieldsystems.trimble.com/trimble-access/2021.00/en/Map-add-data.htm
- [A16] Official icon assets used by [A15]: Selectable (dark dashed square +
  check) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/images/layerselectable_16-32-64.svg ; Visible (plain check) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/images/tick_16-32-64.svg ; some layers not visible (gray square + gray check) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/images/layersomevisiblesomeselectable_16-32-64.svg ; some layers not selectable (gray square + dark check) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/images/layersomeselectable_16-32-64.svg
- [A17] Filtering data by feature layer (`All` / `None`, per-code child
  control) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/layer-manager-features.htm
- [A18] Managing scan layers (`All` / `None`, multiple visible scans and
  regions) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/layer-manager-scans.htm
- [A19] Selecting items in the map (blue highlight, direction arrows,
  rectangle/polygon selection, deselection) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/map-feature-selection.htm
- [A20] Map toolbar (plan, predefined 3D, and orbit modes) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/map-toolbar.htm
- [A21] Stake out a line (tap-near-end direction and reversal) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/stake-lines.htm
- [A22] Map settings (dot, method, and Feature Library point symbols) — https://help.fieldsystems.trimble.com/trimble-access/latest/en/map-options.htm
