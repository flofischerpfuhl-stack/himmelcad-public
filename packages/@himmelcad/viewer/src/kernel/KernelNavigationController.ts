import type {
  KernelCameraController,
  KernelCameraTransitionPair,
  KernelLocalOrthographicViewFrame,
  KernelPerspectiveViewpoint,
} from './KernelCameraController.js';
import { localSectionClipVolume } from './KernelLocalSectionView.js';
import type { KernelLocalSectionView } from './KernelLocalSectionView.js';
import type {
  KernelClipVolume,
  KernelPickCandidate,
  KernelPickResult,
  KernelRasterAnalysisView,
  KernelSourcePoint,
  KernelWorldCamera,
  KernelWorldPoint,
} from './WgpuKernelViewer.js';

/** Narrow navigation-only target; it exposes no render or residency owner. */
export interface KernelNavigationTarget {
  setScopedClipVolume(scopeId: string, volume: KernelClipVolume | null): void;
  setRasterAnalysisView(entityId: string): KernelRasterAnalysisView;
  clearRasterAnalysisView(): boolean;
  setWorldCamera(
    camera: KernelWorldCamera,
    floatingOrigin: readonly [number, number, number],
  ): void;
  setCameraTransition(
    from: KernelWorldCamera,
    to: KernelWorldCamera,
    progress: number,
    floatingOrigin: readonly [number, number, number],
  ): void;
  pick(x: number, y: number, radius?: number): Promise<KernelPickResult>;
  entityHasKnownSourceHeight?(entityId: string): boolean;
}

export interface KernelNavigationCallbacks {
  readonly onActivePick?: (
    candidate: KernelPickCandidate | null,
    index: number,
    count: number,
  ) => void;
  readonly onCameraChanged?: (camera: ReturnType<KernelCameraController['worldCamera']>) => void;
  readonly onViewModeChanged?: (mode: KernelViewMode) => void;
  readonly onInteractionChanged?: (interactive: boolean) => void;
  readonly onCursorCoordinate?: (
    coordinate: KernelPickCandidate['worldPosition'],
    source: 'geometry' | 'targetPlane',
  ) => void;
  readonly requestFrame?: () => void;
}

/** Shared scene/acquisition mode. Both plan modes use one camera and winner. */
export type KernelViewMode = '3d' | '2d' | '2.5d';

type DragMode = 'orbit' | 'pan';
const LOCAL_SECTION_CLIP_SCOPE = 'kernel-local-section-view';
const LOCAL_SECTION_CLIP_ID = 'kernel-local-section-depth';

/**
 * DOM input adapter for the shared kernel camera. It owns no geometry or view
 * state: pointer hardware is translated into f64 camera commands and kernel
 * picks, while hosts decide when their render loop presents the next frame.
 */
