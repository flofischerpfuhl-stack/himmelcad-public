/**
 * Short user notices (the shell's toast) for code below the shell: a module
 * reports what happened with {@link notify}; the shell installs the sink
 * (`interface/shell-ui/module.ts`). Without a sink (headless) notices are
 * dropped.
 */
export type NoticeTone = 'info' | 'warning';

let sink: (text: string, tone: NoticeTone) => void = () => undefined;

/** Shows `text` to the user. */
export function notify(text: string, tone: NoticeTone = 'info'): void {
  sink(text, tone);
}

/** The shell's toast (installed once by the shell module). */
export function setNoticeSink(show: (text: string, tone: NoticeTone) => void): void {
  sink = show;
}
