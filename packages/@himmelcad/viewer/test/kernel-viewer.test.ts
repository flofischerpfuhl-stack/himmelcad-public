import assert from 'node:assert/strict';
import test from 'node:test';

import { kernelStreamingWorkPolicy, WgpuKernelViewer } from '../src/kernel/WgpuKernelViewer.js';
import { KernelViewerSession } from '../src/kernel/KernelViewerSession.js';
import type { KernelDecodeExecutor } from '../src/kernel/KernelStreamingDriver.js';
import type {
  HimmelcadViewerWasmModule,
  KernelCanonicalRenderAdmission,
  KernelGeometryObject,
  KernelResolvedHardwarePolicy,
  WasmViewerBinding,
} from '../src/kernel/WgpuKernelViewer.js';

void test('host selects the kernel interaction streaming ceiling during navigation', () => {
  const policy = testHardwarePolicy() as unknown as KernelResolvedHardwarePolicy;
  assert.deepEqual(kernelStreamingWorkPolicy(policy, false), {
    frame: policy.frame,
    maximumTraversedNodes: 100_000,
  });
  assert.equal(kernelStreamingWorkPolicy(policy, true), policy.interaction);
  assert.equal(kernelStreamingWorkPolicy(policy, true).frame.newRequests, 1);
  assert.equal(kernelStreamingWorkPolicy(policy, true).maximumTraversedNodes, 6_250);
});

