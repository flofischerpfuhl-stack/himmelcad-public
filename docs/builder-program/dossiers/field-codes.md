# Reference dossier: field codes, structured object codes, and geometry-to-object generation

Status: research dossier, 2026-09-02. Evidence for `docs/FUNCTION-CONTRACT.md` A2 derivations and owner decision D6; never normative by itself.

Scope: survey feature coding, German structured object identifiers, sewer data exchange, and the conversion of measured point/line/area geometry into CAD or BIM objects. The question is not merely whether a product stores a code, but what the code resolves to, which data remain separate attributes, and what object actually exists after import.

Claims are cited to the source register in § 8. No claim in this dossier is from memory; where public evidence was not found, the absence is stated rather than filled with practitioner recollection.

---

## 1. Findings at a glance

The surveyed products converge on a three-part pattern: a reusable code library/catalog defines meaning; a measured record carries a feature code plus typed attributes; and geometry-control information says how observations form points, strings, curves, or polygons. Trimble uses an FXL feature library in both Access and Business Center; Leica uses an Infinity Code table exported as a Captivate codelist; Civil 3D uses description keys, figure prefixes, and a linework code set. [T1, T4, L1, A1, A2]

These parts must not be conflated. In Trimble, a numeric suffix such as `Fence01` distinguishes one string from another `Fence02`; its attributes can still come from the base code `Fence`. Attributes are separately defined and entered values. Thus “code + attribute suffix” is not an accurate statement of the Trimble contract: there is a **string suffix** and there are **attributes**, with different purposes. [T2, T3]

Office processing usually produces survey/CAD/GIS features, not a complete domain BIM object. Trimble Business Center creates processed point features, linestrings, and polygons; Leica Infinity applies blocks, layers, line styles, and attribute-driven block scaling; Civil 3D creates COGO points and survey figures. None of the reviewed field-coding sources says that a manhole code by itself instantiates a complete parametric sewer manhole. [T5, L1, A1, A2]

The closest well-documented semantic conversion is a separate command. Civil 3D can convert an existing line, polyline, feature line, alignment, or survey figure into a pipe/pressure network after the user chooses a parts list, sizes, layers, surface/elevation rules, and direction. Revit likewise places a chosen type at a point or along a curve and can create a wall of a selected type by picking an existing line. [A3, A4, V1, V2]

German standards do support structured codes, but for different purposes. ALKIS/ATKIS uses hierarchical numeric object-kind identifiers; ISYBAU defines position-dependent identifiers for network objects; card_1 supports prefix-number-postfix codes. OKSTRA, by contrast, is primarily a typed schema with named object classes and separately cataloged `Fachbedeutung` values, not evidence for one universal numeric type code. [G1, G2, G3, I3, C1]

The name **easyBAU** could not be identified as a sewer-planning product with a vendor and documented native import/export formats. The authoritative name is **ISYBAU-Austauschformate Abwasser**. Some third-party pages and a conference transcript render that name as “EasyBAU/Easy-Bau,” but the latter explicitly describes the official ISYBAU XML format. D6 should therefore say **ISYBAU XML compatibility**, unless the owner can supply a different product reference. [I1, E1, E2]

---

## 2. Survey field and feature coding

### 2.1 Trimble Access and Trimble Business Center

An Access feature library (`.fxl`) defines feature codes, attributes, linework, symbology, and control codes. Trimble supplies `GlobalFeatures.fxl`; custom FXL files can be authored in Business Center's Feature Definition Manager and put on the controller. Access can edit a smaller subset, while attribute definitions and symbols require the office manager. [T1, T4]

When a surveyor selects a feature code for a measured point, Access can prompt for attributes defined by that feature. Attributes are properties such as a road name, surface, width, or lane count; definitions may include required values and defaults. Code buttons can be grouped and arranged for rapid field entry. [T1, T2]

Access offers two linework storage models. In “feature-coded linework,” codes and attributes live on measured points and the linework is reconstructed from them. In “stored polylines,” the line/polygon and its code are stored directly in the job; the constituent points need not carry the line code. [T2, T3]

For several simultaneous features of the same kind, stringing appends a numeric suffix: points with `Fence01` form one feature and points with `Fence02` form another. With “Use attributes of base code,” both resolve their attribute definition from `Fence`. Suffix formats may be `1`, `01`, `001`, or `0001`. [T3]

