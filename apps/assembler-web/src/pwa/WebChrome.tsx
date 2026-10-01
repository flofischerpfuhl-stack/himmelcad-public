/**
 * The web product's own chrome over the shared shell: the update prompt
 * ("A new version is ready" · Reload), the one-time "works offline now"
 * notice after the first install, and a quiet offline badge. Bottom right,
 * the corner the shell leaves free (above the Agent Access indicator while
 * that is on), so it never covers the top bar, the panels or the tool
 * session's Cancel/Done row; only the toasts themselves take pointer and
 * touch input.
 */
import { CloudOff } from 'lucide-react';

import { Button, Toast } from '@himmelcad/ui';

import { useAutomationStore } from '../../../assembler/renderer/src/interface/agent-api/automationStore.js';
import { usePwaStore } from './serviceWorker.js';
import styles from './WebChrome.module.css';

export function WebChrome(): JSX.Element | null {
  const offline = usePwaStore((s) => s.offline);
  const updateReady = usePwaStore((s) => s.updateReady);
  const offlineReady = usePwaStore((s) => s.offlineReady);
  const agentOn = useAutomationStore((s) => s.enabled);
  if (!offline && !updateReady && !offlineReady) return null;
  return (
    <div className={styles.host} data-web-chrome data-raised={agentOn ? '' : undefined}>
      {updateReady ? (
        <Toast
          tone="info"
          autoDismiss={false}
          action={
            <Button
              size="small"
              variant="primary"
              onClick={() => usePwaStore.getState().applyUpdate()}
            >
              Reload
            </Button>
          }
        >
          A new version of Assembler is ready.
        </Toast>
      ) : null}
      {offlineReady && !updateReady ? (
        <Toast
          tone="success"
          autoDismiss={8000}
          onDismiss={() => usePwaStore.getState().dismissOfflineReady()}
        >
          Assembler now works offline. Projects stay on this device.
        </Toast>
      ) : null}
      {offline ? (
        <div
          className={styles.offline}
          role="status"
          aria-label="Offline"
          title="No network: everything keeps working, projects stay on this device."
          data-offline-badge
        >
          <CloudOff size={13} aria-hidden />
          Offline
        </div>
      ) : null}
    </div>
  );
}
