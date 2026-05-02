import type { Object3D } from 'three';

import type { EntityId } from '@himmelcad/data';

/**
 * A renderable layer in the scene graph. Each entity kind that wants to draw
 * something registers a layer implementation. Layers must avoid mutating
 * application state; they only react to the latest snapshot from the core.
 */
export interface Layer {
  readonly id: string;
  readonly entityId: EntityId;
  readonly object3d: Object3D;

  setVisible(visible: boolean): void;
  dispose(): void;
}