Control codes express topology and construction, not domain type. Access supports start/end join sequences, joining to the first or a named point, curves, offsets, circles, rectangles, and related linework operations. In the code field a control code follows the line feature code, separated by a space; one documented pattern is `<Line code> <Join to named point> 123`. [T6, T7]

Business Center imports the same FXL definition and runs **Process Feature Codes**. It can produce the point symbols and feature-coded geometry needed for display and CAD/GIS export. A code absent from the active Feature Definition Library is retained as text but ignored by processing and listed in the processing report. Attribute changes can optionally split a linestring or polygon. [T4, T5]

Processed feature data retain an important source/derivation distinction. A manually edited processed object can be locked so that reprocessing does not overwrite it. This is useful precedent for keeping imported observations and derived objects linked without making every rebuild destructive. [T5]

**Limit of the evidence:** Trimble calls the results point, line, and polygon “features.” The reviewed documentation does not show an FXL code selecting a parametric utility-parts catalog and generating a complete manhole, pipe network, wall, or room. D6 extends the pattern from feature processing into semantic BIM generation; that extension must be an explicit Himmel:CAD design, not attributed to Trimble.

### 2.2 Leica Captivate and Infinity

Infinity's **Code table** manages codes, attributes, and styling. It exports a codelist for Captivate, Viva, System 1200, iCON, or Zeno; collected coded data return to an Infinity project, where the attached Code table automatically applies the corresponding styles. [L1]

Codes categorize point, line, area, or free-code features. Attributes are linked fields and can be text, choice lists, constrained ranges, or defaults. Captivate can prompt for them under rules defined by the codelist. A special linework property/string identifies how measurements join into a linear feature. [L1, L2]

Captivate treats linework metadata separately from the thematic code. Its linework actions include begin/continue/end line, best-fit arcs and splines, and close-line operations. A configurable linework flag is stored with a point so third-party office software can interpret the linework; newer Captivate can also copy the line ID and flag into point code information for point-based exports. [L2, L3]

Infinity's import result is richer than plain points but still chiefly CAD/GIS presentation: points receive assigned blocks, lines receive styles, and features go to assigned layers. Code attributes can scale a 2D or 3D block, for example by a tree-canopy dimension. Imported feature positions and their presentation update when survey processing changes the coordinates. [L1]

Infinity can export coded points and lines, attributes, and linework flags in Autodesk FBK form for Civil 3D, or export thematic features to DWG/DXF. This is evidence for preserving semantic capture data through adapters, not for using one vendor's field-file representation as the canonical model. [L1, L4]

**Limit of the evidence:** the reviewed Leica sources do not define a universal numeric digit layout and do not claim that code processing produces native BIM walls or sewer-network components. Blocks may be 3D and attribute-scaled, but a block representation is not equivalent to a parametric manhole object.

### 2.3 Topcon MAGNET

Topcon identifies MAGNET Field as its GNSS/total-station field controller for collecting points and mapping structures and utilities, with exchange to MAGNET Office and Autodesk/Bentley workflows. An official Topcon GIS webinar specifically lists layers, customized codes, multicodes, attributes, images, notes, and import/export formats. [P1, P2]

Topcon also publishes a support item for transferring a code library from MAGNET Office to MAGNET Field. The item is sign-in gated, so it confirms the shared-library workflow but exposes no inspectable syntax or processing rules. [P3]

**Evidence boundary:** no public, current MAGNET manual was found that lets this dossier verify code grammar, line-control tokens, attribute typing, or exactly which office objects are generated. Topcon corroborates the market convention of library-backed codes and attributes, but should not independently justify a Himmel:CAD parsing or generation rule.

---

## 3. How CAD/civil systems consume field codes

### 3.1 Autodesk Civil 3D description keys and survey figures

A Civil 3D raw point description may contain up to ten space-separated alphanumeric elements. The leading element is matched case-sensitively against a description-key code; later elements are positional parameters. Wildcards broaden matching. A matching key can assign point style, label style, layer, symbol scale/rotation, and a formatted full description. [A1]

The format tokens `$0`, `$1` ... `$9`, `$+`, and `$*` can reorder or retain raw description elements. Autodesk's example `TREE OAK 7` matches `TREE`; a format can use `OAK` and `7` as parameters for the readable label and symbol scale. This is a positional import grammar, not a typed-attribute storage model. [A1]

Field line codes additionally include commands for begin, continuation, end, curve, and line segments. Civil 3D maps feature prefixes to figure properties such as layer, color, linetype, lineweight, and breakline status, then connects COGO points into survey figures. Import can process by import order or point number using the selected linework code set. [A2, A5]

