/**
 * Section › Face in the viewport: while the prompt is on
 * (`viewportUi.sectionFacePick`), the next click on a planar face sets the
 * section plane (`sectionAtFace`); any other click asks for a planar face.
 */
import { notify } from '../../foundation/commands/notices.js';
import { isPlanarFace } from '../../foundation/commands/store.js';
import type { ViewportClickHandler } from '../../platform/viewport/viewportHooks.js';
import { useViewportUi } from '../../platform/viewport/viewportUi.js';
import { sectionAtFace } from './displayCommands.js';

export const SECTION_FACE_CLICK: ViewportClickHandler = {
  id: 'display.sectionFace',
  order: 200,
  click: ({ state, pick }) => {
    if (!useViewportUi.getState().sectionFacePick) return false;
    if (pick?.kind === 'face' && isPlanarFace(state.evaluation, pick.bodyId, pick.faceKey)) {
      sectionAtFace(state, pick.bodyId, pick.faceKey);
      useViewportUi.getState().setSectionFacePick(false);
    } else {
      notify('Click a planar face for the section plane.');
    }
    return true;
  },
};
