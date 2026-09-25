import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export type Vec3 = readonly [number, number, number];

export interface ScenePolyline {
  readonly id: string;
  readonly points: readonly Vec3[];
  readonly closed: boolean;
  readonly visible: boolean;
}

export interface CameraPose {
  readonly target: Vec3;
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
}

export type NavMode = '3d' | '2.5d' | '2d';

export interface ViewportHandle {
  frameAll(): void;
  topView(): void;
  setPose(pose: CameraPose): void;
  pose(): CameraPose;
  frameSelection(points: readonly Vec3[]): void;
}

export interface CloudData {
  readonly count: number;
  readonly xyz: Float32Array;
  readonly rgb: Uint8Array;
  readonly heightAt: (x: number, y: number) => number;
}

interface ViewportProps {
  readonly cloud: CloudData | null;
  readonly cloudVisible: boolean;
  readonly cloudSelected: boolean;
  readonly theme: 'dark' | 'light';
  readonly navMode: NavMode;
  readonly polylines: readonly ScenePolyline[];
  readonly selectedId: string | null;
  readonly previews: readonly (readonly Vec3[])[];
  readonly onPick: (id: string | null) => void;
  readonly onContextMenu: (x: number, y: number, pickedId: string | null) => void;
  readonly onPointerDownAnywhere: () => void;
}

const CLOUD_ID = 'cloud';
const DEFAULT_POSE: CameraPose = { target: [0, 0, 6], distance: 230, yaw: -2.2, pitch: 0.62 };