Therefore, a measured code initially becomes a COGO point and possibly a survey figure with standardized presentation and surface/breakline behavior. A code such as a sewer-manhole description key can choose its point symbol and layer; it does not thereby prove creation of a native pipe-network structure. [A1, A2]

Civil 3D performs semantic network generation as a subsequent command. **Create Pipe Network From Object** converts a line, arc, 2D/3D polyline, spline, feature line, or alignment into pipes and structures. The user selects a parts list, pipe and structure types, layers, optional surface/alignment, and whether vertex elevations mean crown, centerline, invert, or another reference. [A3]

The pressure-network counterpart also accepts a survey figure and asks for direction, parts list, size/material, reference surface, cover or vertex elevation rule, and optional source deletion. This is the closest direct reference for D6's “measured line + declared role + parameters -> real object” flow, including why preview and explicit missing-parameter handling matter. [A4]

### 3.2 RIB Civil / STRATIS specifications and point codes

Current RIB Civil documentation confirms survey-data processing and exchanges including DXF/DWG, OKSTRA, LandXML, SHAPE, ISYBAU, CPIXML, and IFC. It does not publicly document current field-code syntax or the specification editor. [R1]

The available detailed evidence is the STRATIS-era Augsburg teaching manual already used by the RIB Civil dossier. It describes an object-oriented plan in which each graphic element's **Spezifikation** controls lineweight, dash, color, symbols, hatching/fill, and optionally its target **Folie** (layer). Point, line, area, text, label, and slope specifications are stored in `*.SPZ` tables. [R2]

The **F9** box selects the current specification and whether new point, line, text, slope, area, and dimension elements go to the current layer or the layer defined by the specification. “Set” makes a specification current; “Take” copies one from an existing element; “Apply” transfers the current specification to an existing element. [R2]

A point specification has a unique numeric code plus an optional description, a short text of up to ten alphanumeric characters used by the point database, a layer, color, lineweight, and optional symbol. The manual's examples include point specification `6130` for a traffic signal, line specification `5110` for a water-protection boundary, and area specification `2300` for a residential building. Line and area specifications use the same numeric-code concept. [R2]

This directly grounds three parts of D6: numeric catalog keys, a persistent current specification during drawing, and immediate specification-driven layer assignment. It does **not** ground a seven-digit type/size layout, typed attribute suffixes, or code-driven generation of a native BIM object.

The manual also lists a point's **Punktcode** separately from its **Spezifikation** in point output, and reports field-entry errors in point number, coding, and prism height. Public material reviewed here does not expose the rule that maps a survey point code to a specification code on import. Those terms must not be treated as proven synonyms. [R2, R3]

### 3.3 card_1 coding

card_1 calls codes central project information: coding gives points, topographic data, alignments, and other data their technical meaning and controls their screen and drawing presentation. Its survey modules exchange points and raw measurements with Trimble, Leica, and Topcon field books. [C1, C2]

Version 9.1 permits 16-character alphanumeric codes while retaining numeric codes. Code tables use `*.COD`; raw measurement data also carry alphanumeric point codes. A code may consist of an alphanumeric prefix, a number (optionally with a decimal point), and an alphanumeric postfix. Sorting and wildcard filters understand that structure. [C1, C3]

This is good evidence for catalog-defined structured keys and for accepting both legacy numeric and expressive alphanumeric schemes. The reviewed card_1 sources do not demonstrate code-to-parametric-BIM generation or a mandated meaning for fixed digit positions.

---

## 4. German structured-code conventions

### 4.1 ALKIS/ATKIS object-kind identifiers

The AdV AAA object catalog assigns hierarchical numeric **Kennungen**. In the 2D application schema, `30000` is the object area “Buildings,” `31000` the group “Building information,” `31001` `AX_Gebaeude`, `31002` `AX_Bauteil`, `31003` a special building line, and `31005` a special building point. Other areas and groups use the same five-digit hierarchy. [G1]

The 3D catalog uses a related but distinct six-digit namespace: `100000` is the 3D building/structure area, `101000` the 3D building-information group, and `101001` through `101005` include component, closure, floor, roof, and wall surfaces. [G4]

Adoptable lesson: leading positions can make a catalog browsable and allow coarse classification before the leaf is resolved. Deviation: the different 2D/3D lengths show that a digit layout is schema/version-specific, not an eternal universal grammar. Himmel:CAD should preserve codes as strings and let each registered prefix declare its layout.

### 4.2 OKSTRA object types and Fachbedeutungen

