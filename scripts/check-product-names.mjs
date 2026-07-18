/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- package manifests are untyped JSON at this audit boundary. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import process, { stderr, stdout } from 'node:process';

const root = resolve(import.meta.dirname, '..');
const failures = [];

const applications = [
  {
    directory: 'builder',
    packageName: '@himmelcad/builder',
    productName: 'HimmelCAD Builder',
    productLabel: 'Builder',
    desktop: true,
    appId: 'de.himmelcad.builder',
    executableName: 'himmelcad-builder',
    artifactPrefix: 'HimmelCAD-Builder-',
  },
  {
    directory: 'photolab',
    packageName: '@himmelcad/photolab',
    productName: 'HimmelCAD PhotoLab',
    productLabel: 'PhotoLab',
    desktop: true,
    appId: 'de.himmelcad.photolab',
    executableName: 'himmelcad-photolab',
    artifactPrefix: 'HimmelCAD-PhotoLab-',
  },
  {
    directory: 'weltview',
    packageName: '@himmelcad/weltview',
    productName: 'HimmelCAD WeltView',
    productLabel: 'WeltView',
    desktop: false,
  },
];

for (const application of applications) {
  const applicationRoot = join(root, 'apps', application.directory);
  const packagePath = join(applicationRoot, 'package.json');
  if (!existsSync(packagePath)) {
    failures.push(`missing application package: apps/${application.directory}/package.json`);
    continue;
  }

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.name !== application.packageName) {
    failures.push(
      `${application.directory} package name is ${JSON.stringify(packageJson.name)}; expected ${application.packageName}`,
    );
  }
  if (!String(packageJson.description ?? '').startsWith(`${application.productName} —`)) {
    failures.push(
      `${application.directory} description must start with ${JSON.stringify(`${application.productName} —`)}`,
    );
  }

  const htmlPath = join(
    applicationRoot,
    application.desktop ? 'renderer/index.html' : 'index.html',
  );
  const html = readFileSync(htmlPath, 'utf8');
  if (!html.includes(`<title>${application.productName}</title>`)) {
    failures.push(`${application.directory} HTML title is not ${application.productName}`);
  }

  const appSourcePath = join(
    applicationRoot,
    application.desktop ? 'renderer/src/App.tsx' : 'src/App.tsx',
  );
  const appSource = readFileSync(appSourcePath, 'utf8');
  if (
    !appSource.includes('appName="HimmelCAD"') ||
    !appSource.includes(`productLabel="${application.productLabel}"`)
  ) {
    failures.push(
      `${application.directory} title bar does not compose ${application.productName} from the canonical labels`,
    );
  }

  if (application.desktop) {
    if (packageJson.desktopName !== application.productName) {
      failures.push(`${application.directory} desktopName is not ${application.productName}`);
    }
    for (const platform of ['linux', 'win']) {
      const builderPath = join(applicationRoot, `electron-builder.${platform}.yml`);
      const builderConfig = readFileSync(builderPath, 'utf8');
      if (!builderConfig.includes(`productName: ${application.productName}\n`)) {
        failures.push(
          `${application.directory} ${platform} productName is not ${application.productName}`,
        );
      }
      if (!builderConfig.includes(`appId: ${application.appId}\n`)) {
        failures.push(`${application.directory} ${platform} appId is not ${application.appId}`);
      }
      if (!builderConfig.includes(`executableName: ${application.executableName}\n`)) {
        failures.push(
          `${application.directory} ${platform} executableName is not ${application.executableName}`,
        );
      }
      if (!builderConfig.includes(application.artifactPrefix)) {
        failures.push(
          `${application.directory} ${platform} artifact names do not use ${application.artifactPrefix}`,
        );
      }
    }

    const electronMain = readFileSync(join(applicationRoot, 'electron/main.ts'), 'utf8');
    if (!electronMain.includes(`app.setName('${application.productName}')`)) {
      failures.push(`${application.directory} Electron app name is not ${application.productName}`);
    }
    if (!electronMain.includes(`title: '${application.productName}'`)) {
      failures.push(
        `${application.directory} Electron window title is not ${application.productName}`,
      );
    }
  }
}

for (const retiredDirectory of ['omnishape', 'mechatron', 'polyshape']) {
  if (existsSync(join(root, 'apps', retiredDirectory))) {
    failures.push(`retired application directory still exists: apps/${retiredDirectory}`);
  }
}

const currentDocumentation = [
  'AGENTS.md',
  'README.md',
  'docs/PRODUCT-VISION.md',
  'docs/ROADMAP.md',
  'docs/ARCHITECTURE.md',
  'docs/DATA-MODEL.md',
  'docs/PROJECT-FORMAT.md',
];
const retiredProductPattern = /\b(?:Omnishape|Mechatron)\b/i;
for (const relativePath of currentDocumentation) {
  const contents = readFileSync(join(root, relativePath), 'utf8');
  if (retiredProductPattern.test(contents)) {
    failures.push(`retired product name found in current documentation: ${relativePath}`);
  }
}

