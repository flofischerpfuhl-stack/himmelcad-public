/**
 * File > Open Recent submenu: up to 8 most-recently-opened/saved `.hcasm`
 * paths (`electron/recentFiles.ts`, persisted in `userData`). A missing
 * file (moved/deleted since) is shown greyed out with Locate…/Remove
 * instead of Open. The web product lists file handles it kept in IndexedDB
 * (File System Access API); a plain browser never shows this
 * (`listRecentFiles` resolves to `[]`).
 */
import { useEffect, useState } from 'react';

import { MenuItem, MenuSeparator, MenuSubmenu } from '@himmelcad/ui';

import {
  listRecentFiles,
  locateRecentFile,
  openRecentFile,
  removeRecentFile,
  type RecentFileInfo,
} from '../../foundation/document/persistence.js';
import { useProjectStore } from './project/projectStore.js';

export function RecentFilesMenu(): JSX.Element {
  const [entries, setEntries] = useState<RecentFileInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listRecentFiles().then((list) => {
      if (!cancelled) setEntries(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const openEntry = (path: string): void => {
    // Unsaved changes are asked about in the same dialog as New/Open; the file
    // is read only once the user has decided.
    useProjectStore.getState().requestOpenFile(async () => {
      const opened = await openRecentFile(path);
      if (!opened) {
        // Vanished between menu-open and click: reflect that instead of a silent no-op.
        setEntries(
          (prev) => prev?.map((e) => (e.path === path ? { ...e, missing: true } : e)) ?? null,
        );
      }
      return opened;
    });
  };

  const locateEntry = (path: string): void => {
    void (async () => {
      const opened = await locateRecentFile(path);
      if (!opened) return; // dialog cancelled
      // Relocating keeps the entry's list position (`recentFiles.ts`
      // `relocateRecentFile`), so refetch rather than guess the new order.
      void listRecentFiles().then((list) => setEntries(list));
      useProjectStore.getState().requestOpenFile(() => Promise.resolve(opened));
    })();
  };

  const removeEntry = (path: string): void => {
    void removeRecentFile(path);
    setEntries((prev) => prev?.filter((e) => e.path !== path) ?? null);
  };

  if (!entries || entries.length === 0) return <></>;

  return (
    <>
      <MenuSeparator />
      <MenuSubmenu label="Open Recent" ariaLabel="Open Recent">
        {entries.map((entry) => (
          <span key={entry.path} style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
            <MenuItem
              disabled={entry.missing}
              title={`${entry.location ? `${entry.name} · ${entry.location}` : entry.path}${entry.missing ? ' (missing)' : ''}`}
              style={{ flex: 1, opacity: entry.missing ? 0.5 : 1 }}
              onSelect={() => openEntry(entry.path)}
            >
              {entry.name}
              {entry.missing ? ' (missing)' : ''}
            </MenuItem>
            {entry.missing ? (
              <MenuItem onSelect={() => locateEntry(entry.path)}>Locate…</MenuItem>
            ) : null}
            <MenuItem onSelect={() => removeEntry(entry.path)}>Remove</MenuItem>
          </span>
        ))}
      </MenuSubmenu>
    </>
  );
}
