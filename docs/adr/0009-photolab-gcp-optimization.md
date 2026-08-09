# ADR 0009: GCP-Messung und robuste Georeferenzierung

## Status

Angenommen.

Kalibrierungs-Policy in Überarbeitung seit 2026-07-19. Die unten beschriebene
GCP-, Snapshot-, Rollen-, Residual- und Publikationsarchitektur bleibt
verbindlich. Die pauschale Festlegung auf feste Intrinsics und das davon
abgeleitete Solverlabel sind jedoch keine Produktvorgabe mehr. M4 aus
`docs/PROGRAM-MILESTONES-2026-07-19.md` entscheidet die Defaults und die
freigebbaren Parameter pro Kalibrierungsgruppe anhand Primärliteratur,
Beobachtbarkeit und Golden-Datensätzen. Bis dahin darf bestehendes Verhalten
nicht stillschweigend als endgültige Policy dokumentiert werden.

## Kontext

PhotoLab muss GCPs mit XYZ-, XY- und Z-Masken, separat ausgewerteten
Checkpoints und reproduzierbaren Restfehlern verarbeiten. Das Programm muss
offline und auf Windows wie Linux funktionieren. Copyleft-Solver oder eine
plattformgebundene native Solver-Abhängigkeit sind daher kein tragfähiger
Kernpfad.

Die Sparse-Rekonstruktion führt bereits ein Bundle Adjustment aus. GCPs müssen
anschließend das freie Rekonstruktionssystem in den Projekt-Weltraum
überführen und die ausgewählten Kameraposen gemeinsam mit den Bildmessungen
nachziehen, ohne Checkpoints in die Survey-Schätzung einzumischen.

## Entscheidung

- Bildmessungen werden aus kalibrierten Kamerastrahlen per linearer
  Mehrstrahl-Ausgleichung trianguliert.
- Controls bestimmen eine robuste 7-Parameter-Similarity-Transformation
  (Translation, Rotation, Maßstab) als Initialisierung. Danach verfeinert ein
  gewichtetes robustes Bundle Adjustment die ausgewählten Kamera-Extrinsics,
  GCP-Schnittpunkte und eine deterministisch auf 50.000 Tracks begrenzte
  Teilmenge der COLMAP-Tie-Points. Huber und Cauchy stehen als robuste
  M-Schätzer für Bild- und Survey-Residuen zur Verfügung.
- Das Bundle Adjustment nutzt blockweise kleine Normalgleichungen für Punkte
  und Kameras. Dadurch bleibt der Speicher linear in der begrenzten Zahl von
  Messungen; es wird keine globale dichte Normalmatrix aufgebaut.
- Die erste ausgewählte Kamerapose und das Zentrum der zweiten ausgewählten
  Kamera fixieren Pose und Maßstab der Gauge. Nicht ausgewählte Kameras bleiben
  unverändert. Welche Intrinsics fest, priorisiert oder frei sind, wird pro
  Kalibrierungsgruppe durch die in Überarbeitung befindliche
  Kalibrierungs-Policy bestimmt und im Snapshot eingefroren.
- Nur die durch die jeweilige Rolle aktivierten Komponenten gehen mit ihrer
  Unsicherheit in die Normalgleichungen ein. Sind weniger als drei räumliche
  Controls vorhanden, optimiert `Auto` ausschließlich die beobachtbaren
  Translationskomponenten. Ein explizit verlangter 7-Parameter-Lauf wird in
  diesem Fall abgelehnt.
- Checkpoints nehmen mit ihren Bildmessungen an der Reprojektionsgeometrie
  teil, ihre Survey-Koordinaten erzeugen jedoch nie einen Prior und bleiben
  damit reine Genauigkeitskontrolle.
- Kamerareferenzen sind ein ausdrücklicher Opt-in und standardmäßig vollständig
  abgewählt. Nur explizit ausgewählte Kameras erzeugen einen Positionsprior.
  Dafür werden ihre bereits in den Projekt-Weltraum projizierten GPS-/RTK-
  Koordinaten und die beim Import eingefrorenen DJI-Unsicherheiten verwendet;
  fehlen Unsicherheiten, gelten dokumentierte konservative Standardwerte.
- Residuen werden je Punkt als East, North, Height, Horizontal, 3D und
  Bild-RMS geführt und für Controls und Checkpoints getrennt aggregiert. Jede
  Anzeige bleibt an den unveränderlichen GCP-Snapshot gebunden.
- Eine manuelle GCP-Messung darf an einen verifizierten Feature Track snappen.
  Dessen übrige Bildmessungen werden als automatische Vorschläge übernommen;
  manuelle Messungen werden dabei niemals überschrieben.
- Der Sidecar schreibt phasen- und iterationsweise atomare Checkpoints. Eine
  Cancellation wird in allen Punkt-, Iterations- und Projektionsschleifen
  geprüft. Ergebnisobjekte werden erst nach vollständiger Berechnung
  inhaltsadressiert veröffentlicht.
- Jede Optimierung veröffentlicht die IDs der Quell-Ausrichtung und des
  optionalen Processing Sets. MVS, Tiefenkarten, Orthorektifizierung und alle
  Folgeprodukte dürfen nur ein zu genau dieser Lineage kompatibles Ergebnis
  übernehmen. Dabei werden die optimierten Kamera-Extrinsics direkt verwendet;
  die Similarity allein ist kein Ersatz für die Bundle-Adjustment-Pose.

## UX-Vertrag

- Blau: nur vorhergesagte Projektion, nicht optimierungswirksam.
- Grün: manuell bestätigte Bildmessung.
- Orange: über einen geometrisch verifizierten Tie Point fortgeschriebene
  automatische Messung.
- Gedämpft: bewusst gesperrte Messung.

## Konsequenzen

Der GCP-Pfad benötigt keine zusätzliche Runtime-Library und verhält sich auf
CPU, GPU und Betriebssystemen identisch. Das Ergebnis veröffentlicht neben
Similarity, Restfehlern und Projektionen auch die verfeinerten Kameras und
Sparse-Tie-Points. Solverlabel und Provenance enthalten zusätzlich die
eingefrorene Intrinsics-Policy; das bisherige Label
`himmelcad-weighted-robust-bundle-adjustment-v2-fixed-intrinsics` bezeichnet
nur den entsprechenden Legacy-Modus. Ergebnisse ohne passende Alignment-/
Processing-Set-Lineage werden nicht stillschweigend für Produkte
wiederverwendet. Ein späterer Schur- oder GPU-Solver kann denselben Snapshot-,
Gauge-, Rollen-, Residual-, Lineage- und Publikationsvertrag übernehmen.
