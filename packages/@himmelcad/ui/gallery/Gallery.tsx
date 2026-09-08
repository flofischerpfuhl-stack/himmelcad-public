import type { EntityId, ObjectHash, ProjectSnapshot } from '@himmelcad/data';
import { DEFAULT_VIEWPORT_BOTTOM_BAR_STATE } from '@himmelcad/app';
import {
  ConstructionBar,
  ViewportHud,
  Button,
  Checkbox,
  ContextMenu,
  Dialog,
  DurabilityIndicator,
  EdgeStrip,
  EmptyState,
  EntityTree,
  InteractionStateCheckbox,
  EntityCommandMenu,
  FunctionPanel,
  IslandTabs,
  JobsIsland,
  JobsStatusChip,
  type JobSurfaceItem,
  Menu,
  MenuItem,
  MenuSeparator,
  MeasurementGraphics,
  MeasurementLiveReadout,
  MixedPropertyMarker,
  NumberInput,
  OverlayAxis,
  OverlayChip,
  OverlayKind,
  PanelToggles,
  PointCloudDisplayProperties,
  ProgressBar,
  QuickCommandSurface,
  Radio,
  Ribbon,
  Select,
  SelectionCandidateIndicator,
  SelectionPropertiesSummary,
  SelectionVisuals,
  Slider,
  Splitter,
  StatusBar,
  TitleBar,
  Toast,
  ToastRegion,
  Tooltip,
  ViewportBottomBar,
} from '../src/index.js';
import { SpinnerVisual } from '../src/Spinner.js';
import { accessibilityFixtures } from '../test/a11yFixtures.js';
import { useEffect, useRef, type ReactNode } from 'react';

type State =
  | 'default'
  | 'hover'
  | 'focus-visible'
  | 'disabled'
  | 'invalid'
  | 'loading'
  | 'single'
  | 'multi'
  | 'needs-input'
  | 'cancelling'
  | 'failed'
  | 'completed'
  | 'unknown-units'
  | 'island'
  | 'idle'
  | 'baking'
  | 'locked';

interface ComponentSpec {
  name: string;
  states?: readonly (State | GalleryRow)[];
  render: (state: State, row?: GalleryRow) => ReactNode;
}

interface GalleryRow {
  key: string;
  label: string;
  state: State;
  value?: string;
}

const noop = (): void => undefined;
const galleryPointCloudDisplay = {
  schemaId: 'hcad.resource.point-cloud-display@1',
  pointSizePixels: 2,
  colorMode: 'classification',
  classes: [
    { code: 0, name: 'Created, never classified', visible: true },
    { code: 2, name: 'Ground', visible: true },
    { code: 5, name: 'High vegetation', visible: false },
    { code: 6, name: 'Building', visible: true },
    { code: 9, name: 'Water', visible: true },
  ],
} as const;
const galleryPointCloudDisplayMixed = {
  ...galleryPointCloudDisplay,
  classes: galleryPointCloudDisplay.classes.map((item) =>
    item.code === 5 ? { ...item, visible: true } : item,
  ),
};
const id = (value: string): EntityId => value as EntityId;
const hash = (value: string): ObjectHash => value as ObjectHash;

const project: ProjectSnapshot = {
  formatVersion: 1,
  projectId: 'gallery-project',
  name: 'Site survey',
  rootEntity: id('root'),
  renderOffset: { x: 0, y: 0, z: 0 },
  entities: {
    root: {
      id: id('root'),
      kind: 'ProjectRoot',
      name: 'Site survey',
      parent: null,
      children: [id('cloud'), id('surface')],
      visibility: { visible: true, locked: false },
      versionHash: hash('root-hash'),
      bounds: null,
    },
    cloud: {
      id: id('cloud'),
      kind: 'PointCloud',
      name: 'Registered point cloud',
      parent: id('root'),
      children: [],
      visibility: { visible: true, locked: false },
      versionHash: hash('cloud-hash'),
      bounds: null,
    },
    surface: {
      id: id('surface'),
      kind: 'Surface',
      name: 'Existing ground',
      parent: id('root'),
      children: [],
      visibility: { visible: false, locked: false },
      versionHash: hash('surface-hash'),
      bounds: null,
    },
  },
};

const ribbonTabs = [
  {
    id: 'home',
    label: 'Home',
    groups: [
      {
        id: 'project',
        label: 'Project',
        actions: [
          { id: 'open', label: 'Open', shortcut: 'Ctrl+O' },
          { id: 'save', label: 'Save', shortcut: 'Ctrl+S' },
        ],
      },
    ],
  },
  { id: 'view', label: 'View', groups: [] },
];

