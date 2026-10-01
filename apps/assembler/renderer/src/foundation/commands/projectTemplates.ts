/**
 * Project templates (assembler/MODULES.md §3 "Project templates"): the
 * "New from template" parts of the Home screen, registered by the modules
 * that own them (`defineAssemblerModule({ projectTemplates })`) and read by
 * the shell and the tests from here, so the product composition decides
 * which templates a product offers.
 *
 * A template builds its part with the **agent API** only
 * (`call(method, params)`, `hcasm.agent-api@1`), so it is a real, editable
 * History and runs the same in the app, headless and in the acceptance suite.
 */

/** One agent-API call (`AgentSession.handle`). */
export type ApiCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** A template id; unique across modules. `blank` is the empty project. */
export type ProjectTemplateId = string;

export interface ProjectTemplate {
  id: ProjectTemplateId;
  /** Card title and the new project's name. */
  name: string;
  /** One line on the card. */
  description: string;
  /** Builds the part into the (empty) current document. */
  build: (call: ApiCall) => Promise<void>;
}

const templates: { module: string; template: ProjectTemplate }[] = [];

/** Registers a module's templates, in order. Ids are unique; a second registration throws. */
export function registerProjectTemplates(module: string, list: readonly ProjectTemplate[]): void {
  for (const template of list) {
    const existing = templates.find((t) => t.template.id === template.id);
    if (existing) {
      if (existing.template === template) continue;
      throw new Error(
        `Project template "${template.id}" is registered twice (${existing.module}, ${module})`,
      );
    }
    templates.push({ module, template });
  }
}

/** Every registered template, in registration order. */
export function projectTemplates(): readonly ProjectTemplate[] {
  return templates.map((t) => t.template);
}

/** The template `id`; throws for an unknown id. */
export function projectTemplate(id: ProjectTemplateId): ProjectTemplate {
  const template = templates.find((t) => t.template.id === id)?.template;
  if (!template) throw new Error(`Unknown template "${id}"`);
  return template;
}
