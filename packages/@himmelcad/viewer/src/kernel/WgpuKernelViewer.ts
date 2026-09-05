import type {
  AlignmentGeometry,
  BlockDefinition,
  BlockMember,
  CanonicalRepresentationAdmission,
  CanonicalResourceRef,
  CanonicalEntity,
  CanonicalEntityEffect,
  EntityVersionRef,
  GeometryObject,
  GeometryRepresentationBindingRef,
  GeometryRepresentationSlotKey,
  HatchPatternResource,
  LineTypeResource,
  MaterialResource,
  MaterialTableResource,
  RasterImageGeometry,
  SectionTopologyPartitionManifest,
  Transform3d,
  TriangleMeshGeometry,
  TextureResource,
} from './generated/index.js';
import {
  KernelClipCapCoordinator,
  type KernelClipCapFetcher,
  type KernelClipCapSource,
} from './KernelClipCapCoordinator.js';
import type { KernelSectionTopologyPartitionLocation } from './KernelSectionTopologyEvaluation.js';

/** Typed boundary to the wasm-bindgen output of `himmelcad-wasm`. */
export interface WasmViewerBinding {
  resize(width: number, height: number): void;
  set_view_projection(values: Float32Array): void;
  set_world_camera_json(cameraJson: string): void;
  set_camera_transition_json(transitionJson: string, progress: number): void;
  set_floating_origin(x: number, y: number, z: number): void;
  set_clear_color(r: number, g: number, b: number, a: number): void;
  set_point_size(pointSize: number): void;
  canonical_entity_version_hash_json(entityJson: string): string;
  geometry_object_content_hash_json(geometryJson: string): string;
  block_definition_content_hash_json(definitionJson: string): string;
  line_type_resource_content_hash_json(resourceJson: string): string;
  hatch_pattern_resource_content_hash_json(resourceJson: string): string;
  texture_resource_content_hash_json(resourceJson: string): string;
  material_resource_content_hash_json(resourceJson: string): string;
  material_table_resource_content_hash_json(resourceJson: string): string;
  section_topology_partition_content_hash_json(manifestJson: string): string;
  section_product_content_hash_json(productJson: string): string;
  publish_canonical_representations_json(admissionsJson: string): string;
  apply_committed_entity_effect_json?(effectJson: string, expectedBindingsJson: string): string;
  transform_entity_json(commandJson: string, expectedBindingsJson: string): string;
  commit_move_preview_json(previewId: string, commandId: string): string;
  undo_entity_command_json(commandId: string, expectedBindingsJson: string): string;
  redo_entity_command_json(commandId: string, expectedBindingsJson: string): string;
  entity_command_journal_json(): string;
  inspect_3d_tiles_dependencies_json(metadataJson: string, bytes: Uint8Array): string;
  gpu_model_cache_json(): string;
  gpu_texture_cache_json(): string;
  stream_decode_diagnostics_json(): string;
  entity_presentation_json?(entityId: string): string;
  potree_decode_parameters_json(datasetId: string): string;
  stage_decoded_streaming_payload(
    kind: string,
    metadataJson: string,
    artifact: Uint8Array,
    primary: Uint8Array,
    bundleManifestJson: string,
    bundle: Uint8Array,
    secondary: Uint8Array,
    decodeParametersJson: string,
    expectedInputHash: string,
  ): string;
  remove_3d_tiles_content(streamId: string): boolean;
  remove_potree_content(streamId: string): boolean;
  remove_gaussian_splat_content(streamId: string): boolean;
  publish_staged_contents_json(streamIdsJson: string): string;
  remove_raster_content(streamId: string): boolean;
  discard_staged_content(streamId: string): boolean;
  register_3d_tiles_dataset(
    datasetId: string,
    formatId: string,
    tilesetUri: string,
    tilesetJson: Uint8Array,
  ): string;
  three_d_tiles_metadata_json(datasetId: string): string;
  gltf_feature_metadata_json(
    renderProxyId: string,
    sourcePrimitiveId: number,
    worldX: number,
    worldY: number,
    worldZ: number,
  ): string;
  pick_metadata_json(
    renderProxyId: string,
    sourcePrimitiveId: number,
    worldX: number,
    worldY: number,
    worldZ: number,
  ): string;
  register_potree_dataset(
    datasetId: string,
    formatId: string,
    metadataUri: string,
    metadataJson: Uint8Array,
    firstHierarchyChunk: Uint8Array,
    preparedMetadataJson: Uint8Array,
  ): void;
  register_prepared_dataset(
    datasetId: string,
    formatId: string,
    manifestUri: string,
    manifestJson: Uint8Array,
  ): void;
  register_glyph_atlas(objectHash: string, metadataJson: string, rgba8: Uint8Array): void;
  register_annotation_style(objectHash: string, styleJson: string): void;
  register_block_definition(definitionJson: string): void;
  register_block_member_style(resourceRefJson: string, styleJson: string): void;
  register_block_attribute_table(objectHash: string, bytes: Uint8Array): void;
  register_image_resource(
    objectHash: string,
    width: number,
    height: number,
    rgba8: Uint8Array,
  ): void;
  register_depth_resource(
    objectHash: string,
    width: number,
    height: number,
    values: Float32Array,
  ): void;
  measure_raster_depth_sample_json(entityId: string, column: number, row: number): string;
  measure_raster_depth_distance_json(picksJson: string): string;
  set_raster_analysis_view_json(entityId: string): string;
  clear_raster_analysis_view(): boolean;
  register_raster_binary_resource(objectHash: string, bytes: Uint8Array): void;
  register_mesh_resource(objectHash: string, meshJson: string): void;
  register_canonical_hatch_pattern_resource(resourceJson: string): void;
  register_canonical_texture_resource(
    resourceJson: string,
    width: number,
    height: number,
    rgba8: Uint8Array,
  ): void;
  register_canonical_material_resource_set(resourcesJson: string): void;
  register_canonical_line_type_resource(resourceJson: string): void;
  register_line_type_resource(resourceId: string, patternJson: string): string;
  begin_authoritative_section_evaluation(
    operationId: string,
    bindingJson: string,
    planeJson: string,
    tolerance: number,
  ): string;
  skip_authoritative_section_partition(operationId: string, partId: string): boolean;
  push_authoritative_section_partition(
    operationId: string,
    partId: string,
    manifestJson: string,
    positionBytes: Uint8Array,
    indexBytes: Uint8Array,
    materialSlotBytes: Uint8Array,
  ): void;
  finish_authoritative_section_evaluation(operationId: string): string;
  cancel_authoritative_section_evaluation(operationId: string): boolean;
  register_section_product(objectHash: string, productJson: string): void;
  register_prepared_dataset_and_publish_canonical_json(
    datasetId: string,
    formatId: string,
    manifestUri: string,
    manifestJson: Uint8Array,
    admissionsJson: string,
  ): string;
  plan_streaming_frame_json(optionsJson: string): string;
  streaming_runtime_json(): string;
  streaming_fetched(ticketJson: string, retainedCostJson: string): void;
  streaming_decoded(ticketJson: string, retainedCostJson: string): void;
  streaming_uploaded(ticketJson: string, retainedCostJson: string): void;
  streaming_failed(ticketJson: string, message: string, retainedCostJson: string): void;
  apply_hierarchy_page(ownerJson: string, pageUri: string, bytes: Uint8Array): void;
  hierarchy_page_failed(ownerJson: string): void;
  detach_canonical_entities_json?(bindingsJson: string): string;
  retire_canonical_entities_json(bindingsJson: string): string;
  set_entity_style_json(entityId: string, styleJson: string, exaggerationDatum: number): number;
  set_entity_interaction_state(entityId: string, selected: boolean, hovered: boolean): number;
  set_entity_visibility(entityId: string, visible: boolean): number;
  begin_move_preview(previewId: string, entityId: string, opacityMultiplier: number): number;
  update_move_preview(previewId: string, x: number, y: number, z: number): void;
  move_preview_target_tiles_json?(previewId: string): string;
  remove_move_preview(previewId: string): boolean;
  build_alignment_preview_json(previewId: string, requestJson: string): string;
  update_alignment_preview_json(previewId: string, requestJson: string): string;
  remove_alignment_preview(previewId: string): boolean;
  upsert_section_json(requestJson: string): string;
  remove_section(sectionId: string): boolean;
  set_clip_volumes_json(volumesJson: string): void;
  world_generation(): bigint;
  gaussian_splat_order_json?(renderProxyId: string): string;
  clip_preview_batch_count?(): number;
  clip_preview_material_slots_json?(): string;
  render(): string;
  recover_surface?(): void;
  request_device_recovery_for_test?(reason: string): void;
  begin_render_pick(x: number, y: number, radius: number): Promise<string>;
  finish_render_pick(payloadJson: string): string;
  capture_capabilities_json_v1?(): string;
  begin_capture_rgba_v1?(
    width: number,
    height: number,
    transparentBackground: boolean,
  ): Promise<Uint8Array>;
  capabilities_json(): string;
  hardware_policy_json(requestJson: string): string;
  runtime_quality_json(): string;
  observe_frame_telemetry_json(observationJson: string): string;
  frame_telemetry_json(): string;
  gpu_frame_timing_json(): string;
  begin_hardware_calibration(): string;
  step_hardware_calibration(): string;
  width(): number;
  height(): number;
  free(): void;
}

/** Render-independent canonical document binding exported by the same WASM core. */
export interface WasmCanonicalDocumentBinding {
  execute_transaction_json(transactionJson: string): string;
  undo_json(commandId: string, targetCommandId: string): string;
  redo_json(commandId: string, targetCommandId: string): string;
  entity_json(entityId: string): string;
  tombstone_json(entityId: string): string;
  entities_json(): string;
  journal_json(): string;
  generation(): number;
  free(): void;
}

/** wasm-bindgen module shape consumed without coupling to a generated path. */
export interface HimmelcadViewerWasmModule {
  readonly default?: () => Promise<unknown>;
  readonly WasmViewer: {
    create(canvas: HTMLCanvasElement, width: number, height: number): Promise<WasmViewerBinding>;
    create_with_backend?(
      canvas: HTMLCanvasElement,
      width: number,
      height: number,
      backend: KernelBackendPreference,
    ): Promise<WasmViewerBinding>;
  };
  readonly WasmCanonicalDocument?: {
    new (): WasmCanonicalDocumentBinding;
    from_journal_json(journalJson: string): WasmCanonicalDocumentBinding;
  };
}

/** App-supplied dynamic import so Electron and browser builds choose their asset URL. */
export type HimmelcadViewerWasmLoader = () => Promise<HimmelcadViewerWasmModule>;

/** Explicit browser graphics selection; automatic remains the production default. */
export type KernelBackendPreference = 'automatic' | 'webgpu' | 'webgl2';

interface BrowserGpuAdapterProbe {
  readonly info?: {
    readonly isFallbackAdapter?: boolean;
  };
}

interface BrowserGpuProbe {
  requestAdapter(options?: {
    readonly powerPreference?: 'high-performance' | 'low-power';
  }): Promise<BrowserGpuAdapterProbe | null>;
}

/** Stable serialized adapter capabilities emitted by the Rust kernel. */
export interface KernelDeviceCapabilities {
  readonly adapterName: string;
  readonly deviceKind: 'discreteGpu' | 'integratedGpu' | 'virtualGpu' | 'cpu' | 'other';
  readonly backend: 'vulkan' | 'metal' | 'direct3d12' | 'webGpu' | 'webGl2' | 'openGl';
  readonly driver: string;
  readonly driverInfo: string;
  readonly features: readonly string[];
  readonly maxTextureDimension2d: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxSampleCount: number;
}

/** Stable renderer-produced RGBA capture limits for the version-one boundary. */
export interface KernelRgbaCaptureCapabilities {
  readonly version: 1;
  readonly maxDimension: number;
  readonly maxPixels: number;
  readonly maxRgbaBytes: number;
  readonly colorSpace: 'srgb';
  readonly alphaMode: 'straight';
  readonly transparentBackground: true;
}

/** Explicit physical-pixel request; UI chrome is intentionally outside this boundary. */
export interface KernelRgbaCaptureRequest {
  readonly width: number;
  readonly height: number;
  readonly includeUi?: false;
  readonly transparentBackground?: boolean;
  readonly signal?: AbortSignal;
}

/** GPU-complete, tightly packed top-left-origin RGBA8 scene pixels. */
export interface KernelRgbaCaptureResult {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
  readonly colorSpace: 'srgb';
  readonly alphaMode: 'straight';
  readonly includeUi: false;
  readonly transparentBackground: boolean;
}

/** Camera and f64 floating-origin state uploaded atomically before a frame. */
export interface KernelCameraFrame {
  /** Column-major camera-relative world-to-clip matrix. */
  readonly viewProjection: ArrayLike<number>;
  /** Exact project-world coordinate represented by render-local zero. */
  readonly floatingOrigin: readonly [number, number, number];
}

export interface KernelWorldPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Authoritative Source coordinate; `null` means the canonical revision has no Z. */
export interface KernelSourcePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number | null;
}

/** Authoritative f64 camera; Rust derives both render and inverse matrices. */
export interface KernelWorldCamera {
  readonly eye: KernelWorldPoint;
  readonly target: KernelWorldPoint;
  readonly up: KernelWorldPoint;
  readonly projection:
    | {
        readonly kind: 'perspective';
        readonly verticalFovRadians: number;
        readonly aspect: number;
        readonly near: number;
        readonly far: number;
      }
    | {
        readonly kind: 'orthographic';
        readonly verticalSpan: number;
        readonly aspect: number;
        readonly near: number;
        readonly far: number;
      };
}

export interface KernelClipPlane {
  readonly normal: KernelWorldPoint;
  readonly distance: number;
}

interface KernelSectionRequestBase {
  readonly sectionId: string;
  readonly plane: { readonly origin: KernelWorldPoint; readonly normal: KernelWorldPoint };
  readonly tolerance: number;
  readonly style?: KernelRenderStyle;
  /** Optional section-wide override; per-region material identity remains in `materialSlot`. */
  readonly hatch?: KernelSectionHatchStyle | null;
  /** Registered hatch selected by a local slot string or authoritative material key. */
  readonly materialHatches?: Readonly<Record<string, KernelSectionHatchStyle>>;
  /** Exact cap owned by one currently published clip-volume plane. */
  readonly clipCap?: {
    readonly volumeId: string;
    readonly planeIndex: number;
  };
}

/** Exact section evaluated from canonical geometry already resident in the kernel. */
export interface KernelLocalSectionRequest extends KernelSectionRequestBase {
  readonly entityIds: readonly string[];
  readonly entityId?: never;
  readonly productHash?: never;
}

/** Exact immutable section product evaluated outside the renderer, e.g. for a streamed mesh. */
export interface KernelEvaluatedSectionRequest extends KernelSectionRequestBase {
  readonly entityIds?: never;
  readonly entityId: string;
  readonly productHash: string;
}

export type KernelSectionRequest = KernelLocalSectionRequest | KernelEvaluatedSectionRequest;

/** One raw source-triangle intersection edge retained for diagnostics and contour export. */
export interface KernelSectionSegment {
  readonly start: KernelWorldPoint;
  readonly end: KernelWorldPoint;
  readonly materialSlot: number;
}

/** Closed project-world contour; the final point is not duplicated. */
export interface KernelSectionContour {
  readonly points: readonly KernelWorldPoint[];
}

/** One triangulated cap region preserving its source material assignment. */
export interface KernelSectionRegion {
  readonly materialSlot: number;
  readonly outer: KernelSectionContour;
  readonly holes: readonly KernelSectionContour[];
  /** Flattened outer and hole vertices addressed by `indices`. */
  readonly vertices: readonly KernelWorldPoint[];
  readonly indices: readonly number[];
}

/** Immutable f64 output of an exact section evaluator. */
export interface KernelSectionProduct {
  readonly segments: readonly KernelSectionSegment[];
  readonly regions: readonly KernelSectionRegion[];
}

export interface KernelSectionTopologyPart {
  readonly partId: string;
  readonly topologyHash: string;
  /** Exact project-world AABB; absent providers remain correct but cannot be culled. */
  readonly bounds?: KernelSectionTopologyBounds;
}

