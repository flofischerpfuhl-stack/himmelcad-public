# I-07 Deterministic registry linter — verification evidence

Document class: report / verification evidence
Recorded: 2026-09-02
Work package: I-07 (MASTER-PLAN D8 / §0a)

## Outcome

`G-INFRA-REGISTRY-LINT`: **PASS**. The tool runs on the live spec/registry
corpus, its `node --test` self-tests pass (29/29 after the heading-delimiter
and program-root follow-up; 24/24 in the consumer-row TAP below), and corpus
FAILs are reported rather than papered over.

Follow-up on the same day (I-07b): ATX decision headings (`### … (XX-Dn)`,
`### … XX-Dn — …`) and line-start bold runs (`**XX-Dn — …**`) now count as
definitions, which removes the Civil `CIV-D*` false positives. Default
output groups findings by check with a count header; `--summary` prints one
line per check with the finding count.

Follow-up on the same day (consumer-row convention): catalog rows whose
Spec-link cell starts with `owner:` are access-path/consumer rows. They are
excluded from duplicate-id and spec-versus-registry definition checks, and
`consumer-rows-point-to-owner` requires the named owner spec to catalog the
id. Five duplicate pairs were marked on the non-owning spec. Remaining
duplicate-id findings are `view.mode`, `view.point-size`, and `view.station`.

Follow-up on the same day (heading delimiter + program-root definitions):
any ATX heading that contains a decision id is a definition, regardless of
the delimiter after the id (`—`, `:`, `)`, end of line). Line-start bold
runs still define; table cells and prose remain citations. Decision
definitions are also harvested from every `*.md` directly under
`docs/builder-program/` (README, `OWNER-*`, REGISTRY, MASTER-PLAN, GAP,
COORDINATION). Catalog-row parsing stays limited to `specs/`. This removes
the BIM `BS-D18`–`BS-D22` and `GAP-D*` false positives. Dangling-decision
findings on the live corpus are now 0; no remaining dangling id is genuine.

This is tooling plus five consumer-row markers. It does not change product
state, persistence, commands, schemas, automation contracts, or UI.

## Files changed

- `scripts/registry-lint.mjs` — ESM, no new dependencies
- `scripts/registry-lint.test.mjs` — fixture-string unit tests for each check
- `package.json` — script `registry:lint`
- `docs/builder-program/README.md` — consumer-row owner convention under Rules
- `docs/builder-program/specs/civil/civil.md` — three consumer-row markers
- `docs/builder-program/specs/file-project/file-project.md` — two consumer-row markers
- `docs/builder-program/evidence/I-07-registry-lint-2026-09-02.md` — this file

## What the tool checks

Against `docs/builder-program/specs/*/*.md` (excluding filenames containing
`review` or `criteria`), `docs/builder-program/REGISTRY.md`, and — for
decision definitions only — every `*.md` directly under
`docs/builder-program/`:

1. `duplicate-function-ids` — same backticked catalog id in more than one spec (definition rows only)
2. `function-ids-in-spec-absent-from-registry` — spec catalog id missing from registry §1 (definition rows only)
3. `function-ids-in-registry-absent-from-spec` — registry §1 id missing from every spec catalog (definition rows only)
4. `consumer-rows-point-to-owner` — Spec-link `owner: <spec-name>` rows must name a spec that catalogs the id
5. `dangling-decision-ids` — `XX-Dn` cited in a spec or the registry with no heading or line-start-bold definition in the spec tree or program-root markdown
6. `spec-status-mismatch` — spec `Status:` specified/drafted token vs registry §4.5
7. `shortcut-key-collisions` — registry §2, same key, different owner, no `scoped` marker

CLI: default human PASS/FAIL grouped by check with a count header and
`file:line` findings; `--summary` prints one line per check with the finding
count; `--json` emits the report object; `--fix-registry-status` is not
implemented (read-only; exit 2).

Catalog harvest is tables whose first header cell is `Id` or `Function id`,
first cell a backticked dotted function id (`.md` suffixes rejected). A
Spec-link cell (header `Spec link`, or any later cell that starts with
`owner:`) that begins with `owner: <spec-name>` marks a consumer row. A
decision id is defined if it appears in a bold run at line start or in any
markdown heading line (`#`-prefixed) in the spec directory tree or in a
`docs/builder-program/*.md` file, regardless of the delimiter after the id.
A table cell or prose mention is a citation. Catalog rows are harvested only
from spec files.

