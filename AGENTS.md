# HimmelCAD Agent Rules

Diese Datei ist die kurze, verbindliche Arbeitsanweisung fuer Menschen und
KI-Agenten. Sie enthaelt nur Regeln, die bei jedem Task im Kopf sein muessen.
Produktdetails, Roadmap und Architekturgruende stehen in den referenzierten
Dokumenten.

Wenn eine Aufgabe unklar ist oder eine Regel verletzt werden koennte: erst
nachfragen, dann coden.

## 0. Dokumentenkarte

- **Aktuelle Ausfuehrungsrichtung, Lanes, Scope-Freezes:**
  `docs/CURRENT-DIRECTION.md` (bei Widerspruch zur aelteren Roadmap-Prosa
  gewinnt dieses File fuer Sequenz und Freezes)
- **Design-System (alle Produkte):** `docs/DESIGN-SYSTEM.md` + Tokens in
  `packages/@himmelcad/theme`, Module in `packages/@himmelcad/ui`
- Produktvision und langfristiger Scope: `docs/PRODUCT-VISION.md`
- Roadmap und Phasen: `docs/ROADMAP.md`
- Architekturueberblick: `docs/ARCHITECTURE.md`
- Datenmodell: `docs/DATA-MODEL.md`
- Projektformat: `docs/PROJECT-FORMAT.md`
- MVP-Plan: `docs/MVP-PLAN.md`
- Offene Entscheidungen: `docs/OPEN-QUESTIONS.md`
- ADRs: `docs/adr/` (Entity: 0016, Render: 0017)
- Third-Party-Lizenzen: `LICENSES/THIRD_PARTY.md`

## 1. Identitaet und Prioritaeten

- **Produktfamilie:** HimmelCAD.
- **Aktueller Fokus:** HimmelCAD PhotoLab als Delivery-Produkt; parallele
  Kernel-Arbeit an Entities (ADR 0016) und Render-Core (ADR 0017). Builder
  bleibt das CAD-Produkt, weitere CAD-Feature-Productization ist pausiert.
- **Produktfamilie:** HimmelCAD Builder, HimmelCAD PhotoLab, HimmelCAD
  WeltView. **Composer, TestFlight und ChronoGit sind nur reservierte Namen**
  bis zu einem expliziten Decision Gate — keine Implementierung, keine
  Agent-Aufgaben dafuer. Details: `docs/PRODUCT-VISION.md` und
  `docs/CURRENT-DIRECTION.md`.
- **ChronoGit-Tax:** Command-Journal, immutable Objects und stabile IDs sind
  erwuenscht. Diff-UI, Merge-Produkt und weitere Schema-Komplexitaet nur fuer
  ChronoGit sind eingefroren.
- **Prioritaet:** Performance > intuitive UX > Aesthetik.
- HimmelCAD ist 3D-first. Es darf kein 2D-CAD entstehen, dem spaeter 3D
  angeklebt wird.
- Import darf teuer sein. Runtime-Interaktion muss fliegen.
- Parallel-Arbeit: Kernel/Viewer-Lane und PhotoLab-UI-Lane trennen. UI-Polish
  lebt unter `apps/photolab/renderer/`; Kernel unter `crates/` und
  `packages/@himmelcad/viewer/`. Siehe `docs/CURRENT-DIRECTION.md`.

## 2. Lizenz und Dependencies

### Harte Lizenzregeln

- Eigener Code steht unter BSL/BUSL 1.1, solange keine andere Entscheidung in
  `docs/OPEN-QUESTIONS.md` geklaert ist.
- In Produkttexten darf HimmelCAD als Open Source beschrieben werden; die
  rechtlich verbindlichen Regeln stehen trotzdem in Lizenzdateien und
  Third-Party-Dokumentation.
- Kommerzielle Nutzung/Distribution ist nur durch den Lizenzgeber erlaubt.
- Forken und selbst bauen ist nur fuer private, Hobby-, Research- und sonstige
  nicht-kommerzielle Nutzung erlaubt.
- Neue Dependencies oder vendored Code muessen mit diesem Modell kompatibel
  sein.

### Verboten fuer Produktcode

- GPL, LGPL, AGPL, SSPL.
- Commons Clause oder andere Klauseln, wenn sie mit dem HimmelCAD-Lizenzmodell
  kollidieren.
