import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Copy, Eraser, PanelBottomClose, Search, Terminal } from 'lucide-react';

import type { LogEvent, LogLevel } from '@himmelcad/data';
import { Select } from '@himmelcad/ui';
import { completeConsoleInput } from './commands.js';

import {
  AVE_MARIA,
  BRAND_WORDMARK,
  CRUCIFIX_ASCII,
  MADONNA_ASCII_HTML,
  PATER_NOSTER,
} from './brandArt.js';
import { consoleStore } from './store.js';
import styles from './Console.module.css';

export interface ConsoleProps {
  defaultLevel?: LogLevel;
  /** When provided, lines typed at the prompt are forwarded here. */
  onCommand?: (raw: string) => void;
  /** Hide the wordmark splash even on first mount. */
  hideBrand?: boolean;
  /** Product line under the brand splash, e.g. "PhotoLab · console". */
  brandSubtitle?: string;
  /** When provided, a "collapse panel" button is shown in the toolbar. */
  onCollapse?: () => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function Console({
  defaultLevel = 'info',
  onCommand,
  hideBrand = false,
  brandSubtitle = 'console',
  onCollapse,
}: ConsoleProps): JSX.Element {
  const [level, setLevel] = useState<LogLevel>(defaultLevel);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const events = useSyncExternalStore(
    (cb) => consoleStore.subscribe(cb),
    () => consoleStore.getSnapshot(),
    () => consoleStore.getSnapshot(),
  );

  const filtered = useMemo(() => {
    const min = LEVEL_ORDER[level];
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (LEVEL_ORDER[e.level] < min) return false;
      if (q && !e.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, level, query]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = input.trim();
    if (!raw) return;
    setInput('');
    consoleStore.push({
      level: 'info',
      source: 'renderer',
      message: `> ${raw}`,
      timestamp: Date.now(),
    });
    if (onCommand) {
      onCommand(raw);
    } else {
      consoleStore.push({
        level: 'warn',
        source: 'renderer',
        message: `Command runner not bound. Ignored: ${raw}`,
        timestamp: Date.now(),
      });
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Console</span>
        <Select
          wrapClassName={styles.selectWrap}
          className={styles.select}
          aria-label="Log level"
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel)}
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
        <Search size={12} color="var(--hc-fg-subtle)" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
          placeholder="Filter…"
          aria-label="Search console"
        />
        <button
          type="button"
          onClick={async () => {
            const text = filtered
              .map((evt) => {
                const time = new Date(evt.timestamp).toISOString().slice(11, 19);
                return `${time}  ${evt.source.padEnd(8)}  ${evt.level.toUpperCase().padEnd(5)}  ${evt.message}`;
              })
              .join('\n');
            try {
              await navigator.clipboard.writeText(text);
              setCopyState('ok');
              consoleStore.push({
                level: 'info',
                source: 'renderer',
                message: `Copied ${filtered.length} line(s) to clipboard.`,
                timestamp: Date.now(),
              });
            } catch {
              setCopyState('err');
            }
            if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
            copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
          }}
          className={`${styles.iconButton} ${
            copyState === 'ok' ? styles.iconButtonOk : ''
          } ${copyState === 'err' ? styles.iconButtonErr : ''}`}
          aria-label="Copy filtered log to clipboard"
          title={
            copyState === 'ok'
              ? 'Copied!'
              : copyState === 'err'
                ? 'Copy failed'
                : 'Copy all visible lines'
          }
        >
          {copyState === 'ok' ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          onClick={() => consoleStore.clear()}
          className={styles.iconButton}
          aria-label="Clear console"
          title="Clear"
        >
          <Eraser size={14} />
        </button>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className={styles.iconButton}
            aria-label="Collapse console panel"
            title="Collapse panel"
          >
            <PanelBottomClose size={14} />
          </button>
        )}
      </div>
      <div className={styles.body} ref={bodyRef} role="log" aria-live="polite">
        {!hideBrand && (
          <div className={styles.brandBlock}>
            <pre className={styles.liturgy}>{PATER_NOSTER}</pre>
            <pre className={styles.asciiArt}>{CRUCIFIX_ASCII}</pre>
            <pre className={styles.liturgy}>{AVE_MARIA}</pre>
            <pre
              className={`${styles.asciiArt} ${styles.asciiArtDense} ${styles.asciiArtColor}`}
              // Colored per-character art (user-supplied MARI image → HTML spans).
              dangerouslySetInnerHTML={{ __html: MADONNA_ASCII_HTML }}
            />
            <div className={styles.brandSplash}>{BRAND_WORDMARK}</div>
            <div className={styles.brandSubtitle}>{brandSubtitle}</div>
          </div>
        )}
        {filtered.map((evt, i) => (
          <ConsoleLine key={i} evt={evt} />
        ))}
      </div>
      <form className={styles.prompt} onSubmit={handleSubmit}>
        <Terminal size={12} color="var(--hc-fg-muted)" />
        <span className={styles.promptCaret}>›</span>
        <input
          className={styles.promptInput}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            const matches = completeConsoleInput(input);
            if (matches.length !== 1 || !matches[0]) return;
            event.preventDefault();
            setInput(matches[0]);
          }}
          placeholder="Type a command…  (help lists commands)"
          aria-label="Console command"
          spellCheck={false}
          autoComplete="off"
        />
        <span className={styles.promptHint}>↵ run</span>
      </form>
    </div>
  );
}

function ConsoleLine({ evt }: { evt: LogEvent }): JSX.Element {
  const time = new Date(evt.timestamp).toISOString().slice(11, 19);
  const pct = evt.progress != null ? Math.round(evt.progress * 100) : null;
  return (
    <div className={`${styles.line} ${styles[evt.level]}`}>
      <span className={styles.time}>{time}</span>
      <span className={styles.source}>{evt.source}</span>
      <span className={styles.level}>{evt.level}</span>
      <span className={styles.msg}>
        {evt.message}
        {pct != null && (
          <span className={styles.progressWrap}>
            <span className={styles.progressTrack}>
              <span className={styles.progressFill} style={{ width: `${pct}%` }} />
            </span>
            <span className={styles.progressLabel}>{pct}%</span>
          </span>
        )}
      </span>
    </div>
  );
}
