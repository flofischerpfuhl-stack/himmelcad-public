/** The sketching module's UI: the History-card editor of sketches (driving dimensions). */
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { SketchParams } from '../../sketch/ui/SketchParams.js';

export const sketchingUi = defineModuleUi({
  id: 'sketching',
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
});
