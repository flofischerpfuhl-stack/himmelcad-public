/** The printers module's UI: the Slicers… dialog. */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { SlicerDialog } from './ui/SlicerDialog.js';

export const printersUi = defineModuleUi({
  id: 'printers',
  panels: [{ id: 'slicers', slot: 'overlay', order: 110, component: SlicerDialog }],
});
