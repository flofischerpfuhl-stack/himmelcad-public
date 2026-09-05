import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECK_ORDER,
  extractFunctionId,
  formatSummaryReport,
  formatTextReport,
  isConsumerSpecLink,
  isProgramMarkdownPath,
  isSpecLintTarget,
  lintCorpus,
  main,
  parseCatalogRows,
  parseCliArgs,
  parseDecisionCitations,
  parseDecisionDefinitions,
  parseOwnerMarker,
  parseRegistryRows,
  parseRegistryStatusTable,
  parseShortcutClaims,
  parseSpecStatusLine,
} from './registry-lint.mjs';

const registryPath = 'docs/builder-program/REGISTRY.md';

function registryFixture({
  rows = '| `foo.bar` | File · — | R | inline | bnd | `foo.bar` | foo.md | specified |',
  shortcuts = `
| Key | Function | Source | Registry state |
| --- | -------- | ------ | -------------- |
| **F4** | \`foo.bar\` | foo.md | **assigned** |
`,
  armed = `
| Key | Scope | Meaning while armed | Source |
| --- | ----- | ------------------- | ------ |
| F4 | foo tool | toggle | foo.md |
`,
  specified = '`foo`',
  drafted = 'none',
} = {}) {
  return `# Function registry

## 1. Registry rows

| Id | Tab · group | Access | Surface | Perf | Automation | Spec link | Status |
| -- | ----------- | ------ | ------- | ---- | ---------- | --------- | ------ |
${rows}

## 2. Shortcut map

### 2.1 Global shortcuts — claimed or recommended
${shortcuts}

### 2.2 Armed-tool key claims (scoped; released when the tool ends)
${armed}

## 3. Gesture map summary

unused.

## 4. Cross-spec consistency report

### 4.5 Registry-gated spec status

| Status | Specs |
| ------ | ----- |
| \`specified\` | ${specified} |
| \`drafted\` | ${drafted} |
`;
}

function specFixture({
  status = 'Status: specified by the rebuild.',
  catalog = `
| Id | Function |
| -- | -------- |
| \`foo.bar\` | Foo |
`,
  decisions = `
**FO-D1 — Example record.** **Decision:** keep.

See FO-D1.
`,
} = {}) {
  return `# Foo spec

${status}

## Catalog
${catalog}

## Decision records
${decisions}
`;
}

