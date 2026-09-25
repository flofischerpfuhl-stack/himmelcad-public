import { button, escapeHtml, status } from './layout.mjs';

const notify =
  'mailto:fernwork.absolute836@passmail.net?subject=Himmel%3ACAD%20release%20notification&amp;body=Hello%2C%0A%0APlease%20notify%20me%20when%20a%20public%20Himmel%3ACAD%20build%20is%20available.%0A';
const commercial =
  'mailto:fernwork.absolute836@passmail.net?subject=Himmel%3ACAD%20commercial%20licence&amp;body=Hello%2C%0A%0AI%20would%20like%20to%20ask%20about%20a%20commercial%20Himmel%3ACAD%20licence.%0A%0AOrganisation%3A%0APeople%3A%0AIntended%20use%3A%0A';

function intro(kicker, title, text, extra = '', mark = '') {
  return `<section class="page-intro">${mark}<p class="eyebrow">${kicker}</p><h1 class="display-title">${title}</h1><p class="lede">${text}</p>${extra}</section>`;
}

// Product mark on a dark app-icon tile; decorative, the product name always follows as text.
function mark(ctx, product, size = '') {
  const src = ctx.asset(`logos/himmelcad-${product}.svg`);
  return `<span class="product-mark${size ? ` product-mark--${size}` : ''}"><img src="${src}" alt="" width="256" height="256" /></span>`;
}

function productsGrid(ctx) {
  return `<div class="card-grid product-grid">
    <article class="card card--blue">${status('First release in progress', 'active')}${mark(ctx, 'photolab')}<h3 class="display-title">PhotoLab</h3><p>Turns image and control data into aligned cameras, point clouds, elevation products, orthomosaics, meshes and splats.</p><a class="text-link" href="/photolab/">PhotoLab details →</a></article>
    <article class="card">${status('Internal build', 'works')}${mark(ctx, 'builder')}<h3 class="display-title">Builder</h3><p>The flagship: 3D-first Civil CAD with first-class 2D and 2.5D construction.</p><a class="text-link" href="/builder/">Builder details →</a></article>
    <article class="card">${status('MVP; not released', 'active')}${mark(ctx, 'cap')}<h3 class="display-title">Cap</h3><p>Mobile field capture that packages images, poses and quality evidence into a <code>.hcap</code> session.</p><a class="text-link" href="/cap-weltview/">Cap status →</a></article>
    <article class="card">${status('Publication planned', 'planned')}${mark(ctx, 'weltview')}<h3 class="display-title">WeltView</h3><p>A read-only browser viewer for shared Himmel:CAD projects.</p><a class="text-link" href="/cap-weltview/#weltview">WeltView status →</a></article>
  </div>`;
}

function home(ctx) {
  return {
    path: '/',
    title: 'Himmel:CAD',
    description:
      'Offline-first CAD, photogrammetry, capture and viewing for surveying and civil engineering. No public build yet.',
    content: `<section class="hero">
      <div class="hero-art" role="img" aria-label="Painted blue sky with clouds"></div>
      <h1 class="display-title hero-title">Himmel:CAD</h1><div class="hero-copy"><p class="hero-line">CAD, photogrammetry, capture and viewing for surveying and civil engineering.</p><p class="hero-status">No public build yet. PhotoLab will be first.</p><div class="hero-actions">${button('/photolab/', 'See PhotoLab', 'button--cream')}${button('/download/', 'Release status', 'button--dark')}</div></div>
    </section>
    <section class="section"><div class="section-heading"><p class="eyebrow">Four connected products</p><h2 class="display-title">One family.</h2><p>Shared data, rendering and commands where each product allows it. Every status below shows the current development state; none is a public release.</p></div>${productsGrid(ctx)}</section>
    <section class="section section--ink licence-band"><div><p class="eyebrow">Licence essentials</p><h2 class="display-title">Free use.</h2><p class="section-lede">For people and small offices.</p></div><div class="licence-facts"><p><strong>Free:</strong> personal use, evaluation, qualifying education and non-profit research, and organisations with <strong>3 or fewer people</strong> — including paid client work.</p><p><strong>Commercial licence:</strong> production use by organisations above three people, and hosted offerings for third parties. A growing organisation has 90 days to arrange a licence.</p><p>BSL 1.1 with an Additional Use Grant. Each release changes to AGPL-3.0-or-later four years after release.</p>${button('/licence/', 'Read the licence summary', 'button--cream')}</div></section>
    <section class="section action-grid"><article><p class="eyebrow">Programme</p><h2>Follow the work.</h2><p>The roadmap separates current evidence from planned outcomes. It does not promise dates.</p>${button('/roadmap/', 'Open roadmap')}</article><article><p class="eyebrow">Access</p><h2>Nothing to install yet.</h2><p>There is no public download. When one exists, the download page will list each file with its size and SHA-256 checksum.</p>${button('/download/', 'Check downloads')}</article><article><p class="eyebrow">Pricing</p><h2>Free up to three people.</h2><p>Commercial licences for larger organisations are available on request. No prices have been set.</p>${button('/pricing/', 'See pricing')}</article></section>`,
  };
}

