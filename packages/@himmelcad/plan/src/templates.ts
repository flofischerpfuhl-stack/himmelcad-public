import {
  planContentHash,
  type PlanElement,
  type PlanTemplateDefinition,
  type PlanTemplateInstance,
  type PlanTemplateKind,
} from './document.js';
import { PLAN_SCENE_UNITS_PER_MM } from './paper.js';

export interface TemplateBindingContext {
  project: Readonly<Record<string, string>>;
  plan: Readonly<Record<string, string>>;
  sheet: Readonly<Record<string, string>>;
  user: Readonly<Record<string, string>>;
  viewport: Readonly<Record<string, string>>;
}

export interface InstantiatedPlanTemplate {
  elements: readonly PlanElement[];
  instance: PlanTemplateInstance;
}

export function createPlanTemplate(
  input: Omit<PlanTemplateDefinition, 'schemaVersion' | 'contentHash'>,
): PlanTemplateDefinition {
  const template = { ...input, schemaVersion: 1 as const, contentHash: '' };
  return { ...template, contentHash: planContentHash(template, ['contentHash']) };
}

export function instantiatePlanTemplate(
  template: PlanTemplateDefinition,
  instanceId: string,
  placementMm: { x: number; y: number },
  context: TemplateBindingContext,
): InstantiatedPlanTemplate {
  const idMap = new Map<string, string>();
  const elements = template.elements.map((element, index) => {
    const originalId = typeof element.id === 'string' ? element.id : `element-${index}`;
    idMap.set(originalId, `${instanceId}:${index + 1}`);
    return element;
  });
  const bindings = new Map(template.bindings.map((binding) => [binding.elementId, binding]));
  const translated = elements.map((element, index) => {
    const originalId = typeof element.id === 'string' ? element.id : `element-${index}`;
    const binding = bindings.get(originalId);
    const groupIds = Array.isArray(element.groupIds)
      ? element.groupIds.map((id) => `${instanceId}:group:${String(id)}`)
      : [`${instanceId}:group`];
    return {
      ...element,
      id: idMap.get(originalId)!,
      groupIds,
      x: numberValue(element.x) + placementMm.x * PLAN_SCENE_UNITS_PER_MM,
      y: numberValue(element.y) + placementMm.y * PLAN_SCENE_UNITS_PER_MM,
      ...(binding
        ? {
            text: resolveTemplateExpression(binding.expression, context, binding.fallback),
            originalText: resolveTemplateExpression(binding.expression, context, binding.fallback),
          }
        : {}),
      version: 1,
      versionNonce: deterministicNonce(`${instanceId}:${index}`),
      updated: 1,
    } satisfies PlanElement;
  });
  return {
    elements: translated,
    instance: {
      id: instanceId,
      templateId: template.id,
      templateRevision: template.revision,
      templateContentHash: template.contentHash,
      elementIds: translated.map((element) => String(element.id)),
      fieldValues: Object.fromEntries(
        template.bindings.map((binding) => [
          binding.expression,
          resolveTemplateExpression(binding.expression, context, binding.fallback),
        ]),
      ),
    },
  };
}

export function resolveTemplateExpression(
  expression: string,
  context: TemplateBindingContext,
  fallback = '',
): string {
  const path = expression.replace(/^\{\{|\}\}$/g, '').trim();
  const [scope, ...parts] = path.split('.');
  if (!scope || parts.length === 0) return fallback;
  const table = context[scope as keyof TemplateBindingContext];
  return table?.[parts.join('.')] ?? fallback;
}

export function createBuiltinPlanTemplates(): readonly PlanTemplateDefinition[] {
  return [
    frameTemplate(),
    titleBlockTemplate(),
    northArrowTemplate(),
    scaleBarTemplate(),
    legendTemplate(),
    logoTemplate(),
    textGroupTemplate(),
    draftStampTemplate(),
  ];
}

function frameTemplate(): PlanTemplateDefinition {
  return createPlanTemplate({
    id: 'builtin.frame.iso',
    revision: 1,
    name: 'ISO drawing frame',
    kind: 'frame',
    scope: 'project',
    widthMm: 400,
    heightMm: 277,
    elements: [rect('frame', 0, 0, 1_600, 1_108, 2)],
    anchors: [
      { id: 'corner-tl', xMm: 0, yMm: 0 },
      { id: 'corner-tr', xMm: 400, yMm: 0 },
      { id: 'corner-bl', xMm: 0, yMm: 277 },
      { id: 'corner-br', xMm: 400, yMm: 277 },
      { id: 'title-block-right', xMm: 400, yMm: 277 },
    ],
    bindings: [],
  });
}

