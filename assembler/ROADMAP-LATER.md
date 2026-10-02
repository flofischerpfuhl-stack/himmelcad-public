# HimmelCAD Assembler – spätere Ausbaustufen (To-do)

Stand: 30. September 2026. Florians Richtung nach Block 6: **Assembler nicht
in Richtung Enterprise-MCAD (SolidWorks, NX, Creo) ausbauen, sondern die
Zielgruppe „Konstruieren für den 3D-Druck“ verbreitern** – Maker, Prosumer,
Kleinunternehmen. Reihenfolge nach Verhältnis Aufwand zu Reichweite.
Aufwand in „Blöcken“ (ein Block ≈ die Agentenarbeit eines Blocks 4–6, ca.
200–250 US-$ zu API-Preisen); das sind Schätzungen, keine Messungen.

Die Shapr3D-Parität ([GAP-INVENTORY.md](GAP-INVENTORY.md)) bleibt das
Grundziel (U2); diese Liste beschreibt, was danach bzw. parallel den größten
Nutzen bringt.

## 0. Modularer Umbau nach ADR 0032 (≈ 1 Block, als Nächstes – Florian 2026-09-30)

Assembler hat ~78.000 Zeilen in einem App-Paket (`store.ts` ~100 KB,
`featureTools.ts` ~74 KB); fast jede Integration hatte Konflikte in denselben
Sammeldateien. Umbau jetzt, bevor der Code weiter wächst. Abhängigkeiten nur
nach unten, automatisch geprüft wie bei Builder; Domänenmodule registrieren
ihre Befehle, Werkzeuge, Panels und API-Schemas selbst.

- **Fundament** (Assembler-eigen, ADR 0033): `document` (Features, Parameter,
  Referenzen, Transaktionen/Undo, Dateiformat+Migrationen), `commands`
  (Registrierung, Verfügbarkeit, Shortcuts, Vorschau/Commit/Cancel),
  `geometry-kernel` (einzige Stelle, die OCCT kennt: Adapter, Worker,
  Evaluator/Cache, Tessellierung), `sketch-solver` (planeGCS, Skizzenmodell,
  Regionen), `jobs` (Worker, Fortschritt/Abbruch, Budgets, Timeouts).
- **Darstellung/Gerät:** `viewport` (Renderer-Fork, Picking, Kamera, Overlays),
  `hardware-profile` (gemeinsam mit Builder: `@himmelcad/hardware-profile`),
  `input` (Maus-Presets, Touch/Stift, Tastatur, später SpaceMouse).
- **Domänenmodule:** sketching, modeling, direct-edit, construction,
  parameters, measure, display, interop, templates, print (Analyse,
  Ausrichtung), printers (Druckerprofile, Bauraum, Slicer, später direktes
  Senden an Bambu/Klipper/OctoPrint mit eigenen Sicherheitsregeln).
- **Schnittstelle:** `agent-api` (Vertrag, Headless, lokaler Zugang), `shell-ui`.
- **Produkte = Zusammenstellungen:** `apps/assembler` (Electron) und
  `apps/assembler-web` (PWA) aus denselben Modulen.

Stand 2026-09-30: Phase A erledigt (Fundament, Plattform, Schnittstellen,
Registrierungen, Parameter-/Print-/Printers-Modul, Prüfung mit Allowlist
157 → 53); Phase B (übrige Domänenmodule, drei parallele Pakete) siehe
[MODULES.md](MODULES.md) §6.

## 0b. Kernel-Robustheit über und in OCCT (≈ ½–1 Block, laufend)

1. Robustheitsschicht über OCCT: unscharfe Booleans, ShapeFix-Reparatur,
   koplanare Flächen zusammenführen, automatische Zweitversuche, Timeouts
   für hängende OCCT-Aufrufe (Fuzzer-Befund F13, auch im Headless-Pfad).
2. Kleine Patch-Serie auf dem offiziellen OCCT-Stand im Rezept
   `vendor/occt-wasm` (wie PDFium in Fernwork), Kandidaten aus dem Fuzzer
   (z. B. F3/F11: Ergebnis hängt von Speicherlayout/Reihenfolge ab); gute
   Fixes upstream melden. Voraussetzung: OCCT selbst nach WASM kompilieren
   (heute nur Relink) – auf diesem PC viele Stunden pro Durchlauf.
3. Kein harter Fork und keine Neuentwicklung der Kernalgorithmen.

## 1. Browser-Version und weitere Plattformen (≈ ½–1 Block)

- Web-Version auf einer Subdomain von himmelcad.com (Florian: Hosting ist
  kein Problem). Offline-fähig als PWA; Projekte lokal (File System Access
  API / Download), kein Cloud-Zwang.
