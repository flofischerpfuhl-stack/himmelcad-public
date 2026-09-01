# Himmel:CAD Cap product definition

Status: implemented mobile MVP; field validation and release hardening pending.

## Mission

Himmel:CAD Cap lets people without surveying training capture real-world scenes
with a phone, understand the quality of that capture, and create one `.hcap`
session for PhotoLab.

Cap is the field front end of the PhotoLab pipeline. It is not a CAD editor, an
on-device reconstruction suite, a professional RTK controller, or a replacement
for survey control where the required accuracy demands it.

## Audience and use cases

Primary users are construction and field crews who need a simple capture flow
for site conditions, progress, excavations, installations, façades, rooms, and
other scenes that will be processed in the office.

The primary loop is:

```text
choose project -> capture -> review quality -> package -> transfer -> PhotoLab
```

Projects organize site work. A job is one capture session and produces one
`.hcap` package.

## Product priorities

1. Operator simplicity.
2. Capture reliability and data preservation.
3. Honest quality feedback.
4. Useful absolute and relative accuracy.
5. Visual polish.

Performance remains a family-wide requirement, but Cap may prioritize capture
integrity over immediate packaging speed. Packaging and upload must not block a
new safe capture when resources allow both operations.

## Product contract

- Android and iOS share one Flutter UI with targeted native camera and sensor
  channels.
- Product UI is English.
- The phone-only path is complete without a mandatory external receiver or
  mandatory GCP workflow.
- Dual-frequency GNSS and correction data are used when supported, with explicit
  quality and uncertainty.
- Smart stills preserve original image evidence and timing.
- Stopping a capture produces or retains a recoverable job; navigation must not
  silently destroy a session.
- `.hcap` is versioned, checksummed, portable, and importable by PhotoLab.
- PhotoLab owns reconstruction, CRS decisions, dense products, GCPs, and final
  quality reporting.

## Accuracy policy

Cap reports observed positioning tier, fix state, estimated horizontal and
vertical uncertainty, capture coverage, and relevant device limitations. It
does not turn numeric resolution or a transient RTK state into a guaranteed
project accuracy claim.

Marketing accuracy statements remain blocked until repeatable field datasets
have been compared with independent reference measurements through the complete
Cap-to-PhotoLab pipeline.

## Non-goals for the current product

- required external RTK accessories;
- a general survey-controller feature set;
- on-phone dense reconstruction or mesh generation;
- automatic invention of CRS, geoid, scale, or accuracy;
- multi-user project management or a Himmel:CAD-hosted cloud backend;
- CAD editing on the phone.

## Relationship to the family

- **PhotoLab** imports `.hcap`, resolves reference decisions, and reconstructs
  canonical products.
- **Builder** consumes published PhotoLab products as canonical entities.
- **WeltView** may display published results but does not import raw sessions.
- Shared brand, accessibility, command semantics, formats, and validation rules
  apply wherever the mobile platform allows them.

## Success criteria

- An untrained operator can complete the capture and transfer flow without
  hidden setup.
- Interrupted captures and packaging do not lose already safe evidence.
- PhotoLab reproduces the expected images, poses, priors, uncertainty, and
  provenance from golden `.hcap` fixtures.
- Supported devices pass field validation before accuracy claims or broad
  product release.
