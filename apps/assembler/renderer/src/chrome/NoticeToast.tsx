/**
 * One transient workspace notice (e.g. why a History step cannot be moved
 * there), as the shared toast, bottom centre above the status strip; raised
 * above the kernel activity/notice islands (KernelActivity) while those show.
 */
import { useCallback } from 'react';

import { Toast } from '@himmelcad/ui';

import { useAssemblerStore } from '../model/store.js';
import { useWorkspaceStore } from '../model/workspace.js';
import styles from './NoticeToast.module.css';

export function NoticeToast(): JSX.Element | null {
  const notice = useWorkspaceStore((s) => s.notice);
  const dismiss = useCallback(() => useWorkspaceStore.getState().clearNotice(), []);
  const kernelIslands = useAssemblerStore(
    (s) => (s.kernelActivity ? 1 : 0) + (s.kernelNotice ? 1 : 0),
  );
  if (!notice) return null;
  return (
    <div className={styles.host} data-raised={kernelIslands > 0 ? kernelIslands : undefined}>
      <Toast key={notice.nonce} tone={notice.tone} onDismiss={dismiss} autoDismiss={6000}>
        {notice.text}
      </Toast>
    </div>
  );
}
