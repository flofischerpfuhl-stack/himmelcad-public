#!/usr/bin/env node
/** Himmel:CAD static-site quality gates. */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import http from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const websiteRoot = resolve(import.meta.dirname);
const repoRoot = resolve(websiteRoot, '..');
const failures = [];
const notes = [];

const log = (ok, label, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
  process.stdout.write(`${line}\n`);
  if (!ok) failures.push(line);
};

const required = [
  'index.html',
  'impressum.html',
  'datenschutz.html',
  'README.md',
  'wrangler.jsonc',
  '.htmlvalidate.json',
  'assets/css/site.css',
  'assets/css/fonts.css',
  'assets/js/site.js',
  'assets/fonts/Kamikaze.ttf',
  'assets/fonts/Kamikaze3DGradient.ttf',
  'assets/logos/himmelcad-builder-primary.svg',
  'assets/logos/himmelcad-builder-reserve-hoodie-ready.svg',
  'assets/logos/himmelcad-photolab.svg',
];

const masterHashes = {
  'himmelcad-builder-primary.svg':
    '3a919e417991335abca348488744b20e89a17a871c67b8e7c87d3d0a56d8b001',
  'himmelcad-builder-reserve-hoodie-ready.svg':
    '55db337467be8d98795dc4fbf9dffddd90e69ba0f87c0d8c62a9cc744fad4754',
  'himmelcad-photolab.svg': 'd85081f0030c65284bf077a5d290f584a819c7dedf183e51e7f8b7c0d4163f10',
};

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.check-out' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

for (const rel of required) log(existsSync(join(websiteRoot, rel)), `exists ${rel}`);

for (const [name, expected] of Object.entries(masterHashes)) {
  const file = join(websiteRoot, 'assets/logos', name);
  if (!existsSync(file)) continue;
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  log(actual === expected, `logo hash ${name}`, actual === expected ? 'matches master' : actual);
}

const heroImage = join(websiteRoot, 'assets/img/sky-hero.jpg');
const readme = readFileSync(join(websiteRoot, 'README.md'), 'utf8');
if (existsSync(heroImage)) {
  log(statSync(heroImage).size > 0, 'hero image present', 'assets/img/sky-hero.jpg');
} else {
  log(readme.includes('sky-hero.jpg fehlt'), 'missing hero fallback documented');
  notes.push('sky-hero.jpg is absent; the intentional flat #0B2545 fallback is active.');
}

let bytesExcludingFontsAndHero = 0;
let fontBytes = 0;
for (const file of walk(websiteRoot)) {
  const rel = relative(websiteRoot, file);
  const ext = extname(file).toLowerCase();
  if (rel === 'check.mjs' || rel.endsWith('.md') || rel === 'wrangler.jsonc') continue;
  if (rel === '_headers' || rel === '.gitignore' || rel === '.htmlvalidate.json') continue;
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) fontBytes += statSync(file).size;
  else if (file === heroImage) continue;
  else if (['.html', '.css', '.js', '.svg'].includes(ext)) {
    bytesExcludingFontsAndHero += statSync(file).size;
  }
}
const weightLimit = 300 * 1024;
log(
  bytesExcludingFontsAndHero < weightLimit,
  'page weight excluding fonts and hero',
  `${bytesExcludingFontsAndHero} bytes (limit ${weightLimit}); fonts ${fontBytes} bytes`,
);

const htmlFiles = walk(websiteRoot).filter((file) => extname(file) === '.html');
const htmlByFile = new Map(htmlFiles.map((file) => [file, readFileSync(file, 'utf8')]));
const idsByFile = new Map(
  [...htmlByFile].map(([file, html]) => [
    file,
    new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1])),
  ]),
);
const hrefRe = /\b(?:href|src)=["']([^"']+)["']/gi;
for (const [file, html] of htmlByFile) {
  for (const match of html.matchAll(hrefRe)) {
    const href = match[1];
    if (/^(?:mailto:|data:)/i.test(href)) continue;
    if (/^[a-z]+:/i.test(href)) {
      log(false, `external request ${relative(websiteRoot, file)}`, href);
      continue;
    }
    const [pathPart, fragment = ''] = href.split('#');
    const target = pathPart ? resolve(file, '..', pathPart) : file;
    if (!existsSync(target)) {
      log(false, `broken link ${relative(websiteRoot, file)}`, href);
    } else if (fragment && !idsByFile.get(target)?.has(fragment)) {
      log(false, `broken fragment ${relative(websiteRoot, file)}`, href);
    }
  }
}

