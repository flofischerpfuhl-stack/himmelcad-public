import { ContractValidationError } from './errors.js';
import type {
  AppProtocolMethods,
  NegotiatedSession,
  RpcMethodDefinition,
  RpcRequestOptions,
  RpcTransport,
} from './protocol.js';
import { requireCapability } from './protocol.js';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type WorldProjection =
  | {
      readonly kind: 'perspective';
      readonly verticalFieldOfViewRadians: number;
      readonly near: number;
      readonly far: number;
    }
  | {
      readonly kind: 'orthographic';
      readonly verticalSpan: number;
      readonly near: number;
      readonly far: number;
    };

export interface WorldCamera {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly projection: WorldProjection;
}

export type NavigationMode = '3d' | '2d' | '2.5d';

export type ClipScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'entities'; readonly entityIds: readonly string[] };

export type ScopedClip =
  | {
      readonly id: string;
      readonly enabled: boolean;
      readonly scope: ClipScope;
      readonly primitive: {
        readonly kind: 'plane';
        readonly normal: Vec3;
        readonly constant: number;
        readonly keep: 'positive' | 'negative';
      };
    }
  | {
      readonly id: string;
      readonly enabled: boolean;
      readonly scope: ClipScope;
      readonly primitive: {
        readonly kind: 'box';
        readonly center: Vec3;
        readonly halfExtents: Vec3;
        readonly orientation: Quaternion;
        readonly keep: 'inside' | 'outside';
      };
    };

export interface ViewPresentation {
  readonly background: 'theme' | 'black' | 'white' | 'transparent';
  readonly renderStyle: 'source' | 'monochrome' | 'xray';
  readonly showGrid: boolean;
  readonly showAxes: boolean;
  readonly showSelectionOutline: boolean;
}

export interface ViewStateV1 {
  readonly schema: 'himmelcad.view-state';
  readonly version: 1;
  readonly camera: WorldCamera;
  readonly navigationMode: NavigationMode;
  readonly hiddenEntityIds: readonly string[];
  readonly selectedEntityIds: readonly string[];
  readonly scopedClips: readonly ScopedClip[];
  readonly presentation: ViewPresentation;
}

export interface ViewClipRefV2 {
  readonly entityId: string;
  readonly expectedRevision: number;
  readonly active: boolean;
  readonly locked: boolean;
}

export type ViewColorModeOverrideV2 =
  | { readonly kind: 'follow' }
  | { readonly kind: 'mode'; readonly mode: string; readonly params: unknown };

export interface ViewStateV2 {
  readonly schema: 'himmelcad.view-state';
  readonly version: 2;
  readonly camera: WorldCamera;
  readonly navigationMode: NavigationMode;
  readonly hiddenEntityIds: readonly string[];
  readonly sessionHiddenEntityIds: readonly string[];
  readonly selectedEntityIds: readonly string[];
  readonly clipRefs: readonly ViewClipRefV2[];
  readonly presentation: Omit<ViewPresentation, 'background'> & {
    readonly background: Exclude<ViewPresentation['background'], 'transparent'>;
    readonly colorModeOverride: ViewColorModeOverrideV2;
    readonly pointSizeMultiplier: number;
  };
}

export interface ScreenshotRequestV1 {
  readonly schema: 'himmelcad.screenshot-request';
  readonly version: 1;
  readonly requestId: string;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly background: 'view' | 'transparent';
  readonly includeUi: boolean;
  readonly quality?: number;
}

export interface RgbaScreenshotSource {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
}

interface ScreenshotResultBaseV1 {
  readonly schema: 'himmelcad.screenshot-result';
  readonly version: 1;
  readonly requestId: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly width: number;
  readonly height: number;
}

export type ScreenshotResultV1 = ScreenshotResultBaseV1 &
  (
    | {
        readonly encoding: 'base64';
        readonly data: string;
      }
    | {
        readonly encoding: 'bulkLease';
        readonly lease: BulkLeaseDescriptor;
      }
  );

