# Reference-product dossier: RIB Civil (iTWO civil / STRATIS)

Status: research dossier, 2026-09-01. Evidence for A2 derivations per `docs/FUNCTION-CONTRACT.md`; never
normative by itself.

Product flags used throughout: **[RIB]** = current RIB Civil / iTWO civil marketing and product documentation;
**[STRATIS]** = the direct predecessor product (same vendor, same data model; RIB sold iTWO civil as its
successor), documented through a university training course with exact menu paths; **[C3D]** = Autodesk Civil
3D (secondary evidence for German-market expectations); **[card_1]** = card_1 by IB&T (secondary evidence).
Where a claim rests on STRATIS-era material, assume the concept survived into RIB Civil unless marked
otherwise — RIB's own brochure describes iTWO civil as carrying the same object model (Achsen, Gradienten,
Breitenbänder, Querprofile, DGM-Horizonte) forward.

## 1. Product overview and reference role

RIB Civil (formerly RIB iTWO civil, before that STRATIS) is the German civil engineering CAD from RIB Software
GmbH, Stuttgart (founded 1961; acquired by Schneider Electric in 2020). It covers planning, design,
construction preparation and billing of roads, earthworks and sewer networks ("Straßen-, Erd- und Kanalbau")
**[RIB]**. STRATIS was the de-facto standard in German public road administrations; a CAD.de practitioner
notes some Autobahndirektionen effectively required it **[STRATIS]**. iTWO civil is a CAD core
("CAD-Kerngerüst") into which licensable apps are integrated: Trassierung, Querprofil, Erdbauwerke,
Mengenberechnung, Punktwolke, Straßenbau, Entwässerung, and more **[RIB]**.

