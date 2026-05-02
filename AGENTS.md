# Himmelcad — Projekt-Regeln

> Diese Datei ist verbindlich für **alle** Beiträge — menschlich oder durch
> KI-Agenten (Cursor, Claude, Copilot, etc.). Cursor liest diese Datei bei
> jedem Task automatisch. **Wenn etwas unklar ist: erst fragen, dann coden.**

---

## 0. Identität & Mission

- **Produktfamilie:** Himmelcad
- **Module (in Reihenfolge der Entwicklung):**
  1. **Polyshape** — das eigentliche CAD (3D-Punktwolke first)
  2. **Photolab** — Photogrammetrie / Gaussian Splats (Metashape-Klon)
  3. **Weltview** — Browser-Viewer für Polyshape-Projekte (Read-Only + Measurements + IoT-Live-Daten)
  4. **Chronogit** — Git-fähiges CAD (nur nach positiver Machbarkeitsstudie)
  5. **Testflight** — Skriptbare Simulationen (nur nach positiver Machbarkeitsstudie)
- **Top-Prio:** Performance > Bedienbarkeit > Ästhetik. Niemals einer
  niedrigeren Prio zuliebe eine höhere opfern.

---

## 1. Lizenz & Dependencies (HARTE Regeln)

### 1.1 Eigene Lizenz
- Himmelcad steht unter **BSL 1.1** (Business Source License). Alle Header, alle
  Repos. Forken und selber bauen ist **nur für privaten, nicht-kommerziellen
  Gebrauch** erlaubt. Kommerzielle Distribution erfolgt ausschließlich durch
  den Lizenzgeber.

### 1.2 Verbotene Dependency-Lizenzen
Folgende Lizenzen sind **strikt verboten** für Code, der ins Produkt eingebaut
oder daraus abgeleitet wird:
- **GPL** (alle Versionen, inkl. v2, v3)
- **LGPL** (außer als reines dynamisch geladenes Plugin außerhalb des Builds)
- **AGPL** (alle Versionen)
- **SSPL**
- **Commons Clause**, sofern Bedingungen mit BSL kollidieren

### 1.3 Erlaubte Dependency-Lizenzen
- MIT, BSD-2/3-Clause, Apache-2.0, ISC, MPL-2.0 (file-level copyleft, ok solange
  Datei separat bleibt), Zlib, Unlicense, CC0, BSL 1.1.

### 1.4 Dependency-Workflow
- **Vor** Aufnahme einer neuen Dependency:
  1. Lizenz im Lockfile UND im offiziellen Repo prüfen
  2. Eintrag in `LICENSES/THIRD_PARTY.md` ergänzen (Name, Version, Lizenz, URL, Verwendungszweck)
  3. Bei kleinster Unsicherheit: in PR-Beschreibung ausweisen und Lizenztext anhängen
- **CI** prüft automatisch via `cargo deny` (Rust) gegen die Allowlist; ein
  Node-Lizenzcheck (`license-checker-rseidelsohn` oder gleichwertig) wird
  ergänzt, sobald die erste Node-Dependency-Welle stabil ist.
- **Niemals** GPL-Code "portieren" — auch nicht zeilenweise umgeschrieben. CloudCompare etc. dürfen ausschließlich als **Inspiration zum Algorithmenverständnis** dienen. Implementierungen müssen aus Originalpapieren oder MIT/BSD-Quellen erfolgen.

### 1.5 `libs/`-Ordner
- Inhalte in `libs/` sind **Referenzen / Inspiration**, **kein Build-Input**.
- Nichts aus `libs/` wird in den Produkt-Build kopiert oder daraus geforked, wenn nicht zuvor Lizenz und Implementierungspfad explizit in einem ADR geklärt wurden.

---

## 2. Performance-Regeln

> Performance ist **nicht** ein nachträglicher Optimierungsschritt. Sie wird in
> jeder Designentscheidung mitgedacht.

### 2.0 Doktrin: Import teuer, Runtime billig

- **Import darf teuer sein, Runtime nicht.** Lieber dauert ein Import
  3 Minuten und danach fliegt das Projekt, als dass der Import schnell ist und
  die Bedienung später ruckelt. Importer berechnen so viel wie möglich vor:
  Octrees, KD-Bäume, Tile-Hierarchien, Mesh-LOD, Mipmaps, Normalen,
  Bounding-Volumes, Klassifikations-Histogramme, Statistiken,
  vor-quantisierte Render-Buffer, Splat-Sortier-Hierarchien.