function photolab(ctx) {
  const productMedia = `${ctx.media('photolab-alignment')}${ctx.media('photolab-dense')}${ctx.media('photolab-dem-ortho')}`;
  return {
    path: '/photolab/',
    title: 'PhotoLab',
    description:
      'PhotoLab processes image and control data into aligned cameras, point clouds, elevation products, orthomosaics, meshes and splats offline.',
    software: {
      name: 'Himmel:CAD PhotoLab',
      category: 'MultimediaApplication',
      os: 'Linux, Windows',
    },
    content: `${intro('PhotoLab · first release in progress', 'PhotoLab.', 'Images become measured spatial products offline. PhotoLab keeps the source data, coordinate choices, accuracy evidence and a record of how each result was made.', status('No public build', 'active'), mark(ctx, 'photolab', 'large'))}
    <section class="section split"><div><h2>From capture to published products.</h2><p>Import image files, directories, video-derived frames, camera metadata, control data or a Cap <code>.hcap</code> session. Align cameras, inspect sparse geometry and control, then generate selected products from the chosen source data and settings.</p><ul class="plain-list"><li>Aligned cameras and sparse geometry</li><li>Measurable depth and dense point clouds</li><li>DSM and DTM elevation products</li><li>Orthomosaics</li><li>Textured terrain and spatial meshes</li><li>Gaussian splat datasets</li></ul></div><div>${ctx.media('photolab-project')}${ctx.media('photolab-workflow')}</div></section>
    <section class="section section--blue ${productMedia ? '' : 'section--compact'}" id="products"><div class="section-heading"><p class="eyebrow">Works in internal builds</p><h2 class="display-title">Products.</h2><p>The processing chain runs. An eight-image test produced aligned cameras, depth maps, a dense cloud, DEM, orthomosaic, textured terrain mesh and Gaussian splat. Later validation with 135 images completed camera alignment and GCP optimisation.</p></div>${productMedia ? `<div class="media-grid">${productMedia}</div>` : ''}</section>
    <section class="section split"><div><p class="eyebrow">Run lifecycle</p><h2>Cancellation and recovery are product requirements.</h2><p>Long stages report progress. Cancellation stops new work, ends processing within a bounded deadline and leaves saved results unchanged. Saved progress may be resumed after an interruption when the source data and settings still match.</p><p>These behaviours still need testing across the complete workflow.</p></div><div><p class="eyebrow">Accuracy and reports</p><h2>Resolution is not reported as accuracy.</h2><p>Control and checkpoint residuals remain separate. Reports retain the inputs, coordinate choices, settings, processing history and quality evidence behind a published result.</p>${ctx.media('photolab-report')}</div></section>
    <section class="section readiness"><div class="section-heading"><p class="eyebrow">Release readiness</p><h2 class="display-title">Release status.</h2><p>Working features do not make a public release. The remaining evidence is stated below.</p></div><div class="readiness-grid"><article>${status('Works', 'works')}<h3>Verified work</h3><p>A review on 19 September 2026 found 4 requirements fully tested and 37 partly tested. A later internal test completed GCP optimisation with 135 images.</p></article><article>${status('In progress', 'active')}<h3>Evidence still required</h3><p>The complete product set still needs real-data testing. Recovery after a forced shutdown, cancellation, reports, and opening results in Builder and WeltView also need more evidence.</p></article><article>${status('Before release', 'planned')}<h3>Before release</h3><p>Linux and Windows installers must be tested. All included processing components need an offline and licence review, and results must open correctly in Builder and WeltView.</p></article></div><div class="callout"><strong>Current status:</strong> PhotoLab is the first intended release, but no public build exists. ${button('/download/', 'See release status')}</div></section>`,
  };
}

