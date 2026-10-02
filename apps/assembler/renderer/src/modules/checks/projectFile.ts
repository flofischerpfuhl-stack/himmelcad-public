/**
 * Stored checks in the project file: the optional top-level `.hcasm` field
 * `checks` (assembler/CHECKS.md "File format"). Additive like every Block 8
 * field — no schema bump: a file without it has no checks, older apps
 * ignore it (and drop it on their next save).
 *
 * Validation is strict about the structure (id, kind, params object, no
 * duplicate ids: a malformed entry rejects the file like any corrupt field)
 * and lenient about the parameters: a kind this build does not know, or
 * parameters a newer build added, are kept unchanged and round-trip; such a
 * check is reported as unsupported or erroneous in the panel and in
 * `checks.run`, never a reason to refuse the model.
 */
import { useAssemblerStore } from '../../foundation/commands/store.js';
import {
  MAX_CHECKS,
  normalizeStoredCheck,
  storedCheckProblem,
  type StoredCheck,
} from '../../foundation/document/checks.js';
import { registerProjectFileField } from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';

declare module '../../foundation/document/format.js' {
  interface ProjectFileFields {
    /** Stored checks (`document/checks.ts`). */
    checks?: StoredCheck[];
  }
}

registerProjectFileField({
  key: 'checks',
  module: 'checks',
  order: 120,
  validate: (raw, { fail }) => {
    if (!Array.isArray(raw)) fail('checks', 'expected an array');
    const list = raw as unknown[];
    if (list.length > MAX_CHECKS) fail('checks', `at most ${MAX_CHECKS} checks`);
    const ids = new Set<string>();
    return list.map((entry, i) => {
      const problem = storedCheckProblem(entry);
      if (problem) fail(`checks[${i}]${problem.path}`, problem.message);
      const check = entry as StoredCheck;
      if (ids.has(check.id)) fail('checks', `duplicate check id "${check.id}"`);
      ids.add(check.id);
      return normalizeStoredCheck(check);
    });
  },
  include: (checks) => checks.length > 0,
});

export const CHECKS_PROJECT_SECTION: ProjectSection = {
  id: 'checks',
  order: 120,
  save: () => {
    const checks = useAssemblerStore.getState().checks;
    return checks.length > 0 ? { fields: { checks: checks.map(normalizeStoredCheck) } } : {};
  },
  // Opened and new projects start their undo history empty (`loadDocument`); the checks are
  // part of the opened state, not an undo step.
  load: (project) => useAssemblerStore.setState({ checks: project?.checks ?? [] }),
  subscribe: (onChange) =>
    useAssemblerStore.subscribe((state, prev) => {
      if (state.checks !== prev.checks) onChange();
    }),
};
