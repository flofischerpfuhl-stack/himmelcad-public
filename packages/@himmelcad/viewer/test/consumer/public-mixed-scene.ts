import {
  KernelViewerSession,
  type GeometryObject,
  type HimmelcadViewerWasmLoader,
  type KernelCanonicalRenderAdmission,
  type KernelDecodeExecutor,
  type KernelViewerEntityHandle,
} from '../../src/kernel/index.js';

export interface PublicMixedSceneHostOptions {
  readonly canvas: HTMLCanvasElement;
  readonly wasmLoader: HimmelcadViewerWasmLoader;
  readonly decodeWasmModuleUrl?: string;
  readonly createDecodeExecutor?: () => KernelDecodeExecutor;
  readonly requestFrame?: () => void;
}

export interface PublicMixedSceneHost {
  readonly session: KernelViewerSession;
  readonly handles: readonly KernelViewerEntityHandle[];
}

/** One product-neutral scene shared unchanged by headless, browser and Electron hosts. */
export async function loadPublicMixedScene(
  options: PublicMixedSceneHostOptions,
): Promise<PublicMixedSceneHost> {
  const session = await KernelViewerSession.create({
    canvas: options.canvas,
    wasmLoader: options.wasmLoader,
    ...(options.decodeWasmModuleUrl ? { decodeWasmModuleUrl: options.decodeWasmModuleUrl } : {}),
    ...(options.createDecodeExecutor ? { createDecodeExecutor: options.createDecodeExecutor } : {}),
    ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
  });
  try {
    session.registerImageResource('image-resource', 1, 1, new Uint8Array([30, 90, 180, 255]));
    session.registerDepthResource('depth-resource', 1, 1, new Float32Array([12.5]));
    session.registerRasterBinaryResource('validity-resource', new Uint8Array([1]));
    session.registerMeshResource('mesh-resource', { positions: [0, 0, 0] });

    const handles = [
      ...session.loadCanonical([
        admission('public-point', 'hcad.point@1', {
          kind: 'point',
          position: { x: 500_000, y: 5_400_000, z: 100 },
        }),
        admission('public-plan-curve', 'hcad.curve@1', {
          kind: 'curve',
          curve: {
            kind: 'lineSegment',
            start: { x: 500_000, y: 5_400_000, z: null },
            end: { x: 500_020, y: 5_400_010, z: null },
          },
        }),
        admission('public-extension', 'vendor.public-fixture@1', {
          kind: 'extension',
          typeId: 'vendor.public-fixture@1',
          payload: '44'.repeat(32),
        }),
      ]),
      ...session.loadPreparedHierarchy({
        datasetId: 'public-prepared-splat',
        formatId: 'hcad-splat-tiles@1',
        manifestUri: 'memory://public/prepared-splat.json',
        manifestBytes: new TextEncoder().encode('{}'),
        admissions: [
          {
            ...admission('public-splat', 'hcad.gaussian-splat-cloud@1', {
              kind: 'gaussianSplatCloud',
              dataset: {
                formatId: 'hcad-splat-tiles@1',
                metadata: {
                  objectHash: '55'.repeat(32),
                  mediaType: 'application/json',
                  byteLength: 2,
                },
                elementCount: 1,
              },
            }),
            datasetId: 'public-prepared-splat',
          },
        ],
      }),
    ];
    return { session, handles };
  } catch (error) {
    session.dispose();
    throw error;
  }
}

function admission(
  entityId: string,
  typeId: string,
  resolvedGeometry: GeometryObject,
): KernelCanonicalRenderAdmission {
  const selected = {
    role: 'canonical' as const,
    geometryRef: '11'.repeat(32),
    authority: 'authoritative' as const,
    dependencyHash: null,
  };
  return {
    admission: {
      entity: {
        id: entityId,
        revision: 1,
        typeId,
        name: entityId,
        owner: null,
        layerIds: [],
        placement: null,
        representations: [selected],
        componentsRef: '01'.repeat(32),
        attributesRef: '02'.repeat(32),
        relationsRef: '03'.repeat(32),
        styleRef: null,
        schemaVersion: 1,
        versionHash: '22'.repeat(32),
      },
      selected,
      representationSlot: 'primary',
      expectedGeneration: null,
      resolvedGeometry,
    },
  };
}
