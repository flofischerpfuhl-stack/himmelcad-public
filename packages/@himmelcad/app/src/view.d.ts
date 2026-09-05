import type { AppProtocolMethods, NegotiatedSession, RpcMethodDefinition, RpcRequestOptions, RpcTransport } from './protocol.js';
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
export type WorldProjection = {
    readonly kind: 'perspective';
    readonly verticalFieldOfViewRadians: number;
    readonly near: number;
    readonly far: number;
} | {
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
export type ClipScope = {
    readonly kind: 'all';
} | {
    readonly kind: 'entities';
    readonly entityIds: readonly string[];
};
export type ScopedClip = {
    readonly id: string;
    readonly enabled: boolean;
    readonly scope: ClipScope;
    readonly primitive: {
        readonly kind: 'plane';
        readonly normal: Vec3;
        readonly constant: number;
        readonly keep: 'positive' | 'negative';
    };
} | {
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
export type ViewColorModeOverrideV2 = {
    readonly kind: 'follow';
} | {
    readonly kind: 'mode';
    readonly mode: string;
    readonly params: unknown;
};
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
export type ScreenshotResultV1 = ScreenshotResultBaseV1 & ({
    readonly encoding: 'base64';
    readonly data: string;
} | {
    readonly encoding: 'bulkLease';
    readonly lease: BulkLeaseDescriptor;
});
/** Read-only, time- and budget-bounded bytes owned by the desktop host. */
export interface BulkLeaseDescriptor {
    readonly leaseId: string;
    readonly accessToken: string;
    readonly contentHash: string;
    readonly mediaType: string;
    readonly elementType: 'bytes' | 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'uint64' | 'int64' | 'float32' | 'float64';
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
    requestScreenshot(request: ScreenshotRequestV1, options?: RpcRequestOptions): Promise<ScreenshotResultV1>;
}
type ViewTransport = RpcTransport<AppViewMethods & {
    readonly [Key in keyof AppViewMethods]: RpcMethodDefinition;
}>;
export declare class RpcViewController implements ViewController {
    private readonly transport;
    private readonly session;
    constructor(transport: ViewTransport, session: NegotiatedSession);
    getState(options?: RpcRequestOptions): Promise<ViewStateV1>;
    setState(state: ViewStateV1, options?: RpcRequestOptions): Promise<ViewStateV1>;
    requestScreenshot(request: ScreenshotRequestV1, options?: RpcRequestOptions): Promise<ScreenshotResultV1>;
}
export declare function serializeViewState(state: ViewStateV1): string;
export declare function parseViewState(input: unknown): ViewStateV1;
/** Parses the Plan-free Release 0.5 ViewState v2 profile. */
export declare function parseViewStateV2(input: unknown): ViewStateV2;
export declare function validateScreenshotRequest(request: ScreenshotRequestV1): void;
/** Encodes a renderer-owned, top-left-origin RGBA8 capture without sampling its canvas. */
export declare function encodeRgbaScreenshot(request: ScreenshotRequestV1, source: RgbaScreenshotSource): Promise<ScreenshotResultV1>;
export declare function parseScreenshotResult(input: unknown): ScreenshotResultV1;
export {};
//# sourceMappingURL=view.d.ts.map