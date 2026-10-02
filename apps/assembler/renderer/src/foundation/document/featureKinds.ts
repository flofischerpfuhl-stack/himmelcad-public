/**
 * The open feature-kind registry of the document (assembler/MODULES.md §3).
 *
 * A feature kind is declared by the module that owns it, never in a central
 * list:
 *
 * - its **type** joins the {@link Feature} union through a module
 *   augmentation of {@link FeatureKindMap}:
 *
 *   ```ts
 *   declare module '../../foundation/document/featureKinds.js' {
 *     interface FeatureKindMap { hole: HoleFeature }
 *   }
 *   ```
 *
 * - its **runtime facts** (History-card label, `.hcasm` validator, sketch
 *   profiles it consumes, formula fields, boolean-result rule) are
 *   registered with {@link registerFeatureKind} when the module's `kinds`
 *   file is loaded (by the product composition, the kernel-worker
 *   composition and the headless CLI).
 *
 * Plain data only; no store, no kernel, no UI.
 */
import type { EdgeRef, FaceRef } from './document.js';
import { registerFormatCapability } from './formatCapabilities.js';

/** Fields every feature has, regardless of kind. */
export interface FeatureBase {
  /** Stable, unique identifier. Never reused, never derived from position. */
  id: string;
  /** History-card display name, e.g. `"Sketch 1"`, `"Extrude 2"`. */
  name: string;
  /** When `true`, evaluation skips this feature as if it were absent. */
  suppressed: boolean;
}

/**
 * Feature types by kind. Empty here: every module that owns a kind adds it
 * with a `declare module` augmentation (see the file comment), so adding a
 * kind never edits this file.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface FeatureKindMap {}

/** Every feature kind of this build. */
export type FeatureKind = keyof FeatureKindMap & string;

/** A stored feature of any registered kind. */
export type Feature = FeatureKindMap[keyof FeatureKindMap];

/** The feature type of one kind. */
export type FeatureOf<K extends FeatureKind> = FeatureKindMap[K];

/** Helpers the `.hcasm` validator hands to a kind's `validate` (strict, path-qualified). */
export interface FormatHelpers {
  fail: (path: string, message: string) => never;
  faceRef: (v: unknown, path: string) => FaceRef;
  edgeRef: (v: unknown, path: string) => EdgeRef;
}

export interface FeatureKindDefinition<K extends FeatureKind = FeatureKind> {
  kind: K;
  /** Owning module id (`apps/assembler/modules.json`), for diagnostics. */
  module: string;
  /** History-card name prefix (`"Revolve"` → `"Revolve 1"`). */
  label: string;
  /**
   * Strict `.hcasm` validation of the kind's own fields (the base fields
   * `id`/`name`/`suppressed` are already checked). Reports the first problem
   * with `h.fail(path, message)`; never repairs.
   */
  validate(record: Record<string, unknown>, path: string, h: FormatHelpers): void;
  /** Sketch feature ids the feature reads profiles/lines from (hidden once used). */
  sketchIdsUsedBy?(feature: FeatureKindMap[K]): string[];
  /** Numeric fields that accept a formula (`<field>Expression`), see `parameters.ts`. */
  expressionFields?: readonly string[];
  /** The subset of {@link expressionFields} that may resolve negative (a draft angle). */
  signedExpressionFields?: readonly string[];
  /**
   * Whether the feature's result is a boolean of solids, which gets the full
   * B-rep check on commit (`EvaluationRequest.commitCheck`).
   */
  booleanResult?(feature: FeatureKindMap[K]): boolean;
  /**
   * Optional fields of the kind that change what it builds, so an older
   * reader must refuse rather than ignore them (`formatCapabilities.ts`):
   * a feature that uses one puts its id into the file's `requires` list.
   */
  formatCapabilities?: readonly FeatureFormatCapability<FeatureKindMap[K]>[];
}

/** A capability of one kind and the rule that tells whether a feature uses it. */
export interface FeatureFormatCapability<F> {
  id: string;
  label: string;
  usedBy(feature: F): boolean;
}

const definitions = new Map<string, FeatureKindDefinition>();

/** Registers a feature kind. A kind is registered once; a second registration throws. */
export function registerFeatureKind<K extends FeatureKind>(
  definition: FeatureKindDefinition<K>,
): void {
  const existing = definitions.get(definition.kind);
  if (existing) {
    if (existing === (definition as unknown as FeatureKindDefinition)) return;
    throw new Error(
      `Feature kind "${definition.kind}" is registered twice (${existing.module}, ${definition.module})`,
    );
  }
  for (const capability of definition.formatCapabilities ?? []) {
    registerFormatCapability({
      id: capability.id,
      label: capability.label,
      module: definition.module,
    });
  }
  definitions.set(definition.kind, definition as unknown as FeatureKindDefinition);
}

/** Ids of the format capabilities `features` use (see `formatCapabilities.ts`). */
export function featureFormatCapabilities(features: readonly Feature[]): Set<string> {
  const used = new Set<string>();
  for (const feature of features) {
    for (const capability of definitions.get(feature.kind)?.formatCapabilities ?? []) {
      if (!used.has(capability.id) && capability.usedBy(feature)) used.add(capability.id);
    }
  }
  return used;
}

/** The registered definition of `kind`, or `undefined` for an unknown kind. */
export function featureKindDefinition(kind: string): FeatureKindDefinition | undefined {
  return definitions.get(kind);
}

/** Every registered kind, in registration order. */
export function registeredFeatureKinds(): string[] {
  return [...definitions.keys()];
}

/** History-card label prefix of `kind` (the kind itself for an unregistered one). */
export function featureKindLabel(kind: string): string {
  return definitions.get(kind)?.label ?? kind;
}

/** Sketch feature ids `feature` consumes (empty for kinds that read no sketch). */
export function sketchIdsUsedBy(feature: Feature): string[] {
  const definition = definitions.get(feature.kind);
  return definition?.sketchIdsUsedBy ? definition.sketchIdsUsedBy(feature) : [];
}

/** The formula fields of `kind` (empty for kinds without any). */
export function expressionFieldsOf(kind: string): readonly string[] {
  return definitions.get(kind)?.expressionFields ?? [];
}

/** Whether `kind.field` may resolve to a negative value. */
export function isSignedExpressionField(kind: string, field: string): boolean {
  return definitions.get(kind)?.signedExpressionFields?.includes(field) ?? false;
}

/**
 * Whether a feature's result is a boolean of solids: the kind's own rule,
 * else a Join/Cut/Intersect `operation` (every profile solid kind uses that
 * field). OCCT can return an invalid solid for such a boolean instead of
 * failing; committing one is refused after a full B-rep check
 * (`assembler/ROBUSTNESS.md`).
 */
export function isBooleanResult(feature: Feature): boolean {
  const rule = definitions.get(feature.kind)?.booleanResult;
  if (rule && rule(feature)) return true;
  const operation = (feature as { operation?: unknown }).operation;
  return operation === 'join' || operation === 'cut' || operation === 'intersect';
}