Reference role for Himmel:CAD: RIB Civil is the reference for the CAD/civil drafting domain — 2D construction
with survey-grade exactness, alignments (Achsen), gradients (Gradiente), digital terrain models (DGM), cross
sections (Querprofile), quantities, and plan production. Its defining trait, versus generic CAD, is that every
drafting object can carry civil semantics (Fachbedeutung/object meaning, station reference, horizon number)
and that plan, profile and cross-section views stay linked to one data model ("Zusammenspiel aller
Projektdaten – Grundriss, Querprofil, Trassenelemente – im direkten Zugriff") **[RIB]**.

## 2. Function catalog by area

### 2.1 2D drafting primitives [STRATIS, menu paths verified]

| Function                                                      | What it does                                                                                                                                                                                                | UI surface                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Punkt absolut/relativ/polar                                   | Construction points by absolute coords, delta to a reference point, or distance+angle                                                                                                                       | Menu `<Konstruktion><Punkt><…>`, exact input via F5 box                      |
| Kleinpunkt / Achskleinpunkt                                   | Point at offset perpendicular to a reference line, or at station+offset to an alignment                                                                                                                     | Same menu; live station/offset readout in Tachobox                           |
| Schnittpunkt, Mittelpunkt, Tangentenschnittpunkt, Lotfußpunkt | Intersection of any two line elements (line/arc/clothoid), arc center, tangent intersection, foot of perpendicular — also on extensions                                                                     | `<Konstruktion><Punkt><…>`                                                   |
| Teilungspunkte                                                | Divide a line/arc/clothoid/polyline/axis into equal parts without splitting it                                                                                                                              | `<Konstruktion><Punkt><Teilungspunkte>`                                      |
| Gerade AP-EP, TA-EP, AP-TE, TA-TE (m. Kloth.)                 | Straight segments free, coupled tangentially onto arcs ("koppeln"), pivoted onto arcs ("schwenken"), buffered between two arcs ("puffern"), optionally with clothoids inserted                              | `<Konstruktion><Gerade><…>`                                                  |
| Bogen AP-MP-WI, AP-MP-EP, AP-EP-ZP, AP-AR-EP, …m. Kloth.      | Arcs from point/center/angle, three points, start+direction+radius; tangential attach with automatic clothoid or Wendeklothoide (S-curve) insertion; multiple geometric solutions cycled by cursor position | `<Konstruktion><Bogen><…>`, F5 for exact radius (sign = curvature direction) |
| Klothoide                                                     | Connect line–arc or arc–arc with a clothoid or symmetric/asymmetric Wendeklothoide; parameter, length, or A1/A2 ratio can be fixed                                                                          | `<Konstruktion><Klothoide>`, dialog with Berechnen preview                   |
| Linienzug                                                     | Chain of elements treated as one entity: Erzeugen, Verbinden (gap-free join), Umdrehen (reverse direction)                                                                                                  | `<Konstruktion><Linienzug><…>`                                               |
| Kreis, Spline, Text, Maßketten, Flächen, Schraffur            | Full circles, splines, text, dimension chains, areas, hatches (Planbearbeitung "Flächen, Texte, Maßketten")                                                                                                 | Menus + Plangestaltung module                                                |
| Trimmen                                                       | Extend/shorten lines and arcs to intersections; end nearest to cursor is modified                                                                                                                           | `<Funktionen><Trimmen>`                                                      |
| Kopieren, Rotieren, Verschieben, Nummerieren, Ändern          | Copy along a vector, rotate about a reference point/direction, move by vector; renumber points; edit definitions                                                                                            | `<Funktionen><…>`, Markierbox for group selection                            |
| UNDO                                                          | Multi-step undo for delete/remove operations                                                                                                                                                                | `<Löschen>/<Entfernen>` menus                                                |

### 2.2 Snapping and construction aids [STRATIS]

| Function                | What it does                                                                                                                                                             | UI surface                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Fangkreis (snap circle) | Points/elements inside a configurable snap radius are caught; otherwise cursor position is used; snapped candidates highlight in marker color (Fanganzeige)              | Global; radius under `<Extras><Grundparameter>` |
| Punktauswahl            | If several points lie inside the snap circle, a picker box lists them (distance, number, height, spec, layer) for exact choice                                           | `<Extras><Punktauswahl><Ein>`                   |
| F5-Box                  | Every mouse construction has a numeric twin: type point numbers, coordinates, radii, clothoid parameters/lengths mid-command                                             | F5 during any construction                      |
| F4-Box                  | Select named objects (axes, profiles, gradients) by name instead of clicking                                                                                             | F4 during commands                              |
| Tachobox                | Permanent readout of cursor position; values (distance, direction, radius, clothoid parameter, station/offset) adapt to the running function; snapped-element data shown | Screen corner, `<Extras><Tacho>`                |
| Mehrdeutigkeit          | When several geometric solutions exist (e.g. buffer arcs), moving the cursor toggles between them; click commits                                                         | In-canvas                                       |
| Hilfspunkte             | Construction points without number/code, on the current layer, excluded from the point database                                                                          | All point constructions                         |

### 2.3 Layers, pens, specifications [STRATIS]

| Function                      | What it does                                                                                                                                                                                                         | UI surface                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Folien (layers)               | Auto-managed layers; each Achse, Gradiente and Dreiecksnetz gets its own layer named after the element; Folienverwaltung: create, set current, show/hide, remove, rename                                             | `<Ansicht><Folie>`, dialog           |
| Folienhierarchie              | Explicit draw-order stack of layers (bottom-to-top), reorderable                                                                                                                                                     | Dialog `Nach oben/unten`             |
| Elemente einer Folie zuordnen | Reassign marked elements to any layer                                                                                                                                                                                | Menu + Markierbox                    |
| Spezifikation (pen tables)    | Line color, width, dash type per element via line-code table; point, line, area, text, labeling and slope-hatch specifications stored in specification tables (`*.spz`), color table (`*.col`), dash table (`*.dot`) | F9 Spezifikation box                 |
| HV-Planverwaltung             | Foreground/background plans: construction happens in the foreground plan; background plans visible but untouchable                                                                                                   | `<Ansicht><HV-Planverwaltung>`       |
| Darstellung options           | Per-plan toggles for helper points, grid crosses, symbols, texts, hatches, raster images, slope hatches                                                                                                              | `<Ansicht><Optionen>`, tabbed dialog |

### 2.4 Alignments (Achsen / Trassierung)

| Function                                           | What it does                                                                                                                                                                                       | UI surface                                                             | Flag            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------- |
| Achse erzeugen                                     | Turn a Linienzug (lines/arcs/clothoids) into a named axis with start station; axis stationing labels via view options                                                                              | `<Konstruktion><Achse><Erzeugen…>`                                     | [STRATIS]       |
| Achsentwurf/automatische Achsgenerierung           | Generate an axis from a sketched design line (Entwurfslinie)                                                                                                                                       | Trassierung app                                                        | [RIB]           |
| Achsprüfung                                        | Check axis for jumps and kinks ("Sprünge und Knicke"); intelligent error display with correction proposals per axis parameter                                                                      | Trassierung app                                                        | [RIB]           |
| Achsoptimierung                                    | Optimize axis considering constraint points and element parameters                                                                                                                                 | Trassierung app                                                        | [RIB]           |
| Achsverziehung                                     | Lane widening/taper (Abbiegespuren) computed from four equal tangents, arcs fitted                                                                                                                 | `<Konstruktion><Achse><Verziehung>`                                    | [STRATIS]       |
| Knotenpunkt-Assistenten                            | Wizards for junctions: roundabout (Kreisverkehr), Einmündung, Tropfen and Dreiecksinseln per RAS-K-1, parameters editable in a dialog (radii, island roundings, distances) with guideline defaults | `<Konstruktion><Achse><Tropfen>` dialog; assistants in Trassierung app | [STRATIS]+[RIB] |
| Rampenband generation                              | Superelevation band generation per regulation ("Rampenbandgenerierung nach Vorschrift")                                                                                                            | Trassierung app                                                        | [RIB]           |
| Bänder (Breiten-, Rampen-, Kurvenband, Deckenbuch) | Width, superelevation, curvature bands and pavement book stored per axis in linked databases, opened/saved together with the axis                                                                  | `<Datei><Öffnen DAB><Achsen>` with per-band checkboxes                 | [STRATIS]       |
| Schleppkurve                                       | Swept-path analysis for left/right/reverse turns, BMVI vehicle catalog, custom vehicles, hull surfaces/wheel tracks drawn in the plan, documented                                                  | Schleppkurve app                                                       | [RIB]           |
| Sichtweitenanalyse / HViSt                         | Sight-distance analysis per RAL/RAA/RAS-K-1/RASt against DGM and gradient; results as bands in the profile view                                                                                    | Sichtweitenanalyse app, VISAll3D extension                             | [RIB]           |

Comparable secondary evidence: Civil 3D models alignments as element sequences (Festelement/Pufferelement)
with design-check sets; German users judged its junction/OKSTRA support weaker than the German products
**[C3D]**. card_1 likewise builds axes from element sequences incl. rail transition curves **[card_1]**.

#### Best-fit alignment evidence added 2026-09-02 [C3D + research]

| Evidence item                                                                                                        | Sourced behavior or feasibility bound                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Relevance                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Civil 3D **Create Alignment by Best Fit**                                                                            | Autodesk documents input from one path or two roughly parallel paths made of feature lines, COGO points, lines, arcs, points, or blocks. For two point paths it fits a spline to each, projects points between them to derive a centerline, detects straight/curve sequences from sampled curvature, and can insert symmetric or asymmetric transitions subject to an R/A constraint; settings trade source accuracy against the result. A regression report exposes the source data for review. | Establishes the reference workflow for one/two edge paths or picked points, adjustable accuracy/transition constraints, and an inspectable fit result; it does not establish that every input has a feasible constrained solution. |
| Garach, de Oña & Pasadas, _Automation in Construction_ 47 (2014), DOI 10.1016/j.autcon.2014.07.002                   | The published method fits a spline to georeferenced road points, analyzes curvature, and identifies traditional straight, circular-arc, and clothoid elements; the paper explicitly treats element identification as difficult and reports preliminary tests rather than a universal solver.                                                                                                                                                                                                     | Establishes mathematical feasibility of recovering true traditional element classes from point samples, while requiring an honest failure/non-convergence path and measured residuals.                                             |
| McCrae & Singh, _Sketching Piecewise Clothoid Curves_, Computers & Graphics 33 (2009), DOI 10.1016/j.cag.2009.05.010 | A polyline stroke is fitted by first approximating discrete curvature as a piecewise-linear function with a trade-off between fit error and number of pieces; each piece becomes a line, circular arc, or clothoid, and the composite is aligned to the stroke.                                                                                                                                                                                                                                  | Establishes a published algorithm class for the requested residual-versus-element-count objective; it is evidence for feasibility, not a mandate to copy an implementation.                                                        |

Checked absence: neither the RIB/STRATIS sources already cataloged in this dossier nor the added Civil 3D
material documents a best-fit command that guarantees a solution under arbitrary minimum-radius, clothoid-A,
tolerance, and element-count constraints. A product contract must therefore expose infeasibility and residuals
rather than silently relax constraints.

### 2.5 Gradients (Gradiente / Längsschnitt) [STRATIS, menu paths verified]

| Function                                              | What it does                                                                                                                                                                                                                          | UI surface                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Längsprofilfenster                                    | Separate profile view per axis (station/height coordinate system) showing terrain profile, gradients, constraint points; superelevation factor (Überhöhung), stationing, Krümmungsband, Rampenband, Überdeckung, Flächensumme toggles | `<Fenster><Längsprofil>`, `<Ansicht><Optionen><Längsprofil…>` |
| Automatischer Gradientenpolygon                       | Auto-compute a tangent polygon from the terrain profile: smoothing factor, minimum tangent length/radius/grade change, fixed start/end station+height+grade                                                                           | `<Konstruktion><Gradiente><autom. Gradientenpolygon>`         |
| Gradiente erzeugen / auflösen                         | Convert a Linienzug into a named gradient (own layer), and back                                                                                                                                                                       | `<Konstruktion><Gradiente><Erzeugen>/<Auflösen>`              |
| TS-Punkt einfügen/anfügen/entfernen/verschieben       | Insert/append/delete/move tangent intersection points; rubber-band preview; existing roundings preserved; move constrained to tangent, horizontal, or free; exact station via F5                                                      | `<Konstruktion><Gradiente><TS-Punkt …>`                       |
| Ausrunden                                             | Crest/sag rounding with quadratic parabola: drag with live rubber band, current radius shown in Tachobox, or fix radius/tangent length/point via F5; "Maximale Ausrundung" one-click; error message when rounding impossible          | `<Konstruktion><Gradiente><Ausrunden>`                        |
| Tangentensteigung ändern                              | Type both tangent grades of a TS point numerically                                                                                                                                                                                    | Dialog                                                        |
| Gradientenüberdeckung                                 | Live cover-depth band between terrain profile and gradient plus area-sum line, recomputed after every edit                                                                                                                            | `<Konstruktion><Gradiente><Gradientenüberdeckung>`            |
| Gradientenerzeugung aus Längsprofilen mit Optimierung | Modern app: gradient generation from long profiles with optimization and constraint points                                                                                                                                            | Trassierung app [RIB]                                         |

### 2.6 DGM / terrain [STRATIS workflow verified; RIB apps]

| Function                                    | What it does                                                                                                                                                                                                                     | UI surface                                               | Flag            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------- |
| Punktdatenbank                              | Terrain points managed in a point database, loaded selectively (all/filter/rectangle/polygon)                                                                                                                                    | `<Datei><Öffnen DAB><Punkte>`                            | [STRATIS]       |
| Zwangslinien: Bruchlinienzug, Randlinienzug | Constructed polylines converted to breaklines and boundary lines (outer boundary + inner "holes" e.g. buildings); triangulation edges forced onto them                                                                           | `<DGM><Dreiecksnetz><Setzen Linienzug><…>`               | [STRATIS]       |
| Vermaschung                                 | Triangulate visible data with modes: check only / no check / with error display / with error correction; max edge length for auto outer boundary; result on named layer with horizon number                                      | `<DGM><Dreiecksnetz><Vermaschen>` + Optionen             | [STRATIS]       |
| Datenfehleranzeige                          | Error list after meshing; per error: Info + Anzeigen (zoom to error location); also written to INFO.LST                                                                                                                          | `<DGM><Dreiecksnetz><Ändern><Datenfehleranzeige>`        | [STRATIS]       |
| Höhenlinien                                 | Linear or smoothed contours at two simultaneous intervals with distinct line specs and label specs; min/max heights reported; label individual contours by click                                                                 | `<DGM><Höhenlinien><Optionen>/<Erzeugen>/<Beschriftung>` | [STRATIS]       |
| Kontrollschnitt                             | Ad-hoc section between two points, freely placed on screen, stored on a KONTROLLSCHNITTE layer, with exaggeration factor                                                                                                         | `<DGM><Darstellung><Kontrollschnitt>`                    | [STRATIS]       |
| Neigungsplan                                | Triangles color-filled by slope class (user-defined % ranges + colors)                                                                                                                                                           | `<DGM><Darstellung><Neigungsplan>`                       | [STRATIS]       |
| Regen / Fließverfolgung                     | Virtual raindrops traced down steepest slope to DGM edge or low point, per point or in a grid                                                                                                                                    | `<DGM><Darstellung><Regen>`                              | [STRATIS]       |
| Mehrere Horizonte / Bodenschichtmodelle     | Multiple surface horizons (existing ground, topsoil, rock, formation) via horizon numbers; soil-layer models in quantity takeoff                                                                                                 | Horizon field in dialogs                                 | [STRATIS]+[RIB] |
| Punktwolke app                              | Import all common laser-scan formats/ASCII; axis-based interpolation of long/cross profiles directly from the cloud; intelligent breakline finder; object-oriented digitizing in the cloud; difference models; DGM triangulation | Punktwolke app                                           | [RIB]           |
| Volumen                                     | Quantity between horizons, prism method, accounting polygons/thicknesses, automatic surface intersection                                                                                                                         | Mengenberechnung app                                     | [RIB]           |

### 2.7 Cross sections (Querprofile) [STRATIS QP tools verified; RIB app]

| Function                                   | What it does                                                                                                                                                                                                                                                      | UI surface                                  | Flag            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------- |
| RQ-Editor (Regelquerschnitt)               | Build typical cross-section structures (RQ-Strukturen) from extensive predefined component catalogs (Straßenbau, Brückenbau, Wasserbau, Rohrleitungsbau) with preview graphics; multiple pavement layers, frost layer, curbs, shoulders, embankments per RAL/RStO | Separate program/editor                     | [STRATIS]+[RIB] |
| QP-Generator project                       | Wizard: choose axis database + axis, stations, terrain profile lines from the QP database, derive topsoil bottom as parallel at 0.1 m with new horizon number; project saved as `*.qpp`                                                                           | `<Datei><Neu>` wizard                       | [STRATIS]       |
| Stationsfenster                            | Station list with checkboxes — checked stations receive all constructions simultaneously; multiple station windows tiled; active profile line selected in a toolbar dropdown                                                                                      | Main window of QP-Generator                 | [STRATIS]       |
| Konstruktionszuordnung                     | Table assigning an RQ structure per station range and per side (left/right) of the axis                                                                                                                                                                           | `<Konstruktion><Konstruktionszuordnungen…>` | [STRATIS]       |
| Punktkonstruktion / Schnittpunkt-Assistent | Free points or points bound into profile lines; intersection assistant combines two geometric loci (horizontal, vertical, grade, parallel-to-profile-line, …); consistent point names enable cross-station construction                                           | Toolbar + wizard dialogs                    | [STRATIS]       |
| Mulden, Böschungsausrundung, Parallelen    | Ditch construction, slope rounding, new profile lines as parallels                                                                                                                                                                                                | `<Konstruktion>` menu                       | [STRATIS]       |
| Begrenzungslinien                          | Accounting boundary lines over free points + profile points, own Horizontkennzahl, styled via Fachbedeutungen; basis for volume/surface computation                                                                                                               | `<Konstruktion><Begrenzungslinie>` wizard   | [STRATIS]       |
| Fachbedeutungen                            | Object-meaning catalog (OK/UK Mutterboden, Frost, Planum, Bordstein…) mapped to display styles; extensible                                                                                                                                                        | `<Darstellung><Fachbedeutungen>`            | [STRATIS]       |
| Intelligent linkage                        | Cross sections linked to gradient, width band, ramp band; station-wise flexible assignment of Regelprofile; construction macros reusable across projects; logical/mathematical condition queries; REB-conform quantities and test data from the same model        | Querprofil app                              | [RIB]           |

### 2.8 Quantities (Mengenermittlung)

| Function                     | What it does                                                                                                                                                                  | UI surface                  | Flag            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------- |
| Bauabrechnung aus CAD-Plänen | Counts, lengths, areas (incl. projected), volumes from plan elements; element-to-LV-position assignment; accounting periods                                                   | Mengenberechnung app        | [RIB]           |
| Mengen aus DGM               | Between horizons, prism method, accounting polygons/thicknesses, soil classes from a layer model                                                                              | Mengenberechnung app        | [RIB]           |
| REB-Verfahren                | Quantity computation per REB VB 21.003/21.013/21.022/21.033 from cross sections; test-data (Prüfdaten) generation for the quantity proof; position quantity lists for billing | Querprofil/Erdbauwerke apps | [RIB]+[STRATIS] |
| Übergabe an AVA              | Quantities linked to OZ/LV positions, handed to billing as DA11/DA12 (REB) or ÖNorm B2114/A2063                                                                               | Mengenberechnung app        | [RIB]           |
| Erdbauwerke                  | Wizard-driven pit/dam/pond bodies with variable slopes, benches, work spaces; automatic intersection with DGM; REB-conform data for machines or proof                         | Erdbauwerke app             | [RIB]           |

### 2.9 Plan production (Planerstellung)

| Function                                                  | What it does                                                                                                                                                 | UI surface                                                 | Flag            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | --------------- |
| Planausschnitte                                           | Named, arbitrarily rotated sheet frames over the drawing (`*.pas`); each viewable as full screen; frame size/orientation stored separately from drawing data | `<Ansicht><Ausschnitt><Definieren/Setzen/…>`               | [STRATIS]       |
| Drucken Plan + Skalierung                                 | Print current sheet at a chosen scale (1:10000…1:1); metafile export to clipboard/WMF                                                                        | `<Datei><Drucken Plan>`                                    | [STRATIS]       |
| Plangestaltung                                            | Plan decoration stored as `*.dzg` beside drawing data; axis decoration `*.dag`                                                                               | File options                                               | [STRATIS]       |
| Dynamische Bemaßung, Trassengestaltung, Detailzeichnungen | Plan-editing tools named in standard scope: dynamic dimensioning, alignment styling, detail drawings                                                         | Standard solution scope                                    | [RIB]           |
| RE-2012-konforme Pläne                                    | Intelligent, dynamic alignment and plan design per RE 2012 for different scales; automatic land-acquisition plan labeling per RE-2012                        | Trassierung/Grunderwerb apps                               | [RIB]           |
| Höhen-/Querschnittspläne                                  | Dynamic profile and cross-section sheet generation ("Erstellung von dynamischen Höhen- und Querschnittsplänen"); Querprofilpläne as own course module        | Standard scope                                             | [RIB]+[STRATIS] |
| Listen                                                    | Formatted list output (point lists etc.) to printer/screen via list templates                                                                                | `<Datei><Drucken Liste>`                                   | [STRATIS]       |
| Rasterbilder                                              | Georeferenced raster (TIFF/TFW, JPG/JGW) as plan background; 3-point transformation for unreferenced scans                                                   | `<Datei><Import><Rasterbilder>`, `<Bearbeiten><Einpassen>` | [STRATIS]+[RIB] |

### 2.10 Data exchange [RIB]

REB data types (DA40 axis geometry, DA21 gradients, DA22 superelevation, DA23 width bands, DA45 points, DA49
lines, DA50 curvature bands, DA58 DGM triangles, DA66 cross sections, DA67/68 corrections/boundary lines);
LandXML (axes incl. info, points/lines/surfaces, DGMs; Topcon/Leica machine control); DXF/DWG (axes decomposed
to polylines, DGMs as 3DFACE/MESH, layers

- names); OKSTRA-CTE/XML (axes with all bands, Deckenbücher, DGMs, slopes+hatching, Grunderwerb); ALKIS-XML
  (cadastre with parcel attributes); ISYBAU 06/01-96/91 (sewer); CPIXML (Trassenkörper/BIM bodies to iTWO 5D,
  station-wise, layered); IFC + BCF; PDF (scale-true in/out, vectors become CAD elements); KML/Google Earth;
  Messdaten app (polar tachymeter surveys, traverses, direct coding into CAD objects).

## 3. Core workflows (user perspective)

### W1 — Set up a project and load data [STRATIS]

Projects live in project folders; `<Datei><Projektverwaltung>` switches them. Dateivorbelegung presets which
databases (points `*.dpn`, axes `*.dan` with attached width/tangent/QP/long-profile databases, specifications,
symbols) all open/save commands use. Drawing state is one ASCII SDA file; databases persist independently; on
save the user chooses keep-old/overwrite/ask per duplicate; Autosave writes AUTOSAVE.SDA periodically.

### W2 — Draw a site plan over cadastre and raster [STRATIS]

Load parcel/building plan (SDA) → import raster `<Datei><Import> <Rasterbilder>` → georeference with 3+
Paßpunkte (`<Bearbeiten><Einpassen>`; 6-parameter transform) → set line/point specification (F9) and current
Folie → construct with points/lines/arcs; Fangkreis catches existing geometry, F5 for exact coordinates;
Tachobox shows live distance/direction → texts, dimension chains, hatches → hide/show layers, fix layer
hierarchy for draw order → save SDA.

### W3 — Design an alignment element by element [STRATIS, worked example]

Zoom into the corridor (F2/F3 view keys) → divide the corridor with Teilungspunkte → fit an arc through three
of them (`<Bogen><AP-EP-ZP>`) → couple an arc tangentially onto the existing straight (`<Bogen><AP-TA-EP>`) →
trim both arcs to intersection (`<Funktionen><Trimmen>`) → buffer a 400 m arc between them (`<TA-TE-ZP>`,
radius typed in F5; mouse toggles the two solutions) → tangent from a fixed point (`<Gerade><AP-TE>`) → pivot
in a –150 m left-curving arc (`<AP-TE-EP>`, negative radius) → join everything (`<Linienzug><Verbinden>`;
overhanging ends are auto-trimmed) → `<Achse> <Erzeugen…>`: name HAUPT, start station 0.000 → switch on
Achsstationierung labels. Clothoids are inserted by the …m.-Kloth. variants; parameters default to R/3
rounded, overridable. Modern RIB adds axis checking with correction proposals and optimization under
constraints **[RIB]**.

### W4 — Design the gradient [STRATIS, worked example]

`<Fenster><Längsprofil>`, pick the axis → set exaggeration 10, grades in %, stationing + Krümmungsband on →
`<Gradiente><autom. Gradientenpolygon>` computes a tangent polygon from the terrain profile (smoothing factor,
minimum tangent length/radius/grade change, fixed ends) → `<Gradiente> <Erzeugen>` names it G1 → insert TS
point near 0+500 (rubber-band preview, snap to existing points), type exact station via
`<TS-Punkt verschieben><Auf der Tangente>` + F5 → type grades (–1.9 %/4.0 %) in the Gradientensteigung dialog
→ `<Ausrunden>`: drag the parabola, radius live in the Tachobox, or type –3000 via F5; impossible roundings
are refused with a message → check cover with `<Gradientenüberdeckung>` (live band vs. terrain).

### W5 — Build a DGM from points and breaklines, fix errors [STRATIS]

Preset the point database → `<Datei><Öffnen DAB><Punkte><Alle>` → construct polylines over surveyed points for
the outer boundary, holes ("Dead Areas", counter-clockwise) and slope edges → declare them
`<Setzen Linienzug> <Randlinienzug>/<Bruchlinienzug>` via Markierbox → `<Dreiecksnetz><Optionen>`:
"Vermaschung mit Fehleranzeige", all visible data, max edge length 100 m → `<Vermaschen>`, layer dnetz00,
horizon 10 → open the error list (`<Ändern><Datenfehleranzeige>` or INFO.LST): each error has Info and an
Anzeigen jump to the location; typical causes are wrong instrument/point heights, point mix-ups, wrong prism
heights — fix and remesh (a "Vermaschung mit Fehlerkorrektur" mode exists) → verify plausibility with contours
at 0.2/1.0 m in distinct specs, labeled by click; Kontrollschnitte across suspicious spots; Neigungsplan and
Regen grid for drainage checks. Rule pair users must know: constraint-line points must belong to the horizon,
and constraint lines may cross only in shared surveyed points.

### W6 — Generate cross sections along the axis [STRATIS]

Prepare RQ structures in the RQ-Editor from component catalogs (Fb, Fb_Bk, Fb_Gw variants) → QP-Generator
`<Datei><Neu>` wizard: axis database + axis HAUPT, stations every 20 m, terrain profile line 10 (OK
Mutterboden), derive UK Mutterboden as 0.1 m parallel, horizon 11 → project `*.qpp` → assign Fachbedeutungen
to profile lines → `<Konstruktion> <Konstruktionszuordnungen…>`: RQ structure per station range and axis side
→ boundary lines computed → local edits: activate stations 420–500 via checkboxes so constructions repeat on
all of them; Schnittpunkt-Assistent builds daylight/topsoil points; right-click a point for Entfernen/
Verschieben/In Linie einfügen/Eigenschaften (axis offset + height shown numerically) → construct
Begrenzungslinie 72 over named points for the accounting area → quantities per REB from the boundary lines;
results feed Querprofilpläne. RIB Civil keeps this station-wise model with variants per project phase and
reusable construction macros **[RIB]**.

### W7 — Produce a plan sheet [STRATIS + RIB]

Define Planausschnitte (named, rotated frames; content rotates to screen for editing) → decorate: north arrow,
stationing labels, dimension chains, plan head; RE-2012-conform dynamic labeling in the modern product
**[RIB]** → `<Drucken Plan>` at fixed scale or fit-to-page; PDF plans scale-true; DXF/DWG export for
externals; profile and cross-section sheets generated dynamically from the model **[RIB]**.

### W8 — Prepare machine-control and BIM data [RIB]

From cross sections/DGMs generate Trassenkörper (station-wise 3D bodies with layer subdivision and semantic
meaning: Erdauftrag/Abtrag/Frostschutz), export CPIXML to iTWO 5D for costing; LandXML to Topcon/Leica 3D
machine control; as-built data flows back for billing.

## 4. Practitioner praise and complaints

Praise:

- Deep German-regulation coverage (REB, OKSTRA, RE 2012, RAS/RAL, ISYBAU) is the product's moat; Autobahn
  administrations effectively mandated STRATIS data **[STRATIS, CAD.de]**.
- Integrated data model — plan, profile, cross-section, quantities on one object base — is the selling point
  RIB repeats and users migrate for (Eurovia rolled iTWO civil out to ~30 surveyors after a 2-day workshop)
  **[RIB]**.
- Comprehensive function scope and strong market position in Germany **[STRATIS, CAD.de]**.

Complaints:

- Cost: ~€14,500 acquisition (forum-era price), ~15 %/a maintenance, paid version jumps every 4–6 years
  **[STRATIS, CAD.de]**.
- Stagnation before the iTWO civil transition: "Die letzten 3 Jahre war da nichts dabei, was man wirklich
  update nennen könnte"; users saw no clear added value of iTWO civil over STRATIS in presentations and
  cancelled maintenance contracts **[STRATIS/RIB, CAD.de]**.
- Rigid editing: "Das Zeichnen von Querprofilen ist so starr wie ein Stück Stahl" — no drag-and-drop-style
  direct manipulation in cross-section editing; wizard/dialog-driven UI everywhere **[STRATIS/RIB, CAD.de]**.
- Almost no public review footprint (Capterra lists the product without a single verified review) — niche B2B
  distribution **[RIB]**.
- Contrast **[C3D]**: German users find Civil 3D cheaper and strong on DGM, but "many things are only 80 %
  satisfactory": slow with many pipe networks, laborious German cross-sections via Subassembly Composer, weak
  OKSTRA/REB support — which is precisely the gap the German products fill.

Design lessons for Himmel:CAD: (1) exact numeric entry everywhere is the non-negotiable baseline (F5-box
parity), (2) users resent modal rigidity — direct manipulation with live rubber bands and a permanent numeric
readout (Tachobox) is the loved part of the interaction model, (3) error lists must jump to the error location
(DGM Datenfehleranzeige), (4) station-wise multi-apply (checkbox station list) is a proven batch-editing
pattern.

## 5. Mapping hints to Himmel:CAD Builder ribbon tabs

- **Draw** (primary derivation from this dossier): point constructions
  (absolute/relative/polar/offset/intersection/foot-of-perpendicular/ division), line–arc–clothoid element
  constructions with couple/pivot/buffer semantics and multi-solution cycling, polyline join/reverse, trim,
  copy/rotate/move with reference vectors, snap circle + candidate picker, F5-style numeric twin for every
  mouse action, live cursor readout, layer manager with draw-order hierarchy, pen/spec tables, dimension
  chains, texts, hatches. Civil extensions when the domain arrives: axis from polyline with stationing,
  station/offset point, gradient editor in a dedicated profile window (TS points, parabola rounding, live
  cover band).
- **Mesh**: DGM triangulation with breaklines/boundaries/holes, meshing modes (check-only/with error
  display/with correction), error list with zoom-to-error, contours with dual interval + specs, slope-class
  coloring, control sections, drop-flow analysis, horizon concept for multi-surface models, prism volumes
  between horizons. The dedicated-window surface choice (B3) matches STRATIS's QP-Generator/profile windows.
- **Pointcloud**: RIB's Punktwolke app justifies: axis-based profile extraction from clouds, breakline finder,
  digitizing directly in the cloud, difference models, cloud→DGM triangulation.
- **File**: project-folder model, database vs. drawing-file split, keep/overwrite/ask merge on save, autosave;
  import/export DXF/DWG, LandXML, PDF (scale-true), raster with georeferencing; list/report output.
- **View**: named view frames (Ausschnitte) incl. rotated sheet editing, foreground/background plan locking
  (HV-Planverwaltung), per-plan display toggles, layer show/hide, four-step view history.
- **Raster**: georeferenced TIFF/TFW-JPG/JGW backgrounds, 3-point fit transformation, monochrome/transparent
  display options.
- **BIM**: Trassenkörper-style semantic 3D bodies with layer decomposition and attribution, CPIXML/IFC/BCF
  exchange; Fachbedeutung (object meaning) catalogs as the attribution pattern.

## 6. Sources

Primary [RIB]:

- RIB Civil product page: https://www.rib-software.com/de/rib-civil (overview, data formats, point clouds,
  BIM2AVA, machine control)