OKSTRA publishes a versioned UML object model, XML schemas split by subject package, key tables, and an automatically derived object-kind catalog. Geometry uses GML 3.2.2. The object types themselves are named schema classes such as objects in `S_Entwaesserung`; the official material reviewed does not assign them ALKIS-like fixed numeric object-kind identifiers. [G2]

For generic point, line, area, and volume objects, OKSTRA provides a separate `fachliche_Bedeutung` value from published Fachbedeutung lists. The rule is to use a proper domain object type when one exists and a generic geometry plus Fachbedeutung only when no suitable domain type can be assigned. [G5]

A Fachbedeutung code is an alphanumeric string of one to ten characters; digits, letters, `.`, `-`, and `#` are allowed. The code plus symbol kind must be unique within a list, and a separate state-specific code may also be carried. This is evidence for versioned meaning catalogs and geometry-role validation, but negative evidence for claiming that OKSTRA mandates numeric type prefixes. [G3]

### 4.3 ISYBAU object identification

The BFR Abwasser naming scheme for manholes is explicitly positional. Digit 1 identifies the drainage system (`1` stormwater, `2` wastewater, `3` combined, `4` watercourse, `5` special system, `6` drainage); digits 2-3 identify a subnetwork/main collector; digits 4-6 are the running manhole number; digits 7-10 remain available for project-specific qualification. [I3]

A **Haltung** (the pipe reach between nodes) normally takes the identifier of its upstream node in flow direction. A Leitung similarly takes its upstream node; branch identifiers such as `RR01`-`RR99` or `SE01`-`SE99` distinguish multiple lines. This makes direction and topology part of the identification discipline. [I4]

This strongly grounds the _idea_ of position-dependent numeric fields in D6. It is nevertheless an **instance/network identifier**, not a product/type key: the positions tell which system, subnetwork, and numbered manhole an asset is, not which parametric manhole family and diameter should be generated.

---

## 5. Sewer objects and exchange formats

### 5.1 ISYBAU XML

The proper current name is **ISYBAU-Austauschformat Abwasser (XML-2024)**. It is a publicly documented, schema-validated exchange format for geometry and technical data used in planning, construction, operation, condition, hydraulics, and presentation of wastewater assets. XML versions began in 2006; the 2024 revision was incorporated into the January 2025 BFR Abwasser. [I1, I2]

The master-data model distinguishes **edges** and **nodes**. An asset is keyed by the combination of `Objektbezeichnung` and edge/node `Objektart`, with an optional 32-character LISA GUID. Edges identify upstream and downstream nodes and their types and store invert elevations, 3D length, material, profile, and one of Haltung/Leitung/Rinne/Gerinne. [I2]

Pipe profiles have an explicit profile kind or library ID, width/height, outside diameter, and special-profile coordinates. Nodes specialize into manholes, connection points, and structures; a manhole carries a referenced function code, measured depth, access/step data, connections, covers, and other technical fields. [I2]

Consequently an ISYBAU export cannot be produced faithfully from only a point code and XY(Z) coordinate. At minimum, topology, object identity, drainage kind, elevation semantics, profile/material/size, and required format metadata must be resolved or reported missing. The import/export implementation should target the published XSD version and preserve unknown fields for round trips. [I1, I2]

### 5.2 DWA-M 150 and its replacement

DWA-M 150 (April 2010, corrected November 2018) defined a uniform interface for condition capture and assessment of drainage systems outside buildings, based on DIN EN 13508. It addressed inspection/condition exchange rather than being a general BIM authoring or sewer-planning object catalog. [D1]

Its XML field identifiers use groups such as `HG` (pipe-reach master data), `KG` (node/manhole master data), `HI/KI` (inspection), `HZ/KZ` (condition), and `GO/GP` (geometry object/point), with field identifiers shaped as two uppercase letters plus three digits, e.g. `FD002`. This exact field-level account is from a vendor implementation help page, not the paywalled DWA text, so it is medium quality evidence. [D3]

DWA-M 150 is no longer current: DWA states that DWA-M 145-3 (December 2025) replaced it and adds explicit network topology, richer object geometry, and more subject areas. A new implementation should not advertise only “M 150 compatibility”; it should disposition DWA-M 145-3 and any legacy M 150 adapter separately. [D2]

### 5.3 easyBAU identity finding

No distinct sewer-planning software product named **easyBAU** was identified from vendor, standards-body, manual, product, or format-specification sources. Accordingly, no honest vendor name or native import/export format list can be given.

