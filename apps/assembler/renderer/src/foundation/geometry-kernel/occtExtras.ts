/**
 * OCCT classes that only the HimmelCAD OCCT build (`vendor/occt-wasm`,
 * `himmelcad_occt.wasm`) binds; `replicad-opencascadejs` 1.1.0 does not.
 * The kernel detects them at runtime, so the same evaluator runs on either
 * module and falls back to the emulations of the replicad build when they
 * are missing (see `assembler/OCCT-BUILD-SPIKE.md`).
 */
import type { RawShape } from './occt.js';

type Deletable = { delete(): void };
type ShapeList = Deletable & { Size(): number; First(): RawShape; RemoveFirst(): void };

/** Facade over `BRepOffset_MakeOffset` (`vendor/occt-wasm/build-config/wrappers/himmelcad-offset.cpp`). */
export interface HimmelcadOffset extends Deletable {
  Initialize(
    shape: RawShape,
    offset: number,
    tolerance: number,
    mode: number,
    intersection: boolean,
    selfInter: boolean,
    join: number,
    thickening: boolean,
    removeIntEdges: boolean,
  ): void;
  SetOffsetOnFace(face: RawShape, offset: number): void;
  AddFace(face: RawShape): void;
  MakeOffsetShape(): boolean;
  MakeThickSolid(): boolean;
  IsDone(): boolean;
  Shape(): RawShape;
  Error(): number;
  ErrorMessage(): string;
  Generated(shape: RawShape): ShapeList;
  Modified(shape: RawShape): ShapeList;
  IsDeleted(shape: RawShape): boolean;
}

export interface BRepAlgoAPIDefeaturing extends Deletable {
  SetShape(shape: RawShape): void;
  AddFaceToRemove(face: RawShape): void;
  SetRunParallel(parallel: boolean): void;
  SetToFillHistory(fill: boolean): void;
  Build(range: Deletable): void;
  IsDone(): boolean;
  HasErrors(): boolean;
  Shape(): RawShape;
  Modified(shape: RawShape): ShapeList;
  Generated(shape: RawShape): ShapeList;
  IsDeleted(shape: RawShape): boolean;
}

export interface OcctExtras {
  HimmelcadOffset: new () => HimmelcadOffset;
  BRepAlgoAPI_Defeaturing: new () => BRepAlgoAPIDefeaturing;
  IGESControl_Reader: new () => Deletable & {
    ReadFile(path: string): unknown;
    TransferRoots(range: Deletable): number;
    OneShape(): RawShape;
    NbShapes(): number;
  };
  IGESControl_Writer: new (
    unit: string,
    mode: number,
  ) => Deletable & {
    AddShape(shape: RawShape, range: Deletable): boolean;
    ComputeModel(): void;
    Write(path: string, fnes: boolean): boolean;
  };
}

/** `BRepOffset_Mode::BRepOffset_Skin`. */
export const OFFSET_MODE_SKIN = 0;
/** `GeomAbs_JoinType` values. */
export const JOIN_ARC = 0;
export const JOIN_INTERSECTION = 2;

/** The HimmelCAD-only OCCT classes of `oc`, or `null` on the replicad build. */
export function occtExtras(oc: unknown): OcctExtras | null {
  const o = oc as Partial<Record<keyof OcctExtras, unknown>>;
  return typeof o.HimmelcadOffset === 'function' &&
    typeof o.BRepAlgoAPI_Defeaturing === 'function' &&
    typeof o.IGESControl_Reader === 'function' &&
    typeof o.IGESControl_Writer === 'function'
    ? (oc as OcctExtras)
    : null;
}
