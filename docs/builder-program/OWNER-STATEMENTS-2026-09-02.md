# Owner statements — batch 2 (2026-09-02)

Document class: evidence (repo-resident owner statements per doctrine rule 1).
The owner wrote these before reading `MASTER-PLAN.md`; they are workflow
descriptions from the CAD user's perspective and explicit requests to
extrapolate. Statements S1–S12 are transcribed in substance (German →
English); generators G1–G10 are the architect's extrapolation, recorded in
`OWNER-DECISIONS.md` D7 and, where class-level, in the doctrine/contract.

## S1 — Drawing a line

Two clicks is the default. Alternatively: click one point, move the cursor in
a direction — snap at certain angles — then type a length; the second point
may also be defined by absolute height or relative slope. While the second
point is pending, a live preview follows the cursor. The right function panel
always shows the pending second point's polar values and the first point's
coordinates; typed values appear there; Tab switches between inputs
(direction, slope, …) without affecting the cursor.

## S2 — Selection appearance (Trimble Access)

Selected or actively drawn lines: the same orange as Trimble Access, with
the line direction shown. Selected points: an orange square. A point whose
specification carries a symbol highlights only the anchor point the symbol
refers to. Blue is used for support points / points without number or
specification (Hilfspunkte) and for support lines (e.g. the line that
defines a wall). On a BIM wall all corner points and edges must be
selectable; complex BIM objects need care (open).

## S3 — Bottom bar rebuilt as global always-visible controls

The current bottom bar (mostly unneeded info) becomes a strip of globally
relevant toggles: show/hide support points and lines; "explode polylines"
(a selection mode: segments become individually selectable and tools such
as parallel act on the segment, with no geometry change); 3D / 2.5D / 2D;
selectable element kinds (e.g. deselect "points" so they cannot be selected
when many things overlap — especially after areas were formed); label
display (height, specification, name, volume of a solid) globally and per
element. A per-element label choice (e.g. a section line named "Schnitt A")
must not be lost when the global toggle is switched on and off again. The
owner's proposed solution: separate undo histories — camera, display,
selection, and real entity changes.

## S4 — Creating a point

By click, by typed coordinates, and — as in Trimble RealWorks — with a 3D
target reticle that can be rotated and moved in all directions, so that a
point can be placed into a sparse point cloud where the user can estimate
its position between neighbours.

## S5 — Layers / tree / type taxonomies (Trimble Access tri-state)

The left panel offers taxonomies (by layer, tree, type). Adopt the Trimble
Access checkbox: empty = hidden; dashed box with check = visible, not
editable, but selectable (usable for parallels, as support points for new
lines, …); checked = editable; possibly a fourth state: visible but reacts
to nothing. Parent nodes carry the same box and propagate to children; grey
when children differ. Multi-select with Ctrl+A / Ctrl+click.

## S6 — Plan editor layout

Plan production is nearly a program of its own. Layout: the plan at its
paper size on an infinite canvas; UI elements float above it as islands —
a top bar, a left and a right island; contents left to the architect.

## S7 — Embankments (Böschungen) and excavation pits

Are slopes elements? Workflow: import a DWG, form areas from the closed
polygons that are foundations, give each defining polygon a common height
so they become surfaces, assign a slope angle to each surface; the slope is
shown transparently (it is theoretically infinite, so its displayed extent
is configurable); finally select all areas and slopes and say "build a new
surface from the lower edge" — everything is intersected and the lower edge
is the pit surface. Must be robust to edge cases such as two slopes lying
partly exactly on top of each other. The same workflow from the outer faces
of BIM objects turned into surfaces.

## S8 — Sections and profiles

Sections must be easy: select a line, "make a section", state the view
direction and optionally a depth; the line gets a specification with two
arrows in view direction so the plan view shows where the section looks; the
section itself is a new view with a correspondingly rotated coordinate
system. Special case: profiles — "views" defined by an alignment or a
polyline; not a pure coordinate transform but mathematically more complex,
so the relevant elements are selected first, then transformed/projected in
the profile; editing in the profile needs an explicit synchronize step
(realtime is presumably impossible — owner asks whether that is right); an
indicator that views are out of sync, and on switching views the user
confirms the sync or discards changes.

