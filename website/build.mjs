#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './site.config.mjs';
import { createPages } from './src/pages.mjs';
import { jsonLd, layout, mediaFigure } from './src/layout.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(root, 'src');
const assetRoot = join(srcRoot, 'assets');
const mediaRoot = join(srcRoot, 'media');
const distRoot = join(root, 'dist');
const assetsOut = join(distRoot, 'assets');
const watch = process.argv.includes('--watch');

const hash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 12);
const slash = (value) => value.split('\\').join('/');
const selfCloseVoid = (html) =>
  html.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*)>/gi,
    (_match, tag, attributes) => `<${tag}${attributes.replace(/\s*\/$/, '')} />`,
  );

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function outputName(key, data) {
  const extension = extname(key);
  const stem = key.slice(0, -extension.length);
  return `${stem}.${hash(data)}${extension}`;
}

function writeAsset(key, data, assets) {
  const name = outputName(key, data);
  const target = join(assetsOut, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  assets[key] = `/assets/${slash(name)}`;
  return assets[key];
}

function build() {
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(assetsOut, { recursive: true });
  const assets = {};

  const deferredCss = join(assetRoot, 'site.css');
  const deferredJs = join(assetRoot, 'site.js');
  for (const file of walk(assetRoot)) {
    if (file === deferredCss || file === deferredJs) continue;
    const key = slash(relative(assetRoot, file));
    writeAsset(key, readFileSync(file), assets);
  }

  const js = readFileSync(deferredJs);
  writeAsset('site.js', js, assets);
  let css = readFileSync(deferredCss, 'utf8')
    .replaceAll('__FONT__', assets['fonts/Kamikaze.ttf'])
    .replaceAll('__HERO_1440_WEBP__', assets['images/sky-hero-1440.webp'])
    .replaceAll('__HERO_2880_WEBP__', assets['images/sky-hero-2880.webp'])
    .replaceAll('__HERO_1440_JPG__', assets['images/sky-hero-1440.jpg'])
    .replaceAll('__HERO_2880_JPG__', assets['images/sky-hero-2880.jpg']);
  writeAsset('site.css', css, assets);

  const mediaSlots = JSON.parse(readFileSync(join(root, 'content/media.json'), 'utf8'));
  const mediaById = new Map();
  const missing = [];
  for (const original of mediaSlots) {
    const slot = { ...original };
    const file = join(mediaRoot, slot.file);
    if (!existsSync(file)) {
      missing.push(`${slot.id}: src/media/${slot.file}`);
      continue;
    }
    const key = `media/${slot.file}`;
    slot.assetPath = writeAsset(key, readFileSync(file), assets);
    const webpName = slot.file.replace(/\.[^.]+$/, '.webp');
    if (webpName !== slot.file && existsSync(join(mediaRoot, webpName))) {
      slot.webpExists = true;
      slot.webpPath = writeAsset(
        `media/${webpName}`,
        readFileSync(join(mediaRoot, webpName)),
        assets,
      );
    }
    if (slot.poster) {
      const poster = join(mediaRoot, slot.poster);
      if (existsSync(poster))
        slot.posterPath = writeAsset(`media/${slot.poster}`, readFileSync(poster), assets);
      else missing.push(`${slot.id} poster: src/media/${slot.poster}`);
    }
    mediaById.set(slot.id, slot);
  }

  const releases = JSON.parse(readFileSync(join(root, 'content/releases.json'), 'utf8'));
  const context = {
    releases,
    asset(key) {
      if (!assets[key]) throw new Error(`Unknown asset: ${key}`);
      return assets[key];
    },
    media(id) {
      const slot = mediaById.get(id);
      return slot ? mediaFigure(slot, slot.assetPath) : '';
    },
  };
  const pages = createPages(context);
  for (const page of pages) {
    page.structuredKey = `data/${page.path === '/' ? 'home' : page.path.replaceAll('/', '') || 'page'}.json`;
    writeAsset(page.structuredKey, `${jsonLd(page)}\n`, assets);
  }

  const htmlPaths = [];
  for (const page of pages) {
    const out =
      page.path === '/'
        ? join(distRoot, 'index.html')
        : page.path === '/404.html'
          ? join(distRoot, '404.html')
          : join(distRoot, page.path.slice(1), 'index.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${selfCloseVoid(layout(page, assets))}\n`);
    htmlPaths.push(page.path === '/404.html' ? '/404.html' : page.path);
  }

  const manifest = {
    name: 'Himmel:CAD',
    short_name: 'Himmel:CAD',
    lang: 'en',
    description: config.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: config.theme.cream,
    theme_color: config.theme.deepSky,
    icons: [
      { src: assets['icons/icon-192.png'], sizes: '192x192', type: 'image/png' },
      { src: assets['icons/icon-512.png'], sizes: '512x512', type: 'image/png' },
      {
        src: assets['icons/icon-512-maskable.png'],
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: assets['logos/himmelcad-builder-primary.svg'], sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  writeFileSync(join(distRoot, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

  const shell = [
    ...htmlPaths.filter((path) => path !== '/404.html'),
    assets['site.css'],
    assets['site.js'],
    assets['fonts/Kamikaze.ttf'],
    assets['icons/icon-192.png'],
    assets['icons/icon-512.png'],
    assets['icons/icon-512-maskable.png'],
    assets['logos/himmelcad-builder-primary.svg'],
    '/manifest.webmanifest',
  ];
  const buildId = hash(
    shell.join('|') +
      walk(distRoot)
        .map((file) => hash(readFileSync(file)))
        .join('|'),
  );
  const serviceWorker = `const VERSION = ${JSON.stringify(buildId)};
const SHELL = 'himmelcad-shell-' + VERSION;
const RUNTIME = 'himmelcad-media-' + VERSION;
const PRECACHE = ${JSON.stringify(shell)};
self.addEventListener('install', (event) => event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => ![SHELL, RUNTIME].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
async function trim(cacheName, limit) { const cache = await caches.open(cacheName); const keys = await cache.keys(); await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((key) => cache.delete(key))); }
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => { const copy = response.clone(); caches.open(SHELL).then((cache) => cache.put(request, copy)); return response; }).catch(async () => (await caches.match(request)) || caches.match('/offline/')));
    return;
  }
  if (request.destination === 'image' || request.destination === 'video') {
    event.respondWith(caches.open(RUNTIME).then(async (cache) => { const cached = await cache.match(request); const fresh = fetch(request).then((response) => { if (response.ok) { cache.put(request, response.clone()); trim(RUNTIME, 40); } return response; }).catch(() => cached); return cached || fresh; }));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});\n`;
  writeFileSync(join(distRoot, 'sw.js'), serviceWorker);

  const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: no-cache

/manifest.webmanifest
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache
`;
  writeFileSync(join(distRoot, '_headers'), headers);
  writeFileSync(
    join(distRoot, '_redirects'),
    `/impressum.html /legal/ 301
/datenschutz.html /privacy/ 301
/index.html / 301
`,
  );
  writeFileSync(
    join(distRoot, 'robots.txt'),
    `User-agent: *\nAllow: /\n${config.siteUrl ? `Sitemap: ${config.siteUrl}/sitemap.xml\n` : ''}`,
  );
  const sitemapUrls = config.siteUrl
    ? pages
        .filter((page) => !page.noIndex && page.path !== '/404.html')
        .map((page) => `  <url><loc>${config.siteUrl}${page.path}</loc></url>`)
        .join('\n')
    : '  <!-- Set siteUrl to emit absolute URLs. -->';
  writeFileSync(
    join(distRoot, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls}\n</urlset>\n`,
  );

  console.log(`Built ${pages.length} pages (${buildId}).`);
  if (!config.siteUrl)
    console.warn(
      'WARNING siteUrl is empty: canonical, og:url and absolute sitemap URLs were omitted.',
    );
  if (missing.length)
    console.warn(`WARNING missing media (${missing.length}):\n- ${missing.join('\n- ')}`);
}

function snapshot() {
  return hash(
    walk(root)
      .filter((file) => !file.startsWith(distRoot) && !file.includes('/.check-out/'))
      .map((file) => `${file}:${statSync(file).mtimeMs}:${statSync(file).size}`)
      .join('|'),
  );
}

build();
if (watch) {
  let state = snapshot();
  console.log('Watching website sources…');
  setInterval(() => {
    const next = snapshot();
    if (next !== state) {
      state = next;
      try {
        build();
      } catch (error) {
        console.error(error);
      }
    }
  }, 500);
}
