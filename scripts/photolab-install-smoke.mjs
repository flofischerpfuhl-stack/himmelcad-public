#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';

const workspace = resolve(import.meta.dirname, '..');
const platform = process.argv[2];
if (!['linux-x64', 'win32-x64'].includes(platform ?? '')) usage();
const artifact = process.argv[3]
  ? resolve(process.argv[3])
  : discoverArtifact(platform, join(workspace, 'apps', 'photolab', 'release'));
if (!artifact || !existsSync(artifact)) usage();
const hostPlatform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
if (hostPlatform !== platform) {
  fail(
    `installation certification for ${platform} must run on a native ${platform} host; Wine is deliberately not accepted`,
  );
}

const temporary = mkdtempSync(join(tmpdir(), 'himmelcad-photolab-install-smoke-'));
let uninstall = null;
try {
  let unpackedRoot;
  if (platform === 'linux-x64') {
    if (artifact.toLowerCase().endsWith('.deb')) {
      execFileSync('dpkg-deb', ['-x', artifact, temporary], { stdio: 'inherit' });
      unpackedRoot = findUnpackedRoot(temporary);
    } else if (artifact.toLowerCase().endsWith('.appimage')) {
      const extraction = spawnSync(artifact, ['--appimage-extract'], {
        cwd: temporary,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (extraction.error || extraction.status !== 0) {
        fail(`AppImage extraction failed: ${extraction.error?.message ?? extraction.stderr}`);
      }
      unpackedRoot = findUnpackedRoot(join(temporary, 'squashfs-root'));
    } else {
      fail('Linux install smoke accepts a .deb or .AppImage artifact');
    }
  } else {
    if (extname(artifact).toLowerCase() !== '.exe' || !artifact.toLowerCase().includes('setup')) {
      fail('native Windows install smoke requires the NSIS setup executable');
    }
    const installRoot = join(temporary, 'installed');
    const installation = spawnSync(artifact, ['/S', `/D=${installRoot}`], {
      encoding: 'utf8',
      timeout: 10 * 60_000,
      windowsHide: true,
    });
    if (installation.error || installation.status !== 0) {
      fail(
        `NSIS installation failed: ${installation.error?.message ?? installation.stderr ?? installation.stdout}`,
      );
    }
    unpackedRoot = findUnpackedRoot(installRoot);
    uninstall = findFile(installRoot, (name) => /^uninstall.*\.exe$/i.test(name));
  }
  execFileSync(
    process.execPath,
    [
      join(workspace, 'scripts/photolab-package-smoke.mjs'),
      platform,
      unpackedRoot,
      '--mode=native',
    ],
    { stdio: 'inherit' },
  );
  process.stdout.write(`PhotoLab native install smoke passed: ${platform} · ${artifact}\n`);
} finally {
  if (uninstall && existsSync(uninstall)) {
    spawnSync(uninstall, ['/S'], { timeout: 5 * 60_000, windowsHide: true });
  }
  rmSync(temporary, { recursive: true, force: true });
}

function findUnpackedRoot(root) {
  const resources = findFile(
    root,
    (name, path) => name === 'app.asar' && /[\\/]resources[\\/]/.test(path),
  );
  if (!resources) fail(`installed Electron resources/app.asar was not found below ${root}`);
  return dirname(dirname(resources));
}

function findFile(root, predicate) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && predicate(entry.name, path)) return path;
    }
  }
  return null;
}

function discoverArtifact(target, directory) {
  if (!existsSync(directory)) return null;
  const candidates = readdirSync(directory)
    .filter((name) =>
      target === 'win32-x64'
        ? /HimmelCAD-PhotoLab-.+-x64-setup\.exe$/i.test(name)
        : /HimmelCAD-PhotoLab-.+\.(?:deb|AppImage)$/i.test(name),
    )
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

function usage() {
  fail('usage: photolab-install-smoke.mjs <linux-x64|win32-x64> [deb|AppImage|NSIS-setup.exe]');
}

function fail(message) {
  process.stderr.write(`PhotoLab install smoke failed: ${message}\n`);
  process.exit(1);
}