function builder(ctx) {
  return {
    path: '/builder/',
    title: 'Builder',
    description:
      'Builder is the 3D-first Civil CAD in development, with current point-cloud and terrain workflows and a documented completion programme.',
    software: { name: 'Himmel:CAD Builder', category: 'DesignApplication', os: 'Linux, Windows' },
    content: `${intro('Builder · flagship in development', 'Builder.', 'A 3D-first Civil CAD with first-class 2D and 2.5D construction. Builder keeps point clouds, terrain, CAD, raster, mesh and BIM work in one project.', status('No public build', 'active'), mark(ctx, 'builder', 'large'))}
    <section class="section inventory"><div class="section-heading"><p class="eyebrow">Audited function inventory</p><h2 class="display-title">Inventory.</h2><p>The inventory dated 24 September 2026 accounts for 221 functions. It records what works now and what remains planned; the count does not mean the software is ready for release.</p></div><dl class="number-grid"><div><dt>Built</dt><dd>68</dd></div><div><dt>Built, no UI</dt><dd>8</dd></div><div><dt>Planned</dt><dd>142</dd></div><div><dt>Deferred</dt><dd>3</dd></div></dl></section>
    <section class="section" id="works"><div class="section-heading"><p class="eyebrow">Works in the current internal build</p><h2 class="display-title">Current build.</h2><p>Viewer, point-cloud, terrain and export foundations are available in the internal build.</p></div><div class="feature-columns"><article><h3>View and inspect</h3><p>Navigate the shared 3D viewer, select objects, use display controls and inspect mixed spatial scenes.</p></article><article><h3>Process point clouds</h3><p>Fence and segment a cloud, rasterise height and run ground extraction with preview, progress and cancellation.</p></article><article><h3>Create and edit a DGM</h3><p>Choose sources, check the surface draft, apply listed fixes, create the surface, then smooth or downsample a selected region.</p></article><article><h3>Plan an export</h3><p>Choose a supported format, review expected losses and export with visible progress and cancellation.</p></article></div><div class="media-grid">${ctx.media('builder-viewer')}${ctx.media('builder-clipping')}${ctx.media('builder-ground')}${ctx.media('builder-dem')}${ctx.media('builder-export')}${ctx.media('builder-workflow')}</div></section>
    <section class="section section--ink" id="being-built"><div class="section-heading"><p class="eyebrow">Being built</p><h2 class="display-title">Next work.</h2><p>The current programme places every function in one coherent interface before wider feature work continues.</p></div><div class="feature-columns"><article>${status('In progress', 'active')}<h3>Project foundations</h3><p>Projects, import, export, registration, properties, progress, cancellation and recovery.</p></article><article>${status('In progress', 'active')}<h3>Point-cloud starter</h3><p>Daily viewing, measurement, filtering, classification, registration and station workflows.</p></article><article>${status('Planned', 'planned')}<h3>Construction and terrain</h3><p>Point and line drafting, snapping, breaklines, terrain editing, profiles, quantities and Civil geometry.</p></article><article>${status('Planned', 'planned')}<h3>Plans and automation</h3><p>Sheets, annotation and repeatable output, then Python and agent access through the same documented actions as the user interface.</p></article></div>${ctx.media('builder-breaklines')}</section>
    <section class="section evidence-note"><p class="eyebrow">Named internal validation</p><h2 class="display-title">Validation.</h2><p>A mixed real project has been exercised. The Alte Akademie test loaded a 96,600,723-point cloud, a 20 cm orthomosaic, a tiled DEM and 895 IFC objects in one shared viewer. Navigation, clipping, transparency, terrain exaggeration and panel resizing were inspected. This evidence describes a development build, not release readiness.</p>${button('/roadmap/', 'See the staged programme')}</section>`,
  };
}