void test('kernel canvas host preserves high-end device limits and f64 origin', async () => {
  const calls: unknown[][] = [];
  const canvas = { width: 0, height: 0, clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement;
  const binding: WasmViewerBinding = {
    resize(width, height): void {
      calls.push(['resize', width, height]);
    },
    set_view_projection(values): void {
      calls.push(['matrix', ...values]);
    },
    set_world_camera_json(cameraJson): void {
      calls.push(['worldCamera', cameraJson]);
    },
    set_camera_transition_json(transitionJson, progress): void {
      calls.push(['cameraTransition', transitionJson, progress]);
    },
    set_floating_origin(x, y, z): void {
      calls.push(['origin', x, y, z]);
    },
    set_clear_color(r, g, b, a): void {
      calls.push(['clear', r, g, b, a]);
    },
    set_point_size(pointSize): void {
      calls.push(['pointSize', pointSize]);
    },
    canonical_entity_version_hash_json: () => '11'.repeat(32),
    geometry_object_content_hash_json: () => '22'.repeat(32),
    block_definition_content_hash_json: () => '33'.repeat(32),
    line_type_resource_content_hash_json: () => '34'.repeat(32),
    hatch_pattern_resource_content_hash_json: () => '56'.repeat(32),
    texture_resource_content_hash_json: () => '57'.repeat(32),
    material_resource_content_hash_json: () => '58'.repeat(32),
    material_table_resource_content_hash_json: () => '59'.repeat(32),
    section_topology_partition_content_hash_json: () => '66'.repeat(32),
    section_product_content_hash_json: () => '55'.repeat(32),
    publish_canonical_representations_json(admissionsJson): string {
      calls.push(['publishCanonical', admissionsJson]);
      const admissions = JSON.parse(admissionsJson) as Array<{
        admission: {
          entity: { id: string; revision: number; versionHash: string };
          representationSlot: string;
          selected: { geometryRef: string };
        };
      }>;
      const bindings = admissions.map(({ admission }) => ({
        key: {
          slot: { entityId: admission.entity.id, representationSlot: admission.representationSlot },
          entityRevision: admission.entity.revision,
          entityVersionHash: admission.entity.versionHash,
          geometryRef: admission.selected.geometryRef,
        },
        generation: 1,
      }));
      return JSON.stringify({
        entities: 2,
        slots: admissions.length,
        proxies: 1,
        generation: 2,
        bindings,
      });
    },
    transform_entity_json: () => {
      throw new Error('not used');
    },
    commit_move_preview_json: () => {
      throw new Error('not used');
    },
    undo_entity_command_json: () => {
      throw new Error('not used');
    },
    redo_entity_command_json: () => {
      throw new Error('not used');
    },
    entity_command_journal_json: () =>
      JSON.stringify({ entries: [], canUndo: false, canRedo: false, nextSequence: 1 }),
    inspect_3d_tiles_dependencies_json: () => '[]',
    gpu_model_cache_json: () => '{"allocations":0,"owners":0,"gpuBufferBytes":0}',
    gpu_texture_cache_json: () =>
      '{"allocations":0,"retainedAllocations":0,"owners":0,"stagedOwners":0,"gpuTextureBytes":0,"decodedSources":0,"factoryCalls":0}',
    stream_decode_diagnostics_json: () =>
      '{"workerArtifactIngests":0,"mainThreadProviderDecodes":0}',
    potree_decode_parameters_json: () => '{}',
    stage_decoded_streaming_payload: () => JSON.stringify(zeroCost()),
    remove_3d_tiles_content(): boolean {
      return true;
    },
    remove_potree_content(): boolean {
      return true;
    },
    remove_gaussian_splat_content(): boolean {
      return true;
    },
    publish_staged_contents_json(): string {
      return JSON.stringify({
        entities: 1,
        proxies: 1,
        generation: 1,
        cost: zeroCost(),
        uploadedBytes: 0,
        streams: [],
      });
    },
    remove_raster_content(): boolean {
      return true;
    },
    discard_staged_content(): boolean {
      return true;
    },
    register_3d_tiles_dataset(): string {
      return 'explicit3dTiles';
    },
    three_d_tiles_metadata_json(): string {
      return JSON.stringify({
        schema: null,
        schemaUri: 'https://example.test/schema.json',
        tileset: { class: 'city' },
        groups: [{ class: 'terrain' }],
        statistics: null,
      });
    },
    gltf_feature_metadata_json(proxyId, primitiveId, x, y, z): string {
      calls.push(['gltfFeature', proxyId, primitiveId, x, y, z]);
      return JSON.stringify({
        sourcePrimitiveId: primitiveId,
        triangleIndex: primitiveId,
        barycentric: [0.8, 0.1, 0.1],
        featureSets: [
          {
            featureCount: 2,
            label: 'buildingId',
            nullFeatureId: null,
            propertyTable: 0,
            propertyTableDefinition: { class: 'building', count: 2 },
            propertyRow: { height: 27.25, name: 'tower' },
            binding: { kind: 'attribute', attribute: 0 },
            resolved: { kind: 'feature', id: 1 },
          },
        ],
        propertyAttributes: [],
        propertyTextures: [],
        structuralMetadata: { propertyTables: [{ class: 'building', count: 2 }] },
        instance: null,
      });
    },
    pick_metadata_json(proxyId, primitiveId, x, y, z): string {
      calls.push(['pickMetadata', proxyId, primitiveId, x, y, z]);
      return JSON.stringify({
        sourcePrimitiveId: primitiveId,
        barycentric: [0.8, 0.1, 0.1],
        providers: {
          gltf: null,
          legacy: {
            provider: 'b3dm',
            source: { kind: 'triangle', triangleIndex: primitiveId, primitiveTriangleIndex: 0 },
            featureId: 1,
            batchLength: 2,
            directRow: { name: 'tower' },
            resolvedRow: { name: 'tower', district: 'central' },
            hierarchy: {
              exactInstance: {
                instanceId: 1,
                classId: 0,
                className: 'building',
                classInstanceIndex: 1,
                parentIds: [2],
              },
              ancestors: [
                {
                  instanceId: 2,
                  classId: 1,
                  className: 'block',
                  classInstanceIndex: 0,
                  parentIds: [2],
                },
              ],
            },
          },
          potree: null,
        },
      });
    },
    register_potree_dataset(): void {},
    register_prepared_dataset(): void {},
    register_prepared_dataset_and_publish_canonical_json(
      _datasetId,
      _formatId,
      _manifestUri,
      _manifestJson,
      admissionsJson,
    ): string {
      calls.push(['atomicPreparedCanonical', admissionsJson]);
      return binding.publish_canonical_representations_json(admissionsJson);
    },
    register_glyph_atlas(objectHash, metadataJson, rgba8): void {
      calls.push(['glyphAtlas', objectHash, metadataJson, rgba8.byteLength]);
    },
    register_annotation_style(): void {},
    register_block_definition(): void {},
    register_block_member_style(): void {},
    register_block_attribute_table(): void {},
    register_image_resource(): void {},
    register_depth_resource(): void {},
    measure_raster_depth_sample_json: () =>
      JSON.stringify({
        entityId: 'raster',
        column: 0,
        row: 0,
        depth: 1,
        confidence: null,
        sourcePosition: { x: 0, y: 0, z: 1 },
      }),
    measure_raster_depth_distance_json: () =>
      JSON.stringify({ picks: [], segmentDistances: [1], totalDistance: 1 }),
    set_raster_analysis_view_json: () =>
      JSON.stringify({
        entityId: 'raster',
        versionHash: null,
        width: 4,
        height: 4,
        kind: 'orientedImage',
        origin: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: -1, z: 0 },
        verticalSpan: 2,
      }),
    clear_raster_analysis_view: () => true,
    register_raster_binary_resource(): void {},
    register_mesh_resource(): void {},
    register_canonical_hatch_pattern_resource(): void {},
    register_canonical_texture_resource(): void {},
    register_canonical_material_resource_set(): void {},
    register_canonical_line_type_resource(resourceJson): void {
      calls.push(['canonicalLineType', resourceJson]);
    },
    register_line_type_resource(resourceId, patternJson): string {
      calls.push(['lineType', resourceId, patternJson]);
      return JSON.stringify({
        resourceId,
        schemaId: 'hcad.resource.line-type@1',
        contentHash: 'ab'.repeat(32),
      });
    },
    begin_authoritative_section_evaluation(): string {
      return JSON.stringify({ topologyHash: '66'.repeat(32), closedManifold: false, parts: [] });
    },
    skip_authoritative_section_partition(): boolean {
      return false;
    },
    push_authoritative_section_partition(): void {},
    finish_authoritative_section_evaluation(): string {
      return '{}';
    },
    cancel_authoritative_section_evaluation(): boolean {
      return true;
    },
    register_section_product(objectHash, productJson): void {
      calls.push(['sectionProduct', objectHash, productJson]);
    },
    plan_streaming_frame_json(): string {
      return JSON.stringify({
        render: [],
        renderCount: 0,
        actions: [],
        admission: {},
        eviction: {},
        claimedDecodeMs: 0,
      });
    },
    streaming_runtime_json: () =>
      JSON.stringify({
        limits: { decoderWorkers: 1, contentRequests: 4 },
        activeDecodes: 0,
        inFlightContentRequests: 0,
        trackedEntries: 0,
        residencyStageCounts: zeroResidencyStages(),
        residencyCost: zeroCost(),
      }),
    streaming_fetched(): void {},
    streaming_decoded(): void {},
    streaming_uploaded(): void {},
    streaming_failed(): void {},
    apply_hierarchy_page(): void {},
    hierarchy_page_failed(): void {},
    retire_canonical_entities_json(bindingsJson): string {
      calls.push(['retireCanonical', bindingsJson]);
      const bindings = JSON.parse(bindingsJson) as Array<{
        key: unknown;
        generation: number;
      }>;
      return JSON.stringify({
        tombstones: bindings.map((binding) => ({
          key: binding.key,
          generation: binding.generation + 1,
        })),
        entities: 0,
        slots: 0,
        proxies: 0,
        generation: 3,
      });
    },
    set_entity_style_json(): number {
      return 1;
    },
    set_entity_interaction_state(entityId, selected, hovered): number {
      calls.push(['entityInteraction', entityId, selected, hovered]);
      return 1;
    },
    set_entity_visibility(entityId, visible): number {
      calls.push(['entityVisibility', entityId, visible]);
      return 1;
    },
    begin_move_preview(): number {
      return 1;
    },
    update_move_preview(): void {},
    remove_move_preview(): boolean {
      return true;
    },
    build_alignment_preview_json(previewId, requestJson): string {
      calls.push(['buildAlignmentPreview', previewId, requestJson]);
      return alignmentPreviewMutation(previewId, 0, null);
    },
    update_alignment_preview_json(previewId, requestJson): string {
      calls.push(['updateAlignmentPreview', previewId, requestJson]);
      return alignmentPreviewMutation(previewId, 1, '88'.repeat(32));
    },
    remove_alignment_preview(previewId): boolean {
      calls.push(['removeAlignmentPreview', previewId]);
      return true;
    },
    upsert_section_json(requestJson): string {
      calls.push(['section', requestJson]);
      return JSON.stringify({ proxies: 1, generation: 7 });
    },
    remove_section(): boolean {
      return true;
    },
    set_clip_volumes_json(volumesJson): void {
      calls.push(['clips', volumesJson]);
    },
    world_generation(): bigint {
      return 2n;
    },
    render(): string {
      return JSON.stringify({ status: 'presented', reconfigured: false });
    },
    recover_surface(): void {
      calls.push(['recoverSurface']);
    },
    begin_render_pick(): Promise<string> {
      return Promise.resolve('{}');
    },
    finish_render_pick(): string {
      return JSON.stringify({
        generation: 2,
        stale: false,
        candidates: [
          {
            address: {
              entityId: 'point-1',
              renderProxyId: 'point-1@1',
              datasetId: null,
              tileId: null,
              primitiveId: 0,
            },
            worldPosition: { x: 1, y: 2, z: 3 },
            presentationPosition: { x: 1, y: 2, z: 3 },
            snapKind: 'point',
            pixelDistance: 0,
            depth: 0.25,
          },
        ],
      });
    },
    capabilities_json(): string {
      return JSON.stringify({
        adapterName: 'large discrete adapter',
        deviceKind: 'discreteGpu',
        backend: 'webGpu',
        driver: 'browser',
        driverInfo: '',
        features: ['webGpuCompliant'],
        maxTextureDimension2d: 32_768,
        maxStorageBufferBindingSize: 1_073_741_824,
        maxBufferSize: 4_294_967_296,
        maxSampleCount: 8,
      });
    },
    hardware_policy_json(requestJson): string {
      calls.push(['hardwarePolicy', JSON.parse(requestJson)]);
      return JSON.stringify(testHardwarePolicy());
    },
    runtime_quality_json: () => JSON.stringify({ renderScale: 1, detailScale: 0.75 }),
    observe_frame_telemetry_json(observationJson): string {
      calls.push(['telemetry', JSON.parse(observationJson)]);
      return JSON.stringify({
        adjustment: 'reduced',
        quality: { renderScale: 0.9, detailScale: 0.6375 },
      });
    },
    frame_telemetry_json: () =>
      JSON.stringify({
        frames: 240,
        cpu: { p50Ms: 10, p95Ms: 20, p99Ms: 30, maximumMs: 40 },
        gpu: null,
        effective: { p50Ms: 10, p95Ms: 20, p99Ms: 30, maximumMs: 40 },
        meanUploadedBytes: 512,
        peakResidentGpuBytes: 4096,
        peakPoints: 100,
        peakTriangles: 200,
        peakSplats: 300,
        peakDrawCalls: 4,
      }),
    gpu_frame_timing_json: () =>
      JSON.stringify({
        supported: true,
        pendingReadbacks: 1,
        latestGpuMs: 4.25,
        completedSamples: 12,
        saturatedFrames: 0,
        failedReadbacks: 0,
      }),
    begin_hardware_calibration: () => JSON.stringify(testCalibrationProgress(false)),
    step_hardware_calibration: () => JSON.stringify(testCalibrationProgress(true)),
    width(): number {
      return canvas.width;
    },
    height(): number {
      return canvas.height;
    },
    free(): void {
      calls.push(['free']);
    },
  };
  const module: HimmelcadViewerWasmModule = {
    WasmViewer: { create: () => Promise.resolve(binding) },
  };
  const viewer = await WgpuKernelViewer.create(canvas, () => Promise.resolve(module));
  const extent = viewer.resize(10_000, 5_000, 2);
  assert.deepEqual(extent, { width: 20_000, height: 10_000, devicePixelRatio: 2 });
  viewer.setCamera({
    viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    floatingOrigin: [6_378_137.000_001, 5_400_000.000_002, 712.003],
  });
  assert.deepEqual(calls.at(-1), ['origin', 6_378_137.000_001, 5_400_000.000_002, 712.003]);
  assert.deepEqual(viewer.render(), { status: 'presented', reconfigured: false });
  binding.render = () => JSON.stringify({ status: 'recreateDevice', reason: 'outOfMemory' });
  assert.deepEqual(viewer.render(), { status: 'recreateDevice', reason: 'outOfMemory' });
  binding.render = () => JSON.stringify({ status: 'recreateDevice', reason: 'deviceLost' });
  assert.deepEqual(viewer.render(), { status: 'recreateDevice', reason: 'deviceLost' });
  viewer.recoverSurface();
  assert.deepEqual(calls.at(-1), ['recoverSurface']);
  const hardwareInventory = {
    gpuMemoryBytes: null,
    systemMemoryBytes: null,
    logicalCores: 8,
  };
  viewer.resolveHardwarePolicy(hardwareInventory);
  assert.deepEqual(calls.at(-1), [
    'hardwarePolicy',
    { inventory: hardwareInventory, calibration: null, deploymentProfile: 'desktop' },
  ]);
  viewer.resolveHardwarePolicy(hardwareInventory, null, 'mobileWebView');
  assert.deepEqual(calls.at(-1), [
    'hardwarePolicy',
    { inventory: hardwareInventory, calibration: null, deploymentProfile: 'mobileWebView' },
  ]);
  assert.deepEqual(viewer.streamingRuntime(), {
    limits: { decoderWorkers: 1, contentRequests: 4 },
    activeDecodes: 0,
    inFlightContentRequests: 0,
    trackedEntries: 0,
    residencyStageCounts: zeroResidencyStages(),
    residencyCost: zeroCost(),
  });
  assert.deepEqual(viewer.streamDecodeDiagnostics(), {
    workerArtifactIngests: 0,
    mainThreadProviderDecodes: 0,
  });
  assert.deepEqual(viewer.runtimeQuality(), { renderScale: 1, detailScale: 0.75 });
  assert.deepEqual(
    viewer.observeFrameTelemetry({
      cpuMs: 20,
      interacting: true,
      uploadedBytes: 512,
    }),
    {
      adjustment: 'reduced',
      quality: { renderScale: 0.9, detailScale: 0.6375 },
    },
  );
  assert.deepEqual(calls.at(-1), [
    'telemetry',
    {
      cpuMs: 20,
      interacting: true,
      uploadedBytes: 512,
    },
  ]);
  assert.equal(viewer.frameTelemetry()?.cpu.p99Ms, 30);
  assert.throws(
    () =>
      viewer.observeFrameTelemetry({
        cpuMs: Number.NaN,
        interacting: false,
        uploadedBytes: 0,
      }),
    /frame telemetry/,
  );
  assert.deepEqual(
    viewer.publishCanonicalRepresentations([
      canonicalAdmission('point-1', { kind: 'point', position: { x: 1, y: 2, z: 3 } }),
    ]),
    {
      entities: 2,
      slots: 1,
      proxies: 1,
      generation: 2,
      bindings: [
        {
          key: {
            slot: { entityId: 'point-1', representationSlot: 'primary' },
            entityRevision: 1,
            entityVersionHash: '11'.repeat(32),
            geometryRef: '22'.repeat(32),
          },
          generation: 1,
        },
      ],
    },
  );
  assert.equal(viewer.worldGeneration(), 2n);
  assert.equal(viewer.canonicalEntityBindings('point-1')[0]?.key.slot.entityId, 'point-1');
  assert.equal(viewer.setEntityVisibility('point-1', false), 1);
  assert.deepEqual(calls.at(-1), ['entityVisibility', 'point-1', false]);
  assert.equal(viewer.setEntityInteractionState('point-1', { selected: true, hovered: false }), 1);
  assert.deepEqual(calls.at(-1), ['entityInteraction', 'point-1', true, false]);
  assert.deepEqual(viewer.threeDTilesMetadata('city'), {
    schema: null,
    schemaUri: 'https://example.test/schema.json',
    tileset: { class: 'city' },
    groups: [{ class: 'terrain' }],
    statistics: null,
  });
  assert.equal(
    viewer.gltfFeatureMetadata('tile-proxy', 3, { x: 1, y: 2, z: 3 }).featureSets[0]?.resolved.kind,
    'feature',
  );
  assert.equal(
    viewer.pickMetadata('tile-proxy', 3, { x: 1, y: 2, z: 3 }).providers.legacy?.resolvedRow
      ?.district,
    'central',
  );
  assert.deepEqual(
    viewer.publishCanonicalRepresentations([
      canonicalAdmission(
        'scan-entity',
        {
          kind: 'pointCloud',
          dataset: {
            formatId: 'potree@2',
            metadata: {
              objectHash: 'a'.repeat(64),
              mediaType: 'application/json',
              byteLength: null,
            },
            elementCount: null,
          },
        },
        'scan',
      ),
    ]),
    {
      entities: 2,
      slots: 1,
      proxies: 1,
      generation: 2,
      bindings: [
        {
          key: {
            slot: { entityId: 'scan-entity', representationSlot: 'primary' },
            entityRevision: 1,
            entityVersionHash: '11'.repeat(32),
            geometryRef: '22'.repeat(32),
          },
          generation: 1,
        },
      ],
    },
  );
  const scanBinding = viewer.canonicalStreamBinding('scan');
  assert.equal(scanBinding.key.slot.entityId, 'scan-entity');
  const retirement = viewer.retireCanonicalEntities([scanBinding]);
  assert.equal(retirement.tombstones[0]?.generation, scanBinding.generation + 1);
  assert.equal(retirement.slots, 0);
  assert.throws(() => viewer.canonicalStreamBinding('scan'), /no current canonical/);
  assert.equal(calls.at(-1)?.[0], 'retireCanonical');
  assert.equal(viewer.beginHardwareCalibration().completedSamples, 0);
  assert.equal(viewer.stepHardwareCalibration().calibration?.triangleMillionsPerSecond, 400);
  viewer.registerGlyphAtlas(
    'font-hash',
    {
      width: 1,
      height: 1,
      lineHeight: 1,
      glyphs: {},
      fallback: null,
    },
    new Uint8Array([255, 255, 255, 255]),
  );
  assert.equal(calls.at(-1)?.[0], 'glyphAtlas');
  viewer.registerSectionProduct('evaluated-section-hash', {
    schemaVersion: 2,
    source: {
      entityId: 'streamed-mesh',
      datasetId: 'streamed-dataset',
      versionHash: 'streamed-mesh-v1',
      topologyHash: 'streamed-topology-v1',
      closedManifold: true,
      parts: [
        { partId: 'tile-left', topologyHash: 'left-v1' },
        { partId: 'tile-right', topologyHash: 'right-v1' },
      ],
    },
    plane: {
      origin: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: 0, z: 1 },
    },
    tolerance: 0.001,
    materialRegions: [
      {
        regionIndex: 0,
        regionId: 'wall-core',
        materialKey: 'material:insulation',
      },
    ],
    product: {
      segments: [
        {
          start: { x: 0, y: 0, z: 1 },
          end: { x: 1, y: 0, z: 1 },
          materialSlot: 4,
        },
      ],
      regions: [
        {
          materialSlot: 4,
          outer: {
            points: [
              { x: 0, y: 0, z: 1 },
              { x: 1, y: 0, z: 1 },
              { x: 0, y: 1, z: 1 },
            ],
          },
          holes: [],
          vertices: [
            { x: 0, y: 0, z: 1 },
            { x: 1, y: 0, z: 1 },
            { x: 0, y: 1, z: 1 },
          ],
          indices: [0, 1, 2],
        },
      ],
    },
  });
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ['sectionProduct', 'evaluated-section-hash']);
  assert.deepEqual(
    viewer.upsertSection({
      sectionId: 'streamed-section',
      entityId: 'streamed-mesh',
      productHash: 'evaluated-section-hash',
      plane: {
        origin: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: 0, z: 1 },
      },
      tolerance: 0.001,
      materialHatches: {
        'material:insulation': {
          resource: {
            resourceId: 'wall-insulation',
            schemaId: 'hcad.resource.hatch-pattern@1',
            contentHash: 'cd'.repeat(32),
          },
          lineWidth: 0.025,
          color: [0.2, 0.2, 0.2, 1],
        },
      },
      hatch: {
        resource: {
          resourceId: 'section-default',
          schemaId: 'hcad.resource.hatch-pattern@1',
          contentHash: 'ef'.repeat(32),
        },
        lineWidth: 0.025,
        color: [0.2, 0.2, 0.2, 1],
      },
    }),
    { proxies: 1, generation: 7 },
  );
  const sectionCall = calls.at(-1);
  assert.equal(sectionCall?.[0], 'section');
  const sectionRequest = JSON.parse(String(sectionCall?.[1])) as Record<string, unknown>;
  assert.equal(sectionRequest.productHash, 'evaluated-section-hash');
  assert.deepEqual(sectionRequest.materialHatches, {
    'material:insulation': {
      resource: {
        resourceId: 'wall-insulation',
        schemaId: 'hcad.resource.hatch-pattern@1',
        contentHash: 'cd'.repeat(32),
      },
      lineWidth: 0.025,
      color: [0.2, 0.2, 0.2, 1],
    },
  });
  const preview = viewer.buildAlignmentPreview('road-edit', {
    alignment: {
      horizontal: {
        kind: 'lineSegment',
        start: { x: 0, y: 0, z: null },
        end: { x: 30, y: 0, z: null },
      },
      vertical: [{ kind: 'grade', startStation: 1_000, startElevation: 100, grade: 0, length: 30 }],
      stationOrigin: 1_000,
      widthBands: [],
      crossfallBands: [],
      slopeRules: [],
    },
    alignmentVersion: '77'.repeat(32),
    targets: [],
    config: {
      chordTolerance: 0.01,
      maximumCurveSegments: 128,
      partitionLength: 30,
      sampleStep: 10,
      maximumPartitionsPerUpdate: 1,
      maximumSamplesPerPartition: 8,
      maximumRoadBandsPerPartition: 8,
      maximumSlopeRulesPerPartition: 8,
    },
  });
  assert.equal(preview.previewId, 'road-edit');
  assert.equal(preview.generation, 0);
  assert.equal(calls.at(-1)?.[0], 'buildAlignmentPreview');
  const updatedPreview = viewer.updateAlignmentPreview('road-edit', {
    expectedGeneration: preview.generation,
    alignmentVersion: '77'.repeat(32),
    horizontalPathVersion: preview.horizontalPathVersion,
    partitions: [],
    targets: [],
    affected: { start: 1_000, end: 1_030 },
  });
  assert.equal(updatedPreview.generation, 1);
  assert.equal(updatedPreview.parentIdentity, preview.identity);
  assert.equal(viewer.removeAlignmentPreview('road-edit'), true);
  assert.equal(calls.at(-1)?.[0], 'removeAlignmentPreview');
  viewer.registerLineTypeResource('survey-dash', {
    segments: [2.4, 0.8, 0.25, 0.8],
    phase: 0.15,
  });
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ['lineType', 'survey-dash']);
  assert.throws(
    () => viewer.registerLineTypeResource('invalid', { segments: [1, 0] }),
    /positive lengths/,
  );
  viewer.setClipVolumes([
    {
      id: 'box',
      planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 0 }],
      operation: 'keepInside',
      previewCap: true,
      enabled: true,
    },
  ]);
  const pick = await viewer.pick(10, 20, 4);
  assert.equal(pick.candidates[0]?.worldPosition.z, 3);
  assert.deepEqual(pick.candidates[0]?.presentationPosition, { x: 1, y: 2, z: 3 });
  assert.equal(pick.stale, false);
  assert.throws(
    () => viewer.pickMetadata('point-1@1', 0, { x: 1, y: 2, z: null }),
    /finite and portable/,
  );
  assert.throws(
    () =>
      viewer.setEntityStyle('flattened', {
        baseColor: [1, 1, 1, 1],
        opacity: 1,
        verticalExaggeration: 0,
        colorMode: { kind: 'uniform' },
        fill: { kind: 'color' },
        stroke: {
          mode: { kind: 'color' },
          color: { kind: 'inherit' },
          width: { kind: 'source' },
          cap: 'butt',
          join: 'miter',
          miterLimit: 4,
        },
      }),
    /strictly positive/,
  );
  viewer.dispose();
  assert.throws(() => viewer.render(), /disposed/);
});

