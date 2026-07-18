import { useEffect, useRef } from 'react';

import styles from './KernelViewport.module.css';
import { KernelCameraController } from './KernelCameraController.js';
import {
  KernelNavigationController,
  type KernelNavigationCallbacks,
} from './KernelNavigationController.js';
import { KernelStreamingDriver } from './KernelStreamingDriver.js';
import { KernelViewerScene } from './KernelViewerScene.js';
import { KernelDecodeWorkerPool } from './KernelDecodeWorkerPool.js';
import type {
  HimmelcadViewerWasmLoader,
  KernelFrameOutcome,
  KernelHardwareInventory,
  KernelPickCandidate,
  KernelResolvedHardwarePolicy,
  KernelRuntimeQualityAdjustment,
  KernelRuntimeQualityState,
} from './WgpuKernelViewer.js';
import { kernelStreamingWorkPolicy, WgpuKernelViewer } from './WgpuKernelViewer.js';

export interface KernelViewportHandle {
  readonly viewer: WgpuKernelViewer;
  readonly camera: KernelCameraController;
  readonly navigation: KernelNavigationController;
  readonly streaming: KernelStreamingDriver;
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

/** React host for the shared Rust viewer; it contains no Three.js scene state. */
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
    let alive = true;
    let animationFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let viewer: WgpuKernelViewer | null = null;
    let navigation: KernelNavigationController | null = null;
    let streaming: KernelStreamingDriver | null = null;
    let hardwarePolicy: KernelResolvedHardwarePolicy | null = null;
    let runtimeQuality: KernelRuntimeQualityState | null = null;
    let hardwareInventory: KernelHardwareInventory | null = null;
    let navigationInteracting = false;
    let hostInteracting = false;
    let calibrationActive = false;
    let calibrationComplete = false;
    let resizeViewport: (() => void) | null = null;

    const fail = (error: unknown): void => {
      if (!alive) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
    };

    const requestFrame = (): void => {
      if (!alive || animationFrame !== null) return;
      animationFrame = requestAnimationFrame(renderFrame);
    };

    const renderFrame = (): void => {
      animationFrame = null;
      if (!alive || !viewer || !streaming || !hardwarePolicy || !runtimeQuality) return;
      const frameStarted = performance.now();
      try {
        if (calibrationActive && !calibrationComplete && hardwareInventory) {
          const progress = viewer.stepHardwareCalibration();
          if (progress.calibration) {
            const previousQuality = runtimeQuality;
            hardwarePolicy = viewer.resolveHardwarePolicy(hardwareInventory, progress.calibration);
            streaming.setRuntimeLimits(hardwarePolicy);
            runtimeQuality = viewer.runtimeQuality();
            calibrationComplete = true;
            onHardwarePolicy?.(hardwarePolicy);
            if (
              runtimeQuality.renderScale < previousQuality.renderScale ||
              runtimeQuality.detailScale < previousQuality.detailScale
            ) {
              onRuntimeQuality?.(runtimeQuality, 'reduced');
            }
            resizeViewport?.();
          } else {
            requestFrame();
          }
        }
        const interacting = navigationInteracting || hostInteracting;
        const streamingPolicy = kernelStreamingWorkPolicy(hardwarePolicy, interacting);
        const plan = viewer.planStreamingFrame({
          resourceBudget: hardwarePolicy.resources,
          frameBudget: streamingPolicy.frame,
          detailScale: runtimeQuality.detailScale,
          maximumScreenSpaceError: 2,
          maximumTraversedNodes: streamingPolicy.maximumTraversedNodes,
        });
        const uploadedBytes = streaming.execute(plan);
        const outcome = viewer.render();
        onFrame?.(outcome);
        if (outcome.status === 'recreateSurface') {
          viewer.recoverSurface();
        }
        const qualityObservation = viewer.observeFrameTelemetry({
          cpuMs: performance.now() - frameStarted,
          interacting,
          uploadedBytes,
        });
        runtimeQuality = qualityObservation.quality;
        if (qualityObservation.adjustment !== 'unchanged') {
          onRuntimeQuality?.(runtimeQuality, qualityObservation.adjustment);
          resizeViewport?.();
        }
        if (
          plan.actions.some(
            (action) => action.kind !== 'fetchTile' && action.kind !== 'fetchHierarchyPage',
          ) ||
          outcome.status === 'recreateSurface'
        ) {
          requestFrame();
        }
      } catch (error) {
        fail(error);
      }
    };

