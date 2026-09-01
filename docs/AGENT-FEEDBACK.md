# Active agent feedback

This file is the short-lived learning queue for explicit, generalizable owner
corrections. It is not a second `AGENTS.md` and must contain at most ten active
lessons.

## Workflow

1. Apply explicit feedback immediately in the current task.
2. Add or update a lesson only when the correction generalizes beyond the
   current edit. Do not infer preferences from silence.
3. Deduplicate by behavior and increment `Repeated` when the same failure
   returns.
4. On repetition, promote the lesson to its authoritative product, design,
   architecture, or development document. Add an automated check when the rule
   is mechanically testable.
5. Remove the active lesson after promotion and enforcement. Git history is the
   archive.

Each lesson must state `Scope`, `Avoid`, `Required`, `Evidence`, `Repeated`, and
`Promote to`.

## Active lessons

### SYSTEM-001 — Cross-check the complete change surface

- Scope: all non-trivial implementations.
- Avoid: treating a requested function as isolated and overlooking conflicting
  simultaneous operations or consumers in another app or API.
- Required: inspect concurrency, shared state, lifecycle, cancellation, error
  recovery, persistence, undo/redo, sibling apps, commands, automation, formats,
  documentation, and tests. Explicitly coordinate, serialize, or reject
  operations that must not overlap.
- Evidence: the implementation report names the affected surfaces and any
  intentionally deferred follow-up.
- Repeated: 2.
- Promote to: architecture concurrency contracts and automated integration tests
  for each concrete recurrence.
