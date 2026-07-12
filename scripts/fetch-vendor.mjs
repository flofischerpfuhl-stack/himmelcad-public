#!/usr/bin/env node
/**
 * HimmelCAD vendor binary fetcher.
 *
 * Downloads platform-specific vendored binaries (PotreeConverter, etc.)
 * with SHA-256 verification. Runs automatically on `pnpm install` via the
 * root `package.json` postinstall hook, but can also be invoked manually:
 *
 *     node scripts/fetch-vendor.mjs
 *     node scripts/fetch-vendor.mjs --force        # re-download even if present
 *     node scripts/fetch-vendor.mjs --component=potreeconverter
 *
 * Per AGENTS.md §1.6, binary vendor assets live in `vendor/<name>/<platform>/`
 * and are NOT committed to git (see .gitignore). The verified manifest below
 * is the single source of truth for what we ship.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { writeFile, chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');

/**
 * Vendor manifest. Each entry pins a platform-specific download URL +
 * SHA-256 + the file inside the archive that becomes our binary.
 *
 * To bump a version: update url, recompute sha256 with
 * `curl -L <url> | sha256sum`, update `executable.path` if archive layout
 * changed, then re-run this script with --force.
 */
const VENDOR_MANIFEST = {
  potreeconverter: {
    upstream: 'https://github.com/potree/PotreeConverter',
    license: 'BSD-2-Clause',
    version: '2.1.1',
    platforms: {
      'linux-x64': {
        url: 'https://github.com/potree/PotreeConverter/releases/download/2.1.1/PotreeConverter_2.1.1_x64_linux.zip',
        sha256: '6ecf70d2156be36ebeed8b6dbe457e89531e7816aaba814531527288a84294f7',
        archive: 'zip',
        // Path inside the zip → relative path inside vendor/potreeconverter/<platform>/.
        // PotreeConverter relies on liblaszip.so next to it (RPATH=$ORIGIN), so
        // we co-locate both. License files are mirrored next to the binary.
        executables: [
          { from: 'PotreeConverter', to: 'PotreeConverter', mode: 0o755 },
          { from: 'liblaszip.so', to: 'liblaszip.so', mode: 0o644 },
        ],
        copyExtras: [
          { from: 'license_potree_converter.txt', to: 'LICENSE-PotreeConverter.txt' },
          { from: 'license_laszip.txt', to: 'LICENSE-laszip.txt' },
          { from: 'license_brotli.txt', to: 'LICENSE-brotli.txt' },
          { from: 'license_json.txt', to: 'LICENSE-json.txt' },
        ],
      },
      'win32-x64': {
        url: 'https://github.com/potree/PotreeConverter/releases/download/2.1.1/PotreeConverter_2.1.1_x64_windows.zip',
        sha256: '8b4a70194fa85ceafa51e017b58e455cf3539edc9ab212b2c92b4a1f2b15e887',
        archive: 'zip',
        executables: [
          { from: 'PotreeConverter_windows_x64/PotreeConverter.exe', to: 'PotreeConverter.exe', mode: 0o755 },
          { from: 'PotreeConverter_windows_x64/laszip.dll', to: 'laszip.dll', mode: 0o644 },
        ],
        copyExtras: [
          { from: 'PotreeConverter_windows_x64/licenses/license_potree_converter.txt', to: 'LICENSE-PotreeConverter.txt' },
          { from: 'PotreeConverter_windows_x64/licenses/license_laszip.txt', to: 'LICENSE-laszip.txt' },
          { from: 'PotreeConverter_windows_x64/licenses/license_brotli.txt', to: 'LICENSE-brotli.txt' },
          { from: 'PotreeConverter_windows_x64/licenses/license_json.txt', to: 'LICENSE-json.txt' },
        ],
      },
      'darwin-x64': {
        // No upstream prebuilt binary for macOS — needs to be built from source.
        // The script currently emits a pointer to vendor/potreeconverter/darwin-x64/BUILD.md
        // with the recipe; populating this entry will switch to the binary path.
        sourceBuild: true,
      },
      'darwin-arm64': {
        sourceBuild: true,
      },
    },
  },
  brush: {
    upstream: 'https://github.com/ArthurBrussee/brush',
    license: 'Apache-2.0',
    version: '0.3.0',
    platforms: {
      'linux-x64': {
        url: 'https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-x86_64-unknown-linux-gnu.tar.xz',
        sha256: '4f0f9a8785d1951c62df26aae247c02c5bba32b00f40b06df4e1c9b867399e20',
        archive: 'tar.xz',
        executables: [{ from: 'brush_app', to: 'brush_app', mode: 0o755 }],
        copyExtras: [
          { from: 'LICENSE', to: 'LICENSE' },
          { from: 'README.md', to: 'README.md' },
          { from: 'CHANGELOG.md', to: 'CHANGELOG.md' },
        ],
      },
      'win32-x64': {
        url: 'https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-x86_64-pc-windows-msvc.zip',
        sha256: 'b68e3e9cf052d51bf3ee30776fa5a364de7f2ba13b58443128ff797bb7bcfcd6',
        archive: 'zip',
        executables: [{ from: 'brush_app.exe', to: 'brush_app.exe', mode: 0o755 }],
        copyExtras: [
          { from: 'LICENSE', to: 'LICENSE' },
          { from: 'README.md', to: 'README.md' },
          { from: 'CHANGELOG.md', to: 'CHANGELOG.md' },
        ],
      },
    },
  },
};

