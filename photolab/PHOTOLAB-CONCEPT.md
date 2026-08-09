# HimmelCAD PhotoLab — Produkt- und Technikkonzept

Status: Konzeptentwurf für die Produktentscheidung  
Stand: 11. Juli 2026  
Ziel: nahezu vollwertige, vermessungstaugliche Alternative zu Agisoft Metashape mit zusätzlicher Gaussian-Splat-Pipeline

## 1. Produktziel

PhotoLab wird vor Builder zum nächsten fertigen HimmelCAD-Produkt. Es verarbeitet Luftbild-, Nahbereichs- und perspektivisch Multikamera-Datensätze in einem reproduzierbaren, hardwareadaptiven Workflow. Die sechs verpflichtenden Hauptprodukte sind:

1. messbare Tiefenbilder je ausgerichtetem Originalbild,
2. dichte Punktwolke,
3. DEM als DSM oder DTM,
4. Orthomosaik,
5. Textured Mesh,
6. Gaussian-Splat-Datensatz.

Zusätzlich benötigt der Workflow intern und für die Qualitätsprüfung:

- kalibrierte Kameras und Bildposen,
- Keypoints, Matches, Tracks und Sparse Point Cloud,
- GCP-/Checkpoint-Beobachtungen und Ausgleichungsergebnisse,
- intern zusätzlich untexturierte Mesh-/Terrain-Zwischenprodukte,
- Verarbeitungsberichte, Unsicherheiten und vollständige Provenienz.

Alle Ergebnisse sind normale HimmelCAD-Entities. PhotoLab nutzt denselben Renderer, dieselben Weltkoordinaten-, Picking-, Streaming- und Projektverträge wie Builder und WeltView.

## 2. Leitentscheidungen

### 2.1 Genauigkeit vor vermeintlicher Automatik

- Quelldaten bleiben unverändert; EXIF/XMP/DJI-Metadaten werden als immutable Source-Entities gespeichert.
- Jede Transformation, Ausrichtung, Optimierung und Produkterzeugung ist ein Command und erzeugt einen nachvollziehbaren Run.
- Kein CRS, Höhensystem, Geoid, Grid, Maßstab oder Kameramodell wird stillschweigend angenommen.
- Angezeigte Millimeter sind numerische Auflösung, keine behauptete Genauigkeit. Transformations- und Messgenauigkeit werden aus Quelle, Operation, Grid und Ausgleichung getrennt ausgewiesen.
- Gaussian Splats sind primär eine photorealistische Darstellung. Vermessungen verwenden validierte Tiefenbilder, Punktwolken, Meshes oder DEMs; Messungen auf Splats werden als approximiert gekennzeichnet.

### 2.2 Kein kopiertes „Chunk“-Modell

Metashape-Chunks vermischen Organisation, Rechenzustand und alternative Ergebnisse. PhotoLab trennt diese Begriffe:

| Begriff | Bedeutung | Veränderbarkeit |
| --- | --- | --- |
| Projekt | gemeinsamer Container, Objektstore, CRS-Katalog, Jobs | kanonisch über Commands |
| Survey/Block | zusammenhängendes Aufnahme- und Rekonstruktionssystem | editierbare Metadaten, versionierte Geometrie |
| Capture Group | eingefrorene Mission beziehungsweise Aufnahme-/Autofokus-Session mit exakter Bildmitgliedschaft | immutable |
| Camera Calibration Group | exakte Intrinsics-Gruppe innerhalb einer Capture Group; Fokus-/Zoomwechsel bleiben getrennt | immutable |
| Sammlung | reine Baumorganisation/Tags, z. B. Flug 1 oder Schrägbilder | frei organisierbar |
| Verarbeitungsset | benannte Bildauswahl als Query oder eingefrorener Snapshot | versioniert |
| Alignment Run | Posen, Kalibrierung, Tracks, Sparse Cloud und QA für exakt einen Input-Snapshot | immutable |
| Product Run | Depth/Dense/DEM/Ortho/Splat mit Parent-Run und Parametern | immutable |
| Merge Run | registriert mehrere Surveys/Alignment Runs über Tracks, GCPs oder Referenz | immutable |

Das vermeidet die häufige Unklarheit „welches aktive Asset gehört zu welchem Chunk?“ und ermöglicht echte Reproduzierbarkeit.

Ein Zwischenlanden mit neu gesetztem Autofokus erzeugt deshalb mindestens eine neue
`Camera Calibration Group`. Die betroffenen Bildmengen können bis einschließlich GCP-Optimierung
getrennt verarbeitet werden. Ein anschließender Merge ist explizit: Bei Bildüberlappung misst der
gemeinsame Solve echte Cross-Run-Tracks; ohne Bildüberlappung verbinden mindestens drei in allen
Blöcken verwendete Controls die bereits optimierten Kameras im gemeinsamen Survey-Frame. Der
zweite Fall behauptet bewusst kein Cross-Block-Bundle-Adjustment, weil keine verbindenden
Bildbeobachtungen existieren. Folgeprodukte wählen den veröffentlichten Merge Run explizit als
Quelle.

### 2.3 Organisation und Berechnung bleiben getrennt

- Sammlungen dürfen Bilder beliebig hierarchisch gruppieren, ohne Berechnungsergebnisse zu verändern.
- Verarbeitungssets können aus Auswahl, Sammlung, Tags, Zeit, Kamera, Fluglinie, GPS-Fläche, Qualitätsgrenze oder einer Kombination entstehen.
- Vor dem Start wird ein Set als Input-Snapshot eingefroren. Nachträgliche Bildänderungen markieren abhängige Runs als „veraltet“, verändern sie aber nicht.
- Der Scope-Balken über dem View zeigt ständig Survey, Alignment Run, Verarbeitungsset, GCP-Snapshot und Produktstand.

## 3. Ziel-Workflow

### 3.1 Bilder importieren und Referenz konfigurieren

Der gemeinsame IO-Import akzeptiert einzelne Bilder, Ordner, rekursive Ordner,
Drag-and-drop, Multikamera-/Multispektral-Layouts und später Video-Frames. Er
erkennt Duplikate per Content Hash, schlägt Dateinamenorganisation und
Aufnahmegruppen vor und zeigt EXIF/XMP, GNSS/INS, Kamera-/Gimbalwinkel,
Brennweite, Sensorgröße, Zeit, Zeitzone und Unsicherheiten. Das ist noch keine
interaktive Registrierung und kein Batch-Knoten.

Zusätzlich ist ein dedizierter Importer für **HimmelCAD Cap**-Sessions
(`.himmelcap`) vorgesehen: gewichtete Positions-Priors mit echter Kovarianz,
Capture Groups pro Session, ohne stilles Umschalten auf `crsBacked`. Details:
`docs/himmelcap/PHOTOLAB-IMPORTER.md` und ADR 0027.

Eine optionale anschließende Referenzkonfiguration hat zwei Modi:

- **CRS-backed:** Höhenbezug, Quell-/Ziel-CRS, Area of Interest, Datumsepoche,
  konkrete PROJ-Operation und benötigte NTv2-/GTG-Grids werden geprüft. Die
  bewährte Reihenfolge bleibt Höhe vor Lage; vor Accept erscheinen Stichproben,
  Bounding Box, Genauigkeit, Grid-Abdeckung, Ausreißer und die endgültige
  Pipeline.
- **Local metric:** Das Projekt bleibt ein rechtshändiger kartesischer Raum in
  Metern ohne erfundenes CRS, Kartenorigin, Norden oder Schwerkraft. Ein
  versionierter Maßstabszwang zwischen triangulierten Endpunkten kann später
  den Maßstab festlegen. Smartphone-GNSS bleibt ein unsicherer optionaler Prior
  und macht den Raum nicht automatisch CRS-backed.

Die UX fragt wie gewünscht zuerst nach dem Höhenbezug und danach nach der Lage. Intern darf die mathematische PROJ-Pipeline die nötigen Schritte in der korrekten Reihenfolge ausführen, weil ein Geoidwert selbst an geographischen Koordinaten ausgewertet wird.

#### CRS-/Grid-Regeln

