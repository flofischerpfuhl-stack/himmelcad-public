import type { AssemblerApi } from '../../electron/assemblerApi';

declare global {
  interface Window {
    readonly assembler?: AssemblerApi;
  }
}

export {};