- **Runtime rechnet nicht, Runtime liest.** Hot Paths greifen nur auf
  vorbereitete Strukturen zu, sie iterieren nie über Rohdaten.
- **Edits sind incremental und non-destructive.** Sie machen die
  Pre-Computation nicht ungültig. Strukturelle Änderungen, die es doch tun
  müssten, lösen einen sichtbaren Hintergrund-Re-Optimize aus, blockieren
  aber nie die Interaktion.
- **Pre-Computation persistiert on-disk.** Was beim Import berechnet wurde,
  liegt im Projekt-Objektspeicher und wird beim nächsten Öffnen nie neu
  berechnet.

### 2.1 Hot-Path-Regeln

1. **Render-Hot-Path frei halten.**
   - Keine Allokationen in `requestAnimationFrame`-Callbacks (Vektor-Pools nutzen).
   - Keine `Array.prototype.map`/`filter`/`reduce` in inneren Schleifen über Punkte/Triangles.
   - Keine String-Konkatenation in der Render-Loop.
2. **Typed Arrays only** für Punkt-, Index-, Attribut-Buffer (`Float32Array`, `Uint32Array`, `BigInt64Array` für Indices > 4 G, `Float64Array` nur für Storage, nie für GPU).
3. **Web Worker / Rust-Sidecar für jede CPU-Arbeit > 8 ms.** Faustregel: alles, was den Mauscursor-Refresh stören könnte, gehört aus dem Main-Thread raus.
4. **Streaming statt Laden.** Punktwolken, Meshes, Texturen, Splats werden gestreamt (Octree- bzw. Tile-basiert). Nichts wird "ganz" geladen.
5. **Non-destructive Edits.** Punkte werden nie kopiert oder umgeschrieben — Klassifikations-/Selektions-Layer sind sparse Bit-Sets über dem Original.
6. **Coordinate Precision:** Speicherung in `f64` (welt-absolut), Rendering in `f32` mit konstantem Render-Offset pro Szene → siehe §4.
7. **Picking & Cursor-Koordinate** dürfen den Frame-Budget nie sprengen. Hardware-Picking via Depth-Buffer, kein Iterieren über alle Punkte.
8. **Lazy Geometry.** Achsen, IFC-Hierarchien, Wand-Generierung aus Linien etc. werden erst bei sichtbarem Frustum/Detailgrad evaluiert.
9. **Benchmark Pflicht.** Jede neue Render-Pipeline / Importer kommt mit Mikro-Benchmark im Repo (`benches/`). Regression > 10 % blockiert Merge.

### 2.2 Performance-Ziele (Referenz: aktueller Laptop mit dGPU)

- 200 M Punkte: Orbit/Pan/Zoom > 60 fps mit dynamischem Punktbudget.
- 50 M Triangles tiled mesh: Orbit/Pan/Zoom > 60 fps mit LOD.
- 5 M Gaussian Splats: > 60 fps in einer leeren Szene, > 30 fps zusammen mit
  einer Punktwolke.
- Cursor-Koordinate aktualisiert sich in < 16 ms im stabilen Zustand.
- Erste sichtbare Punkte beim Öffnen eines bereits importierten Projekts: < 1 s.
- Frame-Spikes > 50 ms gelten als Bug, nicht als gelegentlicher Jank.
- Import einer 50-GB-LAS-Sammlung darf länger dauern als deren Anzeige —
  aber Anzeige danach muss obenstehende Ziele halten.

---

## 3. Architektur-Invarianten

> Diese Regeln sind nie verhandelbar ohne Architecture Decision Record (ADR).

