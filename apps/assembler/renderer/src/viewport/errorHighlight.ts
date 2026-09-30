/**
 * The geometry a feature error points at (`EvaluationResult.errorRefs`):
 * while a tool's preview fails (e.g. a fillet radius too large for one
 * edge), or when the History card of a failing feature is selected. The
 * keys name the body as it was before the failing feature, so the lines
 * come from the committed model (the preview shows the last valid result).
 */
import { baseEdgeKey, baseFaceKey } from '../kernel/naming.js';
import type { FeatureErrorRefs } from '../kernel/types.js';
import { isPreviewTool, type AssemblerState } from '../model/store.js';

export function errorHighlightOf(
  state: Pick<AssemblerState, 'activeTool' | 'selection' | 'evaluation'>,
): { segments: Float32Array[] } | null {
  let refs: FeatureErrorRefs | null | undefined = null;
  const tool = state.activeTool;
  if (isPreviewTool(tool)) {
    refs = tool.previewError !== null ? tool.previewErrorRefs : null;
  } else if (!tool) {
    const card = state.selection.find((s) => s.kind === 'feature');
    if (card?.kind === 'feature') refs = state.evaluation.errorRefs?.[card.featureId];
  }
  if (!refs) return null;
  const body = state.evaluation.bodies.find((b) => b.id === refs.bodyId);
  if (!body) return null;
  const edgeKeys = new Set((refs.edgeKeys ?? []).map(baseEdgeKey));
  const faceKeys = new Set((refs.faceKeys ?? []).map(baseFaceKey));
  const segments: Float32Array[] = [];
  body.edges.forEach((edge) => {
    if (edgeKeys.has(baseEdgeKey(edge.key))) segments.push(edge.segments);
  });
  body.faces.forEach((face) => {
    if (!faceKeys.has(baseFaceKey(face.key))) return;
    for (const e of face.edgeIndices) {
      const edge = body.edges[e];
      if (edge) segments.push(edge.segments);
    }
  });
  return segments.length > 0 ? { segments } : null;
}
