# M11 implementation plan: Python SDK and agent chat

Status: implementation completed on 2026-07-20; final integrated release
verification remains in progress. This record does not substitute for the
capability-owned release gates.

## Outcome

HimmelCAD exposes one versioned automation protocol whose queries and commands
enter the same canonical dispatcher, journal and compare-and-swap checks as the
desktop UI. A generated synchronous and asynchronous Python SDK uses that
protocol. Builder and PhotoLab may host a virtualized chat UI which discovers
installed Codex, Claude and OpenCode CLI harnesses, but no harness owns or
mutates a second project model.

## Non-negotiable boundaries

- The language-neutral automation schema is the source for generated clients.
  Hand-written Python DTO copies are not accepted.
- UI, Python and agent operations all reach the canonical application runtime.
  A harness never edits project persistence or an in-memory mirror directly.
- Every mutation is an explicit canonical command transaction with a command
  ID, expected revisions/hashes and one journal entry or no change.
- Entity and property reads are cursor-paginated and have hard item and byte
  limits. Stable cursors bind to a snapshot generation.
- Large geometry, images and screenshots use bounded bulk-data leases. JSON
  messages contain descriptors, never unbounded arrays or opaque filesystem
  paths.
- Python runs out of process in a managed, pinned environment. Network is off
  by default and project/filesystem access is capability-scoped.
- Destructive commands require an explicit product confirmation. A CLI
  harness's own approval setting cannot weaken the product boundary.
- Provider/harness conversation state is presentation state. The canonical
  project and journal remain recoverable without it.

## Protocol surface

Protocol negotiation advertises exact version and capabilities. Unknown
required capabilities fail closed; optional capabilities may be absent.

### Existing canonical wire methods

The SDK schema reuses `app.negotiate`, `app.protocol`, `view.state.get`,
`view.state.set` and `view.screenshot`. The `app.protocol` request envelope
already owns snapshots, journal pages, property schemas/queries, property-edit
compilation and canonical transaction execution. The SDK may expose clearer
high-level Python method names, but it must not create duplicate wire methods or
a second dispatcher for those operations.

### Additional queries

- `automation.entities.page`: stable generation, cursor, limit, optional type,
  hierarchy and bounds filters; returns compact entity envelopes and next
  cursor.
- `automation.cas.describe`: content hash, media type, logical shape and byte
  length; no host path.

### Commands

- `automation.commands.validate`: validate and return the exact loss/conflict
  plan without mutation.
- `automation.commands.status` and `.cancel`: progress and cooperative
  cancellation for long operations.
- Commit uses `app.protocol` with `executeCanonicalTransaction`; it is not
  duplicated under the automation namespace.
- Existing property batch/match edits are expressed as canonical transactions,
  not a Python-only shortcut.

### View control

- Reuse `view.state.get`/`view.state.set` and `himmelcad.view-state` version 1
  for camera, navigation mode,
  visibility, selection, scoped clips and presentation.
- Reuse `view.screenshot` plus `himmelcad.screenshot-request` and result
  contracts. A screenshot is
  produced by the product renderer and respects its explicit UI/background
  flags.
- Screenshot image bytes should move through a lease when they exceed the
  inline response ceiling.

### Bulk leases

A lease descriptor contains:

- opaque lease ID and access token scoped to the negotiated session;
- immutable content hash and media/element type;
- typed shape, endianness and byte length;
- expiry, maximum readable range and remaining read budget;
- source entity revision/hash where applicable.

Reads are bounded ranges. Leases are revoked on explicit release, session
close, cancellation, process restart or expiry. A consumer verifies the final
content hash. Project storage paths are never returned. Initial formats cover
interleaved point positions/attributes, triangle vertices/indices, raster/image
bytes and screenshot bytes. NumPy views are read-only unless a new command
explicitly uploads a replacement artifact.

## Generated Python package

Package name: `himmelcad`. Supported runtime: pinned CPython 3.12 for the
managed product environment; ordinary users may install the wheel on supported
CPython versions declared by the package.

Generated output includes:

- immutable typed request/response models;
- `HimmelCadClient` and `AsyncHimmelCadClient`;
- iterators/async iterators which follow pages without hiding generation
  changes;
- transaction builder with explicit expected revisions;
- context-managed bulk leases with NumPy zero-/single-copy adapters;
- view/camera and screenshot helpers;
- structured protocol, conflict, capability, expiry and cancellation errors.

The generator emits a manifest containing schema hash, generator version and
all output hashes. `--check` regenerates in a temporary directory and fails on
any drift. Changed/push verification runs this only when the schema, generator
or generated package changed; release verification always runs it.

