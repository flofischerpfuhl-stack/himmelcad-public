import { ShaderMaterial, Texture } from 'three';
import { IUniform } from './types';

// Himmelcad vendor patch: webpack `require('./shaders/*.vert')` → Vite-style
// `?raw` imports so the source compiles under our Vite/tsc pipeline. See
// vendor/three-loader/VENDOR.md.
import blurVertSource from './shaders/blur.vert?raw';
import blurFragSource from './shaders/blur.frag?raw';

// see http://john-chapman-graphics.blogspot.co.at/2013/01/ssao-tutorial.html

export interface IBlurMaterialUniforms {
  [name: string]: IUniform<any>;
  screenWidth: IUniform<number>;
  screenHeight: IUniform<number>;
  map: IUniform<Texture | null>;
}

export class BlurMaterial extends ShaderMaterial {
  vertexShader = blurVertSource;
  fragmentShader = blurFragSource;
  uniforms: IBlurMaterialUniforms = {
    screenWidth: { type: 'f', value: 0 },
    screenHeight: { type: 'f', value: 0 },
    map: { type: 't', value: null },
  };
}
