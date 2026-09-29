/**
 * Minimal JSON Schema (draft 2020-12 subset) validator for the agent API
 * contract. The repository's dependency policy discourages new runtime
 * dependencies for small needs, and the contract only uses a small,
 * deliberate subset of keywords:
 *
 * `type`, `properties`, `required`, `additionalProperties`, `enum`, `const`,
 * `items`, `minItems`, `maxItems`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `minLength`, `pattern`, `oneOf`, `anyOf`, `$ref` (`#/$defs/...` only).
 *
 * Annotation keywords (`description`, `default`, `title`, `examples`,
 * `x-*`) are ignored. Unknown validation keywords are a programming error
 * and are reported by the schema self-test (`test/api/contract.test.ts`).
 */

export type JsonSchema = {
  $ref?: string;
  type?: SchemaType | SchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  pattern?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  description?: string;
  default?: unknown;
  title?: string;
  examples?: unknown[];
  $defs?: Record<string, JsonSchema>;
  $id?: string;
  $schema?: string;
} & Partial<Record<`x-${string}`, unknown>>;

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'minLength',
  'pattern',
  'oneOf',
  'anyOf',
  'description',
  'default',
  'title',
  'examples',
  '$defs',
  '$id',
  '$schema',
]);

function typeOf(value: unknown): SchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function typeMatches(value: unknown, type: SchemaType): boolean {
  const actual = typeOf(value);
  if (type === 'number') {
    return (actual === 'number' || actual === 'integer') && Number.isFinite(value as number);
  }
  return actual === type;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  const target = match ? root.$defs?.[match[1]!] : undefined;
  if (!target) throw new Error(`Unresolvable schema $ref "${ref}"`);
  return target;
}

/**
 * Validates `value` against `schema`; returns human-readable problems with
 * JSON paths (`params.profiles[0].radius: expected number`), empty if valid.
 * `root` supplies `$defs` for `$ref`.
 */
export function validateSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
  path = 'params',
): string[] {
  if (schema.$ref) return validateSchema(value, resolveRef(root, schema.$ref), root, path);
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `${path}: expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must have at least ${schema.minLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: allows at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateSchema(item, schema.items!, root, `${path}[${i}]`));
      });
    }
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        errors.push(`${path}.${key}: is required`);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (child === undefined) continue;
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        errors.push(...validateSchema(child, propertySchema, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(schema.properties ?? {});
        errors.push(
          `${path}.${key}: unknown property${known.length ? ` (allowed: ${known.join(', ')})` : ''}`,
        );
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validateSchema(child, schema.additionalProperties, root, `${path}.${key}`));
      }
    }
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((option) => validateSchema(value, option, root, path));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing !== 1) {
      if (passing === 0) {
        // Report the closest alternative (fewest problems) rather than all of them.
        const best = results.reduce((a, b) => (b.length < a.length ? b : a));
        errors.push(...best);
      } else {
        errors.push(`${path}: matches more than one alternative`);
      }
    }
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map((option) => validateSchema(value, option, root, path));
    if (!results.some((r) => r.length === 0)) {
      errors.push(...results.reduce((a, b) => (b.length < a.length ? b : a)));
    }
  }
  return errors;
}

/** Returns every keyword used in `schema` (recursively) that this validator does not implement. */
export function unsupportedKeywords(schema: unknown, path = '#'): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  if (Array.isArray(schema))
    return schema.flatMap((s, i) => unsupportedKeywords(s, `${path}/${i}`));
  const out: string[] = [];
  for (const [key, child] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !key.startsWith('x-')) out.push(`${path}/${key}`);
    if (key === 'properties' || key === '$defs') {
      for (const [name, sub] of Object.entries(child as Record<string, unknown>)) {
        out.push(...unsupportedKeywords(sub, `${path}/${key}/${name}`));
      }
    } else if (
      key === 'items' ||
      key === 'oneOf' ||
      key === 'anyOf' ||
      (key === 'additionalProperties' && typeof child === 'object')
    ) {
      out.push(...unsupportedKeywords(child, `${path}/${key}`));
    }
  }
  return out;
}
