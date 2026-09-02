import type { EntityId, ObjectHash, PublishedGcpOptimizationEntry } from '@himmelcad/data';
import { Checkbox, Select } from '@himmelcad/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { compatibleGcpOptimizations } from './alignmentMergeDraft.js';
import {
  defaultProductConfiguration,
  type ProductOperation,
  type ProductRunConfiguration,
} from './productConfiguration.js';
import {
  evaluateProductPrerequisites,
  type ProductPrerequisiteStatus,
} from './productPrerequisites.js';
import styles from './ProductPanel.module.css';

export {
  defaultProductConfiguration,
  type ProductOperation,
  type ProductRunConfiguration,
} from './productConfiguration.js';

export interface ProductPanelProps {
  operation: ProductOperation;
  busy: boolean;
  inputs: readonly { id: string; label: string }[];
  selectedInputId: string;
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
  localMetric: boolean;
  prerequisites: ProductPrerequisiteStatus;
  prerequisiteProducts: readonly {
    kind: 'depth' | 'dense' | 'dem' | string;
    sourceAlignmentEntityId?: EntityId;
    gcpOptimizationEntityId?: EntityId;
    gcpOptimizationSnapshotSha256?: ObjectHash;
  }[];
  startError: string | null;
  onInputChange: (id: string) => void;
  onActivatePrerequisite: (functionId: string) => void;
  onStart: (
    configuration: ProductRunConfiguration,
    gcpOptimizationEntityId: EntityId | null | undefined,
  ) => void;
}

export interface ResolvedProductInputs {
  kind: ProductOperation;
  alignment: { entityId: EntityId; name: string; snapshotSha256: ObjectHash };
  processingSet?: { entityId: EntityId; name: string; membershipSha256: ObjectHash };
  gcpOptimization?: { entityId: EntityId; operationId: string; snapshotSha256: ObjectHash };
  maskScopeSha256?: ObjectHash;
}

