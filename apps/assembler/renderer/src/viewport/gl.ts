/**
 * WebGL2 execution layer for the Assembler viewport. Pure "draw these
 * batches" executor — no knowledge of the store, selection, or tools. All
 * geometry (including move/extrude preview translation and highlight
 * duplicates) is precomputed on the CPU by `Viewport.tsx` using
 * `geometry.ts`/`camera.ts`; this module only uploads and draws it.
 *
 * Three programs: `lit` (shaded body faces), `flat` (lines + translucent
 * overlays, per-vertex RGBA), `id` (offscreen picking pass, uniform color
 * per batch). Not unit tested (requires a GL context) — see `Viewport.tsx`'s
 * manual verification notes instead.
 */

export interface SectionClip {
  enabled: boolean;
  normal: readonly [number, number, number];
  offset: number;
}

export interface TriBatch {
  positions: Float32Array;
  normals: Float32Array;
  color: readonly [number, number, number];
  alpha: number;
  depthTest: boolean;
  depthWrite: boolean;
  polygonOffset: boolean;
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

export interface IdBatch {
  positions: Float32Array;
  id: number;
  mode: 'triangles' | 'lines';
  /** Drawn without depth test and without the section clip (tool handles win every pick). */
  onTop?: boolean;
}

export interface SceneFrame {
  viewProj: Float32Array;
  cameraPosition: readonly [number, number, number];
  background: readonly [number, number, number];
  lit: TriBatch[];
  flat: FlatBatch[];
  clip: SectionClip;
}

interface Program {
  program: WebGLProgram;
  attribs: Record<string, number>;
  uniforms: Record<string, WebGLUniformLocation | null>;
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
  uniformNames: string[],
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
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, attribs, uniforms };
}

