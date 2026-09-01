# Himmel:CAD

Himmel:CAD is an offline-first family of CAD, photogrammetry, capture, and
spatial-viewing applications for construction and civil engineering.

- **Himmel:CAD Builder** is the flagship 3D-first Civil CAD with first-class 2D
  construction support.
- **Himmel:CAD PhotoLab** turns image captures into measurable spatial products
  and is prioritized as the first finished release.
- **Himmel:CAD Cap** captures mobile field sessions for PhotoLab.
- **Himmel:CAD WeltView** is the browser viewer for shared Himmel:CAD projects.

The family shares canonical entities and commands, a Rust/wgpu renderer,
provider-neutral IO, automation contracts, and one design system. Large data is
prepared ahead of interaction and streamed under bounded resource budgets.

## Start here

- [`AGENTS.md`](AGENTS.md) — short implementation principles for coding agents.
- [`docs/README.md`](docs/README.md) — documentation map and authority rules.
- [`docs/CURRENT-DIRECTION.md`](docs/CURRENT-DIRECTION.md) — current priorities,
  sequencing, and scope freezes.
- [`docs/PRODUCT-VISION.md`](docs/PRODUCT-VISION.md) — product family and
  long-term intent.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current system architecture.
- [`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md) — shared visual and
  interaction language.

## Development

```bash
pnpm install
pnpm verify:changed
```

Product entry points include `pnpm dev:builder`, `pnpm dev:photolab`, and
`pnpm dev:weltview`. See [`docs/TEST-TIERS.md`](docs/TEST-TIERS.md) for the
verification tiers.

## License

Himmel:CAD is source-available under the repository license. Commercial use or
distribution requires permission from the rights holder. Dependency rules are
defined in [`docs/DEPENDENCY-POLICY.md`](docs/DEPENDENCY-POLICY.md).
