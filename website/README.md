# Himmel:CAD website

Production-oriented, English, multi-page static site for the Himmel:CAD product family. The generator uses Node 22 built-ins only. The public build makes no third-party request, sets no cookie and performs no tracking.

## Information architecture

| Route            | Purpose                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `/`              | Family overview, current release status, four products, licence essentials and routes to the deeper pages |
| `/photolab/`     | PhotoLab workflow, inputs/outputs, evidence and honest release-readiness summary                          |
| `/builder/`      | Current Builder functions, audited inventory totals, active programme and planned outcomes                |
| `/cap-weltview/` | Concise status and boundary for the two companion products                                                |
| `/roadmap/`      | R1–R4 outcomes without unsourced dates                                                                    |
| `/pricing/`      | Free eligibility and commercial licences on request (no prices set)                                       |
| `/licence/`      | Plain-language BSL 1.1 + Additional Use Grant summary                                                     |
| `/download/`     | Manifest-driven release files or the honest empty state                                                   |
| `/legal/`        | English legal notice (Impressum)                                                                          |
| `/privacy/`      | Privacy, hosting, logs, rights and local Cache Storage                                                    |
| `/offline/`      | Service-worker fallback                                                                                   |
| `/404.html`      | Not-found page                                                                                            |

Every published factual claim is mapped to repository evidence in [`CLAIMS.md`](CLAIMS.md). Capture requirements for the currently empty media slots are in [`MEDIA.md`](MEDIA.md).

## Build and preview

From the repository root:

```bash
node website/build.mjs
node website/serve.mjs
```

Open `http://127.0.0.1:8080/`. The watch build is `node website/build.mjs --watch`. The output is `website/dist/` and is ignored by Git.

`site.config.mjs` owns the site name, canonical origin, contact address, colours and product names. `siteUrl` is intentionally empty because the repository does not confirm the public domain. The build warns and omits canonical links, `og:url` and absolute sitemap entries until it is set.

## Source structure

- `build.mjs`: zero-dependency generator, asset hashing, PWA files, headers, redirects and sitemap
- `serve.mjs`: local clean-URL server with production-equivalent CSP and MIME types
- `src/pages.mjs`: page templates and public copy
- `src/layout.mjs`: shared document shell, navigation, footer and media renderer
- `src/assets/`: CSS, JavaScript, fonts, source images, icons and byte-identical owner logos
- `src/media/`: future product screenshots and videos
- `content/media.json`: media slots and capture instructions
- `content/releases.json`: live release manifest; intentionally empty
- `check.mjs`: build and production gate suite

## Media

Drop a correctly named file into `src/media/` and rebuild. A slot renders only when its file exists. Image slots use an optional same-basename WebP with the PNG fallback. Video slots use H.264 MP4, a poster, controls, muted in-view playback and reduced-motion suppression. Missing files remain absent from the HTML and are listed as build warnings.

See [`MEDIA.md`](MEDIA.md) for dimensions, datasets and exact shots.

## Release manifest

The live `content/releases.json` contains empty lists. Do not add a release until the files, hashes, requirements and notes are real. When a release exists, the download template exposes a detected-OS primary link while keeping every platform in the table without JavaScript. It includes file size, SHA-256 copy action, requirements, verification guidance and notes.

Complete example (documentation only):

```json
{
  "photolab": [
    {
      "version": "1.0.0-beta.1",
      "date": "2027-01-15",
      "channel": "beta",
      "notes": "First public beta. See the signed release record for known issues.",
      "files": [
        {
          "os": "windows",
          "arch": "x64",
          "kind": "msi",
          "url": "/releases/photolab-1.0.0-beta.1-x64.msi",
          "size": "842 MB",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "signature": "/releases/photolab-1.0.0-beta.1-x64.msi.sig"
        },
        {
          "os": "linux",
          "arch": "x64",
          "kind": "AppImage",
          "url": "/releases/photolab-1.0.0-beta.1-x86_64.AppImage",
          "size": "817 MB",
          "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        }
      ],
      "requirements": {
        "memory": "16 GB RAM",
        "storage": "20 GB plus project data",
        "gpu": "A supported graphics adapter"
      }
    }
  ],
  "builder": [],
  "cap": [],
  "weltview": []
}
```

## PWA and caching

The manifest includes 192, 512 and maskable PNG icons, an SVG icon and English app metadata. `sw.js` precaches all page shells, CSS, JavaScript, the display font and icons. Navigation uses network-first with `/offline/` as fallback. Local images and video use a 40-entry stale-while-revalidate cache. Activation removes caches from older builds.

Fingerprint assets receive one-year immutable caching. HTML, the manifest and the service worker receive `no-cache`. The generated `_headers` also applies the strict CSP and security headers.

## Quality gates

Run:

```bash
pnpm website:check
```

Latest result: **27/27 gates passed**.

| Gate                                                                                          | Result                           |
| --------------------------------------------------------------------------------------------- | -------------------------------- |
| Zero-dependency production build and 12-page set                                              | PASS                             |
| Byte-identical owner-logo SHA-256 values                                                      | PASS                             |
| `html-validate@9` on every generated page                                                     | PASS                             |
| Banned marketing phrase and no-CSS-gradient scan                                              | PASS                             |
| Unique titles/descriptions; internal links/assets                                             | PASS                             |
| Fingerprinted assets; each page under 150 KB excluding font, hero and media                   | PASS — largest 24.5 KB           |
| Manifest, declared icon sizes and 1200 × 630 OG image                                         | PASS                             |
| Security and caching headers                                                                  | PASS                             |
| Empty release manifest and honest download state                                              | PASS                             |
| axe-core WCAG 2.2 AA on every page                                                            | PASS                             |
| No horizontal overflow at 360, 768 or 1440 px                                                 | PASS                             |
| Display titles contain at most four short words; no display word splits; no heading overflows | PASS                             |
| Public copy excludes internal implementation terms                                            | PASS                             |
| No third-party requests                                                                       | PASS                             |
| Desktop and mobile screenshot for every page                                                  | PASS — 24 files in `.check-out/` |
| Skip link first, visible focus, reduced motion                                                | PASS                             |
| No CSP violations                                                                             | PASS                             |
| Service-worker install and offline reload of home and Builder                                 | PASS                             |

## Cloudflare configuration

`wrangler.jsonc` points static assets at `dist`. Configure the Cloudflare build working directory as `website/` and the build command as:

```text
node build.mjs
```

The output directory is `dist`. Deployment is intentionally not part of this work.

## Fonts and images

`Kamikaze.ttf` is Vladimir Nikolic’s Kamikaze display family already used by Himmel:CAD. It is freeware for personal and commercial use, not an OFL font, and has not been modified or subset. It is limited to the wordmark and major display titles. Body and interface copy use the local system monospace stack.

`sky-hero-2880.jpg` is the existing owner-selected hero. The 1440 JPEG and both WebP encodings are local responsive variants. The original owner logo SVG files remain byte-identical; the build fingerprints without changing their bytes. The 1200 × 630 social image combines the existing hero with the wordmark and current status.