/** Read-only, time- and budget-bounded bytes owned by the desktop host. */
export interface BulkLeaseDescriptor {
  readonly leaseId: string;
  readonly accessToken: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly elementType:
    | 'bytes'
    | 'uint8'
    | 'int8'
    | 'uint16'
    | 'int16'
    | 'uint32'
    | 'int32'
    | 'uint64'
    | 'int64'
    | 'float32'
    | 'float64';
  readonly shape: readonly number[];
  readonly endianness: 'notApplicable' | 'little' | 'big';
  readonly byteLength: number;
  readonly expiresAt: string;
  readonly maxReadableRange: number;
  readonly remainingReadBudget: number;
  readonly readOnly: true;
  readonly sourceEntity?: {
    readonly id: string;
    readonly revision: number;
    readonly versionHash: string;
  };
}

export interface AppViewMethods extends AppProtocolMethods {
  readonly 'view.state.get': {
    readonly request: Record<string, never>;
    readonly response: unknown;
  };
  readonly 'view.state.set': {
    readonly request: ViewStateV1;
    readonly response: unknown;
  };
  readonly 'view.screenshot': {
    readonly request: ScreenshotRequestV1;
    readonly response: unknown;
  };
}

export interface ViewController {
  getState(options?: RpcRequestOptions): Promise<ViewStateV1>;
  setState(state: ViewStateV1, options?: RpcRequestOptions): Promise<ViewStateV1>;
  requestScreenshot(
    request: ScreenshotRequestV1,
    options?: RpcRequestOptions,
  ): Promise<ScreenshotResultV1>;
}

type ViewTransport = RpcTransport<
  AppViewMethods & { readonly [Key in keyof AppViewMethods]: RpcMethodDefinition }
>;

export class RpcViewController implements ViewController {
  constructor(
    private readonly transport: ViewTransport,
    private readonly session: NegotiatedSession,
  ) {}

  async getState(options?: RpcRequestOptions): Promise<ViewStateV1> {
    requireCapability(this.session, 'view.read');
    return parseViewState(await this.transport.request('view.state.get', {}, options));
  }

  async setState(state: ViewStateV1, options?: RpcRequestOptions): Promise<ViewStateV1> {
    requireCapability(this.session, 'view.write');
    const validated = parseViewState(state);
    return parseViewState(await this.transport.request('view.state.set', validated, options));
  }

  async requestScreenshot(
    request: ScreenshotRequestV1,
    options?: RpcRequestOptions,
  ): Promise<ScreenshotResultV1> {
    requireCapability(this.session, 'view.screenshot');
    validateScreenshotRequest(request);
    const result = parseScreenshotResult(
      await this.transport.request('view.screenshot', request, options),
    );
    const expectedWidth = Math.round(request.width * request.pixelRatio);
    const expectedHeight = Math.round(request.height * request.pixelRatio);
    if (
      result.requestId !== request.requestId ||
      result.mimeType !== mimeTypeFor(request.format) ||
      result.width !== expectedWidth ||
      result.height !== expectedHeight
    ) {
      throw new ContractValidationError('does not match the screenshot request', 'result');
    }
    return result;
  }
}

export function serializeViewState(state: ViewStateV1): string {
  return JSON.stringify(parseViewState(state));
}

export function parseViewState(input: unknown): ViewStateV1 {
  const value: unknown = typeof input === 'string' ? parseJson(input, 'viewState') : input;
  const root = record(value, 'viewState');
  literal(root.schema, 'himmelcad.view-state', 'viewState.schema');
  literal(root.version, 1, 'viewState.version');
  validateWorldCamera(root.camera, 'viewState.camera');
  oneOf(root.navigationMode, ['3d', '2d', '2.5d'], 'viewState.navigationMode');
  stringArray(root.hiddenEntityIds, 'viewState.hiddenEntityIds');
  stringArray(root.selectedEntityIds, 'viewState.selectedEntityIds');
  const clips = array(root.scopedClips, 'viewState.scopedClips');
  const clipIds = new Set<string>();
  for (const [index, clip] of clips.entries()) {
    const id = validateScopedClip(clip, `viewState.scopedClips[${index}]`);
    if (clipIds.has(id)) invalid('must be unique', `viewState.scopedClips[${index}].id`);
    clipIds.add(id);
  }
  validatePresentation(root.presentation, 'viewState.presentation');
  return value as ViewStateV1;
}

