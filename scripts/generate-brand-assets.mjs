#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const sourceRoot = join(workspace, 'branding/logos/source');
const generatedRoot = join(workspace, 'branding/logos/generated');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const variants = [
  {
    id: 'photolab',
    source: 'himmelcad-photolab.svg',
    app: 'photolab',
  },
  {
    id: 'builder-primary',
    source: 'himmelcad-builder-primary.svg',
    app: 'builder',
  },
  {
    id: 'builder-reserve-hoodie-ready',
    source: 'himmelcad-builder-reserve-hoodie-ready.svg',
  },
];

for (const variant of variants) generateVariant(variant);

function generateVariant(variant) {
  const source = join(sourceRoot, variant.source);
  if (!existsSync(source)) throw new Error(`Missing original SVG: ${source}`);
  const output = join(generatedRoot, variant.id);
  mkdirSync(output, { recursive: true });
  const pngs = [];
  for (const size of sizes) {
    const temporary = join(output, `.icon-${size}.tmp.png`);
    const destination = join(output, `icon-${size}.png`);
    execFileSync(
      'inkscape',
      [
        source,
        '--export-type=png',
        `--export-filename=${temporary}`,
        `--export-width=${size}`,
        `--export-height=${size}`,
        '--export-background-opacity=0',
      ],
      deterministicEnvironment(),
    );
    execFileSync(
      'convert',
      [temporary, '-strip', '-define', 'png:exclude-chunks=date,time', destination],
      deterministicEnvironment(),
    );
    rmSync(temporary, { force: true });
    pngs.push(destination);
  }
  const ico = join(output, 'icon.ico');
  execFileSync(
    'convert',
    [
      ...pngs.filter((path) => !path.endsWith('icon-512.png') && !path.endsWith('icon-1024.png')),
      '-strip',
      ico,
    ],
    deterministicEnvironment(),
  );
  if (variant.app) publishAppIcons(variant.app, output);
}

function publishAppIcons(app, source) {
  const appRoot = join(workspace, 'apps', app);
  if (!existsSync(appRoot)) return;
  const build = join(appRoot, 'build');
  mkdirSync(build, { recursive: true });
  copyFileSync(join(source, 'icon-512.png'), join(build, 'icon.png'));
  copyFileSync(join(source, 'icon.ico'), join(build, 'icon.ico'));
}

function deterministicEnvironment() {
  return {
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: '0',
      TZ: 'UTC',
    },
    stdio: 'inherit',
  };
}
