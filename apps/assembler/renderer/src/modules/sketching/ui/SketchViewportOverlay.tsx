/**
 * Sketch mode in the viewport as a registered DOM overlay
 * (`platform/viewport/domOverlays.ts`): the camera turns normal to the
 * sketch plane when a session starts (and back when it ends,
 * `useSketchViewport.ts`), and the sketch overlay draws and edits the
 * sketch while a session runs.
 */
import type { ViewportDomOverlayProps } from '../../../platform/viewport/domOverlays.js';
import { SketchOverlay } from './SketchOverlay.js';
import { useSketchViewport } from './useSketchViewport.js';

export function SketchViewportOverlay({ host, tick }: ViewportDomOverlayProps): JSX.Element | null {
  const sketch = useSketchViewport(host);
  return sketch.session ? <SketchOverlay api={sketch.api} tick={tick} /> : null;
}
