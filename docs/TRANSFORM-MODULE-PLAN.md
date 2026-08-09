# Transformationsmodul für Punkte (Plan)

**Branch:** `grok/pipeline-and-transform`  
**Status:** Design + **v1 implementiert** (siehe `docs/TRANSFORM-MODULE-REPORT.md`)  
**Ziel:** Ein wiederverwendbares, auditierbares Transformationsmodul, das **Punkte** transformiert und damit **jeden Geometrietyp** bedient (Punktwolken, Vertex-Listen, Polyline-Stützpunkte, Mesh-Vertices, Raster-Anker/Georeferenz, GCP, Kamerazentren, …).

---

## 1. Problem & Prinzip

### 1.1 Kernidee

> **Alles, was transformiert wird, ist eine Punktmenge (oder abgeleitete Parameter einer Punktmenge).**  
> Dateitypen sind nur *Adapter*: Sie extrahieren Punkte, rufen das Modul, schreiben Punkte zurück (oder bauen daraus abgeleitete Produkte neu).

| Eingangstyp | Was wird transformiert? | Nacharbeit |
|-------------|-------------------------|------------|
| Punktwolke (LAS/LAZ/E57/PLY/Potree) | Jeder Punkt (XYZ, optional Attribute) | Bounds, Index, Octree neu |
| DGM / Raster (GeoTIFF) | Georeferenz + optional Resampling der Samples | Geotransform / VRT, ggf. Warp |
| 3D-Mesh / glTF / prepared mesh | Vertices (Normalen ggf. rotieren) | Bounds, Tiles |
| Polylinie / Polygon / CAD-Kurve | Stützpunkte | Länge/Segmentierung invalidieren |
| GCP / Kontrollpunkte | Punktkoordinaten | Residuen neu berechnen |
| Kameras / Pose | Projektionszentren + Orientierung (über 3D-Trafo) | Re-export COLMAP etc. |
| Orthophoto | Nur Georeferenz **oder** voller Warp | abhängig von Modus |

### 1.2 Was das Modul *nicht* ist

- Kein Dateiformat-Monolith („LAS-Trafo“, „DXF-Trafo“ als getrennte Engines).
- Kein stilles Baken von CRS ohne Audit-Record (siehe bestehende `FrozenImportTransformation` in `photolab_crs.rs`).
- Keine Viewer-only-Matrix, die Projektdaten „optisch“ verschiebt, ohne Produkt zu invalidieren.

### 1.3 Bestehende Bausteine im Repo (nicht neu erfinden)

| Baustein | Rolle |
|----------|--------|
| `himmelcad-core::photolab_crs` | Explizite Horizontal/Vertikal-Entscheidung, Grid-Nachweis, Ballpark-Policy, **Frozen**-Audit |
| `himmelcad-sidecar::crs_runtime` | PROJ/EPSG offline, Pipeline-Selektion |
| Vendor PROJ + proj-data (NTv2, Geoid-TIFFs, …) | Ausführung geodätischer Ops |
| Product lineage (ADR 0012) | Transform = neuer Produkt-Schritt / invalidiert Downstream |
| Design-System Import-UI | Twin-Blöcke Höhe / Lage (links Quelle, rechts Ziel) |

Das neue Modul **erweitert** das: von „Import-CRS-Entscheidung“ zu einem **allgemeinen `CoordinateTransform`**, der auch empirische (identische Punkte, ICP, Baustellenkalibrierung) und manuelle Trafo abdeckt.

---

## 2. Architektur

### 2.1 Schichten

