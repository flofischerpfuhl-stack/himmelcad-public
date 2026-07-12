# `vendor/` — Vendored Open-Source Components

Per `AGENTS.md` §1.6, the contents of this directory are **part of
HimmelCAD**. They originate from upstream open-source projects with
licenses compatible with our policy (`AGENTS.md` §1.3), but once
vendored we treat them like any other module in our tree: free to
modify, refactor, replace, or strip features as our roadmap demands.

This directory is distinct from `libs/`, which holds reference /
inspiration material that is **not** built into the product.

## Layout

```
vendor/
├── README.md                     ← this file
├── three-loader/                 ← @pnext/three-loader source snapshot
│   ├── LICENSE                   ← mirrored upstream license
│   ├── VENDOR.md                 ← upstream commit, modifications log
│   ├── package.json
│   └── src/
└── potreeconverter/              ← PotreeConverter binaries (gitignored)
    ├── LICENSE
    ├── VENDOR.md
    ├── linux-x64/
    │   └── PotreeConverter
    ├── win-x64/
    │   └── PotreeConverter.exe
    └── darwin-x64/               ← built from source by fetch script
        └── PotreeConverter
```

## How to populate

Source-vendored components (`three-loader/`) are committed to the repo.

Binary-vendored components (`potreeconverter/<platform>/`) are
downloaded by `pnpm install` via `scripts/fetch-vendor.mjs`. SHA-256
checksums are verified at fetch time; mismatches abort the install.

Manual fetch (e.g. CI cache priming):

```bash
node scripts/fetch-vendor.mjs
```

## Modifying vendored code

You may modify any file in `vendor/`. Document the change in the
component's `VENDOR.md` — list the upstream commit you forked from,
the diff summary, and whether the change is a candidate for an
upstream PR. This makes future re-syncs surgical instead of guesswork.

When upstream releases a fix you want, follow the recipe in the
component's `VENDOR.md` (typically: cherry-pick or full re-vendor +
re-apply local patches).
