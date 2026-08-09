# T3 Code adapted slice

- Upstream: https://github.com/pingdotgg/t3code
- Release: `v0.0.24`
- Commit: `ea20e800216417c8d3b5dfc54a863bbd9e0b3e20`
- License: MIT, copyright 2026 T3 Tools Inc.
- Upstream license SHA-256: `935d8f2af0c703f9c39517ee57cc4930b19d02d533be930b63f0e82f93614b43`

This is a narrow, rewritten TypeScript adaptation. It does not retain T3 Code's
Effect runtime, database, project/worktree/Git authority, account inspection,
updates, telemetry, remotes, persistence, terminal manager or application UI.

| Upstream file | HimmelCAD file | Modification |
| --- | --- | --- |
| `apps/server/src/provider/ProviderDriver.ts` | `src/vendor/t3code/providerShape.ts` | Plain driver SPI retained; Effect services, settings, project and registry authority removed. |
| `apps/server/src/provider/Services/ProviderAdapter.ts` | `src/vendor/t3code/providerShape.ts` | Session/turn/interrupt/approval shape rewritten around the abstract desktop HostTransport. |
| `apps/server/src/provider/Drivers/CodexDriver.ts` | `src/drivers.ts` | Rewritten as deterministic read-only discovery plus frozen executable identity. |
| `apps/server/src/provider/Drivers/ClaudeDriver.ts` | `src/drivers.ts` | Rewritten; account/update/home inspection excluded and absence is normal. |
| `apps/server/src/provider/Drivers/OpenCodeDriver.ts` | `src/drivers.ts` | Rewritten; server ownership/update logic excluded and absence is normal. |
| `apps/server/src/provider/Layers/CodexAdapter.ts` | `src/drivers.ts`, `src/normalize.ts` | Only app-server handshake, exec-json fallback and normalized event concepts retained. |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | `src/normalize.ts` | Only bounded provider-event normalization retained. |
| `apps/server/src/provider/Layers/OpenCodeAdapter.ts` | `src/normalize.ts` | Only bounded provider-event normalization retained. |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | `src/vendor/t3code/stableRows.ts`, `src/timeline.ts` | Stable keyed row derivation/reference reuse generalized to HimmelCAD events. |
| `apps/web/src/components/chat/MessagesTimeline.tsx` | `src/VirtualAgentTimeline.tsx`, `src/virtualization.ts` | List-owner anchoring contract rewritten without Tailwind, repository UI or upstream state. |

No other upstream file is incorporated.