function capWeltview(ctx) {
  return {
    path: '/cap-weltview/',
    title: 'Cap and WeltView',
    description:
      'Cap is the mobile capture companion in field validation; WeltView is the read-only browser viewer planned for project publication.',
    software: [
      { name: 'Himmel:CAD Cap', category: 'UtilitiesApplication', os: 'Android, iOS' },
      { name: 'Himmel:CAD WeltView', category: 'DesignApplication', os: 'Web browser' },
    ],
    content: `${intro('Companion products', 'Companions.', 'Cap captures in the field. WeltView is for browser review. Both connect to the same project family without gaining Builder’s editing rights.')}
    <section class="section split"><article>${status('Implemented MVP', 'works')}<h2 class="product-heading">${mark(ctx, 'cap', 'small')}Himmel:CAD Cap</h2><p>A Flutter application for Android and iOS. Cap records phone imagery, poses, observations and quality evidence, then prepares a versioned, checksummed <code>.hcap</code> package for PhotoLab.</p><p>Capture data stays local unless the operator explicitly shares or uploads it. Reconstruction, CRS decisions and final accuracy reporting belong to PhotoLab.</p><div class="callout"><strong>Not released:</strong> supported devices, capture reliability, field accuracy, package recovery and complete Cap-to-PhotoLab results still need field evidence.</div></article><article id="weltview">${status('Browser viewer in progress', 'active')}<h2 class="product-heading">${mark(ctx, 'weltview', 'small')}Himmel:CAD WeltView</h2><p>A read-only browser viewer for shared projects. It uses the shared viewer and interface but cannot edit project data.</p><p>Publication remains a roadmap stage. The delivery method for large projects and full real-project loading still require validation.</p><div class="callout"><strong>Not released:</strong> there is no public WeltView service or project link.</div></article></section>`,
  };
}

function roadmap() {
  return {
    path: '/roadmap/',
    title: 'Roadmap',
    description:
      'The staged Himmel:CAD roadmap: PhotoLab release, Builder completion, WeltView publication and Cap field hardening.',
    content: `${intro('Roadmap', 'Roadmap.', 'The stages follow the current product direction. A stage advances only when the required work and evidence are complete. No release dates are published.')}
    <section class="section"><ol class="roadmap-list"><li><article>${status('In progress', 'active')}<p class="stage">R1</p><h2>PhotoLab first release</h2><p>Complete import-to-product workflows, real-data accuracy evidence, cancellation and recovery, offline processing, Linux and Windows packages, and results that open correctly in Builder and WeltView.</p><a href="/photolab/">PhotoLab readiness →</a></article></li><li><article>${status('In progress', 'active')}<p class="stage">R2</p><h2>Builder product completion</h2><p>Complete 2D, 2.5D and 3D construction across projects, import, export, point clouds, terrain, meshes, rasters, BIM/Civil data, plans and documented automation.</p><a href="/builder/">Builder status →</a></article></li><li><article>${status('Planned', 'planned')}<p class="stage">R3</p><h2>WeltView publication</h2><p>Publish Builder and PhotoLab projects for read-only browser viewing with the same rendering and project data. Select and validate the delivery method for large projects.</p><a href="/cap-weltview/#weltview">WeltView status →</a></article></li><li><article>${status('MVP; field hardening planned', 'planned')}<p class="stage">R4</p><h2>Cap field hardening</h2><p>Validate devices, capture reliability, honest GNSS quality, <code>.hcap</code> interoperability, privacy and measured PhotoLab results before release claims.</p><a href="/cap-weltview/">Cap status →</a></article></li></ol><div class="callout">Current work prioritises PhotoLab while Builder continues in parallel.</div></section>`,
  };
}

function pricing() {
  return {
    path: '/pricing/',
    title: 'Pricing',
    description:
      'Himmel:CAD is free for personal use and organisations with three or fewer people. Commercial licences are available on request.',
    content: `${intro('Pricing', 'Pricing.', 'Free for people and small organisations. Commercial use by larger organisations is licensed on request; no prices have been set.')}
    <section class="section"><div class="pricing-grid"><article class="price-card price-card--free"><p class="price-label">Free</p><p class="price">€0</p><h2>For people and small organisations.</h2><p>Personal use; evaluation by anyone; qualifying teaching and non-profit research; and production use by organisations with <strong>3 or fewer people</strong>, including paid client work.</p><p>No registration or licence key is required for qualifying use.</p>${button('/licence/', 'Check the licence terms')}</article><article class="price-card price-card--dark"><p class="price-label">Commercial licence</p><p class="price price--small">On request</p><p>For organisations with more than three people using Himmel:CAD in production, and for hosted offerings to third parties.</p><a class="button button--cream" href="${commercial}">Ask about a commercial licence <span aria-hidden="true">→</span></a></article></div></section>
    <section class="section section--blue split"><div><h2>Who needs a commercial licence?</h2><p>Organisations with more than three people using Himmel:CAD in production, and anyone offering Himmel:CAD or a fork as a hosted service to third parties.</p></div><div><h2>Growing beyond three?</h2><p>You may continue the existing production use for 90 days while you obtain a commercial licence or end that use.</p></div></section>`,
  };
}

