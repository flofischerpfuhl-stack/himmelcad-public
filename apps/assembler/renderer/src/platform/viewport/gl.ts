/**
 * WebGL2 execution layer for the Assembler viewport. Pure "draw these
 * batches" executor — no knowledge of the store, selection, or tools. All
 * geometry is prepared on the CPU by `scene.ts` (`geometry.ts`,
 * `bodyGeometry.ts`); this module uploads and draws it.
 *
 * - Stable arrays (kernel meshes and data derived from them, see
 *   `bodyGeometry.ts#markStable`) are uploaded once and their GPU buffers
 *   kept while they are drawn; everything else streams through two dynamic
 *   buffers. Orbiting a 60-feature part therefore uploads almost nothing.
 * - Bodies draw indexed with a hemisphere + key/fill light model, material
 *   parameters (`displayModes.ts`), zebra or curvature analysis shading,
 *   and an optional screen-space ambient-occlusion term sampled from a
 *   half-resolution depth prepass (depth-only "unsharp masking" against the
 *   local plane — creases and contact areas darken, flat faces do not).
 * - Lines (edges, silhouettes, hidden dashed edges, highlights) are
 *   instanced screen-space quads with an anti-aliased profile: the same CSS
 *   pixel width at any device pixel ratio.
 * - Section caps use the stencil parity of each body (correct for several
 *   bodies, each in its own colour); a soft contact shadow is rendered from
 *   a small shadow map looking up at the bodies from the grid plane.
 * - The picking id pass is drawn lazily, only when something reads it.
 *
 * Not unit tested (requires a GL context); the pure inputs are.
 */
import type { MaterialParams } from './displayModes.js';
import { isStable } from './bodyGeometry.js';

type Vec3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];
export type RGBA = readonly [number, number, number, number];

export interface SectionClip {
  enabled: boolean;
  normal: readonly [number, number, number];
  offset: number;
}

export type Shading = 'lit' | 'zebra' | 'curvature';

export interface TriBatch {
  positions: Float32Array;
  normals: Float32Array;
  /** Indexed mesh (kernel bodies); absent = non-indexed triangle list. */
  indices?: Uint32Array;
  /** Per-vertex signed curvature, 1/mm (curvature shading). */
  curvature?: Float32Array;
  color: RGB;
  alpha: number;
  depthTest: boolean;
  depthWrite: boolean;
  polygonOffset: boolean;
  /** Surface response; default: the neutral "Shaded" material. */
  material?: MaterialParams;
  shading?: Shading;
}

export interface FlatBatch {
  /** 3 floats per vertex. */
  positions: Float32Array;
  /** 4 floats per vertex (rgba, 0..1). */
  colors: Float32Array;
  mode: 'lines' | 'triangles';
  depthTest: boolean;
  /** Ignore the section clip (grid, axes, tool handles, the section plane itself). */
  noClip?: boolean;
}

/** Anti-aliased screen-space lines, one instance per segment. */
export interface LineBatch {
  kind: 'lines';
  /** `x,y,z,x,y,z` per segment — or, with `silhouette`, `a, b, n1, n2` (12 floats). */
  segments: Float32Array;
  /** Segment range to draw (default: all). */
  first?: number;
  count?: number;
  color: RGBA;
  /** CSS pixels. */
  widthPx: number;
  depthTest: boolean;
  /** Draw only where the line is hidden behind geometry, dashed (hidden edges). */
  hiddenOnly?: boolean;
  /** Dash length, CSS px (0 = solid). */
  dashPx?: number;
  noClip?: boolean;
  /** Silhouette candidates: drawn only where one side faces the eye and the other away. */
  silhouette?: boolean;
}

/** A range of an indexed mesh in one colour (face highlights). */
export interface MeshRangeBatch {
  kind: 'meshRange';
  positions: Float32Array;
  indices: Uint32Array;
  firstTriangle: number;
  triangleCount: number;
  color: RGBA;
  depthTest: boolean;
  noClip?: boolean;
}

export type DrawBatch = FlatBatch | LineBatch | MeshRangeBatch;

export interface LegacyIdBatch {
  positions: Float32Array;
  id: number;
  mode: 'triangles' | 'lines';
  /** Drawn without depth test and without the section clip (tool handles win every pick). */
  onTop?: boolean;
}

/** Every face of a body in one draw: id = `baseId + faceIndex` (per vertex). */
export interface MeshIdBatch {
  kind: 'mesh';
  positions: Float32Array;
  indices: Uint32Array;
  localIndex: Float32Array;
  baseId: number;
}

/** Every edge of a body in one draw: id = `baseId + edgeIndex` (per segment). */
export interface LinesIdBatch {
  kind: 'lines';
  segments: Float32Array;
  localIndex: Float32Array;
  baseId: number;
  /** Hit width, CSS px. */
  widthPx: number;
  onTop?: boolean;
}

export type IdBatch = LegacyIdBatch | MeshIdBatch | LinesIdBatch;

/** Light rig in world space (derived from the camera each frame, see `scene.ts`). */
export interface Lighting {
  keyDir: Vec3;
  fillDir: Vec3;
  /** Camera basis, for view-anchored zebra stripes. */
  right: Vec3;
  up: Vec3;
  sky: RGB;
  ground: RGB;
}

export interface AmbientOcclusion {
  /** Sample radius, CSS px. */
  radiusPx: number;
  /** 0..1 darkening at full occlusion. */
  strength: number;
}

export interface GroundShadow {
  /** Height of the ground plane. */
  z: number;
  /** Footprint rectangle (XY) the shadow map covers. */
  min: readonly [number, number];
  max: readonly [number, number];
  /** Highest point of the casters (shadow map depth range). */
  top: number;
  casters: { positions: Float32Array; indices?: Uint32Array }[];
  /** Changes whenever the casters or their placement change (re-renders the shadow map). */
  key: string;
  strength: number;
  /** Alpha of a faint light pool under the part (dark themes), 0 = none. */
  pool?: number;
}

export interface SectionCaps {
  bodies: { positions: Float32Array; indices?: Uint32Array; color: RGB }[];
  /** A quad on the section plane covering every cut. */
  plane: readonly [Vec3, Vec3, Vec3, Vec3];
  hatch: boolean;
}

export interface SceneFrame {
  viewProj: Float32Array;
  cameraPosition: readonly [number, number, number];
  background: readonly [number, number, number];
  lit: TriBatch[];
  /** Grid and axes: drawn after the bodies, under the contact shadow. */
  underlay?: DrawBatch[];
  flat: DrawBatch[];
  clip: SectionClip;
  /** Device pixels per CSS pixel (line widths). Default 1. */
  pxScale?: number;
  /** Clip planes of `viewProj` (AO depth linearisation). */
  depth?: {
    near: number;
    far: number;
    orthographic: boolean;
    worldPerPxAt1: number;
    /** Clip-space z offset pulling lines in front of the faces they lie on. */
    lineBias: number;
  };
  lighting?: Lighting;
  ao?: AmbientOcclusion | null;
  shadow?: GroundShadow | null;
  caps?: SectionCaps | null;
  /** Curvature map radius range, mm. */
  curvatureRange?: { min: number; max: number };
  /** Zebra stripe count over the half sphere. */
  zebraStripes?: number;
}

interface Program {
  program: WebGLProgram;
  attribs: Record<string, number>;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info ?? 'unknown'}`);
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
  attribNames: string[],
): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    throw new Error(`Program link error: ${info ?? 'unknown'}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const attribs: Record<string, number> = {};
  for (const name of attribNames) attribs[name] = gl.getAttribLocation(program, name);
  return { program, attribs, uniforms: new Map() };
}

// ---- shaders ---------------------------------------------------------------------------------

