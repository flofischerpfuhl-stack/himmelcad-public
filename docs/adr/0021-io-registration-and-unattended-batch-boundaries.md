# ADR 0021: Canonical IO, interactive registration and unattended PhotoLab batches are separate lifecycles

- Status: Accepted
- Date: 2026-07-19
- Depends on: ADR 0018, ADR 0019

## Context

Himmel:CAD needs reusable import/export providers, interactive survey/BIM
placement workflows and configurable PhotoLab processing recipes. Treating all
three as one generic workflow introduces two failures: product UIs begin to own
format logic, and a long-running PhotoLab batch can unexpectedly stop for a
human decision.

The PhotoLab recipe canvas also needs to select an explicit imported DEM when
several surfaces exist. That selection is configuration before execution, not
an interactive processing node.

## Decision

The three lifecycles are distinct:

1. Canonical IO providers probe, stage, validate, report losses and publish or
   export canonical packages. They are app-neutral.
2. Import registration may request CRS decisions, point pairs, manual placement
   or ICP review before committing the staged package. Its saved recipes retain
   methods and parameters but never silently reuse old picks.
3. A PhotoLab batch starts only from a fully resolved, immutable execution
   plan. It never requests user input after `Run`.

PhotoLab recipe templates contain typed nodes, edges and symbolic input slots.
Before a run, the configuration UI resolves every mandatory slot to an exact
project artifact. Ambiguous or missing bindings make the template not ready.
Planning freezes entity revisions, object hashes and parameters. Runtime may
progress, checkpoint, resume, cancel or fail, but it cannot enter a
`NeedsUserInput` state.

GCP measurement, manual masks and other authoring tasks produce versioned input
artifacts before execution. A batch node may consume those artifacts; it does
not open their editors.

## Consequences

- Builder and PhotoLab share providers and canonical transactions without
  sharing product-specific wizards.
- Reusable import recipes with point-picking still require fresh interaction
  for each unresolved import.
- Standard PhotoLab recipes and advanced node-canvas recipes compile to the
  same deterministic execution plan.
- Choosing one of several DEMs is explicit, provenance-bound and complete
  before processing starts.
- Resume never depends on a transient UI continuation or hidden human state.
