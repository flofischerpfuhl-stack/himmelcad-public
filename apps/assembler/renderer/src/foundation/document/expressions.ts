/**
 * Dimension expressions: `+ - * /`, parentheses, unary minus, decimal
 * numbers (`,` accepted as decimal separator), an optional trailing `mm` /
 * `°` / `deg`, and references to other dimensions of the same sketch by
 * name (`d1`, `d2`, …). No `eval`: a small recursive-descent parser.
 */

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
      tokens.push({ kind: 'number', value: Number(num[1]) });
      i += num[1]!.length;
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

/** `true` when the text is just a number (no operators, no references). */
export function isPlainNumber(input: string): boolean {
  return /^\s*\d+([.,]\d*)?\s*(mm|°|deg)?\s*$/i.test(input) || /^\s*[.,]\d+\s*$/.test(input);
}
