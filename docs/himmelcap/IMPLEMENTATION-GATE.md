# HimmelCAD Cap — implementation gate (questions for autonomous E2E build)

Status: **blocked on owner answers** before a long unattended implementation run.
UI visual baseline: `apps/cap-prototype/screenshots/` (+ `MANIFEST.md`).
Product/roadmap: `docs/himmelcap/*`, ADR 0027.

**Goal of this file:** After you answer every **Required** item, an agent can implement
Cap end-to-end (Flutter + Android channels + `.hcap` + PhotoLab importer hooks)
without stopping to invent product decisions.

Legend:

- **Required** — must answer before full autonomous run
- **Default OK** — agent will use stated default if you say “defaults”
- **Later** — can ship MVP without

---

## A. Build scope and autonomy

### A1. What is “done” for this run? **Required**

Pick one:

| Option | Scope |
| --- | --- |
| **A** | Android-first MVP: Flutter app + dual-freq/NTRIP path + `.hcap` pack + local share + PhotoLab importer for `.hcap` |
| **B** | A + iOS shell (same UI; CoreLocation only, no raw RTK) |
| **C** | A + B + cloud upload (Drive/Dropbox/OneDrive) |
| **D** | C + DXF cloud overlay pull |
| **E** | Full C5 field-validation tooling too |

**Recommend for first long run:** **B** or **C**. DXF overlay (D) is separable.

### A2. May the agent choose stack defaults without reconfirming? **Required**

Proposed locked defaults (say yes/no):

- Flutter in `apps/cap/`
- Kotlin/Swift **platform channels** for GNSS + camera
- Single monorepo; no second Git repo
- Package: compressed **`.hcap`**
- PhotoLab importer in same monorepo
- UI parity vs `apps/cap-prototype/screenshots/*`

### A3. Language **Required**

- App UI strings: **DE only** / **EN only** / **DE primary + EN later**?
- PhotoLab stays English per existing product policy?

### A4. Minimum OS versions **Default OK**

- Android 10+ (raw GNSS mandatory era), target 14/15
- iOS 16+
Override?

### A5. Commit / PR policy for the long run **Required**

- Create feature branch `cap/mvp-…` and commit regularly without asking?
- Open draft PR at end?
- Touch PhotoLab only for importer (no unrelated PhotoLab refactors)?

---

## B. Accounts, keys, services (cannot invent)

### B1. NTRIP / SAPOS for development **Required**

- Do you have **test credentials** (host, port, mountpoint, user, password)?
- Paste into a **local env file that is gitignored**, or agent uses mock NTRIP only until you provide?
- Production: user brings own credentials only (yes)?

### B2. Cloud OAuth **Required if scope includes C/D**

For each: ship in v1?

| Provider | Ship? | Dev OAuth client IDs you can supply? |
| --- | --- | --- |
| Google Drive | y/n | |
| Dropbox | y/n | |
| OneDrive | y/n | |

Without client IDs, agent can only implement **interfaces + fake/link UI**, not real upload.

### B3. Map tiles **Required**

- Free satellite (e.g. Esri imagery) + **custom Cap attribution chip** — OK?
- Fallback OSM streets if imagery fails — OK?
- Any **API key** for a preferred free/paid provider, or stay keyless free tiles only?

### B4. Analytics / crash reporting **Default OK**

- None in MVP (privacy, no account). Override?

### B5. App identity **Required**

- Android `applicationId`: `de.himmelcad.cap` OK?
- iOS bundle id: `de.himmelcad.cap` OK?
- Display name: **himmel:cap** vs **HimmelCAD Cap** on home screen?

### B6. Distribution for first binary **Required**

- Debug APK / sideload only?
- Internal Play track?
- TestFlight?
- Not part of this run (library + PhotoLab only)?

---

## C. Product behaviour

### C1. Accuracy targets (already drafted) **Confirm**

- Global **&lt; 30 cm** horizontal on Pixel-class + NTRIP + PhotoLab BA, open-sky protocol
- Local **&lt; 7 cm** relative
- Go/no-go after field validation — **do not block code MVP**, only marketing — OK?

### C2. Devices **Required**

