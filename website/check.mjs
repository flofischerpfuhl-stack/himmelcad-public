#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(root);
const dist = join(root, 'dist');
const out = join(root, '.check-out');
let failures = 0;
const results = [];

function gate(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function walk(dir, extension = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? walk(path, extension)
      : !extension || extname(path) === extension
        ? [path]
        : [];
  });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pngSize(file) {
  const data = readFileSync(file);
  return data.toString('ascii', 1, 4) === 'PNG'
    ? [data.readUInt32BE(16), data.readUInt32BE(20)]
    : null;
}

function request(url) {
  return new Promise((resolveRequest, reject) =>
    http
      .get(url, (response) => {
        response.resume();
        response.on('end', () => resolveRequest(response.statusCode));
      })
      .on('error', reject),
  );
}

const build = spawnSync(process.execPath, [join(root, 'build.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
});
process.stdout.write(build.stdout || '');
process.stderr.write(build.stderr || '');
gate(
  build.status === 0,
  'production build',
  build.status === 0 ? 'completed' : `exit ${build.status}`,
);
if (build.status !== 0) process.exit(1);

const htmlFiles = walk(dist, '.html').sort();
gate(htmlFiles.length === 12, 'page set', `${htmlFiles.length} generated HTML pages`);

const logoHashes = {
  'himmelcad-builder-primary.svg':
    '3a919e417991335abca348488744b20e89a17a871c67b8e7c87d3d0a56d8b001',
  'himmelcad-builder-reserve-hoodie-ready.svg':
    '55db337467be8d98795dc4fbf9dffddd90e69ba0f87c0d8c62a9cc744fad4754',
  'himmelcad-photolab.svg': '32b82d92c0d188530cae0d794fcf1cb75c3defc38aa30ef2deccff6a3373b3f8',
};
for (const [name, expected] of Object.entries(logoHashes)) {
  const source = join(root, 'src/assets/logos', name);
  const built = walk(join(dist, 'assets/logos')).find(
    (file) =>
      file.startsWith(join(dist, 'assets/logos', name.replace('.svg', '.'))) &&
      file.endsWith('.svg'),
  );
  gate(
    existsSync(source) && sha256(source) === expected && built && sha256(built) === expected,
    `owner logo unchanged: ${name}`,
  );
}

const htmlValidate = spawnSync('npx', ['-y', 'html-validate@9', ...htmlFiles], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (htmlValidate.status !== 0)
  process.stdout.write(`${htmlValidate.stdout || ''}${htmlValidate.stderr || ''}`);
gate(htmlValidate.status === 0, 'HTML validity', `${htmlFiles.length} pages`);

const banned = [
  'seamless',
  'powerful',
  'cutting-edge',
  'next-generation',
  'revolutionary',
  'game-changing',
  'blazing fast',
  'effortless',
  'robust',
  'intuitive',
  'world-class',
  'unlock',
  'supercharge',
  'empower',
  'elevate',
  'take x to the next level',
  'all-in-one',
  'built for professionals',
  'trusted by',
  'most popular',
];
const bannedHits = [];
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8').toLowerCase();
  for (const phrase of banned)
    if (html.includes(phrase)) bannedHits.push(`${relative(dist, file)}: ${phrase}`);
}
gate(bannedHits.length === 0, 'banned marketing phrases', bannedHits.join(', '));

const cssFile = walk(join(dist, 'assets'), '.css')[0];
gate(
  Boolean(cssFile) && !/gradient\s*\(/i.test(readFileSync(cssFile, 'utf8')),
  'visual policy: no CSS gradients',
);

const titles = new Set();
const descriptions = new Set();
let metadataOk = true;
const linkErrors = [];
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  const description = html.match(/<meta name="description" content="([^"]+)" \/>/)?.[1];
  if (!title || !description || titles.has(title) || descriptions.has(description))
    metadataOk = false;
  titles.add(title);
  descriptions.add(description);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(?:mailto:|https?:|data:|#)/.test(value)) continue;
    const [pathname, fragment] = value.split('#');
    let target;
    if (pathname.startsWith('/')) {
      if (pathname === '/') target = join(dist, 'index.html');
      else if (pathname.endsWith('/')) target = join(dist, pathname.slice(1), 'index.html');
      else target = join(dist, pathname.slice(1));
    } else target = resolve(dirname(file), pathname || basename(file));
    if (!existsSync(target)) linkErrors.push(`${relative(dist, file)} → ${value}`);
    else if (
      fragment &&
      target.endsWith('.html') &&
      !readFileSync(target, 'utf8').includes(`id="${fragment}"`)
    )
      linkErrors.push(`${relative(dist, file)} → missing #${fragment}`);
  }
}
gate(metadataOk, 'unique page titles and descriptions');
gate(
  linkErrors.length === 0,
  'internal links and assets resolve',
  linkErrors.slice(0, 8).join(', '),
);