export interface KernelSectionTopologyBounds {
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export interface KernelAuthoritativeSectionSource {
  readonly entityId: string;
  readonly datasetId: string | null;
  readonly versionHash: string;
  readonly topologyHash: string;
  /** Closed sources produce cap regions; open Civil surfaces produce exact traces only. */
  readonly closedManifold: boolean;
  /** Sorted authoritative topology partitions; these are not render-residency dependencies. */
  readonly parts: readonly KernelSectionTopologyPart[];
}

export interface KernelSectionMaterialRegionBinding {
  readonly regionIndex: number;
  readonly regionId: string;
  readonly materialKey: string;
}

/** Versioned output of the topology/section provider, consumed atomically by the kernel. */
export interface KernelAuthoritativeSectionProduct {
  readonly schemaVersion: 2;
  readonly source: KernelAuthoritativeSectionSource;
  readonly plane: { readonly origin: KernelWorldPoint; readonly normal: KernelWorldPoint };
  readonly tolerance: number;
  readonly materialRegions: readonly KernelSectionMaterialRegionBinding[];
  readonly product: KernelSectionProduct;
}

export interface KernelAuthoritativeSectionEvaluationManifest {
  readonly topologyHash: string;
  readonly closedManifold: boolean;
  readonly parts: readonly KernelSectionTopologyPart[];
}

export interface KernelSectionMutation {
  readonly proxies: number;
  readonly generation: number;
}

/** Convex clip shared by points, splats, rasters, CAD and mesh passes. */
export interface KernelClipVolume {
  readonly id: string;
  readonly planes: readonly KernelClipPlane[];
  readonly operation: 'keepInside' | 'removeInside';
  readonly previewCap: boolean;
  readonly sectionFill?: KernelSectionHatchStyle | null;
  readonly sectionMaterialHatches?: Readonly<Record<number, KernelSectionHatchStyle>>;
  readonly enabled: boolean;
}

export type KernelBoundingVolume =
  | {
      readonly kind: 'axisAlignedBox';
      readonly bounds: { readonly min: KernelWorldPoint; readonly max: KernelWorldPoint };
    }
  | {
      readonly kind: 'orientedBox';
      readonly center: KernelWorldPoint;
      readonly halfAxes: readonly [KernelWorldPoint, KernelWorldPoint, KernelWorldPoint];
    }
  | { readonly kind: 'sphere'; readonly center: KernelWorldPoint; readonly radius: number }
  | {
      readonly kind: 'geodeticRegion';
      readonly west: number;
      readonly south: number;
      readonly east: number;
      readonly north: number;
      readonly minimumHeight: number;
      readonly maximumHeight: number;
    };

/** Registry-owned identity accompanying one asynchronously fetched tile payload. */
export interface KernelCanonicalStreamMetadata {
  readonly streamId: string;
  readonly slot: GeometryRepresentationSlotKey;
  readonly binding: GeometryRepresentationBindingRef;
  readonly datasetId: string;
  readonly tileId: string;
}

export interface KernelThreeDTilesContentMetadata extends KernelCanonicalStreamMetadata {
  /** Fully resolved URI that owns relative references inside this payload. */
  readonly contentUri: string;
  /** Explicit payload interpretation; never inferred from a file extension. */
  readonly contentKind: 'gltf' | 'threeDTilesContainer';
  readonly bounds: KernelBoundingVolume;
  readonly contentTransform?: readonly number[];
}

/** One immediate external resource declared by 3D Tiles or glTF content. */
export interface KernelAssetDependency {
  readonly ownerUri: string;
  readonly sourceUri: string;
  readonly kind: 'gltfDocument' | 'buffer' | 'image' | 'schema';
}

/** Stable packed-resource descriptor consumed by the Rust decoder. */
export interface KernelResolvedAssetEntry extends KernelAssetDependency {
  readonly resolvedUri: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface KernelResolvedAssetBundleManifest {
  readonly schemaVersion: 1;
  readonly entries: readonly KernelResolvedAssetEntry[];
}

/** Externally resolved bytes retained atomically with one streamed payload. */
export interface KernelResolvedAssetBundle {
  readonly manifest: KernelResolvedAssetBundleManifest;
  readonly bytes: Uint8Array;
}

export interface KernelGpuModelCacheStats {
  readonly allocations: number;
  readonly owners: number;
  readonly gpuBufferBytes: number;
}

export interface KernelGpuTextureCacheStats {
  readonly allocations: number;
  readonly retainedAllocations: number;
  readonly owners: number;
  readonly stagedOwners: number;
  readonly gpuTextureBytes: number;
  readonly decodedSources: number;
  readonly factoryCalls: number;
}

export interface KernelStreamDecodeDiagnostics {
  readonly workerArtifactIngests: number;
  readonly mainThreadProviderDecodes: number;
}

/** Tileset-wide 3D Metadata retained independently from traversal state. */
export interface KernelThreeDTilesMetadataCatalog {
  readonly schema: Readonly<Record<string, unknown>> | null;
  readonly schemaUri: string | null;
  readonly tileset: Readonly<Record<string, unknown>> | null;
  readonly groups: readonly Readonly<Record<string, unknown>>[];
  readonly statistics: Readonly<Record<string, unknown>> | null;
}

/** Feature identity and structural metadata resolved at one exact glTF hit. */
export interface KernelGltfFeatureMetadata {
  readonly sourcePrimitiveId: number;
  readonly triangleIndex: number;
  readonly barycentric: readonly [number, number, number];
  readonly featureSets: readonly {
    readonly featureCount: number;
    readonly label: string | null;
    readonly nullFeatureId: number | null;
    readonly propertyTable: number | null;
    readonly propertyTableDefinition: Readonly<Record<string, unknown>> | null;
    readonly propertyRow: Readonly<Record<string, unknown>> | null;
    readonly binding: Readonly<Record<string, unknown>>;
    readonly resolved:
      | { readonly kind: 'feature'; readonly id: number }
      | { readonly kind: 'null' | 'textureSampleRequired' | 'unresolved' };
  }[];
  readonly propertyAttributes: readonly Readonly<Record<string, unknown>>[];
  readonly propertyTextures: readonly Readonly<Record<string, unknown>>[];
  readonly structuralMetadata: Readonly<Record<string, unknown>> | null;
  readonly instance: {
    readonly index: number;
    readonly featureId: number;
    readonly batchLength: number;
    readonly batchTableRow: Readonly<Record<string, unknown>> | null;
  } | null;
}

export interface KernelLegacyHierarchyInstance {
  readonly instanceId: number;
  readonly classId: number;
  readonly className: string;
  readonly classInstanceIndex: number;
  readonly parentIds: readonly number[];
}

export type KernelLegacyPickSource =
  | {
      readonly kind: 'triangle';
      readonly triangleIndex: number;
      readonly primitiveTriangleIndex: number;
    }
  | {
      readonly kind: 'instance';
      readonly instanceIndex: number;
      readonly modelTriangleIndex: number;
    }
  | { readonly kind: 'point'; readonly pointIndex: number };

/** Exact legacy feature identity and validated direct/inherited batch-table rows. */
export interface KernelLegacyPickMetadata {
  readonly provider: 'b3dm' | 'i3dm' | 'pnts';
  readonly source: KernelLegacyPickSource;
  readonly featureId: number | null;
  readonly batchLength: number;
  readonly directRow: Readonly<Record<string, unknown>> | null;
  readonly resolvedRow: Readonly<Record<string, unknown>> | null;
  readonly hierarchy: {
    readonly exactInstance: KernelLegacyHierarchyInstance;
    readonly ancestors: readonly KernelLegacyHierarchyInstance[];
  } | null;
}

/** Unified provider-discriminated metadata at one exact kernel pick address. */
export interface KernelPickMetadata {
  readonly sourcePrimitiveId: number;
  readonly barycentric: readonly [number, number, number] | null;
  readonly providers: {
    readonly gltf: {
      readonly provider: 'gltf';
      readonly metadata: KernelGltfFeatureMetadata;
    } | null;
    readonly legacy: KernelLegacyPickMetadata | null;
    readonly potree: {
      readonly provider: 'potree';
      readonly metadata: {
        readonly datasetId: string;
        readonly tileId: string;
        readonly pointIndex: number;
        readonly worldPosition: KernelWorldPoint;
        readonly intensity: number | null;
        readonly classification: number | null;
        readonly returnNumber: number | null;
        readonly numberOfReturns: number | null;
        readonly pointSourceId: number | null;
        readonly sourceColor: readonly [number, number, number, number] | null;
      };
    } | null;
  };
}

/** Identity and exact point count accompanying one Potree octree range. */
export interface KernelPotreeContentMetadata extends KernelCanonicalStreamMetadata {
  readonly bounds: KernelBoundingVolume;
  readonly pointCount: number;
}

export interface KernelGaussianSplatContentMetadata extends KernelCanonicalStreamMetadata {
  readonly bounds: KernelBoundingVolume;
  readonly maximumSplats: number;
}

export type KernelPreparedRasterColorEncoding = 'encodedImage' | 'rgba8';
export type KernelPreparedRasterDepthEncoding =
  | { readonly kind: 'float32LittleEndian' }
  | { readonly kind: 'float32BigEndian' }
  | { readonly kind: 'float64LittleEndian' }
  | { readonly kind: 'float64BigEndian' }
  | { readonly kind: 'constant'; readonly value: number };
export type KernelPreparedRasterNoData =
  | { readonly kind: 'none' }
  | { readonly kind: 'nan' }
  | { readonly kind: 'numeric'; readonly value: number }
  | { readonly kind: 'alphaMask' };

export interface KernelPreparedRasterSurfaceGrid {
  readonly width: number;
  readonly height: number;
  readonly mapping: {
    readonly origin: readonly [number, number];
    readonly columnStep: readonly [number, number];
    readonly rowStep: readonly [number, number];
  };
  readonly depth: NonNullable<RasterImageGeometry['depth']>;
  readonly sourceSurface: EntityVersionRef;
  readonly derivation: CanonicalResourceRef;
}

export interface KernelRasterContentMetadata extends KernelCanonicalStreamMetadata {
  readonly bounds: KernelBoundingVolume;
  readonly contract: {
    readonly schemaVersion: 1 | 2;
    readonly raster: RasterImageGeometry;
    readonly colorEncoding: KernelPreparedRasterColorEncoding;
    readonly depthEncoding: KernelPreparedRasterDepthEncoding;
    readonly noData: KernelPreparedRasterNoData;
    readonly surface?: KernelPreparedRasterSurfaceGrid;
  };
  readonly elevationPayloadByteLength: number;
  readonly validityPayloadByteLength: number;
  readonly confidencePayloadByteLength: number;
  readonly triangleMaskPayloadByteLength: number;
  readonly style?: KernelRenderStyle;
  readonly exaggerationDatum?: number;
}

/** Exact source-space result of one canonical raster depth sample. */
export interface KernelRasterDepthMeasurement {
  readonly entityId: string;
  readonly column: number;
  readonly row: number;
  readonly depth: number;
  readonly confidence: number | null;
  readonly sourcePosition: KernelWorldPoint;
}

export interface KernelRasterDepthPick {
  readonly entityId: string;
  readonly column: number;
  readonly row: number;
}

/** Source-space segments resolved atomically from two or more image picks. */
export interface KernelRasterDepthDistanceMeasurement {
  readonly picks: readonly KernelRasterDepthMeasurement[];
  readonly segmentDistances: readonly number[];
  readonly totalDistance: number;
}

interface KernelRasterAnalysisViewBase {
  readonly entityId: string;
  readonly versionHash: string | null;
  readonly width: number;
  readonly height: number;
}

/** Kernel-derived camera state for a separate panorama or oriented-image view. */
export type KernelRasterAnalysisView = KernelRasterAnalysisViewBase &
  (
    | {
        readonly kind: 'panorama';
        readonly eye: KernelWorldPoint;
        readonly target: KernelWorldPoint;
        readonly up: KernelWorldPoint;
        readonly verticalFovRadians: number;
      }
    | {
        readonly kind: 'orientedImage';
        readonly origin: KernelWorldPoint;
        readonly normal: KernelWorldPoint;
        readonly up: KernelWorldPoint;
        readonly verticalSpan: number;
      }
  );

export interface KernelResourceCost {
  readonly cpuCompressedBytes: number;
  readonly cpuDecodedBytes: number;
  readonly gpuBufferBytes: number;
  readonly gpuTextureBytes: number;
  readonly stagingBytes: number;
  readonly points: number;
  readonly triangles: number;
  readonly splats: number;
  readonly drawCalls: number;
}

export type KernelResourceBudget = KernelResourceCost;

export interface KernelFrameBudget {
  readonly targetFrameMs: number;
  readonly traversalMs: number;
  readonly decodeMs: number;
  readonly uploadBytes: number;
  readonly newRequests: number;
}

export interface KernelStreamingFrameOptions {
  readonly resourceBudget: KernelResourceBudget;
  readonly frameBudget: KernelFrameBudget;
  readonly frontierBudget?: KernelFrontierBudget;
  readonly maximumScreenSpaceError?: number;
  readonly detailScale?: number;
  readonly maximumTraversedNodes?: number;
  /** Diagnostic only; visible keys otherwise stay inside the Rust kernel. */
  readonly includeRenderKeys?: boolean;
  /** Predicted motion camera used only for bounded auxiliary admission. */
  readonly prefetchCamera?: KernelWorldCamera;
}

export interface KernelFrontierBudget {
  readonly hardwareClass: 'I' | 'W' | 'D';
  readonly points: number;
  readonly bytes: number;
  readonly drawCalls: number;
}

export interface KernelHardwareInventory {
  readonly gpuMemoryBytes: number | null;
  readonly systemMemoryBytes: number | null;
  readonly logicalCores: number;
}

/** Explicit host class; desktop remains the uncapped default. */
export type KernelHardwareDeploymentProfile = 'desktop' | 'mobileWebView';

export interface KernelDeviceCalibration {
  readonly uploadGibPerSecond: number;
  readonly pointMillionsPerSecond: number;
  readonly triangleMillionsPerSecond: number;
  readonly splatMillionsPerSecond: number;
}

/** Progress of the bounded production-pipeline benchmark on the selected GPU. */
export interface KernelCalibrationProgress {
  readonly completedSamples: number;
  readonly totalSamples: number;
  readonly inFlight: boolean;
  readonly submitted: boolean;
  readonly calibration: KernelDeviceCalibration | null;
}

export interface KernelResolvedHardwarePolicy {
  readonly deploymentProfile: KernelHardwareDeploymentProfile;
  readonly resources: KernelResourceBudget;
  readonly frame: KernelFrameBudget;
  readonly maximumTraversedNodes: number;
  readonly interaction: {
    readonly frame: KernelFrameBudget;
    readonly maximumTraversedNodes: number;
  };
  readonly workload: {
    readonly points: number;
    readonly triangles: number;
    readonly splats: number;
  };
  readonly frontier: KernelFrontierBudget;
  readonly maximumRenderScale: number;
  readonly maximumDetailScale: number;
  readonly maximumMsaaSamples: number;
  readonly decoderWorkers: number;
  readonly contentRequests: number;
  readonly transparency: 'weightedBlended' | 'sortedAlpha';
}

export interface KernelStreamingWorkPolicy {
  readonly frame: KernelFrameBudget;
  readonly maximumTraversedNodes: number;
}

/** Selects kernel-authored work limits without reproducing policy in the host. */
export function kernelStreamingWorkPolicy(
  policy: KernelResolvedHardwarePolicy,
  interacting: boolean,
): KernelStreamingWorkPolicy {
  return interacting
    ? policy.interaction
    : { frame: policy.frame, maximumTraversedNodes: policy.maximumTraversedNodes };
}

/** Authoritative concurrency state of the Rust streaming coordinator. */
export interface KernelStreamingRuntimeState {
  readonly limits: {
    readonly decoderWorkers: number;
    readonly contentRequests: number;
  };
  readonly activeDecodes: number;
  readonly inFlightContentRequests: number;
  readonly trackedEntries: number;
  readonly residencyStageCounts: Readonly<
    Record<
      | 'unloaded'
      | 'fetching'
      | 'queuedDecode'
      | 'decoding'
      | 'queuedUpload'
      | 'uploading'
      | 'resident'
      | 'failed',
      number
    >
  >;
  readonly residencyCost: KernelResourceCost;
}

/** Presentation-only quality selected by the Rust runtime governor. */
export interface KernelRuntimeQualityState {
  readonly renderScale: number;
  readonly detailScale: number;
}

export type KernelRuntimeQualityAdjustment = 'unchanged' | 'reduced' | 'increased';

export interface KernelFrameTelemetryObservation {
  readonly cpuMs: number;
  readonly interacting: boolean;
  readonly uploadedBytes: number;
}

export interface KernelRuntimeQualityObservation {
  readonly adjustment: KernelRuntimeQualityAdjustment;
  readonly quality: KernelRuntimeQualityState;
  readonly reasonCode:
    | 'within_target'
    | 'cpu_deadline'
    | 'gpu_deadline'
    | 'recovery_headroom'
    | 'invalid_timing';
  readonly gpuSample: { readonly sequence: number; readonly gpuMs: number } | null;
  readonly primitives: {
    readonly points: number;
    readonly triangles: number;
    readonly lines: number;
    readonly textQuads: number;
    readonly splats: number;
    readonly drawCalls: number;
  };
}

export interface KernelFrameTimeDistribution {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maximumMs: number;
}

/** Fixed-shape diagnostics over the bounded recent-frame window in Rust. */
export interface KernelFrameTelemetrySnapshot {
  readonly frames: number;
  readonly cpu: KernelFrameTimeDistribution;
  readonly gpu: KernelFrameTimeDistribution | null;
  readonly effective: KernelFrameTimeDistribution;
  readonly meanUploadedBytes: number;
  readonly peakResidentGpuBytes: number;
  readonly peakPoints: number;
  readonly peakTriangles: number;
  readonly peakSplats: number;
  readonly peakDrawCalls: number;
}

/** Asynchronous whole-frame GPU timestamp-query diagnostics. */
export interface KernelGpuFrameTimingDiagnostics {
  readonly supported: boolean;
  readonly pendingReadbacks: number;
  readonly latestGpuMs: number | null;
  readonly completedSamples: number;
  readonly saturatedFrames: number;
  readonly failedReadbacks: number;
}

export interface KernelEntityPresentationBatch {
  readonly proxyId: string;
  readonly batchIndex: number;
  readonly kind:
    | 'points'
    | 'triangles'
    | 'cadStroke'
    | 'cadFill'
    | 'raster'
    | 'gaussianSplats'
    | 'text';
  readonly baseColor: readonly [number, number, number, number];
  readonly colorMode: number;
  readonly fillVisible: boolean;
  readonly hatchEnabled: boolean;
  readonly strokeVisible: boolean;
  readonly strokeWidthOverride: number;
  readonly lineTypeComponents: number;
  readonly declaredTextureCoordinates: boolean;
  readonly sourceMaterialSlot: number | null;
  readonly sourceMaterialColor: readonly [number, number, number, number] | null;
  readonly sourceMaterialDoubleSided: boolean;
  readonly sourceMaterialUvRows:
    | readonly [
        readonly [number, number, number, number],
        readonly [number, number, number, number],
      ]
    | null;
  readonly sourcePbr: {
    readonly emissive: readonly [number, number, number];
    readonly metallic: number;
    readonly roughness: number;
  } | null;
  readonly sourcePbrTextureFlags: number | null;
  readonly sourcePbrUvRows: readonly (readonly [number, number, number, number])[] | null;
  readonly usesSourceTexture: boolean;
}

export interface KernelTileKey {
  readonly datasetId: string;
  readonly tileId: string;
}

export interface KernelResidencyTicket {
  readonly key: KernelTileKey;
  readonly generation: number;
}

export interface KernelContentReference {
  readonly kind:
    | 'potreePoints'
    | 'gltf'
    | 'threeDTilesContainer'
    | 'raster'
    | 'gaussianSplats'
    | 'cadProxy';
  readonly uri: string;
  readonly byteOffset: number | null;
  readonly byteLength: number | null;
  readonly primitiveCount: number | null;
  readonly contentHash: string | null;
  readonly decoderParameters?: Readonly<Record<string, unknown>> | null;
}

export interface KernelTileDescriptor {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly bounds: KernelBoundingVolume;
  readonly contentTransform: readonly number[];
  readonly geometricError: number;
  readonly refinement: 'add' | 'replace';
  readonly contents: readonly KernelContentReference[];
  readonly childPage: {
    readonly uri: string;
    readonly byteOffset: number | null;
    readonly byteLength: number | null;
    readonly contentHash: string | null;
    readonly decoderParameters?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly preparedPointMetadata?: {
    readonly screenSpaceError: {
      readonly geometricError: number;
      readonly pointSpacing: number;
    };
    readonly sampleStatistics: {
      readonly sampledPoints: number;
      readonly sourcePoints: number | null;
      readonly method: string | null;
    };
    readonly stationIds: readonly string[] | null;
    readonly contentHash: string | null;
    readonly origin: 'baked' | 'potree2Compatibility';
  } | null;
  readonly providerMetadata?: Readonly<Record<string, unknown>> | null;
}

export type KernelStreamingAction =
  | {
      readonly kind: 'fetchTile';
      readonly ticket: KernelResidencyTicket;
      readonly descriptor: KernelTileDescriptor;
    }
  | { readonly kind: 'decodeTile'; readonly ticket: KernelResidencyTicket }
  | { readonly kind: 'uploadTile'; readonly ticket: KernelResidencyTicket }
  | {
      readonly kind: 'fetchHierarchyPage';
      readonly request: {
        readonly owner: KernelTileKey;
        readonly reference: {
          readonly uri: string;
          readonly byteOffset: number | null;
          readonly byteLength: number | null;
          readonly contentHash: string | null;
          readonly decoderParameters?: Readonly<Record<string, unknown>> | null;
        };
      };
    }
  | { readonly kind: 'evictTile'; readonly key: KernelTileKey };

export interface KernelStreamingFramePlan {
  readonly render: readonly KernelTileKey[];
  readonly renderCount: number;
  readonly actions: readonly KernelStreamingAction[];
  readonly admission: Readonly<Record<string, unknown>>;
  readonly eviction: Readonly<Record<string, unknown>>;
  readonly claimedDecodeMs: number;
  readonly frontier: {
    readonly budget: KernelFrontierBudget;
    readonly selected: KernelResourceCost;
    readonly coarsenedTiles: number;
    readonly reasonCodes: readonly ('budget:points' | 'budget:bytes' | 'budget:draws')[];
    readonly budgetSatisfied: boolean;
  };
}

export interface KernelPickAddress {
  readonly entityId: string;
  readonly renderProxyId: string;
  readonly datasetId: string | null;
  readonly tileId: string | null;
  readonly primitiveId: number | null;
}

export type KernelSnapKind =
  | 'point'
  | 'vertex'
  | 'midpoint'
  | 'intersection'
  | 'edge'
  | 'surface'
  | 'rasterSample';

/** Ranked kernel-owned point-picking candidate used for Tab traversal. */
export interface KernelPickCandidate {
  readonly address: KernelPickAddress;
  /** Exact canonical Source coordinate. Never contains a synthetic plan height. */
  readonly worldPosition: KernelSourcePoint;
  /** Numeric displayed coordinate used only for navigation and screen-space ranking. */
  readonly presentationPosition: KernelWorldPoint;
  readonly snapKind: KernelSnapKind;
  readonly pixelDistance: number;
  readonly depth: number;
}

export interface KernelPickResult {
  readonly generation: number;
  readonly stale: boolean;
  readonly candidates: readonly KernelPickCandidate[];
}

/** Tagged canonical `GeometryObject` serialized by `himmelcad-core`. */
export type KernelGeometryObject = GeometryObject;

/** Backend-neutral style matching the Rust render-world contract. */
export type KernelFillMode =
  | { readonly kind: 'none' }
  | { readonly kind: 'color' }
  | { readonly kind: 'texture'; readonly resourceId: string }
  | {
      readonly kind: 'hatch';
      readonly resource: CanonicalResourceRef;
      readonly origin: KernelWorldPoint;
      readonly axisU: KernelWorldPoint;
      readonly axisV: KernelWorldPoint;
      readonly lineWidth: number;
      readonly color: readonly [number, number, number, number];
    };

export type KernelStrokeMode =
  | { readonly kind: 'none' }
  | { readonly kind: 'color' }
  | { readonly kind: 'lineType'; readonly resource: CanonicalResourceRef }
  /** @deprecated Register and retain the exact returned revision instead. */
  | { readonly kind: 'lineType'; readonly resourceId: string };

export type KernelStrokeColor =
  | { readonly kind: 'inherit' }
  | {
      readonly kind: 'uniform';
      readonly color: readonly [number, number, number, number];
    };

export type KernelStrokeWidth =
  | { readonly kind: 'source' }
  | { readonly kind: 'screen'; readonly pixels: number };

export interface KernelStrokeStyle {
  readonly mode: KernelStrokeMode;
  readonly color: KernelStrokeColor;
  readonly width: KernelStrokeWidth;
  readonly cap: 'butt' | 'square' | 'round';
  readonly join: 'miter' | 'bevel' | 'round';
  readonly miterLimit: number;
}

export interface KernelRenderStyle {
  readonly baseColor: readonly [number, number, number, number];
  readonly opacity: number;
  /** Finite, strictly positive display-only Z scale around the explicit datum. */
  readonly verticalExaggeration: number;
  readonly colorMode: Readonly<Record<string, unknown>>;
  readonly fill: KernelFillMode;
  readonly stroke: KernelStrokeStyle;
}

/** View-local interaction flags resolved by the shared Rust presentation contract. */
export interface KernelEntityInteractionState {
  readonly selected: boolean;
  readonly hovered: boolean;
}

export interface KernelAlignmentPreviewConfig {
  readonly chordTolerance: number;
  readonly maximumCurveSegments: number;
  readonly partitionLength: number;
  readonly sampleStep: number;
  readonly maximumPartitionsPerUpdate: number;
  readonly maximumSamplesPerPartition: number;
  readonly maximumRoadBandsPerPartition: number;
  readonly maximumSlopeRulesPerPartition: number;
}

export interface KernelAlignmentStationRange {
  readonly start: number;
  readonly end: number;
}

export interface KernelAlignmentPreviewBuildRequest {
  readonly alignment: AlignmentGeometry;
  readonly alignmentVersion: string;
  readonly targets: readonly Readonly<Record<string, unknown>>[];
  readonly config: KernelAlignmentPreviewConfig;
}

export interface KernelAlignmentPreviewUpdateRequest {
  readonly expectedGeneration: number;
  readonly alignmentVersion: string;
  readonly horizontalPathVersion: string;
  readonly partitions: readonly Readonly<Record<string, unknown>>[];
  readonly targets: readonly Readonly<Record<string, unknown>>[];
  readonly affected: KernelAlignmentStationRange;
}

export interface KernelAlignmentPreviewChangedPartition {
  readonly index: number;
  readonly stationRange: KernelAlignmentStationRange;
  readonly identity: string;
  readonly roadBody: readonly KernelAlignmentPreviewRoadBodyPart[];
  readonly slopes: readonly KernelAlignmentPreviewSlopePart[];
}

export interface KernelAlignmentPreviewRoadBodyPart {
  readonly proxyId: string;
  readonly bandId: string;
  readonly mesh: TriangleMeshGeometry;
}

export interface KernelAlignmentPreviewSlopePart {
  readonly proxyId: string;
  readonly ruleId: string;
  readonly sourceBandId: string;
  readonly targetSurface: string;
  readonly targetSurfaceVersion: string;
  readonly geometryVersion: string;
  readonly mesh: TriangleMeshGeometry;
}

export interface KernelAlignmentPreviewMutation {
  readonly previewId: string;
  readonly generation: number;
  readonly alignmentVersion: string;
  readonly horizontalPathVersion: string;
  readonly partitionCount: number;
  readonly parentIdentity: string | null;
  readonly identity: string;
  readonly changedPartitions: readonly KernelAlignmentPreviewChangedPartition[];
  readonly changedProxyIds: readonly string[];
  readonly workload: {
    readonly partitions: number;
    readonly stationSamples: number;
  };
}

/** One registry-authorized representation plus presentation/provider bindings. */
export interface KernelCanonicalRenderAdmission {
  readonly admission: CanonicalRepresentationAdmission;
  readonly datasetId?: string;
  readonly evaluatedMesh?: KernelEvaluatedMeshAdmission;
  readonly style?: KernelRenderStyle;
  /** Presentation plane used only by an explicitly locked top-down plan view. */
  readonly lockedPlanElevation?: number;
  readonly chordTolerance?: number;
  readonly maximumCurveSegments?: number;
  readonly lineWidth?: number;
  readonly planeExtent?: number;
  readonly fillAreas?: boolean;
  readonly exaggerationDatum?: number;
}

export interface KernelEvaluatedMeshAdmission {
  /** Inline mesh object hash or, for streamed meshes/TINs, the dataset manifest object hash. */
  readonly meshResourceRef: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly parametersRef?: string;
  /** Must equal the canonical dataset binding for streamed topology. */
  readonly datasetId?: string;
  readonly parts: readonly KernelSectionTopologyPart[];
  readonly materialKeys: Readonly<Record<number, string>>;
  readonly closedManifold: boolean;
}

export interface KernelGlyphMetrics {
  readonly atlasMin: readonly [number, number];
  readonly atlasMax: readonly [number, number];
  readonly planeMin: readonly [number, number];
  readonly planeMax: readonly [number, number];
  readonly advance: number;
}

export interface KernelGlyphAtlasMetadata {
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  readonly glyphs: Readonly<Record<string, KernelGlyphMetrics>>;
  readonly fallback: string | null;
}

export interface KernelAnnotationStyle {
  readonly glyphAtlasHash: string;
  readonly textHeight?: number;
  readonly screenSpace?: boolean;
  readonly decimals?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly lineWidth?: number;
}

/** Atomic exact-revision publication for canonical mesh presentation. */
export interface KernelCanonicalMaterialResourceSet {
  readonly textures: readonly [];
  readonly materials: readonly MaterialResource[];
  readonly materialTables: readonly MaterialTableResource[];
  readonly hatchPatterns: readonly [];
  readonly lineTypes: readonly [];
  readonly annotationStyles: readonly [];
}

export interface KernelSectionHatchStyle {
  readonly resource: CanonicalResourceRef;
  readonly lineWidth: number;
  readonly color: readonly [number, number, number, number];
}

/** Alternating drawn/gap lengths evaluated continuously in authored world units. */
export interface KernelLineTypePattern {
  readonly segments: readonly number[];
  readonly phase?: number;
}

export type KernelBlockMember = BlockMember;
export type KernelBlockDefinition = BlockDefinition;

/** Atomic entity mutation result from the Rust render world. */
export interface KernelEntityMutation {
  readonly entities: number;
  readonly proxies: number;
  readonly generation: number;
}

export interface KernelCanonicalEntityMutation extends KernelEntityMutation {
  readonly slots: number;
  readonly bindings: readonly GeometryRepresentationBindingRef[];
}

export interface KernelCanonicalRetirementMutation extends KernelEntityMutation {
  readonly slots: number;
  readonly tombstones: readonly GeometryRepresentationBindingRef[];
  /** Streamed datasets atomically detached with the retired entities. */
  readonly retiredDatasetIds: readonly string[];
}

/** Absolute, optimistic canonical placement command. */
export interface KernelTransformEntityCommand {
  readonly commandId: string;
  readonly entityId: string;
  readonly expectedRevision: number;
  readonly expectedVersionHash: string;
  readonly targetPlacement: Transform3d | null;
}

export type KernelEntityCommandJournalKind =
  | 'transformEntity'
  | 'undoTransformEntity'
  | 'redoTransformEntity';

/** Append-only command record suitable for project persistence and replay. */
export interface KernelEntityCommandJournalEntry {
  readonly sequence: number;
  readonly commandId: string;
  readonly kind: KernelEntityCommandJournalKind;
  readonly entityId: string;
  readonly beforeRevision: number;
  readonly beforeVersionHash: string;
  readonly beforePlacement: Transform3d | null;
  readonly afterRevision: number;
  readonly afterVersionHash: string;
  readonly afterPlacement: Transform3d | null;
  readonly relatedCommandId?: string;
}

export interface KernelEntityCommandMutation extends KernelCanonicalEntityMutation {
  readonly entity: CanonicalEntity;
  readonly journalEntry: KernelEntityCommandJournalEntry;
}

/** Projection result for an effect already journaled by the document authority. */
export interface KernelCommittedEntityEffectMutation extends KernelCanonicalEntityMutation {
  readonly entity: CanonicalEntity;
}

export interface KernelEntityCommandJournal {
  readonly entries: readonly KernelEntityCommandJournalEntry[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly nextSequence: number;
}

/** View-local immutable topology transport paired with one canonical representation slot. */
export interface KernelPreparedTopologyRegistration {
  readonly entityId: string;
  readonly representationSlot: string;
  readonly sectionTopologyParts: readonly KernelSectionTopologyPartitionLocation[];
  readonly closedManifold: boolean;
  readonly style?: KernelRenderStyle;
}

export interface KernelClipCapAttachmentOptions {
  /** Project-unit tolerance used by authoritative clip-cap intersection. */
  readonly tolerance: number;
  readonly requestFrame?: () => void;
  readonly onError?: (error: Error) => void;
}

export interface KernelStreamingPublish extends KernelEntityMutation {
  readonly cost: KernelResourceCost;
  /** GPU bytes newly allocated by this publish, including first-owner shared models. */
  readonly uploadedBytes: number;
  /** Exact kernel-derived proxy identities published for every stream in the transaction. */
  readonly streams: readonly {
    readonly streamId: string;
    readonly proxyIds: readonly string[];
  }[];
}

/** Result of one present attempt. */
export type KernelFrameOutcome =
  | {
      readonly status: 'presented';
      readonly reconfigured: boolean;
      readonly gpuTimingSequence?: number | null;
    }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'recreateSurface' }
  | {
      readonly status: 'recreateDevice';
      readonly reason: 'deviceLost' | 'outOfMemory';
    };

/** Physical canvas extent selected after DPR and device-limit resolution. */
export interface KernelCanvasExtent {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

/**
 * Framework-neutral owner of the shared Rust `wgpu` canvas surface.
 *
 * React components own layout and animation policy; this class owns only the
 * versioned WASM boundary, physical target sizing and validated frame state.
 */
// wasm-bindgen's async wgpu constructor temporarily owns JS closures that are
// not re-entrant. React StrictMode can overlap a cancelled mount with its
// replacement, and device recovery can coincide with another viewport start.
// Serialize only this rare constructor boundary; frames, traversal and tile
// streaming remain completely independent and pay no per-frame cost.
let viewerCreationTail: Promise<void> = Promise.resolve();

async function serializeViewerCreation<T>(create: () => Promise<T>): Promise<T> {
  const previous = viewerCreationTail;
  let release!: () => void;
  viewerCreationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await create();
  } finally {
    release();
  }
}

export class WgpuKernelViewer {
  readonly capabilities: KernelDeviceCapabilities;
  private disposed = false;
  private readonly datasetBindings = new Map<string, GeometryRepresentationBindingRef>();
  private readonly entityBindings = new Map<string, readonly GeometryRepresentationBindingRef[]>();
  private readonly legacyLineTypeRefs = new Map<string, CanonicalResourceRef>();
  private preparedTopologySources = new Map<string, Omit<KernelClipCapSource, 'tolerance'>>();
  private clipCapCoordinator: KernelClipCapCoordinator | null = null;
  private clipCapTolerance = 0;
  private clipCapRequestFrame: (() => void) | null = null;
  private clipCapError: ((error: Error) => void) | null = null;
  private clipCapCompletion: Promise<void> = Promise.resolve();
  private publishedClipVolumes: readonly KernelClipVolume[] = [];
  private baseClipVolumes: readonly KernelClipVolume[] = [];
  private scopedClipVolumes = new Map<string, KernelClipVolume>();
  private readonly definitionReplay = new Map<string, (target: WgpuKernelViewer) => void>();
  private readonly entityStyleReplay = new Map<
    string,
    { readonly style: KernelRenderStyle; readonly exaggerationDatum: number }
  >();
  private readonly entityVisibilityReplay = new Map<string, boolean>();
  private readonly entityInteractionReplay = new Map<string, KernelEntityInteractionState>();
  private readonly sectionReplay = new Map<string, KernelSectionRequest>();
  private cameraReplay: ((target: WgpuKernelViewer) => void) | null = null;
  private clearColorReplay: readonly [number, number, number, number] | null = null;
  private pointSizeReplay = 1;
  private rasterAnalysisReplay: string | null = null;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly binding: WasmViewerBinding,
    capabilities: KernelDeviceCapabilities,
  ) {
    this.capabilities = capabilities;
  }

