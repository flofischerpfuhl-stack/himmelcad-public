#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { get } from 'node:https';

const root = resolve(import.meta.dirname, '..');
const destination = join(root, 'vendor', 'msvc-runtime', 'win32-x64');
const url =
  'https://download.visualstudio.microsoft.com/download/pr/7ebf5fdb-36dc-4145-b0a0-90d3d5990a61/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe';
const archiveSha256 = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b';
const licenseSha256 = '8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b';
const version = '14.44.35211.0';
const files = [
  [
    'msvcp140.dll_amd64',
    'msvcp140.dll',
    '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9',
  ],
  [
    'msvcp140_1.dll_amd64',
    'msvcp140_1.dll',
    'bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d',
  ],
  [
    'vcruntime140.dll_amd64',
    'vcruntime140.dll',
    'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066',
  ],
  [
    'vcruntime140_1.dll_amd64',
    'vcruntime140_1.dll',
    '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f',
  ],
];

if (
  existsSync(join(destination, 'LICENSE.rtf')) &&
  sha256(join(destination, 'LICENSE.rtf')) === licenseSha256 &&
  existsSync(join(destination, 'VENDOR.json')) &&
  files.every(
    ([, name, hash]) =>
      existsSync(join(destination, name)) && sha256(join(destination, name)) === hash,
  )
) {
  process.stdout.write(`Microsoft VC runtime ${version} already materialized\n`);
  process.exit(0);
}

const temporary = await mkdtemp(join(tmpdir(), 'himmelcad-msvc-runtime-'));
try {
  const archive = join(temporary, 'vc_redist.x64.exe');
  await download(url, archive);
  const observedArchiveHash = sha256(archive);
  if (observedArchiveHash !== archiveSha256) {
    throw new Error(
      `VC runtime archive hash mismatch: expected ${archiveSha256}, got ${observedArchiveHash}`,
    );
  }

  const bytes = readFileSync(archive);
  const cabinetSignature = Buffer.from('MSCF', 'ascii');
  const bootstrapCabinet = bytes.indexOf(cabinetSignature);
  const attachedCabinet = bytes.indexOf(
    cabinetSignature,
    bootstrapCabinet + cabinetSignature.length,
  );
  if (bootstrapCabinet < 0 || attachedCabinet < 0) {
    throw new Error('The pinned Microsoft Burn bundle does not contain its attached cabinet');
  }
  const attached = join(temporary, 'attached.cab');
  writeFileSync(attached, bytes.subarray(attachedCabinet));
  extractCabinet(attached, 'a12', temporary);
  const payload = join(temporary, 'payload');
  mkdirSync(payload);
  extractCabinet(join(temporary, 'a12'), '*', payload);
  const bootstrap = join(temporary, 'bootstrap.cab');
  writeFileSync(bootstrap, bytes.subarray(bootstrapCabinet, attachedCabinet));
  extractCabinet(bootstrap, 'u4', temporary);
  if (sha256(join(temporary, 'u4')) !== licenseSha256) {
    throw new Error('Unexpected Microsoft redistributable license hash');
  }

  mkdirSync(destination, { recursive: true });
  for (const [sourceName, destinationName, expectedHash] of files) {
    const source = join(payload, sourceName);
    if (sha256(source) !== expectedHash)
      throw new Error(`Unexpected payload hash for ${sourceName}`);
    await copyFile(source, join(destination, destinationName));
  }
  await copyFile(join(temporary, 'u4'), join(destination, 'LICENSE.rtf'));
  writeFileSync(
    join(destination, 'VENDOR.json'),
    `${JSON.stringify(
      {
        name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
        version,
        source: url,
        archiveSha256,
        licenseSha256,
        license: 'Microsoft Software License Terms (Visual Studio redistributables)',
        artifacts: Object.fromEntries(files.map(([, name, hash]) => [name, { sha256: hash }])),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Microsoft VC runtime ${version} materialized at ${destination}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function extractCabinet(cabinet, pattern, output) {
  if (process.platform === 'win32') {
    execFileSync('expand.exe', [cabinet, `-F:${pattern}`, output], { stdio: 'ignore' });
  } else {
    execFileSync('7z', ['x', '-y', cabinet, pattern, `-o${output}`], { stdio: 'ignore' });
  }
}

function download(source, output, redirects = 5) {
  if (redirects < 0)
    return Promise.reject(new Error('Too many redirects while fetching VC runtime'));
  return new Promise((resolveDownload, rejectDownload) => {
    const request = get(source, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        download(response.headers.location, output, redirects - 1).then(
          resolveDownload,
          rejectDownload,
        );
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`HTTP ${response.statusCode ?? 'unknown'} fetching ${source}`));
        return;
      }
      const file = createWriteStream(output);
      response.pipe(file);
      file.on('finish', () => file.close(resolveDownload));
      file.on('error', rejectDownload);
    });
    request.on('error', rejectDownload);
  });
}