export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const glState = useRef<GlState | null>(null);
  const pose = useRef<CameraPose>(DEFAULT_POSE);
  const animation = useRef<{ from: CameraPose; to: CameraPose; start: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const dirty = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;

  const requestRender = useCallback(() => {
    dirty.current = true;
  }, []);

  const animateTo = useCallback((to: CameraPose) => {
    animation.current = { from: pose.current, to, start: performance.now() };
    dirty.current = true;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      frameAll: () =>
        animateTo({
          ...DEFAULT_POSE,
          pitch: clampPitch(DEFAULT_POSE.pitch, propsRef.current.navMode),
        }),
      topView: () => animateTo({ ...pose.current, pitch: 1.5697, yaw: -Math.PI / 2 }),
      setPose: (next) => animateTo(next),
      pose: () => pose.current,
      frameSelection: (points) => {
        if (points.length === 0) return;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const p of points) {
          for (let i = 0; i < 3; i += 1) {
            min[i] = Math.min(min[i]!, p[i]!);
            max[i] = Math.max(max[i]!, p[i]!);
          }
        }
        const size = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, 8);
        animateTo({
          ...pose.current,
          target: [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2],
          distance: size * 1.6,
        });
      },
    }),
    [animateTo],
  );

  // Navigation mode changes the allowed pitch.
  useEffect(() => {
    const target = clampPitch(pose.current.pitch, props.navMode);
    if (props.navMode === '2d') animateTo({ ...pose.current, pitch: 1.5697 });
    else if (target !== pose.current.pitch) animateTo({ ...pose.current, pitch: target });
    else requestRender();
  }, [props.navMode, animateTo, requestRender]);

  useEffect(() => {
    requestRender();
  }, [
    props.cloudVisible,
    props.cloudSelected,
    props.theme,
    props.polylines,
    props.selectedId,
    props.previews,
    requestRender,
  ]);

  // GL setup + cloud upload.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) return;
    glState.current = createGlState(gl);
    requestRender();
    return () => {
      glState.current = null;
    };
  }, [requestRender]);

  useEffect(() => {
    const state = glState.current;
    if (!state || !props.cloud) return;
    uploadCloud(state, props.cloud);
    requestRender();
  }, [props.cloud, requestRender]);

  // Render loop (on demand).
  useEffect(() => {
    let handle = 0;
    const loop = (now: number) => {
      handle = requestAnimationFrame(loop);
      const anim = animation.current;
      if (anim) {
        const t = Math.min(1, (now - anim.start) / 420);
        const e = 1 - Math.pow(1 - t, 3);
        pose.current = lerpPose(anim.from, anim.to, e);
        dirty.current = true;
        if (t >= 1) animation.current = null;
      }
      const canvas = canvasRef.current;
      const host = hostRef.current;
      const state = glState.current;
      if (!canvas || !host || !state) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(host.clientWidth * dpr));
      const height = Math.max(1, Math.round(host.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        dirty.current = true;
      }
      if (!dirty.current) return;
      dirty.current = false;
      const p = propsRef.current;
      const mvp = viewProjection(pose.current, width / height);
      drawCloud(state, mvp, p.theme, p.cloudVisible && p.cloud !== null, p.cloudSelected, dpr);
      setFrame((value) => value + 1);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, []);

  // ---- Input -------------------------------------------------------------
  const pointers = useRef(
    new Map<number, { x: number; y: number; type: string; button: number }>(),
  );
  const gesture = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
    longPress: number | null;
    pinchDistance: number;
    midX: number;
    midY: number;
    button: number;
  } | null>(null);

  const pickAt = useCallback((clientX: number, clientY: number, touch: boolean): string | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const mvp = viewProjection(pose.current, rect.width / rect.height);
    const tolerance = touch ? 20 : 9;
    let best: { id: string; d: number } | null = null;
    for (const line of propsRef.current.polylines) {
      if (!line.visible) continue;
      const screen = line.points.map((pt) => project(mvp, pt, rect.width, rect.height));
      const count = line.closed ? screen.length : screen.length - 1;
      for (let i = 0; i < count; i += 1) {
        const a = screen[i];
        const b = screen[(i + 1) % screen.length];
        if (!a || !b) continue;
        const d = segmentDistance(x, y, a, b);
        if (d < tolerance && (!best || d < best.d)) best = { id: line.id, d };
      }
    }
    // The cloud covers the whole view, so it is selected from the layer panel only;
    // a tap into the cloud clears the selection like a tap into empty space.
    if (best) return best.id;
    return null;
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    props.onPointerDownAnywhere();
    const host = hostRef.current;
    if (!host) return;
    host.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
      button: event.button,
    });
    animation.current = null;
    if (pointers.current.size === 1) {
      const longPress =
        event.pointerType === 'mouse'
          ? null
          : window.setTimeout(() => {
              const g = gesture.current;
              if (g && !g.moved) {
                const picked = pickAt(g.startX, g.startY, true);
                propsRef.current.onContextMenu(g.startX, g.startY, picked);
                gesture.current = null;
                pointers.current.clear();
              }
            }, 520);
      gesture.current = {
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        longPress,
        pinchDistance: 0,
        midX: event.clientX,
        midY: event.clientY,
        button: event.button,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (gesture.current && a && b) {
        if (gesture.current.longPress) window.clearTimeout(gesture.current.longPress);
        gesture.current.longPress = null;
        gesture.current.moved = true;
        gesture.current.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        gesture.current.midX = (a.x + b.x) / 2;
        gesture.current.midY = (a.y + b.y) / 2;
      }
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    const g = gesture.current;
    if (!previous || !g) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    pointers.current.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
    if (!g.moved && Math.hypot(event.clientX - g.startX, event.clientY - g.startY) > 6) {
      g.moved = true;
      if (g.longPress) window.clearTimeout(g.longPress);
      g.longPress = null;
    }
    if (!g.moved) return;
    const host = hostRef.current;
    const height = host?.clientHeight ?? 800;
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (g.pinchDistance > 0) zoomBy(g.pinchDistance / Math.max(1, distance));
      pan(midX - g.midX, midY - g.midY, height);
      g.pinchDistance = distance;
      g.midX = midX;
      g.midY = midY;
      return;
    }
    const panMode =
      propsRef.current.navMode === '2d' || g.button === 1 || g.button === 2 || event.shiftKey;
    if (panMode) pan(dx, dy, height);
    else orbit(dx, dy);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    pointers.current.delete(event.pointerId);
    if (!g) return;
    if (g.longPress) window.clearTimeout(g.longPress);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (g.moved) return;
    const touch = event.pointerType !== 'mouse';
    const picked = pickAt(event.clientX, event.clientY, touch);
    if (g.button === 2) {
      propsRef.current.onContextMenu(event.clientX, event.clientY, picked);
    } else {
      propsRef.current.onPick(picked);
    }
  };

  const orbit = (dx: number, dy: number) => {
    const current = pose.current;
    pose.current = {
      ...current,
      yaw: current.yaw - dx * 0.006,
      pitch: clampPitch(current.pitch + dy * 0.005, propsRef.current.navMode),
    };
    requestRender();
  };

  const pan = (dx: number, dy: number, height: number) => {
    const current = pose.current;
    const scale = (current.distance * 2 * Math.tan(FOV / 2)) / height;
    // Grab-the-ground panning: right follows the screen x axis, forward is the
    // horizontal view direction (screen up in a top view).
    const right: Vec3 = [-Math.sin(current.yaw), Math.cos(current.yaw), 0];
    const forward: Vec3 = [-Math.cos(current.yaw), -Math.sin(current.yaw), 0];
    const k = 1 / Math.max(0.35, Math.sin(current.pitch));
    pose.current = {
      ...current,
      target: [
        current.target[0] - right[0] * dx * scale + forward[0] * dy * scale * k,
        current.target[1] - right[1] * dx * scale + forward[1] * dy * scale * k,
        current.target[2],
      ],
    };
    requestRender();
  };

  const zoomBy = (factor: number) => {
    const current = pose.current;
    pose.current = { ...current, distance: Math.min(900, Math.max(4, current.distance * factor)) };
    requestRender();
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host) return;
    const factor = Math.exp(event.deltaY * 0.0012);
    const rect = host.getBoundingClientRect();
    const current = pose.current;
    const hit = groundHit(current, rect, event.clientX, event.clientY);
    const next = Math.min(900, Math.max(4, current.distance * factor));
    const k = 1 - next / current.distance;
    pose.current = {
      ...current,
      distance: next,
      target: hit
        ? [
            current.target[0] + (hit[0] - current.target[0]) * k,
            current.target[1] + (hit[1] - current.target[1]) * k,
            current.target[2],
          ]
        : current.target,
    };
    requestRender();
  };

  // ---- Overlay -----------------------------------------------------------
  const host = hostRef.current;
  const width = host?.clientWidth ?? 1;
  const height = host?.clientHeight ?? 1;
  const mvp = viewProjection(pose.current, width / Math.max(1, height));
  void frame;
  const toPath = (points: readonly Vec3[], closed: boolean) => {
    const parts: string[] = [];
    let pen = false;
    for (const point of points) {
      const s = project(mvp, point, width, height);
      if (!s) {
        pen = false;
        continue;
      }
      parts.push(`${pen ? 'L' : 'M'}${s[0].toFixed(1)} ${s[1].toFixed(1)}`);
      pen = true;
    }
    if (closed && parts.length > 2) parts.push('Z');
    return parts.join(' ');
  };

  return (
    <div
      ref={hostRef}
      className="lab-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="lab-canvas" />
      <svg className="lab-overlay" width={width} height={height}>
        {props.polylines
          .filter((line) => line.visible)
          .map((line) => {
            const d = toPath(line.points, line.closed);
            const selected = line.id === props.selectedId;
            return (
              <g key={line.id}>
                {selected && <path d={d} className="lab-line-halo" />}
                <path d={d} className={selected ? 'lab-line lab-line-selected' : 'lab-line'} />
                {selected &&
                  line.points.map((point, index) => {
                    const s = project(mvp, point, width, height);
                    return s ? (
                      <circle key={index} cx={s[0]} cy={s[1]} r={3.5} className="lab-vertex" />
                    ) : null;
                  })}
              </g>
            );
          })}
        {props.previews.map((points, index) => (
          <path key={`preview-${index}`} d={toPath(points, false)} className="lab-line-preview" />
        ))}
      </svg>
    </div>
  );
});