const LIT_VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uViewProj;
uniform vec3 uClipNormal;
uniform float uClipOffset;
uniform bool uClipEnabled;
out vec3 vNormal;
out float vClip;
void main() {
  vClip = uClipEnabled ? (dot(aPosition, uClipNormal) - uClipOffset) : -1.0;
  vNormal = aNormal;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const LIT_FS = `#version 300 es
precision mediump float;
in vec3 vNormal;
in float vClip;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
uniform bool uClipEnabled;
void main() {
  if (vClip > 0.0) discard;
  // Section caps: with the clip on, a back face can only be seen through the
  // cut, i.e. it lies inside the solid. Paint it flat and hatched in shades of
  // the body colour so the cut reads as a filled cap (closed solids).
  if (uClipEnabled && !gl_FrontFacing) {
    float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0));
    outColor = vec4(uColor * mix(0.5, 0.68, hatch) + vec3(0.03), uAlpha);
    return;
  }
  vec3 lightDir = normalize(vec3(0.45, 0.35, 0.82));
  float diff = max(dot(normalize(vNormal), lightDir), 0.0);
  float shade = 0.42 + diff * 0.58;
  outColor = vec4(uColor * shade, uAlpha);
}`;

const FLAT_VS = `#version 300 es
in vec3 aPosition;
in vec4 aColor;
uniform mat4 uViewProj;
uniform vec3 uClipNormal;
uniform float uClipOffset;
uniform bool uClipEnabled;
out vec4 vColor;
out float vClip;
void main() {
  vClip = uClipEnabled ? (dot(aPosition, uClipNormal) - uClipOffset) : -1.0;
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

const ID_VS = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProj;
uniform vec3 uClipNormal;
uniform float uClipOffset;
uniform bool uClipEnabled;
out float vClip;
void main() {
  vClip = uClipEnabled ? (dot(aPosition, uClipNormal) - uClipOffset) : -1.0;
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

export class ViewportRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly lit: Program;
  private readonly flat: Program;
  private readonly idProgram: Program;
  private readonly dynamicBuffer: WebGLBuffer;
  private readonly dynamicBuffer2: WebGLBuffer;
  private idFbo: WebGLFramebuffer | null = null;
  private idColorTex: WebGLTexture | null = null;
  private idDepthRb: WebGLRenderbuffer | null = null;
  private idWidth = 0;
  private idHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.lit = linkProgram(
      gl,
      LIT_VS,
      LIT_FS,
      ['aPosition', 'aNormal'],
      ['uViewProj', 'uColor', 'uAlpha', 'uClipNormal', 'uClipOffset', 'uClipEnabled'],
    );
    this.flat = linkProgram(
      gl,
      FLAT_VS,
      FLAT_FS,
      ['aPosition', 'aColor'],
      ['uViewProj', 'uClipNormal', 'uClipOffset', 'uClipEnabled'],
    );
    this.idProgram = linkProgram(
      gl,
      ID_VS,
      ID_FS,
      ['aPosition'],
      ['uViewProj', 'uId', 'uClipNormal', 'uClipOffset', 'uClipEnabled'],
    );
    this.dynamicBuffer = gl.createBuffer()!;
    this.dynamicBuffer2 = gl.createBuffer()!;
  }

  resize(widthPx: number, heightPx: number): void {
    const gl = this.gl;
    if (gl.canvas.width !== widthPx || gl.canvas.height !== heightPx) {
      gl.canvas.width = widthPx;
      gl.canvas.height = heightPx;
    }
    this.ensureIdFbo(widthPx, heightPx);
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
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.idWidth, this.idHeight);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.idFbo = fbo;
    this.idColorTex = tex;
    this.idDepthRb = depth;
  }

  private setClipUniforms(program: Program, clip: SectionClip): void {
    const gl = this.gl;
    gl.uniform1i(program.uniforms.uClipEnabled!, clip.enabled ? 1 : 0);
    gl.uniform3f(program.uniforms.uClipNormal!, clip.normal[0], clip.normal[1], clip.normal[2]);
    gl.uniform1f(program.uniforms.uClipOffset!, clip.offset);
  }

  render(frame: SceneFrame): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(frame.background[0], frame.background[1], frame.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Lit (shaded) triangle batches.
    gl.useProgram(this.lit.program);
    gl.uniformMatrix4fv(this.lit.uniforms.uViewProj!, false, frame.viewProj);
    this.setClipUniforms(this.lit, frame.clip);
    for (const batch of frame.lit) {
      gl.depthMask(batch.depthWrite);
      if (batch.depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      if (batch.polygonOffset) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1, 1);
      } else {
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      if (batch.alpha < 1) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        gl.disable(gl.BLEND);
      }
      gl.uniform3f(this.lit.uniforms.uColor!, batch.color[0], batch.color[1], batch.color[2]);
      gl.uniform1f(this.lit.uniforms.uAlpha!, batch.alpha);
      this.drawTriPositionsNormals(this.lit, batch.positions, batch.normals);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);

    // Flat batches (lines + overlays), in order (grid/axes first, then edges, then highlights).
    gl.useProgram(this.flat.program);
    gl.uniformMatrix4fv(this.flat.uniforms.uViewProj!, false, frame.viewProj);
    this.setClipUniforms(this.flat, frame.clip);
    let clipOn = frame.clip.enabled;
    for (const batch of frame.flat) {
      const wantClip = frame.clip.enabled && !batch.noClip;
      if (wantClip !== clipOn) {
        gl.uniform1i(this.flat.uniforms.uClipEnabled!, wantClip ? 1 : 0);
        clipOn = wantClip;
      }
      if (batch.depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.drawFlatPositionsColors(this.flat, batch.positions, batch.colors, batch.mode);
    }
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private drawTriPositionsNormals(
    program: Program,
    positions: Float32Array,
    normals: Float32Array,
  ): void {
    const gl = this.gl;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(program.attribs.aPosition!);
    gl.vertexAttribPointer(program.attribs.aPosition!, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuffer2);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(program.attribs.aNormal!);
    gl.vertexAttribPointer(program.attribs.aNormal!, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  private drawFlatPositionsColors(
    program: Program,
    positions: Float32Array,
    colors: Float32Array,
    mode: 'lines' | 'triangles',
  ): void {
    const gl = this.gl;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(program.attribs.aPosition!);
    gl.vertexAttribPointer(program.attribs.aPosition!, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuffer2);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(program.attribs.aColor!);
    gl.vertexAttribPointer(program.attribs.aColor!, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(mode === 'lines' ? gl.LINES : gl.TRIANGLES, 0, vertexCount);
  }

  /** Renders the id pass into the offscreen framebuffer; call {@link readPickPixel} afterwards. */
  renderPicking(viewProj: Float32Array, batches: IdBatch[], clip: SectionClip): void {
    const gl = this.gl;
    this.ensureIdFbo(gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    gl.viewport(0, 0, this.idWidth, this.idHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.useProgram(this.idProgram.program);
    gl.uniformMatrix4fv(this.idProgram.uniforms.uViewProj!, false, viewProj);
    this.setClipUniforms(this.idProgram, clip);
    let onTop = false;
    for (const batch of batches) {
      const vertexCount = batch.positions.length / 3;
      if (vertexCount === 0) continue;
      if ((batch.onTop ?? false) !== onTop) {
        onTop = batch.onTop ?? false;
        if (onTop) gl.disable(gl.DEPTH_TEST);
        else gl.enable(gl.DEPTH_TEST);
        gl.uniform1i(this.idProgram.uniforms.uClipEnabled!, clip.enabled && !onTop ? 1 : 0);
      }
      const r = batch.id & 0xff;
      const g = (batch.id >>> 8) & 0xff;
      const b = (batch.id >>> 16) & 0xff;
      const a = (batch.id >>> 24) & 0xff;
      gl.uniform4f(this.idProgram.uniforms.uId!, r / 255, g / 255, b / 255, a / 255);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.idProgram.attribs.aPosition!);
      gl.vertexAttribPointer(this.idProgram.attribs.aPosition!, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(batch.mode === 'lines' ? gl.LINES : gl.TRIANGLES, 0, vertexCount);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Reads the whole id framebuffer (bottom-left origin rows, RGBA bytes).
   * Dev automation only (anchor lookup) — too slow for per-frame use.
   */
  readPickBuffer(): { width: number; height: number; pixels: Uint8Array } | null {
    const gl = this.gl;
    if (!this.idFbo) return null;
    const pixels = new Uint8Array(this.idWidth * this.idHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idFbo);
    gl.readPixels(0, 0, this.idWidth, this.idHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: this.idWidth, height: this.idHeight, pixels };
  }

  /** Reads back one pixel from the id framebuffer (in framebuffer pixel coordinates, top-left origin flipped to bottom-left internally). */
  readPickPixel(xPx: number, yPx: number): number {
    const gl = this.gl;
    if (!this.idFbo) return 0;
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

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.lit.program);
    gl.deleteProgram(this.flat.program);
    gl.deleteProgram(this.idProgram.program);
    gl.deleteBuffer(this.dynamicBuffer);
    gl.deleteBuffer(this.dynamicBuffer2);
    if (this.idFbo) gl.deleteFramebuffer(this.idFbo);
    if (this.idColorTex) gl.deleteTexture(this.idColorTex);
    if (this.idDepthRb) gl.deleteRenderbuffer(this.idDepthRb);
  }
}
