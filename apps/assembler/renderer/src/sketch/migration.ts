/**
 * `.hcasm` schema v1 → v2 migration of sketches (raw JSON, before strict
 * validation):
 *
 * - v1 `sketch.profiles` (rectangles/circles) become fully dimensioned v2
 *   entities, constraints and dimensions (`builders.sketchFromLegacyProfiles`);
 * - v1 extrude `profile.profileIndex` becomes `profile.regions`, the region
 *   keys of the regions inside that profile;
 * - naming keys that encoded v1 profile/segment indices
 *   (`<extrude>:side:<profile>:<segment>`, `<extrude>:start|end:<profile>`)
 *   are rewritten to the v2 form (`<extrude>:side:<p>:<entityId>`) wherever
 *   a face or edge reference stores them.
 *
 * Anything that does not look like a v1 sketch is left untouched so the
 * strict validator reports it with a path-qualified message.
 */
import {
  legacyProfileContains,
  sketchFromLegacyProfiles,
  type LegacySketchProfile,
} from './builders.js';
import { detectRegions } from './regions.js';

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asLegacyProfile(v: unknown): LegacySketchProfile | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'rectangle' && [v.x, v.y, v.width, v.height].every(isNumber)) {
    return v as unknown as LegacySketchProfile;
  }
  if (v.kind === 'circle' && [v.cx, v.cy, v.radius].every(isNumber)) {
    return v as unknown as LegacySketchProfile;
  }
  return null;
}

interface MigratedSketch {
  /** Entity id replacing legacy segment `s` of profile `i`. */
  segmentEntities: string[][];
  /** Region keys inside legacy profile `i`. */
  profileRegions: string[][];
}

/** Migrates a v1 `features` array to v2 (returns a new array; the input is not mutated). */
export function migrateSketchesV1ToV2(features: unknown): unknown {
  if (!Array.isArray(features)) return features;
  const migrated = new Map<string, MigratedSketch>();
  const renamed = new Map<string, string>();

  const out = features.map((f: unknown) => {
    if (!isRecord(f) || f.kind !== 'sketch' || !Array.isArray(f.profiles)) return f;
    const profiles = f.profiles.map(asLegacyProfile);
    if (profiles.some((p) => p === null) || typeof f.id !== 'string') return f;
    const legacy = profiles as LegacySketchProfile[];
    const { sketch, segmentEntities } = sketchFromLegacyProfiles(legacy);
    const regions = detectRegions(sketch);
    migrated.set(f.id, {
      segmentEntities,
      profileRegions: legacy.map((profile) =>
        regions.filter((r) => legacyProfileContains(profile, r.sample)).map((r) => r.key),
      ),
    });
    const { profiles: _dropped, ...rest } = f;
    return { ...rest, ...sketch };
  });

  const withProfiles = out.map((f: unknown) => {
    if (!isRecord(f) || f.kind !== 'extrude' || typeof f.id !== 'string') return f;
    const profile = f.profile;
    if (!isRecord(profile) || profile.kind !== 'sketch' || typeof profile.featureId !== 'string') {
      return f;
    }
    const source = migrated.get(profile.featureId);
    if (!source) return f;
    const indices = isNumber(profile.profileIndex)
      ? [profile.profileIndex]
      : source.profileRegions.map((_, i) => i);
    const regions: string[] = [];
    for (const i of indices) {
      const keys = source.profileRegions[i] ?? [];
      const first = keys[0];
      for (const key of keys) if (!regions.includes(key)) regions.push(key);
      if (first === undefined) continue;
      const p = regions.indexOf(first);
      renamed.set(`${f.id}:start:${i}`, `${f.id}:start:${p}`);
      renamed.set(`${f.id}:end:${i}`, `${f.id}:end:${p}`);
      (source.segmentEntities[i] ?? []).forEach((entityId, s) => {
        renamed.set(`${f.id}:side:${i}:${s}`, `${f.id}:side:${p}:${entityId}`);
      });
    }
    const { profileIndex: _index, ...restProfile } = profile;
    // "Every profile" stays "every region" when that is the same list in the same order.
    const all = [...new Set(source.profileRegions.flat())].sort();
    const same = !isNumber(profile.profileIndex) && all.join('\n') === regions.join('\n');
    return { ...f, profile: same ? restProfile : { ...restProfile, regions } };
  });

  if (renamed.size === 0) return withProfiles;
  return withProfiles.map((f: unknown) => rewriteKeys(f, renamed));
}

/** Rewrites every face-key part of `key` fields in face/edge references (`A|B`, `#n`, `~n` kept). */
function rewriteKeys(value: unknown, renamed: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteKeys(v, renamed));
  if (!isRecord(value)) return value;
  const out: Raw = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'key' && typeof v === 'string' && isRecord(value.signature)) {
      out[k] = v.replace(/[^|#~]+/g, (part) => renamed.get(part) ?? part);
    } else {
      out[k] = rewriteKeys(v, renamed);
    }
  }
  return out;
}
