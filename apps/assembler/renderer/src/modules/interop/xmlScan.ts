/**
 * Streaming XML tag scanner for machine-written model files (3MF model
 * parts). Not a validating parser: it reports start/end tags with their
 * attributes (namespace prefixes stripped from element and attribute names,
 * entities decoded) and skips comments, processing instructions, CDATA and
 * text. Enough for 3MF, whose content lives entirely in attributes.
 */

export interface XmlHandlers {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close?(name: string): void;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, code: string) => {
    if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? whole;
  });
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Scans `text`, calling `onProgress(fraction)` about every 2 MB (it may throw to abort). */
export function scanXml(
  text: string,
  handlers: XmlHandlers,
  onProgress?: (fraction: number) => void,
): void {
  const n = text.length;
  let i = 0;
  let nextReport = 1 << 21;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const end = text.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Find the end of the tag, skipping quoted attribute values.
    let j = lt + 1;
    let quote = '';
    for (; j < n; j += 1) {
      const c = text[j]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) throw new XmlError('Unterminated tag');
    if (text[lt + 1] === '/') {
      handlers.close?.(localName(text.slice(lt + 2, j).trim()));
    } else {
      const selfClosing = text[j - 1] === '/';
      const body = text.slice(lt + 1, selfClosing ? j - 1 : j);
      const space = body.search(/\s/);
      const name = localName(space < 0 ? body : body.slice(0, space));
      const attrs: Record<string, string> = {};
      if (space >= 0) {
        ATTR.lastIndex = space;
        let m: RegExpExecArray | null;
        while ((m = ATTR.exec(body)) !== null) {
          attrs[localName(m[1]!)] = decodeXmlEntities(m[2] ?? m[3] ?? '');
        }
      }
      handlers.open(name, attrs, selfClosing);
      if (selfClosing) handlers.close?.(name);
    }
    i = j + 1;
    if (onProgress && i >= nextReport) {
      nextReport = i + (1 << 21);
      onProgress(i / n);
    }
  }
}
