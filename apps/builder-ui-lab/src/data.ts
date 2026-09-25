import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  ArrowUpDown,
  Axis3d,
  Bookmark,
  Box,
  Building2,
  Camera,
  ChartArea,
  Circle,
  ClipboardPaste,
  Combine,
  Copy,
  Crop,
  Cuboid,
  Diameter,
  Download,
  Equal,
  Eye,
  EyeOff,
  FileArchive,
  FilePlus,
  Filter,
  Focus,
  FolderOpen,
  GitMerge,
  Grid2x2,
  Grid3x3,
  History,
  Image,
  Import,
  LandPlot,
  Layers3,
  List,
  Map,
  Maximize,
  Merge,
  Mountain,
  MountainSnow,
  Move3d,
  MoveVertical,
  PenLine,
  Pentagon,
  Rotate3d,
  Route,
  Ruler,
  Save,
  Scaling,
  Scan,
  ScanEye,
  ScanLine,
  Scissors,
  Settings,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Split,
  Square,
  Tags,
  Trash2,
  Triangle,
  Type,
  Ungroup,
  Upload,
  Waypoints,
  X,
} from 'lucide-react';

export interface LabFunction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface LabGroup {
  readonly label: string;
  readonly functions: readonly LabFunction[];
}

export interface LabTab {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly LabGroup[];
}

const f = (id: string, label: string, icon: LucideIcon): LabFunction => ({ id, label, icon });

/** Ribbon content per owner decision D2, filled from docs/ui-redesign/FUNCTION-INVENTORY-2026-09-24.md. */
export const TABS: readonly LabTab[] = [
  {
    id: 'file',
    label: 'File',
    groups: [
      {
        label: 'Project',
        functions: [
          f('project.new', 'New', FilePlus),
          f('project.open', 'Open', FolderOpen),
          f('project.recent', 'Recent', History),
          f('project.save', 'Save', Save),
          f('project.save_as', 'Save as', FileArchive),
          f('project.snapshots', 'Snapshots', Bookmark),
          f('project.close', 'Close', X),
        ],
      },
      {
        label: 'Exchange',
        functions: [
          f('file.import', 'Import', Import),
          f('entity.export', 'Export', Upload),
          f('project.reference', 'Reference project', Layers3),
        ],
      },
      {
        label: 'Settings',
        functions: [f('project.crs', 'CRS & units', Map), f('app.settings', 'Settings', Settings)],
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Camera',
        functions: [
          f('view.frame', 'Frame all', Maximize),
          f('view.preset.top', 'Top', Square),
          f('view.preset.front', 'Front', AppWindow),
          f('view.preset.isometric', 'Perspective', Rotate3d),
          f('view.station', 'Station view', Camera),
        ],
      },
      {
        label: 'Clip',
        functions: [
          f('view.viewing_box', 'Viewing box', Box),
          f('view.section', 'Section', ScanLine),
          f('view.section_from_line', 'Section from line', Split),
        ],
      },
      {
        label: 'Measure',
        functions: [
          f('measure.point', 'Point', Axis3d),
          f('measure.distance', 'Distance', Ruler),
          f('measure.dz', 'Height diff.', ArrowUpDown),
          f('measure.area', 'Area', LandPlot),
        ],
      },
      {
        label: 'Display',
        functions: [
          f('view.point_size', 'Point size', Grid2x2),
          f('view.color_mode', 'Color mode', Sparkles),
          f('view.grid', 'Grid & axes', Grid3x3),
          f('view.labels', 'Labels', Tags),
        ],
      },
    ],
  },
  {
    id: 'pointcloud',
    label: 'Pointcloud',
    groups: [
      {
        label: 'Prepare',
        functions: [
          f('pointcloud.segment', 'Segment', Scissors),
          f('pointcloud.ground', 'Extract ground', MountainSnow),
          f('pointcloud.sample', 'Sample / thin', Filter),
          f('pointcloud.classify', 'Classify', Tags),
        ],
      },
      {
        label: 'Derive',
        functions: [
          f('pointcloud.rasterize', 'Rasterize', Grid3x3),
          f('pointcloud.floor', 'Extract floor', Square),
          f('pointcloud.ortho', 'Ortho image', Image),
          f('pointcloud.merge', 'Merge clouds', Merge),
        ],
      },
      {
        label: 'Register',
        functions: [
          f('registration.c2c', 'Cloud to cloud', GitMerge),
          f('registration.report', 'Report', List),
        ],
      },
    ],
  },
  {
    id: 'draw',
    label: 'Draw',
    groups: [
      {
        label: 'Create',
        functions: [
          f('draw.point', 'Point', Circle),
          f('draw.line', 'Line', PenLine),
          f('draw.polyline', 'Polyline', Spline),
          f('draw.boundary', 'Boundary', Pentagon),
          f('draw.arc', 'Arc / circle', Diameter),
          f('draw.text', 'Text', Type),
        ],
      },
      {
        label: 'Modify',
        functions: [
          f('draw.parallel', 'Parallel', Equal),
          f('draw.trim', 'Trim / extend', Scaling),
          f('draw.split', 'Split line', Scissors),
          f('draw.join', 'Join', Combine),
          f('edit.move', 'Move / copy', Move3d),
        ],
      },
      {
        label: 'Heights',
        functions: [f('draw.assign_heights', 'Assign heights', MoveVertical)],
      },
    ],
  },
  {
    id: 'mesh',
    label: 'Mesh',
    groups: [
      {
        label: 'Surface',
        functions: [
          f('mesh.create_surface', 'Create DGM', Mountain),
          f('mesh.edit_region', 'Edit region', Triangle),
          f('mesh.downsample', 'Downsample', Filter),
        ],
      },
      {
        label: 'Analyse',
        functions: [
          f('mesh.contours', 'Contours', Waypoints),
          f('mesh.volume', 'Volume', Cuboid),
          f('mesh.cut_fill', 'Cut / fill', ChartArea),
        ],
      },
      {
        label: 'Mesh',
        functions: [
          f('mesh.from_cloud', 'Mesh from cloud', Shapes),
          f('mesh.simplify', 'Simplify', Ungroup),
        ],
      },
    ],
  },
  {
    id: 'raster',
    label: 'Raster',
    groups: [
      {
        label: 'Orthophoto',
        functions: [
          f('raster.import', 'Import', Download),
          f('raster.drape', 'Drape on DGM', Layers3),
        ],
      },
      {
        label: 'Edit',
        functions: [f('raster.georeference', 'Georeference', Map), f('raster.clip', 'Clip', Crop)],
      },
      {
        label: 'Derive',
        functions: [
          f('raster.to_dgm', 'Raster to DGM', Mountain),
          f('raster.difference', 'Difference', ChartArea),
        ],
      },
    ],
  },
  {
    id: 'bim',
    label: 'BIM',
    groups: [
      {
        label: 'Specifications',
        functions: [f('specs.library', 'Library', List), f('specs.apply', 'Apply', Tags)],
      },
      {
        label: 'Objects',
        functions: [
          f('bim.place', 'Place object', Building2),
          f('bim.generate', 'From geometry', Route),
        ],
      },
    ],
  },
];

