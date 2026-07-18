# Viewer completion milestones

Status: verbindlicher Ausführungs- und Messplan ab 2026-07-18.  
Architekturautorität: ADR 0016, ADR 0017, ADR 0018 und ADR 0019.  
Scope: gemeinsamer Rust/wgpu-Viewer-Kernel und `@himmelcad/viewer`; keine
produktspezifische Builder-/PhotoLab-/WeltView-UI.

## Zielzustand

Der Viewer gilt als **app-ready fertig**, wenn er alle kanonischen Entities und
ihre vorbereiteten Large-Geometry-Repräsentationen in einem gemeinsamen View
darstellt, die vollständigen Darstellungs-, Navigations-, Auswahl-, Mess-,
Clip-, Schnitt- und Transformverträge erfüllt, auf WebGPU und WebGL2 dieselbe
Engine nutzt, seine Qualität an die tatsächlich verfügbare Hardware anpasst und
die unten definierten Real-/Scale-Gates besteht. Danach darf für die drei Apps
nur noch Lifecycle-, Command- und UI-Verdrahtung fehlen; kein App-Adapter darf
Geometrie neu interpretieren oder einen eigenen Renderer benötigen.

Foundation A bleibt während aller Meilensteine permanentes Regression-Gate.
Ein Meilenstein ist erst abgeschlossen, wenn **alle** Muss-Kriterien und Gates
belegt sind. Teilimplementierung, ein grüner Mock oder ein dokumentierter
Fallback zählen nicht als Abschluss.

## Statusübersicht

| ID | Meilenstein | Status | Start | Abschluss | Aktive Zeit |
| --- | --- | --- | --- | --- | --- |
| A | Foundation A | abgeschlossen | historisch, nicht exakt erfasst | 2026-07-17 | nicht rückwirkend erfunden |
| V1 | Imaging und Heavy-Geometry-Verträge | abgeschlossen | 2026-07-18 07:21 CEST | 2026-07-18 11:33 CEST | 4 h 12 min verstrichene Arbeitszeit |
| V2 | Kanonische Entity- und Definitionsbreite | aktiv | 2026-07-18 11:33 CEST | – | läuft |
| V3 | Darstellung, Interaktion, Messung und Schnitte | offen | – | – | – |
| V4 | Civil-Scale, Hardware und Backend-Härtung | offen | – | – | – |
| V5 | Stabile Viewer-Fassade und App-Ready-Gate | offen | – | – | – |

## V1 – Imaging und Heavy-Geometry-Verträge

V1 beseitigt alle parallelen oder unvollständigen Datenbedeutungen zwischen
kanonischem Raster, Worker-Decoding, Streaming, GPU-Upload und Picking.

### Muss-Umfang

- Ein einziger versionierter Prepared-Raster-Tile-Vertrag wird von
  Decode-Worker und Render-Host verwendet. Er trägt dieselben kanonischen
  Dimensionen, Pixelzentrumregeln, Mapping-, Depth-, Validity-, Confidence- und
  Connectivity-Semantiken wie `RasterImageGeometry`.
- OrthoGrid-, Planar- und Camera-Mappings werden ohne stilles Umdeuten
  unterstützt. Planare U/V-Frames, Homographie sowie die starre
  Camera-to-Entity-Local-Pose werden exakt validiert.
- `ElevationZ`, `OpticalAxisDepth` und `RayDistance` werden nur in geometrisch
  definierten Kombinationen akzeptiert. Equirectangular, Pinhole und
  namespaced Camera Extensions dürfen keine erratene Projektion erzeugen.
- Farbband, Depth, Validity, Confidence und Connectivity sind immutable,
  content-addressed und atomar resident. Confidence verändert Gültigkeit nie
  implizit; Connectivity entscheidet gemeinsam über Anzeige und Picking.