The strongest contrary-looking source is a Graebert article about cseTools for ARES Commander. It names “EasyBAU, EasyBAU XML, DWA M150” interfaces and an “EasyBAU-XML” export, but provides no product vendor or schema. [E1]

A FOSSGIS conference record repeatedly transcribes “Easy-Bau,” yet its title, abstract, and technical content identify the subject as the official **ISYBAU XML wastewater exchange format** and its published XSDs. This supports the conclusion that “easyBAU” is a spelling/hearing variant of ISYBAU in this context, not a separately identified product. [E2]

**D6 correction:** replace “easyBAU export compatibility” with “ISYBAU XML import/export compatibility, exact schema version to be specified.” If the owner meant a private or regional application, its vendor name, sample file, and interface documentation are required before it can become a format row.

---

## 6. Role-based generation from measured geometry

| Reference workflow                              | Input                                    | Catalog/role selection                                        | Result                                                      | D6 lesson                                                                                      |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Trimble Business Center feature processing [T5] | coded observations                       | active FXL definition                                         | point feature, linestring, polygon, attributes/presentation | adopt shared field/office catalog and diagnostics; do not call the result BIM                  |
| Leica Infinity feature processing [L1]          | coded measurements                       | attached Code table                                           | blocks, styled line/area features, layers                   | adopt typed attributes and live rebuild; 3D block is not sufficient domain semantics           |
| Civil 3D survey import [A1, A2]                 | raw descriptions and observations        | description keys, prefixes, linework set                      | COGO points and survey figures                              | preserve raw code and separate string topology from feature meaning                            |
| Civil 3D network from object [A3, A4]           | line/polyline/feature/survey figure      | parts list, pipe/structure type, direction and elevation role | native pipe or pressure network                             | adopt an explicit conversion/completion step with preview                                      |
| Revit component placement [V1]                  | point or curve plus selected symbol/type | family symbol and host/level/view                             | native family instance                                      | catalog row may constrain allowed source geometry and required context                         |
| Revit wall by picked line [V2]                  | existing line/edge/face                  | wall type, height, location line, offset, orientation         | native wall instance                                        | “what this line represents” can generate a typed object, but parameters remain visible choices |

Adopt the references' separation of capture and derivation. Imported measured records remain authoritative observations; generated objects record their source IDs, catalog revision, role, parameters, and completion state. Re-running resolution should be deterministic, previewable, cancellable, and should not silently overwrite user-edited derived objects. [T5, A3, A4]

Deliberately deviate from style-only import. A resolved manhole code may first show a preview/placeholder, but “complete” must mean a canonical manhole entity with validated dimensions, elevation references, topology, and provenance, not a scaled symbol on a sewer layer. [L1, I2]

Deliberately deviate from silent fallback. Trimble ignores unknown feature codes during processing but reports them; Himmel:CAD should retain every raw row, report unmapped/ambiguous codes before commit, and let the user map or defer them. It must never infer coordinates, invert levels, cover levels, flow direction, diameter, or material. [T5, I2]

---

## 7. Mapping hints for Himmel:CAD

### 7.1 `bim-specs`: one catalog, explicit code schemas

- Make the specification code the stable string key of a catalog type row, consistent with STRATIS numeric specification codes and Revit-like definition -> type -> instance generation. Preserve leading zeroes. [R2, V1]
- Register digit layouts **per prefix and schema version**, rather than baking one seven-digit grammar into import code. A D6 layout such as `09 | 41 | 100` can mean domain | manhole family | nominal-size variant for that prefix, while another catalog can use ALKIS-like five digits or card_1 alphanumeric prefix-number-postfix codes. [G1, G4, C3]
- Keep three distinct fields: `type_code` (catalog lookup), `string_id` or `feature_instance_suffix` (which observations join), and typed `attributes` (width, material, height, direction, notes). Trimble provides the clearest evidence that these are not interchangeable. [T1, T3, T6]
- Let each catalog definition declare allowed source geometry (point, line, area), semantic role, required attributes, generator, default presentation, and target layer. Reject a point-to-wall or open-line-to-room conversion unless the definition provides an explicit completion workflow. [L1, G3, V1, V2]
- Store the raw external code, resolved internal type ID, catalog/schema version, and resolution diagnostics. Do not derive durable semantics by reparsing a display label after the catalog changes. [T5, I1]

### 7.2 `draw`: current specification and shortcuts

