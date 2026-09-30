/**
 * `assembler-headless` — HimmelCAD Assembler without a GUI.
 *
 * Runs the canonical command layer (`renderer/src/api/session.ts`) on the
 * same application store the desktop app uses, with the OCCT kernel
 * in-process, and speaks JSON-RPC 2.0 over stdio: one request object per
 * line on stdin, one response object per line on stdout. Everything else
 * (kernel logs, diagnostics) goes to stderr, so stdout stays a clean
 * protocol stream for agents, CI and the Python SDK
 * (`himmelcad.assembler.StdioTransport`).
 *
 * Usage:
 *   assembler-headless                 serve JSON-RPC on stdio
 *   assembler-headless --print-schema  print the hcasm.agent-api@1 contract
 *   assembler-headless --write-schema <file>  write it (UTF-8) to a file
 *   assembler-headless --version
 *
 * Trust boundary: the process runs with the invoking user's rights; it has
 * no network listener. File paths in `export.*`, `import.*`,
 * `project.open/save` are resolved against the working directory.
 */
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { handleJsonRpcText } from '../renderer/src/api/jsonRpc.js';
import { AGENT_API_SCHEMA, API_ID, API_VERSION } from '../renderer/src/api/schema.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../renderer/src/api/session.js';
import { useAssemblerStore } from '../renderer/src/model/store.js';
import { setSketchSolverFactory } from '../renderer/src/sketch/solverProvider.js';
import { createHeadlessKernel } from './nodeKernel.js';
import { installHeadlessFonts } from './nodeFonts.js';
import { createHeadlessSketchSolver } from './nodeSolver.js';

function writeLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function protectStdout(): void {
  // Anything printed by libraries (Emscripten, replicad) must not corrupt the protocol stream.
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(
      `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
    );
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function serve(): Promise<void> {
  protectStdout();
  const store = useAssemblerStore;
  // Start from an empty document (the store's initial content is the UI demo part).
  store.getState().loadDocument([], { projectName: 'Untitled' });
  const kernel = createHeadlessKernel();
  store.getState().attachKernel(kernel);
  // Sketch writes re-solve with planeGCS in-process (loaded on first use).
  setSketchSolverFactory(createHeadlessSketchSolver);
  // Sketch text reads the bundled font from node_modules (Inter, OFL-1.1).
  installHeadlessFonts();

  const session = new AgentSession({
    store,
    kernel,
    host: {
      server: 'headless',
      capabilities: HEADLESS_CAPABILITIES,
      readFile: async (path) => new Uint8Array(await fs.readFile(resolve(path))),
      writeFile: async (path, bytes) => {
        const absolute = resolve(path);
        await fs.mkdir(dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, bytes);
        return absolute;
      },
    },
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    pending = pending.then(async () => {
      const response = await handleJsonRpcText(session, line);
      if (response) writeLine(response);
    });
  });
  await new Promise<void>((done) => lines.once('close', () => done()));
  await pending;
  session.dispose();
  kernel.dispose();
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'assembler-headless — JSON-RPC 2.0 over stdio (one JSON object per line).\n' +
        '  --print-schema   print the hcasm.agent-api@1 contract (JSON Schema)\n' +
        '  --version        print the API id and version\n',
    );
    return 0;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${API_ID}@${API_VERSION}\n`);
    return 0;
  }
  const writeSchema = argv.indexOf('--write-schema');
  if (writeSchema >= 0 && argv[writeSchema + 1]) {
    await fs.writeFile(
      resolve(argv[writeSchema + 1]!),
      `${JSON.stringify(AGENT_API_SCHEMA, null, 2)}\n`,
      'utf8',
    );
    return 0;
  }
  if (argv.includes('--print-schema')) {
    process.stdout.write(`${JSON.stringify(AGENT_API_SCHEMA, null, 2)}\n`);
    return 0;
  }
  await serve();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `assembler-headless: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  },
);
