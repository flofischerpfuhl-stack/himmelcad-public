/**
 * Slicer handoff, pure part (no Electron import, unit tested): known
 * Windows install locations of Bambu Studio, OrcaSlicer, PrusaSlicer and
 * UltiMaker Cura, validation of a slicer executable path, the persisted
 * settings format and the launch description (`spawn` with an argument
 * array and `shell: false` — never a command line string).
 *
 * Trust rule: the renderer never passes an executable path to launch. It
 * passes the id of a registered slicer; the main process resolves the path
 * from its own detection/settings and validates it again before spawning.
 */
import { basename, isAbsolute, join, win32 } from 'node:path';

export type SlicerKind = 'bambu' | 'orca' | 'prusa' | 'cura' | 'custom';

export interface SlicerEntry {
  /** `detected:<kind>` or `user:<n>`. */
  id: string;
  name: string;
  kind: SlicerKind;
  path: string;
  source: 'detected' | 'user';
}

export interface SlicerSettingsV1 {
  version: 1;
  /** Slicers the user added (paths chosen in a native dialog). */
  user: { id: string; name: string; path: string }[];
  defaultId: string | null;
}

export function emptySlicerSettings(): SlicerSettingsV1 {
  return { version: 1, user: [], defaultId: null };
}

/** Validates a parsed settings file; malformed entries are dropped. */
export function parseSlicerSettings(raw: unknown, platform: NodeJS.Platform): SlicerSettingsV1 {
  if (typeof raw !== 'object' || raw === null) return emptySlicerSettings();
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return emptySlicerSettings();
  const user = Array.isArray(r.user)
    ? r.user
        .filter(
          (u): u is { id: string; name: string; path: string } =>
            typeof u === 'object' &&
            u !== null &&
            typeof (u as { id?: unknown }).id === 'string' &&
            /^user:\d+$/.test((u as { id: string }).id) &&
            typeof (u as { name?: unknown }).name === 'string' &&
            typeof (u as { path?: unknown }).path === 'string' &&
            validateSlicerPath((u as { path: string }).path, platform) === null,
        )
        .map((u) => ({ id: u.id, name: u.name.slice(0, 80), path: u.path }))
    : [];
  const defaultId = typeof r.defaultId === 'string' ? r.defaultId : null;
  return { version: 1, user, defaultId };
}

/** Executables that are shells, script hosts or loaders: never accepted as a "slicer". */
const DENIED_EXECUTABLES = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'bash.exe',
  'wsl.exe',
  'conhost.exe',
  'explorer.exe',
  'msiexec.exe',
  'node.exe',
  'python.exe',
  'pythonw.exe',
]);

/**
 * Syntactic validation of a slicer executable path; `null` when acceptable,
 * else the reason. Windows: an absolute path to a `.exe` (no scripts, no
 * shells, no UNC/device paths). Elsewhere: an absolute path without shell
 * metacharacters (existence and file type are checked separately).
 */
export function validateSlicerPath(path: string, platform: NodeJS.Platform): string | null {
  if (typeof path !== 'string' || path.trim() === '') return 'No path given.';
  if (path.length > 1024) return 'The path is too long.';
  if (/[\0\r\n]/.test(path)) return 'The path contains control characters.';
  if (platform === 'win32') {
    if (!win32.isAbsolute(path) || !/^[a-zA-Z]:[\\/]/.test(path)) {
      return 'Use an absolute path on a drive (e.g. C:\\Program Files\\…).';
    }
    if (/^[\\/]{2}/.test(path)) return 'Network (UNC) paths are not allowed.';
    if (!/\.exe$/i.test(path)) return 'Choose the slicer program (.exe), not a script or shortcut.';
    if (/[<>"|?*]/.test(path.slice(2)))
      return 'The path contains characters Windows does not allow.';
    const name = win32.basename(path).toLowerCase();
    if (DENIED_EXECUTABLES.has(name)) return `${win32.basename(path)} is not a slicer.`;
    return null;
  }
  if (!isAbsolute(path)) return 'Use an absolute path.';
  const name = basename(path).toLowerCase();
  if (/\.(sh|bash|zsh|command|py|pl|rb|js|bat|cmd|ps1)$/i.test(name)) {
    return 'Choose the slicer program, not a script.';
  }
  if (
    DENIED_EXECUTABLES.has(`${name}.exe`) ||
    ['sh', 'bash', 'zsh', 'env', 'sudo'].includes(name)
  ) {
    return `${basename(path)} is not a slicer.`;
  }
  return null;
}

export interface CandidateEnvironment {
  programFiles?: string | undefined;
  programFilesX86?: string | undefined;
  localAppData?: string | undefined;
}

export interface SlicerCandidate {
  kind: Exclude<SlicerKind, 'custom'>;
  name: string;
  path: string;
}

const FIXED_LOCATIONS: {
  kind: Exclude<SlicerKind, 'custom' | 'cura'>;
  name: string;
  rel: string[];
}[] = [
  { kind: 'bambu', name: 'Bambu Studio', rel: ['Bambu Studio', 'bambu-studio.exe'] },
  { kind: 'orca', name: 'OrcaSlicer', rel: ['OrcaSlicer', 'orca-slicer.exe'] },
  { kind: 'prusa', name: 'PrusaSlicer', rel: ['Prusa3D', 'PrusaSlicer', 'prusa-slicer.exe'] },
];

const CURA_DIR = /^ulti[mM]aker cura( [\d.]+)?$/i;
const CURA_EXES = ['UltiMaker-Cura.exe', 'Ultimaker-Cura.exe', 'Cura.exe'];

/**
 * Candidate executables of the common slicers under Program Files, Program
 * Files (x86) and the per-user `%LOCALAPPDATA%\Programs` (Windows). Cura
 * installs into a versioned folder (`UltiMaker Cura 5.8.1`), so its roots
 * are listed with `listDir`; the newest version (by folder name) wins.
 * Existence is checked by the caller.
 */
export function slicerCandidates(
  env: CandidateEnvironment,
  listDir: (dir: string) => string[],
): SlicerCandidate[] {
  const roots = [
    env.programFiles,
    env.programFilesX86,
    env.localAppData ? win32.join(env.localAppData, 'Programs') : undefined,
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);
  const out: SlicerCandidate[] = [];
  for (const location of FIXED_LOCATIONS) {
    for (const root of roots) {
      out.push({
        kind: location.kind,
        name: location.name,
        path: win32.join(root, ...location.rel),
      });
    }
  }
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = listDir(root);
    } catch {
      entries = [];
    }
    const curaDirs = entries
      .filter((e) => CURA_DIR.test(e))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const dir of curaDirs) {
      for (const exe of CURA_EXES) {
        out.push({
          kind: 'cura',
          name: `UltiMaker ${dir.replace(/^ulti[mM]aker /i, '')}`,
          path: win32.join(root, dir, exe),
        });
      }
    }
  }
  return out;
}

