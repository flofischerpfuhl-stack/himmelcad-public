# ADR 0024: Automation SDK and agent trust boundary

- Status: Accepted
- Date: 2026-07-19
- Depends on: ADR 0019

## Context

Python scripts and LLM harnesses need broad read and controlled write access to
HimmelCAD without becoming alternate project authorities. Geometry can be too
large for JSON, and third-party CLI harnesses have different process and
network behavior.

## Decision

HimmelCAD exposes a versioned, language-neutral automation protocol over the
same canonical queries, CAS revisions, commands and durable journal as product
UI. Python sync and async clients are generated from that contract. Queries are
paginated; large point, mesh, image and table data use bounded local bulk-data
leases with explicit type, shape, byte length, expiry and read/write policy.

Python runs out of process in a managed, pinned local environment. Network is
denied by default. Project, filesystem, process and optional network access are
separate explicit capabilities. Every write uses expected revisions and
journaled commands. Destructive or externally visible commands require user
approval; automation cannot bypass this by invoking a harness.

The agent-chat host discovers installed CLI harnesses such as Codex, Claude and
OpenCode and adapts their events into one UI contract. Harnesses never receive
direct canonical-store authority. A pinned, attributed T3 Code vendor slice may
provide adapters, normalized events, virtualized timeline rendering and scroll
anchoring. Generated SDK output is checked for staleness in relevant push and
release gates.

## Consequences

- UI, Python and agents share undo, replay, validation and conflict behavior.
- NumPy/OpenCV-style local work can use leased arrays without unbounded JSON
  copies.
- Capability grants and approvals are auditable and survive neither project nor
  process boundaries implicitly.
- Provider UI can evolve independently of the canonical automation protocol.
