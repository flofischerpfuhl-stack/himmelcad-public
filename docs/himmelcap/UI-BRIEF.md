# HimmelCAD Cap — UI brief (owner + review)

Status: owner vision 2026-07-21 + design review notes.
Implements against `docs/DESIGN-SYSTEM.md` (islands, themes, Inter / mono, accent `#1597f2`).
Marketing shorthand on chrome: **himmel:cap** / product **HimmelCAD Cap**.

## Design principles (mobile)

1. **One-handed field use** — big capture control, few taps to record.
2. **Map-first jobs** — spatial memory beats file trees for crews.
3. **Honest GNSS** — green/amber/red + approximate H/V error always visible in capture.
4. **HimmelCAD family** — floating islands on void, dark default + light theme, shared tokens (Flutter theme port of `--hc-*`).
5. **Progressive disclosure** — settings power (RTK profiles); main path stays simple.

---

## Screen map

```text
Main (map)
  ├─ Job popup → Job screen
  ├─ Capture button → Capture screen
  ├─ Top island: ☰ | settings
  └─ (optional later) list/search jobs

Job screen
  └─ Accordion: GNSS · Corrections · Gallery · …

Settings
  └─ RTK profiles · theme · camera defaults · units · about

Capture
  └─ Live preview · quality HUD · start/stop · end → process → package
```

---

## 0. Projects and jobs

- **Project** = site / Auftrag (e.g. “MUC FTTH Nord”). Contains many jobs.
- **Job** = one capture session → one `.hcap`.
- Map top island **center** shows **active project name** (not product wordmark).
- Tap center → project dropdown. Menu (☰) → collapsible projects → jobs.
- Optional cloud: office drops latest **Bestandsplan.dxf** into a linked folder;
  Cap auto-pulls and overlays on map (no Cap backend). See PRODUCT notes.

## 1. Main screen (map)

### Owner vision

- Full-bleed **satellite basemap** with OSM vector option (or hybrid).
- **Jobs** = capture sessions; each shows a **trajectory** on the map.
- Trajectories as **screen-space constant pixel width** vector polylines (not ground metres that vanish when zoomed out) — e.g. ~3–4 px stroke, rounded joins, optional subtle outline for contrast on imagery.
- Tap trajectory → **popup**: name, date, description, button **Open job**.
- **Top floating island**: left burger, right settings (desktop-like chrome).
- **Bottom**: large round **Capture** button.
- Future: **DXF overlay** on map.

### Review additions

| Item | Suggestion |
| --- | --- |
| Empty state | First launch: short tip + big Capture; no fake jobs |
| Active / last job | Slightly stronger stroke or accent outline on selected trajectory |
| Quality tint (optional) | Polyline colour by session quality summary (green/amber/grey) — not required MVP |
| Location chip | Small “my position” + follow-me toggle (crew walks site) |
| Offline basemap | Cache last tiles; show “offline map” chip when no network |
| Map attribution | **Own Cap UI** (small island chip / muted text), not Leaflet/Google chrome. Full text also under Settings → map licences. Free satellite still needs visible credit; style is ours. |
| Job list fallback | Long-press map empty / search icon if many jobs (burger or top island secondary) |
| Permissions | First capture: camera + location rationale in plain language |
| Export entry | From popup or job: “Share .himmelcap” |

### Map stack (implementation note)

- Prefer MapLibre / flutter_map + raster satellite provider (license/API keys in settings later).
- DXF later: simplify to polylines/polygons in local CRS, reproject to map; not full CAD edit.

---

## 2. Job screen

### Owner vision

- Header: **name, date, description** (editable description).
- **Accordion** sections: GNSS data, correction stream, gallery of frames, other relevant info.

### Suggested accordion sections (MVP → later)

| Section | Content |
| --- | --- |
| **Overview** | Duration, frame count, path length, quality summary (mean σ H/V, %fix/float) |
| **GNSS** | Best tier, dual-freq yes/no, constellation counts snapshot, height semantic |
| **Corrections** | Profile used, caster/mountpoint (no password), connected time, age of corrections stats |
| **Media** | Thumbnail grid; tap → full image; count selected vs recorded |
| **Package** | `.himmelcap` status (ready / processing / failed), share, re-process |
| **Notes** | Free text (capo notes: “Kabel 0,8 m, PE 110”) |
| **Advanced** (collapsed) | Session id, hashes, app version, device model |

### Actions

- Share package
- Delete job (confirm)
- Re-run on-device packing if failed
- Open on map (centre trajectory)

---

## 3. Settings

### Owner vision

- RTK **profiles** (create/select), connection check.
- Plus whatever else is needed.

### Recommended settings groups

| Group | Items |
| --- | --- |
| **Appearance** | Theme: system / dark / light |
| **Map** | Basemap: satellite / streets / hybrid; show my location; units m |
| **Capture defaults** | Smartstills interval mode (distance vs time); target overlap guidance on/off; keep screen on while recording |
| **GNSS** | Prefer full tracking when recording (Android); show advanced σ in capture HUD on/off |
| **RTK / NTRIP profiles** | List profiles; add/edit: name, host, port, mountpoint, user, password (secure storage), TLS if any, GGA upload interval; **Test connection**; default profile |
| **CRS hints** (light) | Optional default horizontal hint (WGS84); height = ellipsoid default; PhotoLab does real CRS |
| **Storage** | Cache size; clear map cache; auto-delete packages older than N days (off by default) |
| **Cloud accounts** | Link **Google Drive**, **Dropbox**, **OneDrive** (Microsoft); default folder per provider; “Upload after capture” on/off; test connection |
| **Export** | Default: save `.hcap` locally + optional auto-upload to default cloud; package profile `office` vs `full` |
| **About / support** | App version, open source licences, send support bundle (logs + meta, no password) |
| **Developer** (hidden) | Verbose GNSS log, force tier labels |