const VENDOR_ROOT = join(REPO_ROOT, 'vendor');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const targetPlatform = `${platform()}-${arch()}`;
const requestedComponents = args.component
  ? args.component.split(',')
  : Object.keys(VENDOR_MANIFEST);

console.log(
  `[fetch-vendor] platform=${targetPlatform}, components=${requestedComponents.join(', ')}`,
);

let hadError = false;
for (const name of requestedComponents) {
  const entry = VENDOR_MANIFEST[name];
  if (!entry) {
    console.error(`[fetch-vendor] unknown component: ${name}`);
    hadError = true;
    continue;
  }
  try {
    await processComponent(name, entry);
  } catch (err) {
    console.error(`[fetch-vendor] ${name}: ${err.message}`);
    if (process.env.HIMMELCAD_VENDOR_VERBOSE === '1') console.error(err);
    hadError = true;
  }
}

if (hadError) {
  console.error(
    '[fetch-vendor] one or more components failed; the build may not work. ' +
      'Run with HIMMELCAD_VENDOR_VERBOSE=1 for stack traces.',
  );
  // Do NOT exit non-zero here — `pnpm install` should still succeed even if
  // a vendor binary is unavailable (e.g. offline install). The downstream
  // import path will surface the missing binary at runtime with a clearer
  // error message.
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Component processing
// ---------------------------------------------------------------------------

async function processComponent(name, entry) {
  const platforms = entry.platforms ?? {};
  const platformEntry = platforms[targetPlatform];
  if (!platformEntry) {
    console.warn(`[fetch-vendor] ${name}: no entry for ${targetPlatform}; skipping`);
    return;
  }

  const outDir = join(VENDOR_ROOT, name, targetPlatform);
  mkdirSync(outDir, { recursive: true });

  if (platformEntry.sourceBuild) {
    await writeSourceBuildPointer(name, entry, platformEntry, outDir);
    return;
  }

  if (platformEntry.sha256 === '__PENDING__') {
    console.warn(
      `[fetch-vendor] ${name}/${targetPlatform}: sha256 not yet pinned; skipping. ` +
        'Edit scripts/fetch-vendor.mjs and replace __PENDING__ with the verified hash.',
    );
    return;
  }

  const allPresent = platformEntry.executables.every((e) => existsSync(join(outDir, e.to)));
  if (allPresent && !args.force) {
    console.log(`[fetch-vendor] ${name}/${targetPlatform}: already present`);
    return;
  }

  await downloadAndExtract(name, platformEntry, outDir);
  await writeMeta(name, entry, platformEntry, outDir);
  console.log(`[fetch-vendor] ${name}/${targetPlatform}: OK`);
}

async function downloadAndExtract(name, p, outDir) {
  const tmpFile = join(tmpdir(), `himmelcad-vendor-${name}-${Date.now()}.zip`);
  console.log(`[fetch-vendor] ${name}: downloading ${p.url}`);
  await downloadToFile(p.url, tmpFile);

  const actualHash = await sha256OfFile(tmpFile);
  if (actualHash !== p.sha256) {
    await rm(tmpFile, { force: true });
    throw new Error(
      `sha256 mismatch for ${p.url}: expected ${p.sha256}, got ${actualHash}. ` +
        'Either upstream re-released, or the download is tampered with.',
    );
  }
  console.log(`[fetch-vendor] ${name}: sha256 verified`);

  await extractArchive(tmpFile, outDir, p.archive, p.executables, p.copyExtras ?? []);

  await rm(tmpFile, { force: true });
}

async function writeMeta(name, entry, p, outDir) {
  const artifacts = {};
  for (const executable of p.executables) {
    artifacts[executable.to] = {
      sha256: await sha256OfFile(join(outDir, executable.to)),
    };
  }
  const meta = {
    name,
    upstream: entry.upstream,
    license: entry.license,
    version: entry.version,
    platform: targetPlatform,
    sha256: p.sha256,
    artifacts,
    fetchedAt: new Date().toISOString(),
    note:
      'This file is generated by scripts/fetch-vendor.mjs. The binary above is ' +
      'vendored under HimmelCAD per AGENTS.md §1.6. See LICENSE next to it for ' +
      'upstream copyright + license terms.',
  };
  await writeFile(join(outDir, 'VENDOR.json'), JSON.stringify(meta, null, 2) + '\n');
}

async function writeSourceBuildPointer(name, entry, p, outDir) {
  const buildMd = join(outDir, 'BUILD.md');
  if (existsSync(buildMd) && !args.force) return;
  const recipe = `# Building ${name} from source for ${targetPlatform}

Upstream does not ship a prebuilt binary for ${targetPlatform}. Until we add
a CI build for this platform, build manually:

\`\`\`bash
git clone ${entry.upstream}.git /tmp/${name}
cd /tmp/${name}
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j\$(nproc)
cp PotreeConverter "${outDir.replace(REPO_ROOT, '$HIMMELCAD_ROOT')}/PotreeConverter"
chmod +x "${outDir.replace(REPO_ROOT, '$HIMMELCAD_ROOT')}/PotreeConverter"
\`\`\`

Once the binary is in place, the importer (\`crates/himmelcad-io::las_import\`)
will pick it up automatically. Verify with:

\`\`\`bash
${outDir}/PotreeConverter --version
\`\`\`
`;
  await writeFile(buildMd, recipe);
  console.log(`[fetch-vendor] ${name}/${targetPlatform}: wrote ${buildMd}`);
}

// ---------------------------------------------------------------------------
// HTTP download with redirects
// ---------------------------------------------------------------------------

async function downloadToFile(url, outFile, redirectsLeft = 5) {
  if (redirectsLeft < 0) throw new Error('too many redirects');
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https://') ? import('node:https') : import('node:http');
    proto.then((mod) => {
      const req = mod.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadToFile(res.headers.location, outFile, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        const ws = createWriteStream(outFile);
        res.pipe(ws);
        ws.on('finish', () => ws.close(() => resolve(outFile)));
        ws.on('error', reject);
      });
      req.on('error', reject);
    }, reject);
  });
}

