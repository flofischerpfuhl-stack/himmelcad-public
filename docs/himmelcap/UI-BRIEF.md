# Himmel:CAD Cap UI

Status: normative English UI behavior for the implemented Flutter product.

## Principles

- One-handed field use with a clear primary capture action.
- Map-first spatial project and job discovery.
- Quality is visible before and during capture.
- Progressive disclosure keeps expert GNSS and transfer settings out of the
  primary path.
- Shared Himmel:CAD islands, typography, color, casing, and feedback patterns.
- Product-owned controls are custom themed and accessible.

## Navigation

```text
Projects / map
  -> job details
  -> capture
  -> settings

Capture
  -> stop
  -> package progress
  -> job details
  -> share or upload
```

Back, close, app backgrounding, and system gestures never silently discard an
active or recoverable job. Destructive exits name the consequence and provide a
safe alternative.

## Projects and jobs

A project groups work for one site. A job is one capture session and one `.hcap`
package.

The map and list use the same selected project and job state. Job details expose
capture summary, quality, media, positioning evidence, package state, transfer,
notes, and recovery actions without duplicating job authority in each screen.

Contextual actions are available from job surfaces. Global settings do not move
into job menus unless they materially affect that job.

## Capture screen

Before capture, the live preview and quality HUD are already active so the
operator can wait for suitable conditions.

During capture, show:

- recording state and elapsed time;
- selected-frame count;
- positioning/fix tier and estimated horizontal/vertical uncertainty;
- storage, thermal, camera, sensor, and correction warnings;
- one clear Stop action.

Expert skyplots and raw diagnostics belong in an advanced surface, not the
primary capture HUD.

## Stop, processing, and cancellation

Stop seals the capture and opens package progress. The operator may leave the
screen without losing the job.

- Real stages and units are shown when available.
- Cancellation stops new package work and preserves a recoverable draft when
  safe.
- A short non-interruptible publication boundary is identified and completes or
  fails atomically.
- Low storage, permission loss, and worker failure provide an actionable
  recovery path.
- Save/share becomes available only for a validated `.hcap` package.

## Settings

Settings include only product-level configuration such as theme, units, camera
defaults, positioning/correction profiles, storage, transfer providers, privacy,
and about/support information.

Credentials use a dedicated secure control and are never displayed again in
plain text. The product is English-only; no language selector is shown.

## Visual system

Cap ports the shared theme roles to Flutter:

- dark default and supported light theme;
- floating islands over the map or camera void;
- Inter for UI and JetBrains Mono for coordinates and uncertainty;
- one accent blue for primary action and focus;
- status colors only for meaningful capture/position states;
- concise sentence-case English labels.

## Accessibility and verification

Touch targets, focus order, screen-reader labels, color contrast, safe areas,
text scaling, keyboard behavior where available, and platform back gestures are
part of completion.

Golden tests cover both themes and supported screen classes. Tests exercise
capture, background/resume, stop, cancellation, package failure, draft recovery,
and transfer entry points rather than screenshots alone.