```
┌─────────────────────────────────────────────────────────────┐
│ Product-hosted interactive registration / Align review      │
│  - Mode: getrennt Lage+Höhe | gemeinsame 3D | Hybrid        │
│  - Pick-UI: gemeinsame Punkte, visueller Manipulator        │
└──────────────────────────┬──────────────────────────────────┘
                           │ TransformSpec (serialisierbar)
┌──────────────────────────▼──────────────────────────────────┐
│ himmelcad-core: TransformSpec / ResidualReport / Audit      │
│  - reine Datenmodelle, Validierung, Hash, Freeze            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ himmelcad-sidecar: transform_runtime                        │
│  - PROJ pipelines (Lage, Höhe, compound)                    │
│  - empirische Fit-Solver (Helmert/Affine/TPS/…)             │
│  - ICP/GICP-Fine-Registration (Punktwolken)                 │
│  - Expliziter Site-Cal-Text/JSON-Reader; opaque .dc failt   │
│  - apply_stream: f64 XYZ in/out, batch, cancel, checkpoint  │
└──────────────────────────┬──────────────────────────────────┘
                           │ PointStream API
┌──────────────────────────▼──────────────────────────────────┐
│ Adapters (pro Format / Produkt)                             │
│  las_adapter | mesh_adapter | vector_adapter | raster_georef│
│  photolab_product_adapter | gcp_adapter | camera_pose_adapter│
└─────────────────────────────────────────────────────────────┘
```

Der interaktive Pre-Commit-Lifecycle ist in ADR 0025 festgelegt. Ein
unbeaufsichtigter Executor ist ein separater Consumer: Er erhält nur eine
bereits eingefrorene `TransformSpec` und darf weder Pick-UI öffnen noch einen
`NeedsUserInput`-Zustand erzeugen. Siehe ADR 0021.

### 2.2 Zentrale API (Skizze)

```rust
/// Stable public contract – pure geometry, no file I/O.
trait PointTransform {
    fn transform_point(&self, p: [f64; 3]) -> Result<[f64; 3], TransformError>;
    fn transform_points_batch(&self, pts: &mut [[f64; 3]]) -> Result<(), TransformError>;
    /// Optional: rotate free vectors (normals, camera axes) without translation.
    fn transform_direction(&self, v: [f64; 3]) -> Result<[f64; 3], TransformError>;
    fn inverse(&self) -> Option<Box<dyn PointTransform>>; // only if bijective / documented
    fn domain_hint(&self) -> Option<BoundingBox3>; // for grid coverage checks
}

/// Serializable recipe that can be frozen into project audit.
struct TransformSpec { /* see §3 */ }

/// Built, ready-to-run pipeline (may hold PROJ context, grids, matrices).
struct CompiledTransform { /* implements PointTransform */ }
```

**Invariante:** Intern und an der API immer **float64** Weltkoordinaten (vgl. Dense-f32-Bug). Float32 nur als Storage-Codec nach bewusster Offset/Scale-Quantisierung (LAS-Style).

### 2.3 `TransformSpec` – logische Struktur

```
TransformSpec
├── schema_version
├── composition_mode: SeparateHorizontalVertical | Joint3D | HybridCascade
├── horizontal?: HorizontalOp
├── vertical?: VerticalOp
├── joint?: JointOp          // 3D Helmert, oblique plane, ICP residual, site cal
├── domain: AreaOfInterest + optional height range
├── residual_policy: max_rms, max_residual, outlier_rule
└── audit: source_crs?, target_crs?, grids[], epochs, solver_meta, user_confirmations
```

Komposition (wichtig):

1. **Separate (klassisch geodätisch):** zuerst Lage, dann Höhe (oder umgekehrt – **explizit wählbar**, Default dokumentieren: typisch *horizontal then vertical* in projected frame, oder *geocentric compound* wenn PROJ-Compound-CRS).
2. **Joint 3D:** eine 3D-Ähnlichkeits-/Affine-/Freeform-Trafo in kartesischen XYZ.
3. **HybridCascade:** z. B. PROJ-Datum → dann lokale Site-Cal → dann optional ICP-Feinjustage. Reihenfolge ist Teil des Frozen-Records.

---

## 3. Transformationsarten im Detail

### 3.1 Einstieg: „Getrennt vs. gemeinsam?“

Dein Vorschlag ist **richtig und sollte der erste Wizard-Schritt** sein:

| Modus | Wann | Ergebnis |
|-------|------|----------|
| **Getrennt Lage + Höhe** | Unterschiedliche Vertikaldatums, Geoid, NTv2, klassische Kataster-Workflows | Zwei Ops + klare Residuen pro Komponente |
| **Gemeinsame 3D** | Baustellenlokal ↔ Geodätisch, Schrägebene, Scan-zu-Scan, „passt optisch“ | Eine 3D-Trafo (ggf. + nichtlineare Nachbarschaft) |
| **Hybrid** | Erst geodätisch „in die Nähe“, dann lokal einpassen | Cascade, jede Stufe auditierbar |

UI: Radio am Anfang, danach nur die relevanten Panels.

---

### 3.2 Höhentransformation

#### A) Ellipsoid ↔ Geoid / Orthometrisch / Normalhöhe

| Aspekt | Plan |
|--------|------|
| UX | Quelle/Ziel-Vertikalreferenz wählen (EPSG/WKT2) + **Geoid-/Vertikalgrid-Datei** (oder proj-data Name) |
| Engine | PROJ `vgridshift` / compound CRS (`EPSG:xxxx+yyyy`) / Geodetic TIFF grids (GTG) |
| Grids | `.tif` (bevorzugt, GTG), legacy `.gtx`; DE: z. B. GCG2016 über proj-data / BKG |
| Audit | Grid-Dateiname, SHA-256, Coverage, PROJ-Pipeline-String, Genauigkeitshinweis |
| Fehlerfälle | Punkt außerhalb Grid → fail / clamp / null-flag (Policy, Default: **fail hard** für Survey) |

**Hinweis:** „Einfach Quelle und Ziel“ funktioniert nur, wenn PROJ eine Pipeline **mit verfügbarem Grid** finden kann. Ohne Grid: keine stille Ballpark-Höhe (passt zu `ALLOW_BALLPARK=NO` Default).

#### B) Height Offset (konstant)

| Aspekt | Plan |
|--------|------|
| Eingabe | Manueller Δh **oder** aus 1…n Identpunkten (Median/Mean/LS) |
| 2-Punkte-UI | Sinnvoll als *Check*, nicht als einziger Fit: bei 2 Punkten Δh₁≠Δh₂ → Neigung/Restklaffung anzeigen |
| Besser | ≥3 Höhenkontrollen → konstanter Offset **oder** geneigte Ebene (3 Param) |

#### C) Höhe aus geneigter Ebene / Schräge

Wenn Lage und Höhe gekoppelt auf schräger Baustellenebene liegen:

- Fit einer Ebene \(h = a + b\,E + c\,N\) (oder 3D-Ebene) aus Identpunkten  
- Oder als Teil der Joint-3D-Trafo (Helmert 7P enthält bereits „Schräge“ über Rotation)

#### D) Geoid-Undulation manuell (seltener)

Tabelle/CSV Undulation pro Punkt – eher Import-Hilfe, nicht Kernpfad.

---

### 3.3 Lagetrafo (2D im Projektionssystem)

#### A) Über PROJ / „pyproj“

| Korrektur | Im Produkt **PROJ nativ im Sidecar** (Rust), nicht Python-pyproj in der Hot Path. pyproj nur ggf. für Dev-Scripts. |
|-----------|------------------------------------------------------------------------------------------------------------------|
| Inhalt | EPSG/WKT2/PROJJSON Quelle→Ziel, Epoch für dynamische Frames, Area of Interest |
| Policy | `ONLY_BEST`, `ALLOW_BALLPARK`, explizite Operation wählen (wie `ImportTransformationDecision`) |
| GK/DHDN | **Pflicht** explizites NTv2/GTG (bereits im Code angedacht) |

#### B) NTv2 / GTG Horizontalgrids

- Formate: `.gsb` (NTv2), `.tif` (GTG)  
- Ops: PROJ `hgridshift` / `gridshift`  
- UI: Grid auswählen, Coverage-Map, Testpunkte mit Soll-Ist  
- Optional: **Grid aus Identpunkten erzeugen** (offline Tool, später) – nicht V1

