#!/usr/bin/env node
/**
 * Overview sheet: the Assembler candidates next to the approved family marks
 * (on dark, on white, app icon card at 128/64/32/16 px, favicons in light and
 * dark tab strips, maskable crops, a taskbar row).
 *
 *   node sheet.mjs <out.png> [candidate-dir] [--sizes]
 *
 * `--sizes`: the chosen mark alone at every shipped size instead of the comparison.
 *
 * Family icons are the committed generated PNGs; candidate icons come from the
 * Assembler pipeline (`apps/assembler/scripts/generate-icon.mjs`), i.e. the
 * pixels that ship. Needs a local Chromium (playwright-core of apps/assembler-web).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../..');
const icon = await import(
  pathToFileURL(join(repo, 'apps/assembler/scripts/generate-icon.mjs')).href
);
const { chromium } = createRequire(join(repo, 'apps/assembler-web/package.json'))(
  'playwright-core',
);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const sizesMode = process.argv.includes('--sizes');
const out = resolve(args[0] ?? join(here, sizesMode ? '../bolt-sizes.png' : '../overview.png'));
const candDir = resolve(args[1] ?? join(here, '..'));

const png = (size, rgba) =>
  `data:image/png;base64,${Buffer.from(icon.encodePng(size, rgba)).toString('base64')}`;
const file = (path) =>
  `data:${path.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${readFileSync(path).toString('base64')}`;
const src = (name) => join(repo, 'branding/logos/source', name);
const gen = (id, size) => join(repo, 'branding/logos/generated', id, `icon-${size}.png`);

const family = [
  [
    'Himmel:CAD (cloud)',
    'himmelcad-builder-primary.svg',
    'himmelcad-on-light.svg',
    'builder-primary',
  ],
  ['Builder (hard hat)', 'himmelcad-builder.svg', 'himmelcad-builder-on-light.svg', 'builder'],
  ['PhotoLab (crystal)', 'himmelcad-photolab.svg', 'himmelcad-photolab-on-light.svg', 'photolab'],
  ['WeltView (globe)', 'himmelcad-weltview.svg', 'himmelcad-weltview-on-light.svg', 'weltview'],
  ['Cap (aperture, on hold)', 'himmelcad-cap.svg', 'himmelcad-cap-on-light.svg', 'cap'],
].map(([label, dark, light, id]) => ({
  label,
  dark: file(src(dark)),
  light: file(src(light)),
  icons: Object.fromEntries([128, 64, 32, 16].map((s) => [s, file(gen(id, s))])),
  fav: file(gen(id, 16)),
  favLight: file(gen(id, 16)),
}));

const candidates = [
  ['B · Bolt (chosen by the owner)', 'b-bolt', 'b-bolt-small', true],
  ['A · Hex nut (rejected)', 'a-nut', 'a-nut-small'],
  ['C · Printer nozzle (rejected)', 'c-nozzle'],
].map(([label, name, smallName, chosen]) => {
  const svg = (n, light) =>
    join(candDir, `himmelcad-assembler-${n}${light ? '-on-light' : ''}.svg`);
  const big = icon.parseMaster(readFileSync(svg(name), 'utf8'));
  const small = smallName ? icon.parseMaster(readFileSync(svg(smallName), 'utf8')) : big;
  const smallLight = icon.parseMaster(readFileSync(svg(smallName ?? name, true), 'utf8'));
  const pick = (s) => (s <= 32 ? small : big);
  return {
    label,
    chosen,
    big,
    small,
    smallLight,
    dark: file(svg(name)),
    light: file(svg(name, true)),
    icons: Object.fromEntries(
      [128, 64, 32, 16].map((s) => [s, png(s, icon.drawIcon(s, { polys: pick(s) }))]),
    ),
    fav: png(16, icon.drawMark(16, { polys: small })),
    favLight: png(16, icon.drawMark(16, { polys: smallLight })),
    maskable: png(192, icon.drawIcon(192, { maskable: true, polys: big })),
  };
});

const row = (m) => `
<div class="row${m.chosen ? ' chosen' : ''}">
  <div class="cell dark"><img src="${m.dark}" width="150" height="150"></div>
  <div class="cell white"><img src="${m.light}" width="150" height="150"></div>
  <div class="cell dark icons">${[128, 64, 32, 16].map((s) => `<img src="${m.icons[s]}" width="${s}" height="${s}">`).join('')}</div>
  <div class="cell tabs"><div class="tab tl"><img src="${m.favLight}" width="16" height="16"><span>Assembler</span></div><div class="tab td"><img src="${m.fav}" width="16" height="16"><span>Assembler</span></div></div>
  <div class="cell dark mask">${
    m.maskable
      ? `<img class="circle" src="${m.maskable}" width="72" height="72"><img class="squircle" src="${m.maskable}" width="72" height="72">`
      : '<span class="na">—</span>'
  }</div>
  <div class="label">${m.label}</div>
</div>`;

const zoom = candidates[0];
const taskbar = [...family.map((f) => f.icons[32]), zoom.icons[32]]
  .map((s) => `<img src="${s}" width="32" height="32">`)
  .join('');
const taskbarZoom = [...family.map((f) => f.icons[32]), zoom.icons[32]]
  .map((s) => `<img class="px" src="${s}" width="96" height="96">`)
  .join('');

const css = `
body{margin:0;padding:24px;background:#1b1b1b;color:#ddd;font:14px system-ui,sans-serif;width:1500px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:28px 0 8px;color:#aaa;font-weight:600}
p{margin:0 0 12px;color:#999}
.strip{display:flex;gap:18px;align-items:flex-end;padding:16px;border-radius:10px;width:max-content}
.strip figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:#999}
.dark{background:#1b1b1b}.white{background:#fff}.grey{background:#2a2a2a}.slate{background:#5a6470}
.circle{border-radius:50%}.squircle{border-radius:30%}.px{image-rendering:pixelated}
.tab{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px 8px 0 0;width:170px;font-size:13px}
.tl{background:#fff;color:#222;box-shadow:0 0 0 1px #ddd}.td{background:#35363a;color:#eee}
.bar{display:flex;gap:10px;padding:10px 16px;background:#202020;border-radius:8px;width:max-content;align-items:center}
`;

/** The chosen mark at every shipped size (`--sizes`). */
function sizesSheet(m) {
  const fig = (img, label) => `<figure>${img}<figcaption>${label}</figcaption></figure>`;
  const iconImg = (s, opts = {}) =>
    `<img src="${png(s, icon.drawIcon(s, { polys: s <= 32 ? m.small : m.big, ...opts }))}" width="${s}" height="${s}">`;
  const masters = [
    fig(
      `<div class="strip dark"><img src="${m.dark}" width="220" height="220"></div>`,
      'master on dark',
    ),
    fig(
      `<div class="strip white"><img src="${m.light}" width="220" height="220"></div>`,
      '-on-light on white',
    ),
    fig(
      `<div class="strip dark"><img src="${file(join(candDir, 'himmelcad-assembler-b-bolt-small.svg'))}" width="220" height="220"></div>`,
      'small master (16–32 px)',
    ),
  ].join('');
  const sizes = [512, 192, 128, 64, 32, 16].map((s) => fig(iconImg(s), `${s} px`)).join('');
  const zoom = [32, 16]
    .map((s) =>
      fig(
        `<img class="px" src="${png(s, icon.drawIcon(s, { polys: m.small }))}" width="${s * 6}" height="${s * 6}">`,
        `${s} px, 6× zoom`,
      ),
    )
    .join('');
  const mask = icon.drawIcon(192, { maskable: true, polys: m.big });
  const masks = [
    fig(`<img src="${png(192, mask)}" width="144" height="144">`, 'maskable, full'),
    fig(`<img class="circle" src="${png(192, mask)}" width="144" height="144">`, 'circle'),
    fig(`<img class="squircle" src="${png(192, mask)}" width="144" height="144">`, 'squircle'),
    fig(
      `<img style="border-radius:22%" src="${png(180, icon.drawIcon(180, { maskable: true, polys: m.big }))}" width="144" height="144">`,
      'apple-touch 180 (iOS rounds it)',
    ),
  ].join('');
  const tabs = `<div class="tab tl"><img src="${m.favLight}" width="16" height="16"><span>Himmel:CAD Assembler</span></div><div class="tab td"><img src="${m.fav}" width="16" height="16"><span>Himmel:CAD Assembler</span></div>`;
  const tabsZoom = `<img class="px" src="${m.favLight}" width="96" height="96" style="background:#fff"><img class="px" src="${m.fav}" width="96" height="96" style="background:#35363a">`;
  const row = [...family.map((f) => f.icons[32]), m.icons[32]];
  return `<!doctype html><meta charset="utf-8"><style>${css}</style>
<h1>Himmel:CAD Assembler – the bolt at every size</h1>
<p>Rendered by the shipping pipeline (apps/assembler/scripts/generate-icon.mjs). 32 and 16 px use the small master: three thread steps, taller head.</p>
<div class="strip grey">${masters}</div>
<h2>App icon (black card, as the family): 512 · 192 · 128 · 64 · 32 · 16 px</h2>
<div class="strip grey">${sizes}</div><div style="height:10px"></div><div class="strip grey">${zoom}</div>
<h2>Maskable (Android/ChromeOS crop the safe zone) and iOS home screen</h2>
<div class="strip slate">${masks}</div>
<h2>Favicon (SVG follows the colour scheme): light and dark tab strip, and 6× zoom</h2>
<div class="strip grey" style="flex-direction:column;align-items:flex-start;gap:8px">${tabs}</div><div style="height:10px"></div><div class="strip grey">${tabsZoom}</div>
<h2>Taskbar row at 32 px: cloud, hard hat, crystal, globe, aperture, bolt (1:1 and 3×)</h2>
<div class="bar">${row.map((s) => `<img src="${s}" width="32" height="32">`).join('')}</div><div style="height:10px"></div>
<div class="bar">${row.map((s) => `<img class="px" src="${s}" width="96" height="96">`).join('')}</div>`;
}

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#1b1b1b;color:#ddd;font:14px system-ui,sans-serif;width:1500px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:28px 0 8px;color:#aaa;font-weight:600}
p{margin:0 0 12px;color:#999}
.head,.row{display:grid;grid-template-columns:170px 170px 300px 250px 190px 1fr;align-items:center;gap:8px}
.head div{color:#888;font-size:12px}
.row{margin:6px 0;padding:6px;border-radius:10px}
.row.chosen{outline:2px solid #1597F2;background:#202a33}
.cell{display:flex;align-items:center;justify-content:center;height:170px;border-radius:8px}
.dark{background:#1b1b1b}.white{background:#fff}
.icons{gap:14px;background:#2a2a2a}.label{font-weight:600}
.tabs{flex-direction:column;gap:10px}
.tab{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px 8px 0 0;width:150px;font-size:13px}
.tl{background:#fff;color:#222;box-shadow:0 0 0 1px #ddd}.td{background:#35363a;color:#eee}
.mask{gap:14px;background:#5a6470}.circle{border-radius:50%}.squircle{border-radius:30%}.na{color:#888}
.bar{display:flex;gap:10px;padding:10px 16px;background:#202020;border-radius:8px;width:max-content;align-items:center}
.px{image-rendering:pixelated}
</style>
<h1>Himmel:CAD Assembler – app icon candidates next to the family</h1>
<p>Same azure ramp (12 tones), same light (upper left), flat facets without strokes, black rounded card as the family's app icons. Icons at 32 and 16 px use a reduced master (bolt: three thread steps and a taller head; nut: no thread rings). Rendered by the shipping pipeline.</p>
<div class="head"><div>master, dark</div><div>-on-light, white</div><div>app icon 128 · 64 · 32 · 16 px</div><div>favicon 16 px, light / dark tab</div><div>maskable 192 (circle, squircle)</div><div></div></div>
${candidates.map(row).join('')}
<h2>Family (approved 2026-09-25)</h2>
${family.map(row).join('')}
<h2>Taskbar row at 32 px (1:1 and 3× pixel zoom): cloud, hard hat, crystal, globe, aperture, bolt</h2>
<div class="bar">${taskbar}</div><div style="height:10px"></div><div class="bar">${taskbarZoom}</div>
`;

const exe = [
  process.env.ASM_CHROME,
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1234/chrome-win64/chrome.exe'),
].find((p) => p && existsSync(p));
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({
  viewport: { width: 1548, height: 900 },
  deviceScaleFactor: 1,
});
await page.setContent(sizesMode ? sizesSheet(candidates[0]) : html);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
process.stdout.write(`${out}\n`);
