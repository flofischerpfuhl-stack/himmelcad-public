# ADR 0027: HimmelCAD Cap as phone-only capture upstream for PhotoLab

- Status: Accepted (preparation track)
- Date: 2026-07-21
- Depends on: ADR 0009, ADR 0018, ADR 0021, ADR 0023

## Context

PhotoLab needs high-quality field imagery with usable absolute priors. Professional
RTK accessories and mandatory GCPs exclude the primary audience: field crews
without surveying training or survey equipment. A mobile capture product must
package sessions so PhotoLab does not fall back to 25 m / 50 m EXIF defaults.

## Decision

1. Add product **HimmelCAD Cap** (shorthand **himmel:cap**) to the product family.
2. Cap runs on **Android and iOS** consumer phones. MVP accuracy path is
   **phone GNSS only** (dual-frequency + optional NTRIP on Android). External
   RTK hardware is not required and not part of MVP onboarding.
3. Cap produces a versioned **`.hcap`** ZIP session package after short
   on-device processing. PhotoLab gains a **dedicated importer** for that
   package (not DJI-XMP spoofing). Cloud upload (Drive/Dropbox/OneDrive) and
   local/USB export are first-class distribution paths.
4. GNSS positions remain **`priorOnly`** and never silently create a
   `crsBacked` project (ADR 0023).
5. Operator UX is **video-like**; photogrammetry uses **smartstills** or
   selected frames under the hood. Operators must not pause for manual stills.
6. GCPs are **optional in PhotoLab only**, never required to finish a Cap
   session.
7. Cap implementation lives under `apps/cap/` once a mobile stack is chosen.
   Format schemas live under `schemas/himmelcap/`. Product docs under
   `docs/himmelcap/`.
8. Until the owner provides a UI brief and stack gate, agents implement only
   documentation, schemas, fixtures, and shared types — not free-form mobile UI.

## Consequences

- PhotoLab import and Cap capture can proceed in parallel after format freeze.
- Marketing and in-app copy must use quality tiers; centimetre SLA on phone
  antennas is forbidden without new evidence.
- iOS will often report weaker absolute tiers than dual-frequency Android; UX
  stays parallel.
- License review is required before linking any RTK engine.
- Branding assets for Cap are pending owner artwork.

## References

- `docs/himmelcap/PRODUCT.md`
- `docs/himmelcap/ROADMAP.md`
- `docs/himmelcap/FORMAT.md`
- `docs/himmelcap/PHOTOLAB-IMPORTER.md`
- `docs/photolab-capture-and-local-scale.md`