#### C) Identische Punkte (empirisch, 2D)

Wizard erzeugt **temporären Dual-View** (Bestand + Import) → User pickt Korrespondenzen (Snap an Vertices/GCP/Cloud).

| Modell | Min. Punkte | Parameter | Use-case |
|--------|-------------|-----------|----------|
| **Translation only** | 1 | 2 | grobe Verschiebung |
| **Rigid 2D** (Verschiebung + Drehung) | 2 | 3 | Passpunkte ohne Maßstab |
| **Helmert 2D / Similarity** (V+D+Maßstab) | 2 | 4 | klassische Einpassung |
| **Affine 2D** | 3 | 6 | verzerrte Scans, ungleicher Maßstab E/N |
| **Projektive 2D** | 4 | 8 | eher Photogrammetrie-Bild, selten für Kataster |
| **Nachbarschaftstreu** (TPS / Multiquadrik / IDW der Residuen) | ≥4–6, besser flächig | frei | lokale Deformation, „passt an allen Passpunkten“ |

**Solver-Details (V1 prioritisiert):**

1. Weighted least squares, optionale robuste Verlustfunktion (Huber/Tukey)  
2. Residuen-Report: pro Punkt dE, dN, dH, RMS, max, χ²  
3. Ausreißer-Flagging + „Punkt deaktivieren“  
4. Konfidenzellipse / Maßstabs-σ wenn n groß genug  

**Korrektur zu „zwei Punkte“:**  
Zwei Punkte reichen für Rigid/Helmert-2D, **nicht** für Affine und **nicht** für sinnvolle Nachbarschaft. UI muss Modell-Mindestanzahl erzwingen und „2 Punkte = nur Similarity/Rigid“ klar machen.

#### D) Visuell verschieben/drehen (Lage)

- Gizmo im Dual-View: translate + rotate (+ optional scale)  
- Ergebnis = dieselbe `Similarity2D` wie aus 2 Punkten, nur interaktiv initialisiert  
- Danach optional „auf Identpunkte snappen / residual fit“

---

### 3.4 Kombinierte / 3D-Transformation

#### A) 3D Similarity (Helmert 7-Parameter)

- 3 Translation + 3 Rotation + 1 Maßstab  
- Min. **3 nicht-kollineare** Identpunkte (besser ≥4–6)  
- Standard für: GNSS-Ellipsoid → lokales Baustellennetz (wenn Kalibrierung parametrisch)

Varianten:

- **6P rigid** (Maßstab = 1)  
- **7P** mit Maßstab  
- Optional **gewichtete Höhe** (Lage-σ ≠ Höhen-σ) – in der Praxis sehr wichtig

#### B) 3D Affine (12 Parameter)

- Mehr Freiheitsgrade, braucht ≥4 Punkte gut verteilt  
- Risiko: Scherung/„Gummi“ – nur mit Warnung und Residuen

#### C) Einpassen auf schräger Ebene

Zwei sinnvolle Interpretationen (UI trennen!):

1. **Passpunkte auf geneigter Baustelle** → 7P Helmert (bevorzugt)  
2. **2.5D:** Lage-Helmert + Höhen-Ebene \(h(E,N)\)  
3. **Plane-to-plane:** Normalen aus beiden Wolken schätzen, Rotation um Kippachse + Translation (Sonderfall Scan)

#### D) Visuell 3D + ICP / Fine Registration

Pipeline:

```
1. Grobe Trafo (manuell / 3+ Klicks / vorhandene CRS)
2. Optional downsample (voxel) beider Wolken
3. Fine: Point-to-Plane ICP oder GICP / VGICP
4. Optional Colored-ICP wenn RGB dicht und beleuchtungsstabil
5. Residual cloud + RMSE; User Accept → freeze TransformSpec
```

**Empfehlung Algorithmus (Stand 2025/26, praxisnah):**

