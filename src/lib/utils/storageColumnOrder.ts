import type { StorageColumn } from '../services/storageManagement';

export function orderStorageColumns(columns: readonly StorageColumn[]): StorageColumn[] {
  const clouds = columns
    .filter(column => column.kind === 'cloud')
    .sort((left, right) => Number(right.active) - Number(left.active));
  const byId = new Map(clouds.map(cloud => [cloud.id, cloud]));
  const byContext = new Map(
    clouds.flatMap(cloud => (cloud.contextId === null ? [] : [[cloud.contextId, cloud] as const]))
  );
  const owner = (cache: StorageColumn) =>
    (cache.contextId === null ? undefined : byContext.get(cache.contextId)) ??
    byId.get(cache.storageId ?? '');
  const grouped = clouds.flatMap(cloud => [
    cloud,
    ...columns
      .filter(column => column.kind === 'local' && owner(column)?.id === cloud.id)
      .sort(
        (left, right) =>
          Number(cloud.contextId !== null && right.contextId === cloud.contextId) -
          Number(cloud.contextId !== null && left.contextId === cloud.contextId)
      )
  ]);
  const placed = new Set(grouped.map(column => column.id));
  const remaining = columns.filter(column => !placed.has(column.id));
  const checkIsUnassigned = (column: StorageColumn) =>
    column.contextId === null && !column.storageId;
  return [
    ...grouped,
    ...remaining.sort(
      (left, right) => Number(checkIsUnassigned(left)) - Number(checkIsUnassigned(right))
    )
  ];
}
