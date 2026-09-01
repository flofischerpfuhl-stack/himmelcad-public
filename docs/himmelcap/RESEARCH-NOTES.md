# Himmel:CAD Cap — research notes (2026-07)

Condensed findings that inform Cap product decisions. Not a substitute for
peer-reviewed reading lists; pointers only.

## Product implication summary

| Decision | Research-backed rationale |
| --- | --- |
| Phone-only, no required external RTK | Matches non-surveyor audience; external RTK is how PIX4Dcatch reaches cm, but kills Cap’s value prop |
| **Product targets: global &lt; 30 cm, local &lt; 7 cm** on Pixel 8a class | BA 2023 without RTK was ~1–2 m global / local often dm–cm on small scenes; dual-freq + NTRIP + better camera + BA priors is the step that makes 30 cm global a **stretch but rational** go/no-go — not centimetre SLA |
| Smartstills under video UX | Stills beat video for SfM (RS, compression); operators need video simplicity |
| Surface noise ≠ GNSS error | Noise from imagery/SfM/MVS; GNSS drives absolute placement |
| PhotoLab BA with many priors | Pix4D Geofusion-class: BA recovers temporary GNSS outages when image network is strong |
| Bachelor thesis (Note 9, 2023) | Without GCP ~1–2 m H global (worse 3D on large Ulm set); local length mean ~5 cm small site without GCP; dual-freq called out as path to sub-dm |

## Accuracy bands (planning)

| Tier | Horizontal (order of magnitude) |
| --- | --- |
| T0 OS GNSS | 3–10 m open sky |
| T1 dual-freq phone PVT | ~0.5–2 m open sky |
| T2 NTRIP float/fix on phone | ~0.2–0.8 m typical float; cm-class only when fix holds and multipath is low |
| External RTK + phone camera | ~1–3 cm (out of Cap MVP scope) |

After PhotoLab bundle adjustment with dense priors, absolute errors can improve
over single-epoch GNSS if geometry is good (literature/product reports in the
few-cm range only with **external** RTK). Cap should claim **dm-class under
good conditions** after C5 validation, not cm.

## Capture

- Lock focus far; lock AE/AWB when lighting is stable
- Avoid HDR / Night composite modes for geometry
- Overlap ≥70–80% along path; loop closures help
- Time sync: 100 ms skew ≈ 14 cm at walking speed → interpolate GNSS to exposure time

## SAPOS (Germany)

- HEPS: real-time RTK corrections (cm-class **on survey rovers**)
- EPS: sub-metre class code
- GPPS: post-processing
- Cap uses HEPS-like NTRIP where available; phone antenna still limits result

## Thesis counter-check (Florian Fischer, 2023)

Repo: `photolab/Bachelorarbeit Florian Fischer - Titelblätter Ausgebessert.pdf`

Still valid: infinity focus, high JPEG quality, continuous GNSS logging,
automatic capture, local accuracy promising on small scenes, GCP requirement
defeats non-surveyor motivation, PPK unreliable on that hardware.

Superseded by Cap plan: dual-frequency + live corrections + multi-frame BA
priors as the georeferencing path instead of GCP-first; smartstills UX; first-class
package format.

## Key external anchors

- Strecha et al. 2024 ISPRS Annals — RTK phone + photogrammetry (external RTK)
- Android raw GNSS documentation / EUSPA white paper
- SAPOS AdV service descriptions
- Pix4Dcatch Geofusion public material (competitive architecture, not copy)

## Validation still required (C5)

Pixel 8a-class + SAPOS HEPS on real trenches/rooms before locking marketing numbers.