- **Reference device you will test:** Pixel 8a / other model?
- Must app refuse capture on phones without raw GNSS, or always allow with low tier?

### C3. Projects model **Default OK**

- Projects are **local only** on device until cloud sync of project list exists
- Create project in-app: name only
- No multi-user roles in MVP
Override?

### C4. Job save **Default OK**

- Prefill name: `{date} {time} · {projectName}`
- Description optional
- Packing continues while dialog open; Save enabled when `.hcap` ready
- Cancel discards session? **or** keep as draft job? **Required** (pick discard vs draft)

### C5. Notes **Default OK**

- Append-only notes on job; original description is first note entry
- No edit/delete of past notes in MVP

### C6. Capture technical defaults **Default OK / confirm**

| Setting | Proposed default |
| --- | --- |
| Mode | Video preview + smartstills |
| Still trigger | distance ~0.2 m **or** 1.5 s min interval (whichever first) |
| Focus | lock far / infinity when API allows |
| AE/AWB | lock after first meter |
| HDR / Night | force off when possible |
| Resolution | max still size main camera |
| Video file kept | **no** in default package (stills only in `.hcap`) unless `full` later |

**Required:** Is **distance 0.2 m** OK, or prefer time-only (e.g. every 1 s)?

### C7. GNSS / RTK **Default OK / confirm**

| Item | Proposal |
| --- | --- |
| Full tracking while recording | on |
| NTRIP GGA upload interval | 1–5 s |
| Prefer multi-GNSS | yes |
| False fix policy | conservative; show Float rather than wrong Fix |
| iOS | CoreLocation only; same HUD with honest labels |
| External RTK Bluetooth | **out of MVP** |

**Required:** Ship a **minimal on-device RTK engine** (license-clean) vs **first ship NTRIP-fed positions only when using OS/fused + correction age display** until engine chosen?

This is the hardest engineering fork:

| Path | Meaning |
| --- | --- |
| **E1** | Integrate open-source or commercial RTK lib (must clear BSL license) |
| **E2** | Log raw + NTRIP; run PPK offline in PhotoLab later (weaker live HUD) |
| **E3** | Use third-party SDK (name + license + cost) |

**Required: E1 / E2 / E3** (and if E1/E3, allowed libraries).

### C8. Cloud folder conventions **Required if cloud**

- Default remote path: `/HimmelCAD Cap/{projectName}/` ?
- Upload: `{jobName}.hcap`
- Bestandsplan pull: fixed name `bestandsplan.dxf` or latest `*.dxf` by mtime?
- Auto-upload after save: default off or on?

### C9. DXF overlay **Later unless scope D**

- Which DXF entities (LINE, LWPOLYLINE, POLYLINE, CIRCLE, …)?
- CRS of office DXF (e.g. UTM32N / EPSG:25832) — **Required if D**
- How does Cap know project CRS for overlay? Project setting?

### C10. Offline **Default OK**

- Capture always offline-capable
- Map: last tiles cache best-effort
- NTRIP: show red / no correction when offline

---

## D. PhotoLab integration

### D1. Importer in same run? **Required**

- Yes: PhotoLab opens `.hcap`, creates capture group + priors
- No: only Cap packs files; importer separate milestone

### D2. Prior source enum **Default OK**

- Add `himmelCap` to `CapturePositionPriorSource` (Rust + TS)
- Never auto `crsBacked`

### D3. Coordinate / height **Default OK**

- Store WGS84 lat/lon + ellipsoid height when available
- Height semantic flagged; PhotoLab CRS wizard does geoid

---

## E. Legal / license (hard stops)

### E1. RTK engine license **Required with C7**

Monorepo forbids GPL in product.
Is **GPL RTKLIB** banned for Cap binary? (Almost certainly **yes** → need permissive fork, clean-room, or commercial SDK.)

### E2. Map attribution **Default OK**

- Visible Cap-styled chip on map + settings licence text

### E3. Privacy text **Default OK**

- Short DE permission rationales for camera + location
- No analytics

### E4. Commercial license of Cap itself **Default OK**

- Same BSL/BUSL as monorepo

---

## F. UI / design freeze

### F1. Prototype is visual source of truth? **Required**

