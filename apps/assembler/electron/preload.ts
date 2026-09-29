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
  },
  recentFiles: {
    list: () => ipcRenderer.invoke('assembler:recentFiles:list'),
    remove: (path: string) => ipcRenderer.invoke('assembler:recentFiles:remove', path),
    openPath: (path: string) => ipcRenderer.invoke('assembler:recentFiles:openPath', path),
    locate: (oldPath: string) => ipcRenderer.invoke('assembler:recentFiles:locate', oldPath),
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