| Situation | Erste Wahl | Alternative |
|-----------|------------|-------------|
| CAD/Mesh vs. Scan, gute Init | **Point-to-Plane ICP** | GICP |
| Zwei dichte TLS/Photo-Clouds | **GICP** oder **Voxel-GICP (VGICP)** | NDT |
| Mit Farbe, flache Fassaden | Colored ICP (Park2017) | — |
| Schlechte Init, große Rotation | FPFH+RANSAC (global) → dann ICP | TEASER++ (wenn wir Dependency wollen) |
| Sehr große Wolken | Voxel-Downsample + multi-scale ICP | Chunked / tiled |

ICP ist **kein** Ersatz für geodätische Datumstransformation; er minimiert lokale geometrische Distanz und kann systematische Maßstabs-/Netzfehler „wegbügeln“. Im Audit: `kind=icp_refinement`, RMSE, Overlap, Iterationen.

#### E) Baustellenkalibrierung (Site Calibration)

**Ziel:** Transformation zwischen **geodätischem/globalem** System (typ. GNSS/ETRS) und **lokalem Baustellennetz** (NEE / „Ground“).

Typischer Inhalt einer Site Cal (Trimble-Logik, vereinfacht):

1. Horizontal: oft **lokale Similarity** (Origin, Rotation, optional Scale) auf projected/ground  
2. Vertical: Geoid **oder** geneigte Ebene / Inclined plane aus Passpunkten  
3. Gebunden an Projektion/Datum des Jobs  

**Dateiformate (Recherche):**

| Format | Rolle | Open Source? |
|--------|--------|--------------|
| **`.dc`** | Trimble Data Collector Job/Calibration-Export (Access/Siteworks) | **Nein** – proprietär; Parser oft reverse-engineered / Drittlizenzen |
| **`.cal`** | Machine-Control-Variante derselben Kalibrierinfo; WorksManager konvertiert .dc ↔ .cal | **Nein** – proprietär |
| **JobXML / `.jxl`** | XML-Job inkl. Coordinate System / Calibration – besser dokumentiert als Binär-.dc | Semi-dokumentiert, immer noch Trimble-spezifisch |
| **`.ggf` / `.dgf` / `.sgf`** | Trimble Geoid/Datum/Shift grids (nicht dasselbe wie PROJ GTG) | Proprietär |

**Korrektur zu „.dx“:**  
In der Trimble-Welt ist das übliche Paar **`.dc` / `.cal`**, nicht „.dx“. (Falls mit **Leica `.lok` / DBX** oder generischem DXF verwechselt: anderes Ökosystem.) Es gibt **kein** sauberes öffentliches ISO-„Open-Site-Cal“-Format von Trimble.

**Unsere Strategie:**

1. **V1 intern:** eigenes kanonisches `SiteCalibration` JSON/CBOR im Projekt (Helmert + Vertikalmodell + CRS-Endpunkte + Residuen + Passpunkt-IDs).  
2. **Import-Adapter (später, optional):**  
   - JobXML best-effort  
   - .dc/.cal nur wenn spezifizierbarer Teil reverse-engineered **oder** User exportiert Parameter als CSV/WKT aus TBC  
3. **Export:** immer unser kanonisches Format + optional PROJ-Pipeline-String wenn abbildbar  
4. **Nicht** so tun, als wäre .cal „opensource“ – UI-Text: „proprietäres Trimble-Format, Import best-effort / manuell“

---

## 4. Wiederverwendung über Dateitypen (Adapter-Vertrag)

### 4.1 `GeometryPointSource` / `GeometryPointSink`

```text
extract_points(entity) -> PointBatch { xyz: f64, optional attrs, topology handles }
apply_points(entity, PointBatch) -> Entity'
```

- **Topologie erhalten:** Polyline-Konnektivität, Face-Indices – nur XYZ ändern  
- **Attribute:** Intensität/RGB bleiben; Normalen mit `transform_direction`  
- **Raster:** zwei Pfade  
  - *Metadata-only:* affine Geotransform anpassen (nur wenn Trafo affine im Kartenraum ist)  
  - *Warp:* volle Resampling-Pipeline (GDAL), teuer, cancelbar  

