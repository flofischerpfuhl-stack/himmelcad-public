import { resolvePaperMm, validatePaperConfig, type PaperConfig } from './paper.js';

export const PLAN_DOCUMENT_KIND = 'planDocument' as const;
export const PLAN_DOCUMENT_FORMAT_VERSION = 2 as const;
export const EXCALIDRAW_SCENE_ENGINE = 'excalidraw-himmelcad-v0.18' as const;

export type PlanId = string;
export type PlanSheetId = string;
export type PlanElement = Readonly<Record<string, unknown>>;

export interface PlanExcalidrawScene {
  engine: typeof EXCALIDRAW_SCENE_ENGINE;
  elements: readonly PlanElement[];
  appState: Readonly<Record<string, unknown>>;
  files: Readonly<Record<string, unknown>>;
  revision: number;
  sceneHash: string;
}

export type PlotProfile = 'color' | 'grayscale' | 'monochrome';
export type ViewRefreshState = 'clean' | 'stale' | 'refreshing' | 'error';

export interface ViewLayerFilter {
  mode: 'include' | 'exclude';
  layerIds: readonly string[];
}

export interface FrozenViewEntity {
  entityId: string;
  revision: number;
  versionHash: string;
}

export interface PlanViewDescriptor {
  schemaVersion: 1;
  id: string;
  mode: 'topOrtho' | 'camera3d';
  worldCenter: readonly [number, number, number];
  rotationDeg: number;
  scale: number;
  layerFilter: ViewLayerFilter;
  sourceEntities: readonly FrozenViewEntity[];
  styleRevisionHash: string;
  viewRevisionHash: string;
  refreshState: ViewRefreshState;
  snapshot?: {
    rasterUnderlayHash?: string;
    vectorSceneHash?: string;
    generatedAtRevision: number;
  };
  lastError?: string;
}

export interface PlanViewport {
  id: string;
  elementId: string;
  rectMm: { x: number; y: number; width: number; height: number };
  descriptor: PlanViewDescriptor;
}

export type PlanTemplateKind =
  | 'frame'
  | 'titleBlock'
  | 'stamp'
  | 'northArrow'
  | 'scaleBar'
  | 'legend'
  | 'logo'
  | 'textGroup';

export interface PlanTemplateFieldBinding {
  elementId: string;
  property: 'text';
  expression: string;
  fallback: string;
}

export interface PlanTemplateAnchor {
  id: string;
  xMm: number;
  yMm: number;
}

export interface PlanTemplateDefinition {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  kind: PlanTemplateKind;
  scope: 'project' | 'user';
  elements: readonly PlanElement[];
  widthMm: number;
  heightMm: number;
  anchors: readonly PlanTemplateAnchor[];
  bindings: readonly PlanTemplateFieldBinding[];
  contentHash: string;
}

export interface PlanTemplateInstance {
  id: string;
  templateId: string;
  templateRevision: number;
  templateContentHash: string;
  elementIds: readonly string[];
  fieldValues: Readonly<Record<string, string>>;
}

export interface PlanSheet {
  id: PlanSheetId;
  name: string;
  paper: PaperConfig;
  scene: PlanExcalidrawScene;
  viewports: readonly PlanViewport[];
  templateInstances: readonly PlanTemplateInstance[];
  hiddenLayerIds: readonly string[];
}

export interface PlanDocument {
  formatVersion: typeof PLAN_DOCUMENT_FORMAT_VERSION;
  kind: typeof PLAN_DOCUMENT_KIND;
  id: PlanId;
  revision: number;
  name: string;
  projectId?: string;
  author: string;
  plotProfile: PlotProfile;
  sheets: readonly PlanSheet[];
  projectLibrary: readonly PlanTemplateDefinition[];
  contentHash: string;
}

interface LegacyPlanDocumentV1 {
  formatVersion: 1;
  kind: 'planDocument';
  id: string;
  name: string;
  projectId?: string;
  plotProfileId?: string;
  sheets: readonly Record<string, unknown>[];
}

export interface PlanValidationIssue {
  path: string;
  message: string;
}

export function emptyExcalidrawScene(): PlanExcalidrawScene {
  const scene = {
    engine: EXCALIDRAW_SCENE_ENGINE,
    elements: [],
    appState: {},
    files: {},
    revision: 1,
    sceneHash: '',
  } satisfies PlanExcalidrawScene;
  return { ...scene, sceneHash: planContentHash(scene, ['sceneHash']) };
}