- Kontinuierliche Raster, PixelSteps und explizite Zwei-Bit-Dreiecksmasken
  behalten ihre Diskontinuitäten über Tilegrenzen. Die horizontale
  Panorama-Naht besitzt exakt definierte Zellen; Pole werden nicht verbunden.
- Panorama besitzt genau eine Standpunkt-/Pose- und eine Depth-Autorität. Ein
  verknüpfter Scan bzw. eine Standpunktpunktwolke bleibt Relation, nicht zweite
  Geometriewahrheit.
- Im gemeinsamen 3D-View ist ein Panorama standardmäßig ein pickbarer
  Scanstandpunkt-Marker und ein orientiertes Kamerabild eine posegenaue
  Bildfläche bzw. ein Frustum. Ihre Depth-Daten werden dort nicht ungefragt als
  vollständige Kugel-/Ray-Oberfläche dargestellt. Eine solche
  Analysepräsentation ist ein expliziter View-Modus.
- Orthomosaike mit Depth/Elevation werden dagegen als pyramidal gestreamte,
  texturierte Oberfläche dargestellt: top-down wie ein Orthofoto und im
  Orbit-View wie ein texturiertes DGM mit derselben Source-Geometrie.
- Prepared Pointcloud-, Mesh/TIN-, Raster- und Splat-Inhalte teilen Hierarchie,
  Scheduler, Residency-Budgets, Placement, Clip-, Pick- und Unload-Lifecycle.
- Große Texturen und Rasterseitenbänder werden budgetiert; kein vollständiges
  Orthomosaik oder DGM darf als Runtime-Voraussetzung im RAM/GPU-Speicher liegen.
- Source-Koordinaten bleiben für Pick, Messung und Clip maßgeblich;
  Floating-Origin und Überhöhung bleiben reine Render-/Presentation-Schritte.

### Abschluss-Gates

- Rust-Contract-/Validation-/Decode-/Picking-Tests für jedes Mapping, jede
  Depth-Semantik und jede Connectivity-Art, einschließlich negativer Fälle.
- Worker-Artefakt-Hash und Version verhindern alte, manipulierte oder
  semantisch abweichende Payloads vor Veröffentlichung.
- Browser-Gate auf WebGPU und erzwungenem WebGL2 mit Ortho-DGM,
  depth-texturiertem Raster, messbarem Panorama, Punktwolke, Mesh und Splat in
  derselben Szene; Pick und Clip müssen Source-Koordinaten bestätigen.
- Ein realer E57-/Panorama- sowie ein GeoTIFF-/Orthomosaik-Providerpfad
  veröffentlicht denselben Vertrag atomar.
- Residency-Diagnostik beweist vollständiges Unload und keine unbudgetierten
  Textur-/Seitenbandallokationen.

## V2 – Kanonische Entity- und Definitionsbreite

V2 schließt den darstellbaren Katalog, ohne für jede Dateiquelle neue
Viewer-Entities zu erfinden.

### Muss-Umfang

- Punkte mit optionaler Höhe, Linien, Polylinien, Kreise, Bögen, Ellipsen,
  Kegelschnitte, zusammengesetzte Kurven, Splines und Klothoiden.
- Flächen mit Außenring und Löchern/Inseln; gemischte XY/XYZ-Stützpunkte bleiben
  kanonische Vermessungsgeometrie. Eine Höhenauflösungs-Anweisung ist keine
  Viewer-Eigenschaft der Fläche.
- Entities mit mindestens einem höhenlosen Stützpunkt sind reguläre
  2D-/Plan-Geometrie: Sie erscheinen im
  locked Top-down-View vollständig, im 3D-Orbit standardmäßig überhaupt nicht.
  Der Viewer darf weder unbekanntes Z erfinden noch nur bekannte Teilsegmente
  als scheinbar vollständige Entity zeigen.
