/**
 * Dimension expressions: `+ - * /`, parentheses, unary minus, decimal
 * numbers (`,` accepted as decimal separator), units after any number
 * (lengths `mm cm m in ft` and `"` / `'`, converted to millimetres; angles
 * `° deg rad`, converted to degrees: `10 mm + 1 in` is 35.4), and
 * references to other dimensions of the same sketch or to document
 * parameters by name (`d1`, `wall`, …). No `eval`: a small
 * recursive-descent parser.
 */

/** Factor to the document's base unit (mm, degrees) per unit word after a number. */
export const EXPRESSION_UNITS: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
  '"': 25.4,
  ft: 304.8,
  "'": 304.8,
  um: 0.001,
  deg: 1,
  '°': 1,
  rad: 180 / Math.PI,
};

// Longest first so `mm` wins over `m` and `inch` over `in`.
const UNIT_PATTERN = new RegExp(
  `^\\s*(` +
    Object.keys(EXPRESSION_UNITS)
      .sort((a, b) => b.length - a.length)
      .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') +
    `)(?![A-Za-z0-9_])`,
  'i',
);

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'end' };

function tokenize(input: string): Token[] | null {
  const src = input
    .trim()
    .replace(/\s*(mm|°|deg)\s*$/i, '')
    .replace(/(\d),(\d)/g, '$1.$2');
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push(ch === '(' ? { kind: 'lparen' } : { kind: 'rparen' });
      i += 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) {
      i += num[1]!.length;
      // An optional unit right after the number (`1 in`, `2.5cm`, `90°`).
      const unit = UNIT_PATTERN.exec(src.slice(i));
      const factor = unit ? EXPRESSION_UNITS[unit[1]!.toLowerCase()] : undefined;
      if (unit && factor !== undefined) i += unit[0].length;
      tokens.push({ kind: 'number', value: Number(num[1]) * (factor ?? 1) });
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      i += name[0].length;
      continue;
    }
    return null;
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

function parse(tokens: Token[]): Node | null {
  let pos = 0;
  const peek = () => tokens[pos]!;
  const expr = (): Node | null => {
    let left = term();
    while (left) {
      const t = peek();
      if (t.kind !== 'op' || (t.value !== '+' && t.value !== '-')) break;
      pos += 1;
      const right = term();
      if (!right) return null;
      left = { kind: 'bin', op: t.value, left, right };
    }
    return left;
  };
  const term = (): Node | null => {
    let left = unary();
    while (left) {
      const t = peek();
      if (t.kind !== 'op' || (t.value !== '*' && t.value !== '/')) break;
      pos += 1;
      const right = unary();
      if (!right) return null;
      left = { kind: 'bin', op: t.value, left, right };
    }
    return left;
  };
  const unary = (): Node | null => {
    const t = peek();
    if (t.kind === 'op' && (t.value === '-' || t.value === '+')) {
      pos += 1;
      const arg = unary();
      if (!arg) return null;
      return t.value === '-' ? { kind: 'neg', arg } : arg;
    }
    return primary();
  };
  const primary = (): Node | null => {
    const t = peek();
    if (t.kind === 'number') {
      pos += 1;
      return { kind: 'num', value: t.value };
    }
    if (t.kind === 'name') {
      pos += 1;
      return { kind: 'ref', name: t.value };
    }
    if (t.kind === 'lparen') {
      pos += 1;
      const inner = expr();
      if (!inner || peek().kind !== 'rparen') return null;
      pos += 1;
      return inner;
    }
    return null;
  };
  const root = expr();
  return root && peek().kind === 'end' ? root : null;
}

function references(node: Node, out: Set<string>): Set<string> {
  if (node.kind === 'ref') out.add(node.name);
  else if (node.kind === 'neg') references(node.arg, out);
  else if (node.kind === 'bin') {
    references(node.left, out);
    references(node.right, out);
  }
  return out;
}

function evaluate(node: Node, lookup: (name: string) => number | null): number | null {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'ref':
      return lookup(node.name);
    case 'neg': {
      const v = evaluate(node.arg, lookup);
      return v === null ? null : -v;
    }
    case 'bin': {
      const l = evaluate(node.left, lookup);
      const r = evaluate(node.right, lookup);
      if (l === null || r === null) return null;
      if (node.op === '/') return r === 0 ? null : l / r;
      return node.op === '+' ? l + r : node.op === '-' ? l - r : l * r;
    }
  }
}

export interface ParsedExpression {
  /** Names of other dimensions the expression reads. */
  refs: string[];
  evaluate(lookup: (name: string) => number | null): number | null;
}

/** Parses an expression, or `null` when it is not valid syntax. */
export function parseDimensionExpression(input: string): ParsedExpression | null {
  const tokens = tokenize(input);
  if (!tokens) return null;
  const root = parse(tokens);
  if (!root) return null;
  return {
    refs: [...references(root, new Set())],
    evaluate: (lookup) => {
      const v = evaluate(root, lookup);
      return v !== null && Number.isFinite(v) ? v : null;
    },
  };
}

/** The value of an expression without names (`12 + 3.5`, `1 in + 2 mm`), or `null`. */
export function evaluateConstantExpression(input: string): number | null {
  const parsed = parseDimensionExpression(input);
  return parsed && parsed.refs.length === 0 ? parsed.evaluate(() => null) : null;
}

/** `true` when the text is just a number (no operators, no references). */
export function isPlainNumber(input: string): boolean {
  return /^\s*\d+([.,]\d*)?\s*(mm|°|deg)?\s*$/i.test(input) || /^\s*[.,]\d+\s*$/.test(input);
}
