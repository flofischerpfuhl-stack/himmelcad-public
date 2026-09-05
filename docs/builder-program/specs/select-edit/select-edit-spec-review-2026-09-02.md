# Demanding-user review — Select & edit domain spec (2026-09-02)

Document class: report/verification evidence.

Static review. Verdict: **not ready for owner review**. Headline: **5 blockers,
6 major findings, 2 minor findings, 0 ideas**. The spec has a strong placement-
only architectural instinct and a useful mixed-scene narrative, but it is not
yet executable as a deterministic CAD interaction contract. Its status line
also overclaims: the registry still calls Select/Edit unwritten, the fragment
format is absent, and none of the three named continuous gates exists.

## Findings

1. **Severity: blocker. Contract question: E2 / A3 / SE-D3.**

   **Objection:** I moved the selected 600-million-point cloud while a locked
   viewing box was active. The spec promises a placement-only move and says
   vaguely that “derived-product invalidation” consumes it
   (`select-edit.md:120-149`, `:279-286`, `SE-D3`), but it never says what the
   locked bake displays during the drag or after commit. This is not a harmless
   omission. `VB-D3` keys the bake on box geometry, operation, and **source-
   dataset revision** (`viewing-box.md:323-342`); `SetPlacement` changes the
   entity revision/placement, not the immutable dataset revision. The old bake
   can therefore remain “valid” while containing the wrong world-space subset.
   The same blanket phrase fails to disposition raster drapes (`RA-D4`: exact
   support revisions rebuild) and associative measurements (`MI-D3`: valid
   placement changes re-resolve anchors). This violates the E2 passive-consumer
   rule and the cite-and-revise rule: Select/Edit touched three sibling-owned
   semantics without recording the required amendments/adoptions.

   **Proposed resolution:** Derived, vetoable decision from X1/X2, P4, E2,
   `VB-D3`, `RA-D4`, and `MI-D3`: a placement commit increments the exact source
   entity version consumed by every dependent artifact. Amend `VB-D3` at its
   owning spec so a bake key includes the source entity id plus exact placement/
   entity version as well as dataset revision. During a cloud-placement preview,
   suspend the stale bake and render the source through the preview placement
   and live clip; after commit show an explicit **Rebuilding locked box** state
   until one debounced bake publishes atomically. Never show the old bake as
   current. Adopt `RA-D4` verbatim for drapes: rebuild from the exact moved
   support revision and suppress stale prepared output. Adopt `MI-D3` verbatim:
   local associative anchors follow and recompute; fixed project-world anchors
   do not. Add all three transitions to `G-SE-CORE`, `G-SE-1`, and the real-data
   scene. No owner decision is needed.

2. **Severity: blocker. Contract question: C1 / E2 / A3 / SE-D1.**

   **Objection:** I cannot drive the flagship Move workflow key by key. There is
   no picked/typeable base point, no definition of which moving point snaps, no
   plane/free-move handle contract, no result when an exact candidate conflicts
   with the active axis, and no adoption of `DR-D12` source priority or its
   one-shot override. Worse, the gizmo takes Tab to cycle Move/Rotate/Scale
   (`select-edit.md:380-394`), while Draw and Measure reserve viewport Tab for
   exact snap-candidate cycling (`DR-D2`, `DR-D12`, `MI-D5`). That makes an
   ambiguous destination impossible to choose. The narrative itself is
   physically unresolved: “Before releasing, the user types … into Delta X”
   (`:136-139`) without defining how a held pointer drag transfers focus,
   releases capture, handles the later pointer-up, or assigns the first and
   second Escape presses. Different implementations will commit different
   coordinates and undo steps.

   **Proposed resolution:** Derived, vetoable decision from X1, X5, C1,
   `DR-D12`, `UIP-D14`, and P5: Move begins with an explicit **From/pivot** point,
   defaulted to the visible selection-bounds center but pickable and typeable as
   X/Y/Z. Axis handles constrain the delta to the chosen world/local axis; plane
   handles constrain it to that plane; the center handle is unconstrained.
   Snapping moves the From point to an exact shared-kernel candidate after P4
   filtering and then projects/rejects it consistently under the constraint.
   Tab/Shift+Tab must keep the sibling meaning—cycle the visible candidate
   stack—and the held `DR-D12` override must remain available. Mode switches use
   visible panel controls and registry-assigned accelerators, not Tab. While a
   handle drag is active, printable input freezes the pointer-derived preview,
   transfers to the matching numeric field, and retains one transaction:
   Enter commits once and releases capture; first Escape reverts typed input to
   the drag-start preview, second Escape restores every target to the captured
   baseline; a trailing pointer-up after keyboard completion is ignored. State
   explicitly that pointer-up without typing also commits once and Ctrl+Z
   restores the entire target set once. Apply the same grammar to angle, scale,
   mirror plane, and copy-vector, with browser tests for axis + snap + typing +
   two Escapes + one undo.

