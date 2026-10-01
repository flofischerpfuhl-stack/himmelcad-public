/**
 * Viewport overlays the modules contribute (assembler/MODULES.md §3): flat
 * GL batches drawn after the bodies — on body surfaces (below edges and
 * highlights) or last (translucent volumes). A module registers a provider
 * through its UI part (`defineModuleUi({ viewportOverlays })`); the
 * viewport asks every provider per frame and redraws when one reports a
 * change. The viewport itself never imports a module.
 */
import type { Body } from '../../foundation/geometry-kernel/types.js';
import type { FlatBatch } from './gl.js';

export interface OverlayFrameInput {
  bodies: readonly Body[];
  hiddenBodyIds: readonly string[];
  isolatedBodyIds: readonly string[] | null;
}

export interface OverlayBatches {
  /** On body surfaces: drawn below edges and highlights. */
  surface: FlatBatch[];
  /** Translucent volumes: drawn last. */
  last: FlatBatch[];
}

export interface ViewportOverlayProvider {
  id: string;
  /** Draw order among providers (lower first). */
  order: number;
  /** The batches of the current frame; cache on your own inputs, this runs every frame. */
  batches(input: OverlayFrameInput): OverlayBatches;
  /** Calls `onChange` when the overlay changed on its own (not through the document). */
  subscribe?(onChange: () => void): () => void;
}

const EMPTY: OverlayBatches = { surface: [], last: [] };
const providers: ViewportOverlayProvider[] = [];

export function registerViewportOverlay(provider: ViewportOverlayProvider): void {
  if (providers.some((p) => p.id === provider.id)) {
    throw new Error(`Viewport overlay "${provider.id}" is registered twice`);
  }
  providers.push(provider);
  providers.sort((x, y) => x.order - y.order);
}

/** Every provider's batches of this frame, in order. */
export function viewportOverlayBatches(input: OverlayFrameInput): OverlayBatches {
  if (providers.length === 0) return EMPTY;
  if (providers.length === 1) return providers[0]!.batches(input);
  const surface: FlatBatch[] = [];
  const last: FlatBatch[] = [];
  for (const provider of providers) {
    const batches = provider.batches(input);
    surface.push(...batches.surface);
    last.push(...batches.last);
  }
  return { surface, last };
}

/** Calls `onChange` whenever any provider reports a change. */
export function subscribeViewportOverlays(onChange: () => void): () => void {
  const unsubscribe = providers.map((p) => p.subscribe?.(onChange) ?? (() => undefined));
  return () => unsubscribe.forEach((u) => u());
}
