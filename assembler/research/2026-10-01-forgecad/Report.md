# ForgeCAD-Analyse für HimmelCAD Assembler – 2026-10-01

Wettbewerbsrecherche analog zur [Shapr3D-Recherche](../2026-09-28/README.md),
in kleinerem Umfang. Zuerst [OWNER-INTENT.md](../../OWNER-INTENT.md) lesen. Die
Empfehlungen hier sind Vorschläge und kein Owner-Beschluss. Aufwand steht in
„Blöcken“ wie in [ROADMAP-LATER.md](../../ROADMAP-LATER.md): ein Block entspricht
etwa der Agentenarbeit eines der Assembler-Blöcke 4–6. Das sind Schätzungen,
keine Messungen.

**Evidenz-Kennzeichen:**

- **D**: offizielle Website und Dokumentation von forgecad.io
- **R**: öffentliches Repository, Issues oder npm-Registry
- **S**: Sekundärquelle
- **H**: selbst im Browser gesehen
- **C**: Assembler-Code oder -Dokumentation im Repo (Stand `c651301`, Branch
  `feat/assembler-phase0-20260929`)
- **U**: unverifiziert

Alle Webquellen wurden am 2026-10-01 abgerufen.

## 1. Kurzfazit

- ForgeCAD (forgecad.io) ist ein **Code-first-CAD im Browser** mit einem
  eingebauten KI-Agenten. Ein Modell ist eine JavaScript-Datei (`.forge.js`).
  Kernels sind Manifold (Mesh) und OCCT bzw. truck (B-rep). Das Produkt ist
  closed source, hat eine Person als Rechtsträger, steht bei Version 0.x und
  ist seit April 2026 gehostet.
- **Stärke:** Der Agent kann seine Arbeit selbst prüfen. Er bekommt
  Render-PNGs, Inspektionsbündel, ausführbare `verify.*`-Prüfungen, eine
  Druckprüfung, Parameter-Sweeps und einen Vergleich mit Referenzmodellen. Dazu
  kommen eine große Teilebibliothek (Gewinde, Normteile, Zahnräder) und
  Baugruppen mit Gelenken.
- **Schwäche für unsere Zielgruppe:**
  - Es gibt keine direkte Modellierung. Wer nicht programmiert, schreibt Code
    oder lässt den bezahlten Agenten schreiben.
  - Der Default-Kernel ist ein Mesh-Kernel; Fillet und Chamfer gelten als
    „experimental“.
  - Kostenlose Projekte sind öffentlich.
  - Für kommerzielle Arbeit braucht man Pro (99 $/Monat).
  - Agenten-Workflows sind laut Nutzungsbedingungen nur mit
    Enterprise-Vertrag erlaubt.
- **Assembler ist besser bei:**
  - Shapr3D-naher Direktbedienung
  - exakter B-rep mit stabilen Referenzen
  - tieferem Druck-Workflow (Auto-Orient, Place on Plate, Bauraum, Slicer-Start)
  - lokalem Arbeiten ohne Konto
  - freier Agent-API für Privatleute und Kleinstfirmen
- **Übernehmen** (Details in §6): Render-Sicht für Agenten, ausführbare
  Prüfungen im Dokument, Parameterbereiche mit Slider und Sweep,
  Kollisions-/Spielprüfung, Agent-Skills. Zusammen sind das etwa 3 Blöcke.
  Fast alles passt zu ROADMAP-LATER §2–4.

## 2. Was ForgeCAD ist

### 2.1 Identität und Namensgleichheit

| Name | Was | Relevanz |
| --- | --- | --- |
| **ForgeCAD, forgecad.io** (gewählt) | Code-first-CAD mit KI-Agent für Produkte, Fertigung und Robotik. Formate STL, 3MF und STEP; eigener Druckcheck `check print` | hoch: wird von Makern für Druckteile genutzt (S: HN-Kommentar, FDM-Skill eines Dritten) |
| forge-cad.com | „AI engineering engine“ Text → STEP/STL für SolidWorks und Fusion (Suchtreffer; Seite lieferte einen TLS-Fehler, nicht geprüft) | gering, U |
| forgecad.com | Show HN vom 2025-01-08 „Create detailed 3D designs from text or image prompts“; die Domain leitet heute auf einen Domain-Marktplatz um (atom.com) | vermutlich eingestellt (R: HN-API, Redirect) |
| „Forge“ (Blender-Add-on, adam-james-v/forge u. a.) | B-rep-Bibliothek bzw. Add-on, kein „ForgeCAD“ | nicht verglichen |

