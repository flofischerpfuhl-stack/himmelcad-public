export type HardwareOperatingSystem = 'linux' | 'windows' | 'macos';
export type HardwareRendererBackend = 'webgpu' | 'webgl2' | 'software';

export interface RendererFallbackDecision {
  readonly mode: 'software';
  readonly from: 'webgl2';
  readonly reason: string;
  readonly gpu: string;
  readonly driver: string;
  readonly decidedAt: string;
}

export type PersistedRendererFallback = { readonly mode: 'hardware' } | RendererFallbackDecision;

export interface RendererFallbackStore {
  status(): PersistedRendererFallback;
  useSoftware(input: {
    readonly reason: string;
    readonly gpu: string;
    readonly driver: string;
    readonly decidedAt?: string;
  }): RendererFallbackDecision;
  clear(): void;
}

export type GpuLossAction =
  | { readonly kind: 'retryCurrent'; readonly reason: string }
  | { readonly kind: 'fallbackWebgl2'; readonly reason: string }
  | { readonly kind: 'relaunchSoftware'; readonly status: RendererFallbackDecision }
  | { readonly kind: 'none' };

/** Session-scoped recovery ladder. Persisted software launches cannot relaunch-loop. */
export class RendererFallbackController {
  private gpuLosses = 0;
  private relaunchRequested = false;
  private readonly store: RendererFallbackStore;

  constructor(store: RendererFallbackStore) {
    this.store = store;
  }

  gpuProcessGone(reason: string, gpu: string, driver: string): GpuLossAction {
    if (this.store.status().mode === 'software' || this.relaunchRequested) return { kind: 'none' };
    this.gpuLosses += 1;
    if (this.gpuLosses === 1) return { kind: 'retryCurrent', reason };
    if (this.gpuLosses === 2) return { kind: 'fallbackWebgl2', reason };
    return this.requestSoftware(reason, gpu, driver);
  }

  requestSoftware(reason: string, gpu: string, driver: string): GpuLossAction {
    if (this.store.status().mode === 'software' || this.relaunchRequested) return { kind: 'none' };
    const status = this.store.useSoftware({ reason, gpu, driver });
    this.relaunchRequested = true;
    return { kind: 'relaunchSoftware', status };
  }

  tryHardwareAgain(): boolean {
    if (this.relaunchRequested || this.store.status().mode !== 'software') return false;
    this.store.clear();
    this.relaunchRequested = true;
    return true;
  }
}

export interface ChromiumLaunchFacts {
  readonly os: HardwareOperatingSystem;
  readonly development: boolean;
  readonly electronVersion: string;
  readonly persistedFallback: PersistedRendererFallback;
}

export interface ChromiumSwitch {
  readonly name: string;
  readonly value?: string;
}

/** Pure launch-switch policy shared by both Electron products. */
export function deriveChromiumLaunchSwitches(
  facts: ChromiumLaunchFacts,
): readonly ChromiumSwitch[] {
  if (facts.persistedFallback.mode === 'software') {
    const switches: ChromiumSwitch[] = [
      { name: 'use-gl', value: 'angle' },
      { name: 'use-angle', value: 'swiftshader' },
    ];
    const major = Number(facts.electronVersion.split('.')[0]);
    if (!Number.isFinite(major) || major >= 30)
      switches.push({ name: 'enable-unsafe-swiftshader' });
    return switches;
  }
  if (facts.os === 'windows') return [{ name: 'use-angle', value: 'd3d11' }];
  if (facts.os === 'linux' && facts.development) return [{ name: 'enable-unsafe-webgpu' }];
  return [];
}

export function appendChromiumLaunchSwitches(
  commandLine: { appendSwitch(name: string, value?: string): void },
  facts: ChromiumLaunchFacts,
): void {
  for (const entry of deriveChromiumLaunchSwitches(facts)) {
    commandLine.appendSwitch(entry.name, entry.value);
  }
}

export interface ViewerRenderingFacts {
  readonly backend: HardwareRendererBackend;
  readonly adapter: {
    readonly vendorId?: number;
    readonly deviceId?: number;
    readonly driver?: string;
    readonly isFallbackAdapter: boolean;
  };
}