- CAD apps overview: https://www.rib-software.com/de/rib-civil/cad-applikationen (licensable app list)
- Querprofil app page: https://www.rib-software.com/loesungen/cad-tiefbau/alle-apps/querprofil and EN
  cross-section page:
  https://www.rib-software.com/en/solutions/cad-civil-engineering/all-apps/cross-section-editing (cross
  sections linked to gradient/width/ramp bands)
- iTWO civil "Alle APPs" brochure (16 pp., read in full):
  https://www.rib-software.com/fileadmin/user_upload/service-support/downloads/cad-tiefbau/iTWO-Civil-Alle-APPs-A4-WEB-2022.pdf
  (standard solution scope; Trassierung, Schleppkurve, Sichtweiten, Punktwolke, Grunderwerb, Mengenberechnung,
  Erdbauwerke, Querprofilbearbeitung, catalogs, Entwässerung, Wasserversorgung, Infrastrukturobjekte,
  VISAll3D, HViSt, 3D-Entwurf; REB/CPIXML/LandXML/DXF/OKSTRA/ALKIS/ISYBAU/PDF/KML details)
- Company history: https://en.wikipedia.org/wiki/RIB_Software

Primary [STRATIS] (training scripts, FH Augsburg, Straßenentwurf mit CAD I/II, P. Winter — menu-path-level
workflow evidence; STRATIS 10-era):