3. **Severity: blocker. Contract question: D1 / E3.**

   **Objection:** The spec calls `G-SE-1`, `G-SE-2`, and `G-SE-3` agent-runnable
   and names `scripts/bench-builder-transform-gizmo.mjs`,
   `scripts/bench-builder-selection-overlay.mjs`, and
   `scripts/bench-builder-entity-fence-query.mjs` (`select-edit.md:526-565`). A
   repository-wide static search found none of those files and no registration
   of any `G-SE-*` gate outside this spec. The gold-standard viewing-box spec has
   an actual `scripts/benchmark-builder-viewing-box.mjs`; this spec has prose
   paths. The contract is explicit: a continuous interaction without a runnable
   gate is not specifiable as smooth. The current `Status: specified` is false.

   **Proposed resolution:** Add self-launching scripts at the named paths, real
   fixtures, deterministic membership oracles, and verifier routing under the
   `browser-gpu` / `real-data` capability tiers before restoring “specified”
   status. Until then mark the affected rows contract-level or blocked on gate
   evidence. Each script must fail on the SE-D13 thresholds, buffer/object
   rewrites, stale preview frames, overlay-membership disagreement, and missing
   capability rather than report a skip. This is derived directly from D1, E3,
   `TEST-TIERS.md`, X2, and P3.

4. **Severity: blocker. Contract question: C4 / E2 / SE-D7.**

   **Objection:** Cross-project clipboard is specified on top of an artifact
   that does not exist. The catalog says Ctrl+C can become a long cross-project
   pack and Ctrl+V an import, while the workflow switches to explicit **Export
   fragment… / Import fragment…** and admits that the `.hcadx` fragment profile
   is not defined (`select-edit.md:42-45`, `:185-212`, `:288-317`). A repository-
   wide search found no fragment profile outside this spec, and
   `PROJECT-FORMAT.md` defines only whole-project `.hcadx`. The runtime clipboard
   token has no affected-state/lifetime contract across project replacement,
   project close, application exit, temp cleanup, or source GC. On CRS mismatch,
   “use FP-D15’s … attach-at-identity choice” also changes a paste of owned
   entities into a project reference without saying so. FP-D15 owns attach
   semantics, not clipboard import. This is a data-integrity boundary, not an
   implementation detail.

   **Proposed resolution:** Derived, vetoable decision from X1, X3, X5,
   `PROJECT-FORMAT.md`, and FP-D15: define and commit the versioned fragment
   manifest in `PROJECT-FORMAT.md` before this function is “specified.” The
   clipboard record must carry source project id, exact entity/dependency refs,
   source CRS and units, format version, and an operation-owned spool reference
   with explicit close/crash/cleanup retention. Same-project Ctrl+C/V may use a
   cheap token; cross-project paste stages and validates the fragment. **Paste in
   place** is enabled only when CRS and units are identical, or after the user
   explicitly selects and previews a registered transformation. Numeric-identity
   paste into a different/unknown frame is a separately labeled, explicit
   dangerous choice with recorded provenance; **Attach as reference** is a
   separate offered command, never a silent paste fallback. Cancel/failure
   publishes no object or entity, and recovery follows the format’s ready
   boundary. Add tests for project switch, app restart, missing spool, source GC,
   unit-only mismatch, CRS mismatch, identity override, and path traversal.