## Tests run

### Self-tests

Command:

```text
node --test scripts/registry-lint.test.mjs
```

Exit 0. Compact TAP after the consumer-row follow-up (`node --test` prints
per-test `duration_ms` blocks omitted here):

```text
TAP version 13
# Subtest: registry-lint parsers
    ok 1 - harvests only backticked function ids and strips parenthetical annotations
    ok 2 - treats **XX-Dn** bold headings as definitions and other matches as citations
    ok 3 - treats ATX (XX-Dn), ATX XX-Dn —, and **XX-Dn —** lines as definitions
    ok 4 - reads the first specified/drafted token on the Status line
    ok 5 - treats Spec-link cells starting with owner: as consumer rows
    ok 6 - treats owner: at the start of a catalog cell as a consumer row when Spec link is absent
    ok 7 - excludes review and criteria spec filenames
    1..7
ok 1 - registry-lint parsers
# Subtest: registry-lint checks
    ok 1 - passes a closed fixture corpus
    ok 2 - fails duplicate function ids across specs
    ok 3 - does not treat owner-marked consumer rows as duplicate definitions
    ok 4 - fails consumer rows whose named owner spec does not catalog the id
    ok 5 - fails consumer rows that name an owner spec missing from the corpus
    ok 6 - fails function ids present in a spec catalog but absent from the registry
    ok 7 - fails function ids present in the registry but absent from every spec catalog
    ok 8 - does not treat heading-defined decision ids as dangling
    ok 9 - fails decision ids cited without a bold-heading definition
    ok 10 - fails when the spec status line disagrees with registry §4.5
    ok 11 - fails unscoped shortcut keys claimed by more than one owner
    ok 12 - does not treat the same key as a collision when a claim is marked scoped
    1..12
ok 2 - registry-lint checks
# Subtest: registry-lint cli
    ok 1 - parses --json and rejects unknown flags
    ok 2 - prints a machine-readable report object from lintCorpus
    ok 3 - formats PASS/FAIL lines with file:line findings
    ok 4 - refuses --fix-registry-status as an unimplemented read-only tool
    ok 5 - parses registry §1 rows and §4.5 status from fixture strings
    1..5
ok 3 - registry-lint cli
1..3
# tests 24
# suites 3
# pass 24
# fail 0
```

### `--fix-registry-status`

Command:

```text
node scripts/registry-lint.mjs --fix-registry-status
```

Exit 2. Verbatim stderr/stdout:

```text
--fix-registry-status is not implemented; this tool is read-only
```

### Corpus run

Command:

```text
pnpm registry:lint
```

Exit 1 (any FAIL). Counts from the same corpus via `--json` / `--summary`
after the consumer-row follow-up (I-07 before that follow-up had
`duplicate-function-ids` 16 / 8 ids and no `consumer-rows-point-to-owner`
check):

| Check                                     | Status | Findings | Unique ids                                         |
| ----------------------------------------- | ------ | -------: | -------------------------------------------------- |
| duplicate-function-ids                    | FAIL   |        6 | 3 (`view.mode`, `view.point-size`, `view.station`) |
| function-ids-in-spec-absent-from-registry | FAIL   |        7 | 7                                                  |
| function-ids-in-registry-absent-from-spec | FAIL   |       27 | 27                                                 |
| consumer-rows-point-to-owner              | PASS   |        0 | —                                                  |
| dangling-decision-ids                     | FAIL   |       88 | 10                                                 |
| spec-status-mismatch                      | FAIL   |        1 | `registration-stations`                            |
| shortcut-key-collisions                   | PASS   |        0 | —                                                  |

`--summary` (exit 1):

```text
FAIL duplicate-function-ids 6
FAIL function-ids-in-spec-absent-from-registry 7
FAIL function-ids-in-registry-absent-from-spec 27
PASS consumer-rows-point-to-owner 0
FAIL dangling-decision-ids 88
FAIL spec-status-mismatch 1
PASS shortcut-key-collisions 0
```

Current duplicate-id findings after the consumer-row markers:

