# HimmelCAD Assembler — embedded assistant

Status: implemented 2026-10-02 (Block 9, agent stream, branch
`asm/b9-agent-20261002`). Serves owner intent **U5** ("as usable by agents
as possible") and [ROADMAP-LATER.md](ROADMAP-LATER.md) §2 ("describe the part,
get an editable model") and §2b items 1 and 5 (renders for agents, skills),
under the owner's rule that users bring their own Claude, Codex or OpenCode
subscription: the app runs the CLI the user installed and signed in to — no
AI cost for HimmelCAD, no purchased licence (U4). The contract the agent
works through is [AGENT-API.md](AGENT-API.md) (`hcasm.agent-api@1`).

## What the user sees

1. **Open** — left dock › Assistant, View › Assistant or command search
   ("assistant", "ai", "claude" …). No global shortcut (as Builder's plan).
   The island floats next to the Items column; hiding it never stops a
   running turn (the left-dock button then pulses).
2. **Choose a CLI** — the harness picker lists Codex, Claude and OpenCode
   with their state (found and version, not installed, incompatible);
   refresh looks again. Nothing is configured in the app: the CLI uses the
   user's own login.
3. **Sessions** — the session menu lists this project's conversations
   (newest first, "· interrupted" when the last turn did not finish);
   New session, double-click to rename, Delete. Sessions are saved with the
   project; reopening the project brings them back, and the next message
   continues the CLI's own conversation when this computer still has it.
4. **References** — "@ Add selection" (or the context-menu command
   **Mention in Assistant**) turns the selected bodies, faces, edges and
   steps into chips; on Send they resolve to their current ids (a deleted
   one is sent as "no longer exists", never rebound by name).
5. **A turn** — the timeline shows the agent's messages and each tool call
   as it runs (`hcasm_call · feature.create`, `view_render · iso`, with the
   result), render thumbnails under their call, and the model changes live
   in the viewport and History. Interrupt stops the CLI at once; Continue
   (or Retry) resumes an interrupted session.
6. **Approval** — before the agent deletes a step or parameter that existed
   before the turn, replaces the project (`project.new`/`open`) or undoes a
   change it did not make in this turn, the island shows "Destructive
   approval" with Approve / Deny (the island opens if hidden). Deny, or no
   answer within 5 minutes, refuses the call; the agent is told to continue
   without it.
7. **One undo step** — when the turn ends the transcript says
   "3 model changes · one undo step (Ctrl+Z)": one Ctrl+Z returns the model
   to the state before the turn, Redo brings it back. If the user edited the
   model while the turn ran, the steps stay separate and the note says so.
8. **Skills tab** — built-in workflows (read-only) and the project's own
   skills, searchable; New skill opens a SKILL.md editor with live
   validation (Save stays disabled until the file is valid).
9. **Web** — the browser cannot start programs, so the Assistant button is
   hidden and the command explains why (use the desktop app, or connect an
   external agent through Agent Access). Skills, `view.render` and the rest
   of the contract work in the web build too.

Screens: `D:\AgentWork\HimmelCAD-Assembler\shots\block9-agent\`
(`island-empty`, `island-session`, `island-approval`, `island-skills`,
`render-gpu`, `render-software`), produced by `test/electron/assistant.test.ts`.

## Architecture

```text
 renderer (interface/assistant)                    Electron main (electron/)
 ┌──────────────────────────────────┐   IPC       ┌──────────────────────────────────────┐
 │ AssistantIsland (AgentChatPanel) │ ──────────► │ assistantHost.ts: discover / open /  │
 │ controller.ts: sessions, turns,  │ ◄────────── │ sendTurn / interrupt; spawns the CLI │
 │  approvals, references, undo     │  events     │ per turn, stream-json → payloads     │
 │ tools.ts: MCP tools on the       │             │ assistantTools.ts: 127.0.0.1 /tool,  │
 │  AgentSession (hcasm.agent-api)  │ ◄────────── │  per-turn bearer token               │
 └──────────────────────────────────┘ tool calls  └──────────────────────────────────────┘
                 ▲                                         │ spawn (no shell)
                 │ one commit path, one undo stack         ▼
        store / kernel / viewport                user's CLI (claude / codex / opencode)
                                                           │ MCP stdio
                                                           ▼
                                        assistantMcpServer.js (Electron as Node) ── POST /tool
```

- **Tools are the contract.** The CLI sees six MCP tools (below); every call
  ends in `AgentSession.handle`, the same command layer as Agent Access,
  the headless CLI and Python: kernel validation, structured errors, normal
  History steps. The main process never interprets a call.
- **One undo step per turn.** The store gained `markHistory()` and
  `squashHistory(mark)` (`foundation/commands/store.ts`): the controller
  marks the undo stack when a turn starts, counts the agent's committed
  steps, watches for foreign feature/parameter changes, and merges the
  agent's steps into one when the turn ends. Refused (steps stay separate)
  if the user edited in between, undid past the mark, opened another
  document, or a sketch session owns the undo stack.
- **Headless.** `assembler-headless --mcp` serves the same tools over MCP
  stdio (`tools.ts` `handleMcpMessage`), for external CLIs and the
  benchmark; `HCASM_MCP_SAVE_ON_EXIT=<file>` saves the project when stdin
  closes.

### Shared with Builder, specific to Assembler

| Part                                                                                                                                         | Where                                                                                                                     | Shared?                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Harness drivers, frozen executable identity, normalized events, redaction, timeline, virtual list                                            | `packages/@himmelcad/agent`                                                                                               | Shared, used as is                                                                                                                                                                               |
| Chat panel                                                                                                                                   | `@himmelcad/agent` `AgentChatPanel`                                                                                       | Shared; Block 9 added optional props (title, className, header/composer accessories, session slot, scope labels, empty text, placeholder, row extra) — defaults render Builder's panel unchanged |
| Stream expansion (Claude `stream-json` content arrays, Codex `exec --json` items), host turn lifecycle for Claude/OpenCode, `resumeThreadId` | `@himmelcad/agent` `expand.ts`, `normalize.ts`, `drivers.ts`                                                              | Shared, additive (Builder's Claude and Codex exec output now render instead of being dropped)                                                                                                    |
| Desktop host (process spawning, sandbox)                                                                                                     | Builder: `@himmelcad/automation-host` (Linux bubblewrap, Builder sidecar router) · Assembler: `electron/assistantHost.ts` | Separate: Builder's host refuses non-Linux platforms and routes tools to Builder's sidecar protocol                                                                                              |
| Tools                                                                                                                                        | Assembler: MCP tools on `hcasm.agent-api@1`                                                                               | Assembler-specific (Builder: Python SDK in the sandbox)                                                                                                                                          |
| Sessions, approvals, references, undo grouping, skills                                                                                       | `apps/assembler/renderer/src/interface/assistant`                                                                         | Assembler subset of Builder's plan (`docs/builder-program/specs/agent/agent.md`)                                                                                                                 |

Builder's plan items adopted in this subset: on-demand skill discovery
with size caps (AG-D1), built-in and project scopes without shadowing
(AG-D2), product approvals the agent cannot answer (AG-D5), sanitized
project-owned transcripts with local resume bindings (AG-D6), hiding never
cancels (AG-D7), stable references resolved at send (AG-D8), harnesses as
peers (AG-D10), one presented turn = one undo step (AG-D14, as an undo
merge rather than a journal batch root). Not adopted (Builder-specific or
follow-up): journal actor metadata (AG-D20), immutable transcript chunks
(AG-D19 — Assembler stores one bounded array per session), path grants and
I/O passage (AG-D4/D16/D17 — the assistant has no file access), captured
selection sets (AG-D18), the one-shot Pick tool (AG-D11), generated help
documents (AG-D3).

## Trust model

| Rule                       | Implementation                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User's own subscription    | The CLI on `PATH` runs with the user's login and environment; the app stores no credential and calls no provider.                                                                                                                                                                                           |
| Tools only through the app | Claude: `--tools ""` (no built-in tools), `--allowedTools mcp__hcasm`, `--strict-mcp-config`, `--permission-mode dontAsk`. Codex: `exec -s read-only --ignore-user-config`, `approval_policy="never"`, the MCP server by `-c mcp_servers.hcasm.*`. OpenCode: every built-in tool denied, `hcasm_*` allowed. |
| No shell parsing           | Executables are spawned directly; npm `.cmd` shims are resolved to the `.exe` or Node script they start; the prompt goes to stdin.                                                                                                                                                                          |
| Private working folder     | `userData/assistant/threads/<thread>` per conversation, never the user's project folder.                                                                                                                                                                                                                    |
| Per-turn tool token        | 256-bit token issued when a turn starts, revoked when it ends; loopback only, no `Origin`, loopback `Host`, bounded bodies (`assistantTools.ts`).                                                                                                                                                           |
| App capabilities only      | The assistant's session has `document.read/write`, `view.write`; no file paths (exports come back inline).                                                                                                                                                                                                  |
| Destructive steps          | Approval in the island (above); the agent has no tool to answer it.                                                                                                                                                                                                                                         |
| Bounded                    | Output ≤ 32 MB per turn, 30 min per turn, tool results ≤ 48 KiB text, renders ≤ 2048 px, inspect ≤ 4 MP.                                                                                                                                                                                                    |
| Integrity                  | The CLI's file hash is checked before each turn ("changed since it was found").                                                                                                                                                                                                                             |
| Test stand-in              | `ASSEMBLER_ASSISTANT_TEST_HARNESS` (scripted harness) is honoured only in unpackaged builds.                                                                                                                                                                                                                |

## Tools (MCP)

| Tool                          | What it does                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hcasm_call {method, params}` | One `hcasm.agent-api@1` method; result JSON or `{code, message, hint, details}` with `isError`. `view.render`/`view.inspect` results also carry the images. |
| `hcasm_methods`               | Method index; `{method}`, `{kind}` (feature kinds) or `{def}` for exact schemas and the `$defs` they use.                                                   |
| `view_render`                 | `view.render`; the PNG as MCP image content (the model sees it) plus the JSON.                                                                              |
| `view_inspect`                | `view.inspect`; four images plus the manifest.                                                                                                              |
| `skills_list`, `skills_read`  | `skills.list`, `skills.read` (paged).                                                                                                                       |

The system prompt (`prompt.ts`, < 8 KiB) names the tools, the rules and the
project's name and size — nothing of the model is copied into it.

## Sessions and persistence

`.hcasm` gains two optional top-level fields (no schema bump):
`assistantSkills` (the project's SKILL.md texts) and `assistantSessions`
(per session: id, name, provider, the host's opaque thread id, timestamps,
idle/interrupted, up to 400 stored events: user and assistant messages,
tool calls with a 2 KiB result preview, approvals, errors, turn states).
Before storing, text passes the shared redactor (bearer tokens,
`key=secret` pairs); hidden reasoning, usage and images are never stored.
At most 30 sessions; older events give way with a visible "Earlier
messages were removed" marker. The mapping from the thread id to the CLI's
own session id lives in `userData/assistant/threads.json` on this computer
only, so a shared project never carries a provider session id.

## Skills

Files: closed frontmatter (`id`, `name`, `description`, `version`,
`scope`, `tags`) and a Markdown body (≤ 64 KiB). Built-ins live in
`assembler/agent-skills/builtin/<id>/SKILL.md` and are embedded by
`apps/assembler/scripts/generate-skills.mjs` (a test fails when the
generated file is stale; run prettier on the Markdown first):

- `printable-part` — request → defaults and assumptions → model → look →
  printability acceptance rules → report;
- `fix-printability` — each finding kind and its fix in the History;
- `parametric-part` — parameters, expressions, checking an edit;
- `api-quickstart` — the JSON calls a part needs (verified by the
  benchmark).

Discovery is on demand: `skills.list` (compact index, query, paging) and
`skills.read` (4 KiB pages by default, 16 KiB at most). Project skills
cannot reuse a built-in id. For tools outside the app:
`assembler/agent-skills/external/himmelcad-assembler/SKILL.md` (installable
skill for Claude Code, Codex and OpenCode: MCP server, app connection,
Python) and `assembler/agent-skills/external/CHAT-CONTEXT.md` (for chat
tools without a shell: they write a Python script the user runs; the
example script is verified).

## Benchmark

`apps/assembler/bench/assistant/`: `tasks.json` holds plain-language tasks
with acceptance checks (validity, bounding box, volume range, face count,
printability errors, named parameters, a parameter edit that must resize
the part, four renders); `run.mjs` gives each prompt to an agent CLI
driving `assembler-headless --mcp`, then checks the saved project in a
fresh headless process and writes `results.json` and the renders.

- **CI / automated**: `--provider scripted` replays `plans.json` through
  `scriptedHarness.mjs` (a stand-in that speaks Claude's `stream-json`;
  no provider is called). `test/api/assistantBench.test.ts` runs it in
  `pnpm test`.
- **Real CLIs, by hand only** (never in tests; it spends the user's
  subscription): `node apps/assembler/bench/assistant/run.mjs --provider
claude` or `--provider codex` after `build:headless`.

Scripted run 2026-10-02 (Windows host, indicative times):

| Task           | Prompt                                                         | Tool calls | Result                                                                                       | Time  |
| -------------- | -------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- | ----- |
| rpi5-enclosure | "Design an enclosure for a Raspberry Pi 5 with ventilation…"   | 22         | pass: 91 × 62 × 30 mm, 63 faces, 5 parameters, `board_l` 95 → 101 mm wide, no error findings | 4.4 s |
| wall-hook      | "Make a wall hook for a 20 mm towel bar with two screw holes." | 6          | pass: 30 × 20 × 60 mm, two holes                                                             | 3.1 s |

The scripted plans are a model of what an agent should call, not evidence
of model quality; the real-provider column of this table is open.

## Verification

- `@himmelcad/agent` tests (expansion, resume, existing suites) and
  Builder's agent-related tests.
- `test/assistant/assistant.test.ts` (controller on the real kernel with a
  fake harness: steps, one undo step, redaction, file round trip, resume,
  approvals, interrupt, references, MCP framing, skills),
  `test/viewport/softRender.test.ts`, `test/api/viewRender.test.ts`,
  `test/electron/assistantHost.test.ts` (scripted harness through the
  token endpoint and the MCP script), `test/api/assistantBench.test.ts`.
- `test/electron/assistant.test.ts` — production app, scripted harness,
  end to end (prompt → API calls → bodies → render → done → one Ctrl+Z).
- Python: `sdk/python/tests/test_assembler_view.py`.

CLI flags were checked against `claude --help` (Claude Code 2.1.283) and
`codex exec --help` (codex-cli 0.152.0) on the Windows host; no provider
was called. OpenCode is not installed there: its invocation follows
Builder's and is unverified.

## Limits and open items

- Real-provider runs (Claude, Codex, OpenCode) of the island and the
  benchmark are manual and not yet recorded; Codex `exec resume` with MCP
  config overrides and OpenCode's `--session` are unverified.
- No one-shot "Pick entity" tool (selection chips and the context-menu
  command instead); no captured sets for very large selections.
- Project skills and sessions are not part of undo (like Items names);
  deleting a session is immediate.
- The GPU render path draws the app theme's background and no axis triad;
  sections have no caps in either renderer.
- No model choice in the app (the CLI's default; Codex ignores the user's
  config file to keep the tool surface closed).
- The island's position is fixed (next to Items); no docking or resizing.
- Windows sandboxing beyond the tool restrictions (Builder's bubblewrap
  equivalent) is not implemented.