  /** Initializes wasm once and requests the actual canvas-compatible adapter. */
  static async create(
    canvas: HTMLCanvasElement,
    loader: HimmelcadViewerWasmLoader,
    initialWidth = canvas.clientWidth,
    initialHeight = canvas.clientHeight,
    backend: KernelBackendPreference = 'automatic',
  ): Promise<WgpuKernelViewer> {
    return serializeViewerCreation(async () => {
      const module = await loader();
      if (module.default !== undefined) await module.default();
      const width = finiteExtent(initialWidth);
      const height = finiteExtent(initialHeight);
      if (backend !== 'automatic' && module.WasmViewer.create_with_backend === undefined) {
        throw new Error('loaded viewer kernel does not support explicit backend selection');
      }
      const resolvedBackend =
        backend === 'automatic' && module.WasmViewer.create_with_backend !== undefined
          ? await reliableAutomaticBrowserBackend()
          : backend;
      const binding =
        resolvedBackend === 'automatic'
          ? await module.WasmViewer.create(canvas, width, height)
          : await module.WasmViewer.create_with_backend!(canvas, width, height, resolvedBackend);
      const capabilities = parseCapabilities(binding.capabilities_json());
      return new WgpuKernelViewer(canvas, binding, capabilities);
    });
  }

  /** Attaches the single authoritative clip-cap transport for this viewer lifetime. */
  attachClipCapCoordinator(
    streaming: KernelClipCapFetcher,
    options: KernelClipCapAttachmentOptions,
  ): void {
    this.assertAlive();
    if (!Number.isFinite(options.tolerance) || options.tolerance <= 0) {
      throw new RangeError('authoritative clip-cap tolerance must be finite and positive');
    }
    if (this.clipCapCoordinator !== null) {
      throw new Error('authoritative clip-cap coordinator is already attached');
    }
    this.clipCapCoordinator = new KernelClipCapCoordinator(this, streaming);
    this.clipCapTolerance = options.tolerance;
    this.clipCapRequestFrame = options.requestFrame ?? null;
    this.clipCapError = options.onError ?? null;
    this.scheduleClipCapSynchronization();
  }

  /** Settles all exact caps requested by the latest canonical and clip state. */
  clipCapsSettled(): Promise<void> {
    this.assertAlive();
    return this.clipCapCompletion;
  }

  /** Cancels exact-cap I/O and removes coordinator-owned sections before host teardown. */
  detachClipCapCoordinator(): void {
    this.assertAlive();
    this.clipCapCoordinator?.dispose();
    this.clipCapCoordinator = null;
    this.clipCapCompletion = Promise.resolve();
  }

  /** Updates camera and f64 origin after validating the entire frame. */
  setCamera(frame: KernelCameraFrame): void {
    this.assertAlive();
    if (frame.viewProjection.length !== 16) {
      throw new RangeError('viewProjection must contain exactly 16 values');
    }
    const matrix = new Float32Array(16);
    for (let index = 0; index < matrix.length; index += 1) {
      const value = frame.viewProjection[index];
      if (value === undefined || !Number.isFinite(value)) {
        throw new RangeError(`viewProjection[${String(index)}] must be finite`);
      }
      matrix[index] = value;
    }
    if (!frame.floatingOrigin.every(Number.isFinite)) {
      throw new RangeError('floatingOrigin must contain three finite f64 coordinates');
    }
    this.binding.set_view_projection(matrix);
    this.binding.set_floating_origin(...frame.floatingOrigin);
    const replayFrame = replayClone(frame);
    this.cameraReplay = (target) => target.setCamera(replayFrame);
  }

  /** Sets the f64 camera required for precise coordinate-aware picking. */
  setWorldCamera(
    camera: KernelWorldCamera,
    floatingOrigin: readonly [number, number, number],
  ): void {
    this.assertAlive();
    if (!floatingOrigin.every(Number.isFinite)) {
      throw new RangeError('floatingOrigin must contain three finite f64 coordinates');
    }
    this.binding.set_floating_origin(...floatingOrigin);
    this.binding.set_world_camera_json(JSON.stringify(camera));
    const replayCamera = replayClone(camera);
    const replayOrigin = replayClone(floatingOrigin);
    this.cameraReplay = (target) => target.setWorldCamera(replayCamera, replayOrigin);
  }

  /** Samples the Rust f64 perspective/orthographic camera morph. */
  setCameraTransition(
    from: KernelWorldCamera,
    to: KernelWorldCamera,
    progress: number,
    floatingOrigin: readonly [number, number, number],
  ): void {
    this.assertAlive();
    if (!Number.isFinite(progress) || !floatingOrigin.every(Number.isFinite)) {
      throw new RangeError('camera transition progress and floatingOrigin must be finite');
    }
    this.binding.set_floating_origin(...floatingOrigin);
    this.binding.set_camera_transition_json(JSON.stringify({ from, to }), progress);
    const replayFrom = replayClone(from);
    const replayTo = replayClone(to);
    const replayOrigin = replayClone(floatingOrigin);
    this.cameraReplay = (target) =>
      target.setCameraTransition(replayFrom, replayTo, progress, replayOrigin);
  }

  /** Sets a linear clear color without silently clamping invalid channels. */
  setClearColor(color: readonly [number, number, number, number]): void {
    this.assertAlive();
    if (color.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
      throw new RangeError('clear color channels must be finite values from zero through one');
    }
    this.binding.set_clear_color(...color);
    this.clearColorReplay = [...color];
  }

