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
  Minus,
  PaintBucket,
  Pipette,
  Redo2,
  Ruler,
  Save,
  Scissors,
  ScanLine,
  SquareDashed,
  SwatchBook,
  Tag,
  Triangle,
  Undo2,
  ZoomIn,
} from 'lucide-react';
import { createElement, type ReactElement } from 'react';

import type { RibbonTab } from '@himmelcad/ui';

interface RecentProjectAction {
  readonly path: string;
  readonly name: string;
}

interface FileRibbonHandlers {
  readonly recent: readonly RecentProjectAction[];
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onOpenArchive: () => void;
  readonly onOpenRecent: (path: string) => void;
  readonly onSave: () => void;
  readonly onSaveAs: () => void;
  readonly onClose: () => void;
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
            { id: 'file.import', label: 'Import…', icon: i(CloudUpload) },
            { id: 'project.export', label: 'Export', icon: i(HardDriveDownload) },
            { id: 'automation.agent', label: 'Agent', icon: i(Bot) },
          ],
        },
        {
          id: 'project.history',
          label: 'History',
          actions: [
            { id: 'project.undo', label: 'Undo', shortcut: 'Ctrl+Z', icon: i(Undo2) },
            { id: 'project.redo', label: 'Redo', shortcut: 'Ctrl+Shift+Z', icon: i(Redo2) },
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
            })),
            { id: 'view.3d', label: '3D', icon: i(Camera) },
            { id: 'view.2.5d', label: '2.5D', icon: i(Grid3x3) },
            { id: 'view.2d', label: '2D', icon: i(Grid3x3) },
            { id: 'view.camera.undo', label: 'Undo Camera', icon: i(Undo2) },
            { id: 'view.camera.redo', label: 'Redo Camera', icon: i(Redo2) },
            { id: 'view.viewing-box', label: 'Viewing Box', icon: i(Box) },
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
      id: 'segment',
      label: 'Segment',
      groups: [
        {
          id: 'segment.tools',
          label: 'Tools',
          actions: [
            { id: 'segment.extract', label: 'Extract', icon: i(Scissors) },
            { id: 'segment.classify', label: 'Classify', icon: i(Tag) },
            { id: 'segment.invert', label: 'Invert', icon: i(Minus) },
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
            { id: 'inspect.distance', label: 'Distance', icon: i(Ruler) },
            { id: 'inspect.angle', label: 'Angle', icon: i(Triangle) },
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
