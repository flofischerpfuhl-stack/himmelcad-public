/**
 * Independent specification system (not wired to HimmelCAD core entities yet).
 *
 * Hierarchy (bottom → top):
 *   Pattern primitives (linetype, hatch, texture)
 *     → Material (simple fill + extensible attributes)
 *       → Specification (named code; per entity-kind presentation)
 *
 * Drawing-folder: hierarchical placement hint for model/view (not bound yet).
 */

export const SPECS_LIBRARY_FORMAT = 1 as const;
export const SPECS_LIBRARY_KIND = 'himmelcadSpecLibrary' as const;

/** Integer code: 1–10 decimal digits (1 … 9999999999). Hierarchical by prefix. */
export type SpecCode = number;

/** Entity kinds a specification can style (independent of core type_ids). */
export type SpecEntityKind =
  | 'point'
  | 'curve'
  | 'area'
  | 'text'
  | 'dimension'
  | 'block'
  | 'surface'
  | 'bimObject'
  | 'pointCloud'
  | 'raster'
  | 'generic';

export const SPEC_ENTITY_KINDS: readonly SpecEntityKind[] = [
  'point',
  'curve',
  'area',
  'text',
  'dimension',
  'block',
  'surface',
  'bimObject',
  'pointCloud',
  'raster',
  'generic',
] as const;

export type RgbColor = { r: number; g: number; b: number };

export type ColorRef = { kind: 'rgb'; rgb: RgbColor } | { kind: 'none' };

/** Dash pattern in drawing units (absolute). */
export interface LinetypePattern {
  id: string;
  name: string;
  /** Alternating dash/gap lengths; empty = continuous. */
  segments: number[];
  description?: string;
}

/** Simple hatch (Revit-style fill pattern list; not material physics). */
export interface HatchPattern {
  id: string;
  name: string;
  /** Built-in id or custom lines. */
  kind: 'solid' | 'lines' | 'crosshatch' | 'dots' | 'custom';
  /** Angle degrees for line hatches. */
  angleDeg?: number;
  spacing?: number;
  /** Custom: pairs of angle/spacing. */
  lines?: Array<{ angleDeg: number; spacing: number; offset?: number }>;
  description?: string;
}

/** Lightweight texture reference (image path or data URL) — not PBR. */
export interface TextureRef {
  id: string;
  name: string;
  /** Relative path, data URL, or asset id. */
  source: string;
  scale?: number;
  description?: string;
}

/**
 * Material = named combination of fill/stroke primitives + free attributes.
 * No fire rating / cost / physics — user can add those via attributes.
 */
export interface SpecMaterial {
  id: string;
  name: string;
  color?: ColorRef;
  hatchId?: string;
  textureId?: string;
  linetypeId?: string;
  lineWeightPx?: number;
  /** Arbitrary key/value bag for user extension. */
  attributes: Record<string, string | number | boolean>;
  description?: string;
}

export interface PointPresentation {
  symbol: 'dot' | 'cross' | 'circle' | 'square' | 'triangle' | 'plus';
  sizePx: number;
  color: ColorRef;
  materialId?: string;
}

export interface CurvePresentation {
  color: ColorRef;
  lineWeightPx: number;
  linetypeId?: string;
  materialId?: string;
}

export interface AreaPresentation {
  fill: ColorRef;
  hatchId?: string;
  textureId?: string;
  boundary?: CurvePresentation;
  materialId?: string;
}

export interface TextPresentation {
  color: ColorRef;
  fontFamily: string;
  fontSizePx: number;
  bold?: boolean;
  italic?: boolean;
  materialId?: string;
}

export interface DimensionPresentation {
  color: ColorRef;
  lineWeightPx: number;
  text: TextPresentation;
  materialId?: string;
}

export interface BlockPresentation {
  color: ColorRef;
  materialId?: string;
}

export interface SurfacePresentation {
  color: ColorRef;
  hatchId?: string;
  textureId?: string;
  materialId?: string;
}

export interface BimObjectPresentation {
  color: ColorRef;
  materialId?: string;
  /** Optional hatch when shown as plan fill. */
  hatchId?: string;
}

export interface PointCloudPresentation {
  colorMode: 'rgb' | 'uniform' | 'height' | 'intensity';
  uniformColor?: ColorRef;
  pointSizePx: number;
}

export interface RasterPresentation {
  opacity: number;
}

export type EntityPresentation =
  | { kind: 'point'; point: PointPresentation }
  | { kind: 'curve'; curve: CurvePresentation }
  | { kind: 'area'; area: AreaPresentation }
  | { kind: 'text'; text: TextPresentation }
  | { kind: 'dimension'; dimension: DimensionPresentation }
  | { kind: 'block'; block: BlockPresentation }
  | { kind: 'surface'; surface: SurfacePresentation }
  | { kind: 'bimObject'; bimObject: BimObjectPresentation }
  | { kind: 'pointCloud'; pointCloud: PointCloudPresentation }
  | { kind: 'raster'; raster: RasterPresentation }
  | { kind: 'generic'; generic: { color: ColorRef; materialId?: string } };

/**
 * One specification: hierarchical integer code + name + draw-folder +
 * optional presentation per entity kind.
 */
export interface Specification {
  id: string;
  /** 1–10 digit positive integer (leading zeros not stored). */
  code: SpecCode;
  name: string;
  /**
   * Hierarchical folder path for model/view placement when drawing.
   * e.g. ["Surfaces", "Paved", "Carriageway"] — not bound to core yet.
   */
  drawFolder: string[];
  description?: string;
  /** Presentations keyed by entity kind (only kinds that apply). */
  presentations: Partial<Record<SpecEntityKind, EntityPresentation>>;
  /** Default material shortcut. */
  defaultMaterialId?: string;
  attributes: Record<string, string | number | boolean>;
  updatedAt: string;
}

export interface SpecLibrary {
  formatVersion: typeof SPECS_LIBRARY_FORMAT;
  kind: typeof SPECS_LIBRARY_KIND;
  id: string;
  name: string;
  linetypes: LinetypePattern[];
  hatches: HatchPattern[];
  textures: TextureRef[];
  materials: SpecMaterial[];
  specifications: Specification[];
  updatedAt: string;
}
