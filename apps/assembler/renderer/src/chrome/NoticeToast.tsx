/**
 * One transient workspace notice (e.g. why a History step cannot be moved
 * there), as the shared toast, bottom centre above the status strip.
 */
import { useCallback } from 'react';

import { Toast } from '@himmelcad/ui';

import { useWorkspaceStore } from '../model/workspace.js';
import styles from './NoticeToast.module.css';

export function NoticeToast(): JSX.Element | null {
  const notice = useWorkspaceStore((s) => s.notice);
  const dismiss = useCallback(() => useWorkspaceStore.getState().clearNotice(), []);
  if (!notice) return null;
  return (
    <div className={styles.host}>
      <Toast key={notice.nonce} tone={notice.tone} onDismiss={dismiss} autoDismiss={6000}>
        {notice.text}
      </Toast>
    </div>
  );
}
