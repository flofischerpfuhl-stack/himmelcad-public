import {
  CanonicalProjectClient,
  IoClient,
  RegistrationClient,
  negotiateAppProtocol,
  type AppFacadeMethods,
  type JsonValue,
  type RegistrationIcpOptions,
  type RegistrationPoint,
  type RegistrationPointPair,
  type RegistrationRecipe,
  type RegistrationSimilarity3d,
  type RegistrationTargetSample,
  type RpcRequestOptions,
  type RpcTransport,
} from '@himmelcad/app';

type SidecarCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

class PhotolabSidecarTransport implements RpcTransport<AppFacadeMethods> {
  constructor(private readonly call: SidecarCall) {}

  request<Key extends keyof AppFacadeMethods>(
    method: Key,
    request: AppFacadeMethods[Key]['request'],
    _options?: RpcRequestOptions,
  ): Promise<AppFacadeMethods[Key]['response']> {
    return this.call<AppFacadeMethods[Key]['response']>(method, request);
  }
}

/** Thin PhotoLab host over the app-neutral canonical I/O and registration facades. */
export class PhotolabExternalImportSession {
  private constructor(
    private readonly io: IoClient,
    private readonly registration: RegistrationClient,
  ) {}

  static async open(
    projectRoot: string,
    call: SidecarCall,
  ): Promise<PhotolabExternalImportSession> {
    const transport = new PhotolabSidecarTransport(call);
    const negotiated = await negotiateAppProtocol(transport, {
      clientName: 'himmelcad-photolab-external-import',
      supportedVersions: [1],
      optionalCapabilities: [],
      requiredCapabilities: ['io.formats.read', 'io.probe', 'registration.import'],
    });
    await new CanonicalProjectClient(transport).open(projectRoot);
    return new PhotolabExternalImportSession(
      new IoClient(transport, negotiated),
      new RegistrationClient(transport, negotiated),
    );
  }

  listFormats() {
    return this.io.listAllFormats();
  }

  probe(sourcePath: string) {
    return this.io.probe({ sourcePath });
  }

  async stage(sourcePath: string, recipe: RegistrationRecipe, options: JsonValue = {}) {
    const selection = await this.io.probe({ sourcePath });
    return this.registration.stage({
      sessionId: `photolab-registration-${crypto.randomUUID()}`,
      commandId: `photolab-external-import-${crypto.randomUUID()}`,
      sourcePath,
      selection,
      options,
      recipe,
    });
  }

  previewPointPairs(sessionId: string, pairs: readonly RegistrationPointPair[]) {
    return this.registration.previewPointPairs(sessionId, pairs);
  }

  previewIcp(input: {
    readonly sessionId: string;
    readonly source: readonly RegistrationPoint[];
    readonly target: readonly RegistrationTargetSample[];
    readonly initial: RegistrationSimilarity3d;
    readonly mode: 'pointToPoint' | 'pointToPlane';
    readonly options: RegistrationIcpOptions;
  }) {
    return this.registration.previewIcp(input);
  }

  sourceSamples(sessionId: string) {
    return this.registration.sourceSamples(sessionId);
  }

  projectPointCloudSamples(datasetId: string, maximumSamples = 2_048) {
    return this.registration.projectPointCloudSamples(datasetId, maximumSamples);
  }

  inspectTransform(path: string) {
    return this.registration.inspectSiteCalibration(path);
  }

  commit(sessionId: string) {
    return this.registration.commit(sessionId);
  }

  cancel(sessionId: string) {
    return this.registration.cancel(sessionId);
  }
}