```text
FAIL duplicate-function-ids (6)
docs/builder-program/specs/pointcloud/pointcloud.md:50: `view.point-size` is cataloged in more than one spec (also docs/builder-program/specs/view/view-domain.md:57)
docs/builder-program/specs/registration-stations/registration-stations.md:31: `view.station` is cataloged in more than one spec (also docs/builder-program/specs/view/view-domain.md:60)
docs/builder-program/specs/ui-platform/ui-platform.md:67: `view.mode` is cataloged in more than one spec (also docs/builder-program/specs/view/view-domain.md:44)
docs/builder-program/specs/view/view-domain.md:44: `view.mode` is cataloged in more than one spec (also docs/builder-program/specs/ui-platform/ui-platform.md:67)
docs/builder-program/specs/view/view-domain.md:57: `view.point-size` is cataloged in more than one spec (also docs/builder-program/specs/pointcloud/pointcloud.md:50)
docs/builder-program/specs/view/view-domain.md:60: `view.station` is cataloged in more than one spec (also docs/builder-program/specs/registration-stations/registration-stations.md:31)
```

### Corpus run 2026-09-02 — heading delimiter + program-root definitions

Self-tests after this follow-up (`node --test scripts/registry-lint.test.mjs`,
exit 0; `node --test` prints per-test `duration_ms` blocks omitted here):

```text
TAP version 13
# Subtest: registry-lint parsers
    ok 1 - harvests only backticked function ids and strips parenthetical annotations
    ok 2 - treats **XX-Dn** bold headings as definitions and other matches as citations
    ok 3 - treats ATX (XX-Dn), ATX XX-Dn —, and **XX-Dn —** lines as definitions
    ok 4 - treats any heading that contains a decision id as a definition regardless of delimiter
    ok 5 - treats only docs/builder-program/*.md as program-root definition sources
    ok 6 - reads the first specified/drafted token on the Status line
    ok 7 - treats Spec-link cells starting with owner: as consumer rows
    ok 8 - treats owner: at the start of a catalog cell as a consumer row when Spec link is absent
    ok 9 - excludes review and criteria spec filenames
    1..9
ok 1 - registry-lint parsers
# Subtest: registry-lint checks
    ok 1 - passes a closed fixture corpus
    ok 2 - fails duplicate function ids across specs
    ok 3 - does not treat owner-marked consumer rows as duplicate definitions
    ok 4 - fails consumer rows whose named owner spec does not catalog the id
    ok 5 - fails consumer rows that name an owner spec missing from the corpus
    ok 6 - fails function ids present in a spec catalog but absent from the registry
    ok 7 - fails function ids present in the registry but absent from every spec catalog
    ok 8 - does not treat heading-defined decision ids as dangling
    ok 9 - does not treat colon-delimited heading ids as dangling
    ok 10 - does not treat table-cell or prose mentions as decision definitions
    ok 11 - resolves program-root heading definitions without harvesting those catalog rows
    ok 12 - fails decision ids cited without a bold-heading definition
    ok 13 - fails when the spec status line disagrees with registry §4.5
    ok 14 - fails unscoped shortcut keys claimed by more than one owner
    ok 15 - does not treat the same key as a collision when a claim is marked scoped
    1..15
ok 2 - registry-lint checks
# Subtest: registry-lint cli
    ok 1 - parses --json and rejects unknown flags
    ok 2 - prints a machine-readable report object from lintCorpus
    ok 3 - formats PASS/FAIL lines with file:line findings
    ok 4 - refuses --fix-registry-status as an unimplemented read-only tool
    ok 5 - parses registry §1 rows and §4.5 status from fixture strings
    1..5
ok 3 - registry-lint cli
1..3
# tests 29
# suites 3
# pass 29
# fail 0
```

Command:

```text
node scripts/registry-lint.mjs --summary
```

Exit 1 (any FAIL). Counts after the heading-delimiter and program-root
follow-up (previous dangling-decision count 88 / 10 unique ids):

| Check                                     | Status | Findings | Unique ids                                         |
| ----------------------------------------- | ------ | -------: | -------------------------------------------------- |
| duplicate-function-ids                    | FAIL   |        6 | 3 (`view.mode`, `view.point-size`, `view.station`) |
| function-ids-in-spec-absent-from-registry | FAIL   |        7 | 7                                                  |
| function-ids-in-registry-absent-from-spec | FAIL   |       27 | 27                                                 |
| consumer-rows-point-to-owner              | PASS   |        0 | —                                                  |
| dangling-decision-ids                     | PASS   |        0 | —                                                  |
| spec-status-mismatch                      | FAIL   |        1 | `registration-stations`                            |
| shortcut-key-collisions                   | PASS   |        0 | —                                                  |

