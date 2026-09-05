# Decision doctrine

Status: draft for owner review (2026-09-01).

## Purpose

`docs/FUNCTION-CONTRACT.md` makes sure the right design questions get asked.
This document makes sure they get _answered without the owner_. Escalating a
decision to the owner is a failure mode with a target rate of zero; the owner's
role is reading finished workflow specifications, not adjudicating trade-offs
that the written principles already decide.

Agents must not present a decision as an owner call merely because it is
consequential, expensive, or uncomfortable. Consequential decisions with a
derivable answer are decided, recorded, and reported — not asked.

## Axioms

Each axiom names its source. An axiom is not a guideline; inside its scope the
decision is considered already made.

**X1 — Priority order.** Correctness, data integrity, and security are
non-negotiable; below them performance > intuitive UX > aesthetics. Any
trade-off between these layers is pre-decided by the order.
(Source: `AGENTS.md`, `docs/PRODUCT-VISION.md`.)

**X2 — Spend preprocessing, never interaction.** Preprocessing time, memory,
and disk may be spent freely to make subsequent interaction fast. Interaction
smoothness is never sacrificed to save precompute or storage. Corollary: when
the user freezes, locks, extracts, or otherwise reduces working data, the
implementation bakes the reduced dataset so it performs like natively small
data. (Source: `AGENTS.md` "Import and preprocessing may be expensive";
owner precedent P2.)

**X3 — Agent parity.** Anything the user can do, see, create, name, or
restore, the embedded agent and the Python SDK can too, through the same
canonical commands. Therefore deliberately created state is canonical and
journaled by default; view-local state is the justified exception, never the
convenient default. Parity runs both ways: what an agent does is attributed
in the journal and console, and a batch the agent presents as one action is
undoable by the user as one step. The one asymmetry is the trust boundary:
approval responses, confirmation grants, and credential handling are
user-only surfaces that no automation path may invoke (ADR 0024). (Source:
ADR 0019, ADR 0024, `docs/PRODUCT-VISION.md`; owner precedent P1; agent
review 2026-09-02.)

**X4 — Reference default.** Where a reference product (RealWorks, RIB Civil,
Revit, Trimble Perspective — see `docs/FUNCTION-CONTRACT.md` A2) has an
established behavior and no axiom conflicts, adopt it. Deviation requires a
stated reason, not permission. "What would users expect?" is answered by the
reference, not by the owner.

**X5 — Symmetry.** Interactions come in pairs: open/close, drag/type,
do/undo, select/deselect, keep-inside/remove-inside, save/restore. Shipping
one side of a pair is a defect, not a scope decision.

**X6 — Delegated calibration.** Numeric thresholds, budgets, tolerances, and
gate values never escalate. Choose a defensible value, record it as tunable
with its rationale, and tighten it with evidence. (Owner precedent P3.)

**X7 — Precedent binds the class.** A resolved decision applies to its entire
class, not its triggering case. Before deciding, search the precedent register
below and the normative documents; after deciding anything class-shaped,
append it as a precedent.

## Escalation protocol

An owner-decision item is legitimate only when **all** of the following hold:

1. The question survives an honest derivation attempt from X1–X7 and the
   normative documents — and the failed derivation is shown in writing.
2. No precedent in the register covers its class.
3. It is one of: a genuine conflict between axioms; product identity, scope,
   money, or licensing; or a boundary explicitly reserved for the owner
   (`docs/CURRENT-DIRECTION.md` scope freezes, `docs/OPEN-QUESTIONS.md`).