/** Parses the Plan-free Release 0.5 ViewState v2 profile. */
export function parseViewStateV2(input: unknown): ViewStateV2 {
  const value: unknown = typeof input === 'string' ? parseJson(input, 'viewState') : input;
  const root = record(value, 'viewState');
  literal(root.schema, 'himmelcad.view-state', 'viewState.schema');
  literal(root.version, 2, 'viewState.version');
  validateWorldCamera(root.camera, 'viewState.camera');
  oneOf(root.navigationMode, ['3d', '2d', '2.5d'], 'viewState.navigationMode');
  stringArray(root.hiddenEntityIds, 'viewState.hiddenEntityIds');
  stringArray(root.sessionHiddenEntityIds, 'viewState.sessionHiddenEntityIds');
  stringArray(root.selectedEntityIds, 'viewState.selectedEntityIds');
  const clipRefs = array(root.clipRefs, 'viewState.clipRefs');
  const ids = new Set<string>();
  for (const [index, candidate] of clipRefs.entries()) {
    const path = `viewState.clipRefs[${index}]`;
    const clip = record(candidate, path);
    const id = nonEmptyString(clip.entityId, `${path}.entityId`);
    if (ids.has(id)) invalid('must be unique', `${path}.entityId`);
    ids.add(id);
    integerInRange(clip.expectedRevision, 0, Number.MAX_SAFE_INTEGER, `${path}.expectedRevision`);
    boolean(clip.active, `${path}.active`);
    boolean(clip.locked, `${path}.locked`);
  }
  const presentation = record(root.presentation, 'viewState.presentation');
  oneOf(presentation.background, ['theme', 'black', 'white'], 'viewState.presentation.background');
  oneOf(presentation.renderStyle, ['source', 'monochrome', 'xray'], 'viewState.presentation.renderStyle');
  boolean(presentation.showGrid, 'viewState.presentation.showGrid');
  boolean(presentation.showAxes, 'viewState.presentation.showAxes');
  boolean(presentation.showSelectionOutline, 'viewState.presentation.showSelectionOutline');
  const override = record(presentation.colorModeOverride, 'viewState.presentation.colorModeOverride');
  const overrideKind = oneOf(override.kind, ['follow', 'mode'], 'viewState.presentation.colorModeOverride.kind');
  if (overrideKind === 'mode') nonEmptyString(override.mode, 'viewState.presentation.colorModeOverride.mode');
  const multiplier = finite(presentation.pointSizeMultiplier, 'viewState.presentation.pointSizeMultiplier');
  if (multiplier <= 0) invalid('must be positive', 'viewState.presentation.pointSizeMultiplier');
  for (const forbidden of ['scopedClips', 'pinnedViewport', 'planFilters', 'updatePolicy', 'capturedPlanRevision']) {
    if (root[forbidden] !== undefined) invalid('is not admitted in the Release 0.5 profile', `viewState.${forbidden}`);
  }
  return value as ViewStateV2;
}