function titleBlockTemplate(): PlanTemplateDefinition {
  const group = 'title-block';
  return createPlanTemplate({
    id: 'builtin.title-block.standard',
    revision: 1,
    name: 'Project title block',
    kind: 'titleBlock',
    scope: 'project',
    widthMm: 150,
    heightMm: 42,
    elements: [
      rect('tb-box', 0, 0, 600, 168, 1, group),
      line('tb-row-1', 0, 64, 600, 0, group),
      line('tb-row-2', 0, 112, 600, 0, group),
      text('tb-project', 12, 12, 'PROJECT', 22, group),
      text('tb-plan', 12, 75, 'PLAN', 18, group),
      text('tb-sheet', 430, 75, 'SHEET', 18, group),
      text('tb-author', 12, 123, 'AUTHOR', 16, group),
      text('tb-scale', 430, 123, 'SCALE', 16, group),
    ],
    anchors: [{ id: 'frame-br', xMm: 150, yMm: 42 }],
    bindings: [
      bind('tb-project', '{{project.name}}', 'Untitled project'),
      bind('tb-plan', '{{plan.name}}', 'Untitled plan'),
      bind('tb-sheet', '{{sheet.name}}', 'Sheet'),
      bind('tb-author', '{{user.name}}', 'Author'),
      bind('tb-scale', '{{viewport.scale}}', '1:500'),
    ],
  });
}

function northArrowTemplate(): PlanTemplateDefinition {
  const group = 'north-arrow';
  return createPlanTemplate({
    id: 'builtin.north-arrow.simple',
    revision: 1,
    name: 'North arrow',
    kind: 'northArrow',
    scope: 'project',
    widthMm: 18,
    heightMm: 32,
    elements: [
      line('north-shaft', 36, 112, 0, -88, group),
      line('north-left', 36, 24, -18, 30, group),
      line('north-right', 36, 24, 18, 30, group),
      text('north-label', 25, 0, 'N', 24, group),
    ],
    anchors: [{ id: 'center', xMm: 9, yMm: 16 }],
    bindings: [],
  });
}

function scaleBarTemplate(): PlanTemplateDefinition {
  const group = 'scale-bar';
  return createPlanTemplate({
    id: 'builtin.scale-bar.metric',
    revision: 1,
    name: 'Metric scale bar',
    kind: 'scaleBar',
    scope: 'project',
    widthMm: 60,
    heightMm: 12,
    elements: [
      rect('scale-a', 0, 24, 80, 16, 1, group, '#1b1b1f'),
      rect('scale-b', 80, 24, 80, 16, 1, group),
      rect('scale-c', 160, 24, 80, 16, 1, group, '#1b1b1f'),
      text('scale-label', 0, 0, '1:500', 16, group),
    ],
    anchors: [{ id: 'left', xMm: 0, yMm: 6 }],
    bindings: [bind('scale-label', '{{viewport.scale}}', '1:500')],
  });
}

function legendTemplate(): PlanTemplateDefinition {
  return simpleTextTemplate('builtin.legend', 'Legend', 'legend', 'LEGEND\nVisible model layers');
}

function logoTemplate(): PlanTemplateDefinition {
  return simpleTextTemplate('builtin.logo', 'Company logo', 'logo', 'YOUR LOGO');
}

function textGroupTemplate(): PlanTemplateDefinition {
  return simpleTextTemplate('builtin.text.notes', 'Notes group', 'textGroup', 'NOTES\n• Add note');
}

function draftStampTemplate(): PlanTemplateDefinition {
  return simpleTextTemplate('builtin.stamp.draft', 'Draft stamp', 'stamp', 'DRAFT');
}

function simpleTextTemplate(
  id: string,
  name: string,
  kind: PlanTemplateKind,
  label: string,
): PlanTemplateDefinition {
  return createPlanTemplate({
    id,
    revision: 1,
    name,
    kind,
    scope: 'project',
    widthMm: 55,
    heightMm: 22,
    elements: [rect(`${id}:box`, 0, 0, 220, 88, 1, id), text(`${id}:text`, 10, 10, label, 18, id)],
    anchors: [{ id: 'center', xMm: 27.5, yMm: 11 }],
    bindings: [],
  });
}

function base(
  id: string,
  type: string,
  x: number,
  y: number,
  groupId?: string,
): Record<string, unknown> {
  return {
    id,
    type,
    x,
    y,
    angle: 0,
    strokeColor: '#1b1b1f',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: groupId ? [groupId] : [],
    frameId: null,
    index: null,
    roundness: null,
    seed: deterministicNonce(id),
    version: 1,
    versionNonce: deterministicNonce(`${id}:version`),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function rect(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  strokeWidth: number,
  groupId?: string,
  backgroundColor = 'transparent',
): PlanElement {
  return { ...base(id, 'rectangle', x, y, groupId), width, height, strokeWidth, backgroundColor };
}

function line(
  id: string,
  x: number,
  y: number,
  dx: number,
  dy: number,
  groupId?: string,
): PlanElement {
  return {
    ...base(id, 'line', x, y, groupId),
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
    startBinding: null,
    endBinding: null,
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: null,
  };
}

function text(
  id: string,
  x: number,
  y: number,
  value: string,
  fontSize: number,
  groupId?: string,
): PlanElement {
  return {
    ...base(id, 'text', x, y, groupId),
    width: Math.max(40, value.length * fontSize * 0.55),
    height: fontSize * Math.max(1, value.split('\n').length) * 1.25,
    text: value,
    originalText: value,
    fontSize,
    fontFamily: 2,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

function bind(elementId: string, expression: string, fallback: string) {
  return { elementId, property: 'text' as const, expression, fallback };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function deterministicNonce(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