Legitimate escalations are phrased at class level ("where does any named view
artifact persist?", never "where does the viewing box persist?"), carry a
recommendation, and are batched — collected across functions and deduplicated
before they reach the owner. The owner's answer is generalized and appended to
the register, closing the class permanently.

## Precedent register

Format: ID — rule (class-level) — derivation/decider — date.

- **P1** — State a user deliberately creates and would want back (named
  viewing/clipping boxes, view bookmarks, saved section states, saved
  measurement sets, and their class) is stored as canonical entities, visible
  and restorable through automation. — Derivable from X3; owner-confirmed —
  2026-09-01.
- **P2** — Freezing or locking a spatial subset bakes a reduced resident
  dataset; memory is spent for interaction speed. Segmenting data out and
  locking a box around it must feel identically fast. — Derivable from X2;
  owner-confirmed — 2026-09-01.
- **P3** — Performance-gate numbers and similar calibration values are set by
  agents, recorded as tunable, and never asked. — Owner-delegated —
  2026-09-01.
- **P4** — Anything that acts on geometry acts on the visible set: active
  clip volumes and explicit visibility states (hidden classes, hidden
  entities) scope picking, snapping, measurement, selection, and destructive
  applies alike; natural occlusion does not scope anything. — Derived from
  X1 + viewing-box VB-D13, generalized after the pointcloud review found the
  picking-only phrasing let a destructive fence apply slip through —
  2026-09-01.
- **P5** — Persistence cost is never paid on the interaction path: continuous
  gestures journal once at gesture end, never per frame; journal appends are
  asynchronous with group commit off the UI/render thread; heavy data is
  immutable, content-addressed, and written only by explicit progress-
  reporting jobs; the "stored" indicator reflects true durability with a
  bounded lag and an explicit failure state. — Derived from X2 + X1; recorded
  after the owner's concern that auto-persistence on huge datasets would
  interrupt work — 2026-09-02.
- **P6** — Universal affordances survive mechanism changes: when the
  mechanism behind a gesture every reference product has (Save/Ctrl+S,
  Undo, Escape, double-click) changes, keep the affordance and give it an
  honest effect; never remove it because the old mechanism is gone. —
  Derived from X4 + the design-system rule that copy never claims unverified
  state; recorded after the first D1 draft dropped the Save button and the
  owner asked for it back — 2026-09-02.
- **P7** — Office conventions are user data, not product rules: where
  practice varies between offices or users (specification codes and their
  grammar, layer naming, specification tables, symbol libraries, code lists,
  units, report layouts), the product ships a mechanism plus an editable
  default table, never a fixed convention. Agents do not decide such
  conventions; they specify the mechanism, the default, and the import/
  export of the tables. — Derived from X4 (reference products ship
  user-editable Spezifikationen/feature libraries); recorded after an agent
  recommended a product-wide code grammar and the owner corrected it —
  2026-09-02.
- **P8** — Undo is domain-scoped: the document journal, the selection set,
  display/visibility state, and the camera each keep their own history with
  their own undo path; a global display toggle never enters the document
  journal. — Derived from X3/X5 and the existing canonical-vs-view-local
  split; owner statement S3 2026-09-02.
- **P9** — Every visibility node (layer, tree node, entity kind, cloud
  class, attached project) has one interaction state from {hidden,
  reference (visible, snappable, selectable, not editable), editable,
  inert}; parents propagate and show mixed as grey; global toggles are
  defaults that never destroy a per-element choice. — Derived from X4
  (Trimble Access tri-state boxes) and D5 (attached projects are the
  reference state); owner statements S3/S5 2026-09-02.
- **P10** — Derived views and derived entities are live when the mapping is
  cheap and unambiguous (rigid section views; station/offset-defined civil
  geometry; small parametric relations) and otherwise carry a visible stale
  state with explicit synchronization and confirm/discard on view switch —
  never silently wrong, never silently blocking. Derived _entities_ follow
  the same rule with a recipe: linked by default (sources by id + revision +
  parameters), stale at gesture end on source change, regenerated by a
  journaled command (automatic under an X6 cost budget, else explicit or
  batched), detachable at any time with the recipe kept as provenance,
  auto-detached with a console note when a source disappears, recipe graph
  a DAG enforced at command time, regeneration errors reusing the creation
  error list. — Derived from X1/X2 and the plan-editor capture precedent
  (PE-D7); owner statements S8 and S14 2026-09-02.

- **P11** — Product operations reach automation and the console from one
  generated command table: every product capability (Builder, PhotoLab,
  WeltView read-only queries) is a canonical command or query with the
  validate/status/cancel lifecycle, generated from a single command table
  that also drives the console vocabulary and the Python SDK; allowlisting
  raw RPCs is never the exposure mechanism; approval, confirmation-grant,
  and credential surfaces stay user-only (ADR 0024). — Derived from X3 and
  the ui-platform single-command-registry precedent (UIP-D6); raised by the
  PhotoLab release-polish session 2026-09-02 after finding zero photolab.\*
  operations reachable through the automation host allowlist.

## Decision records and auditability

Every consequential derived decision in a specification is recorded where it
is made, in this form:

> **Decision:** what was decided.
> **Derivation:** the axioms (X*), precedents (P*), normative documents, or
> dossier evidence (with source) it follows from.
> **Rejected:** the strongest alternative and why it lost.
> **Tunable:** yes/no — whether this is a calibration value under X6.

Two hard rules keep the chain auditable:

1. **No repo-external norms.** Every rule that influences a design decision
   must live in a versioned repository file: this doctrine, the function
   contract, the review persona, the design system, ADRs, or a reference
   dossier. A decision whose derivation cites no repo-resident source is
   invalid and must be reworked. Prompt-only instructions must not introduce
   norms; if an instruction is worth following twice, it becomes a file.
2. **Wrong source ⇒ fix the source.** When the owner finds a decision wrong,
   the correction targets the cited source (axiom, precedent, dossier), not
   only the decision — so the same fallacy cannot recur from the same file.

## Evolution

When the owner overrides a doctrine-derived decision, that is the most
valuable signal this system produces: the axiom or precedent was wrong or
incomplete. Generalize the override, amend the axiom or add the precedent, and
apply the `docs/AGENT-FEEDBACK.md` workflow. The doctrine must stay short
enough that every agent actually reasons from it.