- Copy/Paste, Portierung oder abgeleitete Implementierung aus GPL-Familiencode.
  `libs/CloudCompare-master` und aehnliche Quellen sind nur Referenz zur
  Orientierung, nie Build-Input und keine Portierungsquelle.

### Erlaubt, sofern korrekt dokumentiert

- MIT, BSD-2/3-Clause, Apache-2.0, ISC, MPL-2.0 mit File-Level-Trennung, Zlib,
  Unlicense, CC0, BUSL/BSL-kompatible eigene Komponenten.

### Dependency-Workflow

Vor jeder neuen Dependency oder jedem Vendoring:

1. Lizenz im Lockfile und im offiziellen Repo pruefen.
2. Eintrag in `LICENSES/THIRD_PARTY.md` ergaenzen.
3. Bei Unsicherheit: Entscheidung im PR/ADR offen ausweisen.
4. Wenn Code modifiziert werden soll: lieber vendoren unter `vendor/<name>/`
   als heimlich um die Dependency herum arbeiten.

`libs/` bleibt Referenz/Inspiration. Produktcode kommt aus `apps/`, `packages/`,
`crates/` oder explizit dokumentiertem `vendor/`.

## 3. Performance-Invarianten

- Keine globale O(N)-Runtime-Arbeit ueber Punktwolken, Triangles oder Splats.
- Grosse Daten werden gestreamt: Punktwolken, Meshes, Texturen, Splats,
  Orthofotos und spaetere Panorama-/Rasterdaten.
- Hot Paths greifen auf vorbereitete Strukturen zu. Importer/Preprocessor bauen
  Octrees, BVHs, Tile-Hierarchien, Mipmaps, Statistiken, Spatial-Indizes und
  renderfreundliche Buffer vor.
- Renderer-Hot-Path:
  - keine unnoetigen Allokationen in `requestAnimationFrame`,
  - keine `map`/`filter`/`reduce` in inneren Punkt-/Triangle-Loops,
  - keine String-Arbeit in Render-Loops,
  - Typed Arrays fuer Punkt-, Index- und Attributbuffer.
- Jede CPU-Arbeit > 8 ms gehoert in Worker, Rust-Sidecar oder spaetere
  Compute-Sidecars.
- Punktwolken-/Mesh-Daten werden im Renderer nie dauerhaft voll gehalten. Der
  Renderer besitzt nur sichtbare/gestreamte Ausschnitte.
- Neue Render-Pipelines, Importer und Spatial-Indizes brauchen Benchmarks oder
  mindestens Performance-Smoke-Tests. Regressionen > 10 % muessen begruendet
  werden.
- Jede rechenintensive Operation, die einen Fortschrittsbalken rechtfertigt,
  muss inkrementellen Fortschritt melden und spaeter ueber einen Cancellation-
  Token abbrechbar sein.

Details:

- Cursor/Picking: `docs/adr/0002-cursor-coordinates.md`
- Pointcloud-Streaming: `docs/adr/0003-pointcloud-streaming.md`
- Large-Geometry-Vertraege: `docs/adr/0004-large-geometry-contracts.md`

## 4. Architektur-Invarianten

- Authoritative State liegt im Rust-Core/Sidecar bzw. spaeter in der
  browserfaehigen WASM-Variante. UI ist Mirror, nicht Quelle der Wahrheit.
- Alle Schreiboperationen laufen durch Commands. Keine UI-Komponente mutiert
  kanonische Entities direkt.
- Commands muessen undo-/redo-faehig, journalbar, replaybar und spaeter
  ChronoGit-diffbar sein.
- Builder und WeltView teilen Renderer und Datenvertraege.
- Shared Renderer/Data Packages duerfen kein Electron importieren.
- Electron-spezifische APIs leben nur unter `apps/<desktop-product>/electron/`;
  geteilte Renderer-/Datenpakete bleiben Electron-frei.
- Rust-Core-Code muss plattformneutral bleiben und darf nicht unnoetig Desktop-
  Filesystem-Annahmen in gemeinsame Logik ziehen.
- Grosse renderbare Daten implementieren den gemeinsamen `TiledDataset`-Pfad.
  Keine neue Large-Geometry-Sonderpipeline ohne ADR.