export function validateScreenshotRequest(request: ScreenshotRequestV1): void {
  const root = record(request, 'request');
  literal(root.schema, 'himmelcad.screenshot-request', 'request.schema');
  literal(root.version, 1, 'request.version');
  nonEmptyString(root.requestId, 'request.requestId');
  const format = oneOf(root.format, ['png', 'jpeg', 'webp'], 'request.format');
  const width = integerInRange(root.width, 1, 16_384, 'request.width');
  const height = integerInRange(root.height, 1, 16_384, 'request.height');
  const pixelRatio = finite(root.pixelRatio, 'request.pixelRatio');
  if (pixelRatio < 0.25 || pixelRatio > 4)
    invalid('must be from 0.25 through 4', 'request.pixelRatio');
  if (width * height * pixelRatio * pixelRatio > 100_000_000) {
    invalid('resolved image exceeds 100 million pixels', 'request');
  }
  const background = oneOf(root.background, ['view', 'transparent'], 'request.background');
  boolean(root.includeUi, 'request.includeUi');
  if (background === 'transparent' && format === 'jpeg') {
    invalid('JPEG cannot preserve a transparent background', 'request.background');
  }
  if (root.quality !== undefined) {
    const quality = finite(root.quality, 'request.quality');
    if (format === 'png') invalid('is not supported for PNG', 'request.quality');
    if (quality < 0 || quality > 1) invalid('must be from 0 through 1', 'request.quality');
  }
}

/** Encodes a renderer-owned, top-left-origin RGBA8 capture without sampling its canvas. */
export async function encodeRgbaScreenshot(
  request: ScreenshotRequestV1,
  source: RgbaScreenshotSource,
): Promise<ScreenshotResultV1> {
  validateScreenshotRequest(request);
  const width = Math.round(request.width * request.pixelRatio);
  const height = Math.round(request.height * request.pixelRatio);
  if (
    source.width !== width ||
    source.height !== height ||
    source.rgba8.byteLength !== width * height * 4
  ) {
    throw new ContractValidationError('does not match the requested dimensions', 'capture');
  }
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A 2D canvas encoder is unavailable.');
  context.putImageData(new ImageData(Uint8ClampedArray.from(source.rgba8), width, height), 0, 0);
  const mimeType = mimeTypeFor(request.format);
  const quality = request.format === 'png' ? undefined : (request.quality ?? 0.92);
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({
          type: mimeType,
          ...(quality === undefined ? {} : { quality }),
        })
      : await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value ? resolve(value) : reject(new Error(`The ${mimeType} encoder failed.`)),
            mimeType,
            quality,
          ),
        );
  if (blob.type !== mimeType) {
    throw new Error(`The browser does not provide the requested ${mimeType} encoder.`);
  }
  return {
    schema: 'himmelcad.screenshot-result',
    version: 1,
    requestId: request.requestId,
    mimeType,
    width,
    height,
    encoding: 'base64',
    data: await blobBase64(blob),
  };
}

export function parseScreenshotResult(input: unknown): ScreenshotResultV1 {
  const root = record(input, 'result');
  literal(root.schema, 'himmelcad.screenshot-result', 'result.schema');
  literal(root.version, 1, 'result.version');
  nonEmptyString(root.requestId, 'result.requestId');
  oneOf(root.mimeType, ['image/png', 'image/jpeg', 'image/webp'], 'result.mimeType');
  integerInRange(root.width, 1, 65_536, 'result.width');
  integerInRange(root.height, 1, 65_536, 'result.height');
  const encoding = oneOf(root.encoding, ['base64', 'bulkLease'], 'result.encoding');
  if (encoding === 'base64') {
    const data = nonEmptyString(root.data, 'result.data');
    if (root.lease !== undefined) invalid('is forbidden for inline data', 'result.lease');
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      invalid('must be canonical base64 without a data URL prefix', 'result.data');
    }
  } else {
    if (root.data !== undefined) invalid('is forbidden for a bulk lease', 'result.data');
    validateBulkLease(root.lease, 'result.lease');
  }
  return input as ScreenshotResultV1;
}

