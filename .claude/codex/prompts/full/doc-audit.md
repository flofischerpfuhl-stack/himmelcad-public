DOCUMENTATION AUDIT — contradictions and compression plan (read-only analysis). Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English report.

HARD RULES: do NOT edit, move, delete or format any existing file; do not commit; do not copy the repository anywhere; no builds. The only file you create is the report at `docs/builder-program/evidence/DOC-AUDIT-2026-09-23.md` (plus scratch under `.build/doc-audit/`, max 50 MB, delete it at the end).

## Authority (read first, in this order)
1. `docs/README.md` (authority order, document classes, the new compression rule).
2. `docs/adr/0032-module-architecture-and-crs-declaration.md` and `docs/CURRENT-DIRECTION.md` (newest owner decisions: 2026-09-23 section supersedes the 2026-09-19 course correction for `main`).
3. `AGENTS.md`, `docs/AGENT-FEEDBACK.md`.
4. Owner corrections that are domain truth: (a) a vertex with a finite Z is an elevation point regardless of entity or role; no 2D/3D special cases; (b) DGM creation (2026-09-19, `docs/builder-program/MASTER-PLAN.md` "Owner course correction"): points are optional, a boundary alone can be meshed, roles are assigned in the surface tool never at draw time, thinning is a separate tool, "breakline vertex off the point set" is not an error, export uses the general export; (c) CRS rule of ADR 0032 (scale 1 internally, CRS is a declaration, transformations only at import/registration/export).

## Scope
Part A — full read, contradiction audit (~190k words): every file listed in `.build/doc-audit/scope-a.txt`, which you create as: `docs/*.md`, `docs/adr/*.md`, `docs/builder-program/*.md`, `docs/implementation-plans/**/*.md`, `docs/feasibility/**/*.md`, `docs/himmelcap/**/*.md`, `docs/security/**/*.md`, `photolab/*.md`, `packages/@himmelcad/*/README.md`, `sdk/README.md`, `README.md`.
Part B — targeted scan only (do NOT read line by line, ~290k words): `docs/builder-program/specs/**`. Use grep/ripgrep for statements that contradict the owner corrections (4a–4c) and ADR 0032 (e.g. mandatory points for DGM, role assignment while drawing, thinning inside the DGM tool, vertex-off-point-set errors, lat/lon or grid scale inside the project, scale factors in measurement, app-local command models). Report locations with a one-line quote each.
Excluded (reports and history are snapshots, allowed to be outdated): `docs/builder-program/evidence/**`, `docs/builder-program/dossiers/**`, `docs/history/**`, `docs/validation/**`.

## What to find
1. Contradictions between documents (same topic, different rule). For each: files with line numbers, short quotes, which document wins by the authority order, and the exact proposed correction (replacement text or deletion).
2. Statements contradicted by ADR 0032, CURRENT-DIRECTION 2026-09-23, or the owner corrections.
3. Stale status claims in normative/spec documents (e.g. "planned" for landed work, "Proposed" ADRs that owner decisions have since settled, dead links to files that no longer exist — check existence with `test -e`).
4. Cheap code checks only where a document names a concrete path, crate, package or command: verify it exists (`test -e`, `rg -l`). No deeper code review.

## Compression plan
Propose how to shrink the documentation without losing decisions (docs/README compression rule). For every Part A file and for the specs folder as a whole: keep / shorten (target size) / merge into X / archive to `docs/history/`. For each shorten/merge/archive, list the decisions (with dates/ids) that must survive and where they will live (ADR, OWNER-DECISIONS, owning spec). Note: the Builder UI will be redesigned together with the owner; agent-derived Builder specs are expected to be largely replaced by the jointly designed UI plus short domain rules — propose how to preserve their still-valid owner decisions and research references while retiring the rest.

## Report format (`docs/builder-program/evidence/DOC-AUDIT-2026-09-23.md`)
- Summary (≤ 15 lines): counts per finding class, top 10 fixes by importance.
- Table of findings: id | class | files:lines | quote(s) | winner | proposed fix.
- Part B location list.
- Compression table + list of decisions to preserve.
- "Not checked" section: what you skipped and why.
Keep the report factual and compact; quotes ≤ 25 words each.