5. **Severity: blocker. Contract question: catalog / B1 / E2.**

   **Objection:** The Builder program requires registry rows at specification
   time, but `REGISTRY.md` still says the transform gizmo is unowned (`F2`),
   clipboard/paste-in-place is unowned (`F5b`), and Select/Edit is an unwritten
   owed spec (§5.7). It contains no `SE-D*` record and no `edit.move`,
   `edit.clipboard.*`, lock, isolate, or Select/Edit gesture entry. The spec also
   recommends Ctrl+C/V/Shift+V/D/G/Delete and claims armed Tab meanings without
   entering them in the registry-owned shortcut/gesture maps. Consequently none
   of these claims has passed the mandated duplicate-act, same-surface, command-
   naming, or gesture-collision check. `REGISTRY.md` still carries the unresolved
   snake_case-vs-camelCase automation finding F8, which this spec silently joins.

   **Proposed resolution:** In the same revision as the corrected spec, add every
   non-deferred catalog row to `REGISTRY.md`; replace the §5.7 owed entry with a
   disposition table; mark F2 and F5b satisfied by `SE-D1` / `SE-D7`; register
   every shortcut recommendation and armed gesture; and run the standing
   duplicate/surface/state checks. Resolve F8 once at registry level and
   mechanically adopt the winning command convention here. Do not declare the
   spec “specified” until that cross-check artifact agrees. This follows the
   builder-program README and X7; it is not an escalation.

6. **Severity: major. Contract question: E2 / A3 / SE-D1.**

   **Objection:** “Select-edit uses the full profile” (`select-edit.md:402-414`)
   treats every selected entity as translate/rotate/scale/mirror capable. The
   spec never publishes a per-kind capability/applicability matrix. That clashes
   with FP-D15’s translate+rotate-only project reference, viewing-box-owned
   handles, Draw-owned vertex/content editing, and Measure’s rule that endpoint
   handles arm only in **Edit anchors** (`measure-inspect.md:77-80`,
   `MI-D6`). If I select a measurement, a viewing box, an attached project, a
   screen-sized label, and a cloud together, the contextual buttons and command
   result are unknowable. A generic placement matrix is not proof that a domain
   entity permits nonuniform scale or mirror.

   **Proposed resolution:** Add one canonical transform-capability query used by
   ribbon, context menu, Properties, console, agent, and SDK. The available
   operation set is the intersection across effective targets; any unsupported
   member disables/rejects the whole operation with names and reasons—never
   skips. Initial derived matrix: ordinary spatial CAD/mesh/cloud entities expose
   only operations their semantic owner validates; project references expose
   translate+rotate per FP-D15; viewing boxes route to `viewing_box.update`;
   measurements route to Edit anchors/plane and expose no generic gizmo;
   dimensions/text follow Draw’s domain adapter; organizational entities expand
   only through the expressly defined descendant rule. Scale/mirror for survey
   sources remain disabled until their owner specifies semantic and CRS effects.
   Add mixed-selection applicability and automation-parity tests.

