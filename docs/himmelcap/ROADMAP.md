# HimmelCAD Cap — Roadmap

Status: preparation track opened 2026-07-21.
Product definition: `docs/himmelcap/PRODUCT.md`.
This roadmap is the **execution sequence for Cap + PhotoLab importer**.
It does not replace PhotoLab’s own milestones; Cap work is a **parallel
upstream track** that must not block PhotoLab release gates unless the owner
explicitly re-prioritizes.

## Principles

1. **Non-surveyor first** — if a step needs a surveyor, it is not Cap MVP.
2. **Phone only** — dual-frequency handset recommended; no required accessories.
3. **Video UX, photogrammetry guts** — operator holds record; app does smartstills / frame selection.
4. **One package** — every session ends as a **`.hcap`** ZIP (office profile by default).
5. **Field→office** — local/USB share plus optional Google Drive / Dropbox / OneDrive upload.
6. **Honest quality** — tiers, σ, fix/float; never fake centimetres.
7. **PhotoLab is the brain** — Cap packages capture evidence; PhotoLab reconstructs.
8. **Accuracy go/no-go (Pixel 8a class, outdoor protocol, no external RTK, no mandatory GCPs):**
   - **Global &lt; 30 cm** (horizontal vs survey checkpoints after PhotoLab + Cap priors)
   - **Local &lt; 7 cm** (relative lengths/depths in the model)
   - Failure on this device class → pause productization (see PRODUCT.md).
   - Non-dual-frequency phones: best-effort only, not go/no-go.

## Phase overview

| Phase | Name | Outcome | Depends on |
| --- | --- | --- | --- |
| **C0** | Repo prep | Docs, ADR, format draft, app skeleton, importer plan | — |
| **C1** | Format + contracts | Frozen `.himmelcap` v1 schema + golden fixtures | C0 |
| **C2** | PhotoLab importer | Import sessions into PhotoLab with real priors | C1 |
| **C3** | Mobile capture MVP | Android (+ iOS shell) capture → process → export | C1 |
| **C4** | Positioning quality | Dual-freq, NTRIP, fusion, quality UI | C3 |
| **C5** | Field validation | Pixel-class devices vs reference on real sites | C4 |
| **C6** | Hardening & ship | Installers/stores, support, German utility presets | C5 |

C0 is documentation and structure only. **Implementation of UI starts after
the owner’s UI brief** (explicit gate after C0).

---

## C0 — Repo preparation *(this track)*

**Goal:** Agents and humans can implement without re-litigating product scope.

- [x] Product definition (`PRODUCT.md`)
- [x] Roadmap (this file)
- [x] Architecture sketch (`ARCHITECTURE.md`)
- [x] Format draft (`FORMAT.md`) + JSON Schema stub
- [x] ADR 0027 (product + format boundary)
- [x] Wire product family (vision, README, CURRENT-DIRECTION, AGENTS)
- [x] `apps/cap/` skeleton (no full mobile stack until UI brief)
- [x] PhotoLab importer design note
- [x] Research notes link (`RESEARCH-NOTES.md`)

**Exit:** Owner reviews C0 docs, delivers **UI brief**, opens C1/C3 coding.

---

## C1 — `.himmelcap` format v1 freeze

**Goal:** A versioned, content-addressable session package PhotoLab can trust.

Deliverables:

- JSON Schema `schemas/himmelcap/himmelcap-session-v1.schema.json` (complete)
- Manifest fields: device, camera state, capture mode, CRS hints, capability tier
- `poses.jsonl` / equivalent: per-frame time, lat/lon/h, ENU covariance, fix state
- Media layout: selected frames and/or source video with extraction provenance
- Deterministic packing (zip or folder + checksums); extension `.himmelcap`
- Golden fixtures under `scripts/fixtures/himmelcap/` (synthetic, no private data)
- TypeScript types in `packages/@himmelcad/data` (or dedicated small package)
- Rust structs in `himmelcad-core` or `himmelcad-io` for importer

**Exit criteria:**

- Schema validates golden fixtures
- Round-trip hash stability for identical inputs
- Documented height/CRS semantics (ellipsoid vs orthometric: unknown until PhotoLab CRS step)

**Non-goals:** live NTRIP, camera pipeline.

---

## C2 — PhotoLab `.himmelcap` importer

**Goal:** Drag-drop / file open of a Cap session creates a PhotoLab capture group
with **real** position priors (not 25 m / 50 m EXIF defaults).

Deliverables:

- Import provider path (ADR 0018-compatible) for `.himmelcap`
- Map frames → images + `CapturePositionPrior` (covariance from package)
- `CaptureSourceProfile`: smartphone, make/model from manifest
- Capture group = one Cap session; calibration group splits if focus/zoom state changes
- UI: import progress, quality summary (% fix, mean σ, tier)
- Preserve video lineage if frames were extracted (hashes, timestamps)
- Tests: golden session → discovered photos + priors

**Exit criteria:**

- Import of golden `.himmelcap` matches expected prior σ and frame count
- No silent promotion to `crsBacked` solely because GNSS exists
- English UI strings for PhotoLab surface

**Ordering note:** C2 can start as soon as C1 schema is stable, **in parallel**
with C3, so desktop import is ready when first field packages exist.

---

## C3 — Mobile capture MVP (UI brief required)

**Goal:** Untrained operator records a scene and produces a `.himmelcap`.

Deliverables (subject to owner UI brief):

- Project/session list, permissions, storage
- Capture: **video preview** + **background smartstills** (distance/time/overlap)
- Locked focus/AE policy where platform allows (infinity/far for outdoor default)
- Continuous GNSS log (OS fused minimum; raw on Android when available)
- Stop → on-device processing: frame select, sharpness/motion filters, package write
- Map preview of track (coarse) optional for orientation
- Share/export `.himmelcap` (Files, Drive, USB, QR of path — platform-native)

