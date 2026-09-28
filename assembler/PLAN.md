# HimmelCAD Assembler – aktueller Umsetzungsvorschlag

Stand: 28. September 2026. **Planungsdokument, keine Implementierungszusage
oder Behauptung fertiger Funktionen.**

**Zuerst [OWNER-INTENT.md](OWNER-INTENT.md) lesen:** Dort stehen Florians
Originalintention, Bedingungen und Vorschläge mit Originalaussagen und Status.
Die Ziele haben Vorrang vor diesem Umsetzungsvorschlag. Agents dürfen den Weg
verbessern, aber nicht stillschweigend das Ziel an die einfachere Lösung anpassen.

Der Maßstab bleibt: HimmelCAD Assembler als CAD für 3D-Druck, möglichst nah an
Shapr3D in Funktionen, Oberfläche und Bedienung; bestmögliche Agent-Nutzbarkeit
unter Berücksichtigung vorhandener Blender-Erfahrung; dieselbe Produktlizenz wie
HimmelCAD/Fernwork; keine gekauften Komponentenlizenzen; sinnvolle Open-Source-
Wiederverwendung; keine Verschlechterung von Builder. Aufwand wird primär in
Tokens und Claude-Wochenlimit-Verbrauch beurteilt. Eine Alpha erfüllt noch nicht
das Gesamtziel. Die Zuordnung U1–U11 im Intent-Dokument macht dies nachprüfbar.

Dieser Plan aktualisiert die Renderer-Empfehlung des
[Gesamtberichts](research/2026-09-28/Report.md): **Der derzeit empfohlene Start
ist ein eigener Fork des HimmelCAD-Renderers.** Das ist ein Umsetzungsvorschlag,
keine unveränderliche Vorgabe des Auftraggebers.

## 1. Produktziel

Eine lokale Desktop-CAD-App für funktionale 3D-Druckteile. Shapr3D ist die
Referenz für den Arbeitsfluss: Geometrie direkt auswählen, passende Werkzeuge
angeboten bekommen, per Gizmo formen, genaue Maße eingeben und Änderungen später
in der Historie bearbeiten. Eine ähnliche Werkzeugliste allein erfüllt das Ziel
nicht; Vorschau, Auswahl, Abbruch, Undo, Historie und Datei müssen zusammenpassen.

Die App soll sowohl manuell als auch durch Agents gut nutzbar sein. Menschen und
Agents arbeiten am selben Modell mit denselben Commands, Referenzen und
Transaktionen. Agent-Ergebnisse müssen anschließend manuell editierbar bleiben.

Eigener Produktname und eigene Assets. Die Shapr3D-Bilder dienen dem Studium
von Verhalten und Oberfläche, nicht als mitzuliefernde Icons oder Texturen.

## 2. Erste Version: enthalten und zurückgestellt

### Enthalten

- Lokale Projekte mit Save/Open, Autosave, Backups, Wiederherstellung und
  Schema-/Dateiversionierung.
- 2D-Konstruktionsskizzen: Ebenen, Linien, Bögen, Kreise, Rechtecke, Splines,
  geschlossene Profile, Maße, Constraints und numerische Ausdrücke/Variablen.
- Kernmodellierung: Extrude, Revolve, grundlegende Sweep-/Loft-Abläufe,
  Union/Subtract/Intersect, Split, Fillet/Chamfer und Shell.
- Mehrkörperverwaltung: Move/Rotate, Copy, Mirror, Pattern, Translate und Align.
- Parametrische Historie, Änderung früher Schritte, Undo/Redo,
  Referenzdiagnose und kontrollierte Neuberechnung.
- Shapr3D-nahe Desktop-Bedienung: adaptive Werkzeuge, Command Search,
  Kontextmenüs, Maus/Trackpad, Zahlenfelder, präzise Kanten-/Flächenauswahl,
  grundlegende Touch-/Pen-Unterstützung.
- Messen im Modell, Schnittansicht, Isolate, Kamera/Würfel, Snaps, Körperfarben
  und gute CAD-Darstellung.
- STEP als wichtiger Austauschpfad, STL-Referenzmeshes und STL-/3MF-Druckexport;
  Einheiten, Tessellierungsqualität und Mehrkörperzuordnung explizit behandeln.
- Strukturierte Agent-API und Python-Zugang; Ergebnisprüfung und Export ohne
  notwendige GUI-Klicksimulation.