- Flutter must match `apps/cap-prototype/screenshots/*.png` within reasonable mobile platform chrome (status bar, etc.)
- Deviations only for platform guidelines (e.g. iOS back gesture)

### F2. Theme **Default OK**

- Dark default, light available, system option
- Tokens ported from `@himmelcad/theme`

### F3. Kamikaze for “Einstellungen” / “Jobs” titles only? **Default OK**

- Yes; body Inter

### F4. Burger vs menu icon **Default OK**

- Lucide `menu` as now; projects+jobs screen title “Jobs” in Kamikaze

---

## G. Testing & devices for the agent

### G1. What can the agent run without your phone? **Confirm**

| Test | Available? |
| --- | --- |
| Flutter unit/widget tests | yes |
| Android emulator | **Required:** is emulator OK on this machine / should agent install? |
| Real Pixel device USB | **Required:** will you plug in for final check only? |
| NTRIP live | needs B1 |
| PhotoLab importer golden fixture | yes (synthetic `.hcap`) |

### G2. CI **Default OK**

- Flutter analyze + tests in monorepo CI later; not blocking first green APK

---

## H. Non-goals (confirm freeze)

Confirm **out of MVP long-run**:

- [ ] External RTK hardware
- [ ] Mandatory GCPs
- [ ] Dense SfM on phone
- [ ] Own cloud server
- [ ] Cadastre-grade always-cm claims
- [ ] Full DXF editor
- [ ] Multi-user live collaboration

---

## I. Answer template (copy-paste)

```text
A1: B | C | D | …
A2: yes defaults
A3: DE primary
A4: defaults
A5: branch + commits ok; draft PR at end; PhotoLab importer only
B1: mock NTRIP | credentials in … (path)
B2: Drive y/n; Dropbox y/n; OneDrive y/n; client ids: …
B3: free Esri + Cap chip OK
B5: de.himmelcad.cap; home screen name: himmel:cap
B6: debug APK / sideload
C2: reference Pixel 8a; allow low-tier capture on all phones: yes
C4: cancel = discard | draft
C6: still trigger: 0.2 m / time …
C7: E1 | E2 | E3 + library name
C8: paths … (if cloud)
C9: … (if DXF)
D1: importer yes/no
E1: no GPL in app
F1: screenshots are SoT
G1: emulator yes/no; device later
H: non-goals confirmed
Anything else:
```

---

## J. Suggested “defaults pack” if you want maximum speed

Reply literally: **`defaults + A1=B + C7=E2 + D1=yes + A3=DE + B6=sideload APK`**

That means:

- Flutter Android+iOS UI
- Live HUD from best available GNSS; raw log + NTRIP stored; full on-device RTK engine deferred if license unclear
- PhotoLab `.hcap` importer included
- German UI
- No real cloud OAuth until you send client IDs (UI stubs only)
- Visual match to screenshots

Upgrade to **E1** when you name an allowed RTK library.

---

## Screenshot baseline (for Flutter parity)

Directory: `apps/cap-prototype/screenshots/`

| # | File | Screen |
| --- | --- | --- |
| 01 | `01-map-dark.png` | Map dark |
| 02 | `02-project-dropdown.png` | Project dropdown |
| 03 | `03-job-detail.png` | Job detail |
| 04 | `04-job-notes.png` | Job notes |
| 05 | `05-menu-projects-jobs.png` | Menu projects/jobs |
| 06 | `06-settings-top.png` | Settings |
| 07 | `07-settings-cloud.png` | Settings cloud |
| 08 | `08-rtk-create-modal.png` | RTK create |
| 09 | `09-capture-idle.png` | Capture idle |
| 10 | `10-capture-recording.png` | Capture recording |
| 11 | `11-save-job-dialog.png` | Save packing |
| 12 | `12-save-job-ready.png` | Save ready |
| 13 | `13-map-light.png` | Map light |
| 14 | `14-settings-light.png` | Settings light |
| 15 | `15-add-note-modal.png` | Add note |
| 16 | `16-capture-gnss-*.png` | GNSS HUD states |

Regenerate: `python3 apps/cap-prototype/capture-screenshots.py` (server on :8765).
