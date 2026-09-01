# Maximizing smartphone RTK — algorithms research (Cap)

Status: research synthesis for Himmel:CAD Cap, 2026-07-21.
Complements `RESEARCH-NOTES.md` and the accuracy targets in `PRODUCT.md`.

**Core question:** Can single-frequency phones with RTK/NTRIP approach useful
sub-metre / dm accuracy via “fancy” filtering, and how do dual-frequency phones
pull further ahead?

**Short answer:** Yes — a large literature exists on robust RTK, multipath
mitigation, partial ambiguity resolution, C/N0 weighting, and GNSS+IMU/VIO
fusion for phones. These methods **reliably push single-freq + RTK into
sub-metre and often dm-class** under open sky; they **do not** make single-freq
as reliable as dual-freq for continuous &lt;30 cm claims. Dual-freq + the same
stack is the go/no-go path for Cap’s global target.

---

## 1. What limits phone RTK (the problem algorithms attack)

| Limitation | Effect | Algorithmic lever |
| --- | --- | --- |
| Tiny multipath-prone antenna | Code errors metres; phase cm–dm biased | Outlier rejection, multipath indicators, elevation/C/N0 weight, PAR |
| Duty cycling | Fake cycle slips | Full tracking API; slip detection; re-init ambiguities |
| Weak / intermittent ADR (carrier) | No true RTK, only code DGPS | Runtime capability probe; degrade to code+Doppler |
| Ionosphere (single-freq) | Slow AR, wrong fix risk | Longer float, dual-freq iono-free / Melbourne–Wübbena when L5 exists |
| NLOS urban | Biased “good looking” sats | Consistency tests, residual screening, map/VIO aids |
| Clock / ISB quirks | Filter divergence | State flags, clock discontinuity handling |
| Kinematic multipath | Float never converges | IMU/VIO coast, robust KF, quality gating |

Algorithms **filter and weight** bad observations and **bridge** outages. They
cannot invent a choke-ring antenna. Expect **~25–35 % accuracy gains** from
robust RTK layers on top of a baseline phone RTK engine in published static
and dynamic tests (e.g. IGG-III robust adaptive RTK on Xiaomi 8 / Huawei
flagships — order of 30 % improvement vs non-robust).

---

## 2. Single-frequency + RTK: what is physically possible?

**Yes, RTK exists without dual-frequency.** Commercial RTK was L1-only for
decades. Double-differenced carrier phase still yields centimetres **when
integer ambiguities are correctly fixed** and multipath is mild.

On **phones**, single-freq RTK typically means:

| Solution state | Typical open-sky phone behaviour | Role for Cap |
| --- | --- | --- |
| Code differential / SBAS-like with NTRIP SSR | ~0.5–2 m | Floor above raw SPP |
| **RTK Float** (carrier used, N not integer) | **~0.2–1.0 m** common; better with multi-GNSS + robust filter | Main single-freq workhorse |
| **RTK Fix** | cm–dm when it holds | Valuable but **low duty cycle** on phone SF |

**Implication for Cap targets:**

- Single-freq + RTK + robust stack: **safely “under a metre” often**; **&lt;30 cm
  global sometimes**, not as a universal SLA.
- Dual-freq + RTK + same stack: **&lt;30 cm global** as product go/no-go is
  defensible under open sky after BA.

Non-dual phones are therefore a **real RTK tier**, not a waste — just not the
kill-metric device class.

---

## 3. Algorithm catalogue (state of literature)

### 3.1 Observation gating (must-have, not fancy)

Android / any raw pipeline:

1. **Tracking state:** require TOW decoded + code lock before using pseudorange.
2. **ADR state:** use carrier only if `VALID` and not `RESET` / `CYCLE_SLIP`.
3. **Full tracking:** disable duty cycle (`setFullTracking(true)`).
4. **C/N0 floor:** drop or heavily down-weight below ~20–25 dB-Hz (tune per device).
5. **Elevation mask:** 10–15° typical; phones often need **higher** masks in multipath.
6. **Outlier residual tests:** post-fit residual &gt; k·σ → reject epoch or satellite.
7. **Clock jumps:** detect `GnssClock` discontinuities; reset filter carefully.

These alone separate “research-grade phone RTK” from “paste measurements into
RTKLIB and cry”.

### 3.2 Stochastic models (weighting)

| Scheme | Idea | Phone note |
| --- | --- | --- |
| Elevation-dependent σ | Higher elev → smaller σ | Weak on phones (gain pattern ≠ geodetic) |
| **C/N0-dependent σ** | σ² ∝ 10^(−C/N0/10) or similar | **Preferred in smartphone literature** |
| Combined elev + C/N0 | Hybrid | Common in production engines |
| Adaptive process noise | Inflate Q when motion / slip | Helps kinematic walk |