1. **Authoritative State liegt im Rust-Core.** Die UI ist ein Mirror, nie die Quelle der Wahrheit.
2. **Renderer ist Web-only und browserfähig.** Polyshape (Electron) und Weltview (Browser) teilen sich denselben Renderer-Code in `packages/@himmelcad/viewer`. Electron-spezifische APIs (Native Menüs, FS-Dialoge, Sidecar-IPC) leben ausschließlich in `apps/polyshape/electron/`. **Kein** Renderer-Code darf `require('electron')` etc. enthalten.
3. **Rust-Core ist plattform-neutral.** Ein- und derselbe Rust-Workspace baut zu (a) NAPI-RS Node-Modul für Electron und (b) `wasm-bindgen` Modul für Weltview. Kein Code darf nur in einem Target funktionieren.
4. **Entities sind immutable + content-addressable.** Jede Änderung erzeugt eine neue Version (Hash-adressiert), die alte bleibt referenzierbar. Das ist die Grundlage für Undo/Redo, Chronogit und semantische Diffs.
5. **Welt-Koordinaten sind authoritative.** Der Nutzer arbeitet immer in einem **übergeordneten kartesischen Koordinatenraum** (`f64`). Der Render-Offset wird automatisch berechnet und nie dem Nutzer angezeigt. Kein Code im Viewer darf annehmen, der Ursprung sei der Welt-Ursprung.
6. **Z is up.** Welt-Z ist Höhe. Potree/three.js-typische Y-up wird **am Importer-/Adapter-Layer** umgerechnet, nie im Datenmodell.
7. **Alle Schreib-Operationen gehen durch das Command-System.** Kein direktes Mutieren des Stores aus UI-Komponenten. Nur Commands sind undoable und git-fähig.
8. **Keine Feature darf Weltview-Kompatibilität brechen.** Wenn ein Feature nicht im Browser laufen kann, muss es in `polyshape-only`-Modul gekapselt werden, **nicht** im Datenmodell verankert.
9. **Keine Feature darf Chronogit-Kompatibilität brechen.** Konkret: jede Mutation muss als Command-Sequenz reproduzierbar sein und einen semantischen Diff liefern können.
10. **Keine Feature darf Testflight-Kompatibilität brechen.** Konkret: Entitäts-Attribute müssen optional zeit-varianten Wert tragen können (Timeline-fähig).

---

## 4. Koordinaten- & Einheiten-Regeln

- **Intern: kartesisch, einheitenlos im numerischen Sinn, `f64`.** Punktwolken,
  Geometrie, Cursor-Koordinaten — alles existiert in einem **einzigen
  kartesischen Welt-Raum** mit konsistenter Z-Achse als Up. Was für ein CRS
  (UTM, Gauß-Krüger, lokales System, …) die Daten ursprünglich tragen,
  **interessiert die Engine nicht**. Annahme: die Eingabedaten sind bereits
  kartesisch.
- **CRS-Metadatum** wird optional pro Entity **gespeichert**, aber **nie**
  von der Engine zur Berechnung herangezogen. Es dient ausschließlich:
  - späterer Heuristik beim Import (Erkennung "weit auseinanderliegender"
    Datasets → Transformations-Dialog),
  - späterer Anzeige einer Hintergrundkarte (Map-Layer kennt sein eigenes
    CRS und projiziert in unseren kartesischen Raum, nicht umgekehrt),
  - Export (Beibehalten der ursprünglichen CRS-Information).
- **Keine** automatische Maßstabskorrektur, **keine** NTv2-Grids, **keine**
  on-the-fly-Reprojektion innerhalb der Engine. Alle solchen Operationen
  finden ausschließlich an Importer-/Exporter-Adaptern statt — als
  explizite Nutzeraktion, nie implizit.
- Szene-Render-Offset: pro geöffnetem Projekt **eine** Translation
  `T_render = round(min_corner)`. Wird beim ersten Import gesetzt, bleibt
  konstant über die Session. Damit `f64`-Welt-Koords im `f32`-WebGL-Raum
  präzise bleiben.
- Cursor-Anzeige: immer welt-absolut (also Render-Position + `T_render`).
- Längen: dimensionslos intern. Anzeige-Einheit (m, ft, …) ist
  Nutzerpräferenz, der Wandlungspunkt liegt **nur in der UI**.
  Default-Annahme: 1 Welt-Einheit = 1 Meter.
- Winkel intern: Radiant. Anzeige in Grad / Gon nach Nutzerpräferenz.
- Höhensystem (NHN, ellipsoidisch, lokal): nur Metadatum, nicht
  rechen-relevant innerhalb der Engine.

---

## 5. UI-Konventionen

### 5.1 Layout (verbindlich)
- **Top:** Ribbon-Leiste, einklappbar zu Dropdown-Headern (Funktion bleibt erreichbar).
- **Links:** Element-Tree (Reiter für alternative Sortierungen wie Layer).
- **Rechts:** Kontext-/Funktions-Panel. Expandiert automatisch bei Funktions-Aktivierung.
- **Unten:** Konsole (Stil orientiert sich an `libs/polyshapev01/`).
- **Mitte:** Viewport (später mit Tabs für mehrere Views).
- Linke, rechte und untere Leiste sind **immer** einklappbar.
- Unten rechts im Viewport: persistente Cursor-Koordinatenanzeige (X/Y/Z im Projekt-Koordinatenraum).