Diese Liste beschreibt das Ziel einer guten ersten Version. Die Alpha darf einen
kleineren, ausdrücklich gekennzeichneten Teilumfang haben. Beispielsweise ist ein
Loft ohne alle Guide-/Stetigkeitsvarianten keine vollständige Loft-Parität.

### Zunächst zurückgestellt

**Status:** Florian hat Cloud, Zeichnungen und XR mit „evtl“ zum vorläufigen
Weglassen vorgeschlagen. Der Plan und die Budgetspanne nehmen diese vorläufige
Reduktion an; sie ist weder endgültiger Ausschluss noch dauerhafter Verzicht.
Die übrigen Kürzungen dieser Tabelle sind Vorschläge des Assistants. Sie dürfen
nicht als zusätzliche Originalbedingungen gelesen werden.

| Bereich                | Bedeutung und Abgrenzung                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud                  | Geräte-Sync, Teams, Rollen, Reviewlinks und Kommentare. Lokales Speichern und Backups bleiben.                                           |
| Technische Zeichnungen | Aus dem Modell abgeleitete Blätter mit Ansichten, Bemaßung, Toleranzen und Schriftfeld. **Konstruktionsskizzen und Modellmaße bleiben.** |
| AR/XR                  | Raumplatzierung und Vision-Pro-/räumliche Review-Workflows. Normale 3D-Ansicht bleibt.                                                   |
| Integrierter Slicer    | Erst Dateien bzw. Handoff an vorhandene Slicer; keine eigene Toolpath-Engine.                                                            |
| Dynamische Baugruppen  | Mate-/Joint-Solver und Bewegungssimulation sind zusätzliche Anforderungen. Statisches Align und Mehrkörpermodelle bleiben.               |
| Spezialumfang          | Vollständige Enterprise-Importer, SHAPR-Kompatibilität, Cloud-KI-Rendering und native iPad-/Vision-Pro-Apps.                             |

Hohe spätere Desktop-Nähe umfasst mehr Werkzeugvarianten, direkte
Flächenbearbeitung, Wrap/Emboss, fortgeschrittene Fillets, detaillierte
Touch-/Pen-Interaktion und Visualization. Für diese Erweiterungen sind
Kernelgrenzen gesondert zu prüfen.

## 3. Architektur

```text
Electron / TypeScript UI ───────── Python / Agent-Tools
                 │ gleiche Commands und Queries
                 ▼
         Assembler-Anwendung in Rust
  Projekt · Featuregraph · Referenzen · Transaktionen
                 │
        ┌────────┴──────────────────────────┐
        ▼                                   ▼
 CAD-Adapter                         Assembler-Renderadapter
 OCCT / ggf. planeGCS                 eigener Renderer-Fork
 ausgewählte FreeCAD-Logik            aus HimmelCAD

 Builder → bestehender Renderer, unabhängig vom Assembler-Fork
```

Electron ist der Startpunkt, weil vorhandene Desktop-Erfahrung und Bausteine
genutzt werden können. Tauri ist eine mögliche spätere Entscheidung, kein
paralleles Migrationsziel. Noch keine neuen Runtime-Abhängigkeiten hinzufügen.

### CAD-Unterbau

OCCT stellt präzise B-rep-Geometrie und Modellieroperationen bereit. FreeCAD ist
Quelle für wiederverwendbare Komponenten, Featurelogik, Solveranbindung und
Tests. Die detaillierte [FreeCAD-/OCCT-Matrix](research/2026-09-28/notes/freecad-mapping.md)
trennt vorhandene Bausteine, nötige Adaption, neue Mechanismen und Kernelrisiken.

Zwei Varianten im Durchstich gegeneinander prüfen:

1. **FreeCAD-Unterbau behalten:** FreeCAD-Dokument und Recompute sind die
   Autorität hinter eigener UI/Rust-Dienstschicht. Das maximiert Wiederverwendung,
   übernimmt aber dessen Semantik und Laufzeitabhängigkeiten.
2. **Selektiver Rust-Port:** Assembler führt einen eigenen Featuregraphen;
   benötigte FreeCAD-Rechenfolgen werden adaptiert/portiert, OCCT und gegebenenfalls
   `planeGCS` bleiben zunächst C++. Das entspricht der bevorzugten langfristigen
   Produktrichtung und ist Grundlage der Budgetspanne.

Pro Variante genau **eine** autoritative CAD-Historie. Kein unabhängig editierbares
FreeCAD-Dokument neben einem zweiten Assembler-Verlauf. Das komplette
HimmelCAD-Dokument-/Civil-Backend muss nicht übernommen werden; vorhandene
Desktop-, UI- und Agent-Bausteine werden einzeln auf Nutzen geprüft.

