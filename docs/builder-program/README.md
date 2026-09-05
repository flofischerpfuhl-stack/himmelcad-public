# Builder completion program

Status: active program, started 2026-09-01. Goal: a comprehensive
implementation plan covering all Builder functions, produced 2026-09-01 to
2026-09-03, then largely autonomous execution.

This directory is a **plan** in the sense of `docs/README.md` document
classes: it is never evidence that work exists. Normative rules stay in their
authoritative documents; resolved owner decisions get promoted to
`docs/OPEN-QUESTIONS.md` removals, ADRs, or `docs/DECISION-DOCTRINE.md`
precedents.

## Structure

- `OWNER-DECISIONS.md` — the batched owner confirmations and questions, with
  status. The owner reads and vetoes; answers are generalized into doctrine
  precedents.
- `dossiers/` — reference-product research (RealWorks, RIB Civil, Revit,
  Trimble Perspective/Access): function catalogs and workflow descriptions
  with sources. Dossiers are evidence for X4 derivations, never normative by
  themselves.
- `specs/<domain>/` — domain specifications. Two resolutions:
  1. **Contract level** (every function): catalog entry + answered function
     contract (`docs/FUNCTION-CONTRACT.md`) + decision records. Sufficient to
     detect cross-function conflicts and inconsistency project-wide.
  2. **Workflow level** (near implementation horizon): full user-perspective
     workflow narrative, reviewed by the `demanding-user` agent before the
     owner sees it.
- `REGISTRY.md` — the function registry: one row per function (id, ribbon
  place, access paths, surface type, performance class, automation command,
  spec link, status). The cross-checking artifact.
- `MASTER-PLAN.md` — sequencing, milestones as user outcomes, dependency
  order, and the autonomous-execution protocol. Written last.

## Rules

- Every spec walks `docs/FUNCTION-CONTRACT.md`; every decision follows
  `docs/DECISION-DOCTRINE.md` and carries a decision record.
- Specs are written from the CAD user's perspective; the owner reads
  workflow narratives and registry tables, not code plans.
- The `demanding-user` review runs before owner review; unresolved blockers
  block, owner-decision items follow the escalation protocol (target zero).
- Registry rows are written at specification time, not assembled later. A
  spec that touches a capability another spec has dispositioned must cite
  and revise that spec's decision record — never disposition it a second
  time. Standing registry checks: no two rows claim the same act; no two
  specs claim the same surface, gesture, or state with different
  guarantees. (Evidence: bim/draw symbol-model contradiction; view/
  pointcloud display-ownership contradiction — both undetected pre-registry.)
- A catalog row in a spec that does not own the capability is an
  access-path/consumer row and must carry `owner: <spec-name>` at the
  start of its Spec-link cell (for example
  `owner: mesh-terrain; CIV-D5 access path`). The registry linter
  (`scripts/registry-lint.mjs`) excludes those rows from duplicate-id and
  spec-versus-registry definition checks and enforces
  `consumer-rows-point-to-owner`: the named owner spec must catalog the
  id.
- A spec's status is "specified" only once its catalog rows exist in
  `REGISTRY.md` and the registry consistency report shows no open finding
  against it; until then it is "drafted". (Evidence: raster review
  2026-09-02 — the spec called itself specified while the registry still
  listed measurement and raster rows as absent.)
- A change to the contract or doctrine invalidates the "specified" status
  of any spec not yet reviewed against the changed version; the spec is
  re-walked against the new rules before it counts again.
- A slice with user-visible UI carries an architect-written visual brief
  (layout, sizes, spacing, states, tokens, reference or mockup) in its
  prompt, and counts as landed only after the architect has reviewed
  rendered light and dark screenshots of it (G17, owner statement S21
  2026-09-03). The shared component gallery under `packages/@himmelcad/ui`
  is the review surface; a slice that adds or changes a shared control adds
  or updates its gallery fixture.
