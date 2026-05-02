# Himmelcad Data Model

## Goals

The data model must support:

- huge point clouds without copying data,
- CAD entities and future IFC/DXF/GIS-like attributes,
- high-resolution meshes and Gaussian splats,
- undo/redo,
- semantic diffs for future Chronogit,
- browser read-only viewing,
- later simulations without changing the foundation.

## Core Concepts

### Entity

An entity is the stable semantic unit in the project tree.

```text
Entity {
  id: EntityId,
  kind: EntityKind,
  name: String,
  parent: Option<EntityId>,
  children: Vec<EntityId>,
  geometry: Option<ObjectRef>,
  attributes: ObjectRef,
  style: StyleRef,
  transform: TransformRef,
  derivation: Option<DerivationRef>,
  visibility: VisibilityState,
  schema_version: u32,
  version_hash: ObjectHash
}
```

Rules:

- entity IDs are stable and semantic,
- geometry blobs may be huge and immutable,
- attributes are separate from geometry,
- transforms are explicit, not baked into source geometry unless exported,
- all mutations happen through commands.

### Entity Kinds

Initial and planned kinds:

- `ProjectRoot`
- `Group`
- `Layer`
- `PointCloud`
- `PointCloudSegment`
- `SinglePoint`
- `Polyline3D`
- `Mesh`
- `TexturedMesh`
- `GaussianSplatCloud`
- `Text`
- `Axis`
- `AlignmentElement`
- `IfcElement`
- `Pipe`
- `Manhole`
- `SimulationOverlay`

The MVP needs only:

- `ProjectRoot`
- `Group`
- `PointCloud`
- `PointCloudSegment`

## Point Clouds

Imported point clouds are source entities.

```text
PointCloudGeometry {
  bounds_f64,
  point_count,
  tile_index_ref,
  source_metadata_ref,
  available_attributes: [rgb, intensity, classification, return_number, ...]
}
```

Point data is immutable. Edits and segmentations create derived entities.

### Segments

Segmentation does not duplicate point data.

```text
PointCloudSegment {
  source_entity: EntityId,
  include_filter: SelectionSpec,
  exclude_filter: Option<SelectionSpec>,
  materialized_blob: Option<ObjectRef>
}
```

After extracting a selection:

```text
PointCloud_A
  Extracted_001
  Remaining_001
```

`Extracted_001` references selected point IDs/ranges/masks. `Remaining_001`
references the inverse filter. The original source remains unchanged.

Selection specs can be:

- tile-local bitset,
- point ID ranges,
- spatial query spec,
- classification/intensity predicate,
- command-produced mask object.

MVP should use tile-local sparse bitsets where practical because they are simple,
fast, and diffable.

## Attributes

Attributes are nested and typed.

```text
AttributeValue =
  Null |
  Bool |
  Int64 |
  Float64 |
  String |
  Vec3F64 |
  ColorRgba |
  DateTime |
  Array(AttributeValue) |
  Object(Map<String, AttributeValue>)
```

Each attribute has metadata:

```text
Attribute {
  key,
  value,
  source,
  role,
  unit,
  locked,
  display_name
}
```

Attribute roles:

- `UserFreeform` — user can write anything.
- `ImportMetadata` — preserved from source files.
- `GeometryDriving` — affects generated geometry.
- `MaterialDriving` — affects material/rendering.
- `StyleDriving` — affects visual display.
- `SimulationInput` — reserved for Testflight.
- `ExternalMapping` — IFC/GIS/DXF mapping metadata.

This separates free user attributes from attributes that are allowed to affect
geometry or rendering.

## Style Model

Style is a first-class object, not random component state.

```text
Style {
  color,
  opacity,
  point_size,
  line_width,
  point_color_mode,
  classification_palette,
  material_ref
}
```

Style changes are commands and can be undone. Layer style inheritance can be
added later without changing entity geometry.

## Commands

Commands are the only write path.

```text
Command {
  id,
  parent_command,
  timestamp,
  actor,
  kind,
  payload,
  affected_entities,
  before_refs,
  after_refs
}
```

MVP command kinds:

- `CreateProject`
- `ImportPointCloudBatch`
- `RenameEntity`
- `SetEntityVisibility`
- `SetEntityStyle`
- `SetPanelState`
- `CreateSelectionMask`
- `ExtractPointCloudSegment`
- `Undo`
- `Redo`

Rules:

- command payloads are deterministic,
- command results are object refs,
- commands must be replayable,
- commands must emit semantic events for the UI,
- commands must not depend on current wall-clock except recorded metadata.

## Undo/Redo

Undo is implemented through command history, not ad hoc UI rollback.

For commands that create immutable objects, undo usually removes references from
the active manifest and keeps the objects available for redo until garbage
collection.

Examples:

- Import undo: remove imported entities from manifest, keep blobs.
- Segment undo: remove derived entities and selection mask refs.
- Rename undo: restore previous name object/ref.
- Visibility undo: restore previous visibility state.

## Diff Strategy for Chronogit

The data model preserves semantic diffs by comparing:

- entity tree changes,
- command journal changes,
- object hashes,
- attribute object diffs,
- style object diffs,
- derivation specs,
- transform refs.

Large point-cloud data is not line-diffed. Instead, Chronogit can later show:

- source file changed,
- segment mask changed,
- tile set changed,
- derived entity added/removed,
- point-count/bounds/classification statistics changed.

## Transforms

Transforms are explicit:

```text
Transform {
  translation: Vec3F64,
  rotation_quat: [f64; 4],
  scale: Vec3F64
}
```

The engine does not perform implicit CRS reprojection. If a user later chooses a
transformation during import, that transformation becomes an explicit object and
a command, so it is undoable and visible in project history.

## Future Conversions

Entity conversion is modeled as derivation:

- line to wall,
- point to manhole,
- points to alignment,
- mesh to terrain model.

Converted entities keep a `derivation` link to the source plus parameters. If
the conversion is later materialized, both the materialized geometry and the
derivation spec are kept.

This is important for CAD semantics: a wall generated from a guide line is not
just a mesh; it is a wall with a source, parameters, material, and attributes.

## Scripting

Future scripting (Python console or macro system) must call the same command
API as the UI. Scripts may create entities, attributes, selections, and derived
geometry, but they must not bypass the command journal.
