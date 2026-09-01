# Open product and architecture questions

This file contains unresolved owner decisions only. Resolved decisions belong
in the relevant normative document or an ADR.

## Licensing

### Q1 — Final product license

Is the final license exactly Business Source License 1.1, including its change
date and change license, or a custom source-available commercial license?

Until resolved, repository license files and `docs/DEPENDENCY-POLICY.md` define
the enforceable boundary. Marketing must not make a legally stronger claim than
the license text.

## Builder semantics

### Q2 — Specifications

Do specifications primarily group layer/style/property rules, or may they also
define geometry-generating Civil behavior? Implementation must keep ordinary
user attributes separate from geometry-driving parameters until this is
decided.

### Q3 — Paper-space model

Should independent paper-space drafting become a canonical entity domain, or
remain plan-composer/view content connected to canonical model-view
descriptors?

## WeltView delivery

### Q4 — Large-project distribution

Which modes ship first: complete client download, static HTTP range streaming,
or a hosted backend? The shared format and viewer remain compatible with all
three until the product gate.

### Q5 — Initial mobile-browser support

Is mobile browser use a first-release requirement or a compatibility target
after desktop browser release?

## Rendering quality

### Q6 — Transparency tiers

Which transparency modes are required for large textured meshes and splats on
each hardware tier? Correctness and performance gates must be defined before a
quality mode is presented as supported.

## Cap release

### Q7 — Validated accuracy claims

Which absolute and relative accuracy statements may be used after the agreed
field-validation datasets have passed? Until then, Cap reports measured quality
and uncertainty without a marketing guarantee.

### Q8 — Distribution channels

Which store, enterprise, and sideload channels are required for the first Cap
release?