void test('kernel canvas host suspends zero extent and rejects incomplete cameras', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  let resized: readonly [number, number] = [1, 1];
  const binding = minimalBinding(canvas, (width, height) => {
    resized = [width, height];
  });
  const viewer = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
  );
  viewer.resize(0, 0, 2);
  assert.deepEqual(resized, [0, 0]);
  assert.throws(
    () => viewer.setCamera({ viewProjection: [1, 2], floatingOrigin: [0, 0, 0] }),
    /16 values/,
  );
});

void test('renderer RGBA capture is bounded, GPU-promise based and abortable', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const binding = minimalBinding(canvas, () => undefined);
  const calls: unknown[][] = [];
  binding.capture_capabilities_json_v1 = () =>
    JSON.stringify({
      version: 1,
      maxDimension: 4_096,
      maxPixels: 16_777_216,
      maxRgbaBytes: 67_108_864,
      colorSpace: 'srgb',
      alphaMode: 'straight',
      transparentBackground: true,
    });
  binding.begin_capture_rgba_v1 = (width, height, transparent) => {
    calls.push([width, height, transparent]);
    return Promise.resolve(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  };
  const viewer = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
  );

  const result = await viewer.captureRgba({
    width: 2,
    height: 1,
    transparentBackground: true,
  });
  assert.deepEqual(calls, [[2, 1, true]]);
  assert.deepEqual(result, {
    width: 2,
    height: 1,
    rgba8: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    colorSpace: 'srgb',
    alphaMode: 'straight',
    includeUi: false,
    transparentBackground: true,
  });
  await assert.rejects(
    viewer.captureRgba({ width: 1, height: 1, includeUi: true } as never),
    /includeUi=false/,
  );
  await assert.rejects(viewer.captureRgba({ width: 4_097, height: 1 }), /capture limits/);

  binding.begin_capture_rgba_v1 = () => new Promise<Uint8Array>(() => undefined);
  const abort = new AbortController();
  const pending = viewer.captureRgba({ width: 1, height: 1, signal: abort.signal });
  const reason = new Error('capture cancelled');
  abort.abort(reason);
  await assert.rejects(pending, reason);
  viewer.dispose();
});

