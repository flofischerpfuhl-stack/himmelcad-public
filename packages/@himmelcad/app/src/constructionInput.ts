export interface ConstructionPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PolarConstructionValues {
  readonly directionDegrees: number;
  readonly distance: number;
  readonly deltaZ: number;
}

export type ConstructionInputMode = 'click' | 'constrain' | 'type';

export type ConstructionInputFieldId = 'x' | 'y' | 'z' | 'direction' | 'distance' | 'deltaZ';

export interface ConstructionInputField {
  readonly id: ConstructionInputFieldId;
  readonly label: 'X' | 'Y' | 'Z' | 'Dir °' | 'Dist m' | 'Δz m';
  readonly unit?: '°' | 'm';
  readonly value: number;
}

export interface ConstructionInputDeclaration {
  readonly toolId: string;
  readonly prompt: string;
  readonly firstPoint?: ConstructionPoint;
  readonly fields: readonly ConstructionInputFieldId[];
}

export interface ConstructionInputSnapshot {
  readonly armed: boolean;
  readonly declaration: ConstructionInputDeclaration | null;
  readonly mode: ConstructionInputMode;
  readonly values: Readonly<Record<ConstructionInputFieldId, number>>;
  readonly committedValues: Readonly<Record<ConstructionInputFieldId, number>>;
  readonly preview: ConstructionPoint | null;
  readonly polar: PolarConstructionValues | null;
  readonly activeField: ConstructionInputFieldId | null;
}

const ZERO_VALUES: Readonly<Record<ConstructionInputFieldId, number>> = Object.freeze({
  x: 0,
  y: 0,
  z: 0,
  direction: 0,
  distance: 0,
  deltaZ: 0,
});

export function polarFromPoints(
  origin: ConstructionPoint,
  point: ConstructionPoint,
): PolarConstructionValues {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return Object.freeze({
    directionDegrees: normalizeDegrees((Math.atan2(dy, dx) * 180) / Math.PI),
    distance: Math.hypot(dx, dy),
    deltaZ: point.z - origin.z,
  });
}

export function pointFromPolar(
  origin: ConstructionPoint,
  polar: PolarConstructionValues,
): ConstructionPoint {
  const radians = (normalizeDegrees(polar.directionDegrees) * Math.PI) / 180;
  return Object.freeze({
    x: origin.x + Math.cos(radians) * polar.distance,
    y: origin.y + Math.sin(radians) * polar.distance,
    z: origin.z + polar.deltaZ,
  });
}

/** Tri-modal C1 state owner. Pointer, constrained, and absolute entry converge here. */
export class ConstructionInputController {
  private declaration: ConstructionInputDeclaration | null = null;
  private mode: ConstructionInputMode = 'click';
  private values = { ...ZERO_VALUES };
  private committedValues = { ...ZERO_VALUES };
  private preview: ConstructionPoint | null = null;
  private activeField: ConstructionInputFieldId | null = null;
  private cachedSnapshot: ConstructionInputSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ConstructionInputSnapshot => {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const polar =
      this.preview && this.declaration?.firstPoint
        ? polarFromPoints(this.declaration.firstPoint, this.preview)
        : null;
    this.cachedSnapshot = Object.freeze({
      armed: this.declaration !== null,
      declaration: this.declaration,
      mode: this.mode,
      values: Object.freeze({ ...this.values }),
      committedValues: Object.freeze({ ...this.committedValues }),
      preview: this.preview,
      polar,
      activeField: this.activeField,
    });
    return this.cachedSnapshot;
  };

  arm(declaration: ConstructionInputDeclaration, seed?: ConstructionPoint): void {
    if (!declaration.toolId.trim() || declaration.fields.length === 0) {
      throw new TypeError('construction input declaration requires a tool and fields');
    }
    this.declaration = Object.freeze({
      ...declaration,
      fields: Object.freeze([...declaration.fields]),
    });
    const initial = seed ?? declaration.firstPoint ?? { x: 0, y: 0, z: 0 };
    this.values = valuesFromPoint(declaration.firstPoint, initial);
    this.committedValues = { ...this.values };
    this.preview = initial;
    this.mode = 'click';
    this.activeField = declaration.fields[0] ?? null;
    this.changed();
  }

  disarm(): void {
    if (!this.declaration) return;
    this.declaration = null;
    this.preview = null;
    this.activeField = null;
    this.changed();
  }

  pointer(point: ConstructionPoint): ConstructionPoint {
    this.requireArmed();
    assertPoint(point);
    this.mode = 'click';
    this.preview = Object.freeze({ ...point });
    this.values = valuesFromPoint(this.declaration?.firstPoint, point);
    this.changed();
    return this.preview;
  }

