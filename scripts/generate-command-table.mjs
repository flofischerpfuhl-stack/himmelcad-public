#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(root, 'schemas/automation/himmelcad-automation-v1.schema.json');
const appOutput = resolve(root, 'packages/@himmelcad/app/src/generated/commandTable.ts');
const hostOutput = resolve(root, 'packages/@himmelcad/automation-host/generated-command-table.cjs');
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const productIds = new Set(['builder', 'photolab']);
const quickSurfaceOrder = [
  'view.frame',
  'view.preset.top',
  'view.preset.front',
  'view.preset.right',
  'view.preset.isometric',
  'select.clear',
  'edit.clipboard.paste_in_place',
];
const builderOnlyRows = new Set([
  'measure.point',
  'measure.distance',
  'measure.dz',
  'measurement.list',
  'measurement.delete',
  'view.bookmark.restore',
  'entity.isolate',
  'pointcloud.display.set',
  'pointcloud.ground.extract',
  'pointcloud.ground.preview',
  'pointcloud.ground.cancel',
  'view.box.place',
  'view.box.update',
  'view.box.set_operation',
  'view.box.lock',
  'view.box.unlock',
  'view.box.rename',
  'view.box.activate',
  'view.box.deactivate',
  'view.box.remove',
  'view.box.list',
]);
const rows = Object.entries(schema.methods)
  .filter(([, method]) => method.command)
  .map(([id, method]) => ({ id, ...method.command }))
  .sort((left, right) => {
    const order = { selection: 0, edit: 1, view: 2, 'entity-specific': 3 };
    return order[left.group] - order[right.group];
  });

if (rows.length === 0) throw new Error('Automation schema methods contain no command metadata.');
const ids = new Set();
const shortcuts = new Map();
for (const row of rows) {
  if (!schema.methods[row.id]) throw new Error(`Command row has no automation method: ${row.id}`);
  if (ids.has(row.id)) throw new Error(`Duplicate command id: ${row.id}`);
  ids.add(row.id);
  if (row.shortcut) {
    const normalized = row.shortcut.toLowerCase();
    if (shortcuts.has(normalized)) {
      throw new Error(
        `Shortcut collision: ${row.shortcut} (${shortcuts.get(normalized)}, ${row.id})`,
      );
    }
    shortcuts.set(normalized, row.id);
  }
  if (
    !(
      row.surfaces.ribbon ||
      row.surfaces.contextMenu ||
      row.surfaces.quickSurface ||
      row.surfaces.console
    )
  ) {
    throw new Error(`Command has no visible surface: ${row.id}`);
  }
  if (
    !Array.isArray(row.products) ||
    row.products.length === 0 ||
    new Set(row.products).size !== row.products.length ||
    row.products.some((product) => !productIds.has(product))
  ) {
    throw new Error(`Command products must be an explicit non-empty product-id array: ${row.id}`);
  }
  if (builderOnlyRows.has(row.id) && row.products.includes('photolab')) {
    throw new Error(`Builder-only command leaks into the PhotoLab fixture menu: ${row.id}`);
  }
  if (row.productPredicates != null) {
    if (typeof row.productPredicates !== 'object' || Array.isArray(row.productPredicates)) {
      throw new Error(`Command productPredicates must be an object: ${row.id}`);
    }
    for (const [product, productPredicate] of Object.entries(row.productPredicates)) {
      if (!row.products.includes(product)) {
        throw new Error(`Command predicate names an undeclared product: ${row.id} (${product})`);
      }
      if (
        typeof productPredicate !== 'object' ||
        productPredicate === null ||
        Array.isArray(productPredicate) ||
        productPredicate.selectionExportable !== true
      ) {
        throw new Error(`Command product predicate is invalid: ${row.id} (${product})`);
      }
      if (
        productPredicate.entityKinds != null &&
        (!Array.isArray(productPredicate.entityKinds) || productPredicate.entityKinds.length === 0)
      ) {
        throw new Error(
          `Command product predicate entityKinds must be non-empty: ${row.id} (${product})`,
        );
      }
    }
  }
  if (row.entityKinds != null) {
    if (!Array.isArray(row.entityKinds) || row.entityKinds.length === 0) {
      throw new Error(`Command entityKinds must be a non-empty array: ${row.id}`);
    }
    if (!row.surfaces.contextMenu) {
      throw new Error(`Entity-kind command must declare the contextMenu surface: ${row.id}`);
    }
  }
  if (row.allowMultiSelect != null && typeof row.allowMultiSelect !== 'boolean') {
    throw new Error(`Command allowMultiSelect must be boolean: ${row.id}`);
  }
}

const quickSurfaceIds = rows.filter((row) => row.surfaces.quickSurface).map((row) => row.id);
const unexpectedQuickSurfaceIds = quickSurfaceIds.filter((id) => !quickSurfaceOrder.includes(id));
const missingQuickSurfaceIds = quickSurfaceOrder.filter((id) => !quickSurfaceIds.includes(id));
if (unexpectedQuickSurfaceIds.length > 0 || missingQuickSurfaceIds.length > 0) {
  throw new Error(
    `UIP-D13 quick-surface rows differ from the required set. ` +
      `Unexpected: ${unexpectedQuickSurfaceIds.join(', ') || 'none'}; ` +
      `missing: ${missingQuickSurfaceIds.join(', ') || 'none'}.`,
  );
}

const banner = '// Generated by scripts/generate-command-table.mjs. Do not edit.\n';
const outputs = new Map([
  [
    appOutput,
    `${banner}export const GENERATED_QUICK_SURFACE_ORDER = ${JSON.stringify(quickSurfaceOrder, null, 2)} as const;\n\nexport const GENERATED_COMMAND_TABLE = ${JSON.stringify(rows, null, 2)} as const;\n`,
  ],
  [
    hostOutput,
    `'use strict';\n${banner}module.exports = Object.freeze(${JSON.stringify(rows, null, 2)});\n`,
  ],
]);
for (const [path, contents] of outputs) {
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== contents) {
      throw new Error(`Generated command table is stale: ${path}`);
    }
  } else {
    await writeFile(path, contents);
  }
}