`--summary` (exit 1):

```text
FAIL duplicate-function-ids 6
FAIL function-ids-in-spec-absent-from-registry 7
FAIL function-ids-in-registry-absent-from-spec 27
PASS consumer-rows-point-to-owner 0
PASS dangling-decision-ids 0
FAIL spec-status-mismatch 1
PASS shortcut-key-collisions 0
```

Dangling section of the default text report:

```text
PASS dangling-decision-ids (0)
```

No dangling ids remain; none is therefore genuine.

Verbatim `pnpm registry:lint` output from the original I-07 corpus run (before
consumer-row markers; counts superseded by the tables above):

```text
> himmelcad@0.0.0 registry:lint /home/oem/Dokumente/003_Projekte/10_himmelcad
> node scripts/registry-lint.mjs

FAIL duplicate-function-ids (16)
docs/builder-program/specs/civil/civil.md:75: `mesh.create-surface` is cataloged in more than one spec (also docs/builder-program/specs/mesh-terrain/mesh-terrain.md:84)
docs/builder-program/specs/civil/civil.md:84: `derived.recipe-manage` is cataloged in more than one spec (also docs/builder-program/specs/mesh-terrain/mesh-terrain.md:87)
docs/builder-program/specs/civil/civil.md:85: `inspect.point_info` is cataloged in more than one spec (also docs/builder-program/specs/measure-inspect/measure-inspect.md:55)
docs/builder-program/specs/file-project/file-project.md:36: `document.history` is cataloged in more than one spec (also docs/builder-program/specs/ui-platform/ui-platform.md:70)
docs/builder-program/specs/file-project/file-project.md:39: `file.import` is cataloged in more than one spec (also docs/builder-program/specs/import-formats/import-formats.md:31)
docs/builder-program/specs/import-formats/import-formats.md:31: `file.import` is cataloged in more than one spec (also docs/builder-program/specs/file-project/file-project.md:39)
docs/builder-program/specs/measure-inspect/measure-inspect.md:55: `inspect.point_info` is cataloged in more than one spec (also docs/builder-program/specs/civil/civil.md:85)
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:84: `mesh.create-surface` is cataloged in more than one spec (also docs/builder-program/specs/civil/civil.md:75)
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:87: `derived.recipe-manage` is cataloged in more than one spec (also docs/builder-program/specs/civil/civil.md:84)
docs/builder-program/specs/pointcloud/pointcloud.md:50: `view.point-size` is cataloged in more than one spec (also docs/builder-program/specs/view/view-domain.md:57)
docs/builder-program/specs/registration-stations/registration-stations.md:29: `view.station` is cataloged in more than one spec (also docs/builder-program/specs/view/view-domain.md:60)
docs/builder-program/specs/ui-platform/ui-platform.md:67: `view.mode` is cataloged in more than one spec (also docs/builder-program/specs/view/view-domain.md:44)
docs/builder-program/specs/ui-platform/ui-platform.md:70: `document.history` is cataloged in more than one spec (also docs/builder-program/specs/file-project/file-project.md:36)
docs/builder-program/specs/view/view-domain.md:44: `view.mode` is cataloged in more than one spec (also docs/builder-program/specs/ui-platform/ui-platform.md:67)
docs/builder-program/specs/view/view-domain.md:57: `view.point-size` is cataloged in more than one spec (also docs/builder-program/specs/pointcloud/pointcloud.md:50)
docs/builder-program/specs/view/view-domain.md:60: `view.station` is cataloged in more than one spec (also docs/builder-program/specs/registration-stations/registration-stations.md:29)
FAIL function-ids-in-spec-absent-from-registry (7)
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1664: `mesh.repair-region` is in the spec catalog but absent from REGISTRY.md §1
docs/builder-program/specs/pointcloud/pointcloud.md:1235: `pointcloud.extract-ground` is in the spec catalog but absent from REGISTRY.md §1
docs/builder-program/specs/pointcloud/pointcloud.md:1236: `pointcloud.extract-floor` is in the spec catalog but absent from REGISTRY.md §1
docs/builder-program/specs/registration-stations/registration-stations.md:25: `station.catalog` is in the spec catalog but absent from REGISTRY.md §1
docs/builder-program/specs/registration-stations/registration-stations.md:26: `registration.cloud-to-cloud` is in the spec catalog but absent from REGISTRY.md §1
docs/builder-program/specs/registration-stations/registration-stations.md:27: `registration.report` is in the spec catalog but absent from REGISTRY.md §1
docs/builder-program/specs/registration-stations/registration-stations.md:28: `station.depth-image` is in the spec catalog but absent from REGISTRY.md §1
FAIL function-ids-in-registry-absent-from-spec (27)
docs/builder-program/REGISTRY.md:76: `view.section-create` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:127: `draw.line` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:128: `draw.polyline` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:129: `draw.arc` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:130: `draw.circle` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:131: `draw.clothoid` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:132: `draw.area` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:133: `draw.text` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:134: `draw.dimension` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:135: `draw.label` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:136: `draw.edit` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:137: `draw.offset` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:138: `draw.trim` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:139: `draw.fillet` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:140: `draw.divide` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:141: `draw.snap` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:142: `draw.input-bar` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:143: `draw.layers` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:144: `draw.assign-heights` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:145: `draw.symbol` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:146: `draw.fill` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:148: `draw.support-role` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:167: `pointcloud.grid-mean-sample` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:168: `pointcloud.station-corridor-sample` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:190: `bim.components` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:191: `bim.strata` is in REGISTRY.md §1 but absent from every spec catalog
docs/builder-program/REGISTRY.md:203: `raster.difference` is in REGISTRY.md §1 but absent from every spec catalog
FAIL dangling-decision-ids (88)
docs/builder-program/REGISTRY.md:179: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/REGISTRY.md:182: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/REGISTRY.md:185: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/REGISTRY.md:186: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/REGISTRY.md:187: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/REGISTRY.md:359: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/REGISTRY.md:525: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:51: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:74: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:211: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:236: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:474: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:579: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:705: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:738: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:748: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:781: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:789: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:791: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:847: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:871: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:959: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1039: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1039: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1153: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1170: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1321: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1400: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1425: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1471: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1494: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1597: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1598: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1598: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1619: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1627: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1627: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1627: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1631: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1631: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1632: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1632: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1633: BS-D18 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1633: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/bim-specs/bim-specs.md:1684: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/draw/draw.md:973: GAP-D4 is cited but defined nowhere as a decision heading
docs/builder-program/specs/draw/draw.md:1189: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/draw/draw.md:1381: GAP-D2 is cited but defined nowhere as a decision heading
docs/builder-program/specs/draw/draw.md:1441: BS-D19 is cited but defined nowhere as a decision heading
docs/builder-program/specs/draw/draw.md:1476: GAP-D2 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:101: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:101: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:102: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:103: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:104: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:273: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:880: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:881: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:926: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:926: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:1266: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:1266: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/import-formats/import-formats.md:1266: BS-D22 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:195: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:195: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:765: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1223: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1224: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1388: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1459: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1492: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1501: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1501: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1501: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1600: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1615: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1616: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1644: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1644: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/plan-editor/plan-editor.md:1237: GAP-D9 is cited but defined nowhere as a decision heading
docs/builder-program/specs/raster/raster.md:825: GAP-D7 is cited but defined nowhere as a decision heading
docs/builder-program/specs/raster/raster.md:825: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/raster/raster.md:863: GAP-D8 is cited but defined nowhere as a decision heading
docs/builder-program/specs/select-edit/select-edit.md:397: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/select-edit/select-edit.md:397: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/select-edit/select-edit.md:1027: BS-D20 is cited but defined nowhere as a decision heading
docs/builder-program/specs/select-edit/select-edit.md:1027: BS-D21 is cited but defined nowhere as a decision heading
docs/builder-program/specs/ui-platform/ui-platform.md:84: BS-D19 is cited but defined nowhere as a decision heading
FAIL spec-status-mismatch (1)
docs/builder-program/specs/registration-stations/registration-stations.md:3: spec status is drafted; REGISTRY.md §4.5 does not list this spec
PASS shortcut-key-collisions (0)
[41m[30m ELIFECYCLE [39m[49m [31mCommand failed with exit code 1.[39m
```