### 4.2 Streaming & Performance

| Datenmenge | Strategie |
|------------|-----------|
| < 1e6 Punkte | In-Memory batch |
| 1e6–1e8 | Chunked stream, memory cap, progress, cancel |
| > 1e8 / Potree | Transform **lazy** in Decode-Shader/CPU-decode **oder** Offline-Re-tile Job |

**Wichtig:** Für auditierte Lieferprodukte (Orthophoto, dense.las) **immer materialisierte** Trafo + neuer Hash, nicht nur Viewer-Offset.

### 4.3 Product Lineage

Nach Accept:

1. `TransformSpec` frezen → `FrozenTransform` (SHA-256)  
2. Neues Produkt oder neue Entity-Version mit `transform_ref`  
3. Downstream (Mesh, Ortho, Potree) **invalidiert** oder als Job-Queue „rebuild with same transform“

---

## 5. Wiederverwendbare Registrierung, produktgehostete UI

```
[1] Modus wählen: Getrennt | Gemeinsam 3D | Hybrid
        ↓
[2] Quelle beschreiben (CRS? „lokal unbekannt“? Epoch?)
        ↓
[3] Ziel beschreiben (Projekt-CRS / anderes lokales System)
        ↓
[4] Methode(n) wählen
     - PROJ / Grid / Identpunkte / Visuell / SiteCal / ICP
        ↓
[5] Parameter / Picks / Grid-Files
        ↓
[6] Preview: Dual-View Overlay + Residuen-Tabelle + Heatmap optional
        ↓
[7] Accept → Freeze → Apply-Job → Report
```

**Dual-View (dein Vorschlag):**  
Temporärer Layer „Import (pre-transform)“ + Bestand. Pick-Modus: Punkt A im Bestand, Punkt A' im Import. Mindestanzahl je Modell. Snap: Vertex, GCP, Cloud-Punkt (octree pick), Mesh-Vertex.

Design-System: Twin-Blöcke Höhe/Lage bleiben; darunter „Gemeinsame 3D“-Panel nur im Joint-Modus.

Core, Solver, TransformSpec, Preview-Verträge und UI-Controls sind gemeinsam.
Builder und PhotoLab hosten diese Controls in ihrem Produktkontext; es gibt
keinen privaten Builder-Importkern und keinen interaktiven PhotoLab-Batchknoten.
Eine gespeicherte Registrierungs-Recipe bewahrt Methode und Parameter, verlangt
aber frische Picks, solange deren Inputs nicht neu aufgelöst wurden.

---

## 6. Fehler, Grenzen, Korrekturen an deinen Überlegungen

### 6.1 Was du richtig hast

- Getrennt vs. gemeinsam als Einstieg  
- Höhe: Geoid-Grid + Offset  
- Lage: PROJ, NTv2, Identpunkte mit Modellwahl (rigid / similarity / affine / nachbarschaftstreu)  
- Visuell grob + ICP fein für Wolken/DGM/Modelle  
- Baustellenkalibrierung als eigener Workflow  
- Ein Modul für Punkte → alle Dateitypen über Stützpunkte/Vertices  

### 6.2 Fehlende / unvollständige Optionen