const cssFiles = walk(websiteRoot).filter((file) => extname(file) === '.css');
for (const file of cssFiles) {
  const css = readFileSync(file, 'utf8');
  for (const match of css.matchAll(/url\((['"]?)([^"')]+)\1\)/gi)) {
    const url = match[2];
    if (/^(?:data:|#)/i.test(url)) continue;
    const target = resolve(file, '..', url);
    const expectedMissingHero = target === heroImage && !existsSync(heroImage);
    if (!existsSync(target) && !expectedMissingHero) {
      log(false, `broken CSS URL ${relative(websiteRoot, file)}`, url);
    }
  }
}
log(
  !failures.some((item) => /broken|external request/i.test(item)),
  'all active links resolve',
);

const indexHtml = readFileSync(join(websiteRoot, 'index.html'), 'utf8');
const impressumHtml = readFileSync(join(websiteRoot, 'impressum.html'), 'utf8');
const datenschutzHtml = readFileSync(join(websiteRoot, 'datenschutz.html'), 'utf8');
const css = readFileSync(join(websiteRoot, 'assets/css/site.css'), 'utf8');
const _allHtml = [...htmlByFile.values()].join('\n');
const roadmapBlock = indexHtml.match(/<section class="roadmap-section"[\s\S]*?<\/section>/)?.[0] ?? '';
const heroBlock = indexHtml.match(/<section class="hero[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';

const contentChecks = [
  [/CAD für die Ingenieurvermessung\./, 'hero claim'],
  [/KOSTENLOS FÜR PRIVAT, TESTS UND BÜROS UNTER 3 PERSONEN/, 'hero free sticker'],
  [/KOSTENLOS LADEN/, 'hero free download CTA'],
  [/href="#download"/, 'hero CTA targets download'],
  [/79 € im Monat pro Büro · 790 € im Jahr · Preis für immer festgeschrieben/, 'founder price footnote'],
  [/20 €\/Monat/, 'supporter price'],
  [/>Roadmap\.<\/h2>/i, 'roadmap heading'],
  [/Vom ersten Scan bis zum fertigen Plan\. Alles, was fehlt, steht hier — mit Stand\./, 'roadmap subline'],
  [/0\.5 · DGM aus Scan/i, '0.5 roadmap card'],
  [/1\.0 · Punktwolken-Starter/i, '1.0 roadmap card'],
  [/1\.x · Projekt und Werkstatt/i, '1.x roadmap card'],
  [/2\.0 · Raster und Mengen/i, '2.0 roadmap card'],
  [/2\.5 · Trassen und Baugruben/i, '2.5 roadmap card'],
  [/3\.0 · BIM und Spezifikationen/i, '3.0 roadmap card'],
  [/3\.5 · Planeditor/i, '3.5 roadmap card'],
  [/4\.0 · Agent und Python/i, '4.0 roadmap card'],
  [/Finanziert durch Gründerbüros und offene Entwicklung\./, 'quiet roadmap financing line'],
  [/data-todo="registry-url"/, 'function registry placeholder'],
  [/Source-available, nicht Open Source\./i, 'license heading'],
  [/Business Source License 1\.1/, 'license authority'],
];
for (const [pattern, label] of contentChecks) log(pattern.test(indexHtml), label);

log((roadmapBlock.match(/class="timeline-card"/g) ?? []).length === 8, 'eight roadmap cards');
log(!/\b20\d{2}\b/.test(roadmapBlock), 'roadmap has no dates');
log(!/>\s*Fertig\s*</i.test(roadmapBlock), 'roadmap has no substrate status card');

const prohibitedNames = [
  ['Trimble', /\btrimble\b/i],
  ['RealWorks', /\brealworks\b/i],
  ['Autodesk', /\bautodesk\b/i],
  ['Revit', /\brevit\b/i],
  ['AutoCAD', /\bautocad\b/i],
  ['Civil 3D', /\bcivil\s*3d\b/i],
  ['RIB', /\brib\b/i],
  ['Leica', /\bleica\b/i],
  ['Cyclone', /\bcyclone\b/i],
  ['Bentley', /\bbentley\b/i],
];
const prohibitedHits = [];
for (const [file, html] of htmlByFile) {
  for (const [name, pattern] of prohibitedNames) {
    html.split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) {
        prohibitedHits.push(`${relative(websiteRoot, file)}:${index + 1} ${name}`);
      }
    });
  }
}
log(
  prohibitedHits.length === 0,
  'all HTML excludes prohibited CAD/scan vendor and product names',
  prohibitedHits.join(', '),
);

