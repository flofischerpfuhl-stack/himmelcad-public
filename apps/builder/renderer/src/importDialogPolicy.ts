import type { RegistrationRecipeMethod } from '@himmelcad/app';

/** The modal remains only while the registration workflow still needs user input. */
export function importStageNeedsFurtherInput(
  methodKind: RegistrationRecipeMethod['kind'],
): boolean {
  return methodKind !== 'sourceCoordinates';
}
