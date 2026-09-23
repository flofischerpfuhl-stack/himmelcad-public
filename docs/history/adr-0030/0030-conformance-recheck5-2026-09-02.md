# ADR 0030 — conformance re-check 5 (revision 6, commit 9d4d398)

Document class: report / verification evidence. Method: mechanical
comparison by the architect (no LLM): each "Adopted verbatim (import-formats
IF-Dnn, quoted)" blockquote in the ADR was whitespace-normalized and compared
with the corresponding **Decision** text of IF-D26–IF-D34 in
`docs/builder-program/specs/import-formats/import-formats.md`.

| Record                                                                              | Result                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| IF-D26 … IF-D34                                                                     | 9 / 9 MATCH (quote equals or is contained in the spec Decision text) |
| Decision 10 table                                                                   | uniform (4 pipes per row)                                            |
| Stale phrases ("owner unresolved", "Deferred until Pointcloud", "not decided here") | 0 occurrences                                                        |
| Prettier                                                                            | clean                                                                |

Verdict: **conformant**. Framing sentences outside the blockquotes were not
LLM-reviewed in this pass; they carry no normative content by construction
(the ADR's own text states the quoted records govern). Status of the ADR
remains "Proposed (architect-reviewed; owner acceptance pending)".
