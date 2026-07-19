/* global console, process */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const electronCli = resolve(process.cwd(), 'node_modules/electron/cli.js');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const remoteDebuggingPort = process.env.HIMMELCAD_REMOTE_DEBUGGING_PORT?.trim() || '9223';

const child = spawn(
  process.execPath,
  [electronCli, `--remote-debugging-port=${remoteDebuggingPort}`, ...process.argv.slice(2)],
  {
  env: environment,
  stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(`[electron-launcher] ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