void test('device replay restores immutable resources before presentation state', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const sourceBinding = minimalBinding(canvas, () => undefined);
  const source = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(sourceBinding) } }),
  );
  const pixels = new Uint8Array([1, 2, 3, 4]);
  const depths = new Float32Array([17.5]);
  source.registerImageResource('image-hash', 1, 1, pixels);
  source.registerDepthResource('depth-hash', 1, 1, depths);
  source.setCamera({
    viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    floatingOrigin: [6_378_137.25, 5_400_000.5, 712.75],
  });
  source.setClearColor([0.1, 0.2, 0.3, 1]);
  source.setEntityVisibility('survey', false);
  source.setEntityInteractionState('survey', { selected: true, hovered: false });
  pixels.fill(255);
  depths[0] = 99;

  const calls: unknown[][] = [];
  const targetBinding = minimalBinding(canvas, () => undefined);
  targetBinding.register_image_resource = (hash, width, height, bytes) =>
    calls.push(['image', hash, width, height, [...bytes]]);
  targetBinding.register_depth_resource = (hash, width, height, values) =>
    calls.push(['depth', hash, width, height, [...values]]);
  targetBinding.set_view_projection = (values) => calls.push(['matrix', [...values]]);
  targetBinding.set_floating_origin = (x, y, z) => calls.push(['origin', x, y, z]);
  targetBinding.set_clear_color = (r, g, b, a) => calls.push(['clear', r, g, b, a]);
  targetBinding.set_clip_volumes_json = (json) => calls.push(['clips', JSON.parse(json)]);
  targetBinding.set_entity_visibility = (entityId, visible) => {
    calls.push(['visible', entityId, visible]);
    return 1;
  };
  targetBinding.set_entity_interaction_state = (entityId, selected, hovered) => {
    calls.push(['interaction', entityId, selected, hovered]);
    return 1;
  };
  const target = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(targetBinding) } }),
  );

  source.replayDefinitionsInto(target);
  source.replayViewStateInto(target);

  assert.deepEqual(calls, [
    ['image', 'image-hash', 1, 1, [1, 2, 3, 4]],
    ['depth', 'depth-hash', 1, 1, [17.5]],
    ['matrix', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    ['origin', 6_378_137.25, 5_400_000.5, 712.75],
    ['clear', 0.1, 0.2, 0.3, 1],
    ['clips', []],
    ['visible', 'survey', false],
    ['interaction', 'survey', true, false],
  ]);
});

