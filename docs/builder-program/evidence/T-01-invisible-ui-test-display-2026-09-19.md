# T-01 — invisible Linux UI test display — 2026-09-19

Status: **COMPLETE. Builder self-test and the 103,713,735-point V-01 orbit run
used a private Xvfb display; NVIDIA hardware WebGL2, the renderer chip, HUD,
CDP screenshot, timeout cleanup, and zero owned `DISPLAY=:0` processes are
proved. The private-display orbit is materially slower than the real-display
V-07 result and is recorded as such.**

## Implementation

`scripts/ui-test-display.sh` creates an authenticated 1920×1080×24 Xvfb server
on the first free display at or above `:90`. It removes the caller's `DISPLAY`
and `XAUTHORITY` before doing any work and supplies the private values only to
the owned app scope. Every attempt uses the exact isolated profile
`.build/ui-test-display/<run>/profile`, a free CDP port, and one user systemd
scope with `MemoryMax=${UI_TEST_MEM:-12G}`, `MemorySwapMax=0`,
`CPUQuota=400%`, and `--nice=10`. The launcher traps exit, signals, and its
overall timeout, stops the scope, and then stops Xvfb.

Systemd 255 on this laptop rejects `LimitCORE=0` on a scope unit with
`Unknown assignment: LimitCORE=0`; that property is valid for a transient
service but not a scope. The script attempts the requested property, retains
the rejection in `systemd-limit-core-check.log`, and enforces the same process
limit with `ulimit -c 0` inside the scope. It does not silently run with core
dumps enabled.

The backend order is:

1. ANGLE/Vulkan with Chromium Vulkan enabled, as requested;
2. the V-01c proven NVIDIA ANGLE/Vulkan WebGL2 variant, still part of the first
   Vulkan rung but without Chromium's Vulkan compositor;
3. NVIDIA EGL PRIME using
   `/usr/share/glvnd/egl_vendor.d/10_nvidia.json`;
4. labelled ANGLE SwiftShader software rendering.

The full-Vulkan rung enumerates the Quadro and can draw the empty project, but
V-01c already proved its WebGPU surface unsustainable. This run reproduced the
problem under the 104 M-point load: Chromium lost the GPU process after repeated
shared-image texture failures. The launcher therefore does not call that a
usable result merely because enumeration succeeded. The selected second
variant uses an explicit test-only viewer backend environment setting; ordinary
development and production retain `automatic`. Builder and PhotoLab both honor
that setting so the wrapper has the same backend contract for either product.

`scripts/run-electron.mjs` accepts a validated JSON array of extra Electron
switches from the launcher. The probe connects through CDP, records
`SystemInfo.getInfo` plus the app kernel diagnostics, opens Builder's HUD on the
private display, checks the renderer chip/HUD against the kernel backend, and
uses `Page.captureScreenshot` for PNG output. It rejects CPU, SwiftShader,
llvmpipe, and unknown adapters as hardware.

Documentation in `docs/TEST-TIERS.md` now defines this lane. The two active
implementation/review briefs say: use `scripts/ui-test-display.sh`;
`DISPLAY=:0` is forbidden.

## Self-test

Command:

```sh
scripts/ui-test-display.sh builder \
  --screenshot .build/ui-test-display/selftest.png \
  --ready-file .build/ui-test-display/selftest.env \
  --exit-after-probe --timeout 300
```

Result: **PASS**. The first full-Vulkan attempt was rejected because the viewer
reported WebGPU rather than the proven WebGL2 path. The next Vulkan attempt was
accepted on `:90` and CDP `http://127.0.0.1:9223`:

- `SystemInfo.getInfo`: vendor `0x10de`, device `0x1436`, NVIDIA driver
  `580.173.2.0`, `displayType=ANGLE_VULKAN`,
  `glImplementationParts=(gl=egl-angle,angle=vulkan)`;
- Chromium GL renderer: `ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA Quadro M2200
(0x00001436)), NVIDIA-580.173.2.0)`;
- kernel: `rendererBackend=webgl2`, capability backend `webGl2`, adapter
  `ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA Quadro M2200 (0x00001436)), NVIDIA)`;
- Builder bottom-bar chip: **Hardware rendering**;
- Builder HUD: **backend webgl2**.

