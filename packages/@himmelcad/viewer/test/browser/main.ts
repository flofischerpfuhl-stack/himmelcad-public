import { WgpuKernelViewer } from '../../src/kernel/WgpuKernelViewer';
import { KernelCanonicalDocument } from '../../src/kernel/KernelCanonicalDocument';
import { KernelCameraController } from '../../src/kernel/KernelCameraController';
import { localSectionClipVolume } from '../../src/kernel/KernelLocalSectionView';
import { KernelDecodeWorkerPool } from '../../src/kernel/KernelDecodeWorkerPool';
import { KernelClipCapCoordinator } from '../../src/kernel/KernelClipCapCoordinator';
import { decodeInputManifestHash } from '../../src/kernel/KernelStreamingDriver';
import { evaluateCanonicalSectionTopologyWith } from '../../src/kernel/KernelSectionTopologyEvaluation';
import type {
  AlignmentGeometry,
  AreaGeometry,
  GeometryRepresentationBindingRef,
  CanonicalResourceRef,
  HatchPatternResource,
  LineTypeResource,
  MaterialResource,
  MaterialTableResource,
  SectionTopologyPartitionManifest,
  Transform3d,
  TriangleMeshGeometry,
  TextureResource,
  CanonicalCommandTransaction,
} from '../../src/kernel/generated/index.js';
import type { KernelSectionTopologyPartitionLocation } from '../../src/kernel/KernelSectionTopologyEvaluation';
import type {
  HimmelcadViewerWasmModule,
  KernelAlignmentPreviewMutation,
  KernelBlockDefinition,
  KernelAuthoritativeSectionProduct,
  KernelCanonicalRenderAdmission,
  KernelCanonicalEntityMutation,
  KernelEvaluatedMeshAdmission,
  KernelEntityPresentationBatch,
  KernelPickCandidate,
  KernelPickMetadata,
  KernelPickResult,
  KernelRenderStyle,
  KernelResolvedHardwarePolicy,
  KernelResolvedAssetBundle,
  KernelResourceCost,
  KernelStreamingFramePlan,
  KernelStreamingPublish,
} from '../../src/kernel/WgpuKernelViewer';

declare global {
  interface Window {
    __HCAD_E2E__?: BrowserValidationState;
    __HCAD_APPLY_CLIP__?: () => { batchCount: number; materialSlots: readonly number[] };
    __HCAD_APPLY_REMOVE_CLIP__?: () => { batchCount: number; materialSlots: readonly number[] };
    __HCAD_CLEAR_CLIP__?: () => void;
    __HCAD_FOCUS_REAL__?: () => void;
    __HCAD_FOCUS_REAL_TILES__?: () => void;
    __HCAD_FOCUS_REAL_EXTERNAL__?: () => void;
    __HCAD_FOCUS_REAL_EXTERNAL_JSON__?: () => void;
    __HCAD_FOCUS_PREPARED_TEXTURED__?: () => void;
    __HCAD_FOCUS_ALIGNMENT_PREVIEW__?: () => void;
    __HCAD_FOCUS_LOCAL_PROFILE__?: () => LocalProfileViewValidation;
    __HCAD_EXIT_LOCAL_PROFILE__?: () => LocalProfileViewValidation;
    __HCAD_APPLY_LOCAL_PROFILE_DEPTH__?: () => LocalProfileDepthValidation;
    __HCAD_CLEAR_LOCAL_PROFILE_DEPTH__?: () => void;
    __HCAD_FOCUS_USER_VIEWPOINT__?: () => UserPerspectiveViewValidation;
    __HCAD_FOCUS_VERTICAL_EXAGGERATION__?: () => Promise<VerticalExaggerationValidation>;
    __HCAD_APPLY_VERTICAL_EXAGGERATION_CLIP__?: () => Promise<KernelPickResult>;
    __HCAD_CLEAR_VERTICAL_EXAGGERATION__?: () => void;
    __HCAD_FOCUS_STREAMED_EXAGGERATION__?: () => Promise<StreamedExaggerationValidation>;
    __HCAD_FOCUS_STREAMED_MOVE_PREVIEW__?: () => Promise<StreamedMovePreviewValidation>;
    __HCAD_CLEAR_STREAMED_EXAGGERATION__?: () => void;
    __HCAD_UPDATE_ALIGNMENT_PREVIEW__?: () => AlignmentPreviewBrowserValidation;
    __HCAD_REMOVE_ALIGNMENT_PREVIEW__?: () => boolean;
    __HCAD_RESET_CAMERA__?: () => void;
  }
}

interface BrowserValidationState {
  ready: boolean;
  phase: string;
  error: string | null;
  capabilities: unknown;
  hardwarePolicy: KernelResolvedHardwarePolicy | null;
  calibration: unknown;
  entityCount: number;
  proxyCount: number;
  generation: string;
  frameDurationsMs: number[];
  gpuFrameTiming: unknown;
  pickFrameTiming: { before: unknown; after: unknown } | null;
  pick: unknown;
  exactPointPick: KernelPickResult | null;
  originRebase: { generationStable: boolean; pick: unknown } | null;
  drapePick: KernelPickResult | null;
  drapeKnownPick: KernelPickResult | null;
  interpolationPick: KernelPickResult | null;
  extensionPick: KernelPickResult | null;
  tilesMetadata: unknown;
  gltfFeatureMetadata: unknown;
  atomicPublish: KernelStreamingPublish | null;
  crossProviderReplacement: {
    toMesh: KernelStreamingPublish;
    toPotree: KernelStreamingPublish;
  } | null;
  providerFixtures: ProviderFixtureValidation | null;
  realGlb: RealGlbValidation | null;
  realTiles: RealTilesValidation | null;
  realExternal: RealExternalValidation | null;
  realExternalJson: RealExternalJsonValidation | null;
  preparedTexturedMesh: PreparedTexturedMeshValidation | null;
  alignmentPreview: AlignmentPreviewBrowserValidation | null;
  localProfileView: LocalProfileViewValidation | null;
  realLegacyMetadata: RealLegacyMetadataValidation | null;
  syntheticPointMetadata: {
    readonly pick: KernelPickResult;
    readonly metadata: KernelPickMetadata;
  } | null;
  streamDecodeRebuild: {
    before: { workerArtifactIngests: number; mainThreadProviderDecodes: number };
    after: { workerArtifactIngests: number; mainThreadProviderDecodes: number };
  } | null;
  decodeWorker: {
    workerContext: boolean;
    eventLoopTickedBeforeCompletion: boolean;
    artifactBytes: number;
    artifactMagic: string;
    inputBytes: number;
    ingestMs: number;
    diagnostics: ReturnType<KernelDecodeWorkerPool['diagnostics']>;
  } | null;
  authoritativeOpenTin: {
    readonly segments: number;
    readonly regions: number;
    readonly sourceParts: number;
    readonly projectBounds: {
      readonly minimum: { readonly x: number; readonly y: number; readonly z: number };
      readonly maximum: { readonly x: number; readonly y: number; readonly z: number };
    };
  } | null;
  authoritativeClipCap: {
    readonly compiled: boolean;
    readonly clippedVolumeId: string;
    readonly planeIndex: number;
  } | null;
  presentationBindings: {
    readonly hatchAfterLiveStyle: readonly KernelEntityPresentationBatch[];
    readonly none: readonly KernelEntityPresentationBatch[];
    readonly strokeLineType: readonly KernelEntityPresentationBatch[];
    readonly strokeNone: readonly KernelEntityPresentationBatch[];
    readonly textureOverride: readonly KernelEntityPresentationBatch[];
    readonly textureRestored: readonly KernelEntityPresentationBatch[];
    readonly canonicalMaterials: readonly KernelEntityPresentationBatch[];
    readonly materialTextureResidency: {
      readonly allocations: number;
      readonly retainedAllocations: number;
      readonly owners: number;
      readonly stagedOwners: number;
      readonly gpuTextureBytes: number;
      readonly decodedSources: number;
      readonly factoryCalls: number;
    };
    readonly invalidAreaTextureRejectedAtomically: boolean;
    readonly invalidStrokeRejectedAtomically: boolean;
    readonly decodeCountersStable: boolean;
    readonly proxyIdentityStable: boolean;
  } | null;
  canonicalDocument: {
    readonly generation: number;
    readonly journalEntries: number;
    readonly restoredName: string;
    readonly replayedName: string;
  } | null;
}

interface LocalProfileViewValidation {
  readonly projection: 'orthographic';
  readonly target: Readonly<{ x: number; y: number; z: number }>;
  readonly centerCoordinate: Readonly<{ x: number; y: number; z: number }>;
  readonly cornerCoordinate: Readonly<{ x: number; y: number; z: number }>;
  readonly restoredExact: boolean | null;
}

interface LocalProfileDepthValidation {
  readonly planeCount: number;
  readonly previewCap: boolean;
  readonly previewBatchCount: number;
}

interface UserPerspectiveViewValidation {
  readonly projection: 'perspective';
  readonly eyeError: number;
  readonly targetExact: boolean;
  readonly verticalFovRadians: number;
}

interface VerticalExaggerationValidation {
  readonly factor: number;
  readonly datum: number;
  readonly sourceTarget: Readonly<{ x: number; y: number; z: number }>;
  readonly presentedTarget: Readonly<{ x: number; y: number; z: number }>;
  readonly pick: KernelPickResult;
}

interface StreamedExaggerationValidation {
  readonly factor: number;
  readonly datum: number;
  readonly sourcePoint: Readonly<{ x: number; y: number; z: number }>;
  readonly presentedPoint: Readonly<{ x: number; y: number; z: number }>;
  readonly identityPlan: KernelStreamingFramePlan;
  readonly exaggeratedPlan: KernelStreamingFramePlan;
  readonly pick: KernelPickResult;
  readonly decodeCountersStable: boolean;
}

interface StreamedMovePreviewValidation {
  readonly sourcePoint: Readonly<{ x: number; y: number; z: number }>;
  readonly targetPoint: Readonly<{ x: number; y: number; z: number }>;
  readonly translation: Readonly<{ x: number; y: number; z: number }>;
  readonly primaryPlan: KernelStreamingFramePlan;
  readonly targetTiles: readonly { readonly datasetId: string; readonly tileId: string }[];
  readonly staleRejectedAtomically: boolean;
  readonly targetPlan: KernelStreamingFramePlan;
  readonly targetPick: KernelPickResult;
  readonly committedRevision: number;
  readonly undoRevision: number;
  readonly redoRevision: number;
  readonly restoredRevision: number;
  readonly generations: readonly number[];
  readonly previewConsumed: boolean;
  readonly decodeCountersStable: boolean;
  readonly proxyCountStable: boolean;
  readonly journalEntries: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface RealGlbValidation {
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
  pick: KernelPickResult;
}

interface RealTilesValidation {
  rootPublish: KernelStreamingPublish;
  instancePublish: KernelStreamingPublish;
  rootTarget: { x: number; y: number; z: number };
  instanceTarget: { x: number; y: number; z: number };
  rootPick: KernelPickResult;
  instancePick: KernelPickResult;
  instanceMetadata: unknown;
}

interface RealExternalValidation {
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
  dependencyCount: number;
  bundleBytes: number;
  sharedGpuModels: { allocations: number; owners: number; gpuBufferBytes: number };
  sharedGpuTextures: {
    allocations: number;
    retainedAllocations: number;
    owners: number;
    stagedOwners: number;
    gpuTextureBytes: number;
    decodedSources: number;
    factoryCalls: number;
  };
  pick: KernelPickResult;
}

interface RealLegacyMetadataValidation {
  hierarchyPublish: KernelStreamingPublish;
  pointPublish: KernelStreamingPublish;
  hierarchyPick: KernelPickResult;
  pointPick: KernelPickResult;
  hierarchyMetadata: KernelPickMetadata;
  pointMetadata: KernelPickMetadata;
}

interface RealExternalJsonValidation {
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
  dependencies: readonly { ownerUri: string; sourceUri: string; kind: string }[];
  primaryBytes: number;
  bundleBytes: number;
  pick: KernelPickResult;
  structuralMetadata: Readonly<Record<string, unknown>> | null;
}

interface PreparedTexturedMeshValidation {
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
  dependencies: readonly { ownerUri: string; sourceUri: string; kind: string }[];
  primaryBytes: number;
  bundleBytes: number;
  pick: KernelPickResult;
}

interface AlignmentPreviewBrowserValidation {
  readonly initial: KernelAlignmentPreviewMutation;
  readonly updated: KernelAlignmentPreviewMutation | null;
  readonly staleRejected: boolean;
  readonly staleGenerationStable: boolean;
}

interface ProviderFixtureValidation {
  potree: {
    stage: KernelResourceCost;
    publish: KernelStreamingPublish;
    expectedWorldPosition: { x: number; y: number; z: number };
    expectedProviderPosition: { x: number; y: number; z: number };
    pick: KernelPickResult;
    metadata: KernelPickMetadata;
  };
  raster: {
    stage: KernelResourceCost;
    publish: KernelStreamingPublish;
    expectedLowSample: { x: number; y: number; z: number };
    expectedHighSample: { x: number; y: number; z: number };
    lowPick: KernelPickResult;
    highPick: KernelPickResult;
    noDataPick: KernelPickResult;
  };
  gaussian: {
    stage: KernelResourceCost;
    publish: KernelStreamingPublish;
    expectedMean: { x: number; y: number; z: number };
    expectedCoverage: { x: number; y: number; z: number };
    meanPick: KernelPickResult;
    coveragePick: KernelPickResult;
    positiveSideOrder: readonly (readonly number[])[];
    negativeSideOrder: readonly (readonly number[])[];
  };
}

const BASE = [6_378_137.125, 5_400_000.25, 512.75] as const;
const FONT_HASH = 'f'.repeat(64);
const DIMENSION_STYLE_HASH = 'd'.repeat(64);
let BLOCK_HASH = 'b'.repeat(64);
const PANORAMA_IMAGE_HASH = 'a'.repeat(64);
const PANORAMA_DEPTH_HASH = 'e'.repeat(64);
const PANORAMA_VALIDITY_HASH = 'a2c70538651a7e9296b097e8c3dfc1b195a945802ffe45aa471868fba6f1042e';
const PANORAMA_CONFIDENCE_HASH = 'c05617ac39c882500d10674a36f1795b657df7606db0fdce146f93ea4a288b38';
const PANORAMA_CONNECTIVITY_HASH = 'ce8bee525d6736e9825261b19a9b51719f9dc4bb728e95cf7067a2142b03b362';
let EVALUATED_MESH_HASH = 'c'.repeat(64);
let EVALUATED_TOPOLOGY_HASH = 'c'.repeat(64);
let MATERIAL_TABLE_HASH = '7'.repeat(64);
let MATERIAL_TEXTURE_RESIDENCY: ReturnType<WgpuKernelViewer['gpuTextureCacheStats']> | null = null;
const ORTHO_IMAGE_HASH = '1'.repeat(64);
const ORTHO_DEPTH_HASH = '2'.repeat(64);
const POINT_VERSION_HASH = '3'.repeat(64);
const DIMENSION_VERSION_HASH = '4'.repeat(64);
let SECTION_PRODUCT_HASH = '5'.repeat(64);
let diagonalHatchRef: CanonicalResourceRef;
let crossHatchRef: CanonicalResourceRef;
const BOOLEAN_SOLID_VERSION_HASH = '6'.repeat(64);
const AREA_BOUNDARY_HASH = '6'.repeat(64);
const DRAPE_SUPPORT_HASH = 'ab'.repeat(32);
const AREA_INTERPOLATION_PARAMETERS_HASH = 'cd'.repeat(32);
let AREA_INTERPOLATION_RESULT_HASH = 'ef'.repeat(32);
const EXTENSION_PAYLOAD_HASH = '12'.repeat(32);
const DRAPED_UNKNOWN_VERTEX = {
  x: BASE[0] + 36,
  y: BASE[1] - 3,
  z: BASE[2] + 6.6,
} as const;
const DRAPED_KNOWN_VERTEX = {
  x: BASE[0] + 24,
  y: BASE[1] - 3,
  z: BASE[2] + 6,
} as const;
const INTERPOLATED_VERTEX = {
  x: BASE[0] - 2,
  y: BASE[1] - 8,
  z: BASE[2] + 0.75,
} as const;
const EXTENSION_TOP = {
  x: BASE[0] - 25,
  y: BASE[1] + 10,
  z: BASE[2] + 5,
} as const;
const IDENTITY: Transform3d = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function liveAlignmentGeometry(middleOuterOffset: number): AlignmentGeometry {
  return {
    horizontal: {
      kind: 'lineSegment',
      start: { x: BASE[0] - 15, y: BASE[1] + 15, z: null },
      end: { x: BASE[0] + 15, y: BASE[1] + 15, z: null },
    },
    vertical: [
      {
        kind: 'grade',
        startStation: 1_000,
        startElevation: BASE[2] + 2,
        grade: 0,
        length: 30,
      },
    ],
    stationOrigin: 1_000,
    widthBands: [
      {
        id: 'carriageway',
        innerOffset: {
          samples: [
            { station: 1_000, value: 0 },
            { station: 1_030, value: 0 },
          ],
        },
        outerOffset: {
          samples: [
            { station: 1_000, value: 5 },
            { station: 1_010, value: middleOuterOffset },
            { station: 1_020, value: middleOuterOffset },
            { station: 1_030, value: 5 },
          ],
        },
      },
    ],
    crossfallBands: [],
    slopeRules: [],
  };
}

let streamingWorkerPool: KernelDecodeWorkerPool | null = null;
const admittedGenerations = new Map<string, number>();
const canonicalVersionByLegacyVersion = new Map<string, string>();
const streamDatasetByEntity = new Map<string, string>();
let preparedOpenSurfaceTopology: {
  readonly admission: KernelEvaluatedMeshAdmission;
  readonly locations: readonly KernelSectionTopologyPartitionLocation[];
  readonly resources: ReadonlyMap<string, Uint8Array>;
} | null = null;
let preparedClosedMeshTopology: {
  readonly locations: readonly KernelSectionTopologyPartitionLocation[];
  readonly resources: ReadonlyMap<string, Uint8Array>;
} | null = null;

const state: BrowserValidationState = {
  ready: false,
  phase: 'boot',
  error: null,
  capabilities: null,
  hardwarePolicy: null,
  calibration: null,
  entityCount: 0,
  proxyCount: 0,
  generation: '0',
  frameDurationsMs: [],
  gpuFrameTiming: null,
  pickFrameTiming: null,
  pick: null,
  exactPointPick: null,
  originRebase: null,
  drapePick: null,
  drapeKnownPick: null,
  interpolationPick: null,
  extensionPick: null,
  tilesMetadata: null,
  gltfFeatureMetadata: null,
  atomicPublish: null,
  crossProviderReplacement: null,
  providerFixtures: null,
  realGlb: null,
  realTiles: null,
  realExternal: null,
  realExternalJson: null,
  preparedTexturedMesh: null,
  alignmentPreview: null,
  localProfileView: null,
  realLegacyMetadata: null,
  syntheticPointMetadata: null,
  streamDecodeRebuild: null,
  decodeWorker: null,
  authoritativeOpenTin: null,
  authoritativeClipCap: null,
  presentationBindings: null,
  canonicalDocument: null,
};

function featureMetadataGlb(): Uint8Array {
  const binary = new Uint8Array(208);
  const view = new DataView(binary.buffer);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  positions.forEach((value, index) => view.setFloat32(index * 4, value, true));
  [0, 1, 2].forEach((value, index) => view.setUint16(36 + index * 2, value, true));
  binary.set([1, 0, 0], 44);
  view.setFloat32(48, 12.5, true);
  view.setFloat32(52, 27.25, true);
  binary.set(new TextEncoder().encode('westtower'), 56);
  [0, 4, 9].forEach((value, index) => view.setUint32(72 + index * 4, value, true));
  [0.75, 0.5, 0.75, 0.5, 0.75, 0.5].forEach((value, index) =>
    view.setFloat32(88 + index * 4, value, true),
  );
  binary.set(
    [
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0,
      0, 0, 244, 34, 127, 138, 0, 0, 0, 15, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 248, 207, 8,
      196, 0, 6, 7, 2, 0, 7, 123, 36, 247, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ],
    112,
  );
  [10, 20, 30].forEach((value, index) => view.setFloat32(184 + index * 4, value, true));
  [0, 1, 1].forEach((value, index) => view.setUint16(200 + index * 2, value, true));
  const document = {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_mesh_features', 'EXT_structural_metadata'],
    extensions: {
      EXT_structural_metadata: {
        schema: {
          id: 'browser-feature-test',
          enums: {
            surfaceClass: {
              valueType: 'UINT16',
              values: [
                { name: 'ground', value: 0 },
                { name: 'roof', value: 1 },
              ],
            },
          },
          classes: {
            building: {
              properties: {
                height: { type: 'SCALAR', componentType: 'FLOAT32' },
                name: { type: 'STRING' },
                temperature: { type: 'SCALAR', componentType: 'FLOAT32' },
                classification: { type: 'ENUM', enumType: 'surfaceClass' },
                surfaceCode: { type: 'SCALAR', componentType: 'UINT8' },
                flags: { type: 'BOOLEAN', array: true, count: 2 },
              },
            },
          },
        },
        propertyTables: [
          {
            class: 'building',
            count: 2,
            properties: {
              height: { values: 3 },
              name: { values: 4, stringOffsets: 5 },
            },
          },
        ],
        propertyAttributes: [
          {
            class: 'building',
            properties: {
              temperature: { attribute: '_TEMPERATURE', scale: 2, offset: 1 },
              classification: { attribute: '_CLASSIFICATION' },
            },
          },
        ],
        propertyTextures: [
          {
            class: 'building',
            properties: {
              surfaceCode: { index: 0, texCoord: 0, channels: [0], scale: 2, offset: 1 },
              flags: { index: 0, texCoord: 0, channels: [3] },
            },
          },
        ],
      },
    },
    buffers: [{ byteLength: 208 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
      { buffer: 0, byteOffset: 44, byteLength: 3, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 8 },
      { buffer: 0, byteOffset: 56, byteLength: 9 },
      { buffer: 0, byteOffset: 72, byteLength: 12 },
      { buffer: 0, byteOffset: 88, byteLength: 24, target: 34962 },
      { buffer: 0, byteOffset: 112, byteLength: 72 },
      { buffer: 0, byteOffset: 184, byteLength: 12, target: 34962 },
      { buffer: 0, byteOffset: 200, byteLength: 6, target: 34962 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5121, count: 3, type: 'SCALAR' },
      { bufferView: 6, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 8, componentType: 5126, count: 3, type: 'SCALAR' },
      { bufferView: 9, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 7, mimeType: 'image/png' }],
    textures: [{ sampler: 0, source: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: 0,
              TEXCOORD_0: 3,
              _FEATURE_ID_0: 2,
              _TEMPERATURE: 4,
              _CLASSIFICATION: 5,
            },
            indices: 1,
            mode: 4,
            extensions: {
              EXT_mesh_features: {
                featureIds: [
                  {
                    featureCount: 2,
                    label: 'buildingId',
                    attribute: 0,
                    propertyTable: 0,
                  },
                  {
                    featureCount: 2,
                    label: 'textureBuildingId',
                    texture: { index: 0, texCoord: 0, channels: [0] },
                    propertyTable: 0,
                  },
                ],
              },
              EXT_structural_metadata: { propertyAttributes: [0], propertyTextures: [0] },
            },
          },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(encoded.byteLength / 4) * 4;
  const totalLength = 12 + 8 + jsonLength + 8 + binary.byteLength;
  const output = new Uint8Array(totalLength);
  const header = new DataView(output.buffer);
  output.set(new TextEncoder().encode('glTF'), 0);
  header.setUint32(4, 2, true);
  header.setUint32(8, totalLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(encoded, 20);
  const binaryHeader = 20 + jsonLength;
  header.setUint32(binaryHeader, binary.byteLength, true);
  header.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

function syntheticBatchPointPnts(): Uint8Array {
  const featureJson = Array.from(
    jsonBytes({
      POINTS_LENGTH: 1,
      POSITION: { byteOffset: 0 },
      BATCH_ID: { byteOffset: 12, componentType: 'UNSIGNED_BYTE' },
      BATCH_LENGTH: 1,
    }),
  );
  while ((28 + featureJson.length) % 8 !== 0) featureJson.push(0x20);
  const featureBinary = new Array<number>(13).fill(0);
  while ((28 + featureJson.length + featureBinary.length) % 8 !== 0) featureBinary.push(0);
  const batchJson = Array.from(jsonBytes({ name: ['synthetic-point'] }));
  while ((28 + featureJson.length + featureBinary.length + batchJson.length) % 8 !== 0) {
    batchJson.push(0x20);
  }
  const total = 28 + featureJson.length + featureBinary.length + batchJson.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('pnts'), 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, featureJson.length, true);
  view.setUint32(16, featureBinary.length, true);
  view.setUint32(20, batchJson.length, true);
  view.setUint32(24, 0, true);
  bytes.set(featureJson, 28);
  bytes.set(featureBinary, 28 + featureJson.length);
  bytes.set(batchJson, 28 + featureJson.length + featureBinary.length);
  return bytes;
}
window.__HCAD_E2E__ = state;

function style(
  baseColor: readonly [number, number, number, number],
  opacity = 1,
  colorMode: Readonly<Record<string, unknown>> = { kind: 'uniform' },
): KernelRenderStyle {
  return {
    baseColor,
    opacity,
    verticalExaggeration: 1,
    colorMode,
    fill: { kind: 'color' },
    stroke: {
      mode: { kind: 'color' },
      color: { kind: 'inherit' },
      width: { kind: 'source' },
      cap: 'butt',
      join: 'miter',
      miterLimit: 4,
    },
  };
}

function hatchFill(
  resource: CanonicalResourceRef,
  lineWidth: number,
  color: readonly [number, number, number, number],
): KernelRenderStyle['fill'] {
  return {
    kind: 'hatch',
    resource,
    origin: { x: BASE[0], y: BASE[1], z: BASE[2] },
    axisU: { x: 1, y: 0, z: 0 },
    axisV: { x: 0, y: 1, z: 0 },
    lineWidth,
    color,
  };
}

function evaluatedMeshAdmission(): KernelEvaluatedMeshAdmission {
  return {
    meshResourceRef: EVALUATED_MESH_HASH,
    providerId: 'hcad.test-brep-tessellator',
    providerVersion: '1.0.0',
    parametersRef: '103626d1a0d8cbc819f677b6e11f5a4f655998db28a2536ca4579cb041c89256',
    parts: [{ partId: 'body-0', topologyHash: EVALUATED_TOPOLOGY_HASH }],
    materialKeys: { 0: 'material:default' },
    closedManifold: true,
  };
}

function evaluatedClosedMesh(): TriangleMeshGeometry {
  return {
    storage: {
      kind: 'inline',
      positions: [
        { x: -3, y: -2, z: 0 },
        { x: 3, y: -2, z: 0 },
        { x: 3, y: 2, z: 0 },
        { x: -3, y: 2, z: 0 },
        { x: -3, y: -2, z: 5 },
        { x: 3, y: -2, z: 5 },
        { x: 3, y: 2, z: 5 },
        { x: -3, y: 2, z: 5 },
      ],
      indices: [
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
        0, 4, 3, 4, 7,
      ],
      normals: null,
      textureCoordinates: null,
    },
    closedManifold: true,
    materials: null,
    triangleMaterialSlots: null,
  };
}

async function prepareEvaluatedClosedMeshTopology(
  viewer: WgpuKernelViewer,
  mesh: TriangleMeshGeometry,
): Promise<void> {
  if (mesh.storage.kind !== 'inline') throw new Error('closed topology fixture must be inline');
  const positionBytes = float64LittleEndian(
    mesh.storage.positions.flatMap((position) => [position.x, position.y, position.z]),
  );
  const indexBytes = uint32LittleEndian(mesh.storage.indices);
  const materialSlotBytes = uint32LittleEndian(
    new Array<number>(mesh.storage.indices.length / 3).fill(0),
  );
  const manifest: SectionTopologyPartitionManifest = {
    schemaVersion: 1,
    origin: [0, 0, 0],
    positions: {
      objectHash: await sha256Bytes(positionBytes),
      mediaType: 'hcad.positions-f64le-xyz@1',
      byteLength: positionBytes.byteLength,
    },
    positionComponentType: 'float64',
    vertexCount: mesh.storage.positions.length,
    indices: {
      objectHash: await sha256Bytes(indexBytes),
      mediaType: 'hcad.indices-u32le@1',
      byteLength: indexBytes.byteLength,
    },
    indexComponentType: 'uint32',
    indexCount: mesh.storage.indices.length,
    materialSlots: {
      objectHash: await sha256Bytes(materialSlotBytes),
      mediaType: 'hcad.material-slots-u32le@1',
      byteLength: materialSlotBytes.byteLength,
    },
  };
  EVALUATED_TOPOLOGY_HASH = viewer.sectionTopologyPartitionContentHash(manifest);
  const manifestUri = 'memory:///closed-evaluated/body-0.section.json';
  const positionUri = 'memory:///closed-evaluated/body-0.positions.f64';
  const indexUri = 'memory:///closed-evaluated/body-0.indices.u32';
  const materialSlotUri = 'memory:///closed-evaluated/body-0.materials.u32';
  preparedClosedMeshTopology = {
    locations: [{ partId: 'body-0', manifestUri, positionUri, indexUri, materialSlotUri }],
    resources: new Map([
      [manifestUri, jsonBytes(manifest)],
      [positionUri, positionBytes],
      [indexUri, indexBytes],
      [materialSlotUri, materialSlotBytes],
    ]),
  };
}

function requiredClosedMeshTopology(): NonNullable<typeof preparedClosedMeshTopology> {
  if (preparedClosedMeshTopology === null) {
    throw new Error('closed evaluated topology was not prepared');
  }
  return preparedClosedMeshTopology;
}

function openSurfaceMesh(): TriangleMeshGeometry {
  return {
    closedManifold: false,
    triangleMaterialSlots: null,
    materials: null,
    storage: {
      kind: 'inline',
      positions: [
        { x: -3, y: 4, z: 0 },
        { x: 5, y: 4, z: 1 },
        { x: 5, y: 12, z: 6 },
        { x: -3, y: 12, z: 2 },
      ],
      indices: [0, 1, 2, 0, 2, 3],
      normals: null,
      textureCoordinates: null,
    },
  };
}

async function prepareOpenSurfaceTopology(viewer: WgpuKernelViewer): Promise<void> {
  const mesh = openSurfaceMesh();
  const meshResourceRef = viewer.geometryObjectContentHash({ kind: 'surface3d', mesh });
  viewer.registerMeshResource(meshResourceRef, mesh);
  const resources = new Map<string, Uint8Array>();
  const parts: KernelEvaluatedMeshAdmission['parts'][number][] = [];
  const locations: KernelSectionTopologyPartitionLocation[] = [];
  const triangles = [
    [-3, 4, 0, 5, 4, 1, 5, 12, 6],
    [-3, 4, 0, 5, 12, 6, -3, 12, 2],
  ] as const;
  for (let index = 0; index < triangles.length; index += 1) {
    const partId = `part-${String(index)}`;
    const positionBytes = float32LittleEndian(triangles[index]!);
    const indexBytes = uint32LittleEndian([0, 1, 2]);
    const manifest: SectionTopologyPartitionManifest = {
      schemaVersion: 1,
      // Authoritative topology stays in representation-local coordinates;
      // CanonicalEntity.placement maps each partition into project world.
      origin: [0, 0, 0],
      positions: {
        objectHash: await sha256Bytes(positionBytes),
        mediaType: 'hcad.positions-f32le-xyz@1',
        byteLength: positionBytes.byteLength,
      },
      positionComponentType: 'float32',
      vertexCount: 3,
      indices: {
        objectHash: await sha256Bytes(indexBytes),
        mediaType: 'hcad.indices-u32le@1',
        byteLength: indexBytes.byteLength,
      },
      indexComponentType: 'uint32',
      indexCount: 3,
      materialSlots: null,
    };
    const manifestBytes = jsonBytes(manifest);
    const topologyHash = viewer.sectionTopologyPartitionContentHash(manifest);
    const triangle = triangles[index]!;
    const xs = [triangle[0], triangle[3], triangle[6]];
    const ys = [triangle[1], triangle[4], triangle[7]];
    const zs = [triangle[2], triangle[5], triangle[8]];
    const manifestUri = `memory:///open-tin/${partId}.section.json`;
    const positionUri = `memory:///open-tin/${partId}.positions.f32`;
    const indexUri = `memory:///open-tin/${partId}.indices.u32`;
    resources.set(manifestUri, manifestBytes);
    resources.set(positionUri, positionBytes);
    resources.set(indexUri, indexBytes);
    parts.push({
      partId,
      topologyHash,
      bounds: {
        minimum: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
        maximum: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
      },
    });
    locations.push({ partId, manifestUri, positionUri, indexUri });
  }
  preparedOpenSurfaceTopology = {
    admission: {
      meshResourceRef,
      providerId: 'hcad.browser-civil-tin',
      providerVersion: '1.0.0',
      parametersRef: await sha256Bytes(jsonBytes({ schemaVersion: 1, purpose: 'browser-gate' })),
      parts,
      materialKeys: {},
      closedManifold: false,
    },
    locations,
    resources,
  };
}

function requiredOpenSurfaceTopology(): NonNullable<typeof preparedOpenSurfaceTopology> {
  if (preparedOpenSurfaceTopology === null) throw new Error('open TIN topology was not prepared');
  return preparedOpenSurfaceTopology;
}

function float32LittleEndian(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function float64LittleEndian(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return bytes;
}

function uint32LittleEndian(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function placement(x = 0, y = 0, z = 0): readonly number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, BASE[0] + x, BASE[1] + y, BASE[2] + z, 1];
}

function relativePlacement(x = 0, y = 0, z = 0): readonly number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function point(x: number, y: number, z: number | null): { x: number; y: number; z: number | null } {
  return { x, y, z };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', exactArrayBuffer(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function replaceLegacyVersionRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceLegacyVersionRefs);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        key === 'expectedVersion' && typeof nested === 'string'
          ? (canonicalVersionByLegacyVersion.get(nested) ?? nested)
          : replaceLegacyVersionRefs(nested),
      ]),
    );
  }
  return value;
}

