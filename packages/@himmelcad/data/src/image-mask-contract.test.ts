import type { EditImageMaskParams, EntityId, ImageMaskEdit } from './index.js';

const brushEdit = {
  kind: 'brush',
  stroke: {
    mode: 'add',
    radiusPixels: 12,
    points: [{ xPixels: 10.5, yPixels: 20.5 }],
  },
} satisfies ImageMaskEdit;

const request = {
  operationId: 'mask-edit-1',
  imageEntityId: 'camera-1' as EntityId,
  edit: brushEdit,
} satisfies EditImageMaskParams;

function assertExhaustive(edit: ImageMaskEdit): string {
  switch (edit.kind) {
    case 'brush':
      return edit.stroke.mode;
    case 'clear':
      return edit.kind;
    case 'restore':
      return edit.revisionSha256;
  }
}

void request;
void assertExhaustive;
