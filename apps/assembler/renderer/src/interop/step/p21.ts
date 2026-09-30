/**
 * Minimal ISO 10303-21 ("STEP physical file") scanner, written from the
 * standard (ISO 10303-21:2016 §5–§12) for what the importer needs from a
 * file besides its geometry: the product structure, names and colours
 * (`stepStructure.ts`). OCCT still reads the geometry; this scanner never
 * interprets curves or surfaces.
 *
 * - Every DATA record is counted in file order (`index`, 1-based): OCCT's
 *   `StepData_StepModel::Entity(n)` numbers entities the same way, which is
 *   how the importer hands a single entity to OCCT's transfer.
 * - Arguments are parsed only for the entity types the caller asks for, so
 *   a large file costs one linear pass over its text.
 * - Strings are decoded (`''`, `\X\hh`, `\X2\…\X0\`, `\X4\…\X0\`, `\S\c`).
 */

/** A parsed parameter value. */
export type StepValue =
  | number
  | string
  | StepRef
  | StepEnum
  | StepTyped
  | null // `$` (unset)
  | '*' // derived
  | StepValue[];

export interface StepRef {
  ref: number;
}
export interface StepEnum {
  enum: string;
}
/** A typed parameter such as `LENGTH_MEASURE(1.0)`. */
export interface StepTyped {
  type: string;
  args: StepValue[];
}

export interface StepEntity {
  /** Instance name (`#id`). */
  id: number;
  /** 1-based position of the record in the DATA section. */
  index: number;
  /**
   * Upper-case type names: one for a simple record, every partial type of a
   * complex record (`( A(...) B(...) )`), in file order.
   */
  types: string[];
  /** Arguments per type (same order as `types`). */
  parts: StepValue[][];
}

export interface ScanResult {
  /** `FILE_SCHEMA` identifiers, e.g. `AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }`. */
  schemas: string[];
  /** Records in the DATA section. */
  recordCount: number;
  /** Parsed entities of the wanted types, by instance id. */
  entities: Map<number, StepEntity>;
  /** Instance id → 1-based record position, for every record. */
  positions: Map<number, number>;
}

export class StepSyntaxError extends Error {}

const enum Ch {
  Quote = 39, // '
  Hash = 35, // #
  Semicolon = 59,
  LParen = 40,
  RParen = 41,
  Comma = 44,
  Slash = 47,
  Star = 42,
  Dollar = 36,
  Dot = 46,
  Equals = 61,
  Backslash = 92,
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function isIdentChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45
  );
}

