export type KernelSelectionVisualClass =
  | 'directedLine'
  | 'pointSquare'
  | 'symbolAnchor'
  | 'supportGeometry'
  | 'entityBounds';

export interface KernelSelectionVisualInput {
  readonly entityKind: string;
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly pickable: boolean;
  readonly symbolBearingPoint?: boolean;
  readonly supportRole?: 'helper_point' | 'defining_point' | 'defining_curve' | null;
}

export interface KernelSelectionVisualOptions {
  readonly supportGeometryVisible: boolean;
  readonly directionArrowSizePixels?: number;
}

export interface KernelSelectionVisualPolicy {
  readonly visualClass: KernelSelectionVisualClass | null;
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly colorToken:
    | '--hc-geometry-selection'
    | '--hc-geometry-support'
    | '--hc-geometry-hover'
    | null;
  readonly directionGlyph: { readonly kind: 'endArrow'; readonly sizePixels: number } | null;
  readonly anchorOnly: boolean;
}

const CLOUD_KINDS = new Set([
  'PointCloud',
  'GaussianSplatCloud',
  'pointCloud',
  'gaussianSplatCloud',
]);
const POINT_KINDS = new Set(['SinglePoint', 'GroundControlPoint', 'point']);
const CURVE_KINDS = new Set(['Polyline3D', 'Axis', 'AlignmentElement', 'curve']);

/** UIP-D15/UIP-D21 policy seam consumed by viewport selection adapters. */
export function kernelSelectionVisualPolicy(
  input: KernelSelectionVisualInput,
  options: KernelSelectionVisualOptions,
): KernelSelectionVisualPolicy {
  const arrowSize = options.directionArrowSizePixels ?? 8;
  if (!Number.isFinite(arrowSize) || arrowSize < 4 || arrowSize > 32) {
    throw new RangeError('selection direction arrow size must be between 4 and 32 pixels');
  }
  const isCloud = CLOUD_KINDS.has(input.entityKind);
  const hovered = input.hovered && input.pickable && !isCloud;
  if (input.supportRole) {
    return Object.freeze({
      visualClass: options.supportGeometryVisible ? 'supportGeometry' : null,
      selected: input.selected,
      hovered,
      colorToken: options.supportGeometryVisible ? '--hc-geometry-support' : null,
      directionGlyph: null,
      anchorOnly: false,
    });
  }
  if (isCloud) {
    return Object.freeze({
      visualClass: input.selected ? 'entityBounds' : null,
      selected: input.selected,
      hovered: false,
      colorToken: null,
      directionGlyph: null,
      anchorOnly: false,
    });
  }
  if (!input.selected && !hovered) {
    return Object.freeze({
      visualClass: null,
      selected: false,
      hovered: false,
      colorToken: null,
      directionGlyph: null,
      anchorOnly: false,
    });
  }
  if (POINT_KINDS.has(input.entityKind)) {
    return Object.freeze({
      visualClass: input.symbolBearingPoint ? 'symbolAnchor' : 'pointSquare',
      selected: input.selected,
      hovered,
      colorToken: input.selected ? '--hc-geometry-selection' : '--hc-geometry-hover',
      directionGlyph: null,
      anchorOnly: input.symbolBearingPoint === true,
    });
  }
  const directed = CURVE_KINDS.has(input.entityKind);
  return Object.freeze({
    visualClass: directed ? 'directedLine' : 'entityBounds',
    selected: input.selected,
    hovered,
    colorToken: input.selected ? '--hc-geometry-selection' : '--hc-geometry-hover',
    directionGlyph: directed ? { kind: 'endArrow' as const, sizePixels: arrowSize } : null,
    anchorOnly: false,
  });
}