/** Quick menu (right-click on empty space) — the old mini toolbar. */
export const QUICK_FUNCTIONS: readonly LabFunction[] = [
  f('view.frame', 'Frame all', Maximize),
  f('view.preset.top', 'Top view', Square),
  f('draw.polyline', 'Draw polyline', Spline),
  f('measure.distance', 'Measure distance', Ruler),
  f('view.viewing_box', 'Viewing box here', Box),
  f('edit.paste', 'Paste', ClipboardPaste),
  f('view.save', 'Save this view', Camera),
];

/** Functions applicable to a selected 3D polyline. */
export const LINE_FUNCTIONS: readonly LabFunction[] = [
  f('draw.parallel', 'Parallel', Equal),
  f('draw.split', 'Split line', Scissors),
  f('draw.assign_heights', 'Assign heights', MoveVertical),
  f('mesh.create_surface', 'Create DGM', Mountain),
  f('measure.distance', 'Measure', Ruler),
  f('view.zoom_selection', 'Zoom to selection', Focus),
  f('edit.copy', 'Copy', Copy),
  f('entity.isolate', 'Isolate', ScanEye),
  f('entity.hide', 'Hide', EyeOff),
  f('entity.properties', 'Properties', SlidersHorizontal),
  f('entity.delete', 'Delete', Trash2),
];

/** Functions applicable to a selected point cloud. */
export const CLOUD_FUNCTIONS: readonly LabFunction[] = [
  f('pointcloud.segment', 'Segment', Scissors),
  f('pointcloud.ground', 'Extract ground', MountainSnow),
  f('pointcloud.sample', 'Sample / thin', Filter),
  f('mesh.create_surface', 'Create DGM', Mountain),
  f('view.zoom_selection', 'Zoom to selection', Focus),
  f('entity.isolate', 'Isolate', ScanEye),
  f('entity.hide', 'Hide', EyeOff),
  f('entity.properties', 'Properties', SlidersHorizontal),
];

export const ICON_EYE = Eye;
export const ICON_SCAN = Scan;
