"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcViewController = void 0;
exports.serializeViewState = serializeViewState;
exports.parseViewState = parseViewState;
exports.parseViewStateV2 = parseViewStateV2;
exports.validateScreenshotRequest = validateScreenshotRequest;
exports.encodeRgbaScreenshot = encodeRgbaScreenshot;
exports.parseScreenshotResult = parseScreenshotResult;
const errors_js_1 = require("./errors.js");
const protocol_js_1 = require("./protocol.js");
class RpcViewController {
    transport;
    session;
    constructor(transport, session) {
        this.transport = transport;
        this.session = session;
    }
    async getState(options) {
        (0, protocol_js_1.requireCapability)(this.session, 'view.read');
        return parseViewState(await this.transport.request('view.state.get', {}, options));
    }
    async setState(state, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'view.write');
        const validated = parseViewState(state);
        return parseViewState(await this.transport.request('view.state.set', validated, options));
    }
    async requestScreenshot(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'view.screenshot');
        validateScreenshotRequest(request);
        const result = parseScreenshotResult(await this.transport.request('view.screenshot', request, options));
        const expectedWidth = Math.round(request.width * request.pixelRatio);
        const expectedHeight = Math.round(request.height * request.pixelRatio);
        if (result.requestId !== request.requestId ||
            result.mimeType !== mimeTypeFor(request.format) ||
            result.width !== expectedWidth ||
            result.height !== expectedHeight) {
            throw new errors_js_1.ContractValidationError('does not match the screenshot request', 'result');
        }
        return result;
    }
}
exports.RpcViewController = RpcViewController;
function serializeViewState(state) {
    return JSON.stringify(parseViewState(state));
}
function parseViewState(input) {
    const value = typeof input === 'string' ? parseJson(input, 'viewState') : input;
    const root = record(value, 'viewState');
    literal(root.schema, 'himmelcad.view-state', 'viewState.schema');
    literal(root.version, 1, 'viewState.version');
    validateWorldCamera(root.camera, 'viewState.camera');
    oneOf(root.navigationMode, ['3d', '2d', '2.5d'], 'viewState.navigationMode');
    stringArray(root.hiddenEntityIds, 'viewState.hiddenEntityIds');
    stringArray(root.selectedEntityIds, 'viewState.selectedEntityIds');
    const clips = array(root.scopedClips, 'viewState.scopedClips');
    const clipIds = new Set();
    for (const [index, clip] of clips.entries()) {
        const id = validateScopedClip(clip, `viewState.scopedClips[${index}]`);
        if (clipIds.has(id))
            invalid('must be unique', `viewState.scopedClips[${index}].id`);
        clipIds.add(id);
    }
    validatePresentation(root.presentation, 'viewState.presentation');
    return value;
}
/** Parses the Plan-free Release 0.5 ViewState v2 profile. */
function parseViewStateV2(input) {
    const value = typeof input === 'string' ? parseJson(input, 'viewState') : input;
    const root = record(value, 'viewState');
    literal(root.schema, 'himmelcad.view-state', 'viewState.schema');
    literal(root.version, 2, 'viewState.version');
    validateWorldCamera(root.camera, 'viewState.camera');
    oneOf(root.navigationMode, ['3d', '2d', '2.5d'], 'viewState.navigationMode');
    stringArray(root.hiddenEntityIds, 'viewState.hiddenEntityIds');
    stringArray(root.sessionHiddenEntityIds, 'viewState.sessionHiddenEntityIds');
    stringArray(root.selectedEntityIds, 'viewState.selectedEntityIds');
    const clipRefs = array(root.clipRefs, 'viewState.clipRefs');
    const ids = new Set();
    for (const [index, candidate] of clipRefs.entries()) {
        const path = `viewState.clipRefs[${index}]`;
        const clip = record(candidate, path);
        const id = nonEmptyString(clip.entityId, `${path}.entityId`);
        if (ids.has(id))
            invalid('must be unique', `${path}.entityId`);
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
    if (overrideKind === 'mode')
        nonEmptyString(override.mode, 'viewState.presentation.colorModeOverride.mode');
    const multiplier = finite(presentation.pointSizeMultiplier, 'viewState.presentation.pointSizeMultiplier');
    if (multiplier <= 0)
        invalid('must be positive', 'viewState.presentation.pointSizeMultiplier');
    for (const forbidden of ['scopedClips', 'pinnedViewport', 'planFilters', 'updatePolicy', 'capturedPlanRevision']) {
        if (root[forbidden] !== undefined)
            invalid('is not admitted in the Release 0.5 profile', `viewState.${forbidden}`);
    }
    return value;
}
function validateScreenshotRequest(request) {
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
        if (format === 'png')
            invalid('is not supported for PNG', 'request.quality');
        if (quality < 0 || quality > 1)
            invalid('must be from 0 through 1', 'request.quality');
    }
}
/** Encodes a renderer-owned, top-left-origin RGBA8 capture without sampling its canvas. */
async function encodeRgbaScreenshot(request, source) {
    validateScreenshotRequest(request);
    const width = Math.round(request.width * request.pixelRatio);
    const height = Math.round(request.height * request.pixelRatio);
    if (source.width !== width ||
        source.height !== height ||
        source.rgba8.byteLength !== width * height * 4) {
        throw new errors_js_1.ContractValidationError('does not match the requested dimensions', 'capture');
    }
    const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    if (!context)
        throw new Error('A 2D canvas encoder is unavailable.');
    context.putImageData(new ImageData(Uint8ClampedArray.from(source.rgba8), width, height), 0, 0);
    const mimeType = mimeTypeFor(request.format);
    const quality = request.format === 'png' ? undefined : (request.quality ?? 0.92);
    const blob = canvas instanceof OffscreenCanvas
        ? await canvas.convertToBlob({
            type: mimeType,
            ...(quality === undefined ? {} : { quality }),
        })
        : await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(`The ${mimeType} encoder failed.`)), mimeType, quality));
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
function parseScreenshotResult(input) {
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
        if (root.lease !== undefined)
            invalid('is forbidden for inline data', 'result.lease');
        if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
            invalid('must be canonical base64 without a data URL prefix', 'result.data');
        }
    }
    else {
        if (root.data !== undefined)
            invalid('is forbidden for a bulk lease', 'result.data');
        validateBulkLease(root.lease, 'result.lease');
    }
    return input;
}
function validateBulkLease(input, path) {
    const lease = record(input, path);
    nonEmptyString(lease.leaseId, `${path}.leaseId`);
    nonEmptyString(lease.accessToken, `${path}.accessToken`);
    const hash = nonEmptyString(lease.contentHash, `${path}.contentHash`);
    if (!/^[0-9a-f]{64}$/.test(hash))
        invalid('must be a lowercase SHA-256 hash', `${path}.contentHash`);
    nonEmptyString(lease.mediaType, `${path}.mediaType`);
    oneOf(lease.elementType, [
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
    ], `${path}.elementType`);
    const shape = array(lease.shape, `${path}.shape`);
    if (shape.length > 8)
        invalid('must have at most eight dimensions', `${path}.shape`);
    for (const [index, dimension] of shape.entries()) {
        integerInRange(dimension, 0, Number.MAX_SAFE_INTEGER, `${path}.shape[${index}]`);
    }
    oneOf(lease.endianness, ['notApplicable', 'little', 'big'], `${path}.endianness`);
    integerInRange(lease.byteLength, 0, Number.MAX_SAFE_INTEGER, `${path}.byteLength`);
    nonEmptyString(lease.expiresAt, `${path}.expiresAt`);
    integerInRange(lease.maxReadableRange, 1, Number.MAX_SAFE_INTEGER, `${path}.maxReadableRange`);
    integerInRange(lease.remainingReadBudget, 0, Number.MAX_SAFE_INTEGER, `${path}.remainingReadBudget`);
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
function validateWorldCamera(input, path) {
    const camera = record(input, path);
    const position = vec3(camera.position, `${path}.position`);
    const target = vec3(camera.target, `${path}.target`);
    const up = vec3(camera.up, `${path}.up`);
    if (squaredDistance(position, target) === 0)
        invalid('position and target must differ', path);
    if (squaredLength(up) === 0)
        invalid('up vector must not be zero', `${path}.up`);
    const projection = record(camera.projection, `${path}.projection`);
    const kind = oneOf(projection.kind, ['perspective', 'orthographic'], `${path}.projection.kind`);
    const near = finite(projection.near, `${path}.projection.near`);
    const far = finite(projection.far, `${path}.projection.far`);
    if (near <= 0 || far <= near)
        invalid('requires 0 < near < far', `${path}.projection`);
    if (kind === 'perspective') {
        const fieldOfView = finite(projection.verticalFieldOfViewRadians, `${path}.projection.verticalFieldOfViewRadians`);
        if (fieldOfView <= 0 || fieldOfView >= Math.PI) {
            invalid('must be between 0 and PI', `${path}.projection.verticalFieldOfViewRadians`);
        }
    }
    else if (finite(projection.verticalSpan, `${path}.projection.verticalSpan`) <= 0) {
        invalid('must be positive', `${path}.projection.verticalSpan`);
    }
}
function validateScopedClip(input, path) {
    const clip = record(input, path);
    const id = nonEmptyString(clip.id, `${path}.id`);
    boolean(clip.enabled, `${path}.enabled`);
    const scope = record(clip.scope, `${path}.scope`);
    const scopeKind = oneOf(scope.kind, ['all', 'entities'], `${path}.scope.kind`);
    if (scopeKind === 'entities' &&
        stringArray(scope.entityIds, `${path}.scope.entityIds`).length === 0) {
        invalid('must contain at least one entity', `${path}.scope.entityIds`);
    }
    const primitive = record(clip.primitive, `${path}.primitive`);
    const primitiveKind = oneOf(primitive.kind, ['plane', 'box'], `${path}.primitive.kind`);
    if (primitiveKind === 'plane') {
        const normal = vec3(primitive.normal, `${path}.primitive.normal`);
        if (squaredLength(normal) === 0)
            invalid('must not be zero', `${path}.primitive.normal`);
        finite(primitive.constant, `${path}.primitive.constant`);
        oneOf(primitive.keep, ['positive', 'negative'], `${path}.primitive.keep`);
    }
    else {
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
function validatePresentation(input, path) {
    const presentation = record(input, path);
    oneOf(presentation.background, ['theme', 'black', 'white', 'transparent'], `${path}.background`);
    oneOf(presentation.renderStyle, ['source', 'monochrome', 'xray'], `${path}.renderStyle`);
    boolean(presentation.showGrid, `${path}.showGrid`);
    boolean(presentation.showAxes, `${path}.showAxes`);
    boolean(presentation.showSelectionOutline, `${path}.showSelectionOutline`);
}
function parseJson(input, path) {
    try {
        return JSON.parse(input);
    }
    catch {
        invalid('must be valid JSON', path);
    }
}
function record(value, path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        invalid('must be an object', path);
    return value;
}
function array(value, path) {
    if (!Array.isArray(value))
        invalid('must be an array', path);
    return value;
}
function nonEmptyString(value, path) {
    if (typeof value !== 'string' || value.trim().length === 0)
        invalid('must be a non-empty string', path);
    return value;
}
function stringArray(value, path) {
    const values = array(value, path);
    const unique = new Set();
    for (const [index, candidate] of values.entries()) {
        const item = nonEmptyString(candidate, `${path}[${index}]`);
        if (unique.has(item))
            invalid('must not contain duplicates', `${path}[${index}]`);
        unique.add(item);
    }
    return values;
}
function boolean(value, path) {
    if (typeof value !== 'boolean')
        invalid('must be a boolean', path);
    return value;
}
function finite(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        invalid('must be a finite number', path);
    return value;
}
function integerInRange(value, minimum, maximum, path) {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        invalid(`must be an integer from ${minimum} through ${maximum}`, path);
    }
    return Number(value);
}
function literal(value, expected, path) {
    if (value !== expected)
        invalid(`must equal ${String(expected)}`, path);
    return expected;
}
function oneOf(value, values, path) {
    if (!values.includes(value))
        invalid(`must be one of ${values.join(', ')}`, path);
    return value;
}
function vec3(value, path) {
    const vector = record(value, path);
    return {
        x: finite(vector.x, `${path}.x`),
        y: finite(vector.y, `${path}.y`),
        z: finite(vector.z, `${path}.z`),
    };
}
function quaternion(value, path) {
    const orientation = record(value, path);
    const result = {
        x: finite(orientation.x, `${path}.x`),
        y: finite(orientation.y, `${path}.y`),
        z: finite(orientation.z, `${path}.z`),
        w: finite(orientation.w, `${path}.w`),
    };
    if (squaredLength4(result) < 1e-12)
        invalid('must not be zero', path);
    return result;
}
function squaredDistance(left, right) {
    const x = left.x - right.x;
    const y = left.y - right.y;
    const z = left.z - right.z;
    return x * x + y * y + z * z;
}
function squaredLength(value) {
    return value.x * value.x + value.y * value.y + value.z * value.z;
}
function squaredLength4(value) {
    return value.x * value.x + value.y * value.y + value.z * value.z + value.w * value.w;
}
function mimeTypeFor(format) {
    if (format === 'png')
        return 'image/png';
    if (format === 'jpeg')
        return 'image/jpeg';
    return 'image/webp';
}
async function blobBase64(blob) {
    return await new Promise((resolve, reject) => {
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
function invalid(message, path) {
    throw new errors_js_1.ContractValidationError(message, path);
}
//# sourceMappingURL=view.js.map