const assetNames = walk(join(dist, 'assets')).map((file) => relative(join(dist, 'assets'), file));
gate(
  assetNames.every((name) => /\.[a-f0-9]{12}\.[^.]+$/.test(name)),
  'asset fingerprinting',
  `${assetNames.length} immutable assets`,
);

const sharedWeight = statSync(cssFile).size + statSync(walk(join(dist, 'assets'), '.js')[0]).size;
const pageWeights = htmlFiles.map((file) => statSync(file).size + sharedWeight);
gate(
  pageWeights.every((weight) => weight < 150 * 1024),
  'page-weight budget',
  `largest ${(Math.max(...pageWeights) / 1024).toFixed(1)} KB excluding fonts, hero and media`,
);

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
let manifestOk =
  manifest.name === 'Himmel:CAD' &&
  manifest.start_url === '/' &&
  manifest.scope === '/' &&
  manifest.lang === 'en';
for (const icon of manifest.icons) {
  const file = join(dist, icon.src.slice(1));
  if (!existsSync(file)) manifestOk = false;
  if (icon.type === 'image/png') {
    const expected = icon.sizes.split('x').map(Number);
    if (String(pngSize(file)) !== String(expected)) manifestOk = false;
  }
}
gate(manifestOk, 'PWA manifest and icon dimensions');

const og = walk(join(dist, 'assets/images'), '.png').find(
  (file) => pngSize(file)?.join('x') === '1200x630',
);
gate(Boolean(og), 'Open Graph image', '1200×630');

const headers = readFileSync(join(dist, '_headers'), 'utf8');
const requiredHeaders = [
  'Content-Security-Policy:',
  "default-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  'X-Content-Type-Options: nosniff',
  'Referrer-Policy: strict-origin-when-cross-origin',
  'Permissions-Policy:',
  'X-Frame-Options: DENY',
  'Cross-Origin-Opener-Policy: same-origin',
  'max-age=31536000, immutable',
];
gate(
  requiredHeaders.every((value) => headers.includes(value)),
  'security and cache headers',
);

