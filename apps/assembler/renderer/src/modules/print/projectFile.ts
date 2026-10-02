/**
 * Printability findings the user ignored in this document ("Ignore here",
 * "Mark as intended" for an overlap), saved as the optional top-level
 * `.hcasm` field `printIgnored` (finding ids, `analysis.ts` `PrintFinding.id`).
 * Additive: older apps ignore the field; a file without it ignores nothing.
 * Not undo-tracked (like pinned measurements); changing it makes the
 * project unsaved.
 */
import { registerProjectFileField } from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';
import { usePrintStore } from './printStore.js';

declare module '../../foundation/document/format.js' {
  interface ProjectFileFields {
    /** Ids of printability findings ignored in this document. */
    printIgnored?: string[];
  }
}

/** Upper bound of ignored findings kept in a file. */
export const MAX_IGNORED_FINDINGS = 5000;

registerProjectFileField({
  key: 'printIgnored',
  module: 'print',
  order: 130,
  validate: (raw, { fail, isString }) => {
    if (!Array.isArray(raw)) fail('printIgnored', 'expected an array of finding ids');
    const list = raw as unknown[];
    if (list.length > MAX_IGNORED_FINDINGS) {
      fail('printIgnored', `at most ${MAX_IGNORED_FINDINGS} entries`);
    }
    list.forEach((id, i) => {
      if (!isString(id) || id.length === 0 || id.length > 500) {
        fail(`printIgnored[${i}]`, 'expected a finding id');
      }
    });
    return [...new Set(list as string[])];
  },
  include: (ids) => ids.length > 0,
});

export const PRINT_PROJECT_SECTION: ProjectSection = {
  id: 'print.ignored',
  order: 160,
  save: () => {
    const ignored = usePrintStore.getState().ignored;
    return ignored.length > 0 ? { fields: { printIgnored: [...ignored] } } : {};
  },
  load: (project) => usePrintStore.getState().setIgnored(project?.printIgnored ?? []),
  subscribe: (onChange) =>
    usePrintStore.subscribe((state, prev) => {
      if (state.ignored !== prev.ignored) onChange();
    }),
};