### 3.3 Robust estimation / outlier resistance

Published smartphone / low-cost RTK work uses:

| Method | What it does |
| --- | --- |
| **M-estimators** (Huber, Tukey, …) | Soft-reject large residuals in KF/LS |
| **IGG-III equivalent weights** | Chinese classical robust geodesy scheme; used in robust adaptive phone RTK (~30 % improvement reported on Xiaomi 8 etc.) |
| **Adaptive KF factors** | Scale observation R or state noise from innovation statistics |
| **Quartile / MAD robust models** | Scale noise from robust residual stats tailored to phone residual distributions |
| **Innovation χ² gating** | Hard reject inconsistent satellites/epochs |

These are exactly the “fancy outlier filters” — and they **work**, with
diminishing returns once the baseline is already clean.

### 3.4 Multipath-specific techniques

| Technique | Maturity on phones |
| --- | --- |
| Code multipath observables / dual-freq multipath combination | High when L5 present |
| Carrier multipath is harder (small amplitude) | Limited |
| C/N0 time-series / AGC features | Used as multipath/NLOS flags |
| **ML multipath/NLOS classifiers** (SVM, RF, NN on C/N0, elev, residuals, AGC) | Active research; train carefully per device |
| Sidereal filtering (static) | Not for walking trenches |
| Spatial consistency with VIO | Practical for Cap: reject GNSS jumps that contradict vision |

### 3.5 Ambiguity resolution (AR)

| Technique | SF phone | DF phone |
| --- | --- | --- |
| LAMBDA / MLAMBDA integer search | Yes | Yes |
| Ratio test / success-rate control | Critical — phones need **conservative** thresholds | Same |
| **Partial Ambiguity Resolution (PAR)** | **Very useful** — fix only strong subset | Even better with L1+L5 |
| Instantaneous multi-GNSS DF RTK | Rare SF | Demonstrated in papers on modern Androids |
| Hold / coast integers across short slips | Needs excellent slip detection | Same |
| TCAR / EWL with dual-freq | N/A | Helps fast AR |

**Product rule:** Prefer **honest float + good σ** over **wrong fix**. A wrong
fix is worse than 50 cm float for photogrammetry priors.

### 3.6 Multi-constellation multi-frequency

- Use **GPS + Galileo + BeiDou (+ GLONASS carefully)** for geometry.
- Dual-freq: L1/E1 + L5/E5a (and B2a where available).
- Frequency diversity ≈ multipath diversity and iono control → higher fix ratio.

### 3.7 Sensor fusion (where Cap can win vs pure RTK apps)

| Coupling | Inputs | Benefit for walk-and-capture |
| --- | --- | --- |
| Loose | RTK PVT + IMU/VIO | Smooth track, bridge 1–10 s outages |
| Semi-tight | GNSS velocity/Doppler + position with adaptive R | Practical middle ground |
| Tight | Pseudorange/phase + IMU | Research-grade; harder on phone clocks |
| Photogrammetry BA (PhotoLab) | Many camera poses with σ | **Averages random GNSS noise**; systematic multipath bias remains |

Published smartphone RTK+IMU demos (e.g. UniBW fused RTK fixed + inertial on
Android sensors; GVINS-class optimization GNSS-VIO) show **sub-metre seamless
tracks** and better continuity than GNSS alone. Cap should treat fusion as
**first-class**, not optional polish.

### 3.8 Time-domain and session-level post-processing (Cap packer / PhotoLab)

Even without real-time fix:

| Step | Effect |
| --- | --- |
| Forward–backward RTS smoothing on trajectory | Reduces random walk of float |
| Outlier epoch deselect before writing priors | Stops one multipath spike from warping BA |
| Quality-weighted priors into PhotoLab BA | Core Cap value |
| Optional PPK with same NTRIP base RINEX after session | Can beat real-time on same data (your BA saw inconsistent PPK — better engines + DF change this) |

---

## 4. Reference pipeline for Cap (maximum extraction)

```text
Android raw stream
  → full tracking ON
  → reconstruct PR + ADR
  → gate: state, ADR flags, C/N0, elev, lock time
  → NTRIP RTCM (SAPOS HEPS / generic)
  → multi-GNSS DD engine
       ├─ C/N0(+elev) stochastic model
       ├─ robust M-est / IGG-III on innovations
       ├─ cycle-slip detector (geometry-free / Doppler / ADR flags)
       ├─ PAR + conservative ratio test
       └─ output: fix | float | code-diff | fail + full covariance
  → loose/semi-tight fuse with ARCore/IMU (adaptive R from fix type)
  → interpolate to camera exposure time
  → session smoother + epoch QC
  → poses.jsonl priors for PhotoLab
  → PhotoLab BA (visual network + weighted GNSS)
```

**Single-freq phones:** same pipeline; skip DF combinations; expect more float,
stricter AR, still large gain vs OS GPS.