- Adopt STRATIS's current-specification behavior: choosing a specification makes it current; subsequently drawn compatible geometry receives its style and target layer in the same journaled command. F9 has direct reference grounding for opening the selection surface. [R2]
- The shortcuts panel should pin catalog rows, not copy them. A shortcut click changes the one canonical current-specification state used by point, line, and area tools; catalog changes then remain coherent across Draw and import.
- Show code, concise name, geometry-role icon, and validation state. Keep the owner's unbounded pinned set with eight visible as a product choice, not as a behavior attributed to STRATIS, Leica, or Trimble.
- When an existing entity is re-specified, distinguish a presentation-only change from regeneration of semantic geometry and preview destructive consequences. STRATIS “Apply” proves reassignment of style/layer, not safe regeneration of a BIM object's geometry. [R2]

### 7.3 `import-formats`: CSV code column to canonical entity

- Extend CSV/XYZ column mapping with `code`, optional `string/control`, and named attribute columns. Provide adapters for positional raw descriptions such as Civil 3D's leading-code plus `$1`...`$9` parameters, but normalize them into typed attributes before entity generation. [A1]
- Resolve in a preflight pass: raw code -> registered code schema -> catalog type -> allowed geometry role -> required parameters -> proposed entity kind, layer, presentation, and generator. Show counts for resolved, incomplete, ambiguous, unknown, and invalid rows before commit. [T5, I2]
- Process line-control codes/string IDs into source geometry first; only then run role-based BIM generation. This mirrors Trimble/Civil 3D survey processing followed by Civil 3D's separate network conversion and makes error recovery intelligible. [T2, A2, A3]
- A cover-point code may resolve to “stormwater manhole, nominal 1.0 m,” but the import must leave the object incomplete until the required cover/invert interpretation, depth or invert level, orientation where relevant, and topology are supplied. The measured coordinate remains unchanged. [I2]
- A line code may resolve to a wall or pipe type, but direction, side/location line, height/elevation reference, and connectivity must be explicit catalog defaults or prompted parameters. Civil 3D and Revit expose these choices rather than pretending the source line contains them. [A3, A4, V2]
- Commit the import and all generated entities as a bounded, journaled command with provenance back to file, row, measured observation, raw code, and catalog revision. Cancellation must leave neither orphan source geometry nor half-generated networks.

### 7.4 Three consequential conclusions for D6

1.  **The numeric vision has real precedent, but not the exact grammar.** STRATIS proves numeric specification keys/current selection/layer targeting; ALKIS and ISYBAU prove meaningful digit positions. The precise `09|41|100` layout remains Himmel:CAD/owner-defined and should be catalog-versioned.
2.  **Suffixes are not attributes.** Trimble's suffix identifies a particular line string; attributes are separate typed values. D6 should model catalog code, feature/string identity, control code, and attributes separately.
3.  **Code resolution and BIM generation are two stages.** Field references create survey/CAD features; Civil 3D/Revit show a further typed conversion with parts/type and elevation/orientation choices. A measured code can select a generator, but completeness must be validated and user-visible.

---

## 8. Sources

### Trimble

- [T1] Trimble Access Help, “Configuration files” and FXL contents — <https://help.fieldsystems.trimble.com/trimble-access/latest/en/downloads-templates.htm>
- [T2] Trimble Access Help, “Measuring with feature codes” — <https://help.fieldsystems.trimble.com/trimble-access/2025.20/en/measure-codes.htm>
- [T3] Trimble Access Help, “Measure code options” (string suffix and base-code attributes) — <https://help.fieldsystems.trimble.com/trimble-access/latest/en/measure-code-options.htm>
- [T4] Trimble Business Center Help, “Feature Definition Manager” — <https://help.fieldsystems.trimble.com/tbc/1868_1.htm>
- [T5] Trimble Business Center Help, “Process Feature Codes” — <https://help.fieldsystems.trimble.com/tbc/5001.htm>
- [T6] Trimble Access Help, “Measuring multiple lines using stringing” — <https://help.fieldsystems.trimble.com/trimble-access/latest/en/measure-codes-stringing.htm>
- [T7] Trimble Access Projects and Jobs Guide, feature geometry control codes (2018.10, PDF) — <https://help.trimblegeospatial.com/TrimbleAccess/2018.10/en/PDFs/TA_Projects_and_Jobs.pdf>

### Leica and Topcon