- PROJ und seine EPSG-Datenbank liefern Kandidaten, Area of Use, Operationsgenauigkeit und benötigte Grid-Namen.
- `ALLOW_BALLPARK=NO` und `ONLY_BEST=YES` sind der vermessungstaugliche Standard. Eine Ballpark-Operation ist nur nach expliziter Warnungsbestätigung zulässig.
- Fehlende Grids erscheinen mit offiziellem Namen, Abdeckung, Quelle, Lizenz und Prüfsumme. Frei redistribuierbare, häufige Grids können nach Lizenzprüfung gebündelt werden; andere lädt der User von der Behörde oder wählt lokal aus.
- Ein ausdrücklich gewähltes lokales Grid darf einen abweichenden Dateinamen tragen. PhotoLab kopiert es einmal in sein lokales Grid-Register, getrennt nach horizontaler und vertikaler Rolle. Eine erneute Wahl desselben registrierten Namens verwendet diese unveränderliche lokale Kopie ohne erneutes Hashen oder Kopieren. PhotoLab prüft tatsächliche Abdeckung, Format und Transformationsrichtung und validiert die eingefrorene Pipeline mit einer Vorwärts-/Rückwärtsprobe. Eine veröffentlichte Genauigkeit wird nicht allein aus Dateiname oder Dateiendung abgeleitet.
- Netzwerkdownload ist opt-in, wird gecacht und protokolliert. Projektarchive können verwendete Grids einbetten, sofern deren Lizenz das erlaubt.
- Originalkoordinaten, transformierte Koordinaten, Pipeline als PROJJSON/WKT2, registrierte Grid-Rolle/-Datei und PROJ-/EPSG-Datenbankversion werden gespeichert. Offizielle gebündelte Grids dürfen zusätzlich ihre veröffentlichte Inventar-Prüfsumme tragen; benutzergewählte Grids blockieren den Workflow nicht durch eine vollständige Datei-Hashprüfung.
- Dynamische Datumsangaben benötigen eine Koordinatenepoche. Fehlende Epoche wird nicht erfunden.
- DJI-„AbsoluteAltitude“ oder ähnliche Felder werden nicht pauschal als Ellipsoid- oder Geoid-Höhe interpretiert; Importprofile tragen Geräte-/Firmwarewissen und eine Konfidenz.

#### Lokale NTv2-Referenz

Der Ordner `/home/oem/Dokumente/002_Geschäftlich/01_Geiger/03_Projekte/NT2V` enthält 109 bayerische GK4/UTM32-Testpunktpaare sowie ältere Transformationsversuche. Er wird ausschließlich als Test- und Verständnisquelle genutzt:

- kein Copy/Paste der Python-/GeodePy-abgeleiteten Reader,
- Umsetzung über PROJ mit explizit ausgewähltem BY-KanU-Grid,
- golden tests in beide Richtungen, Grid-Rand, außerhalb der Abdeckung, falsches Grid, fehlendes Grid und Achsenreihenfolge,
- erst die behördlichen Testpunkte und die konkrete Grid-Version als authoritative Erwartung festlegen; die lokalen CSV-/Skriptstände weisen unterschiedliche Zwischenresultate aus.

### 3.2 Fotos ausrichten

Die Funktion „Fotos ausrichten“ erzeugt einen Alignment Run mit folgenden Stufen:

1. Bilddekodierung, Orientierung normalisieren, lineare Arbeitsfarbräume und Bildpyramiden cachen.
2. Bildqualität schätzen: Schärfe, Bewegungsunschärfe, Belichtung, Sättigung, Textur, Duplikate.
3. Kandidatenpaare erzeugen: GPS/INS-Frustum, Zeit/Sequenz, globale Bildähnlichkeit und bei kleinen Sets exhaustive Ergänzung.
4. Keypoints und Deskriptoren berechnen.
5. Korrespondenzen matchen und geometrisch robust verifizieren.
6. Tracks über Bilder konsolidieren.
7. Initialisierung, inkrementelles/hybrides SfM, Triangulation und lokale Bundle Adjustments.
8. Globales Bundle Adjustment, Ausreißerprüfung, Komponentenbildung und Kovarianzschätzung.
9. Kameraposen, Sparse Point Cloud, Kalibriergruppen und Diagnose-Report persistieren.

#### Empfohlene Matching-Strategie

Nicht ein einziges neuronales Modell wird als unfehlbarer Standard fest eingebaut. PhotoLab erhält einen adaptiven Hybridpfad mit austauschbaren Backends:

- **Quality Hybrid (Release-Default):** ALIKED-N32/Rotation-Variante +
  LightGlue und SIFT/DSP-SIFT + LightGlue laufen für alle Kandidatenpaare
  unabhängig. Der separat signierte DeDoDe-v2-G-Pfad ergänzt
  tragende, geometrisch schwierige oder zwischen den Sparse-Pfaden
  widersprüchliche Kanten. Erst die jeweils geometrisch verifizierten Inlier
  werden zusammengeführt.
- **Fast:** Der native SIFT-Pfad verarbeitet einen begrenzten, nach der
  Aufnahmefolge geordneten Pair Graph; ALIKED + LightGlue und weitere Backends
  werden für gescheiterte Rekonstruktionen oder explizite Problemkanten als
  Rescue aktiviert. Dieser Modus ist eine sichtbare Userwahl und kein
  automatischer Low-Hardware-Qualitätsabfall.
- **Maximum Robustness:** Quality Hybrid mit erweitertem Pair Graph, höheren
  Featurebudgets und DeDoDe-v2-G auf allen Kandidatenpaaren; danach
  Dense Rescue für verbleibende Problemkanten. Dieser Modus priorisiert
  Alignment-Erfolg vor Matching-Zeit.
- **Dense Rescue:** ein lizenzgeeigneter dichter Matcher wie RoMa wird ausschließlich auf schwache, erzwungene oder zum Verbinden von Komponenten benötigte Paare angewendet. LoFTR/weitere Kandidaten bleiben austauschbar; MASt3R/DUSt3R sind mit den verfügbaren Gewichten lizenzbedingt ausgeschlossen.
- **Hybrid Features:** Punkt- und Linienmerkmale für texturarme, gebaute Szenen als späterer professioneller Modus.

ALIKED- und SIFT-Features bleiben getrennte Namespaces. PhotoLab mischt keine inkompatiblen Deskriptoren. Jedes Backend matcht und verifiziert zunächst separat; anschließend werden Inlier über Pixelnähe, Epipolargeometrie, Track-Eindeutigkeit und Zykluskonsistenz dedupliziert. Ein Track darf pro Bild höchstens eine Beobachtung besitzen und speichert die Backend-Provenienz jeder Beobachtung.

Der adaptive Pfad eskaliert anhand messbarer Gates: verifizierte Inlier, Bildflächenabdeckung, Epipolar-/Reprojektionsfehler, Basislinie/Triangulationswinkel, Zykluskonsistenz, Kameragraph-Grad und drohende getrennte Komponenten. „Mehr Matches“ allein ist kein Qualitätskriterium.

Learned Matching kann in schwierigen Fällen deutlich mehr Inlier liefern, ist aber kein automatischer Ersatz für klassische Features: Gewichte, Generalisierung, Speicherbedarf, Reproduzierbarkeit und Lizenz müssen getrennt bewertet werden. SuperPoint wird wegen der restriktiven Weight-/Referenzlizenz nicht mitgeliefert. Der endgültige Default wird durch eigene UAV-, Nahbereichs-, Wald-, Fassade-, RTK- und Smartphone-Benchmarks bestätigt.

**Was mit „Gewichten mitliefern“ gemeint ist:** ALIKED und LightGlue gehören zur
Bildausrichtung, nicht zum Gaussian Splat. Der Programmcode beschreibt, wie das
neuronale Netz rechnet. Die Gewichtsdatei enthält die beim vorherigen Training
gelernten Millionen Zahlenwerte – vergleichbar mit der Kalibrierung bzw. dem
gelernten Gedächtnis des Algorithmus. Ohne passende Gewichte ist der Code zwar
vorhanden, erkennt und verknüpft aber keine Bildmerkmale. PhotoLab liefert daher
kleine, lizenzgeprüfte Standardgewichte im Installer mit: offline, reproduzierbar
und auf allen Plattformen identisch. Alle für den freigegebenen
Maximum-Robustness- und Dense-Rescue-Pfad benötigten großen Gewichte werden im
vollständigen Offline-Installer bzw. einem zusammen mit der Distribution
auslieferbaren, signierten Offline-Modellpaket mitgeliefert. PhotoLab lädt zur
Laufzeit keine Gewichte aus dem Internet. SIFT bleibt der vollständig klassische,
gewichtelose Referenz- und CPU-Pfad.

Die Paketgröße ist kein Auswahlkriterium: die produktiven Sparse-Modelle liegen
nur im ein- bis niedrigen zweistelligen MiB-Bereich, weil die Aufgabe kompakt
ist. Mehrere GiB sind nur gerechtfertigt, wenn ein dichter Rescue-Backbone in
eigenen UAV-/Nahbereichs-Benchmarks zusätzliche gültige Graphkanten liefert.
Große Gewichte werden nicht dauerhaft geladen, sondern nur für die betroffenen
Paar-Work-Units innerhalb des RAM-/VRAM-Budgets gemappt.

Offizielle `.pth`-Dateien werden nicht ungeprüft zur Laufzeit entpickelt. Die
Release-Pipeline lädt sie isoliert und nur im sicheren Weight-Modus, konvertiert
sie in ein geprüftes natives/ONNX-/Safetensors-Artefakt und versieht jede Datei
mit SHA-256, Signatur, Source-Commit, Model Card, Code-/Weight-/Trainingsdaten-
Lizenz und SBOM-Eintrag. Der Runtime-Model-Resolver akzeptiert ausschließlich
signierte Manifestartefakte aus dem installierten Offline-Paket.

#### SfM-Strategie