- Course scope: https://www.hs-augsburg.de/~rweber/Herr%20Winter/FH_Internetseite_CAD_I_II_190407.pdf
- Top-menu functions, Folien, snapping, options:
  https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_I_Skripte_011005/CAD_I_02_Funktionen_Topmenue_011005.pdf
- DGM chapter: https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_I_Skripte_011005/CAD_I_06_DGM_011005.pdf
- Grundriss constructions:
  https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_II_Skripte_010106/CAD_2_02_Konstruktion_Grundriss_010106.pdf
- Axis constructions + Tropfen:
  https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_II_Skripte_010106/CAD_2_03_Achskonstruktionen_Geometrische_Berechnungen_010106.pdf
- Gradiente/Aufriss:
  https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_II_Skripte_010106/CAD_2_07_Konstruktion_Aufriss_010106.pdf
- Querprofilberechnung/-konstruktion:
  https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_II_Skripte_010106/CAD_2_11_Querprofilsberechnung_Querprofilskonstruktion_010106.pdf
- STRATIS overview: https://de.wikipedia.org/wiki/STRATIS
- STRATIS→iTWO-5D integration press: https://www.baulinks.de/bausoftware/2013/0121.php4

Practitioner voices:

- CAD.de "Tief-/Straßenbausoftware gesucht, STRATIS vs. Civil3D vs …":
  https://ww3.cad.de/foren/ubb/Forum7/HTML/002466.shtml [STRATIS]+[C3D]