  /** Sets a presentation-only point diameter without reloading streamed tiles. */
  setPointSize(pointSize: number): void {
    this.assertAlive();
    if (!Number.isFinite(pointSize) || pointSize < 0.25 || pointSize > 20) {
      throw new RangeError('point size must be finite and between 0.25 and 20 physical pixels');
    }
    this.binding.set_point_size(pointSize);
    this.pointSizeReplay = pointSize;
  }

  /** Recreates immutable non-streaming resources before canonical scene replay. */
  replayDefinitionsInto(target: WgpuKernelViewer): void {
    this.assertAlive();
    for (const replay of this.definitionReplay.values()) replay(target);
  }

  /** Restores presentation-only state after canonical entities were replayed. */
  replayViewStateInto(target: WgpuKernelViewer): void {
    this.assertAlive();
    this.cameraReplay?.(target);
    if (this.clearColorReplay !== null) target.setClearColor(this.clearColorReplay);
    target.setPointSize(this.pointSizeReplay);
    target.setClipVolumes(this.baseClipVolumes);
    for (const [scopeId, volume] of this.scopedClipVolumes) {
      target.setScopedClipVolume(scopeId, volume);
    }
    for (const [entityId, state] of this.entityStyleReplay) {
      target.setEntityStyle(entityId, state.style, state.exaggerationDatum);
    }
    for (const [entityId, visible] of this.entityVisibilityReplay) {
      target.setEntityVisibility(entityId, visible);
    }
    for (const [entityId, state] of this.entityInteractionReplay) {
      target.setEntityInteractionState(entityId, state);
    }
    if (this.rasterAnalysisReplay !== null) {
      target.setRasterAnalysisView(this.rasterAnalysisReplay);
    }
    for (const request of this.sectionReplay.values()) target.upsertSection(request);
  }

  /** Atomically publishes complete canonical entity envelopes and selected representations. */
  publishCanonicalRepresentations(
    admissions: readonly KernelCanonicalRenderAdmission[],
  ): KernelCanonicalEntityMutation {
    this.assertAlive();
    if (admissions.length === 0) {
      throw new RangeError('canonical representation transaction must be non-empty');
    }
    const resolvedAdmissions = admissions.map((admission) =>
      admission.style === undefined
        ? admission
        : { ...admission, style: this.resolveLegacyLineType(admission.style) },
    );
    const result: unknown = JSON.parse(
      this.binding.publish_canonical_representations_json(JSON.stringify(resolvedAdmissions)),
    );
    const mutation = parseCanonicalEntityMutation(result);
    this.applyCanonicalDatasetBindings(resolvedAdmissions, mutation);
    return mutation;
  }

  private applyCanonicalDatasetBindings(
    admissions: readonly KernelCanonicalRenderAdmission[],
    mutation: KernelCanonicalEntityMutation,
    topology: readonly KernelPreparedTopologyRegistration[] = [],
  ): void {
    const changedEntities = new Set(admissions.map(({ admission }) => admission.entity.id));
    for (const [datasetId, binding] of this.datasetBindings) {
      if (changedEntities.has(binding.key.slot.entityId)) this.datasetBindings.delete(datasetId);
    }
    const bindingsBySlot = new Map(
      mutation.bindings.map((binding) => [canonicalSlotKey(binding.key.slot), binding]),
    );
    for (const entityId of changedEntities) {
      this.entityBindings.set(
        entityId,
        mutation.bindings.filter((binding) => binding.key.slot.entityId === entityId),
      );
    }
    for (const item of admissions) {
      if (item.datasetId === undefined) continue;
      const slot: GeometryRepresentationSlotKey = {
        entityId: item.admission.entity.id,
        representationSlot: item.admission.representationSlot,
      };
      const binding = bindingsBySlot.get(canonicalSlotKey(slot));
      if (binding === undefined) {
        throw new Error('kernel omitted an admitted canonical representation binding');
      }
      this.datasetBindings.set(item.datasetId, binding);
    }
    const nextTopology = new Map(this.preparedTopologySources);
    for (const entityId of changedEntities) nextTopology.delete(entityId);
    for (const registration of topology) {
      const binding = bindingsBySlot.get(
        canonicalSlotKey({
          entityId: registration.entityId,
          representationSlot: registration.representationSlot,
        }),
      );
      if (binding === undefined) {
        throw new Error('kernel omitted an admitted authoritative topology binding');
      }
      nextTopology.set(registration.entityId, {
        entityId: registration.entityId,
        binding,
        sectionTopologyParts: registration.sectionTopologyParts,
        closedManifold: registration.closedManifold,
        ...(registration.style === undefined ? {} : { style: registration.style }),
      });
    }
    this.preparedTopologySources = nextTopology;
    this.scheduleClipCapSynchronization();
  }

  private applyCanonicalCommandBindings(
    mutation: Pick<KernelEntityCommandMutation, 'entity' | 'bindings'>,
  ): void {
    const bindings = new Map(
      mutation.bindings.map((binding) => [canonicalSlotKey(binding.key.slot), binding]),
    );
    this.entityBindings.set(mutation.entity.id, mutation.bindings);
    for (const [datasetId, current] of this.datasetBindings) {
      if (current.key.slot.entityId !== mutation.entity.id) continue;
      const replacement = bindings.get(canonicalSlotKey(current.key.slot));
      if (replacement === undefined) {
        throw new Error('kernel command omitted a current canonical dataset binding');
      }
      this.datasetBindings.set(datasetId, replacement);
    }
    const topology = this.preparedTopologySources.get(mutation.entity.id);
    if (topology !== undefined) {
      const replacement = bindings.get(canonicalSlotKey(topology.binding.key.slot));
      if (replacement === undefined) {
        throw new Error('kernel command omitted a current authoritative topology binding');
      }
      this.preparedTopologySources = new Map(this.preparedTopologySources).set(mutation.entity.id, {
        ...topology,
        binding: replacement,
      });
    }
    this.scheduleClipCapSynchronization();
  }

  /** Exact current slot/generation carried by every worker streaming artifact. */
  canonicalStreamBinding(datasetId: string): GeometryRepresentationBindingRef {
    this.assertAlive();
    const binding = this.datasetBindings.get(datasetId);
    if (binding === undefined) {
      throw new Error(`dataset ${datasetId} has no current canonical representation binding`);
    }
    return binding;
  }

  /** Exact current bindings for unload, commands and stable entity handles. */
  canonicalEntityBindings(entityId: string): readonly GeometryRepresentationBindingRef[] {
    this.assertAlive();
    const bindings = this.entityBindings.get(entityId);
    if (bindings === undefined) throw new Error(`entity ${entityId} is not loaded`);
    return bindings;
  }

  /** Authoritative Rust hash of every canonical envelope field except `versionHash`. */
  canonicalEntityVersionHash(entity: CanonicalEntity): string {
    this.assertAlive();
    return this.binding.canonical_entity_version_hash_json(JSON.stringify(entity));
  }

  /** Authoritative Rust hash of one validated canonical geometry object. */
  geometryObjectContentHash(geometry: KernelGeometryObject): string {
    this.assertAlive();
    return this.binding.geometry_object_content_hash_json(JSON.stringify(geometry));
  }

  /** Authoritative Rust hash of a reusable block's immutable member manifest. */
  blockDefinitionContentHash(definition: KernelBlockDefinition): string {
    this.assertAlive();
    return this.binding.block_definition_content_hash_json(JSON.stringify(definition));
  }

  /** Authoritative Rust hash for one immutable canonical line-type revision. */
  lineTypeResourceContentHash(resource: LineTypeResource): string {
    this.assertAlive();
    return this.binding.line_type_resource_content_hash_json(JSON.stringify(resource));
  }

  /** Authoritative Rust hash for one immutable canonical hatch-pattern revision. */
  hatchPatternResourceContentHash(resource: HatchPatternResource): string {
    this.assertAlive();
    return this.binding.hatch_pattern_resource_content_hash_json(JSON.stringify(resource));
  }

  /** Authoritative Rust hash for one immutable canonical texture revision. */
  textureResourceContentHash(resource: TextureResource): string {
    this.assertAlive();
    return this.binding.texture_resource_content_hash_json(JSON.stringify(resource));
  }

  /** Authoritative Rust hash for one immutable canonical material revision. */
  materialResourceContentHash(resource: MaterialResource): string {
    this.assertAlive();
    return this.binding.material_resource_content_hash_json(JSON.stringify(resource));
  }

  /** Authoritative Rust hash for one immutable ordered material table. */
  materialTableResourceContentHash(resource: MaterialTableResource): string {
    this.assertAlive();
    return this.binding.material_table_resource_content_hash_json(JSON.stringify(resource));
  }

  /** Authoritative Rust hash of one exact topology-partition manifest. */
  sectionTopologyPartitionContentHash(manifest: SectionTopologyPartitionManifest): string {
    this.assertAlive();
    return this.binding.section_topology_partition_content_hash_json(JSON.stringify(manifest));
  }

  /** Authoritative Rust content hash of one validated exact section product. */
  sectionProductContentHash(product: KernelAuthoritativeSectionProduct): string {
    this.assertAlive();
    return this.binding.section_product_content_hash_json(JSON.stringify(product));
  }

  /** Evicts one streamed tile and invalidates its outstanding pick addresses. */
  remove3dTilesContent(streamId: string): boolean {
    this.assertAlive();
    return this.binding.remove_3d_tiles_content(streamId);
  }

  /** Returns immediate non-data-URI dependencies for one fetched payload. */
  inspect3dTilesDependencies(
    metadata: Pick<KernelThreeDTilesContentMetadata, 'contentUri' | 'contentKind'>,
    bytes: Uint8Array,
  ): readonly KernelAssetDependency[] {
    this.assertAlive();
    const value: unknown = JSON.parse(
      this.binding.inspect_3d_tiles_dependencies_json(JSON.stringify(metadata), bytes),
    );
    return parseAssetDependencies(value);
  }

  /** Kernel-wide content-addressed immutable GPU model residency. */
  gpuModelCacheStats(): KernelGpuModelCacheStats {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.gpu_model_cache_json());
    if (
      !isRecord(value) ||
      ![value.allocations, value.owners, value.gpuBufferBytes].every(
        (entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0,
      )
    ) {
      throw new TypeError('GPU model cache diagnostics are malformed');
    }
    return value as unknown as KernelGpuModelCacheStats;
  }

  /** Kernel-wide content-addressed immutable GPU texture residency. */
  gpuTextureCacheStats(): KernelGpuTextureCacheStats {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.gpu_texture_cache_json());
    if (
      !isRecord(value) ||
      ![
        value.allocations,
        value.retainedAllocations,
        value.owners,
        value.stagedOwners,
        value.gpuTextureBytes,
        value.decodedSources,
        value.factoryCalls,
      ].every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)
    ) {
      throw new TypeError('GPU texture cache diagnostics are malformed');
    }
    return value as unknown as KernelGpuTextureCacheStats;
  }

  /** Provider-decode counters used to reject accidental main-thread rebuild decoding. */
  streamDecodeDiagnostics(): KernelStreamDecodeDiagnostics {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.stream_decode_diagnostics_json());
    if (
      !isRecord(value) ||
      ![value.workerArtifactIngests, value.mainThreadProviderDecodes].every(
        (entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0,
      )
    ) {
      throw new TypeError('stream decode diagnostics are malformed');
    }
    return value as unknown as KernelStreamDecodeDiagnostics;
  }

  /** Resolved fill/resource state without exposing process-local GPU identities. */
  entityPresentation(entityId: string): readonly KernelEntityPresentationBatch[] {
    this.assertAlive();
    const method = this.binding.entity_presentation_json;
    if (method === undefined) {
      throw new Error('loaded viewer kernel does not expose presentation diagnostics');
    }
    const value: unknown = JSON.parse(method.call(this.binding, entityId));
    if (!Array.isArray(value) || !value.every(isEntityPresentationBatch)) {
      throw new TypeError('entity presentation diagnostics are malformed');
    }
    return value;
  }

  potreeDecodeParameters(datasetId: string): string {
    this.assertAlive();
    return this.binding.potree_decode_parameters_json(datasetId);
  }

  stageDecodedStreamingPayload(
    kind: KernelContentReference['kind'],
    metadataJson: string,
    artifact: Uint8Array,
    primary: Uint8Array,
    bundleManifestJson: string,
    bundle: Uint8Array,
    secondary: Uint8Array,
    decodeParametersJson: string,
    expectedInputHash: string,
  ): KernelResourceCost {
    this.assertAlive();
    return parseResourceCost(
      JSON.parse(
        this.binding.stage_decoded_streaming_payload(
          kind,
          metadataJson,
          artifact,
          primary,
          bundleManifestJson,
          bundle,
          secondary,
          decodeParametersJson,
          expectedInputHash,
        ),
      ),
    );
  }

  /** Evicts one Potree node and invalidates its outstanding pick address. */
  removePotreeContent(streamId: string): boolean {
    this.assertAlive();
    return this.binding.remove_potree_content(streamId);
  }

  discardStagedContent(streamId: string): boolean {
    this.assertAlive();
    return this.binding.discard_staged_content(streamId);
  }

  removeGaussianSplatContent(streamId: string): boolean {
    this.assertAlive();
    return this.binding.remove_gaussian_splat_content(streamId);
  }

  /** Current primitive order per CPU-sorted Gaussian block; OIT returns none. */
  gaussianSplatOrder(renderProxyId: string): readonly (readonly number[])[] {
    this.assertAlive();
    const method = this.binding.gaussian_splat_order_json;
    if (method === undefined) return [];
    const value: unknown = JSON.parse(method.call(this.binding, renderProxyId));
    if (
      !Array.isArray(value) ||
      !value.every(
        (block) =>
          Array.isArray(block) && block.every((slot) => Number.isSafeInteger(slot) && slot >= 0),
      )
    ) {
      throw new TypeError('kernel Gaussian sort diagnostics are malformed');
    }
    return value as readonly (readonly number[])[];
  }

