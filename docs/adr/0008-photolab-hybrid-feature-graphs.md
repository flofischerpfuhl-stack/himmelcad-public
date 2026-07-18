# ADR 0008: Getrennte Feature-Graphen und messbare Hybrid-Auswahl

## Status

Angenommen.

## Kontext

PhotoLab kombiniert ALIKED/LightGlue, SIFT/LightGlue und DeDoDe-v2-G. Die
Keypoint-Indizes der drei Verfahren haben keine gemeinsame Semantik. Ein
ungeprüftes Zusammenkopieren ihrer SQLite-Tabellen würde Beobachtungen
vertauschen oder Duplikate als zusätzliche Evidenz zählen.

DeDoDe läuft aus Lizenz-, Trust- und Hardwaregründen in einem separaten,
signierten Offline-Worker. COLMAP bleibt für Kameramodell, epipolare Prüfung,
Trackbildung und Sparse Reconstruction zuständig.

## Entscheidung

- Jeder Matcher besitzt eine eigene COLMAP-Datenbank.
- DeDoDe-Keypoints werden nach `(CameraEntityId, workerFeatureId)` stabil
  aggregiert. Widersprüchliche Koordinaten desselben Features brechen den Lauf
  ab.
- Die Brücke verwendet ausschließlich COLMAPs öffentliche Textformate und die
  CLI-Kommandos `feature_importer`, `matches_importer` und
  `geometric_verifier`.
- Die 128 Import-Deskriptorwerte sind deterministische Sentinelwerte. Sie
  gelangen nie in einen Deskriptormatcher; ausschließlich die expliziten
  DeDoDe-Paare werden importiert und anschließend geometrisch geprüft.
- Im Hybridmodus werden globale und inkrementelle Rekonstruktionen für alle
  drei getrennt verifizierten Feature-Graphen ausgeführt.
- „Alle Kandidatenpaare“ bezeichnet den vor dem Lauf eingefrorenen Pair Graph,
  nicht automatisch alle quadratischen Bildkombinationen. `Quality Hybrid`
  verwendet für geordnete Aufnahmefolgen einen beidseitig überlappenden
  Sequenzgraphen mit 24 Nachbarn; ALIKED/LightGlue und SIFT verarbeiten jede
  dieser Kanten unabhängig. Nur `Maximum Robustness` verlangt den
  vollständigen quadratischen Graphen. Kalibriergruppen dürfen die
  Aufnahmefolge dabei nicht umsortieren.
- Jede erfolgreiche Rekonstruktion wird mit `model_converter` in das
  öffentliche COLMAP-Textformat überführt. Die Auswahl erfolgt deterministisch
  nach registrierten Bildern, gültigen Beobachtungen, 3D-Punkten und kleinerem
  mittleren Reprojektionsfehler. Erst bei vollständigem Gleichstand gelten die
  Nutzerpräferenz, Global Mapper und eine feste Store-Reihenfolge.
- Das ausgewählte Modell wird nach `sparse-selected/0` kopiert. Alle dichten
  Folgeprodukte und die publizierte Sparse-Artefaktbeschreibung verwenden nur
  diesen kanonischen Pfad.
- Fehlgeschlagene Kandidaten werden im Command-Protokoll erhalten. Es gibt
  keinen stillen Fallback von einem angeforderten DeDoDe-Lauf auf nur
  ALIKED/SIFT.

## Folgen

Die Verfahren werden auf Rekonstruktionsebene als Ensemble fusioniert, ohne
inkompatible Feature-Indizes zu vermischen. Der Hybridmodus benötigt mehr
Rechenzeit und Speicher, kann aber niemals allein wegen einer internen
Tie-Break-Entscheidung ein statistisch schwächeres Modell auswählen. Eine
spätere echte Track-Level-Fusion braucht einen eigenen, getesteten
Multi-Descriptor-Trackbuilder und eine neue ADR.