function licence() {
  return {
    path: '/licence/',
    title: 'Licence',
    description:
      'A plain-language summary of the Himmel:CAD Business Source License 1.1 and Additional Use Grant.',
    content: `${intro('Licence', 'Licence.', 'Source-available now; AGPL later. This is a plain-language summary of BSL 1.1 and the Additional Use Grant. The licence text controls if this summary differs.')}
    <section class="section prose"><h2>Free uses</h2><ul><li>Personal use by a natural person.</li><li>Evaluation, testing and development by anyone, at any organisation size.</li><li>Production use by an organisation with <strong>3 or fewer people</strong>, including paid work for its clients when the clients receive the results rather than access to the software.</li><li>Teaching, learning, coursework and non-commercial academic research at qualifying schools, universities and non-profit institutions.</li></ul><p>Headcount includes active owners and partners, directors, employees, trainees, interns and people who work predominantly for the organisation, across affiliates. Each person counts once. No registration or licence key is required for qualifying uses.</p><h2>Commercial licence</h2><p>An organisation with more than three people needs a commercial licence for production use. An organisation that grows beyond three has a 90-day grace period. Offering the software or a fork as a hosted service to third parties also needs a commercial licence.</p><h2>Source and change licence</h2><p>The source is available on request until downloads exist. Each version released under this licence changes automatically to AGPL-3.0-or-later four years after that version’s public release.</p><h2>Forks and contributions</h2><p>Copies, modifications and forks stay under the same licence. The licence grants no right to use the Himmel:CAD name or logo. Contributions require acceptance of the Contributor License Agreement; contributors keep their copyright.</p><div class="callout">For licence questions or commercial terms, email <a href="mailto:fernwork.absolute836@passmail.net">fernwork.absolute836@passmail.net</a>.</div></section>`,
  };
}

function download(ctx) {
  const { releases } = ctx;
  const products = [
    [
      'photolab',
      'PhotoLab',
      'Planned for Linux and Windows. The first release is intended to cover the complete offline workflow from import to products, with reports, cancellation and recovery.',
    ],
    [
      'builder',
      'Builder',
      'Planned for Linux and Windows after PhotoLab. The first public build will cover the completed point-cloud, terrain and shared project work available at that time.',
    ],
    [
      'cap',
      'Cap',
      'Planned for Android and iOS after device and field validation. The first release will capture and package checked field sessions for PhotoLab.',
    ],
    [
      'weltview',
      'WeltView',
      'Planned for current web browsers after project delivery and read-only loading are validated.',
    ],
  ];
  const cards = products
    .map(([key, name, copy]) => {
      const list = releases[key] || [];
      if (!list.length)
        return `<article class="download-card">${status('No public build yet', 'active')}${mark(ctx, key)}<h2>${name}</h2><p>${copy}</p><a class="text-link" href="${notify}">Ask for a release notification →</a></article>`;
      const release = list[0];
      const primary = release.files
        .map(
          (file) =>
            `<a class="button os-primary" data-os-primary="${escapeHtml(file.os)}" href="${escapeHtml(file.url)}" hidden>Download for ${escapeHtml(file.os)} <span aria-hidden="true">→</span></a>`,
        )
        .join('');
      const rows = release.files
        .map(
          (file) =>
            `<tr data-os="${escapeHtml(file.os)}"><td>${escapeHtml(file.os)}</td><td>${escapeHtml(file.arch)}</td><td>${escapeHtml(file.kind)}</td><td>${escapeHtml(file.size)}</td><td><code>${escapeHtml(file.sha256)}</code> <button class="copy" type="button" data-copy="${escapeHtml(file.sha256)}">Copy</button></td><td><a href="${escapeHtml(file.url)}">Download</a></td></tr>`,
        )
        .join('');
      const requirements = Object.entries(release.requirements || {})
        .map(
          ([label, value]) =>
            `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`,
        )
        .join('');
      return `<article class="download-card download-card--release">${status(`${release.channel} release`, 'works')}${mark(ctx, key)}<h2>${name} ${escapeHtml(release.version)}</h2><p>Published ${escapeHtml(release.date)}.</p>${primary}<div class="table-scroll"><table><thead><tr><th>OS</th><th>Architecture</th><th>File</th><th>Size</th><th>SHA-256</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>${requirements ? `<h3>System requirements</h3><ul>${requirements}</ul>` : ''}<h3>Verify the file</h3><p>Calculate its SHA-256 digest locally and compare every character with the value above. Verify the signature as described in the release notes when one is supplied.</p><h3>Release notes</h3><p>${escapeHtml(release.notes || 'No notes supplied.')}</p></article>`;
    })
    .join('');
  const notes = products
    .flatMap(([key, name]) =>
      (releases[key] || []).map(
        (release) =>
          `<article><h3>${name} ${escapeHtml(release.version)}</h3><p>${escapeHtml(release.date)} · ${escapeHtml(release.channel)}</p><p>${escapeHtml(release.notes || 'No notes supplied.')}</p></article>`,
      ),
    )
    .join('');
  const empty = Object.values(releases).every((list) => list.length === 0);
  return {
    path: '/download/',
    title: 'Download',
    description:
      'Himmel:CAD release status and future verified downloads. No public build exists yet.',
    content: `${intro('Download', 'Download.', empty ? 'There is no public download yet.' : 'Choose a release file for your system and verify its SHA-256 checksum.')}<section class="section"><div class="download-grid">${cards}</div></section>${notes ? `<section class="section" id="release-notes"><div class="section-heading"><p class="eyebrow">Release history</p><h2 class="display-title">Release notes.</h2></div><div class="feature-columns">${notes}</div></section>` : ''}`,
  };
}

