# S-03 gesture arbiter evidence — 2026-09-02

## Outcome

`@himmelcad/viewer/kernel` now exposes one `PlatformGestureArbiter`. Registering
gesture claims arms that tool and returns its idempotent release function. A
non-colliding second registration releases the previously armed tool with the
typed `superseded` reason; same-state row collisions are rejected. The kernel
navigation controller delegates clicks and keyboard rows to this arbiter while
retaining platform ownership of camera drags and wheel.

Builder supplies its existing selection callbacks and the landed
`registerEscapeRung` function through `KernelViewport`. The arbiter registers
only `tool` and `selection` rungs with that dispatcher and installs no Escape
listener. PhotoLab supplies no tool claims, so its viewer remains on the idle
path.

## §3.6 trace

| Platform row | Implementing code |
| --- | --- |
| LMB click | `PlatformGestureArbiter.ts:370-377`; exact release-position pick and click dispatch in `KernelNavigationController.ts:587-614` |
| LMB double-click on entity | reserved idle branch / claim dispatch at `PlatformGestureArbiter.ts:335-362` |
| LMB double-click on void or bare cloud | pickability-normalized clear/claim branch at `PlatformGestureArbiter.ts:352-362` |
| LMB drag | 4 px admission, reasoned claim admission, and unchanged off-handle orbit/plan-pan at `KernelNavigationController.ts:444-495` |
| Ctrl+LMB click | toggle callback at `PlatformGestureArbiter.ts:364-368` |
| RMB click | context-surface callback at `PlatformGestureArbiter.ts:322-328` |
| RMB drag | reasoned claim admission or unchanged pan at `KernelNavigationController.ts:469-495` |
| MMB drag / click | reasoned claim admission or unchanged pan in `KernelNavigationController.ts:469-495`; claimable/no-op click at `PlatformGestureArbiter.ts:329-333` |
| Wheel | reasoned claim admission or unchanged zoom at `KernelNavigationController.ts:528-550`; platform ownership validation at `PlatformGestureArbiter.ts:94-102,150-164` |
| Tab / Shift+Tab | ordinary traversal passes through when idle; armed construction-bar claim at `PlatformGestureArbiter.ts:240-254` |
| Up / Down | passes through without a live indicator; stable candidate callback only with `setCandidateIndicator(n, i)` at `PlatformGestureArbiter.ts:217-269` |
| Escape | selection rung at `PlatformGestureArbiter.ts:131-142`; armed-tool rung at `PlatformGestureArbiter.ts:183-202`; Builder injects the shared dispatcher at `BuilderKernelViewport.tsx:841` |
| Typing | registry callback by default; only a claim carrying `entryFocus: 'numeric' | 'text'` wins at `PlatformGestureArbiter.ts:271-279` |
| Touch tap / tap-again / tap-hold / double-tap | selection/toggle, context callback, and clear mappings at `PlatformGestureArbiter.ts:310-377` |

The claim registry, typed rejection, single armed owner, typed supersession,
and release lifecycle are at `PlatformGestureArbiter.ts:71-92,120-215,394-405`.
The §9.5 `Shared3DTarget` handle-origin LMB-drag deviation reason is declared
once at `PlatformGestureArbiter.ts:101-104`; all off-handle camera gestures stay
with the navigation controller.

## X6 tunables

All recognizer values live in `PLATFORM_GESTURE_TUNABLES`
(`PlatformGestureArbiter.ts:1-13`):

| Tunable | Value | Rationale |
| --- | ---: | --- |
| click/drag threshold | 4 px | absorbs normal press/release jitter while admitting orbit/pan at and above the threshold, matching UIP-D1 |
| double-click interval | 500 ms | browsers do not expose the OS interval; one conservative desktop/touch value avoids per-tool timing drift |
| touch-hold interval | 500 ms | provides the touch counterpart of RMB click from the same recognizer |

## Removed listener

The global recenter-on-Escape listener was removed from
`apps/builder/renderer/src/FloatingTaskIsland.tsx` (formerly lines 54-55 and its
add/remove listener calls). The remaining effect at current lines 52-58 handles
resize clamping only. Modal close handling remains separate pre-existing local
code; the S-03 arbiter itself registers Escape only through the UIP-D14 ladder.

## Tests and gates

`packages/@himmelcad/viewer/test/platform-gesture-arbiter.test.ts`:

- `G-B2-GESTURE-C1 coordinate tool keeps Tab on its bar and gates candidate cycling`
- `G-B2-GESTURE-C1 Escape cancels the tool rung before selection and clears next`
- `G-B2-GESTURE-C1 armed LMB void is claimed while idle void is inert`
- `gesture registry rejects unreasoned platform ownership and same-state collisions`
- `arming another non-colliding tool releases the first with a typed reason`
- `idle mouse and touch gestures preserve the platform selection and context map`
- `typing stays with registry shortcuts unless a tool declares entry focus`
- `Shared3DTarget can register its documented handle-drag deviation`

Camera regression: `camera orbit, pan and wheel remain platform-owned while a
tool is armed` in `kernel-navigation-controller.test.ts`.

Measured results from this worktree:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS; exit 0; PhotoLab English UI check passed |
| `pnpm --filter @himmelcad/viewer test` | PASS; 124 tests, 124 passed, 0 failed |
| `pnpm --filter @himmelcad/app test` | PASS; 15 tests, 15 passed, 0 failed |
| `pnpm --filter @himmelcad/builder typecheck` | PASS; exit 0 |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS; exit 0; PhotoLab English UI check passed |

The kernel public-surface checksum was reviewed and updated to include the new
arbiter API together with the Release 0.5 generated types already present in
this resumed worktree.

## Change surface and intentionally deferred work

Changed for S-03: the arbiter, navigation controller/session/React adapter and
kernel exports; Builder's existing selection callback bridge and shared Escape
registrar injection; the obsolete global recenter listener; focused unit and
camera regression tests; the stable public-surface gate.

No document commands, canonical persistence, undo history, automation schema,
Python SDK, formats, migrations, Rust, or dependencies changed. Real Draw and
Viewing Box tools are intentionally not registered here, per package scope;
they consume `navigation.gestures.registerGestureClaims(...)` in their later
tool slices. No GPU browser/Playwright visual run was performed; S-03 behavior
was verified in the deterministic DOM-event unit harness and the existing
navigation-controller harness. Context-surface presentation remains a host
callback; this slice does not add menu UI.
