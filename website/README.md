# Himmel:CAD marketing site

Static HTML/CSS with no build step, tracking, cookies, remote fonts or client-side behaviour.

## Local preview

From `website/`:

```bash
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/`.

From the repository root, run the full quality gate with:

```bash
pnpm website:check
```

## Hero image

The Codex-generated `sky-hero.jpg` (brief: `.claude/codex/prompts/full/website-sky-image.md`; alternative `sky-hero-alt.jpg`) is present at 2880 × 1620 and active. If it is ever absent,
record **sky-hero.jpg fehlt** here and render the final hero layout against a flat `#0B2545`
fallback. Never replace it with a CSS gradient, drawn clouds or an unapproved generated image.

Owner prompt / requirement:

> Supply `website/assets/img/sky-hero.jpg` at 2880 × 1620. The image fills the complete first
> viewport with `background-size: cover` and `background-position: center`. It is imagery only:
> no logo, type, buttons or other interface elements in the JPEG. The CSS must keep the flat
> `#0B2545` fallback for any period in which the file is unavailable.

The image is excluded from the 300 KB page-weight gate, as requested. Fonts are also excluded.

## Design contract

- Lawn-inspired editorial composition: oversized Kamikaze wordmark, mono uppercase navigation,
  paper stickers, hard offset shadows and ruled grids.
- Palette: cream `#F3F0E6`, ink `#0A0A0A`, sky blue `#2E86FF`, fallback sky `#0B2545`.
- No gradients, rounded corners, soft shadows or animation.
- Kamikaze is limited to the wordmark and major display titles; all other text uses the system
  monospace stack.
- The owner-supplied logos remain byte-identical to the repository masters, although the landing
  page deliberately does not use a logo in its navigation.

## Legal and contact data

The legal pages name Florian Fischer, Steig 4, 88167 Grünenbach, Germany. The contact mailbox is
`fernwork.absolute836@passmail.net`. This mailbox is interim and should be replaced with the final
public address before launch.

The privacy text retains the existing Cloudflare Pages processing disclosure, Data Privacy
Framework wording, server-log purpose and legal basis. Cloudflare Web Analytics, Email
Obfuscation and optional bot cookies must remain disabled.

## Font licence

`Kamikaze.ttf` and `Kamikaze3DGradient.ttf` are Vladimir Nikolic’s Kamikaze family, already shipped
in `@himmelcad/theme`. The author describes the family as free for personal and commercial use.
The files are freeware display fonts, not OSI-licensed fonts; see `LICENSES/THIRD_PARTY.md` and the
repository font notes before redistribution changes.

## Gate table

Run `pnpm website:check` after every content or layout change. The latest recorded run is reflected
below.

| Gate | Result |
| --- | --- |
| Required files and master logo hashes | PASS |
| HTML validity | PASS |
| axe-core on home, Impressum and Datenschutz | PASS |
| Keyboard: skip link first, then all four primary navigation links | PASS |
| Contrast: normal text ≥ 4.5:1; large bold cream on sky blue ≥ 3:1 | PASS |
| Internal links and active assets | PASS |
| Page weight excluding fonts and hero image < 300 KB | PASS |
| Responsive layouts at 360, 768 and 1440 px without horizontal overflow | PASS |
| Full-viewport hero and image/fallback state | PASS — 2880 × 1620 owner image active |
| No gradients, border radius, soft shadows or animation | PASS |
| Owner-confirmed pricing, roadmap, licence and legal copy | PASS |

Screenshots from the latest visual verification live in `.check-out/` as `site-1440.png`,
`site-768.png` and `site-360.png`.

## Cloudflare Pages

`wrangler.jsonc` serves this folder directly. There is no build command.
