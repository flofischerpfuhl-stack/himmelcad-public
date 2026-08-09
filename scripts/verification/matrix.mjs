import { extname } from 'node:path';

export const RISK = Object.freeze({ low: 0, normal: 1, high: 2, release: 3 });

const DOC_EXTENSIONS = new Set(['.md', '.html', '.txt']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss']);

export function classifyPath(path) {
  const extension = extname(path).toLowerCase();
  if (path.startsWith('photolab/') && !path.endsWith('PHOTOLAB-CONCEPT.md')) {
    return { risk: 'none', groups: ['local-data'] };
  }
  if (DOC_EXTENSIONS.has(extension) || path.startsWith('docs/'))
    return { risk: 'low', groups: ['docs'] };
  if (
    /^(?:scripts\/(?:stage-automation-runtime\.mjs|build-automation-.*|package-staged-python-wheel\.py)|scripts\/verification\/(?:audit-.*opencv.*|package_staged_python_wheel_test\.py))$/.test(
      path,
    )
  ) {
    return {
      risk: 'release',
      groups: ['release', 'licenses', 'automation-sdk', 'automation-runtime'],
    };
  }
  if (
    /^(LICENSES\/|vendor\/|.*electron-builder\.|scripts\/(?:fetch|stage|build-).*|pnpm-lock\.yaml)/.test(
      path,
    )
  ) {
    return { risk: 'release', groups: ['release', 'licenses'] };
  }
  if (/^(\.gitlab-ci\.yml|\.githooks\/|scripts\/verification\/|scripts\/verify\.mjs)/.test(path)) {
    return { risk: 'high', groups: ['verification'] };
  }
  if (path.startsWith('schemas/automation/')) {
    return { risk: 'high', groups: ['automation-sdk', 'automation-schema'] };
  }
  if (/^(sdk\/python\/|scripts\/generate-automation-sdk\.py$)/.test(path)) {
    return { risk: 'high', groups: ['automation-sdk'] };
  }
  if (path.startsWith('runtime/')) {
    return {
      risk: 'release',
      groups: ['release', 'licenses', 'automation-sdk', 'automation-runtime'],
    };
  }
  if (
    /^(Cargo\.(?:toml|lock)|rust-toolchain\.toml|tsconfig\.base\.json|package\.json|pnpm-workspace\.yaml)/.test(
      path,
    )
  ) {
    return { risk: 'high', groups: ['workspace'] };
  }
  if (
    /^(crates\/(?:himmelcad-core|himmelcad-render|himmelcad-io|himmelcad-sidecar|himmelcad-wasm|himmelcad-decode)\/)/.test(
      path,
    )
  ) {
    return { risk: 'high', groups: ['rust', 'core'] };
  }
  if (/^(packages\/@himmelcad\/viewer\/|packages\/@himmelcad\/data\/)/.test(path)) {
    return { risk: 'high', groups: ['node', 'viewer'] };
  }
  if (/^apps\/photolab\/(electron|preload)\//.test(path)) {
    return { risk: 'high', groups: ['node', 'photolab', 'electron'] };
  }
  if (path.startsWith('apps/photolab/renderer/')) {
    return { risk: 'normal', groups: ['node', 'photolab-ui'] };
  }
  if (path.startsWith('crates/')) return { risk: 'high', groups: ['rust'] };
  if (
    (path.startsWith('apps/') || path.startsWith('packages/@himmelcad/')) &&
    SOURCE_EXTENSIONS.has(extension)
  ) {
    return { risk: 'normal', groups: ['node'] };
  }
  if (/^(scripts\/|types\/)/.test(path) && SOURCE_EXTENSIONS.has(extension)) {
    return { risk: 'high', groups: ['node', 'scripts'] };
  }
  return { risk: 'high', groups: ['unknown-source'] };
}

export function maxRisk(classifications) {
  return classifications.reduce(
    (highest, classification) =>
      RISK[classification.risk] > RISK[highest] ? classification.risk : highest,
    'low',
  );
}

export function isFormatCandidate(path) {
  return /\.(?:css|html|js|jsx|json|md|mjs|scss|ts|tsx|ya?ml)$/.test(path);
}

export function isLintCandidate(path) {
  return /\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(path);
}

export function affectsEnglishUi(path) {
  return (
    /^apps\/photolab\/(?:renderer|electron)\//.test(path) ||
    path === 'scripts/check-photolab-english-ui.mjs'
  );
}
