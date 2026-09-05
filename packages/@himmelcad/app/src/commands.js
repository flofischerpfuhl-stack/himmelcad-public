"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMAND_REGISTRY = exports.QUICK_SURFACE_ENTRY_CAP = void 0;
exports.commandById = commandById;
exports.commandsForSurface = commandsForSurface;
exports.assertRuntimeCommandRegistry = assertRuntimeCommandRegistry;
exports.shortcutForEvent = shortcutForEvent;
exports.dispatchRegistryShortcut = dispatchRegistryShortcut;
exports.consoleHelpEntries = consoleHelpEntries;
exports.completeConsoleCommand = completeConsoleCommand;
exports.executeConsoleLine = executeConsoleLine;
exports.executeAutomationCommand = executeAutomationCommand;
const commandTable_js_1 = require("./generated/commandTable.js");
exports.QUICK_SURFACE_ENTRY_CAP = 7;
const CLOUD = new Set(['cloud']);
function predicate(name) {
    switch (name) {
        case 'hasProject':
            return (context) => context.hasProject;
        case 'hasSelection':
            return (context) => context.selectedEntityIds.length > 0;
        case 'pickCandidates':
            return (context) => (context.candidates?.length ?? 0) > 1;
        case 'clipboardAdmissible':
            return (context) => context.clipboardAdmissible === true;
        case 'singleEditableNonCloud':
            return (context) => context.selectedEntityIds.length === 1 &&
                context.selectionEditable !== false &&
                !CLOUD.has(context.selectedEntityKinds[0] ?? 'other');
        case 'visibleSelection':
            return (context) => context.selectedEntityIds.length > 0 && context.selectionVisibility !== 'hidden';
        case 'hiddenSelection':
            return (context) => context.selectedEntityIds.length > 0 && context.selectionVisibility !== 'visible';
        case 'exportableSelection':
            return (context) => context.selectedEntityIds.length > 0 &&
                context.selectionExportable === true &&
                !context.selectedEntityKinds.includes('cloud');
        default:
            throw new Error(`Unknown generated command enablement predicate: ${name}`);
    }
}
exports.COMMAND_REGISTRY = Object.freeze(commandTable_js_1.GENERATED_COMMAND_TABLE.map((row) => Object.freeze({
    id: row.id,
    label: row.label,
    kind: row.kind,
    shortcut: row.shortcut,
    surfaces: row.surfaces,
    group: row.group,
    ownerSpec: row.ownerSpec,
    isEnabled: predicate(row.enablement),
})));
const BY_ID = new Map(exports.COMMAND_REGISTRY.map((entry) => [entry.id, entry]));
function commandById(id) {
    return BY_ID.get(id);
}
function commandsForSurface(surface, context) {
    const entries = exports.COMMAND_REGISTRY.filter((entry) => entry.surfaces[surface] && entry.isEnabled(context));
    if (surface !== 'quickSurface')
        return entries;
    const quickOrder = {
        view: 0,
        selection: 1,
        edit: 2,
        'entity-specific': 3,
    };
    return entries
        .toSorted((left, right) => quickOrder[left.group] - quickOrder[right.group])
        .slice(0, exports.QUICK_SURFACE_ENTRY_CAP);
}
function assertRuntimeCommandRegistry() {
    const ids = new Set();
    const shortcuts = new Map();
    for (const entry of exports.COMMAND_REGISTRY) {
        if (ids.has(entry.id))
            throw new Error(`Duplicate runtime command id: ${entry.id}`);
        ids.add(entry.id);
        if (!(entry.surfaces.ribbon || entry.surfaces.contextMenu || entry.surfaces.quickSurface)) {
            throw new Error(`Command has no visible surface: ${entry.id}`);
        }
        if (!entry.shortcut)
            continue;
        const key = entry.shortcut.toLowerCase();
        const collision = shortcuts.get(key);
        if (collision)
            throw new Error(`Shortcut collision: ${entry.shortcut} (${collision}, ${entry.id})`);
        shortcuts.set(key, entry.id);
    }
}
assertRuntimeCommandRegistry();
function shortcutForEvent(event) {
    const modifiers = [
        event.ctrlKey || event.metaKey ? 'Ctrl' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
    ].filter(Boolean);
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    return [...modifiers, key].join('+');
}
function dispatchRegistryShortcut(event, context, execute) {
    const shortcut = shortcutForEvent(event).toLowerCase();
    const entry = exports.COMMAND_REGISTRY.find((candidate) => candidate.shortcut?.toLowerCase() === shortcut);
    if (!entry || !entry.isEnabled(context))
        return false;
    event.preventDefault();
    void execute({ id: entry.id, args: [], source: 'ribbon' });
    return true;
}
function consoleHelpEntries() {
    return exports.COMMAND_REGISTRY.filter((entry) => entry.surfaces.console);
}
function completeConsoleCommand(prefix) {
    const normalized = prefix.trim().toLowerCase();
    return consoleHelpEntries()
        .map((entry) => entry.id)
        .filter((id) => id.startsWith(normalized));
}
async function executeConsoleLine(raw, context, execute) {
    const [head = '', ...args] = raw.trim().split(/\s+/);
    if (head.toLowerCase() === 'help') {
        return {
            kind: 'help',
            lines: consoleHelpEntries().map((entry) => `${entry.id}${entry.shortcut ? `  ${entry.shortcut}` : ''} — ${entry.label}`),
        };
    }
    const entry = commandById(head.toLowerCase());
    if (!entry?.surfaces.console)
        throw new Error(`Unknown command: ${head}`);
    if (!entry.isEnabled(context))
        throw new Error(`Command is not available: ${entry.id}`);
    await execute({ id: entry.id, args, source: 'console' });
    return { kind: 'executed', id: entry.id };
}
async function executeAutomationCommand(id, payload, context, execute) {
    const entry = commandById(id);
    if (!entry?.surfaces.automation)
        throw new Error(`Automation command is not registered: ${id}`);
    if (!entry.isEnabled(context))
        throw new Error(`Automation command is not available: ${id}`);
    await execute({ id: entry.id, args: [], source: 'automation', payload });
}
//# sourceMappingURL=commands.js.map