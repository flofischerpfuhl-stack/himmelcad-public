import { accessSync, constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import process from 'node:process';

function environmentValue(environment, name, platform) {
  if (platform !== 'win32') return environment[name];
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name);
  return key ? environment[key] : undefined;
}

function executableExists(path, platform) {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(command, environment, platform) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const pathValue = environmentValue(environment, 'PATH', platform) ?? '';
  const extensions =
    platform === 'win32' && !win32.extname(command)
      ? (environmentValue(environment, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  return pathValue
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => pathApi.join(directory, command + extension)),
    );
}

export function resolveCargoExecutable({
  environment = process.env,
  platform = process.platform,
  isExecutable = (path) => executableExists(path, platform),
} = {}) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const executableName = platform === 'win32' ? 'cargo.exe' : 'cargo';
  const searched = [];
  const seen = new Set();
  const tryCandidate = (label, candidate) => {
    if (!candidate) {
      searched.push(`${label} (not set)`);
      return undefined;
    }
    const normalized = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(normalized)) return undefined;
    seen.add(normalized);
    searched.push(`${label} (${candidate})`);
    return isExecutable(candidate) ? candidate : undefined;
  };

  const cargoOverride = environmentValue(environment, 'CARGO', platform);
  if (cargoOverride) {
    const hasPathSeparator = cargoOverride.includes('/') || cargoOverride.includes('\\');
    if (hasPathSeparator || pathApi.isAbsolute(cargoOverride)) {
      const resolved = tryCandidate('CARGO', cargoOverride);
      if (resolved) return resolved;
    } else {
      for (const candidate of pathCandidates(cargoOverride, environment, platform)) {
        const resolved = tryCandidate('CARGO via PATH', candidate);
        if (resolved) return resolved;
      }
      if (!environmentValue(environment, 'PATH', platform))
        searched.push('CARGO via PATH (PATH not set)');
    }
  } else {
    searched.push('CARGO (not set)');
  }

  const cargoHome = environmentValue(environment, 'CARGO_HOME', platform);
  const cargoHomeCandidate = cargoHome ? pathApi.join(cargoHome, 'bin', executableName) : undefined;
  const resolvedCargoHome = tryCandidate('CARGO_HOME/bin', cargoHomeCandidate);
  if (resolvedCargoHome) return resolvedCargoHome;

  const home = environmentValue(environment, 'HOME', platform);
  const homeCandidate = home ? pathApi.join(home, '.cargo', 'bin', executableName) : undefined;
  const resolvedHome = tryCandidate('HOME/.cargo/bin rustup proxy', homeCandidate);
  if (resolvedHome) return resolvedHome;

  const userProfile = environmentValue(environment, 'USERPROFILE', platform);
  const userProfileCandidate = userProfile
    ? pathApi.join(userProfile, '.cargo', 'bin', executableName)
    : undefined;
  const resolvedUserProfile = tryCandidate(
    'USERPROFILE/.cargo/bin rustup proxy',
    userProfileCandidate,
  );
  if (resolvedUserProfile) return resolvedUserProfile;

  const rustupHome = environmentValue(environment, 'RUSTUP_HOME', platform);
  const rustupShimCandidate = rustupHome
    ? pathApi.join(rustupHome, 'shims', executableName)
    : undefined;
  const resolvedRustupShim = tryCandidate('RUSTUP_HOME/shims', rustupShimCandidate);
  if (resolvedRustupShim) return resolvedRustupShim;

  const cargoPathCandidates = pathCandidates(executableName, environment, platform);
  if (!cargoPathCandidates.length) searched.push('PATH (not set or empty)');
  for (const candidate of cargoPathCandidates) {
    const resolved = tryCandidate('PATH', candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    `Cargo was not found. Install the pinned Rust toolchain or set CARGO. Searched: ${searched.join('; ')}`,
  );
}
