# Function design contract

Status: draft for owner review (2026-09-01). Once accepted, this contract is
normative for every new or reworked user-facing Builder function, and applies
to sibling apps where their domain allows it.

## Purpose

The owner's corrections on past features were almost never one-off wishes; they
were instances of general standards that had not been written down. This
contract turns those standards into questions that a specification author and a
reviewer must answer _before_ the owner sees the result. The goal is that the
owner reads finished workflow specifications and vetoes rarely, instead of
supplying the same class of correction repeatedly.

This contract does not replace `AGENTS.md` or `docs/DESIGN-SYSTEM.md`; it
operationalizes them per function and adds design-generative questions they do
not contain. Where a question is already covered by a normative document, the
answer may be a reference plus the function-specific specifics.

## When to apply

- When writing or revising a function specification or workflow plan.
- When reviewing an implementation for completion (see
  `docs/CURRENT-DIRECTION.md` "Completion discipline").
- The `demanding-user` review agent (`.claude/agents/demanding-user.md`) walks
  this contract adversarially; an answer of "not applicable" must say why.

Answers belong in the function's specification document. Trivial functions may
answer briefly, but must answer; the cheap questions are the ones that were
historically skipped.

This contract asks the questions; `docs/DECISION-DOCTRINE.md` governs how they
are answered without the owner. Escalation follows its protocol, not the
author's comfort.

## A. Purpose and reference grounding

**A1 — User outcome.** Describe the workflow from the CAD user's perspective,
start to finish, in prose: what the user has, does, sees, and ends up with.
This narrative is the owner's primary review surface.

**A2 — Reference behavior.** How do the reference products solve this?
Point clouds: Trimble RealWorks. CAD/Civil: RIB Civil. Specifications/BIM:
Autodesk Revit. Viewing/navigation: Trimble Perspective and the current
Himmel:CAD viewport. State what we adopt, what we deliberately do differently,
and why. "The reference has nothing comparable" requires evidence of having
looked. A function catalog proposal for a whole domain derives from the
reference products' catalogs, then gets owner-pruned.

Evidence precedes specification: every reference claim cites the specific
section of a repo-resident dossier (`docs/builder-program/dossiers/`) or
other repo-resident evidence — doctrine auditability rule 1 applies to spec
claims, not only to decision records. A claim whose evidence does not exist
yet is flagged unresearched, and the spec is not "specified" until it is
resolved. (Evidence: pilot spec 2026-09-01 asserted three reference claims
its later-written dossiers contradicted.) The same rule covers code:
every "exists today" claim in a status column or implementation delta cites
file:line, and a cited stub or `@deprecated` surface counts as not existing.
(Evidence: draw review 2026-09-01 finding 2 — a workflow rested on a snap
provider whose file says "STUB … returns no candidates".)

When a domain catalog derives from a reference dossier, every dossier
catalog row gets a disposition — adopted, deferred with reason, or rejected
with reason — so omissions are decisions, not accidents. (Evidence: draw
review 2026-09-01 — clothoids, dimension chains, and drafting-time styling
were dropped silently.)

