/**
 * The interop module's UI: the window-wide drop target, the import progress
 * island and the import/export dialogs, floating over the viewport.
 */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { InteropChrome } from './ui/InteropChrome.js';

export const interopUi = defineModuleUi({
  id: 'interop',
  panels: [{ id: 'interop', slot: 'overlay', order: 300, component: InteropChrome }],
});
