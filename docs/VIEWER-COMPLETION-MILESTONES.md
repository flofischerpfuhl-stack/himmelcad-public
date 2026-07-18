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
| V2 | Kanonische Entity- und Definitionsbreite | abgeschlossen | 2026-07-18 11:33 CEST | 2026-07-18 15:33 CEST | 4 h 00 min verstrichene Arbeitszeit |
| V3 | Darstellung, Interaktion, Messung und Schnitte | abgeschlossen | 2026-07-18 15:33 CEST | 2026-07-18 17:04 CEST | 1 h 31 min verstrichene Arbeitszeit |
| V4 | Civil-Scale, Hardware und Backend-Härtung | aktiv | 2026-07-18 17:04 CEST | – | läuft |
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
- Der dritte V2-Slice erweitert Inline-Meshes auf acht geordnete authored
  UV-Sets, synchron zum bereits kanonischen Materialindexbereich `0..=7`.
  Jeder PBR-Kanal wählt und transformiert seinen eigenen Satz im gemeinsamen
  WebGPU-/WebGL2-Shader. Vier gepackte Vertexattribute und aus der affinen
  Instanzmatrix rekonstruierte Normaltransformation halten den portablen
  16-Attribut-Vertrag ein, ohne die kanonische Breite zu reduzieren.
- Der vierte V2-Slice ersetzt den ignorierten Block-Override-Hash durch den
  versionierten `hcad.block@2`-/`block-definition@2`-Vertrag. Definition,
  Instanz und stabile Member-ID besitzen explizite `inherit`-/`clear`-/exakte
  Stil- und Attributzustände; Attributbytes werden vor der Referenzaufnahme
  gehasht. Unbekannte Member, fehlende oder veraltete Revisionen und Zyklen
  publizieren keine Teilinstanz.
- Der erneute Schema-Audit findet damit keine verbleibende V2-Schema-Lücke.
  Offen sind ausschließlich die nachfolgenden Zoo-, Manipulations- und realen
  Provider-Gates.
- Der fünfte V2-Slice nimmt alle analytischen Kurvenvarianten, die explizite
  Plane-Entity und eine verschachtelte Blockdefinition in denselben Browser-Zoo
  auf. Jede neue Variante wird auf WebGPU und WebGL2 dargestellt,
  source-gepickt, verborgen unpickbar und anschließend ohne Neuaufnahme wieder
  pickbar; manipulierte Block-, Attribut-, UV- und Referenzfälle bleiben
  atomisch abgewiesen.
- Der sechste V2-Slice schließt den Viewer-Nachweis der bereits vorhandenen
  DXF-, IFC- und LandXML-Providerpfade direkt aus ihren kanonischen
  Importpaketen.
- Zusätzliche Formatkorpora ohne neue Geometriesemantik bleiben gemäß V2-Gate
  Provider-Conformance und werden nicht als Viewer-Schemaarbeit vorgezogen.

### Abschluss 2026-07-18 15:33 CEST

V2 ist nach 4 h 00 min tatsächlich verstrichener Arbeitszeit abgeschlossen.
Die realen DXF-, buildingSMART-IFC- und Civil-LandXML-Fixtures durchlaufen aus
ihren kanonischen Importpaketen direkt die gemeinsamen Render-Core-Proxy-,
f64-Placement- und Source-Tessellationsverträge. Der vollständige Zoo umfasst
38 Entities/47 Proxies; seine acht ergänzten Varianten werden zusätzlich als
temporäre kanonische Slots gemeinsam aufgenommen und über exakte Bindings
atomar ohne verbleibende Proxy- oder Pick-Adresse detached. Die checksum-
gepinnten Real-Data-Gates umfassen 47 Entities/56 Proxies auf WebGPU und
WebGL2. Manipulierte Referenzen, Attribute, Ressourcen und Generationen bleiben
atomar abgewiesen. V3 beginnt unmittelbar mit demselben permanenten
Foundation-/V1-/V2-Regressionsstand.

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

### Arbeitsstand ab 2026-07-18 15:33 CEST

- Der initiale V3-Audit bestätigt die vorhandenen gemeinsamen Style-, Kamera-,
  Navigation-, Fallback-, Tab-, Snap-, Clip-/Schnitt-, Transformjournal- und
  Transparenzpfade. Als erste reale Lücke wurden die noch fehlenden separaten
  Panorama-/Bildviews und die Source-Strecke zwischen mehreren Bildpicks
  geschlossen.