- Höhenauflösung ist eine spätere CAD-Command-Funktion, keine live abgeleitete
  Viewer-Darstellung. Projektion auf ein DGM, Ebene oder einen versionierten
  Interpolator schreibt eine neue kanonische Revision mit tatsächlichen
  Z-Werten und nötigen echten Stützpunkten; erst diese materialisierte
  XYZ-Geometrie ist 3D-fähig. Zielversion und Resolverparameter dürfen als
  Provenienz erhalten bleiben. Undo stellt die vorherige Revision wieder her.
- Ebenen, 2.5D-TIN/Grid-DGMs, beliebige 3D-Oberflächen, offene Meshes,
  geschlossene Solids, BRep-/CSG-/Extrusion-/Sweep-Repräsentationen und deren
  immutable ausgewertete Meshes.
- Civil-Achsen mit horizontaler Geometrie, Gradiente, Stationierung,
  Breitenband, Rampen-/Querneigungsband und Böschungsregeln.
- Rasterbilder, Punktwolken, Gaussian Splats, Panoramen, allgemeine 3D-Objekte
  und BIM-Objekte mit getrennter Klassifikation und Geometrierepräsentation.
- Blockdefinitionen, verschachtelte Definitionen, Instanzen, Member-Placement,
  Stil-/Attributvererbung und Zyklus-/Versionsprüfung ohne Vertexkopien je
  Instanz.
- Texte, Beschriftungen und Bemaßungen mit content-addressed Font-/Style-
  Ressourcen und assoziativen, versionsgeprüften Ankern.
- Materialtabellen, Texturen, Sampler, Alpha-/Culling-Regeln, zusätzliche
  authored UV-Sets, Hatch- und Linetype-Ressourcen ohne App-spezifische Shapes.
- Extension-Geometrie bleibt roundtripfähig und wird nur mit registriertem
  Resolver dargestellt; unbekannte Payloads werden nie still interpretiert.

### Abschluss-Gates

- Ein kanonischer Entity-Zoo enthält jede Variante und wird auf WebGPU und
  WebGL2 gemeinsam dargestellt, gepickt, geclippt, versteckt und entladen.
- Canonical-Hash-, Admission-, Definition-/Resource- und Roundtrip-Tests decken
  positive sowie manipulierte Referenzen ab.
- Repräsentations- und Providerwechsel ersetzen atomar denselben stabilen
  Entity-Slot; keine doppelte sichtbare Wahrheit bleibt zurück.
- Reale IFC-, DXF-, LandXML-/Civil- und glTF/3D-Tiles-Fixtures belegen die
  Viewer-Verträge. Dateiformat-Zoobreite, die keine neue Viewer-Semantik
  enthält, blockiert V2 nicht und bleibt Provider-Conformance.

### Implementierungs-Audit 2026-07-18

Der Code-Audit gegen den Muss-Umfang unterscheidet bereits vorhandene Breite
von echten V2-Lücken:

- Vorhanden und zu erhalten sind stabile kanonische Entity-/Revisionshüllen,
  optionale Z-Werte, alle derzeit deklarierten Built-in-Typen, analytische
  Kreis-/Bogen-/Ellipsen-, rational-quadratische Kegelschnitt-, Spline-,
  Klothoiden- und Composite-Kurven, Area-Ringe mit Löchern und assoziativen
  Kurven, TIN/Grid/Surface/Solid-Repräsentationen,
  Alignment-Bänder und Böschungsresultate, Raster/Pointcloud/Splat/Panorama,
  Text/Label/Dimension, content-addressed Präsentationsressourcen,
  versionsgeprüfte Blockdefinitionen einschließlich Verschachtelungszyklen und
  registrierte Extension-Evaluationsmeshes.
- Der erste V2-Slice schließt die aktive Invariantenverletzung:
  `AreaGeometry` und Viewer/WASM besitzen keinen Height-Resolver mehr. Mixed-Z
  ist nur über eine explizite locked-plan-Präsentation kompilierbar; eine
  eigenständige materialisierte XYZ-Revision ersetzt denselben stabilen Slot für
  3D.
