import type { EntityId, ObjectHash } from '@himmelcad/data';

import {
  defaultProductConfiguration,
  type ProductRunConfiguration,
} from './productConfiguration.js';

export type BatchRecipePipelineStep =
  | { kind: 'alignment'; profile: 'qualityHybrid' }
  | { kind: 'product'; configuration: ProductRunConfiguration };

export interface BatchRecipeCanvasNode {
  id: string;
  label: string;
  kind: 'alignment' | 'depth' | 'dense' | 'dem' | 'ortho' | 'mesh' | 'splat';
  position: { x: number; y: number };
  inputs: readonly string[];
  output: string;
}

export interface BatchRecipeCanvasEdge {
  from: string;
  to: string;
  artifact: string;
}

export interface BatchRecipeTemplateFile {
  formatVersion: 2;
  lifecycle: 'recipeTemplate';
  name: string;
  preset: BatchRecipePreset;
  nodes: BatchRecipeCanvasNode[];
  edges: BatchRecipeCanvasEdge[];
}

export type BatchRecipePreset = 'allProducts' | 'orthomosaicExternalDem';

export function graphForBatchRecipePreset(preset: BatchRecipePreset): {
  nodes: BatchRecipeCanvasNode[];
  edges: BatchRecipeCanvasEdge[];
} {
  if (preset === 'orthomosaicExternalDem') {
    return {
      nodes: [
        node('alignment', 'Align Photos', 'alignment', 50, 145, [], 'alignment'),
        node(
          'ortho',
          'Orthomosaic',
          'ortho',
          510,
          145,
          ['alignment', 'images', 'dem'],
          'orthomosaic',
        ),
      ],
      edges: [{ from: 'alignment', to: 'ortho', artifact: 'alignment' }],
    };
  }
  return {
    nodes: [
      node('alignment', 'Align Photos', 'alignment', 30, 190, [], 'alignment'),
      node('depth', 'Depth Maps', 'depth', 180, 80, ['alignment'], 'depthMaps'),
      node('dense', 'Dense Cloud', 'dense', 330, 80, ['depthMaps'], 'densePointCloud'),
      node('dem', 'DEM', 'dem', 480, 30, ['densePointCloud'], 'dem'),
      node('ortho', 'Orthomosaic', 'ortho', 650, 30, ['alignment', 'images', 'dem'], 'orthomosaic'),
      node('mesh', 'Mesh', 'mesh', 480, 210, ['densePointCloud'], 'mesh'),
      node('splat', 'Gaussian Splat', 'splat', 650, 210, ['mesh'], 'gaussianSplat'),
    ],
    edges: [
      { from: 'alignment', to: 'depth', artifact: 'alignment' },
      { from: 'depth', to: 'dense', artifact: 'depthMaps' },
      { from: 'dense', to: 'dem', artifact: 'densePointCloud' },
      { from: 'dem', to: 'ortho', artifact: 'dem' },
      { from: 'dense', to: 'mesh', artifact: 'densePointCloud' },
      { from: 'mesh', to: 'splat', artifact: 'mesh' },
    ],
  };
}

export function instantiateBatchRecipe(
  preset: BatchRecipePreset,
  demEntityId?: EntityId,
  demVersionSha256?: ObjectHash,
): BatchRecipePipelineStep[] {
  const alignment: BatchRecipePipelineStep = { kind: 'alignment', profile: 'qualityHybrid' };
  if (preset === 'orthomosaicExternalDem') {
    const configuration = {
      ...defaultProductConfiguration('ortho'),
      ...(demEntityId && demVersionSha256
        ? { sourceDemEntityId: demEntityId, sourceDemVersionSha256: demVersionSha256 }
        : {}),
    } satisfies ProductRunConfiguration;
    return [alignment, { kind: 'product', configuration }];
  }
  return [
    alignment,
    ...(['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'] as const).map(
      (operation): BatchRecipePipelineStep => ({
        kind: 'product',
        configuration: defaultProductConfiguration(operation),
      }),
    ),
  ];
}

export function isBatchRecipeTemplateFile(value: unknown): value is BatchRecipeTemplateFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BatchRecipeTemplateFile>;
  return (
    candidate.formatVersion === 2 &&
    candidate.lifecycle === 'recipeTemplate' &&
    typeof candidate.name === 'string' &&
    (candidate.preset === 'allProducts' || candidate.preset === 'orthomosaicExternalDem') &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

function node(
  id: string,
  label: string,
  kind: BatchRecipeCanvasNode['kind'],
  x: number,
  y: number,
  inputs: string[],
  output: string,
): BatchRecipeCanvasNode {
  return { id, label, kind, position: { x, y }, inputs, output };
}