// ---- Camera math -----------------------------------------------------------
const FOV = (50 * Math.PI) / 180;

function clampPitch(pitch: number, mode: NavMode): number {
  if (mode === '2d') return 1.5697;
  const min = mode === '2.5d' ? 0.35 : 0.05;
  return Math.min(1.5697, Math.max(min, pitch));
}

function eyeOf(pose: CameraPose): Vec3 {
  const cp = Math.cos(pose.pitch);
  return [
    pose.target[0] + pose.distance * cp * Math.cos(pose.yaw),
    pose.target[1] + pose.distance * cp * Math.sin(pose.yaw),
    pose.target[2] + pose.distance * Math.sin(pose.pitch),
  ];
}

function viewProjection(pose: CameraPose, aspect: number): Float32Array {
  const eye = eyeOf(pose);
  const up: Vec3 = pose.pitch > 1.56 ? [-Math.cos(pose.yaw), -Math.sin(pose.yaw), 0] : [0, 0, 1];
  const view = lookAt(eye, pose.target, up);
  const proj = perspective(FOV, aspect, Math.max(0.5, pose.distance * 0.01), pose.distance * 20);
  return multiply(proj, view);
}

function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  let dyaw = b.yaw - a.yaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  return {
    target: [
      a.target[0] + (b.target[0] - a.target[0]) * t,
      a.target[1] + (b.target[1] - a.target[1]) * t,
      a.target[2] + (b.target[2] - a.target[2]) * t,
    ],
    distance: a.distance * Math.pow(b.distance / a.distance, t),
    yaw: a.yaw + dyaw * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
  };
}

