/**
 * The STEP product tree of an export "as assembly": the project is the top
 * assembly, every Items folder a sub-assembly (nested like in the Items
 * panel), every exported body a part in its folder.
 */
import type { StepAssemblyTree } from '../foundation/geometry-kernel/stepExport.js';
import { bodyRowKey, folderRowKey, type ItemsMeta } from '../model/items.js';

export function stepAssemblyFromItems(
  projectName: string,
  bodyIds: readonly string[],
  items: Pick<ItemsMeta, 'folders' | 'parent'>,
): StepAssemblyTree {
  const folderIds = new Set(items.folders.map((f) => f.id));
  const parentOf = (key: string): string | null => {
    const p = items.parent[key];
    return p && folderIds.has(p) ? p : null;
  };
  const build = (folderId: string | null, name: string, seen: Set<string>): StepAssemblyTree => {
    const children: StepAssemblyTree['children'] = [];
    for (const folder of items.folders) {
      if (seen.has(folder.id) || parentOf(folderRowKey(folder.id)) !== folderId) continue;
      const sub = build(folder.id, folder.name, new Set([...seen, folder.id]));
      if (sub.children.length > 0) children.push(sub);
    }
    for (const id of bodyIds) {
      if (parentOf(bodyRowKey(id)) === folderId) children.push({ bodyId: id });
    }
    return { name, children };
  };
  return build(null, projectName.trim() || 'Assembly', new Set());
}