interface LegacyEntityRequest {
  readonly entityId: string;
  readonly proxyId?: string;
  readonly revision?: number;
  readonly versionHash?: string;
  readonly geometry: Record<string, unknown>;
  readonly placement?: readonly number[];
  readonly style?: KernelRenderStyle;
  readonly unresolvedHeightElevation?: number;
  readonly chordTolerance?: number;
  readonly maximumCurveSegments?: number;
  readonly lineWidth?: number;
  readonly planeExtent?: number;
  readonly fillAreas?: boolean;
  readonly exaggerationDatum?: number;
  readonly evaluatedMesh?: KernelEvaluatedMeshAdmission;
  readonly areaInterpolationRef?: string;
}

function canonicalTypeIdForGeometry(
  geometry: Readonly<{ kind?: string; typeId?: string }>,
): string {
  if (geometry.kind === 'extension' && geometry.typeId !== undefined) return geometry.typeId;
  const typeId = {
    point: 'hcad.point@1',
    curve: 'hcad.curve@1',
    area: 'hcad.area@1',
    plane: 'hcad.plane@1',
    elevationSurface: 'hcad.elevation-surface@1',
    surface3d: 'hcad.surface-3d@1',
    rasterImage: 'hcad.raster-image@1',
    pointCloud: 'hcad.point-cloud@1',
    gaussianSplatCloud: 'hcad.gaussian-splat-cloud@1',
    panorama: 'hcad.panorama@1',
    solid: 'hcad.object-3d@1',
    alignment: 'hcad.alignment@1',
    block: 'hcad.block@1',
    text: 'hcad.text@1',
    label: 'hcad.label@1',
    dimension: 'hcad.dimension@1',
  }[geometry.kind ?? ''];
  if (typeId === undefined) {
    throw new Error(`browser entity zoo has no canonical built-in for ${String(geometry.kind)}`);
  }
  return typeId;
}

async function canonicalizeLegacyRequest(
  viewer: WgpuKernelViewer,
  request: LegacyEntityRequest,
  datasetId?: string,
): Promise<KernelCanonicalRenderAdmission> {
  const geometry = replaceLegacyVersionRefs(request.geometry) as never;
  const geometryRef = viewer.geometryObjectContentHash(geometry);
  const selected = {
    role: 'canonical' as const,
    geometryRef,
    authority: 'authoritative' as const,
    dependencyHash: null,
  };
  const entityWithoutVersion = {
    id: request.entityId,
    revision: request.revision ?? 1,
    typeId: canonicalTypeIdForGeometry(geometry as { kind?: string; typeId?: string }),
    name: request.entityId,
    owner: null,
    layerIds: [],
    placement: (request.placement ?? null) as Transform3d | null,
    representations: [selected],
    componentsRef: '01'.repeat(32),
    attributesRef: '02'.repeat(32),
    relationsRef: '03'.repeat(32),
    styleRef: null,
    schemaVersion: 1,
  };
  const versionHash = viewer.canonicalEntityVersionHash({
    ...entityWithoutVersion,
    versionHash: '00'.repeat(32),
  });
  if (request.versionHash !== undefined) {
    canonicalVersionByLegacyVersion.set(request.versionHash, versionHash);
  }
  return {
    admission: {
      entity: { ...entityWithoutVersion, versionHash },
      selected,
      representationSlot: 'primary',
      expectedGeneration: admittedGenerations.get(request.entityId) ?? null,
      resolvedGeometry: geometry,
    },
    ...(datasetId === undefined ? {} : { datasetId }),
    ...(request.style === undefined ? {} : { style: request.style }),
    ...(request.unresolvedHeightElevation === undefined
      ? {}
      : { unresolvedHeightElevation: request.unresolvedHeightElevation }),
    ...(request.chordTolerance === undefined ? {} : { chordTolerance: request.chordTolerance }),
    ...(request.maximumCurveSegments === undefined
      ? {}
      : { maximumCurveSegments: request.maximumCurveSegments }),
    ...(request.lineWidth === undefined ? {} : { lineWidth: request.lineWidth }),
    ...(request.planeExtent === undefined ? {} : { planeExtent: request.planeExtent }),
    ...(request.fillAreas === undefined ? {} : { fillAreas: request.fillAreas }),
    ...(request.exaggerationDatum === undefined
      ? {}
      : { exaggerationDatum: request.exaggerationDatum }),
    ...(request.evaluatedMesh === undefined ? {} : { evaluatedMesh: request.evaluatedMesh }),
    ...(request.areaInterpolationRef === undefined
      ? {}
      : { areaInterpolationRef: request.areaInterpolationRef }),
  };
}

async function publishLegacyRequests(
  viewer: WgpuKernelViewer,
  requests: readonly LegacyEntityRequest[],
): Promise<KernelCanonicalEntityMutation> {
  const admissions: KernelCanonicalRenderAdmission[] = [];
  for (const request of requests) admissions.push(await canonicalizeLegacyRequest(viewer, request));
  const mutation = viewer.publishCanonicalRepresentations(admissions);
  for (const binding of mutation.bindings) {
    admittedGenerations.set(binding.key.slot.entityId, binding.generation);
  }
  return mutation;
}

async function verifyPreparedDatasetGenerationRollback(viewer: WgpuKernelViewer): Promise<void> {
  const datasetId = 'fixture-atomic-prepared-generation-conflict';
  const manifestBytes = jsonBytes({
    schemaVersion: 1,
    roots: ['empty-root'],
    tiles: [
      {
        id: 'empty-root',
        parent: null,
        children: [],
        bounds: {
          kind: 'axisAlignedBox',
          bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
        },
        contentTransform: IDENTITY,
        geometricError: 0,
        refinement: 'replace',
        contents: [],
        childPage: null,
      },
    ],
  });
  const manifestHash = await sha256Bytes(manifestBytes);
  const admission = await canonicalizeLegacyRequest(
    viewer,
    {
      entityId: 'fixture-atomic-prepared-generation-conflict',
      geometry: {
        kind: 'surface3d',
        mesh: {
          storage: {
            kind: 'resource',
            resource: {
              objectHash: manifestHash,
              mediaType: 'himmelcad-prepared-hierarchy@1',
              byteLength: manifestBytes.byteLength,
            },
          },
          closedManifold: false,
          triangleMaterialSlots: null,
          materials: null,
        },
      },
      evaluatedMesh: {
        meshResourceRef: manifestHash,
        providerId: 'hcad.browser-atomic-test',
        providerVersion: '1.0.0',
        datasetId,
        parts: [
          {
            partId: 'empty-root',
            topologyHash: 'ab'.repeat(32),
            bounds: { minimum: [0, 0, 0], maximum: [1, 1, 1] },
          },
        ],
        materialKeys: {},
        closedManifold: false,
      },
    },
    datasetId,
  );
  const staleAdmission: KernelCanonicalRenderAdmission = {
    ...admission,
    admission: { ...admission.admission, expectedGeneration: 41 },
  };
  let rejected = false;
  try {
    viewer.registerPreparedDatasetAndPublishCanonicalRepresentations(
      datasetId,
      'himmelcad-prepared-hierarchy@1',
      'memory:///atomic-prepared/manifest.json',
      manifestBytes,
      [staleAdmission],
    );
  } catch (error) {
    if (!String(error).includes('generation conflict')) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error('stale prepared dataset transaction unexpectedly committed');

  viewer.registerPreparedDataset(
    datasetId,
    'himmelcad-prepared-hierarchy@1',
    'memory:///atomic-prepared/manifest.json',
    manifestBytes,
  );
}

async function ensureStreamBinding(
  viewer: WgpuKernelViewer,
  metadata: {
    readonly datasetId: string;
    readonly entityId: string;
    readonly canonicalDatasetRegistered?: boolean;
    readonly canonicalDatasetFormatId?: string;
    readonly canonicalDatasetMetadata?: Uint8Array;
    readonly style?: KernelRenderStyle;
    readonly bounds?: Readonly<Record<string, unknown>>;
    readonly canonicalPlacement?: readonly number[];
  },
  geometry: Record<string, unknown>,
): Promise<{ datasetId: string; binding: ReturnType<WgpuKernelViewer['canonicalStreamBinding']> }> {
  const key = `${metadata.datasetId}\u0000${metadata.entityId}`;
  let datasetId = streamDatasetByEntity.get(key);
  if (datasetId === undefined) {
    datasetId =
      metadata.canonicalDatasetRegistered === true
        ? metadata.datasetId
        : `browser-stream:${metadata.datasetId}:${metadata.entityId}`;
    const bounds = metadata.bounds ?? {
      kind: 'sphere',
      center: { x: BASE[0], y: BASE[1], z: BASE[2] },
      radius: 1,
    };
    const manifestBytes = jsonBytes({
      schemaVersion: 1,
      roots: ['authority-root'],
      tiles: [
        {
          id: 'authority-root',
          parent: null,
          children: [],
          bounds,
          contentTransform: IDENTITY,
          geometricError: 0,
          refinement: 'replace',
          contents: [
            {
              kind: 'cadProxy',
              uri: 'authority.bin',
              byteOffset: null,
              byteLength: null,
              primitiveCount: null,
              contentHash: null,
            },
          ],
          childPage: null,
        },
      ],
    });
    if (metadata.canonicalDatasetRegistered !== true) {
      viewer.registerPreparedDataset(
        datasetId,
        'himmelcad-prepared-hierarchy@1',
        `memory:///${encodeURIComponent(datasetId)}/manifest.json`,
        manifestBytes,
      );
    }
    const streamed = geometry as {
      readonly kind?: string;
      readonly dataset?: Record<string, unknown>;
      readonly mesh?: Record<string, unknown>;
      readonly raster?: Record<string, unknown>;
    };
    const canonicalMetadata = metadata.canonicalDatasetMetadata ?? manifestBytes;
    const resource = {
      objectHash: await sha256Bytes(canonicalMetadata),
      mediaType: metadata.canonicalDatasetFormatId ?? 'himmelcad-prepared-hierarchy@1',
      byteLength: canonicalMetadata.byteLength,
    };
    const canonicalGeometry =
      streamed.dataset === undefined
        ? streamed.kind === 'surface3d'
          ? {
              ...geometry,
              mesh: { ...streamed.mesh, storage: { kind: 'resource', resource } },
            }
          : streamed.kind === 'rasterImage'
            ? { ...geometry, raster: { ...streamed.raster, pixels: resource } }
            : geometry
        : {
            ...geometry,
            dataset: {
              ...streamed.dataset,
              formatId: metadata.canonicalDatasetFormatId ?? 'himmelcad-prepared-hierarchy@1',
              metadata: resource,
            },
          };
    const admission = await canonicalizeLegacyRequest(
      viewer,
      {
        entityId: metadata.entityId,
        geometry: canonicalGeometry,
        ...(metadata.canonicalPlacement === undefined
          ? {}
          : { placement: metadata.canonicalPlacement }),
        ...(metadata.style === undefined ? {} : { style: metadata.style }),
      },
      datasetId,
    );
    const mutation = viewer.publishCanonicalRepresentations([admission]);
    const binding = mutation.bindings[0];
    if (binding === undefined) throw new Error('canonical stream admission omitted its binding');
    admittedGenerations.set(metadata.entityId, binding.generation);
    streamDatasetByEntity.set(key, datasetId);
  }
  return { datasetId, binding: viewer.canonicalStreamBinding(datasetId) };
}

async function decodeAndStage(
  viewer: WgpuKernelViewer,
  decodeKind: 'gltf' | 'threeDTilesContainer' | 'potreePoints' | 'gaussianSplats' | 'raster',
  metadata: Record<string, unknown> & {
    readonly streamId: string;
    readonly entityId: string;
    readonly datasetId: string;
    readonly canonicalDatasetRegistered?: boolean;
    readonly canonicalDatasetFormatId?: string;
    readonly canonicalDatasetMetadata?: Uint8Array;
    readonly canonicalPlacement?: readonly number[];
    readonly style?: KernelRenderStyle;
  },
  primary: Uint8Array<ArrayBufferLike>,
  secondary: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  bundle?: KernelResolvedAssetBundle,
  decodeParametersJson = '',
): Promise<KernelResourceCost> {
  if (streamingWorkerPool === null) throw new Error('streaming worker pool is not initialized');
  const sourceHash = await sha256Bytes(primary);
  const placeholderResource = {
    objectHash: sourceHash,
    mediaType: 'application/octet-stream',
    byteLength: primary.byteLength,
  };
  const depthResource = {
    objectHash: secondary.byteLength === 0 ? '00'.repeat(32) : await sha256Bytes(secondary),
    mediaType: 'application/vnd.himmelcad.depth-f32',
    byteLength: secondary.byteLength,
  };
  const rasterMapping = metadata.mapping as
    | {
        readonly origin?: readonly [number, number];
        readonly columnStep?: readonly [number, number];
        readonly rowStep?: readonly [number, number];
      }
    | undefined;
  const bounds = metadata.bounds as
    | {
        readonly bounds?: { readonly min?: { readonly z?: number } };
      }
    | undefined;
  const geometry =
    decodeKind === 'gaussianSplats'
      ? {
          kind: 'gaussianSplatCloud',
          dataset: { formatId: '3dgs-ply@1', metadata: placeholderResource, elementCount: null },
        }
      : decodeKind === 'potreePoints'
        ? {
            kind: 'pointCloud',
            dataset: { formatId: 'potree@2', metadata: placeholderResource, elementCount: null },
          }
        : decodeKind === 'raster'
          ? {
              kind: 'rasterImage',
              raster: {
                pixels: placeholderResource,
                width: metadata.width,
                height: metadata.height,
                mapping: {
                  kind: 'orthoGrid',
                  origin: {
                    x: rasterMapping?.origin?.[0] ?? 0,
                    y: rasterMapping?.origin?.[1] ?? 0,
                    z: bounds?.bounds?.min?.z ?? 0,
                  },
                  columnStep: {
                    x: rasterMapping?.columnStep?.[0] ?? 1,
                    y: rasterMapping?.columnStep?.[1] ?? 0,
                    z: 0,
                  },
                  rowStep: {
                    x: rasterMapping?.rowStep?.[0] ?? 0,
                    y: rasterMapping?.rowStep?.[1] ?? 1,
                    z: 0,
                  },
                },
                depth: {
                  values: depthResource,
                  validity: null,
                  confidence: null,
                  sampling: {
                    semantics: 'elevationZ',
                    interpolation: 'discontinuityAware',
                    connectivity: metadata.topology,
                  },
                },
              },
            }
          : {
              kind: 'surface3d',
              mesh: {
                storage: { kind: 'resource', resource: placeholderResource },
                closedManifold: false,
                triangleMaterialSlots: null,
                materials: null,
              },
            };
  const { datasetId, binding } = await ensureStreamBinding(viewer, metadata, {
    ...geometry,
  });
  const {
    entityId: _entityId,
    proxyId: _proxyId,
    style: _style,
    datasetId: _sourceDataset,
    canonicalDatasetRegistered: _canonicalDatasetRegistered,
    canonicalDatasetFormatId: _canonicalDatasetFormatId,
    canonicalDatasetMetadata: _canonicalDatasetMetadata,
    canonicalPlacement: _canonicalPlacement,
    width: _width,
    height: _height,
    mapping: _mapping,
    topology: _topology,
    colorEncoding: _colorEncoding,
    elevationEncoding: _elevationEncoding,
    noData: _noData,
    ...content
  } = metadata;
  const canonicalMetadata = {
    ...content,
    ...(geometry.kind === 'rasterImage'
      ? {
          contract: {
            schemaVersion: 1,
            raster: geometry.raster,
            colorEncoding: metadata.colorEncoding,
            depthEncoding: metadata.elevationEncoding,
            noData: metadata.noData,
          },
        }
      : {}),
    slot: binding.key.slot,
    binding,
    datasetId,
  };
  const bundleManifest = bundle?.manifest ?? { schemaVersion: 1 as const, entries: [] };
  const bundleBytes = bundle?.bytes ?? new Uint8Array();
  const metadataJson = JSON.stringify(canonicalMetadata);
  const bundleManifestJson = JSON.stringify(bundleManifest);
  const decodeJob = {
    kind: decodeKind,
    metadataJson,
    bundleManifestJson,
    decodeParametersJson,
    primary: exactArrayBuffer(primary),
    bundle: exactArrayBuffer(bundleBytes),
    secondary: exactArrayBuffer(secondary),
  } as const;
  const expectedInputHash = await decodeInputManifestHash(decodeJob);
  const result = await streamingWorkerPool.decode(decodeJob, new AbortController().signal);
  return viewer.stageDecodedStreamingPayload(
    decodeKind === 'gltf' ? 'gltf' : decodeKind,
    metadataJson,
    new Uint8Array(result.artifact),
    new Uint8Array(result.primary),
    bundleManifestJson,
    new Uint8Array(result.bundle),
    new Uint8Array(result.secondary),
    decodeParametersJson,
    expectedInputHash,
  );
}

async function stage3dTilesContent(
  viewer: WgpuKernelViewer,
  metadata: Parameters<typeof decodeAndStage>[2] & {
    readonly contentKind: 'gltf' | 'threeDTilesContainer';
  },
  bytes: Uint8Array,
  bundle?: KernelResolvedAssetBundle,
): Promise<KernelResourceCost> {
  return await decodeAndStage(
    viewer,
    metadata.contentKind,
    metadata,
    bytes,
    new Uint8Array(),
    bundle,
  );
}

function potreeHierarchyRecord(pointCount: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0); // normal node
  view.setUint8(1, 0); // leaf: no children
  view.setUint32(2, pointCount, true);
  view.setBigInt64(6, 0n, true);
  view.setBigInt64(14, BigInt(byteLength), true);
  return bytes;
}

