import type { VideoFrameSelectionPolicy } from '@himmelcad/data';

export interface VideoFramePlanDraft {
  intervalSeconds: string;
  maximumFrames: string;
  minimumSharpness: string;
}

export interface ValidVideoFramePlan {
  policy: VideoFrameSelectionPolicy;
  summary: string;
}

export type VideoFramePlanValidation =
  | { valid: true; value: ValidVideoFramePlan }
  | { valid: false; errors: Partial<Record<keyof VideoFramePlanDraft, string>> };

export const DEFAULT_VIDEO_FRAME_PLAN: VideoFramePlanDraft = {
  intervalSeconds: '0.25',
  maximumFrames: '1000',
  minimumSharpness: '0.02',
};

export function validateVideoFramePlan(draft: VideoFramePlanDraft): VideoFramePlanValidation {
  const errors: Partial<Record<keyof VideoFramePlanDraft, string>> = {};
  const intervalSeconds = parseFiniteNumber(draft.intervalSeconds);
  const maximumFrames = parseFiniteNumber(draft.maximumFrames);
  const minimumSharpness = parseFiniteNumber(draft.minimumSharpness);

  if (intervalSeconds == null || intervalSeconds <= 0 || intervalSeconds > 3_600) {
    errors.intervalSeconds = 'Enter an interval greater than 0 and no more than 3,600 seconds.';
  }
  if (
    maximumFrames == null ||
    !Number.isSafeInteger(maximumFrames) ||
    maximumFrames < 1 ||
    maximumFrames > 10_000
  ) {
    errors.maximumFrames = 'Enter a whole number from 1 to 10,000.';
  }
  if (minimumSharpness == null || minimumSharpness < 0 || minimumSharpness > 1) {
    errors.minimumSharpness = 'Enter a sharpness threshold from 0 to 1.';
  }
  if (Object.keys(errors).length > 0) return { valid: false, errors };

  const policy: VideoFrameSelectionPolicy = {
    maximumFrames: maximumFrames!,
    minimumIntervalMicroseconds: Math.round(intervalSeconds! * 1_000_000),
    minimumWidthPixels: 640,
    minimumHeightPixels: 480,
    minimumSharpness: minimumSharpness!,
    maximumMotion: 0.8,
    minimumOverlap: 0.2,
    maximumOverlap: 0.98,
  };
  return {
    valid: true,
    value: {
      policy,
      summary: summarizeVideoFramePlan(policy),
    },
  };
}

export function summarizeVideoFramePlan(policy: VideoFrameSelectionPolicy): string {
  const seconds = policy.minimumIntervalMicroseconds / 1_000_000;
  return `Up to ${policy.maximumFrames.toLocaleString('en-US')} frames · at least ${formatSeconds(seconds)} apart · sharpness ≥ ${policy.minimumSharpness.toFixed(2)}`;
}

function parseFiniteNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSeconds(value: number): string {
  return Number.isInteger(value)
    ? `${value.toFixed(0)} s`
    : `${value.toFixed(3).replace(/0+$/, '')} s`;
}
