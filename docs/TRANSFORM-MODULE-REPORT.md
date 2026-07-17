# Transformationsmodul — Umsetzungsreport

**Branch:** `grok/pipeline-and-transform`  
**Datum:** 2026-07-18  
**Status:** Kern-Contract + Sidecar-Runtime v1 (Rust)

---

## 1. Was wurde gebaut

### 1.1 `himmelcad-core::transform` (Contract, rein, serialisierbar)

Datei: `crates/himmelcad-core/src/transform.rs`

| Baustein | Zweck |
|----------|--------|
| `WorldPoint` / `WorldBounds` | Immer **f64** Weltkoordinaten |
| `TransformCompositionMode` | Getrennt Lage/Höhe · Joint 3D · Hybrid-Cascade |
| `OutOfBoundsPolicy` | `Error` (Default) · `FlagAndPreserve` · `Skip` |
| `GridFileFormat` / `GridRole` / `GridFileRef` | Grid-Bindung **über Pfad**, nicht Dateiname |
| `GridAuthorityHint` | Optionale EPSG/System-Erwartung → **Warnung**, kein Hard-Fail |
| `TransformStage` | Identity, PROJ, HeightOffset, HeightPlane, Empirical, VerticalProj |
| `EmpiricalOp` | Similarity2D, Affine2D, Similarity3D, Translation3D |
| `TransformSpec` → `FrozenTransform` | Validierung + Hash-Audit |
| `ResidualReport` / `ControlPair` | Passpunkt-Residuen |
| `fit_similarity_2d` / `apply_*` | Pure-Rust empirische Fits (volle Genauigkeit) |

**Kein TypeScript** in der Hot Path. Apps orchestrieren nur.

### 1.2 `himmelcad-sidecar::transform_runtime` (Ausführung)

Datei: `crates/himmelcad-sidecar/src/transform_runtime.rs`

| Fähigkeit | Verhalten |
|-----------|-----------|
| `inspect_grid` | Magic-Bytes: NTv2 (`NUM_OREC`), GeoTIFF/GTG (`II*`/`MM*`), Ctable, sonst unrecognized |
| NTv2-Metadaten | SYSTEM_F/T, GS_TYPE, Coverage (Grad), Node-Count |
| Dateiname vs. Inhalt | Nur **Warnings** (z. B. NTv2-Inhalt, Name endet nicht auf `.gsb`) |
| Authority-Hint | Soft-Mismatch-Warnung, Hash-Pin optional **hart** |
| `freeze_spec` | Alle Grids inspizieren, PROJ-Pipelines resolven, Frozen-Record |
| `apply_points` | Stufen in Reihenfolge: empirisch pure Rust, PROJ über offline **`cct`** |
| PROJ | `PROJ_NETWORK=OFF`, `PROJ_DATA` = erlaubte Grid-Roots + Datei-Parents |
| OOB | cct `*` / `inf` → Policy Error / Preserve / Skip |
| Integration | `TransformRuntime::new(config)` — gleiche Config-Idee wie `ProjRuntime` |

### 1.3 Tests

- **Core:** Similarity-Fit Roundtrip, empty stages, identity freeze, insufficient control  
- **Sidecar:** Magic detection, height/identity, empirical stage, Schwaben-NTv2 inspect (live file), WGS84→UTM32 ohne Grid, filename-warning  

```
himmelcad-core transform*: ok
himmelcad-sidecar transform_runtime*: 6 passed
```

---

## 2. Architektur-Fit (Integration später)

```
App (PhotoLab Import / Builder / Job)
        │  TransformSpec JSON
        ▼
transform_runtime.freeze_spec + apply_points
        │  WorldPoint[]
        ▲
Adapter (LAS stream, mesh vertices, polyline, GCP, cameras…)
```

- **Genauigkeit first:** f64 end-to-end; empirische Ops exakt; PROJ über gleiche Engine wie CRS-Import  
- **Effizienz:** Batch an `cct` (eine Prozess-Session pro PROJ-Stage), pure-Rust Stages ohne FFI  
- **Sicherheit:** erlaubte Grid-Roots, kein Netzwerk-Grid-Fetch  
- **Agnostische Dateien:** Pfad + Content-Inspection; Name nur Warnung  

Noch **nicht** in v1 (bewusst, API schon vorbereitet):

- ICP / Colored-ICP Fine-Registration  
- Site-Cal `.dc`/`.cal` Parser  
- TPS / nachbarschaftstreue Deformation  
- LAS/Mesh-Adapter als eigene Module (rufen nur `apply_points`)  
- Async-Wrapper an `ProjRuntime::transform_stream` (sync `cct` reicht für v1; async kann wrappen)

---

## 3. Fehlerbilder (wo was greift)

