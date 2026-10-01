/**
 * Pinned measurements in the project file (`viewState.measurements`): they
 * are references, re-measured on every change; malformed entries are
 * dropped on load. Pinning and unpinning make the project unsaved.
 */
import { registerViewStatePart } from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';
import { parsePins, serializePins, useMeasureStore } from './measureStore.js';

declare module '../../foundation/document/format.js' {
  interface ProjectViewState {
    /** Pinned measurements (`PinnedMeasurement` without ids); malformed entries are dropped on load. */
    measurements?: unknown[];
  }
}

// After the section, before the grid, as always.
registerViewStatePart({ key: 'measurements', module: 'measure', order: 400 });

export const MEASURE_PROJECT_SECTION: ProjectSection = {
  id: 'measure.pins',
  order: 300,
  save: () => {
    const measurements = serializePins(useMeasureStore.getState().pins);
    return measurements.length > 0 ? { viewState: { measurements } } : {};
  },
  load: (project) =>
    useMeasureStore.getState().setPins(parsePins(project?.viewState?.measurements)),
  subscribe: (onChange) =>
    useMeasureStore.subscribe((state, prev) => {
      if (state.pins !== prev.pins) onChange();
    }),
};
