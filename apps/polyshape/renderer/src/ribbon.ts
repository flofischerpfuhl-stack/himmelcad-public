import type { RibbonTab } from '@himmelcad/ui';

export const ribbonTabs: RibbonTab[] = [
  {
    id: 'project',
    label: 'Project',
    groups: [
      {
        id: 'project.file',
        label: 'File',
        actions: [
          { id: 'project.new', label: 'New' },
          { id: 'project.open', label: 'Open' },
          { id: 'project.save', label: 'Save' },
          { id: 'project.export', label: 'Export .hcadx' },
        ],
      },
      {
        id: 'project.history',
        label: 'History',
        actions: [
          { id: 'project.undo', label: 'Undo', shortcut: 'Ctrl+Z' },
          { id: 'project.redo', label: 'Redo', shortcut: 'Ctrl+Shift+Z' },
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
          { id: 'import.las', label: 'LAS / LAZ' },
          { id: 'import.e57', label: 'E57' },
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
          { id: 'view.frame', label: 'Frame All' },
          { id: 'view.top', label: 'Top' },
          { id: 'view.iso', label: 'Iso' },
        ],
      },
      {
        id: 'view.style',
        label: 'Style',
        actions: [
          { id: 'view.background', label: 'Background Color' },
          { id: 'view.point-size', label: 'Point Size' },
          { id: 'view.color-mode', label: 'Color Mode' },
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
          { id: 'select.box', label: 'Box' },
          { id: 'select.lasso', label: 'Lasso' },
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
          { id: 'segment.extract', label: 'Extract Selection' },
          { id: 'segment.classify', label: 'Classify' },
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
          { id: 'inspect.distance', label: 'Distance' },
          { id: 'inspect.angle', label: 'Angle' },
        ],
      },
    ],
  },
];