| Thema | Warum relevant |
|-------|----------------|
| **Zeit/Epoch** (ITRF/ETRF Bewegungen) | Dynamische CRS; 14-Parameter-Helmert + Velocity grids |
| **Geozentrisch vs. projected** | 7P Helmert gehört in ECEF; 2D Helmert im Gauß-Krüger-Raster ist **nicht** dasselbe |
| **Maßstab Grid vs. Ground** | Baustelle oft „Ground coordinates“ (combined factor) – eigene Checkbox/Parameter |
| **Residuen-Gewichtung Lage≠Höhe** | Sonst dominiert E/N die Höhe oder umgekehrt |
| **Outlier / robust fit** | Passpunkt-Fehler zerstören sonst die Trafo |
| **Coverage / Extrapolation** | NTv2/Geoid außerhalb Gitter; TPS außerhalb Konvexhülle → explodierende Deformation |
| **Invertierbarkeit** | Nachbarschaftstreue Trafo oft nur vorwärts stabil; Export braucht Policy |
| **Unsicherheit propagieren** | Optional σ der Passpunkte → σ der Trafo-Parameter |
| **Raster-Warp vs. nur Header** | Affine im Kartenraum ≠ echte geodätische Trafo auf Pixeln |
| **Kameras/Orientierung** | Nicht nur XYZ der Zentren – Rotationen mittransformieren |
| **Compound order** | Reihenfolge Lage/Höhe in Cascade dokumentieren und testen |
| **Unit / Axis order** | NEU vs ENU vs XYZ; mm vs m – strikt im Spec |
| **Null space / Rank** | Zu wenige/kollineare Punkte → Solver muss ablehnen |
| **Multi-Patch / Tile** | Große Wolken: eine globale Trafo vs. tileweise (meist **eine** globale) |
| **Legal/Lizenz Grids** | NTv2 oft nutzbar, Redistribution eingeschränkt – `GridLicenseMetadata` existiert schon |

### 6.3 Sachliche Korrekturen

1. **„pyproj“:** Architekturseitig **PROJ C-API im Sidecar** (wie CRS-Runtime), nicht Python im Produktpfad.  
2. **Zwei Punkte für Höhe:** liefert nur Δh; bei Diskrepanz brauchst du Ebene oder Geoid, nicht „Mittel und fertig“ ohne Warnung.  
3. **Zwei Punkte für Lage:** max. Similarity; Affine/Nachbarschaft brauchen mehr und gute Geometrie (nicht alle auf einer Linie).  
4. **`.cal` / `.dx`:** gemeint sind sehr wahrscheinlich **`.cal` + `.dc`** (Trimble). Beide **nicht** opensource. Kanonisch eigenes Format + optionale Importer.  
5. **ICP „bester Algo“:** es gibt keinen Universalsieger; für HimmelCAD-Praxis: **multi-scale Point-to-Plane oder GICP nach guter Init**, optional Colored-ICP. Deep-Learning-Registration ist für V1 unnötig und schwer offline/reproduzierbar.  
6. **Schrägebene ≠ freie 3D-Deformation:** oft reicht 7P; „Nachbarschaftstreue 3D“ ist teuer und riskant – als Expert-Modus.  
7. **NTv2 ersetzt keine Site Cal und umgekehrt:** NTv2 = regionales Datum; Site Cal = lokales Passpunktnetz. HybridCascade ist der Normalfall „ETRS → GK + NTv2 → lokale Similarity“.  
8. **Dense float64:** Materialisierte Trafo muss f64 behalten (gerade erledigter Bug) – gilt auch hier.

### 6.4 Empfohlene Default-Policies (Survey-tauglich)

- Ballpark-Datum: **aus**, nur mit Bestätigung  
- Grid fehlt: **hartes Fail**  
- ICP ohne grobe Init: **verweigern** oder globalen Feature-Match fordern  
- Nachbarschaftstreue: Warnung „nur innerhalb Passpunkt-Hülle gültig“  
- Apply auf Produkte: immer neuer Hash + Report-PDF/JSON  

---

## 7. Implementierungsphasen

### Phase 0 – Contract (1 PR)

- `TransformSpec` / `FrozenTransform` / `ResidualReport` in `himmelcad-core`  
- Einheitliche Fehlercodes  
- Anbindung an bestehende `FrozenImportTransformation` (CRS-Import = Spezialfall von `HorizontalOp::Proj` + `VerticalOp::Proj`)

### Phase 1 – PROJ-Pfad (Lage + Höhe)

- `transform_runtime`: compile PROJ pipeline, stream points  
- Grid-Binding (NTv2, Geoid-TIFF) mit Coverage-Check  
- Adapter: GCP-CSV, einfaches XYZ, LAS (stream)  
- UI: getrennte Lage/Höhe (erweitert bestehenden Import)

### Phase 2 – Empirische 2D/3D Fits

