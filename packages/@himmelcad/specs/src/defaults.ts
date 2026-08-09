import type {
  HatchPattern,
  LinetypePattern,
  SpecLibrary,
  SpecMaterial,
  Specification,
} from './types.js';
import { SPECS_LIBRARY_FORMAT, SPECS_LIBRARY_KIND } from './types.js';

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultLinetypes(): LinetypePattern[] {
  return [
    { id: 'lt_continuous', name: 'Continuous', segments: [] },
    { id: 'lt_dashed', name: 'Dashed', segments: [6, 3] },
    { id: 'lt_dashdot', name: 'Dash Dot', segments: [6, 2, 0, 2] },
    { id: 'lt_dotted', name: 'Dotted', segments: [0, 2] },
    { id: 'lt_center', name: 'Center', segments: [12, 2, 2, 2] },
    { id: 'lt_hidden', name: 'Hidden', segments: [3, 2] },
  ];
}

/** Revit-inspired basic draft hatches (names only; simple geometry). */
export function defaultHatches(): HatchPattern[] {
  return [
    { id: 'h_solid', name: 'Solid', kind: 'solid' },
    { id: 'h_diagonal', name: 'Diagonal up', kind: 'lines', angleDeg: 45, spacing: 4 },
    { id: 'h_diagonal_down', name: 'Diagonal down', kind: 'lines', angleDeg: -45, spacing: 4 },
    { id: 'h_cross', name: 'Crosshatch', kind: 'crosshatch', angleDeg: 45, spacing: 4 },
    { id: 'h_horizontal', name: 'Horizontal', kind: 'lines', angleDeg: 0, spacing: 3 },
    { id: 'h_vertical', name: 'Vertical', kind: 'lines', angleDeg: 90, spacing: 3 },
    { id: 'h_dots', name: 'Dots', kind: 'dots', spacing: 3 },
    {
      id: 'h_brick',
      name: 'Brick',
      kind: 'custom',
      lines: [
        { angleDeg: 0, spacing: 6 },
        { angleDeg: 90, spacing: 12, offset: 3 },
      ],
    },
    { id: 'h_concrete', name: 'Concrete', kind: 'crosshatch', angleDeg: 30, spacing: 5 },
    { id: 'h_earth', name: 'Earth', kind: 'lines', angleDeg: 45, spacing: 2 },
    { id: 'h_steel', name: 'Steel', kind: 'lines', angleDeg: 45, spacing: 1.5 },
    { id: 'h_wood', name: 'Wood', kind: 'lines', angleDeg: 0, spacing: 2 },
    { id: 'h_sand', name: 'Sand', kind: 'dots', spacing: 2 },
    { id: 'h_grass', name: 'Grass', kind: 'lines', angleDeg: 60, spacing: 3 },
    { id: 'h_glass', name: 'Glass', kind: 'lines', angleDeg: 45, spacing: 8 },
  ];
}

export function defaultMaterials(): SpecMaterial[] {
  return [
    {
      id: 'mat_asphalt',
      name: 'Asphalt',
      color: { kind: 'rgb', rgb: { r: 64, g: 64, b: 64 } },
      hatchId: 'h_solid',
      attributes: {},
    },
    {
      id: 'mat_concrete',
      name: 'Concrete',
      color: { kind: 'rgb', rgb: { r: 180, g: 180, b: 176 } },
      hatchId: 'h_concrete',
      attributes: {},
    },
    {
      id: 'mat_paving',
      name: 'Paving',
      color: { kind: 'rgb', rgb: { r: 160, g: 140, b: 120 } },
      hatchId: 'h_brick',
      attributes: {},
    },
    {
      id: 'mat_grass',
      name: 'Grass',
      color: { kind: 'rgb', rgb: { r: 120, g: 160, b: 90 } },
      hatchId: 'h_grass',
      attributes: {},
    },
  ];
}

/** Sample hierarchical codes: 1 paved, 11 carriageway, 12 paving, 13 concrete. */
export function sampleSpecifications(): Specification[] {
  const now = new Date().toISOString();
  return [
    {
      id: id('spec'),
      code: 1,
      name: 'Paved surfaces',
      drawFolder: ['Surfaces', 'Paved'],
      presentations: {},
      attributes: {},
      updatedAt: now,
    },
    {
      id: id('spec'),
      code: 11,
      name: 'Carriageway',
      drawFolder: ['Surfaces', 'Paved', 'Carriageway'],
      presentations: {
        curve: {
          kind: 'curve',
          curve: {
            color: { kind: 'rgb', rgb: { r: 0, g: 0, b: 0 } },
            lineWeightPx: 1,
            linetypeId: 'lt_continuous',
            materialId: 'mat_asphalt',
          },
        },
        area: {
          kind: 'area',
          area: {
            fill: { kind: 'rgb', rgb: { r: 90, g: 90, b: 90 } },
            hatchId: 'h_solid',
            materialId: 'mat_asphalt',
            boundary: {
              color: { kind: 'rgb', rgb: { r: 0, g: 0, b: 0 } },
              lineWeightPx: 1,
              linetypeId: 'lt_continuous',
            },
          },
        },
        point: {
          kind: 'point',
          point: {
            symbol: 'cross',
            sizePx: 6,
            color: { kind: 'rgb', rgb: { r: 0, g: 0, b: 0 } },
            materialId: 'mat_asphalt',
          },
        },
      },
      defaultMaterialId: 'mat_asphalt',
      attributes: {},
      updatedAt: now,
    },
    {
      id: id('spec'),
      code: 12,
      name: 'Paving',
      drawFolder: ['Surfaces', 'Paved', 'Paving'],
      presentations: {
        area: {
          kind: 'area',
          area: {
            fill: { kind: 'rgb', rgb: { r: 160, g: 140, b: 120 } },
            hatchId: 'h_brick',
            materialId: 'mat_paving',
          },
        },
        curve: {
          kind: 'curve',
          curve: {
            color: { kind: 'rgb', rgb: { r: 80, g: 60, b: 40 } },
            lineWeightPx: 0.75,
            linetypeId: 'lt_continuous',
          },
        },
      },
      defaultMaterialId: 'mat_paving',
      attributes: {},
      updatedAt: now,
    },
    {
      id: id('spec'),
      code: 13,
      name: 'Concrete',
      drawFolder: ['Surfaces', 'Paved', 'Concrete'],
      presentations: {
        area: {
          kind: 'area',
          area: {
            fill: { kind: 'rgb', rgb: { r: 180, g: 180, b: 176 } },
            hatchId: 'h_concrete',
            materialId: 'mat_concrete',
          },
        },
      },
      defaultMaterialId: 'mat_concrete',
      attributes: {},
      updatedAt: now,
    },
  ];
}

export function createEmptyLibrary(name = 'Project specs'): SpecLibrary {
  const now = new Date().toISOString();
  return {
    formatVersion: SPECS_LIBRARY_FORMAT,
    kind: SPECS_LIBRARY_KIND,
    id: id('lib'),
    name,
    linetypes: defaultLinetypes(),
    hatches: defaultHatches(),
    textures: [],
    materials: defaultMaterials(),
    specifications: sampleSpecifications(),
    updatedAt: now,
  };
}