/** Decodes the control directives of a STEP string literal (content between the quotes). */
export function decodeStepString(raw: string): string {
  if (!raw.includes('\\') && !raw.includes("''")) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "'" && raw[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    if (raw.startsWith('\\X2\\', i) || raw.startsWith('\\X4\\', i)) {
      const width = raw[i + 2] === '2' ? 4 : 8;
      const end = raw.indexOf('\\X0\\', i + 4);
      const hex = raw.slice(i + 4, end < 0 ? raw.length : end);
      for (let k = 0; k + width <= hex.length; k += width) {
        const code = parseInt(hex.slice(k, k + width), 16);
        if (Number.isFinite(code)) out += String.fromCodePoint(code);
      }
      i = end < 0 ? raw.length : end + 4;
      continue;
    }
    if (raw.startsWith('\\X\\', i)) {
      const code = parseInt(raw.slice(i + 3, i + 5), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
      i += 5;
      continue;
    }
    if (raw.startsWith('\\S\\', i)) {
      out += String.fromCharCode((raw.charCodeAt(i + 3) || 0) + 128);
      i += 4;
      continue;
    }
    if (raw.startsWith('\\\\', i)) {
      out += '\\';
      i += 2;
      continue;
    }
    // \P?\ code page switches and unknown directives: drop the directive.
    if (raw[i + 1] === 'P' && raw[i + 3] === '\\') {
      i += 4;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Parses a parameter list starting at `text[start] === '('`; returns values and the index after `)`. */
function parseList(text: string, start: number): { values: StepValue[]; end: number } {
  const values: StepValue[] = [];
  let i = start + 1;
  const n = text.length;
  for (;;) {
    while (i < n && isSpace(text.charCodeAt(i))) i += 1;
    if (i >= n) throw new StepSyntaxError('Unterminated parameter list');
    const c = text.charCodeAt(i);
    if (c === Ch.RParen) return { values, end: i + 1 };
    if (c === Ch.Comma) {
      i += 1;
      continue;
    }
    if (c === Ch.Hash) {
      let j = i + 1;
      while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j += 1;
      values.push({ ref: Number(text.slice(i + 1, j)) });
      i = j;
    } else if (c === Ch.Quote) {
      const q = stringEnd(text, i);
      if (q >= n) throw new StepSyntaxError('Unterminated string');
      values.push(decodeStepString(text.slice(i + 1, q)));
      i = q + 1;
    } else if (c === Ch.LParen) {
      const inner = parseList(text, i);
      values.push(inner.values);
      i = inner.end;
    } else if (c === Ch.Dollar) {
      values.push(null);
      i += 1;
    } else if (c === Ch.Star) {
      values.push('*');
      i += 1;
    } else if (c === Ch.Dot) {
      const j = text.indexOf('.', i + 1);
      if (j < 0) throw new StepSyntaxError('Unterminated enumeration');
      values.push({ enum: text.slice(i + 1, j).toUpperCase() });
      i = j + 1;
    } else if (c === 34 /* " binary */) {
      const j = text.indexOf('"', i + 1);
      values.push(text.slice(i + 1, j < 0 ? n : j));
      i = j < 0 ? n : j + 1;
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      let j = i;
      while (j < n && isIdentChar(text.charCodeAt(j))) j += 1;
      const type = text.slice(i, j).toUpperCase();
      while (j < n && isSpace(text.charCodeAt(j))) j += 1;
      if (text.charCodeAt(j) === Ch.LParen) {
        const inner = parseList(text, j);
        values.push({ type, args: inner.values });
        i = inner.end;
      } else {
        values.push({ enum: type });
        i = j;
      }
    } else {
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === Ch.Comma || d === Ch.RParen || isSpace(d)) break;
        j += 1;
      }
      const num = Number(text.slice(i, j));
      values.push(Number.isFinite(num) ? num : text.slice(i, j));
      i = j;
    }
  }
}

/** Index of the quote closing the string literal whose opening quote is at `i` (`''` is an escaped quote). */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  for (;;) {
    const q = text.indexOf("'", j);
    if (q < 0) return text.length;
    if (text.charCodeAt(q + 1) === Ch.Quote) {
      j = q + 2;
      continue;
    }
    return q;
  }
}

/** Index after the end of a comment starting at `i` (`/*`). */
function skipComment(text: string, i: number): number {
  const end = text.indexOf('*/', i + 2);
  return end < 0 ? text.length : end + 2;
}

/** Index of the `;` ending the record that starts at `i` (strings and comments skipped). */
function recordEnd(text: string, i: number): number {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === Ch.Semicolon) return j;
    if (c === Ch.Quote) {
      j = stringEnd(text, j);
      if (j >= n) return n;
      j += 1;
      continue;
    }
    if (c === Ch.Slash && text.charCodeAt(j + 1) === Ch.Star) {
      j = skipComment(text, j);
      continue;
    }
    j += 1;
  }
  return n;
}

/** Type names and argument lists of a record body (`TYPE(...)` or `( A(...) B(...) )`). */
function parseRecordBody(body: string): { types: string[]; parts: StepValue[][] } {
  let i = 0;
  const n = body.length;
  while (i < n && isSpace(body.charCodeAt(i))) i += 1;
  if (body.charCodeAt(i) === Ch.LParen) {
    // Complex entity instance: a list of partial simple records.
    const types: string[] = [];
    const parts: StepValue[][] = [];
    i += 1;
    for (;;) {
      while (i < n && isSpace(body.charCodeAt(i))) i += 1;
      if (i >= n || body.charCodeAt(i) === Ch.RParen) break;
      let j = i;
      while (j < n && isIdentChar(body.charCodeAt(j))) j += 1;
      const type = body.slice(i, j).toUpperCase();
      while (j < n && isSpace(body.charCodeAt(j))) j += 1;
      if (body.charCodeAt(j) !== Ch.LParen)
        throw new StepSyntaxError(`Malformed complex record ${type}`);
      const list = parseList(body, j);
      types.push(type);
      parts.push(list.values);
      i = list.end;
    }
    return { types, parts };
  }
  let j = i;
  while (j < n && isIdentChar(body.charCodeAt(j))) j += 1;
  const type = body.slice(i, j).toUpperCase();
  while (j < n && isSpace(body.charCodeAt(j))) j += 1;
  if (body.charCodeAt(j) !== Ch.LParen) throw new StepSyntaxError(`Malformed record ${type}`);
  return { types: [type], parts: [parseList(body, j).values] };
}