### 2.2 Fakten zu forgecad.io

| Aspekt | Befund | Quelle |
| --- | --- | --- |
| Hersteller | Rechtsträger ist „Narek Kostandyan, Individual Entrepreneur (d.b.a. ForgeCAD)“. Entwickler und öffentliches Gesicht ist Ruben Kostandyan (GitHub KoStard). Mitwirkende im Public Kit: KoStard, „claude“, „aider-chat-bot“ | D (Footer, License), R |
| Produkttyp | „browser-based CAD workspace with a built-in Agent“. Modelle sind `.forge.js`-Quelltext; Parameter, Baugruppen, Prüfungen, Renders und Exporte entstehen aus dem Code | D (Startseite, Docs/Welcome) |
| Plattformen | gehostete Web-App `forgecad.io/app` (Login nötig, H); npm-CLI `forgecad` (Node ≥ 20) mit lokalem Editor `forgecad studio` auf localhost. Ein Mobile-Bug (iPhone) wurde behoben | D, R (npm, Issue #13), H |
| Kernel | `--backend manifold` (Default), `occt`, `truck` oder `sdf`. Abhängigkeiten laut npm: `manifold-3d`, `opencascade.js` und ein eigenes `@forgecad/geometry-kernel`. Die Doku erwähnt zusätzlich ein Backend „SMLib“ | D (Sketch/Core/Curves), R (CLI.md, npm 0.13.0) |
| Lizenz | Proprietär („All rights reserved“). Kostenlos nur für private, nicht kommerzielle Nutzung; kommerzielle menschliche Nutzung braucht Pro; „automated backend … agents … benchmark“ braucht Enterprise. Das Public Kit (Beispiele, Skills) steht unter MIT. Bis 2026-04-04 lag der Kern-Quelltext öffentlich unter BSL 1.1 (Change License MIT) und wurde dann entfernt | D (/license, /terms), R (Commit `0360c37`, alte LICENSE) |
| Preise | Free 0 $ (kein Agent, 10 MB, nur öffentliche Projekte), Basic 19 $, Standard 39 $, Pro 99 $ (private Projekte), Mega 199 $, Team 269 $ (3 Builder- und 6 Viewer-Sitze), Enterprise auf Anfrage. Im Juni nannte Grabowski noch „$20/month Pro“, das Modell hat sich also seitdem geändert | D (/pricing), S |
| KI | Eingebauter Agent über Credits; die Demo zeigt ein Claude-Modell. Alternativ eigene Coding-Agenten (Claude Code, Codex, OpenCode) über die CLI und `forgecad skill install` | D, R |
| Reife und Aktivität | npm 0.1.0 am 2026-03-15, 0.13.0 am 2026-07-05: 37 Versionen in rund 16 Wochen, seither kein npm-Release (die gehostete App kann sich unabhängig ändern, U). Gehostet seit 2026-04-01. Public Kit: 940 Sterne, 106 Forks, letzter Commit 2026-06-15, 27 Issues (5 offen). Galerie-Projekte vom 2026-10-01 zeigen laufende Registrierungen | R, D (Blog), H (Galerie) |
| Zielgruppe | „Products, Manufacturing, and Robotics“, Physical AI, KI-Trainingsdaten. Maker und 3D-Druck sind nicht das Hauptziel, kommen aber vor (`check print`, 3MF, Druck-FEA-Preset für PLA) | D |

## 3. Vergleichsmatrix ForgeCAD vs. Assembler

Für ForgeCAD wurde nichts außer Website und Galerie-Viewer selbst getestet
(§7). Die Angaben beruhen daher überwiegend auf **D/R**.

| Dimension | ForgeCAD | Ev. | Assembler (heute) | Ev. |
| --- | --- | --- | --- | --- |
| Modellierparadigma | Code ist die Quelle. Die Ansicht dient zum Prüfen; das Modell lässt sich nicht direkt bearbeiten („You cannot edit the model directly“, S). Der Agent schreibt den Code | D, S | Shapr3D-nahe Direktbedienung mit parametrischer History. Agenten nutzen dieselben Commands | C: PLAN §1, GAP-INVENTORY §1–7 |
| Kernel | Manifold-Mesh als Default; OCCT, truck und SDF wählbar. Exaktes STEP nur über OCCT | D, R | OCCT (eigener WASM-Build), immer exakte B-rep, stabile Face/Edge-Namen | C: MODULES.md `geometry-kernel`, KERNEL-SPIKE |
| Skizzen und Constraints | `constrainedSketch()` im Code: eigener nichtlinearer Solver, Status `fully/under/over`, DOF, Residuum. Einen grafischen Skizzierer zeigt die Doku nicht | D (Sketches); grafisch: U | planeGCS in UI und API, Konflikt-/Redundanzdiagnose, DOF, Splines, Ellipsen, Text, Projektion, Muster | C: SKETCHING.md |
| Volumen-Features | Booleans, Extrude, Revolve, Loft, Sweep, Pfade, Flächen (NURBS bei OCCT), Shell, Draft (Draft nur OCCT). Fillet/Chamfer „experimental“: Manifold teils falsch, OCCT teils sehr langsam | D (Core, Curves) | 30 Modellier-Zeilen mit 68 % gewichteter Parität: Fillet/Chamfer/Shell/Draft/Rib/Thicken/Hole (ISO-Größen)/Emboss/Sweep/Loft/Muster/Spiegeln/Split | C: GAP-INVENTORY §5, `modules/modeling/printFeatures.ts` |
| Direkte Bearbeitung | keine | S | Offset/Move/Delete Face (Kanten noch nicht) | C: GAP-INVENTORY §6 |
| Interaktion (Maus, Touch, Stift) | Orbit, Messen, Schnitt, Explode, Slider für Parameter; Code-Editor (Monaco) | D, R, S | Adaptive Werkzeugleiste, Gizmos, Maus-Presets, Touch-Grundausstattung (55 % Parität) | C: GAP-INVENTORY §1, §12 |
| Parameter | `Param.number(name, default, {min, max, unit})` als Slider; auch Zeichenketten. Veröffentlichte Parameter in der Galerie | D, R (Issue #13) | Benannte Parameter mit Formeln, Rename-Kaskade, Zyklusprüfung. **Kein min/max, keine Slider** | C: `foundation/document/parameters.ts` |
| Ausführbare Prüfungen | `verify.*` im Modell (Maße, Abstand, Spiel, Kollision, Volumen, Fläche, Bounding Box, Parallelität …), CLI `check params --samples N` | D (Concepts), R (CLI.md) | Fehlt im Dokument. Tests gibt es nur im Repo; Agenten prüfen per Query (`measure.*`, `print.analyze`) | C: Schema-Methodenliste |
| Druckbarkeit | `forgecad check print`: `verify.*`-Ergebnisse, Kollisionen, Anzahl Komponenten, Mesh-Topologie, Wandstärke (Stichproben), „overhang budget“, Kontaktfläche zum Bett. Profil FDM/PLA, 0,4-mm-Düse; JSON für Agenten. Laut Issue #32 lädt der 3MF-Import für `check print` evtl. 0 Dreiecke (nicht reproduziert) | R (CLI.md, Issue #32) | Print-Modus im UI und per API: Überhang je Fläche, Wandstärke (Stichproben, Keil-Heuristik), kleine Löcher/Pins, B-rep-Gültigkeit, Wasserdichtheit, Masse/Kosten, Bauraum, Abstand zur Platte; Worker mit Fortschritt und Abbruch | C: PRINTING.md, `modules/print/` |
| Orientierung und Platte | Nicht dokumentiert. Der FDM-Skill eines Dritten warnt vor Orientierungs-Fallen bei `check print` | S | Place on Plate, Auto Orient (Top 3, Vorschau), als History-Schritt | C: PRINTING.md |
| 3MF und Slicer | Export 3MF (Farbe, Mehrteile) und STL; G-Code „scripted, not sliced“. Keine Übergabe an einen Slicer dokumentiert | R (CLI.md) | 3MF Core 1.3 + Materials mit strengem Validator; „Open in Slicer“ (Bambu, Orca, Prusa, Cura) | C: PRINTING.md, `electron/slicer*.ts` |
| Drucker-Integration | keine dokumentiert | D | Druckerprofile für den Bauraum; direktes Senden ist geplant | C: ROADMAP-LATER §0 `printers` |
| Import | STL, OBJ, 3MF (Mesh), STEP (OCCT), SVG als Skizze | R (Skills) | STEP mit Baugruppenstruktur, Farben und Namen; IGES; STL/3MF/OBJ als Referenz; DXF in eine Skizze; Mesh → Solid | C: INTEROP.md |
| Export | STL, 3MF, SVG, DXF (Skizze); als „Production“ markiert: STEP, BREP, G-Code, PDF-Bericht/Skizze, Zuschnittplan, URDF/MJCF/SDF/USD | R (CLI.md), D | STEP (AP214/242), IGES, STL, 3MF, DXF, PNG. Kein OBJ/GLB/SVG/PDF | C: INTEROP.md, GAP IMP-07 |
| Baugruppen und Gelenke | Connectors, `matchTo()`, Gelenke, gekoppelte Bewegung, Animation, `minClearance`, Kollision in mehreren Posen, Stückliste | D (Assembly, Output) | Nur Mehrkörper; Gelenke sind ROADMAP §4; keine Kollisionsprüfung zwischen Körpern | C: ROADMAP-LATER §4, Code-Suche |
| Bibliothek und Generatoren | `lib.*`: Gewinde, ISO-Schrauben/Muttern/Scheiben, Befestigungssätze, Zahnräder (Stirn-, Kegel-, Kronen-, Hohlrad, Zahnstange, Paar-Diagnose), T-Nut-Profile, Rohre, Riementrieb, Lochbilder | D (Library) | ISO-Lochgrößen (Durchgang, Kernloch, Senkung) als Maßangaben, Gewinde nur als Etikett; ROADMAP §3 | C: `printFeatures.ts` |
| Organische Formen | SDF: glatte Booleans, TPMS-Gitter, Voronoi (Mesh, nicht exakt) | D (SDF) | keine | C |
| Analyse jenseits Druck | FEA (lineare Statik, PLA-Druck-Preset mit Infill und Orientierung), Masseneigenschaften | D (Assembly) | Messen, Masse über die Dichte | C: GAP §9 |
| Automation und Agent-API | Der Code selbst ist die Schnittstelle; die CLI bietet `run`, `render`, `inspect`, `check`, `export` und `compare` | R | `hcasm.agent-api@1` (JSON-RPC, headless und in der App), Python SDK, Transaktionen, Revisionen, strukturierte Fehler mit Kandidaten, Benchmark mit 5 Teilen | C: AGENT-API.md |
| Visuelles Feedback für Agenten | `render 3d`/`section`, Inspektionsbündel (PNGs + `manifest.json`), Zebra, Normalen, Tiefe, Overlay-Vergleich | R (Skill inspect-model) | **Fehlt in der API.** Bildexport gibt es nur im UI (`display`) | C: Schema-Methodenliste |
| Eingebauter KI-Assistent | ja, gehostet und per Credits bezahlt; Eingabe Text und Bilder | D | geplant (ROADMAP §2, mit den Abos der Nutzer) | C |
| Agent-Onboarding | `forgecad skill install --target claude/codex/opencode`, Skill-Bibliothek, „AI Usage“-Leitfaden mit Abnahmekriterien | R, D | `api.describe`, AGENT-API.md; kein installierbarer Skill | C |
| Kollaboration und Cloud | Cloud-Projekte, Teams mit Rollen, Galerie und Teilen, Discord, Bounties | D | lokal; Cloud vom Owner zurückgestellt | C: OWNER-INTENT |
| Performance | Manifold schnell (U), OCCT-Fillets langsam (D); Issue #19 „Script execution timed out after 30s“ | D, R | Gemessene Budgets (Print-Analyse 32 Körper ≈ 0,56 s), Kernel-Timeout 120 s headless | C: PRINTING.md, AGENT-API.md |
| Plattformen und Offline | Browser mit Konto; CLI lokal ohne Konto für Modellieren, Inspektion und Export | R (CLI.md) | Electron-Desktop, offline, ohne Konto. Web-PWA geplant (ROADMAP §1) | C |
| Lizenz und Preis | siehe §2.2; kostenlose Projekte sind öffentlich | D | BSL 1.1 (Change License AGPL-3.0): kostenlos für Privatpersonen und Organisationen mit ≤ 3 Personen, auch kommerziell | C: `LICENSE` |
| Erweiterbarkeit | eigene JS-Module (`require`), SVG-Import; kein Plugin-System dokumentiert | R | Modul- und Registrierungsverträge intern (MODULES.md); kein öffentliches Plugin-System | C |
| Community | 940 Sterne, Discord, X, öffentlicher Benchmark, Galerie | R, D | noch nicht veröffentlicht | — |

## 4. Wo ForgeCAD überlegen ist

Sortiert nach Relevanz für Konstruieren für den 3D-Druck.

1. **Der Agent prüft sich selbst und sieht das Ergebnis** (R, D). Die Skills
   verlangen nach jedem Feature ein Render, Inspektionsbündel mit PNGs und
   `manifest.json`, `check print` vor dem Export und `compare` gegen
   Referenzen. Unsere API liefert nur Zahlen. Ein Agent erkennt dort kein
   „sieht falsch aus“, solange er nicht selbst Screenshots anfordern kann.
   Für ROADMAP §2 (KI-Assistent) ist das die größte Lücke.
2. **Ausführbare Anforderungen im Modell** (D). `verify.*` liegt beim Modell und
   läuft bei jedem Lauf mit. `check params --samples` testet viele
   Parameterwerte. Damit bleiben parametrische Druckteile über den ganzen
   Wertebereich gültig („passt der M3-Einsatz noch, wenn wall = 1,2?“). Wir
   haben Parameter, aber weder Bereiche noch Sweep noch gespeicherte Prüfungen.
3. **Parametrische Teile als Konfigurator** (D, R). Slider mit min/max und
   veröffentlichte Parameter in der Galerie folgen dem
   Thingiverse-Customizer-Muster, das Maker kennen.
4. **Teilebibliothek und Generatoren** (D): echte Gewinde (allerdings als Mesh,
   §5), ISO-Schrauben, Zahnräder mit Paar-Diagnose, T-Nut, Lochbilder. Das
   deckt genau ROADMAP §3 ab, das wir noch nicht haben.
5. **Baugruppen mit Gelenken und Spielprüfung** (D): Kollision und
   Mindestabstand über mehrere Posen, Animation. Wichtig für
   Print-in-Place (ROADMAP §4).
6. **Null-Installation und Teilen** (D): Browser, Galerie, Projekt-Links,
   Community. Bei uns kommt das frühestens mit ROADMAP §1.
7. **Breite** (D): SDF/TPMS-Gitter (für Druck interessant, aber nur als Mesh),
   Freiformflächen, FEA mit PLA-Druck-Preset, Stückliste und PDF-Bericht,
   Blech, Robotik-Exporte. Für die Zielgruppe zählen davon am ehesten
   TPMS-Gitter und eine einfache FEA.
8. **Code als Quelle** (D): leicht zu versionieren und zu vergleichen, Varianten
   lassen sich parallel erkunden, Module sind wiederverwendbar. Unser `.hcasm`
   ist JSON-History und lässt sich ebenfalls vergleichen, ist aber nicht zum
   Handschreiben gedacht.

## 5. Wo Assembler besser ist

1. **Bedienbar ohne Programmieren** (C). Assembler bietet Direktbedienung nach
   Shapr3D-Vorbild: Auswahl schlägt Werkzeuge vor, Gizmo und Maßeingabe,
   History. ForgeCAD verlangt Code oder bezahlte Agent-Credits; für die
   meisten Maker und Prosumer ist das die größere Hürde.
2. **Exakte Geometrie als Standard** (C, D). Bei uns läuft jedes Feature auf
   OCCT-B-rep mit stabilen Namen. ForgeCAD modelliert standardmäßig mit
   Mesh. Fillet und Chamfer sind dort „experimental“. STEP gibt es nur über
   den OCCT-Pfad und gilt als „Production“-Export.
3. **Druck-Workflow vom Modell bis zum Slicer** (C):
   - Analyse-Overlays im UI mit klickbaren Befunden
   - Place on Plate und Auto Orient
   - Bauraum-Presets sowie Masse und Kosten
   - strenger 3MF-Writer
   - „Open in Slicer“

   ForgeCAD hat eine gute CLI-Prüfung, aber dokumentiert weder Orientierung
   noch eine Übergabe an den Slicer.
4. **Lokal, privat, ohne Konto** (C, D). Bei ForgeCAD sind kostenlose Projekte
   öffentlich; private Projekte gibt es erst ab 99 $/Monat.
5. **Lizenz passt zur Zielgruppe** (C, D). Kleinunternehmen mit bis zu 3
   Personen nutzen Assembler kostenlos, auch kommerziell, und die Agent-API
   ist frei. Bei ForgeCAD braucht schon die kommerzielle Einzelarbeit Pro.
   „agent workflows“ sind nach dem Wortlaut der Nutzungsbedingungen nur mit
   Enterprise erlaubt. Das steht im Widerspruch zur eigenen
   Claude-Code-Anleitung; wie die Grenze gemeint ist, bleibt unklar.
6. **Robuste Agent-Schnittstelle** (C):
   - Transaktionen mit Vorschau, Commit und Abbruch
   - Revisionen mit optimistischer Sperre
   - strukturierte Fehler mit Kandidatenlisten
   - Referenzen, die über spätere Features hinweg stabil bleiben
   - Ergebnis ist eine normale, im UI editierbare History

   ForgeCAD-Agenten editieren dagegen Text und müssen jeden Lauf neu
   auswerten.
7. **Interop für Bestandsdaten** (C): STEP-Import mit Baugruppenstruktur,
   Namen und Farben; IGES; DXF in eine Skizze; Mesh → Solid.

## 6. Übernahme-Empfehlungen

Sortiert nach Nutzen pro Aufwand. Die Module richten sich nach
[MODULES.md](../../MODULES.md).

| # | Empfehlung | Nutzen | Aufwand | Modul(e) | ROADMAP-LATER |
| --- | --- | --- | --- | --- | --- |
| 1 | **Render-Sicht für Agenten:** Query `view.render` mit benannter Kamera oder Az/El, Isolate/Highlight, Schnittebene, Overlay-Modus (z. B. Print-Befunde), PNG als base64. Dazu `inspect.bundle` = mehrere Ansichten + JSON-Manifest | Agenten erkennen Fehler visuell; Voraussetzung für einen guten KI-Assistenten | ¼ Block in der App (Bildexport existiert); headless + ½–¾ (Node hat kein WebGL: versteckter Electron-Renderer oder Software-Rasterizer prüfen) | `agent-api`, `viewport`, `display`, Produkt `headless` | passt zu §2, dort neuer Unterpunkt |
| 2 | **Prüfungen im Dokument („Checks“):** gespeicherte Anforderungen, z. B. Maß/Abstand im Bereich, passt in Bauraum, druckbar ohne Fehler, Mindestwand, Mindestspiel zwischen Körpern, Volumen/Masse im Bereich. Laufen nach jedem Rebuild, Panel mit Bestanden/Fehlgeschlagen, `checks.list/run` in der API, Python-Helfer | Schließt den Prüfkreislauf für Mensch und Agent; Regressionsschutz bei Parameteränderungen | ~1 Block | neues Domänenmodul `checks`. Registry in `foundation/commands`; `print`, `measure` und `parameters` registrieren ihre Prüfarten selbst (keine Domäne-zu-Domäne-Imports). Format v4 | neu; entspricht §2 „Druckbarkeitsprüfung als Selbstkontrolle“ |
| 3 | **Parameterbereiche, Slider, Sweep:** `min/max/step` am Parameter, Slider im Parameters-Panel, Query `parameters.sweep` (min/nominal/max oder N Stichproben → Rebuild-Fehler + Check-Ergebnisse) | Robuste parametrische Druckteile; Basis für Vorlagen im Customizer-Stil | ½ Block | `parameters`, `document` (Format), `agent-api` | neu; ergänzt §3 (Vorlagen/Generatoren) |
| 4 | **Kollision und Spiel zwischen Körpern:** Mindestabstand (`BRepExtrema`) und Überlappungsvolumen (Common) als Messung, Print-Befund und Check | Print-in-Place, Deckel/Gehäuse-Passung; Voraussetzung für Gelenke | ½ Block | `measure`, `print` (Befund), Kernel-Adapter | **aus §4 vorziehen** |
| 5 | **Agent-Skills und Leitfaden:** installierbarer `SKILL.md` (Claude/Codex/OpenCode) mit Druckteil-Workflow, Abnahmekriterien („nie ohne Render/Check abgeben“), Python-Beispielen und typischen Fehlern; eine Kontextdatei für Chat-Tools ohne Shell | Agenten liefern ab dem ersten Versuch bessere Teile; wenig Aufwand | ¼ Block | `agent-api` (Doku), `sdk/python` | §2 |
| 6 | **Generatoren:** Gewinde als B-rep (braucht helikales Revolve, MOD-05), ISO-Schrauben/Muttern als Referenzteile, Zahnräder mit Paar-Diagnose, Lochbilder für mehrere Körper, T-Nut | Typische Maker-Teile ohne Fremd-CAD | ~1 Block | `modeling` (Features), `templates` (Bibliothek) | §3 (unverändert; ForgeCAD bestätigt die Priorität) |
| 7 | **Vergleich mit Referenzmesh:** Abweichungs-Heatmap und Score (Fläche, Kanten, Volumen-IoU) zwischen Körper und importiertem STL/3MF | Remixen und Nachbauen von Plattform-Teilen; objektiver Score für unseren Agent-Benchmark | ½ Block | `interop` bzw. `measure`, `agent-api` | §3 „Remixen“, §2 Benchmark |
| 8 | **Kleine Print-Ergänzungen:** Kontaktfläche zum Bett als Befund, schwebende bzw. getrennte Teile, unbeabsichtigt verschmolzene Körper | Fängt typische Agent-Fehler früh ab | ¼ Block | `print` | neu (klein) |
| 9 | **Später prüfen:** TPMS-/Gitter-Füllungen für Leichtbau-Druckteile; einfache FEA mit Druckorientierung | Prosumer-Mehrwert | je ≥ 1 Block, Forschung | neues Modul bzw. „Später“ | „Später“-Liste (FEA steht schon dort) |

Kern (1–5) zusammen: etwa 2½–3 Blöcke. Mit 6–8 sind es etwa 4½–5 Blöcke.

### Ausdrücklich nicht übernehmen

- **Code als einzige Quelle bzw. Code-first-UI.** Das widerspricht U2
  (Shapr3D-Nähe) und der Zielgruppe ohne Programmierkenntnisse. Die
  Automationsschicht bleibt die Command-API mit Python. Ein optionales
  „Script-Feature“ in der History wäre höchstens später zu prüfen.
- **Mesh-Kernel als Modellier-Standard (Manifold).** Damit gingen exakte
  B-rep, STEP-Treue und stabile Referenzen verloren; ForgeCAD dokumentiert
  selbst falsche Fillet-Ergebnisse. Manifold (Apache-2.0) wäre allenfalls für
  schnelle Mesh-Booleans beim Remixen eine Option, als eigener Abhängigkeits-
  check.
- **Cloud-Zwang, Konten und „kostenlos = öffentlich“.** Der Owner hat Cloud
  zurückgestellt; Privatsphäre ist für Maker und Kleinunternehmen ein
  Vorteil.
- **KI als Credit-Abo beim Anbieter.** ROADMAP §2 setzt bewusst auf die
  eigenen Abos der Nutzer (U4, keine KI-Kosten für uns).
- **Einschränkende Agent-Klauseln in der Lizenz.** Sie widersprechen U5.
- **Robotik- und Simulations-Exporte (URDF, MJCF, USD), Blech, CAM-G-Code.**
  Sie liegen außerhalb der Zielgruppe; Blech und CAM sind in ROADMAP-LATER
  ausdrücklich nicht geplant.
- **Code, Doku oder API-Namen von ForgeCAD.** Das Produkt ist proprietär. Der
  frühere BSL-Quelltext liegt noch in Forks (z. B. `razor-ai/forgecad`), wird
  aber nicht gelesen und nicht verwendet. Wir übernehmen nur Ideen und
  setzen sie unabhängig um.

## 7. Evidenz und Grenzen

**Selbst geprüft (H), 2026-10-01, headless Chromium (Playwright,
Windows-Host):**

- Startseite, Preise, Lizenz, Nutzungsbedingungen, 13 Doku-Seiten, Blog,
  Benchmark, Galerie und Library gerendert und als Text gesichert.
- Die Web-App `/app` zeigt ohne Konto nur einen Login. Dabei wurde **kein
  Konto angelegt**.
- Ein öffentliches Galerie-Projekt rendert ohne Login als 3D-Ansicht
  (Screenshot geprüft: Platte mit Bohrung, Lizenzangabe
  „CERN-OHL-P-2.0-PROPOSED“). Veröffentlichte Parameter waren dort „not
  available yet“.

**Bewusst nicht getestet: die npm-CLI.** Laut Nutzungsbedingungen bedeutet
schon die Installation die Zustimmung zu den Bedingungen. Agenten-Workflows
sind ohne Enterprise-Vertrag untersagt, und ein Agent, der die CLI bedient,
fiele vermutlich darunter. Deshalb ungeprüft:

- Editor-UX und der eingebaute Agent
- tatsächliche Ergebnisse und Genauigkeit von `check print`
- Exportqualität (3MF/STEP), Performance, Offline-Verhalten

**Nur aus Dokumentation und Repo (D/R):**

- Kernel-Liste, `verify.*`, Inspektionsbefehle, Exportformate und
  Lizenzstaffel
- Bibliothek, Baugruppen und FEA
- Die npm-Abhängigkeiten belegen Manifold und opencascade.js, nicht
  „truck“/„SMLib“ (U)

**Sekundär (S), nicht verifiziert:**

- Ralph Grabowski (2026-06-08): keine direkte Modellbearbeitung,
  Inspector-Panel, Exportliste
- HN-Kommentar (2026-09-15): Druckteile mit Claude über ForgeCAD
- FDM-Skill eines Dritten (0 Sterne): Hinweise zu Orientierungs-Fallen bei
  `check print`

**Assembler-Seite:** belegt aus Repo-Dokumentation und Code (Stand
`c651301`). Geprüft wurden:

- die Methodenliste der Schema-Datei
- der `Parameter`-Typ (kein min/max)
- die Dateien des Print-Moduls und der Slicer-Übergabe
- die Code-Suche nach Kollisionsprüfung (nicht vorhanden)
- die `LICENSE`-Parameter

Die App wurde für diesen Bericht nicht gestartet. Die Statusangaben stammen
aus GAP-INVENTORY (dort im laufenden App-Zustand geprüft).

**Lokale Rohdaten (nicht in Git):**
`D:\AgentWork\HimmelCAD-Assembler\research-forgecad\`

- `pages/`: Seitentexte und Screenshots
- `shots/`: Galerie/App
- `raw/`: öffentliche Skill-Dateien (MIT) und npm-Metadaten
- Skripte `scrape.js`, `app.js`, `gallery.js`

Dort liegen nur Arbeitskopien zur Nachprüfung; ins Repo wird nichts davon
übernommen.

## 8. Quellen (abgerufen am 2026-10-01)

Primär (ForgeCAD):

- Startseite: https://forgecad.io/
- Preise: https://forgecad.io/pricing
- Softwarelizenz (gültig ab 2026-06-22): https://forgecad.io/license
- Nutzungsbedingungen: https://forgecad.io/terms
- Doku-Index: https://forgecad.io/docs
- Docs Welcome: https://forgecad.io/docs/welcome
- AI-Native CAD: https://forgecad.io/docs/ai-native-cad
- AI Usage: https://forgecad.io/docs/ai-usage
- API-Referenz (Core, Sketches, Curves, Assembly, Output, Library, Sheet
  Metal, Viewport, SDF, Concepts): https://forgecad.io/docs/core,
  https://forgecad.io/docs/sketch, https://forgecad.io/docs/curves,
  https://forgecad.io/docs/assembly, https://forgecad.io/docs/output,
  https://forgecad.io/docs/lib, https://forgecad.io/docs/sheet-metal,
  https://forgecad.io/docs/viewport, https://forgecad.io/docs/sdf,
  https://forgecad.io/docs/concepts
- Blog „Hello, forgecad.io“ (2026-04-01):
  https://forgecad.io/blog/hello-forgecad-io
- Benchmark (Stand 2026-05-26): https://forgecad.io/benchmark
- Galerie: https://forgecad.io/gallery
- Beispielprojekt:
  https://forgecad.io/gallery/c8fbbcb5-049e-47d8-a6fd-77dbcb24b46a
- Library: https://forgecad.io/library
- Public Kit (MIT): https://github.com/KoStard/forgecad-public-kit
- Public-Kit-Commits: https://github.com/KoStard/forgecad-public-kit/commits/mainline
- Public-Kit-Issues: https://github.com/KoStard/forgecad-public-kit/issues
  (#13, #17, #19, #25, #32)
- Frühere Lizenz (BSL 1.1) im Commit `c2d74d5`:
  https://github.com/KoStard/forgecad-public-kit/blob/c2d74d5/LICENSE
- Skills:
  https://github.com/KoStard/forgecad-public-kit/blob/mainline/skills/README.md
- CLI-Doku:
  https://raw.githubusercontent.com/KoStard/forgecad-public-kit/mainline/skills/forgecad/docs/CLI.md
- Skill inspect-model:
  https://raw.githubusercontent.com/KoStard/forgecad-public-kit/mainline/skills/forgecad-inspect-model/SKILL.md
- Skill build-model:
  https://raw.githubusercontent.com/KoStard/forgecad-public-kit/mainline/skills/forgecad-build-model/SKILL.md
- npm-Registry (Versionen, Abhängigkeiten 0.13.0):
  https://registry.npmjs.org/forgecad

Sekundär:

- Ralph Grabowski, „Experimental CAD Is Exploding All Over“ (2026-06-08):
  https://upfrontezine.substack.com/p/experimental-cad-is-exploding-all
- HN-Kommentar von atonse (2026-09-15):
  https://news.ycombinator.com/item?id=49714750 (über
  https://hn.algolia.com/api/v1/items/49714750)
- HN-Suche (Treffer zu forgecad.com 2025 und Codex/KO II 2026):
  https://hn.algolia.com/api/v1/search?query=forgecad
- Drittanbieter-Skill: https://github.com/TheJackFace/forgecad-fdm-skill
- Community-Fork mit altem BSL-Quelltext, nicht gelesen:
  https://github.com/razor-ai/forgecad
- Namensgleiche Produkte: https://forge-cad.com/ (TLS-Fehler, nicht geladen);
  https://www.forgecad.com/ (Redirect auf
  https://www.atom.com/name/ForgeCAD)