async function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const fs = import('node:fs');
    fs.then((mod) => {
      const rs = mod.createReadStream(path);
      rs.on('data', (chunk) => h.update(chunk));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    }, reject);
  });
}

// ---------------------------------------------------------------------------
// Zip extraction (no native deps; shells out to `unzip` if present)
// ---------------------------------------------------------------------------

async function extractArchive(archivePath, outDir, archiveType, executables, extras = []) {
  // Use the system `unzip` (present on Linux/macOS). On Windows, fall back
  // to PowerShell's Expand-Archive. This avoids adding a Node.js zip dep
  // for one operation that runs once per dev machine.
  const isWin = platform() === 'win32';
  const tmpExtract = join(tmpdir(), `himmelcad-vendor-extract-${Date.now()}`);
  mkdirSync(tmpExtract, { recursive: true });

  await new Promise((resolve, reject) => {
    if (archiveType === 'tar.xz') {
      const tar = spawn('tar', ['-xJf', archivePath, '-C', tmpExtract], { stdio: 'inherit' });
      tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
      tar.on('error', (err) => reject(new Error(`tar not found in PATH (${err.message})`)));
    } else if (archiveType !== 'zip') {
      reject(new Error(`unsupported archive type: ${archiveType}`));
    } else if (isWin) {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -LiteralPath "${archivePath}" -DestinationPath "${tmpExtract}"`,
        ],
        { stdio: 'inherit' },
      );
      ps.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`)),
      );
    } else {
      const uz = spawn('unzip', ['-q', '-o', archivePath, '-d', tmpExtract], {
        stdio: 'inherit',
      });
      uz.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`))));
      uz.on('error', (err) => reject(new Error(`unzip not found in PATH (${err.message})`)));
    }
  });

  // Move the requested executables and extras into outDir; everything else
  // is left in tmpExtract for inspection.
  const fs = await import('node:fs/promises');
  for (const exe of executables) {
    const candidate = await findFile(tmpExtract, exe.from);
    if (!candidate) {
      throw new Error(`expected ${exe.from} inside ${archivePath}, not found`);
    }
    const dest = join(outDir, exe.to);
    mkdirSync(dirname(dest), { recursive: true });
    await fs.copyFile(candidate, dest);
    await chmod(dest, exe.mode);
  }
  for (const ex of extras) {
    const candidate = await findFile(tmpExtract, ex.from);
    if (!candidate) {
      console.warn(`[fetch-vendor] extra ${ex.from} not in archive; skipping`);
      continue;
    }
    const dest = join(outDir, ex.to);
    mkdirSync(dirname(dest), { recursive: true });
    await fs.copyFile(candidate, dest);
  }
  await rm(tmpExtract, { recursive: true, force: true });
}

async function findFile(rootDir, target) {
  const fs = await import('node:fs/promises');
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name === target) {
        return full;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { force: false, component: null };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a.startsWith('--component=')) out.component = a.slice('--component='.length);
  }
  return out;
}
