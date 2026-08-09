import type {
  CanonicalCommandTransaction,
  CanonicalEntity,
  CanonicalEntityTombstone,
  CanonicalJournalEntry,
  EntityVersionRef,
  Transform3d,
} from '@himmelcad/data/canonical';

import type { JsonObject, JsonValue } from './protocol.js';

export type {
  CanonicalCommandTransaction,
  CanonicalEntity,
  CanonicalEntityTombstone,
  CanonicalJournalEntry,
  CanonicalRepresentationAdmission,
  EntityVersionRef,
  GeometryResource,
} from '@himmelcad/data/canonical';

export const APP_PROTOCOL_SCHEMA_ID = 'hcad.app-protocol@1' as const;
export const APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE = 4_096 as const;
export const CANONICAL_ENTITY_PROPERTY_SCHEMA_ID = 'hcad.property-schema.entity@1' as const;
export const PROPERTY_QUERY_REQUEST_SCHEMA_ID = 'hcad.property-query-request@1' as const;
export const PROPERTY_QUERY_RESULT_SCHEMA_ID = 'hcad.property-query-result@1' as const;
export const PROPERTY_EDIT_REQUEST_SCHEMA_ID = 'hcad.property-edit-request@1' as const;
export const CANONICAL_ENTITY_PROPERTY_NAMESPACE = 'hcad.entity@1' as const;

export type AppProtocolExtensions = Readonly<Record<string, JsonValue>>;

export interface AppDocumentSnapshot {
  readonly generation: number;
  readonly entities: CanonicalEntity[];
  readonly tombstones: CanonicalEntityTombstone[];
  readonly journalHeadSequence: number;
}

export interface AppJournalReadRequest {
  readonly afterSequence: number;
  readonly limit: number;
}

export interface AppJournalPage {
  readonly afterSequence: number;
  readonly entries: CanonicalJournalEntry[];
  readonly journalHeadSequence: number;
  readonly hasMore: boolean;
}

export interface PropertyId {
  readonly namespace: string;
  readonly name: string;
}

export type PropertyValueType =
  | 'text'
  | 'entityType'
  | 'optionalEntityReference'
  | 'entityReferences'
  | 'optionalTransform3d'
  | 'contentHash'
  | 'optionalContentHash';

export type PropertyEditability = 'readOnly' | 'writable';

export interface PropertyDefinition {
  readonly id: PropertyId;
  readonly displayNameKey: string;
  readonly valueType: PropertyValueType;
  readonly editability: PropertyEditability;
}

export interface PropertyNamespaceSchema {
  readonly schemaId: string;
  readonly namespace: string;
  readonly properties: PropertyDefinition[];
}

export type PropertyValue =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'entityType'; readonly value: string }
  | { readonly kind: 'optionalEntityReference'; readonly value: string | null }
  | { readonly kind: 'entityReferences'; readonly values: string[] }
  | { readonly kind: 'optionalTransform3d'; readonly value: Transform3d | null }
  | { readonly kind: 'contentHash'; readonly value: string }
  | { readonly kind: 'optionalContentHash'; readonly value: string | null };

export interface PropertyQueryRequest {
  readonly schemaId: string;
  readonly entities: EntityVersionRef[];
  readonly properties: PropertyId[];
}

export type PropertyAggregateState =
  | { readonly state: 'shared'; readonly value: PropertyValue }
  | { readonly state: 'mixed' }
  | { readonly state: 'unavailable'; readonly reason: 'unknownProperty' };

export interface PropertyQueryRow {
  readonly propertyId: PropertyId;
  readonly definition?: PropertyDefinition;
  readonly aggregate: PropertyAggregateState;
}

export interface PropertyQueryResult {
  readonly schemaId: string;
  readonly entities: EntityVersionRef[];
  readonly properties: PropertyQueryRow[];
}

export interface PropertyAssignment {
  readonly propertyId: PropertyId;
  readonly value: PropertyValue;
}

export interface MultiEntityPropertyEditRequest {
  readonly schemaId: string;
  readonly commandId: string;
  readonly entities: EntityVersionRef[];
  readonly assignments: PropertyAssignment[];
}

export type AppProtocolRequest =
  | { readonly method: 'readDocumentSnapshot' }
  | { readonly method: 'readJournal'; readonly params: AppJournalReadRequest }
  | { readonly method: 'readPropertySchemas' }
  | { readonly method: 'queryProperties'; readonly params: PropertyQueryRequest }
  | { readonly method: 'compilePropertyEdit'; readonly params: MultiEntityPropertyEditRequest }
  | {
      readonly method: 'executeCanonicalTransaction';
      readonly params: CanonicalCommandTransaction;
    };

export interface AppProtocolRequestEnvelope {
  readonly schemaId: typeof APP_PROTOCOL_SCHEMA_ID;
  readonly requestId: string;
  readonly request: AppProtocolRequest;
  readonly extensions?: AppProtocolExtensions;
}

export interface AppProtocolError {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonObject;
}

export type AppProtocolResponse =
  | { readonly kind: 'documentSnapshot'; readonly payload: AppDocumentSnapshot }
  | { readonly kind: 'journalPage'; readonly payload: AppJournalPage }
  | { readonly kind: 'propertySchemas'; readonly payload: PropertyNamespaceSchema[] }
  | { readonly kind: 'propertyQuery'; readonly payload: PropertyQueryResult }
  | { readonly kind: 'compiledTransaction'; readonly payload: CanonicalCommandTransaction }
  | { readonly kind: 'transactionAccepted'; readonly payload: CanonicalJournalEntry }
  | { readonly kind: 'error'; readonly payload: AppProtocolError };

export interface AppProtocolResponseEnvelope {
  readonly schemaId: typeof APP_PROTOCOL_SCHEMA_ID;
  readonly requestId: string;
  readonly response: AppProtocolResponse;
  readonly extensions?: AppProtocolExtensions;
}
