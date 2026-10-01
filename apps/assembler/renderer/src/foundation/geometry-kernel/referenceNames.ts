/**
 * Readable `Missing reference: …` messages. The kernel raises them with
 * internal ids (`construction plane "feature-constructionPlane-4"`, `body
 * "body:feature-extrude-2"`, `face "feature-extrude-1:end:0" on "Body 1"`,
 * `line "l3" of "Sketch 1"`); before an evaluation result leaves the
 * evaluator they are rewritten to the names the user sees in History and
 * Items ("Plane 2", `body of "Extrude 2"`, `the end face of "Body 1"
 * created by "Extrude 1"`, `a line of "Sketch 1"`), or say that the step was
 * deleted. Naming keys (`kernel/naming.ts`) carry the generating step and
 * the face's role, which is all a person can recognise of them.
 */
import { baseEdgeKey, baseFaceKey, keyFeatureId } from './naming.js';

interface Named {
  readonly id: string;
  readonly name: string;
}

const STEP_REF = /Missing reference: (construction plane|construction axis|sketch) "([^"]+)"/;
const BODY_REF = /Missing reference: body "([^"]+)"/;
const FACE_REF = /Missing reference: face "([^"]+)"(?: on "([^"]+)")?/;
const EDGE_REF = /Missing reference: edge "([^"]+)"(?: on "([^"]+)")?/;
const SKETCH_ITEM_REF = /Missing reference: (profile|line|point) "([^"]+)" of "([^"]+)"/;
const MIRRORED_SKETCH = /^(.+):sketch:(\d+)$/;

/** Face roles of the naming scheme (`<featureId>:<role>:…`), as words. */
const FACE_ROLES: Record<string, string> = {
  start: 'the start face',
  end: 'the end face',
  side: 'a side face',
  round: 'a fillet face',
  chamfer: 'a chamfer face',
  inner: 'an inner shell face',
};

function stepName(names: ReadonlyMap<string, string>, id: string): string | null {
  const name = names.get(id);
  return name === undefined ? null : `"${name}"`;
}

/** Whether a key prefix looks like a step id (`feature-<kind>-<n>`), so its absence means "deleted". */
function looksLikeStepId(id: string): boolean {
  return /^feature-[A-Za-z]+-\d+$/.test(id);
}

/** The step that created a face key: its name, "a deleted step", or `null` when the key names no step. */
function creatorOf(names: ReadonlyMap<string, string>, key: string): string | null {
  const owner = keyFeatureId(baseFaceKey(key));
  const name = stepName(names, owner);
  if (name) return name;
  return looksLikeStepId(owner) ? 'a deleted step' : null;
}

/** `the end face of "Body 1" created by "Extrude 1"` for a face key. */
function describeFace(names: ReadonlyMap<string, string>, key: string, body?: string): string {
  const base = baseFaceKey(key);
  const role = base.split(':')[1];
  const creator = creatorOf(names, base);
  const what = creator && role && FACE_ROLES[role] ? FACE_ROLES[role] : 'a face';
  const of = body ? ` of "${body}"` : '';
  return `${what}${of}${creator ? ` created by ${creator}` : ''}`;
}

/** `an edge of "Body 1" created by "Extrude 1"` (or between faces of two steps). */
function describeEdge(names: ReadonlyMap<string, string>, key: string, body?: string): string {
  const [a, b] = baseEdgeKey(key).split('|');
  const creators = [
    ...new Set([a, b].filter((k): k is string => !!k).map((k) => creatorOf(names, k))),
  ];
  const known = creators.filter((c): c is string => c !== null);
  const of = body ? ` of "${body}"` : '';
  if (known.length === 0) return `an edge${of}`;
  if (known.length === 1 && creators.length === 1) return `an edge${of} created by ${known[0]}`;
  return `an edge${of} between faces created by ${known.join(' and ')}`;
}

/** `message` with feature/body ids and naming keys replaced by readable names (unchanged if it names nothing known). */
export function nameMissingReference(message: string, names: ReadonlyMap<string, string>): string {
  const step = STEP_REF.exec(message);
  if (step) {
    const [whole, kind, id] = step as unknown as [string, string, string];
    let text = `${kind} ${stepName(names, id) ?? 'of a deleted step'}`;
    // A mirrored sketch (`<mirror id>:sketch:<i>`) is named after its Mirror step.
    const mirrored = kind === 'sketch' && !names.has(id) ? MIRRORED_SKETCH.exec(id) : null;
    const owner = mirrored ? stepName(names, mirrored[1]!) : null;
    if (mirrored && owner) text = `mirrored sketch ${Number(mirrored[2]) + 1} of ${owner}`;
    return message.replace(whole, `Missing reference: ${text}`);
  }
  const body = BODY_REF.exec(message);
  if (body) {
    const [whole, id] = body as unknown as [string, string];
    const owner = /^body:([^:]+)/.exec(id)?.[1];
    const text = owner ? stepName(names, owner) : null;
    return message.replace(whole, `Missing reference: body of ${text ?? 'a deleted step'}`);
  }
  const face = FACE_REF.exec(message);
  if (face) {
    const [whole, key, bodyName] = face as unknown as [string, string, string | undefined];
    return message.replace(whole, `Missing reference: ${describeFace(names, key, bodyName)}`);
  }
  const edge = EDGE_REF.exec(message);
  if (edge) {
    const [whole, key, bodyName] = edge as unknown as [string, string, string | undefined];
    return message.replace(whole, `Missing reference: ${describeEdge(names, key, bodyName)}`);
  }
  const item = SKETCH_ITEM_REF.exec(message);
  if (item) {
    const [whole, kind, , sketch] = item as unknown as [string, string, string, string];
    const what = kind === 'profile' ? 'a profile' : kind === 'line' ? 'a line' : 'a point';
    return message.replace(whole, `Missing reference: ${what} of "${sketch}"`);
  }
  return message;
}

/** Every error of an evaluation with readable references (a new object; `errors` is not changed). */
export function nameMissingReferences(
  errors: Readonly<Record<string, string>>,
  features: readonly Named[],
): Record<string, string> {
  const names = new Map(features.map((f) => [f.id, f.name]));
  const out: Record<string, string> = {};
  for (const [id, message] of Object.entries(errors)) {
    out[id] = message.includes('Missing reference')
      ? nameMissingReference(message, names)
      : message;
  }
  return out;
}
