# Agent — embedded AI assistant domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2 and doctrine P11. Document class: plan. Resolution: **workflow level** for the Agent
workspace, session persistence, skill authoring, entity references, the “restore the last viewing box” workflow, and automation I/O grants;
**contract level** for the remaining catalog rows. This document walks `docs/FUNCTION-CONTRACT.md` (CURRENT version) in full and was
re-walked against its principal-level trust, gesture-arbitration, and extreme-member rules and against
`docs/DECISION-DOCTRINE.md` X1–X7/P1–P11. Its §1 rows are present in the rebuilt
registry and no open registry finding names this spec.

Foundation: X3 (Agent parity) and accepted ADR 0024. Inputs: `docs/builder-program/REGISTRY.md` §§4–5, owner decisions D1–D5,
`docs/DESIGN-SYSTEM.md`, ADR 0024, `specs/ui-platform/ui-platform.md` (especially §3.6 and UIP-D10/UIP-D14), `specs/view/viewing-box.md`,
`specs/import-formats/import-formats.md` IF-D12/IF-D13, the four dossiers, and the current implementation cited throughout. The automation
protocol remains shared infrastructure: this spec adds methods and capability metadata to its existing versioned schema; it does not create
a second protocol or command authority (ADR 0024; `schemas/automation/himmelcad-automation-v1.schema.json:33–45`).

E1 reference artifact: §8 of this file. Its in-repo written criteria are concrete enough to fail against screenshots and scripted state
samples; no third-party screenshot is required.

## 0. Ownership and registered obligations

This domain owns the embedded assistant’s workspace, sessions, harness selection, normalized conversation, skills, documentation discovery,
entity mentions, and the user-facing trust handoff. Core CAD acts remain owned by their domain specs. In particular, `viewing_box.*` belongs
to the viewing-box spec, and public import automation is `io.probe`, `io.import`, and IF-D20's generated
`io.import.product_dataset.list/register` specializations under import-formats IF-D12/IF-D20. Low-level
`io.import.execute` and every `registration.*` route remain app-private and capability negotiation rejects them for Agent and generated
Python. This spec owns only safe passage through the ADR 0024 automation boundary; it does not re-disposition either function family.

Obligations inherited from `REGISTRY.md` §1.12 are all claimed:

- Agent turns register as platform jobs under UIP-D10 and survive island hide.
- Agent is a persistent workspace island: UIP-D14 excludes it from Escape rung 6, and free-text Escape never discards the prompt.
- Project close/replacement revokes harness sessions, path grants, cursors, leases, and approvals; resumable transcript data remains
  project-owned.
- Agent-runnable gate conventions are supplied in §7, including a deterministic scripted-harness end-to-end gate.

Registry §4 findings checked for this domain: no global Agent shortcut is claimed, so F9/F11 do not gain another collision; command leaves
use the schema-verified dotted lower-case/`snake_case` convention and F8 is closed; this spec contributes one armed tool
(entity-reference pick) and reconciles it against ui-platform §3.6 in §3.1 E2; all Agent turns and long I/O operations cite UIP-D10,
closing F7 for this domain. Agent does not take ownership of measurement, transforms, Civil/registration stations, or clipboard capabilities
owned or explicitly deferred by their domain specs. The catalog below is registered and the
duplicate/surface/gesture/state checks pass in the 2026-09-02 rebuild.

## 1. Function catalog (registry rows)

Access: R ribbon · X entity context menu · C console · A automation (Agent harness and generated Python SDK) · K keyboard. Perf: cont =
continuous, bnd = bounded (<1 s), long = long-running. “Missing” includes placeholder-only surfaces, per the function contract. For the
approval row, A reaches observation only; confirmation/denial is a trusted product-UI act absent from automation by construction (X3,
Function Contract B1, AG-D5).

| Id                   | Tab · group             | Access                                                                                                                | Surface                                                  | Perf                                      | Automation                                                  | Spec link                       | Status                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.workspace`    | File · Agent            | R (pure toggle), C `agent`, A                                                                                         | persistent resizable workspace island                    | bnd open/hide                             | `agent.workspace.open/close/state`                          | §2.4; AG-D7                     | partial — ribbon entry and island exist (`apps/builder/renderer/src/ribbon.ts:35–49`, `apps/builder/renderer/src/App.tsx:446–449,854–860`), but close unmounts the chat                                                                                                           |
| `agent.session`      | Agent · Sessions        | island list, C, A                                                                                                     | island sidebar + transcript                              | bnd; resume may become long               | `agent.session.create/list/open/rename/delete`              | §2.4; AG-D6/AG-D19              | missing — thread/events are renderer refs/state only (`packages/@himmelcad/agent/src/ManagedAgentChat.tsx:29–38`)                                                                                                                                                                 |
| `agent.turn`         | Agent · Chat            | composer, C, A, K Ctrl/Cmd+Enter                                                                                      | transcript + composer; platform job while running        | long                                      | `agent.turn.send/interrupt/resume/status`                   | §§2.1, 2.4; AG-D7/AG-D14        | partial — send/interrupt/resume exist (`packages/@himmelcad/agent/src/ManagedAgentChat.tsx:175–207,247–275`), but no job registration, batch root, or restart resume                                                                                                              |
| `agent.reference`    | Agent · Chat            | composer **Pick entity**; X **Mention in Agent**; **Mention selection**; C; A                                         | inline token, captured-set token, one-shot viewport pick | cont pick hover; bnd capture/page/resolve | `agent.reference.add/remove/resolve/capture_selection/page` | §2.5; AG-D8/AG-D18              | missing — composer and message rows are plain text (`packages/@himmelcad/agent/src/AgentChatPanel.tsx:211–234,257–265`)                                                                                                                                                           |
| `agent.approval`     | Agent · Activity        | automatic request; trusted foreground transcript/modal Confirm/Deny; A observes only                                  | alert dialog + timeline card                             | bnd                                       | `agent.approval.list/get` (no response method)              | §3.1 B1, §3.3 B1; AG-D5/AG-D16  | partial — product modal and harness cards exist (`packages/@himmelcad/agent/src/ManagedAutomationApproval.tsx:12–65`, `packages/@himmelcad/agent/src/AgentChatPanel.tsx:186–210`), but are separate queues and current renderer IPC is not yet bound to the full request identity |
| `agent.skills`       | Agent · Skills          | island tab, C, A                                                                                                      | searchable list / read view                              | bnd, paginated                            | `skills.page/read/search`                                   | §2.2; AG-D1/AG-D2               | missing — `/workspace/SKILLS.md` is four hard-coded bullets (`packages/@himmelcad/automation-host/electron.cjs:383–395`)                                                                                                                                                          |
| `agent.skill-author` | Agent · Skills          | New/Edit/Import in Skills tab, C, A                                                                                   | full-height Markdown editor + validation preview         | cont typing; bnd save                     | `skills.create/update/delete/import`                        | §2.2; AG-D2                     | missing — the package exports no skill model/editor (`packages/@himmelcad/agent/src/index.ts:1–16`)                                                                                                                                                                               |
| `agent.help`         | Agent · Help            | island header/tab, C `help`, A                                                                                        | search field, result list, bounded document reader       | bnd, paginated                            | `help.search/open`                                          | §2.2.2; AG-D1/AG-D3             | missing — `SDK.md` is static and the schema exposes no help methods (`packages/@himmelcad/automation-host/electron.cjs:371–382`; `schemas/automation/himmelcad-automation-v1.schema.json:79–143`)                                                                                 |
| `agent.providers`    | File · Settings · Agent | settings page; session picker; C status; A list/status/select only                                                    | settings page + compact picker                           | bnd discovery                             | `agent.providers.list/status/select`                        | §2.4; AG-D10                    | partial — three harnesses are discovered (`packages/@himmelcad/agent/src/drivers.ts:24–43`), but credential type/UI is Codex-only (`packages/@himmelcad/agent/src/providerCredentials.ts:1`; `packages/@himmelcad/agent/src/ProviderCredentialControl.tsx:16–19`)                 |
| `agent.path-grants`  | Agent · Permissions     | passive inline request card; trusted foreground picker click; Settings · Agent · Active grants; A request/list/revoke | passive card → OS picker; grants list                    | bnd                                       | `automation.grants.request/list/revoke`                     | §2.3, §3.3; AG-D4/AG-D16/AG-D17 | missing — harness workspace is read-only and router allowlist has no I/O methods (`packages/@himmelcad/automation-host/index.cjs:79–101,182–185,701–724`)                                                                                                                         |

No global Agent shortcut is assigned. The visible File button, console command, and persistent island already make the workspace
discoverable; Ctrl/Cmd+Enter is scoped to the focused composer and exists today (`AgentChatPanel.tsx:83–92,227–233`).

## 2. Full user-perspective workflow narratives

### 2.1 “Restore the last viewing box”

Before closing the project, the surveyor explicitly deactivated all viewing boxes to inspect the full model. Reopening therefore restores
that exact deactivated state, as viewing-box §1.4 and file-project §1.2 require; the full model is not evidence that reopen forgot an active
box. They open **Agent** from File and type “Restore the last viewing box.” The island keeps the prompt and starts a named platform job,
“Agent · Restore the last viewing box”; the jobs chip appears only after UIP-D10’s debounce. The transcript immediately shows that the Agent
is looking up product instructions, not silently guessing.

The built-in artifact is exactly `skills/builtin/restore-last-viewing-box/SKILL.md`. Its sole responsibility is to map this intent to the
bounded list query and owning activation command; it contains no domain manual, journal-scanning recipe, or unrelated view advice. The
bootstrap reads the compact `/workspace/SKILLS.md` index, makes at most one
`help.search({query: "restore viewing box", limit: 1, max_excerpt_bytes: 512})` call, then one
`skills.read({id: "restore-last-viewing-box", max_bytes: 4096})` call. It does not call `help.open` for this workflow because the skill
contains the exact bounded signature. The next call is
`viewing_box.list({order: "last_activated_generation_desc", limit: 1, state: "surviving"})`: deleted boxes and boxes never activated are
excluded; the journal generation is unique per activation, with stable entity-id ascending as the defensive tie-breaker for migrated data.
The result contains only id, name, expected revision, active/locked state, and `last_activated_generation`. No journal page is read.

The entire injected support context for this workflow—five-line bootstrap, `SKILLS.md`, the one help excerpt, the one skill body, and any
generated command signature—is capped at both 12 KiB UTF-8 and 3,072 measured model-input tokens. Each individual skill body is capped at
4 KiB and 1,024 measured tokens; `/workspace/SKILLS.md` and `/workspace/SDK.md` are each capped at 4 KiB. The generator and runtime host fail
closed with `contextBudgetExceeded` before injection if either byte or token ceiling is exceeded. These X6 values are tunable, but an
unbounded fallback is forbidden (AG-D1/AG-D12).

If “Stairwell B” is the result, the Agent previews one activity row: “Activate viewing box · Stairwell B.” Activation is journaled,
reversible, and neither destructive nor externally visible, so no approval dialog appears. The host validates expected revisions and calls
the exact owning command `viewing_box.activate({id, expected_revision})` from viewing-box §1.4/B1 (canonical entity/commit semantics:
VB-D1/VB-D2). If a concurrent edit changed the box, the command fails before mutation; the Agent
re-queries once and either applies the current revision or explains the conflict. If a viewport tool or drag is active, activation is
rejected as `interactionBusy` because changing the P4 visible set underneath a construction would change its meaning; the Agent asks the
user to finish or cancel the tool.

On success the viewport clips immediately, the viewing-box chip shows “Stairwell B,” the entity tree still contains the box, the Agent
timeline marks the command completed, and the console adds an attributed line: “Agent · Site review · activated viewing box ‘Stairwell B’.”
The journal entry carries the Agent session and turn actor ids. The Agent answers “Restored Stairwell B.” Ctrl+Z deactivates it exactly like
a UI activation. If no saved box survives, the Agent says so and changes nothing; it never invents geometry.

### 2.2 Authoring a project skill

The BIM coordinator opens Agent ▸ **Skills** and presses **New project skill**. The island changes to a full-height split editor: Markdown
on the left, rendered preview and validation on the right. A concise starter appears:

```markdown
---
id: check-storey-deliverable
name: Check storey deliverable
description: Inspect visible storey entities before export.
version: 1
scope: project
applies_to: [bim, export]
requires: [document.read, view.read]
---

