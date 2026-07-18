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
  /** URL of the slim `himmelcad-decode-wasm` module used only inside workers. */
  readonly decodeWasmModuleUrl: string;
  /** Project-unit tolerance for exact authoritative clip-cap intersections. */
  readonly authoritativeSectionTolerance: number;
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
  decodeWasmModuleUrl,
  authoritativeSectionTolerance,
  className,
  onReady,
  onActivePick,
  onCursorCoordinate,
  onFrame,
  onHardwarePolicy,
  onRuntimeQuality,
  onError,
}: KernelViewportProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const abort = new AbortController();
    let alive = true;
    let animationFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let session: KernelViewerSession | null = null;
    let hostInteracting = false;
    let resizeViewport: (() => void) | null = null;

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
          decodeWasmModuleUrl,
          authoritativeSectionTolerance,
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
          const bounds = canvas.getBoundingClientRect();
          const renderScale = Math.min(
            globalThis.devicePixelRatio || 1,
            session.runtimeQuality.renderScale,
          );
          session.resize(bounds.width, bounds.height, renderScale);
        };
        resizeViewport = resize;
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);
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
      session?.dispose();
    };
  }, [
    authoritativeSectionTolerance,
    decodeWasmModuleUrl,
    onActivePick,
    onCursorCoordinate,
    onError,
    onFrame,
    onHardwarePolicy,
    onReady,
    onRuntimeQuality,
    wasmLoader,
  ]);

  return (
    <div className={className ? `${styles.root} ${className}` : styles.root}>
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
