/** Resolve Potree metadata and binary assets without corrupting absolute custom-protocol URLs. */
export function resolvePotreeAssetUrl(metadataUrl: string, assetUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(assetUrl)) return assetUrl;
  return new URL(assetUrl, metadataUrl).toString();
}
