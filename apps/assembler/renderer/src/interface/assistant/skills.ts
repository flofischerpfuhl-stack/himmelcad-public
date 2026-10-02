/**
 * Assistant skills (assembler/AGENT-ASSISTANT.md "Skills"): short Markdown
 * workflows an agent reads on demand. Two scopes, as in Builder's agent plan
 * (AG-D1/AG-D2), narrowed for Assembler:
 *
 * - **built-in** — read-only, shipped with the app
 *   (`assembler/agent-skills/builtin/<id>/SKILL.md`, embedded by
 *   `scripts/generate-skills.mjs`);
 * - **project** — written by the user in the assistant's Skills tab, saved
 *   in the `.hcasm` file (`assistantSkills`), never shadowing a built-in id.
 *
 * Discovery is a compact index (`skills.list`: id, name, description, size,
 * paged) and paged reads (`skills.read`, at most {@link MAX_SKILL_READ_CHARS}
 * per call); nothing is preloaded into an agent's prompt.
 *
 * File format: a closed frontmatter subset (`id`, `name`, `description`,
 * `version`, `scope`, `tags`; plain scalars and `[a, b]` lists; unknown keys
 * are errors) and a non-empty Markdown body.
 */
import { create } from 'zustand';

import type { ApiContribution, ApiHandler } from '../../foundation/commands/api/registry.js';
import { API_ORDER } from '../../foundation/commands/api/registry.js';
import type { MethodSpec } from '../../foundation/commands/api/contract.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import {
  registerProjectFileField,
  type FileFieldHelpers,
} from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';
import { BUILTIN_SKILL_FILES } from './builtinSkills.generated.js';

export type SkillScope = 'built-in' | 'project';

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: number;
  scope: SkillScope;
  tags: string[];
  body: string;
  /** The whole file (frontmatter + body), as stored. */
  text: string;
}

/** Largest skill file (characters). */
export const MAX_SKILL_CHARS = 64 * 1024;
/** Default and largest page of `skills.read`. */
export const DEFAULT_SKILL_READ_CHARS = 4096;
export const MAX_SKILL_READ_CHARS = 16 * 1024;
/** Project skills per project. */
export const MAX_PROJECT_SKILLS = 64;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const KEYS = new Set(['id', 'name', 'description', 'version', 'scope', 'tags']);

export type SkillParse = { ok: true; skill: Skill } | { ok: false; errors: string[] };

/**
 * Parses a skill file. `scope` is the catalog that supplies it; the file's
 * own `scope` must match.
 */
export function parseSkill(text: string, scope: SkillScope): SkillParse {
  const errors: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length > MAX_SKILL_CHARS) {
    return { ok: false, errors: [`The skill is longer than ${MAX_SKILL_CHARS} characters.`] };
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(normalized);
  if (!match) return { ok: false, errors: ['The file must start with a --- frontmatter block.'] };
  const fields = new Map<string, string | string[]>();
  for (const [index, raw] of match[1]!.split('\n').entries()) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^([a-z_]+):\s*(.*)$/u.exec(line);
    if (!kv) {
      errors.push(`Frontmatter line ${index + 1}: expected "key: value".`);
      continue;
    }
    const [, key, value] = kv as unknown as [string, string, string];
    if (!KEYS.has(key)) {
      errors.push(`Unknown field "${key}".`);
      continue;
    }
    if (fields.has(key)) {
      errors.push(`Field "${key}" appears twice.`);
      continue;
    }
    const list = /^\[(.*)\]$/u.exec(value.trim());
    fields.set(
      key,
      list
        ? list[1]!
            .split(',')
            .map((item) => unquote(item.trim()))
            .filter(Boolean)
        : unquote(value.trim()),
    );
  }
  const text1 = (key: string, max: number): string => {
    const value = fields.get(key);
    if (typeof value !== 'string' || !value) {
      errors.push(`"${key}" is required.`);
      return '';
    }
    if (value.length > max) errors.push(`"${key}" is longer than ${max} characters.`);
    return value;
  };
  const id = text1('id', 64);
  if (id && !ID.test(id)) errors.push('"id" must be lower-case words joined by hyphens.');
  const name = text1('name', 80);
  const description = text1('description', 240);
  const versionText = fields.get('version');
  const version = typeof versionText === 'string' ? Number(versionText) : NaN;
  if (!Number.isInteger(version) || version < 1)
    errors.push('"version" must be a whole number ≥ 1.');
  const fileScope = fields.get('scope');
  if (fileScope !== scope) errors.push(`"scope" must be ${scope}.`);
  const tagsValue = fields.get('tags') ?? [];
  const tags = Array.isArray(tagsValue) ? tagsValue : [tagsValue];
  if (tags.length > 16) errors.push('At most 16 tags.');
  for (const tag of tags) if (!TAG.test(tag)) errors.push(`Tag "${tag}" is not a lower-case word.`);
  const body = match[2]!.trim();
  if (!body) errors.push('The skill needs a Markdown body.');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    skill: { id, name, description, version, scope, tags, body, text: normalized },
  };
}

