/**
 * One-shot camera instructions for the viewport from code below the shell
 * (a module frames what it just selected). The shell owns the channel's
 * state (`interface/shell-ui/workspace.ts` `cameraCommand`) and installs
 * the sink (`interface/shell-ui/module.ts`).
 */
import type { SelectionItem } from '../../foundation/commands/store.js';
import type { CameraPose } from './camera.js';
import type { Vec3 } from './math.js';

/** One-shot camera instruction for the viewport (applied once per `nonce`). */
export type CameraCommand =
  | { kind: 'home' }
  | { kind: 'fitAll' }
  /** Frames the selection (or everything when nothing is selected). */
  | { kind: 'fitSelection' }
  /** Frames these items without selecting them (History card "Zoom to"). */
  | { kind: 'fitItems'; items: SelectionItem[] }
  | { kind: 'direction'; direction: Vec3 }
  | { kind: 'roll'; degrees: number }
  | { kind: 'pose'; pose: CameraPose }
  /** Looks straight at a face and frames it (Space over a face). */
  | { kind: 'lookAtFace'; bodyId: string; faceKey: string }
  /** Looks along `-direction` (eye on the `direction` side) and frames the visible model (Look at section). */
  | { kind: 'lookAlong'; direction: Vec3 };

let sink: (command: CameraCommand) => void = () => undefined;

/** Sends a camera instruction to the viewport. */
export function sendCamera(command: CameraCommand): void {
  sink(command);
}

/** The shell's channel (installed once by the shell module). */
export function setCameraSink(send: (command: CameraCommand) => void): void {
  sink = send;
}
