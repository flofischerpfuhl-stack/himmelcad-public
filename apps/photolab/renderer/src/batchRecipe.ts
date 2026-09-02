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
  type ProductOperation,
  type ProductRunConfiguration,
} from './productConfiguration.js';
import { productPrerequisiteArtifactGroups } from './productPrerequisites.js';

export const BATCH_PIPELINE_SCHEMA = 'himmelcad.photolab.batch-pipeline';
export const BATCH_PIPELINE_FORMAT_VERSION = 2;
export const BATCH_PROCESSING_SET_PREFIX = 'processing-set:';

const PRODUCT_OPERATIONS: readonly ProductOperation[] = [
  'depth',
  'dense',
  'dem',
  'ortho',
  'mesh',
  'splat',
];

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

export type BatchPipelineScope =
  | { kind: 'all' }
  | { kind: 'currentSelection' }
  | { kind: 'processingSet'; entityId: EntityId; membershipSha256: ObjectHash };

/**
 * The schema discriminator distinguishes the current pipeline from the retired
 * formatVersion 2 recipeTemplate file. Version 1 pipelines had no discriminator.
 */
export interface BatchPipelineFile {
  schema: typeof BATCH_PIPELINE_SCHEMA;
  formatVersion: typeof BATCH_PIPELINE_FORMAT_VERSION;
  name: string;
  steps: BatchRecipePipelineStep[];
  scope: BatchPipelineScope;
}