## S9 — Alignments (Trassen)

Classic alignment creation with gradients and width bands is user-unfriendly
in most CADs. Vision for an as-built road from a point cloud: pick left and
right road edges as polylines from the cloud; with both selected, fit a
best-fitting axis that is a true tuple of lines, arcs, and clothoids
(possibly with adjustable constraints; mathematical feasibility unknown to
the owner). Select the axis and give it a gradient: open a profile, best-fit
to the cloud or draw lines/arcs/clothoids. Make the two edge polylines
"pretty" axes too (they have heights; still allow a pretty gradient in
their profile rather than raw vertex heights); use them as width bands; the
axis is now already displayed as a surface because the edge band emerged;
then add slopes. Classic table entry must remain possible and be usable for
later adjustment; but fully intuitive graphical work is the goal.
Extrapolate to design (not only as-built).

## S10 — Surface creation workflow

Frequent workflow: point cloud → draw breaklines and possibly a boundary →
thin the cloud (spatial sampling; or a grid where each cell yields the point
with the most average height, or a new cloud on a 10 cm grid whose cell
centers carry the cell's mean height) → select cloud, boundary, breaklines →
"create surface" → popup: assign line roles (boundary / breakline / form
line) → errors appear (breakline over a cloud point, points outside the
boundary) → fix individually (remove points — only within this surface job,
never from the actual cloud) or by rules ("disregard all points outside the
boundary", "disregard all points within x cm of breaklines"). Often a
pre-drawn boundary is too cumbersome: create the surface with an auto-
generated boundary, then draw a 2D polyline inside the popup that takes the
heights and crops. Creating a surface from an alignment with width bands
must be very easy.

## S11 — Additional functions

- Convex hull area/surface from several polylines, very quickly.
- Solid between two surfaces/DGMs, with cut and fill each assignable a
  specification.
- Solid when at least one side is a point cloud: the cloud side is defined
  on a grid of mean heights, not by triangles.
- Solid specifications by height (layers known from a borehole: which
  soil/rock layer to which depth).
- Raster image between two surfaces/DGMs/point clouds with height coloring
  via an intuitive assistant; also a legend as a raster image.

## S13 — Cursor appearance per function (follow-up)

The cursor should look different per function; this needs a design.

## S14 — Dependent objects (follow-up)

How do dependent objects behave — does a surface change when its breakline
is dragged? The owner would like it always possible to detach an object
from its source data and make it independent, but fears that dependency
introduces very many edge cases.

## S15 — DGM smoothing region (follow-up, 2026-09-02 evening)

Editing a DGM must let the user mark a region with a line and smooth it:
either excise the region and refill it from heights interpolated along the
temporary marking line, or fill it intelligently from the surrounding
triangle slopes. Also: intelligent downsampling of the triangle count.

## S16 — "Trimble RealWorks starter" outcome (owner definition, 2026-09-02 evening)

The complete Builder shell stands, and of the functions the point-cloud
set is implemented: segmentation, classification, terrain (ground)
extraction, floor extraction, clipping box, views, cloud-to-cloud
registration, the station view (the owner's approach: compute a panorama
depth image from the E57 panorama image or from the station's own cloud),
spatial sampling, rasterize (mean height per grid cell as described in
S10). All measurement tools (single point, 2D distance, 3D distance,
Δz, …). Orthophoto import that performs very well. Viewer performance
improved again so that it beats TRW. At least line and point creation
tools work, with line editing (split, trim, parallel, …). Surfaces and
DGMs can be created and edited well (S15). Volume generation works and
volumes can be computed. At least the start of specification management
stands. PhotoLab production-ready in parallel, by a separate session that
must adopt this program's workflow.

## S17 — Commercial direction (2026-09-02 late)

Release 0.5 as "DGM aus Scan" is the goal; PhotoLab and the Builder alpha
are sold as a bundle. Market with the source-available codebase (restrictive
license) and an explicit roadmap: the aim is to free surveyors from the
Trimble/Autodesk stranglehold — buy the product and we build the ultimate
CAD for a fraction of the cost. Token budget: consider gpt-5.6-terra for
some tasks, carefully, because reviews and very concrete instructions for a
weaker model may cost more overall.

## S18 — Distribution and the other projects (2026-09-02 late)

The owner will promote Himmel:CAD Release 0.5 on Reddit (with moderator
permission) — considered the best strategy. Doubt: were SupraBench and
Fernwork dropped too early? If SupraBench gains users, monetization is moot
because "once you are a player in the AI bubble, money is thrown at you".
Fernwork PDF is "only a few changes away" from a real PDF-XChange
alternative; maybe a 5 € app-store version earns money, or a dedicated
Electron desktop app bundled with Himmel:CAD. Concern: both depend on
advertising; generic LLM marketing advice does not work and is seen through
by consumers; effective advertising costs money the owner does not have.

## S19 — Website judgement (2026-09-02 night)

The v1 site was rejected outright ("never seen such an ugly website"): no
CSS sky — a proper background image; the architect must actually look at
lawn.video; Grok is useless without high-precision instructions. Added: the
roadmap must be prominent and eye-catching — visitors must see what the
79 € finance; "our product can be as good as it wants, if the website does
not sell it properly, all of this is worthless."

## S12 — Meta

Extrapolate from these to other functions. The level of detail is meant to
let the architect judge whether the specs are specific enough. The master
plan may already have some things differently — possibly better.

## S20 — Website message corrections (owner, 2026-09-02 late evening)

Verbatim intent, four binding corrections after the v3 redesign brief:

1. Codex generates the hero background image itself (its image-generation
   tool is available); the owner does not supply it.
2. No other CAD or scan product is named anywhere on the website.
3. The "79 € finance this" link is at most subliminal; the price is
   mentioned as little as necessary because the site advertises through the
   free tier.
4. The roadmap contains everything (BIM, alignments/Trassen, plan editor,
   raster, agent, ...) and starts at the Release 0.5 state, not at the
   current state.

Generalized as **G16 — Marketing surfaces sell the free tier and the
complete roadmap; money and competitors are footnotes.** Any public
marketing artifact (website, README landing, release notes, posts) leads with
the free tier, shows the whole roadmap from the next release onward with
honest status per item, names no vendor, and mentions price once in the
pricing block only. Derivation: owner statements above; D10 (free tier is the
acquisition path).

## S21 — Segmentation in 0.5; architect reviews every UI; budget state (owner, 2026-09-03 morning)

1. "ich will segment auch in der release 0.5 drinnen haben" — point-cloud
   segmentation (fence: keep inside / remove inside, RealWorks "Segment")
   joins the Release 0.5 scope.
2. "ich will trotzdem dass du nochmal über jede ui drüberguckst die codex
   macht und sobald codex etwas in der ui machen soll du sehr spezifisch bis
   wie es aussehen soll" — despite token discipline, the architect (Claude)
   reviews every UI Codex produces (screenshots, not reports) and writes the
   visual brief for any UI work to the level of "how it looks".
3. Codex weekly budget: 80 % remaining after the owner's own use; the 10 %
   floor (D8) stands, so ≈70 % is available to both lanes until the reset.

Generalized as **G17 — UI is briefed to the pixel and reviewed by eye.**
Any slice with user-visible UI gets an architect-written visual brief
(layout, sizes, spacing, states, tokens, reference screenshot or ASCII
mockup) before launch, and lands only after the architect has looked at
rendered screenshots (light and dark) and either accepted or filed
corrections. Reports and passing tests never substitute for the look.
Derivation: S19/G15 (marketing) extended to product UI by S21; DESIGN-SYSTEM
"Verification" (visual inspection required).

## Generators extracted (architect, 2026-09-02)

- **G1 Tri-modal input** (S1, S4, S9): every geometric input accepts pick,
  constrained pick (angle/length/slope snap), and typed values; vertical
  values always offer absolute Z, relative ΔZ, and slope; live preview
  follows the cursor; the function panel mirrors pending geometry in
  cartesian and polar form; Tab traverses fields without moving the cursor.
  → contract C1 extension.
- **G2 Domain-scoped undo** (S3): document, selection, display, camera each
  keep their own history. → doctrine P8.
- **G3 Interaction state per visibility node** (S5, D5): hidden / reference
  (visible, snappable, selectable, not editable) / editable / inert; parents
  propagate, mixed = grey; applies to layers, tree, types, cloud classes,
  attached projects. → doctrine P9.
- **G4 Global toggles are defaults, never destroyers** (S3): per-element
  display choices survive global switches. → doctrine P9.
- **G5 Support geometry class** (S2, S3): defining points/lines of
  higher-order entities are a visibility/selectability class (blue),
  globally toggleable. → ui-platform / select-edit.
- **G6 Selection granularity mode** (S3): explode-polylines and selectable-
  kind filters are selection modes, never geometry changes. → ui-platform.
- **G7 Shared 3D cursor/target** (S4): a manipulable 3D reticle is the
  shared placement component (points, viewing-box center, section planes).
  → ui-platform / select-edit gizmo family.
- **G8 Live-or-stale rule** (S8, S7, S11): derived views and entities update
  live when the mapping is cheap and unambiguous (rigid sections,
  station/offset-defined civil geometry); otherwise they show a visible
  stale state and require explicit synchronization, with confirm/discard on
  view switch. → doctrine P10.
- **G9 Parametric derived geometry as entities** (S7, S9, S11): slopes,
  offsets, best-fit alignments, solids between surfaces are canonical
  parametric entities with preview and an explicit "bake to surface" step,
  robust under intersection edge cases. → new civil domain + mesh-terrain.
- **G10 Jobs act on copies** (S10): exclusions inside a creation job never
  modify the source entity. → mesh-terrain (and X1).
- **G11 Cursor vocabulary** (S13): the cursor is a platform component with
  a fixed vocabulary — pick crosshair; crosshair + snap-kind marker
  (endpoint, midpoint, intersection, cloud point, surface; RIB Fangkreis
  around it); gizmo handle glyphs (move/rotate/scale); 3D target reticle;
  prohibited glyph on invalid input; wait state for bounded work. Tools
  declare which vocabulary items they use (E1), never invent cursors.
  → ui-platform + draw/select-edit E1 criteria.
- **G12 Linked-or-detached derived entities** (S14): every derived entity
  keeps a recipe (sources by id + revision + parameters); linked by default;
  a source change marks it stale (badge) at gesture end, never mid-drag
  (P5); regeneration is a journaled command — automatic under an X6 cost
  budget, otherwise explicit/batched; detachable at any time (recipe kept
  as provenance); auto-detached with a console note when a source
  disappears; the recipe graph is a DAG enforced at command time;
  regeneration errors reuse the creation error list. → doctrine P10
  extension; mesh-terrain (surface ↔ breaklines/boundary/cloud), civil
  (slopes, corridor surfaces), draw (parallels/offsets), raster (drape),
  bim-specs (role-generated objects ↔ source geometry).
- **G13 Region-scoped surface repair** (S15): a marked region on a surface
  is a temporary derived job (P10/MT-D25 semantics) with two fill
  strategies — interpolate along the marking line, or fit surrounding
  slopes — previewed, committed as one journaled command, never modifying
  the source cloud. → mesh-terrain amendment.
- **G14 Milestone as owner outcome** (S16): the RealWorks-starter list is a
  user outcome, not a feature count — it becomes a named milestone with
  gates in MASTER-PLAN (M-RW), and the owed `registration-and-stations`
  spec is written before its slices start.
- **G15 Precise briefs or nothing** (S19): design and marketing work is
  delegated only with a pixel-level brief derived from a reference the
  architect has inspected (screenshots attached), naming layout,
  measurements, colours, typography, components, and copy; cheap models
  never receive open-ended creative tasks. → process rule (D8 addendum).
- **G16 Free tier first, complete roadmap, no vendor names** (S20): public marketing surfaces lead with the free tier, show the whole roadmap from the next release onward with honest status, name no competitor, and state the price once in the pricing block only.
- **G17 UI briefed to the pixel, reviewed by eye** (S21): every UI slice gets an architect visual brief before launch and lands only after the architect reviewed rendered light/dark screenshots.