## What the findings mean (information; remaining corpus FAILs not fixed)

- **Duplicates (3 ids remaining).** Consumer-row markers removed five shared
  catalog pairs: `mesh.create-surface` and `derived.recipe-manage` (civil →
  mesh-terrain), `inspect.point_info` (civil → measure-inspect),
  `document.history` (file-project → ui-platform), `file.import`
  (file-project → import-formats). Still definition-duplicated:
  `view.mode`, `view.point-size`, `view.station`. Registry §4.1 claims each
  shared act has one owner row; this check is spec-catalog occupancy, not
  registry-row uniqueness.
- **In spec, not registry (7).** Batch-3 / unregistered catalogs:
  `mesh.repair-region`, `pointcloud.extract-ground`, `pointcloud.extract-floor`,
  and the four `registration-stations.md` rows (`station.catalog`,
  `registration.cloud-to-cloud`, `registration.report`, `station.depth-image`).
  `view.station` is in both `registration-stations.md` and `view-domain.md`, so
  it is a duplicate rather than absent-from-registry.
- **In registry, not spec (27).** `draw.md` catalog first cells are not
  backticked, so most `draw.*` registry rows have no harvested spec catalog
  id (`draw.point` / `draw.alignment` survive via Civil's backticked shared
  rows). Also missing from harvested catalogs: `view.section-create`,
  `pointcloud.grid-mean-sample`, `pointcloud.station-corridor-sample`,
  `bim.components`, `bim.strata`, `raster.difference`.