- Rigid / Similarity / Affine 2D + 3D Helmert 6/7P  
- Residuen-Tabelle, robuste Gewichte  
- Dual-View Point-Pick (Builder + PhotoLab)  
- Height offset + inclined plane

### Phase 3 – Apply-Adapter flächendeckend

- Mesh vertices, Polylines, dense/sparse clouds, camera centers  
- Product invalidation + rebuild hooks  
- Reports

### Phase 4 – Fine Registration

- Voxel downsample, multi-scale Point-to-Plane / GICP  
- Preview residual cloud  
- Nur als *Refinement*-Stufe nach grober Trafo

### Phase 5 – Site Calibration

- Kanonisches `SiteCalibration`-Objekt  
- Wizard Passpunkte GNSS↔Local  
- Optional JobXML-Import; .dc/.cal explizit „experimental/best-effort“  
- Export kanonisch + lesbare Parameter

### Phase 6 – Nachbarschaftstreue & Expert

- TPS / Multiquadrik auf Residuen (2D primär)  
- Starke UX-Warnungen, Domain-Maske  
- Optional NTv2-Erzeugung aus Passpunkten (Tooling)

---

## 8. Test- & Goldstrategie

| Testklasse | Inhalt |
|------------|--------|
| Unit | Helmert/Affine closed-form, known 7P, residual math |
| PROJ golden | Bestehende NTv2-Schwaben / Agisoft-Golden-Punkte |
| Geoid | Ellipsoid→GCG2016 an bekannten Testpunkten (mm–cm) |
| Round-trip | Transform + inverse (wo definiert) < ε |
| Stream | 10M-Punkte LAS cancel/resume, f64 precision at GK magnitudes |
| ICP | Synthetic two clouds known transform + noise |
| Negative | collinear points, missing grid, outside coverage |
| Audit | Frozen JSON stable hash, lineage invalidation |

---

## 9. Offene Produktentscheidungen (vor Coding klären)

1. **Default-Kompositionsreihenfolge** bei Separate: horizontal→vertical oder compound-CRS atomar?  
2. **Dürfen Nachbarschaftstrafos exportiert werden** (z. B. als dense displacement grid)?  
3. **ICP-Abhängigkeit:** pure Rust vs. kleine C++/nalgebra-only Implementierung (Lizenz, Build)?  
4. **Trimble .dc/.cal:** lohnt Reverse-Engineering in V1 oder nur kanonisch + CSV-Parameter?  
5. ~~**Builder vs PhotoLab:** gleiches Modul, getrennte Wizards oder ein „Transform Studio“-Fenster?~~
   **Entschieden:** ein gemeinsamer Transform-/Registrierungsvertrag und
   wiederverwendbare Controls, produktgehostete interaktive Abläufe; kein
   privater Importkern.
6. **Ground scale factor** als First-Class-Parameter der Site Cal?  

---

## 10. Kurz-Fazit

| | |
|--|--|
| **Kern** | Ein `PointTransform`-Modul + serialisierbare `TransformSpec` + Format-Adapter |
| **Modi** | Getrennt Lage/Höhe, Joint 3D, Hybrid-Cascade |
| **Geodäsie** | PROJ + NTv2/GTG + Geoid-Grids, Frozen Audit (bereits angelegt) |
| **Empirisch** | 2D/3D Similarity/Affine, optional TPS; Dual-View Picks |
| **Wolken** | Manuell/Passpunkte grob → multi-scale GICP/Point-to-Plane fein |
| **Site Cal** | Eigenes kanonisches Format; Trimble .dc/.cal **nicht** open, Import später/optional |
| **Nicht vergessen** | Epoch, f64, Residuen, Coverage, Lineage, Raster-Warp vs. Header |

Dieser Plan ist die Grundlage für ein späteres Design-Doc/ADR und die PR-Zerlegung (Phase 0–6). Implementierung startet bewusst **nicht** im Viewer-Kern, sondern in `himmelcad-core` + `himmelcad-sidecar`, UI nur als Orchestrator.
