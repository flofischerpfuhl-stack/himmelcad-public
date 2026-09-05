export declare const GENERATED_COMMAND_TABLE: readonly [{
    readonly id: "select.set";
    readonly label: "Select under cursor ▸";
    readonly kind: "command";
    readonly shortcut: null;
    readonly enablement: "pickCandidates";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "selection";
    readonly ownerSpec: "UI Platform UIP-D16";
    readonly host: "renderer";
}, {
    readonly id: "select.clear";
    readonly label: "Clear selection";
    readonly kind: "command";
    readonly shortcut: null;
    readonly enablement: "hasSelection";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "selection";
    readonly ownerSpec: "UI Platform UIP-D13";
    readonly host: "renderer";
}, {
    readonly id: "edit.clipboard.paste_in_place";
    readonly label: "Paste in place";
    readonly kind: "command";
    readonly shortcut: "Ctrl+Shift+V";
    readonly enablement: "clipboardAdmissible";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "edit";
    readonly ownerSpec: "Select/Edit SE-D7";
    readonly host: "renderer";
}, {
    readonly id: "entity.rename";
    readonly label: "Rename";
    readonly kind: "command";
    readonly shortcut: "F2";
    readonly enablement: "singleEditableNonCloud";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "edit";
    readonly ownerSpec: "UI Platform UIP-D5";
    readonly host: "renderer";
}, {
    readonly id: "project.flush";
    readonly label: "Save";
    readonly kind: "command";
    readonly shortcut: "Ctrl+S";
    readonly enablement: "hasProject";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "edit";
    readonly ownerSpec: "File/project FP-D19";
    readonly host: "renderer";
}, {
    readonly id: "view.frame";
    readonly label: "Frame all";
    readonly kind: "command";
    readonly shortcut: "F";
    readonly enablement: "hasProject";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "View VD-D1";
    readonly host: "renderer";
}, {
    readonly id: "view.preset.top";
    readonly label: "Top";
    readonly kind: "command";
    readonly shortcut: "7";
    readonly enablement: "hasProject";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "View VD-D1";
    readonly host: "renderer";
}, {
    readonly id: "view.preset.front";
    readonly label: "Front";
    readonly kind: "command";
    readonly shortcut: "1";
    readonly enablement: "hasProject";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "View VD-D1";
    readonly host: "renderer";
}, {
    readonly id: "view.preset.right";
    readonly label: "Right";
    readonly kind: "command";
    readonly shortcut: "3";
    readonly enablement: "hasProject";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "View VD-D1";
    readonly host: "renderer";
}, {
    readonly id: "view.preset.isometric";
    readonly label: "Perspective";
    readonly kind: "command";
    readonly shortcut: "5";
    readonly enablement: "hasProject";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: false;
        readonly quickSurface: true;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "View VD-D1";
    readonly host: "renderer";
}, {
    readonly id: "entity.zoom_to";
    readonly label: "Zoom to";
    readonly kind: "command";
    readonly shortcut: "Z";
    readonly enablement: "hasSelection";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "UI Platform UIP-D5";
    readonly host: "renderer";
}, {
    readonly id: "entity.hide";
    readonly label: "Hide";
    readonly kind: "command";
    readonly shortcut: "H";
    readonly enablement: "visibleSelection";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "UI Platform UIP-D5";
    readonly host: "renderer";
}, {
    readonly id: "entity.show";
    readonly label: "Show";
    readonly kind: "command";
    readonly shortcut: "Shift+H";
    readonly enablement: "hiddenSelection";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "UI Platform UIP-D5";
    readonly host: "renderer";
}, {
    readonly id: "entity.isolate";
    readonly label: "Isolate";
    readonly kind: "command";
    readonly shortcut: "I";
    readonly enablement: "hasSelection";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "view";
    readonly ownerSpec: "UI Platform UIP-D5";
    readonly host: "renderer";
}, {
    readonly id: "entity.properties";
    readonly label: "Properties";
    readonly kind: "query";
    readonly shortcut: "Alt+Enter";
    readonly enablement: "hasSelection";
    readonly surfaces: {
        readonly ribbon: false;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "entity-specific";
    readonly ownerSpec: "UI Platform UIP-D5";
    readonly host: "renderer";
}, {
    readonly id: "entity.export";
    readonly label: "Export…";
    readonly kind: "command";
    readonly shortcut: null;
    readonly enablement: "exportableSelection";
    readonly surfaces: {
        readonly ribbon: true;
        readonly contextMenu: true;
        readonly quickSurface: false;
        readonly console: true;
        readonly automation: true;
    };
    readonly group: "entity-specific";
    readonly ownerSpec: "Import/Export IF-D20";
    readonly host: "renderer";
}];
//# sourceMappingURL=commandTable.d.ts.map