const baseStates = ['default', 'hover', 'focus-visible'] as const;
const galleryJob = (
  id: string,
  state: JobSurfaceItem['state'],
  phase: string,
  fraction: number | null,
): JobSurfaceItem => ({
  id,
  label: `Import ${id}.laz`,
  state,
  phase,
  fraction,
  cancellation: { cancellable: state !== 'failed' },
  registeredAtUnixMs: 0,
  finishedAtUnixMs:
    state === 'failed' || state === 'completed' || state === 'cancelled' ? 1_000 : null,
  suppressChip: false,
});
const row = (key: string, label: string, state: State, value?: string): GalleryRow =>
  value === undefined ? { key, label, state } : { key, label, state, value };

const specs: readonly ComponentSpec[] = [
  {
    name: 'Command surfaces',
    states: [
      row('entity-menu', 'entity menu · polyline selected', 'default', 'entity'),
      row('photolab-product-menu', 'PhotoLab product node menu', 'default', 'photolab-product'),
      row('quick-surface', 'void quick surface', 'default', 'quick'),
      row('candidate-submenu', 'Select under cursor · open', 'default', 'submenu'),
    ],
    render: (_state, galleryRow) => {
      const isPhotolabProduct = galleryRow?.value === 'photolab-product';
      const commandContext = {
        hasProject: true,
        productId: isPhotolabProduct ? 'photolab' : 'builder',
        selectedEntityIds: [isPhotolabProduct ? 'dense-cloud' : 'boundary'],
        selectedEntityKinds: [isPhotolabProduct ? 'cloud' : 'polyline'] as const,
        selectedCanonicalEntityKinds: [isPhotolabProduct ? 'PointCloud' : 'Polyline3D'],
        entityKind: isPhotolabProduct ? 'PointCloud' : 'Polyline3D',
        selectionVisibility: 'visible' as const,
        selectionEditable: true,
        selectionExportable: true,
        clipboardAdmissible: true,
        candidates:
          galleryRow?.value === 'quick'
            ? []
            : [
                { entityId: 'boundary', kind: 'Polyline', name: 'North boundary' },
                { entityId: 'ground', kind: 'Mesh', name: 'Existing ground' },
                { entityId: 'station', kind: 'Point', name: 'Station 104' },
              ],
      };
      return galleryRow?.value === 'quick' ? (
        <QuickCommandSurface
          x={24}
          y={48}
          context={commandContext}
          onExecute={noop}
          onClose={noop}
        />
      ) : (
        <EntityCommandMenu
          x={24}
          y={48}
          context={commandContext}
          target={{
            entityIds: commandContext.selectedEntityIds,
            kind: commandContext.entityKind,
          }}
          currentCandidateId="boundary"
          candidateSubmenuOpen={galleryRow?.value === 'submenu'}
          onExecute={noop}
          onClose={noop}
        />
      );
    },
  },
  {
    name: 'File surfaces',
    states: ['default'],
    render: () => (
      <div style={{ display: 'grid', gap: 16, minWidth: 520 }}>
        <Menu ariaLabel="Recent projects" autoFocus={false} onClose={noop}>
          <MenuItem onSelect={noop}>
            <span style={{ display: 'grid', gap: 3, textAlign: 'left' }}>
              <span>Site survey</span>
              <span
                style={{
                  color: 'var(--hc-fg-muted)',
                  fontFamily: 'var(--hc-font-mono)',
                  fontSize: 10,
                }}
              >
                /projects/munich/site-survey.hcad
              </span>
            </span>
          </MenuItem>
          <MenuItem onSelect={noop}>
            <span style={{ display: 'grid', gap: 3, textAlign: 'left' }}>
              <span>Bridge scan</span>
              <span
                style={{
                  color: 'var(--hc-fg-muted)',
                  fontFamily: 'var(--hc-font-mono)',
                  fontSize: 10,
                }}
              >
                /projects/inn/bridge-scan.hcad
              </span>
            </span>
          </MenuItem>
        </Menu>
        <Toast
          tone="warning"
          autoDismiss={false}
          action={
            <Button size="small" variant="quiet" onClick={noop}>
              Show in console
            </Button>
          }
        >
          Recovered 14 unsaved changes from 09:42:18
        </Toast>
      </div>
    ),
  },
  {
    name: 'Selection surfaces',
    states: ['default'],
    render: () => (
      <div className="selectionSurfacesFixture">
        <StatusBar
          items={[
            { id: 'candidate', content: <SelectionCandidateIndicator index={0} count={3} /> },
          ]}
        />
        <div className="selectionPropertiesFixture">
          <SelectionPropertiesSummary count={3} perKind={{ point: 2, polyline: 1 }} />
          <label>
            Elevation
            <MixedPropertyMarker />
          </label>
          <label>
            Offset
            <NumberInput aria-label="Offset" defaultValue={12.5} unit="m" />
          </label>
        </div>
      </div>
    ),
  },
  {
    name: 'Bottom bar',
    states: ['default'],
    render: () => (
      <div className="interactionBarFixture">
        <ViewportBottomBar
          state={{
            ...DEFAULT_VIEWPORT_BOTTOM_BAR_STATE,
            granularity: 'segments',
            selectableKinds: {
              ...DEFAULT_VIEWPORT_BOTTOM_BAR_STATE.selectableKinds,
              points: false,
            },
          }}
          onSupportGeometryChange={noop}
          onExplodePolylinesChange={noop}
          onViewModeChange={noop}
          onSelectableKindChange={noop}
          onLabelsChange={noop}
        />
      </div>
    ),
  },
  {
    name: 'Construction bar',
    states: [
      row('cartesian', 'X / Y / Z', 'default', 'cartesian'),
      row('polar', 'Dir / Dist / Δz', 'focus-visible', 'polar'),
    ],
    render: (_state, galleryRow) => (
      <div className="interactionBarFixture">
        <ConstructionBar
          prompt={
            galleryRow?.value === 'polar'
              ? 'Line — constrain endpoint'
              : 'Point — pick or type position'
          }
          fields={
            galleryRow?.value === 'polar'
              ? [
                  { id: 'direction', label: 'Dir °', unit: '°', value: 32.5 },
                  { id: 'distance', label: 'Dist m', unit: 'm', value: 14.25 },
                  { id: 'deltaZ', label: 'Δz m', unit: 'm', value: 1.2 },
                ]
              : [
                  { id: 'x', label: 'X', unit: 'm', value: 691234.125 },
                  { id: 'y', label: 'Y', unit: 'm', value: 5338123.5 },
                  { id: 'z', label: 'Z', unit: 'm', value: 482.75 },
                ]
          }
          activeField={galleryRow?.value === 'polar' ? 'distance' : 'x'}
          candidateIndex={0}
          candidateCount={3}
        />
      </div>
    ),
  },
  {
    name: 'Tree states',
    states: ['default'],
    render: () => (
      <div className="treeStatesFixture">
        <InteractionStateCheckbox label="Hidden" state="hidden" onStateChange={noop} />
        <InteractionStateCheckbox label="Reference" state="reference" onStateChange={noop} />
        <InteractionStateCheckbox label="Editable" state="editable" onStateChange={noop} />
        <InteractionStateCheckbox label="Inert" state="inert" onStateChange={noop} />
        <InteractionStateCheckbox label="Mixed" state="mixed" onStateChange={noop} />
        <span>Hidden</span>
        <span>Reference</span>
        <span>Editable</span>
        <span>Inert</span>
        <span>Mixed</span>
      </div>
    ),
  },
  {
    name: 'Selection visuals',
    states: ['default'],
    render: () => <SelectionVisuals supportVisible directionArrowSize={10} />,
  },
  {
    name: 'Measurement tool',
    states: [
      row('live', 'live readout + idle chip', 'default', 'live'),
      row('selected', 'selected chip', 'single', 'selected'),
    ],
    render: (_state, galleryRow) => (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 220px',
          gap: 12,
          width: 760,
        }}
      >
        <div
          style={{
            position: 'relative',
            height: 190,
            overflow: 'hidden',
            border: '1px solid var(--hc-border-subtle)',
            borderRadius: 'var(--hc-radius-md)',
            background:
              'linear-gradient(150deg, var(--hc-bg-panel), color-mix(in srgb, var(--hc-bg-panel) 70%, var(--hc-geometry-support)))',
          }}
        >
          <MeasurementGraphics
            items={[
              {
                id: 'distance-1',
                anchors: [
                  { x: 72, y: 126 },
                  { x: 230, y: 78 },
                ],
                label: '12.345 m',
                selected: galleryRow?.value === 'selected',
              },
              {
                id: 'dz-preview',
                anchors: [
                  { x: 164, y: 142 },
                  { x: 236, y: 126 },
                ],
                label: 'Δz 0.412 m',
                preview: true,
              },
            ]}
            onSelect={noop}
          />
        </div>
        <MeasurementLiveReadout
          prompt="Pick or type next point"
          value={galleryRow?.value === 'selected' ? '12.345 m' : 'Δz 0.412 m'}
        />
      </div>
    ),
  },
  {
    name: 'Viewing box panel',
    states: ['idle', 'baking', 'locked'],
    render: (state) => (
      <div className="viewingBoxFixture">
        <div className="viewingBoxFixtureViewport" data-state={state}>
          <span className="viewingBoxFixtureFace" />
          {state !== 'locked'
            ? [
                ['corner', 14, 23],
                ['corner', 38, 17],
                ['corner', 79, 17],
                ['corner', 86, 23],
                ['corner', 14, 77],
                ['corner', 21, 83],
                ['corner', 62, 83],
                ['corner', 86, 77],
                ['face', 50, 20],
                ['face', 50, 80],
                ['face', 14, 50],
                ['face', 86, 50],
                ['face', 26, 50],
                ['face', 74, 50],
              ].map(([kind, left, top], index) => (
                <span
                  key={`${kind}-${left}-${top}`}
                  className="viewingBoxFixtureGrip"
                  data-kind={kind}
                  data-active={index === 11 || undefined}
                  style={{ left: `${left}%`, top: `${top}%` }}
                />
              ))
            : null}
          {state === 'locked' ? <span className="viewingBoxFixtureLock">🔒 Locked</span> : null}
        </div>
        <div className="viewingBoxFixturePanel">
          <label>
            <span>Name</span>
            <input value="Viewing Box 1" readOnly />
          </label>
          <div className="viewingBoxFixtureSegment">
            <strong>Keep inside</strong>
            <span>Remove inside</span>
          </div>
          <div className="viewingBoxFixtureExtents">
            {['Min X', 'Max X', 'Min Y', 'Max Y', 'Min Z', 'Max Z'].map((label, index) => (
              <label key={label}>
                <span>{label}</span>
                <NumberInput
                  aria-label={label}
                  value={index % 2 === 0 ? -5 : 5}
                  unit="m"
                  disabled={state !== 'idle'}
                />
              </label>
            ))}
          </div>
          {state === 'baking' ? (
            <>
              <ProgressBar value={0.58} ariaLabel="Viewing box bake progress" />
              <Button size="small" variant="secondary">
                Cancel bake
              </Button>
            </>
          ) : state === 'locked' ? (
            <Button size="small" variant="primary">
              Unlock
            </Button>
          ) : (
            <Button size="small" variant="primary">
              Lock
            </Button>
          )}
        </div>
      </div>
    ),
  },
  {
    name: 'Jobs surfaces',
    states: [
      'single',
      'multi',
      'needs-input',
      'cancelling',
      'failed',
      'completed',
      'unknown-units',
      'island',
    ],
    render: (state) => {
      const running = galleryJob('scan_01', 'running', 'Building point hierarchy', 0.42);
      const waiting = galleryJob('scan_02', 'needs-input', 'Choose registration', null);
      const failed = galleryJob('scan_03', 'failed', 'Failed', 0.18);
      const cancelling = galleryJob(
        'scan_01',
        'cancelling',
        'Cancelling at next safe boundary',
        null,
      );
      const completed = galleryJob('scan_01', 'completed', 'Completed', 1);
      const unknown = galleryJob('scan_06', 'running', 'Indexing source tiles', null);
      if (state === 'island') {
        return (
          <JobsIsland
            jobs={[running, waiting, unknown, failed]}
            now={1_000}
            onCancel={noop}
            onRespond={noop}
          />
        );
      }
      if (state === 'unknown-units') {
        return <JobsIsland jobs={[unknown]} now={1_000} onCancel={noop} onRespond={noop} />;
      }
      return (
        <JobsStatusChip
          jobs={
            state === 'single'
              ? [running]
              : state === 'multi'
                ? [running, galleryJob('scan_04', 'running', 'Reading points', 0.18)]
                : state === 'needs-input'
                  ? [waiting]
                  : state === 'cancelling'
                    ? [cancelling]
                    : state === 'failed'
                      ? [failed]
                      : state === 'completed'
                        ? [completed]
                        : [running]
          }
          now={1_000}
          onClick={noop}
        />
      );
    },
  },
  {
    name: 'Import surfaces',
    states: ['default'],
    render: () => (
      <div className="importSurfacesFixture">
        <div className="importJobsFixture">
          <JobsIsland
            jobs={[
              galleryJob('scan_01', 'running', 'Reading header', 0.03),
              galleryJob('scan_02', 'running', 'Preparing hierarchy', 0.42),
              galleryJob('scan_03', 'running', 'Registering dataset', 0.82),
              galleryJob('scan_04', 'running', 'First frame', 0.99),
            ]}
            now={1_000}
            onCancel={noop}
            onRespond={noop}
          />
          <div className="importPlacementFixture">
            <span>CRS: EPSG:25832 · offset 0 0 0 · source units m</span>
            <Button variant="secondary" size="small">
              Change…
            </Button>
          </div>
        </div>
        <div className="importPropertiesFixture">
          <PointCloudDisplayProperties
            styles={[galleryPointCloudDisplay, galleryPointCloudDisplayMixed]}
            onChange={noop}
          />
        </div>
      </div>
    ),
  },
  {
    name: 'Menu',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <Menu onClose={noop} autoFocus={false}>
        <MenuItem data-gallery-active={state === 'hover' || state === 'focus-visible' || undefined}>
          Open project
        </MenuItem>
        <MenuItem>Save project</MenuItem>
        <MenuSeparator />
        <MenuItem disabled={state === 'disabled'}>Delete selection</MenuItem>
      </Menu>
    ),
  },
  {
    name: 'ContextMenu',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <ContextMenu x={0} y={0} onClose={noop} autoFocus={false}>
        <MenuItem data-gallery-active={state === 'hover' || state === 'focus-visible' || undefined}>
          Inspect
        </MenuItem>
        <MenuItem>Properties</MenuItem>
        <MenuSeparator />
        <MenuItem disabled={state === 'disabled'}>Delete selection</MenuItem>
      </ContextMenu>
    ),
  },
  {
    name: 'Button',
    states: [
      ...(['primary', 'secondary', 'quiet', 'danger'] as const).flatMap((variant) => [
        row(`${variant}-default`, `${variant} · default`, 'default', variant),
        row(`${variant}-hover`, `${variant} · hover`, 'hover', variant),
        row(`${variant}-focus`, `${variant} · focus`, 'focus-visible', variant),
        row(`${variant}-disabled`, `${variant} · disabled`, 'disabled', variant),
      ]),
      row('primary-loading', 'primary · loading', 'loading', 'primary'),
    ],
    render: (state, galleryRow) => (
      <Button
        disabled={state === 'disabled'}
        loading={state === 'loading'}
        variant={(galleryRow?.value ?? 'primary') as 'primary' | 'secondary' | 'quiet' | 'danger'}
        data-gallery-active={state === 'hover' || state === 'focus-visible' || undefined}
        data-gallery-variant={galleryRow?.value}
      >
        Save project
      </Button>
    ),
  },
  {
    name: 'NumberInput',
    states: [...baseStates, 'disabled', 'invalid'],
    render: (state) =>
      state === 'invalid' ? (
        <InvalidNumberInput />
      ) : (
        <NumberInput
          aria-label="Length"
          defaultValue={12.5}
          unit="m"
          disabled={state === 'disabled'}
        />
      ),
  },
  {
    name: 'Toast',
    states: [
      row('info', 'info', 'default', 'info'),
      row('success', 'success', 'default', 'success'),
      row('warning', 'warning', 'default', 'warning'),
      row('error', 'error', 'default', 'error'),
      row('close-hover', 'close · hover', 'hover', 'info'),
      row('close-focus', 'close · focus', 'focus-visible', 'info'),
    ],
    render: (_state, galleryRow) => (
      <ToastRegion>
        <Toast
          autoDismiss={false}
          tone={(galleryRow?.value ?? 'info') as 'info' | 'success' | 'warning' | 'error'}
          onDismiss={noop}
          action={galleryRow?.value === 'error' ? <a href="#retry">Retry</a> : undefined}
        >
          {galleryRow?.value === 'error' ? 'Could not save project' : 'Project saved'}
        </Toast>
      </ToastRegion>
    ),
  },
  { name: 'Spinner', render: () => <SpinnerVisual label="Loading" size="medium" /> },
  {
    name: 'Tooltip',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <Tooltip content="Frame all entities" open={state !== 'disabled'}>
        <button type="button" disabled={state === 'disabled'}>
          Frame all
        </button>
      </Tooltip>
    ),
  },
  {
    name: 'Slider',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <Slider
        aria-label="Point size"
        min={1}
        max={10}
        defaultValue={4}
        disabled={state === 'disabled'}
      />
    ),
  },
  {
    name: 'Dialog',
    states: [
      row('default', 'default', 'default'),
      row('delete-focus', 'Delete · focus', 'focus-visible', 'delete'),
      row('close-hover', 'close · hover', 'hover', 'close'),
    ],
    render: (_state, galleryRow) => (
      <Dialog
        open
        onClose={noop}
        title="Delete 3 entities?"
        actions={
          <>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="danger"
              data-gallery-active={galleryRow?.value === 'delete' || undefined}
            >
              Delete
            </Button>
          </>
        }
      >
        The selected entities will be permanently removed from the project.
      </Dialog>
    ),
  },
  {
    name: 'Snapshots menu',
    states: [
      row('list', 'list', 'default', 'list'),
      row('dialog', 'restore dialog', 'default', 'dialog'),
    ],
    render: (_state, galleryRow) =>
      galleryRow?.value === 'dialog' ? (
        <Dialog
          open
          onClose={noop}
          title="Restore snapshot?"
          actions={
            <>
              <Button variant="secondary">Cancel</Button>
              <Button variant="danger">Restore</Button>
            </>
          }
        >
          Restore snapshot 'Before grading'? Later changes stay in the journal and can be redone.
        </Dialog>
      ) : (
        <div className="snapshotsMenuFixture" role="menu" aria-label="Snapshots">
          {[
            ['Before grading', 'Sep 06, 14:32 · g184'],
            ['Session start', 'Sep 06, 09:08 · g167'],
            ['Survey import', 'Sep 05, 17:46 · g119'],
          ].map(([name, detail], index) => (
            <div
              className={`snapshotMenuRowFixture ${index === 0 ? 'snapshotMenuRowFixtureActive' : ''}`}
              key={name}
            >
              <span>{name}</span>
              <span className="snapshotMenuMetaFixture">{detail}</span>
              <Button variant="secondary" size="small">
                Restore
              </Button>
            </div>
          ))}
        </div>
      ),
  },
  {
    name: 'ProgressBar',
    states: [...baseStates, 'loading'],
    render: (state) => (
      <ProgressBar
        value={0.64}
        ariaLabel="Import progress"
        indeterminate={state === 'loading'}
        indeterminateLabel="Importing…"
      />
    ),
  },
  {
    name: 'Viewport HUD',
    render: () => (
      <div style={{ display: 'grid', gap: 8 }}>
        {[24.1, 30, 55].map((p95) => (
          <div key={p95} style={{ position: 'relative', height: 58, width: 490 }}>
            <ViewportHud
              p95={p95}
              p50={16.4}
              points={41_200_000}
              targetMs={25}
              quality="W-2"
              budget="gpu"
              backlog={3}
            />
          </div>
        ))}
      </div>
    ),
  },
  {
    name: 'View presets',
    states: ['default'],
    render: () => (
      <Ribbon
        tabs={[
          {
            id: 'view',
            label: 'View',
            groups: [
              {
                id: 'view.camera',
                label: 'Camera',
                actions: ['top', 'front', 'right', 'perspective'].map((preset) => ({
                  id: `view.preset.${preset}`,
                  label: preset[0]!.toUpperCase() + preset.slice(1),
                })),
              },
            ],
          },
        ]}
      />
    ),
  },
  { name: 'Ribbon', render: () => <Ribbon tabs={ribbonTabs} /> },
  {
    name: 'Select',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <Select
        aria-label="Coordinate system"
        defaultValue="local"
        disabled={state === 'disabled'}
        options={[
          { value: 'local', label: 'Local engineering' },
          { value: 'etrs', label: 'ETRS89 / UTM 32N' },
        ]}
      />
    ),
  },
  {
    name: 'Checkbox',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <Checkbox label="Show point cloud" checked disabled={state === 'disabled'} readOnly />
    ),
  },
  {
    name: 'Radio',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <Radio label="Top-down view" checked disabled={state === 'disabled'} readOnly />
    ),
  },
  {
    name: 'IslandTabs',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <IslandTabs
        ariaLabel="Workspace"
        value="model"
        onChange={noop}
        items={[
          { id: 'model', label: 'Model' },
          { id: 'results', label: 'Results', badge: 3, disabled: state === 'disabled' },
        ]}
      />
    ),
  },
  {
    name: 'FunctionPanel',
    states: [
      row('three-tabs-320', '3 tabs at 320 px', 'default', '3'),
      row('five-tabs-320', '5 tabs at 320 px (overflow)', 'default', '5'),
      row('overflow-open', 'overflow menu open', 'default', 'open'),
    ],
    render: (_state, galleryRow) => (
      <FunctionPanelGalleryFixture
        tabCount={galleryRow?.value === '3' ? 3 : 5}
        overflowOpen={galleryRow?.value === 'open'}
      />
    ),
  },
  {
    name: 'Extract ground panel',
    states: [
      row('idle', 'idle', 'idle'),
      row('running', 'running', 'baking'),
      row('done', 'done', 'completed'),
    ],
    render: (state) => (
      <div className="galleryPanel galleryGroundPanel">
        <FunctionPanel
          activeFunctionId="pointcloud.ground.extract"
          title="Extract ground"
          activeTab="function"
          onActiveTabChange={noop}
          onCloseFunction={noop}
          properties={<span>Point-cloud properties</span>}
        >
          <div className="galleryGroundBody" aria-busy={state === 'baking'}>
            <div className="galleryGroundSource">Registered point cloud</div>
            <label>
              <span>Terrain type</span>
              <Select
                value="rolling"
                disabled={state === 'baking'}
                options={[{ value: 'rolling', label: 'Rolling' }]}
              />
            </label>
            {[
              ['Cell size', 1, 'm'],
              ['Slope', 15, '%'],
              ['Maximum window', 18, 'm'],
              ['Initial threshold', 0.5, 'm'],
            ].map(([label, value, unit]) => (
              <label key={String(label)}>
                <span>{label}</span>
                <NumberInput
                  aria-label={String(label)}
                  value={Number(value)}
                  unit={String(unit)}
                  disabled={state === 'baking'}
                />
              </label>
            ))}
            {state === 'baking' ? (
              <>
                <span className="galleryGroundStatus">Classifying points</span>
                <ProgressBar value={0.62} ariaLabel="Ground extraction progress" />
                <Button variant="secondary">Cancel</Button>
              </>
            ) : state === 'completed' ? (
              <div className="galleryGroundResult">
                <strong>Ground cloud created</strong>
                <span>Ground points 61.2 M (59 %) · residual σ 0.04 m</span>
                <span>This result is a point cloud, not an inferred DGM.</span>
                <Button variant="secondary">Create surface…</Button>
              </div>
            ) : (
              <div className="galleryGroundActions">
                <Button variant="quiet">Preview</Button>
                <Button>Extract ground</Button>
              </div>
            )}
          </div>
        </FunctionPanel>
      </div>
    ),
  },
  {
    name: 'EntityTree',
    render: () => (
      <div className="galleryPanel">
        <EntityTree project={project} selectedIds={new Set([id('cloud')])} onSelect={noop} />
      </div>
    ),
  },
  {
    name: 'StatusBar',
    render: () => (
      <StatusBar
        items={[
          { id: 'ready', content: 'Ready' },
          { id: 'crs', content: 'ETRS89 / UTM 32N', align: 'right' },
        ]}
      />
    ),
  },
  {
    name: 'DurabilityIndicator',
    states: [
      row('stored', 'stored', 'default', 'stored'),
      row('storing', 'storing', 'loading', 'storing'),
      row('failed', 'failure', 'failed', 'failed'),
    ],
    render: (_state, galleryRow) => (
      <StatusBar
        items={[
          {
            id: 'durability',
            content: (
              <DurabilityIndicator
                state={
                  galleryRow?.value === 'failed'
                    ? { kind: 'failed', reason: 'Disk is full' }
                    : galleryRow?.value === 'storing'
                      ? { kind: 'storing' }
                      : { kind: 'stored' }
                }
                onRetry={noop}
              />
            ),
          },
        ]}
      />
    ),
  },
  {
    name: 'EmptyState',
    render: () => (
      <EmptyState
        title="No results"
        hint="Run a calculation to see results here."
        meta="0 entities"
      />
    ),
  },
  {
    name: 'Viewport chrome',
    states: ['default'],
    render: () => (
      <div className="viewportChromeFixture">
        <div aria-label="Viewport mode" className="viewportModeFixture">
          {(['3D', '2.5D', '2D'] as const).map((mode) => (
            <OverlayChip key={mode} as="button" active={mode === '3D'} aria-pressed={mode === '3D'}>
              <span data-gallery-contrast-text={mode === '3D' ? 'viewport-active' : undefined}>
                {mode}
              </span>
            </OverlayChip>
          ))}
        </div>
        <OverlayChip data-gallery-contrast-surface="axis-chip">
          <span data-gallery-contrast-text="axis-chip">X — Y — Z —</span>
        </OverlayChip>
      </div>
    ),
  },
  {
    name: 'OverlayChip',
    states: [...baseStates, 'disabled'],
    render: (state) => (
      <OverlayChip as="button" active accent disabled={state === 'disabled'}>
        <OverlayAxis>X</OverlayAxis> 413 204.18 <OverlayKind>m</OverlayKind>
      </OverlayChip>
    ),
  },
  {
    name: 'Splitter',
    render: () => (
      <div className="splitterDemo">
        <span>Panel</span>
        <Splitter orientation="vertical" onResize={noop} />
        <span>Viewport</span>
      </div>
    ),
  },
  {
    name: 'TitleBar',
    render: () => (
      <TitleBar
        productLabel="BUILDER"
        projectLabel="Site survey.hcad"
        controls={{
          minimize: noop,
          maximizeToggle: noop,
          close: noop,
          isMaximized: async () => false,
          onMaximizeChange: () => noop,
        }}
      />
    ),
  },
  {
    name: 'EdgeStrip',
    render: () => (
      <div className="edgeStripDemo">
        <EdgeStrip side="left" label="Entities" onExpand={noop} />
      </div>
    ),
  },
  { name: 'PanelToggles', render: () => <PanelToggles /> },
];