function validateBulkLease(input: unknown, path: string): void {
  const lease = record(input, path);
  nonEmptyString(lease.leaseId, `${path}.leaseId`);
  nonEmptyString(lease.accessToken, `${path}.accessToken`);
  const hash = nonEmptyString(lease.contentHash, `${path}.contentHash`);
  if (!/^[0-9a-f]{64}$/.test(hash))
    invalid('must be a lowercase SHA-256 hash', `${path}.contentHash`);
  nonEmptyString(lease.mediaType, `${path}.mediaType`);
  oneOf(
    lease.elementType,
    [
      'bytes',
      'uint8',
      'int8',
      'uint16',
      'int16',
      'uint32',
      'int32',
      'uint64',
      'int64',
      'float32',
      'float64',
    ],
    `${path}.elementType`,
  );
  const shape = array(lease.shape, `${path}.shape`);
  if (shape.length > 8) invalid('must have at most eight dimensions', `${path}.shape`);
  for (const [index, dimension] of shape.entries()) {
    integerInRange(dimension, 0, Number.MAX_SAFE_INTEGER, `${path}.shape[${index}]`);
  }
  oneOf(lease.endianness, ['notApplicable', 'little', 'big'], `${path}.endianness`);
  integerInRange(lease.byteLength, 0, Number.MAX_SAFE_INTEGER, `${path}.byteLength`);
  nonEmptyString(lease.expiresAt, `${path}.expiresAt`);
  integerInRange(lease.maxReadableRange, 1, Number.MAX_SAFE_INTEGER, `${path}.maxReadableRange`);
  integerInRange(
    lease.remainingReadBudget,
    0,
    Number.MAX_SAFE_INTEGER,
    `${path}.remainingReadBudget`,
  );
  literal(lease.readOnly, true, `${path}.readOnly`);
  if (lease.sourceEntity !== undefined) {
    const source = record(lease.sourceEntity, `${path}.sourceEntity`);
    nonEmptyString(source.id, `${path}.sourceEntity.id`);
    integerInRange(source.revision, 0, Number.MAX_SAFE_INTEGER, `${path}.sourceEntity.revision`);
    const versionHash = nonEmptyString(source.versionHash, `${path}.sourceEntity.versionHash`);
    if (!/^[0-9a-f]{64}$/.test(versionHash)) {
      invalid('must be a lowercase SHA-256 hash', `${path}.sourceEntity.versionHash`);
    }
  }
}

function validateWorldCamera(input: unknown, path: string): void {
  const camera = record(input, path);
  const position = vec3(camera.position, `${path}.position`);
  const target = vec3(camera.target, `${path}.target`);
  const up = vec3(camera.up, `${path}.up`);
  if (squaredDistance(position, target) === 0) invalid('position and target must differ', path);
  if (squaredLength(up) === 0) invalid('up vector must not be zero', `${path}.up`);
  const projection = record(camera.projection, `${path}.projection`);
  const kind = oneOf(projection.kind, ['perspective', 'orthographic'], `${path}.projection.kind`);
  const near = finite(projection.near, `${path}.projection.near`);
  const far = finite(projection.far, `${path}.projection.far`);
  if (near <= 0 || far <= near) invalid('requires 0 < near < far', `${path}.projection`);
  if (kind === 'perspective') {
    const fieldOfView = finite(
      projection.verticalFieldOfViewRadians,
      `${path}.projection.verticalFieldOfViewRadians`,
    );
    if (fieldOfView <= 0 || fieldOfView >= Math.PI) {
      invalid('must be between 0 and PI', `${path}.projection.verticalFieldOfViewRadians`);
    }
  } else if (finite(projection.verticalSpan, `${path}.projection.verticalSpan`) <= 0) {
    invalid('must be positive', `${path}.projection.verticalSpan`);
  }
}