- Picking/Snapping liefert `SnapResult`/`GeometryTargetRef`. Exakte
  schreibende Operationen revalidieren Entity/Tile/Primitive im Core.
- Features duerfen WeltView-, ChronoGit- oder TestFlight-Kompatibilitaet nicht
  unnoetig verbauen. Wenn eine Funktion desktop-only ist, muss sie klar
  gekapselt werden.

## 5. Koordinaten und Einheiten

- Intern: kartesischer Welt-Raum, `f64`, Z ist Up.
- Rendering: `f32` relativ zu stabilem Render-/Tile-Offset.
- Cursor-Anzeige und CAD-Werkzeuge arbeiten mit weltabsoluten Koordinaten.
- Drawing-/Edit-Tools duerfen nie mit GPU-`f32` als Wahrheit rechnen.
- CRS, Hoehensysteme und Einheiten sind Metadaten bzw. UI-/Import-/Export-
  Themen. Die Engine reprojiziert nicht implizit.
- Keine automatische Massstabskorrektur, keine NTv2-Grids, keine stille
  Koordinatentransformation.

## 6. UI und Bedienung

### Layout

- Top: Ribbon, einklappbar zu Dropdown-Headern.
- Links: Entity Tree, spaeter alternative Sortierungen wie Layer in eigenem Tab.
- Rechts: 1. ab: Kontext-/Funktionspanel, oeffnet bei Funktionsaktivierung. 2. Tab: Eigenschaften der ausgewählten Entitie. Bei Multiselect sind die Eigenschaften aller editierbar. Namentliche Anzeige der geteilten Eigenschaften "multiple" wo sich die Eigenschaften unterscheiden.
- Rechts Rechts: Später rechts neben der Rechten Bar nochmal eine mit einem AI-Agent Chat.
- Unten: Konsole.
- Mitte: Viewport, spaeter Multi-View-Tabs.
- Linke, rechte und untere Leiste bleiben einklappbar.
- Unten rechts im Viewport: persistente Cursor-Koordinatenanzeige.

### Mausmodell

| Aktion                | Verhalten                                    |
| --------------------- | -------------------------------------------- |
| LMB Klick             | Auswahl / Funktionsklick                     |
| LMB Hold + Drag       | Orbit, horizon-locked, Z-Up                  |
| LMB Doppelklick       | aktive Funktion abschliessen                 |
| RMB Klick auf Auswahl | Kontextmenue                                 |
| RMB Klick leer        | Quick-Function-Bar am Cursor                 |
| RMB Hold + Drag       | Pan                                          |
| MMB/Wheel Hold + Drag | Pan als zusaetzliche CAD-kompatible Belegung |
| Wheel                 | Zoom, Pivot = Cursor-3D-Position             |
| Esc                   | Funktion abbrechen                           |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo                                  |

### Aesthetik

- VSCode Dark Islands Look: dunkle Void-Flaeche, Panels als eigene Islands,
  keine zusammengeklebten Standard-Borders.
- Keine ungestylten Browser-/Electron-Defaults fuer Checkboxes, Alerts,
  Dialoge, Toasts oder Controls.
- Theme Tokens aus `packages/@himmelcad/theme`; keine One-off-Hexcodes in
  Komponenten.
- Lucide React fuer Standardicons, eigene CAD-Icons wo noetig.
- Animationen subtil, < 200 ms, nie blockierend.

## 7. Konsole und Progress

- Die In-App-Konsole ist primaeres Kommunikationsmedium zwischen App und User.
- Jede neue nutzerrelevante Funktion loggt Start, Abschluss mit Dauer/Statistik
  und erwartbare Fehlerszenarien.
- Long-running Ops > 1 s brauchen `progressKey`-Progress, der in-place
  aktualisiert. Keine reine 0-auf-100-Anzeige, wenn echter Fortschritt
  abgreifbar ist.
- Log-Level:
  - `info`: nutzerrelevante Aktion,
  - `warn`: Degraded/Fallback, aber lauffaehig,
  - `error`: Operation gescheitert + klare Handlungsempfehlung,
  - `debug`: interne Diagnose.