function potreePoint(position: readonly [number, number, number]): Uint8Array {
  if (position[0] !== 125 || position[1] !== 250 || position[2] !== 500) {
    throw new Error(
      'BROTLI Potree fixture position changed without regenerating its Morton stream',
    );
  }
  // PotreeConverter BROTLI payload: attribute-major Morton position/RGB plus
  // exact intensity, classification, returns and source-id scalar streams.
  return Uint8Array.from([
    11, 15, 128, 0, 0, 0, 0, 0, 0, 0, 0, 81, 247, 223, 4, 0, 0, 0, 0, 0, 128, 6, 2, 4, 1, 2, 73,
    146, 36, 77, 146, 100, 0, 0, 3,
  ]);
}

function float32Band(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function gaussianPly(position: Readonly<{ x: number; y: number; z: number }>): Uint8Array {
  return new TextEncoder().encode(
    `ply\nformat ascii 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n${String(position.x - 0.5)} ${String(position.y)} ${String(position.z)} 0.05 0.04 0.03 0 0 0 1 255 40 40 166\n${String(position.x)} ${String(position.y)} ${String(position.z)} 0.05 0.04 0.03 0 0 0 1 40 255 80 166\n${String(position.x + 0.5)} ${String(position.y)} ${String(position.z)} 0.05 0.04 0.03 0 0 0 1 40 80 255 166\n`,
  );
}

function workerLoadGaussianPly(count: number): Uint8Array {
  const header = `ply\nformat ascii 1.0\nelement vertex ${String(count)}\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n`;
  const row = `${String(BASE[0])} ${String(BASE[1])} ${String(BASE[2])} 0.05 0.04 0.03 0 0 0 1 40 180 255 166\n`;
  return new TextEncoder().encode(header + row.repeat(count));
}

function setFocusedTopCamera(
  viewer: WgpuKernelViewer,
  target: Readonly<{ x: number; y: number; z: number }>,
  verticalSpan = 4,
): void {
  viewer.setWorldCamera(
    {
      eye: { x: target.x, y: target.y, z: target.z + 100 },
      target,
      up: { x: 0, y: 1, z: 0 },
      projection: {
        kind: 'orthographic',
        verticalSpan,
        aspect: 1280 / 720,
        near: 0.05,
        far: 1_000,
      },
    },
    BASE,
  );
  viewer.render();
}

function setFocusedSideCamera(
  viewer: WgpuKernelViewer,
  target: Readonly<{ x: number; y: number; z: number }>,
  side: -1 | 1,
): void {
  viewer.setWorldCamera(
    {
      eye: { x: target.x + side * 100, y: target.y, z: target.z },
      target,
      up: { x: 0, y: 0, z: 1 },
      projection: {
        kind: 'orthographic',
        verticalSpan: 4,
        aspect: 1280 / 720,
        near: 0.05,
        far: 1_000,
      },
    },
    BASE,
  );
  viewer.render();
}

function setFocusedFrontCamera(
  viewer: WgpuKernelViewer,
  target: Readonly<{ x: number; y: number; z: number }>,
): void {
  viewer.setWorldCamera(
    {
      eye: { x: target.x, y: target.y - 100, z: target.z },
      target,
      up: { x: 0, y: 0, z: 1 },
      projection: {
        kind: 'orthographic',
        verticalSpan: 4,
        aspect: 1280 / 720,
        near: 0.05,
        far: 1_000,
      },
    },
    BASE,
  );
  viewer.render();
}

function setFocusedOrientedCamera(
  viewer: WgpuKernelViewer,
  target: Readonly<{ x: number; y: number; z: number }>,
  eyeDirection: Readonly<{ x: number; y: number; z: number }>,
  up: Readonly<{ x: number; y: number; z: number }>,
  verticalSpan: number,
): void {
  viewer.setWorldCamera(
    {
      eye: {
        x: target.x + eyeDirection.x * 500,
        y: target.y + eyeDirection.y * 500,
        z: target.z + eyeDirection.z * 500,
      },
      target,
      up,
      projection: {
        kind: 'orthographic',
        verticalSpan,
        aspect: 1280 / 720,
        near: 0.05,
        far: 2_000,
      },
    },
    [target.x, target.y, target.z],
  );
  viewer.render();
}

async function findEntityPick(
  viewer: WgpuKernelViewer,
  entityId: string,
): Promise<{ pick: KernelPickResult; candidate: KernelPickCandidate }> {
  const offsets = [
    [0, 0],
    [-160, 0],
    [160, 0],
    [0, -120],
    [0, 120],
    [-240, -120],
    [240, -120],
    [-240, 120],
    [240, 120],
    [-320, 0],
    [320, 0],
    [0, -240],
    [0, 240],
  ] as const;
  for (const [x, y] of offsets) {
    const pick = await viewer.pick(640 + x, 360 + y, 8);
    const candidate = pick.candidates.find((entry) => entry.address.entityId === entityId);
    if (candidate !== undefined) return { pick, candidate };
  }
  throw new Error(`no exact pick candidate found for ${entityId}`);
}

async function installRealGlb(viewer: WgpuKernelViewer): Promise<{
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
}> {
  const response = await fetch('/fixtures/TextureCoordinateTest.glb');
  if (!response.ok)
    throw new Error(`real glTF fixture fetch failed: HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const target = { x: BASE[0] - 32, y: BASE[1] - 18, z: BASE[2] + 4 };
  const streamId = 'real-khronos-texture-coordinate-test/root';
  await stage3dTilesContent(
    viewer,
    {
      streamId,
      entityId: 'khronos-texture-coordinate-test',
      proxyId: 'real-khronos-texture-coordinate-test/root@1',
      datasetId: 'real-khronos-texture-coordinate-test',
      tileId: 'root',
      contentUri: '/fixtures/TextureCoordinateTest.glb',
      contentKind: 'gltf',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: target.x - 1.3, y: target.y - 0.1, z: target.z - 1.3 },
          max: { x: target.x + 1.3, y: target.y + 0.1, z: target.z + 1.3 },
        },
      },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, target.x, target.y, target.z, 1],
      style: style([1, 1, 1, 1], 1, { kind: 'source' }),
    },
    bytes,
  );
  const publish = viewer.publishStagedContents([streamId]);
  state.entityCount = publish.entities;
  state.proxyCount = publish.proxies;
  return { publish, target };
}

async function installRealTiles(viewer: WgpuKernelViewer): Promise<{
  rootPublish: KernelStreamingPublish;
  instancePublish: KernelStreamingPublish;
  rootTarget: { x: number; y: number; z: number };
  instanceTarget: { x: number; y: number; z: number };
}> {
  const [tilesetResponse, rootResponse, instanceResponse] = await Promise.all([
    fetch('/fixtures/tileset.json'),
    fetch('/fixtures/buildings.b3dm'),
    fetch('/fixtures/instances.i3dm'),
  ]);
  for (const response of [tilesetResponse, rootResponse, instanceResponse]) {
    if (!response.ok)
      throw new Error(`real 3D Tiles fixture fetch failed: HTTP ${String(response.status)}`);
  }
  const tileset = new Uint8Array(await tilesetResponse.arrayBuffer());
  const rootBytes = new Uint8Array(await rootResponse.arrayBuffer());
  const instanceBytes = new Uint8Array(await instanceResponse.arrayBuffer());
  const datasetId = 'real-cesium-transforms';
  viewer.register3dTilesDataset(datasetId, '3d-tiles@1.1', '/fixtures/tileset.json', tileset);
  const rootTransform = [
    0.9686356343768792, 0.24848542777253735, 0, 0, -0.15986460744966327, 0.623177611820219,
    0.765567091384559, 0, 0.19023226619126932, -0.7415555652213445, 0.6433560667227647, 0,
    1215011.9317263428, -4736309.3434217675, 4081602.0044800863, 1,
  ] as const;
  const childTransform = [
    0.28594373878372104, 0.30817942310285806, 0.2706688408856415, 0, -0.39898508678310346,
    0.1324736920988568, 0.27066884088564147, 0, 0.09511613309563466, -0.37077778261067224,
    0.32167803336138234, 0, 1215012.8828876738, -4736313.051199594, 4081605.22126042, 1,
  ] as const;
  const rootCenter = { x: rootTransform[12], y: rootTransform[13], z: rootTransform[14] };
  const rootBounds = {
    kind: 'axisAlignedBox' as const,
    bounds: {
      min: { x: rootCenter.x - 200, y: rootCenter.y - 200, z: rootCenter.z - 200 },
      max: { x: rootCenter.x + 200, y: rootCenter.y + 200, z: rootCenter.z + 200 },
    },
  };
  await stage3dTilesContent(
    viewer,
    {
      streamId: `${datasetId}/root`,
      entityId: 'cesium-transformed-buildings',
      proxyId: 'cesium-transformed-buildings/root@1',
      datasetId,
      tileId: 'root',
      contentUri: '/fixtures/buildings.b3dm',
      contentKind: 'threeDTilesContainer',
      bounds: rootBounds,
      contentTransform: rootTransform,
      style: style([0.72, 0.8, 1, 1], 1, { kind: 'source' }),
    },
    rootBytes,
  );
  const rootPublish = viewer.publishStagedContents([`${datasetId}/root`]);
  await stage3dTilesContent(
    viewer,
    {
      streamId: `${datasetId}/child`,
      entityId: 'cesium-transformed-instances',
      proxyId: 'cesium-transformed-instances/child@1',
      datasetId,
      tileId: 'child',
      contentUri: '/fixtures/instances.i3dm',
      contentKind: 'threeDTilesContainer',
      bounds: rootBounds,
      contentTransform: childTransform,
      style: style([1, 0.76, 0.2, 1], 1, { kind: 'source' }),
    },
    instanceBytes,
  );
  const instancePublish = viewer.publishStagedContents([`${datasetId}/child`]);
  state.entityCount = instancePublish.entities;
  state.proxyCount = instancePublish.proxies;
  // Building 2 is outside the i3dm instance grid, so its exact b3dm pick
  // cannot be occluded by the independently decoded child content.
  const rootTarget = {
    x: 1215088.720982394,
    y: -4736289.674901866,
    z: 4081598.0437297337,
  };
  const instanceTarget = {
    x: 1215013.1027584642,
    y: -4736313.90829083,
    z: 4081605.9648525026,
  };
  return { rootPublish, instancePublish, rootTarget, instanceTarget };
}

async function installRealLegacyMetadata(viewer: WgpuKernelViewer): Promise<{
  hierarchyPublish: KernelStreamingPublish;
  pointPublish: KernelStreamingPublish;
  hierarchyTarget: { x: number; y: number; z: number };
  pointTarget: { x: number; y: number; z: number };
  hierarchyProxyId: string;
  pointProxyId: string;
}> {
  const [hierarchyResponse, pointResponse] = await Promise.all([
    fetch('/fixtures/batch-table-hierarchy.b3dm'),
    fetch('/fixtures/point-cloud-per-point-properties.pnts'),
  ]);
  if (!hierarchyResponse.ok || !pointResponse.ok) {
    throw new Error('real legacy metadata fixture fetch failed');
  }
  const hierarchyBytes = new Uint8Array(await hierarchyResponse.arrayBuffer());
  const pointBytes = new Uint8Array(await pointResponse.arrayBuffer());
  const hierarchyTarget = { x: BASE[0] + 400, y: BASE[1], z: BASE[2] };
  const pointTarget = { x: BASE[0] + 560, y: BASE[1], z: BASE[2] };
  let hierarchyProxyId = 'legacy-hierarchy/root@1';
  let pointProxyId = 'legacy-points/root@1';
  await stage3dTilesContent(
    viewer,
    {
      streamId: 'legacy-hierarchy/root',
      entityId: 'legacy-hierarchy',
      proxyId: hierarchyProxyId,
      datasetId: 'legacy-hierarchy',
      tileId: 'root',
      contentUri: '/fixtures/batch-table-hierarchy.b3dm',
      contentKind: 'threeDTilesContainer',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: hierarchyTarget.x - 60, y: hierarchyTarget.y - 60, z: hierarchyTarget.z - 5 },
          max: { x: hierarchyTarget.x + 60, y: hierarchyTarget.y + 60, z: hierarchyTarget.z + 30 },
        },
      },
      contentTransform: [
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        hierarchyTarget.x,
        hierarchyTarget.y,
        hierarchyTarget.z,
        1,
      ],
      style: style([0.85, 0.7, 0.3, 1]),
    },
    hierarchyBytes,
  );
  const hierarchyPublish = viewer.publishStagedContents(['legacy-hierarchy/root']);
  hierarchyProxyId = hierarchyPublish.streams[0]?.proxyIds[0] ?? hierarchyProxyId;
  await stage3dTilesContent(
    viewer,
    {
      streamId: 'legacy-points/root',
      entityId: 'legacy-points',
      proxyId: pointProxyId,
      datasetId: 'legacy-points',
      tileId: 'root',
      contentUri: '/fixtures/point-cloud-per-point-properties.pnts',
      contentKind: 'threeDTilesContainer',
      bounds: {
        kind: 'sphere',
        center: pointTarget,
        radius: 6,
      },
      contentTransform: [
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        pointTarget.x,
        pointTarget.y,
        pointTarget.z,
        1,
      ],
      style: style([0.3, 0.9, 0.7, 1]),
    },
    pointBytes,
  );
  const pointPublish = viewer.publishStagedContents(['legacy-points/root']);
  pointProxyId = pointPublish.streams[0]?.proxyIds[0] ?? pointProxyId;
  return {
    hierarchyPublish,
    pointPublish,
    hierarchyTarget,
    pointTarget,
    hierarchyProxyId,
    pointProxyId,
  };
}

async function installRealExternalI3dm(viewer: WgpuKernelViewer): Promise<{
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
  dependencyCount: number;
  bundleBytes: number;
  sharedGpuModels: { allocations: number; owners: number; gpuBufferBytes: number };
  sharedGpuTextures: {
    allocations: number;
    retainedAllocations: number;
    owners: number;
    stagedOwners: number;
    gpuTextureBytes: number;
    decodedSources: number;
    factoryCalls: number;
  };
}> {
  const response = await fetch('/fixtures/external-instances.i3dm');
  if (!response.ok)
    throw new Error(`external i3dm fixture fetch failed: HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentUri = '/fixtures/external-instances.i3dm';
  const dependencies = viewer.inspect3dTilesDependencies(
    {
      contentUri,
      contentKind: 'threeDTilesContainer',
    },
    bytes,
  );
  if (
    dependencies.length !== 1 ||
    dependencies[0]?.sourceUri !== 'box.glb' ||
    dependencies[0].kind !== 'gltfDocument'
  ) {
    throw new Error(`unexpected external i3dm dependency graph: ${JSON.stringify(dependencies)}`);
  }
  const modelResponse = await fetch('/fixtures/box.glb');
  if (!modelResponse.ok)
    throw new Error(`external i3dm model fetch failed: HTTP ${String(modelResponse.status)}`);
  const model = new Uint8Array(await modelResponse.arrayBuffer());
  const streamId = 'real-cesium-external-i3dm/root';
  await stage3dTilesContent(
    viewer,
    {
      streamId,
      entityId: 'cesium-external-instances',
      proxyId: 'cesium-external-instances/root@1',
      datasetId: 'real-cesium-external-i3dm',
      tileId: 'root',
      contentUri,
      contentKind: 'threeDTilesContainer',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: 1_215_900, y: -4_736_410, z: 4_081_520 },
          max: { x: 1_216_130, y: -4_736_220, z: 4_081_700 },
        },
      },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1_000, 0, 0, 1],
      style: style([0.45, 1, 0.55, 1], 1, { kind: 'source' }),
    },
    bytes,
    {
      manifest: {
        schemaVersion: 1,
        entries: [
          {
            ...dependencies[0],
            resolvedUri: '/fixtures/box.glb',
            byteOffset: 0,
            byteLength: model.byteLength,
          },
        ],
      },
      bytes: model,
    },
  );
  const publish = viewer.publishStagedContents([streamId]);
  if (publish.uploadedBytes <= publish.cost.gpuBufferBytes + publish.cost.gpuTextureBytes) {
    throw new Error('first i3dm owner did not report its shared model GPU upload');
  }
  const firstGpuTextures = viewer.gpuTextureCacheStats();
  const secondStreamId = 'real-cesium-external-i3dm/second';
  await stage3dTilesContent(
    viewer,
    {
      streamId: secondStreamId,
      entityId: 'cesium-external-instances-second',
      proxyId: 'cesium-external-instances/second@1',
      datasetId: 'real-cesium-external-i3dm',
      tileId: 'second',
      contentUri,
      contentKind: 'threeDTilesContainer',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: 1_217_900, y: -4_736_410, z: 4_081_520 },
          max: { x: 1_218_130, y: -4_736_220, z: 4_081_700 },
        },
      },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3_000, 0, 0, 1],
      style: style([0.45, 1, 0.55, 1], 1, { kind: 'source' }),
    },
    bytes,
    {
      manifest: {
        schemaVersion: 1,
        entries: [
          {
            ...dependencies[0],
            resolvedUri: '/fixtures/box.glb',
            byteOffset: 0,
            byteLength: model.byteLength,
          },
        ],
      },
      bytes: model,
    },
  );
  const secondPublish = viewer.publishStagedContents([secondStreamId]);
  if (
    secondPublish.uploadedBytes !==
    secondPublish.cost.gpuBufferBytes + secondPublish.cost.gpuTextureBytes
  ) {
    throw new Error('second i3dm owner charged the already resident shared model again');
  }
  const sharedGpuModels = viewer.gpuModelCacheStats();
  const afterSecondOwner = viewer.gpuTextureCacheStats();
  if (
    afterSecondOwner.allocations !== firstGpuTextures.allocations ||
    afterSecondOwner.gpuTextureBytes !== firstGpuTextures.gpuTextureBytes ||
    afterSecondOwner.decodedSources !== firstGpuTextures.decodedSources ||
    afterSecondOwner.factoryCalls !== firstGpuTextures.factoryCalls ||
    afterSecondOwner.owners !== firstGpuTextures.owners + 1 ||
    afterSecondOwner.stagedOwners !== 0
  ) {
    throw new Error('second i3dm owner did not reuse the exact resident texture allocation');
  }
  viewer.setEntityStyle(
    'cesium-external-instances-second',
    style([0.35, 0.95, 0.7, 1], 0.8, { kind: 'source' }),
  );
  const sharedGpuTextures = viewer.gpuTextureCacheStats();
  if (
    sharedGpuTextures.decodedSources !== afterSecondOwner.decodedSources ||
    sharedGpuTextures.factoryCalls !== afterSecondOwner.factoryCalls ||
    sharedGpuTextures.allocations !== afterSecondOwner.allocations ||
    sharedGpuTextures.gpuTextureBytes !== afterSecondOwner.gpuTextureBytes
  ) {
    throw new Error('resident style recompile decoded, transcoded, or uploaded textures again');
  }
  state.entityCount = publish.entities;
  state.proxyCount = publish.proxies;
  return {
    publish,
    target: { x: 1_216_013.875, y: -4_736_317, z: 4_081_608.5 },
    dependencyCount: dependencies.length,
    bundleBytes: model.byteLength,
    sharedGpuModels,
    sharedGpuTextures,
  };
}