- GLOMAP/globales SfM ist der schnelle erste Pfad für einen gut verbundenen, geometrisch verifizierten View Graph.
- Inkrementelles SfM bleibt der robuste Fallback bei unsicherer Kalibrierung, gemischten Kameras und vielen Outlier-Kanten.
- Sehr große Datensätze können hierarchisch geclustert werden; Cluster werden über gemeinsame Tracks, RTK oder GCPs registriert und erhalten anschließend ein gemeinsames globales Bundle Adjustment.
- Jeder Feature-/Match-Cache trägt Originalbildkoordinaten, Backend-/Weight-Version, Downscale, Tile-NMS und Parameterhash.
- Tracks werden nicht blind transitiv vereinigt: höchstens ein Feature pro Bild, robuste Multi-View-Triangulation, Cheirality, Basislinie, Triangulationswinkel und Zykluskonsistenz sind Pflicht.

#### Alignment-Einstellungen

**Einfach:** Profil, erwartete Szene, Qualitätsziel, Bildvorselektion, vorhandene Posen verwenden, Reset/Incremental.  
**Erweitert:** Feature-Backend, Arbeitsauflösung, Keypoints/Mpx, minimale Tracklänge, Pairing-Modi und Limits, Geometrie-Modell, RANSAC-Schwelle, Kameramodell, Rolling Shutter, Kalibriergruppen, robuste Loss, Reprojection Cutoff, BA-Intrinsics, Kovarianz, deterministischer Seed.  
**Ressourcen:** Auto/CPU/GPU, Geräte, maximaler RAM-/VRAM-Anteil, parallele Decoder, Cacheort, Leistungs-/Energieschema.

Das UI zeigt aussagekräftige Größen („max. 8.000 Features/Mpx“, „Arbeitskante 3.000 px“) statt nur „High/Medium/Low“. Presets schreiben konkrete Parameter und können aufgeklappt werden.

#### Alignment-Ergebnisse und Diagnose

- ausgerichtet/nicht ausgerichtet/ausgeschlossen/mehrdeutig als Status und Tag,
- zusätzliche, voneinander unabhängige Bild-Tags für `Depth ready`, `Depth stale`,
  `Masked`, `RTK fixed`, `Quality warning` und spätere Produktzustände; ein Bild
  kann beispielsweise gleichzeitig `Aligned` und `Depth ready` tragen,
- getrennte Komponenten im Tree,
- Coverage- und Overlap-Heatmap,
- Matchgraph und „Matches zwischen zwei Bildern“,
- Reprojection Error, Track Length, Triangulation Angle, Keypoint Scale, Image Residuals,
- Kamerakalibrierung je Gruppe mit Unsicherheit und Korrelation,
- Gradual Selection als nichtdestruktiver Filter/derived selection,
- „Ausgewählte Kameras neu ausrichten“, „Alignment zurücksetzen“, „Komponenten verbinden“.

### 3.3 GCPs importieren

Ein CSV-Import-Mapping unterstützt Header, Trennzeichen, Dezimalzeichen, Name, East/North/Height, XY-/Z-Standardabweichung, Rolle und CRS. GCPs erscheinen als quadratische blaue Billboard-Marker mit optionalem Namen; Farbe und Form kodieren zusätzlich den Zustand barriereärmer:

- Blau, Quadrat: noch nicht bestätigte/projizierte Beobachtung,
- Grün, Pin: manuell bestätigt,
- Orange, Raute: automatisch an einen Keypoint/Track gekoppelt,
- Grau, durchgestrichen: deaktiviert/geblockt,
- Violett, Ring: Checkpoint im 3D-View.

### 3.4 GCP-Projektionen markieren

Rechtsklick auf einen GCP bietet „Bilder mit diesem GCP“. Daraufhin:

- öffnet der zentrale Bereich den Bilder-View oder einen 3D/Bild-Split,
- listet das rechte Funktionspanel nur Bilder mit erwarteter Sichtbarkeit, sortiert nach Projektionsunsicherheit, Auflösung am Punkt und Blickwinkel,
- zeigt jedes Bild die erwartete Position samt Unsicherheitsellipse und Epipolarhilfe,
- erzeugt Drag/Pin einen `SetMarkerObservation`-Command,
- erzeugt auch ein Bild-Rechtsklick eine neue Beobachtung und ordnet sie einem
  vorhandenen oder neu angelegten GCP zu,
- trianguliert PhotoLab aus bestätigten Beobachtungen die GCP-Schätzung neu,
  berechnet lokale Residuen und Kovarianz neu und reprojiziert sie sofort in
  alle anderen Bilder,
- leitet jede Fehlerellipse mit dem Projektions-Jacobian aus der aktuellen
  3D-Kovarianz ab; Winkel und Radien sind nie hart kodiert,
- bleiben alle in einem Bild relevanten GCPs sichtbar, während genau einer
  fokussiert ist,
- übernimmt der Bildwechsel die Vergrößerung und zentriert den fokussierten GCP,
- bleiben Kameraposen dabei unverändert; die kanonische Blockausgleichung erfolgt erst durch „Ausrichtung optimieren“.

Landet eine Reprojektion konsistent auf einem vorhandenen Feature-Track, kann dieser als orange Auto-Beobachtung vorgeschlagen werden. Automatische Beobachtungen sind niemals stillschweigend „manuell bestätigt“. Jeder Vorschlag besitzt Score, Herkunft und Undo.

Weitere Beobachtungsaktionen: Pin/Bestätigen, Unpin, Blockieren, aus Bild entfernen, auf Keypoint snappen, 100%-Zoom, Korrelationspatch zeigen, vorherige/nächste Projektion, nur unbestätigte Bilder.

### 3.5 Ausrichtung optimieren

Mathematisch sinnvoll sind getrennte GCP-Komponenten:

- `XYZ Control`,
- `XY Control` (Lage),
- `Z Control` (Höhe),
- `Checkpoint` (XYZ/XY/Z),
- `Disabled`.

Die Bundle-Adjustment-Residualvektoren werden entsprechend maskiert und mit XY-/Z-Kovarianzen gewichtet. Das UI warnt bei schwacher Geometrie, etwa reinen Lagepunkten ohne Höhenstaffelung.

Wichtige Begriffsklärung: Alle ausgerichteten Bilder bleiben über Tie-Point-Reprojektionen Bestandteil der Ausgleichung. Die standardmäßig deaktivierte Option „Kamerareferenz verwenden“ meint nur GNSS-/INS-Positions- und Orientierungsbeobachtungen der Bilder. Sie entfernt die Kamera nicht aus dem Block.

Standardvorschlag:

- Tie-Point-Beobachtungen: aktiv,
- manuell bestätigte GCP-Beobachtungen: aktiv,
- automatisch vorgeschlagene GCP-Beobachtungen: aktiv nur oberhalb konfigurierter Konfidenz und klar markiert,
- Kamera-GNSS/INS: deaktiviert, sofern deren Genauigkeit nicht RTK/PPK-verifiziert ist,
- Checkpoints: räumlich geschichtete, deterministische Auswahl statt blindem Zufall; mindestens 3–5, bei kleinen Sets Userentscheidung,
- optimierte Intrinsics: adaptive Auswahl mit Experten-Override,
- robuste Loss und Ausreißerbericht, keine stille Beobachtungslöschung.

Vor „Start“ erscheint eine Vergleichsvorschau: Anzahl Kameras, Tracks, Control Points, Checkpoints, Beobachtungen, Freiheitsgrade, räumliche Abdeckung, erwartete Speicherzeit sowie geänderte Parameter. Das Ergebnis wird als neuer Alignment Run gespeichert; „vorher/nachher“ bleibt vergleichbar.

### 3.6 Accuracy- und QA-Arbeitsbereich

Das Bottom-Island besitzt die Tabs `Konsole`, `Jobs`, `Genauigkeit` und `Bericht`. Der Genauigkeits-Tab zeigt immer einen fest angehefteten Scope:

`Survey › Alignment Run › GCP Snapshot › Filter`

Pro GCP:

- Name und Rolle,
- verwendete/gesamte Projektionen,
- East-, North-, Height- und 3D-Residual,
- Bild-Reprojection RMS in Pixeln,
- XY-/Z-Genauigkeit der Quelle,
- geschätzte XYZ-Unsicherheit,
- Max-Residual und Warnstatus.

Zusammenfassung getrennt für Control und Check:

- Anzahl Punkte/Beobachtungen,
- Bias East/North/Height,
- RMSE East/North/Height/Horizontal/3D,
- Median, robustes NMAD, Maximum,
- Reprojection RMS,
- Sigma0/Redundanz soweit statistisch tragfähig,
- Konfidenzintervalle und räumliche Residualvektoren.

Wechselt der User die sichtbare Punktwolke oder ein Produkt, ändert sich der QA-Scope nicht unbemerkt. Ein gelbes „Scope weicht von sichtbarem Produkt ab“-Badge bietet „passenden Run aktivieren“.

## 4. Produkterzeugung

### 4.1 Tiefenbilder

Empfohlener Ausgangspunkt ist plane-sweeping/ PatchMatch Multi-View Stereo mit coarse-to-fine Bildpyramide, view selection und geometric consistency. Neuronale MVS-Backends bleiben optionale Plugins, bis sie in Vermessungsdatensätzen, auf schwacher Hardware und lizenzrechtlich bestanden haben.