export class KernelNavigationController {
  private dragMode: DragMode | null = null;
  private dragPivot: KernelWorldPoint | null = null;
  private lastClientX = 0;
  private lastClientY = 0;
  private localSectionDepthActive = false;
  private rasterAnalysisKind: KernelRasterAnalysisView['kind'] | null = null;
  private disposed = false;
  private pickPending = false;
  private pickAgain = false;
  private latestPickPosition: readonly [number, number] | null = null;
  private candidates: readonly KernelPickCandidate[] = [];
  private activeCandidateIndex = 0;
  private cursorCoordinate: KernelPickCandidate['worldPosition'] | null = null;
  private cursorPresentationPosition: KernelWorldPoint | null = null;
  private viewMode: KernelViewMode = '3d';
  private transitionGeneration = 0;
  private pendingTransition: {
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  } | null = null;
  private enabled = true;
  private pointerInteracting = false;
  private pointerMotionTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelInteracting = false;
  private transitionInteracting = false;
  private reportedInteracting = false;
  private wheelInteractionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly previousTabIndex: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewer: KernelNavigationTarget,
    readonly camera: KernelCameraController,
    private readonly callbacks: KernelNavigationCallbacks = {},
  ) {
    this.previousTabIndex = canvas.tabIndex;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.preventDefault);
    canvas.addEventListener('auxclick', this.preventMiddleDefault);
    canvas.addEventListener('keydown', this.onKeyDown);
    this.uploadCamera();
  }

  /** Suspends DOM input during device replacement while preserving the stable controller. */
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.cancelCameraTransition();
    this.dragMode = null;
    this.dragPivot = null;
    this.pointerInteracting = false;
    if (this.pointerMotionTimer !== null) clearTimeout(this.pointerMotionTimer);
    this.pointerMotionTimer = null;
    if (this.wheelInteractionTimer !== null) clearTimeout(this.wheelInteractionTimer);
    this.wheelInteractionTimer = null;
    this.wheelInteracting = false;
    this.reportInteraction();
    if (enabled) this.uploadCamera();
  }

  setViewportSize(width: number, height: number): void {
    this.assertAlive();
    this.camera.setViewportSize(width, height);
    this.uploadCamera();
  }

  /** Cycles the last stable GPU neighborhood in the same order as Tab picking. */
  cycleCandidate(direction: 1 | -1 = 1): KernelPickCandidate | null {
    this.assertAlive();
    if (this.candidates.length === 0) return null;
    const index =
      (this.activeCandidateIndex + direction + this.candidates.length) % this.candidates.length;
    return this.activateCandidate(index);
  }

  activeCandidate(): KernelPickCandidate | null {
    const candidate = this.candidates[this.activeCandidateIndex] ?? null;
    return candidate ? this.projectCandidate(candidate) : null;
  }

  /** Current authoritative cursor coordinate, including an explicitly unknown Source Z. */
  cursorSourceCoordinate(): KernelPickCandidate['worldPosition'] | null {
    return this.cursorCoordinate;
  }

  currentViewMode(): KernelViewMode {
    return this.viewMode;
  }

  /**
   * Changes shared view semantics. 2D and 2.5D never move the camera; only a
   * 3D/plan boundary runs the perspective/orthographic morph.
   */
  async setViewMode(mode: KernelViewMode, durationMilliseconds = 180): Promise<void> {
    this.assertAlive();
    if (mode === this.viewMode) return;
    const wasPlan = isPlanViewMode(this.viewMode);
    const becomesPlan = isPlanViewMode(mode);
    this.viewMode = mode;
    if (wasPlan !== becomesPlan) {
      if (becomesPlan) this.clearLocalSectionDepth();
      const transition = this.camera.setLockedTopDown(becomesPlan);
      const settled = this.applyCameraTransition(transition, durationMilliseconds);
      this.republishCurrentAcquisition();
      this.callbacks.onViewModeChanged?.(mode);
      this.callbacks.requestFrame?.();
      await settled;
      return;
    }
    this.republishCurrentAcquisition();
    this.callbacks.onViewModeChanged?.(mode);
    this.callbacks.requestFrame?.();
  }

  /** Runs the Rust perspective/orthographic morph and commits its endpoint. */
  setLockedTopDown(enabled: boolean, durationMilliseconds = 180): Promise<void> {
    return this.setViewMode(enabled ? '2d' : '3d', durationMilliseconds);
  }

  /** Cancels an in-flight morph and publishes one controller-owned camera endpoint. */
  adoptWorldCamera(
    camera: KernelWorldCamera,
    floatingOrigin?: readonly [number, number, number],
  ): KernelWorldCamera {
    this.assertAlive();
    const previous = this.camera.worldCamera();
    this.cancelCameraTransition();
    const adopted = this.camera.adoptWorldCamera(camera);
    try {
      this.viewer.setWorldCamera(
        adopted,
        floatingOrigin ?? this.camera.recommendedFloatingOrigin(),
      );
    } catch (error) {
      this.camera.adoptWorldCamera(previous);
      throw error;
    }
    this.callbacks.onCameraChanged?.(adopted);
    this.callbacks.requestFrame?.();
    return adopted;
  }

  /** Enters or replaces an arbitrary local section/profile view frame. */
  setLocalOrthographicFrame(
    frame: KernelLocalOrthographicViewFrame,
    durationMilliseconds = 180,
  ): void {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const transition = this.camera.setLocalOrthographicFrame(frame);
    void this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Enters a local profile/section frame and composes its optional depth slab. */
  setLocalSectionView(view: KernelLocalSectionView, durationMilliseconds = 180): void {
    this.assertAlive();
    const volume =
      view.sectionDepth === undefined || view.sectionDepth === null
        ? null
        : localSectionClipVolume({
            id: LOCAL_SECTION_CLIP_ID,
            frame: view.frame,
            depth: view.sectionDepth,
          });
    this.viewer.setScopedClipVolume(LOCAL_SECTION_CLIP_SCOPE, volume);
    this.localSectionDepthActive = volume !== null;
    const transition = this.camera.setLocalOrthographicFrame(view.frame);
    void this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Morphs to an exact user-authored world-space perspective standpoint. */
  setPerspectiveViewpoint(viewpoint: KernelPerspectiveViewpoint, durationMilliseconds = 180): void {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const transition = this.camera.setPerspectiveViewpoint(viewpoint);
    void this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Opens one isolated kernel-owned panorama or oriented-image view. */
  setRasterAnalysisView(entityId: string, durationMilliseconds = 180): KernelRasterAnalysisView {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const view = this.viewer.setRasterAnalysisView(entityId);
    try {
      const transition =
        view.kind === 'panorama'
          ? this.camera.setOrientedPerspectiveViewpoint(view)
          : this.camera.setLocalOrthographicFrame({
              origin: view.origin,
              normal: view.normal,
              up: view.up,
              verticalSpan: view.verticalSpan,
            });
      this.rasterAnalysisKind = view.kind;
      void this.applyCameraTransition(transition, durationMilliseconds);
      return view;
    } catch (error) {
      this.viewer.clearRasterAnalysisView();
      throw error;
    }
  }

  /** Leaves the active image view and restores its captured mixed-scene camera. */
  clearRasterAnalysisView(durationMilliseconds = 180): void {
    this.assertAlive();
    const kind = this.rasterAnalysisKind;
    if (!kind) return;
    const transition =
      kind === 'panorama'
        ? this.camera.clearOrientedPerspectiveViewpoint()
        : this.camera.clearLocalOrthographicFrame();
    this.viewer.clearRasterAnalysisView();
    this.rasterAnalysisKind = null;
    void this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Leaves a local section/profile frame and restores its captured 3D camera. */
  clearLocalOrthographicFrame(durationMilliseconds = 180): void {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const transition = this.camera.clearLocalOrthographicFrame();
    void this.applyCameraTransition(transition, durationMilliseconds);
  }

  private clearLocalSectionDepth(): void {
    if (!this.localSectionDepthActive) return;
    this.viewer.setScopedClipVolume(LOCAL_SECTION_CLIP_SCOPE, null);
    this.localSectionDepthActive = false;
  }

  private applyCameraTransition(
    transition: KernelCameraTransitionPair | null,
    durationMilliseconds: number,
  ): Promise<void> {
    this.cancelCameraTransition();
    if (!transition) return Promise.resolve();
    const generation = this.transitionGeneration;
    const origin = this.camera.recommendedFloatingOrigin();
    if (!Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) {
      this.viewer.setWorldCamera(transition.to, origin);
      this.callbacks.onCameraChanged?.(transition.to);
      this.callbacks.requestFrame?.();
      return Promise.resolve();
    }
    this.transitionInteracting = true;
    this.reportInteraction();
    const start = performance.now();
    return new Promise<void>((resolve, reject) => {
      this.pendingTransition = { resolve, reject };
      const frame = (timestamp: number): void => {
        if (this.disposed || generation !== this.transitionGeneration) return;
        try {
          const progress = Math.min(1, Math.max(0, (timestamp - start) / durationMilliseconds));
          this.viewer.setCameraTransition(transition.from, transition.to, progress, origin);
          this.callbacks.requestFrame?.();
          if (progress < 1) {
            requestAnimationFrame(frame);
            return;
          }
          this.viewer.setWorldCamera(transition.to, origin);
          this.callbacks.onCameraChanged?.(transition.to);
          this.pendingTransition = null;
          this.transitionInteracting = false;
          this.reportInteraction();
          resolve();
        } catch (error) {
          this.pendingTransition = null;
          this.transitionInteracting = false;
          this.reportInteraction();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      requestAnimationFrame(frame);
    });
  }

  private cancelCameraTransition(): void {
    this.transitionGeneration += 1;
    const pending = this.pendingTransition;
    this.pendingTransition = null;
    if (this.transitionInteracting) {
      this.transitionInteracting = false;
      this.reportInteraction();
    }
    pending?.resolve();
  }

  dispose(preserveViewerState = false): void {
    if (this.disposed) return;
    if (this.rasterAnalysisKind && !preserveViewerState) this.viewer.clearRasterAnalysisView();
    this.rasterAnalysisKind = null;
    this.disposed = true;
    this.cancelCameraTransition();
    if (this.wheelInteractionTimer !== null) clearTimeout(this.wheelInteractionTimer);
    if (this.pointerMotionTimer !== null) clearTimeout(this.pointerMotionTimer);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.preventDefault);
    this.canvas.removeEventListener('auxclick', this.preventMiddleDefault);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    this.canvas.tabIndex = this.previousTabIndex;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.disposed || this.enabled === false) return;
    this.canvas.focus({ preventScroll: true });
    this.dragMode = event.button === 0 && !this.camera.isOrthographicView() ? 'orbit' : 'pan';
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
      this.dragMode = null;
      return;
    }
    if (event.button === 1) event.preventDefault();
    this.dragPivot = this.cursorPresentationPosition;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
    // A captured pointer is input state, not camera motion. Streaming work is
    // throttled only after a non-zero camera change; merely holding a button
    // must leave the render and request frontiers unchanged.
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.enabled === false) return;
    if (!this.dragMode) {
      this.queuePick(event.clientX, event.clientY);
      return;
    }
    const deltaX = clamp(event.clientX - this.lastClientX, -480, 480);
    const deltaY = clamp(event.clientY - this.lastClientY, -480, 480);
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    if (deltaX === 0 && deltaY === 0) return;
    this.reportPointerMotion();
    if (this.dragMode === 'orbit') {
      if (this.dragPivot) this.camera.orbitAround(-deltaX * 0.005, deltaY * 0.005, this.dragPivot);
      else this.camera.orbit(-deltaX * 0.005, deltaY * 0.005);
    } else if (this.dragPivot) {
      const ndc = this.pointerNdc(event.clientX, event.clientY);
      if (!this.camera.panAnchorToPointer(this.dragPivot, ndc[0], ndc[1])) {
        this.camera.panPixels(deltaX, deltaY);
      }
    } else {
      this.camera.panPixels(deltaX, deltaY);
    }
    this.uploadCamera();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.disposed || this.enabled === false) return;
    this.dragMode = null;
    this.dragPivot = null;
    this.pointerInteracting = false;
    if (this.pointerMotionTimer !== null) clearTimeout(this.pointerMotionTimer);
    this.pointerMotionTimer = null;
    this.reportInteraction();
    // One fresh pick after the camera settles is enough. Rendering a complete
    // ID/depth pass for every drag frame needlessly competes with navigation.
    this.queuePick(event.clientX, event.clientY);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.disposed || this.enabled === false) return;
    event.preventDefault();
    this.wheelInteracting = true;
    this.reportInteraction();
    if (this.wheelInteractionTimer !== null) clearTimeout(this.wheelInteractionTimer);
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.wheelInteractionTimer = setTimeout(() => {
      this.wheelInteractionTimer = null;
      if (this.disposed) return;
      this.wheelInteracting = false;
      this.reportInteraction();
      this.queuePick(this.lastClientX, this.lastClientY);
    }, 120);
    const factor = Math.pow(1.0015, clamp(event.deltaY, -2_000, 2_000));
    const anchor = this.cursorPresentationPosition;
    if (anchor) this.camera.zoomAt(factor, anchor);
    else this.camera.zoom(factor);
    this.uploadCamera();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || this.enabled === false) return;
    if (event.key !== 'Tab' || this.candidates.length === 0) return;
    event.preventDefault();
    this.cycleCandidate(event.shiftKey ? -1 : 1);
  };

  private readonly preventDefault = (event: Event): void => event.preventDefault();
  private readonly preventMiddleDefault = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  private queuePick(clientX: number, clientY: number): void {
    if (this.enabled === false) return;
    this.latestPickPosition = this.physicalPointer(clientX, clientY);
    if (this.pickPending) {
      this.pickAgain = true;
      return;
    }
    this.pickPending = true;
    requestAnimationFrame(() => void this.executePick());
  }

  private async executePick(): Promise<void> {
    const position = this.latestPickPosition;
    this.pickAgain = false;
    try {
      if (!this.disposed && this.navigationEnabled() && position) {
        const result = await this.viewer.pick(position[0], position[1], 4);
        if (
          !this.disposed &&
          this.navigationEnabled() &&
          !result.stale &&
          position === this.latestPickPosition
        ) {
          this.candidates = result.candidates;
          const nearestIndex = nearestCandidateIndex(this.candidates);
          if (nearestIndex >= 0) {
            this.activateCandidate(nearestIndex);
          } else {
            this.publishTargetPlaneCursor(position);
          }
        }
      }
    } finally {
      this.pickPending = false;
      if (!this.disposed && this.navigationEnabled() && this.pickAgain) {
        this.pickPending = true;
        requestAnimationFrame(() => void this.executePick());
      }
    }
  }

  private publishTargetPlaneCursor(position: readonly [number, number]): void {
    this.activeCandidateIndex = 0;
    this.candidates = [];
    const ndc = this.physicalPointerNdc(position[0], position[1]);
    const targetPlaneCoordinate = this.camera.worldPointOnTargetPlane(ndc[0], ndc[1]);
    this.cursorCoordinate = projectTargetPlaneCoordinate(targetPlaneCoordinate, this.viewMode);
    this.cursorPresentationPosition = targetPlaneCoordinate;
    this.callbacks.onCursorCoordinate?.(this.cursorCoordinate, 'targetPlane');
    this.callbacks.onActivePick?.(null, 0, 0);
  }

  private uploadCamera(): void {
    const camera = this.camera.worldCamera();
    this.viewer.setWorldCamera(camera, this.camera.recommendedFloatingOrigin());
    this.callbacks.onCameraChanged?.(camera);
    this.callbacks.requestFrame?.();
  }

  private activateCandidate(index: number): KernelPickCandidate | null {
    const sourceCandidate = this.candidates[index] ?? null;
    if (!sourceCandidate) return null;
    const candidate = this.projectCandidate(sourceCandidate);
    this.activeCandidateIndex = index;
    this.cursorCoordinate = candidate.worldPosition;
    this.cursorPresentationPosition = sourceCandidate.presentationPosition;
    this.callbacks.onCursorCoordinate?.(candidate.worldPosition, 'geometry');
    this.callbacks.onActivePick?.(candidate, index, this.candidates.length);
    return candidate;
  }

  private republishCurrentAcquisition(): void {
    if (this.candidates[this.activeCandidateIndex]) {
      this.activateCandidate(this.activeCandidateIndex);
      return;
    }
    const presentation = this.cursorPresentationPosition;
    if (!presentation) return;
    this.cursorCoordinate = projectTargetPlaneCoordinate(presentation, this.viewMode);
    this.callbacks.onCursorCoordinate?.(this.cursorCoordinate, 'targetPlane');
  }

  private projectCandidate(candidate: KernelPickCandidate): KernelPickCandidate {
    const authoritativeCandidate =
      this.viewer.entityHasKnownSourceHeight?.(candidate.address.entityId) === false
        ? withUnknownSourceHeight(candidate)
        : candidate;
    return projectPickCandidateForViewMode(authoritativeCandidate, this.viewMode);
  }

  private reportInteraction(): void {
    const interacting =
      this.pointerInteracting || this.wheelInteracting || this.transitionInteracting;
    if (interacting === this.reportedInteracting) return;
    this.reportedInteracting = interacting;
    this.callbacks.onInteractionChanged?.(interacting);
  }

  private reportPointerMotion(): void {
    this.pointerInteracting = true;
    this.reportInteraction();
    if (this.pointerMotionTimer !== null) clearTimeout(this.pointerMotionTimer);
    this.pointerMotionTimer = setTimeout(() => {
      this.pointerMotionTimer = null;
      if (this.disposed) return;
      this.pointerInteracting = false;
      this.reportInteraction();
    }, 120);
  }

  private physicalPointer(clientX: number, clientY: number): readonly [number, number] {
    const bounds = this.canvas.getBoundingClientRect();
    const x = bounds.width > 0 ? ((clientX - bounds.left) * this.canvas.width) / bounds.width : 0;
    const y = bounds.height > 0 ? ((clientY - bounds.top) * this.canvas.height) / bounds.height : 0;
    return [
      Math.round(clamp(x, 0, Math.max(0, this.canvas.width - 1))),
      Math.round(clamp(y, 0, Math.max(0, this.canvas.height - 1))),
    ];
  }

  private pointerNdc(clientX: number, clientY: number): readonly [number, number] {
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return [0, 0];
    return [
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((clientY - bounds.top) / bounds.height) * 2,
    ];
  }

  private physicalPointerNdc(x: number, y: number): readonly [number, number] {
    return [
      this.canvas.width > 0 ? (x / this.canvas.width) * 2 - 1 : 0,
      this.canvas.height > 0 ? 1 - (y / this.canvas.height) * 2 : 0,
    ];
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('KernelNavigationController has been disposed');
    if (this.enabled === false) throw new Error('KernelNavigationController is suspended');
  }

  private navigationEnabled(): boolean {
    return this.enabled !== false;
  }
}

