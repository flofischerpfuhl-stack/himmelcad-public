# Himmel:CAD agent principles

Himmel:CAD is a family of applications primarily for construction and civil
engineering. Himmel:CAD Builder is the flagship: a 3D-first Civil CAD with
first-class 2D construction support. Himmel:CAD PhotoLab is the tactical first
release because it can become a finished product sooner. The products share the
canonical core, renderer, automation contracts, and visual language wherever
their domains allow it.

Before a non-trivial implementation, read `docs/CURRENT-DIRECTION.md` and use
`docs/README.md` to locate the authoritative document for the affected area.
Accepted ADRs override older plans and reports.

## Principles

- Correctness, data integrity, and security are non-negotiable. Within those
  boundaries: performance > intuitive UX > aesthetics.
- Import and preprocessing may be expensive; interaction after loading must be
  fast. Large data stays streamed, bounded, and incremental.
- Treat every change as a system change. Trace interactions, shared state,
  lifecycle, persistence, undo/redo, cancellation, and failure recovery. Decide
  explicitly which operations may run concurrently and which must be
  coordinated, serialized, or rejected.
- Trace the complete change surface before finishing: callers, consumers,
  sibling apps, shared packages, commands, context menus, automation protocol,
  Python SDK, formats, migrations, documentation, and tests. Report relevant
  follow-up work that is intentionally out of scope.
- Prefer shared core, renderer, command, and UI modules over app-specific
  implementations. Check whether sibling apps should reflect the same change.
- Product UI is English. Use the shared design system, tokens, typography,
  casing, and controls. Never ship unstyled browser, Electron, or platform
  defaults; preserve native semantics and accessibility beneath custom styling.
- Design the complete user flow: discovery, confirmation, cancellation,
  closing, recovery, and contextual access. Every user-facing capability needs
  a visible UI entry; entity-relevant commands should also be considered for
  context menus. Keep UI copy concise.
- Product capabilities and state-changing operations use canonical query and
  command contracts so UI, Python, and AI agents do not diverge.
- Work that is not effectively instant needs visible activity. Longer work
  reports meaningful progress and must be cancellable with bounded response
  time.
- Never invent coordinates, heights, CRS transformations, scale, or other
  domain truth. Source data remains authoritative until an explicit command
  changes it.
- Follow `docs/DEPENDENCY-POLICY.md` before adding dependencies or vendored
  code.
- Validate every implementation proportionally to its risk and report what was
  and was not verified.
- Apply active owner corrections from `docs/AGENT-FEEDBACK.md`. Keep this file
  short; detailed rules belong in their authoritative documents.

## Windows host (DESKTOP-BNB2PBA) — available to every agent

A Windows PC on the owner's Tailscale network is the project's Windows
build/test/measurement lane (owner decision 2026-09-08). Any agent on the Linux
laptop — Claude sessions, Codex runs, subagents — may and should use it when a
task needs one of: Windows-specific verification (packaging, installer, signing
paths, MSVC builds, path/CRLF/long-path behavior), GPU measurements of viewer
class W/D on a discrete GPU, compute above ~8 GB RAM or long end-to-end runs
(PhotoLab golden datasets), or anything that would contend with the laptop's
CPU/GPU/disk while other lanes run.

How: write a brief under `.claude/codex/prompts/remote/<name>.md` (same
discipline as any Codex brief: scope, gates, evidence file) and run
`.claude/codex/run-remote.sh <name> .claude/codex/prompts/remote/<name>.md`
(env `MODEL`, `EFFORT`, `RWORKDIR`; default `gpt-5.6-sol` high, working dir
`C:\Users\flori`; the repo clone lives at `C:\himmelcad` once bootstrapped).
This prompts the Codex CLI installed and authenticated on the Windows PC over
SSH (`ssh win-himmelcad`, key-only). Logs land in
`.claude/codex/out/remote-<name>.log/.exit`. Rules: agents do not run ad-hoc
commands on the host — they prompt the Windows Codex with a brief (owner
rule); the Windows clone is synced only through git (push here, pull there;
the final report comes back directly over the SSH channel into `.claude/codex/out/remote-<name>.last.md` — no commit on the Windows side is needed; only durable evidence files are committed, by the architect from the laptop); GUI
tests need the PC unlocked (ask the owner); state the host's load honestly in
any measurement. Details and the lane protocol: `docs/builder-program/COORDINATION.md`
"Windows host".