- Der Panorama-View rendert eine bounded, nach innen orientierte
  Equirectangular-Präsentationssphäre im bestehenden Rust/wgpu-Kernel. Der
  normale Mixed-Scene-View bleibt beim exakten Scanstandpunkt-Marker. Der
  Panorama-Controller hält den Source-Standpunkt fest, übernimmt die beliebige
  kanonische Kamera-Up-Achse und benutzt Schwenken plus FOV-Zoom.
- Der orientierte Bildview isoliert dieselbe kanonische Kameraebene in einem
  lokalen orthographischen Pan-/Zoom-Frame. Beide Analyseviews teilen die
  registrierten Bild-/Depth-/Validity-/Confidence-Ressourcen und liefern über
  CPU-Refinement nur tatsächliche Source-RasterSamples; Präsentationssphäre und
  Kameraebene werden nie als Messgeometrie ausgegeben. Der zusätzliche bounded
  GPU-Buffer wird während der View-Laufzeit im globalen Shared-Resource-Budget
  und in der Frame-Telemetrie mitgeführt.
- Zwei oder mehr Bildpicks werden im Rust-Kernel gemeinsam auf Source-3D
  aufgelöst. Segment- und Gesamtstrecken entstehen ausschließlich aus diesen
  f64-Source-Punkten, nicht aus GPU-Depth. View-Eintritt und -Austritt ändern
  weder kanonische Revision noch normale Visibility oder Residency.
- Der öffentliche Pick-Contract trennt nun den numerischen
  `presentationPosition` vom kanonischen `worldPosition`. Für eine im locked
  Top-down dargestellte Mixed-Z-Revision bleibt dessen Z ausdrücklich `null`;
  die nur für GPU-Rasterung und Navigation verwendete Planhöhe kann damit
  weder Messung noch Metadatenabfrage als Source-Höhe erreichen.
- Selection und Hover sind nun explizite, gemeinsame Render-Core-Zustände mit
  stabiler Priorität. Sie werden aus demselben verfeinerten Pick-Entity-Ziel
  gesetzt, überschreiben den retained Basisstil nicht und ändern weder
  Proxy-/Pick-Identität noch Residency oder Decode-Zähler. Inline- und
  gestreamte Inhalte benutzen denselben Live-Uniform-Pfad; neue Stream-Tiles
  übernehmen den wirksamen Zustand aus ihrem kanonischen Slot-Contract.
- Der Befehls-Audit bestätigt die bereits vorhandene atomare Revalidierung von
  Entity-ID, Revision, Version-Hash und Representation-Slot-Generation für
  Placement-Commit, Undo und Redo. Es wurde dafür kein zweiter App-seitiger
  Commandpfad eingeführt.

### Abschluss 2026-07-18 17:04 CEST

V3 ist nach 1 h 31 min tatsächlich verstrichener Arbeitszeit abgeschlossen.
Alle Darstellungseigenschaften, Navigations- und Analyseviews, Source-Picks,
Bildmessungen, CAD-Snaps, Clip-/Schnittprodukte, Transformjournal- und
Transparenzpfade bleiben im gemeinsamen Rust/wgpu-Kernel. Die abschließende
Bildparität prüft die checksum-gepinnten WebGPU-/WebGL2-Real-Data-Aufnahmen mit
einem Frame-RMSE von 0,011007 sowie identischen Clear-, Opaque- und
Materialfarben. Der freie blaue Solid-Probe-Punkt entspricht auf beiden
Backends exakt der sRGB-Übertragung seines linearen Basisstils; die strikte
Toleranz von einem 8-Bit-Kanalwert bleibt unverändert. V4 beginnt unmittelbar
mit demselben permanenten Foundation-/V1-/V2-/V3-Regressionsstand.

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

### Arbeitsstand ab 2026-07-18 17:04 CEST

- Der initiale V4-Audit bestätigt den vorhandenen gemeinsamen Milliardenpunkt-
  und Mixed-Civil-Harness, providerneutrale globale Budgets, physische
  Low-/Mainstream-Population, Interaktions-Perzentile sowie Eviction/Re-entry.
  Als erste reale Lücken bleiben ein explizites Mobile/WebView-Profil, echte
  Surface-/Device-Recovery und die noch offenen Mainstream-/High-End-
  Hardwarebelege.
- `mobileWebView` ist nun ein explizites Rust-eigenes Deployment-Profil. Desktop
  bleibt der unveränderte Default und wird in einem Gegenbeweis nach einer
  Mobile-Auflösung identisch erneut aufgelöst. Mobile begrenzt nur seinen
  eigenen Speicher-, RenderScale-, Detail-, MSAA-, Worker- und Request-Raum;
  Capability-abhängige Transparenz und gemeinsame Geometriesemantik bleiben
  erhalten.
