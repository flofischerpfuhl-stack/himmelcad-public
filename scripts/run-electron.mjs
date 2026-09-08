/* global console, process */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const electronCli = resolve(process.cwd(), 'node_modules/electron/cli.js');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const remoteDebuggingPort = process.env.HIMMELCAD_REMOTE_DEBUGGING_PORT?.trim() || '9223';
const userDataDirectory = process.env.HIMMELCAD_ELECTRON_USER_DATA_DIR?.trim();
const electronArguments = [electronCli, `--remote-debugging-port=${remoteDebuggingPort}`];
if (userDataDirectory) electronArguments.push(`--user-data-dir=${userDataDirectory}`);
if (process.platform === 'linux' && process.env.HIMMELCAD_GPU?.trim() === 'nvidia') {
  // Electron 43's default ANGLE/OpenGL path stays on the integrated adapter on
  // PRIME laptops. ANGLE Vulkan enumerates the discrete adapter correctly; the
  // viewer then keeps its normal WebGPU-or-WebGL2 backend negotiation. This
  // remains opt-in so unsupported drivers retain Electron's defaults.
  electronArguments.push(
    '--use-angle=vulkan',
    '--enable-features=DefaultANGLEVulkan',
    '--enable-unsafe-webgpu',
    '--ozone-platform=x11',
  );
}
electronArguments.push(...process.argv.slice(2));

const child = spawn(process.execPath, electronArguments, {
  env: environment,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`[electron-launcher] ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