  /** Number of exact transient cap batches for the active clipping setup. */
  clipPreviewBatchCount(): number {
    this.assertAlive();
    const count = this.binding.clip_preview_batch_count?.() ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('kernel clip-cap diagnostics are malformed');
    }
    return count;
  }

  /** Canonical triangle-material slots represented by current exact clip caps. */
  clipPreviewMaterialSlots(): readonly number[] {
    this.assertAlive();
    const method = this.binding.clip_preview_material_slots_json;
    if (method === undefined) return [];
    const value: unknown = JSON.parse(method.call(this.binding));
    if (!Array.isArray(value) || !value.every((slot) => Number.isSafeInteger(slot) && slot >= 0)) {
      throw new TypeError('kernel clip-cap material diagnostics are malformed');
    }
    return value as readonly number[];
  }

  /** Publishes one tile's heterogeneous staging records as one kernel transaction. */
  publishStagedContents(streamIds: readonly string[]): KernelStreamingPublish {
    this.assertAlive();
    if (streamIds.length === 0) {
      throw new RangeError('staged content transaction must be non-empty');
    }
    return parseStreamingPublish(
      JSON.parse(this.binding.publish_staged_contents_json(JSON.stringify(streamIds))),
    );
  }

  removeRasterContent(streamId: string): boolean {
    this.assertAlive();
    return this.binding.remove_raster_content(streamId);
  }

  /** Registers a 3D Tiles hierarchy; content remains lazy and budgeted. */
  register3dTilesDataset(
    datasetId: string,
    formatId: string,
    tilesetUri: string,
    tilesetJson: Uint8Array,
  ): string {
    this.assertAlive();
    return this.binding.register_3d_tiles_dataset(datasetId, formatId, tilesetUri, tilesetJson);
  }

  /** Returns explicit tileset schema/group metadata for inspection and styling. */
  threeDTilesMetadata(datasetId: string): KernelThreeDTilesMetadataCatalog | null {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.three_d_tiles_metadata_json(datasetId));
    if (value === null) return null;
    if (!isRecord(value) || !Array.isArray(value.groups)) {
      throw new TypeError('3D Tiles metadata catalog is malformed');
    }
    return value as unknown as KernelThreeDTilesMetadataCatalog;
  }

  /** Resolves per-feature metadata from the same exact source triangle used by picking. */
  gltfFeatureMetadata(
    renderProxyId: string,
    sourcePrimitiveId: number,
    worldPosition: KernelSourcePoint,
  ): KernelGltfFeatureMetadata {
    this.assertAlive();
    const sourceZ = worldPosition.z;
    if (
      renderProxyId.length === 0 ||
      !Number.isSafeInteger(sourcePrimitiveId) ||
      sourcePrimitiveId < 0 ||
      sourcePrimitiveId > 0xffff_ffff ||
      !Number.isFinite(worldPosition.x) ||
      !Number.isFinite(worldPosition.y) ||
      sourceZ === null ||
      !Number.isFinite(sourceZ)
    ) {
      throw new RangeError('glTF feature hit address must be finite and portable');
    }
    const value: unknown = JSON.parse(
      this.binding.gltf_feature_metadata_json(
        renderProxyId,
        sourcePrimitiveId,
        worldPosition.x,
        worldPosition.y,
        sourceZ,
      ),
    );
    return parseGltfFeatureMetadata(value);
  }

  /** Resolves modern glTF and legacy 3D Tiles metadata from one exact pick address. */
  pickMetadata(
    renderProxyId: string,
    sourcePrimitiveId: number,
    worldPosition: KernelSourcePoint,
  ): KernelPickMetadata {
    this.assertAlive();
    const sourceZ = worldPosition.z;
    if (
      renderProxyId.length === 0 ||
      !Number.isSafeInteger(sourcePrimitiveId) ||
      sourcePrimitiveId < 0 ||
      sourcePrimitiveId > 0xffff_ffff ||
      !Number.isFinite(worldPosition.x) ||
      !Number.isFinite(worldPosition.y) ||
      sourceZ === null ||
      !Number.isFinite(sourceZ)
    ) {
      throw new RangeError('pick metadata address must be finite and portable');
    }
    return parsePickMetadata(
      JSON.parse(
        this.binding.pick_metadata_json(
          renderProxyId,
          sourcePrimitiveId,
          worldPosition.x,
          worldPosition.y,
          sourceZ,
        ),
      ),
    );
  }

  /** Registers Potree metadata plus the first range-loaded hierarchy chunk. */
  registerPotreeDataset(
    datasetId: string,
    formatId: string,
    metadataUri: string,
    metadataJson: Uint8Array,
    firstHierarchyChunk: Uint8Array,
    preparedMetadataJson: Uint8Array = new Uint8Array(0),
  ): void {
    this.assertAlive();
    this.binding.register_potree_dataset(
      datasetId,
      formatId,
      metadataUri,
      metadataJson,
      firstHierarchyChunk,
      preparedMetadataJson,
    );
  }

  /** Registers a prepared raster/splat hierarchy under the global scheduler. */
  registerPreparedDataset(
    datasetId: string,
    formatId: string,
    manifestUri: string,
    manifestJson: Uint8Array,
  ): void {
    this.assertAlive();
    this.binding.register_prepared_dataset(datasetId, formatId, manifestUri, manifestJson);
  }

  /** Atomically registers a prepared hierarchy and publishes its canonical dataset binding. */
  registerPreparedDatasetAndPublishCanonicalRepresentations(
    datasetId: string,
    formatId: string,
    manifestUri: string,
    manifestJson: Uint8Array,
    admissions: readonly KernelCanonicalRenderAdmission[],
    topology: readonly KernelPreparedTopologyRegistration[] = [],
  ): KernelCanonicalEntityMutation {
    this.assertAlive();
    if (admissions.length === 0) {
      throw new RangeError('canonical representation transaction must be non-empty');
    }
    validatePreparedTopologyRegistrations(admissions, topology);
    const resolvedAdmissions = admissions.map((admission) =>
      admission.style === undefined
        ? admission
        : { ...admission, style: this.resolveLegacyLineType(admission.style) },
    );
    const resolvedTopology = topology.map((registration) =>
      registration.style === undefined
        ? registration
        : { ...registration, style: this.resolveLegacyLineType(registration.style) },
    );
    const result: unknown = JSON.parse(
      this.binding.register_prepared_dataset_and_publish_canonical_json(
        datasetId,
        formatId,
        manifestUri,
        manifestJson,
        JSON.stringify(resolvedAdmissions),
      ),
    );
    const mutation = parseCanonicalEntityMutation(result);
    this.applyCanonicalDatasetBindings(resolvedAdmissions, mutation, resolvedTopology);
    return mutation;
  }

  /** Uploads one immutable glyph atlas shared by text, labels and dimensions. */
  registerGlyphAtlas(
    objectHash: string,
    metadata: KernelGlyphAtlasMetadata,
    rgba8: Uint8Array,
  ): void {
    this.assertAlive();
    if (objectHash.length === 0 || rgba8.byteLength === 0) {
      throw new RangeError('objectHash and glyph atlas pixels must be non-empty');
    }
    this.binding.register_glyph_atlas(objectHash, JSON.stringify(metadata), rgba8);
    const replayMetadata = replayClone(metadata);
    const replayPixels = rgba8.slice();
    this.rememberDefinition(`glyph:${objectHash}`, (target) =>
      target.registerGlyphAtlas(objectHash, replayMetadata, replayPixels),
    );
  }

  /** Registers immutable formatting shared by associative dimension entities. */
  registerAnnotationStyle(objectHash: string, style: KernelAnnotationStyle): void {
    this.assertAlive();
    if (objectHash.length === 0 || style.glyphAtlasHash.length === 0) {
      throw new RangeError('objectHash and glyphAtlasHash must be non-empty');
    }
    this.binding.register_annotation_style(objectHash, JSON.stringify(style));
    const replayStyle = replayClone(style);
    this.rememberDefinition(`annotation:${objectHash}`, (target) =>
      target.registerAnnotationStyle(objectHash, replayStyle),
    );
  }

  /** Registers one resolved immutable block definition before placing instances. */
  registerBlockDefinition(definition: KernelBlockDefinition): void {
    this.assertAlive();
    if (
      definition.definitionId.length === 0 ||
      definition.contentHash.length === 0 ||
      definition.members.length === 0
    ) {
      throw new RangeError('block definition id, hash and members must be non-empty');
    }
    this.binding.register_block_definition(JSON.stringify(definition));
    const replayDefinition = replayClone(definition);
    this.rememberDefinition(`block:${definition.definitionId}`, (target) =>
      target.registerBlockDefinition(replayDefinition),
    );
  }

  /** Binds an exact canonical style-resource revision to render presentation. */
  registerBlockMemberStyle(resource: CanonicalResourceRef, style: KernelRenderStyle): void {
    this.assertAlive();
    if (
      resource.resourceId.length === 0 ||
      resource.schemaId.length === 0 ||
      resource.contentHash.length === 0
    ) {
      throw new RangeError('block member style resource reference must be complete');
    }
    this.binding.register_block_member_style(
      JSON.stringify(resource),
      JSON.stringify(this.resolveLegacyLineType(style)),
    );
    const replayResource = replayClone(resource);
    const replayStyle = replayClone(style);
    this.rememberDefinition(`block-style:${resource.contentHash}`, (target) =>
      target.registerBlockMemberStyle(replayResource, replayStyle),
    );
  }

  /** Registers one content-addressed attribute table used by block inheritance. */
  registerBlockAttributeTable(objectHash: string, bytes: Uint8Array): void {
    this.assertAlive();
    if (objectHash.length === 0) {
      throw new RangeError('block attribute table hash must be non-empty');
    }
    this.binding.register_block_attribute_table(objectHash, bytes);
    const replayBytes = bytes.slice();
    this.rememberDefinition(`block-attributes:${objectHash}`, (target) =>
      target.registerBlockAttributeTable(objectHash, replayBytes),
    );
  }

  /** Uploads deterministic decoded pixels for raster and panorama resources. */
  registerImageResource(
    objectHash: string,
    width: number,
    height: number,
    rgba8: Uint8Array,
  ): void {
    this.assertAlive();
    if (objectHash.length === 0 || width <= 0 || height <= 0) {
      throw new RangeError('image hash and dimensions must be non-empty');
    }
    this.binding.register_image_resource(objectHash, width, height, rgba8);
    const replayPixels = rgba8.slice();
    this.rememberDefinition(`image:${objectHash}`, (target) =>
      target.registerImageResource(objectHash, width, height, replayPixels),
    );
  }

  /** Uploads immutable depth/elevation samples without collapsing NaN validity. */
  registerDepthResource(
    objectHash: string,
    width: number,
    height: number,
    values: Float32Array,
  ): void {
    this.assertAlive();
    if (objectHash.length === 0 || width <= 0 || height <= 0) {
      throw new RangeError('depth hash and dimensions must be non-empty');
    }
    this.binding.register_depth_resource(objectHash, width, height, values);
    const replayValues = values.slice();
    this.rememberDefinition(`depth:${objectHash}`, (target) =>
      target.registerDepthResource(objectHash, width, height, replayValues),
    );
  }

  /** Measures one exact raster/depth pixel in source coordinates, never GPU presentation space. */
  measureRasterDepthSample(
    entityId: string,
    column: number,
    row: number,
  ): KernelRasterDepthMeasurement {
    this.assertAlive();
    if (
      entityId.length === 0 ||
      !Number.isSafeInteger(column) ||
      !Number.isSafeInteger(row) ||
      column < 0 ||
      row < 0
    ) {
      throw new RangeError('raster measurement requires an entity and non-negative pixel indices');
    }
    return JSON.parse(
      this.binding.measure_raster_depth_sample_json(entityId, column, row),
    ) as KernelRasterDepthMeasurement;
  }

  /** Resolves an ordered image-pick chain and its source-space segment distances in Rust. */
  measureRasterDepthDistance(
    picks: readonly KernelRasterDepthPick[],
  ): KernelRasterDepthDistanceMeasurement {
    this.assertAlive();
    if (
      picks.length < 2 ||
      picks.some(
        ({ entityId, column, row }) =>
          entityId.length === 0 ||
          !Number.isSafeInteger(column) ||
          !Number.isSafeInteger(row) ||
          column < 0 ||
          row < 0,
      )
    ) {
      throw new RangeError(
        'raster distance measurement requires at least two valid non-negative image picks',
      );
    }
    return JSON.parse(
      this.binding.measure_raster_depth_distance_json(JSON.stringify(picks)),
    ) as KernelRasterDepthDistanceMeasurement;
  }

  /** Enters the kernel's isolated panorama or oriented-image render view. */
  setRasterAnalysisView(entityId: string): KernelRasterAnalysisView {
    this.assertAlive();
    if (entityId.length === 0) throw new RangeError('raster analysis entity must be non-empty');
    const view = JSON.parse(
      this.binding.set_raster_analysis_view_json(entityId),
    ) as KernelRasterAnalysisView;
    this.rasterAnalysisReplay = entityId;
    return view;
  }

  /** Restores normal mixed-scene submission without changing entity visibility. */
  clearRasterAnalysisView(): boolean {
    this.assertAlive();
    const cleared = this.binding.clear_raster_analysis_view();
    if (cleared) this.rasterAnalysisReplay = null;
    return cleared;
  }

  /** Uploads an encoded validity, confidence or connectivity side-band unchanged. */
  registerRasterBinaryResource(objectHash: string, bytes: Uint8Array): void {
    this.assertAlive();
    if (objectHash.length === 0 || bytes.byteLength === 0) {
      throw new RangeError('raster binary hash and payload must be non-empty');
    }
    this.binding.register_raster_binary_resource(objectHash, bytes);
    const replayBytes = bytes.slice();
    this.rememberDefinition(`raster-binary:${objectHash}`, (target) =>
      target.registerRasterBinaryResource(objectHash, replayBytes),
    );
  }

  /** Registers one immutable evaluated mesh for BRep, Boolean CSG or sweep display. */
  registerMeshResource(objectHash: string, mesh: Readonly<Record<string, unknown>>): void {
    this.assertAlive();
    if (objectHash.length === 0) throw new RangeError('mesh objectHash must be non-empty');
    this.binding.register_mesh_resource(objectHash, JSON.stringify(mesh));
    const replayMesh = replayClone(mesh);
    this.rememberDefinition(`mesh:${objectHash}`, (target) =>
      target.registerMeshResource(objectHash, replayMesh),
    );
  }

  /** Registers one validated immutable canonical hatch-pattern revision. */
  registerCanonicalHatchPatternResource(resource: HatchPatternResource): void {
    this.assertAlive();
    this.binding.register_canonical_hatch_pattern_resource(JSON.stringify(resource));
    const replayResource = replayClone(resource);
    this.rememberDefinition(`hatch:${resource.resourceId}`, (target) =>
      target.registerCanonicalHatchPatternResource(replayResource),
    );
  }

  /** Uploads one exact decoded canonical texture with authored sampling. */
  registerCanonicalTextureResource(
    resource: TextureResource,
    width: number,
    height: number,
    rgba8: Uint8Array,
  ): void {
    this.assertAlive();
    if (width <= 0 || height <= 0 || rgba8.byteLength === 0) {
      throw new RangeError('canonical texture dimensions and pixels must be non-empty');
    }
    this.binding.register_canonical_texture_resource(
      JSON.stringify(resource),
      width,
      height,
      rgba8,
    );
    const replayResource = replayClone(resource);
    const replayPixels = rgba8.slice();
    this.rememberDefinition(`texture:${resource.resourceId}`, (target) =>
      target.registerCanonicalTextureResource(replayResource, width, height, replayPixels),
    );
  }

  /** Atomically publishes exact texture, material and material-table revisions. */
  registerCanonicalMaterialResourceSet(resources: KernelCanonicalMaterialResourceSet): void {
    this.assertAlive();
    this.binding.register_canonical_material_resource_set(JSON.stringify(resources));
    const replayResources = replayClone(resources);
    this.rememberDefinition(`material-set:${JSON.stringify(resources)}`, (target) =>
      target.registerCanonicalMaterialResourceSet(replayResources),
    );
  }

  /** Registers one validated immutable canonical line-type revision. */
  registerCanonicalLineTypeResource(resource: LineTypeResource): void {
    this.assertAlive();
    this.binding.register_canonical_line_type_resource(JSON.stringify(resource));
    const replayResource = replayClone(resource);
    this.rememberDefinition(`line-type:${resource.resourceId}`, (target) =>
      target.registerCanonicalLineTypeResource(replayResource),
    );
  }

  /**
   * Registers the former alternating pattern and returns its sealed canonical revision.
   * @deprecated Publish a `LineTypeResource` with `registerCanonicalLineTypeResource`.
   */
  registerLineTypeResource(
    resourceId: string,
    pattern: KernelLineTypePattern,
  ): CanonicalResourceRef {
    this.assertAlive();
    if (resourceId.length === 0) throw new RangeError('line type resourceId must be non-empty');
    if (
      pattern.segments.length === 0 ||
      pattern.segments.length > 65_536 ||
      pattern.segments.length % 2 !== 0 ||
      pattern.segments.some((length) => !Number.isFinite(length) || length <= 0) ||
      (pattern.phase !== undefined && !Number.isFinite(pattern.phase))
    ) {
      throw new RangeError(
        'line type segments must be a non-empty even sequence of at most 65536 positive lengths',
      );
    }
    const reference = parseCanonicalResourceRef(
      JSON.parse(this.binding.register_line_type_resource(resourceId, JSON.stringify(pattern))),
    );
    this.legacyLineTypeRefs.set(resourceId, reference);
    const replayPattern = replayClone(pattern);
    this.rememberDefinition(`legacy-line-type:${resourceId}`, (target) => {
      target.registerLineTypeResource(resourceId, replayPattern);
    });
    return reference;
  }

  /** Begins an exact section whose source partitions are independent of render residency. */
  beginAuthoritativeSectionEvaluation(
    operationId: string,
    binding: GeometryRepresentationBindingRef,
    plane: KernelAuthoritativeSectionProduct['plane'],
    tolerance: number,
  ): KernelAuthoritativeSectionEvaluationManifest {
    this.assertAlive();
    if (operationId.length === 0 || !Number.isFinite(tolerance) || tolerance <= 0) {
      throw new RangeError('section operation id and tolerance must be valid');
    }
    const value: unknown = JSON.parse(
      this.binding.begin_authoritative_section_evaluation(
        operationId,
        JSON.stringify(binding),
        JSON.stringify(plane),
        tolerance,
      ),
    );
    if (
      !isRecord(value) ||
      typeof value.topologyHash !== 'string' ||
      typeof value.closedManifold !== 'boolean' ||
      !Array.isArray(value.parts)
    ) {
      throw new TypeError('section evaluation manifest is malformed');
    }
    return value as unknown as KernelAuthoritativeSectionEvaluationManifest;
  }

  /** Skips a source partition only after the kernel proves its AABB misses the plane. */
  skipAuthoritativeSectionPartition(operationId: string, partId: string): boolean {
    this.assertAlive();
    return this.binding.skip_authoritative_section_partition(operationId, partId);
  }

  /** Supplies one verified immutable source partition and releases it after intersection. */
  pushAuthoritativeSectionPartition(
    operationId: string,
    partId: string,
    manifest: SectionTopologyPartitionManifest,
    positionBytes: Uint8Array,
    indexBytes: Uint8Array,
    materialSlotBytes = new Uint8Array(),
  ): void {
    this.assertAlive();
    this.binding.push_authoritative_section_partition(
      operationId,
      partId,
      JSON.stringify(manifest),
      positionBytes,
      indexBytes,
      materialSlotBytes,
    );
  }

  /** Completes the trace/cap envelope after every canonical partition arrived. */
  finishAuthoritativeSectionEvaluation(operationId: string): KernelAuthoritativeSectionProduct {
    this.assertAlive();
    return JSON.parse(
      this.binding.finish_authoritative_section_evaluation(operationId),
    ) as KernelAuthoritativeSectionProduct;
  }

  /** Cancels one transient exact-section operation. */
  cancelAuthoritativeSectionEvaluation(operationId: string): boolean {
    this.assertAlive();
    return this.binding.cancel_authoritative_section_evaluation(operationId);
  }

  /** Registers exact evaluated contours and triangulation without transferring source geometry. */
  registerSectionProduct(objectHash: string, product: KernelAuthoritativeSectionProduct): void {
    this.assertAlive();
    if (objectHash.length === 0)
      throw new RangeError('section product objectHash must be non-empty');
    this.binding.register_section_product(objectHash, JSON.stringify(product));
    const replayProduct = replayClone(product);
    this.rememberDefinition(`section-product:${objectHash}`, (target) =>
      target.registerSectionProduct(objectHash, replayProduct),
    );
  }

  /** Produces the single mixed-provider work plan for the current camera frame. */
  planStreamingFrame(options: KernelStreamingFrameOptions): KernelStreamingFramePlan {
    this.assertAlive();
    const value: unknown = JSON.parse(
      this.binding.plan_streaming_frame_json(JSON.stringify(options)),
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value.render) ||
      !Number.isSafeInteger(value.renderCount) ||
      Number(value.renderCount) < value.render.length ||
      !Array.isArray(value.actions) ||
      !isRecord(value.admission) ||
      !isRecord(value.eviction) ||
      typeof value.claimedDecodeMs !== 'number'
    ) {
      throw new TypeError('kernel streaming frame plan is malformed');
    }
    if (isRecord(value.frontier)) return value as unknown as KernelStreamingFramePlan;
    const budget = options.frontierBudget ?? {
      hardwareClass: 'W' as const,
      points: options.resourceBudget.points,
      bytes:
        options.resourceBudget.gpuBufferBytes + options.resourceBudget.gpuTextureBytes,
      drawCalls: options.resourceBudget.drawCalls,
    };
    return {
      ...(value as Omit<KernelStreamingFramePlan, 'frontier'>),
      frontier: {
        budget,
        selected: {
          cpuCompressedBytes: 0,
          cpuDecodedBytes: 0,
          gpuBufferBytes: 0,
          gpuTextureBytes: 0,
          stagingBytes: 0,
          points: 0,
          triangles: 0,
          splats: 0,
          drawCalls: 0,
        },
        coarsenedTiles: 0,
        reasonCodes: [],
        budgetSatisfied: true,
      },
    };
  }

  /** Authoritative Rust claim ceilings and currently occupied coordinator slots. */
  streamingRuntime(): KernelStreamingRuntimeState {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.streaming_runtime_json());
    if (
      !isRecord(value) ||
      !isRecord(value.limits) ||
      !validConcurrency(value.limits.decoderWorkers) ||
      !validConcurrency(value.limits.contentRequests) ||
      !Number.isSafeInteger(value.activeDecodes) ||
      Number(value.activeDecodes) < 0 ||
      !Number.isSafeInteger(value.inFlightContentRequests) ||
      Number(value.inFlightContentRequests) < 0 ||
      !Number.isSafeInteger(value.trackedEntries) ||
      Number(value.trackedEntries) < 0 ||
      !validResidencyStageCounts(value.residencyStageCounts)
    ) {
      throw new TypeError('kernel streaming runtime state is malformed');
    }
    return {
      ...value,
      residencyCost: parseResourceCost(value.residencyCost),
    } as unknown as KernelStreamingRuntimeState;
  }

  streamingFetched(ticket: KernelResidencyTicket, retainedCost: KernelResourceCost): void {
    this.assertAlive();
    this.binding.streaming_fetched(JSON.stringify(ticket), JSON.stringify(retainedCost));
  }

  streamingDecoded(ticket: KernelResidencyTicket, retainedCost: KernelResourceCost): void {
    this.assertAlive();
    this.binding.streaming_decoded(JSON.stringify(ticket), JSON.stringify(retainedCost));
  }

  streamingUploaded(ticket: KernelResidencyTicket, retainedCost: KernelResourceCost): void {
    this.assertAlive();
    this.binding.streaming_uploaded(JSON.stringify(ticket), JSON.stringify(retainedCost));
  }

  streamingFailed(
    ticket: KernelResidencyTicket,
    message: string,
    retainedCost: KernelResourceCost,
  ): void {
    this.assertAlive();
    this.binding.streaming_failed(JSON.stringify(ticket), message, JSON.stringify(retainedCost));
  }

  applyHierarchyPage(owner: KernelTileKey, pageUri: string, bytes: Uint8Array): void {
    this.assertAlive();
    this.binding.apply_hierarchy_page(JSON.stringify(owner), pageUri, bytes);
  }

  hierarchyPageFailed(owner: KernelTileKey): void {
    this.assertAlive();
    this.binding.hierarchy_page_failed(JSON.stringify(owner));
  }

  /** Detaches complete canonical entities from this view through exact slot generations. */
  detachCanonicalEntities(
    bindings: readonly GeometryRepresentationBindingRef[],
  ): KernelCanonicalRetirementMutation {
    this.assertAlive();
    if (bindings.length === 0 || !bindings.every(isGeometryRepresentationBindingRef)) {
      throw new RangeError('canonical view detach needs exact non-empty binding references');
    }
    const retiredEntities = new Set(bindings.map((binding) => binding.key.slot.entityId));
    const retiredDatasetIds = [...this.datasetBindings]
      .filter(([, binding]) => retiredEntities.has(binding.key.slot.entityId))
      .map(([datasetId]) => datasetId);
    const encoded = JSON.stringify(bindings);
    const detach = this.binding.detach_canonical_entities_json;
    const result: unknown = JSON.parse(
      detach === undefined
        ? this.binding.retire_canonical_entities_json(encoded)
        : detach.call(this.binding, encoded),
    );
    const mutation = parseCanonicalRetirementMutation(result);
    for (const [datasetId, binding] of this.datasetBindings) {
      if (retiredEntities.has(binding.key.slot.entityId)) this.datasetBindings.delete(datasetId);
    }
    for (const entityId of retiredEntities) this.entityBindings.delete(entityId);
    for (const entityId of retiredEntities) {
      this.entityStyleReplay.delete(entityId);
      this.entityVisibilityReplay.delete(entityId);
      this.entityInteractionReplay.delete(entityId);
    }
    const nextTopology = new Map(this.preparedTopologySources);
    for (const entityId of retiredEntities) nextTopology.delete(entityId);
    this.preparedTopologySources = nextTopology;
    this.scheduleClipCapSynchronization();
    return { ...mutation, retiredDatasetIds };
  }

  /** @deprecated This is a view detach and never deletes canonical document state. */
  retireCanonicalEntities(
    bindings: readonly GeometryRepresentationBindingRef[],
  ): KernelCanonicalRetirementMutation {
    return this.detachCanonicalEntities(bindings);
  }

  /** Updates all resident parts of an entity through live GPU uniforms. */
  setEntityStyle(entityId: string, style: KernelRenderStyle, exaggerationDatum = 0): number {
    this.assertAlive();
    if (!Number.isFinite(style.verticalExaggeration) || style.verticalExaggeration <= 0) {
      throw new RangeError('verticalExaggeration must be finite and strictly positive');
    }
    if (!Number.isFinite(exaggerationDatum)) {
      throw new RangeError('exaggerationDatum must be finite');
    }
    if (style.fill.kind === 'texture' && style.fill.resourceId.length === 0) {
      throw new RangeError('fill resourceId must be non-empty');
    }
    if (style.fill.kind === 'hatch' && style.fill.resource.resourceId.length === 0) {
      throw new RangeError('hatch resourceId must be non-empty');
    }
    validateStrokeStyle(style.stroke);
    const resolvedStyle = this.resolveLegacyLineType(style);
    const updated = this.binding.set_entity_style_json(
      entityId,
      JSON.stringify(resolvedStyle),
      exaggerationDatum,
    );
    this.entityStyleReplay.set(entityId, {
      style: replayClone(style),
      exaggerationDatum,
    });
    const source = this.preparedTopologySources.get(entityId);
    if (source !== undefined) {
      this.preparedTopologySources = new Map(this.preparedTopologySources).set(entityId, {
        ...source,
        style: resolvedStyle,
      });
      this.scheduleClipCapSynchronization();
    }
    return updated;
  }

  private resolveLegacyLineType(style: KernelRenderStyle): KernelRenderStyle {
    const mode = style.stroke.mode;
    if (mode.kind !== 'lineType' || !('resourceId' in mode)) return style;
    const resource = this.legacyLineTypeRefs.get(mode.resourceId);
    if (resource === undefined) {
      throw new RangeError(
        `legacy line type resource '${mode.resourceId}' is not registered in this viewer`,
      );
    }
    return {
      ...style,
      stroke: {
        ...style.stroke,
        mode: { kind: 'lineType', resource },
      },
    };
  }

  /** Hides or shows an entity while retaining every resident immutable allocation. */
  setEntityVisibility(entityId: string, visible: boolean): number {
    this.assertAlive();
    if (entityId.length === 0) throw new RangeError('entityId must be non-empty');
    const updated = this.binding.set_entity_visibility(entityId, visible);
    this.entityVisibilityReplay.set(entityId, visible);
    return updated;
  }

  /** Highlights one exact picked entity without replacing its base style or resources. */
  setEntityInteractionState(entityId: string, state: KernelEntityInteractionState): number {
    this.assertAlive();
    if (
      entityId.length === 0 ||
      typeof state.selected !== 'boolean' ||
      typeof state.hovered !== 'boolean'
    ) {
      throw new TypeError('entity interaction state requires an entity id and boolean flags');
    }
    const updated = this.binding.set_entity_interaction_state(
      entityId,
      state.selected,
      state.hovered,
    );
    this.entityInteractionReplay.set(entityId, replayClone(state));
    return updated;
  }

  /** Commits an absolute canonical placement through entity and slot-generation CAS. */
  transformEntity(
    command: KernelTransformEntityCommand,
    expectedBindings: readonly GeometryRepresentationBindingRef[],
  ): KernelEntityCommandMutation {
    this.assertAlive();
    validateTransformEntityCommand(command);
    validateExpectedEntityBindings(command.entityId, expectedBindings);
    const value: unknown = JSON.parse(
      this.binding.transform_entity_json(JSON.stringify(command), JSON.stringify(expectedBindings)),
    );
    const mutation = parseEntityCommandMutation(value);
    this.applyCanonicalCommandBindings(mutation);
    return mutation;
  }

  /** Applies an already journaled document effect without a second viewer journal. */
  applyCommittedCanonicalEffect(
    effect: CanonicalEntityEffect,
    expectedBindings: readonly GeometryRepresentationBindingRef[],
  ): KernelCommittedEntityEffectMutation {
    this.assertAlive();
    if (effect.after === null) {
      throw new TypeError('committed delete effects must use detachCanonicalEntities');
    }
    validateExpectedEntityBindings(effect.entityId, expectedBindings);
    const apply = this.binding.apply_committed_entity_effect_json;
    if (apply === undefined) {
      throw new Error('loaded viewer kernel cannot project committed canonical effects');
    }
    const value: unknown = JSON.parse(
      apply.call(this.binding, JSON.stringify(effect), JSON.stringify(expectedBindings)),
    );
    const mutation = parseCommittedEntityEffectMutation(value);
    if (
      mutation.entity.id !== effect.entityId ||
      mutation.entity.versionHash !== effect.after.versionHash
    ) {
      throw new TypeError('committed effect projection returned a different canonical entity');
    }
    this.applyCanonicalCommandBindings(mutation);
    return mutation;
  }

  /** Creates a buffer-sharing, non-pickable translucent drag ghost. */
  beginMovePreview(previewId: string, entityId: string, opacityMultiplier = 0.5): number {
    this.assertAlive();
    if (!Number.isFinite(opacityMultiplier) || opacityMultiplier < 0 || opacityMultiplier > 1) {
      throw new RangeError('opacityMultiplier must be a finite value from zero through one');
    }
    return this.binding.begin_move_preview(previewId, entityId, opacityMultiplier);
  }

  /** Updates only transient f64 ghost placement; canonical geometry remains unchanged. */
  updateMovePreview(previewId: string, translation: KernelWorldPoint): void {
    this.assertAlive();
    if (![translation.x, translation.y, translation.z].every(Number.isFinite)) {
      throw new RangeError('move preview translation must be finite');
    }
    this.binding.update_move_preview(previewId, translation.x, translation.y, translation.z);
  }

  /** Atomically commits the ghost's captured f64 translation, then consumes the preview. */
  commitMovePreview(previewId: string, commandId: string): KernelEntityCommandMutation {
    this.assertAlive();
    if (previewId.length === 0 || commandId.trim().length === 0) {
      throw new RangeError('previewId and commandId must be non-empty');
    }
    const value: unknown = JSON.parse(this.binding.commit_move_preview_json(previewId, commandId));
    const mutation = parseEntityCommandMutation(value);
    this.applyCanonicalCommandBindings(mutation);
    return mutation;
  }

  /** Target-LOD diagnostics for a streamed move ghost; canonical visibility is separate. */
  movePreviewTargetTiles(previewId: string): readonly KernelTileKey[] {
    this.assertAlive();
    const diagnostics = this.binding.move_preview_target_tiles_json;
    if (diagnostics === undefined) {
      throw new Error('loaded viewer kernel does not expose move-preview target diagnostics');
    }
    const value: unknown = JSON.parse(diagnostics.call(this.binding, previewId));
    if (
      !Array.isArray(value) ||
      value.some(
        (key) =>
          !isRecord(key) || typeof key.datasetId !== 'string' || typeof key.tileId !== 'string',
      )
    ) {
      throw new TypeError('move preview target tile diagnostics are malformed');
    }
    return value as unknown as readonly KernelTileKey[];
  }

  removeMovePreview(previewId: string): boolean {
    this.assertAlive();
    return this.binding.remove_move_preview(previewId);
  }

  /** Restores the latest command's prior placement as a new forward canonical revision. */
  undoEntityCommand(
    commandId: string,
    expectedBindings: readonly GeometryRepresentationBindingRef[],
  ): KernelEntityCommandMutation {
    this.assertAlive();
    validateCommandOperation(commandId, expectedBindings);
    const value: unknown = JSON.parse(
      this.binding.undo_entity_command_json(commandId, JSON.stringify(expectedBindings)),
    );
    const mutation = parseEntityCommandMutation(value);
    this.applyCanonicalCommandBindings(mutation);
    return mutation;
  }

  /** Reapplies the latest compensated placement as a new forward canonical revision. */
  redoEntityCommand(
    commandId: string,
    expectedBindings: readonly GeometryRepresentationBindingRef[],
  ): KernelEntityCommandMutation {
    this.assertAlive();
    validateCommandOperation(commandId, expectedBindings);
    const value: unknown = JSON.parse(
      this.binding.redo_entity_command_json(commandId, JSON.stringify(expectedBindings)),
    );
    const mutation = parseEntityCommandMutation(value);
    this.applyCanonicalCommandBindings(mutation);
    return mutation;
  }

  /** Current serializable append-only command journal and undo/redo availability. */
  entityCommandJournal(): KernelEntityCommandJournal {
    this.assertAlive();
    return parseEntityCommandJournal(JSON.parse(this.binding.entity_command_journal_json()));
  }

  /** Builds one immutable, partitioned Civil corridor preview. */
  buildAlignmentPreview(
    previewId: string,
    request: KernelAlignmentPreviewBuildRequest,
  ): KernelAlignmentPreviewMutation {
    this.assertAlive();
    if (previewId.length === 0) throw new RangeError('alignment preview id must be non-empty');
    const value: unknown = JSON.parse(
      this.binding.build_alignment_preview_json(previewId, JSON.stringify(request)),
    );
    return parseAlignmentPreviewMutation(value, previewId);
  }

  /** Atomically replaces only the Civil preview partitions affected by an edit. */
  updateAlignmentPreview(
    previewId: string,
    request: KernelAlignmentPreviewUpdateRequest,
  ): KernelAlignmentPreviewMutation {
    this.assertAlive();
    if (previewId.length === 0) throw new RangeError('alignment preview id must be non-empty');
    const value: unknown = JSON.parse(
      this.binding.update_alignment_preview_json(previewId, JSON.stringify(request)),
    );
    return parseAlignmentPreviewMutation(value, previewId);
  }

  removeAlignmentPreview(previewId: string): boolean {
    this.assertAlive();
    return this.binding.remove_alignment_preview(previewId);
  }

  /** Generates exact closed-mesh section caps in project f64 coordinates. */
  upsertSection(request: KernelSectionRequest): KernelSectionMutation {
    this.assertAlive();
    const localEntityIds = request.entityIds;
    if (
      request.sectionId.length === 0 ||
      !Number.isFinite(request.tolerance) ||
      request.tolerance <= 0 ||
      (localEntityIds !== undefined
        ? localEntityIds.length === 0 || localEntityIds.some((id) => id.length === 0)
        : request.entityId.length === 0 || request.productHash.length === 0) ||
      (request.clipCap !== undefined &&
        (request.clipCap.volumeId.length === 0 ||
          !Number.isSafeInteger(request.clipCap.planeIndex) ||
          request.clipCap.planeIndex < 0))
    ) {
      throw new RangeError(
        'section needs a non-empty id, positive tolerance and either entityIds or entityId/productHash',
      );
    }
    const resolvedRequest =
      request.style === undefined
        ? request
        : { ...request, style: this.resolveLegacyLineType(request.style) };
    const value: unknown = JSON.parse(
      this.binding.upsert_section_json(JSON.stringify(resolvedRequest)),
    );
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.proxies) ||
      !Number.isSafeInteger(value.generation)
    ) {
      throw new TypeError('kernel section mutation result is malformed');
    }
    this.sectionReplay.set(request.sectionId, replayClone(resolvedRequest));
    return value as unknown as KernelSectionMutation;
  }

  removeSection(sectionId: string): boolean {
    this.assertAlive();
    const removed = this.binding.remove_section(sectionId);
    this.sectionReplay.delete(sectionId);
    return removed;
  }

  /** Atomically replaces all view-local convex clipping volumes. */
  setClipVolumes(volumes: readonly KernelClipVolume[]): void {
    this.assertAlive();
    const next = volumes.map(cloneClipVolume);
    this.publishClipVolumes(next, this.scopedClipVolumes);
    this.baseClipVolumes = next;
  }

  /**
   * Adds, replaces or removes one tool-owned clip without discarding user clip
   * boxes. Scope ordering is deterministic and publication remains atomic.
   */
  setScopedClipVolume(scopeId: string, volume: KernelClipVolume | null): void {
    this.assertAlive();
    if (scopeId.trim().length === 0 || scopeId !== scopeId.trim()) {
      throw new RangeError('clip scope id must be non-empty and trimmed');
    }
    const next = new Map(this.scopedClipVolumes);
    if (volume === null) next.delete(scopeId);
    else next.set(scopeId, cloneClipVolume(volume));
    this.publishClipVolumes(this.baseClipVolumes, next);
    this.scopedClipVolumes = next;
  }

  private publishClipVolumes(
    base: readonly KernelClipVolume[],
    scoped: ReadonlyMap<string, KernelClipVolume>,
  ): void {
    const composed = [
      ...base,
      ...[...scoped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, volume]) => volume),
    ];
    const identities = new Set<string>();
    for (const volume of composed) {
      if (identities.has(volume.id)) {
        throw new RangeError(`duplicate composed clip volume id: ${volume.id}`);
      }
      identities.add(volume.id);
    }
    const active = composed.filter((volume) => volume.enabled);
    if (active.length > 4) {
      throw new RangeError('portable clip capacity supports at most four active volumes');
    }
    if (active.reduce((total, volume) => total + volume.planes.length, 0) > 24) {
      throw new RangeError('portable clip capacity supports at most 24 active planes');
    }
    this.binding.set_clip_volumes_json(JSON.stringify(composed));
    this.publishedClipVolumes = composed;
    this.scheduleClipCapSynchronization();
  }

  private scheduleClipCapSynchronization(): void {
    const coordinator = this.clipCapCoordinator;
    if (coordinator === null || this.disposed) return;
    const sources = [...this.preparedTopologySources.values()].map((source) => ({
      ...source,
      tolerance: this.clipCapTolerance,
    }));
    const synchronization = coordinator.synchronizePublished({
      volumes: this.publishedClipVolumes,
      sources,
    });
    this.clipCapCompletion = synchronization.then(
      () => {
        if (this.disposed || this.clipCapCoordinator !== coordinator) return;
        this.clipCapRequestFrame?.();
      },
      (error: unknown) => {
        if (this.disposed || this.clipCapCoordinator !== coordinator) return;
        const resolved = error instanceof Error ? error : new Error(String(error));
        this.clipCapError?.(resolved);
        throw resolved;
      },
    );
    void this.clipCapCompletion.catch(() => undefined);
  }

  /** Current generation for rejecting stale asynchronous hit readbacks. */
  worldGeneration(): bigint {
    this.assertAlive();
    return this.binding.world_generation();
  }

  /**
   * Resolves CSS size and DPR against the selected adapter's real texture limit.
   * Zero extent suspends the Rust surface and does not allocate a fake 1px canvas.
   */
  resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio = globalDevicePixelRatio(),
  ): KernelCanvasExtent {
    this.assertAlive();
    const dpr = finiteDpr(devicePixelRatio);
    const maximum = Math.min(65_535, this.capabilities.maxTextureDimension2d);
    const width = physicalExtent(cssWidth, dpr, maximum);
    const height = physicalExtent(cssHeight, dpr, maximum);
    this.canvas.width = width;
    this.canvas.height = height;
    this.binding.resize(width, height);
    return { width, height, devicePixelRatio: dpr };
  }

  /** Presents one frame and returns an explicit recoverable lifecycle result. */
  render(): KernelFrameOutcome {
    this.assertAlive();
    return parseFrameOutcome(this.binding.render());
  }

  /** Versioned renderer capture capabilities, independent of the live canvas extent. */
  rgbaCaptureCapabilities(): KernelRgbaCaptureCapabilities {
    this.assertAlive();
    const report = this.binding.capture_capabilities_json_v1;
    if (report === undefined) {
      throw new Error('loaded viewer kernel does not support renderer RGBA capture v1');
    }
    return parseRgbaCaptureCapabilities(report.call(this.binding));
  }

  /**
   * Renders the current camera and scene at an explicit size and resolves only
   * after GPU readback. This never resizes or snapshots the live canvas.
   */
  async captureRgba(request: KernelRgbaCaptureRequest): Promise<KernelRgbaCaptureResult> {
    this.assertAlive();
    request.signal?.throwIfAborted();
    const includeUi: unknown = request.includeUi;
    if (includeUi !== undefined && includeUi !== false) {
      throw new TypeError('renderer RGBA capture supports includeUi=false only');
    }
    const begin = this.binding.begin_capture_rgba_v1;
    if (begin === undefined) {
      throw new Error('loaded viewer kernel does not support renderer RGBA capture v1');
    }
    const capabilities = this.rgbaCaptureCapabilities();
    validateRgbaCaptureExtent(request.width, request.height, capabilities);
    const transparentBackground = request.transparentBackground ?? false;
    const pending = begin.call(this.binding, request.width, request.height, transparentBackground);
    const value = await abortable(pending, request.signal);
    if (!(value instanceof Uint8Array)) {
      throw new TypeError('kernel RGBA capture result is not a Uint8Array');
    }
    const expectedLength = request.width * request.height * 4;
    if (value.byteLength !== expectedLength) {
      throw new TypeError(
        `kernel RGBA capture returned ${String(value.byteLength)} bytes; expected ${String(expectedLength)}`,
      );
    }
    this.assertAlive();
    return {
      width: request.width,
      height: request.height,
      rgba8: value.slice(),
      colorSpace: capabilities.colorSpace,
      alphaMode: capabilities.alphaMode,
      includeUi: false,
      transparentBackground,
    };
  }

  /** Rebinds a lost canvas surface without rebuilding the device or resident scene. */
  recoverSurface(): void {
    this.assertAlive();
    if (this.binding.recover_surface === undefined) {
      throw new Error('loaded viewer kernel does not support surface recovery');
    }
    this.binding.recover_surface();
  }

  /** Browser-gate injection for the otherwise asynchronous platform callback. */
  requestDeviceRecoveryForTest(reason: 'deviceLost' | 'outOfMemory'): void {
    this.assertAlive();
    if (this.binding.request_device_recovery_for_test === undefined) {
      throw new Error('loaded viewer kernel does not support device-recovery test injection');
    }
    this.binding.request_device_recovery_for_test(reason);
  }

  /**
   * Presents an ID/depth frame and returns world-space candidates in stable Tab
   * order. A result is marked stale if the render world changed during mapping.
   */
  async pick(x: number, y: number, radius = 4): Promise<KernelPickResult> {
    this.assertAlive();
    if (![x, y, radius].every(Number.isSafeInteger) || x < 0 || y < 0 || radius < 0 || radius > 8) {
      throw new RangeError(
        'pick coordinates must be non-negative integers and radius must be 0..8',
      );
    }
    const requestedGeneration = this.binding.world_generation();
    // GPU mapping must not keep the mutable WASM viewer borrowed. WebGL2
    // completes map callbacks from later device polls, which are driven by the
    // ordinary frame loop while this promise is pending.
    const payload = await this.binding.begin_render_pick(x, y, radius);
    if (this.disposed) {
      return { generation: Number(requestedGeneration), stale: true, candidates: [] };
    }
    const value: unknown = JSON.parse(this.binding.finish_render_pick(payload));
    const result = parsePickResult(value);
    if (
      this.disposed ||
      BigInt(result.generation) !== requestedGeneration ||
      this.binding.world_generation() !== requestedGeneration
    ) {
      return { ...result, stale: true, candidates: [] };
    }
    return result;
  }

  /** Releases the Rust surface, adapter resources and all resident GPU objects. */
  dispose(): void {
    if (this.disposed) return;
    this.detachClipCapCoordinator();
    this.disposed = true;
    this.binding.free();
  }

  /** Current physical target extent reported by the Rust surface. */
  extent(): readonly [number, number] {
    this.assertAlive();
    return [this.binding.width(), this.binding.height()];
  }

  /** Resolves budgets from real adapter limits without reducing high-end devices to a low tier. */
  resolveHardwarePolicy(
    inventory: KernelHardwareInventory,
    calibration: KernelDeviceCalibration | null = null,
    deploymentProfile: KernelHardwareDeploymentProfile = 'desktop',
  ): KernelResolvedHardwarePolicy {
    this.assertAlive();
    if (deploymentProfile !== 'desktop' && deploymentProfile !== 'mobileWebView') {
      throw new TypeError('kernel hardware deployment profile is invalid');
    }
    const value: unknown = JSON.parse(
      this.binding.hardware_policy_json(
        JSON.stringify({
          inventory,
          calibration,
          deploymentProfile,
        }),
      ),
    );
    if (
      !isRecord(value) ||
      !isRecord(value.resources) ||
      !isRecord(value.frame) ||
      !isRecord(value.interaction) ||
      !isRecord(value.interaction.frame) ||
      !isRecord(value.workload) ||
      (value.deploymentProfile !== 'desktop' && value.deploymentProfile !== 'mobileWebView') ||
      typeof value.maximumTraversedNodes !== 'number' ||
      typeof value.interaction.maximumTraversedNodes !== 'number' ||
      typeof value.maximumRenderScale !== 'number' ||
      typeof value.maximumDetailScale !== 'number'
    ) {
      throw new TypeError('kernel hardware policy is malformed');
    }
    if (isRecord(value.frontier)) return value as unknown as KernelResolvedHardwarePolicy;
    const legacy = value as unknown as Omit<KernelResolvedHardwarePolicy, 'frontier'>;
    return {
      ...legacy,
      frontier: {
        hardwareClass: this.capabilities.deviceKind === 'discreteGpu' ? 'W' : 'I',
        points: Math.min(legacy.workload.points, legacy.resources.points),
        bytes: legacy.resources.gpuBufferBytes + legacy.resources.gpuTextureBytes,
        drawCalls: legacy.resources.drawCalls,
      },
    };
  }

  /** Current presentation quality owned by the Rust runtime governor. */
  runtimeQuality(): KernelRuntimeQualityState {
    this.assertAlive();
    return parseRuntimeQuality(JSON.parse(this.binding.runtime_quality_json()));
  }

  /** Records one measured frame; scene workload values remain Rust-authoritative. */
  observeFrameTelemetry(
    observation: KernelFrameTelemetryObservation,
  ): KernelRuntimeQualityObservation {
    this.assertAlive();
    if (
      !validDuration(observation.cpuMs) ||
      !Number.isSafeInteger(observation.uploadedBytes) ||
      observation.uploadedBytes < 0
    ) {
      throw new RangeError('frame telemetry requires valid timings and uploaded bytes');
    }
    const value: unknown = JSON.parse(
      this.binding.observe_frame_telemetry_json(JSON.stringify(observation)),
    );
    if (
      !isRecord(value) ||
      (value.adjustment !== 'unchanged' &&
        value.adjustment !== 'reduced' &&
        value.adjustment !== 'increased') ||
      (value.reasonCode !== undefined &&
        ![
          'within_target',
          'cpu_deadline',
          'gpu_deadline',
          'recovery_headroom',
          'invalid_timing',
        ].includes(String(value.reasonCode))) ||
      (value.gpuSample !== undefined && value.gpuSample !== null &&
        (!isRecord(value.gpuSample) ||
          !Number.isSafeInteger(value.gpuSample.sequence) ||
          Number(value.gpuSample.sequence) < 1 ||
          !validDuration(value.gpuSample.gpuMs))) ||
      (value.primitives !== undefined && !validFramePrimitiveCounts(value.primitives))
    ) {
      throw new TypeError('kernel runtime quality observation is malformed');
    }
    return {
      adjustment: value.adjustment,
      quality: parseRuntimeQuality(value.quality),
      reasonCode:
        (value.reasonCode as KernelRuntimeQualityObservation['reasonCode'] | undefined) ??
        'within_target',
      gpuSample:
        (value.gpuSample as KernelRuntimeQualityObservation['gpuSample'] | undefined) ?? null,
      primitives: validFramePrimitiveCounts(value.primitives)
        ? value.primitives
        : { points: 0, triangles: 0, lines: 0, textQuads: 0, splats: 0, drawCalls: 0 },
    };
  }

  /** Bounded recent-frame percentiles and authoritative workload peaks. */
  frameTelemetry(): KernelFrameTelemetrySnapshot | null {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.frame_telemetry_json());
    if (value === null) return null;
    return parseFrameTelemetrySnapshot(value);
  }

  /** Latest completed GPU timestamp sample; pending work never blocks this call. */
  gpuFrameTiming(): KernelGpuFrameTimingDiagnostics {
    this.assertAlive();
    const value: unknown = JSON.parse(this.binding.gpu_frame_timing_json());
    if (
      !isRecord(value) ||
      typeof value.supported !== 'boolean' ||
      typeof value.pendingReadbacks !== 'number' ||
      !Number.isSafeInteger(value.pendingReadbacks) ||
      value.pendingReadbacks < 0 ||
      (value.latestGpuMs !== null && !validDuration(value.latestGpuMs)) ||
      typeof value.completedSamples !== 'number' ||
      !Number.isSafeInteger(value.completedSamples) ||
      value.completedSamples < 0 ||
      typeof value.saturatedFrames !== 'number' ||
      !Number.isSafeInteger(value.saturatedFrames) ||
      value.saturatedFrames < 0 ||
      typeof value.failedReadbacks !== 'number' ||
      !Number.isSafeInteger(value.failedReadbacks) ||
      value.failedReadbacks < 0
    ) {
      throw new TypeError('kernel GPU frame timing diagnostics are malformed');
    }
    return value as unknown as KernelGpuFrameTimingDiagnostics;
  }

  /** Allocates the bounded incremental benchmark suite on the real adapter. */
  beginHardwareCalibration(): KernelCalibrationProgress {
    this.assertAlive();
    return parseCalibrationProgress(JSON.parse(this.binding.begin_hardware_calibration()));
  }

  /** Submits at most one benchmark pass and never blocks the interaction thread. */
  stepHardwareCalibration(): KernelCalibrationProgress {
    this.assertAlive();
    return parseCalibrationProgress(JSON.parse(this.binding.step_hardware_calibration()));
  }

  private rememberDefinition(identity: string, replay: (target: WgpuKernelViewer) => void): void {
    this.definitionReplay.set(identity, replay);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('WgpuKernelViewer has been disposed');
  }
}