The managed environment is created from a hash-locked runtime manifest. It is
not allowed to download packages during an agent run. A support inventory
reports Python/runtime/package hashes without secrets or user paths.

### Reproducible managed-runtime gates

The release manifest pins CPython 3.12.13 and every platform archive and wheel
by SHA-256. It additionally pins the automation schema, SDK generator,
generator manifest and Python host transport. Staging verifies those source
pins, every generated contract input and output, artifact hashes and declared
byte lengths before publishing anything.

For both `linux-x64` and `win32-x64`, staging:

1. validates archive entry count, paths, extracted symlinks and file types;
2. installs only the manifest wheels with `--no-index --no-deps`;
3. copies the generated SDK and the private host transport into the managed
   runtime;
4. removes `pip`, `ensurepip` and their launchers and verifies that neither can
   be imported;
5. imports the SDK, NumPy, Pillow and headless OpenCV and records their exact
   versions; and
6. atomically publishes a platform-specific runtime inventory containing all
   source and artifact hashes and the release-eligibility result.

The Windows manifest contains release-eligible, deterministic HimmelCAD wheels
for NumPy 2.2.6 and headless OpenCV 4.13.0. Their exact CPython runtime is also
covered by dynamic Wine smoke tests for NumPy's float/complex BLAS and LAPACK
paths, failure cases and concurrency, plus OpenCV PNG and SIFT operations. A
native Windows package runner still owns the authoritative Windows staging and
install certification; a foreign-platform smoke is additional evidence, not a
replacement.

## Harness adapters and chat

Discovery is read-only and deterministic:

1. resolve each supported executable from the host-approved PATH;
2. record canonical executable identity and `--version` output;
3. probe supported transport/capabilities with a timeout;
4. present unavailable/incompatible harnesses as actionable UI states;
5. freeze the selected executable identity and adapter version for a thread.