- Das eigene OCCT-Modul (`vendor/occt-wasm`) wird dabei als statisches
  Asset mit ausgeliefert; LGPL-Quellpflicht über das veröffentlichte Rezept.
- Linux- (AppImage/deb) und macOS-Builds der Desktop-App (ohne gekaufte
  Signaturzertifikate; unsignierte Builds bzw. freie Alternativen prüfen).

Stand 2026-10-01 (Block 8, Strang „web“, `asm/b8-web-20261001`): Web-Version
gebaut – `apps/assembler-web`, PWA aus denselben Modulen, offline nach dem
ersten Laden, Updates mit „Reload“-Hinweis, Projekte per File System Access API
(Chromium) bzw. Upload/Download, zuletzt geöffnete Projekte und
Wiederherstellung in IndexedDB, Agent-API im Browser als In-Page-API, strenge
CSP, LGPL-Quellangebot samt OCCT-Rezept in der Site. E2E in Chromium,
Smoke-Test in Firefox und WebKit grün; erstes Laden 6,9 MB (brotli), warm 0
Bytes. Details und offene Punkte: [WEB.md](WEB.md); Hosting-Anforderungen:
`apps/assembler-web/deploy/README.md`. **Nicht** erledigt: Hosting/DNS (nichts
deployt), Test auf einem echten iPad, Linux- und macOS-Desktop-Builds (nur
Schritte dokumentiert, WEB.md §9).

## 1b. Touch und Stift auf Shapr3D-Niveau (≈ 1 Block, nach der Web-Version)

Shapr3D kommt vom iPad; unsere Touch-Unterstützung ist bisher Grundausstattung.
Stift-zuerst-Skizzieren mit automatischer Linie/Bogen-Erkennung,
Tablet-Layout (Links-/Rechtshänder), große Ziele, Bildschirm-Ziffernblock für
Maße, Handballenerkennung, Gesten für Undo/Redo. iPad realistisch über die
Web-Version (PWA); Windows-Tablets über die Desktop-App.

**Stand 2026-10-01 (Block 8, Branch `asm/b8-touch-20261001`): umgesetzt,
mit emulierter Touch-/Stift-Eingabe geprüft** – Einzelheiten in
[TOUCH.md](TOUCH.md). Zeigermodell Maus/Finger/Stift mit Druck und
Handballenerkennung, Gestenerkenner (Orbit, Pan/Pinch/Drehen, Trägheit,
Doppeltipp auf Fläche, Long-Press-Menü und -Rahmen mit Filter per zweitem
Finger, Zwei-/Drei-Finger-Tipp und Drei-Finger-Wischen für Undo/Redo),
Windows-Stift mit Shift/Strg/Alt, Strich-Erkennung im Skizzenmodus (Linie,
Linienzug, Bogen mit Tangente, Kreis, Rechteck auch gedreht, Kritzeln
löscht) über die Zeichenwerkzeuge mit deren automatischen Bedingungen,
Tablet-Layout mit großen Zielen und Fingergriffen, Links-/Rechtshänder,
Bildschirm-Ziffernblock, Einstellungen „Touch and pen“. Offen: Prüfung auf
echter Hardware (iPad über die Web-Version, Windows-Stifttablett),
Linie↔Bogen-Umschalten durch Wackeln während des Zeichnens,
Ellipsen/Splines aus Strichen.

## 2. KI-Assistent: „Beschreib das Teil, bekomm ein editierbares Modell“ (≈ 1 Block)

- Auf dem gemeinsamen Paket `@himmelcad/agent` aufbauen (t3code-Adaption
  aus Builder: Chat-Panel, Treiber für Claude-/Codex-/OpenCode-CLIs mit den
  eigenen Abos der Nutzer – keine KI-Kosten für uns, keine gekauften Lizenzen).
- Werkzeuge für den Agenten = der vorhandene Befehlsvertrag
  `hcasm.agent-api@1` (siehe [AGENT-API.md](AGENT-API.md)); Ergebnis ist
  immer eine normale, manuell editierbare History.
- Vorschau/Commit-Transaktionen sichtbar im UI, Rückfrage vor destruktiven
  Schritten, Druckbarkeitsprüfung als Selbstkontrolle des Agenten.
- Vorlage/Benchmark: die fünf Druckteile aus `apps/assembler/bench/` plus
  Aufgaben in Alltagssprache („Gehäuse für Raspberry Pi 5 mit Lüftung“).

### 2b. Übernahmen aus der ForgeCAD-Analyse (Florian 2026-10-02: Empfehlungen 1–5 freigegeben)

