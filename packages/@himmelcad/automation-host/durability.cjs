'use strict';

const BEST_EFFORT_DIRECTORY_SYNC_ERRORS = new Set([
  'EACCES',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EPERM',
]);

async function syncDirectory(filesystem, directory, platform = process.platform) {
  if (platform === 'win32') return false;

  let handle = null;
  try {
    handle = await filesystem.open(directory, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (!BEST_EFFORT_DIRECTORY_SYNC_ERRORS.has(error?.code)) throw error;
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

module.exports = { syncDirectory };
