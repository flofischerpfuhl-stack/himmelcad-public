# Shapr3D research – 2026-09-28

Recherche für HimmelCAD Assembler mit drei GPT-6-Sol-Agents, anschließend
Quellenabgleich, visuellen Stichproben und Architektur-/Budgetbewertung.

**Zuerst die [Originalintention](../../OWNER-INTENT.md) lesen; der aktuelle
Umsetzungsvorschlag steht in [../../PLAN.md](../../PLAN.md).**
Insbesondere ersetzt der dort geplante eigenständige Renderer-Fork die ältere
Empfehlung eines gemeinsamen, versionierten Renderer-Konsums im datierten Bericht.

## Lesereihenfolge

1. [Gesamtbericht](Report.md), alternativ [HTML](Report.html): konsolidierte
   Analyse, aktualisierte Bedienhinweise, Funktionsmatrizen, Architektur,
   Agent-Budget, visuelle Belege und vollständiger Tutorial-Katalog.
2. [FreeCAD-/OCCT-Abgleich](notes/freecad-mapping.md): 19 Funktionsgruppen,
   Quellcodeanker, vorhandene Tests und zu ergänzende Mechanismen.
3. [Coverage-/Widerspruchsprüfung](notes/coverage-audit.md): wichtige
   Dokumentationsdrift und Verifikationslücken.
4. [Quellenindex](source-index.json), [Medienmanifest](media-manifest.json),
   [Inventarzahlen](research-stats.json), [Kopiernachweis](import-manifest.json).

## Einzelstudien

Die Originalnotizen bleiben für Nachvollziehbarkeit erhalten:

- [Interaktion](notes/interaction.md): Workspace, adaptive Auswahl, Gizmos,
  Maus/Trackpad/Touch/Pen, Kamera, Snaps und UI-Akzeptanzfälle.
- [Modellierung](notes/modeling.md): Sketcher, Constraints, Konstruktion,
  Volumen-/Flächenwerkzeuge, Transformationen und History.
- [Weiterer Produktumfang](notes/scope-media.md): Dateien, Druck, Projekte,
  Visualization, technische Zeichnungen, Cloud und XR.
- [Tutorial-Katalog](notes/tutorial-catalog.md): 134 sichtbare Kacheln des
  offiziellen Lernindex; Metadateninventar, keine vollständige Videosichtung.

**Die Einzelstudien sind historische Arbeitsnotizen, nicht die bereinigte
Gesamtfassung.** Bekannte Korrekturen: Trim endet seit 26.20 nicht mehr beim
Klick ins Leere; „More“ hängt von Platzmangel ab; Windows unterstützt USDZ-Export;
gespeicherte Ansichten können Section-Zustände enthalten; bestimmte
Konstruktionsreferenzen funktionieren auf STL-Meshes. Beim Overview-Video
beginnt Items/History etwa bei 01:06, nicht 00:57. Der Coverage-Audit erläutert
die Quellen. Der Gesamtbericht arbeitet diese Korrekturen ein. Bei Abweichungen
zuerst Gesamtbericht und aktuelle Primärquelle prüfen.

## Evidenz und Grenzen

- 134 Tutorial-Kacheln katalogisiert; kein Anspruch, jedes YouTube-Video über
  Shapr3D gefunden oder angesehen zu haben.
- 29 Originalmedien gesichert: 13 statische Bilder und 16 GIFs; zusätzlich
  16 dekodierte Einzelbilder für Stichproben.
- Acht Originale anhand statischer Bilder/GIF-Stichproben visuell geprüft.
- Stellen aus zwei offiziellen YouTube-Videos visuell geprüft; weitere Aussagen
  aus ausgewählten offiziellen Transkripten und Dokumentation.
- Keine vollständig durchgetestete aktuelle Shapr3D-Installation und kein
  ausgeführter FreeCAD-/OCCT-Vergleichsbuild.
- Budgetspannen sind technische Annahmen, keine gemessenen Claude-Wochenlimits.

Recherchebasis: HimmelCAD `b825a1ca4b57116d14828ca760325c51b84d0130`,
FreeCAD `f2065c6624af8afa3587646193980618cf1208fd`, FreeCAD-Dokumentation
`15406d1498e284739fd921d6fdc071905601b34b`. Das sind datierte Referenzen,
keine Behauptung aktueller Heads bei späterer Nutzung.

## Medien und Git

`media/` enthält die lokalen Originale und Stichproben. Die Quellen-/Medienrechte
verbleiben bei den jeweiligen Rechteinhabern. Diese Dateien werden nicht unter
HimmelCADs Lizenz umetikettiert, nicht als Produktassets verwendet und sind durch
`assembler/.gitignore` von Git ausgeschlossen. Der versionierbare Bericht und
das Manifest enthalten die Original-URLs, Quellseiten und SHA-256 der Originale.

Auf diesem Rechner öffnet `Report.html` mit den Bildern offline. Nach einem
frischen Git-Checkout ohne lokale Medien funktionieren die externen Quellenlinks
weiter; die lokalen Vorschaubilder müssen aus den angegebenen Referenzen erneut
bereitgestellt werden. Es gibt keinen automatischen Download im Produktbuild.

Vollständige Videos, fremde Handbücher und Volltranskripte werden nicht kopiert.
Die Untersuchungsnotizen und Verweise enthalten die für die Planung relevanten
Ergebnisse. Lokale Agent-Laufzeitlogs und Browser-/Download-Temporärdateien
gehören ebenfalls nicht in dieses Paket.

## Einordnung zur Repo-Architektur

Die Ablage ist ein Forschungs- und Planungsbereich. Sie importiert keine
FreeCAD-/OCCT-Quellen, installiert keine Abhängigkeit und ändert keine Builder-
Renderer-, Runtime- oder Releasekonfiguration. Den Abgleich der älteren globalen
Vorgaben mit der neuen Assembler-Planung beschreibt `PLAN.md`.
