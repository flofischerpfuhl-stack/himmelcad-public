# I-03b TypeScript project references — verification evidence

Document class: report / implementation evidence  
Recorded: 2026-09-02  
Work package: I-03b (second attempt)

## Outcome

`G-INFRA-TSC`: **PASS**. `pnpm typecheck` now invokes one `tsc -b` solution
graph covering the first-party TypeScript packages and applications, followed
by the existing PhotoLab English-UI check. Each project writes declarations,
declaration maps, and incremental build information below its local
`.tsbuild/` directory. `.tsbuild/` is git-ignored, and no declaration is
emitted next to a source file.

The solution contains these projects, ordered by their explicit references:

```text
packages/@himmelcad/data/tsconfig.json
packages/@himmelcad/app/tsconfig.json
packages/@himmelcad/theme/tsconfig.json
packages/@himmelcad/ui/tsconfig.json
packages/@himmelcad/console/tsconfig.json
packages/@himmelcad/viewer/tsconfig.json
packages/@himmelcad/agent/tsconfig.json
packages/@himmelcad/automation-host/tsconfig.json
packages/@himmelcad/plan/tsconfig.json
packages/@himmelcad/specs/tsconfig.json
apps/builder/tsconfig.json
apps/builder/tsconfig.typecheck-electron.json
apps/photolab/tsconfig.typecheck-electron.json
apps/photolab/tsconfig.json
apps/weltview/tsconfig.json
tsconfig.json
```

The desktop runtime build configurations remain unchanged. Separate
`tsconfig.typecheck-electron.json` composite projects perform declaration-only
checking under `.tsbuild/`, so `tsconfig.electron.json` continues to emit the
JavaScript used by development and packaging.

## Resolution trace and corrected diagnosis

Before retaining migration changes, a temporary composite `data -> viewer`
trace was run with `packages/@himmelcad/viewer/src/Viewport.tsx` as the sole
viewer entry file:

```text
======== Resolving module '@himmelcad/data' from '.../packages/@himmelcad/viewer/src/Viewport.tsx'. ========
Module name '@himmelcad/data', matched pattern '@himmelcad/data'.
Trying substitution 'packages/@himmelcad/data/src/index.ts', candidate module location: 'packages/@himmelcad/data/src/index.ts'.
File '.../packages/@himmelcad/data/src/index.ts' exists - use it as a name resolution result.
======== Module name '@himmelcad/data' was successfully resolved to '.../packages/@himmelcad/data/src/index.ts'. ========
```

`--listFiles` on the same composite build showed the important second step:
the data project itself compiled `packages/@himmelcad/data/src/index.ts`, while
the viewer consumer read the declaration redirect at:

```text
packages/@himmelcad/data/.build/i03b-trace/types/src/index.d.ts
```

Thus `--traceResolution` reports the path-alias source target, and project
reference redirection subsequently substitutes the declaration output in the
consumer. The retained layout preserves the source-relative `src/` segment,
so the corresponding production redirect is:

```text
packages/@himmelcad/data/.tsbuild/types/src/index.d.ts
```

The stale first-attempt declaration at
`packages/@himmelcad/data/.build/types/src/index.d.ts` and the fresh traced
declaration both export `EntityId`, `SnapKind`, `SnapSource`,
`GeometryPrimitiveRef`, `GeometryTargetRef`, `SnapTargetMask`, and
`SnapResult`. No data-package export change was needed. The first attempt's
TS2305 was therefore a stale or incorrectly mapped declaration redirect, not a
missing public export. `tsconfig.base.json` path aliases and
`packages/@himmelcad/data/package.json` source-facing runtime exports remain
unchanged.

The first full graph build also identified four transitive viewer test helpers
that the old non-composite program accepted without listing. They are now
listed explicitly in the viewer project; this satisfies composite's complete
file-list requirement without broadly adding unrelated test programs.

PhotoLab's renderer import of `../../electron/projectLifecycle.js` is resolved
through an explicit reference to the PhotoLab Electron typecheck project. No
source was moved or duplicated.

## Diagnostics parity probe

