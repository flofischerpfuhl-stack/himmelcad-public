/**
 * Viewport glue for sketch mode, kept out of `Viewport.tsx`: animates the
 * camera normal to the sketch plane when a session starts (and back when it
 * ends), requests redraws on session changes, and provides the screen
 * mapping ({@link SketchViewApi}) the sketch overlay draws with.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';

import { framePoint, frameUv, type SketchFrame } from '../../foundation/document/document.js';
import { isPlanarFace, useAssemblerStore } from '../../foundation/commands/store.js';
import type { CameraPose } from '../../viewport/camera.js';
import { viewProjectionMatrix } from '../../viewport/camera.js';
import { projectToScreen, rayPlaneIntersect, type Vec3 } from '../../viewport/math.js';
import type { PickTarget } from '../../viewport/picking.js';
import { useSketchStore, type SketchSession } from '../session.js';
import { poseLookingAlong, sketchBounds, sketchViewDirection } from '../sketchCamera.js';
import type { Vec2 } from '../../foundation/sketch-solver/types.js';
import type { SketchViewApi } from './SketchOverlay.js';

export interface SketchViewportRefs {
  hostRef: MutableRefObject<HTMLDivElement | null>;
  poseRef: MutableRefObject<CameraPose>;
  animRef: MutableRefObject<{
    from: CameraPose;
    to: CameraPose;
    start: number;
    duration: number;
  } | null>;
  dirtyRef: MutableRefObject<boolean>;
  rayAtClient: (clientX: number, clientY: number) => { origin: Vec3; direction: Vec3 } | null;
  pickAt: (clientX: number, clientY: number) => PickTarget | null;
}

/** Camera pose looking straight at `frame` (fitting the sketch, or keeping the current focus). */
function enterPose(
  current: CameraPose,
  frame: SketchFrame,
  session: SketchSession | null,
): CameraPose {
  const bounds = session ? sketchBounds(session.sketch) : null;
  let center: Vec3;
  let distance = current.distance;
  if (bounds) {
    center = framePoint(
      frame,
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
    );
    const size = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
    distance = Math.max(80, size * 2.2);
  } else {
    // Keep looking at the same spot, moved onto the sketch plane.
    const t = current.target;
    const n = frame.normal;
    const d =
      (t[0] - frame.origin[0]) * n[0] +
      (t[1] - frame.origin[1]) * n[1] +
      (t[2] - frame.origin[2]) * n[2];
    center = [t[0] - n[0] * d, t[1] - n[1] * d, t[2] - n[2] * d];
  }
  const plane = session?.plane ?? { kind: 'plane' as const, plane: 'XY' as const, offset: 0 };
  // Keeps the projection (perspective/orthographic, field of view); the sketch view is never rolled.
  return {
    ...current,
    ...poseLookingAlong(sketchViewDirection(frame, plane), center, distance, frame.v),
    roll: 0,
  };
}

export function useSketchViewport(refs: SketchViewportRefs): {
  session: SketchSession | null;
  api: SketchViewApi;
} {
  const session = useSketchStore((s) => s.session);
  const camera = useSketchStore((s) => s.camera);
  const returnPoseRef = useRef<CameraPose | null>(null);
  const lastNonce = useRef<number | null>(null);
  const { hostRef, poseRef, animRef, dirtyRef, rayAtClient, pickAt } = refs;

  useEffect(() => {
    dirtyRef.current = true;
  }, [session, dirtyRef]);

  useEffect(() => {
    if (!camera || camera.nonce === lastNonce.current) return;
    lastNonce.current = camera.nonce;
    const current = poseRef.current;
    let next: CameraPose;
    if (camera.mode === 'enter') {
      returnPoseRef.current ??= current;
      next = enterPose(current, camera.frame, useSketchStore.getState().session);
    } else {
      next = returnPoseRef.current ?? current;
      returnPoseRef.current = null;
    }
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) poseRef.current = next;
    else animRef.current = { from: current, to: next, start: performance.now(), duration: 350 };
    dirtyRef.current = true;
  }, [camera, poseRef, animRef, dirtyRef]);

  const host = hostRef.current;
  const width = host?.clientWidth ?? 0;
  const height = host?.clientHeight ?? 0;
  // One view-projection matrix per camera pose (poses are replaced, never mutated): the
  // overlay maps every sampled curve point of a render, e.g. thousands for glyph outlines.
  let vpCache: { pose: CameraPose; vp: ReturnType<typeof viewProjectionMatrix> } | null = null;
  const api: SketchViewApi = {
    width,
    height,
    toScreen: (uv: Vec2) => {
      const s = useSketchStore.getState().session;
      if (!s || width === 0 || height === 0) return null;
      const pose = poseRef.current;
      if (vpCache?.pose !== pose) {
        vpCache = { pose, vp: viewProjectionMatrix(pose, width / Math.max(1, height)) };
      }
      const vp = vpCache.vp;
      const screen = projectToScreen(vp, framePoint(s.frame, uv[0], uv[1]), width, height);
      return screen ? [screen[0], screen[1]] : null;
    },
    fromClient: (clientX, clientY) => {
      const s = useSketchStore.getState().session;
      const ray = rayAtClient(clientX, clientY);
      if (!s || !ray) return null;
      const hit = rayPlaneIntersect(ray.origin, ray.direction, s.frame.origin, s.frame.normal);
      if (!hit) return null;
      const { u, v } = frameUv(s.frame, hit);
      return [u, v];
    },
    pickPlanarFace: (clientX, clientY) => {
      const pick = pickAt(clientX, clientY);
      if (pick?.kind !== 'face') return null;
      return isPlanarFace(useAssemblerStore.getState().evaluation, pick.bodyId, pick.faceKey)
        ? { bodyId: pick.bodyId, faceKey: pick.faceKey }
        : null;
    },
    pickBodyItem: (clientX, clientY) => {
      const pick = pickAt(clientX, clientY);
      if (pick?.kind === 'edge') return { kind: 'edge', bodyId: pick.bodyId, key: pick.edgeKey };
      if (pick?.kind === 'face') return { kind: 'face', bodyId: pick.bodyId, key: pick.faceKey };
      return null;
    },
  };
  return { session, api };
}
