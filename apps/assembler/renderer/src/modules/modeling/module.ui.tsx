/**
 * The modelling module's UI: the History-card editors of its kinds and of
 * the core fillet/chamfer/shell/boolean kinds whose variant options it owns
 * (`ui/FeatureParams.tsx`, `ui/PrintFeatureParams.tsx`), the icons of its
 * kinds and commands, and the viewport side of its tools (`viewportTools.ts`).
 */
import { BlendParams, BooleanParams, ShellParams } from './ui/PrintFeatureParams.js';
import { ModelingFeatureParams } from './ui/FeatureParams.js';
import type {
  BooleanFeature,
  ChamferFeature,
  FilletFeature,
  ShellFeature,
} from '../../foundation/document/document.js';
import { MODELING_FEATURE_KINDS, type ModelingFeature } from './features.js';
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { MODELING_COMMAND_ICON, MODELING_FEATURE_ICON } from './ui/featureIcons.js';
import { MODELING_VIEWPORT_TOOLS } from './viewportTools.js';

export const modelingUi = defineModuleUi({
  id: 'modeling',
  featureIcons: MODELING_FEATURE_ICON,
  commandIcons: MODELING_COMMAND_ICON,
  viewportTools: MODELING_VIEWPORT_TOOLS,
  historyCards: [
    {
      kinds: MODELING_FEATURE_KINDS,
      component: ({ feature, state }) => (
        <ModelingFeatureParams feature={feature as ModelingFeature} state={state} />
      ),
    },
    {
      kinds: ['fillet', 'chamfer'],
      component: ({ feature, state }) => (
        <BlendParams feature={feature as FilletFeature | ChamferFeature} state={state} />
      ),
    },
    {
      kinds: ['shell'],
      component: ({ feature, state }) => (
        <ShellParams feature={feature as ShellFeature} state={state} />
      ),
    },
    {
      kinds: ['boolean'],
      component: ({ feature, state }) => (
        <BooleanParams feature={feature as BooleanFeature} state={state} />
      ),
    },
  ],
});