- [L1] Leica Geosystems, “Feature coding in Leica Infinity” — <https://leica-geosystems.com/en-gb/products/gnss-systems/software/leica-infinity/feature-coding>
- [L2] Leica Captivate Technical Reference Manual v3.0 (public mirror of Leica manual; pp. 326-335 cover coding and linework) — <https://www.manualslib.com/manual/1888980/Leica-Captivate.html>
- [L3] Leica Geosystems, Captivate feature history (v2.30 configurable linework flags; v8.30 line ID/flag copied into point code information) — <https://leica-geosystems.com/en-gb/products/total-stations/software/leica-captivate/leica-captivate-the-next-great-release> and <https://leica-geosystems.com/products/total-stations/software/leica-captivate/new-features>
- [L4] Leica Geosystems, Infinity v5.0 release notes (Autodesk FBK export) — <https://leica-geosystems.com/-/media/files/leicageosystems/products/datasheets/release%20notes%20leica%20infinity%20v500%202.ashx>
- [P1] Topcon, MAGNET Field product page — <https://www.topconpositioning.com/gb/en/solutions/technology/infrastructure-software-and-services/field>
- [P2] Topcon, MAGNET Field GIS webinar description — <https://www.topconpositioning.com/es/es/campaigns/webinar-magnet-field-modulo-gis>
- [P3] Topcon support, “Transferring a code library to MAGNET Field” (sign-in required) — <https://mytopcon.topconpositioning.com/ie/support/article/magnet-office-transferring-code-library-magnet-field-video>

### Autodesk, RIB/STRATIS, and card_1

- [A1] Autodesk Civil 3D Help, “About Description Keys” and format reference — <https://help.autodesk.com/cloudhelp/2023/ENU/Civil3D-UserGuide/files/GUID-A411F11B-2546-4950-8D5D-FE2FDAE7E75D.htm> and <https://help.autodesk.com/cloudhelp/2022/ENU/Civil3D-UserGuide/files/GUID-3E7422F2-F6D9-4AAD-A997-04678401CE41.htm>
- [A2] Autodesk Civil 3D Help, “About Field Codes, Figure Prefixes, and Description Keys” — <https://help.autodesk.com/cloudhelp/2023/ENU/Civil3D-UserGuide/files/GUID-2DC2AA57-057B-41AC-BA2E-C893FF01A300.htm>
- [A3] Autodesk Civil 3D Help, “About Creating Pipe Networks From Objects” — <https://help.autodesk.com/cloudhelp/2022/ENU/Civil3D-UserGuide/files/GUID-A2BC9557-7AD8-4CCC-84E9-BCF27279C0F4.htm>
- [A4] Autodesk Civil 3D Help, “To Create Pressure Networks from Objects” — <https://help.autodesk.com/cloudhelp/2024/ENU/Civil3D-UserGuide/files/GUID-3B5A3079-BE1F-44F4-910E-81C538B8FBEA.htm>
- [A5] Autodesk Civil 3D Help, LandXML survey import/re-import settings — <https://help.autodesk.com/cloudhelp/2026/ENU/Civil3D-UserGuide/files/GUID-C63F11C5-B48A-4592-888B-FE469100226A.htm>
- [V1] Autodesk Revit API, `Document.NewFamilyInstance` overloads for point and curve placement — <https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/0c0d640b-7810-55e4-3c5e-cd295dede87b.htm>
- [V2] Autodesk Revit Help, “Place a Wall” (type, height, location line, Pick Lines) — <https://help.autodesk.com/cloudhelp/2020/ENU/Revit-Model/files/GUID-05BAFEAA-5186-484E-80F4-8D900C454748.htm>
- [R1] RIB Software, RIB Civil product page — <https://www.rib-software.com/de/rib-civil>
- [R2] Hochschule Augsburg, P. Winter, “Funktionen Topmenü,” STRATIS training manual, especially pp. 27, 39-46 — <https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_I_Skripte_011005/CAD_I_02_Funktionen_Topmenue_011005.pdf>
- [R3] Hochschule Augsburg, P. Winter, DGM training manual, error sources in measured coding — <https://www.hs-augsburg.de/~rweber/Herr%20Winter/CAD_I_Skripte_011005/CAD_I_06_DGM_011005.pdf>
- [C1] card_1, version 9.1 survey release notes, “Alphanumerische Kodes” — <https://www.card-1.com/fileadmin/files/help/91_de/install/content/change_newin/vermessung.htm>
- [C2] card_1, survey module overview — <https://www.card-1.com/produkt/moduluebersicht/vermessung>
- [C3] card_1, “Einstellungen und Kataloge” (code tables and prefix-number-postfix structure) — <https://www.card-1.com/fileadmin/files/help/91_de/install/content/change_newin/einstellungen.htm>

