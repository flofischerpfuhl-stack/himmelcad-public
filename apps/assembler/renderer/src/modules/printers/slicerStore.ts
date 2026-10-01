/** Registered slicers as the renderer sees them (desktop only; see `electron/slicerIpc.ts`). */
import { create } from 'zustand';

import { notify } from '../../foundation/commands/notices.js';
import { openInSlicer } from './handoff.js';

type SlicersApi = NonNullable<Window['assembler']>['slicers'];
type SlicerListInfo = Awaited<ReturnType<SlicersApi['list']>>;
type SlicerInfo = SlicerListInfo['slicers'][number];

export interface SlicerState {
  /** `false` in the browser build (no main process: "Open in slicer" downloads the 3MF). */
  available: boolean;
  slicers: SlicerInfo[];
  defaultId: string | null;
  loaded: boolean;
  busy: boolean;
  message: { text: string; tone: 'info' | 'warning' } | null;
  refresh: () => Promise<void>;
  add: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  /** The Slicers… dialog. */
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Hands the model to `id` (default slicer when omitted). */
  open: (id?: string) => Promise<void>;
}

function api() {
  return typeof window !== 'undefined' ? window.assembler?.slicers : undefined;
}

export const useSlicerStore = create<SlicerState>((set, get) => {
  const apply = (info: SlicerListInfo) =>
    set({ slicers: info.slicers, defaultId: info.defaultId, loaded: true });
  return {
    available: api() !== undefined,
    slicers: [],
    defaultId: null,
    loaded: false,
    busy: false,
    message: null,
    dialogOpen: false,
    setDialogOpen: (open) => set({ dialogOpen: open }),
    refresh: async () => {
      const slicers = api();
      if (!slicers) {
        set({ loaded: true });
        return;
      }
      apply(await slicers.list());
    },
    add: async () => {
      const slicers = api();
      if (!slicers) return;
      const result = await slicers.add();
      apply(result);
      set({ message: result.error ? { text: result.error, tone: 'warning' } : null });
    },
    remove: async (id) => {
      const slicers = api();
      if (slicers) apply(await slicers.remove(id));
    },
    setDefault: async (id) => {
      const slicers = api();
      if (slicers) apply(await slicers.setDefault(id));
    },
    open: async (id) => {
      if (get().busy) return;
      set({ busy: true, message: null });
      try {
        if (api() && !get().loaded) await get().refresh();
        const target = id ?? get().defaultId;
        const result = await openInSlicer(target);
        set({ message: { text: result.message, tone: result.ok ? 'info' : 'warning' } });
        notify(result.message, result.ok ? 'info' : 'warning');
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        set({ message: { text, tone: 'warning' } });
        notify(text, 'warning');
      } finally {
        set({ busy: false });
      }
    },
  };
});