export function ProductPanel({
  operation,
  busy,
  inputs,
  selectedInputId,
  gcpOptimizations,
  localMetric,
  prerequisites,
  prerequisiteProducts,
  startError,
  onInputChange,
  onActivatePrerequisite,
  onStart,
}: ProductPanelProps): JSX.Element {
  const defaults = useMemo(() => defaultProductConfiguration(operation), [operation]);
  const [configuration, setConfiguration] = useState<ProductRunConfiguration>(defaults);
  const [gcpSelection, setGcpSelection] = useState('latest');
  const [resolvedInputs, setResolvedInputs] = useState<ResolvedProductInputs | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  useEffect(() => setConfiguration(defaults), [defaults]);
  useEffect(() => setGcpSelection('latest'), [selectedInputId]);
  const compatibleOptimizations = useMemo(
    () =>
      selectedInputId
        ? compatibleGcpOptimizations(selectedInputId as EntityId, gcpOptimizations)
        : [],
    [gcpOptimizations, selectedInputId],
  );
  const latestOptimization = compatibleOptimizations.at(-1);
  const exactPrerequisites = useMemo((): ProductPrerequisiteStatus => {
    if (!resolvedInputs) return prerequisites;
    const availableArtifacts = new Set(prerequisites.availableArtifacts);
    availableArtifacts.clear();
    for (const product of prerequisiteProducts) {
      if (product.sourceAlignmentEntityId !== resolvedInputs.alignment.entityId) continue;
      if (product.gcpOptimizationEntityId !== resolvedInputs.gcpOptimization?.entityId) continue;
      if (product.gcpOptimizationSnapshotSha256 !== resolvedInputs.gcpOptimization?.snapshotSha256)
        continue;
      if (product.kind === 'depth') {
        availableArtifacts.add('depth');
        availableArtifacts.add('depthReuse');
      } else if (product.kind === 'dense') availableArtifacts.add('dense');
      else if (product.kind === 'dem') availableArtifacts.add('dem');
    }
    return {
      ...prerequisites,
      availableArtifacts,
      mergedFrameGeoreferenced:
        prerequisites.mergedFrameGeoreferenced || Boolean(resolvedInputs.gcpOptimization),
    };
  }, [prerequisiteProducts, prerequisites, resolvedInputs]);
  const prerequisite = evaluateProductPrerequisites(operation, {
    ...exactPrerequisites,
    externalDemBound:
      exactPrerequisites.externalDemBound ||
      (configuration.kind === 'ortho' && Boolean(configuration.sourceDemEntityId)),
  });
  useEffect(() => {
    let current = true;
    setResolvedInputs(null);
    setResolveError(null);
    if (!selectedInputId) {
      setResolving(false);
      return () => {
        current = false;
      };
    }
    const api = window.himmelcad;
    if (!api) {
      setResolveError('Desktop bridge is missing. Start PhotoLab through Electron.');
      return () => {
        current = false;
      };
    }
    setResolving(true);
    const gcpOptimizationEntityId = decodeGcpSelection(gcpSelection);
    void api.sidecar
      .call<ResolvedProductInputs>('photolab.products.resolveInputs', {
        kind: operation,
        sourceAlignmentEntityId: selectedInputId,
        ...(gcpOptimizationEntityId !== undefined ? { gcpOptimizationEntityId } : {}),
      })
      .then((resolved) => {
        if (current) setResolvedInputs(resolved);
      })
      .catch((error: unknown) => {
        if (current) setResolveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (current) setResolving(false);
      });
    return () => {
      current = false;
    };
  }, [gcpSelection, operation, selectedInputId]);
  if (configuration.kind !== operation) {
    return <div className={styles.root} />;
  }

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>{title(operation)}</div>
        <Field label="Input">
          <Select
            value={selectedInputId}
            onChange={(event) => onInputChange(event.currentTarget.value)}
          >
            {inputs.length === 0 && <option value="">No published alignments</option>}
            {inputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="GCP optimization">
          <Select
            value={gcpSelection}
            disabled={!selectedInputId}
            onChange={(event) => setGcpSelection(event.currentTarget.value)}
          >
            <option value="latest">{latestGcpLabel(latestOptimization)}</option>
            {compatibleOptimizations.map((entry) => (
              <option key={entry.entityId} value={`revision:${entry.entityId}`}>
                {entry.optimization.operationId} · {entry.optimization.snapshotSha256.slice(0, 8)}
              </option>
            ))}
            {localMetric && <option value="none">None (unreferenced)</option>}
          </Select>
        </Field>
        {configuration.kind === 'depth' && (
          <>
            <Field label="Image resolution">
              <Select
                value={configuration.imageDownscale}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    imageDownscale: Number(event.currentTarget.value) as 1 | 2 | 4 | 8,
                  })
                }
              >
                <option value={1}>Ultra · original resolution</option>
                <option value={2}>High · 1/2 edge</option>
                <option value={4}>Medium · 1/4 edge</option>
                <option value={8}>Low · 1/8 edge</option>
              </Select>
            </Field>
            <Field label="Depth filter">
              <Select
                value={configuration.filter}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    filter: event.currentTarget.value as 'mild' | 'moderate' | 'aggressive',
                  })
                }
              >
                <option value="mild">Mild · fine detail</option>
                <option value="moderate">Moderate · recommended</option>
                <option value="aggressive">Aggressive · clean surfaces</option>
              </Select>
            </Field>
            <Toggle
              label="Reuse compatible depth maps"
              checked={configuration.reuseCompatibleMaps}
              onChange={(checked) =>
                setConfiguration({ ...configuration, reuseCompatibleMaps: checked })
              }
            />
          </>
        )}
        {configuration.kind === 'dense' && (
          <>
            <Field label="Image resolution">
              <Select
                value={configuration.imageDownscale}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    imageDownscale: Number(event.currentTarget.value) as 1 | 2 | 4 | 8,
                  })
                }
              >
                <option value={1}>Ultra · original resolution</option>
                <option value={2}>High · 1/2 edge</option>
                <option value={4}>Medium · 1/4 edge</option>
                <option value={8}>Low · 1/8 edge</option>
              </Select>
            </Field>
            <NumberField
              label="Minimum views"
              value={configuration.minimumViews}
              min={2}
              max={16}
              step={1}
              onChange={(value) => setConfiguration({ ...configuration, minimumViews: value })}
            />
            <Toggle
              label="Retain confidence attribute"
              checked={configuration.retainConfidence}
              onChange={(checked) =>
                setConfiguration({ ...configuration, retainConfidence: checked })
              }
            />
            <Toggle
              label="Calculate point colors"
              checked={configuration.calculateColors}
              onChange={(checked) =>
                setConfiguration({ ...configuration, calculateColors: checked })
              }
            />
          </>
        )}
        {configuration.kind === 'dem' && (
          <>
            <Field label="Surface">
              <Select
                value={configuration.surface}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    surface: event.currentTarget.value as 'dsm' | 'dtm',
                  })
                }
              >
                <option value="dsm">DSM · visible surface</option>
                <option value="dtm">DTM · conservative local ground envelope</option>
              </Select>
            </Field>
            <Resolution configuration={configuration} setConfiguration={setConfiguration} />
            <Field label="Streaming tiles">
              <span className={styles.readonly}>512 px · fixed COG/quadtree pyramid</span>
            </Field>
            <Toggle
              label="Interpolate small NoData gaps"
              checked={configuration.interpolateNodata}
              onChange={(checked) =>
                setConfiguration({ ...configuration, interpolateNodata: checked })
              }
            />
          </>
        )}
        {configuration.kind === 'ortho' && (
          <>
            <Resolution configuration={configuration} setConfiguration={setConfiguration} />
            <Field label="Blending">
              <Select
                value={configuration.blendMode}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    blendMode: event.currentTarget.value as 'mosaic' | 'average' | 'disabled',
                  })
                }
              >
                <option value="mosaic">Mosaic · best viewing geometry</option>
                <option value="average">Weighted average</option>
                <option value="disabled">First suitable camera</option>
              </Select>
            </Field>
            <Field label="Streaming tiles">
              <span className={styles.readonly}>512 px · fixed COG/quadtree pyramid</span>
            </Field>
            <Toggle
              label="Color and exposure correction"
              checked={configuration.colorCorrection}
              onChange={(checked) =>
                setConfiguration({ ...configuration, colorCorrection: checked })
              }
            />
            <Toggle
              label="Fill small holes"
              checked={configuration.fillHoles}
              onChange={(checked) => setConfiguration({ ...configuration, fillHoles: checked })}
            />
          </>
        )}
        {configuration.kind === 'mesh' && (
          <>
            <NumberField
              label="Target face count"
              value={configuration.targetFaceCount}
              min={10_000}
              max={500_000_000}
              step={10_000}
              onChange={(value) => setConfiguration({ ...configuration, targetFaceCount: value })}
            />
            <Toggle
              label="Interpolate holes"
              checked={configuration.interpolateHoles}
              onChange={(checked) =>
                setConfiguration({ ...configuration, interpolateHoles: checked })
              }
            />
            <Toggle
              label="Build texture"
              checked={configuration.buildTexture}
              onChange={(checked) => setConfiguration({ ...configuration, buildTexture: checked })}
            />
            <Field label="Texture detail budget">
              <Select
                value={configuration.textureSize}
                disabled={!configuration.buildTexture}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    textureSize: Number(event.currentTarget.value) as 2048 | 4096 | 8192 | 16384,
                  })
                }
              >
                {[2048, 4096, 8192, 16384].map((size) => (
                  <option key={size} value={size}>{`${size} × ${size}`}</option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {configuration.kind === 'splat' && (
          <>
            <div className={styles.warning}>
              Gaussian splats are a photorealistic representation, not measurable survey geometry.
              Measurements remain limited to depth, point clouds, DEMs, and meshes.
            </div>
            <Field label="Initialization">
              <span className={styles.readonly}>calibrated cameras + sparse tie points</span>
            </Field>
            <NumberField
              label="Iterations"
              value={configuration.iterations}
              min={1_000}
              max={200_000}
              step={1_000}
              onChange={(value) => setConfiguration({ ...configuration, iterations: value })}
            />
            <Field label="SH degree">
              <Select
                value={configuration.sphericalHarmonicsDegree}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    sphericalHarmonicsDegree: Number(event.currentTarget.value) as 0 | 1 | 2 | 3,
                  })
                }
              >
                <option value={0}>0 · diffuse color</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3 · highest view dependence</option>
              </Select>
            </Field>
            <NumberField
              label="Maximum splats"
              value={configuration.maximumSplats}
              min={100_000}
              max={100_000_000}
              step={100_000}
              onChange={(value) => setConfiguration({ ...configuration, maximumSplats: value })}
            />
            <NumberField
              label="Maximum training image edge"
              value={configuration.maximumResolution}
              min={256}
              max={32_768}
              step={128}
              onChange={(value) => setConfiguration({ ...configuration, maximumResolution: value })}
            />
            <Toggle
              label="Retain training checkpoints"
              checked={configuration.retainTrainingCheckpoints}
              onChange={(checked) =>
                setConfiguration({ ...configuration, retainTrainingCheckpoints: checked })
              }
            />
          </>
        )}
      </section>

      {!prerequisite.met && (
        <div className={styles.prerequisite} role="status">
          <span>{prerequisite.reason}</span>
          {prerequisite.actionFunctionId && prerequisite.actionLabel && (
            <button
              type="button"
              onClick={() => onActivatePrerequisite(prerequisite.actionFunctionId!)}
            >
              {prerequisite.actionLabel}
            </button>
          )}
        </div>
      )}
      {(resolveError || startError) && (
        <div className={styles.error} role="alert">
          {startError ?? resolveError}
        </div>
      )}
      <div className={styles.freeze} aria-busy={resolving}>
        <strong>This run will freeze</strong>
        {resolving ? (
          <span>Resolving exact input artifacts…</span>
        ) : resolvedInputs ? (
          <dl>
            <FreezeRow
              label="Alignment"
              name={resolvedInputs.alignment.name}
              hash={resolvedInputs.alignment.snapshotSha256}
            />
            {resolvedInputs.processingSet && (
              <FreezeRow
                label="Processing set"
                name={resolvedInputs.processingSet.name}
                hash={resolvedInputs.processingSet.membershipSha256}
              />
            )}
            <FreezeRow
              label="GCP revision"
              name={resolvedInputs.gcpOptimization?.operationId ?? 'None (unreferenced)'}
              {...(resolvedInputs.gcpOptimization
                ? { hash: resolvedInputs.gcpOptimization.snapshotSha256 }
                : {})}
            />
            {resolvedInputs.maskScopeSha256 && (
              <FreezeRow label="Mask scope" hash={resolvedInputs.maskScopeSha256} />
            )}
          </dl>
        ) : (
          <span>Select a published alignment to resolve this run.</span>
        )}
      </div>

      <button
        className={styles.action}
        type="button"
        disabled={
          busy ||
          !valid(configuration) ||
          !prerequisite.met ||
          resolving ||
          !resolvedInputs ||
          resolveError !== null
        }
        onClick={() =>
          onStart(
            configuration,
            gcpSelection === 'latest'
              ? (resolvedInputs?.gcpOptimization?.entityId ?? (localMetric ? null : undefined))
              : decodeGcpSelection(gcpSelection),
          )
        }
      >
        {busy ? 'Queueing…' : `Start ${title(operation)}`}
      </button>
    </div>
  );
}