void test('already committed canonical effects update residency without a viewer journal', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const binding = minimalBinding(canvas, () => {});
  const admission = canonicalAdmission('committed', {
    kind: 'point',
    position: { x: 1, y: 2, z: 3 },
  });
  const before = admission.admission.entity;
  const after = {
    ...before,
    revision: 2,
    name: 'Committed rename',
    versionHash: 'aa'.repeat(32),
  };
  let calls = 0;
  binding.publish_canonical_representations_json = () =>
    JSON.stringify({
      entities: 1,
      slots: 1,
      proxies: 1,
      generation: 1,
      bindings: [
        {
          key: {
            slot: { entityId: before.id, representationSlot: 'primary' },
            entityRevision: before.revision,
            entityVersionHash: before.versionHash,
            geometryRef: before.representations[0]?.geometryRef,
          },
          generation: 1,
        },
      ],
    });
  binding.apply_committed_entity_effect_json = (effectJson, expectedBindingsJson) => {
    calls += 1;
    const effect = JSON.parse(effectJson) as { after: unknown };
    const expected = JSON.parse(expectedBindingsJson) as Array<{
      key: { slot: { entityId: string; representationSlot: string }; geometryRef: string };
    }>;
    assert.deepEqual(effect.after, after);
    return JSON.stringify({
      entities: 1,
      slots: 1,
      proxies: 1,
      generation: 2,
      entity: after,
      bindings: expected.map((current) => ({
        key: {
          ...current.key,
          entityRevision: 2,
          entityVersionHash: after.versionHash,
        },
        generation: 2,
      })),
    });
  };
  const viewer = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
  );
  viewer.publishCanonicalRepresentations([admission]);
  const currentBindings = viewer.canonicalEntityBindings(before.id);
  assert.equal(currentBindings.length, 1);
  assert.equal(currentBindings[0]?.key.slot.entityId, before.id);
  const mutation = viewer.applyCommittedCanonicalEffect(
    {
      entityId: before.id,
      before,
      after,
      touchedFields: ['name'],
    },
    currentBindings,
  );

  assert.equal(calls, 1);
  assert.equal(mutation.entity.name, 'Committed rename');
  assert.equal(viewer.canonicalEntityBindings(before.id)[0]?.key.entityRevision, 2);
  assert.deepEqual(viewer.entityCommandJournal().entries, []);
  viewer.dispose();
});

void test('scoped view clips compose atomically without discarding user clip boxes', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const publications: Array<Array<{ id: string }>> = [];
  const binding = minimalBinding(canvas, () => {});
  binding.set_clip_volumes_json = (json): void => {
    publications.push(JSON.parse(json) as Array<{ id: string }>);
  };
  const viewer = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
  );
  const userBox = {
    id: 'user-box',
    planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 0 }],
    operation: 'keepInside',
    previewCap: true,
    enabled: true,
  } as const;
  const profileDepth = {
    id: 'profile-depth',
    planes: [
      { normal: { x: 1, y: 0, z: 0 }, distance: 10 },
      { normal: { x: -1, y: 0, z: 0 }, distance: 2 },
    ],
    operation: 'keepInside',
    previewCap: false,
    enabled: true,
  } as const;

  viewer.setClipVolumes([userBox]);
  viewer.setScopedClipVolume('local-profile', profileDepth);
  assert.deepEqual(
    publications.at(-1)?.map(({ id }) => id),
    ['user-box', 'profile-depth'],
  );

  assert.throws(
    () => viewer.setScopedClipVolume('duplicate', { ...profileDepth, id: 'user-box' }),
    /duplicate composed clip volume id/,
  );
  viewer.setScopedClipVolume('local-profile', null);
  assert.deepEqual(
    publications.at(-1)?.map(({ id }) => id),
    ['user-box'],
  );
});

void test('prepared topology follows composed clips, live style and canonical retirement', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const binding = minimalBinding(canvas, () => {});
  const clipPublications: string[][] = [];
  const begins: string[] = [];
  const upserts: Array<{ sectionId: string; style?: { opacity: number } }> = [];
  const removed: string[] = [];
  const canonicalBinding = {
    key: {
      slot: { entityId: 'prepared', representationSlot: 'primary' },
      entityRevision: 1,
      entityVersionHash: '11'.repeat(32),
      geometryRef: '22'.repeat(32),
    },
    generation: 1,
  };
  binding.register_prepared_dataset_and_publish_canonical_json = () =>
    JSON.stringify({
      entities: 1,
      slots: 1,
      proxies: 0,
      generation: 1,
      bindings: [canonicalBinding],
    });
  binding.set_clip_volumes_json = (json): void => {
    clipPublications.push((JSON.parse(json) as Array<{ id: string }>).map(({ id }) => id));
  };
  binding.begin_authoritative_section_evaluation = (operationId, _binding, plane, tolerance) => {
    begins.push(operationId);
    return JSON.stringify({
      topologyHash: '66'.repeat(32),
      closedManifold: true,
      parts: [{ partId: 'only', topologyHash: '66'.repeat(32) }],
      plane: JSON.parse(plane),
      tolerance,
    });
  };
  binding.skip_authoritative_section_partition = () => true;
  binding.finish_authoritative_section_evaluation = () =>
    JSON.stringify({
      schemaVersion: 2,
      source: {
        entityId: 'prepared',
        datasetId: 'prepared-dataset',
        versionHash: '11'.repeat(32),
        topologyHash: '66'.repeat(32),
        closedManifold: true,
        parts: [{ partId: 'only', topologyHash: '66'.repeat(32) }],
      },
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
      tolerance: 0.001,
      materialRegions: [],
      product: { segments: [], regions: [] },
    });
  binding.upsert_section_json = (json) => {
    upserts.push(JSON.parse(json) as { sectionId: string; style?: { opacity: number } });
    return JSON.stringify({ proxies: 1, generation: upserts.length });
  };
  binding.remove_section = (sectionId) => {
    removed.push(sectionId);
    return true;
  };
  binding.retire_canonical_entities_json = () =>
    JSON.stringify({
      entities: 0,
      slots: 1,
      proxies: 0,
      generation: 3,
      tombstones: [canonicalBinding],
    });
  const viewer = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
  );
  viewer.attachClipCapCoordinator(
    { fetchImmutableResource: () => Promise.reject(new Error('culled part must not fetch')) },
    { tolerance: 0.001 },
  );
  const admission = canonicalAdmission(
    'prepared',
    {
      kind: 'surface3d',
      mesh: {
        storage: {
          kind: 'resource',
          resource: {
            objectHash: '22'.repeat(32),
            mediaType: 'himmelcad-prepared-hierarchy@1',
            byteLength: 1,
          },
        },
        closedManifold: true,
        triangleMaterialSlots: null,
        materials: null,
      },
    },
    'prepared-dataset',
  );
  viewer.registerPreparedDatasetAndPublishCanonicalRepresentations(
    'prepared-dataset',
    'himmelcad-prepared-hierarchy@1',
    'memory:///prepared/manifest.json',
    new Uint8Array([1]),
    [admission],
    [
      {
        entityId: 'prepared',
        representationSlot: 'primary',
        closedManifold: true,
        sectionTopologyParts: [
          {
            partId: 'only',
            manifestUri: 'memory:///prepared/only.json',
            positionUri: 'memory:///prepared/only.positions',
            indexUri: 'memory:///prepared/only.indices',
          },
        ],
      },
    ],
  );
  viewer.setClipVolumes([
    {
      id: 'user',
      planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 0 }],
      operation: 'keepInside',
      previewCap: true,
      enabled: true,
    },
  ]);
  viewer.setScopedClipVolume('profile', {
    id: 'profile',
    planes: [{ normal: { x: 0, y: 1, z: 0 }, distance: 0 }],
    operation: 'keepInside',
    previewCap: false,
    enabled: true,
  });
  await viewer.clipCapsSettled();
  assert.deepEqual(clipPublications.at(-1), ['user', 'profile']);
  assert.equal(upserts.at(-1)?.sectionId, 'clip-cap:prepared:user:0');
  const beginsBeforeStyle = begins.length;

  viewer.setEntityStyle('prepared', {
    baseColor: [1, 1, 1, 1],
    opacity: 0.5,
    verticalExaggeration: 1,
    colorMode: { kind: 'uniform' },
    fill: { kind: 'color' },
    stroke: {
      mode: { kind: 'color' },
      color: { kind: 'inherit' },
      width: { kind: 'source' },
      cap: 'butt',
      join: 'miter',
      miterLimit: 4,
    },
  });
  await viewer.clipCapsSettled();
  assert.equal(begins.length, beginsBeforeStyle);
  assert.equal(upserts.at(-1)?.style?.opacity, 0.5);

  viewer.retireCanonicalEntities([canonicalBinding]);
  await viewer.clipCapsSettled();
  assert(removed.includes('clip-cap:prepared:user:0'));
  viewer.dispose();
});

