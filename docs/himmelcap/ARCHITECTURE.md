# HimmelCAD Cap — Architecture sketch

Status: pre-implementation. Mobile stack **recommendation** is below; final
gate still waits for the owner UI brief. Format and PhotoLab contracts are not
blocked by that choice.

## Recommended tech stack (single monorepo, full hardware access)

**Recommendation: Flutter app in `apps/cap/` + thin Android/iOS platform
channels for GNSS/camera + shared format contracts already in this monorepo.**

| Layer | Choice | Why |
| --- | --- | --- |
| UI + navigation | **Flutter** (one codebase Android + iOS) | One operator UX; mature camera/preview plugins; not two product UIs |
| Hard Android GNSS | **Kotlin platform channel** (`GnssMeasurement`, full tracking, NTRIP sockets) | Flutter plugins are incomplete for carrier/raw; channels unlock full chipset |
| Hard camera policy | **Platform channel** (Camera2 / AVFoundation): focus lock, AE/AWB lock, still while preview | Photogrammetry needs controls stock camera apps hide |
| Soft sensors / AR | Flutter plugins or channels (ARCore/ARKit pose when useful) | Relative bridging, not absolute truth |
| Package format | Schema in `schemas/himmelcap/`; packer in Dart **with golden tests** against Rust PhotoLab importer | One monorepo CI; no second product repo |
| PhotoLab import | Existing Electron + Rust (`himmelcad-io`) | Unchanged desktop stack |
| Optional later | Rust `cdylib` for fusion/packer via FFI | Only if Dart packer becomes a maintenance burden |

### Why not the alternatives (for Cap)

| Option | Verdict |
| --- | --- |
| Two fully native apps (Kotlin + Swift) only | Max hardware, **two UIs** and double field bugs — bad for non-surveyor polish |
| React Native / Expo managed | Fits TS culture poorly for this hardware; Expo blocks raw GNSS; bare RN still needs native modules ≈ Flutter channels with less camera maturity |
| Separate Git repo for mobile | Avoid — keep `apps/cap` here so format, fixtures, importer tests stay one pipeline |
| Pure Flutter without channels | **Will not** fully use dual-freq raw / infinity lock / NTRIP control |
| Shared Electron codebase | Irrelevant on phone |

### Monorepo layout (intended)

```text
himmelcad/
  apps/cap/                 # Flutter project (opens after stack gate)
    android/                # Kotlin GNSS + Camera2 channels
    ios/                    # Swift AVFoundation (+ CoreLocation) channels
    lib/                    # Dart UI + packer + session logic
  schemas/himmelcap/        # shared with PhotoLab tests
  crates/himmelcad-io/      # importer authority
  scripts/fixtures/himmelcap/
```

pnpm workspace does **not** need to build Flutter; CI adds a Flutter job when
C3 starts. Product name checks stay documentation-level until store manifests
exist.

### Stack gate checklist

- [ ] Owner accepts Flutter + platform channels
- [ ] Flutter SDK pinned in `apps/cap` docs
- [ ] License review for any NTRIP/RTK native library
- [ ] First PR: empty Flutter shell + channel stubs + CI smoke

## System context

```text
┌──────────────────────────────────────────┐
│  HimmelCAD Cap (phone)                   │
│  capture · GNSS · light process · pack   │
└──────────────────┬───────────────────────┘
                   │  .himmelcap (v1)
                   ▼
┌──────────────────────────────────────────┐
│  HimmelCAD PhotoLab (desktop)            │
│  importer · alignment · dense products   │
└──────────────────┬───────────────────────┘
                   │  normal HimmelCAD entities
                   ▼
┌──────────────────────────────────────────┐
│  Builder / WeltView                      │
└──────────────────────────────────────────┘
```

Cap never writes a full `.hcad` project in MVP. It only writes **session
packages** that PhotoLab admits through a dedicated importer.

## Logical modules (mobile)

| Module | Responsibility |
| --- | --- |
| **Session** | Create/open local sessions, lifecycle, storage quota |
| **CaptureController** | Preview video, smartstill triggers, camera request policy |
| **SensorHub** | GNSS (fused + raw when available), IMU, optional AR pose |
| **PositionEngine** | Time-align sensors, tiers, σ, fix state, optional NTRIP |
| **FrameSelector** | Sharpness / motion / overlap scoring (on-device after stop) |
| **Packer** | Build `.himmelcap` (manifest, poses, media, checksums) |
| **QualityUX** | Operator-facing tier / warnings (not expert GNSS panels) |
| **Export** | Share sheet / file path |

PhotoLab-side:

