/**
 * The "Checks" toggle in the left dock's mode group (next to Print). With
 * Settings › Checks › "Check status in the workspace: Badge" (default) it
 * carries a small passive status — a dot and passed/total — when the
 * document has checks; with "Off" it is a plain toggle. It never blinks,
 * pops up or takes the focus.
 */
import { ListChecks } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import { summarizeResults, type CheckResult } from '../../../foundation/commands/checks.js';
import { useAssemblerStore } from '../../../foundation/commands/store.js';
import { usePreferences } from '../../../platform/input/preferences.js';
import type { ModeButtonProps } from '../../../platform/widgets/moduleUi.js';
import { useCheckResults } from '../checksStore.js';
import { resultsStale } from '../runner.js';
import styles from './ChecksPanel.module.css';

/** What the badge shows for the document's checks (`null`: no badge). */
export function checksBadge(): {
  text: string;
  tone: 'pass' | 'fail' | 'stale';
  title: string;
} | null {
  const state = useAssemblerStore.getState();
  const checks = state.checks.filter((c) => c.enabled !== false);
  if (checks.length === 0) return null;
  const results = useCheckResults.getState().results;
  const current = checks.map((c) => results[c.id]).filter((r): r is CheckResult => r !== undefined);
  const summary = summarizeResults(current);
  const problems = summary.failed + summary.errors;
  if (resultsStale() || current.length < checks.length) {
    return {
      text: `${summary.passed}/${checks.length}`,
      tone: 'stale',
      title: 'Checks: out of date, re-evaluated in the background',
    };
  }
  return {
    text: `${summary.passed}/${checks.length}`,
    tone: problems > 0 ? 'fail' : 'pass',
    title:
      problems > 0
        ? `Checks: ${problems} of ${checks.length} not met`
        : `Checks: all ${checks.length} met`,
  };
}

export function ChecksModeButton({
  className,
  activeClassName,
  stateClassName,
}: ModeButtonProps): JSX.Element {
  const open = useAssemblerStore((s) => s.checksPanelOpen);
  // Re-render on results and document changes (the badge reads both).
  useCheckResults((s) => s.results);
  useCheckResults((s) => s.evaluatedFor);
  useAssemblerStore((s) => s.checks);
  useAssemblerStore((s) => s.evaluation);
  const display = usePreferences((s) => s.checkStatus);
  const badge = display === 'badge' ? checksBadge() : null;
  return (
    <Tooltip content={badge?.title ?? 'Checks: requirements the model keeps'}>
      <button
        type="button"
        className={`${className ?? ''} ${open ? (activeClassName ?? '') : ''}`}
        aria-pressed={open}
        aria-label={badge ? `Checks, ${badge.title}` : 'Checks'}
        onClick={() => useAssemblerStore.getState().setChecksPanelOpen(!open)}
      >
        <ListChecks size={14} />
        Checks
        <span className={stateClassName}>
          {badge ? (
            <span className={styles.badge}>
              <span
                className={`${styles.dot} ${
                  badge.tone === 'pass'
                    ? styles.dotPass
                    : badge.tone === 'fail'
                      ? styles.dotFail
                      : styles.dotStale
                }`}
                aria-hidden
              />
              {badge.text}
            </span>
          ) : open ? (
            'On'
          ) : (
            'Off'
          )}
        </span>
      </button>
    </Tooltip>
  );
}