const canonicalProductNames = [
  'HimmelCAD Builder',
  'HimmelCAD Assembler',
  'HimmelCAD PhotoLab',
  'HimmelCAD WeltView',
  'HimmelCAD TestFlight',
  'HimmelCAD ChronoGit',
];
for (const relativePath of ['README.md', 'docs/PRODUCT-VISION.md']) {
  const contents = readFileSync(join(root, relativePath), 'utf8');
  for (const productName of canonicalProductNames) {
    if (!contents.includes(productName)) {
      failures.push(`canonical product name missing from ${relativePath}: ${productName}`);
    }
  }
}

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const [scriptName, command] of [
  ['dev:builder', 'pnpm --filter @himmelcad/builder dev'],
  ['dev:photolab', 'pnpm --filter @himmelcad/photolab dev'],
  ['dev:weltview', 'pnpm --filter @himmelcad/weltview dev'],
  ['product-names:check', 'node scripts/check-product-names.mjs'],
]) {
  if (rootPackage.scripts?.[scriptName] !== command) {
    failures.push(`root package script ${scriptName} is not ${JSON.stringify(command)}`);
  }
}

const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
for (const directory of applications.map((application) => application.directory)) {
  if (!lockfile.includes(`  apps/${directory}:\n`)) {
    failures.push(`pnpm lockfile is missing the apps/${directory} importer`);
  }
}
if (/ {2}apps\/(?:omnishape|mechatron|polyshape):\n/i.test(lockfile)) {
  failures.push('pnpm lockfile still contains a retired application importer');
}

const textExtensions = new Set([
  '.cjs',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const ignoredDirectories = new Set([
  '.build',
  '.git',
  'build',
  'dist',
  'libs',
  'node_modules',
  'release',
  'target',
  'vendor',
]);
const currentSurfaceRoots = ['apps', 'branding', 'crates', 'docs', 'packages', 'scripts'];
const additionalCurrentFiles = [
  '.gitlab-ci.yml',
  'AGENTS.md',
  'Cargo.toml',
  'LICENSES/THIRD_PARTY.md',
  'README.md',
  'package.json',
  'photolab/PHOTOLAB-CONCEPT.md',
  'photolab/implementation-plan.html',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];
const retiredName = /\b(?:Omnishape|Mechatron|Polyshape)\b/i;
const retiredApplicationPath = /(?:^|[/"'`])apps\/(?:omnishape|mechatron|polyshape)(?:[/"'`]|$)/i;
const canonicalByLowerCase = new Map(
  canonicalProductNames.map((productName) => [productName.toLowerCase(), productName]),
);
const brandedProduct =
  /himmelcad\s+(?:builder|assembler|photolab|weltview|testflight|chronogit)\b/gi;
// "compose" / "Composer" were the old reserved-product name; canonical is Assembler.
const retiredBrandedAlias = /himmelcad\s+(?:build|compose|composer)\b/gi;

for (const filePath of [
  ...currentSurfaceRoots.flatMap((surfaceRoot) => collectTextFiles(join(root, surfaceRoot))),
  ...additionalCurrentFiles.map((relativePath) => join(root, relativePath)),
]) {
  const relativePath = relative(root, filePath);
  if (
    relativePath === 'scripts/check-product-names.mjs' ||
    relativePath.startsWith('branding/logos/source/')
  ) {
    continue;
  }
  const contents = readFileSync(filePath, 'utf8');
  if (retiredName.test(contents)) {
    failures.push(`retired product name found in current repository surface: ${relativePath}`);
  }
  if (retiredApplicationPath.test(contents)) {
    failures.push(`retired application path found in current repository surface: ${relativePath}`);
  }
  for (const match of contents.matchAll(brandedProduct)) {
    const expected = canonicalByLowerCase.get(match[0].toLowerCase());
    if (match[0] !== expected) {
      failures.push(
        `non-canonical product capitalization ${JSON.stringify(match[0])} in ${relativePath}`,
      );
    }
  }
  for (const match of contents.matchAll(retiredBrandedAlias)) {
    failures.push(`retired branded alias ${JSON.stringify(match[0])} in ${relativePath}`);
  }
}

/** @param {string} directory @returns {string[]} */
function collectTextFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...collectTextFiles(join(directory, entry.name)));
    } else if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

if (failures.length > 0) {
  stderr.write(
    `Product-name check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  stdout.write('Product-name and application-path check passed.\n');
}