**Platform strategy:**

| Priority | Platform | Rationale |
| --- | --- | --- |
| P0 | Android | Dual-freq raw GNSS + NTRIP path; primary accuracy device class |
| P0 | iOS | Same UX; absolute accuracy limited to CoreLocation (+ later optional external only if ever added) |
| Stack | **TBD in UI brief** | Flutter / RN / Kotlin+Swift — decide before C3 code |

**Exit criteria:**

- One-tap-ish record loop completable without training script longer than one page
- Always emits valid v1 package
- Works offline for capture; NTRIP optional when network present

---

## C4 — Positioning quality (phone only)

**Goal:** Maximize absolute accuracy **without accessories**.

Deliverables:

- Runtime capability probe (dual-freq, ADR/carrier, full tracking)
- Quality tiers T0–T2 (consumer → dual-freq → NTRIP float/fix on device)
- Android: NTRIP client (SAPOS and generic casters), credentials storage
- Android: optional on-device RTK/PPP engine path **or** high-rate filtered PVT + corrections where feasible
- Full GNSS measurements request; RINEX/raw log for support/debug
- Sensor fusion: OS/AR pose + GNSS with adaptive R; interpolate to frame time
- Per-frame σ and fix flag written into package
- Operator UI: simple traffic-light / “good for as-built” indicator (not PDOP soup)

**Exit criteria:**

- Documented expected accuracy bands per tier in-app
- Sessions under open sky on Pixel-class device show sub-meter priors when NTRIP works
- Degraded GNSS still packages usable relative capture

**Explicitly deferred:** external Bluetooth RTK as product dependency.

---

## C5 — Field validation (go / no-go)

**Goal:** Prove or reject the binding accuracy targets on Pixel 8a class hardware.

**Binding targets** (also in `PRODUCT.md`):

| Metric | Target |
| --- | --- |
| Global horizontal (vs survey checkpoints, after PhotoLab + Cap priors) | **&lt; 30 cm** |
| Local relative (lengths/depths in model vs reference) | **&lt; 7 cm** |

Deliverables:

- Frozen validation protocol (open sky primary; suburban optional; indoor = local-only)
- Reference: temporary survey control **for QA only**, not product workflow
- Scenes: utility trench analogue, small outdoor strip, optional room (local only)
- Devices: **Pixel 8a class dual-freq Android (required)** + one iOS (informational)
- Metrics: global H (and V reported separately), local length/depth error, planar thickness (noise), %FIX/float, tier mix
- Report under `docs/himmelcap/validation/`

**Exit criteria:**

- Pixel 8a class meets **global &lt; 30 cm** and **local &lt; 7 cm** on the primary outdoor protocol, or owner explicitly relaxes targets
- If missed: **pause Cap productization** — do not ship accuracy claims
- Claim language + in-app quality envelope match measured data

---

## C6 — Hardening and distribution

**Goal:** Crews can install and use Cap without HimmelCAD developers on site.

- Store or enterprise sideload path (decision gate)
- Crash reporting opt-in, support bundle (logs + anonymized session meta)
- Battery/thermal policies for long captures
- Localization: German primary field language, English for PhotoLab-adjacent strings policy TBD
- SAPOS/HEPS connection help for German states
- Legal: location permission copy, correction-service credentials responsibility

**Exit criteria:**

- Install smoke on target devices
- Support playbook for “package won’t import” / “red GNSS”

---

## Cross-cutting workstreams

| Stream | Owner lane | Notes |
| --- | --- | --- |
| Format & priors | Kernel / PhotoLab IO | `himmelcad-io`, `@himmelcad/data` |
| PhotoLab import UI | PhotoLab UI | `apps/photolab` |
| Mobile app | Cap lane | `apps/cap` (stack TBD) |
| Branding | Shared | mark for Cap when owner supplies artwork |
| Licensing | same as monorepo | BSL/BUSL; mobile deps allowlisted |

## Dependency on PhotoLab

Cap MVP **requires** PhotoLab importer (C2) before Cap is customer-useful.
Cap can develop capture (C3) against golden fixtures before PhotoLab UI is pretty.

PhotoLab does **not** require Cap to ship; Cap is additive upstream.

## Risk register (summary)

| Risk | Mitigation |
| --- | --- |
| Phone antenna multipath prevents dm | Quality tiers; relative value still ships; claims gated by C5 |
| iOS absolute accuracy weak | Same UX; lower tier labels; Android recommended for geo-critical work |
| Smartstills battery/thermal | Adaptive still rate; pause guidance |
| Operator walks too fast / blur | Live blur/speed warning; post filter drops frames |
| NTRIP auth complexity | Presets + clear offline fallback |
| Format churn | v1 freeze after C1; additive v2 only |

## Near-term owner gates

1. **UI brief** → unlocks C3 implementation.
2. **Mobile stack choice** (Flutter vs RN vs native) → before first app commit.
3. **Claim language after C5** → marketing and in-app accuracy copy.
4. **Store vs sideload** → C6.

## Suggested first implementation PR stack (after UI brief)

1. C1 schema + fixtures + core types
2. C2 importer skeleton + golden test
3. C3 empty shell app + permissions + session store
4. C3 capture smartstills pipeline
5. C3 packer → `.himmelcap`
6. C4 GNSS tiers + NTRIP
7. C5 validation scripts/docs

Until the UI brief arrives, **only C0 (done) and optional C1 schema completion**
should proceed without further product inventing of screens.
