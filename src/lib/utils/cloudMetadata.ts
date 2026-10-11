// Normalize optional transport/cache metadata before display or freshness checks.
// This is a hint about the remote file, not a document timestamp or revision.
export function parseCloudModifiedTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
