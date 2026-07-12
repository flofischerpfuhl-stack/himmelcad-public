import type { LogEvent, LogLevel } from '@himmelcad/data';

type Listener = () => void;

const RING_SIZE = 5000;

class ConsoleStore {
  private events: LogEvent[] = [];
  private listeners = new Set<Listener>();

  push(event: LogEvent): void {
    if (event.progressKey) {
      const idx = this.events.findIndex((e) => e.progressKey === event.progressKey);
      if (idx !== -1) {
        this.events = this.events.map((existing, i) => (i === idx ? event : existing));
        for (const l of this.listeners) l();
        return;
      }
    }
    this.events = [...this.events.slice(Math.max(0, this.events.length - RING_SIZE + 1)), event];
    for (const l of this.listeners) l();
  }

  clear(): void {
    this.events = [];
    for (const l of this.listeners) l();
  }

  getSnapshot(): readonly LogEvent[] {
    return this.events;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const consoleStore = new ConsoleStore();

export function useConsoleStore(): readonly LogEvent[] {
  // INVARIANT: We deliberately keep the React import out of this module so it
  // can be consumed without React when needed. The React-bound hook lives in
  // useConsoleStoreReact.ts to keep this file framework-free.
  return consoleStore.getSnapshot();
}

export function logEvent(level: LogLevel, source: LogEvent['source'], message: string, data?: Record<string, unknown>): void {
  consoleStore.push({
    level,
    source,
    message,
    timestamp: Date.now(),
    ...(data ? { data } : {}),
  });
}