7. **Severity: major. Contract question: C4 / E2 / SE-D10.**

   **Objection:** **Exit isolate** is a restore operation, but its restore scope
   is undefined. `SE-D10` says isolate writes `sessionHiddenEntityIds` and Exit
   clears it (`select-edit.md:349-373`, `:499-505`). That set is also a general
   automation-writable ViewState layer under VD-D13. Clearing it can erase
   unrelated session hides; retaining it can preserve stale isolate hides. A
   second isolate is computed only from “currently visible” entities, so the
   first isolate’s hidden population cannot re-enter. An entity created, pasted,
   restored, or imported while isolate is active is not in the captured hidden-
   id snapshot and leaks into the supposedly isolated view. The interaction
   between **Show selection** and isolate is also silent: canonical Show can
   succeed while the entity remains session-hidden.

   **Proposed resolution:** Derived from C4, X1, X3’s view-local exception,
   VD-D13, and UIP-D18: model an active isolate as a session-local **allow set plus
   operation identity**, not as ownership of the entire shared hidden-id set.
   Effective visibility is canonical visibility ∩ independent session hides ∩
   active-isolate predicate. New/restored entities are hidden automatically
   unless admitted; replacing isolate recomputes from the full live universe,
   not the already-filtered view. Exit removes only the isolate predicate and
   preserves canonical hides and independent automation session hides. Show
   reports **Shown canonically · still hidden by Isolate** with an Exit action.
   Define clearing on project close/replacement and app shutdown; never on panel
   close or selection change. Keep hidden selected ids in the selection per
   UIP-D18. Test nested writers, second isolate, paste/undo during isolate, and
   Exit’s exact affected-state set.

8. **Severity: major. Contract question: E2 / A3 / SE-D9.**

   **Objection:** The repository now has two locks with no single effective lock
   rule. Draw DR-D4 owns canonical layer lock; SE-D9 adds self/owner-ancestor
   entity lock, but omits layer lock from its predicate and consumer list
   (`select-edit.md:319-347`, `:488-497`). I can therefore “unlock” an entity on
   a locked layer and still not know whether Move, Delete, Group, property edit,
   or an SDK command succeeds. A UI-only conjunction and a command-layer
   conjunction will drift immediately.

   **Proposed resolution:** Derived from X1, X3, X7, DR-D4, and SYSTEM-001: keep
   two canonical lock **sources** but one authoritative effective-editability
   predicate: locked here OR locked by owner ancestor OR locked by any effective
   layer. Every mutating canonical command, including automation, calls it before
   preparing the transaction; read/select/snap/measure/copy stay permitted as
   already chosen. `entity.lock/unlock` changes only the entity source;
   `layers.setLocked` changes only the layer source. Properties/query results
   expose `effectiveLocked` plus all causes (“Locked here”, “Locked by Facade
   west”, “Locked by layer Existing survey”). Unlocking one source never claims
   the entity is editable while another source remains. Amend both SE-D9 and
   DR-D4 by citation rather than inventing a third lock model, and test UI/SDK
   parity for every cause and mixed batch.

9. **Severity: major. Contract question: E2 / C4.**

   **Objection:** Generic Delete has no deletion plan for the least typical
   entities it claims. Deleting `hcad.group@1` alone leaves children pointing to
   a missing owner and is rejected by the canonical owner invariant; deleting
   its subtree is a materially different result. Deleting a source cloud must
   leave MI-D3 measurements unresolved, not cascade them. Default/root/layer,
   viewing-box, attachment, and domain entities have owner-specific cleanup or
   protected-state rules. “Routes through its owner command when extra cleanup
   is required” (`select-edit.md:339-347`) names no applicability list, affected-
   state set, or adapter result, while the catalog advertises one universal
   `entity.delete`.

   **Proposed resolution:** Add a registry-fed delete-plan query per selected
   kind and dependency closure. Derived defaults: deleting a group deletes the
   explicitly previewed descendant subtree atomically; **Ungroup** is the
   preserve-children alternative. Protected root/default-layer state rejects.
   Viewing boxes, project references, measurements, and other domain artifacts
   dispatch to their owning remove/detach command adapter. Source-dependent
   measurements survive as unresolved per MI-D3; immutable objects remain until
   journal/undo reachability releases them. The preflight states exact direct,
   descendant, dependent-unresolved, hidden-excluded, and lock-blocking counts;
   Ctrl+Z restores exactly the command’s canonical affected set but never
   selection membership (UIP-D18). Test each extreme and any-member rejection.

