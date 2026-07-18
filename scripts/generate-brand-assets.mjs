#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const sourceRoot = join(workspace, 'branding/logos/source');
const generatedRoot = join(workspace, 'branding/logos/generated');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const variants = [
  {
    id: 'photolab',
    source: 'himmelcad-photolab.svg',
    sourceSha256: 'd85081f0030c65284bf077a5d290f584a819c7dedf183e51e7f8b7c0d4163f10',
    app: 'photolab',
  },
  {
    id: 'builder-primary',
    source: 'himmelcad-builder-primary.svg',
    sourceSha256: '3a919e417991335abca348488744b20e89a17a871c67b8e7c87d3d0a56d8b001',
    app: 'builder',
  },
  {
    id: 'builder-reserve-hoodie-ready',
    source: 'himmelcad-builder-reserve-hoodie-ready.svg',
    sourceSha256: '55db337467be8d98795dc4fbf9dffddd90e69ba0f87c0d8c62a9cc744fad4754',
  },
];

const checkOnly = process.argv.includes('--check');
const targetRoot = checkOnly ? mkdtempSync(join(tmpdir(), 'himmelcad-branding-')) : generatedRoot;

try {
  for (const variant of variants) {
    verifyMaster(variant);
    generateVariant(variant, targetRoot);
  }
  if (checkOnly) {
    compareGeneratedTrees(targetRoot, generatedRoot);
    verifyPublishedAppIcons();
  } else for (const variant of variants) if (variant.app) publishAppIcons(variant.app, variant.id);
} finally {
  if (checkOnly) rmSync(targetRoot, { force: true, recursive: true });
}

function verifyMaster(variant) {
  const source = join(sourceRoot, variant.source);
  if (!existsSync(source)) throw new Error(`Missing original SVG: ${source}`);
  const actual = sha256(readFileSync(source));
  if (actual !== variant.sourceSha256) {
    throw new Error(`Original SVG changed: ${variant.source} (${actual})`);
  }
}

function generateVariant(variant, root) {
  const source = join(sourceRoot, variant.source);
  const output = join(root, variant.id);
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });

  const renderedMaster = join(output, '.master.png');
  const centeredMark = join(output, '.mark.png');
  const cardMaster = join(output, '.card.png');
  execFileSync(
    'inkscape',
    [
      source,
      '--export-type=png',
      `--export-filename=${renderedMaster}`,
      '--export-width=1024',
      '--export-height=1024',
      '--export-background-opacity=0',
    ],
    deterministicEnvironment(),
  );
  execFileSync(
    'convert',
    [
      renderedMaster,
      '-trim',
      '+repage',
      '-resize',
      '790x790>',
      '-depth',
      '8',
      '-strip',
      '-define',
      'png:exclude-chunks=date,time',
      centeredMark,
    ],
    deterministicEnvironment(),
  );
  execFileSync(
    'convert',
    [
      '-size',
      '1024x1024',
      'xc:none',
      '-fill',
      '#000000',
      '-draw',
      'roundrectangle 0,0,1023,1023,192,192',
      centeredMark,
      '-gravity',
      'center',
      '-compose',
      'over',
      '-composite',
      '-depth',
      '8',
      '-strip',
      '-define',
      'png:exclude-chunks=date,time',
      cardMaster,
    ],
    deterministicEnvironment(),
  );

  const pngs = [];
  for (const size of sizes) {
    const destination = join(output, `icon-${size}.png`);
    execFileSync(
      'convert',
      [
        cardMaster,
        '-filter',
        'Lanczos',
        '-resize',
        `${size}x${size}!`,
        '-depth',
        '8',
        '-strip',
        '-define',
        'png:exclude-chunks=date,time',
        destination,
      ],
      deterministicEnvironment(),
    );
    pngs.push(destination);
  }

  const titlebarMark = join(output, 'mark-512.png');
  execFileSync(
    'convert',
    [
      renderedMaster,
      '-filter',
      'Lanczos',
      '-resize',
      '512x512!',
      '-depth',
      '8',
      '-strip',
      '-define',
      'png:exclude-chunks=date,time',
      titlebarMark,
    ],
    deterministicEnvironment(),
  );

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
  rmSync(renderedMaster, { force: true });
  rmSync(centeredMark, { force: true });
  rmSync(cardMaster, { force: true });
  verifyDerivedIcon(output);
}

function verifyDerivedIcon(output) {
  const description = execFileSync(
    'identify',
    ['-format', '%w %h %[pixel:p{0,0}] %[pixel:p{512,0}]', join(output, 'icon-1024.png')],
    deterministicEnvironment({ capture: true }),
  )
    .toString('utf8')
    .trim();
  if (!description.startsWith('1024 1024 srgba(0,0,0,0) srgba(0,0,0,1)')) {
    throw new Error(`Derived icon is not an opaque black rounded card: ${description}`);
  }
}

function compareGeneratedTrees(actualRoot, expectedRoot) {
  for (const variant of variants) {
    for (const filename of [
      ...sizes.map((size) => `icon-${size}.png`),
      'icon.ico',
      'mark-512.png',
    ]) {
      const actual = join(actualRoot, variant.id, filename);
      const expected = join(expectedRoot, variant.id, filename);
      if (
        !existsSync(expected) ||
        sha256(readFileSync(actual)) !== sha256(readFileSync(expected))
      ) {
        throw new Error(`Generated branding asset is stale: ${variant.id}/${filename}`);
      }
    }
  }
  console.info('Generated branding assets are deterministic and current.');
}

function verifyPublishedAppIcons() {
  for (const variant of variants) {
    if (!variant.app) continue;
    const generated = join(generatedRoot, variant.id);
    const build = join(workspace, 'apps', variant.app, 'build');
    for (const [generatedName, publishedName] of [
      ['icon-512.png', 'icon.png'],
      ['icon.ico', 'icon.ico'],
      ['mark-512.png', 'mark.png'],
    ]) {
      const source = join(generated, generatedName);
      const published = join(build, publishedName);
      if (
        !existsSync(published) ||
        sha256(readFileSync(source)) !== sha256(readFileSync(published))
      ) {
        throw new Error(`Published app branding asset is stale: ${variant.app}/${publishedName}`);
      }
    }
  }
  console.info('Published desktop branding assets are current.');
}

function publishAppIcons(app, variantId) {
  const appRoot = join(workspace, 'apps', app);
  if (!existsSync(appRoot)) return;
  const source = join(generatedRoot, variantId);
  const build = join(appRoot, 'build');
  mkdirSync(build, { recursive: true });
  copyFileSync(join(source, 'icon-512.png'), join(build, 'icon.png'));
  copyFileSync(join(source, 'icon.ico'), join(build, 'icon.ico'));
  copyFileSync(join(source, 'mark-512.png'), join(build, 'mark.png'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deterministicEnvironment(options = {}) {
  return {
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: '0',
      TZ: 'UTC',
    },
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  };
}