Parameter:

- Input Alignment Run und Verarbeitungsset,
- Ziel-GSD oder Pyramidenskalierung statt abstrakter Qualitätsstufe,
- maximale Nachbarbilder und Auswahlkriterien,
- Min/Max-Tiefe automatisch oder manuell,
- Matching Cost, Fenster/Pattern, Iterationen,
- geometric consistency und Anzahl konsistenter Views,
- schwach-textur-/Kantenmodus,
- Filtering mild/moderat/aggressiv/custom,
- Confidence- und Normalenoutput,
- Masks, ROI, NoData-Regeln,
- Geräte-/Speicherbudget.

Jedes Depth-Map-Tile speichert Tiefe, Normalen, Confidence, Validity, Parent Alignment Run und Pixel-zu-Kamera-Modell. Ein Klick im Original-/Depth-View rechnet den validen Tiefenpixel mit der kalibrierten Pose nach `f64`-Weltkoordinaten zurück. Angezeigt werden XYZ, Tiefe, Confidence, geschätzte Unsicherheit und Methode. Bei NoData darf optional trianguliert oder gegen sichtbare Geometrie gepickt werden; der Fallback wird deutlich bezeichnet.

### 4.2 Dichte Punktwolke

Die Fusion prüft Depth-Consistency, Normalen, Reprojection und Sichtbarkeit. Sie arbeitet tiled/out-of-core und erzeugt direkt:

- Position `f64`/tile-relative `f32`, RGB, Normalen,
- Confidence und Anzahl beitragender Bilder,
- Source Camera IDs/kompakte Provenienz,
- optional Klassifikation, Rückprojektionsfehler und Unsicherheit,
- Potree-2-kompatible Laufzeitkacheln plus kanonische Objektblobs.

Einstellungen: Depth-Run, Confidence, Mindestviews, Normalwinkel, Depth-Differenz, Duplikatfusion/Spacing, Farben, Crop/ROI, Klassenmasken. Nachbearbeitung: Auswahl, Confidence-Filter, statistischer Ausreißerfilter, Ground-Klassifikation, manuelle Klassen, smooth als neuer Derived Run.

### 4.3 DEM / DSM / DTM

„DEM“ wird in der UI präzisiert:

- DSM: oberste sichtbare Oberfläche inklusive Vegetation/Gebäude,
- DTM: klassifizierter Boden,
- Custom Elevation Grid: gewählte Klassen/Quelle.

Quellen: dichte Punktwolke, ausgewählte Klassen, Depth Maps, Mesh, importierte Punktwolke oder bestehendes DEM. Parameter: Ziel-CRS, Zellgröße, Extent/Polygon, Höhenaggregation, Interpolation, Breaklines, NoData, Lochfüllung, DTM-Klassifikation, Glättung, Senkenbehandlung, Unsicherheits-/Dichte-Raster.

Interne Darstellung ist eine Quadtree-Rasterpyramide mit tile-local Bounds, Min/Max/NoData/Statistiken und separaten Overviews. Float-Höhen werden verlustfrei oder fehlerbeschränkt mit dokumentierter Toleranz gespeichert. Export: GeoTIFF/BigTIFF und COG mit Overviews, NoData, CRS, Vertical CRS und Metadaten.

### 4.4 Orthomosaik

Quelloberfläche ist explizit ein DEM/DSM/DTM oder Mesh. Das vermeidet, das DEM als zwingenden semantischen Zwischenschritt zu missverstehen: Für flache Luftbilder ist es Standard, für Fassaden/Überhänge wird Mesh-/planare/cylindrische Projektion benötigt.

Parameter:

- Alignment Run, Bildset und Surface Run,
- Projektion/CRS, Auflösung/GSD, Extent/Boundary,
- Bildprioritäten und ausgeschlossene Bilder,
- Sichtbarkeit/Occlusion,
- Blending: Mosaic, weighted average, nearest, custom,
- Seamline-Suche, Ghosting-/Moving-Object-Modus,
- Farb-/Vignettierungs-/Belichtungsabgleich,
- Hole fill/NoData, Alpha, Gutter,
- Ausgabe-Bänder, Datentyp und Kompression.

Seamlines und Patches sind versionierte Vektor-Edits; das Original-Orthomosaik bleibt erhalten. Export: GeoTIFF/COG, BigTIFF, JPEG/PNG plus Worldfile, MBTiles/PMTiles optional nach Lizenz-/Format-ADR.

### 4.5 Gaussian Splat

Der Splat-Run nutzt kalibrierte Kameras, Originalbilder, Masks und optional Sparse/Dense/Depth-Initialisierung. Kernoptionen:

Ein Gaussian Splat ist kein Dreieck und kein einzelner harter 3D-Punkt, sondern
ein kleiner, weicher, transparenter und meist länglicher 3D-Farbfleck. Jeder
Splat speichert mindestens Position, räumliche Größe und Ausrichtung,
Transparenz sowie eine blickrichtungsabhängige Farbe. Beim Rendern werden sehr
viele solcher Ellipsoide in die Kamera projiziert, nach Sichtbarkeit sortiert
und transparent übereinandergelegt. Dadurch lassen sich Blätter, dünne Äste,
Reflexe und feine Oberflächen oft fotorealistischer darstellen als mit einer
gleich großen Punktwolke oder einem groben Mesh.

Das „Training“ geschieht für das konkrete Projekt: PhotoLab startet mit
geschätzten Splats, rendert sie aus den bereits ausgerichteten Aufnahmekameras,
vergleicht die Renderbilder mit den Originalfotos und verändert Position,
Form, Farbe und Transparenz. Nützliche Splats werden geteilt, unnütze entfernt.
Das wird wiederholt, bis die Ansichten gut rekonstruiert werden. Das ist von den
vortrainierten ALIKED-/LightGlue-Gewichten zu unterscheiden. Ein Splat-Run kann
von der Sparse/Dense Cloud initialisiert werden, lernt seine Szene aber neu.

Splats sind deshalb ein **Appearance-Produkt**: visuell sehr stark und schnell
darstellbar, aber ohne harte, geschlossene Oberfläche. Ein scheinbarer Rand
kann aus halbtransparenten Flecken bestehen oder bei einer nie beobachteten
Perspektive „floaten“. Verbindliche Messungen referenzieren daher Depth,
Dense Cloud, Mesh oder DEM; ein Pick im Splat kann diese Geometrie nutzen oder
wird ausdrücklich als approximiert gekennzeichnet.

- Initialization: sparse, dense, depth-fused oder random rescue,
- SH-Grad, Auflösungsschedule, Iterationen/Stopkriterium,
- Densification, pruning, opacity/scale limits,
- Exposure/appearance compensation,
- Depth-, normal- und geometric-consistency regularization,
- Anti-aliasing, sky/dynamic-object masks,
- Blockgröße/Overlap für große Luftbildszenen,
- Multi-GPU-Verteilung und Checkpoints,
- Zielprofil: Highest Visual, Balanced, Web/Low VRAM, Survey Companion.

Große Szenen werden räumlich mit Kamera-Overlap partitioniert, pro Block optimiert und anschließend seamsicher vereinigt. Der Runtime-Output ist ein hierarchischer Splat Tree mit LOD, komprimierten Attributen und tile-local Koordinaten. Der kanonische Trainingscheckpoint bleibt optional erhalten. Exporte müssen ein eigenes Format-ADR bekommen; PLY allein ist kein skalierbares Projektformat.

#### Gerankte Implementierungswege für PhotoLab

1. **Eigener backendneutraler Trainer: portable Vulkan-Compute-Basis plus
   optimierte CUDA-/HIP-Pfade.** Beste Produktlösung: identische Algorithmen,
   Artefakte, Qualitäts- und Recovery-Verträge auf Windows/Linux und AMD/NVIDIA;
   starke Hardware erhält native Optimierungen. Höchster Entwicklungs- und
   Validierungsaufwand. `gsplat` dient als lizenzgeeignete Testreferenz, nicht als
   Datenformat oder alleinige Runtime-Voraussetzung.
2. **Apache-2.0-`gsplat` als isolierter Trainingsworker plus eigener Viewer.**
   Schnellster Weg zu einem qualitativ guten Prototyp und einer Referenz für
   Verlustfunktionen, Densification und Speicherbedarf. Allein nicht das
   Release-Backend, weil PyTorch/Accelerator-Support je Betriebssystem und
   Hersteller nicht symmetrisch ist.
3. **Zwei native Trainer, CUDA für NVIDIA und HIP/ROCm für AMD.** Sehr hohe
   Spitzenleistung, aber doppelte Kernelpflege und kein überzeugender
   Windows-AMD-Pfad. Als spätere Optimierung über demselben Backendvertrag gut,
   als Fundament schlechter als Rang 1.
4. **Reine PyTorch-Implementierung ohne spezialisierte Raster-Kernels.** Gut für
   Forschung und Debugging, aber typischerweise zu langsam, speicherhungrig und
   groß zu paketieren für das Produkt.