function groundHit(pose: CameraPose, rect: DOMRect, clientX: number, clientY: number): Vec3 | null {
  const mvp = viewProjection(pose, rect.width / rect.height);
  const inv = invert(mvp);
  if (!inv) return null;
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
  const near = transform(inv, [nx, ny, -1]);
  const far = transform(inv, [nx, ny, 1]);
  const dz = far[2] - near[2];
  if (Math.abs(dz) < 1e-9) return null;
  const t = (pose.target[2] - near[2]) / dz;
  if (t < 0) return null;
  return [near[0] + (far[0] - near[0]) * t, near[1] + (far[1] - near[1]) * t, pose.target[2]];
}

function project(m: Float32Array, p: Vec3, width: number, height: number): [number, number] | null {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  if (w <= 0.01) return null;
  return [((x / w + 1) / 2) * width, ((1 - y / w) / 2) * height];
}

function transform(m: Float32Array, p: Vec3): Vec3 {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!;
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  return [x / w, y / w, z / w];
}

function segmentDistance(x: number, y: number, a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len));
  return Math.hypot(x - (a[0] + vx * t), y - (a[1] + vy * t));
}

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function invert(m: Float32Array): Float32Array | null {
  const inv = new Float32Array(16);
  const a = m;
  inv[0] =
    a[5]! * a[10]! * a[15]! -
    a[5]! * a[11]! * a[14]! -
    a[9]! * a[6]! * a[15]! +
    a[9]! * a[7]! * a[14]! +
    a[13]! * a[6]! * a[11]! -
    a[13]! * a[7]! * a[10]!;
  inv[4] =
    -a[4]! * a[10]! * a[15]! +
    a[4]! * a[11]! * a[14]! +
    a[8]! * a[6]! * a[15]! -
    a[8]! * a[7]! * a[14]! -
    a[12]! * a[6]! * a[11]! +
    a[12]! * a[7]! * a[10]!;
  inv[8] =
    a[4]! * a[9]! * a[15]! -
    a[4]! * a[11]! * a[13]! -
    a[8]! * a[5]! * a[15]! +
    a[8]! * a[7]! * a[13]! +
    a[12]! * a[5]! * a[11]! -
    a[12]! * a[7]! * a[9]!;
  inv[12] =
    -a[4]! * a[9]! * a[14]! +
    a[4]! * a[10]! * a[13]! +
    a[8]! * a[5]! * a[14]! -
    a[8]! * a[6]! * a[13]! -
    a[12]! * a[5]! * a[10]! +
    a[12]! * a[6]! * a[9]!;
  inv[1] =
    -a[1]! * a[10]! * a[15]! +
    a[1]! * a[11]! * a[14]! +
    a[9]! * a[2]! * a[15]! -
    a[9]! * a[3]! * a[14]! -
    a[13]! * a[2]! * a[11]! +
    a[13]! * a[3]! * a[10]!;
  inv[5] =
    a[0]! * a[10]! * a[15]! -
    a[0]! * a[11]! * a[14]! -
    a[8]! * a[2]! * a[15]! +
    a[8]! * a[3]! * a[14]! +
    a[12]! * a[2]! * a[11]! -
    a[12]! * a[3]! * a[10]!;
  inv[9] =
    -a[0]! * a[9]! * a[15]! +
    a[0]! * a[11]! * a[13]! +
    a[8]! * a[1]! * a[15]! -
    a[8]! * a[3]! * a[13]! -
    a[12]! * a[1]! * a[11]! +
    a[12]! * a[3]! * a[9]!;
  inv[13] =
    a[0]! * a[9]! * a[14]! -
    a[0]! * a[10]! * a[13]! -
    a[8]! * a[1]! * a[14]! +
    a[8]! * a[2]! * a[13]! +
    a[12]! * a[1]! * a[10]! -
    a[12]! * a[2]! * a[9]!;
  inv[2] =
    a[1]! * a[6]! * a[15]! -
    a[1]! * a[7]! * a[14]! -
    a[5]! * a[2]! * a[15]! +
    a[5]! * a[3]! * a[14]! +
    a[13]! * a[2]! * a[7]! -
    a[13]! * a[3]! * a[6]!;
  inv[6] =
    -a[0]! * a[6]! * a[15]! +
    a[0]! * a[7]! * a[14]! +
    a[4]! * a[2]! * a[15]! -
    a[4]! * a[3]! * a[14]! -
    a[12]! * a[2]! * a[7]! +
    a[12]! * a[3]! * a[6]!;
  inv[10] =
    a[0]! * a[5]! * a[15]! -
    a[0]! * a[7]! * a[13]! -
    a[4]! * a[1]! * a[15]! +
    a[4]! * a[3]! * a[13]! +
    a[12]! * a[1]! * a[7]! -
    a[12]! * a[3]! * a[5]!;
  inv[14] =
    -a[0]! * a[5]! * a[14]! +
    a[0]! * a[6]! * a[13]! +
    a[4]! * a[1]! * a[14]! -
    a[4]! * a[2]! * a[13]! -
    a[12]! * a[1]! * a[6]! +
    a[12]! * a[2]! * a[5]!;
  inv[3] =
    -a[1]! * a[6]! * a[11]! +
    a[1]! * a[7]! * a[10]! +
    a[5]! * a[2]! * a[11]! -
    a[5]! * a[3]! * a[10]! -
    a[9]! * a[2]! * a[7]! +
    a[9]! * a[3]! * a[6]!;
  inv[7] =
    a[0]! * a[6]! * a[11]! -
    a[0]! * a[7]! * a[10]! -
    a[4]! * a[2]! * a[11]! +
    a[4]! * a[3]! * a[10]! +
    a[8]! * a[2]! * a[7]! -
    a[8]! * a[3]! * a[6]!;
  inv[11] =
    -a[0]! * a[5]! * a[11]! +
    a[0]! * a[7]! * a[9]! +
    a[4]! * a[1]! * a[11]! -
    a[4]! * a[3]! * a[9]! -
    a[8]! * a[1]! * a[7]! +
    a[8]! * a[3]! * a[5]!;
  inv[15] =
    a[0]! * a[5]! * a[10]! -
    a[0]! * a[6]! * a[9]! -
    a[4]! * a[1]! * a[10]! +
    a[4]! * a[2]! * a[9]! +
    a[8]! * a[1]! * a[6]! -
    a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (Math.abs(det) < 1e-12) return null;
  for (let i = 0; i < 16; i += 1) inv[i] = inv[i]! / det;
  return inv;
}

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---- WebGL -----------------------------------------------------------------
interface GlState {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly uMvp: WebGLUniformLocation | null;
  readonly uSize: WebGLUniformLocation | null;
  readonly uTint: WebGLUniformLocation | null;
  count: number;
}