| Situation | Fehler / Verhalten |
|-----------|-------------------|
| Leere Stages | `TransformSpecError::EmptyStages` |
| Ungültige CRS/Scale/Bounds | `TransformSpecError::*` |
| Grid-Datei fehlt | `TransformRuntimeError::GridMissing` |
| Pfad außerhalb Roots | `GridPathNotAllowed` |
| Pin-Hash falsch | `GridHashMismatch` (hart) |
| Unrecognized + zu klein | `GridInvalid` |
| Punkt außerhalb Grid (cct) | `OutOfBounds` **oder** Flag/Skip je Policy |
| cct non-finite | `NonFiniteOutput` / Policy |
| cct crash / stderr | `ProjFailed` |
| Cancel | `Cancelled` |
| Name ≠ Content / Hint ≠ SYSTEM_F | **Warning** im `InspectedGridFile` / Frozen |

Default Policy für Survey: **`OutOfBoundsPolicy::Error`**.

---

## 4. Warum NTv2 für UTM32 ↔ GK4 — und nicht für WGS84 → UTM32?

### Kurz

| Transformation | Braucht NTv2/Grid? | Warum |
|----------------|--------------------|--------|
| **WGS84 / ETRS89 → UTM32 (EPSG:25832)** | **Nein** (i. d. R.) | Gleiches **modernes geodätisches Datum** (GRS80/WGS84-Familie). Nur **Abbildung** (geographisch → Transverse Mercator Zone 32). |
| **GK4 (DHDN / Bessel) ↔ UTM32 (ETRS89)** | **Ja, für mm–cm** | **Datumswechsel** zwischen historischem **DHDN (Bessel)** und **ETRS89 (GRS80)**. Rein parametrische 7P-Helmert („Ballpark“) ist in Bayern oft **dm-Fehler**. NTv2 modelliert **regionale Verzerrungen**. |

### Etwas genauer

1. **WGS84 → UTM32**  
   - Ausgang: Ellipsoid-Koordinaten (lat/lon) auf WGS84/ETRS-ähnlich.  
   - Ziel: projizierte Meter im gleichen (oder praktisch äquivalenten) Frame.  
   - PROJ-Pipeline: `unitconvert` + `utm +zone=32 +ellps=GRS80`.  
   - **Kein** regionales Shift-Grid nötig, solange man nicht „WGS84 1984 epoch“ vs. „ETRS89 2000“ auf cm-Niveau trennt (dann Epoch/Plate-Motion — anderes Thema).

2. **UTM32 (ETRS89) ↔ GK4 (DHDN90)**  
   - GK4 hängt an **DHDN / Bessel-Ellipsoid** und historischem Netz.  
   - UTM32 in DE hängt an **ETRS89 / GRS80**.  
   - Zwischen den Netzen gibt es **nicht nur** einen globalen 7-Parameter-Helmert, sondern **örtlich variable** Reste (NTv2).  
   - Bayerische Dateien (`kanu_ntv2_schwaben.gsb`, …): `SYSTEM_F=DHDN90` → `SYSTEM_T=ETRS89`.  
   - Unsere KANU-Validierung: **mean ~3,5 mm, max ~6,3 mm** mit NTv2 — deckungsgleich mit deinem Script-Header.  
   - Ohne Grid (nur EPSG 31468↔25832): oft **cm bis dm** (Ballpark).

3. **Geoid (GCG2016 etc.)**  
   - Braucht man für **Ellipsoidhöhe ↔ Normal-/Orthometrische Höhe**, nicht für reine 2D-Lage UTM↔GK.  
   - Eigene Stage / VerticalProj + `vgridshift`.

### Produktregel (so im Modul verankert)

- Discovery darf **ballpark** vorschlagen, Default-Policy bleibt streng (`ALLOW_BALLPARK`-Äquivalent in `OperationSelectionPolicy`).  
- GK/DHDN-Pfade: **explizites Grid** (wie schon `photolab_crs` / Gauss-Krüger-Regeln).  
- Dateiname der Grid-Datei ist **egal**; Content + optionaler Hash/Authority-Hint zählen.

---

## 5. Empfohlene nächste Schritte (Apps)

1. PhotoLab-Import: `TransformSpec` UI (getrennt/joint) → `freeze_spec` → Audit anzeigen → Apply auf GCP/Cloud  
2. LAS-Adapter: stream chunks → `apply_points` → write  
3. Optional: async bridge auf bestehendes `ProjRuntime::transform_stream` für riesige Text-Streams  
4. Site-Cal + ICP als weitere `TransformStage`-Varianten  

---

## 6. Dateien

| Pfad | Rolle |
|------|--------|
| `crates/himmelcad-core/src/transform.rs` | Contract |
| `crates/himmelcad-core/src/lib.rs` | `pub mod transform` |
| `crates/himmelcad-sidecar/src/transform_runtime.rs` | Engine |
| `crates/himmelcad-sidecar/src/lib.rs` | `pub mod transform_runtime` |
| `docs/TRANSFORM-MODULE-PLAN.md` | Design |
| `docs/TRANSFORM-MODULE-REPORT.md` | Dieser Report |