- CAD.de RIB forum, STRATIS→iTWO civil migration: https://ww3.cad.de/foren/ubb/Forum480/HTML/000024.shtml
  [STRATIS/RIB]
- Eurovia iTWO civil rollout:
  https://www.computer-spezial.de/artikel/grundlagen-fuer-den-uebergreifenden-bim-prozess-3277212.html [RIB]
- Capterra listing (0 reviews): https://www.capterra.com.de/software/208905/itwo-civil [RIB]

Secondary:

- Civil 3D German plan frames (Planrahmen) help:
  https://help.autodesk.com/cloudhelp/2019/DEU/Civil3D-UserGuide/files/GUID-879A407F-9F9F-49F3-842D-C6A1CA57AFD1.htm
  [C3D]
- Civil 3D DGM/breakline forum usage:
  https://forums.autodesk.com/t5/civil-3d-forum/dgm-erstellung-mit-bruchkanten/td-p/7957819 [C3D]
- card_1 module overview:
  https://www.card-1.com/en/product/overview-of-modules/all-modules-in-alphabetical-order/ [card_1]
- Autodesk Civil 3D, "About Creating an Alignment by Best Fit":
  https://help.autodesk.com/cloudhelp/2027/ENG/Civil3D-UserGuide/files/GUID-CC6B6C3F-57CC-41DE-9498-F3D969AD37A0.htm
  [C3D]
