---
name: himmelcad-assembler
description: Design 3D-printable parts in HimmelCAD Assembler as an editable CAD history (sketches, extrudes, fillets, holes, parameters) through its MCP tools or Python SDK; render the result and check printability before declaring it done. Use when the user asks for a printable part, an enclosure, a bracket, a holder or a change to an .hcasm project.
---

# HimmelCAD Assembler

HimmelCAD Assembler is a CAD application for 3D-printable parts. Its agent
API (`hcasm.agent-api@1`) builds a normal, editable History — the user can
open the result in the app and change any sketch dimension, distance or
parameter. Never produce meshes for a part you design.

## Connect

Pick one (paths relative to a HimmelCAD checkout; build once with
`pnpm --filter @himmelcad/assembler build:headless`):

- **MCP server (recommended)** — the same tools the app's built-in
  assistant uses:
  - Claude Code: `claude mcp add hcasm -- node apps/assembler/bin/assembler-headless.mjs --mcp`
  - Codex (`~/.codex/config.toml`):
    `[mcp_servers.hcasm]` `command = "node"`
    `args = ["apps/assembler/bin/assembler-headless.mjs", "--mcp"]`
  - OpenCode (`opencode.json`):
    `"mcp": {"hcasm": {"type": "local", "command": ["node", "apps/assembler/bin/assembler-headless.mjs", "--mcp"]}}`

  Set `HCASM_MCP_SAVE_ON_EXIT=<file.hcasm>` to keep the project when the
  server stops, or save it yourself with `hcasm_call` and the method
  `project.save` (params `{"path": "part.hcasm"}`).

- **The running desktop app** — the user turns on File › Agent Access
  (Local) and gives you the connection JSON; use the Python SDK:
  `Document.connect_app('{"url": …, "token": …}')`.
- **Python SDK, no app** — `sdk/python`:
  `from himmelcad.assembler import Document; doc = Document.headless()`.

## Tools (MCP)

- `hcasm_call {method, params}` — one API method (`feature.create`,
  `sketch.setDimension`, `parameter.create`, `bodies.list`,
  `print.analyze`, `project.save`, …). Millimetres, Z up, build plate XY.
- `hcasm_methods` — the method index; `{method}`, `{kind}`, `{def}` for
  exact parameters. Look up before guessing.
- `view_render`, `view_inspect` — images of the model (named views or
  azimuth/elevation, isolate, highlight, section, printability overlay).
- `skills_list`, `skills_read` — the built-in workflows. Read
  `printable-part` before a new part and `api-quickstart` for the calls.

## Workflow

1. Read `skills_read printable-part`; follow its acceptance rules.
2. Build: sketch with `profiles` → `extrude` → details (shell, cut-outs,
   holes) → fillets and chamfers last. Use parameters for the sizes the
   user will change (`parametric-part`).
3. Look: `view_render` after the main shape and at the end.
4. Check: `print.analyze`; fix error findings (`fix-printability`).
5. Report sizes, assumptions, parameters and the printability result.

Rules: do not invent dimensions of real products you do not know — state
assumptions; read error `hint`/`details` and change the request instead of
repeating it; keep the user's existing work.
