const PRODUCT_IMPORT_ERROR_MARKER = 'HCAD_PRODUCT_IMPORT_ERROR:';

export type ProductImportFailureReasonCode =
  | 'invalid_package'
  | 'unsupported_package_schema'
  | 'needs_preparation'
  | 'needs_republish_recompute'
  | 'cancelled_before_commit'
  | 'failed_no_commit';

export interface ProductImportFailure {
  readonly reasonCode: ProductImportFailureReasonCode;
  readonly message: string;
}

const SAFE_REASON_CODES = new Set<ProductImportFailureReasonCode>([
  'invalid_package',
  'unsupported_package_schema',
  'needs_preparation',
  'needs_republish_recompute',
]);

export function productImportFailure(error: unknown): ProductImportFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const marker = raw.indexOf(PRODUCT_IMPORT_ERROR_MARKER);
  if (marker >= 0) {
    const encoded = raw.slice(marker + PRODUCT_IMPORT_ERROR_MARKER.length).split(/\s/, 1)[0] ?? '';
    try {
      const envelope = JSON.parse(decodeURIComponent(encoded)) as {
        readonly reasonCode?: unknown;
        readonly message?: unknown;
      };
      if (
        typeof envelope.reasonCode === 'string' &&
        SAFE_REASON_CODES.has(envelope.reasonCode as ProductImportFailureReasonCode) &&
        typeof envelope.message === 'string' &&
        envelope.message.trim().length > 0
      ) {
        return {
          reasonCode: envelope.reasonCode as ProductImportFailureReasonCode,
          message: envelope.message,
        };
      }
    } catch {
      // A malformed bridge envelope is an internal failure, not user-facing detail.
    }
  }
  return {
    reasonCode: 'failed_no_commit',
    message:
      'Import failed without changing the project. Try again. If it persists, republish or recompute the product in PhotoLab.',
  };
}

export function cancelledProductImportFailure(): ProductImportFailure {
  return {
    reasonCode: 'cancelled_before_commit',
    message: 'Import cancelled before commit. The project was not changed.',
  };
}
