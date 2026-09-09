import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';

const READY_SCHEMA = 'hcad.product-import-package-ready@1';
const MANIFEST_SCHEMA = 'hcad.product-import-package-manifest@1';
const PUBLICATION_SCHEMA = 'hcad.photolab-product-publication@1';
const MAX_ROWS = 200;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_READY_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export type ProductImportReadiness = 'ready' | 'notReady';

export interface ProductImportCatalogRow {
  readonly packagePath: string | null;
  readonly productId: string;
  readonly productVersionHash: string;
  readonly publicationGeneration: number;
  readonly productKind: string;
  readonly product: string;
  readonly datasetLabel: string;
  readonly producer: string;
  readonly objectCount: number | null;
  readonly artifactCount: number | null;
  readonly totalBytes: number | null;
  readonly packageSha256: string | null;
  readonly readiness: ProductImportReadiness;
  readonly reasonCode: ProductImportReasonCode;
  readonly reason: string;
}

export type ProductImportReasonCode =
  | 'available'
  | 'needs_republish_recompute'
  | 'needs_preparation'
  | 'no_package'
  | 'unsupported_format'
  | 'invalid_package'
  | 'unsupported_package_schema';

export interface ProductImportCatalog {
  readonly sourcePath: string;
  readonly rows: readonly ProductImportCatalogRow[];
}

type JsonObject = Record<string, unknown>;

const REASON_COPY: Readonly<Record<ProductImportReasonCode, string>> = {
  available: 'Ready to import.',
  needs_republish_recompute:
    'Republish or recompute this product in PhotoLab to capture complete provenance.',
  needs_preparation: 'Prepare this product in PhotoLab before importing.',
  no_package: 'No import package is available. Republish this product in PhotoLab.',
  unsupported_format: 'This product format is not supported by Builder.',
  invalid_package:
    'The import package is invalid. Republish or recompute this product in PhotoLab.',
  unsupported_package_schema:
    'This product package version is not supported by this version of Builder.',
};

