/**
 * Minimum-reader rule of the `.hcasm` format (README "Files", MODULES.md §3).
 *
 * Optional fields are additive: a reader that does not know one ignores it.
 * That is harmless for data that does not change the geometry (a parameter
 * range, a view setting), but an optional field that changes what the
 * features *build* (an extrude taper, a helical revolve) would silently open
 * as the plain feature in a build that predates it. So the writer lists every
 * such **capability** the document uses in the file's `requires` field, each
 * with a readable label, and a reader refuses a file that requires a
 * capability it does not know:
 *
 *   "This project needs a newer HimmelCAD Assembler: it uses Extrude taper."
 *
 * The field is written only when a capability is in use, so a document
 * without one stays byte-identical, and the schema version stays 3. A
 * capability is declared by the module that owns the field — feature kinds
 * through `FeatureKindDefinition.formatCapabilities` (`featureKinds.ts`),
 * anything else with {@link registerFormatCapability}. Once released, an id
 * is never renamed or reused.
 */

/** A capability a reader must know to open a document that uses it. */
export interface FormatCapability {
  /** Stable id, `<kind or area>.<field>` (e.g. `extrude.taper`). */
  id: string;
  /** Written next to the id, so even a reader that never heard of it can name it. */
  label: string;
  /** Owning module id (`apps/assembler/modules.json`), for diagnostics. */
  module: string;
}

/** One entry of a file's `requires` list. */
export interface RequiredCapability {
  id: string;
  label: string;
}

const capabilities = new Map<string, FormatCapability>();

const ID_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

/** Declares a capability this build reads (once per id; a second owner throws). */
export function registerFormatCapability(capability: FormatCapability): void {
  if (!ID_PATTERN.test(capability.id)) {
    throw new Error(`Format capability id "${capability.id}" is not of the form "area.field"`);
  }
  const known = capabilities.get(capability.id);
  if (known) {
    if (known.module === capability.module && known.label === capability.label) return;
    throw new Error(
      `Format capability "${capability.id}" is registered twice (${known.module}, ${capability.module})`,
    );
  }
  capabilities.set(capability.id, { ...capability });
}

/** The capability `id` if this build reads it. */
export function formatCapability(id: string): FormatCapability | undefined {
  return capabilities.get(id);
}

/** Every capability this build reads, in registration order. */
export function knownFormatCapabilities(): FormatCapability[] {
  return [...capabilities.values()];
}

/**
 * The `requires` list of a file, sorted by id (stable bytes), or `null` when
 * it has none. Each id appears once.
 */
export function requiredCapabilitiesList(ids: Iterable<string>): RequiredCapability[] | null {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return null;
  return unique.map((id) => {
    const capability = capabilities.get(id);
    if (!capability) throw new Error(`Format capability "${id}" is not registered`);
    return { id, label: capability.label };
  });
}

/**
 * Checks a file's raw `requires` value: `null` when this build reads every
 * listed capability, else the message a reader shows. A malformed list is a
 * format error of its own (`malformed`).
 */
export function unknownRequiredCapabilities(
  raw: unknown,
): { kind: 'ok' } | { kind: 'unknown'; message: string } | { kind: 'malformed'; message: string } {
  if (raw === undefined) return { kind: 'ok' };
  if (!Array.isArray(raw)) return { kind: 'malformed', message: 'expected an array' };
  const missing: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { kind: 'malformed', message: `entry ${index}: expected an object` };
    }
    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') {
      return { kind: 'malformed', message: `entry ${index}: expected a non-empty "id"` };
    }
    if (label !== undefined && typeof label !== 'string') {
      return { kind: 'malformed', message: `entry ${index}: expected a string "label"` };
    }
    if (!capabilities.has(id)) {
      missing.push(typeof label === 'string' && label.trim() !== '' ? label.trim() : id);
    }
  }
  if (missing.length === 0) return { kind: 'ok' };
  return {
    kind: 'unknown',
    message:
      `This project needs a newer HimmelCAD Assembler: it uses ${joinLabels(missing)}. ` +
      `Update the app to open it.`,
  };
}

function joinLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
