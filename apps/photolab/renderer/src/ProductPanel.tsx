import { Checkbox, Select } from '@himmelcad/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import styles from './ProductPanel.module.css';

export type ProductOperation = 'depth' | 'dense' | 'dem' | 'ortho' | 'mesh' | 'splat';

export type ProductRunConfiguration =
  | {
      kind: 'depth';
      imageDownscale: 1 | 2 | 4 | 8;
      filter: 'mild' | 'moderate' | 'aggressive';
      reuseCompatibleMaps: boolean;
    }
  | {
      kind: 'dense';
      imageDownscale: 1 | 2 | 4 | 8;
      minimumViews: number;
      retainConfidence: boolean;
      calculateColors: boolean;
    }
  | {
      kind: 'dem';
      surface: 'dsm' | 'dtm';
      resolutionMetersPerPixel: number;
      interpolateNodata: boolean;
      tileSizePixels: 512;
    }
  | {
      kind: 'ortho';
      resolutionMetersPerPixel: number;
      blendMode: 'mosaic' | 'average' | 'disabled';
      colorCorrection: boolean;
      fillHoles: boolean;
      tileSizePixels: 512;
    }
  | {
      kind: 'mesh';
      targetFaceCount: number;
      interpolateHoles: boolean;
      buildTexture: boolean;
      textureSize: 2048 | 4096 | 8192 | 16384;
    }
  | {
      kind: 'splat';
      initialization: 'sparseTiePoints';
      iterations: number;
      sphericalHarmonicsDegree: 0 | 1 | 2 | 3;
      maximumSplats: number;
      maximumResolution: number;
      retainTrainingCheckpoints: boolean;
    };

export interface ProductPanelProps {
  operation: ProductOperation;
  busy: boolean;
  inputs: readonly { id: string; label: string }[];
  selectedInputId: string;
  onInputChange: (id: string) => void;
  onStart: (configuration: ProductRunConfiguration) => void;
}

export function ProductPanel({
  operation,
  busy,
  inputs,
  selectedInputId,
  onInputChange,
  onStart,
}: ProductPanelProps): JSX.Element {
  const defaults = useMemo(() => defaultProductConfiguration(operation), [operation]);
  const [configuration, setConfiguration] = useState<ProductRunConfiguration>(defaults);
  useEffect(() => setConfiguration(defaults), [defaults]);
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
            {inputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.label}
              </option>
            ))}
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

      <button
        className={styles.action}
        type="button"
        disabled={busy || !valid(configuration)}
        onClick={() => onStart(configuration)}
      >
        {busy ? 'Queueing…' : `Start ${title(operation)}`}
      </button>
    </div>
  );
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
      <Checkbox
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
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

export function defaultProductConfiguration(operation: ProductOperation): ProductRunConfiguration {
  if (operation === 'depth') {
    return { kind: 'depth', imageDownscale: 2, filter: 'moderate', reuseCompatibleMaps: true };
  }
  if (operation === 'dense') {
    return {
      kind: 'dense',
      imageDownscale: 2,
      minimumViews: 3,
      retainConfidence: true,
      calculateColors: true,
    };
  }
  if (operation === 'dem') {
    return {
      kind: 'dem',
      surface: 'dsm',
      resolutionMetersPerPixel: 0.05,
      interpolateNodata: false,
      tileSizePixels: 512,
    };
  }
  if (operation === 'ortho') {
    return {
      kind: 'ortho',
      resolutionMetersPerPixel: 0.03,
      blendMode: 'mosaic',
      colorCorrection: true,
      fillHoles: false,
      tileSizePixels: 512,
    };
  }
  if (operation === 'mesh') {
    return {
      kind: 'mesh',
      targetFaceCount: 5_000_000,
      interpolateHoles: false,
      buildTexture: true,
      textureSize: 8192,
    };
  }
  return {
    kind: 'splat',
    initialization: 'sparseTiePoints',
    iterations: 30_000,
    sphericalHarmonicsDegree: 3,
    maximumSplats: 10_000_000,
    maximumResolution: 1_920,
    retainTrainingCheckpoints: true,
  };
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
