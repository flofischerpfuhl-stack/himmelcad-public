import { contextBridge } from 'electron';

interface HimmelcadApi {
  readonly version: string;
}

const api: HimmelcadApi = {
  version: '0.0.0',
};

contextBridge.exposeInMainWorld('himmelcad', api);