export function createPlanSheet(id: string, name = 'Sheet 1'): PlanSheet {
  return {
    id,
    name,
    paper: { sizeId: 'a3', orientation: 'landscape', marginMm: 10 },
    scene: emptyExcalidrawScene(),
    viewports: [],
    templateInstances: [],
    hiddenLayerIds: [],
  };
}

export function createPlanDocument(input: {
  id: string;
  name: string;
  author?: string;
  projectId?: string;
  firstSheetId?: string;
}): PlanDocument {
  const base: PlanDocument = {
    formatVersion: PLAN_DOCUMENT_FORMAT_VERSION,
    kind: PLAN_DOCUMENT_KIND,
    id: input.id,
    revision: 1,
    name: input.name,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    author: input.author ?? '',
    plotProfile: 'color',
    sheets: [createPlanSheet(input.firstSheetId ?? `${input.id}:sheet:1`)],
    projectLibrary: [],
    contentHash: '',
  };
  return rehashPlanDocument(base);
}

export function validatePlanDocument(document: PlanDocument): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (
    document.kind !== PLAN_DOCUMENT_KIND ||
    document.formatVersion !== PLAN_DOCUMENT_FORMAT_VERSION
  ) {
    issues.push({ path: '', message: 'Unsupported plan document schema.' });
  }
  if (!validId(document.id) || !document.name.trim() || document.revision < 1) {
    issues.push({ path: '', message: 'Plan identity, revision and name are required.' });
  }
  if (document.sheets.length === 0) {
    issues.push({ path: 'sheets', message: 'A plan needs at least one sheet.' });
  }
  const sheetIds = new Set<string>();
  for (const [index, sheet] of document.sheets.entries()) {
    const path = `sheets[${index}]`;
    if (!validId(sheet.id) || sheetIds.has(sheet.id) || !sheet.name.trim()) {
      issues.push({ path, message: 'Sheet IDs must be unique and names must not be empty.' });
    }
    sheetIds.add(sheet.id);
    const paperIssue = validatePaperConfig(sheet.paper);
    if (paperIssue) issues.push({ path: `${path}.paper`, message: paperIssue });
    if (sheet.scene.engine !== EXCALIDRAW_SCENE_ENGINE || sheet.scene.revision < 1) {
      issues.push({ path: `${path}.scene`, message: 'Invalid Excalidraw scene wrapper.' });
    }
    const viewportIds = new Set<string>();
    for (const viewport of sheet.viewports) {
      if (!validId(viewport.id) || viewportIds.has(viewport.id)) {
        issues.push({ path: `${path}.viewports`, message: 'Viewport IDs must be unique.' });
      }
      viewportIds.add(viewport.id);
      const { widthMm, heightMm } = resolvePaperMm(sheet.paper);
      const rect = viewport.rectMm;
      if (
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.width > widthMm ||
        rect.y + rect.height > heightMm
      ) {
        issues.push({
          path: `${path}.viewports.${viewport.id}`,
          message: 'Viewport is outside paper.',
        });
      }
      if (
        viewport.descriptor.scale <= 0 ||
        !Number.isFinite(viewport.descriptor.scale) ||
        !validHash(viewport.descriptor.styleRevisionHash) ||
        !validHash(viewport.descriptor.viewRevisionHash)
      ) {
        issues.push({
          path: `${path}.viewports.${viewport.id}`,
          message: 'Viewport pin is incomplete.',
        });
      }
    }
  }
  const expected = rehashPlanDocument({ ...document, contentHash: '' }).contentHash;
  if (document.contentHash !== expected) {
    issues.push({ path: 'contentHash', message: 'Plan content hash does not match.' });
  }
  return issues;
}

export function updatePlanSheet(
  document: PlanDocument,
  sheetId: string,
  update: (sheet: PlanSheet) => PlanSheet,
): PlanDocument {
  let found = false;
  const sheets = document.sheets.map((sheet) => {
    if (sheet.id !== sheetId) return sheet;
    found = true;
    return update(sheet);
  });
  if (!found) throw new Error(`Unknown sheet: ${sheetId}`);
  return revise(document, { sheets });
}

