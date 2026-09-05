# Performance measurements

Run the real Viewer Core baseline from the repository root:

```sh
node scripts/perf/viewer-baseline.mjs
```

Run the baseline alone on an idle machine. The default run converts the largest
real repository fixture (103,713,735-point LAS), launches Builder with its
existing Electron/CDP browser-GPU path, rejects software adapters, and writes
JSON plus Markdown to `.build/perf/viewer-baseline-<date>.*`. Its measurements
come from the kernel's exact 2,048-frame diagnostic ring: the declared present
source is `raf-render-complete`, input and workload belong to the same presented
frame, and asynchronous GPU timestamps are matched by sequence when the adapter
supports them. It does not describe rAF alone or an OS compositor timestamp as
displayed presentation.

Reuse prepared data with `--metadata <metadata.json>`, or measure another real
LAZ/LAS with `--dataset </absolute/path/to/cloud.laz>`. Use `--no-launch --cdp
http://127.0.0.1:9223` only when Builder is already running with
`window.__hcadBuilderKernel` available; as with the existing CDP benchmark, the
script closes that browser when capture ends.
