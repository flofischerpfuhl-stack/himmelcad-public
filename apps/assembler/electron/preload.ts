import { contextBridge } from 'electron';

import type { AssemblerApi } from './assemblerApi';

const api: AssemblerApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('assembler', api);