export function addPlanSheet(
  document: PlanDocument,
  sheet: PlanSheet,
  afterId?: string,
): PlanDocument {
  if (document.sheets.some((candidate) => candidate.id === sheet.id)) {
    throw new Error(`Duplicate sheet: ${sheet.id}`);
  }
  const sheets = [...document.sheets];
  const index = afterId
    ? sheets.findIndex((candidate) => candidate.id === afterId) + 1
    : sheets.length;
  sheets.splice(Math.max(0, index), 0, sheet);
  return revise(document, { sheets });
}

export function duplicatePlanSheet(
  document: PlanDocument,
  sheetId: string,
  newId: string,
): PlanDocument {
  const index = document.sheets.findIndex((sheet) => sheet.id === sheetId);
  if (index < 0) throw new Error(`Unknown sheet: ${sheetId}`);
  const source = document.sheets[index]!;
  const duplicate = clone(source);
  duplicate.id = newId;
  duplicate.name = `${source.name} copy`;
  return addPlanSheet(document, duplicate, sheetId);
}

export function removePlanSheet(document: PlanDocument, sheetId: string): PlanDocument {
  if (document.sheets.length === 1) throw new Error('A plan needs at least one sheet.');
  const sheets = document.sheets.filter((sheet) => sheet.id !== sheetId);
  if (sheets.length === document.sheets.length) throw new Error(`Unknown sheet: ${sheetId}`);
  return revise(document, { sheets });
}

export function renamePlanSheet(
  document: PlanDocument,
  sheetId: string,
  name: string,
): PlanDocument {
  if (!name.trim()) throw new Error('Sheet name is required.');
  return updatePlanSheet(document, sheetId, (sheet) => ({ ...sheet, name: name.trim() }));
}

export function updatePlanMetadata(
  document: PlanDocument,
  patch: Partial<Pick<PlanDocument, 'name' | 'author' | 'plotProfile'>>,
): PlanDocument {
  const name = patch.name === undefined ? document.name : patch.name.trim();
  if (!name) throw new Error('Plan name is required.');
  return revise(document, { ...patch, name });
}

export function replaceProjectPlanLibrary(
  document: PlanDocument,
  templates: readonly PlanTemplateDefinition[],
): PlanDocument {
  const templateIds = new Set<string>();
  for (const template of templates) {
    if (!validId(template.id) || templateIds.has(template.id)) {
      throw new Error('Project library template IDs must be unique.');
    }
    templateIds.add(template.id);
  }
  return revise(document, { projectLibrary: [...templates] });
}

export function movePlanSheet(
  document: PlanDocument,
  sheetId: string,
  direction: -1 | 1,
): PlanDocument {
  const sheets = [...document.sheets];
  const index = sheets.findIndex((sheet) => sheet.id === sheetId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sheets.length) return document;
  [sheets[index], sheets[target]] = [sheets[target]!, sheets[index]!];
  return revise(document, { sheets });
}

export function reorderPlanSheet(
  document: PlanDocument,
  sheetId: string,
  targetIndex: number,
): PlanDocument {
  const sheets = [...document.sheets];
  const index = sheets.findIndex((sheet) => sheet.id === sheetId);
  if (index < 0) throw new Error(`Unknown sheet: ${sheetId}`);
  const bounded = Math.max(0, Math.min(sheets.length - 1, targetIndex));
  if (bounded === index) return document;
  const [sheet] = sheets.splice(index, 1);
  sheets.splice(bounded, 0, sheet!);
  return revise(document, { sheets });
}

export function replaceSheetScene(
  document: PlanDocument,
  sheetId: string,
  scene: Omit<PlanExcalidrawScene, 'engine' | 'revision' | 'sceneHash'>,
): PlanDocument {
  return updatePlanSheet(document, sheetId, (sheet) => {
    const nextScene = {
      ...scene,
      engine: EXCALIDRAW_SCENE_ENGINE,
      revision: sheet.scene.revision + 1,
      sceneHash: '',
    } satisfies PlanExcalidrawScene;
    return {
      ...sheet,
      scene: { ...nextScene, sceneHash: planContentHash(nextScene, ['sceneHash']) },
    };
  });
}

export function serializePlanDocument(document: PlanDocument): string {
  const normalized = rehashPlanDocument(document);
  const issues = validatePlanDocument(normalized);
  if (issues.length > 0)
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  return stableStringify(normalized, 2);
}

