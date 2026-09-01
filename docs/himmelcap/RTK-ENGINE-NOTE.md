# On-device RTK engine (E1) status

Owner gate: prefer **E1** (real on-device RTK), not hand-rolled from scratch;
fallback **E2** if no license-clean library.

## Constraint

`AGENTS.md` forbids **GPL** in product code. **RTKLIB** is GPL → cannot ship
inside himmel:Cap.

## What shipped in MVP

| Component | Status |
| --- | --- |
| NTRIP client (Dart) | **Done** — RTCM stream, GGA hook |
| Android raw GNSS + full tracking channel | **Done** |
| Correction-aware float HUD + adaptive σ | **Done** (honest Float when NTRIP fresh) |
| Integer ambiguity (Fix) | **Not** shipped — needs permissive engine |
| RINEX/raw log to session | Scaffold via measurement events + trajectory |

## Plug-in boundary

`OnDeviceRtkBackend` in `lib/services/gnss/gnss_engine.dart`.

Candidates to evaluate later (must re-check license before link):

- Commercial: Swift Navigation, Point One, u-blox SDKs
- Permissive research ports (verify case-by-case)
- Clean-room float/AR under BUSL/MIT by Himmel:CAD (future)

Until then Cap still delivers the **capture + NTRIP + `.hcap` + PhotoLab prior**
pipeline that makes dual-freq + corrections usable for the &lt;30 cm go/no-go
path after PhotoLab BA.
