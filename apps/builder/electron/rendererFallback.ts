import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  RendererFallbackController,
  appendChromiumLaunchSwitches,
  type GpuLossAction,
  type PersistedRendererFallback,
  type RendererFallbackDecision,
  type RendererFallbackStore,
} from '@himmelcad/hardware-profile';

export type BuilderRendererFallbackDecision = RendererFallbackDecision;

interface BuilderRendererSettingsFileV1 {
  readonly schemaVersion: 1;
  readonly rendererFallback: BuilderRendererFallbackDecision | null;
}

export type BuilderRendererStatus = PersistedRendererFallback;
export type BuilderGpuLossAction = GpuLossAction;

export class BuilderRendererFallbackStore implements RendererFallbackStore {
  private decision: BuilderRendererFallbackDecision | null = null;

  constructor(private readonly path: string) {}

  load(): BuilderRendererStatus {
    try {
      if (!existsSync(this.path)) return { mode: 'hardware' };
      const parsed = parseSettings(JSON.parse(readFileSync(this.path, 'utf8')) as unknown);
      this.decision = parsed.rendererFallback;
    } catch (error) {
      console.warn(`[renderer-fallback] ignored invalid settings: ${String(error)}`);
      this.decision = null;
    }
    return this.status();
  }

  status(): BuilderRendererStatus {
    return this.decision ?? { mode: 'hardware' };
  }

  useSoftware(input: {
    readonly reason: string;
    readonly gpu: string;
    readonly driver: string;
    readonly decidedAt?: string;
  }): BuilderRendererFallbackDecision {
    const decision: BuilderRendererFallbackDecision = {
      mode: 'software',
      from: 'webgl2',
      reason: requiredText(input.reason, 'renderer fallback reason'),
      gpu: requiredText(input.gpu, 'GPU name'),
      driver: requiredText(input.driver, 'GPU driver'),
      decidedAt: input.decidedAt ?? new Date().toISOString(),
    };
    const previous = this.decision;
    this.decision = decision;
    try {
      this.persist();
    } catch (error) {
      this.decision = previous;
      throw error;
    }
    return decision;
  }

  clear(): void {
    const previous = this.decision;
    this.decision = null;
    try {
      this.persist();
    } catch (error) {
      this.decision = previous;
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const candidate = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(candidate, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ schemaVersion: 1, rendererFallback: this.decision }, null, 2)}\n`,
        'utf8',
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(candidate, this.path);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(candidate);
      } catch {
        // The candidate may not exist when opening it failed.
      }
      throw error;
    }
  }
}

export { RendererFallbackController as BuilderRendererFallbackController };

export function appendSoftwareRenderingSwitches(
  commandLine: { appendSwitch(name: string, value?: string): void },
  status: BuilderRendererStatus,
  electronVersion: string,
): void {
  appendChromiumLaunchSwitches(commandLine, {
    os: 'windows',
    development: false,
    electronVersion,
    persistedFallback: status,
  });
}

function parseSettings(value: unknown): BuilderRendererSettingsFileV1 {
  if (!value || typeof value !== 'object') throw new Error('settings are not an object');
  const file = value as Record<string, unknown>;
  if (file.schemaVersion !== 1) throw new Error('unsupported renderer settings');
  if (file.rendererFallback === null) return { schemaVersion: 1, rendererFallback: null };
  if (!file.rendererFallback || typeof file.rendererFallback !== 'object') {
    throw new Error('renderer fallback decision is malformed');
  }
  const decision = file.rendererFallback as Record<string, unknown>;
  if (
    decision.mode !== 'software' ||
    decision.from !== 'webgl2' ||
    typeof decision.reason !== 'string' ||
    typeof decision.gpu !== 'string' ||
    typeof decision.driver !== 'string' ||
    typeof decision.decidedAt !== 'string'
  ) {
    throw new Error('renderer fallback decision is malformed');
  }
  return {
    schemaVersion: 1,
    rendererFallback: {
      mode: decision.mode,
      from: decision.from,
      reason: requiredText(decision.reason, 'renderer fallback reason'),
      gpu: requiredText(decision.gpu, 'GPU name'),
      driver: requiredText(decision.driver, 'GPU driver'),
      decidedAt: requiredText(decision.decidedAt, 'renderer fallback timestamp'),
    },
  };
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}