**Dual-freq phones:** enable L5/E5a, iono-aware combos, faster/safer AR.

**iOS:** no raw → cannot run this engine on internal chip; OS location + optional
future external only. Same fusion/packaging UX with lower tier labels.

---

## 5. Expected accuracy after the full stack (honest)

Planning numbers for **open sky, walking, phone in hand**, NTRIP available:

| Device class | Stack | Global horizontal (order) |
| --- | --- | --- |
| SF phone, OS fused only | none | 3–10 m |
| SF phone + NTRIP code/robust | robust DGPS-like | **0.5–2 m** |
| SF phone + RTK float + robust + multi-GNSS | full SF pipeline | **0.2–0.8 m** typical; spikes |
| SF phone + RTK fix (when held) | full SF | **0.05–0.3 m** intermittent |
| DF phone + RTK float/fix + robust | full DF pipeline | **0.05–0.4 m** more often; static better |
| Either + VIO fusion + PhotoLab BA | Cap product path | Often **tighter than single-epoch** if multipath not systematic |

**Local &lt;7 cm** remains primarily **photogrammetry**; GNSS stack feeds absolute
frame and reduces scale drift.

**Global &lt;30 cm go/no-go** should be validated on **DF + full stack + BA**.
SF + full stack is the **compatibility tier**: “often sub-metre, sometimes dm”.

---

## 6. Open-source / implementable building blocks

| Component | Candidates | Caution |
| --- | --- | --- |
| RTK engine | RTKLIB ports, goGPS, commercial SDKs, research myGNSS-class apps | **License** (GPL RTKLIB vs Cap BSL — review before link) |
| Raw logging | Geo++ RINEX Logger patterns, GnssLogger | Measurement quality varies by OEM |
| Robust KF | Standard M-est literature; Zhu et al. robust adaptive RTK (IGG-III) | Tune thresholds per device |
| VIO | ARCore / ARKit poses as measurements | Not a substitute for absolute RTK |
| Cloud RTK | Offload heavy AR (papers 2024+) | Latency + privacy; offline Cap prefers on-device |

---

## 7. Product recommendations for Cap

1. **Invest in the algorithm stack** (gating → robust RTK → fusion → session QC)
   — this is where SF phones become “worth supporting” and DF phones hit
   &lt;30 cm more often.
2. **Do not equate “no dual-freq” with “no RTK value”.** SF+RTK should still be
   a supported tier with honest σ.
3. **Do not claim SF equals DF** for the go/no-go metric.
4. **Conservative AR** over aggressive false fixes.
5. **PhotoLab BA is part of the positioning system**, not only a mesh renderer.
6. **License-clean engine choice is a hard gate** before C4 implementation.
7. **C5 validation matrix** must include:
   - DF + NTRIP + full stack (Pixel class)
   - SF + NTRIP + full stack (older single-freq Android)
   - both with and without PhotoLab BA
   - open sky vs light multipath

---

## 8. Key literature pointers (non-exhaustive)

- Zangenehnejad & Gao — smartphone GNSS positioning review (raw measurements, PPP/RTK challenges)
- EUSPA/GSA — Using GNSS raw measurements on Android devices (white paper)
- Robust adaptive RTK for low-cost/smart terminals (IGG-III / M-estimator KF; ~30 % gains on Xiaomi 8 class)
- Instantaneous dual-frequency multi-GNSS smartphone RTK studies (Yong et al. and follow-ons)
- Odolinski et al. — phone-to-phone / dual-freq multi-GNSS RTK evaluations
- UniBW / ION — fused RTK + inertial with Android sensors
- myGNSS (2025) — open real-time Android RTK app architecture (engine + NTRIP + UI)
- C/N0-dependent weighting and multipath/NLOS ML detection literature for smartphones
- Partial ambiguity resolution (PAR) for weak geometries
- Pix4D Geofusion-class lesson: absolute anchors + relative VIO + BA

---

## 9. Bottom line

| Question | Answer |
| --- | --- |
| Fancy outlier algorithms exist? | **Yes** — robust KF, IGG-III, PAR, C/N0 models, ML multipath, VIO consistency |
| SF + RTK worth it? | **Yes** — often **sub-metre**, sometimes dm; large step vs BA 2023 SPP metres |
| SF + RTK = DF + RTK? | **No** — DF wins reliability and &lt;30 cm duty cycle |
| Can algorithms alone guarantee 30 cm on SF? | **No guarantee** — improve odds, not physics of antenna |
| Cap strategy | Full stack on all Android raw-capable phones; **go/no-go on DF**; SF as best-effort geo tier |

This stack is exactly what turns “pessimistic multipath essays” into an
engineering program: **filter hard, fuse soft, fix conservatively, let
photogrammetry finish the job.**
