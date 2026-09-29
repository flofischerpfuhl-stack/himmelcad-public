import { contextBridge, ipcRenderer } from 'electron';

import type { AssemblerApi, ProjectExportFilter } from './assemblerApi';

const api: AssemblerApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  project: {
    openDialog: () => ipcRenderer.invoke('assembler:project:openDialog'),
    saveDialog: (suggestedName: string) =>
      ipcRenderer.invoke('assembler:project:saveDialog', suggestedName),
    save: (path: string, text: string) => ipcRenderer.invoke('assembler:project:save', path, text),
    exportDialog: (suggestedName: string, filters: ProjectExportFilter[]) =>
      ipcRenderer.invoke('assembler:project:exportDialog', suggestedName, filters),
    writeBinary: (path: string, bytes: Uint8Array) =>
      ipcRenderer.invoke('assembler:project:writeBinary', path, bytes),
    readRecovery: () => ipcRenderer.invoke('assembler:project:readRecovery'),
    writeRecovery: (text: string) => ipcRenderer.invoke('assembler:project:writeRecovery', text),
    clearRecovery: () => ipcRenderer.invoke('assembler:project:clearRecovery'),
    onCloseRequested: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on('assembler:project:close-requested', handler);
      return () => ipcRenderer.removeListener('assembler:project:close-requested', handler);
    },
    respondClose: (allow: boolean) => ipcRenderer.invoke('assembler:project:respondClose', allow),
    onOpenRequested: (listener: (path: string, text: string) => void) => {
      const handler = (_event: unknown, path: string, text: string) => listener(path, text);
      ipcRenderer.on('assembler:project:open-requested', handler);
      // The file this instance was launched with, delivered once a listener exists.
      void ipcRenderer
        .invoke('assembler:project:takePendingOpen')
        .then((opened: { path: string; text: string } | null) => {
          if (opened) listener(opened.path, opened.text);
        });
      return () => ipcRenderer.removeListener('assembler:project:open-requested', handler);
    },
  },
  recentFiles: {
    list: () => ipcRenderer.invoke('assembler:recentFiles:list'),
    remove: (path: string) => ipcRenderer.invoke('assembler:recentFiles:remove', path),
    openPath: (path: string) => ipcRenderer.invoke('assembler:recentFiles:openPath', path),
    locate: (oldPath: string) => ipcRenderer.invoke('assembler:recentFiles:locate', oldPath),
  },
  slicers: {
    list: () => ipcRenderer.invoke('assembler:slicers:list'),
    add: () => ipcRenderer.invoke('assembler:slicers:add'),
    remove: (id: string) => ipcRenderer.invoke('assembler:slicers:remove', id),
    setDefault: (id: string) => ipcRenderer.invoke('assembler:slicers:setDefault', id),
    open: (id: string, bytes: Uint8Array, projectName: string) =>
      ipcRenderer.invoke('assembler:slicers:open', id, bytes, projectName),
  },
  automation: {
    status: () => ipcRenderer.invoke('assembler:automation:status'),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('assembler:automation:setEnabled', enabled),
    onRequest: (listener: (id: string, body: string) => void) => {
      const handler = (_event: unknown, id: string, body: string) => listener(id, body);
      ipcRenderer.on('assembler:automation:request', handler);
      return () => ipcRenderer.removeListener('assembler:automation:request', handler);
    },
    respond: (id: string, body: string) =>
      ipcRenderer.invoke('assembler:automation:respond', id, body),
  },
};

contextBridge.exposeInMainWorld('assembler', api);
