import {
  planContentHash,
  type PlanElement,
  type PlanViewDescriptor,
  type PlanViewport,
} from './document.js';
import { PLAN_SCENE_UNITS_PER_MM } from './paper.js';

export interface PlanViewportCapture {
  descriptor: PlanViewDescriptor;
  vectorElements: readonly PlanElement[];
  rasterDataUrl?: string;
}

/** Stable adapter boundary for the later Builder model/view implementation. */
export interface PlanModelViewAdapter {
  capture(descriptor: PlanViewDescriptor): Promise<PlanViewportCapture>;
}

export function createMockViewDescriptor(id: string, scale = 500): PlanViewDescriptor {
  const body = {
    schemaVersion: 1 as const,
    id,
    mode: 'topOrtho' as const,
    worldCenter: [0, 0, 0] as const,
    rotationDeg: 0,
    scale,
    layerFilter: { mode: 'exclude' as const, layerIds: [] },
    sourceEntities: [],
    styleRevisionHash: 'mock:style-v1',
    viewRevisionHash: '',
    refreshState: 'clean' as const,
  };
  return { ...body, viewRevisionHash: planContentHash(body, ['viewRevisionHash']) };
}

export function createViewportPlaceholder(
  id: string,
  rectMm: { x: number; y: number; width: number; height: number },
  descriptor = createMockViewDescriptor(`${id}:view`),
): { viewport: PlanViewport; elements: readonly PlanElement[] } {
  const x = rectMm.x * PLAN_SCENE_UNITS_PER_MM;
  const y = rectMm.y * PLAN_SCENE_UNITS_PER_MM;
  const width = rectMm.width * PLAN_SCENE_UNITS_PER_MM;
  const height = rectMm.height * PLAN_SCENE_UNITS_PER_MM;
  const elementId = `${id}:placeholder`;
  return {
    viewport: { id, elementId, rectMm, descriptor },
    elements: [
      {
        id: elementId,
        type: 'rectangle',
        x,
        y,
        width,
        height,
        angle: 0,
        strokeColor: '#60758a',
        backgroundColor: '#eef3f7',
        fillStyle: 'hachure',
        strokeWidth: 2,
        strokeStyle: 'dashed',
        roughness: 0,
        opacity: 100,
        groupIds: [`${id}:group`],
        frameId: null,
        roundness: null,
        seed: 101,
        version: 1,
        versionNonce: 102,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
      {
        id: `${id}:label`,
        type: 'text',
        x: x + 12,
        y: y + 12,
        width: 260,
        height: 48,
        angle: 0,
        strokeColor: '#263746',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: [`${id}:group`],
        frameId: null,
        roundness: null,
        seed: 103,
        version: 1,
        versionNonce: 104,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        text: `MODEL VIEWPORT · 1:${descriptor.scale}\nMock adapter · refresh explicitly`,
        originalText: `MODEL VIEWPORT · 1:${descriptor.scale}\nMock adapter · refresh explicitly`,
        fontSize: 18,
        fontFamily: 2,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
      },
    ],
  };
}

export class MockPlanModelViewAdapter implements PlanModelViewAdapter {
  async capture(descriptor: PlanViewDescriptor): Promise<PlanViewportCapture> {
    const refreshed = {
      ...descriptor,
      refreshState: 'clean' as const,
      viewRevisionHash: planContentHash({ ...descriptor, refreshState: 'clean' }),
      snapshot: {
        vectorSceneHash: planContentHash(descriptor),
        generatedAtRevision: 1,
      },
    };
    return { descriptor: refreshed, vectorElements: [] };
  }
}

export function markViewportStale(descriptor: PlanViewDescriptor): PlanViewDescriptor {
  const stale = { ...descriptor, refreshState: 'stale' as const, viewRevisionHash: '' };
  return { ...stale, viewRevisionHash: planContentHash(stale, ['viewRevisionHash']) };
}
