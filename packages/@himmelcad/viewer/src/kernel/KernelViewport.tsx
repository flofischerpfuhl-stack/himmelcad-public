import { useEffect, useRef } from 'react';

import styles from './KernelViewport.module.css';
import type { KernelCameraController } from './KernelCameraController.js';
import type {
  KernelNavigationCallbacks,
  KernelNavigationController,
} from './KernelNavigationController.js';
import type { KernelViewerScene } from './KernelViewerScene.js';
import { KernelViewerSession, type KernelViewerSessionEvent } from './KernelViewerSession.js';
import type {
  HimmelcadViewerWasmLoader,
  KernelBackendPreference,
  KernelFrameOutcome,
  KernelPickCandidate,
  KernelResolvedHardwarePolicy,
  KernelRuntimeQualityAdjustment,
  KernelRuntimeQualityState,
} from './WgpuKernelViewer.js';

/** Stable React-host handle; all mutable engine ownership remains in the session. */
export interface KernelViewportHandle {
  readonly session: KernelViewerSession;
  readonly camera: KernelCameraController;
  readonly navigation: KernelNavigationController;
  readonly scene: KernelViewerScene;
  readonly hardwarePolicy: KernelResolvedHardwarePolicy;
  readonly runtimeQuality: KernelRuntimeQualityState;
  requestFrame(): void;
  setInteracting(interacting: boolean): void;
}

export interface KernelViewportProps {
  readonly wasmLoader: HimmelcadViewerWasmLoader;
  readonly backend?: KernelBackendPreference;
  /** URL of the slim `himmelcad-decode-wasm` module used only inside workers. */
  readonly decodeWasmModuleUrl: string;
  /** Project-unit tolerance for exact authoritative clip-cap intersections. */
  readonly authoritativeSectionTolerance: number;
  /**
   * Keeps one window-sized presentation surface behind this clipped host.
   * Panel layout then changes only the visible mask, never the camera or GPU
   * target extent. An actual browser-window resize still reallocates normally.
   */
  readonly presentationMode?: 'container' | 'windowMask';
  readonly className?: string;
  readonly onReady?: (handle: KernelViewportHandle) => void;
  readonly onActivePick?: (
    candidate: KernelPickCandidate | null,
    index: number,
    count: number,
  ) => void;
  readonly onCursorCoordinate?: KernelNavigationCallbacks['onCursorCoordinate'];
  readonly onFrame?: (outcome: KernelFrameOutcome) => void;
  readonly onHardwarePolicy?: (policy: KernelResolvedHardwarePolicy) => void;
  readonly onRuntimeQuality?: (
    quality: KernelRuntimeQualityState,
    adjustment: Exclude<KernelRuntimeQualityAdjustment, 'unchanged'>,
  ) => void;
  readonly onError?: (error: Error) => void;
}