- Der zweite V2-Slice ergänzt `ConicArc` als exakten rational-quadratischen
  Kegelschnitt. Positive Kontrollgewichte unter, gleich und über eins bilden
  elliptische, parabolische und hyperbolische Bögen im kanonischen Rust-Vertrag
  ab; Bindings, adaptive Tessellation und analytische Source-Snaps teilen diesen
  Typ auf WebGPU und WebGL2.
- Reale verbleibende Schema-Lücken sind mehrere authored UV-Sets für
  Inline-Meshes sowie ein typisierter Vererbungs-/Override-Vertrag für
  Blockinstanz-Attribute und -Stile statt eines opaken Override-Hashes.
- Reale verbleibende Gate-Lücken sind die Aufnahme jeder vorhandenen
  Kurvenvariante und Plane-/Definition-Variante in den gemeinsamen Browser-Zoo,
  manipulierte Referenzfälle für die neuen Breiten und der vollständige
  Viewer-Nachweis der bereits vorhandenen realen DXF-, IFC- und LandXML-Pfade.
- Zusätzliche Formatkorpora ohne neue Geometriesemantik bleiben gemäß V2-Gate
  Provider-Conformance und werden nicht als Viewer-Schemaarbeit vorgezogen.

## V3 – Darstellung, Interaktion, Messung und Schnitte

V3 macht aus vollständiger Geometrie einen vollständigen CAD-View.

### Muss-Umfang

- Gemeinsame Farb-, Opacity-, Visibility-, Selection-, Hover-, Height-Ramp-,
  Vertical-Exaggeration-, Texture-, Vector-, Hatch-, Linetype- und
  entity-spezifische Darstellung ohne Mutation der Source-Geometrie.
- Orbit, Pan und Cursor-Pivot-Zoom; 3D, locked Top-down 2D, lokale
  orthographische Schnitt-/Profilframes und benutzerdefinierte perspektivische
  Standpunkte mit nahtlosen, maßstabserhaltenden Übergängen.
- Ein Klick auf einen Scanstandpunkt öffnet einen separaten Panorama-View mit
  360-Grad-Schwenken und FOV-Zoom. Ein Klick auf ein orientiertes Kamerabild
  öffnet einen 2D-Bildview mit Pan/Zoom. Beide Views teilen Kernel, Ressourcen,
  Source-Koordinaten und Picking; sie sind keine neuen Renderer.
- Bildmessung bildet Pixel über Validity/Confidence, Depth-Semantik,
  Kameramodell und Pose auf Source-3D-Punkte ab. Punktkoordinaten und Strecken
  zwischen mindestens zwei Bildpicks werden ohne GPU-Depth als Wahrheit
  berechnet.
- Cursor liefert überall eine belastbare nächste Source-Koordinate oder einen
  klar gekennzeichneten Ebenen-Fallback. Tab zyklisiert deterministisch durch
  nahe Treffer aller Provider.
- Top-down-Picking höhenloser Stützpunkte liefert `z: null`; eine für Rasterung
  oder Kamera notwendige Präsentationsebene wird nie als gemessene Source-Höhe
  ausgegeben. Die normale 3D-Darstellung besitzt keinen temporären Drape-,
  Interpolations- oder Arbeitsebenen-Ersatz für unvollständige Z-Werte.
- Kanonische CAD-Stützpunkte, End-/Mittel-/Zentrum-/Quadrant-/Schnittpunkte und
  Providerpunkte; keine Tessellations-Fake-Vertices als CAD-Snaps.
- Auswahl, Hover, Point-Picking und Messung teilen ID-/Depth- und exakte
  CPU-Refinement-Verträge. Schreibende Befehle revalidieren Version und
  Geometrieziel.