Use help.search before choosing commands. Inspect the visible set and report missing information; never invent coordinates, CRS, or heights.
```

The coordinator edits freely. Escape in the Markdown body only releases focus; it never clears text (UIP-D14). Hiding the Agent island keeps
the draft, and an app restart offers **Resume draft** because the only copy is main-process project-draft state, never renderer memory.
**Discard draft** is explicit and names the skill. Save stays disabled until frontmatter is closed, fields are valid, the id is unique,
declared capabilities exist in the negotiated schema, and the body fits the size limit. Unknown fields are errors, not ignored.

On **Save project skill**, Builder creates one journaled project skill record; the Markdown bytes are an immutable object referenced from
versioned Agent product data. The skill travels in `.hcadx`, is undoable, and appears with a **Project** badge and content hash. Built-in
skills have a **Built-in** badge, are read-only, and cannot be shadowed by a project skill with the same id. An imported `.md` file goes
through the same validation and command. Deleting a project skill is journaled and undoable; automation deletion requires the normal
destructive confirmation.

The generated `/workspace/SKILLS.md` remains small: it explains discovery, reports catalog generations/counts, and points to
`skills.search/page/read`. It never embeds bodies. On the next relevant question the Agent searches metadata, reads this skill on demand,
verifies its hash/generation, and follows it inside the current capability boundary. Skill text can suggest actions but cannot expand host
authority, bypass validation, mint a grant, or suppress a product confirmation.

#### 2.2.1 Skill file contract

Built-ins are packaged as `skills/builtin/<id>/SKILL.md`; project records are projected read-only into the harness as
`/workspace/skills/project/<id>/SKILL.md`. The projection is never the project authority. Frontmatter is a closed, safe subset—plain UTF-8
scalars and lists only; aliases, tags, executable values, duplicate keys, additional fields, symlinks, and non-UTF-8 files reject.

| Field         | Rule                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | required lowercase kebab id, 1–64 characters; immutable and unique across both scopes   |
| `name`        | required sentence-case display name, 1–80 characters                                    |
| `description` | required discovery summary, 1–240 characters; bodies are never substituted for it       |
| `version`     | required integer ≥1; increments on a project-skill update                               |
| `scope`       | exactly `built-in` or `project`, and must match the catalog that supplied the file      |
| `applies_to`  | up to 32 known Builder domain ids; empty means cross-domain                             |
| `requires`    | up to 64 capabilities present in the versioned automation schema; never grants them     |
| Markdown body | required, nonblank, complete file ≤256 KiB; rendered as text/Markdown, never executable |

#### 2.2.2 Generated documentation layout

`/workspace/SDK.md` is the compact generated namespace/capability index; `/workspace/docs/commands/<method>.md` holds exact bounded method
reference; `/workspace/docs/domains/<domain>.md` is generated prose containing the catalog outcome, state class, access paths, approval
posture, and decision links. Domain capability prose cannot be separately authored. The checked input declaration
`schemas/automation/himmelcad-help-sources-v1.json` lists the ordered Markdown heading sections for each domain. The deterministic extractor
normalizes LF line endings and trailing whitespace and hashes the complete normalized source fragments—not merely their heading anchors.
`/workspace/SKILLS.md` is the compact discovery/index contract above.

Checked build output lives under `packages/@himmelcad/automation-host/generated/help/`; its
`manifest.json` records, for every output: source path, ordered section ids, normalized source-fragment SHA-256, automation-schema SHA-256,
generator version, output relative path, output SHA-256, byte length, and token count. `help.search/open`, UI Help, packaged projections, and
the harness read that single immutable generation. A changed fragment with the same heading, command/access/approval change, omitted domain,
hand edit, schema change, or output-hash mismatch fails G-AG-DOC. Package verification regenerates into a sibling candidate and compares
every projected byte and manifest hash before atomic publication. Every result reports document id, section id, source-spec anchor, content
hash, generation, and bounded excerpt; `open` pages long sections with a 4 KiB/1,024-token per-call ceiling. The two compact root indexes are
each hard-capped at 4 KiB; generation fails instead of truncating required entries (AG-D3).

### 2.3 I/O and registration exposure with grants

The user asks, “Import the survey LAS with preset Site scan, then export the accepted result to E57.” The Agent loads only the import
capability doc and the project skill if one matches. It cannot see arbitrary host paths. `automation.grants.request` creates or returns one
passive pending card for the exact `(session, capability, purpose)`; the call itself never opens a picker, alert, or modal and never changes
focus. The card says **Choose source file**. Only a fresh click by the user while Builder's owning `BrowserWindow` is foreground opens the OS
picker. The selected file becomes an opaque, read-only source grant. The harness receives a grant id and display basename, never a raw path
or broad filesystem access (AG-D16).

The source grant binds an already-opened, no-follow read handle and platform file identity (Linux device+inode; Windows volume+file id),
observed type/size/mtime, allowed methods, project generation, Agent session, and expiry. The sidecar receives a duplicated brokered handle
or lease, not a re-resolved pathname. Rename or symlink changes therefore cannot substitute a different source after selection; an identity
or required-metadata change rejects as `sourceIdentityChanged` and forces a new probe/plan/grant (AG-D17).

`io.probe` uses that source grant without another confirmation and reports provider candidates. If ambiguous, the Agent shows the IF-D13
candidate card and asks; registration order never decides. The Agent then calls only public `io.import`, exactly as IF-D12 specifies. A
complete non-interactive recipe stages, previews, requests product confirmation, and commits through that one orchestration command. An
incomplete recipe returns structured `needsUserInput`; only an explicit caller option creates a Needs-input UIP-D10 job. Point acquisition,
ICP controls, registration session state, samples, preview, and commit remain inside the visible import-formats registration island. The
Agent may observe the owning job's bounded public status and summarize its eventual result, but capability negotiation rejects
`io.import.execute` and all `registration.*` methods for Agent and Python. It never fabricates points or directly commits the user-owned
session (IF-D12; AG-D4/AG-D5).

Before `io.import` publishes, the product gate shows source basename, provider/version, CRS/transform, entities and bytes to add, accepted
losses, and preview quality where applicable. **Confirm import** is a user-only UI response. Electron main validates a live foreground
request bound to the owning window/session, request id, exact plan hash, source grant, project generation, expected revisions, and a
single-use nonce; it mints the short-lived execution grant internally. Agent, generated Python, scripted harnesses, sidecar calls, replayed
IPC, and another window/session have no response method and cannot mint or submit that grant. Deny/expiry changes nothing. Confirm publishes
artifacts transactionally and commits last; progress and cancel remain visible in Jobs and the transcript.

For export, the Agent creates a passive **Choose export destination** card under the same user-activation rule. The picker opens the target
parent and binds its directory handle/identity plus the target's planned present-or-absent identity and collision state. `io.export.plan` is
read-only planning and needs no product confirmation, but it requires that target grant so collision/loss reporting is truthful.
`io.export.execute` is always confirmation-bound because it is externally visible and may overwrite a file (ADR 0024; file-project FP-D5
and §1.6). At execute, the broker revalidates the opened parent and target state; target creation, replacement, or mount substitution since
the accepted plan invalidates it and requires re-plan/reapproval. The exporter creates a no-follow, create-new sibling candidate through the
directory handle, flushes file and directory metadata, then atomically renames with the accepted no-clobber or replace semantic. A replace
also requires the opened target identity to match the plan immediately before publish.

For multi-file output, an all-or-none plan is allowed only when the filesystem supports staging a complete sibling directory and atomic
directory publication. Otherwise the plan and confirmation explicitly say **Files publish independently** and list the rollback limit;
each file still uses a flushed sibling candidate and atomic no-clobber/replace, cancellation cleans candidates, and already published files
remain named as completed external facts. No UI or transcript may claim all-or-none rollback in that mode. This adopts the external-export
owner FP-D5/§1.6 rather than project-format's internal transaction rule. On project close, source/target grants, jobs, leases, plans, and
pending approvals are revoked; reopening the transcript does not resurrect authority.

### 2.4 Close, restart, resume, and multiple harnesses

Closing Agent with its x or File toggle hides the island; it does not end the selected session or interrupt a running turn. The turn remains
a UIP-D10 job, with interrupt available from Jobs. Reopening returns to the same scroll anchor, draft prompt, mentions, and activity. Escape
never closes this workspace island and never discards composer text (UIP-D14).

After an app restart, the session list and completed transcript rehydrate from project-owned data. A turn interrupted by shutdown is marked
**Interrupted**, never completed. Builder attempts native provider-thread resume only when the same frozen harness identity and a local
secure resume binding remain valid; it creates a fresh ADR 0024 automation connection with zero inherited grants. If native resume is
unavailable, the transcript remains readable and **Continue in a new provider thread** starts a clean thread linked to the same named
session; it does not silently replay an unbounded transcript.

File ▸ Settings ▸ Agent shows Codex, Claude, and OpenCode as separate rows with installed version, compatibility, authentication state, and
test action. A session pins its harness; switching the picker creates or opens a session for that harness and never changes a running
session underneath a turn. Provider credentials remain OS-secure or session-only, are never returned through automation, and mutating them
stops affected harness sessions as today (`automation-host/electron.cjs:193–237`).

#### 2.4.1 Durable transcript protocol and privacy boundary

Only sanitized, finalized events become project data. `AgentTranscriptEventV1` stores session id, local turn id, monotone session sequence,
normalized role/kind, sanitized display segments, typed redaction records, command/result references, timestamps, and an opaque
domain-separated HMAC idempotency digest of provider event identity under a local non-archived key. It never stores provider credentials or
resume/thread tokens, approval/grant nonces, raw canonical paths, credentialed/private-token URLs, bulk-lease tokens or contents, hidden
reasoning, executable environment values, or the raw bytes of a user-marked sensitive span. Display-safe basenames replace paths.
Redaction records contain only class (`credential`, `path`, `credentialed_url`, `grant`, `lease`, `sensitive_span`, `hidden_reasoning`, or
`malformed`) and character count—never the removed bytes. User-authored session names pass the same sanitizer and an 80-character limit.

The sanitizer runs before any immutable object, transcript, console projection, error, command preview, or provider echo is created. It
covers user input, provider output, tool output, errors, previews, and normalized lifecycle events. The composer provides **Mark sensitive**
for arbitrary client text; structured credentials/paths/tokens are always marked by their typed source, and known secret patterns are a
second defense. A malformed event, sanitizer failure, or typed sensitive field that cannot be proven removed fails closed: the raw event
remains in bounded process memory only, UI shows **Not stored — sensitive content could not be sanitized**, the provider stream is paused
and then interrupted if storage cannot recover, and the transcript is never labeled complete. There is no promise that heuristic scanning
can recognize unmarked confidential prose; the UI says that ordinary project transcripts archive with `.hcadx` and offers Mark sensitive
before send.

Finalized sanitized events append into immutable chunks capped at 64 KiB or 256 events, whichever comes first. Each chunk records content
hash, session id, inclusive sequence range, previous-head hash, and unique provider-event digests. Publication writes and synchronizes the
chunk, verifies it, then atomically journals the session-catalog plus head update in one project-store transaction; acknowledgement to the
provider/event queue advances only after that head commit. Duplicate provider events are idempotent; out-of-order events buffer at most 256 events or five seconds, then interrupt with a
visible sequence-gap error rather than reorder silently. Orphan chunks written before the head commit are unreachable and later GC-safe; a
head referencing a missing/corrupt chunk opens the session read-only with corruption named and never fabricates completion.

Disk-full or store failure pauses ingestion at one chunk, interrupts the turn at the bounded host boundary, preserves already committed
chunks, and exposes copy-out of the bounded unsaved display content; it never drops a finalized message while claiming success. No automatic
retention truncates finalized chunks. **Delete session** says **Recoverable with Undo**. A running turn must first interrupt and reach its
finalized boundary before the delete transaction can tombstone the session head; undo restores the exact sanitized head and metadata, but
provider resume remains separately conditional and may require **Continue in a new provider thread**. This specification offers no secure
purge: immutable objects, undo history, archives, and backups make ordinary Delete non-erasing. A future purge would require its own
maintenance specification and explicit archive/backup limits (AG-D15/AG-D19).

### 2.5 Entity references and visible side effects

The user presses **Pick entity** beside the composer, then clicks a wall. The one-shot reference tool inserts a chip “Wall W-104” carrying
stable entity id and observed revision, then disarms; it does not serialize the wall. For the point-cloud extreme, viewport LMB cannot
target the cloud under UIP-D15, so the user chooses **Mention in Agent** from its RMB/tree context menu or presses **Mention selection**. A
deleted reference renders “Removed entity · <id>” and never silently rebinds by name. Sending resolves each chip to the current exact
revision or reports it stale; the Agent re-queries properties/data through the SDK.

At 1,000 or fewer selected entities, **Mention selection** creates ordinary chips. Above that tunable threshold it calls
`agent.reference.capture_selection` and inserts one captured-set token, never a live query. The immutable object is SHA-256 addressed over
stable entity-id ordering and stores exact `(entity_id, observed_revision, observed_version_hash)` tuples; the token contains digest,
captured count, project id, session id, and display label `Selection · <count> entities`. `agent.reference.page` returns at most 256 tuples
and 32 KiB per page plus aggregate current/stale/deleted counts; `resolve` checks project/session permission and never substitutes later
selection membership. The object is project-session product data: reachable from the recoverable draft until send/discard, then from the
sanitized finalized transcript; it archives with that session and survives restart. Capturing/removing a draft token is not a CAD undo
step. Session deletion is recoverable and retains the object while deletion undo/history reaches it; explicit unreachable-data maintenance
may collect it only afterward. Selection changes do nothing to the capture (AG-D18).

Every Agent-initiated canonical command appears in three places: transcript activity, attributed console line, and journal actor metadata.
View-local acts (selection, frame, camera, presentation) appear in transcript + console and visibly change the standard
selection/highlight/chips; they are not falsely journaled. A user pointer drag already in progress wins: an Agent camera/frame request
rejects rather than yanking the view. Clicking a mention in the transcript selects the entity through `select.set`; **Frame** is a separate
affordance using `view.frame_selection`, so a casual click does not move the camera.

When one requested Agent result needs several canonical mutations, the preview declares one **Agent action** and opens one journal batch
root identified by `(agent_session_id, agent_turn_id, batch_ordinal)`. All child commands retain their owning command ids/payloads and audit
results, but their expected revisions are validated together and their effects publish all-or-none as one root transaction. The root—not
each child—is the active unit consumed by FP-D11's `document.undo`: Ctrl+Z and the activity card's **Undo Agent action** append one
field-scoped compensating transaction and preserve unrelated later fields. Other canonical writers cannot interleave inside the root;
concurrent sessions prepare independently but serialize at root validation/commit. Long-running work may prepare immutable artifacts before
the boundary, with progress/cancel and no canonical publication; cancellation or failure discards preparation. If filesystem outputs or
another operation cannot participate in that atomic root, the Agent must present them as separately numbered actions, disclose the exact
undo/irreversibility of each before execution, and never label them one batch. This is the X3 both-ways boundary (AG-D14).

## 3. Function contract answers by group

### 3.1 Workspace, sessions, turns, references, approvals

**A1 — User outcome.** §§2.1, 2.4, and 2.5 are the full workflow narratives. The user gets a resumable, attributable project assistant whose
actions use the same commands and remain visible and reversible.

**A2 — Reference behavior.** The Agent catalog is not derived from a reference assistant. The dossiers’ mapping sections allocate their
catalogs to File, View, Pointcloud, Draw, Mesh, Raster, BIM, and plan/specification domains (`realworks.md` §5; `trimble-perspective.md` §5;
`rib-civil.md` §5; `revit.md` §5). We therefore make no unsupported claim about reference AI UX. The motivating CAD behavior is referenced,
not copied: Perspective persists and restores limit boxes (`trimble-perspective.md` §2.3), and RealWorks exposes named stored boxes
(`realworks.md` §2.5). Viewing-box §1.4 already adopted that behavior and owns it; Agent only exercises its command under X3.

**A3 — Sibling functions.** Persistent Specs/Plan/Agent islands share the platform island class; actual current semantics are
unmount-on-close (`App.tsx:844–860`), which this spec deliberately changes for Agent while UIP-D14 still owns Escape. Jobs inherit UIP-D10.
Product approval reuses the existing modal (`ManagedAutomationApproval.tsx:35–65`) but unifies it with the timeline queue. Entity selection
uses UIP-D2/D15 and `select.*`; framing uses view-domain `view.frame_selection`. The same attribution contract should be adopted by future
automation-facing Specs/Plan operations.

**B1 — Reachability.** Matrix: ribbon File ▸ Agent present; entity X contributes “Mention in Agent”; viewport quick surface absent (global
workspace command, not void-relevant); console `agent` plus `agent session/turn`; automation listed in §1; keyboard only focused
Ctrl/Cmd+Enter; no global shortcut. All routes use the catalog commands. Security-sensitive reachability is principal-specific:

| Principal                                             | Pending approval/grant visibility                                                                                                  | Confirm/Deny or picker-open authority                                                                                                                   | Credential authority                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Agent harness                                         | bounded sanitized `agent.approval.get/list` without nonce/grant material; passive `automation.grants.request`; observe disposition | absent from schema and host allowlist                                                                                                                   | absent                              |
| Generated Python SDK / scripted harness               | same bounded observation/request contract                                                                                          | absent from generated client, schema, and host allowlist                                                                                                | absent                              |
| Trusted renderer product UI in owning `BrowserWindow` | exact live card                                                                                                                    | private IPC only after fresh foreground user activation; request id + plan hash + project generation + expected revisions + single-use nonce must match | invokes OS-owned credential UI only |
| Electron main                                         | authority queue and bindings                                                                                                       | validates window/session/foreground/nonce and mints or denies the internal one-use grant; never accepts a public automation response                    | owns secure credential broker       |
| Sidecar                                               | receives only validated execution capability/handle and final disposition                                                          | cannot respond, open picker, or mint a grant                                                                                                            | receives no credential              |

This is structural absence, not a policy check that automation can request to bypass. There is no `agent.approval.respond` method (X3;
ADR 0024; AG-D5).

**B2 — Open/close symmetry.** File button pure-toggles show/hide; island x hides; Escape is exempt. Hide preserves session/turn/draft. **End
session** is explicit; during a turn it requests interrupt, waits a bounded interval, then host-terminates and marks interrupted. Delete is
separate, journaled, explicitly labeled **Recoverable with Undo**, and serialized after any running turn reaches its finalized boundary
(§2.4.1). Passive grant requests survive island hide but not expiry/session end/project close; picker/window-blur behavior is §3.3 B2.

**B3 — Surface choice.** Persistent resizable workspace island, as UIP-D14 already classifies Agent. Conversation, approvals, sessions, and
references need enduring context beside the viewport; a right function panel is too narrow and would consume the Properties slot, while a
modal blocks CAD work.

**C1 — Numeric parity.** No Agent-owned geometry manipulation exists. Numeric values in command previews are read-only summaries; editing
occurs in the owning domain’s typed controls or explicit prompt text, and the command schema validates units. Entity-reference picking has a
non-pointer twin: context menu, selection button, or typed stable id through automation.

**C2 — Selection semantics.** Ordinary chat ignores selection until the user presses Mention selection or an explicit command targets it.
Reference-pick captures one entity per click; repeated activation supports many. Selection may change while Agent is open without mutating
existing tokens. Mixed selections become one token per stable id up to 1,000; above that, §2.5's immutable digest-addressed
`CapturedSelectionReferenceV1` replaces chips. It is an exact captured set with bounded pages, never a live query (AG-D18).

**C3 — Freezability.** Sessions pin harness identity, schema generation, skill hashes read during each turn, and exact entity revisions.
This is a correctness freeze, not a performance bake. Timeline virtualization is already the performance answer; freezing a conversation
would provide no useful invariant.

**C4 — Persistence and undo.** Named session metadata and sanitized finalized turn transcripts are project Agent product data backed by
immutable objects under §2.4.1; create/rename/delete are journaled, and Delete is recovery rather than erasure. Streaming fragments, busy
state, selection, camera, scroll anchor, unsubmitted prompt, and draft mentions are not CAD undo steps. Prompt/draft recovery persists in
main-owned per-project state and is cleared only by send/discard. One canonical command is one normal root. Several mutations presented as
one Agent action use the single all-or-none journal batch root in §2.5/AG-D14, so Ctrl+Z and **Undo Agent action** compensate once; child
audit records are not independent undo roots. View-local actions do not enter the journal, matching their owning specs.

**D1 — Performance budget.** Continuous: streaming timeline while typing and reference-pick hover; gate G-AG-UI (§7) requires p95 presented
interval ≤2× target and composer input echo ≤50 ms p95 with 100,000 transcript rows. Bounded: open/hide, session switch, mention resolve (<1
s; inline busy if perceptible). Long: every turn, provider resume, and I/O work registers UIP-D10 progress/cancel. Values are tunable under
X6.

**D2 — Degradation.** Virtualization and bounded normalized events remain mandatory (`VirtualAgentTimeline.tsx:37–65,120–160`;
`drivers.ts:97–102`). Degrade transient reasoning/file previews first, then page older committed rows out of the DOM; never delete
sanitized finalized messages, approvals, errors, canonical action results, or weaken input/capability enforcement. The transcript reader
pages older immutable chunks on demand. Storage failure follows §2.4.1: pause/interrupt and report unsaved bounded content, never claim a
dropped event was finalized.

**E1 — Visual quality.** §8 criteria 1–5 and 8, both themes.

**E2 — Conflicts, failures, consumers, gestures.** One turn per session; turns in different sessions may run concurrently, but canonical
commands serialize through expected revisions/journal. Provider switch is rejected while its turn runs. Renderer reload rehydrates
jobs/transcripts; whole-app crash marks the turn interrupted. Malformed provider events remain contained/redacted as today
(`drivers.ts:215–245`; `queue.ts:83–134`). Approval denial/expiry publishes nothing.

Consumers: project store (session records/chunks/captured sets), main job registry, timeline, console, journal actor/batch metadata, entity
tree/selection/properties, viewer and overlay chips, command/query registry, generated SDK, provider host, credential store, import/export
runtimes, filesystem broker, and the enumerated sibling products/packages below. No renderer is sole owner of durable data.

| Consumer                                      | Agent methods/UI                                                                                                          | Project/archive behavior                                                                                                                                                 | Gate impact                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Himmel:CAD Builder                            | full §1 catalog under negotiated capabilities                                                                             | reads/writes `builder.agent@1`; journal actor/batch semantics active                                                                                                     | all G-AG gates                                               |
| Himmel:CAD PhotoLab                           | shared Agent workspace may expose only its own product profile; Builder-only view/import methods fail `methodUnavailable` | preserves unknown `builder.agent@1` product data and actor versions byte-for-byte when opening/saving a compatible archive; never advertises unsupported Builder methods | PhotoLab package + cross-product `.hcadx` round-trip fixture |
| Himmel:CAD WeltView                           | no Agent workspace or automation host                                                                                     | read-only preserves/ignores Agent product data; may display fixed actor label but cannot mutate; any future repack must retain unknown data                              | WeltView archive-open fixture                                |
| Himmel:CAD Cap                                | no shared automation schema and produces `.hcap`, not `.hcadx`                                                            | no adoption required; `.hcap` contains no Agent session authority                                                                                                        | unchanged Cap package gate                                   |
| `@himmelcad/automation-host`                  | app-profile allowlist; unsupported methods and all trust responses fail closed                                            | owns runtime-only sessions/grants, no archive authority                                                                                                                  | host negative matrix and package inventory                   |
| `@himmelcad/app` and generated Python clients | may contain generated types, but runtime negotiation exposes only the app profile                                         | preserve opaque product-extension references; clients cannot infer support from generated presence                                                                       | `automation.sdk` + client capability tests                   |
| `@himmelcad/data` / canonical project store   | no UI/routing                                                                                                             | versioned actor, batch, product-data and unknown-extension preservation; writable open only when supported                                                               | migration/deterministic serialization/round-trip tests       |

Class extremes: largest transcript = 100,000 rows with multi-MiB command previews, still virtualized/paged; least typical = empty new
session, which shows actionable setup, no fake history. Largest entity = point cloud, mention via tree/RMB because UIP-D15 excludes LMB;
least typical = deleted GCP marker, rendered as a stale id without rebinding.

Reference-pick gesture reconciliation with ui-platform §3.6:

| Gesture while one-shot pick is armed | Claim / platform reconciliation                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LMB click entity                     | claimed: insert one mention and disarm; idle selection is suspended for this click sequence                                                            |
| LMB click void/bare cloud            | claimed: no token, status explains; stays armed; cloud path is RMB/tree                                                                                |
| LMB double-click entity              | first click inserts exactly one mention and disarms; the second activation in that sequence is suppressed; platform has no entity-double-click meaning |
| LMB double-click void/bare cloud     | unclaimed: platform clears selection; mention tool stays armed after the sequence                                                                      |
| LMB drag                             | unclaimed: orbit/pan remains platform-owned; no token on drag                                                                                          |
| Ctrl+LMB                             | unclaimed: platform selection toggle; tool remains armed                                                                                               |
| RMB click / drag                     | unclaimed: entity/quick menu and pan remain platform-owned; menu contributes Mention in Agent                                                          |
| MMB / wheel                          | unclaimed: pan/zoom remain platform-owned                                                                                                              |
| Tab / Shift+Tab                      | traverses Agent composer/pick controls; never cycles candidates                                                                                        |
| Up / Down                            | cycles visible pick candidates for the pending mention while its indicator is live                                                                     |
| Escape                               | UIP-D14 rung 4: cancel pick only; prompt and island remain                                                                                             |
| Typing                               | composer wins focus, cancels pick, retains all text                                                                                                    |
| Touch tap entity                     | claimed: insert one mention and disarm; no tap-again deselection in the consumed sequence                                                              |
| Touch tap void/bare cloud            | no token; status explains; stays armed                                                                                                                 |
| Touch tap-again on selected entity   | while armed, claimed as the entity-tap equivalent: insert mention and disarm; it does not alter selection                                              |
| Touch tap-hold                       | unclaimed: platform context menu opens; tool stays armed; menu may contribute Mention in Agent                                                         |
| Touch double-tap entity              | first tap inserts one mention/disarms and suppresses a second activation in the sequence                                                               |
| Touch double-tap void/bare cloud     | unclaimed: platform clears selection; tool stays armed                                                                                                 |

Only one viewport tool may be armed; Pick entity is disabled with explanation while Draw, fence, viewing-box placement, or another tool owns
the slot.

**E3 — Verification.** G-AG-E2E, G-AG-UI, changed tests, automation.sdk, and manual/E1 checks are named in §7. Subjective response
usefulness remains explicitly unverified.

### 3.2 Skills and generated documentation

**A1.** §2.2 in full: the user creates, validates, saves, discovers, and later edits a project skill; the Agent discovers and reads only
what it needs.

**A2.** RealWorks documents an in-product Help search used to find “shortcut” (`dossiers/realworks.md` §2.3, Cloud merge note); we adopt
visible search, not its content structure. The four dossier mapping sections assign all substantive CAD rows to their owning domains (§4),
so Agent documentation links those specs instead of duplicating their capabilities.

**A3.** Siblings: automation schema → generated Python client already exists (`sdk/python/src/himmelcad/client.py:1,21–23`); SDK staleness
is already a named release gate (`docs/TEST-TIERS.md`, Automation runtime release tasks). `systemPrompt.ts:13–19` already names SDK and
skills paths without serializing the project; this becomes the deliberate five-line bootstrap, not a stub.

**B1.** Skills: Agent Skills tab, console, generated SDK. Help: Agent header, console `help`, generated SDK. No ribbon buttons per item and
no viewport quick entry (catalog content, not spatial acts). Built-in edit/delete automation is absent by decision; project
create/update/delete exists.

**B2.** Reader/editor close returns to Chat without losing a draft. Cancel exits only after discard confirmation for a changed draft. Save
commits; validation failure stays open. Search clears with its x/Escape as a normal search field, while Markdown/free text obeys UIP-D14 and
is never discarded.

**B3.** Skills/Help are tabs inside the persistent Agent island. The Markdown editor takes the island’s full content area with an internal
split; it does not open another floating island. The user can still inspect the viewport beside it.

**C1.** Frontmatter version is a typed integer with a text-source twin in raw Markdown; preview and source remain synchronized. No spatial
numeric input.

**C2.** Selection is ignored. `applies_to` filters discovery by domain, never by current selected entity without an explicit search query.

**C3.** A skill read pins `(id, scope, version, contentHash, catalogGeneration)` for the turn. The implementation can cache immutable
built-in/project bodies by hash and invalidate only the catalog index, avoiding repeated parse work.

**C4.** Built-ins are read-only application resources. Project skills are journaled project records and archive with `.hcadx`; drafts are
recoverable noncanonical main-owned state. Generated docs/indexes are rebuildable caches, never authoritative. Skill undo restores exact
Markdown/hash.

**D1.** Search/page/read/save are bounded; page limits and byte limits match the automation schema’s bounded-query posture. Editor typing is
continuous and covered by G-AG-UI. Documentation generation is preprocessing and may be expensive, but runs at build/bootstrap with atomic
publication and staleness gate, never during a user keystroke (X2).

**D2.** Weak hardware reduces preview refresh frequency and syntax decoration first. It never weakens validation, loses draft text, preloads
all docs, or returns an unbounded page.

**E1.** §8 criteria 6–7, both themes.

**E2.** Consumers: five-line system prompt, `/workspace/SKILLS.md`, `/workspace/SDK.md`, generated help manifest/output, local help index,
generated sync/async Python clients, Skills/Help UI, scripted harness, packaging/staleness gates. Generation writes a sibling candidate then
atomically renames (same durable pattern already used for bootstrap files, `automation-host/electron.cjs:399–424`). A bad project skill is
quarantined with a visible validation error; it never disappears silently. A malicious skill remains text under least authority and cannot
override a built-in id or request undeclared capabilities. Runtime injection enforces both the per-call and total byte/token ceilings in
§§2.1/2.2.2 before adding content.

Class extremes: a 256 KiB valid skill is paged through explicit 4 KiB/1,024-token reads and cannot be injected wholesale; the least typical
metadata-only/empty-body file is rejected because actionable body is required. The largest documentation domain is Pointcloud and is split
into bounded, independently hashed sections. The least typical one-method domain still receives a manifest entry and full-fragment hash.

**E3.** G-AG-DOC and automation.sdk in §7 prove deterministic generation, full-fragment/schema/output staleness, pagination, and no-body preload.
Visual/editor checks use §8.

### 3.3 Providers, path grants, I/O and registration passage

**A1.** §§2.3–2.4 in full.

**A2.** Import/registration behaviors are already dispositioned by import-formats §1.3 and IF-D12/IF-D13; this spec adopts their public
access boundary rather than deciding the import workflow again. RealWorks’ import and registration rows (`realworks.md` §§2.1–2.2) remain
owned by File/Pointcloud per its §5 mapping. No reference trust model is claimed.

**A3.** Siblings: UI `IoClient`/`RegistrationClient` expose the complete method families
(`packages/@himmelcad/app/src/clients.ts:629–716,718–839`); the sidecar implements them (`main.rs:1681–1920,1938–2103`); automation
currently cannot reach them because its host allowlist stops at document/view/bulk methods (`automation-host/index.cjs:79–101`). Existing
confirmation grants are plan, transaction, session, and expiry bound and single-use (`index.cjs:245–340`; `automation_runtime.rs:604–674`);
extend that mechanism.

**B1.** Provider configuration: Settings page + session picker + status SDK. Secrets have deliberately no SDK read/write path. Path grants:
passive inline request, Settings revocation, and SDK request/list/revoke; `request` cannot accept a raw path and cannot open a picker. Only
the trusted foreground product-UI click described in §2.3 can open it. Public I/O matrix, adopting IF-D12 without re-disposition:

| Public method family                 | Required authority                                                                      | Product confirmation / result                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `io.formats.page`                    | negotiated metadata read                                                                | none                                                                                               |
| `io.probe`                           | brokered exact source-read grant                                                        | none                                                                                               |
| `io.import`                          | source grant + complete IF-D12 recipe + expected revisions                              | user-only at commit; otherwise structured `needsUserInput` or explicitly requested Needs-input job |
| `io.import.product_dataset.list`     | brokered source-project/archive read grant + bounded cursor                             | none; returns the IF-D20 bounded disposition page                                                  |
| `io.import.product_dataset.register` | same source grant/snapshot + product/package identity + destination expected generation | user-only single-use confirmation at commit; otherwise typed IF-D20 status/result                  |
| `io.export.plan`                     | brokered exact target-parent/target grant; plan only                                    | none                                                                                               |
| `io.export.execute`                  | target grant + accepted exact plan + revalidated target state                           | always user-only                                                                                   |
| `io.operation.status/cancel`         | owning session/operation capability                                                     | none; bounded status / safe cancellation                                                           |

App-private `io.import.execute` and every `registration.*` method are absent from Agent/Python capability negotiation and reject at the
host even if a caller guesses their names. The visible registration island remains the only owner of picks, samples, ICP controls, preview,
and commit (IF-D12; AG-D4/AG-D5).

**B2.** A grant request is idempotent per `(session, capability, purpose)`: one passive pending card, duplicates return its id. At most one OS
picker is active per owning window, eight grant requests may be pending per session, and 32 per project; excess requests fail
`tooManyPendingGrantRequests` without evicting an existing card. After three user denials/cancels for one tuple within 60 seconds, a new
request is throttled for 30 seconds (`requestThrottled`). These X6 numbers are tunable. Hiding Agent retains passive cards; a background or
blurred window cannot open a picker, and losing foreground while the picker opens cancels it without issuing a grant. Provider death/session
end expires its requests; project close/app restart revokes all requests, pickers, grants, approvals, plans, and handles. Deny/expiry publish
nothing. Provider settings close normally; credential edits explicitly stop affected sessions before mutation (AG-D16).

**B3.** Provider configuration uses File Settings framework; approvals use the modal alert-dialog because work must stop before authority
expands. Source and target choice remains OS-owned. Registration preview remains import-formats’ modal dual-view island; Agent does not
clone it.

**C1.** Paths are never typed into Agent-controlled fields; OS selection and opaque grants are the secure equivalent. Registration numeric
transforms and point pairs use import-formats’ typed/picked parity. Agent summaries are not editors.

**C2.** I/O commands take explicit source/target grants and entity/package ids, never implicit current selection. Export plans may
explicitly use a selection scope owned by file-project; the exact ids/revisions are frozen into the plan.

**C3.** Grants freeze brokered open-handle/platform identity, observed metadata, permissions, allowed methods, project generation, session,
and expiry. Export plans freeze provider version, outputs, losses, collisions, target present/absent identity, replacement mode, and project
revisions. Execution revalidates through the same opened parent/target handle immediately before publish. Canonical path text alone is not
an identity and never crosses to the harness or sidecar as authority (AG-D17).

**C4.** Grants, provider threads, cursors, leases, preview sessions, and approvals are runtime authority and never journaled or archived.
Import commits are journaled by import-formats; exports are external outputs recorded in console/provenance but not undone by Ctrl+Z.
Provider choice is user-level; session choice is project Agent data. Revocation’s affected set is exact grant plus dependent uncommitted
plans/sessions; committed project data and completed exports are exempt because revocation cannot reverse facts already published.

**D1.** Discovery/grant/plan calls bounded; stage/import/export/ICP/commit long and UIP-D10-registered with real progress and cancel.
G-AG-IO exercises source and target grants and cancellation. Harness discovery retains its 2 s timeout and 64 KiB output cap
(`drivers.ts:20–22`).

**D2.** No security or correctness degradation. Weak hardware may reduce preview sample density within the registration spec’s declared
bounds, never source precision, plan validation, hash checks, approval detail, or cancellation.

**E1.** §8 criteria 3–5 and 8.

**E2.** Consumers: allowlist/router, filesystem handle broker, sidecar I/O runtime, canonical journal/store, job registry, OS picker,
provider credential store, approval modal, transcript/console, SDK generator, import island, exporters, and the sibling matrix in §3.1 E2.
The sidecar consumes only brokered handles/leases and never trusts a harness path. Two exports to the same target serialize; the second
re-plans or fails. Imports may prepare concurrently, but `io.import` commits serialize through journal revisions. Project replacement
rejects all late callbacks by generation. Project publication follows `PROJECT-FORMAT` ready/commit rules; external export follows
file-project FP-D5/§1.6 plus §2.3's sibling-candidate/flush/atomic-rename mechanism and stated multi-file limit. Symlink swap, rename swap,
mount replacement, or target creation after approval rejects and requires a new plan/approval (AG-D17).

Class extremes: 40×50 GB LAS batch uses one per-file source grant set, bounded jobs, no aggregate memory; a 3-line XYZ file still gets a
real grant and commit review. Largest export may contain many files: the confirmation lists a bounded summary plus pageable exact outputs; a
one-file export names that file directly.

**E3.** G-AG-IO, G-AG-E2E, automation.sdk, sidecar/host tests, and §8 visual checks in §7. Native OS picker behavior remains manual on Linux
and Windows.

## 4. Dossier-row dispositions

The Agent catalog is ADR/X3-derived, not reference-derived. To prevent silent catalog pruning, every dossier row that this spec invokes or
could appear to claim is dispositioned below; the remaining rows are explicitly rejected only as **Agent-owned duplicates**, not rejected
from Builder.

| Dossier row/group                                    | Disposition for Agent domain                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RealWorks §2.3 Cloud merge help-search note          | **Adopted:** visible `help.search`; command itself remains Pointcloud-owned                                                                                  |
| RealWorks §2.5 Store/manage limit boxes              | **Adopted as an Agent-accessed sibling:** viewing-box owns storage/activation; §2.1 calls it, no duplicate row                                               |
| RealWorks §§2.1–2.2 import/registration              | **Adopted for parity passage:** methods/grants in §3.3; workflows remain import-formats/registration-owned per RealWorks §5                                  |
| RealWorks §2.9 export/publishing                     | **Adopted for parity passage:** export planning/execution grants; File/import-formats retain the user function                                               |
| RealWorks remaining §§2.1–2.10 rows                  | **Rejected as Agent-owned rows:** RealWorks §5 assigns each to File/View/Pointcloud/Draw/Mesh/BIM/Raster; X3 accesses their commands instead of cloning them |
| Trimble Perspective §2.3 persisted/restore limit box | **Adopted through viewing-box §1.4:** motivates §2.1 only                                                                                                    |
| Perspective §2.5 selection/context access            | **Adopted through UIP-D2/D15:** reference mentions use those platform semantics, not a second selection model                                                |
| Perspective remaining §§2.1–2.7 rows                 | **Rejected as Agent-owned rows:** Perspective §5 maps them to View/viewport/measure/registration domains                                                     |
| RIB Civil §2.2 F4/F5 aids                            | **Rejected for Agent:** Agent claims no global F4/F5 and owns no geometry construction; Draw/View retain those mappings (rib-civil.md §5)                    |
| RIB Civil §§2.1–2.10 remaining rows                  | **Rejected as Agent-owned rows:** rib-civil.md §5 maps them to Draw/Mesh/Pointcloud/File/View/Raster/BIM                                                     |
| Revit §§2.1–2.8 families/properties/styles/schedules | **Rejected as Agent-owned rows:** revit.md §5 maps them to BIM/specifications/plan; Agent accesses their future commands under X3                            |

No dossier-backed Agent capability is deferred. Deferred core capabilities keep their owning spec/REGISTRY disposition; Agent parity arrives
when their canonical commands arrive.

## 5. Decision records

**AG-D1 — Skills are discovered and loaded on demand.** **Decision:** the five-line bootstrap points to compact SDK/skill indexes; metadata
search/page precedes a specific paged `skills.read`; no skill body, project snapshot, or whole manual is preloaded. Each read is at most 4
KiB/1,024 tokens; the §2.1 restore workflow has a 12 KiB/3,072-token total injected-support ceiling and fails closed on either limit.
**Derivation:** X2 (spend preprocessing, protect interaction/context), X6/P3 (calibrate enforceable ceilings), ADR 0024 (bounded SDK), current
`systemPrompt.ts:6–19` intent. **Rejected:** concatenate all skills/specs into the system prompt (unbounded context, stale unrelated
instructions); byte-only limit (token expansion can still overflow context). **Tunable:** yes — numeric ceilings and local search ranking,
not on-demand/fail-closed behavior.

**AG-D2 — Two skill scopes, immutable built-ins and canonical project skills.** **Decision:** built-ins ship read-only and hash-inventoried;
project skills are journaled records backed by immutable Markdown objects, archive with the project, cannot shadow built-in ids, and
validate closed frontmatter. **Derivation:** X1 security/data integrity; X3/P1 deliberate restorable state; `PROJECT-FORMAT.md` Product
data/Immutable object store. **Rejected:** loose writable workspace files (not canonical, not archive-safe); global user skills now (third
scope without a required workflow). **Tunable:** 256 KiB body cap.

**AG-D3 — Generated documentation has schema truth plus content-hashed spec meaning.** **Decision:** §2.2.2's checked source declaration and
deterministic extractor emit artifacts and a manifest containing source path, ordered section ids, normalized full-fragment hash, schema
hash, generator version, output hash/size/token count. Domain capability prose is generated only; same-anchor semantic changes, omissions, hand edits, schema drift,
or package projection mismatch fail G-AG-DOC. `help.search/open` page the same immutable artifacts. **Derivation:** X3; ADR 0024 versioned
protocol/generated clients; FUNCTION-CONTRACT auditability; TEST-TIERS SDK staleness gate. **Rejected:** hand-written SDK/domain manuals
(drift); anchor-presence-only manifest (misses changed approval/state semantics); runtime prose scraping (fragile and slow). **Tunable:** yes
— search ranking and page size, not source/output hash enforcement.

**AG-D4 — Public I/O passage adopts IF-D12 and opaque least authority.** **Decision:** Agent/Python receive only `io.formats.page`,
`io.probe`, public `io.import` (including IF-D20's generated
`io.import.product_dataset.list/register` specializations),
`io.export.plan/execute`, and bounded operation status/cancel under §3.3. Raw paths never authorize access;
grants use brokered identities per AG-D17. `io.import.execute` and every `registration.*` method stay app-private and reject in capability
negotiation. **Derivation:** import-formats IF-D12 via the README cite-and-revise rule; ADR 0024 separate filesystem capability; X1/X3;
existing read-only harness sandbox (`automation-host/index.cjs:701–724`). **Rejected:** re-owning registration preview/commit here (second
disposition); mount user directories or accept raw paths; keep public `io.import` blocked (violates X3/IF-D12). **Tunable:** grant expiry
only.

**AG-D5 — Trust responses are user-only by construction.** **Decision:** import commit and export execute require one plan-bound product
confirmation. Automation may observe but cannot respond: no `agent.approval.respond` schema/generated/host route exists. Only trusted
foreground UI IPC bound to owning window/session, request id, exact plan hash, project generation, expected revisions, and a single-use
nonce may Confirm/Deny and cause Electron main to mint the internal grant. Probe/plan/status/cancel need no confirmation. One user response
updates modal and transcript. **Derivation:** X3's trust-boundary asymmetry; Function Contract B1; ADR 0024; X1; IF-D12; existing single-use
plan grants (`index.cjs:245–340`). **Rejected:** public response method or harness-native approval (self-authorization); approve every read
(fatigue); no export confirmation (external overwrite). **Tunable:** approval expiry only; principal separation is not tunable.

**AG-D6 — Sessions contain sanitized project-owned transcripts with local secure provider bindings.** **Decision:** session identity/name and
AG-D15-sanitized finalized transcript heads are project Agent data; provider resume tokens stay local secure state and do not travel in
archives. AG-D19 governs append/recovery. Restart rehydrates transcript and attempts same-harness resume with a new zero-grant connection.
**Derivation:** X3/P1; X1; ADR 0024 grants do not cross process/project implicitly; PROJECT-FORMAT forbids renderer-only persistent state.
**Rejected:** raw transcript persistence (secret leakage); renderer-only events; archive provider tokens; replay full transcript silently.
**Tunable:** chunk size and explicit retention UI, never silent deletion.

**AG-D7 — Hiding Agent never cancels work; turns are main-owned jobs.** **Decision:** x/File toggle hide the workspace; active turns
register UIP-D10 jobs owned alongside the main-process harness host and continue. End/interrupt is explicit. **Derivation:** REGISTRY §1.12;
UIP-D10 lifecycle ownership; UIP-D14 workspace exemption; SYSTEM-001. **Rejected:** current unmount/stop on close
(`ManagedAgentChat.tsx:93–101`, `App.tsx:854–860`). **Tunable:** graceful interrupt timeout.

**AG-D8 — Entity mentions are stable references, never copied project context.** **Decision:** ordinary mention tokens carry id + observed
revision; send resolves current state via SDK. A one-shot pick tool plus context/selection twins create them; deleted ids stay visibly stale.
Large selection captures follow AG-D18 rather than a live query.
**Derivation:** ADR 0024 no copied project model; X1 no name rebinding; X3; UIP-D15 extreme member. **Rejected:** paste serialized entities
into prompts (unbounded/stale); resolve by name (wrong entity risk). **Tunable:** multi-mention chip threshold.

**AG-D9 — Agent side effects are attributed in every relevant consumer.** **Decision:** canonical acts get timeline + console +
AG-D20 `JournalActorV1`/batch metadata; view-local acts get timeline + console + normal visible UI state. Active user gestures win over Agent
view changes. **Derivation:**
X3 “both ways”; PROJECT-FORMAT journal actor; DESIGN-SYSTEM console/error rules; SYSTEM-001 passive consumers. **Rejected:** chat-only
success text (user cannot verify); journal view state (contradicts owning specs). **Tunable:** concise console copy.

**AG-D10 — Harnesses are peers; secrets are not automation capabilities.** **Decision:** Codex/Claude/OpenCode have independent
discovery/auth/settings; sessions pin one frozen identity. Automation can read status/select a usable harness but never read/write secrets.
**Derivation:** ADR 0024 multi-harness adapters and security; current three-driver configuration (`drivers.ts:24–43`); X1. **Rejected:**
Codex-only product model; common plaintext token field; mid-turn provider switch. **Tunable:** preferred default harness.

**AG-D11 — Reference pick owns one explicit armed-tool slot.** **Decision:** §3.1 E2 gesture table is exhaustive, including separate entity
versus void/cloud double-click and tap/tap-again/tap-hold/double-tap rows; no hidden modifier or global shortcut; other armed tools block it.
**Derivation:** ui-platform §3.6, UIP-D2/UIP-D14, FUNCTION-CONTRACT E2 gesture rule. **Rejected:**
hijack every viewport click while composer focused (breaks selection/navigation); auto-mention every selection (surprising context spam).
**Tunable:** hover settle delay.

**AG-D12 — Restore is one indexed query and the owning activation command.** **Decision:** §2.1 uses exactly
`viewing_box.list(order: last_activated_generation_desc, limit: 1, state: surviving)` followed by
`viewing_box.activate(id, expected_revision)`; no journal scan, deleted resurrection, last-created inference, or reopen-state contradiction.
No approval is required. **Derivation:** viewing-box §1.4/B1 and VB-D1/VB-D2; file-project §1.2; P1; X1; X2; AG-D1.
**Rejected:** forward journal paging (unbounded and lacks activation semantics); last-created; resurrect deletion; assume reopen forgot active
state; ask owner. **Tunable:** no for ordering/call shape; context ceilings are AG-D1 tunables.

**AG-D13 — Additive protocol extension, no alternate command layer.** **Decision:** new help/skills/session/grant/reference-query methods and
the IF-D12/IF-D20-bounded public I/O methods enter the existing versioned automation schema, capability negotiation, generator, sync/async client,
and host router. User-only responses and app-private registration methods are structurally absent. Core mutations still validate and
execute the owning canonical commands. Per doctrine P11, **Product operations reach automation and the console from one generated command table: every product capability (Builder, PhotoLab, WeltView read-only queries) is a canonical command or query with the validate/status/cancel lifecycle, generated from a single command table that also drives the console vocabulary and the Python SDK; allowlisting raw RPCs is never the exposure mechanism; approval, confirmation-grant, and credential surfaces stay user-only (ADR 0024).** **Derivation:** ADR 0024; X3; P11; IF-D12/IF-D20; CURRENT-DIRECTION shared infrastructure. **Rejected:**
Agent-only RPC/socket or hand-authored client wrappers (parity and staleness fork). **Tunable:** no.

**AG-D14 — One presented Agent action is one journal batch root.** **Decision:** §2.5 defines the batch id, all-or-none validation/publication,
child audit records, serialization point, cancellation boundary, and one-step `document.undo`/Undo Agent action behavior. Non-atomic work is
presented as separately numbered actions with exact undo/irreversibility, never one batch. **Derivation:** X3 both-ways clause; X5; Function
Contract C4; file-project FP-D11's most-recent-root and field-scoped compensation semantics. **Rejected:** one root per child (40-command
request needs 40 undos and permits interleaving); cosmetic grouping without transaction semantics; hiding non-atomicity. **Tunable:** no.

**AG-D15 — Sanitize every durable or projected transcript boundary before object creation.** **Decision:** §2.4.1's closed
`AgentTranscriptEventV1` and typed redaction records apply to prompts, provider/tool output, errors, previews, console, and transcript before
persistence. Credentials, nonces, raw paths, lease tokens/content, hidden reasoning, and marked sensitive spans never enter `.hcadx`;
sanitizer/malformed-event failure is fail-closed and visibly not stored. Ordinary Delete is recoverable, not secure erasure; no purge is
claimed. **Derivation:** X1 security/data integrity; ADR 0024 credential and capability boundary; PROJECT-FORMAT immutable-object/archive
semantics; Function Contract C4. **Rejected:** post-persistence display redaction (secret already durable); heuristic-only secret detection
(cannot cover arbitrary client text); calling undoable deletion erasure. **Tunable:** yes — supported heuristic patterns and display limits,
not the closed forbidden-field classes or pre-persistence boundary.

**AG-D16 — Automation requests passive, bounded authority cards; only user activation opens native UI.** **Decision:** §3.3 B2 defines
idempotency, one active picker/window, pending ceilings, denial/cancel throttle, foreground ownership, and hide/blur/close/provider-death/
expiry outcomes. An automation request alone never opens a picker or modal. **Derivation:** X1 availability/security; X3 trust asymmetry;
Function Contract B2; ADR 0024. **Rejected:** request-opens-picker (focus theft/modal spam); unbounded queue; implicit denial on island hide.
**Tunable:** yes — 8/session, 32/project, three-in-60-second and 30-second throttle calibrations; fresh user activation is not tunable.

**AG-D17 — Filesystem grants bind open objects, and export publication revalidates the accepted target.** **Decision:** source grants use
no-follow brokered read handles/platform identity; target grants use an opened parent plus planned target identity. Execution rejects
identity/collision change, publishes flushed sibling candidates with exact no-clobber/replace semantics, and discloses when multi-file
publication cannot be all-or-none (§2.3). **Derivation:** X1; ADR 0024 separate filesystem capability; file-project FP-D5/§1.6; PROJECT-FORMAT
safety invariant against concurrent external-target writers. **Rejected:** canonicalized pathname as frozen identity (TOCTOU); raw sidecar
path; overwrite without last-moment identity check; claiming project-store atomicity for an incapable external filesystem. **Tunable:** no.

**AG-D18 — Large selection mentions are immutable captured sets.** **Decision:** above 1,000 selected entities, §2.5 creates
`CapturedSelectionReferenceV1`: digest-addressed exact refs, project/session scoped, paged at 256 tuples/32 KiB, archived with the sanitized
session, stale/deleted counted, selection changes ignored, and GC only after draft/transcript/deletion-history reachability ends.
**Derivation:** X1; X3; Function Contract C2 and E2 extreme-member rule; AG-D8 stable-reference rule; PROJECT-FORMAT immutable objects/GC.
**Rejected:** implicit live query (silently retargets); 100,000 chips (unbounded prompt/UI); unpaged exact array. **Tunable:** yes — 1,000,
256, and 32 KiB; immutable exact capture and lifecycle are not tunable.

**AG-D19 — Transcript append has one crash-consistent immutable-head protocol.** **Decision:** §2.4.1 uses monotone session sequences,
provider-event idempotency digests, 64 KiB/256-event hash-linked chunks, write+sync+verify then atomic session-catalog/head publication, bounded out-of-order
buffering, explicit orphan/missing-head recovery, disk-full interruption, and delete-versus-turn serialization. No automatic retention
silently truncates finalized content. **Derivation:** X1; P1; PROJECT-FORMAT immutable store/transactional publication/product data;
SYSTEM-001; Function Contract C4/E2. **Rejected:** renderer-owned events; object write without atomic head; best-effort ordering; delete racing
a live turn; unbounded memory fallback on disk full. **Tunable:** yes — chunk/event/buffer/time ceilings, not ordering, idempotency, or
atomic-head semantics.

**AG-D20 — Journal attribution is versioned, deterministic, and privacy-safe.** **Decision:** canonical transaction and
`CanonicalJournalEntry` gain `JournalActorV1 { origin, local_session_id?, local_turn_id?, display_label }` plus optional
`AgentBatchV1 { batch_id, batch_ordinal, child_command_ids }`. `origin` is one of `user_ui | agent | python_sdk | console | system |
legacy`; Agent entries require stable project-local UUID session/turn ids. `display_label` is the fixed origin label (for example `Agent`),
never a user session name, provider identity, credential, or resume token. Actor and batch bytes participate in deterministic transaction
serialization/hash. Forward, undo, and redo record the initiating actor; compensation retains `related_command_id`, so UI may resolve the
original actor without copying it. Replay and archive load preserve bytes; session deletion leaves actor ids intact but may resolve the name
as **Deleted Agent session**. Old entries migrate logically to `{origin: legacy, display_label: Legacy}` with null ids and unchanged command
hash; the format version and generated Rust/TypeScript/Python models advance together. Unknown actor versions force read-only preservation,
never writable discard. **Derivation:** X3 attribution/batch parity; PROJECT-FORMAT canonical-journal actor and migration rules; X1 privacy;
Function Contract A3/C4. **Rejected:** transcript-only attribution; user-provided names/provider tokens in journal; nondeterministic lookup at
hash time; rewriting legacy command hashes. **Tunable:** no.

**AG-D21 — Sibling support is capability-negotiated and unknown Agent data is preserved.** **Decision:** §3.1 E2's per-product/package matrix
is binding: only Builder exposes this catalog; PhotoLab exposes its own profile, WeltView is read-only, Cap is unaffected, and shared hosts/
clients fail closed. Any compatible archive round-trip preserves unknown Agent product data and actor versions byte-for-byte.
**Derivation:** AGENTS sibling-app/shared-core principle; ADR 0024 capability negotiation; PROJECT-FORMAT unknown-content preservation;
SYSTEM-001 passive-consumer rule. **Rejected:** generated-method presence implies app support; silently dropping unknown Agent data; giving
every sibling an Agent UI regardless of domain. **Tunable:** no.

## 6. Current implementation delta

**Exists and stays:** Codex/Claude/OpenCode discovery and compatibility checks (`drivers.ts:24–85,302–373`); frozen executable identity and
fail-closed schema binding (`drivers.ts:123–156`); provider-specific normalization plus bounded/redacted events (`normalize.ts:1–269`;
`events.ts:1–96,108–207`; `queue.ts:14–80,83–134`); timeline caps, stable row derivation, and bounded streamed append
(`packages/@himmelcad/agent/src/timeline.ts:4–6,87–104,201–235`; existing bound test
`packages/@himmelcad/agent/src/timeline.test.ts:65–79`); virtualization,
scroll anchoring, and text-selection retention (`VirtualAgentTimeline.tsx:37–160`); send/interrupt/resume and visible harness picker
(`ManagedAgentChat.tsx:104–172,175–198,247–275`; `AgentChatPanel.tsx:94–138`); provider credential secure/session states
(`providerCredentials.ts:3–20,68–138`); product confirmation with loss/conflict counts (`ManagedAutomationApproval.tsx:35–65`); read-only
sandbox, provider-only egress, private SDK bridge, paginated entity queries, bulk leases, plan validation, and single-use confirmation
grants (`automation-host/index.cjs:79–101,245–340,701–724,801–850`; `automation_runtime.rs:28–34,356–445,604–765`); private
descriptor/socket transport (`runtime/python/himmelcad_host.py:1–5,24–68,85–109`); generated sync/async Python client
(`sdk/python/src/himmelcad/client.py:1,87–229,232–374`).

**Changes:** current Project ▸ File ▸ Agent placement moves to File ▸ Agent under owner decision D2; Agent island close changes unmount/stop
→ hide/keep-alive; renderer-local event/ref ownership moves to a main-owned session/job service; sanitized finalized events persist through
AG-D19's immutable chunk/head protocol; product/harness approval cards become one product-authority queue whose Confirm/Deny IPC is
user-only by AG-D5; provider credential/status model generalizes beyond Codex without exposing secrets; system prompt keeps five lines but
points to hard-capped generated indexes; generated help uses AG-D3's full-fragment/hash manifest; host/schema/SDK allowlists gain only the
IF-D12-bounded §3.3 public methods, reject `io.import.execute`, all `registration.*`, and all approval responses, and route I/O through
brokered handles; Agent batch roots and `JournalActorV1` enter the canonical journal/migrations/models; all projections pass AG-D15 before
immutable creation.

**New:** session browser/name/delete/restore; native resume binding and new-thread fallback; Agent job integration; prompt/draft recovery;
structured entity mention tokens, captured-selection objects/pages, and one-shot pick tool; Skills list/reader/editor/import, frontmatter
validator, immutable project skill records, built-in inventory including `restore-last-viewing-box`; schema/spec-bound documentation
generator and local help index; generated `help.*`/`skills.*` sync+async SDK methods; Settings ▸ Agent multi-harness page; passive bounded
grant requests, OS-handle source/target broker and active-grants view; transcript sanitizer/redaction schema; scripted harness and §7 gates.

Known absence checks were dossier-/implementation-wide where claimed. No cited stub or placeholder is counted as existing: specifically
`SKILLS.md` and `SDK.md` are missing product capability despite their current files.

## 7. Verification plan (per `docs/TEST-TIERS.md`)

- **changed — `pnpm verify:changed`:** `@himmelcad/agent` tests cover session reducer, restart rehydrate, interrupted marking,
  one-turn-per-session, provider pinning, prompt/draft recovery, ordinary mentions, the 1,001/100,000-entity captured-selection threshold,
  digest stability, 256-item/32-KiB paging, selection-change independence, stale/deleted aggregates, restart/archive lifecycle, every
  mouse/touch gesture row in §3.1, and free-text Escape. Sanitizer fixtures paste and provider-echo credentials, raw paths, nonces, lease
  tokens, hidden reasoning, marked spans, malformed events, errors, previews, and console output; inspect `.hcadx`/Save As bytes, delete,
  undo, and export projections for forbidden content. Transcript store tests inject duplicate/out-of-order events, disk full, deletion
  during a turn, and a kill at every chunk write/sync/verify/head-publication phase. Rust canonical tests commit a 40-child Agent action as
  one root/one visible undo while preserving unrelated later fields; verify cancel/failure before root publication; round-trip
  `JournalActorV1`/`AgentBatchV1`, forward/undo/redo/replay, deterministic serialization, legacy migration, session deletion, and unknown
  actor read-only preservation.
- **changed — host security matrix:** schema, generated clients, Agent harness, generated Python, scripted harness, direct sidecar, replayed
  IPC, and a different window/session all reject approval responses, confirmation grant minting, credential methods, `io.import.execute`,
  and every `registration.*` method. A public grant request opens no picker/modal, duplicate requests coalesce, ceilings/throttle bound
  memory, blur/provider death/project close expire correctly, and only a fresh foreground click in the owning window can open the picker.
- **push, automation schema risk — `automation.sdk` (existing stable gate):** generated sync/async methods and models match schema;
  source/generated hashes current; public `io.import`, `io.probe`, export, help, skills, session/grant/reference methods negotiate only
  declared capabilities; forbidden trust/app-private methods are absent and guessed calls fail closed; no method bypasses expected revision
  or owning canonical command validation.
- **push — G-AG-DOC, `pnpm test:agent:docs`:** build twice byte-identical and validate every AG-D3 manifest field/output hash. Mutate content
  beneath an unchanged heading, command/access/approval posture, schema, generator version, domain list, and generated output by hand; each
  must fail. Omit a domain and fail. Package projection must byte-match. `/workspace/SKILLS.md` contains zero bodies and both indexes stay
  ≤4 KiB with 10,000 fixture skills or generation fails; `search/open/read/page` enforce item, byte, and measured-token ceilings.
- **push, browser — G-AG-UI, `pnpm test:agent:ui-perf`:** self-launch Builder with 100,000 fixture rows; streaming + typing p95 frame
  interval ≤2× target, input echo ≤50 ms p95; scroll anchor and selected transcript text survive row updates; every §3.1 pointer/touch row
  is exercised, including entity versus void/cloud double-click/double-tap, tap-again, tap-hold, cloud via RMB/tree, Escape prompt
  retention, and other-tool rejection. Delete says Recoverable with Undo; passive grant request causes no focus/modal change; both-theme
  state captures feed §8.
- **push, electron/sidecar — G-AG-IO, `pnpm test:automation:io-grants`:** source picker fixture → brokered handle → probe → public
  `io.import`; incomplete recipe returns `needsUserInput`/optional job and no private registration route. Import commit blocks until exact
  user-only confirmation and stale plan rejects. Target handle → export plan → user-only confirm → execute; accepted no-clobber/replace and
  multi-file atomicity disclosure are exact. Raw path, wrong method, symlink swap, rename swap, mount replacement, source metadata/identity
  change, target creation after approval, and overwrite-target identity change all reject and require re-plan; cancelled/crashed candidates
  clean up while an existing target survives. Deny/expiry/project close revoke authority; same-target exports serialize/re-plan.
- **push, browser + electron — G-AG-E2E, `pnpm test:agent:e2e`:** deterministic scripted harness starts Builder, opens a fixture whose two
  saved boxes were explicitly deactivated before close, and receives “restore the last viewing box.” Assert exactly one help result, one
  `restore-last-viewing-box` skill read, zero `help.open`/journal reads, one
  `viewing_box.list(order=last_activated_generation_desc,limit=1,state=surviving)`, and one
  `viewing_box.activate(id,expected_revision)`. Total injected support context must be ≤12 KiB and ≤3,072 measured tokens, skill ≤4 KiB/
  1,024 tokens; exceeding either fails before injection. Verify the journal-newest surviving box, viewport chip, transcript, attributed
  console/journal actor, one-step Ctrl+Z, no approval, island hide during turn, renderer reload rehydration, app restart interrupted/resume,
  and zero restored grants. The I/O scenario uses passive source card → foreground picker → ambiguous IF-D13 choice → public `io.import` →
  visible user-owned registration when needed → user-only confirmed commit → passive target card → confirmed export.
- **release:** G-AG-E2E and `automation.sdk` always; `linux-package` and `windows-package` verify generated docs/skills/runtime inventory,
  user-activation/picker and brokered-handle behavior. `real-data` repeats G-AG-IO with large LAS/E57 and multi-file outputs. Cross-product
  fixtures prove PhotoLab preserves unknown Builder Agent data/actor versions on compatible open-save, WeltView opens read-only without
  loss, Cap `.hcap` stays unaffected, and unsupported app profiles fail closed. Existing automation runtime staging gates remain
  dependency-ordered per TEST-TIERS.
- **manual/visual:** compare screenshots and scripted states against §8 in dark and light themes; keyboard-only and screen-reader pass for
  session list, mention tokens, editor, approval, and provider settings.

Explicitly unverified: semantic usefulness/truthfulness of third-party model answers beyond deterministic scripted outputs; provider-native
resume support for versions not installed on the verifier; real OS keyring behavior outside native release runners; subjective copy quality
beyond the failable criteria.

## 8. E1 — visual and behavioral criteria (failable, in repo)

All screenshots are captured in both themes and use only shared `--hc-*` tokens; source grep fails hardcoded colors/gradients in new
modules.

1. **Persistent island:** header shows “Agent,” current named session, harness
   - version, hide x, and no modal treatment. Hiding/reopening produces an equal-content screenshot at equal size (apart from
     elapsed/progress text), same scroll anchor, and same unsent prompt. Escape produces no visibility or prompt diff.
2. **Transcript scale:** at 100,000 rows, DOM row count stays within the calculated virtual range + overscan, no row overlaps, selected text
   remains selected after a streaming update, and “new output” follows bottom only when the user was already at bottom.
3. **Activity and attribution:** a canonical Agent act shows command label, target, running/completed/failed state in one stable card;
   corresponding console text begins “Agent · <session> ·”; canonical journal fixture contains the same `JournalActorV1` session/turn ids.
   A 40-child action renders one root card and one **Undo Agent action**, and the undo fixture has one compensating root. A view-local act has
   no journal entry and still has timeline + console evidence.
4. **Approval:** an automation request produces only a passive card and no focus/modal diff. Exactly one foreground alert appears only after
   a trusted user click on that card. It names action, source/target basename, provider,
   added/removed/overwritten counts, losses/conflicts, and consequence; Deny is first, Confirm uses the primary accent, focus is
   trapped/restored, and no raw path/token/secret is rendered. Import says “Confirm import”; export says “Confirm export.” Another window,
   replayed event, Agent, and Python cannot change the card's disposition.
5. **Mentions:** tokens are compact, keyboard-focusable, show entity name + kind without raw JSON, distinguish stale/deleted state, and
   offer separate Select and Frame actions. A point-cloud token created through tree/RMB is visually identical to a normal entity token; no
   per-point highlight is introduced. A captured selection is one token reading `Selection · N entities`, with pageable details and
   stale/deleted counts; it never expands 100,000 chips into the composer.
6. **Skills:** list clearly badges Built-in vs Project; built-ins show no edit/ delete actions. Editor source/preview split remains usable
   at 1024×768; invalid frontmatter marks exact lines/fields, Save disables, and no invalid skill appears in discovery. Closing/hiding
   retains a visible draft indicator.
7. **Help/on-demand proof:** initial transcript state sample shows only the five-line bootstrap. The restore workflow sequence is exactly one
   `help.search` → one `skills.read(restore-last-viewing-box)` → one bounded `viewing_box.list` → one `viewing_box.activate`; no `help.open`,
   journal read, skill bundle, or full domain manual. Byte and measured-token counters are visible in the scripted state and fail at the
   AG-D1 ceilings.
8. **Providers and grants:** Settings shows all three harness rows even when missing/incompatible, with sentence-case actionable status and
   no secret. Permission bar distinguishes project SDK, workspace read-only, provider-only network, and active source/target grants.
   Revocation removes the grant chip immediately and dependent pending actions become visibly unavailable. Pending-card ceilings and
   throttling use one non-modal status row; no native picker opens while the owning window is backgrounded.
9. **Transcript privacy and deletion:** redacted segments render a typed label, never removed bytes; a sanitizer/storage failure visibly says
   **Not stored** and cannot resemble completion. Delete session copy says **Recoverable with Undo**; no surface says secure delete/purge.

## 9. Cross-spec dispositions and remaining implementation requests

| Source capability                                    | Disposition here                                                                                                                                                     | Remaining action                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UIP-D10 job registry                                 | adopted: every turn and long I/O operation registers                                                                                                                 | none; ui-platform already names Agent runs                                                                                                                                         |
| UIP-D14 Agent workspace/free-text and §3.6 gestures  | adopted exactly; no Escape close/discard; §3.1 enumerates all pointer/touch extremes                                                                                 | applied: the consolidated Registry carries the gesture merge and collision check                                                                                                   |
| Viewing-box §1.4/B1, VB-D1/VB-D2                     | adopted: reopen restores exact active/deactivated state; activation command is exactly `viewing_box.activate`                                                        | applied: VB-D1/VB-D2 and the Registry define the bounded, indexed `viewing_box.list(order: last_activated_generation_desc, limit, state: surviving)` projection consumed by AG-D12 |
| File-project FP-D11                                  | adopted: Ctrl+Z walks the latest root and preserves unrelated later fields                                                                                           | applied: FP-D11 cites X3/AG-D14 and makes one presented Agent action one batch root with child audit records                                                                       |
| File-project FP-D5/§1.6                              | adopted for external export planning/loss/confirmation; AG-D17 supplies handle-bound publication detail                                                              | applied: FP-D5 cites AG-D17 for target-identity revalidation and the multi-file non-atomic disclosure limit                                                                        |
| File-project project-close automation lifecycle (E2) | adopted: revoke runtime authority, retain sanitized transcript                                                                                                       | none                                                                                                                                                                               |
| Import-formats IF-D12                                | reconciled 2026-09-02: public `io.probe`/`io.import` plus bounded `io.operation.status/cancel`; low-level facade and every `registration.*` method remain non-public | none; IF-D12 now cites AG-D4/AG-D5 and defines the bounded projection without resources, samples, point pairs, preview payloads, grants, or nonces                                 |
| Import-formats IF-D13                                | adopted unchanged: ambiguity is a user choice/structured error                                                                                                       | none                                                                                                                                                                               |
| Canonical journal/project format                     | AG-D20 defines actor/batch version, migration, deterministic serialization, and unknown-version preservation                                                         | canonical core/project-format owner must add the versioned fields/migration and generated Rust/TypeScript/Python models before Agent attribution ships                             |
| Shared sibling/archive consumers                     | AG-D21 and §3.1 E2 define app profiles and preservation behavior                                                                                                     | PhotoLab/WeltView/shared-store owners add fail-closed negotiation and compatible `.hcadx` unknown-Agent-data round-trip fixtures; Cap remains unchanged                            |
| `docs/builder-program/REGISTRY.md`                   | all Agent rows, approval/grant acts, shortcuts and gesture claims are registered; F8 and Agent findings are closed in the 2026-09-02 rebuild                         | none                                                                                                                                                                               |
| Automation schema/shared SDK                         | additive methods only under AG-D13; forbidden methods structurally absent                                                                                            | sequence schema/generator/host revision with the registry rebuild and run `automation.sdk`                                                                                         |

## 10. Owner-decision items

None. Candidate questions were subjected to the doctrine escalation protocol:

- _“May project skills override built-ins?”_ X1 security and ADR 0024’s trust boundary reject shadowing; no axiom conflict or reserved owner
  boundary.
- _“Should prompts/transcripts travel with the project?”_ X3/P1 plus PROJECT-FORMAT product data decide yes for finalized content; ADR 0024
  decides provider tokens/grants stay local, and X1 requires pre-persistence sanitization. The apparent privacy/security conflict dissolves
  by separating sanitized transcript, authority, and secure provider binding (AG-D6/AG-D15/AG-D19).
- _“Do import commits and exports need confirmation?”_ IF-D12 already binds import; ADR 0024 binds externally visible export; reads/previews
  remain unapproved to avoid indiscriminate prompts (AG-D5).
- _“Can the Agent invoke registration methods?”_ IF-D12 already says no: public `io.import` orchestrates a complete recipe or yields
  `needsUserInput`; interactive registration remains in its owning UI. X3 parity is satisfied through the public outcome, not low-level
  method parity (AG-D4).
- _“What does ‘last viewing box’ mean?”_ viewing-box §1.4 and P1 select latest activation; X1/X2 require the bounded indexed form, and exact
  reopen/activation semantics come from viewing-box §1.4/B1 and VB-D1/VB-D2 (AG-D12).
- _“How is one Agent action undone?”_ X3 now explicitly binds the user-visible action unit; FP-D11 supplies root compensation (AG-D14).
- _“Can the same principal approve?”_ X3, Function Contract B1, and ADR 0024 make trust responses user-only by construction (AG-D5).
- _“May Agent close on Escape?”_ UIP-D14 already answers no.
- _“How large/fast?”_ X6/P3 delegate every threshold recorded tunable above.

No candidate survives all three escalation conditions: none presents an axiom conflict, product identity/money/licensing choice, scope
freeze, or explicitly reserved owner boundary.

## 11. Disposition — adversarial review 2026-09-02

The review disposition was “reject as specified” with 4 blockers, 10 majors, and 2 minors. All 16 findings are resolved in this
specification text. Finding 3 is now closed by the consolidated registry merge
and clean consistency checks; the status is `specified`. No blocker or major
relies on this table alone.

| Finding                                                              | Disposition                                                                                                                                                                                              | Spec section / decision                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 — automation could approve itself                                  | **Resolved:** removed `agent.approval.respond`; principal matrix and host/schema structural absence bind Confirm/Deny to foreground user UI and exact one-use request identity                           | §1 `agent.approval`; §3.1 B1; §2.3; AG-D5; §7 host security matrix |
| 2 — Agent contradicted IF-D12/public import owner                    | **Resolved:** adopted IF-D12 without re-disposition: public `io.import`; app-private `io.import.execute` and all `registration.*` reject; residual bounded status request recorded for the owner         | §0; §2.3; §3.3 B1; AG-D4/AG-D13; §9                                |
| 3 — Agent absent from central registry                               | **Resolved:** §1 includes every central column and the round-3 registry records Agent plus P11/PhotoLab exposure rows with no collision.                                                                 | status; §0; §1; §9; REGISTRY §1.12                                 |
| 4 — restore workflow unbounded/nondeterministic/reopen contradiction | **Resolved:** starts after explicit deactivation; exact one-result indexed query and exact `viewing_box.activate`; no journal scan; exact built-in, call count, byte/token ceilings, fail-closed gate    | §2.1; AG-D1/AG-D12; G-AG-E2E; §9 viewing-box request               |
| 5 — 40-command Agent result needs 40 undos                           | **Resolved:** one presented action is one all-or-none journal root with child audits, serialization/cancel boundaries, Ctrl+Z and Undo Agent action once; non-atomic work cannot be labeled one batch    | §2.5; §3.1 C4; AG-D14; §7 40-child test                            |
| 6 — transcript-borne secrets persisted/delete implied erasure        | **Resolved:** closed sanitized schema and pre-persistence boundary across every projection; fail-closed behavior; ordinary Delete labeled recoverable; no purge claim                                    | §2.4.1; AG-D15/AG-D19; §7 sanitizer/archive/delete gates; §8.9     |
| 7 — automation could spam pickers/approval UI                        | **Resolved:** request is passive/idempotent; fresh foreground click required; picker/pending ceilings, coalescing, throttle, hide/blur/close/provider/expiry outcomes and abuse tests specified          | §2.3; §3.3 B2; AG-D16; §7/§8.4/§8.8                                |
| 8 — canonical path did not prevent substitution                      | **Resolved:** brokered no-follow handles/platform identity, target-parent binding, execute-time revalidation, explicit rename semantics, swap/mount/collision tests                                      | §2.3; §3.3 C3/E2; AG-D17; G-AG-IO                                  |
| 9 — generated docs could drift behind valid anchors                  | **Resolved:** deterministic normalized full-fragment extraction and checked manifest/output hashes; same-anchor/semantic/omission/hand-edit/package tests                                                | §2.2.2; §3.2 E2/E3; AG-D3; G-AG-DOC                                |
| 10 — double-click/touch gesture contradictions                       | **Resolved:** entity versus void/cloud double-click split; tap, tap-again, tap-hold, and double-tap enumerated with armed-state results; every row tested                                                | §3.1 E2 gesture table; AG-D11; G-AG-UI                             |
| 11 — undefined large named-selection query                           | **Resolved:** immutable `CapturedSelectionReferenceV1`, capture/page commands, exact refs/digest, bounded pages, stale/deleted aggregates, lifecycle/archive/GC/undo policy and 1,001/100,000 tests      | §1 `agent.reference`; §2.5; §3.1 C2; AG-D18; §7                    |
| 12 — journal actor schema/migration absent                           | **Resolved:** exact `JournalActorV1`/`AgentBatchV1`, core entry/transaction placement, hashing, forward/undo/redo/replay, privacy, deletion, legacy and unknown-version behavior, generated models/tests | §2.5; AG-D20; §6; §7; §9 core request                              |
| 13 — sibling-app passive consumers unspecified                       | **Resolved:** Builder/PhotoLab/WeltView/Cap and shared host/app/data behavior enumerated; unsupported methods fail closed and compatible archive round-trips preserve unknown Agent data                 | §3.1 E2 matrix; AG-D21; §7 release; §9                             |
| 14 — transcript append/delete crash boundary absent                  | **Resolved:** hash-linked chunks, monotone sequence, idempotency, atomic head, acknowledgement, orphan/corrupt/disk-full recovery, retention, delete/turn serialization and kill-point gates             | §2.4.1; AG-D19; §7                                                 |
| 15 — bounded timeline citation wrong                                 | **Resolved:** citation split across caps, derivation, append implementation, and existing bound test                                                                                                     | §6 Exists and stays                                                |
| 16 — wrong authority for external-export atomicity                   | **Resolved:** adopted file-project FP-D5/§1.6; specified sibling candidate/flush/atomic rename, overwrite/no-clobber, cancellation/crash, and honest multi-file limit                                    | §2.3; §3.3 E2; AG-D17; G-AG-IO; §9                                 |

## Cross-spec reconciliation 2026-09-02

| Item                                  | Disposition                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IF-D12 registration boundary          | Reconciled both ways: public `io.import` plus bounded `io.operation.status/cancel`; `io.import.execute` and every `registration.*` method are app-private; approval responses remain user-only (AG-D4/AG-D5). |
| Viewing-box restore query             | VB §1.4 now defines the bounded indexed `viewing_box.list` order/limit/tie/deletion contract consumed by AG-D12.                                                                                              |
| File undo/export                      | FP-D11 cites AG-D14 one-root Agent batches; FP-D5 cites AG-D17 handle-bound publication.                                                                                                                      |
| P11 and PhotoLab product registration | AG-D4/AG-D13 cite P11 and IF-D20: the generated command table includes `io.import.product_dataset.list/register`; no raw-RPC allowlist or trust-response method is admitted.                                  |
| P10/G12 automation                    | AG-D22 mirrors MT-D25 common operations and the typed DR-D20/CIV-D15/RA-D15/BS-D24 payload/status schemas; it adds no Agent recipe lifecycle.                                                                 |
| Semantic cursor                       | Agent cites UIP-D24/§9.7: a user-pick request may show the owning domain's pick/snap/Fangkreis or Shared3DTarget plus prohibited/wait, but Agent cannot simulate or confirm the pointer gesture.              |
| GAP §6 Civil inbound                  | AG-D3–AG-D5/AG-D13/AG-D17 are amended by AG-D22's generated parity for CIV-D1–CIV-D24; Agent adds no Civil command or trust semantics.                                                                        |
| Re-walk 2026-09-02                    | Complies with P5/P6/P7 and current C4/D1/X3/B1/A2 rules: transcript/journal writes are off interaction paths; universal affordances and user-only trust surfaces remain; no office convention is mandated.    |

## Owner statements batch 2 — 2026-09-02

This section amends AG-D3–D5/D13/D17 and the generated catalog. The schema
generator mirrors, without alternate semantics, the new owner commands/queries and
capability flags for: P9 node/effective state and causes; selectable kinds and
Whole/Segments; the four named history paths; Draw line/point/reticle/station-offset/
offset recipes; Pointcloud mean-grid/station-corridor sampling; Mesh source roles,
exclusions, crop, surface dependency state, convex hull and solids; View rigid
sections; Plan layout/captures; BIM component manifests/generated recipes/strata;
Raster difference Grid/legend and drape recipes; and File persistence/export-loss
plans. All long work returns UIP-D10 job ids/status/cancel; reads page; writes require
expected revisions.

One presented Agent action still forms one all-or-none AG-D14 batch root. Recipe
regeneration/detach, surface/solid creation, imports, and exports use their owning
approval/publication rules; the Agent cannot answer confirmations, choose
credentials, or bypass creation Check/error lists. C1 numeric fields are ordinary
typed command parameters; UI-only pointer previews are not simulated as authority.

**AG-D22 — Batch-2 automation is generated owner parity.** **Decision:** the
generated schema/catalog/SDK expose the complete owner list above, including P8/P9/
P10 states and capabilities, with one batch root and user-only trust boundaries.
**Derivation:** C1, P8, P9, P10, X3, ADR 0024, AG-D3/D5/D13/D14/D17, owning
records UIP-D19–D22, DR-D17–D20, PC-D17/D18, MT-D25–D27, VD-D14/D15,
PE-D20/D21, SE-D19/D20, BS-D23–D25, RA-D14/D15, FP-D21/D22. **Rejected:**
handwritten Agent-only wrappers; omitted capability flags; automation approval;
simulated pointer gestures. **Tunable:** page and batch ceilings only.

Generation checks fail on missing owner act/query/capability, duplicate semantic
act, non-paged large result, unbounded job, missing expected revision, or any public
trust-response method. End-to-end fixtures cover a 40-child mixed batch, cancellation
before publication, stale/detach/DAG errors, and deterministic Rust/TypeScript/Python
docs hashes.

| Work-order item                           | Disposition                                                    |
| ----------------------------------------- | -------------------------------------------------------------- |
| S1–S14/G1–G12 canonical automation parity | Applied by AG-D22 as generated mirrors only.                   |
| P8/P9/P10 capability/state exposure       | Applied; user-only trust decisions remain structurally absent. |
