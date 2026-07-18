# ADR 0019: Canonical document authority is independent from viewer residency

- Status: Accepted
- Date: 2026-07-17
- Depends on: ADR 0016, ADR 0017, ADR 0018

## Context

The first viewer kernel stored canonical representation bindings, render
residency and the translation undo journal in one `WasmViewer`. This proved the
resident-stream transform path, but it also made three different operations
look identical:

1. deleting an entity from the project;
2. detaching an entity from one view;
3. evicting one render tile while the entity remains attached.

It also left create, style, attribute and relation changes outside the journal.
That cannot be the project authority for Builder, PhotoLab and WeltView.

## Decision

`himmelcad-core::canonical_document::CanonicalDocument` is the only mutable
authority for canonical entity envelopes and their command history.

- Every semantic create, update, delete or restore is an atomic canonical
  command transaction with exact revision/hash compare-and-swap.
- Undo and redo append compensating forward transactions. Revisions and journal
  sequence never move backwards.
- Immutable objects and prepared dataset artifacts are staged and hash-verified
  before the entity transaction becomes publishable.
- Project persistence stores the canonical journal and immutable objects. Live
  entity indexes, render bindings, spatial indexes and GPU residency are
  rebuildable projections.

The viewer consumes exact document snapshots but does not own their lifetime.

- **Attach** makes selected representations of an existing live document entity
  eligible for display in one view.
- **Detach** removes that view projection and its streams without a tombstone or
  semantic command.
- **Evict** removes only selected resident render resources. The attachment and
  document entity remain.
- **Delete** is a document command. Views observe its committed effect and then
  detach the deleted entity.

Viewer representation bindings retain their own generation CAS because they
protect render projection replacement, not document history.

## Command-to-view sequence

For an interactive edit:

1. prepare and validate the canonical document transaction;
2. prepare any required viewer projection update against current render
   bindings;
3. commit the canonical transaction and durable journal entry;
4. publish or detach the rebuildable viewer projection;
5. if GPU publication fails, keep canonical state authoritative and rebuild the
   affected projection from its committed snapshot. Never roll canonical state
   back to match a failed cache update.

Translation remains a special fast render impact, not a special document
command: it is `SetPlacement` in the document and a uniform/origin/bounds update
for already resident streams.

## Import sequence

An import provider returns one validated `CanonicalImportPackage`:

1. write immutable objects and dataset artifacts into a temporary project area;
2. verify hashes, paths, dataset bindings and complete entity envelopes;
3. prepare the package's deduplicated entity-create transaction;
4. atomically publish immutable objects and commit the document transaction;
5. attach desired representations to active views.

No provider writes directly into a viewer registry or legacy `EntitySnapshot`
store.

## Consequences

- `retire_canonical_entities` must be replaced by an explicitly named view
  detach API. It must not create document tombstones.
- The placement-only `EntityCommandJournal` inside `WasmViewer` is a migration
  path and will be removed after callers use the canonical document controller.
- WeltView can attach read-only snapshots without gaining mutation authority.
- Multiple views can display different representation/style selections of the
  same document entity without duplicating semantic state.
- Render failure recovery is deterministic because every projection is
  reconstructible from canonical snapshots and immutable resources.