export interface RenderingStatusFacts {
  readonly chromiumFeatureStatus: Readonly<{
    readonly gpu_compositing?: string;
    readonly webgl?: string;
    readonly webgpu?: string;
  }> | null;
  readonly chromiumGpuInfo?: unknown;
  readonly persistedFallback: PersistedRendererFallback;
  readonly viewer: ViewerRenderingFacts | null;
  readonly unavailableReason?: string;
}

export type RenderingStatus =
  | {
      readonly state: 'initializing';
      readonly label: 'Initializing';
      readonly title: string;
      readonly degraded: false;
    }
  | {
      readonly state: 'webgpuHardware';
      readonly label: 'WebGPU (hardware)';
      readonly title: string;
      readonly degraded: false;
    }
  | {
      readonly state: 'webgl2Hardware';
      readonly label: 'WebGL2 (hardware)';
      readonly title: string;
      readonly degraded: false;
    }
  | {
      readonly state: 'software';
      readonly label: 'Software';
      readonly title: string;
      readonly degraded: true;
    }
  | {
      readonly state: 'unavailable';
      readonly label: 'Unavailable';
      readonly title: string;
      readonly degraded: true;
    };

const SOFTWARE_MARKERS = ['software', 'readback'];

function featureIsHardware(value: string | undefined): boolean {
  const normalized = value?.toLowerCase() ?? '';
  return (
    normalized.startsWith('enabled') &&
    !SOFTWARE_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function featureIsSoftware(value: string | undefined): boolean {
  const normalized = value?.toLowerCase() ?? '';
  return SOFTWARE_MARKERS.some((marker) => normalized.includes(marker));
}

/** Derives the user-visible renderer truth from Chromium and the selected viewer adapter. */
export function deriveRenderingStatus(facts: RenderingStatusFacts): RenderingStatus {
  if (facts.unavailableReason) {
    return {
      state: 'unavailable',
      label: 'Unavailable',
      title: facts.unavailableReason,
      degraded: true,
    };
  }
  if (facts.persistedFallback.mode === 'software' || facts.viewer?.backend === 'software') {
    const reason =
      facts.persistedFallback.mode === 'software'
        ? facts.persistedFallback.reason
        : 'The viewer selected software rendering.';
    return { state: 'software', label: 'Software', title: reason, degraded: true };
  }
  if (!facts.viewer || !facts.chromiumFeatureStatus) {
    return {
      state: 'initializing',
      label: 'Initializing',
      title: 'Renderer capability verification is in progress.',
      degraded: false,
    };
  }
  const feature = facts.chromiumFeatureStatus;
  const required =
    facts.viewer.backend === 'webgpu'
      ? [feature.gpu_compositing, feature.webgl, feature.webgpu]
      : [feature.gpu_compositing, feature.webgl];
  if (facts.viewer.adapter.isFallbackAdapter || required.some(featureIsSoftware)) {
    return {
      state: 'software',
      label: 'Software',
      title: `Chromium renderer: compositing=${feature.gpu_compositing ?? 'unknown'}, WebGL=${feature.webgl ?? 'unknown'}, WebGPU=${feature.webgpu ?? 'unknown'}; fallback adapter=${String(facts.viewer.adapter.isFallbackAdapter)}.`,
      degraded: true,
    };
  }
  if (!required.every(featureIsHardware)) {
    return {
      state: 'unavailable',
      label: 'Unavailable',
      title: `Hardware acceleration is unavailable: compositing=${feature.gpu_compositing ?? 'unknown'}, WebGL=${feature.webgl ?? 'unknown'}, WebGPU=${feature.webgpu ?? 'unknown'}.`,
      degraded: true,
    };
  }
  return facts.viewer.backend === 'webgpu'
    ? {
        state: 'webgpuHardware',
        label: 'WebGPU (hardware)',
        title: 'WebGPU is active on a non-fallback adapter with Chromium hardware acceleration.',
        degraded: false,
      }
    : {
        state: 'webgl2Hardware',
        label: 'WebGL2 (hardware)',
        title: 'WebGL2 is active on a non-fallback adapter with Chromium hardware acceleration.',
        degraded: false,
      };
}

export interface HardwareQuirkRule {
  readonly id: string;
  readonly priority: number;
  readonly match: {
    readonly os?: HardwareOperatingSystem;
    readonly vendorId?: number;
    readonly deviceId?: number;
    readonly driverMin?: string;
    readonly driverMax?: string;
    readonly backend?: HardwareRendererBackend;
    readonly sessionType?: string;
    readonly electronRange?: string;
  };
  readonly actions: {
    readonly disableBackends?: readonly HardwareRendererBackend[];
    readonly forceAngle?: string;
    readonly renderBudgetScale?: number;
    readonly computeBudgetScale?: number;
  };
  readonly reason: string;
  readonly expires: string;
}

export interface HardwareQuirkRegistry {
  readonly schemaVersion: 1;
  readonly rules: readonly HardwareQuirkRule[];
}

export function validateQuirkRegistry(value: unknown): HardwareQuirkRegistry {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.rules))
    throw new TypeError('hardware quirk registry must use schemaVersion 1');
  const ids = new Set<string>();
  for (const candidate of value.rules) {
    if (
      !record(candidate) ||
      typeof candidate.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.id)
    )
      throw new TypeError('hardware quirk id is invalid');
    if (ids.has(candidate.id)) throw new TypeError(`duplicate hardware quirk id: ${candidate.id}`);
    ids.add(candidate.id);
    if (
      !Number.isInteger(candidate.priority) ||
      !record(candidate.match) ||
      !record(candidate.actions) ||
      typeof candidate.reason !== 'string' ||
      !candidate.reason.trim() ||
      typeof candidate.expires !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.expires)
    )
      throw new TypeError(`hardware quirk ${candidate.id} is malformed`);
    const matchKeys = new Set([
      'os',
      'vendorId',
      'deviceId',
      'driverMin',
      'driverMax',
      'backend',
      'sessionType',
      'electronRange',
    ]);
    const actionKeys = new Set([
      'disableBackends',
      'forceAngle',
      'renderBudgetScale',
      'computeBudgetScale',
    ]);
    if (
      Object.keys(candidate.match).some((key) => !matchKeys.has(key)) ||
      Object.keys(candidate.actions).some((key) => !actionKeys.has(key))
    )
      throw new TypeError(`hardware quirk ${candidate.id} has an unknown field`);
    for (const field of ['vendorId', 'deviceId'] as const)
      if (
        candidate.match[field] !== undefined &&
        (!Number.isInteger(candidate.match[field]) || Number(candidate.match[field]) < 0)
      )
        throw new TypeError(`hardware quirk ${candidate.id} has an invalid ${field}`);
    for (const field of ['renderBudgetScale', 'computeBudgetScale'] as const) {
      const scale = candidate.actions[field];
      if (
        scale !== undefined &&
        (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 1)
      )
        throw new TypeError(`hardware quirk ${candidate.id} has an invalid ${field}`);
    }
    if (
      typeof candidate.match.driverMin === 'string' &&
      typeof candidate.match.driverMax === 'string' &&
      compareVersions(candidate.match.driverMin, candidate.match.driverMax) > 0
    )
      throw new TypeError(`hardware quirk ${candidate.id} has a reversed driver range`);
  }
  return value as unknown as HardwareQuirkRegistry;
}

export function resolveMatchedQuirks(
  rules: readonly HardwareQuirkRule[],
): readonly HardwareQuirkRule[] {
  const registry = validateQuirkRegistry({ schemaVersion: 1, rules });
  const ordered = [...registry.rules].sort(
    (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const left = ordered[index - 1]!;
    const right = ordered[index]!;
    if (
      left.priority === right.priority &&
      left.actions.forceAngle !== undefined &&
      right.actions.forceAngle !== undefined &&
      left.actions.forceAngle !== right.actions.forceAngle
    )
      throw new TypeError(`hardware quirks ${left.id} and ${right.id} conflict at equal priority`);
  }
  return ordered;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  if ([...a, ...b].some((part) => !Number.isInteger(part) || part < 0))
    throw new TypeError('driver ranges must use dotted numeric versions');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