void test('explicit browser backend selection crosses the versioned wasm boundary', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const binding = minimalBinding(canvas, () => {});
  let selected: string | null = null;
  const viewer = await WgpuKernelViewer.create(
    canvas,
    () =>
      Promise.resolve({
        WasmViewer: {
          create: () => Promise.resolve(binding),
          create_with_backend: (_canvas, _width, _height, backend) => {
            selected = backend;
            return Promise.resolve(binding);
          },
        },
      }),
    1,
    1,
    'webgl2',
  );
  assert.equal(selected, 'webgl2');
  viewer.dispose();

  await assert.rejects(
    WgpuKernelViewer.create(
      canvas,
      () => Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
      1,
      1,
      'webgpu',
    ),
    /does not support explicit backend selection/,
  );
});

void test('concurrent viewport mounts serialize the non-reentrant wasm constructor', async () => {
  const firstCanvas = {
    width: 1,
    height: 1,
    clientWidth: 1,
    clientHeight: 1,
  } as HTMLCanvasElement;
  const secondCanvas = { ...firstCanvas } as HTMLCanvasElement;
  let activeConstructors = 0;
  let maximumActiveConstructors = 0;
  const loader = (): Promise<HimmelcadViewerWasmModule> =>
    Promise.resolve({
      WasmViewer: {
        create: () => Promise.reject(new Error('explicit WebGL2 must use create_with_backend')),
        create_with_backend: async (canvas) => {
          activeConstructors += 1;
          maximumActiveConstructors = Math.max(maximumActiveConstructors, activeConstructors);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeConstructors -= 1;
          return minimalBinding(canvas, () => {});
        },
      },
    });

  const [first, second] = await Promise.all([
    WgpuKernelViewer.create(firstCanvas, loader, 1, 1, 'webgl2'),
    WgpuKernelViewer.create(secondCanvas, loader, 1, 1, 'webgl2'),
  ]);
  assert.equal(maximumActiveConstructors, 1);
  first.dispose();
  second.dispose();
});

void test('framework-free session owns create, frame, device rebuild and dispose', async () => {
  const canvas = {
    width: 1,
    height: 1,
    clientWidth: 640,
    clientHeight: 480,
    tabIndex: -1,
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement;
  const bindings: WasmViewerBinding[] = [];
  const replayCalls: string[] = [];
  let disposedDecoders = 0;
  const createDecodeExecutor = (): KernelDecodeExecutor => ({
    setWorkerCount(): void {},
    decode: () => Promise.reject(new Error('empty frame must not decode')),
    diagnostics: () => ({
      requestedDecodeWorkers: 1,
      actualDecodeWorkers: 1,
      workerRamBudgetBytes: 256 * 1024 * 1024,
      perWorkerReservationBytes: 256 * 1024 * 1024,
      activeDecodes: 0,
      queuedDecodes: 0,
      transferredInputBytes: 0,
      transferredOutputBytes: 0,
      peakTransferBytes: 0,
      completedDecodes: 0,
      failedDecodes: 0,
      canceledDecodes: 0,
      workerDecodeMs: 0,
      mainThreadDispatchMs: 0,
      maximumWorkerBaselineLinearMemoryBytes: 0,
      maximumWorkerLinearMemoryBytes: 0,
    }),
    dispose(): void {
      disposedDecoders += 1;
    },
  });
  const loader = (): Promise<HimmelcadViewerWasmModule> =>
    Promise.resolve({
      WasmViewer: {
        create: () => {
          const binding = minimalBinding(canvas, () => {});
          const generation = bindings.length + 1;
          binding.register_image_resource = () => replayCalls.push(`${generation}:image`);
          binding.register_depth_resource = () => replayCalls.push(`${generation}:depth`);
          binding.register_raster_binary_resource = () => replayCalls.push(`${generation}:binary`);
          binding.register_mesh_resource = () => replayCalls.push(`${generation}:mesh`);
          binding.publish_canonical_representations_json = () => {
            replayCalls.push(`${generation}:canonical`);
            return JSON.stringify({
              entities: 1,
              slots: 1,
              proxies: 1,
              generation,
              bindings: [],
            });
          };
          binding.upsert_section_json = () => {
            replayCalls.push(`${generation}:section`);
            return JSON.stringify({ proxies: 1, generation });
          };
          bindings.push(binding);
          return Promise.resolve(binding);
        },
      },
    });
  const session = await KernelViewerSession.create({
    canvas,
    wasmLoader: loader,
    inventory: { gpuMemoryBytes: null, systemMemoryBytes: 8 * 1024 ** 3, logicalCores: 4 },
    createDecodeExecutor,
  });
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  const navigation = session.attachNavigation();
  await navigation.setLockedTopDown(true, 0);
  session.registerImageResource('image', 1, 1, new Uint8Array([1, 2, 3, 4]));
  session.registerDepthResource('depth', 1, 1, new Float32Array([12.5]));
  session.registerRasterBinaryResource('validity', new Uint8Array([1]));
  session.registerMeshResource('mesh', { positions: [0, 0, 0] });
  assert.equal(
    session.loadCanonical([
      canonicalAdmission('inline', { kind: 'point', position: { x: 1, y: 2, z: 3 } }),
    ])[0]?.entityId,
    'inline',
  );
  assert.deepEqual(session.measureRasterDepthSample('raster', 0, 0).sourcePosition, {
    x: 0,
    y: 0,
    z: 1,
  });
  assert.deepEqual(
    session.upsertSection({
      sectionId: 'section',
      entityIds: ['inline'],
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      tolerance: 0.001,
    }),
    { proxies: 1, generation: 1 },
  );
  assert.deepEqual(replayCalls, [
    '1:image',
    '1:depth',
    '1:binary',
    '1:mesh',
    '1:canonical',
    '1:section',
  ]);
  assert.deepEqual(session.frame(), { status: 'skipped', reason: 'Suspended' });
  assert.equal(session.diagnostics().deviceGeneration, 1);
  assert.equal(session.diagnostics().recoveringDevice, false);

  bindings[0]!.render = () => JSON.stringify({ status: 'recreateDevice', reason: 'deviceLost' });
  assert.deepEqual(session.frame(), { status: 'recreateDevice', reason: 'deviceLost' });
  await session.settled();
  assert.equal(bindings.length, 2);
  assert.equal(session.diagnostics().deviceGeneration, 2);
  await navigation.setLockedTopDown(false, 0);
  assert.deepEqual(replayCalls.slice(6), [
    '2:image',
    '2:depth',
    '2:binary',
    '2:mesh',
    '2:canonical',
    '2:section',
  ]);
  assert(events.includes('deviceRecoveryStarted'));
  assert(events.includes('deviceRecoveryCompleted'));

  session.dispose();
  assert.equal(disposedDecoders, 2);
  assert(events.includes('disposed'));
  assert.throws(() => session.diagnostics(), /disposed/);
  await assert.rejects(navigation.setLockedTopDown(true, 0), /disposed/);
});

void test('automatic backend routes a browser fallback adapter to WebGL2', async () => {
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement;
  const binding = minimalBinding(canvas, () => {});
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let selected: string | null = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      gpu: {
        requestAdapter: () => Promise.resolve({ info: { isFallbackAdapter: true } }),
      },
    },
  });
  try {
    const viewer = await WgpuKernelViewer.create(canvas, () =>
      Promise.resolve({
        WasmViewer: {
          create: () => Promise.reject(new Error('fallback adapter must not use automatic WebGPU')),
          create_with_backend: (_canvas, _width, _height, backend) => {
            selected = backend;
            return Promise.resolve(binding);
          },
        },
      }),
    );
    assert.equal(selected, 'webgl2');
    viewer.dispose();
  } finally {
    if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }
});