**Not in settings (or advanced only):** professional antenna PCO tables, full geoid picker — PhotoLab territory.

### Field → office flow

1. Capture ends → on-device pack → `*.hcap` (ZIP).
2. Operator: **Upload** (cloud) and/or **Save / Teilen** (USB, cable, Files).
3. Office: PhotoLab imports `.hcap` while crew continues next job.

Cloud is convenience, not required for offline capture.

---

## 4. Burger menu

### Owner: unsure if needed

### Recommendation

**MVP: weak burger** — only if it reduces top-island clutter.

| If burger exists | Contents |
| --- | --- |
| Jobs list (searchable) | Alternative to map-only discovery |
| Settings | Duplicate of gear is OK or gear-only |
| Help / “How to capture” | 4-panel field guide |
| About | Version |
| (Later) Account / license | If commercial gate appears |

**Alternative without burger:**
Top island = `[Jobs list icon] · himmel:cap · [Settings]`. Map stays primary; list is secondary route. Fewer abstract “☰” meanings for non-surveyors.

**Suggestion:** ship **without burger** first; add only if job count or help needs a home.

---

## 5. Capture screen

### Owner vision

- Full **video feed**.
- Bottom large **Start** (then Stop).
- Top: **green / amber / red** for RTK not connected / single / fixed.
- Approximate **error in plan and height**.

### Status model (align with GNSS tiers)

| UI colour | Meaning (operator language) | Technical |
| --- | --- | --- |
| **Red** | Not ready for best geo — no fix path / no corrections / very poor | Offline NTRIP, no GNSS, or σ huge |
| **Amber** | Usable but rough — single / float / weak | Float, single, high σ |
| **Green** | Best available — fixed or excellent float | Fix, or float under threshold |

Show always:

- **~H ± x m** · **~V ± y m** (from filter covariance; mono font)
- Short label: `Keine Korrektur` / `Float` / `Fix` / `Nur Handy-GPS`

### Review additions

| Item | Why |
| --- | --- |
| **Before Start** | HUD already live so operator waits for amber/green |
| **Recording chrome** | Red REC dot + elapsed time + frame count (smartstills taken) |
| **Stop → processing sheet** | “Paket wird gebaut…” progress; cannot lose session on back |
| **Low storage / thermal** | Banner, don’t fail silently |
| **Camera permission denied** | Full-screen recovery, not empty preview |
| **Optional after Stop** | Name + one-line description before save (or auto name `Job 21.07. 14:32` + edit on job screen) |
| **Don’t** | Expert skyplot on main capture (optional advanced sheet) |

---

## 6. Visual system

- Themes: `.hc-theme-dark` default, light per design system.
- Islands: `--hc-bg-island`, radius, shadow on map void.
- Accent: one blue for primary Capture / links; status colours only for GNSS HUD.
- Typography: Inter UI; **JetBrains Mono** for coordinates and σ.
- Wordmark: compact **himmel:cap** in island if space; not competing with map.

---

## 7. Navigation & jobs model

| Term | Meaning |
| --- | --- |
| **Job** | One capture session → one `.himmelcap` (matches package session) |
| **Trajectory** | Fused track used for map display (may be denser than still frames) |
| **Frames** | Selected images in gallery |

Flow:

1. Main → Capture → record → process → new job on map
2. Main → tap trajectory → Job → share

---

## 8. Future (not MVP UI)

- DXF / as-built plan overlay on map
- Multi-user job sync
- In-app PhotoLab status
- AR trench outline guidance
- External RTK accessory mode (hidden advanced)

---

## 9. Open UI decisions

1. Burger vs jobs-list icon (recommend: no burger MVP).
2. Job naming: auto vs forced prompt after stop.
3. Satellite tile provider + licensing.
4. German-first strings vs bilingual (field DE recommended).
5. Whether polyline quality colouring is MVP or later.

---

## 10. Interactive prototype → Flutter

| Approach | Verdict |
| --- | --- |
| **HTML/CSS/JS phone prototype** (`apps/cap-prototype/`) | **Chosen for iteration** with owner: fast, no Flutter install required, maps real basemap, dark/light, all main screens |
| **Flutter Web later** | Production UI; rebuild screens 1:1 from frozen prototype + this brief (not pixel-copy CSS — structure, states, copy) |
| Figma only | No; we need clickable flows |

**Iteration loop:** change prototype → owner feedback → update brief → when frozen, implement Flutter screens matching navigation and components.

Prototype: open `apps/cap-prototype/index.html` via local static server (see README there).

## 11. Verdict

Owner structure (**map + island + capture + job accordion + RTK profiles + capture HUD + cloud/USB export**) is the right product shape for non-surveyors and matches HimmelCAD island language.
Package: **`.hcap` ZIP**.
Prioritise: **capture reliability and honest GNSS HUD** over burger/menu depth; settings = **RTK + cloud links + theme + export**.
