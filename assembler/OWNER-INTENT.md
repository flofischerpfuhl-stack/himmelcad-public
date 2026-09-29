# HimmelCAD Assembler — owner intent and constraints

Recorded from Florian's requests in the planning conversation of 28 September 2026. The short German quotations below preserve his wording, including typos.
They are source evidence; explanations and acceptance implications are the
assistant's interpretation, explicitly separated from implementation proposals.

## How to use this document

**The owner's intended outcome governs the implementation plan, not the other
way around.** Read this document before [PLAN.md](PLAN.md) or the dated research.
Improve or replace implementation proposals when evidence shows a better route
to these goals. Do not silently weaken a goal to fit an easier implementation,
promote a suggested mechanism into an owner requirement, or count an alpha as
completion of the intended product. Later explicit owner corrections supersede
this record and must be reflected here.

This records Assembler-specific intent; it does not silently rewrite existing
repository-wide ADRs or dependency rules for other products. Record the necessary
Assembler exceptions and component decisions before implementing them. The
current task authorizes documentation, commit and push, not a claim that the CAD
application has already been implemented.

## Intended outcome and conditions

| ID  | Owner intent                                                                                                                                                               | Original evidence                                                                                                                                                                                    | Meaning for evaluation                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Build **HimmelCAD Assembler**, a CAD application focused on **3D printing**.                                                                                               | “ein cad fukussiert für 3d druck.”                                                                                                                                                                   | Judge the result by complete, precise, editable workflows for printable parts, not by a viewport demonstration.                                                                                                                                                            |
| U2  | Get **as close as possible to Shapr3D**. The ambition includes functionality, workflow, UI, mouse/touch operation and interactions between features.                       | “soll möglichst nah am original sein”; “welche funktionen es gibt, wie es funkrioniert wie funktionen miteinander interargieren, wie die ui funktioniert, wie die touch/maus bedienung funktioniert” | A familiar-looking shell or abbreviated tool list is insufficient. Maintain a feature/behavior gap inventory. Milestone reductions do not redefine the end goal.                                                                                                           |
| U3  | Own product code should use the **same license as HimmelCAD and Fernwork**.                                                                                                | “es soll unter der gleichen lizens stehen wie himmelcad und fernwork.”                                                                                                                               | Verify the actual product license when implementing; preserve obligations on reused third-party code instead of pretending all code becomes first-party code.                                                                                                              |
| U4  | **No purchased licenses** for the solution.                                                                                                                                | “wir werden keine lizenz kaufen für irgendetwas.”                                                                                                                                                    | Do not make paid CAD kernels, SDKs, importers or other component licenses prerequisites. This is distinct from the user's discussion of agent subscription budgets.                                                                                                        |
| U5  | Make the application **as usable by agents as possible**, taking their existing Blender familiarity into account. AI integration is desirable.                             | “aber wir wollen es auf jeden fall sogut wie mögoivh von agents nutzbar machen und dazu müssen wir derren training berücksichtigen”                                                                  | Evaluate successful modeling, correction and export with agents, and transfer of familiar modeling concepts. The owner suggests substantial Blender training; its actual amount is unknown, not an established measurement. A GUI alone does not address this requirement. |
| U6  | Reuse **HimmelCAD and existing open-source projects** wherever this reduces effort while meeting the product goals.                                                        | “überprüfe auch on wir nicht vllt mehr noch auf himmelcad und auf vkrhandene opensource projekte aufbauen können um den aufwand zu senken”                                                           | Compare reuse/adaptation against new implementation. Neither starting everything from scratch nor requiring the entire HimmelCAD backend follows from the request.                                                                                                         |
| U7  | Renderer reuse must not cause **Assembler-specific changes to degrade Builder**. Sharing remains acceptable.                                                               | “hier hab ich bloß die befürchtung dass wir ihn dann vllt bei assembler problemen für assembler overfitten und dann builder drunter leidet. ich bin aber nicht grundsätzlich dergegen”               | Protect Builder's behavior and performance. A separate fork is one proposed way to do this, not the goal itself.                                                                                                                                                           |
| U8  | Estimate effort primarily in **tokens and Claude weekly-limit consumption**, using the Compositor/Fernwork experience as a calibration reference.                          | “mich intressiert weniger die tatsächliche zeit die eir brauchen sondern eher die tokens/claude wochenlimits die wir brauchen”                                                                       | Separate measured usage from guesses; do not translate elapsed commit spans or output tokens directly into Claude weeks. There is no owner-set numeric budget cap in this conversation.                                                                                    |
| U9  | Research Shapr3D deeply and comprehensively, using **GPT-6-Sol subagents**, screenshots, tutorials and YouTube, then reassess effort and preserve the results in the repo. | “schick jetz 6-sol subagents los, die sollen sehr tief recherchieren”; “möglichst komplett (also wirklich _komplett_) shapr3d beschrieben”                                                           | Keep source provenance, behavior interactions and remaining gaps. A large source list is not proof that every video was watched or every behavior tested. The research archive explicitly reports its limits.                                                              |
| U10 | Preserve the original intent so future agents can correctly interpret and improve the plan.                                                                                | “dein plan ist nur ein versuch das umzusetzen, wenn meine originalintention nicht drinnen ist, dann kann kein agents den plan eichtig interpretieren oder verbessern”                                | Keep requirements separate from architecture choices, estimates and proposed scope cuts. Explain how revisions better serve the outcome.                                                                                                                                   |
| U11 | Do not exclude a license merely because it appears on a blacklist if it is actually compatible with the intended distribution.                                             | “wenn auf der verbotsliste eine lizenz steht die eigentlich nicht in konflikt mit unsrer lizenz steht dann sollte sie eogentlich da weg.”                                                            | Review the blanket LGPL prohibition and the concrete component/license boundary. Neither a blanket ban nor a blanket compatibility assertion satisfies the request. A Rust port does not erase a source license.                                                           |

