# Building potreeconverter from source for win32-x64

This platform uses a curated source build because the upstream binary has an
unbundled runtime dependency. From the HimmelCAD repository root run:

```bash
pnpm photolab:build:potree:win
```

The script pins the upstream commit, applies audited portability changes,
checks the PE import closure and writes the vendor manifest deterministically.