/** Detected slicers: the first existing candidate per kind (Program Files before per-user installs). */
export function detectSlicers(
  candidates: readonly SlicerCandidate[],
  isFile: (path: string) => boolean,
): SlicerEntry[] {
  const found = new Map<string, SlicerEntry>();
  for (const candidate of candidates) {
    if (found.has(candidate.kind)) continue;
    if (validateSlicerPath(candidate.path, 'win32') !== null) continue;
    if (!isFile(candidate.path)) continue;
    found.set(candidate.kind, {
      id: `detected:${candidate.kind}`,
      name: candidate.name,
      kind: candidate.kind,
      path: candidate.path,
      source: 'detected',
    });
  }
  return [...found.values()];
}

/** Detected slicers plus the user's (a user entry with the same path as a detected one is dropped). */
export function mergeSlicers(
  detected: readonly SlicerEntry[],
  settings: SlicerSettingsV1,
): SlicerEntry[] {
  const seen = new Set(detected.map((d) => d.path.toLowerCase()));
  const user: SlicerEntry[] = settings.user
    .filter((u) => !seen.has(u.path.toLowerCase()))
    .map((u) => ({ id: u.id, name: u.name, kind: 'custom', path: u.path, source: 'user' }));
  return [...detected, ...user];
}

/** Next free `user:<n>` id. */
export function nextUserSlicerId(settings: SlicerSettingsV1): string {
  let n = 1;
  const taken = new Set(settings.user.map((u) => u.id));
  while (taken.has(`user:${n}`)) n += 1;
  return `user:${n}`;
}

/** Display name for a user-chosen executable (`prusa-slicer.exe` → `prusa-slicer`). */
export function slicerNameFromPath(path: string): string {
  const base = win32.basename(path).replace(/\.exe$/i, '');
  return base || 'Slicer';
}

export interface SlicerLaunch {
  command: string;
  args: string[];
  options: {
    shell: false;
    detached: true;
    stdio: 'ignore';
    windowsHide: false;
  };
}

/**
 * The launch of `slicerPath` with the model file: the executable and one
 * argument (the file), never through a shell, detached from the app.
 * Throws when the executable path fails {@link validateSlicerPath}.
 */
export function buildSlicerLaunch(
  slicerPath: string,
  modelPath: string,
  platform: NodeJS.Platform,
): SlicerLaunch {
  const problem = validateSlicerPath(slicerPath, platform);
  if (problem) throw new Error(problem);
  if (!(platform === 'win32' ? win32.isAbsolute(modelPath) : isAbsolute(modelPath))) {
    throw new Error('The model file path must be absolute.');
  }
  return {
    command: slicerPath,
    args: [modelPath],
    options: { shell: false, detached: true, stdio: 'ignore', windowsHide: false },
  };
}

/** A safe temp file name for the handed-off model: `<project>-<yyyymmdd-hhmmss>.3mf`. */
export function handoffFileName(projectName: string, now: Date): string {
  const safe =
    projectName
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 60) || 'Model';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${safe}-${stamp}.3mf`;
}

/** Directory (under the OS temp dir) handed-off models are written to. */
export function handoffDir(tempDir: string): string {
  return join(tempDir, 'HimmelCAD-Assembler', 'slicer-handoff');
}