## Owner suggestions and provisional scope, not unconditional requirements

| Topic                            | What the owner actually said                                                                                                                                    | Status and implication                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blender fork                     | “also das mit blender fork war nur ein vorschlag.”                                                                                                              | Explicitly optional. Agent familiarity matters (U5); a Blender fork, Blender UI or full `bpy` compatibility is not mandatory.                                                                                                                                                                                           |
| FreeCAD backend                  | “könnten mir einfach komplett freecad backend nehmen und da eine neue ui einfach draufsetzen?”                                                                  | A reuse option to investigate. Do not omit this comparison just because a custom Rust document model is attractive.                                                                                                                                                                                                     |
| Selective FreeCAD port and stack | “eine rust typscript electron app bauen die im frontend so nah wie möglich shapr3d ähnelt und für den view renderer und backend logik freecad nach rust porten” | The owner's proposed technical direction, following the Compositor analogy. Rust/TypeScript/Electron and selective porting deserve an explicit comparison. Retaining native OCCT/solver components is an assistant recommendation, not an original owner demand. Earlier Electron/Tauri wording left shell choice open. |
| HimmelCAD backend                | “himmelcad backend vllt ganz weglassen.”                                                                                                                        | Permission to evaluate an independent backend, not an order to discard all reusable HimmelCAD code.                                                                                                                                                                                                                     |
| Renderer fork                    | “oder himmelcad renderer einfach für assembler forken?”                                                                                                         | Proposed alternative to coupling Builder and Assembler. The current plan recommends an initial fork. Neither permanent duplication nor mandatory future reunification was requested.                                                                                                                                    |
| Cloud, drawings, XR              | “erklär mal cloud, zeichnungen und xr? evtl können wir die erstmal weglassen”                                                                                   | **Tentative deferral for the first version**, not permanent rejection or an explicit final scope ban. The working estimate excludes these modules and must say so. “Drawings” means derived technical drawing sheets, not construction sketches or model dimensions.                                                    |

## Assistant proposals and assumptions that may be improved

The following are **means**, not extra owner conditions: an initial independent
renderer fork; one authoritative CAD history; OCCT/possible planeGCS reuse;
a selective Rust feature-graph implementation versus a FreeCAD-backed one;
a common command contract with Python access; the particular phased roadmap
and sample acceptance parts in PLAN.md.

The current plan also proposes deferring an integrated slicer, dynamic assembly
joints, specialized importers, full SHAPR compatibility and native mobile apps.
These are budget/scope assumptions by the assistant, not explicit owner bans.
Likewise, avoiding a complete Rust geometry-kernel rewrite is a current effort
recommendation. It must not erase the owner's interest in a selective Rust port.

The numerical token ranges are unmeasured estimates under those assumptions.
They are neither an owner-approved spending allowance nor evidence of measured
Claude weekly consumption. Renderer forking has no measured token saving yet.

## Traceability to the current implementation proposal

| Owner intent | Plan location                  | Evidence needed before claiming success                                                                                    |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| U1, U2       | Sections 1, 2, 6, 7            | End-to-end printed-part workflows and explicit Shapr3D behavior/feature gaps; alpha and release parity stated separately.  |
| U3, U4, U11  | Sections 3, 9                  | Exact license/version/distribution boundaries and free component availability; repository policy reconciled.               |
| U5           | Sections 1, 5, 7               | Agent modeling benchmark, repair cost, usable API, and continued manual editability; compare familiar modeling approaches. |
| U6           | Sections 3, 4, 6               | Reuse comparison including FreeCAD backend, selective port and existing HimmelCAD parts, with measured integration burden. |
| U7           | Section 4                      | Isolated dependencies and Builder regression evidence wherever shared code or backports change.                            |
| U8           | Section 8                      | Measured token/input/cache counters and account limit deltas, with model, resets and concurrent usage accounted for.       |
| U9           | Section 7 and research archive | Cited findings, tutorial/media provenance, known contradictions and explicit unverified behavior.                          |
| U10          | This document and plan opening | A future agent can distinguish the intended product from the current route to it.                                          |

Open decisions include the final first-release boundary, backend authority,
exact fork scope, agent API and empirically calibrated token budget. Resolve
technical choices through evidence within these goals. A change to the owner's
actual goals or conditions requires explicit owner direction; simply improving
an implementation proposal does not.

## Owner decision 2026-09-29 — implementation started

The owner started implementation on 2026-09-29, choosing "Phase 0 + UI shell"
for this session: the documentation follow-ups of PLAN.md §9 (product
boundary ADR, dependency-policy update, fork-base pin) plus a Shapr3D-like UI
shell without a CAD kernel. This is a scope choice for the current session,
not a revision of U1–U11 above.