const VERTEX = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uMvp;
uniform float uSize;
uniform vec4 uTint;
out vec3 vColor;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  gl_PointSize = uSize;
  vColor = mix(aColor, uTint.rgb, uTint.a);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 color;
void main() { color = vec4(vColor, 1.0); }`;

function createGlState(gl: WebGL2RenderingContext): GlState {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  const vao = gl.createVertexArray()!;
  return {
    gl,
    program,
    vao,
    uMvp: gl.getUniformLocation(program, 'uMvp'),
    uSize: gl.getUniformLocation(program, 'uSize'),
    uTint: gl.getUniformLocation(program, 'uTint'),
    count: 0,
  };
}

function uploadCloud(state: GlState, cloud: CloudData): void {
  const { gl } = state;
  gl.bindVertexArray(state.vao);
  const positions = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positions);
  gl.bufferData(gl.ARRAY_BUFFER, cloud.xyz, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const colors = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colors);
  gl.bufferData(gl.ARRAY_BUFFER, cloud.rgb, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, 0, 0);
  gl.bindVertexArray(null);
  state.count = cloud.count;
}

function drawCloud(
  state: GlState,
  mvp: Float32Array,
  theme: 'dark' | 'light',
  visible: boolean,
  selected: boolean,
  dpr: number,
): void {
  const { gl } = state;
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  if (theme === 'dark') gl.clearColor(0.063, 0.067, 0.078, 1);
  else gl.clearColor(0.886, 0.898, 0.918, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!visible || state.count === 0) return;
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(state.program);
  gl.uniformMatrix4fv(state.uMvp, false, mvp);
  gl.uniform1f(state.uSize, 2.2 * dpr);
  gl.uniform4f(state.uTint, 1.0, 0.62, 0.11, selected ? 0.35 : 0);
  gl.bindVertexArray(state.vao);
  gl.drawArrays(gl.POINTS, 0, state.count);
  gl.bindVertexArray(null);
}

export async function loadCloud(url: string): Promise<CloudData> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`cloud sample missing (${response.status}) — run pnpm sample-cloud`);
  const buffer = await response.arrayBuffer();
  const header = new DataView(buffer, 0, 32);
  const count = header.getUint32(4, true);
  const xyz = new Float32Array(buffer, 32, count * 3);
  const rgb = new Uint8Array(buffer, 32 + count * 12, count * 3);
  // Coarse height grid for draping demo lines (2 m cells, median-ish mean).
  const cell = 2;
  const sums = new Map<string, [number, number]>();
  for (let i = 0; i < count; i += 1) {
    const key = `${Math.floor(xyz[i * 3]! / cell)}:${Math.floor(xyz[i * 3 + 1]! / cell)}`;
    const entry = sums.get(key);
    const z = xyz[i * 3 + 2]!;
    if (entry) {
      entry[0] = Math.min(entry[0], z);
      entry[1] += 1;
    } else sums.set(key, [z, 1]);
  }
  const heightAt = (x: number, y: number): number => {
    for (let r = 0; r < 4; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dy = -r; dy <= r; dy += 1) {
          const entry = sums.get(`${Math.floor(x / cell) + dx}:${Math.floor(y / cell) + dy}`);
          if (entry) return entry[0];
        }
      }
    }
    return 0;
  };
  return { count, xyz, rgb, heightAt };
}

export { CLOUD_ID };
