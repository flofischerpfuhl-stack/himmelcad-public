import { execFileSync } from 'node:child_process';

const SOURCE_ROOTS = [
  'apps',
  'crates',
  'docs',
  'packages',
  'runtime',
  'schemas',
  'scripts',
  'sdk',
  'types',
  'vendor',
  '.gitlab-ci.yml',
  '.githooks',
  'Cargo.toml',
  'Cargo.lock',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'rust-toolchain.toml',
  'tsconfig.base.json',
];

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

export function parseNulList(value) {
  return value.split('\0').filter(Boolean);
}

function unique(paths) {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

export function changedPathsForTier(tier, { base } = {}) {
  if (tier === 'release') return [];
  if (tier === 'commit') {
    return unique(
      parseNulList(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRDTUXB'])),
    );
  }
  if (tier === 'push') {
    const comparisonBase =
      base || git(['rev-parse', '--verify', '@{upstream}'], { allowFailure: true }).trim();
    const fallbackBase = git(['rev-parse', '--verify', 'HEAD^'], { allowFailure: true }).trim();
    const resolvedBase = comparisonBase || fallbackBase;
    if (!resolvedBase)
      return unique(parseNulList(git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])));
    const mergeBase =
      git(['merge-base', resolvedBase, 'HEAD'], { allowFailure: true }).trim() || resolvedBase;
    return unique(
      parseNulList(
        git(['diff', '--name-only', '-z', '--diff-filter=ACMRDTUXB', `${mergeBase}..HEAD`]),
      ),
    );
  }

  const tracked = [
    ...parseNulList(git(['diff', '--name-only', '-z', '--diff-filter=ACMRDTUXB', 'HEAD'])),
    ...parseNulList(
      git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRDTUXB', 'HEAD']),
    ),
  ];
  // Restrict untracked enumeration to known source roots. In particular, do
  // not recurse through user datasets below top-level `photolab/`.
  const untracked = parseNulList(
    git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...SOURCE_ROOTS]),
  );
  return unique([...tracked, ...untracked]);
}

export function shallowUnknownUntracked() {
  const entries = parseNulList(
    git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { allowFailure: true }),
  );
  return entries
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .filter((path) => !SOURCE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)));
}