const linesContaining79 = indexHtml.split(/\r?\n/).filter((line) => line.includes('79'));
log(
  linesContaining79.length === 1,
  'grep-count of 79 in index.html is exactly one line',
  `${linesContaining79.length}`,
);
log((indexHtml.match(/\b79\b/g) ?? []).length === 1, 'standalone 79 occurs exactly once');
log(!/class="(?:sky|panel|brand|lang)\b/.test(indexHtml), 'rejected v1 components removed');
log(!/linear-gradient|radial-gradient/i.test(css), 'no CSS gradients');
log(!/border-radius/i.test(css), 'no border radius');
log(!/@keyframes|animation\s*:/i.test(css), 'no animation');
log(/prefers-reduced-motion/.test(css), 'reduced-motion rule present');
log(/hero--missing/.test(heroBlock) === !existsSync(heroImage), 'hero image/fallback state correct');
log((heroBlock.match(/<(?:h1|div)\b/g) ?? []).length === 3, 'hero contains only wordmark and offer boxes');

for (const [needle, label] of [
  ['Florian Fischer', 'legal name'],
  ['Steig 4', 'legal street'],
  ['88167 Grünenbach', 'legal city'],
  ['Germany', 'legal country'],
  ['fernwork.absolute836@passmail.net', 'legal e-mail'],
]) {
  log(impressumHtml.includes(needle) && datenschutzHtml.includes(needle), label);
}
log(datenschutzHtml.includes('Cloudflare Pages'), 'datenschutz keeps Cloudflare processing');
log(/Data Privacy Framework/i.test(datenschutzHtml), 'datenschutz keeps DPF text');
log(/Art\.\s*6\s*Abs\.\s*1\s*lit\.\s*f/.test(datenschutzHtml), 'datenschutz keeps legal basis');
log(/keine Cookies/i.test(datenschutzHtml), 'datenschutz states no cookies');

const linear = (channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const clean = hex.replace('#', '');
  return (
    0.2126 * linear(Number.parseInt(clean.slice(0, 2), 16)) +
    0.7152 * linear(Number.parseInt(clean.slice(2, 4), 16)) +
    0.0722 * linear(Number.parseInt(clean.slice(4, 6), 16))
  );
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
for (const [foreground, background, label, minimum] of [
  ['#f3f0e6', '#0a0a0a', 'cream on ink', 4.5],
  ['#0a0a0a', '#f3f0e6', 'ink on cream', 4.5],
  ['#0a0a0a', '#2e86ff', 'ink on sky blue', 4.5],
  ['#f3f0e6', '#0b2545', 'cream on missing-image fallback', 4.5],
  ['#f3f0e6', '#2e86ff', 'large bold cream on sky blue', 3],
]) {
  const ratio = contrast(foreground, background);
  log(ratio >= minimum, `contrast ${label}`, `${ratio.toFixed(2)}:1`);
}

const htmlValidate = spawnSync(
  'npx',
  [
    '--yes',
    'html-validate@9',
    '--config',
    relative(repoRoot, join(websiteRoot, '.htmlvalidate.json')),
    ...htmlFiles.map((file) => relative(repoRoot, file)),
  ],
  { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
);
if (htmlValidate.error) {
  notes.push(`html-validate skipped: ${htmlValidate.error.message}`);
  log(true, 'HTML validity', 'SKIPPED');
} else {
  const output = `${htmlValidate.stdout ?? ''}\n${htmlValidate.stderr ?? ''}`.trim();
  log(htmlValidate.status === 0, 'HTML validity', htmlValidate.status === 0 ? 'valid' : output.slice(0, 1800));
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
};
const server = http.createServer((request, response) => {
  const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const file = resolve(websiteRoot, relPath);
  if (!file.startsWith(websiteRoot) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});

const port = await new Promise((resolvePort) => {
  server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
});

const runBrowserChecks = async () => {
  const playwrightPath = join(repoRoot, 'node_modules/playwright-core/index.mjs');
  if (!existsSync(playwrightPath)) {
    notes.push('playwright-core missing; browser checks skipped');
    log(true, 'browser checks', 'SKIPPED');
    return;
  }
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
  } catch (error) {
    notes.push(`Google Chrome could not launch: ${error.message}`);
    log(true, 'browser checks', 'SKIPPED');
    return;
  }

  const origin = `http://127.0.0.1:${port}`;
  const page = await browser.newPage();
  try {
    for (const [path, width, height] of [
      ['/', 360, 800],
      ['/', 768, 1024],
      ['/', 1440, 900],
      ['/impressum.html', 360, 800],
      ['/datenschutz.html', 1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      const response = await page.goto(`${origin}${path}`, { waitUntil: 'load' });
      log(Boolean(response?.ok()), `load ${path} @${width}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      log(!overflow, `no horizontal overflow ${path} @${width}`);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const design = await page.evaluate(() => {
      const hero = document.querySelector('.hero');
      const body = getComputedStyle(document.body);
      const wordmark = getComputedStyle(document.querySelector('.wordmark'));
      return {
        heroHeight: hero?.getBoundingClientRect().height ?? 0,
        bodyFont: body.fontFamily,
        wordmarkFont: wordmark.fontFamily,
        animations: document.getAnimations().length,
      };
    });
    log(Math.abs(design.heroHeight - 900) <= 1, 'hero covers first viewport', `${design.heroHeight}px`);
    log(/monospace/i.test(design.bodyFont), 'monospace body typography', design.bodyFont);
    log(/HC Wordmark/i.test(design.wordmarkFont), 'Kamikaze wordmark typography', design.wordmarkFont);
    log(design.animations === 0, 'no runtime animation');

    const roadmapBounds = await page.evaluate(() => {
      const roadmap = document.querySelector('.roadmap-section');
      const lastCard = document.querySelector('.timeline-item:last-child');
      return {
        sectionBottom: roadmap?.getBoundingClientRect().bottom ?? 0,
        lastCardBottom: lastCard?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
      };
    });
    log(
      roadmapBounds.lastCardBottom <= roadmapBounds.sectionBottom,
      'complete roadmap fits inside its section',
    );

    await page.keyboard.press('Tab');
    const skipFocused = await page.evaluate(() => document.activeElement?.classList.contains('skip'));
    log(skipFocused, 'skip link is first tab stop');
    const focusedHrefs = [];
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press('Tab');
      focusedHrefs.push(
        await page.evaluate(() => document.activeElement?.getAttribute('href') ?? ''),
      );
    }
    log(
      ['#roadmap', '#preise', '#lizenz', 'impressum.html'].every((href) =>
        focusedHrefs.includes(href),
      ),
      'keyboard reaches primary navigation',
      focusedHrefs.join(', '),
    );

    const axePath = join(repoRoot, 'node_modules/axe-core/axe.min.js');
    if (existsSync(axePath)) {
      for (const path of ['/', '/impressum.html', '/datenschutz.html']) {
        await page.goto(`${origin}${path}`, { waitUntil: 'load' });
        await page.addScriptTag({ path: axePath });
        const violations = await page.evaluate(async () => {
          const result = await window.axe.run(document, { resultTypes: ['violations'] });
          return result.violations.map((item) => `${item.id} (${item.impact}) x${item.nodes.length}`);
        });
        log(violations.length === 0, `axe-core ${path}`, violations.join('; ') || 'no violations');
      }
    } else {
      notes.push('axe-core missing; accessibility automation skipped');
      log(true, 'axe-core', 'SKIPPED');
    }

    const screenshotDir = join(websiteRoot, '.check-out');
    mkdirSync(screenshotDir, { recursive: true });
    for (const [width, height] of [
      [1440, 900],
      [768, 1024],
      [360, 800],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
      const screenshotPath = join(screenshotDir, `index-${width}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log(existsSync(screenshotPath), `full-page screenshot ${width}`, relative(repoRoot, screenshotPath));
    }
  } finally {
    await browser.close();
  }
};

try {
  await runBrowserChecks();
} catch (error) {
  log(false, 'browser run', error.stack ?? error.message);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

if (notes.length) {
  process.stdout.write('\nNotes:\n');
  for (const note of notes) process.stdout.write(`- ${note}\n`);
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} gate(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nAll recorded gates passed.\n');
}
