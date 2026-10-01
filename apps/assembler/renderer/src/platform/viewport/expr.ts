/**
 * Tiny arithmetic-expression evaluator for editable dimension labels
 * (Shapr3D-style: `"12 + 3.5"`, `"40/2"`). Supports `+ - * /`, unary minus,
 * parentheses, and decimal numbers. Returns `null` on any parse error or on
 * division by zero — callers should keep the field's previous value in that
 * case rather than applying `NaN`.
 */

import { evaluateConstantExpression } from '../../foundation/document/expressions.js';

type TokenKind = 'number' | 'op' | 'lparen' | 'rparen' | 'end';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const src = input.trim();
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
    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: ch });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      const numText = src.slice(i, j);
      if (!/^\d*\.?\d+$|^\d+\.?\d*$/.test(numText)) return null;
      tokens.push({ kind: 'number', value: numText });
      i = j;
      continue;
    }
    return null;
  }
  tokens.push({ kind: 'end', value: '' });
  return tokens;
}

interface ParseState {
  tokens: Token[];
  pos: number;
}

function peek(state: ParseState): Token {
  return state.tokens[state.pos]!;
}

function advance(state: ParseState): Token {
  const t = state.tokens[state.pos]!;
  state.pos += 1;
  return t;
}

function parseExpr(state: ParseState): number | null {
  let value = parseTerm(state);
  if (value === null) return null;
  for (;;) {
    const t = peek(state);
    if (t.kind === 'op' && (t.value === '+' || t.value === '-')) {
      advance(state);
      const rhs = parseTerm(state);
      if (rhs === null) return null;
      value = t.value === '+' ? value + rhs : value - rhs;
    } else break;
  }
  return value;
}

function parseTerm(state: ParseState): number | null {
  let value = parseUnary(state);
  if (value === null) return null;
  for (;;) {
    const t = peek(state);
    if (t.kind === 'op' && (t.value === '*' || t.value === '/')) {
      advance(state);
      const rhs = parseUnary(state);
      if (rhs === null) return null;
      if (t.value === '/') {
        if (rhs === 0) return null;
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    } else break;
  }
  return value;
}

function parseUnary(state: ParseState): number | null {
  const t = peek(state);
  if (t.kind === 'op' && t.value === '-') {
    advance(state);
    const v = parseUnary(state);
    return v === null ? null : -v;
  }
  if (t.kind === 'op' && t.value === '+') {
    advance(state);
    return parseUnary(state);
  }
  return parsePrimary(state);
}

function parsePrimary(state: ParseState): number | null {
  const t = peek(state);
  if (t.kind === 'number') {
    advance(state);
    const n = Number(t.value);
    return Number.isFinite(n) ? n : null;
  }
  if (t.kind === 'lparen') {
    advance(state);
    const v = parseExpr(state);
    if (v === null) return null;
    const close = advance(state);
    if (close.kind !== 'rparen') return null;
    return v;
  }
  return null;
}

/**
 * Evaluates a simple `+ - * /` arithmetic expression, e.g. `"40 + 2*3"`.
 * Returns `null` for empty input, unparsable input, trailing garbage, or a
 * division by zero.
 */
export function parseExpression(input: string): number | null {
  const value = parsePlain(input);
  // Units (`1 in + 2 mm`, `90°`) through the document's expression parser.
  return value ?? evaluateConstantExpression(input);
}

function parsePlain(input: string): number | null {
  const tokens = tokenize(input);
  if (!tokens) return null;
  const state: ParseState = { tokens, pos: 0 };
  const value = parseExpr(state);
  if (value === null) return null;
  if (peek(state).kind !== 'end') return null;
  return value;
}
