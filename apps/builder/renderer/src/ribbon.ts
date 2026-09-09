import {
  Box,
  Bot,
  Camera,
  CircleDot,
  CloudUpload,
  FilePlus,
  FileText,
  FolderOpen,
  Gauge,
  Grid3x3,
  HardDriveDownload,
  History,
  Mountain,
  Minus,
  PaintBucket,
  PenLine,
  Pentagon,
  Pipette,
  Redo2,
  Ruler,
  Save,
  Scissors,
  ScanLine,
  SquareDashed,
  SwatchBook,
  Undo2,
  Waypoints,
  ZoomIn,
} from 'lucide-react';
import { createElement, type ReactElement } from 'react';

import type { RibbonTab } from '@himmelcad/ui';

interface RecentProjectAction {
  readonly path: string;
  readonly name: string;
}

interface SnapshotAction {
  readonly entityId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly markedGeneration: number;
}

interface FileRibbonHandlers {
  readonly recent: readonly RecentProjectAction[];
  readonly snapshots: readonly SnapshotAction[];
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onOpenArchive: () => void;
  readonly onOpenRecent: (path: string) => void;
  readonly onSave: () => void;
  readonly onSaveAs: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onRestoreSnapshot: (entityId: string) => void;
  readonly onClose: () => void;
  readonly onExport: () => void;
  readonly onImport: () => void;
  readonly onPhotoLabProductImport: () => void;
  readonly navigationMode?: '3d' | '2.5d' | '2d';
  readonly groundExtractionAvailable?: boolean;
  readonly segmentationAvailable?: boolean;
}

const i = (Comp: typeof Box, size = 18): ReactElement =>
  createElement(Comp, { size, strokeWidth: 1.6 });