Ein vollständiger OCCT-Port nach Rust wäre ein eigenes Kernelprojekt und ist
im aktuellen Budgetvorschlag nicht enthalten. Das ist eine Aufwandsempfehlung,
kein Verbot von Florian. Die hier vorgeschlagene Übertragung der Compositor-
Analogie lautet: Anwendung modernisieren, bewährte native Rechenkerne behalten.

### Kritische Unterschiede zu Shapr3D

- Gleicher Funktionsname bedeutet keine identische Geometrie. Shapr3D nutzt
  Parasolid; OCCT kann bei Fillets, Shells oder tangentialen Booleans anders reagieren.
- Offset/Move/Replace Face erfordern lokale Flächenänderungen und Nachbarflächen-
  Reparatur. Allgemeine Offset- oder Replace-APIs sind noch kein fertiges Werkzeug.
- FreeCAD Body/Tip und `Allow Compound` sind nicht automatisch Shapr3Ds freie
  Mehrkörper-Items samt Historienkarten.
- Frühe Änderungen können Flächen teilen oder verschmelzen. Referenzen brauchen
  Herkunft und Rebinding; flüchtige Indizes wie `Face7` reichen nicht.
- Renderdreiecke sind Darstellung. Maße, Modelloperationen und Export basieren
  auf der präzisen CAD-Geometrie.

## 4. Renderer-Fork und Schutz von Builder

Verbindliches Ziel ist der Schutz von Builder (U7). Der Fork ist die aktuell
empfohlene Methode nach Florians Vorschlag. Eine nachweislich bessere gemeinsame
oder getrennte Lösung darf diesen Plan ersetzen, wenn sie U2, U6 und U7 erfüllt.

### Vorgehen

1. Einen geprüften HimmelCAD-Commit als Fork-Basis fixieren und in einer
   Herkunftsdatei festhalten. Recherchebasis war
   `b825a1ca4b57116d14828ca760325c51b84d0130`; vor dem Fork einen aktuellen
   geeigneten Stand prüfen, statt diesen automatisch als neueste Version anzusehen.
2. Eigene Assembler-Paket-/Crate-Namen und einen getrennten Abhängigkeitsgraphen
   verwenden. Builder darf nicht auf den Fork umgebogen werden.
3. Benötigte Foundation-/Modell-/Ressourcentypen zunächst gezielt übernehmen oder
   fest versionieren. Veränderliche Workspace-Abhängigkeiten würden die Trennung
   sonst wieder aufheben.
4. CAD-Auswahl, Skizzen-Overlays, Gizmos, Kantenanzeige, Schnitt und Vorschau im
   Fork bzw. Assembler-Adapter entwickeln. Builder-Regeln nicht global ändern.
5. Gemeinsame Bugfixes später gezielt übertragen und jeweils im Zielprodukt
   prüfen. Kein automatischer Gleichlauf der beiden Renderer.

Der aktuelle Renderer hat Abhängigkeiten auf `himmelcad-model`,
`himmelcad-hardware-profile` und `himmelcad-prepared`; höhere Viewer-Schichten
enthalten auch Civil-/Punktwolken-/TIN-Funktionen. Ein Fork ist daher eine
abgegrenzte Auswahl samt Abhängigkeitsprüfung, nicht bloß das Kopieren eines
vollständig unabhängigen Crates.

### Regeln

- CAD-Toleranzen in Millimetern, Face-/Edge-Picking und Selection-Styles bleiben
  Assembler-spezifisch. Georeferenzierung und Builder-Punktwolkenregeln bleiben
  dort unverändert.
- Ressourcen tragen Dokumentrevision, Entity-/Face-/Edge-Zuordnung und
  Geometrieversion. Veraltete Vorschauen dürfen keine neueren Ergebnisse überschreiben.
- Lange Modelloperationen sind abbrechbar; stale Antworten werden verworfen.
  GPU-/Kernel-Fehler dürfen keinen teilweise committed Zustand hinterlassen.
- Renderer-Änderungen brauchen passende Assembler-Fälle. Beim Rückport zusätzlich
  Builder-Fälle für georeferenzierte Daten, Streaming, Picking und Backend-Fallback.
- Erst aus tatsächlich bewährten gemeinsamen Teilen später einen gemeinsamen
  Kern bilden. Eine vorgezogene vollständige Entkopplung ist kein Startblocker.