export async function listProductImportCatalog(sourcePath: string): Promise<ProductImportCatalog> {
  const source = resolve(sourcePath);
  const stat = await fs.stat(source);
  if (!stat.isDirectory())
    throw new Error('Choose a PhotoLab project or product package directory.');
  const publications = resolve(source, '.photolab', 'product-import-publications');
  if (!(await exists(publications))) {
    if (await isPackageDirectory(source)) {
      return { sourcePath: source, rows: [await readPackageRow(source, null)] };
    }
    throw new Error('Choose a PhotoLab project or product package directory.');
  }
  const entries = (await fs.readdir(publications, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_ROWS) {
    throw new Error(`PhotoLab publication catalog exceeds the ${MAX_ROWS}-row chooser limit.`);
  }
  let bytesRead = 0;
  const rows: ProductImportCatalogRow[] = [];
  for (const entry of entries) {
    const path = resolve(publications, entry.name);
    const bytes = await readBounded(path, MAX_CATALOG_BYTES - bytesRead);
    bytesRead += bytes.byteLength;
    const publication = parseObject(bytes, 'PhotoLab publication record');
    rows.push(await rowFromPublication(source, publication));
  }
  rows.sort(
    (left, right) =>
      left.publicationGeneration - right.publicationGeneration ||
      left.productId.localeCompare(right.productId) ||
      left.productVersionHash.localeCompare(right.productVersionHash),
  );
  return { sourcePath: source, rows };
}

async function rowFromPublication(
  projectRoot: string,
  publication: JsonObject,
): Promise<ProductImportCatalogRow> {
  if (publication.schema_id !== PUBLICATION_SCHEMA) {
    return invalidSummaryRow('unsupported_package_schema', 'Unknown publication record version.');
  }
  const lineage = objectMember(publication, 'lineage');
  const payload = objectMember(lineage, 'payload');
  const productId = stringMember(publication, 'product_id', 'Unknown product');
  const productVersionHash = stringMember(publication, 'product_version_hash', '');
  const publicationGeneration = integerMember(publication, 'publication_generation', 0);
  const productKind = stringMember(payload, 'product_kind', 'unknown');
  const product = stringMember(payload, 'product_label', productId);
  const datasetLabel = stringMember(payload, 'dataset_label', 'Unknown dataset');
  const reasonCode = reasonMember(publication.reason_code);
  const packageSummary = nullableObjectMember(publication, 'package');
  if (!packageSummary) {
    return {
      packagePath: null,
      productId,
      productVersionHash,
      publicationGeneration,
      productKind,
      product,
      datasetLabel,
      producer: 'himmelcad-photolab',
      objectCount: null,
      artifactCount: null,
      totalBytes: null,
      packageSha256: null,
      readiness: 'notReady',
      reasonCode,
      reason: REASON_COPY[reasonCode],
    };
  }
  const relativePath = stringMember(packageSummary, 'package_relative_path', '');
  if (!safeRelativePath(relativePath)) {
    return invalidSummaryRow('invalid_package', 'Package locator is unsafe.', {
      productId,
      productVersionHash,
      publicationGeneration,
      productKind,
      product,
      datasetLabel,
    });
  }
  const packagePath = resolve(projectRoot, ...relativePath.split('/'));
  const row = await readPackageRow(packagePath, {
    productId,
    productVersionHash,
    publicationGeneration,
    productKind,
    product,
    datasetLabel,
  });
  const expectedPackageSha = stringMember(packageSummary, 'package_sha256', '');
  if (row.readiness === 'ready' && row.packageSha256 !== expectedPackageSha) {
    return {
      ...row,
      readiness: 'notReady',
      reasonCode: 'invalid_package',
      reason: REASON_COPY.invalid_package,
    };
  }
  return row;
}

interface ProductSummary {
  readonly productId: string;
  readonly productVersionHash: string;
  readonly publicationGeneration: number;
  readonly productKind: string;
  readonly product: string;
  readonly datasetLabel: string;
}

async function readPackageRow(
  packagePath: string,
  summary: ProductSummary | null,
): Promise<ProductImportCatalogRow> {
  const manifestPath = resolve(packagePath, 'manifest.json');
  const readyPath = resolve(packagePath, 'ready.json');
  let manifestBytes: Uint8Array;
  let manifest: JsonObject;
  try {
    manifestBytes = await readBounded(manifestPath, MAX_MANIFEST_BYTES);
    manifest = parseObject(manifestBytes, 'product manifest');
  } catch (error) {
    return invalidSummaryRow(
      'invalid_package',
      `manifest.json: ${message(error)}`,
      summary ?? undefined,
      packagePath,
    );
  }
  const productObject = objectMember(manifest, 'product');
  const producerObject = objectMember(manifest, 'producer');
  const sourceObject = objectMember(manifest, 'source');
  const counts = objectMember(manifest, 'counts');
  const base: ProductSummary = summary ?? {
    productId: stringMember(productObject, 'entity_id', basename(packagePath)),
    productVersionHash: stringMember(productObject, 'entity_version_hash', ''),
    publicationGeneration: integerMember(sourceObject, 'publication_generation', 0),
    productKind: stringMember(productObject, 'kind', 'unknown'),
    product: stringMember(productObject, 'label', basename(packagePath)),
    datasetLabel: stringMember(productObject, 'dataset_label', 'Unknown dataset'),
  };
  const common = {
    packagePath,
    ...base,
    producer: `${stringMember(producerObject, 'product_id', 'PhotoLab')} · ${stringMember(producerObject, 'product_version', 'unknown version')}`,
    objectCount: integerMember(counts, 'object_count', 0),
    artifactCount: integerMember(counts, 'artifact_count', 0),
    totalBytes: integerMember(counts, 'total_bytes', 0),
    packageSha256: stringMember(manifest, 'package_sha256', '') || null,
  };
  if (manifest.schema_id !== MANIFEST_SCHEMA) {
    return {
      ...common,
      readiness: 'notReady' as const,
      reasonCode: 'unsupported_package_schema' as const,
      reason: REASON_COPY.unsupported_package_schema,
    };
  }
  let readyBytes: Uint8Array;
  let ready: JsonObject;
  try {
    readyBytes = await readBounded(readyPath, MAX_READY_BYTES);
    ready = parseObject(readyBytes, 'product ready record');
  } catch (error) {
    return {
      ...common,
      readiness: 'notReady' as const,
      reasonCode: 'invalid_package' as const,
      reason: `${REASON_COPY.invalid_package} ready.json: ${message(error)}`,
    };
  }
  if (ready.schema_id !== READY_SCHEMA) {
    return {
      ...common,
      readiness: 'notReady' as const,
      reasonCode: 'unsupported_package_schema' as const,
      reason: REASON_COPY.unsupported_package_schema,
    };
  }
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
  if (
    ready.manifest_sha256 !== manifestHash ||
    ready.package_sha256 !== manifest.package_sha256 ||
    ready.provenance_status !== 'complete' ||
    !Array.isArray(ready.missing_field_ids) ||
    ready.missing_field_ids.length !== 0
  ) {
    return {
      ...common,
      readiness: 'notReady' as const,
      reasonCode: 'invalid_package' as const,
      reason: `${REASON_COPY.invalid_package} The ready record and manifest do not match.`,
    };
  }
  return { ...common, readiness: 'ready', reasonCode: 'available', reason: REASON_COPY.available };
}

function invalidSummaryRow(
  reasonCode: ProductImportReasonCode,
  diagnostic: string,
  summary?: ProductSummary,
  packagePath: string | null = null,
): ProductImportCatalogRow {
  return {
    packagePath,
    productId: summary?.productId ?? 'unknown',
    productVersionHash: summary?.productVersionHash ?? '',
    publicationGeneration: summary?.publicationGeneration ?? 0,
    productKind: summary?.productKind ?? 'unknown',
    product: summary?.product ?? 'Unreadable PhotoLab product',
    datasetLabel: summary?.datasetLabel ?? 'Unknown dataset',
    producer: 'himmelcad-photolab',
    objectCount: null,
    artifactCount: null,
    totalBytes: null,
    packageSha256: null,
    readiness: 'notReady',
    reasonCode,
    reason: `${REASON_COPY[reasonCode]} ${diagnostic}`,
  };
}

async function isPackageDirectory(path: string): Promise<boolean> {
  return (
    (await exists(resolve(path, 'manifest.json'))) || (await exists(resolve(path, 'ready.json')))
  );
}

async function readBounded(path: string, remaining: number): Promise<Uint8Array> {
  if (remaining <= 0) throw new Error('PhotoLab publication catalog exceeds the 16 MiB limit.');
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size > remaining)
    throw new Error('file exceeds its bounded read limit');
  return fs.readFile(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function parseObject(bytes: Uint8Array, label: string): JsonObject {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  return value as JsonObject;
}

function objectMember(value: JsonObject, key: string): JsonObject {
  const member = value[key];
  return member && typeof member === 'object' && !Array.isArray(member)
    ? (member as JsonObject)
    : {};
}

function nullableObjectMember(value: JsonObject, key: string): JsonObject | null {
  const member = value[key];
  return member && typeof member === 'object' && !Array.isArray(member)
    ? (member as JsonObject)
    : null;
}

function stringMember(value: JsonObject, key: string, fallback: string): string {
  return typeof value[key] === 'string' ? value[key] : fallback;
}

function integerMember(value: JsonObject, key: string, fallback: number): number {
  return Number.isSafeInteger(value[key]) && Number(value[key]) >= 0
    ? Number(value[key])
    : fallback;
}

function reasonMember(value: unknown): ProductImportReasonCode {
  return typeof value === 'string' && value in REASON_COPY
    ? (value as ProductImportReasonCode)
    : 'invalid_package';
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
