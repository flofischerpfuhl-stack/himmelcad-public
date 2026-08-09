import {
  classifyPath,
  affectsEnglishUi,
  isFormatCandidate,
  isLintCandidate,
  maxRisk,
  RISK,
} from './matrix.mjs';
import {
  loadNodeWorkspace,
  packageForPath,
  reverseNodeClosure,
  rustPackageForPath,
} from './workspace-graph.mjs';

function task(id, command, args, options = {}) {
  return { id, command, args, cwd: options.cwd, requiredCapability: options.requiredCapability };
}

function add(map, value) {
  if (!map.has(value.id)) map.set(value.id, value);
}

export function createVerificationPlan({ root, tier, paths }) {
  const classifications = paths.map((path) => ({ path, ...classifyPath(path) }));
  const risk = tier === 'release' ? 'release' : maxRisk(classifications);
  const tasks = new Map();
  const activePaths = classifications
    .filter(({ risk: pathRisk }) => pathRisk !== 'none')
    .map(({ path }) => path);
  const groups = new Set(classifications.flatMap((classification) => classification.groups));

  add(
    tasks,
    task(
      'git.diff-check',
      'git',
      tier === 'commit' ? ['diff', '--cached', '--check'] : ['diff', '--check'],
    ),
  );

  if (tier === 'release' || groups.has('verification')) {
    add(
      tasks,
      task('verification.self-test', 'node', ['--test', 'scripts/verification/planner.test.mjs'], {
        cwd: root,
      }),
    );
  }

  if (tier === 'release' || groups.has('automation-sdk')) {
    add(
      tasks,
      task('automation.sdk', 'python3', ['-m', 'unittest', 'discover', '-s', 'sdk/python/tests']),
    );
  }
  if (tier === 'release' || groups.has('automation-runtime')) {
    add(
      tasks,
      task('automation.runtime-packager', 'python3', [
        '-m',
        'unittest',
        'scripts/verification/package_staged_python_wheel_test.py',
      ]),
    );
    if (tier === 'release') {
      add(
        tasks,
        task(
          'automation.runtime-stage-linux',
          'node',
          ['scripts/stage-automation-runtime.mjs', 'linux-x64', '--release'],
          { requiredCapability: 'linux-package' },
        ),
      );
      add(
        tasks,
        task(
          'automation.runtime-stage-windows',
          'node',
          ['scripts/stage-automation-runtime.mjs', 'win32-x64', '--release'],
          { requiredCapability: 'windows-package' },
        ),
      );
    }
    add(
      tasks,
      task('node.typecheck:@himmelcad/automation-host', 'pnpm', [
        '--filter',
        '@himmelcad/automation-host',
        'typecheck',
      ]),
    );
    add(
      tasks,
      task('node.test:@himmelcad/automation-host', 'pnpm', [
        '--filter',
        '@himmelcad/automation-host',
        'test',
      ]),
    );
  }
  if (groups.has('automation-schema') && (tier === 'changed' || tier === 'commit')) {
    add(
      tasks,
      task('automation.wire-rust', 'cargo', [
        'test',
        '-p',
        'himmelcad-core',
        '--test',
        'automation_schema_golden',
      ]),
    );
  }

  const packages = loadNodeWorkspace(root);
  const directlyAffected = activePaths
    .map((path) => packageForPath(packages, path))
    .filter(Boolean);
  const affectedPackages = reverseNodeClosure(packages, directlyAffected);
  if (groups.has('workspace') || tier === 'release') {
    affectedPackages.splice(0, affectedPackages.length, ...[...packages.keys()].sort());
  }
  for (const name of affectedPackages) {
    const manifest = packages.get(name)?.manifest;
    if (manifest?.scripts?.typecheck) {
      add(tasks, task(`node.typecheck:${name}`, 'pnpm', ['--filter', name, 'typecheck']));
    }
    if (manifest?.scripts?.test && (tier !== 'changed' || directlyAffected.includes(name))) {
      add(tasks, task(`node.test:${name}`, 'pnpm', ['--filter', name, 'test']));
    }
  }

  const rustPackages = [
    ...new Set(activePaths.map((path) => rustPackageForPath(root, path)).filter(Boolean)),
  ].sort();
  if (
    tier === 'release' ||
    (tier === 'push' && RISK[risk] >= RISK.high) ||
    groups.has('workspace')
  ) {
    add(tasks, task('rust.test:workspace', 'cargo', ['test', '--workspace']));
  } else {
    for (const name of rustPackages)
      add(tasks, task(`rust.test:${name}`, 'cargo', ['test', '-p', name]));
  }

  if (tier === 'commit') {
    const formatPaths = activePaths.filter(isFormatCandidate);
    const lintPaths = activePaths.filter(isLintCandidate);
    if (formatPaths.length)
      add(
        tasks,
        task('node.prettier:changed', 'pnpm', ['exec', 'prettier', '--check', ...formatPaths]),
      );
    if (lintPaths.length)
      add(
        tasks,
        task('node.eslint:changed', 'pnpm', [
          'exec',
          'eslint',
          '--max-warnings',
          '0',
          ...lintPaths,
        ]),
      );
    if (rustPackages.length)
      add(tasks, task('rust.fmt', 'cargo', ['fmt', '--all', '--', '--check']));
    add(tasks, task('photolab.english-ui', 'pnpm', ['photolab:check:english-ui']));
  }

  if (tier === 'push') {
    if (groups.has('photolab-ui'))
      add(tasks, task('photolab.visual', 'pnpm', ['photolab:test:visual']));
    if (groups.has('photolab') || groups.has('electron')) {
      add(tasks, task('photolab.contracts', 'pnpm', ['photolab:test:e2e-contracts']));
      add(tasks, task('photolab.dialog-policy', 'pnpm', ['photolab:test:dialog-policy']));
    }
    if (groups.has('viewer') || groups.has('core')) {
      add(
        tasks,
        task('viewer.browser-kernel', 'pnpm', [
          '--filter',
          '@himmelcad/viewer',
          'test:browser-kernel',
        ]),
      );
    }
    if (activePaths.some(affectsEnglishUi))
      add(tasks, task('photolab.english-ui', 'pnpm', ['photolab:check:english-ui']));
    if (RISK[risk] >= RISK.high) {
      add(tasks, task('node.lint', 'pnpm', ['lint']));
      add(tasks, task('rust.clippy', 'cargo', ['clippy', '--workspace', '--all-targets']));
    }
  }

  if (tier === 'release') {
    for (const value of [
      task('node.lint', 'pnpm', ['lint']),
      task('node.format', 'pnpm', ['format:check']),
      task('rust.fmt', 'cargo', ['fmt', '--all', '--', '--check']),
      task('rust.clippy', 'cargo', ['clippy', '--workspace', '--all-targets']),
      task('photolab.english-ui', 'pnpm', ['photolab:check:english-ui']),
      task('branding', 'pnpm', ['branding:check']),
      task('product-names', 'pnpm', ['product-names:check']),
      task('data.bindings', 'pnpm', ['--filter', '@himmelcad/data', 'bindings:check']),
      task(
        'viewer.browser-real-parity',
        'pnpm',
        ['--filter', '@himmelcad/viewer', 'test:browser-kernel-real-parity'],
        { requiredCapability: 'browser-gpu' },
      ),
      task('viewer.real-dgm', 'pnpm', ['viewer:test:real-dgm-section'], {
        requiredCapability: 'real-data',
      }),
      task('viewer.large-mesh', 'pnpm', ['viewer:test:large-prepared-mesh'], {
        requiredCapability: 'real-data',
      }),
      task('photolab.golden', 'pnpm', ['photolab:test:golden:agisoft'], {
        requiredCapability: 'real-data',
      }),
      task('photolab.package-linux', 'pnpm', ['photolab:smoke:install:linux'], {
        requiredCapability: 'linux-package',
      }),
      task('photolab.package-windows', 'pnpm', ['photolab:smoke:install:win'], {
        requiredCapability: 'windows-package',
      }),
      task('licenses.cargo-deny', 'cargo', ['deny', 'check']),
    ])
      add(tasks, value);
  }

  return { tier, risk, paths, classifications, tasks: [...tasks.values()] };
}