A reference claim with no dossier line item is automatically unresearched —
even when phrased as an absence or an implied behavior. Extend the dossier
first (doctrine rule 2), then cite it. An absence claim ("no reference
documents X") is checked against the whole dossier, not named sections.
(Evidence: pointcloud review 2026-09-01 finding 3 — "RealWorks merges
implicitly" was invented over a dossier gap; view review 2026-09-02 finding
3 — "checked §2.10" missed saved view stations in §2.6, two tables away.)

**A3 — Sibling functions.** Which existing Himmel:CAD functions are the
nearest relatives? Name the UI patterns, shortcuts, copy, and parameter
conventions that must stay consistent with them, and check whether the sibling
should gain the same improvement. A sibling-behavior claim must cite the
handler or surface _and_ state its actual semantics, verified by reading the
flow — not inferred from a function name. (Evidence: file-project review
2026-09-01 finding 5 — "match PhotoLab" cited real code lines whose lifecycle
semantics were the opposite of the claim.)

## B. Access and lifecycle

**B1 — Reachability matrix.** For each access path state present/absent and
why: ribbon; entity context menu; viewport quick surface / mini toolbar;
console command; automation command (AI agent and Python SDK); keyboard
shortcut. All paths resolve to the same canonical command or query. Absence
from automation is a decision to record, not a default — except for
user-only trust surfaces (approval responses, confirmation grants,
credentials), which must be absent from automation by construction (X3,
ADR 0024). (Evidence: agent review 2026-09-02 — automation could call
`agent.approval.respond`.)

**B2 — Open/close symmetry.** Every surface that can open the function can
close it: the ribbon button toggles, the panel or island has an explicit close
affordance, Escape behaves as specified in `docs/DESIGN-SYSTEM.md` "Complete
user flows". Specify what closing means: cancel, commit, or keep-alive in
background.

**B3 — Surface choice.** Choose and justify: inline action (no surface);
right-side function panel (required when the user must keep interacting with
the viewport while adjusting parameters); floating island (focused multi-step
work); dedicated resizable window (spatially dense editing workflows with
their own selection, error lists, or canvases — e.g. surface creation, plan
composition). If the function outgrows its chosen surface in the spec's own
workflow narrative, the choice is wrong.

## C. Interaction contract

**C1 — Numeric parity.** Every direct manipulation (drag, handle, gizmo) has
an equivalent numeric input, and both stay live-synchronized. Every numeric
value that the function displays can be typed, not only dragged. Units and
precision follow project settings. Every coordinate-bearing continuous
input that has a numeric representation is tri-modal: pick, constrained
pick (angle/length/slope snaps), and typed; topological or entity picks
state their inapplicability explicitly. Any vertical value offers absolute
Z, relative ΔZ, and slope; a live preview follows the cursor; the shared
construction input bar (draw DR-D1) mirrors the pending geometry in
cartesian and polar terms; Tab focuses and traverses that bar without
moving the cursor, and Up/Down cycle candidates while the candidate
indicator is live. (Evidence: owner statement S1 and follow-up
2026-09-02; gap analysis §12 G1.)

**C2 — Selection semantics.** What does the function do with the current
selection? Does it operate on one entity, many, or a pre-selected set captured
at launch? For multi-select, define shared/mixed property behavior. Define
what happens when the selection changes while the function is open.

**C3 — Freezability.** What state can the user explicitly freeze or lock, and
what does the implementation gain from it? A locked state is an invariant the
implementation must exploit: precompute, cache, drop per-frame work, or bake a
reduced dataset. If a tool has an expensive live-preview mode, a lock that
trades editability for speed must be considered and either specified or
rejected with a reason.

**C4 — Persistence and undo.** Is the function's state worth naming, saving,
and restoring — per project, globally, or as a reusable library item? Which
actions are canonical journaled commands (undoable), which are view-local, and
is that split defensible to a user who presses Ctrl+Z? Any operation that
restores or rolls back state must define its affected-state set explicitly:
what rolls back, what is exempt, and why the exemptions are safe. Exiting
or clearing a temporary mode (isolate, hide-selection, a transient filter)
is itself a restore-scope operation and must define what it restores.
When undo must retain heavy immutable data (re-imported clouds, bakes,
captures), state the physical retention roots, peak storage during the
operation, when retention is released (undo horizon, snapshot reachability),
and the interaction with project maintenance/GC (X2 spends disk, but the
cost is named, never implied). (Evidence: file-project review 2026-09-01
finding 1 — snapshot restore erased its own safety snapshot because the
restore scope was never defined; select-edit review 2026-09-02 — isolate
exit left visibility restore undefined; import-formats review 2026-09-02 —
exact undo of an 80 GB re-import had no retention or peak-disk guarantee.)

## D. Performance and feedback

**D1 — Performance budget.** Classify every interaction the function offers:
continuous (must hold the interactive frame budget on the active hardware
tier), bounded (< 1 s, needs a busy state), or long-running (needs progress
and cancellation per `docs/DESIGN-SYSTEM.md`). For continuous interactions,
name the measurable gate (existing benchmark, scale-gate burst, or a new
script) that the implementing agent can run without the owner. A continuous
interaction without a runnable gate is not specifiable as "smooth". For
long-running work, name the budgets for its extreme member (X6 tunable):
time-to-first-progress, cancellation response bound, peak memory/disk, and
what "complete" means (e.g. a 500M-point plan capture, a whole-project
re-import) — "long-running with progress" alone is not a specification.
Multi-minute jobs also state their behavior across app restart and crash:
checkpoint/resume, discard-and-restart, or refuse-to-start-without-budget —
and never leave partial canonical results (P5, design-system cancellation
rule). (Evidence: plan-editor review 2026-09-02 — a 500M-point viewport
capture had no latency, cancel, resource, or completion budget; mesh-terrain
review 2026-09-02 — 20-minute triangulation had no restart behavior.)

**D2 — Degradation.** State the behavior on weak hardware: which quality
governor tier applies, what degrades first, and what never degrades
(correctness, input responsiveness).

## E. Quality and verification

**E1 — Visual quality.** The spec names what the surface should look like by
reference (existing Himmel:CAD surface, reference-product screenshot, or
mockup). The named reference artifact — image, mockup, or written comparison
criteria concrete enough to fail against — must exist in the repository when
the spec is marked specified; a described-but-uncommitted reference does not
count. Implementation review includes an actual screenshot compared against
that reference, not only passing tests. Design tokens only; no one-off
chrome. (Evidence: viewing-box corrections 2026, twice.)

**E2 — Conflicts and failure.** Apply SYSTEM-001 (`docs/AGENT-FEEDBACK.md`):
which concurrent operations are coordinated, serialized, or rejected; what
happens on failure mid-operation; what state survives a crash. Additionally,
name every consumer of the state this function manipulates — render passes,
picking/snapping, tools, selection, exporters, sibling surfaces, automation —
and specify the function's effect on each. Passive readers of shared state
cause defects as surely as concurrent writers. (Evidence: pilot review
2026-09-01 findings 1 and 3, both "who else consumes the clip volume".)

For every rule that governs a class of entities, surfaces, or inputs, name
the largest and the least typical member of that class and state the rule's
effect on each — a rule proven only on the narrative's example entity is
unproven. (Evidence: ui-platform review 2026-09-01 findings 1/2/9 — selection
and Escape rules written for walls, parameter fields, and tool panels broke
on the point cloud, the chat input, and the persistent island.)

If the function arms a tool or mode that claims viewport input, name every
gesture it claims while active (LMB, RMB, wheel, Tab, Escape, typing) and
reconcile each against the platform gesture map (ui-platform spec) — two
specs claiming the same gesture is a registry-level defect. (Evidence: draw
review 2026-09-01 findings 4/5 — Tab triple-booked, vertex clicks vs
click-select unarbitrated.)

**E3 — Verification plan.** For each answer above that makes a claim, name the
test, benchmark, or manual check that proves it, per `docs/TEST-TIERS.md`.
Claims without a check are listed explicitly as unverified.

## Worked example: the viewing box

The viewing box (clip-to-box) went through six owner correction rounds. Each
correction maps to a contract question that would have raised it up front:

| Owner correction (historical)                                                                   | Contract question                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| "Make the drag interaction smoother"                                                            | D1 — continuous interaction needed a named frame-budget gate before being called done |
| "It still does not look good"                                                                   | E1 — no visual reference was specified, so nobody compared against one                |
| "You could lock it — then the boxed content is effectively a small point cloud and much faster" | C3 — the freezability question generates the lock feature and its performance payoff  |
| "It opens in the right panel but I cannot close it there, nor from the ribbon"                  | B2 — open/close symmetry                                                              |
| "I want to type extents, center, and rotation by hand"                                          | C1 — numeric parity                                                                   |
| "I want to save boxes for later"                                                                | C4 — persistence and naming                                                           |

The contract would additionally have raised: move-by-drag is unreachable while
the API supports it (C1 parity in the other direction), there is no automation
command for the viewing box (B1), and no benchmark asserts drag smoothness in
CI (E3).

## Evolution

This contract grows by the `docs/AGENT-FEEDBACK.md` workflow: when the owner
corrects a design, generalize the correction, add or sharpen a question here
with the concrete case as evidence, and never require the same correction
twice. Questions without at least one motivating case should not be added;
this document must stay short enough to be applied, not admired.