function replayClone<T>(value: T): T {
  return structuredClone(value);
}

function validResidencyStageCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    'unloaded',
    'fetching',
    'queuedDecode',
    'decoding',
    'queuedUpload',
    'uploading',
    'resident',
    'failed',
  ].every((stage) => Number.isSafeInteger(value[stage]) && Number(value[stage]) >= 0);
}

async function reliableAutomaticBrowserBackend(): Promise<KernelBackendPreference> {
  const navigatorWithGpu = globalThis.navigator as
    | (Navigator & { readonly gpu?: BrowserGpuProbe })
    | undefined;
  const gpu = navigatorWithGpu?.gpu;
  if (gpu === undefined) return 'automatic';
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    return adapter?.info?.isFallbackAdapter === true ? 'webgl2' : 'automatic';
  } catch {
    // Let the Rust automatic selector retain its permanent WebGL2 fallback when
    // adapter probing itself is unavailable or rejected by the browser.
    return 'automatic';
  }
}

function parseCalibrationProgress(value: unknown): KernelCalibrationProgress {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.completedSamples) ||
    !Number.isSafeInteger(value.totalSamples) ||
    typeof value.inFlight !== 'boolean' ||
    typeof value.submitted !== 'boolean' ||
    (value.calibration !== null && !validCalibration(value.calibration))
  ) {
    throw new TypeError('kernel calibration progress is malformed');
  }
  return value as unknown as KernelCalibrationProgress;
}