async function installRealExternalJsonGltf(viewer: WgpuKernelViewer): Promise<{
  publish: KernelStreamingPublish;
  target: { x: number; y: number; z: number };
  dependencies: readonly { ownerUri: string; sourceUri: string; kind: string }[];
  primaryBytes: number;
  bundleBytes: number;
}> {
  const contentUri = '/fixtures/external-json/model.gltf';
  const response = await fetch(contentUri);
  if (!response.ok)
    throw new Error(`external JSON glTF fixture fetch failed: HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const dependencies = viewer.inspect3dTilesDependencies(
    { contentUri, contentKind: 'gltf' },
    bytes,
  );
  const expected = new Map<string, string>([
    ['mesh.bin', 'buffer'],
    ['checker.png', 'image'],
    ['metadata.schema.json', 'schema'],
  ] as const);
  if (
    dependencies.length !== expected.size ||
    dependencies.some(
      (dependency) =>
        dependency.ownerUri !== contentUri ||
        expected.get(dependency.sourceUri) !== dependency.kind,
    )
  ) {
    throw new Error(
      `unexpected external JSON glTF dependency graph: ${JSON.stringify(dependencies)}`,
    );
  }
  const resources = await Promise.all(
    dependencies.map(async (dependency) => {
      const resolvedUri = `/fixtures/external-json/${dependency.sourceUri}`;
      const resourceResponse = await fetch(resolvedUri);
      if (!resourceResponse.ok) {
        throw new Error(
          `external JSON glTF resource fetch failed for ${dependency.sourceUri}: HTTP ${String(resourceResponse.status)}`,
        );
      }
      return {
        dependency,
        resolvedUri,
        bytes: new Uint8Array(await resourceResponse.arrayBuffer()),
      };
    }),
  );
  const bundleBytes = resources.reduce((sum, resource) => sum + resource.bytes.byteLength, 0);
  const bundle = new Uint8Array(bundleBytes);
  let byteOffset = 0;
  const entries = resources.map((resource) => {
    bundle.set(resource.bytes, byteOffset);
    const entry = {
      ...resource.dependency,
      resolvedUri: resource.resolvedUri,
      byteOffset,
      byteLength: resource.bytes.byteLength,
    };
    byteOffset += resource.bytes.byteLength;
    return entry;
  });
  const target = { x: BASE[0] - 44, y: BASE[1] + 24, z: BASE[2] + 6 };
  const streamId = 'real-external-json-gltf/root';
  await stage3dTilesContent(
    viewer,
    {
      streamId,
      entityId: 'external-json-textured-triangle',
      proxyId: 'external-json-textured-triangle/root@1',
      datasetId: 'real-external-json-gltf',
      tileId: 'root',
      contentUri,
      contentKind: 'gltf',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: target.x - 1, y: target.y, z: target.z - 1 },
          max: { x: target.x + 1, y: target.y, z: target.z + 1 },
        },
      },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, target.x, target.y, target.z, 1],
      style: style([1, 1, 1, 1], 1, { kind: 'source' }),
    },
    bytes,
    {
      manifest: { schemaVersion: 1, entries },
      bytes: bundle,
    },
  );
  const publish = viewer.publishStagedContents([streamId]);
  state.entityCount = publish.entities;
  state.proxyCount = publish.proxies;
  return {
    publish,
    target,
    dependencies,
    primaryBytes: bytes.byteLength,
    bundleBytes: bundle.byteLength,
  };
}

async function installPreparedTexturedMesh(
  viewer: WgpuKernelViewer,
): Promise<Omit<PreparedTexturedMeshValidation, 'pick'>> {
  const manifestUri = '/fixtures/prepared-textured/kernel-manifest.json';
  const manifestResponse = await fetch(manifestUri);
  if (!manifestResponse.ok) {
    throw new Error(`prepared hierarchy fetch failed: HTTP ${String(manifestResponse.status)}`);
  }
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    readonly tiles: readonly [
      {
        readonly id: string;
        readonly bounds: {
          readonly kind: 'sphere';
          readonly center: { readonly x: number; readonly y: number; readonly z: number };
          readonly radius: number;
        };
        readonly contentTransform: readonly number[];
        readonly contents: readonly [
          {
            readonly uri: string;
            readonly contentHash: string;
            readonly decoderParameters: {
              readonly immutableAssets: readonly {
                readonly uri: string;
                readonly contentHash: string;
                readonly byteLength: number;
              }[];
            };
          },
        ];
      },
    ];
  };
  const descriptor = manifest.tiles[0];
  const reference = descriptor?.contents[0];
  if (descriptor?.id !== 'r' || reference === undefined) {
    throw new Error('prepared hierarchy fixture omitted its root glTF descriptor');
  }
  viewer.registerPreparedDataset(
    'prepared-textured-mesh',
    'himmelcad-prepared-hierarchy@1',
    manifestUri,
    manifestBytes,
  );
  const contentUri = new URL(reference.uri, `${location.origin}${manifestUri}`).pathname;
  const response = await fetch(contentUri);
  if (!response.ok) {
    throw new Error(`prepared textured glTF fetch failed: HTTP ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256Bytes(bytes)) !== reference.contentHash) {
    throw new Error('prepared textured glTF does not match its hierarchy content hash');
  }
  const dependencies = viewer.inspect3dTilesDependencies(
    { contentUri, contentKind: 'gltf' },
    bytes,
  );
  const expected = new Map<string, string>([
    ['r.positions.f32', 'buffer'],
    ['r.indices.u32', 'buffer'],
    ['r.texcoords.f32', 'buffer'],
    ['../texture.png', 'image'],
  ] as const);
  if (
    dependencies.length !== expected.size ||
    dependencies.some(
      (dependency) =>
        dependency.ownerUri !== contentUri ||
        expected.get(dependency.sourceUri) !== dependency.kind,
    )
  ) {
    throw new Error(
      `unexpected prepared textured glTF dependency graph: ${JSON.stringify(dependencies)}`,
    );
  }
  const resources = await Promise.all(
    dependencies.map(async (dependency) => {
      const resolvedUri = new URL(dependency.sourceUri, `${location.origin}${contentUri}`).pathname;
      const resourceResponse = await fetch(resolvedUri);
      if (!resourceResponse.ok) {
        throw new Error(
          `prepared textured glTF resource fetch failed for ${dependency.sourceUri}: HTTP ${String(resourceResponse.status)}`,
        );
      }
      const resourceBytes = new Uint8Array(await resourceResponse.arrayBuffer());
      const immutableAsset = reference.decoderParameters.immutableAssets.find(
        (asset) => asset.uri === dependency.sourceUri,
      );
      if (
        immutableAsset === undefined ||
        immutableAsset.byteLength !== resourceBytes.byteLength ||
        immutableAsset.contentHash !== (await sha256Bytes(resourceBytes))
      ) {
        throw new Error(`prepared immutable asset identity mismatch: ${dependency.sourceUri}`);
      }
      return {
        dependency,
        resolvedUri,
        bytes: resourceBytes,
      };
    }),
  );
  const bundleBytes = resources.reduce((sum, resource) => sum + resource.bytes.byteLength, 0);
  const bundle = new Uint8Array(bundleBytes);
  let byteOffset = 0;
  const entries = resources.map((resource) => {
    bundle.set(resource.bytes, byteOffset);
    const entry = {
      ...resource.dependency,
      resolvedUri: resource.resolvedUri,
      byteOffset,
      byteLength: resource.bytes.byteLength,
    };
    byteOffset += resource.bytes.byteLength;
    return entry;
  });
  const center = descriptor.bounds.center;
  const target = { x: center.x, y: center.y, z: center.z };
  const streamId = 'prepared-textured-mesh/root';
  await stage3dTilesContent(
    viewer,
    {
      streamId,
      entityId: 'prepared-textured-mesh',
      proxyId: 'prepared-textured-mesh/root@1',
      datasetId: 'prepared-textured-mesh',
      canonicalDatasetRegistered: true,
      canonicalDatasetFormatId: 'himmelcad-prepared-hierarchy@1',
      canonicalDatasetMetadata: manifestBytes,
      tileId: 'r',
      contentUri,
      contentKind: 'gltf',
      bounds: descriptor.bounds,
      contentTransform: descriptor.contentTransform,
      style: style([1, 1, 1, 1], 1, { kind: 'source' }),
    },
    bytes,
    {
      manifest: { schemaVersion: 1, entries },
      bytes: bundle,
    },
  );
  const publish = viewer.publishStagedContents([streamId]);
  state.entityCount = publish.entities;
  state.proxyCount = publish.proxies;
  return { publish, target, dependencies, primaryBytes: bytes.byteLength, bundleBytes };
}

async function installProviderFixtures(viewer: WgpuKernelViewer) {
  const potreeDatasetId = 'fixture-potree';
  const potreeEntityId = 'fixture-potree-point';
  const potreeStreamId = 'fixture-potree/r';
  const potreeOffset = [BASE[0] + 80, BASE[1] + 20, BASE[2] + 10] as const;
  const quantizedPoint = [125, 250, 500] as const;
  const expectedProviderPosition = {
    x: potreeOffset[0] + quantizedPoint[0] * 0.001,
    y: potreeOffset[1] + quantizedPoint[1] * 0.001,
    z: potreeOffset[2] + quantizedPoint[2] * 0.001,
  };
  const potreePlacement = [12.5, -6.25, 4.75] as const;
  const expectedWorldPosition = {
    x: expectedProviderPosition.x + potreePlacement[0],
    y: expectedProviderPosition.y + potreePlacement[1],
    z: expectedProviderPosition.z + potreePlacement[2],
  };
  const potreeBytes = potreePoint(quantizedPoint);
  const potreeMetadataBytes = jsonBytes({
    version: '2.0',
    hierarchy: { firstChunkSize: 22, stepSize: 5, depth: 0 },
    spacing: 1,
    boundingBox: {
      min: [potreeOffset[0] - 1, potreeOffset[1] - 1, potreeOffset[2] - 1],
      max: [potreeOffset[0] + 1, potreeOffset[1] + 1, potreeOffset[2] + 1],
    },
    offset: potreeOffset,
    scale: [0.001, 0.001, 0.001],
    encoding: 'BROTLI',
    attributes: [
      { name: 'position', size: 12, numElements: 3, type: 'int32' },
      { name: 'Intensity', size: 2, numElements: 1, type: 'uint16' },
      { name: 'classification', size: 1, numElements: 1, type: 'uint8' },
      { name: 'return_number', size: 1, numElements: 1, type: 'uint8' },
      { name: 'Number Of Returns', size: 1, numElements: 1, type: 'uint8' },
      { name: 'source-id', size: 2, numElements: 1, type: 'uint16' },
      { name: 'rgb', size: 3, numElements: 3, type: 'uint8' },
    ],
  });
  viewer.registerPotreeDataset(
    potreeDatasetId,
    'potree@2',
    'hcad://browser-fixture/potree/metadata.json',
    potreeMetadataBytes,
    potreeHierarchyRecord(1, potreeBytes.byteLength),
  );
  const potreeMetadata = {
    streamId: potreeStreamId,
    entityId: potreeEntityId,
    proxyId: 'fixture-potree/r@1',
    datasetId: potreeDatasetId,
    canonicalDatasetRegistered: true,
    canonicalDatasetFormatId: 'potree@2',
    canonicalDatasetMetadata: potreeMetadataBytes,
    canonicalPlacement: relativePlacement(...potreePlacement),
    tileId: 'r',
    bounds: {
      kind: 'axisAlignedBox' as const,
      bounds: {
        min: {
          x: expectedProviderPosition.x - 0.01,
          y: expectedProviderPosition.y - 0.01,
          z: expectedProviderPosition.z - 0.01,
        },
        max: {
          x: expectedProviderPosition.x + 0.01,
          y: expectedProviderPosition.y + 0.01,
          z: expectedProviderPosition.z + 0.01,
        },
      },
    },
    pointCount: 1,
    style: style([1, 1, 1, 1], 1, { kind: 'pointClassification', colors: [] }),
  };
  state.phase = 'provider-worker-fixtures:potree';
  const potreeStage = await decodeAndStage(
    viewer,
    'potreePoints',
    potreeMetadata,
    potreeBytes,
    new Uint8Array(),
    undefined,
    viewer.potreeDecodeParameters(potreeDatasetId),
  );
  viewer.publishStagedContents([potreeStreamId]);
  await stage3dTilesContent(
    viewer,
    {
      streamId: potreeStreamId,
      entityId: potreeEntityId,
      proxyId: 'fixture-potree/temporary-mesh@1',
      datasetId: potreeDatasetId,
      tileId: 'r',
      contentUri: 'memory:///fixture-potree/temporary.glb',
      contentKind: 'gltf',
      bounds: potreeMetadata.bounds,
      contentTransform: [
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        expectedProviderPosition.x,
        expectedProviderPosition.y,
        expectedProviderPosition.z,
        1,
      ],
      style: style([1, 0.12, 0.72, 1]),
    },
    featureMetadataGlb(),
  );
  const toMesh = viewer.publishStagedContents([potreeStreamId]);
  await decodeAndStage(
    viewer,
    'potreePoints',
    potreeMetadata,
    potreeBytes,
    new Uint8Array(),
    undefined,
    viewer.potreeDecodeParameters(potreeDatasetId),
  );
  const potreePublish = viewer.publishStagedContents([potreeStreamId]);
  state.crossProviderReplacement = { toMesh, toPotree: potreePublish };
  state.entityCount = potreePublish.entities;
  state.proxyCount = potreePublish.proxies;

  const rasterDatasetId = 'fixture-elevation-raster';
  const rasterEntityId = 'fixture-pixel-steps';
  const rasterStreamId = 'fixture-elevation-raster/r';
  const rasterOrigin = [BASE[0] + 100, BASE[1] - 30] as const;
  const columnStep = [2, 0] as const;
  const rowStep = [0, 2] as const;
  const elevations = [BASE[2] + 5, BASE[2] + 15, -9_999, BASE[2] + 25] as const;
  const expectedLowSample = { x: rasterOrigin[0], y: rasterOrigin[1], z: elevations[0] };
  const expectedHighSample = { x: rasterOrigin[0] + 2, y: rasterOrigin[1], z: elevations[1] };
  const rasterBounds = {
    kind: 'axisAlignedBox' as const,
    bounds: {
      min: { x: rasterOrigin[0] - 1, y: rasterOrigin[1] - 1, z: BASE[2] },
      max: { x: rasterOrigin[0] + 7, y: rasterOrigin[1] + 1, z: BASE[2] + 30 },
    },
  };
  const rasterManifestBytes = jsonBytes({
    schemaVersion: 1,
    roots: ['r'],
    tiles: [
      {
        id: 'r',
        parent: null,
        children: [],
        bounds: rasterBounds,
        contentTransform: IDENTITY,
        geometricError: 0,
        refinement: 'replace',
        contents: [
          {
            kind: 'raster',
            uri: 'raster.bin',
            byteOffset: null,
            byteLength: null,
            primitiveCount: 4,
            contentHash: null,
          },
        ],
        childPage: null,
      },
    ],
  });
  viewer.registerPreparedDataset(
    rasterDatasetId,
    'himmelcad-prepared-hierarchy@1',
    'hcad://browser-fixture/elevation-raster/manifest.json',
    rasterManifestBytes,
  );
  const rasterMetadata = {
    streamId: rasterStreamId,
    entityId: rasterEntityId,
    proxyId: 'fixture-elevation-raster/r@1',
    datasetId: rasterDatasetId,
    canonicalDatasetRegistered: true,
    canonicalDatasetFormatId: 'himmelcad-prepared-hierarchy@1',
    canonicalDatasetMetadata: rasterManifestBytes,
    tileId: 'r',
    bounds: rasterBounds,
    width: 4,
    height: 1,
    mapping: { origin: rasterOrigin, columnStep, rowStep },
    topology: { kind: 'pixelSteps' as const },
    colorEncoding: 'rgba8' as const,
    elevationEncoding: { kind: 'float32LittleEndian' as const },
    noData: { kind: 'numeric' as const, value: -9_999 },
    elevationPayloadByteLength: elevations.length * Float32Array.BYTES_PER_ELEMENT,
    validityPayloadByteLength: 0,
    triangleMaskPayloadByteLength: 0,
    style: style([1, 1, 1, 1], 1, { kind: 'source' }),
  };
  const rasterColor = new Uint8Array([
    20, 210, 110, 255, 255, 180, 25, 255, 255, 0, 255, 255, 40, 130, 255, 255,
  ]);
  state.phase = 'provider-worker-fixtures:raster';
  const rasterStage = await decodeAndStage(
    viewer,
    'raster',
    rasterMetadata,
    rasterColor,
    float32Band(elevations),
  );
  const rasterPublish = viewer.publishStagedContents([rasterStreamId]);
  state.entityCount = rasterPublish.entities;
  state.proxyCount = rasterPublish.proxies;

  const gaussianDatasetId = 'fixture-gaussian-splat';
  const gaussianEntityId = 'fixture-gaussian-mean';
  const gaussianStreamId = 'fixture-gaussian-splat/r';
  const expectedMean = {
    x: 6_378_257.123_456_789,
    y: 5_400_020.234_567_891,
    z: 542.345_678_901,
  };
  const expectedCoverage = {
    x: expectedMean.x + 12 / 180,
    y: expectedMean.y,
    z: expectedMean.z,
  };
  const gaussianBounds = {
    kind: 'axisAlignedBox' as const,
    bounds: {
      min: { x: expectedMean.x - 1, y: expectedMean.y - 1, z: expectedMean.z - 1 },
      max: { x: expectedMean.x + 1, y: expectedMean.y + 1, z: expectedMean.z + 1 },
    },
  };
  const gaussianManifestBytes = jsonBytes({
    schemaVersion: 1,
    roots: ['r'],
    tiles: [
      {
        id: 'r',
        parent: null,
        children: [],
        bounds: gaussianBounds,
        contentTransform: IDENTITY,
        geometricError: 0,
        refinement: 'replace',
        contents: [
          {
            kind: 'gaussianSplats',
            uri: 'splat.ply',
            byteOffset: null,
            byteLength: null,
            primitiveCount: 3,
            contentHash: null,
          },
        ],
        childPage: null,
      },
    ],
  });
  viewer.registerPreparedDataset(
    gaussianDatasetId,
    'himmelcad-prepared-hierarchy@1',
    'hcad://browser-fixture/gaussian/manifest.json',
    gaussianManifestBytes,
  );
  const gaussianBytes = gaussianPly(expectedMean);
  state.phase = 'provider-worker-fixtures:gaussian';
  const gaussianStage = await decodeAndStage(
    viewer,
    'gaussianSplats',
    {
      streamId: gaussianStreamId,
      entityId: gaussianEntityId,
      proxyId: 'fixture-gaussian-splat/r@1',
      datasetId: gaussianDatasetId,
      canonicalDatasetRegistered: true,
      canonicalDatasetFormatId: 'himmelcad-prepared-hierarchy@1',
      canonicalDatasetMetadata: gaussianManifestBytes,
      tileId: 'r',
      bounds: gaussianBounds,
      maximumSplats: 3,
      style: style([1, 1, 1, 1], 1, { kind: 'source' }),
    },
    gaussianBytes,
  );
  const gaussianPublish = viewer.publishStagedContents([gaussianStreamId]);
  state.entityCount = gaussianPublish.entities;
  state.proxyCount = gaussianPublish.proxies;

  return {
    potree: {
      stage: potreeStage,
      publish: potreePublish,
      expectedWorldPosition,
      expectedProviderPosition,
    },
    raster: {
      stage: rasterStage,
      publish: rasterPublish,
      expectedLowSample,
      expectedHighSample,
    },
    gaussian: {
      stage: gaussianStage,
      publish: gaussianPublish,
      expectedMean,
      expectedCoverage,
    },
  };
}

function verifyResolvedPresentationBindings(
  viewer: WgpuKernelViewer,
): NonNullable<BrowserValidationState['presentationBindings']> {
  const batchIdentity = (batches: readonly KernelEntityPresentationBatch[]) =>
    JSON.stringify(batches.map(({ proxyId, batchIndex, kind }) => ({ proxyId, batchIndex, kind })));
  const decodeBefore = viewer.streamDecodeDiagnostics();
  const canonicalMaterials = viewer.entityPresentation('material-layer-box');
  const materialTextureResidency = MATERIAL_TEXTURE_RESIDENCY;
  if (
    materialTextureResidency === null ||
    materialTextureResidency.allocations !== 5 ||
    materialTextureResidency.retainedAllocations !== 5 ||
    materialTextureResidency.owners !== 5 ||
    materialTextureResidency.stagedOwners !== 0 ||
    materialTextureResidency.gpuTextureBytes !== 80 ||
    materialTextureResidency.factoryCalls !== 5 ||
    canonicalMaterials.length !== 2 ||
    canonicalMaterials[0]?.sourceMaterialSlot !== 3 ||
    canonicalMaterials[1]?.sourceMaterialSlot !== 7 ||
    canonicalMaterials.some(
      (batch) => !batch.declaredTextureCoordinates || !batch.usesSourceTexture,
    ) ||
    canonicalMaterials[0]?.sourceMaterialDoubleSided !== false ||
    canonicalMaterials[1]?.sourceMaterialDoubleSided !== true ||
    canonicalMaterials[0]?.sourceMaterialColor?.[0] !== 1 ||
    canonicalMaterials[1]?.sourceMaterialColor?.[1] !== 1 ||
    Math.abs((canonicalMaterials[1]?.sourceMaterialUvRows?.[0]?.[2] ?? 0) - 0.125) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourceMaterialUvRows?.[1]?.[2] ?? 0) + 0.25) > 1e-6 ||
    canonicalMaterials[0]?.sourcePbrTextureFlags !== 0 ||
    canonicalMaterials[1]?.sourcePbrTextureFlags !== 15 ||
    Math.abs((canonicalMaterials[1]?.sourcePbr?.metallic ?? 0) - 0.7) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourcePbr?.roughness ?? 0) - 0.55) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourcePbr?.emissive[0] ?? 0) - 0.12) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourcePbrUvRows?.[2]?.[2] ?? 0) - 0.05) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourcePbrUvRows?.[3]?.[2] ?? 0) - 0.1) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourcePbrUvRows?.[8]?.[2] ?? 0) + 0.05) > 1e-6 ||
    Math.abs((canonicalMaterials[1]?.sourcePbrUvRows?.[9]?.[2] ?? 0) + 0.1) > 1e-6
  ) {
    throw new Error('canonical mesh material table did not resolve exact slots/PBR channels');
  }
  const unsealedOldLineType: LineTypeResource = {
    schemaId: 'hcad.resource.line-type@1',
    resourceId: 'revisioned-survey-line',
    contentHash: '00'.repeat(32),
    name: 'Revision A',
    pattern: {
      kind: 'repeating',
      elements: [
        { kind: 'gap', length: 0.45 },
        { kind: 'dot' },
        { kind: 'dash', length: 0.7 },
        { kind: 'dash', length: 0.2 },
      ],
    },
  };
  const oldLineType = {
    ...unsealedOldLineType,
    contentHash: viewer.lineTypeResourceContentHash(unsealedOldLineType),
  };
  const unsealedNewLineType: LineTypeResource = {
    ...unsealedOldLineType,
    contentHash: '00'.repeat(32),
    name: 'Revision B',
    pattern: {
      kind: 'repeating',
      elements: Array.from({ length: 40 }, (_, index) =>
        index % 5 === 0
          ? ({ kind: 'dot' } as const)
          : index % 3 === 0
            ? ({ kind: 'gap', length: 0.11 + index * 0.001 } as const)
            : ({ kind: 'dash', length: 0.17 + index * 0.001 } as const),
      ),
    },
  };
  const newLineType = {
    ...unsealedNewLineType,
    contentHash: viewer.lineTypeResourceContentHash(unsealedNewLineType),
  };
  viewer.registerCanonicalLineTypeResource(oldLineType);
  viewer.registerCanonicalLineTypeResource(newLineType);
  const areaIdentity = batchIdentity(viewer.entityPresentation('mixed-height-area'));
  const areaHatchStyle: KernelRenderStyle = {
    ...style([0.08, 0.52, 0.92, 1], 0.61),
    verticalExaggeration: 1.75,
    fill: hatchFill(crossHatchRef, 0.1, [1, 0.72, 0.2, 0.95]),
  };
  viewer.setEntityStyle('mixed-height-area', areaHatchStyle, BASE[2]);
  viewer.render();
  const hatchAfterLiveStyle = viewer.entityPresentation('mixed-height-area');
  const areaFill = hatchAfterLiveStyle.find((batch) => batch.kind === 'cadFill');
  const areaBoundary = hatchAfterLiveStyle.find((batch) => batch.kind === 'cadStroke');
  if (areaFill?.hatchEnabled !== true || areaFill.fillVisible !== true) {
    throw new Error('live area style update did not retain the resolved hatch binding');
  }
  if (areaBoundary?.hatchEnabled !== false || areaBoundary.fillVisible !== true) {
    throw new Error('area fill presentation leaked into its boundary batch');
  }

  const strokeLineTypeStyle: KernelRenderStyle = {
    ...areaHatchStyle,
    stroke: {
      mode: { kind: 'lineType', resourceId: 'survey-dash' },
      color: { kind: 'uniform', color: [1, 0.18, 0.04, 1] },
      width: { kind: 'screen', pixels: 7 },
      cap: 'round',
      join: 'bevel',
      miterLimit: 3,
    },
  };
  viewer.setEntityStyle('mixed-height-area', strokeLineTypeStyle, BASE[2]);
  viewer.render();
  const strokeLineType = viewer.entityPresentation('mixed-height-area');
  const lineTypeBoundary = strokeLineType.find((batch) => batch.kind === 'cadStroke');
  if (
    lineTypeBoundary?.strokeVisible !== true ||
    lineTypeBoundary.strokeWidthOverride !== 7 ||
    lineTypeBoundary.lineTypeComponents !== 4 ||
    strokeLineType.find((batch) => batch.kind === 'cadFill')?.hatchEnabled !== true
  ) {
    throw new Error('live line-type style did not remain independent from the area fill');
  }

  viewer.setEntityStyle('mixed-height-area', {
    ...strokeLineTypeStyle,
    stroke: {
      ...strokeLineTypeStyle.stroke,
      mode: {
        kind: 'lineType',
        resource: {
          resourceId: oldLineType.resourceId,
          schemaId: oldLineType.schemaId,
          contentHash: oldLineType.contentHash,
        },
      },
    },
  });
  if (
    viewer
      .entityPresentation('mixed-height-area')
      .find((batch) => batch.kind === 'cadStroke')?.lineTypeComponents !== 4
  ) {
    throw new Error('older exact line-type revision was not independently resolvable');
  }
  viewer.setEntityStyle('mixed-height-area', {
    ...strokeLineTypeStyle,
    stroke: {
      ...strokeLineTypeStyle.stroke,
      mode: {
        kind: 'lineType',
        resource: {
          resourceId: newLineType.resourceId,
          schemaId: newLineType.schemaId,
          contentHash: newLineType.contentHash,
        },
      },
    },
  });
  if (
    viewer
      .entityPresentation('mixed-height-area')
      .find((batch) => batch.kind === 'cadStroke')?.lineTypeComponents !== 40
  ) {
    throw new Error('new exact line-type revision or scalable >16 path was not resolved');
  }

  viewer.setEntityStyle('mixed-height-area', {
    ...strokeLineTypeStyle,
    stroke: { ...strokeLineTypeStyle.stroke, mode: { kind: 'none' } },
  });
  viewer.render();
  const strokeNone = viewer.entityPresentation('mixed-height-area');
  if (
    strokeNone.find((batch) => batch.kind === 'cadStroke')?.strokeVisible !== false ||
    strokeNone.find((batch) => batch.kind === 'cadFill')?.fillVisible !== true
  ) {
    throw new Error('stroke none did not hide only the area boundary');
  }

  const beforeInvalidStroke = JSON.stringify(strokeNone);
  const generationBeforeInvalidStroke = viewer.worldGeneration();
  let invalidStrokeRejectedAtomically = false;
  try {
    viewer.setEntityStyle('mixed-height-area', {
      ...strokeLineTypeStyle,
      stroke: {
        ...strokeLineTypeStyle.stroke,
        mode: { kind: 'lineType', resourceId: 'missing-line-type' },
      },
    });
  } catch (error) {
    if (!String(error).includes('not registered')) throw error;
    invalidStrokeRejectedAtomically =
      viewer.worldGeneration() === generationBeforeInvalidStroke &&
      JSON.stringify(viewer.entityPresentation('mixed-height-area')) === beforeInvalidStroke;
  }
  if (!invalidStrokeRejectedAtomically) {
    throw new Error('missing line type did not fail before presentation mutation');
  }

  viewer.setEntityStyle('mixed-height-area', {
    ...areaHatchStyle,
    fill: { kind: 'none' },
  });
  viewer.render();
  const none = viewer.entityPresentation('mixed-height-area');
  if (
    none.find((batch) => batch.kind === 'cadFill')?.fillVisible !== false ||
    none.find((batch) => batch.kind === 'cadStroke')?.fillVisible !== true
  ) {
    throw new Error('fill none did not hide only the fill-capable area batch');
  }

  const beforeInvalid = JSON.stringify(none);
  const generationBeforeInvalid = viewer.worldGeneration();
  let invalidAreaTextureRejectedAtomically = false;
  try {
    viewer.setEntityStyle('mixed-height-area', {
      ...areaHatchStyle,
      fill: { kind: 'texture', resourceId: ORTHO_IMAGE_HASH },
    });
  } catch (error) {
    if (!String(error).includes('texture coordinates')) throw error;
    invalidAreaTextureRejectedAtomically =
      viewer.worldGeneration() === generationBeforeInvalid &&
      JSON.stringify(viewer.entityPresentation('mixed-height-area')) === beforeInvalid;
  }
  if (!invalidAreaTextureRejectedAtomically) {
    throw new Error('unmapped area texture did not fail before presentation mutation');
  }

  const rasterStyle = style([1, 1, 1, 1], 1, { kind: 'source' });
  const rasterIdentity = batchIdentity(viewer.entityPresentation('fixture-pixel-steps'));
  viewer.setEntityStyle('fixture-pixel-steps', {
    ...rasterStyle,
    fill: { kind: 'texture', resourceId: ORTHO_IMAGE_HASH },
  });
  viewer.render();
  const textureOverride = viewer.entityPresentation('fixture-pixel-steps');
  if (
    textureOverride.length === 0 ||
    textureOverride.some(
      (batch) =>
        batch.kind !== 'raster' ||
        !batch.declaredTextureCoordinates ||
        batch.usesSourceTexture ||
        !batch.fillVisible,
    )
  ) {
    throw new Error('raster presentation texture was not rebound over declared UVs');
  }
  viewer.setEntityStyle('fixture-pixel-steps', rasterStyle);
  viewer.render();
  const textureRestored = viewer.entityPresentation('fixture-pixel-steps');
  if (textureRestored.some((batch) => !batch.usesSourceTexture || !batch.fillVisible)) {
    throw new Error('color fill did not restore the immutable raster source texture');
  }
  viewer.setEntityStyle('mixed-height-area', strokeLineTypeStyle, BASE[2]);
  viewer.render();
  const areaRestored = viewer.entityPresentation('mixed-height-area');
  const proxyIdentityStable =
    areaIdentity === batchIdentity(hatchAfterLiveStyle) &&
    areaIdentity === batchIdentity(strokeLineType) &&
    areaIdentity === batchIdentity(strokeNone) &&
    areaIdentity === batchIdentity(none) &&
    areaIdentity === batchIdentity(areaRestored) &&
    rasterIdentity === batchIdentity(textureOverride) &&
    rasterIdentity === batchIdentity(textureRestored);
  if (!proxyIdentityStable) {
    throw new Error('presentation-only changes replaced render proxies or draw batches');
  }
  const decodeAfter = viewer.streamDecodeDiagnostics();
  const decodeCountersStable = JSON.stringify(decodeBefore) === JSON.stringify(decodeAfter);
  if (!decodeCountersStable) {
    throw new Error('presentation-only changes entered a provider decode path');
  }
  return {
    canonicalMaterials,
    materialTextureResidency,
    hatchAfterLiveStyle,
    none,
    strokeLineType,
    strokeNone,
    textureOverride,
    textureRestored,
    invalidAreaTextureRejectedAtomically,
    invalidStrokeRejectedAtomically,
    decodeCountersStable,
    proxyIdentityStable,
  };
}

