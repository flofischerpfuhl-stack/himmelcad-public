/**
 * Slicer handoff, pure part: executable-path validation (no shells, no
 * scripts, no relative/UNC paths), install-location detection, settings
 * parsing and the launch description (argument array, `shell: false`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSlicerLaunch,
  detectSlicers,
  emptySlicerSettings,
  handoffFileName,
  mergeSlicers,
  nextUserSlicerId,
  parseSlicerSettings,
  slicerCandidates,
  slicerNameFromPath,
  validateSlicerPath,
} from '../../electron/slicerPaths.js';

void test('validateSlicerPath (Windows): only absolute drive paths to a .exe that is not a shell', () => {
  const ok = [
    'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
    'D:/Tools/OrcaSlicer/orca-slicer.EXE',
    'C:\\Program Files\\UltiMaker Cura 5.8.1\\UltiMaker-Cura.exe',
  ];
  for (const path of ok) assert.equal(validateSlicerPath(path, 'win32'), null, path);
  const rejected: [string, RegExp][] = [
    ['', /No path/],
    ['bambu-studio.exe', /absolute/],
    ['..\\slicer.exe', /absolute/],
    ['\\\\server\\share\\slicer.exe', /absolute|UNC/],
    ['C:\\Tools\\slicer.bat', /\.exe/],
    ['C:\\Tools\\slicer.cmd', /\.exe/],
    ['C:\\Tools\\slicer.ps1', /\.exe/],
    ['C:\\Tools\\slicer.lnk', /\.exe/],
    ['C:\\Windows\\System32\\cmd.exe', /not a slicer/],
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', /not a slicer/],
    ['C:\\Windows\\System32\\wscript.exe', /not a slicer/],
    ['C:\\Tools\\slicer.exe" & calc.exe', /not allow|\.exe/],
    ['C:\\Tools\\sli\ncer.exe', /control/],
  ];
  for (const [path, reason] of rejected) {
    const problem = validateSlicerPath(path, 'win32');
    assert.ok(problem, `rejected: ${JSON.stringify(path)}`);
    assert.match(problem, reason, `${JSON.stringify(path)}: ${problem}`);
  }
});

void test('validateSlicerPath (Linux/macOS): absolute, not a script or shell', () => {
  assert.equal(validateSlicerPath('/opt/PrusaSlicer/prusa-slicer', 'linux'), null);
  assert.equal(
    validateSlicerPath('/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer', 'darwin'),
    null,
  );
  assert.match(validateSlicerPath('prusa-slicer', 'linux')!, /absolute/);
  assert.match(validateSlicerPath('/usr/local/bin/run.sh', 'linux')!, /script/);
  assert.match(validateSlicerPath('/bin/bash', 'linux')!, /not a slicer/);
});

void test('buildSlicerLaunch: executable + one file argument, never a shell', () => {
  const launch = buildSlicerLaunch(
    'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe',
    'C:\\Users\\me\\AppData\\Local\\Temp\\HimmelCAD-Assembler\\slicer-handoff\\Part & Co-20260930-120000.3mf',
    'win32',
  );
  assert.equal(launch.command, 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe');
  assert.deepEqual(launch.args, [
    'C:\\Users\\me\\AppData\\Local\\Temp\\HimmelCAD-Assembler\\slicer-handoff\\Part & Co-20260930-120000.3mf',
  ]);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.detached, true);
  assert.throws(
    () => buildSlicerLaunch('C:\\Windows\\System32\\cmd.exe', 'C:\\a.3mf', 'win32'),
    /not a slicer/,
  );
  assert.throws(() => buildSlicerLaunch('C:\\Tools\\run.bat', 'C:\\a.3mf', 'win32'), /\.exe/);
  assert.throws(() => buildSlicerLaunch('C:\\Tools\\s.exe', 'a.3mf', 'win32'), /absolute/);
});

void test('slicer detection: known install folders, newest Cura first, per-user installs', () => {
  const env = {
    programFiles: 'C:\\Program Files',
    programFilesX86: 'C:\\Program Files (x86)',
    localAppData: 'C:\\Users\\me\\AppData\\Local',
  };
  const listDir = (dir: string) =>
    dir === 'C:\\Program Files'
      ? ['Bambu Studio', 'UltiMaker Cura 5.7.2', 'UltiMaker Cura 5.10.0', 'Common Files']
      : [];
  const candidates = slicerCandidates(env, listDir);
  const existing = new Set([
    'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
    'C:\\Program Files\\UltiMaker Cura 5.10.0\\UltiMaker-Cura.exe',
    'C:\\Program Files\\UltiMaker Cura 5.7.2\\UltiMaker-Cura.exe',
    'C:\\Users\\me\\AppData\\Local\\Programs\\OrcaSlicer\\orca-slicer.exe',
  ]);
  const detected = detectSlicers(candidates, (p) => existing.has(p));
  assert.deepEqual(
    detected.map((d) => [d.id, d.path]),
    [
      ['detected:bambu', 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe'],
      ['detected:orca', 'C:\\Users\\me\\AppData\\Local\\Programs\\OrcaSlicer\\orca-slicer.exe'],
      ['detected:cura', 'C:\\Program Files\\UltiMaker Cura 5.10.0\\UltiMaker-Cura.exe'],
    ],
  );
  assert.equal(
    detectSlicers(candidates, () => false).length,
    0,
    'nothing installed: nothing detected',
  );
});

void test('slicer settings: parsing drops invalid entries; user and detected entries merge', () => {
  const parsed = parseSlicerSettings(
    {
      version: 1,
      user: [
        { id: 'user:1', name: 'My Prusa', path: 'C:\\Prusa\\prusa-slicer.exe' },
        { id: 'user:2', name: 'Evil', path: 'C:\\Windows\\System32\\cmd.exe' },
        { id: 'user:3', name: 'Script', path: 'C:\\x\\run.bat' },
        { id: 'bad', name: 'Bad id', path: 'C:\\x\\a.exe' },
      ],
      defaultId: 'user:1',
    },
    'win32',
  );
  assert.deepEqual(
    parsed.user.map((u) => u.id),
    ['user:1'],
  );
  assert.equal(parsed.defaultId, 'user:1');
  assert.deepEqual(parseSlicerSettings({ version: 2 }, 'win32'), emptySlicerSettings());
  assert.deepEqual(parseSlicerSettings('nonsense', 'win32'), emptySlicerSettings());
  assert.equal(nextUserSlicerId(parsed), 'user:2');
  const merged = mergeSlicers(
    [
      {
        id: 'detected:prusa',
        name: 'PrusaSlicer',
        kind: 'prusa',
        path: 'C:\\Prusa\\PRUSA-SLICER.exe',
        source: 'detected',
      },
    ],
    parsed,
  );
  assert.equal(merged.length, 1, 'a user entry with a detected path is not listed twice');
  assert.equal(slicerNameFromPath('C:\\x\\orca-slicer.exe'), 'orca-slicer');
});

void test('handoffFileName: safe, timestamped 3MF names', () => {
  const when = new Date(2026, 8, 30, 12, 5, 9);
  assert.equal(handoffFileName('Bracket', when), 'Bracket-20260930-120509.3mf');
  assert.equal(handoffFileName('a/b\\c:*?"<>|', when), 'a_b_c_-20260930-120509.3mf');
  assert.equal(handoffFileName('  ..  ', when), 'Model-20260930-120509.3mf');
});
