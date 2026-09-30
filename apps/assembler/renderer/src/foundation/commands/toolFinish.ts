/**
 * Which running tools a click on empty space finishes (pure, unit tested).
 *
 * Shapr3D: tools started from the adaptive toolbar finish with a click on
 * free grid, while a click next to geometry in Trim does _not_ end it
 * (26.20) and a plain click on empty space otherwise deselects — so "empty
 * click = Done" must be a per-tool rule, and one the user can see
 * (research `notes/coverage-audit.md` input rule 1, `interaction.md` §4).
 * The viewport's click handler and the tool pill's hint both read this.
 */
import { toolKindDefinition, type ToolSession } from './store.js';

export function emptyClickFinishes(tool: ToolSession | null): boolean {
  if (!tool) return false;
  // Feature tools finish on an empty click (Shapr3D adaptive tools).
  if (tool.kind === 'feature') return true;
  // A pick session waits for references: Next (Enter) moves on, an empty click is a missed pick.
  if (tool.kind === 'pick') return false;
  // A module's tool says so itself (Fillet/Chamfer, Shell, Booleans do; Extrude and
  // Move/Rotate keep running: an empty click there is a missed handle).
  return toolKindDefinition(tool.kind)?.emptyClickFinishes ?? false;
}