- Clip-Box, freie Clip-Volumen, Ausschnittsbox, Schnitte mit Tiefe,
  partitionsexakte Schnittgeometrie und Schraffur von geschnittenen
  Material-/Wandschichten.
- Translation-Preview, Commit, Undo/Redo und Placement für inline wie gestreamte
  Entities ohne Reload residenter Daten; abgeleitete Geometrie wird atomar
  aktualisiert.
- Transparenz nutzt bestmögliche Hardwarepfade und einen expliziten
  qualitätsreduzierten Downlevel-Pfad, ohne Opaque/Pick/Clip-Semantik zu ändern.

### Abschluss-Gates

- Deterministische Rust-/TS-Tests für Navigation, Snap-Ranking, Tab-Zyklus,
  Transformjournal, Clip-/Schnitt-Topologie und Source-vs-Display-Koordinaten.
- Visuelle WebGPU-/WebGL2-Paritätsszenen für alle Darstellungsmodi und
  Entity-Familien; Screenshots ergänzen, ersetzen aber keine Koordinatentests.
- Exakte Schnitte über mehrere Streaming-Partitionen sowie Reload/Cancel/Stale-
  Generation-Gates ohne teilweise veröffentlichte Ergebnisse.
- Schnelle Orbit-/Zoom-Interaktion während Streaming und kontrollierter
  Hintergrundarbeit ohne globale O(N)-Arbeit im Frame.

## V4 – Civil-Scale, Hardware und Backend-Härtung

V4 belegt, dass der vollständige Viewer nicht nur mit kleinen Testdaten
funktioniert.

### Muss-Umfang

- Eine gemeinsame Civil-Szene aus mehreren hundert Millionen Pointcloud-
  Punkten, einem DGM/3D-Mesh mit sehr hoher Dreieckszahl, pyramidalem
  Orthomosaik, CAD, Raster und Splats wird out-of-core navigiert.
- Hierarchie, LOD/SSE, Occlusion/Frustum, Request-/Decode-/Upload-Budgets,
  Residency und Eviction bleiben global koordiniert und providerneutral.
- Hardwarekalibrierung setzt getrennte Idle-/Interaction-Ceilings für Detail,
  RenderScale, Upload, Requests, Worker, MSAA und Transparenz. Schwache Hardware
  begrenzt starke Hardware nicht.
- Schnelles Zoomen, Pannen und Orbiten wird als Interaktions-Trace gemessen;
  Durchschnittswerte allein reichen nicht, Max-/Perzentil-Spikes und Abstürze
  werden ausgewiesen.
- WebGPU und WebGL2 nutzen denselben Rust-Core. Electron auf Linux, Windows und
  macOS besitzt keine alternative Renderlogik. Browser bleibt ein echtes Gate.
- Mobile/WebView-Limits werden als eigene Policy/Profile getestet; sie dürfen
  Desktop-Budgets und Desktop-Features nicht deckeln.
- Device loss, Context loss, Out-of-memory-Nähe, Abbruch, Netzwerkfehler und
  wiederholtes Load/Unload hinterlassen einen wiederherstellbaren Viewer.

### Abschluss-Gates

- Häufiges Low-/Mixed-Smoke-Gate und bewusst seltene, checksum-gepinnte reale
  Large-/Sustained-Gates; Billion-Point- oder vergleichbare Läufe erfolgen nur
  an Meilenstein- bzw. Release-Grenzen.
- Dokumentierte Mainstream- und High-End-Latenzen mit unveränderten
  Passkriterien; kein Hochsetzen von Budgets, um Regressionen grün zu färben.
- Physische integrierte GPU plus mindestens eine diskrete GPU; WebGPU,
  erzwungenes WebGL2 und Desktop-Host. Mobile sustained darf nur dann als
  separates Rest-Risiko stehen, wenn Portierbarkeit und kurze Gates grün sind.
- Speicherplateau- und vollständige Eviction-/Reload-Nachweise für lange
  Navigationssequenzen.