10. **Severity: major. Contract question: A2 / catalog.**

    **Objection:** The cited dossier facts I checked mostly hold, including RIB
    vector move/rotation/F5 parity, RealWorks Move Mesh, Access rectangle/polygon
    selection, Revit definition-driven repetition, and the dossier-wide absence
    of RealWorks clipboard payload semantics. But the spec then promotes
    scale, mirror, duplicate, entity lock, and generic isolate without a dossier
    line item or a doctrine derivation for each catalog row. It also says
    RealWorks supports Ctrl+C/V “entity clipboard shortcuts.” The RealWorks
    dossier only says those key labels appeared in a shortcut roundup alongside
    Ctrl+M (`realworks.md:73-78`); it does not say what Ctrl+C/V copy, and the spec
    itself admits the payload and cross-project semantics are unknown. Bare keys
    are not evidence for an entity clipboard workflow. The opening claim that
    “all four dossiers are disposed” is therefore false.

    **Proposed resolution:** Extend the appropriate repo-resident dossier first
    with sourced scale, mirror, duplicate, entity-lock, isolate, and exact
    Ctrl+C/V behavior, then give every resulting row Adopt/Defer/Reject treatment.
    Where a capability is deliberately Himmel:CAD-native rather than reference-
    derived, say so and supply a valid repo-resident X*/P*/ADR derivation in its
    decision record; do not call it a reference adoption. Until then mark those
    rows unresearched and the domain not fully specified. The functions need not
    be removed; the evidence chain needs to become honest.

11. **Severity: major. Contract question: C2 / E2.**

    **Objection:** Box/Lasso exposes two independent concepts as one muddled
    mode. The workflow panel shows **Replace** and **Crossing**
    (`select-edit.md:151-166`), C2 says Replace/Add/Remove, and the gesture table
    gives Box Contained/Crossing but Lasso Replace/Add/Remove (`:380-394`). I
    cannot tell whether Box can add/remove or whether Lasso has a contained
    rule. The alleged accessibility polygonal lasso finishes on double-click,
    but the same table says sub-threshold LMB click commits nothing, so no
    polygon vertex can ever be entered. A2 also calls Access’s polygon selection
    “Lasso,” while the actual tool elsewhere is freehand; that deviation is not
    stated.

    **Proposed resolution:** Specify two orthogonal controls for both tools:
    **Combine** = Replace/Add/Remove and **Hit rule** = Window/Contained or
    Crossing. Define whether freehand Lasso supports both hit rules; if it does
    not, disable the unsupported one with a reason. Freehand lasso is press-drag-
    release. Its accessible polygon mode uses single LMB clicks to add vertices,
    Backspace to remove the last, Enter/double-click to close, Escape to discard;
    record every claim in the gesture table and registry. State explicitly that
    Access provides rectangle/polygon evidence while freehand lasso is a
    Himmel:CAD/PC-D2 addition. Add clipped-scene tests for both combine modes,
    both hit rules, cloud-as-one-entity, zero point masks, and natural occlusion.

12. **Severity: minor. Contract question: A2 (code-evidence rule).**

    **Objection:** The `edit.move` status says “exact placement CAS exists” but
    cites `entity_commands.rs:18-32` (the command struct) and
    `canonical_document.rs:104-148` (the edit enum and field assignment). Those
    lines do not perform compare-and-swap validation. The behavior does exist,
    but the citation is wrong: `apply_transform_entity` validates the expected
    reference at `entity_commands.rs:199-218`, and canonical update validation
    is at `canonical_document.rs:644-674`. Under the CURRENT contract, a wrong
    file:line claim is a finding even when nearby code can rescue the statement.

    **Proposed resolution:** Replace the status citations with the validating
    lines, keep the struct/edit lines only as schema evidence, and make the same
    distinction wherever “exists” currently cites only a declaration. The
    generic create/delete claims are fairly labeled as foundation and may keep
    their type-plus-prepare citations.

