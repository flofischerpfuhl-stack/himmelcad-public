/**
 * The open project's file lifecycle as a service for code below the shell
 * (assembler/MODULES.md §3): the agent API's `project.*` methods and the
 * unsaved-work guard, and modules that open a project the user dropped
 * (interop). The shell's project store implements it and installs it
 * (`interface/shell-ui/module.ts`); without it (headless CLI, tests without
 * the shell) callers fall back to the bare document.
 */
import type { OpenResult } from './persistence.js';

export interface ProjectPersistence {
  /** Features, Items, saved views, pins or reference meshes changed since the last New/Open/Save. */
  hasUnsavedChanges(): boolean;
  /** Opens `.hcasm` text as the current project; rejects with the load error. */
  open(text: string): Promise<void>;
  /** Replaces the document with a blank project (`Untitled` when unnamed). */
  newProject(name?: string): void;
  /** The file text Save would write now, optionally under another project name. */
  text(projectName?: string): Promise<string>;
  /**
   * Opens a project the user picked or dropped, asking about unsaved changes
   * first (the File › Open flow); `load` reads it, `null` = nothing to open.
   */
  requestOpen(load: () => Promise<OpenResult | null>): void;
}

let current: ProjectPersistence | null = null;

/** Installs the project lifecycle (the shell, once). */
export function setProjectPersistence(persistence: ProjectPersistence | null): void {
  current = persistence;
}

/** The installed project lifecycle, or `null` without a shell. */
export function projectPersistence(): ProjectPersistence | null {
  return current;
}