| Module | Responsibility |
| --- | --- |
| **HimmelcapImporter** | Unpack, validate schema, hash media |
| **PriorMapper** | Manifest poses → `CapturePositionPrior` |
| **CaptureGroupFactory** | One session → one capture group (+ cal groups) |

## Capture strategy: video UX, stills pipeline

```text
Operator: hold Record, walk, stop
     │
     ├─ UI surface: camera preview (feels like video)
     │
     └─ Pipeline (parallel):
           smartstills @ distance/time/overlap
           OR continuous video + post extract
           + GNSS/IMU samples @ high rate
```

**MVP preference:** full-resolution stills triggered while preview runs
(Camera2 / AVFoundation still capture concurrent with preview where possible).
Fallback: record high-bitrate video and extract frames in the post-session step
(already partially anticipated by PhotoLab video preparation).

Camera policy (outdoor default, aligned with PhotoLab smartphone policy + thesis):

- Prefer locked focus (far / infinity) for a session segment
- Prefer locked AE/AWB after initial meter
- Disable HDR / multi-frame geometry-warping modes when the API allows
- High JPEG quality; RAW optional later
- Rolling shutter: prefer stills; document residual risk

Focus or zoom changes should mark a **new calibration segment** in the
manifest so PhotoLab can split calibration groups.

## Positioning tiers (phone only)

| Tier | Source | Typical use |
| --- | --- | --- |
| **T0** | OS fused GNSS | Always available |
| **T1** | Dual-frequency phone PVT (when exposed) | Better open-sky geotag |
| **T2** | Dual-frequency + network corrections (NTRIP), float/fix if engine allows | Target for dm-class priors |

External RTK is **not** part of the MVP architecture. If added later, it must
be an advanced optional path that does not appear as required setup.

### Android

- `FusedLocationProvider` / `LocationManager` for T0
- `GnssMeasurement` + full tracking for research/T2 path
- NTRIP client (RTCM) + embedded or linked positioning engine (license-clean)
- Capability detection at runtime (never hard-fail capture)

### iOS

- CoreLocation best accuracy
- No public raw GNSS → T2 on-chip RTK not available
- Same capture/packaging UX; quality tier labels remain honest

### Fusion

Loose/semi-tight fusion of absolute GNSS with relative motion (ARKit/ARCore
or IMU odometry) to:

- interpolate pose to image exposure time,
- bridge short outages,
- estimate along-track time offset when possible.

Magnetometer is not a primary heading source for mapping.

## On-device processing (after Stop)

Keep **short** (seconds to low minutes for typical sessions):

1. Verify media hashes
2. Score and select frames (if not already distance-triggered only)
3. Build pose table at frame times from trajectory
4. Write manifest + checksums
5. Emit single `.himmelcap`

No dense SfM on device in MVP.

## Data flow into PhotoLab

```text
.himmelcap
  manifest.json     → session + device + camera segments
  poses.jsonl       → CapturePositionPrior (lat/lon/h, cov ENU, source, role priorOnly)
  frames/*.jpg      → images (content-addressed in PhotoLab object store)
  optional video    → lineage only or secondary extract
```

Rules (must match PhotoLab contracts):

- GNSS/RTK values are **`priorOnly`**
- Presence of coordinates does **not** auto-switch project to `crsBacked`
- Missing σ → importer must not invent centimetres; use package σ or refuse
  optimistic defaults (prefer package-required σ fields)
- Height semantic: store ellipsoid height when known; flag unknown orthometric

See `docs/himmelcap/FORMAT.md` and `docs/photolab-capture-and-local-scale.md`.

## Repository layout (planned)

```text
apps/cap/                    # mobile app (stack TBD)
docs/himmelcap/              # product docs (this tree)
schemas/himmelcap/           # JSON Schema for packages
packages/@himmelcad/data     # shared TS types (when wired)
crates/himmelcad-io          # Rust unpack/import
apps/photolab/               # importer UI + IPC
scripts/fixtures/himmelcap/  # golden packages
```

## Security and privacy

- Location and camera permission justified in plain language
- NTRIP credentials stored in platform secure storage
- Support bundles redact credentials; media share is user-initiated
- No requirement for cloud account in MVP (offline-first capture)

## License constraints

Same monorepo rules (`AGENTS.md`): no GPL-family engines in product.
Any RTKLIB-class dependency must be checked for license compatibility before
linking; prefer permissive ports or clean-room / commercial-licensed SDKs.

## Open technical decisions

Recorded in `docs/OPEN-QUESTIONS.md` (Cap section):

- Mobile UI framework
- On-device RTK engine choice (Android)
- Package container (zip vs custom) finalization
- Whether Cap ships German-first UI strings