function unquote(value: string): string {
  return /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
}

/** A starter for "New skill". */
export function skillTemplate(id = 'my-skill'): string {
  return [
    '---',
    `id: ${id}`,
    'name: My skill',
    'description: What this workflow is for, in one sentence.',
    'version: 1',
    'scope: project',
    'tags: [workflow]',
    '---',
    '',
    '# My skill',
    '',
    'Steps the assistant should follow, the checks it must pass before it is done.',
    '',
  ].join('\n');
}

// ---- catalog ----------------------------------------------------------------------------

export const BUILTIN_SKILLS: readonly Skill[] = Object.entries(BUILTIN_SKILL_FILES).map(
  ([id, text]) => {
    const parsed = parseSkill(text, 'built-in');
    if (!parsed.ok) throw new Error(`Built-in skill ${id}: ${parsed.errors.join(' ')}`);
    if (parsed.skill.id !== id)
      throw new Error(`Built-in skill ${id} declares id ${parsed.skill.id}`);
    return parsed.skill;
  },
);

interface ProjectSkillsState {
  skills: readonly Skill[];
  /** Adds or replaces (by id) a project skill; throws with the validation errors. */
  save(text: string, previousId?: string): Skill;
  remove(id: string): void;
  replaceAll(skills: readonly Skill[]): void;
}

export const useProjectSkills = create<ProjectSkillsState>((set, get) => ({
  skills: [],
  save: (text, previousId) => {
    const parsed = parseSkill(text, 'project');
    if (!parsed.ok) throw new Error(parsed.errors.join(' '));
    const skill = parsed.skill;
    if (BUILTIN_SKILLS.some((b) => b.id === skill.id)) {
      throw new Error(`"${skill.id}" is a built-in skill; choose another id.`);
    }
    const others = get().skills.filter((s) => s.id !== (previousId ?? skill.id));
    if (others.some((s) => s.id === skill.id))
      throw new Error(`A skill "${skill.id}" exists already.`);
    if (others.length >= MAX_PROJECT_SKILLS)
      throw new Error(`At most ${MAX_PROJECT_SKILLS} skills.`);
    const index = get().skills.findIndex((s) => s.id === (previousId ?? skill.id));
    const next = [...get().skills];
    if (index >= 0) next[index] = skill;
    else next.push(skill);
    set({ skills: next });
    return skill;
  },
  remove: (id) => set((s) => ({ skills: s.skills.filter((skill) => skill.id !== id) })),
  replaceAll: (skills) => set({ skills: [...skills] }),
}));

/** Built-in skills first, then the project's. */
export function allSkills(): readonly Skill[] {
  return [...BUILTIN_SKILLS, ...useProjectSkills.getState().skills];
}

export function findSkill(id: string): Skill | undefined {
  return allSkills().find((s) => s.id === id);
}

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  version: number;
  tags: string[];
  chars: number;
}

export function indexEntry(skill: Skill): SkillIndexEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    version: skill.version,
    tags: skill.tags,
    chars: skill.body.length,
  };
}

