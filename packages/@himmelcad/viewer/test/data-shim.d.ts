declare module '@himmelcad/data' {
  export interface Bounds3 {
    readonly min: { x: number; y: number; z: number };
    readonly max: { x: number; y: number; z: number };
  }

  export type GeometryDatasetKind =
    | 'camera'
    | 'point-cloud'
    | 'mesh'
    | 'textured-mesh'
    | 'dgm'
    | 'surface'
    | 'splat'
    | 'cad'
    | 'grid'
    | 'fallback';
}