Der Fork reduziert die unmittelbare Kopplung. Er erzeugt später doppelte
Wartungsarbeit; seine Token-Ersparnis ist bisher nicht gemessen.

## 5. Agent-API

Vorhandene HimmelCAD-Agent-Treiber, Python- und Automationskonzepte auf
Wiederverwendung prüfen. Eine große neue Skriptsprache oder vorgetäuschte
`bpy`-Kompatibilität vermeiden.

Geplanter gemeinsamer Befehlsvertrag:

- Szene, Features, Maße und Geometrie strukturiert abfragen.
- Skizzen/Constraints erstellen und Parameter ändern.
- Körperoperationen mit typisierten Referenzen ausführen.
- Zusammenhängende Änderungen als Preview/Commit/Cancel-Transaktion behandeln.
- Validität, Abmessungen, Volumen, Export und Revision zurückmelden.
- Reproduzierbare Python-Beispiele und kompakte Fehlerdiagnose anbieten.

Blender-Vorerfahrung kann bei Transform, Extrude, Boolean und prozeduralem
Modellieren helfen. Ihr tatsächlicher Trainingsanteil ist unbekannt. Ein
Mesh-Bevel ist kein B-rep-Fillet. Echte Blender-Skripte können später optional
extern laufen und Meshes importieren; daraus entsteht keine erfundene CAD-Historie.

Vor API-Festlegung dieselben Druckteil-Aufgaben mit FreeCAD-Python, build123d
und dem Assembler-Vertrag vergleichen: Tokens pro gültigem exportierbarem Teil,
Reparaturrunden, Maße und spätere manuelle Editierbarkeit.

## 6. Umsetzung in überprüfbaren Schritten

| Phase                     | Ergebnis                                                                                    | Abschlusskriterium                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0 – Basis fixieren        | Scope, kostenlose Komponenten, Fork-Basis, Dokumentautorität, Herkunft und Lizenzgrenzen    | Reproduzierbarer kleiner Build; keine unbeabsichtigte Builder-Abhängigkeit               |
| 1 – Vertikaler Durchstich | Skizze → Extrude → Fillet → frühes Maß ändern → Save/Reopen → 3MF, per UI und Agent         | Geometrie gültig, Referenzen korrekt, Undo/Cancel konsistent, Export im Slicer maßhaltig |
| 2 – Alpha                 | Kernskizzen, Constraints, Körperoperationen, Auswahl/Gizmos, Items/History, lokale Projekte | Mehrere vollständige Druckteil-Abläufe; Grenzen sichtbar dokumentiert                    |
| 3 – Gute erste Version    | Kernumfang härten, Referenzreparatur, Imports, Agent-Übergaben, Installer/Recovery          | Wiederholbare End-to-End-Fälle und reale Druckteil-Abnahme                               |
| 4 – Hohe Desktop-Nähe     | Werkzeugvarianten, direkte Faces, Wrap/Emboss, Input-Feinschliff, Visualization             | Funktionsweise, Wechselwirkungen und Fehlerpfade gegen Referenzen geprüft                |

Schon Phase 1 muss eine frühere Skizzenänderung testen. Eine isolierte Extrusion
mit hübschem Viewport beweist weder einen stabilen Featuregraphen noch eine gute
Aufwandsprognose. Risikoreiche direkte Flächenoperationen früh als begrenzte
Prototypen prüfen, auch wenn deren vollständige UI später kommt.

## 7. Abnahme und verbleibende Recherche

Pflichtfälle: Gehäuse mit Deckel, Halter mit Langloch, Rohradapter, importiertes
STEP anpassen, statische Mehrkörpermontage, Mehrfarb-3MF, UI-/Agent-Wechsel,
Save/Reopen/Crash-Recovery. Dazu überbestimmte Skizzen, ungültige Fillets/Shells,
verdeckte Auswahl und Änderungen vor referenzierten Features.

Nicht nur Bilder vergleichen: Einheiten, Abmessungen, Volumen, B-rep-Gültigkeit,
Körperzahl, Referenzbindung und exportierte Druckdaten prüfen. Unterschiedliche
Face-Zahlen verschiedener Kernel sind nicht automatisch ein Fehler.

