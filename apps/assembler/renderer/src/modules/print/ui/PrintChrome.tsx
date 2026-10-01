/** Everything Print mode adds to the chrome: the Printability panel, the place-on-plate hint and the STL export dialog. */
import { StlExportDialog } from './PrintDialogs.js';
import { PlacePickHint, PrintPanel } from './PrintPanel.js';

export function PrintChrome(): JSX.Element {
  return (
    <>
      <PrintPanel />
      <PlacePickHint />
      <StlExportDialog />
    </>
  );
}