5. **Nur Splat-Import und -Viewer, Training extern.** Einfach und robust, erfüllt
   aber den Anspruch eines Metashape-Ersatzes nicht.

Nicht als Produktcode zulässig sind die originale graphdeco-Implementierung
(non-commercial), OpenSplat (AGPL) und LichtFeld Studio (GPL). Neue portable
Vulkan-Forschung wie VkSplat ist technisch interessant, wird aber erst nach
Reproduktions-, Qualitäts- und Lizenzaudit als Algorithmus-/Implementierungskandidat
herangezogen. Die Architekturentscheidung für Rang 1 wird vor Implementierung in
einem ADR fixiert.

## 5. Einheitlicher Viewer

### 5.1 Zentrale Views

- **3D Szene:** Kamerafrusta/Bildrechtecke, Sparse/Dense Clouds, GCPs, DEM-Terrain, drapiertes Orthomosaik, Mesh und Splats gleichzeitig.
- **Karte 2D:** orthographisch, Top-down und rotationsgesperrt; derselbe
  Snap-Gewinner wie 2.5D, aber die Erfassung liefert absichtlich `z: null`.
- **Karte 2.5D:** dieselbe Kamera, Sichtbarkeit und Snap-Rangfolge wie 2D; die
  Erfassung behält die Quellhöhe des Gewinners, wenn vorhanden.
- **Bilder:** Einzelbild, Grid/Filmstrip, Original/Depth/Confidence/Normalen, Marker und Messwerkzeuge.
- **Split:** 3D oder Karte links, Bild rechts für GCP- und Messworkflow.
- **Report:** interaktiver QA-Bericht vor PDF/HTML-Export.

### 5.2 Raster-Streaming

Das vom User beschriebene Nachladen ist eine Multiresolutionspyramide:

- 512×512-Kacheln plus 1–2 Pixel Gutter,
- Quadtree mit Overviews bis eine Kachel die Gesamtfläche abdeckt,
- Screen-space-error-/Texel-Dichte-Auswahl,
- cancellable, priorisierte Requests in Blickrichtung,
- getrennte CPU-, komprimierte und GPU-Texture-Budgets,
- parent tile bleibt sichtbar, bis alle benötigten Kinder bereit sind,
- Prefetch während Zoom/Trägheit, aggressive Abbruchlogik bei Richtungswechsel,
- COG-kompatible Exporte; intern content-addressed Tiles und Manifest, um partielle Updates und ChronoGit zu erhalten.

Im gelockten 2D-View werden Rastertiles direkt auf die Projektebene gezeichnet. Im 3D-View wird das DEM nicht zu einem riesigen statischen Mesh konvertiert: Jede sichtbare Höhenkachel displacet ein wiederverwendbares Grid auf der GPU, mit Skirts/Geomorphing gegen Risse. Orthomosaiktiles werden exakt deckungsgleich darauf drapiert. Ein echtes Textured Mesh ist ein separates Produkt für Überhänge, Fassaden und beliebige 3D-Geometrie.

### 5.3 Gemeinsamer `TiledDataset`-Pfad

Die vorhandenen Verträge sind die richtige Basis, aber noch Skeletons. Benötigt werden:

- echte SSE-/Frustum-Traversierung im `TileStreamingService`,
- faire globale Budgetvergabe und LRU/2Q-Eviction,
- `RasterDataset`, `TerrainDataset`, `MeshDataset`, `SplatDataset`,
- Tile Request Scheduler mit Abbruch, Priorität, Retry und Telemetrie,
- per-tile BVH/Grid/Splat-Index,
- Render-Offset je Tile und exaktes Core-Revalidation-Picking,
- GPU Upload Queue ohne Allokationen im Renderloop.

### 5.4 Unveränderte Builder-Viewportbedienung

PhotoLab verwendet direkt denselben `Viewport`, `CameraController`, Picking-,
Snapping- und Render-Offset-Pfad wie Builder. Es gibt keinen PhotoLab-Fork der
Navigation. Damit gelten insbesondere:

- Z ist immer Up und Orbit bleibt horizon-locked,
- LMB Hold + Drag orbitet, RMB Hold + Drag und MMB/Wheel Hold + Drag pannen,
- das Mausrad zoomt zur aktuellen 3D-Cursorposition als Pivot,
- Cursoranzeige, Picking und Messwerkzeuge liefern weltabsolute `f64`-Koordinaten,
- Space-Cycling, Snap-Prioritäten, View-Framing und Render-Offset-Aufhebung sind
  identisch zu Builder,
- 2D Top-down ist ein gelockter orthographischer Modus desselben Controllers,
  keine zweite inkompatible Kamerasteuerung.

## 6. UX-Layout

### 6.1 App Shell

- oben: Titlebar und einklappbares Ribbon,
- links: `Projekt`-Tree, `Sammlungen`, `Sets` und Suche,
- Mitte: View-Tabs, Scope-Balken und Viewport,
- rechts: `Funktion` und `Eigenschaften`; GCP-Funktion zeigt die relevanten Bilder,
- unten: `Konsole`, `Jobs`, `Genauigkeit`, `Bericht`,
- unten rechts im View: persistente Weltkoordinaten,
- Statusbar: aktiver Run, CRS/Vertical CRS, Renderqualität, RAM/VRAM, Workerzustand.

### 6.2 Ribbon

| Tab | Hauptgruppen |
| --- | --- |
| Projekt | Neu, Öffnen, Speichern, Import/Export, Undo/Redo, Bericht |
| Bilder | Bilder/Ordner, Metadaten, Qualität, Masken, Kalibriergruppen, Sets |
| Referenz | CRS/Transformieren, GCP CSV, Kamera-Referenz, GCP-Projektionen, Scale Bars |
| Ausrichtung | Fotos ausrichten, ausgewählte neu ausrichten, Komponenten, Optimieren, Diagnose |
| Produkte | Depth Maps, Punktwolke, Klassifikation, DEM, Orthomosaik, Mesh, Splat |
| Ansicht | 3D/2D/Bilder/Split, Frame, Kamera, Darstellungsmodi, Performance |
| Automation | Batch/DAG, Profile, Job Queue, CLI/Script, Worker |
| Hilfe | Capture Guide, Diagnosepaket, Dokumentation, Systembericht |

### 6.3 Einstellungen am richtigen Ort

- globale Geräte-/Cache-/UI-Defaults in Preferences,
- fachliche Parameter immer im rechten Function Panel der aktiven Funktion,
- wiederverwendbare Presets pro Funktion,
- Batch referenziert Presets oder friert deren konkrete Werte ein,
- Entity-Properties zeigen gespeicherte Resultatparameter und Provenienz read-only; Änderungen erzeugen einen neuen Run,
- Expertenparameter sind aufklappbar und durchsuchbar, nie in einer separaten unverbundenen Welt.

## 7. Kontextmenüs

### Projekt/Survey

- umbenennen, CRS/Vertical CRS prüfen, transformieren, duplizieren, zusammenführen,
- neues Verarbeitungsset, Batch anwenden, Report, Export, Dateipfad/Provenienz.

### Sammlung/Verarbeitungsset

- Bilder hinzufügen/entfernen, Query bearbeiten, Snapshot einfrieren, duplizieren,
- aktivieren, ausrichten, Batch starten, Differenz zu anderem Set, Exportliste.

### Bild/Kamera

- öffnen, im 3D-View zeigen, Frustum fokussieren, Referenz/Metadaten,
- aktivieren/deaktivieren, Tag/Sammlung/Set, Mask bearbeiten,
- Kalibriergruppe setzen, Alignment reset/neu ausrichten,
- Matches/Tracks/Residuals, Depth Map öffnen, GCP-Projektionen,
- Datei finden, Source Hash prüfen.

### GCP/Checkpoint

- Bilder mit diesem GCP, im Bild/3D fokussieren, Rolle XYZ/XY/Z/Check/Disabled,
- Koordinate/Genauigkeit/CRS ändern, Projektionen prüfen/refinen,
- automatische Projektionen verwerfen, blockierte zeigen,
- Residuen und Run-Vergleich, aus Auswahl optimieren, exportieren, löschen.

### Alignment Run/Sparse Cloud

- aktivieren, vergleichen, Parameter/Report, abhängige Produkte,
- Depth/Punktwolke/Optimierung starten, Komponenten verbinden,
- Matches/Tracks exportieren, duplizieren als neuen Versuch, archivieren.

### Depth/Dense/DEM/Ortho/Mesh/Splat

- aktivieren/sichtbar, fokussieren, Eigenschaften/Provenienz, vergleichen,
- passende Source Runs aktivieren, rebuild mit Parametern,
- spezifische Filter/Edits, Export, Cache prüfen/reparieren, löschen.

### Job

- pausieren, fortsetzen, abbrechen, neu versuchen, ab hier neu starten,
- Ressourcen ändern (soweit checkpointfähig), Log, Output öffnen, Preset speichern.

## 8. Batch Processing

