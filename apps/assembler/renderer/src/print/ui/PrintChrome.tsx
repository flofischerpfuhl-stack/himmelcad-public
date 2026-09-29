/** Everything Print mode adds to the chrome: the Printability panel, the place-on-plate hint and the dialogs. */
import { SlicerDialog, StlExportDialog } from './PrintDialogs.js';
import { PlacePickHint, PrintPanel } from './PrintPanel.js';

export function PrintChrome(): JSX.Element {
  return (
    <>
      <PrintPanel />
      <PlacePickHint />
      <StlExportDialog />
      <SlicerDialog />
    </>
  );
}
