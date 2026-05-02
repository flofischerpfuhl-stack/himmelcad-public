import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { LogEvent, LogLevel } from '@himmelcad/data';

import { consoleStore } from './store.js';
import styles from './Console.module.css';

export interface ConsoleProps {
  defaultLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function Console({ defaultLevel = 'info' }: ConsoleProps): JSX.Element {
  const [level, setLevel] = useState<LogLevel>(defaultLevel);
  const [query, setQuery] = useState('');

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
    const el = document.getElementById('hc-console-tail');
    if (el) el.scrollIntoView({ block: 'end' });
  }, [filtered.length]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel)}
          className={styles.select}
          aria-label="Log level"
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
          placeholder="Search…"
          aria-label="Search console"
        />
        <button onClick={() => consoleStore.clear()} className={styles.clear}>
          Clear
        </button>
      </div>
      <div className={styles.body} role="log" aria-live="polite">
        {filtered.map((evt, i) => (
          <ConsoleLine key={i} evt={evt} />
        ))}
        <div id="hc-console-tail" />
      </div>
    </div>
  );
}

function ConsoleLine({ evt }: { evt: LogEvent }): JSX.Element {
  const time = new Date(evt.timestamp).toISOString().slice(11, 19);
  return (
    <div className={`${styles.line} ${styles[evt.level]}`}>
      <span className={styles.time}>{time}</span>
      <span className={styles.source}>{evt.source}</span>
      <span className={styles.level}>{evt.level}</span>
      <span className={styles.msg}>{evt.message}</span>
    </div>
  );
}