export function createRibbonTabs(handlers: FileRibbonHandlers): RibbonTab[] {
  return [
    {
      id: 'file',
      label: 'File',
      groups: [
        {
          id: 'file.project',
          label: 'Project',
          actions: [
            { id: 'project.new', label: 'New', icon: i(FilePlus), onActivate: handlers.onNew },
            {
              id: 'project.open',
              label: 'Open',
              icon: i(FolderOpen),
              onActivate: handlers.onOpen,
              menuItems: [
                {
                  id: 'open-archive',
                  label: 'Open archive…',
                  description: 'Unpack a portable .hcadx copy',
                  onSelect: handlers.onOpenArchive,
                },
              ],
            },
            {
              id: 'project.recent',
              label: 'Recent',
              icon: i(FolderOpen),
              menuItems:
                handlers.recent.length > 0
                  ? handlers.recent.map((entry) => ({
                      id: entry.path,
                      label: entry.name,
                      description: entry.path,
                      descriptionMono: true,
                      onSelect: () => handlers.onOpenRecent(entry.path),
                    }))
                  : [
                      {
                        id: 'empty',
                        label: 'No recent projects',
                        disabled: true,
                        onSelect: () => undefined,
                      },
                    ],
            },
            {
              id: 'project.save',
              label: 'Save',
              shortcut: 'Ctrl+S',
              icon: i(Save),
              onActivate: handlers.onSave,
              menuItems: [
                {
                  id: 'save-as',
                  label: 'Save As…',
                  description: 'Create a portable .hcadx archive copy',
                  onSelect: handlers.onSaveAs,
                },
              ],
            },
            {
              id: 'project.snapshots',
              label: 'Snapshots',
              icon: i(History),
              menuItems:
                handlers.snapshots.length > 0
                  ? [...handlers.snapshots].reverse().map((snapshot) => ({
                      id: snapshot.entityId,
                      label: snapshot.name,
                      metadata: `${formatSnapshotTime(snapshot.createdAt)} · g${snapshot.markedGeneration}`,
                      onSelect: () => handlers.onRestoreSnapshot(snapshot.entityId),
                      secondaryActionLabel: 'Restore',
                      onSecondaryAction: () => handlers.onRestoreSnapshot(snapshot.entityId),
                    }))
                  : [
                      {
                        id: 'empty',
                        label: 'No snapshots',
                        disabled: true,
                        onSelect: () => undefined,
                      },
                    ],
            },
            {
              id: 'project.save_as',
              label: 'Save As…',
              shortcut: 'Ctrl+Shift+S',
              icon: i(HardDriveDownload),
              onActivate: handlers.onSaveAs,
            },
            { id: 'project.close', label: 'Close', icon: i(Minus), onActivate: handlers.onClose },
          ],
        },
        {
          id: 'file.import',
          label: 'Import',
          actions: [
            {
              id: 'file.import',
              label: 'Import…',
              icon: i(CloudUpload),
              onActivate: handlers.onImport,
              menuItems: [
                {
                  id: 'general-import',
                  label: 'Import files…',
                  description: 'Choose LAS, LAZ, E57, or another supported format',
                  onSelect: handlers.onImport,
                },
                {
                  id: 'photolab-product-dataset',
                  label: 'PhotoLab product dataset',
                  description: 'Choose a PhotoLab project or published package',
                  onSelect: handlers.onPhotoLabProductImport,
                },
              ],
            },
            {
              id: 'entity.export',
              label: 'Export…',
              icon: i(HardDriveDownload),
              onActivate: handlers.onExport,
            },
            { id: 'automation.agent', label: 'Agent', icon: i(Bot) },
          ],
        },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      groups: [
        {
          id: 'project.history',
          label: 'History',
          actions: [
            {
              id: 'project.undo',
              label: 'Undo',
              shortcut: 'Ctrl+Z',
              icon: i(Undo2),
              onActivate: handlers.onUndo,
            },
            {
              id: 'project.redo',
              label: 'Redo',
              shortcut: 'Ctrl+Shift+Z',
              icon: i(Redo2),
              onActivate: handlers.onRedo,
            },
          ],
        },
      ],
    },
    {
      id: 'view',
      label: 'View',
      groups: [
        {
          id: 'view.camera',
          label: 'Camera',
          actions: [
            { id: 'view.frame', label: 'Frame All', icon: i(ZoomIn) },
            ...['top', 'front', 'right', 'perspective'].map((preset) => ({
              id: `view.preset.${preset}`,
              label: preset[0]!.toUpperCase() + preset.slice(1),
              icon: i(Camera),
              ...(handlers.navigationMode === '2d' && preset !== 'top'
                ? {
                    disabled: true,
                    title: 'Available in 3D or 2.5D navigation.',
                  }
                : {}),
            })),
            { id: 'view.3d', label: '3D', icon: i(Camera) },
            { id: 'view.2.5d', label: '2.5D', icon: i(Grid3x3) },
            { id: 'view.2d', label: '2D', icon: i(Grid3x3) },
            { id: 'view.camera.undo', label: 'Undo Camera', icon: i(Undo2) },
            { id: 'view.camera.redo', label: 'Redo Camera', icon: i(Redo2) },
            { id: 'view.display.undo', label: 'Undo Display', icon: i(Undo2) },
            { id: 'view.display.redo', label: 'Redo Display', icon: i(Redo2) },
            { id: 'view.viewing-box', label: 'Viewing Box', icon: i(Box) },
            { id: 'view.bookmark.create', label: 'Capture View', icon: i(Camera) },
            { id: 'view.bookmark.restore', label: 'Restore Bookmark', icon: i(Camera) },
          ],
        },
        {
          id: 'view.style',
          label: 'Style',
          actions: [
            { id: 'view.background', label: 'Background', icon: i(PaintBucket) },
            { id: 'view.point-size', label: 'Point Size', icon: i(CircleDot) },
            { id: 'view.hud.toggle', label: 'HUD', icon: i(Gauge) },
            { id: 'view.color-mode', label: 'Color Mode', icon: i(Pipette) },
          ],
        },
      ],
    },
    {
      id: 'select',
      label: 'Select',
      groups: [
        {
          id: 'select.tools',
          label: 'Tools',
          actions: [
            { id: 'select.box', label: 'Box', icon: i(SquareDashed) },
            { id: 'select.lasso', label: 'Lasso', icon: i(ScanLine) },
          ],
        },
      ],
    },
    {
      id: 'pointcloud',
      label: 'Pointcloud',
      groups: [
        {
          id: 'pointcloud.ground',
          label: 'Terrain',
          actions: [
            {
              id: 'pointcloud.ground.extract',
              label: 'Extract ground',
              icon: i(Mountain),
              disabled: handlers.groundExtractionAvailable === false,
              title:
                handlers.groundExtractionAvailable === false
                  ? 'Select exactly one point cloud.'
                  : 'Classify ground and create a prepared ground-only cloud.',
            },
            {
              id: 'pointcloud.rasterize',
              label: 'Rasterize mean height',
              icon: i(Grid3x3),
              disabled: handlers.groundExtractionAvailable === false,
              title:
                handlers.groundExtractionAvailable === false
                  ? 'Select exactly one point cloud.'
                  : 'Create a prepared height grid from the visible point set.',
            },
          ],
        },
        {
          id: 'pointcloud.cloud',
          label: 'Cloud',
          actions: [
            {
              id: 'pointcloud.fence.begin',
              label: 'Segment',
              icon: i(Scissors),
              disabled: handlers.segmentationAvailable === false,
              title:
                handlers.segmentationAvailable === false
                  ? 'Select one or more editable, visible point clouds.'
                  : 'Draw a projection-true fence and keep or remove its visible points.',
            },
            {
              id: 'pointcloud.sample',
              label: 'Sample',
              icon: i(ScanLine),
              disabled: handlers.groundExtractionAvailable === false,
              title:
                handlers.groundExtractionAvailable === false
                  ? 'Select exactly one point cloud.'
                  : 'Create a deterministic prepared sampled cloud.',
            },
          ],
        },
      ],
    },
    {
      id: 'draw',
      label: 'Draw',
      groups: [
        {
          id: 'draw.linework',
          label: 'Linework',
          actions: [
            { id: 'draw.line', label: 'Line', icon: i(PenLine) },
            { id: 'draw.polyline', label: 'Polyline', icon: i(Waypoints) },
            { id: 'draw.boundary', label: 'Boundary polygon', icon: i(Pentagon) },
          ],
        },
      ],
    },
    {
      id: 'mesh',
      label: 'Mesh',
      groups: [
        {
          id: 'mesh.surface',
          label: 'Terrain',
          actions: [
            {
              id: 'mesh.surface.create',
              label: 'Create surface',
              icon: i(Mountain),
              title:
                'Create a checked TIN surface from selected points, clouds, grids, and linework.',
            },
            {
              id: 'mesh.edit.smooth',
              label: 'Edit surface',
              icon: i(Mountain),
              title: 'Smooth or downsample a selected DGM inside a protected region.',
            },
          ],
        },
      ],
    },
    {
      id: 'inspect',
      label: 'Inspect',
      groups: [
        {
          id: 'inspect.measure',
          label: 'Measure',
          actions: [
            { id: 'measure.point', label: 'Point', icon: i(CircleDot) },
            { id: 'measure.distance', label: 'Distance', icon: i(Ruler) },
            { id: 'measure.dz', label: 'Height difference', icon: i(Ruler) },
            { id: 'measurement.list', label: 'Measurements', icon: i(Ruler) },
          ],
        },
      ],
    },
    {
      id: 'output',
      label: 'Output',
      groups: [
        {
          id: 'output.annotate',
          label: 'Document',
          actions: [
            { id: 'output.specs', label: 'Specifications', icon: i(SwatchBook) },
            { id: 'output.plan', label: 'Plan', icon: i(FileText) },
          ],
        },
      ],
    },
  ];
}

function formatSnapshotTime(createdAt: string): string {
  const match = /^unix-ms:(\d+)$/u.exec(createdAt);
  const timestamp = match ? Number(match[1]) : Date.parse(createdAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString([], {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : createdAt;
}