PhotoLab verwendet einen validierten Task-Graph statt nur einer linearen Liste.
Ein Standardgraph beginnt mit bereits konfigurierten, unveränderlichen Inputs:

`Image Snapshot + Reference Snapshot → Quality → Align → GCP Optimize → Depth → Dense → Ground Classify → DEM → Ortho → Splat → Report → Export`

Eigenschaften:

- Set-/Survey-Parameter und explizite Input-Run-Auswahl,
- typisierte symbolische Input-Ports werden vor Queue/Run an genaue,
  versionierte Artefakte gebunden; fehlende oder mehrdeutige Pflichtinputs
  deaktivieren Run,
- Abhängigkeiten, optionale Zweige, Bedingungen und Failure Policy,
- Schema-versioniertes JSON/YAML mit UI-Editor,
- Save/Load, Projektvorlage und CLI-Ausführung,
- konkrete Parameter werden beim Queueing eingefroren,
- nach Run fordert der Executor nie User-Interaktion an; `GCP Optimize`
  verarbeitet nur einen vorher eingefrorenen GCP-Snapshot und öffnet keinen
  Marker-Editor,
- Preflight für RAM/VRAM/Disk/Zeit und Outputgrößen,
- Checkpoint nach jeder Tile-/Subtask-Grenze,
- Pause/Resume/Cancel-Token und Crash-Recovery,
- Cache-Hits sichtbar, kein stilles Reuse inkompatibler Zwischenprodukte,
- Platzhalter wie Projekt, Survey, Set, Kamera, Datum und Run ID für Exportpfade,
- später lokale Netzwerkworker; zuerst robuste Einzelmaschine.

### 8.1 Autosave und Job-Checkpoints

Autosave und Rechen-Checkpoints lösen zwei verschiedene Probleme und sind beide
standardmäßig aktiv:

- **Projekt-Autosave:** Jeder Command wird sofort in ein lokales Write-ahead-
  Journal geschrieben. Nach kurzer Inaktivität und spätestens in einem festen
  Zeitfenster wird ein neues Manifest atomar committed. Tree-Organisation,
  Marker, GCP-Rollen, Einstellungen und Queue-Zustand gehen dadurch auch dann
  nicht verloren, wenn zwischen zwei großen Rechenschritten etwas ausfällt.
- **Job-Checkpoint:** Rechenzustand wird an natürlichen Grenzen persistiert:
  pro Bild, Pair-Block, Depth-Tile, Fusion-/Raster-Tile, Mesh-Partition und beim
  Splat-Training nach einer begrenzten Zahl Iterationen bzw. Zeit. Ein
  mehrstündiger Batch setzt am letzten gültigen Rechenstand fort, nicht nur am
  Anfang seines aktuellen Hauptprodukts.
- **Batch-DAG:** Status, eingefrorener Input-Snapshot, vollständig aufgelöste
  Parameter, Code-/Modell-/Backendversion, Zufallsseed, fertige Knoten und
  Wiederaufnahmeposition werden gemeinsam versioniert.
- **Splat-Checkpoint:** enthält zusätzlich Splat-Parameter, Optimizer-Zustand,
  Iteration, Densification-/Pruning-Phase, Kamera-Exposure und Blockstatus. Nur
  so ist eine echte Fortsetzung statt eines optisch ähnlichen Neustarts möglich.

Ein Checkpoint wird `temp → flush/fsync → Prüfsumme/Validierung → atomarer
Rename → Manifest-Referenz` geschrieben. Ein unvollständiger Temp-Stand wird
nie zum gültigen Ergebnis. Zwei bis drei letzte Checkpoints bleiben innerhalb
eines konfigurierbaren Disk-Budgets erhalten; unreferenzierte Temp-Daten werden
erst im Hintergrund bereinigt. Die UI zeigt „zuletzt sicher gespeichert“,
Checkpointgröße und Wiederaufnahmepunkt. Der User kann **Pausieren** (Checkpoint
erzeugen und stoppen), **Abbrechen und Zwischenstände behalten** oder
**Abbrechen und unreferenzierte Zwischenstände verwerfen** wählen.

### 8.2 Schneller und projektsicherer Abbruch

Beim Klick auf Abbrechen gilt sofort: keine neue Subtask, kein neuer Tile-Read
und kein neuer GPU-Kernel wird mehr gestartet. Ein hierarchisches Cancellation-
Token erreicht DAG, Worker und I/O-Requests. Laufende Arbeit wird absichtlich in
kurzen, begrenzten Einheiten ausgeführt und prüft den Token:

- vor jedem Bild, Paar, Tile und Block,
- in längeren CPU-Loops nach kleinen Chunks,
- zwischen kurzen GPU-Kernel-Starts,
- vor jedem Commit und während chunkbarer I/O.

Zielbudgets sind: UI-Bestätigung unter 100 ms, normales kooperatives Stoppen
meist unter zwei Sekunden und bei laufender GPU-Arbeit spätestens nach dem
kurzen aktuellen Kernel. Ein Treiber kann einen bereits gestarteten Kernel
nicht immer sicher unterbrechen; deshalb verbietet der Backendvertrag
sekunden- oder minutenlange monolithische Kernels. Reagiert ein Worker trotzdem
nicht, beendet der Supervisor nach Timeout ausschließlich diesen isolierten
Worker. Electron, Rust-Core und Projekt bleiben aktiv.

Worker dürfen kanonische Entities nie direkt verändern. Sie schreiben nur in
eine Run-spezifische Temp-Namespace. Erst der Core validiert und committed ein
fertiges Artefakt atomar. Bereits committed Produkte bleiben beim Abbruch
unverändert; ein halbfertiges Produkt erscheint höchstens als klar markierter,
wiederaufnehmbarer Job-Checkpoint und nie als fertige Entity. Damit sind
„schnell abbrechen“ und „Projekt nicht zerstören“ derselbe Architekturvertrag.

### 8.3 Projektöffnung, lokale Arbeitskopie und Sperre

PhotoLab-Projekte sind standardmäßig selbstenthaltend. Beim Bildimport werden
Originalbilder unverändert per Content Hash in den Projekt-Objektstore kopiert.
Identische Dateien werden nur einmal gespeichert. Dateiname, Quellpfad und
Aufnahmeorganisation bleiben Metadaten; die spätere Verarbeitung hängt nicht
mehr vom ursprünglichen Karten-/Serverpfad ab.

Beim Öffnen wird unter dem plattformspezifischen lokalen App-Data-Verzeichnis
eine versteckte Arbeitskopie angelegt, beispielsweise:

`~/.local/share/HimmelCAD/PhotoLab/workspaces/<project-id>/`

Regeln:

- lokale Projekte können den vorhandenen Store direkt nutzen, wenn das sicher
  und performant ist; Server-/Netzwerk-/Archivprojekte werden lokal gespiegelt,
- vor einer Vollspiegelung prüft PhotoLab freien Platz und prognostizierte Größe;
  sehr große unveränderte Blobs dürfen bedarfsgesteuert nachgeladen werden,
  während Manifest, Journal, Indizes und aktive Worksets immer lokal liegen,
- die lokale Kopie ist zugleich Crash-Recovery-Workspace und bleibt nach einem
  Absturz zur Wiederherstellung erhalten,
- ein lokaler Workspace-Lock verhindert doppeltes Öffnen durch dieselbe Maschine.

Für ein schreibend geöffnetes Serverprojekt wird zusätzlich neben dem
Quellprojekt atomar ein versteckter Single-Writer-Lease angelegt. Er enthält
Projekt-ID, User, Host, Prozess, Basisrevision, Startzeit und Heartbeat. Existiert
ein gültiger fremder Lease, öffnet PhotoLab read-only oder wartet nach expliziter
Userentscheidung. Ein abgelaufener Lease darf nur mit Konfliktprüfung übernommen
werden. Vor dem Speichern wird die Basisrevision erneut geprüft; fremde Änderungen
werden niemals überschrieben.

### 8.4 Speichern und Packen

Das kanonische Arbeits-/Serverformat bleibt ein Projekt-Bundle mit Manifest,
Journal und content-addressed Objekten. Speichern synchronisiert nur neue oder
geänderte Objekte und committed das neue Manifest atomar. Das ist auch bei
hunderten Gigabyte oder Terabyte schnell.

Ein komplettes ZIP bei jedem Ctrl+S wäre für große Bild-, Depth- und
Punktwolkendaten nicht skalierbar. Deshalb sind zwei Aktionen getrennt:

- **Speichern:** inkrementeller, konfliktgeprüfter Commit und Sync zum Bundle,
- **Projekt packen / Snapshot exportieren:** portable ZIP64-`.hcadx`-Datei mit
  Fortschritt, freiem-Platz-Preflight, Prüfsummen und atomarem Zielrename.

Wird eine gepackte Datei geöffnet, arbeitet PhotoLab lokal und bietet beim
Speichern entweder ein Projekt-Bundle oder das bewusste erneute Packen als neue
Snapshot-Datei an. Optionale Thin Snapshots dürfen große, bereits auf einem
bekannten Server vorhandene Objekte referenzieren, sind aber klar als nicht
selbstenthaltend markiert.