describe('registry-lint parsers', () => {
  it('harvests only backticked function ids and strips parenthetical annotations', () => {
    const rows = parseCatalogRows(`
| Id | Function |
| --- | -------- |
| \`view.mode\` (3D / 2.5D / 2D) | Mode |
| draw.point | not harvested |
| \`hcad.group@1\` | entity type, not a function id |
| Idle viewport | not an id |
`);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['view.mode'],
    );
    assert.equal(extractFunctionId('`draw.alignment` (shared)'), 'draw.alignment');
    assert.equal(extractFunctionId('`file-project.md`'), null);
    assert.deepEqual(
      parseCatalogRows(`
| Error class | Detection |
| ----------- | --------- |
| \`repair.region.invalid_loop\` | blocked |
`).map((row) => row.id),
      [],
    );
  });

  it('treats **XX-Dn** bold headings as definitions and other matches as citations', () => {
    const markdown = `**VB-D1 — Boxes are entities.**
See VB-D1 and UIP-D14; ignore VB-D1…D14 ranges beyond the regex.
`;
    assert.deepEqual(parseDecisionDefinitions(markdown), [{ id: 'VB-D1', line: 1 }]);
    assert.deepEqual(
      parseDecisionCitations(markdown).map((citation) => citation.id),
      ['VB-D1', 'VB-D1', 'UIP-D14', 'VB-D1'],
    );
  });

  it('treats ATX (XX-Dn), ATX XX-Dn —, and **XX-Dn —** lines as definitions', () => {
    const markdown = `### 5.1 Gesture reconciliation (CIV-D1)
See CIV-D1 in running text.

### 10.1 MT-D25 — the common derived-recipe contract
MT-D25 applies only to a reproducible mapping.

**MT-D25 — One common recipe envelope and transition service governs derived entities.** **Decision:** keep.

Prose CIV-D1 — em dash in a body line is a citation.
Body (CIV-D1) parentheses are also a citation.
`;
    assert.deepEqual(parseDecisionDefinitions(markdown), [
      { id: 'CIV-D1', line: 1 },
      { id: 'MT-D25', line: 4 },
      { id: 'MT-D25', line: 7 },
    ]);
    const citations = parseDecisionCitations(markdown).map((citation) => citation.id);
    assert.deepEqual(citations, [
      'CIV-D1',
      'CIV-D1',
      'MT-D25',
      'MT-D25',
      'MT-D25',
      'CIV-D1',
      'CIV-D1',
    ]);
  });

  it('treats any heading that contains a decision id as a definition regardless of delimiter', () => {
    const markdown = `#### Decision record — BS-D18: catalog-declared codes
See BS-D18 in running text.

### BS-D19
End-of-line id.

### Record (BS-D20)
Paren form still counts.

### 10.1 MT-D25 — the common derived-recipe contract

| Decision | Note |
| -------- | ---- |
| BS-D18 | table cell is a citation |

Prose BS-D18 — em dash in a body line is a citation.
`;
    assert.deepEqual(parseDecisionDefinitions(markdown), [
      { id: 'BS-D18', line: 1 },
      { id: 'BS-D19', line: 4 },
      { id: 'BS-D20', line: 7 },
      { id: 'MT-D25', line: 10 },
    ]);
    const citations = parseDecisionCitations(markdown).map((citation) => citation.id);
    assert.deepEqual(citations, [
      'BS-D18',
      'BS-D18',
      'BS-D19',
      'BS-D20',
      'MT-D25',
      'BS-D18',
      'BS-D18',
    ]);
  });

  it('treats only docs/builder-program/*.md as program-root definition sources', () => {
    assert.equal(isProgramMarkdownPath('docs/builder-program/README.md'), true);
    assert.equal(
      isProgramMarkdownPath('docs/builder-program/OWNER-STATEMENTS-2026-09-02-GAP.md'),
      true,
    );
    assert.equal(isProgramMarkdownPath('docs/builder-program/REGISTRY.md'), true);
    assert.equal(isProgramMarkdownPath('docs/builder-program/MASTER-PLAN.md'), true);
    assert.equal(isProgramMarkdownPath('docs/builder-program/COORDINATION.md'), true);
    assert.equal(isProgramMarkdownPath('docs/builder-program/specs/bim-specs/bim-specs.md'), false);
    assert.equal(isProgramMarkdownPath('docs/builder-program/dossiers/realworks.md'), false);
    assert.equal(
      isProgramMarkdownPath('docs/builder-program/evidence/I-07-registry-lint-2026-09-02.md'),
      false,
    );
  });

  it('reads the first specified/drafted token on the Status line', () => {
    assert.deepEqual(parseSpecStatusLine('Status: specified by rebuild; later drafted notes.\n'), {
      status: 'specified',
      line: 1,
      raw: 'specified by rebuild; later drafted notes.',
    });
    assert.equal(
      parseSpecStatusLine('Status: **drafted pending Registry copy/audit**.\n').status,
      'drafted',
    );
  });

  it('treats Spec-link cells starting with owner: as consumer rows', () => {
    const rows = parseCatalogRows(`
| Id | Function | Spec link |
| -- | -------- | --------- |
| \`foo.bar\` | Foo | owner: mesh-terrain; CIV-D5 access path |
| \`foo.own\` | Own | foo.md FO-D1 |
`);
    assert.equal(rows[0].consumer, true);
    assert.equal(rows[0].owner, 'mesh-terrain');
    assert.equal(rows[0].specLink, 'owner: mesh-terrain; CIV-D5 access path');
    assert.equal(rows[1].consumer, false);
    assert.equal(rows[1].owner, null);
    assert.equal(parseOwnerMarker('owner: import-formats.md; access path'), 'import-formats');
    assert.equal(isConsumerSpecLink('foo.md FO-D1'), false);
  });

  it('treats owner: at the start of a catalog cell as a consumer row when Spec link is absent', () => {
    const rows = parseCatalogRows(`
| Id | Function | Status |
| -- | -------- | ------ |
| \`foo.bar\` | Foo | owner: measure-inspect; CIV-D24 access path |
`);
    assert.equal(rows[0].consumer, true);
    assert.equal(rows[0].owner, 'measure-inspect');
  });

  it('excludes review and criteria spec filenames', () => {
    assert.equal(isSpecLintTarget('docs/builder-program/specs/draw/draw.md'), true);
    assert.equal(
      isSpecLintTarget('docs/builder-program/specs/draw/draw-spec-review-2026-09-01.md'),
      false,
    );
    assert.equal(
      isSpecLintTarget('docs/builder-program/specs/view/viewing-box-visual-criteria.md'),
      false,
    );
  });
});

