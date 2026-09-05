import { renderToStaticMarkup } from 'react-dom/server';

import { Button } from '../src/Button.js';
import { Dialog } from '../src/Dialog.js';
import { DurabilityIndicator } from '../src/DurabilityIndicator.js';
import { ContextMenu, Menu, MenuItem, MenuSeparator } from '../src/Menu.js';
import { NumberInput } from '../src/NumberInput.js';
import { ProgressBar } from '../src/ProgressBar.js';
import { Ribbon } from '../src/Ribbon.js';
import { Slider } from '../src/Slider.js';
import { SpinnerVisual } from '../src/Spinner.js';
import { Toast, ToastRegion } from '../src/Toast.js';
import { Tooltip } from '../src/Tooltip.js';

export function accessibilityFixtures(): Record<string, string> {
  return {
    Menu: renderToStaticMarkup(
      <Menu onClose={() => undefined}>
        <MenuItem>Open project</MenuItem>
        <MenuItem>Save project</MenuItem>
        <MenuSeparator />
        <MenuItem>Delete selection</MenuItem>
      </Menu>,
    ),
    ContextMenu: renderToStaticMarkup(
      <ContextMenu x={0} y={0} onClose={() => undefined}>
        <MenuItem>Inspect</MenuItem>
      </ContextMenu>,
    ),
    Button: renderToStaticMarkup(<Button variant="primary">Save project</Button>),
    DurabilityIndicator: renderToStaticMarkup(
      <DurabilityIndicator
        state={{ kind: 'failed', reason: 'Disk is full' }}
        onRetry={() => undefined}
      />,
    ),
    NumberInput: renderToStaticMarkup(<NumberInput aria-label="Length" defaultValue={1} />),
    Toast: renderToStaticMarkup(
      <ToastRegion>
        <Toast tone="info" autoDismiss={false} onDismiss={() => undefined}>
          Project saved
        </Toast>
      </ToastRegion>,
    ),
    Spinner: renderToStaticMarkup(<SpinnerVisual label="Loading" size="medium" />),
    Tooltip: renderToStaticMarkup(
      <Tooltip content="Help" open>
        <button type="button">Help</button>
      </Tooltip>,
    ),
    Slider: renderToStaticMarkup(<Slider aria-label="Size" defaultValue={2} />),
    Dialog: renderToStaticMarkup(
      <Dialog
        open
        onClose={() => undefined}
        title="Delete 3 entities?"
        actions={
          <>
            <Button variant="secondary">Cancel</Button>
            <Button variant="danger">Delete</Button>
          </>
        }
      >
        The selected entities will be permanently removed from the project.
      </Dialog>,
    ),
    ProgressBar: renderToStaticMarkup(<ProgressBar value={0.5} ariaLabel="Progress" />),
    Ribbon: renderToStaticMarkup(
      <Ribbon
        tabs={[
          { id: 'home', label: 'Home', groups: [] },
          { id: 'view', label: 'View', groups: [] },
        ]}
      />,
    ),
  };
}