## V5 – Stabile Viewer-Fassade und App-Ready-Gate

V5 friert den konsumierbaren Viewer-Vertrag ein und beweist, dass keine App
einen eigenen Geometriepfad benötigt.

### Muss-Umfang

- Eine dokumentierte, stabile Package-Fassade für Create/Dispose, Kamera,
  Navigation, Laden/Entladen, Visibility, Style, Selection, Picking,
  Measurement, Clip/Schnitt, Transformcommands, Events und Diagnostics.
- Kanonische Inline-Entities sowie Potree, prepared Mesh/TIN, Raster, Splat,
  Panorama, BIM/Solid und registrierte Extensions werden über denselben
  Entity-/Representation-Lifecycle angebunden.
- Asynchrone Operationen besitzen Abort, Fortschritt, Generation/Version und
  atomaren Commit. Fehler sind typisiert und lassen keine halb-residenten
  Entities zurück.
- Rust/WASM/TypeScript-Bindings sind generiert und driftgeprüft. Die Fassade
  enthält keine Electron-, React- oder produktspezifische Abhängigkeit.
- Builder, PhotoLab und WeltView benötigen anschließend ausschließlich dünne
  Adapter für Dokumentcommands, URL/Resource-Zugriff und UI-State.
- API-, Architektur-, Datenformat-, Verifikations- und Integrationsdokumente
  stimmen mit dem implementierten Stand überein; geparkte Provider-Zoofälle
  sind klar von Viewer-Lücken getrennt.

### Abschluss-Gates

- Ein headless Package-Consumer und minimale Browser-/Electron-Testhosts laden
  dieselbe Mixed Scene ausschließlich über die öffentliche Fassade.
- Vollständige Core/Render/IO/WASM/Viewer-Suites, Binding-/Typecheck-Gates,
  WebGPU/WebGL2, Real-Data-Visuals und V4-Scale-Gates sind grün.
- Öffentliche API-Surface wird gegen unbeabsichtigte Änderung geprüft;
  Lifecycle-/Abort-/Unload-Tests zeigen keine Handles, Worker oder GPU-Owner
  nach Dispose.
- Abschlussbericht listet Gate, Datensatz, Hardware, Backend, Messwerte,
  bekannte nicht-blockierende Provider-Conformance und die verbleibende reine
  App-Verdrahtung. Erst dann lautet der Status **Viewer app-ready fertig**.

## Zeitmessung und Fortschrittsprotokoll

Zeit wird nicht geschätzt oder nachträglich rekonstruiert:

- `aktive Zeit` umfasst Implementierung, lokale Analyse sowie Build-/Testwartezeit
  während eines laufenden Arbeitsintervalls;
- Pausen durch User-Unterbrechung, Nutzungslimit oder fehlende externe Hardware
  werden als Intervallende protokolliert und nicht addiert;
- `Kalenderdauer` wird zusätzlich aus erstem Start und endgültigem Abschluss
  ausgewiesen;
- jeder Abschluss nennt Commit(s), Gates und reale Messwerte;
- ein Meilensteinstatus wird nur in derselben Änderung auf `abgeschlossen`
  gesetzt, in der auch sein Abschlussnachweis eingetragen wird.

### Arbeitsintervalle

| Meilenstein | Start | Ende | Aktive Dauer | Anlass/Ergebnis |
| --- | --- | --- | --- | --- |
| V1 | 2026-07-18 07:21 CEST | läuft | läuft | Prepared Raster/Depth-Vertrag und Q11 |

### Abschlussnachweise

| Meilenstein | Commit(s) | Gates und Messwerte | Aktive Zeit | Kalenderdauer |
| --- | --- | --- | --- | --- |
| A | siehe `docs/VIEWER-VERIFICATION.md` | Foundation-A-Gates | nicht rückwirkend messbar | nicht rückwirkend messbar |