- **Dangling decisions (0).** Civil ATX records, BIM
  `#### Decision record — BS-D18:` headings, and program-root
  `#### GAP-Dn —` headings now count as definitions. The previous 88
  citations / 10 unique ids (`BS-D18`–`BS-D22`, `GAP-D2`, `GAP-D4`,
  `GAP-D7`, `GAP-D8`, `GAP-D9`) resolve. No dangling id remains on the live
  corpus, so none is genuine.
- **Status.** `registration-stations.md` is `drafted`; registry §4.5 lists
  it in neither `specified` nor `drafted` (`drafted` is `none`).
- **Shortcuts.** No unscoped two-owner key collision in registry §2.

## What the tool proves

- Deterministic, dependency-free parsing of the named catalog/registry
  structures and the seven structural checks.
- Non-zero exit on any FAIL; `--json` shape; `--summary` counts; default
  grouped count headers; `--fix-registry-status` refused.
- Self-tests cover a closed passing corpus, one failing fixture per check,
  owner-marked consumer rows (excluded from duplicate/definition occupancy;
  `consumer-rows-point-to-owner` pass and fail), heading ids with any
  delimiter, table/prose citations that are not definitions, and
  program-root heading definitions that do not harvest catalog rows.

## What the tool cannot prove (needs review)

- Semantic contradictions (same surface/gesture/state with different
  guarantees; README standing checks beyond id occupancy).
- Range/slash citations (`VB-D1…D14`, `UIP-D7/D17`) — only the
  `\b[A-Z]{2,4}-D\d+\b` match is seen.
- Unbackticked catalog ids (`draw.md`).
- Shared-row duplicates that are not yet marked `owner:` (`view.mode`,
  `view.point-size`, `view.station`). Marked consumer rows are checked only
  for owner occupancy, not for semantic agreement with the owner spec.
- Automation command spelling, ribbon placement, performance class, or
  implementation status cell truth.
- Review/criteria files (excluded by filename).
- Program-root markdown (`OWNER-*`, MASTER-PLAN, COORDINATION, README) is a
  definition source only. Catalog-row parsing stays in `specs/`. Citations
  are still harvested only from specs and `REGISTRY.md`.

## Gate status

| Gate                    | Result   | Notes                                                                                   |
| ----------------------- | -------- | --------------------------------------------------------------------------------------- |
| `G-INFRA-REGISTRY-LINT` | **PASS** | Tool runs on the corpus; self-tests pass. Corpus FAILs are findings, not gate failures. |

Changed-tier verification actually run: `node --test scripts/registry-lint.test.mjs`,
`npx prettier --write` on the changed scripts and this evidence file,
`npx eslint` on the changed scripts, and `node scripts/registry-lint.mjs
--summary` on the corpus.

## Not verified

- Full `scripts/verify.mjs changed` / commit-tier matrix (typecheck, app tests,
  prettier/eslint over the whole tree).
- Browser, runtime, or product behavior (no UI change).