### 5.2 Maus-Belegung (verbindlich)
| Aktion              | Verhalten                                                          |
|---------------------|--------------------------------------------------------------------|
| LMB Klick           | Auswahl / Funktions-Klick                                          |
| LMB Hold + Drag     | Orbit (horizon-locked, Z-Achse als Up-Vektor)                      |
| LMB Doppelklick     | Funktion abschließen (z. B. gezeichnete Linie beenden)             |
| RMB Klick (Auswahl) | Kontextmenü mit Element-Funktionen                                 |
| RMB Klick (leer)    | Mini-Quick-Function-Bar am Cursor (per RMB auf Ribbon konfiguriert)|
| RMB Hold + Drag     | Pan                                                                |
| MMB / Wheel         | Zoom (Zoom-Pivot = Cursor-3D-Position)                             |
| Esc                 | Funktion abbrechen                                                 |
| Strg+Z / Strg+Shift+Z | Undo / Redo                                                       |

### 5.3 Aesthetik
- **Theme-Tokens** aus `libs/vscode-dark-islands-main/themes/` portieren in `packages/@himmelcad/theme/tokens.css` (CSS Custom Properties). Niemals Hex-Codes hardcoden.
- Icons: Tabler Icons (MIT) — ergänzt um eigene CAD-Icons; das Polyshape-Logo aus `libs/polyshapev01/build/`.
- Schriftart: Inter (UI), JetBrains Mono (Konsole) — übernommen aus `libs/polyshapev01/assets/fonts/`.
- Animationen subtil, immer < 200 ms, nie blockierend.

### 5.4 Konsole
- Eine Quelle (Pino-Style strukturiertes Logging im Renderer + aus dem Sidecar gestreamt).
- Filter-Levels (debug/info/warn/error) per Toggle.
- Suchfeld + Copy.
- ANSI-Style-Farben übernommen aus `libs/polyshapev01/`.

---

## 6. Code-Konventionen

### 6.1 TypeScript
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- Keine `any`. `unknown` + Narrowing oder Branded Types.
- ESLint + `@typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-plugin-import`. Prettier für Format.
- Imports: absolute via `@himmelcad/*`-Aliasse, keine `../../../`-Ketten > 2.

### 6.2 Rust
- `#![deny(unsafe_op_in_unsafe_fn, missing_docs, rust_2018_idioms)]` in jedem Crate.
- `clippy --all-targets --all-features -- -D warnings` muss grün sein.
- `unsafe` ist erlaubt für FFI/SIMD/zero-copy, aber dokumentiert mit Sicherheitsbegründung im Doc-Kommentar.
- Fehler: `thiserror` für Bibliotheken, `anyhow` nur in Bin-Crates.

### 6.3 Kommentare
- **Niemals** narrative Kommentare ("// Setze x auf 5", "// Importiere Modul").
- Kommentare erklären **warum**, nicht **was**.
- `// SAFETY:`, `// PERF:`, `// INVARIANT:`-Marker für nicht-offensichtliche Constraints.

### 6.4 Tests
- Pflicht für jeden Importer, jeden Geometrie-Algorithmus, jeden Command, jedes Reducer.
- Visual-Regression-Tests (Playwright) für UI-Komponenten ab Phase 2.
- Punktwolken-Performance-Smoke-Test in CI: 50 M Punkte LAS muss in < x s indexiert sein (x je Hardware-Klasse dokumentiert).

### 6.5 Commits
- Conventional Commits: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `test:`, `build:`.
- Body in Deutsch oder Englisch — konsistent pro Commit.
- Keine Emoji im Commit-Header.

---

## 7. Datenmodell-Regeln

Volldetail in `docs/DATA-MODEL.md`. Kurzform:

