import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

const INITIAL_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function unsupportedPackageReason(): string | null {
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return 'automatic updates require the AppImage package';
  }
  if (
    process.platform === 'win32' &&
    (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
  ) {
    return 'automatic updates require the NSIS setup package';
  }
  return null;
}

export function startDesktopUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return;
  if (!['win32', 'linux'].includes(process.platform)) return;
  const unsupportedReason = unsupportedPackageReason();
  if (unsupportedReason) {
    console.info(`[updater] ${unsupportedReason}`);
    return;
  }

  // Builder and PhotoLab use custom metadata files in one shared release. Keep
  // prerelease channel inference disabled so electron-updater honors those names.
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  let checkInFlight = false;
  let promptVisible = false;
  const check = async (): Promise<void> => {
    if (checkInFlight) return;
    checkInFlight = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.warn('[updater] update check failed', error);
    } finally {
      checkInFlight = false;
    }
  };

  autoUpdater.on('update-available', (info) => {
    console.info(`[updater] downloading version ${info.version}`);
  });
  autoUpdater.on('update-not-available', (info) => {
    console.info(`[updater] version ${info.version} is current`);
  });
  autoUpdater.on('error', (error) => {
    console.warn('[updater] update failed', error);
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (promptVisible) return;
    promptVisible = true;
    const options: MessageBoxOptions = {
      type: 'info',
      title: 'HimmelCAD PhotoLab update ready',
      message: `HimmelCAD PhotoLab ${info.version} is ready to install.`,
      detail:
        'Restart now to use the latest build, or continue working and install it when the app closes.',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const parent = getWindow();
    const response = parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options);
    void response
      .then(({ response: selected }) => {
        if (selected === 0) autoUpdater.quitAndInstall(false, true);
      })
      .catch((error: unknown) => {
        console.warn('[updater] unable to show update prompt', error);
      })
      .finally(() => {
        promptVisible = false;
      });
  });

  const initialTimer = setTimeout(() => void check(), INITIAL_CHECK_DELAY_MS);
  initialTimer.unref();
  const periodicTimer = setInterval(() => void check(), PERIODIC_CHECK_INTERVAL_MS);
  periodicTimer.unref();
}
