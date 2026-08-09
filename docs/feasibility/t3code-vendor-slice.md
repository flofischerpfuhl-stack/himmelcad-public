# T3 Code vendor-slice provenance and boundary

## Audited upstream

- Upstream: `https://github.com/pingdotgg/t3code`
- Audited release: `v0.0.24`
- Exact commit: `ea20e800216417c8d3b5dfc54a863bbd9e0b3e20`
- License: MIT, copyright 2026 T3 Tools Inc.
- Upstream `LICENSE` SHA-256:
  `935d8f2af0c703f9c39517ee57cc4930b19d02d533be930b63f0e82f93614b43`

The tag and commit are frozen inputs. HimmelCAD must not track `main` or copy
unattributed snippets from a moving checkout. Every retained upstream file is
listed in the slice manifest together with its original path and local
modifications.

## Retained design slices

### Virtualized timeline

The useful upstream boundary is small:

- `apps/web/src/components/chat/MessagesTimeline.logic.ts` provides stable row
  derivation and reference reuse so streaming activity does not re-render old
  turns.
- The list-owner portion of
  `apps/web/src/components/chat/MessagesTimeline.tsx` uses stable keys, an
  estimated row size, bottom anchoring, visible-content retention and explicit
  at-end state.
- Upstream uses `@legendapp/list@3.0.0-beta.44`. If retained, this dependency is
  pinned and audited separately rather than hidden inside copied code. The
  audited package declares MIT and has registry integrity
  `sha512-loGRve78NuZ5k8Z54ZSDNOtv3dVBM1SeBCRtm1EYtZiDIZ8SyMVcYpUGgFpGuNKk71+9/NuM9hvScrgf7+4E+A==`.

HimmelCAD keeps its own message rendering and design system. It ports the row
stability and scroll contract, not T3 Code's Tailwind markup, repository diff
UI, terminal-context UI or application state.

### Installed harness adapters

The relevant upstream architecture is the provider boundary, not the complete
T3 server:

- `apps/server/src/provider/ProviderDriver.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- the Codex, Claude and OpenCode driver/adapter implementations and their event
  normalization tests

HimmelCAD forks this as a narrow `AgentHarnessDriver` SPI with discovery,
capability probing, normalized events, turn interruption, approval forwarding
and process cleanup. It does not import the upstream Effect runtime,
orchestration database, worktree/VCS ownership, update manager, telemetry,
account inspection or provider settings store. Installed CLIs remain the
provider authorities and keep their own authenticated homes; HimmelCAD never
copies tokens into a project.

## HimmelCAD security boundary

- The managed Python environment has network access disabled by default.
- A selected LLM CLI is a separate, explicit harness process. Its provider
  network access does not grant the Python process network access.
- Harnesses receive an SDK endpoint and scoped capability token, never a
  canonical-store path or mutation handle.
- Canonical writes still use expected revisions and journaled commands.
- Destructive, process-spawning, filesystem-expanding and externally visible
  actions remain approval-gated in HimmelCAD even if a harness supports its own
  approval protocol.
- Discovery probes version/help output with time and output bounds; it never
  invokes login, update or credential-reading commands.

## Explicit exclusions

The vendor slice excludes T3 Code's project/worktree management, Git rollback,
terminal manager, telemetry and account identity readers, update installers,
remote server, persistence migrations, marketing assets and desktop packaging.
Those are outside the requested chat-and-harness scope and would create a
second project authority.

## Retained file inventory

The implementation is a narrow rewritten adaptation under
`packages/@himmelcad/agent`. Exact per-file mapping and modifications are in
`packages/@himmelcad/agent/vendor/t3code/VENDOR.md`; the unmodified upstream MIT
license is mirrored beside it. The retained upstream inputs are:

- `apps/server/src/provider/ProviderDriver.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Drivers/CodexDriver.ts`
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- `apps/server/src/provider/Drivers/OpenCodeDriver.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`

No upstream persistence, project, worktree, Git, account, update, telemetry,
remote or terminal-management source is retained. The UI uses a HimmelCAD-owned
virtual list and design tokens; `@legendapp/list` is not incorporated.
