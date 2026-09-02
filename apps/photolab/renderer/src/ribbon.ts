import type { RibbonTab } from '@himmelcad/ui';
import {
  Box,
  Bot,
  Camera,
  ChartNoAxesCombined,
  CloudUpload,
  FileImage,
  FilePlus,
  Film,
  FolderOpen,
  Gauge,
  History,
  Images,
  Layers3,
  Map,
  MapPin,
  Play,
  Save,
  SaveAll,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { createElement, type ReactElement } from 'react';

const icon = (Component: typeof Box): ReactElement =>
  createElement(Component, { size: 18, strokeWidth: 1.6 });

export interface PhotolabRibbonCallbacks {
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onRecentProjects: () => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onImportVideo: () => void;
  onImportExternal: () => void;
  onImportGcps: () => void;
  onActivateFunction: (id: string) => void;
}

export function createPhotolabRibbonTabs(callbacks: PhotolabRibbonCallbacks): RibbonTab[] {
  return [
    {
      id: 'project',
      label: 'Project',
      groups: [
        {
          id: 'project.file',
          label: 'File',
          actions: [
            {
              id: 'project.new',
              label: 'New',
              icon: icon(FilePlus),
              onActivate: callbacks.onNewProject,
            },
            {
              id: 'project.open',
              label: 'Open',
              icon: icon(FolderOpen),
              onActivate: callbacks.onOpenProject,
            },
            {
              id: 'project.recent',
              label: 'Recent',
              icon: icon(History),
              onActivate: callbacks.onRecentProjects,
            },
            {
              id: 'project.save',
              label: 'Save',
              title: 'Save — store all changes now',
              shortcut: 'Ctrl+S',
              icon: icon(Save),
              onActivate: callbacks.onSaveProject,
            },
            {
              id: 'project.saveAs',
              label: 'Save As…',
              title: 'Save As… — write an archive copy',
              icon: icon(SaveAll),
              onActivate: callbacks.onSaveProjectAs,
            },
            {
              id: 'automation.agent',
              label: 'Agent',
              icon: icon(Bot),
              onActivate: () => callbacks.onActivateFunction('automation.agent'),
            },
          ],
        },
      ],
    },
    {
      id: 'images',
      label: 'Images',
      groups: [
        {
          id: 'images.import',
          label: 'Import',
          actions: [
            {
              id: 'images.import.files',
              label: 'Images',
              icon: icon(FileImage),
              onActivate: callbacks.onImportFiles,
            },
            {
              id: 'images.import.folder',
              label: 'Folder',
              icon: icon(Images),
              onActivate: callbacks.onImportFolder,
            },
            {
              id: 'images.import.videoFrames',
              label: 'Video frames…',
              icon: icon(Film),
              onActivate: callbacks.onImportVideo,
            },
            {
              id: 'data.import.external',
              label: 'DEM / Cloud / Mesh',
              icon: icon(CloudUpload),
              onActivate: callbacks.onImportExternal,
            },
          ],
        },
        {
          id: 'images.prepare',
          label: 'Prepare',
          actions: [
            {
              id: 'images.metadata',
              label: 'Metadata',
              icon: icon(Settings2),
              onActivate: () => callbacks.onActivateFunction('images.metadata'),
            },
            {
              id: 'images.quality',
              label: 'Image Status',
              icon: icon(Gauge),
              onActivate: () => callbacks.onActivateFunction('images.quality'),
            },
          ],
        },
      ],
    },
    {
      id: 'reference',
      label: 'Reference',
      groups: [
        {
          id: 'reference.crs',
          label: 'Coordinates',
          actions: [
            {
              id: 'reference.transform',
              label: 'Reference Frame',
              icon: icon(Map),
              onActivate: () => callbacks.onActivateFunction('reference.transform'),
            },
            {
              id: 'reference.gcp.import',
              label: 'Import GCPs',
              icon: icon(MapPin),
              onActivate: callbacks.onImportGcps,
            },
          ],
        },
      ],
    },
    {
      id: 'alignment',
      label: 'Alignment',
      groups: [
        {
          id: 'alignment.compute',
          label: 'Compute',
          actions: [
            {
              id: 'alignment.run',
              label: 'Align Photos',
              icon: icon(Camera),
              onActivate: () => callbacks.onActivateFunction('alignment.run'),
            },
            {
              id: 'alignment.define',
              label: 'Define Alignment',
              icon: icon(Settings2),
              onActivate: () => callbacks.onActivateFunction('alignment.define'),
            },
            {
              id: 'alignment.optimize',
              label: 'Optimize',
              icon: icon(ChartNoAxesCombined),
              onActivate: () => callbacks.onActivateFunction('alignment.optimize'),
            },
            {
              id: 'alignment.merge',
              label: 'Merge Alignments',
              icon: icon(Layers3),
              onActivate: () => callbacks.onActivateFunction('alignment.merge'),
            },
          ],
        },
        {
          id: 'alignment.inspect',
          label: 'Diagnostics',
          actions: [
            {
              id: 'alignment.groups',
              label: 'Capture Groups',
              icon: icon(Layers3),
              onActivate: () => callbacks.onActivateFunction('alignment.groups'),
            },
            {
              id: 'alignment.report',
              label: 'Report',
              icon: icon(ChartNoAxesCombined),
              onActivate: () => callbacks.onActivateFunction('alignment.report'),
            },
          ],
        },
      ],
    },
    {
      id: 'products',
      label: 'Products',
      groups: [
        {
          id: 'products.metric',
          label: 'Metric',
          actions: [
            {
              id: 'products.depth',
              label: 'Depth Maps',
              icon: icon(Layers3),
              onActivate: () => callbacks.onActivateFunction('products.depth'),
            },
            {
              id: 'products.dense',
              label: 'Dense Cloud',
              icon: icon(CloudUpload),
              onActivate: () => callbacks.onActivateFunction('products.dense'),
            },
            {
              id: 'products.dem',
              label: 'DEM',
              icon: icon(Map),
              onActivate: () => callbacks.onActivateFunction('products.dem'),
            },
            {
              id: 'products.ortho',
              label: 'Orthomosaic',
              icon: icon(Images),
              onActivate: () => callbacks.onActivateFunction('products.ortho'),
            },
          ],
        },
        {
          id: 'products.appearance',
          label: '3D',
          actions: [
            {
              id: 'products.mesh',
              label: 'Textured Mesh',
              icon: icon(Box),
              onActivate: () => callbacks.onActivateFunction('products.mesh'),
            },
            {
              id: 'products.splat',
              label: 'Gaussian Splat',
              icon: icon(Sparkles),
              onActivate: () => callbacks.onActivateFunction('products.splat'),
            },
          ],
        },
      ],
    },
    {
      id: 'automation',
      label: 'Automation',
      groups: [
        {
          id: 'automation.batch',
          label: 'Batch',
          actions: [
            {
              id: 'batch.configure',
              label: 'Configure Batch',
              icon: icon(Settings2),
              onActivate: () => callbacks.onActivateFunction('batch.configure'),
            },
            {
              id: 'batch.queue',
              label: 'Queue',
              icon: icon(Play),
              onActivate: () => callbacks.onActivateFunction('batch.queue'),
            },
          ],
        },
      ],
    },
  ];
}
