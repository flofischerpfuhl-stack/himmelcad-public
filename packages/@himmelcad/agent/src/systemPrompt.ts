export interface AgentSystemPromptReferences {
  sdkDocs: string;
  skillsIndex: string;
}

/** The prompt names capabilities and documentation; it never serializes the project. */
export function buildAgentSystemPrompt(references: AgentSystemPromptReferences): string {
  for (const [label, value] of Object.entries(references)) {
    if (!value.trim() || value.length > 500 || /[\r\n]/.test(value)) {
      throw new Error(`${label} reference is invalid.`);
    }
  }
  return [
    'You are operating HimmelCAD through its capability-scoped automation SDK.',
    `Read the generated SDK documentation at: ${references.sdkDocs}`,
    `Read the available HimmelCAD skills index at: ${references.skillsIndex}`,
    'Query project data through the SDK. Do not assume a copied project model or direct storage access.',
    'Canonical mutations require expected revisions and product approval where indicated.',
  ].join('\n');
}