/** The type names of a record body without parsing its arguments. */
function recordTypes(body: string): string[] {
  let i = 0;
  const n = body.length;
  while (i < n && isSpace(body.charCodeAt(i))) i += 1;
  if (body.charCodeAt(i) !== Ch.LParen) {
    let j = i;
    while (j < n && isIdentChar(body.charCodeAt(j))) j += 1;
    return [body.slice(i, j).toUpperCase()];
  }
  // Complex: collect identifiers at nesting depth 1.
  const types: string[] = [];
  let depth = 0;
  for (let k = i; k < n; k += 1) {
    const c = body.charCodeAt(k);
    if (c === Ch.Quote) {
      k = stringEnd(body, k);
      continue;
    }
    if (c === Ch.LParen) depth += 1;
    else if (c === Ch.RParen) depth -= 1;
    else if (depth === 1 && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      let j = k;
      while (j < n && isIdentChar(body.charCodeAt(j))) j += 1;
      types.push(body.slice(k, j).toUpperCase());
      k = j - 1;
    }
  }
  return types;
}

export interface ScanOptions {
  /** Parse the arguments of records having any of these types (upper case). */
  wanted: ReadonlySet<string>;
  /** Called every ~1 MB of text with the fraction scanned. Throwing aborts the scan. */
  onProgress?: (fraction: number) => void;
}

/**
 * Scans the text of a STEP file. Throws {@link StepSyntaxError} if it is not
 * an ISO 10303-21 exchange structure.
 */
export function scanStep(text: string, options: ScanOptions): ScanResult {
  if (!/^\s*ISO-10303-21\s*;/.test(text.slice(0, 256))) {
    throw new StepSyntaxError('Not a STEP file (no ISO-10303-21 header)');
  }
  const schemas: string[] = [];
  const headerEnd = text.indexOf('ENDSEC;');
  const schemaMatch = /FILE_SCHEMA\s*\(\s*\(([^;]*)\)\s*\)\s*;/i.exec(
    text.slice(0, headerEnd < 0 ? 4096 : headerEnd),
  );
  if (schemaMatch) {
    for (const m of schemaMatch[1]!.matchAll(/'([^']*)'/g)) schemas.push(m[1]!);
  }
  const dataStart = text.search(/\bDATA\s*(\([^)]*\))?\s*;/);
  if (dataStart < 0) throw new StepSyntaxError('STEP file has no DATA section');
  let i = text.indexOf(';', dataStart) + 1;
  const n = text.length;
  const entities = new Map<number, StepEntity>();
  const positions = new Map<number, number>();
  let index = 0;
  let nextReport = 1 << 20;
  for (;;) {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isSpace(c)) i += 1;
      else if (c === Ch.Slash && text.charCodeAt(i + 1) === Ch.Star) i = skipComment(text, i);
      else break;
    }
    if (i >= n) break;
    if (text.charCodeAt(i) !== Ch.Hash) {
      // ENDSEC (end of DATA) or a second DATA section: stop at ENDSEC.
      if (text.startsWith('ENDSEC', i)) break;
      const skip = recordEnd(text, i);
      i = skip + 1;
      continue;
    }
    let j = i + 1;
    while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j += 1;
    const id = Number(text.slice(i + 1, j));
    while (j < n && isSpace(text.charCodeAt(j))) j += 1;
    if (text.charCodeAt(j) !== Ch.Equals) throw new StepSyntaxError(`Malformed record #${id}`);
    const end = recordEnd(text, j + 1);
    index += 1;
    positions.set(id, index);
    const body = text.slice(j + 1, end);
    const types = recordTypes(body);
    if (types.some((t) => options.wanted.has(t))) {
      const parsed = parseRecordBody(body);
      entities.set(id, { id, index, types: parsed.types, parts: parsed.parts });
    }
    i = end + 1;
    if (options.onProgress && i >= nextReport) {
      nextReport = i + (1 << 20);
      options.onProgress(i / n);
    }
  }
  return { schemas, recordCount: index, entities, positions };
}

/** Arguments of `type` in an entity (simple or complex), or `null`. */
export function partOf(entity: StepEntity | undefined, type: string): StepValue[] | null {
  if (!entity) return null;
  const k = entity.types.indexOf(type);
  return k < 0 ? null : entity.parts[k]!;
}

export function refOf(value: StepValue | undefined): number | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'ref' in value
    ? value.ref
    : null;
}

export function refsOf(value: StepValue | undefined): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const r = refOf(item);
    if (r !== null) out.push(r);
  }
  return out;
}

export function stringOf(value: StepValue | undefined): string {
  return typeof value === 'string' && value !== '*' ? value : '';
}

export function numberOf(value: StepValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) {
    return numberOf(value.args[0]);
  }
  return null;
}