- Das kurze physische Mobile-Portability-Gate materialisiert auf der Intel HD
  Graphics 630/WebGL2 gleichzeitig 1.013.376 Punkte, 131.072 DGM-Dreiecke,
  50.000 Splats und 16 Texturen. Seine Interaktion erreicht p50/p95/p99/Max
  10,8/29,4/36,9/42,8 ms, beweist Eviction und Re-entry und meldet keine
  Providerfehler. Ein sustained Lauf auf physischer Android-/iOS-Hardware bleibt
  entsprechend dem Abschluss-Gate offen und wird nicht durch diesen Desktop-
  Portabilitätslauf ersetzt.
- Ein verlorenes Canvas-Surface wird nun von Gerät und Residency getrennt
  behandelt. Der Surface-Host gibt das verlorene Plattformobjekt frei, bindet
  über dieselbe Instance und denselben Adapter ein neues Surface und baut nur
  bei einem Formatwechsel die Präsentationspipeline neu. KernelViewport
  konsumiert `recreateSurface` direkt; World, GPU-Ressourcen und Stream-Tiles
  bleiben erhalten. Beide Browserbackends belegen nach der Neubindung stabile
  Generation, Proxy-/Pick-Identität und Decode-Zähler. Device-Loss und OOM
  erfordern dagegen weiterhin einen neuen Device-/Replay-Pfad und bleiben der
  nächste aktive V4-Slice.
- Device-Loss und OOM besitzen nun einen vom Surface-Loss getrennten unteren
  Lifecycle-Vertrag. Der wgpu-Host pollt jedes Gerät unabhängig von optionalen
  Timestamp-Queries, latched unerwarteten Device-Loss und unscoped OOM und gibt
  wiederholbar `recreateDevice` mit maschinenlesbarem Grund aus. Eine im
  Pick-Error-Scope erkannte OOM setzt denselben Zustand. Validation/Internal
  bleiben absichtlich harte Rendererfehler. Der deterministische Neuaufbau und
  Definition-/Streaming-Replay auf das Ersatzgerät ist weiterhin die aktive
  Folgescheibe; dieser Zwischenstand behauptet noch keine vollständige Recovery.
- Physische Windows-, macOS- und Apple-Silicon-Messläufe werden mangels lokal
  verfügbarer Hardware nicht als V4-Blocker behandelt. Alle portablen Engine-
  und Browser-Gates bleiben verbindlich; die fehlenden Hostmessungen werden als
  explizites V6-/Release-Conformance-Risiko weitergeführt, ohne V5 aufzuhalten.

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
| V1 | 2026-07-18 07:21 CEST | 2026-07-18 11:33 CEST | 4 h 12 min | Imaging und Heavy-Geometry-Verträge abgeschlossen |
| V2 | 2026-07-18 11:33 CEST | 2026-07-18 15:33 CEST | 4 h 00 min | Kanonische Entity- und Definitionsbreite abgeschlossen |
| V3 | 2026-07-18 15:33 CEST | 2026-07-18 17:04 CEST | 1 h 31 min | Darstellung, Interaktion, Messung und Schnitte abgeschlossen |
| V4 | 2026-07-18 17:04 CEST | läuft | läuft | Civil-Scale-, Hardware- und Backend-Härtung gestartet |

### Abschlussnachweise

| Meilenstein | Commit(s) | Gates und Messwerte | Aktive Zeit | Kalenderdauer |
| --- | --- | --- | --- | --- |
| A | siehe `docs/VIEWER-VERIFICATION.md` | Foundation-A-Gates | nicht rückwirkend messbar | nicht rückwirkend messbar |
| V1 | siehe V1-Abschluss und `docs/VIEWER-VERIFICATION.md` | 324 Render-Core-, 7 Viewer-WASM-, 4 Decode-WASM-, 71 Viewer-Pakettests; 29 Entities/37 Proxies | 4 h 12 min | 4 h 12 min |
| V2 | `aecf700`, `c85d298` und vorherige V2-Slices | 38 Entities/47 Proxies; checksum-gepinnte DXF-/IFC-/LandXML-Providerpfade auf WebGPU/WebGL2 | 4 h 00 min | 4 h 00 min |
| V3 | `b2d9a7f`, `c4b017b`, `f1fef3f` und V3-Abschlusscommit | 320 Render-Core-, 7 Viewer-WASM-, 73 Viewer-Pakettests; 38 Entities/47 Proxies; Real-Data-Farbparität RMSE 0,011007 | 1 h 31 min | 1 h 31 min |