- Jede Ribbon-/Command-Funktion soll spaeter auch ueber die Konsole erreichbar
  sein. Keine doppelte Registrierung neben dem Command-System.
- Python-Konsole/Scripting nutzt spaeter einen gemeinsamen Scripting-Sidecar
  plus SDK und bleibt ein Submodus derselben Konsolenidee, kein zweites Panel.

## 8. Code-Konventionen

### TypeScript

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Kein `any`, ausser lokal begruendet bei vendored/FFI-Grenzen.
- `unknown` + Narrowing oder Branded Types.
- Absolute Imports via `@himmelcad/*`; keine langen `../../../`-Ketten.
- ESLint + Prettier muessen fuer beruehrte produktive Dateien gruen sein.

### Rust

- `#![deny(unsafe_op_in_unsafe_fn, missing_docs, rust_2018_idioms)]` in
  Crates, sobald sie nicht mehr reine Skeletons sind.
- `clippy --all-targets --all-features -- -D warnings` ist Zielzustand.
- `unsafe` nur fuer FFI/SIMD/Zero-copy und mit `SAFETY:`-Begruendung.
- Bibliotheken nutzen `thiserror`; `anyhow` nur in Binaries.

### Kommentare

- Keine narrativen Kommentare.
- Kommentare erklaeren warum, nicht was.
- Marker fuer nicht-offensichtliche Constraints: `SAFETY:`, `PERF:`,
  `INVARIANT:`.

### Tests

- Pflicht fuer Importer, Geometriealgorithmen, Commands, Reducer und
  migrationsrelevante Datenmodelle.
- Visual Regression ab UI-Phase 2.
- Performance-Smokes fuer grosse Punktwolken und spaeter Mesh/Splat-Pipelines.

## 9. Prozessregeln

- Vor nicht-trivialen Aenderungen: kurzer Plan oder Mini-ADR.
- Architekturentscheidungen: nummeriertes ADR unter `docs/adr/`.
- Feste Entscheidungen, die waehrend der Implementierung getroffen werden,
  muessen in Roadmap, ADR, Architektur-/Produktdoku oder `AGENTS.md`
  nachgezogen werden, sobald sie fuer spaetere Arbeit relevant sind.
- `AGENTS.md` bleibt kompakt. Detailwissen gehoert in Roadmap, Doku oder ADRs;
  hier stehen nur Regeln, die bei jedem Task aktiv gebraucht werden.
- Keine stillen Renderer-Features, die in Core/Command-System gehoeren.
- Keine TODO/FIXME ohne Issue-Nummer oder klare Kurzbegruendung.
- Dirty Worktree respektieren: keine fremden Aenderungen revertieren.
- Conventional Commits: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`,
  `chore:`, `test:`, `build:`.

## 10. Dev-Server-Reload-Pflicht

Nach Code-Aenderungen muss verifiziert werden, dass der laufende Dev-Server die
Aenderung erhalten hat:

| Aenderung                        | Verifikation                                 |
| -------------------------------- | -------------------------------------------- |
| CSS, React-Komponenten           | HMR-Log `hmr update <path>` ohne Folgefehler |
| Mount-only Hooks/Refs            | Remount ausloesen oder Dev-Reload            |
| Electron Main/Preload/Sidecar TS | kompletter Dev-Restart                       |
| Rust Sidecar/Crates              | `cargo build` + Sidecar-/Dev-Restart         |
| Theme Tokens                     | HMR reicht, gecachte Werte beachten          |

Nicht sagen "teste mal", bevor HMR oder Restart im Terminal geprueft wurde.

## 11. Sicherheit

- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Native Calls nur ueber minimale Preload-API.
- Keine `eval`, kein `new Function`, kein `unsafe-eval`.
- User-Pfade vor Sidecar-Calls kanonisieren und auf erlaubte Bereiche
  beschraenken.

## 12. Glossar

- **Source-Entity:** immutable Originaldaten.
- **Derived-Entity:** virtuelle/abgeleitete Entity ueber Filter, Selektion,
  Transformation oder Generierungsparameter.
- **Render-Offset:** stabile Translation fuer praezises `f64` -> `f32`
  Rendering.
- **Command:** einziger kanonischer Mutator.
- **Manifest:** aktive Projektszene mit Entity-Refs und View-State.
