export interface BuilderDurabilityStatus {
  readonly state: 'stored' | 'storing' | 'failed';
  readonly visibleGeneration: number;
  readonly durableGeneration: number;
  readonly acknowledgedAtMs: number;
  readonly pendingCount: number;
  readonly reason: string | null;
  readonly recoveredTailCount: number;
}

function sameDurabilityStatus(
  left: BuilderDurabilityStatus,
  right: BuilderDurabilityStatus,
): boolean {
  return (
    left.state === right.state &&
    left.visibleGeneration === right.visibleGeneration &&
    left.durableGeneration === right.durableGeneration &&
    left.acknowledgedAtMs === right.acknowledgedAtMs &&
    left.pendingCount === right.pendingCount &&
    left.reason === right.reason &&
    left.recoveredTailCount === right.recoveredTailCount
  );
}

export function startDurabilityPolling(
  read: () => Promise<BuilderDurabilityStatus>,
  publish: (status: BuilderDurabilityStatus) => void,
  onError: (error: unknown) => void,
  intervalMs = 25,
): () => void {
  let stopped = false;
  let polling = false;
  let published: BuilderDurabilityStatus | undefined;
  const poll = (): void => {
    if (polling) return;
    polling = true;
    void read()
      .then((status) => {
        if (!stopped && (!published || !sameDurabilityStatus(published, status))) {
          published = status;
          publish(status);
        }
      })
      .catch((error: unknown) => {
        if (!stopped) onError(error);
      })
      .finally(() => {
        polling = false;
      });
  };
  poll();
  const timer = globalThis.setInterval(poll, intervalMs);
  return () => {
    stopped = true;
    globalThis.clearInterval(timer);
  };
}