function validCalibration(value: unknown): value is KernelDeviceCalibration {
  return (
    isRecord(value) &&
    [
      value.uploadGibPerSecond,
      value.pointMillionsPerSecond,
      value.triangleMillionsPerSecond,
      value.splatMillionsPerSecond,
    ].every(
      (measurement) =>
        typeof measurement === 'number' && Number.isFinite(measurement) && measurement > 0,
    )
  );
}

function parseRuntimeQuality(value: unknown): KernelRuntimeQualityState {
  if (!isRecord(value) || !validPositive(value.renderScale) || !validPositive(value.detailScale)) {
    throw new TypeError('kernel runtime quality state is malformed');
  }
  return value as unknown as KernelRuntimeQualityState;
}

function parseFrameTelemetrySnapshot(value: unknown): KernelFrameTelemetrySnapshot {
  const countKeys: readonly string[] = [
    'frames',
    'meanUploadedBytes',
    'peakResidentGpuBytes',
    'peakPoints',
    'peakTriangles',
    'peakSplats',
    'peakDrawCalls',
  ];
  if (
    !isRecord(value) ||
    !countKeys.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) ||
    !validDistribution(value.cpu) ||
    !validDistribution(value.effective) ||
    (value.gpu !== null && !validDistribution(value.gpu))
  ) {
    throw new TypeError('kernel frame telemetry snapshot is malformed');
  }
  return value as unknown as KernelFrameTelemetrySnapshot;
}

function validDistribution(value: unknown): value is KernelFrameTimeDistribution {
  return (
    isRecord(value) && [value.p50Ms, value.p95Ms, value.p99Ms, value.maximumMs].every(validDuration)
  );
}

function validFramePrimitiveCounts(
  value: unknown,
): value is KernelRuntimeQualityObservation['primitives'] {
  return (
    isRecord(value) &&
    ['points', 'triangles', 'lines', 'textQuads', 'splats', 'drawCalls'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    )
  );
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteExtent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.min(65_535, Math.round(value)));
}

function finiteDpr(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function physicalExtent(cssExtent: number, dpr: number, maximum: number): number {
  if (!Number.isFinite(cssExtent) || cssExtent <= 0) return 0;
  return Math.min(maximum, Math.max(1, Math.round(cssExtent * dpr)));
}

function globalDevicePixelRatio(): number {
  return typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
}

function parseCapabilities(json: string): KernelDeviceCapabilities {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new TypeError('kernel capability report is not an object');
  const maxTextureDimension2d = finitePositiveInteger(value.maxTextureDimension2d);
  const maxSampleCount = finitePositiveInteger(value.maxSampleCount);
  if (
    typeof value.adapterName !== 'string' ||
    typeof value.deviceKind !== 'string' ||
    typeof value.backend !== 'string' ||
    typeof value.driver !== 'string' ||
    typeof value.driverInfo !== 'string' ||
    !Array.isArray(value.features) ||
    !value.features.every((feature) => typeof feature === 'string') ||
    maxTextureDimension2d === null ||
    maxSampleCount === null ||
    typeof value.maxStorageBufferBindingSize !== 'number' ||
    typeof value.maxBufferSize !== 'number'
  ) {
    throw new TypeError('kernel capability report is malformed');
  }
  return value as unknown as KernelDeviceCapabilities;
}

function parseRgbaCaptureCapabilities(json: string): KernelRgbaCaptureCapabilities {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    finitePositiveInteger(value.maxDimension) === null ||
    finitePositiveInteger(value.maxPixels) === null ||
    finitePositiveInteger(value.maxRgbaBytes) === null ||
    value.colorSpace !== 'srgb' ||
    value.alphaMode !== 'straight' ||
    value.transparentBackground !== true
  ) {
    throw new TypeError('kernel RGBA capture capability report is malformed');
  }
  return value as unknown as KernelRgbaCaptureCapabilities;
}

function validateRgbaCaptureExtent(
  width: number,
  height: number,
  capabilities: KernelRgbaCaptureCapabilities,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('capture width and height must be positive safe integers');
  }
  const pixels = width * height;
  if (
    width > capabilities.maxDimension ||
    height > capabilities.maxDimension ||
    pixels > capabilities.maxPixels ||
    pixels * 4 > capabilities.maxRgbaBytes
  ) {
    throw new RangeError('capture extent exceeds the renderer RGBA capture limits');
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function parseFrameOutcome(json: string): KernelFrameOutcome {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new TypeError('kernel frame outcome is malformed');
  }
  if (
    value.status === 'presented' &&
    typeof value.reconfigured === 'boolean' &&
    (value.gpuTimingSequence === undefined || value.gpuTimingSequence === null ||
      (Number.isSafeInteger(value.gpuTimingSequence) && Number(value.gpuTimingSequence) > 0))
  ) {
    return value.gpuTimingSequence === undefined
      ? { status: 'presented', reconfigured: value.reconfigured }
      : {
          status: 'presented',
          reconfigured: value.reconfigured,
          gpuTimingSequence: value.gpuTimingSequence as number | null,
        };
  }
  if (value.status === 'skipped' && typeof value.reason === 'string') {
    return { status: 'skipped', reason: value.reason };
  }
  if (value.status === 'recreateSurface') return { status: 'recreateSurface' };
  if (
    value.status === 'recreateDevice' &&
    (value.reason === 'deviceLost' || value.reason === 'outOfMemory')
  ) {
    return { status: 'recreateDevice', reason: value.reason };
  }
  throw new TypeError('kernel frame outcome contains an unknown status');
}

function parseEntityMutation(value: unknown): KernelEntityMutation {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.entities) ||
    !Number.isSafeInteger(value.proxies) ||
    !Number.isSafeInteger(value.generation)
  ) {
    throw new TypeError('kernel entity mutation result is malformed');
  }
  return value as unknown as KernelEntityMutation;
}

function parseCanonicalEntityMutation(value: unknown): KernelCanonicalEntityMutation {
  const mutation = parseEntityMutation(value);
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.slots) ||
    !Array.isArray(value.bindings) ||
    !value.bindings.every(isGeometryRepresentationBindingRef)
  ) {
    throw new TypeError('kernel canonical entity mutation result is malformed');
  }
  return { ...mutation, slots: value.slots as number, bindings: value.bindings };
}

function parseEntityCommandMutation(value: unknown): KernelEntityCommandMutation {
  const mutation = parseCanonicalEntityMutation(value);
  if (!isRecord(value) || !isCanonicalEntityEnvelope(value.entity)) {
    throw new TypeError('kernel entity command result has no canonical entity');
  }
  const journalEntry = parseEntityCommandJournalEntry(value.journalEntry);
  if (
    journalEntry.entityId !== value.entity.id ||
    journalEntry.afterRevision !== value.entity.revision ||
    journalEntry.afterVersionHash !== value.entity.versionHash
  ) {
    throw new TypeError('kernel entity command result and journal entry disagree');
  }
  return {
    ...mutation,
    entity: value.entity as unknown as CanonicalEntity,
    journalEntry,
  };
}

function parseCommittedEntityEffectMutation(value: unknown): KernelCommittedEntityEffectMutation {
  const mutation = parseCanonicalEntityMutation(value);
  if (!isRecord(value) || !isCanonicalEntityEnvelope(value.entity)) {
    throw new TypeError('committed effect projection has no canonical entity');
  }
  return { ...mutation, entity: value.entity as unknown as CanonicalEntity };
}

function parseEntityCommandJournal(value: unknown): KernelEntityCommandJournal {
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    typeof value.canUndo !== 'boolean' ||
    typeof value.canRedo !== 'boolean' ||
    !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < 1
  ) {
    throw new TypeError('kernel entity command journal is malformed');
  }
  const entries = value.entries.map(parseEntityCommandJournalEntry);
  if (entries.some((entry, index) => entry.sequence !== index + 1)) {
    throw new TypeError('kernel entity command journal sequence is discontinuous');
  }
  return {
    entries,
    canUndo: value.canUndo,
    canRedo: value.canRedo,
    nextSequence: value.nextSequence as number,
  };
}

function parseEntityCommandJournalEntry(value: unknown): KernelEntityCommandJournalEntry {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.commandId !== 'string' ||
    value.commandId.length === 0 ||
    !isEntityCommandJournalKind(value.kind) ||
    typeof value.entityId !== 'string' ||
    value.entityId.length === 0 ||
    !Number.isSafeInteger(value.beforeRevision) ||
    !Number.isSafeInteger(value.afterRevision) ||
    typeof value.beforeVersionHash !== 'string' ||
    typeof value.afterVersionHash !== 'string' ||
    !isOptionalTransform3d(value.beforePlacement) ||
    !isOptionalTransform3d(value.afterPlacement) ||
    (value.relatedCommandId !== undefined && typeof value.relatedCommandId !== 'string')
  ) {
    throw new TypeError('kernel entity command journal entry is malformed');
  }
  return value as unknown as KernelEntityCommandJournalEntry;
}

function validateTransformEntityCommand(command: KernelTransformEntityCommand): void {
  if (
    command.commandId.trim().length === 0 ||
    command.entityId.length === 0 ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    command.expectedVersionHash.length === 0 ||
    !isOptionalTransform3d(command.targetPlacement)
  ) {
    throw new RangeError('canonical transform entity command is malformed');
  }
}

function validateExpectedEntityBindings(
  entityId: string,
  bindings: readonly GeometryRepresentationBindingRef[],
): void {
  if (
    bindings.length === 0 ||
    !bindings.every(
      (binding) =>
        isGeometryRepresentationBindingRef(binding) && binding.key.slot.entityId === entityId,
    ) ||
    new Set(bindings.map((binding) => canonicalSlotKey(binding.key.slot))).size !== bindings.length
  ) {
    throw new RangeError('command needs every unique current binding of its target entity');
  }
}

function validateCommandOperation(
  commandId: string,
  bindings: readonly GeometryRepresentationBindingRef[],
): void {
  if (commandId.trim().length === 0 || bindings.length === 0) {
    throw new RangeError('commandId and expected bindings must be non-empty');
  }
  const entityId = bindings[0]?.key.slot.entityId;
  if (entityId === undefined) throw new RangeError('expected bindings are empty');
  validateExpectedEntityBindings(entityId, bindings);
}

function isCanonicalEntityEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    Number.isSafeInteger(value.revision) &&
    typeof value.versionHash === 'string' &&
    isOptionalTransform3d(value.placement)
  );
}

function isOptionalTransform3d(value: unknown): value is Transform3d | null {
  return value === null || isTransform3d(value);
}

function isTransform3d(value: unknown): value is Transform3d {
  return Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);
}

function isEntityCommandJournalKind(value: unknown): value is KernelEntityCommandJournalKind {
  return (
    value === 'transformEntity' ||
    value === 'undoTransformEntity' ||
    value === 'redoTransformEntity'
  );
}

function parseCanonicalRetirementMutation(value: unknown): KernelCanonicalRetirementMutation {
  const mutation = parseEntityMutation(value);
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.slots) ||
    !Array.isArray(value.tombstones) ||
    !value.tombstones.every(isGeometryRepresentationBindingRef)
  ) {
    throw new TypeError('kernel canonical retirement result is malformed');
  }
  return {
    ...mutation,
    slots: value.slots as number,
    tombstones: value.tombstones,
    retiredDatasetIds: [],
  };
}

function isGeometryRepresentationBindingRef(
  value: unknown,
): value is GeometryRepresentationBindingRef {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.generation) ||
    !isRecord(value.key) ||
    !isRecord(value.key.slot)
  )
    return false;
  const slot = value.key.slot;
  return (
    typeof slot.entityId === 'string' &&
    slot.entityId.length > 0 &&
    typeof slot.representationSlot === 'string' &&
    slot.representationSlot.length > 0 &&
    Number.isSafeInteger(value.key.entityRevision) &&
    typeof value.key.entityVersionHash === 'string' &&
    typeof value.key.geometryRef === 'string'
  );
}

function validatePreparedTopologyRegistrations(
  admissions: readonly KernelCanonicalRenderAdmission[],
  registrations: readonly KernelPreparedTopologyRegistration[],
): void {
  const admittedSlots = new Set(
    admissions.map(({ admission }) =>
      canonicalSlotKey({
        entityId: admission.entity.id,
        representationSlot: admission.representationSlot,
      }),
    ),
  );
  const entities = new Set<string>();
  for (const registration of registrations) {
    const slot = canonicalSlotKey({
      entityId: registration.entityId,
      representationSlot: registration.representationSlot,
    });
    const partIds = new Set<string>();
    if (
      registration.entityId.length === 0 ||
      registration.representationSlot.length === 0 ||
      !admittedSlots.has(slot) ||
      registration.sectionTopologyParts.length === 0 ||
      entities.has(registration.entityId)
    ) {
      throw new RangeError('prepared topology must uniquely match one admitted entity slot');
    }
    entities.add(registration.entityId);
    for (const part of registration.sectionTopologyParts) {
      if (
        part.partId.length === 0 ||
        part.manifestUri.length === 0 ||
        part.positionUri.length === 0 ||
        part.indexUri.length === 0 ||
        partIds.has(part.partId)
      ) {
        throw new RangeError('prepared topology partition locations must be complete and unique');
      }
      partIds.add(part.partId);
    }
  }
}

function canonicalSlotKey(slot: GeometryRepresentationSlotKey): string {
  return `${slot.entityId}\0${slot.representationSlot}`;
}

function parseResourceCost(value: unknown): KernelResourceCost {
  const keys: readonly (keyof KernelResourceCost)[] = [
    'cpuCompressedBytes',
    'cpuDecodedBytes',
    'gpuBufferBytes',
    'gpuTextureBytes',
    'stagingBytes',
    'points',
    'triangles',
    'splats',
    'drawCalls',
  ];
  if (
    !isRecord(value) ||
    !keys.every(
      (key) =>
        typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0,
    )
  ) {
    throw new TypeError('kernel resource cost is malformed');
  }
  return value as unknown as KernelResourceCost;
}

function parseStreamingPublish(value: unknown): KernelStreamingPublish {
  const mutation = parseEntityMutation(value);
  if (
    !isRecord(value) ||
    typeof value.uploadedBytes !== 'number' ||
    !Number.isSafeInteger(value.uploadedBytes) ||
    value.uploadedBytes < 0 ||
    !Array.isArray(value.streams) ||
    !value.streams.every(
      (stream) =>
        isRecord(stream) &&
        typeof stream.streamId === 'string' &&
        Array.isArray(stream.proxyIds) &&
        stream.proxyIds.every((id) => typeof id === 'string'),
    )
  ) {
    throw new TypeError('kernel streaming publish is malformed');
  }
  return {
    ...mutation,
    cost: parseResourceCost(value.cost),
    uploadedBytes: value.uploadedBytes,
    streams: value.streams as unknown as KernelStreamingPublish['streams'],
  };
}

function parseAssetDependencies(value: unknown): readonly KernelAssetDependency[] {
  const kinds = new Set<KernelAssetDependency['kind']>([
    'gltfDocument',
    'buffer',
    'image',
    'schema',
  ]);
  if (
    !Array.isArray(value) ||
    !value.every(
      (dependency) =>
        isRecord(dependency) &&
        typeof dependency.ownerUri === 'string' &&
        dependency.ownerUri.length > 0 &&
        typeof dependency.sourceUri === 'string' &&
        dependency.sourceUri.length > 0 &&
        typeof dependency.kind === 'string' &&
        kinds.has(dependency.kind as KernelAssetDependency['kind']),
    )
  ) {
    throw new TypeError('kernel asset dependency report is malformed');
  }
  return value as unknown as readonly KernelAssetDependency[];
}

function parsePickResult(value: unknown): KernelPickResult {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.stale !== 'boolean' ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(isPickCandidate)
  ) {
    throw new TypeError('kernel pick result is malformed');
  }
  return value as unknown as KernelPickResult;
}

function parseGltfFeatureMetadata(value: unknown): KernelGltfFeatureMetadata {
  if (
    !isRecord(value) ||
    !portableId(value.sourcePrimitiveId) ||
    !portableId(value.triangleIndex) ||
    !isBarycentric(value.barycentric) ||
    !Array.isArray(value.featureSets) ||
    !value.featureSets.every(isGltfFeatureSet) ||
    !Array.isArray(value.propertyAttributes) ||
    !value.propertyAttributes.every(isRecord) ||
    !Array.isArray(value.propertyTextures) ||
    !value.propertyTextures.every(isRecord) ||
    (value.structuralMetadata !== null && !isRecord(value.structuralMetadata)) ||
    (value.instance !== null && !isLegacyInstanceSummary(value.instance))
  ) {
    throw new TypeError('glTF feature metadata result is malformed');
  }
  return value as unknown as KernelGltfFeatureMetadata;
}

function parsePickMetadata(value: unknown): KernelPickMetadata {
  if (
    !isRecord(value) ||
    !portableId(value.sourcePrimitiveId) ||
    (value.barycentric !== null && !isBarycentric(value.barycentric)) ||
    !isRecord(value.providers) ||
    (value.providers.gltf !== null && !isGltfProvider(value.providers.gltf)) ||
    (value.providers.legacy !== null && !isLegacyPickMetadata(value.providers.legacy)) ||
    (value.providers.potree !== null && !isPotreeProvider(value.providers.potree))
  ) {
    throw new TypeError('kernel pick metadata result is malformed');
  }
  return value as unknown as KernelPickMetadata;
}

function isPotreeProvider(value: unknown): boolean {
  if (!isRecord(value) || value.provider !== 'potree' || !isRecord(value.metadata)) return false;
  const metadata = value.metadata;
  const nullableInteger = (candidate: unknown, maximum: number): boolean =>
    candidate === null ||
    (typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      candidate <= maximum);
  return (
    typeof metadata.datasetId === 'string' &&
    typeof metadata.tileId === 'string' &&
    portableId(metadata.pointIndex) &&
    isWorldPoint(metadata.worldPosition) &&
    nullableInteger(metadata.intensity, 0xffff) &&
    nullableInteger(metadata.classification, 0xff) &&
    nullableInteger(metadata.returnNumber, 0xff) &&
    nullableInteger(metadata.numberOfReturns, 0xff) &&
    nullableInteger(metadata.pointSourceId, 0xffff) &&
    (metadata.sourceColor === null ||
      (Array.isArray(metadata.sourceColor) &&
        metadata.sourceColor.length === 4 &&
        metadata.sourceColor.every((channel) => nullableInteger(channel, 0xff))))
  );
}

function isGltfProvider(value: unknown): boolean {
  if (!isRecord(value) || value.provider !== 'gltf') return false;
  try {
    parseGltfFeatureMetadata(value.metadata);
    return true;
  } catch {
    return false;
  }
}

function isGltfFeatureSet(value: unknown): boolean {
  return (
    isRecord(value) &&
    portableId(value.featureCount) &&
    (value.label === null || typeof value.label === 'string') &&
    (value.nullFeatureId === null || portableId(value.nullFeatureId)) &&
    (value.propertyTable === null || portableId(value.propertyTable)) &&
    (value.propertyTableDefinition === null || isRecord(value.propertyTableDefinition)) &&
    (value.propertyRow === null || isRecord(value.propertyRow)) &&
    isRecord(value.binding) &&
    isRecord(value.resolved) &&
    (value.resolved.kind === 'null' ||
      value.resolved.kind === 'textureSampleRequired' ||
      value.resolved.kind === 'unresolved' ||
      (value.resolved.kind === 'feature' && portableId(value.resolved.id)))
  );
}

function isLegacyInstanceSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    portableId(value.index) &&
    portableId(value.featureId) &&
    portableId(value.batchLength) &&
    (value.batchTableRow === null || isRecord(value.batchTableRow))
  );
}

function isLegacyPickMetadata(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.provider !== 'b3dm' && value.provider !== 'i3dm' && value.provider !== 'pnts') ||
    !portableId(value.batchLength) ||
    (value.featureId !== null && !portableId(value.featureId)) ||
    (value.directRow !== null && !isRecord(value.directRow)) ||
    (value.resolvedRow !== null && !isRecord(value.resolvedRow)) ||
    !isLegacyPickSource(value.source, value.provider) ||
    (value.hierarchy !== null && !isLegacyHierarchy(value.hierarchy))
  ) {
    return false;
  }
  return value.featureId === null || value.featureId < value.batchLength;
}

function isLegacyPickSource(value: unknown, provider: 'b3dm' | 'i3dm' | 'pnts'): boolean {
  if (!isRecord(value)) return false;
  if (provider === 'b3dm') {
    return (
      value.kind === 'triangle' &&
      portableId(value.triangleIndex) &&
      portableId(value.primitiveTriangleIndex)
    );
  }
  if (provider === 'i3dm') {
    return (
      value.kind === 'instance' &&
      portableId(value.instanceIndex) &&
      portableId(value.modelTriangleIndex)
    );
  }
  return value.kind === 'point' && portableId(value.pointIndex);
}

function isLegacyHierarchy(value: unknown): boolean {
  return (
    isRecord(value) &&
    isLegacyHierarchyInstance(value.exactInstance) &&
    Array.isArray(value.ancestors) &&
    value.ancestors.every(isLegacyHierarchyInstance)
  );
}

function isLegacyHierarchyInstance(value: unknown): boolean {
  return (
    isRecord(value) &&
    portableId(value.instanceId) &&
    portableId(value.classId) &&
    typeof value.className === 'string' &&
    portableId(value.classInstanceIndex) &&
    Array.isArray(value.parentIds) &&
    value.parentIds.every(portableId)
  );
}

function isBarycentric(value: unknown): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((weight) => typeof weight === 'number' && Number.isFinite(weight))
  );
}

function portableId(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
  );
}

function isPickCandidate(value: unknown): value is KernelPickCandidate {
  return (
    isRecord(value) &&
    isRecord(value.address) &&
    typeof value.address.entityId === 'string' &&
    typeof value.address.renderProxyId === 'string' &&
    isSourcePoint(value.worldPosition) &&
    isWorldPoint(value.presentationPosition) &&
    typeof value.snapKind === 'string' &&
    typeof value.pixelDistance === 'number' &&
    Number.isFinite(value.pixelDistance) &&
    typeof value.depth === 'number' &&
    Number.isFinite(value.depth)
  );
}

function isSourcePoint(value: unknown): value is KernelSourcePoint {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    (value.z === null || (typeof value.z === 'number' && Number.isFinite(value.z)))
  );
}

function isWorldPoint(value: unknown): value is KernelWorldPoint {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    typeof value.z === 'number' &&
    Number.isFinite(value.z)
  );
}

function validateStrokeStyle(stroke: KernelStrokeStyle): void {
  if (stroke.mode.kind === 'lineType') {
    if ('resourceId' in stroke.mode && stroke.mode.resourceId.length === 0) {
      throw new RangeError('stroke line type resourceId must be non-empty');
    }
    if ('resource' in stroke.mode) parseCanonicalResourceRef(stroke.mode.resource);
  }
  if (
    stroke.color.kind === 'uniform' &&
    stroke.color.color.some((channel) => !Number.isFinite(channel))
  ) {
    throw new RangeError('uniform stroke color must be finite');
  }
  if (
    stroke.width.kind === 'screen' &&
    (!Number.isFinite(stroke.width.pixels) || stroke.width.pixels <= 0)
  ) {
    throw new RangeError('screen stroke width must be finite and strictly positive');
  }
  if (!Number.isFinite(stroke.miterLimit) || stroke.miterLimit < 1) {
    throw new RangeError('stroke miterLimit must be finite and at least one');
  }
}

function parseCanonicalResourceRef(value: unknown): CanonicalResourceRef {
  if (
    !isRecord(value) ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0 ||
    typeof value.schemaId !== 'string' ||
    value.schemaId.length === 0 ||
    typeof value.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.contentHash)
  ) {
    throw new TypeError('canonical resource reference is malformed');
  }
  return value as unknown as CanonicalResourceRef;
}

function cloneClipVolume(volume: KernelClipVolume): KernelClipVolume {
  return {
    ...volume,
    planes: volume.planes.map((plane) => ({
      normal: { ...plane.normal },
      distance: plane.distance,
    })),
    ...(volume.sectionFill === undefined
      ? {}
      : {
          sectionFill:
            volume.sectionFill === null ? null : cloneSectionHatchStyle(volume.sectionFill),
        }),
    ...(volume.sectionMaterialHatches === undefined
      ? {}
      : {
          sectionMaterialHatches: Object.fromEntries(
            Object.entries(volume.sectionMaterialHatches).map(([slot, style]) => [
              slot,
              cloneSectionHatchStyle(style),
            ]),
          ),
        }),
  };
}

function cloneSectionHatchStyle(style: KernelSectionHatchStyle): KernelSectionHatchStyle {
  return {
    resource: { ...style.resource },
    lineWidth: style.lineWidth,
    color: [...style.color],
  };
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validConcurrency(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffff;
}

function parseAlignmentPreviewMutation(
  value: unknown,
  expectedPreviewId: string,
): KernelAlignmentPreviewMutation {
  if (
    !isRecord(value) ||
    value.previewId !== expectedPreviewId ||
    !Number.isSafeInteger(value.generation) ||
    !Number.isSafeInteger(value.partitionCount) ||
    typeof value.alignmentVersion !== 'string' ||
    typeof value.horizontalPathVersion !== 'string' ||
    typeof value.identity !== 'string' ||
    (value.parentIdentity !== null && typeof value.parentIdentity !== 'string') ||
    !Array.isArray(value.changedPartitions) ||
    !Array.isArray(value.changedProxyIds) ||
    !value.changedProxyIds.every((id) => typeof id === 'string' && id.length > 0) ||
    !isRecord(value.workload) ||
    !Number.isSafeInteger(value.workload.partitions) ||
    !Number.isSafeInteger(value.workload.stationSamples)
  ) {
    throw new TypeError('kernel alignment-preview mutation result is malformed');
  }
  const hashes = [
    value.alignmentVersion,
    value.horizontalPathVersion,
    value.identity,
    ...(value.parentIdentity === null ? [] : [value.parentIdentity]),
  ];
  if (!hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))) {
    throw new TypeError('kernel alignment-preview mutation contains a non-canonical hash');
  }
  for (const partition of value.changedPartitions) {
    if (
      !isRecord(partition) ||
      !Number.isSafeInteger(partition.index) ||
      !isRecord(partition.stationRange) ||
      !Number.isFinite(partition.stationRange.start) ||
      !Number.isFinite(partition.stationRange.end) ||
      typeof partition.identity !== 'string' ||
      !/^[0-9a-f]{64}$/.test(partition.identity) ||
      !Array.isArray(partition.roadBody) ||
      !Array.isArray(partition.slopes)
    ) {
      throw new TypeError('kernel alignment-preview changed partition is malformed');
    }
  }
  return value as unknown as KernelAlignmentPreviewMutation;
}

function isEntityPresentationBatch(value: unknown): value is KernelEntityPresentationBatch {
  return (
    isRecord(value) &&
    typeof value.proxyId === 'string' &&
    Number.isSafeInteger(value.batchIndex) &&
    typeof value.kind === 'string' &&
    ['points', 'triangles', 'cadStroke', 'cadFill', 'raster', 'gaussianSplats', 'text'].includes(
      value.kind,
    ) &&
    Array.isArray(value.baseColor) &&
    value.baseColor.length === 4 &&
    value.baseColor.every(
      (component) => typeof component === 'number' && Number.isFinite(component),
    ) &&
    Number.isSafeInteger(value.colorMode) &&
    typeof value.fillVisible === 'boolean' &&
    typeof value.hatchEnabled === 'boolean' &&
    typeof value.strokeVisible === 'boolean' &&
    typeof value.strokeWidthOverride === 'number' &&
    Number.isFinite(value.strokeWidthOverride) &&
    Number.isSafeInteger(value.lineTypeComponents) &&
    typeof value.declaredTextureCoordinates === 'boolean' &&
    (value.sourceMaterialSlot === null || Number.isSafeInteger(value.sourceMaterialSlot)) &&
    (value.sourceMaterialColor === null ||
      (Array.isArray(value.sourceMaterialColor) &&
        value.sourceMaterialColor.length === 4 &&
        value.sourceMaterialColor.every(
          (component) => typeof component === 'number' && Number.isFinite(component),
        ))) &&
    typeof value.sourceMaterialDoubleSided === 'boolean' &&
    (value.sourceMaterialUvRows === null ||
      (Array.isArray(value.sourceMaterialUvRows) &&
        value.sourceMaterialUvRows.length === 2 &&
        value.sourceMaterialUvRows.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 4 &&
            row.every((component) => typeof component === 'number' && Number.isFinite(component)),
        ))) &&
    (value.sourcePbr === null ||
      (isRecord(value.sourcePbr) &&
        Array.isArray(value.sourcePbr.emissive) &&
        value.sourcePbr.emissive.length === 3 &&
        value.sourcePbr.emissive.every(
          (component) => typeof component === 'number' && Number.isFinite(component),
        ) &&
        typeof value.sourcePbr.metallic === 'number' &&
        Number.isFinite(value.sourcePbr.metallic) &&
        typeof value.sourcePbr.roughness === 'number' &&
        Number.isFinite(value.sourcePbr.roughness))) &&
    (value.sourcePbrTextureFlags === null || Number.isSafeInteger(value.sourcePbrTextureFlags)) &&
    (value.sourcePbrUvRows === null ||
      (Array.isArray(value.sourcePbrUvRows) &&
        value.sourcePbrUvRows.length === 10 &&
        value.sourcePbrUvRows.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 4 &&
            row.every((component) => typeof component === 'number' && Number.isFinite(component)),
        ))) &&
    typeof value.usesSourceTexture === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
