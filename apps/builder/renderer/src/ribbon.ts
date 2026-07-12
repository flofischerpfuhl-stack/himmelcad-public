import {
  Box,
  Camera,
  CircleDot,
  CloudUpload,
  FilePlus,
  FolderOpen,
  Gauge,
  Grid3x3,
  HardDriveDownload,
  Layers,
  Minus,
  PaintBucket,
  Pipette,
  Redo2,
  Ruler,
  Save,
  Scissors,
  ScanLine,
  SquareDashed,
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
          { id: 'project.save', label: 'Save', icon: i(Save) },
          { id: 'project.export', label: 'Export', icon: i(HardDriveDownload) },
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
        id: 'import.pointcloud',
        label: 'Point Cloud',
        actions: [
          { id: 'import.las', label: 'LAS / LAZ', icon: i(CloudUpload) },
          { id: 'import.e57', label: 'E57', icon: i(CloudUpload) },
        ],
      },
      {
        id: 'import.cad',
        label: 'CAD / BIM',
        actions: [
          { id: 'import.dxf', label: 'DXF', icon: i(Layers) },
          { id: 'import.ifc', label: 'IFC', icon: i(Box) },
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
          { id: 'view.top', label: 'Top', icon: i(Grid3x3) },
          { id: 'view.iso', label: 'Iso', icon: i(Camera) },
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
];
