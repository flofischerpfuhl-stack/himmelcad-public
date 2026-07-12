#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const roots = [
  join(workspace, 'apps/photolab/renderer'),
  join(workspace, 'apps/photolab/electron'),
  join(workspace, 'packages/@himmelcad/ui/src/EntityTree.tsx'),
  join(workspace, 'crates/himmelcad-sidecar/src/main.rs'),
  join(workspace, 'crates/himmelcad-sidecar/src/dedode_runtime.rs'),
];
const extensions = new Set(['.ts', '.tsx', '.html', '.rs']);
const germanUiWords = new RegExp(
  String.raw`[ÄÖÜäöüß]|\b(?:Abbrechen|Abbruch|Aktuelle|Alle Bilder|Ausrichtung|Ansicht|Befehle|Bilder|Dichte Punktwolke|Duplikate|Eigenschaften|Exportieren|Fehler|fehlt|Genauigkeit|gesichert|gesperrt|geprüft|Hardwareplan|Höhe|initialisiert|Kameras|Karte|Kein Bild|Konsole|Lage|Messungen|Orthomosaik|Profil|Projektarchiv|Punktwolke|Speichern|Texturatlas|Tiefenbilder|Verarbeitungssatz|Vermutet|Warnungen|Zurück)\b`,
  'u',
);
const violations = [];

for (const root of roots) {
  for (const path of collect(root)) {
    if (!extensions.has(extname(path))) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (germanUiWords.test(lines[index])) {
        violations.push(`${relative(workspace, path)}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`PhotoLab English UI check failed:\n${violations.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('PhotoLab English UI check passed.\n');

function collect(path) {
  if (!existsSync(path)) return [];
  const entry = readdirOrFile(path);
  if (entry.kind === 'file') return [path];
  return entry.entries.flatMap((child) => collect(join(path, child.name)));
}

function readdirOrFile(path) {
  try {
    return { kind: 'directory', entries: readdirSync(path, { withFileTypes: true }) };
  } catch (error) {
    if (error?.code === 'ENOTDIR') return { kind: 'file' };
    throw error;
  }
}
