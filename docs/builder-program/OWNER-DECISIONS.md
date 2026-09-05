# Owner decisions — batch 1 (2026-09-01)

Per `docs/DECISION-DOCTRINE.md`, items D1–D5 are **derived decisions**: they
were resolved from axioms, precedents, and references, and are presented for
veto, not for design. Item Q1 is the single surviving genuine owner question.
Silence is not consent; each item needs an explicit "ok" or a correction.
Corrections are generalized into the doctrine.

## Derived decisions (veto if wrong)

### D1 — Builder project lifecycle

**Decision:** Journal-implicit persistence stays: work is never lost, there
is no "unsaved document" state. What the user gets on top: choose the project
location at creation (New/Open in File ribbon), **Save As = archive copy**
(`.hcadx` export to a chosen path), and **named snapshots** (restorable
points in the journal). No dirty flag — but a visible **Save** control
remains (File tab + Ctrl+S; corrected 2026-09-02 after the owner asked
"don't we still need a normal Save button?"): it forces the durability flush
of pending group commits and affirms "All changes stored · <time>"; its
dropdown offers **Save snapshot…** and **Save As…**. Ordinary work never
needs Save As; path and name are chosen once at project creation.
**Derivation:** X1 (crash-safe persistence is a correctness property; the
journaled canonical store already provides it); X4 (modern reference
behavior: Revit worksharing and cloud models moved away from dirty-flag
saving); `docs/PROJECT-FORMAT.md` already specifies `.hcadx` archives.
**Rejected:** classic dirty-flag save (reintroduces data loss for no user
benefit); removing the Save affordance entirely (the first draft did this —
rejected per P6: universal affordances survive mechanism changes); fully
hidden storage with no location choice (breaks user's file management
expectations, X4).
**Tunable:** snapshot retention/auto-snapshot cadence (X6).

**Non-interruption guarantees (added 2026-09-02 after the owner asked whether
auto-persistence would interrupt work on huge datasets):** the journal model
is not "autosave the document". A command journals a few hundred bytes (ids,
field deltas, content hashes); the heavy data (clouds, meshes, rasters) lives
in the immutable content-addressed object store and is written once, by
explicit progress-reporting jobs (import, extraction, bake, compaction) —
editing an 80 GB cloud's placement writes ~200 bytes, never the cloud. The
model is therefore strictly cheaper than classic Save _and_ classic
autosave, provided these implementation invariants hold (now doctrine
precedent P5): continuous gestures (drags, orbit, gizmo) journal exactly once
at gesture end, never per frame; journal appends run asynchronously with
group commit off the UI/render thread, and slow disks show "storing…" rather
than blocking; heavy derived work (bake, compaction, index rebuild) is a
background, coalesced, cancellable job; the "All changes stored" indicator
reflects true durability with a bounded lag and a loud failure state
(file-project FP-D2). Named gates: commit-latency p95 budget on the
interaction tier, zero journal writes during a scripted drag, indicator-lag
budget (X6, tunable). Additionally an automatic "Session start" snapshot
marker is created on open so "discard everything since I opened" is one
restore away.

### D2 — Ribbon taxonomy

