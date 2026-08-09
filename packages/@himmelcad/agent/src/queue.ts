export interface BoundedQueueLimits {
  maxItems: number;
  maxBytes: number;
  maxItemBytes: number;
}

export interface BoundedQueueSnapshot<T> {
  items: readonly T[];
  bytes: number;
  dropped: number;
  rejected: number;
}

export class BoundedQueue<T> {
  readonly #limits: BoundedQueueLimits;
  readonly #items: { value: T; bytes: number }[] = [];
  #bytes = 0;
  #dropped = 0;
  #rejected = 0;

  constructor(limits: BoundedQueueLimits) {
    if (limits.maxItems < 1 || limits.maxBytes < 1 || limits.maxItemBytes < 1) {
      throw new Error('Bounded queue limits must be positive.');
    }
    this.#limits = limits;
  }

  push(value: T, bytes = estimateJsonBytes(value)): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#limits.maxItemBytes) {
      this.#rejected += 1;
      return false;
    }
    while (
      this.#items.length >= this.#limits.maxItems ||
      (this.#items.length > 0 && this.#bytes + bytes > this.#limits.maxBytes)
    ) {
      const removed = this.#items.shift()!;
      this.#bytes -= removed.bytes;
      this.#dropped += 1;
    }
    if (bytes > this.#limits.maxBytes) {
      this.#rejected += 1;
      return false;
    }
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
    return true;
  }

  shift(): T | undefined {
    const item = this.#items.shift();
    if (!item) return undefined;
    this.#bytes -= item.bytes;
    return item.value;
  }

  snapshot(): BoundedQueueSnapshot<T> {
    return {
      items: this.#items.map((item) => item.value),
      bytes: this.#bytes,
      dropped: this.#dropped,
      rejected: this.#rejected,
    };
  }
}

export interface RawDiagnostic {
  provider: string;
  receivedAt: string;
  payload: unknown;
}

export class BoundedDiagnosticLog extends BoundedQueue<RawDiagnostic> {
  constructor(limits: Partial<BoundedQueueLimits> = {}) {
    super({ maxItems: 512, maxBytes: 2 * 1024 * 1024, maxItemBytes: 64 * 1024, ...limits });
  }

  override push(value: RawDiagnostic): boolean {
    return super.push({ ...value, payload: redactDiagnosticPayload(value.payload) });
  }
}

const SENSITIVE_KEY = /^(?:authorization|token|api[_-]?key|password|secret|cookie)$/i;
const KEY_VALUE_SECRET =
  /\b(authorization|token|api[_-]?key|password|secret|cookie)\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactSensitiveText(value: string, maximumLength = 4_096): string {
  return value
    .slice(0, maximumLength)
    .replace(BEARER_SECRET, 'Bearer [REDACTED]')
    .replace(KEY_VALUE_SECRET, '$1=[REDACTED]');
}

export function redactDiagnosticPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return visit(value, 0);

  function visit(current: unknown, depth: number): unknown {
    if (typeof current === 'string') return redactSensitiveText(current);
    if (current === null || typeof current === 'number' || typeof current === 'boolean')
      return current;
    if (typeof current === 'bigint') return `[BigInt:${current.toString().slice(0, 64)}]`;
    if (typeof current !== 'object') return `[${typeof current}]`;
    if (seen.has(current)) return '[Circular]';
    if (depth >= 8) return '[DepthLimit]';
    seen.add(current);
    if (current instanceof Error) {
      return {
        name: redactSensitiveText(current.name, 256),
        message: redactSensitiveText(current.message),
      };
    }
    if (Array.isArray(current)) {
      const items = current.slice(0, 100).map((item) => visit(item, depth + 1));
      if (current.length > 100) items.push(`[${current.length - 100} items omitted]`);
      return items;
    }
    const result: Record<string, unknown> = {};
    const keys = Object.keys(current).slice(0, 100);
    for (const key of keys) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = '[REDACTED]';
        continue;
      }
      try {
        result[key.slice(0, 256)] = visit((current as Record<string, unknown>)[key], depth + 1);
      } catch {
        result[key.slice(0, 256)] = '[Unreadable]';
      }
    }
    if (Object.keys(current).length > keys.length) result.__truncatedKeys = true;
    return result;
  }
}

function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
