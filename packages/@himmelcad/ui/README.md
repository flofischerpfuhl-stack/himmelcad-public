# `@himmelcad/ui`

Shared UI modules for all Himmel:CAD products. **Use these — never invent one-off chrome.**

## Control modules (mandatory for forms)

| Module          | Use for                                          | Native forbidden          |
| --------------- | ------------------------------------------------ | ------------------------- |
| `Checkbox`      | boolean fields                                   | `<input type="checkbox">` |
| `Radio`         | exclusive choices                                | `<input type="radio">`    |
| `Select`        | dropdowns (custom listbox, **not** OS popup)     | bare `<select>`           |
| `EmptyState`    | empty Jobs/Accuracy/etc.                         | ad-hoc empty UIs          |
| `ExpandChevron` | collapse/expand (right = collapsed, down = open) | inverted chevrons         |

## Shell modules

`AppShell`, `TitleBar`, `Ribbon`, `EntityTree`, `FunctionPanel`, `StatusBar`, `IslandTabs`, `OverlayChip`, `PanelToggles`, `EdgeStrip`, `Splitter`, `CrsTransformPair`.

## Rules

1. Import from `@himmelcad/ui` only.
2. Theme tokens from `@himmelcad/theme` only (no hardcoded hex).
3. If a control is missing, add it here first, then use it in the app.
4. `Select` accepts either `options={[...]}` or classic `<option>` children.

See `docs/DESIGN-SYSTEM.md`.
