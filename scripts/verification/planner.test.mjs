import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseNulList, shallowUnknownUntracked } from './git-changes.mjs';
import { resolveCargoExecutable } from './cargo-resolver.mjs';
import { createVerificationPlan } from './planner.mjs';

const root = resolve(import.meta.dirname, '../..');
const ids = (plan) => plan.tasks.map((task) => task.id);

describe('verification planner', () => {
  it('resolves Cargo from the override, known homes, rustup shims and PATH', () => {
    const resolveFrom = (environment, executable) =>
      resolveCargoExecutable({
        environment,
        platform: 'linux',
        isExecutable: (path) => path === executable,
      });

    assert.equal(
      resolveFrom({ CARGO: '/toolchain/cargo' }, '/toolchain/cargo'),
      '/toolchain/cargo',
    );
    assert.equal(
      resolveFrom({ CARGO_HOME: '/cargo-home' }, '/cargo-home/bin/cargo'),
      '/cargo-home/bin/cargo',
    );
    assert.equal(
      resolveFrom({ HOME: '/home/tester' }, '/home/tester/.cargo/bin/cargo'),
      '/home/tester/.cargo/bin/cargo',
    );
    assert.equal(
      resolveFrom({ RUSTUP_HOME: '/rustup' }, '/rustup/shims/cargo'),
      '/rustup/shims/cargo',
    );
    assert.equal(
      resolveFrom({ PATH: '/usr/local/bin:/usr/bin' }, '/usr/bin/cargo'),
      '/usr/bin/cargo',
    );
    assert.equal(
      resolveCargoExecutable({
        environment: { Path: String.raw`C:\Windows;C:\Rust\bin` },
        platform: 'win32',
        isExecutable: (path) => path === String.raw`C:\Rust\bin\cargo.exe`,
      }),
      String.raw`C:\Rust\bin\cargo.exe`,
    );
  });

  it('reports every Cargo search location when Cargo is absent', () => {
    assert.throws(
      () =>
        resolveCargoExecutable({
          environment: {
            CARGO: '/custom/cargo',
            CARGO_HOME: '/cargo-home',
            HOME: '/home/tester',
            RUSTUP_HOME: '/rustup',
            PATH: '/usr/local/bin:/usr/bin',
          },
          platform: 'linux',
          isExecutable: () => false,
        }),
      (error) => {
        assert.match(error.message, /CARGO \(\/custom\/cargo\)/);
        assert.match(error.message, /CARGO_HOME\/bin \(\/cargo-home\/bin\/cargo\)/);
        assert.match(error.message, /HOME\/\.cargo\/bin rustup proxy/);
        assert.match(error.message, /RUSTUP_HOME\/shims \(\/rustup\/shims\/cargo\)/);
        assert.match(error.message, /PATH \(\/usr\/bin\/cargo\)/);
        return true;
      },
    );
  });

  it('uses the resolved Cargo executable for every emitted Cargo task', () => {
    const cargoExecutable = '/toolchains/pinned/bin/cargo';
    const releasePlan = createVerificationPlan({
      root,
      tier: 'release',
      paths: [],
      cargoExecutable,
    });
    const schemaPlan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['schemas/automation/fixtures/automation-wire-v1.json'],
      cargoExecutable,
    });
    const packagePlan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['crates/himmelcad-core/src/lib.rs'],
      cargoExecutable,
    });
    const cargoTasks = [...releasePlan.tasks, ...schemaPlan.tasks, ...packagePlan.tasks].filter(
      ({ id }) =>
        id.startsWith('rust.') || id === 'automation.wire-rust' || id === 'licenses.cargo-deny',
    );

    const expectedArgs = new Map([
      [
        'automation.wire-rust',
        ['test', '-p', 'himmelcad-core', '--test', 'automation_schema_golden'],
      ],
      ['rust.test:workspace', ['test', '--workspace']],
      ['rust.test:himmelcad-core', ['test', '-p', 'himmelcad-core']],
      ['rust.fmt', ['fmt', '--all', '--', '--check']],
      ['rust.clippy', ['clippy', '--workspace', '--all-targets']],
      ['licenses.cargo-deny', ['deny', 'check']],
    ]);

    assert.deepEqual(new Set(cargoTasks.map(({ id }) => id)), new Set(expectedArgs.keys()));
    for (const cargoTask of cargoTasks) {
      assert.equal(cargoTask.command, cargoExecutable);
      assert.deepEqual(cargoTask.args, expectedArgs.get(cargoTask.id));
      assert.ok(cargoTask.resourceKeys.some((key) => key.startsWith('cargo:')));
    }
  });

  it('declares exclusive lanes for Cargo, package outputs, staging, fixtures and targets', () => {
    const previousTarget = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = 'target/builder';
    try {
      const release = createVerificationPlan({
        root,
        tier: 'release',
        paths: [],
        cargoExecutable: '/toolchains/pinned/bin/cargo',
      });
      const byId = new Map(release.tasks.map((task) => [task.id, task]));
      assert.ok(byId.get('rust.test:workspace').resourceKeys.includes('cargo:target/builder'));
      assert.ok(byId.get('rust.clippy').resourceKeys.includes('cargo:target/builder'));
      assert.ok(
        byId.get('viewer.browser-real-parity').resourceKeys.includes('wasm-staging:viewer-kernel'),
      );
      assert.ok(
        byId.get('viewer.real-dgm').resourceKeys.includes('fixture:target/viewer-real-dgm-section'),
      );
      assert.ok(
        byId.get('photolab.package-linux').resourceKeys.includes('package-staging:photolab'),
      );
      assert.deepEqual(byId.get('node.typecheck:@himmelcad/builder').resourceKeys, [
        'node-package:@himmelcad/builder',
      ]);
      assert.deepEqual(byId.get('node.test:@himmelcad/builder').resourceKeys, [
        'node-package:@himmelcad/builder',
      ]);
      assert.notDeepEqual(
        byId.get('node.typecheck:@himmelcad/builder').resourceKeys,
        byId.get('node.typecheck:@himmelcad/viewer').resourceKeys,
      );
    } finally {
      if (previousTarget === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = previousTarget;
    }
  });

  it('parses names with spaces and rename output without line splitting', () => {
    assert.deepEqual(parseNulList('docs/a file.md\0apps/builder/new.ts\0'), [
      'docs/a file.md',
      'apps/builder/new.ts',
    ]);
  });

  it('keeps docs-only changed checks compiler-free', () => {
    const plan = createVerificationPlan({ root, tier: 'changed', paths: ['docs/example.md'] });
    assert.equal(plan.risk, 'low');
    assert.deepEqual(ids(plan), ['git.diff-check']);
  });

  it('runs English UI once for commit and never for changed', () => {
    const paths = ['apps/photolab/renderer/src/App.tsx'];
    assert.equal(
      ids(createVerificationPlan({ root, tier: 'changed', paths })).includes('photolab.english-ui'),
      false,
    );
    assert.equal(
      ids(createVerificationPlan({ root, tier: 'commit', paths })).filter(
        (id) => id === 'photolab.english-ui',
      ).length,
      1,
    );
  });

  it('escalates viewer work to browser and portable workspace gates on push', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'push',
      paths: ['packages/@himmelcad/viewer/src/index.ts'],
    });
    assert.equal(plan.risk, 'high');
    assert.ok(ids(plan).includes('viewer.browser-kernel'));
    assert.ok(ids(plan).includes('node.lint'));
  });

  it('deduplicates tasks and preserves stable ordering', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'commit',
      paths: [
        'apps/photolab/renderer/src/App.tsx',
        'apps/photolab/renderer/src/FloatingTaskIsland.tsx',
      ],
    });
    assert.equal(new Set(ids(plan)).size, ids(plan).length);
  });

  it('treats raw photolab data as non-source', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['photolab/capture/images/a.jpg'],
    });
    assert.equal(plan.classifications[0].risk, 'none');
    assert.deepEqual(ids(plan), ['git.diff-check']);
  });

  it('runs the generated automation SDK gate only for its contract inputs', () => {
    for (const path of [
      'schemas/automation/himmelcad-automation-v1.schema.json',
      'scripts/generate-automation-sdk.py',
      'sdk/python/src/himmelcad/client.py',
    ]) {
      const plan = createVerificationPlan({ root, tier: 'changed', paths: [path] });
      assert.equal(plan.risk, 'high');
      assert.equal(ids(plan).filter((id) => id === 'automation.sdk').length, 1);
    }
    const schemaPlan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['schemas/automation/fixtures/automation-wire-v1.json'],
    });
    assert.equal(ids(schemaPlan).filter((id) => id === 'automation.wire-rust').length, 1);
    const sdkOnly = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['sdk/python/src/himmelcad/client.py'],
    });
    assert.equal(ids(sdkOnly).includes('automation.wire-rust'), false);
    const unrelated = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['apps/builder/renderer/src/App.tsx'],
    });
    assert.equal(ids(unrelated).includes('automation.sdk'), false);
  });

  it('always includes the generated automation SDK gate for release', () => {
    const plan = createVerificationPlan({ root, tier: 'release', paths: [] });
    assert.equal(ids(plan).filter((id) => id === 'automation.sdk').length, 1);
    assert.equal(
      plan.tasks.find((task) => task.id === 'automation.runtime-stage-linux')?.requiredCapability,
      'linux-package',
    );
    assert.equal(
      plan.tasks.find((task) => task.id === 'automation.runtime-stage-windows')?.requiredCapability,
      'windows-package',
    );
    assert.ok(
      ids(plan).indexOf('automation.runtime-stage-linux') <
        ids(plan).indexOf('node.test:@himmelcad/automation-host'),
    );
  });

  it('treats automation schema, SDK and managed runtime roots as known source roots', () => {
    const unknown = shallowUnknownUntracked();
    assert.equal(unknown.includes('schemas/'), false);
    assert.equal(unknown.includes('sdk/'), false);
    assert.equal(unknown.includes('runtime/'), false);
  });

  it('treats the managed automation runtime as a release artifact', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['runtime/automation-runtime-manifest.json'],
    });
    assert.equal(plan.risk, 'release');
    assert.ok(ids(plan).includes('automation.sdk'));
    assert.ok(ids(plan).includes('automation.runtime-packager'));
    assert.ok(ids(plan).includes('node.test:@himmelcad/automation-host'));
    assert.ok(ids(plan).includes('node.typecheck:@himmelcad/automation-host'));
  });

  it('selects managed-runtime gates for reproducible automation build scripts', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['scripts/build-automation-linux-opencv.sh'],
    });
    assert.equal(plan.risk, 'release');
    assert.ok(ids(plan).includes('automation.sdk'));
    assert.ok(ids(plan).includes('automation.runtime-packager'));
    assert.ok(ids(plan).includes('node.test:@himmelcad/automation-host'));
  });
});
