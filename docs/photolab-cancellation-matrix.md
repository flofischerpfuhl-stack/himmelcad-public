# PhotoLab cancellation and resume matrix

The deterministic contract gate is:

```bash
pnpm photolab:test:e2e-contracts
```

It does not start a sidecar or a compute backend. It verifies the complete
stage vocabulary, acknowledgement and terminal latency enforcement, terminal
state validation, manifest/catalog/active-run publication invariants, exact
resume identity and rejection of changed job kind, configuration hash or input
hash.

## Real matrix to run after the product chain is idle

All commands below use 24 real Sulzberg images and independent output roots.
The cancellation result remains in `result.json`; incompatible-resume audits
are written below `attempts/` so they cannot destroy the reusable result.

```bash
SOURCE='photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos'
COMMON=(--source "$SOURCE" --max-images 24 --smoke --poll-ms 250 --max-cancel-ack-ms 2000 --max-cancel-terminal-ms 15000)

node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/aliked --profile fast --cancel-stage aliked --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/sift --profile qualityHybrid --cancel-stage sift --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/dedode --profile maximumRobustness --cancel-stage dedode --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mapper --profile qualityHybrid --cancel-stage mapper --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mvs --profile fast --products depth --cancel-stage mvs --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/raster --profile fast --products depth,dense,dem --cancel-stage raster --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mesh --profile fast --products depth,dense,dem,mesh --cancel-stage mesh --cancel-after-units 1
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/splat --profile fast --products splat --cancel-stage splat --cancel-after-units 1
```

Each command must finish successfully with:

- acknowledgement no slower than 2 seconds;
- terminal `cancelled` no slower than 15 seconds;
- no change to published product entities, product catalog or manifest
  `activeRuns`;
- a recorded immutable `{kind, configHash, inputHash}` identity;
- a committed terminal checkpoint before a resume test is attempted.

Resume every cancelled stage with the identical profile, scope and product
configuration:

```bash
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/aliked --profile fast --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/sift --profile qualityHybrid --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/dedode --profile maximumRobustness --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mapper --profile qualityHybrid --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mvs --profile fast --products depth --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/raster --profile fast --products depth,dense,dem --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mesh --profile fast --products depth,dense,dem,mesh --reuse --verify-resume
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/splat --profile fast --products splat --reuse --verify-resume
```

`--verify-resume` rejects a prior run without a terminal committed checkpoint
and requires exact kind, configuration hash and immutable input hash equality.

Before the compatible ALIKED resume, the following command proves that a
same-kind job with a changed configuration is explicitly rejected by the E2E
resume-identity gate and cancelled before compute is allowed to continue:

```bash
node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/aliked --profile qualityHybrid --reuse --expect-incompatible-checkpoint config
```

The deterministic unit contract separately exercises rejection for `kind`,
`configHash` and `inputHash`. A real matrix result is acceptable only if the
corresponding command report contains `rejected: true`, the mismatch field and
an atomically unchanged publication state.