/** Skills whose id, name, description or tags contain every word of `query`. */
export function searchSkills(query: string | undefined, skills = allSkills()): Skill[] {
  const words = (query ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [...skills];
  return skills.filter((skill) => {
    const haystack =
      `${skill.id} ${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** One page of a skill's body (characters `offset` … `offset + max`). */
export function readSkillPage(
  skill: Skill,
  offset = 0,
  max = DEFAULT_SKILL_READ_CHARS,
): { text: string; offset: number; total: number; nextOffset: number | null } {
  const start = Math.max(0, Math.min(offset, skill.body.length));
  const end = Math.min(skill.body.length, start + Math.max(1, Math.min(max, MAX_SKILL_READ_CHARS)));
  return {
    text: skill.body.slice(start, end),
    offset: start,
    total: skill.body.length,
    nextOffset: end < skill.body.length ? end : null,
  };
}

// ---- agent API ----------------------------------------------------------------------------

const str: JsonSchema = { type: 'string', minLength: 1 };

export const SKILL_METHODS: Record<string, MethodSpec> = {
  'skills.list': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Compact index of the assistant skills (built-in workflows and the project’s own): id, name, description, scope, size. Filter with `query` (all words must match), page with `cursor`.',
    params: {
      type: 'object',
      properties: {
        query: str,
        scope: { enum: ['built-in', 'project'] },
        cursor: {
          type: 'integer',
          minimum: 0,
          description: 'Index of the first entry (from `nextCursor`).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: [],
      additionalProperties: false,
    },
    result:
      '{skills: [{id, name, description, scope, version, tags, chars}], total, nextCursor: number | null}',
  },
  'skills.read': {
    kind: 'query',
    capability: 'document.read',
    summary: `One page of a skill's Markdown body (default ${DEFAULT_SKILL_READ_CHARS}, at most ${MAX_SKILL_READ_CHARS} characters); continue at \`nextOffset\`.`,
    params: {
      type: 'object',
      properties: {
        id: str,
        offset: { type: 'integer', minimum: 0, default: 0 },
        maxChars: {
          type: 'integer',
          minimum: 256,
          maximum: MAX_SKILL_READ_CHARS,
          default: DEFAULT_SKILL_READ_CHARS,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    result: '{id, name, scope, version, offset, total, text, nextOffset: number | null}',
  },
};

const list: ApiHandler = (_ctx, p) => {
  let skills = searchSkills(typeof p.query === 'string' ? p.query : undefined);
  if (p.scope === 'built-in' || p.scope === 'project')
    skills = skills.filter((s) => s.scope === p.scope);
  const cursor = typeof p.cursor === 'number' ? p.cursor : 0;
  const limit = typeof p.limit === 'number' ? p.limit : 20;
  const page = skills.slice(cursor, cursor + limit);
  return {
    skills: page.map(indexEntry),
    total: skills.length,
    nextCursor: cursor + limit < skills.length ? cursor + limit : null,
  };
};

const read: ApiHandler = (_ctx, p) => {
  const skill = findSkill(String(p.id));
  if (!skill) {
    throw new ApiError('notFound', `No skill "${String(p.id)}"`, {
      hint: 'skills.list returns the skill ids.',
      details: { candidates: allSkills().map((s) => s.id) },
    });
  }
  const page = readSkillPage(
    skill,
    typeof p.offset === 'number' ? p.offset : 0,
    typeof p.maxChars === 'number' ? p.maxChars : DEFAULT_SKILL_READ_CHARS,
  );
  return { id: skill.id, name: skill.name, scope: skill.scope, version: skill.version, ...page };
};

export const SKILLS_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.skills,
      methods: {
        'skills.list': { spec: SKILL_METHODS['skills.list']!, handler: list },
        'skills.read': { spec: SKILL_METHODS['skills.read']!, handler: read },
      },
    },
  ],
};

// ---- project file -----------------------------------------------------------------------

/** A project skill in the `.hcasm` file: the whole SKILL.md text. */
export interface ProjectSkillRecord {
  text: string;
}

declare module '../../foundation/document/format.js' {
  interface ProjectFileFields {
    /** The project's own assistant skills (Block 9; additive, written only when present). */
    assistantSkills?: ProjectSkillRecord[];
  }
}

function validateSkillRecords(raw: unknown, h: FileFieldHelpers): ProjectSkillRecord[] {
  if (!Array.isArray(raw)) h.fail('assistantSkills', 'expected an array');
  if (raw.length > MAX_PROJECT_SKILLS)
    h.fail('assistantSkills', `at most ${MAX_PROJECT_SKILLS} skills`);
  return raw.map((r: unknown, i) => {
    const path = `assistantSkills[${i}]`;
    if (!h.isRecord(r)) h.fail(path, 'expected an object');
    if (!h.isString(r.text) || r.text.length === 0 || r.text.length > MAX_SKILL_CHARS) {
      h.fail(`${path}.text`, 'expected the skill file text');
    }
    return { text: r.text };
  });
}

registerProjectFileField({
  key: 'assistantSkills',
  module: 'assistant',
  order: 400,
  validate: validateSkillRecords,
  include: (records) => records.length > 0,
});

/** Opened files: a record that does not parse (any more) is kept out of the catalog, not a reason to fail the open. */
export function skillsFromRecords(records: readonly ProjectSkillRecord[]): Skill[] {
  const out: Skill[] = [];
  for (const record of records) {
    const parsed = parseSkill(record.text, 'project');
    if (!parsed.ok) continue;
    if (BUILTIN_SKILLS.some((b) => b.id === parsed.skill.id)) continue;
    if (out.some((s) => s.id === parsed.skill.id)) continue;
    out.push(parsed.skill);
  }
  return out;
}

export const SKILLS_PROJECT_SECTION: ProjectSection = {
  id: 'assistant.skills',
  order: 400,
  save: () => {
    const skills = useProjectSkills.getState().skills;
    return skills.length > 0
      ? { fields: { assistantSkills: skills.map((s) => ({ text: s.text })) } }
      : {};
  },
  load: (project) =>
    useProjectSkills.getState().replaceAll(skillsFromRecords(project?.assistantSkills ?? [])),
  subscribe: (onChange) =>
    useProjectSkills.subscribe((state, previous) => {
      if (state.skills !== previous.skills) onChange();
    }),
};
