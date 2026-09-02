import type { CameraCalibrationSeed, GcpIntrinsicsPolicy } from '@himmelcad/data';

export type LabCalibrationPolicy = 'fixed' | 'prior';
export type LabCalibrationParameter = 'f' | 'cx' | 'cy' | 'k1' | 'k2' | 'k3' | 'p1' | 'p2';

export interface LabCalibrationFormValues extends Record<LabCalibrationParameter, string> {
  policy: LabCalibrationPolicy;
}

export interface ImagePixelDimensions {
  widthPixels: number;
  heightPixels: number;
}

export interface ValidatedLabCalibration {
  errors: Partial<Record<LabCalibrationParameter | 'dimensions', string>>;
  initialCalibration?: CameraCalibrationSeed;
  intrinsicsPolicy?: GcpIntrinsicsPolicy;
}

export const EMPTY_LAB_CALIBRATION: LabCalibrationFormValues = {
  f: '',
  cx: '',
  cy: '',
  k1: '',
  k2: '',
  k3: '',
  p1: '',
  p2: '',
  policy: 'fixed',
};

const ALL_INTRINSICS = {
  f: true,
  cx: true,
  cy: true,
  k1: true,
  k2: true,
  k3: true,
  p1: true,
  p2: true,
} as const;

export function validateLabCalibration(
  values: LabCalibrationFormValues,
  dimensions: ImagePixelDimensions | undefined,
): ValidatedLabCalibration {
  const errors: ValidatedLabCalibration['errors'] = {};
  if (!dimensions || dimensions.widthPixels <= 0 || dimensions.heightPixels <= 0) {
    errors.dimensions = 'Image dimensions are unavailable.';
  }
  const parsed = {} as Record<LabCalibrationParameter, number>;
  for (const parameter of Object.keys(EMPTY_LAB_CALIBRATION).filter(
    (key) => key !== 'policy',
  ) as LabCalibrationParameter[]) {
    const value = Number(values[parameter]);
    if (values[parameter].trim() === '' || !Number.isFinite(value)) {
      errors[parameter] = 'Enter a finite number.';
    } else {
      parsed[parameter] = value;
    }
  }
  if (parsed.f !== undefined && parsed.f <= 0) errors.f = 'Focal length must be greater than 0.';
  if (
    dimensions &&
    parsed.f !== undefined &&
    parsed.f > Math.max(dimensions.widthPixels, dimensions.heightPixels) * 10
  ) {
    errors.f = 'Focal length is outside the supported pixel range.';
  }
  if (
    dimensions &&
    parsed.cx !== undefined &&
    (parsed.cx < 0 || parsed.cx > dimensions.widthPixels)
  ) {
    errors.cx = 'cx must be inside the image width.';
  }
  if (
    dimensions &&
    parsed.cy !== undefined &&
    (parsed.cy < 0 || parsed.cy > dimensions.heightPixels)
  ) {
    errors.cy = 'cy must be inside the image height.';
  }
  for (const parameter of ['k1', 'k2', 'k3'] as const) {
    if (parsed[parameter] !== undefined && Math.abs(parsed[parameter]) > 10) {
      errors[parameter] = `${parameter} must be between -10 and 10.`;
    }
  }
  for (const parameter of ['p1', 'p2'] as const) {
    if (parsed[parameter] !== undefined && Math.abs(parsed[parameter]) > 1) {
      errors[parameter] = `${parameter} must be between -1 and 1.`;
    }
  }
  if (Object.keys(errors).length || !dimensions) return { errors };

  const initialCalibration: CameraCalibrationSeed = {
    widthPixels: dimensions.widthPixels,
    heightPixels: dimensions.heightPixels,
    focalPixels: parsed.f,
    principalXPixels: parsed.cx,
    principalYPixels: parsed.cy,
    fullBrownCalibration: {
      focalXPixels: parsed.f,
      focalYPixels: parsed.f,
      principalXPixels: parsed.cx,
      principalYPixels: parsed.cy,
      radialDistortion: [parsed.k1, parsed.k2, parsed.k3],
      tangentialDistortion: [parsed.p1, parsed.p2],
      calibrationDate: '',
      provenance: 'labCalibration',
    },
  };
  return {
    errors,
    initialCalibration,
    intrinsicsPolicy:
      values.policy === 'fixed'
        ? { kind: 'fixed' }
        : {
            kind: 'prior',
            parameters: ALL_INTRINSICS,
            stddev: {
              focalLogScale: 0.25,
              principalXPixels: 200,
              principalYPixels: 200,
              k1: 0.25,
              k2: 0.25,
              k3: 0.25,
              p1: 0.1,
              p2: 0.1,
            },
          },
  };
}