export function isPlanViewMode(mode: KernelViewMode): mode is '2d' | '2.5d' {
  return mode !== '3d';
}

/** Applies acquisition semantics after ranking, without changing the winner. */
export function projectPickCandidateForViewMode(
  candidate: KernelPickCandidate,
  mode: KernelViewMode,
): KernelPickCandidate {
  if (mode !== '2d' || candidate.worldPosition.z === null) return candidate;
  return {
    ...candidate,
    worldPosition: { x: candidate.worldPosition.x, y: candidate.worldPosition.y, z: null },
  };
}

function withUnknownSourceHeight(candidate: KernelPickCandidate): KernelPickCandidate {
  if (candidate.worldPosition.z === null) return candidate;
  return {
    ...candidate,
    worldPosition: { x: candidate.worldPosition.x, y: candidate.worldPosition.y, z: null },
  };
}

/** A free target plane has no Source height in either plan acquisition mode. */
export function projectTargetPlaneCoordinate(
  coordinate: KernelWorldPoint,
  mode: KernelViewMode,
): KernelSourcePoint {
  return isPlanViewMode(mode) ? { x: coordinate.x, y: coordinate.y, z: null } : coordinate;
}

/** Returns the closest visible cursor candidate with depth as stable tie-breaker. */
export function nearestCandidateIndex(candidates: readonly KernelPickCandidate[]): number {
  let nearest = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const best = nearest >= 0 ? candidates[nearest] : undefined;
    if (
      candidate &&
      (!best ||
        candidate.pixelDistance < best.pixelDistance ||
        (candidate.pixelDistance === best.pixelDistance && candidate.depth < best.depth))
    ) {
      nearest = index;
    }
  }
  return nearest;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
