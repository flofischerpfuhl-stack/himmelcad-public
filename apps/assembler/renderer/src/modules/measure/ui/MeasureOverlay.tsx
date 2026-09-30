/**
 * Dimension overlays of the Measure mode, drawn over the viewport with the
 * shared `MeasurementGraphics` (`@himmelcad/ui`): the current measurement
 * (preview style) and every pinned measurement whose "Show in viewport" is
 * on. Screen positions follow the camera every drawn frame (`tick`).
 */
import { MeasurementGraphics, type MeasurementGraphicItem } from '@himmelcad/ui';

import type { Measurement, Vec3 } from '../measure.js';
import { graphicLabel, useDisplayUnit, useLiveMeasurements } from '../measureLive.js';
import { useMeasureStore } from '../measureStore.js';

export interface MeasureOverlayProps {
  /** Bumped every drawn frame. */
  tick: number;
  /** World point → host-relative CSS px, `null` behind the camera. */
  project: (point: Vec3) => [number, number] | null;
}

function itemsOf(
  id: string,
  m: Measurement,
  project: MeasureOverlayProps['project'],
  unit: ReturnType<typeof useDisplayUnit>,
  preview: boolean,
): MeasurementGraphicItem[] {
  const out: MeasurementGraphicItem[] = [];
  m.graphics.forEach((g, index) => {
    const points = g.kind === 'segment' ? [g.a, g.b] : [g.at];
    const anchors = points.map(project);
    if (anchors.some((a) => a === null)) return;
    out.push({
      id: `${id}:${index}`,
      anchors: (anchors as [number, number][]).map(([x, y]) => ({ x, y })),
      label: graphicLabel(m, index, unit),
      preview,
    });
  });
  return out;
}

export function MeasureOverlay({ tick, project }: MeasureOverlayProps): JSX.Element | null {
  void tick;
  const unit = useDisplayUnit();
  const live = useLiveMeasurements();
  const points = useMeasureStore((s) => s.points);
  const items: MeasurementGraphicItem[] = [];
  for (const { pin, measurement } of live.pinned) {
    if (pin.showInViewport) items.push(...itemsOf(pin.id, measurement, project, unit, false));
  }
  if (live.current && live.current.measurement.values.length > 0) {
    items.push(...itemsOf('current', live.current.measurement, project, unit, true));
  } else if (points.length === 1 && points[0]!.kind === 'point') {
    const at = project(points[0]!.point);
    if (at) {
      items.push({
        id: 'point',
        anchors: [{ x: at[0], y: at[1] }],
        label: 'Point 1',
        preview: true,
      });
    }
  }
  if (items.length === 0) return null;
  return <MeasurementGraphics items={items} />;
}