The 1480×920 CDP screenshot is `.build/ui-test-display/selftest.png`. It shows
the opened `builder-default` project, zero clouds, the hardware chip, and the
WebGL2 HUD; nothing was imported.

The run's `process-displays.txt` walks the owned scope's cgroup without opening
an X connection. Every launcher/dev process has `DISPLAY=:90`; sandboxed
Electron subprocesses have the variable removed. No owned process has `:0`.
The requested `xwininfo`/`xdotool` check against `:0` was deliberately not run,
because the package's final owner rule says this agent must not touch
`DISPLAY=:0` in this run. The cgroup/environment proof establishes the same
isolation without connecting to the owner's X server.

After exit, `hcad-ui-*.scope`, Xvfb `:90`, Builder Electron, Vite, sidecar, and
the CDP listener were all absent. A separate one-second timeout test returned
124 with `UI test timeout reached before vulkan probing; cleaning up`, followed
by the same zero-leftover checks. A separate SIGINT startup test also left no
scope, Xvfb, Electron, Vite, sidecar, or CDP listener.

## Real-data frame sample

The source is the prepared Potree representation of the repository road scan:
103,713,735 points, identity
`ff05d6cffc614424f835a84871bca67bebfb11954c72164d36ab20b5281bd05a`.
The complete five-repetition V-01 command was:

```sh
node scripts/perf/viewer-baseline.mjs --no-launch \
  --cdp http://127.0.0.1:9223 \
  --metadata .build/perf/viewer-baseline-datasets/PW_GHT_251215_Orscholz_Deponie-1-1-ff05d6cffc61/metadata.json \
  --date 2026-09-19-t01-private-display
```

The report is complete, hardware-backed NVIDIA WebGL2, Class I, with
`raf-render-complete` as the present source. At measurement start the host had
25 GiB available, zero swap in use, load `2.49 / 1.98 / 1.80`, and the Quadro
was at 0% with 168 MiB allocated.

| Route             | Orbit p50 | Orbit p95 |          Delta p50 |          Delta p95 |
| ----------------- | --------: | --------: | -----------------: | -----------------: |
| V-07 real display |   17.4 ms |   19.1 ms |                  — |                  — |
| T-01 private Xvfb |   38.2 ms |   42.5 ms | +20.8 ms (+119.5%) | +23.4 ms (+122.5%) |

The five private-display orbit p95 values were 42.4, 42.5, 41.0, 46.5, and
44.3 ms; each run retained 176 samples. Against the owner's broader 19–21 ms
real-display range, private-display p95 is 21.5–23.4 ms slower (2.02–2.23×).
This is proof that the private display presents through hardware, not a claim
of performance parity. Artifacts:
`.build/perf/viewer-baseline-2026-09-19-t01-private-display.{json,md}`.

Two earlier reports named `2026-09-19-t01-xvfb*` are blocked diagnostics from
the discarded full-Vulkan path (disposed-session startup race, then duplicate
dataset registration); they contain no accepted timing result.

## Verification

| Check                                         | Result                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `bash -n scripts/ui-test-display.sh`          | PASS                                                                    |
| `node --check scripts/run-electron.mjs`       | PASS                                                                    |
| `pnpm --filter @himmelcad/builder typecheck`  | PASS                                                                    |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS; English UI check passed                                           |
| final Builder private-display self-test       | PASS; hardware WebGL2, chip/HUD, CDP PNG, default project, zero imports |
| cgroup display audit                          | PASS; all display-bearing owned processes use `:90`, none use `:0`      |
| timeout cleanup test                          | PASS; exit 124 and zero leftover owned processes/listeners              |
| SIGINT cleanup test                           | PASS; one interrupt and zero leftover owned processes/listeners         |
| V-01 five-run real-data baseline              | PASS as a complete measurement; 42.5 ms orbit p95 is slower than V-07   |
| `git diff --check`                            | PASS                                                                    |

PhotoLab was typechecked but not launched through Xvfb in this package; Builder
is the required literal self-test. The EGL and software rungs were not reached
in the final run because NVIDIA ANGLE/Vulkan WebGL2 succeeded. `shellcheck` is
not installed, so the shell gate was `bash -n` plus the literal success,
timeout, and signal runs. No repository or dataset was copied, no `DISPLAY=:0`
connection or input was used, and no commit was created.