Siehe [research/2026-10-01-forgecad/Report.md](research/2026-10-01-forgecad/Report.md) §6.
Punkte 1 und 5 sind im Builder-Agentenplan (`docs/builder-program/specs/agent/agent.md`:
Skills, `view.screenshot`) bereits angelegt und werden mit `@himmelcad/agent`
übernommen; 2–4 sind CAD-/druckspezifisch und neu.

1. Render-Sicht für Agenten (`view.render`/Screenshot, Inspektionsbündel), auch headless.
2. Gespeicherte Prüfungen im Dokument („Checks“) als eigenes Modul, mit Panel und API.
3. Parameterbereiche (min/max/step), Slider, `parameters.sweep`.
4. Kollision und Spiel zwischen Körpern (Messung, Print-Befund, Check) – aus §4 vorgezogen.
5. Installierbare Agent-Skills (eingebaute und Projekt-Skills wie in Builder) mit Druckteil-Workflow.

Stand 2026-10-02 (Block 9, Stream „checks“): **Punkte 2 und 4 umgesetzt**, siehe
[CHECKS.md](CHECKS.md). Kollision und Spiel: exakter Mindestabstand, Berührung und
Überlappungsvolumen im Kernel-Adapter (`measureClearance`), in Measure, als
Printability-Befund (mit „Ignore here“/„Don't show this type“) und als Check-Art.
Checks: eigenes Domänenmodul `checks`, Registry in `foundation/commands`, Arten von
`measure`, `print` und `checks`, Panel mit passivem Badge, Undo/Redo, optionales
`.hcasm`-Feld `checks` (kein Format v4: additiv wie Block 8), `checks.*` und Python.
Offen: Sweep-Anbindung durch Stream „params“ (Vertrag in MODULES.md), Spiel über
Bewegungen/Posen (§4, Gelenke).

## 3. Maker-Werkzeuge für Druckteile (≈ 1 Block)

- Echte, druckbare Gewinde (metrisch, Rohr, Schraubverschlüsse) mit
  Druckspiel-Presets.
- Generatoren: Zahnräder, Knöpfe, Scharniere/Filmscharniere, Snap-Fits,
  Kabeldurchführungen.
- Teilebibliothek mit Norm- und Vorlagenteilen.
- „Remixen“: STL/3MF/STEP von Plattformen wie Printables/MakerWorld
  importieren, per Mesh→Solid umwandeln und anpassen (Lizenz der Vorlage
  anzeigen).

## 4. Leichte Baugruppen mit Gelenken (≈ 1–2 Blöcke)

- Gezielt für Druckanwendungen: Print-in-Place-Mechanismen mit Spielprüfung,
  Gelenke (Drehen, Schieben), Bewegung testen, Kollisionsprüfung, einfache
  Stückliste. Keine Großbaugruppen-/PDM-Ambitionen.
- Statische Spiel- und Kollisionsprüfung ist seit Block 9 vorhanden (§2b Punkt 4,
  [CHECKS.md](CHECKS.md)); hier bleibt sie über Gelenkposen und Bewegungen.

## Später bzw. nur bei konkretem Bedarf

- **Technische Zeichnungen** (≈ 2–3 Blöcke): siehe Entscheidung unten.
- Leichte Festigkeitsprüfung (FEM) für Druckteile.
- Versionierung/Variantenverwaltung, ggf. über die HimmelCAD-Familie
  (reservierter Name ChronoGit).
- Nicht geplant: Blech, Schweißkonstruktionen, CAM, Großbaugruppen, PLM.

## Technische Zeichnungen: gemeinsam mit Builder, später

Florian hat für Builder bereits eine Vision für Zeichnungen und will bei der
Gestaltung aktiv mitwirken; für die Assembler-Zielgruppe haben Zeichnungen
geringere Priorität, daher wird gewartet (Florian, 2026-09-30). Richtung:

- **Ein gemeinsames Zeichnungsmodul** für Builder und Assembler
  (Blätter, Ansichten-Layout, Bemaßungs- und Textstile, Schriftfeld,
  PDF/DXF-Export) unter Florians Gestaltung – entspricht ADR 0032 (gemeinsame
  Module) und vermeidet zwei auseinanderlaufende Zeichnungssysteme.
- **Assembler liefert den produktspezifischen Teil:** Ableitung der
  2D-Ansichten aus der B-rep (Verdeckte-Kanten-Berechnung mit OCCT
  `HLRBRep`), Schnitte/Details, Passungen und Form-/Lagetoleranzen (GD&T).
  Diese Ansichts-Engine kann vorab entstehen und bis dahin als DXF/PDF
  exportieren.
- Kein autonomes Nachbauen der Shapr3D-Zeichnungsfunktion, solange das
  gemeinsame Modul nicht gestaltet ist.
