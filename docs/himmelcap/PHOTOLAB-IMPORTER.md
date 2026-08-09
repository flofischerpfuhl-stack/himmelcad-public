# PhotoLab importer for `.himmelcap`

Status: design note for C2. Implementation starts after C1 schema freeze.

## Why a dedicated importer

EXIF GPS without σ becomes **25 m H / 50 m V** priors in PhotoLab. Cap’s value
is **honest covariances and session structure**. That requires a first-class
importer, not “open folder of JPEGs”.

Canonical package: **`.hcap`** ZIP (`format: himmelcap-session`). See `FORMAT.md`.

## Admission flow

1. User selects `.hcap` file or exploded session directory.
2. Importer verifies `checksums.sha256` and `schemaVersion`.
3. Media objects are content-addressed into the project store (byte-exact).
4. Each reconstruction frame becomes a discovered photo with:
   - source hash,
   - capture profile (smartphone, make/model from manifest),
   - `CapturePositionPrior` from `poses.jsonl`.
5. One **Capture Group** named from session id / timestamp.
6. **Camera calibration groups** split by `cameraSegments` (focus/AE policy changes).
7. Import report shows quality summary (tier, mean σ, fix fraction).
8. Project spatial reference remains **unchanged** unless user later commits CRS.

## Mapping rules

| Cap | PhotoLab |
| --- | --- |
| Session | Capture group (immutable membership) |
| Frame image | Photo entity / discovered photo |
| Pose prior | `CapturePositionPrior` diagonal or full ENU cov |
| `fixType` fix/float/single | Stored in provenance; may influence default prior weight UI |
| Video lineage | `DerivedCaptureArtifactProvenance` if frames extracted from video |
| Operator notes | Import warning or session metadata attachment |

### Source enum

Prefer extending `CapturePositionPriorSource` with `HimmelCap` (serde
`himmelCap`) rather than overloading `VendorRtk`. Until the enum ships, C2 may
temporarily map T2+ to `VendorRtk` **only if** σ fields are present — document
the temporary mapping in the importer report.

## Non-behaviours

- Do not auto-enable camera position priors in GCP optimization (ADR 0009:
  opt-in).
- Do not invent orthometric heights from ellipsoid without a CRS/geoid step.
- Do not drop frames with poor GNSS; import all reconstruction frames and let
  alignment use weak priors.

## UI (PhotoLab)

Minimal C2 surface:

- File → Import Cap session (or drag-drop `.himmelcap`)
- Progress + cancel
- Summary panel: frame count, mean σ, tier, warnings
- Link to capture group in project tree

## Tests

- Golden synthetic package under `scripts/fixtures/himmelcap/`
- Prior σ matches fixture
- Hash mismatch fails closed
- Unknown optional fields ignored
- SchemaVersion too new → clear error

## Implementation touchpoints (expected)

- `crates/himmelcad-io` — unpack + parse
- `crates/himmelcad-core` — prior types if extended
- `packages/@himmelcad/data` — TS types
- `apps/photolab` — dialog + IPC
- Sidecar RPC method e.g. `photolab.himmelcap.import`