function validateScopedClip(input: unknown, path: string): string {
  const clip = record(input, path);
  const id = nonEmptyString(clip.id, `${path}.id`);
  boolean(clip.enabled, `${path}.enabled`);
  const scope = record(clip.scope, `${path}.scope`);
  const scopeKind = oneOf(scope.kind, ['all', 'entities'], `${path}.scope.kind`);
  if (
    scopeKind === 'entities' &&
    stringArray(scope.entityIds, `${path}.scope.entityIds`).length === 0
  ) {
    invalid('must contain at least one entity', `${path}.scope.entityIds`);
  }
  const primitive = record(clip.primitive, `${path}.primitive`);
  const primitiveKind = oneOf(primitive.kind, ['plane', 'box'], `${path}.primitive.kind`);
  if (primitiveKind === 'plane') {
    const normal = vec3(primitive.normal, `${path}.primitive.normal`);
    if (squaredLength(normal) === 0) invalid('must not be zero', `${path}.primitive.normal`);
    finite(primitive.constant, `${path}.primitive.constant`);
    oneOf(primitive.keep, ['positive', 'negative'], `${path}.primitive.keep`);
  } else {
    vec3(primitive.center, `${path}.primitive.center`);
    const extents = vec3(primitive.halfExtents, `${path}.primitive.halfExtents`);
    if (extents.x <= 0 || extents.y <= 0 || extents.z <= 0) {
      invalid('components must be positive', `${path}.primitive.halfExtents`);
    }
    quaternion(primitive.orientation, `${path}.primitive.orientation`);
    oneOf(primitive.keep, ['inside', 'outside'], `${path}.primitive.keep`);
  }
  return id;
}

function validatePresentation(input: unknown, path: string): void {
  const presentation = record(input, path);
  oneOf(presentation.background, ['theme', 'black', 'white', 'transparent'], `${path}.background`);
  oneOf(presentation.renderStyle, ['source', 'monochrome', 'xray'], `${path}.renderStyle`);
  boolean(presentation.showGrid, `${path}.showGrid`);
  boolean(presentation.showAxes, `${path}.showAxes`);
  boolean(presentation.showSelectionOutline, `${path}.showSelectionOutline`);
}

function parseJson(input: string, path: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    invalid('must be valid JSON', path);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('must be an object', path);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid('must be an array', path);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    invalid('must be a non-empty string', path);
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  const values = array(value, path);
  const unique = new Set<string>();
  for (const [index, candidate] of values.entries()) {
    const item = nonEmptyString(candidate, `${path}[${index}]`);
    if (unique.has(item)) invalid('must not contain duplicates', `${path}[${index}]`);
    unique.add(item);
  }
  return values as readonly string[];
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('must be a boolean', path);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    invalid('must be a finite number', path);
  return value;
}

function integerInRange(value: unknown, minimum: number, maximum: number, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`must be an integer from ${minimum} through ${maximum}`, path);
  }
  return Number(value);
}

function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) invalid(`must equal ${String(expected)}`, path);
  return expected;
}

function oneOf<const Values extends readonly (string | number)[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (!values.includes(value as never)) invalid(`must be one of ${values.join(', ')}`, path);
  return value as Values[number];
}

function vec3(value: unknown, path: string): Vec3 {
  const vector = record(value, path);
  return {
    x: finite(vector.x, `${path}.x`),
    y: finite(vector.y, `${path}.y`),
    z: finite(vector.z, `${path}.z`),
  };
}

function quaternion(value: unknown, path: string): Quaternion {
  const orientation = record(value, path);
  const result = {
    x: finite(orientation.x, `${path}.x`),
    y: finite(orientation.y, `${path}.y`),
    z: finite(orientation.z, `${path}.z`),
    w: finite(orientation.w, `${path}.w`),
  };
  if (squaredLength4(result) < 1e-12) invalid('must not be zero', path);
  return result;
}

function squaredDistance(left: Vec3, right: Vec3): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return x * x + y * y + z * z;
}

function squaredLength(value: Vec3): number {
  return value.x * value.x + value.y * value.y + value.z * value.z;
}

function squaredLength4(value: Quaternion): number {
  return value.x * value.x + value.y * value.y + value.z * value.z + value.w * value.w;
}

function mimeTypeFor(format: ScreenshotRequestV1['format']): ScreenshotResultV1['mimeType'] {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  return 'image/webp';
}

async function blobBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the encoded image.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('The browser returned a non-text data URL.'));
        return;
      }
      const separator = result.indexOf(',');
      if (separator < 0) {
        reject(new Error('The browser returned an invalid data URL.'));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function invalid(message: string, path: string): never {
  throw new ContractValidationError(message, path);
}
