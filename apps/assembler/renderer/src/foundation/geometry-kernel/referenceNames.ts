/**
 * Readable `Missing reference: …` messages. The kernel raises them with
 * internal ids (`construction plane "feature-constructionPlane-4"`, `body
 * "body:feature-extrude-2"`); before an evaluation result leaves the
 * evaluator they are rewritten to the step names the user sees in History
 * ("Plane 2", `body of "Extrude 2"`), or say that the step was deleted.
 * Face/edge/profile messages already name their sketch or keep a key that
 * has no better name, and pass through unchanged.
 */

interface Named {
  readonly id: string;
  readonly name: string;
}

const STEP_REF = /Missing reference: (construction plane|construction axis|sketch) "([^"]+)"/;
const BODY_REF = /Missing reference: body "([^"]+)"/;
const MIRRORED_SKETCH = /^(.+):sketch:(\d+)$/;

function stepName(names: ReadonlyMap<string, string>, id: string): string | null {
  const name = names.get(id);
  return name === undefined ? null : `"${name}"`;
}

/** `message` with feature/body ids replaced by step names (unchanged if it names nothing known). */
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
