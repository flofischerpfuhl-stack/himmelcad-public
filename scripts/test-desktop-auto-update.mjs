import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const workspace = resolve(import.meta.dirname, '..');
const products = [
  { path: 'builder', channel: 'builder', name: 'HimmelCAD Builder' },
  { path: 'photolab', channel: 'photolab', name: 'HimmelCAD PhotoLab' },
];

for (const product of products) {
  const root = join(workspace, 'apps', product.path);
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(parsed && typeof parsed === 'object' && 'dependencies' in parsed);
  const manifest = parsed;
  assert.ok(
    manifest.dependencies &&
      typeof manifest.dependencies === 'object' &&
      'electron-updater' in manifest.dependencies,
  );
  assert.equal(manifest.dependencies['electron-updater'], '6.8.9');

  const main = readFileSync(join(root, 'electron', 'main.ts'), 'utf8');
  const updater = readFileSync(join(root, 'electron', 'updater.ts'), 'utf8');
  assert.match(main, /startDesktopUpdater\(\(\) => mainWindow\)/);
  assert.match(updater, /if \(!app\.isPackaged\) return/);
  assert.match(updater, /autoUpdater\.allowPrerelease = false/);
  assert.match(updater, /autoUpdater\.autoDownload = true/);
  assert.match(updater, /autoUpdater\.quitAndInstall\(false, true\)/);
  assert.match(updater, new RegExp(`${product.name} \\$\\{info\\.version\\} is ready to install`));

  for (const platform of ['win', 'linux']) {
    const config = readFileSync(join(root, `electron-builder.${platform}.yml`), 'utf8');
    assert.match(config, /provider: github/);
    assert.match(config, /owner: flofischerpfuhl-stack/);
    assert.match(config, /repo: himmelcad-public/);
    assert.match(config, new RegExp(`channel: ${product.channel}`));
    assert.match(config, /releaseType: release/);
  }
}

const workflow = readFileSync(join(workspace, '.github/workflows/desktop-release.yml'), 'utf8');
assert.match(workflow, /push:\n\s+branches: \[main\]/);
assert.match(workflow, /gh release create[\s\S]+--draft/);
assert.match(workflow, /gh release edit[\s\S]+--draft=false --prerelease=false/);
assert.match(workflow, /Incomplete release was deleted/);
assert.match(workflow, /PHOTOLAB_RUNTIME_BUNDLES_READY/);
assert.doesNotMatch(workflow, /upload-artifact|cloudflare|\bR2\b/i);

const temporaryWorkspace = mkdtempSync(join(tmpdir(), 'himmelcad-release-version-'));
try {
  for (const product of products) {
    const directory = join(temporaryWorkspace, 'apps', product.path);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: product.path, version: '0.1.0' }, null, 2)}\n`,
    );
  }
  const versioner = join(workspace, 'scripts/set-desktop-release-version.mjs');
  const result = spawnSync(process.execPath, [versioner, '0.1.42'], {
    encoding: 'utf8',
    env: { ...process.env, HIMMELCAD_RELEASE_WORKSPACE: temporaryWorkspace },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const product of products) {
    /** @type {unknown} */
    const parsed = JSON.parse(
      readFileSync(join(temporaryWorkspace, 'apps', product.path, 'package.json'), 'utf8'),
    );
    assert.ok(parsed && typeof parsed === 'object' && 'version' in parsed);
    assert.equal(parsed.version, '0.1.42');
  }
} finally {
  rmSync(temporaryWorkspace, { recursive: true, force: true });
}

process.stdout.write('Desktop auto-update contract tests passed.\n');
