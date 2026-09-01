# Himmel:CAD Cap roadmap

Status: Flutter MVP and `.hcap`/PhotoLab path implemented. Remaining work is
validation and release hardening, not initial product scaffolding.

## Completed foundation

- Flutter application roots for Android and iOS.
- Shared mobile theme and primary project/job/capture flows.
- Smart-still capture, quality HUD, local jobs, and `.hcap` packaging.
- GNSS/correction boundaries and secure credential handling.
- Golden package fixtures and PhotoLab import path.
- Emulator/component coverage and Android package evidence.

Completion claims remain limited to the tested MVP. They do not imply field
accuracy, store approval, complete native sensor support on every device, or a
finished cloud integration.

## C1 — English product conformance

- Remove the legacy German localization and language selector.
- Update golden screenshots and accessibility labels.
- Add an English UI gate for Flutter alongside the desktop product gate.
- Align every package, error, permission, and recovery message with the shared
  design system.

## C2 — Device and lifecycle hardening

- Validate supported Android and iOS versions and reference devices.
- Exercise permission loss, backgrounding, process death, low storage, thermal
  pressure, camera interruption, and correction loss.
- Prove that capture, packaging, upload, deletion, and new captures coordinate
  ownership and do not corrupt or delete another job.
- Bound cancellation acknowledgement and recover drafts after interruption.

## C3 — Field validation

- Capture repeatable outdoor and construction datasets on supported phones.
- Compare the complete Cap-to-PhotoLab results with independent survey
  checkpoints and reference dimensions.
- Separate random noise, multipath/systematic bias, camera network quality, and
  final model uncertainty.
- Record supported and failed environments honestly.

Field evidence is the gate for accuracy claims and broad release.

## C4 — Transfer and distribution

- Finish only the cloud providers with approved credentials, privacy behavior,
  and user value.
- Validate local file/share workflows independently from cloud availability.
- Define store, enterprise, and sideload distribution.
- Add signed release, installation, upgrade, data-retention, and rollback tests.

## Non-goals until a new decision

- required external RTK hardware;
- a general-purpose survey controller;
- on-device dense reconstruction;
- a Himmel:CAD-operated cloud backend;
- CAD editing or PhotoLab processing on the phone;
- unvalidated accuracy marketing.
