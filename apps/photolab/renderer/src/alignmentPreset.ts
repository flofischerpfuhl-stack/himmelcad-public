import type { AlignmentQualityProfile } from '@himmelcad/data';

/** On-disk PhotoLab alignment preset (JSON body, extension `.hcalign`). */
export const ALIGNMENT_PRESET_FORMAT_VERSION = 1 as const;
export const ALIGNMENT_PRESET_KIND = 'alignmentPreset' as const;
export const ALIGNMENT_PRESET_EXTENSION = 'hcalign';

export interface AlignmentPresetOverrides {
  /** Long-edge resize for feature extract (px). */
  maxImageEdge?: number;
  /** Target SIFT/ALIKED density before profile clamp. */
  keypointsPerMegapixel?: number;
  /** Sequential matcher overlap (ignored for exhaustive Maximum Robustness). */
  sequentialOverlap?: number;
  /**
   * Absolute stored-feature budget passed to extractors (before COLMAP SIFT
   * orientation halving). When omitted, density × edge is used.
   */
  featureBudget?: number;
}

export interface AlignmentPresetFile {
  formatVersion: typeof ALIGNMENT_PRESET_FORMAT_VERSION;
  kind: typeof ALIGNMENT_PRESET_KIND;
  id: string;
  name: string;
  description: string;
  savedAt: string;
  profile: AlignmentQualityProfile;
  overrides: AlignmentPresetOverrides;
}

export type AlignmentPresetParseResult =
  | { ok: true; preset: AlignmentPresetFile }
  | { ok: false; errors: string[] };

const PROFILES = new Set<AlignmentQualityProfile>([
  'fast',
  'qualityHybrid',
  'maximumRobustness',
]);

export function defaultOverridesForProfile(
  profile: AlignmentQualityProfile,
): Required<AlignmentPresetOverrides> {
  switch (profile) {
    case 'fast':
      return {
        maxImageEdge: 2_400,
        keypointsPerMegapixel: 5_500,
        sequentialOverlap: 20,
        featureBudget: 8_192,
      };
    case 'qualityHybrid':
      return {
        maxImageEdge: 8_192,
        keypointsPerMegapixel: 8_000,
        sequentialOverlap: 24,
        featureBudget: 16_000,
      };
    case 'maximumRobustness':
      return {
        maxImageEdge: 12_000,
        keypointsPerMegapixel: 12_000,
        sequentialOverlap: 32,
        featureBudget: 32_000,
      };
  }
}

export function buildAlignmentPreset(input: {
  name: string;
  description?: string;
  profile: AlignmentQualityProfile;
  overrides: AlignmentPresetOverrides;
  id?: string;
}): AlignmentPresetFile {
  const name = input.name.trim();
  if (!name) throw new Error('Preset name is required');
  return {
    formatVersion: ALIGNMENT_PRESET_FORMAT_VERSION,
    kind: ALIGNMENT_PRESET_KIND,
    id: input.id ?? crypto.randomUUID(),
    name,
    description: (input.description ?? '').trim(),
    savedAt: new Date().toISOString(),
    profile: input.profile,
    overrides: sanitizeOverrides(input.overrides),
  };
}

/** Strict parse for import — returns all validation errors. */
export function parseAlignmentPreset(value: unknown): AlignmentPresetParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['File is not a JSON object'] };
  }
  if (value.formatVersion !== ALIGNMENT_PRESET_FORMAT_VERSION) {
    errors.push(
      `Unsupported formatVersion (expected ${ALIGNMENT_PRESET_FORMAT_VERSION}, got ${String(value.formatVersion)})`,
    );
  }
  if (value.kind !== ALIGNMENT_PRESET_KIND) {
    errors.push(
      `Wrong file kind (expected "${ALIGNMENT_PRESET_KIND}", got ${String(value.kind ?? 'missing')}). ` +
        'This does not look like a PhotoLab alignment preset (.hcalign).',
    );
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    errors.push('Missing or empty "name"');
  }
  if (typeof value.profile !== 'string' || !PROFILES.has(value.profile as AlignmentQualityProfile)) {
    errors.push(
      `Invalid profile (expected fast | qualityHybrid | maximumRobustness, got ${String(value.profile)})`,
    );
  }
  if (value.overrides !== undefined && !isRecord(value.overrides)) {
    errors.push('"overrides" must be an object when present');
  }

  const overrides = isRecord(value.overrides) ? value.overrides : {};
  const overrideErrors = validateOverrideFields(overrides);
  errors.push(...overrideErrors);

  if (errors.length > 0) return { ok: false, errors };

  const profile = value.profile as AlignmentQualityProfile;
  return {
    ok: true,
    preset: {
      formatVersion: ALIGNMENT_PRESET_FORMAT_VERSION,
      kind: ALIGNMENT_PRESET_KIND,
      id: typeof value.id === 'string' && value.id.trim() ? value.id : crypto.randomUUID(),
      name: (value.name as string).trim(),
      description: typeof value.description === 'string' ? value.description.trim() : '',
      savedAt:
        typeof value.savedAt === 'string' && value.savedAt
          ? value.savedAt
          : new Date().toISOString(),
      profile,
      overrides: sanitizeOverrides(overrides as AlignmentPresetOverrides),
    },
  };
}

function validateOverrideFields(overrides: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const check = (
    key: string,
    min: number,
    max: number,
    label: string,
  ): void => {
    if (!(key in overrides) || overrides[key] === undefined || overrides[key] === null) return;
    const n = overrides[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push(`${label} must be an integer`);
      return;
    }
    if (n < min || n > max) errors.push(`${label} must be between ${min} and ${max}`);
  };
  check('maxImageEdge', 1_024, 32_768, 'maxImageEdge');
  check('keypointsPerMegapixel', 500, 50_000, 'keypointsPerMegapixel');
  check('sequentialOverlap', 2, 128, 'sequentialOverlap');
  check('featureBudget', 1_024, 64_000, 'featureBudget');
  return errors;
}

function sanitizeOverrides(input: AlignmentPresetOverrides): AlignmentPresetOverrides {
  const out: AlignmentPresetOverrides = {};
  if (typeof input.maxImageEdge === 'number') out.maxImageEdge = input.maxImageEdge;
  if (typeof input.keypointsPerMegapixel === 'number')
    out.keypointsPerMegapixel = input.keypointsPerMegapixel;
  if (typeof input.sequentialOverlap === 'number')
    out.sequentialOverlap = input.sequentialOverlap;
  if (typeof input.featureBudget === 'number') out.featureBudget = input.featureBudget;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
