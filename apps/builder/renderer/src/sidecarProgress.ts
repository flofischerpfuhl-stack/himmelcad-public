const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';

export interface SidecarProgress {
  readonly progressKey: string;
  readonly fraction: number;
  readonly message: string;
}

export function parseSidecarProgress(line: string): SidecarProgress | null {
  const index = line.indexOf(SIDECAR_PROGRESS_PREFIX);
  if (index < 0) return null;
  const raw = line.slice(index + SIDECAR_PROGRESS_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as {
      progressKey?: unknown;
      fraction?: unknown;
      message?: unknown;
    };
    if (typeof parsed.progressKey !== 'string' || parsed.progressKey.length === 0) return null;
    if (typeof parsed.fraction !== 'number' || !Number.isFinite(parsed.fraction)) return null;
    if (typeof parsed.message !== 'string') return null;
    return {
      progressKey: parsed.progressKey,
      fraction: Math.min(1, Math.max(0, parsed.fraction)),
      message: parsed.message,
    };
  } catch {
    return null;
  }
}
