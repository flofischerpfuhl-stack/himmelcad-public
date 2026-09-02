import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cameraRotationToYawPitchRoll,
  humanizeEnum,
  isVideoImportPath,
  naturalNameCompare,
  splitImageImportPaths,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './photolabFormatting.ts';

describe('PhotoLab formatting', () => {
  it('sorts names naturally', () => {
    const names = ['DJI_10.JPG', 'DJI_2.JPG', 'dji_1.jpg'];
    assert.deepEqual(names.sort(naturalNameCompare), ['dji_1.jpg', 'DJI_2.JPG', 'DJI_10.JPG']);
  });

  it('keeps Cap packages out of image inspection inputs', () => {
    assert.deepEqual(splitImageImportPaths(['/survey/A.HCAP', '/survey/DJI_1.JPG']), {
      himmelcapPaths: ['/survey/A.HCAP'],
      imagePaths: ['/survey/DJI_1.JPG'],
      videoPaths: [],
    });
  });

  it('routes video files away from ordinary image inspection', () => {
    assert.deepEqual(
      splitImageImportPaths(['/survey/walk.MP4', '/survey/frame.jpg', '/survey/clip.webm']),
      {
        himmelcapPaths: [],
        imagePaths: ['/survey/frame.jpg'],
        videoPaths: ['/survey/walk.MP4', '/survey/clip.webm'],
      },
    );
    assert.equal(isVideoImportPath('/survey/clip.m4v'), true);
    assert.equal(isVideoImportPath('/survey/photo.jpeg'), false);
  });

  it('humanizes camel-case and compatibility enum spellings', () => {
    assert.equal(humanizeEnum('needsReview'), 'Needs review');
    assert.equal(humanizeEnum('embeddedCalibration'), 'Embedded calibration');
    assert.equal(humanizeEnum('camera_image'), 'Camera image');
  });

  it('converts a camera rotation matrix to north-based yaw, pitch, and roll', () => {
    const orientation = cameraRotationToYawPitchRoll([1, 0, 0, 0, 0, 1, 0, -1, 0]);
    assert.ok(orientation);
    assert.ok(Math.abs(orientation.yaw) < 1e-10);
    assert.ok(Math.abs(orientation.pitch) < 1e-10);
    assert.ok(Math.abs(orientation.roll) < 1e-10);
  });
});
