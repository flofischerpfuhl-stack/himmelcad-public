import type { AlignmentQualityProfile, EntityId, ObjectHash } from '@himmelcad/data';

import {
  builtInAlignmentPresetReference,
  factoryAlignmentPresetById,
  isAlignmentPresetReference,
  parseAlignmentPreset,
  type AlignmentPresetFile,
  type AlignmentPresetReference,
} from './alignmentPreset.js';

import {
  defaultProductConfiguration,
  type ProductRunConfiguration,
} from './productConfiguration.js';

export type BatchRecipePipelineStep =
  | { kind: 'alignment'; preset: AlignmentPresetReference }
  | {
      kind: 'product';
      configuration: ProductRunConfiguration;
      gcpOptimizationEntityId?: EntityId | null;
    };

export interface LegacyBatchAlignmentStep {
  kind: 'alignment';
  profile: AlignmentQualityProfile;
}

export interface ResolvedBatchAlignmentPreset {
  id: string;
  name: string;
  profile: AlignmentQualityProfile;
  overrides: AlignmentPresetFile['overrides'];
}

export type ResolvedBatchPipelineStep =
  | { kind: 'alignment'; preset: ResolvedBatchAlignmentPreset }
  | {
      kind: 'product';
      configuration: ProductRunConfiguration;
      gcpOptimizationEntityId?: EntityId | null;
    };

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
  const alignment: BatchRecipePipelineStep = {
    kind: 'alignment',
    preset: builtInAlignmentPresetReference('qualityHybrid'),
  };
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

export function migrateLegacyBatchAlignmentSteps(
  steps: readonly (BatchRecipePipelineStep | LegacyBatchAlignmentStep)[],
): { steps: BatchRecipePipelineStep[]; migratedProfiles: AlignmentQualityProfile[] } {
  const migratedProfiles: AlignmentQualityProfile[] = [];
  const migrated = steps.map((step): BatchRecipePipelineStep => {
    if (step.kind !== 'alignment' || 'preset' in step) return step;
    migratedProfiles.push(step.profile);
    return { kind: 'alignment', preset: builtInAlignmentPresetReference(step.profile) };
  });
  return { steps: migrated, migratedProfiles };
}

export async function resolveBatchPipelineSteps(
  steps: readonly BatchRecipePipelineStep[],
  loadUserPreset: (path: string) => Promise<unknown>,
): Promise<ResolvedBatchPipelineStep[]> {
  return Promise.all(
    steps.map(async (step): Promise<ResolvedBatchPipelineStep> => {
      if (step.kind === 'product') return step;
      let preset: AlignmentPresetFile;
      if (step.preset.source === 'builtIn') {
        const factory = factoryAlignmentPresetById(step.preset.presetId);
        if (!factory) throw new Error('The selected built-in alignment preset is unavailable.');
        preset = factory.preset;
      } else {
        const parsed = parseAlignmentPreset(await loadUserPreset(step.preset.path));
        if (!parsed.ok) {
          throw new Error(`The batch alignment preset is invalid: ${parsed.errors.join('; ')}`);
        }
        preset = parsed.preset;
      }
      return {
        kind: 'alignment',
        preset: {
          id: preset.id,
          name: preset.name,
          profile: preset.profile,
          overrides: preset.overrides,
        },
      };
    }),
  );
}

export function isBatchAlignmentStep(
  value: unknown,
): value is Extract<BatchRecipePipelineStep, { kind: 'alignment' }> | LegacyBatchAlignmentStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  if (step.kind !== 'alignment') return false;
  if (isAlignmentPresetReference(step.preset)) return true;
  return (
    step.profile === 'qualityHybrid' ||
    step.profile === 'maximumRobustness' ||
    step.profile === 'fast'
  );
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