The production desktop host executes Codex through the stable
`codex exec --json` surface. The adapter models the version-bound app-server
handshake (`initialize`/`initialized`), but the host does not advertise or
enable that experimental mode until its CLI/schema pair has a separate audit.
See the official [Codex app-server documentation](https://developers.openai.com/codex/app-server/)
and [non-interactive mode](https://developers.openai.com/codex/non-interactive/).

The same production host executes Claude through
`claude -p --output-format stream-json` and OpenCode through
`opencode --pure run --format json`. Prompts are supplied over standard input,
never as command-line arguments. Each turn receives its system prompt through
a private mode-`0600` file in the read-only automation bridge. Claude disables
session persistence and external MCP servers. OpenCode receives a
host-generated agent configuration which denies edit, task, web, external
directory, question and doom-loop capabilities while retaining the audited
read and shell surface. Both adapters parse chunked NDJSON fail-closed, reap
their process groups on cancel/error and retain the same AF_UNIX SDK bridge as
Codex.

Absence of Claude or OpenCode is normal and does not block Codex or Python SDK
use. Their host adapters are covered through real Bubblewrap, managed CPython,
SDK and RPC routing with identity/version-compatible CLI fixtures for Claude
Code 2.1.211 and OpenCode 1.15.11. Those two real executables were not installed
on the implementation workstation, so a native installed-CLI smoke remains
release-runner evidence rather than being inferred from the fixtures.
`providerOnly` remains deliberately Codex-only: Claude and OpenCode fail closed
until each provider has a separately audited credential and exact-egress
manifest.

Normalized events include thread/turn state, user and agent messages,
reasoning summaries where exposed, command/tool lifecycle, file changes,
approval requests, errors and usage. Raw provider payloads may be retained in a
bounded diagnostic log, but product rendering consumes only the normalized
versioned model.

The T3 Code vendor slice is limited to the audited provider-driver/adapter
shape, stable timeline row derivation, reference reuse, virtualized rendering
and scroll anchoring. It excludes project/worktree authority, Git mutations,
remote/account/update/telemetry systems and upstream persistence. Exact source
commit, license and local modifications are recorded in
`docs/feasibility/t3code-vendor-slice.md` and `LICENSES/THIRD_PARTY.md`.

### Chat UI acceptance behavior

- Open from a shared function tab/modal in Builder and PhotoLab.
- Smoothly render and scroll a synthetic thread with at least 100,000 timeline
  rows while retaining bottom anchoring only when the user was already at the
  bottom.
- Preserve selection and scroll position as streamed rows grow or prior
  history is prepended.
- Show active harness, version, permissions, network state and workspace scope.
- Provide interrupt, resume/retry and clear error states.
- Render commands, approvals and file changes distinctly from assistant text.
- Never inject geometry arrays into the transcript; the system prompt points to
  the generated SDK documentation and capabilities.

## Security and execution policy

- Default Python and harness turns have no network access.
- Default filesystem scope is read-only product/project capability access;
  workspace writes require a per-thread/turn grant.
- The product asks before destructive canonical commands and before broadening
  filesystem or network access.
- Environment variables are allowlisted. Provider credentials are never
  inherited by the harness process, renderer, managed Python process or SDK;
  logs, normalized events and support bundles never contain them.
- Process groups receive cooperative cancel, then bounded termination. Child
  processes cannot outlive the owning session.
- Stdout/stderr/event queues, message sizes and diagnostic retention are
  bounded to prevent memory and disk exhaustion.

### Credential and provider-egress trust boundary

Builder and PhotoLab keep Codex credentials in a main-process-only store. The
renderer-facing IPC exposes only bounded status, replace, clear-session and
delete operations to the owning main frame at the exact application URL; there
is no credential getter. Persistent credentials use Electron SafeStorage only
when its operating-system backend is considered secure. Session-only storage
is explicit, and replacement, removal, renderer destruction and navigation
serialize session invalidation before the new state becomes usable.

Harness discovery advertises `providerOnly` only when the credential is usable
and the host has the audited egress capability. The ordinary state remains
network-disabled. A provider-enabled Codex turn runs inside a Bubblewrap
network namespace with a read-only workspace and managed runtime. It can reach
only a mode-specific loopback relay; it cannot open direct external sockets.
The relay crosses a mode-`0600` Unix socket to a host broker which:

- accepts exactly `POST /v1/responses` for the exact credential-free HTTPS
  origin (`https://api.openai.com` in the applications);
- denies redirects, WebSockets, CONNECT, private/loopback/link-local/metadata
  destinations and DNS results outside pinned public A/AAAA addresses;
- drops child authorization, cookie, proxy and framing headers, then adds the
  host-owned authorization only for the upstream request; and
- enforces bounded request/response sizes, headers, duration and concurrency.

The independent automation channel is a separate scoped AF_UNIX bridge. It
allows tools launched by the harness to use `/runtime/python/bin/python3` and
the generated SDK without granting project-file authority or network access.
Both bridges and all sessions are revoked when the owning turn/session or
renderer ends.

## Implementation order

1. Freeze the automation schema, capabilities, limits and error vocabulary.
2. Implement server paging, canonical command forwarding, view calls and bulk
   leases with restart/cancel/security tests.
3. Generate sync/async Python SDK, docs and staleness gate; run a real SDK to
   query, mutate, read geometry, set a camera and capture a screenshot.
4. Add managed Python runtime inventory and OS-enforced network/filesystem
   policy.
5. Vendor the exact T3 Code slice with provenance and license inventory.
6. Implement harness discovery and Codex/Claude/OpenCode adapters.
7. Add normalized events and the virtualized chat panel to both applications.
8. Run long-thread, cancellation, recovery, stale-revision, expired-lease,
   malicious-output and packaged-install gates.

## Milestone gates

The M11 implementation-side gates below are green:

- protocol negotiation, pagination stability and byte/item ceilings;
- atomic command/conflict semantics through the real canonical journal;
- bulk lease hash/range/expiry/revoke/restart behavior;
- generated sync and async Python clients against the real desktop host;
- camera update and renderer-produced screenshot from Python;
- stale generation check;
- network-off and filesystem-capability integration tests;
- discovery with installed, absent and incompatible CLI fixtures;
- at least one real locally installed harness smoke test without granting it
  project authority;
- 100,000-row chat virtualization/scroll-anchor performance gate;
- Builder and PhotoLab component typechecks and host integration tests; and
- attribution, support inventory and user-facing empty/error/recovery states.

Evidence includes generated sync and async clients exercised through the real
desktop host, a renderer-produced screenshot returned through a bulk lease, a
real installed Codex CLI 0.144.5 turn against a deterministic fake Responses
upstream, direct-egress denial from that turn, and a scoped SDK query from a
Codex-launched managed Python tool. Claude and OpenCode adapter fixtures run
through the real sandbox/runtime/SDK/router path and cover prompt isolation,
chunked events, malformed output, cancellation, process reaping and subsequent
session reuse. Harness fixtures additionally cover installed, absent,
incompatible and executable-identity changes. The chat gate indexes 100,000
rows while rendering a bounded window and verifies append/prepend anchoring and
selection retention.

The full application browser/HMR, packaged-host, native install, GPU and
real-data gates belong to the continuous finished-product release plan. That
integrated plan is still in progress; M11 implementation completion must not be
read as an overall release certification.
