/// <reference lib="webworker" />

interface DecodeModule {
  readonly default?: () => Promise<unknown>;
  decode_worker_linear_memory_bytes(): number;
  decode_streaming_payload(
    kind: string,
    metadataJson: string,
    primary: Uint8Array,
    bundleManifestJson: string,
    bundle: Uint8Array,
    secondary: Uint8Array,
    decodeParametersJson: string,
  ): Uint8Array;
}

let moduleUrl = '';
let modulePromise: Promise<DecodeModule> | null = null;
let loadedModule: DecodeModule | null = null;
let baselineLinearMemoryBytes = 0;

self.onmessage = (event: MessageEvent<{
  kind: 'decode'; id: number; wasmModuleUrl: string; job: {
    kind: string; metadataJson: string; bundleManifestJson: string;
    decodeParametersJson: string; primary: ArrayBuffer; bundle: ArrayBuffer;
    secondary: ArrayBuffer;
  };
}>) => {
  const { id, wasmModuleUrl, job } = event.data;
  const started = performance.now();
  void decode(wasmModuleUrl, job).then((result) => {
    self.postMessage({ kind: 'decoded', id, ...result }, [
      result.artifact, result.primary, result.bundle, result.secondary,
    ]);
  }, (error: unknown) => {
    const failure = {
      kind: 'failed',
      id,
      message: error instanceof Error ? error.message : String(error),
      primary: job.primary,
      bundle: job.bundle,
      secondary: job.secondary,
      workerDurationMs: performance.now() - started,
      workerContext: typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope,
      workerBaselineLinearMemoryBytes: baselineLinearMemoryBytes,
      workerLinearMemoryBytes: loadedModule?.decode_worker_linear_memory_bytes() ?? 0,
    } as const;
    self.postMessage(failure, [failure.primary, failure.bundle, failure.secondary]);
  });
};

async function decode(wasmModuleUrl: string, job: {
  kind: string; metadataJson: string; bundleManifestJson: string;
  decodeParametersJson: string; primary: ArrayBuffer; bundle: ArrayBuffer;
  secondary: ArrayBuffer;
}): Promise<{
  artifact: ArrayBuffer; primary: ArrayBuffer; bundle: ArrayBuffer;
  secondary: ArrayBuffer; workerDurationMs: number;
  workerContext: boolean;
  workerBaselineLinearMemoryBytes: number;
  workerLinearMemoryBytes: number;
}> {
  if (modulePromise === null || moduleUrl !== wasmModuleUrl) {
    moduleUrl = wasmModuleUrl;
    modulePromise = import(/* @vite-ignore */ wasmModuleUrl).then(async (value: unknown) => {
      const module = value as DecodeModule;
      if (module.default !== undefined) await module.default();
      loadedModule = module;
      baselineLinearMemoryBytes = module.decode_worker_linear_memory_bytes();
      return module;
    });
  }
  const module = await modulePromise;
  const started = performance.now();
  const bytes = module.decode_streaming_payload(
    job.kind,
    job.metadataJson,
    new Uint8Array(job.primary),
    job.bundleManifestJson,
    new Uint8Array(job.bundle),
    new Uint8Array(job.secondary),
    job.decodeParametersJson,
  );
  const artifact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : bytes.slice().buffer;
  return {
    artifact,
    primary: job.primary,
    bundle: job.bundle,
    secondary: job.secondary,
    workerDurationMs: performance.now() - started,
    workerContext: typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope,
    workerBaselineLinearMemoryBytes: baselineLinearMemoryBytes,
    workerLinearMemoryBytes: module.decode_worker_linear_memory_bytes(),
  };
}