/** Thin React lifecycle adapter over the framework-free shared viewer session. */
export function KernelViewport({
  wasmLoader,
  backend,
  decodeWasmModuleUrl,
  authoritativeSectionTolerance,
  presentationMode = 'container',
  className,
  onReady,
  onActivePick,
  onCursorCoordinate,
  onFrame,
  onHardwarePolicy,
  onRuntimeQuality,
  onError,
}: KernelViewportProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const abort = new AbortController();
    let alive = true;
    let animationFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let session: KernelViewerSession | null = null;
    let hostInteracting = false;
    let resizeViewport: (() => void) | null = null;
    const windowMasked = presentationMode === 'windowMask';

    const syncWindowMask = (): void => {
      if (!windowMasked) return;
      const bounds = root.getBoundingClientRect();
      canvas.style.left = `${-bounds.left}px`;
      canvas.style.top = `${-bounds.top}px`;
      canvas.style.width = `${globalThis.innerWidth}px`;
      canvas.style.height = `${globalThis.innerHeight}px`;
    };

    // Establish the compositor geometry before the GPU surface is created so
    // its first camera and target already use the stable presentation extent.
    syncWindowMask();

    const fail = (error: unknown): void => {
      if (!alive || abort.signal.aborted) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
    };

    const requestFrame = (): void => {
      if (!alive || animationFrame !== null) return;
      animationFrame = requestAnimationFrame(renderFrame);
    };

    const renderFrame = (): void => {
      animationFrame = null;
      if (!alive || session === null) return;
      try {
        session.frame(hostInteracting);
      } catch (error) {
        fail(error);
      }
    };

    const observeSession = (event: KernelViewerSessionEvent): void => {
      switch (event.type) {
        case 'frame':
          onFrame?.(event.outcome);
          return;
        case 'hardwarePolicy':
          onHardwarePolicy?.(event.policy);
          resizeViewport?.();
          return;
        case 'runtimeQuality':
          onRuntimeQuality?.(event.quality, event.adjustment);
          resizeViewport?.();
          return;
        case 'deviceRecoveryCompleted':
          resizeViewport?.();
          requestFrame();
          return;
        case 'error':
          fail(event.error);
          return;
        case 'deviceRecoveryStarted':
        case 'loadProgress':
        case 'disposed':
          return;
      }
    };

    void (async () => {
      try {
        const created = await KernelViewerSession.create({
          canvas,
          wasmLoader,
          ...(backend ? { backend } : {}),
          decodeWasmModuleUrl,
          authoritativeSectionTolerance,
          ...(windowMasked
            ? { initialWidth: globalThis.innerWidth, initialHeight: globalThis.innerHeight }
            : {}),
          requestFrame,
          signal: abort.signal,
        });
        if (!alive || abort.signal.aborted) {
          created.dispose();
          return;
        }
        session = created;
        created.subscribe(observeSession);
        created.camera.frame({ x: -25, y: -25, z: -1 }, { x: 25, y: 25, z: 1 });
        const navigation = created.attachNavigation({
          ...(onActivePick ? { onActivePick } : {}),
          ...(onCursorCoordinate ? { onCursorCoordinate } : {}),
        });
        const resize = (): void => {
          if (!alive || session === null) return;
          if (windowMasked) {
            syncWindowMask();
            // CAD presentation stays at native physical resolution. Geometry
            // detail remains adaptive, but interaction never reallocates a
            // blurry fractional-resolution backbuffer.
            const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
            session.resize(globalThis.innerWidth, globalThis.innerHeight, pixelRatio);
            return;
          }
          const bounds = canvas.getBoundingClientRect();
          const renderScale =
            (globalThis.devicePixelRatio || 1) * session.runtimeQuality.renderScale;
          session.resize(bounds.width, bounds.height, renderScale);
        };
        resizeViewport = resize;
        resizeObserver = new ResizeObserver(windowMasked ? syncWindowMask : resize);
        resizeObserver.observe(windowMasked ? root : canvas);
        if (windowMasked) globalThis.addEventListener('resize', resize);
        resize();
        onHardwarePolicy?.(created.hardwarePolicy);
        onReady?.({
          session: created,
          camera: created.camera,
          navigation,
          scene: created.scene,
          get hardwarePolicy() {
            return created.hardwarePolicy;
          },
          get runtimeQuality() {
            return created.runtimeQuality;
          },
          requestFrame,
          setInteracting(interacting): void {
            hostInteracting = interacting;
            requestFrame();
          },
        });
        requestFrame();
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      alive = false;
      abort.abort();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      if (windowMasked && resizeViewport) globalThis.removeEventListener('resize', resizeViewport);
      session?.dispose();
    };
  }, [
    authoritativeSectionTolerance,
    backend,
    decodeWasmModuleUrl,
    onActivePick,
    onCursorCoordinate,
    onError,
    onFrame,
    onHardwarePolicy,
    onReady,
    onRuntimeQuality,
    presentationMode,
    wasmLoader,
  ]);

  return (
    <div
      ref={rootRef}
      className={`${styles.root}${presentationMode === 'windowMask' ? ` ${styles.windowMask}` : ''}${className ? ` ${className}` : ''}`}
    >
      <canvas
        ref={canvasRef}
        className={`${styles.canvas}${presentationMode === 'windowMask' ? ` ${styles.windowCanvas}` : ''}`}
      />
    </div>
  );
}
