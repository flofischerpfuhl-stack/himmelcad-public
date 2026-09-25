import config from '../site.config.mjs';

export const routes = [
  ['/', 'Home'],
  ['/photolab/', 'PhotoLab'],
  ['/builder/', 'Builder'],
  ['/cap-weltview/', 'Cap + WeltView'],
  ['/roadmap/', 'Roadmap'],
  ['/pricing/', 'Pricing'],
  ['/licence/', 'Licence'],
  ['/download/', 'Download'],
];

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function status(label, kind = 'planned') {
  return `<span class="status status--${kind}">${escapeHtml(label)}</span>`;
}

export function button(href, label, variant = '') {
  return `<a class="button ${variant}" href="${href}">${escapeHtml(label)} <span aria-hidden="true">→</span></a>`;
}

export function jsonLd(page) {
  const graph = [
    {
      '@type': 'Organization',
      name: config.siteName,
      email: config.contactEmail,
      founder: { '@type': 'Person', name: 'Florian Fischer' },
    },
  ];
  for (const software of page.software
    ? Array.isArray(page.software)
      ? page.software
      : [page.software]
    : []) {
    graph.push({
      '@type': 'SoftwareApplication',
      name: software.name,
      applicationCategory: software.category,
      operatingSystem: software.os,
      description: page.description,
      releaseNotes: 'No public build has been released.',
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replaceAll(
    '<',
    '\\u003c',
  );
}

function navLink([href, label], currentPath) {
  const current = href === currentPath ? ' aria-current="page"' : '';
  return `<a href="${href}"${current}>${label}</a>`;
}

export function layout(page, assets) {
  const title =
    page.path === '/'
      ? 'Himmel:CAD — CAD and photogrammetry, offline'
      : `${page.title} — Himmel:CAD`;
  const canonical = config.siteUrl ? `${config.siteUrl}${page.path}` : '';
  const nav = routes
    .slice(1)
    .map((route) => navLink(route, page.path))
    .join('');
  const ogImage = config.siteUrl
    ? `${config.siteUrl}${assets['images/og-image.png']}`
    : assets['images/og-image.png'];
  const heroPreload =
    page.path === '/'
      ? `<link rel="preload" as="image" href="${assets['images/sky-hero-1440.webp']}" imagesrcset="${assets['images/sky-hero-1440.webp']} 1440w, ${assets['images/sky-hero-2880.webp']} 2880w" imagesizes="100vw" fetchpriority="high">`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta name="theme-color" content="${page.path === '/' ? config.theme.deepSky : config.theme.cream}">
  <meta name="color-scheme" content="light">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Himmel:CAD">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(page.description)}">
  <meta name="twitter:image" content="${ogImage}">
  ${canonical ? `<link rel="canonical" href="${canonical}">\n  <meta property="og:url" content="${canonical}">` : ''}
  ${page.noIndex ? '<meta name="robots" content="noindex">' : ''}
  <link rel="alternate" hreflang="en" href="${canonical || page.path}">
  <link rel="alternate" hreflang="x-default" href="${canonical || page.path}">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/svg+xml" href="${assets['logos/himmelcad-builder-primary.svg']}">
  <link rel="icon" href="${assets['icons/favicon.ico']}" sizes="any">
  <link rel="apple-touch-icon" href="${assets['icons/icon-180.png']}">
  <link rel="preload" href="${assets['fonts/Kamikaze.ttf']}" as="font" type="font/ttf" crossorigin>
  ${heroPreload}
  <link rel="stylesheet" href="${assets['site.css']}">
  <script type="application/ld+json" src="${assets[page.structuredKey]}"></script>
  <script src="${assets['site.js']}" defer></script>
</head>
<body class="${page.path === '/' ? 'home' : 'inner'}">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/" aria-label="Himmel:CAD home">Himmel:CAD</a>
    <nav class="wide-nav" aria-label="Primary">${nav}</nav>
    <details class="menu">
      <summary aria-label="Open navigation">Menu</summary>
      <nav aria-label="Mobile primary">${nav}</nav>
    </details>
  </header>
  <main id="main">${page.content}</main>
  <footer class="site-footer">
    <div><a class="footer-brand" href="/">Himmel:CAD</a><p>Offline-first spatial software. No public build yet.</p></div>
    <nav aria-label="Products"><h2>Products</h2><a href="/photolab/">PhotoLab</a><a href="/builder/">Builder</a><a href="/cap-weltview/">Cap + WeltView</a></nav>
    <nav aria-label="Project"><h2>Project</h2><a href="/roadmap/">Roadmap</a><a href="/pricing/">Pricing</a><a href="/licence/">Licence</a><a href="/download/">Download</a></nav>
    <nav aria-label="Legal"><h2>Contact</h2><a href="mailto:${config.contactEmail}">${config.contactEmail}</a><a href="/legal/">Legal notice</a><a href="/privacy/">Privacy</a></nav>
  </footer>
  <aside class="preview-note" aria-label="Preview notice"><strong>Preview</strong><span>In development. Nothing is released yet.</span><a href="/download/">Release status <span aria-hidden="true">→</span></a></aside>
</body>
</html>`;
}

export function mediaFigure(slot, assetPath) {
  if (slot.kind === 'image') {
    return `<figure class="media-frame"><picture>${slot.webpExists ? `<source srcset="${slot.webpPath}" type="image/webp">` : ''}<img src="${assetPath}" alt="${escapeHtml(slot.alt)}" width="${slot.width}" height="${slot.height}" loading="lazy" decoding="async"></picture><figcaption>${escapeHtml(slot.caption)}</figcaption></figure>`;
  }
  return `<figure class="media-frame"><video muted loop playsinline preload="none" controls data-in-view width="${slot.width}" height="${slot.height}"${slot.posterPath ? ` poster="${slot.posterPath}"` : ''} aria-label="${escapeHtml(slot.alt)}"><source src="${assetPath}" type="video/mp4">Your browser cannot play this video.</video><figcaption>${escapeHtml(slot.caption)}</figcaption></figure>`;
}