export interface LoadedBatchPipeline {
  file: BatchPipelineFile;
  notices: string[];
  migratedProfiles: AlignmentQualityProfile[];
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

export interface BatchPipelineEdge {
  from: number;
  to: number;
  artifact: 'alignment' | 'depth' | 'dense' | 'dem';
}

export function encodeBatchProcessingSetValue(entityId: EntityId): string {
  return `${BATCH_PROCESSING_SET_PREFIX}${entityId}`;
}

export function decodeBatchProcessingSetValue(value: string): EntityId | null {
  return value.startsWith(BATCH_PROCESSING_SET_PREFIX)
    ? (value.slice(BATCH_PROCESSING_SET_PREFIX.length) as EntityId)
    : null;
}

export function loadBatchPipeline(value: unknown): LoadedBatchPipeline | null {
  if (isCurrentBatchPipelineFile(value)) {
    return { file: value, notices: [], migratedProfiles: [] };
  }
  if (isLegacyBatchPipelineFile(value)) {
    const migration = migrateLegacyBatchAlignmentSteps(value.steps);
    return {
      file: {
        schema: BATCH_PIPELINE_SCHEMA,
        formatVersion: BATCH_PIPELINE_FORMAT_VERSION,
        name: value.name,
        steps: migration.steps,
        scope: value.scope ?? { kind: 'all' },
      },
      notices: ['Updated batch pipeline to format version 2'],
      migratedProfiles: migration.migratedProfiles,
    };
  }
  if (!isLegacyRecipeTemplateFile(value)) return null;

  return {
    file: {
      schema: BATCH_PIPELINE_SCHEMA,
      formatVersion: BATCH_PIPELINE_FORMAT_VERSION,
      name: value.name,
      steps: migrateLegacyRecipeSteps(value),
      scope: { kind: 'all' },
    },
    notices: ['Migrated from recipe template'],
    migratedProfiles: [],
  };
}

export function deriveBatchPipelineEdges(
  steps: readonly BatchRecipePipelineStep[],
): BatchPipelineEdge[] {
  const alignmentIndex = steps.findIndex((step) => step.kind === 'alignment');
  const productIndex = new Map<ProductOperation, number>();
  steps.forEach((step, index) => {
    if (step.kind === 'product') productIndex.set(step.configuration.kind, index);
  });

  const edges: BatchPipelineEdge[] = [];
  steps.forEach((step, to) => {
    if (step.kind !== 'product') return;
    if (alignmentIndex >= 0) edges.push({ from: alignmentIndex, to, artifact: 'alignment' });

    const externalDemBound =
      step.configuration.kind === 'ortho' && Boolean(step.configuration.sourceDemEntityId);
    const meshSourceKinds =
      step.configuration.kind === 'mesh' && step.configuration.sourceDemEntityId
        ? ([] as const)
        : (['dem'] as const);
    const prerequisiteGroups = productPrerequisiteArtifactGroups(step.configuration.kind, {
      externalDemBound,
      meshSourceKinds,
    });
    for (const group of prerequisiteGroups) {
      const source = group
        .map((artifact) => ({
          artifact,
          index:
            artifact === 'depthReuse'
              ? productIndex.get('depth')
              : productIndex.get(artifact as ProductOperation),
        }))
        .find((candidate) => candidate.index !== undefined);
      if (!source || source.index === undefined || source.index === to) continue;
      edges.push({
        from: source.index,
        to,
        artifact: source.artifact === 'depthReuse' ? 'depth' : source.artifact,
      });
    }
  });
  return edges;
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

function migrateLegacyRecipeSteps(template: Record<string, unknown>): BatchRecipePipelineStep[] {
  const alignment: BatchRecipePipelineStep = {
    kind: 'alignment',
    preset: builtInAlignmentPresetReference('qualityHybrid'),
  };
  if (template.preset !== 'orthomosaicExternalDem') {
    return [
      alignment,
      ...PRODUCT_OPERATIONS.map(
        (operation): BatchRecipePipelineStep => ({
          kind: 'product',
          configuration: defaultProductConfiguration(operation),
        }),
      ),
    ];
  }

  const configuration = defaultProductConfiguration('ortho');
  const binding = legacyDemBinding(template);
  return [
    alignment,
    {
      kind: 'product',
      configuration: binding ? { ...configuration, ...binding } : configuration,
    },
  ];
}

function legacyDemBinding(
  template: Record<string, unknown>,
): Pick<
  Extract<ProductRunConfiguration, { kind: 'ortho' }>,
  'sourceDemEntityId' | 'sourceDemVersionSha256'
> | null {
  const nodes = Array.isArray(template.nodes) ? template.nodes : [];
  const candidates = [
    template.externalDemBinding,
    template.demBinding,
    ...nodes.flatMap((node) => {
      if (!node || typeof node !== 'object') return [];
      const record = node as Record<string, unknown>;
      return [record.binding, record.configuration, record];
    }),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const entityId = record.sourceDemEntityId ?? record.entityId;
    const version = record.sourceDemVersionSha256 ?? record.versionSha256 ?? record.versionHash;
    if (typeof entityId === 'string' && typeof version === 'string') {
      return {
        sourceDemEntityId: entityId as EntityId,
        sourceDemVersionSha256: version as ObjectHash,
      };
    }
  }
  return null;
}

function isCurrentBatchPipelineFile(value: unknown): value is BatchPipelineFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BatchPipelineFile>;
  return (
    candidate.schema === BATCH_PIPELINE_SCHEMA &&
    candidate.formatVersion === BATCH_PIPELINE_FORMAT_VERSION &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every(isBatchStep) &&
    isBatchPipelineScope(candidate.scope)
  );
}

type LoadableBatchPipelineStep = BatchRecipePipelineStep | LegacyBatchAlignmentStep;
interface LegacyBatchPipelineFile {
  formatVersion: 1;
  name: string;
  steps: LoadableBatchPipelineStep[];
  scope?: BatchPipelineScope;
}

function isLegacyBatchPipelineFile(value: unknown): value is LegacyBatchPipelineFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LegacyBatchPipelineFile>;
  return (
    candidate.formatVersion === 1 &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every(isBatchStep) &&
    (candidate.scope == null || isBatchPipelineScope(candidate.scope))
  );
}

function isLegacyRecipeTemplateFile(
  value: unknown,
): value is Record<string, unknown> & { name: string } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.formatVersion === 2 &&
    candidate.lifecycle === 'recipeTemplate' &&
    typeof candidate.name === 'string' &&
    (candidate.preset === 'allProducts' || candidate.preset === 'orthomosaicExternalDem') &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

function isBatchPipelineScope(value: unknown): value is BatchPipelineScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as Record<string, unknown>;
  if (scope.kind === 'all' || scope.kind === 'currentSelection') return true;
  return (
    scope.kind === 'processingSet' &&
    typeof scope.entityId === 'string' &&
    typeof scope.membershipSha256 === 'string'
  );
}

function isBatchStep(value: unknown): value is LoadableBatchPipelineStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  if (step.kind === 'alignment') return isBatchAlignmentStep(step);
  if (step.kind !== 'product' || !step.configuration || typeof step.configuration !== 'object') {
    return false;
  }
  const operation = (step.configuration as { kind?: unknown }).kind;
  return (
    typeof operation === 'string' &&
    PRODUCT_OPERATIONS.some((candidate) => candidate === operation) &&
    (step.gcpOptimizationEntityId === undefined ||
      step.gcpOptimizationEntityId === null ||
      typeof step.gcpOptimizationEntityId === 'string')
  );
}
