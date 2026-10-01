/**
 * The sketching module's UI: the sketch chrome (tool pill, constraint and
 * option rows) floating over the viewport, the History-card editor of
 * sketches (driving dimensions), sketch mode in the viewport (camera, the
 * sketch overlay) and what the viewport must know while a sketch is open.
 */
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { useSketchStore } from './session.js';
import { openSketch } from './sketchCommands.js';
import { installLocalFontProvider } from './ui/localFonts.js';
import { SketchChrome } from './ui/SketchChrome.js';
import { SketchParams } from './ui/SketchParams.js';
import { SketchViewportOverlay } from './ui/SketchViewportOverlay.js';

export const sketchingUi = defineModuleUi({
  id: 'sketching',
  // Installed fonts for sketch text (Local Font Access; desktop UI only, headless stays bundled-only).
  install: installLocalFontProvider,
  // Below every other floating chrome (Print mode …): it was drawn right after the tool pill.
  panels: [{ id: 'sketch', slot: 'overlay', order: 10, component: () => <SketchChrome /> }],
  historyCards: [
    {
      kinds: ['sketch'],
      component: ({ feature, state, className, fullClassName }) => (
        <SketchParams
          feature={feature as SketchFeature}
          state={state}
          className={className}
          fullClassName={fullClassName}
        />
      ),
    },
  ],
  viewportDomOverlays: [{ id: 'sketch', order: 10, component: SketchViewportOverlay }],
  viewportModes: [
    {
      id: 'sketch',
      // The sketch being edited is drawn by the sketch overlay, not by the scene.
      hiddenFeatureIds: () => {
        const editing = useSketchStore.getState().session?.featureId;
        return editing ? [editing] : [];
      },
      ownsKeyboard: () => useSketchStore.getState().session !== null,
      // Double-clicking a sketch opens it in sketch mode (Shapr3D).
      openOnDoubleClick: (pick) => {
        // A double-clicked curve opens its sketch with that curve selected (SEL-12).
        if (pick.kind === 'sketchCurve') {
          openSketch(pick.featureId, [pick.entityId]);
          return true;
        }
        if (pick.kind !== 'sketchProfile') return false;
        useSketchStore.getState().begin({ featureId: pick.featureId });
        return true;
      },
    },
  ],
});