const fixtureMarkup = accessibilityFixtures();
const fixtureNames = new Set(Object.keys(fixtureMarkup));
const missingFixtures = [...fixtureNames].filter(
  (name) => !specs.some((spec) => spec.name === name),
);
if (missingFixtures.length > 0)
  throw new Error(`Gallery fixtures missing: ${missingFixtures.join(', ')}`);

export function Gallery(): JSX.Element {
  const query = new URLSearchParams(window.location.search);
  const requestedTheme = query.get('theme');
  const theme = requestedTheme === 'light' ? 'light' : 'dark';
  const sectionFilter = query.get('section')?.trim().toLowerCase() ?? '';
  const visibleSpecs = sectionFilter
    ? specs.filter(
        (spec) =>
          sectionId(spec.name) === sectionFilter || spec.name.toLowerCase() === sectionFilter,
      )
    : specs;

  useEffect(() => {
    document.documentElement.classList.remove('hc-theme-light', 'hc-theme-dark');
    document.documentElement.classList.add(`hc-theme-${theme}`);
    const reportHeight = (): void => {
      document.documentElement.dataset.captureHeight = String(
        document.documentElement.scrollHeight,
      );
    };
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(document.body);
    document.fonts.ready.then(reportHeight).catch(noop);
    return () => observer.disconnect();
  }, [theme]);

  return (
    <main className="galleryRoot">
      <header className="galleryHeader">
        <div>
          <p className="galleryEyebrow">@himmelcad/ui</p>
          <h1>Shared component gallery</h1>
        </div>
        <span className="themeBadge">{theme} theme</span>
      </header>
      {visibleSpecs.length > 0 ? (
        <div className="gallerySections">
          {visibleSpecs.map((spec) => (
            <GallerySection key={spec.name} spec={spec} />
          ))}
        </div>
      ) : (
        <section className="gallerySection">
          <h2>Unknown section</h2>
          <p>No component matches “{sectionFilter}”.</p>
        </section>
      )}
    </main>
  );
}