describe('registry-lint checks', () => {
  it('passes a closed fixture corpus', () => {
    const report = lintCorpus({
      specs: [{ path: 'docs/builder-program/specs/foo/foo.md', content: specFixture() }],
      registry: registryFixture(),
      registryPath,
    });
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      CHECK_ORDER.map(() => 'PASS'),
    );
  });

  it('fails duplicate function ids across specs', () => {
    const catalog = `
| Id | Function |
| -- | -------- |
| \`foo.bar\` | Foo |
`;
    const report = lintCorpus({
      specs: [
        { path: 'a/a.md', content: specFixture({ catalog }) },
        { path: 'b/b.md', content: specFixture({ catalog }) },
      ],
      registry: registryFixture(),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'duplicate-function-ids');
    assert.equal(check.status, 'FAIL');
    assert.match(check.findings[0].message, /foo\.bar/);
    assert.equal(check.findings[0].file, 'a/a.md');
    assert.equal(check.findings[1].file, 'b/b.md');
  });

  it('does not treat owner-marked consumer rows as duplicate definitions', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/foo/foo.md',
          content: specFixture(),
        },
        {
          path: 'docs/builder-program/specs/bar/bar.md',
          content: specFixture({
            catalog: `
| Id | Function | Spec link |
| -- | -------- | --------- |
| \`foo.bar\` | Foo access | owner: foo; access path |
`,
          }),
        },
      ],
      registry: registryFixture({ specified: '`foo`, `bar`' }),
      registryPath,
    });
    assert.equal(report.ok, true);
    assert.equal(
      report.checks.find((entry) => entry.name === 'duplicate-function-ids').status,
      'PASS',
    );
    assert.equal(
      report.checks.find((entry) => entry.name === 'consumer-rows-point-to-owner').status,
      'PASS',
    );
  });

  it('fails consumer rows whose named owner spec does not catalog the id', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/foo/foo.md',
          content: specFixture(),
        },
        {
          path: 'docs/builder-program/specs/bar/bar.md',
          content: specFixture({
            catalog: `
| Id | Function | Spec link |
| -- | -------- | --------- |
| \`foo.missing\` | Missing | owner: foo; access path |
`,
          }),
        },
      ],
      registry: registryFixture(),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'consumer-rows-point-to-owner');
    assert.equal(check.status, 'FAIL');
    assert.equal(check.findings.length, 1);
    assert.equal(check.findings[0].id, 'foo.missing');
    assert.equal(check.findings[0].file, 'docs/builder-program/specs/bar/bar.md');
    assert.match(check.findings[0].message, /does not catalog this id/);
    const absent = report.checks.find(
      (entry) => entry.name === 'function-ids-in-spec-absent-from-registry',
    );
    assert.equal(
      absent.findings.some((finding) => finding.id === 'foo.missing'),
      false,
    );
  });

  it('fails consumer rows that name an owner spec missing from the corpus', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/bar/bar.md',
          content: specFixture({
            catalog: `
| Id | Function | Spec link |
| -- | -------- | --------- |
| \`foo.bar\` | Foo access | owner: foo; access path |
`,
          }),
        },
      ],
      registry: registryFixture(),
      registryPath,
    });
    const consumer = report.checks.find((entry) => entry.name === 'consumer-rows-point-to-owner');
    assert.equal(consumer.status, 'FAIL');
    assert.match(consumer.findings[0].message, /not a spec in the corpus/);
    const absentFromSpec = report.checks.find(
      (entry) => entry.name === 'function-ids-in-registry-absent-from-spec',
    );
    assert.equal(absentFromSpec.status, 'FAIL');
    assert.equal(absentFromSpec.findings[0].id, 'foo.bar');
  });

  it('fails function ids present in a spec catalog but absent from the registry', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'specs/foo.md',
          content: specFixture({
            catalog: `
| Id | Function |
| -- | -------- |
| \`foo.bar\` | Foo |
| \`foo.extra\` | Extra |
`,
          }),
        },
      ],
      registry: registryFixture(),
      registryPath,
    });
    const check = report.checks.find(
      (entry) => entry.name === 'function-ids-in-spec-absent-from-registry',
    );
    assert.equal(check.status, 'FAIL');
    assert.equal(check.findings.length, 1);
    assert.equal(check.findings[0].id, 'foo.extra');
    assert.match(check.findings[0].message, /absent from REGISTRY\.md §1/);
  });

  it('fails function ids present in the registry but absent from every spec catalog', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'specs/foo.md',
          content: specFixture({
            catalog: `
| Id | Function |
| -- | -------- |
| foo.bar | unbackticked, not harvested |
`,
          }),
        },
      ],
      registry: registryFixture(),
      registryPath,
    });
    const check = report.checks.find(
      (entry) => entry.name === 'function-ids-in-registry-absent-from-spec',
    );
    assert.equal(check.status, 'FAIL');
    assert.equal(check.findings[0].id, 'foo.bar');
    assert.equal(check.findings[0].file, registryPath);
    assert.ok(check.findings[0].line > 1);
  });

  it('does not treat heading-defined decision ids as dangling', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/civil/civil.md',
          content: specFixture({
            decisions: `
### 5.1 Gesture reconciliation (CIV-D1)

See CIV-D1.

### 10.1 MT-D25 — the common derived-recipe contract

**MT-D25 — One common recipe envelope.** **Decision:** keep.

See MT-D25 and CIV-D1.
`,
          }),
        },
      ],
      registry: registryFixture({
        rows: '| `foo.bar` | File · — | R | inline | bnd | `foo.bar` | foo.md CIV-D1 MT-D25 | specified |',
      }),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'dangling-decision-ids');
    assert.equal(check.status, 'PASS');
    assert.equal(check.findings.length, 0);
  });

  it('does not treat colon-delimited heading ids as dangling', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/bim-specs/bim-specs.md',
          content: specFixture({
            decisions: `
#### Decision record — BS-D18: catalog-declared codes

See BS-D18.
`,
          }),
        },
      ],
      registry: registryFixture({
        rows: '| `foo.bar` | File · — | R | inline | bnd | `foo.bar` | bim-specs.md BS-D18 | specified |',
      }),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'dangling-decision-ids');
    assert.equal(check.status, 'PASS');
    assert.equal(check.findings.length, 0);
  });

  it('does not treat table-cell or prose mentions as decision definitions', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/bim-specs/bim-specs.md',
          content: specFixture({
            decisions: `
| Decision | Note |
| -------- | ---- |
| BS-D18 | table cell |

See BS-D18.
`,
          }),
        },
      ],
      registry: registryFixture({
        rows: '| `foo.bar` | File · — | R | inline | bnd | `foo.bar` | bim-specs.md BS-D18 | specified |',
      }),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'dangling-decision-ids');
    assert.equal(check.status, 'FAIL');
    assert.ok(check.findings.some((finding) => finding.id === 'BS-D18'));
  });

  it('resolves program-root heading definitions without harvesting those catalog rows', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/foo/foo.md',
          content: specFixture({
            decisions: 'See GAP-D2.\n',
          }),
        },
      ],
      registry: registryFixture({
        rows: '| `foo.bar` | File · — | R | inline | bnd | `foo.bar` | foo.md GAP-D2 | specified |',
      }),
      programDocs: [
        {
          path: 'docs/builder-program/OWNER-STATEMENTS-2026-09-02-GAP.md',
          content: `#### GAP-D2 — Keep the shared construction bar

| Id | Function |
| -- | -------- |
| \`gap.extra\` | must not be harvested as a spec catalog row |
`,
        },
      ],
      registryPath,
    });
    const dangling = report.checks.find((entry) => entry.name === 'dangling-decision-ids');
    assert.equal(dangling.status, 'PASS');
    assert.equal(dangling.findings.length, 0);
    const absent = report.checks.find(
      (entry) => entry.name === 'function-ids-in-spec-absent-from-registry',
    );
    assert.equal(
      absent.findings.some((finding) => finding.id === 'gap.extra'),
      false,
    );
    const duplicate = report.checks.find((entry) => entry.name === 'duplicate-function-ids');
    assert.equal(duplicate.status, 'PASS');
  });

  it('fails decision ids cited without a bold-heading definition', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'specs/foo.md',
          content: specFixture({
            decisions: 'See ZZ-D9 and FO-D1.\n',
          }),
        },
      ],
      registry: registryFixture({
        rows: '| `foo.bar` | File · — | R | inline | bnd | `foo.bar` | foo.md FO-D1 | specified |',
      }),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'dangling-decision-ids');
    assert.equal(check.status, 'FAIL');
    const ids = check.findings.map((finding) => finding.id);
    assert.ok(ids.includes('ZZ-D9'));
    assert.ok(ids.includes('FO-D1'));
    assert.equal(
      check.findings.some((finding) => finding.file === registryPath),
      true,
    );
  });

  it('fails when the spec status line disagrees with registry §4.5', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'docs/builder-program/specs/foo/foo.md',
          content: specFixture({ status: 'Status: **drafted pending audit**.' }),
        },
      ],
      registry: registryFixture({ specified: '`foo`', drafted: 'none' }),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'spec-status-mismatch');
    assert.equal(check.status, 'FAIL');
    assert.match(check.findings[0].message, /drafted/);
    assert.match(check.findings[0].message, /specified/);
  });

  it('fails unscoped shortcut keys claimed by more than one owner', () => {
    const report = lintCorpus({
      specs: [{ path: 'docs/builder-program/specs/foo/foo.md', content: specFixture() }],
      registry: registryFixture({
        shortcuts: `
| Key | Function | Source | Registry state |
| --- | -------- | ------ | -------------- |
| **F4** | \`foo.bar\` | foo.md | **assigned** |
| **F4** | \`foo.other\` | bar.md | **assigned** |
`,
        armed: `
| Key | Scope | Meaning while armed | Source |
| --- | ----- | ------------------- | ------ |
| X | foo tool | unused | foo.md |
`,
      }),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'shortcut-key-collisions');
    assert.equal(check.status, 'FAIL');
    assert.match(check.findings[0].message, /F4/);
    assert.match(check.findings[0].message, /no scoped marker/);
  });

  it('does not treat the same key as a collision when a claim is marked scoped', () => {
    const report = lintCorpus({
      specs: [{ path: 'docs/builder-program/specs/foo/foo.md', content: specFixture() }],
      registry: registryFixture(),
      registryPath,
    });
    const check = report.checks.find((entry) => entry.name === 'shortcut-key-collisions');
    assert.equal(check.status, 'PASS');
    const claims = parseShortcutClaims(registryFixture());
    assert.equal(
      claims.some((claim) => claim.key === 'F4' && claim.scoped),
      true,
    );
  });
});

