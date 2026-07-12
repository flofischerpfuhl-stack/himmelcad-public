import { GLSL3, ShaderMaterial } from 'three';

/**
 * Shader that encodes a per-vertex point id into RGBA8.
 *
 * Layout per fragment:
 *   R/G/B = (gl_VertexID & 0xFFFFFF) split into three 8-bit channels.
 *   A     = `uDrawId` mapped to a small (per-frame) layer registry.
 *
 * Combined: 24 bits for the point index inside a single layer (up to ~16 M
 * points per layer per frame) plus 8 bits for the layer slot (up to 256
 * layers in the same pick pass). Sufficient for the foreseeable workloads;
 * MRT can be added later for unlimited point/layer counts.
 *
 * Requires WebGL 2 / GLSL 3 because it relies on `gl_VertexID`.
 */
export class PointCloudPickMaterial extends ShaderMaterial {
  constructor() {
    super({
      glslVersion: GLSL3,
      uniforms: {
        uDrawId: { value: 0 },
        uPointSize: { value: 2.0 },
      },
      vertexShader: /* glsl */ `
        in vec3 position;
        flat out int vPointId;
        uniform float uPointSize;
        void main() {
          vPointId = gl_VertexID;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPointSize;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        layout(location = 0) out vec4 outColor;
        flat in int vPointId;
        uniform float uDrawId;
        void main() {
          int pi = vPointId;
          float r = float(pi & 0xFF) / 255.0;
          float g = float((pi >> 8) & 0xFF) / 255.0;
          float b = float((pi >> 16) & 0xFF) / 255.0;
          outColor = vec4(r, g, b, uDrawId / 255.0);
        }
      `,
      depthTest: true,
      depthWrite: true,
      transparent: false,
    });
  }

  setDrawId(drawId: number): void {
    if (this.uniforms.uDrawId) this.uniforms.uDrawId.value = drawId;
  }

  setPointSize(size: number): void {
    if (this.uniforms.uPointSize) this.uniforms.uPointSize.value = size;
  }
}