function GallerySection({ spec }: { spec: ComponentSpec }): JSX.Element {
  const states = spec.states ?? baseStates;
  return (
    <section className="gallerySection" data-gallery-section={sectionId(spec.name)}>
      <h2>{spec.name}</h2>
      <div className="stateList">
        {states.map((stateOrRow) => {
          const galleryRow = typeof stateOrRow === 'string' ? undefined : stateOrRow;
          const state = galleryRow?.state ?? (stateOrRow as State);
          const rowKey = galleryRow?.key ?? state;
          const exactFixture =
            !galleryRow && state === 'default' ? fixtureMarkup[spec.name] : undefined;
          return (
            <div className="stateRow" key={rowKey} data-gallery-row={rowKey}>
              <div className="stateLabel">{galleryRow?.label ?? state}</div>
              <div
                className={`gallerySample ${state === 'hover' ? 'data-force-hover' : ''} ${state === 'focus-visible' ? 'data-force-focus-visible' : ''}`}
                data-force-hover={state === 'hover' || undefined}
                data-force-focus-visible={state === 'focus-visible' || undefined}
              >
                {exactFixture ? (
                  <div dangerouslySetInnerHTML={{ __html: exactFixture }} />
                ) : (
                  spec.render(state, galleryRow)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function InvalidNumberInput(): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = root.current?.querySelector('input');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    input.focus();
    setter?.call(input, 'not-a-number');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const frame = requestAnimationFrame(() => input.blur());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={root}>
      <NumberInput
        aria-label="Length"
        defaultValue={12.5}
        unit="m"
        invalidMessage="Enter a valid length."
      />
    </div>
  );
}

function FunctionPanelGalleryFixture({
  tabCount,
  overflowOpen,
}: {
  tabCount: 3 | 5;
  overflowOpen: boolean;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const functionIds = [
    'measure.distance',
    'view.point-size',
    'view.performance',
    'view.viewing-box',
  ].slice(0, tabCount - 1);
  const activeFunctionId = functionIds.at(-1)!;

  useEffect(() => {
    if (!overflowOpen) return;
    let frame = 0;
    const openWhenReady = (): void => {
      const trigger = root.current?.querySelector<HTMLButtonElement>(
        '[aria-label="More function tabs"]',
      );
      if (trigger) trigger.click();
      else frame = requestAnimationFrame(openWhenReady);
    };
    frame = requestAnimationFrame(openWhenReady);
    return () => cancelAnimationFrame(frame);
  }, [overflowOpen]);

  return (
    <div ref={root} className="galleryPanel galleryFunctionPanel">
      <FunctionPanel
        activeFunctionId={activeFunctionId}
        functionIds={functionIds}
        closeFunctionTabs
        title={activeFunctionId === 'view.viewing-box' ? 'Viewing Box' : undefined}
        activeTab="function"
        onActiveTabChange={noop}
        onCloseFunction={noop}
        properties={<p>Selection properties</p>}
      >
        <p>Pick the first point in the viewport.</p>
        <NumberInput aria-label="Offset" defaultValue={0} unit="m" />
      </FunctionPanel>
    </div>
  );
}

function sectionId(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();
}