describe('registry-lint cli', () => {
  it('parses --json and rejects unknown flags', () => {
    assert.deepEqual(parseCliArgs(['--json']), {
      json: true,
      summary: false,
      fixRegistryStatus: false,
    });
    assert.deepEqual(parseCliArgs(['--summary']), {
      json: false,
      summary: true,
      fixRegistryStatus: false,
    });
    assert.throws(() => parseCliArgs(['--nope']), /Unknown argument/);
    assert.throws(() => parseCliArgs(['--json', '--summary']), /Cannot combine/);
  });

  it('prints a machine-readable report object from lintCorpus', () => {
    const report = lintCorpus({
      specs: [{ path: 'docs/builder-program/specs/foo/foo.md', content: specFixture() }],
      registry: registryFixture(),
      registryPath,
    });
    const parsed = JSON.parse(JSON.stringify(report));
    assert.equal(parsed.ok, true);
    assert.deepEqual(
      parsed.checks.map((check) => check.name),
      CHECK_ORDER,
    );
  });

  it('formats PASS/FAIL lines with file:line findings', () => {
    const report = lintCorpus({
      specs: [
        {
          path: 'specs/foo.md',
          content: specFixture({
            catalog: `
| Id | Function |
| -- | -------- |
| \`foo.missing\` | Missing |
`,
          }),
        },
      ],
      registry: registryFixture(),
      registryPath,
    });
    const text = formatTextReport(report);
    assert.match(text, /^FAIL function-ids-in-spec-absent-from-registry \(1\)$/m);
    assert.match(text, /^specs\/foo\.md:\d+: `foo\.missing`/m);
    const summary = formatSummaryReport(report);
    assert.match(summary, /^FAIL function-ids-in-spec-absent-from-registry 1$/m);
    assert.match(summary, /^PASS shortcut-key-collisions 0$/m);
    assert.equal(summary.trim().split('\n').length, CHECK_ORDER.length);
  });

  it('refuses --fix-registry-status as an unimplemented read-only tool', () => {
    const errChunks = [];
    const code = main(['--fix-registry-status'], {
      stdout: { write() {} },
      stderr: {
        write(chunk) {
          errChunks.push(chunk);
        },
      },
      root: '/tmp',
    });
    assert.equal(code, 2);
    assert.match(errChunks.join(''), /not implemented/);
  });

  it('parses registry §1 rows and §4.5 status from fixture strings', () => {
    const markdown = registryFixture({
      specified: '`agent`, `draw`',
      drafted: '`registration-stations`',
    });
    assert.deepEqual(
      parseRegistryRows(markdown).map((row) => row.id),
      ['foo.bar'],
    );
    const status = parseRegistryStatusTable(markdown);
    assert.equal(status.get('agent').status, 'specified');
    assert.equal(status.get('registration-stations').status, 'drafted');
  });
});