A temporary, removed probe was added at
`packages/@himmelcad/agent/src/index.ts:18`:

```ts
const i03bDiagnosticParityProbe: string = 1;
```

The old `tsc --noEmit` package configuration and the new `tsc -b` package
configuration produced identical diagnostic lines:

```text
src/index.ts(18,7): error TS2322: Type 'number' is not assignable to type 'string'.
src/index.ts(18,7): error TS6133: 'i03bDiagnosticParityProbe' is declared but its value is never read.
```

The probe was removed before final verification.

## Cold and warm measurements

The cold measurement was taken after deleting every generated `.tsbuild/`
directory. The warm measurement was the immediate no-change rerun of the same
root command.

```text
/usr/bin/time -p pnpm typecheck
# cold: exit 0
# real 35.35
# user 55.66
# sys 1.23

/usr/bin/time -p pnpm typecheck
# warm, no changes: exit 0
# real 2.03
# user 1.69
# sys 0.29
```

Warm/cold ratio: `2.03 / 35.35 = 5.74%`, passing the required `<= 25%` gate.
A later final no-change confirmation completed in 1.96 s.

## Tests and checks run

```text
pnpm typecheck
# pass; PhotoLab English UI check passed

pnpm --filter @himmelcad/photolab typecheck
# pass; PhotoLab English UI check passed

pnpm --filter @himmelcad/builder typecheck
# pass

pnpm --filter @himmelcad/weltview typecheck
# pass

pnpm --filter @himmelcad/app test
# tests 14, pass 14, fail 0

pnpm --filter @himmelcad/ui test
# tests 11, pass 11, fail 0

pnpm exec tsc -b --verbose --pretty false
# pass; all 15 referenced projects reported up to date

git diff --check
# pass
```

No Cargo command was run.

## Files changed

```text
.gitignore
package.json
tsconfig.json
apps/builder/package.json
apps/builder/tsconfig.json
apps/builder/tsconfig.typecheck-electron.json
apps/photolab/package.json
apps/photolab/tsconfig.json
apps/photolab/tsconfig.typecheck-electron.json
apps/weltview/package.json
apps/weltview/tsconfig.json
packages/@himmelcad/agent/package.json
packages/@himmelcad/agent/tsconfig.json
packages/@himmelcad/agent/tsconfig.test.json
packages/@himmelcad/app/package.json
packages/@himmelcad/app/tsconfig.json
packages/@himmelcad/app/tsconfig.test.json
packages/@himmelcad/automation-host/package.json
packages/@himmelcad/automation-host/tsconfig.json
packages/@himmelcad/console/package.json
packages/@himmelcad/console/tsconfig.json
packages/@himmelcad/data/package.json
packages/@himmelcad/data/tsconfig.json
packages/@himmelcad/plan/package.json
packages/@himmelcad/plan/tsconfig.json
packages/@himmelcad/plan/tsconfig.test.json
packages/@himmelcad/specs/package.json
packages/@himmelcad/specs/tsconfig.json
packages/@himmelcad/specs/tsconfig.test.json
packages/@himmelcad/theme/package.json
packages/@himmelcad/theme/tsconfig.json
packages/@himmelcad/ui/package.json
packages/@himmelcad/ui/tsconfig.json
packages/@himmelcad/ui/tsconfig.test.json
packages/@himmelcad/viewer/package.json
packages/@himmelcad/viewer/tsconfig.browser.json
packages/@himmelcad/viewer/tsconfig.json
packages/@himmelcad/viewer/tsconfig.test.json
docs/builder-program/evidence/I-03-ts-project-references-2026-09-02.md
```

The test and browser configs that extend a composite production config
explicitly disable composite/declaration-only mode so their existing runnable
test output remains JavaScript. There were no runtime source changes and no
type-only export changes.

## Not verified

- CI and non-Linux hosts were not run.
- Tests outside the required `@himmelcad/app` and `@himmelcad/ui` acceptance
  set were not run.
- Runtime builds and packaging were not run; their Electron emit configs were
  deliberately left unchanged.