1. **Entity** = `(EntityId, Kind, geometry_ref, attributes_ref, parent?, children, transform?, version_hash)`.
2. **EntityKind** ist ein geschlossener `enum` im Rust-Core. Erweiterungen brauchen Schema-Versionierung.
3. **Attribute** sind eine eigene baumartige (nested) Struktur, separat vom Geometry-Blob (für effizientes Edit ohne Re-Hash der Geometrie).
4. **Sources vs. Derivations:** Eine importierte Punktwolke ist eine "Source". Segmentierung erzeugt zwei "Derived"-Entities (`extracted`, `remaining`) mit Verweis auf die Source und einer Filter-Spec — **keine** Punktdaten-Kopie.
5. **Schema-Versionierung:** Jeder Entity-Kind trägt `schema_version`. Migrationen sind Pflichtbestandteil des PRs, der die Schema-Version bumpt.

---

## 8. Projekt-Format Regeln

Volldetail in `docs/PROJECT-FORMAT.md`. Kurzform:

- Default: **Ordner** `projektname.hcad/` mit:
  - `manifest.json` (Szene-Manifest, Entity-Refs, optionale Import-Metadaten, Render-Offset, View-States)
  - `objects/<sha256-prefix>/<sha256-rest>` (content-addressable BLOBs für Geometrie, Attribute, Texturen)
  - `journal/` (Append-only Command-Log für Undo/Redo & Chronogit)
  - `index/` (optional, abgeleitete Spatial-Indizes — kann jederzeit neu gebaut werden)
- Export: `projektname.hcadx` (zip mit identischer Struktur, optional ohne `index/`).
- Garbage-Collection auf Anforderung (`Datei → Projekt aufräumen`).

---

## 9. IPC-Vertrag (Renderer ↔ Rust-Sidecar)

- **Sidecar ist ein separater OS-Prozess.** Der Electron-Main-Prozess startet
  `himmelcad-sidecar` als Child-Prozess und kommuniziert über JSON-RPC 2.0
  über stdio. Crash-Isolation, gleicher Pattern wie später Photolab
  (Python-Sidecar).
- IPC-Kontrakt (Methoden + Typen) ist in `crates/himmelcad-core/src/contract.rs`
  definiert mit `ts-rs`-Generierung der TypeScript-Typen nach
  `packages/@himmelcad/data/src/generated/`.
- **Eine** Quelle der Wahrheit, niemals doppelte Typdefinition.
- Asynchron, Promise-basiert auf TS-Seite (Wrapper im Preload), Tokio im
  Rust-Sidecar.
- Long-Running Ops (Import, Indizierung) streamen Progress-Events als
  Notifications. Cancellation via Request-Token.
- Für Weltview wird derselbe Vertrag durch eine WASM-Variante
  (`himmelcad-wasm`) bedient — gleicher Funktions-Surface, andere Transport-
  Schicht (`postMessage` zwischen UI-Thread und Worker).

---

## 10. Sicherheit (Electron)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Alle Native-Calls via Preload-Skript mit minimaler API-Oberfläche.
- Keine `eval`, kein `new Function`, kein `unsafe-eval` in CSP.
- File-Pfade vom User werden vor jedem Sidecar-Call kanonikalisiert + auf Allowlist (Projekt-Verzeichnis + explizite Imports).

---

## 11. Process-Regeln (für AI-Agenten und Menschen)

1. **Vor jedem nicht-trivialen Beitrag:** kurzer Plan oder Mini-ADR im PR.
2. **Architektur-Änderungen** brauchen ein nummeriertes ADR unter `docs/adr/`.
3. **Niemals** Funktionalität "still" in Renderer einbauen, die ins Rust-Core gehört (siehe §3.1).
4. **Niemals** Punktwolken-Daten im Renderer dauerhaft halten — nur Streaming-Ausschnitte.
5. **Niemals** GPL-Code per Copy-Paste (auch nicht "umformuliert") aus `libs/` übernehmen — siehe §1.4.
6. Wenn ein Tool/eine Lib unklar ist: lieber fragen als raten.
7. **TODO/FIXME** dürfen committet werden, müssen aber Issue-Nummer + Kurzbegründung enthalten.

---

## 12. Glossar

- **Source-Entity:** Original-Importdaten, immutable.
- **Derived-Entity:** Verweis-basiertes virtuelles Entity (Filter, Selektion, Transformation einer Source).
- **Render-Offset:** Konstante Translation pro Session, um `f64`-Welt-Koords im `f32`-WebGL-Raum zu rendern.
- **Command:** Einziger zugelassener Mutator des Stores; reversible, persistierbar, inspizierbar.
- **Manifest:** Szene-Definition eines Projekts (welche Entities, welche View-States).
