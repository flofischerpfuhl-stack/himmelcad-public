# PL-I2 PhotoLab automation SDK and brokered-grant smoke evidence

Date: 2026-09-19  
Repository base: `875a87593ef259620b4bda13ed718d31c1adc95a` plus the uncommitted PL-I2 changes described here  
Machine: Linux 6.8.0-139-generic x86_64  
Runtime: Node 22.18.0, pnpm 9.12.0, Python 3.12.3

## Outcome

R22's SDK and smoke-harness gap is closed for the requested lightweight
PhotoLab sequence.

- The automation schema owns 72 PhotoLab-prefixed rows whose generated command
  metadata marks them `products: ["photolab"]` and `surfaces.automation: true`.
  The Python generator emits 72 public sync and 72 public async methods from
  those rows. Request and result annotations are generated schema models; no
  per-command Python implementation is handwritten.
- `BrokeredFilesystemGrantStore` binds grants to one live automation
  connection, canonical filesystem identity, and read/write scope. Raw path
  fields are rejected at the public boundary. Image inspection returns opaque
  per-image handles; only the host rehydrates them for the private commit RPC.
  Closing a connection revokes its filesystem grants.
- `scripts/smoke-photolab-automation.py` starts the automation host and the real
  PhotoLab sidecar, obtains host-issued grants, and drives project create →
  image inspect/commit → jobs list → image-quality start/cancel → project close
  through both generated clients. It also verifies that a missing grant becomes
  a typed `ProtocolError` with `permissionDenied`.
- The smoke generates eight 192×128 PNGs under
  `.build/codex-scratch/pl-i2/`, removes only its own run directory, and uses no
  repository dataset, display, COLMAP, ALIKED, or MVS path.

The exact sidecar used by the smoke was
`target/photolab/release/himmelcad-sidecar`, SHA-256
`f04cd0c70613c3149111acba0d34dc8c513dd8ce59a231c918cd6bb4ba3c60ee`.
The final schema SHA-256 was
`668f9f87ceeedf4f8476f0f187302233c49fe96f1c031b479120815d32e6290e`.

## Verification

| Gate | Result |
| --- | --- |
| `python3.12 -m unittest discover -s sdk/python/tests -v` | PASS — 16/16; includes sync/async typed PhotoLab methods, typed refusal, and SDK freshness |
| `pnpm --filter @himmelcad/app test` | PASS — 83/83; generated command-table freshness passed |
| `pnpm --filter @himmelcad/automation-host test` | PASS — 49 passed, 0 failed, 1 skipped; the existing real-Codex probe expects 0.144.5 and found 0.155.1 |
| `pnpm --filter @himmelcad/automation-host typecheck` | PASS |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS; English UI check passed |
| `CARGO_TARGET_DIR=target/photolab CARGO_BUILD_JOBS=4 pnpm --filter @himmelcad/photolab test` | PASS — renderer 88/88, Electron 10/10, processing-report contract passed, Cap import contract passed |
| `pnpm photolab:smoke:automation --mode sync` | PASS — 1.7 s, sampled host + sidecar RSS 74.7 MiB |
| `pnpm photolab:smoke:automation --mode async` | PASS — 1.7 s, sampled host + sidecar RSS 74.6 MiB |
| `pnpm photolab:smoke:automation` on the final hardened broker path | PASS — both clients in 3.6 s, sampled host + sidecar RSS 77.1 MiB |
| `python3.12 scripts/generate-automation-sdk.py --check` | PASS — current |
| `node scripts/generate-command-table.mjs --check` | PASS — current |
| `node scripts/check-photolab-english-ui.mjs` | PASS |

The PhotoLab test gate's first attempt failed only because the new G-1 assertion
included shared `view.*` rows in the PhotoLab-prefixed count. The assertion was
corrected to the specified `photolab.*` surface; the second and final exact-tree
attempts passed. Two initial pnpm smoke invocations passed a literal `--` to
`argparse` and exited before starting the host or sidecar; the corrected sync
and async invocations above are the executed smoke gates.

## Change surface and remaining boundary

The schema, command-table generator and outputs, Python generator and outputs,
automation router/grant lifecycle, SDK tests, PhotoLab G-1 coverage, package
script, implementation-plan status, and release acceptance status are covered.
The smoke exercises project replacement/drain, side-operation persistence,
job admission/cancellation, and clean close. It does not alter undo/redo or the
project format and adds no dependency.

WP-G2 remains partial outside PL-I2: `apps/photolab/renderer/src/App.tsx` still
contains the old hand-listed console dispatcher. Replacing that UI adapter with
generated command-table dispatch is intentionally not claimed by this R22
SDK/brokered-smoke package.
