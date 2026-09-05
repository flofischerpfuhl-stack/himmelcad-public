import { GENERATED_COMMAND_TABLE } from './generated/commandTable.js';
import type { SelectionCandidate } from './selection.js';
export declare const QUICK_SURFACE_ENTRY_CAP = 7;
export type CommandSurface = 'ribbon' | 'contextMenu' | 'quickSurface' | 'console' | 'automation';
export type CommandGroup = 'selection' | 'edit' | 'view' | 'entity-specific';
export type CommandEntityKind = 'point' | 'polyline' | 'mesh' | 'cloud' | 'other';
export type RuntimeCommandId = (typeof GENERATED_COMMAND_TABLE)[number]['id'];
export interface CommandContext {
    readonly hasProject: boolean;
    readonly selectedEntityIds: readonly string[];
    readonly selectedEntityKinds: readonly CommandEntityKind[];
    readonly selectionVisibility?: 'visible' | 'hidden' | 'mixed';
    readonly selectionEditable?: boolean;
    readonly selectionExportable?: boolean;
    readonly clipboardAdmissible?: boolean;
    readonly candidates?: readonly SelectionCandidate[];
}
export interface CommandInvocation {
    readonly id: RuntimeCommandId;
    readonly args: readonly string[];
    readonly source: CommandSurface;
    readonly payload?: unknown;
}
export type CommandExecutor = (invocation: CommandInvocation) => void | Promise<void>;
export interface RuntimeCommandEntry {
    readonly id: RuntimeCommandId;
    readonly label: string;
    readonly kind: 'command' | 'query';
    readonly shortcut: string | null;
    readonly surfaces: Readonly<Record<CommandSurface, boolean>>;
    readonly group: CommandGroup;
    readonly ownerSpec: string;
    readonly isEnabled: (context: CommandContext) => boolean;
}
export declare const COMMAND_REGISTRY: readonly RuntimeCommandEntry[];
export declare function commandById(id: string): RuntimeCommandEntry | undefined;
export declare function commandsForSurface(surface: CommandSurface, context: CommandContext): readonly RuntimeCommandEntry[];
export declare function assertRuntimeCommandRegistry(): void;
export interface ShortcutEventLike {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    preventDefault(): void;
}
export declare function shortcutForEvent(event: ShortcutEventLike): string;
export declare function dispatchRegistryShortcut(event: ShortcutEventLike, context: CommandContext, execute: CommandExecutor): boolean;
export declare function consoleHelpEntries(): readonly RuntimeCommandEntry[];
export declare function completeConsoleCommand(prefix: string): readonly string[];
export declare function executeConsoleLine(raw: string, context: CommandContext, execute: CommandExecutor): Promise<{
    readonly kind: 'help';
    readonly lines: readonly string[];
} | {
    readonly kind: 'executed';
    readonly id: RuntimeCommandId;
}>;
export declare function executeAutomationCommand(id: string, payload: unknown, context: CommandContext, execute: CommandExecutor): Promise<void>;
//# sourceMappingURL=commands.d.ts.map