function entityZoo(): LegacyEntityRequest[] {
  const area: AreaGeometry = {
    outer: {
      uses: [
        {
          kind: 'associative',
          reversed: false,
          entityId: 'parcel-boundary',
          expectedVersion: AREA_BOUNDARY_HASH,
        },
      ],
    },
    holes: [
      {
        uses: [
          {
            kind: 'inline',
            reversed: false,
            curve: {
              kind: 'polyline',
              closed: true,
              positions: [
                point(-10, -5, null),
                point(-6, -5, null),
                point(-6, -1, null),
                point(-10, -1, null),
              ],
            },
          },
        ],
      },
    ],
    heightResolution: {
      kind: 'interpolateMissing',
      algorithmId: 'de.himmelcad.height/natural-neighbour',
      algorithmVersion: '1.0.0',
      parameters: AREA_INTERPOLATION_PARAMETERS_HASH,
    },
  };

  return [
    {
      entityId: 'parcel-boundary',
      proxyId: 'parcel-boundary@1',
      versionHash: AREA_BOUNDARY_HASH,
      geometry: {
        kind: 'curve',
        curve: {
          kind: 'polyline',
          closed: true,
          positions: [
            point(-13, -8, 0),
            point(-2, -8, null),
            point(-2, 2, 1.5),
            point(-13, 2, null),
          ],
        },
      },
      placement: placement(),
      unresolvedHeightElevation: 0,
      lineWidth: 1,
      style: style([0.3, 0.72, 1, 1], 0.35),
    },
    {
      entityId: 'survey-point',
      proxyId: 'survey-point@1',
      geometry: { kind: 'point', position: point(0, 0, 4) },
      placement: placement(),
      style: style([1, 0.38, 0.08, 1]),
    },
    {
      entityId: 'mixed-height-area',
      proxyId: 'mixed-height-area@1',
      geometry: { kind: 'area', area },
      areaInterpolationRef: AREA_INTERPOLATION_RESULT_HASH,
      placement: placement(),
      unresolvedHeightElevation: 0,
      fillAreas: true,
      lineWidth: 3,
      style: {
        ...style([0.08, 0.52, 0.92, 1], 0.78),
        fill: hatchFill(diagonalHatchRef, 0.12, [0.94, 0.98, 1, 0.9]),
      },
    },
    {
      entityId: 'analytic-circle',
      proxyId: 'analytic-circle@1',
      geometry: {
        kind: 'curve',
        curve: { kind: 'circle', center: point(6, -7, 2), radius: 4, plane: null },
      },
      placement: placement(),
      chordTolerance: 0.01,
      maximumCurveSegments: 512,
      lineWidth: 4,
      style: style([0.18, 0.95, 0.78, 1]),
    },
    {
      entityId: 'clothoid',
      proxyId: 'clothoid@1',
      geometry: {
        kind: 'curve',
        curve: {
          kind: 'clothoid',
          start: point(-14, 7, 0.5),
          startTangent: { x: 1, y: 0, z: 0 },
          startCurvature: 0,
          endCurvature: 0.12,
          length: 22,
          plane: null,
        },
      },
      placement: placement(),
      chordTolerance: 0.01,
      maximumCurveSegments: 1024,
      lineWidth: 3,
      style: style([0.96, 0.72, 0.16, 1]),
    },
    {
      entityId: 'open-surface',
      proxyId: 'open-surface@1',
      evaluatedMesh: requiredOpenSurfaceTopology().admission,
      geometry: {
        kind: 'surface3d',
        mesh: openSurfaceMesh(),
      },
      placement: placement(),
      style: style([0.35, 0.42, 0.94, 1], 0.82, {
        kind: 'height',
        minimum: BASE[2],
        maximum: BASE[2] + 8,
        colors: [
          [0.08, 0.34, 0.95, 1],
          [0.15, 0.95, 0.65, 1],
          [1, 0.35, 0.08, 1],
        ],
      }),
    },
    {
      entityId: 'road-drape-support',
      proxyId: 'road-drape-support@1',
      versionHash: DRAPE_SUPPORT_HASH,
      geometry: {
        kind: 'elevationSurface',
        surface: {
          kind: 'tin',
          mesh: {
            closedManifold: false,
            triangleMaterialSlots: null,
            materials: null,
            storage: {
              kind: 'inline',
              positions: [
                { x: 20, y: -20, z: 0 },
                { x: 40, y: -20, z: 4 },
                { x: 40, y: 0, z: 8 },
                { x: 20, y: 0, z: 4 },
              ],
              indices: [0, 1, 2, 0, 2, 3],
              normals: null,
              textureCoordinates: null,
            },
          },
          breaklines: [],
        },
      },
      placement: placement(),
      style: style([0.2, 0.46, 0.22, 1], 0.22),
    },
    {
      entityId: 'mixed-draped-parcel',
      proxyId: 'mixed-draped-parcel@1',
      geometry: {
        kind: 'area',
        area: {
          outer: {
            uses: [
              {
                kind: 'inline',
                reversed: false,
                curve: {
                  kind: 'polyline',
                  closed: true,
                  positions: [
                    point(24, -15, 2),
                    point(24, -3, 6),
                    point(36, -3, null),
                    point(36, -15, null),
                  ],
                },
              },
            ],
          },
          holes: [],
          heightResolution: {
            kind: 'drapeMissing',
            supportSurface: 'road-drape-support',
            expectedVersion: DRAPE_SUPPORT_HASH,
            direction: { x: 0, y: 0, z: 1 },
            missPolicy: 'rejectOperation',
          },
        },
      },
      placement: placement(),
      fillAreas: true,
      lineWidth: 3,
      style: style([0.96, 0.38, 0.1, 1], 0.52),
    },
    {
      entityId: 'solid-box',
      proxyId: 'solid-box@1',
      geometry: {
        kind: 'solid',
        solid: {
          kind: 'csg',
          root: {
            kind: 'primitive',
            primitive: { kind: 'box', size: { x: 8, y: 0.5, z: 9 } },
            placement: IDENTITY,
          },
        },
      },
      placement: placement(9, 7.7, 0),
      style: style([0.8, 0.18, 0.48, 1]),
    },
    {
      entityId: 'material-layer-box',
      proxyId: 'material-layer-box@1',
      geometry: {
        kind: 'solid',
        solid: {
          kind: 'closedMesh',
          mesh: {
            storage: {
              kind: 'inline',
              positions: [
                { x: -2, y: -2.25, z: -2 },
                { x: 2, y: -2.25, z: -2 },
                { x: 2, y: -0.25, z: -2 },
                { x: -2, y: -0.25, z: -2 },
                { x: -2, y: -2.25, z: 2 },
                { x: 2, y: -2.25, z: 2 },
                { x: 2, y: -0.25, z: 2 },
                { x: -2, y: -0.25, z: 2 },
                { x: -2, y: 0.25, z: -2 },
                { x: 2, y: 0.25, z: -2 },
                { x: 2, y: 2.25, z: -2 },
                { x: -2, y: 2.25, z: -2 },
                { x: -2, y: 0.25, z: 2 },
                { x: 2, y: 0.25, z: 2 },
                { x: 2, y: 2.25, z: 2 },
                { x: -2, y: 2.25, z: 2 },
              ],
              indices: [
                0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2,
                7, 6, 3, 0, 4, 3, 4, 7, 8, 10, 9, 8, 11, 10, 12, 13, 14, 12, 14, 15, 8, 9, 13, 8,
                13, 12, 9, 10, 14, 9, 14, 13, 10, 11, 15, 10, 15, 14, 11, 8, 12, 11, 12, 15,
              ],
              normals: null,
              textureCoordinates: [
                [0, 0], [1, 0], [1, 1], [0, 1],
                [0, 0], [1, 0], [1, 1], [0, 1],
                [0, 0], [1, 0], [1, 1], [0, 1],
                [0, 0], [1, 0], [1, 1], [0, 1],
              ],
            },
            closedManifold: true,
            triangleMaterialSlots: [
              ...new Array<number>(12).fill(3),
              ...new Array<number>(12).fill(7),
            ],
            materials: {
              resourceId: 'browser-material-table',
              schemaId: 'hcad.resource.material-table@1',
              contentHash: MATERIAL_TABLE_HASH,
            },
          },
        },
      },
      placement: placement(9, 4.75, 0),
      style: style([0.22, 0.52, 0.9, 1]),
    },
    {
      entityId: 'road-alignment',
      proxyId: 'road-alignment@1',
      geometry: {
        kind: 'alignment',
        alignment: {
          horizontal: {
            kind: 'lineSegment',
            start: point(-15, 15, null),
            end: point(15, 15, null),
          },
          vertical: [
            {
              kind: 'grade',
              startStation: 1000,
              startElevation: 0,
              grade: 0.04,
              length: 30,
            },
          ],
          stationOrigin: 1000,
          widthBands: [
            {
              id: 'carriageway',
              innerOffset: {
                samples: [
                  { station: 1000, value: 2 },
                  { station: 1030, value: 2 },
                ],
              },
              outerOffset: {
                samples: [
                  { station: 1000, value: 5 },
                  { station: 1030, value: 5 },
                ],
              },
            },
          ],
          crossfallBands: [
            {
              id: 'lane',
              fromOffset: {
                samples: [
                  { station: 1000, value: 0 },
                  { station: 1030, value: 0 },
                ],
              },
              toOffset: {
                samples: [
                  { station: 1000, value: 5 },
                  { station: 1030, value: 5 },
                ],
              },
              crossfall: {
                samples: [
                  { station: 1000, value: -0.025 },
                  { station: 1030, value: -0.025 },
                ],
              },
            },
          ],
          slopeRules: [],
        },
      },
      placement: placement(),
      unresolvedHeightElevation: 0,
      lineWidth: 2,
      style: style([0.92, 0.96, 1, 1]),
    },
    {
      entityId: 'world-text',
      proxyId: 'world-text@1',
      geometry: {
        kind: 'text',
        text: {
          text: 'HIMMELCAD',
          anchor: point(-12, -11, 1),
          space: 'world',
          height: 1.8,
          font: {
            objectHash: FONT_HASH,
            mediaType: 'application/x-himmelcad-test-atlas',
            byteLength: 4,
          },
        },
      },
      placement: placement(),
      style: style([0.9, 0.95, 1, 1]),
    },
    {
      entityId: 'surface-label',
      proxyId: 'surface-label@1',
      geometry: {
        kind: 'label',
        label: {
          target: { kind: 'position', position: point(4, 9, 4) },
          text: {
            text: 'SURFACE',
            anchor: point(10, 13, 8),
            space: 'world',
            height: 1.2,
            font: {
              objectHash: FONT_HASH,
              mediaType: 'application/x-himmelcad-test-atlas',
              byteLength: 4,
            },
          },
          leader: [point(4, 9, 4), point(8, 11, 6), point(10, 13, 8)],
        },
      },
      placement: placement(),
      lineWidth: 2,
      style: style([0.98, 0.86, 0.28, 1]),
    },
    {
      entityId: 'survey-dimension',
      proxyId: 'survey-dimension@1',
      geometry: {
        kind: 'dimension',
        dimension: {
          dimensionKind: 'aligned',
          anchors: [
            {
              kind: 'entity',
              entityId: 'survey-point',
              expectedVersion: null,
              primitiveId: null,
              parameter: null,
            },
            { kind: 'position', position: point(8, 0, 4) },
          ],
          placement: point(4, -3, 5),
          style: {
            objectHash: DIMENSION_STYLE_HASH,
            mediaType: 'application/x-himmelcad-annotation-style',
            byteLength: null,
          },
        },
      },
      placement: placement(),
      lineWidth: 2,
      style: style([1, 0.92, 0.25, 1]),
    },
    {
      entityId: 'survey-marker-block',
      proxyId: 'survey-marker-block@1',
      geometry: {
        kind: 'block',
        instance: {
          definitionId: 'survey-marker',
          definitionHash: BLOCK_HASH,
          placement: IDENTITY,
          overrides: null,
        },
      },
      placement: placement(-18, -3, 0),
    },
    {
      entityId: 'scan-panorama',
      proxyId: 'scan-panorama@1',
      geometry: {
        kind: 'panorama',
        panorama: {
          image: {
            pixels: { objectHash: PANORAMA_IMAGE_HASH, mediaType: 'image/rgba8', byteLength: 128 },
            width: 8,
            height: 4,
            mapping: {
              kind: 'camera',
              model: { kind: 'equirectangular' },
              pose: relativePlacement(18, -10, 4),
            },
            depth: {
              values: {
                objectHash: PANORAMA_DEPTH_HASH,
                mediaType: 'application/f32',
                byteLength: 128,
              },
              validity: {
                resource: {
                  objectHash: PANORAMA_VALIDITY_HASH,
                  mediaType: 'application/vnd.himmelcad.raster-validity+bitset',
                  byteLength: 4,
                },
                encoding: 'bitsetLsb0',
              },
              confidence: {
                resource: {
                  objectHash: PANORAMA_CONFIDENCE_HASH,
                  mediaType: 'application/vnd.himmelcad.raster-confidence+u8',
                  byteLength: 32,
                },
                encoding: 'unorm8',
              },
              sampling: {
                semantics: 'rayDistance',
                interpolation: 'discontinuityAware',
                connectivity: {
                  kind: 'mask',
                  resource: {
                    objectHash: PANORAMA_CONNECTIVITY_HASH,
                    mediaType: 'application/vnd.himmelcad.raster-triangle-mask+2bit',
                    byteLength: 6,
                  },
                  encoding: 'twoBitsPerCellLsb0',
                  diagonal: 'topLeftToBottomRight',
                },
              },
            },
          },
          stationPointCloud: null,
        },
      },
      placement: placement(),
      style: style([1, 1, 1, 1], 1, { kind: 'source' }),
    },
    {
      entityId: 'boolean-solid',
      proxyId: 'boolean-solid@1',
      versionHash: BOOLEAN_SOLID_VERSION_HASH,
      evaluatedMesh: evaluatedMeshAdmission(),
      geometry: {
        kind: 'solid',
        solid: {
          kind: 'csg',
          root: {
            kind: 'boolean',
            operation: 'union',
            left: {
              kind: 'primitive',
              primitive: { kind: 'box', size: { x: 4, y: 4, z: 4 } },
              placement: IDENTITY,
            },
            right: {
              kind: 'primitive',
              primitive: { kind: 'sphere', radius: 3 },
              placement: IDENTITY,
            },
          },
        },
      },
      placement: placement(17, 13, 1),
      style: style([0.58, 0.2, 0.96, 1]),
    },
    {
      entityId: 'inline-depth-ortho',
      proxyId: 'inline-depth-ortho@1',
      geometry: {
        kind: 'rasterImage',
        raster: {
          pixels: { objectHash: ORTHO_IMAGE_HASH, mediaType: 'image/rgba8', byteLength: 64 },
          width: 4,
          height: 4,
          mapping: {
            kind: 'orthoGrid',
            origin: { x: BASE[0] - 8, y: BASE[1] + 18, z: BASE[2] },
            columnStep: { x: 2, y: 0, z: 0 },
            rowStep: { x: 0, y: 2, z: 0 },
          },
          depth: {
            values: { objectHash: ORTHO_DEPTH_HASH, mediaType: 'application/f32', byteLength: 64 },
            validity: null,
            confidence: null,
            sampling: {
              semantics: 'elevationZ',
              interpolation: 'discontinuityAware',
              connectivity: { kind: 'pixelSteps' },
            },
          },
        },
      },
      style: style([1, 1, 1, 1], 0.88, { kind: 'source' }),
    },
    {
      entityId: 'namespaced-extension',
      proxyId: 'namespaced-extension@1',
      evaluatedMesh: evaluatedMeshAdmission(),
      geometry: {
        kind: 'extension',
        typeId: 'de.himmelcad.test-custom-volume@1',
        payload: EXTENSION_PAYLOAD_HASH,
      },
      placement: placement(-25, 10, 0),
      style: style([0.92, 0.28, 0.72, 1]),
    },
  ];
}

