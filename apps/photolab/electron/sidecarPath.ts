import { resolve, sep } from 'node:path';

export const SIDECAR_BINARY_OVERRIDE_ENV = 'HIMMELCAD_SIDECAR_BIN';

/**
 * Resolves the development sidecar executable. `HIMMELCAD_SIDECAR_BIN` is a
 * development-only explicit override; relative values are resolved from the
 * repository root. Packaged applications do not call this resolver.
 */
export function resolveDevelopmentSidecarPath(
  repositoryRoot: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment[SIDECAR_BINARY_OVERRIDE_ENV]?.trim();
  if (override) return resolve(repositoryRoot, override);

  const defaultTargetRoot = resolve(repositoryRoot, 'target');
  const configuredTargetRoot = resolve(
    repositoryRoot,
    environment.CARGO_TARGET_DIR?.trim() || 'target',
  );
  const targetRoot =
    configuredTargetRoot === defaultTargetRoot ||
    configuredTargetRoot.startsWith(`${defaultTargetRoot}${sep}`)
      ? configuredTargetRoot
      : defaultTargetRoot;
  const executable = platform === 'win32' ? 'himmelcad-sidecar.exe' : 'himmelcad-sidecar';
  return resolve(targetRoot, 'debug', executable);
}