## 9. Hardware- und Crash-Architektur

### 9.1 Prozessgrenzen

- Electron Renderer: nur UI und Darstellung.
- Rust Core/Sidecar: authoritative state, Commands, Objektstore, Scheduler, CRS-Verträge.
- Compute Supervisor: startet isolierte Worker pro Pipeline/Device, überwacht Heartbeats und OOM.
- CPU Worker: portable Referenzpfade und Fallback.
- GPU Worker: gemeinsamer Compute-Vertrag mit portabler Vulkan-Basis sowie
  optimierten CUDA-/HIP-Pfaden; kein Herstellerbackend bestimmt Datenformat oder
  Scheduler.
- Python/ONNX Worker: optionale Learned Models, niemals zwingend für Projektöffnung oder klassische Pipeline.

Ein Crash oder GPU-Reset beendet höchstens den Worker. Der Scheduler markiert die aktuelle Subtask, reduziert auf Wunsch die Batch-/Tile-Größe und setzt am letzten validen Checkpoint fort.

### 9.2 Hardwareadaptive Budgets

Beim Start misst PhotoLab Geräte, Treiber, RAM, VRAM, freien Diskplatz und einen kurzen sicheren Durchsatzbenchmark. Jede Operation reserviert Tokens für:

- CPU-RAM,
- GPU-VRAM,
- komprimierten/dekodierten Bildcache,
- Disk Scratch,
- Decoder/CPU-Threads,
- GPU Streams/Queues.

Auto-Tuning setzt pro Gerät Batch-, Tile- und Pyramidengrößen. Schwache Hardware erhält kleinere Work Units und weniger Parallelität, nicht einen anderen Algorithmus mit stiller Qualitätsreduktion. Gute Hardware nutzt größere Tiles, parallele GPUs und Pipeline-Overlap. Manuelle Limits bleiben möglich.

Windows und Linux sind ab dem ersten Produktrelease gleichwertige Zielplattformen.
NVIDIA, AMD und CPU-Fallback werden durch dieselben fachlichen Qualitäts- und
Recovery-Gates geprüft; Linux Mint auf dem ThinkBook ist eine primäre reale
Testplattform, keine nachgelagerte Community-Konfiguration. CUDA bleibt ein
hochoptimierter Backendpfad, darf aber weder Datenformat noch Scheduler-ABI
bestimmen. Der Backendvertrag muss mindestens CUDA sowie den gewählten
AMD/Linux-Pfad und portable CPU-Ausführung tragen.

### 9.3 Schutzregeln

- keine globale O(N²)-Paarbildung ohne Pair-Graph/kleines explizites Set,
- nie alle Vollbilder, Depth Maps oder Punkte gleichzeitig resident,
- Disk- und Speicher-Preflight plus Reserve für OS/Renderer,
- OOM-Probe vor großem Run; adaptive Halbierung mit unterer Grenze,
- persistente Zwischenprodukte mit Hash aus Inputs, Parametern, Code-/Modellversion,
- atomare Tile Writes, Checksums, temp → fsync → rename,
- hierarchischer Cancel-Token, bounded Kernels/Subtasks und Worker-Kill als
  isolierte Eskalationsstufe,
- thermisches/Power-Limit nur als Userprofil, nicht als pauschale Drosselung.

## 10. Datenmodell und Commands

Neue Kern-Entities:

- `Survey`, `ImageCollection`, `ProcessingSet`, `CameraSource`, `ImageSource`,
- `CameraCalibrationGroup`, `CameraPoseSet`, `FeatureSet`, `MatchGraph`, `TrackSet`,
- `AlignmentRun`, `SparsePointCloud`, `ControlPointSet`, `MarkerObservationSet`,
- `DepthImageSet`, `DensePointCloud`, `ElevationRaster`, `Orthomosaic`,
- `Mesh`, `TexturedMesh`, `GaussianSplatCloud`, `ProcessingGraph`, `ProcessingRun`, `AccuracyReport`.

Wichtige Commands:

- `ImportImages`, `OrganizeImages`, `CreateProcessingSet`, `FreezeProcessingSet`,
- `ConfigureCoordinateTransform`, `TransformCameraReferences`, `AttachGridResource`,
- `RunImageQuality`, `RunAlignment`, `ResetCameraAlignment`, `MergeAlignmentRuns`,
- `ImportControlPoints`, `SetControlPointRole`, `SetMarkerObservation`, `BlockMarkerObservation`,
- `OptimizeAlignment`, `CreateCheckpointSplit`,
- `BuildDepthImages`, `FuseDensePointCloud`, `ClassifyGround`, `BuildElevationRaster`,
- `BuildOrthomosaic`, `EditSeamline`, `BuildMesh`, `TrainGaussianSplats`,
- `CreateProcessingGraph`, `QueueProcessingRun`, `CancelProcessingRun`, `ExportEntity`.

Jeder Run speichert Input-Entity-Versionen, Auswahl-Snapshot, Parameter, Seed, Backend/Device, Software-/Modellversion, Dauer, Peak-Ressourcen, Logs, Output-Hashes und QA.

## 11. Implementierungsphasen

1. **Foundation:** Produkt-App, Entity-/Run-/Command-Modell, Scheduler, Bildimport, Metadaten, Projektmigration.
2. **CRS/Reference:** PROJ-Sidecar, Transformationswizard, Grid Registry, Vertical CRS, GCP-CSV, Golden Tests.
3. **Viewer:** Kamera-/Bildlayer, echte Streaming Engine, Raster/DEM Terrain, 2D Map, Image/Depth View.
4. **Alignment MVP:** Quality Hybrid aus ALIKED/LightGlue und SIFT, Pairing,
   getrennte Verifikation/Track-Fusion, Dense Rescue, incremental/global SfM,
   BA, Sparse View und Diagnose.
5. **GCP/QA:** Projektionen, Rollen XYZ/XY/Z/Check, Optimierung, Accuracy Tab, Reports.
6. **Depth/Dense:** PatchMatch MVS, Tile Pipeline, Fusion, Potree-Streaming, Confidence.
7. **DEM/Ortho:** Ground Classification, Rasterisierung, Pyramiden, Seamlines, COG Export.
8. **Mesh/Splat:** tiled Mesh/Terrain-Vertrag, Splat Training, Hierarchie/LOD und Viewer.
9. **Automation:** DAG Batch, Presets, CLI, Resume/Recovery, Performance-Tuning.
10. **Professional Hardening:** Multi-camera/multispectral, rolling shutter/rigs, distributed optional, umfangreiche Benchmarks und Visual Regression.

Kein Meilenstein gilt als fertig, solange seine Ergebnisse nicht in PhotoLab viewbar, exportierbar, reproduzierbar, abbrechbar und nach Crash fortsetzbar sind.

## 12. Qualitäts- und Performance-Gates

- SfM: öffentlich verfügbare Benchmarks plus eigene UAV-/Smartphone-/Fassaden-Datensätze; registrierte Kameras, Pose Error, Completeness, Runtime, Peak RAM/VRAM.
- Metashape-Nichtunterlegenheit: identische unveränderte Inputs werden automatisiert
  in der jeweils aktuellen freigegebenen Metashape-Version und PhotoLab gerechnet.
  Release-Gates vergleichen registrierte Kameras, korrekte Komponenten, Pose- und
  Reprojektionsfehler, GCP-/Checkpoint-RMSE, Trackabdeckung und katastrophale
  Fehlregistrierungen. Kein einzelner öffentlicher Pair-Benchmark und keine
  Gewichtsgröße beweist Metashape-Parität.
- GCP: synthetische Netze und reale Checkpoints; Komponentenmaskierung XY/Z, Kovarianz, robuste Ausreißer, Cross-Validation.
- MVS: Depth Accuracy/Completeness, Point-to-reference, Kanten, schwache Textur, Runtime.
- DEM/Ortho: GSD, Höhen-RMSE, NoData, Seam-Ghosting, Radiometrie, COG/GeoTIFF-Validierung.
- CRS: authoritative Testpunkte, Hin-/Rückweg, Grid-/Epoch-/Axis-Fehler, keine Ballpark-Fallbacks.
- Viewer: konstante Framezeit, Zoom-Thrash, Tile-Cancel, VRAM-Limit, Mischszene aller sechs Produkte.
- Recovery: Prozesskill, GPU OOM, voller Datenträger, beschädigte Tile, Resume und klare Handlungsempfehlung.
- Performance-Regressionsgrenze: >10 % nur dokumentiert und begründet.

## 13. Was aus Metashape übernommen und verbessert wird

Übernehmen:

- vollständiger Alignment → Reference/GCP → Optimize → Depth/Dense → DEM/Ortho/Mesh-Workflow,
- mehrere Resultatinstanzen, Marker-Guidance, Control/Check Points,
- Camera Calibration Groups, Masks, Regions, Depth-Reuse,
- Batch, Reports, Point Classification, Seamline-/DEM-Editing,
- 3D-, Ortho- und Photo-Views.

Verbessern:

- explizite Run-Provenienz statt „aktives Asset“ und Chunk-Zustand,
- Scope immer sichtbar und Accuracy nie kontextlos,
- konkrete Parameter statt nur Qualitätsnamen,
- CRS-/Grid-Operationen prüfbar, versioniert und ohne stillen Ballpark,
- echte task-/tile-basierte Crash-Recovery,
- gemeinsamer schneller Viewer für Point/Raster/Mesh/Splat,
- Gaussian Splat als First-Class Product,
- Hardware-Autotuning ohne pauschale Low-End-Bremse,
- moderne Matching-Backends als benchmarkbare Plugins statt Marketing-Automatik.

### 13.1 Fachfunktionen, die nicht vergessen werden dürfen

Diese Funktionen gehören zur annähernden Metashape-Parität, auch wenn nicht alle V1 blockieren:

- Keep Key Points und inkrementelles Hinzufügen neuer Bilder ohne vollständige Neuberechnung,
- Pair-Match-/Connectivity-Ansicht und Component-Reparatur,
- automatische und manuelle Masken pro Verarbeitungsstufe,
- Calibration Groups, Distortion-/Residual-/Correlation-Plots und Vignetting,
- Rolling Shutter, GNSS-/INS-Lever-Arm, Boresight und Bias,
- Coded Targets (einschließlich AprilTags), nicht codierte Targets und Scale Bars,
- Shapes, Breaklines, Konturen, Profile, Fläche und Volumen,
- Dense-Confidence, Ground- und Multiclass-Klassifikation,
- Color Calibration, Contribution Map, Seamline/Patch/Fill,
- Multikamera-Rigs, Fisheye, sphärische Kameras, Multispektral/Thermal, Reflectance Calibration und Rasterformeln,
- Mesh-Textur, Tiled Mesh, Panorama, Camera Track/Flythrough,
- LiDAR-/Punktwolken-Fusion als geteilter Builder-Pfad,
- HTML/PDF-Verarbeitungsbericht und headless CLI/API.

### 13.2 Dependency-/Lizenz-Vorauswahl

| Kandidat | Lizenzlage | Konzeptentscheidung |
| --- | --- | --- |
| PROJ | MIT; Grids separat | verwenden, Grid Registry/Audit |
| GDAL | MIT-Kern; optionale Treiber separat | nur kuratierter Build |
| OpenCV ≥4.5 | Apache-2.0; Codecgraph separat | geeigneter Kandidat |
| COLMAP/GLOMAP | BSD-3; transitive Optionen separat | selektiver Sidecar/Referenz, kein ungeprüfter Vollbuild |
| PoseLib | BSD-3 | geeigneter Solver-/RANSAC-Kandidat |
| Ceres | BSD-3; SuiteSparse/CXSparse-Optionen problematisch | nur ohne GPL/LGPL-Solver, sonst eigener Solverpfad |
| ALIKED | BSD-3 | moderner Defaultkandidat |
| LightGlue | Apache-2.0 Code/geeignete gebündelte Weights | Defaultmatcher nach Version-Audit |
| RoMa | MIT-Code/-Modelle; DINO-Teil separat auditieren | Dense-Rescue-Kandidat, vollständiges Offline-Paket |
| SuperPoint | restriktive Referenz-/Weight-Lage | nicht mitliefern |
| ONNX Runtime | MIT; Provider separat | optionaler Model Worker |
| OpenMVS | AGPL | verboten |
| Exiv2 | GPL | verboten |
| DUSt3R/MASt3R | CC BY-NC-SA | verboten |
| originale graphdeco-3DGS-Codebasis | non-commercial | Algorithmus aus Papers, Code nicht übernehmen |
| gsplat | Apache-2.0 | bevorzugt evaluieren; Third Parties auditieren |

Bei ML-Komponenten werden Paper/Algorithmus, Implementierung, Gewichte und Trainingsdaten als vier getrennte Lizenz-/Provenienzobjekte geprüft.

## 14. Bestätigte Product-Owner-Entscheidungen

1. Windows und Linux sowie NVIDIA, AMD und CPU-Fallback sind zum ersten Release
   fachlich gleichwertig; Linux Mint auf dem ThinkBook ist primäre Testplattform.
2. Textured Mesh ist ein offiziell beworbenes sechstes Hauptprodukt.
3. Alle freigegebenen Matching-Gewichte werden nach Lizenz-, Trainingsdaten- und
   Supply-Chain-Audit vollständig offline ausgeliefert. Das vollständige Paket
   darf mehrere GiB umfassen; PhotoLab benötigt weder beim ersten Start noch zur
   Rescue-Eskalation Internetzugriff. Quality Hybrid rechnet ALIKED und SIFT auf
   allen Kandidatenpaaren und ist Release-Default; große Backends werden
   qualitätsgesteuert ergänzt. Maximum Robustness erweitert Pair Graph und
   Modell-/Featurebudgets und führt DeDoDe-v2-G auf allen Kandidatenpaaren aus.
   Detector-L-v2, Descriptor-G und DINOv2 ViT-L/14 sind bytegenau gepinnt; die
   Inferenz ist blockweise, checkpointbar und auf CPU/CUDA fachlich identisch.
4. V1 exportiert LAS/LAZ, E57, GeoTIFF/COG, OBJ/glTF, PLY/SPZ und `.hcadx`;
   3D Tiles folgt danach.
5. Lokale Netzwerk-/Clusterverarbeitung folgt erst nach der stabilen
   Single-Workstation-Pipeline.
6. Lokale metrische Projekte ohne CRS sind First-Class gemäß ADR 0023.
7. IO-Provider, interaktive Import-Registrierung und der nach Start
   unbeaufsichtigte Batch sind getrennte Lebenszyklen gemäß ADR 0021.
8. 2D und 2.5D teilen Kamera, Sichtbarkeit und Snap-Gewinner gemäß ADR 0022.
9. Plan ist Excalidraw-first; DWG nutzt den beschlossenen `acadrust`-Fork und
   SLPK/I3S bleibt Provider des gemeinsamen Renderers.
10. Python-/Agent-Automation folgt der Capability- und Journalgrenze aus ADR
    0024.

## 15. Quellenbasis (Auswahl)

- Agisoft Metashape Professional 2.3 User Manual (2026): https://www.agisoft.com/pdf/metashape-pro_2_3_en.pdf
- Agisoft GCP/Checkpoint Workflow: https://agisoft.freshdesk.com/support/solutions/articles/31000154132-control-and-check-points-for-aerial-surveys
- PROJ Resources and Grids: https://proj.org/en/stable/resource_files.html
- PROJ Operation Selection / `projinfo`: https://proj.org/en/stable/apps/projinfo.html
- PROJ Vertical Grid Shift: https://proj.org/en/stable/operations/transformations/vgridshift.html
- GDAL Cloud Optimized GeoTIFF: https://gdal.org/en/stable/drivers/raster/cog.html
- Original 3D Gaussian Splatting: https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/
- VastGaussian (CVPR 2024): https://doi.org/10.1109/CVPR52733.2024.00494
- HUG (ICCV 2025): https://openaccess.thecvf.com/content/ICCV2025/papers/Su_HUG_Hierarchical_Urban_Gaussian_Splatting_with_Block-Based_Reconstruction_for_Large-Scale_ICCV_2025_paper.pdf
- RUBIK Image Matching Benchmark (CVPR 2025): https://openaccess.thecvf.com/content/CVPR2025/papers/Loiseau_RUBIK_A_Structured_Benchmark_for_Image_Matching_across_Geometric_Challenges_CVPR_2025_paper.pdf
- GLOMAP (ECCV 2024): https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/5646_ECCV_2024_paper.php
- LightGlue (ICCV 2023): https://openaccess.thecvf.com/content/ICCV2023/html/Lindenberger_LightGlue_Local_Feature_Matching_at_Light_Speed_ICCV_2023_paper.html
- Glue Factory Benchmarks: https://github.com/cvg/glue-factory
- ALIKED: https://github.com/Shiaoming/ALIKED
- DeDoDe v2 (CVPRW 2024): https://openaccess.thecvf.com/content/CVPR2024W/IMW/papers/Edstedt_DeDoDe_v2_Analyzing_and_Improving_the_DeDoDe_Keypoint_Detector_CVPRW_2024_paper.pdf
- RoMa (CVPR 2024): https://github.com/Parskatt/RoMa
- Rotation Steerers (CVPR 2024): https://openaccess.thecvf.com/content/CVPR2024/papers/Bokman_Steerers_A_Framework_for_Rotation_Equivariant_Keypoint_Descriptors_CVPR_2024_paper.pdf
- COLMAP Pixelwise View Selection MVS: https://www.microsoft.com/en-us/research/?p=610152
- ACMM MVS (CVPR 2019): https://openaccess.thecvf.com/content_CVPR_2019/html/Xu_Multi-Scale_Geometric_Consistency_Guided_Multi-View_Stereo_CVPR_2019_paper.html
- gsplat (Apache-2.0): https://github.com/nerfstudio-project/gsplat
- Lokale Bachelorarbeit: `photolab/Bachelorarbeit Florian Fischer - Titelblätter Ausgebessert.pdf`
