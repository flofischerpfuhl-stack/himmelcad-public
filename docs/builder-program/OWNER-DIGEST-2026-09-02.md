# Owner digest — Builder completion program, 2026-09-02

Document class: report. Reading guide for the owner; contains no norms.

## What exists after two days

| Artifact                                  | Size                                                                | Role                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/FUNCTION-CONTRACT.md`               | 15 questions, 12 evidence-backed sharpenings                        | what every spec must answer                                                                                                           |
| `docs/DECISION-DOCTRINE.md`               | 7 axioms, 7 precedents (P1–P7), escalation protocol                 | how answers are derived without the owner                                                                                             |
| `.claude/agents/demanding-user.md`        | review persona                                                      | adversarial review before the owner sees anything                                                                                     |
| `docs/builder-program/OWNER-DECISIONS.md` | D1–D6 + Q1                                                          | derived decisions to veto; one genuine question                                                                                       |
| `docs/builder-program/dossiers/`          | 5 dossiers, 1 723 lines                                             | reference evidence (RealWorks, RIB Civil, Revit, Trimble Perspective/Access, field codes)                                             |
| `docs/builder-program/specs/`             | 14 domain specs, 18 912 lines, 16 persisted reviews                 | the implementation plan, function by function                                                                                         |
| `docs/builder-program/REGISTRY.md`        | 162 function rows, shortcut + gesture maps                          | mechanical cross-check: 0 duplicate acts, 0 contradictory guarantees, 0 dangling ids, 0 unowned capabilities                          |
| `docs/builder-program/MASTER-PLAN.md`     | 624 lines, 8 milestones (M0–M7), ordered autonomous queue, protocol | sequencing, milestones as user outcomes, autonomous-execution protocol; Q1 defaults to the PhotoLab-exclusive branch until you answer |

Owner questions asked across all 14 specs and 16 reviews: **zero**. Every
review finding (roughly 200, of which ~45 blockers) was resolved by
derivation from the doctrine; each derivation is recorded next to the
decision it produced.

## What the owner should read, in order

1. `OWNER-DECISIONS.md` — veto or confirm D1–D6; answer Q1 (execution
   priority vs PhotoLab). D1 now includes the Save control and the
   non-interruption guarantees (P5); D6 records your specification-code
   vision with the P7 correction (code grammar is user data).
2. `REGISTRY.md` §1 — skim the function rows per ribbon tab. This is the
   fastest way to see the whole product surface and strike anything you do
   not want.
3. One workflow narrative per domain (each spec's §2): read as a CAD user,
   veto by annotation. Suggested first three: `specs/view/viewing-box.md`
   (the pilot you know), `specs/bim-specs/bim-specs.md` §2 (D6: codes,
   shortcuts, role-based BIM generation), `specs/mesh-terrain/mesh-terrain.md`
   §2 (the surface-creation window).
4. `MASTER-PLAN.md` §1 (Q1 branches), §6 (milestones M0–M7 as user
   outcomes with demos), §9 (the autonomous protocol for after your
   vacation: how tasks are picked, what "done" means, how derived decisions
   reach you as a weekly veto digest).

## Update (evening 2026-09-02): owner statements batch 2

Your workflow batch (line drawing, selection look, bottom bar, 3D target,
tri-state layers, plan layout, embankments, sections/profiles, best-fit
alignments, surface workflow, solids/rasters) is recorded in
`OWNER-STATEMENTS-2026-09-02.md` with ten extracted generators; D7 records
the directions; doctrine gained P8–P10 and the contract a tri-modal C1. The
new `civil` domain spec exists (896 lines, under review); the gap analysis
(`OWNER-STATEMENTS-2026-09-02-GAP.md`, 576 lines) found 28 requirements
already covered, 15 covered differently (its §10.2 lists seven places where
the plan is stronger than the literal statement), 20 missing — the
amendment round is applying them across the specs. Your follow-ups (Tab vs
arrow keys, cursor vocabulary, dependent objects) are recorded as S13/S14
with generators G11/G12; doctrine P10 now carries the linked/stale/detach
recipe model. The key rule you settled: Tab = construction input bar,
↑/↓ = candidate cycling.

Three of your reference attributions were checked against sources and
corrected in the dossiers (your preference stands where it is taste): Trimble
Access selects in blue, not orange — orange is now recorded as owner taste in
the design system (selection = orange with direction, support geometry =
blue); the Access layer manager has three states (Off / Visible /
Selectable), our four-state model adds Editable and Inert as a stated
extension; RealWorks has no single rotatable 3D placement reticle — the 3D
target is a Himmel:CAD design with a stated reason, not a reference copy.

## Open items that need you

- Q1 (execution priority) — the only genuine question.
- "easyBAU": the field-codes dossier could not identify it as a product;
  the sewer exchange target is recorded as ISYBAU XML / DWA-M 145-3. If you
  meant a specific program, name it.
- Vetoes on D1–D6 (silence is not consent).

## Open items that do not need you

- Six pending data-model admissions (`docs/DATA-MODEL.md`) need ADRs before
  implementation — scheduled in the master plan.
- The planned `.hcadx` fragment profile and Plan authority change are
  recorded as planned sections in `docs/PROJECT-FORMAT.md` and
  `docs/PLAN-EDITOR-EXPORT.md`; current contracts remain in force.
- Implementation-phase items (benchmark scripts, theme tokens, SDK/schema
  generation, sibling-app preservation tests) are tracked in the master
  plan, not as planning gaps.

## How the process behaved

- Wave 1 (7 specs) ran on Claude subagents; wave 2 (7 specs, reviews,
  revisions, reconciliation, master plan) ran on Codex CLI (gpt-5.6-sol,
  high) after the session-limit switch, with Claude as architect.
- Each review round produced generalizable rules; the contract and doctrine
  absorbed 19 of them with the triggering case cited as evidence, so the same
  class of defect cannot recur silently.
- The registry caught two real cross-spec contradictions (symbol data model,
  display ownership) that no single review could see.

## Status at 2026-09-02 16:10 — tooling outage

Codex reached its usage limit (reset announced 2026-09-08 23:00). The
batch-2 amendments landed in all 15 specs; the three targeted re-reviews
(ui-platform, draw, mesh-terrain — 5/5/6 blockers, mostly the MT-D25 recipe
record not yet being one true common record, Tab/↑↓ leftovers, reticle and
Escape semantics) are written. Still open, all with ready prompts
(`.claude/codex/out/PENDING-2026-09-02.md`): the three revisions, registry
round 3, the master-plan update for Civil, and this digest's refresh. The
owner decides how to finish: Codex credits, wait for the reset, or Claude.

## Cross-product item for your acceptance: ADR 0030

The PhotoLab release-polish session found that Builder can register only
one PhotoLab product format today (R1 gate 8 unmet). The Builder program
specified the fix (import-formats IF-D19–IF-D25: register PhotoLab product
datasets with frozen lineage provenance; legacy publications get explicit
`partial`/`unknown` provenance), and the PhotoLab session drafted
`docs/adr/0030-photolab-product-import-package-and-provenance.md` as a
verbatim adoption — checked three times against the spec, now conformant.
Its status is "Proposed (architect-reviewed; owner acceptance pending)":
please accept or veto when you read the ADRs. Related doctrine addition:
P11 (product operations reach automation and the console from one
generated command table, never raw-RPC allowlists).

## Final status 2026-09-02 evening — planning round 2 complete

Everything above is now consistent: your batch-2 statements are in all 15
specs (three targeted re-reviews and revisions), the Civil domain is
specified (best-fit alignments, profiles under the live-or-stale rule,
corridor surfaces, embankments and pit surfaces), the registry was rebuilt
(round 3) with zero conflicts, and the master plan carries Civil as its own
milestone (M5), the un-deferred DR-D8, the P11 command table and the PhotoLab
dataset bridge. All program documents and the edited normative documents
pass the repository's Prettier check. Nothing is committed — commit on your
word.

What only you can do now: answer Q1; veto or confirm D1–D7; accept or veto
ADR 0030 (Proposed); tell me what "easyBAU" refers to. After that,
autonomous execution starts with the iteration-speed package (allowed under
both Q1 branches).

## Late evening 2026-09-02 — commercial track

- D9 accepted: Release 0.5 = "DGM aus Scan"; bundle PhotoLab + Builder alpha;
  Q1 = Branch A. D10: website + trust-based free tier; pricing confirmed
  (Free prominent; Founders 79 €/month per office, locked; 20 € supporter).
- Website v1 under `website/` passes all gates (HTML, axe, contrast,
  keyboard, weight); v2 applies the pricing, the Cloudflare Datenschutz
  text, the "Source-available, nicht Open Source" wording, and a customer
  roadmap. Your three to-dos: LICENSE Additional Use Grant for the free
  tier, the public mirror URL, Impressum + mailbox.
- D11 (pending your veto): SupraBench = one weekend data-story bet on Grok;
  Fernwork Desktop inside the Himmel:CAD bundle + a 5–9 € Gumroad SKU (fix
  its P0 first, on Grok); marketing without money = LinkedIn/XING, forums,
  a 3-minute "Punktwolke → DGM" video, five direct office contacts.
- Implementation has started: I-01 done (verifier gate), I-02 measuring,
  I-07 registry linter live (deterministic; replaces LLM registry rebuilds),
  registration-stations spec written and revised; PhotoLab lane works under
  COORDINATION.md with the same token discipline.

## Nacht 2026-09-02 → 03 (Nachtrag)

- Website v3.1 steht lokal (http://127.0.0.1:8765/): Lawn-Struktur, Codex-generiertes
  Anime-Himmelbild (Codex hat ein eingebautes Bildwerkzeug — kein Bild von dir nötig),
  Free Tier als Botschaft, 79 € genau einmal in der Founders-Karte, keine
  Herstellernamen (automatisch geprüft), vollständige Roadmap 0.5 → 4.0 als Zeitleiste.
  Deine Korrekturen sind als S20/G16 festgehalten.
- D12 (vetobar): ADR 0031 „Release 0.5 data-model admissions" — welche Datenmodell-
  Zulassungen 0.5 braucht (Rezepte, Quellrollen, Punktherkunft, Stützrolle, lokale
  Undo-Historien, Snapshot-Marker, ViewState-Teilprofil, Mess-Basisprofil,
  Segment-Locator) und welche warten. Neun Einzelentscheidungen am Ende, jede streichbar.
- Infrastruktur gelandet: I-03b (ein `tsc -b`-Graph, warm 2 s statt 35 s), I-04
  (paralleler Verifier, Cargo-Lanes exklusiv, 85 s → 39 s). I-05/I-06 (Build-
  Messprogramme) zurückgestellt, Begründung im Masterplan. Terra-Test: ehrliches
  Zurückrollen, unzuverlässige Diagnose — kein Substrat mit Diagnoseanteil mehr an Terra.
- PhotoLab-Lane: Escape-Leiter (UIP-D14) konform, Funktionstab-Abweichung als UIP-D7-
  Revision akzeptiert (Builder muss die Schließ-Tabs einschalten).
- Register vollständig grün (sieben Batch-2-Katalogzeilen ergänzt). S-02 läuft, S-01
  wartet auf die PhotoLab-Änderung an der geteilten Datei, S-03 ist vorbereitet.
- S-01 gelandet (ADR-0031-Zulassungen als Rust-Schemas mit generierten TS/Python-
  Verträgen, 216 Core-Tests grün) und S-02 gelandet (neun Basiskomponenten, Achsen-
  und Ebenen-Tokens, Ribbon-Tastatur, 22/22 Tests, axe ohne Befund). Drei S-01-
  Entscheidungen, vetobar: Rust bleibt Quelle der Wahrheit (kein zweiter JSON-
  Schema-Generator), neue Automations-Zeilen tragen einen versionierten Umschlag bis
  ihr Domänen-Slice den genauen DTO liefert, PhotoLabs v1-ViewState-Aufruf bleibt
  neben v2 erhalten. Deine Anweisung vom Morgen (jede UI selbst anschauen) ist als
  G17 festgehalten; die Komponentengalerie für die Sichtprüfung wird gerade gebaut.
- Segmentierung ist jetzt Teil von 0.5 (Slice 0.5-02a, S21).