void test('pending WebGL2 pick mapping never owns or blocks the mutable viewer', async () => {
  const canvas = { width: 64, height: 64, clientWidth: 64, clientHeight: 64 } as HTMLCanvasElement;
  const binding = minimalBinding(canvas, () => {});
  let finishMapping = (_payload: string): void => {
    assert.fail('pick mapping resolver was not installed');
  };
  let renderedWhilePending = 0;
  let mutatedWhilePending = 0;
  binding.begin_render_pick = () =>
    new Promise<string>((resolve) => {
      finishMapping = resolve;
    });
  binding.finish_render_pick = () =>
    JSON.stringify({ generation: 0, stale: false, candidates: [] });
  binding.render = () => {
    renderedWhilePending += 1;
    return JSON.stringify({ status: 'presented', reconfigured: false });
  };
  binding.set_clear_color = () => {
    mutatedWhilePending += 1;
  };
  const viewer = await WgpuKernelViewer.create(canvas, () =>
    Promise.resolve({ WasmViewer: { create: () => Promise.resolve(binding) } }),
  );

  const pendingPick = viewer.pick(16, 16, 4);
  await Promise.resolve();
  viewer.setClearColor([0.1, 0.2, 0.3, 1]);
  assert.deepEqual(viewer.render(), { status: 'presented', reconfigured: false });
  assert.equal(mutatedWhilePending, 1);
  assert.equal(renderedWhilePending, 1);
  finishMapping('{}');
  assert.deepEqual(await pendingPick, { generation: 0, stale: false, candidates: [] });
  viewer.dispose();
});

function canonicalAdmission(
  entityId: string,
  geometry: KernelGeometryObject,
  datasetId?: string,
): KernelCanonicalRenderAdmission {
  const representation = {
    role: 'canonical' as const,
    geometryRef: '22'.repeat(32),
    authority: 'authoritative' as const,
    dependencyHash: null,
  };
  return {
    admission: {
      entity: {
        id: entityId,
        revision: 1,
        typeId: 'hcad.test@1',
        name: entityId,
        owner: null,
        layerIds: [],
        placement: null,
        representations: [representation],
        componentsRef: '33'.repeat(32),
        attributesRef: '44'.repeat(32),
        relationsRef: '55'.repeat(32),
        styleRef: null,
        schemaVersion: 1,
        versionHash: '11'.repeat(32),
      },
      selected: representation,
      representationSlot: 'primary',
      expectedGeneration: null,
      resolvedGeometry: geometry,
    },
    ...(datasetId === undefined ? {} : { datasetId }),
  };
}

