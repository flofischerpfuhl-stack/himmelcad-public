import type { BrowserWindow, IpcMain } from 'electron';

import type {
  AutomationRpcRouter,
  DesktopAgentHarnessHostTransport,
  ManagedPythonHost,
  ProviderAuthorizationRequest,
  ProviderEgressManifest,
} from './index';
import type { ProviderCredentialStore } from './provider-credentials';

export interface ElectronAutomationHostOptions {
  readonly ipcMain: IpcMain;
  readonly getWindow: () => BrowserWindow | null;
  readonly sidecarCall: (method: string, params: unknown) => Promise<unknown>;
  readonly issueConfirmationGrant: (planHash: string) => string;
  readonly runtimeRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceCapabilityId: string;
  readonly rendererUrl: string;
  readonly approvedPath?: string;
  readonly providerEgressManifest?: ProviderEgressManifest;
  readonly getAuthorization?: (
    request: ProviderAuthorizationRequest,
  ) => Promise<string | Buffer | null>;
  readonly authorizationAvailable?: (request: ProviderAuthorizationRequest) => Promise<boolean>;
  readonly providerCredentialStore?: ProviderCredentialStore;
}

export function registerElectronAutomationHost(options: ElectronAutomationHostOptions): {
  readonly router: AutomationRpcRouter;
  readonly harness: DesktopAgentHarnessHostTransport;
  readonly python: ManagedPythonHost;
  readonly ready: Promise<void>;
  invalidateAgentSessions(): Promise<void>;
  dispose(): Promise<void>;
};

export function defaultAutomationPaths(
  repositoryRoot: string,
  applicationDataRoot: string,
  platform?: NodeJS.Platform,
): { readonly runtimeRoot: string; readonly workspaceRoot: string };
