export interface ProjectInteractionLifecycle {
  readonly draw: {
    snapshot(): { readonly armed: boolean };
    cancelAll(): Promise<boolean>;
  };
  readonly measurement: {
    cancel(): boolean;
  };
  readonly construction: {
    disarm(): void;
  };
  readonly clearSelection: () => Promise<void>;
  readonly clearHudOverlays: () => void;
  readonly clearArmedPlacement: () => void;
  readonly closeFunctionTabs: () => void;
}

/** Ends project-owned acquisition in the same inside-out order as Escape. */
export async function retireProjectInteractionState(
  lifecycle: ProjectInteractionLifecycle,
): Promise<void> {
  lifecycle.construction.disarm();
  if (lifecycle.draw.snapshot().armed) await lifecycle.draw.cancelAll();
  lifecycle.measurement.cancel();
  lifecycle.clearArmedPlacement();
  lifecycle.clearHudOverlays();
  await lifecycle.clearSelection();
  lifecycle.closeFunctionTabs();
}
