# Documentation consistency audit — 2026-08-16

Status: historical audit report. It records why the documentation was
restructured; it is not a normative source.

## Conflicts found and resolved

| Previous conflict                                                                 | Resolution                                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder was described both as paused and as the main product                      | Builder is the flagship; PhotoLab is the tactical first-release priority because its completion scope is smaller.                            |
| Old architecture prose named TypeScript/Three.js as the target renderer           | Current architecture follows ADR 0017: shared Rust/wgpu kernel; Three.js is migration-only legacy.                                           |
| The data-model overview used a closed legacy entity-kind model                    | The overview now follows ADR 0016/0019: semantic `type_id`, representations, immutable resources, and commands as the only write path.       |
| Completed plans and reports still looked like current direction                   | Dated plans, measurements, gate answers, and milestone logs moved to `docs/history/`.                                                        |
| Cap was described as both unstarted and implemented                               | Current docs describe the implemented Flutter MVP and keep field validation and release hardening open.                                      |
| Cap package names alternated between `.himmelcap` and `.hcap`                     | `.hcap` is canonical; `himmelcap` remains only in stable internal identifiers where needed.                                                  |
| ADR numbers 0007 and 0021 were duplicated                                         | Portable MVS is ADR 0028; desktop continuous updates is ADR 0029. Existing unrelated ADRs retain 0007 and 0021.                              |
| German and English normative text and multiple brand spellings were mixed         | First-party documentation is English; the display brand is `Himmel:CAD`, while technical identifiers may use `himmelcad`.                    |
| Universal agent rules contained detailed product, code-style, and milestone prose | Root `AGENTS.md` now contains only implementation principles and points to the authority map.                                                |
| No durable rule required cross-system impact and concurrency analysis             | Root principles, architecture, design system, and active owner feedback now require explicit change-surface and operation-conflict analysis. |

## Specificity decisions

- Root `AGENTS.md` contains only rules needed during nearly every implementation.
- Current priority and freezes live only in `CURRENT-DIRECTION.md`.
- Cross-product technical invariants live in architecture, data, format,
  transformation, design, dependency, and verification documents.
- Exact historical measurements and completed implementation plans live in
  history and never establish current completion.
- Focused product and subsystem documents may remain detailed when the detail
  is executable behavior, a wire contract, a security boundary, or a testable
  quality rule.
- Research notes and feasibility records provide evidence but do not override
  accepted ADRs or current normative documents.

## Known implementation follow-ups

These are code/test inconsistencies discovered by the documentation audit, not
documentation authority:

- `pnpm photolab:test:himmelcap` still asserts that `apps/cap/` must not exist.
  This predates the later Cap-MVP integration and conflicts with the current
  repository, ADR 0027, and commit history. The architecture assertions after
  that obsolete guard do not run.
- Cap still includes German localization as a supported locale and defaults
  some UI tests to German. The all-English product policy therefore requires a
  separate implementation change and an automated Cap English-UI gate.

## Audit checks

- First-party local Markdown links resolved after restructuring.
- ADR filenames have unique four-digit numbers.
- Active first-party Markdown contains no German prose detected by the audit;
  remaining German tokens are source titles or legally exact license names.
- Rewritten normative documents and changed schemas pass Prettier.
- `git diff --check` reports no whitespace errors.