function minimalBinding(
  canvas: HTMLCanvasElement,
  resize: (width: number, height: number) => void,
): WasmViewerBinding {
  return {
    resize,
    set_view_projection(): void {},
    set_world_camera_json(): void {},
    set_camera_transition_json(): void {},
    set_floating_origin(): void {},
    set_clear_color(): void {},
    set_point_size(): void {},
    canonical_entity_version_hash_json: () => '11'.repeat(32),
    geometry_object_content_hash_json: () => '22'.repeat(32),
    block_definition_content_hash_json: () => '33'.repeat(32),
    line_type_resource_content_hash_json: () => '34'.repeat(32),
    hatch_pattern_resource_content_hash_json: () => '56'.repeat(32),
    texture_resource_content_hash_json: () => '57'.repeat(32),
    material_resource_content_hash_json: () => '58'.repeat(32),
    material_table_resource_content_hash_json: () => '59'.repeat(32),
    section_topology_partition_content_hash_json: () => '66'.repeat(32),
    section_product_content_hash_json: () => '55'.repeat(32),
    publish_canonical_representations_json: () =>
      JSON.stringify({
        entities: 0,
        slots: 0,
        proxies: 0,
        generation: 0,
        bindings: [],
      }),
    transform_entity_json: () => {
      throw new Error('not used');
    },
    commit_move_preview_json: () => {
      throw new Error('not used');
    },
    undo_entity_command_json: () => {
      throw new Error('not used');
    },
    redo_entity_command_json: () => {
      throw new Error('not used');
    },
    entity_command_journal_json: () =>
      JSON.stringify({ entries: [], canUndo: false, canRedo: false, nextSequence: 1 }),
    inspect_3d_tiles_dependencies_json: () => '[]',
    gpu_model_cache_json: () => '{"allocations":0,"owners":0,"gpuBufferBytes":0}',
    gpu_texture_cache_json: () =>
      '{"allocations":0,"retainedAllocations":0,"owners":0,"stagedOwners":0,"gpuTextureBytes":0,"decodedSources":0,"factoryCalls":0}',
    stream_decode_diagnostics_json: () =>
      '{"workerArtifactIngests":0,"mainThreadProviderDecodes":0}',
    potree_decode_parameters_json: () => '{}',
    stage_decoded_streaming_payload: () => JSON.stringify(zeroCost()),
    remove_3d_tiles_content: () => false,
    remove_potree_content: () => false,
    remove_gaussian_splat_content: () => false,
    publish_staged_contents_json: () =>
      JSON.stringify({
        entities: 0,
        proxies: 0,
        generation: 0,
        cost: zeroCost(),
        uploadedBytes: 0,
        streams: [],
      }),
    remove_raster_content: () => false,
    discard_staged_content: () => false,
    register_3d_tiles_dataset: () => 'explicit3dTiles',
    three_d_tiles_metadata_json: () => 'null',
    gltf_feature_metadata_json: () =>
      JSON.stringify({
        sourcePrimitiveId: 0,
        triangleIndex: 0,
        barycentric: [1, 0, 0],
        featureSets: [],
        propertyAttributes: [],
        propertyTextures: [],
        structuralMetadata: null,
        instance: null,
      }),
    pick_metadata_json: () =>
      JSON.stringify({
        sourcePrimitiveId: 0,
        barycentric: null,
        providers: { gltf: null, legacy: null, potree: null },
      }),
    register_potree_dataset(): void {},
    register_prepared_dataset(): void {},
    register_prepared_dataset_and_publish_canonical_json: () =>
      JSON.stringify({ entities: 0, slots: 0, proxies: 0, generation: 0, bindings: [] }),
    register_glyph_atlas(): void {},
    register_annotation_style(): void {},
    register_block_definition(): void {},
    register_block_member_style(): void {},
    register_block_attribute_table(): void {},
    register_image_resource(): void {},
    register_depth_resource(): void {},
    measure_raster_depth_sample_json: () =>
      JSON.stringify({
        entityId: 'raster',
        column: 0,
        row: 0,
        depth: 1,
        confidence: null,
        sourcePosition: { x: 0, y: 0, z: 1 },
      }),
    measure_raster_depth_distance_json: () =>
      JSON.stringify({ picks: [], segmentDistances: [1], totalDistance: 1 }),
    set_raster_analysis_view_json: () =>
      JSON.stringify({
        entityId: 'raster',
        versionHash: null,
        width: 4,
        height: 4,
        kind: 'orientedImage',
        origin: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: -1, z: 0 },
        verticalSpan: 2,
      }),
    clear_raster_analysis_view: () => true,
    register_raster_binary_resource(): void {},
    register_mesh_resource(): void {},
    register_canonical_hatch_pattern_resource(): void {},
    register_canonical_texture_resource(): void {},
    register_canonical_material_resource_set(): void {},
    register_canonical_line_type_resource(): void {},
    register_line_type_resource: () =>
      JSON.stringify({
        resourceId: 'legacy',
        schemaId: 'hcad.resource.line-type@1',
        contentHash: 'ab'.repeat(32),
      }),
    begin_authoritative_section_evaluation: () =>
      JSON.stringify({ topologyHash: '66'.repeat(32), closedManifold: false, parts: [] }),
    skip_authoritative_section_partition: () => false,
    push_authoritative_section_partition(): void {},
    finish_authoritative_section_evaluation: () => '{}',
    cancel_authoritative_section_evaluation: () => true,
    register_section_product(): void {},
    plan_streaming_frame_json: () =>
      JSON.stringify({
        render: [],
        renderCount: 0,
        actions: [],
        admission: {},
        eviction: {},
        claimedDecodeMs: 0,
      }),
    streaming_runtime_json: () =>
      JSON.stringify({
        limits: { decoderWorkers: 1, contentRequests: 4 },
        activeDecodes: 0,
        inFlightContentRequests: 0,
        trackedEntries: 0,
        residencyStageCounts: zeroResidencyStages(),
        residencyCost: zeroCost(),
      }),
    streaming_fetched(): void {},
    streaming_decoded(): void {},
    streaming_uploaded(): void {},
    streaming_failed(): void {},
    apply_hierarchy_page(): void {},
    hierarchy_page_failed(): void {},
    retire_canonical_entities_json: () =>
      JSON.stringify({
        tombstones: [],
        entities: 0,
        slots: 0,
        proxies: 0,
        generation: 0,
      }),
    set_entity_style_json: () => 0,
    set_entity_interaction_state: () => 0,
    set_entity_visibility: () => 0,
    begin_move_preview: () => 0,
    update_move_preview(): void {},
    remove_move_preview: () => false,
    build_alignment_preview_json: (previewId) => alignmentPreviewMutation(previewId, 0, null),
    update_alignment_preview_json: (previewId) =>
      alignmentPreviewMutation(previewId, 1, '88'.repeat(32)),
    remove_alignment_preview: () => false,
    upsert_section_json: () => JSON.stringify({ proxies: 0, generation: 0 }),
    remove_section: () => false,
    set_clip_volumes_json(): void {},
    world_generation: () => 0n,
    render: () => JSON.stringify({ status: 'skipped', reason: 'Suspended' }),
    begin_render_pick: () => Promise.resolve('{}'),
    finish_render_pick: () => JSON.stringify({ generation: 0, stale: false, candidates: [] }),
    capabilities_json: () =>
      JSON.stringify({
        adapterName: 'test',
        deviceKind: 'integratedGpu',
        backend: 'webGl2',
        driver: '',
        driverInfo: '',
        features: [],
        maxTextureDimension2d: 8_192,
        maxStorageBufferBindingSize: 1,
        maxBufferSize: 1,
        maxSampleCount: 1,
      }),
    hardware_policy_json: () => JSON.stringify(testHardwarePolicy()),
    runtime_quality_json: () => JSON.stringify({ renderScale: 1, detailScale: 0.75 }),
    observe_frame_telemetry_json: () =>
      JSON.stringify({
        adjustment: 'unchanged',
        quality: { renderScale: 1, detailScale: 0.75 },
      }),
    frame_telemetry_json: () => 'null',
    gpu_frame_timing_json: () =>
      JSON.stringify({
        supported: false,
        pendingReadbacks: 0,
        latestGpuMs: null,
        completedSamples: 0,
        saturatedFrames: 0,
        failedReadbacks: 0,
      }),
    begin_hardware_calibration: () => JSON.stringify(testCalibrationProgress(false)),
    step_hardware_calibration: () => JSON.stringify(testCalibrationProgress(true)),
    width: () => canvas.width,
    height: () => canvas.height,
    free(): void {},
  };
}

function zeroCost(): Record<string, number> {
  return {
    cpuCompressedBytes: 0,
    cpuDecodedBytes: 0,
    gpuBufferBytes: 0,
    gpuTextureBytes: 0,
    stagingBytes: 0,
    points: 0,
    triangles: 0,
    splats: 0,
    drawCalls: 0,
  };
}

function zeroResidencyStages(): Record<string, number> {
  return {
    unloaded: 0,
    fetching: 0,
    queuedDecode: 0,
    decoding: 0,
    queuedUpload: 0,
    uploading: 0,
    resident: 0,
    failed: 0,
  };
}

function alignmentPreviewMutation(
  previewId: string,
  generation: number,
  parentIdentity: string | null,
): string {
  return JSON.stringify({
    previewId,
    generation,
    alignmentVersion: '77'.repeat(32),
    horizontalPathVersion: '66'.repeat(32),
    partitionCount: 1,
    parentIdentity,
    identity: generation === 0 ? '88'.repeat(32) : '99'.repeat(32),
    changedPartitions: [
      {
        index: 0,
        stationRange: { start: 1_000, end: 1_030 },
        identity: 'aa'.repeat(32),
        roadBody: [],
        slopes: [],
      },
    ],
    changedProxyIds: [`${previewId}/partition/0/road/carriageway`],
    workload: { partitions: 1, stationSamples: 4 },
  });
}

function testHardwarePolicy(): Record<string, unknown> {
  return {
    deploymentProfile: 'desktop',
    resources: zeroCost(),
    frame: {
      targetFrameMs: 16.7,
      traversalMs: 1,
      decodeMs: 3,
      uploadBytes: 1_048_576,
      newRequests: 4,
    },
    maximumTraversedNodes: 100_000,
    interaction: {
      frame: {
        targetFrameMs: 16.7,
        traversalMs: 0.5,
        decodeMs: 1.5,
        uploadBytes: 524_288,
        newRequests: 1,
      },
      maximumTraversedNodes: 6_250,
    },
    workload: { points: 1, triangles: 1, splats: 1 },
    maximumRenderScale: 1,
    maximumDetailScale: 1,
    maximumMsaaSamples: 1,
    decoderWorkers: 1,
    contentRequests: 4,
    transparency: 'weightedBlended',
  };
}

function testCalibrationProgress(complete: boolean): Record<string, unknown> {
  return {
    completedSamples: complete ? 12 : 0,
    totalSamples: 12,
    inFlight: !complete,
    submitted: !complete,
    calibration: complete
      ? {
          uploadGibPerSecond: 4,
          pointMillionsPerSecond: 800,
          triangleMillionsPerSecond: 400,
          splatMillionsPerSecond: 200,
        }
      : null,
  };
}