**Decision:** Domain-based tabs as the owner sketched: **File, View,
Pointcloud, Draw, Mesh, BIM, Raster** (+ Plan and Agent as File-launched
windows per the owner's list). The current workflow tabs are remapped:
Import → File; Select/Inspect actions → contextual surfaces + View;
Segment → Pointcloud; Output → File (export) and Plan. Terrain/surface
functions live in Mesh unless the dossiers show reference products separate
them, in which case a Terrain tab may be proposed with evidence.
**Derivation:** owner statement 2026-09-01 ("schon so ungefähr wie zuletzt
beschrieben"); X4 (RIB Civil and RealWorks group by data domain).
**Rejected:** keeping the current workflow taxonomy (owner-overridden).
**Tunable:** exact group/button placement within tabs.

### D3 — Specifications are generative (resolves `docs/OPEN-QUESTIONS.md` Q2)

**Decision:** Specifications may define geometry-generating behavior, not
only layer/style/property grouping: reusable symbols usable as point symbols,
spacing-based area fills, and Revit-family-like parametric definitions.
Ordinary user attributes remain separated from geometry-driving parameters in
the data model.
**Derivation:** owner statement 2026-09-01 (symbols as point symbols, area
fills); X4 (Revit families are the named reference for specification
management and are exactly this).
**Rejected:** style-only specifications (would fork symbol logic into ad-hoc
per-tool features later).
**Tunable:** no — this is a data-model direction; details come from the BIM
domain spec.

### D4 — Paper space stays plan-composer content (resolves Q3 for now)

**Decision:** Independent paper-space drafting does **not** become a
canonical entity domain. Sheets, sheet drafting, and model viewports remain
plan-composer content (`.hcplan`, to be moved into the canonical project
store as project-owned data). Revisit only if a concrete workflow demands
canonical paper-space entities.
**Derivation:** `docs/CURRENT-DIRECTION.md` scope-freeze philosophy (no
speculative canonical domains); current architecture already has the plan
document model; X4 (Excalidraw/PowerPoint mix per owner, not a second CAD).
**Rejected:** canonical paper-space entities now (cost without a driving
workflow).
**Tunable:** no.

### D5 — Project-as-block import (xref)

**Decision:** Another Himmel:CAD project can be attached as a **canonical
reference entity** (xref-like): read-only, non-editable content, rendered
from the source project's prepared datasets, with per-block display
overrides (original colors or single uniform color, block-wide transparency)
and a re-sync action when the source changed. Automation sees and can attach/
detach/restyle it like any entity.
**Derivation:** owner statement 2026-09-01 (the described feature); X3
(agent parity ⇒ canonical entity, precedent P1); X4 (AutoCAD xref,
RealWorks project neighborhood as established reference behavior); X2
(read-only ⇒ prepared/baked datasets, faster than editable rendering).
**Rejected:** file-level copy-import (loses the link and the read-only
speedup); view-local overlay (invisible to automation, violates X3/P1).
**Tunable:** re-sync policy (manual vs on-open check).

### D6 — Specification codes, shortcuts, and role-based BIM generation (owner statement 2026-09-02)

**Owner statement (recorded verbatim in substance, repo-resident per doctrine
rule 1):** every specification has a number (e.g. 113 = asphalt). A
"specification shortcuts" panel holds any number of pinned specifications;
clicking one makes it current, and every point/line/area drawn afterwards
gets that specification's style and is moved to its layer immediately. The
code structure encodes the object type — e.g. `0941100`: `09` = BIM object,
`41` = stormwater manhole, `100` = width 1 m — so that a field measurement
carrying the code creates a real BIM object at the measured coordinate on
CSV import; the user then picks the measured cover point and the 3D manhole
is generated completely. Lines likewise: a code "inner wall edge, 20 cm"
turns a measured line into a wall object with thickness and fall direction.
Generally: BIM objects are created from CAD geometry by declaring what the
point/line/area represents (floor/ceiling area + room height → room). Sewer
planning (manholes, pipes) runs as real 3D BIM objects under the BIM tab,
with easyBAU export compatibility as a goal. Harmonize with the Revit / RIB
Civil specification systems; keep it uncomplicated.

**Derived directions (vetoable):** (a) the code is the catalog key of a
definition/type row (bim-specs model unchanged: definition → type →
instance; Revit type catalogs, RIB Spezifikationen as evidence). The **code
grammar is user data, not a product rule** (owner correction 2026-09-02,
now precedent P7): each specification catalog defines its own code layout —
which digits encode type, class, or parameters, and whether parameters are
digit-encoded (`100` = 1 m) or carried as attribute suffixes; Himmel:CAD
ships a default specification table as editable data and supports both
grammars; the owner's `0941100` example is a default-table example, not a
mandated scheme. (The first draft recommended attribute suffixes over
digit-encoded parameters as _the_ convention — overridden: that is an
office decision.) (b) the shortcuts panel is a project-persisted,
automation-visible pinned set (P1), consumed by Draw's current-specification

- layer-targeting records (DR-D4, DR-D16) — one canonical "current
  specification" state; (c) role-based generation is a generative
  specification capability (D3): point/line/area + role + parameters →
  canonical BIM object via a journaled command, with a completion workflow
  (pick cover point, give room height); (d) code-driven field import lives in
  import-formats' XYZ/CSV workflow (column mapping gains a code column bound
  to the specification catalog); (e) sewer objects (manhole, pipe run) become
  bim-specs catalog rows; easyBAU export is an import-formats format row
  pending evidence.
  **Rejected:** a product-mandated code convention (overridden by the owner;
  violates P7); per-tool ad-hoc code tables (forks the catalog, D3). Note:
  free-text codes are allowed if a catalog declares them — recognition then
  follows that catalog's grammar.
  **Tunable:** number of shortcut slots (unbounded, default 8 visible), code
  digit layout per prefix (catalog-defined).

### D7 — Owner statements batch 2: interaction, civil, surfaces (2026-09-02)

**Owner statements:** `OWNER-STATEMENTS-2026-09-02.md` S1–S12 (line
drawing, Trimble-Access selection look, global bottom-bar toggles, 3D
target point placement, tri-state layer boxes, plan-editor layout,
embankments/excavation pits, sections and profiles, best-fit alignments,
surface-creation workflow, solids/rasters between surfaces).
**Derived directions (vetoable):** generators G1–G10 in that file; G1 →
contract C1; G2/G3+G4/G8 → doctrine P8/P9/P10; the deferred civil
subsystem (draw DR-D8) is **un-deferred**: a new domain spec `civil`
(alignments with best-fit from edge polylines, gradients in profile views,
width bands, corridor surfaces, embankments/pits, long/cross profiles with
the live-or-stale rule) is written; mesh-terrain, view-domain (sections
from a line with direction/depth and an arrowed specification), pointcloud
(grid sampling modes), ui-platform (bottom bar, selection look, tri-state
nodes, selection modes, 3D cursor), draw (tri-modal line/point input),
plan-editor (infinite canvas + floating islands), select-edit (support
geometry) receive amendments from the gap analysis
`OWNER-STATEMENTS-2026-09-02-GAP.md`.
**Rejected:** treating the statements as one-off feature requests (they are
generators; X7).
**Tunable:** per the receiving specs.

### D8 — Release definitions and token discipline (2026-09-02 late)

**Owner statement:** Release 1.0 = the "Trimble RealWorks starter" outcome
(S16) plus Gaussian-splat display. Question: does a useful Release 0.5
exist, or is its foundation already 90 % of 1.0? Concern: 10 % of the weekly
Codex budget went in four hours at the top tier.
**Derived decisions (vetoable):** (a) **Release 0.5 "Viewer-plus"** —
internal alpha (owner + one friendly office, no public packaging): fast
import of the existing formats, fluid view with the performance HUD and
presented-frame gate, viewing box with lock/bake, display properties
(height/intensity/classification), measurement basics (point, 2D/3D
distance, Δz), segmentation/extraction, project lifecycle with snapshots and
the Save control, export UI. Derivation: the expensive foundation (render
core, canonical core, importers/exporters, registration backend) already
exists — the exploration finding; 0.5 = substrate + one useful vertical
slice ≈ 35–40 % of 1.0, entirely on the 1.0 dependency path (no throwaway).
(b) **Release 1.0** = S16 + splat display (render provider exists; wiring +
display properties). (c) **Token discipline (TEMPORARY — owner: until more inference is affordable; revisit when revenue or budget allows, then restore high-effort defaults and parallel lanes). Owner 2026-09-02 late: applies to BOTH sessions (PhotoLab too); hard floor — at least 10 % of the weekly Codex budget must remain until the reset in one week; remaining Grok budget may be spent freely on mechanical work. Measured: this session's 54 Codex runs consumed ~15.2 M tokens; the top consumers were the three registry reconciliation passes (0.55–0.87 M each), the master plan, full-spec reviews and revisions (0.4–0.47 M each) — exactly the classes the discipline removes.** no speculative spec rounds —
specs change only from implementation findings (doctrine rule 2); one
demanding-user review per implementation slice; an implementer brief
replaces the ten-document reading list; reasoning effort `medium` by
default, `high` for reviews and design-heavy substrate slices; a
deterministic registry linter (I-07) replaces LLM registry rebuilds; three
lanes, not six. Rough budget: 0.5 ≈ one weekly Codex budget; 1.0 ≈ 1.5–2
with the levers.
**Rejected:** a public 0.5 (installer/updater/docs cost not on the 1.0
path); six-lane parallelism (spends tokens for wall clock the owner does
not need).
**Tunable:** the 0.5 slice list at the edges; effort defaults per task
class (X6).

### D9 — Fastest path to a paying product (2026-09-02 late; strategy candidate for the owner)

**Owner statement:** the owner's daily TRW work is ~90 % line drawing,
terrain extraction, DGM creation, DGM editing; the "Viewer-plus" 0.5 cut
would miss most of that value. Core question: what is the fastest path to a
product that earns money to fund inference — Builder, PhotoLab, or the
owner's other projects (Fernwork: free client-side office tools on
Cloudflare, no monetization; SupraBench: AI-model rankings with Stripe API
tiers implemented but demand-gated, last commit June 2026)?
**Architect assessment (vetoable):** Fernwork and SupraBench need traffic
and marketing, not code — income months away and small; keep both alive at
zero development budget. PhotoLab's market is the hardest (RealityCapture
free for small firms, WebODM/Meshroom free, Metashape Standard ~180 $):
finish R1 with no scope growth and position it as a free funnel, not the
revenue source. Builder is the only path where the owner knows the market,
has pilot customers in reach, dogfoods daily, and replaces a licence that
offices pay thousands for. **Recommendation: re-cut Release 0.5 as "DGM aus
Scan"** — import → fluid view + HUD → viewing box with lock → ground
extraction → sampling/rasterize → lines with snapping (breaklines, boundary,
tri-modal input) → DGM window with error fixing → DGM editing (region
smoothing, downsampling) → DXF/LandXML export (exists) + measurement basics.
Excluded from 0.5: classification beyond ground, station view,
registration UI, civil, specifications, plan editor, BIM. ≈ 45–50 % of 1.0,
all on the 1.0 path; estimate 1.5–2 weekly Codex budgets, 2–3 weeks with
three lanes, usable at starter level; builds for the owner and 2–3 pilot
offices, no installer/updater. Inference levers: cheaper models for
mechanical slices, high-tier only for substrate design and reviews; the
temporary discipline stays until revenue or budget allows more; first
revenue = pilot offices at a founder price once "DGM aus Scan" runs.
**Status:** ACCEPTED by the owner 2026-09-02 late ("ich denke das sollte
unser Ziel sein"), with two additions: (i) the commercial target is a
**bundle** — PhotoLab (production-ready) + the Builder alpha ("DGM aus Scan")
sold together to pilot offices; (ii) go-to-market position: source-available
(restrictive license) with a transparent roadmap — "free surveyors from the
Trimble/Autodesk stranglehold; buy now and we build the ultimate CAD for a
fraction of the cost" — the specs and registry double as public roadmap
evidence. Architect caveats recorded: no public dates; the delivered core
must be daily-usable at the first customer; PhotoLab R1 gates must be
executed, not asserted (adoption audit finding 4). Model routing: a cheaper
model (gpt-5.6-terra) is trialled only on mechanical slices with machine-
checkable DoD, A/B-measured (I-03 vs I-02) before any broader routing.

### D10 — Website and trust-based free tier (owner statement 2026-09-02 late)

**Owner statement:** build a Himmel:CAD website in parallel; without one no
money arrives. Subtle messaging: "get out of the Autodesk stranglehold". A
trust-based free tier from the start — private use, testing, and offices with
fewer than three people — to be likeable and sharpen the message against the
big, greedy vendors. Site limited to the necessary. Style inspired by
lawn.video, with our own spin: an anime sky as the background instead of the
lawn, and our stylized Japanese-style fonts.
**Derived directions:** static site (no backend; Cloudflare Pages like
Fernwork) under `website/` in this repo, German primary for the German
surveying market with an English toggle later; sections: hero, products
(PhotoLab, Builder alpha "DGM aus Scan", bundle), pricing (free tier as
stated; founders' program for pilot offices with a waitlist — mailto until a
form backend exists), transparent roadmap (linking the public specs/registry
as evidence), source-available license, Impressum/Datenschutz (German legal
requirement). Assets: branding/logos/source/\*.svg (masters, never modified),
fonts from packages/@himmelcad/theme/src/fonts (Kamikaze, HC Wordmark).
Built on the Grok budget (D8: mechanical, machine-checkable — HTML validity,
Lighthouse/a11y, link check). No public dates on the roadmap.
**Pricing (owner-confirmed 2026-09-02 late, "hört sich gut an, prominent aber das Free Tier"):** the Free tier is the most prominent element of the pricing section (private use, testing, offices under three people — 0 €, trust-based, no licence check); Founders' bundle for pilot offices **79 €/month per office (790 €/year), price locked for life**; later list price 149–199 €/month per office (still a fraction of TRW/Civil 3D); optional Supporter tier 20 €/month for individuals who would be free but want to contribute. Per office, never per seat.
**Owner answers 2026-09-02 late:** the architect writes the LICENSE amendment (the current text is LLM-written too); a public source mirror is not needed for the start — uploading binaries (.exe etc.) is enough, so the site must not claim public source until a mirror exists ("Quellcode einsehbar auf Anfrage"; downloads with Release 0.5); the Impressum is copied from the owner's Fernwork site. SupraBench is live, polished, and auto-updated every two days (the local checkout is stale) — the D11 assessment stands per the owner.
**Done by the architect 2026-09-02 late (owner delegation):** the repository LICENSE's Additional Use Grant now states the free tier in writing (private/non-commercial; evaluation and testing; production by organizations with fewer than three people, trust-based, written confirmation may be requested) and the Production Use paragraph matches. Caveat recorded: have a lawyer read the LICENSE once before the public release — this is licence text, not legal advice. Previously: the Additional Use Grant had to state the free tier in writing (private use, testing, offices with fewer than three people incl. owner) — a legal-document change only the owner makes; until then the site says the free tier is granted in writing by e-mail and the repository licence governs. Also: publish the public source mirror URL (ADR 0029 names a public GitHub mirror) before the site claims "Quellcode öffentlich"; fill Impressum data and the contact mailbox.
**Tunable:** free-tier boundary (<3 people); supporter tier existence.

### D11 — SupraBench and Fernwork re-examined (architect assessment 2026-09-02 late, for the owner)

**Facts checked:** Fernwork's PDF audit (2026-09-01/02) rates the tested
scope "Release-Candidate" but explicitly NOT PDF-XChange parity (no
permanent content/layer panel, several P0 classes were fixed, one P0 —
restricted-PDF export unreadable in standard readers — is listed; the audit
itself says a green functional suite is not a sufficient maturity
criterion). SupraBench: API paid tiers implemented and demand-gated; data
and code untouched since June 2026 (leaderboard stale).
**Assessment:** (1) SupraBench — the "AI bubble money" outcome requires
traction, and traction for a leaderboard in 2026 requires a _finding_, not
a site: one reproducible data story ("which popular benchmarks are
saturated/contaminated, with numbers") launched on HN / r/LocalLLaMA /
r/MachineLearning costs a weekend of data refresh (cheap models/Grok) and
zero Codex budget; keep API tiers dormant; decide after measuring the spike.
Probability of money: low; cost of the test: near zero — worth exactly one
try, not a strategy. (2) Fernwork PDF — a privacy-true, no-upload editor is
a real angle (GDPR, German market) but the paid PDF market is crowded
(PDF-XChange ~55 $, PDF24/Stirling/iLovePDF free); a 5 € app-store SKU needs
thousands of buyers and store discovery we cannot buy. The cheap, coherent
move: package Fernwork as a desktop app with the Electron shell Himmel:CAD
already has, ship it INSIDE the Himmel:CAD free tier and founders' bundle
("office tools for surveyors" — plans, reports, PDFs), and sell a one-time
Fernwork Desktop/Pro (5–9 €) via Gumroad/Lemon Squeezy (no store fees or
developer accounts) for everyone else; distribute for free where the honest
story lands: Show HN, r/privacy, AlternativeTo, the Chrome Web Store (5 $
one-time), German privacy/tech press. Finish the listed P0 first (restricted
export) — on Grok. (3) Himmel:CAD — Reddit is right but not enough: German
surveyors are on LinkedIn/XING, in Vermessungs-Foren and at DVW/BDVI events;
the highest-converting zero-cost asset is a 3-minute screen recording of
"Punktwolke → DGM" done by a surveyor (the owner) plus direct outreach to
five known offices. **Sequencing:** Himmel:CAD 0.5 first; Fernwork Desktop
rides the same bundle launch; SupraBench data story as a one-weekend side
bet when Builder work is waiting on builds. No Codex budget for (1)/(2):
Grok only.
**Status:** for the owner's veto; nothing here reorders the Builder queue.

## Genuine owner questions

### Q1 — Execution priority after planning

`docs/CURRENT-DIRECTION.md` currently binds: PhotoLab release first; broad
Builder feature expansion must not displace it. The plan we are writing is
compatible (planning is not implementation), but the moment it is finished
this becomes acute: **may Builder implementation work start immediately in
parallel to PhotoLab release work, or does PhotoLab retain exclusive
implementation priority until released?**
This is a scope/priority call reserved to the owner (escalation rule 3).
**Recommendation:** Builder implementation starts immediately, but the first
implemented tranche is the iteration-speed package and shared-platform work
(benefits PhotoLab too); pure Builder features queue behind PhotoLab release
gates. Update `CURRENT-DIRECTION.md` accordingly.

## Status

| Item     | Owner response                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1       | pending                                                                                                                                                         |
| D2       | pending                                                                                                                                                         |
| D3       | pending                                                                                                                                                         |
| D4       | pending                                                                                                                                                         |
| D5       | pending                                                                                                                                                         |
| D6       | owner-stated 2026-09-02; derived directions pending veto                                                                                                        |
| D7       | owner-stated 2026-09-02; generators pending veto; civil domain un-deferred                                                                                      |
| D8       | derived 2026-09-02 late; Release 0.5 "Viewer-plus" + 1.0 definition + token discipline (temporary) — pending veto; 0.5 cut superseded by D9 if the owner agrees |
| ADR 0030 | rev 6 (9d4d398) conformant by mechanical verbatim check; Proposed — owner acceptance pending                                                                    |
| D11      | architect assessment 2026-09-02 late — SupraBench/Fernwork re-examined; sequencing proposal — pending veto                                                      |
| D10      | owner-stated 2026-09-02 late — website + trust-based free tier; built on Grok                                                                                   |
| D9       | ACCEPTED 2026-09-02 late — Release 0.5 = "DGM aus Scan"; bundle PhotoLab + Builder alpha; source-available roadmap GTM                                          |
| Q1       | pending                                                                                                                                                         |

## D8 addendum (2026-09-05)

Owner: a second full Codex reset — spend more tokens where it does not cost calendar time; trial `gpt-6-astra` on one work package and decide by tokens × price versus quality whether to keep it. Standing instruction: commit **and push** continuously from now on (logical groups per landing, no owner ask). Owner decides high-level only; anything else is derived and reported here.

## D8 addendum (2026-09-04)

Owner: Codex budget effectively 180 % of a weekly limit (a full reset is available). Consequence: token discipline relaxes from "park packages" to "spend on the queue": up to three Builder-lane runs in parallel, `high` effort for design/research and reviews, `medium` for implementation; the 10 % floor and the ledger stay. Owner statement S21 also extends G17 (architect reviews every Codex UI by eye, pixel-specific UI briefs) explicitly to the PhotoLab lane.

## D9 addendum (2026-09-03)

Owner statement S21: segmentation is part of Release 0.5 (slice 0.5-02a). D9 scope table in MASTER-PLAN §0a amended.

## D12 — Release 0.5 data-model admissions (ADR 0031, Proposed; vetoable)

Status: architect-derived under MASTER-PLAN §9.7 (vacation posture); implementation of the admitted items is authorized as vetoable substrate work (S-01); owner acceptance of `docs/adr/0031-release-0-5-data-model-admissions.md` pending.

| Registry §4.4 item                            | 0.5 disposition                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1 saved measurements                          | admit a basic profile (point, distance, height difference)                            |
| 3 ViewState v2                                | admit the 0.5 profile (entity clip refs, VD-D8 display); Plan viewport state deferred |
| 5 snapshot markers                            | admit                                                                                 |
| 6 derived recipes + mesh source roles         | admit                                                                                 |
| 7 point acquisition + support role            | admit; offset/parallel recipe deferred to 1.0 (split/trim/parallel)                   |
| 11 stable segment locator                     | admit (moved in: MASTER-PLAN §5 S-B2 requires it for `G-B2-SEGMENTS`)                 |
| 12 local histories (selection/display/camera) | admit                                                                                 |
| 2, 4, 9, 10                                   | defer to their named 1.0 milestones; 8 stays under ADR 0030                           |

Nine line-item decision records (ADR31-D1…D9) sit at the end of the ADR for line-by-line veto. All 16 spec citations in the ADR were verified verbatim by script (2026-09-02). Veto path: strike a row here or in the ADR; S-01 work on a struck item is reverted, not argued.
