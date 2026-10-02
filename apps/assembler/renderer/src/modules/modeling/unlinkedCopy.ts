/**
 * Unlinked copies (Shapr3D Move/Rotate: "a Link badge can detach copies
 * from the history", MOD-16). A linked copy is a `transform` step with
 * `copy`: it follows every later change of the steps before it. An
 * unlinked copy is the copy's exact B-rep at the moment it was made, kept
 * in the project like an imported part — an `importStep` step holding the
 * STEP text of that copy (name and colour included) — so editing the
 * original's earlier steps no longer changes it.
 *
 * No new document kind: older builds read the step as an import. Used by
 * the Move/Rotate tool's Link badge (`tools.ts`) and the agent API
 * (`body.copyUnlinked`, `api.ts`).
 */
import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import {
  bodyIdFor,
  type Feature,
  type ImportStepFeature,
} from '../../foundation/document/document.js';
import type { TransformFeature } from './features.js';

/** The fields of a Move/Rotate copy (`transform` without id, name, suppressed). */
export type CopyMotion = Pick<
  TransformFeature,
  'bodyId' | 'dx' | 'dy' | 'dz' | 'rx' | 'ry' | 'rz' | 'pivot'
>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * The step of an unlinked copy of `motion.bodyId` moved by `motion`: the
 * copy is evaluated after `features` and written as STEP by the kernel.
 * Rejects with the kernel's message when the copy cannot be made.
 */
export async function unlinkedCopyFeature(
  kernel: Pick<KernelAdapter, 'exportStep'>,
  features: readonly Feature[],
  motion: CopyMotion,
  base: { id: string; name: string; bodyName: string },
): Promise<ImportStepFeature> {
  const source: TransformFeature = {
    id: `${base.id}-source`,
    name: base.name,
    suppressed: false,
    kind: 'transform',
    ...motion,
    copy: true,
  };
  const bytes = await kernel.exportStep([...features, source], [bodyIdFor(source.id)]);
  if (bytes.length === 0) throw new Error('The copy could not be written');
  return {
    id: base.id,
    name: base.name,
    suppressed: false,
    kind: 'importStep',
    data: bytesToBase64(bytes),
    fileName: `${base.bodyName}.step`,
    structure: 'assembly',
  };
}