function FreezeRow({
  label,
  name,
  hash,
}: {
  label: string;
  name?: string;
  hash?: ObjectHash;
}): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {name && <span>{name}</span>}
        {hash && <code title={hash}>{hash.slice(0, 8)}</code>}
      </dd>
    </div>
  );
}

function latestGcpLabel(entry: PublishedGcpOptimizationEntry | undefined): string {
  if (!entry) return 'Latest converged — none available';
  return `Latest converged — ${entry.optimization.operationId} · ${entry.optimization.snapshotSha256.slice(0, 8)}`;
}

function decodeGcpSelection(value: string): EntityId | null | undefined {
  if (value === 'latest') return undefined;
  if (value === 'none') return null;
  return value.startsWith('revision:') ? (value.slice('revision:'.length) as EntityId) : undefined;
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </Field>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className={styles.toggle}>
      <Checkbox checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span aria-hidden="true" />
      <strong>{label}</strong>
    </label>
  );
}

type RasterConfiguration = Extract<ProductRunConfiguration, { kind: 'dem' | 'ortho' }>;

function Resolution({
  configuration,
  setConfiguration,
}: {
  configuration: RasterConfiguration;
  setConfiguration: (configuration: ProductRunConfiguration) => void;
}): JSX.Element {
  return (
    <NumberField
      label="Resolution [m/px]"
      value={configuration.resolutionMetersPerPixel}
      min={0.001}
      max={100}
      step={0.001}
      onChange={(value) => setConfiguration({ ...configuration, resolutionMetersPerPixel: value })}
    />
  );
}

function valid(configuration: ProductRunConfiguration): boolean {
  if ('resolutionMetersPerPixel' in configuration) {
    return (
      Number.isFinite(configuration.resolutionMetersPerPixel) &&
      configuration.resolutionMetersPerPixel > 0
    );
  }
  if (configuration.kind === 'dense') return configuration.minimumViews >= 2;
  if (configuration.kind === 'mesh') return configuration.targetFaceCount >= 10_000;
  if (configuration.kind === 'splat') {
    return (
      configuration.iterations >= 1_000 &&
      configuration.maximumSplats >= 100_000 &&
      configuration.maximumResolution >= 256
    );
  }
  return true;
}

function title(operation: ProductOperation): string {
  if (operation === 'depth') return 'Depth Maps';
  if (operation === 'dense') return 'Dense Point Cloud';
  if (operation === 'dem') return 'DEM';
  if (operation === 'ortho') return 'Orthomosaic';
  if (operation === 'mesh') return 'Textured Mesh';
  return 'Gaussian Splat';
}