async function run(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewer');
  const status = document.querySelector<HTMLOutputElement>('#status');
  if (canvas === null || status === null) throw new Error('browser fixture DOM is incomplete');

  const moduleLoader = async (): Promise<HimmelcadViewerWasmModule> => {
    const wasmModuleUrl = '/wasm/himmelcad_wasm.js';
    const module = await import(wasmModuleUrl);
    return module as unknown as HimmelcadViewerWasmModule;
  };
  const requestedBackend = new URLSearchParams(window.location.search).get('backend');
  state.phase = 'create-viewer';
  const viewer = await WgpuKernelViewer.create(
    canvas,
    moduleLoader,
    1280,
    720,
    requestedBackend === 'webgl2'
      ? 'webgl2'
      : requestedBackend === 'webgpu'
        ? 'webgpu'
        : 'automatic',
  );
  state.capabilities = viewer.capabilities;
  streamingWorkerPool = new KernelDecodeWorkerPool(
    '/decode-wasm/himmelcad_decode_wasm.js',
    Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)),
    () =>
      new Worker('/decode-worker.js', {
        type: 'module',
        name: 'himmelcad-e2e-streaming-decode',
      }),
    512 * 1024 * 1024,
  );
  viewer.resize(1280, 720, 1);
  state.phase = 'register-resources';
  viewer.setClearColor([0.008, 0.014, 0.024, 1]);
  const worldCamera = {
    eye: { x: BASE[0] + 35, y: BASE[1] - 44, z: BASE[2] + 34 },
    target: { x: BASE[0], y: BASE[1] + 3, z: BASE[2] + 3 },
    up: { x: 0, y: 0, z: 1 },
    projection: {
      kind: 'perspective',
      verticalFovRadians: Math.PI / 3,
      aspect: 1280 / 720,
      near: 0.05,
      far: 100_000,
    },
  } as const;
  viewer.setWorldCamera(worldCamera, BASE);
  const localProfileCamera = new KernelCameraController(1280, 720);
  localProfileCamera.frame(
    { x: BASE[0] - 30, y: BASE[1] - 27, z: BASE[2] - 12 },
    { x: BASE[0] + 30, y: BASE[1] + 33, z: BASE[2] + 18 },
  );
  localProfileCamera.orbit(0.37, -0.16);
  const localProfileReturnCamera = localProfileCamera.worldCamera();
  const inverseRootTwo = Math.SQRT1_2;
  const localProfileFrame = {
    origin: { x: BASE[0], y: BASE[1] + 3, z: BASE[2] + 3 },
    normal: { x: inverseRootTwo, y: -inverseRootTwo, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    verticalSpan: 32,
  } as const;
  state.phase = 'early-pick-readback';
  await viewer.pick(0, 0, 0);
  state.phase = 'prepared-dataset-atomicity';
  await verifyPreparedDatasetGenerationRollback(viewer);
  state.phase = 'register-resources';

  viewer.registerGlyphAtlas(
    FONT_HASH,
    {
      width: 1,
      height: 1,
      lineHeight: 1,
      fallback: '?',
      glyphs: {
        '?': {
          atlasMin: [0, 0],
          atlasMax: [1, 1],
          planeMin: [0, 0],
          planeMax: [0.65, 1],
          advance: 0.7,
        },
      },
    },
    new Uint8Array([255, 255, 255, 255]),
  );
  viewer.registerAnnotationStyle(DIMENSION_STYLE_HASH, {
    glyphAtlasHash: FONT_HASH,
    textHeight: 1.25,
    decimals: 2,
    suffix: ' m',
    lineWidth: 2,
  });
  const unsealedDiagonalHatch: HatchPatternResource = {
    schemaId: 'hcad.resource.hatch-pattern@1',
    resourceId: 'diagonal-survey',
    contentHash: '00'.repeat(32),
    name: 'Diagonal survey',
    pattern: {
      kind: 'lines',
      lines: [{ angle: Math.PI / 4, origin: [0, 0], offset: [0, 1.2], dashPattern: [] }],
    },
  };
  const diagonalHatch: HatchPatternResource = {
    ...unsealedDiagonalHatch,
    contentHash: viewer.hatchPatternResourceContentHash(unsealedDiagonalHatch),
  };
  const unsealedCrossHatch: HatchPatternResource = {
    schemaId: 'hcad.resource.hatch-pattern@1',
    resourceId: 'cross-survey',
    contentHash: '00'.repeat(32),
    name: 'Cross survey',
    pattern: {
      kind: 'lines',
      lines: [
        { angle: 0, origin: [0, 0], offset: [0, 0.65], dashPattern: [1.1, -0.35, 0] },
        { angle: Math.PI / 2, origin: [0, 0], offset: [0.65, 0], dashPattern: [] },
      ],
    },
  };
  const crossHatch: HatchPatternResource = {
    ...unsealedCrossHatch,
    contentHash: viewer.hatchPatternResourceContentHash(unsealedCrossHatch),
  };
  viewer.registerCanonicalHatchPatternResource(diagonalHatch);
  viewer.registerCanonicalHatchPatternResource(crossHatch);
  diagonalHatchRef = {
    resourceId: diagonalHatch.resourceId,
    schemaId: diagonalHatch.schemaId,
    contentHash: diagonalHatch.contentHash,
  };
  crossHatchRef = {
    resourceId: crossHatch.resourceId,
    schemaId: crossHatch.schemaId,
    contentHash: crossHatch.contentHash,
  };
  const registerMaterialTexture = async (
    resourceId: string,
    colorSpace: TextureResource['colorSpace'],
    pixels: Uint8Array,
  ): Promise<CanonicalResourceRef> => {
    const unsealed: TextureResource = {
      schemaId: 'hcad.resource.texture@1',
      resourceId,
      contentHash: '00'.repeat(32),
      pixels: {
        objectHash: await sha256Bytes(pixels),
        mediaType: 'application/x-himmelcad-decoded-rgba8',
        byteLength: pixels.byteLength,
      },
      colorSpace,
      wrapU: 'mirroredRepeat',
      wrapV: 'clampToEdge',
      magFilter: 'nearest',
      minFilter: 'linear',
    };
    const texture: TextureResource = {
      ...unsealed,
      contentHash: viewer.textureResourceContentHash(unsealed),
    };
    viewer.registerCanonicalTextureResource(texture, 2, 2, pixels);
    return {
      resourceId: texture.resourceId,
      schemaId: texture.schemaId,
      contentHash: texture.contentHash,
    };
  };
  const textureRef = await registerMaterialTexture(
    'browser-material-checker',
    'srgb',
    new Uint8Array([
      255, 255, 255, 255, 32, 220, 255, 255,
      255, 80, 48, 255, 255, 255, 255, 255,
    ]),
  );
  const normalTextureRef = await registerMaterialTexture(
    'browser-material-normal',
    'data',
    new Uint8Array([
      128, 128, 255, 255, 172, 128, 246, 255,
      128, 172, 246, 255, 96, 128, 251, 255,
    ]),
  );
  const metallicRoughnessTextureRef = await registerMaterialTexture(
    'browser-material-metallic-roughness',
    'data',
    new Uint8Array([
      255, 48, 224, 255, 255, 128, 160, 255,
      255, 208, 96, 255, 255, 255, 0, 255,
    ]),
  );
  const emissiveTextureRef = await registerMaterialTexture(
    'browser-material-emissive',
    'srgb',
    new Uint8Array([
      255, 64, 16, 255, 64, 128, 255, 255,
      32, 255, 96, 255, 255, 255, 255, 255,
    ]),
  );
  const occlusionTextureRef = await registerMaterialTexture(
    'browser-material-occlusion',
    'data',
    new Uint8Array([
      255, 255, 255, 255, 192, 255, 255, 255,
      96, 255, 255, 255, 32, 255, 255, 255,
    ]),
  );
  MATERIAL_TEXTURE_RESIDENCY = viewer.gpuTextureCacheStats();
  const unsealedSurveyMaterial: MaterialResource = {
    schemaId: 'hcad.resource.material@1',
    resourceId: 'browser-survey-red',
    contentHash: '00'.repeat(32),
    name: 'Survey red',
    baseColor: { red: 1, green: 0.16, blue: 0.08, alpha: 1 },
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.8,
    alphaMode: 'opaque',
    alphaCutoff: null,
    doubleSided: false,
    textureBindings: [],
  };
  const surveyMaterial: MaterialResource = {
    ...unsealedSurveyMaterial,
    contentHash: viewer.materialResourceContentHash(unsealedSurveyMaterial),
  };
  const unsealedTexturedMaterial: MaterialResource = {
    schemaId: 'hcad.resource.material@1',
    resourceId: 'browser-survey-checker',
    contentHash: '00'.repeat(32),
    name: 'Survey checker',
    baseColor: { red: 0.28, green: 1, blue: 0.48, alpha: 1 },
    emissive: [0.12, 0.04, 0.02],
    metallic: 0.7,
    roughness: 0.55,
    alphaMode: 'opaque',
    alphaCutoff: null,
    doubleSided: true,
    textureBindings: [
      {
        slot: 'baseColor',
        texture: textureRef,
        textureCoordinateSet: 0,
        transform: { offset: [0.125, -0.25], scale: [1.5, 0.75], rotation: Math.PI / 6 },
      },
      {
        slot: 'normal',
        texture: normalTextureRef,
        textureCoordinateSet: 0,
        transform: { offset: [0.05, 0.1], scale: [0.8, 1.2], rotation: -Math.PI / 8 },
      },
      {
        slot: 'metallicRoughness',
        texture: metallicRoughnessTextureRef,
        textureCoordinateSet: 0,
        transform: { offset: [-0.15, 0.2], scale: [2, 2], rotation: Math.PI / 10 },
      },
      {
        slot: 'emissive',
        texture: emissiveTextureRef,
        textureCoordinateSet: 0,
        transform: { offset: [0.2, 0.05], scale: [1, 0.5], rotation: 0 },
      },
      {
        slot: 'occlusion',
        texture: occlusionTextureRef,
        textureCoordinateSet: 0,
        transform: { offset: [-0.05, -0.1], scale: [0.6, 0.9], rotation: Math.PI / 12 },
      },
    ],
  };
  const texturedMaterial: MaterialResource = {
    ...unsealedTexturedMaterial,
    contentHash: viewer.materialResourceContentHash(unsealedTexturedMaterial),
  };
  const surveyMaterialRef: CanonicalResourceRef = {
    resourceId: surveyMaterial.resourceId,
    schemaId: surveyMaterial.schemaId,
    contentHash: surveyMaterial.contentHash,
  };
  const texturedMaterialRef: CanonicalResourceRef = {
    resourceId: texturedMaterial.resourceId,
    schemaId: texturedMaterial.schemaId,
    contentHash: texturedMaterial.contentHash,
  };
  const tableMaterials = new Array<CanonicalResourceRef>(8).fill(surveyMaterialRef);
  tableMaterials[7] = texturedMaterialRef;
  const unsealedMaterialTable: MaterialTableResource = {
    schemaId: 'hcad.resource.material-table@1',
    resourceId: 'browser-material-table',
    contentHash: '00'.repeat(32),
    materials: tableMaterials,
  };
  const materialTable: MaterialTableResource = {
    ...unsealedMaterialTable,
    contentHash: viewer.materialTableResourceContentHash(unsealedMaterialTable),
  };
  MATERIAL_TABLE_HASH = materialTable.contentHash;
  viewer.registerCanonicalMaterialResourceSet({
    textures: [],
    materials: [surveyMaterial, texturedMaterial],
    materialTables: [materialTable],
    hatchPatterns: [],
    lineTypes: [],
    annotationStyles: [],
  });
  viewer.registerLineTypeResource('survey-dash', {
    segments: [2.4, 0.8, 0.25, 0.8],
    phase: 0.15,
  });
  viewer.register3dTilesDataset(
    'fixture-3d-metadata',
    '3d-tiles@1.1',
    'https://example.test/metadata/tileset.json',
    jsonBytes({
      asset: { version: '1.1' },
      schemaUri: 'city.schema.json',
      metadata: { class: 'city', properties: { epoch: 2025.5 } },
      groups: [{ class: 'discipline', properties: { name: 'survey' } }],
      root: {
        boundingVolume: { sphere: [BASE[0], BASE[1], BASE[2], 1] },
        geometricError: 0,
        metadata: { class: 'tile', properties: { quality: 'authoritative' } },
      },
    }),
  );
  state.tilesMetadata = viewer.threeDTilesMetadata('fixture-3d-metadata');
  state.phase = 'feature-metadata-worker-streams';
  const featureStreamId = 'fixture-3d-metadata/feature-glb';
  let featureProxyId = 'feature-glb@1';
  const companionStreamId = 'fixture-3d-metadata/feature-glb-companion';
  const featureBytes = featureMetadataGlb();
  await stage3dTilesContent(
    viewer,
    {
      streamId: featureStreamId,
      entityId: 'feature-glb',
      proxyId: featureProxyId,
      datasetId: 'fixture-3d-metadata',
      tileId: 'feature',
      contentUri: 'memory:///fixture-3d-metadata/feature.glb',
      contentKind: 'gltf',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: BASE[0], y: BASE[1], z: BASE[2] },
          max: { x: BASE[0] + 1, y: BASE[1], z: BASE[2] + 1 },
        },
      },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, BASE[0], BASE[1], BASE[2], 1],
      style: style([0.35, 0.8, 1, 1]),
    },
    featureBytes,
  );
  await stage3dTilesContent(
    viewer,
    {
      streamId: companionStreamId,
      entityId: 'feature-glb-companion',
      proxyId: 'feature-glb-companion@1',
      datasetId: 'fixture-3d-metadata',
      tileId: 'feature-companion',
      contentUri: 'memory:///fixture-3d-metadata/feature-companion.glb',
      contentKind: 'gltf',
      bounds: {
        kind: 'axisAlignedBox',
        bounds: {
          min: { x: BASE[0] + 2, y: BASE[1], z: BASE[2] },
          max: { x: BASE[0] + 3, y: BASE[1], z: BASE[2] + 1 },
        },
      },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, BASE[0] + 2, BASE[1], BASE[2], 1],
      style: style([0.35, 0.8, 1, 1]),
    },
    featureBytes,
  );
  state.atomicPublish = viewer.publishStagedContents([featureStreamId, companionStreamId]);
  featureProxyId =
    state.atomicPublish.streams.find((stream) => stream.streamId === featureStreamId)
      ?.proxyIds[0] ?? featureProxyId;
  const resolvedFeature = viewer.gltfFeatureMetadata(featureProxyId, 0, {
    x: BASE[0],
    y: BASE[1],
    z: BASE[2],
  });
  viewer.remove3dTilesContent(featureStreamId);
  viewer.remove3dTilesContent(companionStreamId);
  let evicted = false;
  try {
    viewer.gltfFeatureMetadata(featureProxyId, 0, {
      x: BASE[0],
      y: BASE[1],
      z: BASE[2],
    });
  } catch {
    evicted = true;
  }
  state.gltfFeatureMetadata = { resolved: resolvedFeature, evicted };
  const interpolatedArea: AreaGeometry = {
    outer: {
      uses: [
        {
          kind: 'inline',
          reversed: false,
          curve: {
            kind: 'polyline',
            closed: true,
            positions: [
              point(-13, -8, 0),
              point(-2, -8, 0.75),
              point(-2, 2, 1.5),
              point(-13, 2, 1),
            ],
          },
        },
      ],
    },
    holes: [
      {
        uses: [
          {
            kind: 'inline',
            reversed: false,
            curve: {
              kind: 'polyline',
              closed: true,
              positions: [
                point(-10, -5, 0.4),
                point(-6, -5, 0.5),
                point(-6, -1, 0.6),
                point(-10, -1, 0.5),
              ],
            },
          },
        ],
      },
    ],
    heightResolution: null,
  };
  const centerStyleResource = {
    resourceId: 'survey-marker-center-style',
    schemaId: 'hcad.resource.render-style@1',
    contentHash: 'c1'.repeat(32),
  };
  const ringStyleResource = {
    resourceId: 'survey-marker-ring-style',
    schemaId: 'hcad.resource.render-style@1',
    contentHash: 'c2'.repeat(32),
  };
  viewer.registerBlockMemberStyle(centerStyleResource, style([1, 0.16, 0.1, 1]));
  viewer.registerBlockMemberStyle(ringStyleResource, style([1, 0.82, 0.12, 1]));
  const blockDefinition: KernelBlockDefinition = {
    schemaId: 'hcad.resource.block-definition@1',
    definitionId: 'survey-marker',
    contentHash: '00'.repeat(32),
    placementComposition: 'instanceThenMember',
    members: [
      {
        memberId: 'center',
        placement: IDENTITY,
        source: {
          kind: 'inline',
          geometry: { kind: 'point', position: point(0, 0, 3) },
          style: { kind: 'resource', style: centerStyleResource },
        },
      },
      {
        memberId: 'ring',
        placement: IDENTITY,
        source: {
          kind: 'inline',
          geometry: {
            kind: 'curve',
            curve: { kind: 'circle', center: point(0, 0, 3), radius: 2, plane: null },
          },
          style: { kind: 'resource', style: ringStyleResource },
        },
      },
    ],
  };
  BLOCK_HASH = viewer.blockDefinitionContentHash(blockDefinition);
  viewer.registerBlockDefinition({ ...blockDefinition, contentHash: BLOCK_HASH });
  const panoramaPixels = new Uint8Array(8 * 4 * 4);
  for (let index = 0; index < 8 * 4; index += 1) {
    panoramaPixels.set(index % 2 === 0 ? [30, 180, 255, 255] : [255, 110, 30, 255], index * 4);
  }
  viewer.registerImageResource(PANORAMA_IMAGE_HASH, 8, 4, panoramaPixels);
  viewer.registerDepthResource(PANORAMA_DEPTH_HASH, 8, 4, new Float32Array(8 * 4).fill(3));
  viewer.registerRasterBinaryResource(
    PANORAMA_VALIDITY_HASH,
    new Uint8Array([255, 255, 255, 127]),
  );
  viewer.registerRasterBinaryResource(
    PANORAMA_CONFIDENCE_HASH,
    new Uint8Array([
      255, 230, 204, 179, 153, 128, 102, 77, 51, 26, 0, 26, 51, 77, 102, 128, 153, 179, 204,
      230, 255, 230, 204, 179, 153, 128, 102, 77, 51, 26, 0, 26,
    ]),
  );
  viewer.registerRasterBinaryResource(
    PANORAMA_CONNECTIVITY_HASH,
    new Uint8Array([255, 255, 255, 255, 255, 255]),
  );
  const evaluatedMesh = evaluatedClosedMesh();
  EVALUATED_MESH_HASH = viewer.geometryObjectContentHash({
    kind: 'surface3d',
    mesh: evaluatedMesh,
  });
  viewer.registerMeshResource(EVALUATED_MESH_HASH, evaluatedMesh);
  await prepareEvaluatedClosedMeshTopology(viewer, evaluatedMesh);
  await prepareOpenSurfaceTopology(viewer);
  const orthoPixels = new Uint8Array(4 * 4 * 4);
  for (let index = 0; index < 16; index += 1) {
    orthoPixels.set(index % 2 === 0 ? [30, 220, 100, 255] : [15, 80, 220, 255], index * 4);
  }
  viewer.registerImageResource(ORTHO_IMAGE_HASH, 4, 4, orthoPixels);
  viewer.registerDepthResource(
    ORTHO_DEPTH_HASH,
    4,
    4,
    new Float32Array(Array.from({ length: 16 }, (_, index) => BASE[2] + (index % 4) * 0.7)),
  );
  state.phase = 'canonical-entity-zoo';
  // Orthographic rasters are provider-backed by contract and are exercised by
  // the canonical worker fixture below, not admitted as fake inline geometry.
  const zooRequests = entityZoo().filter((request) => request.entityId !== 'inline-depth-ortho');
  const boundaryRequest = zooRequests.find((request) => request.entityId === 'parcel-boundary');
  const mixedAreaRequest = zooRequests.find((request) => request.entityId === 'mixed-height-area');
  if (boundaryRequest === undefined || mixedAreaRequest === undefined) {
    throw new Error('entity zoo omitted the associative area fixtures');
  }
  await publishLegacyRequests(viewer, [boundaryRequest]);
  const mixedAreaAdmission = await canonicalizeLegacyRequest(viewer, mixedAreaRequest);
  AREA_INTERPOLATION_RESULT_HASH = viewer.geometryObjectContentHash({
    kind: 'area',
    area: interpolatedArea,
  });
  const interpolationDependency = {
    resultGeometryRef: AREA_INTERPOLATION_RESULT_HASH,
    sourceGeometryRef: mixedAreaAdmission.admission.selected.geometryRef,
    sourceEntityVersion: mixedAreaAdmission.admission.entity.versionHash,
    algorithmId: 'de.himmelcad.height/natural-neighbour',
    algorithmVersion: '1.0.0',
    parameters: AREA_INTERPOLATION_PARAMETERS_HASH,
  };
  viewer.registerAreaInterpolation({
    ...interpolationDependency,
    dependencyHash: viewer.areaInterpolationDependencyHash(interpolationDependency),
    area: interpolatedArea,
  });
  const remainingAdmissions: KernelCanonicalRenderAdmission[] = [
    {
      ...mixedAreaAdmission,
      areaInterpolationRef: AREA_INTERPOLATION_RESULT_HASH,
    },
  ];
  for (const request of zooRequests) {
    if (request === boundaryRequest || request === mixedAreaRequest) continue;
    remainingAdmissions.push(await canonicalizeLegacyRequest(viewer, request));
  }
  const zooMutation = viewer.publishCanonicalRepresentations(remainingAdmissions);
  for (const binding of zooMutation.bindings) {
    admittedGenerations.set(binding.key.slot.entityId, binding.generation);
  }
  state.entityCount = zooMutation.entities;
  state.proxyCount = zooMutation.proxies;

  const referencedSurveyPointAdmission = remainingAdmissions.find(
    ({ admission }) => admission.entity.id === 'survey-point',
  );
  const referencedSurveyPoint = referencedSurveyPointAdmission?.admission.entity;
  if (referencedSurveyPointAdmission === undefined || referencedSurveyPoint === undefined) {
    throw new Error('entity-reference block fixture has no canonical survey point');
  }
  const referenceBlockDraft: KernelBlockDefinition = {
    schemaId: 'hcad.resource.block-definition@1',
    definitionId: 'survey-point-reference',
    contentHash: '00'.repeat(32),
    placementComposition: 'instanceThenMember',
    members: [
      {
        memberId: 'exact-survey-point-revision',
        placement: IDENTITY,
        source: {
          kind: 'entityReference',
          entity: {
            id: referencedSurveyPoint.id,
            revision: referencedSurveyPoint.revision,
            versionHash: referencedSurveyPoint.versionHash,
          },
        },
      },
    ],
  };
  const referenceBlockHash = viewer.blockDefinitionContentHash(referenceBlockDraft);
  viewer.registerBlockDefinition({ ...referenceBlockDraft, contentHash: referenceBlockHash });
  const referenceBlockAdmission = await canonicalizeLegacyRequest(viewer, {
    entityId: 'survey-point-reference-block',
    geometry: {
      kind: 'block',
      instance: {
        definitionId: 'survey-point-reference',
        definitionHash: referenceBlockHash,
        placement: IDENTITY,
        overrides: null,
      },
    },
    placement: placement(-14, 5, 0),
  });
  const referenceBlockMutation = viewer.publishCanonicalRepresentations([
    referenceBlockAdmission,
  ]);
  if (referenceBlockMutation.bindings.length !== 1 || referenceBlockMutation.proxies === 0) {
    throw new Error('canonical entity-reference block did not publish atomically');
  }
  state.entityCount = referenceBlockMutation.entities;
  state.proxyCount = referenceBlockMutation.proxies;

  const canonicalDocument = await KernelCanonicalDocument.create(moduleLoader);
  const sourceDocumentEntity = remainingAdmissions[0]?.admission.entity;
  if (sourceDocumentEntity === undefined) throw new Error('document authority fixture has no entity');
  const documentEntityDraft = {
    ...sourceDocumentEntity,
    revision: 0,
    versionHash: '00'.repeat(32),
  };
  const documentEntity = {
    ...documentEntityDraft,
    versionHash: viewer.canonicalEntityVersionHash(documentEntityDraft),
  };
  canonicalDocument.execute({
    commandId: 'document-create-fixture',
    mutations: [{ operation: 'create', entity: documentEntity }],
  } satisfies CanonicalCommandTransaction);
  const createdDocumentEntity = canonicalDocument.entity(documentEntity.id);
  if (createdDocumentEntity === null) throw new Error('document create did not publish its entity');
  canonicalDocument.execute({
    commandId: 'document-rename-fixture',
    mutations: [
      {
        operation: 'update',
        expected: {
          id: createdDocumentEntity.id,
          revision: createdDocumentEntity.revision,
          versionHash: createdDocumentEntity.versionHash,
        },
        edits: [{ kind: 'setName', name: 'Temporary document name' }],
      },
    ],
  } satisfies CanonicalCommandTransaction);
  canonicalDocument.undo('document-undo-rename', 'document-rename-fixture');
  const restoredDocumentEntity = canonicalDocument.entity(documentEntity.id);
  if (restoredDocumentEntity === null) throw new Error('document undo lost its entity');
  const durableJournal = canonicalDocument.journal();
  const replayedDocument = await KernelCanonicalDocument.create(moduleLoader, durableJournal);
  const replayedEntity = replayedDocument.entity(documentEntity.id);
  if (replayedEntity === null) throw new Error('document replay lost its entity');
  state.canonicalDocument = {
    generation: canonicalDocument.generation,
    journalEntries: durableJournal.length,
    restoredName: restoredDocumentEntity.name,
    replayedName: replayedEntity.name,
  };
  replayedDocument.dispose();
  canonicalDocument.dispose();

  const transactionRequests: LegacyEntityRequest[] = [
    {
      entityId: 'survey-point',
      proxyId: 'survey-point@2',
      revision: 2,
      versionHash: POINT_VERSION_HASH,
      geometry: { kind: 'point', position: point(0, 0, 4) },
      placement: placement(),
      style: style([1, 0.38, 0.08, 1]),
    },
    {
      entityId: 'survey-dimension',
      proxyId: 'survey-dimension@2',
      revision: 2,
      versionHash: DIMENSION_VERSION_HASH,
      geometry: {
        kind: 'dimension',
        dimension: {
          dimensionKind: 'aligned',
          anchors: [
            {
              kind: 'entity',
              entityId: 'survey-point',
              expectedVersion: POINT_VERSION_HASH,
              primitiveId: null,
              parameter: null,
            },
            { kind: 'position', position: point(8, 0, 4) },
          ],
          placement: point(4, -3, 5),
          style: {
            objectHash: DIMENSION_STYLE_HASH,
            mediaType: 'application/x-himmelcad-annotation-style',
            byteLength: null,
          },
        },
      },
      placement: placement(),
      lineWidth: 2,
      style: style([1, 0.92, 0.25, 1]),
    },
  ];
  const transaction = await publishLegacyRequests(viewer, transactionRequests);
  state.entityCount = transaction.entities;
  state.proxyCount = transaction.proxies;
  if (viewer.canonicalEntityBindings('survey-point-reference-block').length !== 1) {
    throw new Error('live source update invalidated an immutable entity-reference block capture');
  }
  state.phase = 'alignment-preview';
  const initialLiveAlignment = liveAlignmentGeometry(5);
  const initialLiveAlignmentVersion = viewer.geometryObjectContentHash({
    kind: 'alignment',
    alignment: initialLiveAlignment,
  });
  const initialAlignmentPreview = viewer.buildAlignmentPreview('live-road-edit', {
    alignment: initialLiveAlignment,
    alignmentVersion: initialLiveAlignmentVersion,
    targets: [],
    config: {
      chordTolerance: 0.01,
      maximumCurveSegments: 128,
      partitionLength: 10,
      sampleStep: 10,
      maximumPartitionsPerUpdate: 1,
      maximumSamplesPerPartition: 4,
      maximumRoadBandsPerPartition: 8,
      maximumSlopeRulesPerPartition: 8,
    },
  });
  state.alignmentPreview = {
    initial: initialAlignmentPreview,
    updated: null,
    staleRejected: false,
    staleGenerationStable: false,
  };
  window.__HCAD_FOCUS_ALIGNMENT_PREVIEW__ = (): void =>
    setFocusedTopCamera(viewer, { x: BASE[0], y: BASE[1] + 18, z: BASE[2] + 2 }, 18);
  window.__HCAD_UPDATE_ALIGNMENT_PREVIEW__ = (): AlignmentPreviewBrowserValidation => {
    const currentPreview = state.alignmentPreview;
    if (currentPreview === null) throw new Error('alignment preview state is missing');
    if (currentPreview.updated !== null) return currentPreview;
    const updatedAlignment = liveAlignmentGeometry(7);
    const updatedAlignmentVersion = viewer.geometryObjectContentHash({
      kind: 'alignment',
      alignment: updatedAlignment,
    });
    const request = {
      expectedGeneration: initialAlignmentPreview.generation,
      alignmentVersion: updatedAlignmentVersion,
      horizontalPathVersion: initialAlignmentPreview.horizontalPathVersion,
      partitions: [
        {
          index: 1,
          stationRange: { start: 1_010, end: 1_020 },
          roadBody: [
            {
              id: 'carriageway',
              samples: [
                {
                  station: 1_010,
                  inner: { x: BASE[0] - 5, y: BASE[1] + 15, z: BASE[2] + 2 },
                  outer: { x: BASE[0] - 5, y: BASE[1] + 22, z: BASE[2] + 2 },
                },
                {
                  station: 1_020,
                  inner: { x: BASE[0] + 5, y: BASE[1] + 15, z: BASE[2] + 2 },
                  outer: { x: BASE[0] + 5, y: BASE[1] + 22, z: BASE[2] + 2 },
                },
              ],
            },
          ],
        },
      ],
      targets: [],
      affected: { start: 1_010.1, end: 1_019.9 },
    } as const;
    const updated = viewer.updateAlignmentPreview('live-road-edit', request);
    const generationAfterUpdate = viewer.worldGeneration();
    let staleRejected = false;
    try {
      viewer.updateAlignmentPreview('live-road-edit', request);
    } catch (error) {
      if (!String(error).includes('stale')) throw error;
      staleRejected = true;
    }
    state.alignmentPreview = {
      initial: initialAlignmentPreview,
      updated,
      staleRejected,
      staleGenerationStable: viewer.worldGeneration() === generationAfterUpdate,
    };
    viewer.render();
    return state.alignmentPreview;
  };
  window.__HCAD_REMOVE_ALIGNMENT_PREVIEW__ = (): boolean => {
    const removed = viewer.removeAlignmentPreview('live-road-edit');
    viewer.render();
    return removed;
  };
  state.phase = 'provider-worker-fixtures';
  const providerFixtures = await installProviderFixtures(viewer);
  state.phase = 'resolved-presentation-bindings';
  state.presentationBindings = verifyResolvedPresentationBindings(viewer);
  const syntheticPointTarget = { x: BASE[0] + 700, y: BASE[1], z: BASE[2] };
  const syntheticPointProxyId = 'synthetic-batch-point/root@1';
  await stage3dTilesContent(
    viewer,
    {
      streamId: 'synthetic-batch-point/root',
      entityId: 'synthetic-batch-point',
      proxyId: syntheticPointProxyId,
      datasetId: 'synthetic-batch-point',
      tileId: 'root',
      contentUri: 'memory:///synthetic-batch-point.pnts',
      contentKind: 'threeDTilesContainer',
      bounds: { kind: 'sphere', center: syntheticPointTarget, radius: 1 },
      contentTransform: [
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        syntheticPointTarget.x,
        syntheticPointTarget.y,
        syntheticPointTarget.z,
        1,
      ],
      style: style([1, 0.2, 0.9, 1]),
    },
    syntheticBatchPointPnts(),
  );
  viewer.publishStagedContents(['synthetic-batch-point/root']);
  const realGlb =
    new URLSearchParams(location.search).get('real') === '1' ? await installRealGlb(viewer) : null;
  const realExternal = realGlb === null ? null : await installRealExternalI3dm(viewer);
  const realTiles = realExternal === null ? null : await installRealTiles(viewer);
  const realExternalJson = realExternal === null ? null : await installRealExternalJsonGltf(viewer);
  const preparedTexturedMesh =
    realExternal === null ? null : await installPreparedTexturedMesh(viewer);
  const realLegacyMetadata = realExternal === null ? null : await installRealLegacyMetadata(viewer);
  state.phase = 'authoritative-sections';
  const sectionVertices = [
    { x: BASE[0] + 14, y: BASE[1] + 10, z: BASE[2] + 3.5 },
    { x: BASE[0] + 20, y: BASE[1] + 10, z: BASE[2] + 3.5 },
    { x: BASE[0] + 20, y: BASE[1] + 16, z: BASE[2] + 3.5 },
    { x: BASE[0] + 14, y: BASE[1] + 16, z: BASE[2] + 3.5 },
  ] as const;
  const booleanSolidVersionHash = canonicalVersionByLegacyVersion.get(BOOLEAN_SOLID_VERSION_HASH);
  if (booleanSolidVersionHash === undefined)
    throw new Error('boolean solid canonical version was not admitted');
  const sectionProduct: KernelAuthoritativeSectionProduct = {
    schemaVersion: 2,
    source: {
      entityId: 'boolean-solid',
      datasetId: null,
      versionHash: booleanSolidVersionHash,
      topologyHash: EVALUATED_TOPOLOGY_HASH,
      closedManifold: true,
      parts: [{ partId: 'body-0', topologyHash: EVALUATED_TOPOLOGY_HASH }],
    },
    plane: {
      origin: { x: BASE[0] + 17, y: BASE[1] + 13, z: BASE[2] + 3.5 },
      normal: { x: 0, y: 0, z: 1 },
    },
    tolerance: 0.0001,
    materialRegions: [
      {
        regionIndex: 0,
        regionId: 'boolean-solid:cut-face',
        materialKey: 'material:default',
      },
    ],
    product: {
      segments: [
        { start: sectionVertices[0], end: sectionVertices[1], materialSlot: 0 },
        { start: sectionVertices[1], end: sectionVertices[2], materialSlot: 0 },
        { start: sectionVertices[2], end: sectionVertices[3], materialSlot: 0 },
        { start: sectionVertices[3], end: sectionVertices[0], materialSlot: 0 },
      ],
      regions: [
        {
          materialSlot: 0,
          outer: { points: sectionVertices },
          holes: [],
          vertices: sectionVertices,
          indices: [0, 1, 2, 0, 2, 3],
        },
      ],
    },
  };
  SECTION_PRODUCT_HASH = viewer.sectionProductContentHash(sectionProduct);
  viewer.registerSectionProduct(SECTION_PRODUCT_HASH, sectionProduct);
  const section = viewer.upsertSection({
    sectionId: 'streamed-solid-section',
    entityId: 'boolean-solid',
    productHash: SECTION_PRODUCT_HASH,
    plane: {
      origin: { x: BASE[0] + 17, y: BASE[1] + 13, z: BASE[2] + 3.5 },
      normal: { x: 0, y: 0, z: 1 },
    },
    tolerance: 0.0001,
    style: style([0.96, 0.76, 0.12, 1]),
    materialHatches: {
      'material:default': {
        resource: diagonalHatchRef,
        lineWidth: 0.12,
        color: [0.94, 0.98, 1, 0.9],
      },
    },
  });
  state.proxyCount = section.proxies;
  const authoritativeCapVolume = {
    id: 'authoritative-streamed-cap-box',
    planes: [
      { normal: { x: 0, y: 0, z: 1 }, distance: -(BASE[2] + 3.5) },
      { normal: { x: 1, y: 0, z: 0 }, distance: -(BASE[0] + 16) },
      { normal: { x: -1, y: 0, z: 0 }, distance: BASE[0] + 18 },
      { normal: { x: 0, y: 1, z: 0 }, distance: -(BASE[1] + 11.5) },
      { normal: { x: 0, y: -1, z: 0 }, distance: BASE[1] + 14.5 },
    ],
    operation: 'keepInside',
    previewCap: true,
    sectionFill: {
      resource: diagonalHatchRef,
      lineWidth: 0.12,
      color: [0.94, 0.98, 1, 0.9],
    },
    enabled: true,
  } as const;
  const booleanSolidBinding = zooMutation.bindings.find(
    (binding) => binding.key.slot.entityId === 'boolean-solid',
  );
  if (booleanSolidBinding === undefined) {
    throw new Error('boolean solid canonical binding is missing');
  }
  const closedTopology = requiredClosedMeshTopology();
  const clipCapCoordinator = new KernelClipCapCoordinator(viewer, {
    fetchImmutableResource(reference): Promise<Uint8Array> {
      const bytes = closedTopology.resources.get(reference.uri);
      if (bytes === undefined) return Promise.reject(new Error(`missing ${reference.uri}`));
      return Promise.resolve(bytes.slice());
    },
  });
  await clipCapCoordinator.synchronize({
    volumes: [authoritativeCapVolume],
    sources: [
      {
        entityId: 'boolean-solid',
        binding: booleanSolidBinding,
        sectionTopologyParts: closedTopology.locations,
        closedManifold: true,
        tolerance: sectionProduct.tolerance,
        style: style([0.96, 0.76, 0.12, 1]),
      },
    ],
  });
  const expectedCapId = `clip-cap:boolean-solid:${authoritativeCapVolume.id}:0`;
  state.authoritativeClipCap = {
    compiled: clipCapCoordinator.committedSectionIds().includes(expectedCapId),
    clippedVolumeId: authoritativeCapVolume.id,
    planeIndex: 0,
  };
  await clipCapCoordinator.synchronize({ volumes: [], sources: [] });
  clipCapCoordinator.dispose();
  const openProfileRequest = {
    sectionId: 'open-tin-profile',
    plane: {
      origin: { x: BASE[0] + 1, y: BASE[1] + 8, z: BASE[2] },
      normal: { x: 1, y: 0, z: 0 },
    },
    tolerance: 0.0001,
    style: style([0.1, 1, 0.72, 1]),
  } as const;
  const openTinBinding = zooMutation.bindings.find(
    (binding) => binding.key.slot.entityId === 'open-surface',
  ) as GeometryRepresentationBindingRef | undefined;
  if (openTinBinding === undefined) throw new Error('open TIN canonical binding is missing');
  const openTinTopology = requiredOpenSurfaceTopology();
  const openTinProduct = await evaluateCanonicalSectionTopologyWith(
    viewer,
    {
      fetchImmutableResource(reference): Promise<Uint8Array> {
        const bytes = openTinTopology.resources.get(reference.uri);
        if (bytes === undefined) return Promise.reject(new Error(`missing ${reference.uri}`));
        return Promise.resolve(bytes.slice());
      },
    },
    {
      operationId: 'browser-open-tin-section-evaluation',
      binding: openTinBinding,
      plane: openProfileRequest.plane,
      tolerance: 0.0001,
      parts: openTinTopology.locations,
    },
  );
  const openTinProductHash = viewer.sectionProductContentHash(openTinProduct);
  viewer.registerSectionProduct(openTinProductHash, openTinProduct);
  const evaluatedOpenProfileRequest = {
    ...openProfileRequest,
    entityId: 'open-surface',
    productHash: openTinProductHash,
  } as const;
  const openProfile = viewer.upsertSection(evaluatedOpenProfileRequest);
  const openTinEndpoints = openTinProduct.product.segments.flatMap((segment) => [
    segment.start,
    segment.end,
  ]);
  state.authoritativeOpenTin = {
    segments: openTinProduct.product.segments.length,
    regions: openTinProduct.product.regions.length,
    sourceParts: openTinProduct.source.parts.length,
    projectBounds: {
      minimum: {
        x: Math.min(...openTinEndpoints.map((point) => point.x)),
        y: Math.min(...openTinEndpoints.map((point) => point.y)),
        z: Math.min(...openTinEndpoints.map((point) => point.z)),
      },
      maximum: {
        x: Math.max(...openTinEndpoints.map((point) => point.x)),
        y: Math.max(...openTinEndpoints.map((point) => point.y)),
        z: Math.max(...openTinEndpoints.map((point) => point.z)),
      },
    },
  };
  state.proxyCount = openProfile.proxies;
  state.phase = 'transferable-worker-proof';
  const workerPool = streamingWorkerPool;
  if (workerPool === null) throw new Error('streaming worker pool was disposed too early');
  const workerAuthority = await ensureStreamBinding(
    viewer,
    {
      datasetId: 'worker-proof',
      entityId: 'worker-proof',
    },
    {
      kind: 'gaussianSplatCloud',
      dataset: {
        formatId: '3dgs-ply@1',
        metadata: { objectHash: '04'.repeat(32), mediaType: 'application/ply', byteLength: null },
        elementCount: 50_000,
      },
    },
  );
  const workerMetadata = {
    streamId: 'worker-proof/splats',
    slot: workerAuthority.binding.key.slot,
    binding: workerAuthority.binding,
    datasetId: workerAuthority.datasetId,
    tileId: 'root',
    bounds: { kind: 'sphere', center: { x: BASE[0], y: BASE[1], z: BASE[2] }, radius: 1 },
    maximumSplats: 50_000,
  };
  const workerPrimary = workerLoadGaussianPly(50_000);
  const workerPrimaryBuffer =
    workerPrimary.buffer instanceof ArrayBuffer
      ? workerPrimary.buffer
      : workerPrimary.slice().buffer;
  let workerCompleted = false;
  let eventLoopTickedBeforeCompletion = false;
  const workerDecodeJob = {
    kind: 'gaussianSplats',
    metadataJson: JSON.stringify(workerMetadata),
    bundleManifestJson: '{"schemaVersion":1,"entries":[]}',
    decodeParametersJson: '',
    primary: workerPrimaryBuffer,
    bundle: new ArrayBuffer(0),
    secondary: new ArrayBuffer(0),
  } as const;
  const workerExpectedInputHash = await decodeInputManifestHash(workerDecodeJob);
  const workerDecode = workerPool
    .decode(workerDecodeJob, new AbortController().signal)
    .then((result) => {
      workerCompleted = true;
      return result;
    });
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      eventLoopTickedBeforeCompletion = !workerCompleted;
      resolve();
    }, 0),
  );
  const workerResult = await workerDecode;
  const workerMetadataJson = JSON.stringify(workerMetadata);
  const ingestStarted = performance.now();
  viewer.stageDecodedStreamingPayload(
    'gaussianSplats',
    workerMetadataJson,
    new Uint8Array(workerResult.artifact),
    new Uint8Array(workerResult.primary),
    '{"schemaVersion":1,"entries":[]}',
    new Uint8Array(workerResult.bundle),
    new Uint8Array(workerResult.secondary),
    '',
    workerExpectedInputHash,
  );
  const ingestMs = performance.now() - ingestStarted;
  viewer.discardStagedContent('worker-proof/splats');
  state.decodeWorker = {
    workerContext: workerResult.workerContext,
    eventLoopTickedBeforeCompletion,
    artifactBytes: workerResult.artifact.byteLength,
    artifactMagic: new TextDecoder().decode(new Uint8Array(workerResult.artifact, 0, 8)),
    inputBytes: workerResult.primary.byteLength,
    ingestMs,
    diagnostics: workerPool.diagnostics(),
  };
  workerPool.dispose();
  const decodeBeforeRebuildMutations = viewer.streamDecodeDiagnostics();
  const repeatTransaction = await publishLegacyRequests(viewer, transactionRequests);
  state.entityCount = repeatTransaction.entities;
  state.proxyCount = repeatTransaction.proxies;
  viewer.setEntityStyle('survey-point', style([1, 0.38, 0.08, 1]));
  viewer.setWorldCamera(worldCamera, [BASE[0] + 1_024, BASE[1] - 512, BASE[2] + 64]);
  viewer.setWorldCamera(worldCamera, BASE);
  viewer.setClipVolumes([]);
  viewer.upsertSection(evaluatedOpenProfileRequest);
  state.streamDecodeRebuild = {
    before: decodeBeforeRebuildMutations,
    after: viewer.streamDecodeDiagnostics(),
  };
  viewer.beginMovePreview('box-drag-preview', 'solid-box', 0.42);
  viewer.updateMovePreview('box-drag-preview', { x: -10, y: 1, z: 2 });

  state.capabilities = viewer.capabilities;
  state.hardwarePolicy = viewer.resolveHardwarePolicy({
    gpuMemoryBytes: null,
    systemMemoryBytes: 16 * 1024 ** 3,
    logicalCores: navigator.hardwareConcurrency || 4,
  });
  state.phase = 'calibration';
  let calibration = viewer.beginHardwareCalibration();
  for (let attempt = 0; calibration.calibration === null && attempt < 600; attempt += 1) {
    calibration = viewer.stepHardwareCalibration();
    state.calibration = calibration;
    viewer.render();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (calibration.calibration === null) {
    throw new Error(`hardware calibration did not complete: ${JSON.stringify(calibration)}`);
  }
  state.calibration = calibration;
  state.hardwarePolicy = viewer.resolveHardwarePolicy(
    {
      gpuMemoryBytes: null,
      systemMemoryBytes: 16 * 1024 ** 3,
      logicalCores: navigator.hardwareConcurrency || 4,
    },
    calibration.calibration,
  );

  window.__HCAD_APPLY_CLIP__ = () => {
    viewer.setClipVolumes([
      {
        id: 'solid-box-cutaway',
        planes: [
          { normal: { x: 1, y: 0, z: 0 }, distance: -(BASE[0] + 8) },
          { normal: { x: -1, y: 0, z: 0 }, distance: BASE[0] + 10 },
          { normal: { x: 0, y: 1, z: 0 }, distance: -(BASE[1] + 2) },
          { normal: { x: 0, y: -1, z: 0 }, distance: BASE[1] + 8 },
          { normal: { x: 0, y: 0, z: 1 }, distance: -(BASE[2] - 3) },
          { normal: { x: 0, y: 0, z: -1 }, distance: BASE[2] + 3 },
        ],
        operation: 'keepInside',
        previewCap: true,
        sectionFill: null,
        sectionMaterialHatches: {
          3: { resource: crossHatchRef, lineWidth: 0.1, color: [1, 0.72, 0.2, 0.95] },
          7: {
            resource: diagonalHatchRef,
            lineWidth: 0.12,
            color: [0.94, 0.98, 1, 0.9],
          },
        },
        enabled: true,
      },
    ]);
    viewer.render();
    return {
      batchCount: viewer.clipPreviewBatchCount(),
      materialSlots: viewer.clipPreviewMaterialSlots(),
    };
  };
  window.__HCAD_APPLY_REMOVE_CLIP__ = () => {
    viewer.setClipVolumes([
      {
        id: 'solid-box-opening',
        planes: [
          { normal: { x: 1, y: 0, z: 0 }, distance: -(BASE[0] + 8) },
          { normal: { x: -1, y: 0, z: 0 }, distance: BASE[0] + 10 },
          { normal: { x: 0, y: 1, z: 0 }, distance: -(BASE[1] + 2) },
          { normal: { x: 0, y: -1, z: 0 }, distance: BASE[1] + 8 },
          { normal: { x: 0, y: 0, z: 1 }, distance: -(BASE[2] - 3) },
          { normal: { x: 0, y: 0, z: -1 }, distance: BASE[2] + 3 },
        ],
        operation: 'removeInside',
        previewCap: true,
        sectionFill: null,
        sectionMaterialHatches: {
          3: { resource: crossHatchRef, lineWidth: 0.1, color: [1, 0.72, 0.2, 0.95] },
          7: {
            resource: diagonalHatchRef,
            lineWidth: 0.12,
            color: [0.94, 0.98, 1, 0.9],
          },
        },
        enabled: true,
      },
    ]);
    viewer.render();
    return {
      batchCount: viewer.clipPreviewBatchCount(),
      materialSlots: viewer.clipPreviewMaterialSlots(),
    };
  };
  window.__HCAD_CLEAR_CLIP__ = (): void => {
    viewer.setClipVolumes([]);
    viewer.render();
  };
  window.__HCAD_RESET_CAMERA__ = (): void => {
    viewer.setWorldCamera(worldCamera, BASE);
    viewer.render();
  };
  window.__HCAD_FOCUS_LOCAL_PROFILE__ = (): LocalProfileViewValidation => {
    const transition = localProfileCamera.setLocalOrthographicFrame(localProfileFrame);
    const origin = localProfileCamera.recommendedFloatingOrigin();
    viewer.setCameraTransition(transition.from, transition.to, 1, origin);
    viewer.setWorldCamera(transition.to, origin);
    viewer.render();
    if (transition.to.projection.kind !== 'orthographic') {
      throw new Error('local profile controller did not produce an orthographic camera');
    }
    state.localProfileView = {
      projection: transition.to.projection.kind,
      target: transition.to.target,
      centerCoordinate: localProfileCamera.worldPointOnTargetPlane(0, 0),
      cornerCoordinate: localProfileCamera.worldPointOnTargetPlane(0.6, 0.5),
      restoredExact: null,
    };
    return state.localProfileView;
  };
  window.__HCAD_APPLY_LOCAL_PROFILE_DEPTH__ = (): LocalProfileDepthValidation => {
    const volume = localSectionClipVolume({
      id: 'browser-local-profile-depth',
      frame: localProfileFrame,
      depth: { towardCamera: 2, awayFromCamera: 8 },
    });
    viewer.setScopedClipVolume('browser-local-profile-depth', volume);
    viewer.render();
    return {
      planeCount: volume.planes.length,
      previewCap: volume.previewCap,
      previewBatchCount: viewer.clipPreviewBatchCount(),
    };
  };
  window.__HCAD_CLEAR_LOCAL_PROFILE_DEPTH__ = (): void => {
    viewer.setScopedClipVolume('browser-local-profile-depth', null);
    viewer.render();
  };
  window.__HCAD_EXIT_LOCAL_PROFILE__ = (): LocalProfileViewValidation => {
    const previous = state.localProfileView;
    const transition = localProfileCamera.clearLocalOrthographicFrame();
    if (previous === null || transition === null) {
      throw new Error('local profile frame is not active');
    }
    viewer.setScopedClipVolume('browser-local-profile-depth', null);
    const origin = localProfileCamera.recommendedFloatingOrigin();
    viewer.setCameraTransition(transition.from, transition.to, 1, origin);
    viewer.setWorldCamera(transition.to, origin);
    viewer.render();
    state.localProfileView = {
      ...previous,
      restoredExact: JSON.stringify(transition.to) === JSON.stringify(localProfileReturnCamera),
    };
    return state.localProfileView;
  };
  window.__HCAD_FOCUS_USER_VIEWPOINT__ = (): UserPerspectiveViewValidation => {
    const viewpoint = {
      eye: { x: BASE[0] + 48.25, y: BASE[1] - 31.5, z: BASE[2] + 22.75 },
      target: { x: BASE[0], y: BASE[1] + 3, z: BASE[2] + 3 },
      verticalFovRadians: Math.PI / 2.8,
    } as const;
    const transition = localProfileCamera.setPerspectiveViewpoint(viewpoint);
    const origin = localProfileCamera.recommendedFloatingOrigin();
    viewer.setCameraTransition(transition.from, transition.to, 1, origin);
    viewer.setWorldCamera(transition.to, origin);
    viewer.render();
    if (transition.to.projection.kind !== 'perspective') {
      throw new Error('user viewpoint controller did not produce a perspective camera');
    }
    return {
      projection: transition.to.projection.kind,
      eyeError: Math.hypot(
        transition.to.eye.x - viewpoint.eye.x,
        transition.to.eye.y - viewpoint.eye.y,
        transition.to.eye.z - viewpoint.eye.z,
      ),
      targetExact: JSON.stringify(transition.to.target) === JSON.stringify(viewpoint.target),
      verticalFovRadians: transition.to.projection.verticalFovRadians,
    };
  };
  window.__HCAD_FOCUS_VERTICAL_EXAGGERATION__ =
    async (): Promise<VerticalExaggerationValidation> => {
      const factor = 4;
      const datum = BASE[2];
      const sourceTarget = { x: BASE[0] + 1, y: BASE[1] + 8, z: BASE[2] + 3 };
      const presentedTarget = {
        ...sourceTarget,
        z: datum + (sourceTarget.z - datum) * factor,
      };
      viewer.setClipVolumes([]);
      viewer.setEntityStyle(
        'open-surface',
        {
          ...style([0.35, 0.42, 0.94, 1], 0.82, {
            kind: 'height',
            minimum: BASE[2],
            maximum: BASE[2] + 8,
            colors: [
              [0.08, 0.34, 0.95, 1],
              [0.15, 0.95, 0.65, 1],
              [1, 0.35, 0.08, 1],
            ],
          }),
          verticalExaggeration: factor,
        },
        datum,
      );
      setFocusedOrientedCamera(
        viewer,
        presentedTarget,
        { x: 0.45, y: -0.75, z: 0.48 },
        { x: -0.24, y: 0.4, z: 0.88 },
        40,
      );
      return {
        factor,
        datum,
        sourceTarget,
        presentedTarget,
        pick: await viewer.pick(640, 360, 8),
      };
    };
  window.__HCAD_APPLY_VERTICAL_EXAGGERATION_CLIP__ = async (): Promise<KernelPickResult> => {
    viewer.setClipVolumes([
      {
        id: 'exaggerated-source-height-clip',
        planes: [{ normal: { x: 0, y: 0, z: -1 }, distance: BASE[2] + 3.5 }],
        operation: 'keepInside',
        previewCap: false,
        enabled: true,
      },
    ]);
    viewer.render();
    return viewer.pick(640, 360, 8);
  };
  window.__HCAD_CLEAR_VERTICAL_EXAGGERATION__ = (): void => {
    viewer.setClipVolumes([]);
    viewer.setEntityStyle(
      'open-surface',
      style([0.35, 0.42, 0.94, 1], 0.82, {
        kind: 'height',
        minimum: BASE[2],
        maximum: BASE[2] + 8,
        colors: [
          [0.08, 0.34, 0.95, 1],
          [0.15, 0.95, 0.65, 1],
          [1, 0.35, 0.08, 1],
        ],
      }),
      BASE[2],
    );
    viewer.setWorldCamera(worldCamera, BASE);
    viewer.render();
  };
  window.__HCAD_FOCUS_STREAMED_EXAGGERATION__ =
    async (): Promise<StreamedExaggerationValidation> => {
      const factor = 4;
      const sourcePoint = providerFixtures.potree.expectedWorldPosition;
      const datum = sourcePoint.z - 10;
      const presentedPoint = {
        ...sourcePoint,
        z: datum + (sourcePoint.z - datum) * factor,
      };
      const potreeStyle = (verticalExaggeration: number): KernelRenderStyle => ({
        ...style([1, 1, 1, 1], 1, { kind: 'pointClassification', colors: [] }),
        verticalExaggeration,
      });
      const streamingOptions = {
        resourceBudget: state.hardwarePolicy!.resources,
        frameBudget: state.hardwarePolicy!.frame,
        maximumScreenSpaceError: 4,
        detailScale: 1,
        maximumTraversedNodes: 50_000,
        includeRenderKeys: true,
      } as const;
      viewer.setClipVolumes([]);
      viewer.setEntityStyle('fixture-potree-point', potreeStyle(1), datum);
      setFocusedFrontCamera(viewer, presentedPoint);
      const identityPlan = viewer.planStreamingFrame(streamingOptions);
      const decodeBefore = viewer.streamDecodeDiagnostics();
      viewer.setEntityStyle('fixture-potree-point', potreeStyle(factor), datum);
      const selectedPlan = viewer.planStreamingFrame(streamingOptions);
      const fetchAction = selectedPlan.actions.find(
        (action) => action.kind === 'fetchTile' && action.ticket.key.datasetId === 'fixture-potree',
      );
      if (fetchAction?.kind !== 'fetchTile') {
        throw new Error(
          `presentation-aware selection did not request fixture-potree: ${JSON.stringify(selectedPlan)}`,
        );
      }
      const zeroCost = {
        cpuCompressedBytes: 0,
        cpuDecodedBytes: 0,
        gpuBufferBytes: 0,
        gpuTextureBytes: 0,
        stagingBytes: 0,
        points: 0,
        triangles: 0,
        splats: 0,
        drawCalls: 0,
      } as const;
      viewer.streamingFetched(fetchAction.ticket, zeroCost);
      const decodePlan = viewer.planStreamingFrame(streamingOptions);
      const decodeAction = decodePlan.actions.find(
        (action) =>
          action.kind === 'decodeTile' && action.ticket.key.datasetId === 'fixture-potree',
      );
      if (decodeAction?.kind !== 'decodeTile') {
        throw new Error(
          `selected fixture-potree did not enter decoding: ${JSON.stringify(decodePlan)}`,
        );
      }
      viewer.streamingDecoded(decodeAction.ticket, zeroCost);
      const uploadPlan = viewer.planStreamingFrame(streamingOptions);
      const uploadAction = uploadPlan.actions.find(
        (action) =>
          action.kind === 'uploadTile' && action.ticket.key.datasetId === 'fixture-potree',
      );
      if (uploadAction?.kind !== 'uploadTile') {
        throw new Error(
          `decoded fixture-potree did not enter upload: ${JSON.stringify(uploadPlan)}`,
        );
      }
      viewer.streamingUploaded(uploadAction.ticket, zeroCost);
      const exaggeratedPlan = viewer.planStreamingFrame(streamingOptions);
      viewer.render();
      const pick = await viewer.pick(640, 360, 4);
      const decodeAfter = viewer.streamDecodeDiagnostics();
      return {
        factor,
        datum,
        sourcePoint,
        presentedPoint,
        identityPlan,
        exaggeratedPlan,
        pick,
        decodeCountersStable:
          decodeBefore.mainThreadProviderDecodes === decodeAfter.mainThreadProviderDecodes &&
          decodeBefore.workerArtifactIngests === decodeAfter.workerArtifactIngests,
      };
    };
  window.__HCAD_CLEAR_STREAMED_EXAGGERATION__ = (): void => {
    viewer.setEntityStyle(
      'fixture-potree-point',
      style([1, 1, 1, 1], 1, { kind: 'pointClassification', colors: [] }),
      0,
    );
    viewer.setWorldCamera(worldCamera, BASE);
    viewer.render();
  };
  window.__HCAD_FOCUS_STREAMED_MOVE_PREVIEW__ =
    async (): Promise<StreamedMovePreviewValidation> => {
      const sourcePoint = providerFixtures.potree.expectedWorldPosition;
      const translation = { x: 750.125, y: -420.25, z: 15.5 };
      const targetPoint = {
        x: sourcePoint.x + translation.x,
        y: sourcePoint.y + translation.y,
        z: sourcePoint.z + translation.z,
      };
      const previewId = 'streamed-potree-move-target';
      viewer.beginMovePreview(previewId, 'fixture-potree-point', 0.5);
      viewer.updateMovePreview(previewId, translation);
      setFocusedFrontCamera(viewer, targetPoint);
      const primaryPlan = viewer.planStreamingFrame({
        resourceBudget: state.hardwarePolicy!.resources,
        frameBudget: state.hardwarePolicy!.frame,
        maximumScreenSpaceError: 4,
        detailScale: 1,
        maximumTraversedNodes: 50_000,
        includeRenderKeys: true,
      });
      const targetTiles = viewer.movePreviewTargetTiles(previewId);
      const currentBinding = viewer.canonicalStreamBinding('fixture-potree');
      let staleRejected = false;
      try {
        viewer.transformEntity(
          {
            commandId: 'e2e-potree-stale-move',
            entityId: 'fixture-potree-point',
            expectedRevision: currentBinding.key.entityRevision - 1,
            expectedVersionHash: currentBinding.key.entityVersionHash,
            targetPlacement: null,
          },
          [currentBinding],
        );
      } catch {
        staleRejected = true;
      }
      const staleRejectedAtomically =
        staleRejected &&
        viewer.entityCommandJournal().entries.length === 0 &&
        viewer.movePreviewTargetTiles(previewId).length === targetTiles.length;
      viewer.render();
      const decodeBefore = viewer.streamDecodeDiagnostics();
      const committed = viewer.commitMovePreview(previewId, 'e2e-potree-move');
      const previewConsumed = !viewer.removeMovePreview(previewId);
      const targetPlan = viewer.planStreamingFrame({
        resourceBudget: state.hardwarePolicy!.resources,
        frameBudget: state.hardwarePolicy!.frame,
        maximumScreenSpaceError: 4,
        detailScale: 1,
        maximumTraversedNodes: 50_000,
        includeRenderKeys: true,
      });
      viewer.render();
      const targetPick = await viewer.pick(640, 360, 4);
      const undone = viewer.undoEntityCommand('e2e-potree-move-undo', committed.bindings);
      const redone = viewer.redoEntityCommand('e2e-potree-move-redo', undone.bindings);
      const restored = viewer.undoEntityCommand('e2e-potree-move-restore', redone.bindings);
      const journal = viewer.entityCommandJournal();
      const decodeAfter = viewer.streamDecodeDiagnostics();
      viewer.setWorldCamera(worldCamera, BASE);
      viewer.render();
      return {
        sourcePoint,
        targetPoint,
        translation,
        primaryPlan,
        targetTiles,
        staleRejectedAtomically,
        targetPlan,
        targetPick,
        committedRevision: committed.entity.revision,
        undoRevision: undone.entity.revision,
        redoRevision: redone.entity.revision,
        restoredRevision: restored.entity.revision,
        generations: [
          committed.bindings[0]?.generation ?? -1,
          undone.bindings[0]?.generation ?? -1,
          redone.bindings[0]?.generation ?? -1,
          restored.bindings[0]?.generation ?? -1,
        ],
        previewConsumed,
        decodeCountersStable:
          decodeBefore.mainThreadProviderDecodes === decodeAfter.mainThreadProviderDecodes &&
          decodeBefore.workerArtifactIngests === decodeAfter.workerArtifactIngests,
        proxyCountStable:
          committed.proxies === undone.proxies &&
          committed.proxies === redone.proxies &&
          committed.proxies === restored.proxies,
        journalEntries: journal.entries.length,
        canUndo: journal.canUndo,
        canRedo: journal.canRedo,
      };
    };
  if (realGlb !== null) {
    window.__HCAD_FOCUS_REAL__ = (): void => setFocusedFrontCamera(viewer, realGlb.target);
  }
  if (realTiles !== null) {
    window.__HCAD_FOCUS_REAL_TILES__ = (): void =>
      setFocusedOrientedCamera(
        viewer,
        { x: 1215011.9317263428, y: -4736309.3434217675, z: 4081602.0044800863 },
        { x: 0.19023226619126932, y: -0.7415555652213445, z: 0.6433560667227647 },
        { x: -0.15986460744966327, y: 0.623177611820219, z: 0.765567091384559 },
        220,
      );
  }
  if (realExternal !== null) {
    window.__HCAD_FOCUS_REAL_EXTERNAL__ = (): void =>
      setFocusedOrientedCamera(
        viewer,
        realExternal.target,
        { x: 0.19023226619126932, y: -0.7415555652213445, z: 0.6433560667227647 },
        { x: -0.15986460744966327, y: 0.623177611820219, z: 0.765567091384559 },
        220,
      );
  }
  if (realExternalJson !== null) {
    window.__HCAD_FOCUS_REAL_EXTERNAL_JSON__ = (): void =>
      setFocusedTopCamera(viewer, realExternalJson.target);
  }
  if (preparedTexturedMesh !== null) {
    window.__HCAD_FOCUS_PREPARED_TEXTURED__ = (): void =>
      setFocusedTopCamera(viewer, preparedTexturedMesh.target);
  }

  state.phase = 'frames';
  viewer.render();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const durations: number[] = [];
  for (let frame = 0; frame < 30; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const started = performance.now();
    const outcome = viewer.render();
    const duration = performance.now() - started;
    if (outcome.status !== 'presented') throw new Error(`frame ${String(frame)} was not presented`);
    durations.push(duration);
  }
  state.frameDurationsMs = durations;
  state.gpuFrameTiming = viewer.gpuFrameTiming();
  state.phase = 'pick';
  state.pick = await viewer.pick(640, 360, 8);
  state.pickFrameTiming = {
    before: state.gpuFrameTiming,
    after: viewer.gpuFrameTiming(),
  };
  const surveyPointSource = { x: BASE[0], y: BASE[1], z: BASE[2] + 4 };
  const surveyPointDatum = BASE[2];
  const surveyPointFactor = 4;
  const surveyPointPresented = {
    ...surveyPointSource,
    z: surveyPointDatum + (surveyPointSource.z - surveyPointDatum) * surveyPointFactor,
  };
  viewer.setEntityStyle(
    'survey-point',
    { ...style([1, 0.38, 0.08, 1]), verticalExaggeration: surveyPointFactor },
    surveyPointDatum,
  );
  setFocusedTopCamera(viewer, surveyPointPresented);
  state.exactPointPick = await viewer.pick(640, 360, 4);
  viewer.setEntityStyle('survey-point', style([1, 0.38, 0.08, 1]), 0);
  viewer.setWorldCamera(worldCamera, BASE);
  viewer.render();
  const generationBeforeRebase = viewer.worldGeneration();
  viewer.setWorldCamera(worldCamera, [BASE[0] + 1_024, BASE[1] - 512, BASE[2] + 64]);
  viewer.render();
  const rebasePick = await viewer.pick(640, 360, 8);
  state.originRebase = {
    generationStable: viewer.worldGeneration() === generationBeforeRebase,
    pick: rebasePick,
  };

  state.phase = 'provider-picks';
  setFocusedTopCamera(viewer, providerFixtures.potree.expectedWorldPosition);
  const visibilityDecodeBefore = viewer.streamDecodeDiagnostics();
  viewer.setEntityVisibility('fixture-potree-point', false);
  viewer.render();
  const hiddenPotreePick = await viewer.pick(640, 360, 2);
  if (
    hiddenPotreePick.candidates.some(
      (candidate) => candidate.address.entityId === 'fixture-potree-point',
    )
  ) {
    throw new Error('hidden Potree entity remained pickable');
  }
  viewer.setEntityVisibility('fixture-potree-point', true);
  viewer.render();
  const potreePick = await viewer.pick(640, 360, 2);
  if (JSON.stringify(viewer.streamDecodeDiagnostics()) !== JSON.stringify(visibilityDecodeBefore)) {
    throw new Error('entity visibility toggled resident Potree decode state');
  }
  const providerPotreeProxyId = providerFixtures.potree.publish.streams[0]?.proxyIds[0];
  if (providerPotreeProxyId === undefined) {
    throw new Error('Potree metadata fixture publication omitted its stable proxy identity');
  }
  const potreeCandidate = potreePick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-potree-point' &&
      candidate.address.renderProxyId === providerPotreeProxyId &&
      candidate.address.primitiveId !== null,
  );
  if (potreeCandidate === undefined || potreeCandidate.address.primitiveId === null) {
    throw new Error('Potree metadata fixture did not produce an exact point pick');
  }
  const potreeMetadata = viewer.pickMetadata(
    potreeCandidate.address.renderProxyId,
    potreeCandidate.address.primitiveId,
    potreeCandidate.worldPosition,
  );
  setFocusedTopCamera(viewer, providerFixtures.raster.expectedLowSample);
  const rasterLowPick = await viewer.pick(640, 360, 1);
  setFocusedTopCamera(viewer, providerFixtures.raster.expectedHighSample);
  const rasterHighPick = await viewer.pick(640, 360, 1);
  setFocusedTopCamera(viewer, {
    x: providerFixtures.raster.expectedHighSample.x + 2,
    y: providerFixtures.raster.expectedHighSample.y,
    z: BASE[2] + 20,
  });
  const rasterNoDataPick = await viewer.pick(640, 360, 1);
  setFocusedTopCamera(viewer, providerFixtures.gaussian.expectedMean);
  const gaussianMeanPick = await viewer.pick(640, 360, 2);
  const gaussianCoveragePick = await viewer.pick(652, 360, 1);
  setFocusedSideCamera(viewer, providerFixtures.gaussian.expectedMean, 1);
  const gaussianProxyId = providerFixtures.gaussian.publish.streams[0]?.proxyIds[0];
  if (gaussianProxyId === undefined) throw new Error('Gaussian publish omitted its proxy identity');
  const gaussianPositiveSideOrder = viewer.gaussianSplatOrder(gaussianProxyId);
  setFocusedSideCamera(viewer, providerFixtures.gaussian.expectedMean, -1);
  const gaussianNegativeSideOrder = viewer.gaussianSplatOrder(gaussianProxyId);
  setFocusedTopCamera(viewer, DRAPED_UNKNOWN_VERTEX);
  state.drapePick = await viewer.pick(640, 360, 3);
  setFocusedTopCamera(viewer, DRAPED_KNOWN_VERTEX);
  state.drapeKnownPick = await viewer.pick(640, 360, 3);
  setFocusedTopCamera(viewer, INTERPOLATED_VERTEX);
  state.interpolationPick = await viewer.pick(640, 360, 3);
  setFocusedTopCamera(viewer, EXTENSION_TOP);
  state.extensionPick = await viewer.pick(640, 360, 2);
  setFocusedOrientedCamera(
    viewer,
    syntheticPointTarget,
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
    4,
  );
  const syntheticPointHit = await findEntityPick(viewer, 'synthetic-batch-point');
  if (syntheticPointHit.candidate.address.primitiveId === null) {
    throw new Error('synthetic pnts GPU pick has no exact source point');
  }
  state.syntheticPointMetadata = {
    pick: syntheticPointHit.pick,
    metadata: viewer.pickMetadata(
      syntheticPointHit.candidate.address.renderProxyId,
      syntheticPointHit.candidate.address.primitiveId,
      syntheticPointHit.candidate.worldPosition,
    ),
  };
  if (realGlb !== null) {
    setFocusedFrontCamera(viewer, realGlb.target);
    state.realGlb = {
      ...realGlb,
      pick: await viewer.pick(640, 360, 2),
    };
  }
  if (realTiles !== null) {
    setFocusedOrientedCamera(
      viewer,
      realTiles.rootTarget,
      { x: 0.19023226619126932, y: -0.7415555652213445, z: 0.6433560667227647 },
      { x: -0.15986460744966327, y: 0.623177611820219, z: 0.765567091384559 },
      12,
    );
    const rootPick = await viewer.pick(640, 360, 3);
    setFocusedOrientedCamera(
      viewer,
      realTiles.instanceTarget,
      { x: 0.19023226619126932, y: -0.7415555652213445, z: 0.6433560667227647 },
      { x: -0.15986460744966327, y: 0.623177611820219, z: 0.765567091384559 },
      12,
    );
    const instancePick = await viewer.pick(640, 360, 3);
    const instanceSurface = instancePick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'cesium-transformed-instances' &&
        candidate.snapKind === 'surface',
    );
    state.realTiles = {
      ...realTiles,
      rootPick,
      instancePick,
      instanceMetadata:
        instanceSurface === undefined || instanceSurface.address.primitiveId === null
          ? null
          : viewer.gltfFeatureMetadata(
              instanceSurface.address.renderProxyId,
              instanceSurface.address.primitiveId,
              instanceSurface.worldPosition,
            ),
    };
  }
  if (realLegacyMetadata !== null) {
    setFocusedOrientedCamera(
      viewer,
      realLegacyMetadata.hierarchyTarget,
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 },
      120,
    );
    const hierarchyHit = await findEntityPick(viewer, 'legacy-hierarchy');
    if (hierarchyHit.candidate.address.primitiveId === null) {
      throw new Error('hierarchy b3dm pick has no exact source triangle');
    }
    const hierarchyMetadata = viewer.pickMetadata(
      hierarchyHit.candidate.address.renderProxyId,
      hierarchyHit.candidate.address.primitiveId,
      hierarchyHit.candidate.worldPosition,
    );
    setFocusedOrientedCamera(
      viewer,
      realLegacyMetadata.pointTarget,
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 },
      12,
    );
    const pointPick = await viewer.pick(640, 360, 8);
    const pointMetadata = viewer.pickMetadata(
      realLegacyMetadata.pointProxyId,
      0,
      realLegacyMetadata.pointTarget,
    );
    state.realLegacyMetadata = {
      hierarchyPublish: realLegacyMetadata.hierarchyPublish,
      pointPublish: realLegacyMetadata.pointPublish,
      hierarchyPick: hierarchyHit.pick,
      pointPick,
      hierarchyMetadata,
      pointMetadata,
    };
  }
  if (realExternal !== null) {
    setFocusedOrientedCamera(
      viewer,
      realExternal.target,
      { x: 0.19023226619126932, y: -0.7415555652213445, z: 0.6433560667227647 },
      { x: -0.15986460744966327, y: 0.623177611820219, z: 0.765567091384559 },
      30,
    );
    state.realExternal = {
      ...realExternal,
      pick: await viewer.pick(640, 360, 3),
    };
  }
  if (realExternalJson !== null) {
    setFocusedTopCamera(viewer, realExternalJson.target);
    const pick = await viewer.pick(640, 360, 2);
    const surface = pick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'external-json-textured-triangle' &&
        candidate.snapKind === 'surface',
    );
    state.realExternalJson = {
      ...realExternalJson,
      pick,
      structuralMetadata:
        surface === undefined || surface.address.primitiveId === null
          ? null
          : viewer.gltfFeatureMetadata(
              surface.address.renderProxyId,
              surface.address.primitiveId,
              surface.worldPosition,
            ).structuralMetadata,
    };
  }
  if (preparedTexturedMesh !== null) {
    setFocusedTopCamera(viewer, preparedTexturedMesh.target);
    state.preparedTexturedMesh = {
      ...preparedTexturedMesh,
      pick: await viewer.pick(550, 360, 1),
    };
  }
  state.providerFixtures = {
    potree: { ...providerFixtures.potree, pick: potreePick, metadata: potreeMetadata },
    raster: {
      ...providerFixtures.raster,
      lowPick: rasterLowPick,
      highPick: rasterHighPick,
      noDataPick: rasterNoDataPick,
    },
    gaussian: {
      ...providerFixtures.gaussian,
      meanPick: gaussianMeanPick,
      coveragePick: gaussianCoveragePick,
      positiveSideOrder: gaussianPositiveSideOrder,
      negativeSideOrder: gaussianNegativeSideOrder,
    },
  };
  viewer.setWorldCamera(worldCamera, BASE);
  viewer.render();
  state.generation = viewer.worldGeneration().toString();
  state.phase = 'ready';
  state.ready = true;
  status.value = `${String(state.entityCount)} entities · ${String(state.proxyCount)} proxies · ${viewer.capabilities.backend} · p95 CPU submit ${percentile(durations, 0.95).toFixed(2)} ms`;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

void run().catch((error: unknown) => {
  state.error =
    error instanceof Error
      ? `[${state.phase}] ${error.name}: ${error.message}\n${error.stack ?? ''}`
      : `[${state.phase}] ${String(error)}`;
  const status = document.querySelector<HTMLOutputElement>('#status');
  if (status !== null) status.value = state.error;
  console.error(error);
});

export {};
