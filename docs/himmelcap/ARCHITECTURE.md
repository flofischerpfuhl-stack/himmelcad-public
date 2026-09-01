# Himmel:CAD Cap architecture

Status: current architecture of the implemented Flutter MVP.

## Stack

- Flutter owns the shared Android/iOS UI, navigation, local job catalog, and
  package workflow.
- Kotlin and Swift platform channels expose camera, GNSS, correction, and
  platform services that Flutter plugins cannot represent completely.
- Cap schemas live in `schemas/himmelcap/` and are tested against the Rust
  PhotoLab importer.
- PhotoLab imports through `himmelcad-io`; Cap does not create canonical
  PhotoLab or Builder entities directly.

## Runtime model

```text
Flutter product UI
  project and job catalog
  capture controller
  quality HUD
  package and transfer workflows
       |
Platform channels
  camera / GNSS / corrections / storage / sharing
       |
Immutable capture evidence
  images / timestamps / poses / observations / diagnostics
       |
.hcap packer
       |
PhotoLab canonical IO provider
```

## Capture lifecycle

1. The operator selects or creates a project and starts a job.
2. The capture controller locks supported camera behavior and records timestamps,
   smart stills, poses, GNSS observations, correction state, and diagnostics.
3. The UI displays quality without claiming unsupported accuracy.
4. Stop seals the capture input set and starts bounded package preparation.
5. The packer validates and publishes one `.hcap` candidate atomically.
6. Share or upload operates on the committed package.

Camera and sensor callbacks write through one capture-session owner. A screen,
platform channel, and background task must not maintain competing job state.

## Concurrent operations

- Only one active camera capture session may own the camera and live sensor
  stream.
- Packaging a stopped job may overlap a later capture only when disk, thermal,
  memory, and platform constraints are budgeted and the jobs have disjoint
  storage.
- Two packers or uploads never publish to the same target concurrently.
- Project deletion, job deletion, logout, and destructive storage cleanup are
  blocked or coordinated while owned work is active.
- App backgrounding, process death, low storage, thermal pressure, permission
  loss, and connectivity loss have explicit state transitions.
- Cancellation keeps a recoverable draft when safe and removes only temporary
  artifacts owned by that operation.

## Position and quality

The phone records raw and processed evidence with timestamps and uncertainty.
Dual-frequency measurements, NTRIP corrections, device fixes, and fused poses
remain distinguishable in the package.

The live HUD is advisory. PhotoLab decides how observations enter bundle
adjustment and how final accuracy is reported. Neither Cap nor PhotoLab silently
turns a phone coordinate into a fixed canonical reference.

## Package boundary

`.hcap` is a checksummed versioned ZIP. The package contains a manifest,
selected images, pose/observation records, quality diagnostics, and provenance.
Optional profiles change included evidence, not the logical format.

The packer writes a candidate and exposes it only after complete validation.
PhotoLab rejects unsafe paths, missing content, checksum mismatch, unsupported
versions, and incomplete mandatory records.

## Security and privacy

- Capture data stays local unless the user explicitly shares or uploads it.
- Credentials use platform secure storage and never enter packages or logs.
- Development credentials come only from ignored environment/configuration.
- Cloud providers receive only the capabilities required for the chosen target.
- Package paths and imported archive entries are canonicalized and contained.
- Analytics and crash reporting are not implied by the product architecture.

## Shared product boundaries

Cap ports shared Himmel:CAD tokens and interaction principles but does not import
Electron or web UI packages. Format, provenance, English UI, accessibility, and
operation lifecycle rules remain family-wide contracts.
