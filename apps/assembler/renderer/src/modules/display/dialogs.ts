/**
 * Which display dialog is open: the body colour dialog (Items row menu,
 * context menu, command search "Colour…") and File › Export image….
 * Session-only UI state; nothing here is saved or undoable.
 */
import { create } from 'zustand';

export interface DisplayDialogsState {
  /** Body colour dialog for these bodies (`null` = closed). */
  colourDialogBodyIds: string[] | null;
  setColourDialog: (bodyIds: string[] | null) => void;
  exportImageOpen: boolean;
  setExportImageOpen: (open: boolean) => void;
}

export const useDisplayDialogs = create<DisplayDialogsState>((set) => ({
  colourDialogBodyIds: null,
  setColourDialog: (bodyIds) => set({ colourDialogBodyIds: bodyIds }),
  exportImageOpen: false,
  setExportImageOpen: (open) => set({ exportImageOpen: open }),
}));