13. **Severity: minor. Contract question: E1.**

    **Objection:** Criterion 3 requires “shared semantic axis tokens”
    (`select-edit.md:591-593`), but a static search of `@himmelcad/theme` and
    `@himmelcad/ui` found no axis X/Y/Z tokens. The spec neither names their token
    identifiers nor lists them as new shared-theme work. “Distinct” without
    defined light/dark values and contrast states is not a failable in-repo
    reference; an implementer must invent the most visible part of the gizmo.

    **Proposed resolution:** Add shared theme tokens such as
    `--hc-axis-x/y/z` plus hover/active treatment through the design-system
    source, define both themes and contrast criteria over dense clouds/rasters,
    export them from `@himmelcad/theme`, and list that work in §8. Update G-SE-E1
    screenshots to assert the actual token values at 100%/200% and color-
    deficiency-safe non-color cues. This is a shared design-system extension,
    not one-off gizmo chrome.

## Contract questions answered convincingly

**B3** is convincing: viewport tool plus docked right panel is the correct
surface for fence/gizmo interaction, and inline commands remain inline.
**C3** is convincing at the architectural level: immutable geometry reuse,
transient group transforms, spatial indexes, cached effective lock, and
deduplicated objects are the right freeze/precompute posture. **D2** is
convincing: decorative density/fidelity degrades before input response,
precision, P4 correctness, or atomicity. The P4 visible-set half of **C2** is
also good, but C2 overall is not convincing because the fence modes and isolate
membership lifecycle remain ambiguous.

## Executed vs. read

**Executed:** no build, application, test, benchmark, or dev server, per the
static-review instruction. I performed only non-mutating repository searches
and line reads. Those checks established that all three `G-SE-*` scripts, every
registry `SE-D*`/Select-Edit row, the `.hcadx` fragment profile, and shared axis
tokens are absent.

**Read:** `.claude/agents/demanding-user.md`; `CURRENT-DIRECTION.md`,
`README.md`, the full CURRENT `FUNCTION-CONTRACT.md`, `DECISION-DOCTRINE.md`
(X1–X7, P1–P6, escalation protocol), `DESIGN-SYSTEM.md`, `AGENT-FEEDBACK.md`
(SYSTEM-001), `TEST-TIERS.md`, `PROJECT-FORMAT.md`; Builder-program README,
OWNER-DECISIONS, and REGISTRY; the complete target; the viewing-box gold
standard; the prior Draw, Pointcloud, and File/Project reviews; the relevant
normative sections and decision records in UI Platform, File/Project,
Pointcloud, Draw, Measure/Inspect, View Domain, and Raster; the complete RIB
Civil, RealWorks, Revit, and Trimble Perspective/Access dossiers; and every
file:line code citation made by the target. No web research was needed because
the review questions were answerable from current repo-resident evidence.

## Owner-decision items

**None — count 0.** Every resolution above is derived and vetoable, not a
question: correctness and no-silent-coordinate behavior come from X1;
placement-only geometry and interaction-first performance from X2; canonical
lock/clipboard commands and automation parity from X3; interaction pairs from
X5; thresholds from X6/P3; sibling ownership and cite-and-revise from X7 plus
the Builder-program README; visible-set behavior from P4; one-commit gestures
from P5; and UI/restore behavior from the Design System and C4. No axiom
conflict, product-identity/scope/money/licensing call, or owner-reserved
boundary survives the escalation protocol.

## System feedback

No doctrine axiom failed. A2, D1, E2, and the registry rules did their jobs; the
spec asserted compliance without supplying the required evidence. C4 would
benefit from one explicit example—**Exit/Clear of a temporary visibility mode
is a restore operation and must name its affected-state set**—because this spec
did not recognize Exit isolate as belonging to the existing restore-scope rule.
That is a wording hardening opportunity, not a new product decision.