- Autodesk Civil 3D, "Entity by Best Fit Dialog Box" and regression inputs:
  https://help.autodesk.com/cloudhelp/2026/ENU/Civil3D-UserGuide/files/GUID-6AB452B3-32F8-4621-B9D7-3A65562E7DCE.htm
  [C3D]
- Autodesk Civil 3D, "Alignment Dialog Boxes" (Best Fit Alignment Report Vista and Horizontal Regression
  Analysis Vista):
  https://help.autodesk.com/cloudhelp/2027/ENU/Civil3D-UserGuide/files/GUID-304ECE1B-A963-41B2-8651-CFAEC58C07F9.htm
  [C3D]
- Laura Garach, Juan de Oña, Miguel Pasadas, "Mathematical formulation and preliminary testing of a spline
  approximation algorithm for the extraction of road alignments," _Automation in Construction_ 47 (2014), 1–9,
  https://doi.org/10.1016/j.autcon.2014.07.002 [research]
- James McCrae, Karan Singh, "Sketching Piecewise Clothoid Curves," _Computers & Graphics_ 33 (2009), 452–461,
  https://doi.org/10.1016/j.cag.2009.05.010 [research]

### Evidence quality statement

Strong: the app-level function catalog and data-exchange scope of the current product (vendor brochure read in
full, 16 pages) and the exact drafting/DGM/ alignment/gradient/cross-section workflows with menu paths
(university training scripts for STRATIS, read in full as PDFs). Medium: the assumption that STRATIS-era
interaction details carry over to today's RIB Civil — the vendor markets iTWO civil as the same data model
with a new shell, and a practitioner complaint from the migration era confirms continuity (also of the
rigidity), but no current-version manual was publicly available; current UI surfaces (ribbon vs. menus) could
not be verified. Weak: practitioner sentiment rests on two CAD.de threads (2006-era pricing, 2013-era
migration) plus one case study; the Capterra page has zero reviews, so no recent broad user feedback exists.
Not found despite searching: a public RIB Civil user manual, current screenshots of the cross-section or
plan-production UI, and any public card_1-vs-RIB comparison; card_1 is therefore cited only for the market
convention of modular element-based civil CAD. No feature in this dossier is invented; every table row traces
to one of the flagged sources.