function legal() {
  return {
    path: '/legal/',
    title: 'Legal notice (Impressum)',
    description: 'Legal notice and provider information for the Himmel:CAD website.',
    noIndex: true,
    content: `${intro('Legal', 'Legal notice.', 'Impressum — information pursuant to Section 5 of the German Digital Services Act (DDG).')}<section class="section prose"><h2>Provider</h2><address>Florian Fischer<br>Steig 4<br>88167 Grünenbach<br>Germany</address><h2>Contact</h2><p>Email: <a href="mailto:fernwork.absolute836@passmail.net">fernwork.absolute836@passmail.net</a></p><h2>Responsible for content</h2><p>Florian Fischer, address as above.</p></section>`,
  };
}

function privacy() {
  return {
    path: '/privacy/',
    title: 'Privacy',
    description:
      'Privacy information for the Himmel:CAD website: no tracking, cookies or third-party requests.',
    noIndex: true,
    content: `${intro('Privacy', 'Privacy.', 'No tracking and no cookies. This site makes no analytics or advertising requests and loads no third-party fonts, scripts or media.')}<section class="section prose"><h2>Controller</h2><address>Florian Fischer<br>Steig 4<br>88167 Grünenbach<br>Germany<br>Email: <a href="mailto:fernwork.absolute836@passmail.net">fernwork.absolute836@passmail.net</a></address><h2>Hosting</h2><p>The website is configured for Cloudflare hosting (Cloudflare, Inc., USA). Cloudflare participates in the EU–US Data Privacy Framework; Standard Contractual Clauses also apply.</p><h2>Server logs</h2><p>To deliver the pages, the host may process the IP address, requested URL, user agent and TLS metadata. The purpose is delivery, security and technical operation, not advertising or audience measurement. The legal basis is Art. 6(1)(f) GDPR: the legitimate interest in a secure, functioning website.</p><h2>Local offline storage</h2><p>A service worker can store public site files in the browser’s Cache Storage so pages remain available offline. This cache is local to the device, is limited to site files and is not intended to contain personal data. It can be removed through the browser’s site-data controls. The site does not use localStorage or sessionStorage.</p><h2>Email</h2><p>When you use an enquiry or notification link, your email application prepares a message to <a href="mailto:fernwork.absolute836@passmail.net">fernwork.absolute836@passmail.net</a>. Nothing is sent until you send it.</p><h2>Your rights</h2><p>Where personal data is processed, Articles 15–21 and 77 GDPR provide rights of access, rectification, erasure, restriction, portability, objection and complaint to a supervisory authority.</p></section>`,
  };
}

function offline() {
  return {
    path: '/offline/',
    title: 'Offline',
    description: 'Himmel:CAD website offline fallback.',
    noIndex: true,
    content: `${intro('Offline', 'Offline.', 'A saved copy of this page is available. Other pages will open if they have already been stored on this device.', button('/', 'Try the home page'))}`,
  };
}

function notFound() {
  return {
    path: '/404.html',
    title: 'Page not found',
    description: 'The requested Himmel:CAD page was not found.',
    noIndex: true,
    content: `${intro('404', 'Not found.', 'The address may be old or incomplete.', button('/', 'Go to the home page'))}`,
  };
}

export function createPages(ctx) {
  return [
    home(ctx),
    photolab(ctx),
    builder(ctx),
    capWeltview(ctx),
    roadmap(),
    pricing(),
    licence(),
    download(ctx),
    legal(),
    privacy(),
    offline(),
    notFound(),
  ];
}