### German catalogs and sewer standards

- [G1] AdV, AAA object catalog 7.1.2, Basis-DLM/2D overview — <https://www.adv-online.de/sites/default/files/documents/2026-08/Objektartenkatalog_BasisDLM.html>
- [G2] BASt/OKSTRA, current schema downloads and catalog documentation — <https://okstra.bast.de/schema.html>
- [G3] OKSTRA N0140, “Aufbau von Fachbedeutungs-Codes,” § 2.5 — <https://www.okstra.de/docs/n-dokumente/n0140.pdf>
- [G4] AdV, AAA 3D object catalog 7.1.2 — <https://www.adv-online.de/sites/default/files/documents/2026-07/Objektartenkatalog__AFIS-ALKIS-ATKIS_Anwendungsschema3D_711_.html>
- [G5] OKSTRA, package `S_Allgemeine_Geometrieobjekte` and domain-object rule — <https://www.okstra.de/docs/2023/html/EARoot/EA3/EA495.htm>
- [I1] BFR Abwasser, “ISYBAU-Austauschformate Abwasser (XML), Allgemeines” — <https://www.bfr-abwasser.de/html/A7ISYBAU_ATF_XML.html>
- [I2] BFR Abwasser, XML-2024 master data for wastewater assets — <https://www.bfr-abwasser.de/html/ISYBAU_Austauschformate_Abwasser.14.08.html>
- [I3] BFR Abwasser, naming scheme for manholes, structures, and connection points — <https://bfr-abwasser.de/html/definitionen.07.03.html>
- [I4] BFR Abwasser, naming scheme for Haltungen, lines, channels, and gutters — <https://bfr-abwasser.de/html/definitionen.07.04.html>
- [D1] DWA, DWA-M 150 publication description — <https://shop.dwa.de/DWA-M-150-Datenaustauschformat-fuer-die-Zustandserfassung-von-Entwaesserungssystemen-April-2010-Stand-korrigierte-Fassung-November-2018/M-150-PDF-10>
- [D2] DWA, DWA-M 145-3 publication notice and withdrawal of DWA-M 150 — <https://de.dwa.de/app.php/de/regelwerk-news-volltext/merkblatt-dwa-m-145-3-kanalinformationssysteme-teil-3-anforderungen-an-ein-datenmodell-und-schnittstelle.html>
- [D3] Barthauer BaSYS help, DWA-M 150 identifiers and format groups — <https://help.barthauer.de/BaSYS/9.21.1/02_BaSYS/IE/DWA_M150/IE_DWA_M150.htm>
- [E1] Graebert, cseTools for ARES Commander (uses the labels “EasyBAU” and “EasyBAU XML”) — <https://www.graebert.com/de/blog/general-news/die-csetools-fur-ares-commander-leistungsstark-in-der-siedlungswasserwirtschaft/>
- [E2] FOSSGIS 2018 / TIB, “Jetzt in Ihrem QGIS: ISYBAU XML-Abwasserdaten” — <https://av.tib.eu/media/36135>

### Evidence quality statement

**Strong:** Trimble's current field/office feature-library and processing contract; Leica Infinity's code-table workflow; Civil 3D description-key, linework, and network-conversion behavior; the STRATIS `*.SPZ`/F9/numeric-code details in the full university manual; card_1's current code structure; and the ALKIS/ATKIS, OKSTRA, and ISYBAU claims all come from vendor or standards-owner documentation reviewed directly. ISYBAU XML-2024 gives field-level evidence for sewer topology and parameters.

**Medium:** Captivate's detailed coding UI is supported by a public mirror of Leica's technical manual plus Leica release notes. DWA-M 150's exact field-ID groups come from the BaSYS implementation help because the full DWA text is paywalled. Current RIB Civil continuity with STRATIS specifications is not asserted beyond the current vendor's high-level capabilities.

**Thin/negative:** Topcon's public pages confirm custom codes, multicodes, attributes, and code-library transfer but not syntax or generated object kinds. No public current RIB Civil manual established modern point-code mapping. No source established that Trimble, Leica, Topcon, STRATIS, or card_1 turns a lone field code into a complete native BIM manhole. No distinct product named easyBAU could be identified; available evidence instead points to misspelling or phonetic rendering of ISYBAU. These gaps must remain explicit until a manual, sample dataset, or owner-supplied product identity resolves them.

**From-memory claims:** none.