const CLIP_VS = `
uniform vec3 uClipNormal;
uniform float uClipOffset;
uniform bool uClipEnabled;
float clipDistance(vec3 p) { return uClipEnabled ? dot(p, uClipNormal) - uClipOffset : -1.0; }
`;

const LIT_VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
in float aCurvature;
uniform mat4 uViewProj;
${CLIP_VS}
out vec3 vNormal;
out vec3 vWorld;
out float vClip;
out float vCurvature;
void main() {
  vClip = clipDistance(aPosition);
  vNormal = aNormal;
  vWorld = aPosition;
  vCurvature = aCurvature;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const LIT_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in float vClip;
in float vCurvature;
uniform vec3 uColor;
uniform float uAlpha;
uniform bool uClipEnabled;
uniform vec3 uEye;
uniform bool uOrtho;
uniform vec3 uViewDir;
uniform vec3 uKeyDir;
uniform vec3 uFillDir;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uRoughness;
uniform float uSpecular;
uniform float uMetalness;
uniform float uClearcoat;
uniform float uWrap;
uniform int uShading;
uniform float uZebra;
uniform vec2 uCurvRange;
uniform bool uAo;
uniform highp sampler2D uDepthTex;
uniform vec2 uViewportPx;
uniform float uAoRadiusPx;
uniform float uAoStrength;
uniform float uNear;
uniform float uFar;
uniform float uWorldPerPxAt1;
out vec4 outColor;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  if (uOrtho) return 0.5 * (z * (uFar - uNear) + uFar + uNear);
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

// Depth-buffer unsharp masking: darkens where neighbours are nearer than the
// fragment's own tangent plane predicts (creases, contact, deep holes).
float ambientOcclusion() {
  vec2 uv = gl_FragCoord.xy / uViewportPx;
  float d0 = linearDepth(gl_FragCoord.z);
  float q0 = uOrtho ? d0 : 1.0 / d0;
  float qx = dFdx(q0);
  float qy = dFdy(q0);
  float worldR = uAoRadiusPx * uWorldPerPxAt1 * (uOrtho ? 1.0 : d0);
  float angle = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float occ = 0.0;
  vec2 aoSize = vec2(textureSize(uDepthTex, 0));
  for (int i = 0; i < 8; i++) {
    float a = angle + float(i) * 2.3999632;
    float r = uAoRadiusPx * (0.25 + 0.75 * fract(float(i) * 0.618034 + 0.31));
    // Snap to the centre of the (half-resolution) texel actually read, so the
    // tangent-plane prediction below is evaluated at the same place.
    vec2 st = (floor((uv + vec2(cos(a), sin(a)) * r / uViewportPx) * aoSize) + 0.5) / aoSize;
    vec2 o = (st - uv) * uViewportPx;
    float ds = linearDepth(texture(uDepthTex, st).r);
    float qp = q0 + qx * o.x + qy * o.y;
    float dp = uOrtho ? qp : 1.0 / max(qp, 1e-9);
    float dz = dp - ds;
    occ += clamp(dz / worldR, 0.0, 1.0) * (1.0 - smoothstep(2.0 * worldR, 5.0 * worldR, dz));
  }
  return 1.0 - uAoStrength * occ / 8.0;
}

vec3 curvatureColor(float k) {
  float m = abs(k);
  vec3 flatC = vec3(0.55, 0.62, 0.55);
  if (m < 1e-9) return flatC;
  float t = clamp((uCurvRange.y - log(1.0 / m) / log(10.0)) / (uCurvRange.y - uCurvRange.x), 0.0, 1.0);
  vec3 mid = k > 0.0 ? vec3(0.95, 0.85, 0.25) : vec3(0.25, 0.8, 0.9);
  vec3 strong = k > 0.0 ? vec3(0.9, 0.2, 0.15) : vec3(0.15, 0.3, 0.9);
  return t < 0.5 ? mix(flatC, mid, t * 2.0) : mix(mid, strong, (t - 0.5) * 2.0);
}

void main() {
  if (vClip > 0.0) discard;
  vec3 n = normalize(vNormal);
  vec3 v = uOrtho ? uViewDir : normalize(uEye - vWorld);
  if (!gl_FrontFacing) {
    // Inside of a body seen through a cut that has no cap (open shells): flat and dark.
    if (uClipEnabled) { outColor = vec4(uColor * 0.42, uAlpha); return; }
    n = -n;
  }
  float ao = uAo ? ambientOcclusion() : 1.0;
  if (uShading == 1) {
    // Zebra: parallel light bars reflected in the surface, fixed to the view.
    vec3 r = reflect(-v, n);
    float s = asin(clamp(dot(r, uUp), -1.0, 1.0)) / 3.14159265 * uZebra;
    float w = fwidth(s) * 1.2;
    float stripe = smoothstep(0.5 - w, 0.5 + w, abs(fract(s) - 0.5) * 2.0);
    vec3 c = mix(vec3(0.06), vec3(0.95), stripe);
    float lambert = 0.8 + 0.2 * max(dot(n, v), 0.0);
    outColor = vec4(c * lambert * ao, uAlpha);
    return;
  }
  vec3 base = toLinear(uShading == 2 ? curvatureColor(vCurvature) : uColor);
  float rough = clamp(uRoughness, 0.04, 1.0);
  float shininess = mix(900.0, 6.0, rough);
  float ndv = max(dot(n, v), 0.0);
  float fresnel = pow(1.0 - ndv, 5.0);
  // Hemisphere ambient (sky above, warm ground bounce below).
  vec3 hemi = mix(toLinear(uGround), toLinear(uSky), n.z * 0.5 + 0.5);
  float keyN = dot(n, uKeyDir);
  float keyDiff = max((keyN + uWrap) / (1.0 + uWrap), 0.0);
  float fillDiff = max(dot(n, uFillDir), 0.0);
  vec3 h = normalize(uKeyDir + v);
  float spec = pow(max(dot(n, h), 0.0), shininess) * (shininess + 8.0) / 64.0;
  spec *= keyN > 0.0 ? 1.0 : 0.0;
  vec3 diffuseColor = base * (1.0 - uMetalness * 0.85);
  vec3 specColor = mix(vec3(0.04 + 0.2 * uSpecular), base, uMetalness);
  vec3 color = diffuseColor * (hemi * 0.42 + keyDiff * vec3(0.72) + fillDiff * vec3(0.22));
  color += specColor * spec * (0.25 + uSpecular) * 0.9;
  // Environment reflection for metals and glossy coats: the same hemisphere.
  vec3 r = reflect(-v, n);
  vec3 env = mix(toLinear(uGround), toLinear(uSky) * 1.3, smoothstep(-0.2, 0.4, r.z));
  color += env * base * uMetalness * mix(0.9, 0.35, rough);
  color += env * (fresnel * 0.6 + 0.04) * uClearcoat;
  vec3 hc = normalize(uKeyDir + v);
  color += vec3(pow(max(dot(n, hc), 0.0), 350.0)) * uClearcoat * 1.4;
  color += base * fresnel * 0.08;
  color *= ao;
  outColor = vec4(toSrgb(color), uAlpha);
}`;

const FLAT_VS = `#version 300 es
in vec3 aPosition;
in vec4 aColor;
uniform mat4 uViewProj;
${CLIP_VS}
out vec4 vColor;
out float vClip;
void main() {
  vClip = clipDistance(aPosition);
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const FLAT_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
in float vClip;
out vec4 outColor;
void main() {
  if (vClip > 0.0) discard;
  outColor = vColor;
}`;

/** Uniform colour (face highlights, caps, depth-only passes). */
const SOLID_VS = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProj;
${CLIP_VS}
out float vClip;
void main() {
  vClip = clipDistance(aPosition);
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision mediump float;
in float vClip;
uniform vec4 uColor;
uniform bool uHatch;
uniform float uPxScale;
out vec4 outColor;
void main() {
  if (vClip > 0.0) discard;
  vec4 c = uColor;
  if (uHatch) {
    // Thin 45° hatch lines every 8 CSS px, anti-aliased.
    float s = (gl_FragCoord.x + gl_FragCoord.y) / (8.0 * uPxScale);
    float d = abs(fract(s) - 0.5) * 8.0 * uPxScale * 0.7071;
    float line = 1.0 - smoothstep(0.35 * uPxScale, 0.35 * uPxScale + 1.0, d);
    c.rgb *= mix(1.0, 0.84, line);
  }
  outColor = c;
}`;

/** Instanced screen-space line quads (defines select the variant). */
function lineVs(variant: 'color' | 'silhouette' | 'pick'): string {
  return `#version 300 es
in vec2 aCorner;
in vec3 aA;
in vec3 aB;
${variant === 'silhouette' ? 'in vec3 aN1;\nin vec3 aN2;' : ''}
${variant === 'pick' ? 'in float aLocal;\nout float vLocal;' : ''}
uniform mat4 uViewProj;
uniform vec2 uViewportPx;
uniform float uWidthPx;
uniform float uDepthBias;
uniform vec3 uEye;
uniform bool uOrtho;
uniform vec3 uViewDir;
${CLIP_VS}
out float vClip;
out vec2 vSideW;
out vec2 vAlongW;
out float vHalf;
void main() {
  ${
    variant === 'silhouette'
      ? `vec3 mid = (aA + aB) * 0.5;
  vec3 toEye = uOrtho ? uViewDir : uEye - mid;
  if (dot(aN1, toEye) * dot(aN2, toEye) > 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }`
      : ''
  }
  ${variant === 'pick' ? 'vLocal = aLocal;' : ''}
  vec4 ca = uViewProj * vec4(aA, 1.0);
  vec4 cb = uViewProj * vec4(aB, 1.0);
  float eps = 1e-5;
  if (ca.w < eps && cb.w < eps) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (ca.w < eps) ca = mix(ca, cb, (eps - ca.w) / (cb.w - ca.w));
  else if (cb.w < eps) cb = mix(cb, ca, (eps - cb.w) / (ca.w - cb.w));
  vec2 half_ = uViewportPx * 0.5;
  vec2 sa = ca.xy / ca.w * half_;
  vec2 sb = cb.xy / cb.w * half_;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = uWidthPx * 0.5 + 1.0;
  bool atB = aCorner.x > 0.5;
  vec4 c = atB ? cb : ca;
  vec2 s = (atB ? sb : sa) + nrm * aCorner.y * hw + dir * (atB ? hw : -hw);
  vClip = clipDistance(atB ? aB : aA);
  float along = atB ? len + hw : -hw;
  // Screen-linear varyings (no noperspective in GLSL ES): interpolate x·w and w.
  vSideW = vec2(aCorner.y * hw * c.w, c.w);
  vAlongW = vec2(along * c.w, c.w);
  vHalf = uWidthPx * 0.5;
  // A constant clip-space z offset is a constant *relative* depth offset in
  // perspective (and a constant one in orthographic views): see scene.ts.
  gl_Position = vec4(s / half_ * c.w, c.z - uDepthBias, c.w);
}`;
}

const LINE_FS = `#version 300 es
precision highp float;
in float vClip;
in vec2 vSideW;
in vec2 vAlongW;
in float vHalf;
uniform vec4 uColor;
uniform float uDashPx;
out vec4 outColor;
void main() {
  if (vClip > 0.0) discard;
  float side = abs(vSideW.x / vSideW.y);
  float coverage = clamp(vHalf + 0.5 - side, 0.0, 1.0);
  if (uDashPx > 0.0) {
    float along = vAlongW.x / vAlongW.y;
    if (mod(along, uDashPx * 2.0) > uDashPx) discard;
  }
  if (coverage <= 0.0) discard;
  outColor = vec4(uColor.rgb, uColor.a * coverage);
}`;

const ID_ENCODE = `
vec4 encodeId(float id) {
  return vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), mod(floor(id / 65536.0), 256.0), floor(id / 16777216.0)) / 255.0;
}`;

const LINE_PICK_FS = `#version 300 es
precision highp float;
in float vClip;
in vec2 vSideW;
in vec2 vAlongW;
in float vHalf;
in float vLocal;
uniform float uBase;
out vec4 outColor;
${ID_ENCODE}
void main() {
  if (vClip > 0.0) discard;
  if (abs(vSideW.x / vSideW.y) > vHalf) discard;
  outColor = encodeId(uBase + floor(vLocal + 0.5));
}`;

const ID_VS = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProj;
${CLIP_VS}
out float vClip;
void main() {
  vClip = clipDistance(aPosition);
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const ID_FS = `#version 300 es
precision mediump float;
in float vClip;
uniform vec4 uId;
out vec4 outColor;
void main() {
  if (vClip > 0.0) discard;
  outColor = uId;
}`;

const MESH_ID_VS = `#version 300 es
in vec3 aPosition;
in float aLocal;
uniform mat4 uViewProj;
${CLIP_VS}
out float vClip;
flat out float vLocal;
void main() {
  vClip = clipDistance(aPosition);
  vLocal = aLocal;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const MESH_ID_FS = `#version 300 es
precision highp float;
in float vClip;
flat in float vLocal;
uniform float uBase;
out vec4 outColor;
${ID_ENCODE}
void main() {
  if (vClip > 0.0) discard;
  outColor = encodeId(uBase + floor(vLocal + 0.5));
}`;

/** Ground contact shadow: blurred height field from the shadow map. */
const SHADOW_VS = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProj;
uniform vec2 uMin;
uniform vec2 uMax;
out vec2 vUv;
void main() {
  vUv = (aPosition.xy - uMin) / (uMax - uMin);
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform highp sampler2D uShadowTex;
uniform float uRange;
uniform float uFade;
uniform float uStrength;
uniform vec2 uBlur;
uniform float uPool;
out vec4 outColor;
float contact(vec2 uv) {
  float d = texture(uShadowTex, uv).r;
  if (d >= 0.9999) return 0.0;
  float h = max(d * uRange - uRange * 0.01, 0.0);
  return exp(-h / uFade);
}
void main() {
  // A tight contact core plus a wide, soft falloff (three rings of taps).
  float sum = contact(vUv) * 2.0;
  float weight = 2.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988 + 0.26;
    vec2 dir = vec2(cos(a), sin(a));
    sum += contact(vUv + dir * uBlur * 0.15);
    sum += contact(vUv + dir * uBlur * 0.45) * 0.8;
    sum += contact(vUv + dir * uBlur) * 0.55;
    weight += 2.35;
  }
  float s = sum / weight;
  // Fade out towards the rectangle border so the shadow never shows a hard edge.
  vec2 edge = min(vUv, 1.0 - vUv);
  float border = smoothstep(0.0, 0.08, min(edge.x, edge.y));
  float shade = s * uStrength * border;
  // Dark themes: a faint light pool under the part so the contact shadow reads.
  float pool = uPool * (1.0 - smoothstep(0.15, 0.5, length(vUv - 0.5))) * (1.0 - s);
  float a = shade + pool;
  outColor = vec4(a > 0.0 ? vec3(pool / a) : vec3(0.0), a);
}`;

const LINE_CORNERS = new Float32Array([0, -1, 0, 1, 1, 1, 0, -1, 1, 1, 1, -1]);

interface CachedBuffer {
  buffer: WebGLBuffer;
  bytes: number;
  lastFrame: number;
}

/** Frames a stable GPU buffer may stay unused before it is released. */
const BUFFER_KEEP_FRAMES = 120;
/** GPU bytes above which unused stable buffers are released at once. */
const BUFFER_BUDGET_BYTES = 384 * 1024 * 1024;
const SHADOW_MAP_SIZE = 512;

interface RenderTarget {
  fbo: WebGLFramebuffer | null;
  width: number;
  height: number;
  /** Export: clear to transparent and keep straight alpha. */
  transparent?: boolean;
}

export interface RenderStats {
  frames: number;
  lastCpuMs: number;
  uploadsLastFrame: number;
  cachedBuffers: number;
  cachedBytes: number;
  drawCalls: number;
  /** Ambient occlusion ran in the last frame. */
  ambientOcclusion: boolean;
  /** The ground shadow map is available. */
  shadowMap: boolean;
}

export class ViewportRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly lit: Program;
  private readonly flat: Program;
  private readonly solid: Program;
  private readonly line: Program;
  private readonly silhouette: Program;
  private readonly linePick: Program;
  private readonly idProgram: Program;
  private readonly meshId: Program;
  private readonly shadowProgram: Program;
  private readonly dynamicBuffer: WebGLBuffer;
  private readonly dynamicBuffer2: WebGLBuffer;
  private readonly dynamicIndexBuffer: WebGLBuffer;
  private readonly cornerBuffer: WebGLBuffer;
  private readonly cache = new Map<ArrayBufferView, CachedBuffer>();
  private cacheBytes = 0;
  private frameNo = 0;
  private uploads = 0;
  private drawCalls = 0;
  private enabledAttribs = new Set<number>();
  private idFbo: WebGLFramebuffer | null = null;
  private idColorTex: WebGLTexture | null = null;
  private idDepthRb: WebGLRenderbuffer | null = null;
  private idWidth = 0;
  private idHeight = 0;
  private aoFbo: WebGLFramebuffer | null = null;
  private aoDepthTex: WebGLTexture | null = null;
  private aoWidth = 0;
  private aoHeight = 0;
  private aoFailed = false;
  private shadowFbo: WebGLFramebuffer | null = null;
  private shadowTex: WebGLTexture | null = null;
  private shadowKey: string | null = null;
  private pending: {
    viewProj: Float32Array;
    batches: IdBatch[];
    clip: SectionClip;
    pxScale: number;
    lineBias: number;
  } | null = null;
  private pickStale = false;
  private stats: RenderStats = {
    frames: 0,
    lastCpuMs: 0,
    uploadsLastFrame: 0,
    cachedBuffers: 0,
    cachedBytes: 0,
    drawCalls: 0,
    ambientOcclusion: false,
    shadowMap: false,
  };
  private aoRan = false;
  /** DEV measurement: wait for the GPU after each frame so `lastCpuMs` includes GPU time. */
  finishEachFrame = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      stencil: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.lit = linkProgram(gl, LIT_VS, LIT_FS, ['aPosition', 'aNormal', 'aCurvature']);
    this.flat = linkProgram(gl, FLAT_VS, FLAT_FS, ['aPosition', 'aColor']);
    this.solid = linkProgram(gl, SOLID_VS, SOLID_FS, ['aPosition']);
    this.line = linkProgram(gl, lineVs('color'), LINE_FS, ['aCorner', 'aA', 'aB']);
    this.silhouette = linkProgram(gl, lineVs('silhouette'), LINE_FS, [
      'aCorner',
      'aA',
      'aB',
      'aN1',
      'aN2',
    ]);
    this.linePick = linkProgram(gl, lineVs('pick'), LINE_PICK_FS, [
      'aCorner',
      'aA',
      'aB',
      'aLocal',
    ]);
    this.idProgram = linkProgram(gl, ID_VS, ID_FS, ['aPosition']);
    this.meshId = linkProgram(gl, MESH_ID_VS, MESH_ID_FS, ['aPosition', 'aLocal']);
    this.shadowProgram = linkProgram(gl, SHADOW_VS, SHADOW_FS, ['aPosition']);
    this.dynamicBuffer = gl.createBuffer()!;
    this.dynamicBuffer2 = gl.createBuffer()!;
    this.dynamicIndexBuffer = gl.createBuffer()!;
    this.cornerBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, LINE_CORNERS, gl.STATIC_DRAW);
  }

  /** Waits until the GPU has finished all submitted work (DEV measurement only). */
  sync(): void {
    const gl = this.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  /** Frame counters for DEV measurement (`window.__assembler.viewportStats()`). */
  renderStats(): RenderStats {
    return { ...this.stats };
  }

  resize(widthPx: number, heightPx: number): void {
    const gl = this.gl;
    if (gl.canvas.width !== widthPx || gl.canvas.height !== heightPx) {
      gl.canvas.width = widthPx;
      gl.canvas.height = heightPx;
    }
    this.pickStale = true;
  }

  // ---- buffers ------------------------------------------------------------------------------

  private u(program: Program, name: string): WebGLUniformLocation | null {
    let loc = program.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(program.program, name);
      program.uniforms.set(name, loc);
    }
    return loc;
  }

  /** GPU buffer holding `data`: cached for stable arrays, streamed otherwise. */
  private bufferFor(
    data: ArrayBufferView,
    target: number,
    stream: WebGLBuffer = this.dynamicBuffer,
  ): WebGLBuffer {
    const gl = this.gl;
    if (isStable(data)) {
      const hit = this.cache.get(data);
      if (hit) {
        hit.lastFrame = this.frameNo;
        gl.bindBuffer(target, hit.buffer);
        return hit.buffer;
      }
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      this.uploads += 1;
      this.cache.set(data, { buffer, bytes: data.byteLength, lastFrame: this.frameNo });
      this.cacheBytes += data.byteLength;
      return buffer;
    }
    gl.bindBuffer(target, stream);
    gl.bufferData(target, data, gl.STREAM_DRAW);
    return stream;
  }

  private endFrame(): void {
    const gl = this.gl;
    for (const [key, entry] of this.cache) {
      const idle = this.frameNo - entry.lastFrame;
      if (idle > BUFFER_KEEP_FRAMES || (this.cacheBytes > BUFFER_BUDGET_BYTES && idle > 0)) {
        gl.deleteBuffer(entry.buffer);
        this.cacheBytes -= entry.bytes;
        this.cache.delete(key);
      }
    }
    this.frameNo += 1;
  }

  private resetAttribs(): void {
    const gl = this.gl;
    for (const loc of this.enabledAttribs) {
      gl.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
    this.enabledAttribs.clear();
  }

  private attrib(loc: number | undefined, size: number, stride = 0, offset = 0, divisor = 0): void {
    if (loc === undefined || loc < 0) return;
    const gl = this.gl;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, divisor);
    this.enabledAttribs.add(loc);
  }

  private setClipUniforms(program: Program, clip: SectionClip, enabled = clip.enabled): void {
    const gl = this.gl;
    gl.uniform1i(this.u(program, 'uClipEnabled'), enabled ? 1 : 0);
    gl.uniform3f(this.u(program, 'uClipNormal'), clip.normal[0], clip.normal[1], clip.normal[2]);
    gl.uniform1f(this.u(program, 'uClipOffset'), clip.offset);
  }

  // ---- frame --------------------------------------------------------------------------------

  render(frame: SceneFrame): void {
    const gl = this.gl;
    const t0 = performance.now();
    this.uploads = 0;
    this.drawCalls = 0;
    this.renderInto(frame, {
      fbo: null,
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
    });
    if (this.finishEachFrame) {
      // A 1-pixel read-back waits until the GPU has finished this frame
      // (`gl.finish` returns early in Chromium's command-buffer model).
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    this.endFrame();
    this.stats = {
      frames: this.stats.frames + 1,
      lastCpuMs: performance.now() - t0,
      uploadsLastFrame: this.uploads,
      cachedBuffers: this.cache.size,
      cachedBytes: this.cacheBytes,
      drawCalls: this.drawCalls,
      ambientOcclusion: this.aoRan,
      shadowMap: this.shadowFbo !== null,
    };
  }

  private renderInto(frame: SceneFrame, target: RenderTarget): void {
    const gl = this.gl;
    const pxScale = frame.pxScale ?? 1;
    const aoOn = !!frame.ao && !!frame.depth && frame.lit.some((b) => b.depthWrite);
    let aoReady = false;
    if (aoOn) aoReady = this.renderAoDepth(frame, target);
    this.aoRan = aoReady;
    const shadowReady = frame.shadow ? this.renderShadowMap(frame.shadow) : false;

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.colorMask(true, true, true, true);
    if (target.transparent) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(frame.background[0], frame.background[1], frame.background[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    this.blend(target, false);

    // ---- bodies
    const lit = this.lit;
    gl.useProgram(lit.program);
    gl.uniformMatrix4fv(this.u(lit, 'uViewProj'), false, frame.viewProj);
    this.setClipUniforms(lit, frame.clip);
    const cam = frame.cameraPosition;
    gl.uniform3f(this.u(lit, 'uEye'), cam[0], cam[1], cam[2]);
    const light = frame.lighting ?? DEFAULT_LIGHTING;
    const ortho = frame.depth?.orthographic ?? false;
    gl.uniform1i(this.u(lit, 'uOrtho'), ortho ? 1 : 0);
    // right × up = the unit direction towards the eye (orthographic view rays).
    const vd = cross3(light.right, light.up);
    gl.uniform3f(this.u(lit, 'uViewDir'), vd[0], vd[1], vd[2]);
    gl.uniform3f(this.u(lit, 'uKeyDir'), light.keyDir[0], light.keyDir[1], light.keyDir[2]);
    gl.uniform3f(this.u(lit, 'uFillDir'), light.fillDir[0], light.fillDir[1], light.fillDir[2]);
    gl.uniform3f(this.u(lit, 'uRight'), light.right[0], light.right[1], light.right[2]);
    gl.uniform3f(this.u(lit, 'uUp'), light.up[0], light.up[1], light.up[2]);
    gl.uniform3f(this.u(lit, 'uSky'), light.sky[0], light.sky[1], light.sky[2]);
    gl.uniform3f(this.u(lit, 'uGround'), light.ground[0], light.ground[1], light.ground[2]);
    gl.uniform1f(this.u(lit, 'uZebra'), frame.zebraStripes ?? 14);
    const range = frame.curvatureRange ?? { min: 0.5, max: 200 };
    gl.uniform2f(this.u(lit, 'uCurvRange'), Math.log10(range.min), Math.log10(range.max));
    gl.uniform1i(this.u(lit, 'uAo'), aoReady ? 1 : 0);
    if (aoReady && frame.depth && frame.ao) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.aoDepthTex);
      gl.uniform1i(this.u(lit, 'uDepthTex'), 0);
      gl.uniform2f(this.u(lit, 'uViewportPx'), target.width, target.height);
      gl.uniform1f(this.u(lit, 'uAoRadiusPx'), frame.ao.radiusPx * pxScale);
      gl.uniform1f(this.u(lit, 'uAoStrength'), frame.ao.strength);
      gl.uniform1f(this.u(lit, 'uNear'), frame.depth.near);
      gl.uniform1f(this.u(lit, 'uFar'), frame.depth.far);
      gl.uniform1f(this.u(lit, 'uWorldPerPxAt1'), frame.depth.worldPerPxAt1 / pxScale);
    }
    for (const batch of frame.lit) this.drawLit(batch, target);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);

    // ---- section caps (stencil parity per body)
    if (frame.caps && frame.clip.enabled) this.drawCaps(frame, pxScale, target);

    // ---- grid and axes, then the ground contact shadow over them
    // (No depth writes: edges lying on the grid plane must not z-fight with grid lines.)
    if (frame.underlay) this.drawBatchList(frame, frame.underlay, pxScale, target, false);
    if (frame.shadow && shadowReady) this.drawShadow(frame, frame.shadow, target);

    // ---- flat batches, lines and highlights, in order
    this.drawBatchList(frame, frame.flat, pxScale, target);
    this.resetAttribs();
    this.blend(target, false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
  }

  private drawBatchList(
    frame: SceneFrame,
    list: readonly DrawBatch[],
    pxScale: number,
    target: RenderTarget,
    writeDepth = true,
  ): void {
    const gl = this.gl;
    let lastProgram: Program | null = null;
    for (const batch of list) {
      gl.depthMask(writeDepth);
      if ('kind' in batch && batch.kind === 'lines') {
        this.drawLines(frame, batch, pxScale, target);
        lastProgram = null;
      } else if ('kind' in batch && batch.kind === 'meshRange') {
        this.drawMeshRange(frame, batch, target);
        lastProgram = null;
      } else {
        const flatBatch = batch as FlatBatch;
        if (lastProgram !== this.flat) {
          gl.useProgram(this.flat.program);
          gl.uniformMatrix4fv(this.u(this.flat, 'uViewProj'), false, frame.viewProj);
          lastProgram = this.flat;
        }
        this.setClipUniforms(this.flat, frame.clip, frame.clip.enabled && !flatBatch.noClip);
        if (flatBatch.depthTest) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
        this.blend(target, true);
        this.drawFlatPositionsColors(flatBatch.positions, flatBatch.colors, flatBatch.mode);
      }
    }
    gl.depthMask(true);
  }

  private blend(target: RenderTarget, on: boolean): void {
    const gl = this.gl;
    if (!on) {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    if (target.transparent) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  private drawLit(batch: TriBatch, target: RenderTarget): void {
    const gl = this.gl;
    const lit = this.lit;
    gl.depthMask(batch.depthWrite);
    if (batch.depthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (batch.polygonOffset) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
    } else {
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    this.blend(target, batch.alpha < 1);
    const m = batch.material ?? DEFAULT_MATERIAL;
    gl.uniform3f(this.u(lit, 'uColor'), batch.color[0], batch.color[1], batch.color[2]);
    gl.uniform1f(this.u(lit, 'uAlpha'), batch.alpha);
    gl.uniform1f(this.u(lit, 'uRoughness'), m.roughness);
    gl.uniform1f(this.u(lit, 'uSpecular'), m.specular);
    gl.uniform1f(this.u(lit, 'uMetalness'), m.metalness);
    gl.uniform1f(this.u(lit, 'uClearcoat'), m.clearcoat);
    gl.uniform1f(this.u(lit, 'uWrap'), m.wrap);
    const shading = batch.shading === 'zebra' ? 1 : batch.shading === 'curvature' ? 2 : 0;
    gl.uniform1i(this.u(lit, 'uShading'), shading);
    this.resetAttribs();
    this.bufferFor(batch.positions, gl.ARRAY_BUFFER, this.dynamicBuffer);
    this.attrib(lit.attribs.aPosition, 3);
    this.bufferFor(batch.normals, gl.ARRAY_BUFFER, this.dynamicBuffer2);
    this.attrib(lit.attribs.aNormal, 3);
    const curvLoc = lit.attribs.aCurvature;
    if (curvLoc !== undefined && curvLoc >= 0) {
      if (batch.curvature && shading === 2) {
        this.bufferFor(batch.curvature, gl.ARRAY_BUFFER, this.dynamicBuffer);
        this.attrib(curvLoc, 1);
      } else {
        gl.disableVertexAttribArray(curvLoc);
        gl.vertexAttrib1f(curvLoc, 0);
      }
    }
    this.drawTriangles(batch.positions.length / 3, batch.indices);
  }

  private drawTriangles(vertexCount: number, indices?: Uint32Array, first = 0, count?: number) {
    const gl = this.gl;
    this.drawCalls += 1;
    if (indices) {
      this.bufferFor(indices, gl.ELEMENT_ARRAY_BUFFER, this.dynamicIndexBuffer);
      gl.drawElements(gl.TRIANGLES, count ?? indices.length, gl.UNSIGNED_INT, first * 4);
    } else if (vertexCount > 0) {
      gl.drawArrays(gl.TRIANGLES, first, count ?? vertexCount);
    }
  }

  private drawMeshRange(frame: SceneFrame, batch: MeshRangeBatch, target: RenderTarget): void {
    const gl = this.gl;
    const solid = this.solid;
    gl.useProgram(solid.program);
    gl.uniformMatrix4fv(this.u(solid, 'uViewProj'), false, frame.viewProj);
    this.setClipUniforms(solid, frame.clip, frame.clip.enabled && !batch.noClip);
    gl.uniform4f(this.u(solid, 'uColor'), ...batch.color);
    gl.uniform1i(this.u(solid, 'uHatch'), 0);
    if (batch.depthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.blend(target, true);
    this.resetAttribs();
    this.bufferFor(batch.positions, gl.ARRAY_BUFFER);
    this.attrib(solid.attribs.aPosition, 3);
    this.drawTriangles(0, batch.indices, batch.firstTriangle * 3, batch.triangleCount * 3);
    gl.depthMask(true);
  }

  private drawLines(
    frame: SceneFrame,
    batch: LineBatch,
    pxScale: number,
    target: RenderTarget,
  ): void {
    const gl = this.gl;
    const program = batch.silhouette ? this.silhouette : this.line;
    const floats = batch.silhouette ? 12 : 6;
    const total = Math.floor(batch.segments.length / floats);
    const first = batch.first ?? 0;
    const count = Math.min(batch.count ?? total - first, total - first);
    if (count <= 0) return;
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(this.u(program, 'uViewProj'), false, frame.viewProj);
    this.setClipUniforms(program, frame.clip, frame.clip.enabled && !batch.noClip);
    gl.uniform2f(this.u(program, 'uViewportPx'), target.width, target.height);
    gl.uniform1f(this.u(program, 'uWidthPx'), batch.widthPx * pxScale);
    gl.uniform1f(
      this.u(program, 'uDepthBias'),
      batch.depthTest ? (frame.depth?.lineBias ?? 4e-5) : 0,
    );
    gl.uniform4f(this.u(program, 'uColor'), ...batch.color);
    gl.uniform1f(this.u(program, 'uDashPx'), (batch.dashPx ?? 0) * pxScale);
    const cam = frame.cameraPosition;
    gl.uniform3f(this.u(program, 'uEye'), cam[0], cam[1], cam[2]);
    const ortho = frame.depth?.orthographic ?? false;
    gl.uniform1i(this.u(program, 'uOrtho'), ortho ? 1 : 0);
    const vd = frame.lighting
      ? cross3(frame.lighting.right, frame.lighting.up)
      : normalize3(cam as [number, number, number]);
    gl.uniform3f(this.u(program, 'uViewDir'), vd[0], vd[1], vd[2]);
    if (batch.hiddenOnly) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.GREATER);
      gl.depthMask(false);
    } else if (batch.depthTest) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    this.blend(target, true);
    this.resetAttribs();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    this.attrib(program.attribs.aCorner, 2);
    this.bufferFor(batch.segments, gl.ARRAY_BUFFER, this.dynamicBuffer);
    const stride = floats * 4;
    const base = first * stride;
    this.attrib(program.attribs.aA, 3, stride, base, 1);
    this.attrib(program.attribs.aB, 3, stride, base + 12, 1);
    if (batch.silhouette) {
      this.attrib(program.attribs.aN1, 3, stride, base + 24, 1);
      this.attrib(program.attribs.aN2, 3, stride, base + 36, 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    this.drawCalls += 1;
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
  }

  private drawFlatPositionsColors(
    positions: Float32Array,
    colors: Float32Array,
    mode: 'lines' | 'triangles',
  ): void {
    const gl = this.gl;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) return;
    this.resetAttribs();
    this.bufferFor(positions, gl.ARRAY_BUFFER, this.dynamicBuffer);
    this.attrib(this.flat.attribs.aPosition, 3);
    this.bufferFor(colors, gl.ARRAY_BUFFER, this.dynamicBuffer2);
    this.attrib(this.flat.attribs.aColor, 4);
    gl.drawArrays(mode === 'lines' ? gl.LINES : gl.TRIANGLES, 0, vertexCount);
    this.drawCalls += 1;
  }

  // ---- section caps ---------------------------------------------------------------------------

  private drawCaps(frame: SceneFrame, pxScale: number, target: RenderTarget): void {
    const gl = this.gl;
    const caps = frame.caps!;
    const solid = this.solid;
    gl.useProgram(solid.program);
    gl.uniformMatrix4fv(this.u(solid, 'uViewProj'), false, frame.viewProj);
    gl.uniform1f(this.u(solid, 'uPxScale'), pxScale);
    const quad = caps.plane;
    const quadPositions = new Float32Array([
      ...quad[0],
      ...quad[1],
      ...quad[2],
      ...quad[0],
      ...quad[2],
      ...quad[3],
    ]);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    for (const body of caps.bodies) {
      // 1) Parity of the kept surface along each pixel's ray.
      this.setClipUniforms(solid, frame.clip, true);
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.stencilMask(0x01);
      this.resetAttribs();
      this.bufferFor(body.positions, gl.ARRAY_BUFFER);
      this.attrib(solid.attribs.aPosition, 3);
      this.drawTriangles(body.positions.length / 3, body.indices);
      // 2) The plane where the parity is odd, in the body's colour; clears the bit again.
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      // Pixels where the cap loses the depth test are cleared too (dpfail = ZERO).
      gl.stencilFunc(gl.EQUAL, 1, 0x01);
      gl.stencilOp(gl.KEEP, gl.ZERO, gl.ZERO);
      this.setClipUniforms(solid, frame.clip, false);
      gl.uniform4f(this.u(solid, 'uColor'), body.color[0], body.color[1], body.color[2], 1);
      gl.uniform1i(this.u(solid, 'uHatch'), caps.hatch ? 1 : 0);
      this.blend(target, false);
      this.resetAttribs();
      this.bufferFor(quadPositions, gl.ARRAY_BUFFER);
      this.attrib(solid.attribs.aPosition, 3);
      this.drawTriangles(6);
    }
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.stencilMask(0xff);
    gl.disable(gl.STENCIL_TEST);
  }

  // ---- ambient occlusion depth prepass -------------------------------------------------------

  private renderAoDepth(frame: SceneFrame, target: RenderTarget): boolean {
    if (this.aoFailed) return false;
    const gl = this.gl;
    const width = Math.max(1, Math.ceil(target.width / 2));
    const height = Math.max(1, Math.ceil(target.height / 2));
    if (!this.aoFbo || this.aoWidth !== width || this.aoHeight !== height) {
      if (this.aoFbo) gl.deleteFramebuffer(this.aoFbo);
      if (this.aoDepthTex) gl.deleteTexture(this.aoDepthTex);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.DEPTH_COMPONENT24,
        width,
        height,
        0,
        gl.DEPTH_COMPONENT,
        gl.UNSIGNED_INT,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.aoFailed = true;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        return false;
      }
      this.aoFbo = fbo;
      this.aoDepthTex = tex;
      this.aoWidth = width;
      this.aoHeight = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aoFbo);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    const solid = this.solid;
    gl.useProgram(solid.program);
    gl.uniformMatrix4fv(this.u(solid, 'uViewProj'), false, frame.viewProj);
    this.setClipUniforms(solid, frame.clip);
    gl.uniform4f(this.u(solid, 'uColor'), 0, 0, 0, 1);
    gl.uniform1i(this.u(solid, 'uHatch'), 0);
    for (const batch of frame.lit) {
      if (!batch.depthWrite) continue;
      this.resetAttribs();
      this.bufferFor(batch.positions, gl.ARRAY_BUFFER);
      this.attrib(solid.attribs.aPosition, 3);
      this.drawTriangles(batch.positions.length / 3, batch.indices);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    return true;
  }

  // ---- ground shadow ----------------------------------------------------------------------------

  private renderShadowMap(shadow: GroundShadow): boolean {
    const gl = this.gl;
    if (!this.shadowFbo) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.DEPTH_COMPONENT24,
        SHADOW_MAP_SIZE,
        SHADOW_MAP_SIZE,
        0,
        gl.DEPTH_COMPONENT,
        gl.UNSIGNED_INT,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        return false;
      }
      this.shadowFbo = fbo;
      this.shadowTex = tex;
    }
    if (this.shadowKey === shadow.key) return true;
    this.shadowKey = shadow.key;
    // Orthographic camera below the ground plane looking up: depth = height above ground.
    const [x0, y0] = shadow.min;
    const [x1, y1] = shadow.max;
    const floor = shadow.z;
    const range = Math.max(1e-3, shadow.top - floor) * 1.01 + 1e-3;
    const near = floor - range * 0.01;
    // Maps x→[-1,1], y→[-1,1], z (world) from `near` (depth 0) to `near + range` (depth 1).
    const sx = 2 / (x1 - x0);
    const sy = 2 / (y1 - y0);
    const sz = 2 / range;
    const viewProj = new Float32Array([
      sx,
      0,
      0,
      0,
      0,
      sy,
      0,
      0,
      0,
      0,
      sz,
      0,
      -(x0 + x1) / (x1 - x0),
      -(y0 + y1) / (y1 - y0),
      -1 - near * sz,
      1,
    ]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const solid = this.solid;
    gl.useProgram(solid.program);
    gl.uniformMatrix4fv(this.u(solid, 'uViewProj'), false, viewProj);
    this.setClipUniforms(solid, { enabled: false, normal: [0, 0, 1], offset: 0 });
    for (const caster of shadow.casters) {
      this.resetAttribs();
      this.bufferFor(caster.positions, gl.ARRAY_BUFFER);
      this.attrib(solid.attribs.aPosition, 3);
      this.drawTriangles(caster.positions.length / 3, caster.indices);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  private drawShadow(frame: SceneFrame, shadow: GroundShadow, target: RenderTarget): void {
    const gl = this.gl;
    const program = this.shadowProgram;
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(this.u(program, 'uViewProj'), false, frame.viewProj);
    const [x0, y0] = shadow.min;
    const [x1, y1] = shadow.max;
    gl.uniform2f(this.u(program, 'uMin'), x0, y0);
    gl.uniform2f(this.u(program, 'uMax'), x1, y1);
    const range = Math.max(1e-3, shadow.top - shadow.z) * 1.01 + 1e-3;
    gl.uniform1f(this.u(program, 'uRange'), range);
    const size = Math.max(x1 - x0, y1 - y0);
    gl.uniform1f(this.u(program, 'uFade'), Math.max(0.5, size * 0.06));
    gl.uniform1f(this.u(program, 'uStrength'), shadow.strength);
    gl.uniform1f(this.u(program, 'uPool'), shadow.pool ?? 0);
    // Blur radius: 8 % of the footprint (the rectangle has a 30 % margin, see `scene.ts`).
    gl.uniform2f(this.u(program, 'uBlur'), (size * 0.08) / (x1 - x0), (size * 0.08) / (y1 - y0));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.u(program, 'uShadowTex'), 1);
    gl.activeTexture(gl.TEXTURE0);
    const z = shadow.z;
    const quad = new Float32Array([
      x0,
      y0,
      z,
      x1,
      y0,
      z,
      x1,
      y1,
      z,
      x0,
      y0,
      z,
      x1,
      y1,
      z,
      x0,
      y1,
      z,
    ]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    this.blend(target, true);
    this.resetAttribs();
    this.bufferFor(quad, gl.ARRAY_BUFFER);
    this.attrib(program.attribs.aPosition, 3);
    this.drawTriangles(6);
    gl.depthMask(true);
  }

  // ---- picking ------------------------------------------------------------------------------------

  /**
   * Records the id pass of the current frame. It is drawn lazily — only when
   * a pick/box/anchor query reads the buffer — so orbiting never pays for it.
   */
  renderPicking(
    viewProj: Float32Array,
    batches: IdBatch[],
    clip: SectionClip,
    pxScale = 1,
    lineBias = 1.5e-4,
  ): void {
    this.pending = { viewProj, batches, clip, pxScale, lineBias };
    this.pickStale = true;
  }

  private ensureIdFbo(width: number, height: number): void {
    if (this.idWidth === width && this.idHeight === height && this.idFbo) return;
    const gl = this.gl;
    if (this.idFbo) gl.deleteFramebuffer(this.idFbo);
    if (this.idColorTex) gl.deleteTexture(this.idColorTex);
    if (this.idDepthRb) gl.deleteRenderbuffer(this.idDepthRb);
    this.idWidth = Math.max(1, width);
    this.idHeight = Math.max(1, height);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.idWidth,
      this.idHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.idWidth, this.idHeight);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.idFbo = fbo;
    this.idColorTex = tex;
    this.idDepthRb = depth;
  }

  /** Draws the recorded id pass if it is out of date. */
  private ensurePick(): boolean {
    const gl = this.gl;
    this.ensureIdFbo(gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (!this.pickStale) return this.idFbo !== null;
    const pending = this.pending;
    if (!pending) return false;
    this.pickStale = false;
    const { viewProj, batches, clip, pxScale, lineBias } = pending;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    gl.viewport(0, 0, this.idWidth, this.idHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    for (const batch of batches) {
      if ('kind' in batch && batch.kind === 'mesh') {
        const p = this.meshId;
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(this.u(p, 'uViewProj'), false, viewProj);
        this.setClipUniforms(p, clip);
        gl.uniform1f(this.u(p, 'uBase'), batch.baseId);
        gl.enable(gl.DEPTH_TEST);
        this.resetAttribs();
        this.bufferFor(batch.positions, gl.ARRAY_BUFFER);
        this.attrib(p.attribs.aPosition, 3);
        this.bufferFor(batch.localIndex, gl.ARRAY_BUFFER, this.dynamicBuffer2);
        this.attrib(p.attribs.aLocal, 1);
        this.drawTriangles(batch.positions.length / 3, batch.indices);
      } else if ('kind' in batch && batch.kind === 'lines') {
        const count = Math.floor(batch.segments.length / 6);
        if (count === 0) continue;
        const p = this.linePick;
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(this.u(p, 'uViewProj'), false, viewProj);
        this.setClipUniforms(p, clip, clip.enabled && !batch.onTop);
        gl.uniform2f(this.u(p, 'uViewportPx'), this.idWidth, this.idHeight);
        gl.uniform1f(this.u(p, 'uWidthPx'), batch.widthPx * pxScale);
        // Edges win over the faces they bound inside their hit ribbon.
        gl.uniform1f(this.u(p, 'uDepthBias'), lineBias * 3);
        gl.uniform1f(this.u(p, 'uBase'), batch.baseId);
        if (batch.onTop) gl.disable(gl.DEPTH_TEST);
        else gl.enable(gl.DEPTH_TEST);
        this.resetAttribs();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
        this.attrib(p.attribs.aCorner, 2);
        this.bufferFor(batch.segments, gl.ARRAY_BUFFER);
        this.attrib(p.attribs.aA, 3, 24, 0, 1);
        this.attrib(p.attribs.aB, 3, 24, 12, 1);
        this.bufferFor(batch.localIndex, gl.ARRAY_BUFFER, this.dynamicBuffer2);
        this.attrib(p.attribs.aLocal, 1, 4, 0, 1);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      } else {
        const legacy = batch as LegacyIdBatch;
        const vertexCount = legacy.positions.length / 3;
        if (vertexCount === 0) continue;
        const p = this.idProgram;
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(this.u(p, 'uViewProj'), false, viewProj);
        const onTop = legacy.onTop ?? false;
        if (onTop) gl.disable(gl.DEPTH_TEST);
        else gl.enable(gl.DEPTH_TEST);
        this.setClipUniforms(p, clip, clip.enabled && !onTop);
        const id = legacy.id;
        gl.uniform4f(
          this.u(p, 'uId'),
          (id & 0xff) / 255,
          ((id >>> 8) & 0xff) / 255,
          ((id >>> 16) & 0xff) / 255,
          ((id >>> 24) & 0xff) / 255,
        );
        this.resetAttribs();
        this.bufferFor(legacy.positions, gl.ARRAY_BUFFER);
        this.attrib(p.attribs.aPosition, 3);
        gl.drawArrays(legacy.mode === 'lines' ? gl.LINES : gl.TRIANGLES, 0, vertexCount);
      }
    }
    this.resetAttribs();
    gl.enable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /**
   * Reads the whole id framebuffer (bottom-left origin rows, RGBA bytes).
   * Dev automation only (anchor lookup) — too slow for per-frame use.
   */
  readPickBuffer(): { width: number; height: number; pixels: Uint8Array } | null {
    const gl = this.gl;
    if (!this.ensurePick()) return null;
    const pixels = new Uint8Array(this.idWidth * this.idHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    gl.readPixels(0, 0, this.idWidth, this.idHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: this.idWidth, height: this.idHeight, pixels };
  }

  /**
   * Distinct ids inside a rectangle of the id framebuffer (framebuffer pixels,
   * top-left origin), each with its smallest squared pixel distance to
   * (`cx`, `cy`) — used for box selection and overlapping-pick candidates.
   */
  readPickIdsInRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
  ): Map<number, number> {
    const gl = this.gl;
    const out = new Map<number, number>();
    if (!this.ensurePick()) return out;
    const left = Math.max(0, Math.floor(Math.min(x0, x1)));
    const right = Math.min(this.idWidth - 1, Math.ceil(Math.max(x0, x1)));
    const top = Math.max(0, Math.floor(Math.min(y0, y1)));
    const bottom = Math.min(this.idHeight - 1, Math.ceil(Math.max(y0, y1)));
    if (right < left || bottom < top) return out;
    const width = right - left + 1;
    const height = bottom - top + 1;
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    gl.readPixels(
      left,
      this.idHeight - 1 - bottom,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let row = 0; row < height; row += 1) {
      // readPixels rows are bottom-up.
      const y = bottom - row;
      for (let col = 0; col < width; col += 1) {
        const o = (row * width + col) * 4;
        const id =
          (pixels[o]! | (pixels[o + 1]! << 8) | (pixels[o + 2]! << 16) | (pixels[o + 3]! << 24)) >>>
          0;
        if (id === 0) continue;
        const x = left + col;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        const previous = out.get(id);
        if (previous === undefined || d < previous) out.set(id, d);
      }
    }
    return out;
  }

  /** Reads back one pixel from the id framebuffer (in framebuffer pixel coordinates, top-left origin flipped to bottom-left internally). */
  readPickPixel(xPx: number, yPx: number): number {
    const gl = this.gl;
    if (!this.ensurePick()) return 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    const flippedY = this.idHeight - 1 - Math.round(yPx);
    const px = new Uint8Array(4);
    const x = Math.round(xPx);
    if (x < 0 || x >= this.idWidth || flippedY < 0 || flippedY >= this.idHeight) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return 0;
    }
    gl.readPixels(x, flippedY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (px[0]! | (px[1]! << 8) | (px[2]! << 16) | (px[3]! << 24)) >>> 0;
  }

  // ---- offscreen image export -------------------------------------------------------------------

  /** Largest image side {@link renderImage} can produce on this GPU. */
  maxImageSize(): number {
    const gl = this.gl;
    return Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      8192,
    );
  }

  /**
   * Renders `frame` into an offscreen multisampled framebuffer of the given
   * size and returns straight-alpha RGBA pixels, top row first.
   */
  renderImage(frame: SceneFrame, width: number, height: number, transparent: boolean): Uint8Array {
    const gl = this.gl;
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const msFbo = gl.createFramebuffer()!;
    const colorRb = gl.createRenderbuffer()!;
    const depthRb = gl.createRenderbuffer()!;
    const resolveFbo = gl.createFramebuffer()!;
    const resolveRb = gl.createRenderbuffer()!;
    try {
      gl.bindRenderbuffer(gl.RENDERBUFFER, colorRb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        gl.DEPTH24_STENCIL8,
        width,
        height,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        depthRb,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('The graphics driver cannot render an image of this size.');
      }
      this.renderInto(frame, { fbo: msFbo, width, height, transparent });
      gl.bindRenderbuffer(gl.RENDERBUFFER, resolveRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, resolveRb);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolveFbo);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // Bottom-up rows → top-down.
      const flipped = new Uint8Array(pixels.length);
      const row = width * 4;
      for (let y = 0; y < height; y += 1) {
        flipped.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
      }
      return flipped;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(msFbo);
      gl.deleteFramebuffer(resolveFbo);
      gl.deleteRenderbuffer(colorRb);
      gl.deleteRenderbuffer(depthRb);
      gl.deleteRenderbuffer(resolveRb);
      // The AO depth texture was sized for the export; the next frame resizes it back.
      this.pickStale = true;
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of [
      this.lit,
      this.flat,
      this.solid,
      this.line,
      this.silhouette,
      this.linePick,
      this.idProgram,
      this.meshId,
      this.shadowProgram,
    ]) {
      gl.deleteProgram(p.program);
    }
    gl.deleteBuffer(this.dynamicBuffer);
    gl.deleteBuffer(this.dynamicBuffer2);
    gl.deleteBuffer(this.dynamicIndexBuffer);
    gl.deleteBuffer(this.cornerBuffer);
    for (const entry of this.cache.values()) gl.deleteBuffer(entry.buffer);
    this.cache.clear();
    if (this.idFbo) gl.deleteFramebuffer(this.idFbo);
    if (this.idColorTex) gl.deleteTexture(this.idColorTex);
    if (this.idDepthRb) gl.deleteRenderbuffer(this.idDepthRb);
    if (this.aoFbo) gl.deleteFramebuffer(this.aoFbo);
    if (this.aoDepthTex) gl.deleteTexture(this.aoDepthTex);
    if (this.shadowFbo) gl.deleteFramebuffer(this.shadowFbo);
    if (this.shadowTex) gl.deleteTexture(this.shadowTex);
  }
}

const DEFAULT_MATERIAL: MaterialParams = {
  roughness: 0.6,
  specular: 0.22,
  metalness: 0,
  clearcoat: 0,
  wrap: 0.1,
};

const DEFAULT_LIGHTING: Lighting = {
  keyDir: normalize3([0.45, 0.35, 0.82]),
  fillDir: normalize3([-0.6, -0.2, 0.3]),
  right: [1, 0, 0],
  up: [0, 0, 1],
  sky: [0.82, 0.86, 0.92],
  ground: [0.32, 0.3, 0.28],
};

function cross3(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(v: Vec3): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