export function parsePlanDocument(serialized: string): PlanDocument {
  const value = JSON.parse(serialized) as unknown;
  const migrated = migratePlanDocument(value);
  const issues = validatePlanDocument(migrated);
  if (issues.length > 0)
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  return migrated;
}

export function migratePlanDocument(value: unknown): PlanDocument {
  if (!isRecord(value) || value.kind !== PLAN_DOCUMENT_KIND)
    throw new Error('Not a .hcplan document.');
  if (value.formatVersion === PLAN_DOCUMENT_FORMAT_VERSION)
    return clone(value) as unknown as PlanDocument;
  if (value.formatVersion !== 1) throw new Error('Unsupported .hcplan version.');
  const legacy = value as unknown as LegacyPlanDocumentV1;
  const sheets = legacy.sheets.map((raw, index) => migrateSheetV1(raw, index, legacy.id));
  const base: PlanDocument = {
    formatVersion: PLAN_DOCUMENT_FORMAT_VERSION,
    kind: PLAN_DOCUMENT_KIND,
    id: legacy.id,
    revision: 1,
    name: legacy.name,
    ...(legacy.projectId ? { projectId: legacy.projectId } : {}),
    author: '',
    plotProfile:
      legacy.plotProfileId === 'monochrome' || legacy.plotProfileId === 'grayscale'
        ? legacy.plotProfileId
        : 'color',
    sheets: sheets.length > 0 ? sheets : [createPlanSheet(`${legacy.id}:sheet:1`)],
    projectLibrary: [],
    contentHash: '',
  };
  return rehashPlanDocument(base);
}

export function rehashPlanDocument(document: PlanDocument): PlanDocument {
  const normalized = { ...document, contentHash: '' };
  return { ...normalized, contentHash: planContentHash(normalized, ['contentHash']) };
}

export function planContentHash(value: unknown, excludedKeys: readonly string[] = []): string {
  const text = stableStringify(value, 0, new Set(excludedKeys));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function stableStringify(
  value: unknown,
  indentation = 0,
  excludedKeys: ReadonlySet<string> = new Set(),
): string {
  return JSON.stringify(sortJson(value, excludedKeys), null, indentation);
}

function revise(document: PlanDocument, patch: Partial<PlanDocument>): PlanDocument {
  return rehashPlanDocument({ ...document, ...patch, revision: document.revision + 1 });
}

function migrateSheetV1(raw: Record<string, unknown>, index: number, planId: string): PlanSheet {
  const id = typeof raw.id === 'string' ? raw.id : `${planId}:sheet:${index + 1}`;
  const paper = isRecord(raw.paper)
    ? {
        sizeId: typeof raw.paper.size === 'string' ? raw.paper.size.toLowerCase() : 'a3',
        orientation:
          raw.paper.orientation === 'portrait' ? ('portrait' as const) : ('landscape' as const),
        marginMm: typeof raw.paper.marginMm === 'number' ? raw.paper.marginMm : 10,
      }
    : createPlanSheet(id).paper;
  const sceneData =
    isRecord(raw.compositionScene) && isRecord(raw.compositionScene.data)
      ? raw.compositionScene.data
      : {};
  const elements = Array.isArray(sceneData.elements) ? (sceneData.elements as PlanElement[]) : [];
  const scene = emptyExcalidrawScene();
  const migratedScene = {
    ...scene,
    elements,
    appState: isRecord(sceneData.appState) ? sceneData.appState : {},
    files: isRecord(sceneData.files) ? sceneData.files : {},
  };
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : `Sheet ${index + 1}`,
    paper,
    scene: { ...migratedScene, sceneHash: planContentHash(migratedScene, ['sceneHash']) },
    viewports: [],
    templateInstances: [],
    hiddenLayerIds: [],
  };
}

function sortJson(value: unknown, excluded: ReadonlySet<string>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => sortJson(item, excluded));
  if (!isRecord(value)) throw new Error('Plan data must be JSON serializable.');
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !excluded.has(key) && value[key] !== undefined)
      .sort()
      .map((key) => [key, sortJson(value[key], excluded)]),
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: string): boolean {
  return value.trim().length > 0 && value.length <= 200 && !/[\\/\0]/.test(value);
}

function validHash(value: string): boolean {
  return /^(?:[a-f0-9]{64}|fnv1a64:[a-f0-9]{16}|mock:[a-z0-9._-]+)$/i.test(value);
}
