import type { EntityId, EntitySnapshot, ObjectHash, ProjectSnapshot } from '@himmelcad/data';

const ROOT_ID = 'photolab:root' as EntityId;
const SURVEY_ID = 'photolab:survey:1' as EntityId;
const IMAGES_ID = 'photolab:images' as EntityId;
const REFERENCE_ID = 'photolab:reference' as EntityId;
const PRODUCTS_ID = 'photolab:products' as EntityId;
const EMPTY_HASH = '0000000000000000' as ObjectHash;

function group(id: EntityId, name: string, parent: EntityId): EntitySnapshot {
  return {
    id,
    kind: 'Group',
    name,
    parent,
    children: [],
    visibility: { visible: true, locked: false },
    versionHash: EMPTY_HASH,
    bounds: null,
  };
}

export function createPhotolabProject(): ProjectSnapshot {
  const images = group(IMAGES_ID, 'Images · 0', SURVEY_ID);
  const reference = group(REFERENCE_ID, 'Reference & GCPs', SURVEY_ID);
  const products = group(PRODUCTS_ID, 'Products', SURVEY_ID);
  const survey: EntitySnapshot = {
    ...group(SURVEY_ID, 'Survey 01', ROOT_ID),
    children: [IMAGES_ID, REFERENCE_ID, PRODUCTS_ID],
  };
  const root: EntitySnapshot = {
    ...group(ROOT_ID, 'Untitled PhotoLab Project', ROOT_ID),
    kind: 'ProjectRoot',
    parent: null,
    children: [SURVEY_ID],
  };
  return {
    formatVersion: 1,
    projectId: 'photolab-local-bootstrap',
    name: 'Untitled PhotoLab Project',
    rootEntity: ROOT_ID,
    entities: {
      [ROOT_ID]: root,
      [SURVEY_ID]: survey,
      [IMAGES_ID]: images,
      [REFERENCE_ID]: reference,
      [PRODUCTS_ID]: products,
    },
    renderOffset: { x: 0, y: 0, z: 0 },
  };
}