  constrain(values: PolarConstructionValues): ConstructionPoint {
    const declaration = this.requireArmed();
    if (!declaration.firstPoint) throw new Error('polar constraints require a first point');
    assertPolar(values);
    this.mode = 'constrain';
    this.preview = pointFromPolar(declaration.firstPoint, values);
    this.values = valuesFromPoint(declaration.firstPoint, this.preview);
    this.changed();
    return this.preview;
  }

  typeAbsolute(point: ConstructionPoint): ConstructionPoint {
    this.requireArmed();
    assertPoint(point);
    this.mode = 'type';
    this.preview = Object.freeze({ ...point });
    this.values = valuesFromPoint(this.declaration?.firstPoint, point);
    this.changed();
    return this.preview;
  }

  setField(field: ConstructionInputFieldId, value: number): ConstructionPoint {
    const declaration = this.requireArmed();
    if (!declaration.fields.includes(field))
      throw new RangeError(`undeclared construction field: ${field}`);
    if (!Number.isFinite(value)) throw new TypeError('construction value must be finite');
    this.activeField = field;
    this.values = { ...this.values, [field]: value };
    if (field === 'direction' || field === 'distance' || field === 'deltaZ') {
      if (!declaration.firstPoint) throw new Error('polar constraints require a first point');
      this.mode = 'constrain';
      this.preview = pointFromPolar(declaration.firstPoint, {
        directionDegrees: this.values.direction,
        distance: this.values.distance,
        deltaZ: this.values.deltaZ,
      });
    } else {
      this.mode = 'type';
      this.preview = { x: this.values.x, y: this.values.y, z: this.values.z };
    }
    this.changed();
    return this.preview;
  }

  focus(field: ConstructionInputFieldId): void {
    const declaration = this.requireArmed();
    if (!declaration.fields.includes(field))
      throw new RangeError(`undeclared construction field: ${field}`);
    this.activeField = field;
    this.changed();
  }

  commit(): ConstructionPoint {
    const point = this.preview;
    if (!point) throw new Error('construction input has no valid preview');
    this.committedValues = { ...this.values };
    this.changed();
    return point;
  }

  /** First Escape restores the focused field's last committed value. */
  revertField(): boolean {
    if (!this.declaration || !this.activeField) return false;
    const field = this.activeField;
    if (Object.is(this.values[field], this.committedValues[field])) return false;
    this.values = { ...this.values, [field]: this.committedValues[field] };
    if (field === 'direction' || field === 'distance' || field === 'deltaZ') {
      if (!this.declaration.firstPoint) return false;
      this.preview = pointFromPolar(this.declaration.firstPoint, {
        directionDegrees: this.values.direction,
        distance: this.values.distance,
        deltaZ: this.values.deltaZ,
      });
    } else {
      this.preview = { x: this.values.x, y: this.values.y, z: this.values.z };
    }
    this.changed();
    return true;
  }

  fields(): readonly ConstructionInputField[] {
    const declaration = this.requireArmed();
    return declaration.fields.map((id) => ({
      id,
      label: fieldLabel(id),
      ...(id === 'direction' ? { unit: '°' as const } : { unit: 'm' as const }),
      value: this.values[id],
    }));
  }

  private requireArmed(): ConstructionInputDeclaration {
    if (!this.declaration) throw new Error('construction input is not armed');
    return this.declaration;
  }

  private changed(): void {
    this.cachedSnapshot = null;
    for (const listener of this.listeners) listener();
  }
}

function valuesFromPoint(
  origin: ConstructionPoint | undefined,
  point: ConstructionPoint,
): Record<ConstructionInputFieldId, number> {
  const polar = origin
    ? polarFromPoints(origin, point)
    : { directionDegrees: 0, distance: 0, deltaZ: 0 };
  return {
    x: point.x,
    y: point.y,
    z: point.z,
    direction: polar.directionDegrees,
    distance: polar.distance,
    deltaZ: polar.deltaZ,
  };
}

function fieldLabel(id: ConstructionInputFieldId): ConstructionInputField['label'] {
  return (
    {
      x: 'X',
      y: 'Y',
      z: 'Z',
      direction: 'Dir °',
      distance: 'Dist m',
      deltaZ: 'Δz m',
    } as const
  )[id];
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function assertPoint(point: ConstructionPoint): void {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new TypeError('construction point must be finite');
  }
}

function assertPolar(values: PolarConstructionValues): void {
  if (![values.directionDegrees, values.distance, values.deltaZ].every(Number.isFinite)) {
    throw new TypeError('construction polar values must be finite');
  }
  if (values.distance < 0) throw new RangeError('construction distance must be non-negative');
}