Die Recherche umfasst 134 offizielle Tutorial-Einträge und 29 gesicherte
Originalmedien. Acht Bilder/GIF-Stichproben und Stellen aus zwei Videos wurden
visuell geprüft. Es wurde keine aktuelle Shapr3D-Installation vollständig
durchgetestet. Offene Punkte sind insbesondere genaue Escape-/Commit-Priorität,
jede ungültige Vorschau, Touch-Zielgrößen, Persistenz einzelner Ansichtsmodi und
Kernel-Grenzfälle. Der [Coverage-Audit](research/2026-09-28/notes/coverage-audit.md)
trennt dokumentierte Befunde, Widersprüche und Lücken.

## 8. Budget und Kalibrierung

Eigene ungemessene Planungsbandbreiten, **kumulativ ab Start**, einschließlich
Coding, Reviews, Integration und Korrekturen. Keine Zeilensummen bilden.

| Ziel                                           | Generierte Output-Tokens aller beteiligten Agents |
| ---------------------------------------------- | ------------------------------------------------: |
| Technischer Durchstich                         |                                      0,2–0,6 Mio. |
| Brauchbare Alpha                               |                                        1–2,5 Mio. |
| Gute erste Druck-CAD-Version                   |                                          3–7 Mio. |
| Sehr hohe Desktop-Nähe im verbleibenden Umfang |                                         8–20 Mio. |

Voraussetzung: OCCT/Solver-Wiederverwendung und gezielter Rust-Port, kein eigener
vollständiger Geometriekernel. Cloud, Zeichnungsblätter und XR sind für diese
Schätzung vorläufig herausgenommen. Die Fork-Empfehlung rechtfertigt noch keinen
numerischen Abschlag. Diese Zahlen sind weder ein vereinbartes Ausgabenlimit
noch eine Zusage vollständiger Shapr3D-Parität.

Claude-Wochenlimits lassen sich daraus nicht direkt ablesen. Modell, Kontext,
Cache und Modellmix beeinflussen den Verbrauch. Vor/nach dem Durchstich
deduplizierte Output-/Input-/Cache-Zähler sowie Wochen- und Modellbalken messen;
Resets und fremde parallele Nutzung berücksichtigen. Dann Budget pro akzeptiertem
Workflow kalibrieren. Codex-Verbrauch ist kein Claude-Verbrauch.

Die frühere Compositor-Recherche belegt Commit-Spannen, keine vollständigen
Tokens: 4:55:34 bis erster Handoff, danach erste Verbesserungsrunde 2:31:44,
erster Handoff bis untersuchtem späterem Snapshot 71:36:12. Daraus keine
gemessene Wochenlimit-Prognose ableiten. Details und die frühere Vergleichsgrenze
stehen im Gesamtbericht.

## 9. Lizenz und Abgleich mit dem bestehenden Repo

Keine gekaufte Komponentenlizenz einplanen. Eigene Assembler-Anteile sollen dem
HimmelCAD-/Fernwork-Produktlizenzmodell folgen. Übernommene LGPL-Komponenten und
abgeleitete Rust-Ports behalten ihre jeweiligen Lizenzpflichten; eine andere
Programmiersprache ändert die Herkunft nicht. LGPL ist kein pauschaler
Ausschlussgrund für eine korrekt abgegrenzte, konform ausgelieferte Komponente.

Der aktuell gelesene Hauptcheckout enthält noch einen pauschalen LGPL-Ausschluss
in `docs/DEPENDENCY-POLICY.md`, einen gemeinsamen Renderer als Pflicht und
Assembler als reservierten Namen. Diese Ablage fügt keine Runtime und keinen
Produktcode hinzu. Vor Implementierung sind folgende Folgeänderungen gemeinsam
mit dem betroffenen Architekturstand nachzuführen:

1. Produktbezogene Assembler-Ausnahme zum gemeinsamen Renderer und gegebenenfalls
   zum Dokumentkern als nachvollziehbare ADR festhalten; bestehende Builder-/PhotoLab-
   Entscheidungen nicht rückwirkend umschreiben.
2. Dependency-Policy entsprechend der bereits besprochenen bedingten LGPL-
   Zulässigkeit aktualisieren. Exakte Komponenten, Versionen, Link-Art,
   Dritt-Lizenzen, Notices und Quell-/Relinkpflichten dokumentieren.
3. Assembler-Produktstatus aktualisieren, sobald konkrete Implementierung startet;
   dieser Auftrag dient zunächst der Ablage des Plans und der Recherche.

Dies sind Umsetzungspunkte, keine erneute Genehmigungsanforderung für die bereits
beauftragte Planung. Offene technische Entscheidungen werden zuerst am
Durchstich geprüft, nicht durch ungemessene Paritätsversprechen ersetzt.
