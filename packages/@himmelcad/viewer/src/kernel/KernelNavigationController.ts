import { KernelCameraController } from './KernelCameraController.js';
import type {
  KernelCameraTransitionPair,
  KernelLocalOrthographicViewFrame,
  KernelPerspectiveViewpoint,
} from './KernelCameraController.js';
import { localSectionClipVolume } from './KernelLocalSectionView.js';
import type { KernelLocalSectionView } from './KernelLocalSectionView.js';
import type { KernelPickCandidate } from './WgpuKernelViewer.js';
import { WgpuKernelViewer } from './WgpuKernelViewer.js';

export interface KernelNavigationCallbacks {
  readonly onActivePick?: (
    candidate: KernelPickCandidate | null,
    index: number,
    count: number,
  ) => void;
  readonly onCameraChanged?: (camera: ReturnType<KernelCameraController['worldCamera']>) => void;
  readonly onInteractionChanged?: (interactive: boolean) => void;
  readonly onCursorCoordinate?: (
    coordinate: KernelPickCandidate['worldPosition'],
    source: 'geometry' | 'targetPlane',
  ) => void;
  readonly requestFrame?: () => void;
}

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
  private dragPivot: KernelPickCandidate['worldPosition'] | null = null;
  private lastClientX = 0;
  private lastClientY = 0;
  private movedDuringDrag = false;
  private localSectionDepthActive = false;
  private disposed = false;
  private pickPending = false;
  private pickAgain = false;
  private latestPickPosition: readonly [number, number] | null = null;
  private candidates: readonly KernelPickCandidate[] = [];
  private activeCandidateIndex = 0;
  private cursorCoordinate: KernelPickCandidate['worldPosition'] | null = null;
  private transitionGeneration = 0;
  private pointerInteracting = false;
  private wheelInteracting = false;
  private transitionInteracting = false;
  private reportedInteracting = false;
  private wheelInteractionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly previousTabIndex: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewer: WgpuKernelViewer,
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
    return this.candidates[this.activeCandidateIndex] ?? null;
  }

  /** Runs the Rust perspective/orthographic morph and commits its endpoint. */
  setLockedTopDown(enabled: boolean, durationMilliseconds = 180): void {
    this.assertAlive();
    if (enabled) this.clearLocalSectionDepth();
    const transition = this.camera.setLockedTopDown(enabled);
    this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Enters or replaces an arbitrary local section/profile view frame. */
  setLocalOrthographicFrame(
    frame: KernelLocalOrthographicViewFrame,
    durationMilliseconds = 180,
  ): void {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const transition = this.camera.setLocalOrthographicFrame(frame);
    this.applyCameraTransition(transition, durationMilliseconds);
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
    this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Morphs to an exact user-authored world-space perspective standpoint. */
  setPerspectiveViewpoint(viewpoint: KernelPerspectiveViewpoint, durationMilliseconds = 180): void {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const transition = this.camera.setPerspectiveViewpoint(viewpoint);
    this.applyCameraTransition(transition, durationMilliseconds);
  }

  /** Leaves a local section/profile frame and restores its captured 3D camera. */
  clearLocalOrthographicFrame(durationMilliseconds = 180): void {
    this.assertAlive();
    this.clearLocalSectionDepth();
    const transition = this.camera.clearLocalOrthographicFrame();
    this.applyCameraTransition(transition, durationMilliseconds);
  }

  private clearLocalSectionDepth(): void {
    if (!this.localSectionDepthActive) return;
    this.viewer.setScopedClipVolume(LOCAL_SECTION_CLIP_SCOPE, null);
    this.localSectionDepthActive = false;
  }

  private applyCameraTransition(
    transition: KernelCameraTransitionPair | null,
    durationMilliseconds: number,
  ): void {
    this.transitionGeneration += 1;
    if (this.transitionInteracting) {
      this.transitionInteracting = false;
      this.reportInteraction();
    }
    if (!transition) return;
    const generation = this.transitionGeneration;
    const origin = this.camera.recommendedFloatingOrigin();
    if (!Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) {
      this.viewer.setWorldCamera(transition.to, origin);
      this.callbacks.onCameraChanged?.(transition.to);
      this.callbacks.requestFrame?.();
      return;
    }
    this.transitionInteracting = true;
    this.reportInteraction();
    const start = performance.now();
    const frame = (timestamp: number): void => {
      if (this.disposed || generation !== this.transitionGeneration) return;
      const progress = Math.min(1, Math.max(0, (timestamp - start) / durationMilliseconds));
      this.viewer.setCameraTransition(transition.from, transition.to, progress, origin);
      this.callbacks.requestFrame?.();
      if (progress < 1) requestAnimationFrame(frame);
      else {
        this.viewer.setWorldCamera(transition.to, origin);
        this.callbacks.onCameraChanged?.(transition.to);
        this.transitionInteracting = false;
        this.reportInteraction();
      }
    };
    requestAnimationFrame(frame);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transitionGeneration += 1;
    if (this.wheelInteractionTimer !== null) clearTimeout(this.wheelInteractionTimer);
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
    if (this.disposed) return;
    this.canvas.focus({ preventScroll: true });
    this.dragMode = event.button === 0 && !this.camera.isOrthographicView() ? 'orbit' : 'pan';
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
      this.dragMode = null;
      return;
    }
    if (event.button === 1) event.preventDefault();
    this.dragPivot = this.cursorCoordinate;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.movedDuringDrag = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointerInteracting = true;
    this.reportInteraction();
    this.queuePick(event.clientX, event.clientY);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.disposed) return;
    this.queuePick(event.clientX, event.clientY);
    if (!this.dragMode) return;
    const deltaX = clamp(event.clientX - this.lastClientX, -480, 480);
    const deltaY = clamp(event.clientY - this.lastClientY, -480, 480);
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.movedDuringDrag ||= Math.abs(deltaX) + Math.abs(deltaY) > 1;
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
    if (this.disposed) return;
    this.dragMode = null;
    this.dragPivot = null;
    this.pointerInteracting = false;
    this.reportInteraction();
    if (!this.movedDuringDrag) this.queuePick(event.clientX, event.clientY);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.disposed) return;
    event.preventDefault();
    this.wheelInteracting = true;
    this.reportInteraction();
    if (this.wheelInteractionTimer !== null) clearTimeout(this.wheelInteractionTimer);
    this.wheelInteractionTimer = setTimeout(() => {
      this.wheelInteractionTimer = null;
      if (this.disposed) return;
      this.wheelInteracting = false;
      this.reportInteraction();
    }, 120);
    const factor = Math.pow(1.0015, clamp(event.deltaY, -2_000, 2_000));
    const anchor = this.cursorCoordinate;
    if (anchor) this.camera.zoomAt(factor, anchor);
    else this.camera.zoom(factor);
    this.uploadCamera();
    this.queuePick(event.clientX, event.clientY);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || this.candidates.length === 0) return;
    event.preventDefault();
    this.cycleCandidate(event.shiftKey ? -1 : 1);
  };

  private readonly preventDefault = (event: Event): void => event.preventDefault();
  private readonly preventMiddleDefault = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  private queuePick(clientX: number, clientY: number): void {
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
      if (!this.disposed && position) {
        const result = await this.viewer.pick(position[0], position[1], 4);
        if (!this.disposed && !result.stale && position === this.latestPickPosition) {
          this.candidates = result.candidates;
          const nearestIndex = nearestCandidateIndex(this.candidates);
          if (nearestIndex >= 0) {
            this.activateCandidate(nearestIndex);
          } else {
            this.activeCandidateIndex = 0;
            const ndc = this.physicalPointerNdc(position[0], position[1]);
            this.cursorCoordinate = this.camera.worldPointOnTargetPlane(ndc[0], ndc[1]);
            this.callbacks.onCursorCoordinate?.(this.cursorCoordinate, 'targetPlane');
            this.callbacks.onActivePick?.(null, 0, 0);
          }
        }
      }
    } finally {
      this.pickPending = false;
      if (!this.disposed && this.pickAgain) {
        this.pickPending = true;
        requestAnimationFrame(() => void this.executePick());
      }
    }
  }

  private uploadCamera(): void {
    const camera = this.camera.worldCamera();
    this.viewer.setWorldCamera(camera, this.camera.recommendedFloatingOrigin());
    this.callbacks.onCameraChanged?.(camera);
    this.callbacks.requestFrame?.();
  }

  private activateCandidate(index: number): KernelPickCandidate | null {
    const candidate = this.candidates[index] ?? null;
    if (!candidate) return null;
    this.activeCandidateIndex = index;
    this.cursorCoordinate = candidate.worldPosition;
    this.callbacks.onCursorCoordinate?.(candidate.worldPosition, 'geometry');
    this.callbacks.onActivePick?.(candidate, index, this.candidates.length);
    return candidate;
  }

  private reportInteraction(): void {
    const interacting =
      this.pointerInteracting || this.wheelInteracting || this.transitionInteracting;
    if (interacting === this.reportedInteracting) return;
    this.reportedInteracting = interacting;
    this.callbacks.onInteractionChanged?.(interacting);
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
  }
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
