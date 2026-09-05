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

const i = (Comp: typeof Box, size = 18): ReactElement =>
  createElement(Comp, { size, strokeWidth: 1.6 });

export const ribbonTabs: RibbonTab[] = [
  {
    id: 'project',
    label: 'Project',
    groups: [
      {
        id: 'project.file',
        label: 'File',
        actions: [
          { id: 'project.new', label: 'New', icon: i(FilePlus) },
          { id: 'project.open', label: 'Open', icon: i(FolderOpen) },
          { id: 'project.flush', label: 'Save', shortcut: 'Ctrl+S', icon: i(Save) },
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
    id: 'import',
    label: 'Import',
    groups: [
      {
        id: 'import.source',
        label: 'Source',
        actions: [{ id: 'import.file', label: 'Import…', icon: i(CloudUpload) }],
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
          { id: 'view.3d', label: '3D', icon: i(Camera) },
          { id: 'view.2.5d', label: '2.5D', icon: i(Grid3x3) },
          { id: 'view.2d', label: '2D', icon: i(Grid3x3) },
          { id: 'view.viewing-box', label: 'Viewing Box', icon: i(Box) },
        ],
      },
      {
        id: 'view.style',
        label: 'Style',
        actions: [
          { id: 'view.background', label: 'Background', icon: i(PaintBucket) },
          { id: 'view.point-size', label: 'Point Size', icon: i(CircleDot) },
          { id: 'view.performance', label: 'Performance', icon: i(Gauge) },
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