const releases = JSON.parse(readFileSync(join(root, 'content/releases.json'), 'utf8'));
gate(
  Object.values(releases).every((list) => Array.isArray(list) && list.length === 0),
  'release manifest starts empty',
);
const downloadHtml = readFileSync(join(dist, 'download/index.html'), 'utf8');
gate(
  (downloadHtml.match(/No public build yet/g) || []).length >= 5 && !/disabled/i.test(downloadHtml),
  'honest empty download state',
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const port = 41873;
const server = spawn(process.execPath, [join(root, 'serve.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await request(`http://127.0.0.1:${port}/`)) === 200) break;
    } catch {
      // The preview server is still starting; retry.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const playwrightCandidates = [
    join(repoRoot, 'node_modules/playwright/index.mjs'),
    '/home/oem/Dokumente/003_Projekte/17_fernwork/node_modules/playwright/index.mjs',
  ];
  const playwrightPath = playwrightCandidates.find(existsSync);
  if (!playwrightPath) throw new Error('Playwright module not found');
  const { chromium } = await import(pathToFileURL(playwrightPath));
  const axeCandidates = [
    join(repoRoot, 'node_modules/axe-core/axe.min.js'),
    '/home/oem/Dokumente/003_Projekte/10_himmelcad/node_modules/axe-core/axe.min.js',
  ];
  const axePath = axeCandidates.find(existsSync);
  if (!axePath) throw new Error('axe-core not found');
  const axeSource = readFileSync(axePath, 'utf8');
  const browser = await chromium.launch({ headless: true });
  const routes = [
    '/',
    '/photolab/',
    '/builder/',
    '/cap-weltview/',
    '/roadmap/',
    '/pricing/',
    '/licence/',
    '/download/',
    '/legal/',
    '/privacy/',
    '/offline/',
    '/404.html',
  ];
  const external = new Set();
  const cspViolations = [];
  const axeViolations = [];
  const overflow = [];
  const typographyErrors = new Set();
  const publicJargon = new Set();
  const context = await browser.newContext({ bypassCSP: true });
  context.on('request', (req) => {
    const url = new URL(req.url());
    if (url.origin !== `http://127.0.0.1:${port}`) external.add(req.url());
  });
  const page = await context.newPage();
  for (const route of routes) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle' });
    const visibleText = await page.locator('body').innerText();
    for (const term of [
      'release manifest',
      'file controls',
      'gates',
      'rows',
      'slices',
      'hand-off',
      'reconciliation',
    ]) {
      if (new RegExp(`\\b${term.replace('-', '\\-')}\\b`, 'i').test(visibleText))
        publicJargon.add(`${route}: ${term}`);
    }
    await page.addScriptTag({ content: axeSource });
    const axe = await page.evaluate(() =>
      window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      }),
    );
    if (axe.violations.length)
      axeViolations.push(`${route}: ${axe.violations.map((item) => item.id).join(', ')}`);
    const slug =
      route === '/'
        ? 'home'
        : route
            .replace(/^\//, '')
            .replace(/\/$/, '')
            .replace(/\.html$/, '') || 'page';
    await page.screenshot({ path: join(out, `${slug}-1440.png`), fullPage: true });
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const sizes = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      if (sizes.scroll > sizes.client)
        overflow.push(`${route}@${width}: ${sizes.scroll}>${sizes.client}`);
      const typeIssues = await page.evaluate(() => {
        const issues = [];
        const displayElements = [...document.querySelectorAll('body *')].filter((element) =>
          getComputedStyle(element).fontFamily.includes('HC Display'),
        );
        for (const element of displayElements) {
          const label = `${element.tagName.toLowerCase()}.${element.className || 'plain'} "${element.textContent.trim()}"`;
          const text = element.textContent.trim();
          if (text.length > 24 || text.split(/\s+/).length > 4)
            issues.push(`display title too long: ${label}`);
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            for (const match of node.data.matchAll(/\S+/g)) {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              const lines = new Set(
                [...range.getClientRects()]
                  .filter((rect) => rect.width > 0)
                  .map((rect) => Math.round(rect.top * 10) / 10),
              );
              if (lines.size > 1) issues.push(`split display word "${match[0]}": ${label}`);
            }
          }
        }
        for (const heading of document.querySelectorAll('h1, h2, h3')) {
          if (heading.scrollWidth > heading.clientWidth + 1)
            issues.push(`heading overflow: ${heading.textContent.trim()}`);
        }
        for (const value of document.querySelectorAll('.price, .number-grid dd')) {
          if (getComputedStyle(value).fontFamily.includes('HC Display'))
            issues.push(`number uses display font: ${value.textContent.trim()}`);
        }
        return issues;
      });
      for (const issue of typeIssues) typographyErrors.add(`${route}@${width}: ${issue}`);
      if (width === 360)
        await page.screenshot({ path: join(out, `${slug}-360.png`), fullPage: true });
    }
  }
  gate(axeViolations.length === 0, 'axe-core WCAG 2.2 AA', axeViolations.join('; '));
  gate(overflow.length === 0, 'no horizontal overflow at 360/768/1440', overflow.join('; '));
  gate(
    typographyErrors.size === 0,
    'display titles and headings fit without split words',
    [...typographyErrors].join('; '),
  );
  gate(
    publicJargon.size === 0,
    'public copy avoids implementation jargon',
    [...publicJargon].join('; '),
  );
  gate(external.size === 0, 'no third-party requests', [...external].join(', '));
  gate(
    walk(out, '.png').length === routes.length * 2,
    'responsive screenshots',
    `${walk(out, '.png').length} files`,
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => document.activeElement?.className);
  const focusStyle = await page.evaluate(
    () => getComputedStyle(document.activeElement).outlineStyle,
  );
  gate(
    firstFocus === 'skip-link' && focusStyle !== 'none',
    'keyboard path and visible focus',
    `first focus: ${firstFocus}`,
  );

  const reduced = await browser.newContext({ reducedMotion: 'reduce', bypassCSP: true });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`http://127.0.0.1:${port}/`);
  const duration = await reducedPage
    .locator('.button')
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  gate(
    duration.split(',').every((part) => Number.parseFloat(part) === 0),
    'reduced motion disables transitions',
    duration,
  );
  await reduced.close();

  const strict = await browser.newContext({ serviceWorkers: 'allow' });
  const strictPage = await strict.newPage();
  strictPage.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy'))
      cspViolations.push(message.text());
  });
  await strictPage.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`Content Security Policy violation: ${event.violatedDirective}`),
    ),
  );
  await strictPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await strictPage.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('service worker install timeout')), 10000),
      ),
    ]),
  );
  gate(cspViolations.length === 0, 'CSP has no violations', cspViolations.join('; '));
  await strict.setOffline(true);
  let offlineOk = true;
  for (const route of ['/', '/builder/']) {
    try {
      await strictPage.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded' });
      offlineOk &&= await strictPage.locator('main').isVisible();
    } catch {
      offlineOk = false;
    }
  }
  gate(offlineOk, 'service worker offline reload', 'home and Builder');
  await strict.close();
  await context.close();
  await browser.close();
} catch (error) {
  gate(false, 'browser quality suite', error.stack || error.message);
} finally {
  server.kill('SIGTERM');
}

console.log(`\n${results.filter((item) => item.ok).length}/${results.length} gates passed.`);
process.exit(failures ? 1 : 0);
