/**
 * One transient workspace notice (e.g. why a History step cannot be moved
 * there), as the shared toast, bottom centre above the status strip; raised
 * above the kernel activity/notice islands (KernelActivity) while those show.
 *
 * Also shows a failed Open/Import/template (`projectStore.loadError`) while
 * the editor is up: the Home screen shows it inline, but a failure started
 * from the editor (File > Open, a recent file, drag & drop) must not be
 * silent there. It stays until dismissed (which clears it).
 */
import { useCallback } from 'react';

import { Toast } from '@himmelcad/ui';

import { useProjectStore } from './project/projectStore.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { useWorkspaceStore } from './workspace.js';
import styles from './NoticeToast.module.css';

export function NoticeToast(): JSX.Element | null {
  const notice = useWorkspaceStore((s) => s.notice);
  const homeOpen = useWorkspaceStore((s) => s.homeOpen);
  const loadError = useProjectStore((s) => s.loadError);
  const dismiss = useCallback(() => useWorkspaceStore.getState().clearNotice(), []);
  const dismissLoadError = useCallback(() => useProjectStore.getState().clearLoadError(), []);
  const kernelIslands = useAssemblerStore(
    (s) => (s.kernelActivity ? 1 : 0) + (s.kernelNotice ? 1 : 0),
  );
  const showLoadError = loadError !== null && !homeOpen;
  if (!notice && !showLoadError) return null;
  return (
    <div className={styles.host} data-raised={kernelIslands > 0 ? kernelIslands : undefined}>
      {showLoadError ? (
        <Toast
          key={`load:${loadError}`}
          tone="error"
          onDismiss={dismissLoadError}
          autoDismiss={false}
        >
          {loadError}
        </Toast>
      ) : null}
      {notice ? (
        <Toast key={notice.nonce} tone={notice.tone} onDismiss={dismiss} autoDismiss={6000}>
          {notice.text}
        </Toast>
      ) : null}
    </div>
  );
}
