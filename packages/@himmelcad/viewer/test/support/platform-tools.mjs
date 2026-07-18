import { existsSync } from 'node:fs';
import path from 'node:path';

export function toolCommand(environmentName, fallback) {
  const configured = process.env[environmentName]?.trim();
  return configured === undefined || configured === '' ? fallback : configured;
}

export function browserHeadless() {
  const configured = process.env.HCAD_HEADLESS?.trim();
  if (configured === '1') return true;
  if (configured === '0') return false;
  if (configured !== undefined && configured !== '') {
    throw new Error('HCAD_HEADLESS must be 0 or 1');
  }
  return (
    process.platform === 'linux' &&
    process.env.DISPLAY === undefined &&
    process.env.WAYLAND_DISPLAY === undefined
  );
}

export function resolveChromeExecutable() {
  const configured =
    process.env.HCAD_CHROME_PATH?.trim() ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) return requireExecutable(configured, 'configured Chrome');

  const candidates =
    process.platform === 'win32'
      ? [
          process.env.PROGRAMFILES &&
            path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
          process.env['PROGRAMFILES(X86)'] &&
            path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
          process.env.LOCALAPPDATA &&
            path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];
  const executable = candidates.find(
    (candidate) => typeof candidate === 'string' && existsSync(candidate),
  );
  if (executable !== undefined) return executable;
  throw new Error(
    `no Chrome executable found for ${process.platform}; set HCAD_CHROME_PATH`,
  );
}

export function resolveElectronExecutable(repoRoot) {
  const configured = process.env.HCAD_ELECTRON_PATH?.trim();
  if (configured) return requireExecutable(configured, 'configured Electron');
  const relative =
    process.platform === 'win32'
      ? 'electron/dist/electron.exe'
      : process.platform === 'darwin'
        ? 'electron/dist/Electron.app/Contents/MacOS/Electron'
        : 'electron/dist/electron';
  const candidates = [
    path.join(repoRoot, 'apps/photolab/node_modules', relative),
    path.join(repoRoot, 'node_modules', relative),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable !== undefined) return executable;
  throw new Error(
    `no Electron executable found for ${process.platform}; set HCAD_ELECTRON_PATH`,
  );
}

export function resolveEsbuildExecutable(repoRoot) {
  const configured = process.env.HCAD_ESBUILD_PATH?.trim();
  if (configured) return requireExecutable(configured, 'configured esbuild');
  const executableName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  const candidates = [
    path.join(repoRoot, 'node_modules/.pnpm/node_modules/esbuild/bin', executableName),
    path.join(repoRoot, 'node_modules/esbuild/bin', executableName),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable !== undefined) return executable;
  throw new Error(
    `no esbuild executable found for ${process.platform}; set HCAD_ESBUILD_PATH`,
  );
}

function requireExecutable(executable, label) {
  if (existsSync(executable)) return executable;
  throw new Error(`${label} executable does not exist: ${executable}`);
}
