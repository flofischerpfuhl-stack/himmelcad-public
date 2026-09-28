# HimmelCAD Assembler

Planungs- und Recherchebereich für ein eigenständiges, agentenfreundliches CAD
für 3D-Druck mit möglichst Shapr3D-naher Bedienung.

**Stand: 28. September 2026. Dokumentation, noch keine Implementierung.**

## Einstieg

- **Zuerst [Originalintention und Bedingungen](OWNER-INTENT.md) lesen:**
  Florians Ziele mit Originalaussagen, getrennt von Vorschlägen und Annahmen.
- [Aktueller Umsetzungsvorschlag](PLAN.md): Produktumfang, Renderer-Fork, CAD-Unterbau,
  Agent-Schnittstelle, Umsetzungsschritte, Abnahme und Tokenbudget.
- [Recherchepaket](research/2026-09-28/README.md): Lesereihenfolge,
  Evidenzgrenzen und Medienablage.
- [Gesamtbericht als Markdown](research/2026-09-28/Report.md) oder
  [lesbare HTML-Fassung](research/2026-09-28/Report.html).
- [Quellenindex](research/2026-09-28/source-index.json) und
  [Mediennachweise](research/2026-09-28/media-manifest.json).

## Aktuelle Richtung

Electron + TypeScript für die Oberfläche, Rust für die Anwendungslogik.
Ausgewählte FreeCAD-/OCCT-Bausteine sollen die CAD-Arbeit reduzieren.
OCCT und gegebenenfalls der FreeCAD-Skizzensolver bleiben zunächst native
Komponenten. Ein vollständiger Geometriekernel-Port nach Rust ist nicht geplant.

Der derzeitige Vorschlag ist, den HimmelCAD-Renderer zunächst **separat zu forken**.
Builder behält seinen Renderer und seine Verhaltensregeln. Ein unabhängiger
Assembler-Dokumentkern ist eine zu prüfende Option; das vollständige
Builder-Backend ist keine automatische Voraussetzung.

Die erste Version konzentriert sich auf lokale, editierbare Druckteile.
Cloud/Teamfreigaben, technische 2D-Zeichnungsblätter und AR/XR sind für diese
Planung vorläufig zurückgestellt; Florian hat dies als Möglichkeit genannt,
nicht dauerhaft ausgeschlossen. Konstruktionsskizzen, Maße, Schnittansicht und
STL-/3MF-Ausgabe bleiben enthalten.

## Dokumentstatus

`OWNER-INTENT.md` hält das Ziel fest; `PLAN.md` beschreibt einen verbesserbaren
Weg dorthin. Weder die Alpha noch der Umfang der ersten Version ersetzen das
Ziel größtmöglicher Shapr3D-Nähe. Die datierte Recherche entstand größtenteils
vor der Fork-Empfehlung und ist Belegmaterial, keine aktuelle Architekturvorgabe.
Abweichungen sind im Recherchepaket benannt.

Bestehende globale ADRs und Produktprioritäten wurden durch diese Ablage nicht
umgeschrieben. Vor tatsächlicher Implementierung werden die produktbezogenen
Ausnahmen und die konkrete Komponentenlizenzierung in den zuständigen
Architekturdokumenten nachgeführt. Die gewünschte Planung ist bereits
autorisiert; diese Ablage behauptet keinen begonnenen Fork oder CAD-Build.

## Referenzmedien

Die Originalbilder/GIFs und extrahierten Stichproben liegen lokal in
`research/2026-09-28/media/`. Sie gehören nicht zu den Produktassets und werden
durch die lokale `.gitignore` dieses Bereichs von Git ausgeschlossen.
URLs, Herkunft und SHA-256 bleiben im versionierbaren Manifest nachvollziehbar.
Es werden keine vollständigen YouTube-Videos oder Tutorial-Transkripte mitgeführt.
