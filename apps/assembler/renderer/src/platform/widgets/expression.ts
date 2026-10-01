/**
 * Tiny, safe `+ - * /` expression evaluator for numeric dimension fields
 * (history-card parameters). No `eval`/`Function` — a small hand-rolled
 * recursive-descent parser over `+ - * / ( )` and decimal numbers.
 *
 * Returns `null` for anything that isn't a fully-consumed, finite numeric
 * expression (empty input, trailing garbage, division producing NaN/Infinity).
 */

import { evaluateConstantExpression } from '../../foundation/document/expressions.js';
export function evaluateExpression(input: string): number | null {
  // Units (`1 in + 2 mm`, `90°`) through the document's expression parser.
  return evaluatePlain(input) ?? evaluateConstantExpression(input);
}

function evaluatePlain(input: string): number | null {
  const src = input.trim().replace(',', '.');
  if (src === '') return null;
  let pos = 0;

  function skipSpace(): void {
    while (pos < src.length && src[pos] === ' ') pos += 1;
  }

  function parseNumber(): number | null {
    const start = pos;
    if (src[pos] === '+' || src[pos] === '-') pos += 1;
    let sawDigit = false;
    while (pos < src.length && /[0-9]/.test(src[pos]!)) {
      pos += 1;
      sawDigit = true;
    }
    if (src[pos] === '.') {
      pos += 1;
      while (pos < src.length && /[0-9]/.test(src[pos]!)) {
        pos += 1;
        sawDigit = true;
      }
    }
    if (!sawDigit) {
      pos = start;
      return null;
    }
    return Number(src.slice(start, pos));
  }

  function parseFactor(): number | null {
    skipSpace();
    if (src[pos] === '(') {
      pos += 1;
      const value = parseExpr();
      skipSpace();
      if (value === null || src[pos] !== ')') return null;
      pos += 1;
      return value;
    }
    return parseNumber();
  }

  function parseTerm(): number | null {
    let value = parseFactor();
    if (value === null) return null;
    skipSpace();
    while (src[pos] === '*' || src[pos] === '/') {
      const op = src[pos];
      pos += 1;
      const rhs = parseFactor();
      if (rhs === null) return null;
      value = op === '*' ? value * rhs : value / rhs;
      skipSpace();
    }
    return value;
  }

  function parseExpr(): number | null {
    let value = parseTerm();
    if (value === null) return null;
    skipSpace();
    while (src[pos] === '+' || src[pos] === '-') {
      const op = src[pos];
      pos += 1;
      const rhs = parseTerm();
      if (rhs === null) return null;
      value = op === '+' ? value + rhs : value - rhs;
      skipSpace();
    }
    return value;
  }

  const result = parseExpr();
  skipSpace();
  if (result === null || pos !== src.length || !Number.isFinite(result)) return null;
  return result;
}

/** Formats a number for display in a dimension field, trimming float noise. */
export function formatExpressionValue(value: number, precision = 3): string {
  const rounded = Math.round(value * 10 ** precision) / 10 ** precision;
  return String(rounded);
}
