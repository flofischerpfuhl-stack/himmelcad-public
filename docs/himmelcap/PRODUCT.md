# HimmelCAD Cap (himmel:cap) — Product definition

Status: preparation track, 2026-07-21.
Canonical product name: **HimmelCAD Cap**. Marketing / UI shorthand: **himmel:cap**.
Binding roadmap: `docs/himmelcap/ROADMAP.md`. Architecture: `docs/himmelcap/ARCHITECTURE.md`.
Session package: `docs/himmelcap/FORMAT.md`. ADR: `docs/adr/0027-himmelcap-capture-product.md`.

## Mission

HimmelCAD Cap is a **mobile capture app** (Android and iOS) that lets people
**without surveying training and without professional field equipment** record
photo/video of real-world scenes with the best absolute and relative accuracy
the **phone alone** can achieve, package the result as a single
**`.himmelcap`** session file, and hand that file to **HimmelCAD PhotoLab**
for photogrammetric processing (point clouds, meshes, orthos, splats, …).

Cap is the **field front-end** of the PhotoLab pipeline. It is not a
Metashape replacement, not a CAD app, and not a professional RTK controller
product.

Jobs are sealed as a single **compressed `.hcap`** ZIP for USB, share sheet, or
cloud upload (Google Drive, Dropbox, OneDrive) so the office can import into
PhotoLab while the crew is still on site.

**Projects** group jobs on a site. Optionally the office publishes a current
as-built **DXF** into a shared cloud folder; Cap can poll/download that file and
overlay it on the map so crews see what is already built — still without
HimmelCAD-operated server infrastructure (consumer cloud APIs only).

## Priority order (product-specific)

```text
Operator simplicity > honest quality feedback > absolute accuracy > aesthetics
```

Family-wide `Performance > intuitive UX > aesthetics` still applies to
downstream desktop products. Cap optimizes for **one-handed field use under
site noise and time pressure**.

## Core audience

| Audience | Role |
| --- | --- |
| **Primary** | Field crews, site supervisors, utility/civil installers, facility staff — **not surveyors** |
| **Secondary** | Surveyors/engineers who want quick phone capture without packing a rover |
| **Not primary** | Users who already own multi-band RTK poles and expect cm SLA without a phone antenna limit |

**Hardware pitch that must stay true:** “Buy a good dual-frequency phone
(e.g. Pixel 8a class) and install the app.”
**Hardware pitch that is out of scope for MVP:** external GNSS pucks, handles
with survey antennas, mandatory GCPs, total stations.

Optional GCPs remain a **PhotoLab** workflow for users who have control —
never a Cap capture requirement.

## Flagship and other use cases

The **open utility trench** (power, broadband, water, district heating) is the
**parade example**, not the only scope:

| Use case | What Cap records | Success vs today’s practice |
| --- | --- | --- |
| Open trench / as-built utilities | Geometry of trench, visible pipes/cables, depth context before backfill | Better than weekly “capo points at closed ground” |
| Open excavations / foundations | Footprint, formwork, rebar before pour | Better than phone photos with no geometry |
| Indoor / plant rooms | Rooms, racks, pipe runs (GNSS weak) | Relative model + optional local scale; absolute GNSS optional |
| Facades / small structures | Elevations for planning/docs | dm-class global only with good sky + corrections |
| Damage / handover documentation | Time-stamped, geo-linked capture package | Reproducible evidence package for PhotoLab |
| Rough stockpile / spoil | Visual volume input for PhotoLab | Relative accuracy first; global secondary |

Cap must not hard-code “trench mode” as the only UX. Domain templates may
come later; the **core loop** is always: capture → short process → `.himmelcap`.

## Accuracy product contract

Cap does **not** promise survey-grade centimetres on an internal phone antenna
in every environment. It **does** set hard product targets for the primary
device class.

### Binding targets (go / no-go)

Validated on a **dual-frequency Android reference device** (Pixel 8a class),
open or mostly open sky, small-to-medium outdoor scenes (e.g. open trench
segments), after PhotoLab alignment with Cap priors — **without** external
RTK hardware and **without** mandatory GCPs:

| Metric | Target | Notes |
| --- | --- | --- |
| **Global** (checkpoint vs survey reference, horizontal mean or RMSE — protocol fixed in C5) | **&lt; 30 cm** | Requires dual-frequency + network corrections (e.g. SAPOS HEPS) path when available; quality UI must fail soft when sky/corrections are bad |
| **Local** (relative lengths / depths in the reconstructed model vs reference) | **&lt; 7 cm** | Driven by capture + SfM; GNSS helps scale/drift but is not the main noise source |

**Go / no-go:** If C5 validation cannot meet these targets on Pixel 8a class
hardware under the agreed outdoor protocol, Cap productization is paused and
scope is reassessed. Non-dual-frequency phones are a **best-effort** tier
(global often metres); they must not block shipping if Pixel-class passes.

### Supporting claims

| Claim | Status |
| --- | --- |
| Better documented geometry than ad-hoc finger-pointing after backfill | **Product promise** even when global degrades |
| Centimetre global on phone antenna, all sites / urban canyon | **Out of scope** |
| Point-cloud **surface noise** | Camera + SfM/MVS (PhotoLab), reported separately from global/local accuracy |
| Indoor / canopy | Relative local target may still apply; global target suspended |

Every session carries **per-frame quality** (tier, fix/float, σ) so operators
and PhotoLab know when a session is inside the claim envelope.

## Non-goals (MVP)

- External RTK hardware integration as a **required** path (optional later only if it does not confuse the primary audience).
- Mandatory GCPs or scale bars in the field.
- Full dense reconstruction **on the phone**.
- Professional NMEA survey controller feature parity.
- iOS on-chip carrier-phase RTK (platform limitation); iOS still ships with best-effort fused GNSS + same capture UX.

## Relationship to other products

| Product | Relationship |
| --- | --- |
| **PhotoLab** | Downstream: imports `.himmelcap`, runs alignment/products. Owns GCPs, CRS, dense products. |
| **Builder** | Consumes PhotoLab outputs as normal entities; Cap does not write `.hcad` directly in MVP. |
| **WeltView** | May later show shared results; not Cap’s job. |

## Competitive position (informal)

- Vs **PIX4Dcatch + external RTK**: Cap targets **no accessory**, simpler operators, PhotoLab-native package.
- Vs **consumer 3D scan apps**: Cap targets **honest geo priors + survey-aware packaging**, not only visual meshes.
- Vs **QField / SW Maps**: Cap is **photogrammetry capture**, not GIS digitizing.

## Success metrics (product)

1. An untrained operator completes a capture session in under a few minutes of instruction.
2. A session always produces a valid `.himmelcap` (even at low GNSS tier).
3. PhotoLab imports without manual EXIF surgery.
4. On dual-frequency Android + corrections + open sky small scenes, validation studies support **decimetre-class** absolute claims with published caveats.
5. Relative trench/room dimensions usable for as-built docs even when global GNSS degrades.
