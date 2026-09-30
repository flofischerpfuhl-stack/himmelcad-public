/**
 * Icon lookups for the chrome. Own icon choices from `lucide-react` (never
 * Shapr3D assets) — see the task brief's reference-only note.
 */
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Axis3D,
  Box,
  BoxSelect,
  Boxes,
  Combine,
  CopyMinus,
  CopyPlus,
  Diff,
  Eye,
  EyeOff,
  FileOutput,
  FilePlus2,
  FolderOpen,
  Home,
  Maximize,
  Move3d,
  MoveDiagonal,
  PackageOpen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  PenSquare,
  Redo2,
  RotateCw,
  Ruler,
  Save,
  Scan,
  Scissors,
  Spline,
  SquareDashedMousePointer,
  SunMedium,
  Trash2,
  FileInput,
  Triangle,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

import type { Command, CommandGroup } from '../model/commands/registry.js';
import type { Feature } from '../model/document.js';
import type { SelectionItem } from '../model/store.js';
import { SKETCH_COMMAND_ICONS } from '../sketch/ui/sketchIcons.js';
import { MODELING_COMMAND_ICON, MODELING_FEATURE_ICON } from './featureIcons.js';
import { PRINT_COMMAND_ICONS } from '../print/printIcons.js';

export const GROUP_ICON: Record<CommandGroup, LucideIcon> = {
  sketch: PenSquare,
  add: Combine,
  transform: MoveDiagonal,
  tools: Scissors,
  modes: Scan,
  edit: SquareDashedMousePointer,
  view: Axis3D,
  display: SunMedium,
  file: Box,
};

/**
 * Per-command icon, keyed by `Command.id` — used by the adaptive toolbar so
 * e.g. Extrude gets its own icon instead of falling back to its group's
 * (Tools -> scissors) icon, which reads as "delete/cut" for an additive
 * operation. Deliberately distinct from {@link GROUP_ICON}: a command's
 * icon should never be the same glyph as its own group trigger, so the two
 * are never visually interchangeable in the same surface.
 */
export const COMMAND_ICON: Partial<Record<string, LucideIcon>> = {
  ...SKETCH_COMMAND_ICONS,
  'tools.extrude': ArrowUpFromLine,
  'tools.filletChamfer': Spline,
  'tools.chamfer': Triangle,
  'tools.shell': PackageOpen,
  'tools.revolve': RotateCw,
  'tools.union': CopyPlus,
  'tools.subtract': CopyMinus,
  'tools.intersect': Diff,
  'transform.moveRotate': Move3d,
  'transform.delete': Trash2,
  'view.front': ArrowDown,
  'view.back': ArrowUp,
  'view.top': PanelTop,
  'view.bottom': PanelBottom,
  'view.right': PanelRight,
  'view.left': PanelLeft,
  'view.iso': Home,
  'view.zoomToFit': Maximize,
  'modes.section': Scan,
  'modes.isolate': Boxes,
  'modes.measure': Ruler,
  'edit.undo': Undo2,
  'edit.redo': Redo2,
  'edit.hide': EyeOff,
  'edit.showAll': Eye,
  'edit.selectAllBodies': BoxSelect,
  'file.new': FilePlus2,
  'file.open': FolderOpen,
  'file.save': Save,
  'file.export3mf': FileOutput,
  ...MODELING_COMMAND_ICON,
  ...PRINT_COMMAND_ICONS,
};

/** `COMMAND_ICON[command.id]`, falling back to the command's group icon. */
export function commandIcon(command: Pick<Command, 'id' | 'group'>): LucideIcon {
  return COMMAND_ICON[command.id] ?? GROUP_ICON[command.group];
}

export function featureKindIcon(kind: Feature['kind']): LucideIcon {
  switch (kind) {
    case 'sketch':
      return PenSquare;
    case 'extrude':
      return Combine;
    case 'fillet':
    case 'chamfer':
      return Spline;
    case 'shell':
      return PackageOpen;
    case 'boolean':
      return CopyPlus;
    case 'move':
      return MoveDiagonal;
    case 'setAppearance':
      return Eye;
    case 'importStep':
      return FileInput;
    default:
      return MODELING_FEATURE_ICON[kind];
  }
}

export function selectionKindIcon(kind: SelectionItem['kind']): LucideIcon {
  switch (kind) {
    case 'body':
      return Box;
    case 'face':
      return Scan;
    case 'edge':
      return Spline;
    case 'sketchProfile':
      return PenSquare;
    case 'feature':
      return Combine;
    case 'mesh':
      return Box;
    default:
      return Box;
  }
}