    void (async () => {
      try {
        const created = await WgpuKernelViewer.create(canvas, wasmLoader);
        if (!alive) {
          created.dispose();
          return;
        }
        viewer = created;
        const inventory = browserInventory();
        hardwareInventory = inventory;
        const policy = created.resolveHardwarePolicy(inventory);
        hardwarePolicy = policy;
        const initialQuality = created.runtimeQuality();
        runtimeQuality = initialQuality;
        onHardwarePolicy?.(policy);
        const camera = new KernelCameraController(
          Math.max(1, canvas.clientWidth),
          Math.max(1, canvas.clientHeight),
        );
        camera.frame({ x: -25, y: -25, z: -1 }, { x: 25, y: 25, z: 1 });
        const decodePool = new KernelDecodeWorkerPool(
          decodeWasmModuleUrl,
          policy.decoderWorkers,
          undefined,
          inventory.systemMemoryBytes === null
            ? 512 * 1024 * 1024
            : Math.max(192 * 1024 * 1024, Math.floor(inventory.systemMemoryBytes * 0.125)),
        );
        const driver = new KernelStreamingDriver(
          created,
          undefined,
          requestFrame,
          undefined,
          decodePool,
        );
        driver.setRuntimeLimits(policy);
        streaming = driver;
        const scene = new KernelViewerScene(created, driver, requestFrame);
        created.attachClipCapCoordinator(driver, {
          tolerance: authoritativeSectionTolerance,
          requestFrame,
          onError: fail,
        });
        navigation = new KernelNavigationController(canvas, created, camera, {
          ...(onActivePick ? { onActivePick } : {}),
          ...(onCursorCoordinate ? { onCursorCoordinate } : {}),
          onInteractionChanged(interacting): void {
            navigationInteracting = interacting;
            requestFrame();
          },
          requestFrame,
        });
        const resize = (): void => {
          const bounds = canvas.getBoundingClientRect();
          const renderScale = Math.min(
            globalThis.devicePixelRatio || 1,
            runtimeQuality?.renderScale ?? initialQuality.renderScale,
          );
          const extent = created.resize(bounds.width, bounds.height, renderScale);
          navigation?.setViewportSize(extent.width, extent.height);
          requestFrame();
        };
        resizeViewport = resize;
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);
        resize();
        onReady?.({
          viewer: created,
          camera,
          navigation,
          streaming: driver,
          scene,
          get hardwarePolicy() {
            return hardwarePolicy ?? policy;
          },
          get runtimeQuality() {
            return runtimeQuality ?? initialQuality;
          },
          requestFrame,
          setInteracting(interacting): void {
            hostInteracting = interacting;
            requestFrame();
          },
        });
        created.beginHardwareCalibration();
        calibrationActive = true;
        requestFrame();
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      alive = false;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      navigation?.dispose();
      viewer?.detachClipCapCoordinator();
      streaming?.dispose();
      viewer?.dispose();
    };
  }, [
    decodeWasmModuleUrl,
    authoritativeSectionTolerance,
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

function browserInventory(): {
  readonly gpuMemoryBytes: null;
  readonly systemMemoryBytes: number | null;
  readonly logicalCores: number;
} {
  const browser = navigator as Navigator & { readonly deviceMemory?: number };
  const systemMemoryBytes =
    typeof browser.deviceMemory === 'number' ? browser.deviceMemory * 1_073_741_824 : null;
  return {
    gpuMemoryBytes: null,
    systemMemoryBytes,
    logicalCores: Math.max(1, Math.min(65_535, navigator.hardwareConcurrency || 1)),
  };
}
